/**
 * EDGAR relay Worker.
 *  - Static files in /public (the web page) are served automatically by Workers Assets.
 *  - GET /api/facts/:ticker    SEC companyfacts JSON (financial data)
 *  - GET /api/company/:ticker  SEC submissions JSON, trimmed (profile + recent filings)
 *  - GET /api/tickers          [[ticker, name], ...] for the search box
 *  - GET /api/prices/:ticker   10y daily prices (Yahoo Finance, Stooq fallback)
 *  - GET /api/rate             10-yr US Treasury yield
 *  - GET/PUT /api/user/:doc   your synced watchlist, saved screens and custom peers (stored in KV)
 *  - GET /api/fx/:CCY           USD per 1 unit of a currency (Yahoo, ECB via Frankfurter as fallback)
 *  - GET /api/item1?url=…      anchor of "Item 1. Business" (10-K) / "Item 4. Information on the Company" (20-F)
 *  - GET /api/concalls/:ticker  earnings 8-Ks (Item 2.02) with their exhibits classified
 *  - GET /api/transcript/:ticker/:YYYYQn   earnings call transcript (Alpha Vantage), stored permanently
 *
 * Secrets / vars (set with wrangler):
 *   SEC_UA      required  e.g. "Souveek Pal you@example.com"   (wrangler secret put SEC_UA)
 *   ACCESS_KEY  optional  if set, the page must send it (stops strangers using your quota)
 *   ALPHAVANTAGE_KEY  optional  enables transcripts (free key: ~25 requests/day)
 * Bindings (wrangler.toml, optional): TRANSCRIPTS_KV (Workers KV) or TRANSCRIPTS_R2 (R2 bucket)
 *   to keep every transcript permanently; without one, transcripts are only cached briefly.
 */
const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const SYM = "([A-Za-z0-9.\\-\\^]{1,12})";

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors() });
    if (!url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    if (env.ACCESS_KEY && req.headers.get("x-access-key") !== env.ACCESS_KEY)
      return json({ error: "Wrong or missing access key" }, 401);

    const p = url.pathname;
    let m;
    try {
      if (p === "/api/rate") return cached("rate", 21600, ctx, url, rate10y);
      if ((m = p.match(/^\/api\/user\/(watchlist|screens|peers)$/))) return userDoc(env, req, m[1]);
      if ((m = p.match(/^\/api\/fx\/([A-Z]{3})$/))) return cached(`fx/${m[1]}`, 43200, ctx, url, () => fxRate(m[1]));
      if ((m = p.match(new RegExp(`^/api/prices/${SYM}$`))))
        return cached(`prices/${m[1].toUpperCase()}`, 43200, ctx, url, () => prices(m[1].toUpperCase()));

      if (!env.SEC_UA) return json({ error: "Server not configured: set the SEC_UA secret" }, 500);
      if (!/@/.test(env.SEC_UA)) return json({ error: `The SEC_UA secret must include an email address, e.g. "Jane Doe jane@example.com" (SEC requires it).` }, 500);
      if (p === "/api/tickers")
        return cached("tickers", 86400, ctx, url, async () =>
          Object.values(await tickerList(env)).map((v) => [v.ticker, v.title]));
      if ((m = p.match(new RegExp(`^/api/company/${SYM}$`)))) {
        const t = m[1].toUpperCase().replace(".", "-"), fresh = url.searchParams.get("fresh") === "1";
        if (!fresh) { const s = await snapCompany(env, url, t, "snapshot"); if (s) return s; }
        const res = await cached(`company/${m[1].toUpperCase()}`, 21600, ctx, url, () => company(env, m[1]));
        if (!res.ok) { const s = await snapCompany(env, url, t, "fallback"); if (s) return s; }
        return res;
      }
      if ((m = p.match(new RegExp(`^/api/facts/${SYM}$`)))) return facts(env, ctx, url, m[1]);
      if (p === "/api/item1") return item1(env, ctx, url);
      if ((m = p.match(new RegExp(`^/api/concalls/${SYM}$`))))
        return cached(`concalls/${m[1].toUpperCase()}`, 21600, ctx, url, () => concalls(env, m[1]));
      if ((m = p.match(new RegExp(`^/api/transcript/${SYM}/(\\d{4})Q([1-4])$`)))) {
        if (req.method === "POST") return saveTranscript(env, req, m[1].toUpperCase(), m[2], m[3]);
        return transcript(env, ctx, m[1].toUpperCase(), m[2], m[3], url.searchParams.get("stored") === "1");
      }
    } catch (e) {
      return json({ error: String(e.message || e) }, e.status || 502);
    }
    return json({ error: "Not found" }, 404);
  },
};

/* ---------------- SEC ---------------- */
async function secFetch(u, ua, ttl) {
  const go = () => fetch(u, {
    headers: { "User-Agent": ua, "Accept-Encoding": "gzip, deflate" },
    cf: ttl ? { cacheTtl: ttl, cacheEverything: true } : { cacheTtl: 0 },
  });
  let r = await go();
  if (r.status === 403 || r.status === 429) { await new Promise((ok) => setTimeout(ok, 1500)); r = await go(); }   // one gentle retry
  return r;
}
// Turn an SEC refusal into a message that says what to do
async function secError(what, r) {
  let body = "";
  try { body = (await r.text()).slice(0, 2000); } catch {}
  if (r.status === 403 && /undeclared automated tool|user-agent|declare your traffic/i.test(body))
    return httpErr(`SEC rejected the request's identity. Check the Worker secret SEC_UA is your name and email, e.g. "Jane Doe jane@example.com".`, 502);
  if ((r.status === 403 || r.status === 429) && /rate threshold|request rate|exceeded/i.test(body + r.status))
    return httpErr(`SEC is temporarily limiting requests from this server (Cloudflare's shared address). It usually clears within 10 minutes; pages opened before stay cached.`, 503);
  if (r.status === 403 || r.status === 429)
    return httpErr(`SEC refused the request (${what}: HTTP ${r.status}). This is usually its rate limit on Cloudflare's shared address and clears within 10 minutes. If it persists, check that SEC_UA is your name and email.`, 503);
  return httpErr(`SEC ${what}: HTTP ${r.status}`, 502);
}
async function tickerList(env) {
  const r = await secFetch(TICKERS_URL, env.SEC_UA, 86400);
  if (!r.ok) throw await secError("ticker list", r);
  return r.json();
}
async function cikFor(env, sym) {
  const t = sym.toUpperCase().replace(".", "-");          // BRK.B -> BRK-B
  const row = Object.values(await tickerList(env)).find((v) => v.ticker.toUpperCase() === t);
  if (!row) throw httpErr(`Ticker ${t} not found in SEC's list (US filers only)`, 404);
  return String(row.cik_str).padStart(10, "0");
}

async function facts(env, ctx, url, sym) {
  const ticker = sym.toUpperCase().replace(".", "-");
  const fresh = url.searchParams.get("fresh") === "1";
  const cacheKey = new Request(`https://edgar-cache/facts/${ticker}`);
  if (!fresh) {
    const hit = await caches.default.match(cacheKey);
    if (hit) return withCors(hit, "HIT");
    // last night's copy from the bulk file: no SEC request, so no Cloudflare-address refusals
    const s = await snapFacts(env, url, ticker, "snapshot");
    if (s) return s;
  }
  try {
    const cik = await cikFor(env, ticker);
    const r = await secFetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, env.SEC_UA, 0);
    if (r.status === 404) return json({ error: `${ticker} has no XBRL financial data on EDGAR` }, 404);
    if (!r.ok) throw await secError("companyfacts", r);
    const out = new Response(r.body, {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=21600",
                 "x-cik": cik, "x-fetched": new Date().toISOString(), "x-source": "live" },
    });
    ctx.waitUntil(caches.default.put(cacheKey, out.clone()));
    return withCors(out, "MISS");
  } catch (e) {
    const s = await snapFacts(env, url, ticker, "fallback");
    if (s) return s;
    return json({ error: e.message }, e.status || 502);
  }
}

/* ---------- nightly snapshot (public/data/snap, written by builder/build.mjs) ---------- */
async function snapAsset(env, url, p) {
  if (!env.ASSETS) return null;
  try { const r = await env.ASSETS.fetch(new Request(new URL(p, url))); return r.ok ? r : null; } catch { return null; }
}
async function snapCompany(env, url, t, source) {
  const r = await snapAsset(env, url, `/data/snap/c/${t}.json`);
  if (!r) return null;
  return new Response(r.body, { headers: { ...cors(), "content-type": "application/json", "x-source": source } });
}
async function snapFacts(env, url, t, source) {
  const [rf, rc] = await Promise.all([snapAsset(env, url, `/data/snap/f/${t}.json.gz`), snapAsset(env, url, `/data/snap/c/${t}.json`)]);
  if (!rf) return null;
  let c = null;
  try { if (rc) c = await rc.json(); } catch {}
  const h = { ...cors(), "content-type": "application/json", "x-cik": (c && c.cik) || "", "x-fetched": (c && c.snapshot) || "", "x-source": source };
  // the file is gzip bytes: pass them through untouched (no CPU spent decompressing)
  if (/gzip/i.test(rf.headers.get("content-encoding") || "")) return new Response(rf.body, { headers: h });
  return new Response(rf.body, { headers: { ...h, "content-encoding": "gzip" }, encodeBody: "manual" });
}

const KEEP_FORMS = new Set(["10-K", "10-K/A", "10-Q", "10-Q/A", "8-K", "DEF 14A", "20-F", "40-F", "6-K", "S-1", "10-KT"]);
async function company(env, sym) {
  const cik = await cikFor(env, sym);
  const r = await secFetch(`https://data.sec.gov/submissions/CIK${cik}.json`, env.SEC_UA, 3600);
  if (!r.ok) throw await secError("submissions", r);
  const s = await r.json();
  const rec = (s.filings && s.filings.recent) || {};
  const filings = [];
  for (let i = 0; i < (rec.form || []).length && filings.length < 120; i++) {
    if (!KEEP_FORMS.has(rec.form[i])) continue;
    filings.push({
      form: rec.form[i], date: rec.filingDate[i], period: rec.reportDate[i] || "",
      desc: rec.primaryDocDescription ? rec.primaryDocDescription[i] : "", items: rec.items ? rec.items[i] : "",
      url: `https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${rec.accessionNumber[i].replace(/-/g, "")}/${rec.primaryDocument[i]}`,
    });
  }
  const b = (s.addresses && s.addresses.business) || {};
  return {
    cik, name: s.name, tickers: s.tickers || [], exchanges: s.exchanges || [],
    sic: s.sic, sicDescription: s.sicDescription, category: s.category,
    fiscalYearEnd: s.fiscalYearEnd, stateOfIncorporation: s.stateOfIncorporationDescription || s.stateOfIncorporation,
    website: s.website || "", investorWebsite: s.investorWebsite || "", phone: s.phone || "",
    address: [b.street1, b.city, b.stateOrCountryDescription || b.stateOrCountry].filter(Boolean).join(", "),
    formerNames: (s.formerNames || []).map((f) => f.name),
    filings,
  };
}



/* ---------------- Item 1 (Business) anchor inside a 10-K / 20-F ---------------- */
// Reads only the start of the document (the table of contents) to keep within the free CPU budget.
async function item1(env, ctx, url) {
  const doc = url.searchParams.get("url") || "";
  if (!/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d+\/[\w.\-]+\.html?$/i.test(doc)) return json({ error: "bad url" }, 400);
  const ck = new Request(`https://edgar-cache/item1/${encodeURIComponent(doc)}`);
  const hit = await caches.default.match(ck);
  if (hit) return withCors(hit, "HIT");
  const r = await fetch(doc, { headers: { "User-Agent": env.SEC_UA, "Accept-Encoding": "gzip, deflate" }, cf: { cacheTtl: 30 * 86400, cacheEverything: true } });
  if (!r.ok) { const e = await secError("10-K", r); return json({ error: e.message }, e.status); }
  // read the first ~400 KB
  const reader = r.body.getReader(), dec = new TextDecoder();
  let head = "";
  while (head.length < 400000) { const { done, value } = await reader.read(); if (done) break; head += dec.decode(value, { stream: true }); }
  try { await reader.cancel(); } catch {}
  const is20F = /20-?F/i.test(head.slice(0, 20000)) && !/FORM\s+10-K/i.test(head.slice(0, 20000));
  const label = is20F ? /Information\s+on\s+the\s+Company/i : /(?:Item\s*1\.?\s*(?:&#160;|&nbsp;|\s)*)?Business\b/i;
  let anchor = null;
  // table-of-contents links: <a href="#id">...Business...</a>  (text may be split by tags)
  for (const m of head.matchAll(/<a\b[^>]*href="#([^"]+)"[^>]*>([\s\S]{0,300}?)<\/a>/gi)) {
    const text = m[2].replace(/<[^>]+>/g, " ").replace(/&#160;|&nbsp;/g, " ").replace(/\s+/g, " ").trim();
    if (label.test(text) && !/risk|legal|propert|unresolved|cybersecurity|segment/i.test(text) && (is20F || /^(item\s*1\.?\s*)?business$/i.test(text) || /^item\s*1\b/i.test(text) || text.length < 20)) { anchor = m[1]; break; }
    if (!anchor && /^item\s*1\.?$/i.test(text)) {     // "Item 1." in one cell, "Business" in the next: accept if Business follows soon after
      const after = head.slice(m.index, m.index + 600).replace(/<[^>]+>/g, " ");
      if (/Item\s*1\.?\s+Business/i.test(after.replace(/&#160;|&nbsp;|\s+/g, " "))) { anchor = m[1]; break; }
    }
  }
  const body = { url: doc, anchor, link: anchor ? `${doc}#${anchor}` : `${doc}#:~:text=${encodeURIComponent(is20F ? "Information on the Company" : "Business")}`, section: is20F ? "Item 4. Information on the Company" : "Item 1. Business" };
  const res = new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "cache-control": "public, max-age=2592000" } });
  ctx.waitUntil(caches.default.put(ck, res.clone()));
  return withCors(res, "MISS");
}

/* ---------------- concalls: earnings 8-Ks and their exhibits ---------------- */
async function concalls(env, sym) {
  const c = await company(env, sym);
  const cikInt = parseInt(c.cik, 10);
  const earn = c.filings.filter((f) => f.form === "8-K" && /(^|,)\s*2\.02/.test(f.items || "")).slice(0, 8);
  const out = [];
  for (let i = 0; i < earn.length; i += 2) {              // two at a time with a pause: be gentle with SEC's rate limit
    if (i) await new Promise((ok) => setTimeout(ok, 250));
    const batch = await Promise.all(earn.slice(i, i + 2).map(async (f) => {
      const accnNoDash = f.url.split("/")[7], accn = `${accnNoDash.slice(0, 10)}-${accnNoDash.slice(10, 12)}-${accnNoDash.slice(12)}`;
      const base = `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accnNoDash}/`;
      let docs = [];
      try {
        const r = await secFetch(`${base}${accn}-index.htm`, env.SEC_UA, 30 * 86400);   // filings never change
        if (r.ok) docs = parseIndex(await r.text());
      } catch (e) { /* keep the filing with just its main document */ }
      return { date: f.date, items: f.items, filing: f.url, index: `${base}${accn}-index.htm`, docs: classify(docs, f.url) };
    }));
    out.push(...batch);
  }
  return { cik: c.cik, name: c.name, investorWebsite: c.investorWebsite || c.website || "", calls: out };
}
function parseIndex(html) {
  const docs = [];
  const table = (html.match(/<table[^>]*class="tableFile"[^>]*>([\s\S]*?)<\/table>/i) || [])[1] || "";
  for (const row of table.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => x[1]);
    if (cells.length < 4) continue;
    const href = (cells[2].match(/href="([^"]+)"/i) || [])[1];
    if (!href) continue;
    const text = (h) => h.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").trim();
    docs.push({ desc: text(cells[1]), name: text(cells[2]), type: text(cells[3]),
      url: "https://www.sec.gov" + href.replace(/^\/ix\?doc=/, "") });
  }
  return docs;
}
function classify(docs, mainUrl) {
  const out = [];
  for (const d of docs) {
    if (!/^EX-99/i.test(d.type) || /\.(jpg|jpeg|png|gif|xml|xsd|json|zip)$/i.test(d.name)) continue;
    const t = `${d.desc} ${d.name}`.toLowerCase();
    let kind = "other";
    if (/transcript/.test(t)) kind = "transcript";
    else if (/prepared remarks|remarks|script|commentary|cfo comment/.test(t)) kind = "remarks";
    else if (/letter/.test(t)) kind = "letter";
    else if (/presentation|slides|deck|investor update/.test(t)) kind = "slides";
    else if (/supplement|financial data|fact sheet|metrics|trending schedule/.test(t)) kind = "supplement";
    else if (/press release|earnings release|news release|results|announces|reports/.test(t) || /^EX-99\.1$/i.test(d.type)) kind = "press";
    out.push({ kind, type: d.type, desc: d.desc, url: d.url });
  }
  if (!out.length && mainUrl) out.push({ kind: "filing", type: "8-K", desc: "8-K filing", url: mainUrl });
  return out;
}

/* ---------------- transcripts: Alpha Vantage, stored compressed for good ---------------- */
async function transcript(env, ctx, ticker, year, q, storedOnly) {
  const key = `transcripts/${ticker}/${year}Q${q}.json.gz`;
  const store = env.TRANSCRIPTS_R2 ? "r2" : env.TRANSCRIPTS_KV ? "kv" : null;
  // 1. permanent store
  try {
    let buf = null;
    if (store === "r2") { const o = await env.TRANSCRIPTS_R2.get(key); if (o) buf = await o.arrayBuffer(); }
    if (store === "kv") buf = await env.TRANSCRIPTS_KV.get(key, "arrayBuffer");
    if (buf) return json({ ...(JSON.parse(await gunzip(buf))), stored: true, storage: store });
  } catch (e) { /* fall through and fetch */ }
  if (storedOnly) return json({ error: "notstored", storage: store }, 404);
  // 2. short-lived edge cache (also catches "no transcript" answers so they don't burn requests)
  const ck = new Request(`https://edgar-cache/${key}`);
  const hit = await caches.default.match(ck);
  if (hit) return withCors(hit, "HIT");
  if (!env.ALPHAVANTAGE_KEY) return json({ error: "nokey" }, 501);
  const r = await fetch(`https://www.alphavantage.co/query?function=EARNINGS_CALL_TRANSCRIPT&symbol=${encodeURIComponent(ticker.replace("-", "."))}&quarter=${year}Q${q}&apikey=${env.ALPHAVANTAGE_KEY}`);
  if (!r.ok) return json({ error: `Alpha Vantage HTTP ${r.status}` }, 502);
  const j = await r.json();
  const msg = j.Information || j.Note || j["Error Message"];
  if (msg) {
    const kind = /requests per day|rate limit|per minute|call frequency/i.test(msg) ? "limit" : /premium/i.test(msg) ? "premium" : /invalid|apikey|api key/i.test(msg) ? "badkey" : "provider";
    return json({ error: kind, detail: msg }, kind === "limit" ? 429 : 502);
  }
  const parts = Array.isArray(j.transcript) ? j.transcript.map((x) => ({ speaker: x.speaker || "", title: x.title || "", content: x.content || "" })) : [];
  const body = { symbol: ticker, quarter: j.quarter || `${year}Q${q}`, source: "Alpha Vantage", fetched: new Date().toISOString(), transcript: parts };
  if (!parts.length) {
    const res = new Response(JSON.stringify({ ...body, empty: true }), { headers: { "content-type": "application/json", "cache-control": "public, max-age=604800" } });
    ctx.waitUntil(caches.default.put(ck, res.clone()));
    return withCors(res, "MISS");
  }
  let stored = false;
  if (store) {
    try {
      const gz = await gzip(JSON.stringify(body));
      if (store === "r2") await env.TRANSCRIPTS_R2.put(key, gz, { httpMetadata: { contentType: "application/json", contentEncoding: "gzip" } });
      else await env.TRANSCRIPTS_KV.put(key, gz);
      stored = true;
    } catch (e) { body.storeError = String(e.message || e); }      // storage full etc.: still show it
  }
  if (!stored) {
    const res = new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "cache-control": "public, max-age=2592000" } });
    ctx.waitUntil(caches.default.put(ck, res.clone()));
  }
  return json({ ...body, stored, storage: store });
}
// The browser fetched a transcript itself (Cloudflare's shared IPs often hit Alpha Vantage's per-IP limit); keep it.
async function saveTranscript(env, req, ticker, year, q) {
  const store = env.TRANSCRIPTS_R2 ? "r2" : env.TRANSCRIPTS_KV ? "kv" : null;
  if (!store) return json({ stored: false, storage: null });
  const text = await req.text();
  if (text.length > 3e6) return json({ error: "too large" }, 413);
  let j;
  try { j = JSON.parse(text); } catch { return json({ error: "bad json" }, 400); }
  const parts = Array.isArray(j.transcript) ? j.transcript.filter((x) => x && typeof x.content === "string")
    .map((x) => ({ speaker: String(x.speaker || "").slice(0, 200), title: String(x.title || "").slice(0, 200), content: x.content })) : [];
  if (!parts.length) return json({ error: "empty transcript" }, 400);
  const body = { symbol: ticker, quarter: `${year}Q${q}`, source: "Alpha Vantage", fetched: new Date().toISOString(), transcript: parts };
  const key = `transcripts/${ticker}/${year}Q${q}.json.gz`;
  try {
    const gz = await gzip(JSON.stringify(body));
    if (store === "r2") await env.TRANSCRIPTS_R2.put(key, gz, { httpMetadata: { contentType: "application/json", contentEncoding: "gzip" } });
    else await env.TRANSCRIPTS_KV.put(key, gz);
    return json({ stored: true, storage: store });
  } catch (e) { return json({ stored: false, storeError: String(e.message || e) }); }
}
async function gzip(text) {
  return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
}
async function gunzip(buf) {
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
}

/* ---------------- prices: Yahoo chart API, Stooq CSV fallback (free, no key) ---------------- */
async function prices(ticker) {
  const errors = [];
  for (const host of ["query1", "query2"]) {
    try { return await yahoo(host, ticker.replace(".", "-")); } catch (e) { errors.push(`yahoo ${host}: ${e.message}`); }
  }
  try { return await stooq(ticker.toLowerCase().replace(".", "-") + ".us"); } catch (e) { errors.push(`stooq: ${e.message}`); }
  throw new Error("No price source answered (" + errors.join("; ") + ")");
}
async function yahoo(host, symbol, range = "10y") {
  const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d&events=split`,
    { headers: { "User-Agent": BROWSER_UA, Accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  if (!res || !res.timestamp) throw new Error((j.chart && j.chart.error && j.chart.error.description) || "no data");
  const q = res.indicators.quote[0], close = q.close, vol = q.volume || [];   // close is split-adjusted, not dividend-adjusted
  const out = [];
  res.timestamp.forEach((ts, i) => {
    if (close[i] != null) out.push([new Date(ts * 1000).toISOString().slice(0, 10), Math.round(close[i] * 10000) / 10000, vol[i] || 0]);
  });
  const meta = res.meta || {};
  const last = meta.regularMarketPrice != null
    ? { price: meta.regularMarketPrice, date: new Date((meta.regularMarketTime || Date.now() / 1000) * 1000).toISOString().slice(0, 10),
        prevClose: meta.chartPreviousClose != null && range === "5d" ? meta.chartPreviousClose : null }
    : { price: out.at(-1)[1], date: out.at(-1)[0] };
  return { source: "Yahoo Finance", currency: meta.currency || "USD", last, prices: out };
}
async function stooq(symbol) {
  const r = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`, { headers: { "User-Agent": BROWSER_UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const lines = (await r.text()).trim().split(/\r?\n/);
  if (!/^Date,/i.test(lines[0])) throw new Error("no data");
  const cutoff = new Date(Date.now() - 10.5 * 365 * 86400000).toISOString().slice(0, 10);
  const out = [];
  for (const ln of lines.slice(1)) {
    const c = ln.split(",");
    if (c[0] >= cutoff && c[4]) out.push([c[0], +c[4], +(c[5] || 0)]);
  }
  if (!out.length) throw new Error("no rows");
  return { source: "Stooq", currency: "USD", last: { price: out.at(-1)[1], date: out.at(-1)[0] }, prices: out };
}
// Synced personal data. Set ACCESS_KEY so only you can read or change it.
async function userDoc(env, req, doc) {
  const kv = env.TRANSCRIPTS_KV;
  if (!kv) return json({ error: "nostorage" }, 501);
  const key = `user/${doc}.json`;
  if (req.method === "PUT") {
    const text = await req.text();
    if (text.length > 500000) return json({ error: "too large" }, 413);
    let j; try { j = JSON.parse(text); } catch { return json({ error: "bad json" }, 400); }
    if (typeof j.updated !== "number" || !("data" in j)) return json({ error: "expected {data, updated}" }, 400);
    const cur = await kv.get(key, "json");
    if (cur && cur.updated > j.updated) return json({ ...cur, conflict: true }, 409);   // newer copy elsewhere wins
    await kv.put(key, JSON.stringify({ data: j.data, updated: j.updated }));
    return json({ ok: true, updated: j.updated, protected: !!env.ACCESS_KEY });
  }
  const cur = await kv.get(key, "json");
  return json({ ...(cur || { data: null, updated: 0 }), protected: !!env.ACCESS_KEY });
}

async function fxRate(ccy) {
  if (ccy === "USD") return { ccy, usd: 1, source: "identity" };
  try {
    const y = await yahoo("query1", `${ccy}USD=X`, "5d");
    if (y.last.price > 0) return { ccy, usd: y.last.price, date: y.last.date, source: "Yahoo Finance" };
  } catch (e) { /* fall through */ }
  const r = await fetch(`https://api.frankfurter.app/latest?from=${ccy}&to=USD`);
  if (!r.ok) throw new Error(`No exchange rate for ${ccy}`);
  const j = await r.json();
  return { ccy, usd: j.rates.USD, date: j.date, source: "ECB (Frankfurter)" };
}

async function rate10y() {
  try {
    const y = await yahoo("query1", "^TNX", "5d");
    return { rate: y.last.price, date: y.last.date, source: "Yahoo Finance ^TNX" };   // already in %
  } catch (e) {
    const s = await stooq("10usy.b");
    return { rate: s.last.price, date: s.last.date, source: "Stooq 10USY.B" };
  }
}

/* ---------------- plumbing ---------------- */
async function cached(name, ttl, ctx, url, producer) {
  const key = new Request(`https://edgar-cache/${name}`);
  if (url.searchParams.get("fresh") !== "1") {
    const hit = await caches.default.match(key);
    if (hit) return withCors(hit, "HIT");
  }
  let body;
  try { body = await producer(); }
  catch (e) { return json({ error: String(e.message || e) }, e.status || 502); }
  const res = new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttl}` },
  });
  ctx.waitUntil(caches.default.put(key, res.clone()));
  return withCors(res, "MISS");
}
function httpErr(msg, status) { const e = new Error(msg); e.status = status; return e; }
function cors() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "x-access-key, content-type",
    "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
    "access-control-expose-headers": "x-cik, x-fetched, x-cache, x-source",
  };
}
function withCors(res, state) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors())) h.set(k, v);
  h.set("x-cache", state);
  return new Response(res.body, { status: res.status, headers: h });
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...cors() } });
}

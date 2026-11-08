/**
 * EDGAR relay Worker.
 *  - Static files in /public (the web page) are served automatically by Workers Assets.
 *  - GET /api/facts/:ticker    SEC companyfacts JSON (financial data)
 *  - GET /api/company/:ticker  SEC submissions JSON, trimmed (profile + recent filings)
 *  - GET /api/tickers          [[ticker, name], ...] for the search box
 *  - GET /api/prices/:ticker   10y daily prices (Yahoo Finance, Stooq fallback)
 *  - GET /api/rate             10-yr US Treasury yield
 *
 * Secrets / vars (set with wrangler):
 *   SEC_UA      required  e.g. "Souveek Pal you@example.com"   (wrangler secret put SEC_UA)
 *   ACCESS_KEY  optional  if set, the page must send it (stops strangers using your quota)
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
      if ((m = p.match(new RegExp(`^/api/prices/${SYM}$`))))
        return cached(`prices/${m[1].toUpperCase()}`, 43200, ctx, url, () => prices(m[1].toUpperCase()));

      if (!env.SEC_UA) return json({ error: "Server not configured: set the SEC_UA secret" }, 500);
      if (p === "/api/tickers")
        return cached("tickers", 86400, ctx, url, async () =>
          Object.values(await tickerList(env)).map((v) => [v.ticker, v.title]));
      if ((m = p.match(new RegExp(`^/api/company/${SYM}$`))))
        return cached(`company/${m[1].toUpperCase()}`, 21600, ctx, url, () => company(env, m[1]));
      if ((m = p.match(new RegExp(`^/api/facts/${SYM}$`)))) return facts(env, ctx, url, m[1]);
    } catch (e) {
      return json({ error: String(e.message || e) }, e.status || 502);
    }
    return json({ error: "Not found" }, 404);
  },
};

/* ---------------- SEC ---------------- */
function secFetch(u, ua, ttl) {
  return fetch(u, {
    headers: { "User-Agent": ua, "Accept-Encoding": "gzip, deflate" },
    cf: ttl ? { cacheTtl: ttl, cacheEverything: true } : { cacheTtl: 0 },
  });
}
async function tickerList(env) {
  const r = await secFetch(TICKERS_URL, env.SEC_UA, 86400);
  if (!r.ok) throw httpErr(`SEC ticker list: HTTP ${r.status}`, 502);
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
  const cacheKey = new Request(`https://edgar-cache/facts/${ticker}`);
  if (url.searchParams.get("fresh") !== "1") {
    const hit = await caches.default.match(cacheKey);
    if (hit) return withCors(hit, "HIT");
  }
  const cik = await cikFor(env, ticker);
  const r = await secFetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, env.SEC_UA, 0);
  if (r.status === 404) return json({ error: `${ticker} has no XBRL financial data on EDGAR` }, 404);
  if (!r.ok) return json({ error: `SEC companyfacts: HTTP ${r.status}` }, 502);
  const out = new Response(r.body, {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=21600",
               "x-cik": cik, "x-fetched": new Date().toISOString() },
  });
  ctx.waitUntil(caches.default.put(cacheKey, out.clone()));
  return withCors(out, "MISS");
}

const KEEP_FORMS = new Set(["10-K", "10-K/A", "10-Q", "10-Q/A", "8-K", "DEF 14A", "20-F", "40-F", "6-K", "S-1", "10-KT"]);
async function company(env, sym) {
  const cik = await cikFor(env, sym);
  const r = await secFetch(`https://data.sec.gov/submissions/CIK${cik}.json`, env.SEC_UA, 0);
  if (!r.ok) throw httpErr(`SEC submissions: HTTP ${r.status}`, 502);
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
    "access-control-allow-headers": "x-access-key",
    "access-control-expose-headers": "x-cik, x-fetched, x-cache",
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

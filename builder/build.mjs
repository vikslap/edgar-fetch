#!/usr/bin/env node
/**
 * Nightly screener builder.
 *   1. SEC list of exchange-listed companies (company_tickers_exchange.json)
 *   2. Prices + sector for every US-listed stock (Nasdaq screener download; Yahoo fallback)
 *   3. SEC bulk companyfacts.zip, streamed one company at a time
 *   4. Same calculations as the website (public/core.js + public/screen-core.js)
 *   5. Writes public/data/screener.json, state/build_log.json
 *   6. Runs alert screens from screens.json and messages Telegram on changes
 *
 * Env:
 *   SEC_UA              required for downloads, e.g. "Souveek Pal you@example.com"
 *   TELEGRAM_BOT_TOKEN  optional; with TELEGRAM_CHAT_ID sends alerts
 *   TELEGRAM_CHAT_ID    optional
 *   SITE_URL            optional, e.g. https://edgar-fetch.you.workers.dev (links in alerts)
 *   For local testing:  FACTS_ZIP, TICKERS_FILE, PRICES_FILE, RATE, LIMIT, TELEGRAM_API
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import yauzl from "yauzl";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const core = require(path.join(ROOT, "public/core.js"));
const SC = require(path.join(ROOT, "public/screen-core.js"));
const mapping = JSON.parse(fs.readFileSync(path.join(ROOT, "public/mapping.json"), "utf8"));
const env = process.env;
const UA = env.SEC_UA || "";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const LISTED = new Set(["Nasdaq", "NYSE", "NYSE American", "NYSE Arca", "CBOE"]);
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJSON(url, headers, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i >= tries) throw new Error(`${url}: ${e.message}`);
      await sleep(1500 * i);
    }
  }
}
const readJSON = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const normSym = (s) => String(s).trim().toUpperCase().replace(/[\/^.]/g, "-");

/* ---------- 1. listed companies ---------- */
async function listedCompanies() {
  const j = env.TICKERS_FILE ? readJSON(env.TICKERS_FILE)
    : await getJSON("https://www.sec.gov/files/company_tickers_exchange.json", { "User-Agent": UA });
  const ix = Object.fromEntries(j.fields.map((f, i) => [f, i]));
  const byCik = new Map();
  for (const r of j.data) {
    const cik = r[ix.cik], ex = r[ix.exchange];
    if (!LISTED.has(ex) || byCik.has(cik)) continue;        // first ticker per company = primary class
    byCik.set(cik, { cik, name: r[ix.name], ticker: normSym(r[ix.ticker]), exchange: ex });
  }
  return byCik;
}

/* ---------- 2. prices ---------- */
async function nasdaqPrices() {
  const j = env.PRICES_FILE ? readJSON(env.PRICES_FILE)
    : await getJSON("https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=25000&download=true",
        { "User-Agent": BROWSER_UA, Accept: "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9" });
  const rows = (j.data && (j.data.rows || (j.data.table && j.data.table.rows))) || [];
  const out = new Map();
  for (const r of rows) {
    const price = parseFloat(String(r.lastsale || "").replace(/[$,]/g, ""));
    if (!(price > 0)) continue;
    out.set(normSym(r.symbol), { price, sector: r.sector || "", industry: r.industry || "", mcapNasdaq: parseFloat(r.marketCap) || null });
  }
  return out;
}
async function yahooPrice(sym) {
  try {
    const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`, { "User-Agent": BROWSER_UA }, 2);
    const p = j.chart.result[0].meta.regularMarketPrice;
    return p > 0 ? { price: p, sector: "", industry: "" } : null;
  } catch { return null; }
}
async function riskFree() {
  if (env.RATE) return parseFloat(env.RATE);
  try {
    const j = await getJSON("https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX?range=5d&interval=1d", { "User-Agent": BROWSER_UA }, 2);
    return j.chart.result[0].meta.regularMarketPrice;
  } catch { return 4.3; }
}

/* ---------- 3. bulk facts ---------- */
async function factsZip() {
  if (env.FACTS_ZIP) return env.FACTS_ZIP;
  const dest = path.join(os.tmpdir(), "companyfacts.zip");
  log("Downloading companyfacts.zip …");
  const r = await fetch("https://www.sec.gov/Archives/edgar/daily-index/xbrl/companyfacts.zip", { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`companyfacts.zip: HTTP ${r.status}`);
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest));
  log(`Downloaded ${(fs.statSync(dest).size / 1e9).toFixed(2)} GB`);
  return dest;
}
function eachCompany(zipPath, wanted, onFacts) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err) return reject(err);
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (e) => {
        const m = e.fileName.match(/CIK(\d{10})\.json$/);
        if (!m || !wanted.has(parseInt(m[1], 10))) return zip.readEntry();
        zip.openReadStream(e, (err2, rs) => {
          if (err2) return reject(err2);
          const chunks = [];
          rs.on("data", (c) => chunks.push(c));
          rs.on("end", async () => {
            try { await onFacts(parseInt(m[1], 10), JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
            catch (x) { /* logged by caller */ }
            zip.readEntry();
          });
          rs.on("error", reject);
        });
      });
      zip.readEntry();
    });
  });
}

/* ---------- 4. one company -> one row ---------- */
const FIELD_KEYS = SC.FIELDS.map((f) => f[0]);
const round = (v) => (v == null || !isFinite(v) ? null : Math.abs(v) >= 1000 ? Math.round(v) : Math.abs(v) >= 10 ? Math.round(v * 100) / 100 : Math.round(v * 10000) / 10000);
function rowFor(facts, meta, px, rf) {
  const result = core.compute(facts, mapping, meta.ticker);
  const rat = core.ratios(result);
  const val = core.valuation(result, rat, px ? px.price : null, null);
  const sector = px ? px.sector : "";
  const sic = /finance/i.test(sector) ? 6000 : 0;            // Nasdaq sector: banks/insurers/lenders
  const q = core.quality(result, rat, val, sic);
  const r = SC.rowFor(core, result, rat, val, q, { rf });
  return { cells: [meta.name, meta.ticker, meta.exchange, sector, px ? px.industry : "", ...FIELD_KEYS.map((k) => round(r[k]))],
           warnings: result.warnings.length, row: r };
}

/* ---------- 5. alerts ---------- */
async function alerts(table) {
  const screensFile = path.join(ROOT, "screens.json"), stateFile = path.join(ROOT, "state/alerts_state.json");
  if (!fs.existsSync(screensFile)) return;
  const screens = readJSON(screensFile).filter((s) => s.alert !== false);
  const state = fs.existsSync(stateFile) ? readJSON(stateFile) : {};
  const idx = Object.fromEntries(["name", "ticker", "exchange", "sector", "industry", ...FIELD_KEYS].map((k, i) => [k, i]));
  const messages = [], next = {};
  for (const s of screens) {
    let c;
    try { c = SC.compile(s.query); } catch (e) { messages.push(`⚠️ <b>${esc(s.name)}</b>: query error: ${esc(e.message)}`); continue; }
    const hits = table.filter((row) => c.test((k) => row[idx[k]])).map((row) => row[1]).sort();
    next[s.name] = { query: s.query, tickers: hits, at: new Date().toISOString().slice(0, 10) };
    const prev = state[s.name];
    if (!prev || prev.query !== s.query) {
      messages.push(`🆕 <b>${esc(s.name)}</b>: tracking started with ${hits.length} companies.${hits.length ? "\n" + list(hits.slice(0, 25), table, idx) : ""}`);
      continue;
    }
    const before = new Set(prev.tickers), now = new Set(hits);
    const added = hits.filter((t) => !before.has(t)), dropped = prev.tickers.filter((t) => !now.has(t));
    if (!added.length && !dropped.length) continue;
    let msg = `📊 <b>${esc(s.name)}</b> (${hits.length} match)\n<code>${esc(s.query)}</code>`;
    if (added.length) msg += `\n\n🟢 <b>New (${added.length})</b>\n${list(added.slice(0, 30), table, idx)}`;
    if (dropped.length) msg += `\n\n🔴 <b>Dropped (${dropped.length})</b>\n${dropped.slice(0, 30).join(", ")}`;
    if (env.SITE_URL) msg += `\n\n<a href="${env.SITE_URL.replace(/\/$/, "")}/?view=screens&q=${encodeURIComponent(s.query)}">Open screen</a>`;
    messages.push(msg);
  }
  fs.writeFileSync(stateFile, JSON.stringify(next, null, 1));
  for (const msg of messages) await telegram(msg);
  log(`Alerts: ${screens.length} screens, ${messages.length} message(s)`);
}
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
function list(tickers, table, idx) {
  const by = new Map(table.map((r) => [r[1], r]));
  return tickers.map((t) => { const r = by.get(t); const link = env.SITE_URL ? `<a href="${env.SITE_URL.replace(/\/$/, "")}/?t=${t}">${t}</a>` : `<b>${t}</b>`;
    return `${link} ${esc(r ? r[0] : "")}${r && r[idx.mcap] != null ? ` · $${Math.round(r[idx.mcap]).toLocaleString("en-US")}M` : ""}${r && r[idx.pe] != null ? ` · P/E ${r[idx.pe].toFixed(1)}` : ""}`; }).join("\n");
}
async function telegram(text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) { console.log("--- telegram (not configured) ---\n" + text); return; }
  const base = env.TELEGRAM_API || "https://api.telegram.org";
  for (let i = 0; i < text.length; i += 3900) {
    const r = await fetch(`${base}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: text.slice(i, i + 3900), parse_mode: "HTML", disable_web_page_preview: true }),
    });
    if (!r.ok) console.error("Telegram error", r.status, await r.text());
  }
}

/* ---------- main ---------- */
async function main() {
  if (!UA && !(env.FACTS_ZIP && env.TICKERS_FILE)) throw new Error("Set SEC_UA (name + email) — the SEC requires it.");
  const companies = await listedCompanies();
  log(`Listed companies: ${companies.size}`);
  let prices = new Map();
  try { prices = await nasdaqPrices(); log(`Nasdaq prices: ${prices.size}`); }
  catch (e) { log("Nasdaq price download failed:", e.message); }
  if (prices.size < companies.size * 0.5 && !env.PRICES_FILE) {
    log("Filling prices from Yahoo (slower) …");
    const todo = [...companies.values()].filter((c) => !prices.has(c.ticker));
    for (let i = 0; i < todo.length; i += 8) {
      const got = await Promise.all(todo.slice(i, i + 8).map((c) => yahooPrice(c.ticker)));
      got.forEach((g, k) => g && prices.set(todo[i + k].ticker, g));
      if (i % 800 === 0) log(`  ${i}/${todo.length}`);
    }
  }
  const rf = await riskFree();
  log(`10y Treasury: ${rf}%`);
  const zip = await factsZip();

  const limit = env.LIMIT ? parseInt(env.LIMIT, 10) : Infinity;
  const table = [], failures = [], noPrice = [];
  let seen = 0;
  await eachCompany(zip, new Set(companies.keys()), async (cik, facts) => {
    if (seen++ >= limit) return;
    const meta = companies.get(cik), px = prices.get(meta.ticker);
    try {
      const r = rowFor(facts, meta, px, rf);
      table.push(r.cells);
      if (!px) noPrice.push(meta.ticker);
    } catch (e) { failures.push([meta.ticker, String(e.message).slice(0, 120)]); }
    if (seen % 1000 === 0) log(`  processed ${seen}`);
  });
  table.sort((a, b) => (b[5 + FIELD_KEYS.indexOf("mcap")] || 0) - (a[5 + FIELD_KEYS.indexOf("mcap")] || 0));
  log(`Rows: ${table.length}, failed: ${failures.length}, without price: ${noPrice.length}`);

  const out = {
    built: new Date().toISOString(), rf, count: table.length,
    text: ["name", "ticker", "exchange", "sector", "industry"],
    fields: SC.FIELDS.map(([key, label, unit, group, , desc]) => ({ key, label, unit, group, desc })),
    rows: table,
  };
  fs.mkdirSync(path.join(ROOT, "public/data"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "public/data/screener.json"), JSON.stringify(out));
  log(`Wrote public/data/screener.json (${(fs.statSync(path.join(ROOT, "public/data/screener.json")).size / 1e6).toFixed(1)} MB)`);
  fs.mkdirSync(path.join(ROOT, "state"), { recursive: true });
  const byReason = {};
  for (const [t, why] of failures) { const k = why.replace(/\. Use the tag explorer.*$/, "").slice(0, 80); (byReason[k] = byReason[k] || []).push(t); }
  fs.writeFileSync(path.join(ROOT, "state/build_log.json"), JSON.stringify({
    built: out.built, rows: table.length, failedCount: failures.length, noPrice: noPrice.length,
    failedByReason: Object.fromEntries(Object.entries(byReason).sort((a, b) => b[1].length - a[1].length).map(([k, v]) => [k, { count: v.length, tickers: v.join(" ") }])),
    noPriceTickers: noPrice.join(" "),
  }, null, 1));
  await alerts(table);
  if (table.length < 100 && !env.LIMIT && !env.FACTS_ZIP) throw new Error("Suspiciously few rows; not deploying.");
}
main().catch((e) => { console.error(e); process.exit(1); });

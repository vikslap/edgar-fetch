(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const mon = (s) => new Date(s + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  const day = (s) => new Date(s + "T00:00:00Z").toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const status = (msg, err) => { $("status").innerHTML = msg ? (err ? `<span class="err">${esc(msg)}</span>` : esc(msg)) : ""; };

  let defaultMap = null, mapping = null, facts = null, result = null, rat = null, ticker = "";
  let unit = store.get("edgar.unit", 1000000);
  let px = null, pxErr = "", rf = null, val = null, dcfIn = null, co = null, tickers = null;
  const livePrice = () => (px && px.last ? px.last.price : null);
  const curPrice = () => { const o = parseFloat(store.get("edgar.price." + ticker, "")); return o > 0 ? o : livePrice(); };
  const headers = () => { const k = store.get("edgar.key", ""); return k ? { "x-access-key": k } : {}; };
  const api = async (path) => {
    const r = await fetch(path, { headers: headers() });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return { j, r };
  };

  // number formats (money in USD thousands internally)
  const fmtNum = (v, d = 0) => (v == null || !isFinite(v) ? "–" : Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
  const big = (v) => (v == null || !isFinite(v) ? "–" : (v < 0 ? "−$" : "$") + fmtNum(Math.abs(v) / 1000) + " <small>Mn</small>");
  const xf = (v, d = 1) => (v == null || !isFinite(v) ? "–" : v.toFixed(d));
  const pf = (v, d = 1) => (v == null || !isFinite(v) ? "–" : v.toFixed(d) + " <small>%</small>");
  const usd = (v, d = 2) => (v == null || !isFinite(v) ? "–" : (v < 0 ? "−$" : "$") + Math.abs(v).toFixed(d));

  // ---------------- mapping ----------------
  async function loadMapping() {
    defaultMap = await (await fetch("mapping.json", { cache: "no-cache" })).json();
    const saved = store.get("edgar.mapping", null);
    mapping = saved || defaultMap;
    $("mapText").value = JSON.stringify(mapping, null, 2);
    if (saved) $("mapMsg").textContent = "Using your saved mapping.";
  }
  $("mapSave").onclick = () => {
    try { mapping = JSON.parse($("mapText").value); store.set("edgar.mapping", mapping); $("mapMsg").textContent = "Saved."; if (facts) run(); }
    catch (e) { $("mapMsg").textContent = "Not valid JSON: " + e.message; }
  };
  $("mapReset").onclick = () => {
    store.del("edgar.mapping"); mapping = defaultMap; $("mapText").value = JSON.stringify(mapping, null, 2);
    $("mapMsg").textContent = "Reset to the server's mapping.json."; if (facts) run();
  };

  // ---------------- settings ----------------
  $("accessKey").value = store.get("edgar.key", "");
  $("avKey").value = store.get("edgar.avkey", "");
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("[data-settings]"); if (!a) return;
    e.preventDefault(); $("settingsBox").open = true; $("settingsBox").scrollIntoView({ block: "center" }); setTimeout(() => $("avKey").focus(), 300);
  });
  $("avSave").onclick = () => { store.set("edgar.avkey", $("avKey").value.trim()); status("Alpha Vantage key saved in this browser."); };
  $("keySave").onclick = () => { store.set("edgar.key", $("accessKey").value); status("Access key saved."); };
  $("priceSave").onclick = () => { if (!ticker) return; store.set("edgar.price." + ticker, $("priceIn").value.trim()); drawAll(); };
  $("home").onclick = () => { history.replaceState(null, "", location.pathname); location.reload(); };

  // ---------------- search with company-name typeahead ----------------
  async function loadTickers() {
    if (tickers) return tickers;
    const c = store.get("edgar.tickers", null);
    if (c && c.at > Date.now() - 7 * 86400000) return (tickers = c.list);
    try { const { j } = await api("/api/tickers"); tickers = j; store.set("edgar.tickers", { at: Date.now(), list: j }); }
    catch { tickers = []; }
    return tickers;
  }
  let ddSel = -1, ddItems = [];
  function search(q) {
    q = q.trim().toUpperCase();
    if (!q || !tickers) return [];
    const a = [], b = [], c = [];
    for (const [t, n] of tickers) {
      const N = n.toUpperCase();
      if (t === q) a.unshift([t, n]);
      else if (t.startsWith(q)) a.push([t, n]);
      else if (N.startsWith(q)) b.push([t, n]);
      else if (q.length > 2 && N.includes(q)) c.push([t, n]);
      if (a.length + b.length > 40) break;
    }
    return [...a, ...b, ...c].slice(0, 8);
  }
  function drawDd() {
    const dd = $("dd");
    if (!ddItems.length) { dd.classList.remove("on"); return; }
    dd.innerHTML = ddItems.map(([t, n], i) => `<div data-t="${esc(t)}" class="${i === ddSel ? "sel" : ""}" role="option"><b>${esc(t)}</b><span>${esc(n)}</span></div>`).join("");
    dd.classList.add("on");
    dd.querySelectorAll("div").forEach((d) => (d.onmousedown = (e) => { e.preventDefault(); pick(d.dataset.t); }));
  }
  function pick(t) { $("ticker").value = t; ddItems = []; drawDd(); go(t); }
  $("ticker").addEventListener("focus", loadTickers);
  $("ticker").addEventListener("input", async () => { await loadTickers(); ddSel = -1; ddItems = search($("ticker").value); drawDd(); });
  $("ticker").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { ddSel = Math.min(ddSel + 1, ddItems.length - 1); drawDd(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { ddSel = Math.max(ddSel - 1, 0); drawDd(); e.preventDefault(); }
    else if (e.key === "Escape") { ddItems = []; drawDd(); }
  });
  $("ticker").addEventListener("blur", () => setTimeout(() => { ddItems = []; drawDd(); }, 100));
  $("searchForm").onsubmit = (e) => {
    e.preventDefault();
    const q = $("ticker").value.trim().toUpperCase();
    let t = q;
    if (ddSel >= 0 && ddItems[ddSel]) t = ddItems[ddSel][0];                    // arrow-key choice
    else if (!(tickers || []).some(([x]) => x === q) && ddItems.length) t = ddItems[0][0]; // typed a name
    pick(t);
  };

  function drawRecent() {
    const r = store.get("edgar.recent", []);
    $("recent").innerHTML = r.length ? "Recent: " + r.map((t) => `<span class="chip" data-t="${esc(t)}">${esc(t)}</span>`).join("") : "";
    $("recent").querySelectorAll(".chip").forEach((c) => (c.onclick = () => pick(c.dataset.t)));
  }
  function pushRecent(t) { store.set("edgar.recent", [t, ...store.get("edgar.recent", []).filter((x) => x !== t)].slice(0, 10)); drawRecent(); }

  // ---------------- fetch ----------------
  async function go(t) {
    t = (t || "").trim().toUpperCase();
    if (!t) return;
    if (view !== "company") showView("company");
    status(`Fetching ${t} from EDGAR…`);
    const fresh = $("freshBox").checked ? "?fresh=1" : "";
    const pxP = api(`/api/prices/${encodeURIComponent(t)}${fresh}`).then((x) => x.j);
    const coP = api(`/api/company/${encodeURIComponent(t)}${fresh}`).then((x) => x.j).catch(() => null);
    const rfP = rf ? Promise.resolve(rf) : api(`/api/rate`).then((x) => x.j).catch(() => null);
    try {
      const { j, r } = await api(`/api/facts/${encodeURIComponent(t)}${fresh}`);
      px = null; pxErr = "";
      try { px = await pxP; } catch (e) { pxErr = e.message; }
      [co, rf] = await Promise.all([coP, rfP]);
      facts = j; ticker = t; dcfIn = null;
      // foreign filers: exchange rate to USD, and ADR sizing from the quoted market cap
      facts._opts = {};
      const basis = EdgarCore.detectBasis(facts);
      if (basis.cur !== "USD") { try { facts._opts.fx = (await api(`/api/fx/${basis.cur}`)).j.usd; } catch (e) { /* shown as a note */ } }
      if (basis.foreign && px && px.last && px.last.price > 0) {
        const d = await ensureScreener();
        const row = d && d.rows.find((r) => r[1] === t);
        const mq = row && row[d.ix.mcap_quote];
        if (mq > 0) facts._opts.adrShares = (mq * 1000) / px.last.price;
      }
      facts._meta = { cik: r.headers.get("x-cik"), fetched: r.headers.get("x-fetched") };
      pushRecent(t);
      history.replaceState(null, "", `?t=${encodeURIComponent(t)}`);
      run();
      status("");
      scrollTo({ top: 0 });
    } catch (e) { status(e.message, true); }
  }

  function run() {
    try { result = EdgarCore.compute(facts, mapping, ticker, facts._opts || {}); }
    catch (e) { status(e.message, true); $("result").hidden = true; drawTags(); return; }
    try { rat = EdgarCore.ratios(result); } catch (e) { rat = null; console.error(e); }
    $("empty").hidden = true; $("result").hidden = view !== "company"; $("subnav").hidden = view !== "company";
    $("navName").textContent = shortName(result.name);
    $("priceIn").value = store.get("edgar.price." + ticker, "");
    drawAll(); drawTables(); drawDocs(); drawConcalls(); drawTags(); drawStar();
    document.title = `${ticker} · ${result.name} · EDGAR Fetch`;
  }
  const shortName = (n) => n.replace(/,?\s+(INC|CORP|CORPORATION|CO|LTD|PLC|HOLDINGS|GROUP|N\.?V\.?|S\.?A\.?)\.?$/i, "").slice(0, 24);
  const title = (n) => n.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(Inc|Corp|Co|Ltd|Plc)\b\.?/g, (m) => m.replace(/\.$/, "") + ".").replace(/\.\./g, ".");

  // ---------------- summary ----------------
  function drawAll() {
    val = rat ? EdgarCore.valuation(result, rat, curPrice(), px && px.prices) : null;
    drawHeader(); drawKeybox(); drawAbout(); drawAlerts(); drawCharts(); drawDcf(); drawAnalysis(); drawModels(); drawPeers();
  }

  function drawHeader() {
    $("coName").textContent = title((co && co.name) || result.name);
    const p = curPrice(), overridden = parseFloat(store.get("edgar.price." + ticker, "")) > 0;
    let chg = "";
    if (px && px.prices && px.prices.length > 1 && !overridden) {
      const ps = px.prices, lastIdx = ps.at(-1)[0] === px.last.date ? ps.length - 2 : ps.length - 1;
      const prev = ps[lastIdx] && ps[lastIdx][1];
      if (prev) { const c = (p / prev - 1) * 100; chg = `<span class="chg ${c < 0 ? "neg-t" : "pos-t"}">${c >= 0 ? "▲" : "▼"} ${Math.abs(c).toFixed(2)}%</span>`; }
    }
    $("pxBlock").innerHTML = p == null
      ? `<span class="p">–</span><span class="d err">No live price${pxErr ? "" : ""}. Set one under Data tools → Settings.</span>`
      : `<div><span class="p">${usd(p)}</span>${chg}</div><span class="d">${overridden ? "your price (override)" : `${day(px.last.date)} · ${esc(px.source)}, delayed`}</span>`;

    const L = [];
    if (co && co.website) L.push(`<a href="${esc(/^https?:/.test(co.website) ? co.website : "https://" + co.website)}" target="_blank" rel="noopener">↗ ${esc(co.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))}</a>`);
    const ex = co && co.exchanges && co.exchanges.length ? co.exchanges : [];
    const tk = co && co.tickers && co.tickers.length ? co.tickers : [ticker];
    tk.slice(0, 3).forEach((t, i) => L.push(`<span><span class="k">${esc(ex[i] || ex[0] || "Ticker")}:</span> ${esc(t)}</span>`));
    const cik = (co && co.cik) || (facts._meta && facts._meta.cik);
    if (cik) L.push(`<a href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=&dateb=&owner=include&count=40" target="_blank" rel="noopener">↗ SEC: CIK ${parseInt(cik, 10)}</a>`);
    if (co && co.sicDescription) L.push(`<span class="k">${esc(title(co.sicDescription))}</span>`);
    const B = result.basis || {};
    if (B.cur && B.cur !== "USD" || B.ns === "ifrs-full") L.push(`<span class="k" title="${esc(result.notes.filter((n) => /Reports in|IFRS|ADR/.test(n)).join(" "))}">ⓘ Reports ${B.ns === "ifrs-full" ? "under IFRS " : ""}in ${esc(B.cur)}${B.cur !== "USD" ? ", shown in USD" : ""}</span>`);
    if (result.noRevenue) L.push(`<span class="k">ⓘ No revenue reported yet</span>`);
    $("coLinks").innerHTML = L.join("");
  }

  function drawKeybox() {
    if (!rat || !val) { $("keybox").innerHTML = ""; return; }
    const k = rat.kpis, m = val.multiples, s = val.peStats || {}, p = curPrice();
    const rows = (lbl) => (rat.rows.find((r) => r.label === lbl) || { v: [] }).v;
    const n = result.aEnds.length, L = n - 1;
    const box = (title, key) => { const b = rat.boxes.find((x) => x.title === title); const r = b && b.rows.find((x) => x[0] === key); return r ? r[1] : null; };
    const prices1y = px && px.prices ? px.prices.filter((x) => x[0] >= new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10)).map((x) => x[1]) : [];
    const hi = prices1y.length ? Math.max(...prices1y) : null, lo = prices1y.length ? Math.min(...prices1y) : null;
    const bvps = val.shares && val.equity != null ? val.equity / val.shares : null;
    const epsCagr = box("Compounded EPS Growth", "5 Years");
    const peg = m.pe != null && epsCagr > 0 ? m.pe / epsCagr : null;
    const pl = (key) => { const b = result.blocks.find((x) => x.title === "PROFIT & LOSS"); const r = b.rows.find((x) => x.key === key); return r ? r.values : []; };
    const cf = (key) => { const b = result.blocks.find((x) => x.title === "CASH FLOW"); const r = b && b.rows.find((x) => x.key === key); return r ? r.values : []; };
    const niFY = (() => { const g = (key) => pl(key)[L] || 0; const sales = pl("sales")[L]; return sales == null ? null : sales - g("cogs") - g("sga") - g("rnd") - g("interest") + g("other_income") - g("other_nonop") - g("tax"); })();
    const cfo = cf("cfo")[L];
    const opm = rows("Operating margin (EBIT) %").slice(0, n).slice(-5).filter((x) => x != null);
    const opm5 = opm.length ? opm.reduce((a, b) => a + b, 0) / opm.length : null;
    const taxRate = (rows("Effective tax rate %")[L] ?? 21) / 100;
    const invested = val.equity != null ? val.equity + m.debt - m.cash : null;
    const roic = invested > 0 && k.ebit != null ? (k.ebit * (1 - taxRate) / invested) * 100 : null;
    const d = dcfResult();
    const items = [
      ["Market Cap", big(m.mcap)], ["Current Price", usd(p)], ["High / Low", hi ? `${usd(hi)} / ${usd(lo)}` : "–", "52-week, closing prices"],
      ["Stock P/E", xf(m.pe), `Price ÷ EPS (${k.basis})`], ["Book Value", usd(bvps), "Shareholders' equity ÷ shares outstanding"], ["Dividend Yield", pf(m.divYield, 2)],
      ["ROCE", pf(k.roce), "EBIT ÷ average (total assets − current liabilities), last FY"], ["ROE", pf(k.roe), "Net profit ÷ average equity, last FY"], ["ROIC", pf(roic), "EBIT × (1 − tax rate) ÷ (equity + debt − cash), latest"],
      ["EPS", usd(k.eps), k.basis], ["5Yr Median PE", xf(s.median5), "Median daily P/E over the last 5 years"], ["PEG Ratio", xf(peg, 2), "P/E ÷ 5-year EPS CAGR"],
      ["Price to Sales", xf(m.mcap && k.sales ? m.mcap / k.sales : null, 2)], ["Price to Book", xf(m.pb, 2)], ["Price to FCF", xf(m.pfcf)],
      ["EV / EBITDA", xf(m.evEbitda)], ["EV / Sales", xf(m.evSales, 2)], ["Int Coverage", xf(rows("Interest coverage (x)")[L]), "EBIT ÷ interest expense, last FY"],
      ["Debt to Equity", xf(m.debt && val.equity > 0 ? m.debt / val.equity : 0, 2)], ["Net Debt", big(m.netDebt)], ["Current Ratio", xf(rows("Current ratio (x)")[L], 2)],
      ["CFO to PAT", xf(cfo != null && niFY > 0 ? cfo / niFY : null, 2), "Operating cash flow ÷ net profit, last FY"], ["FCF to PAT", xf(m.fcf != null && niFY > 0 ? m.fcf / niFY : null, 2)], ["Earnings Yield", pf(m.earningsYield, 2)],
      ["OPM 5Year", pf(opm5), "Average operating (EBIT) margin, last 5 fiscal years"], ["Sales Growth 5Y", pf(box("Compounded Sales Growth", "5 Years")), "CAGR"], ["Profit Growth 5Y", pf(box("Compounded Profit Growth", "5 Years")), "CAGR"],
      ["Intrinsic Value", d && d.perShare ? usd(d.perShare, 0) : "–", "DCF value per share with the inputs in the Valuation section"], ["Implied Growth", d && d.implied != null ? pf(d.implied * 100) : "–", "Reverse DCF: FCF growth (years 1–5) priced in today"], ["Shareholder Yield", pf(m.shareholderYield, 2), "(Dividends + buybacks) ÷ market cap, last FY"],
      ["SBC % of FCF", pf(m.sbcPctFcf, 0), "Stock-based compensation ÷ free cash flow, last FY"], ["Dilution 1Y", pf(m.dilution), "Change in diluted shares, last FY"], ["Shares Out.", val.shares ? fmtNum(val.shares / 1000, 1) + " <small>Mn</small>" : "–", result.sharesLatest ? `As of ${result.sharesLatest.end}` : ""],
    ];
    $("keybox").innerHTML = items.map(([l, v, t], i) => `<div class="kr${Math.floor(i / 3) % 2 ? " z3" : ""}${Math.floor(i / 2) % 2 ? " z2" : ""}${i % 2 ? " z1" : ""}"${t ? ` title="${esc(t)}"` : ""}><span class="l">${esc(l)}</span><span class="v">${v}</span></div>`).join("");
  }

  function drawAbout() {
    const el = $("about");
    if (!co) { el.innerHTML = `<h3>About</h3><p class="muted">Company profile unavailable.</p>`; return; }
    const fye = co.fiscalYearEnd ? new Date(`2001-${co.fiscalYearEnd.slice(0, 2)}-${co.fiscalYearEnd.slice(2)}T00:00:00Z`).toLocaleDateString("en-US", { day: "numeric", month: "long", timeZone: "UTC" }) : null;
    const latest = (f) => co.filings.find((x) => x.form === f || x.form === f + "/A");
    const tenK = latest("10-K") || latest("20-F"), tenQ = latest("10-Q"), eightK = latest("8-K"), proxy = latest("DEF 14A");
    const name = title(co.name);
    let p = `${esc(name)} is ${co.category ? `a ${esc(co.category.toLowerCase())}` : "a company"} filing with the SEC under industry code ${esc(co.sic)} (<i>${esc(title(co.sicDescription || ""))}</i>).`;
    if (co.stateOfIncorporation) p += ` Incorporated in ${esc(co.stateOfIncorporation)}`;
    if (co.address) p += `${co.stateOfIncorporation ? ", headquartered" : " Headquartered"} at ${esc(title(co.address))}`;
    p += ".";
    if (fye) p += ` Fiscal year ends ${fye}.`;
    if (co.formerNames && co.formerNames.length) p += ` Formerly ${co.formerNames.slice(0, 2).map((x) => esc(title(x))).join(", ")}.`;
    const li = (f, lbl) => (f ? `<li><a href="${esc(f.url)}" target="_blank" rel="noopener">${lbl}</a> <span class="muted">· ${day(f.date)}</span></li>` : "");
    el.innerHTML = `<h3>About</h3><p>${p}</p>
      <p class="sub">The SEC feed has no business description. For what the company does, read Item 1 (Business) of the annual report linked below.</p>
      <h3>Key filings</h3><ul>
        ${li(tenK, `Annual report (${tenK ? esc(tenK.form) : ""})`)}${li(tenQ, "Latest quarterly report (10-Q)")}${li(eightK, "Latest announcement (8-K)")}${li(proxy, "Proxy statement (DEF 14A)")}
        ${co.investorWebsite ? `<li><a href="${esc(co.investorWebsite)}" target="_blank" rel="noopener">Investor relations site</a></li>` : ""}
      </ul>`;
  }

  function drawAlerts() {
    const w = result.warnings, n = result.notes, q = result.quiet;
    const NICE = { "QUARTERS": "Quarters", "PROFIT & LOSS": "Profit & Loss", "BALANCE SHEET": "Balance Sheet", "CASH FLOW": "Cash Flow" };
    const count = w.length + n.length + Object.keys(q).length;
    if (!count) { $("alerts").innerHTML = ""; return; }
    let h = `<details${w.length ? " open" : ""}><summary>Data notes (${count})${w.length ? ` · <span class="err">${w.length} missing item${w.length > 1 ? "s" : ""}</span>` : ""}</summary><div class="alerts" style="margin-top:8px"><ul>`;
    for (const x of w) h += `<li>${esc(x)}. Use the tag explorer under Data tools to find the right tag.</li>`;
    for (const x of n) h += `<li>${esc(x)}</li>`;
    for (const [t, labels] of Object.entries(q)) h += `<li class="quiet">${esc(NICE[t] || t)}, not reported (set to 0): ${esc(labels.join(", "))}</li>`;
    $("alerts").innerHTML = h + "</ul></div></details>";
  }

  // ---------------- charts ----------------
  // ---------------- stock chart (screener-style) ----------------
  const MULT = {
    pe: { label: "P/E", base: "EPS (TTM)", baseFmt: (v) => "$" + v.toFixed(2), stat: "pe" },
    ev_ebitda: { label: "EV/EBITDA", base: "EBITDA ($ Mn, TTM)", baseFmt: (v) => "$" + fmtNum(v, 0) + "M" },
    pb: { label: "P/B", base: "Book value per share", baseFmt: (v) => "$" + v.toFixed(2) },
    ps: { label: "P/S", base: "Sales per share (TTM)", baseFmt: (v) => "$" + v.toFixed(2) },
  };
  const chart = { range: store.get("edgar.range", "5Y"), mode: "price", show: { price: true, d50: true, d200: true, vol: true, pe: true, med: true, eps: true } };
  const RANGE_DAYS = { "1M": 31, "6M": 183, "1Y": 366, "3Y": 1096, "5Y": 1827, "10Y": 3653, MAX: 1e6 };
  let maCache = null;
  function sma(arr, w) {
    const out = new Array(arr.length).fill(null); let sum = 0;
    for (let i = 0; i < arr.length; i++) { sum += arr[i]; if (i >= w) sum -= arr[i - w]; if (i >= w - 1) out[i] = sum / w; }
    return out;
  }
  function drawCharts() {
    if (!val) return;
    document.querySelectorAll("#ranges button").forEach((b) => b.classList.toggle("on", b.dataset.r === chart.range));
    document.querySelectorAll("#modeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.m === chart.mode));
    const s = val.peStats, m = val.multiples;
    let peTxt = "";
    const mode = chart.mode === "price" ? "pe" : chart.mode, st = val.multStats && val.multStats[mode], lab = MULT[mode].label;
    const cur = mode === "pe" ? m.pe : st && st.current;
    if (!px) peTxt = `<span class="err">Price history unavailable${pxErr ? ": " + esc(pxErr) : ""}. Valuation uses the price set under Data tools → Settings.</span>`;
    else if (st && cur != null && st.median5) peTxt = `${lab} now <b>${cur.toFixed(1)}×</b>, ${cur > st.median5 ? "above" : "below"} its 5-year median of <b>${st.median5.toFixed(1)}×</b> (range ${st.min.toFixed(0)}–${st.max.toFixed(0)}×)` +
      (st.pctile != null ? `. Cheaper than ${(100 - st.pctile).toFixed(0)}% of trading days in the last 5 years.` : ".");
    else if (st && st.median5) peTxt = `5-year median ${lab} ${st.median5.toFixed(1)}× (no current value: the denominator is negative or missing).`;
    else peTxt = `Not enough history for ${lab}.`;
    $("peText").innerHTML = peTxt;
    stockChart();
  }
  $("ranges").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; chart.range = b.dataset.r; store.set("edgar.range", chart.range); drawCharts(); };
  $("modeSeg").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; chart.mode = b.dataset.m; drawCharts(); };

  function stockChart() {
    const el = $("stock"), all = px ? px.prices : [];
    if (!all.length) { el.innerHTML = `<div class="sub" style="padding:80px 0;text-align:center">No price data</div>`; $("chLegend").innerHTML = ""; $("rangeRet").innerHTML = ""; return; }
    if (!maCache || maCache.src !== all) { const c = all.map((x) => x[1]); maCache = { src: all, d50: sma(c, 50), d200: sma(c, 200) }; }
    const lastD = all.at(-1)[0];
    const startD = new Date(Date.parse(lastD) - RANGE_DAYS[chart.range] * 86400000).toISOString().slice(0, 10);
    let i0 = all.findIndex((x) => x[0] >= startD); if (i0 < 0) i0 = 0;
    const days = all.slice(i0).map((x, k) => ({ d: x[0], p: x[1], v: x[2] || 0, d50: maCache.d50[i0 + k], d200: maCache.d200[i0 + k] }));
    // return over the range
    const first = days[0].p, last = days.at(-1).p, yrs = (Date.parse(lastD) - Date.parse(days[0].d)) / (365.25 * 86400000);
    const ret = (last / first - 1) * 100, cagr = yrs >= 0.95 ? (Math.pow(last / first, 1 / yrs) - 1) * 100 : null;
    $("rangeRet").innerHTML = `<span class="${ret < 0 ? "neg-t" : "pos-t"}">${ret < 0 ? "↘" : "↗"} ${Math.abs(ret).toFixed(1)}%</span>` + (cagr != null ? `<span>${cagr.toFixed(1).replace("-", "−")}% <small>CAGR</small></span>` : "");

    // PE mode data
    const pe = chart.mode !== "price", MD = MULT[chart.mode] || MULT.pe;
    let peMap = null, epsBars = [];
    if (pe) {
      peMap = new Map((val.multSeries[chart.mode] || []).map((x) => [x[0], x[1] != null && x[1] > 0 && x[1] < 500 ? x[1] : null]));
      days.forEach((x) => (x.pe = peMap.has(x.d) ? peMap.get(x.d) : null));
      epsBars = [...new Map((val.bases[chart.mode] || []).filter((e) => e[0] >= days[0].d && e[1] != null).map((e) => [e[0], e])).values()];
    }
    const peVals = pe ? days.map((x) => x.pe).filter((v) => v != null) : [];
    const medPe = peVals.length ? [...peVals].sort((a, b) => a - b)[peVals.length >> 1] : null;

    // bucket to ~1 point per 2px
    const W = Math.max(300, el.clientWidth || 800), padL = 52, padR = 58, innerW = W - padL - padR;
    const step = Math.max(1, Math.ceil(days.length / (innerW / 2)));
    const pts = [];
    for (let k = 0; k < days.length; k += step) {
      const grp = days.slice(k, k + step), e = grp.at(-1);
      pts.push({ ...e, v: grp.reduce((a, x) => a + x.v, 0) / grp.length });
    }
    if (pts.at(-1).d !== days.at(-1).d) pts.push(days.at(-1));

    const showLow = pe ? chart.show.eps && epsBars.length : chart.show.vol && pts.some((x) => x.v > 0);
    const H1 = 280, gap = 14, H2 = showLow ? 70 : 0, axisH = 24, H = H1 + (showLow ? gap + H2 : 0) + axisH;
    const t0 = Date.parse(pts[0].d), t1 = Date.parse(pts.at(-1).d);
    const X = (d) => padL + ((Date.parse(d) - t0) / (t1 - t0 || 1)) * innerW;
    // top panel scale
    const topSeries = pe ? [chart.show.pe && "pe"] : [chart.show.price && "p", chart.show.d50 && "d50", chart.show.d200 && "d200"];
    const tv = []; pts.forEach((x) => topSeries.forEach((k) => k && x[k] != null && tv.push(x[k])));
    if (pe && chart.show.med && medPe != null) tv.push(medPe);
    if (!tv.length) tv.push(pe ? 0 : first);
    let lo = Math.min(...tv), hi = Math.max(...tv); const pad = (hi - lo) * 0.06 || 1; lo = Math.max(0, lo - pad); hi += pad;
    const Y = (v) => 8 + (1 - (v - lo) / (hi - lo)) * (H1 - 16);
    const fmtP = (v) => (pe ? v.toFixed(0) + "×" : "$" + (v >= 1000 ? Math.round(v).toLocaleString() : v >= 100 ? v.toFixed(0) : v.toFixed(2)));
    const ticks = niceTicks(lo, hi, 5), tstep = ticks.length > 1 ? ticks[1] - ticks[0] : 1;
    const fmtAxis = (v) => (pe ? Math.round(v) + "×" : "$" + (tstep >= 1 ? Math.round(v).toLocaleString() : v.toFixed(tstep >= 0.1 ? 1 : 2)));
    const path = (k) => { let d = "", pen = false; for (const x of pts) { const v = x[k]; if (v == null) { pen = false; continue; } d += (pen ? "L" : "M") + X(x.d).toFixed(1) + " " + Y(v).toFixed(1); pen = true; } return d; };
    // bottom panel
    const y2top = H1 + gap;
    let low = "";
    if (showLow && !pe) {
      const vmax = Math.max(...pts.map((x) => x.v)) || 1, bw = Math.max(1, innerW / pts.length - 1);
      low = pts.map((x) => { const h = (x.v / vmax) * (H2 - 4); return `<rect class="vol" x="${(X(x.d) - bw / 2).toFixed(1)}" y="${(y2top + H2 - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}"/>`; }).join("") +
        `<text x="${padL - 6}" y="${y2top + 10}" text-anchor="end">${fmtVol(vmax)}</text><text x="${padL - 6}" y="${y2top + H2}" text-anchor="end">0</text>`;
    } else if (showLow && pe) {
      const ev = epsBars.map((e) => e[1]), emax = Math.max(0.01, ...ev.map(Math.abs)), mid = Math.min(...ev) < 0 ? y2top + H2 / 2 : y2top + H2;
      const scale = (Math.min(...ev) < 0 ? H2 / 2 : H2 - 4) / emax;
      low = epsBars.map((e, k) => {
        const xa = Math.max(padL, X(e[0])), xb = k + 1 < epsBars.length ? X(epsBars[k + 1][0]) : padL + innerW;
        const h = Math.abs(e[1]) * scale;
        return `<rect class="eps${e[1] < 0 ? " neg" : ""}" x="${xa.toFixed(1)}" y="${(e[1] >= 0 ? mid - h : mid).toFixed(1)}" width="${Math.max(1, xb - xa - 2).toFixed(1)}" height="${h.toFixed(1)}"/>`;
      }).join("") + `<text x="${padL - 6}" y="${y2top + 10}" text-anchor="end">${MD.baseFmt(emax)}</text>`;
    }
    // x axis ticks
    const spanY = (t1 - t0) / (365.25 * 86400000);
    let xt = "";
    const xTicks = [];
    if (spanY > 2.5) { const s = spanY > 6 ? 2 : 1; for (let y = new Date(t0).getUTCFullYear() + 1; y <= new Date(t1).getUTCFullYear(); y += s) xTicks.push([`${y}-01-01`, String(y)]); }
    else { const mStep = spanY > 1.2 ? 6 : spanY > 0.4 ? 2 : 1; const d = new Date(t0); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1);
      for (; d.getTime() <= t1; d.setUTCMonth(d.getUTCMonth() + mStep)) xTicks.push([d.toISOString().slice(0, 10), d.toLocaleDateString("en-US", { month: "short", year: spanY > 0.4 ? "numeric" : undefined, day: spanY > 0.4 ? undefined : "numeric", timeZone: "UTC" })]); }
    for (const [d, l] of xTicks) { const x = X(d); if (x < padL + 10 || x > padL + innerW - 10) continue; xt += `<text x="${x}" y="${H - 6}" text-anchor="middle">${l}</text>`; }
    const lp = pts.at(-1);
    const endLabel = (k, cls, txt) => (lp[k] == null ? "" : `<circle class="dot" cx="${X(lp.d)}" cy="${Y(lp[k])}" r="4" fill="var(--${cls})"/>`);
    const lines = pe
      ? (chart.show.med && medPe != null ? `<line x1="${padL}" x2="${padL + innerW}" y1="${Y(medPe)}" y2="${Y(medPe)}" class="ref"/><text x="${padL + 6}" y="${Y(medPe) - 6}" class="reft">Median ${MD.label} ${medPe.toFixed(1)}</text>` : "") +
        (chart.show.pe ? `<path class="ln s1" d="${path("pe")}"/>${endLabel("pe", "s1")}` : "")
      : (chart.show.d200 ? `<path class="ln ma s3" d="${path("d200")}"/>` : "") + (chart.show.d50 ? `<path class="ln ma s2" d="${path("d50")}"/>` : "") +
        (chart.show.price ? `<path class="ln s1" d="${path("p")}"/>${endLabel("p", "s1")}` : "");
    el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="${pe ? MD.label : "Share price"} chart">
      ${ticks.map((v) => `<line x1="${padL}" x2="${padL + innerW}" y1="${Y(v)}" y2="${Y(v)}" class="grid"/><text x="${padL + innerW + 8}" y="${Y(v) + 4}">${fmtAxis(v)}</text>`).join("")}
      <line x1="${padL}" x2="${padL + innerW}" y1="${H1}" y2="${H1}" class="ax"/>
      ${showLow ? `<line x1="${padL}" x2="${padL + innerW}" y1="${y2top + H2}" y2="${y2top + H2}" class="ax"/><text x="${padL - 6}" y="${y2top + H2 / 2 + 4}" text-anchor="end" style="display:none"></text>` : ""}
      ${low}${lines}${xt}
      <line class="xh" y1="4" y2="${H - axisH}" x1="0" x2="0" visibility="hidden"/>
      <g id="hdots"></g>
      <rect x="${padL}" y="0" width="${innerW}" height="${H - axisH}" fill="transparent" class="hit"/>
    </svg><div class="hbox" id="hbox"></div>`;

    // legend with checkboxes (series colour on the box, current value beside the name)
    const lv = (v, f) => (v == null ? "" : `<span class="val">${f(v)}</span>`);
    const leg = pe
      ? [["pe", MD.label, "var(--s1)", lv(lp.pe, (v) => v.toFixed(1))], ["med", `Median ${MD.label}`, "var(--muted)", lv(medPe, (v) => v.toFixed(1))], ["eps", MD.base, "var(--vol)", lv((epsBars.at(-1) || [])[1], MD.baseFmt)]]
      : [["price", "Price", "var(--s1)", lv(lp.p, fmtP)], ["d50", "50 DMA", "var(--s2)", lv(lp.d50, fmtP)], ["d200", "200 DMA", "var(--s3)", lv(lp.d200, fmtP)], ["vol", "Volume", "var(--vol)", ""]];
    $("chLegend").innerHTML = leg.map(([k, l, c, v]) => `<label style="--c:${c}"><input type="checkbox" data-k="${k}"${chart.show[k] ? " checked" : ""}>${l} ${v}</label>`).join("");
    $("chLegend").querySelectorAll("input").forEach((i) => (i.onchange = () => { chart.show[i.dataset.k] = i.checked; stockChart(); }));

    // hover: crosshair, dots, info box
    const svg = el.querySelector("svg"), xh = svg.querySelector(".xh"), hd = svg.querySelector("#hdots"), hb = $("hbox");
    const hit = svg.querySelector(".hit");
    hit.addEventListener("mousemove", (e) => {
      const mx = e.clientX - svg.getBoundingClientRect().left;
      let best = pts[0], bd = 1e9;
      for (const x of pts) { const dd = Math.abs(X(x.d) - mx); if (dd < bd) { bd = dd; best = x; } }
      const cx = X(best.d);
      xh.setAttribute("x1", cx); xh.setAttribute("x2", cx); xh.setAttribute("visibility", "visible");
      const dots = pe ? [["pe", "s1"]] : [["d200", "s3"], ["d50", "s2"], ["p", "s1"]];
      hd.innerHTML = dots.filter(([k]) => best[k] != null && chart.show[{ p: "price", pe: "pe", d50: "d50", d200: "d200" }[k]]).map(([k, c]) => `<circle class="dot" cx="${cx}" cy="${Y(best[k])}" r="4.5" fill="var(--${c})"/>`).join("");
      const cell = (l, v) => `<div><small>${l}</small><b>${v}</b></div>`;
      const fromHere = (last / best.p - 1) * 100;
      hb.innerHTML = pe
        ? cell(day(best.d), best.pe == null ? "–" : best.pe.toFixed(1) + "×") + cell(`Median ${MD.label}`, medPe == null ? "–" : medPe.toFixed(1) + "×") + cell("Price", usd(best.p))
        : cell(day(best.d), usd(best.p)) + cell("From here", `<span class="${fromHere < 0 ? "neg-t" : "pos-t"}">${fromHere >= 0 ? "↗" : "↘"} ${Math.abs(fromHere).toFixed(1)}%</span>`) +
          cell("50 DMA", best.d50 == null ? "–" : fmtP(best.d50)) + cell("200 DMA", best.d200 == null ? "–" : fmtP(best.d200)) + (best.v ? cell("Vol", fmtVol(best.v)) : "");
      hb.style.display = "flex";
      const bw = hb.offsetWidth;
      hb.style.left = Math.max(0, Math.min(cx - bw / 2, W - bw)) + "px";
      hb.style.top = "-6px";
    });
    hit.addEventListener("mouseleave", () => { xh.setAttribute("visibility", "hidden"); hd.innerHTML = ""; hb.style.display = "none"; });
  }
  function niceTicks(lo, hi, n) {
    const raw = (hi - lo) / n, mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
    const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag, out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
    return out;
  }
  const fmtVol = (v) => (v >= 1e9 ? (v / 1e9).toFixed(1) + "B" : v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? (v / 1e3).toFixed(0) + "K" : String(Math.round(v)));

  // ---------------- analysis: pros/cons + quality scores ----------------
  function drawAnalysis() {
    if (!rat || !val) return;
    const sic = co && co.sic ? parseInt(co.sic, 10) : 0;
    const q = EdgarCore.quality(result, rat, val, sic);
    const d = dcfResult();
    const pc = EdgarCore.prosCons(result, rat, val, q, d ? d.implied : null);
    $("pros").innerHTML = pc.pros.length ? pc.pros.map((x) => `<li>${esc(x)}</li>`).join("") : `<li class="muted">Nothing stands out.</li>`;
    $("cons").innerHTML = pc.cons.length ? pc.cons.map((x) => `<li>${esc(x)}</li>`).join("") : `<li class="muted">Nothing stands out.</li>`;
    $("qSub").textContent = q.year ? `Fiscal year ${q.year.slice(0, 4)} compared with ${q.prevYear.slice(0, 4)}. Hover a test for details.` : "Needs at least two fiscal years.";
    const ICON = { good: "✓", warning: "!", critical: "✗" };
    const badge = (zone, txt) => `<span class="badge ${zone || "na"}">${zone ? ICON[zone] + " " : ""}${esc(txt)}</span>`;
    const scale = (v, lo, hi, cuts, order) => {   // cuts: [distress, safe]; order: "up" = higher is better
      const p = (x) => Math.max(0, Math.min(100, ((x - lo) / (hi - lo)) * 100));
      const a = p(cuts[0]), b = p(cuts[1]);
      const segs = order === "up" ? [["z-c", a], ["z-w", b - a], ["z-g", 100 - b]] : [["z-g", a], ["z-w", b - a], ["z-c", 100 - b]];
      return `<div class="scale-wrap"><div class="scale">${segs.map(([c, w]) => `<span class="${c}" style="width:${w}%"></span>`).join("")}</div><div class="marker" style="left:${p(v)}%"></div></div>
        <div class="scale-l"><span>${lo}</span><span>${hi}</span></div>`;
    };
    const cards = [];
    const p = q.piotroski;
    if (p) {
      const zt = p.zone === "good" ? "Strong" : p.zone === "warning" ? "Average" : p.zone === "critical" ? "Weak" : "Too few tests";
      cards.push(`<div class="score"><h3>Piotroski F-score</h3><div class="big">${p.score}<span class="muted" style="font-size:16px"> / ${p.of}</span></div>
        ${badge(p.zone, zt)} ${scale(p.score, 0, 9, [3.5, 6.5], "up")}
        <div class="sub">Nine pass/fail tests of profitability, balance-sheet strength and efficiency. 7–9 strong, 0–3 weak.${p.of < 9 ? ` ${9 - p.of} test(s) skipped for missing data.` : ""}</div>
        <details open><summary>The ${p.tests.length} tests</summary><table><tbody>${p.tests.map((t) => `<tr title="${esc(t.detail)}"><td>${esc(t.name)}<div class="sub">${esc(t.detail)}</div></td><td class="${t.pass == null ? "muted" : t.pass ? "ok" : "no"}">${t.pass == null ? "n/a" : t.pass ? "✓ Pass" : "✗ Fail"}</td></tr>`).join("")}</tbody></table></details></div>`);
    }
    const a = q.altman;
    if (a) cards.push(a.na ? `<div class="score"><h3>Altman Z-score</h3><div class="big muted">n/a</div>${badge(null, "Not applicable")}<p class="sub">${esc(a.na)}</p></div>` :
      `<div class="score"><h3>Altman Z-score</h3><div class="big">${a.z.toFixed(2).replace("-", "−")}</div>
        ${badge(a.zone, a.zone === "good" ? "Safe zone" : a.zone === "warning" ? "Grey zone" : "Distress zone")} ${scale(Math.max(-2, Math.min(a.z, a.safe * 2)), -2, +(a.safe * 2).toFixed(1), [a.distress, a.safe], "up")}
        <div class="sub">Bankruptcy-risk score, ${esc(a.model)}. Above ${a.safe} safe, below ${a.distress} distress.${a.note ? " " + esc(a.note) : ""}</div>
        <details><summary>Components</summary><table><tbody>${a.parts.map(([l, w, v]) => `<tr><td>${esc(l)}</td><td class="num">${v.toFixed(3)}</td><td class="num muted">× ${w}</td><td class="num">${(w * v).toFixed(2)}</td></tr>`).join("")}</tbody></table></details></div>`);
    const bm = q.beneish;
    if (bm) cards.push(`<div class="score"><h3>Beneish M-score</h3><div class="big">${bm.m.toFixed(2).replace("-", "−")}</div>
        ${badge(bm.zone, bm.zone === "good" ? "Unlikely manipulator" : bm.zone === "warning" ? "Borderline" : bm.zone === "critical" ? "Possible manipulation" : "Use with caution")} ${scale(Math.max(-4, Math.min(bm.m, 0)), -4, 0, [-2.22, -1.78], "down")}
        <div class="sub">Earnings-manipulation screen from 8 ratios. Above −1.78 is a red flag; it flags for a closer look, it doesn't prove anything.${bm.na ? " " + esc(bm.na) : ""}${bm.neutral.length ? ` Treated as neutral (data missing): ${bm.neutral.join(", ")}.` : ""}</div>
        <details><summary>The 8 ratios</summary><table><tbody>${bm.parts.map((x) => `<tr title="${esc(x.label)}"><td>${x.k}<div class="sub">${esc(x.label)}</div></td><td class="num${x.neutral ? " muted" : ""}">${x.v.toFixed(3)}</td><td class="num">${(x.w * x.v).toFixed(2)}</td></tr>`).join("")}</tbody></table></details></div>`);
    const acc = q.accruals, cb = q.cfoBeatsNi;
    const accZone = acc == null ? null : acc < 0 ? "good" : acc < 5 ? "warning" : "critical";
    cards.push(`<div class="score"><h3>Earnings quality</h3><div class="big">${acc == null ? "–" : acc.toFixed(1) + "%"}</div>
      ${badge(accZone, accZone === "good" ? "Cash exceeds profit" : accZone === "warning" ? "Some accruals" : accZone === "critical" ? "High accruals" : "n/a")}
      <div class="sub" style="margin-top:8px">Sloan accruals ratio: (net profit − operating cash flow) ÷ average assets, last FY. Negative is good: reported profit is fully backed by cash. Above ~5% means a lot of profit is on paper.</div>
      ${cb ? `<p style="margin:10px 0 0;font-size:14px">Operating cash flow beat net profit in <b>${cb.hits} of the last ${cb.of}</b> years.</p>` : ""}
      ${val.multiples.sbcPctFcf != null ? `<p style="margin:6px 0 0;font-size:14px">Stock-based pay: <b>${val.multiples.sbcPctFcf.toFixed(0)}%</b> of free cash flow.</p>` : ""}</div>`);
    $("scores").innerHTML = cards.join("");
  }

  // ---------------- DCF ----------------
  function dcfDefaults() {
    const b = rat.boxes[0].rows.find((r) => r[0] === "5 Years");
    const g = b && b[1] != null ? Math.max(0, Math.min(25, b[1])) : 10;
    const r = rf && rf.rate ? Math.round((rf.rate + 5) * 2) / 2 : 9.5;
    return { g: Math.round(g), r, gT: 2.5, sbc: true };
  }
  function dcfBase() {
    const m = val.multiples;
    const fcf0 = m.fcf == null ? null : m.fcf - (dcfIn.sbc ? m.sbc || 0 : 0);
    return { fcf0, r: dcfIn.r / 100, gT: dcfIn.gT / 100, netDebt: m.netDebt, shares: val.shares };
  }
  function dcfResult() {
    if (!val || !rat) return null;
    if (!dcfIn) dcfIn = dcfDefaults();
    const base = dcfBase();
    if (!(base.fcf0 > 0)) return null;
    const d = EdgarCore.dcf({ ...base, g: dcfIn.g / 100 });
    const rv = val.multiples.mcap ? EdgarCore.reverseDcf({ ...base, mcap: val.multiples.mcap }) : null;
    return d && { ...d, implied: rv && !rv.below && !rv.above ? rv.g : null, rv };
  }
  function drawDcf() {
    if (!val) return;
    if (!dcfIn) dcfIn = dcfDefaults();
    const price = curPrice(), base = dcfBase();
    $("dcfG").value = dcfIn.g; $("dcfR").value = dcfIn.r; $("dcfT").value = dcfIn.gT; $("dcfSbc").checked = dcfIn.sbc;
    $("rfNote").textContent = rf && rf.rate ? `Discount rate default: 10-yr Treasury ${rf.rate.toFixed(2)}% + 5% equity risk premium (beta 1) = ${(rf.rate + 5).toFixed(2)}%, rounded.` : "10-yr Treasury yield unavailable; default 9.5%.";
    $("dcfBase").textContent = base.fcf0 == null ? "–" : (base.fcf0 < 0 ? "−$" : "$") + fmtNum(Math.abs(base.fcf0) / 1000) + " Mn" + (dcfIn.sbc ? " (FCF − SBC, last FY)" : " (FCF, last FY)");
    if (!(base.fcf0 > 0)) {
      $("dcfOut").innerHTML = `<p class="err">Free cash flow is negative or missing, so a cash-flow DCF doesn't apply. For lenders and early-stage companies, value on earnings or book value instead.</p>`;
      $("dcfGrid").innerHTML = ""; return;
    }
    const d = dcfResult();
    if (!d) {
      const why = !(val.shares > 0) ? "The company's latest share count isn't in its SEC data, so a per-share value can't be worked out."
        : !(dcfIn.r > dcfIn.gT) ? "The discount rate must be higher than terminal growth. Raise the discount rate or lower terminal growth."
        : "Not enough data for a DCF.";
      $("dcfOut").innerHTML = `<p class="err">${why}</p>`; $("dcfGrid").innerHTML = ""; return;
    }
    const rv = d.rv;
    const up = price ? (d.perShare / price - 1) * 100 : null;
    const rvTxt = !rv ? "–" : rv.below ? "below −50% a year" : rv.above ? "above 150% a year" : `${(rv.g * 100).toFixed(1)}% a year`;
    $("dcfOut").innerHTML = [
      ["Growth the price implies (yrs 1–5)", rvTxt], ["DCF value per share", usd(d.perShare)],
      ["vs current price", up == null ? "–" : `<span class="${up < 0 ? "neg-t" : "pos-t"}">${up >= 0 ? "+" : "−"}${Math.abs(up).toFixed(0)}%</span>`],
      ["Terminal value share", `${(d.tvShare * 100).toFixed(0)}%`],
    ].map(([a, b]) => `<div class="kpi"><div class="k">${a}</div><div class="v">${b}</div></div>`).join("");
    const rs = [-2, -1, 0, 1, 2].map((x) => dcfIn.r + x), gs = [-10, -5, 0, 5, 10].map((x) => dcfIn.g + x);
    let h = `<table class="sens"><thead><tr><th>Growth ↓ / Discount →</th>${rs.map((r) => `<th>${r.toFixed(1)}%</th>`).join("")}</tr></thead><tbody>`;
    for (const g of gs) {
      h += `<tr><td>${g}%</td>`;
      for (const r of rs) {
        const v = EdgarCore.dcf({ ...base, g: g / 100, r: r / 100 });
        const ps = v ? v.perShare : null;
        const cls = ps == null || !price ? "na" : ps >= price ? "pos-t" : "neg-t";
        h += `<td class="num ${cls}${g === dcfIn.g && r === dcfIn.r ? " cur" : ""}">${ps == null ? "–" : "$" + ps.toFixed(0)}</td>`;
      }
      h += "</tr>";
    }
    $("dcfGrid").innerHTML = h + `</tbody></table><div class="sub" style="margin-top:6px">DCF value per share. Green = above today's price, red = below. The outlined cell is your current inputs.</div>`;
  }
  ["dcfG", "dcfR", "dcfT"].forEach((id) => ($(id).oninput = () => {
    const v = parseFloat($(id).value); if (!isFinite(v)) return;
    dcfIn[{ dcfG: "g", dcfR: "r", dcfT: "gT" }[id]] = v; drawDcf(); drawKeybox();
  }));
  $("dcfSbc").onchange = () => { dcfIn.sbc = $("dcfSbc").checked; drawDcf(); drawKeybox(); drawAnalysis(); drawModels(); };
  $("dcfReset").onclick = () => { dcfIn = dcfDefaults(); drawDcf(); drawKeybox(); drawAnalysis(); drawModels(); };


  // ---------------- other valuation models + football field ----------------
  let peerModels = [];
  function drawModels() {
    if (!val || !rat) return;
    if (!dcfIn) dcfIn = dcfDefaults();
    const M = EdgarCore.models(result, rat, val, { r: dcfIn.r / 100, gT: dcfIn.gT / 100, g: dcfIn.g / 100, sbc: dcfIn.sbc, rf: rf && rf.rate });
    const price = curPrice();
    const good = M.list.filter((x) => !x.na), bad = M.list.filter((x) => x.na);
    const up = (v) => (price && v != null ? (v / price - 1) * 100 : null);
    const upTxt = (v) => { const u = up(v); return u == null ? "" : `<span class="${u < 0 ? "neg-t" : "pos-t"}">${u >= 0 ? "+" : "−"}${Math.abs(u).toFixed(0)}% vs price</span>`; };
    $("models").innerHTML = good.filter((x) => x.key !== "dcf").map((x) => `<div class="model"><div class="g">${esc(x.group)}</div><h3>${esc(x.name)}</h3>
      <div class="v">${usd(x.value)}</div><div>${upTxt(x.value)}</div>
      ${x.low !== x.high ? `<div class="rg">Range ${usd(Math.min(x.low, x.high))} – ${usd(Math.max(x.low, x.high))}</div>` : ""}<p>${esc(x.how)}</p></div>`).join("");
    $("modelsNa").innerHTML = bad.length ? "<b>Not applicable here:</b> " + bad.map((x) => `${esc(x.name)} (${esc(x.na.replace(/\.$/, ""))})`).join(" · ") : "";
    // football field rows
    const rows = good.map((x) => ({ name: x.name, group: x.group, v: x.value, lo: Math.min(x.low, x.high), hi: Math.max(x.low, x.high), how: x.how }));
    peerModels.forEach((x) => rows.push(x));
    if (px && px.prices && px.prices.length) {
      const cut = new Date(Date.parse(px.prices.at(-1)[0]) - 365 * 86400000).toISOString().slice(0, 10);
      const yr = px.prices.filter((p) => p[0] >= cut).map((p) => p[1]);
      if (yr.length) rows.push({ name: "52-week trading range", group: "Market", v: null, lo: Math.min(...yr), hi: Math.max(...yr), ref: true, how: "Lowest and highest close over the last year." });
    }
    footballField($("ffield"), rows, price);
  }

  function footballField(el, rows, price) {
    rows = rows.filter((r) => isFinite(r.lo) && isFinite(r.hi));
    if (!rows.length) { el.innerHTML = `<p class="muted">Not enough data for any valuation model.</p>`; return; }
    const W = Math.max(300, el.clientWidth || 900), narrow = W < 640;
    // narrow screens: label + value on one line, bar underneath (full width)
    const lw = narrow ? 8 : 230, rw = narrow ? 12 : 120, rh = narrow ? 50 : 34, top = 26, H = top + rows.length * rh + 26;
    const cap = price ? price * 4 : Infinity;
    let hi = Math.max(price || 0, ...rows.map((r) => Math.min(r.hi, cap)));
    hi = hi * 1.08 || 1;
    const X = (v) => lw + (Math.max(0, Math.min(v, hi)) / hi) * (W - lw - rw);
    const ticks = []; const step = niceStep(hi / (narrow ? 3 : 5)); for (let t = 0; t <= hi; t += step) ticks.push(t);
    let svg = ticks.map((t) => `<line class="grid" x1="${X(t)}" x2="${X(t)}" y1="${top - 6}" y2="${H - 22}"/><text class="ax" x="${X(t)}" y="${H - 6}" text-anchor="middle">$${t >= 1000 ? Math.round(t).toLocaleString() : t % 1 ? t.toFixed(1) : t}</text>`).join("");
    rows.forEach((r, i) => {
      const y = top + i * rh, cy = narrow ? y + 34 : y + rh / 2, ly = narrow ? y + 13 : cy;
      const x1 = X(r.lo), x2 = X(r.hi), over = r.hi > hi;
      const valTxt = r.v != null ? usd(r.v, r.v >= 100 ? 0 : 2) : `${usd(r.lo, 0)}–${usd(r.hi, 0)}`;
      svg += `<g class="row" data-i="${i}"><rect class="hov" x="0" y="${y}" width="${W}" height="${rh}" fill="transparent"/>
        <text class="lbl" x="${narrow ? lw : 0}" y="${ly}" dominant-baseline="middle">${esc(r.name)}</text>
        ${x2 - x1 > 1.5 ? `<rect class="bar${r.ref ? " ref" : ""}" x="${x1}" y="${cy - 7}" width="${Math.max(2, x2 - x1)}" height="14" rx="3"/>` : ""}
        ${r.v != null ? `<circle class="pt${r.ref ? " ref" : ""}" cx="${X(r.v)}" cy="${cy}" r="5.5"/>` : ""}
        ${over ? `<text x="${X(hi) + 4}" y="${cy}" dominant-baseline="middle" class="grp">›</text>` : ""}
        <text class="val" x="${narrow ? W - rw : W - rw + 10}" y="${ly}" dominant-baseline="middle" ${narrow ? 'text-anchor="end"' : ""}>${valTxt}</text></g>`;
    });
    if (price) svg += `<line class="px" x1="${X(price)}" x2="${X(price)}" y1="${top - 10}" y2="${H - 22}"/><text class="pxl" x="${Math.min(Math.max(X(price), 50), W - 50)}" y="${top - 14}" text-anchor="middle">Price ${usd(price)}</text>`;
    el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Valuation range by method versus current price">${svg}</svg>`;
    el.querySelectorAll("g.row").forEach((g) => {
      const r = rows[+g.dataset.i];
      g.addEventListener("mousemove", (e) => {
        const u = (v) => (price && v != null ? ` (${v >= price ? "+" : "−"}${Math.abs((v / price - 1) * 100).toFixed(0)}%)` : "");
        tip.textContent = `${r.name}\n${r.v != null ? "Value " + usd(r.v) + u(r.v) + "\n" : ""}Range ${usd(r.lo)} – ${usd(r.hi)}\n\n${r.how || ""}`;
        tip.style.display = "block"; tip.style.left = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8) + "px"; tip.style.top = e.clientY + 16 + "px";
      });
      g.addEventListener("mouseleave", () => (tip.style.display = "none"));
    });
  }
  function niceStep(raw) { const m = Math.pow(10, Math.floor(Math.log10(raw || 1))), f = raw / m; return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * m; }

  // ---------------- peers (from the nightly screener data) ----------------
  async function drawPeers() {
    const forTicker = ticker;
    $("peerSub").textContent = "Loading peers…"; $("peerTable").innerHTML = ""; $("peerImplied").innerHTML = "";
    const data = await ensureScreener();
    if (forTicker !== ticker) return;
    peerModels = [];
    if (!data) { $("peerSub").textContent = "Peer data comes from the nightly screener build, which isn't available yet."; drawModels(); return; }
    const ix = data.ix, self = data.rows.find((r) => r[1] === ticker);
    if (!self) { $("peerSub").textContent = `${ticker} isn't in the screener data yet, so peers can't be matched.`; drawModels(); return; }
    let basis = "industry", key = self[ix.industry], peers;
    const custom = (getDoc("peers", {}) || {})[ticker];
    if (custom && custom.length) {
      basis = "custom";
      peers = custom.map((t) => data.rows.find((r) => r[1] === t)).filter(Boolean);
      const missing = custom.filter((t) => !data.rows.some((r) => r[1] === t));
      if (missing.length) basis = `custom (not in screener data: ${missing.join(", ")})`;
    } else {
      let pool = key ? data.rows.filter((r) => r !== self && r[ix.industry] === key && r[ix.mcap] > 0) : [];
      if (pool.length < 4 && self[ix.sector]) {
        const sec = data.rows.filter((r) => r !== self && r[ix.sector] === self[ix.sector] && r[ix.mcap] > 0);
        if (sec.length > pool.length) { basis = "sector"; key = self[ix.sector]; pool = sec; }
      }
      const lm = Math.log(self[ix.mcap] || 1);
      peers = pool.sort((a, b) => Math.abs(Math.log(a[ix.mcap]) - lm) - Math.abs(Math.log(b[ix.mcap]) - lm)).slice(0, 10).sort((a, b) => b[ix.mcap] - a[ix.mcap]);
    }
    drawPeerEditor(custom);
    if (!peers.length) { $("peerSub").textContent = "No comparable companies found. Choose your own peers below."; $("peerTable").innerHTML = ""; drawModels(); return; }
    const cols = [["price", "CMP", "$"], ["mcap", "Mar Cap", "$ Mn"], ["pe", "P/E", "x"], ["ev_ebitda", "EV/EBITDA", "x"], ["pb", "P/B", "x"], ["roce", "ROCE", "%"], ["opm", "OPM", "%"], ["sales_g5", "Sales gr 5Y", "%"], ["de", "Debt/Eq", "x"]];
    const q = (arr, p) => { const v = arr.filter((x) => x != null && isFinite(x)).sort((a, b) => a - b); if (!v.length) return null; const i = (v.length - 1) * p, lo = Math.floor(i); return v[lo] + (v[Math.ceil(i)] - v[lo]) * (i - lo); };
    const med = Object.fromEntries(cols.map(([k]) => [k, q(peers.map((r) => r[ix[k]]), 0.5)]));
    const cell = (v, u) => (v == null ? `<span class="muted">–</span>` : u === "$ Mn" ? fmtNum(v, 0) : u === "%" ? v.toFixed(1) : u === "$" ? v.toFixed(2) : v.toFixed(1));
    const line = (r, cls) => `<tr class="${cls || ""}"><td>${cls === "self" ? esc(title(r[0])) : `<a href="?t=${encodeURIComponent(r[1])}" data-t="${esc(r[1])}">${esc(title(r[0]))}</a>`}<span class="tk">${esc(r[1])}</span></td>${cols.map(([k, , u]) => `<td class="num${r[ix[k]] < 0 ? " neg" : ""}">${cell(r[ix[k]], u)}</td>`).join("")}</tr>`;
    $("peerTable").innerHTML = `<thead><tr><th>Name</th>${cols.map(([, l, u]) => `<th>${l}<br><span class="muted" style="font-weight:400">${u}</span></th>`).join("")}</tr></thead><tbody>` +
      line(self, "self") + peers.map((r) => line(r)).join("") +
      `<tr class="med"><td>Median of ${peers.length} peers</td>${cols.map(([k, , u]) => `<td class="num">${k === "price" ? "" : cell(med[k], u)}</td>`).join("")}</tr></tbody>`;
    $("peerTable").querySelectorAll("a[data-t]").forEach((a) => (a.onclick = (e) => { if (e.ctrlKey || e.metaKey) return; e.preventDefault(); history.pushState(null, "", `?t=${a.dataset.t}`); $("ticker").value = a.dataset.t; go(a.dataset.t); }));
    $("peerSub").textContent = basis.startsWith("custom") ? `Your chosen peers (${peers.length})${basis.length > 6 ? " — " + basis.slice(7) : ""}. Synced across your devices.`
      : `${peers.length} ${basis === "industry" ? "companies in the same industry" : "companies in the same sector"} (${key}), closest in market cap. From the nightly screener build.`;
    // peer-implied prices: 25th–75th percentile of peer multiples × this company's figure
    const k = rat.kpis, m = val.multiples, sh = val.shares, bvps = val.equity != null && sh ? val.equity / sh : null;
    const imp = [];
    const add = (name, metric, f, how) => {
      const vals = peers.map((r) => r[ix[metric]]).filter((x) => x != null && x > 0);
      if (vals.length < 3) return;
      const a = f(q(vals, 0.25)), b = f(q(vals, 0.5)), c = f(q(vals, 0.75));
      if ([a, b, c].every((x) => x != null && x > 0)) imp.push({ name, group: "Peers", v: b, lo: Math.min(a, c), hi: Math.max(a, c), how });
    };
    if (k.eps > 0) add("Peer P/E", "pe", (mult) => mult * k.eps, `Peer median P/E × this company's EPS ($${k.eps.toFixed(2)}). Range: peers' 25th–75th percentile.`);
    if (m.ebitda > 0 && sh) add("Peer EV/EBITDA", "ev_ebitda", (mult) => (mult * m.ebitda - m.netDebt) / sh, "Peer median EV/EBITDA × this company's EBITDA, minus net debt, per share. Range: peers' 25th–75th percentile.");
    if (bvps > 0) add("Peer P/B", "pb", (mult) => mult * bvps, `Peer median P/B × book value/share ($${bvps.toFixed(2)}). Range: peers' 25th–75th percentile.`);
    peerModels = imp;
    const price = curPrice();
    $("peerImplied").innerHTML = imp.map((x) => `<div class="kpi"><div class="k">Implied by ${esc(x.name)}</div><div class="v">${usd(x.v)} ${price ? `<span class="${x.v < price ? "neg-t" : "pos-t"}" style="font-size:13px">${x.v >= price ? "+" : "−"}${Math.abs((x.v / price - 1) * 100).toFixed(0)}%</span>` : ""}</div></div>`).join("");
    drawModels();
  }

  function drawPeerEditor(custom) {
    const el = $("peerEdit"); if (!el) return;
    el.innerHTML = `<form class="row" id="peerForm" style="margin-top:10px"><label class="sub" for="peerIn">${custom && custom.length ? "Your peers" : "Choose your own peers"} (tickers, comma-separated)</label>
      <input id="peerIn" style="flex:1;min-width:220px;max-width:420px;text-transform:uppercase" value="${esc((custom || []).join(", "))}" placeholder="e.g. DIS, WBD, PARA, ROKU">
      <button class="primary">Save</button>${custom && custom.length ? `<button type="button" id="peerAuto">Use automatic</button>` : ""}</form>`;
    $("peerForm").onsubmit = (e) => {
      e.preventDefault();
      const list = [...new Set($("peerIn").value.toUpperCase().split(/[\s,;]+/).map((x) => x.replace(".", "-")).filter((x) => x && x !== ticker))].slice(0, 20);
      const all = getDoc("peers", {}) || {}; if (list.length) all[ticker] = list; else delete all[ticker];
      setDoc("peers", all); drawPeers();
    };
    if ($("peerAuto")) $("peerAuto").onclick = () => { const all = getDoc("peers", {}) || {}; delete all[ticker]; setDoc("peers", all); drawPeers(); };
  }

  // ---------------- financial tables ----------------
  const ORDER = ["QUARTERS", "PROFIT & LOSS", "BALANCE SHEET", "CASH FLOW"];
  const NICE = { "QUARTERS": "Quarterly Results", "PROFIT & LOSS": "Profit & Loss", "BALANCE SHEET": "Balance Sheet", "CASH FLOW": "Cash Flows" };
  const SUBT = { "QUARTERS": "Discrete quarters (Q4 derived from the annual report)", "PROFIT & LOSS": "Fiscal years", "BALANCE SHEET": "As at fiscal year end", "CASH FLOW": "Fiscal years" };

  function computedRows(b) {
    const g = (key) => (b.rows.find((r) => r.key === key) || { values: [] }).values;
    const n = b.ends.length, z = (a, i) => a[i] || 0;
    if (b.title === "PROFIT & LOSS" || b.title === "QUARTERS") {
      const S = g("sales");
      const op = [...Array(n)].map((_, i) => (S[i] == null ? null : S[i] - z(g("cogs"), i) - z(g("sga"), i) - z(g("rnd"), i)));
      const pbt = op.map((v, i) => (v == null ? null : v - z(g("interest"), i) + z(g("other_income"), i) - z(g("other_nonop"), i)));
      const np = pbt.map((v, i) => (v == null ? null : v - z(g("tax"), i)));
      const sh = g("shares_diluted");
      return { after: {
        rnd: [{ label: "Operating Profit (EBIT)", values: op, strong: true },
              { label: "OPM %", values: op.map((v, i) => (v == null || !S[i] ? null : (v / S[i]) * 100)), f: "pct" }],
        other_nonop: [{ label: "Profit before tax", values: pbt, strong: true }],
        tax: [{ label: "Tax %", values: pbt.map((v, i) => (v > 0 ? (z(g("tax"), i) / v) * 100 : null)), f: "pct" },
              { label: "Net Profit", values: np, strong: true },
              { label: "EPS in $", values: np.map((v, i) => (v != null && sh[i] ? v / sh[i] : null)), f: "eps" }],
      } };
    }
    if (b.title === "CASH FLOW") {
      const c = g("cfo"), k = g("capex");
      return { tail: [{ label: "Free Cash Flow", values: c.map((v, i) => (v == null ? null : v - z(k, i))), strong: true },
        { label: "Net Cash Flow", values: c.map((v, i) => (v == null ? null : v + z(g("cfi"), i) + z(g("cff"), i))) }] };
    }
    return {};
  }
  const cellFmt = (v, f, isShares) => {
    if (v == null || !isFinite(v)) return "–";
    if (f === "pct") return Math.round(v) + "%";
    if (f === "eps") return v.toFixed(2);
    return fmtNum(isShares ? v / 1000 : (v * 1000) / unit, unit === 1000 && !isShares ? 0 : (Math.abs((v * 1000) / unit) < 100 ? 1 : 0));
  };

  function drawTables() {
    const blocks = [...result.blocks].sort((a, b) => ORDER.indexOf(a.title) - ORDER.indexOf(b.title));
    let h = "";
    for (const b of blocks) {
      const n = b.ends.length, extra = computedRows(b);
      const head = b.ends.map((e) => `<th>${mon(e)}</th>`).join("");
      const line = (r, ri, raw) => {
        const isShares = /share/i.test(r.label);
        let s = `<tr class="${r.strong ? "strong" : ""}"><td>${esc(r.label)}${isShares ? ' <span class="muted">(Mn)</span>' : ""}</td>`;
        for (let i = 0; i < n; i++) {
          const v = r.values[i], src = raw && r.src[i], cls = ["num"];
          if (v == null) cls.push("na"); else if (v < 0) cls.push("neg");
          if (src && src.derived && src.derived !== "calculated") cls.push("derived");
          if (src && src.derived === "calculated") cls.push("plug");
          s += `<td class="${cls.join(" ")}"${raw ? ` data-b="${esc(b.title)}" data-r="${ri}" data-i="${i}"` : ""}>${cellFmt(v, r.f, isShares)}</td>`;
        }
        return s + "</tr>";
      };
      let rows = "";
      b.rows.forEach((r, ri) => {
        rows += line(r, ri, true);
        ((extra.after || {})[r.key] || []).forEach((x) => (rows += line(x, -1, false)));
      });
      (extra.tail || []).forEach((x) => (rows += line(x, -1, false)));
      h += `<section class="card" id="sec-${b.title.split(" ")[0]}">
        <div class="head-row"><div><h2>${esc(NICE[b.title])}</h2><div class="sub">${SUBT[b.title]} · Figures in ${unit === 1000 ? "$ thousands" : "$ millions"} · hover a number for its source</div></div></div>
        <div class="tbl-wrap"><table><thead><tr><th></th>${head}</tr></thead><tbody>${rows}</tbody></table></div>
        <div class="legend"><span><b>underlined</b> = derived (Q4 = FY − Q1–Q3, split-adjusted)</span><span><i>italic</i> = reconciling plug</span><span>bold rows are calculated</span></div>
        ${b.title === "PROFIT & LOSS" && rat ? growthBoxes() : ""}
      </section>`;
    }
    $("tables").innerHTML = h + drawRatios();
  }
  const growthBoxes = () => `<div class="boxes">` + rat.boxes.map((b) => `<div class="box"><h3>${esc(b.title)}:</h3>` +
    b.rows.map(([k, v]) => `<div><span class="muted">${esc(k)}:</span><span>${v == null ? "–" : v.toFixed(0) + "%"}</span></div>`).join("") + "</div>").join("") + `</div>`;

  function drawRatios() {
    if (!rat) return "";
    const fmtR = (v, f) => {
      if (v == null || !isFinite(v)) return "–";
      if (f === "pct") return v.toFixed(1) + "%";
      if (f === "x" || f === "usd") return v.toFixed(2);
      if (f === "days") return Math.round(v).toString();
      return fmtNum((v * 1000) / unit);
    };
    const head = rat.cols.map((c) => `<th>${c === "TTM" ? "TTM" : mon(c)}</th>`).join("");
    const rows = rat.rows.map((r) => `<tr><td>${esc(r.label.replace("($k)", unit === 1000 ? "($ '000)" : "($ Mn)"))}</td>` +
      r.v.map((v) => `<td class="num ${v == null ? "na" : v < 0 ? "neg" : ""}">${fmtR(v, r.f)}</td>`).join("") + "</tr>").join("");
    return `<section class="card" id="ratios"><h2>Ratios</h2>
      <div class="sub">EBIT = Sales − COGS − SG&amp;A − R&amp;D. ROE and ROCE use average equity / capital employed. TTM = last 4 quarters.</div>
      <div class="tbl-wrap"><table><thead><tr><th></th>${head}</tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }


  // ---------------- concalls ----------------
  let ccData = null;
  async function drawConcalls() {
    const forTicker = ticker;
    $("ccTable").innerHTML = `<tr><td class="muted">Loading earnings filings…</td></tr>`;
    let j;
    try { j = (await api(`/api/concalls/${encodeURIComponent(ticker)}`)).j; }
    catch (e) { if (forTicker === ticker) $("ccTable").innerHTML = `<tr><td class="err">Couldn't load earnings filings: ${esc(e.message)}</td></tr>`; return; }
    if (forTicker !== ticker) return;
    ccData = j;
    const fps = EdgarCore.fiscalPeriods(facts, mapping);
    const ends = [...fps.keys()].sort();
    const qFor = (date) => {        // the latest fiscal period that ended before the release, within ~4 months
      let best = null;
      for (const e of ends) if (e < date && (Date.parse(date) - Date.parse(e)) / 86400000 <= 125) best = e;
      return best ? { end: best, ...fps.get(best) } : null;
    };
    if (!j.calls.length) { $("ccTable").innerHTML = `<tr><td class="muted">No earnings releases (8-K Item 2.02) found in recent filings.</td></tr>`; return; }
    const KIND = { press: "Press release", letter: "Shareholder letter", remarks: "Prepared remarks", transcript: "Transcript", slides: "Slides", supplement: "Supplement", other: "Other", filing: "8-K filing" };
    const ORDER = ["press", "letter", "remarks", "slides", "supplement", "transcript", "other", "filing"];
    const ir = j.investorWebsite ? (/^https?:/.test(j.investorWebsite) ? j.investorWebsite : "https://" + j.investorWebsite) : null;
    const name = title(result.name).replace(/,?\s+(Inc|Corp|Co|Ltd|Plc)\.?$/i, "");
    $("ccTable").innerHTML = `<thead><tr><th>Quarter</th><th>Released</th><th>Documents filed with the SEC</th><th>Call transcript</th></tr></thead><tbody>` +
      j.calls.map((c, i) => {
        const q = qFor(c.date);
        const label = q ? `Q${q.fq} FY${q.fy}` : "Results";
        const sub = q ? `<div class="sub">quarter ended ${mon(q.end)}</div>` : "";
        const docs = [...c.docs].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
        const seen = {};
        const links = docs.map((d) => { seen[d.kind] = (seen[d.kind] || 0) + 1; const n = seen[d.kind] > 1 ? ` ${seen[d.kind]}` : "";
          return `<a class="doc" href="${esc(d.url)}" target="_blank" rel="noopener" title="${esc(d.desc || d.type)}">${KIND[d.kind]}${n}<span class="tag">${esc(d.type)}</span></a>`; }).join("");
        const filedTranscript = docs.find((d) => d.kind === "transcript");
        const search = `https://www.google.com/search?q=${encodeURIComponent(`${name} ${q ? `Q${q.fq} ${q.fy}` : c.date.slice(0, 4)} earnings call transcript`)}`;
        const tr = (q ? `<button class="rd" data-i="${i}" data-q="${q.fy}Q${q.fq}" data-l="${esc(label)}">Read</button> ` : "") +
          (filedTranscript ? `<a class="doc" href="${esc(filedTranscript.url)}" target="_blank" rel="noopener">Filed copy</a>` : "") +
          `<a class="doc" href="${search}" target="_blank" rel="noopener" title="Search the web for this call's transcript">Search ↗</a>` +
          (ir && i === 0 ? `<a class="doc" href="${esc(ir)}" target="_blank" rel="noopener" title="Webcast replays are usually here">IR site ↗</a>` : "") +
          `<div class="sub cc-msg" id="ccMsg${i}"></div>`;
        return `<tr><td><b>${label}</b>${sub}</td><td>${day(c.date)}<div class="sub"><a href="${esc(c.index)}" target="_blank" rel="noopener">filing index</a></div></td><td>${links}</td><td>${tr}</td></tr>`;
      }).join("") + "</tbody>";
    $("ccTable").querySelectorAll("button.rd").forEach((b) => (b.onclick = () => openTranscript(b.dataset.q, b.dataset.l, +b.dataset.i, b)));
  }

  async function openTranscript(quarter, label, i, btn) {
    const msg = $(`ccMsg${i}`), T = encodeURIComponent(ticker);
    btn.disabled = true; msg.textContent = "Fetching transcript…";
    const said = (d) => (d ? `<br><span class="muted">Alpha Vantage said: “${esc(String(d).slice(0, 300))}”</span>` : "");
    try {
      // 1. your saved library (no request used)
      const sr = await fetch(`/api/transcript/${T}/${quarter}?stored=1`, { headers: headers() });
      const sj = await sr.json().catch(() => ({}));
      if (sr.ok && sj.transcript && sj.transcript.length) { msg.textContent = "✓ From your library"; showReader(sj, label); return; }
      // 2. fetch from this browser with your key (Cloudflare's shared IPs get rate-limited by Alpha Vantage)
      const key = store.get("edgar.avkey", "");
      if (key) {
        let j = null;
        try {
          const r = await fetch(`https://www.alphavantage.co/query?function=EARNINGS_CALL_TRANSCRIPT&symbol=${encodeURIComponent(ticker.replace("-", "."))}&quarter=${quarter}&apikey=${encodeURIComponent(key)}`);
          j = await r.json();
        } catch (e) { j = null; }                                     // network/CORS problem: fall back to the Worker
        if (j) {
          const note = j.Information || j.Note || j["Error Message"];
          if (note) { msg.innerHTML = (/per day|rate limit/i.test(note) ? "This key's daily limit (about 25) is used up; it resets tomorrow. Saved transcripts still open." : "Alpha Vantage couldn't return this transcript.") + said(note); return; }
          if (!Array.isArray(j.transcript) || !j.transcript.length) { msg.textContent = "No transcript available from Alpha Vantage for this quarter. Try the search link."; return; }
          const data = { symbol: ticker, quarter: j.quarter || quarter, source: "Alpha Vantage", transcript: j.transcript };
          showReader(data, label);
          msg.textContent = "Saving to your library…";
          try {
            const pr = await fetch(`/api/transcript/${T}/${quarter}`, { method: "POST", headers: { ...headers(), "content-type": "application/json" }, body: JSON.stringify(data) });
            const pj = await pr.json().catch(() => ({}));
            msg.textContent = pj.stored ? "✓ Saved in your library" : pj.storeError ? "Shown, but couldn't be saved (storage full?)" : "Shown (no library storage set up)";
          } catch { msg.textContent = "Shown, but couldn't be saved"; }
          return;
        }
      }
      // 3. ask the Worker to fetch it (works when Cloudflare's IP isn't rate-limited)
      const r = await fetch(`/api/transcript/${T}/${quarter}`, { headers: headers() });
      const j = await r.json().catch(() => ({}));
      if (j.error === "nokey") { msg.innerHTML = "<a href='#data' data-settings>Add your Alpha Vantage key in Settings</a> to read transcripts here. Use the search link for now."; return; }
      if (j.error === "limit") { msg.innerHTML = (key ? "Alpha Vantage's request limit has been reached." : "Alpha Vantage is limiting requests from the shared server. <a href='#data' data-settings>Add your own key in Settings</a> so your browser fetches it directly.") + said(j.detail); return; }
      if (j.error === "premium") { msg.innerHTML = "Alpha Vantage says this needs a premium plan." + said(j.detail); return; }
      if (j.error === "badkey") { msg.innerHTML = "Alpha Vantage didn't accept the API key." + said(j.detail); return; }
      if (!r.ok) { msg.innerHTML = "Couldn't fetch the transcript." + (said(j.detail) || ` (${esc(String(j.error || r.status))})`); return; }
      if (j.empty || !j.transcript || !j.transcript.length) { msg.textContent = "No transcript available from the provider for this quarter. Try the search link."; return; }
      msg.textContent = j.stored ? "✓ Saved in your library" : j.storeError ? "Shown, but couldn't be saved (storage full?)" : "";
      showReader(j, label);
    } catch (e) { msg.textContent = "Couldn't fetch: " + e.message; }
    finally { btn.disabled = false; }
  }
  function showReader(j, label) {
    $("rdTitle").textContent = `${title(result.name)} · ${label} earnings call`;
    $("rdSub").textContent = `${j.transcript.length} speaker turns · source: ${j.source}${j.quarter ? ` (${j.quarter})` : ""}`;
    $("rdBody").innerHTML = j.transcript.map((t) => `<div class="sp"><div class="who">${esc(t.speaker)}${t.title ? `<small>${esc(t.title)}</small>` : ""}</div><p>${esc(t.content)}</p></div>`).join("");
    $("rdBody").dataset.raw = $("rdBody").innerHTML;
    $("rdFind").value = ""; $("rdCount").textContent = "";
    $("reader").hidden = false; document.body.style.overflow = "hidden"; $("rdBody").scrollTop = 0; $("rdFind").focus();
  }
  function closeReader() { $("reader").hidden = true; document.body.style.overflow = ""; }
  $("rdClose").onclick = closeReader;
  $("reader").onclick = (e) => { if (e.target === $("reader")) closeReader(); };
  addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("reader").hidden) closeReader(); });
  let findIdx = 0;
  $("rdFind").addEventListener("input", () => { findIdx = 0; highlight(); });
  $("rdFind").addEventListener("keydown", (e) => { if (e.key === "Enter") { findIdx++; highlight(); } });
  function highlight() {
    const body = $("rdBody"), q = $("rdFind").value.trim();
    body.innerHTML = body.dataset.raw;
    if (q.length < 2) { $("rdCount").textContent = ""; return; }
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    body.querySelectorAll("p, .who").forEach((el) => { el.innerHTML = el.innerHTML.replace(/(^|>)([^<]+)/g, (m, a, txt) => a + txt.replace(rx, (x) => `<mark>${x}</mark>`)); });
    const marks = body.querySelectorAll("mark");
    $("rdCount").textContent = marks.length ? `${(findIdx % marks.length) + 1} of ${marks.length}` : "0 found";
    if (marks.length) { const m = marks[findIdx % marks.length]; m.classList.add("cur"); m.scrollIntoView({ block: "center" }); }
  }

  // ---------------- documents ----------------
  const ITEMS = { "1.01": "Material agreement", "1.02": "Agreement ended", "2.01": "Acquisition / disposal", "2.02": "Earnings results",
    "2.03": "New debt", "2.05": "Restructuring costs", "2.06": "Impairment", "3.02": "Share issue", "4.01": "Auditor change", "4.02": "Restatement warning",
    "5.01": "Change of control", "5.02": "Director / officer change", "5.03": "Bylaws change", "5.07": "Shareholder vote", "7.01": "Reg FD disclosure", "8.01": "Other events" };
  const itemText = (s) => (s || "").split(",").map((x) => ITEMS[x.trim()]).filter(Boolean).join(", ");
  function drawDocs() {
    if (!co || !co.filings) { $("docs").innerHTML = `<p class="muted">Filings list unavailable.</p>`; return; }
    const groups = [
      ["Annual reports", (f) => /^(10-K|20-F|40-F|10-KT)/.test(f.form)],
      ["Quarterly reports", (f) => /^10-Q/.test(f.form)],
      ["Announcements (8-K)", (f) => f.form === "8-K" || f.form === "6-K"],
      ["Proxy & other", (f) => /^(DEF 14A|S-1)/.test(f.form)],
    ];
    $("docs").innerHTML = groups.map(([t, fn]) => {
      const list = co.filings.filter(fn).slice(0, 30);
      return `<div><h3>${t}</h3><ul>${list.length ? list.map((f) => `<li><a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.form)}${f.period ? " · period " + esc(f.period) : ""}</a>
        <span class="sub">Filed ${day(f.date)}${itemText(f.items) ? " · " + esc(itemText(f.items)) : ""}</span></li>`).join("") : `<li class="muted">None recently</li>`}</ul></div>`;
    }).join("");
  }

  // ---------------- tooltip with the source of each number ----------------
  const tip = $("tip");
  document.addEventListener("mouseover", (e) => {
    const td = e.target.closest && e.target.closest("td[data-b]");
    if (!td || !result) { if (!e.target.closest || !e.target.closest(".chart")) tip.style.display = "none"; return; }
    const b = result.blocks.find((x) => x.title === td.dataset.b);
    const s = b.rows[+td.dataset.r].src[+td.dataset.i];
    tip.textContent = !s ? "No value found for this period." :
      [s.tag, s.form && `${s.form} filed ${s.filed}`, s.accn && `accession ${s.accn}`, s.derived && `derived: ${s.derived}`].filter(Boolean).join("\n");
    tip.style.display = "block";
  });
  document.addEventListener("mousemove", (e) => {
    if (tip.style.display !== "block" || (e.target.closest && e.target.closest(".chart"))) return;
    tip.style.left = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8) + "px"; tip.style.top = e.clientY + 16 + "px";
  });

  // ---------------- unit toggle + active section ----------------
  function setUnitButtons() { $("unitSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", +x.dataset.u === unit)); }
  setUnitButtons();
  $("unitSeg").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    unit = +b.dataset.u; store.set("edgar.unit", unit); setUnitButtons();
    if (result) drawTables();
  };
  const navLinks = [...document.querySelectorAll(".subin a")];
  addEventListener("scroll", () => {
    let cur = navLinks[0];
    const atBottom = innerHeight + scrollY >= document.documentElement.scrollHeight - 4;
    for (const a of navLinks) { const t = document.querySelector(a.getAttribute("href")); if (t && !t.closest("[hidden]") && t.getBoundingClientRect().top < (atBottom ? innerHeight * 0.6 : 140)) cur = a; }
    navLinks.forEach((a) => a.classList.toggle("on", a === cur));
  }, { passive: true });

  // ---------------- tag explorer ----------------
  let tagTimer;
  $("tagSearch").oninput = () => { clearTimeout(tagTimer); tagTimer = setTimeout(drawTags, 150); };
  function drawTags() {
    const tbl = $("tagTable");
    if (!facts) { tbl.innerHTML = `<tr><td class="muted">Search for a company first.</td></tr>`; return; }
    const rows = EdgarCore.listTags(facts, $("tagSearch").value.trim()).slice(0, 300);
    tbl.innerHTML = `<thead><tr><th>Tag</th><th>Latest FY end</th><th>Value</th><th>Since</th><th style="text-align:left">Label</th></tr></thead><tbody>` +
      rows.map((r) => `<tr><td style="font-family:var(--mono);font-size:12.5px">${esc(r.tag)} <span class="muted">[${esc(r.unit)}${r.instant ? ", instant" : ""}]</span></td>
        <td>${r.end}</td><td class="num ${r.val < 0 ? "neg" : ""}">${fmtNum(r.val)}</td><td>${r.since}</td><td style="text-align:left" class="muted">${esc(r.label)}</td></tr>`).join("") +
      (rows.length ? "" : `<tr><td class="muted">No tags match.</td></tr>`) + "</tbody>";
  }

  // ---------------- downloads ----------------
  function download(buf, name) {
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  $("exportBtn").onclick = async () => {
    if (!result) return;
    download(await EdgarCore.dataWorkbook(ExcelJS, result, rat).xlsx.writeBuffer(), `${ticker}_EDGAR_data.xlsx`);
  };
  $("modelFile").onchange = async (e) => {
    const file = e.target.files[0]; e.target.value = "";
    if (!file || !result) return;
    status(`Filling ${file.name}…`);
    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(await file.arrayBuffer());
      const log = [];
      EdgarCore.fillWorkbook(wb, result, (m) => log.push(m));
      const base = file.name.replace(/\.xlsx$/i, "").replace(/_[A-Z.\-]{1,10}$/, "");
      download(await wb.xlsx.writeBuffer(), `${base}_${ticker}.xlsx`);
      status(`Done: ${base}_${ticker}.xlsx downloaded. Excel recalculates the model when you open it.` + (log.length ? "  " + log.join(" · ") : ""));
    } catch (err) { status("Couldn't fill the model: " + err.message, true); }
  };

  // ---------------- small SVG line chart with crosshair tooltip ----------------
  function lineChart(el, data, o) {
    const pts = data.filter((d, i) => i % 3 === 0 || i === data.length - 1);
    const W = Math.max(280, el.clientWidth || 520), H = 230, pl = 46, pr = 12, pt = 12, pb = 26;
    const vals = pts.map((p) => p[1]).filter((v) => v != null);
    if (pts.length < 2 || !vals.length) { el.innerHTML = `<div class="sub" style="padding:50px 0;text-align:center">No data</div>`; return; }
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (o.ref != null) { lo = Math.min(lo, o.ref); hi = Math.max(hi, o.ref); }
    const pad = (hi - lo) * 0.08 || 1; lo = Math.max(0, lo - pad); hi += pad;
    const t0 = Date.parse(pts[0][0]), t1 = Date.parse(pts.at(-1)[0]);
    const X = (d) => pl + ((Date.parse(d) - t0) / (t1 - t0 || 1)) * (W - pl - pr);
    const Y = (v) => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
    let path = "", pen = false;
    for (const [d, v] of pts) { if (v == null) { pen = false; continue; } path += (pen ? "L" : "M") + X(d).toFixed(1) + " " + Y(v).toFixed(1); pen = true; }
    const ticks = [0, 1, 2, 3].map((i) => lo + ((hi - lo) * i) / 3);
    const y0 = new Date(t0).getUTCFullYear(), y1 = new Date(t1).getUTCFullYear(), step = Math.ceil((y1 - y0 + 1) / 6);
    let xt = "";
    for (let y = y0 + 1; y <= y1; y += step) { const x = X(`${y}-01-01`); xt += `<text x="${x}" y="${H - 8}" text-anchor="middle">${y}</text><line x1="${x}" x2="${x}" y1="${H - pb}" y2="${H - pb + 4}" class="ax"/>`; }
    const last = pts.filter((p) => p[1] != null).at(-1);
    el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="${esc(o.label)}">
      ${ticks.map((v) => `<line x1="${pl}" x2="${W - pr}" y1="${Y(v)}" y2="${Y(v)}" class="grid"/><text x="${pl - 6}" y="${Y(v) + 4}" text-anchor="end">${o.fmt(v).replace(/\.\d+/, "")}</text>`).join("")}
      ${xt}
      ${o.ref != null ? `<line x1="${pl}" x2="${W - pr}" y1="${Y(o.ref)}" y2="${Y(o.ref)}" class="ref"/><text x="${pl + 6}" y="${Y(o.ref) - 6}" class="reft">${esc(o.refLabel)} ${o.fmt(o.ref)}</text>` : ""}
      <path d="${path}" class="ln"/>
      <circle cx="${X(last[0])}" cy="${Y(last[1])}" r="4" class="dot"/>
      <line class="xh" y1="${pt}" y2="${H - pb}" x1="0" x2="0" visibility="hidden"/><circle class="xhd" r="4" cx="0" cy="0" visibility="hidden"/>
      <rect x="${pl}" y="0" width="${W - pl - pr}" height="${H}" fill="transparent" class="hit"/>
    </svg>`;
    const svg = el.querySelector("svg"), xh = svg.querySelector(".xh"), xd = svg.querySelector(".xhd"), hit = svg.querySelector(".hit");
    hit.addEventListener("mousemove", (e) => {
      const mx = e.clientX - svg.getBoundingClientRect().left;
      let best = null, bd = 1e9;
      for (const p of pts) { if (p[1] == null) continue; const dd = Math.abs(X(p[0]) - mx); if (dd < bd) { bd = dd; best = p; } }
      if (!best) return;
      xh.setAttribute("visibility", "visible"); xd.setAttribute("visibility", "visible");
      xh.setAttribute("x1", X(best[0])); xh.setAttribute("x2", X(best[0]));
      xd.setAttribute("cx", X(best[0])); xd.setAttribute("cy", Y(best[1]));
      tip.textContent = `${day(best[0])}\n${o.label}: ${o.fmt(best[1])}`; tip.style.display = "block";
      tip.style.left = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8) + "px"; tip.style.top = e.clientY + 16 + "px";
    });
    hit.addEventListener("mouseleave", () => { xh.setAttribute("visibility", "hidden"); xd.setAttribute("visibility", "hidden"); tip.style.display = "none"; });
  }
  let rsz; addEventListener("resize", () => { clearTimeout(rsz); rsz = setTimeout(() => { if (val) { stockChart(); drawModels(); } }, 150); });


  // ---------------- views ----------------
  let view = "company";
  function showView(v) {
    view = v;
    const scr = v === "screens", wl = v === "watchlist", co = v === "company";
    $("screens").hidden = !scr; $("watch").hidden = !wl;
    $("data").hidden = !co;
    $("empty").hidden = !co || !!result;
    $("result").hidden = !co || !result;
    $("subnav").hidden = !co || !result;
    $("lnkScreens").classList.toggle("on", scr); $("lnkWatch").classList.toggle("on", wl);
    if (scr) { loadScreener(); document.title = "Screens · EDGAR Fetch"; }
    if (wl) { drawWatchlist(); document.title = "Watchlist · EDGAR Fetch"; }
  }
  $("lnkWatch").onclick = (e) => { e.preventDefault(); history.pushState(null, "", "?view=watchlist"); showView("watchlist"); };
  $("lnkScreens").onclick = (e) => { e.preventDefault(); history.pushState(null, "", "?view=screens"); showView("screens"); };
  addEventListener("popstate", () => {
    const ps = new URLSearchParams(location.search);
    const v = ps.get("view"); showView(v === "screens" || v === "watchlist" ? v : "company");
  });

  // ---------------- screens ----------------
  let scr = null, scrErr = "", res = null, resPage = 0, resSort = { key: "mcap", dir: -1 };
  const FIELD = Object.fromEntries(ScreenCore.FIELDS.map(([key, label, unit, group, , desc]) => [key, { key, label, unit, group, desc }]));
  let scrP = null;
  function ensureScreener() {
    if (!scrP) scrP = fetch("data/screener.json", { cache: "no-cache" }).then(async (r) => {
      if (!r.ok) throw new Error(r.status === 404 ? "not built yet" : `HTTP ${r.status}`);
      scr = await r.json();
      scr.ix = Object.fromEntries([...scr.text, ...scr.fields.map((f) => f.key)].map((k, i) => [k, i]));
      return scr;
    }).catch((e) => { scrErr = e.message; return null; });
    return scrP;
  }
  async function loadScreener() {
    await ensureScreener();
    drawScrMeta();
    const q = new URLSearchParams(location.search).get("q");
    if (q && scr && !res) { $("q").value = q; runQuery(); }
  }
  function drawScrMeta() {
    $("scrMeta").innerHTML = scr
      ? `Data as of ${new Date(scr.built).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })} · ${scr.count.toLocaleString()} US-listed companies · rebuilt nightly`
      : `<span class="err">Screener data ${esc(scrErr || "loading")}. It's built by the nightly GitHub Action; run the workflow once from the Actions tab.</span>`;
  }
  function drawLists() {
    $("presets").innerHTML = ScreenCore.PRESETS.map(([n, q], i) => `<li><a data-p="${i}">${esc(n)}</a></li>`).join("");
    $("presets").querySelectorAll("a").forEach((a) => (a.onclick = () => { $("q").value = ScreenCore.PRESETS[+a.dataset.p][1]; $("saveName").value = ScreenCore.PRESETS[+a.dataset.p][0]; runQuery(); }));
    const saved = getDoc("screens", []);
    $("saved").innerHTML = saved.length ? saved.map((x, i) => `<li><a data-s="${i}">${esc(x.name)}</a><button class="x" data-d="${i}" title="Delete">✕</button></li>`).join("")
      : `<li class="muted">None yet. Write a query, give it a name and press Save.</li>`;
    $("saved").querySelectorAll("a").forEach((a) => (a.onclick = () => { const x = saved[+a.dataset.s]; $("q").value = x.query; $("saveName").value = x.name; runQuery(); }));
    $("saved").querySelectorAll(".x").forEach((b) => (b.onclick = () => { saved.splice(+b.dataset.d, 1); setDoc("screens", saved); drawLists(); }));
    const groups = {};
    ScreenCore.FIELDS.forEach(([key, label, unit, group, , desc]) => (groups[group] = groups[group] || []).push([label, unit, desc]));
    $("fieldList").innerHTML = Object.entries(groups).map(([g, fs]) => `<h4>${esc(g)}</h4>` +
      fs.map(([l, u, d]) => `<a data-l="${esc(l)}" title="${esc(d || "")}">${esc(l)} ${u ? `<small>${esc(u)}</small>` : ""}</a>`).join("")).join("");
    $("fieldList").querySelectorAll("a").forEach((a) => (a.onclick = () => insertField(a.dataset.l, true)));
  }
  $("saveQ").onclick = () => {
    const name = $("saveName").value.trim() || $("q").value.trim().slice(0, 40), query = $("q").value.trim();
    if (!query) return;
    try { ScreenCore.compile(query); } catch (e) { $("qErr").textContent = e.message; return; }
    const saved = getDoc("screens", []).filter((x) => x.name !== name);
    saved.unshift({ name, query }); setDoc("screens", saved); drawLists();
    $("qErr").innerHTML = `<span class="pos-t">Saved as "${esc(name)}".</span>`;
  };
  $("alertQ").onclick = async () => {
    const query = $("q").value.trim(); if (!query) return;
    try { ScreenCore.compile(query); } catch (e) { $("qErr").textContent = e.message; return; }
    const line = JSON.stringify({ name: $("saveName").value.trim() || "My screen", query, alert: true });
    try { await navigator.clipboard.writeText(line); $("qErr").innerHTML = `<span class="pos-t">Copied. Paste it into <b>screens.json</b> in your GitHub repo (inside the [ ], comma-separated). Alerts start from the next nightly run.</span>`; }
    catch { $("qErr").innerHTML = `Copy this into screens.json: <code>${esc(line)}</code>`; }
  };
  $("runQ").onclick = () => runQuery();
  $("q").addEventListener("keydown", (e) => {
    if (qdd.items.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) { qdd.sel = (qdd.sel + (e.key === "ArrowDown" ? 1 : -1) + qdd.items.length) % qdd.items.length; drawQdd(); e.preventDefault(); return; }
    if (qdd.items.length && (e.key === "Enter" || e.key === "Tab") && qdd.sel >= 0) { insertField(qdd.items[qdd.sel][1]); e.preventDefault(); return; }
    if (e.key === "Escape") { qdd.items = []; drawQdd(); return; }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { runQuery(); e.preventDefault(); }
  });

  // autocomplete for field names
  const qdd = { items: [], sel: -1, start: 0 };
  function currentPhrase() {
    const ta = $("q"), upto = ta.value.slice(0, ta.selectionStart);
    const m = upto.match(/(?:^|[()<>=!+*\n]|\s(?:AND|OR|NOT)\s|\s[-\/]\s|\d\s)\s*([A-Za-z][A-Za-z0-9 %\/&-]*)$/i);
    if (!m) return null;
    return { text: m[1], start: ta.selectionStart - m[1].length };
  }
  $("q").addEventListener("input", () => {
    $("qErr").textContent = "";
    const ph = currentPhrase();
    if (!ph || ph.text.trim().length < 2 || /^(and|or|not)$/i.test(ph.text.trim())) { qdd.items = []; return drawQdd(); }
    const n = ph.text.trim().toLowerCase();
    const scored = [];
    for (const [key, label, unit, , aliases] of ScreenCore.FIELDS) {
      const names = [label, ...aliases].map((x) => x.toLowerCase());
      const sc = names.some((x) => x.startsWith(n)) ? 2 : names.some((x) => x.includes(n)) ? 1 : 0;
      if (sc) scored.push([sc, label, unit]);
    }
    qdd.items = scored.sort((a, b) => b[0] - a[0]).slice(0, 8); qdd.sel = qdd.items.length ? 0 : -1; qdd.start = ph.start;
    drawQdd();
  });
  $("q").addEventListener("blur", () => setTimeout(() => { qdd.items = []; drawQdd(); }, 150));
  function drawQdd() {
    const dd = $("qdd");
    if (!qdd.items.length) { dd.classList.remove("on"); return; }
    dd.innerHTML = qdd.items.map(([, l, u], i) => `<div class="${i === qdd.sel ? "sel" : ""}" data-l="${esc(l)}"><span style="color:var(--ink)">${esc(l)}</span><span>${esc(u || "")}</span></div>`).join("");
    dd.classList.add("on");
    dd.querySelectorAll("div").forEach((d) => (d.onmousedown = (e) => { e.preventDefault(); insertField(d.dataset.l); }));
  }
  function insertField(label, append) {
    const ta = $("q");
    if (append) {
      const v = ta.value.trim();
      ta.value = (v ? v + (/(AND|OR|\()$/i.test(v) ? " " : " AND\n") : "") + label + " ";
    } else {
      const end = ta.selectionStart;
      ta.value = ta.value.slice(0, qdd.start) + label + " " + ta.value.slice(end);
      const pos = qdd.start + label.length + 1; ta.setSelectionRange(pos, pos);
    }
    qdd.items = []; drawQdd(); ta.focus();
  }

  function runQuery() {
    if (!scr) { $("qErr").textContent = "Screener data isn't available yet."; return; }
    let c;
    try { c = ScreenCore.compile($("q").value); } catch (e) { $("qErr").textContent = e.message; $("scrResults").hidden = true; return; }
    $("qErr").textContent = "";
    const ix = scr.ix;
    const rows = scr.rows.filter((r) => c.test((k) => r[ix[k]]));
    const base = ["price", "mcap", "pe", "roce"], extra = c.fields.filter((k) => !base.includes(k));
    res = { rows, cols: [...base, ...extra].slice(0, 10), query: $("q").value.trim() };
    resPage = 0;
    if (!res.cols.includes(resSort.key)) resSort = { key: "mcap", dir: -1 };
    sortRes(); drawRes();
    history.replaceState(null, "", `?view=screens&q=${encodeURIComponent(res.query)}`);
  }
  function sortRes() {
    const i = scr.ix[resSort.key], d = resSort.dir;
    res.rows.sort((a, b) => { const x = a[i], y = b[i]; if (x == null) return 1; if (y == null) return -1; return typeof x === "string" ? d * x.localeCompare(y) : d * (x - y); });
  }
  const fmtCell = (v, unit) => {
    if (v == null) return `<span class="muted">–</span>`;
    if (unit === "$ Mn") return fmtNum(v, 0);
    if (unit === "%") return v.toFixed(1);
    if (unit === "$") return v.toFixed(2);
    if (unit === "days" || unit === "/9") return Math.round(v);
    if (unit === "Mn") return fmtNum(v, 1);
    return Math.abs(v) >= 100 ? fmtNum(v, 0) : v.toFixed(2);
  };
  function drawRes() {
    $("scrResults").hidden = false;
    const per = 50, pages = Math.max(1, Math.ceil(res.rows.length / per));
    $("resTitle").textContent = `${res.rows.length.toLocaleString()} result${res.rows.length === 1 ? "" : "s"}`;
    $("resSub").textContent = `Sorted by ${FIELD[resSort.key] ? FIELD[resSort.key].label : resSort.key}, ${resSort.dir < 0 ? "high to low" : "low to high"}. Click a column to sort; click a company to open it.`;
    const head = `<th data-k="name">Name</th>` + res.cols.map((k) => `<th data-k="${k}" class="${resSort.key === k ? "sorted" : ""}" title="${esc(FIELD[k].desc || "")}">${esc(FIELD[k].label)}${FIELD[k].unit ? `<br><span class="muted" style="font-weight:400">${esc(FIELD[k].unit)}</span>` : ""}${resSort.key === k ? (resSort.dir < 0 ? " ▼" : " ▲") : ""}</th>`).join("");
    const ix = scr.ix;
    const body = res.rows.slice(resPage * per, resPage * per + per).map((r, j) =>
      `<tr><td>${resPage * per + j + 1}. <a href="?t=${encodeURIComponent(r[1])}" data-t="${esc(r[1])}">${esc(title(r[0]))}</a><span class="tk">${esc(r[1])}</span></td>` +
      res.cols.map((k) => `<td class="num${r[ix[k]] < 0 ? " neg" : ""}">${fmtCell(r[ix[k]], FIELD[k].unit)}</td>`).join("") + "</tr>").join("");
    $("resTable").innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body || `<tr><td class="muted">No companies match.</td></tr>`}</tbody>`;
    $("resTable").querySelectorAll("th").forEach((th) => (th.onclick = () => {
      const k = th.dataset.k; resSort = { key: k, dir: resSort.key === k ? -resSort.dir : k === "name" ? 1 : -1 }; sortRes(); drawRes();
    }));
    $("resTable").querySelectorAll("a[data-t]").forEach((a) => (a.onclick = (e) => {
      if (e.ctrlKey || e.metaKey) return;
      e.preventDefault(); history.pushState(null, "", `?t=${encodeURIComponent(a.dataset.t)}`); $("ticker").value = a.dataset.t; go(a.dataset.t);
    }));
    $("pager").innerHTML = pages > 1 ? `<button id="pgPrev"${resPage ? "" : " disabled"}>← Prev</button><span class="sub">Page ${resPage + 1} of ${pages}</span><button id="pgNext"${resPage < pages - 1 ? "" : " disabled"}>Next →</button>` : "";
    if (pages > 1) { $("pgPrev").onclick = () => { resPage--; drawRes(); }; $("pgNext").onclick = () => { resPage++; drawRes(); }; }
  }
  $("csvQ").onclick = () => {
    if (!res) return;
    const ix = scr.ix, cols = ["name", "ticker", "exchange", "sector", "industry", ...scr.fields.map((f) => f.key)];
    const q = (v) => (v == null ? "" : typeof v === "string" ? `"${v.replace(/"/g, '""')}"` : v);
    const lines = [cols.map((k) => q(FIELD[k] ? `${FIELD[k].label}${FIELD[k].unit ? " (" + FIELD[k].unit + ")" : ""}` : k)).join(",")]
      .concat(res.rows.map((r) => cols.map((k) => q(r[ix[k]])).join(",")));
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "screen_results.csv"; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  };
  drawLists();


  // ---------------- synced personal data (watchlist, saved screens, custom peers) ----------------
  // Kept in this browser and mirrored to the Worker's KV, so every device sees the same lists.
  const DOCS = { watchlist: [], screens: [], peers: {} };
  let syncState = "local";
  function getDoc(name, def) {
    const d = store.get(`edgar.doc.${name}`, null);
    if (d) return d.data;
    if (name === "screens") { const old = store.get("edgar.screens", null); if (old) return old; }   // migrate older saves
    return def;
  }
  const pushTimers = {};
  function setDoc(name, data) {
    const doc = { data, updated: Date.now() };
    store.set(`edgar.doc.${name}`, doc);
    clearTimeout(pushTimers[name]);
    pushTimers[name] = setTimeout(() => pushDoc(name, doc), 600);
  }
  async function pushDoc(name, doc) {
    try {
      const r = await fetch(`/api/user/${name}`, { method: "PUT", headers: { ...headers(), "content-type": "application/json" }, body: JSON.stringify(doc) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 409 && j.data != null) { store.set(`edgar.doc.${name}`, { data: j.data, updated: j.updated }); refreshSynced(); }
      syncState = r.ok || r.status === 409 ? (j.protected ? "synced" : "synced-open") : r.status === 501 ? "nostorage" : r.status === 401 ? "denied" : "error";
    } catch { syncState = "offline"; }
    drawSyncNote();
  }
  async function syncAll() {
    for (const name of Object.keys(DOCS)) {
      try {
        const r = await fetch(`/api/user/${name}`, { headers: headers() });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { syncState = r.status === 501 ? "nostorage" : r.status === 401 ? "denied" : "error"; continue; }
        const local = store.get(`edgar.doc.${name}`, null);
        if (j.updated > (local ? local.updated : 0)) store.set(`edgar.doc.${name}`, { data: j.data, updated: j.updated });
        else if (local && local.updated > j.updated) await pushDoc(name, local);
        else if (!local && name === "screens" && store.get("edgar.screens", null)) setDoc("screens", store.get("edgar.screens", []));
        syncState = j.protected ? "synced" : "synced-open";
      } catch { syncState = "offline"; }
    }
    refreshSynced();
  }
  function refreshSynced() { drawLists(); drawStar(); if (view === "watchlist") drawWatchlist(); if (result && val) drawPeers(); drawSyncNote(); }
  function drawSyncNote() {
    const el = $("syncNote"); if (!el) return;
    el.innerHTML = {
      synced: "✓ Synced across your devices.",
      "synced-open": "✓ Synced across devices. <b>Tip:</b> set an ACCESS_KEY on the Worker (and enter it under Data tools → Settings) so only you can see or change your lists.",
      nostorage: "Saved in this browser only: the Worker has no KV storage connected.",
      denied: "Saved in this browser only: enter your access key under Data tools → Settings to sync.",
      offline: "Saved in this browser; will sync when the server is reachable.",
      error: "Saved in this browser; syncing failed.", local: "",
    }[syncState] || "";
  }

  // ---------------- watchlist ----------------
  function inWatch(t) { return getDoc("watchlist", []).includes(t); }
  function toggleWatch(t) {
    const w = getDoc("watchlist", []);
    setDoc("watchlist", w.includes(t) ? w.filter((x) => x !== t) : [...w, t]);
    drawStar(); if (view === "watchlist") drawWatchlist();
  }
  function drawStar() {
    const b = $("starBtn"); if (!b || !ticker) return;
    const on = inWatch(ticker);
    b.textContent = on ? "★ In watchlist" : "☆ Watchlist"; b.classList.toggle("starred", on);
  }
  $("starBtn").onclick = () => ticker && toggleWatch(ticker);
  $("wlAddForm").onsubmit = (e) => { e.preventDefault(); const t = $("wlAdd").value.trim().toUpperCase().replace(".", "-"); if (t && !inWatch(t)) toggleWatch(t); $("wlAdd").value = ""; };
  let wlSort = { key: null, dir: -1 };
  async function drawWatchlist() {
    const list = getDoc("watchlist", []);
    drawSyncNote();
    if (!list.length) { $("wlSub").textContent = "Empty. Add tickers above, or press ☆ Watchlist on any company page."; $("wlTable").innerHTML = ""; return; }
    const d = await ensureScreener();
    const cols = [["price", "CMP", "$"], ["mcap", "Mar Cap", "$ Mn"], ["pe", "P/E", "x"], ["roce", "ROCE", "%"], ["sales_g5", "Sales gr 5Y", "%"], ["opm", "OPM", "%"], ["de", "Debt/Eq", "x"], ["piotroski", "Piotroski", "/9"], ["dcf_upside", "DCF upside", "%"]];
    const rows = list.map((t) => ({ t, r: d ? d.rows.find((x) => x[1] === t) : null }));
    if (wlSort.key) { const i = d.ix[wlSort.key]; rows.sort((a, b) => { const x = a.r ? a.r[i] : null, y = b.r ? b.r[i] : null; if (x == null) return 1; if (y == null) return -1; return wlSort.dir * (x - y); }); }
    const cell = (v, u) => (v == null ? `<span class="muted">–</span>` : u === "$ Mn" ? fmtNum(v, 0) : u === "%" ? v.toFixed(1) : u === "/9" ? Math.round(v) : u === "$" ? v.toFixed(2) : v.toFixed(1));
    $("wlSub").textContent = `${list.length} compan${list.length === 1 ? "y" : "ies"}${d ? ` · data as of ${new Date(d.built).toLocaleDateString("en-US", { dateStyle: "medium" })}` : ""}. Click a column to sort.`;
    $("wlTable").innerHTML = `<thead><tr><th>Name</th>${cols.map(([k, l, u]) => `<th data-k="${k}" class="${wlSort.key === k ? "sorted" : ""}">${l}<br><span class="muted" style="font-weight:400">${u}</span></th>`).join("")}<th></th></tr></thead><tbody>` +
      rows.map(({ t, r }) => `<tr><td><a href="?t=${encodeURIComponent(t)}" data-t="${esc(t)}">${esc(r ? title(r[0]) : t)}</a><span class="tk">${esc(t)}</span></td>` +
        cols.map(([k, , u]) => `<td class="num${r && r[d.ix[k]] < 0 ? " neg" : ""}">${r ? cell(r[d.ix[k]], u) : (k === "price" ? '<span class="muted">not in screener data</span>' : "")}</td>`).join("") +
        `<td><button class="x" data-rm="${esc(t)}" title="Remove">✕</button></td></tr>`).join("") + "</tbody>";
    $("wlTable").querySelectorAll("th[data-k]").forEach((th) => (th.onclick = () => { const k = th.dataset.k; wlSort = { key: k, dir: wlSort.key === k ? -wlSort.dir : -1 }; drawWatchlist(); }));
    $("wlTable").querySelectorAll("a[data-t]").forEach((a) => (a.onclick = (e) => { if (e.ctrlKey || e.metaKey) return; e.preventDefault(); history.pushState(null, "", `?t=${a.dataset.t}`); $("ticker").value = a.dataset.t; go(a.dataset.t); }));
    $("wlTable").querySelectorAll("button[data-rm]").forEach((b) => (b.onclick = () => toggleWatch(b.dataset.rm)));
  }

  // ---------------- boot ----------------
  drawRecent(); drawTags(); syncAll();
  loadMapping().then(() => {
    const ps = new URLSearchParams(location.search), q = ps.get("t");
    if (ps.get("view") === "screens" || ps.get("view") === "watchlist") showView(ps.get("view"));
    else if (q) { $("ticker").value = q.toUpperCase(); go(q); }
  }).catch((e) => status("Couldn't load mapping.json: " + e.message, true));
})();

/* soic.js — SOIC-style ranking score, answered automatically from filings and prices.
   Shared by the nightly builder (Node) and the company page (browser, for the question list).
   Each question has the options and points of the SOIC ranking sheet; the builder picks the option
   from the data and records the figure it was based on. */
(function (root) {
  "use strict";

  // [id, section, short label, question, options [[text, points]], how the answer is picked]
  const QUESTIONS = [
    ["ind_growth", "Industry", "Industry growth", "Is it a growing industry or a stagnant one?",
      [["Growing industry", 10], ["Cyclical in an upturn", 5], ["Stagnant industry", 0]],
      "Combined revenue of US-listed companies with the same SEC industry code. Growing = 3-year growth of 6%+ a year; cyclical in an upturn = not that, but up 3%+ last year in an industry with down years."],
    ["ind_comp", "Industry", "Competitiveness", "Does one company control the industry, or is it crowded (top 7 under 50%)?",
      [["Monopoly", 10], ["Duopoly that cooperate", 10], ["Duopoly that compete", 5], ["Oligopoly", 5], ["Too many players with high ROCE", 5], ["Too many players with low ROCE", 0]],
      "Revenue shares among US-listed peers. Monopoly = leader has 60%+; duopoly = top two 70%+ (cooperate if both earn 15%+ operating margins); oligopoly = top 7 hold 50%+; otherwise crowded, split by the peers' median ROCE (15%)."],
    ["ind_type", "Industry", "Industry type", "Structural or cyclical industry?",
      [["Structural (10 years consistency)", 10], ["Shallow cyclical (2 to 3 years growth)", 5], ["Cyclical", 0]],
      "Industry revenue over up to 10 years: structural = no down year (7+ years of data); shallow cyclical = at most 2 down years; cyclical = more."],
    ["ind_wind", "Industry", "Headwinds / tailwinds", "Near-term tailwinds or headwinds?",
      [["Tailwind", 10], ["Headwind", 0]],
      "Tailwind when the industry's stocks have beaten the median US stock over the last 6 months (if prices are missing: industry growth speeding up)."],

    ["margins", "Fundamental", "Margins", "Are the margins much higher than normal?",
      [["Yes due to product mix change or operating leverage", 10], ["Yes, these are peak margins", -5], ["No", 5]],
      "Latest operating margin vs the median of the 5 years before: much higher = 3+ points and 20%+ above. Peak margins if the industry is cyclical, or the jump came in one year without sales growth."],
    ["margin_stab", "Fundamental", "Margin stability", "Are the margins stable or volatile?",
      [["Stable", 10], ["Volatile", 0]],
      "Operating margin over the last 5–7 years: stable = never negative and the standard deviation is under 3 points (or under a fifth of the average margin)."],
    ["growth_vs_ind", "Fundamental", "Growth vs industry", "Is the company growing faster than its industry?",
      [["Yes", 10], ["No", 0]],
      "Company's 3-year sales growth vs the industry's."],
    ["rev_type", "Fundamental", "Type of revenue", "Are revenues annuity (repeat) in nature or one-time?",
      [["Fully annuity", 10], ["Higher annuity, lower one-time", 5], ["Higher one-time, lower annuity", 3], ["Fully one-time", 0]],
      "Deferred revenue (customers paying ahead: subscriptions, contracts) as a share of a year's revenue: 25%+, 10%+, 3%+, below 3%. Moved up one step if revenue rose in 8 of the last 9 years (repeat demand)."],
    ["cap_alloc", "Fundamental", "Capital allocation", "How is the capital allocation? (No diworsification)",
      [["Good", 10], ["Weak (low or falling returns on capital)", 0]],
      "Good = average return on invested capital of 12%+ over the last 5 years, and not down more than 5 points over that time."],

    ["adx", "Technical", "ADX (weekly)", "ADX 14 on the weekly chart?",
      [["Above 40", 20], ["20 to 40", 10], ["0 to 20", -5]], "Wilder's ADX 14 on weekly bars."],
    ["rsi", "Technical", "RSI (weekly)", "Where is RSI on the weekly chart? (Above 75 can lead to a near-term correction)",
      [["Between 50 to 75", 10], ["Above 75", 0], ["45 to 50", 0], ["Below 45", 0]], "Wilder's RSI 14 on weekly closes."],
    ["stage", "Technical", "Stage analysis", "What stage is the stock in?",
      [["Stage 2 (mark-up)", 20], ["Stage 3 (distribution)", 5], ["Stage 1 (accumulation)", 0], ["Stage 4 (mark-down)", -5]],
      "Weinstein stages on the 30-week average: stage 2 = rising average with price above it; stage 4 = falling average with price below; otherwise a base (stage 1 after a decline, stage 3 after an advance)."],
    ["pv", "Technical", "Price-volume action", "What is price-volume action indicating?",
      [["Positive trend", 20], ["Neutral", 0], ["Negative trend", -10]],
      "Last 26 weeks: volume on up weeks vs down weeks. Positive = 1.2x or more and price higher; negative = 0.83x or less and price lower."],
    ["trend2", "Technical", "Secondary trend", "What is the secondary (intermediate) trend?",
      [["Uptrend", 10], ["Sideways", 5], ["Downtrend", 0]], "Price vs the 10-week average and that average's direction over 4 weeks."],
    ["trend1", "Technical", "Primary trend", "What is the primary (long-term) trend?",
      [["Uptrend", 10], ["Sideways", 5], ["Downtrend", 0]], "Price vs the 40-week average and that average's direction over 8 weeks."],
    ["resist", "Technical", "Resistance", "Is there a zone of resistance overhead?",
      [["Blue sky (at all-time highs)", 10], ["Close to 52-week high or retracement", 5], ["Overhead supply in last 2 years", -5], ["Long-term downtrend", -10]],
      "Blue sky = within 2% of the highest price in our history (up to 10 years); close = within 15% of the 52-week high; long-term downtrend = below a 40-week average lower than a year ago; otherwise overhead supply."],
    ["vstop", "Technical", "V-stop (weekly)", "Is the volatility stop positive on the weekly chart?",
      [["Yes", 10], ["No", 0]], "Volatility stop on weekly closes (20-week ATR × 2): yes when price is above the stop."],

    ["pat_growth", "Valuation", "Profit growth", "Is profit after tax growing at more than 20% a year?",
      [["More than 20%", 10], ["Between 12 to 20%", 5], ["Less than 12%", 0]], "3-year compound growth in net profit (below 12% if it started from a loss)."],
    ["history", "Valuation", "Stock history", "Has the stock ever fallen 60%+ from its peak?",
      [["No", 10], ["Yes", 0]], "Largest fall from a weekly closing high in our price history (up to 10 years)."],
    ["pe50", "Valuation", "P/E above 50", "Is the P/E ratio above 50?",
      [["No", 5], ["Yes (or loss-making)", 0]], "Market cap ÷ last 12 months' net profit."],
    ["peg", "Valuation", "PEG ratio", "Is the PEG ratio less than 1.5 (P/E ÷ last 3 years of profit growth)?",
      [["Less than 1.5", 10], ["Between 1.5 to 2", 5], ["Above 2 (or no growth)", 0]], "P/E ÷ 3-year net profit growth (in %)."],

    ["cfo_ebitda", "Forensic", "CFO to EBITDA", "How is the CFO to EBITDA conversion?",
      [["Above 70%", 10], ["Between 50% to 70%", 5], ["Less than 50%", 0], ["Less than 50% and borrowings increasing", -5], ["Negative", -10]],
      "Operating cash flow ÷ EBITDA, summed over the last 3 years; borrowings compare total debt with 3 years earlier."],
    ["de", "Forensic", "Debt to equity", "What is the debt to equity ratio?",
      [["Less than 0.7", 10], ["Between 0.7 to 1.2", 0], ["More than 1.2 (or negative equity)", -10]], "Total debt ÷ shareholders' equity, latest."],
    ["auditor", "Forensic", "Auditor change", "Any resignation or change of auditor in the last 3 years?",
      [["No", 0], ["Yes", -10]], "An 8-K with Item 4.01 (change in the company's certifying accountant) in the last 3 years. Covers resignations and dismissals."],
    ["contingent", "Forensic", "Contingent liabilities", "Contingent liabilities to net worth?",
      [["Less than 15%", 10], ["More than 15%", -10]],
      "Loss contingencies and guarantees the company tags in its filings (estimated possible loss, accrued loss, guarantee exposure) ÷ equity. Many companies don't tag these, which counts as less than 15%: read the 10-K's commitments note."],
  ];
  const SECTIONS = ["Industry", "Fundamental", "Technical", "Valuation", "Forensic"];
  const QI = Object.fromEntries(QUESTIONS.map((q, i) => [q[0], i]));
  const MAX = Object.fromEntries(SECTIONS.map((s) => [s, QUESTIONS.filter((q) => q[1] === s).reduce((a, q) => a + Math.max(...q[4].map((o) => o[1])), 0)]));
  MAX.total = SECTIONS.reduce((a, s) => a + MAX[s], 0);
  const FIN_SECTIONS = ["Technical", "Valuation"];        // banks, insurers, REITs: only these are scored

  /* ---------- helpers ---------- */
  const med = (a) => { const s = a.filter((x) => x != null && isFinite(x)).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const pct = (x, d = 0) => (x == null || !isFinite(x) ? "–" : (x * 100).toFixed(d) + "%");
  const num = (x, d = 1) => (x == null || !isFinite(x) ? "–" : x.toFixed(d));
  const fyYear = (iso) => { const y = +iso.slice(0, 4), m = +iso.slice(5, 7); return m <= 3 ? y - 1 : y; };

  /* ---------- per company: financial inputs (from core.compute result + facts) ---------- */
  function companyInputs(result, row, facts) {
    const blk = (t, key) => { const b = result.blocks.find((x) => x.title === t); const r = b && b.rows.find((x) => x.key === key); return r ? r.values : []; };
    const ends = result.aEnds, n = ends.length, L = n - 1;
    const P = (k) => blk("PROFIT & LOSS", k), B = (k) => blk("BALANCE SHEET", k), C = (k) => blk("CASH FLOW", k);
    const z = (v) => v || 0;
    const sales = P("sales"), opinc = P("operating_income"), dep = P("depreciation");
    const ebit = ends.map((e, i) => (opinc[i] != null ? opinc[i] : sales[i] == null ? null : sales[i] - z(P("cogs")[i]) - z(P("sga")[i]) - z(P("rnd")[i]) - z(P("other_opex")[i])));
    const opm = ends.map((e, i) => (sales[i] > 0 && ebit[i] != null ? ebit[i] / sales[i] : null));
    const debt = ends.map((e, i) => (B("total_assets")[i] == null ? null : z(B("st_debt")[i]) + z(B("lt_debt")[i])));
    const ic = ends.map((e, i) => (B("equity")[i] == null ? null : B("equity")[i] + z(debt[i]) - z(B("cash")[i]) - z(B("st_investments")[i])));
    const roic = ends.map((e, i) => (ic[i] > 0 && ebit[i] != null ? (ebit[i] * 0.79) / ic[i] : null));
    const rev = {};
    ends.forEach((e, i) => { if (e && sales[i] > 0) rev[fyYear(e)] = sales[i]; });
    // 3-year sums for CFO / EBITDA
    const cfo = C("cfo"), last3 = [L, L - 1, L - 2].filter((i) => i >= 0);
    const okCF = last3.length === 3 && last3.every((i) => cfo[i] != null && ebit[i] != null);
    const cfo3 = okCF ? sum(last3.map((i) => cfo[i])) : null;
    const ebitda3 = okCF ? sum(last3.map((i) => ebit[i] + z(dep[i]))) : null;
    // deferred revenue and contingencies at the latest fiscal year end (tagged facts)
    const gaap = ((facts && facts.facts) || {})["us-gaap"] || {};
    const endL = ends[L];
    const at = (tag, near = 0) => {
      const units = gaap[tag] && gaap[tag].units;
      if (!units || !endL) return null;
      const uName = units.USD ? "USD" : Object.keys(units)[0], u = units[uName];
      const fx = uName === "USD" ? 1 : facts._fx || 1;
      let best = null;
      for (const f of u) {
        if (f.start) continue;
        const dd = Math.abs(Date.parse(f.end) - Date.parse(endL)) / 864e5;
        if (dd > near) continue;
        if (!best || f.filed > best.filed) best = f;
      }
      return best ? (best.val * fx) / (result.scale || 1000) : null;
    };
    const firstOf = (tags, near) => { for (const t of tags) { const v = at(t, near); if (v != null) return v; } return null; };
    const defCur = firstOf(["ContractWithCustomerLiabilityCurrent", "DeferredRevenueCurrent"], 3);
    const defNon = firstOf(["ContractWithCustomerLiabilityNoncurrent", "DeferredRevenueNoncurrent"], 3);
    const defTot = firstOf(["ContractWithCustomerLiability", "DeferredRevenue"], 3);
    const deferred = Math.max(z(defCur) + z(defNon), z(defTot));
    const contingent = Math.max(z(firstOf(["LossContingencyEstimateOfPossibleLoss", "LossContingencyRangeOfPossibleLossMaximum"], 120)),
      0) + z(firstOf(["LossContingencyAccrualAtCarryingValue"], 3)) + z(firstOf(["GuaranteeObligationsMaximumExposure"], 3));
    const contingentTagged = ["LossContingencyEstimateOfPossibleLoss", "LossContingencyRangeOfPossibleLossMaximum", "LossContingencyAccrualAtCarryingValue", "GuaranteeObligationsMaximumExposure"].some((t) => gaap[t]);
    const growthYears = [];
    for (let i = Math.max(1, n - 9); i < n; i++) if (sales[i] > 0 && sales[i - 1] > 0) growthYears.push(sales[i] > sales[i - 1]);
    return {
      n, endL, rev, opm: opm.slice(-8), roic: roic.slice(-6), salesL: sales[L], salesG1: n > 1 && sales[L - 1] > 0 && sales[L] != null ? sales[L] / sales[L - 1] - 1 : null,
      salesG3: row.sales_g3 != null ? row.sales_g3 / 100 : null, npG3: row.np_g3 != null ? row.np_g3 / 100 : null,
      pe: row.pe, de: row.de, equity: B("equity")[L], roce: row.roce, opmL: opm[L],
      cfo3, ebitda3, debtUp: debt[L] != null && L >= 3 && debt[L - 3] != null ? debt[L] > debt[L - 3] : null,
      deferredRatio: sales[L] > 0 ? deferred / sales[L] : null, contingent, contingentTagged,
      upYears: growthYears.filter(Boolean).length, growthYearsN: growthYears.length,
    };
  }

  /* ---------- weekly technicals ---------- */
  function weeklyFromDaily(c, v, h, l, t) {
    // group daily bars into weeks (by timestamp when we have it, otherwise blocks of 5 sessions from the latest)
    const W = { h: [], l: [], c: [], v: [] };
    if (!c || !c.length) return W;
    const key = t && t.length === c.length ? (i) => Math.floor((t[i] / 86400 + 3) / 7) : (i) => Math.floor((c.length - 1 - i) / 5) * -1;
    let k = null;
    for (let i = 0; i < c.length; i++) {
      const hi = h ? h[i] : c[i], lo = l ? l[i] : c[i];
      if (c[i] == null) continue;
      const kk = key(i);
      if (kk !== k) { W.h.push(hi ?? c[i]); W.l.push(lo ?? c[i]); W.c.push(c[i]); W.v.push(v ? v[i] || 0 : 0); k = kk; }
      else {
        const j = W.c.length - 1;
        W.h[j] = Math.max(W.h[j], hi ?? c[i]); W.l[j] = Math.min(W.l[j], lo ?? c[i]); W.c[j] = c[i]; W.v[j] += v ? v[i] || 0 : 0;
      }
    }
    return W;
  }
  const smaAt = (a, len, end) => (end + 1 < len ? null : sum(a.slice(end + 1 - len, end + 1)) / len);
  function wilderRSI(c, len = 14) {
    if (c.length < len + 2) return null;
    let g = 0, l = 0;
    for (let i = 1; i <= len; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
    g /= len; l /= len;
    for (let i = len + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (len - 1) + Math.max(d, 0)) / len; l = (l * (len - 1) + Math.max(-d, 0)) / len; }
    return l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  function wilderADX(h, l, c, len = 14) {
    const n = c.length;
    if (n < 2 * len + 2) return null;
    let tr = 0, pdm = 0, mdm = 0, adx = null;
    const dx = [];
    for (let i = 1; i < n; i++) {
      const up = h[i] - h[i - 1], dn = l[i - 1] - l[i];
      const p = up > dn && up > 0 ? up : 0, m = dn > up && dn > 0 ? dn : 0;
      const t = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
      if (i <= len) { tr += t; pdm += p; mdm += m; if (i < len) continue; }
      else { tr = tr - tr / len + t; pdm = pdm - pdm / len + p; mdm = mdm - mdm / len + m; }
      const pdi = tr ? (100 * pdm) / tr : 0, mdi = tr ? (100 * mdm) / tr : 0;
      const d = pdi + mdi ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
      if (adx == null) { dx.push(d); if (dx.length === len) adx = sum(dx) / len; }
      else adx = (adx * (len - 1) + d) / len;
    }
    return adx;
  }
  function vstopUp(h, l, c, len = 20, mult = 2) {
    const n = c.length;
    if (n < len + 5) return null;
    let atr = 0;
    for (let i = 1; i <= len; i++) atr += Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    atr /= len;
    let up = c[len] >= c[0], mx = c[len], mn = c[len], stop = up ? c[len] - mult * atr : c[len] + mult * atr;
    for (let i = len + 1; i < n; i++) {
      atr = (atr * (len - 1) + Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))) / len;
      mx = Math.max(mx, c[i]); mn = Math.min(mn, c[i]);
      stop = up ? Math.max(stop, mx - mult * atr) : Math.min(stop, mn + mult * atr);
      const nu = c[i] - stop >= 0;
      if (nu !== up) { up = nu; mx = mn = c[i]; stop = up ? c[i] - mult * atr : c[i] + mult * atr; }
    }
    return { up, stop };
  }
  // weekly bars -> the technical inputs
  function techInputs(W) {
    const c = W && W.c, n = c ? c.length : 0;
    if (n < 45) return null;
    const h = W.h, l = W.l, v = W.v, last = c[n - 1];
    const slope = (len, back) => { const a = smaAt(c, len, n - 1), b = smaAt(c, len, n - 1 - back); return a != null && b ? a / b - 1 : null; };
    const trend = (len, back, thr) => {
      const m = smaAt(c, len, n - 1), s = slope(len, back);
      if (m == null || s == null) return null;
      return last > m && s > thr ? "up" : last < m && s < -thr ? "down" : "side";
    };
    const out = { weeks: n, last };
    out.adx = wilderADX(h, l, c);
    out.rsi = wilderRSI(c);
    // stage
    const m30 = smaAt(c, 30, n - 1), s30 = slope(30, 5), m30ago = smaAt(c, 30, n - 27);
    if (m30 != null && s30 != null) {
      out.stage = s30 > 0.01 && last > m30 ? 2 : s30 < -0.01 && last < m30 ? 4 : m30ago != null && m30 < m30ago ? 1 : 3;
      out.ma30 = m30; out.ma30slope = s30;
    }
    // price-volume, last 26 weeks
    if (n > 27) {
      let up = 0, dn = 0;
      for (let i = n - 26; i < n; i++) { if (c[i] > c[i - 1]) up += v[i] || 0; else if (c[i] < c[i - 1]) dn += v[i] || 0; }
      out.pvRatio = dn > 0 ? up / dn : up > 0 ? 9 : null;
      out.ret26 = last / c[n - 27] - 1;
    }
    out.trend2 = trend(10, 4, 0.01);
    out.trend1 = trend(40, 8, 0.01);
    out.ma40 = smaAt(c, 40, n - 1);
    const ma40yr = smaAt(c, 40, n - 53);
    out.ma40fall = out.ma40 != null && ma40yr != null ? out.ma40 < ma40yr : null;
    out.hiAll = Math.max(...h);
    out.hi52 = Math.max(...h.slice(-52));
    const vs = vstopUp(h, l, c);
    out.vstop = vs ? vs.up : null; out.vstopLevel = vs ? vs.stop : null;
    // largest fall from a weekly closing high
    let pk = c[0], dd = 0;
    for (const x of c) { pk = Math.max(pk, x); dd = Math.max(dd, 1 - x / pk); }
    out.maxDD = dd;
    out.years = Math.round((n / 52) * 10) / 10;
    return out;
  }

  /* ---------- industry groups (needs every company) ---------- */
  // items: [{ t, sic, sicDesc, fin, ci, tech }]
  function industries(items) {
    const keyOf = (sic, d) => (sic ? String(sic).padStart(4, "0").slice(0, d) : null);
    const eligible = items.filter((x) => x.sic && x.ci && Object.keys(x.ci.rev).length >= 2);
    const count = (d) => { const m = new Map(); for (const x of eligible) { const k = keyOf(x.sic, d); m.set(k, (m.get(k) || 0) + 1); } return m; };
    const c4 = count(4), c3 = count(3), c2 = count(2);
    const groups = new Map();
    for (const x of eligible) {
      let k = keyOf(x.sic, 4), d = 4;
      if (c4.get(k) < 6) { k = keyOf(x.sic, 3); d = 3; if (c3.get(k) < 6) { k = keyOf(x.sic, 2); d = 2; } }
      x.group = `${d}:${k}`;
      if (!groups.has(x.group)) groups.set(x.group, { key: x.group, digits: d, code: k, members: [], descs: {} });
      const g = groups.get(x.group);
      g.members.push(x);
      if (x.sicDesc) g.descs[x.sicDesc] = (g.descs[x.sicDesc] || 0) + 1;
    }
    const allRet = med(items.map((x) => x.tech && x.tech.ret26));
    for (const g of groups.values()) {
      const top = Object.entries(g.descs).sort((a, b) => b[1] - a[1])[0];
      g.label = g.digits === 4 && top ? `${top[0]} (SIC ${g.code})` : `SIC ${g.code}${"x".repeat(4 - g.digits)}${top ? ` · mostly ${top[0]}` : ""}`;
      // latest year most members have
      const lastYears = g.members.map((x) => Math.max(...Object.keys(x.ci.rev).map(Number)));
      const Y = med(lastYears) != null ? Math.floor(med(lastYears)) : null;
      g.year = Y;
      const gy = {};
      for (let y = Y - 9; y <= Y; y++) {
        let a = 0, b = 0, k = 0;
        for (const x of g.members) { const r1 = x.ci.rev[y], r0 = x.ci.rev[y - 1]; if (r1 > 0 && r0 > 0) { a += r1; b += r0; k++; } }
        if (k >= 3 && b > 0) gy[y] = a / b - 1;
      }
      g.growth = gy;
      const g3 = [Y - 2, Y - 1, Y].map((y) => gy[y]);
      g.cagr3 = g3.every((x) => x != null) ? Math.pow(g3.reduce((p, x) => p * (1 + x), 1), 1 / 3) - 1 : null;
      g.last = gy[Y] ?? null;
      const ys = Object.values(gy);
      g.nYears = ys.length;
      g.down = ys.filter((x) => x < -0.01).length;
      g.type = ys.length >= 7 && g.down === 0 ? 0 : g.down <= 2 ? 1 : 2;     // option index of ind_type
      if (ys.length < 3) g.type = null;
      // revenue shares (latest year, else the year before)
      const revs = g.members.map((x) => ({ x, r: x.ci.rev[Y] ?? x.ci.rev[Y - 1] ?? 0 })).filter((o) => o.r > 0).sort((a, b) => b.r - a.r);
      const tot = sum(revs.map((o) => o.r));
      const sh = revs.map((o) => o.r / tot);
      g.shares = revs.slice(0, 7).map((o, i) => [o.x.t, sh[i]]);
      g.top1 = sh[0] || 0; g.top2 = (sh[0] || 0) + (sh[1] || 0); g.top7 = sum(sh.slice(0, 7));
      g.medRoce = med(g.members.map((x) => x.ci.roce));
      g.duoMargins = revs.slice(0, 2).map((o) => o.x.ci.opmL);
      g.medRet = med(g.members.map((x) => x.tech && x.tech.ret26));
      g.allRet = allRet;
      g.n = g.members.length;
    }
    return groups;
  }

  /* ---------- answers ---------- */
  function answer(x, g) {
    const A = new Array(QUESTIONS.length).fill(null), V = new Array(QUESTIONS.length).fill("");
    const set = (id, opt, why) => { A[QI[id]] = opt; V[QI[id]] = why; };
    const ci = x.ci, T = x.tech;
    // industry
    if (g && !x.fin) {
      const typeTxt = ["no down year", `${g.down} down year${g.down === 1 ? "" : "s"}`, `${g.down} down years`];
      if (g.type != null) set("ind_type", g.type, `${typeTxt[g.type]} in ${g.nYears} years of industry revenue`);
      if (g.cagr3 != null) {
        const growing = g.cagr3 >= 0.06 && (g.last == null || g.last >= 0);
        const upturn = !growing && g.type !== 0 && g.last != null && g.last >= 0.03;
        set("ind_growth", growing ? 0 : upturn ? 1 : 2, `industry sales ${pct(g.cagr3, 1)} a year over 3 years, ${pct(g.last, 1)} last year`);
      }
      let comp;
      if (g.top1 >= 0.6) comp = 0;
      else if (g.top2 >= 0.7 && g.shares.length >= 2 && g.shares[1][1] >= 0.2) comp = g.duoMargins.every((m) => m != null && m >= 0.15) ? 1 : 2;
      else if (g.top7 >= 0.5) comp = 3;
      else comp = g.medRoce != null && g.medRoce >= 15 ? 4 : 5;
      set("ind_comp", comp, `top 1: ${pct(g.top1)}, top 2: ${pct(g.top2)}, top 7: ${pct(g.top7)} of ${g.n} US-listed peers' sales${comp >= 4 ? `; median ROCE ${num(g.medRoce, 0)}%` : ""}`);
      if (g.medRet != null && g.allRet != null) set("ind_wind", g.medRet > g.allRet ? 0 : 1, `industry stocks' median 6-month return ${pct(g.medRet)} vs ${pct(g.allRet)} for all stocks`);
      else if (g.last != null && g.cagr3 != null) set("ind_wind", g.last > g.cagr3 ? 0 : 1, `industry growth ${pct(g.last, 1)} last year vs ${pct(g.cagr3, 1)} a year over 3 years`);
    }
    // fundamentals
    if (ci && !x.fin) {
      const op = ci.opm.filter((m) => m != null);
      if (op.length >= 4) {
        const latest = op[op.length - 1], prior = med(op.slice(-6, -1)), prev = op[op.length - 2];
        const higher = latest - prior >= 0.03 && (prior <= 0 || latest >= prior * 1.2);
        let o = 2;
        if (higher) {
          const oneJump = latest - prev >= (2 / 3) * (latest - prior);
          o = (g && g.type === 2) || (oneJump && !(ci.salesG1 >= 0.05)) ? 1 : 0;
        }
        set("margins", o, `operating margin ${pct(latest, 1)} vs ${pct(prior, 1)} median of the 5 years before`);
        const recent = op.slice(-7);
        if (recent.length >= 5) {
          const mean = sum(recent) / recent.length, sd = Math.sqrt(sum(recent.map((m) => (m - mean) ** 2)) / recent.length);
          const stable = Math.min(...recent) > 0 && sd <= Math.max(0.03, Math.abs(mean) / 5);
          set("margin_stab", stable ? 0 : 1, `average ${pct(mean, 1)}, standard deviation ${num(sd * 100, 1)} points over ${recent.length} years`);
        }
      }
      if (g && g.cagr3 != null) set("growth_vs_ind", ci.salesG3 != null && ci.salesG3 > g.cagr3 ? 0 : 1, `company ${ci.salesG3 == null ? "–" : pct(ci.salesG3, 1)} vs industry ${pct(g.cagr3, 1)} a year over 3 years`);
      if (ci.deferredRatio != null) {
        const d = ci.deferredRatio;
        let o = d >= 0.25 ? 0 : d >= 0.1 ? 1 : d >= 0.03 ? 2 : 3;
        const steady = ci.growthYearsN >= 8 && ci.upYears >= ci.growthYearsN - 1;
        if (steady && o > 0) o--;
        set("rev_type", o, `${d > 0 ? `deferred revenue ${pct(d, d < 0.1 ? 1 : 0)} of sales` : "no deferred revenue reported"}${steady ? `; sales rose in ${ci.upYears} of ${ci.growthYearsN} years` : ""}`);
      }
      const ro = ci.roic.filter((r) => r != null).slice(-5);
      if (ro.length >= 3) {
        const avg = sum(ro) / ro.length, good = avg >= 0.12 && ro[ro.length - 1] >= ro[0] - 0.05;
        set("cap_alloc", good ? 0 : 1, `ROIC averaged ${pct(avg, 1)} over ${ro.length} years (${pct(ro[0], 0)} → ${pct(ro[ro.length - 1], 0)})`);
      }
    }
    // technicals
    if (T) {
      if (T.adx != null) set("adx", T.adx > 40 ? 0 : T.adx >= 20 ? 1 : 2, `ADX ${num(T.adx)}`);
      if (T.rsi != null) set("rsi", T.rsi > 75 ? 1 : T.rsi >= 50 ? 0 : T.rsi >= 45 ? 2 : 3, `RSI ${num(T.rsi)}`);
      if (T.stage != null) set("stage", { 2: 0, 3: 1, 1: 2, 4: 3 }[T.stage], `30-week average ${T.ma30slope >= 0 ? "up" : "down"} ${pct(Math.abs(T.ma30slope), 1)} in 5 weeks; price ${T.last > T.ma30 ? "above" : "below"} it`);
      if (T.pvRatio != null) set("pv", T.pvRatio >= 1.2 && T.ret26 > 0 ? 0 : T.pvRatio <= 0.83 && T.ret26 < 0 ? 2 : 1, `up-week volume ${num(T.pvRatio, 2)}x down-week volume; price ${T.ret26 >= 0 ? "+" : ""}${pct(T.ret26)} in 26 weeks`);
      const tr = { up: 0, side: 1, down: 2 };
      if (T.trend2) set("trend2", tr[T.trend2], `price vs 10-week average, average ${T.trend2 === "up" ? "rising" : T.trend2 === "down" ? "falling" : "flat or mixed"}`);
      if (T.trend1) set("trend1", tr[T.trend1], `price vs 40-week average, average ${T.trend1 === "up" ? "rising" : T.trend1 === "down" ? "falling" : "flat or mixed"}`);
      let rs;
      if (T.last >= 0.98 * T.hiAll) rs = 0;
      else if (T.last >= 0.85 * T.hi52) rs = 1;
      else if (T.trend1 === "down" && T.ma40fall) rs = 3;
      else rs = 2;
      set("resist", rs, `${pct(1 - T.last / T.hi52)} below the 52-week high, ${pct(1 - T.last / T.hiAll)} below the ${T.years}-year high`);
      if (T.vstop != null) set("vstop", T.vstop ? 0 : 1, `stop at ${num(T.vstopLevel, 2)}, price ${num(T.last, 2)}`);
      set("history", T.maxDD >= 0.6 ? 1 : 0, `largest fall ${pct(T.maxDD)} in ${T.years} years`);
    }
    // valuation
    if (ci) {
      const g3 = ci.npG3;
      set("pat_growth", g3 != null && g3 > 0.2 ? 0 : g3 != null && g3 >= 0.12 ? 1 : 2, g3 == null ? "3-year profit growth not measurable (loss in the start or latest year)" : `net profit ${pct(g3, 1)} a year over 3 years`);
      set("pe50", ci.pe != null && ci.pe > 0 && ci.pe <= 50 ? 0 : 1, ci.pe != null && ci.pe > 0 ? `P/E ${num(ci.pe)}` : "loss-making (no P/E)");
      const peg = ci.pe > 0 && g3 > 0 ? ci.pe / (g3 * 100) : null;
      set("peg", peg != null && peg < 1.5 ? 0 : peg != null && peg <= 2 ? 1 : 2, peg == null ? "no positive P/E and profit growth" : `PEG ${num(peg, 2)}`);
    }
    // forensic
    if (ci && !x.fin) {
      if (ci.cfo3 != null && ci.ebitda3 != null) {
        const r = ci.ebitda3 > 0 ? ci.cfo3 / ci.ebitda3 : null;
        const o = ci.ebitda3 <= 0 || ci.cfo3 < 0 ? 4 : r >= 0.7 ? 0 : r >= 0.5 ? 1 : ci.debtUp ? 3 : 2;
        set("cfo_ebitda", o, ci.ebitda3 <= 0 ? "EBITDA negative over 3 years" : `CFO ${pct(r)} of EBITDA over 3 years${o >= 2 ? (ci.debtUp ? "; debt up vs 3 years ago" : "; debt not up") : ""}`);
      }
      if (ci.equity != null) {
        const neg = !(ci.equity > 0);
        set("de", neg || ci.de > 1.2 ? 2 : ci.de >= 0.7 ? 1 : 0, neg ? "equity is zero or negative" : `debt to equity ${num(ci.de, 2)}`);
      }
      set("auditor", x.auditor ? 1 : 0, x.auditor ? `8-K Item 4.01 filed ${x.auditor}` : x.subs ? "no Item 4.01 8-K in 3 years" : "filing list unavailable");
      if (!x.subs) A[QI.auditor] = null;
      const cr = ci.equity > 0 ? ci.contingent / ci.equity : ci.contingent > 0 ? Infinity : 0;
      set("contingent", cr > 0.15 ? 1 : 0, ci.contingentTagged ? (isFinite(cr) ? `tagged contingencies ${pct(cr, 1)} of equity` : "tagged contingencies with negative equity") : "none tagged in the filings");
    }
    // scores
    const sec = {};
    for (const s of SECTIONS) {
      const qs = QUESTIONS.map((q, i) => [q, i]).filter(([q]) => q[1] === s);
      const ans = qs.filter(([, i]) => A[i] != null);
      sec[s] = ans.length ? sum(ans.map(([q, i]) => q[4][A[i]][1])) : null;
    }
    const scored = x.fin ? FIN_SECTIONS : SECTIONS;
    const complete = scored.every((s) => sec[s] != null);
    const total = x.fin || !complete ? null : sum(SECTIONS.map((s) => sec[s]));
    return { A, V, sec, total, answered: A.filter((a) => a != null).length };
  }

  // items: [{ t, sic, sicDesc, fin, ci, tech, auditor, subs }] -> Map ticker -> {A, V, sec, total, group}
  function finish(items) {
    const groups = industries(items);
    const out = new Map();
    for (const x of items) {
      const g = x.group ? groups.get(x.group) : null;
      const r = answer(x, g);
      r.group = g ? { label: g.label, n: g.n, year: g.year, cagr3: g.cagr3, shares: g.shares } : null;
      out.set(x.t, r);
    }
    // rank by total (1 = best)
    const ranked = [...out.entries()].filter(([, r]) => r.total != null).sort((a, b) => b[1].total - a[1].total);
    ranked.forEach(([, r], i) => { r.rank = i + 1; });
    return { scores: out, groups, ranked: ranked.length };
  }

  const api = { QUESTIONS, SECTIONS, MAX, FIN_SECTIONS, companyInputs, weeklyFromDaily, techInputs, industries, answer, finish, wilderRSI, wilderADX, vstopUp };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Soic = api;
})(typeof window !== "undefined" ? window : this);

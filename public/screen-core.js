/* screen-core.js — screener fields, per-company row calculation, and a safe query language.
   Shared by the nightly builder (Node) and the Screens page (browser).
   Money fields are in USD millions, per-share fields in USD, ratios as plain numbers, % as percent. */
(function (root) {
  "use strict";

  // [key, label, unit, group, aliases, description]
  const FIELDS = [
    ["price", "Current price", "$", "Valuation", ["price", "cmp"], "Last close"],
    ["mcap", "Market Capitalization", "$ Mn", "Valuation", ["market cap", "mcap", "market capitalisation"], "Price × latest shares outstanding"],
    ["ev", "Enterprise Value", "$ Mn", "Valuation", ["ev"], "Market cap + debt − cash − short-term investments"],
    ["pe", "Price to earning", "x", "Valuation", ["pe", "p/e", "stock p/e", "price to earnings", "pe ratio"], "Market cap ÷ TTM net profit (reported, attributable to shareholders)"],
    ["pe_clean", "P/E excl. unusual items", "x", "Valuation", ["clean pe", "adjusted pe", "price to earning excl unusual"], "Market cap ÷ TTM profit excluding impairments, restructuring, asset-sale gains and discontinued operations"],
    ["pb", "Price to book value", "x", "Valuation", ["pb", "p/b", "price to book"], ""],
    ["ps", "Price to sales", "x", "Valuation", ["ps", "p/s"], "Market cap ÷ TTM sales"],
    ["pfcf", "Price to free cash flow", "x", "Valuation", ["pfcf", "p/fcf", "price to fcf"], "Market cap ÷ last FY FCF"],
    ["ev_ebitda", "EV to EBITDA", "x", "Valuation", ["evebitda", "ev/ebitda", "ev ebitda"], ""],
    ["ev_sales", "EV to sales", "x", "Valuation", ["ev/sales"], ""],
    ["earnings_yield", "Earnings yield", "%", "Valuation", [], "TTM net profit ÷ market cap"],
    ["fcf_yield", "FCF yield", "%", "Valuation", ["free cash flow yield"], "Last FY FCF ÷ market cap"],
    ["div_yield", "Dividend yield", "%", "Valuation", [], ""],
    ["shareholder_yield", "Shareholder yield", "%", "Valuation", [], "(Dividends + buybacks) ÷ market cap"],
    ["peg", "PEG Ratio", "x", "Valuation", ["peg"], "P/E ÷ 5-year EPS CAGR"],
    ["intrinsic", "Intrinsic value", "$", "Valuation", ["dcf value"], "Default DCF per share (growth = 5y sales CAGR capped 0–25%, discount = 10y Treasury + 5%, terminal 2.5%, FCF − SBC)"],
    ["dcf_upside", "DCF upside", "%", "Valuation", ["upside"], "Intrinsic value vs price"],
    ["implied_g", "Implied growth", "%", "Valuation", ["reverse dcf"], "FCF growth (yrs 1–5) priced in, reverse DCF"],
    ["graham_number", "Graham Number", "$", "Valuation", ["graham"], "√(22.5 × EPS × book value per share)"],
    ["price_to_graham", "Price to Graham Number", "x", "Valuation", [], "Below 1 = under Graham's ceiling"],
    ["graham_growth", "Graham growth value", "$", "Valuation", ["graham formula"], "EPS × (8.5 + 2g) × 4.4 ÷ (10y Treasury + 1)"],
    ["epv", "Earnings power value", "$", "Valuation", ["epv per share"], "No-growth value per share: normalised after-tax EBIT ÷ discount rate − net debt"],
    ["epv_upside", "EPV upside", "%", "Valuation", ["epv to price"], "Earnings power value vs price; negative = price includes growth"],
    ["justified_pb", "Justified P/B value", "$", "Valuation", ["residual income value", "rim value"], "Book value × (ROE − g) ÷ (r − g), per share"],
    ["ncav", "NCAV per share", "$", "Valuation", ["net current asset value", "net net"], "(Current assets − all liabilities) ÷ shares"],
    ["price_to_ncav", "Price to NCAV", "x", "Valuation", ["price to net current assets"], "Below 1 = Graham net-net"],
    ["tangible_bv", "Tangible book value", "$", "Valuation", ["tbv", "tangible book value per share"], "(Equity − goodwill − intangibles) ÷ shares"],
    ["price_to_tbv", "Price to tangible book", "x", "Valuation", ["p/tbv"], ""],

    ["sales", "Sales", "$ Mn", "Size & growth", ["revenue", "sales ttm"], "TTM"],
    ["sales_ly", "Sales last year", "$ Mn", "Size & growth", ["revenue last year"], "Last fiscal year"],
    ["sales_py", "Sales preceding year", "$ Mn", "Size & growth", ["revenue preceding year", "sales previous year"], "Fiscal year before last"],
    ["np", "Net profit", "$ Mn", "Size & growth", ["profit after tax", "pat", "net income"], "TTM"],
    ["np_ly", "Net profit last year", "$ Mn", "Size & growth", ["pat last year"], ""],
    ["np_py", "Net profit preceding year", "$ Mn", "Size & growth", ["pat preceding year", "net profit previous year"], ""],
    ["eps_ly", "EPS last year", "$", "Size & growth", [], "Diluted, last fiscal year"],
    ["eps_py", "EPS preceding year", "$", "Size & growth", ["eps previous year"], ""],
    ["ebit", "Operating profit", "$ Mn", "Size & growth", ["ebit"], "TTM, Sales − COGS − SG&A − R&D"],
    ["eps", "EPS", "$", "Size & growth", ["eps ttm"], "TTM, diluted"],
    ["sales_g1", "Sales growth", "%", "Size & growth", ["sales growth ttm", "revenue growth"], "TTM vs prior 4 quarters"],
    ["sales_g3", "Sales growth 3Years", "%", "Size & growth", ["sales growth 3 years", "sales cagr 3"], "CAGR"],
    ["sales_g5", "Sales growth 5Years", "%", "Size & growth", ["sales growth 5 years", "sales cagr 5"], "CAGR"],
    ["np_g1", "Profit growth", "%", "Size & growth", ["profit growth ttm"], "TTM vs prior 4 quarters"],
    ["np_g3", "Profit growth 3Years", "%", "Size & growth", ["profit growth 3 years"], "CAGR"],
    ["np_g5", "Profit growth 5Years", "%", "Size & growth", ["profit growth 5 years"], "CAGR"],
    ["eps_g5", "EPS growth 5Years", "%", "Size & growth", ["eps growth 5 years"], "CAGR"],

    ["opm", "OPM", "%", "Profitability", ["operating margin", "operating profit margin"], "TTM"],
    ["opm_5y", "OPM 5Year", "%", "Profitability", ["average opm 5years", "opm 5 years"], "Average of last 5 fiscal years"],
    ["opm_ly", "OPM last year", "%", "Profitability", [], "Last fiscal year"],
    ["opm_py", "OPM preceding year", "%", "Profitability", ["opm previous year"], ""],
    ["npm", "Net profit margin", "%", "Profitability", ["npm"], "TTM"],
    ["gpm", "Gross margin", "%", "Profitability", ["gross profit margin", "gpm"], "TTM"],
    ["roe", "Return on equity", "%", "Profitability", ["roe"], "Last FY, average equity"],
    ["roe_3y", "Average return on equity 3Years", "%", "Profitability", ["roe 3 years", "roe 3years"], ""],
    ["roe_5y", "Average return on equity 5Years", "%", "Profitability", ["roe 5 years", "roe 5years"], ""],
    ["roce", "Return on capital employed", "%", "Profitability", ["roce"], "Last FY"],
    ["roce_py", "ROCE preceding year", "%", "Profitability", ["return on capital employed preceding year"], ""],
    ["roe_py", "ROE preceding year", "%", "Profitability", ["return on equity preceding year"], ""],
    ["roic", "ROIC", "%", "Profitability", ["return on invested capital"], "EBIT × (1 − tax) ÷ (equity + debt − cash)"],

    ["de", "Debt to equity", "x", "Balance sheet", ["d/e", "debt equity"], ""],
    ["debt", "Debt", "$ Mn", "Balance sheet", ["total debt"], "Latest balance sheet"],
    ["cash", "Cash", "$ Mn", "Balance sheet", ["cash and investments"], "Cash + short-term investments"],
    ["net_debt", "Net debt", "$ Mn", "Balance sheet", [], "Debt − cash"],
    ["debt_ly", "Debt last year", "$ Mn", "Balance sheet", ["debt current year"], "Short + long-term debt at the last fiscal year end"],
    ["debt_py", "Debt preceding year", "$ Mn", "Balance sheet", ["debt previous year", "debt prev year"], "At the fiscal year end before that"],
    ["debt_3y", "Debt 3Years back", "$ Mn", "Balance sheet", ["debt 3 years back", "debt 3 years ago"], "Three fiscal year ends before the last"],
    ["debt_chg", "Change in debt", "%", "Balance sheet", ["debt change", "debt growth"], "Last year vs preceding year (blank if preceding year had no debt)"],
    ["de_py", "Debt to equity preceding year", "x", "Balance sheet", ["d/e preceding year"], ""],
    ["net_debt_ly", "Net debt last year", "$ Mn", "Balance sheet", [], "At the last fiscal year end"],
    ["net_debt_py", "Net debt preceding year", "$ Mn", "Balance sheet", ["net debt previous year"], ""],
    ["current_ratio", "Current ratio", "x", "Balance sheet", [], ""],
    ["int_cov", "Interest Coverage Ratio", "x", "Balance sheet", ["interest coverage", "icr"], "EBIT ÷ interest, last FY"],
    ["book_value", "Book value", "$", "Balance sheet", ["bvps", "book value per share"], "Per share"],

    ["cfo_ly", "Cash from operations last year", "$ Mn", "Cash flow", ["cfo", "operating cash flow"], ""],
    ["fcf_ly", "Free cash flow last year", "$ Mn", "Cash flow", ["fcf", "free cash flow"], "CFO − capex"],
    ["fcf_margin", "FCF margin", "%", "Cash flow", [], ""],
    ["cfo_pat", "CFO to PAT", "x", "Cash flow", ["cfo/pat"], "Last FY"],
    ["payout", "Dividend Payout", "%", "Cash flow", ["dividend payout ratio"], "Last FY"],
    ["sbc_fcf", "SBC to FCF", "%", "Cash flow", ["sbc % fcf", "stock based compensation to fcf"], ""],
    ["dilution", "Change in shares", "%", "Cash flow", ["dilution", "share dilution"], "Diluted shares, last FY vs prior"],

    ["piotroski", "Piotroski score", "/9", "Quality", ["piotroski", "f score", "f-score"], "Out of 9 (fewer if data missing)"],
    ["altman_z", "Altman Z score", "", "Quality", ["altman", "z score"], "Z″ for non-manufacturers; blank for financials"],
    ["beneish_m", "Beneish M score", "", "Quality", ["beneish", "m score"], "Above −1.78 = red flag"],
    ["accruals", "Accruals ratio", "%", "Quality", ["sloan ratio"], "(Net profit − CFO) ÷ average assets"],
    ["debtor_days", "Debtor days", "days", "Quality", [], ""],
    ["inventory_days", "Inventory days", "days", "Quality", [], ""],
    ["ccc", "Cash conversion cycle", "days", "Quality", [], ""],
    ["shares", "Number of shares", "Mn", "Other", ["shares outstanding", "no eq shares"], "Latest"],
    ["years", "Years of data", "", "Other", [], "Fiscal years available"],
    ["mcap_quote", "Market cap (quoted)", "$ Mn", "Other", ["quoted market cap"], "Market cap from the price feed; used to size ADRs"],
    ["dma50", "DMA 50", "$", "Technicals", ["50 dma", "50 day moving average", "sma 50", "dma50"], "50-day simple moving average of the close"],
    ["dma200", "DMA 200", "$", "Technicals", ["200 dma", "200 day moving average", "sma 200", "dma200"], "200-day simple moving average of the close"],
    ["golden_days", "Days since golden cross", "days", "Technicals", ["golden cross", "golden crossover", "days since golden crossover"], "Trading days since the 50 DMA crossed above the 200 DMA (0 = today). Empty if the 50 DMA is below the 200 DMA now"],
    ["death_days", "Days since death cross", "days", "Technicals", ["death cross", "death crossover"], "Trading days since the 50 DMA crossed below the 200 DMA (0 = today). Empty if the 50 DMA is above the 200 DMA now"],
    ["dma50_above", "DMA 50 above DMA 200", "", "Technicals", ["50 dma above 200 dma"], "1 if the 50 DMA is above the 200 DMA, otherwise 0"],
    ["vs_dma200", "Price vs DMA 200", "%", "Technicals", ["distance from 200 dma", "price to 200 dma"], "% above (+) or below (−) the 200 DMA"],
    ["vs_dma50", "Price vs DMA 50", "%", "Technicals", ["distance from 50 dma", "price to 50 dma"], "% above (+) or below (−) the 50 DMA"],
    ["from_high", "Down from 52 week high", "%", "Technicals", ["52 week high", "below 52 week high"], "% below the highest close of the last 52 weeks (0 = at the high)"],
    ["ret_3m", "Return over 3 months", "%", "Technicals", ["3 month return"], "Price change over the last 63 trading days"],
    ["ret_1y", "Return over 1 year", "%", "Technicals", ["1 year return", "52 week return"], "Price change over the last 252 trading days"],
    ["dma150", "DMA 150", "$", "Technicals", ["150 dma", "sma 150", "dma150"], "150-day simple moving average of the close"],
    ["dma50_rising", "DMA 50 rising", "", "Technicals", ["50 dma rising"], "1 if the 50 DMA is higher than 10 trading days ago, otherwise 0"],
    ["dma200_rising", "DMA 200 rising", "", "Technicals", ["200 dma rising"], "1 if the 200 DMA is higher than a month (21 trading days) ago, otherwise 0"],
    ["from_low", "Up from 52 week low", "%", "Technicals", ["52 week low", "above 52 week low"], "% above the lowest close of the last 52 weeks"],
    ["rsi14", "RSI 14", "", "Technicals", ["rsi", "relative strength index"], "Wilder's 14-day RSI (0–100). Under 30 oversold, over 70 overbought"],
    ["vol_ratio", "Volume vs 50 day average", "x", "Technicals", ["relative volume", "volume ratio"], "Last session's volume ÷ the average of the 50 sessions before it"],
    ["new_high_vol", "New 52 week high on volume", "", "Technicals", ["52 week high on volume", "breakout on volume"], "1 if the last close is the highest of 52 weeks and volume is at least 1.5× its 50-day average"],
    ["bb_width", "Bollinger band width", "%", "Technicals", ["band width", "bbw"], "Width of the 20-day, 2-standard-deviation Bollinger bands as % of the 20-day average"],
    ["squeeze_pct", "Squeeze percentile", "%", "Technicals", ["volatility squeeze", "squeeze"], "Where today's Bollinger band width sits within the last 6 months: 0 = the narrowest (tightest) of the period"],
    ["rs_rating", "RS rating", "/99", "Technicals", ["relative strength", "rs"], "Price performance vs every US stock, 1–99 (99 = top 1%). Last 3 months count double, plus 6, 9 and 12 months"],
    ["stage2_score", "Stage 2 checks passed", "/8", "Technicals", ["trend template score", "minervini score"], "How many of the 8 Stage 2 trend-template checks the stock meets"],
    ["stage2", "Stage 2 trend template", "", "Technicals", ["stage 2", "minervini", "trend template"], "1 if all 8 checks pass: price above the 150 and 200 DMA; 150 above 200; 200 DMA rising for a month; 50 above 150 and 200; price above the 50 DMA; 30%+ above the 52-week low; within 25% of the 52-week high; RS rating 70+"],
  ];

  /* ---------- technicals from daily history (oldest → newest) ----------
     h = closes array, or { c: closes, v: volumes } (same length). RS rating and the final Stage 2 flag
     need every stock's numbers, so the builder finishes them with finishTechnicals(). */
  function technicals(h) {
    const out = {};
    const c = Array.isArray(h) ? h : h && h.c, v = Array.isArray(h) ? null : h && h.v;
    if (!c || c.length < 50) return out;
    const n = c.length, last = c[n - 1];
    const sma = (len) => {                         // rolling simple average; null until enough bars
      const a = new Array(n).fill(null); let s = 0;
      for (let i = 0; i < n; i++) { s += c[i]; if (i >= len) s -= c[i - len]; if (i >= len - 1) a[i] = s / len; }
      return a;
    };
    const s50 = sma(50), s150 = sma(150), s200 = sma(200);
    out.dma50 = s50[n - 1];
    out.vs_dma50 = (last / s50[n - 1] - 1) * 100;
    if (n > 60) out.dma50_rising = s50[n - 1] > s50[n - 11] ? 1 : 0;
    if (n >= 150) out.dma150 = s150[n - 1];
    if (n >= 200) {
      out.dma200 = s200[n - 1];
      out.vs_dma200 = (last / s200[n - 1] - 1) * 100;
      const up = s50[n - 1] > s200[n - 1];
      out.dma50_above = up ? 1 : 0;
      // walk back to the day the current state began; stays empty if it began before our history
      let i = n - 1;
      while (i > 0 && s200[i - 1] != null && (s50[i - 1] > s200[i - 1]) === up) i--;
      const days = s200[i - 1] != null && i > 0 ? n - 1 - i : null;
      out.golden_days = up ? days : null;
      out.death_days = up ? null : days;
      if (n >= 221) out.dma200_rising = s200[n - 1] > s200[n - 22] ? 1 : 0;
    }
    const yr = c.slice(-252), hi = Math.max(...yr), lo = Math.min(...yr);
    out.from_high = (1 - last / hi) * 100;
    out.from_low = (last / lo - 1) * 100;
    if (n > 63) out.ret_3m = (last / c[n - 64] - 1) * 100;
    if (n > 252) out.ret_1y = (last / c[n - 253] - 1) * 100;

    // RSI 14 (Wilder smoothing)
    if (n > 30) {
      let g = 0, l = 0;
      for (let i = 1; i <= 14; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
      g /= 14; l /= 14;
      for (let i = 15; i < n; i++) { const d = c[i] - c[i - 1]; g = (g * 13 + Math.max(d, 0)) / 14; l = (l * 13 + Math.max(-d, 0)) / 14; }
      out.rsi14 = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    // volume vs the 50 sessions before; 52-week closing high on 1.5× volume
    if (v && v.length === n && n > 51) {
      let s = 0, k = 0;
      for (let i = n - 51; i < n - 1; i++) if (v[i] > 0) { s += v[i]; k++; }
      if (k > 30 && s > 0 && v[n - 1] > 0) {
        out.vol_ratio = v[n - 1] / (s / k);
        const prevHi = Math.max(...c.slice(Math.max(0, n - 252), n - 1));
        out.new_high_vol = n >= 200 && last > prevHi && out.vol_ratio >= 1.5 ? 1 : 0;
      }
    }
    // Bollinger band width (20, 2σ) and where today's width sits in the last 6 months
    if (n >= 20 + 126) {
      const bw = [];
      for (let e = n - 126; e < n; e++) {
        let m = 0; for (let i = e - 19; i <= e; i++) m += c[i]; m /= 20;
        let q = 0; for (let i = e - 19; i <= e; i++) q += (c[i] - m) ** 2;
        bw.push(m ? (4 * Math.sqrt(q / 20)) / m * 100 : null);
      }
      const now = bw[bw.length - 1];
      if (now != null) {
        out.bb_width = now;
        const ok = bw.filter((x) => x != null);
        out.squeeze_pct = (ok.filter((x) => x < now).length / (ok.length - 1 || 1)) * 100;
      }
    }
    // RS raw score (IBD-style: last quarter double weight); ranked across all stocks later
    if (n > 252) out._rs = 2 * (last / c[n - 64]) + last / c[n - 127] + last / c[n - 190] + last / c[n - 253];
    // Stage 2 checks that don't need the cross-stock rank (7 of 8)
    if (n >= 221) {
      const p150 = s150[n - 1], p200 = s200[n - 1], p50 = s50[n - 1];
      out._s2 = [last > p150 && last > p200, p150 > p200, out.dma200_rising === 1, p50 > p150 && p50 > p200,
        last > p50, last >= lo * 1.3, last >= hi * 0.75].filter(Boolean).length;
    }
    return out;
  }

  // rows: objects carrying _rs / _s2 from technicals(); sets rs_rating (1–99), stage2_score, stage2; removes the helpers
  function finishTechnicals(rows) {
    const withRs = rows.filter((r) => r._rs != null).sort((a, b) => a._rs - b._rs);
    withRs.forEach((r, i) => { r.rs_rating = withRs.length > 1 ? Math.max(1, Math.min(99, Math.round((i / (withRs.length - 1)) * 98 + 1))) : null; });
    for (const r of rows) {
      if (r._s2 != null) {
        const rsOk = r.rs_rating != null && r.rs_rating >= 70;
        r.stage2_score = r._s2 + (rsOk ? 1 : 0);
        r.stage2 = r.stage2_score === 8 ? 1 : 0;
      }
      delete r._rs; delete r._s2;
    }
    return rows;
  }
  const TEXT = ["name", "ticker", "exchange", "sector", "industry"];

  /* ---------- per-company row ---------- */
  function rowFor(core, result, rat, val, q, opts = {}) {
    const n = result.aEnds.length, L = n - 1;
    const R = (label) => (rat.rows.find((r) => r.label === label) || { v: [] }).v;
    const hasTTM = rat.cols.at(-1) === "TTM";
    const ly = (label) => R(label)[L];
    const ttm = (label) => (hasTTM ? R(label)[n] : R(label)[L]);
    const box = (t, k) => { const b = rat.boxes.find((x) => x.title === t); const r = b && b.rows.find((x) => x[0] === k); return r ? r[1] : null; };
    const m = val.multiples, k = rat.kpis, M = (v) => (v == null || !isFinite(v) ? null : v / 1000);
    const blk = (t, key) => { const b = result.blocks.find((x) => x.title === t); const r = b && b.rows.find((x) => x.key === key); return r ? r.values : []; };
    const P = (key) => blk("PROFIT & LOSS", key), z = (v) => v || 0;
    const niFY = (i) => { const v = P("net_profit")[i]; if (v != null) return v; const s = P("sales")[i]; return s == null ? null : s - z(P("cogs")[i]) - z(P("sga")[i]) - z(P("rnd")[i]) - z(P("interest")[i]) + z(P("other_income")[i]) - z(P("other_nonop")[i]) - z(P("tax")[i]); };
    const cagr = (arr, yrs) => (n - 1 < yrs ? null : arr[L - yrs] > 0 && arr[L] > 0 ? (Math.pow(arr[L] / arr[L - yrs], 1 / yrs) - 1) * 100 : null);
    const npArr = [...Array(n).keys()].map(niFY);
    const opm = R("Operating margin (EBIT) %").slice(0, n).slice(-5).filter((x) => x != null);
    const cfo = blk("CASH FLOW", "cfo")[L];
    const taxRate = (ly("Effective tax rate %") ?? 21) / 100;
    const invested = val.equity != null ? val.equity + m.debt - m.cash : null;
    const epsC = box("Compounded EPS Growth", "5 Years");
    const fin = q && q.financial;

    // default DCF
    let intrinsic = null, implied = null;
    const rfRate = opts.rf != null ? opts.rf : 4.3;
    const fcf0 = m.fcf == null ? null : m.fcf - (m.sbc || 0);
    if (fcf0 > 0 && val.shares) {
      const g5 = box("Compounded Sales Growth", "5 Years");
      const base = { fcf0, r: (Math.round((rfRate + 5) * 2) / 2) / 100, gT: 0.025, netDebt: m.netDebt, shares: val.shares };
      const d = core.dcf({ ...base, g: Math.round(Math.max(0, Math.min(25, g5 == null ? 10 : g5))) / 100 });
      intrinsic = d ? d.perShare : null;
      if (m.mcap) { const rv = core.reverseDcf({ ...base, mcap: m.mcap }); implied = rv && !rv.below && !rv.above ? rv.g * 100 : null; }
    }
    const price = val.price;
    const BS = (key) => blk("BALANCE SHEET", key);
    const debtAt = (i) => (i < 0 || BS("total_assets")[i] == null ? null : z(BS("st_debt")[i]) + z(BS("lt_debt")[i]));
    const netDebtAt = (i) => { const d = debtAt(i); return d == null ? null : d - z(BS("cash")[i]) - z(BS("st_investments")[i]); };
    const dLy = debtAt(L), dPy = debtAt(L - 1);
    const eqAt = (i) => BS("equity")[i];
    const epsArr = R("EPS (diluted, $)");
    const prev = (label) => (n > 1 ? R(label)[L - 1] : null);
    const row = {
      sales_py: M(P("sales")[L - 1]), np_py: M(npArr[L - 1]), eps_ly: epsArr[L], eps_py: n > 1 ? epsArr[L - 1] : null,
      opm_ly: ly("Operating margin (EBIT) %"), opm_py: prev("Operating margin (EBIT) %"),
      roce_py: prev("ROCE %"), roe_py: prev("ROE %"),
      debt_ly: M(dLy), debt_py: M(dPy), debt_3y: M(debtAt(L - 3)),
      debt_chg: dLy != null && dPy > 0 ? (dLy / dPy - 1) * 100 : null,
      de_py: dPy != null && eqAt(L - 1) > 0 ? dPy / eqAt(L - 1) : null,
      net_debt_ly: M(netDebtAt(L)), net_debt_py: M(netDebtAt(L - 1)),
      price, mcap: M(m.mcap), ev: M(m.ev), pe: m.pe, pe_clean: m.peClean, pb: m.pb, ps: m.mcap && k.sales > 0 ? m.mcap / k.sales : null, pfcf: m.pfcf,
      ev_ebitda: m.evEbitda, ev_sales: m.evSales, earnings_yield: m.earningsYield, fcf_yield: m.fcfYield, div_yield: m.divYield,
      shareholder_yield: m.shareholderYield, peg: m.pe != null && epsC > 0 ? m.pe / epsC : null,
      intrinsic, dcf_upside: intrinsic != null && price ? (intrinsic / price - 1) * 100 : null, implied_g: implied,
      sales: M(k.sales), sales_ly: M(P("sales")[L]), np: M(k.ni), np_ly: M(npArr[L]), ebit: M(k.ebit), eps: k.eps,
      sales_g1: ttm("Sales growth %"), sales_g3: cagr(P("sales"), 3), sales_g5: cagr(P("sales"), 5),
      np_g1: ttm("Net profit growth %"), np_g3: cagr(npArr, 3), np_g5: cagr(npArr, 5), eps_g5: epsC,
      opm: k.ebitMargin, opm_5y: opm.length ? opm.reduce((a, b) => a + b, 0) / opm.length : null,
      npm: ttm("Net margin %"), gpm: ttm("Gross margin %"),
      roe: k.roe, roe_3y: box("Return on Equity", "3 Years avg"), roe_5y: box("Return on Equity", "5 Years avg"), roce: k.roce,
      roic: invested > 0 && k.ebit != null ? (k.ebit * (1 - taxRate) / invested) * 100 : null,
      de: val.equity > 0 ? m.debt / val.equity : null, debt: M(m.debt), cash: M(m.cash), net_debt: M(m.netDebt),
      current_ratio: ly("Current ratio (x)"), int_cov: ly("Interest coverage (x)"),
      book_value: val.shares && val.equity != null ? val.equity / val.shares : null,
      cfo_ly: M(cfo), fcf_ly: M(m.fcf), fcf_margin: ly("FCF margin %"), cfo_pat: cfo != null && npArr[L] > 0 ? cfo / npArr[L] : null,
      payout: ly("Dividend payout %"), sbc_fcf: m.sbcPctFcf, dilution: m.dilution,
      piotroski: q && q.piotroski && q.piotroski.of >= 7 ? q.piotroski.score : null,
      altman_z: q && q.altman && !q.altman.na ? q.altman.z : null, beneish_m: q && q.beneish && !fin ? q.beneish.m : null,
      accruals: q ? q.accruals : null,
      debtor_days: ly("Debtor days"), inventory_days: ly("Inventory days"), ccc: ly("Cash conversion cycle"),
      shares: val.shares ? val.shares / 1000 : null, years: n,
    };
    if (core.models) {
      const g5 = box("Compounded Sales Growth", "5 Years");
      const Mo = core.models(result, rat, val, { r: (Math.round((rfRate + 5) * 2) / 2) / 100, gT: 0.025, g: Math.round(Math.max(0, Math.min(25, g5 == null ? 10 : g5))) / 100, sbc: true, rf: rfRate });
      const mv = (k) => { const x = Mo.list.find((y) => y.key === k && !y.na); return x ? x.value : null; };
      const per = (v) => (v > 0 && price ? price / v : null);
      Object.assign(row, {
        graham_number: mv("graham"), price_to_graham: per(mv("graham")), graham_growth: mv("graham_g"),
        epv: mv("epv"), epv_upside: mv("epv") != null && price ? (mv("epv") / price - 1) * 100 : null,
        justified_pb: mv("rim"), ncav: mv("ncav"), price_to_ncav: per(mv("ncav")), tangible_bv: mv("tbv"), price_to_tbv: per(mv("tbv")),
      });
    }
    for (const key of Object.keys(row)) if (row[key] != null && !isFinite(row[key])) row[key] = null;
    return row;
  }

  /* ---------- query language ---------- */
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9%\/]+/g, " ").trim();
  const LOOKUP = new Map();
  for (const [key, label, , , aliases] of FIELDS) {
    for (const a of [key, label, ...aliases]) { LOOKUP.set(norm(a), key); LOOKUP.set(norm(a).replace(/ /g, ""), key); }
  }
  function resolve(phrase) {
    const p = norm(phrase);
    return LOOKUP.get(p) || LOOKUP.get(p.replace(/ /g, "")) || null;
  }
  function suggest(phrase, n = 3) {
    const p = norm(phrase);
    return FIELDS.map(([key, label, , , al]) => {
      const cands = [label, ...al].map(norm);
      const score = Math.max(...cands.map((c) => (c.includes(p) || p.includes(c) ? 0.9 : sim(c, p))));
      return [score, label];
    }).sort((a, b) => b[0] - a[0]).slice(0, n).filter((x) => x[0] > 0.3).map((x) => x[1]);
  }
  function sim(a, b) {   // word-overlap similarity
    const A = new Set(a.split(" ")), B = new Set(b.split(" "));
    let c = 0; A.forEach((w) => B.has(w) && c++);
    return c / Math.max(A.size, B.size);
  }

  function tokenize(src) {
    src = src.replace(/(\d),(?=\d{3}(\D|$))/g, "$1");   // 5,000 -> 5000
    const toks = [];
    let words = [], i = 0;
    const isL = (c) => /[A-Za-z]/.test(c || "");
    const flush = () => { if (words.length) { toks.push({ t: "id", v: words.join(" ") }); words = []; } };
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === "(" || c === ")") { flush(); toks.push({ t: c }); i++; continue; }
      const cmp = src.slice(i).match(/^(<=|>=|!=|<>|==|=|<|>)/);
      if (cmp) { flush(); toks.push({ t: "cmp", v: cmp[1] === "<>" ? "!=" : cmp[1] === "==" ? "=" : cmp[1] }); i += cmp[1].length; continue; }
      if (c === "+" || c === "*") { flush(); toks.push({ t: "op", v: c }); i++; continue; }
      if ((c === "-" || c === "/") && !(isL(src[i - 1]) && isL(src[i + 1]))) { flush(); toks.push({ t: "op", v: c }); i++; continue; }
      if (/[0-9.]/.test(c) && !words.length) {
        const num = src.slice(i).match(/^\d*\.?\d+/);
        if (num && !isL(src[i + num[0].length])) {
          toks.push({ t: "num", v: parseFloat(num[0]) }); i += num[0].length;
          if (src[i] === "%") i++;
          continue;
        }
      }
      // a word (letters, digits, and - / between letters)
      let w = "";
      while (i < src.length) {
        const d = src[i];
        if (/\s|[()<>=!+*]/.test(d)) break;
        if ((d === "-" || d === "/") && !(isL(src[i - 1]) && isL(src[i + 1]))) break;
        w += d; i++;
      }
      if (/^(and|or)$/i.test(w)) { flush(); toks.push({ t: w.toLowerCase() }); }
      else if (/^not$/i.test(w)) { flush(); toks.push({ t: "not" }); }
      else words.push(w);
    }
    flush();
    return toks;
  }

  function compile(src) {
    const toks = tokenize(src || "");
    let p = 0;
    const used = new Set();
    const peek = () => toks[p], eat = (t) => (toks[p] && toks[p].t === t ? toks[p++] : null);
    const fail = (msg) => { throw new Error(msg); };
    const isNull = (v) => v == null || (typeof v === "number" && !isFinite(v));

    function orE() { let a = andE(); while (eat("or")) { const l = a, r = andE(); a = (g) => !!(l(g) === true || r(g) === true); } return a; }
    function andE() { let a = notE(); while (eat("and")) { const l = a, r = notE(); a = (g) => !!(l(g) === true && r(g) === true); } return a; }
    function notE() { if (eat("not")) { const x = notE(); return (g) => x(g) !== true; } return cmpE(); }
    function cmpE() {
      const a = sum();
      const c = eat("cmp");
      if (!c) return a;
      const b = sum(), op = c.v;
      return (g) => {
        const x = a(g), y = b(g);
        if (isNull(x) || isNull(y)) return false;
        return op === "<" ? x < y : op === ">" ? x > y : op === "<=" ? x <= y : op === ">=" ? x >= y : op === "=" ? Math.abs(x - y) < 1e-9 : Math.abs(x - y) >= 1e-9;
      };
    }
    function sum() {
      let a = term();
      while (peek() && peek().t === "op" && (peek().v === "+" || peek().v === "-")) {
        const o = toks[p++].v, l = a, r = term();
        a = (g) => { const x = l(g), y = r(g); return isNull(x) || isNull(y) ? null : o === "+" ? x + y : x - y; };
      }
      return a;
    }
    function term() {
      let a = factor();
      while (peek() && peek().t === "op" && (peek().v === "*" || peek().v === "/")) {
        const o = toks[p++].v, l = a, r = factor();
        a = (g) => { const x = l(g), y = r(g); return isNull(x) || isNull(y) || (o === "/" && y === 0) ? null : o === "*" ? x * y : x / y; };
      }
      return a;
    }
    function factor() {
      const t = toks[p++];
      if (!t) fail("The query ends too early. Add a value after the last operator.");
      if (t.t === "num") return () => t.v;
      if (t.t === "op" && t.v === "-") { const f = factor(); return (g) => { const v = f(g); return isNull(v) ? null : -v; }; }
      if (t.t === "(") { const e = orE(); if (!eat(")")) fail("A bracket is not closed."); return e; }
      if (t.t === "id") {
        const key = resolve(t.v);
        if (!key) { const s = suggest(t.v); fail(`Unknown field "${t.v}".${s.length ? " Did you mean: " + s.join(", ") + "?" : ""}`); }
        used.add(key);
        return (g) => g(key);
      }
      fail(`Unexpected "${t.v || t.t}".`);
    }
    if (!toks.length) throw new Error("Type a query, e.g. Price to earning < 50 AND Market Capitalization < 5000");
    const fn = orE();
    if (p < toks.length) fail(`Didn't understand the part starting at "${toks[p].v || toks[p].t}". Join conditions with AND / OR.`);
    return { test: (get) => fn(get) === true, fields: [...used] };
  }

  const PRESETS = [
    ["Piotroski 8+", "Piotroski score >= 8 AND Market Capitalization > 300"],
    ["Magic Formula", "Return on capital employed > 25 AND Earnings yield > 6 AND Market Capitalization > 1000"],
    ["Cheap vs own DCF", "DCF upside > 30 AND Free cash flow last year > 0 AND Debt to equity < 1"],
    ["Quality compounders", "Average return on equity 5Years > 20 AND Sales growth 5Years > 10 AND Debt to equity < 0.5"],
    ["Net cash, low P/E", "Net debt < 0 AND Price to earning < 15 AND Price to earning > 0"],
    ["Clean books", "Beneish M score < -2.22 AND Altman Z score > 3 AND CFO to PAT > 1"],
    ["Growth at a fair price", "PEG Ratio < 1 AND PEG Ratio > 0 AND EPS growth 5Years > 15"],
    ["Buyback machines", "Change in shares < -2 AND Free cash flow last year > 0"],
    ["Below Graham Number", "Price to Graham Number < 1 AND Price to earning > 0 AND Market Capitalization > 300"],
    ["Graham net-nets", "Price to NCAV < 1 AND Market Capitalization > 50"],
    ["Priced for no growth", "EPV upside > 0 AND Return on capital employed > 15"],
    ["Debt reducing", "Debt last year < Debt preceding year AND Debt preceding year > 0 AND Market Capitalization > 500"],
    ["Golden cross (last 10 days)", "Days since golden cross <= 10 AND Market Capitalization > 1000"],
    ["Death cross (last 10 days)", "Days since death cross <= 10 AND Market Capitalization > 1000"],
    ["Uptrend near highs", "DMA 50 above DMA 200 = 1 AND Down from 52 week high < 5 AND Market Capitalization > 1000"],
    ["Stage 2 trend template", "Stage 2 trend template = 1 AND Market Capitalization > 1000"],
    ["RS leaders (top 10%)", "RS rating >= 90 AND Market Capitalization > 1000"],
    ["52-week high on volume", "New 52 week high on volume = 1 AND Market Capitalization > 500"],
    ["Pullback to rising 50 DMA", "DMA 50 above DMA 200 = 1 AND DMA 50 rising = 1 AND Price vs DMA 50 >= -3 AND Price vs DMA 50 <= 3 AND RSI 14 >= 40 AND RSI 14 <= 55 AND Market Capitalization > 1000"],
    ["Quality on sale", "Piotroski score >= 7 AND Debt to equity < 1 AND Price vs DMA 200 <= -10 AND Price vs DMA 200 >= -25 AND Market Capitalization > 1000"],
    ["Volatility squeeze in uptrend", "Squeeze percentile <= 5 AND DMA 50 above DMA 200 = 1 AND Market Capitalization > 1000"],
  ];

  const api = { FIELDS, TEXT, rowFor, technicals, finishTechnicals, compile, tokenize, resolve, suggest, PRESETS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ScreenCore = api;
})(typeof window !== "undefined" ? window : this);

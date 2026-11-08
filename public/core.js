/* core.js — EDGAR companyfacts -> Data Sheet logic (same rules as fetch_edgar.py).
   Works in the browser (window.EdgarCore) and in Node (require). */
(function (root) {
  "use strict";

  const FORMS = new Set(["10-K", "10-K/A", "10-Q", "10-Q/A", "10-KT", "20-F", "20-F/A", "40-F", "40-F/A", "6-K", "6-K/A"]);
  const SECTIONS = {
    PL: [["PROFIT & LOSS", "annual"], ["QUARTERS", "quarterly"]],
    BS: [["BALANCE SHEET", "annual"]],
    CF: [["CASH FLOW", "annual"]],
  };
  const DAY = 86400000;
  const t = (s) => Date.parse(s + "T00:00:00Z");
  const days = (a, b) => Math.round((t(b) - t(a)) / DAY);
  const near = (a, b, tol = 7) => Math.abs(days(a, b)) <= tol;
  const addDays = (s, n) => new Date(t(s) + n * DAY).toISOString().slice(0, 10);

  function kind(start, end) {
    if (!start) return "I";
    const n = days(start, end) + 1;
    if (n >= 80 && n <= 100) return "Q";
    if (n >= 175 && n <= 190) return "H";
    if (n >= 260 && n <= 285) return "9M";
    if (n >= 350 && n <= 380) return "FY";
    return null;
  }

  /* Which taxonomy and currency a filer reports in. US companies: us-gaap / USD.
     Many foreign filers: ifrs-full in their home currency. Result is cached on the facts object. */
  function detectBasis(facts) {
    if (facts._basis) return facts._basis;
    const F = facts.facts || {};
    const usable = (node) => node && Object.values(node.units || {}).some((a) => a.some((f) => FORMS.has(f.form)));
    const ns = usable((F["us-gaap"] || {}).Assets) || usable((F["us-gaap"] || {}).Revenues) || !F["ifrs-full"] ? "us-gaap" : "ifrs-full";
    const probe = (F[ns] || {}).Assets || (F[ns] || {}).Revenue || (F[ns] || {}).Revenues || {};
    const counts = Object.entries(probe.units || {}).filter(([u]) => /^[A-Z]{3}$/.test(u)).map(([u, a]) => [u, a.filter((f) => FORMS.has(f.form)).length]);
    counts.sort((a, b) => b[1] - a[1]);
    const cur = counts.find(([u]) => u === "USD" && counts[0][1] > 0 && counts.find((c) => c[0] === "USD")[1] >= counts[0][1] * 0.5) ? "USD" : (counts[0] ? counts[0][0] : "USD");
    const foreign = Object.values(F).some((nsNode) => Object.values(nsNode).some((n) => Object.values(n.units || {}).some((a) => a.some((f) => /^(20-F|40-F)/.test(f.form)))));
    return (facts._basis = { ns, cur, foreign });
  }

  function tagSeries(facts, tag, unit) {
    const b = facts._basis || detectBasis(facts);
    const node = ((facts.facts || {})[b.ns] || {})[tag];
    const out = new Map();
    if (!node) return out;
    const u = unit === "USD" ? b.cur : unit;
    const fx = u !== "USD" && unit === "USD" && facts._fx ? facts._fx : 1;      // convert at one (latest) rate
    for (const f of (node.units || {})[u] || []) {
      if (!FORMS.has(f.form)) continue;
      const s = f.start || null, e = f.end, k = kind(s, e);
      if (!k) continue;
      const key = `${k}|${s}|${e}`;
      const cur = out.get(key);
      if (!cur || f.filed > cur.filed)
        out.set(key, { kind: k, start: s, end: e, val: f.val * fx, tag, form: f.form,
                       filed: f.filed, accn: f.accn || "", derived: "" });
    }
    return out;
  }

  function mergedSeries(facts, tags, unit) {
    const out = new Map();
    for (const tag of tags || [])
      for (const [k, f] of tagSeries(facts, tag, unit)) if (!out.has(k)) out.set(k, f);
    return out;
  }

  function itemSeries(facts, spec) {
    const unit = spec.unit || "USD", ifrs = (facts._basis || detectBasis(facts)).ns === "ifrs-full";
    const s = mergedSeries(facts, ifrs ? spec.ifrs : spec.tags, unit);
    const comps = ifrs ? spec.ifrs_components : spec.components;
    if (comps && comps.length) {
      const parts = comps.map((c) => mergedSeries(facts, c, unit));
      for (const key of parts[0].keys()) {
        if (s.has(key) || !parts.every((p) => p.has(key))) continue;
        const fs = parts.map((p) => p.get(key));
        s.set(key, { ...fs[0], val: fs.reduce((a, f) => a + f.val, 0),
                     tag: fs.map((f) => f.tag).join(" + "),
                     filed: fs.map((f) => f.filed).sort().pop(), derived: "sum of components" });
      }
    }
    if (spec.groups && spec.groups.length) {             // sum of optional tag groups with signs
      const parts = spec.groups.map((g) => [g.sign || 1, mergedSeries(facts, ifrs ? g.ifrs : g.tags, unit)]);
      const keys = new Set(parts.flatMap(([, p]) => [...p.keys()]));
      for (const key of keys) {
        if (s.has(key)) continue;
        const hits = parts.filter(([, p]) => p.has(key)).map(([sg, p]) => [sg, p.get(key)]);
        s.set(key, { ...hits[0][1], val: hits.reduce((a, [sg, f]) => a + sg * f.val, 0),
                     tag: hits.map(([sg, f]) => (sg < 0 ? "−" : "+") + f.tag).join(" "), derived: "sum of unusual items" });
      }
    }
    if (spec.negate) for (const f of s.values()) f.val = -f.val;
    return s;
  }

  function byEnd(series, k) {
    const out = new Map();
    for (const f of series.values()) {
      if (f.kind !== k) continue;
      const cur = out.get(f.end);
      if (!cur || f.filed > cur.filed) out.set(f.end, { ...f });
    }
    return out;
  }

  function buildQuarters(series, additive = true) {
    const q = byEnd(series, "Q"), fy = byEnd(series, "FY"), nine = byEnd(series, "9M"), half = byEnd(series, "H");
    if (additive) {
      // cash-flow items are reported year-to-date in 10-Qs: turn 6- and 9-month totals into single quarters
      for (const h of half.values()) {
        if ([...q.keys()].some((e) => near(e, h.end))) continue;
        const q1 = [...q.values()].find((x) => near(x.start, h.start) && x.end < h.end);
        if (q1) q.set(h.end, { ...h, start: addDays(q1.end, 1), kind: "Q", val: h.val - q1.val, derived: "H1 YTD − Q1" });
      }
      for (const n9 of nine.values()) {
        if ([...q.keys()].some((e) => near(e, n9.end))) continue;
        const h = [...half.values()].find((x) => near(x.start, n9.start) && x.end < n9.end);
        if (h) q.set(n9.end, { ...n9, start: addDays(h.end, 1), kind: "Q", val: n9.val - h.val, derived: "9M YTD − H1 YTD" });
      }
    }
    for (const [fe, f] of fy) {
      if ([...q.keys()].some((e) => near(e, fe))) continue;
      const fs = f.start;
      const inside = [...q.keys()].filter((e) => e > fs && e < addDays(fe, -7)).sort();
      let val = null, how = "";
      if (inside.length >= 3) {
        const q123 = inside.slice(-3).map((e) => q.get(e).val);
        const sum = q123.reduce((a, b) => a + b, 0);
        val = additive ? f.val - sum : 4 * f.val - sum;
        how = additive ? "FY - Q1-Q2-Q3" : "4*FY - Q1-Q2-Q3 (approx. weighted avg)";
      } else {
        const ytd = [...nine.values()].find((n) => near(n.start, fs) && n.end < fe);
        if (ytd && additive) { val = f.val - ytd.val; how = "FY - 9M YTD"; }
        else if (ytd) { val = 4 * f.val - 3 * ytd.val; how = "4*FY - 3*9M avg (approx. weighted avg)"; }
      }
      if (val !== null) q.set(fe, { ...f, val, derived: how });
    }
    return q;
  }

  function splitFactor(filed, splits) {
    let m = 1;
    for (const [when, ratio] of splits || []) if (filed < when) m *= ratio;
    return m;
  }

  function resolveItems(cfg, ticker) {
    const items = {};
    for (const [k, v] of Object.entries(cfg.items || {})) if (!k.startsWith("_")) items[k] = { ...v };
    const ov = (cfg.overrides || {})[ticker] || {};
    for (const [k, v] of Object.entries(ov.items || {})) items[k] = { ...(items[k] || {}), ...v };
    return { items, splits: ov.splits || [], scale: cfg.scale || 1000 };
  }

  /* Main: returns everything needed to preview and to write the Data Sheet */
  function compute(facts, cfg, ticker, opts = {}) {
    const ANNUAL = opts.annualCols || 12, QUARTERS = opts.quarterCols || 10;
    ticker = (ticker || "").toUpperCase();
    const { items, splits, scale } = resolveItems(cfg, ticker);
    const annual = {}, quarterly = {};
    const basis = detectBasis(facts), basisNotes = [];
    facts._fx = basis.cur !== "USD" && opts.fx ? opts.fx : null;
    if (basis.cur !== "USD") basisNotes.push(facts._fx
      ? `Reports in ${basis.cur}; all years converted to USD at today's rate (1 ${basis.cur} = ${facts._fx.toFixed(4)} USD), so growth rates are in ${basis.cur} terms.`
      : `Reports in ${basis.cur}; no exchange rate available, so figures are in ${basis.cur} (valuation vs the USD price will be wrong).`);
    if (basis.ns === "ifrs-full") basisNotes.push("Files under IFRS; line items are mapped from IFRS tags.");

    for (const [key, spec] of Object.entries(items)) {
      if (spec.plug || spec.skip) continue;
      const s = itemSeries(facts, spec);
      if (spec.split_adjust && splits.length)
        for (const f of s.values()) {
          const m = splitFactor(f.filed, splits);
          if (m !== 1) { f.val *= m; f.derived = (f.derived ? f.derived + "; " : "") + `split x${m}`; }
        }
      if (spec.section === "BS") { annual[key] = byEnd(s, "I"); quarterly[key] = annual[key]; }
      else { annual[key] = byEnd(s, "FY"); quarterly[key] = buildQuarters(s, spec.additive !== false); }
    }

    const chk = {};
    for (const [ck, tags] of Object.entries((basis.ns === "ifrs-full" ? cfg.checks_ifrs : cfg.checks) || {})) {
      if (ck.startsWith("_")) continue;
      const s = mergedSeries(facts, tags, "USD");
      chk[ck] = [byEnd(s, "FY"), buildQuarters(s)];
    }
    const pretax = chk.pretax || [new Map(), new Map()];

    let noRevenue = false;
    if (!annual.sales || !annual.sales.size) {
      // pre-revenue companies: anchor the years on net income / operating costs and show sales as 0
      const anchorA = new Map(), anchorQ = new Map();
      for (const src of [chk.net_income, chk.pretax].filter(Boolean)) { for (const e of src[0].keys()) anchorA.set(e, 1); for (const e of src[1].keys()) anchorQ.set(e, 1); }
      for (const key of ["rnd", "sga", "tax"]) if (annual[key]) { for (const e of annual[key].keys()) anchorA.set(e, 1); for (const e of quarterly[key].keys()) anchorQ.set(e, 1); }
      if (!anchorA.size) throw new Error("No annual revenue or profit data found. Use the tag explorer to find this company's tags.");
      const zero = (ends) => new Map([...ends.keys()].map((e) => [e, { val: 0, tag: "(no revenue reported)", form: "", filed: "", accn: "", derived: "no revenue reported" }]));
      annual.sales = zero(anchorA); quarterly.sales = zero(anchorQ); noRevenue = true;
      basisNotes.push("No revenue reported: shown as 0 (common for early-stage companies).");
    }
    const aEnds = [...annual.sales.keys()].sort().slice(-ANNUAL);
    const qEnds = [...quarterly.sales.keys()].sort().slice(-QUARTERS);

    const lookup = (book, key, e) => {
      const b = book[key];
      if (!b) return null;
      if (b.has(e)) return b.get(e);
      for (const [be, f] of b) if (near(be, e)) return f;
      return null;
    };
    const plug = (book, e) => {
      const g = (k) => (lookup(book, k, e) || {}).val || 0;
      const p = pretax[book === annual ? 0 : 1].get(e);
      if (!p) return null;
      return g("sales") - g("cogs") - g("sga") - g("rnd") - g("interest") + g("other_income") - p.val;
    };

    const blocks = [], raw = [], missing = new Map(), notes = [];
    const r2 = (v) => Math.round(v * 100) / 100;
    for (const [sec, list] of Object.entries(SECTIONS)) {
      const secItems = Object.entries(items).filter(([, v]) => (v.section || "PL") === sec);
      for (const [title, freq] of list) {
        const [ends, book, ncols] = freq === "annual" ? [aEnds, annual, ANNUAL] : [qEnds, quarterly, QUARTERS];
        const block = { title, freq, ncols, ends: ends.slice(), rows: [] };
        for (const [key, spec] of secItems) {
          const row = { key, label: spec.label, values: [], src: [], sheet: spec.sheet !== false };
          for (let i = 0; i < ncols; i++) {
            const e = ends[i];
            if (!e) { row.values.push(null); row.src.push(null); continue; }
            if (spec.skip) { row.values.push(0); row.src.push({ tag: "(skipped for this ticker)" }); continue; }
            if (spec.plug) {
              const v = plug(book, e);
              row.values.push(v === null ? null : r2(v / scale));
              const src = { tag: "(plug vs reported pre-tax)", derived: "calculated" };
              row.src.push(src);
              if (v !== null) raw.push([title, spec.label, e, r2(v / scale), src.tag, "", "", "", "calculated"]);
              continue;
            }
            const f = lookup(book, key, e);
            if (!f) {
              row.values.push(spec.optional ? 0 : null); row.src.push(null);
              if (spec.quiet) continue;
              const mk = `${title}|${spec.label}|${spec.optional ? 1 : 0}`;
              if (!missing.has(mk)) missing.set(mk, []);
              missing.get(mk).push(e);
              continue;
            }
            const v = r2(f.val / scale);
            row.values.push(v); row.src.push(f);
            raw.push([title, spec.label, e, v, f.tag, f.form, f.filed, f.accn, f.derived]);
          }
          block.rows.push(row);
        }
        blocks.push(block);
      }
    }

    // Net profit = reported net income attributable to shareholders; falls back to pre-tax − tax.
    for (const b of blocks) {
      if (b.title !== "PROFIT & LOSS" && b.title !== "QUARTERS") continue;
      const g = (key) => (b.rows.find((r) => r.key === key) || { values: [] }).values;
      const zz = (v) => v || 0;
      const pat = [], np = [], clean = [], npSrc = [];
      for (let i = 0; i < b.ncols; i++) {
        const sales = g("sales")[i];
        if (sales == null || !b.ends[i]) { pat.push(null); np.push(null); clean.push(null); npSrc.push(null); continue; }
        const pbt = sales - zz(g("cogs")[i]) - zz(g("sga")[i]) - zz(g("rnd")[i]) - zz(g("interest")[i]) + zz(g("other_income")[i]) - zz(g("other_nonop")[i]);
        const p = pbt - zz(g("tax")[i]);
        const rep = g("net_income")[i];
        const v = rep != null ? rep : p;
        const tr = pbt > 0 ? Math.max(0, Math.min(0.35, zz(g("tax")[i]) / pbt)) : 0.21;
        pat.push(r2(p)); np.push(r2(v)); clean.push(r2(v - zz(g("disc_ops")[i]) + zz(g("unusual")[i]) * (1 - tr)));
        npSrc.push(rep != null ? { tag: "reported net income attributable to shareholders" } : { tag: "pre-tax profit − tax (no reported net income)", derived: "calculated" });
      }
      b.rows.push({ key: "pat", label: "Profit after tax (incl. minority)", values: pat, src: pat.map(() => ({ derived: "calculated" })), sheet: false, calc: true });
      b.rows.push({ key: "net_profit", label: "Net profit", values: np, src: npSrc, sheet: false, calc: true });
      b.rows.push({ key: "profit_clean", label: "Profit excl. unusual items", values: clean, src: clean.map(() => ({ derived: "calculated" })), sheet: false, calc: true });
    }

    const niA = (chk.net_income || [new Map()])[0];
    for (const e of aEnds) {
      const p = pretax[0].get(e), ni = niA.get(e);
      const tax = ((annual.tax && annual.tax.get(e)) || {}).val || 0;
      if (p && ni) {
        const diff = p.val - tax - ni.val;
        if (Math.abs(diff) > 0.01 * Math.max(1, Math.abs(ni.val)))
          notes.push(`FY ${e}: pre-tax minus tax differs from reported net income by ${fmt(diff / scale)} (minority interest / discontinued ops / equity income?)`);
      }
      const A = lookup(annual, "total_assets", e), L = lookup(annual, "total_liabilities", e);
      const E = lookup(annual, "equity_total", e) || lookup(annual, "equity", e);
      if (A && L && E && Math.abs(A.val - L.val - E.val) > 0.005 * Math.abs(A.val))
        notes.push(`BS ${e}: assets - liabilities - equity = ${fmt((A.val - L.val - E.val) / scale)} (mezzanine equity / NCI?)`);
    }

    const warnings = [], quiet = {};
    for (const [mk, ends] of missing) {
      const [title, label, opt] = mk.split("|");
      const ncols = title === "QUARTERS" ? qEnds.length : aEnds.length;
      const span = ends.length === 1 ? ends[0] : `${ends.length} periods, ${ends[0]} .. ${ends[ends.length - 1]}`;
      if (opt === "1") (quiet[title] = quiet[title] || []).push(ends.length >= ncols ? label : `${label} (${span})`);
      else warnings.push(`${title}: no value for '${label}' (${span})`);
    }

    // most recent balance-sheet values (latest 10-Q or 10-K), for valuation
    const latestBS = {};
    for (const [key, spec] of Object.entries(items)) {
      if (spec.section !== "BS" || spec.skip || !annual[key]) continue;
      const s = itemSeries(facts, spec);
      if (spec.split_adjust && splits.length)
        for (const f of s.values()) f.val *= splitFactor(f.filed, splits);
      let best = null;
      for (const f of s.values()) if (f.kind === "I" && (!best || f.end > best.end || (f.end === best.end && f.filed > best.filed))) best = f;
      if (best) latestBS[key] = { val: best.val / scale, end: best.end };
    }
    // latest share count from the filing cover page (sums share classes)
    let sharesLatest = null;
    const dei = (((facts.facts || {}).dei || {}).EntityCommonStockSharesOutstanding || {}).units || {};
    const arr = (dei.shares || []).filter((f) => FORMS.has(f.form));
    if (arr.length) {
      const top = arr.reduce((a, f) => (f.filed > a.filed || (f.filed === a.filed && f.end > a.end) ? f : a));
      const same = arr.filter((f) => f.accn === top.accn && f.end === top.end);
      sharesLatest = { val: same.reduce((a, f) => a + f.val, 0) / scale, end: top.end, classes: same.length };
    } else if (latestBS.shares_out) sharesLatest = { ...latestBS.shares_out, classes: 1 };
    if (!sharesLatest || !(sharesLatest.val > 0)) {          // last resort: latest diluted weighted-average shares
      const pick = (title, ends) => { const b = blocks.find((x) => x.title === title), r = b && b.rows.find((x) => x.key === "shares_diluted");
        if (!r) return null; for (let i = r.values.length - 1; i >= 0; i--) if (r.values[i] > 0) return { val: r.values[i], end: ends[i], classes: 1, approx: true }; return null; };
      sharesLatest = pick("QUARTERS", qEnds) || pick("PROFIT & LOSS", aEnds) || sharesLatest;
    }

    // ADRs: one US share can equal several home-market shares. Re-express share counts in ADR units
    // using the quoted market cap (opts.adrShares = quoted market cap ÷ price, in thousands).
    let adrRatio = 1;
    if (basis.foreign && opts.adrShares > 0 && sharesLatest && sharesLatest.val > 0) {
      const k = sharesLatest.val / opts.adrShares;
      if (k > 1.15 || k < 0.87) {
        adrRatio = k;
        for (const b of blocks) for (const r of b.rows) if (r.key === "shares_diluted" || r.key === "shares_out") r.values = r.values.map((v) => (v == null ? v : v / k));
        sharesLatest = { val: opts.adrShares, end: sharesLatest.end, classes: 1, adr: true };
        basisNotes.push(`Share counts shown per ADR: 1 ADR ≈ ${k >= 1 ? k.toFixed(2) + " ordinary shares" : (1 / k).toFixed(2) + " ADRs per share"} (from the quoted market cap).`);
      }
    }
    for (const n of basisNotes) notes.unshift(n);
    return { name: facts.entityName || ticker, ticker, scale, aEnds, qEnds, blocks, raw,
             warnings, notes, quiet, latestBS, sharesLatest, basis, noRevenue, adrRatio };
  }

  function fmt(v) {
    return v == null ? "" : Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
  }

  /* Tag explorer: every us-gaap tag with its latest annual value */
  function listTags(facts, needle) {
    needle = (needle || "").toLowerCase();
    const rows = [];
    const nsList = Object.keys(facts.facts || {}).filter((n) => n !== "dei");
    for (const [tag, node] of nsList.flatMap((n) => Object.entries(facts.facts[n]).map(([t, v]) => [n === "us-gaap" ? t : `${n}:${t}`, v]))) {
      const label = node.label || "";
      if (needle && !tag.toLowerCase().includes(needle) && !label.toLowerCase().includes(needle)) continue;
      for (const [unit, arr] of Object.entries(node.units || {})) {
        const fy = arr.filter((f) => FORMS.has(f.form) && (!f.start || kind(f.start, f.end) === "FY"));
        if (!fy.length) continue;
        const last = fy.reduce((a, f) => (f.end > a.end || (f.end === a.end && f.filed > a.filed) ? f : a));
        const first = fy.reduce((a, f) => (f.end < a ? f.end : a), fy[0].end);
        rows.push({ end: last.end, tag, unit, val: last.val, since: first, label, instant: !last.start });
      }
    }
    rows.sort((a, b) => (a.end === b.end ? Math.abs(b.val) - Math.abs(a.val) : a.end < b.end ? 1 : -1));
    return rows;
  }

  /* ---------- write into an ExcelJS workbook ---------- */
  const cellText = (c) => {
    const v = c.value;
    if (v == null) return "";
    if (typeof v === "object" && v.richText) return v.richText.map((r) => r.text).join("");
    return String(v);
  };
  function findTitle(ws, title) {
    for (let r = 1; r <= ws.rowCount; r++)
      if (cellText(ws.getCell(r, 1)).trim().toUpperCase() === title) return r;
    return null;
  }
  function findSection(ws, title) {
    const start = findTitle(ws, title);
    if (!start) throw new Error(`Couldn't find '${title}' in column A of the Data Sheet.`);
    const dateRow = start + 1, rows = {};
    for (let r = dateRow + 1; r <= ws.rowCount && cellText(ws.getCell(r, 1)) !== ""; r++)
      rows[cellText(ws.getCell(r, 1)).trim()] = r;
    return { dateRow, rows };
  }
  function ensureSection(ws, title, labels, log) {
    if (findTitle(ws, title)) return;
    const tpl = findTitle(ws, "PROFIT & LOSS");
    let last = 1;
    for (let r = 1; r <= ws.rowCount; r++)
      for (let c = 1; c <= 14; c++) if (ws.getCell(r, c).value != null && ws.getCell(r, c).value !== "") last = r;
    const r0 = last + 3, src = [tpl, tpl + 1, tpl + 2];
    [title, "Report Date", ...labels].forEach((text, i) => {
      const srow = src[Math.min(i, 2)];
      for (let c = 1; c <= 14; c++) ws.getCell(r0 + i, c).style = JSON.parse(JSON.stringify(ws.getCell(srow, c).style || {}));
      ws.getCell(r0 + i, 1).value = text;
    });
    log && log(`Added '${title}' section to the Data Sheet at row ${r0}`);
  }
  const asDate = (s) => new Date(t(s));

  function fillWorkbook(wb, result, log) {
    const ws = wb.getWorksheet("Data Sheet");
    if (!ws) throw new Error("This workbook has no sheet called 'Data Sheet'.");
    ws.getCell("B1").value = result.name.toUpperCase();
    for (const b of result.blocks)
      if (b.title !== "PROFIT & LOSS" && b.title !== "QUARTERS")
        ensureSection(ws, b.title, b.rows.filter((r) => r.sheet !== false).map((r) => r.label), log);
    const SHEET_ANNUAL = 9;                                   // your template's annual columns (B..J)
    for (const b of result.blocks) {
      const { dateRow, rows } = findSection(ws, b.title);
      const filled = b.ends.filter(Boolean).length;
      const from = b.freq === "annual" ? Math.max(0, filled - SHEET_ANNUAL) : 0;
      const ncols = b.freq === "annual" ? Math.min(SHEET_ANNUAL, b.ncols) : b.ncols;
      for (let k = 0; k < ncols; k++) {
        const i = from + k, col = 2 + k, e = b.ends[i];
        ws.getCell(dateRow, col).value = e ? asDate(e) : null;
        for (const row of b.rows) {
          if (row.sheet === false) continue;
          const r = rows[row.label];
          if (!r) { if (i === 0) log && log(`Label '${row.label}' not found under ${b.title} - row not filled`); continue; }
          ws.getCell(r, col).value = row.values[i];
        }
      }
    }
    const old = wb.getWorksheet("EDGAR_Raw");
    if (old) wb.removeWorksheet(old.id);
    const rs = wb.addWorksheet("EDGAR_Raw");
    rs.addRow([`${result.name} (${result.ticker}) - pulled ${new Date().toISOString().slice(0, 10)} from data.sec.gov - values in USD / ${result.scale.toLocaleString()} (shares / ${result.scale.toLocaleString()})`]);
    rs.addRow(["Section", "Line item", "Period end", "Value", "XBRL tag", "Form", "Filed", "Accession", "Derived"]).font = { bold: true };
    for (const r of result.raw) rs.addRow([r[0], r[1], asDate(r[2]), ...r.slice(3)]);
    [14, 30, 12, 16, 60, 8, 12, 22, 34].forEach((w, i) => (rs.getColumn(i + 1).width = w));
    rs.getColumn(3).numFmt = "yyyy-mm-dd";
    wb.calcProperties = { ...(wb.calcProperties || {}), fullCalcOnLoad: true };
    return wb;
  }

  /* A standalone workbook with just the data (no model) */
  function dataWorkbook(ExcelJS, result, rat) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Data Sheet");
    ws.getCell("A1").value = "COMPANY NAME"; ws.getCell("B1").value = result.name.toUpperCase();
    ws.getColumn(1).width = 34;
    let r = 4;
    for (const b of result.blocks) {
      ws.getCell(r, 1).value = b.title; ws.getCell(r, 1).font = { bold: true };
      ws.getCell(r + 1, 1).value = "Report Date";
      b.ends.forEach((e, i) => { const c = ws.getCell(r + 1, 2 + i); c.value = asDate(e); c.numFmt = "mmm-yy"; c.font = { bold: true }; });
      b.rows.forEach((row, j) => {
        ws.getCell(r + 2 + j, 1).value = row.label;
        row.values.forEach((v, i) => { const c = ws.getCell(r + 2 + j, 2 + i); c.value = v; c.numFmt = "#,##0"; });
      });
      r += b.rows.length + 4;
    }
    for (let c = 2; c <= 12; c++) ws.getColumn(c).width = 14;
    if (rat) {
      const rs = wb.addWorksheet("Ratios");
      rs.getColumn(1).width = 30;
      const h = rs.addRow(["Ratio", ...rat.cols.map((c) => (c === "TTM" ? "TTM" : asDate(c)))]);
      h.font = { bold: true };
      rat.cols.forEach((c, i) => { rs.getColumn(i + 2).width = 13; if (c !== "TTM") h.getCell(i + 2).numFmt = "mmm-yy"; });
      for (const r of rat.rows) {
        const row = rs.addRow([r.label, ...r.v.map((v) => (v == null || !isFinite(v) ? null : r.f === "pct" ? v / 100 : v))]);
        for (let i = 2; i <= rat.cols.length + 1; i++)
          row.getCell(i).numFmt = r.f === "pct" ? "0.0%" : r.f === "days" ? "0" : r.f === "num" ? "#,##0" : "0.00";
      }
      rs.addRow([]);
      for (const b of rat.boxes) {
        rs.addRow([b.title]).font = { bold: true };
        for (const [k, v] of b.rows) { const row = rs.addRow([k, v == null ? null : v / 100]); row.getCell(2).numFmt = "0.0%"; }
      }
    }
    return fillRawOnly(wb, result);
  }
  function fillRawOnly(wb, result) {
    const rs = wb.addWorksheet("EDGAR_Raw");
    rs.addRow(["Section", "Line item", "Period end", "Value", "XBRL tag", "Form", "Filed", "Accession", "Derived"]).font = { bold: true };
    for (const r of result.raw) rs.addRow([r[0], r[1], asDate(r[2]), ...r.slice(3)]);
    [14, 30, 12, 16, 60, 8, 12, 22, 34].forEach((w, i) => (rs.getColumn(i + 1).width = w));
    rs.getColumn(3).numFmt = "yyyy-mm-dd";
    return wb;
  }

  /* ---------- ratios (screener-style) ---------- */
  function ratios(result) {
    const blk = (t) => result.blocks.find((b) => b.title === t);
    const get = (t, key) => { const b = blk(t); const r = b && b.rows.find((x) => x.key === key); return r ? r.values : []; };
    const A = (key) => get("PROFIT & LOSS", key), B = (key) => get("BALANCE SHEET", key),
          C = (key) => get("CASH FLOW", key), Q = (key) => get("QUARTERS", key);
    const n = result.aEnds.length, nq = result.qEnds.length;
    const div = (a, b) => (a == null || b == null || !isFinite(a) || !isFinite(b) || b === 0 ? null : a / b);
    const nz = (v) => (v == null || v === 0 ? null : v);              // "not reported" (0) -> null
    const num = (v) => v || 0;

    // derived annual + TTM series (values in USD thousands; shares in thousands)
    const ttmOK = nq >= 4;
    const last4 = (key) => (ttmOK ? Q(key).slice(nq - 4).reduce((a, v) => a + num(v), 0) : null);
    const prev4 = (key) => (nq >= 8 ? Q(key).slice(nq - 8, nq - 4).reduce((a, v) => a + num(v), 0) : null);
    const pl = (i, src) => {             // src(key) -> value for column i (annual) or TTM
      const sales = src("sales"), cogs = num(src("cogs")), sga = num(src("sga")), rnd = num(src("rnd"));
      const intr = num(src("interest")), oth = num(src("other_income")), plug = num(src("other_nonop")), tax = num(src("tax"));
      const ebit = sales == null ? null : sales - cogs - sga - rnd;
      const ebt = ebit == null ? null : ebit - intr + oth - plug;
      const npv = src("net_profit"), clean = src("profit_clean");
      return { sales, cogs, ebit, ebt, tax, intr, ni: npv != null ? npv : ebt == null ? null : ebt - tax, niClean: clean, gp: sales == null ? null : sales - cogs };
    };
    const yr = [...Array(n).keys()].map((i) => pl(i, (k) => A(k)[i]));
    const ttm = ttmOK ? pl(-1, (k) => (k === "shares_diluted" ? null : last4(k))) : null;
    const ttmPrev = nq >= 8 ? pl(-1, (k) => prev4(k)) : null;
    // unusual items / discontinued ops are often only in the annual report: carry the latest FY adjustment into TTM
    if (ttm && n) {
      const qHasAdj = ["unusual", "disc_ops"].some((key) => Q(key).slice(nq - 4).some((v) => v));
      ttm.niClean = qHasAdj ? ttm.niClean : ttm.ni + (num(yr[n - 1].niClean) - num(yr[n - 1].ni));
    }
    const shares = A("shares_diluted"), qShares = Q("shares_diluted");
    const ttmShares = ttmOK ? qShares.slice(nq - 4).reduce((a, v) => a + num(v), 0) / 4 : null;
    const eps = yr.map((y, i) => div(y.ni, shares[i]));
    const ttmEps = ttm ? div(ttm.ni, ttmShares) : null;

    const eq = B("equity"), ta = B("total_assets"), cl = B("current_liabilities"), ca = B("current_assets");
    const debt = B("st_debt").map((v, i) => num(v) + num(B("lt_debt")[i]));
    const cash = B("cash"), sti = B("st_investments");
    const avg = (arr, i) => (i > 0 && arr[i - 1] != null && arr[i] != null ? (arr[i] + arr[i - 1]) / 2 : arr[i]);
    const capEmp = ta.map((v, i) => (nz(v) && nz(cl[i]) ? v - cl[i] : null));
    const fcf = C("cfo").map((v, i) => (v == null ? null : v - num(C("capex")[i])));
    const L = n - 1;

    const cols = [...result.aEnds, ...(ttm ? ["TTM"] : [])];
    const withTTM = (arr, t) => (ttm ? [...arr, t] : arr);
    const pct = (a, b) => { const v = div(a, b); return v == null ? null : v * 100; };
    const growth = (arr) => arr.map((v, i) => (i === 0 || v == null || !arr[i - 1] || arr[i - 1] <= 0 ? null : (v / arr[i - 1] - 1) * 100));
    const days = (num_, den) => num_.map((v, i) => { const x = div(nz(v), nz(den[i])); return x == null ? null : x * 365; });

    const salesArr = yr.map((y) => y.sales), niArr = yr.map((y) => y.ni);
    const rec = days(B("receivables"), salesArr), inv = days(B("inventory"), yr.map((y) => y.cogs)), pay = days(B("payables"), yr.map((y) => y.cogs));
    const ccc = rec.map((r, i) => (r == null && inv[i] == null && pay[i] == null ? null : num(r) + num(inv[i]) - num(pay[i])));

    const rows = [
      { label: "Sales growth %", f: "pct", v: withTTM(growth(salesArr), ttmPrev ? pct(ttm.sales - ttmPrev.sales, ttmPrev.sales) : null) },
      { label: "Gross margin %", f: "pct", v: withTTM(yr.map((y) => (y.cogs ? pct(y.gp, y.sales) : null)), ttm && ttm.cogs ? pct(ttm.gp, ttm.sales) : null) },
      { label: "Operating margin (EBIT) %", f: "pct", v: withTTM(yr.map((y) => pct(y.ebit, y.sales)), ttm && pct(ttm.ebit, ttm.sales)) },
      { label: "Net margin %", f: "pct", v: withTTM(yr.map((y) => pct(y.ni, y.sales)), ttm && pct(ttm.ni, ttm.sales)) },
      { label: "Net profit growth %", f: "pct", v: withTTM(growth(niArr), ttmPrev && ttmPrev.ni > 0 ? pct(ttm.ni - ttmPrev.ni, ttmPrev.ni) : null) },
      { label: "EPS (diluted, $)", f: "usd", v: withTTM(eps, ttmEps) },
      { label: "EPS growth %", f: "pct", v: withTTM(growth(eps), null) },
      { label: "Effective tax rate %", f: "pct", v: withTTM(yr.map((y) => (y.ebt > 0 ? pct(y.tax, y.ebt) : null)), ttm && ttm.ebt > 0 ? pct(ttm.tax, ttm.ebt) : null) },
      { label: "ROE %", f: "pct", v: withTTM(yr.map((y, i) => pct(y.ni, avg(eq, i))), ttm && pct(ttm.ni, eq[L])) },
      { label: "ROCE %", f: "pct", v: withTTM(yr.map((y, i) => pct(y.ebit, avg(capEmp, i))), ttm && pct(ttm.ebit, capEmp[L])) },
      { label: "Interest coverage (x)", f: "x", v: withTTM(yr.map((y) => div(y.ebit, nz(y.intr))), ttm && div(ttm.ebit, nz(ttm.intr))) },
      { label: "Debt / Equity (x)", f: "x", v: withTTM(debt.map((d, i) => div(nz(d), eq[i])), null) },
      { label: "Net debt ($k)", f: "num", v: withTTM(debt.map((d, i) => (eq[i] == null ? null : d - num(cash[i]) - num(sti[i]))), null) },
      { label: "Current ratio (x)", f: "x", v: withTTM(ca.map((v, i) => div(nz(v), nz(cl[i]))), null) },
      { label: "Debtor days", f: "days", v: withTTM(rec, null) },
      { label: "Inventory days", f: "days", v: withTTM(inv, null) },
      { label: "Payable days", f: "days", v: withTTM(pay, null) },
      { label: "Cash conversion cycle", f: "days", v: withTTM(ccc, null) },
      { label: "Free cash flow ($k)", f: "num", v: withTTM(fcf, null) },
      { label: "FCF margin %", f: "pct", v: withTTM(fcf.map((v, i) => pct(v, salesArr[i])), null) },
      { label: "FCF / Net profit (x)", f: "x", v: withTTM(fcf.map((v, i) => (niArr[i] > 0 ? div(v, niArr[i]) : null)), null) },
      { label: "Dividend payout %", f: "pct", v: withTTM(C("dividends").map((v, i) => (niArr[i] > 0 ? pct(nz(v), niArr[i]) : null)), null) },
    ].filter((r) => r.v.some((x) => x != null));

    // compounded growth boxes, screener-style
    const cagr = (arr, yrs) => {
      if (n - 1 < yrs) return null;
      const a = arr[L - yrs], b = arr[L];
      return a > 0 && b > 0 ? (Math.pow(b / a, 1 / yrs) - 1) * 100 : null;
    };
    const roeArr = rows.find((r) => r.label === "ROE %");
    const roeY = roeArr ? roeArr.v.slice(0, n) : [];
    const mean = (xs) => { const v = xs.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const span = Math.min(n - 1, 10);
    const boxes = [
      { title: "Compounded Sales Growth", rows: [[`${span} Years`, cagr(salesArr, span)], ["5 Years", cagr(salesArr, 5)], ["3 Years", cagr(salesArr, 3)], ["TTM", ttmPrev ? pct(ttm.sales - ttmPrev.sales, ttmPrev.sales) : null]] },
      { title: "Compounded Profit Growth", rows: [[`${span} Years`, cagr(niArr, span)], ["5 Years", cagr(niArr, 5)], ["3 Years", cagr(niArr, 3)], ["TTM", ttmPrev && ttmPrev.ni > 0 ? pct(ttm.ni - ttmPrev.ni, ttmPrev.ni) : null]] },
      { title: "Compounded EPS Growth", rows: [[`${span} Years`, cagr(eps, span)], ["5 Years", cagr(eps, 5)], ["3 Years", cagr(eps, 3)], ["1 Year", cagr(eps, 1)]] },
      { title: "Return on Equity", rows: [["5 Years avg", mean(roeY.slice(-5))], ["3 Years avg", mean(roeY.slice(-3))], ["Last Year", roeY[L]]] },
    ];

    const src = ttm || yr[L];
    const kpis = {
      sales: src.sales, ni: src.ni, niClean: src.niClean, ebit: src.ebit, eps: ttm ? ttmEps : eps[L], ebitMargin: pct(src.ebit, src.sales),
      roe: roeY[L], roce: (rows.find((r) => r.label === "ROCE %") || { v: [] }).v[L],
      de: div(nz(debt[L]), eq[L]), fcf: fcf[L], equity: eq[L], sharesOut: B("shares_out")[L] || shares[L], basis: ttm ? "TTM" : `FY ${result.aEnds[L].slice(0, 4)}`,
    };
    return { cols, rows, boxes, kpis };
  }

  /* ---------- valuation ---------- */
  // all money in USD thousands, shares in thousands, price in USD
  function valuation(result, rat, price, priceSeries) {
    const blk = (t) => result.blocks.find((b) => b.title === t);
    const row = (t, key) => { const b = blk(t); const r = b && b.rows.find((x) => x.key === key); return r ? r.values : []; };
    const n = result.aEnds.length, L = n - 1, nq = result.qEnds.length;
    const num = (v) => v || 0;
    const lb = (k) => (result.latestBS[k] ? result.latestBS[k].val : null);
    const sh = result.sharesLatest ? result.sharesLatest.val : null;
    const k = rat.kpis;

    const mcap = price > 0 && sh ? price * sh : null;
    const debt = num(lb("st_debt")) + num(lb("lt_debt"));
    const cash = num(lb("cash")) + num(lb("st_investments"));
    const netDebt = debt - cash;
    const ev = mcap == null ? null : mcap + netDebt;
    const dna = row("CASH FLOW", "dna")[L];
    const ebit = k.sales == null ? null : k.ebit;
    const ebitda = ebit == null ? null : ebit + num(dna);
    const fcf = k.fcf, sbc = row("CASH FLOW", "sbc")[L];
    const divs = num(row("CASH FLOW", "dividends")[L]), buy = num(row("CASH FLOW", "buybacks")[L]);
    const dil = row("PROFIT & LOSS", "shares_diluted");
    const pos = (v) => (v != null && v > 0 ? v : null);
    const ratio = (a, b) => (a == null || !pos(b) ? null : a / b);
    const equity = lb("equity") != null ? lb("equity") : k.equity;

    const multiples = {
      mcap, ev, netDebt, debt, cash, ebitda, fcf, sbc,
      pe: ratio(mcap, k.ni), peClean: ratio(mcap, k.niClean), evEbitda: ratio(ev, ebitda), evEbit: ratio(ev, ebit), evSales: ratio(ev, k.sales),
      pb: ratio(mcap, equity), pfcf: ratio(mcap, fcf), fcfYield: mcap && fcf != null ? (fcf / mcap) * 100 : null,
      earningsYield: mcap && k.ni != null ? (k.ni / mcap) * 100 : null,
      divYield: mcap ? (divs / mcap) * 100 : null,
      shareholderYield: mcap ? ((divs + buy) / mcap) * 100 : null,
      dilution: n > 1 && dil[L] && dil[L - 1] ? (dil[L] / dil[L - 1] - 1) * 100 : null,
      sbcPctFcf: fcf > 0 && sbc != null ? (sbc / fcf) * 100 : null,
    };

    // EPS timeline: FY EPS at each FY end, TTM EPS at each quarter end once 4 quarters exist
    const epsPts = [];
    const fyEps = (rat.rows.find((r) => r.label === "EPS (diluted, $)") || { v: [] }).v;
    result.aEnds.forEach((e, i) => fyEps[i] != null && epsPts.push([e, fyEps[i]]));
    const q = (key) => row("QUARTERS", key);
    for (let i = 3; i < nq; i++) {
      let ni = 0, shs = 0;
      for (let j = i - 3; j <= i; j++) {
        const s = q("sales")[j];
        ni += num(q("net_profit")[j]);
        shs += num(q("shares_diluted")[j]) / 4;
      }
      if (shs) epsPts.push([result.qEnds[i], ni / shs]);
    }
    epsPts.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const peSeries = [];
    if (priceSeries && epsPts.length) {
      let j = -1;
      for (const [d, p] of priceSeries) {
        while (j + 1 < epsPts.length && epsPts[j + 1][0] <= d) j++;
        if (j >= 0 && epsPts[j][1] > 0) peSeries.push([d, p / epsPts[j][1]]);
        else if (j >= 0) peSeries.push([d, null]);
      }
    }
    const peVals = peSeries.map((x) => x[1]).filter((v) => v != null && v < 500);
    const recent = (yrs) => {
      if (!peSeries.length) return [];
      const cut = new Date(t(peSeries.at(-1)[0]) - yrs * 365.25 * DAY).toISOString().slice(0, 10);
      return peSeries.filter((x) => x[0] >= cut && x[1] != null && x[1] < 500).map((x) => x[1]);
    };
    const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
    const pe5 = recent(5);
    const peStats = peVals.length ? {
      median5: median(pe5), medianAll: median(peVals), min: Math.min(...peVals), max: Math.max(...peVals),
      pctile: multiples.pe != null && pe5.length ? (pe5.filter((v) => v <= multiples.pe).length / pe5.length) * 100 : null,
    } : null;

    // History of EV/EBITDA, P/B and P/S: step through fundamentals as they were at each date
    // (fiscal-year points, overridden by trailing-4-quarter points where quarterly data exists).
    const BSv = (key) => row("BALANCE SHEET", key), CFv = (key) => row("CASH FLOW", key), PLv = (key) => row("PROFIT & LOSS", key);
    const fpts = [];
    result.aEnds.forEach((e, i) => {
      const sales = PLv("sales")[i], eb = sales == null ? null : sales - num(PLv("cogs")[i]) - num(PLv("sga")[i]) - num(PLv("rnd")[i]);
      fpts.push({ d: e, shares: dil[i], equity: BSv("equity")[i], netDebt: BSv("total_assets")[i] == null ? null : num(BSv("st_debt")[i]) + num(BSv("lt_debt")[i]) - num(BSv("cash")[i]) - num(BSv("st_investments")[i]),
        ebitda: eb == null ? null : eb + num(CFv("dna")[i]), sales, da: num(CFv("dna")[i]), eps: fyEps[i] });
    });
    for (let i = 3; i < nq; i++) {
      let sales = 0, eb = 0, shs = 0;
      for (let j = i - 3; j <= i; j++) { const sv = q("sales")[j]; sales += num(sv); eb += num(sv) - num(q("cogs")[j]) - num(q("sga")[j]) - num(q("rnd")[j]); shs += num(q("shares_diluted")[j]) / 4; }
      const d = result.qEnds[i], prev = fpts.filter((p) => p.d <= d && !p.q).pop() || {};
      fpts.push({ d, q: true, shares: shs || prev.shares, equity: prev.equity, netDebt: prev.netDebt, ebitda: eb + num(prev.da), sales, da: prev.da,
        eps: (epsPts.find((x) => x[0] === d) || [])[1] });
    }
    fpts.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : a.q ? 1 : -1));
    const multSeries = { pe: peSeries, ev_ebitda: [], pb: [], ps: [] }, bases = { pe: epsPts.map((x) => [x[0], x[1]]), ev_ebitda: [], pb: [], ps: [] };
    for (const p of fpts) {
      if (p.ebitda != null) bases.ev_ebitda.push([p.d, p.ebitda / 1000]);
      if (p.equity != null && p.shares) bases.pb.push([p.d, p.equity / p.shares]);
      if (p.sales != null && p.shares) bases.ps.push([p.d, p.sales / p.shares]);
    }
    if (priceSeries && fpts.length) {
      let j = -1;
      for (const [d, pr] of priceSeries) {
        while (j + 1 < fpts.length && fpts[j + 1].d <= d) j++;
        if (j < 0) continue;
        const p = fpts[j], mc = p.shares ? pr * p.shares : null;
        multSeries.ev_ebitda.push([d, mc && p.ebitda > 0 && p.netDebt != null ? (mc + p.netDebt) / p.ebitda : null]);
        multSeries.pb.push([d, mc && p.equity > 0 ? mc / p.equity : null]);
        multSeries.ps.push([d, mc && p.sales > 0 ? mc / p.sales : null]);
      }
    }
    const statsOf = (ser, cur) => {
      const all = ser.map((x) => x[1]).filter((v) => v != null && v > 0 && v < 500);
      if (!all.length) return null;
      const cut = ser.length ? new Date(t(ser.at(-1)[0]) - 5 * 365.25 * DAY).toISOString().slice(0, 10) : "";
      const v5 = ser.filter((x) => x[0] >= cut && x[1] != null && x[1] > 0 && x[1] < 500).map((x) => x[1]);
      return { median5: median(v5.length ? v5 : all), min: Math.min(...all), max: Math.max(...all), current: cur,
        pctile: cur != null && v5.length ? (v5.filter((v) => v <= cur).length / v5.length) * 100 : null };
    };
    const multStats = { pe: peStats, ev_ebitda: statsOf(multSeries.ev_ebitda, multiples.evEbitda), pb: statsOf(multSeries.pb, multiples.pb),
      ps: statsOf(multSeries.ps, mcap && k.sales > 0 ? mcap / k.sales : null) };
    return { price, shares: sh, multiples, peSeries, peStats, equity, epsPts, multSeries, multStats, bases };
  }

  // Two-stage FCF DCF: growth g for years 1-5, fading linearly to terminal growth by year 10.
  function dcf({ fcf0, g, r, gT, netDebt, shares }) {
    if (!(fcf0 > 0) || !(r > gT) || !(shares > 0)) return null;
    let f = fcf0, pv = 0;
    const flows = [];
    for (let yr = 1; yr <= 10; yr++) {
      const gy = yr <= 5 ? g : g + ((gT - g) * (yr - 5)) / 5;
      f *= 1 + gy;
      const d = f / Math.pow(1 + r, yr);
      pv += d; flows.push({ yr, g: gy, fcf: f, pv: d });
    }
    const tv = (f * (1 + gT)) / (r - gT), pvTv = tv / Math.pow(1 + r, 10);
    const evv = pv + pvTv, eq = evv - netDebt;
    return { ev: evv, equity: eq, perShare: eq / shares, pvFlows: pv, pvTerminal: pvTv, tvShare: pvTv / evv, flows };
  }
  // growth (years 1-5) that the current market cap implies
  function reverseDcf({ fcf0, r, gT, netDebt, shares, mcap }) {
    if (!(fcf0 > 0) || !(mcap > 0) || !(r > gT)) return null;
    const val = (g) => dcf({ fcf0, g, r, gT, netDebt, shares }).equity;
    let lo = -0.5, hi = 1.5;
    if (val(lo) > mcap) return { g: lo, below: true };
    if (val(hi) < mcap) return { g: hi, above: true };
    for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (val(mid) < mcap) lo = mid; else hi = mid; }
    return { g: (lo + hi) / 2 };
  }


  /* ---------- quality & red-flag scores ---------- */
  function quality(result, rat, val, sic) {
    const blk = (t) => result.blocks.find((b) => b.title === t);
    const row = (t, key) => { const b = blk(t); const r = b && b.rows.find((x) => x.key === key); return r ? r.values : []; };
    const P = (k) => row("PROFIT & LOSS", k), B = (k) => row("BALANCE SHEET", k), C = (k) => row("CASH FLOW", k);
    const n = result.aEnds.length, t1 = n - 1, t0 = n - 2;
    const z = (v) => v || 0, has = (v) => v != null && v !== 0;
    const ni = (i) => { const v = P("net_profit")[i]; if (v != null) return v; const s = P("sales")[i]; return s == null ? null : s - z(P("cogs")[i]) - z(P("sga")[i]) - z(P("rnd")[i]) - z(P("interest")[i]) + z(P("other_income")[i]) - z(P("other_nonop")[i]) - z(P("tax")[i]); };
    const ebit = (i) => { const s = P("sales")[i]; return s == null ? null : s - z(P("cogs")[i]) - z(P("sga")[i]) - z(P("rnd")[i]); };
    const TA = B("total_assets"), CA = B("current_assets"), CL = B("current_liabilities"), LTD = B("lt_debt"), STD = B("st_debt");
    const TL = B("total_liabilities"), RE = B("retained_earnings"), EQ = B("equity"), PPE = B("ppe"), REC = B("receivables");
    const CFO = C("cfo"), DA = C("dna"), SALES = P("sales"), COGS = P("cogs"), SGA = P("sga"), SH = P("shares_diluted");
    const fin = sic >= 6000 && sic <= 6799;
    const out = { year: result.aEnds[t1], prevYear: result.aEnds[t0], financial: fin };
    if (n < 2) return out;

    // Piotroski F-score (9 binary tests, latest FY vs prior FY)
    const roa = (i) => (has(TA[i]) && ni(i) != null ? ni(i) / TA[i] : null);
    const cr = (i) => (has(CA[i]) && has(CL[i]) ? CA[i] / CL[i] : null);
    const lev = (i) => (has(TA[i]) ? z(LTD[i]) / TA[i] : null);
    const gm = (i) => (has(SALES[i]) && has(COGS[i]) ? 1 - COGS[i] / SALES[i] : null);
    const at = (i) => (has(TA[i]) && SALES[i] != null ? SALES[i] / TA[i] : null);
    const pct = (v) => (v == null ? "n/a" : (v * 100).toFixed(1) + "%");
    const f2 = (v) => (v == null ? "n/a" : v.toFixed(2));
    const test = (group, name, a, b, ok, detail) => ({ group, name, pass: a == null || (b !== undefined && b == null) ? null : ok, detail });
    const tests = [
      test("Profitability", "Positive return on assets", roa(t1), undefined, roa(t1) > 0, `ROA ${pct(roa(t1))}`),
      test("Profitability", "Positive operating cash flow", CFO[t1], undefined, CFO[t1] > 0, `CFO ${fmtM(CFO[t1])}`),
      test("Profitability", "ROA improved", roa(t1), roa(t0), roa(t1) > roa(t0), `${pct(roa(t0))} → ${pct(roa(t1))}`),
      test("Profitability", "Cash flow exceeds profit (quality of earnings)", CFO[t1], ni(t1), CFO[t1] > ni(t1), `CFO ${fmtM(CFO[t1])} vs net profit ${fmtM(ni(t1))}`),
      test("Leverage & liquidity", "Long-term debt / assets fell", lev(t1), lev(t0), lev(t1) <= lev(t0), `${pct(lev(t0))} → ${pct(lev(t1))}`),
      test("Leverage & liquidity", "Current ratio improved", cr(t1), cr(t0), cr(t1) > cr(t0), cr(t1) == null ? "not reported" : `${f2(cr(t0))} → ${f2(cr(t1))}`),
      test("Leverage & liquidity", "No share dilution", SH[t1], SH[t0], SH[t1] <= SH[t0], SH[t1] && SH[t0] ? `diluted shares ${((SH[t1] / SH[t0] - 1) * 100).toFixed(1)}%` : "n/a"),
      test("Operating efficiency", "Gross margin improved", gm(t1), gm(t0), gm(t1) > gm(t0), gm(t1) == null ? "no COGS reported" : `${pct(gm(t0))} → ${pct(gm(t1))}`),
      test("Operating efficiency", "Asset turnover improved", at(t1), at(t0), at(t1) > at(t0), at(t1) == null ? "n/a" : `${f2(at(t0))} → ${f2(at(t1))}`),
    ];
    const scored = tests.filter((x) => x.pass != null);
    out.piotroski = { score: scored.filter((x) => x.pass).length, of: scored.length, tests,
      zone: scored.length < 7 ? null : scored.filter((x) => x.pass).length >= 7 ? "good" : scored.filter((x) => x.pass).length >= 4 ? "warning" : "critical" };

    // Altman Z
    if (fin) out.altman = { na: "Not meaningful for banks, lenders and insurers (SIC 6000–6799): their balance sheets are mostly debt by design." };
    else if (!has(TA[t1]) || !has(TL[t1]) || !has(CA[t1]) || !has(CL[t1])) out.altman = { na: "Needs current assets, current liabilities and total liabilities, which this company doesn't report separately." };
    else {
      const manuf = sic >= 2000 && sic <= 3999;
      const wc = (CA[t1] - CL[t1]) / TA[t1], re = z(RE[t1]) / TA[t1], eb = ebit(t1) / TA[t1], s = SALES[t1] / TA[t1];
      const mve = val && val.multiples.mcap ? val.multiples.mcap : null;
      if (manuf && mve) {
        const parts = [["Working capital / assets", 1.2, wc], ["Retained earnings / assets", 1.4, re], ["EBIT / assets", 3.3, eb], ["Market cap / liabilities", 0.6, mve / TL[t1]], ["Sales / assets", 1.0, s]];
        const zz = parts.reduce((a, [, w, v]) => a + w * v, 0);
        out.altman = { z: zz, model: "Original Z (manufacturers)", parts, safe: 2.99, distress: 1.81, zone: zz > 2.99 ? "good" : zz >= 1.81 ? "warning" : "critical" };
      } else {
        const parts = [["Working capital / assets", 6.56, wc], ["Retained earnings / assets", 3.26, re], ["EBIT / assets", 6.72, eb], ["Book equity / liabilities", 1.05, z(EQ[t1]) / TL[t1]]];
        const zz = parts.reduce((a, [, w, v]) => a + w * v, 0);
        out.altman = { z: zz, model: "Z″ (non-manufacturers)", parts, safe: 2.6, distress: 1.1, zone: zz > 2.6 ? "good" : zz >= 1.1 ? "warning" : "critical" };
      }
      if (!has(RE[t1])) out.altman.note = "Retained earnings not reported; counted as 0.";
    }

    // Beneish M-score (8 variables)
    const neutral = [];
    const idx = (name, f) => { const v = f(); if (v == null || !isFinite(v) || v <= 0) { neutral.push(name); return 1; } return v; };
    const sr = (i) => (has(REC[i]) && has(SALES[i]) ? REC[i] / SALES[i] : null);
    const aq = (i) => (has(TA[i]) && has(CA[i]) ? 1 - (CA[i] + z(PPE[i])) / TA[i] : null);
    const dep = (i) => (has(DA[i]) && has(PPE[i]) ? DA[i] / (DA[i] + PPE[i]) : null);
    const sg = (i) => (has(SGA[i]) && has(SALES[i]) ? SGA[i] / SALES[i] : null);
    const lv = (i) => (has(TA[i]) ? (z(CL[i]) + z(LTD[i]) + z(STD[i])) / TA[i] : null);
    const r = (a, b) => (a == null || b == null || b === 0 ? null : a / b);
    const v = {
      DSRI: idx("DSRI", () => r(sr(t1), sr(t0))), GMI: idx("GMI", () => r(gm(t0), gm(t1))), AQI: idx("AQI", () => r(aq(t1), aq(t0))),
      SGI: idx("SGI", () => r(SALES[t1], SALES[t0])), DEPI: idx("DEPI", () => r(dep(t0), dep(t1))), SGAI: idx("SGAI", () => r(sg(t1), sg(t0))),
      LVGI: idx("LVGI", () => r(lv(t1), lv(t0))),
    };
    const tata = has(TA[t1]) && CFO[t1] != null && ni(t1) != null ? (ni(t1) - CFO[t1]) / TA[t1] : null;
    if (tata == null) neutral.push("TATA");
    v.TATA = tata == null ? 0 : tata;
    const W = { DSRI: 0.92, GMI: 0.528, AQI: 0.404, SGI: 0.892, DEPI: 0.115, SGAI: -0.172, TATA: 4.679, LVGI: -0.327 };
    const LBL = { DSRI: "Receivables growing faster than sales", GMI: "Gross margin deteriorating", AQI: "Asset quality (more soft assets)", SGI: "Sales growth",
      DEPI: "Depreciation slowing", SGAI: "SG&A rising vs sales", TATA: "Accruals (profit not backed by cash)", LVGI: "Leverage rising" };
    const m = -4.84 + Object.entries(W).reduce((a, [k, w]) => a + w * v[k], 0);
    out.beneish = { m, threshold: -1.78, zone: fin ? null : m > -1.78 ? "critical" : m > -2.22 ? "warning" : "good",
      parts: Object.keys(W).map((k) => ({ k, label: LBL[k], v: v[k], w: W[k], neutral: neutral.includes(k) })), neutral,
      na: fin ? "Designed for non-financial companies; treat with caution for lenders." : null };

    // accruals & cash conversion
    const avgTA = has(TA[t0]) && has(TA[t1]) ? (TA[t0] + TA[t1]) / 2 : TA[t1];
    out.accruals = avgTA && CFO[t1] != null && ni(t1) != null ? ((ni(t1) - CFO[t1]) / avgTA) * 100 : null;
    const last5 = [...Array(Math.min(5, n)).keys()].map((k) => n - 1 - k);
    out.cfoBeatsNi = { hits: last5.filter((i) => CFO[i] != null && ni(i) != null && CFO[i] > ni(i)).length, of: last5.length };
    return out;
  }
  const fmtM = (v) => (v == null ? "n/a" : (v < 0 ? "−$" : "$") + Math.round(Math.abs(v) / 1000).toLocaleString("en-US") + "M");

  /* ---------- auto pros & cons, screener-style ---------- */
  function prosCons(result, rat, val, q, dcfImplied) {
    const pros = [], cons = [];
    const R = (l) => (rat.rows.find((r) => r.label === l) || { v: [] }).v;
    const box = (t, k) => { const b = rat.boxes.find((x) => x.title === t); const r = b && b.rows.find((x) => x[0] === k); return r ? r[1] : null; };
    const n = result.aEnds.length, L = n - 1, m = val ? val.multiples : {}, s = val && val.peStats;
    const roe3 = box("Return on Equity", "3 Years avg"), sales5 = box("Compounded Sales Growth", "5 Years"), prof5 = box("Compounded Profit Growth", "5 Years");
    const de = (R("Debt / Equity (x)")[L]), dePrev = R("Debt / Equity (x)")[Math.max(0, L - 3)];
    const icov = R("Interest coverage (x)")[L], payout = R("Dividend payout %")[L], opm = R("Operating margin (EBIT) %");
    if (roe3 != null && roe3 >= 18) pros.push(`Strong ROE track record: 3-year average ${roe3.toFixed(1)}%`);
    if (roe3 != null && roe3 < 8) cons.push(`Low return on equity: 3-year average ${roe3.toFixed(1)}%`);
    if (prof5 != null && prof5 >= 15) pros.push(`Profit has compounded ${prof5.toFixed(1)}% a year over 5 years`);
    if (sales5 != null && sales5 >= 12) pros.push(`Sales have grown ${sales5.toFixed(1)}% a year over 5 years`);
    if (sales5 != null && sales5 < 5) cons.push(`Weak sales growth: ${sales5.toFixed(1)}% a year over 5 years`);
    if (m.netDebt != null && m.netDebt < 0) pros.push("Net cash: more cash and investments than debt");
    else if (de != null && dePrev != null && de < dePrev * 0.8 && dePrev > 0.1) pros.push(`Has been reducing debt: debt/equity ${dePrev.toFixed(2)} → ${de.toFixed(2)}`);
    if (de != null && de > 1.5 && !(q && q.financial)) cons.push(`High leverage: debt/equity ${de.toFixed(2)}`);
    if (icov != null && icov < 3 && icov > 0) cons.push(`Thin interest cover: EBIT is only ${icov.toFixed(1)}× interest`);
    if (payout != null && payout >= 25 && payout <= 75) pros.push(`Pays a healthy dividend: ${payout.toFixed(0)}% of profit`);
    const opmV = opm.slice(0, n).filter((x) => x != null);
    if (opmV.length >= 4 && opmV.at(-1) > opmV[opmV.length - 4] + 3) pros.push(`Operating margin expanding: ${opmV[opmV.length - 4].toFixed(1)}% → ${opmV.at(-1).toFixed(1)}%`);
    if (opmV.length >= 4 && opmV.at(-1) < opmV[opmV.length - 4] - 3) cons.push(`Operating margin shrinking: ${opmV[opmV.length - 4].toFixed(1)}% → ${opmV.at(-1).toFixed(1)}%`);
    if (m.pb != null && m.pb > 10) cons.push(`Stock trades at ${m.pb.toFixed(1)}× book value`);
    if (s && m.pe != null && s.median5) {
      if (m.pe > s.median5 * 1.2) cons.push(`P/E of ${m.pe.toFixed(1)} is well above its 5-year median of ${s.median5.toFixed(1)}`);
      if (m.pe < s.median5 * 0.8) pros.push(`P/E of ${m.pe.toFixed(1)} is below its 5-year median of ${s.median5.toFixed(1)}`);
    }
    if (dcfImplied != null && sales5 != null && dcfImplied * 100 > sales5 + 5) cons.push(`Price implies ${(dcfImplied * 100).toFixed(0)}% a year FCF growth, above its 5-year sales growth of ${sales5.toFixed(0)}%`);
    if (m.dilution != null && m.dilution > 2) cons.push(`Share count rising: diluted shares up ${m.dilution.toFixed(1)}% last year`);
    if (m.dilution != null && m.dilution < -1.5) pros.push(`Buying back shares: diluted share count down ${Math.abs(m.dilution).toFixed(1)}% last year`);
    if (m.sbcPctFcf != null && m.sbcPctFcf > 25) cons.push(`Stock-based pay is ${m.sbcPctFcf.toFixed(0)}% of free cash flow`);
    if (m.fcf != null && m.fcf < 0) cons.push("Free cash flow was negative last year");
    if (q) {
      const p = q.piotroski;
      if (p && p.of >= 7 && p.score >= 7) pros.push(`Piotroski F-score ${p.score}/${p.of}: financial strength improving`);
      if (p && p.of >= 7 && p.score <= 3) cons.push(`Piotroski F-score ${p.score}/${p.of}: financial strength weakening`);
      if (q.altman && q.altman.zone === "critical") cons.push(`Altman Z of ${q.altman.z.toFixed(2)} is in the distress zone`);
      if (q.beneish && q.beneish.zone === "critical") cons.push(`Beneish M-score of ${q.beneish.m.toFixed(2)} flags possible earnings manipulation`);
      if (q.cfoBeatsNi && q.cfoBeatsNi.of >= 4 && q.cfoBeatsNi.hits >= q.cfoBeatsNi.of - 1) pros.push(`Earnings backed by cash: operating cash flow beat profit in ${q.cfoBeatsNi.hits} of the last ${q.cfoBeatsNi.of} years`);
      if (q.cfoBeatsNi && q.cfoBeatsNi.of >= 4 && q.cfoBeatsNi.hits <= 1) cons.push(`Profit not backed by cash: operating cash flow beat profit in only ${q.cfoBeatsNi.hits} of the last ${q.cfoBeatsNi.of} years`);
    }
    return { pros, cons };
  }



  /* ---------- fiscal quarter labels: period end -> {fy, fq} from the filings themselves ---------- */
  function fiscalPeriods(facts, cfg) {
    const b = detectBasis(facts), ifrs = b.ns === "ifrs-full";
    const tags = ifrs ? [...((cfg.items && cfg.items.sales && cfg.items.sales.ifrs) || []), "ProfitLoss"]
      : [...((cfg.items && cfg.items.sales && cfg.items.sales.tags) || []), "NetIncomeLoss", "OperatingIncomeLoss"];
    const best = new Map();
    for (const tag of tags) {
      const node = ((facts.facts || {})[b.ns] || {})[tag];
      for (const f of (node && node.units && node.units[b.cur]) || []) {
        if (!f.start || !f.fp || !f.fy || !FORMS.has(f.form)) continue;
        const k = kind(f.start, f.end);
        const isQ = k === "Q" && /^Q[1-3]$/.test(f.fp), isFY = k === "FY" && f.fp === "FY";
        if (!isQ && !isFY) continue;
        const cur = best.get(f.end);
        if (!cur || f.filed < cur.filed) best.set(f.end, { fy: f.fy, fq: isFY ? 4 : +f.fp[1], filed: f.filed });   // original filing wins
      }
    }
    return best;
  }

  /* ---------- other valuation models ----------
     All per-share values in USD. Shared inputs: r (discount / cost of equity, decimal), gT (terminal growth),
     g (DCF growth yrs 1–5), sbc (subtract SBC from FCF), rf (10y Treasury, %). */
  function models(result, rat, val, inp) {
    const n = result.aEnds.length, L = n - 1, k = rat.kpis, m = val.multiples, sh = val.shares;
    const R = (label) => (rat.rows.find((x) => x.label === label) || { v: [] }).v;
    const box = (t, key) => { const b = rat.boxes.find((x) => x.title === t); const r = b && b.rows.find((x) => x[0] === key); return r ? r[1] : null; };
    const blk = (t, key) => { const b = result.blocks.find((x) => x.title === t); const r = b && b.rows.find((x) => x.key === key); return r ? r.values : []; };
    const lb = (key) => (result.latestBS[key] ? result.latestBS[key].val : null);
    const r = inp.r, gT = inp.gT, out = [];
    const ok = (v) => v != null && isFinite(v);
    const add = (o) => out.push({ low: o.value, high: o.value, ...o });
    const na = (key, name, why, group) => out.push({ key, name, group, na: why });
    if (!(sh > 0)) return { list: [{ key: "all", name: "All models", na: "No share count available." }] };
    const eps = k.eps, equity = val.equity, bvps = equity != null ? equity / sh : null;
    const avg = (xs) => { const v = xs.filter(ok); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

    // DCF (range from the sensitivity grid r±1pt, g±5pt)
    const fcf0 = m.fcf == null ? null : m.fcf - (inp.sbc ? m.sbc || 0 : 0);
    if (fcf0 > 0 && r > gT) {
      const base = { fcf0, gT, netDebt: m.netDebt, shares: sh };
      const at = (dr, dg) => { const d = dcf({ ...base, r: r + dr, g: inp.g + dg }); return d ? d.perShare : null; };
      const grid = [];
      for (const dr of [-0.01, 0, 0.01]) for (const dg of [-0.05, 0, 0.05]) { const v = at(dr, dg); if (ok(v)) grid.push(v); }
      add({ key: "dcf", group: "Cash flow", name: "DCF (free cash flow)", value: at(0, 0), low: Math.min(...grid), high: Math.max(...grid),
        how: `Two-stage FCF model. Growth ${(inp.g * 100).toFixed(0)}% for 5 years fading to ${(gT * 100).toFixed(1)}%, discount ${(r * 100).toFixed(1)}%. Range: discount ±1pt, growth ±5pt.` });
    } else na("dcf", "DCF (free cash flow)", fcf0 > 0 ? "Discount rate must exceed terminal growth." : "Free cash flow is negative or missing.", "Cash flow");

    // Earnings Power Value: normalised EBIT margin × sales, after tax, as a perpetuity (no growth)
    const opm5 = avg(R("Operating margin (EBIT) %").slice(0, n).slice(-5));
    const tax = clamp(avg(R("Effective tax rate %").slice(0, n).slice(-3)) ?? 21, 0, 35) / 100;
    const ebitN = opm5 != null && k.sales != null ? (opm5 / 100) * k.sales : k.ebit;
    if (ebitN > 0 && r > 0) {
      const epv = (rr) => ((ebitN * (1 - tax)) / rr - m.netDebt) / sh;
      add({ key: "epv", group: "Earnings", name: "Earnings Power Value", value: epv(r), low: epv(r + 0.01), high: epv(Math.max(0.03, r - 0.01)),
        how: `Value with zero growth: normalised EBIT (5-yr avg margin ${opm5 != null ? opm5.toFixed(1) + "%" : "n/a"} × TTM sales) × (1 − ${(tax * 100).toFixed(0)}% tax) ÷ ${(r * 100).toFixed(1)}%, minus net debt. Price above EPV = paying for growth.` });
    } else na("epv", "Earnings Power Value", "Operating profit is not positive.", "Earnings");

    // Graham Number
    if (eps > 0 && bvps > 0) add({ key: "graham", group: "Earnings", name: "Graham Number", value: Math.sqrt(22.5 * eps * bvps),
      how: `√(22.5 × EPS $${eps.toFixed(2)} × book value/share $${bvps.toFixed(2)}). Graham's ceiling for a defensive buy: P/E 15 × P/B 1.5.` });
    else na("graham", "Graham Number", "Needs positive EPS and book value.", "Earnings");

    // Graham growth formula (revised): EPS × (8.5 + 2g) × 4.4 / Y
    const gE = box("Compounded EPS Growth", "5 Years");
    const Y = (inp.rf != null ? inp.rf : 4.3) + 1.0;
    if (eps > 0) {
      const g0 = clamp(gE == null ? 5 : gE, 0, 20);
      const gf = (g) => (eps * (8.5 + 2 * g) * 4.4) / Y;
      add({ key: "graham_g", group: "Earnings", name: "Graham growth formula", value: gf(g0), low: gf(Math.max(0, g0 - 5)), high: gf(g0 + 5),
        how: `EPS × (8.5 + 2 × ${g0.toFixed(1)}% growth) × 4.4 ÷ ${Y.toFixed(2)}% bond yield (10-yr Treasury + 1pt as an AAA proxy). Range: growth ±5pt. Growth capped at 20%.` });
    } else na("graham_g", "Graham growth formula", "EPS is not positive.", "Earnings");

    // Residual income / justified P/B
    const roe = box("Return on Equity", "3 Years avg");
    if (bvps > 0 && roe != null && r > gT) {
      const roeD = clamp(roe / 100, -0.5, 0.4);
      const jpb = (rr) => ((roeD - gT) / (rr - gT)) * bvps;
      const v = jpb(r);
      if (v > 0) add({ key: "rim", group: "Returns", name: "Residual income (justified P/B)", value: v, low: jpb(r + 0.01), high: r - 0.01 > gT ? jpb(r - 0.01) : v,
        how: `Book value/share $${bvps.toFixed(2)} × (ROE ${(roeD * 100).toFixed(1)}% − g ${(gT * 100).toFixed(1)}%) ÷ (cost of equity ${(r * 100).toFixed(1)}% − g). 3-yr average ROE, capped at 40%. The standard method for banks and insurers.` });
      else na("rim", "Residual income (justified P/B)", "ROE is below terminal growth, so the model gives no positive value.", "Returns");
    } else na("rim", "Residual income (justified P/B)", "Needs positive book value and ROE history.", "Returns");

    // Two-stage dividend discount model
    const divs = blk("CASH FLOW", "dividends"), dsh = blk("PROFIT & LOSS", "shares_diluted");
    const dps = divs.map((d, i) => (d > 0 && dsh[i] > 0 ? d / dsh[i] : null));
    if (dps[L] > 0 && r > gT) {
      const first = n > 5 ? dps[L - 5] : null;
      const gD = first > 0 ? Math.pow(dps[L] / first, 1 / 5) - 1 : 0.03;
      const g1 = clamp(gD, 0, 0.12);
      const ddm = (rr) => { let d = dps[L], pv = 0; for (let t = 1; t <= 5; t++) { d *= 1 + g1; pv += d / Math.pow(1 + rr, t); } return pv + (d * (1 + gT)) / (rr - gT) / Math.pow(1 + rr, 5); };
      add({ key: "ddm", group: "Cash flow", name: "Dividend discount model", value: ddm(r), low: ddm(r + 0.01), high: r - 0.01 > gT ? ddm(r - 0.01) : ddm(r),
        how: `Dividend/share $${dps[L].toFixed(2)} growing ${(g1 * 100).toFixed(1)}% for 5 years (5-yr history, capped 12%), then ${(gT * 100).toFixed(1)}%, discounted at ${(r * 100).toFixed(1)}%. Best for steady dividend payers.` });
    } else na("ddm", "Dividend discount model", "No dividends paid last year.", "Cash flow");

    // Asset-based
    const ca = lb("current_assets"), tl = lb("total_liabilities");
    if (ca > 0 && tl != null) {
      const v = (ca - tl) / sh;
      if (v > 0) add({ key: "ncav", group: "Assets", name: "Net current asset value", value: v, how: `(Current assets − all liabilities) ÷ shares. Graham's "net-net": a price below this is deep value.` });
      else na("ncav", "Net current asset value", "Liabilities exceed current assets (negative NCAV), the usual case.", "Assets");
    } else na("ncav", "Net current asset value", "Current assets or total liabilities not reported.", "Assets");
    if (equity != null) {
      const v = (equity - (lb("goodwill") || 0) - (lb("intangibles") || 0)) / sh;
      if (v > 0) add({ key: "tbv", group: "Assets", name: "Tangible book value", value: v, how: "(Equity − goodwill − intangibles) ÷ shares, latest balance sheet." });
      else na("tbv", "Tangible book value", "Negative: goodwill and intangibles exceed equity.", "Assets");
    }
    return { list: out, inputs: { r, gT, eps, bvps, tax, opm5, roe, Y } };
  }

  const api = { detectBasis, compute, ratios, valuation, quality, prosCons, models, fiscalPeriods, dcf, reverseDcf, listTags, fillWorkbook, dataWorkbook, fmt, SECTIONS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.EdgarCore = api;
})(typeof window !== "undefined" ? window : this);

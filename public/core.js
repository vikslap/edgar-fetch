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
    const diff = ifrs ? spec.ifrs_diff : spec.diff;              // A − B, only where both are reported
    if (diff) {
      const [A, B] = diff.map((tags) => mergedSeries(facts, tags, unit));
      for (const [key, a] of A) {
        if (s.has(key) || !B.has(key)) continue;
        const b = B.get(key);
        s.set(key, { ...a, val: a.val - b.val, tag: `${a.tag} − ${b.tag}`, filed: [a.filed, b.filed].sort().pop(), derived: "total − equity" });
      }
    }
    if (spec.negate) for (const f of s.values()) f.val = -f.val;
    return s;
  }

  /* Stock splits, found in the filings themselves: after a split, companies restate earlier periods'
     EPS and share counts, so the same period appears in two filings at an exact split ratio.
     Returns [[first filing date after the split, ratio]] (ratio = new shares per old share). */
  const NICE_RATIOS = [1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25, 30, 40, 50, 100];
  function detectSplits(facts) {
    const gaap = (facts.facts || {})["us-gaap"] || {};
    const SRC = [["WeightedAverageNumberOfDilutedSharesOutstanding", 1], ["WeightedAverageNumberOfSharesOutstandingBasic", 1],
      ["CommonStockSharesOutstanding", 1], ["EarningsPerShareDiluted", -1], ["EarningsPerShareBasic", -1]];
    const snap = (r) => {
      const inv = r < 1, x = inv ? 1 / r : r;
      const hit = NICE_RATIOS.find((n) => Math.abs(x / n - 1) < 0.03);
      return hit ? (inv ? 1 / hit : hit) : null;
    };
    const cand = [];
    for (const [tag, dir] of SRC) {
      const node = gaap[tag];
      if (!node) continue;
      for (const arr of Object.values(node.units || {})) {
        const byPeriod = new Map();
        for (const f of arr) {
          if (!FORMS.has(f.form) || !f.val) continue;
          const k = `${f.start || ""}|${f.end}`;
          (byPeriod.get(k) || byPeriod.set(k, []).get(k)).push(f);
        }
        for (const [k, fs] of byPeriod) {
          fs.sort((a, b) => (a.filed < b.filed ? -1 : 1));
          for (let i = 1; i < fs.length; i++) {
            const a = fs[i - 1], b = fs[i];
            if (a.filed === b.filed || Math.sign(a.val) !== Math.sign(b.val)) continue;
            const raw = dir > 0 ? b.val / a.val : a.val / b.val;
            if (raw > 0.85 && raw < 1.18) continue;
            const r = snap(raw);
            if (r) cand.push({ r, lo: a.filed, hi: b.filed, ev: `${tag}|${k}` });
          }
        }
      }
    }
    // group by ratio where the filing windows overlap; the split sits between the last pre-split and first post-split filing
    const groups = [];
    for (const c of cand.sort((a, b) => (a.hi < b.hi ? -1 : 1))) {
      const g = groups.find((g) => g.r === c.r && c.lo < g.hi && g.lo < c.hi);
      if (g) { g.lo = c.lo > g.lo ? c.lo : g.lo; g.hi = c.hi < g.hi ? c.hi : g.hi; g.ev.add(c.ev); }
      else groups.push({ r: c.r, lo: c.lo, hi: c.hi, ev: new Set([c.ev]) });
    }
    const ok = groups.filter((g) => g.ev.size >= 2 && g.lo < g.hi).sort((a, b) => b.ev.size - a.ev.size);
    const out = [];
    for (const g of ok) {
      // skip a "split" that is just two real ones seen across a long gap between filings
      const inside = out.filter(([d]) => d > g.lo && d <= g.hi).reduce((p, [, r]) => p * r, 1);
      if (inside !== 1 && Math.abs(inside / g.r - 1) < 0.03) continue;
      if (out.some(([d, r]) => d === g.hi)) continue;
      out.push([g.hi, g.r]);
    }
    return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
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
    const { items, splits: splitsCfg, scale } = resolveItems(cfg, ticker);
    // splits listed in the mapping win; otherwise use the ones the filings reveal
    const splits = splitsCfg.length ? splitsCfg : detectSplits(facts);
    const annual = {}, quarterly = {};
    const basis = detectBasis(facts), basisNotes = [];
    facts._fx = basis.cur !== "USD" && opts.fx ? opts.fx : null;
    if (basis.cur !== "USD") basisNotes.push(facts._fx
      ? `Reports in ${basis.cur}; all years converted to USD at today's rate (1 ${basis.cur} = ${facts._fx.toFixed(4)} USD), so growth rates are in ${basis.cur} terms.`
      : `Reports in ${basis.cur}; no exchange rate available, so figures are in ${basis.cur} (valuation vs the USD price will be wrong).`);
    if (basis.ns === "ifrs-full") basisNotes.push("Files under IFRS; line items are mapped from IFRS tags.");
    if (splits.length) basisNotes.push("Share counts adjusted for stock splits: " + splits.map(([d, r]) =>
      `${r >= 1 ? `${+r.toFixed(2)}-for-1` : `1-for-${+(1 / r).toFixed(2)} (reverse)`} (filings from ${d})`).join(", ") + ".");

    for (const [key, spec] of Object.entries(items)) {
      if (spec.plug || spec.skip || spec.from_check) continue;
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
    // Checkpoint 1: reported operating income splits the leftover into costs above it (fines, restructuring,
    // impairments…) and items below it. Ignored when missing or implausible (leftover > half of sales).
    const opexResidual = (book, e) => {
      const oi = lookup(book, "operating_income", e);
      if (!oi) return null;
      const g = (k) => (lookup(book, k, e) || {}).val || 0;
      const r = g("sales") - g("cogs") - g("sga") - g("rnd") - oi.val;
      return Math.abs(r) > 0.5 * Math.max(Math.abs(g("sales")), Math.abs(oi.val)) ? null : r;
    };
    // Checkpoint 2: reported pre-tax income
    const plug = (book, e) => {
      const g = (k) => (lookup(book, k, e) || {}).val || 0;
      const p = pretax[book === annual ? 0 : 1].get(e);
      if (!p) return null;
      return g("sales") - g("cogs") - g("sga") - g("rnd") - (opexResidual(book, e) || 0) - g("interest") + g("other_income") - p.val;
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
            if (spec.from_check) {
              const f = ((chk[spec.from_check] || [])[freq === "annual" ? 0 : 1] || new Map()).get(e);
              row.values.push(f ? r2(f.val / scale) : null); row.src.push(f || null);
              if (f) raw.push([title, spec.label, e, r2(f.val / scale), f.tag, f.form, f.filed, f.accn, f.derived]);
              continue;
            }
            if (spec.plug === "operating") {
              const v = opexResidual(book, e);
              row.values.push(v === null ? 0 : r2(v / scale));
              const src = v === null ? { tag: "(operating income not reported: left in the lines below)", derived: "calculated" }
                : { tag: "(sales − COGS − SG&A − R&D − reported operating income)", derived: "calculated" };
              row.src.push(src);
              if (v !== null) raw.push([title, spec.label, e, r2(v / scale), src.tag, "", "", "", "calculated"]);
              continue;
            }
            if (spec.plug) {
              const v = plug(book, e);
              row.values.push(v === null ? null : r2(v / scale));
              const src = { tag: "(plug vs reported pre-tax)", derived: "calculated" };
              row.src.push(src);
              if (v !== null) raw.push([title, spec.label, e, r2(v / scale), src.tag, "", "", "", "calculated"]);
              continue;
            }
            let f = lookup(book, key, e);
            if (!f && spec.residual) {                    // e.g. temporary equity = L&E total − liabilities − equity
              const parts = spec.residual.map((k) => [k.startsWith("-") ? -1 : 1, lookup(book, k.replace(/^-/, ""), e)]);
              if (parts.every(([, p]) => p) && !parts.some(([, p]) => p.derived)) {
                const v = parts.reduce((a, [sg, p]) => a + sg * p.val, 0);
                if (Math.abs(v) > 0.0005 * Math.abs(parts[0][1].val)) f = { val: v, tag: "(total liabilities & equity − liabilities − equity)", derived: "balancing", filed: parts[0][1].filed, end: e };
              }
            }
            if (!f) {
              row.values.push(null); row.src.push(null);   // not reported: blank, never 0
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
        const pbt = sales - zz(g("cogs")[i]) - zz(g("sga")[i]) - zz(g("rnd")[i]) - zz(g("other_opex")[i]) - zz(g("interest")[i]) + zz(g("other_income")[i]) - zz(g("other_nonop")[i]);
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
    // reported EPS (split-adjusted to today's share basis) for the data checks
    const reportedEps = {};
    if (basis.cur === "USD") {
      const epsTags = basis.ns === "ifrs-full" ? ["DilutedEarningsLossPerShare", "BasicEarningsLossPerShare"] : ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted", "EarningsPerShareBasic"];
      for (const [e, f] of byEnd(mergedSeries(facts, epsTags, "USD/shares"), "FY"))
        reportedEps[e] = { val: f.val / splitFactor(f.filed, splits), raw: f.val, filed: f.filed, tag: f.tag };
    }
    return { name: facts.entityName || ticker, ticker, scale, aEnds, qEnds, blocks, raw,
             warnings, notes, quiet, latestBS, sharesLatest, basis, noRevenue, adrRatio, splits, reportedEps };
  }

  /* ---------- data checks: reconcile what we show against the company's own reported totals ----------
     Returns { checks: [{id,label,status: ok|warn|fail|na, detail, years}], flags: {blockTitle: {end: [msg]}}, summary } */
  function dataChecks(result) {
    const blk = (t) => result.blocks.find((b) => b.title === t);
    const P = blk("PROFIT & LOSS"), B = blk("BALANCE SHEET"), C = blk("CASH FLOW");
    const at = (b, k) => { if (!b) return () => null; const r = b.rows.find((x) => x.key === k); const idx = new Map(b.ends.map((e, i) => [e, i]));
      return (e) => { const i = idx.get(e); return r && i != null ? r.values[i] : null; }; };
    const z = (v) => v || 0, pct = (v) => `${(v * 100).toFixed(1)}%`, money = (v) => fmt(v);
    const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const yr = (e) => `${MON[+e.slice(5, 7) - 1]} ${e.slice(0, 4)}`;
    const ends = (P ? P.ends : []).filter((e) => e && at(P, "sales")(e) != null);
    const flags = {}, checks = [];
    const flag = (title, e, msg) => { ((flags[title] = flags[title] || {})[e] = flags[title][e] || []).push(msg); };
    const add = (id, label, bad, warnOnly, okDetail, naDetail, applicable, explain) => {
      const yrs = Object.keys(bad).sort();
      const status = !applicable ? "na" : !yrs.length ? "ok" : warnOnly ? "warn" : "fail";
      checks.push({ id, label, status, years: yrs, detail: status === "na" ? naDetail : status === "ok" ? okDetail : explain(yrs) });
    };
    // 1. operating income: our lines must add up to the company's reported operating income
    { const S = at(P, "sales"), op = at(P, "operating_income"), bad = {}; let n = 0;
      for (const e of ends) {
        const r = op(e); if (r == null) continue; n++;
        const ebit = S(e) - z(at(P, "cogs")(e)) - z(at(P, "sga")(e)) - z(at(P, "rnd")(e)) - z(at(P, "other_opex")(e));
        if (Math.abs(ebit - r) > Math.max(1, 0.005 * Math.abs(S(e)))) { bad[e] = ebit - r; flag("PROFIT & LOSS", e, `Operating profit differs from reported by ${money(ebit - r)}`); }
      }
      add("op_income", "Operating profit matches reported operating income", bad, false, `All ${n} years match.`,
        "The company doesn't report operating income, so the split between operating and other items can't be checked.", n > 0,
        (y) => `Off in ${y.map(yr).join(", ")}: the cost lines don't fit the reported total (an unusual tag or a big one-off). Treat Operating Profit and OPM for these years with care.`); }
    // 2. items that couldn't be placed in any line
    { const S = at(P, "sales"), u = at(P, "other_nonop"), bad = {};
      for (const e of ends) {
        const ebit = S(e) - z(at(P, "cogs")(e)) - z(at(P, "sga")(e)) - z(at(P, "rnd")(e)) - z(at(P, "other_opex")(e));
        const v = u(e); if (v == null || !ebit) continue;
        if (Math.abs(v) > 0.05 * Math.abs(ebit) && Math.abs(v) > 0.005 * Math.abs(S(e))) { bad[e] = v; flag("PROFIT & LOSS", e, `Unplaced items ${money(-v)} (${pct(Math.abs(v / ebit))} of operating profit)`); }
      }
      add("unplaced", "Little left unplaced between operating profit and pre-tax profit", bad, true, "Under 5% of operating profit in every year.", "", ends.length > 0,
        (y) => `Over 5% of operating profit in ${y.map(yr).join(", ")} ended up in "Unclassified items". Other Income for these years may include items that belong elsewhere.`); }
    // 3. net profit explained by pre-tax − tax ± discontinued ops − minority share
    { const bad = {};
      for (const e of ends) {
        const np = at(P, "net_profit")(e), pat = at(P, "pat")(e); if (np == null || pat == null) continue;
        const gap = np - (pat + z(at(P, "disc_ops")(e)) - z(at(P, "minority")(e)));
        if (Math.abs(gap) > Math.max(1, 0.02 * Math.abs(np), 0.002 * Math.abs(at(P, "sales")(e)))) { bad[e] = gap; flag("PROFIT & LOSS", e, `Net profit has ${money(gap)} not explained by tax, discontinued operations or minority share`); }
      }
      add("net_profit", "Net profit = pre-tax − tax ± discontinued ops − minority share", bad, true, "Every year adds up.", "", ends.length > 0,
        (y) => `Unexplained gap in ${y.map(yr).join(", ")}: usually equity-method income reported after tax, or a line the site doesn't map yet.`); }
    // 4. EPS: net profit ÷ diluted shares vs the EPS the company reported (catches split and share-count errors)
    { const eps = result.reportedEps || {}, sh = at(P, "shares_diluted"), bad = {}; let n = 0, worst = 1;
      for (const e of ends) {
        const r = eps[e], np = at(P, "net_profit")(e), s = sh(e);
        if (!r || np == null || !s || Math.abs(r.val) < 0.05) continue; n++;
        const ratio = (np / s) / r.val;
        if (!(ratio > 0.95 && ratio < 1.05)) {
          bad[e] = ratio; if (Math.abs(Math.log(ratio)) > Math.abs(Math.log(worst))) worst = ratio;
          flag("PROFIT & LOSS", e, `EPS from net profit ÷ shares is ${(np / s).toFixed(2)} vs reported ${r.val.toFixed(2)}`);
        }
      }
      const split = worst > 1.8 || worst < 0.55;
      add("eps", "EPS matches reported EPS", bad, !split, `All ${n} years within 5% of reported EPS (split-adjusted).`,
        "No reported EPS to compare (or not in USD).", n > 0,
        (y) => split ? `Off by about ${worst >= 1 ? worst.toFixed(1) + "×" : "1/" + (1 / worst).toFixed(1)} in ${y.map(yr).join(", ")}: looks like a stock split or share-class change that isn't adjusted. Per-share figures for these years are wrong.`
          : `More than 5% off in ${y.map(yr).join(", ")}: often dual share classes or preferred dividends. Per-share figures are approximate.`); }
    // 5. balance sheet balances
    const bEnds = (B ? B.ends : []).filter(Boolean);
    { const A = at(B, "total_assets"), L = at(B, "total_liabilities"), T = at(B, "temp_equity"), E = at(B, "equity_total"), bad = {}; let n = 0;
      for (const e of bEnds) {
        if (A(e) == null || L(e) == null || E(e) == null) continue; n++;
        const d = A(e) - L(e) - z(T(e)) - E(e);
        if (Math.abs(d) > 0.005 * Math.abs(A(e))) { bad[e] = d; flag("BALANCE SHEET", e, `Assets − (Liabilities + Temporary equity + Equity) = ${money(d)}`); }
      }
      add("bs_balance", "Balance sheet balances (Assets = Liabilities + Temporary equity + Equity)", bad, false, `All ${n} years balance.`, "Totals not reported.", n > 0,
        (y) => `Doesn't balance in ${y.map(yr).join(", ")}: a total is missing or tagged differently (often equity with/without minority interest).`); }
    // 6. listed lines never exceed their reported total
    { const A = at(B, "total_assets"), bad = {}; const g = (k) => at(B, k);
      for (const e of bEnds) {
        const ta = Math.abs(z(A(e))); if (!ta) continue;
        const parts = [];
        if (g("current_assets")(e) != null) parts.push(["current assets", g("current_assets")(e) - z(g("cash")(e)) - z(g("st_investments")(e)) - z(g("receivables")(e)) - z(g("inventory")(e))]);
        if (g("current_assets")(e) != null) parts.push(["non-current assets", A(e) - g("current_assets")(e) - z(g("ppe")(e)) - z(g("goodwill")(e)) - z(g("intangibles")(e))]);
        if (g("current_liabilities")(e) != null) parts.push(["current liabilities", g("current_liabilities")(e) - z(g("payables")(e)) - z(g("st_debt")(e))]);
        for (const [nm, v] of parts) if (v < -0.01 * ta) { bad[e] = v; flag("BALANCE SHEET", e, `Listed ${nm} exceed the reported total by ${money(-v)}`); }
      }
      add("bs_parts", "Listed balance-sheet lines fit inside their totals", bad, true, "Every 'Other' line is zero or positive.", "", bEnds.length > 0,
        (y) => `In ${y.map(yr).join(", ")} the listed lines add up to more than the reported total: one line probably includes another (e.g. cash tagged together with investments).`); }
    // 7. cash flow explains the change in cash
    const cEnds = (C ? C.ends : []).filter(Boolean);
    { const O = at(C, "cfo"), I = at(C, "cfi"), F = at(C, "cff"), K = at(B, "cash"), A = at(B, "total_assets"), bad = {}; let n = 0;
      for (let j = 1; j < cEnds.length; j++) {
        const e = cEnds[j], p = cEnds[j - 1];
        if (O(e) == null || I(e) == null || F(e) == null || K(e) == null || K(p) == null) continue; n++;
        const d = O(e) + I(e) + F(e) - (K(e) - K(p));
        if (Math.abs(d) > Math.max(0.03 * Math.abs(O(e)), 0.005 * Math.abs(z(A(e))), 1)) { bad[e] = d; flag("CASH FLOW", e, `Cash flows differ from the change in cash by ${money(d)}`); }
      }
      add("cash", "Cash flows explain the change in cash", bad, true, `All ${n} years agree.`, "Not enough cash-flow data.", n > 0,
        (y) => `Gap in ${y.map(yr).join(", ")}: usually exchange-rate effects or restricted cash, which the cash line may exclude. Large gaps mean a cash-flow line is missing.`); }
    // 8. share count doesn't jump
    { const sh = at(P, "shares_diluted"), bad = {};
      for (let j = 1; j < ends.length; j++) {
        const a = sh(ends[j - 1]), b = sh(ends[j]); if (!a || !b) continue;
        const r = b / a; if (r > 1.8 || r < 0.55) { bad[ends[j]] = r; flag("PROFIT & LOSS", ends[j], `Diluted shares changed ${r.toFixed(1)}× from the year before`); }
      }
      add("shares", "Share count has no unexplained jumps", bad, false, "No jumps between years.", "", ends.length > 1,
        (y) => `Shares jump in ${y.map(yr).join(", ")}: an unadjusted split, a big acquisition paid in shares, or a change in share classes. Check per-share figures around these years.`); }
    // 9. key lines present
    { const bad = {}, need = [["Net profit", at(P, "net_profit")], ["Total assets", at(B, "total_assets")], ["Shareholders' equity", at(B, "equity")], ["Operating cash flow", at(C, "cfo")]];
      const miss = {};
      for (const e of ends) for (const [nm, f] of need) if (f(e) == null) { (miss[e] = miss[e] || []).push(nm); bad[e] = 1; }
      add("coverage", "Key lines reported every year", bad, true, "Net profit, total assets, equity and operating cash flow are there for every year.", "", ends.length > 0,
        (y) => `Missing: ${y.map((e) => `${yr(e)} (${miss[e].join(", ")})`).join("; ")}.`); }
    if (result.splits && result.splits.length) checks.push({ id: "splits", label: "Stock splits adjusted", status: "ok", years: [],
      detail: result.splits.map(([d, r]) => `${r >= 1 ? `${+r.toFixed(2)}-for-1` : `1-for-${+(1 / r).toFixed(2)}`} (filings from ${d})`).join(", ") });
    const summary = { ok: 0, warn: 0, fail: 0, na: 0 };
    for (const c of checks) summary[c.status]++;
    return { checks, flags, summary };
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

  function fillWorkbook(wb, result, log, facts) {
    const ws = wb.getWorksheet("Data Sheet");
    if (!ws) throw new Error("This workbook has no sheet called 'Data Sheet'.");
    ws.getCell("B1").value = result.name.toUpperCase();
    for (const b of result.blocks)
      if (b.title !== "PROFIT & LOSS" && b.title !== "QUARTERS")
        ensureSection(ws, b.title, b.rows.filter((r) => r.sheet !== false).map((r) => r.label), log);
    const SHEET_ANNUAL = 9;                                   // your template's annual columns (B..J)
    // rows added in Nov 2026; older copies of the template don't have them
    const NEW_ROWS = new Set(["Other Operating Costs", "Operating Income (reported)", "Pre-tax Income (reported)", "Temporary Equity"]);
    let oldTemplate = false;
    for (const b of result.blocks) {
      const { dateRow, rows } = findSection(ws, b.title);
      const filled = b.ends.filter(Boolean).length;
      // no "Other Operating Costs" row: put it back into the nonoperating plug so EBT still ties to the reported figure
      const oo = b.rows.find((r) => r.key === "other_opex");
      const fold = oo && !rows[oo.label];
      if (fold && b.title === "PROFIT & LOSS") oldTemplate = true;
      const from = b.freq === "annual" ? Math.max(0, filled - SHEET_ANNUAL) : 0;
      const ncols = b.freq === "annual" ? Math.min(SHEET_ANNUAL, b.ncols) : b.ncols;
      for (let k = 0; k < ncols; k++) {
        const i = from + k, col = 2 + k, e = b.ends[i];
        ws.getCell(dateRow, col).value = e ? asDate(e) : null;
        for (const row of b.rows) {
          if (row.sheet === false) continue;
          const r = rows[row.label];
          if (!r) { if (i === 0 && !NEW_ROWS.has(row.label)) log && log(`Label '${row.label}' not found under ${b.title} - row not filled`); continue; }
          let v = row.values[i];
          if (fold && row.key === "other_nonop" && v != null) v = Math.round((v + (oo.values[i] || 0)) * 100) / 100;
          ws.getCell(r, col).value = v;
        }
      }
    }
    if (oldTemplate && log) log("Your template has no 'Other Operating Costs' row, so those costs are included in 'Other Nonoperating Expenses' as before. The latest My_Model.xlsx in the repo shows them separately, with checks.");
    const old = wb.getWorksheet("EDGAR_Raw");
    if (old) wb.removeWorksheet(old.id);
    writeRaw(wb.addWorksheet("EDGAR_Raw"), result, facts);
    standardSheet(wb, result);
    wb.calcProperties = { ...(wb.calcProperties || {}), fullCalcOnLoad: true };
    return wb;
  }

  /* A standalone workbook with just the data (no model) */
  function dataWorkbook(ExcelJS, result, rat, facts) {
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
      let extra = 0;
      if (b.title === "BALANCE SHEET") {          // show that it balances: L + E and a check, as formulas
        const at = (k) => r + 2 + b.rows.findIndex((x) => x.key === k);
        const [A, TL, TE, TQ] = ["total_assets", "total_liabilities", "equity_total", "temp_equity"].map(at);
        const le = r + 2 + b.rows.length, ck = le + 1;
        ws.getCell(le, 1).value = "Total Liabilities + Temporary Equity + Equity"; ws.getCell(le, 1).font = { bold: true };
        ws.getCell(ck, 1).value = "Check: Assets − (Liabilities + Temp. Equity + Equity)"; ws.getCell(ck, 1).font = { italic: true };
        b.ends.forEach((e, i) => {
          if (!e) return;
          const col = String.fromCharCode(66 + i);
          ws.getCell(le, 2 + i).value = { formula: `IF(OR(${col}${TL}="",${col}${TE}=""),"",${col}${TL}+${col}${TE}${TQ > r + 1 ? `+N(${col}${TQ})` : ""})` };
          ws.getCell(le, 2 + i).numFmt = "#,##0"; ws.getCell(le, 2 + i).font = { bold: true };
          ws.getCell(ck, 2 + i).value = { formula: `IF(OR(${col}${A}="",${col}${le}=""),"",ROUND(${col}${A}-${col}${le},0))` };
          ws.getCell(ck, 2 + i).numFmt = '#,##0;-#,##0;"OK"'; ws.getCell(ck, 2 + i).font = { italic: true };
        });
        extra = 2;
      }
      r += b.rows.length + 4 + extra;
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
    return fillRawOnly(wb, result, facts);
  }
  function fillRawOnly(wb, result, facts) {
    standardSheet(wb, result);
    writeRaw(wb.addWorksheet("EDGAR_Raw"), result, facts);
    return wb;
  }

  /* Every line item the company reported (all tags, not just the mapped ones), one row per tag and period,
     for the same fiscal years and quarters as the Data Sheet. As reported: no Q4 derivation, no currency
     conversion. Money and share counts are divided by the scale; per-share and ratio units are not. */
  function allFactRows(facts, result) {
    const out = [], scale = result.scale || 1;
    const periods = [["ALL TAGS · ANNUAL", result.aEnds || [], "FY"], ["ALL TAGS · QUARTERLY", (result.qEnds || []).filter(Boolean), "Q"]];
    const nsOrder = (n) => (n === "dei" ? 2 : n === "us-gaap" || n === "ifrs-full" ? 0 : 1);
    for (const ns of Object.keys(facts.facts || {}).sort((a, b) => nsOrder(a) - nsOrder(b))) {
      for (const [tag, node] of Object.entries(facts.facts[ns]).sort(([a], [b]) => a.localeCompare(b))) {
        const name = ns === "us-gaap" ? tag : `${ns}:${tag}`;
        for (const [unit, arr] of Object.entries(node.units || {})) {
          const div = /\/|pure/i.test(unit) ? 1 : scale;
          const fs = arr.filter((f) => FORMS.has(f.form));
          for (const [section, ends, want] of periods) {
            for (const e of ends) {
              let best = null;
              for (const f of fs) {
                if (!near(f.end, e)) continue;
                if (f.start && kind(f.start, f.end) !== want) continue;
                if (!best || f.filed > best.filed) best = f;
              }
              if (best) out.push([section, node.label || tag, e, Math.round((best.val / div) * 100) / 100, name, best.form, best.filed, best.accn || "",
                best.start ? `${best.start} to ${best.end}` : "as at period end", unit]);
            }
          }
        }
      }
    }
    return out;
  }
  function writeRaw(rs, result, facts) {
    rs.addRow([`${result.name} (${result.ticker}) - pulled ${new Date().toISOString().slice(0, 10)} from data.sec.gov - money and shares in units / ${result.scale.toLocaleString()} (per-share and ratios as reported) - filter column A to switch between the mapped items and ALL TAGS`]);
    const head = rs.addRow(["Section", "Line item", "Period end", "Value", "XBRL tag", "Form", "Filed", "Accession", "Derived / period", "Unit"]);
    head.font = { bold: true };
    for (const r of result.raw) rs.addRow([r[0], r[1], asDate(r[2]), ...r.slice(3), /share/i.test(r[1]) ? "shares" : "USD"]);
    if (facts) for (const r of allFactRows(facts, result)) rs.addRow([r[0], r[1], asDate(r[2]), ...r.slice(3)]);
    [24, 44, 12, 16, 60, 8, 12, 22, 26, 12].forEach((w, i) => (rs.getColumn(i + 1).width = w));
    rs.getColumn(3).numFmt = "yyyy-mm-dd";
    rs.getColumn(4).numFmt = "#,##0.##";
    rs.autoFilter = { from: { row: 2, column: 1 }, to: { row: rs.rowCount, column: 10 } };
    rs.views = [{ state: "frozen", ySplit: 2 }];
  }

  /* ---------- "Standard" sheet: one fixed, SF1-style layout for every company ----------
     Subtotals come from the company's reported figures; the *_other lines absorb what doesn't fit,
     so every identity holds. Inputs are values (blue), everything else is an Excel formula. */
  const STD = [
    ["h", "INCOME STATEMENT"],
    ["revenue", "Revenue", "P", "sales"],
    ["cor", "Cost of revenue", "P", "cogs"],
    ["gp", "Gross profit = revenue − cor", "f", "{revenue}-{cor}"],
    ["sgna", "Selling, general & administrative", "P", "sga"],
    ["rnd", "Research & development", "P", "rnd"],
    ["opex_other", "Other operating costs (fines, restructuring, impairments…)", "P", "other_opex"],
    ["opex", "Operating expenses = sgna + rnd + opex_other", "f", "{sgna}+{rnd}+{opex_other}"],
    ["opinc", "Operating income = gp − opex", "f", "{gp}-{opex}"],
    ["intexp", "Interest expense", "P", "interest"],
    ["nonop", "Other income (reported, net)", "P", "other_income"],
    ["nonop_other", "Other non-operating items (balancing)", "Pn", "other_nonop"],
    ["ebt", "Pre-tax income = opinc − intexp + nonop + nonop_other", "f", "{opinc}-{intexp}+{nonop}+{nonop_other}"],
    ["taxexp", "Income tax", "P", "tax"],
    ["netincdis", "Discontinued operations", "P", "disc_ops"],
    ["consolinc", "Consolidated net income = ebt − taxexp + netincdis", "f", "{ebt}-{taxexp}+{netincdis}"],
    ["netincnci", "Minority (non-controlling) share", "P", "minority"],
    ["netinc_other", "Other items after tax (balancing, e.g. equity-method income)", "f", "IF({netinc_rep}=\"\",0,{netinc_rep}-({consolinc}-{netincnci}))"],
    ["netinc", "Net income to shareholders = consolinc − netincnci + netinc_other", "f", "{consolinc}-{netincnci}+{netinc_other}"],
    ["shareswadil", "Diluted weighted average shares", "P", "shares_diluted"],
    ["epsdil", "Diluted EPS = netinc ÷ shareswadil ($)", "f", "IF(N({shareswadil})=0,\"\",{netinc}/{shareswadil})", "0.00"],
    ["depamor", "Depreciation & amortisation (cash flow)", "C", "dna"],
    ["ebitda", "EBITDA = opinc + depamor", "f", "{opinc}+{depamor}"],
    ["h", "BALANCE SHEET"],
    ["cashneq", "Cash & equivalents", "B", "cash"],
    ["investmentsc", "Short-term investments", "B", "st_investments"],
    ["receivables", "Receivables", "B", "receivables"],
    ["inventory", "Inventory", "B", "inventory"],
    ["assetsc_other", "Other current assets (balancing)", "f", "IF(N({assetsc})=0,0,{assetsc}-{cashneq}-{investmentsc}-{receivables}-{inventory})"],
    ["assetsc", "Current assets", "B", "current_assets"],
    ["ppnenet", "Property, plant & equipment (net)", "B", "ppe"],
    ["goodwill", "Goodwill", "B", "goodwill"],
    ["intangibles", "Intangible assets", "B", "intangibles"],
    ["assetsnc_other", "Other non-current assets (balancing)", "f", "IF(N({assets})=0,0,{assets}-{assetsc}-{ppnenet}-{goodwill}-{intangibles})"],
    ["assets", "Total assets", "B", "total_assets"],
    ["payables", "Accounts payable", "B", "payables"],
    ["debtc", "Short-term debt", "B", "st_debt"],
    ["liabilitiesc_other", "Other current liabilities (balancing)", "f", "IF(N({liabilitiesc})=0,0,{liabilitiesc}-{payables}-{debtc})"],
    ["liabilitiesc", "Current liabilities", "B", "current_liabilities"],
    ["debtnc", "Long-term debt", "B", "lt_debt"],
    ["liabilitiesnc_other", "Other non-current liabilities (balancing)", "f", "IF(N({liabilities})=0,0,{liabilities}-{liabilitiesc}-{debtnc})"],
    ["liabilities", "Total liabilities", "B", "total_liabilities"],
    ["tempequity", "Temporary equity (convertible / redeemable, between liabilities and equity)", "B", "temp_equity"],
    ["equity", "Shareholders' equity", "B", "equity"],
    ["equity_nci", "Minority interest in equity", "f", "IF(N({equity_total})=0,0,{equity_total}-{equity})"],
    ["equity_total", "Total equity", "B", "equity_total"],
    ["retearn", "Retained earnings", "B", "retained_earnings"],
    ["debt", "Total debt = debtc + debtnc", "f", "{debtc}+{debtnc}"],
    ["h", "CASH FLOW (outflows negative)"],
    ["ncfo", "Cash from operations", "C", "cfo"],
    ["capex", "Capital expenditure", "Cn", "capex"],
    ["fcf", "Free cash flow = ncfo + capex", "f", "{ncfo}+{capex}"],
    ["ncfi", "Cash from investing", "C", "cfi"],
    ["ncff", "Cash from financing", "C", "cff"],
    ["sbcomp", "Stock-based compensation", "C", "sbc"],
    ["ncfdiv", "Dividends paid", "Cn", "dividends"],
    ["ncfbuyback", "Share buybacks", "Cn", "buybacks"],
    ["ncf_other", "FX & other cash movements (balancing)", "f", "IF(OR(N({cashneq})=0,{prev_cashneq}=\"\"),\"\",{cashneq}-{prev_cashneq}-{ncfo}-{ncfi}-{ncff})"],
    ["h", "CHECKS (OK = identity holds against the reported figure)"],
    ["chk_opinc", "opinc − reported operating income", "f", "IF({opinc_rep}=\"\",\"\",ROUND({opinc}-{opinc_rep},0))", "chk"],
    ["chk_ebt", "ebt − reported pre-tax income", "f", "IF({ebt_rep}=\"\",\"\",ROUND({ebt}-{ebt_rep},0))", "chk"],
    ["chk_bs", "assets − (liabilities + temporary equity + total equity)", "f", "IF(OR(N({assets})=0,N({liabilities})=0),\"\",ROUND({assets}-{liabilities}-{tempequity}-{equity_total},0))", "chk"],
    ["h", "REPORTED FIGURES USED FOR THE CHECKS"],
    ["opinc_rep", "Operating income (reported)", "P", "operating_income"],
    ["ebt_rep", "Pre-tax income (reported)", "P", "pretax_reported"],
    ["netinc_rep", "Net income to shareholders (reported)", "P", "net_profit"],
  ];
  function standardSheet(wb, result) {
    const old = wb.getWorksheet("Standard"); if (old) wb.removeWorksheet(old.id);
    const ws = wb.addWorksheet("Standard");
    const blk = { P: result.blocks.find((b) => b.title === "PROFIT & LOSS"), B: result.blocks.find((b) => b.title === "BALANCE SHEET"), C: result.blocks.find((b) => b.title === "CASH FLOW") };
    if (!blk.P) return;
    const ends = blk.P.ends.filter(Boolean);
    const valOf = (b, key, e) => { const B = blk[b]; if (!B) return null; const r = B.rows.find((x) => x.key === key); const i = B.ends.indexOf(e); return r && i >= 0 ? r.values[i] : null; };
    const filedOf = (e) => { const r = blk.P.rows.find((x) => x.key === "sales"); const i = blk.P.ends.indexOf(e); const f = r && r.src[i]; return f && f.filed ? f.filed : ""; };
    const C0 = 3, col = (j) => { let n = C0 + j, s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
    ws.getCell(1, 1).value = `${result.name} (${result.ticker}) - standard layout, ${result.scale === 1000 ? "$ thousands" : "$ millions"} (shares in thousands, EPS in $)`;
    ws.getCell(1, 1).font = { bold: true, size: 12 };
    ws.getCell(2, 1).value = "Same rows for every company. Blue = from the filings, black = formula. '(balancing)' lines make each subtotal match the company's reported total. Filed = latest filing behind that year (restated figures win).";
    ws.getCell(2, 1).font = { italic: true, size: 9, color: { argb: "FF666666" } };
    const H = 4;
    ws.getCell(H, 1).value = "Field"; ws.getCell(H, 2).value = "Definition";
    ws.getCell(H + 1, 2).value = "Filed";
    ends.forEach((e, j) => { const c = ws.getCell(H, C0 + j); c.value = asDate(e); c.numFmt = "mmm-yy"; ws.getCell(H + 1, C0 + j).value = filedOf(e); });
    ws.getRow(H).font = { bold: true }; ws.getRow(H + 1).font = { italic: true, size: 9, color: { argb: "FF666666" } };
    const rowOf = {}; let r = H + 2;
    for (const d of STD) { if (d[0] !== "h") rowOf[d[0]] = r; r++; }
    r = H + 2;
    for (const [code, label, kind, src, fmt] of STD) {
      if (code === "h") { r++; const c = ws.getCell(r - 1, 1); c.value = label; c.font = { bold: true, color: { argb: "FF1F3864" } }; continue; }
      ws.getCell(r, 1).value = code; ws.getCell(r, 1).font = { name: "Consolas", size: 10 };
      ws.getCell(r, 2).value = label;
      ends.forEach((e, j) => {
        const c = ws.getCell(r, C0 + j), L = col(j);
        if (kind === "f") {
          const f = src.replace(/\{(prev_)?(\w+)\}/g, (m, prev, k) => prev ? (j === 0 ? '""' : `${col(j - 1)}${rowOf[k]}`) : `${L}${rowOf[k]}`);
          c.value = { formula: f };
        } else {
          let v = valOf(kind[0], src, e);
          if (v != null && kind.length > 1) v = -v;                      // flip to the standard sign
          c.value = v; c.font = { color: { argb: "FF0000FF" } };
        }
        c.numFmt = fmt === "0.00" ? "0.00" : fmt === "chk" ? '#,##0;-#,##0;"OK"' : "#,##0;-#,##0;\"-\"";
      });
      if (["gp", "opinc", "ebt", "netinc", "assets", "liabilities", "equity_total", "fcf"].includes(code)) ws.getRow(r).font = { bold: true };
      r++;
    }
    ws.getColumn(1).width = 20; ws.getColumn(2).width = 58;
    ends.forEach((e, j) => (ws.getColumn(C0 + j).width = 13));
    ws.views = [{ state: "frozen", xSplit: 2, ySplit: H + 1 }];
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
      const ebit = sales == null ? null : sales - cogs - sga - rnd - num(src("other_opex"));
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
      const sales = PLv("sales")[i], eb = sales == null ? null : sales - num(PLv("cogs")[i]) - num(PLv("sga")[i]) - num(PLv("rnd")[i]) - num(PLv("other_opex")[i]);
      fpts.push({ d: e, shares: dil[i], equity: BSv("equity")[i], netDebt: BSv("total_assets")[i] == null ? null : num(BSv("st_debt")[i]) + num(BSv("lt_debt")[i]) - num(BSv("cash")[i]) - num(BSv("st_investments")[i]),
        ebitda: eb == null ? null : eb + num(CFv("dna")[i]), sales, da: num(CFv("dna")[i]), eps: fyEps[i] });
    });
    for (let i = 3; i < nq; i++) {
      let sales = 0, eb = 0, shs = 0;
      for (let j = i - 3; j <= i; j++) { const sv = q("sales")[j]; sales += num(sv); eb += num(sv) - num(q("cogs")[j]) - num(q("sga")[j]) - num(q("rnd")[j]) - num(q("other_opex")[j]); shs += num(q("shares_diluted")[j]) / 4; }
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
    const ni = (i) => { const v = P("net_profit")[i]; if (v != null) return v; const s = P("sales")[i]; return s == null ? null : s - z(P("cogs")[i]) - z(P("sga")[i]) - z(P("rnd")[i]) - z(P("other_opex")[i]) - z(P("interest")[i]) + z(P("other_income")[i]) - z(P("other_nonop")[i]) - z(P("tax")[i]); };
    const ebit = (i) => { const s = P("sales")[i]; return s == null ? null : s - z(P("cogs")[i]) - z(P("sga")[i]) - z(P("rnd")[i]) - z(P("other_opex")[i]); };
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

  const api = { detectBasis, detectSplits, dataChecks, standardSheet, compute, ratios, valuation, quality, prosCons, models, fiscalPeriods, dcf, reverseDcf, listTags, fillWorkbook, dataWorkbook, fmt, SECTIONS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.EdgarCore = api;
})(typeof window !== "undefined" ? window : this);

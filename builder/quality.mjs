/* Nightly data-quality report.
   - Runs core.dataChecks on every company and counts how many pass each check.
   - For lines left blank, lists the tags those companies DID report that look like the same line
     (the most common ones are the next tags to add to mapping.json).
   - Test set: a fixed list of companies whose key figures are compared with last night's run
     and with values checked by hand against their 10-Ks (state/test_set_expected.json). */
import fs from "node:fs";
import path from "node:path";

// rows we check for gaps, and what a candidate tag for each looks like
const GAP_ROWS = {
  "PROFIT & LOSS": {
    cogs: /^CostOf(Goods|Revenue|Services|GoodsAndServices)/,
    sga: /(SellingGeneralAndAdministrative|GeneralAndAdministrativeExpense|SellingAndMarketingExpense)/,
    rnd: /ResearchAndDevelopment/,
    interest: /^Interest(Expense|AndDebtExpense)/,
    depreciation: /^Depreciation|Amortization$/,
    tax: /^IncomeTaxExpense/,
    shares_diluted: /^WeightedAverage.*Diluted/,
  },
  "BALANCE SHEET": {
    cash: /^Cash/,
    st_investments: /(Marketable|ShortTermInvestments|AvailableForSale.*Current)/,
    receivables: /Receivable.*Current/,
    inventory: /^Inventor/,
    current_assets: /^AssetsCurrent/,
    current_liabilities: /^LiabilitiesCurrent/,
    lt_debt: /^LongTermDebt/,
  },
  "CASH FLOW": {
    cfo: /^NetCashProvidedByUsedInOperatingActivities/,
    capex: /^PaymentsToAcquire(PropertyPlantAndEquipment|ProductiveAssets)/,
    sbc: /(ShareBasedCompensation|StockBasedCompensation|AllocatedShareBasedCompensation)/,
    dividends: /^PaymentsOfDividends/,
    buybacks: /^PaymentsForRepurchaseOfCommonStock/,
  },
};

// the fixed test set: well-known companies across sectors and filing types
export const TEST_SET = ["GOOGL", "AAPL", "MSFT", "NVDA", "AMZN", "META", "WMT", "COST", "JPM", "BRK-B", "JNJ", "PFE",
  "XOM", "KO", "PG", "O", "TSLA", "NFLX", "INTC", "TSM"];
const KEY_LINES = [["PROFIT & LOSS", "sales", "Sales"], ["PROFIT & LOSS", "net_profit", "Net profit"], ["PROFIT & LOSS", "operating_income", "Operating income"],
  ["PROFIT & LOSS", "shares_diluted", "Diluted shares"], ["BALANCE SHEET", "total_assets", "Total assets"], ["BALANCE SHEET", "equity", "Equity"],
  ["CASH FLOW", "cfo", "Operating cash flow"]];

export function makeQuality(core, mapping) {
  const mapped = {};                                  // row key -> tags already in the mapping
  for (const [k, v] of Object.entries(mapping.items || {})) if (v && typeof v === "object") mapped[k] = new Set([...(v.tags || []), ...((v.groups || []).flatMap((g) => g.tags || [])), ...((v.components || []).flat())]);
  const totals = {}, failing = [], gaps = {}, testSet = {}, causes = {}, diags = {}, ratioHist = {};
  let companies = 0;

  function add(ticker, name, mcap, result, facts) {
    let dq;
    try { dq = core.dataChecks(result, facts); } catch { return; }
    companies++;
    for (const c of dq.checks) {
      const t = (totals[c.id] = totals[c.id] || { label: c.label, ok: 0, warn: 0, fail: 0, na: 0 });
      t[c.status]++;
    }
    // ratio patterns for EPS and share-count failures (where a single matching figure can't explain them)
    const bucket = (r) => r == null ? null : r < 0.002 ? "<1/500" : r < 0.1 ? "1/500–1/10" : r < 0.55 ? "1/10–0.55" : r < 0.95 ? "0.55–0.95" : r <= 1.05 ? "ok" : r < 1.8 ? "1.05–1.8" : r < 10 ? "1.8–10" : r < 500 ? "10–500" : ">500";
    for (const [id, r] of [["eps", dq.ratios && dq.ratios.eps], ["shares", dq.ratios && dq.ratios.shares]]) {
      const b = bucket(r); if (!b || b === "ok") continue;
      const h = (ratioHist[id] = ratioHist[id] || {}); const x = (h[b] = h[b] || { companies: 0, examples: [] });
      x.companies++; if (x.examples.length < 8) x.examples.push(`${ticker} ×${r.toPrecision(3)}`);
    }
    const fails = dq.checks.filter((c) => c.status === "fail").map((c) => c.id);
    if (fails.length) failing.push([ticker, mcap || 0, fails]);
    // group failures by the reported figure that explains the gap (company-specific tags grouped by their name without prefix)
    for (const c of dq.checks) {
      if (c.status !== "fail" && c.status !== "warn") continue;
      for (const k of new Set((c.causes || []).map((x) => x.tag.replace(/^[a-z0-9-]+:/, "*:")))) {
        const g = (causes[`${c.id}|${k}`] = causes[`${c.id}|${k}`] || { check: c.id, tag: k, companies: 0, sameSign: 0, examples: [] });
        g.companies++;
        const cz = (c.causes || []).find((x) => x.tag.replace(/^[a-z0-9-]+:/, "*:") === k);
        if (cz && Math.sign(cz.gap) === Math.sign(cz.val)) g.sameSign++;
        if (g.examples.length < 8) g.examples.push(cz ? `${ticker} ${cz.end.slice(0, 4)} gap ${Math.round(cz.gap)} tag ${Math.round(cz.val)}` : ticker);
      }
    }

    // gaps: blank line in a year the company has sales → which similar tags did it report for that year?
    const gaap = (facts.facts || {})["us-gaap"] || {};
    for (const [title, rows] of Object.entries(GAP_ROWS)) {
      const b = result.blocks.find((x) => x.title === title); if (!b) continue;
      for (const [key, re] of Object.entries(rows)) {
        const r = b.rows.find((x) => x.key === key); if (!r) continue;
        const blankEnds = b.ends.filter((e, i) => e && r.values[i] == null);
        if (!blankEnds.length) continue;
        const g = (gaps[key] = gaps[key] || { companies: 0, tags: {} });
        g.companies++;
        for (const [tag, node] of Object.entries(gaap)) {
          if (!re.test(tag) || (mapped[key] && mapped[key].has(tag))) continue;
          const hit = Object.values(node.units || {}).some((arr) => arr.some((f) => blankEnds.includes(f.end)));
          if (hit) g.tags[tag] = (g.tags[tag] || 0) + 1;
        }
      }
    }

    if (TEST_SET.includes(ticker)) {
      const vals = {};
      for (const [title, key, label] of KEY_LINES) {
        const b = result.blocks.find((x) => x.title === title); if (!b) continue;
        const r = b.rows.find((x) => x.key === key); if (!r) continue;
        b.ends.forEach((e, i) => { if (e && r.values[i] != null) vals[`${label} ${e}`] = r.values[i]; });
      }
      testSet[ticker] = { name, summary: dq.summary, checks: Object.fromEntries(dq.checks.map((c) => [c.id, c.status])), vals };
    }
  }

  // a test-set company that failed to build: record what revenue/profit tags it has, to see why
  function diag(ticker, facts, error) {
    if (!TEST_SET.includes(ticker)) return;
    const out = { error: String(error && error.message || error).slice(0, 200), tags: {} };
    for (const [ns, tags] of Object.entries(facts.facts || {})) for (const [tag, node] of Object.entries(tags)) {
      if (!/Revenue|Sales|NetIncomeLoss|ProfitLoss|IncomeLoss.*BeforeIncomeTax/i.test(tag)) continue;
      for (const [u, arr] of Object.entries(node.units || {})) {
        const fy = arr.filter((f) => f.fp === "FY" || /10-K|20-F|40-F/.test(f.form));
        out.tags[`${ns}:${tag} [${u}]`] = { facts: arr.length, annual: fy.length, forms: [...new Set(arr.map((f) => f.form))].slice(0, 6),
          latest: fy.sort((a, b) => (a.end < b.end ? 1 : -1)).slice(0, 2).map((f) => `${f.start || ""}→${f.end} ${f.val} ${f.form} fp=${f.fp}`) };
      }
    }
    out.entity = facts.entityName; out.namespaces = Object.keys(facts.facts || {});
    diags[ticker] = out;
  }

  function write(root, built) {
    const pctOk = (t) => { const n = t.ok + t.warn + t.fail; return n ? Math.round((t.ok / n) * 1000) / 10 : null; };
    const checks = Object.fromEntries(Object.entries(totals).map(([id, t]) => [id, { ...t, pctOk: pctOk(t) }]));
    const missingTags = Object.fromEntries(Object.entries(gaps).sort((a, b) => b[1].companies - a[1].companies)
      .map(([k, g]) => [k, { companiesWithGaps: g.companies, candidates: Object.entries(g.tags).sort((a, b) => b[1] - a[1]).slice(0, 6) }]));
    const worst = failing.sort((a, b) => b[1] - a[1]).slice(0, 40).map(([t, , f]) => `${t}: ${f.join(", ")}`);

    // test set: compare with last night and with hand-checked values
    const prevPath = path.join(root, "state/test_set.json"), expPath = path.join(root, "state/test_set_expected.json");
    let prev = {}, expected = {};
    try { prev = JSON.parse(fs.readFileSync(prevPath, "utf8")).companies || {}; } catch {}
    try { expected = JSON.parse(fs.readFileSync(expPath, "utf8")); } catch {}
    const changes = [], mismatches = [], statusChanges = [];
    for (const [t, cur] of Object.entries(testSet)) {
      const p = prev[t];
      if (p) {
        for (const [k, v] of Object.entries(cur.vals)) {
          const o = p.vals[k];
          if (o != null && Math.abs(v - o) > Math.max(1, 0.005 * Math.abs(o))) changes.push(`${t} ${k}: ${o.toLocaleString("en-US")} → ${v.toLocaleString("en-US")}`);
        }
        for (const [id, s] of Object.entries(cur.checks)) if (p.checks[id] && p.checks[id] !== s) statusChanges.push(`${t} ${id}: ${p.checks[id]} → ${s}`);
      }
      for (const [k, want] of Object.entries((expected[t] || {}).values || {})) {
        const got = cur.vals[k];
        if (got == null) mismatches.push(`${t} ${k}: missing (10-K says ${want.toLocaleString("en-US")})`);
        else if (Math.abs(got - want) > Math.max(1, 0.005 * Math.abs(want))) mismatches.push(`${t} ${k}: ${got.toLocaleString("en-US")} vs 10-K ${want.toLocaleString("en-US")}`);
      }
    }
    const missingFromRun = TEST_SET.filter((t) => !testSet[t]);
    const gapCauses = Object.values(causes).sort((a, b) => b.companies - a.companies).slice(0, 40);
    const report = { built, companies, checks, gapCauses, ratioPatterns: ratioHist, missingTags, worstFailing: worst, buildDiagnostics: diags,
      testSet: { companies: Object.keys(testSet).length, notBuilt: missingFromRun, changesSinceLastRun: changes.slice(0, 60), checkStatusChanges: statusChanges,
        mismatchesVs10K: mismatches, perCompany: Object.fromEntries(Object.entries(testSet).map(([t, v]) => [t, v.summary])) } };
    fs.writeFileSync(path.join(root, "state/data_quality.json"), JSON.stringify(report, null, 1));
    fs.writeFileSync(prevPath, JSON.stringify({ built, companies: testSet }, null, 1));
    return report;
  }
  return { add, write, diag };
}

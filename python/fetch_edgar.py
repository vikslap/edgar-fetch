#!/usr/bin/env python3
"""
fetch_edgar.py  -  Fill the 'Data Sheet' of your financial model from SEC EDGAR.

Usage:
    python fetch_edgar.py NFLX My_Model.xlsx
    python fetch_edgar.py AAPL My_Model.xlsx --out AAPL_Model.xlsx
    python fetch_edgar.py NFLX My_Model.xlsx --cache          # reuse downloaded JSON
    python fetch_edgar.py SOFI --list-tags interest           # find the right XBRL tags

Needs:  pip install openpyxl requests

What it does
  1. Ticker -> CIK, downloads companyfacts JSON from data.sec.gov (free, no key).
  2. For each line item in edgar_mapping.json, tries XBRL tags in order, per period.
  3. Keeps the latest-filed value for each period (so restatements win).
  4. Builds Q4 = full year - (Q1+Q2+Q3), because 10-Ks don't report Q4 alone.
  5. Adjusts share counts for splits listed in the mapping.
  6. Writes ONLY values into the Data Sheet (formulas elsewhere untouched):
       PROFIT & LOSS (annual), QUARTERS, BALANCE SHEET (annual), CASH FLOW (annual).
     Missing BALANCE SHEET / CASH FLOW sections are added at the bottom automatically.
  7. Adds an EDGAR_Raw sheet showing where every number came from.
"""
import argparse, copy, json, os, sys, time
from collections import defaultdict
from datetime import date, datetime, timedelta

import openpyxl

# ---- SEC asks every client to identify itself: put your name + email here ----
USER_AGENT = "YOUR NAME your@email.com"

ANNUAL_COLS = 9      # Data Sheet columns B..J hold annual data (K is left alone)
QUARTER_COLS = 10    # Data Sheet columns B..K hold quarterly data
FORMS = {"10-K", "10-K/A", "10-Q", "10-Q/A", "10-KT"}

SECTIONS = {         # mapping "section" -> Data Sheet block(s) it is written to
    "PL": [("PROFIT & LOSS", "annual"), ("QUARTERS", "quarterly")],
    "BS": [("BALANCE SHEET", "annual")],
    "CF": [("CASH FLOW", "annual")],
}

HERE = os.path.dirname(os.path.abspath(__file__))


# ----------------------------------------------------------------- download --
def http_json(url):
    import requests
    r = requests.get(url, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "gzip"}, timeout=60)
    r.raise_for_status()
    time.sleep(0.15)                      # stay well under SEC's 10 req/sec
    return r.json()


def get_facts(ticker, use_cache):
    cache_dir = os.path.join(HERE, "edgar_cache")
    os.makedirs(cache_dir, exist_ok=True)
    path = os.path.join(cache_dir, f"{ticker.upper()}.json")
    if use_cache and os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    if "your@email.com" in USER_AGENT:
        sys.exit("Edit USER_AGENT at the top of fetch_edgar.py first (SEC requires a name + email).")
    tickers = http_json("https://www.sec.gov/files/company_tickers.json")
    cik = next((v["cik_str"] for v in tickers.values() if v["ticker"].upper() == ticker.upper()), None)
    if cik is None:
        sys.exit(f"Ticker {ticker} not found in SEC's ticker list.")
    facts = http_json(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{int(cik):010d}.json")
    with open(path, "w") as f:
        json.dump(facts, f)
    return facts


# ------------------------------------------------------------------ periods --
def d(s):
    return datetime.strptime(s, "%Y-%m-%d").date()


def kind(start, end):
    if start is None:
        return "I"                                     # instant (balance sheet)
    days = (end - start).days + 1
    if 80 <= days <= 100:  return "Q"
    if 175 <= days <= 190: return "H"
    if 260 <= days <= 285: return "9M"
    if 350 <= days <= 380: return "FY"
    return None


def tag_series(facts, tag, unit):
    """{(kind, start, end): fact} keeping the latest-filed fact for each period."""
    node = facts.get("facts", {}).get("us-gaap", {}).get(tag)
    if not node:
        return {}
    out = {}
    for f in node.get("units", {}).get(unit, []):
        if f.get("form") not in FORMS:
            continue
        s = d(f["start"]) if "start" in f else None
        e = d(f["end"])
        k = kind(s, e)
        if not k:
            continue
        key = (k, s, e)
        if key not in out or f["filed"] > out[key]["filed"]:
            out[key] = {"val": f["val"], "tag": tag, "form": f["form"], "filed": f["filed"],
                        "accn": f.get("accn", ""), "derived": ""}
    return out


def merged_series(facts, tags, unit):
    """Per-period fallback: for each period, first tag in the list that has it."""
    out = {}
    for tag in tags:
        for key, f in tag_series(facts, tag, unit).items():
            out.setdefault(key, f)
    return out


def item_series(facts, spec):
    unit = spec.get("unit", "USD")
    s = merged_series(facts, spec.get("tags", []), unit)
    if spec.get("components"):
        parts = [merged_series(facts, comp, unit) for comp in spec["components"]]
        common = set.intersection(*[set(p) for p in parts]) if parts else set()
        for key in common:
            if key in s:
                continue
            fs = [p[key] for p in parts]
            s[key] = {"val": sum(f["val"] for f in fs), "tag": " + ".join(f["tag"] for f in fs),
                      "form": fs[0]["form"], "filed": max(f["filed"] for f in fs),
                      "accn": fs[0]["accn"], "derived": "sum of components"}
    if spec.get("negate"):
        for f in s.values():
            f["val"] = -f["val"]
    return s


def by_end(series, k):
    """{end_date: fact} for one period kind. If two starts share an end, latest filed wins."""
    out = {}
    for (kk, s, e), f in series.items():
        if kk == k and (e not in out or f["filed"] > out[e]["filed"]):
            out[e] = dict(f, start=s)
    return out


def near(a, b, tol=7):
    return abs((a - b).days) <= tol


def build_quarters(series, additive=True):
    """Discrete quarters by end date, with Q4 (or any missing quarter) derived from FY."""
    q = by_end(series, "Q")
    fy = by_end(series, "FY")
    nine = by_end(series, "9M")
    for fe, f in fy.items():
        if any(near(e, fe) for e in q):
            continue                                   # Q4 already reported
        fs = f["start"]
        inside = sorted(e for e in q if fs < e < fe - timedelta(days=7))
        val, how = None, ""
        if len(inside) >= 3:
            q123 = [q[e]["val"] for e in inside[-3:]]
            val = (f["val"] - sum(q123)) if additive else (4 * f["val"] - sum(q123))
            how = "FY - Q1-Q2-Q3" if additive else "4*FY - Q1-Q2-Q3 (approx. weighted avg)"
        else:
            ytd = next((n for e, n in nine.items() if near(n["start"], fs) and e < fe), None)
            if ytd and additive:
                val, how = f["val"] - ytd["val"], "FY - 9M YTD"
            elif ytd:
                val, how = 4 * f["val"] - 3 * ytd["val"], "4*FY - 3*9M avg (approx. weighted avg)"
        if val is not None:
            q[fe] = dict(f, val=val, derived=how)
    return q


def split_factor(filed, splits):
    fd = d(filed)
    factor = 1
    for when, ratio in splits:
        if fd < d(when):
            factor *= ratio
    return factor


# --------------------------------------------------------------- the sheet --
def find_title(ws, title):
    return next((r for r in range(1, ws.max_row + 1)
                 if str(ws.cell(r, 1).value or "").strip().upper() == title), None)


def ensure_section(ws, title, labels):
    """Add a section block at the bottom if the Data Sheet doesn't have it yet,
    copying the look of the PROFIT & LOSS block."""
    if find_title(ws, title):
        return
    tpl = find_title(ws, "PROFIT & LOSS")
    last = max(r for r in range(1, ws.max_row + 1)
               if any(ws.cell(r, c).value not in (None, "") for c in range(1, 15)))
    r0 = last + 3
    src = [tpl, tpl + 1, tpl + 2]                      # title, date row, first item row
    for i, text in enumerate([title, "Report Date"] + labels):
        srow = src[min(i, 2)]
        for c in range(1, 15):
            ws.cell(r0 + i, c)._style = copy.copy(ws.cell(srow, c)._style)
        ws.cell(r0 + i, 1).value = text
    print(f"  (added '{title}' section to the Data Sheet at row {r0})")


def find_section(ws, title):
    """Return (date_row, {label: row}) for a section like 'PROFIT & LOSS'."""
    start = find_title(ws, title)
    if start is None:
        sys.exit(f"Couldn't find '{title}' in column A of the Data Sheet.")
    date_row = start + 1
    rows, r = {}, date_row + 1
    while r <= ws.max_row and ws.cell(r, 1).value not in (None, ""):
        rows[str(ws.cell(r, 1).value).strip()] = r
        r += 1
    return date_row, rows


# --------------------------------------------------------------- list-tags --
def list_tags(facts, needle):
    """Print every us-gaap tag with its latest annual value - for fixing the mapping."""
    rows = []
    for tag, node in facts.get("facts", {}).get("us-gaap", {}).items():
        if needle and needle.lower() not in tag.lower() and needle.lower() not in (node.get("label") or "").lower():
            continue
        for unit, arr in node.get("units", {}).items():
            fy = [f for f in arr if f.get("form") in FORMS and
                  ("start" not in f or kind(d(f["start"]), d(f["end"])) == "FY")]
            if not fy:
                continue
            last = max(fy, key=lambda f: (f["end"], f["filed"]))
            first = min(f["end"] for f in fy)
            rows.append((last["end"], tag, unit, last["val"], first, node.get("label") or ""))
    rows.sort(key=lambda r: (r[0], abs(r[3])), reverse=True)
    print(f"{'latest FY end':<13} {'value':>20}  {'since':<10}  tag  (label)")
    for end, tag, unit, val, first, label in rows:
        print(f"{end:<13} {val:>20,.0f}  {first:<10}  {tag} [{unit}]  ({label})")


# -------------------------------------------------------------------- main --
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ticker")
    ap.add_argument("workbook", nargs="?")
    ap.add_argument("--out", help="output file (default: <workbook>_<TICKER>.xlsx)")
    ap.add_argument("--mapping", default=os.path.join(HERE, "edgar_mapping.json"))
    ap.add_argument("--cache", action="store_true", help="reuse edgar_cache/<TICKER>.json if present")
    ap.add_argument("--facts", help="path to a companyfacts JSON you already downloaded")
    ap.add_argument("--list-tags", nargs="?", const="", metavar="WORD",
                    help="print the company's XBRL tags (optionally only those containing WORD) and exit")
    a = ap.parse_args()
    t = a.ticker.upper()

    if a.facts:
        with open(a.facts) as f:
            facts = json.load(f)
    else:
        facts = get_facts(t, a.cache or a.list_tags is not None)
    if a.list_tags is not None:
        list_tags(facts, a.list_tags)
        return
    if not a.workbook:
        sys.exit("Give the workbook path, e.g.  python fetch_edgar.py NFLX My_Model.xlsx")

    with open(a.mapping) as f:
        cfg = json.load(f)
    items = {k: v for k, v in cfg["items"].items() if not k.startswith("_")}
    ov = cfg.get("overrides", {}).get(t, {})
    for k, v in ov.get("items", {}).items():
        items[k] = {**items.get(k, {}), **v}
    splits = ov.get("splits", [])
    scale = cfg.get("scale", 1000)
    name = facts.get("entityName", t)

    # ---- build every series ------------------------------------------------
    annual, quarterly = {}, {}
    for key, spec in items.items():
        if spec.get("plug") or spec.get("skip"):
            continue
        s = item_series(facts, spec)
        if spec.get("split_adjust") and splits:
            # adjust each raw fact BEFORE deriving Q4, so pre- and post-split
            # filings are on the same basis
            for f in s.values():
                m = split_factor(f["filed"], splits)
                if m != 1:
                    f["val"] *= m
                    f["derived"] = (f["derived"] + "; " if f["derived"] else "") + f"split x{m}"
        if spec.get("section") == "BS":
            annual[key] = by_end(s, "I")
            quarterly[key] = annual[key]
        else:
            annual[key] = by_end(s, "FY")
            quarterly[key] = build_quarters(s, spec.get("additive", True))

    chk = {}
    for ck, tags in cfg.get("checks", {}).items():
        if ck.startswith("_"):
            continue
        s = merged_series(facts, tags, "USD")
        chk[ck] = (by_end(s, "FY"), build_quarters(s))
    pretax = chk.get("pretax", ({}, {}))

    # period ends: driven by Sales
    a_ends = sorted(annual["sales"])[-ANNUAL_COLS:]
    q_ends = sorted(quarterly["sales"])[-QUARTER_COLS:]
    if not a_ends:
        sys.exit("No annual revenue found. Run with --list-tags revenue to find this company's tag.")

    def lookup(book, key, e):
        """Value for period e; balance-sheet dates can be a few days off the FY end."""
        b = book.get(key, {})
        if e in b:
            return b[e]
        return next((f for be, f in b.items() if near(be, e)), None)

    def plug(book, e):
        g = lambda k: (lookup(book, k, e) or {}).get("val", 0)
        p = pretax[0 if book is annual else 1].get(e)
        if not p:
            return None
        sheet_ebt = g("sales") - g("cogs") - g("sga") - g("rnd") - g("interest") + g("other_income")
        return sheet_ebt - p["val"]

    # ---- write --------------------------------------------------------------
    wb = openpyxl.load_workbook(a.workbook)
    ws = wb["Data Sheet"]
    ws["B1"] = name.upper()
    for sec, blocks in SECTIONS.items():
        labels = [v["label"] for v in items.values() if v.get("section", "PL") == sec]
        for title, _ in blocks:
            if sec != "PL":
                ensure_section(ws, title, labels)

    raw, missing, notes = [], defaultdict(list), []
    for sec, blocks in SECTIONS.items():
        sec_items = {k: v for k, v in items.items() if v.get("section", "PL") == sec}
        for title, freq in blocks:
            ends, book, ncols = (a_ends, annual, ANNUAL_COLS) if freq == "annual" else (q_ends, quarterly, QUARTER_COLS)
            date_row, rows = find_section(ws, title)
            for key, spec in sec_items.items():
                if spec["label"] not in rows:
                    notes.append(f"Label '{spec['label']}' not found under {title} - row not filled")
            for i in range(ncols):
                col = 2 + i
                e = ends[i] if i < len(ends) else None
                ws.cell(date_row, col).value = datetime(e.year, e.month, e.day) if e else None
                for key, spec in sec_items.items():
                    r = rows.get(spec["label"])
                    if r is None:
                        continue
                    cell = ws.cell(r, col)
                    if e is None:
                        cell.value = None
                        continue
                    if spec.get("skip"):
                        cell.value = 0
                        continue
                    if spec.get("plug"):
                        v = plug(book, e)
                        cell.value = round(v / scale, 2) if v is not None else None
                        if v is not None:
                            raw.append([title, spec["label"], e, round(v / scale, 2),
                                        "(plug vs reported pre-tax)", "", "", "", "calculated"])
                        continue
                    f = lookup(book, key, e)
                    if f is None:
                        cell.value = 0 if spec.get("optional") else None
                        missing[(title, spec["label"], bool(spec.get("optional")))].append(e)
                        continue
                    v = f["val"] / scale
                    cell.value = round(v, 2)
                    raw.append([title, spec["label"], e, round(v, 2), f["tag"], f["form"],
                                f["filed"], f["accn"], f["derived"]])

    # net-income sanity check
    ni_a = chk.get("net_income", ({}, {}))[0]
    for e in a_ends:
        p = pretax[0].get(e)
        tax = (annual.get("tax", {}).get(e) or {}).get("val", 0)
        if p and e in ni_a:
            diff = (p["val"] - tax) - ni_a[e]["val"]
            if abs(diff) > 0.01 * max(1, abs(ni_a[e]["val"])):
                notes.append(f"FY {e}: pre-tax minus tax differs from reported net income by "
                             f"{diff/scale:,.0f} (minority interest / discontinued ops / equity income?)")
    # balance sheet check
    for e in a_ends:
        A_ = lookup(annual, "total_assets", e); L_ = lookup(annual, "total_liabilities", e)
        E_ = lookup(annual, "equity_total", e) or lookup(annual, "equity", e)
        if A_ and L_ and E_ and abs(A_["val"] - L_["val"] - E_["val"]) > 0.005 * abs(A_["val"]):
            notes.append(f"BS {e}: assets - liabilities - equity = "
                         f"{(A_['val']-L_['val']-E_['val'])/scale:,.0f} (mezzanine equity / NCI?)")

    # audit sheet
    if "EDGAR_Raw" in wb.sheetnames:
        del wb["EDGAR_Raw"]
    rs = wb.create_sheet("EDGAR_Raw")
    rs.append([f"{name} ({t}) - pulled {date.today()} from data.sec.gov - values in USD / {scale:,} (shares / {scale:,})"])
    rs.append(["Section", "Line item", "Period end", "Value", "XBRL tag", "Form", "Filed", "Accession", "Derived"])
    for row in raw:
        rs.append(row)
    for c, w in zip("ABCDEFGHI", (14, 30, 12, 16, 60, 8, 12, 22, 34)):
        rs.column_dimensions[c].width = w
    for r in rs.iter_rows(min_row=3, min_col=3, max_col=3):
        r[0].number_format = "yyyy-mm-dd"

    out = a.out or os.path.splitext(a.workbook)[0] + f"_{t}.xlsx"
    wb.save(out)
    print(f"Saved {out}")
    print(f"  Annual:    {a_ends[0]} .. {a_ends[-1]}  ({len(a_ends)} years)")
    print(f"  Quarterly: {q_ends[0]} .. {q_ends[-1]}  ({len(q_ends)} quarters)")

    if missing or notes:
        print("\nCheck these:")
        quiet = defaultdict(list)
        for (title, label, optional), ends in sorted(missing.items()):
            span = f"{ends[0]}" if len(ends) == 1 else f"{len(ends)} periods, {ends[0]} .. {ends[-1]}"
            if optional:
                quiet[title].append(label if len(ends) >= ncols_of(title, len(a_ends), len(q_ends))
                                    else f"{label} ({span})")
            else:
                print(f"  - {title}: no value for '{label}' ({span})"
                      f"  -> try: python fetch_edgar.py {t} --list-tags <word>")
        for n in notes:
            print("  -", n)
        for title, labels in quiet.items():
            print(f"  - {title}, not reported by this company (set to 0): {', '.join(labels)}")


def ncols_of(title, n_annual, n_quarterly):
    return n_quarterly if title == "QUARTERS" else n_annual


if __name__ == "__main__":
    main()

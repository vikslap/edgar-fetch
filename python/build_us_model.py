"""Builds the US Stock Analysis model template (python/US_Analysis_Model.xlsx and public/US_Analysis_Model.xlsx).

Every analysis sheet is formulas off the "Data" sheet, which reads the latest 10 fiscal years out of the
"Standard" sheet. The site's "Analysis model" button rewrites only the Standard sheet inside this file,
so the charts and formatting survive.  Run:  python3 python/build_us_model.py
"""
import os
import shutil
from openpyxl import Workbook
from openpyxl.chart import BarChart, LineChart, Reference
from openpyxl.chart.layout import Layout, ManualLayout
from openpyxl.comments import Comment
from openpyxl.formatting.rule import CellIsRule, FormulaRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter as L
from openpyxl.worksheet.datavalidation import DataValidation

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "python", "US_Analysis_Model.xlsx")

F = "Arial"
NAVY, INK, MUTED, LINE, ZEBRA = "1F3864", "1F2937", "6B7280", "D9DEE7", "F4F6FA"
f_title = Font(name=F, size=15, bold=True, color=INK)
f_sub = Font(name=F, size=9, italic=True, color=MUTED)
f_hdr = Font(name=F, size=10, bold=True, color="FFFFFF")
f_sec = Font(name=F, size=10, bold=True, color=NAVY)
f_lab = Font(name=F, size=10, color=INK)
f_bold = Font(name=F, size=10, bold=True, color=INK)
f_val = Font(name=F, size=10, color="000000")
f_link = Font(name=F, size=10, color="008000")
f_in = Font(name=F, size=10, color="0000FF")
f_note = Font(name=F, size=9, color=MUTED)
fill_hdr = PatternFill("solid", fgColor=NAVY)
fill_in = PatternFill("solid", fgColor="FFF2CC")
fill_key = PatternFill("solid", fgColor="EEF2F8")
fill_sec = PatternFill("solid", fgColor="E8EDF6")
thin = Side(style="thin", color=LINE)
b_top = Border(top=Side(style="thin", color="9CA3AF"))

MONEY = '#,##0;(#,##0);"-"'
MONEY1 = '#,##0.0;(#,##0.0);"-"'
PCT = '0.0%;(0.0%);"-"'
MULT = '0.0"x";(0.0"x");"-"'
DAYS = '0;(0);"-"'
EPS = '0.00;(0.00);"-"'
YEARS = 10
YC = [L(3 + i) for i in range(YEARS)]          # C..L: oldest -> latest
LAST, PREV = YC[-1], YC[-2]
CUR = "M"                                        # "current / TTM" column on some sheets

wb = Workbook()
wb.remove(wb.active)


def sheet(name, title, subtitle, tab=None, widths=None):
    ws = wb.create_sheet(name)
    ws.sheet_view.showGridLines = False
    ws["A1"] = f'=IF(Data!$C$2="","{title}",Data!$C$2&"  ·  {title}")' if name not in ("Read Me", "Data", "QData", "Standard") else title
    ws["A1"].font = f_title
    ws["A2"] = subtitle
    ws["A2"].font = f_sub
    ws.column_dimensions["A"].width = (widths or {}).get("A", 40)
    ws.column_dimensions["B"].width = (widths or {}).get("B", 2)
    for c in YC + [CUR, "N", "O"]:
        ws.column_dimensions[c].width = (widths or {}).get(c, 11)
    if tab:
        ws.sheet_properties.tabColor = tab
    ws.page_setup.orientation = "landscape"
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 1
    return ws


def year_header(ws, r, label="$ millions", current=None, cols=None, src="Data!{c}$6"):
    ws.cell(r, 1, label).font = f_hdr
    ws.cell(r, 1).fill = fill_hdr
    ws.cell(r, 2).fill = fill_hdr
    for i, c in enumerate(cols or YC):
        x = ws[f"{c}{r}"]
        x.value = "=" + (src(c, i) if callable(src) else src.format(c=c))
        x.font = f_hdr
        x.fill = fill_hdr
        x.alignment = Alignment(horizontal="right")
    if current:
        x = ws[f"{CUR}{r}"]
        x.value = current
        x.font = f_hdr
        x.fill = PatternFill("solid", fgColor="374151")
        x.alignment = Alignment(horizontal="right")


def section(ws, r, text, cols=None):
    ws.cell(r, 1, text).font = f_sec
    for c in ["A", "B"] + (cols or YC):
        ws[f"{c}{r}"].fill = fill_sec


def row(ws, r, label, fn, fmt=MONEY, bold=False, note=None, cur=None, cur_fmt=None, font=None, cols=None):
    """fn(col_letter, index) -> formula string (without '='), or None to leave blank."""
    cols = cols or YC
    a = ws.cell(r, 1, label)
    a.font = f_bold if bold else f_lab
    if note:
        a.comment = Comment(note, "Model")
    for i, c in enumerate(cols):
        f = fn(c, i)
        if f is None:
            continue
        x = ws[f"{c}{r}"]
        x.value = "=" + f
        x.number_format = fmt
        x.font = font or (f_bold if bold else f_val)
    if cur:
        x = ws[f"{CUR}{r}"]
        x.value = "=" + cur
        x.number_format = cur_fmt or fmt
        x.font = f_bold
        x.fill = fill_key
    if bold:
        for c in ["A"] + cols:
            ws[f"{c}{r}"].border = b_top
    return r


def safe_div(num, den):
    return f'IF(OR(N({den})=0,{num}=""),"",{num}/{den})'


def pos_div(num, den):        # only when the denominator is positive (P/E on a loss is meaningless)
    return f'IF(OR(N({den})<=0,{num}=""),"",{num}/{den})'


_cd = {"ws": None, "row": 2, "cats": {}}


def chart_rows(srcs, cols=None, cat_src="Data!{c}6"):
    """Copy charted rows to the hidden ChartData sheet as numbers or #N/A, so blank years and meaningless ratios
    are gaps in the chart instead of drops to zero. srcs = [(sheet, row)]. Returns (category row, [ChartData rows])."""
    cols = cols or YC
    if _cd["ws"] is None:
        cdw = wb.create_sheet("ChartData")
        cdw.sheet_state = "hidden"
        _cd["ws"] = cdw
    cdw = _cd["ws"]
    key = (cat_src if isinstance(cat_src, str) else cat_src.__name__, len(cols))
    if key not in _cd["cats"]:                          # one category row per column set
        rr = _cd["row"]
        cdw[f"A{rr}"] = "Period"
        for i, c in enumerate(cols):
            cdw[f"{L(3 + i)}{rr}"] = "=" + (cat_src(c, i) if callable(cat_src) else cat_src.format(c=c))
        _cd["cats"][key] = rr
        _cd["row"] += 1
    out = []
    for ws, r in srcs:
        rr = _cd["row"]
        ref = f"'{ws.title}'!"
        cdw[f"A{rr}"] = f"={ref}A{r}"
        for i, c in enumerate(cols):
            cdw[f"{L(3 + i)}{rr}"] = f"=IF(ISNUMBER({ref}{c}{r}),{ref}{c}{r},NA())"
        out.append(rr)
        _cd["row"] += 1
    return _cd["cats"][key], out


def chart(ws, kind, title, rows, anchor, cat_row=None, y_fmt=None, stacked=False, width=17, height=7.5, y_title=None, host=None,
          cols=None, cat_src="Data!{c}6"):
    """rows: row numbers on ws, or (sheet, row) pairs. host: sheet the chart is placed on (default ws).
    cols: the columns the rows use on their sheet (default the 10 year columns); cat_src: where the period labels come from."""
    cols = cols or YC
    n = len(cols)
    srcs = [r if isinstance(r, tuple) else (ws, r) for r in rows]
    catrow, cdrows = chart_rows(srcs, cols, cat_src)
    cdw = _cd["ws"]
    ch = LineChart() if kind == "line" else BarChart()
    if kind == "bar":
        ch.type = "col"
        ch.gapWidth = 60
        if stacked:
            ch.grouping = "stacked"
            ch.overlap = 100
    ch.title = title
    ch.style = 10
    ch.height, ch.width = height, width
    for r in cdrows:
        ch.add_data(Reference(cdw, min_col=1, max_col=3 + n - 1, min_row=r, max_row=r), from_rows=True, titles_from_data=True)
    for s in ch.series:
        s.val.numRef.f = s.val.numRef.f.replace("$B$", "$C$")
        if kind == "line":
            s.smooth = False
            s.marker.symbol = "circle"
            s.marker.size = 5
    ch.set_categories(Reference(cdw, min_col=3, max_col=3 + n - 1, min_row=catrow, max_row=catrow))
    ch.display_blanks = "gap"
    if y_fmt:
        ch.y_axis.numFmt = y_fmt
    if y_title:
        ch.y_axis.title = y_title
    ch.x_axis.delete = False
    ch.y_axis.delete = False
    ch.legend.position = "b"
    (host or ws).add_chart(ch, anchor)
    return ch


# =====================================================================================  Read Me
rm = sheet("Read Me", "US Stock Analysis Model", "Built for US-listed companies · filled by EDGAR Fetch from SEC filings", tab="374151",
           widths={"A": 26, "B": 100})
rm.column_dimensions["B"].width = 100
lines = [
    ("How to fill it", "Open any company on EDGAR Fetch and click “Analysis model”. You get this workbook with that company's data, recalculated when it opens. "
                       "Only the Standard sheet is written; everything else is formulas, so your own edits to other sheets survive as long as you keep the layout."),
    ("Where the numbers come from", "SEC XBRL filings (10-K / 10-Q / 20-F), standardised the same way for every company. The Standard sheet lists each line with its definition; "
                                    "'(balancing)' lines make subtotals match the company's own reported totals. Prices and the 10-year Treasury come from the site's price feed."),
    ("Units", "$ millions unless stated. Shares in millions. EPS and prices in $. Fiscal years (up to the latest 10) and quarters (the latest 12)."),
    ("Sheets", "Summary · Margins · Returns & DuPont · Leverage & Working Capital · Cash Flow · Growth · Quarterly · Due Diligence · Unit Metrics · "
               "Valuation · DCF · Valuation Simulation · Notes. Data and QData = the latest 10 years and 16 quarters pulled from Standard (don't edit). "
               "Standard = the raw input written by the site."),
    ("Your inputs", "The yellow cells (blue numbers) on the DCF and Valuation Simulation sheets, and your answers on Notes. Every other cell is a formula."),
    ("Quarterly figures", "From 10-Qs; the fourth quarter is the full year minus the first nine months. Companies filing 20-F (most foreign companies) "
                          "don't file quarterly in XBRL, so the Quarterly sheet stays empty for them."),
    ("Blank cells", "A blank means the company didn't report that figure for that year (or has fewer than 10 years of filings). "
                    "Ratios are left blank instead of showing a misleading number, e.g. P/E when earnings are negative."),
    ("Check before you rely on it", "Look at the Data checks badge on the company's page on EDGAR Fetch. If a year is flagged there, treat that year here with care too."),
    ("Not designed for", "Banks, insurers and REITs: their statements don't fit the industrial layout (no gross margin, interest is revenue, FFO not EPS), "
                         "so several ratios here won't mean much for them."),
    ("Education only", "This model reproduces reported figures and standard ratios. It is not investment advice."),
]
r = 4
for k, v in lines:
    rm.cell(r, 1, k).font = f_bold
    rm.cell(r, 1).alignment = Alignment(vertical="top")
    c = rm.cell(r, 2, v)
    c.font = f_lab
    c.alignment = Alignment(wrap_text=True, vertical="top")
    rm.row_dimensions[r].height = 46
    r += 1

# =====================================================================================  Standard (input)
st = wb.create_sheet("Standard")
st.sheet_properties.tabColor = "9CA3AF"
st["A1"] = "Standard: input sheet written by EDGAR Fetch (click “Analysis model” on any company page). Empty until filled."
st["A1"].font = f_bold
st["A4"] = "Field"
st["B4"] = "Definition"
st.column_dimensions["A"].width = 20
st.column_dimensions["B"].width = 58

# =====================================================================================  Data (helper)
FIELDS = [
    ("h", "Income statement"),
    ("revenue", "Revenue", 1000), ("cor", "Cost of revenue", 1000), ("gp", "Gross profit", 1000), ("sgna", "SG&A", 1000),
    ("rnd", "R&D", 1000), ("opex_other", "Other operating costs", 1000), ("opinc", "Operating income (EBIT)", 1000),
    ("intexp", "Interest expense", 1000), ("nonop", "Other income (net)", 1000), ("nonop_other", "Other non-operating (balancing)", 1000),
    ("ebt", "Pre-tax income", 1000), ("taxexp", "Income tax", 1000), ("netincdis", "Discontinued operations", 1000),
    ("netincnci", "Minority share", 1000), ("netinc", "Net income to shareholders", 1000), ("shareswadil", "Diluted shares (m)", 1000),
    ("epsdil", "Diluted EPS ($)", 1), ("depamor", "Depreciation & amortisation", 1000), ("ebitda", "EBITDA", 1000),
    ("h", "Balance sheet"),
    ("cashneq", "Cash & equivalents", 1000), ("investmentsc", "Short-term investments", 1000), ("receivables", "Receivables", 1000),
    ("inventory", "Inventory", 1000), ("assetsc", "Current assets", 1000), ("ppnenet", "PP&E (net)", 1000), ("goodwill", "Goodwill", 1000),
    ("intangibles", "Intangibles", 1000), ("assets", "Total assets", 1000), ("payables", "Accounts payable", 1000), ("debtc", "Short-term debt", 1000),
    ("liabilitiesc", "Current liabilities", 1000), ("debtnc", "Long-term debt", 1000), ("liabilities", "Total liabilities", 1000),
    ("tempequity", "Temporary equity", 1000), ("equity", "Shareholders' equity", 1000), ("equity_nci", "Minority interest (equity)", 1000),
    ("equity_total", "Total equity", 1000), ("retearn", "Retained earnings", 1000), ("debt", "Total debt", 1000),
    ("h", "Cash flow (outflows negative)"),
    ("ncfo", "Operating cash flow", 1000), ("capex", "Capital expenditure", 1000), ("fcf", "Free cash flow", 1000), ("ncfi", "Investing cash flow", 1000),
    ("ncff", "Financing cash flow", 1000), ("sbcomp", "Stock-based compensation", 1000), ("ncfdiv", "Dividends paid", 1000), ("ncfbuyback", "Share buybacks", 1000),
    ("h", "Market"),
    ("price_fy", "Share price at fiscal year end ($)", 1), ("mcap_fy", "Market cap at fiscal year end", 1000),
]
SINGLE = [("price", "Current share price ($)", 1, EPS), ("price_date", "Price date", None, "@"), ("shares_now", "Shares outstanding now (m)", 1000, MONEY1),
          ("mcap_now", "Market cap now", 1000, MONEY), ("rf", "10-year Treasury yield", 1, "0.00%"), ("ttm_basis", "TTM basis", None, "@"),
          ("ttm_revenue", "Revenue, TTM", 1000, MONEY), ("ttm_ebit", "Operating income, TTM", 1000, MONEY), ("ttm_netinc", "Net income, TTM", 1000, MONEY),
          ("ttm_eps", "Diluted EPS, TTM ($)", 1, EPS)]

dt = sheet("Data", "Data: latest 10 fiscal years from the Standard sheet ($ millions)", "Formulas only. Don't edit; the analysis sheets read from here.", tab="9CA3AF")
dt.column_dimensions["A"].width = 16
dt.column_dimensions["B"].width = 34
dt["A2"] = "Company"
dt["A2"].font = f_bold
dt["C2"] = '=IFERROR(LEFT(Standard!$A$1,FIND(" - standard layout",Standard!$A$1)-1),"")'
dt["C2"].font = f_bold
dt["A3"], dt["C3"] = "Years available", "=COUNTA(Standard!$C$4:$AZ$4)"
dt["A4"] = "Column in Standard"
dt["A5"] = "Fiscal year end"
dt["A6"] = "Label"
for i, c in enumerate(YC):
    dt[f"{c}4"] = f"=$C$3-{YEARS - 1 - i}"
    dt[f"{c}5"] = f'=IF({c}4<1,"",INDEX(Standard!$C$4:$AZ$4,1,{c}4))'
    dt[f"{c}5"].number_format = "yyyy-mm-dd"
    dt[f"{c}6"] = f'=IF({c}5="","",IF(ISNUMBER({c}5),"FY"&TEXT({c}5,"yy")&" "&TEXT({c}5,"mmm"),""))'
    for rr in (4, 5, 6):
        dt[f"{c}{rr}"].font = f_note if rr != 6 else f_bold
for rr in (3, 4, 5, 6):
    dt[f"A{rr}"].font = f_lab
D = {}
r = 8
for fdef in FIELDS:
    if fdef[0] == "h":
        section(dt, r, fdef[1])
        r += 1
        continue
    code, label, div = fdef
    D[code] = r
    dt.cell(r, 1, code).font = Font(name="Consolas", size=9, color=MUTED)
    dt.cell(r, 2, label).font = f_lab
    for c in YC:
        x = dt[f"{c}{r}"]
        x.value = f'=IF({c}$4<1,"",IFERROR(INDEX(Standard!$C$1:$AZ$400,MATCH($A{r},Standard!$A$1:$A$400,0),{c}$4)/{div},""))'
        x.number_format = EPS if div == 1 else MONEY1
        x.font = f_link
    r += 1
r += 1
section(dt, r, "Current values")
r += 1
for code, label, div, fmt in SINGLE:
    D[code] = r
    dt.cell(r, 1, code).font = Font(name="Consolas", size=9, color=MUTED)
    dt.cell(r, 2, label).font = f_lab
    base = f"INDEX(Standard!$C$1:$C$400,MATCH($A{r},Standard!$A$1:$A$400,0))"
    dt[f"C{r}"] = f'=IFERROR({base}{"/" + str(div) if div and div != 1 else ""},"")' if div else f'=IFERROR({base}&"","")'
    dt[f"C{r}"].number_format = fmt
    dt[f"C{r}"].font = f_link
    r += 1
dt.freeze_panes = "C7"


def d(code, c):
    return f"Data!{c}{D[code]}"


def dv(code):
    return f"Data!$C${D[code]}"


def prevcol(c):
    return L(ord(c) - ord("A"))  # column before c (B for C)


def avg2(code, c, i):        # average of this and last year's balance (or this year's alone for the first column)
    return d(code, c) if i == 0 else f"AVERAGE({d(code, prevcol(c))},{d(code, c)})"


# =====================================================================================  Margins
mg = sheet("Margins", "Margins & cost structure", "How much of each dollar of revenue is left at each level, and where the costs go", tab="2A78D6")
r = 4
year_header(mg, r)
M = {}
r += 1
M["rev"] = row(mg, r, "Revenue", lambda c, i: d("revenue", c), bold=True); r += 1
M["gp"] = row(mg, r, "Gross profit", lambda c, i: f'IF(N({d("cor", c)})=0,"",{d("gp", c)})'); r += 1
M["ebitda"] = row(mg, r, "EBITDA", lambda c, i: d("ebitda", c)); r += 1
M["ebit"] = row(mg, r, "Operating income (EBIT)", lambda c, i: d("opinc", c)); r += 1
M["ebt"] = row(mg, r, "Pre-tax income", lambda c, i: d("ebt", c)); r += 1
M["ni"] = row(mg, r, "Net income", lambda c, i: d("netinc", c), bold=True); r += 2
section(mg, r, "Margins (% of revenue)"); r += 1
M["gm"] = row(mg, r, "Gross margin", lambda c, i: safe_div(f"{c}{M['gp']}", d("revenue", c)), PCT, note="Blank when the company doesn't report a cost of revenue (many service companies)."); r += 1
M["ebitdam"] = row(mg, r, "EBITDA margin", lambda c, i: safe_div(d("ebitda", c), d("revenue", c)), PCT); r += 1
M["opm"] = row(mg, r, "Operating margin", lambda c, i: safe_div(d("opinc", c), d("revenue", c)), PCT); r += 1
M["pbtm"] = row(mg, r, "Pre-tax margin", lambda c, i: safe_div(d("ebt", c), d("revenue", c)), PCT); r += 1
M["npm"] = row(mg, r, "Net margin", lambda c, i: safe_div(d("netinc", c), d("revenue", c)), PCT); r += 1
M["fcfm"] = row(mg, r, "Free cash flow margin", lambda c, i: safe_div(d("fcf", c), d("revenue", c)), PCT); r += 2
section(mg, r, "Cost structure (% of revenue)"); r += 1
M["c_cor"] = row(mg, r, "Cost of revenue", lambda c, i: safe_div(d("cor", c), d("revenue", c)), PCT); r += 1
M["c_sga"] = row(mg, r, "SG&A", lambda c, i: safe_div(d("sgna", c), d("revenue", c)), PCT); r += 1
M["c_rnd"] = row(mg, r, "R&D", lambda c, i: safe_div(d("rnd", c), d("revenue", c)), PCT); r += 1
M["c_oth"] = row(mg, r, "Other operating costs", lambda c, i: safe_div(d("opex_other", c), d("revenue", c)), PCT,
                 note="Fines, restructuring, impairments, or costs the company reports as one total. A big jump usually means a one-off: read that year's 10-K."); r += 1
M["c_da"] = row(mg, r, "Depreciation & amortisation (inside the costs above)", lambda c, i: safe_div(d("depamor", c), d("revenue", c)), PCT); r += 1
M["c_sbc"] = row(mg, r, "Stock-based compensation (inside the costs above)", lambda c, i: safe_div(d("sbcomp", c), d("revenue", c)), PCT); r += 2
section(mg, r, "Tax"); r += 1
M["tax"] = row(mg, r, "Effective tax rate", lambda c, i: pos_div(d("taxexp", c), d("ebt", c)), PCT); r += 1
chart(mg, "line", "Margins", [M["gm"], M["opm"], M["npm"], M["fcfm"]], "O4", 4, "0%")
chart(mg, "bar", "Cost structure (% of revenue)", [M["c_cor"], M["c_sga"], M["c_rnd"], M["c_oth"]], "O20", 4, "0%", stacked=True)
mg.freeze_panes = "C5"

# =====================================================================================  Returns & DuPont
rt = sheet("Returns", "Return ratios & DuPont", "Return on equity, capital employed and invested capital, and what drives ROE", tab="1BAF7A")
r = 4
year_header(rt, r)
R = {}
r += 1
R["ni"] = row(rt, r, "Net income", lambda c, i: d("netinc", c)); r += 1
R["eq"] = row(rt, r, "Average shareholders' equity", lambda c, i: avg2("equity", c, i)); r += 1
R["roe"] = row(rt, r, "Return on equity (ROE)", lambda c, i: pos_div(f"{c}{R['ni']}", f"{c}{R['eq']}"), PCT, bold=True,
               note="Net income ÷ average equity. Blank when equity is negative (heavy buybacks can do that), where ROE isn't meaningful."); r += 1
R["ta"] = row(rt, r, "Average total assets", lambda c, i: avg2("assets", c, i)); r += 1
R["roa"] = row(rt, r, "Return on assets (ROA)", lambda c, i: safe_div(f"{c}{R['ni']}", f"{c}{R['ta']}"), PCT); r += 1
R["ce"] = row(rt, r, "Capital employed (assets − current liabilities)", lambda c, i: f'IF({d("assets", c)}="","",{d("assets", c)}-N({d("liabilitiesc", c)}))'); r += 1
R["roce"] = row(rt, r, "Return on capital employed (ROCE)", lambda c, i: pos_div(d("opinc", c), f"{c}{R['ce']}"), PCT, bold=True); r += 1
R["tr"] = row(rt, r, "Tax rate used (effective, kept between 0% and 35%; 21% when pre-tax is a loss)",
              lambda c, i: f'IF({d("ebt", c)}="","",IF(N({d("ebt", c)})<=0,0.21,MAX(0,MIN(0.35,N({d("taxexp", c)})/{d("ebt", c)}))))', PCT); r += 1
R["nopat"] = row(rt, r, "NOPAT = EBIT × (1 − tax rate)", lambda c, i: f'IF({d("opinc", c)}="","",{d("opinc", c)}*(1-{c}{R["tr"]}))'); r += 1
R["ic"] = row(rt, r, "Invested capital = total equity + debt − cash − short-term investments",
              lambda c, i: f'IF({d("equity_total", c)}="","",{d("equity_total", c)}+N({d("debt", c)})-N({d("cashneq", c)})-N({d("investmentsc", c)}))'); r += 1
R["icavg"] = row(rt, r, "Average invested capital", lambda c, i: f"{c}{R['ic']}" if i == 0 else f"AVERAGE({prevcol(c)}{R['ic']},{c}{R['ic']})"); r += 1
R["roic"] = row(rt, r, "Return on invested capital (ROIC)", lambda c, i: pos_div(f"{c}{R['nopat']}", f"{c}{R['icavg']}"), PCT, bold=True); r += 2
section(rt, r, "DuPont: ROE = net margin × asset turnover × equity multiplier"); r += 1
R["npm"] = row(rt, r, "Net margin", lambda c, i: safe_div(d("netinc", c), d("revenue", c)), PCT); r += 1
R["at"] = row(rt, r, "Asset turnover (revenue ÷ average assets)", lambda c, i: safe_div(d("revenue", c), f"{c}{R['ta']}"), '0.00"x"'); r += 1
R["em"] = row(rt, r, "Equity multiplier (average assets ÷ average equity)", lambda c, i: pos_div(f"{c}{R['ta']}", f"{c}{R['eq']}"), '0.00"x"'); r += 1
R["dup"] = row(rt, r, "ROE (DuPont)", lambda c, i: f'IFERROR({c}{R["npm"]}*{c}{R["at"]}*{c}{R["em"]},"")', PCT, bold=True); r += 1
chart(rt, "line", "ROE, ROCE and ROIC", [R["roe"], R["roce"], R["roic"]], "O4", 4, "0%")
chart(rt, "line", "DuPont drivers", [R["at"], R["em"]], "O20", 4, "0.0")
rt.freeze_panes = "C5"

# =====================================================================================  Leverage & working capital
lv = sheet("Leverage", "Leverage & working capital", "How much debt the company carries, whether it can service it, and how much cash is tied up in operations", tab="EB6834")
r = 4
year_header(lv, r)
V = {}
r += 1
V["debt"] = row(lv, r, "Total debt", lambda c, i: d("debt", c)); r += 1
V["cash"] = row(lv, r, "Cash & short-term investments", lambda c, i: f'IF({d("cashneq", c)}="","",N({d("cashneq", c)})+N({d("investmentsc", c)}))'); r += 1
V["nd"] = row(lv, r, "Net debt (negative = net cash)", lambda c, i: f'IF({c}{V["cash"]}="","",N({c}{V["debt"]})-{c}{V["cash"]})', bold=True); r += 1
V["eq"] = row(lv, r, "Total equity", lambda c, i: d("equity_total", c)); r += 2
section(lv, r, "Ratios"); r += 1
V["de"] = row(lv, r, "Debt to equity", lambda c, i: pos_div(f"{c}{V['debt']}", f"{c}{V['eq']}"), '0.00"x"'); r += 1
V["ndeb"] = row(lv, r, "Net debt to EBITDA", lambda c, i: pos_div(f"{c}{V['nd']}", d("ebitda", c)), '0.0"x";(0.0"x");"-"',
                note="Below 0 means more cash than debt. Above 3x is high for most industries."); r += 1
V["ic"] = row(lv, r, "Interest coverage (EBIT ÷ interest)", lambda c, i: pos_div(d("opinc", c), d("intexp", c)), MULT); r += 1
V["cr"] = row(lv, r, "Current ratio", lambda c, i: pos_div(d("assetsc", c), d("liabilitiesc", c)), '0.00"x"'); r += 1
V["qr"] = row(lv, r, "Quick ratio (excluding inventory)", lambda c, i: f'IF(N({d("liabilitiesc", c)})<=0,"",(N({d("assetsc", c)})-N({d("inventory", c)}))/{d("liabilitiesc", c)})', '0.00"x"'); r += 1
V["ea"] = row(lv, r, "Equity ÷ total assets", lambda c, i: safe_div(f"{c}{V['eq']}", d("assets", c)), PCT); r += 2
section(lv, r, "Working capital"); r += 1
V["wc"] = row(lv, r, "Working capital (current assets − current liabilities)", lambda c, i: f'IF({d("assetsc", c)}="","",{d("assetsc", c)}-N({d("liabilitiesc", c)}))'); r += 1
V["wcs"] = row(lv, r, "Working capital % of revenue", lambda c, i: safe_div(f"{c}{V['wc']}", d("revenue", c)), PCT); r += 1
V["rd"] = row(lv, r, "Receivable days", lambda c, i: f'IF(OR(N({d("revenue", c)})=0,N({d("receivables", c)})=0),"",{d("receivables", c)}/{d("revenue", c)}*365)', DAYS); r += 1
V["id"] = row(lv, r, "Inventory days", lambda c, i: f'IF(OR(N({d("cor", c)})=0,N({d("inventory", c)})=0),"",{d("inventory", c)}/{d("cor", c)}*365)', DAYS); r += 1
V["pd"] = row(lv, r, "Payable days", lambda c, i: f'IF(OR(N({d("cor", c)})=0,N({d("payables", c)})=0),"",{d("payables", c)}/{d("cor", c)}*365)', DAYS); r += 1
V["ccc"] = row(lv, r, "Cash conversion cycle (receivable + inventory − payable days)",
               lambda c, i: f'IF(AND({c}{V["rd"]}="",{c}{V["id"]}=""),"",N({c}{V["rd"]})+N({c}{V["id"]})-N({c}{V["pd"]}))', DAYS, bold=True); r += 1
chart(lv, "line", "Debt to equity and net debt to EBITDA", [V["de"], V["ndeb"]], "O4", 4, "0.0")
chart(lv, "bar", "Working capital days", [V["rd"], V["id"], V["pd"]], "O20", 4, "0")
lv.freeze_panes = "C5"

# =====================================================================================  Cash flow
cf = sheet("Cash Flow", "Cash flow", "How much cash the business generates, what it reinvests, and what it returns to shareholders", tab="7C3AED")
r = 4
year_header(cf, r)
C = {}
r += 1
C["cfo"] = row(cf, r, "Operating cash flow", lambda c, i: d("ncfo", c), bold=True); r += 1
C["capex"] = row(cf, r, "Capital expenditure", lambda c, i: f'IF({d("capex", c)}="","",-{d("capex", c)})'); r += 1
C["fcf"] = row(cf, r, "Free cash flow", lambda c, i: d("fcf", c), bold=True); r += 1
C["sbc"] = row(cf, r, "Stock-based compensation", lambda c, i: d("sbcomp", c)); r += 1
C["fcfsbc"] = row(cf, r, "Free cash flow after stock-based compensation", lambda c, i: f'IF({d("fcf", c)}="","",{d("fcf", c)}-N({d("sbcomp", c)}))',
                  note="Stock-based pay is a real cost to shareholders (dilution) even though it isn't cash; many investors subtract it."); r += 1
C["ni"] = row(cf, r, "Net income", lambda c, i: d("netinc", c)); r += 2
section(cf, r, "Returned to shareholders"); r += 1
C["div"] = row(cf, r, "Dividends", lambda c, i: f'IF({d("ncfdiv", c)}="","",-{d("ncfdiv", c)})'); r += 1
C["bb"] = row(cf, r, "Share buybacks", lambda c, i: f'IF({d("ncfbuyback", c)}="","",-{d("ncfbuyback", c)})'); r += 1
C["tsr"] = row(cf, r, "Total returned", lambda c, i: f'IF(AND({c}{C["div"]}="",{c}{C["bb"]}=""),"",N({c}{C["div"]})+N({c}{C["bb"]}))', bold=True); r += 1
C["pay"] = row(cf, r, "Returned as % of free cash flow", lambda c, i: pos_div(f"{c}{C['tsr']}", f"{c}{C['fcf']}"), PCT); r += 2
section(cf, r, "Quality of cash flow"); r += 1
C["cfoe"] = row(cf, r, "Operating cash flow ÷ EBITDA", lambda c, i: pos_div(f"{c}{C['cfo']}", d("ebitda", c)), PCT); r += 1
C["conv"] = row(cf, r, "Free cash flow ÷ net income (cash conversion)", lambda c, i: pos_div(f"{c}{C['fcf']}", f"{c}{C['ni']}"), PCT,
                note="Consistently below ~80% means profits aren't turning into cash: check working capital and capex."); r += 1
C["capr"] = row(cf, r, "Capex % of revenue", lambda c, i: safe_div(f"{c}{C['capex']}", d("revenue", c)), PCT); r += 1
C["capd"] = row(cf, r, "Capex ÷ depreciation (above 1 = growing the asset base)", lambda c, i: pos_div(f"{c}{C['capex']}", d("depamor", c)), '0.00"x"'); r += 1
chart(cf, "bar", "Operating cash flow, free cash flow and net income", [C["cfo"], C["fcf"], C["ni"]], "O4", 4, "#,##0")
chart(cf, "bar", "Returned to shareholders", [C["div"], C["bb"]], "O20", 4, "#,##0", stacked=True)
cf.freeze_panes = "C5"

# =====================================================================================  Growth
gr = sheet("Growth", "Growth", "Year-on-year growth and compound annual growth rates (CAGR)", tab="D97706")
r = 4
year_header(gr, r)
G = {}
r += 1
GROW = [("rev", "Revenue", lambda c: d("revenue", c)), ("gp", "Gross profit", lambda c: f"Margins!{c}{M['gp']}"), ("ebitda", "EBITDA", lambda c: d("ebitda", c)),
        ("ebit", "Operating income", lambda c: d("opinc", c)), ("ni", "Net income", lambda c: d("netinc", c)), ("eps", "Diluted EPS", lambda c: d("epsdil", c)),
        ("cfo", "Operating cash flow", lambda c: d("ncfo", c)), ("fcf", "Free cash flow", lambda c: d("fcf", c)),
        ("bvps", "Book value per share", lambda c: f'IF(OR(N({d("shareswadil", c)})=0,{d("equity", c)}=""),"",{d("equity", c)}/{d("shareswadil", c)})'),
        ("sh", "Diluted shares (dilution if positive)", lambda c: d("shareswadil", c))]
section(gr, r, "Values"); r += 1
GV = {}
for k, lab, fn in GROW:
    GV[k] = row(gr, r, lab, lambda c, i, fn=fn: fn(c), EPS if k in ("eps", "bvps") else MONEY1 if k == "sh" else MONEY); r += 1
r += 1
section(gr, r, "Growth vs previous year"); r += 1
for k, lab, fn in GROW:
    G[k] = row(gr, r, lab, lambda c, i, k=k: None if i == 0 else
               f'IF(OR(N({prevcol(c)}{GV[k]})<=0,{c}{GV[k]}=""),"",{c}{GV[k]}/{prevcol(c)}{GV[k]}-1)', PCT); r += 1
r += 1
section(gr, r, "Compound annual growth (CAGR) to the latest year"); r += 1
CG_HDR = r
for j, (lab, n) in enumerate([("3 years", 3), ("5 years", 5), ("9 years", 9)]):
    x = gr.cell(r, 3 + j, lab)
    x.font = f_hdr
    x.fill = fill_hdr
    x.alignment = Alignment(horizontal="right")
gr.cell(r, 1, "").fill = fill_hdr
gr.cell(r, 2, "").fill = fill_hdr
r += 1
CG = {}
for k, lab, fn in GROW:
    gr.cell(r, 1, lab).font = f_lab
    for j, n in enumerate([3, 5, 9]):
        first = f"{YC[YEARS - 1 - n]}{GV[k]}"
        last = f"{LAST}{GV[k]}"
        x = gr.cell(r, 3 + j, f'=IF(OR(N({first})<=0,N({last})<=0),"",({last}/{first})^(1/{n})-1)')
        x.number_format = PCT
        x.font = f_val
    CG[k] = r
    r += 1
gr.cell(r, 1, "CAGR is blank when the start or end value is zero or negative (a growth rate isn't meaningful then).").font = f_note
chart(gr, "bar", "Revenue and EPS growth", [G["rev"], G["eps"]], "O4", 4, "0%")
gr.freeze_panes = "C5"

# =====================================================================================  Valuation
va = sheet("Valuation", "Valuation history", "Multiples at each fiscal year end, against today's price and trailing-12-month figures", tab="0E7490")
r = 4
year_header(va, r, current="Now (TTM)")
Q = {}
r += 1
Q["px"] = row(va, r, "Share price ($)", lambda c, i: d("price_fy", c), EPS, cur=dv("price"), cur_fmt=EPS); r += 1
Q["mc"] = row(va, r, "Market cap", lambda c, i: d("mcap_fy", c), cur=dv("mcap_now")); r += 1
Q["ev"] = row(va, r, "Enterprise value (market cap + debt − cash − ST investments + minority)",
              lambda c, i: f'IF({c}{Q["mc"]}="","",{c}{Q["mc"]}+N({d("debt", c)})-N({d("cashneq", c)})-N({d("investmentsc", c)})+N({d("equity_nci", c)}))',
              cur=f'IF({CUR}{Q["mc"]}="","",{CUR}{Q["mc"]}+N({d("debt", LAST)})-N({d("cashneq", LAST)})-N({d("investmentsc", LAST)})+N({d("equity_nci", LAST)}))'); r += 2
section(va, r, "Multiples"); r += 1
EBITDA_TTM = f'IF({dv("ttm_ebit")}="","",{dv("ttm_ebit")}+N({d("depamor", LAST)}))'
MULTS = [
    ("pe", "P/E", lambda c: pos_div(f"{c}{Q['mc']}", d("netinc", c)), pos_div(f"{CUR}{Q['mc']}", dv("ttm_netinc")), MULT),
    ("ps", "Price / sales", lambda c: pos_div(f"{c}{Q['mc']}", d("revenue", c)), pos_div(f"{CUR}{Q['mc']}", dv("ttm_revenue")), '0.00"x";(0.00"x");"-"'),
    ("pb", "Price / book", lambda c: pos_div(f"{c}{Q['mc']}", d("equity", c)), pos_div(f"{CUR}{Q['mc']}", d("equity", LAST)), '0.00"x";(0.00"x");"-"'),
    ("eve", "EV / EBITDA", lambda c: pos_div(f"{c}{Q['ev']}", d("ebitda", c)), pos_div(f"{CUR}{Q['ev']}", EBITDA_TTM), MULT),
    ("evb", "EV / EBIT", lambda c: pos_div(f"{c}{Q['ev']}", d("opinc", c)), pos_div(f"{CUR}{Q['ev']}", dv("ttm_ebit")), MULT),
    ("fy", "Free cash flow yield", lambda c: pos_div(d("fcf", c), f"{c}{Q['mc']}"), pos_div(d("fcf", LAST), f"{CUR}{Q['mc']}"), PCT),
    ("ey", "Earnings yield (inverse of P/E)", lambda c: pos_div(d("netinc", c), f"{c}{Q['mc']}"), pos_div(dv("ttm_netinc"), f"{CUR}{Q['mc']}"), PCT),
    ("dy", "Dividend yield", lambda c: f'IF(OR(N({c}{Q["mc"]})<=0,N({d("ncfdiv", c)})=0),"",-{d("ncfdiv", c)}/{c}{Q["mc"]})',
     f'IF(OR(N({CUR}{Q["mc"]})<=0,N({d("ncfdiv", LAST)})=0),"",-{d("ncfdiv", LAST)}/{CUR}{Q["mc"]})', PCT),
]
for k, lab, fn, curf, fmt in MULTS:
    Q[k] = row(va, r, lab, lambda c, i, fn=fn: fn(c), fmt, cur=curf, cur_fmt=fmt); r += 1
r += 1
section(va, r, "Where today sits against its own history (fiscal-year-end values)"); r += 1
STAT_HDR = r
for j, h in enumerate(["Low", "Median", "Average", "High", "Now", "Now vs median"]):
    x = va.cell(r, 3 + j, h)
    x.font = f_hdr
    x.fill = fill_hdr
    x.alignment = Alignment(horizontal="right")
va.cell(r, 1).fill = fill_hdr
va.cell(r, 2).fill = fill_hdr
r += 1
STATS = {}
for k, lab, fn, curf, fmt in MULTS:
    rng = f"$C${Q[k]}:${LAST}${Q[k]}"
    va.cell(r, 1, lab).font = f_lab
    for j, f in enumerate([f"MIN({rng})", f"MEDIAN({rng})", f"AVERAGE({rng})", f"MAX({rng})", f"{CUR}{Q[k]}"]):
        x = va.cell(r, 3 + j, f'=IFERROR(IF(COUNT({rng})=0,"",{f}),"")' if j < 4 else f"={f}")
        x.number_format = fmt
        x.font = f_val
    x = va.cell(r, 8, f'=IFERROR(IF(OR(G{r}="",D{r}=""),"",G{r}/D{r}-1),"")')
    x.number_format = '+0%;-0%;0%'
    x.font = f_bold
    STATS[k] = r
    r += 1
va.cell(r, 1, "For P/E, P/S, P/B and EV multiples, “now vs median” above 0% means more expensive than usual; for the yields it means cheaper.").font = f_note
r += 2
section(va, r, "Against the risk-free rate"); r += 1
va.cell(r, 1, "10-year US Treasury yield").font = f_lab
va.cell(r, 3, f'={dv("rf")}').number_format = "0.00%"
RF_ROW = r
r += 1
va.cell(r, 1, "Earnings yield now − Treasury yield").font = f_bold
x = va.cell(r, 3, f'=IF(OR({CUR}{Q["ey"]}="",C{RF_ROW}=""),"",{CUR}{Q["ey"]}-C{RF_ROW})')
x.number_format = '+0.0%;-0.0%;0.0%'
x.font = f_bold
va.cell(r, 4, "the extra return earnings give over a 'risk-free' bond").font = f_note
chart(va, "line", "P/E and EV/EBITDA at fiscal year end", [Q["pe"], Q["eve"]], "P4", 4, "0")
va.column_dimensions[CUR].width = 12
va.freeze_panes = "C5"

# =====================================================================================  DCF
dc = sheet("DCF", "Discounted cash flow (2-stage)", "Yellow cells are your assumptions. Everything else updates.", tab="B91C1C")
dc.column_dimensions["A"].width = 46
INP = {}
inputs = [
    ("base", "Starting free cash flow ($m)", f'=IF({d("fcf", LAST)}="","",{d("fcf", LAST)})', MONEY,
     "Default: latest fiscal year's free cash flow. Overwrite with a normalised figure if that year was unusual (see Cash Flow sheet)."),
    ("sbc", "Subtract stock-based compensation? (Yes/No)", "Yes", "@", "Yes treats stock-based pay as a cost (recommended for tech)."),
    ("g1", "Growth, years 1-5", f'=IFERROR(MIN(0.15,MAX(0.02,Growth!D{CG["rev"]})),0.06)', PCT,
     "Default: 5-year revenue CAGR, kept between 2% and 15%."),
    ("g2", "Growth, years 6-10", f"=B{7}/2", PCT, "Default: half of the first stage."),
    ("gt", "Terminal growth (forever)", 0.025, PCT, "Long-run growth after year 10; usually 2-3% (around nominal GDP)."),
    ("rf", "10-year Treasury yield", f'=IF(N({dv("rf")})=0,0.0425,{dv("rf")})', "0.00%", "From the site's price feed when the file was made."),
    ("erp", "Equity risk premium", 0.05, PCT, "Extra return investors demand from stocks over Treasuries; 4.5-5.5% is common."),
    ("beta", "Beta (risk vs the market)", 1.0, "0.00", "1 = market risk. Raise for riskier businesses, lower for very stable ones."),
    ("r", "Discount rate = Treasury + beta × premium", "=B10+B12*B11", PCT, None),
    ("nd", "Net debt incl. minority interest ($m)",
     f'=N({d("debt", LAST)})-N({d("cashneq", LAST)})-N({d("investmentsc", LAST)})+N({d("equity_nci", LAST)})', MONEY, "Latest balance sheet. Negative = net cash."),
    ("sh", "Shares outstanding (m)", f'=IF(N({dv("shares_now")})>0,{dv("shares_now")},{d("shareswadil", LAST)})', MONEY1, None),
    ("px", "Current share price ($)", f'={dv("price")}', EPS, None),
    ("mos", "Margin of safety", 0.25, PCT, "How far below fair value you'd want to buy."),
]
r = 5
dc.cell(4, 1, "Assumptions").font = f_sec
for k, lab, val, fmt, note in inputs:
    INP[k] = r
    dc.cell(r, 1, lab).font = f_lab
    x = dc.cell(r, 2, val)
    x.number_format = fmt
    if k in ("r",):
        x.font = f_bold
    elif k in ("nd", "sh", "px", "rf"):
        x.font = f_link
    else:
        x.font = f_in
        x.fill = fill_in
    if note:
        dc.cell(r, 1).comment = Comment(note, "Model")
    r += 1
dc.column_dimensions["B"].width = 14
dv_yes = DataValidation(type="list", formula1='"Yes,No"', allow_blank=False)
dc.add_data_validation(dv_yes)
dv_yes.add(f"B{INP['sbc']}")

r += 1
dc.cell(r, 1, "Projection").font = f_sec
r += 1
P_HDR = r
dc.cell(r, 1, "Year").font = f_hdr
dc.cell(r, 1).fill = fill_hdr
dc.cell(r, 2, 0).font = f_hdr
dc.cell(r, 2).fill = fill_hdr
for i, c in enumerate(YC):
    x = dc[f"{c}{r}"]
    x.value = i + 1
    x.font = f_hdr
    x.fill = fill_hdr
    x.alignment = Alignment(horizontal="right")
r += 1
P = {}
P["g"] = r
dc.cell(r, 1, "Growth").font = f_lab
for i, c in enumerate(YC):
    dc[f"{c}{r}"] = f"=$B${INP['g1']}" if i < 5 else f"=$B${INP['g2']}"
    dc[f"{c}{r}"].number_format = PCT
r += 1
P["fcf"] = r
dc.cell(r, 1, "Free cash flow ($m)").font = f_bold
base = f'IF($B${INP["sbc"]}="Yes",N($B${INP["base"]})-N({d("sbcomp", LAST)}),N($B${INP["base"]}))'
dc[f"B{r}"] = "=" + base
dc[f"B{r}"].number_format = MONEY
for i, c in enumerate(YC):
    dc[f"{c}{r}"] = f"={prevcol(c)}{r}*(1+{c}{P['g']})"
    dc[f"{c}{r}"].number_format = MONEY
    dc[f"{c}{r}"].font = f_bold
r += 1
P["df"] = r
dc.cell(r, 1, "Discount factor").font = f_lab
for i, c in enumerate(YC):
    dc[f"{c}{r}"] = f"=1/(1+$B${INP['r']})^{c}${P_HDR}"
    dc[f"{c}{r}"].number_format = "0.000"
r += 1
P["pv"] = r
dc.cell(r, 1, "Present value ($m)").font = f_lab
for i, c in enumerate(YC):
    dc[f"{c}{r}"] = f"={c}{P['fcf']}*{c}{P['df']}"
    dc[f"{c}{r}"].number_format = MONEY
r += 2
dc.cell(r, 1, "Value").font = f_sec
r += 1
OUTS = [
    ("pvsum", "Present value of 10 years of cash flow", f"=SUM(C{P['pv']}:{LAST}{P['pv']})", MONEY),
    ("tv", "Terminal value in year 10", f'=IF($B${INP["r"]}<=$B${INP["gt"]},"",{LAST}{P["fcf"]}*(1+$B${INP["gt"]})/($B${INP["r"]}-$B${INP["gt"]}))', MONEY),
    ("pvtv", "Present value of terminal value", f'=IF(B{{tv}}="","",B{{tv}}*{LAST}{P["df"]})', MONEY),
    ("ev", "Enterprise value", "=N(B{pvsum})+N(B{pvtv})", MONEY),
    ("eqv", "Equity value (after net debt)", f"=B{{ev}}-$B${INP['nd']}", MONEY),
    ("vps", "Fair value per share ($)", f'=IF(N($B${INP["sh"]})=0,"",B{{eqv}}/$B${INP["sh"]})', EPS),
    ("px", "Current share price ($)", f"=$B${INP['px']}", EPS),
    ("up", "Upside / (downside)", '=IF(OR(N(B{px})=0,B{vps}=""),"",B{vps}/B{px}-1)', '+0%;-0%;0%'),
    ("buy", "Buy below (fair value less margin of safety)", f'=IF(B{{vps}}="","",B{{vps}}*(1-$B${INP["mos"]}))', EPS),
    ("tvsh", "Terminal value share of enterprise value", '=IF(N(B{ev})=0,"",N(B{pvtv})/B{ev})', PCT),
]
O = {}
for k, *_ in OUTS:
    O[k] = r
    r += 1
for k, lab, f, fmt in OUTS:
    rr = O[k]
    dc.cell(rr, 1, lab).font = f_bold if k in ("vps", "up") else f_lab
    x = dc.cell(rr, 2, f.format(**O))
    x.number_format = fmt
    x.font = f_bold if k in ("vps", "up", "buy") else f_val
    if k in ("vps", "up"):
        dc.cell(rr, 1).fill = fill_key
        x.fill = fill_key
dc.cell(O["tvsh"], 3, "above ~75% means the answer depends mostly on the far future").font = f_note
r += 1

dc.cell(r, 1, "Sensitivity: fair value per share ($) by discount rate (rows) and terminal growth (columns)").font = f_sec
r += 1
S_HDR = r
dc.cell(r, 1, "Discount rate ↓  ·  terminal growth →").font = f_hdr
dc.cell(r, 1).fill = fill_hdr
dc.cell(r, 2).fill = fill_hdr
TG = [-0.01, -0.005, 0, 0.005, 0.01]
for j, dg in enumerate(TG):
    x = dc.cell(r, 3 + j, f"=$B${INP['gt']}+({dg})")
    x.number_format = PCT
    x.font = f_hdr
    x.fill = fill_hdr
r += 1
fr = f"$C${P['fcf']}:${LAST}${P['fcf']}"
yr = f"$C${P_HDR}:${LAST}${P_HDR}"
for k, dr in enumerate([-0.02, -0.01, 0, 0.01, 0.02]):
    x = dc.cell(r, 2, f"=$B${INP['r']}+({dr})")
    x.number_format = PCT
    x.font = f_bold
    for j in range(len(TG)):
        col = L(3 + j)
        rr_ = f"$B{r}"
        gg = f"{col}${S_HDR}"
        f = (f'=IF(OR({rr_}<={gg},N($B${INP["sh"]})=0),"",(SUMPRODUCT({fr},1/(1+{rr_})^{yr})'
             f'+${LAST}${P["fcf"]}*(1+{gg})/({rr_}-{gg})/(1+{rr_})^10-$B${INP["nd"]})/$B${INP["sh"]})')
        y = dc.cell(r, 3 + j, f)
        y.number_format = EPS
        y.font = f_val
        if dr == 0 and TG[j] == 0:
            y.fill = fill_key
            y.font = f_bold
    r += 1
SENS = (S_HDR + 1, r - 1)
dc.conditional_formatting.add(f"C{SENS[0]}:G{SENS[1]}", FormulaRule(formula=[f"AND(ISNUMBER(C{SENS[0]}),C{SENS[0]}>=$B${INP['px']})"],
                                                                      font=Font(color="15803D", bold=True)))
dc.cell(r, 1, "Green = at or above today's price.").font = f_note
r += 2
dc.cell(r, 1, "Education only: a DCF is only as good as its assumptions. Try the sensitivity table before trusting a single number.").font = f_note

# =====================================================================================  Summary
sm = sheet("Summary", "Summary", "The whole picture on one page. Details on the other sheets.", tab="111827")
sm.column_dimensions["A"].width = 30
for c in "CDEFGHI":
    sm.column_dimensions[c].width = 12
r = 4
facts = [("Share price ($)", f'={dv("price")}', EPS), ("Price date", f'={dv("price_date")}', "@"), ("Market cap ($m)", f'={dv("mcap_now")}', MONEY),
         ("Shares outstanding (m)", f'={dv("shares_now")}', MONEY1), ("P/E (TTM)", f"=Valuation!{CUR}{Q['pe']}", MULT),
         ("EV / EBITDA (TTM)", f"=Valuation!{CUR}{Q['eve']}", MULT), ("Free cash flow yield", f"=Valuation!{CUR}{Q['fy']}", PCT),
         ("10-year Treasury", f'={dv("rf")}', "0.00%"), ("DCF fair value ($)", f"=DCF!B{O['vps']}", EPS), ("DCF upside", f"=DCF!B{O['up']}", '+0%;-0%;0%'),
         ("Years of data", "=Data!$C$3", "0"), ("TTM basis", f'={dv("ttm_basis")}', "@")]
sm.cell(r, 1, "Snapshot").font = f_sec
r += 1
for j, (lab, f, fmt) in enumerate(facts):
    rr, cc = r + j % 6, 1 + (j // 6) * 4
    sm.cell(rr, cc, lab).font = f_lab
    x = sm.cell(rr, cc + 2, f)
    x.number_format = fmt
    x.font = f_bold
r += 7


def table(ws, r, title, cols, rows_):
    ws.cell(r, 1, title).font = f_sec
    r += 1
    ws.cell(r, 1).fill = fill_hdr
    ws.cell(r, 2).fill = fill_hdr
    for j, h in enumerate(cols):
        x = ws.cell(r, 3 + j, h)
        x.font = f_hdr
        x.fill = fill_hdr
        x.alignment = Alignment(horizontal="right")
    r += 1
    first = r
    for lab, fs, fmt in rows_:
        ws.cell(r, 1, lab).font = f_lab
        for j, f in enumerate(fs):
            x = ws.cell(r, 3 + j, f)
            x.number_format = fmt if isinstance(fmt, str) else fmt[j]
            x.font = f_val
        r += 1
    return r + 1, first


one_year = lambda k: f'=Growth!{LAST}{G[k]}'
r, _ = table(sm, r, "Growth (compound annual)", ["1 year", "3 years", "5 years", "9 years"],
             [(lab, [one_year(k)] + [f"=Growth!{L(3 + j)}{CG[k]}" for j in range(3)], PCT)
              for k, lab in [("rev", "Revenue"), ("ebitda", "EBITDA"), ("ebit", "Operating income"), ("ni", "Net income"), ("eps", "Diluted EPS"),
                             ("fcf", "Free cash flow"), ("bvps", "Book value per share")]])


def sum_last(sheetname, rr, n):
    return f"=SUM({sheetname}!{YC[YEARS - n]}{rr}:{LAST}{rr})"


r, _ = table(sm, r, "Totals over the period ($m)", ["Last year", "3 years", "5 years", "10 years"],
             [(lab, [f"={sh}!{LAST}{rr}"] + [sum_last(sh, rr, n) for n in (3, 5, 10)], MONEY)
              for lab, sh, rr in [("Revenue", "Margins", M["rev"]), ("Net income", "Margins", M["ni"]), ("Operating cash flow", "'Cash Flow'", C["cfo"]),
                                  ("Free cash flow", "'Cash Flow'", C["fcf"]), ("Capital expenditure", "'Cash Flow'", C["capex"]),
                                  ("Returned to shareholders", "'Cash Flow'", C["tsr"])]])
sm.cell(r - 1, 1, "Cash conversion over 10 years (free cash flow ÷ net income):").font = f_note
x = sm.cell(r - 1, 6, f"=IFERROR(F{r - 4}/F{r - 6},\"\")")
x.number_format = PCT
x.font = f_bold
r += 1


def kpi(lab, sh, rr, fmt):
    rng = f"{sh}!$C${rr}:${LAST}${rr}"
    return (lab, [f'=IFERROR(IF(COUNT({rng})=0,"",MIN({rng})),"")', f'=IFERROR(IF(COUNT({rng})=0,"",AVERAGE({rng})),"")',
                  f'=IFERROR(IF(COUNT({rng})=0,"",MAX({rng})),"")', f"={sh}!{LAST}{rr}"], fmt)


r, kfirst = table(sm, r, "Business quality (10-year range)", ["Low", "Average", "High", "Latest"],
                  [kpi("Gross margin", "Margins", M["gm"], PCT), kpi("Operating margin", "Margins", M["opm"], PCT), kpi("Net margin", "Margins", M["npm"], PCT),
                   kpi("Return on equity", "Returns", R["roe"], PCT), kpi("ROCE", "Returns", R["roce"], PCT), kpi("ROIC", "Returns", R["roic"], PCT),
                   kpi("Net debt / EBITDA", "Leverage", V["ndeb"], '0.0"x";(0.0"x");"-"'), kpi("Interest coverage", "Leverage", V["ic"], MULT),
                   kpi("Current ratio", "Leverage", V["cr"], '0.00"x"'), kpi("Cash conversion (FCF ÷ net income)", "'Cash Flow'", C["conv"], PCT)])
r, vfirst = table(sm, r, "Valuation against its own history", ["Low", "Median", "High", "Now", "vs median"],
                  [(lab, [f"=Valuation!C{STATS[k]}", f"=Valuation!D{STATS[k]}", f"=Valuation!F{STATS[k]}", f"=Valuation!G{STATS[k]}", f"=Valuation!H{STATS[k]}"],
                    [fmt, fmt, fmt, fmt, '+0%;-0%;0%'])
                   for k, lab, fmt in [("pe", "P/E", MULT), ("ps", "Price / sales", '0.00"x"'), ("pb", "Price / book", '0.00"x"'),
                                       ("eve", "EV / EBITDA", MULT), ("fy", "Free cash flow yield", PCT)]])
sm.cell(r - 1, 1, "Before relying on these numbers, check the Data checks badge on the company's EDGAR Fetch page.").font = f_note
chart(mg, "bar", "Revenue and net income ($m)", [M["rev"], M["ni"]], "K4", y_fmt="#,##0", width=16, host=sm)
chart(mg, "line", "Operating margin and ROE", [(mg, M["opm"]), (rt, R["roe"])], "K20", y_fmt="0%", width=16, host=sm)

# =====================================================================================  QData (quarterly helper)
QN = 16                                            # quarters pulled (12 shown + 4 earlier for year-on-year growth)
QDC = [L(3 + i) for i in range(QN)]                # C..R on QData, oldest -> latest
QS = 12                                            # quarters shown
QC = [L(3 + i) for i in range(QS)]                 # C..N on the Quarterly sheet
QLAST = QC[-1]
QFIELDS = [("q_revenue", "Revenue", 1000), ("q_cor", "Cost of revenue", 1000), ("q_gp", "Gross profit", 1000), ("q_sgna", "SG&A", 1000),
           ("q_rnd", "R&D", 1000), ("q_opex_other", "Other operating costs", 1000), ("q_opinc", "Operating income", 1000), ("q_intexp", "Interest expense", 1000),
           ("q_ebt", "Pre-tax income", 1000), ("q_taxexp", "Income tax", 1000), ("q_netinc", "Net income", 1000), ("q_shareswadil", "Diluted shares (m)", 1000),
           ("q_epsdil", "Diluted EPS ($)", 1)]
qd = sheet("QData", "QData: latest 16 quarters from the Standard sheet ($ millions)", "Formulas only. Don't edit; the Quarterly sheet reads from here.", tab="9CA3AF")
qd.column_dimensions["A"].width = 16
qd.column_dimensions["B"].width = 30
for c in QDC:
    qd.column_dimensions[c].width = 10
qd["A2"], qd["A3"] = "Row of q_date in Standard", "Quarters available"
qd["C2"] = '=IFERROR(MATCH("q_date",Standard!$A$1:$A$400,0),0)'
qd["C3"] = '=IF($C$2=0,0,COUNT(INDEX(Standard!$C$1:$CZ$400,$C$2,0)))'
qd["A4"], qd["A5"], qd["A6"] = "Column in Standard", "Quarter end", "Label"
for i, c in enumerate(QDC):
    qd[f"{c}4"] = f"=$C$3-{QN - 1 - i}"
    qd[f"{c}5"] = f'=IF({c}4<1,"",INDEX(Standard!$C$1:$CZ$400,$C$2,{c}4))'
    qd[f"{c}5"].number_format = "yyyy-mm-dd"
    qd[f"{c}6"] = f'=IF(ISNUMBER({c}5),TEXT({c}5,"mmm yy"),"")'
    qd[f"{c}6"].font = f_bold
for rr in range(2, 7):
    qd[f"A{rr}"].font = f_lab
QD = {}
r = 8
for code, label, div in QFIELDS:
    QD[code] = r
    qd.cell(r, 1, code).font = Font(name="Consolas", size=9, color=MUTED)
    qd.cell(r, 2, label).font = f_lab
    for c in QDC:
        x = qd[f"{c}{r}"]
        x.value = f'=IF({c}$4<1,"",IFERROR(INDEX(Standard!$C$1:$CZ$400,MATCH($A{r},Standard!$A$1:$A$400,0),{c}$4)/{div},""))'
        x.number_format = EPS if div == 1 else MONEY1
        x.font = f_link
    r += 1
r += 1
section(qd, r, "Trailing 12 months (sum of 4 quarters)", QDC)
r += 1
for code, label in [("q_revenue", "Revenue, TTM"), ("q_opinc", "Operating income, TTM"), ("q_netinc", "Net income, TTM"), ("q_epsdil", "Diluted EPS, TTM ($)")]:
    QD["ttm_" + code] = r
    qd.cell(r, 2, label).font = f_lab
    for i, c in enumerate(QDC):
        if i < 3:
            continue
        rng = f"{QDC[i - 3]}{QD[code]}:{c}{QD[code]}"
        x = qd[f"{c}{r}"]
        x.value = f'=IF(COUNT({rng})=4,SUM({rng}),"")'
        x.number_format = EPS if code == "q_epsdil" else MONEY1
    r += 1
qd.freeze_panes = "C7"


def q(code, c):
    """QData cell for Quarterly-sheet column c (C..N maps to QData G..R)."""
    return f"QData!{QDC[4 + QC.index(c)]}{QD[code]}"


def q4(code, c):
    """the same quarter a year earlier"""
    return f"QData!{QDC[QC.index(c)]}{QD[code]}"


def q1(code, c):
    """the previous quarter"""
    return f"QData!{QDC[3 + QC.index(c)]}{QD[code]}"


def growth(cur, old):
    return f'IF(OR(N({old})<=0,{cur}=""),"",{cur}/{old}-1)'


# =====================================================================================  Quarterly
qt = sheet("Quarterly", "Quarterly results", "The last 12 quarters: trend, margins, growth against the same quarter last year, and trailing-12-month figures", tab="0891B2")
for c in QC:
    qt.column_dimensions[c].width = 10
r = 4
year_header(qt, r, cols=QC, src=lambda c, i: f"QData!{QDC[4 + i]}$6")
QT = {}
r += 1
QT["rev"] = row(qt, r, "Revenue", lambda c, i: q("q_revenue", c), bold=True, cols=QC); r += 1
QT["gp"] = row(qt, r, "Gross profit", lambda c, i: f'IF(N({q("q_cor", c)})=0,"",{q("q_gp", c)})', cols=QC); r += 1
QT["ebit"] = row(qt, r, "Operating income", lambda c, i: q("q_opinc", c), cols=QC); r += 1
QT["ebt"] = row(qt, r, "Pre-tax income", lambda c, i: q("q_ebt", c), cols=QC); r += 1
QT["ni"] = row(qt, r, "Net income", lambda c, i: q("q_netinc", c), bold=True, cols=QC); r += 1
QT["eps"] = row(qt, r, "Diluted EPS ($)", lambda c, i: q("q_epsdil", c), EPS, cols=QC); r += 2
section(qt, r, "Margins", QC); r += 1
QT["gm"] = row(qt, r, "Gross margin", lambda c, i: safe_div(f"{c}{QT['gp']}", q("q_revenue", c)), PCT, cols=QC); r += 1
QT["opm"] = row(qt, r, "Operating margin", lambda c, i: safe_div(q("q_opinc", c), q("q_revenue", c)), PCT, cols=QC); r += 1
QT["npm"] = row(qt, r, "Net margin", lambda c, i: safe_div(q("q_netinc", c), q("q_revenue", c)), PCT, cols=QC); r += 1
QT["tax"] = row(qt, r, "Effective tax rate", lambda c, i: pos_div(q("q_taxexp", c), q("q_ebt", c)), PCT, cols=QC); r += 2
section(qt, r, "Growth vs the same quarter last year", QC); r += 1
QT["g_rev"] = row(qt, r, "Revenue", lambda c, i: growth(q("q_revenue", c), q4("q_revenue", c)), PCT, cols=QC); r += 1
QT["g_ebit"] = row(qt, r, "Operating income", lambda c, i: growth(q("q_opinc", c), q4("q_opinc", c)), PCT, cols=QC); r += 1
QT["g_ni"] = row(qt, r, "Net income", lambda c, i: growth(q("q_netinc", c), q4("q_netinc", c)), PCT, cols=QC); r += 1
QT["g_eps"] = row(qt, r, "Diluted EPS", lambda c, i: growth(q("q_epsdil", c), q4("q_epsdil", c)), PCT, cols=QC); r += 1
QT["d_opm"] = row(qt, r, "Change in operating margin (percentage points)",
                  lambda c, i: f'IF(OR(N({q4("q_revenue", c)})=0,N({q("q_revenue", c)})=0),"",{q("q_opinc", c)}/{q("q_revenue", c)}-{q4("q_opinc", c)}/{q4("q_revenue", c)})',
                  '+0.0%;-0.0%;0.0%', cols=QC); r += 2
section(qt, r, "Growth vs the previous quarter", QC); r += 1
QT["q_rev"] = row(qt, r, "Revenue", lambda c, i: growth(q("q_revenue", c), q1("q_revenue", c)), PCT, cols=QC,
                  note="Quarter-on-quarter growth mixes in seasonality. Compare with the same quarter last year above before drawing conclusions."); r += 1
QT["q_ni"] = row(qt, r, "Net income", lambda c, i: growth(q("q_netinc", c), q1("q_netinc", c)), PCT, cols=QC); r += 2
section(qt, r, "Trailing 12 months (TTM)", QC); r += 1
QT["t_rev"] = row(qt, r, "Revenue, TTM", lambda c, i: q("ttm_q_revenue", c), cols=QC); r += 1
QT["t_ebit"] = row(qt, r, "Operating income, TTM", lambda c, i: q("ttm_q_opinc", c), cols=QC); r += 1
QT["t_ni"] = row(qt, r, "Net income, TTM", lambda c, i: q("ttm_q_netinc", c), bold=True, cols=QC); r += 1
QT["t_eps"] = row(qt, r, "Diluted EPS, TTM ($)", lambda c, i: q("ttm_q_epsdil", c), EPS, cols=QC); r += 1
QT["t_opm"] = row(qt, r, "Operating margin, TTM", lambda c, i: safe_div(q("ttm_q_opinc", c), q("ttm_q_revenue", c)), PCT, cols=QC); r += 1
QT["t_g_rev"] = row(qt, r, "TTM revenue growth vs a year earlier", lambda c, i: growth(q("ttm_q_revenue", c), q4("ttm_q_revenue", c)), PCT, cols=QC); r += 1
QT["t_g_ni"] = row(qt, r, "TTM net income growth vs a year earlier", lambda c, i: growth(q("ttm_q_netinc", c), q4("ttm_q_netinc", c)), PCT, cols=QC); r += 2

# seasonality: the last 16 quarters as 4 blocks of 4, each block ending a year apart (aligned on the latest quarter)
section(qt, r, "Seasonality: revenue by quarter, each row a run of 4 quarters (aligned on the latest quarter)", QC); r += 1
SEAS_HDR = r
qt.cell(r, 1, "4 quarters ending").font = f_hdr
qt.cell(r, 1).fill = fill_hdr
qt.cell(r, 2).fill = fill_hdr
for j in range(4):
    x = qt.cell(r, 3 + j, f"=QData!{QDC[12 + j]}6")
    x.font, x.fill, x.alignment = f_hdr, fill_hdr, Alignment(horizontal="right")
for j, h in enumerate(["Total", "Last col %"]):
    x = qt.cell(r, 7 + j, h)
    x.font, x.fill, x.alignment = f_hdr, fill_hdr, Alignment(horizontal="right")
r += 1
for b in range(4):                                 # block 0 = oldest
    cols_ = QDC[4 * b: 4 * b + 4]
    qt.cell(r, 1, f'=IF(QData!{cols_[3]}5="","",TEXT(QData!{cols_[3]}5,"mmm yyyy"))').font = f_lab
    for j, c in enumerate(cols_):
        x = qt.cell(r, 3 + j, f'=IF(QData!{c}{QD["q_revenue"]}="","",QData!{c}{QD["q_revenue"]})')
        x.number_format = MONEY
        x.font = f_val
    x = qt.cell(r, 7, f'=IF(COUNT(C{r}:F{r})=4,SUM(C{r}:F{r}),"")')
    x.number_format, x.font = MONEY, f_bold
    x = qt.cell(r, 8, f'=IF(N(G{r})=0,"",F{r}/G{r})')
    x.number_format = PCT
    r += 1
qt.cell(r, 1, "If one column is always much bigger than the others, the business is seasonal: compare quarters with the same quarter a year earlier.").font = f_note
r += 2


def qlabel(c, i):
    return f"QData!{QDC[4 + i]}6"


chart(qt, "bar", "Quarterly revenue and net income ($m)", [QT["rev"], QT["ni"]], "P4", y_fmt="#,##0", cols=QC, cat_src=qlabel, width=18)
chart(qt, "line", "Quarterly margins", [QT["gm"], QT["opm"], QT["npm"]], "P20", y_fmt="0%", cols=QC, cat_src=qlabel, width=18)
chart(qt, "line", "Trailing-12-month revenue and net income ($m)", [QT["t_rev"], QT["t_ni"]], "P36", y_fmt="#,##0", cols=QC, cat_src=qlabel, width=18)
qt.freeze_panes = "C5"

# =====================================================================================  Due Diligence
dd = sheet("Due Diligence", "Due diligence: red-flag checks", "Ratios that often expose aggressive accounting, weak cash flow or hidden risk. 'Check' = latest year crosses the rule of thumb; read that part of the 10-K.", tab="BE123C")
dd.column_dimensions["A"].width = 58
dd.column_dimensions[CUR].width = 10
dd.column_dimensions["N"].width = 46
r = 4
year_header(dd, r, current="Latest")
dd.cell(r, 14, "Rule of thumb (when 'Check' appears)").font = f_hdr
dd.cell(r, 14).fill = fill_hdr
DD = {}
r += 1


def ddrow(key, label, fn, fmt, flag=None, rule="", note=None):
    """flag: formula on the latest-year cell X (string with {x}); True -> 'Check'."""
    global r
    DD[key] = row(dd, r, label, fn, fmt, note=note)
    x = dd[f"{CUR}{r}"]
    if flag:
        x.value = f'=IF({LAST}{r}="","",IF({flag.format(x=LAST + str(r))},"Check","OK"))'
    x.alignment = Alignment(horizontal="center")
    x.font = f_bold
    dd.cell(r, 14, rule).font = f_note
    r += 1


def yoy_gap(a, b, c, i):          # growth of a minus growth of b, this year vs last
    if i == 0:
        return None
    p = prevcol(c)
    return (f'IF(OR(N({d(a, p)})<=0,N({d(b, p)})<=0,{d(a, c)}="",{d(b, c)}=""),"",'
            f'({d(a, c)}/{d(a, p)}-1)-({d(b, c)}/{d(b, p)}-1))')


section(dd, r, "Earnings quality"); r += 1
ddrow("tax", "Effective tax rate", lambda c, i: pos_div(d("taxexp", c), d("ebt", c)), PCT, "OR({x}<0.1,{x}>0.35)",
      "Below 10% or above 35%: one-off tax items or profits booked in tax havens; check whether it can last.")
ddrow("oth", "Non-operating income ÷ pre-tax income", lambda c, i: f'IF(N({d("ebt", c)})<=0,"",(N({d("nonop", c)})+N({d("nonop_other", c)}))/{d("ebt", c)})', PCT,
      "ABS({x})>0.2", "More than ±20%: profit leans on interest income, investment gains or one-offs rather than the business.")
ddrow("bal", "Unexplained non-operating items ÷ pre-tax income", lambda c, i: f'IF(N({d("ebt", c)})<=0,"",{d("nonop_other", c)}/{d("ebt", c)})', PCT,
      "ABS({x})>0.1", "More than ±10%: a gain, loss or write-down sits below operating income. Find it in the 10-K income statement notes.")
ddrow("ooc", "Other operating costs ÷ revenue", lambda c, i: safe_div(d("opex_other", c), d("revenue", c)), PCT, "ABS({x})>0.05",
      "More than 5%: restructuring, impairments or legal charges. If they recur every year, they're not one-offs.")
ddrow("cfo", "Operating cash flow ÷ net income", lambda c, i: pos_div(d("ncfo", c), d("netinc", c)), PCT, "{x}<0.8",
      "Below 80%: profits aren't turning into cash. Look at receivables, inventory and capitalised costs.")
ddrow("acc", "Accruals ratio = (net income − operating cash flow) ÷ average assets",
      lambda c, i: f'IF(OR({d("netinc", c)}="",{d("ncfo", c)}=""),"",IFERROR(({d("netinc", c)}-{d("ncfo", c)})/{avg2("assets", c, i)},""))', PCT,
      "{x}>0.05", "Above 5%: earnings are running ahead of cash. Research links high accruals to weaker future returns.")
r += 1
section(dd, r, "Balance sheet"); r += 1
ddrow("rec", "Receivables growth minus revenue growth", lambda c, i: yoy_gap("receivables", "revenue", c, i), '+0.0%;-0.0%;0.0%', "{x}>0.1",
      "Receivables growing 10+ points faster than sales: customers paying slower, or sales pulled forward.")
ddrow("inv", "Inventory growth minus revenue growth", lambda c, i: yoy_gap("inventory", "revenue", c, i), '+0.0%;-0.0%;0.0%', "{x}>0.1",
      "Inventory growing 10+ points faster than sales: demand slowing or stock going obsolete.")
ddrow("gwa", "Goodwill + intangibles ÷ total assets", lambda c, i: safe_div(f'(N({d("goodwill", c)})+N({d("intangibles", c)}))', d("assets", c)), PCT,
      "{x}>0.4", "Above 40%: growth came from acquisitions; write-downs are possible if they disappoint.")
ddrow("gwe", "Goodwill + intangibles ÷ shareholders' equity", lambda c, i: pos_div(f'(N({d("goodwill", c)})+N({d("intangibles", c)}))', d("equity", c)), PCT,
      "{x}>1", "Above 100%: tangible equity is negative, so the balance sheet rests on acquired intangibles.")
ddrow("rate", "Interest ÷ average debt (implied interest rate)",
      lambda c, i: f'IF(OR({d("intexp", c)}="",N({avg2("debt", c, i)})<=0),"",{d("intexp", c)}/{avg2("debt", c, i)})', PCT, "{x}>0.1",
      "Above 10%: expensive or risky debt, or debt the balance sheet doesn't show (leases, off-balance-sheet).")
ddrow("cash", "Cash & short-term investments ÷ total debt",
      lambda c, i: pos_div(f'(N({d("cashneq", c)})+N({d("investmentsc", c)}))', d("debt", c)), PCT, "{x}<0.2",
      "Below 20%: little cash against the debt; check when the debt matures.")
ddrow("dgr", "Debt growth minus revenue growth", lambda c, i: yoy_gap("debt", "revenue", c, i), '+0.0%;-0.0%;0.0%', "{x}>0.25",
      "Debt growing 25+ points faster than sales: borrowing to fund growth, buybacks or dividends.")
ddrow("re", "Retained earnings ($m)", lambda c, i: d("retearn", c), MONEY, "{x}<0",
      "Negative: lifetime losses, or buybacks and dividends larger than lifetime profits. Normal for heavy buyback companies; a warning otherwise.")
r += 1
section(dd, r, "Shareholders"); r += 1
ddrow("dil", "Change in diluted share count",
      lambda c, i: None if i == 0 else growth(d("shareswadil", c), d("shareswadil", prevcol(c))), '+0.0%;-0.0%;0.0%', "{x}>0.02",
      "More than 2% a year: steady dilution from stock pay or share issues erodes your stake.")
ddrow("sbcr", "Stock-based compensation ÷ revenue", lambda c, i: safe_div(d("sbcomp", c), d("revenue", c)), PCT, "{x}>0.1",
      "Above 10%: a large real cost that adjusted (non-GAAP) earnings usually leave out.")
ddrow("sbcc", "Stock-based compensation ÷ operating cash flow", lambda c, i: pos_div(d("sbcomp", c), d("ncfo", c)), PCT, "{x}>0.25",
      "Above 25%: much of the reported cash flow comes from paying staff in shares instead of cash.")
ddrow("pay", "Dividends ÷ net income (payout ratio)",
      lambda c, i: f'IF(OR(N({d("netinc", c)})<=0,N({d("ncfdiv", c)})=0),"",-{d("ncfdiv", c)}/{d("netinc", c)})', PCT, "{x}>1",
      "Above 100%: paying out more than it earns. Fine for a year; a risk to the dividend if it persists.")
ddrow("tpay", "Dividends + buybacks ÷ free cash flow",
      lambda c, i: f'IF(OR(N({d("fcf", c)})<=0,N({d("ncfdiv", c)})+N({d("ncfbuyback", c)})=0),"",-(N({d("ncfdiv", c)})+N({d("ncfbuyback", c)}))/{d("fcf", c)})', PCT,
      "{x}>1.2", "Above 120%: shareholder returns funded with debt or cash reserves.")
dd.conditional_formatting.add(f"{CUR}5:{CUR}{r}", CellIsRule(operator="equal", formula=['"Check"'], fill=PatternFill("solid", fgColor="FDE2E1"),
                                                             font=Font(name=F, bold=True, color="B91C1C")))
dd.conditional_formatting.add(f"{CUR}5:{CUR}{r}", CellIsRule(operator="equal", formula=['"OK"'], font=Font(name=F, color="15803D")))
DD_CHECKS = (5, r - 1)
r += 1

# where the cash went
section(dd, r, "Where the operating cash went (cumulative)"); r += 1
CU_HDR = r
for j, h in enumerate(["5 yrs ($m)", "% of CFO", "10 yrs ($m)", "% of CFO"]):
    x = dd.cell(r, 3 + j, h)
    x.font, x.fill, x.alignment = f_hdr, fill_hdr, Alignment(horizontal="right")
dd.cell(r, 1).fill = fill_hdr
dd.cell(r, 2).fill = fill_hdr
r += 1


def csum(code, n, neg=False):
    rng = f"Data!{YC[YEARS - n]}{D[code]}:{LAST}{D[code]}"
    return f"{'-' if neg else ''}SUM({rng})"


CU = [("Operating cash flow", lambda n: csum("ncfo", n)),
      ("Capital expenditure", lambda n: csum("capex", n, True)),
      ("Acquisitions & other investing", lambda n: f"-({csum('ncfi', n)}-{csum('capex', n)})"),
      ("Dividends", lambda n: csum("ncfdiv", n, True)),
      ("Share buybacks", lambda n: csum("ncfbuyback", n, True)),
      ("Debt repaid (borrowed if negative)", lambda n: f"-(N({d('debt', LAST)})-N({d('debt', YC[YEARS - n - 1] if n < YEARS else YC[0])}))")]
cu_first = r
for lab, fn in CU:
    dd.cell(r, 1, lab).font = f_bold if r == cu_first else f_lab
    for j, n in enumerate([5, 10]):
        x = dd.cell(r, 3 + 2 * j, "=" + fn(n))
        x.number_format, x.font = MONEY, f_val
        y = dd.cell(r, 4 + 2 * j, f'=IF(N({L(3 + 2 * j)}${cu_first})<=0,"",{L(3 + 2 * j)}{r}/{L(3 + 2 * j)}${cu_first})')
        y.number_format = PCT
    r += 1
dd.cell(r, 1, "Left over (added to cash, other financing)").font = f_bold
for j in range(2):
    cc = L(3 + 2 * j)
    x = dd.cell(r, 3 + 2 * j, f"={cc}{cu_first}-SUM({cc}{cu_first + 1}:{cc}{r - 1})")
    x.number_format, x.font = MONEY, f_bold
    y = dd.cell(r, 4 + 2 * j, f'=IF(N({cc}${cu_first})<=0,"",{cc}{r}/{cc}${cu_first})')
    y.number_format = PCT
r += 1
dd.cell(r, 1, "Debt for 5 years compares the latest balance with the one 5 years earlier; 10 years uses the oldest year shown.").font = f_note
dd.freeze_panes = "C5"

# =====================================================================================  Unit Metrics
um = sheet("Unit Metrics", "Unit metrics: what each dollar earns", "How much revenue and profit each dollar of capital or spending produces. Rising = getting more efficient.", tab="65A30D")
r = 4
year_header(um, r, label="$ per $1 (per-share rows in $)")
U = {}
r += 1
U["wc"] = row(um, r, "Working capital ($m)", lambda c, i: f'IF({d("assetsc", c)}="","",{d("assetsc", c)}-N({d("liabilitiesc", c)}))'); r += 1
U["wca"] = row(um, r, "Average working capital ($m)", lambda c, i: f"{c}{U['wc']}" if i == 0 else f"AVERAGE({prevcol(c)}{U['wc']},{c}{U['wc']})"); r += 2
section(um, r, "Revenue per $1 of …"); r += 1
U["r_wc"] = row(um, r, "Working capital", lambda c, i: pos_div(d("revenue", c), f"{c}{U['wca']}"), '0.00;(0.00);"-"',
                note="Blank when working capital is zero or negative (customers fund the business: often a strength)."); r += 1
U["r_ppe"] = row(um, r, "Net PP&E (fixed asset turnover)", lambda c, i: pos_div(d("revenue", c), avg2("ppnenet", c, i)), '0.00;(0.00);"-"'); r += 1
U["r_ta"] = row(um, r, "Total assets (asset turnover)", lambda c, i: pos_div(d("revenue", c), avg2("assets", c, i)), '0.00;(0.00);"-"'); r += 1
U["r_debt"] = row(um, r, "Total debt", lambda c, i: pos_div(d("revenue", c), d("debt", c)), '0.00;(0.00);"-"'); r += 1
U["r_sga"] = row(um, r, "SG&A spending", lambda c, i: pos_div(d("revenue", c), d("sgna", c)), '0.00;(0.00);"-"'); r += 1
U["r_rnd"] = row(um, r, "R&D spending", lambda c, i: pos_div(d("revenue", c), d("rnd", c)), '0.00;(0.00);"-"'); r += 1
U["r_sbc"] = row(um, r, "Stock-based compensation", lambda c, i: pos_div(d("revenue", c), d("sbcomp", c)), '0.0;(0.0);"-"'); r += 2
section(um, r, "Profit per $1 of …"); r += 1
U["e_wc"] = row(um, r, "EBITDA per $1 of working capital", lambda c, i: pos_div(d("ebitda", c), f"{c}{U['wca']}"), '0.00;(0.00);"-"'); r += 1
U["e_ppe"] = row(um, r, "EBITDA per $1 of net PP&E", lambda c, i: pos_div(d("ebitda", c), avg2("ppnenet", c, i)), '0.00;(0.00);"-"'); r += 1
U["e_debt"] = row(um, r, "EBITDA per $1 of debt", lambda c, i: pos_div(d("ebitda", c), d("debt", c)), '0.00;(0.00);"-"'); r += 1
U["g_sga"] = row(um, r, "Gross profit per $1 of SG&A", lambda c, i: f'IF(N({d("cor", c)})=0,"",{pos_div(d("gp", c), d("sgna", c))})', '0.00;(0.00);"-"',
                 note="How much gross profit the sales and admin machine brings in. Falling = selling is getting more expensive."); r += 1
U["o_rnd"] = row(um, r, "Operating income per $1 of R&D", lambda c, i: pos_div(d("opinc", c), d("rnd", c)), '0.00;(0.00);"-"'); r += 1
U["inc"] = row(um, r, "Incremental operating margin (extra operating income ÷ extra revenue)",
               lambda c, i: None if i == 0 else f'IF(OR({d("revenue", prevcol(c))}="",{d("opinc", prevcol(c))}="",N({d("revenue", c)})-N({d("revenue", prevcol(c))})<=0,{d("opinc", c)}=""),"",({d("opinc", c)}-{d("opinc", prevcol(c))})/({d("revenue", c)}-{d("revenue", prevcol(c))}))',
               PCT, note="Above the operating margin = operating leverage (each new sale is more profitable). Only shown when revenue grew."); r += 2
section(um, r, "Per share ($)"); r += 1


def ps(expr, c):
    return f'IF(OR(N({d("shareswadil", c)})=0,{expr}=""),"",{expr}/{d("shareswadil", c)})'


U["ps_rev"] = row(um, r, "Revenue per share", lambda c, i: ps(d("revenue", c), c), EPS); r += 1
U["ps_ebitda"] = row(um, r, "EBITDA per share", lambda c, i: ps(d("ebitda", c), c), EPS); r += 1
U["ps_eps"] = row(um, r, "Diluted EPS", lambda c, i: d("epsdil", c), EPS); r += 1
U["ps_fcf"] = row(um, r, "Free cash flow per share", lambda c, i: ps(d("fcf", c), c), EPS); r += 1
U["ps_bv"] = row(um, r, "Book value per share", lambda c, i: ps(d("equity", c), c), EPS); r += 1
U["ps_cash"] = row(um, r, "Cash & short-term investments per share",
                   lambda c, i: ps(f'(N({d("cashneq", c)})+N({d("investmentsc", c)}))', c), EPS); r += 1
U["ps_div"] = row(um, r, "Dividends per share",
                  lambda c, i: f'IF(OR(N({d("shareswadil", c)})=0,N({d("ncfdiv", c)})=0),"",-{d("ncfdiv", c)}/{d("shareswadil", c)})', EPS); r += 2
um.cell(r, 1, "Employee numbers and costs aren't in SEC XBRL data for most US companies, so per-employee metrics aren't included. Find headcount in the 10-K (Item 1, Human Capital).").font = f_note
chart(um, "line", "Revenue per $1 of fixed assets and of total assets", [U["r_ppe"], U["r_ta"]], "O4", y_fmt="0.0")
chart(um, "line", "Per share: revenue, free cash flow, book value ($)", [U["ps_rev"], U["ps_fcf"], U["ps_bv"]], "O20", y_fmt="0")
um.freeze_panes = "C5"

# =====================================================================================  Valuation Simulation
vs = sheet("Valuation Simulation", "Valuation simulation: what return could you earn?",
           "Annual return from today's market cap if revenue grows at a given rate and the market pays a given multiple at exit. Yellow cells are yours to change.", tab="9333EA")
vs.column_dimensions["A"].width = 42
vs.column_dimensions["B"].width = 13
for c in "CDEFGHIJ":
    vs.column_dimensions[c].width = 10
VI = {}
vs.cell(4, 1, "Starting point and assumptions").font = f_sec
r = 5
conv_rng = f"'Cash Flow'!$C${C['conv']}:${LAST}${C['conv']}"
VINS = [
    ("rev", "Revenue, trailing 12 months ($m)", f'=IF(N({dv("ttm_revenue")})>0,{dv("ttm_revenue")},{d("revenue", LAST)})', MONEY, "link"),
    ("ni", "Net income, trailing 12 months ($m)", f'=IF({dv("ttm_netinc")}<>"",{dv("ttm_netinc")},{d("netinc", LAST)})', MONEY, "link"),
    ("mc", "Market cap now ($m)", f'={dv("mcap_now")}', MONEY, "link"),
    ("n", "Years until you sell", 5, "0", "in"),
    ("m", "Net margin at exit", f'=IFERROR(MAX(0.01,B6/B5),0.1)', PCT, "in"),
    ("cv", "Free cash flow ÷ net income at exit", f'=IFERROR(MIN(1.2,MAX(0.5,MEDIAN({conv_rng}))),1)', PCT, "in"),
    ("t", "Return you want (per year)", 0.12, PCT, "in"),
]
for k, lab, val, fmt, kind in VINS:
    VI[k] = r
    vs.cell(r, 1, lab).font = f_lab
    x = vs.cell(r, 2, val)
    x.number_format = fmt
    if kind == "in":
        x.font, x.fill = f_in, fill_in
    else:
        x.font = f_link
    r += 1
vs.cell(VI["m"], 3, "default: today's TTM net margin").font = f_note
vs.cell(VI["cv"], 3, "default: 10-year median, kept between 50% and 120%").font = f_note
r += 1

# benchmarks from the company's own history
vs.cell(r, 1, "The company's own history (to pick sensible inputs)").font = f_sec
r += 1
for j, h in enumerate(["Latest / now", "3 years", "5 years", "10-yr median"]):
    x = vs.cell(r, 3 + j, h)
    x.font, x.fill, x.alignment = f_hdr, fill_hdr, Alignment(horizontal="right")
vs.cell(r, 1).fill = fill_hdr
vs.cell(r, 2).fill = fill_hdr
r += 1


def med(sh, rr):
    rng = f"{sh}!$C${rr}:${LAST}${rr}"
    return f'=IFERROR(IF(COUNT({rng})=0,"",MEDIAN({rng})),"")'


def avgn(sh, rr, n):
    rng = f"{sh}!{YC[YEARS - n]}{rr}:{LAST}{rr}"
    return f'=IFERROR(IF(COUNT({rng})=0,"",AVERAGE({rng})),"")'


BM = [("Revenue growth (1 yr, then CAGR)", [f"=Growth!{LAST}{G['rev']}", f"=Growth!C{CG['rev']}", f"=Growth!D{CG['rev']}", med("Growth", G["rev"])], PCT),
      ("Net margin (TTM, then average)", [f'=IFERROR(B{VI["ni"]}/B{VI["rev"]},"")', avgn("Margins", M["npm"], 3), avgn("Margins", M["npm"], 5), med("Margins", M["npm"])], PCT),
      ("Free cash flow ÷ net income", [f"='Cash Flow'!{LAST}{C['conv']}", avgn("'Cash Flow'", C["conv"], 3), avgn("'Cash Flow'", C["conv"], 5), med("'Cash Flow'", C["conv"])], PCT),
      ("P/E (now, then average)", [f"=Valuation!{CUR}{Q['pe']}", avgn("Valuation", Q["pe"], 3), avgn("Valuation", Q["pe"], 5), med("Valuation", Q["pe"])], MULT),
      ("Price / free cash flow", [f'=IFERROR(1/Valuation!{CUR}{Q["fy"]},"")', f'=IFERROR(1/AVERAGE(Valuation!{YC[7]}{Q["fy"]}:{LAST}{Q["fy"]}),"")',
                                  f'=IFERROR(1/AVERAGE(Valuation!{YC[5]}{Q["fy"]}:{LAST}{Q["fy"]}),"")', f'=IFERROR(1/MEDIAN(Valuation!$C${Q["fy"]}:${LAST}${Q["fy"]}),"")'], MULT)]
BMR = {}
for lab, fs, fmt in BM:
    vs.cell(r, 1, lab).font = f_lab
    for j, f in enumerate(fs):
        x = vs.cell(r, 3 + j, f)
        x.number_format, x.font = fmt, f_val
    BMR[lab] = r
    r += 1
PE_ROW, PF_ROW = BMR["P/E (now, then average)"], BMR["Price / free cash flow"]
r += 1

GROWTHS = [0, 0.03, 0.06, 0.09, 0.12, 0.15, 0.20, 0.25, 0.30]
B_ = lambda k: f"$B${VI[k]}"


def grid(r, title, mults, value_expr, mult_label):
    vs.cell(r, 1, title).font = f_sec
    r += 1
    hdr = r
    vs.cell(r, 1, f"Revenue growth per year ↓   ·   {mult_label} at exit →").font = f_hdr
    vs.cell(r, 1).fill = fill_hdr
    vs.cell(r, 2).fill = fill_hdr
    for j, m_ in enumerate(mults):
        x = vs.cell(r, 3 + j, m_)
        x.number_format = '0"x"'
        x.font, x.fill = Font(name=F, size=10, bold=True, color="0000FF"), fill_in
    r += 1
    first = r
    for g in GROWTHS:
        x = vs.cell(r, 2, g)
        x.number_format = "0.0%"
        x.font, x.fill = Font(name=F, size=10, bold=True, color="0000FF"), fill_in
        for j in range(len(mults)):
            cc = L(3 + j)
            exitv = value_expr(f"$B{r}", f"{cc}${hdr}")
            y = vs.cell(r, 3 + j, f'=IF(OR(N({B_("mc")})<=0,N({B_("rev")})<=0,N({B_("n")})<=0),"",IFERROR(({exitv}/{B_("mc")})^(1/{B_("n")})-1,""))')
            y.number_format = '0%;-0%;0%'
            y.font = f_val
        r += 1
    rng = f"C{first}:{L(2 + len(mults))}{r - 1}"
    vs.conditional_formatting.add(rng, FormulaRule(formula=[f'AND(ISNUMBER(C{first}),C{first}>={B_("t")})'],
                                                   fill=PatternFill("solid", fgColor="DCFCE7"), font=Font(name=F, bold=True, color="15803D")))
    vs.conditional_formatting.add(rng, FormulaRule(formula=[f'AND(ISNUMBER(C{first}),C{first}<0)'], font=Font(name=F, color="B91C1C")))
    return r + 1


r = grid(r, "Return per year: by revenue growth and exit P/E", [10, 15, 20, 25, 30, 35, 40],
         lambda g, m_: f"{B_('rev')}*(1+{g})^{B_('n')}*{B_('m')}*{m_}", "P/E")
r = grid(r, "Return per year: by revenue growth and exit price / free cash flow", [10, 15, 20, 25, 30, 35, 40],
         lambda g, m_: f"{B_('rev')}*(1+{g})^{B_('n')}*{B_('m')}*{B_('cv')}*{m_}", "P/FCF")
vs.cell(r - 1, 1, "Green = meets your target return. Returns are on today's market cap, so dividends, buybacks and dilution are left out.").font = f_note
r += 1

vs.cell(r, 1, "Reverse: revenue growth needed to earn your target return").font = f_sec
r += 1
REV = [("If the market pays today's P/E at exit", f"C{PE_ROW}"), ("If it pays its 10-year median P/E", f"F{PE_ROW}"), ("If it pays 15x", "15")]
for lab, pe in REV:
    vs.cell(r, 1, lab).font = f_lab
    x = vs.cell(r, 2, f'=IFERROR(IF(OR(N({pe})<=0,N({B_("rev")})<=0,N({B_("m")})<=0),"",((1+{B_("t")})^{B_("n")}*{B_("mc")}/({B_("rev")}*{B_("m")}*{pe}))^(1/{B_("n")})-1),"")')
    x.number_format, x.font = PCT, f_bold
    r += 1
vs.cell(r, 1, "Compare these with the growth rates in the history table: needing far more than the company has ever done is a warning sign.").font = f_note
r += 2
vs.cell(r, 1, "Education only: a simulation shows what you'd have to believe, not what will happen.").font = f_note

# =====================================================================================  Notes
nt = sheet("Notes", "Analysis notes", "Questions to answer as you go through the sheets. Write your answers in column C.", tab="374151")
nt.column_dimensions["A"].width = 22
nt.column_dimensions["B"].width = 70
nt.column_dimensions["C"].width = 70
QUESTIONS = [
    ("Summary", "Summary", ["Over 1, 3, 5 and 9 years, which grew fastest: revenue, operating income, net income or free cash flow? Why?",
                            "Did profits grow faster than revenue (operating leverage) or slower (rising costs)?"]),
    ("Margins", "Margins", ["Are margins steady, cyclical or trending? What explains the best and worst years?",
                            "Which cost line moved the most as a % of revenue, and is that change permanent?",
                            "Are 'Other operating costs' one-offs, or do they come back every year?"]),
    ("Returns", "Returns", ["Is ROIC comfortably above the cost of capital (roughly 8–10%)?",
                            "Is ROE driven by margins, asset turnover or leverage (DuPont)? Which of these is changing?"]),
    ("Leverage", "Leverage", ["Could the company survive a bad year with its current debt? Check net debt/EBITDA and interest coverage.",
                              "Is working capital tying up more cash over time (receivable, inventory days rising)?"]),
    ("Cash flow", "Cash Flow", ["Does net income turn into free cash flow? If not, where does the cash go?",
                                "How much of free cash flow does stock-based pay account for?",
                                "What does the company do with its cash: reinvest, acquire, pay dividends or buy back shares?"]),
    ("Growth", "Growth", ["Is growth speeding up or slowing down? Is it coming from more shares or better per-share results?"]),
    ("Quarterly", "Quarterly", ["Is the latest quarter better or worse than the same quarter last year?",
                                "Is the business seasonal? Which quarter is usually the biggest?",
                                "Is the trailing-12-month trend still rising?"]),
    ("Due diligence", "Due Diligence", ["Which checks show 'Check', and what does the 10-K say about each?",
                                        "Are any red flags repeated over several years rather than one-offs?"]),
    ("Unit metrics", "Unit Metrics", ["Where is the company getting more efficient (more revenue or profit per dollar), and where less?"]),
    ("Valuation", "Valuation", ["How does today's valuation compare with the company's own history? Has the business changed enough to justify the difference?",
                                "What growth does today's price assume (Valuation Simulation, reverse section)? Is that believable?",
                                "What does the DCF give with conservative assumptions, and how sensitive is it?"]),
    ("Decision", "Summary", ["What has to go right for this to be a good investment, and what could go wrong?",
                             "At what price would you buy, and what would make you change your mind?"]),
]
r = 4
for j, h in enumerate(["Area (sheet)", "Question", "Your notes"]):
    x = nt.cell(r, 1 + j, h)
    x.font, x.fill = f_hdr, fill_hdr
r += 1
for area, sh, qs in QUESTIONS:
    for k, qq in enumerate(qs):
        a = nt.cell(r, 1, area if k == 0 else "")
        a.font = f_bold
        a.alignment = Alignment(vertical="top")
        if k == 0:
            a.hyperlink = f"#'{sh}'!A1"
            a.font = Font(name=F, size=10, bold=True, color="1D4ED8", underline="single")
        b = nt.cell(r, 2, qq)
        b.font = f_lab
        b.alignment = Alignment(wrap_text=True, vertical="top")
        c = nt.cell(r, 3)
        c.fill = fill_in
        c.alignment = Alignment(wrap_text=True, vertical="top")
        c.border = Border(bottom=thin)
        nt.row_dimensions[r].height = 32
        r += 1
nt.page_setup.fitToHeight = 0

# sheet order and finishing
order = ["Read Me", "Summary", "Margins", "Returns", "Leverage", "Cash Flow", "Growth", "Quarterly", "Due Diligence", "Unit Metrics", "Valuation", "DCF",
         "Valuation Simulation", "Notes", "Data", "QData", "Standard", "ChartData"]
wb._sheets = [wb[n] for n in order]
wb.active = 1
wb.calculation.fullCalcOnLoad = True
wb.save(OUT)
shutil.copy(OUT, os.path.join(ROOT, "public", "US_Analysis_Model.xlsx"))
print("wrote", OUT)

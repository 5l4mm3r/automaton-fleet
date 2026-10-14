"""Sale-ready example: a 12-month cash-flow forecast for UK sole traders (XlsxWriter + reportlab).

Outputs deliver/cashflow-forecast.xlsx and deliver/cashflow-quick-start.pdf. Every formula is saved with its computed value
(previewers show saved values), money is formatted in pounds, inputs are labelled and coloured, the buffer warning is a
formula, and the guide explains the workbook with a worked example. Run inside the founder sandbox with the toolchain.
"""
import xlsxwriter
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
OPENING, BUFFER = 2000, 1500
SALES = [3200, 3400, 2800, 2600, 3900, 4200, 4100, 3000, 2700, 3600, 4800, 5200]
OTHER_IN = [0, 0, 250, 0, 0, 250, 0, 0, 250, 0, 0, 250]
COSTS = {  # label -> 12 months
    "Rent": [750] * 12,
    "Stock and materials": [1200, 1300, 1100, 1000, 1500, 1600, 1550, 1200, 1050, 1400, 1900, 2100],
    "Software and phone": [85] * 12,
    "Marketing": [150, 150, 300, 150, 150, 300, 150, 150, 300, 150, 400, 400],
    "Tax set-aside": [450, 480, 390, 360, 560, 610, 590, 420, 380, 510, 700, 760],
    "Drawings": [700] * 12,
}

wb = xlsxwriter.Workbook("deliver/cashflow-forecast.xlsx")
wb.set_properties({"title": "12-month cash-flow forecast", "subject": "Cash-flow forecast for sole traders"})
wb.set_calc_mode("auto")
F = lambda **k: wb.add_format({"font_name": "Calibri", "font_size": 11, **k})
title = F(bold=True, font_size=16, font_color="#1F3864")
h = F(bold=True, bg_color="#1F3864", font_color="white", border=1, align="center", valign="vcenter")
lab = F(bold=True)
money_in = F(num_format="£#,##0;[Red]-£#,##0", bg_color="#DDEBF7", border=1)       # inputs: blue
money = F(num_format="£#,##0;[Red]-£#,##0", border=1)
money_b = F(num_format="£#,##0;[Red]-£#,##0", border=1, bold=True, top=2)
txt = F(text_wrap=True, valign="top")
ok = F(border=1, align="center")

# Start here
st = wb.add_worksheet("Start here")
st.set_column("A:A", 4); st.set_column("B:B", 100)
st.write("B2", "12-month cash-flow forecast", title)
steps = [
    "1. Go to Inputs. Blue cells are yours to change: opening bank balance, the minimum balance you want to keep (buffer), and each month's money in and out.",
    "2. Forecast recalculates instantly: money in, money out, net movement and the closing balance for each month.",
    "3. The Status column says 'Below buffer' in any month whose closing balance falls under your buffer, and the cell turns red. Act on the first one: chase invoices, delay a purchase or arrange funding early.",
    "4. The chart shows the closing balance against your buffer across the year.",
    "5. Amounts are in pounds and exclude VAT (enter VAT-inclusive figures if you are VAT registered and pay VAT from the same account).",
    "This is a planning tool, not financial or tax advice. The example figures are illustrative: replace them with your own.",
]
for i, s in enumerate(steps):
    st.write(4 + i, 1, s, txt); st.set_row(4 + i, 32)

# Inputs
inp = wb.add_worksheet("Inputs")
inp.set_column("A:A", 26); inp.set_column("B:M", 10)
inp.write("A1", "Inputs (blue cells)", title)
inp.write("A3", "Opening bank balance", lab); inp.write_number("B3", OPENING, money_in)
inp.write("A4", "Minimum balance (buffer)", lab); inp.write_number("B4", BUFFER, money_in)
inp.write("A6", "Money in", lab); inp.write_row("B6", MONTHS, h)
inp.write("A7", "Sales"); [inp.write_number(6, 1 + m, SALES[m], money_in) for m in range(12)]
inp.write("A8", "Other income"); [inp.write_number(7, 1 + m, OTHER_IN[m], money_in) for m in range(12)]
inp.write("A10", "Money out", lab); inp.write_row("B10", MONTHS, h)
for r, (name, vals) in enumerate(COSTS.items()):
    inp.write(10 + r, 0, name)
    for m in range(12):
        inp.write_number(10 + r, 1 + m, vals[m], money_in)
inp.freeze_panes(6, 1)
first_cost, last_cost = 11, 10 + len(COSTS)   # 1-based rows 11..16

# Forecast (formulas with their computed values saved)
fc = wb.add_worksheet("Forecast")
fc.set_column("A:A", 8); fc.set_column("B:F", 14); fc.set_column("G:G", 13)
fc.write("A1", "Forecast", title)
fc.write_row("A3", ["Month", "Opening", "Money in", "Money out", "Net", "Closing", "Status"], h)
fc.set_row(2, 20)
col = lambda m: xlsxwriter.utility.xl_col_to_name(1 + m)
bal = OPENING
closings = []
for m in range(12):
    r = 4 + m
    tin = SALES[m] + OTHER_IN[m]
    tout = sum(v[m] for v in COSTS.values())
    opening = bal
    bal = opening + tin - tout
    closings.append(bal)
    fc.write(r - 1, 0, MONTHS[m], ok)
    fc.write_formula(r - 1, 1, "=Inputs!$B$3" if m == 0 else "=F%d" % (r - 1), money, opening)
    fc.write_formula(r - 1, 2, "=SUM(Inputs!%s7:%s8)" % (col(m), col(m)), money, tin)
    fc.write_formula(r - 1, 3, "=SUM(Inputs!%s%d:%s%d)" % (col(m), first_cost, col(m), last_cost), money, tout)
    fc.write_formula(r - 1, 4, "=C%d-D%d" % (r, r), money, tin - tout)
    fc.write_formula(r - 1, 5, "=B%d+E%d" % (r, r), money, bal)
    fc.write_formula(r - 1, 6, '=IF(F%d<Inputs!$B$4,"Below buffer","OK")' % r, ok, "Below buffer" if bal < BUFFER else "OK")
tot_in = sum(SALES) + sum(OTHER_IN); tot_out = sum(sum(v) for v in COSTS.values())
fc.write("A16", "Year", lab)
fc.write_formula("C16", "=SUM(C4:C15)", money_b, tot_in)
fc.write_formula("D16", "=SUM(D4:D15)", money_b, tot_out)
fc.write_formula("E16", "=SUM(E4:E15)", money_b, tot_in - tot_out)
fc.write("A18", "Lowest closing", lab); fc.write_formula("F18", "=MIN(F4:F15)", money_b, min(closings))
red = wb.add_format({"bg_color": "#F8CBAD", "font_color": "#9C0006"})
fc.conditional_format("G4:G15", {"type": "cell", "criteria": "==", "value": '"Below buffer"', "format": red})
fc.freeze_panes(3, 1)
ch = wb.add_chart({"type": "line"})
ch.add_series({"name": "Closing balance", "categories": "=Forecast!$A$4:$A$15", "values": "=Forecast!$F$4:$F$15", "line": {"color": "#1F3864", "width": 2.25}})
ch.set_title({"name": "Closing balance by month"}); ch.set_y_axis({"num_format": "£#,##0"}); ch.set_legend({"position": "bottom"})
fc.insert_chart("I3", ch, {"x_scale": 1.3, "y_scale": 1.2})
wb.close()

# Quick-start guide (PDF)
ss = getSampleStyleSheet()
doc = SimpleDocTemplate("deliver/cashflow-quick-start.pdf", pagesize=A4, leftMargin=20 * mm, rightMargin=20 * mm, topMargin=18 * mm, bottomMargin=18 * mm,
                        title="Cash-flow forecast: quick start")
below = [MONTHS[i] for i, c in enumerate(closings) if c < BUFFER]
story = [Paragraph("Your 12-month cash-flow forecast: quick start", ss["Title"]),
         Paragraph("What it does", ss["Heading2"]),
         Paragraph("The workbook turns the money you expect to receive and pay each month into a month-by-month bank balance, and warns you in "
                   "advance about any month where the balance would fall below the minimum you want to keep. Profit tells you whether the business "
                   "works over a year; cash tells you whether you can pay next month's bills. This forecast is about the second.", ss["BodyText"]),
         Paragraph("Three steps", ss["Heading2"]),
         Paragraph("<b>1. Inputs.</b> Enter your opening bank balance and your buffer, then each month's sales, other income and costs in the blue cells. "
                   "Use realistic, slightly cautious figures: late payers and seasonal dips matter more than the best case.", ss["BodyText"]),
         Paragraph("<b>2. Forecast.</b> Read the closing balance column and the status. The first 'Below buffer' month is your decision point.", ss["BodyText"]),
         Paragraph("<b>3. Act early.</b> Chase invoices, move a purchase, agree supplier terms or arrange funding before that month, not during it.", ss["BodyText"]),
         Paragraph("Worked example (the figures supplied)", ss["Heading2"]),
         Paragraph("Opening balance £%s, buffer £%s. Over the year £%s comes in and £%s goes out, so the balance moves by £%s. The lowest closing balance is £%s%s."
                   % (format(OPENING, ","), format(BUFFER, ","), format(tot_in, ","), format(tot_out, ","), format(tot_in - tot_out, ","), format(min(closings), ","),
                      (" and the forecast flags " + ", ".join(below)) if below else "; no month falls below the buffer"), ss["BodyText"]),
         Spacer(1, 4 * mm)]
rows = [["Month", "Money in", "Money out", "Closing", "Status"]]
b2 = OPENING
for m in range(12):
    tin = SALES[m] + OTHER_IN[m]; tout = sum(v[m] for v in COSTS.values()); b2 += tin - tout
    rows.append([MONTHS[m], "£{:,}".format(tin), "£{:,}".format(tout), "£{:,}".format(b2), "Below buffer" if b2 < BUFFER else "OK"])
t = Table(rows, colWidths=[22 * mm, 30 * mm, 30 * mm, 30 * mm, 32 * mm])
t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1F3864")), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                       ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"), ("GRID", (0, 0), (-1, -1), 0.4, colors.grey),
                       ("ALIGN", (1, 1), (3, -1), "RIGHT"), ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F2F2F2")])]
                      + [("TEXTCOLOR", (4, i), (4, i), colors.HexColor("#9C0006")) for i in range(1, 13) if rows[i][4] != "OK"]))
story += [t, Spacer(1, 4 * mm),
          Paragraph("Limits", ss["Heading2"]),
          Paragraph("A forecast is only as good as its inputs; update it monthly with what actually happened. This is a planning tool, not financial or tax advice.", ss["BodyText"])]
doc.build(story)
print("BUILT", min(closings), ",".join(below))

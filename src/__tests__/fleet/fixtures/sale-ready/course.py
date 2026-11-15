"""Sale-ready example: "Cash-flow basics" — three illustrated PDF lessons with exercises and answers, and a 13-week forecast
workbook, bundled as deliver/cash-flow-course.zip. Formulas carry their computed values; the workbook covers all 13 weeks the
course promises. Run inside the founder sandbox with the toolchain.
"""
import os
import zipfile

import xlsxwriter
from reportlab.graphics.charts.barcharts import VerticalBarChart
from reportlab.graphics.shapes import Drawing, Line, String
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

os.makedirs("course", exist_ok=True)
NAVY = colors.HexColor("#1F3864")
ss = getSampleStyleSheet()
body = ParagraphStyle("b", parent=ss["BodyText"], fontSize=10.5, leading=15)
box = ParagraphStyle("box", parent=body, backColor=colors.HexColor("#EEF3FA"), borderPadding=6, leftIndent=6, rightIndent=6)

OPENING = 1200
RECEIPTS = [900, 1100, 600, 1400, 950, 700, 1300, 1250, 500, 900, 1600, 1150, 1000]
PAYMENTS = [1000, 800, 1150, 900, 1300, 850, 950, 1700, 800, 1000, 900, 1250, 950]
gbp = lambda n: ("−£{:,}" if n < 0 else "£{:,}").format(abs(n))
closing, b = [], OPENING
for r, p in zip(RECEIPTS, PAYMENTS):
    b += r - p
    closing.append(b)


def table(rows, widths, money_cols=()):
    t = Table(rows, colWidths=widths, hAlign="LEFT")
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), NAVY), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white), ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                           ("GRID", (0, 0), (-1, -1), 0.4, colors.grey), ("FONTSIZE", (0, 0), (-1, -1), 9.5),
                           ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F2F2F2")])]
                          + [("ALIGN", (c, 1), (c, -1), "RIGHT") for c in money_cols]))
    return t


def lesson(fname, number, title, sections, exercises, answers, extra=None):
    doc = SimpleDocTemplate("course/" + fname, pagesize=A4, leftMargin=22 * mm, rightMargin=22 * mm, topMargin=20 * mm, bottomMargin=20 * mm,
                            title="Lesson %d: %s" % (number, title))
    story = [Paragraph("Cash-flow basics · Lesson %d of 3" % number, ss["Normal"]), Paragraph(title, ss["Title"]), Spacer(1, 2 * mm)]
    for head, paras in sections:
        story.append(Paragraph(head, ss["Heading2"]))
        story += [Paragraph(p, body) for p in paras]
    if extra:
        story += extra
    story += [Spacer(1, 3 * mm), Paragraph("Exercises", ss["Heading2"])] + [Paragraph("%d. %s" % (i + 1, e), body) for i, e in enumerate(exercises)]
    story += [PageBreak(), Paragraph("Answers", ss["Heading2"])] + [Paragraph("%d. %s" % (i + 1, a), body) for i, a in enumerate(answers)]
    doc.build(story)


# Lesson 1
lesson("01-why-cash-flow.pdf", 1, "Why cash, not profit, keeps you trading", [
    ("Profit and cash are different questions", [
        "Profit answers: over a period, did the work earn more than it cost? Cash answers: on a given day, is there enough money in the bank to pay what is due? "
        "A business can be profitable on paper and still miss a rent payment, because customers pay later than suppliers want to be paid.",
        "Three timing gaps cause most cash shortfalls: <b>customers paying late</b> (you have earned the money but do not have it), <b>buying ahead</b> (stock or "
        "materials paid for before the sale), and <b>lumpy bills</b> (quarterly rent, annual insurance, tax payments) that land in one week."]),
    ("A worked example", [
        "Sam, a freelance designer, invoices £3,000 in March for work done that month. Sam's costs are £1,800 a month and are paid on the 1st. Clients pay "
        "on 30-day terms, so each month's invoice is paid the following month: February's smaller £2,400 invoice arrives in March, March's £3,000 in April. "
        "Between 1 March and 1 April Sam pays two months of costs (March and April, £3,600) but receives only £2,400: the bank balance falls by £1,200, "
        "even though March itself is profitable (£3,000 earned against £1,800 of costs)."]),
    ("What to watch", [
        "Know your lowest point, not your average. The question that matters is 'what is the lowest my balance will be in the next three months, and when?' "
        "Lesson 2 builds a forecast that answers it; lesson 3 turns the answer into action."])],
    ["Sam's March profit is £1,200. Why can the bank balance still fall in March?",
     "List the three timing gaps from this lesson and give one example of each from your own business.",
     "Your clients pay on 45-day terms and your costs are £2,000 a month. Roughly how much cash do you need on hand to bridge the delay?"],
    ["Because the £3,000 earned in March is not received until April, while March's costs are paid in March. Profit counts the work when it is done; cash counts the money when it moves.",
     "Late customer payment (an unpaid invoice), buying ahead (paying for stock before you sell it), lumpy bills (quarterly rent, the January tax payment). Your examples will differ.",
     "About one and a half months of costs: 45 days ≈ 1.5 months × £2,000 = £3,000, plus a buffer for surprises."])

# Lesson 2 — with a chart of the 13-week forecast
d = Drawing(165 * mm, 62 * mm)
bc = VerticalBarChart()
bc.x, bc.y, bc.width, bc.height = 14 * mm, 8 * mm, 128 * mm, 48 * mm
bc.valueAxis.labelTextFormat = "£%d"
bc.data = [closing]
bc.categoryAxis.categoryNames = ["W%d" % (i + 1) for i in range(13)]
bc.valueAxis.valueMin, bc.valueAxis.valueMax, bc.valueAxis.valueStep = 0, 2000, 500
bc.bars[0].fillColor = NAVY
d.add(bc)
buf_y = bc.y + bc.height * 800 / 2000
d.add(Line(bc.x, buf_y, bc.x + bc.width, buf_y, strokeColor=colors.red, strokeDashArray=[3, 2]))
d.add(String(bc.x + bc.width + 2 * mm, buf_y - 3, "buffer £800", fontSize=8, fillColor=colors.red))  # outside the plot: never over a bar
rows = [["Week", "Receipts", "Payments", "Closing"]] + [["W%d" % (i + 1), "£{:,}".format(RECEIPTS[i]), "£{:,}".format(PAYMENTS[i]), "£{:,}".format(closing[i])] for i in range(13)]
lowest = min(range(13), key=lambda i: closing[i])
lesson("02-forecasting.pdf", 2, "Building a 13-week cash-flow forecast", [
    ("Why 13 weeks", [
        "Thirteen weeks is one quarter: long enough to see the next quarterly bill and the next slow patch, short enough to estimate week by week with real "
        "confidence. The workbook that comes with this course is laid out exactly this way."]),
    ("The method", [
        "<b>1. Start from today's bank balance</b>, not from an estimate. <b>2. List receipts in the week you expect the money</b>, not the week you invoice. "
        "<b>3. List payments in the week they leave</b>: rent, suppliers, software, tax set-aside, your own drawings. <b>4. Roll the balance forward</b>: "
        "closing = opening + receipts − payments, and next week's opening is this week's closing. <b>5. Mark your buffer</b>, the minimum you never want to go below."]),
    ("Worked example", [
        "Opening balance £1,200 and a buffer of £800. The table and chart below are the course workbook's example figures. The lowest week is W%d at £%s; "
        "%s fall under the buffer, which is the early warning a forecast exists to give." % (lowest + 1, format(closing[lowest], ","),
                                                                                        " and ".join(", ".join("W%d" % (i + 1) for i in range(13) if closing[i] < 800).rsplit(", ", 1)))])],
    ["Using the workbook, change the opening balance to £600. Which weeks are now below the £800 buffer?",
     "A client says the £1,600 due in W11 will arrive in W13 instead. What happens to the closing balances of W11 and W12?",
     "Why should a receipt go in the week the money arrives rather than the week you send the invoice?"],
    ["Every closing balance falls by £600: the closing balances become " + ", ".join("W%d %s" % (i + 1, gbp(c - 600)) for i, c in enumerate(closing))
     + ". Weeks below £800: " + ", ".join("W%d" % (i + 1) for i, c in enumerate(closing) if c - 600 < 800) + ".",
     "Both fall by £1,600: W11 to %s and W12 to %s, back to normal from W13 when the money arrives." % (gbp(closing[10] - 1600), gbp(closing[11] - 1600)),
     "Because the forecast is about the bank balance. An invoice is a promise; only the payment changes what you can spend."],
    extra=[KeepTogether([Spacer(1, 2 * mm), d, Paragraph("Closing balance by week, against the £800 buffer.", ss["Italic"])]),
           Spacer(1, 2 * mm), KeepTogether([table(rows, [20 * mm, 30 * mm, 30 * mm, 30 * mm], money_cols=(1, 2, 3))])])

# Lesson 3
lesson("03-acting-early.pdf", 3, "Acting before the shortfall", [
    ("Use the warning while you still have choices", [
        "A forecast that shows a dip in six weeks gives you six weeks of options. In the week itself you have only one: not paying someone. "
        "Review it weekly, ten minutes on the same day, replacing estimates with what actually happened."]),
    ("Levers, cheapest first", [
        "<b>Bring money in sooner:</b> invoice on completion, not at month end; chase on day 7, not day 30; offer card or instant bank payment; take deposits on "
        "larger jobs. <b>Move money out later:</b> ask suppliers for 30-day terms before you need them; time annual renewals away from your low weeks. "
        "<b>Reduce the gap:</b> pause discretionary spending in the weeks before a dip. <b>Arrange funding early:</b> an overdraft or short-term facility is "
        "far easier to arrange from a position of strength than in a crisis."]),
    ("Worked example", [
        "In the lesson 2 forecast, W%d dips under the buffer. Moving W8's £1,700 equipment purchase two weeks later and chasing W9's late receipt on day 7 lifts every closing balance from W8 onward."
        % (lowest + 1)])],
    ["Pick the dip in your own forecast. Write down two levers you could pull at least four weeks before it.",
     "Why is it easier to arrange an overdraft before you need it?",
     "Which of the levers costs you nothing but a conversation?"],
    ["Answers will differ. A good answer names a specific invoice to chase or a payment to move, the week you will act, and the effect on the lowest balance.",
     "Lenders assess your current position and your forecast; a request made early, with a forecast showing how it is repaid, looks like planning rather than distress.",
     "Asking suppliers for longer terms, invoicing on completion and chasing earlier: each improves timing without adding cost."])

# The 13-week workbook (all 13 weeks, computed values saved, formatted, with instructions)
wb = xlsxwriter.Workbook("course/13-week-forecast.xlsx")
F = lambda **k: wb.add_format({"font_name": "Calibri", "font_size": 11, **k})
title, h = F(bold=True, font_size=15, font_color="#1F3864"), F(bold=True, bg_color="#1F3864", font_color="white", border=1, align="center")
mi, m, mb = F(num_format="£#,##0;[Red]-£#,##0", bg_color="#DDEBF7", border=1), F(num_format="£#,##0;[Red]-£#,##0", border=1), F(num_format="£#,##0;[Red]-£#,##0", border=1, bold=True)
c = F(border=1, align="center")
ws = wb.add_worksheet("Forecast")
ws.set_column("A:A", 9); ws.set_column("B:E", 13); ws.set_column("F:F", 14); ws.set_column("H:H", 26); ws.set_column("I:I", 11)
ws.write("A1", "13-week cash-flow forecast", title)
ws.write("H3", "Opening bank balance", F(bold=True)); ws.write_number("I3", OPENING, mi)
ws.write("H4", "Buffer (minimum balance)", F(bold=True)); ws.write_number("I4", 800, mi)
ws.write("H6", "Blue cells are inputs. Enter receipts and payments in the week the money moves.", F(italic=True, text_wrap=True)); ws.set_row(5, 30)
ws.write_row("A3", ["Week", "Opening", "Receipts", "Payments", "Closing", "Status"], h)
b = OPENING
for i in range(13):
    r = 4 + i
    ws.write(r - 1, 0, "W%d" % (i + 1), c)
    ws.write_formula(r - 1, 1, "=$I$3" if i == 0 else "=E%d" % (r - 1), m, b)
    ws.write_number(r - 1, 2, RECEIPTS[i], mi); ws.write_number(r - 1, 3, PAYMENTS[i], mi)
    b += RECEIPTS[i] - PAYMENTS[i]
    ws.write_formula(r - 1, 4, "=B%d+C%d-D%d" % (r, r, r), m, b)
    ws.write_formula(r - 1, 5, '=IF(E%d<$I$4,"Below buffer","OK")' % r, c, "Below buffer" if b < 800 else "OK")
ws.write("A17", "Total", F(bold=True))
ws.write_formula("C17", "=SUM(C4:C16)", mb, sum(RECEIPTS)); ws.write_formula("D17", "=SUM(D4:D16)", mb, sum(PAYMENTS))
ws.write("H8", "Lowest closing", F(bold=True)); ws.write_formula("I8", "=MIN(E4:E16)", mb, min(closing))
ws.conditional_format("F4:F16", {"type": "cell", "criteria": "==", "value": '"Below buffer"', "format": wb.add_format({"bg_color": "#F8CBAD", "font_color": "#9C0006"})})
ws.freeze_panes(3, 1)
wb.close()

with zipfile.ZipFile("deliver/cash-flow-course.zip", "w", zipfile.ZIP_DEFLATED) as z:
    for n in ["01-why-cash-flow.pdf", "02-forecasting.pdf", "03-acting-early.pdf", "13-week-forecast.xlsx"]:
        z.write("course/" + n, "cash-flow-course/" + n)
print("BUILT", min(closing), lowest + 1)

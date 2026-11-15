"""Sale-ready service example: a VAT invoice tracker built from the buyer's own CSV export.

usage: python3 invoice_tracker.py <buyer.csv> <out.xlsx> [--paid-date]
CSV columns: client, net (pounds), and optionally invoice_date / paid (YYYY-MM-DD). The VAT rate is a labelled input cell; every
row's VAT and gross refer to it; dates are real dates; net, VAT and gross are totalled; a Summary sheet totals by client with
SUMIF; every formula is saved with its computed value. --paid-date (the buyer's revision) adds the paid date and a status.
"""
import csv
import datetime
import sys

import xlsxwriter

src, out = sys.argv[1], sys.argv[2]
paid_col = "--paid-date" in sys.argv[3:]
rows = list(csv.DictReader(open(src, newline="", encoding="utf-8")))
if not rows:
    sys.exit("no invoices in " + src)
VAT = 0.20
date = lambda s: datetime.datetime.strptime(s.strip(), "%Y-%m-%d") if s and s.strip() else None

wb = xlsxwriter.Workbook(out)
F = lambda **k: wb.add_format({"font_name": "Calibri", "font_size": 11, **k})
title, h = F(bold=True, font_size=15, font_color="#1F3864"), F(bold=True, bg_color="#1F3864", font_color="white", border=1, align="center", text_wrap=True)
money, money_b = F(num_format="£#,##0.00", border=1), F(num_format="£#,##0.00", border=1, bold=True, top=2)
pct_in = F(num_format="0%", bg_color="#DDEBF7", border=1)
dfmt, cell, bold = F(num_format="dd mmm yyyy", border=1, align="center"), F(border=1), F(bold=True)

ws = wb.add_worksheet("Invoices")
ws.write("A1", "Invoice tracker", title)
ws.write("F1", "VAT rate", bold); ws.write_number("G1", VAT, pct_in)
hdr = ["Client", "Invoice date", "Net", "VAT", "Gross"] + (["Paid on", "Status"] if paid_col else [])
ws.write_row("A3", hdr, h)
ws.set_column("A:A", 24); ws.set_column("B:B", 13); ws.set_column("C:E", 12); ws.set_column("F:F", 13); ws.set_column("G:G", 10)
tn = tv = tg = 0.0
for i, r in enumerate(rows):
    n = 4 + i
    net = round(float(r["net"]), 2); vat = round(net * VAT, 2); gross = round(net + vat, 2)
    tn += net; tv += vat; tg += gross
    ws.write(n - 1, 0, r["client"].strip(), cell)
    d = date(r.get("invoice_date", ""))
    ws.write_datetime(n - 1, 1, d, dfmt) if d else ws.write_blank(n - 1, 1, None, dfmt)
    ws.write_number(n - 1, 2, net, money)
    ws.write_formula(n - 1, 3, "=ROUND(C%d*$G$1,2)" % n, money, vat)
    ws.write_formula(n - 1, 4, "=C%d+D%d" % (n, n), money, gross)
    if paid_col:
        p = date(r.get("paid", ""))
        ws.write_datetime(n - 1, 5, p, dfmt) if p else ws.write_blank(n - 1, 5, None, dfmt)
        ws.write_formula(n - 1, 6, '=IF(F%d="","Unpaid","Paid")' % n, cell, "Paid" if p else "Unpaid")
last = 3 + len(rows)
ws.write(last, 0, "Total", bold)
ws.write_formula(last, 2, "=SUM(C4:C%d)" % last, money_b, round(tn, 2))
ws.write_formula(last, 3, "=SUM(D4:D%d)" % last, money_b, round(tv, 2))
ws.write_formula(last, 4, "=SUM(E4:E%d)" % last, money_b, round(tg, 2))
ws.freeze_panes(3, 1)
ws.autofilter(2, 0, last - 1, len(hdr) - 1)

sm = wb.add_worksheet("Summary")
sm.write("A1", "Totals by client", title)
sm.write_row("A3", ["Client", "Net", "VAT", "Gross"], h)
sm.set_column("A:A", 24); sm.set_column("B:D", 12)
clients = list(dict.fromkeys(r["client"].strip() for r in rows))
for j, c in enumerate(clients):
    n = 4 + j
    cn = round(sum(round(float(r["net"]), 2) for r in rows if r["client"].strip() == c), 2)
    cv = round(sum(round(round(float(r["net"]), 2) * VAT, 2) for r in rows if r["client"].strip() == c), 2)
    sm.write(n - 1, 0, c, cell)
    sm.write_formula(n - 1, 1, "=SUMIF(Invoices!$A$4:$A$%d,A%d,Invoices!$C$4:$C$%d)" % (last, n, last), money, cn)
    sm.write_formula(n - 1, 2, "=SUMIF(Invoices!$A$4:$A$%d,A%d,Invoices!$D$4:$D$%d)" % (last, n, last), money, cv)
    sm.write_formula(n - 1, 3, "=B%d+C%d" % (n, n), money, round(cn + cv, 2))
wb.close()
print("BUILT", len(rows), round(tg, 2))

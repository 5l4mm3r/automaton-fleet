/**
 * Deliverable QA inspector fleet-qa-3: spreadsheets checked as the customer's office application shows them.
 *  - the displayed-cell rules on the REAL LibreOffice Calc output of Agent-1's published tracker (2026-10-19, LibreOffice
 *    24.2 on the production host; docs/evaluations/launch-candidate/tracker-libreoffice-2026-10-19/): exactly the three
 *    date columns showing serial numbers fail; a corrected sheet passes; money columns are never read as dates; error
 *    values fail;
 *  - without an office application (this machine, unless LibreOffice is installed) a CSV / XLSX says plainly that it was
 *    not opened — a check that did not run never passes; with one, a CSV whose formula computes a date fails.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { runSandboxed } from "../../fleet/founder/exec-sandbox.js";
import { QA_INSPECTOR_PY, QA_INSPECTOR_VERSION, parseInspectorReport } from "../../fleet/founder/qa/inspector.js";

const EVIDENCE = path.join(process.cwd(), "docs/evaluations/launch-candidate/tracker-libreoffice-2026-10-19");
const DEV_TOOLS = path.join(os.homedir(), ".cache/automaton-fleet-tools/dev");
const HAVE_TOOLS = fs.existsSync(path.join(DEV_TOOLS, "bin/fleet-python"));
const RENDERER = ["/usr/bin/soffice", "/usr/bin/libreoffice"].some((p) => fs.existsSync(p));

// The inspector's own displayed-cell rules, run on a saved office export (no renderer needed).
const HARNESS = String.raw`
import json, re, sys
from html.parser import HTMLParser
src = open(sys.argv[1]).read()
seg = src[src.index("DATE_HEADER = "):src.index("def sheet_as_displayed")]
ns = {"re": re, "HTMLParser": HTMLParser}
exec(seg, ns)
out = {}
for p in sys.argv[2:]:
    e, s = ns["displayed_problems"](ns["displayed_cells"](open(p, encoding="utf-8").read()))
    out[p.rsplit("/", 1)[-1]] = {"errors": e, "serials": s}
print(json.dumps(out))
`;

describe("deliverable QA inspector fleet-qa-3 (spreadsheets as displayed)", () => {
  let dir = "";
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa3-"));
    fs.writeFileSync(path.join(dir, "inspector.py"), QA_INSPECTOR_PY);
  });
  afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
  const rules = (...files: string[]) => JSON.parse(execFileSync("python3", ["-c", HARNESS, path.join(dir, "inspector.py"), ...files], { encoding: "utf8" }));
  const table = (rows: string[][]) => `<html><body><table>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</table></body></html>`;

  it("is fleet-qa-3", () => expect(QA_INSPECTOR_VERSION).toBe("fleet-qa-3"));

  it("the published tracker as LibreOffice showed it: exactly its three date columns showing serial numbers fail", () => {
    const r = rules(path.join(EVIDENCE, "properties.html"), path.join(EVIDENCE, "rent_log.html"));
    expect(r["properties.html"]).toEqual({ errors: [], serials: [
      "table 1 row 2 column 'Gas safety due' shows 46266 instead of a date",
      "table 1 row 2 column 'EICR due' shows 46905 instead of a date"] });
    expect(r["rent_log.html"]).toEqual({ errors: [], serials: ["table 1 row 2 column 'Earliest next increase' shows 46143 instead of a date"] });
  });

  it("a corrected sheet passes; money columns are never read as dates; error values fail", () => {
    fs.writeFileSync(path.join(dir, "fixed.html"), table([["Property", "Gas safety due", "EICR due", "Amount due", "Annual rent", "Next rent increase"],
      ["12 High St", "2026-08-30", "2028-05-31", "25000", "24000", "2026-06-01"]]));
    fs.writeFileSync(path.join(dir, "broken.html"), table([["Property", "EPC expiry", "Deposit returned by", "Status"], ["12 High St", "#VALUE!", "Err:502", "###"]]));
    const r = rules(path.join(dir, "fixed.html"), path.join(dir, "broken.html"));
    expect(r["fixed.html"]).toEqual({ errors: [], serials: [] });
    expect(r["broken.html"].errors).toEqual(["table 1 row 2 column 'EPC expiry' shows #VALUE!", "table 1 row 2 column 'Deposit returned by' shows Err:502",
      "table 1 row 2 column 'Status' shows ###"]);
  });

  it.skipIf(!HAVE_TOOLS)("in the sandbox: a CSV is opened in the office application when one is installed, and says so plainly when not", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "qa3-ws-"));
    try {
      fs.writeFileSync(path.join(ws, "qa.py"), QA_INSPECTOR_PY);
      fs.writeFileSync(path.join(ws, "tracker.csv"), "Property,Gas safety last,Gas safety due\n12 High St,2025-08-30,=B2+365\n");
      fs.writeFileSync(path.join(ws, "spec.json"), JSON.stringify({ files: ["tracker.csv"], cases: [], renderDir: ".tmp/qa-render" }));
      const r = await runSandboxed(ws, "python3 qa.py spec.json", { timeoutMs: 180_000, maxOutput: 4_000_000, toolsDir: DEV_TOOLS });
      expect(r.timedOut).toBe(false);
      const report = parseInspectorReport(r.output.trim().split("\n").at(-1)!);
      const f = report.files[0];
      if (RENDERER) {
        expect(f.checks.find((c) => c.id === "csv_displayed_dates")).toMatchObject({ status: "fail", detail: expect.stringContaining("'Gas safety due' shows") });
        expect(f.ok).toBe(false);
      } else {
        expect(f.checks.find((c) => c.id === "csv_as_displayed")).toMatchObject({ status: "warn", detail: expect.stringContaining("not opened in an office application") });
        expect(f.checks.some((c) => c.id === "csv_displayed_dates")).toBe(false);
      }
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }, 240_000);

  // 2026-10-19 (found proving the revision path on the production host): LibreOffice saves =A2+365 under a date format as a
  // date; the formula engine computes the day number. They are the same value: a recalculated workbook passes.
  it.skipIf(!HAVE_TOOLS)("a saved date equals the engine's day number: a recalculated date formula passes, a wrong one still fails", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "qa3-dates-"));
    try {
      fs.writeFileSync(path.join(ws, "qa.py"), QA_INSPECTOR_PY);
      const make = (name: string, offset: number) => execFileSync(path.join(DEV_TOOLS, "bin/fleet-python"), ["-c", String.raw`
import datetime, sys, xlsxwriter
wb = xlsxwriter.Workbook(sys.argv[1]); ws = wb.add_worksheet("Tracker"); d = wb.add_format({"num_format": "dd/mm/yyyy"}); b = wb.add_format({"bold": True})
ws.write_row(0, 0, ["Start", "Renewal"], b)
start = datetime.date(2026, 1, 5)
ws.write_datetime(1, 0, datetime.datetime(2026, 1, 5), d)
serial = (start - datetime.date(1899, 12, 30)).days + 365 + int(sys.argv[2])
ws.write_formula(1, 1, "=A2+365", d, serial)
wb.close()`, path.join(ws, name), String(offset)]);
      make("good.xlsx", 0);
      make("bad.xlsx", 1);
      fs.writeFileSync(path.join(ws, "spec.json"), JSON.stringify({ files: ["good.xlsx", "bad.xlsx"], cases: [], renderDir: ".tmp/qa-render" }));
      const r = await runSandboxed(ws, "python3 qa.py spec.json", { timeoutMs: 180_000, maxOutput: 4_000_000, toolsDir: DEV_TOOLS });
      const report = parseInspectorReport(r.output.trim().split("\n").at(-1)!);
      const [good, bad] = report.files;
      expect(good.checks.find((c) => c.id === "cached_values")).toMatchObject({ status: "pass" });
      expect(bad.checks.find((c) => c.id === "cached_values")).toMatchObject({ status: "fail", detail: expect.stringContaining("Tracker!B2") });
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }, 240_000);

  // 2026-10-21 (launch check): Agent-1's tracker saved 1,194 template-row formulas such as =IF(D3="","",EDATE(D3,12)) with an
  // empty value; every one recalculates to empty text, so previewers show what they should — blank. The check called them
  // "saved without a value", and the office application's own recalculation (empty text results, t="str") failed it too.
  it.skipIf(!HAVE_TOOLS)("a formula whose result is blank, saved blank, is saved correctly; a formula that should show something still is not", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "qa3-blank-"));
    try {
      fs.writeFileSync(path.join(ws, "qa.py"), QA_INSPECTOR_PY);
      execFileSync(path.join(DEV_TOOLS, "bin/fleet-python"), ["-c", String.raw`
import sys, zipfile, xlsxwriter
def make(name, office):
    wb = xlsxwriter.Workbook(name); ws = wb.add_worksheet("Tracker")
    ws.write_row(0, 0, ["Start", "Renewal", "Status"])
    ws.write_number(1, 0, 5)
    ws.write_formula(1, 1, '=IF(A2="","",A2*2)', None, 10)          # data row: saved value
    ws.write_formula(2, 1, '=IF(A3="","",A3*2)', None, "")          # template row: blank result, saved blank
    ws.write_formula(2, 2, '=IF(A3="","","OK")', None, "")
    wb.close()
    if office:  # as the office application saves an empty text result
        z = zipfile.ZipFile(name); parts = {n: z.read(n) for n in z.namelist()}; z.close()
        x = parts["xl/worksheets/sheet1.xml"].decode()
        x = x.replace('<c r="B3">', '<c r="B3" t="str">').replace('<c r="C3">', '<c r="C3" t="str">')
        parts["xl/worksheets/sheet1.xml"] = x.encode()
        with zipfile.ZipFile(name, "w") as z:
            for n, b in parts.items(): z.writestr(n, b)
def unsaved(name):
    wb = xlsxwriter.Workbook(name); ws = wb.add_worksheet("Tracker")
    ws.write_number(1, 0, 5)
    ws.write_formula(1, 1, "=A2*2", None, "")                          # should show 10: saved blank
    ws.write_formula(1, 2, '=IF(A2="","","OK")', None, "")       # should show OK: saved blank
    wb.close()
make("xlsxwriter.xlsx", False); make("office.xlsx", True); unsaved("unsaved.xlsx")`], { cwd: ws });
      fs.writeFileSync(path.join(ws, "spec.json"), JSON.stringify({ files: ["xlsxwriter.xlsx", "office.xlsx", "unsaved.xlsx"], cases: [], renderDir: ".tmp/qa-render" }));
      const r = await runSandboxed(ws, "python3 qa.py spec.json", { timeoutMs: 180_000, maxOutput: 4_000_000, toolsDir: DEV_TOOLS });
      const report = parseInspectorReport(r.output.trim().split("\n").at(-1)!);
      const check = (i: number) => report.files[i].checks.find((c) => c.id === "cached_values");
      expect(check(0)).toMatchObject({ status: "pass" });
      expect(check(1)).toMatchObject({ status: "pass" });
      expect(check(2)).toMatchObject({ status: "warn", detail: expect.stringContaining("2 formula cell(s) saved without a value") });
      expect(check(2)!.detail).toContain("Tracker!B2");
      expect(check(2)!.detail).toContain("Tracker!C2");
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }, 240_000);
});

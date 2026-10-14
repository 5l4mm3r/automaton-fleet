/**
 * Deliverable QA inspector (fleet-qa-1) under the agent toolchain.
 *
 * Proves, end to end inside the founder exec sandbox (runSandboxed + toolsDir): fixtures built with the pinned
 * wheels (XlsxWriter, python-docx, reportlab, Pillow) are judged correctly — a good workbook recalculates clean
 * and its acceptance case passes while a wrong expectation fails; #DIV/0! / #REF! fail with addresses; a docx
 * TODO fails and its typo is reported; a text PDF passes while a blank page fails; a blank PNG fails; a ZIP bundle
 * is inspected member by member; a PNG named .pdf fails; a path out of the workspace is refused. The report
 * parser is strict. Skips cleanly when the dev toolchain ($HOME/.cache/automaton-fleet-tools/dev) is absent; when
 * the kernel has no Landlock the inspector runs directly under fleet-python (the test name says so).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { runSandboxed } from "../../fleet/founder/exec-sandbox.js";
import { QA_INSPECTOR_PY, QA_INSPECTOR_VERSION, parseInspectorReport, type QaFileReport, type QaInspectorReport } from "../../fleet/founder/qa/inspector.js";

const DEV_TOOLS = path.join(os.homedir(), ".cache/automaton-fleet-tools/dev");
const HAVE_TOOLS = fs.existsSync(path.join(DEV_TOOLS, "site")) && fs.existsSync(path.join(DEV_TOOLS, "bin/fleet-python"));

/** Built inside the sandbox with the toolchain's own libraries. */
const FIXTURES_PY = String.raw`
import json, zipfile
import xlsxwriter
from docx import Document
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from PIL import Image, ImageDraw

wb = xlsxwriter.Workbook("good.xlsx")
ws = wb.add_worksheet("Model")
ws.write_row("A1", ["Item", "Qty", "Price", "Total"])
ws.write_row("A2", ["Widget", 10, 2.5])
ws.write_row("A3", ["Gadget", 4, 10])
ws.write_formula("D2", "=B2*C2", None, 25)
ws.write_formula("D3", "=B3*C3", None, 40)
ws.write_formula("D4", "=SUM(D2:D3)", None, 65)
ws.data_validation("B2:B3", {"validate": "integer", "criteria": ">=", "value": 0})
ch = wb.add_chart({"type": "column"})
ch.add_series({"categories": "=Model!$A$2:$A$3", "values": "=Model!$D$2:$D$3"})
ws.insert_chart("F2", ch)
wb.close()

wb = xlsxwriter.Workbook("broken.xlsx")
ws = wb.add_worksheet("Calc")
ws.write("A1", 5)
ws.write("A2", 0)
ws.write_formula("B1", "=A1/A2", None, 0)
ws.write_formula("B2", "=#REF!+1", None, 0)
ws.write_formula("B3", "=A1*2", None, 10)
wb.close()

d = Document()
d.add_heading("Quarterly Report", level=1)
d.add_paragraph("We will recieve the payment next week.")
d.add_paragraph("TODO: add the revenue table.")
d.save("report.docx")

c = canvas.Canvas("brochure.pdf", pagesize=A4)
c.setFont("Helvetica", 14)
c.drawString(72, 760, "Spring offer: two widgets for the price of one.")
c.showPage()
c.save()

c = canvas.Canvas("blankpage.pdf", pagesize=A4)
c.showPage()
c.save()

Image.new("RGB", (64, 64), (255, 255, 255)).save("blank.png")
im = Image.new("RGB", (64, 64), (255, 255, 255))
dr = ImageDraw.Draw(im)
dr.rectangle([8, 8, 40, 40], fill=(200, 30, 30))
dr.line([0, 63, 63, 0], fill=(0, 0, 120), width=3)
im.save("logo.png")

with zipfile.ZipFile("bundle.zip", "w", zipfile.ZIP_DEFLATED) as z:
    z.write("good.xlsx", "deliverable/good.xlsx")
    z.writestr("deliverable/readme.txt", "Open the workbook and edit the yellow cells.\n")

with open("fake.pdf", "wb") as f:
    f.write(open("logo.png", "rb").read())

json.dump({
    "files": ["good.xlsx", "broken.xlsx", "report.docx", "brochure.pdf", "blankpage.pdf", "blank.png", "logo.png", "bundle.zip", "fake.pdf", "../escape.txt"],
    "cases": [
        {"name": "price-up", "file": "good.xlsx", "sheet": "Model", "inputs": {"C2": 3}, "expect": {"D2": 30, "D4": 70}, "tolerance": 0.01},
        {"name": "wrong", "file": "good.xlsx", "sheet": "Model", "inputs": {"B3": 5}, "expect": {"D4": 999}},
    ],
    "renderDir": ".tmp/qa-render",
}, open("spec.json", "w"))
print("FIXTURES_OK")
`;

/** Landlock probe without the toolchain: decides whether the end-to-end run is sandboxed. */
async function landlockAvailable(ws: string): Promise<boolean> {
  const r = await runSandboxed(ws, "echo up", { timeoutMs: 15_000, maxOutput: 4_000 });
  return !r.sandboxUnavailable && r.output.includes("up");
}

let root = "";
let ws = "";
let sandboxed = false;
let report: QaInspectorReport;
let raw = "";

const file = (p: string): QaFileReport => {
  const f = report.files.find((x) => x.path === p);
  if (!f) throw new Error(`no report for ${p}`);
  return f;
};
const status = (p: string, id: string) => file(p).checks.filter((c) => c.id === id).map((c) => c.status);
const detail = (p: string, id: string) => file(p).checks.filter((c) => c.id === id).map((c) => c.detail).join(" | ");

describe.skipIf(!HAVE_TOOLS)("deliverable QA inspector (fleet-qa-1)", () => {
  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-qa-")));
    ws = path.join(root, "workspace");
    fs.mkdirSync(ws);
    fs.writeFileSync(path.join(ws, "make_fixtures.py"), FIXTURES_PY);
    fs.writeFileSync(path.join(ws, "qa_inspector.py"), QA_INSPECTOR_PY);
    sandboxed = await landlockAvailable(ws);
    const cmd = "python3 make_fixtures.py && python3 qa_inspector.py spec.json";
    if (sandboxed) {
      const r = await runSandboxed(ws, cmd, { timeoutMs: 120_000, maxOutput: 2_000_000, toolsDir: DEV_TOOLS });
      expect(r.sandboxUnavailable).toBe(false);
      expect(r.timedOut).toBe(false);
      raw = r.output;
    } else {
      console.warn("Landlock unavailable on this host: running the inspector directly under fleet-python (NOT sandboxed)");
      raw = execFileSync(path.join(DEV_TOOLS, "bin/fleet-python"), ["-c", `import subprocess, sys; sys.exit(subprocess.call(${JSON.stringify(cmd)}, shell=True))`], {
        cwd: ws,
        env: { PATH: `${DEV_TOOLS}/bin:/usr/bin:/bin`, HOME: ws, LANG: "C.UTF-8" },
        timeout: 120_000,
      }).toString();
    }
    expect(raw).toContain("FIXTURES_OK");
    report = parseInspectorReport(raw);
  }, 180_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("runs inside the exec sandbox with toolsDir (or says it could not)", () => {
    console.info(sandboxed ? "inspector ran under Landlock with toolsDir" : "inspector ran directly (no Landlock)");
    expect(report.inspector).toBe(QA_INSPECTOR_VERSION);
    expect(report.files.map((f) => f.path)).toEqual(["good.xlsx", "broken.xlsx", "report.docx", "brochure.pdf", "blankpage.pdf", "blank.png", "logo.png", "bundle.zip", "fake.pdf", "../escape.txt"]);
    expect(report.ok).toBe(false);
    expect(file("good.xlsx").sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("xlsx: a good workbook recalculates clean; its acceptance case passes and a wrong expectation fails", () => {
    const f = file("good.xlsx");
    expect(f.detectedType).toBe("xlsx");
    expect(f.extensionMatches).toBe(true);
    for (const id of ["size", "extension_matches", "zip_integrity", "macros", "external_links", "xlsx_load", "placeholders", "recalc", "formula_errors", "cached_values"]) {
      expect(status("good.xlsx", id), id).toEqual(["pass"]);
    }
    expect(status("good.xlsx", "case:price-up")).toEqual(["pass"]);
    expect(status("good.xlsx", "case:wrong")).toEqual(["fail"]);
    expect(detail("good.xlsx", "case:wrong")).toContain("D4=75.0 (want 999)");
    expect(f.facts).toMatchObject({ formulaCount: 3, chartCount: 1, dataValidationCount: 1 });
    expect(f.ok).toBe(false); // only because of case:wrong
  });

  it("xlsx: #DIV/0! and #REF! fail with their addresses", () => {
    expect(status("broken.xlsx", "formula_errors")).toEqual(["fail"]);
    expect(detail("broken.xlsx", "formula_errors")).toMatch(/Calc!B1=#DIV\/0!.*Calc!B2=#REF!/);
    expect(file("broken.xlsx").facts.errorCells).toEqual([
      { cell: "Calc!B1", error: "#DIV/0!" },
      { cell: "Calc!B2", error: "#REF!" },
    ]);
  });

  it("docx: outline, a TODO fails, the typo is reported (advisory)", () => {
    const f = file("report.docx");
    expect(f.detectedType).toBe("docx");
    expect(status("report.docx", "docx_load")).toEqual(["pass"]);
    expect(status("report.docx", "placeholders")).toEqual(["fail"]);
    expect(status("report.docx", "spelling")).toEqual(["warn"]);
    expect(f.facts.spellingUnknown).toContain("recieve");
    expect(f.facts.headings).toEqual([{ level: 1, text: "Quarterly Report" }]);
    expect(f.ok).toBe(false);
  });

  it("pdf: a text page passes and is rendered; a blank page fails", () => {
    const good = file("brochure.pdf");
    expect(good.ok).toBe(true);
    for (const id of ["pdf_load", "pages_without_text", "fonts_embedded", "placeholders", "blank_pages"]) expect(status("brochure.pdf", id), id).toEqual(["pass"]);
    const renders = good.facts.renders as string[];
    expect(renders).toHaveLength(1);
    expect(fs.existsSync(path.join(ws, renders[0]))).toBe(true);
    expect(status("blankpage.pdf", "pages_without_text")).toEqual(["warn"]);
    expect(status("blankpage.pdf", "blank_pages")).toEqual(["fail"]);
  });

  it("images: blank fails, a real image passes; a PNG named .pdf fails on extension", () => {
    expect(status("blank.png", "blank_image")).toEqual(["fail"]);
    expect(file("logo.png").ok).toBe(true);
    expect(file("logo.png").facts).toMatchObject({ format: "PNG", width: 64, height: 64 });
    const fake = file("fake.pdf");
    expect(fake.detectedType).toBe("png");
    expect(fake.extensionMatches).toBe(false);
    expect(status("fake.pdf", "extension_matches")).toEqual(["fail"]);
  });

  it("zip: members are inspected one level deep", () => {
    const f = file("bundle.zip");
    expect(f.ok).toBe(true);
    expect(status("bundle.zip", "nested_files")).toEqual(["pass"]);
    const nested = f.facts.nested as { name: string; detectedType: string; ok: boolean }[];
    expect(nested.map((n) => [n.name, n.detectedType, n.ok])).toEqual([
      ["deliverable/good.xlsx", "xlsx", true],
      ["deliverable/readme.txt", "text", true],
    ]);
  });

  it("refuses a path that leaves the workspace", () => {
    const f = file("../escape.txt");
    expect(f.ok).toBe(false);
    expect(status("../escape.txt", "path")).toEqual(["fail"]);
    expect(f.sha256).toBe("");
  });
});

describe("parseInspectorReport", () => {
  const good = {
    inspector: "fleet-qa-1",
    files: [{ path: "a.png", sha256: "a".repeat(64), sizeBytes: 3, detectedType: "png", extensionMatches: true, ok: true, checks: [{ id: "size", status: "pass", detail: "3 bytes" }], facts: {} }],
    ok: true,
  };
  const line = (o: unknown) => `noise on stderr\n${JSON.stringify(o)}\n`;

  it("accepts a well-formed report among other output", () => {
    expect(parseInspectorReport(line(good)).files[0].checks[0].id).toBe("size");
  });

  it("rejects unknown keys, bad enums, inconsistent ok and missing reports", () => {
    expect(() => parseInspectorReport("")).toThrow(/no report line/);
    expect(() => parseInspectorReport(line({ ...good, extra: 1 }))).toThrow(/unknown key extra/);
    expect(() => parseInspectorReport(line({ ...good, inspector: "fleet-qa-0" }))).toThrow(/is not fleet-qa-1/);
    const f0 = good.files[0];
    expect(() => parseInspectorReport(line({ ...good, files: [{ ...f0, detectedType: "exe" }] }))).toThrow(/detectedType/);
    expect(() => parseInspectorReport(line({ ...good, files: [{ ...f0, checks: [{ id: "x", status: "ok", detail: "" }] }] }))).toThrow(/status/);
    expect(() => parseInspectorReport(line({ ...good, files: [{ ...f0, checks: [{ id: "x", status: "fail", detail: "" }] }] }))).toThrow(/ok disagrees/);
    expect(() => parseInspectorReport(line({ ...good, ok: false }))).toThrow(/report.ok disagrees/);
    expect(() => parseInspectorReport(line({ ...good, files: [{ ...f0, sha256: "xyz" }] }))).toThrow(/sha256/);
  });
});

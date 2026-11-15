/**
 * Deliverable QA inspector fleet-qa-2 (runtime founder-v10) under the agent toolchain agent-tools-2, inside the exec
 * sandbox. Representative deliverables built with the toolchain's own libraries:
 *   - a finished presentation (titled slides, text, a table, a picture with alt text, notes) passes;
 *   - a flawed one fails on its empty slide and leftover "Click to add …" prompt, and warns on the overfull text box, the
 *     picture without alt text, the untitled slide, the TODO and the misspelling;
 *   - a valid EPUB (built with ebooklib) passes the package / navigation / spine checks; a broken one fails them;
 *   - a chart image made with matplotlib is checked like any image;
 *   - Word and PowerPoint files say plainly when they were NOT rendered (no office renderer installed here), and an
 *     image-only PDF page says when OCR is not installed — a check that did not run never passes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { runSandboxed } from "../../fleet/founder/exec-sandbox.js";
import { QA_INSPECTOR_PY, QA_INSPECTOR_VERSION, parseInspectorReport, type QaFileReport, type QaInspectorReport } from "../../fleet/founder/qa/inspector.js";

const DEV_TOOLS = path.join(os.homedir(), ".cache/automaton-fleet-tools/dev");
const HAVE_TOOLS = fs.existsSync(path.join(DEV_TOOLS, "site/pptx")) && fs.existsSync(path.join(DEV_TOOLS, "site/ebooklib")) && fs.existsSync(path.join(DEV_TOOLS, "bin/fleet-python"));
const RENDERER = ["/usr/bin/soffice", "/usr/bin/libreoffice"].some((p) => fs.existsSync(p));

const FIXTURES_PY = String.raw`
import json, zipfile, io
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from pptx import Presentation
from pptx.util import Inches, Pt
from docx import Document
from ebooklib import epub
from reportlab.pdfgen import canvas
from PIL import Image

# A chart image (matplotlib), also used in the decks.
fig, ax = plt.subplots(figsize=(6, 3)); ax.bar(["Jan", "Feb", "Mar"], [1200, 1450, 900]); ax.set_title("Cash in by month"); fig.tight_layout(); fig.savefig("chart.png", dpi=110)

def deck(name, flawed):
    prs = Presentation()
    s = prs.slides.add_slide(prs.slide_layouts[0])
    s.shapes.title.text = "Cash-flow forecasting for small businesses"
    s.placeholders[1].text = "A 13-week rolling forecast you can keep up to date in ten minutes a week"
    s = prs.slides.add_slide(prs.slide_layouts[1])
    s.shapes.title.text = "Why forecast cash, not profit"
    s.placeholders[1].text = "Profit is an opinion; cash is a fact.\nSuppliers and payroll are paid in cash.\nA forecast shows the gap before it happens."
    s.notes_slide.notes_text_frame.text = "Open with the late-payment story."
    s = prs.slides.add_slide(prs.slide_layouts[5])
    s.shapes.title.text = "Receipts by month"
    pic = s.shapes.add_picture("chart.png", Inches(1), Inches(1.6), width=Inches(7))
    if not flawed:
        pic._element.xpath("./p:nvPicPr/p:cNvPr")[0].set("descr", "Bar chart of cash received in January, February and March")
    s = prs.slides.add_slide(prs.slide_layouts[5])
    s.shapes.title.text = "Weekly checklist"
    rows = [("Week", "Opening cash", "Receipts", "Payments"), ("1", "4,200", "1,800", "2,100"), ("2", "3,900", "2,300", "1,700")]
    t = s.shapes.add_table(3, 4, Inches(0.5), Inches(1.6), Inches(9), Inches(1.5)).table
    for r, row in enumerate(rows):
        for c, v in enumerate(row):
            t.cell(r, c).text = v
    if flawed:
        prs.slides.add_slide(prs.slide_layouts[6])                                   # an empty slide
        s = prs.slides.add_slide(prs.slide_layouts[1])
        s.shapes.title.text = "Next steps"
        s.placeholders[1].text = "Click to add text"                                # a leftover template prompt
        s = prs.slides.add_slide(prs.slide_layouts[6])                                # no title
        tb = s.shapes.add_textbox(Inches(1), Inches(1), Inches(3), Inches(0.6))
        p = tb.text_frame.paragraphs[0]; p.text = "TODO: write the summary of the forecasting method and the recieved payments " * 6
        p.runs[0].font.size = Pt(24)                                                  # far too much text for the box
    prs.save(name)

deck("pitch.pptx", False)
deck("flawed.pptx", True)

d = Document(); d.add_heading("Quick-start guide", 0); d.add_paragraph("Fill in the opening balance, then each week's receipts and payments."); d.save("guide.docx")

b = epub.EpubBook(); b.set_identifier("guide-1"); b.set_title("Cash-flow guide"); b.set_language("en")
c1 = epub.EpubHtml(title="Start", file_name="start.xhtml", lang="en"); c1.content = "<h1>Start</h1><p>Open the workbook.</p>"
b.add_item(c1); b.toc = [c1]; b.spine = ["nav", c1]; b.add_item(epub.EpubNcx()); b.add_item(epub.EpubNav()); epub.write_epub("guide.epub", b)
# A broken EPUB: the manifest names a chapter that is not in the archive, and there is no navigation.
with zipfile.ZipFile("broken.epub", "w") as z:
    z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip")
    z.writestr("META-INF/container.xml", '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
    z.writestr("OEBPS/content.opf", '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest><item id="c1" href="missing.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>')

# A PDF whose only page is an image (scanned-like): no text layer.
img = Image.new("RGB", (595, 842), "white")
from PIL import ImageDraw
ImageDraw.Draw(img).rectangle([60, 60, 535, 300], outline="black", width=4)
img.save("scan.png")
cv = canvas.Canvas("scan.pdf"); cv.drawImage("scan.png", 0, 0, width=595, height=842); cv.showPage(); cv.save()

json.dump({"files": ["pitch.pptx", "flawed.pptx", "guide.docx", "guide.epub", "broken.epub", "chart.png", "scan.pdf"], "renderDir": ".tmp/qa-render"}, open("spec.json", "w"))
print("FIXTURES_OK")
`;

async function landlockAvailable(ws: string): Promise<boolean> {
  const r = await runSandboxed(ws, "echo up", { timeoutMs: 15_000, maxOutput: 4_000 });
  return !r.sandboxUnavailable && r.output.includes("up");
}

describe.skipIf(!HAVE_TOOLS)(`deliverable QA inspector ${QA_INSPECTOR_VERSION}: presentations, e-books, charts, rendering and OCR honesty`, () => {
  let root = "", ws = "", sandboxed = false, report: QaInspectorReport;
  const file = (p: string): QaFileReport => report.files.find((x) => x.path === p)!;
  const check = (p: string, id: string) => file(p).checks.find((c) => c.id === id);

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-qa2-")));
    ws = path.join(root, "workspace");
    fs.mkdirSync(ws);
    fs.writeFileSync(path.join(ws, "make_fixtures.py"), FIXTURES_PY);
    fs.writeFileSync(path.join(ws, "qa_inspector.py"), QA_INSPECTOR_PY);
    sandboxed = await landlockAvailable(ws);
    const cmd = "python3 make_fixtures.py && python3 qa_inspector.py spec.json";
    let raw: string;
    if (sandboxed) {
      const r = await runSandboxed(ws, cmd, { timeoutMs: 180_000, maxOutput: 2_000_000, toolsDir: DEV_TOOLS });
      expect(r.timedOut).toBe(false);
      raw = r.output;
    } else {
      console.warn("Landlock unavailable on this host: running the inspector directly under fleet-python (NOT sandboxed)");
      raw = execFileSync(path.join(DEV_TOOLS, "bin/fleet-python"), ["-c", `import subprocess, sys; sys.exit(subprocess.call(${JSON.stringify(cmd)}, shell=True))`],
        { cwd: ws, env: { PATH: `${DEV_TOOLS}/bin:/usr/bin:/bin`, HOME: ws, LANG: "C.UTF-8", MPLBACKEND: "Agg" }, timeout: 180_000 }).toString();
    }
    expect(raw).toContain("FIXTURES_OK");
    report = parseInspectorReport(raw);
  }, 240_000);
  afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it("a finished presentation passes: slides, titles, table, a picture with alt text, notes", () => {
    expect(report.inspector).toBe(QA_INSPECTOR_VERSION);
    const f = file("pitch.pptx");
    expect(f.detectedType).toBe("pptx");
    expect(f.ok).toBe(true);
    expect(f.facts).toMatchObject({ slides: 4, pictures: 1, tables: 1, slidesWithNotes: 1 });
    expect((f.facts.titles as string[])[0]).toBe("Cash-flow forecasting for small businesses");
    for (const id of ["slides", "empty_slides", "placeholder_prompts", "slide_titles", "alt_text", "text_overflow"]) expect(check("pitch.pptx", id)?.status, id).toBe("pass");
  });

  it("a flawed presentation fails on the empty slide and the leftover prompt, and warns on overflow, missing alt text, a missing title, a TODO and a typo", () => {
    const f = file("flawed.pptx");
    expect(f.ok).toBe(false);
    expect(check("flawed.pptx", "empty_slides")).toMatchObject({ status: "fail", detail: expect.stringContaining("[5]") });
    expect(check("flawed.pptx", "placeholder_prompts")).toMatchObject({ status: "fail", detail: expect.stringContaining("[6]") });
    expect(check("flawed.pptx", "text_overflow")).toMatchObject({ status: "warn", detail: expect.stringContaining("slide 7") });
    expect(check("flawed.pptx", "alt_text")).toMatchObject({ status: "warn", detail: expect.stringContaining("[3]") });
    expect(check("flawed.pptx", "slide_titles")?.status).toBe("warn");
    expect(f.checks.some((c) => c.id === "placeholders" && c.status === "fail" && /TODO/.test(c.detail))).toBe(true);
    expect(f.checks.find((c) => c.id === "spelling")?.detail ?? "").toMatch(/recieved/);
  });

  it("presentations and Word files say plainly whether they were rendered", () => {
    for (const p of ["pitch.pptx", "guide.docx"]) {
      const id = p.endsWith(".pptx") ? "pptx_render" : "docx_render";
      if (RENDERER) expect(check(p, id)?.status, p).toBe("pass");
      else expect(check(p, id), p).toMatchObject({ status: "warn", detail: expect.stringContaining("not rendered") });
    }
  });

  it("EPUB: a valid book passes the package, navigation and reading-order checks; a broken one fails them", () => {
    for (const id of ["epub_container", "epub_package", "epub_navigation", "epub_spine"]) expect(check("guide.epub", id)?.status, id).toBe("pass");
    expect(file("broken.epub").ok).toBe(false);
    expect(check("broken.epub", "epub_package")).toMatchObject({ status: "fail", detail: expect.stringContaining("missing.xhtml") });
    expect(check("broken.epub", "epub_navigation")?.status).toBe("fail");
  });

  it("a matplotlib chart is an image like any other; an image-only PDF page says OCR did not run (never a silent pass)", () => {
    expect(file("chart.png").ok).toBe(true);
    const ocr = check("scan.pdf", "ocr");
    expect(ocr?.status).toBe("warn");
    expect(ocr?.detail).toMatch(/OCR is not installed|OCR found no words|recognised/);
  });
});

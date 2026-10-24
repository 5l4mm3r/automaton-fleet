/**
 * Desktop run 3 (2026-10-24, Qwen3.5-9B): both delivered checklists passed the inspector and the agent's review with text
 * cut off by the page edge — the first showed 2 of its 10 points (the rest ran past the right margin), the revision a
 * clipped title. Inspector fleet-qa-3 now fails a PDF with visible text outside the page's crop box, naming the page and
 * where the lost text starts. Run 4 (same day): a revision's table rows ran over the next column and the row number — text
 * over text now fails too. Run 5: a PDF written by hand whose content stream was damaged showed only its title in a viewer
 * and passed as "no text layer" — a page whose content cannot be read now fails. Pages whose text fits, superscripts grazing the line above, a heading drawn three times for
 * bold and underscores pass. Needs the pinned agent tools (pypdfium2, reportlab).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { QA_INSPECTOR_PY, parseInspectorReport } from "../../fleet/founder/qa/inspector.js";

const PY = path.join(os.homedir(), ".cache/automaton-fleet-tools/dev/bin/fleet-python");

const MAKE = String.raw`
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
c = canvas.Canvas("runs-off.pdf", pagesize=A4)
c.setFont("Helvetica", 11)
c.drawString(50, 780, "Gas safety: the landlord's annual 10-point checklist (England)")
c.drawString(50, 750, " ".join("[ ] %d. Gas safety check completed by a Gas Safe registered engineer." % i for i in range(1, 11)))
c.save()
c = canvas.Canvas("clipped-title.pdf", pagesize=A4)
c.setFont("Helvetica-Bold", 18)
c.drawString(50, 780, "GAS SAFETY: THE LANDLORD'S ANNUAL 10-POINT CHECKLIST (England)")
c.setFont("Helvetica", 11)
for i in range(10): c.drawString(60, 740 - i * 30, "[ ] %d. A point that fits on the page" % (i + 1))
c.save()
c = canvas.Canvas("overlaps.pdf", pagesize=A4)
c.setFont("Helvetica", 10)
for i in range(1, 11):
    y = 780 - i * 20
    c.drawString(50, y, str(i)); c.drawString(70, y, "Inspect the gas appliances for proper installation and ventilation"); c.drawString(300, y, "[ ]   ____")
c.save()
c = canvas.Canvas("hard-but-fine.pdf", pagesize=A4)
for j in range(10):
    y = 780 - j * 22
    c.setFont("Helvetica", 12)
    for dx in (0, 0.3, 0.6): c.drawString(50 + dx, y, "Bold heading %d drawn three times" % j)
    c.drawString(50, y - 10, "Name: ______________________  Date: ____/____/______")
c.save()
from reportlab.platypus import SimpleDocTemplate, Paragraph
from reportlab.lib.styles import getSampleStyleSheet
SimpleDocTemplate("superscript.pdf", pagesize=A4).build([Paragraph("E = mc<super>2</super>, H<sub>2</sub>O, 1<super>st</super> floor, x<super>2</super>+y<super>2</super> " * 20, getSampleStyleSheet()["Normal"])])
# Run 5's shape: PDF syntax written by hand — a /Length past the stream, no 'endstream', a wrong startxref.
body = (b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"
    b"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n"
    b"4 0 obj\n<< /Length 2000 >>\nstream\nBT\n/F1 18 Tf\n50 750 Td\n(Gas Safety Checklist) Tj\nET\n1. Gas Safety Certificate held\n[ ] Yes [ ] No\n"
    b"endobj\n5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n")
open("hand-written.pdf", "wb").write(body + b"xref\n0 6\n0000000000 65535 f \ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n9999\n%%EOF\n")
c = canvas.Canvas("fits.pdf", pagesize=A4)
c.setFont("Helvetica-Bold", 16)
c.drawString(50, 780, "Gas safety: the landlord's annual checklist")
c.setFont("Helvetica", 11)
for i in range(10): c.drawString(60, 740 - i * 30, "[ ] %d. A point that fits on the page" % (i + 1))
c.save()
`;

describe.skipIf(!fs.existsSync(PY))("inspector: what a PDF viewer actually shows (desktop runs 3–5)", () => {
  let dir = "";
  beforeAll(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qa-off-")));
    execFileSync(PY, ["-c", MAKE], { cwd: dir });
    fs.writeFileSync(path.join(dir, "insp.py"), QA_INSPECTOR_PY);
    fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify({ files: ["runs-off.pdf", "clipped-title.pdf", "overlaps.pdf", "hard-but-fine.pdf", "superscript.pdf", "hand-written.pdf", "fits.pdf"], cases: [], renderDir: ".r" }));
  });
  afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("fails text past the page edge, naming the page and where the lost text starts; text that fits passes", () => {
    const report = parseInspectorReport(execFileSync(PY, ["-P", "-s", "insp.py", "spec.json"], { cwd: dir, encoding: "utf8" }));
    const check = (f: string, id = "text_off_page") => report.files.find((x) => x.path === f)!.checks.find((c) => c.id === id)!;
    expect(check("runs-off.pdf").status).toBe("fail");
    expect(check("runs-off.pdf").detail).toMatch(/^text runs off the page, unseen by the buyer: p1: \d+ character\(s\)/);
    expect(check("clipped-title.pdf").status).toBe("fail");
    expect(check("clipped-title.pdf").detail).toContain("(England)");
    expect(check("fits.pdf").status).toBe("pass");
    expect(report.files.find((x) => x.path === "fits.pdf")!.ok).toBe(true);
    expect(report.files.find((x) => x.path === "runs-off.pdf")!.ok).toBe(false);
  });

  it("fails text drawn over other text; superscripts, a heading drawn three times and underscores pass", () => {
    const report = parseInspectorReport(execFileSync(PY, ["-P", "-s", "insp.py", "spec.json"], { cwd: dir, encoding: "utf8" }));
    const check = (f: string) => report.files.find((x) => x.path === f)!.checks.find((c) => c.id === "text_overlap")!;
    expect(check("overlaps.pdf").status).toBe("fail");
    expect(check("overlaps.pdf").detail).toMatch(/^text is drawn over other text: p1: \d+ character\(s\) drawn over other text \(from "/);
    expect(check("overlaps.pdf").detail).toContain("wrap it inside its cell or column");
    for (const f of ["hard-but-fine.pdf", "superscript.pdf", "fits.pdf", "runs-off.pdf"]) expect(check(f).status, f).toBe("pass");
    for (const f of ["hard-but-fine.pdf", "superscript.pdf"]) expect(report.files.find((x) => x.path === f)!.ok, f).toBe(true);
  });

  it("fails a page whose content cannot be read (a damaged stream), instead of calling it a page without a text layer", () => {
    const report = parseInspectorReport(execFileSync(PY, ["-P", "-s", "insp.py", "spec.json"], { cwd: dir, encoding: "utf8" }));
    const file = report.files.find((x) => x.path === "hand-written.pdf")!;
    const check = (id: string) => file.checks.find((c) => c.id === id)!;
    expect(check("pdf_content").status).toBe("fail");
    expect(check("pdf_content").detail).toMatch(/^the page content cannot be read — the file is damaged .*: p1 \(/);
    expect(check("pdf_content").detail).toContain("never by writing PDF syntax by hand");
    expect(check("pages_without_text").status).toBe("pass");                       // not mistaken for a scan
    expect(file.ok).toBe(false);
    for (const f of ["fits.pdf", "hard-but-fine.pdf", "superscript.pdf", "runs-off.pdf"]) {
      expect(report.files.find((x) => x.path === f)!.checks.find((c) => c.id === "pdf_content")!.status, f).toBe("pass");
    }
  });
});

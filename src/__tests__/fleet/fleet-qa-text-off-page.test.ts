/**
 * Desktop run 3 (2026-10-24, Qwen3.5-9B): both delivered checklists passed the inspector and the agent's review with text
 * cut off by the page edge — the first showed 2 of its 10 points (the rest ran past the right margin), the revision a
 * clipped title. Inspector fleet-qa-3 now fails a PDF with visible text outside the page's crop box, naming the page and
 * where the lost text starts. Run 4 (same day): a revision's table rows ran over the next column and the row number — text
 * over text now fails too. Pages whose text fits, superscripts grazing the line above, a heading drawn three times for
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
c = canvas.Canvas("fits.pdf", pagesize=A4)
c.setFont("Helvetica-Bold", 16)
c.drawString(50, 780, "Gas safety: the landlord's annual checklist")
c.setFont("Helvetica", 11)
for i in range(10): c.drawString(60, 740 - i * 30, "[ ] %d. A point that fits on the page" % (i + 1))
c.save()
`;

describe.skipIf(!fs.existsSync(PY))("inspector: text beyond the page edge", () => {
  let dir = "";
  beforeAll(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qa-off-")));
    execFileSync(PY, ["-c", MAKE], { cwd: dir });
    fs.writeFileSync(path.join(dir, "insp.py"), QA_INSPECTOR_PY);
    fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify({ files: ["runs-off.pdf", "clipped-title.pdf", "overlaps.pdf", "hard-but-fine.pdf", "superscript.pdf", "fits.pdf"], cases: [], renderDir: ".r" }));
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
});

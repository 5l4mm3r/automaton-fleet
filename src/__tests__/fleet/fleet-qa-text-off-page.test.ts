/**
 * Desktop run 3 (2026-10-24, Qwen3.5-9B): both delivered checklists passed the inspector and the agent's review with text
 * cut off by the page edge — the first showed 2 of its 10 points (the rest ran past the right margin), the revision a
 * clipped title. Inspector fleet-qa-3 now fails a PDF with visible text outside the page's crop box, naming the page and
 * where the lost text starts; a page whose text fits passes. Needs the pinned agent tools (pypdfium2, reportlab).
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
    fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify({ files: ["runs-off.pdf", "clipped-title.pdf", "fits.pdf"], cases: [], renderDir: ".r" }));
  });
  afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("fails text past the page edge, naming the page and where the lost text starts; text that fits passes", () => {
    const report = parseInspectorReport(execFileSync(PY, ["-P", "-s", "insp.py", "spec.json"], { cwd: dir, encoding: "utf8" }));
    const check = (f: string) => report.files.find((x) => x.path === f)!.checks.find((c) => c.id === "text_off_page")!;
    expect(check("runs-off.pdf").status).toBe("fail");
    expect(check("runs-off.pdf").detail).toMatch(/^text runs off the page, unseen by the buyer: p1: \d+ character\(s\)/);
    expect(check("clipped-title.pdf").status).toBe("fail");
    expect(check("clipped-title.pdf").detail).toContain("(England)");
    expect(check("fits.pdf").status).toBe("pass");
    expect(report.files.find((x) => x.path === "fits.pdf")!.ok).toBe(true);
    expect(report.files.find((x) => x.path === "runs-off.pdf")!.ok).toBe(false);
  });
});

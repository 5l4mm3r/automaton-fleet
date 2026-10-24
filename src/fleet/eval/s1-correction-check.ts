/**
 * Run 6 (2026-10-24): the scenario reported "completed" while the "revision" was byte-for-byte the first file — the buyer's
 * correction never reached them. Scenario 1's grade now reads the delivered bytes themselves:
 *   - both versions keep the original order: ten numbered points, a usable empty tick box for each (a drawn square or a box
 *     glyph — not a filled one), and the inspector's malformed / clipping / overlap checks pass;
 *   - the revision is not the first file again;
 *   - the buyer's correction is visible where they asked for it: under point 7 (before point 8), a line labelled with a date
 *     of the next (annual) check, with somewhere to write it — a drawn rule or a run of underscores on that line.
 * The agent's own review ("met: true") is not evidence here. Runs in the agent toolchain's Python (pypdfium2), on the host.
 */
import { execFileSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { QA_INSPECTOR_PY, parseInspectorReport } from "../founder/qa/inspector.js";

export const S1_CHECK_PY = String.raw`
import json, re, sys
import pypdfium2 as pdfium, pypdfium2.raw as raw

def lines_of(tp):
    """Visible lines: (text, top, bottom, left, right) from the characters inside the page."""
    out, cur = [], None
    for k in range(tp.count_chars()):
        ch = tp.get_text_range(k, 1)
        if ch in ("\r", "\n"):
            if cur: out.append(cur); cur = None
            continue
        l, b, r, t = tp.get_charbox(k)
        if cur is None:
            cur = [ch, t, b, l, r]
        else:
            cur[0] += ch; cur[1] = max(cur[1], t); cur[2] = min(cur[2], b); cur[3] = min(cur[3], l); cur[4] = max(cur[4], r)
    if cur: out.append(cur)
    return [x for x in out if x[0].strip()]

def doc(path):
    pdf = pdfium.PdfDocument(path)
    pages = []
    for i in range(len(pdf)):
        p = pdf[i]
        cl, cb, cr, ct = p.get_cropbox()
        ls = [x for x in lines_of(p.get_textpage()) if x[3] >= cl - 1 and x[4] <= cr + 1 and x[2] >= cb - 1 and x[1] <= ct + 1]
        boxes, rules = [], []
        for o in p.get_objects():
            if o.type != raw.FPDF_PAGEOBJ_PATH:
                continue
            l, b, r, t = o.get_bounds()
            w, h = r - l, t - b
            if 6 <= w <= 20 and 6 <= h <= 20 and abs(w - h) <= 2.5:
                boxes.append((l, b, r, t))
            elif w >= 40 and h <= 2.5:
                rules.append((l, b, r, t))
        pages.append({"lines": ls, "boxes": boxes, "rules": rules})
    return pages

POINT = re.compile(r"^\s*(?:\[\s?\]\s*)?(\d{1,2})(?:[.)]\s*(?=\S)|\s+(?=[A-Za-z\[]))")
# Empty boxes written as text: a box glyph or a typed "[ ]" (a filled ■ / ☑ / ☒ is already ticked: not usable).
GLYPH_BOX = re.compile(r"[☐□◻⬜]|\[\s?\]")

def original(pages):
    nums, boxes = set(), 0
    for pg in pages:
        boxes += len(pg["boxes"])
        for ln in pg["lines"]:
            m = POINT.match(ln[0])
            if m: nums.add(int(m.group(1)))
            boxes += len(GLYPH_BOX.findall(ln[0]))
    missing = [n for n in range(1, 11) if n not in nums]
    text = " ".join(l[0] for pg in pages for l in pg["lines"]).lower()
    return {"points": sorted(nums), "missingPoints": missing, "tickBoxes": boxes, "gasSafety": "gas safety" in text,
            "ok": not missing and boxes >= 10 and "gas safety" in text}

DATE_LABEL = re.compile(r"date", re.I)
WHICH = re.compile(r"next|annual|check|due|renew", re.I)

def correction(pages):
    for pg in pages:
        ls = pg["lines"]
        i7 = next((i for i, l in enumerate(ls) if (POINT.match(l[0]) or [None, None])[1] == "7"), None) if ls else None
        if i7 is None:
            continue
        top7 = ls[i7][1]
        i8 = next((i for i, l in enumerate(ls) if POINT.match(l[0]) and int(POINT.match(l[0]).group(1)) > 7), None)
        floor = ls[i8][1] if i8 is not None else -1e9
        for l in ls:
            if not (floor < l[1] <= top7):
                continue
            if not (DATE_LABEL.search(l[0]) and WHICH.search(l[0])):
                continue
            # somewhere to write: underscores on the line, or a drawn rule beside or just under the label
            if re.search(r"_{5,}", l[0]):
                return {"found": True, "label": l[0].strip()[:120], "writeIn": "underscores"}
            for (rl, rb, rr, rt) in pg["rules"]:
                if l[2] - 14 <= rb <= l[1] + 2 and rr > l[3] + 40:
                    return {"found": True, "label": l[0].strip()[:120], "writeIn": "drawn line"}
            return {"found": False, "label": l[0].strip()[:120], "why": "a date label under point 7 has no line to write on"}
        return {"found": False, "why": "no line under point 7 (before point 8) names the date of the next annual check"}
    return {"found": False, "why": "point 7 is not on any page"}

first, second = sys.argv[1], sys.argv[2]
a, b = doc(first), doc(second)
print(json.dumps({"first": original(a), "second": {**original(b), "correction": correction(b)}}))
`;

export interface S1Grade {
  ok: boolean;
  reasons: string[];
  identical: boolean;
  first: Record<string, unknown>;
  second: Record<string, unknown>;
}

/** Grade the first and the corrected delivery's bytes. `python` is the agent toolchain's interpreter (pypdfium2, pypdf). */
export function gradeS1Documents(python: string, firstPdf: Buffer, secondPdf: Buffer): S1Grade {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s1-grade-")));
  try {
    fs.writeFileSync(path.join(dir, "first.pdf"), firstPdf);
    fs.writeFileSync(path.join(dir, "second.pdf"), secondPdf);
    fs.writeFileSync(path.join(dir, "check.py"), S1_CHECK_PY);
    fs.writeFileSync(path.join(dir, "insp.py"), QA_INSPECTOR_PY);
    fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify({ files: ["first.pdf", "second.pdf"], cases: [], renderDir: ".r" }));
    const docs = JSON.parse(execFileSync(python, ["-P", "-s", "check.py", "first.pdf", "second.pdf"], { cwd: dir, encoding: "utf8", timeout: 60_000 }).trim().split("\n").pop()!);
    const insp = parseInspectorReport(execFileSync(python, ["-P", "-s", "insp.py", "spec.json"], { cwd: dir, encoding: "utf8", timeout: 150_000 }));
    const fails = (f: string) => (insp.files.find((x) => x.path === f)?.checks ?? []).filter((c) => c.status === "fail").map((c) => c.id);
    const identical = crypto.createHash("sha256").update(firstPdf).digest("hex") === crypto.createHash("sha256").update(secondPdf).digest("hex");
    const reasons: string[] = [];
    const orig = (label: string, d: { missingPoints: number[]; tickBoxes: number; gasSafety: boolean }, f: string[]) => {
      if (d.missingPoints.length) reasons.push(`${label}: points ${d.missingPoints.join(", ")} not visible`);
      if (d.tickBoxes < 10) reasons.push(`${label}: ${d.tickBoxes} usable empty tick box(es), not 10`);
      if (!d.gasSafety) reasons.push(`${label}: the title's subject (gas safety) is not visible`);
      if (f.length) reasons.push(`${label}: inspector failed ${f.join(", ")}`);
    };
    orig("first", docs.first, fails("first.pdf"));
    if (identical) reasons.push("the revision is the first file again (identical bytes): the correction was not delivered");
    orig("revision", docs.second, fails("second.pdf"));
    if (!docs.second.correction.found) reasons.push(`revision: ${docs.second.correction.why}`);
    return { ok: reasons.length === 0, reasons, identical, first: { ...docs.first, inspectorFails: fails("first.pdf") }, second: { ...docs.second, inspectorFails: fails("second.pdf") } };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

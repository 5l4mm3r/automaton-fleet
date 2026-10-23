/**
 * Review 2026-10-23 — the evolving workspace grows from what worked: a successful delivery keeps its method (build
 * commands and scripts, inspection and review, delivery) as an editable procedure in the founder's own workspace; every
 * rewrite keeps the previous version and the founder's own notes; links planted in the workspace never redirect it.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { PROCEDURES_DIR, procedureKind, procedureLine, recordProcedure } from "../../fleet/founder/procedures.js";
import type { ToolCall } from "../../fleet/cognition/types.js";

const c = (name: string, args: Record<string, unknown>): ToolCall => ({ id: name, name, arguments: args });
const ws = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "proc-")));
const ORDER = "6ac71280-60d2-41d1-b2a4-38f21caa4b07";
const deliver = c("wallet", { op: "deliver", orderId: ORDER, paths: ["order/checklist.pdf"], reviewId: "r1" });

describe("procedures kept from a successful delivery", () => {
  it("records the build commands, the scripts they ran (copied), the inspection and review, and the delivery", () => {
    const w = ws();
    fs.mkdirSync(path.join(w, "order"));
    fs.writeFileSync(path.join(w, "order", "make_pdf.py"), "print('pdf')\n");
    const calls = [
      { call: c("write_file", { path: "order/make_pdf.py", content: "print('pdf')" }), ok: true },
      { call: c("exec", { command: "cd order && python3 make_pdf.py --out checklist.pdf" }), ok: true },
      { call: c("exec", { command: "python3 broken.py" }), ok: false },
      { call: c("deliverable", { op: "inspect", paths: ["order/checklist.pdf"] }), ok: true },
      { call: c("deliverable", { op: "review", paths: ["order/checklist.pdf"], criteria: [1, 2, 3], verdict: "pass" }), ok: true },
    ];
    expect(recordProcedure(w, calls, deliver)).toBe(`${PROCEDURES_DIR}/deliver-pdf.md`);
    const md = fs.readFileSync(path.join(w, PROCEDURES_DIR, "deliver-pdf.md"), "utf8");
    expect(md).toContain("# Procedure: deliver-pdf (worked 1 time;");
    expect(md).toContain("- exec: `cd order && python3 make_pdf.py --out checklist.pdf`");
    expect(md).not.toContain("broken.py");                                       // a failed command is not a method
    expect(md).toContain("scripts kept: procedures/scripts/make_pdf.py");
    expect(fs.readFileSync(path.join(w, PROCEDURES_DIR, "scripts", "make_pdf.py"), "utf8")).toBe("print('pdf')\n");
    expect(md).toContain("- deliverable inspect paths=[\"order/checklist.pdf\"]");
    expect(md).toContain("- deliverable review paths=[\"order/checklist.pdf\"] (3 criteria, verdict pass)");
    expect(md).toContain("- wallet deliver {orderId, paths: [\"order/checklist.pdf\"], reviewId}");
    expect(procedureLine(w)).toContain("procedures/deliver-pdf.md — Procedure: deliver-pdf (worked 1 time;");
  });

  it("is editable and reversible: a rewrite keeps the previous version and carries the founder's own notes", () => {
    const w = ws();
    recordProcedure(w, [], deliver, new Date("2026-10-23T10:00:00Z"));
    const f = path.join(w, PROCEDURES_DIR, "deliver-pdf.md");
    fs.writeFileSync(f, `${fs.readFileSync(f, "utf8")}\nUse A4 and 11pt; the buyer wanted tick boxes.\n`);   // the founder's own edit
    recordProcedure(w, [], deliver, new Date("2026-10-24T10:00:00Z"));
    const md = fs.readFileSync(f, "utf8");
    expect(md).toContain("worked 2 times");
    expect(md).toContain("Use A4 and 11pt; the buyer wanted tick boxes.");
    const hist = fs.readdirSync(path.join(w, PROCEDURES_DIR, ".history"));
    expect(hist).toHaveLength(1);
    expect(fs.readFileSync(path.join(w, PROCEDURES_DIR, ".history", hist[0]), "utf8")).toContain("Use A4 and 11pt");
  });

  it("links planted in the workspace never make it read from or write to outside", () => {
    const w = ws();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    fs.writeFileSync(path.join(outside, "secret.py"), "SECRET");
    fs.symlinkSync(outside, path.join(w, "linked"));                             // a script "inside" via a linked directory
    recordProcedure(w, [{ call: c("exec", { command: "python3 linked/secret.py" }), ok: true }], deliver);
    expect(fs.existsSync(path.join(w, PROCEDURES_DIR, "scripts", "secret.py"))).toBe(false);
    const w2 = ws();
    fs.symlinkSync(outside, path.join(w2, PROCEDURES_DIR));                       // the procedures folder itself is a link
    expect(recordProcedure(w2, [], deliver)).toBeNull();
    expect(fs.readdirSync(outside)).toEqual(["secret.py"]);
    const w3 = ws();
    fs.mkdirSync(path.join(w3, PROCEDURES_DIR));
    fs.symlinkSync(path.join(outside, "secret.py"), path.join(w3, PROCEDURES_DIR, "deliver-pdf.md"));   // the file is a link
    expect(recordProcedure(w3, [], deliver)).toBeNull();
    expect(fs.readFileSync(path.join(outside, "secret.py"), "utf8")).toBe("SECRET");
  });

  it("names the kind by the delivered files", () => {
    expect(procedureKind(["a/x.pdf"])).toBe("deliver-pdf");
    expect(procedureKind(["a.xlsx", "b.XLSX"])).toBe("deliver-xlsx");
    expect(procedureKind(["a.pdf", "b.zip"])).toBe("deliver-file");
  });
});

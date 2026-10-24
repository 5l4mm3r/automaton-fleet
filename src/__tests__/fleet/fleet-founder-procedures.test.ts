/**
 * Review 2026-10-23 — the evolving workspace grows from what worked: a successful delivery keeps its method (build
 * commands and scripts, inspection and review, delivery) as an editable procedure in the founder's own workspace; every
 * rewrite keeps the previous version and the founder's own notes; links planted in the workspace never redirect it.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { PROCEDURES_DIR, parameterize, procedureKind, procedureLine, recordProcedure } from "../../fleet/founder/procedures.js";
import type { ToolCall } from "../../fleet/cognition/types.js";

const c = (name: string, args: Record<string, unknown>): ToolCall => ({ id: name, name, arguments: args });
const ws = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "proc-")));
const ORDER = "6ac71280-60d2-41d1-b2a4-38f21caa4b07";
// The wallet tool's real shape (desktop run 2026-10-23: the procedure read top-level arguments and was never written).
const deliver = c("wallet", { op: "deliver", args: { orderId: ORDER, paths: ["order/checklist.pdf"], reviewId: "r1" } });

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
    expect(md).toContain("# Procedure: deliver-pdf (dispatched 1 time;");
    expect(md).toContain("- exec: `cd order && python3 make_pdf.py --out checklist.pdf`");
    expect(md).not.toContain("broken.py");                                       // a failed command is not a method
    expect(md).toContain("scripts kept: procedures/scripts/make_pdf.py");
    expect(fs.readFileSync(path.join(w, PROCEDURES_DIR, "scripts", "make_pdf.py"), "utf8")).toBe("print('pdf')\n");
    expect(md).toContain("- deliverable inspect paths=[\"order/checklist.pdf\"]");
    expect(md).toContain("- deliverable review paths=[\"order/checklist.pdf\"] (3 criteria, verdict pass)");
    expect(md).toContain("- wallet deliver {orderId: <ORDER_ID>, paths: [\"order/checklist.pdf\"] (the NEW files), reviewId: <REVIEW_ID>}");
    expect(md).toContain("Never re-send an earlier delivery call");
    expect(procedureLine(w)).toContain("procedures/deliver-pdf.md — Procedure: deliver-pdf (dispatched 1 time;");
  });

  it("keeps only real build steps: no command that exited non-zero, no look-around, no repeat, no absolute workspace path (desktop run 3)", () => {
    const w = ws();
    fs.mkdirSync(path.join(w, "order"));
    fs.writeFileSync(path.join(w, "order", "create_pdf.py"), "print('pdf')\n");
    const calls = [
      { call: c("exec", { command: "pwd" }), ok: true, output: "exit 0\n/workspace/ws_01M5NMABBS1KX51KV1N53QXFG7" },
      { call: c("exec", { command: "ls -la order/" }), ok: true, output: "exit 0\ncreate_pdf.py" },
      { call: c("exec", { command: "cd order && python create_pdf.py" }), ok: true, output: "exit 127\npython: not found" },
      { call: c("exec", { command: "cd order && python3 create_pdf.py" }), ok: true, output: "exit 0\n" },
      { call: c("exec", { command: "cd order && python3 create_pdf.py" }), ok: true, output: "exit 0\n" },
      { call: c("exec", { command: `cd ${w}/order && python3 create_pdf.py --final` }), ok: true, output: "exit 0\n" },
      { call: c("exec", { command: "cd /workspace/ws_01M5NMABBS1KX51KV1N53QXFG7 && python3 order/create_pdf.py" }), ok: true, output: "exit 0\n" },
      { call: c("exec", { command: "echo done > order/log.txt" }), ok: true, output: "exit 0\n" },
    ];
    expect(recordProcedure(w, calls, deliver)).toBe(`${PROCEDURES_DIR}/deliver-pdf.md`);
    const md = fs.readFileSync(path.join(w, PROCEDURES_DIR, "deliver-pdf.md"), "utf8");
    const build = md.slice(md.indexOf("## Build"), md.indexOf("## Inspect")).split("\n").filter((l) => l.startsWith("- exec"));
    expect(build).toEqual([
      "- exec: `cd order && python3 create_pdf.py`",
      "- exec: `cd ./order && python3 create_pdf.py --final`",
      "- exec: `cd . && python3 order/create_pdf.py`",
      "- exec: `echo done > order/log.txt`",                                        // writes a file: not only a look around
    ]);
    expect(md).not.toContain(w);
    expect(md).not.toContain("ws_01M5");
    expect((md.match(/procedures\/scripts\/create_pdf\.py/g) ?? []).length).toBe(1);
  });

  it("is editable and reversible: a rewrite keeps the previous version and carries the founder's own notes", () => {
    const w = ws();
    recordProcedure(w, [], deliver, new Date("2026-10-23T10:00:00Z"));
    const f = path.join(w, PROCEDURES_DIR, "deliver-pdf.md");
    fs.writeFileSync(f, `${fs.readFileSync(f, "utf8")}\nUse A4 and 11pt; the buyer wanted tick boxes.\n`);   // the founder's own edit
    recordProcedure(w, [], deliver, new Date("2026-10-24T10:00:00Z"));
    const md = fs.readFileSync(f, "utf8");
    expect(md).toContain("dispatched 2 times");
    expect(md).toContain("Use A4 and 11pt; the buyer wanted tick boxes.");
    const hist = fs.readdirSync(path.join(w, PROCEDURES_DIR, ".history"));
    expect(hist).toHaveLength(1);
    expect(fs.readFileSync(path.join(w, PROCEDURES_DIR, ".history", hist[0]), "utf8")).toContain("Use A4 and 11pt");
  });

  it("run 6: the count says dispatched (reviewed and sent), not verified; an older 'worked' record keeps counting", () => {
    const w = ws();
    recordProcedure(w, [], deliver);
    const f = path.join(w, PROCEDURES_DIR, "deliver-pdf.md");
    expect(fs.readFileSync(f, "utf8")).toContain("Dispatched means reviewed and sent, not that the buyer's request was met");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("dispatched 1 time", "worked 3 times"));   // a record written before
    recordProcedure(w, [], deliver);
    expect(fs.readFileSync(f, "utf8")).toContain("(dispatched 4 times;");
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

  it("is a reusable recipe: the earlier order's id, review, item, buyer address and other ids become parameters", () => {
    const w = ws();
    fs.mkdirSync(path.join(w, "orders"));
    fs.mkdirSync(path.join(w, "orders", "6ac71280"));
    fs.writeFileSync(path.join(w, "orders", "6ac71280", "make.py"),
      `ORDER = "${ORDER}"\nTITLE = "Gas safety: the landlord's annual 10-point checklist"\nTO = "jo.buyer@example.com"\n`);
    const d2 = c("wallet", { op: "deliver", args: { orderId: ORDER, paths: ["orders/6ac71280/checklist.pdf"], reviewId: "rev-5d1e0c" } });
    const calls = [
      { call: c("exec", { command: `python3 orders/6ac71280/make.py --order ${ORDER} --mail jo.buyer@example.com --sms +447700900123 --ref 01M3F50SH7PNX2E3GST13J52AS` }), ok: true },
      { call: c("deliverable", { op: "review", paths: ["orders/6ac71280/checklist.pdf"], criteria: [1], verdict: "pass" }), ok: true },
    ];
    recordProcedure(w, calls, d2, new Date(), { item: "Gas safety: the landlord's annual 10-point checklist" });
    const md = fs.readFileSync(path.join(w, PROCEDURES_DIR, "deliver-pdf.md"), "utf8");
    const script = fs.readFileSync(path.join(w, PROCEDURES_DIR, "scripts", "make.py"), "utf8");
    for (const t of [md, script]) {
      for (const v of [ORDER, "6ac71280", "jo.buyer@example.com", "+447700900123", "01M3F50SH7PNX2E3GST13J52AS", "rev-5d1e0c", "10-point checklist"]) expect(t).not.toContain(v);
    }
    expect(md).toContain("python3 orders/<ORDER_ID>/make.py --order <ORDER_ID> --mail <BUYER_EMAIL> --sms <PHONE> --ref <ID>");
    expect(md).toContain('paths=["orders/<ORDER_ID>/checklist.pdf"]');
    expect(md).toContain("## Parameters (values of the earlier order, removed — never replay them)");
    expect(script).toContain('ORDER = "<ORDER_ID>"');
    expect(script).toContain('TITLE = "<ITEM>"');
    expect(parameterize("no specifics here", { ORDER_ID: ORDER })).toBe("no specifics here");
  });

  it("names the kind by the delivered files", () => {
    expect(procedureKind(["a/x.pdf"])).toBe("deliver-pdf");
    expect(procedureKind(["a.xlsx", "b.XLSX"])).toBe("deliver-xlsx");
    expect(procedureKind(["a.pdf", "b.zip"])).toBe("deliver-file");
  });
});

/**
 * Desktop run 2 (2026-10-23, Qwen3.5-9B on the RTX 5080): the order was never delivered — 33 malformed calls on the delivery
 * path, and the buyer was told twice that the file had been delivered. The tool interface is repaired only where the meaning
 * is unambiguous: the compact tool list names the delivery ops' arguments; fields given beside `op` are the op's fields; one
 * `path` (or deliver `files` given as workspace paths) means those files; an order review names its subject; a refusal says
 * what the call needs (never an internal operation name); and a message claiming a delivery that is still owed is refused.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { FounderToolbox, DELIVERY_CLAIM, falseDeliveryClaim, opArgs } from "../../fleet/founder/toolbox.js";
import { LoopGuard } from "../../fleet/founder/loop-guard.js";
import { FOUNDER_MANIFEST_V2 } from "../../fleet/capabilities.js";
import { compactToolSpec, fullToolSpec } from "../../fleet/cognition/types.js";
import type { CustomerObligation } from "../../fleet/founder/obligations.js";

const DEV_TOOLS = path.join(os.homedir(), ".cache/automaton-fleet-tools/dev");
const ORDER = "9e4bc473-96de-4dc7-ad91-39b37fa8709b";

function rig(o: { economy?: (op: string, args: Record<string, unknown>) => Promise<Record<string, unknown>> } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "run2t-")));
  const dirs = { w: path.join(root, "w"), m: path.join(root, "m") };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  const box = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: dirs.w, memoryDir: dirs.m, loopGuard: new LoopGuard(), selfGovernance: true, toolsDir: DEV_TOOLS,
    runtime: { commit: "c".repeat(40), buildId: "b".repeat(64) }, ports: {
    ledger: async () => ({ cash: 10_000, expensePurchasingCapacity: 10_000 }),
    spendOrder: async () => ({ ok: true }), proposeKnowledge: async () => ({}), knowledge: async () => [], requestIdentityFact: async () => ({}),
    economy: async (op: string, args: Record<string, unknown>) => { calls.push({ op, args }); return o.economy ? o.economy(op, args) : { ok: true, op }; },
  } as never });
  let id = 0;
  const run = (name: string, args: Record<string, unknown>) => box.execute({ id: `t${++id}`, name, arguments: args });
  const put = (rel: string, content: string) => { const f = path.join(dirs.w, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); };
  return { run, calls, box, put };
}
// FleetController's answer to a successful wallet deliver: the order with its delivery's record.
const RECORD = { ok: true, order: { orderId: ORDER, status: "delivering", delivery: { deliveryId: "d-1", status: "queued" } } };
const owed = (x: Partial<CustomerObligation> = {}): CustomerObligation => ({ kind: "order", id: ORDER, state: "to_deliver", since: "2026-10-23T23:13:32.761Z",
  lastBuyerAt: "2026-10-23T23:13:32.761Z", buyerMessages: 0, repliedAt: null, delivering: false, deliveryOwed: true, ...x });

describe("desktop run 2: the delivery path's arguments", () => {
  it("the compact tool list names the delivery ops' arguments", () => {
    const d = compactToolSpec(fullToolSpec("deliverable")!).description;
    for (const w of ["inside args", "paths", "subject: \"order\"", "orderId", "criteria", "criterion", "met", "evidence", "verdict"]) expect(d, w).toContain(w);
    const w = compactToolSpec(fullToolSpec("wallet")!).description;
    for (const x of ["op deliver", "paths", "reviewId", "resendReason", "after"]) expect(w, x).toContain(x);
    expect(compactToolSpec(fullToolSpec("customers")!).description).toContain("only after wallet deliver succeeded");
    expect(w).toMatch(/tool_help/);
  });

  it("fields beside op are the op's fields (args wins on a clash); nothing else is invented", () => {
    expect(opArgs({ op: "deliver", orderId: "a", paths: ["x"] })).toEqual({ orderId: "a", paths: ["x"] });
    expect(opArgs({ op: "deliver", orderId: "a", args: { orderId: "b" } })).toEqual({ orderId: "b" });
    expect(opArgs({ op: "view" })).toEqual({});
  });

  it("wallet deliver: fields beside op, one path, or files given as workspace paths are delivered; the staged names reach the controller", async () => {
    for (const call of [
      { op: "deliver", orderId: ORDER, paths: ["order/checklist.txt"], reviewId: "rv" },
      { op: "deliver", args: { orderId: ORDER, path: "order/checklist.txt", reviewId: "rv" } },
      { op: "deliver", args: { orderId: ORDER, files: ["order/checklist.txt"], reviewId: "rv" } },
    ]) {
      const t = rig();
      t.put("order/checklist.txt", "checklist");
      const r = await t.run("wallet", call);
      expect(r.ok, JSON.stringify(call)).toBe(true);
      expect(t.calls.map((c) => c.op)).toEqual(["money.currencies", "order.stage_file", "order.deliver"]);
      expect(t.calls[2].args).toMatchObject({ orderId: ORDER, reviewId: "rv", files: [{ fileName: "checklist.txt" }] });
      expect(t.calls[2].args).not.toHaveProperty("paths");
      expect(t.calls[2].args).not.toHaveProperty("path");
    }
  });

  it("wallet deliver without files is refused here with what it needs — no controller call, no internal operation name", async () => {
    const t = rig();
    for (const args of [{ orderId: ORDER, reviewId: "rv" }, { orderId: ORDER, files: [{ fileName: "checklist.pdf" }] }]) {
      const r = await t.run("wallet", { op: "deliver", args });
      expect(r).toMatchObject({ ok: false, refused: "FLEET_BAD_REQUEST" });
      expect(r.output).toContain("paths");
      expect(r.output).toContain("not an external block");
      expect(r.output).not.toContain("order.stage_file");
    }
    expect(t.calls).toHaveLength(0);
  });

  it("an op that takes one path keeps it (an offer file is not turned into paths)", async () => {
    const t = rig();
    t.put("product/guide.pdf", "%PDF-1.4 hello");
    expect((await t.run("offer", { op: "file", offerId: "o1", path: "product/guide.pdf" })).ok).toBe(true);
    expect(t.calls[0]).toMatchObject({ op: "offer.file", args: { offerId: "o1", fileName: "guide.pdf" } });
  });

  it("deliverable inspect takes paths beside op and one path (the refusal is about the file, not the argument shape)", async () => {
    const t = rig();
    for (const call of [{ op: "inspect", paths: ["order/missing.pdf"] }, { op: "inspect", args: { path: "order/missing.pdf" } }]) {
      const r = await t.run("deliverable", call);
      expect(r).toMatchObject({ ok: false, refused: "FLEET_BAD_REQUEST" });
      expect(r.output).toContain("not a file in your workspace: order/missing.pdf");
    }
  });

  it("exec: a command over 2000 characters says so, with the way round it", async () => {
    const t = rig();
    const r = await t.run("exec", { command: `python3 - <<'EOF'\n${"x = 1\n".repeat(500)}EOF` });
    expect(r).toMatchObject({ ok: false, refused: "FLEET_BAD_REQUEST" });
    expect(r.output).toContain("at most 2000 characters");
    expect(r.output).toContain("write_file");
    expect((await t.run("exec", {})).output).toContain("command required");
  });
});

describe("desktop run 2: no false delivery claim to a buyer", () => {
  it("recognises statements of a delivery, not promises or honest updates", () => {
    for (const s of ["Your file is ready. It has been delivered to your account.", "I've sent the checklist.", "The revised PDF was emailed to you.",
      "Please see the revised PDF.", "We have delivered your order.", "Point 7 has been updated and sent.", "I've corrected and sent the checklist."]) expect(DELIVERY_CLAIM.test(s), s).toBe(true);
    for (const s of ["The file is ready and will be delivered as soon as the review passes.", "It has not been delivered yet: I am fixing the file.",
      "Thank you for your order — I am working on it now.", "I'll update point 7 and send the revised PDF shortly."]) expect(DELIVERY_CLAIM.test(s), s).toBe(false);
  });

  it("is refused while the delivery is owed; sent after a delivery of this turn succeeded, or when nothing is owed", async () => {
    const t = rig({ economy: async (op) => op === "order.deliver" ? RECORD : { ok: true } });
    t.put("order/checklist.txt", "checklist");
    t.box.noteObligations([owed()]);
    const claim = { op: "order_message", args: { orderId: ORDER, message: "Your file is ready. It has been delivered to your account." } };
    const r = await t.run("customers", claim);
    expect(r).toMatchObject({ ok: false, refused: "FLEET_CLAIM_UNSUPPORTED" });
    expect(t.calls).toHaveLength(0);
    // an honest update goes out as written
    expect((await t.run("customers", { op: "order_message", args: { orderId: ORDER, message: "I am building your checklist now; it will be delivered within the hour." } })).ok).toBe(true);
    // a revision owed counts too
    t.box.noteObligations([owed({ state: "acknowledged", deliveryOwed: false, revisionOwed: true })]);
    expect((await t.run("customers", { op: "order_message", args: { orderId: ORDER, message: "Please see the revised PDF." } })).refused).toBe("FLEET_CLAIM_UNSUPPORTED");
    // after a successful delivery in this turn
    expect((await t.run("wallet", { op: "deliver", args: { orderId: ORDER, paths: ["order/checklist.txt"], reviewId: "rv", resendReason: "point 7", after: "op1" } })).ok).toBe(true);
    expect((await t.run("customers", claim)).ok).toBe(true);
    // nothing owed for this order
    t.box.noteObligations([]);
    expect((await t.run("customers", { ...claim, args: { ...claim.args, message: "It has been delivered — let me know if anything else is needed." } })).ok).toBe(true);
  });

  it("while only a revision is owed, a sentence about the original delivery is honest; a claim about the revision is not (review of run 5)", async () => {
    for (const s of ["The original was sent earlier; the revision is in progress.", "Your first PDF was delivered yesterday, but the corrected one is still being checked.",
      "Thanks — the earlier file was sent before your note. I am adding the date line to point 7 now."]) expect(falseDeliveryClaim(s, true), s).toBe(false);
    for (const s of ["Please see the revised PDF.", "It has been delivered.", "I've sent the updated checklist.", "The original was sent and I have now sent the new one too.",
      "Point 7 has been updated and sent."]) expect(falseDeliveryClaim(s, true), s).toBe(true);
    expect(falseDeliveryClaim("The original was sent earlier; the revision is in progress.", false)).toBe(true);   // nothing delivered yet: no "original"
    const t = rig();
    t.box.noteObligations([owed({ state: "acknowledged", deliveryOwed: false, revisionOwed: true })]);
    expect((await t.run("customers", { op: "order_message", args: { orderId: ORDER, message: "The original was sent earlier; the revision is in progress." } })).ok).toBe(true);
    expect((await t.run("customers", { op: "order_message", args: { orderId: ORDER, message: "I've sent the updated checklist." } })).refused).toBe("FLEET_CLAIM_UNSUPPORTED");
    t.box.noteObligations([owed()]);
    expect((await t.run("customers", { op: "order_message", args: { orderId: ORDER, message: "The original was sent earlier; the revision is in progress." } })).refused).toBe("FLEET_CLAIM_UNSUPPORTED");
  });

  it("a first delivery does not license saying the correction was delivered; only the controller's record of a delivery licenses a claim (review of run 5)", async () => {
    const t = rig({ economy: async (op) => op === "order.deliver" ? RECORD : { ok: true } });
    t.put("order/checklist.txt", "checklist");
    t.box.noteObligations([owed()]);
    const msg = (message: string) => t.run("customers", { op: "order_message", args: { orderId: ORDER, message } });
    expect((await t.run("wallet", { op: "deliver", args: { orderId: ORDER, paths: ["order/checklist.txt"], reviewId: "rv" } })).ok).toBe(true);
    expect((await msg("Your new checklist has been delivered.")).ok).toBe(true);                       // the first delivery: true
    for (const s of ["Point 7 has been updated and sent.", "The corrected PDF has been sent.", "Please see the revised PDF."]) expect((await msg(s)).refused, s).toBe("FLEET_CLAIM_UNSUPPORTED");
    // the revision delivered (a second delivery of the order): now true
    expect((await t.run("wallet", { op: "deliver", args: { orderId: ORDER, paths: ["order/checklist.txt"], reviewId: "rv2", resendReason: "point 7 date line" } })).ok).toBe(true);
    expect((await msg("Point 7 has been updated and sent.")).ok).toBe(true);
    // ok without the controller's delivery record licenses nothing
    const u = rig({ economy: async () => ({ ok: true }) });
    u.put("order/checklist.txt", "checklist");
    u.box.noteObligations([owed()]);
    expect((await u.run("wallet", { op: "deliver", args: { orderId: ORDER, paths: ["order/checklist.txt"], reviewId: "rv" } })).ok).toBe(true);
    expect((await u.run("customers", { op: "order_message", args: { orderId: ORDER, message: "It has been delivered." } })).refused).toBe("FLEET_CLAIM_UNSUPPORTED");
  });

  it("a failed delivery does not license the claim", async () => {
    const t = rig({ economy: async (op) => op === "order.deliver" ? { ok: false, code: "FLEET_REVIEW_STALE" } : { ok: true } });
    t.put("order/checklist.txt", "checklist");
    t.box.noteObligations([owed()]);
    expect((await t.run("wallet", { op: "deliver", args: { orderId: ORDER, paths: ["order/checklist.txt"], reviewId: "rv" } })).ok).toBe(false);
    expect((await t.run("customers", { op: "order_message", args: { orderId: ORDER, message: "It has been delivered." } })).refused).toBe("FLEET_CLAIM_UNSUPPORTED");
  });
});

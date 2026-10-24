/**
 * Run 6 (2026-10-24, Qwen3.5-9B, candidate 8da6a94), replayed without a model. What happened: the agent edited its content
 * file for the buyer's correction → its render was refused FLEET_ALREADY_DONE (the continuation guard saw no changed file:
 * render names its input as `source`) → it reviewed the OLD PDF ("met: true") → re-sent the unchanged file → the harness
 * reported "completed" → the procedure counted a second success.
 *
 * Replayed here with run 6's own files (fixtures/run6: the delivered PDF and the agent's edited content, byte for byte) and
 * scripted calls: an edited source renders; an unchanged call keeps its duplicate protection and merely touching the output
 * is not a new input; the revision's review must state the change (require) and the page must show it; the unchanged file
 * is refused as the revision (a plain resend stays possible); the grade reads the delivered bytes; the procedure says
 * "dispatched". Sandboxed with the pinned agent tools.
 */
import { describe, it, expect } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { FounderToolbox } from "../../fleet/founder/toolbox.js";
import { LoopGuard, filesState } from "../../fleet/founder/loop-guard.js";
import { callSig } from "../../fleet/founder/continuity.js";
import { FOUNDER_MANIFEST_V2 } from "../../fleet/capabilities.js";
import { runSandboxed } from "../../fleet/founder/exec-sandbox.js";
import { gradeS1Documents } from "../../fleet/eval/s1-correction-check.js";
import type { ToolCall } from "../../fleet/cognition/types.js";

const DEV_TOOLS = path.join(os.homedir(), ".cache/automaton-fleet-tools/dev");
const PY = path.join(DEV_TOOLS, "bin/fleet-python");
const HAVE_TOOLS = fs.existsSync(path.join(DEV_TOOLS, "site")) && fs.existsSync(PY);
const FIX = path.join(__dirname, "fixtures", "run6");
const ORDER = "27de487c-973b-4a1c-a838-e8d1595c5654";
const BUYER = "Thanks. Point 7 should also have a line to write the date of the next annual check. Could you add it?";
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
/** Run 6's edited content, and the original it was edited from (the same without point 7's new line). */
const EDITED = fs.readFileSync(path.join(FIX, "edited-checklist.json"), "utf8");
function original(): Record<string, any> {
  const c = JSON.parse(EDITED);
  delete c.description;                                     // the first render ignored it; the renderer now refuses it (below)
  const p7 = c.blocks[1].checklist[6];
  p7.lines = p7.lines.filter((l: string) => !/next annual check/i.test(l));
  return c;
}

/** FleetController as the toolbox sees it: deliveries (status, files), the order's thread, review records. */
function world() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "run6-")));
  const ws = path.join(root, "w");
  fs.mkdirSync(ws, { recursive: true }); fs.mkdirSync(path.join(root, "m"));
  const deliveries: Array<{ deliveryId: string; status: string; sentAt?: string; files: Array<{ fileName: string; sha256: string }>; reviewId: string; createdAt: string }> = [];
  const thread: Array<{ author: string; body: string; at: string }> = [];
  const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  let clock = Date.parse("2026-10-24T11:39:00Z");
  const tick = () => new Date((clock += 1_000)).toISOString();
  let reviews = 0;
  // As v113: a request is answered only by an EFFECTIVE sent delivery — the first, or changed files on a review whose
  // automated report passed required_content; the same files again answer nothing.
  const verified = new Set<string>();
  const effectiveAt = () => {
    const sentOnes = deliveries.filter((d) => d.status === "sent");
    const ok = sentOnes.filter((d, i) => i === 0 || (JSON.stringify(d.files.map((f) => f.sha256)) !== JSON.stringify(sentOnes[i - 1].files.map((f) => f.sha256)) && verified.has(d.reviewId)));
    return ok.length ? ok.at(-1)!.createdAt : null;
  };
  const revisionOwed = () => { const at = effectiveAt(); return at !== null && thread.some((m) => m.author === "buyer" && m.at > at); };
  const staged = new Map<string, string>();
  const box = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: ws, memoryDir: path.join(root, "m"), loopGuard: new LoopGuard(), selfGovernance: true, toolsDir: DEV_TOOLS,
    ports: { ledger: async () => ({}), economy: async (op: string, args: Record<string, unknown>) => {
      calls.push({ op, args });
      if (op === "order.thread") return { ok: true, order: { orderId: ORDER, ...(deliveries.length ? { delivery: deliveries.at(-1) } : {}) }, thread, revisionOwed: revisionOwed() };
      if (op === "review.record") {
        const reviewId = `rv-${++reviews}`;
        const auto = args.automated as { ok?: boolean; files?: Array<{ checks?: Array<{ id: string; status: string }> }> };
        if (auto.ok && (auto.files ?? []).some((f) => (f.checks ?? []).some((c) => c.id === "required_content" && c.status === "pass"))) verified.add(reviewId);
        return { ok: true, reviewId, verdict: args.verdict, automatedOk: auto.ok };
      }
      // As FleetController: staged bytes by name; a delivery takes the staged files (their names) with their hashes.
      if (op === "order.stage_file") { staged.set(String(args.fileName), sha(Buffer.from(String(args.contentB64), "base64"))); return { ok: true }; }
      if (op === "order.deliver") {
        const files = (args.files as Array<{ fileName: string }>).map((f) => ({ fileName: f.fileName, sha256: staged.get(f.fileName)! }));
        const d = { deliveryId: `d${deliveries.length + 1}`, status: "queued", files, reviewId: String(args.reviewId ?? ""), createdAt: tick() };
        deliveries.push(d); tick();
        return { ok: true, order: { orderId: ORDER, status: "delivering", delivery: d } };
      }
      return { ok: true };
    } } as never });
  let id = 0;
  const run = (name: string, args: Record<string, unknown>) => box.execute({ id: `s${++id}`, name, arguments: args });
  const sent = () => { const d = deliveries.at(-1)!; d.status = "sent"; d.sentAt = tick(); };
  const buyer = (body: string) => thread.push({ author: "buyer", body, at: tick() });
  return { ws, run, sent, buyer, deliveries, calls, box };
}
const criteria = [{ criterion: "One page, ten numbered points with a tick box each", met: true, evidence: "rendered and inspected" },
  { criterion: "Point 7 has a line to write the date of the next annual check", met: true, evidence: "required text checked on the page" },
  { criterion: "Nothing off the page or overlapping", met: true, evidence: "inspection passed" }];

describe("run 6 replayed: dependency tracking for render (no sandbox needed)", () => {
  it("an edited source is a new call; the unchanged call keeps its protection; touching only the output is not a new input", () => {
    const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "run6dep-")));
    fs.mkdirSync(path.join(ws, "order"));
    fs.writeFileSync(path.join(ws, "order/checklist.json"), JSON.stringify(original()));
    fs.writeFileSync(path.join(ws, "order/checklist.pdf"), "%PDF-1.4 first");
    const call: ToolCall = { id: "r", name: "deliverable", arguments: { op: "render", args: { source: "order/checklist.json", out: "order/checklist.pdf" } } };
    // The done record of the turn that rendered it (as the mind keeps it: the call's signature and its files' state after it ran).
    const done = { sig: callSig(call), fp: filesState(ws, call) };
    expect(done.fp).toMatch(/^order\/checklist\.json=/);                       // was "" in 8da6a94: every later render was "already done"
    const already = () => done.sig === callSig(call) && (!done.fp || done.fp === filesState(ws, call));
    expect(already()).toBe(true);                                               // unchanged: still not repeated
    fs.writeFileSync(path.join(ws, "order/checklist.pdf"), "%PDF-1.4 touched");  // the output alone changed
    fs.utimesSync(path.join(ws, "order/checklist.pdf"), new Date(), new Date(Date.now() + 5_000));
    expect(already()).toBe(true);
    fs.writeFileSync(path.join(ws, "order/checklist.json"), EDITED);            // run 6's edit (11:40:21)
    expect(already()).toBe(false);                                              // the render runs
  });
});

describe.skipIf(!HAVE_TOOLS)("run 6 replayed: edit → render → inspect → review → corrected delivery (scripted, sandboxed)", () => {
  it("the corrected revision goes through; the unchanged file, a review without the change and the old PDF's grade all fail", async () => {
    const w = world();
    if ((await runSandboxed(w.ws, "echo up", { timeoutMs: 15_000, maxOutput: 1_000 })).sandboxUnavailable) return;
    // 1. The first delivery (the original content, rendered).
    const r1 = JSON.parse((await w.run("deliverable", { op: "render", args: { source: "order/checklist.json", out: "order/checklist.pdf", content: original() } })).output);
    expect(r1.inspection.ok, JSON.stringify(r1.inspection)).toBe(true);
    expect((await w.run("deliverable", { op: "review", args: { subject: "order", orderId: ORDER, paths: ["order/checklist.pdf"], criteria, verdict: "pass" } })).ok).toBe(true);
    { const d1 = await w.run("wallet", { op: "deliver", args: { orderId: ORDER, paths: ["order/checklist.pdf"], reviewId: "rv-1" } }); expect(d1.ok, d1.output).toBe(true); }
    w.sent();
    const firstPdf = fs.readFileSync(path.join(w.ws, "order/checklist.pdf"));
    fs.copyFileSync(path.join(w.ws, "order/checklist.pdf"), path.join(w.ws, "order/first.pdf"));
    // 2. The buyer's correction; the agent edits its content file exactly as in run 6.
    w.buyer(BUYER);
    fs.writeFileSync(path.join(w.ws, "order/checklist.json"), EDITED);
    // 3. Render runs (not "already done"); run 6's edit carried an unknown field: refused with what to do, nothing dropped.
    const bad = await w.run("deliverable", { op: "render", args: { source: "order/checklist.json", out: "order/checklist.pdf" } });
    expect(bad.refused).toBe("FLEET_BAD_REQUEST");
    expect(bad.output).toContain("unknown field(s) description");
    const fixed = JSON.parse(EDITED); delete fixed.description;
    fs.writeFileSync(path.join(w.ws, "order/checklist.json"), JSON.stringify(fixed, null, 2));
    const r2 = JSON.parse((await w.run("deliverable", { op: "render", args: { source: "order/checklist.json", out: "order/checklist.pdf", require: ["Next annual check date"] } })).output);
    expect(r2.inspection.ok, JSON.stringify(r2.inspection)).toBe(true);        // the change is visible on the page
    const secondPdf = fs.readFileSync(path.join(w.ws, "order/checklist.pdf"));
    expect(sha(secondPdf)).not.toBe(sha(firstPdf));
    // 4. The revision's review: without require it is refused; the agent's "met: true" is not proof.
    const noReq = await w.run("deliverable", { op: "review", args: { subject: "order", orderId: ORDER, paths: ["order/checklist.pdf"], criteria, verdict: "pass" } });
    expect(noReq.refused).toBe("FLEET_REVIEW_REQUIRE_CHANGE");
    expect(noReq.output).toContain("Point 7 should also have a line");
    // The OLD PDF reviewed with the change stated: the page does not show it — the automated check fails (no passing review).
    const oldReview = JSON.parse((await w.run("deliverable", { op: "review", args: { subject: "order", orderId: ORDER, paths: ["order/first.pdf"], criteria, verdict: "pass",
      require: ["Next annual check date"] } })).output);
    expect(oldReview.automatedOk).toBe(false);
    // The new PDF with the change stated: passes.
    const rev = JSON.parse((await w.run("deliverable", { op: "review", args: { subject: "order", orderId: ORDER, paths: ["order/checklist.pdf"], criteria, verdict: "pass",
      require: ["Next annual check date"] } })).output);
    expect(rev.automatedOk).toBe(true);
    // 5. Delivery: the unchanged file is refused as the revision; a review that did not state the change is refused; the new one goes.
    const same = await w.run("wallet", { op: "deliver", args: { orderId: ORDER, paths: ["order/first.pdf"], reviewId: rev.reviewId, resendReason: "point 7", after: "op1" } });
    expect(same.refused).toBe("FLEET_REVISION_UNCHANGED");
    const unreviewed = await w.run("wallet", { op: "deliver", args: { orderId: ORDER, paths: ["order/checklist.pdf"], reviewId: "rv-1", resendReason: "point 7", after: "op1" } });
    expect(unreviewed.refused).toBe("FLEET_REVISION_UNREVIEWED");
    expect(w.deliveries).toHaveLength(1);
    expect((await w.run("wallet", { op: "deliver", args: { orderId: ORDER, paths: ["order/checklist.pdf"], reviewId: rev.reviewId, resendReason: "point 7 date line", after: "op1" } })).ok).toBe(true);
    w.sent();
    expect(w.deliveries.map((d) => d.files[0].sha256)).toEqual([sha(firstPdf), sha(secondPdf)]);
    // 6. The grade on the delivered bytes: this pair passes; run 6's actual pair (the same file twice) fails.
    const good = gradeS1Documents(PY, firstPdf, secondPdf);
    expect(good.reasons).toEqual([]);
    expect(good.ok).toBe(true);
    expect(good.second).toMatchObject({ correction: { found: true, writeIn: "drawn line" } });
    const delivered6 = fs.readFileSync(path.join(FIX, "delivered-checklist.pdf"));
    const run6 = gradeS1Documents(PY, delivered6, delivered6);
    expect(run6.ok).toBe(false);
    expect(run6.identical).toBe(true);
    expect(run6.reasons).toContain("the revision is the first file again (identical bytes): the correction was not delivered");
    expect(run6.reasons.join(" ")).toContain("no line under point 7 (before point 8) names the date of the next annual check");
  }, 240_000);

  it("a legitimate resend stays possible: the same file again on request (unchanged: true), and recovery of a delivery that never went out", async () => {
    const w = world();
    if ((await runSandboxed(w.ws, "echo up", { timeoutMs: 15_000, maxOutput: 1_000 })).sandboxUnavailable) return;
    await w.run("deliverable", { op: "render", args: { source: "order/checklist.json", out: "order/checklist.pdf", content: original() } });
    await w.run("wallet", { op: "deliver", args: { orderId: ORDER, paths: ["order/checklist.pdf"], reviewId: "rv-0" } });
    // Recovery: the delivery failed (never sent) — the same file again is not a revision question.
    w.deliveries[0].status = "failed";
    w.buyer("I have not received anything yet.");
    expect((await w.run("wallet", { op: "deliver", args: { orderId: ORDER, paths: ["order/checklist.pdf"], reviewId: "rv-0", resendReason: "retry", after: "op1" } })).ok).toBe(true);
    // Sent, then the buyer cannot open it: the same file again, said so explicitly.
    w.sent();
    w.buyer("The attachment would not open, could you send it again?");
    expect((await w.run("wallet", { op: "deliver", args: { orderId: ORDER, paths: ["order/checklist.pdf"], reviewId: "rv-0", resendReason: "resend", after: "op2" } })).refused).toBe("FLEET_REVISION_UNCHANGED");
    const again = await w.run("wallet", { op: "deliver", args: { orderId: ORDER, paths: ["order/checklist.pdf"], reviewId: "rv-0", resendReason: "resend on request", after: "op2", unchanged: true } });
    expect(again.ok).toBe(true);
    expect(w.calls.filter((c) => c.op === "order.deliver").at(-1)!.args).not.toHaveProperty("unchanged");
  }, 120_000);

  it("an explicit unchanged resend does not resolve a pending correction: it stays owed until the change is delivered and shown on the page", async () => {
    const w = world();
    if ((await runSandboxed(w.ws, "echo up", { timeoutMs: 15_000, maxOutput: 1_000 })).sandboxUnavailable) return;
    await w.run("deliverable", { op: "render", args: { source: "order/checklist.json", out: "order/checklist.pdf", content: original() } });
    await w.run("wallet", { op: "deliver", args: { orderId: ORDER, paths: ["order/checklist.pdf"], reviewId: "rv-0" } });
    w.sent();
    w.buyer(BUYER);                                                                    // the correction is requested
    // The agent re-sends the old file and declares it unchanged: it goes out (the buyer gets it again) …
    expect((await w.run("wallet", { op: "deliver", args: { orderId: ORDER, paths: ["order/checklist.pdf"], reviewId: "rv-0", resendReason: "resend", after: "op1", unchanged: true } })).ok).toBe(true);
    w.sent();
    // … but the correction is still owed: FleetController's rule (v113) and therefore the runtime's checks agree.
    const owedNow = await w.run("customers", { op: "order_message", args: { orderId: ORDER, message: "Point 7 has been updated and sent." } });
    expect(owedNow.refused).toBe("FLEET_CLAIM_UNSUPPORTED");
    expect(owedNow.output).toContain("their request is not delivered by it");
    expect((await w.run("deliverable", { op: "review", args: { subject: "order", orderId: ORDER, paths: ["order/checklist.pdf"], criteria, verdict: "pass" } })).refused)
      .toBe("FLEET_REVIEW_REQUIRE_CHANGE");
    expect((await w.run("wallet", { op: "deliver", args: { orderId: ORDER, paths: ["order/checklist.pdf"], reviewId: "rv-0", resendReason: "again", after: "op2" } })).refused)
      .toBe("FLEET_REVISION_UNCHANGED");
    // The change made, shown on the page and delivered: now it is answered.
    const fixed = JSON.parse(EDITED); delete fixed.description;
    fs.writeFileSync(path.join(w.ws, "order/checklist.json"), JSON.stringify(fixed));
    await w.run("deliverable", { op: "render", args: { source: "order/checklist.json", out: "order/checklist.pdf" } });
    const rev = JSON.parse((await w.run("deliverable", { op: "review", args: { subject: "order", orderId: ORDER, paths: ["order/checklist.pdf"], criteria, verdict: "pass",
      require: ["Next annual check date"] } })).output);
    expect((await w.run("wallet", { op: "deliver", args: { orderId: ORDER, paths: ["order/checklist.pdf"], reviewId: rev.reviewId, resendReason: "point 7", after: "op3" } })).ok).toBe(true);
    w.sent();
    expect((await w.run("customers", { op: "order_message", args: { orderId: ORDER, message: "Point 7 has been updated and sent." } })).ok).toBe(true);
  }, 120_000);
});

/**
 * v115 revision review (owner, 24 Oct 2026; Group A rerun on 8f6862e failed on it): after a delivery, the review of a revision
 * reads the order's established correction from FleetController NOW. Visible phrases are required only where the correction
 * declared them (mustShow, checked on the page whether or not the review repeats them); a phrase-free correction (layout,
 * removal, calculation) is reviewed against its outcomes, listed word for word. An unclassified message is refused with what to
 * do. The delivery stays bound to the reviewed bytes, the changed-file rule and the corrections open when the review was made.
 * Sandboxed with the pinned agent tools (the inspector runs on the real PDFs).
 */
import { describe, it, expect } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { FounderToolbox } from "../../fleet/founder/toolbox.js";
import { LoopGuard } from "../../fleet/founder/loop-guard.js";
import { FOUNDER_MANIFEST_V2 } from "../../fleet/capabilities.js";
import { runSandboxed } from "../../fleet/founder/exec-sandbox.js";

const DEV_TOOLS = path.join(os.homedir(), ".cache/automaton-fleet-tools/dev");
const HAVE_TOOLS = fs.existsSync(path.join(DEV_TOOLS, "site")) && fs.existsSync(path.join(DEV_TOOLS, "bin/fleet-python"));
const FIX = path.join(__dirname, "fixtures", "run6");
const ORDER = "27de487c-973b-4a1c-a838-e8d1595c5654";
const MSG1 = "8b1c0d2e-0000-4000-8000-000000000001", MSG2 = "8b1c0d2e-0000-4000-8000-000000000002";
const CORR1 = "c0c0c0c0-0000-4000-8000-000000000001", CORR2 = "c0c0c0c0-0000-4000-8000-000000000002";
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
const EDITED = (() => { const c = JSON.parse(fs.readFileSync(path.join(FIX, "edited-checklist.json"), "utf8")); delete c.description; return c; })();
function original(): Record<string, any> {
  const c = structuredClone(EDITED);
  const p7 = c.blocks[1].checklist[6];
  p7.lines = p7.lines.filter((l: string) => !/next annual check/i.test(l));
  return c;
}
type Crit = { outcome: string; kind: string; mustShow?: string[] };

/** FleetController as the toolbox sees it, at v115: deliveries, the thread, the order's message work (classify, corrections). */
function world() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "v115rev-")));
  const ws = path.join(root, "w");
  fs.mkdirSync(ws, { recursive: true }); fs.mkdirSync(path.join(root, "m"));
  const deliveries: Array<{ deliveryId: string; status: string; sentAt?: string; files: Array<{ fileName: string; sha256: string }>; reviewId: string }> = [];
  const thread: Array<{ author: string; body: string; at: string }> = [];
  const work = { classify: [] as string[], corrections: [] as Array<{ correctionId: string; sourceMessageId: string; criteria: Crit[] }> };
  const records: Array<Record<string, any>> = [];
  const ctl = { obligationsDown: false };
  let clock = Date.parse("2026-10-24T11:39:00Z");
  const tick = () => new Date((clock += 1_000)).toISOString();
  const owed = () => work.classify.length > 0 || work.corrections.length > 0;
  const staged = new Map<string, string>();
  const box = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: ws, memoryDir: path.join(root, "m"), loopGuard: new LoopGuard(), selfGovernance: true, toolsDir: DEV_TOOLS,
    ports: { ledger: async () => ({}), economy: async (op: string, args: Record<string, unknown>) => {
      if (op === "order.thread") return { ok: true, order: { orderId: ORDER, ...(deliveries.length ? { delivery: deliveries.at(-1) } : {}) }, thread, revisionOwed: owed() };
      if (op === "customer.obligations") {
        if (ctl.obligationsDown) return { ok: false, code: "FLEET_UNAVAILABLE" };
        return { ok: true, total: owed() ? 1 : 0, offset: 0, obligations: owed() ? [{ kind: "order", id: ORDER, state: "acknowledged", revisionOwed: true,
          work: { ...(work.classify.length ? { classify: work.classify } : {}), ...(work.corrections.length ? { corrections: work.corrections } : {}) } }] : [] };
      }
      if (op === "review.record") { records.push(args); return { ok: true, reviewId: `rv-${records.length}`, verdict: args.verdict, automatedOk: (args.automated as { ok: boolean }).ok }; }
      if (op === "order.stage_file") { staged.set(String(args.fileName), sha(Buffer.from(String(args.contentB64), "base64"))); return { ok: true }; }
      if (op === "order.deliver") {
        const d = { deliveryId: `d${deliveries.length + 1}`, status: "queued", files: (args.files as Array<{ fileName: string }>).map((f) => ({ fileName: f.fileName, sha256: staged.get(f.fileName)! })),
          reviewId: String(args.reviewId ?? "") };
        deliveries.push(d);
        return { ok: true, order: { orderId: ORDER, status: "delivering", delivery: d } };
      }
      return { ok: true };
    } } as never });
  let id = 0;
  const run = (name: string, args: Record<string, unknown>) => box.execute({ id: `s${++id}`, name, arguments: args });
  const sent = () => { const d = deliveries.at(-1)!; d.status = "sent"; d.sentAt = tick(); };
  const buyer = (body: string) => thread.push({ author: "buyer", body, at: tick() });
  const render = async (content: Record<string, any>) => {
    const r = JSON.parse((await run("deliverable", { op: "render", args: { source: "order/checklist.json", out: "order/checklist.pdf", content } })).output);
    expect(r.inspection.ok, JSON.stringify(r.inspection)).toBe(true);
  };
  const review = (criteria: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
    run("deliverable", { op: "review", args: { subject: "order", orderId: ORDER, paths: ["order/checklist.pdf"], criteria, verdict: "pass", ...extra } });
  const deliver = (reviewId: string, extra: Record<string, unknown> = {}) =>
    run("wallet", { op: "deliver", args: { orderId: ORDER, paths: ["order/checklist.pdf"], reviewId, resendReason: "the buyer's correction", after: "op1", ...extra } });
  /** The first delivery (the original content) is made and sent; then the buyer writes MSG1. */
  const firstDelivery = async () => {
    await render(original());
    const rv = JSON.parse((await review(BASE)).output);
    expect((await deliver(rv.reviewId, { resendReason: undefined, after: undefined })).ok).toBe(true);
    sent();
    buyer("Point 7 should also have a line for the date of the next annual check, and please drop the subtitle.");
  };
  return { ws, run, sent, buyer, render, review, deliver, firstDelivery, deliveries, work, records, ctl };
}
const BASE = [{ criterion: "One page, ten numbered points with a tick box each", met: true, evidence: "rendered and inspected" },
  { criterion: "Nothing off the page or overlapping", met: true, evidence: "inspection passed" },
  { criterion: "Wording matches the brief", met: true, evidence: "read against the brief" }];
const met = (outcome: string) => ({ criterion: outcome, met: true, evidence: "checked on the rendered page" });
const requiredContent = (rec: Record<string, any>) => rec.automated.files.flatMap((f: { checks: Array<{ id: string; status: string }> }) => f.checks).find((c: { id: string }) => c.id === "required_content");
const sandboxUp = async (ws: string) => !(await runSandboxed(ws, "echo up", { timeoutMs: 15_000, maxOutput: 1_000 })).sandboxUnavailable;

describe.skipIf(!HAVE_TOOLS)("v115: the revision's review follows the established correction (sandboxed)", () => {
  it("an unclassified message: the review and the delivery are refused with what to do", async () => {
    const w = world();
    if (!(await sandboxUp(w.ws))) return;
    await w.firstDelivery();
    w.work.classify = [MSG1];
    await w.render(EDITED);
    const r = await w.review(BASE, { require: ["Next annual check date"] });
    expect(r.refused).toBe("FLEET_REVIEW_CLASSIFY_FIRST");
    expect(r.output).toContain(MSG1);
    expect(r.output).toContain("order_classify");
    expect(w.records).toHaveLength(1);                                                 // only the first delivery's review
    expect((await w.deliver("rv-1")).refused).toBe("FLEET_REVISION_UNREVIEWED");
    expect(w.deliveries).toHaveLength(1);
  }, 120_000);

  it("a phrase-free correction (removal): no phrases asked for; each outcome must be listed; the changed file goes out on that review", async () => {
    const w = world();
    if (!(await sandboxUp(w.ws))) return;
    await w.firstDelivery();
    const OUT = "The subtitle under the title is removed";
    w.work.corrections = [{ correctionId: CORR1, sourceMessageId: MSG1, criteria: [{ outcome: OUT, kind: "remove" }] }];
    const changed = structuredClone(original()); delete changed.subtitle;
    expect(original().subtitle, "the fixture has a subtitle to remove").toBeTruthy();
    await w.render(changed);
    const without = await w.review(BASE);
    expect(without.refused).toBe("FLEET_REVIEW_OUTCOMES");
    expect(without.output).toContain(`"${OUT}"`);
    const rv = JSON.parse((await w.review([...BASE, met(OUT)])).output);               // no require: none was declared
    expect(rv.automatedOk).toBe(true);
    expect(requiredContent(w.records.at(-1)!)).toBeUndefined();                        // no phrase invented
    expect((await w.deliver(rv.reviewId)).ok).toBe(true);
    expect(w.deliveries).toHaveLength(2);
  }, 120_000);

  it("a phrase-required correction: its declared phrase is checked on the page even when the review omits it", async () => {
    const w = world();
    if (!(await sandboxUp(w.ws))) return;
    await w.firstDelivery();
    const OUT = "Point 7 has a line to write the date of the next annual check";
    w.work.corrections = [{ correctionId: CORR1, sourceMessageId: MSG1, criteria: [{ outcome: OUT, kind: "add", mustShow: ["Next annual check date"] }] }];
    // The old content re-rendered as if changed (a new title only): the declared phrase is not on the page — no revision review.
    await w.render({ ...original(), title: `${original().title} (v2)` });
    const stale = JSON.parse((await w.review([...BASE, met(OUT)])).output);
    expect(stale.automatedOk).toBe(false);
    expect(requiredContent(w.records.at(-1)!)).toMatchObject({ status: "fail" });
    expect((await w.deliver(stale.reviewId)).refused).toBe("FLEET_REVISION_UNREVIEWED");
    // The real change: the phrase is on the page; the review passes with required_content, though it named no phrase itself.
    await w.render(EDITED);
    const rv = JSON.parse((await w.review([...BASE, met(OUT)])).output);
    expect(rv.automatedOk).toBe(true);
    expect(requiredContent(w.records.at(-1)!)).toMatchObject({ status: "pass" });
    expect((await w.deliver(rv.reviewId)).ok).toBe(true);
  }, 120_000);

  it("stale review or files: the unchanged file, other bytes, a new buyer message and a later correction all refuse the delivery", async () => {
    const w = world();
    if (!(await sandboxUp(w.ws))) return;
    await w.firstDelivery();
    fs.copyFileSync(path.join(w.ws, "order/checklist.pdf"), path.join(w.ws, "order/first.pdf"));
    const OUT = "Point 7 has a line to write the date of the next annual check";
    w.work.corrections = [{ correctionId: CORR1, sourceMessageId: MSG1, criteria: [{ outcome: OUT, kind: "add", mustShow: ["Next annual check date"] }] }];
    await w.render(EDITED);
    const rv = JSON.parse((await w.review([...BASE, met(OUT)])).output);
    expect(rv.automatedOk).toBe(true);
    // The same bytes the buyer already has: still refused as the revision.
    expect((await w.run("wallet", { op: "deliver", args: { orderId: ORDER, paths: ["order/first.pdf"], reviewId: rv.reviewId, resendReason: "x", after: "op1" } })).refused)
      .toBe("FLEET_REVISION_UNCHANGED");
    // The reviewed file changed after its review: not the bytes it inspected.
    const reviewed = fs.readFileSync(path.join(w.ws, "order/checklist.pdf"));
    await w.render({ ...EDITED, title: `${EDITED.title} (edited after review)` });
    expect((await w.deliver(rv.reviewId)).refused).toBe("FLEET_REVISION_STALE_FILES");
    fs.writeFileSync(path.join(w.ws, "order/checklist.pdf"), reviewed);
    // The buyer writes again (unclassified): the earlier review does not deliver it.
    w.buyer("Also, could the footer show my company name?");
    w.work.classify = [MSG2];
    const again = await w.deliver(rv.reviewId, { resendReason: "the correction, after the buyer wrote again" });  // (an identical refused call is not repeated)
    expect(again.refused).toBe("FLEET_REVISION_CLASSIFY_FIRST");
    expect(again.output).toContain(MSG2);
    // Classified as a correction: the review predates it.
    w.work.classify = [];
    const OUT2 = "The footer shows the buyer's company name";
    w.work.corrections.push({ correctionId: CORR2, sourceMessageId: MSG2, criteria: [{ outcome: OUT2, kind: "add" }] });
    const late = await w.deliver(rv.reviewId, { resendReason: "the correction, after classifying" });
    expect(late.refused).toBe("FLEET_REVISION_STALE_REVIEW");
    expect(late.output).toContain(CORR2);
    expect(w.deliveries).toHaveLength(1);
    // A review covering both corrections delivers (the second has no phrase; its outcome is listed).
    const both = JSON.parse((await w.review([...BASE, met(OUT), met(OUT2)])).output);
    expect(both.automatedOk).toBe(true);
    expect((await w.deliver(both.reviewId)).ok).toBe(true);
  }, 180_000);

  it("FleetController's correction cannot be read: the review is refused (fail closed), never accepted without it", async () => {
    const w = world();
    if (!(await sandboxUp(w.ws))) return;
    await w.firstDelivery();
    w.work.corrections = [{ correctionId: CORR1, sourceMessageId: MSG1, criteria: [{ outcome: "The subtitle under the title is removed", kind: "remove" }] }];
    await w.render({ ...original(), subtitle: undefined });
    w.ctl.obligationsDown = true;
    const r = await w.review([...BASE, met("The subtitle under the title is removed")]);
    expect(r.refused).toBe("FLEET_REVIEW_STATE_UNKNOWN");
    expect(w.records).toHaveLength(1);
  }, 120_000);
});

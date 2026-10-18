/**
 * Work continuity — the owner's acceptance conditions of 2026-10-18 (after the proof run in which Agent-1 paid to
 * re-orient every minute). Production FounderMind + FounderToolbox, with the production options
 * (workContinuity, FOUNDER_STEPS_PER_TURN, no timed safety re-check), and a scripted model; every inference is counted.
 *
 *  1. A cut-off turn's actual tool results, its plan and its calls not yet run reach the next turn, after a restart too;
 *     a completed external action is not executed again.
 *  2. Progress is new information: re-reads and unchanged statuses are not progress; new research, a changed result
 *     and a write are.
 *  3. A stalled founder gets ONE assessment turn, then waits: unchanged state, an unrelated change and a restart cause
 *     ZERO inference. A Fleet Control notice (its text, once), an owner message, a due review time or a finished job
 *     (the controller's events digest) wake it.
 *  4. A superseded approval stays on record and the current decision is in the founder's task.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { FounderMind, FOUNDER_STEPS_PER_TURN, STALL_LINE, type MindPorts } from "../../fleet/founder/mind.js";
import { FounderToolbox } from "../../fleet/founder/toolbox.js";
import { LoopGuard } from "../../fleet/founder/loop-guard.js";
import { CARRY_FILE, ProgressMemory, isExternal, normalizeResult } from "../../fleet/founder/continuity.js";
import { FOUNDER_MANIFEST_V2, manifestSha256 } from "../../fleet/capabilities.js";
import { capabilityView } from "../../fleet/cognition/capability-signature.js";
import type { ToolCall } from "../../fleet/cognition/types.js";

const CAPS = { ok: true, origin: "reseed_founder", manifestId: "founder-v2", manifestSha256: manifestSha256(FOUNDER_MANIFEST_V2),
  allowed: [...FOUNDER_MANIFEST_V2.allowed], reproductionExecutable: false, paymentExecutable: false, experimentsEnabled: false, ownerRequests: true };
const c = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: `${name}-${Math.random().toString(36).slice(2, 8)}`, name, arguments: args });
const hex32 = (n: number) => n.toString(16).padStart(32, "0");

type Step = { calls: ToolCall[]; content?: string };
/** `script(turn, step, packet)` scripts the model. `world` is the controller's state the test changes. */
function rig(script: (turn: number, step: number, packet: string) => Step, o: { maxSteps?: number; root?: string } = {}) {
  const root = o.root ?? fs.mkdtempSync(path.join(os.tmpdir(), "wc-"));
  const d = { w: path.join(root, "w"), s: path.join(root, "s"), m: path.join(root, "s", "memory") };
  const fresh = !fs.existsSync(d.w);
  for (const x of Object.values(d)) fs.mkdirSync(x, { recursive: true });
  if (fresh) {
    fs.mkdirSync(path.join(d.w, "product"));
    fs.writeFileSync(path.join(d.w, "product", "tracker.csv"), "property,gas_safety_due\nFlat 1,2026-11-02\n");
    fs.writeFileSync(path.join(d.m, "goals.json"), JSON.stringify([{ id: "g1", title: "Publish the landlord compliance tracker", status: "open" }]));
  }
  const world = { eventsDigest: hex32(1), notices: [] as Array<{ id: string; at: string; body: string }>, ownerPending: 0, cash: 9_906,
    requests: [] as unknown[], storefrontStatus: "draft", economyCalls: [] as string[] };
  const packets: string[] = [];
  const outputsSeen: string[] = [];
  let infers = 0, turn = 0, step = 0;
  const ports: MindPorts = {
    cognitionStatus: async () => ({ policyEnabled: true, provider: "anthropic", founderEnabled: true, paused: false, routing: { active: true },
      capabilities: { ...capabilityView(CAPS, true), reproductionExecutable: false },
      attention: { ownerPending: world.ownerPending, eventsDigest: world.eventsDigest, notices: world.notices, recentEvents: [] },
      survival: { survivalEquityCents: world.cash, inferenceTodayCents: 80, burnPerDayCents: 40, runwayDays: 240 } }),
    ledger: async () => ({ cash: world.cash, survivalEquity: world.cash, genesisAllocation: 10_000, externalCustomerRevenue: 0 }),
    ownerRequests: async () => ({ ok: true, requests: world.requests }),
    economy: async (op: string) => {
      world.economyCalls.push(op);
      if (op === "owner.claim") {
        if (!world.ownerPending) return { ok: false };
        world.ownerPending = 0;
        return { ok: true, turnId: "t-owner", messages: [{ messageId: "m1", body: "How is the tracker going?", files: [] }] };
      }
      return { ok: true };
    },
    infer: async (messages) => {
      const ms = messages as Array<{ role: string; content: string }>;
      if (ms.length === 1) { turn++; step = 0; packets.push(String(ms[0].content)); }
      for (const m of ms) if (m.role === "tool") outputsSeen.push(m.content);
      step++; infers++;
      const s = script(turn, step, packets.at(-1)!);
      return { content: s.content ?? "", toolCalls: s.calls, usage: { inputTokens: 1, outputTokens: 1 }, chargedCents: 1, requestId: `r${turn}-${step}` };
    },
  };
  const loopGuard = new LoopGuard();
  const toolbox = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: d.w, memoryDir: d.m, loopGuard, selfGovernance: true, ports: {
    ledger: async () => ({}), ownerRequests: async () => ({ ok: true, requests: world.requests }),
    economy: async (op: string, args?: Record<string, unknown>) => {
      world.economyCalls.push(op);
      if (op === "storefront.products" || op === "offer.list") return { ok: true, products: [{ id: "p1", status: world.storefrontStatus }] };
      if (op === "owner.reply") return { ok: true };
      return { ok: true, op, args };
    },
  } as never });
  const mind = new FounderMind({ ports, toolbox, stateDir: d.s, workContinuity: true, hibernationSafetyMs: Number.POSITIVE_INFINITY,
    maxStepsPerTurn: o.maxSteps ?? FOUNDER_STEPS_PER_TURN, routed: { memoryDir: d.m, workspaceDir: d.w, manifest: FOUNDER_MANIFEST_V2, loopGuard } });
  return { mind, world, packets, outputsSeen, root, d, infers: () => infers, turns: () => turn };
}
const beats = async (r: ReturnType<typeof rig>, n: number) => { for (let i = 0; i < n; i++) await r.mind.turn(`heartbeat ${i}`); };

describe("work continuity (owner acceptance, 2026-10-18)", () => {
  it("1a. a cut-off turn's actual results, plan and calls not yet run reach the next turn — after a restart too — and a finished turn consumes them", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wc-a-"));
    const script = (t: number, s: number): Step => {
      if (t === 1 && s === 1) return { calls: [c("write_file", { path: "research/notes.md", content: "DEMAND-EVIDENCE-7731: landlords miss EICR renewals" })] };
      if (t === 1 && s === 2) return { calls: [c("read_file", { path: "research/notes.md" })] };
      if (t === 1 && s < 4) return { calls: [c("list_goals")] };
      if (t === 1) return { content: "Plan: next, price at £5 and publish the offer.", calls: Array.from({ length: 6 }, (_, i) => c("read_file", { path: `product/x${i}.csv` })) };
      return { calls: [c("sleep", { reason: "continued" })] };
    };
    const first = rig(script, { root, maxSteps: 4 });
    const cut = await first.mind.turn("hb");
    expect(cut.steps).toBe(4);
    expect(fs.existsSync(path.join(first.d.s, CARRY_FILE))).toBe(true);
    // Restart: a new process on the same state.
    // (The new process counts its turns from 1 again: its script is the continuation's.)
    const second = rig(() => ({ calls: [c("sleep", { reason: "continued from the carried record" })] }), { root, maxSteps: 4 });
    await second.mind.turn("hb after restart");
    const p = second.packets[0];
    expect(p).toContain("CONTINUE YOUR UNFINISHED WORK");
    expect(p).toContain("DEMAND-EVIDENCE-7731");                    // the actual result of the carried read
    expect(p).toContain("Plan: next, price at £5 and publish the offer.");
    expect(p).toMatch(/Requested but not run yet: read_file \{\\?"path\\?":\\?"product\/x5\.csv\\?"\}/); // the 6th call of the last step (limit 5; the packet is JSON)
    expect(fs.existsSync(path.join(second.d.s, CARRY_FILE))).toBe(false); // the finished turn consumed it
    second.world.eventsDigest = hex32(9);                          // something changes: the next working turn runs
    await beats(second, 3);
    expect(second.packets.length).toBeGreaterThan(1);
    expect(second.packets.slice(1).some((x) => x.includes("CONTINUE YOUR UNFINISHED WORK"))).toBe(false);
  });

  it("1b. a completed external action of the carried turn is not executed again; a different one is", async () => {
    const r = rig((t, s) => {
      if (t === 1 && s === 1) return { calls: [c("offer", { op: "publish", args: { offerId: "o1" } })] };
      if (t === 1) return { calls: [c("list_goals")] };
      if (t === 2 && s === 1) return { calls: [c("offer", { op: "publish", args: { offerId: "o1" } }), c("offer", { op: "publish", args: { offerId: "o2" } })] };
      return { calls: [c("sleep", { reason: "published" })] };
    }, { maxSteps: 3 });
    await r.mind.turn("hb 1");
    expect(r.world.economyCalls.filter((x) => x === "offer.publish")).toHaveLength(1);
    await r.mind.turn("hb 2");
    expect(r.world.economyCalls.filter((x) => x === "offer.publish")).toHaveLength(2);         // o2 only
    expect(r.outputsSeen.some((x) => x.includes("NOT EXECUTED FLEET_ALREADY_DONE: you already did exactly this"))).toBe(true);
    expect(isExternal(c("offer", { op: "list" }))).toBe(false);
    expect(isExternal(c("storefront", { op: "products" }))).toBe(false);
    expect(isExternal(c("customers", { op: "quote" }))).toBe(true);      // enquiry.quote sends a quote: an external action
    expect(isExternal(c("identity", { op: "send" }))).toBe(true);        // mail.send
    expect(isExternal(c("business", { op: "no_such_op" }))).toBe(true);  // unknown: the safe side
    expect(isExternal(c("web_search", { query: "x" }))).toBe(true);
    expect(isExternal(c("read_file", { path: "x" }))).toBe(false);
  });

  it("2. progress is new information: re-reads and unchanged statuses are not; new research, a changed status, a changed file and a write are", async () => {
    const m = new ProgressMemory(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wc-p-")), "p.json"));
    const read = c("read_file", { path: "product/tracker.csv" });
    expect(m.note(read, true, "property,gas_safety_due")).toBe(true);
    expect(m.note(read, true, "property,gas_safety_due")).toBe(false);                    // re-read: nothing new
    expect(m.note(read, true, "property,gas_safety_due,eicr_due")).toBe(true);            // the file changed
    const status = c("storefront", { op: "products" });
    expect(m.note(status, true, '{"status":"draft","asOf":"2026-10-18T13:08:43.085Z"}')).toBe(true);
    expect(m.note(status, true, '{"status":"draft","asOf":"2026-10-18T13:09:49.908Z"}')).toBe(false); // only the clock moved
    expect(m.note(status, true, '{"status":"published","asOf":"2026-10-18T13:10:58.629Z"}')).toBe(true);
    expect(m.note(c("web_search", { query: "landlord EICR tracker" }), true, "5 results: …")).toBe(true);
    expect(m.note(c("web_search", { query: "landlord EICR tracker template price" }), true, "5 other results")).toBe(true);
    expect(m.note(c("sleep", { reason: "x" }), true, "ok")).toBe(false);
    expect(m.note(c("read_file", { path: "missing" }), false, "not found")).toBe(false);   // a failure is not progress
    expect(normalizeResult('{"ageS": 42, "at": "2026-10-18 12:30:54+00", "x": "2026-10-18T12:30:54.111Z"}')).toBe('{"ageS":0, "at": "<t>", "x": "<t>"}'); // PostgreSQL's +00 too
    // In the mind: the proof run's loop (status, list, read with unchanged results) is a turn without progress.
    const loop = (): Step => ({ calls: [c("storefront", { op: "products" }), c("list_files", { path: "" }), c("read_file", { path: "product/tracker.csv" })] });
    const r = rig((_t, s) => (s === 1 ? loop() : { calls: [c("sleep", { reason: "checked" })] }));
    expect((await r.mind.turn("hb 1")).progress).toBe(true);            // first time: all new
    expect((await r.mind.turn("hb 2")).progress).toBeUndefined();       // the same results again
    r.world.storefrontStatus = "published";
    expect((await r.mind.turn("hb 3")).progress).toBe(true);            // the status changed: that is news
  });

  it("3. a stalled founder gets one assessment turn, then waits: zero inference until a relevant change", async () => {
    const reviewIn = { at: null as string | null };
    const r = rig((t, s, packet) => {
      // The loop of the proof run, every turn.
      if (s === 1) return { calls: [c("storefront", { op: "products" }), c("list_files", { path: "" })] };
      if (packet.includes("How is the tracker going?") && s === 2) return { calls: [c("reply_to_owner", { message: "Building it; offer next." })] };
      if (reviewIn.at && s === 2) return { calls: [c("sleep", { reason: "waiting for the review", reviewAt: reviewIn.at })] };
      return { calls: [c("sleep", { reason: "nothing new" })] };
    });
    await r.mind.turn("hb 1");                                  // progress (first results)
    await r.mind.turn("hb 2");                                  // stalled once
    const before = r.infers();
    await beats(r, 3);                                          // the one assessment turn runs (with the stall line)
    expect(r.packets.some((p) => p.includes(STALL_LINE))).toBe(true);
    expect(r.infers()).toBeGreaterThan(before);
    // Stalled twice: waiting. Unchanged state → zero inference, however many slots pass.
    const waiting = r.infers();
    await beats(r, 40);
    expect(r.infers()).toBe(waiting);
    // An unrelated change (cash moves with every AI posting; it is not a wake signal) → still zero.
    r.world.cash -= 7;
    await beats(r, 10);
    expect(r.infers()).toBe(waiting);
    // A restart while waiting → still zero.
    const again = rig(() => ({ calls: [c("sleep", { reason: "x" })] }), { root: r.root });
    Object.assign(again.world, r.world);
    await beats(again, 10);
    expect(again.infers()).toBe(0);
    // A Fleet Control notice wakes it, and its text is in the task — once.
    r.world.notices = [{ id: "n1", at: "2026-10-18T13:07:09Z", body: "Fleet Control: the Gumroad channel is deferred; your channel is your own offer page." }];
    r.world.eventsDigest = hex32(2);
    await beats(r, 2);
    const woke = r.packets.filter((p) => p.includes("the Gumroad channel is deferred; your channel is your own offer page"));
    expect(woke).toHaveLength(1);
    expect(r.infers()).toBeGreaterThan(waiting);
    // It stalls again at once (nothing new happened after the notice) → waiting again; the notice is not shown again.
    const afterNotice = r.infers();
    await beats(r, 20);
    expect(r.infers()).toBe(afterNotice);
    // A finished job (the controller's events digest changes) wakes it.
    r.world.eventsDigest = hex32(3);
    await beats(r, 2);
    expect(r.infers()).toBeGreaterThan(afterNotice);
    expect(r.packets.filter((p) => p.includes("your channel is your own offer page"))).toHaveLength(1);
    // An owner message wakes it (the owner turn), and the reply ends the stall.
    const beforeOwner = r.infers();
    await beats(r, 20);
    expect(r.infers()).toBe(beforeOwner);
    r.world.ownerPending = 1;
    await beats(r, 1);
    expect(r.packets.at(-1)).toContain("How is the tracker going?");
    expect(r.world.economyCalls).toContain("owner.reply");
    // A due review time wakes it: a declared hibernation with a review time a moment away.
    reviewIn.at = new Date(Date.now() + 150).toISOString();
    await beats(r, 4);
    const declared = r.infers();
    await beats(r, 5);
    expect(r.infers()).toBe(declared);                         // waiting for the review time
    await new Promise((res) => setTimeout(res, 200));
    reviewIn.at = null;
    await beats(r, 1);
    expect(r.infers()).toBeGreaterThan(declared);              // the review time came
  });

  it("4. a superseded approval stays on record and the founder's task carries the current decision", async () => {
    const r = rig(() => ({ calls: [c("sleep", { reason: "read" })] }));
    r.world.requests = [{ requestId: "62cbe1b7-0d0e-4f4a-9c55-8f3c2a1b0e11", kind: "kyc", action: "List the landlord compliance tracker on Gumroad", title: "Owner request: enrol a Gumroad channel",
      status: "approved", response: "Approved: the owner will open a Gumroad seller account personally.", decidedAt: "2026-09-26T17:00:00Z", ageS: 3_600, createdAt: "2026-09-26T16:28:00Z",
      supersededBy: { decision: "Gumroad is deferred until a wallet reaches £500; sell through your own Fleet offer page.", at: new Date().toISOString() } }];
    await r.mind.turn("hb");
    const p = r.packets[0];
    expect(p).toContain("APPROVED earlier, now SUPERSEDED by the owner's current decision");
    expect(p).toContain("Gumroad is deferred until a wallet reaches £500; sell through your own Fleet offer page.");
    expect(p).toContain("Act on the current decision; do not wait on the earlier answer. The request stays on record.");
  });
});

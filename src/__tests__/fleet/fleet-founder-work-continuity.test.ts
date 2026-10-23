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
 *  9. (attempt 2) A waiting founder whose RUNTIME changed wakes once and is told; a restart on the same runtime stays free.
 * 10. Across that upgrade restart, the carried-turn, manifest and controller protections it exercises still hold (scope
 *     stated at the test; duplicate protection in general is the controller's v95 operation register).
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { FounderMind, FOUNDER_STEPS_PER_TURN, STALL_LINE, type MindPorts } from "../../fleet/founder/mind.js";
import { FounderToolbox } from "../../fleet/founder/toolbox.js";
import { LoopGuard } from "../../fleet/founder/loop-guard.js";
import { CARRY_FILE, PROGRESS_FILE, ProgressMemory, REPEAT_NOTE_AT, isExternal, normalizeResult } from "../../fleet/founder/continuity.js";
import { FOUNDER_MANIFEST_V2, manifestSha256 } from "../../fleet/capabilities.js";
import { capabilityView } from "../../fleet/cognition/capability-signature.js";
import type { ToolCall } from "../../fleet/cognition/types.js";

const CAPS = { ok: true, origin: "reseed_founder", manifestId: "founder-v2", manifestSha256: manifestSha256(FOUNDER_MANIFEST_V2),
  allowed: [...FOUNDER_MANIFEST_V2.allowed], reproductionExecutable: false, paymentExecutable: false, experimentsEnabled: false, ownerRequests: true };
const c = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: `${name}-${Math.random().toString(36).slice(2, 8)}`, name, arguments: args });
const hex32 = (n: number) => n.toString(16).padStart(32, "0");

type Step = { calls: ToolCall[]; content?: string };
/** `script(turn, step, packet)` scripts the model. `world` is the controller's state the test changes. */
function rig(script: (turn: number, step: number, packet: string) => Step, o: { maxSteps?: number; root?: string; runtime?: string; stopSignal?: AbortSignal; toolbox?: (tb: FounderToolbox) => void } = {}) {
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
    requests: [] as unknown[], storefrontStatus: "draft", economyCalls: [] as string[], refuse: {} as Record<string, string>,
    recentEvents: [] as Array<{ kind: string; id: string; at: string; tool?: string }>, obligations: undefined as unknown[] | undefined };
  const packets: string[] = [];
  const outputsSeen: string[] = [];
  const imagesSeen: Array<{ turn: number; step: number; images: number }> = [];
  let infers = 0, turn = 0, step = 0;
  const ports: MindPorts = {
    cognitionStatus: async () => ({ policyEnabled: true, provider: "anthropic", founderEnabled: true, paused: false, routing: { active: true },
      capabilities: { ...capabilityView(CAPS, true), reproductionExecutable: false },
      attention: { ownerPending: world.ownerPending, eventsDigest: world.eventsDigest, notices: world.notices, recentEvents: world.recentEvents,
        ...(world.obligations ? { customerObligations: world.obligations } : {}) },
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
      const imgs = (messages as Array<{ images?: unknown[] }>).reduce((n, m) => n + (m.images?.length ?? 0), 0);
      if (imgs) imagesSeen.push({ turn, step, images: imgs });
      const s = script(turn, step, packets.at(-1)!);
      return { content: s.content ?? "", toolCalls: s.calls, usage: { inputTokens: 1, outputTokens: 1 }, chargedCents: 1, requestId: `r${turn}-${step}` };
    },
  };
  const loopGuard = new LoopGuard({ stateDir: d.s });
  const toolbox = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: d.w, memoryDir: d.m, loopGuard, selfGovernance: true, ports: {
    ledger: async () => ({}), ownerRequests: async () => ({ ok: true, requests: world.requests }),
    economy: async (op: string, args?: Record<string, unknown>) => {
      world.economyCalls.push(op);
      const refusal = world.refuse[`${op}:${String((args?.args as { offerId?: unknown } | undefined)?.offerId ?? args?.offerId ?? "")}`];
      if (refusal) return { ok: false, code: refusal };                  // the controller refuses (its authority, per call)
      if (op === "storefront.products" || op === "offer.list") return { ok: true, products: [{ id: "p1", status: world.storefrontStatus }] };
      if (op === "owner.reply") return { ok: true };
      return { ok: true, op, args };
    },
  } as never });
  o.toolbox?.(toolbox);
  const mind = new FounderMind({ ports, toolbox, stateDir: d.s, workContinuity: true, hibernationSafetyMs: Number.POSITIVE_INFINITY, runtimeCommit: o.runtime, stopSignal: o.stopSignal,
    maxStepsPerTurn: o.maxSteps ?? FOUNDER_STEPS_PER_TURN, routed: { memoryDir: d.m, workspaceDir: d.w, manifest: FOUNDER_MANIFEST_V2, loopGuard } });
  return { mind, world, packets, outputsSeen, imagesSeen, root, d, infers: () => infers, turns: () => turn };
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

  // 2026-10-23 (run scen-89d7c21-b1, S1): 10 of 11 cut turns ended on the view_image result itself — the image's base64 was
  // counted as conversation text against the 40 KB turn budget — so the model never saw one of its 10 images and re-rendered
  // each turn. An image now counts as its token bound: the model sees it in the next step, and the turn goes on.
  it("1k. a large image a tool returned is seen in the next step: it does not end the turn by its base64 size", async () => {
    const ihdr = Buffer.alloc(24); Buffer.from("89504e470d0a1a0a", "hex").copy(ihdr); ihdr.writeUInt32BE(1240, 16); ihdr.writeUInt32BE(1754, 20);
    const png = Buffer.concat([ihdr, Buffer.alloc(300_000, 7)]);                       // an A4 page render: 300 KB, base64 ~400 KB
    const r = rig((t, s) => {
      if (t === 1 && s === 1) return { calls: [c("exec", { command: "render page 1" })] };
      if (t === 1 && s === 2) return { calls: [c("view_image", { path: "product/page1.png" })] };
      if (t === 1 && s === 3) return { content: "The page looks right.", calls: [c("list_goals")] };
      return { calls: [c("sleep", { reason: "checked the render" })] };
    }, { toolbox: (tb) => {
      const real = tb.execute.bind(tb);
      tb.execute = (async (call: ToolCall) => call.name === "view_image"
        ? { name: call.name, ok: true, output: "image product/page1.png is shown to you below", images: [{ mediaType: "image/png", dataB64: png.toString("base64") }] }
        : call.name === "exec" ? { name: call.name, ok: true, output: "rendered" } : real(call)) as typeof tb.execute;
    } });
    await r.mind.turn("hb");
    expect(r.imagesSeen).toEqual([{ turn: 1, step: 3, images: 1 }]);                  // the step after view_image carried the image
    const log = fs.readFileSync(path.join(r.d.s, "mind-log.jsonl"), "utf8");
    expect(log).not.toContain("FLEET_TURN_CONTEXT_BUDGET");
    expect(r.infers()).toBeGreaterThanOrEqual(4);                                     // the turn went on past the image
  });

  // 2026-10-21 (launch check): seven turns each ended at the request-size budget after 5-7 steps; they were taken as
  // finished, so each lost its working record and the next re-oriented from scratch (8 identical inspections, 270p).
  it("1d. turns that reach their size limit mid-work again and again carry their results, the platform's refusal reasons and the plan forward", async () => {
    const big = (from: number) => Array.from({ length: 5 }, (_, i) => c("read_file", { path: `product/big${from + i}.txt` }));
    const r = rig((t, s) => {
      // Turn 1: a plan, a call the platform refuses, then large results until the size limit.
      if (t === 1 && s === 1) return { content: "Plan: recalculate the tracker, inspect the saved file, then review and publish it.",
        calls: [c("offer", { op: "publish", args: { offerId: "o9" } })] };
      if (t === 1) return { calls: big((s - 2) * 5) };
      // Turn 2: it writes nothing (as Agent-1's real turns did) and stops at the size limit again.
      if (t === 2) return { calls: big(40 + (s - 1) * 5) };
      return { calls: [c("sleep", { reason: "continued from the carried record" })] };
    });
    r.world.refuse["offer.publish:o9"] = "FLEET_REVIEW_AUTOMATED_FAILED";
    for (let i = 0; i < 80; i++) fs.writeFileSync(path.join(r.d.w, "product", `big${i}.txt`), `RESULT-MARK-${i} ` + "x".repeat(5_000));
    const t1 = await r.mind.turn("hb");
    expect(t1.steps).toBeLessThan(FOUNDER_STEPS_PER_TURN);                           // stopped by size, not by its steps
    expect(fs.existsSync(path.join(r.d.s, CARRY_FILE))).toBe(true);
    const t2 = await r.mind.turn("hb 2");
    expect(t2.steps).toBeLessThan(FOUNDER_STEPS_PER_TURN);
    const p2 = r.packets[1];
    expect(p2).toContain("CONTINUE YOUR UNFINISHED WORK");
    expect(p2).toContain("reached the turn's size limit");
    expect(p2).toContain("FLEET_REVIEW_AUTOMATED_FAILED");                            // the refusal and its reason
    expect(p2).toMatch(/RESULT-MARK-([0-9]|[1-3][0-9])\b/);                          // an actual result of turn 1
    await r.mind.turn("hb 3");
    const p3 = r.packets[2];
    const log = fs.readFileSync(path.join(r.d.s, "mind-log.jsonl"), "utf8");
    expect(log.match(/FLEET_TURN_CONTEXT_BUDGET/g)).toHaveLength(2);                  // two size stops in a row
    expect(p3).toContain("the last of 2 turns in a row that stopped unfinished");
    expect(p3).toContain("Plan: recalculate the tracker, inspect the saved file, then review and publish it."); // turn 1's plan: turn 2 wrote none
    expect(p3).toContain("Refused by the platform");
    expect(p3).toContain("offer {\\\"op\\\":\\\"publish\\\"");                // turn 1's refusal survives a turn that did not repeat it
    expect(p3).toContain("FLEET_REVIEW_AUTOMATED_FAILED");
    expect(p3).toMatch(/RESULT-MARK-(4[0-9]|[5-7][0-9])\b/);                         // an actual result of turn 2
    expect(fs.existsSync(path.join(r.d.s, CARRY_FILE))).toBe(false);                 // the finished turn consumed it
  });

  // 2026-10-21 (launch check): the owner's mail arrived during Agent-1's turn, after its packet was built; "since your last
  // turn" counted from the END of that turn, so the mail was never listed in any packet.
  it("1e. an event that arrives during a turn (after its packet was built) is listed in the next packet; an older record looks back", async () => {
    const MAIL = "063f6ed3-99a3-4b69-a865-33ef5123449f";
    const r = rig((t, s) => {
      if (t === 1 && s === 1) {
        // The owner's mail arrives while this turn works (the controller records it and its digest changes).
        r.world.recentEvents.unshift({ kind: "mail", id: MAIL, at: new Date().toISOString(), tool: "identity read_mail (inbox lists it)" });
        r.world.eventsDigest = hex32(7);
        return { calls: [c("read_file", { path: "product/tracker.csv" })] };
      }
      if (t === 1) return { content: "Done for now.", calls: [c("sleep", { reason: "the tracker is up to date" })] };
      return { calls: [c("sleep", { reason: "read" })] };
    });
    await r.mind.turn("hb");
    await r.mind.turn("hb 2");
    expect(r.packets[0]).not.toContain(MAIL);                                          // it arrived after this packet was built
    expect(r.packets[1]).toContain(`Since your last turn`);
    expect(r.packets[1]).toContain(`mail ${MAIL}`);
    // A record written before eventsSeenAt (Agent-1's own, saved at 11:01:45Z for a turn whose packet was built at 11:01:02Z):
    // the next packet looks back from its end and still lists the mail of 11:01:06Z.
    const r2 = rig(() => ({ calls: [c("sleep", { reason: "read" })] }));
    const end = new Date(Date.now() - 60_000);
    fs.writeFileSync(path.join(r2.d.s, "mind-continuity.json"), JSON.stringify({ at: end.toISOString(), turn: 8, outcome: "(turn stopped: FLEET_COGNITION_RUN_BUDGET_EXHAUSTED)", tools: ["exec"] }));
    r2.world.recentEvents.push({ kind: "mail", id: MAIL, at: new Date(end.getTime() - 39_000).toISOString(), tool: "identity read_mail (inbox lists it)" });
    r2.world.eventsDigest = hex32(8);
    await r2.mind.turn("hb after the upgrade");
    expect(r2.packets[0]).toContain(`mail ${MAIL}`);
  });

  // 2026-10-22: a turn stopped mid-work because its next model call was refused (run budget spent, run ended, provider
  // error) used to save only a closing note: its results were lost, its wake declaration and stall count reset, and the
  // events cursor moved past what it was shown but never acted on.
  it("1f. a turn stopped by a refused model call keeps its working record; the events it was shown are shown again", async () => {
    const MAIL = "5d7f2a10-0b4e-4c55-9d1e-7f00a1b2c3d4";
    const r = rig((t, s) => {
      if (t === 1 && s === 1) return { content: "Plan: read the tracker, then answer the mail.", calls: [c("read_file", { path: "product/tracker.csv" })] };
      if (t === 1) throw Object.assign(new Error("run budget spent"), { code: "FLEET_COGNITION_RUN_BUDGET_EXHAUSTED" });
      return { calls: [c("sleep", { reason: "continued" })] };
    });
    r.world.recentEvents.push({ kind: "mail", id: MAIL, at: new Date(Date.now() - 5_000).toISOString(), tool: "identity read_mail (inbox lists it)" });
    const t1 = await r.mind.turn("hb");
    expect(t1.reason).toBe("stopped: FLEET_COGNITION_RUN_BUDGET_EXHAUSTED");
    expect(fs.existsSync(path.join(r.d.s, CARRY_FILE))).toBe(true);
    await r.mind.turn("hb 2");
    const p2 = r.packets[1];
    expect(p2).toContain("CONTINUE YOUR UNFINISHED WORK");
    expect(p2).toContain("FLEET_COGNITION_RUN_BUDGET_EXHAUSTED");
    expect(p2).toContain("Flat 1");                                                   // turn 1's actual result
    expect(p2).toContain("Plan: read the tracker, then answer the mail.");
    expect(p2).toContain(`mail ${MAIL}`);                                              // shown again: turn 1 never acted on it
  });

  it("1l. a PAID order owed is the packet's objective and next move — not the opportunity or venture push — also after the buyer writes", async () => {
    const ORDER = "6ac71280-60d2-41d1-b2a4-38f21caa4b07";
    const at = new Date(Date.now() - 60_000).toISOString();
    const r = rig(() => ({ calls: [c("sleep", { reason: "checked" })] }));
    for (const [i, ob] of [{ state: "to_deliver", buyerMessages: 0 }, { state: "unanswered", buyerMessages: 1, deliveryOwed: true }].entries()) {
      r.world.obligations = [{ kind: "order", id: ORDER, since: at, lastBuyerAt: at, ...ob }];
      r.world.eventsDigest = hex32(10 + i);
      await r.mind.turn(`hb ${i}`);
      const p = r.packets.at(-1)!;
      expect(p, ob.state).toContain("objective: DELIVER the paid order 6ac71280");
      expect(p, ob.state).toContain('your own goal, after that: g1 \\"Publish the landlord compliance tracker\\"');
      expect(p, ob.state).toContain(`Your next move: DELIVER the paid order ${ORDER}`);
      expect(p, ob.state).toContain("record_external_dependency");
      expect(p, ob.state).not.toContain("Your open goals are your execution path");
      expect(p, ob.state).not.toContain("opportunity-identification cycle");
    }
  });

  it("1m. bounded repetition: steps that only repeat an already-refused action end the turn; the next wake is told why", async () => {
    const r = rig((t) => t === 1 ? { calls: [c("write_file", { path: "/etc/checklist.txt", content: "x" })] } : { calls: [c("sleep", { reason: "changed approach" })] });
    await r.mind.turn("hb");
    expect(r.infers()).toBe(4);                 // one refusal, then three steps of the identical refused call: ended there
    await r.mind.turn("hb 2");
    expect(r.packets[1]).toContain("only repeated actions already refused");
    expect(r.packets[1]).toContain("paths are relative to your workspace");
  });

  it("1n. a repeated refusal is remembered across wakes and a restart: no fresh three retries each wake — the founder waits for a change", async () => {
    const same = () => ({ calls: [c("write_file", { path: "/etc/checklist.txt", content: "x" })] });
    const r = rig(same);
    for (let i = 0; i < 6; i++) await r.mind.turn(`hb ${i}`);
    const first = r.infers();
    expect(first).toBeLessThanOrEqual(8);                       // the cut-off turn (4) + its one assessment turn; then it waits
    const again = rig(same, { root: r.root });                   // a restart: a new process, the same state on disk
    for (let i = 0; i < 4; i++) await again.mind.turn(`after restart ${i}`);
    expect(again.infers()).toBe(0);                              // still waiting: nothing changed
    again.world.eventsDigest = hex32(77);                        // something relevant changes: it wakes once
    await again.mind.turn("changed");
    // The packet names the remembered call before any step. A restart may follow a fix, so the identical call may run ONCE
    // more; repeated again unchanged it is not executed, and three such steps end the turn — no fresh retry series.
    expect(again.packets[0]).toContain("Already tried 3+ times without success — do not repeat these unchanged");
    expect(again.packets[0]).toContain("write_file path=/etc/checklist.txt");
    expect(again.infers()).toBe(4);
    const executed = (seen: string[]) => new Set(seen.filter((o) => !o.includes("NOT RE-RUN"))).size;   // each step re-sends earlier results
    expect(executed(again.outputsSeen)).toBe(1);
    // A third executed failure (across restarts) makes it refused outright: the next restart and change run it zero times.
    const third = rig(same, { root: r.root });
    third.world.eventsDigest = hex32(78);
    await third.mind.turn("changed again");
    const fourth = rig(same, { root: r.root });
    fourth.world.eventsDigest = hex32(79);
    await fourth.mind.turn("changed once more");
    expect(executed(third.outputsSeen)).toBe(1);
    expect(executed(fourth.outputsSeen)).toBe(0);
    expect(fourth.outputsSeen.some((o) => o.includes("FLEET_REPEATED_FAILURE"))).toBe(true);
  });

  it("1o. a delivery that went through keeps its method as a procedure; the next owed order's packet points to it", async () => {
    const ORDER = "6ac71280-60d2-41d1-b2a4-38f21caa4b07";
    const r = rig((t, s) => t === 1
      ? [{ calls: [c("write_file", { path: "/workspace/order/make.py", content: "print(1)" })] },
         { calls: [c("wallet", { op: "deliver", orderId: ORDER, paths: ["order/checklist.pdf"], reviewId: "r1" })] },
         { calls: [c("sleep", { reason: "delivered" })] }][s - 1] ?? { calls: [c("sleep", { reason: "done" })] }
      : { calls: [c("sleep", { reason: "next" })] });
    await r.mind.turn("hb");
    expect(fs.existsSync(path.join(r.d.w, "procedures", "deliver-pdf.md"))).toBe(true);
    expect(fs.readFileSync(path.join(r.d.w, "procedures", "scripts", "make.py"), "utf8")).toBe("print(1)");
    expect(r.outputsSeen.join("\n")).toContain("was kept as procedures/deliver-pdf.md");
    const at = new Date().toISOString();
    r.world.obligations = [{ kind: "order", id: "7bc71280-60d2-41d1-b2a4-38f21caa4b07", state: "to_deliver", since: at, lastBuyerAt: at, buyerMessages: 0 }];
    r.world.eventsDigest = hex32(91);
    await r.mind.turn("hb 2");
    expect(r.packets.at(-1)).toContain("Your saved procedures (methods that worked before");
    expect(r.packets.at(-1)).toContain("procedures/deliver-pdf.md");
  });

  it("1g. a stop (SIGTERM: deploy, restart) ends the turn between steps with its working record saved", async () => {
    const ac = new AbortController();
    const r = rig((t, s) => {
      if (t === 1 && s === 1) { ac.abort(); return { content: "Plan: inspect, then publish.", calls: [c("read_file", { path: "product/tracker.csv" })] }; }
      if (t === 1) return { calls: [c("read_file", { path: "product/never.csv" })] };
      return { calls: [c("sleep", { reason: "continued" })] };
    }, { stopSignal: ac.signal });
    const t1 = await r.mind.turn("hb");
    expect(t1.steps).toBe(1);                                                          // no second step after the stop
    expect(fs.readFileSync(path.join(r.d.s, "mind-log.jsonl"), "utf8")).toContain("FLEET_RUNTIME_STOPPING");
    const carry = JSON.parse(fs.readFileSync(path.join(r.d.s, CARRY_FILE), "utf8"));
    expect(carry.stopCode).toBe("FLEET_RUNTIME_STOPPING");
    expect(JSON.stringify(carry.calls)).toContain("Flat 1");
  });

  // 2026-10-23 (review: "hard-kill recovery must cover external actions"): a process killed mid-turn — here it never comes back
  // from its second model call, as after SIGKILL — leaves its record; the restarted process continues from it and does not
  // repeat the external action it completed (the controller's durable operation also protects it: v95).
  it("1j. a process killed mid-turn leaves its record after every step; its restart continues and does not repeat a completed external action", async () => {
    let reached2 = false;
    const r1 = rig((t, s) => {
      if (s === 1) return { content: "Plan: publish the offer, then tell the owner.", calls: [c("offer", { op: "publish", args: { offerId: "o1" } }), c("read_file", { path: "product/tracker.csv" })] };
      reached2 = true;
      return new Promise<never>(() => {}) as never;                                   // never returns: the process is killed here
    });
    void r1.mind.turn("hb");                                                          // not awaited: it never finishes
    for (let i = 0; i < 100 && !reached2; i++) await new Promise((res) => setTimeout(res, 10));
    expect(reached2).toBe(true);
    expect(r1.world.economyCalls.filter((o) => o === "offer.publish")).toHaveLength(1);
    // A new process on the same state (systemd restarts the unit).
    const r2 = rig((t, s) => s === 1 ? { calls: [c("offer", { op: "publish", args: { offerId: "o1" } })] } : { calls: [c("sleep", { reason: "published" })] }, { root: r1.root });
    await r2.mind.turn("hb after restart");
    const p = r2.packets[0];
    expect(p).toContain("CONTINUE YOUR UNFINISHED WORK");
    expect(p).toContain("FLEET_RUNTIME_INTERRUPTED");
    expect(p).toContain("Flat 1");                                                    // the completed read's result survived
    expect(p).toContain("Plan: publish the offer, then tell the owner.");
    expect(r2.outputsSeen.some((o) => o.includes("FLEET_ALREADY_DONE"))).toBe(true);  // the repeat was not executed
    expect(r2.world.economyCalls.filter((o) => o === "offer.publish")).toHaveLength(0);
    expect(fs.existsSync(path.join(r2.d.s, CARRY_FILE))).toBe(false);                 // the finished turn consumed it
  });

  it("1h. the same result obtained again and again (across turns) gets a platform note to change tactic", async () => {
    const r = rig((t, s) => {
      if (s === 1) return { calls: [c("list_goals")] };
      if (s === 2) return { calls: [c("write_file", { path: `notes/n${t}.md`, content: `note ${t}` })] };   // changes state: the read runs again
      return { calls: [c("sleep", { reason: "later" })] };
    });
    await beats(r, REPEAT_NOTE_AT + 1);
    const notes = r.outputsSeen.filter((o) => o.startsWith("[platform note: you have now obtained this identical result"));
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0]).toContain(`${REPEAT_NOTE_AT} times`);
    // the note is outside the untrusted tool output
    expect(notes[0].indexOf("[platform note")).toBeLessThan(notes[0].indexOf("[untrusted tool output"));
  });

  it("1i. temporary paths and process ids do not make a result new; a changed checksum does", () => {
    const run = (tmp: string, pid: number, sha: string) => `wrote ${tmp}/recalc.xlsx (pid ${pid}); sha256 ${sha}; 1194 blank formulas`;
    expect(normalizeResult(run("/tmp/tmpa8f3k2", 101, "f45c3d00"))).toBe(normalizeResult(run("/tmp/tmpzz91qq", 202, "f45c3d00")));
    expect(normalizeResult(run("/tmp/tmpa8f3k2", 101, "f45c3d00"))).not.toBe(normalizeResult(run("/tmp/tmpa8f3k2", 101, "9be07a11")));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-"));
    const exec = (cmd: string) => ({ name: "exec", arguments: { command: cmd } });
    let pm = new ProgressMemory(path.join(dir, PROGRESS_FILE));
    expect(pm.note(exec("python3 inspect.py"), true, run("/tmp/tmp111111", 1, "f45c3d00"))).toBe("information");
    expect(pm.note(exec("python3 inspect.py --again"), true, run("/tmp/tmp222222", 2, "f45c3d00"))).toBeNull();
    expect(pm.lastTimes).toBe(2);
    pm.save();
    pm = new ProgressMemory(path.join(dir, PROGRESS_FILE));                                // a restart keeps the count
    expect(pm.note(exec("python3 inspect.py"), true, run("/tmp/tmp333333", 3, "f45c3d00"))).toBeNull();
    expect(pm.lastTimes).toBe(3);
  });

  it("1c. a FAILED external action of the carried turn can be retried as it was", async () => {
    let fail = true;
    const r = rig((t, s) => {
      if (t === 1 && s === 1) return { calls: [c("offer", { op: "publish", args: { offerId: "o1" } })] };
      if (t === 1) return { calls: [c("list_goals")] };
      if (t === 2 && s === 1) return { calls: [c("offer", { op: "publish", args: { offerId: "o1" } })] };
      return { calls: [c("sleep", { reason: "retried" })] };
    }, { maxSteps: 3 });
    const tb = (r.mind as unknown as { o: { toolbox: { o: { ports: { economy: (op: string) => Promise<Record<string, unknown>> } } } } }).o.toolbox.o.ports;
    const real = tb.economy;
    tb.economy = async (op: string) => { if (op === "offer.publish" && fail) { fail = false; r.world.economyCalls.push(op); return { ok: false, code: "FLEET_UNAVAILABLE" }; } return real(op); };
    await r.mind.turn("hb 1");
    await r.mind.turn("hb 2");
    expect(r.world.economyCalls.filter((x) => x === "offer.publish")).toHaveLength(2);         // the retry ran
    expect(r.outputsSeen.some((x) => x.includes("FLEET_ALREADY_DONE"))).toBe(false);
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

  it("2. progress is new information or new work: not re-reads, unchanged statuses, the same result under other arguments, or the same targets rewritten each turn", async () => {
    const m = new ProgressMemory(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wc-p-")), "p.json"));
    const turn = (...calls: Array<[ToolCall, boolean, string]>) => { for (const [k, ok, out] of calls) m.note(k, ok, out); return m.endTurn(); };
    const read = c("read_file", { path: "product/tracker.csv" });
    expect(turn([read, true, "property,gas_safety_due"])).toBe(true);
    expect(turn([read, true, "property,gas_safety_due"])).toBe(false);                                       // re-read
    expect(turn([read, true, "[unchanged since your identical call earlier]\nproperty,gas_safety_due"])).toBe(false); // the loop guard's repeat
    expect(turn([read, true, "property,gas_safety_due,eicr_due"])).toBe(true);                               // the file changed
    const status = c("storefront", { op: "products" });
    expect(turn([status, true, '{"status":"draft","asOf":"2026-10-18T13:08:43.085Z"}'])).toBe(true);
    expect(turn([status, true, '{"status":"draft","asOf":"2026-10-18 13:09:49+00"}'])).toBe(false);          // only the clock moved
    expect(turn([c("storefront", { op: "products", page: 2 }), true, '{"status":"draft","asOf":"2026-10-18T13:10:00Z"}'])).toBe(false); // other arguments, same result
    expect(turn([status, true, '{"status":"published"}'])).toBe(true);                                       // a real change
    expect(turn([c("web_search", { query: "landlord EICR tracker" }), true, "5 results: certnudge.co.uk …"])).toBe(true);
    expect(turn([c("web_search", { query: "landlord EICR tracker uk" }), true, "5 results: certnudge.co.uk …"])).toBe(false); // reworded, nothing new
    // A counter rewritten every turn is not work: the first write is new, the next turn's rewrite of the same target alone is not.
    expect(turn([c("write_file", { path: "state/counter.txt", content: "1" }), true, "wrote 1 bytes"])).toBe(true);
    expect(turn([c("write_file", { path: "state/counter.txt", content: "2" }), true, "wrote 1 bytes"])).toBe(false);
    expect(turn([c("write_file", { path: "state/counter.txt", content: "3" }), true, "wrote 1 bytes"])).toBe(false);
    // Real iteration: the same product file rewritten WITH new information (a calculation, a review) is progress.
    expect(turn([c("write_file", { path: "product/tracker.xlsx", content: "v1" }), true, "wrote"])).toBe(true);
    expect(turn([c("write_file", { path: "product/tracker.xlsx", content: "v2 with EICR column" }), true, "wrote"], [c("exec", { cmd: "python check.py" }), true, "formulas recalculate: 0 errors, 42 rows"])).toBe(true);
    // Recording a conclusion (a fact, a decision) is intermediate work; recording the same one again is not.
    expect(turn([c("remember_fact", { key: "price", value: "£5 private offer" }), true, "remembered"])).toBe(true);
    expect(turn([c("remember_fact", { key: "price", value: "£5 private offer" }), true, "remembered"])).toBe(false);
    // Failures and sleep are never progress; normalisation ignores timestamps (PostgreSQL's +00 too) and ages.
    expect(turn([c("read_file", { path: "missing" }), false, "not found"], [c("sleep", { reason: "x" }), true, "ok"])).toBe(false);
    expect(normalizeResult('{"ageS": 42, "at": "2026-10-18 12:30:54+00", "x": "2026-10-18T12:30:54.111Z"}')).toBe('{"ageS":0, "at": "<t>", "x": "<t>"}');
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

  it("3b. a founder cut off at its step budget turn after turn, learning nothing new, waits after its assessment turn: zero inference until a change", async () => {
    // The revision rehearsal of 2026-10-20: every call refused, every step used, one paid turn a minute.
    const r = rig(() => ({ calls: [c("list_files", { path: "" }), c("read_file", { path: "product/missing.xlsx" })] }), { maxSteps: 3 });
    await r.mind.turn("hb 1");                                  // first results: progress (cut off)
    await r.mind.turn("hb 2");                                  // nothing new, cut off: stalled once
    const stalledOnce = r.infers();
    await beats(r, 3);                                          // the one assessment turn (its carried record shows the refusals)
    expect(r.infers()).toBeGreaterThan(stalledOnce);
    const waiting = r.infers();
    await beats(r, 30);
    expect(r.infers()).toBe(waiting);                           // stalled twice: waiting, though no turn ever finished
    // A restart while waiting → still zero.
    const again = rig(() => ({ calls: [c("list_files", { path: "" })] }), { root: r.root, maxSteps: 3 });
    Object.assign(again.world, r.world);
    await beats(again, 10);
    expect(again.infers()).toBe(0);
    // A change it may act on (the controller's events digest) wakes it, with its carried working record.
    r.world.eventsDigest = hex32(9);
    await beats(r, 1);
    expect(r.infers()).toBeGreaterThan(waiting);
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

  it("5. an oversized turn still runs: lower-value lines shrink first; the task, the carried plan, the oldest unseen notice and the founder's facts stay", async () => {
    const r = rig(() => ({ calls: [c("sleep", { reason: "read it all" })] }), { maxSteps: 4 });
    // The founder's own memory and workspace at Agent-1's real scale (14 facts ≈ 5.4 KB, 13 research files, 4 notes).
    fs.writeFileSync(path.join(r.d.m, "facts.json"), JSON.stringify(Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`fact-${i}`, `${"landlord compliance detail ".repeat(12)}${i}`]))));
    fs.mkdirSync(path.join(r.d.w, "research"), { recursive: true });
    for (let i = 0; i < 13; i++) fs.writeFileSync(path.join(r.d.w, "research", `r${i}.txt`), `attemptId: a${i}\nurl: https://example.com/${i}\nfetchedAt: 2026-09-26T15:2${i % 10}:00Z\nsha256: ${"0".repeat(64)}\n\n${"evidence text ".repeat(80)}`);
    for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(r.d.w, `note${i}.md`), "note ".repeat(400));
    // A large carried record, five long notices, five dependencies.
    fs.writeFileSync(path.join(r.d.s, CARRY_FILE), JSON.stringify({ at: "2026-10-18T13:00:00Z", turn: 9, steps: 16, plan: "PLAN-KEEP: publish the £5 offer next.",
      calls: Array.from({ length: 16 }, (_, i) => ({ name: "read_file", args: `{"path":"f${i}"}`, ok: true, result: "R".repeat(600), external: false, sig: `read_file:${i}` })),
      done: [{ sig: "offer:o1", name: "offer", args: '{"op":"publish"}', result: "ok" }], notRun: [{ name: "exec", args: '{"cmd":"x"}' }] }));
    // The controller lists notices newest first; the oldest unseen one (last here) is shown first, in full.
    r.world.notices = Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, at: `2026-10-18T13:0${4 - i}:00Z`, body: `${i === 4 ? "OLDEST-NOTICE " : ""}${"notice text ".repeat(120)}` }));
    r.world.requests = Array.from({ length: 5 }, (_, i) => ({ requestId: `0000000${i}-0000-4000-8000-000000000000`, kind: "kyc", action: "a".repeat(200), title: "t", status: "pending", ageS: 60 }));
    await r.mind.turn("x".repeat(2_500));
    expect(r.infers()).toBe(1);                                     // it thought; it was not refused
    const p = r.packets[0];
    expect(p.length).toBeLessThanOrEqual(15_000);
    expect(p).toContain("CONTINUE YOUR UNFINISHED WORK");
    expect(p).toContain("PLAN-KEEP: publish the £5 offer next.");
    expect(p).toContain("OLDEST-NOTICE");
    expect(p).toContain("fact-0");                                  // its remembered facts were not dropped
  });

  it("6. fitting never drops essentials: every open request stays, unseen notices are queued (shown in full, marked seen only when shown)", async () => {
    const r = rig(() => ({ calls: [c("sleep", { reason: "read" })] }), { maxSteps: 4 });
    fs.writeFileSync(path.join(r.d.m, "facts.json"), JSON.stringify(Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`fact-${i}`, `${"landlord compliance detail ".repeat(12)}${i}`]))));
    for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(r.d.w, `note${i}.md`), "note ".repeat(400));
    r.world.requests = [
      ...Array.from({ length: 4 }, (_, i) => ({ requestId: `0000000${i}-0000-4000-8000-000000000000`, kind: "kyc", action: `OPEN-REQUEST-${i} ${"a".repeat(150)}`, title: "t", status: "pending", ageS: 60 })),
      ...Array.from({ length: 4 }, (_, i) => ({ requestId: `1000000${i}-0000-4000-8000-000000000000`, kind: "kyc", action: `RESOLVED-${i} ${"b".repeat(150)}`, title: "t", status: "answered", response: "r".repeat(300), ageS: 60, decidedAt: new Date().toISOString() })),
    ];
    r.world.notices = Array.from({ length: 4 }, (_, i) => ({ id: `n${i}`, at: `2026-10-18T13:0${i}:00Z`, body: `NOTICE-${i}-START ${"policy text ".repeat(110)} NOTICE-${i}-END` }));
    r.world.notices.reverse();                                    // the controller lists the newest first
    await r.mind.turn("x".repeat(2_500));
    expect(r.infers()).toBe(1);
    const p1 = r.packets[0];
    for (let i = 0; i < 4; i++) expect(p1).toContain(`OPEN-REQUEST-${i}`);       // all open requests, at any level
    expect(p1).toContain("NOTICE-0-START"); expect(p1).toContain("NOTICE-0-END");  // the oldest unseen notice, in full
    // The notices not shown this turn are not lost: each later turn shows the next, in full, until all have been seen.
    const seen = new Set<string>(["NOTICE-0"]);
    for (let t = 0; t < 6 && seen.size < 4; t++) {
      r.world.eventsDigest = hex32(100 + t);                          // something changes: a new working turn
      await beats(r, 3);
      for (let i = 0; i < 4; i++) if ((r.packets.at(-1) ?? "").includes(`NOTICE-${i}-START`) && (r.packets.at(-1) ?? "").includes(`NOTICE-${i}-END`)) seen.add(`NOTICE-${i}`);
    }
    expect([...seen].sort()).toEqual(["NOTICE-0", "NOTICE-1", "NOTICE-2", "NOTICE-3"]);
  });

  it("7. when the essentials alone cannot fit, the turn makes no model call and reports the fault (the controller raises AGENT_CANNOT_THINK)", async () => {
    const r = rig(() => ({ calls: [c("sleep", { reason: "x" })] }), { maxSteps: 4 });
    // Essentials far beyond the packet: 5 open requests and 5 notices of maximum length, all of which must be kept.
    r.world.requests = Array.from({ length: 5 }, (_, i) => ({ requestId: `0000000${i}-0000-4000-8000-000000000000`, kind: "kyc", action: "a".repeat(200), title: "t", status: "pending", ageS: 60 }));
    const huge = { id: "nx", at: "2026-10-18T13:00:00Z", body: "p".repeat(1_500) };
    r.world.notices = [huge];
    r.world.ownerPending = 1;                                       // and an owner turn with a very long message
    const econ = (r.mind as unknown as { o: { ports: { economy: (op: string, a?: Record<string, unknown>) => Promise<Record<string, unknown>> } } }).o.ports;
    const real = econ.economy; const reports: Array<Record<string, unknown>> = [];
    econ.economy = async (op: string, a?: Record<string, unknown>) => {
      if (op === "owner.claim") { r.world.ownerPending = 0; return { ok: true, turnId: "t1", messages: Array.from({ length: 4 }, (_, i) => ({ messageId: `m${i}`, body: "Q".repeat(4_000), files: [] })) }; }
      if (op === "mind.report") reports.push(a ?? {});
      return real(op, a);
    };
    await r.mind.turn("hb");
    expect(r.infers()).toBe(0);                                     // nothing was sent half-formed
    expect(reports.some((x) => x.fault === "packet_unfit")).toBe(true);
  });

  it("8. a working turn that ends by declaring what it waits for waits at once: no extra paid turn; its wake condition still wakes it", async () => {
    const r = rig((t, s) => (t === 1 && s === 1
      ? { calls: [c("write_file", { path: "notes/plan.md", content: "plan v1" }), c("sleep", { reason: "plan written; waiting for the buyer", wakeOn: "a customer message" })] }
      : { calls: [c("sleep", { reason: "x" })] }));
    await r.mind.turn("hb 1");
    expect(r.infers()).toBe(1);
    await beats(r, 30);
    expect(r.infers()).toBe(1);                                     // nothing changed: no call at all
    r.world.eventsDigest = hex32(77);                               // the awaited event (e.g. a customer message) arrives
    await beats(r, 2);
    expect(r.infers()).toBeGreaterThan(1);
  });

  it("9. a waiting founder whose runtime changed wakes once and is told what changed; a restart on the same runtime stays free", async () => {
    // Attempt 2 (2026-10-18): Agent-1 kept waiting through its 32634bf upgrade — which had fixed the refusal it was waiting
    // on — until Fleet Control sent a notice by hand. An upgrade is a change: one turn, a factual line, then waiting again.
    const A = "94dce86f43898d98a596b2457a47fa43335c238f", B = "32634bfe7f9062a6484da713e985612acd80e694";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wc-up-"));
    const wait = (t: number, s: number): Step => (t === 1 && s === 1 && !fs.existsSync(path.join(root, "w", "notes"))
      ? { calls: [c("write_file", { path: "notes/plan.md", content: "plan v1" }), c("sleep", { reason: "publish refused; waiting", wakeOn: "a change to the refusal" })] }
      : { calls: [c("sleep", { reason: "waiting", wakeOn: "a customer message" })] });
    const onA = rig(wait, { root, runtime: A });
    await onA.mind.turn("hb");
    expect(onA.infers()).toBe(1);
    const cont = () => JSON.parse(fs.readFileSync(path.join(root, "s", "mind-continuity.json"), "utf8")) as Record<string, unknown>;
    expect(cont()).toMatchObject({ waiting: true, runtime: A });
    // A restart on the SAME runtime: still waiting, no call.
    const againA = rig(wait, { root, runtime: A });
    await beats(againA, 10);
    expect(againA.infers()).toBe(0);
    // The upgrade: exactly one turn, with the line (a full packet, never the slim "nothing changed" one), then waiting again.
    const onB = rig(wait, { root, runtime: B });
    await beats(onB, 10);
    expect(onB.infers()).toBe(1);
    expect(onB.packets[0]).toContain("Your runtime was upgraded since your last turn (94dce86 → 32634bf)");
    expect(onB.packets[0]).toContain("an action blocked as a repeat may be tried again if it still matters");
    expect(onB.packets[0]).toContain("Permissions, limits and approvals are unchanged");
    expect(onB.packets[0]).not.toContain("Nothing has changed since your last turn");
    expect(cont()).toMatchObject({ waiting: true, runtime: B });
    const againB = rig(wait, { root, runtime: B });
    await beats(againB, 10);
    expect(againB.infers()).toBe(0);
    expect(againB.packets).toHaveLength(0);
    // A record written by a runtime that did not record itself (32634bf and older): one wake, named as an earlier runtime.
    const legacy = cont(); delete legacy.runtime;
    fs.writeFileSync(path.join(root, "s", "mind-continuity.json"), JSON.stringify(legacy));
    const fromLegacy = rig(wait, { root, runtime: B });
    await beats(fromLegacy, 5);
    expect(fromLegacy.infers()).toBe(1);
    expect(fromLegacy.packets[0]).toContain("(an earlier runtime → 32634bf)");
  });

  // Scope (stated, not implied): this proves the three protections it exercises across an upgrade restart — the runtime's
  // carried record of ONE cut-off turn (a completed publish in it is not repeated), the manifest's per-call decision and
  // the controller's per-call refusal. It is NOT duplicate protection for every tool or across finished turns: that is the
  // controller's durable operation register (v95), tested with real dispatch counts in fleet-v95-durable-operations-pg.
  it("10. across an upgrade restart: a completed action carried from a cut-off turn is not repeated; a non-grantable tool and a controller refusal are still refused", async () => {
    const A = "94dce86f43898d98a596b2457a47fa43335c238f", B = "32634bfe7f9062a6484da713e985612acd80e694";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wc-auth-"));
    const tries = () => [c("offer", { op: "publish", args: { offerId: "o1" } }), c("transfer_credits", { to: "x", amount: 1 }), c("offer", { op: "publish", args: { offerId: "o9" } })];
    // On A: o1 is published (a completed external action); a non-grantable tool and a controller-refused publish fail;
    // the turn is cut off at its step limit, so its record (completed actions included) is carried.
    const onA = rig((t, s) => (s === 1 ? { calls: tries() } : { calls: [c("list_goals")] }), { root, runtime: A, maxSteps: 2 });
    onA.world.refuse["offer.publish:o9"] = "FLEET_SALES_CLOSED";
    await onA.mind.turn("hb");
    expect(onA.world.economyCalls.filter((x) => x === "offer.publish")).toHaveLength(2);    // o1 done, o9 refused
    expect(fs.existsSync(path.join(root, "s", CARRY_FILE))).toBe(true);
    // On B (the upgrade): the same three calls.
    const onB = rig((t, s) => (s === 1 ? { calls: tries() } : { calls: [c("sleep", { reason: "checked", wakeOn: "sales opening" })] }), { root, runtime: B });
    onB.world.refuse["offer.publish:o9"] = "FLEET_SALES_CLOSED";
    await beats(onB, 3);
    expect(onB.packets[0]).toContain("Your runtime was upgraded since your last turn (94dce86 → 32634bf)");
    const seen = onB.outputsSeen.join("\n");
    expect(seen).toContain("NOT EXECUTED FLEET_ALREADY_DONE");                 // o1: the completed publish is not repeated
    expect(seen).toContain("FLEET_CAPABILITY_NOT_GRANTABLE");                  // the manifest still decides, per call
    expect(seen).toContain("FLEET_SALES_CLOSED");                              // the controller still decides, per call
    expect(onB.world.economyCalls.filter((x) => x === "offer.publish")).toHaveLength(1);    // only o9 reached the controller (and was refused)
  });
});

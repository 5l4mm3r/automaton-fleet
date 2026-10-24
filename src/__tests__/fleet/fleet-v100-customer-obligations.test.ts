/**
 * v100 runtime — a buyer's request is an obligation until it is resolved (2026-10-19, the purchase proof: the owner's fault
 * report on the paid order went unanswered; the agent saw it once, as an event, and from its next turn on never again).
 * Production FounderMind + FounderToolbox with the production options and a scripted model; the controller is a fake
 * that keeps the obligations as v100 derives them (tests/fleet-v100-obligations-pg.test.ts proves the SQL itself).
 *
 *  1. The proof's case: an UNANSWERED buyer message is in the packet; a sleep is refused (the turn goes on), an answer
 *     settles it, and the turn then sleeps.
 *  2. The acknowledged request stays in every later packet, slim ones included, until it is resolved; resolved, it leaves.
 *  3. Waiting costs nothing: after the answer and a declared sleep, heartbeats and a restart make ZERO model calls (the
 *     agent's own answer does not wake it); a new buyer message does, and the packet says UNANSWERED again.
 *  4. A buyer message that arrives DURING a turn still wakes the agent after it.
 *  5. An answer the controller refuses does not trap the agent: it may then sleep.
 *  6. Refusals carry bounded, redacted reasons — in the mind log and in the closing note to the controller.
 *  7. An inspector killed by the host's system-call filter is a PLATFORM fault (FLEET_PLATFORM_FAULT), never "bad request".
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { FounderMind, FOUNDER_STEPS_PER_TURN, type MindPorts } from "../../fleet/founder/mind.js";
import { FounderToolbox } from "../../fleet/founder/toolbox.js";
import { LoopGuard } from "../../fleet/founder/loop-guard.js";
import { FOUNDER_MANIFEST_V2, manifestSha256 } from "../../fleet/capabilities.js";
import { capabilityView } from "../../fleet/cognition/capability-signature.js";
import { obligationLines, owedDeliveryLine, parseObligations, refusalReason } from "../../fleet/founder/obligations.js";
import { FOUNDER_TOOLS, type ToolCall } from "../../fleet/cognition/types.js";

const CAPS = { ok: true, origin: "reseed_founder", manifestId: "founder-v2", manifestSha256: manifestSha256(FOUNDER_MANIFEST_V2),
  allowed: [...FOUNDER_MANIFEST_V2.allowed], reproductionExecutable: false, paymentExecutable: false, experimentsEnabled: false, ownerRequests: true };
const c = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: `${name}-${Math.random().toString(36).slice(2, 8)}`, name, arguments: args });
const ORDER = "1186e00e-1111-4222-8333-444455556666";
const hex32 = (n: number) => n.toString(16).padStart(32, "0");

type Step = { calls: ToolCall[]; content?: string };
type Ob = { kind: "order" | "enquiry"; id: string; state: "unanswered" | "acknowledged"; since: string; lastBuyerAt: string; buyerMessages: number; repliedAt?: string };

/** The controller's view of one order thread, as v100 derives it. */
function thread() {
  const msgs: Array<{ author: "buyer" | "agent"; at: number; resolves?: boolean }> = [];
  let delivered = 0;
  let clock = Date.parse("2026-10-19T19:13:09Z");
  const tick = () => (clock += 60_000);
  return {
    buyer() { msgs.push({ author: "buyer", at: tick() }); },
    agent(resolves = false) { msgs.push({ author: "agent", at: tick(), resolves }); },
    deliver() { delivered = tick(); },
    obligations(): Ob[] {
      const resolvedAt = Math.max(delivered, ...msgs.filter((m) => m.author === "agent" && m.resolves).map((m) => m.at), 0);
      const open = msgs.filter((m) => m.author === "buyer" && m.at > resolvedAt);
      if (!open.length) return [];
      const since = open[0].at, last = open.at(-1)!.at;
      const replied = Math.max(0, ...msgs.filter((m) => m.author === "agent" && m.at > since).map((m) => m.at));
      return [{ kind: "order", id: ORDER, state: replied && replied > last ? "acknowledged" : "unanswered", since: new Date(since).toISOString(),
        lastBuyerAt: new Date(last).toISOString(), buyerMessages: open.length, ...(replied ? { repliedAt: new Date(replied).toISOString() } : {}) }];
    },
    buyerCount: () => msgs.filter((m) => m.author === "buyer").length,
  };
}

function rig(script: (turn: number, step: number, packet: string) => Step, o: { root?: string; t?: ReturnType<typeof thread>; refuseReply?: string } = {}) {
  const root = o.root ?? fs.mkdtempSync(path.join(os.tmpdir(), "v100-"));
  const d = { w: path.join(root, "w"), s: path.join(root, "s"), m: path.join(root, "s", "memory") };
  for (const x of Object.values(d)) fs.mkdirSync(x, { recursive: true });
  const t = o.t ?? thread();
  const reports: Array<Record<string, unknown>> = [];
  const packets: string[] = [];
  const outputs: string[] = [];
  let infers = 0, turn = 0, step = 0;
  const midTurn: Array<() => void> = [];
  // v67 digest: a buyer message changes it (count); the agent's own answer does not.
  const status = () => ({ policyEnabled: true, provider: "anthropic", founderEnabled: true, paused: false, routing: { active: true },
    capabilities: { ...capabilityView(CAPS, true), reproductionExecutable: false },
    attention: { ownerPending: 0, eventsDigest: hex32(t.buyerCount()), notices: [], recentEvents: [], customerObligations: t.obligations() },
    survival: { survivalEquityCents: 9_000, inferenceTodayCents: 80, burnPerDayCents: 40, runwayDays: 240 } });
  const economy = async (op: string, args?: Record<string, unknown>) => {
    if (op === "mind.report") { reports.push(args ?? {}); return { ok: true }; }
    if (op === "order.message") {
      if (o.refuseReply) return { ok: false, code: o.refuseReply };
      t.agent(args?.resolved === true);
      midTurn.splice(0).forEach((f) => f());
      return { ok: true, messageId: "m-agent", obligation: t.obligations()[0] ?? null };
    }
    if (op === "order.deliver") { t.deliver(); return { ok: true }; }
    if (op === "order.thread") return { ok: true, thread: [{ author: "buyer", body: "[untrusted] the dates show as numbers" }] };
    return { ok: true, op };
  };
  const ports: MindPorts = {
    cognitionStatus: async () => status(),
    ledger: async () => ({ cash: 9_000, survivalEquity: 9_000, genesisAllocation: 10_000, externalCustomerRevenue: 500 }),
    ownerRequests: async () => ({ ok: true, requests: [] }),
    economy,
    infer: async (messages) => {
      const ms = messages as Array<{ role: string; content: string }>;
      if (ms.length === 1) { turn++; step = 0; packets.push(String(ms[0].content)); }
      const last = ms.at(-1)!;
      if (last.role === "tool") outputs.push(last.content);
      step++; infers++;
      const s = script(turn, step, packets.at(-1)!);
      return { content: s.content ?? "", toolCalls: s.calls, usage: { inputTokens: 1, outputTokens: 1 }, chargedCents: 1, requestId: `r${turn}-${step}` };
    },
  };
  const loopGuard = new LoopGuard();
  const toolbox = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: d.w, memoryDir: d.m, loopGuard, selfGovernance: true,
    ports: { ledger: async () => ({}), ownerRequests: async () => ({ ok: true, requests: [] }), economy } as never });
  const mind = new FounderMind({ ports, toolbox, stateDir: d.s, workContinuity: true, hibernationSafetyMs: Number.POSITIVE_INFINITY,
    maxStepsPerTurn: FOUNDER_STEPS_PER_TURN, routed: { memoryDir: d.m, workspaceDir: d.w, manifest: FOUNDER_MANIFEST_V2, loopGuard } });
  return { mind, t, root, d, packets, outputs, reports, midTurn, infers: () => infers };
}
const beats = async (r: ReturnType<typeof rig>, n: number) => { for (let i = 0; i < n; i++) await r.mind.turn(`heartbeat ${i}`); };
const reply = (message: string, resolved?: boolean) => c("customers", { op: "order_message", args: { orderId: ORDER, message, ...(resolved ? { resolved } : {}) } });
const nap = c("sleep", { reason: "answered the buyer; the revision waits on the office renderer", wakeOn: "the office renderer becomes available, or a new buyer message" });

describe("v100: a buyer's request is an obligation until it is resolved", () => {
  it("1-3. the proof's case: refused sleep, an answer, then free waiting — across a restart — until the buyer writes again", async () => {
    const t = thread();
    t.buyer();                                                     // the owner's fault report, 19:14
    const script = (turn: number, s: number, packet: string): Step => {
      if (packet.includes("is UNANSWERED") && s === 1) return { calls: [c("sleep", { reason: "nothing actionable" })] };   // what Agent-1 did
      if (packet.includes("is UNANSWERED") && s === 2) return { calls: [c("customers", { op: "order_thread", args: { orderId: ORDER } }), reply("Thanks — I have your report and am fixing the dates; I will send the corrected file.")] };
      return { calls: [nap] };
    };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "v100-a-"));
    const r = rig(script, { root, t });
    await r.mind.turn("hb");
    expect(r.packets[0]).toMatch(new RegExp(`order ${ORDER}: the buyer's message of 2026-10-19 19:14 UTC is UNANSWERED`));
    expect(r.packets[0]).toContain("you cannot sleep while a buyer waits for an answer");
    expect(r.outputs[0]).toContain("FLEET_CUSTOMER_UNANSWERED");   // the refused sleep did not end the turn
    expect(r.infers()).toBe(3);                                    // refused sleep → answer → sleep
    expect(t.obligations()[0].state).toBe("acknowledged");

    // 3. waiting is free: the agent's own answer changed the obligation's state, and that does not wake it.
    await beats(r, 6);
    expect(r.infers()).toBe(3);
    const restarted = rig(script, { root, t });                    // a restart on the same state
    await beats(restarted, 6);
    expect(restarted.infers()).toBe(0);

    // The buyer writes again: one wake, and the request is UNANSWERED in the packet.
    t.buyer();
    await beats(restarted, 2);
    expect(restarted.packets[0]).toMatch(/is UNANSWERED \(2 buyer messages since 2026-10-19 19:14 UTC\)/);
    expect(restarted.infers()).toBe(3);                            // refused sleep → answer → sleep, as before
  });

  it("2. the acknowledged request stays in every packet (slim ones too) until a delivery or a resolving answer resolves it", async () => {
    const t = thread();
    t.buyer(); t.agent();                                           // answered, not resolved
    const lines = obligationLines(parseObligations({ customerObligations: t.obligations() })!);
    expect(lines[0]).toContain(`order ${ORDER}: answered 2026-10-19 19:15 UTC, not yet resolved (the buyer's request of 2026-10-19 19:14 UTC)`);
    expect(lines[0]).not.toContain("you cannot sleep");
    const r = rig(() => ({ calls: [c("sleep", { reason: "resting" })] }), { t });
    await beats(r, 12);                                             // a rest, then slim wake-ups on the unchanged state
    expect(r.packets.length).toBeGreaterThan(1);
    for (const p of r.packets) expect(p).toContain(`order ${ORDER}: answered`);
    t.deliver();                                                    // the revised files went out after the request
    expect(t.obligations()).toEqual([]);
    t.buyer(); t.agent(true);                                       // a question answered in full: resolved by the answer
    expect(t.obligations()).toEqual([]);
  });

  it("4. a buyer message that arrives during the turn wakes the agent after it", async () => {
    const t = thread();
    t.buyer();
    const r = rig((_turn, s, packet) => (packet.includes("UNANSWERED") && s === 1 ? { calls: [reply("Received — working on it.")] } : { calls: [nap] }), { t });
    r.midTurn.push(() => t.buyer());                               // the buyer writes again right after the answer
    await r.mind.turn("hb");
    expect(r.infers()).toBe(2);
    await beats(r, 2);
    expect(r.packets.length).toBe(2);                              // woke for the message that came during the turn
    expect(r.packets[1]).toContain("is UNANSWERED");
  });

  it("5. an answer the controller refuses does not trap the agent: it may sleep, and the request stays on record", async () => {
    const t = thread();
    t.buyer();
    const r = rig((_turn, s) => (s === 1 ? { calls: [reply("On it.")] } : { calls: [nap] }), { t, refuseReply: "FLEET_BUYER_PENDING" });
    await r.mind.turn("hb");
    expect(r.outputs.join("\n")).not.toContain("FLEET_CUSTOMER_UNANSWERED");
    expect(r.infers()).toBe(2);
    expect(t.obligations()[0].state).toBe("unanswered");
  });

  it("6. refusals carry bounded, redacted reasons — in the mind log and in the closing note", async () => {
    expect(refusalReason("REFUSED FLEET_X: mail buyer@example.com at https://api.agentfleet.vip/order/" + "ab".repeat(32) + " ref 123456789012 order 1186e00e-1111-4222-8333-444455556666"))
      .toBe("mail <email> at <url> ref <number> order 1186e00e-1111-4222-8333-444455556666");
    expect(refusalReason("NOT DONE FLEET_Y: " + "x ".repeat(400)).length).toBeLessThanOrEqual(300);
    const t = thread();
    t.buyer();
    const r = rig((_turn, s) => (s === 1 ? { calls: [c("sleep", { reason: "nothing to do" })] } : s === 2 ? { calls: [reply("Received.")] } : { calls: [nap] }), { t });
    await r.mind.turn("hb");
    const log = fs.readFileSync(path.join(r.d.s, "mind-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const refused = log.flatMap((e) => (e.tools ?? []) as Array<Record<string, unknown>>).find((x) => x.refused === "FLEET_CUSTOMER_UNANSWERED");
    expect(refused?.reason).toMatch(/^a buyer is waiting for an answer: order 1186e00e-1111-4222-8333-444455556666/);
    await new Promise((res) => setTimeout(res, 20));
    const note = r.reports.at(-1)!;
    expect(note.refusals).toEqual([{ tool: "sleep", code: "FLEET_CUSTOMER_UNANSWERED", reason: refused!.reason }]);
  });

  it("7. an inspector killed by the host's system-call filter is a platform fault, never a bad request", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "v100-q-"));
    const ws = path.join(root, "w"), mem = path.join(root, "m");
    fs.mkdirSync(path.join(ws, "product"), { recursive: true }); fs.mkdirSync(mem);
    fs.writeFileSync(path.join(ws, "product/t.xlsx"), "PK");
    const fake = path.join(root, "python-killed");                 // as the helper's shell reports a child killed by SIGSYS
    fs.writeFileSync(fake, "#!/bin/sh\necho 'Bad system call (core dumped)' >&2\nexit 159\n", { mode: 0o755 });
    const tb = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: ws, memoryDir: mem, sandboxPython: fake,
      ports: { ledger: async () => ({}), economy: async () => ({ ok: true }) } as never });
    const out = await tb.execute(c("deliverable", { op: "inspect", args: { paths: ["product/t.xlsx"] } }));
    expect(out).toMatchObject({ ok: false, refused: "FLEET_PLATFORM_FAULT" });
    expect(out.output).toContain("killed by signal 31 — a system call this host's sandbox does not allow");
    expect(out.output).toContain("not your request: your files were not judged");
    const bad = await tb.execute(c("deliverable", { op: "inspect", args: { paths: ["product/missing.xlsx"] } }));
    expect(bad).toMatchObject({ ok: false, refused: "FLEET_BAD_REQUEST" });   // a genuine bad request stays one
  });

  it("the deliver tool says how to send a corrected file on a delivered order: resendReason with after (the earlier delivery's operation)", () => {
    // 2026-10-20 (the revision rehearsal in real units): "resendReason (only to send a delivered order again)" alone is
    // refused FLEET_OPERATION_EXISTS by the v95 operation register; the description must name `after`.
    const wallet = FOUNDER_TOOLS.find((t) => t.name === "wallet")!.description;
    const deliver = wallet.slice(wallet.indexOf("op deliver:"), wallet.indexOf("op fulfil:"));
    expect(deliver).toMatch(/resendReason\? \(only to send a delivered order again — with after: the operationId of the order's latest delivery/);
  });
});

describe("a paid order's delivery stays owed whatever the conversation (review 2026-10-23)", () => {
  it("deliveryOwed is parsed for every order; the line says the delivery is still owed after the buyer wrote and after an answer", () => {
    const at = "2026-10-23T15:46:10.000Z";
    const list = parseObligations({ customerObligations: [
      { kind: "order", id: ORDER, state: "unanswered", since: at, lastBuyerAt: at, buyerMessages: 1, deliveryOwed: true },
      { kind: "order", id: "2286e00e-1111-4222-8333-444455556666", state: "acknowledged", since: at, lastBuyerAt: at, buyerMessages: 1, repliedAt: at, deliveryOwed: true },
      { kind: "order", id: "3386e00e-1111-4222-8333-444455556666", state: "to_deliver", since: at, lastBuyerAt: at, buyerMessages: 0,
        bought: { item: "A one-page PDF: 'Gas safety' checklist\n(England)\u0000", fulfilment: "digital_file", amountMinor: 700, currency: "GBP", promised: ["A tick box per point", 7] } },
      { kind: "order", id: "4486e00e-1111-4222-8333-444455556666", state: "acknowledged", since: at, lastBuyerAt: at, buyerMessages: 1, repliedAt: at },
    ] })!;
    expect(list.map((o) => o.deliveryOwed)).toEqual([true, true, true, false]);
    const [line] = obligationLines(list);
    expect(line.match(/delivery is still OWED/g)).toHaveLength(2);
    expect(line).toContain(`bought (the order record, data): "A one-page PDF: 'Gas safety' checklist (England)" (a digital file, 7.00 GBP); the offer promises: "A tick box per point"; its delivery is OWED — see what was bought`);
    expect(line).toContain("record_external_dependency");
    expect(line).toContain("stays owed until it is delivered or refunded");
    expect(owedDeliveryLine([ORDER])).toMatch(/^Your next move: DELIVER the paid order 1186e00e-1111-4222-8333-444455556666 — /);
  });
});

describe("v115: the brief spells out the order's message work", async () => {
  const { parseObligations, obligationLines } = await import("../../fleet/founder/obligations.js");
  const ORDER = "6ac71280-60d2-41d1-b2a4-38f21caa4b07", M1 = "11111111-1111-4111-8111-111111111111", M2 = "22222222-2222-4222-8222-222222222222";
  const C = "33333333-3333-4333-8333-333333333333";
  const at = new Date().toISOString();
  it("messages to classify, a disputed one, and an owed correction's outcomes; nothing for messages awaiting Fleet Control", () => {
    const list = parseObligations({ customerObligations: [{ kind: "order", id: ORDER, state: "acknowledged", since: at, lastBuyerAt: at, repliedAt: at, buyerMessages: 2, revisionOwed: true,
      work: { classify: [M1, M2], disputed: [M2], reviewPending: 1, corrections: [{ correctionId: C, sourceMessageId: M1,
        criteria: [{ outcome: "The checklist is laid out in two columns", kind: "layout" }, { outcome: "Point 7 has a next-check date line", kind: "add", mustShow: ["next annual check"] }] }] } }] })!;
    expect(list[0].work).toMatchObject({ classify: [M1, M2], disputed: [M2], reviewPending: 1 });
    const text = obligationLines(list).join("\n");
    expect(text).toContain(`CLASSIFY the buyer's messages ${M1}, ${M2}`);
    expect(text).toContain(`Fleet Control did not confirm "conversation" for ${M2}`);
    expect(text).toContain(`OWED correction ${C}`);
    expect(text).toContain('"The checklist is laid out in two columns"');
    expect(text).toContain('(must show: "next annual check")');
    expect(text).toContain("listing EACH outcome word for word as a met criterion");
    expect(text).toContain("1 message(s) wait for Fleet Control's check: nothing to do for them");
  });
  it("work with nothing in it is dropped (an older controller, or nothing owed)", () => {
    const list = parseObligations({ customerObligations: [{ kind: "order", id: ORDER, state: "acknowledged", since: at, lastBuyerAt: at, buyerMessages: 1, revisionOwed: true,
      work: { classify: ["not-a-uuid"], corrections: [] } }] })!;
    expect(list[0].work).toBeUndefined();
  });
});

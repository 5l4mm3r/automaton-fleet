/**
 * Run 6 (2026-10-24): turn 1's packet was built at 11:32:59.6Z; the paid order was created ~2–3 s later. The turn ran 15
 * steps over 6.5 minutes of unrelated research (four ~88 s browser calls) without seeing it — a packet is built only at a
 * turn's start. Between steps the mind now re-reads the controller's attention; newly owed work ends the turn at that safe
 * boundary (the step's tools finished and recorded), its record is carried, and the next turn's packet leads with the order.
 * Scripted cognition (each step "takes" 6 s of a slow local model); no database, no model.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { FounderMind, FOUNDER_STEPS_PER_TURN, NEW_WORK_CHECK_MS, type MindPorts } from "../../fleet/founder/mind.js";
import { FounderToolbox } from "../../fleet/founder/toolbox.js";
import { LoopGuard } from "../../fleet/founder/loop-guard.js";
import { FOUNDER_MANIFEST_V2, manifestSha256 } from "../../fleet/capabilities.js";
import { capabilityView } from "../../fleet/cognition/capability-signature.js";
import type { ToolCall } from "../../fleet/cognition/types.js";

const CAPS = { ok: true, origin: "reseed_founder", manifestId: "founder-v2", manifestSha256: manifestSha256(FOUNDER_MANIFEST_V2),
  allowed: [...FOUNDER_MANIFEST_V2.allowed], reproductionExecutable: false, paymentExecutable: false, experimentsEnabled: false, ownerRequests: true };
const ORDER = "27de487c-973b-4a1c-a838-e8d1595c5654";
const c = (name: string, args: Record<string, unknown>): ToolCall => ({ id: `${name}-${Math.random().toString(36).slice(2, 8)}`, name, arguments: args });

function rig(o: { orderArrives?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newwork-"));
  const d = { w: path.join(root, "w"), s: path.join(root, "s"), m: path.join(root, "s", "memory") };
  for (const x of Object.values(d)) fs.mkdirSync(x, { recursive: true });
  let orderPaid = false;
  const economy: Array<{ op: string; at: number }> = [];
  const packets: string[] = [];
  const attentionReads: number[] = [];
  const obligation = () => ({ kind: "order", id: ORDER, state: "to_deliver", since: new Date().toISOString(), lastBuyerAt: new Date().toISOString(), buyerMessages: 0,
    deliveryOwed: true, bought: { item: "A one-page PDF: 'Gas safety: the landlord's annual 10-point checklist' (England)", fulfilment: "digital_file", amountMinor: 700, currency: "GBP", promised: [] } });
  let turn = 0, step = 0, lastPacket = "";
  /** The model: in turn 1 it starts a venture, then researches step after step; once a packet shows the order, it turns to it. */
  const script = (packet: string, s: number): ToolCall[] => {
    if (packet.includes(ORDER.slice(0, 8))) {
      if (s === 1) return [c("venture", { op: "create", args: { key: "landlord", model: "digital_product", offer: "landlord documents", state: "selected" } })];  // the same call again
      if (s === 2) return [c("wallet", { op: "orders", args: { orderId: ORDER } })];
      return [];
    }
    if (s === 1) return [c("venture", { op: "create", args: { key: "landlord", model: "digital_product", offer: "landlord documents", state: "selected" } })];
    return [c("list_files", { path: `research/${s}` })];                             // unrelated research, step after step
  };
  const ports: MindPorts = {
    cognitionStatus: async () => {
      attentionReads.push(Date.now());
      return { policyEnabled: true, provider: "local", founderEnabled: true, paused: false, routing: { active: true },
        capabilities: { ...capabilityView(CAPS, true), reproductionExecutable: false }, attention: { customerObligations: orderPaid ? [obligation()] : [] } };
    },
    ledger: async () => ({ cash: 10_000, survivalEquity: 10_000, genesisAllocation: 10_000, externalCustomerRevenue: 0 }),
    ownerRequests: async () => ({ ok: true, requests: [] }),
    infer: async (messages) => {
      const packet = String((messages as Array<{ content: string }>)[0].content);
      if (packet !== lastPacket || messages.length === 1) { turn++; step = 0; lastPacket = packet; packets.push(packet); }
      step++;
      vi.setSystemTime(Date.now() + 6_000);                                           // a slow local model step
      return { content: "", toolCalls: script(packet, step), usage: { inputTokens: 1, outputTokens: 1 }, chargedCents: 0, requestId: `r${turn}-${step}` };
    },
  };
  const loopGuard = new LoopGuard();
  const toolbox = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: d.w, memoryDir: d.m, loopGuard, selfGovernance: true, ports: {
    ledger: async () => ({}), ownerRequests: async () => ({ ok: true, requests: [] }),
    economy: async (op: string) => {
      economy.push({ op, at: Date.now() });
      if (op === "venture.create" && o.orderArrives !== false) orderPaid = true;     // the order is paid while this call is in flight
      return { ok: true };
    },
  } as never });
  const mind = new FounderMind({ ports, toolbox, stateDir: d.s, workContinuity: true, hibernationSafetyMs: Number.POSITIVE_INFINITY, maxStepsPerTurn: FOUNDER_STEPS_PER_TURN,
    routed: { memoryDir: d.m, workspaceDir: d.w, manifest: FOUNDER_MANIFEST_V2, loopGuard } });
  const log = () => fs.readFileSync(path.join(d.s, "mind-log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
  return { mind, packets, economy, attentionReads, log, turns: () => turn };
}

afterEach(() => { vi.useRealTimers(); });

describe("new paid work reaches a running turn (run 6)", () => {
  it("an order paid after the turn's packet ends the turn at the next step boundary; the next packet leads with it; nothing is repeated", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-24T11:32:59Z"));
    const r = rig();
    expect(FOUNDER_STEPS_PER_TURN).toBeGreaterThanOrEqual(12);
    const t1 = await r.mind.turn("Heartbeat 1");
    expect(r.packets[0]).not.toContain(ORDER.slice(0, 8));                             // built before the order existed
    // Turn 1 did not research through all its steps: it stopped once the order showed, at a boundary.
    const stop = r.log().find((x) => x.turn === 1 && x.stopped);
    expect(stop).toMatchObject({ stopped: "FLEET_NEW_PRIORITY", newWork: [`${ORDER.slice(0, 8)}:delivery`] });
    expect(t1.steps).toBeLessThanOrEqual(1 + Math.ceil(NEW_WORK_CHECK_MS / 6_000));    // within ~10 s of model time after the order
    expect(t1.steps).toBeLessThan(FOUNDER_STEPS_PER_TURN);
    // The in-flight call finished and was recorded (its result is in the log), not cut off.
    expect(r.log().find((x) => x.turn === 1 && x.step === 0)?.tools).toEqual([{ name: "venture", ok: true }]);
    // The next turn's packet leads with the order.
    await r.mind.turn("Heartbeat 2");
    expect(r.turns()).toBe(2);
    expect(r.packets[1]).toContain(`DELIVER the paid order ${ORDER.slice(0, 8)}`);
    expect(r.packets[1]).toContain("new customer work arrived — it comes first");
    // The external action completed in turn 1 is not repeated in turn 2 (one controller call, the repeat answered from the record).
    expect(r.economy.filter((x) => x.op === "venture.create")).toHaveLength(1);
    expect(r.log().find((x) => x.turn === 2 && x.step === 0)?.tools).toMatchObject([{ name: "venture", ok: false, refused: "FLEET_ALREADY_DONE" }]);
    // The attention reads are bounded: at most one per NEW_WORK_CHECK_MS of the turn's time (plus the turn's own).
    expect(r.attentionReads.length).toBeLessThanOrEqual(6);
  });

  it("with no new work, a turn is not interrupted (it runs its steps)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-24T11:32:59Z"));
    const r = rig({ orderArrives: false });
    const t = await r.mind.turn("Heartbeat 1");
    expect(r.log().some((x) => x.stopped === "FLEET_NEW_PRIORITY")).toBe(false);
    expect(t.steps).toBe(FOUNDER_STEPS_PER_TURN);
    expect(r.attentionReads.length).toBeGreaterThan(2);                                  // it did look, between steps
  });
});

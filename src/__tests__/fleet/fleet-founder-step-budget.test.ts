/**
 * 2026-10-18 proof run — the founder's turn budget (scripted cognition; no database, no model).
 *
 * Agent-1 looped for half an hour: each turn spent its 4 steps re-orienting (storefront status, list_files, list_files,
 * read_file), ended without a closing note, and the next turn re-oriented again — a paid loop with no progress. These
 * tests drive the production FounderMind and FounderToolbox:
 *   - the production budget (FOUNDER_STEPS_PER_TURN) lets a turn orient AND act in one go;
 *   - a turn that uses every step says so in the next turn's packet (continue, do not re-read);
 *   - a turn that made no call the previous turn had not already made rests like a sleep (no paid repeat each minute);
 *     a turn with anything new does not.
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
import type { ToolCall } from "../../fleet/cognition/types.js";

const CAPS = { ok: true, origin: "reseed_founder", manifestId: "founder-v2", manifestSha256: manifestSha256(FOUNDER_MANIFEST_V2),
  allowed: [...FOUNDER_MANIFEST_V2.allowed], reproductionExecutable: false, paymentExecutable: false, experimentsEnabled: false, ownerRequests: true };

/** `reply(turn, step)` scripts the model: the tool calls of that step (none = the turn ends). */
function rig(reply: (turn: number, step: number) => ToolCall[], maxStepsPerTurn?: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "steps-"));
  const d = { w: path.join(root, "w"), s: path.join(root, "s"), m: path.join(root, "s", "memory") };
  for (const x of Object.values(d)) fs.mkdirSync(x, { recursive: true });
  fs.mkdirSync(path.join(d.w, "product"));
  fs.writeFileSync(path.join(d.w, "product", "tracker.csv"), "property,gas_safety_due\n");
  fs.writeFileSync(path.join(d.m, "goals.json"), JSON.stringify([{ id: "g1", title: "Publish the landlord compliance tracker", status: "open" }]));
  const packets: string[] = [];
  let turn = 0;
  let step = 0;
  let lastPacket = "";
  const ports: MindPorts = {
    cognitionStatus: async () => ({ policyEnabled: true, provider: "anthropic", founderEnabled: true, paused: false, routing: { active: true },
      capabilities: { ...capabilityView(CAPS, true), reproductionExecutable: false }, survival: { survivalEquityCents: 9_906, inferenceTodayCents: 80, burnPerDayCents: 40, runwayDays: 240 } }),
    ledger: async () => ({ cash: 9_906, survivalEquity: 9_906, genesisAllocation: 10_000, externalCustomerRevenue: 0 }),
    ownerRequests: async () => ({ ok: true, requests: [] }),
    infer: async (messages) => {
      const packet = String((messages as Array<{ content: string }>)[0].content);
      if (packet !== lastPacket || messages.length === 1) { turn++; step = 0; lastPacket = packet; packets.push(packet); }
      step++;
      return { content: "", toolCalls: reply(turn, step), usage: { inputTokens: 1, outputTokens: 1 }, chargedCents: 1, requestId: `r${turn}-${step}` };
    },
  };
  const loopGuard = new LoopGuard();
  const toolbox = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: d.w, memoryDir: d.m, loopGuard, selfGovernance: true, ports: {
    ledger: async () => ({}), ownerRequests: async () => ({ ok: true, requests: [] }), economy: async () => ({ ok: true }),
  } as never });
  const mind = new FounderMind({ ports, toolbox, stateDir: d.s, hibernationSafetyMs: 0, maxStepsPerTurn,
    routed: { memoryDir: d.m, workspaceDir: d.w, manifest: FOUNDER_MANIFEST_V2, loopGuard } });
  return { mind, packets, turns: () => turn };
}
const c = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: `${name}-${Math.random().toString(36).slice(2, 8)}`, name, arguments: args });

describe("the founder's turn budget (proof run 2026-10-18)", () => {
  it("the production budget lets one turn orient and then act: six reads, a write and a closing sleep in a single turn", async () => {
    expect(FOUNDER_STEPS_PER_TURN).toBeGreaterThanOrEqual(12);
    const plan = [c("list_files", { path: "" }), c("list_files", { path: "product" }), c("read_file", { path: "product/tracker.csv" }), c("list_goals"),
      c("list_files", { path: "research" }), c("check_ledger"), c("write_file", { path: "product/README.txt", content: "How to use the tracker" }),
      c("sleep", { reason: "README written; next: the offer" })];
    const r = rig((_t, s) => (plan[s - 1] ? [plan[s - 1]] : []), FOUNDER_STEPS_PER_TURN);
    const res = await r.mind.turn("heartbeat");
    expect(res.steps).toBe(8);
    expect(res.toolCalls).toEqual(plan.map((p) => p.name));
    expect(r.turns()).toBe(1);
  });

  it("a turn that uses every step tells the next turn to continue instead of re-reading", async () => {
    const r = rig((t, s) => [c("read_file", { path: `product/tracker.csv`, note: `${t}-${s}` })], 4);
    const first = await r.mind.turn("heartbeat 1");
    expect(first.steps).toBe(4);
    await r.mind.turn("heartbeat 2");
    expect(r.packets).toHaveLength(2);
    expect(r.packets[1]).toContain("this turn used all 4 steps before finishing: continue the same work in the next turn; do not repeat reads you already did");
  });

  it("a turn that only repeats calls already made in the previous turn rests like a sleep; a turn with anything new does not", async () => {
    // The loop exactly as it ran: the same status, list and read calls, two steps a turn, every minute.
    const loop = [[c("storefront", { action: "status" })], [c("list_files", { path: "" })]];
    const r = rig((t, s) => (t === 4 && s === 1 ? [c("write_file", { path: "product/offer.md", content: "£5 tracker" })] : loop[s - 1] ?? []), FOUNDER_STEPS_PER_TURN);
    await r.mind.turn("hb 1");                        // turn 1: new calls
    const second = await r.mind.turn("hb 2");         // turn 2: nothing new → it rests
    expect(second.repeated).toBe(true);
    const resting = await r.mind.turn("hb 3");        // the next slot is skipped: no paid inference
    expect(resting.ran).toBe(false);
    expect(r.turns()).toBe(2);
    for (let i = 4; r.turns() < 3 && i < 12; i++) await r.mind.turn(`hb ${i}`);
    expect(r.turns()).toBe(3);                         // the backoff ends; it thinks again (and repeats again)
    for (let i = 12; r.turns() < 4 && i < 30; i++) await r.mind.turn(`hb ${i}`);
    expect(r.turns()).toBe(4);
    // Turn 4 wrote something new: not a repeat, so the next slot runs at once.
    const after = await r.mind.turn("hb after");
    expect(after.ran).toBe(true);
  });
});

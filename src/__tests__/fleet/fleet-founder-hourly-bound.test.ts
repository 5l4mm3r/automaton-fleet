/**
 * Desktop runs 2 and 3 (2026-10-23/24, Qwen3.5-9B): once the 120 calls/hour bound was reached the founder asked again at
 * every heartbeat — 1,095 refusals in 19 minutes (run 2), 255 in 4.5 (run 3), a median gap of 1.04 s. The missing fix
 * (8077f6c) never reached the desktop; this is an equivalent implementation from that behaviour: at the bound the founder
 * makes no call until one can be made (its own calls tell when the oldest leaves the rolling hour; otherwise it backs off),
 * and the bound itself is unchanged. Scripted cognition; no database, no model.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { FounderMind, type MindPorts } from "../../fleet/founder/mind.js";
import { FounderToolbox } from "../../fleet/founder/toolbox.js";
import { LoopGuard } from "../../fleet/founder/loop-guard.js";
import { FOUNDER_MANIFEST_V2, manifestSha256 } from "../../fleet/capabilities.js";
import { capabilityView } from "../../fleet/cognition/capability-signature.js";

const CAPS = { ok: true, origin: "reseed_founder", manifestId: "founder-v2", manifestSha256: manifestSha256(FOUNDER_MANIFEST_V2),
  allowed: [...FOUNDER_MANIFEST_V2.allowed], reproductionExecutable: false, paymentExecutable: false, experimentsEnabled: false, ownerRequests: true };
const MAX = 3;
const HOUR = 3_600_000;

/** A controller that counts calls over a rolling hour and refuses at the bound (as svc_cognition_authorize does). */
function rig(o: { report: "both" | "max" | "none" }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hourly-"));
  const d = { w: path.join(root, "w"), s: path.join(root, "s"), m: path.join(root, "s", "memory") };
  for (const x of Object.values(d)) fs.mkdirSync(x, { recursive: true });
  const logged: number[] = [];
  let attempts = 0;
  const lastHour = () => logged.filter((t) => t > Date.now() - HOUR).length;
  const ports: MindPorts = {
    cognitionStatus: async () => ({ policyEnabled: true, provider: "local", founderEnabled: true, paused: false, routing: { active: true },
      capabilities: { ...capabilityView(CAPS, true), reproductionExecutable: false },
      ...(o.report === "both" ? { turnsLastHour: lastHour() } : {}), ...(o.report !== "none" ? { maxTurnsPerHour: MAX } : {}) }),
    ledger: async () => ({ cash: 9_906, survivalEquity: 9_906, genesisAllocation: 10_000, externalCustomerRevenue: 0 }),
    ownerRequests: async () => ({ ok: true, requests: [] }),
    infer: async () => {
      attempts++;
      if (lastHour() >= MAX) throw Object.assign(new Error("rate limited"), { code: "FLEET_COGNITION_RATE_LIMITED" });
      logged.push(Date.now());
      return { content: "", toolCalls: [{ id: `c${attempts}`, name: "list_goals", arguments: { n: attempts } }], usage: { inputTokens: 1, outputTokens: 1 }, chargedCents: 0, requestId: `r${attempts}` };
    },
  };
  const loopGuard = new LoopGuard();
  const toolbox = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: d.w, memoryDir: d.m, loopGuard, selfGovernance: true, ports: {
    ledger: async () => ({}), ownerRequests: async () => ({ ok: true, requests: [] }), economy: async () => ({ ok: true }),
  } as never });
  const mind = new FounderMind({ ports, toolbox, stateDir: d.s, hibernationSafetyMs: 0, maxStepsPerTurn: 4,
    routed: { memoryDir: d.m, workspaceDir: d.w, manifest: FOUNDER_MANIFEST_V2, loopGuard } });
  return { mind, attempts: () => attempts, logged };
}

/** Heartbeats one simulated second apart (the scenario's cadence) for `seconds`. */
async function heartbeats(mind: FounderMind, seconds: number) {
  const reasons: string[] = [];
  for (let i = 0; i < seconds; i++) {
    vi.setSystemTime(Date.now() + 1_000);
    reasons.push(String((await mind.turn(`Heartbeat ${i}`)).reason ?? ""));
  }
  return reasons;
}

afterEach(() => { vi.useRealTimers(); });

describe("the hourly call bound: rest until a call can be made (desktop runs 2–3)", () => {
  it("after a refusal at the bound, no call is asked for until the oldest call leaves the hour; then calls resume", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-24T00:00:00Z"));
    const r = rig({ report: "max" });                                        // the count is not shown: the founder learns of it by the refusal
    await r.mind.turn("Heartbeat 0");
    expect(r.logged).toHaveLength(MAX);
    expect(r.attempts()).toBe(MAX + 1);                                      // one refused call
    const reasons = await heartbeats(r.mind, 590);                           // ~10 minutes of 1-second heartbeats
    expect(r.attempts()).toBe(MAX + 1);                                      // was ~590 refusals before
    expect(reasons.at(-1)).toMatch(/^resting: hourly call limit \(3\) reached, next call from /);
    await heartbeats(r.mind, 20);                                            // a rest is at most 10 minutes: asks once, refused, rests again
    expect(r.attempts()).toBe(MAX + 2);
    // The wait is bounded (≤ 10 min at a time) and the controller's count decides: still at the bound → refused again, rest again.
    vi.setSystemTime(r.logged[0] + HOUR + 3_000);
    await r.mind.turn("Heartbeat after the hour");
    expect(r.logged.length).toBeGreaterThan(MAX);                            // a slot opened: calls resume
  });

  it("when FleetController's count shows the bound reached, no call is made at all; the rest ends when its own calls say so", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-24T00:00:00Z"));
    const r = rig({ report: "both" });
    await r.mind.turn("Heartbeat 0");
    const before = r.attempts();
    const reasons = await heartbeats(r.mind, 300);
    expect(r.attempts()).toBe(before);                                       // not even one refused call per rest
    expect(reasons.filter((x) => x.startsWith("resting: hourly call limit (3) reached, next call from ")).length).toBe(300);
    vi.setSystemTime(r.logged[0] + HOUR + 3_000);
    await heartbeats(r.mind, 1);
    expect(r.attempts()).toBeGreaterThan(before);
  });

  it("with nothing known of the bound or the window (an older controller, a restart), it backs off 60 s, then doubles — never a call a second", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-24T00:00:00Z"));
    const r = rig({ report: "none" });
    await r.mind.turn("Heartbeat 0");                                        // 3 calls, then refused
    const fresh = rig({ report: "none" });
    // The same controller history, a new runtime: copy the calls in, the new mind knows none of them.
    fresh.logged.push(...r.logged);
    await fresh.mind.turn("Heartbeat 0");                                    // refused at once
    expect(fresh.attempts()).toBe(1);
    await heartbeats(fresh.mind, 59);
    expect(fresh.attempts()).toBe(1);
    await heartbeats(fresh.mind, 2);
    expect(fresh.attempts()).toBe(2);                                        // asked again after 60 s
    await heartbeats(fresh.mind, 110);
    expect(fresh.attempts()).toBe(2);                                        // the next wait is 120 s
    await heartbeats(fresh.mind, 12);
    expect(fresh.attempts()).toBe(3);
  });
});

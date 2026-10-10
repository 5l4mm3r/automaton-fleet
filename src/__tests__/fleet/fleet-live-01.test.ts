/**
 * F1-LIVE-01 — autonomous-loop liveness (founder side; no database, no model).
 *
 * Founder 1 slept for days partly because its "has anything changed?" wake digest ignored capability, so the experiment
 * pipeline appeared behind repeated "nothing has changed" packets. These tests drive the production FounderMind with
 * scripted cognition. (Owner requests became action-scoped dependencies in F2-A: see fleet-f2a-autonomy.test.ts.)
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { FounderMind, MAX_IDLE_SKIP, wakeDigest, type MindPorts } from "../../fleet/founder/mind.js";
import { FounderToolbox } from "../../fleet/founder/toolbox.js";
import { LoopGuard } from "../../fleet/founder/loop-guard.js";
import { FOUNDER_MANIFEST_V2, manifestSha256 } from "../../fleet/capabilities.js";
import { type ToolCall } from "../../fleet/cognition/types.js";
import { capabilityView, founderStepTools } from "../../fleet/cognition/capability-signature.js";
import { taskPacketProblems } from "../../fleet/cognition/task-packet.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "live01-"));
const CAPS = (o: Record<string, unknown> = {}) => ({ ok: true, origin: "genesis_founder", manifestId: "founder-v2", manifestSha256: manifestSha256(FOUNDER_MANIFEST_V2),
  allowed: [...FOUNDER_MANIFEST_V2.allowed], reproductionExecutable: false, paymentExecutable: false, experimentsEnabled: false,
  experimentFinancialMode: "simulated", experimentHardCapMinor: 5000, experimentMaxActive: 3, ...o });

describe("F1-LIVE-01 semantic capability signature (controller side)", () => {
  it("covers what the founder can do — tools, manifest, experiment bounds, switches — and nothing else", () => {
    const base = capabilityView(CAPS(), true);
    expect(base.signature).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic; unaffected by key order, timestamps, build ids or commit hashes (not inputs).
    expect(capabilityView({ ...CAPS(), at: new Date().toISOString(), buildId: "x".repeat(64), commit: "c".repeat(40) }, true).signature).toBe(base.signature);
    expect(capabilityView(Object.fromEntries(Object.entries(CAPS()).reverse()), true).signature).toBe(base.signature);
    // Each genuine capability change changes it.
    const on = capabilityView(CAPS({ experimentsEnabled: true }), true);
    expect(on.signature).not.toBe(base.signature);
    expect(on.tools.filter((t) => !base.tools.includes(t))).toEqual(["add_experiment_evidence", "list_experiments", "propose_experiment", "record_experiment", "start_experiment"]);
    expect(capabilityView(CAPS({ experimentsEnabled: true, experimentHardCapMinor: 9000 }), true).signature).not.toBe(on.signature);
    expect(capabilityView(CAPS({ paymentExecutable: true }), true).signature).not.toBe(base.signature);
    expect(capabilityView(CAPS({ manifestSha256: "f".repeat(64) }), true).signature).not.toBe(base.signature);
    expect(capabilityView(CAPS(), false).signature).not.toBe(base.signature); // routed adds the cognition tools
    expect(capabilityView(CAPS({ allowed: FOUNDER_MANIFEST_V2.allowed.filter((c) => c !== "research.web") }), true).tools).not.toContain("web_fetch");
  });

  it("the routed gateway and the signature use one tool list (no drift)", () => {
    const tools = founderStepTools(CAPS({ experimentsEnabled: true }), true).map((t) => t.name);
    expect(capabilityView(CAPS({ experimentsEnabled: true }), true).tools).toEqual([...new Set(tools)].sort());
    expect(tools).toEqual(expect.arrayContaining(["record_external_dependency", "withdraw_external_dependency", "routine_task", "escalate_question", "propose_experiment"]));
  });
});

// ─────────────────────────────────────────────── the routed founder mind

type Rig = ReturnType<typeof rig>;
function rig(o: { caps?: () => Record<string, unknown> | null; owner?: () => unknown; reply?: (n: number) => ToolCall[] } = {}) {
  const root = tmp();
  const dirs = { w: path.join(root, "w"), s: path.join(root, "s"), m: path.join(root, "s", "memory") };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(dirs.m, "facts.json"), JSON.stringify({ product: "built" }));
  fs.writeFileSync(path.join(dirs.m, "goals.json"), JSON.stringify([{ id: "g1", title: "Find a sales channel", status: "open" }]));
  const calls: string[] = [];
  let n = 0;
  const ports: MindPorts = {
    cognitionStatus: async () => {
      const c = o.caps?.();
      return { policyEnabled: true, provider: "anthropic", founderEnabled: true, paused: false, routing: { active: true }, ...(c ? { capabilities: capabilityView(c, true) } : {}) };
    },
    ledger: async () => ({ cash: 9_000 - n, genesisAllocation: 10_000 }),
    ...(o.owner ? { ownerRequests: async () => o.owner!() } : {}),
    infer: async (messages) => {
      calls.push(String((messages as Array<{ content: string }>)[0].content));
      n++;
      // R41.1: the founder DECLARES its hibernation (reason + wake condition), so slim wakes are earned at once; these tests
      // observe capability-change detection on top of that.
      return { content: "", toolCalls: o.reply?.(n) ?? [{ id: `t${n}`, name: "sleep", arguments: { reason: "waiting", wakeOn: "a marketplace reply" } }], usage: { inputTokens: 1, outputTokens: 1 }, chargedCents: 0, requestId: `r${n}` };
    },
  };
  const loopGuard = new LoopGuard();
  const toolbox = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: dirs.w, memoryDir: dirs.m, loopGuard, ports: {
    ledger: async () => ({}), spendOrder: async () => ({}), proposeKnowledge: async () => ({}), knowledge: async () => [], requestIdentityFact: async () => ({}),
  } });
  const mind = new FounderMind({ ports, toolbox, stateDir: dirs.s, hibernationSafetyMs: 0 /* v62: 0 = the timer backoff only (slim-packet mechanics) */, routed: { memoryDir: dirs.m, workspaceDir: dirs.w, manifest: FOUNDER_MANIFEST_V2, loopGuard } });
  /** Turn until the next inference call happens (thinking slots skipped by the idle backoff cost nothing). */
  const next = async () => {
    const before = calls.length;
    for (let i = 0; i <= MAX_IDLE_SKIP + 1 && calls.length === before; i++) await mind.turn(`heartbeat ${i}`);
    expect(calls.length).toBe(before + 1);
    const text = calls.at(-1)!;
    const body = JSON.parse(text.split("\n").slice(3).join("\n"));
    expect(taskPacketProblems(body)).toEqual([]);
    return { text, body, slim: /Nothing has changed since your last turn/.test(body.task as string) };
  };
  return { mind, next, dirs, calls };
}
const seq = async (r: Rig, k: number) => { const out = []; for (let i = 0; i < k; i++) out.push(await r.next()); return out; };

describe("F1-LIVE-01 capability change detection (founder runtime)", () => {
  it("a newly available capability yields exactly ONE full packet naming it; then slim wake-ups resume", async () => {
    let caps = CAPS();
    const r = rig({ caps: () => caps });
    const [first, second, third] = await seq(r, 3);
    expect(first.slim).toBe(false);
    expect(first.body.task).toMatch(/Your available tools \(first capability record of this runtime\): .*record_external_dependency/);
    expect([second.slim, third.slim]).toEqual([true, true]);
    expect(second.body.task).not.toMatch(/capabilit/i);
    caps = CAPS({ experimentsEnabled: true }); // the owner switches the pipeline on
    const [changed, after1, after2] = await seq(r, 3);
    expect(changed.slim).toBe(false);
    expect(changed.body.task).toMatch(/Your capabilities changed since your last turn\. Newly available: add_experiment_evidence, list_experiments, propose_experiment, record_experiment, start_experiment\. Experiment pipeline: ON \(simulated; you size it from your own available capital — FleetController checks custody only; up to 3 active\)/);
    expect([after1.slim, after2.slim]).toEqual([true, true]); // acknowledged once; no repeated full packets
    caps = CAPS(); // switched off again: one more full packet, naming what went away
    const [off, offAfter] = await seq(r, 2);
    expect(off.slim).toBe(false);
    expect(off.body.task).toMatch(/No longer available: add_experiment_evidence/);
    expect(offAfter.slim).toBe(true);
  });

  it("an advertised tool this runtime does not implement is not a capability (and a controller without the signature changes nothing)", async () => {
    const r = rig({ caps: () => CAPS() });
    await seq(r, 2);
    // A controller newer than this runtime advertises a tool the runtime cannot execute: the effective set is unchanged.
    const status = (r.mind as unknown as { o: { ports: MindPorts } }).o.ports;
    const plain = status.cognitionStatus;
    status.cognitionStatus = async () => {
      const s = await plain();
      const c = s.capabilities as { tools: string[]; signature: string };
      return { ...s, capabilities: { ...c, tools: [...c.tools, "future_tool"].sort(), signature: "f".repeat(64) } };
    };
    const quiet = await r.next();
    expect(quiet.slim).toBe(true);
    expect(quiet.body.task).not.toMatch(/future_tool/);
    // No signature at all (an older controller): the R23.1 digest exactly as before.
    const legacy = rig();
    const [a, b] = await seq(legacy, 2);
    expect([a.slim, b.slim]).toEqual([false, true]);
    expect(a.body.task).not.toMatch(/capabilit/i);
    expect(wakeDigest(legacy.dirs.m, legacy.dirs.w, {})).toBe(wakeDigest(legacy.dirs.m, legacy.dirs.w, {}, "")); // empty signals = the old digest
  });

  it("a continuity record from an older runtime (no capability record) gets one full inventory packet after the upgrade", async () => {
    const r = rig();
    await seq(r, 2); // older behaviour: sleeps, slim
    const state = r.dirs.s;
    const c = JSON.parse(fs.readFileSync(path.join(state, "mind-continuity.json"), "utf8"));
    expect(c.capabilities).toBeUndefined();
    const upgraded = rig({ caps: () => CAPS({ experimentsEnabled: true }) });
    fs.copyFileSync(path.join(state, "mind-continuity.json"), path.join(upgraded.dirs.s, "mind-continuity.json"));
    const [first, second] = await seq(upgraded, 2);
    expect(first.slim).toBe(false);
    expect(first.body.task).toMatch(/first capability record.*propose_experiment.*Experiment pipeline: ON/s);
    expect(second.slim).toBe(true);
  });
});

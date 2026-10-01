/**
 * F1-LIVE-01 — autonomous-loop liveness (founder side; no database, no model).
 *
 * Founder 1 slept for days: (1) its "has anything changed?" wake digest ignored capability, so the experiment pipeline
 * appeared behind repeated "nothing has changed" packets; (2) its owner request sat in the knowledge queue with no answer
 * path. These tests drive the production FounderMind and FounderToolbox with scripted cognition.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { FounderMind, MAX_IDLE_SKIP, ownerRequestLines, parseOwnerRequests, staleBucket, wakeDigest, type MindPorts, type OwnerRequestView } from "../../fleet/founder/mind.js";
import { FounderToolbox } from "../../fleet/founder/toolbox.js";
import { LoopGuard } from "../../fleet/founder/loop-guard.js";
import { FOUNDER_MANIFEST_V2, decideTool, manifestSha256 } from "../../fleet/capabilities.js";
import { FOUNDER_TOOLS, type ToolCall } from "../../fleet/cognition/types.js";
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
    expect(tools).toEqual(expect.arrayContaining(["request_owner_decision", "withdraw_owner_request", "routine_task", "escalate_question", "propose_experiment"]));
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
      return { content: "", toolCalls: o.reply?.(n) ?? [{ id: `t${n}`, name: "sleep", arguments: { reason: "waiting" } }], usage: { inputTokens: 1, outputTokens: 1 }, chargedCents: 0, requestId: `r${n}` };
    },
  };
  const loopGuard = new LoopGuard();
  const toolbox = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: dirs.w, memoryDir: dirs.m, loopGuard, ports: {
    ledger: async () => ({}), spendOrder: async () => ({}), proposeKnowledge: async () => ({}), knowledge: async () => [], requestIdentityFact: async () => ({}),
  } });
  const mind = new FounderMind({ ports, toolbox, stateDir: dirs.s, routed: { memoryDir: dirs.m, workspaceDir: dirs.w, manifest: FOUNDER_MANIFEST_V2, loopGuard } });
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
    expect(first.body.task).toMatch(/Your available tools \(first capability record of this runtime\): .*request_owner_decision/);
    expect([second.slim, third.slim]).toEqual([true, true]);
    expect(second.body.task).not.toMatch(/capabilit/i);
    caps = CAPS({ experimentsEnabled: true }); // the owner switches the pipeline on
    const [changed, after1, after2] = await seq(r, 3);
    expect(changed.slim).toBe(false);
    expect(changed.body.task).toMatch(/Your capabilities changed since your last turn\. Newly available: add_experiment_evidence, list_experiments, propose_experiment, record_experiment, start_experiment\. Experiment pipeline: ON \(simulated; hard cap 5000 minor units; up to 3 active\)/);
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

describe("F1-LIVE-01 owner-request liveness in the task packet", () => {
  const req = (o: Partial<OwnerRequestView> & { ageS: number }) => ({ requestId: "62cbe1b7-0000-4000-8000-000000000001", category: "sales_channel", goalRef: "g1",
    title: "Enable a Gumroad channel", blocking: true, status: "pending", stale: o.ageS >= 86_400, staleAfterS: 86_400, response: null, ...o });

  it("stale buckets: fresh −1; then 0, 1, 2 … at 1×, 2×, 4× the threshold, capped; decided requests have none", () => {
    const b = (ageS: number, o: Partial<OwnerRequestView> = {}) => staleBucket(parseOwnerRequests({ requests: [req({ ageS, ...o })] })![0]);
    expect([b(3_600), b(86_400), b(1.9 * 86_400), b(2 * 86_400), b(5 * 86_400), b(8 * 86_400), b(400 * 86_400)]).toEqual([-1, 0, 0, 1, 2, 3, 6]);
    expect(b(9 * 86_400, { status: "declined" })).toBe(-1);
    expect(parseOwnerRequests({ nope: 1 })).toBeNull();
  });

  it("lines: pending shows age; STALE blocking lists the founder's own options; decided shows the owner's answer", () => {
    const [fresh, stale, answered] = ownerRequestLines(parseOwnerRequests({ requests: [req({ ageS: 7_200 }), req({ ageS: 5 * 86_400 }),
      req({ ageS: 3_600, status: "declined", response: "No Gumroad. Use a free route or pivot." })] })!);
    expect(fresh).toMatch(/^Owner request 62cbe1b7 \(sales_channel, blocks goal g1\) "Enable a Gumroad channel": pending for 2 h\.$/);
    expect(stale).toMatch(/pending for 5 d — STALE \(no owner answer after 24 h\)\. Waiting is one option, not the only one: you may pursue an alternative route, propose a safe experiment, gather more evidence, pivot, abandon the blocked path, or keep waiting/);
    expect(answered).toMatch(/: DECLINED by the owner, who wrote: "No Gumroad\. Use a free route or pivot\."\. This records the owner's answer only; it grants no capability, account, money or permission by itself\.$/);
    // Approved / answered are distinct words; none implies authority; a withdrawal is the founder's own act.
    const [approved, answer, withdrawn] = ownerRequestLines(parseOwnerRequests({ requests: [req({ ageS: 60, status: "approved" }), req({ ageS: 60, status: "answered", response: "Yes." }), req({ ageS: 60, status: "withdrawn" })] })!);
    expect(approved).toMatch(/: APPROVED by the owner \(no comment\)\. This records the owner's answer only; it grants no capability/);
    expect(answer).toMatch(/: ANSWERED by the owner, who wrote: "Yes\."\. This records the owner's answer only/);
    expect(withdrawn).toMatch(/: withdrawn by you\.$/);
  });

  it("a request turning stale yields one full packet, re-surfaces only at sparse milestones, and an owner answer yields one more", async () => {
    let ageS = 3_600;
    let status = "pending";
    let response: string | null = null;
    const r = rig({ caps: () => CAPS(), owner: () => ({ ok: true, staleAfterS: 86_400, requests: [req({ ageS, status, response })] }) });
    const [a, b] = await seq(r, 2);
    expect(a.slim).toBe(false);
    expect(b.slim).toBe(true);
    expect(b.body.task).toMatch(/pending for 60 min/); // visible on every wake, slim or not
    ageS = 7_200; // time alone, same bucket: still slim
    expect((await r.next()).slim).toBe(true);
    ageS = 86_400 + 60; // crosses the threshold
    const stale = await r.next();
    expect(stale.slim).toBe(false);
    expect(stale.body.task).toMatch(/STALE .* pursue an alternative route/);
    ageS = 1.5 * 86_400;
    const quiet = await r.next();
    expect(quiet.slim).toBe(true); // same milestone: no new full packet
    expect(quiet.body.task).toMatch(/STALE/); // but the stale line stays visible
    ageS = 2 * 86_400 + 60; // next milestone
    expect((await r.next()).slim).toBe(false);
    expect((await r.next()).slim).toBe(true);
    status = "answered"; response = "Listing is not possible this month; consider an experiment.";
    const answered = await r.next();
    expect(answered.slim).toBe(false);
    expect(answered.body.task).toMatch(/ANSWERED by the owner, who wrote: "Listing is not possible this month; consider an experiment\."/);
    expect((await r.next()).slim).toBe(true);
    // Bounded: from 2× to 400× the threshold there are at most 5 more milestones (4×, 8×, 16×, 32×, 64× cap).
    const buckets = new Set(Array.from({ length: 400 }, (_, d) => staleBucket(parseOwnerRequests({ requests: [req({ ageS: (d + 1) * 86_400 })] })![0])));
    expect([...buckets].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe("F1-LIVE-01 owner-request tools (founder toolbox)", () => {
  function box(ports: Record<string, unknown> = {}) {
    const root = tmp();
    fs.mkdirSync(path.join(root, "w"));
    fs.mkdirSync(path.join(root, "m"));
    return new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: path.join(root, "w"), memoryDir: path.join(root, "m"), ports: {
      ledger: async () => ({}), spendOrder: async () => ({}), proposeKnowledge: async () => ({}), knowledge: async () => [], requestIdentityFact: async () => ({}), ...ports,
    } as never });
  }

  it("request_owner_decision records a request through the controller — it grants nothing — and is validated", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const t = box({ ownerRequestCreate: async (r: Record<string, unknown>) => { sent.push(r); return { ok: true, request: { requestId: "x", status: "pending" } }; } });
    const ok = await t.execute({ id: "toolu_1", name: "request_owner_decision", arguments: { category: "sales_channel", title: "Enable a channel", detail: "Product built; need a listing route.", goalId: "g1", blocking: true } });
    expect(ok).toMatchObject({ ok: true });
    expect(sent).toEqual([{ idempotencyKey: "own:toolu_1", category: "sales_channel", goalRef: "g1", title: "Enable a channel", detail: "Product built; need a listing route.", blocking: true }]);
    await t.execute({ id: "toolu_2", name: "request_owner_decision", arguments: { category: "other", title: "t", detail: "d", goalId: "not-a-goal" } });
    expect(sent[1]).toMatchObject({ goalRef: null, blocking: false });
    expect(await t.execute({ id: "toolu_3", name: "request_owner_decision", arguments: { category: "other", title: "t" } })).toMatchObject({ ok: false, refused: "FLEET_BAD_REQUEST" });
    expect(await box().execute({ id: "toolu_4", name: "request_owner_decision", arguments: { category: "other", title: "t", detail: "d" } })).toMatchObject({ ok: false, refused: "FLEET_TOOL_NOT_AVAILABLE" });
    const w = box({ ownerRequestWithdraw: async (id: string) => ({ ok: true, request: { requestId: id, status: "withdrawn" } }) });
    expect(await w.execute({ id: "toolu_5", name: "withdraw_owner_request", arguments: { requestId: "62cbe1b7-0000-4000-8000-000000000001" } })).toMatchObject({ ok: true });
    expect(await w.execute({ id: "toolu_6", name: "withdraw_owner_request", arguments: { requestId: "../x" } })).toMatchObject({ ok: false, refused: "FLEET_BAD_REQUEST" });
    // A controller refusal (the client raises it) comes back as data with the controller's code — never a misleading message.
    const limited = box({ ownerRequestCreate: async () => { throw Object.assign(new Error("FLEET_LIMIT_REACHED"), { code: "FLEET_LIMIT_REACHED" }); } });
    const refused = await limited.execute({ id: "toolu_7", name: "request_owner_decision", arguments: { category: "other", title: "t", detail: "d" } });
    expect(refused).toMatchObject({ ok: false, refused: "FLEET_LIMIT_REACHED" });
    expect(refused.output).not.toMatch(/workspace/);
  });

  it("no new authority: both tools are 'planning' (already granted), the manifest digest is unchanged, and nothing in them executes a payment, account or approval", () => {
    for (const name of ["request_owner_decision", "withdraw_owner_request"]) {
      expect(decideTool(name, FOUNDER_MANIFEST_V2)).toMatchObject({ allowed: true, capability: "planning" });
      expect(FOUNDER_TOOLS.find((t) => t.name === name)).toMatchObject({ capability: "planning" });
    }
    expect(manifestSha256(FOUNDER_MANIFEST_V2)).toBe("30a7060986930db3f611545c8c57fa5a98c9ad798bac279f66c39bdfe527a3d8");
    expect(FOUNDER_TOOLS.find((t) => t.name === "request_owner_decision")!.description).toMatch(/grants nothing by itself/);
  });
});

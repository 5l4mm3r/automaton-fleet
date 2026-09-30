/**
 * R23 — routed founder runtime and tier/scope-aware cache policy (deterministic; fake provider paths only).
 *
 * Proves, without a real provider or a registry:
 *   - explicit task classification T0/T1/T2/T3 from the task alone;
 *   - the prompt-cache policy per tier and scope (T1 off, T2 prefix, T3 one-off question off, T3 step only on evidenced reuse);
 *   - the routed gateway applies it on the wire (cache_control present/absent), gives a question-scoped escalation no
 *     toolbox, advertises the cognition tools on ordinary routed steps only, and keeps provider-bound thinking with
 *     the model that produced it (a T1 chore or an escalation in between does not make the loop's thinking foreign);
 *   - the founder mind in routed mode: a compact task packet instead of a transcript, routine delegation to T1,
 *     one Critical Decision Packet to T3 and back down, consequential-action linkage, loop/duplicate guards, and
 *     thinking never crossing a tier; with routing inactive it runs the legacy turn unchanged.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { cachePolicy, inferRouted, type ProviderFactory, type RoutedCognitionPorts } from "../../fleet/cognition/routed-gateway.js";
import { TASK_CLASSES, route, type TierCandidate } from "../../fleet/cognition/router.js";
import { AnthropicProvider } from "../../fleet/cognition/anthropic.js";
import { startFakeAnthropic } from "../../fleet/cognition/fake-anthropic.js";
import { FOUNDER_ROUTED_TOOLS, FOUNDER_TOOLS, ROUTINE_TASK_CLASSES, type ToolCall } from "../../fleet/cognition/types.js";
import { TASK_PACKET_VERSION, buildDecisionPacket, buildTaskPacket, renderDecisionPacket, taskPacketProblems } from "../../fleet/cognition/task-packet.js";
import type { CognitionRecord } from "../../fleet/postgres/store.js";
import { FOUNDER_MANIFEST_V1, FOUNDER_MANIFEST_V2, MANIFESTS, decideTool, manifestSha256 } from "../../fleet/capabilities.js";
import { DETERMINISTIC_TOOLS, TaskClassificationError, classifyTask } from "../../fleet/founder/task-classifier.js";
import { FounderMind, renderBoundedPacket, type MindPorts } from "../../fleet/founder/mind.js";
import { FounderToolbox } from "../../fleet/founder/toolbox.js";
import { LoopGuard } from "../../fleet/founder/loop-guard.js";
import { priorDecision } from "../../fleet/founder/escalation.js";

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-5-5";
const OPUS = "claude-opus-5-5";
const verified = "2026-09-30T00:00:00Z";
const tiers = (over: Partial<Record<"T1" | "T2" | "T3", Partial<TierCandidate>>> = {}): TierCandidate[] => [
  { tier: "T1", provider: "anthropic", model: HAIKU, thinking: null, effort: null, maxOutputTokens: 2000, prices: { inputMicrocentsPerToken: 100, outputMicrocentsPerToken: 500, cacheWriteMicrocentsPerToken: 125, cacheReadMicrocentsPerToken: 10 }, enabled: true, verifiedAt: verified, promptCache: "off", ...over.T1 },
  { tier: "T2", provider: "anthropic", model: SONNET, thinking: "adaptive", effort: "medium", maxOutputTokens: 8000, prices: { inputMicrocentsPerToken: 200, outputMicrocentsPerToken: 1000, cacheWriteMicrocentsPerToken: 250, cacheReadMicrocentsPerToken: 20 }, enabled: true, verifiedAt: verified, promptCache: "prefix", ...over.T2 },
  { tier: "T3", provider: "anthropic", model: OPUS, thinking: "adaptive", effort: "medium", maxOutputTokens: 8000, prices: { inputMicrocentsPerToken: 400, outputMicrocentsPerToken: 2000, cacheWriteMicrocentsPerToken: 500, cacheReadMicrocentsPerToken: 20 }, enabled: true, verifiedAt: verified, promptCache: "prefix", ...over.T3 },
];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "f-r23-"));
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("R23 task classification (explicit, from the task only)", () => {
  it("tools are T0 software; a delegated chore is T1; an ordinary step is T2; a question or a consequential action is T3", () => {
    for (const tool of Object.keys(DETERMINISTIC_TOOLS)) {
      const c = classifyTask({ kind: "tool", tool });
      expect(c).toMatchObject({ tier: "T0", kind: "deterministic" });
      expect(c.route).toBeUndefined();
      // The router agrees: every deterministic class is T0 and never reaches a model.
      expect(route({ taskClass: c.taskClass })).toMatchObject({ tier: "T0", kind: "deterministic" });
    }
    expect(classifyTask({ kind: "tool", tool: "write_file" })).toMatchObject({ tier: "T0", kind: "deterministic" });
    for (const taskClass of ROUTINE_TASK_CLASSES) {
      const c = classifyTask({ kind: "routine", taskClass }, "turn-1");
      expect(c).toMatchObject({ tier: "T1", kind: "inference", route: { taskClass, taskId: "turn-1" } });
      expect(route(c.route!)).toMatchObject({ tier: "T1", scope: "task_step" });
    }
    const step = classifyTask({ kind: "step" }, "turn-1");
    expect(step).toMatchObject({ tier: "T2", route: { taskClass: "agent_step", taskId: "turn-1" } });
    expect(route(step.route!)).toMatchObject({ tier: "T2", source: "class_minimum", scope: "task_step" });
    const major = classifyTask({ kind: "step", actionClass: "major_spend_request" });
    expect(major.tier).toBe("T3");
    expect(route(major.route!)).toMatchObject({ tier: "T3", source: "action_boundary", scope: "task_step" });
    expect(classifyTask({ kind: "step", actionClass: "spend_request" }).tier).toBe("T2");
    const q = classifyTask({ kind: "question", reasonCode: "EVIDENCE_CONFLICT", parentRequestId: uuid(1) });
    expect(q.tier).toBe("T3");
    // Question-scoped: one call; effort high because the reason itself warrants deeper reasoning.
    expect(route(q.route!)).toMatchObject({ tier: "T3", source: "escalation", scope: "question", effort: "high", escalationReason: "EVIDENCE_CONFLICT" });
    expect(route(classifyTask({ kind: "question", reasonCode: "HIGH_CONSEQUENCE" }).route!)).toMatchObject({ tier: "T3", scope: "question", effort: null });
  });

  it("refuses what is not a task property: unknown classes, reasons, action classes and a parentless LOWER_TIER_INSUFFICIENT", () => {
    const code = (f: () => unknown) => { try { f(); return "OK"; } catch (e) { return e instanceof TaskClassificationError ? e.code : String(e); } };
    expect(code(() => classifyTask({ kind: "routine", taskClass: "agent_step" }))).toBe("FLEET_ROUTE_UNKNOWN_CLASS");
    expect(code(() => classifyTask({ kind: "routine", taskClass: "failure_diagnosis" }))).toBe("FLEET_ROUTE_UNKNOWN_CLASS");
    expect(code(() => classifyTask({ kind: "question", reasonCode: "I_AM_RICH" }))).toBe("FLEET_ROUTE_ESCALATION_REFUSED");
    expect(code(() => classifyTask({ kind: "question", reasonCode: "LOWER_TIER_INSUFFICIENT" }))).toBe("FLEET_ROUTE_ESCALATION_REFUSED");
    expect(code(() => classifyTask({ kind: "step", actionClass: "buy_yacht" }))).toBe("FLEET_ROUTE_INVALID");
    // The classifier's input has no commercial-history field at all; every routine class it offers is a router T1 class.
    for (const c of ROUTINE_TASK_CLASSES) expect(TASK_CLASSES[c].minTier).toBe("T1");
  });

  it("the cognition tools add no authority: same manifest digest, granted by the existing planning class, denied otherwise", () => {
    // The digests Founder 1's identity file and the registry bind are unchanged by R23 (no manifest change).
    expect(manifestSha256(FOUNDER_MANIFEST_V2)).toBe(manifestSha256(MANIFESTS["founder-v2"]));
    expect(FOUNDER_MANIFEST_V2.allowed).toEqual([...FOUNDER_MANIFEST_V1.allowed, "research.web"]);
    for (const t of FOUNDER_ROUTED_TOOLS) {
      expect(t.capability).toBe("planning");
      expect(decideTool(t.name, FOUNDER_MANIFEST_V2)).toMatchObject({ allowed: true, capability: "planning" });
      expect(decideTool(t.name, { manifestId: "x", version: 1, allowed: ["liveness"] })).toMatchObject({ allowed: false });
      expect(FOUNDER_TOOLS.some((x) => x.name === t.name)).toBe(false); // never advertised on the legacy path
    }
  });
});

describe("R23 prompt-cache policy (tier × scope × evidenced reuse)", () => {
  const [t1, t2, t3] = tiers();
  it("T1 off; T2 prefix; T3 question off; T3 step only when the same model served the previous call within the cache lifetime", () => {
    expect(cachePolicy({ tier: "T1", scope: "task_step" }, { ...t1, promptCache: "prefix" as never })).toMatchObject({ mode: "off" });
    expect(cachePolicy({ tier: "T2", scope: "task_step" }, t2)).toMatchObject({ mode: "prefix" });
    expect(cachePolicy({ tier: "T2", scope: "task_step" }, { ...t2, promptCache: "prefix+tail" })).toMatchObject({ mode: "prefix+tail" });
    expect(cachePolicy({ tier: "T2", scope: "task_step" }, { ...t2, promptCache: "off" })).toMatchObject({ mode: "off", reason: "tier policy off" });
    expect(cachePolicy({ tier: "T2", scope: "task_step" }, { model: SONNET })).toMatchObject({ mode: "off" }); // no policy recorded = off
    expect(cachePolicy({ tier: "T3", scope: "question" }, t3, { lastModel: OPUS, lastAgeS: 1 })).toMatchObject({ mode: "off", reason: expect.stringMatching(/one-off/) });
    expect(cachePolicy({ tier: "T3", scope: "task_step" }, t3)).toMatchObject({ mode: "off" });
    expect(cachePolicy({ tier: "T3", scope: "task_step" }, t3, { lastModel: SONNET, lastAgeS: 5 })).toMatchObject({ mode: "off" });
    expect(cachePolicy({ tier: "T3", scope: "task_step" }, t3, { lastModel: OPUS, lastAgeS: 301 })).toMatchObject({ mode: "off" });
    expect(cachePolicy({ tier: "T3", scope: "task_step" }, t3, { lastModel: OPUS, lastAgeS: 30 })).toMatchObject({ mode: "prefix" });
  });
});

/** In-memory ports that behave like the v23 registry for the gateway. */
function fakePorts(state: { tiers?: TierCandidate[]; lastModel?: string | null; conversationModel?: string | null; lastAgeS?: number | null } = {}) {
  const seen = { authorized: [] as Array<{ route: Record<string, unknown> }>, recorded: [] as Array<{ r: CognitionRecord; obs: Record<string, unknown> }> };
  let n = 0;
  const ports: RoutedCognitionPorts = {
    capabilities: async () => ({ ok: true, origin: "genesis_founder", allowed: FOUNDER_MANIFEST_V2.allowed as unknown as string[] }),
    cognitionStatus: async () => ({ ok: true, policyEnabled: true, provider: "anthropic", model: OPUS }),
    routingState: async () => ({ routingEnabled: true, tiers: state.tiers ?? tiers(), lastModel: state.lastModel ?? null, lastAgeS: state.lastAgeS ?? null,
      ...(state.conversationModel !== undefined ? { conversationModel: state.conversationModel } : {}) }),
    authorize: async (_a, _e, r) => { seen.authorized.push({ route: r }); return { ok: true, requestId: uuid(++n) }; },
    record: async (_a, _id, r, obs) => { seen.recorded.push({ r, obs }); return { ok: true, chargedCents: 0, chargedMicrocents: 0, usageSource: r.usageSource }; },
  };
  return { ports, seen };
}

async function withFake<T>(f: (factory: ProviderFactory, fake: Awaited<ReturnType<typeof startFakeAnthropic>>, modes: string[]) => Promise<T>, thinking = false) {
  const fake = await startFakeAnthropic({ apiKey: "k", model: OPUS, models: [HAIKU, SONNET], thinking, fault: () => null, cacheMinTokens: 256 });
  const base = new AnthropicProvider({ baseUrl: fake.url, apiKey: "k", model: OPUS, attemptTimeoutMs: 5000, maxAttempts: 1, backoffMs: 10 });
  const modes: string[] = [];
  const factory: ProviderFactory = (c, eff, promptCache) => {
    modes.push(`${c.tier}:${promptCache}`);
    const p = base.with({ model: c.model, thinking: c.thinking === "adaptive" ? { type: "adaptive" } : undefined, effort: eff ?? c.effort ?? undefined, promptCache });
    return Object.assign(p, { promptCache: p.settings.promptCache });
  };
  try {
    return await f(factory, fake, modes);
  } finally {
    await fake.close();
  }
}
const cached = (body: Record<string, unknown> | null) => Array.isArray(body?.system) && JSON.stringify(body!.system).includes("cache_control");
const toolNames = (body: Record<string, unknown> | null) => ((body?.tools as Array<{ name: string }> | undefined) ?? []).map((t) => t.name);
const obs = [{ role: "user", content: "Heartbeat 2. Decide your next step." }];
function decisionPacket(): string {
  const root = tmp();
  fs.mkdirSync(path.join(root, "m"));
  fs.mkdirSync(path.join(root, "w"));
  fs.writeFileSync(path.join(root, "m", "facts.json"), JSON.stringify({ "fees current": "transaction fee 9% (was 6.5%)" }));
  return renderDecisionPacket(buildDecisionPacket({ memoryDir: path.join(root, "m"), workspaceDir: path.join(root, "w"), question: "Is the fee change material to the £12 listing test?",
    escalationReason: "HIGH_CONSEQUENCE", hypothesis: "run it unchanged", state: "not started", economicConsequence: "£0.20, reversible", conflict: ["fee changed after the plan"] }));
}

describe("R23 routed gateway on the wire (real AnthropicProvider → fake Messages API)", () => {
  it("T1: no cache marker, compact charter, no tools; T2: cached prefix + toolbox + cognition tools; the policy is recorded with its reason", async () => {
    await withFake(async (factory, fake, modes) => {
      const { ports, seen } = fakePorts();
      const a = await inferRouted(ports, factory, "A", "t", { messages: obs, route: { taskClass: "extraction" } });
      expect(a.route).toMatchObject({ tier: "T1", model: HAIKU, promptCache: "off" });
      expect(cached(fake.lastBody)).toBe(false);
      expect(typeof fake.lastBody!.system).toBe("string");
      expect(toolNames(fake.lastBody)).toEqual([]);
      expect(a.usage.cacheWriteTokens ?? 0).toBe(0);

      const b = await inferRouted(ports, factory, "A", "t", { messages: obs });
      expect(b.route).toMatchObject({ tier: "T2", model: SONNET, promptCache: "prefix" });
      expect(cached(fake.lastBody)).toBe(true);
      expect(toolNames(fake.lastBody)).toEqual([...FOUNDER_TOOLS.map((t) => t.name), "routine_task", "escalate_question"]);
      expect(b.usage.cacheWriteTokens ?? 0).toBeGreaterThan(0);
      const c = await inferRouted(ports, factory, "A", "t", { messages: [{ role: "user", content: "Heartbeat 4: something else." }] });
      expect(c.usage.cacheReadTokens).toBe(b.usage.cacheWriteTokens); // the stable prefix is read back: reuse was expected
      expect(modes).toEqual(["T1:off", "T2:prefix", "T2:prefix"]);
      expect(seen.recorded.map((x) => [x.obs.promptCache, String(x.obs.cacheReason)])).toEqual([
        ["off", "T1 routine: compact, never padded"], ["prefix", "T2 stable prefix: reuse expected"], ["prefix", "T2 stable prefix: reuse expected"]]);
    });
  });

  it("a T3 question-scoped escalation pays no cache-write premium and gets no toolbox; a T3 task step caches only on evidenced reuse", async () => {
    await withFake(async (factory, fake, modes) => {
      const esc = { taskClass: "agent_step", escalation: { reasonCode: "HIGH_CONSEQUENCE", requestedTier: "T3" } };
      const q = await inferRouted(fakePorts({ lastModel: OPUS, lastAgeS: 2 }).ports, factory, "A", "t", { messages: [{ role: "user", content: decisionPacket() }], route: esc });
      expect(q.route).toMatchObject({ tier: "T3", model: OPUS, scope: "question", promptCache: "off" });
      expect(cached(fake.lastBody)).toBe(false);
      expect(toolNames(fake.lastBody)).toEqual([]); // it answers; the lower tier acts
      expect(q.usage.cacheWriteTokens ?? 0).toBe(0);
      // A T3 task step (action boundary) with no evidence of reuse: off. With the same model just used: the tier's policy.
      const cold = await inferRouted(fakePorts({ lastModel: SONNET, lastAgeS: 2 }).ports, factory, "A", "t", { messages: obs, route: { taskClass: "agent_step", actionClass: "major_spend_request" } });
      expect(cold.route).toMatchObject({ tier: "T3", scope: "task_step", source: "action_boundary", promptCache: "off" });
      expect(cached(fake.lastBody)).toBe(false);
      expect(toolNames(fake.lastBody)).toContain("request_spend");
      const warm = await inferRouted(fakePorts({ lastModel: OPUS, lastAgeS: 20 }).ports, factory, "A", "t", { messages: obs, route: { taskClass: "agent_step", actionClass: "major_spend_request" } });
      expect(warm.route.promptCache).toBe("prefix");
      expect(cached(fake.lastBody)).toBe(true);
      // The owner can switch a tier's cache off as policy data: then nothing is marked.
      const off = await inferRouted(fakePorts({ tiers: tiers({ T2: { promptCache: "off" } }) }).ports, factory, "A", "t", { messages: obs });
      expect(off.route.promptCache).toBe("off");
      expect(cached(fake.lastBody)).toBe(false);
      expect(modes).toEqual(["T3:off", "T3:off", "T3:prefix", "T2:off"]);
    });
  });

  it("a rendered task packet passes the gateway as an ordinary T2 step (its size is recorded); a packet carrying transcript or provider state is refused", async () => {
    await withFake(async (factory) => {
      const root = tmp();
      fs.mkdirSync(path.join(root, "m"));
      fs.mkdirSync(path.join(root, "w"));
      fs.writeFileSync(path.join(root, "m", "facts.json"), JSON.stringify({ "pricing plan": "List the £12 template." }));
      const p = buildTaskPacket({ memoryDir: path.join(root, "m"), workspaceDir: path.join(root, "w"), task: "Heartbeat 2. Decide your next step.", outputContract: { form: "analysis", mustCite: false, instructions: "act" } });
      const text = renderBoundedPacket(p);
      const { ports, seen } = fakePorts();
      const r = await inferRouted(ports, factory, "A", "t", { messages: [{ role: "user", content: text }], route: { taskClass: "agent_step", taskId: "turn-1" } });
      expect(r.route).toMatchObject({ tier: "T2", scope: "task_step" });
      expect(seen.recorded[0].obs.packetBytes).toBe(Buffer.byteLength(text));
      const head = text.split("\n").slice(0, 3).join("\n");
      const smuggled = `${head}\n${JSON.stringify({ ...JSON.parse(text.split("\n")[3]), messages: [{ role: "assistant", thinking: "x", signature: "s" }] })}`;
      await expect(inferRouted(ports, factory, "A", "t", { messages: [{ role: "user", content: smuggled }] })).rejects.toMatchObject({ code: "FLEET_TASK_PACKET_INVALID" });
      await expect(inferRouted(ports, factory, "A", "t", { messages: [{ role: "user", content: `${head}\nnot json` }] })).rejects.toMatchObject({ code: "FLEET_TASK_PACKET_INVALID" });
    });
  });

  it("the action class of a routed step is part of the route snapshot the registry records", async () => {
    await withFake(async (factory) => {
      const { ports, seen } = fakePorts();
      await inferRouted(ports, factory, "A", "t", { messages: obs, route: { taskClass: "agent_step", actionClass: "major_spend_request", taskId: "turn-9" } });
      expect(seen.authorized[0].route).toMatchObject({ tier: "T3", taskClass: "agent_step", actionClass: "major_spend_request", source: "action_boundary", scope: "task_step", taskId: "turn-9" });
    });
  });

  it("provider-bound thinking returns only to the model that produced it; a T1 chore or an escalation in between does not make it foreign", async () => {
    await withFake(async (factory, fake) => {
      const withThinking = [
        { role: "user", content: "Heartbeat 2." },
        { role: "assistant", content: "", toolCalls: [{ id: "toolu_1", name: "list_goals", arguments: {} }], thinking: [{ type: "thinking", thinking: "plan", signature: "sig-sonnet" }], blockOrder: ["thinking:0", "tool:toolu_1"] },
        { role: "tool", toolCallId: "toolu_1", content: "[]" },
      ];
      const hasSig = () => JSON.stringify(fake.lastBody).includes("sig-sonnet");
      // The founder's last call was a T1 chore (Haiku) or an escalation (Opus), but the loop's thinking is Sonnet's.
      await inferRouted(fakePorts({ lastModel: HAIKU, conversationModel: SONNET }).ports, factory, "A", "t", { messages: withThinking });
      expect(hasSig()).toBe(true);
      await inferRouted(fakePorts({ lastModel: OPUS, conversationModel: SONNET }).ports, factory, "A", "t", { messages: withThinking });
      expect(hasSig()).toBe(true);
      // The same history sent to another model (a T3 action step): the thinking never crosses.
      await inferRouted(fakePorts({ lastModel: SONNET, conversationModel: SONNET }).ports, factory, "A", "t", { messages: withThinking, route: { taskClass: "agent_step", actionClass: "major_spend_request" } });
      expect(hasSig()).toBe(false);
      // Thinking produced by Opus never reaches Sonnet.
      await inferRouted(fakePorts({ lastModel: OPUS, conversationModel: OPUS }).ports, factory, "A", "t", { messages: withThinking });
      expect(hasSig()).toBe(false);
      // A registry without the conversation-model field (older state shape) falls back to the last model.
      await inferRouted(fakePorts({ lastModel: OPUS }).ports, factory, "A", "t", { messages: withThinking });
      expect(hasSig()).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────── the founder mind in routed mode

type Reply = { content?: string; toolCalls?: ToolCall[]; thinking?: boolean; tier?: string; model?: string; scope?: string; fail?: string };
function mindRig(o: { routing?: boolean; replies: Array<Reply | ((call: { messages: Array<Record<string, unknown>>; route?: Record<string, unknown> }) => Reply)>; spend?: (r: Record<string, unknown>) => unknown; maxSteps?: number; facts?: Record<string, string> } ) {
  const root = tmp();
  const dirs = { w: path.join(root, "w"), m: path.join(root, "s", "memory"), s: path.join(root, "s") };
  for (const d of [dirs.w, dirs.s, dirs.m]) fs.mkdirSync(d, { recursive: true });
  if (o.facts) fs.writeFileSync(path.join(dirs.m, "facts.json"), JSON.stringify(o.facts));
  const calls: Array<{ messages: Array<Record<string, unknown>>; route?: Record<string, unknown> }> = [];
  const spends: Array<Record<string, unknown>> = [];
  let n = 0;
  const ports: MindPorts = {
    cognitionStatus: async () => ({ policyEnabled: true, provider: "anthropic", founderEnabled: true, paused: false, routing: { active: o.routing !== false } }),
    ledger: async () => ({ cash: 9_000, genesisAllocation: 10_000 }),
    infer: async (messages, _w, route) => {
      const call = { messages: JSON.parse(JSON.stringify(messages)) as Array<Record<string, unknown>>, route };
      calls.push(call);
      const next = o.replies[n++] ?? { content: "done", toolCalls: [{ id: `toolu_end${n}`, name: "sleep", arguments: { reason: "nothing more" } }] };
      const r = typeof next === "function" ? next(call) : next;
      if (r.fail) throw Object.assign(new Error(r.fail), { code: r.fail });
      const esc = (route as { escalation?: unknown } | undefined)?.escalation;
      const cls = String((route as { taskClass?: string } | undefined)?.taskClass ?? "");
      const tier = r.tier ?? (esc || (route as { actionClass?: string } | undefined)?.actionClass === "major_spend_request" ? "T3" : ROUTINE_TASK_CLASSES.includes(cls) ? "T1" : "T2");
      return {
        content: r.content ?? "", toolCalls: r.toolCalls ?? [], usage: { inputTokens: 10, outputTokens: 5 }, chargedCents: 1, requestId: uuid(n),
        ...(route ? { route: { tier, model: r.model ?? (tier === "T3" ? OPUS : tier === "T1" ? HAIKU : SONNET), taskClass: cls, scope: r.scope ?? (esc ? "question" : "task_step") } } : {}),
        ...(r.thinking ? { thinking: [{ type: "thinking" as const, thinking: "…", signature: `sig-${tier}-${n}` }], blockOrder: ["thinking:0", ...(r.toolCalls ?? []).map((t) => `tool:${t.id}`)] } : {}),
      };
    },
  };
  const loopGuard = new LoopGuard();
  const toolbox = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: dirs.w, memoryDir: dirs.m, loopGuard, ports: {
    ledger: async () => ({ cash: 9_000 }),
    spendOrder: async (r) => { spends.push(r as never); const v = o.spend?.(r as never); if (v instanceof Error) throw v; return v ?? { ok: true, order: { status: "reserved" } }; },
    proposeKnowledge: async () => ({}), knowledge: async () => [], requestIdentityFact: async () => ({}),
  } });
  const mind = new FounderMind({ ports, toolbox, stateDir: dirs.s, maxStepsPerTurn: o.maxSteps, routed: { memoryDir: dirs.m, workspaceDir: dirs.w, manifest: FOUNDER_MANIFEST_V2, loopGuard } });
  return { mind, calls, spends, dirs, loopGuard };
}
const call = (id: string, name: string, args: Record<string, unknown> = {}): ToolCall => ({ id, name, arguments: args });
const firstText = (c: { messages: Array<Record<string, unknown>> }) => String(c.messages[0].content);

describe("R23 founder mind: routed mode", () => {
  it("a turn starts from a compact provider-neutral task packet built from persistent state — never a replayed transcript", async () => {
    const rig = mindRig({ facts: { "pricing plan": "List the £12 template for 21 days." }, replies: [
      { content: "Checking goals.", toolCalls: [call("toolu_a", "set_goal", { title: "Validate the £12 template" })] },
      { content: "Goal set; resting.", toolCalls: [call("toolu_b", "sleep", { reason: "wait for views" })] },
    ] });
    fs.writeFileSync(path.join(rig.dirs.s, "mind-history.json"), JSON.stringify([{ role: "user", content: "OLD-LEGACY-TRANSCRIPT" }, { role: "assistant", content: "OLD-REPLY" }]));
    const t = await rig.mind.turn("Heartbeat 2. Decide your next step.");
    expect(t).toMatchObject({ ran: true, steps: 2, toolCalls: ["set_goal", "sleep"] });
    const c0 = rig.calls[0];
    expect(c0.messages).toHaveLength(1);
    expect(firstText(c0)).toMatch(/^TASK PACKET \(fleet-task-v1\)/);
    expect(firstText(c0)).not.toContain("OLD-LEGACY-TRANSCRIPT");
    const body = JSON.parse(firstText(c0).split("\n").slice(3).join("\n"));
    expect(body.packet).toBe(TASK_PACKET_VERSION);
    expect(taskPacketProblems(body)).toEqual([]);
    expect(body.task).toContain("Heartbeat 2");
    expect(body.knowledge).toEqual([{ key: "pricing plan", value: "List the £12 template for 21 days.", source: "facts.json" }]);
    expect(body.economics).toEqual({ cash: 9_000, genesisAllocation: 10_000 }); // T0: exact software output
    expect(firstText(c0).length).toBeLessThanOrEqual(15_000);
    expect(c0.route).toEqual({ taskClass: "agent_step", taskId: expect.stringMatching(/^turn-/) });
    // Inside the turn the conversation is append-only: step 2 = packet + assistant + tool result.
    expect(rig.calls[1].messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(rig.calls[1].messages[0]).toEqual(c0.messages[0]);
    // The legacy history is untouched; the next turn's packet carries the closing note and the new goal instead.
    expect(fs.readFileSync(path.join(rig.dirs.s, "mind-history.json"), "utf8")).toContain("OLD-LEGACY-TRANSCRIPT");
    await rig.mind.turn("Heartbeat 4.");
    await rig.mind.turn("Heartbeat 6."); // (the idle backoff skipped one slot)
    const next = rig.calls.at(-1)!;
    expect(next.messages).toHaveLength(1);
    const b2 = JSON.parse(firstText(next).split("\n").slice(3).join("\n"));
    expect(b2.task).toMatch(/Your previous turn .* ended with: .*sleep:/);
    expect(b2.objective.map((g: { title: string }) => g.title)).toEqual(["Validate the £12 template"]);
    expect(rig.mind.routing).toMatchObject({ steps: { T2: expect.any(Number), T3: 0 }, routineCalls: 0, escalations: 0 });
  });

  it("with routing inactive the same runtime runs the legacy turn: its history, no packet, no routing request", async () => {
    const rig = mindRig({ routing: false, replies: [{ content: "ok", toolCalls: [call("toolu_a", "sleep")] }] });
    fs.writeFileSync(path.join(rig.dirs.s, "mind-history.json"), JSON.stringify([{ role: "user", content: "earlier observation" }, { role: "assistant", content: "earlier reply" }]));
    await rig.mind.turn("Heartbeat 2.");
    expect(rig.calls[0].messages.map((m) => m.content)).toEqual(["earlier observation", "earlier reply", "Heartbeat 2."]);
    expect(rig.calls[0].route).toBeUndefined();
    expect(rig.mind.routing.routedTurns).toBe(0);
    expect(fs.existsSync(path.join(rig.dirs.s, "mind-continuity.json"))).toBe(false);
  });

  it("routine_task hands one bounded chore to T1 (inline material or a workspace file) and the step continues at T2", async () => {
    const rig = mindRig({ replies: [
      { content: "Triage the saved page.", toolCalls: [call("toolu_a", "routine_task", { taskClass: "page_interpretation", instructions: "List the prices as JSON.", path: "research/page.txt" })] },
      { content: "T1-RESULT: [12, 15]" },
      { content: "Noted.", toolCalls: [call("toolu_b", "routine_task", { taskClass: "classification", instructions: "spam or not?", material: "BUY NOW" }), call("toolu_c", "sleep")] },
      { content: "spam" },
    ] });
    fs.mkdirSync(path.join(rig.dirs.w, "research"));
    fs.writeFileSync(path.join(rig.dirs.w, "research", "page.txt"), "Template A £12. Template B £15.");
    const t = await rig.mind.turn("Heartbeat 2.");
    expect(t).toMatchObject({ steps: 2, toolCalls: ["routine_task", "routine_task", "sleep"], chargedCents: 4 });
    const [, chore] = rig.calls;
    expect(chore.route).toMatchObject({ taskClass: "page_interpretation" });
    expect(chore.messages).toHaveLength(1);
    expect(String(chore.messages[0].content)).toMatch(/^ROUTINE TASK \(page_interpretation\)\.\nInstructions: List the prices as JSON\.\n---BEGIN MATERIAL/);
    expect(String(chore.messages[0].content)).toContain("Template A £12");
    expect(String(chore.messages[0].content)).not.toContain("TASK PACKET"); // the chore never carries the founder's context
    // Control returns to T2 with only the result.
    expect(rig.calls[2].route).toMatchObject({ taskClass: "agent_step" });
    expect(String(rig.calls[2].messages.at(-1)!.content)).toContain("T1-RESULT: [12, 15]");
    expect(rig.calls[3].route).toMatchObject({ taskClass: "classification" });
    expect(rig.mind.routing).toMatchObject({ routineCalls: 2, steps: { T2: 2, T3: 0 } });
  });

  it("routine_task fails closed: unknown class, path escape, per-turn limit and an unavailable T1 are refused — never run at a higher tier", async () => {
    const chore = (id: string, args: Record<string, unknown>) => call(id, "routine_task", { instructions: "x", material: "y", ...args });
    const rig = mindRig({ maxSteps: 3, replies: [
      { toolCalls: [chore("toolu_1", { taskClass: "failure_diagnosis" }), chore("toolu_2", { taskClass: "extraction", path: "../../etc/passwd", material: undefined }), chore("toolu_3", { taskClass: "extraction" })] },
      { fail: "FLEET_COGNITION_TIER_UNAVAILABLE" },
      { toolCalls: [chore("toolu_4", { taskClass: "extraction" })] },
      { toolCalls: [call("toolu_5", "sleep")] },
    ] });
    const t = await rig.mind.turn("Heartbeat 2.");
    expect(t.refusals).toEqual([
      { tool: "routine_task", code: "FLEET_ROUTE_UNKNOWN_CLASS" }, { tool: "routine_task", code: "FLEET_PATH_OUTSIDE_WORKSPACE" }, { tool: "routine_task", code: "FLEET_COGNITION_TIER_UNAVAILABLE" },
      { tool: "routine_task", code: "FLEET_DUPLICATE_FAILED_ACTION" }, // the identical chore is not retried unchanged
    ]);
    // Exactly one T1 request was made (and refused by the controller); nothing was re-sent under another class.
    expect(rig.calls.map((c) => (c.route as { taskClass: string }).taskClass)).toEqual(["agent_step", "extraction", "agent_step", "agent_step"]);
    const limit = mindRig({ replies: [{ toolCalls: [1, 2, 3, 4, 5].map((i) => chore(`toolu_${i}`, { taskClass: "extraction", material: `m${i}` })) }, ...[1, 2, 3, 4, 5].map(() => ({ content: "r" })),
      { toolCalls: [6, 7].map((i) => chore(`toolu_${i}`, { taskClass: "extraction", material: `m${i}` })) }, { content: "r" }] });
    const t2 = await limit.mind.turn("Heartbeat 2.");
    expect(t2.refusals).toEqual([{ tool: "routine_task", code: "FLEET_ROUTINE_LIMIT" }]);
    expect(limit.mind.routing.routineCalls).toBe(6);
  });

  it("escalate_question sends ONE Critical Decision Packet to T3, persists the answer, and the next step returns to T2", async () => {
    const q = { question: "Is the fee rise material to the £12 listing test?", reasonCode: "EVIDENCE_CONFLICT", hypothesis: "Run it unchanged.", state: "validation not started", economicConsequence: "£0.20, reversible", conflict: ["6.5% vs 9%"] };
    const rig = mindRig({ facts: { "fees current": "transaction fee 9% (was 6.5%)", "unrelated note": "PRIVATE-UNRELATED" }, replies: [
      { content: "Conflicting fee evidence.", thinking: true, toolCalls: [call("toolu_a", "escalate_question", q)] },
      { content: "Decision: still run it; net £10.24 per sale.", thinking: true },
      { content: "Proceeding on the decision.", toolCalls: [call("toolu_b", "escalate_question", q), call("toolu_c", "sleep", { reason: "listed" })] },
    ] });
    const t = await rig.mind.turn("Heartbeat 2.");
    expect(t).toMatchObject({ steps: 2, toolCalls: ["escalate_question", "escalate_question", "sleep"], refusals: [] });
    const [step1, esc, step2] = rig.calls;
    expect(step1.route).toEqual({ taskClass: "agent_step", taskId: expect.any(String) });
    // The escalation: a fresh single-message conversation — a decision packet, a structured request, no transcript, no thinking.
    expect(esc.messages).toHaveLength(1);
    expect(String(esc.messages[0].content)).toMatch(/^CRITICAL DECISION PACKET \(fleet-decision-v1\)/);
    expect(JSON.stringify(esc.messages)).not.toMatch(/sig-|TASK PACKET|Conflicting fee evidence|PRIVATE-UNRELATED/);
    expect(esc.route).toEqual({ taskClass: "agent_step", taskId: expect.any(String), escalation: { reasonCode: "EVIDENCE_CONFLICT", requestedTier: "T3", parentRequestId: uuid(1) } });
    expect(route(esc.route as never)).toMatchObject({ tier: "T3", scope: "question" });
    // Back down: the next step is an ordinary T2 step again, carrying only the observable answer.
    expect(step2.route).toEqual({ taskClass: "agent_step", taskId: expect.any(String) });
    expect(String(step2.messages.at(-1)!.content)).toContain("CRITICAL-TIER ANSWER");
    expect(String(step2.messages.at(-1)!.content)).toContain("Decision: still run it");
    expect(JSON.stringify(step2.messages)).not.toContain("sig-T3"); // Opus's thinking never reaches the T2 conversation
    expect(JSON.stringify(step2.messages)).toContain("sig-T2-1"); // the loop's own T2 thinking is still its own
    // The answer is persistent, observable state.
    const facts = JSON.parse(fs.readFileSync(path.join(rig.dirs.m, "facts.json"), "utf8"));
    const key = Object.keys(facts).find((k) => k.startsWith("decision:"))!;
    expect(JSON.parse(facts[key])).toMatchObject({ reason: "EVIDENCE_CONFLICT", answer: "Decision: still run it; net £10.24 per sale.", tier: "T3", model: OPUS });
    // Duplicate guard: asking the same question again is answered from the record — no second T3 call.
    expect(rig.calls).toHaveLength(3);
    expect(rig.mind.routing).toMatchObject({ escalations: 1, escalationsReused: 1, steps: { T2: 2, T3: 0 } });
    expect(priorDecision(rig.dirs.m, "  is the FEE rise material to the £12 listing test? ")).toMatchObject({ factKey: key });
    expect(priorDecision(rig.dirs.m, q.question, 1_000, () => Date.now() + 60_000)).toBeNull(); // stale decisions are asked again
  });

  it("escalation guards: unknown reason codes and a second question in one turn are refused before any call", async () => {
    const rig = mindRig({ replies: [
      { toolCalls: [call("toolu_a", "escalate_question", { question: "q1?", reasonCode: "MORE_TOKENS_PLEASE", hypothesis: "h" }),
        call("toolu_b", "escalate_question", { question: "q1?", reasonCode: "NOVEL_UNCERTAINTY", hypothesis: "h" }),
        call("toolu_c", "escalate_question", { question: "q2?", reasonCode: "NOVEL_UNCERTAINTY", hypothesis: "h" })] },
      { content: "answer 1" },
      { toolCalls: [call("toolu_d", "sleep")] },
    ] });
    const t = await rig.mind.turn("Heartbeat 2.");
    expect(t.refusals).toEqual([{ tool: "escalate_question", code: "FLEET_ROUTE_ESCALATION_REFUSED" }, { tool: "escalate_question", code: "FLEET_ESCALATION_LIMIT" }]);
    expect(rig.calls.filter((c) => (c.route as { escalation?: unknown }).escalation)).toHaveLength(1);
  });

  it("consequential-action linkage: a spend refused for its cognition tier makes exactly the next step run at T3, then control returns to T2; thinking never crosses", async () => {
    const spend = { amountCents: 5_000, category: "expense", destinationId: "dst_01ZZZZZZZZZZZZZZZZZZZZZZZZ", purpose: "stock" };
    let attempt = 0;
    const rig = mindRig({
      spend: () => (++attempt === 1 ? Object.assign(new Error("tier"), { code: "FLEET_ACTION_COGNITION_TIER" }) : { ok: true, order: { status: "awaiting_owner" } }),
      replies: [
        { content: "Buy stock.", thinking: true, toolCalls: [call("toolu_s1", "request_spend", spend)] },
        { content: "Still justified at the critical tier.", thinking: true, toolCalls: [call("toolu_s2", "request_spend", spend)] },
        { content: "Order placed.", toolCalls: [call("toolu_z", "sleep")] },
      ],
    });
    const t = await rig.mind.turn("Heartbeat 2.");
    expect(t).toMatchObject({ steps: 3, toolCalls: ["request_spend", "request_spend", "sleep"], refusals: [{ tool: "request_spend", code: "FLEET_ACTION_COGNITION_TIER" }] });
    const [s1, s2, s3] = rig.calls;
    expect(s1.route).toEqual({ taskClass: "agent_step", taskId: expect.any(String) });
    // Exactly the next step asks for the action's minimum tier…
    expect(s2.route).toEqual({ taskClass: "agent_step", taskId: expect.any(String), actionClass: "major_spend_request" });
    expect(route(s2.route as never)).toMatchObject({ tier: "T3", source: "action_boundary" });
    expect(JSON.stringify(s2.messages)).not.toContain("sig-T2"); // Sonnet's thinking is dropped before the T3 step
    expect(String(s2.messages.at(-1)!.content)).toMatch(/must be decided at the critical tier/);
    // …the identical spend call is allowed again there (the loop guard saw the tier change)…
    expect(rig.spends).toHaveLength(2);
    // …each attempt is linked to the cognition call that produced it by its own tool-call id…
    expect(rig.spends.map((x) => String(x.idempotencyKey).split(":")[1])).toEqual(["toolu_s1", "toolu_s2"]);
    // …and control returns to T2, without Opus's thinking.
    expect(s3.route).toEqual({ taskClass: "agent_step", taskId: expect.any(String) });
    expect(JSON.stringify(s3.messages)).not.toMatch(/sig-T3|sig-T2/);
    expect(rig.mind.routing).toMatchObject({ actionBoundarySteps: 1, steps: { T2: 2, T3: 1 } });
    expect(rig.mind.routing.thinkingDropped).toBeGreaterThanOrEqual(2);
  });

  it("loop and budget guards: identical failed calls are not re-run, and a turn that outgrows its context budget ends instead of editing its history", async () => {
    const rig = mindRig({ maxSteps: 4, replies: [
      { toolCalls: [call("toolu_1", "read_file", { path: "missing.txt" })] },
      { toolCalls: [call("toolu_2", "read_file", { path: "missing.txt" })] }, // one bounded retry of a possibly transient error
      { toolCalls: [call("toolu_3", "read_file", { path: "missing.txt" })] },
      { toolCalls: [call("toolu_4", "sleep")] },
    ] });
    const t = await rig.mind.turn("Heartbeat 2.");
    expect(t.refusals.map((r) => r.code)).toEqual(["FLEET_TOOL_ERROR", "FLEET_TOOL_ERROR", "FLEET_DUPLICATE_FAILED_ACTION"]);
    expect(rig.loopGuard.stats.duplicateFailuresBlocked).toBe(1);
    // Budget: every step returns 5 large tool results; the turn stops rather than trimming earlier messages.
    const big = "x".repeat(3_000);
    const many = (p: string) => [1, 2, 3, 4, 5].map((i) => call(`toolu_${p}${i}`, "write_file", { path: `n${p}${i}.txt`, content: big }));
    const fat = mindRig({ maxSteps: 12, facts: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`fact ${i}`, "y".repeat(180)])),
      replies: Array.from({ length: 12 }, (_, i) => ({ content: big, toolCalls: many(String.fromCharCode(97 + i)) })) });
    const t3 = await fat.mind.turn("Heartbeat 2.");
    expect(t3.steps).toBeLessThan(12);
    expect(fat.mind.routing.budgetStops).toBe(1);
    for (const [i, c] of fat.calls.entries()) {
      expect(c.messages[0]).toEqual(fat.calls[0].messages[0]); // the packet is never dropped or rewritten
      if (i > 0) expect(c.messages.slice(0, fat.calls[i - 1].messages.length).map((m) => [m.role, m.content])).toEqual(fat.calls[i - 1].messages.map((m) => [m.role, m.content])); // append-only
    }
  });

  it("an oversized persistent state still yields a packet that fits one controller message (lowest-value sections trimmed, never the task)", () => {
    const root = tmp();
    const m = path.join(root, "m");
    const w = path.join(root, "w");
    fs.mkdirSync(m);
    fs.mkdirSync(w);
    fs.writeFileSync(path.join(m, "facts.json"), JSON.stringify(Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`fact ${String(i).padStart(2, "0")}`, "z".repeat(900)]))));
    for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(w, `note${i}.md`), "n".repeat(4_000));
    const text = renderBoundedPacket(buildTaskPacket({ memoryDir: m, workspaceDir: w, task: "THE-TASK-MARKER: decide the next step", outputContract: { form: "analysis", mustCite: false, instructions: "act" } }));
    expect(text.length).toBeLessThanOrEqual(15_000);
    expect(text).toContain("THE-TASK-MARKER");
  });
});

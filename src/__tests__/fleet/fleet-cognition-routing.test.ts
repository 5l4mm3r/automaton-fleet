/**
 * Neutral cognition routing (schema v22 phase) — deterministic and fake-provider validation.
 * Task-based routing only; escalate the question, not the job; the consequential-action digest; prompt caching;
 * provider-bound thinking; loop/duplication guards; exact usage attribution. The database side (breakers, snapshot
 * prices, action boundary, grants, inertness) is covered by fleet-cognition-routing-pg.test.ts.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { ACTION_MIN_TIER, RouteError, TASK_CLASSES, actionDigest, candidateFor, parseRouteRequest, route, type TierCandidate } from "../../fleet/cognition/router.js";
import { FOUNDER_EXPERIMENT_TOOLS } from "../../fleet/cognition/types.js";
import { inferRouted, type ProviderFactory, type RoutedCognitionPorts } from "../../fleet/cognition/routed-gateway.js";
import { buildDecisionPacket, renderDecisionPacket, taskPacketProblems, DECISION_LIMITS } from "../../fleet/cognition/task-packet.js";
import { AnthropicProvider } from "../../fleet/cognition/anthropic.js";
import { startFakeAnthropic } from "../../fleet/cognition/fake-anthropic.js";
import { cacheEconomics, costMicrocents } from "../../fleet/cognition/charging.js";
import { CognitionError } from "../../fleet/cognition/gateway.js";
import type { ChatRequest, ChatResult, CognitionProvider } from "../../fleet/cognition/types.js";
import type { CognitionRecord } from "../../fleet/postgres/store.js";
import { LoopGuard } from "../../fleet/founder/loop-guard.js";
import { FounderToolbox } from "../../fleet/founder/toolbox.js";
import { FounderMind } from "../../fleet/founder/mind.js";
import { escalateQuestion } from "../../fleet/founder/escalation.js";
import { FOUNDER_MANIFEST_V2 } from "../../fleet/capabilities.js";

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-5-5";
const OPUS = "claude-opus-5-5";
const verified = "2026-09-30T00:00:00Z";
const TIERS: TierCandidate[] = [
  { tier: "T1", provider: "anthropic", model: HAIKU, thinking: null, effort: null, maxOutputTokens: 2000, prices: { inputMicrocentsPerToken: 100, outputMicrocentsPerToken: 500, cacheWriteMicrocentsPerToken: 125, cacheReadMicrocentsPerToken: 10 }, enabled: true, verifiedAt: verified },
  { tier: "T2", provider: "anthropic", model: SONNET, thinking: "adaptive", effort: "medium", maxOutputTokens: 8000, prices: { inputMicrocentsPerToken: 200, outputMicrocentsPerToken: 1000, cacheWriteMicrocentsPerToken: 250, cacheReadMicrocentsPerToken: 20 }, enabled: true, verifiedAt: verified, promptCache: "prefix" },
  { tier: "T3", provider: "anthropic", model: OPUS, thinking: "adaptive", effort: "medium", maxOutputTokens: 8000, prices: { inputMicrocentsPerToken: 400, outputMicrocentsPerToken: 2000, cacheWriteMicrocentsPerToken: 500, cacheReadMicrocentsPerToken: 20 }, enabled: true, verifiedAt: verified, promptCache: "prefix" },
];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "f-routing-"));

describe("router: tier from the task only", () => {
  it("T0 classes are deterministic (never a model); T1/T2/T3 classes route to their minimum", () => {
    for (const c of ["ledger_calculation", "fx_application", "hashing", "policy_check", "exact_dedupe", "health_check"]) expect(route({ taskClass: c })).toMatchObject({ kind: "deterministic", tier: "T0" });
    expect(route({ taskClass: "extraction" })).toMatchObject({ kind: "inference", tier: "T1", scope: "task_step" });
    expect(route({ taskClass: "agent_step" })).toMatchObject({ tier: "T2" });
    expect(route({ taskClass: "validation_design" })).toMatchObject({ tier: "T2" });
    expect(route({ taskClass: "evidence_conflict_resolution" })).toMatchObject({ tier: "T3", effort: "high" });
    expect(route({ taskClass: "major_capital_proposal" })).toMatchObject({ tier: "T3", effort: null }); // medium unless the task warrants more
    expect(() => route({ taskClass: "hashing", escalation: { reasonCode: "HIGH_CONSEQUENCE", requestedTier: "T3" } })).toThrow(/deterministic/);
    // Every class has a coherent range.
    for (const [c, s] of Object.entries(TASK_CLASSES)) expect([c, ["T0", "T1", "T2", "T3"].indexOf(s.minTier) <= ["T0", "T1", "T2", "T3"].indexOf(s.maxTier)]).toEqual([c, true]);
  });

  it("commercial history cannot reach the router: history fields are refused, and identical tasks route identically", () => {
    for (const k of ["wealth", "cashPence", "recentProfit", "recentLoss", "opportunityCount", "failedOpportunities", "winRate", "successHistory"]) {
      expect(() => parseRouteRequest({ taskClass: "agent_step", [k]: 3 })).toThrow(RouteError);
      expect(() => parseRouteRequest({ taskClass: "agent_step", escalation: { reasonCode: "HIGH_CONSEQUENCE", requestedTier: "T3", [k]: 1 } })).toThrow(RouteError);
    }
    const task = { taskClass: "opportunity_research", taskId: "opp-3" };
    // A founder that failed twice and one that succeeded send the same task: the decision is the same object.
    expect(route(parseRouteRequest({ ...task }))).toEqual(route(parseRouteRequest({ ...task })));
    expect(route(parseRouteRequest(task)).tier).toBe("T2");
  });

  it("escalation: closed reason codes, capped at the class maximum, question-scoped; the action boundary forces minimums", () => {
    expect(() => parseRouteRequest({ taskClass: "agent_step", escalation: { reasonCode: "MORE_TOKENS_WOULD_BE_NICE", requestedTier: "T3" } })).toThrow(/reason code/);
    expect(() => route({ taskClass: "agent_step", escalation: { reasonCode: "LOWER_TIER_INSUFFICIENT", requestedTier: "T3" } })).toThrow(/parent/);
    const e = route({ taskClass: "agent_step", escalation: { reasonCode: "EVIDENCE_CONFLICT", requestedTier: "T3" } });
    expect(e).toMatchObject({ tier: "T3", scope: "question", source: "escalation", effort: "high", escalationReason: "EVIDENCE_CONFLICT" });
    expect(route({ taskClass: "agent_step", escalation: { reasonCode: "HIGH_CONSEQUENCE", requestedTier: "T3" } })).toMatchObject({ tier: "T3", effort: null });
    // A routine class cannot self-escalate to T3 (class maximum T2).
    expect(route({ taskClass: "extraction", escalation: { reasonCode: "HIGH_CONSEQUENCE", requestedTier: "T3" } })).toMatchObject({ tier: "T2" });
    // Mislabelling a major capital action as routine does not lower it: the router forces the action minimum.
    expect(route({ taskClass: "formatting", actionClass: "major_spend_request" })).toMatchObject({ tier: "T3", source: "action_boundary" });
    expect(ACTION_MIN_TIER.major_spend_request).toBe("T3");
  });

  it("candidates: only enabled + verified mappings serve a tier; never a lower tier", () => {
    expect(candidateFor("T2", TIERS).model).toBe(SONNET);
    expect(() => candidateFor("T3", TIERS.map((t) => (t.tier === "T3" ? { ...t, enabled: false } : t)))).toThrow(/not enabled/);
    expect(() => candidateFor("T3", TIERS.map((t) => (t.tier === "T3" ? { ...t, verifiedAt: null } : t)))).toThrow(/not been verified/);
    expect(() => candidateFor("T0", TIERS)).toThrow(/deterministic/);
  });

  it("the action digest is canonical: the controller recomputes it from the spend request", () => {
    const a = actionDigest("request_spend", { amountCents: 1500, category: "expense", destinationId: "dst_01ABCDEFGHJKMNPQRSTVWXYZ01", purpose: "x" });
    expect(a).toBe(actionDigest("request_spend", { destinationId: "dst_01ABCDEFGHJKMNPQRSTVWXYZ01", category: "expense", amountCents: 1500 }));
    expect(a).not.toBe(actionDigest("request_spend", { amountCents: 1501, category: "expense", destinationId: "dst_01ABCDEFGHJKMNPQRSTVWXYZ01" }));
    expect(actionDigest("list_goals", {})).toBeNull();
  });
});

describe("Critical Decision Packet: the question, not the job", () => {
  function state() {
    const root = tmp();
    const mem = path.join(root, "memory");
    const ws = path.join(root, "workspace");
    fs.mkdirSync(mem);
    fs.mkdirSync(path.join(ws, "research"), { recursive: true });
    const facts: Record<string, string> = { "fees current": "Stallhub transaction fee 9% from 1 Oct (attemptId aaaaaaaa-0000-4000-8000-000000000001)", "O2 uncertainty": "conversion unverified" };
    for (let i = 0; i < 40; i++) facts[`unrelated ${i}`] = `wedding planner trivia ${i} ${"x".repeat(200)}`;
    fs.writeFileSync(path.join(mem, "facts.json"), JSON.stringify(facts));
    fs.writeFileSync(path.join(root, "mind-history.json"), JSON.stringify([{ role: "assistant", content: "TRANSCRIPT-ONLY", thinking: [{ type: "thinking", thinking: "PRIVATE", signature: "SIGNATURE-X" }] }]));
    return { mem, ws };
  }
  it("carries only relevant persistent state, is bounded, and holds no transcript, thinking or signature", () => {
    const d = state();
    const p = buildDecisionPacket({ memoryDir: d.mem, workspaceDir: d.ws, question: "Does the 9% transaction fee change whether the listing test is worth running?",
      escalationReason: "EVIDENCE_CONFLICT", hypothesis: "Run the £12 listing test", state: "goal g1 open", economicConsequence: "£0.20 listing fee; reversible", conflict: ["fee rose from 6.5% to 9%"] });
    const text = renderDecisionPacket(p);
    expect(p.knowledge.map((k) => k.key)).toContain("fees current");
    expect(p.knowledge.some((k) => k.key.startsWith("unrelated"))).toBe(false);
    expect(Buffer.byteLength(text)).toBeLessThan(DECISION_LIMITS.totalBytes + 800);
    for (const bad of ["TRANSCRIPT-ONLY", "PRIVATE", "SIGNATURE-X"]) expect(text).not.toContain(bad);
    expect(taskPacketProblems({ ...p, extra: { thinking: "x" } }).join()).toMatch(/forbidden key/);
    expect(taskPacketProblems({ ...p, escalationReason: "MORE_TOKENS" }).join()).toMatch(/escalation reason/);
  });
});

/** In-memory ports that behave like the database for the gateway (authorization snapshot, exact record). */
function fakePorts(o: { lastModel?: string | null; lastAgeS?: number | null; authorize?: (route: Record<string, unknown>) => Record<string, unknown> & { ok: boolean }; status?: Record<string, unknown>; experimentsEnabled?: boolean } = {}) {
  const seen = { authorized: [] as Array<{ estimate: number; route: Record<string, unknown>; promptSha: string }>, recorded: [] as Array<{ r: CognitionRecord; obs: Record<string, unknown> }> };
  let n = 0;
  const ports: RoutedCognitionPorts = {
    capabilities: async () => ({ ok: true, origin: "genesis_founder", allowed: FOUNDER_MANIFEST_V2.allowed as unknown as string[], ...(o.experimentsEnabled === undefined ? {} : { experimentsEnabled: o.experimentsEnabled }) }),
    cognitionStatus: async () => ({ ok: true, policyEnabled: true, provider: "anthropic", model: OPUS, ...(o.status ?? {}) }),
    routingState: async () => ({ routingEnabled: true, tiers: TIERS, lastModel: o.lastModel ?? null, lastAgeS: o.lastAgeS ?? null }),
    authorize: async (_a, estimate, route, promptSha) => {
      seen.authorized.push({ estimate, route, promptSha });
      return o.authorize?.(route) ?? { ok: true, requestId: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` };
    },
    record: async (_a, _id, r, obs) => {
      seen.recorded.push({ r, obs });
      return { ok: true, chargedCents: 0, chargedMicrocents: 0, usageSource: r.usageSource };
    },
  };
  return { ports, seen };
}

describe("routed gateway (real AnthropicProvider → fake Messages API)", () => {
  async function withFake<T>(f: (factory: ProviderFactory, fake: Awaited<ReturnType<typeof startFakeAnthropic>>) => Promise<T>, cacheMinTokens = 256) {
    const fake = await startFakeAnthropic({ apiKey: "k", model: OPUS, models: [HAIKU, SONNET], thinking: false, fault: () => null, cacheMinTokens });
    // v23: the gateway decides the cache mode per call (tier policy × scope × evidenced reuse) and hands it to the factory.
    const base = new AnthropicProvider({ baseUrl: fake.url, apiKey: "k", model: OPUS, attemptTimeoutMs: 5000, maxAttempts: 1, backoffMs: 10 });
    const factory: ProviderFactory = (c, eff, promptCache) => {
      const p = base.with({ model: c.model, thinking: c.thinking === "adaptive" ? { type: "adaptive" } : undefined, effort: eff ?? c.effort ?? undefined, promptCache });
      return Object.assign(p, { promptCache: p.settings.promptCache });
    };
    try {
      return await f(factory, fake);
    } finally {
      await fake.close();
    }
  }
  const obs = [{ role: "user", content: "Heartbeat 2. Decide your next step." }];

  it("R24: the experiment tools reach the model only while the owner has the pipeline on (routed path, as Founder 1 runs)", async () => {
    await withFake(async (factory, fake) => {
      const names = () => ((fake.lastBody as { tools?: Array<{ name: string }> }).tools ?? []).map((t) => t.name);
      const experimentTools = FOUNDER_EXPERIMENT_TOOLS.map((t) => t.name);
      for (const flag of [undefined, false] as const) {
        await inferRouted(fakePorts({ experimentsEnabled: flag }).ports, factory, "A", "t", { messages: obs });
        expect(names().length).toBeGreaterThan(0);
        expect(names().filter((n) => experimentTools.includes(n))).toEqual([]);
      }
      await inferRouted(fakePorts({ experimentsEnabled: true }).ports, factory, "A", "t", { messages: obs });
      expect(names()).toEqual(expect.arrayContaining(experimentTools));
    });
  });

  it("T0 bypasses inference entirely: no authorization, no provider call", async () => {
    await withFake(async (factory, fake) => {
      const { ports, seen } = fakePorts();
      await expect(inferRouted(ports, factory, "A", "t", { messages: obs, route: { taskClass: "ledger_calculation" } })).rejects.toMatchObject({ code: "FLEET_ROUTE_DETERMINISTIC", status: 422 });
      expect(seen.authorized).toEqual([]);
      expect(fake.requests.size).toBe(0);
    });
  });

  it("T1 routine → Haiku (no thinking/effort sent); T2 default → Sonnet medium; T3 → Opus; exact usage attribution", async () => {
    await withFake(async (factory, fake) => {
      const { ports, seen } = fakePorts();
      const t1 = await inferRouted(ports, factory, "A", "t", { messages: obs, route: { taskClass: "extraction" } });
      expect(t1.route).toMatchObject({ tier: "T1", model: HAIKU });
      expect(fake.lastBody).toMatchObject({ model: HAIKU });
      expect(fake.lastBody).not.toHaveProperty("thinking");
      expect(fake.lastBody).not.toHaveProperty("output_config");
      const t2 = await inferRouted(ports, factory, "A", "t", { messages: obs }); // no route: agent_step
      expect(t2.route).toMatchObject({ tier: "T2", model: SONNET, taskClass: "agent_step" });
      expect(fake.lastBody).toMatchObject({ model: SONNET, thinking: { type: "adaptive" }, output_config: { effort: "medium" } });
      const t3 = await inferRouted(ports, factory, "A", "t", { messages: obs, route: { taskClass: "failure_diagnosis" } });
      expect(t3.route).toMatchObject({ tier: "T3", model: OPUS });
      expect(fake.lastBody).toMatchObject({ model: OPUS, output_config: { effort: "high" } });
      // Authorization carried the candidate snapshot; the record carried the provider's exact usage.
      expect(seen.authorized.map((x) => [x.route.tier, x.route.model])).toEqual([["T1", HAIKU], ["T2", SONNET], ["T3", OPUS]]);
      expect(seen.recorded[1].r).toMatchObject({ outcome: "ok", inputTokens: t2.usage.inputTokens, outputTokens: t2.usage.outputTokens, usageSource: "provider" });
    });
  });

  it("escalation needs a decision packet (never a transcript); control returns downward afterwards", async () => {
    await withFake(async (factory, fake) => {
      const { ports, seen } = fakePorts();
      const transcript = [...obs, { role: "assistant", content: "earlier" }, { role: "user", content: "and now?" }];
      const esc = { taskClass: "agent_step", escalation: { reasonCode: "EVIDENCE_CONFLICT", requestedTier: "T3" } };
      await expect(inferRouted(ports, factory, "A", "t", { messages: transcript, route: esc })).rejects.toMatchObject({ code: "FLEET_ESCALATION_REQUIRES_PACKET" });
      await expect(inferRouted(ports, factory, "A", "t", { messages: obs, route: esc })).rejects.toMatchObject({ code: "FLEET_ESCALATION_REQUIRES_PACKET" });
      const root = tmp();
      fs.mkdirSync(path.join(root, "m"));
      fs.mkdirSync(path.join(root, "w"));
      fs.writeFileSync(path.join(root, "m", "facts.json"), JSON.stringify({ "fees current": "transaction fee 9%" }));
      const packet = renderDecisionPacket(buildDecisionPacket({ memoryDir: path.join(root, "m"), workspaceDir: path.join(root, "w"), question: "Is the transaction fee change material?",
        escalationReason: "EVIDENCE_CONFLICT", hypothesis: "list at £12", state: "g1", economicConsequence: "£0.20", conflict: ["fee changed"] }));
      const up = await inferRouted(ports, factory, "A", "t", { messages: [{ role: "user", content: packet }], route: esc });
      expect(up.route).toMatchObject({ tier: "T3", model: OPUS, scope: "question" });
      expect((fake.lastBody!.messages as unknown[]).length).toBe(1);
      expect(seen.recorded.at(-1)!.obs.packetBytes).toBe(Buffer.byteLength(packet));
      // The next ordinary step is routed by its own class again: one T3 decision does not convert the task.
      const down = await inferRouted(ports, factory, "A", "t", { messages: obs, route: { taskClass: "agent_step" } });
      expect(down.route).toMatchObject({ tier: "T2", model: SONNET, scope: "task_step" });
      // A decision packet without an escalation is refused (no quiet T3-shaped calls at T2).
      await expect(inferRouted(ports, factory, "A", "t", { messages: [{ role: "user", content: packet }], route: { taskClass: "agent_step" } })).rejects.toMatchObject({ code: "FLEET_ROUTE_INVALID" });
    });
  });

  it("prompt caching: tools + charter are one cached prefix — written once, then read; the tail stays uncached", async () => {
    await withFake(async (factory) => {
      // R23.1: the prefix is cached when reuse is evidenced (here: the same model served this founder moments ago).
      const { ports, seen } = fakePorts({ lastModel: SONNET, lastAgeS: 10 });
      const a = await inferRouted(ports, factory, "A", "t", { messages: obs });
      const b = await inferRouted(ports, factory, "A", "t", { messages: [{ role: "user", content: "Heartbeat 4, something new." }] });
      expect(a.usage.cacheWriteTokens ?? 0).toBeGreaterThan(0);
      expect(a.usage.cacheReadTokens ?? 0).toBe(0);
      expect(b.usage.cacheReadTokens).toBe(a.usage.cacheWriteTokens);
      expect(b.usage.cacheWriteTokens ?? 0).toBe(0);
      expect(seen.recorded[1].r).toMatchObject({ cacheReadTokens: a.usage.cacheWriteTokens, cacheWriteTokens: 0 });
      expect(seen.recorded[1].obs.promptCache).toBe("prefix");
      const p = TIERS[1].prices;
      expect(cacheEconomics(b.usage, p)).toMatchObject({ hit: true });
      expect(cacheEconomics(b.usage, p).savedMicrocents).toBe(b.usage.cacheReadTokens! * (p.inputMicrocentsPerToken - p.cacheReadMicrocentsPerToken));
      expect(costMicrocents(b.usage, p)).toBeLessThan(costMicrocents({ ...b.usage, inputTokens: b.usage.inputTokens + b.usage.cacheReadTokens!, cacheReadTokens: 0 }, p));
      // The model scopes the cache: a different tier starts its own entry.
      const c = await inferRouted(ports, factory, "A", "t", { messages: obs, route: { taskClass: "failure_diagnosis" } });
      expect(c.usage.cacheReadTokens ?? 0).toBe(0);
    });
  });

  it("a prefix below the model's minimum is not cached (e.g. Haiku 4.5: 4096 tokens)", async () => {
    await withFake(async (factory) => {
      const { ports } = fakePorts();
      const a = await inferRouted(ports, factory, "A", "t", { messages: obs, route: { taskClass: "extraction" } });
      expect(a.usage.cacheWriteTokens ?? 0).toBe(0);
    }, 1_000_000);
  });

  it("provider-bound thinking only goes back to the model that produced it", async () => {
    await withFake(async (factory, fake) => {
      const withThinking = [...obs, { role: "assistant", content: "", toolCalls: [{ id: "toolu_1", name: "list_goals", arguments: {} }], thinking: [{ type: "thinking", thinking: "t", signature: "c2ln" }] }, { role: "tool", toolCallId: "toolu_1", content: "[]" }];
      await inferRouted(fakePorts({ lastModel: OPUS }).ports, factory, "A", "t", { messages: withThinking }); // routed to Sonnet: Opus's block is foreign
      expect(JSON.stringify(fake.lastBody)).not.toContain("c2ln");
      await inferRouted(fakePorts({ lastModel: SONNET }).ports, factory, "A", "t", { messages: withThinking }); // same model, inside the tool loop
      expect(JSON.stringify(fake.lastBody)).toContain("c2ln");
    });
  });

  it("history cannot change the tier: identical tasks from rich and broke founders get the same model", async () => {
    await withFake(async (factory) => {
      const rich = fakePorts({ status: { cashPence: 9_000_000, recentProfitPence: 50_000, opportunities: 1 } });
      const broke = fakePorts({ status: { cashPence: 12, recentLossPence: 9_000, opportunities: 3, failedOpportunities: 2 } });
      for (const cls of ["extraction", "agent_step", "opportunity_research", "failure_diagnosis"]) {
        const a = await inferRouted(rich.ports, factory, "A", "t", { messages: obs, route: { taskClass: cls } });
        const b = await inferRouted(broke.ports, factory, "B", "t", { messages: obs, route: { taskClass: cls } });
        expect([cls, a.route.tier, a.route.model]).toEqual([cls, b.route.tier, b.route.model]);
      }
      await expect(inferRouted(broke.ports, factory, "B", "t", { messages: obs, route: { taskClass: "agent_step", recentLoss: 9000 } })).rejects.toMatchObject({ code: "FLEET_ROUTE_INPUT_REFUSED" });
    });
  });

  it("refusals before the provider: duplicate failure, disabled/unverified tier, routing off", async () => {
    await withFake(async (factory, fake) => {
      const dup = fakePorts({ authorize: () => ({ ok: false, code: "FLEET_COGNITION_DUPLICATE_FAILURE" }) });
      await expect(inferRouted(dup.ports, factory, "A", "t", { messages: obs })).rejects.toMatchObject({ code: "FLEET_COGNITION_DUPLICATE_FAILURE", status: 409 });
      const off = fakePorts();
      off.ports.routingState = async () => ({ routingEnabled: false, tiers: TIERS });
      await expect(inferRouted(off.ports, factory, "A", "t", { messages: obs })).rejects.toMatchObject({ code: "FLEET_ROUTING_DISABLED" });
      const unv = fakePorts();
      unv.ports.routingState = async () => ({ routingEnabled: true, tiers: TIERS.map((t) => ({ ...t, verifiedAt: null })) });
      await expect(inferRouted(unv.ports, factory, "A", "t", { messages: obs })).rejects.toMatchObject({ code: "FLEET_COGNITION_TIER_UNVERIFIED" });
      expect(fake.requests.size).toBe(0);
    });
  });

  it("T1 uses a small routine context: compact charter, no toolbox, single bounded task (no tool loop)", async () => {
    await withFake(async (factory, fake) => {
      const { ports } = fakePorts();
      await inferRouted(ports, factory, "A", "t", { messages: [{ role: "user", content: "Extract the price: 'Groomer Income Tracker — £12'" }], route: { taskClass: "extraction" } });
      const body = fake.lastBody as Record<string, unknown>;
      expect(body).not.toHaveProperty("tools");
      const sys = JSON.stringify(body.system);
      expect(sys).toContain("one bounded routine task");
      expect(sys).toContain("untrusted data");
      expect(sys).not.toContain("independent economic actor"); // not the full founder charter
      expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(2_000);
      const loop = [{ role: "user", content: "x" }, { role: "assistant", content: "", toolCalls: [{ id: "toolu_9", name: "list_goals", arguments: {} }] }, { role: "tool", toolCallId: "toolu_9", content: "[]" }];
      await expect(inferRouted(ports, factory, "A", "t", { messages: loop, route: { taskClass: "extraction" } })).rejects.toMatchObject({ code: "FLEET_ROUTE_T1_SINGLE_TASK" });
    });
  });

  it("T1 lifecycle fails closed: disabled, unverified, missing or retired T1 is refused — never promoted to T2/T3", async () => {
    await withFake(async (factory, fake) => {
      const variants: Array<[string, TierCandidate[]]> = [
        ["disabled", TIERS.map((t) => (t.tier === "T1" ? { ...t, enabled: false } : t))],
        ["unverified", TIERS.map((t) => (t.tier === "T1" ? { ...t, verifiedAt: null } : t))],
        ["missing", TIERS.filter((t) => t.tier !== "T1")],
      ];
      for (const [label, tiers] of variants) {
        const { ports, seen } = fakePorts();
        ports.routingState = async () => ({ routingEnabled: true, tiers, lastModel: null });
        const err = await inferRouted(ports, factory, "A", "t", { messages: obs, route: { taskClass: "extraction" } }).catch((e) => e);
        expect([label, err.code]).toEqual([label, label === "unverified" ? "FLEET_COGNITION_TIER_UNVERIFIED" : "FLEET_COGNITION_TIER_UNAVAILABLE"]);
        expect(seen.authorized).toEqual([]);
      }
      expect(fake.requests.size).toBe(0); // no model at all was called, least of all Sonnet or Opus
      // Retired at the provider (verified earlier, now 404): a classified provider failure, recorded, not re-routed.
      const retired = TIERS.map((t) => (t.tier === "T1" ? { ...t, model: "claude-haiku-retired" } : t));
      const { ports, seen } = fakePorts();
      ports.routingState = async () => ({ routingEnabled: true, tiers: retired, lastModel: null });
      await expect(inferRouted(ports, factory, "A", "t", { messages: obs, route: { taskClass: "extraction" } })).rejects.toMatchObject({ code: "FLEET_COGNITION_PROVIDER_ERROR" });
      expect(seen.authorized.map((x) => x.route.model)).toEqual(["claude-haiku-retired"]);
      expect(seen.recorded.map((x) => [x.r.outcome, x.r.errorCode])).toEqual([["error", "PROVIDER_MODEL_NOT_FOUND"]]);
      expect(fake.lastBody).toMatchObject({ model: "claude-haiku-retired" }); // the only request: the configured T1 model
      // A consequential task still routes by its own class (normal task routing applies).
      const { ports: p2 } = fakePorts();
      p2.routingState = async () => ({ routingEnabled: true, tiers: TIERS.map((t) => (t.tier === "T1" ? { ...t, enabled: false } : t)), lastModel: null });
      expect((await inferRouted(p2, factory, "A", "t", { messages: obs, route: { taskClass: "validation_design" } })).route).toMatchObject({ tier: "T2", model: SONNET });
    });
  });

  it("each logged tool call carries its id and, for a spend, the canonical action digest the boundary checks", async () => {
    const spend = { amountCents: 2500, category: "expense", destinationId: "dst_01ABCDEFGHJKMNPQRSTVWXYZ01", purpose: "listing fee" };
    const provider: CognitionProvider = {
      id: "anthropic", model: SONNET,
      chat: async (_r: ChatRequest): Promise<ChatResult> => ({ content: "", toolCalls: [{ id: "toolu_s1", name: "request_spend", arguments: spend }, { id: "toolu_g1", name: "list_goals", arguments: {} }],
        usage: { inputTokens: 900, outputTokens: 120 }, stopReason: "tool_use", usageSource: "provider", attempts: 1, responseModel: SONNET }),
    };
    const { ports, seen } = fakePorts();
    await inferRouted(ports, () => Object.assign(provider, { promptCache: "off" }), "A", "t", { messages: obs });
    const calls = seen.recorded[0].r.toolCalls as Array<Record<string, unknown>>;
    expect(calls[0]).toMatchObject({ id: "toolu_s1", name: "request_spend", actionSha256: actionDigest("request_spend", spend) });
    expect(calls[1]).not.toHaveProperty("actionSha256");
  });
});

describe("loop and duplication economics (founder runtime)", () => {
  function box(guard?: LoopGuard) {
    const root = tmp();
    for (const d of ["w", "m"]) fs.mkdirSync(path.join(root, d));
    let fetches = 0;
    const tb = new FounderToolbox({
      manifest: FOUNDER_MANIFEST_V2, workspaceDir: path.join(root, "w"), memoryDir: path.join(root, "m"), loopGuard: guard,
      ports: {
        researchFetch: async (p: { url: string }) => {
          fetches++;
          if (p.url.includes("broken")) throw Object.assign(new Error("404"), { code: "RESEARCH_HTTP_STATUS" });
          return { attemptId: `a${fetches}`, requestedUrl: p.url, finalUrl: p.url, fetchedAt: "t", status: 200, contentType: "text/html", bytes: 3, truncated: false, sha256: "c".repeat(64), title: "t", text: "page", links: [] };
        },
      } as never,
    });
    return { tb, fetches: () => fetches };
  }
  const call = (name: string, args: Record<string, unknown>, id = "c") => ({ id, name, arguments: args });

  it("no re-fetch of a saved page (unless refresh:), no identical failed call without changed state, unchanged reads reused", async () => {
    const g = new LoopGuard();
    const { tb, fetches } = box(g);
    await tb.execute(call("web_fetch", { url: "https://x.example/p", purpose: "demand" }));
    const again = await tb.execute(call("web_fetch", { url: "https://x.example/p", purpose: "demand again" }));
    expect(again.output).toMatch(/^ALREADY FETCHED/);
    expect(fetches()).toBe(1);
    await tb.execute(call("web_fetch", { url: "https://x.example/p", purpose: "refresh: prices change daily" }));
    expect(fetches()).toBe(2);
    const bad = call("web_fetch", { url: "https://x.example/broken", purpose: "p" });
    expect((await tb.execute(bad)).ok).toBe(false);
    const blocked = await tb.execute(bad);
    expect(blocked).toMatchObject({ ok: false, refused: "FLEET_DUPLICATE_FAILED_ACTION" });
    expect(fetches()).toBe(3);
    // Changed state justifies a retry.
    await tb.execute(call("remember_fact", { key: "k", value: "new evidence" }));
    await tb.execute(bad);
    expect(fetches()).toBe(4);
    await tb.execute(call("list_goals", {}));
    expect((await tb.execute(call("list_goals", {}))).output).toMatch(/^\[unchanged/);
    expect(g.stats).toMatchObject({ refetchesAvoided: 1, duplicateFailuresBlocked: 1, readOnlyReused: 1 });
  });

  it("without a guard the toolbox is unchanged (legacy runtimes, the F1-EVAL-02 harness)", async () => {
    const { tb, fetches } = box();
    await tb.execute(call("web_fetch", { url: "https://x.example/p", purpose: "d" }));
    await tb.execute(call("web_fetch", { url: "https://x.example/p", purpose: "d" }));
    expect(fetches()).toBe(2);
  });
});

describe("founder runtime: task classes and escalation (new runtimes only)", () => {
  it("a mind with a task class sends it as a routing request; a legacy mind sends the legacy body", async () => {
    const seen: unknown[][] = [];
    const mk = (taskClass?: string) => {
      const root = tmp();
      for (const d of ["w", "m", "s"]) fs.mkdirSync(path.join(root, d));
      return new FounderMind({
        toolbox: new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: path.join(root, "w"), memoryDir: path.join(root, "m"), ports: {} as never }),
        stateDir: path.join(root, "s"), taskClass,
        ports: { cognitionStatus: async () => ({ policyEnabled: true, provider: "anthropic", founderEnabled: true, paused: false }),
          infer: async (...args: unknown[]) => { seen.push(args); return { content: "ok", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, chargedCents: 0, requestId: "r" }; } },
      });
    };
    await mk("opportunity_research").turn("hb");
    await mk().turn("hb");
    expect(seen[0][2]).toEqual({ taskClass: "opportunity_research" });
    expect(seen[1].length).toBe(2);
  });

  it("escalateQuestion sends one decision packet with a structured request and persists the observable answer", async () => {
    const root = tmp();
    const mem = path.join(root, "m");
    const ws = path.join(root, "w");
    fs.mkdirSync(mem);
    fs.mkdirSync(ws);
    fs.writeFileSync(path.join(mem, "facts.json"), JSON.stringify({ "fees current": "transaction fee 9%" }));
    const sent: Array<{ messages: unknown[]; route: Record<string, unknown> }> = [];
    const r = await escalateQuestion({
      ports: { infer: async (messages, _w, route) => { sent.push({ messages, route: route! }); return { content: "Decision: still run it; margin £10.24", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, chargedCents: 0, requestId: "11111111-1111-4111-8111-111111111111", route: { tier: "T3", model: OPUS, taskClass: "evidence_conflict_resolution", scope: "question" } } as never; } },
      memoryDir: mem, workspaceDir: ws, taskClass: "evidence_conflict_resolution", requestedTier: "T3", parentRequestId: "22222222-2222-4222-8222-222222222222",
      decision: { question: "Is the fee change material?", escalationReason: "EVIDENCE_CONFLICT", hypothesis: "list at £12", state: "g1", economicConsequence: "£0.20", conflict: ["6.5% vs 9%"] },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].messages).toHaveLength(1);
    expect(String((sent[0].messages[0] as { content: string }).content)).toMatch(/^CRITICAL DECISION PACKET \(fleet-decision-v1\)/);
    expect(sent[0].route).toEqual({ taskClass: "evidence_conflict_resolution", escalation: { reasonCode: "EVIDENCE_CONFLICT", requestedTier: "T3", parentRequestId: "22222222-2222-4222-8222-222222222222" } });
    const facts = JSON.parse(fs.readFileSync(path.join(mem, "facts.json"), "utf8"));
    expect(JSON.parse(facts[r.factKey])).toMatchObject({ answer: "Decision: still run it; margin £10.24", tier: "T3", model: OPUS, reason: "EVIDENCE_CONFLICT" });
    expect(r.packetBytes).toBeGreaterThan(0);
  });
});

describe("routed gateway error mapping", () => {
  it("a route that is not an object, or names an unknown class, is a 400 before anything else", async () => {
    const { ports, seen } = fakePorts();
    const never = () => { throw new Error("no provider"); };
    await expect(inferRouted(ports, never, "A", "t", { messages: [{ role: "user", content: "x" }], route: "T3" })).rejects.toBeInstanceOf(CognitionError);
    await expect(inferRouted(ports, never, "A", "t", { messages: [{ role: "user", content: "x" }], route: { taskClass: "make_money_fast" } })).rejects.toMatchObject({ code: "FLEET_ROUTE_UNKNOWN_CLASS", status: 400 });
    expect(seen.authorized).toEqual([]);
  });
});

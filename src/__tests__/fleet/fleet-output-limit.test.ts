/**
 * Efficiency proposal (owner, 24 Oct 2026): a founder step's output allowance is 4,000 tokens (not the tier's 8,000 / 16,000),
 * and a reply cut off at that limit is handled safely: its tool calls — possibly with incomplete arguments — are never
 * executed (each parser drops them; the gateway drops any that reach it), the agent is told, and the turn continues in
 * smaller pieces at most twice in a row before it ends cut off. No automatic retry at a higher limit.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { parseAnthropicMessage } from "../../fleet/cognition/anthropic.js";
import { parseChatCompletion } from "../../fleet/cognition/providers.js";
import { parseLocalCompletion } from "../../fleet/cognition/local.js";
import { FOUNDER_STEP_MAX_OUTPUT_TOKENS, costBoundMicro, founderStepMaxTokens, inferRouted, type ProviderFactory, type RoutedCognitionPorts } from "../../fleet/cognition/routed-gateway.js";
import type { TierCandidate } from "../../fleet/cognition/router.js";
import type { ChatRequest, ChatResult } from "../../fleet/cognition/types.js";
import { FOUNDER_MANIFEST_V2, manifestSha256 } from "../../fleet/capabilities.js";
import { FounderToolbox } from "../../fleet/founder/toolbox.js";
import { FounderMind, OUTPUT_LIMIT_CONTINUES, OUTPUT_LIMIT_STOP, type MindPorts } from "../../fleet/founder/mind.js";
import { LoopGuard } from "../../fleet/founder/loop-guard.js";
import { capabilityView } from "../../fleet/cognition/capability-signature.js";

const verified = "2026-09-30T00:00:00Z";
const price = (i: number, o: number) => ({ inputMicrocentsPerToken: i, outputMicrocentsPerToken: o, cacheWriteMicrocentsPerToken: i * 1.25, cacheReadMicrocentsPerToken: i / 10 });
// Production's tier settings (24 Oct): T1 Haiku 2,000; T2 Sonnet 8,000; T3 Opus 16,000.
const TIERS: TierCandidate[] = [
  { tier: "T1", provider: "anthropic", model: "claude-haiku-4-5", thinking: null, effort: null, maxOutputTokens: 2_000, prices: price(100, 500), enabled: true, verifiedAt: verified },
  { tier: "T2", provider: "anthropic", model: "claude-sonnet-5-5", thinking: "adaptive", effort: "medium", maxOutputTokens: 8_000, prices: price(200, 1_000), enabled: true, verifiedAt: verified },
  { tier: "T3", provider: "anthropic", model: "claude-opus-5-5", thinking: "adaptive", effort: "medium", maxOutputTokens: 16_000, prices: price(400, 2_000), enabled: true, verifiedAt: verified },
];

describe("a reply cut off at the output limit: tool calls are dropped, never executed", () => {
  it("Anthropic: a max_tokens stop with a (truncated) tool_use and unsigned thinking keeps only the text", () => {
    const r = parseAnthropicMessage(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "max_tokens",
      content: [{ type: "thinking", thinking: "planning…" }, { type: "text", text: "Writing the file now." },
        { type: "tool_use", id: "toolu_1", name: "write_file", input: { path: "order/big.json", content: "{\"blocks\": [" } }],
      usage: { input_tokens: 100, output_tokens: 4_000 } }));
    expect(r).toMatchObject({ content: "Writing the file now.", toolCalls: [], stopReason: "max_tokens", cutToolCalls: 1 });
    expect(r).not.toHaveProperty("thinking");
  });

  it("a complete tool_use stop is unchanged", () => {
    const r = parseAnthropicMessage(JSON.stringify({ id: "msg_2", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "toolu_2", name: "list_goals", input: {} }], usage: { input_tokens: 10, output_tokens: 10 } }));
    expect(r).toMatchObject({ toolCalls: [{ id: "toolu_2", name: "list_goals" }], stopReason: "tool_use" });
  });

  it("OpenAI-compatible and local: finish_reason length drops the calls (the local parser never 'repairs' a cut-off call)", () => {
    const body = JSON.stringify({ id: "chatcmpl-1", model: "qwen3.5-9b", usage: { prompt_tokens: 10, completion_tokens: 4_000 },
      choices: [{ finish_reason: "length", message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: "{\"path\": \"a.json\", \"content\": \"{\\\"x\\\": [1, 2" } }] } }] });
    expect(parseChatCompletion(body)).toMatchObject({ toolCalls: [], stopReason: "length", cutToolCalls: 1 });
    expect(parseLocalCompletion(body)).toMatchObject({ toolCalls: [], stopReason: "length", cutToolCalls: 1 });
    // Without the cut, the same truncated arguments would have been repaired into an executable call (the hazard closed here).
    const complete = body.replace("\"length\"", "\"tool_calls\"");
    expect((parseLocalCompletion(complete) as { toolCalls: unknown[] }).toolCalls).toHaveLength(1);
  });
});

describe("the founder step's output allowance", () => {
  it("4,000 for T2 and T3; a smaller tier value stays; a thinking budget keeps 1,024 above it", () => {
    expect(FOUNDER_STEP_MAX_OUTPUT_TOKENS).toBe(4_000);
    expect(founderStepMaxTokens(TIERS[2])).toBe(4_000);
    expect(founderStepMaxTokens(TIERS[1])).toBe(4_000);
    expect(founderStepMaxTokens({ maxOutputTokens: 3_000, thinking: null })).toBe(3_000);
    expect(founderStepMaxTokens({ maxOutputTokens: 16_000, thinking: "enabled:6000" })).toBe(7_024);
    expect(founderStepMaxTokens({ maxOutputTokens: 16_000, thinking: "adaptive" })).toBe(4_000);
  });

  it("the reserved worst case falls by exactly the output it no longer reserves (T3: 12,000 × 2,000 µ¢ = $0.24)", () => {
    const at = (n: number) => costBoundMicro("x".repeat(400_000), [], 0, n, TIERS[2].prices);
    expect(at(16_000) - at(4_000)).toBe(12_000 * 2_000);
  });

  it("the gateway sends 4,000 on a founder step, keeps T1's own value, and drops tool calls of a cut-off reply that reach it", async () => {
    const seen: number[] = [];
    let cut = false;
    const factory: ProviderFactory = () => ({ chat: async (req: ChatRequest): Promise<ChatResult> => {
      seen.push(req.maxTokens);
      return cut
        ? { content: "", toolCalls: [{ id: "t1", name: "write_file", arguments: { path: "a" } }], usage: { inputTokens: 10, outputTokens: req.maxTokens }, stopReason: "max_tokens", usageSource: "provider", attempts: 1 }
        : { content: "ok", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, stopReason: "end_turn", usageSource: "provider", attempts: 1 };
    } }) as never;
    const authorized: number[] = [];
    let n = 0;
    const ports: RoutedCognitionPorts = {
      capabilities: async () => ({ ok: true, origin: "genesis_founder", allowed: FOUNDER_MANIFEST_V2.allowed as unknown as string[] }),
      cognitionStatus: async () => ({ ok: true, policyEnabled: true, provider: "anthropic", model: "claude-opus-5-5" }),
      routingState: async () => ({ routingEnabled: true, tiers: TIERS, lastModel: null, lastAgeS: null }),
      authorize: async (_a, estimate) => { authorized.push(estimate); return { ok: true, requestId: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` }; },
      record: async (_a, _id, r) => ({ ok: true, chargedCents: 0, chargedMicrocents: 0, usageSource: r.usageSource }),
    };
    const msgs = [{ role: "user", content: "Heartbeat. Decide your next step." }];
    await inferRouted(ports, factory, "A", "t", { messages: msgs, route: { taskClass: "founder_work" } });
    await inferRouted(ports, factory, "A", "t", { messages: msgs, route: { taskClass: "agent_step" } });
    await inferRouted(ports, factory, "A", "t", { messages: msgs, route: { taskClass: "basic_summary" } });
    expect(seen).toEqual([4_000, 4_000, 2_000]);
    cut = true;
    const r = await inferRouted(ports, factory, "A", "t", { messages: msgs, route: { taskClass: "founder_work" } }) as Record<string, unknown>;
    expect(r.toolCalls).toEqual([]);
    expect(r.outputLimit).toEqual({ maxTokens: 4_000, cutToolCalls: 1 });
  });
});

describe("the mind after a cut-off step (routed, as production founders run)", () => {
  const CAPS = { ok: true, origin: "reseed_founder", manifestId: "founder-v2", manifestSha256: manifestSha256(FOUNDER_MANIFEST_V2), allowed: FOUNDER_MANIFEST_V2.allowed };
  const mind = (replies: Array<Record<string, unknown>>) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "f-outlim-"));
    const d = { w: path.join(root, "w"), s: path.join(root, "s"), m: path.join(root, "s", "memory") };
    for (const x of Object.values(d)) fs.mkdirSync(x, { recursive: true });
    const sent: Array<Array<{ role: string; content: string }>> = [];
    const executed: string[] = [];
    let i = 0;
    const ports: MindPorts = {
      cognitionStatus: async () => ({ policyEnabled: true, provider: "anthropic", founderEnabled: true, paused: false, routing: { active: true },
        capabilities: { ...capabilityView(CAPS as never, true), reproductionExecutable: false }, survival: { survivalEquityCents: 9_906, inferenceTodayCents: 80, burnPerDayCents: 40, runwayDays: 240 } }),
      ledger: async () => ({ cash: 9_906, survivalEquity: 9_906, genesisAllocation: 10_000, externalCustomerRevenue: 0 }),
      ownerRequests: async () => ({ ok: true, requests: [] }),
      infer: async (messages) => {
        sent.push(structuredClone(messages) as never);
        return { usage: { inputTokens: 1, outputTokens: 1 }, chargedCents: 1, requestId: `r${i}`, ...replies[Math.min(i++, replies.length - 1)] } as never;
      },
    };
    const loopGuard = new LoopGuard();
    const toolbox = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: d.w, memoryDir: d.m, loopGuard, selfGovernance: true, ports: {
      ledger: async () => ({}), ownerRequests: async () => ({ ok: true, requests: [] }), economy: async () => ({ ok: true }) } as never });
    const exec = toolbox.execute.bind(toolbox);
    toolbox.execute = async (c) => { executed.push(c.name); return exec(c); };
    const m = new FounderMind({ ports, toolbox, stateDir: d.s, hibernationSafetyMs: 0, maxStepsPerTurn: 12, routed: { memoryDir: d.m, workspaceDir: d.w, manifest: FOUNDER_MANIFEST_V2, loopGuard } });
    return { m, sent, executed };
  };
  const CUT = { content: "", toolCalls: [], outputLimit: { maxTokens: 4_000, cutToolCalls: 1 } };

  it("the agent is told nothing ran and continues; a normal reply after it finishes the turn", async () => {
    const { m, sent, executed } = mind([CUT, { content: "Done for now.", toolCalls: [] }]);
    const r = await m.turn("hb");
    expect(sent).toHaveLength(2);
    expect(sent[1].at(-2)).toMatchObject({ role: "assistant", content: "(reply cut off at the output limit)" });
    expect(sent[1].at(-1)!.role).toBe("user");
    expect(sent[1].at(-1)!.content).toContain("1 tool call(s) in it were NOT executed");
    expect(executed).toEqual([]);
    expect(r.steps).toBe(2);
  });

  it("bounded: after OUTPUT_LIMIT_CONTINUES notes the next cut-off ends the turn, carried (no higher-limit retry)", async () => {
    const { m, sent, executed } = mind([CUT]);
    const r = await m.turn("hb");
    expect(sent).toHaveLength(OUTPUT_LIMIT_CONTINUES + 1);
    expect(executed).toEqual([]);
    expect(r.steps).toBe(OUTPUT_LIMIT_CONTINUES + 1);
    expect(OUTPUT_LIMIT_STOP).toBe("FLEET_OUTPUT_LIMIT");
  });
});

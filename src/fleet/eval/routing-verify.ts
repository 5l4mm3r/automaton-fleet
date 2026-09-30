/**
 * v22 routed-cognition real-API verification (engineering/evaluation spend; never Founder operating expense).
 *
 * Drives the DEPLOYED routed gateway (`inferRouted`) and provider factory against the real provider, with in-memory
 * ports instead of the registry: no founder, no cognition log, no ledger, no provider-credit consumption row. Each
 * call is priced exactly at its tier's own prices. Smallest experiment that proves the real path:
 *   1  T1 extraction            Haiku (compact routine context; not padded to any cache minimum)
 *   2  T2 agent_step            Sonnet, founder prefix → cache WRITE expected
 *   3  T2 agent_step (new tail) Sonnet → cache READ expected
 *   4  T3 escalation            Opus, one Critical Decision Packet (question-scoped)
 *   5  T2 agent_step            Sonnet again (control returned downward); the history carries call 4's Opus-signed
 *                               thinking, which must NOT reach Sonnet
 * A request observer records structure only (model, thinking/effort, cache marker, message count, whether any
 * signature is present, attempts) — never headers or content. A hard guard refuses any request whose worst case
 * would take cumulative spend over the budget, before it is sent.
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { inferRouted, type ProviderFactory, type RoutedCognitionPorts } from "../cognition/routed-gateway.js";
import type { TierCandidate } from "../cognition/router.js";
import { cacheEconomics, costMicrocents } from "../cognition/charging.js";
import { buildDecisionPacket, renderDecisionPacket } from "../cognition/task-packet.js";
import type { ChatMessage, Usage } from "../cognition/types.js";
import { FOUNDER_MANIFEST_V2 } from "../capabilities.js";

export interface ObservedRequest {
  model: string;
  thinking: unknown;
  effort: unknown;
  systemCached: boolean;
  tools: number;
  messages: number;
  containsSignature: boolean;
  bodyBytes: number;
  boundMicrocents: number;
  status?: number;
  responseModel?: string | null;
  providerRequestId?: string | null;
  /** The guard refused this request before it was sent. */
  budgetStop?: boolean;
}

export interface VerifyCall {
  step: number;
  label: string;
  ok: boolean;
  code?: string;
  tier?: string;
  taskClass?: string;
  scope?: string;
  model?: string;
  usage?: Usage;
  costMicrocents: number;
  cache?: ReturnType<typeof cacheEconomics>;
  requests: ObservedRequest[];
  toolCalls?: string[];
  thinkingBlocks?: number;
}

/** The v22 seed mappings (the only models this runner will touch). Output caps are small: verification only. */
export const VERIFY_TIERS: TierCandidate[] = [
  { tier: "T1", provider: "anthropic", model: "claude-haiku-4-5-20251001", thinking: null, effort: null, maxOutputTokens: 300,
    prices: { inputMicrocentsPerToken: 100, outputMicrocentsPerToken: 500, cacheWriteMicrocentsPerToken: 125, cacheReadMicrocentsPerToken: 10 }, enabled: true, verifiedAt: "verification-run" },
  { tier: "T2", provider: "anthropic", model: "claude-sonnet-5-5", thinking: "adaptive", effort: "medium", maxOutputTokens: 1024,
    prices: { inputMicrocentsPerToken: 200, outputMicrocentsPerToken: 1000, cacheWriteMicrocentsPerToken: 250, cacheReadMicrocentsPerToken: 20 }, enabled: true, verifiedAt: "verification-run" },
  { tier: "T3", provider: "anthropic", model: "claude-opus-5-5", thinking: "adaptive", effort: "medium", maxOutputTokens: 2048,
    prices: { inputMicrocentsPerToken: 400, outputMicrocentsPerToken: 2000, cacheWriteMicrocentsPerToken: 500, cacheReadMicrocentsPerToken: 20 }, enabled: true, verifiedAt: "verification-run" },
];
export const VERIFY_MAX_BUDGET_MICROCENTS = 25_000_000;

export class VerifyBudgetStop extends Error {}

/** Wraps fetch: structure-only observation and the worst-case budget guard (before anything is sent). */
export function observingFetch(o: { tiers: TierCandidate[]; budgetMicrocents: number; spent: () => number; sink: ObservedRequest[]; inner?: typeof fetch }): typeof fetch {
  const inner = o.inner ?? fetch;
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    let b: Record<string, unknown> = {};
    try { b = JSON.parse(raw); } catch { /* not JSON */ }
    const t = o.tiers.find((x) => x.model === b.model);
    const inPrice = t ? Math.max(t.prices.inputMicrocentsPerToken, t.prices.cacheWriteMicrocentsPerToken) : 1_000_000;
    const outPrice = t ? t.prices.outputMicrocentsPerToken : 1_000_000;
    const bound = (Buffer.byteLength(raw) + 2_000) * inPrice + Number(b.max_tokens ?? 0) * outPrice;
    const rec: ObservedRequest = {
      model: String(b.model ?? ""), thinking: b.thinking ?? null, effort: (b.output_config as Record<string, unknown> | undefined)?.effort ?? null,
      systemCached: Array.isArray(b.system) && (b.system as Array<Record<string, unknown>>).some((x) => x.cache_control !== undefined),
      tools: Array.isArray(b.tools) ? b.tools.length : 0, messages: Array.isArray(b.messages) ? b.messages.length : 0,
      containsSignature: /"signature"\s*:/.test(raw), bodyBytes: Buffer.byteLength(raw), boundMicrocents: bound,
    };
    o.sink.push(rec);
    if (!t || o.spent() + bound > o.budgetMicrocents) rec.budgetStop = true;
    if (rec.budgetStop) throw new VerifyBudgetStop(!t ? "unknown model in request" : "budget guard: this request's worst case would exceed the verification budget");
    const res = await inner(url, init);
    rec.status = res.status;
    rec.providerRequestId = res.headers.get("request-id");
    try {
      const j = JSON.parse(await res.clone().text()) as Record<string, unknown>;
      rec.responseModel = typeof j.model === "string" ? j.model : null;
    } catch { rec.responseModel = null; }
    return res;
  }) as typeof fetch;
}

export async function runRoutingVerification(o: {
  factory: ProviderFactory;
  tiers: TierCandidate[];
  budgetMicrocents: number;
  sink: ObservedRequest[];
  log?: (c: VerifyCall) => void;
}): Promise<{ calls: VerifyCall[]; spentMicrocents: number; stopped: string | null }> {
  const calls: VerifyCall[] = [];
  let spent = 0;
  let lastModel: string | null = null;
  const byModel = new Map(o.tiers.map((t) => [t.model, t]));
  const ports: RoutedCognitionPorts = {
    capabilities: async () => ({ ok: true, origin: "genesis_founder", allowed: FOUNDER_MANIFEST_V2.allowed as unknown as string[] }),
    cognitionStatus: async () => ({ ok: true, policyEnabled: true, provider: "anthropic" }),
    routingState: async () => ({ routingEnabled: true, tiers: o.tiers, lastModel }),
    authorize: async () => ({ ok: true, requestId: crypto.randomUUID() }),
    record: async (_a, _id, r) => ({ ok: true, chargedCents: 0, chargedMicrocents: 0, usageSource: r.usageSource }),
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-routing-verify-"));
  try {
    const mem = path.join(root, "memory");
    const ws = path.join(root, "workspace");
    fs.mkdirSync(mem);
    fs.mkdirSync(ws);
    fs.writeFileSync(path.join(mem, "facts.json"), JSON.stringify({
      "listing fees": "Marketplace transaction fee rose from 6.5% to 9% on 1 Oct (official fee page); listing fee £0.20.",
      "validation plan": "List a £12 bookkeeping template for 21 days; stop if 150 views and 0 sales.",
    }));
    const packet = renderDecisionPacket(buildDecisionPacket({
      memoryDir: mem, workspaceDir: ws, question: "Given the fee rise from 6.5% to 9%, should the £12 listing test still run as planned? Answer in at most 3 sentences.",
      escalationReason: "HIGH_CONSEQUENCE", hypothesis: "Run the £12 listing test unchanged.", state: "Validation not started.",
      economicConsequence: "£0.20 listing fee; reversible; net per sale falls from £10.54 to £10.24.", conflict: ["fee change after the plan was made"],
    }));
    let opusAssistant: ChatMessage | null = null;
    const steps: Array<{ label: string; body: () => Record<string, unknown> }> = [
      { label: "T1 extraction (Haiku, compact routine context)", body: () => ({ messages: [{ role: "user", content: "Extract the product name and price as JSON {name, priceGBP} from: \"Groomer Income Tracker — £12 — 14 sales\"." }], route: { taskClass: "extraction" } }) },
      { label: "T2 agent_step (Sonnet) — cache write expected", body: () => ({ messages: [{ role: "user", content: "Routing verification heartbeat A. Reply with one short sentence and no tool call." }] }) },
      { label: "T2 agent_step (Sonnet) — new tail, cache read expected", body: () => ({ messages: [{ role: "user", content: "Routing verification heartbeat B (a different observation). Reply with one short sentence and no tool call." }] }) },
      { label: "T3 escalation (Opus) — one decision packet", body: () => ({ messages: [{ role: "user", content: packet }], route: { taskClass: "agent_step", escalation: { reasonCode: "HIGH_CONSEQUENCE", requestedTier: "T3" } } }) },
      { label: "T2 agent_step (Sonnet) after the escalation — Opus thinking must not cross", body: () => ({ messages: [
        { role: "user", content: "Routing verification heartbeat C." },
        ...(opusAssistant ? [opusAssistant] : []),
        { role: "user", content: "Heartbeat D: reply with one short sentence and no tool call." },
      ] }) },
    ];
    for (const [i, st] of steps.entries()) {
      const before = o.sink.length;
      const c: VerifyCall = { step: i + 1, label: st.label, ok: false, costMicrocents: 0, requests: [] };
      try {
        const r = await inferRouted(ports, o.factory, "routing-verify", "t", st.body());
        const t = byModel.get(r.route.model)!;
        Object.assign(c, { ok: true, tier: r.route.tier, taskClass: r.route.taskClass, scope: r.route.scope, model: r.route.model, usage: r.usage,
          costMicrocents: costMicrocents(r.usage, t.prices), cache: cacheEconomics(r.usage, t.prices), toolCalls: (r.toolCalls as Array<{ name: string }>).map((x) => x.name), thinkingBlocks: r.thinking?.length ?? 0 });
        spent += c.costMicrocents;
        lastModel = r.route.model;
        if (r.route.tier === "T3") opusAssistant = { role: "assistant", content: r.content || "(answer)", ...(r.thinking?.length ? { thinking: r.thinking, ...(r.blockOrder ? { blockOrder: r.blockOrder.filter((k) => !k.startsWith("tool:")) } : {}) } : {}) };
      } catch (err) {
        c.code = o.sink.slice(before).some((x) => x.budgetStop) ? "BUDGET_STOP" : ((err as { code?: string }).code ?? (err as Error).name);
        // A failed provider call may still have been billed: count its worst case (conservative).
        const sent = o.sink.slice(before).filter((x) => x.status !== undefined);
        c.costMicrocents = sent.reduce((n, x) => n + x.boundMicrocents, 0);
        spent += c.costMicrocents;
      }
      c.requests = o.sink.slice(before);
      calls.push(c);
      o.log?.(c);
      if (!c.ok) return { calls, spentMicrocents: spent, stopped: c.code ?? "error" };
    }
    return { calls, spentMicrocents: spent, stopped: null };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

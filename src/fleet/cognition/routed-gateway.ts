/**
 * Routed inference gateway (schema v22). Used ONLY for founders the owner opted into routing (global switch AND
 * per-founder enable); every other founder — Founder 1 included — uses the unchanged legacy `infer` in gateway.ts.
 *
 *   founder ─POST /v1/cognition/infer {messages, route?}─▶ controller
 *     1. same message validation / capability filtering / secret refusal as the legacy path
 *     2. Router: tier from the TASK only (task class, structured escalation, consequential-action class);
 *        T0 never reaches a model; commercial history is not an input (unknown route fields are refused)
 *     3. candidate = the owner's verified mapping for that tier (no silent substitution, no downgrade)
 *     4. escalations are question-scoped: exactly one message holding a valid Critical Decision Packet — never a
 *        transcript replay; the next ordinary call routes by its own class again
 *     5. provider-bound thinking only goes back to the model that produced it (otherwise stripped)
 *     6. svc_cognition_routed_authorize (all legacy breakers + route snapshot + duplicate-failure guard)
 *     7. provider.chat with the stable cached prefix (tools + charter) when prompt caching is on
 *     8. svc_cognition_routed_record: charge at the snapshot prices; log tier/class/escalation/packet/cache/thinking
 *        and, per tool call, its id and consequential-action digest (the action boundary's evidence)
 */

import crypto from "crypto";
import { FOUNDER_CHARTER, ProviderError, type ChatMessage, type ChatResult, type CognitionProvider, type ThinkingBlock } from "./types.js";
import { CognitionError, DEFAULT_COGNITION_DEADLINE_MS, MAX_COGNITION_DEADLINE_MS, toolsFor, validateMessages } from "./gateway.js";
import { RouteError, actionDigest, candidateFor, parseRouteRequest, route, type RouteDecision, type TierCandidate } from "./router.js";
import { DECISION_PACKET_VERSION, TASK_PACKET_VERSION, taskPacketProblems } from "./task-packet.js";
import type { CognitionRecord } from "../postgres/store.js";

export interface RoutedCognitionPorts {
  capabilities(agentId: string, token: string): Promise<Record<string, unknown> & { ok: boolean }>;
  cognitionStatus(agentId: string, token: string): Promise<Record<string, unknown> & { ok: boolean }>;
  routingState(agentId: string): Promise<Record<string, unknown> | null>;
  authorize(agentId: string, estimateUsdCents: number, route: Record<string, unknown>, promptSha256: string): Promise<Record<string, unknown> & { ok: boolean }>;
  record(agentId: string, requestId: string, r: CognitionRecord, obs: { packetBytes: number | null; thinkingTokens: number | null; promptCache: string | null }): Promise<Record<string, unknown> & { ok: boolean }>;
}

/** Builds the provider for one candidate (the controller's credential; model/thinking/effort from the owner's mapping). */
export type ProviderFactory = (c: TierCandidate, effortOverride: "high" | null) => CognitionProvider & { promptCache?: string };

const sha = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const approxTokens = (s: string) => Math.ceil(s.length / 4);

/** First line of a rendered packet and its JSON body (line 3), or null. */
function packetOf(m: ChatMessage | undefined): { kind: string; bytes: number; problems: string[] } | null {
  if (!m || m.role !== "user") return null;
  const head = /^(TASK PACKET|CRITICAL DECISION PACKET) \((fleet-task-v1|fleet-decision-v1)\)/.exec(m.content);
  if (!head) return null;
  const lines = m.content.split("\n");
  let body: unknown = null;
  try { body = JSON.parse(lines.slice(2).join("\n")); } catch { return { kind: head[2], bytes: Buffer.byteLength(m.content), problems: ["packet body is not JSON"] }; }
  const problems = taskPacketProblems(body);
  if ((body as { packet?: string })?.packet !== head[2]) problems.push("packet kind does not match its header");
  return { kind: head[2], bytes: Buffer.byteLength(m.content), problems };
}

function stripThinking(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => (m.thinking || m.blockOrder ? { ...m, thinking: undefined, blockOrder: undefined } : m));
}

export async function inferRouted(
  ports: RoutedCognitionPorts,
  providerFor: ProviderFactory,
  agentId: string,
  token: string,
  body: Record<string, unknown>,
  opts: { deadlineMs?: number; now?: () => number } = {},
): Promise<{ content: string; toolCalls: unknown[]; usage: ChatResult["usage"]; usageSource: string; chargedCents: number; chargedMicrocents: number; requestId: string;
  route: { tier: string; model: string; taskClass: string; scope: string; source: string }; thinking?: ThinkingBlock[]; blockOrder?: string[] }> {
  const now = opts.now ?? Date.now;
  let messages = validateMessages(body.messages);
  const caps = await ports.capabilities(agentId, token);
  if (!caps.ok) throw new CognitionError(401, String(caps.code ?? "FLEET_AUTH_FAILED"), "capabilities refused");
  if (caps.origin !== "genesis_founder" && caps.origin !== "reseed_founder") throw new CognitionError(403, "FLEET_COGNITION_NOT_FOUNDER", "cognition is for founders");
  const status = await ports.cognitionStatus(agentId, token);
  if (!status.ok) throw new CognitionError(401, String(status.code ?? "FLEET_AUTH_FAILED"), "status refused");
  if (!status.policyEnabled || status.provider === "none") throw new CognitionError(403, "FLEET_COGNITION_DISABLED", "cognition is disabled by the owner");
  const rs = await ports.routingState(agentId);
  if (!rs || rs.routingEnabled !== true) throw new CognitionError(409, "FLEET_ROUTING_DISABLED", "routing is not enabled for this founder");

  // 2. The router decides from the task alone.
  let decision: RouteDecision;
  try {
    decision = route(parseRouteRequest(body.route ?? { taskClass: "agent_step" }));
  } catch (err) {
    if (err instanceof RouteError) throw new CognitionError(err.code === "FLEET_ROUTE_DETERMINISTIC" ? 422 : 400, err.code, err.message);
    throw err;
  }
  if (decision.kind === "deterministic") {
    throw new CognitionError(422, "FLEET_ROUTE_DETERMINISTIC", `task class ${decision.taskClass} is answered by deterministic software, never by a model`);
  }
  // 3. The owner's verified mapping for that tier.
  let candidate: TierCandidate;
  try {
    candidate = candidateFor(decision.tier, (rs.tiers as TierCandidate[] | undefined) ?? []);
  } catch (err) {
    if (err instanceof RouteError) throw new CognitionError(409, err.code, err.message);
    throw err;
  }
  // 4. Escalate the question, not the job.
  const packet = packetOf(messages[0]);
  if (packet && packet.problems.length) throw new CognitionError(400, "FLEET_TASK_PACKET_INVALID", packet.problems.join("; ").slice(0, 300));
  if (decision.scope === "question") {
    if (messages.length !== 1 || packet?.kind !== DECISION_PACKET_VERSION) {
      throw new CognitionError(400, "FLEET_ESCALATION_REQUIRES_PACKET", "an escalation carries exactly one Critical Decision Packet, never a transcript");
    }
  } else if (packet?.kind === DECISION_PACKET_VERSION) {
    throw new CognitionError(400, "FLEET_ROUTE_INVALID", "a decision packet is only sent with an escalation");
  }
  // 5. Provider-bound thinking stays with the model that produced it.
  if (rs.lastModel !== candidate.model) messages = stripThinking(messages);

  const provider = providerFor(candidate, decision.effort);
  const tools = toolsFor(Array.isArray(caps.allowed) ? (caps.allowed as string[]) : []);
  const maxTokens = candidate.maxOutputTokens;
  const promptText = JSON.stringify({ system: FOUNDER_CHARTER, messages, tools: tools.map((t) => t.name) });
  const promptSha = sha(promptText);
  const estimateMicro = approxTokens(promptText) * candidate.prices.inputMicrocentsPerToken + maxTokens * candidate.prices.outputMicrocentsPerToken;
  const req = parseRouteRequest(body.route ?? { taskClass: "agent_step" });
  const snapshot = {
    tier: decision.tier, provider: candidate.provider, model: candidate.model, taskClass: decision.taskClass, ...(req.taskId ? { taskId: req.taskId } : {}),
    requestedTier: decision.requestedTier, escalationReason: decision.escalationReason, ...(req.escalation?.parentRequestId ? { parentRequestId: req.escalation.parentRequestId } : {}),
    source: decision.source, scope: decision.scope, minTier: decision.minTier, maxTier: decision.maxTier,
    thinking: candidate.thinking, effort: decision.effort ?? candidate.effort,
  };
  const auth = await ports.authorize(agentId, Math.max(1, Math.ceil(estimateMicro / 1_000_000)), snapshot, promptSha);
  if (!auth.ok) {
    const code = String(auth.code);
    throw new CognitionError(code === "FLEET_COGNITION_BUSY" || code === "FLEET_COGNITION_RATE_LIMITED" ? 429 : code === "FLEET_COGNITION_DUPLICATE_FAILURE" ? 409 : 403, code, "inference not authorized");
  }
  const requestId = String(auth.requestId);
  const deadlineMs = Math.min(MAX_COGNITION_DEADLINE_MS, Math.max(1_000, opts.deadlineMs ?? DEFAULT_COGNITION_DEADLINE_MS));
  const started = now();
  const obs = { packetBytes: packet?.bytes ?? null, thinkingTokens: null as number | null, promptCache: provider.promptCache ?? null };

  let result: ChatResult | null = null;
  let failure: ProviderError | null = null;
  try {
    result = await provider.chat({ agentId, system: FOUNDER_CHARTER, messages, tools, maxTokens, deadlineAt: started + deadlineMs });
  } catch (err) {
    failure = err instanceof ProviderError ? err : new ProviderError("PROVIDER_ERROR", { charge: "estimate", attempts: 1 });
  }
  const latencyMs = Math.max(0, Math.round(now() - started));
  if (!result || failure) {
    failure ??= new ProviderError("PROVIDER_ERROR", { charge: "estimate", attempts: 1 });
    const f = failure.info;
    const rec = await ports.record(agentId, requestId, {
      outcome: "error", inputTokens: f.usage?.inputTokens ?? 0, outputTokens: f.usage?.outputTokens ?? 0,
      cacheReadTokens: f.usage?.cacheReadTokens ?? 0, cacheWriteTokens: f.usage?.cacheWriteTokens ?? 0,
      providerRequestId: f.providerRequestId ?? null, promptSha256: promptSha, responseSha256: sha(""), toolCalls: [], errorCode: failure.code,
      usageSource: f.charge === "usage" ? "provider" : f.charge, attempts: f.attempts, providerStatus: f.status ?? null, responseModel: f.responseModel ?? null, latencyMs,
    }, obs);
    if (!rec.ok) throw new CognitionError(409, String(rec.code), "inference could not be recorded");
    if (failure.code === "PROVIDER_RATE_LIMITED") throw new CognitionError(429, "FLEET_COGNITION_PROVIDER_RATE_LIMITED", "the inference provider is rate limiting", f.retryAfterS ?? 60);
    if (failure.code === "PROVIDER_TIMEOUT") throw new CognitionError(504, "FLEET_COGNITION_PROVIDER_TIMEOUT", "the inference provider did not answer in time");
    if (failure.code === "PROVIDER_BAD_REQUEST") throw Object.assign(new CognitionError(502, "FLEET_COGNITION_PROVIDER_REJECTED", "the inference provider rejected the conversation"), { providerDetail: f.detail ?? null, providerRequestId: f.providerRequestId ?? null, requestId });
    throw new CognitionError(502, "FLEET_COGNITION_PROVIDER_ERROR", `the inference provider failed (${failure.code})`);
  }
  obs.thinkingTokens = result.usage.thinkingTokens ?? null;
  // Per tool call: id + argument digest + (for consequential actions) the canonical action digest the boundary checks.
  const loggedCalls = result.toolCalls.slice(0, 10).map((t) => {
    const a = actionDigest(t.name, t.arguments);
    return { id: t.id, name: t.name, argsSha256: sha(JSON.stringify(t.arguments)), ...(a ? { actionSha256: a } : {}) };
  });
  const rec = await ports.record(agentId, requestId, {
    outcome: "ok", inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
    cacheReadTokens: result.usage.cacheReadTokens ?? 0, cacheWriteTokens: result.usage.cacheWriteTokens ?? 0,
    providerRequestId: result.providerRequestId ?? null, stopReason: result.stopReason ?? null, promptSha256: promptSha,
    responseSha256: sha(JSON.stringify({ content: result.content, toolCalls: result.toolCalls })), toolCalls: loggedCalls, errorCode: null,
    usageSource: result.usageSource, attempts: result.attempts, providerStatus: 200, responseModel: result.responseModel ?? null, latencyMs,
  }, obs);
  if (!rec.ok) throw new CognitionError(409, String(rec.code), "inference could not be recorded");
  return {
    content: result.content, toolCalls: result.toolCalls, usage: result.usage, usageSource: String(rec.usageSource ?? result.usageSource),
    chargedCents: Number(rec.chargedCents ?? 0), chargedMicrocents: Number(rec.chargedMicrocents ?? 0), requestId,
    route: { tier: decision.tier, model: candidate.model, taskClass: decision.taskClass, scope: decision.scope, source: decision.source },
    ...(result.thinking?.length ? { thinking: result.thinking, ...(result.blockOrder ? { blockOrder: result.blockOrder } : {}) } : {}),
  };
}

export { TASK_PACKET_VERSION, DECISION_PACKET_VERSION };

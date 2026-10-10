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
 *     7. provider.chat; T1 gets a compact routine charter and no toolbox (one bounded chore, never padded); a
 *        question-scoped escalation gets the charter and no toolbox (it answers, the lower tier acts). Prompt caching
 *        is decided per call by cachePolicy (schema v23): tier policy × scope × evidenced reuse — never a blanket
 *        setting, and never a write premium for a one-off escalation
 *     8. svc_cognition_routed_record: charge at the snapshot prices; log tier/class/escalation/packet/cache/thinking
 *        and, per tool call, its id and consequential-action digest (the action boundary's evidence)
 */

import crypto from "crypto";
import { FOUNDER_ROUTED_ADDENDUM, FOUNDER_ROUTINE_CHARTER, ProviderError, charterFor, parseDoctrine, type ChatMessage, type ChatResult, type CognitionProvider, type ThinkingBlock } from "./types.js";
import { CognitionError, DEFAULT_COGNITION_DEADLINE_MS, MAX_COGNITION_DEADLINE_MS, validateMessages } from "./gateway.js";
import { founderStepTools } from "./capability-signature.js";
import { RouteError, actionDigest, candidateFor, parseRouteRequest, route, type RouteDecision, type TierCandidate } from "./router.js";
import { DECISION_PACKET_VERSION, TASK_PACKET_VERSION, taskPacketProblems } from "./task-packet.js";
import type { CognitionRecord } from "../postgres/store.js";

export interface RoutedCognitionPorts {
  capabilities(agentId: string, token: string): Promise<Record<string, unknown> & { ok: boolean }>;
  cognitionStatus(agentId: string, token: string): Promise<Record<string, unknown> & { ok: boolean }>;
  routingState(agentId: string): Promise<Record<string, unknown> | null>;
  /**
   * v62: `conversationTurn` set = a call inside an owner conversation turn (the controller's SQL decides who pays: the
   * treasury while the turn is this founder's, open and within its bound; otherwise the founder, exactly as without it).
   */
  authorize(agentId: string, estimateUsdCents: number, route: Record<string, unknown>, promptSha256: string, conversationTurn?: string | null): Promise<Record<string, unknown> & { ok: boolean }>;
  record(agentId: string, requestId: string, r: CognitionRecord, obs: { packetBytes: number | null; thinkingTokens: number | null; promptCache: string | null; cacheReason?: string | null }): Promise<Record<string, unknown> & { ok: boolean }>;
  /**
   * R41.1: the doctrines the founder's ATTESTED runtime release implements (absent = not checked, e.g. tests and
   * development). A doctrine beyond founder-v4 is served only when its release contains the matching runtime code.
   */
  runtimeDoctrines?(agentId: string): Promise<readonly string[]>;
}

export type PromptCachePolicy = "off" | "prefix" | "prefix+tail";

/**
 * Builds the provider for one candidate (the controller's credential; model/thinking/effort from the owner's mapping)
 * with the prompt-cache mode decided for THIS call.
 */
export type ProviderFactory = (c: TierCandidate, effortOverride: "high" | null, promptCache: PromptCachePolicy) => CognitionProvider & { promptCache?: string };

/** The provider's default cache lifetime: a prefix written longer ago than this is not read back. */
export const PROMPT_CACHE_TTL_S = 300;

/**
 * Prompt-cache policy for one routed call (schema v23; R22 evidence in docs/evaluations/routing-v22; R23.1 refinement
 * from the first natural routed production turn, docs/evaluations/r23):
 *   T1            off — a compact routine prompt, below the provider's cacheable minimum and never padded to reach it;
 *   question      off — a one-off escalation would pay the write premium and never read it back;
 *   T2 / T3 step  the tier's policy only when reuse is EVIDENCED: the call continues an active tool loop on the same
 *                 model (the request already carries an assistant turn and the loop's previous step ran on this model),
 *                 or the same model served this founder's previous call within the cache lifetime. A bare wake-up that only sleeps and is followed by a long gap writes nothing.
 * Deterministic in (tier, scope, tier policy, the loop position, the founder's last model and its age): never
 * commercial history.
 */
export function cachePolicy(d: Pick<RouteDecision, "tier" | "scope">, c: Pick<TierCandidate, "model" | "promptCache">,
  last: { lastModel?: unknown; lastAgeS?: unknown } = {}, loop: { continuing?: boolean } = {}): { mode: PromptCachePolicy; reason: string } {
  const configured: PromptCachePolicy = c.promptCache === "prefix" || c.promptCache === "prefix+tail" ? c.promptCache : "off";
  if (d.tier === "T1") return { mode: "off", reason: "T1 routine: compact, never padded" };
  if (configured === "off") return { mode: "off", reason: "tier policy off" };
  if (d.scope === "question") return { mode: "off", reason: "one-off escalation: no write premium" };
  const warm = last.lastModel === c.model && typeof last.lastAgeS === "number" && last.lastAgeS >= 0 && last.lastAgeS <= PROMPT_CACHE_TTL_S;
  if (loop.continuing === true) return { mode: configured, reason: `${d.tier} tool loop: reuse expected` };
  if (warm) return { mode: configured, reason: `${d.tier} same model within the cache lifetime` };
  return { mode: "off", reason: `${d.tier} no evidenced reuse` };
}

const sha = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const approxTokens = (s: string) => Math.ceil(s.length / 4);

/**
 * First line of a rendered packet and its JSON body, or null. The body is the single JSON line after the header lines
 * (a task packet has three, a decision packet two: see renderTaskPacket / renderDecisionPacket).
 */
function packetOf(m: ChatMessage | undefined): { kind: string; bytes: number; problems: string[] } | null {
  if (!m || m.role !== "user") return null;
  const head = /^(TASK PACKET|CRITICAL DECISION PACKET) \((fleet-task-v1|fleet-decision-v1)\)/.exec(m.content);
  if (!head) return null;
  const lines = m.content.split("\n");
  const at = lines.findIndex((l, i) => i > 0 && l.startsWith("{"));
  let body: unknown = null;
  try { body = JSON.parse(at < 0 ? "" : lines.slice(at).join("\n")); } catch { return { kind: head[2], bytes: Buffer.byteLength(m.content), problems: ["packet body is not JSON"] }; }
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
  route: { tier: string; model: string; taskClass: string; scope: string; source: string; promptCache: string }; thinking?: ThinkingBlock[]; blockOrder?: string[] }> {
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
  // R41.1: the doctrine the founder's runtime implements (absent = founder-v4, every pre-R41.1 runtime). It selects the
  // charter text and the v5 tool vocabulary only: never the tier, the price, a permission or any capability class.
  const doctrine = parseDoctrine(body.doctrine);
  if (!doctrine) throw new CognitionError(400, "FLEET_DOCTRINE_UNKNOWN", "unknown founder doctrine");
  // A request string is not proof: the founder's registered (attested) release must implement the doctrine's tools and
  // continuity. A mismatch is refused, never silently downgraded (it means the running code is not the pinned code).
  if (doctrine !== "founder-v4" && ports.runtimeDoctrines && !(await ports.runtimeDoctrines(agentId)).includes(doctrine)) {
    throw new CognitionError(409, "FLEET_DOCTRINE_INCOMPATIBLE", "this founder's attested runtime release does not implement that doctrine");
  }

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
  // 5. Provider-bound thinking stays with the model that produced it: it is handed back only to the model behind this
  //    founder's most recent conversational call (a T1 chore or a question-scoped escalation in between is a separate
  //    conversation and does not count), and never crosses to another model.
  const producer = typeof rs.conversationModel === "string" ? rs.conversationModel : rs.lastModel;
  if (producer !== candidate.model) messages = stripThinking(messages);

  // T1 is a single bounded chore with a small context: a compact routine charter, no toolbox, no tool loop.
  // Anything else is refused — never silently promoted to a higher tier.
  const routine = decision.tier === "T1";
  if (routine && messages.some((m) => m.role !== "user")) {
    throw new CognitionError(400, "FLEET_ROUTE_T1_SINGLE_TASK", "T1 is one bounded routine task: user material only, no tool loop");
  }
  // A question-scoped escalation answers; it does not act: the charter's rules and priors, no toolbox.
  const question = decision.scope === "question";
  const charter = charterFor(doctrine);
  const system = routine ? FOUNDER_ROUTINE_CHARTER : question ? charter : `${charter}\n${FOUNDER_ROUTED_ADDENDUM}`;
  // Reuse is evidenced inside an active tool loop on the SAME model: the request already carries an assistant turn and
  // this conversation's previous step ran on this model (a T3 action step inside a T2 loop is not reuse: it returns to T2).
  const cache = cachePolicy(decision, candidate, rs, { continuing: messages.some((m) => m.role === "assistant") && producer === candidate.model });
  const provider = providerFor(candidate, decision.effort, cache.mode);
  // Ordinary routed steps also get the cognition tools (delegate a routine chore, escalate one question); R24: the
  // experiment tools only while the owner has the pipeline on. One function builds this list and the capability signature.
  const tools = routine || question ? [] : founderStepTools(caps, true, doctrine);
  const maxTokens = candidate.maxOutputTokens;
  const promptText = JSON.stringify({ system, messages, tools: tools.map((t) => t.name) });
  const promptSha = sha(promptText);
  const estimateMicro = approxTokens(promptText) * candidate.prices.inputMicrocentsPerToken + maxTokens * candidate.prices.outputMicrocentsPerToken;
  const req = parseRouteRequest(body.route ?? { taskClass: "agent_step" });
  const snapshot = {
    tier: decision.tier, provider: candidate.provider, model: candidate.model, taskClass: decision.taskClass, ...(req.taskId ? { taskId: req.taskId } : {}),
    requestedTier: decision.requestedTier, escalationReason: decision.escalationReason, ...(req.escalation?.parentRequestId ? { parentRequestId: req.escalation.parentRequestId } : {}),
    source: decision.source, scope: decision.scope, minTier: decision.minTier, maxTier: decision.maxTier,
    ...(req.actionClass ? { actionClass: req.actionClass } : {}),
    thinking: candidate.thinking, effort: decision.effort ?? candidate.effort,
  };
  const turn = typeof body.conversationTurn === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.conversationTurn) ? body.conversationTurn : null;
  const auth = await ports.authorize(agentId, Math.max(1, Math.ceil(estimateMicro / 1_000_000)), snapshot, promptSha, turn);
  if (!auth.ok) {
    const code = String(auth.code);
    throw new CognitionError(code === "FLEET_COGNITION_BUSY" || code === "FLEET_COGNITION_RATE_LIMITED" ? 429 : code === "FLEET_COGNITION_DUPLICATE_FAILURE" ? 409 : 403, code,
      code === "FLEET_TREASURY_INSUFFICIENT" ? `the treasury cannot pay for this owner conversation turn (available ${auth.availableMinor ?? "?"}, needed ${auth.neededMinor ?? "?"})` : "inference not authorized");
  }
  const requestId = String(auth.requestId);
  const deadlineMs = Math.min(MAX_COGNITION_DEADLINE_MS, Math.max(1_000, opts.deadlineMs ?? DEFAULT_COGNITION_DEADLINE_MS));
  const started = now();
  const obs = { packetBytes: packet?.bytes ?? null, thinkingTokens: null as number | null, promptCache: cache.mode as string | null, cacheReason: cache.reason as string | null };

  let result: ChatResult | null = null;
  let failure: ProviderError | null = null;
  try {
    result = await provider.chat({ agentId, system, messages, tools, maxTokens, deadlineAt: started + deadlineMs });
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
    route: { tier: decision.tier, model: candidate.model, taskClass: decision.taskClass, scope: decision.scope, source: decision.source, promptCache: cache.mode },
    ...(result.thinking?.length ? { thinking: result.thinking, ...(result.blockOrder ? { blockOrder: result.blockOrder } : {}) } : {}),
  };
}

export { TASK_PACKET_VERSION, DECISION_PACKET_VERSION };

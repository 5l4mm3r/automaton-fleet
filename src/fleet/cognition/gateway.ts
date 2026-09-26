/**
 * FleetController inference gateway (Phase F.2): the only way a founder thinks.
 *
 *   founder ──POST /v1/cognition/infer (signed session)──▶ controller
 *     1. validate the founder's messages (no system role: the charter is ours)
 *     2. tools = the compiled founder toolbox ∩ this founder's capability manifest
 *     3. estimate cost → svc_cognition_authorize (switches, pause, limits, budget,
 *        cash, survival equity, prepaid credits; one call in flight)
 *     4. provider.chat (the provider credential never leaves the controller)
 *     5. svc_cognition_record: charge the founder's ledger, append the trusted log
 *        (model, tokens, cost, prompt/response digests, requested tool calls)
 */

import crypto from "crypto";
import { FOUNDER_CHARTER, FOUNDER_TOOLS, ProviderError, type ChatMessage, type ChatResult, type CognitionProvider, type ToolSpec } from "./types.js";
import type { CognitionRecord } from "../postgres/store.js";

export class CognitionError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryAfterS?: number) {
    super(message);
  }
}

/** Controller cognition timing (L2). The founder waits deadline + FOUNDER_WAIT_MARGIN_MS, so a reply can never be paid for and lost. */
export const DEFAULT_COGNITION_DEADLINE_MS = 120_000;
export const MAX_COGNITION_DEADLINE_MS = 240_000; // < the 5-minute in-flight stale window
export const FOUNDER_WAIT_MARGIN_MS = 30_000;

export interface CognitionPorts {
  capabilities(agentId: string, token: string): Promise<Record<string, unknown> & { ok: boolean }>;
  cognitionStatus(agentId: string, token: string): Promise<Record<string, unknown> & { ok: boolean }>;
  authorize(agentId: string, estimateCents: number): Promise<Record<string, unknown> & { ok: boolean }>;
  record(agentId: string, requestId: string, r: CognitionRecord): Promise<Record<string, unknown> & { ok: boolean }>;
}

const MAX_MESSAGES = 60;
const MAX_MESSAGE_CHARS = 16_000;
/** Fleet credential shapes (fa1 long-lived, fs1 session) and PEM private keys. */
export const SECRET_SHAPES: readonly RegExp[] = Object.freeze([
  /f[as]1\.[0-9A-HJKMNP-TV-Z]{26}\.[A-Za-z0-9_-]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]);

export function containsSecretShape(text: string): boolean {
  return SECRET_SHAPES.some((re) => re.test(text));
}

const sha = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const approxTokens = (s: string) => Math.ceil(s.length / 4);

export function validateMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MESSAGES) throw new CognitionError(400, "FLEET_BAD_REQUEST", `messages must be 1..${MAX_MESSAGES}`);
  return raw.map((m) => {
    const x = m as Record<string, unknown>;
    if (x.role !== "user" && x.role !== "assistant" && x.role !== "tool") throw new CognitionError(400, "FLEET_BAD_REQUEST", "role must be user, assistant or tool (the charter is the controller's)");
    if (typeof x.content !== "string" || x.content.length > MAX_MESSAGE_CHARS) throw new CognitionError(400, "FLEET_BAD_REQUEST", "content must be a bounded string");
    // Nothing credential-shaped is ever forwarded to a model provider.
    if (containsSecretShape(x.content) || (x.toolCalls !== undefined && containsSecretShape(JSON.stringify(x.toolCalls)))) {
      throw new CognitionError(422, "FLEET_COGNITION_SECRET_IN_PROMPT", "the conversation contains credential-shaped text and was not forwarded");
    }
    const out: ChatMessage = { role: x.role, content: x.content };
    if (x.role === "tool") out.toolCallId = typeof x.toolCallId === "string" ? x.toolCallId.slice(0, 64) : "unknown";
    if (x.role === "assistant" && Array.isArray(x.toolCalls)) {
      out.toolCalls = x.toolCalls.slice(0, 10).map((t: Record<string, unknown>, i: number) => ({
        id: typeof t.id === "string" ? t.id.slice(0, 64) : `call_${i}`,
        name: typeof t.name === "string" ? t.name.slice(0, 64) : "",
        arguments: t.arguments && typeof t.arguments === "object" && !Array.isArray(t.arguments) ? (t.arguments as Record<string, unknown>) : {},
      }));
    }
    return out;
  });
}

/** The tools advertised to this founder: compiled toolbox filtered by its granted capability classes. */
export function toolsFor(allowed: readonly string[]): ToolSpec[] {
  const set = new Set(allowed);
  return FOUNDER_TOOLS.filter((t) => set.has(t.capability));
}

export async function infer(
  ports: CognitionPorts,
  provider: CognitionProvider | null,
  agentId: string,
  token: string,
  body: Record<string, unknown>,
  opts: { deadlineMs?: number; now?: () => number } = {},
): Promise<{ content: string; toolCalls: unknown[]; usage: { inputTokens: number; outputTokens: number }; usageSource: string; chargedCents: number; requestId: string }> {
  const now = opts.now ?? Date.now;
  const messages = validateMessages(body.messages);
  const caps = await ports.capabilities(agentId, token);
  if (!caps.ok) throw new CognitionError(401, String(caps.code ?? "FLEET_AUTH_FAILED"), "capabilities refused");
  if (caps.origin !== "genesis_founder" && caps.origin !== "reseed_founder") throw new CognitionError(403, "FLEET_COGNITION_NOT_FOUNDER", "cognition is for founders");
  const status = await ports.cognitionStatus(agentId, token);
  if (!status.ok) throw new CognitionError(401, String(status.code ?? "FLEET_AUTH_FAILED"), "status refused");
  // The owner's switch first: while cognition is off nothing else is consulted.
  if (!status.policyEnabled || status.provider === "none") throw new CognitionError(403, "FLEET_COGNITION_DISABLED", "cognition is disabled by the owner");
  if (!provider) throw new CognitionError(409, "FLEET_COGNITION_UNAVAILABLE", "no inference provider is configured on this controller");
  if (status.provider !== provider.id) throw new CognitionError(409, "FLEET_COGNITION_PROVIDER_MISMATCH", "registry provider differs from the controller's");
  // L6: the model the owner enabled is the model that runs (and the one the trusted log names).
  if (status.model !== provider.model) throw new CognitionError(409, "FLEET_COGNITION_MODEL_MISMATCH", "registry model differs from the controller's");
  const tools = toolsFor(Array.isArray(caps.allowed) ? (caps.allowed as string[]) : []);
  const maxTokens = Number(status.maxOutputTokens) || 1024;
  const promptText = JSON.stringify({ system: FOUNDER_CHARTER, messages, tools: tools.map((t) => t.name) });
  const inTok = approxTokens(promptText);
  const estimateMicro = inTok * Number(status.inputMicrocentsPerToken ?? 0) + maxTokens * Number(status.outputMicrocentsPerToken ?? 0);
  const auth = await ports.authorize(agentId, Math.max(1, Math.ceil(estimateMicro / 1_000_000)));
  if (!auth.ok) throw new CognitionError(auth.code === "FLEET_COGNITION_BUSY" || auth.code === "FLEET_COGNITION_RATE_LIMITED" ? 429 : 403, String(auth.code), "inference not authorized");
  const requestId = String(auth.requestId);
  const deadlineMs = Math.min(MAX_COGNITION_DEADLINE_MS, Math.max(1_000, opts.deadlineMs ?? DEFAULT_COGNITION_DEADLINE_MS));
  const started = now();
  const promptSha = sha(promptText);

  // Exactly one record per authorization, whatever happens (L1): success, classified failure or an unexpected error.
  let result: ChatResult | null = null;
  let failure: ProviderError | null = null;
  try {
    result = await provider.chat({ agentId, system: FOUNDER_CHARTER, messages, tools, maxTokens, deadlineAt: started + deadlineMs });
  } catch (err) {
    // An unexpected error after authorization is treated as ambiguous: the bounded estimate is charged, nothing is delivered.
    failure = err instanceof ProviderError ? err : new ProviderError("PROVIDER_ERROR", { charge: "estimate", attempts: 1 });
  }
  const latencyMs = Math.max(0, Math.round(now() - started));
  if (!result || failure) {
    failure ??= new ProviderError("PROVIDER_ERROR", { charge: "estimate", attempts: 1 });
    const f = failure.info;
    const rec = await ports.record(agentId, requestId, {
      outcome: "error",
      inputTokens: f.usage?.inputTokens ?? 0,
      outputTokens: f.usage?.outputTokens ?? 0,
      promptSha256: promptSha,
      responseSha256: sha(""),
      toolCalls: [],
      errorCode: failure.code,
      usageSource: f.charge === "usage" ? "provider" : f.charge,
      attempts: f.attempts,
      providerStatus: f.status ?? null,
      responseModel: f.responseModel ?? null,
      latencyMs,
    });
    if (!rec.ok) throw new CognitionError(409, String(rec.code), "inference could not be recorded");
    if (failure.code === "PROVIDER_RATE_LIMITED") throw new CognitionError(429, "FLEET_COGNITION_PROVIDER_RATE_LIMITED", "the inference provider is rate limiting", f.retryAfterS ?? 60);
    if (failure.code === "PROVIDER_TIMEOUT") throw new CognitionError(504, "FLEET_COGNITION_PROVIDER_TIMEOUT", "the inference provider did not answer in time");
    if (failure.code === "PROVIDER_MALFORMED_RESPONSE") throw new CognitionError(502, "FLEET_COGNITION_PROVIDER_MALFORMED", "the inference provider returned an unusable response");
    throw new CognitionError(502, "FLEET_COGNITION_PROVIDER_ERROR", `the inference provider failed (${failure.code})`);
  }
  const loggedCalls = result.toolCalls.slice(0, 10).map((t) => ({ name: t.name, argsSha256: sha(JSON.stringify(t.arguments)) }));
  const rec = await ports.record(agentId, requestId, {
    outcome: "ok",
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    promptSha256: promptSha,
    responseSha256: sha(JSON.stringify({ content: result.content, toolCalls: result.toolCalls })),
    toolCalls: loggedCalls,
    errorCode: null,
    usageSource: result.usageSource,
    attempts: result.attempts,
    providerStatus: 200,
    responseModel: result.responseModel ?? null,
    latencyMs,
  });
  // Not recorded = not delivered: a response the fleet could not account for never reaches the founder.
  if (!rec.ok) throw new CognitionError(409, String(rec.code), "inference could not be recorded");
  return { content: result.content, toolCalls: result.toolCalls, usage: result.usage, usageSource: String(rec.usageSource ?? result.usageSource), chargedCents: Number(rec.chargedCents ?? 0), requestId };
}

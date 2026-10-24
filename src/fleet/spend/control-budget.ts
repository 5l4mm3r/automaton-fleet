/**
 * v96: Fleet Control's hard daily AI ceiling. Every paid Fleet Control call (spend review, lesson review, evidence
 * relevance) reserves its BOUNDED MAXIMUM cost before it is made and settles at its actual cost afterwards; the registry
 * checks the reservation atomically against the last 24 hours (svc_fleet_control_ai_reserve). The maximum: every UTF-8 byte
 * of the system prompt and messages counted as one input token (a token is never shorter than a byte) plus a framing
 * allowance, and the call's full output allowance (max_tokens bounds visible and thinking output), at the tier's prices;
 * prompt caching is off for these calls, so no cache price applies.
 */
import type { TierCandidate } from "../cognition/router.js";

export interface ControlBudgetPort {
  controlAiReserve(kind: "spend_review" | "knowledge_review" | "evidence_relevance" | "message_check", ref: string, maxUsdMicrocents: number): Promise<Record<string, unknown>>;
  controlAiSettle(reservationId: string, actualUsdMicrocents: number | null): Promise<Record<string, unknown>>;
}

/** Per-message framing tokens allowed on top of the content bytes (role markers and the like). */
export const FRAMING_TOKENS = 64;

export function maxCallUsdMicrocents(c: Pick<TierCandidate, "prices">, system: string, messages: string[], maxTokens: number): number {
  const inputBound = Buffer.byteLength(system, "utf8") + messages.reduce((n, m) => n + Buffer.byteLength(m, "utf8") + FRAMING_TOKENS, FRAMING_TOKENS);
  return Math.ceil(inputBound * c.prices.inputMicrocentsPerToken + maxTokens * c.prices.outputMicrocentsPerToken);
}

/** Reserve before the call. A refusal means no call is made. */
export async function reserveControlAi(port: ControlBudgetPort, kind: "spend_review" | "knowledge_review" | "evidence_relevance" | "message_check", ref: string, maxUsd: number):
  Promise<{ ok: true; reservationId: string } | { ok: false; reason: string }> {
  // Fail closed: an unreachable registry or a missing port is no room.
  const r: Record<string, unknown> = await Promise.resolve().then(() => port.controlAiReserve(kind, ref, maxUsd))
    .catch((e: unknown) => ({ ok: false, code: "FLEET_CONTROL_AI_BUDGET", reason: e instanceof Error ? e.message.slice(0, 160) : "unreachable" }));
  if (r.ok === true && typeof r.reservationId === "string") return { ok: true, reservationId: r.reservationId };
  return { ok: false, reason: `${String(r.code ?? "FLEET_CONTROL_AI_BUDGET")}: ${String(r.reason ?? "no room")}` };
}

/** Settle after the call (null: the cost is unknown and the maximum keeps counting). Never throws. */
export async function settleControlAi(port: ControlBudgetPort, reservationId: string, actualUsd: number | null): Promise<void> {
  await port.controlAiSettle(reservationId, actualUsd).catch(() => undefined);
}

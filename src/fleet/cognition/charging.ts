/**
 * The inference charge rule (v17, sub-cent accrual), mirrored from svc_cognition_record for the provider
 * probe's economic reconciliation and for tests (which cross-check it against the database). The database
 * remains the authority. All values are integer microcents (1¢ = 1,000,000 µ¢); no floating point.
 *
 *   cost µ¢     = in·p_in + out·p_out + cw·(p_cw ?? p_out) + cr·(p_cr ?? p_in)
 *   charged µ¢  = provider: min(estimate·10⁶, cost); estimate: estimate·10⁶; none: 0
 *   accrual     = unposted + charged → post floor(accrual/10⁶) whole cents, carry the remainder (< 1¢)
 */

import type { Usage } from "./types.js";

export interface Prices {
  inputMicrocentsPerToken: number;
  outputMicrocentsPerToken: number;
  cacheWriteMicrocentsPerToken?: number | null;
  cacheReadMicrocentsPerToken?: number | null;
}

export function costMicrocents(u: Usage, p: Prices): number {
  return (
    u.inputTokens * p.inputMicrocentsPerToken +
    u.outputTokens * p.outputMicrocentsPerToken +
    (u.cacheWriteTokens ?? 0) * (p.cacheWriteMicrocentsPerToken ?? p.outputMicrocentsPerToken) +
    (u.cacheReadTokens ?? 0) * (p.cacheReadMicrocentsPerToken ?? p.inputMicrocentsPerToken)
  );
}

export const MICROCENTS_PER_CENT = 1_000_000;

/** Exact microcents attributed to one call (never more than its reservation). */
export function chargedMicrocents(source: "provider" | "estimate" | "none", u: Usage, p: Prices, estimateCents: number): number {
  if (source === "none") return 0;
  if (source === "estimate") return estimateCents * MICROCENTS_PER_CENT;
  return Math.min(estimateCents * MICROCENTS_PER_CENT, costMicrocents(u, p));
}

/** Add a call's microcents to a founder's carried remainder: whole cents to post now, remainder to carry. */
export function accrue(unpostedMicrocents: number, chargedMicro: number): { postCents: number; unpostedMicrocents: number } {
  const total = unpostedMicrocents + chargedMicro;
  const postCents = Math.floor(total / MICROCENTS_PER_CENT);
  return { postCents, unpostedMicrocents: total - postCents * MICROCENTS_PER_CENT };
}

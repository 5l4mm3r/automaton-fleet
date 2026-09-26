/**
 * The v16 inference charge rule, mirrored from svc_cognition_record for the
 * provider probe's economic reconciliation and for tests (which cross-check it
 * against the database). The database remains the authority.
 *
 *   provider usage: min(estimate, ceil((in·p_in + out·p_out + cw·(p_cw ?? p_out) + cr·(p_cr ?? p_in)) / 1e6))
 *   estimate:       the authorized estimate
 *   none:           0
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

export function chargeCents(source: "provider" | "estimate" | "none", u: Usage, p: Prices, estimateCents: number): number {
  if (source === "none") return 0;
  if (source === "estimate") return estimateCents;
  return Math.min(estimateCents, Math.ceil(costMicrocents(u, p) / 1_000_000));
}

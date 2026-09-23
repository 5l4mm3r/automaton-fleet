/**
 * Wallet custody (Phase 5)
 *
 * Model: agent wallets are supervised by the controller. An agent never
 * receives an owner or treasury private key, and spending goes through a
 * spend REQUEST to the fleet service (api_request_spend), which checks that
 * the wallet is the caller's own custody wallet, that the agent is healthy
 * and not frozen/quarantined, and that the amount is within an approved,
 * current allocation or the daily limit. FleetAdmin can freeze any wallet.
 *
 * Execution: an approved request is executed only by a controller-side
 * signer, only when REAL_PAYMENTS_ENABLED=true AND a signer is configured.
 * Neither is true in this phase, so nothing is ever signed or sent.
 */

export interface SpendDecision {
  requestId: string;
  decision: "denied" | "approved_not_executed";
  amountCents: number;
  toAddress: string;
}

export interface ControllerSigner {
  /** Signs and broadcasts a transfer from the custody wallet. Never exposed to agents. */
  send(req: SpendDecision): Promise<{ txHash: string }>;
}

export type ExecutionResult = { executed: false; reason: string } | { executed: true; txHash: string };

export async function executeApprovedSpend(
  decision: SpendDecision,
  env: Record<string, string | undefined>,
  signer: ControllerSigner | null,
): Promise<ExecutionResult> {
  if (decision.decision !== "approved_not_executed") return { executed: false, reason: "request was denied" };
  if (env.REAL_PAYMENTS_ENABLED?.trim().toLowerCase() !== "true") return { executed: false, reason: "REAL_PAYMENTS_ENABLED=false" };
  if (!signer) return { executed: false, reason: "no controller custody signer is configured" };
  return { executed: true, txHash: (await signer.send(decision)).txHash };
}

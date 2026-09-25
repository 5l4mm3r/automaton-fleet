/**
 * Universal agent spend gate (Phase D3.1, pre-Phase-E).
 *
 * One fail-closed rule for every agent-controlled path that can cause real
 * monetary/credit expenditure or transfer value: while REAL_PAYMENTS_ENABLED
 * is not exactly "true", none of them may run. This is temporary protection
 * until the Phase E treasury/custody design replaces agent-held spending; it
 * does not model budgets or approvals.
 *
 * Enforced in two independent layers:
 *  1. Policy (tool level): `fleet.spend_gate` denies every tool in
 *     SPEND_TOOLS before it executes (PolicyEngine).
 *  2. Chokepoints (library level), so no alias, harness, heartbeat task or
 *     internal caller can bypass the policy layer:
 *       - x402 payment signing (x402Fetch; covers topup_credits, x402_fetch,
 *         register_domain payments, automatic bootstrap/sandbox top-ups);
 *       - Conway credit transfers (transfer_credits, fund_child, orchestrator
 *         child funding) and domain registration;
 *       - Conway sandbox creation for the agent runtime (billed compute);
 *       - ERC-8004 on-chain writes (gas: register, update URI, feedback).
 *
 * Not covered here (baseline operational metering, not a discretionary
 * spend path): the agent's own inference and its existing sandbox.
 * Residual (Phase E): an agent that holds its own wallet key and has a shell
 * can still sign outside this process; see docs/design/phase-d3-1-hardening.md.
 */

import { loadFleetConfig } from "./config.js";

export type SpendKind =
  | "x402_payment"
  | "credit_transfer"
  | "domain_purchase"
  | "sandbox_creation"
  | "onchain_transaction";

/** Agent tools that spend or transfer value (the policy layer). */
export const SPEND_TOOLS: ReadonlySet<string> = new Set([
  "topup_credits",
  "transfer_credits",
  "fund_child",
  "x402_fetch",
  "register_domain",
  "create_sandbox",
  "spawn_child",
  "register_erc8004",
  "give_feedback",
]);

export class RealSpendBlockedError extends Error {
  readonly code = "REAL_PAYMENTS_DISABLED";
  constructor(readonly kind: SpendKind) {
    super(`REAL_PAYMENTS_DISABLED: ${kind} is blocked by the fleet spend gate (REAL_PAYMENTS_ENABLED is not true)`);
    this.name = "RealSpendBlockedError";
  }
}

/** A gate decides whether one kind of real expenditure may proceed in this process. */
export interface SpendGate {
  allows(kind: SpendKind): boolean;
}

/** The agent-runtime gate: every kind requires REAL_PAYMENTS_ENABLED=true, read at call time. */
export const FLEET_SPEND_GATE: SpendGate = Object.freeze({
  allows: (_kind: SpendKind) => loadFleetConfig(process.env).realPaymentsEnabled === true,
});

/**
 * Owner/operator tooling (fleet:admin, owner-approved dry-run provisioning):
 * may create a sandbox the owner explicitly asked for, and nothing else.
 */
export const OWNER_PROVISIONING_GATE: SpendGate = Object.freeze({
  allows: (kind: SpendKind) => kind === "sandbox_creation",
});

/** Throw RealSpendBlockedError unless `gate` allows `kind` (default: the fleet gate). */
export function assertRealSpendAllowed(kind: SpendKind, gate: SpendGate = FLEET_SPEND_GATE): void {
  let ok = false;
  try {
    ok = gate.allows(kind) === true;
  } catch {
    ok = false; // a broken gate fails closed
  }
  if (!ok) throw new RealSpendBlockedError(kind);
}

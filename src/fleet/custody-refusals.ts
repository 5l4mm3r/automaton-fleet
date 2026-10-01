/**
 * F2-A (schema v27): FleetController's custody refusal vocabulary for own-capital spend.
 *
 * FleetController is the custodian of a founder's own capital, not its risk manager: it refuses an order only for a
 * custody or infrastructure reason, and every refusal names that reason precisely. None of them is a judgement of the
 * founder's decision, and none creates anything for the owner (or anyone) to decide — there is no owner spend route.
 * The registry maps each FLEET_* code to its category (fleet_custody_refusal, migrations-phase27.ts, built from this
 * table); the founder runtime uses the same table to frame a refusal.
 */

export type CustodyCategory =
  | "PROTECTED_CAPITAL" | "TAX_RESERVE" | "INSUFFICIENT_OWN_CAPITAL" | "HOLD" | "FROZEN" | "AGENT_NOT_ACTIVE"
  | "INVALID_DESTINATION" | "IDEMPOTENCY_CONFLICT" | "INFRASTRUCTURE_CIRCUIT_BREAKER" | "PAYMENT_RAIL_UNAVAILABLE";

/** FLEET_* refusal code → custody category (the registry emits exactly these). */
export const CUSTODY_REFUSAL_CODES: ReadonlyArray<readonly [string, CustodyCategory]> = Object.freeze([
  ["FLEET_PROTECTED_CAPITAL", "PROTECTED_CAPITAL"],
  ["FLEET_TAX_RESERVE", "TAX_RESERVE"],
  ["FLEET_INSUFFICIENT_ALLOCATION", "INSUFFICIENT_OWN_CAPITAL"],
  ["FLEET_AGENT_HELD", "HOLD"],
  ["FLEET_SPENDING_FROZEN", "FROZEN"],
  ["FLEET_AGENT_NOT_ACTIVE", "AGENT_NOT_ACTIVE"],
  ["FLEET_DESTINATION_NOT_ALLOWED", "INVALID_DESTINATION"],
  ["FLEET_DESTINATION_NOT_ACTIVE", "INVALID_DESTINATION"],
  ["FLEET_IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_CONFLICT"],
  ["FLEET_INFRASTRUCTURE_CIRCUIT_BREAKER", "INFRASTRUCTURE_CIRCUIT_BREAKER"],
  ["FLEET_CUSTODY_EXECUTION_DISABLED", "PAYMENT_RAIL_UNAVAILABLE"],
] as const);

const BY_CODE: ReadonlyMap<string, CustodyCategory> = new Map(CUSTODY_REFUSAL_CODES);

const WHY: Readonly<Record<CustodyCategory, string>> = Object.freeze({
  PROTECTED_CAPITAL: "the order would consume protected capital (borrowed principal or approved obligations), which is never spendable",
  TAX_RESERVE: "the order would consume a tax reserve, which is never spendable",
  INSUFFICIENT_OWN_CAPITAL: "the order exceeds your unreserved own cash",
  HOLD: "your spending is under an operator hold (an incident control)",
  FROZEN: "your spending is frozen (an incident control)",
  AGENT_NOT_ACTIVE: "you are not active",
  INVALID_DESTINATION: "the destination is not an active payee you may pay",
  IDEMPOTENCY_CONFLICT: "that idempotency key was already used for a different order",
  INFRASTRUCTURE_CIRCUIT_BREAKER: "an infrastructure failsafe against anomalies (runaway loops, a compromised provider) tripped — "
    + "it is not a spending allowance, a target or a judgement of your decision",
  PAYMENT_RAIL_UNAVAILABLE: "the payment rail is unavailable",
});

/** The custody category of a FLEET_* code (null = not a custody refusal). */
export function custodyCategory(code: unknown): CustodyCategory | null {
  return typeof code === "string" ? BY_CODE.get(code) ?? null : null;
}

/**
 * How a custody refusal reads to the founder: the precise reason, and that it is final for this order and routes nowhere.
 * Never "ask the owner": the founder's own decision stands and the next move is the founder's.
 */
export function custodyRefusalText(code: string, category: CustodyCategory): string {
  return `CUSTODY REFUSAL ${category} (${code}): ${WHY[category]}. This is FleetController's custody, not a judgement of your decision; `
    + "nothing is queued for anyone and no one else decides it. Your next move is yours: size within what custody allows, "
    + "use another route, or review the decision on new evidence.";
}

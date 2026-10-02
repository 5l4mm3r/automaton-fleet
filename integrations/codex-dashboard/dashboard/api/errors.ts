/**
 * Structured Fleet errors for the owner dashboard. The gateway answers with codes (FLEET_*) and, for refused
 * operations, a short reason written by FleetController itself. Provider / server internals never reach the browser.
 */

export type ErrorCategory =
  | "unauthenticated" | "session_expired" | "stepup_required" | "stepup_cancelled" | "forbidden" | "locked" | "rate_limited"
  | "bad_request" | "conflict" | "insufficient_funds" | "capability_not_configured" | "agent_state" | "replication_blocked"
  | "birth_blocked" | "not_found" | "acknowledge_required" | "outcome_unknown" | "unavailable" | "unsupported" | "failed";

export class FleetApiError extends Error {
  constructor(
    readonly code: string,
    /** A FleetController-written reason (safe to show); never a provider or server error text. */
    readonly reason?: string,
    readonly status?: number,
  ) {
    super(reason ? `${code}: ${reason}` : code);
    this.name = "FleetApiError";
  }
  get category(): ErrorCategory {
    return categorize(this.code);
  }
}

const MAP: Array<[RegExp, ErrorCategory]> = [
  [/^FLEET_SESSION_INVALID$/, "session_expired"],
  [/^FLEET_UNAUTHENTICATED$/, "unauthenticated"],
  [/^FLEET_STEPUP_REQUIRED$/, "stepup_required"],
  [/^FLEET_STEPUP_CANCELLED$/, "stepup_cancelled"],
  [/^FLEET_(PASSKEY_INVALID|TOTP_INVALID|ENROLLMENT_INVALID|CSRF|ORIGIN|SELF_APPROVAL|APPROVAL_REQUIRED|FORBIDDEN)$/, "forbidden"],
  [/^FLEET_ADMIN_LOCKED$/, "locked"],
  [/^FLEET_RATE_LIMITED$/, "rate_limited"],
  [/^FLEET_(INSUFFICIENT_FUNDS|TREASURY_INSUFFICIENT|PHONE_FUNDS)$/, "insufficient_funds"],
  [/^FLEET_(CAPABILITY_NOT_CONFIGURED|NO_MAIL_PROVIDER|NO_SMS_PROVIDER)$/, "capability_not_configured"],
  [/^FLEET_(AGENT_DEAD|AGENT_HELD|AGENT_NOT_LIVING|DEAD|HELD)$/, "agent_state"],
  [/^FLEET_(REPLICATION_[A-Z_]+|REPRODUCTION_DISABLED)$/, "replication_blocked"],
  [/^FLEET_(CAP_EXCEEDED|GENESIS_[A-Z_]+|BIRTH_[A-Z_]+)$/, "birth_blocked"],
  [/^FLEET_NOT_FOUND$/, "not_found"],
  [/^FLEET_ACKNOWLEDGE_REQUIRED$/, "acknowledge_required"],
  [/^FLEET_(INVALID_STATE|IDEMPOTENCY_CONFLICT|STALE)$/, "conflict"],
  [/^FLEET_(BAD_REQUEST|UNKNOWN_OP|CONTENT_TYPE|METHOD)$/, "bad_request"],
  [/^FLEET_OUTCOME_UNKNOWN$/, "outcome_unknown"],
  [/^FLEET_(UNAVAILABLE|DASHBOARD_ERROR|BAD_RESPONSE|NETWORK)$/, "unavailable"],
  [/^FLEET_UNSUPPORTED_IN_LIVE$/, "unsupported"],
];

export function categorize(code: string): ErrorCategory {
  for (const [re, c] of MAP) if (re.test(code)) return c;
  return "failed";
}

/** A short owner-facing sentence per category (the dashboard may phrase its own; the code stays visible). */
export const CATEGORY_TEXT: Record<ErrorCategory, string> = {
  unauthenticated: "Sign in to control the Fleet.",
  session_expired: "Your session ended. Sign in again.",
  stepup_required: "This action needs a fresh passkey confirmation.",
  stepup_cancelled: "Passkey confirmation was cancelled; nothing was done.",
  forbidden: "Refused by the Fleet's security checks.",
  locked: "Sign-in is locked after repeated failures. Wait, then try again.",
  rate_limited: "Too many requests. Wait a moment.",
  bad_request: "The request was not valid.",
  conflict: "The Fleet's state changed; refresh and review.",
  insufficient_funds: "Not enough real funds for this.",
  capability_not_configured: "Not configured for this Fleet (a deliberate state, not a failure).",
  agent_state: "The agent's state does not allow this.",
  replication_blocked: "Replication is blocked by policy or switches.",
  birth_blocked: "A birth is not possible now.",
  not_found: "Not found.",
  acknowledge_required: "Above the advised safe amount: confirm you acknowledge the risk.",
  outcome_unknown: "The connection failed mid-operation. The Fleet was re-read; check the result before trying again.",
  unavailable: "The Fleet is unreachable. Showing nothing rather than stale or fictional data.",
  unsupported: "Not available in LIVE mode.",
  failed: "The operation failed.",
};

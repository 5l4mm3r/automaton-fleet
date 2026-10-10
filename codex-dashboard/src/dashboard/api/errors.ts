/**
 * Structured Fleet errors for the owner dashboard. The gateway answers with codes (FLEET_*) and, for refused
 * operations, a short reason written by FleetController itself. Provider / server internals never reach the browser.
 */

export type ErrorCategory =
  | "unauthenticated" | "session_expired" | "stepup_required" | "stepup_cancelled" | "forbidden" | "locked" | "rate_limited"
  | "bad_request" | "conflict" | "insufficient_funds" | "capability_not_configured" | "agent_state" | "replication_blocked"
  | "birth_blocked" | "not_found" | "acknowledge_required" | "outcome_unknown" | "unavailable" | "unsupported" | "failed"
  | "tab_unverified" | "login_invalid" | "password_weak" | "lockout_prevented";

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
  [/^FLEET_TAB_UNVERIFIED$/, "tab_unverified"],
  [/^FLEET_LOGIN_INVALID$/, "login_invalid"],
  [/^FLEET_PASSWORD_WEAK$/, "password_weak"],
  [/^FLEET_(LAST_SIGN_IN_METHOD|LOCKOUT_PREVENTED|LAST_PASSKEY)$/, "lockout_prevented"],
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
  [/^FLEET_(INVALID_STATE|IDEMPOTENCY_CONFLICT|STALE|PASSKEY_EXISTS)$/, "conflict"],
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
  stepup_required: "This action needs a fresh confirmation (passkey, or password and authenticator code).",
  stepup_cancelled: "Confirmation was cancelled; nothing was done.",
  forbidden: "This was blocked by a security check. Sign in again and retry; if it keeps happening, it may not be allowed.",
  locked: "Sign-in is locked after repeated failures. Wait, then try again.",
  rate_limited: "Too many requests. Wait a moment.",
  bad_request: "Some details were not accepted. Check the highlighted fields and try again.",
  conflict: "Something changed while you were working. Refresh the page and check before trying again.",
  insufficient_funds: "Not enough real funds for this.",
  capability_not_configured: "This feature has not been set up yet.",
  agent_state: "The agent's state does not allow this.",
  replication_blocked: "Replication is blocked by policy or switches.",
  birth_blocked: "A birth is not possible now.",
  not_found: "That item could not be found. It may have been removed.",
  acknowledge_required: "Above the advised safe amount: confirm you acknowledge the risk.",
  outcome_unknown: "The connection failed mid-operation. The Fleet was re-read; check the result before trying again.",
  unavailable: "The Fleet is unreachable. Showing nothing rather than stale or fictional data.",
  unsupported: "This isn’t available on the live Fleet.",
  failed: "That didn’t work. Nothing was changed.",
  login_invalid: "Sign-in details were not accepted. Check the password and the current authenticator code.",
  password_weak: "Choose a longer password.",
  lockout_prevented: "Refused: this would leave you without a way to sign in.",
  tab_unverified: "This browser tab is not verified for changes (it was opened after you signed in elsewhere). Nothing was done. Use “Verify this tab” (passkey or password, with your authenticator code) to make changes here; reading is unaffected.",
};

/**
 * Messages for specific codes where the category alone would be vague (what happened, then what to do). Checked
 * before the category text.
 */
export const CODE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  FLEET_CUSTODY_KEY_UNAVAILABLE: "The secure payments service is not ready to accept keys yet. Nothing was uploaded. Try again in a minute; if it persists, the payments service needs attention.",
  FLEET_OWNER_VAULT_UNAVAILABLE: "The secure identity service is not ready to accept documents yet. Nothing was uploaded.",
  FLEET_NO_RECEIVING_RAIL: "PayPal is not ready to receive payments yet. Finish the PayPal checks first.",
  FLEET_RAIL_NOT_READY: "This payment account has not passed its checks yet, so it cannot be switched on.",
  FLEET_CONFLICT: "That name is already in use. Choose a different one.",
  FLEET_INVALID_STATE: "This cannot be done in the current state. Refresh the page and check before trying again.",
  FLEET_STEPUP_REQUIRED: "Please confirm it’s you (passkey, or password and authenticator code) to continue.",
});

/** The owner-facing sentence for an error: the specific message or the category's, the Fleet's reason, then the code. */
export function describeError(e: unknown, fallback = "Something went wrong. Nothing was changed."): string {
  if (!(e instanceof FleetApiError)) return e instanceof Error && e.message ? e.message : fallback;
  const head = CODE_TEXT[e.code] ?? CATEGORY_TEXT[e.category];
  const reason = e.reason && !CODE_TEXT[e.code] ? ` ${e.reason.replace(/^./, (c) => c.toUpperCase()).replace(/([^.!?])$/, "$1.")}` : "";
  return `${head}${reason} (Error code: ${e.code.replace(/^FLEET_/, "")})`;
}

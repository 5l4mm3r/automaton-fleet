/**
 * Claude bridge (Phase D) — typed, fail-closed errors.
 *
 * Messages are operator-facing and never contain key material, signatures,
 * nonces or DSNs. Every failure path in the bridge ends in one of these codes;
 * there is no fallback to another transport or credential.
 */

export type BridgeErrorCode =
  // local configuration / key
  | "CONFIG_INVALID"
  | "KEY_INVALID"
  | "KEY_MISMATCH"
  | "KEY_EXPIRED"
  | "IDENTITY_MISMATCH"
  | "UNSUPPORTED_REQUEST"
  // transport
  | "TUNNEL_FAILED"
  | "TUNNEL_TIMEOUT"
  | "TUNNEL_AUTH_FAILED"
  | "TUNNEL_PORT_IN_USE"
  | "TUNNEL_NOT_OWNED"
  | "TUNNEL_NOT_OPERATOR_API"
  | "HOST_KEY_MISMATCH"
  // Operator API answers (FLEET_OP_* mapped 1:1)
  | "API_DISABLED"
  | "API_NOT_READY"
  | "AUDIT_FULL"
  | "AUTH_FAILED"
  | "CLOCK_SKEW"
  | "REPLAYED"
  | "SCOPE_DENIED"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "RATE_LIMITED"
  | "SERVER_ERROR"
  // response / network
  | "MALFORMED_RESPONSE"
  | "TIMEOUT"
  | "NETWORK";

export class BridgeError extends Error {
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
    /** Operator API request id, when the server returned one. */
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

/** FLEET_OP_* code -> bridge code and the HTTP status the server must use with it. */
export const OP_CODE_MAP: Readonly<Record<string, { code: BridgeErrorCode; status: number; hint: string }>> = Object.freeze({
  FLEET_OP_BAD_REQUEST: { code: "BAD_REQUEST", status: 400, hint: "the request was rejected as malformed" },
  FLEET_OP_NONCANONICAL: { code: "BAD_REQUEST", status: 400, hint: "the request target was not canonical" },
  FLEET_OP_BAD_PARAM: { code: "BAD_REQUEST", status: 400, hint: "a query parameter was rejected" },
  FLEET_OP_STALE: { code: "CLOCK_SKEW", status: 401, hint: "request timestamp outside ±30 s; check this host's clock" },
  FLEET_OP_AUTH_FAILED: {
    code: "AUTH_FAILED",
    status: 401,
    hint: "signature not accepted (unknown, revoked or expired key or principal, or wrong key)",
  },
  FLEET_OP_SCOPE_DENIED: { code: "SCOPE_DENIED", status: 403, hint: "this principal lacks the scope for that route" },
  FLEET_OP_NOT_FOUND: { code: "NOT_FOUND", status: 404, hint: "no such route or object" },
  FLEET_OP_REPLAYED: { code: "REPLAYED", status: 409, hint: "nonce already used; never resend a signed request" },
  FLEET_OP_RATE_LIMITED: { code: "RATE_LIMITED", status: 429, hint: "rate limited; retry later" },
  FLEET_OP_INTERNAL: { code: "SERVER_ERROR", status: 500, hint: "Operator API internal error" },
  FLEET_OP_DISABLED: { code: "API_DISABLED", status: 503, hint: "the Operator API kill switch is off" },
  FLEET_OP_AUDIT_FULL: { code: "AUDIT_FULL", status: 503, hint: "the operator request audit is full; archival required" },
});

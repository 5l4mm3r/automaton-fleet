/**
 * The v38 gateway contract (src/fleet/dashboard/server.ts). Same origin, JSON, cookie session; the CSRF token lives in
 * sessionStorage for the tab only (never localStorage, never a cookie). Sensitive operations take a fresh passkey
 * step-up bound to the operation and the EXACT args string, which is why args are serialised once and reused.
 */
import { passkeyGet } from "./webauthn";

export const SENSITIVE_OPS = new Set([
  "reveal_request", "owner_vault_upload", "owner_identity_consent_set", "owner_identity_consent_revoke", "owner_identity_class_set",
  "agent_transfer", "wallet_transfer", "agent_fund", "owner_withdrawal", "agent_kill", "birth", "reseed", "estate_assign", "estate_release",
  "replication_policy", "mission_policy", "risk_policy", "notification_policy", "genesis_capital", "passkey_revoke", "totp_reset", "session_revoke_all",
  "provider_credits_record",
]);

export class ApiError extends Error {
  constructor(readonly code: string, readonly reason?: string, readonly status?: number) {
    super(reason ? `${code}: ${reason}` : code);
  }
}

const CSRF_KEY = "fleet_csrf";
export const csrf = {
  get: (): string | null => { try { return sessionStorage.getItem(CSRF_KEY); } catch { return null; } },
  set: (v: string) => { try { sessionStorage.setItem(CSRF_KEY, v); } catch { /* private mode: in-memory only */ } },
  clear: () => { try { sessionStorage.removeItem(CSRF_KEY); } catch { /* ignore */ } },
};

let onSignedOut: () => void = () => {};
export function setSignedOutHandler(fn: () => void) { onSignedOut = fn; }

async function parse(r: Response): Promise<Record<string, any>> {
  const j = await r.json().catch(() => ({ ok: false, code: "FLEET_BAD_RESPONSE" }));
  if (r.status === 401) onSignedOut();
  return j;
}

export async function post(path: string, body: unknown): Promise<Record<string, any>> {
  const t = csrf.get();
  const r = await fetch(path, { method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json", ...(t ? { "X-CSRF": t } : {}) }, body: JSON.stringify(body ?? {}) });
  return parse(r);
}

export async function read<T = any>(op: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch(`/api/read?op=${encodeURIComponent(op)}&args=${encodeURIComponent(JSON.stringify(args))}`, { credentials: "same-origin", cache: "no-store" });
  const j = await parse(r);
  if (!j.ok) throw new ApiError(j.code ?? "FLEET_ERROR", j.reason, r.status);
  return j.result as T;
}

/** A state change; sensitive operations prompt for a fresh passkey (step-up) first. */
export async function call<T = any>(op: string, args: Record<string, unknown> = {}): Promise<T> {
  const a = JSON.stringify(args);
  let stepup: string | undefined;
  if (SENSITIVE_OPS.has(op)) {
    const o = await post("/api/stepup/options", { op, args: a });
    if (!o.ok) throw new ApiError(o.code);
    const v = await post("/api/stepup/verify", { op, args: a, response: await passkeyGet(o.options) });
    if (!v.ok) throw new ApiError(v.code);
    stepup = v.stepup;
  }
  const r = await post("/api/call", { op, args: a, stepup });
  if (!r.ok) throw new ApiError(r.code ?? "FLEET_ERROR", r.reason);
  return r.result as T;
}

/**
 * Real owner authentication (v38): passkey (WebAuthn, user verification required) → TOTP → a full session (HttpOnly
 * cookie, 30 min idle / 12 h absolute) + a per-tab CSRF token. No password, no demo codes: the simulation's training
 * sign-in must never be wired to this module.
 *
 * First access: the owner runs `fleet:admin hub-dashboard-enroll <origin>` on the Fleet host, which prints a one-time
 * link `<origin>/login/#enroll=<token>` (15 minutes). The dashboard reads the token from the URL fragment (never sent to
 * any server log), registers the passkey, shows the TOTP secret ONCE, and confirms a code.
 */
import { FleetApiError } from "./errors";
import type { GatewayClient } from "./client";
import type { AuthState } from "./types";

export class LiveAuth {
  constructor(private readonly c: GatewayClient) {}

  async state(): Promise<AuthState> {
    const { status, json } = await this.c.getJson("/api/auth/state");
    if (!json.ok) throw new FleetApiError(json.code ?? "FLEET_UNAVAILABLE", undefined, status);
    return { enrolled: Boolean(json.enrolled), locked: Boolean(json.locked), session: json.session === "full" ? "full" : "none" };
  }

  /** The one-time enrollment token from `location.hash` (#enroll=…), or null. */
  static enrollTokenFromHash(hash: string): string | null {
    const m = /(?:^#|&)enroll=([A-Za-z0-9_-]{20,200})/.exec(hash);
    return m ? m[1] : null;
  }

  /** Register a passkey with a one-time enrollment token. First enrollment returns the TOTP secret to show ONCE. */
  async enroll(token: string, name = "passkey"): Promise<{ next: "totp" | "login"; totpSecret?: string; otpauth?: string }> {
    const o = await this.c.post("/api/auth/enroll/options", { token });
    if (!o.json.ok) throw new FleetApiError(o.json.code ?? "FLEET_ENROLLMENT_INVALID", undefined, o.status);
    const response = await this.c.webauthn.create(o.json.options);
    const v = await this.c.post("/api/auth/enroll/verify", { token, response, name });
    if (!v.json.ok) throw new FleetApiError(v.json.code ?? "FLEET_PASSKEY_INVALID", undefined, v.status);
    return { next: v.json.next, totpSecret: v.json.totpSecret, otpauth: v.json.otpauth };
  }

  /** Confirm the authenticator app after the first enrollment. */
  async confirmTotp(code: string): Promise<void> {
    const r = await this.c.post("/api/auth/enroll/totp", { code });
    if (!r.json.ok) throw new FleetApiError(r.json.code ?? "FLEET_TOTP_INVALID", undefined, r.status);
  }

  /** Step 1: passkey. Leaves a short partial session that only the TOTP step can complete. */
  async loginPasskey(): Promise<void> {
    const o = await this.c.post("/api/auth/login/options", {});
    if (!o.json.ok) throw new FleetApiError(o.json.code ?? "FLEET_UNAVAILABLE", undefined, o.status);
    const response = await this.c.webauthn.get(o.json.options);
    const v = await this.c.post("/api/auth/login/verify", { response });
    if (!v.json.ok) throw new FleetApiError(v.json.code ?? "FLEET_PASSKEY_INVALID", undefined, v.status);
    this.c.adoptToken(String(v.json.csrf)); // this tab's token; other open tabs adopt it (the session changed)
  }

  /** Step 2: TOTP. Completes the session. */
  async loginTotp(code: string): Promise<void> {
    const r = await this.c.post("/api/auth/login/totp", { code });
    if (!r.json.ok) throw new FleetApiError(r.json.code ?? "FLEET_TOTP_INVALID", undefined, r.status);
  }

  async logout(): Promise<void> {
    try { await this.c.post("/api/auth/logout", {}); } finally { this.c.csrf.clear(); }
  }
}

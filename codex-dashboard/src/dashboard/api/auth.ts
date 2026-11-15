/**
 * Real owner authentication: two routes to the same full session (HttpOnly cookie, 30 min idle / 12 h absolute) + a
 * per-tab CSRF token —
 *   passkey (WebAuthn, user verification required) → TOTP   (v38)
 *   password + TOTP, in one request                          (v43: owner access never depends on one browser's passkey)
 * No demo codes: the simulation's training sign-in must never be wired to this module.
 *
 * First access / recovery: the owner runs `fleet:admin hub-dashboard-enroll <origin>` on the Fleet host, which prints a
 * one-time link `<origin>/login/#enroll=<token>` (15 minutes). The dashboard reads the token from the URL fragment (never
 * sent to any server log) and registers a passkey or sets the password with it; with no authenticator yet, it shows the
 * TOTP secret ONCE and confirms a code.
 *
 * Recovery from the sign-in page (v82; two factors each; never a session — the normal sign-in follows):
 *   forgot password      authenticator code + one recovery code → a new password;
 *   lost authenticator   password (or a passkey) + one recovery code → a new authenticator, confirmed with a code from it.
 * Recovery codes are issued in Security (a fresh confirmation first) and shown once.
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

  /** Recovery / first access without a passkey: set the password with the one-time enrollment token. */
  async enrollPassword(token: string, password: string): Promise<{ next: "totp" | "login"; totpSecret?: string; otpauth?: string }> {
    const v = await this.c.post("/api/auth/enroll/password", { token, password });
    if (!v.json.ok) throw new FleetApiError(v.json.code ?? "FLEET_ENROLLMENT_INVALID", v.json.reason, v.status);
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

  /** The password route: password AND authenticator code together; any wrong factor is one generic refusal. */
  async loginPassword(password: string, code: string): Promise<void> {
    const r = await this.c.post("/api/auth/login/password", { password, code });
    if (!r.json.ok) throw new FleetApiError(r.json.code ?? "FLEET_LOGIN_INVALID", undefined, r.status);
    this.c.adoptToken(String(r.json.csrf));
  }

  /** Set or change the password from a full session: a fresh step-up first (passkey, or the current password + code). */
  async setPassword(password: string): Promise<void> {
    const stepup = await this.c.stepUp("password_set", "{}");
    const r = await this.c.write("/api/account/password", { password, stepup });
    if (!r.json.ok) throw new FleetApiError(r.json.code ?? "FLEET_OPERATION_FAILED", r.json.reason, r.status);
  }

  /** Register another passkey on this device from a full session: a fresh step-up, then the browser creates it. */
  async addPasskey(name: string): Promise<void> {
    const stepup = await this.c.stepUp("passkey_add", "{}");
    const o = await this.c.write("/api/passkey/options", {});
    if (!o.json.ok) throw new FleetApiError(o.json.code ?? "FLEET_UNAVAILABLE", undefined, o.status);
    let response: unknown;
    try { response = await this.c.webauthn.create(o.json.options); } catch { throw new FleetApiError("FLEET_STEPUP_CANCELLED"); }
    const v = await this.c.write("/api/passkey/verify", { response, name, stepup });
    if (!v.json.ok) throw new FleetApiError(v.json.code ?? "FLEET_PASSKEY_INVALID", v.json.reason, v.status);
  }

  /** Step 2: TOTP. Completes the session. */
  async loginTotp(code: string): Promise<void> {
    const r = await this.c.post("/api/auth/login/totp", { code });
    if (!r.json.ok) throw new FleetApiError(r.json.code ?? "FLEET_TOTP_INVALID", undefined, r.status);
  }

  /** Forgot password: a current authenticator code and one unused recovery code set a new password (every session ends). */
  async recoverPassword(code: string, recoveryCode: string, password: string): Promise<{ codesLeft: number | null }> {
    const r = await this.c.post("/api/auth/recover/password", { code, recoveryCode, password });
    if (!r.json.ok) throw new FleetApiError(r.json.code ?? "FLEET_RECOVERY_INVALID", r.json.reason, r.status);
    this.c.csrf.clear();
    return { codesLeft: typeof r.json.codesLeft === "number" ? r.json.codesLeft : null };
  }

  /**
   * Lost authenticator, step 1: the password (or this device's passkey, when `password` is null) and one unused recovery
   * code. Returns the NEW authenticator's secret, shown once, and a ticket for step 2.
   */
  async recoverAuthenticator(recoveryCode: string, password: string | null): Promise<{ ticket: string; totpSecret: string; otpauth: string; codesLeft: number | null }> {
    let response: unknown = undefined;
    if (password === null) {
      const o = await this.c.post("/api/auth/recover/options", {});
      if (!o.json.ok) throw new FleetApiError(o.json.code ?? "FLEET_UNAVAILABLE", undefined, o.status);
      response = await this.c.webauthn.get(o.json.options);
    }
    const r = await this.c.post("/api/auth/recover/authenticator", password === null ? { recoveryCode, response } : { recoveryCode, password });
    if (!r.json.ok) throw new FleetApiError(r.json.code ?? "FLEET_RECOVERY_INVALID", undefined, r.status);
    return { ticket: String(r.json.ticket), totpSecret: String(r.json.totpSecret), otpauth: String(r.json.otpauth), codesLeft: typeof r.json.codesLeft === "number" ? r.json.codesLeft : null };
  }

  /** Lost authenticator, step 2: a code from the NEW authenticator replaces the old one (every session ends). */
  async confirmRecoveredAuthenticator(ticket: string, code: string): Promise<void> {
    const r = await this.c.post("/api/auth/recover/authenticator/confirm", { ticket, code });
    if (!r.json.ok) throw new FleetApiError(r.json.code ?? "FLEET_RECOVERY_INVALID", undefined, r.status);
    this.c.csrf.clear();
  }

  /** How many unused recovery codes are left (never the codes themselves). */
  async recoveryState(): Promise<{ remaining: number; issuedAt: string | null; lastUsedAt: string | null }> {
    const { status, json } = await this.c.getJson("/api/account/recovery");
    if (!json.ok) throw new FleetApiError(json.code ?? "FLEET_SESSION_INVALID", undefined, status);
    return { remaining: Number(json.remaining ?? 0), issuedAt: json.issuedAt ?? null, lastUsedAt: json.lastUsedAt ?? null };
  }

  /** A new set of recovery codes (a fresh confirmation first): shown ONCE; earlier unused codes stop working. */
  async issueRecoveryCodes(): Promise<string[]> {
    const stepup = await this.c.stepUp("recovery_codes_issue", "{}");
    const r = await this.c.write("/api/account/recovery-codes", { stepup });
    if (!r.json.ok) throw new FleetApiError(r.json.code ?? "FLEET_OPERATION_FAILED", r.json.reason, r.status);
    return Array.isArray(r.json.codes) ? r.json.codes.map(String) : [];
  }

  async logout(): Promise<void> {
    try { await this.c.post("/api/auth/logout", {}); } finally { this.c.csrf.clear(); }
  }
}

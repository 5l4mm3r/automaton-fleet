/**
 * Admin dashboard database gateway (schema v38): the restricted login fleet_dashboard_login can call only dash_* — the
 * authentication protocol and the single audited Admin gateway (dash_call). No owner credential, no table privilege.
 */
import pg from "pg";
import type { Pool } from "pg";
import { quoteIdent } from "../postgres/migrations.js";

export type DashResult = { ok: true; result?: unknown; [k: string]: unknown } | { ok: false; code: string; reason?: string; [k: string]: unknown };

export interface DashboardGatewayPort {
  ping(): Promise<{ schemaVersion: number | null }>;
  authState(): Promise<{ passkeys: Array<{ id: string; transports: string[] }>; totpConfigured: boolean; locked: boolean }>;
  log(event: string, ok: boolean, code: string | null, ip: string, detail?: Record<string, unknown>): Promise<void>;
  challengeNew(sha: string, purpose: string, sessionSha: string | null, op: string | null, argsSha: string | null): Promise<void>;
  challengeUse(sha: string, purpose: string, sessionSha: string | null, op: string | null, argsSha: string | null): Promise<boolean>;
  enrollValid(tokenSha: string): Promise<boolean>;
  passkeyAdd(tokenSha: string | null, sessionSha: string | null, stepupSha: string | null, id: string, publicKey: Buffer, count: number, transports: string[],
    name: string, ip: string): Promise<DashResult>;
  passkeyGet(id: string): Promise<{ id: string; publicKeyB64: string; counter: number; transports: string[] } | null>;
  passkeyUsed(id: string, newCount: number, ip: string): Promise<boolean>;
  totpSet(tokenSha: string, secretEnc: Buffer, ip: string): Promise<DashResult>;
  totpGet(): Promise<{ secretEncB64: string; lastCounter: number; confirmed: boolean } | null>;
  totpAccept(counter: number, confirm: boolean): Promise<boolean>;
  sessionBegin(sessionSha: string, csrfSha: string, credentialId: string, ip: string, ua: string): Promise<DashResult>;
  sessionTotp(sessionSha: string, ok: boolean, ip: string): Promise<DashResult>;
  sessionCheck(sessionSha: string): Promise<{ ok: boolean; expiresAt: string | null }>;
  sessionEnd(sessionSha: string, ip: string): Promise<void>;
  stepupRecord(sessionSha: string, stepupSha: string, op: string, argsSha: string, ip: string): Promise<DashResult>;
  call(sessionSha: string, csrfSha: string | null, op: string, args: string, stepupSha: string | null, ip: string): Promise<DashResult>;
}

export class PgDashboardGateway implements DashboardGatewayPort {
  private readonly pool: Pool;
  private readonly s: string;
  constructor(opts: { connectionString: string; schema?: string }) {
    this.s = quoteIdent(opts.schema ?? "fleet");
    this.pool = new pg.Pool({ connectionString: opts.connectionString, max: 4, application_name: "automaton-fleet-dashboard",
      options: "-c statement_timeout=30000 -c lock_timeout=5000" });
    this.pool.on("error", () => {});
  }
  private async call_<T>(fn: string, args: unknown[]): Promise<T> {
    const ph = args.map((_, i) => `$${i + 1}`).join(", ");
    return (await this.pool.query(`SELECT ${this.s}.${fn}(${ph}) AS r`, args)).rows[0].r as T;
  }
  ping() { return this.call_<{ schemaVersion: number | null }>("dash_ping", []); }
  authState() { return this.call_<{ passkeys: Array<{ id: string; transports: string[] }>; totpConfigured: boolean; locked: boolean }>("dash_auth_state", []); }
  async log(event: string, ok: boolean, code: string | null, ip: string, detail: Record<string, unknown> = {}) {
    await this.call_("dash_log", [event, ok, code, ip, JSON.stringify(detail)]);
  }
  async challengeNew(sha: string, purpose: string, sessionSha: string | null, op: string | null, argsSha: string | null) {
    await this.call_("dash_challenge_new", [sha, purpose, sessionSha, op, argsSha]);
  }
  challengeUse(sha: string, purpose: string, sessionSha: string | null, op: string | null, argsSha: string | null) {
    return this.call_<boolean>("dash_challenge_use", [sha, purpose, sessionSha, op, argsSha]);
  }
  enrollValid(tokenSha: string) { return this.call_<boolean>("dash_enroll_valid", [tokenSha]); }
  passkeyAdd(tokenSha: string | null, sessionSha: string | null, stepupSha: string | null, id: string, publicKey: Buffer, count: number, transports: string[], name: string, ip: string) {
    return this.call_<DashResult>("dash_passkey_add", [tokenSha, sessionSha, stepupSha, id, publicKey, count, transports, name, ip]);
  }
  passkeyGet(id: string) { return this.call_<{ id: string; publicKeyB64: string; counter: number; transports: string[] } | null>("dash_passkey_get", [id]); }
  passkeyUsed(id: string, newCount: number, ip: string) { return this.call_<boolean>("dash_passkey_used", [id, newCount, ip]); }
  totpSet(tokenSha: string, secretEnc: Buffer, ip: string) { return this.call_<DashResult>("dash_totp_set", [tokenSha, secretEnc, ip]); }
  totpGet() { return this.call_<{ secretEncB64: string; lastCounter: number; confirmed: boolean } | null>("dash_totp_get", []); }
  totpAccept(counter: number, confirm: boolean) { return this.call_<boolean>("dash_totp_accept", [counter, confirm]); }
  sessionBegin(sessionSha: string, csrfSha: string, credentialId: string, ip: string, ua: string) {
    return this.call_<DashResult>("dash_session_begin", [sessionSha, csrfSha, credentialId, ip, ua]);
  }
  sessionTotp(sessionSha: string, ok: boolean, ip: string) { return this.call_<DashResult>("dash_session_totp", [sessionSha, ok, ip]); }
  sessionCheck(sessionSha: string) { return this.call_<{ ok: boolean; expiresAt: string | null }>("dash_session_check", [sessionSha]); }
  async sessionEnd(sessionSha: string, ip: string) { await this.call_("dash_session_end", [sessionSha, ip]); }
  stepupRecord(sessionSha: string, stepupSha: string, op: string, argsSha: string, ip: string) {
    return this.call_<DashResult>("dash_stepup_record", [sessionSha, stepupSha, op, argsSha, ip]);
  }
  call(sessionSha: string, csrfSha: string | null, op: string, args: string, stepupSha: string | null, ip: string) {
    return this.call_<DashResult>("dash_call", [sessionSha, csrfSha, op, args, stepupSha, ip]);
  }
  async close(): Promise<void> {
    await this.pool.end().catch(() => {});
  }
}

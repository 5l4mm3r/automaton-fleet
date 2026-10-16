/**
 * v82 — owner sign-in recovery, end to end (PostgreSQL + the dashboard gateway and server + the dashboard's own client).
 *
 * Proven here: recovery codes are issued only from a full session with a fresh confirmation, shown once, stored only as keyed
 * digests, and a new set retires the old; "forgot password" needs a current authenticator code AND an unused recovery code,
 * never signs in, ends every session and leaves the normal sign-in with the new password; "lost authenticator" needs the
 * password (or a passkey) AND an unused code, and the new authenticator replaces the old one only when a code from it is
 * confirmed; every failure is one generic refusal that spends nothing and counts towards the lockout; each use raises a RED
 * notification; no code, digest or secret leaks into responses or the audit log.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import crypto from "crypto";
import http from "http";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";
import { SoftAuthenticator, browserLikeFetch } from "./fixtures/soft-webauthn.js";
import { totp } from "../../fleet/identity/crypto.js";
import { PgDashboardGateway } from "../../fleet/dashboard/gateway.js";
import { createDashboardServer, normaliseRecoveryCode, RECOVERY_CODE_COUNT } from "../../fleet/dashboard/server.js";
import { RECOVERY_CODE_COUNT as SQL_COUNT } from "../../fleet/postgres/migrations-phase82.js";
import { GatewayClient } from "../../../codex-dashboard/src/dashboard/api/client";
import { LiveAuth } from "../../../codex-dashboard/src/dashboard/api/auth";
import { FleetApiError } from "../../../codex-dashboard/src/dashboard/api/errors";

const PG_BIN = findPgBin();
const PASSWORD = "correct horse battery staple 82";
const PASSWORD2 = "a brand new passphrase for 2026";
const PASSWORD3 = "the third passphrase in a row";

describe.skipIf(!PG_BIN)("v82 owner sign-in recovery (PostgreSQL + gateway + client)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let dgw: PgDashboardGateway;
  let server: http.Server;
  let ORIGIN = "";
  let totpSecret = "";
  let codes: string[] = [];
  const stateKey = crypto.randomBytes(32);
  let lastStep = 0;
  const responses: string[] = [];
  let shownOnce = 0; // responses that show a secret or the codes by design (enrollment, issue, authenticator replacement)
  const code = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof FleetApiError ? e.code : String(e)));
  const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

  const nextCode = async (secret = totpSecret): Promise<string> => {
    for (;;) {
      const now = Math.floor(Date.now() / 30_000);
      const step = Math.max(lastStep + 1, now - 1);
      if (step <= now + 1) { lastStep = step; return totp(secret, step * 30_000); }
      await new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 300));
    }
  };
  const browser = (authenticator: SoftAuthenticator | null = null) => {
    const jar = browserLikeFetch(ORIGIN);
    const recording = (async (input: string | URL | Request, init?: RequestInit) => {
      const r = await jar(input as string, init);
      responses.push(await r.clone().text());
      return r;
    }) as typeof fetch;
    const store = (() => { let v: string | null = null; return { get: () => v, set: (x: string) => { v = x; }, clear: () => { v = null; } }; })();
    const c = new GatewayClient({ baseUrl: ORIGIN, fetch: recording, webauthn: authenticator ?? new SoftAuthenticator(ORIGIN), csrf: store, share: null });
    return { c, auth: new LiveAuth(c), jar, store };
  };
  const remaining = () => R.one(`(SELECT count(*) FROM fleet.fleet_admin_recovery_codes WHERE used_at IS NULL AND revoked_at IS NULL)`).then(Number);
  const failures = () => R.one(`(SELECT count(*) FROM fleet.fleet_admin_auth_log WHERE NOT ok AND event = 'login' AND code = 'FLEET_RECOVERY_INVALID')`).then(Number);

  let edge: SoftAuthenticator;
  let edgeB: ReturnType<typeof browser>;

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000, treasuryCents: 100_000 });
    dgw = new PgDashboardGateway({ connectionString: R.pgc.dashboardUrl });
    server = createDashboardServer(dgw, { origin: "http://localhost:0", rpId: "localhost", stateKey });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    server.close();
    ORIGIN = `http://localhost:${port}`;
    server = createDashboardServer(dgw, { origin: ORIGIN, rpId: "localhost", stateKey });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
    edge = new SoftAuthenticator(ORIGIN);
    // First access: a passkey + authenticator from the host link, then a password from the passkey session.
    const token = crypto.randomBytes(32).toString("base64url");
    await R.q(`SELECT fleet.fleet_admin_dashboard_enroll($1, $2)`, [sha(token), OWNER]);
    edgeB = browser(edge);
    const e = await edgeB.auth.enroll(token, "Desktop Edge");
    totpSecret = e.totpSecret!;
    shownOnce = responses.length;
    await edgeB.auth.confirmTotp(await nextCode());
    await edgeB.auth.loginPasskey();
    await edgeB.auth.loginTotp(await nextCode());
    await edgeB.auth.setPassword(PASSWORD);
  }, 240_000);
  afterAll(async () => { server?.close(); await dgw?.close(); await R?.close(); });
  /** A fresh server image before each test (the per-address sign-in limit lives in the process); state is in the database. */
  const restart = async () => {
    const port = Number(new URL(ORIGIN).port);
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    server = createDashboardServer(dgw, { origin: ORIGIN, rpId: "localhost", stateKey });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
    await new Promise((r) => setTimeout(r, 250));
  };
  beforeEach(async () => { if (totpSecret) await restart(); });

  it("recovery codes: a fresh confirmation first; ten codes shown once; only keyed digests stored; the count is readable", async () => {
    expect(RECOVERY_CODE_COUNT).toBe(SQL_COUNT);
    expect(await edgeB.auth.recoveryState()).toMatchObject({ remaining: 0, issuedAt: null });
    // No step-up → refused, nothing stored.
    expect((await edgeB.c.write("/api/account/recovery-codes", {})).json.code).toBe("FLEET_STEPUP_REQUIRED");
    expect(await remaining()).toBe(0);
    const before = edge.assertions;
    codes = await edgeB.auth.issueRecoveryCodes();
    shownOnce = responses.length;
    expect(edge.assertions).toBe(before + 1); // the confirmation really asked the passkey
    expect(codes).toHaveLength(10);
    for (const c of codes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
    expect(new Set(codes).size).toBe(10);
    expect(await edgeB.auth.recoveryState()).toMatchObject({ remaining: 10, issuedAt: expect.any(String) });
    const stored = (await R.q(`SELECT code_sha FROM fleet.fleet_admin_recovery_codes`)).map((r) => r.code_sha);
    for (const c of codes) {
      expect(stored).not.toContain(sha(c));
      expect(stored).not.toContain(sha(normaliseRecoveryCode(c)));
      expect(JSON.stringify(stored)).not.toContain(normaliseRecoveryCode(c));
    }
    expect(await R.one(`(SELECT count(*) FROM fleet.fleet_notifications WHERE code = 'ADMIN_RECOVERY_CODES_ISSUED')`).then(Number)).toBe(1);
    // Signed out, the count is not readable.
    expect((await browser().c.getJson("/api/account/recovery")).status).toBe(401);
  });

  it("forgot password: a wrong factor spends nothing; both right → a new password, every session ends, and no session is given", async () => {
    const b = browser(null);
    const f0 = await failures();
    // A wrong authenticator code with a valid recovery code: refused; the code is not spent.
    expect(await code(b.auth.recoverPassword("000000", codes[0], PASSWORD2))).toBe("FLEET_RECOVERY_INVALID");
    expect(await remaining()).toBe(10);
    // A right authenticator code with a made-up recovery code: refused; that authenticator code is NOT used up.
    const good = await nextCode();
    expect(await code(b.auth.recoverPassword(good, "AAAA-BBBB-CCCC-DDDD", PASSWORD2))).toBe("FLEET_RECOVERY_INVALID");
    expect(await failures()).toBe(f0 + 2); // counted towards the sign-in lockout
    // A weak password is refused before any factor is checked.
    expect(await code(b.auth.recoverPassword(good, codes[0], "short"))).toBe("FLEET_PASSWORD_WEAK");
    expect(await remaining()).toBe(10);
    // Both right (the code typed in lower case without dashes still matches): reset.
    const r = await b.auth.recoverPassword(good, normaliseRecoveryCode(codes[0]).toLowerCase(), PASSWORD2);
    expect(r).toEqual({ codesLeft: 9 });
    expect(await remaining()).toBe(9);
    expect(b.jar.cookies.size).toBe(0); // recovery never signs in
    expect(await code(b.c.read("agents"))).toBe("FLEET_SESSION_INVALID");
    expect(await code(edgeB.c.read("agents"))).toBe("FLEET_SESSION_INVALID"); // every session ended
    expect(await R.one(`(SELECT set_via FROM fleet.fleet_admin_password WHERE id = 1)`)).toBe("recovery");
    expect(await R.one(`(SELECT count(*) FROM fleet.fleet_notifications WHERE code = 'ADMIN_PASSWORD_RESET_RECOVERY' AND class = 'RED')`).then(Number)).toBe(1);
    // The same code again: refused. The old password: refused. The new one with a fresh authenticator code: signed in.
    expect(await code(b.auth.recoverPassword(await nextCode(), codes[0], PASSWORD3))).toBe("FLEET_RECOVERY_INVALID");
    expect(await code(b.auth.loginPassword(PASSWORD, await nextCode()))).toBe("FLEET_LOGIN_INVALID");
    await b.auth.loginPassword(PASSWORD2, await nextCode());
    expect(Array.isArray(await b.c.read("agents"))).toBe(true);
  });

  it("lost authenticator: password + code → a new authenticator, which replaces the old one only once a code from it is confirmed", async () => {
    const b = browser(null);
    // A wrong password with a valid code: refused, nothing spent.
    expect(await code(b.auth.recoverAuthenticator(codes[1], "not the password at all"))).toBe("FLEET_RECOVERY_INVALID");
    expect(await remaining()).toBe(9);
    const fresh = await b.auth.recoverAuthenticator(codes[1], PASSWORD2);
    shownOnce = responses.length;
    expect(fresh).toMatchObject({ ticket: expect.any(String), totpSecret: expect.stringMatching(/^[A-Z2-7]{32}$/), otpauth: expect.stringContaining("otpauth://totp/"), codesLeft: 8 });
    expect(await R.one(`(SELECT count(*) FROM fleet.fleet_notifications WHERE code = 'ADMIN_AUTHENTICATOR_RECOVERY_STARTED' AND class = 'RED')`).then(Number)).toBe(1);
    // Until confirmed, the old authenticator still signs in.
    const old = browser(null);
    await old.auth.loginPassword(PASSWORD2, await nextCode());
    expect(Array.isArray(await old.c.read("agents"))).toBe(true);
    // A code from the OLD authenticator does not confirm the new one; a wrong ticket confirms nothing.
    expect(await code(b.auth.confirmRecoveredAuthenticator(fresh.ticket, await nextCode()))).toBe("FLEET_RECOVERY_INVALID");
    expect(await code(b.auth.confirmRecoveredAuthenticator("x".repeat(43), totp(fresh.totpSecret)))).toBe("FLEET_RECOVERY_INVALID");
    await b.auth.confirmRecoveredAuthenticator(fresh.ticket, totp(fresh.totpSecret));
    expect(await code(old.c.read("agents"))).toBe("FLEET_SESSION_INVALID"); // every session ended
    expect(await R.one(`(SELECT count(*) FROM fleet.fleet_notifications WHERE code = 'ADMIN_AUTHENTICATOR_REPLACED' AND class = 'RED')`).then(Number)).toBe(1);
    // The ticket works once.
    expect(await code(b.auth.confirmRecoveredAuthenticator(fresh.ticket, totp(fresh.totpSecret, Date.now() + 30_000)))).toBe("FLEET_RECOVERY_INVALID");
    // The old authenticator no longer signs in; the new one does.
    const oldSecret = totpSecret;
    expect(await code(browser(null).auth.loginPassword(PASSWORD2, await nextCode(oldSecret)))).toBe("FLEET_LOGIN_INVALID");
    totpSecret = fresh.totpSecret; lastStep = Math.floor(Date.now() / 30_000); // the first step of the new factor was used to confirm it
    const n = browser(null);
    await n.auth.loginPassword(PASSWORD2, await nextCode());
    expect(Array.isArray(await n.c.read("agents"))).toBe(true);
  });

  it("lost authenticator with this device's passkey instead of the password; a new set of codes retires the old one", async () => {
    const b = browser(edge);
    const before = edge.assertions;
    const fresh = await b.auth.recoverAuthenticator(codes[2], null);
    shownOnce = responses.length;
    expect(edge.assertions).toBe(before + 1);
    expect(fresh.codesLeft).toBe(7);
    await b.auth.confirmRecoveredAuthenticator(fresh.ticket, totp(fresh.totpSecret));
    totpSecret = fresh.totpSecret; lastStep = Math.floor(Date.now() / 30_000);
    // Sign in again and replace the codes: every unused old code stops working.
    const s = browser(edge);
    await s.auth.loginPasskey(); await s.auth.loginTotp(await nextCode());
    const newCodes = await s.auth.issueRecoveryCodes();
    shownOnce = responses.length;
    expect(await s.auth.recoveryState()).toMatchObject({ remaining: 10 });
    expect(await R.one(`(SELECT count(*) FROM fleet.fleet_admin_recovery_codes WHERE revoked_at IS NOT NULL)`).then(Number)).toBe(7);
    expect(await code(browser(null).auth.recoverPassword(await nextCode(), codes[3], PASSWORD3))).toBe("FLEET_RECOVERY_INVALID");
    codes = newCodes;
  });

  it("no recovery code, digest or authenticator secret appears in later responses or the audit log", async () => {
    const stored = (await R.q(`SELECT code_sha FROM fleet.fleet_admin_recovery_codes`)).map((r) => r.code_sha as string);
    const later = responses.slice(shownOnce).join("\n");
    for (const c of codes) expect(later).not.toContain(c);
    for (const d of stored) expect(later).not.toContain(d);
    expect(later).not.toContain(totpSecret);
    const audit = JSON.stringify(await R.q(`SELECT * FROM fleet.fleet_admin_auth_log`)) + JSON.stringify(await R.q(`SELECT title, detail FROM fleet.fleet_notifications`));
    for (const c of codes) { expect(audit).not.toContain(c); expect(audit).not.toContain(normaliseRecoveryCode(c)); }
    for (const d of stored) expect(audit).not.toContain(d);
    expect(audit).not.toContain(totpSecret);
  });

  it("recovery attempts count towards the lockout; while locked, recovery is refused too", async () => {
    const b = browser(null);
    for (let i = 0; i < 20; i++) await code(b.auth.recoverPassword("000000", `WRONG-CODE-${String(i).padStart(4, "0")}`, PASSWORD3));
    expect(await b.auth.state()).toMatchObject({ locked: true });
    expect(await code(b.auth.recoverPassword(await nextCode(), codes[0], PASSWORD3))).toBe("FLEET_ADMIN_LOCKED");
    expect(await code(b.auth.recoverAuthenticator(codes[0], PASSWORD2))).toBe("FLEET_ADMIN_LOCKED");
    expect(await remaining()).toBe(10);
  });
});

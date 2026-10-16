/**
 * v82 — HOST recovery of the owner's Admin sign-in, end to end (PostgreSQL + the dashboard gateway and server + the
 * dashboard's own client; the host commands run through the SAME code path as `fleet:admin` — runHubCommand + PgHubAdmin on
 * the owner connection).
 *
 * When the sign-in page cannot help (no usable recovery code, or no second factor to pair one with), the owner recovers on
 * the Fleet host: `hub-dashboard-totp-reset` removes the authenticator and `hub-dashboard-enroll <origin>` prints a one-time,
 * 15-minute link `<origin>/login/#enroll=<token>` that sets the password or registers a passkey and — when no authenticator
 * is configured — shows a new authenticator secret once, to be confirmed with a code.
 *
 * Proven here, in order on one registry:
 *   a. lost authenticator, no usable recovery code: the sign-in page refuses; host reset → no sign-in route gives a session;
 *      link → password + new authenticator → confirmed → signed in; old authenticator codes refused; the link works once.
 *   b. lost password and every passkey (authenticator kept): link → new password, the authenticator is NOT reshown → signed
 *      in; old password refused; a used or expired link is refused.
 *   c. lost everything: host reset + link → passkey on a new device + new authenticator → signed in; the lost passkey is
 *      then revoked and the password replaced from the new session.
 *   d. the host commands are owner-only: the dashboard database role cannot call them, a non-Admin actor is refused, and
 *      nothing in the dashboard API removes the authenticator (FLEET_LOCKOUT_PREVENTED).
 *   f. recovery codes issued before a host reset SURVIVE it (the host commands never touch them) and still work afterwards;
 *      issuing a new set from a session retires them.
 *   e. every host recovery leaves an audit and notification trace; no link token, password or secret appears in a response
 *      after it is shown once, in the audit log or in a notification.
 * Also recorded (actual behaviour, asserted): a host reset does NOT end sessions that are already signed in, a link that sets
 * the password ends the other PASSWORD sessions only, and a link that adds a passkey ends none — "Sign out elsewhere" ends them.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import crypto from "crypto";
import http from "http";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";
import { SoftAuthenticator, browserLikeFetch } from "./fixtures/soft-webauthn.js";
import { totp } from "../../fleet/identity/crypto.js";
import { PgDashboardGateway } from "../../fleet/dashboard/gateway.js";
import { createDashboardServer, normaliseRecoveryCode } from "../../fleet/dashboard/server.js";
import { PgHubAdmin } from "../../fleet/hub/admin.js";
import { HUB_COMMANDS, runHubCommand } from "../../fleet/hub/cli.js";
import { GatewayClient, type StepupChoice } from "../../../codex-dashboard/src/dashboard/api/client";
import { LiveAuth } from "../../../codex-dashboard/src/dashboard/api/auth";
import { FleetApiError } from "../../../codex-dashboard/src/dashboard/api/errors";

const PG_BIN = findPgBin();
const PASSWORD = "correct horse battery staple host";
const PASSWORD2 = "a password set through the host link";
const PASSWORD3 = "another one after losing every passkey";
const PASSWORD4 = "the final passphrase after lost everything";
const FAKE_CODE = "AAAA-BBBB-CCCC-DDDD";

describe.skipIf(!PG_BIN)("v82 host recovery of the owner sign-in (PostgreSQL + gateway + client + fleet:admin)", { timeout: 600_000 }, () => {
  let R: EconomyRegistry;
  let dgw: PgDashboardGateway;
  let hub: PgHubAdmin;
  let server: http.Server;
  let ORIGIN = "";
  let totpSecret = "";
  let codes: string[] = [];
  const stateKey = crypto.randomBytes(32);
  let lastStep = 0;
  const responses: string[] = [];
  /** Values shown ONCE by design (authenticator secrets, recovery codes) and the response count right after showing. */
  const shown: Array<{ value: string; at: number }> = [];
  const tokens: string[] = [];        // every raw enrollment-link token (never in a response, the database or the log)
  const oldSecrets: string[] = [];    // authenticator secrets lost along the way
  const code = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof FleetApiError ? e.code : String(e)));
  const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

  /** A fresh, never-used TOTP code (each 30 s step is accepted once; the gateway accepts the previous, current and next step). */
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
  const passwordChoice = (password: string) => async (): Promise<StepupChoice> => ({ method: "password", password, code: await nextCode() });
  /** `fleet:admin hub-dashboard-enroll <origin>` on the host → the token the dashboard's own sign-in page reads from the link. */
  const hostEnroll = async (): Promise<{ token: string; out: Record<string, any> }> => {
    const out = (await runHubCommand("hub-dashboard-enroll", [ORIGIN], hub, OWNER)) as Record<string, any>;
    expect(out.link).toMatch(new RegExp(`^${ORIGIN.replace(/[.:/]/g, "\\$&")}/login/#enroll=[A-Za-z0-9_-]{43}$`));
    const token = LiveAuth.enrollTokenFromHash(new URL(out.link).hash)!;
    expect(token).toBeTruthy();
    tokens.push(token);
    return { token, out };
  };
  const hostTotpReset = () => runHubCommand("hub-dashboard-totp-reset", [], hub, OWNER) as Promise<Record<string, any>>;
  const totpRows = () => R.one(`(SELECT count(*) FROM fleet.fleet_admin_totp)`).then(Number);
  const remaining = () => R.one(`(SELECT count(*) FROM fleet.fleet_admin_recovery_codes WHERE used_at IS NULL AND revoked_at IS NULL)`).then(Number);
  const lockoutFailures = () => R.one(`(SELECT count(*) FROM fleet.fleet_admin_auth_log WHERE NOT ok AND event IN ('login','totp','stepup','enroll') AND at > now() - interval '15 minutes')`).then(Number);

  let edge: SoftAuthenticator;   // the owner's original passkey (lost in b)
  let edgeB: ReturnType<typeof browser>;

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000, treasuryCents: 100_000 });
    dgw = new PgDashboardGateway({ connectionString: R.pgc.dashboardUrl });
    hub = new PgHubAdmin({ connectionString: R.pgc.ownerUrl });
    server = createDashboardServer(dgw, { origin: "http://localhost:0", rpId: "localhost", stateKey });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    server.close();
    ORIGIN = `http://localhost:${port}`;
    server = createDashboardServer(dgw, { origin: ORIGIN, rpId: "localhost", stateKey });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
    edge = new SoftAuthenticator(ORIGIN);
    // The owner's normal state: passkey + authenticator from a first host link, a password, and a set of recovery codes.
    const { token } = await hostEnroll();
    edgeB = browser(edge);
    const e = await edgeB.auth.enroll(token, "Desktop Edge");
    totpSecret = e.totpSecret!;
    shown.push({ value: totpSecret, at: responses.length });
    await edgeB.auth.confirmTotp(await nextCode());
    await edgeB.auth.loginPasskey();
    await edgeB.auth.loginTotp(await nextCode());
    await edgeB.auth.setPassword(PASSWORD);
    codes = await edgeB.auth.issueRecoveryCodes();
    for (const c of codes) shown.push({ value: c, at: responses.length });
    expect(codes).toHaveLength(10);
  }, 300_000);
  afterAll(async () => { server?.close(); await hub?.close(); await dgw?.close(); await R?.close(); });
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

  it("the host commands are the fleet:admin commands (routed from the CLI)", () => {
    expect(HUB_COMMANDS.has("hub-dashboard-enroll")).toBe(true);
    expect(HUB_COMMANDS.has("hub-dashboard-totp-reset")).toBe(true);
  });

  it("a. lost authenticator, no usable recovery code: the page refuses; host reset → no session; link → new authenticator → signed in", async () => {
    // A session the owner (or a thief) already had open before the loss.
    const before = browser(edge);
    await before.auth.loginPasskey(); await before.auth.loginTotp(await nextCode());
    expect(await code(before.c.read("agents"))).toBe("OK");

    // The sign-in page cannot help: forgot-password needs an authenticator code; lost-authenticator needs a recovery code.
    const p = browser(null);
    expect(await code(p.auth.recoverAuthenticator(FAKE_CODE, PASSWORD))).toBe("FLEET_RECOVERY_INVALID");
    expect(await code(p.auth.recoverPassword("000000", FAKE_CODE, PASSWORD2))).toBe("FLEET_RECOVERY_INVALID");
    expect(await remaining()).toBe(10);

    // Host: remove the authenticator.
    const reset = await hostTotpReset();
    expect(reset).toMatchObject({ ok: true, next: expect.stringContaining("hub-dashboard-enroll") });
    expect(await totpRows()).toBe(0);
    const lost = totpSecret; oldSecrets.push(lost);

    // Now no route yields a NEW session: the page reports "not enrolled"; password + (old) code and passkey + code fail.
    expect(await p.auth.state()).toMatchObject({ enrolled: false, locked: false });
    expect(await code(p.auth.loginPassword(PASSWORD, totp(lost)))).toBe("FLEET_LOGIN_INVALID");
    const pk = browser(edge);
    await pk.auth.loginPasskey(); // only the 5-minute half session; the authenticator step cannot complete it
    expect(await code(pk.auth.loginTotp(totp(lost)))).toBe("FLEET_TOTP_STATE");
    expect(await code(pk.c.read("agents"))).toBe("FLEET_SESSION_INVALID");
    // ACTUAL BEHAVIOUR: a host reset does not end a session that was already fully signed in.
    expect(await code(before.c.read("agents"))).toBe("OK");
    // Recovery codes issued before the reset are untouched by it (see f).
    expect(await remaining()).toBe(10);

    // Host: a one-time link. It sets the password (or registers a passkey) and, with no authenticator, shows a new one ONCE.
    const { token, out } = await hostEnroll();
    expect(new Date(out.expiresAt).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(new Date(out.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    const b = browser(null);
    expect(await code(b.auth.enrollPassword(token, "short"))).toBe("FLEET_PASSWORD_WEAK"); // refused before the link is spent
    const e = await b.auth.enrollPassword(token, PASSWORD2);
    expect(e).toMatchObject({ next: "totp", totpSecret: expect.stringMatching(/^[A-Z2-7]{32}$/), otpauth: expect.stringContaining("otpauth://totp/") });
    shown.push({ value: e.totpSecret!, at: responses.length });
    expect(b.jar.cookies.size).toBe(0); // the link never signs in
    // Unconfirmed, the new authenticator does not sign in yet; a wrong code does not confirm it.
    expect(await code(b.auth.loginPassword(PASSWORD2, totp(e.totpSecret!)))).toBe("FLEET_LOGIN_INVALID");
    expect(await code(b.auth.confirmTotp("000000"))).toBe("FLEET_TOTP_INVALID");
    totpSecret = e.totpSecret!;
    await b.auth.confirmTotp(await nextCode());
    expect(await totpRows()).toBe(1);

    // Signed in with the password + a code from the new authenticator; the old password and old codes are refused.
    expect(await code(browser(null).auth.loginPassword(PASSWORD, await nextCode()))).toBe("FLEET_LOGIN_INVALID");
    expect(await code(browser(null).auth.loginPassword(PASSWORD2, totp(lost)))).toBe("FLEET_LOGIN_INVALID");
    const s = browser(null);
    await s.auth.loginPassword(PASSWORD2, await nextCode());
    expect(await code(s.c.read("agents"))).toBe("OK");
    // The link worked once.
    expect(await code(browser(null).auth.enrollPassword(token, PASSWORD3))).toBe("FLEET_ENROLLMENT_INVALID");

    // The passkey session from before the loss is still alive; "Sign out elsewhere" (step-up) ends it.
    expect(await code(before.c.read("agents"))).toBe("OK");
    s.c.stepupConfirm = passwordChoice(PASSWORD2);
    expect(await s.c.call("session_revoke_all", {})).toMatchObject({ ok: true });
    expect(await code(before.c.read("agents"))).toBe("FLEET_SESSION_INVALID");
    expect(await code(s.c.read("agents"))).toBe("OK");
  });

  it("b. lost the password and every passkey (authenticator kept): link → new password, authenticator not reshown; used/expired links refused", async () => {
    const pwBefore = browser(null);
    await pwBefore.auth.loginPassword(PASSWORD2, await nextCode());
    const pkBefore = browser(edge);
    await pkBefore.auth.loginPasskey(); await pkBefore.auth.loginTotp(await nextCode());

    const { token } = await hostEnroll();
    const b = browser(null);
    const r = await b.auth.enrollPassword(token, PASSWORD3);
    expect(r).toEqual({ next: "login", totpSecret: undefined, otpauth: undefined }); // the existing authenticator stays; nothing reshown
    expect(b.jar.cookies.size).toBe(0);
    expect(await R.one(`(SELECT set_via FROM fleet.fleet_admin_password WHERE id = 1)`)).toBe("enrollment");
    // ACTUAL BEHAVIOUR: a password set by the link ends every other PASSWORD session; a passkey session is not ended.
    expect(await code(pwBefore.c.read("agents"))).toBe("FLEET_SESSION_INVALID");
    expect(await code(pkBefore.c.read("agents"))).toBe("OK");

    // The new password + the existing authenticator sign in; the old password is refused.
    expect(await code(browser(null).auth.loginPassword(PASSWORD2, await nextCode()))).toBe("FLEET_LOGIN_INVALID");
    const s = browser(null);
    await s.auth.loginPassword(PASSWORD3, await nextCode());
    expect(await code(s.c.read("agents"))).toBe("OK");

    // The link works once — for a password or a passkey alike.
    expect(await code(browser(null).auth.enrollPassword(token, PASSWORD4))).toBe("FLEET_ENROLLMENT_INVALID");
    expect(await code(browser(new SoftAuthenticator(ORIGIN)).auth.enroll(token, "x"))).toBe("FLEET_ENROLLMENT_INVALID");
    // A link expires after 15 minutes (simulated by moving its expiry into the past): refused, nothing changes.
    const late = await hostEnroll();
    expect(Number(await R.one(`(SELECT extract(epoch FROM expires_at - created_at) FROM fleet.fleet_admin_enrollment WHERE token_sha = $1)`, [sha(late.token)]))).toBeCloseTo(900, 0);
    await R.q(`UPDATE fleet.fleet_admin_enrollment SET expires_at = now() - interval '1 second' WHERE token_sha = $1`, [sha(late.token)]);
    expect(await code(browser(null).auth.enrollPassword(late.token, PASSWORD4))).toBe("FLEET_ENROLLMENT_INVALID");
    expect(await code(browser(new SoftAuthenticator(ORIGIN)).auth.enroll(late.token, "x"))).toBe("FLEET_ENROLLMENT_INVALID");
    expect(await R.one(`(SELECT used_at FROM fleet.fleet_admin_enrollment WHERE token_sha = $1)`, [sha(late.token)])).toBeNull();
    const s2 = browser(null);
    await s2.auth.loginPassword(PASSWORD3, await nextCode()); // still PASSWORD3
    // The owner then revokes the sessions of the lost devices.
    s2.c.stepupConfirm = passwordChoice(PASSWORD3);
    await s2.c.call("session_revoke_all", {});
    expect(await code(pkBefore.c.read("agents"))).toBe("FLEET_SESSION_INVALID");
  });

  it("c. lost everything: host reset + link → a passkey on a new device + a new authenticator → signed in; then clean up", async () => {
    await hostTotpReset();
    oldSecrets.push(totpSecret);
    expect(await totpRows()).toBe(0);
    const { token } = await hostEnroll();
    const phone = new SoftAuthenticator(ORIGIN);
    const b = browser(phone);
    const e = await b.auth.enroll(token, "Replacement phone");
    expect(e).toMatchObject({ next: "totp", totpSecret: expect.stringMatching(/^[A-Z2-7]{32}$/) });
    shown.push({ value: e.totpSecret!, at: responses.length });
    expect(b.jar.cookies.size).toBe(0);
    totpSecret = e.totpSecret!;
    await b.auth.confirmTotp(await nextCode());
    // Passkey + new code: signed in. A passkey alone is not a session.
    const s = browser(phone);
    await s.auth.loginPasskey();
    expect((await s.jar(`${ORIGIN}/api/read?op=agents&args=%7B%7D`)).status).toBe(401);
    await s.auth.loginTotp(await nextCode());
    expect(await code(s.c.read("agents"))).toBe("OK");
    expect(await code(browser(null).auth.loginPassword(PASSWORD3, totp(oldSecrets[oldSecrets.length - 1])))).toBe("FLEET_LOGIN_INVALID");

    // Afterwards (runbook): revoke the lost passkey and replace the password, both with a fresh confirmation by the new passkey.
    const keys = (await s.c.read<Record<string, any>>("security")).passkeys as Array<Record<string, any>>;
    expect(keys.map((k) => k.name).sort()).toEqual(["Desktop Edge", "Replacement phone"]);
    const lostKey = keys.find((k) => k.name === "Desktop Edge")!;
    const before = phone.assertions;
    expect(await s.c.call("passkey_revoke", { credentialId: lostKey.credentialId })).toMatchObject({ ok: true });
    await s.auth.setPassword(PASSWORD4);
    expect(phone.assertions).toBe(before + 2);
    expect(await code(browser(edge).auth.loginPasskey())).toBe("FLEET_PASSKEY_INVALID");
    expect(await code(browser(null).auth.loginPassword(PASSWORD3, await nextCode()))).toBe("FLEET_LOGIN_INVALID");
    const pw = browser(null);
    await pw.auth.loginPassword(PASSWORD4, await nextCode());
    expect(await code(pw.c.read("agents"))).toBe("OK");
  });

  it("d. owner-only: the dashboard role cannot call the host functions; a non-Admin actor is refused; the API cannot remove the authenticator", async () => {
    const dash = new pg.Pool({ connectionString: R.pgc.dashboardUrl, max: 1 });
    dash.on("error", () => {});
    try {
      expect(await R.code(dash.query(`SELECT fleet.fleet_admin_dashboard_totp_reset($1)`, [OWNER]))).toBe("permission denied");
      expect(await R.code(dash.query(`SELECT fleet.fleet_admin_dashboard_enroll($1, $2)`, [sha("forged"), OWNER]))).toBe("permission denied");
      expect(await R.code(dash.query(`DELETE FROM fleet.fleet_admin_totp`))).toBe("permission denied");
      expect(await R.code(dash.query(`INSERT INTO fleet.fleet_admin_enrollment (token_sha, created_by, expires_at) VALUES ($1, 'x', now() + interval '1 hour')`, [sha("forged")]))).toBe("permission denied");
    } finally {
      await dash.end();
    }
    // On the owner connection, only an Admin actor (operator:<name>) may run them; the origin must be a bare origin.
    expect(await R.code(runHubCommand("hub-dashboard-totp-reset", [], hub, "someone"))).toBe("FLEET_APPROVAL_REQUIRED");
    expect(await R.code(runHubCommand("hub-dashboard-enroll", [ORIGIN], hub, "someone"))).toBe("FLEET_APPROVAL_REQUIRED");
    expect(await R.code(runHubCommand("hub-dashboard-enroll", [`${ORIGIN}/`], hub, OWNER))).toBe("FLEET_BAD_REQUEST");
    expect(await R.code(runHubCommand("hub-dashboard-enroll", ["javascript:alert(1)"], hub, OWNER))).toBe("FLEET_BAD_REQUEST");
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_admin_enrollment WHERE created_by = 'someone')`))).toBe(0);
    // The dashboard API refuses to remove the authenticator, even from a full session with a fresh confirmation.
    const s = browser(null);
    await s.auth.loginPassword(PASSWORD4, await nextCode());
    s.c.stepupConfirm = passwordChoice(PASSWORD4);
    expect(await code(s.c.call("totp_reset", {}))).toBe("FLEET_LOCKOUT_PREVENTED");
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_admin_totp WHERE confirmed_at IS NOT NULL)`))).toBe(1);
  });

  it("f. recovery codes issued before a host reset survive it and still work; a new set from a session retires them", async () => {
    // Two host resets and four links later, all ten codes from before are unused and not retired.
    expect(await remaining()).toBe(10);
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_admin_recovery_codes WHERE revoked_at IS NOT NULL OR used_at IS NOT NULL)`))).toBe(0);
    // One of them, with the current password, still replaces the authenticator from the sign-in page.
    const p = browser(null);
    const fresh = await p.auth.recoverAuthenticator(codes[0], PASSWORD4);
    shown.push({ value: fresh.totpSecret, at: responses.length });
    expect(fresh.codesLeft).toBe(9);
    await p.auth.confirmRecoveredAuthenticator(fresh.ticket, totp(fresh.totpSecret));
    oldSecrets.push(totpSecret);
    totpSecret = fresh.totpSecret; lastStep = Math.max(lastStep, Math.floor(Date.now() / 30_000));
    // So after a host recovery the owner issues a new set: every earlier unused code stops working.
    const s = browser(null);
    await s.auth.loginPassword(PASSWORD4, await nextCode());
    s.c.stepupConfirm = passwordChoice(PASSWORD4);
    const newCodes = await s.auth.issueRecoveryCodes();
    for (const c of newCodes) shown.push({ value: c, at: responses.length });
    expect(await remaining()).toBe(10);
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_admin_recovery_codes WHERE revoked_at IS NOT NULL)`))).toBe(9);
    expect(await code(browser(null).auth.recoverAuthenticator(codes[1], PASSWORD4))).toBe("FLEET_RECOVERY_INVALID");
    codes = [...codes, ...newCodes];
  });

  it("e. every host recovery leaves an audit and notification trace; no token, password or secret leaks", async () => {
    const log = await R.q(`SELECT event, ok, op, code, ip, detail FROM fleet.fleet_admin_auth_log ORDER BY seq`);
    const host = log.filter((l) => l.event === "totp_reset");
    expect(host).toHaveLength(2);
    for (const l of host) expect(l).toMatchObject({ ok: true, code: "host", detail: { by: OWNER } });
    const issued = log.filter((l) => l.event === "enroll_issued");
    expect(issued).toHaveLength(tokens.length); // every link the host printed (5), attributed
    for (const l of issued) expect(l).toMatchObject({ ok: true, detail: { by: OWNER } });
    expect(log.filter((l) => l.event === "password_set" && l.ok && l.code === "enrollment")).toHaveLength(2); // a and b
    expect(log.filter((l) => l.event === "passkey_added" && l.ok).map((l) => l.detail.name)).toEqual(["Desktop Edge", "Replacement phone"]);
    expect(log.filter((l) => l.event === "enroll" && !l.ok && l.code === "FLEET_ENROLLMENT_INVALID").length).toBeGreaterThanOrEqual(5);
    const notes = await R.q(`SELECT class, code, title, detail FROM fleet.fleet_notifications WHERE code LIKE 'ADMIN_%' ORDER BY created_at`);
    const count = (c: string) => notes.filter((n) => n.code === c).length;
    expect(notes.filter((n) => n.code === "ADMIN_TOTP_RESET").every((n) => n.class === "AMBER")).toBe(true);
    expect(count("ADMIN_TOTP_RESET")).toBe(2);
    expect(count("ADMIN_PASSWORD_SET")).toBeGreaterThanOrEqual(3); // first set, link in a, link in b (and the change in c)
    expect(count("ADMIN_PASSKEY_ADDED")).toBe(2);
    expect(count("ADMIN_PASSKEY_REVOKED")).toBe(1);

    // Leaks: link tokens appear nowhere (only their SHA-256 is stored); passwords appear nowhere; each one-time secret
    // appears in no response after the one that showed it; nothing secret is in the audit log or a notification.
    const all = responses.join("\n");
    const audit = JSON.stringify(log) + JSON.stringify(notes);
    const stored = JSON.stringify(await R.q(`SELECT * FROM fleet.fleet_admin_enrollment`));
    for (const t of tokens) {
      expect(all).not.toContain(t);
      expect(audit).not.toContain(t);
      expect(stored).not.toContain(t);
      expect(stored).toContain(sha(t));
      expect(audit).not.toContain(sha(t));
    }
    for (const pw of [PASSWORD, PASSWORD2, PASSWORD3, PASSWORD4]) { expect(all).not.toContain(pw); expect(audit).not.toContain(pw); }
    for (const { value, at } of shown) {
      expect(responses.slice(at).join("\n")).not.toContain(value);
      expect(audit).not.toContain(value);
      expect(audit).not.toContain(normaliseRecoveryCode(value));
    }
    // The run stayed below the sign-in lockout (20 failures / 15 min), which also gates the sign-in after a host recovery.
    expect(await lockoutFailures()).toBeLessThan(20);
  });
});

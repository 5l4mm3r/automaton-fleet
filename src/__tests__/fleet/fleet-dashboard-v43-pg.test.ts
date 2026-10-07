/**
 * Schema v43 — owner sign-in resilience and notification housekeeping, against the REAL gateway (PostgreSQL + the
 * dashboard server + the dashboard's own client and auth modules; software WebAuthn authenticators with real P-256
 * signatures). "Separate browsers" are separate cookie jars, token stores and authenticators.
 *
 * Sign-in: the existing passkey + TOTP route keeps working; password + TOTP is a second, independent route; neither a
 * password nor a passkey alone ever yields a full session; any wrong factor is one generic refusal; the lockout counts
 * the password route too; step-up works with either route; several passkeys (add / rename / revoke) and the guard that
 * the owner can never remove the last way in; the authenticator cannot be removed from the dashboard; the host recovery
 * link can set a password; no password, verifier or secret ever appears in a response or a log.
 * Notifications: acknowledge stays; delete is separate, owner-attributed, acknowledged-only (or explicit acknowledge and
 * delete), idempotent, leaves a minimal tombstone, and removes the row from the inbox, its counts and Acknowledge all.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import crypto from "crypto";
import http from "http";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";
import { SoftAuthenticator, browserLikeFetch } from "./fixtures/soft-webauthn.js";
import { totp } from "../../fleet/identity/crypto.js";
import { PgDashboardGateway } from "../../fleet/dashboard/gateway.js";
import { createDashboardServer } from "../../fleet/dashboard/server.js";
import { GatewayClient, type StepupChoice } from "../../../codex-dashboard/src/dashboard/api/client";
import { LiveAuth } from "../../../codex-dashboard/src/dashboard/api/auth";
import { FleetApiError } from "../../../codex-dashboard/src/dashboard/api/errors";

const PG_BIN = findPgBin();
const PASSWORD = "correct horse battery staple 43";
const PASSWORD2 = "a different long passphrase 2026";

describe.skipIf(!PG_BIN)("v43 owner sign-in resilience + notification housekeeping (PostgreSQL + gateway + client)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let dgw: PgDashboardGateway;
  let server: http.Server;
  let ORIGIN = "";
  let totpSecret = "";
  const stateKey = crypto.randomBytes(32);
  let lastStep = 0;
  const responses: string[] = [];
  let afterEnrollment = 0; // the enrollment response shows the TOTP secret ONCE, by design
  const code = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof FleetApiError ? e.code : String(e)));
  const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

  /** A fresh, never-used TOTP code (each 30 s step is accepted once; the gateway accepts the previous, current and next step). */
  const nextCode = async (): Promise<string> => {
    for (;;) {
      const now = Math.floor(Date.now() / 30_000);
      const step = Math.max(lastStep + 1, now - 1);
      if (step <= now + 1) { lastStep = step; return totp(totpSecret, step * 30_000); }
      await new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 300));
    }
  };
  /** One "browser": its own cookie jar, CSRF store and authenticator; every response body is kept for the leak scan. */
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
  const passwordChoice = async (password = PASSWORD): Promise<StepupChoice> => ({ method: "password", password, code: await nextCode() });

  let edge: SoftAuthenticator;   // the owner's existing passkey (held by one browser's provider)
  let phone: SoftAuthenticator;  // a second passkey added later from Fleet HQ
  let edgeB: ReturnType<typeof browser>;

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000, treasuryCents: 100_000 });
    dgw = new PgDashboardGateway({ connectionString: R.pgc.dashboardUrl });
    server = createDashboardServer(dgw, { origin: "http://localhost:0", rpId: "localhost", stateKey: crypto.randomBytes(32) });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const firstPort = (server.address() as { port: number }).port;
    server.close();
    ORIGIN = `http://localhost:${firstPort}`;
    server = createDashboardServer(dgw, { origin: ORIGIN, rpId: "localhost", stateKey });
    await new Promise<void>((r) => server.listen(firstPort, "127.0.0.1", () => r()));
    edge = new SoftAuthenticator(ORIGIN);
    phone = new SoftAuthenticator(ORIGIN);
  }, 240_000);
  afterAll(async () => { server?.close(); await dgw?.close(); await R?.close(); });
  /**
   * Every test browser comes from 127.0.0.1, so the per-address sign-in limit (30 / 10 min, in the server's memory) would
   * soon refuse them all — as it should. Each test starts a fresh server process image on the same origin; sessions,
   * passkeys and the password live in the database and survive the restart.
   */
  let port = 0;
  const restart = async () => {
    port ||= Number(new URL(ORIGIN).port);
    server.closeAllConnections(); // a kept-alive connection to the old instance must not carry the next request
    await new Promise<void>((r) => server.close(() => r()));
    server = createDashboardServer(dgw, { origin: ORIGIN, rpId: "localhost", stateKey });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
    await new Promise((r) => setTimeout(r, 250)); // the client's pool notices the closed sockets before the next request
  };
  beforeEach(async () => { if (ORIGIN && totpSecret) await restart(); });

  it("the existing route still works: enrollment link → passkey + TOTP, then passkey + TOTP sign-in", async () => {
    const token = crypto.randomBytes(32).toString("base64url");
    await R.q(`SELECT fleet.fleet_admin_dashboard_enroll($1, $2)`, [sha(token), OWNER]);
    edgeB = browser(edge);
    const e = await edgeB.auth.enroll(token, "Desktop Edge");
    expect(e.next).toBe("totp");
    totpSecret = e.totpSecret!;
    afterEnrollment = responses.length;
    await edgeB.auth.confirmTotp(await nextCode());
    await edgeB.auth.loginPasskey();
    // A passkey alone is not a session (checked with the raw cookie jar: the client clears its token on any 401).
    expect((await edgeB.jar(`${ORIGIN}/api/read?op=agents&args=%7B%7D`)).status).toBe(401);
    await edgeB.auth.loginTotp(await nextCode());
    expect(Array.isArray(await edgeB.c.read("agents"))).toBe(true);
  });

  it("before a password is set, the password route refuses with the same generic code", async () => {
    const b = browser();
    expect(await code(b.auth.loginPassword(PASSWORD, await nextCode()))).toBe("FLEET_LOGIN_INVALID");
  });

  it("the owner sets a password from the passkey session: weak refused; a fresh step-up required; CSRF enforced", async () => {
    expect(await code(edgeB.auth.setPassword("short"))).toBe("FLEET_PASSWORD_WEAK");
    // No step-up token → refused; the stored state is unchanged.
    const raw = await edgeB.c.write("/api/account/password", { password: PASSWORD });
    expect(raw.json.code).toBe("FLEET_STEPUP_REQUIRED");
    // Without this tab's CSRF token → refused before anything runs.
    const noCsrf = browser(edge); noCsrf.jar.cookies.clear();
    for (const [k, v] of edgeB.jar.cookies) noCsrf.jar.cookies.set(k, v);
    expect((await noCsrf.c.post("/api/account/password", { password: PASSWORD, stepup: "x".repeat(43) })).json.code).toBe("FLEET_CSRF");
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_admin_password)`))).toBe(0);
    const before = edge.assertions;
    await edgeB.auth.setPassword(PASSWORD);
    expect(edge.assertions).toBe(before + 1); // the step-up really asked the passkey
    const sec = await edgeB.c.read<Record<string, any>>("security");
    expect(sec.password).toMatchObject({ configured: true });
    expect(sec.totp).toEqual({ configured: true });
    expect(JSON.stringify(sec)).not.toMatch(/scrypt|verifier/);
  });

  it("password + correct TOTP from a SEPARATE browser (no passkey at all) gives the same full session; writes need its CSRF token", async () => {
    const ff = browser(null);
    await ff.auth.loginPassword(PASSWORD, await nextCode());
    expect(Array.isArray(await ff.c.read("agents"))).toBe(true);
    const sec = await ff.c.read<Record<string, any>>("security");
    expect(sec.method).toBe("password");
    // An ordinary write works with this browser's token; a foreign Origin never does.
    const id = String(await R.one(`(SELECT notification_id FROM fleet.fleet_notifications ORDER BY created_at DESC LIMIT 1)`));
    expect(await ff.c.call("notification_ack", { id })).toMatchObject({ ok: true });
    const foreign = browserLikeFetch(ORIGIN, { origin: "https://evil.example" });
    for (const [k, v] of ff.jar.cookies) foreign.cookies.set(k, v);
    const r = await foreign(`${ORIGIN}/api/call`, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF": ff.store.get()! }, body: JSON.stringify({ op: "notification_ack", args: JSON.stringify({ id }) }) });
    expect(r.status).toBe(403);
  });

  it("a wrong factor is one generic refusal; the right TOTP code is NOT used up by a wrong password; no session either way", async () => {
    const b = browser(null);
    expect(await code(b.auth.loginPassword(PASSWORD, "000000"))).toBe("FLEET_LOGIN_INVALID");
    const good = await nextCode();
    expect(await code(b.auth.loginPassword("wrong password entirely", good))).toBe("FLEET_LOGIN_INVALID");
    expect(await code(b.auth.loginPassword(PASSWORD, ""))).toBe("FLEET_LOGIN_INVALID"); // password without TOTP
    expect(b.jar.cookies.size).toBe(0);
    expect(await code(b.c.read("agents"))).toBe("FLEET_SESSION_INVALID");
    await b.auth.loginPassword(PASSWORD, good); // the same code still works with the right password
    expect(await code(b.auth.loginPassword(PASSWORD, good))).toBe("FLEET_LOGIN_INVALID"); // …once
  });

  it("step-up with the password route: a sensitive operation with password + code; a wrong code changes nothing", async () => {
    const ff = browser(null);
    await ff.auth.loginPassword(PASSWORD, await nextCode());
    ff.c.stepupConfirm = async () => ({ method: "password", password: PASSWORD, code: "123456" });
    expect(await code(ff.c.call("session_revoke_all", {}))).toBe("FLEET_LOGIN_INVALID");
    expect(await code(edgeB.c.read("agents"))).toBe("OK"); // nothing was revoked
    ff.c.stepupConfirm = () => passwordChoice();
    expect(await ff.c.call("session_revoke_all", {})).toMatchObject({ ok: true });
    expect(await code(edgeB.c.read("agents"))).toBe("FLEET_SESSION_INVALID"); // the other sessions ended
    expect(await code(ff.c.read("agents"))).toBe("OK");
    await edgeB.auth.loginPasskey(); await edgeB.auth.loginTotp(await nextCode()); // the Edge passkey still signs in
  });

  it("several passkeys: add a phone passkey from a password session, sign in with it, rename it", async () => {
    const ff = browser(phone);
    await ff.auth.loginPassword(PASSWORD, await nextCode());
    ff.c.stepupConfirm = () => passwordChoice();
    // Registration is CSRF-protected and needs its own step-up.
    expect((await browser(phone).c.post("/api/passkey/options", {})).status).toBe(401);
    await ff.auth.addPasskey("My Phone");
    const keys = (await ff.c.read<Record<string, any>>("security")).passkeys as Array<Record<string, any>>;
    expect(keys.map((k) => k.name).sort()).toEqual(["Desktop Edge", "My Phone"]);
    const p = browser(phone);
    await p.auth.loginPasskey(); await p.auth.loginTotp(await nextCode());
    expect((await p.c.read<Record<string, any>>("security")).method).toBe("passkey");
    const phoneKey = keys.find((k) => k.name === "My Phone")!;
    expect(await p.c.call("passkey_rename", { credentialId: phoneKey.credentialId, name: "Phone <script>x</script>" })).toMatchObject({ ok: true });
    const renamed = ((await p.c.read<Record<string, any>>("security")).passkeys as Array<Record<string, any>>).find((k) => k.credentialId === phoneKey.credentialId)!;
    expect(renamed.name).toBe("Phone <script>x</script>"); // stored as text; the UI renders text only
    expect(await code(p.c.call("passkey_rename", { credentialId: phoneKey.credentialId, name: "   " }))).toBe("FLEET_BAD_REQUEST");
  });

  it("revoking one passkey: its sessions end and it is rejected; the other passkey and the password still work", async () => {
    const p = browser(phone);
    await p.auth.loginPasskey(); await p.auth.loginTotp(await nextCode());
    const keys = (await p.c.read<Record<string, any>>("security")).passkeys as Array<Record<string, any>>;
    const edgeKey = keys.find((k) => k.name === "Desktop Edge")!;
    expect(await p.c.call("passkey_revoke", { credentialId: edgeKey.credentialId })).toMatchObject({ ok: true });
    expect(await code(edgeB.c.read("agents"))).toBe("FLEET_SESSION_INVALID");
    expect(await code(browser(edge).auth.loginPasskey())).toBe("FLEET_PASSKEY_INVALID");
    const again = browser(phone);
    await again.auth.loginPasskey(); await again.auth.loginTotp(await nextCode());
    const ff = browser(null);
    await ff.auth.loginPassword(PASSWORD, await nextCode());
    expect(await code(ff.c.read("agents"))).toBe("OK");
  });

  it("the owner cannot remove the last way in; the authenticator cannot be removed from the dashboard", async () => {
    const p = browser(phone);
    await p.auth.loginPasskey(); await p.auth.loginTotp(await nextCode());
    expect(await code(p.c.call("totp_reset", {}))).toBe("FLEET_LOCKOUT_PREVENTED");
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_admin_totp WHERE confirmed_at IS NOT NULL)`))).toBe(1);
    // With a password set, the last passkey MAY be revoked deliberately. Without one, never (checked in the database).
    const phoneId = String(await R.one(`(SELECT credential_id FROM fleet.fleet_admin_passkeys WHERE revoked_at IS NULL)`));
    const saved = await R.q(`SELECT * FROM fleet.fleet_admin_password`);
    await R.q(`DELETE FROM fleet.fleet_admin_password`);
    expect(await R.code(R.q(`SELECT fleet.dash_passkey_revoke($1, 'test')`, [phoneId]))).toBe("FLEET_LAST_SIGN_IN_METHOD");
    await R.q(`INSERT INTO fleet.fleet_admin_password (id, verifier, set_at, set_via) VALUES (1, $1, $2, $3)`, [saved[0].verifier, saved[0].set_at, saved[0].set_via]);
    expect(await code(p.c.call("passkey_revoke", { credentialId: phoneId }))).toBe("OK");
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_admin_passkeys WHERE revoked_at IS NULL)`))).toBe(0);
    // The password route alone (with TOTP) still gets in, and state() still reports the Fleet as enrolled.
    const ff = browser(null);
    expect(await ff.auth.state()).toMatchObject({ enrolled: true });
    await ff.auth.loginPassword(PASSWORD, await nextCode());
    expect(await code(ff.c.read("agents"))).toBe("OK");
  });

  it("changing the password ends the other password sessions; recovery: a host link sets a password once; old password refused", async () => {
    const a = browser(null), b = browser(null);
    await a.auth.loginPassword(PASSWORD, await nextCode());
    await b.auth.loginPassword(PASSWORD, await nextCode());
    a.c.stepupConfirm = () => passwordChoice(PASSWORD);
    await a.auth.setPassword(PASSWORD2);
    expect(await code(a.c.read("agents"))).toBe("OK");
    expect(await code(b.c.read("agents"))).toBe("FLEET_SESSION_INVALID");
    expect(await code(browser(null).auth.loginPassword(PASSWORD, await nextCode()))).toBe("FLEET_LOGIN_INVALID");
    // Host recovery: a one-time link sets the password (no passkey needed); TOTP already exists, so it goes to sign-in.
    const token = crypto.randomBytes(32).toString("base64url");
    await R.q(`SELECT fleet.fleet_admin_dashboard_enroll($1, $2)`, [sha(token), OWNER]);
    const rec = browser(null);
    expect(await code(rec.auth.enrollPassword(token, "short"))).toBe("FLEET_PASSWORD_WEAK");
    expect(await rec.auth.enrollPassword(token, PASSWORD)).toEqual({ next: "login", totpSecret: undefined, otpauth: undefined });
    expect(await code(rec.auth.enrollPassword(token, PASSWORD))).toBe("FLEET_ENROLLMENT_INVALID"); // one-time
    await rec.auth.loginPassword(PASSWORD, await nextCode());
    expect(await code(rec.c.read("agents"))).toBe("OK");
  });

  it("a session past its idle limit is refused; a fresh tab without a token cannot write (verify this tab)", async () => {
    const s = browser(null);
    await s.auth.loginPassword(PASSWORD, await nextCode());
    const tab = browser(null);
    for (const [k, v] of s.jar.cookies) tab.jar.cookies.set(k, v);
    expect(await code(tab.c.read("agents"))).toBe("OK");
    const id = String(await R.one(`(SELECT notification_id FROM fleet.fleet_notifications ORDER BY created_at LIMIT 1)`));
    expect(await code(tab.c.call("notification_ack", { id }))).toBe("FLEET_TAB_UNVERIFIED");
    await R.q(`UPDATE fleet.fleet_admin_sessions SET last_seen_at = now() - interval '31 minutes' WHERE method = 'password' AND ended_at IS NULL`);
    expect(await code(s.c.read("agents"))).toBe("FLEET_SESSION_INVALID");
  });

  it("no password, verifier or TOTP secret appears in any response or the audit log", async () => {
    const all = responses.slice(afterEnrollment).join("\n");
    for (const secret of [PASSWORD, PASSWORD2, "scrypt$", totpSecret]) expect(all.includes(secret), secret.slice(0, 8)).toBe(false);
    const log = JSON.stringify(await R.q(`SELECT * FROM fleet.fleet_admin_auth_log`));
    for (const secret of [PASSWORD, PASSWORD2, "scrypt$", totpSecret]) expect(log.includes(secret), secret.slice(0, 8)).toBe(false);
    expect(log).toMatch(/password_set/);
  });

  describe("notifications: acknowledge, then delete (acknowledged only), tombstone, counts", () => {
    let c: GatewayClient;
    const ids: string[] = [];
    const inbox = async () => (await c.read<Record<string, any>>("notifications", { limit: 500 }));
    beforeAll(async () => {
      const b = browser(null);
      await b.auth.loginPassword(PASSWORD, await nextCode());
      c = b.c;
      for (let i = 0; i < 5; i++) {
        await R.q(`SELECT fleet.fleet_notify('AMBER', 'TEST_HOUSEKEEPING', NULL, $1, '{"note":"fixture"}'::jsonb, $2)`, [`Housekeeping test ${i} <b>bold</b>`, `test-housekeeping:${i}`]);
        ids.push(String(await R.one(`(SELECT notification_id FROM fleet.fleet_notifications WHERE dedupe_key = $1)`, [`test-housekeeping:${i}`])));
      }
    }, 120_000); // signing in may wait for a fresh authenticator step

    it("an unread notification is not deleted without an explicit acknowledge-and-delete; acknowledged ones are", async () => {
      const r = await c.call<Record<string, any>>("notification_delete", { ids: [ids[0]], acknowledgeUnread: false });
      expect(r).toMatchObject({ ok: true, deleted: 0, refusedUnread: [ids[0]] });
      await c.call("notification_ack", { id: ids[1] });
      expect(await c.call("notification_delete", { ids: [ids[1]], acknowledgeUnread: false })).toMatchObject({ deleted: 1 });
      expect(await c.call("notification_delete", { ids: [ids[0]], acknowledgeUnread: true })).toMatchObject({ deleted: 1 });
      expect(await c.call("notification_delete", { ids: [ids[0], ids[1]], acknowledgeUnread: true })).toMatchObject({ deleted: 0, alreadyDeleted: 2 }); // idempotent
    });

    it("deleted rows leave the inbox, its counts, Acknowledge all and the detail read; a minimal attributed tombstone remains", async () => {
      const box = await inbox();
      const listed = (box.notifications as Array<Record<string, any>>).map((n) => n.notification_id);
      expect(listed).not.toContain(ids[0]); expect(listed).not.toContain(ids[1]);
      expect(box.inbox.total).toBe(listed.length);
      expect(await c.read("notification_get", { id: ids[0] })).toMatchObject({ deleted: true });
      expect(await c.read<Record<string, any>>("notification_get", { id: ids[2] })).toMatchObject({ code: "TEST_HOUSEKEEPING", title: "Housekeeping test 2 <b>bold</b>" });
      const t = (await R.q(`SELECT * FROM fleet.fleet_notifications WHERE notification_id = $1`, [ids[0]]))[0];
      expect(t).toMatchObject({ class: "AMBER", code: "TEST_HOUSEKEEPING", title: "Deleted notification", detail: {}, deleted_by: "operator:owner", acknowledged_by: "operator:owner" });
      expect(t.deleted_at).not.toBeNull(); expect(t.acknowledged_at).not.toBeNull(); expect(t.created_at).not.toBeNull();
      expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_events WHERE event_type = 'notifications_deleted')`))).toBeGreaterThan(0);
      // The producer does not raise it again (its dedupe key is kept).
      expect(await R.one(`fleet.fleet_notify('AMBER', 'TEST_HOUSEKEEPING', NULL, 'again', '{}'::jsonb, 'test-housekeeping:0')`)).toBe(false);
      // A deleted notification cannot be acknowledged again or emailed.
      expect(await c.call("notification_ack", { id: ids[0] })).toMatchObject({ ok: false });
    });

    it("delete selected, then delete all acknowledged; repeats are harmless; unread ones stay", async () => {
      await c.call("notification_ack", { id: ids[2] });
      await c.call("notification_ack", { id: ids[3] });
      expect(await c.call("notification_delete", { ids: [ids[2]], acknowledgeUnread: false })).toMatchObject({ deleted: 1 });
      const all = await c.call<Record<string, any>>("notification_delete_acknowledged", {});
      expect(all.deleted).toBeGreaterThanOrEqual(1); // ids[3] (and any other acknowledged ones)
      expect(await c.call("notification_delete_acknowledged", {})).toMatchObject({ deleted: 0 });
      const box = await inbox();
      expect((box.notifications as Array<Record<string, any>>).every((n) => !n.acknowledged_at)).toBe(true);
      expect((box.notifications as Array<Record<string, any>>).map((n) => n.notification_id)).toContain(ids[4]);
      expect(box.inbox.acknowledged).toBe(0);
    });
  });

  it("the per-address sign-in rate limit applies to the password route", async () => {
    const b = browser(null);
    const codes: string[] = [];
    for (let i = 0; i < 31; i++) codes.push(await code(b.c.post("/api/auth/state", {}).then((r) => { if (!r.json.ok) throw new FleetApiError(r.json.code); })));
    expect(codes).toContain("FLEET_RATE_LIMITED");
    expect(await code(b.auth.loginPassword(PASSWORD, "000000"))).toBe("FLEET_RATE_LIMITED");
  });

  it("finally, the lockout counts password failures: after 20 failures BOTH routes are locked", async () => {
    const b = browser(null);
    for (let i = 0; i < 20; i++) await code(b.auth.loginPassword(`wrong ${i} password here`, "000000"));
    expect(await b.auth.state()).toMatchObject({ locked: true });
    expect(await code(b.auth.loginPassword(PASSWORD, await nextCode()))).toBe("FLEET_ADMIN_LOCKED");
    expect(await code(browser(phone).auth.loginPasskey())).toBe("FLEET_ADMIN_LOCKED");
  });
});

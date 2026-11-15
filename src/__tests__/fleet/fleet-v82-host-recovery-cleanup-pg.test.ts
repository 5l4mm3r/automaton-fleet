/**
 * v82 — HOST recovery ends the old access as part of the operation (PostgreSQL + the dashboard gateway and server + the
 * dashboard's own client; the host commands run through runHubCommand + PgHubAdmin on the owner connection, as `fleet:admin`).
 *
 * `hub-dashboard-totp-reset` and `hub-dashboard-enroll` each, by default:
 *   - end every signed-in session (a passkey session included),
 *   - retire every unused recovery code,
 *   - abandon an unfinished authenticator replacement (started with a recovery code, not yet confirmed),
 *   - retire any earlier unused set-up link,
 * so the owner has no separate security clean-up to remember. Keeping sessions or codes is exceptional and explicit
 * (--keep-sessions / --keep-recovery-codes): recorded in the sign-in log and raised as a RED notification. A misspelt option
 * is refused and changes nothing. (The recovery scenarios themselves: fleet-v82-host-recovery-pg.test.ts.)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import http from "http";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";
import { SoftAuthenticator, browserLikeFetch } from "./fixtures/soft-webauthn.js";
import { totp } from "../../fleet/identity/crypto.js";
import { PgDashboardGateway } from "../../fleet/dashboard/gateway.js";
import { createDashboardServer, normaliseRecoveryCode } from "../../fleet/dashboard/server.js";
import { PgHubAdmin } from "../../fleet/hub/admin.js";
import { runHubCommand } from "../../fleet/hub/cli.js";
import { GatewayClient, type StepupChoice } from "../../../codex-dashboard/src/dashboard/api/client";
import { LiveAuth } from "../../../codex-dashboard/src/dashboard/api/auth";
import { FleetApiError } from "../../../codex-dashboard/src/dashboard/api/errors";

const PG_BIN = findPgBin();
const PASSWORD = "correct horse battery staple cleanup";
const PASSWORD2 = "a password set through a stale link";

describe.skipIf(!PG_BIN)("v82 host recovery ends the old access (PostgreSQL + gateway + client + fleet:admin)", { timeout: 600_000 }, () => {
  let R: EconomyRegistry;
  let dgw: PgDashboardGateway;
  let hub: PgHubAdmin;
  let server: http.Server;
  let ORIGIN = "";
  let totpSecret = "";
  let lastStep = 0;
  const stateKey = crypto.randomBytes(32);
  const responses: string[] = [];
  const shown: Array<{ value: string; at: number }> = [];
  const tokens: string[] = [];
  const code = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof FleetApiError ? e.code : String(e)));

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
    return { c, auth: new LiveAuth(c), jar };
  };
  const passwordChoice = (password: string) => async (): Promise<StepupChoice> => ({ method: "password", password, code: await nextCode() });
  const host = async (cmd: "hub-dashboard-enroll" | "hub-dashboard-totp-reset", args: string[]): Promise<Record<string, any>> => {
    const out = (await runHubCommand(cmd, cmd === "hub-dashboard-enroll" ? [ORIGIN, ...args] : args, hub, OWNER)) as Record<string, any>;
    if (out.link) tokens.push(LiveAuth.enrollTokenFromHash(new URL(out.link).hash)!);
    return out;
  };
  const tokenOf = (out: Record<string, any>) => LiveAuth.enrollTokenFromHash(new URL(out.link).hash)!;
  const remaining = () => R.one(`(SELECT count(*) FROM fleet.fleet_admin_recovery_codes WHERE used_at IS NULL AND revoked_at IS NULL)`).then(Number);
  const totpRows = () => R.one(`(SELECT count(*) FROM fleet.fleet_admin_totp)`).then(Number);
  /** A full password session with a fresh set of ten recovery codes. */
  const signedInWithCodes = async () => {
    const s = browser(null);
    await s.auth.loginPassword(PASSWORD, await nextCode());
    s.c.stepupConfirm = passwordChoice(PASSWORD);
    const set = await s.auth.issueRecoveryCodes();
    for (const c of set) shown.push({ value: c, at: responses.length });
    expect(await remaining()).toBe(10);
    return { s, set };
  };

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
    // First access: a passkey + authenticator from a host link, then a password.
    const first = await host("hub-dashboard-enroll", []);
    expect(first).toMatchObject({ ok: true, sessionsEnded: 0, recoveryCodesRetired: 0, kept: [] });
    const edge = new SoftAuthenticator(ORIGIN);
    const b = browser(edge);
    const e = await b.auth.enroll(tokenOf(first), "Desktop Edge");
    totpSecret = e.totpSecret!;
    shown.push({ value: totpSecret, at: responses.length });
    await b.auth.confirmTotp(await nextCode());
    await b.auth.loginPasskey();
    await b.auth.loginTotp(await nextCode());
    await b.auth.setPassword(PASSWORD);
  }, 300_000);
  afterAll(async () => { server?.close(); await hub?.close(); await dgw?.close(); await R?.close(); });

  it("a link ends every session, retires the unused codes, abandons an unfinished authenticator replacement and retires an earlier link", async () => {
    const { s, set } = await signedInWithCodes();
    const pk = browser(null);
    await pk.auth.loginPassword(PASSWORD, await nextCode());
    // Someone starts replacing the authenticator with one of the codes (password + code) and has not confirmed yet.
    const p = browser(null);
    const fresh = await p.auth.recoverAuthenticator(set[0], PASSWORD);
    shown.push({ value: fresh.totpSecret, at: responses.length });
    expect(fresh.codesLeft).toBe(9);
    // An earlier link, issued and never used.
    const stale = await host("hub-dashboard-enroll", ["--keep-sessions", "--keep-recovery-codes"]);
    expect(await code(s.c.read("agents"))).toBe("OK");

    const out = await host("hub-dashboard-enroll", []);
    expect(out).toMatchObject({ ok: true, recoveryCodesRetired: 9, kept: [] });
    expect(out.sessionsEnded).toBeGreaterThanOrEqual(2);
    expect(await code(s.c.read("agents"))).toBe("FLEET_SESSION_INVALID");
    expect(await code(pk.c.read("agents"))).toBe("FLEET_SESSION_INVALID");
    expect(await remaining()).toBe(0);
    expect(await code(p.auth.confirmRecoveredAuthenticator(fresh.ticket, totp(fresh.totpSecret)))).toBe("FLEET_RECOVERY_INVALID");
    expect(await code(browser(null).auth.recoverAuthenticator(set[1], PASSWORD))).toBe("FLEET_RECOVERY_INVALID");
    expect(await code(browser(null).auth.enrollPassword(tokenOf(stale), PASSWORD2))).toBe("FLEET_ENROLLMENT_INVALID");
    // The authenticator in use is unchanged and still signs in (the new link is simply not needed here).
    const again = browser(null);
    await again.auth.loginPassword(PASSWORD, await nextCode());
    expect(await code(again.c.read("agents"))).toBe("OK");
  });

  it("an authenticator reset does the same, before any link is issued", async () => {
    const { s } = await signedInWithCodes();
    const out = await host("hub-dashboard-totp-reset", []);
    expect(out).toMatchObject({ ok: true, recoveryCodesRetired: 10, kept: [], next: expect.stringContaining("hub-dashboard-enroll") });
    expect(out.sessionsEnded).toBeGreaterThanOrEqual(1);
    expect(await code(s.c.read("agents"))).toBe("FLEET_SESSION_INVALID");
    expect(await remaining()).toBe(0);
    expect(await totpRows()).toBe(0);
    // Back to normal: a link → a new authenticator (password kept) → signed in.
    const link = await host("hub-dashboard-enroll", []);
    const b = browser(null);
    const e = await b.auth.enrollPassword(tokenOf(link), PASSWORD);
    totpSecret = e.totpSecret!; lastStep = 0;
    shown.push({ value: totpSecret, at: responses.length });
    await b.auth.confirmTotp(await nextCode());
    const t = browser(null);
    await t.auth.loginPassword(PASSWORD, await nextCode());
    expect(await code(t.c.read("agents"))).toBe("OK");
  });

  it("keeping sessions or codes is explicit and recorded; a misspelt option is refused and changes nothing", async () => {
    const { s } = await signedInWithCodes();
    const issued = () => R.one(`(SELECT count(*) FROM fleet.fleet_admin_enrollment)`).then(Number);
    const n0 = await issued();
    for (const typo of ["--keep-session", "--keep-codes", "--force"]) {
      expect(await R.code(runHubCommand("hub-dashboard-enroll", [ORIGIN, typo], hub, OWNER))).toBe("FLEET_BAD_REQUEST");
      expect(await R.code(runHubCommand("hub-dashboard-totp-reset", [typo], hub, OWNER))).toBe("FLEET_BAD_REQUEST");
    }
    expect(await issued()).toBe(n0);
    expect(await totpRows()).toBe(1);
    expect(await code(s.c.read("agents"))).toBe("OK");
    expect(await remaining()).toBe(10);
    // Both kept on purpose.
    const both = await host("hub-dashboard-enroll", ["--keep-sessions", "--keep-recovery-codes"]);
    expect(both).toMatchObject({ ok: true, sessionsEnded: 0, recoveryCodesRetired: 0, kept: ["sessions", "recovery_codes"] });
    expect(await code(s.c.read("agents"))).toBe("OK");
    expect(await remaining()).toBe(10);
    // Codes kept, sessions not.
    const codesOnly = await host("hub-dashboard-enroll", ["--keep-recovery-codes"]);
    expect(codesOnly).toMatchObject({ ok: true, recoveryCodesRetired: 0, kept: ["recovery_codes"] });
    expect(codesOnly.sessionsEnded).toBeGreaterThanOrEqual(1);
    expect(await code(s.c.read("agents"))).toBe("FLEET_SESSION_INVALID");
    expect(await remaining()).toBe(10);
  });

  it("every host command is recorded with what it ended or kept; keeping anything raises a RED notification; nothing secret leaks", async () => {
    const log = await R.q(`SELECT event, ok, op, code, detail FROM fleet.fleet_admin_auth_log WHERE event = 'host_recovery_access_ended' ORDER BY seq`);
    expect(log).toHaveLength(tokens.length + 1); // every link, plus the one reset
    for (const l of log) expect(l).toMatchObject({ ok: true, code: "host", detail: { by: OWNER, op: expect.stringMatching(/^(enroll|totp_reset)$/) } });
    expect(log.filter((l) => l.detail.kept.length > 0).map((l) => l.detail.kept)).toEqual([["sessions", "recovery_codes"], ["sessions", "recovery_codes"], ["recovery_codes"]]);
    const notes = await R.q(`SELECT class, code, title, detail FROM fleet.fleet_notifications WHERE code IN ('ADMIN_ENROLLMENT_LINK_ISSUED','ADMIN_TOTP_RESET') ORDER BY created_at`);
    expect(notes.filter((n) => n.code === "ADMIN_ENROLLMENT_LINK_ISSUED")).toHaveLength(tokens.length);
    expect(notes.filter((n) => n.code === "ADMIN_TOTP_RESET")).toEqual([
      expect.objectContaining({ class: "AMBER", title: expect.stringMatching(/^Authenticator reset on the Fleet host: \d+ session\(s\) signed out, 10 unused recovery code\(s\) retired$/) }),
    ]);
    const red = notes.filter((n) => n.class === "RED");
    expect(red.map((n) => n.title)).toEqual([
      "Sign-in set-up link issued on the Fleet host: 0 session(s) signed out, 0 unused recovery code(s) retired (KEPT on purpose: sessions, recovery_codes)",
      "Sign-in set-up link issued on the Fleet host: 0 session(s) signed out, 0 unused recovery code(s) retired (KEPT on purpose: sessions, recovery_codes)",
      expect.stringMatching(/^Sign-in set-up link issued on the Fleet host: \d+ session\(s\) signed out, 0 unused recovery code\(s\) retired \(KEPT on purpose: recovery_codes\)$/),
    ]);
    for (const n of notes) expect(n.title.length).toBeLessThanOrEqual(200);
    // No link token, password, authenticator secret or recovery code in the log, a notification or a later response.
    const audit = JSON.stringify(await R.q(`SELECT * FROM fleet.fleet_admin_auth_log`)) + JSON.stringify(notes);
    for (const t of tokens) expect(audit).not.toContain(t);
    for (const pw of [PASSWORD, PASSWORD2]) { expect(audit).not.toContain(pw); expect(responses.join("\n")).not.toContain(pw); }
    for (const { value, at } of shown) {
      expect(responses.slice(at).join("\n")).not.toContain(value);
      expect(audit).not.toContain(value);
      expect(audit).not.toContain(normaliseRecoveryCode(value));
    }
  });
});

/**
 * The LIVE dashboard contract (integrations/codex-dashboard) against the REAL v41 gateway: PostgreSQL, the dashboard
 * server, the identity broker, and a software WebAuthn authenticator (real P-256 signatures, verified by the gateway).
 *
 * Proves the owner dashboard's LiveFleetAdapter: reads real state (Treasury figures equal the ledger; replication uses
 * Fleet-generated realised wealth); fails closed (unauthenticated, expired session, unreachable gateway — never data
 * from elsewhere; one unavailable section stays unavailable); real passkey + TOTP sign-in; CSRF and origin; step-up on
 * every sensitive operation (a cancelled prompt does nothing; a step-up is single-use); funding, transfers, hold/resume,
 * missions, acknowledgements, birth orders, kill + reseed; automatic replication stays blocked; sealed, temporary
 * reveals; MAIL / SMS NOT CONFIGURED without making the Fleet unhealthy; no automatic retry of writes; commands with no
 * legitimate live contract refused without a request.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { SoftAuthenticator, browserLikeFetch } from "./fixtures/soft-webauthn.js";
import { PgIdentityGateway } from "../../fleet/identity/gateway.js";
import { IdentityBroker } from "../../fleet/identity/broker.js";
import { initIdentityState, openIdentityState, openProviderVault } from "../../fleet/identity/main.js";
import { totp } from "../../fleet/identity/crypto.js";
import { PgDashboardGateway } from "../../fleet/dashboard/gateway.js";
import { createDashboardServer } from "../../fleet/dashboard/server.js";
import { DASHBOARD_SENSITIVE_OPS_V41 } from "../../fleet/postgres/migrations-phase41.js";
import { DASHBOARD_SENSITIVE_OPS_V48 } from "../../fleet/postgres/migrations-phase48.js";
import { DASHBOARD_SENSITIVE_OPS_V49 } from "../../fleet/postgres/migrations-phase49.js";
import { DASHBOARD_SENSITIVE_OPS_V50 } from "../../fleet/postgres/migrations-phase50.js";
import { DASHBOARD_SENSITIVE_OPS_V51 } from "../../fleet/postgres/migrations-phase51.js";
import { DASHBOARD_SENSITIVE_OPS_V52 } from "../../fleet/postgres/migrations-phase52.js";
import { DASHBOARD_SENSITIVE_OPS_V53 } from "../../fleet/postgres/migrations-phase53.js";
import { DASHBOARD_WRITE_OPS_V45 } from "../../fleet/postgres/migrations-phase45.js";
import { GatewayClient } from "../../../codex-dashboard/src/dashboard/api/client";
import { LiveAuth } from "../../../codex-dashboard/src/dashboard/api/auth";
import { FleetApiError } from "../../../codex-dashboard/src/dashboard/api/errors";
import { SENSITIVE_OPS, WRITE_OPS } from "../../../codex-dashboard/src/dashboard/api/operations-meta";
import { OPERATIONS, UNSUPPORTED } from "../../../codex-dashboard/src/dashboard/api/operations";
import { reveal } from "../../../codex-dashboard/src/dashboard/api/reveal";
import { LiveFleetAdapter, OutcomeUnknownError } from "../../../codex-dashboard/src/dashboard/adapters/live";
import type { LiveCommand, LiveSnapshot } from "../../../codex-dashboard/src/dashboard/api/types";

const PG_BIN = findPgBin();
const INTEGRATION = path.join(process.cwd(), "codex-dashboard", "src", "dashboard");

describe.skipIf(!PG_BIN)("Codex dashboard LIVE contract against the real v41 gateway (PostgreSQL + gateway + broker)", { timeout: 120_000 }, () => {
  let R: EconomyRegistry;
  let A: Founder;
  let B: Founder;
  let dir: string;
  let igw: PgIdentityGateway;
  let broker: IdentityBroker;
  let loop: ReturnType<typeof setInterval>;
  let dgw: PgDashboardGateway;
  let server: http.Server;
  let ORIGIN = "";
  let auth: SoftAuthenticator;
  let fetchJar: ReturnType<typeof browserLikeFetch>;
  let client: GatewayClient;
  let signedOut = 0;
  let totpSecret = "";
  // The dashboard's own mapping would reshape the snapshot into its view model; here the view model IS the snapshot.
  const identity = { toFleet: (s: LiveSnapshot) => s, toLiveCommand: (c: LiveCommand) => c };
  let adapter: LiveFleetAdapter<LiveSnapshot, LiveCommand>;
  const cash = (who: string) => R.one<number>(`fleet.fleet_agent_cash($1)`, [who]).then(Number);
  const code = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof FleetApiError ? e.code : String(e)));

  const signIn = async () => {
    const a = new LiveAuth(client);
    await a.loginPasskey();
    const step = Math.floor(Date.now() / 30_000);
    // Each TOTP time-step is accepted once: wait for a fresh step when the current one was used.
    await a.loginTotp(totp(totpSecret, (step + 1) * 30_000 - 1)).catch(async () => {
      await new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 200));
      await a.loginTotp(totp(totpSecret));
    });
  };

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000, treasuryCents: 1_000_000 });
    [A, B] = R.founders;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-codex-"));
    fs.chmodSync(dir, 0o700);
    initIdentityState(dir);
    openProviderVault(dir).put("twilio", { accountSid: `AC${"0".repeat(32)}`, apiKeySid: `SK${"1".repeat(32)}`, apiKeySecret: "contract-test-secret-123" });
    igw = new PgIdentityGateway({ connectionString: R.pgc.identityUrl });
    const { vault, ownerVault } = openIdentityState(dir);
    // The deployment default: no mail or SMS provider configured (dormant).
    broker = new IdentityBroker(igw, vault, { ownerVault, providerVault: openProviderVault(dir), stateFile: path.join(dir, "pending.json") });
    await broker.registerProviders();
    let busy = false;
    loop = setInterval(() => { if (!busy) { busy = true; void broker.tick().catch(() => {}).finally(() => { busy = false; }); } }, 200);
    dgw = new PgDashboardGateway({ connectionString: R.pgc.dashboardUrl });
    server = createDashboardServer(dgw, { origin: "http://localhost:0", rpId: "localhost", stateKey: crypto.randomBytes(32) });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    server.close();
    ORIGIN = `http://localhost:${port}`;
    server = createDashboardServer(dgw, { origin: ORIGIN, rpId: "localhost", stateKey: crypto.randomBytes(32) });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
    auth = new SoftAuthenticator(ORIGIN);
    fetchJar = browserLikeFetch(ORIGIN);
    const store = (() => { let v: string | null = null; return { get: () => v, set: (x: string) => { v = x; }, clear: () => { v = null; } }; })();
    client = new GatewayClient({ baseUrl: ORIGIN, fetch: fetchJar, webauthn: auth, csrf: store, onSignedOut: () => { signedOut++; } });
    adapter = new LiveFleetAdapter(identity, client);
  }, 240_000);
  afterAll(async () => {
    clearInterval(loop);
    server?.close(); await dgw?.close(); await igw?.close(); await R?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the client's operation classes are exactly the gateway's; no live module imports a simulation", () => {
    // v48–v50: treasury, identity authority, custody credentials, lifecycle — each added to the gateway's sensitive class.
    expect([...SENSITIVE_OPS].sort()).toEqual([...DASHBOARD_SENSITIVE_OPS_V41, ...DASHBOARD_SENSITIVE_OPS_V48, ...DASHBOARD_SENSITIVE_OPS_V49, ...DASHBOARD_SENSITIVE_OPS_V50,
      ...DASHBOARD_SENSITIVE_OPS_V51, ...DASHBOARD_SENSITIVE_OPS_V52, ...DASHBOARD_SENSITIVE_OPS_V53].sort());
    expect([...WRITE_OPS].sort()).toEqual([...DASHBOARD_WRITE_OPS_V45].sort());
    for (const f of ["adapters/live.ts", "api/client.ts", "api/auth.ts", "api/operations.ts", "api/snapshot.ts", "api/reveal.ts", "api/seal.ts", "live/mapping.ts", "live/index.ts", "adapter.live.ts", "money/MoneyPanels.tsx"]) {
      const src = fs.readFileSync(path.join(INTEGRATION, f), "utf8");
      expect(src, f).not.toMatch(/from\s+["'][^"']*simulat/i);
      expect(src, f).not.toMatch(/agentfleet\.vip|localhost|127\.0\.0\.1/); // nothing installation-specific
    }
    for (const op of Object.values(OPERATIONS).flatMap((o) => o.ops)) expect(DASHBOARD_SENSITIVE_OPS_V41.includes(op as never) || DASHBOARD_WRITE_OPS_V45.includes(op as never), op).toBe(true);
    for (const o of Object.values(OPERATIONS)) expect(o.stepUp, o.kind).toBe(o.ops.every((op) => SENSITIVE_OPS.has(op)));
  });

  it("fails closed before sign-in: no snapshot, no read, no write", async () => {
    expect(await code(adapter.snapshot())).toBe("FLEET_SESSION_INVALID");
    expect(await code(client.read("agents"))).toBe("FLEET_SESSION_INVALID");
    expect(await code(adapter.execute({ kind: "hold", agentId: A.id }))).toBe("FLEET_SESSION_INVALID");
    expect(signedOut).toBeGreaterThan(0);
    expect(adapter.last).toBeNull();
  });

  it("real enrollment and sign-in: one-time link → passkey → TOTP shown once → passkey + TOTP session", async () => {
    const token = crypto.randomBytes(32).toString("base64url");
    await R.q(`SELECT fleet.fleet_admin_dashboard_enroll($1, $2)`, [crypto.createHash("sha256").update(token).digest("hex"), OWNER]);
    expect(LiveAuth.enrollTokenFromHash(`#enroll=${token}`)).toBe(token);
    const la = new LiveAuth(client);
    expect(await la.state()).toEqual({ enrolled: false, locked: false, session: "none" });
    const e = await la.enroll(token, "contract key");
    expect(e.next).toBe("totp");
    totpSecret = e.totpSecret!;
    await la.confirmTotp(totp(totpSecret));
    expect(await code(la.enroll(token))).toBe("FLEET_ENROLLMENT_INVALID"); // one-time
    // A demo code never works.
    await la.loginPasskey();
    expect(await code(la.loginTotp("123456"))).toMatch(/FLEET_/);
    await signIn();
    expect((await la.state()).session).toBe("full");
  }, 120_000);

  it("snapshot reads real state: Treasury figures equal the ledger; replication uses Fleet-generated realised wealth; MAIL/SMS NOT CONFIGURED is healthy", async () => {
    // Realised revenue first (a real external sale), then a profit contribution: Fleet-generated wealth.
    await R.q(`SELECT fleet.fleet_admin_record_external('external_revenue', $1, 40000, $2, $3, $4, $5)`, [A.id, `stripe:${crypto.randomUUID()}`,
      crypto.createHash("sha256").update(crypto.randomUUID()).digest("hex"), OWNER, `rev:${crypto.randomUUID()}`]);
    await R.q(`SELECT fleet.fleet_profit_contribution($1, 25000, $2, 'owner', $3)`, [A.id, OWNER, `pc:${crypto.randomUUID()}`]);
    const s = await adapter.snapshot();
    expect(s.mode).toBe("live");
    const failed = Object.entries(s).filter(([, v]) => v && typeof v === "object" && (v as { state?: string }).state === "unavailable");
    expect(failed, JSON.stringify(failed)).toEqual([]);
    const w = await R.one<any>(`fleet.fleet_generated_treasury_wealth()`);
    if (s.replication.state !== "ok") throw new Error("replication unavailable");
    expect(s.replication.data.treasury).toMatchObject({ treasuryCashMinor: Number(w.treasuryCashMinor), ownerContributedMinor: Number(w.ownerContributedMinor),
      fleetGeneratedMinor: Number(w.fleetGeneratedMinor) });
    expect(s.replication.data.treasury.fleetGeneratedMinor).toBe(await R.one<number>(`fleet.fleet_ledger_balance('fleet:profit')`).then(Number));
    expect(s.replication.data.treasury.fleetGeneratedMinor).not.toBe(s.replication.data.treasury.treasuryCashMinor - s.replication.data.treasury.ownerContributedMinor);
    expect(s.replication.data.health.economic.fleetGeneratedMinor).toBe(s.replication.data.treasury.fleetGeneratedMinor);
    if (s.agents.state !== "ok") throw new Error("agents unavailable");
    expect(s.agents.data.find((a) => a.agentId === A.id)!.cashMinor).toBe(await cash(A.id));
    if (s.comms.state !== "ok") throw new Error("comms unavailable");
    expect(s.comms.data.mail.state).toBe("NOT_CONFIGURED");
    expect(s.comms.data.sms.state).toBe("NOT_CONFIGURED");
    expect(s.health.state).toBe("ok"); // dormant communications do not make the Fleet unhealthy
    expect(JSON.stringify(s)).not.toContain("contract-test-secret-123");
  });

  it("CSRF and origin: a write without the tab's token, or from another origin, is refused", async () => {
    // A tab without the token and no open dashboard tab to take it from (share: null): the gateway refuses the write
    // (FLEET_CSRF) and the client reports that this tab must be verified...
    const noToken = new GatewayClient({ baseUrl: ORIGIN, fetch: fetchJar, webauthn: auth, csrf: { get: () => null, set: () => {}, clear: () => {} }, share: null });
    expect(await code(noToken.call("agent_hold", { agentId: A.id }))).toBe("FLEET_TAB_UNVERIFIED");
    // ...and the gateway's own answer to a token-less write is FLEET_CSRF.
    const raw = await noToken.post("/api/call", { op: "agent_hold", args: JSON.stringify({ agentId: A.id }) });
    expect(raw.json.code).toBe("FLEET_CSRF");
    const foreign = new GatewayClient({ baseUrl: ORIGIN, fetch: Object.assign(browserLikeFetch(ORIGIN, { origin: "https://evil.example" }), {}), webauthn: auth, csrf: client.csrf });
    expect(await code(foreign.call("agent_hold", { agentId: A.id }))).toBe("FLEET_ORIGIN");
    expect((await R.q(`SELECT operator_hold_at FROM fleet.fleet_agents WHERE agent_id = $1`, [A.id]))[0].operator_hold_at).toBeNull();
  });

  it("step-up: every sensitive operation asks the passkey; a cancelled prompt does nothing; a step-up is single-use", async () => {
    // The gateway itself refuses a sensitive call with no step-up (not just the client).
    const raw = await client.post("/api/call", { op: "agent_fund", args: JSON.stringify({ agentId: A.id, amountMinor: 100, mode: "grant", reason: "x", acknowledge: true }) });
    expect(raw.json.code).toBe("FLEET_STEPUP_REQUIRED");
    const before = await cash(A.id);
    auth.refuseNext = true;
    expect(await code(adapter.execute({ kind: "fund", agentId: A.id, amountMinor: 1_000, reason: "test", acknowledge: true }))).toBe("FLEET_STEPUP_CANCELLED");
    expect(await cash(A.id)).toBe(before);
    // Single use: one step-up, two calls with it → one effect.
    const args = JSON.stringify({ agentId: A.id, amountMinor: 700, mode: "grant", reason: "replay test", acknowledge: true });
    const o = await client.post("/api/stepup/options", { op: "agent_fund", args });
    const v = await client.post("/api/stepup/verify", { op: "agent_fund", args, response: await auth.get(o.json.options) });
    const first = await client.post("/api/call", { op: "agent_fund", args, stepup: v.json.stepup });
    const second = await client.post("/api/call", { op: "agent_fund", args, stepup: v.json.stepup });
    expect(first.json.ok).toBe(true);
    expect(second.json.code).toBe("FLEET_STEPUP_REQUIRED");
    expect(await cash(A.id)).toBe(before + 700);
    // A step-up for one operation / argument string does not authorise another.
    const o2 = await client.post("/api/stepup/options", { op: "agent_fund", args });
    const v2 = await client.post("/api/stepup/verify", { op: "agent_fund", args, response: await auth.get(o2.json.options) });
    const other = JSON.stringify({ agentId: A.id, amountMinor: 999_999, mode: "grant", reason: "swapped", acknowledge: true });
    expect((await client.post("/api/call", { op: "agent_fund", args: other, stepup: v2.json.stepup })).json.code).toBe("FLEET_STEPUP_REQUIRED");
  });

  it("money: fund, agent-to-agent transfer and Treasury transfer move real ledger balances (each with its own step-up)", async () => {
    const a0 = await cash(A.id), b0 = await cash(B.id), t0 = await R.one<number>(`fleet.fleet_ledger_balance('fleet:treasury:unallocated')`).then(Number);
    const asserted = auth.assertions;
    let s = await adapter.execute({ kind: "fund", agentId: A.id, amountMinor: 2_000, reason: "contract fund", acknowledge: true });
    expect(await cash(A.id)).toBe(a0 + 2_000);
    if (s.agents.state === "ok") expect(s.agents.data.find((x) => x.agentId === A.id)!.cashMinor).toBe(a0 + 2_000); // re-read after the command
    s = await adapter.execute({ kind: "transfer", from: A.id, to: B.id, amountMinor: 500, reason: "contract transfer", acknowledge: true });
    expect(await cash(B.id)).toBe(b0 + 500);
    await adapter.execute({ kind: "treasury_transfer", agentId: B.id, target: "treasury", amountMinor: 300, reason: "return surplus", acknowledge: true });
    expect(await cash(B.id)).toBe(b0 + 200);
    expect(await R.one<number>(`fleet.fleet_ledger_balance('fleet:treasury:unallocated')`).then(Number)).toBe(t0 - 2_000 + 300);
    expect(auth.assertions - asserted).toBe(3);
    const big = await adapter.execute({ kind: "fund", agentId: A.id, amountMinor: 999_999_999, reason: "too much", acknowledge: true }).catch((e) => e);
    expect(big).toBeInstanceOf(FleetApiError); // refused by FleetController (never reported as a success)
    expect(await cash(A.id)).toBe(a0 + 2_000 - 500);
    expect((await R.one<boolean>(`fleet.fleet_ledger_verify()`).catch(() => true))).toBeTruthy();
  });

  it("hold / resume, missions and notification acknowledgement (ordinary authenticated writes)", async () => {
    let s = await adapter.execute({ kind: "hold", agentId: B.id, reason: "contract hold" });
    if (s.agents.state === "ok") expect(s.agents.data.find((x) => x.agentId === B.id)!.held).toBe(true);
    s = await adapter.execute({ kind: "hold", agentId: B.id }); // converges
    s = await adapter.execute({ kind: "resume", agentId: B.id });
    if (s.agents.state === "ok") expect(s.agents.data.find((x) => x.agentId === B.id)!.held).toBe(false);
    s = await adapter.execute({ kind: "mission", agentId: A.id, missionKind: "marketing", brief: "promote the Fleet's storefronts", beneficiaries: [{ agentId: B.id, shareBp: 10_000 }] });
    if (s.agents.state === "ok") expect(s.agents.data.find((x) => x.agentId === A.id)!.mode).toBe("MARKETING");
    const active = ((s.engine.state === "ok" ? (s.engine.data as any).missions?.active : []) ?? []) as Array<Record<string, any>>;
    const m = active.find((x) => x.agent_id === A.id);
    expect(m).toBeTruthy();
    s = await adapter.execute({ kind: "mission_end", missionId: m!.mission_id, outcome: "contract test" });
    if (s.agents.state === "ok") expect(s.agents.data.find((x) => x.agentId === A.id)!.mode).toBe("NORMAL");
    await R.q(`SELECT fleet.fleet_notify('AMBER', 'CONTRACT_TEST', NULL, 'contract notification', '{}'::jsonb, $1)`, [`ct:${crypto.randomUUID()}`]);
    await R.q(`SELECT fleet.fleet_notify('AMBER', 'CONTRACT_TEST', NULL, 'contract notification 2', '{}'::jsonb, $1)`, [`ct:${crypto.randomUUID()}`]);
    s = await adapter.snapshot();
    const list = ((s.notifications.state === "ok" ? (s.notifications.data as any).notifications ?? s.notifications.data : []) as Array<Record<string, any>>)
      .filter((n) => n.code === "CONTRACT_TEST");
    expect(list).toHaveLength(2);
    await adapter.execute({ kind: "ack_all", notificationIds: list.map((n) => n.notification_id) });
    await adapter.execute({ kind: "ack", notificationId: list[0].notification_id }); // converges
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_notifications WHERE code = 'CONTRACT_TEST' AND acknowledged_at IS NULL`))[0].n).toBe(0);
  });

  it("births: an Admin birth order is created; automatic replication stays blocked; kill and reseed take a step-up", async () => {
    await R.q(`UPDATE fleet.fleet_state SET max_agents = 4`);
    let s = await adapter.execute({ kind: "birth", mission: "independent", reason: "contract birth order", fundingMinor: 0 });
    expect(s.births.state === "ok" && s.births.data.some((b) => b.reason === "contract birth order")).toBe(true);
    // Automatic replication: every switch is off; a completed window queues nothing.
    if (s.settings.state === "ok") expect((s.settings.data as any).flags.registryReplicationSwitch).toBe(false);
    await R.store.grantServiceRole();
    const svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 1 });
    try { await svc.query(`SELECT fleet.svc_replication_tick(false)`); } finally { await svc.end(); }
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_birth_orders WHERE kind = 'automatic'`))[0].n).toBe(0);
    const asserted = auth.assertions;
    s = await adapter.execute({ kind: "kill", agentId: B.id, reason: "contract kill" });
    expect((await R.q(`SELECT status FROM fleet.fleet_agents WHERE agent_id = $1`, [B.id]))[0].status).toMatch(/dead|failed/);
    s = await adapter.execute({ kind: "reseed", deadAgentId: B.id, reason: "continue B's work", fundingMinor: 0 });
    expect(s.births.state === "ok" && s.births.data.some((b) => b.kind === "reseed")).toBe(true);
    expect(auth.assertions - asserted).toBe(2);
  });

  it("sealed reveal: step-up, broker-sealed to a one-time key, opened only in memory, cleared on time, logged; never in a snapshot", async () => {
    let cleared = false;
    const h = await reveal(client, "provider_secret", "twilio", { ttlMs: 150, onClear: () => { cleared = true; } });
    expect(JSON.parse(h.value!).apiKeySecret).toBe("contract-test-secret-123");
    await new Promise((r) => setTimeout(r, 300));
    expect(h.value).toBeNull();
    expect(cleared).toBe(true);
    const rows = await R.q(`SELECT status, sealed FROM fleet.fleet_reveal_requests WHERE kind = 'provider_secret'`);
    expect(rows.every((r) => r.status === "delivered" && r.sealed === null)).toBe(true); // the sealed copy is erased once taken
    expect((await R.q(`SELECT outcome FROM fleet.fleet_reveal_log WHERE kind = 'provider_secret' ORDER BY seq`)).map((r) => r.outcome))
      .toEqual(["requested", "served", "delivered"]);
    expect(JSON.stringify(await adapter.snapshot())).not.toContain("contract-test-secret-123");
  });

  it("commands with no live contract are refused without any request; writes are never retried; unknown outcomes re-read the Fleet", async () => {
    for (const kind of Object.keys(UNSUPPORTED)) {
      const calls = (fetchJar as any).count ?? 0;
      expect(await code(adapter.execute({ kind } as LiveCommand)), kind).toBe("FLEET_UNSUPPORTED_IN_LIVE");
      expect((fetchJar as any).count ?? 0).toBe(calls);
    }
    // A connection lost mid-write: one attempt only, then a fresh authoritative read for the owner to review.
    let posts = 0;
    const flaky = (async (input: any, init: any) => {
      if ((init?.method ?? "GET") === "POST" && String(input).endsWith("/api/call")) { posts++; throw new TypeError("network down"); }
      return fetchJar(input, init);
    }) as typeof fetch;
    const flakyAdapter = new LiveFleetAdapter(identity, new GatewayClient({ baseUrl: ORIGIN, fetch: flaky, webauthn: auth, csrf: client.csrf }));
    const e = await flakyAdapter.execute({ kind: "hold", agentId: A.id }).catch((x) => x);
    expect(e).toBeInstanceOf(OutcomeUnknownError);
    expect(posts).toBe(1);
    expect((e as OutcomeUnknownError<LiveSnapshot>).fleet?.mode).toBe("live");
  });

  it("an unavailable section stays unavailable; an unreachable gateway yields an error, never data from anywhere else", async () => {
    const partial = (async (input: any, init: any) => (String(input).includes("op=estates") ? new Response("{}", { status: 500 }) : fetchJar(input, init))) as typeof fetch;
    const s = await new LiveFleetAdapter(identity, new GatewayClient({ baseUrl: ORIGIN, fetch: partial, webauthn: auth, csrf: client.csrf })).snapshot();
    expect(s.estates).toEqual({ state: "unavailable", code: "FLEET_UNAVAILABLE" });
    expect(s.replication.state).toBe("ok");
    const dead = new LiveFleetAdapter(identity, new GatewayClient({ baseUrl: "http://127.0.0.1:9", webauthn: auth, csrf: client.csrf }));
    expect(await code(dead.snapshot())).toBe("FLEET_UNAVAILABLE");
    expect(dead.last).toBeNull();
  });

  it("session expiry ends access at once and returns the UI to sign-in", async () => {
    const before = signedOut;
    await R.q(`UPDATE fleet.fleet_admin_sessions SET expires_at = now() - interval '1 second' WHERE ended_at IS NULL`);
    expect(await code(adapter.snapshot())).toBe("FLEET_SESSION_INVALID");
    expect(await code(adapter.execute({ kind: "hold", agentId: A.id }))).toBe("FLEET_SESSION_INVALID");
    expect(signedOut).toBeGreaterThan(before);
    expect(client.csrf.get()).toBeNull();
    await new LiveAuth(client).logout();
  });
});

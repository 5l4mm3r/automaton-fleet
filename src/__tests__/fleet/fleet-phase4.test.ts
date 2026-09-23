/**
 * Fleet Layer Tests (Phase 4): deployment readiness.
 *
 * Least-privilege database roles (admin / service / agent) and the effective
 * privilege audit, admin-only migrations, secret files, the loopback-only
 * fleet service (health, readiness, graceful shutdown, structured logs),
 * runtime release pinning and immutability, heartbeat/lease cleanup,
 * parent-reported deaths, the sandbox termination queue, and the
 * fleet:doctor readiness verdict.
 *
 * PostgreSQL tests run against a throwaway cluster (fixtures/ephemeral-pg.ts)
 * set up exactly as production: non-superuser owner + scripts/fleet-db-roles.sql
 * (fed on stdin like scripts/fleet-db-setup.sh). Describe names include
 * "security", "policy" and "financial" so these tests also run under
 * test:security and test:financial.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomBytes } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { ulid } from "ulid";
import {
  FleetApiClient,
  FleetRuntimeError,
  FleetService,
  PgAgentGateway,
  PgFleetStore,
  SecretFileError,
  UnsupportedSandboxTerminator,
  auditPrivileges,
  formatDoctorReport,
  loadServiceEnv,
  readSecretEnvFile,
  runDoctor,
  type SandboxTerminator,
} from "../../fleet/index.js";
import { attestationProof, type RuntimeAttestation } from "../../fleet/attestation.js";
import type { ClaimedGrant } from "../../fleet/grants.js";
import { buildRuntimeInstallCommand, loadRuntimeRelease, resolveChildRuntime } from "../../fleet/runtime.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";
import { parseListen, startFleetServiceFromEnv } from "../../fleet/service/main.js";
import { createJsonLogger } from "../../fleet/service/log.js";
import { loadFleetConfig } from "../../fleet/config.js";
import { getForbiddenCommandMatch } from "../../agent/policy-rules/command-safety.js";
import { isSensitiveFile } from "../../agent/policy-rules/path-protection.js";
import { isProtectedFile } from "../../self-mod/code.js";
import { TEST_RUNTIME_BUILD, TEST_RUNTIME_PIN } from "../mocks.js";
import { wipeRegistry } from "./fixtures/wipe.js";
import { findPgBin, startEphemeralPg, type EphemeralPg } from "./fixtures/ephemeral-pg.js";

const PIN = TEST_RUNTIME_PIN;
const BUILD = TEST_RUNTIME_BUILD;
const RELEASE = { ...PIN, ...BUILD };
const RELEASE_ENV = {
  FLEET_RUNTIME_REPO: PIN.repo,
  FLEET_RUNTIME_COMMIT: PIN.commit,
  FLEET_RUNTIME_BUILD_ID: BUILD.buildId,
  FLEET_RUNTIME_LOCKFILE_SHA256: BUILD.lockfileSha256,
};

function wallet(): string {
  return `0x${randomBytes(20).toString("hex")}`;
}

function honestAttestation(claimed: ClaimedGrant, overrides: Partial<RuntimeAttestation> = {}): RuntimeAttestation {
  const a = {
    nonce: claimed.nonce!,
    commit: claimed.runtime!.commit,
    repo: claimed.runtime!.repo,
    buildId: claimed.expectedBuild!.buildId,
    lockfileSha256: claimed.expectedBuild!.lockfileSha256,
    clean: true,
    fileCount: 7,
    version: "0.2.1",
    proof: "",
    ...overrides,
  };
  return { ...a, proof: attestationProof(a) };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fleet-p4-"));
}

// ─── Secret files ────────────────────────────────────────────────

describe("Fleet security: secret files", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads a 0600 secret file and parses KEY=VALUE", () => {
    const f = path.join(dir, "service.env");
    fs.writeFileSync(f, "# c\nFLEET_SERVICE_DATABASE_URL=postgresql://a:b@h/d\n", { mode: 0o600 });
    expect(readSecretEnvFile(f)).toEqual({ FLEET_SERVICE_DATABASE_URL: "postgresql://a:b@h/d" });
  });

  it("refuses world- or group-readable secret files and symlinks", () => {
    const f = path.join(dir, "s.env");
    fs.writeFileSync(f, "X=1\n", { mode: 0o644 });
    fs.chmodSync(f, 0o644);
    expect(() => readSecretEnvFile(f)).toThrow(/world-accessible/);
    fs.chmodSync(f, 0o640);
    expect(() => readSecretEnvFile(f)).toThrow(/group-accessible/);
    expect(readSecretEnvFile(f, { allowGroupRead: true })).toEqual({ X: "1" });
    fs.chmodSync(f, 0o600);
    const link = path.join(dir, "link.env");
    fs.symlinkSync(f, link);
    expect(() => readSecretEnvFile(link)).toThrow(/symlink/);
  });

  it.skipIf(process.getuid?.() === 0)("an unreadable secret file fails clearly (no silent fallback)", () => {
    const f = path.join(dir, "admin.env");
    fs.writeFileSync(f, "FLEET_ADMIN_DATABASE_URL=postgresql://x:y@h/d\n", { mode: 0o600 });
    fs.chmodSync(f, 0o000);
    expect(() => readSecretEnvFile(f)).toThrow(SecretFileError);
    expect(() => readSecretEnvFile(f)).toThrow(/not readable by this user/);
    // The service loader requires the systemd credential when CREDENTIALS_DIRECTORY is set.
    expect(() => loadServiceEnv({ CREDENTIALS_DIRECTORY: dir, FLEET_SERVICE_ENV_FILE: f }, dir)).toThrow(/not readable/);
    expect(() => loadServiceEnv({ CREDENTIALS_DIRECTORY: path.join(dir, "none") }, dir)).toThrow(/does not exist/);
  });

  it("the service loader never reads admin.env and warns about legacy .env.fleet secrets", () => {
    fs.writeFileSync(path.join(dir, ".env.fleet"), "DATABASE_URL=postgresql://o:p@h/d\nREAL_REPLICATION_ENABLED=false\n");
    const svc = path.join(dir, "service.env");
    fs.writeFileSync(svc, "FLEET_SERVICE_DATABASE_URL=postgresql://s:p@h/d\n", { mode: 0o600 });
    const loaded = loadServiceEnv({ FLEET_SERVICE_ENV_FILE: svc, FLEET_RUNTIME_ENV_FILE: path.join(dir, "none") }, dir);
    expect(loaded.env.FLEET_SERVICE_DATABASE_URL).toBe("postgresql://s:p@h/d");
    expect(loaded.env.FLEET_ADMIN_DATABASE_URL).toBeUndefined();
    expect(loaded.warnings.join(" ")).toMatch(/DATABASE_URL is read from the repository \.env\.fleet/);
    expect(JSON.stringify(loaded.secretSources)).not.toMatch(/postgresql:/);
  });
});

// ─── Deployment artifacts ────────────────────────────────────────

describe("Fleet security: deployment artifacts (systemd, scripts, flags)", () => {
  const unit = fs.readFileSync("deploy/systemd/automaton-fleet.service", "utf8");
  const agentUnit = fs.readFileSync("deploy/systemd/automaton-agent.service", "utf8");

  it("the fleet service unit runs as its own user, loopback only, restart-rate-limited, secrets via LoadCredential", () => {
    expect(unit).toMatch(/^User=automaton-fleet-service$/m);
    expect(unit).toMatch(/^LoadCredential=service\.env:\/etc\/automaton-fleet\/service\.env$/m);
    expect(unit).not.toMatch(/^EnvironmentFile=/m);
    expect(unit).not.toMatch(/DATABASE_URL=/);
    expect(unit).toMatch(/^Restart=on-failure$/m);
    expect(unit).toMatch(/^StartLimitBurst=\d+$/m);
    expect(unit).toMatch(/^StartLimitIntervalSec=\d+$/m);
    expect(unit).toMatch(/^IPAddressDeny=any$/m);
    expect(unit).toMatch(/^IPAddressAllow=localhost$/m);
    expect(unit).toMatch(/^FLEET_API_LISTEN=127\.0\.0\.1:8787$|^Environment=FLEET_API_LISTEN=127\.0\.0\.1:8787$/m);
    expect(unit).toMatch(/^KillSignal=SIGTERM$/m);
    expect(unit).toMatch(/^NoNewPrivileges=yes$/m);
    expect(unit).toMatch(/InaccessiblePaths=.*\/etc\/automaton-fleet\/admin\.env/);
  });

  it("the agent unit runs as a different user and cannot see the fleet secrets", () => {
    expect(agentUnit).toMatch(/^User=automaton-agent$/m);
    expect(agentUnit).toMatch(/^InaccessiblePaths=\/etc\/automaton-fleet/m);
    expect(agentUnit).toMatch(/^ProtectProc=invisible$/m);
    expect(agentUnit).not.toMatch(/DATABASE_URL|LoadCredential/);
    for (const k of ["REAL_REPLICATION_ENABLED", "REAL_PAYMENTS_ENABLED", "OWNER_SWEEP_ENABLED"]) {
      expect(agentUnit).toMatch(new RegExp(`^Environment=${k}=false$`, "m"));
    }
  });

  it("setup scripts are dry-run by default and pass DB passwords on stdin, never argv", () => {
    for (const f of ["scripts/fleet-os-setup.sh", "scripts/fleet-db-setup.sh"]) {
      const s = fs.readFileSync(f, "utf8");
      expect(s).toMatch(/APPLY=0/);
      expect(s).toMatch(/--apply/);
    }
    const db = fs.readFileSync("scripts/fleet-db-setup.sh", "utf8");
    expect(db).toMatch(/printf '\\\\set agent_password/);
    expect(db).not.toMatch(/-v agent_password/);
    const sql = fs.readFileSync("scripts/fleet-db-roles.sql", "utf8");
    expect(sql).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'fleet_service_login'\)/);
  });

  it("financial safety: every shipped config keeps replication, payments and owner sweep disabled", () => {
    const example = fs.readFileSync("deploy/etc/runtime.env.example", "utf8");
    for (const k of ["REAL_REPLICATION_ENABLED", "REAL_PAYMENTS_ENABLED", "OWNER_SWEEP_ENABLED"]) {
      expect(example).toMatch(new RegExp(`^${k}=false$`, "m"));
      if (fs.existsSync(".env.fleet")) expect(fs.readFileSync(".env.fleet", "utf8")).toMatch(new RegExp(`^${k}=false$`, "m"));
    }
    const cfg = loadFleetConfig({});
    expect(cfg.realReplicationEnabled || cfg.realPaymentsEnabled || cfg.ownerSweepEnabled).toBe(false);
  });

  it("security: agents cannot read controller secret files, run deployment commands, change grants or edit the Phase 4 code", () => {
    for (const cmd of [
      "cat /etc/automaton-fleet/service.env",
      "cat $CREDENTIALS_DIRECTORY/service.env",
      "sudo scripts/fleet-db-setup.sh --apply",
      "sudo scripts/fleet-os-setup.sh --apply",
      "pnpm fleet:audit-privileges",
      "systemctl stop automaton-fleet",
      "psql -c 'GRANT UPDATE ON fleet.fleet_state TO fleet_agent'",
      "psql -c 'REVOKE EXECUTE ON FUNCTION fleet.api_heartbeat(text,text) FROM fleet_agent'",
      "psql -c 'GRANT fleet_service TO fleet_agent_login'",
    ]) {
      expect(getForbiddenCommandMatch(cmd), cmd).not.toBeNull();
    }
    expect(getForbiddenCommandMatch("git log --oneline")).toBeNull();
    expect(isSensitiveFile("/etc/automaton-fleet/admin.env")).toBe(true);
    expect(isSensitiveFile("/run/credentials/automaton-fleet.service/service.env")).toBe(true);
    for (const f of ["fleet/secret-files.ts", "fleet/doctor.ts", "fleet/postgres/privileges.ts", "fleet/service/terminator.ts", "fleet/service/log.ts"]) {
      expect(isProtectedFile(`src/${f}`), f).toBe(true);
    }
  });

  it("the fleet service binds loopback only", () => {
    expect(parseListen(undefined)).toEqual({ host: "127.0.0.1", port: 8787 });
    expect(parseListen("[::1]:9000")).toEqual({ host: "::1", port: 9000 });
    for (const bad of ["0.0.0.0:8787", "192.168.1.10:8787", "[::]:8787", "fleet.example.com:443"]) {
      expect(() => parseListen(bad), bad).toThrow(/loopback/);
    }
  });

  it("structured logs are JSON lines with level/event and scrub credentials", () => {
    const lines: string[] = [];
    const log = createJsonLogger((l) => lines.push(l));
    log("warn", "x_happened", { url: "postgresql://u:secretpw@h/d", token: "fa1.abc", n: 3 });
    const rec = JSON.parse(lines[0]);
    expect(rec).toMatchObject({ level: "warn", event: "x_happened", service: "automaton-fleet", n: 3, token: "[redacted]" });
    expect(lines[0]).not.toContain("secretpw");
  });

  it("child provisioning uses pnpm install --frozen-lockfile and never lets the child pick its runtime", () => {
    const cmd = buildRuntimeInstallCommand(PIN, BUILD);
    expect(cmd).toContain("CI=true pnpm install --frozen-lockfile");
    expect(cmd).not.toMatch(/(^|[^p])npm install(?! -g)/);
    expect(() => resolveChildRuntime(PIN, { repo: "https://github.com/evil/fork" })).toThrow(FleetRuntimeError);
    expect(() => resolveChildRuntime(PIN, { commit: "f".repeat(40) })).toThrow(FleetRuntimeError);
    expect(loadRuntimeRelease({ ...RELEASE_ENV, FLEET_RUNTIME_BUILD_ID: "" })).toBeNull();
    expect(loadRuntimeRelease(RELEASE_ENV)).toEqual(RELEASE);
  });
});

// ─── PostgreSQL ──────────────────────────────────────────────────

const PG_BIN = findPgBin();
if (!PG_BIN) console.warn("[fleet-phase4] PostgreSQL binaries not found — Phase 4 database tests SKIPPED. Set PG_BIN.");

describe.skipIf(!PG_BIN)("Fleet security policy: least-privilege roles, service, reaper and doctor", () => {
  let pgc: EphemeralPg;
  let admin: PgFleetStore;
  let svc: PgFleetStore;
  let ownerRaw: pg.Pool;
  let agentRaw: pg.Pool;
  let serviceRaw: pg.Pool;
  const opened: Array<{ close(): Promise<void> }> = [];

  function track<T extends { close(): Promise<void> }>(x: T): T {
    opened.push(x);
    return x;
  }

  async function events(type: string, agentId?: string): Promise<number> {
    const r = await ownerRaw.query(
      "SELECT count(*)::int AS n FROM fleet.fleet_events WHERE event_type = $1 AND ($2::text IS NULL OR agent_id = $2)",
      [type, agentId ?? null],
    );
    return r.rows[0].n;
  }

  async function reset(max = 5) {
    const c = await ownerRaw.connect();
    try {
      await c.query("BEGIN");
      await wipeRegistry(c, "fleet");
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    } finally {
      c.release();
    }
    await admin.setApprovedRuntime(null, "test");
    await admin.setMaxAgents(max, "test");
    await admin.setOperatingMode("EXPANSION", "test", "test");
    await admin.setApprovedRuntime(PIN, "test", BUILD);
    await admin.setReplicationEnabled(true, "test");
    await admin.setTimeouts(
      { reservationTtlS: 1800, provisioningTtlS: 2700, heartbeatUnresponsiveS: 120, heartbeatDeadS: 600, parentReportQuietS: 60 },
      "test",
    );
  }

  async function enrollRoot(name = "root") {
    const reg = await admin.registerRoot({ walletAddress: wallet(), name });
    if (!reg.ok) throw new Error(reg.reason);
    const cred = await admin.issueCredential(reg.agent.agentId, "test");
    return { agent: reg.agent, cred };
  }

  /** Reserve (admin allocator) then claim through the SERVICE role. */
  async function claimed(parentId: string) {
    const res = await admin.reserveSlot({ parentAgentId: parentId, requestedBy: "t", name: "kid", runtime: PIN });
    if (!res.ok) throw new Error(res.reason);
    const localChildId = ulid();
    const c = await svc.claimGrant(res.agent.agentId, localChildId, { parentAgentId: parentId });
    return { agentId: res.agent.agentId, reservationId: res.lease!.reservationId, claimed: c, localChildId };
  }

  /** Active child, activated by the SERVICE role. */
  async function activeChild(parentId: string, sandboxId: string | null = null) {
    const k = await claimed(parentId);
    const act = await svc.activate(k.agentId, {
      walletAddress: wallet(),
      sandboxId,
      runtimeCommit: PIN.commit,
      attestation: honestAttestation(k.claimed),
      parentAgentId: parentId,
      actor: parentId,
    });
    return { ...k, cred: act.credential };
  }

  async function armReaper() {
    await ownerRaw.query("UPDATE fleet.fleet_state SET reaper_last_run_at = now(), reaper_grace_from = '-infinity'");
  }

  async function ageHeartbeat(agentId: string, seconds: number) {
    await ownerRaw.query("UPDATE fleet.fleet_agents SET last_heartbeat = now() - make_interval(secs => $2) WHERE agent_id = $1", [agentId, seconds]);
  }

  async function status(agentId: string) {
    return (await admin.getAgent(agentId))!.status;
  }

  beforeAll(async () => {
    pgc = await startEphemeralPg(PG_BIN!);
    ownerRaw = new pg.Pool({ connectionString: pgc.ownerUrl, max: 6 });
    agentRaw = new pg.Pool({ connectionString: pgc.agentUrl, max: 4 });
    serviceRaw = new pg.Pool({ connectionString: pgc.serviceUrl, max: 4 });
    admin = track(new PgFleetStore({ connectionString: pgc.ownerUrl }));
    svc = track(new PgFleetStore({ connectionString: pgc.serviceUrl }));
    await admin.migrate();
  }, 60_000);

  afterAll(async () => {
    for (const s of opened) await s.close();
    await ownerRaw?.end();
    await agentRaw?.end();
    await serviceRaw?.end();
    pgc?.stop();
  });

  beforeEach(async () => {
    await reset();
  });

  // ── Migrations and roles

  it("migration is idempotent and reaches the current schema version; the role script is re-runnable", async () => {
    expect(await admin.migrate()).toEqual([]);
    expect((await admin.health()).schemaVersion).toBe(FLEET_PG_SCHEMA_VERSION);
    pgc.applyRoles();
    pgc.applyRoles();
    expect((await admin.auditPrivileges()).ok).toBe(true);
  });

  it("administrative migrations require the privileged admin credential (service and agent logins refused)", async () => {
    await expect(svc.migrate()).rejects.toThrow(/privileged admin credential/);
    const asAgent = track(new PgFleetStore({ connectionString: pgc.agentUrl }));
    await expect(asAgent.migrate()).rejects.toThrow(/privileged admin credential/);
    await expect(svc.grantAgentRole()).rejects.toThrow();
    await expect(svc.grantServiceRole()).rejects.toThrow();
  });

  it("the effective privilege audit passes for the intended grants", async () => {
    const r = await admin.auditPrivileges();
    expect(r.problems).toEqual([]);
    const agentLogin = r.roles.find((x) => x.role === "fleet_agent_login")!;
    expect(agentLogin.tables).toEqual([]);
    expect(agentLogin.functions.every((f) => f.startsWith("api_"))).toBe(true);
    const svcLogin = r.roles.find((x) => x.role === "fleet_service_login")!;
    expect(svcLogin.functions.every((f) => f.startsWith("svc_"))).toBe(true);
    expect(svcLogin.tables).not.toContain("fleet_agent_credentials");
  });

  it("the audit FAILS when agent or service permissions are too broad", async () => {
    const cases: Array<[string, string, RegExp]> = [
      ["GRANT UPDATE ON fleet.fleet_state TO fleet_agent", "REVOKE UPDATE ON fleet.fleet_state FROM fleet_agent", /fleet_agent_login has UPDATE on fleet\.fleet_state/],
      ["GRANT UPDATE (max_agents) ON fleet.fleet_state TO fleet_agent", "REVOKE UPDATE (max_agents) ON fleet.fleet_state FROM fleet_agent", /has UPDATE on fleet\.fleet_state/],
      ["GRANT SELECT ON fleet.fleet_agent_credentials TO fleet_service", "REVOKE SELECT ON fleet.fleet_agent_credentials FROM fleet_service", /fleet_service has SELECT on fleet\.fleet_agent_credentials/],
      ["GRANT INSERT ON fleet.fleet_agents TO fleet_service", "REVOKE INSERT ON fleet.fleet_agents FROM fleet_service", /fleet_service has INSERT on fleet\.fleet_agents/],
      ["GRANT EXECUTE ON FUNCTION fleet.fleet_reserve_slot(text,text,text,text,integer,bigint,boolean,text,text,text,text) TO fleet_agent",
       "REVOKE EXECUTE ON FUNCTION fleet.fleet_reserve_slot(text,text,text,text,integer,bigint,boolean,text,text,text,text) FROM fleet_agent", /can EXECUTE fleet\.fleet_reserve_slot/],
      ["GRANT CREATE ON SCHEMA fleet TO fleet_agent", "REVOKE CREATE ON SCHEMA fleet FROM fleet_agent", /can CREATE in schema fleet/],
      ["GRANT TEMPORARY ON DATABASE fleet_t TO fleet_service_login", "REVOKE TEMPORARY ON DATABASE fleet_t FROM fleet_service_login", /TEMPORARY/],
      ["GRANT EXECUTE ON FUNCTION fleet.api_fleet_state() TO PUBLIC", "REVOKE EXECUTE ON FUNCTION fleet.api_fleet_state() FROM PUBLIC", /PUBLIC has EXECUTE/],
    ];
    for (const [grant, revoke, expected] of cases) {
      await ownerRaw.query(grant);
      try {
        const r = await admin.auditPrivileges();
        expect(r.ok, grant).toBe(false);
        expect(r.problems.join("\n"), grant).toMatch(expected);
      } finally {
        await ownerRaw.query(revoke);
      }
    }
    // Superuser-only changes: role attributes and cross-role membership.
    const su = new pg.Pool({ connectionString: pgc.superUrl.replace(/\/postgres$/, "/fleet_t"), max: 1 });
    try {
      await su.query("ALTER ROLE fleet_agent_login CREATEROLE");
      await su.query("GRANT fleet_service TO fleet_agent_login");
      await su.query("GRANT fleet_owner TO fleet_service_login");
      const problems = (await admin.auditPrivileges()).problems.join("\n");
      expect(problems).toMatch(/fleet_agent_login can create roles/);
      expect(problems).toMatch(/fleet_agent_login is a member of fleet_service/);
      expect(problems).toMatch(/fleet_service_login is a member of the schema owner fleet_owner/);
    } finally {
      await su.query("ALTER ROLE fleet_agent_login NOCREATEROLE");
      await su.query("REVOKE fleet_service FROM fleet_agent_login");
      await su.query("REVOKE fleet_owner FROM fleet_service_login");
      await su.end();
    }
    // The idempotent role script also repairs such drift.
    const su2 = new pg.Pool({ connectionString: pgc.superUrl, max: 1 });
    try {
      await su2.query("ALTER ROLE fleet_service_login CREATEDB");
      await su2.query("GRANT fleet_agent TO fleet_service_login");
    } finally {
      await su2.end();
    }
    expect((await admin.auditPrivileges()).ok).toBe(false);
    pgc.applyRoles();
    expect((await admin.auditPrivileges()).ok).toBe(true);
  });

  it("security: the agent role cannot alter schema, create roles, alter triggers, change the cap, touch another agent, reserve directly or read credentials", async () => {
    const root = await enrollRoot();
    const other = await enrollRoot("other");
    const denied = [
      "CREATE TABLE fleet.x (id int)",
      "ALTER TABLE fleet.fleet_agents ADD COLUMN pwn text",
      "CREATE ROLE evil LOGIN",
      "ALTER TABLE fleet.fleet_agents DISABLE TRIGGER fleet_agents_transition_guard",
      "UPDATE fleet.fleet_state SET max_agents = 50",
      `UPDATE fleet.fleet_agents SET status = 'dead' WHERE agent_id = '${other.agent.agentId}'`,
      "SELECT * FROM fleet.fleet_agent_credentials",
      `SELECT fleet.fleet_reserve_slot('${root.agent.agentId}','x','x','k',NULL,NULL,false,NULL,NULL,'${ulid()}','${ulid()}')`,
      `SELECT fleet.svc_mark_dead('${other.agent.agentId}','x','x','x')`,
      "SET session_replication_role = replica",
      "CREATE TEMP TABLE fleet_state (x int)",
    ];
    for (const sql of denied) await expect(agentRaw.query(sql), sql).rejects.toThrow(/permission denied|must be|not allowed/i);
    // The API lets an agent act only on itself.
    const r = await agentRaw.query("SELECT fleet.api_set_own_status($1, $2, 'dead', 'x') AS r", [other.agent.agentId, root.cred.token]);
    expect(r.rows[0].r).toMatchObject({ ok: false, code: "FLEET_AUTH_FAILED" });
    expect(await status(other.agent.agentId)).toBe("active");
    expect((await admin.getState()).maxAgents).toBe(5);
  });

  it("security: the service role operates the fleet but cannot change the cap/mode/runtime/switch, insert agents, issue arbitrary credentials or read hashes", async () => {
    const root = await enrollRoot();
    await expect(svc.setMaxAgents(50, "svc")).rejects.toThrow(/permission denied/);
    await expect(svc.setOperatingMode("EXPANSION", "svc", "x")).rejects.toThrow(/permission denied/);
    await expect(svc.setApprovedRuntime(null, "svc")).rejects.toThrow(/permission denied/);
    await expect(svc.setReplicationEnabled(false, "svc")).rejects.toThrow(/permission denied/);
    await expect(svc.setTimeouts({ heartbeatDeadS: 9999 }, "svc")).rejects.toThrow(/permission denied/);
    await expect(svc.registerRoot({ walletAddress: wallet(), name: "sneaky" })).rejects.toThrow(/permission denied/);
    await expect(svc.issueCredential(root.agent.agentId, "svc")).rejects.toThrow(/permission denied/);
    await expect(svc.reserveSlot({ parentAgentId: root.agent.agentId, requestedBy: "svc", name: "x", runtime: PIN })).rejects.toThrow(/permission denied/);
    for (const sql of [
      "SELECT * FROM fleet.fleet_agent_credentials",
      `UPDATE fleet.fleet_agents SET status = 'dead' WHERE agent_id = '${root.agent.agentId}'`,
      "ALTER TABLE fleet.fleet_state DISABLE TRIGGER USER",
      "CREATE FUNCTION fleet.f() RETURNS int LANGUAGE sql AS 'SELECT 1'",
      "CREATE ROLE evil",
    ]) {
      await expect(serviceRaw.query(sql), sql).rejects.toThrow(/permission denied|must be owner/i);
    }
    // …while every controller operation works.
    const kid = await activeChild(root.agent.agentId, "sbx-1");
    expect(await status(kid.agentId)).toBe("active");
    expect(await svc.heartbeat(kid.agentId)).toBe(true);
    expect(await svc.reap("t")).toMatchObject({ expired: 0 });
    expect((await svc.getState()).livingAgents).toBe(2);
    expect((await svc.health()).ok).toBe(true);
  });

  // ── Runtime verification (fail closed; authoritative check in the DB)

  it("wrong repo, wrong commit or wrong build id prevents activation — even when the controller's own check is bypassed", async () => {
    const root = await enrollRoot();
    const tamper: Array<[string, Partial<RuntimeAttestation>, string, RegExp]> = [
      ["repo", { repo: "https://github.com/evil/fork" }, PIN.commit, /repository/],
      ["commit", { commit: "f".repeat(40) }, "f".repeat(40), /commit/],
      ["build", { buildId: "c".repeat(64) }, PIN.commit, /build id/],
    ];
    for (const [what, t, reported, sqlReason] of tamper) {
      // (a) through the store: TS check refuses, slot released as failed.
      const a = await claimed(root.agent.agentId);
      await expect(
        svc.activate(a.agentId, { walletAddress: wallet(), runtimeCommit: reported, attestation: honestAttestation(a.claimed, t), parentAgentId: root.agent.agentId }),
        what,
      ).rejects.toThrow(FleetRuntimeError);
      expect(await status(a.agentId), what).toBe("failed");
      expect((await admin.getReservation(a.agentId))!.status).toBe("failed");

      // (b) calling svc_activate directly with a self-consistent forged proof: the DB refuses on its own.
      const b = await claimed(root.agent.agentId);
      const forged = honestAttestation(b.claimed, t);
      const r = await serviceRaw.query("SELECT fleet.svc_activate($1,$2,$3,NULL,$4,NULL,$5,$2,$6) AS r", [
        b.agentId, root.agent.agentId, wallet(), reported, JSON.stringify(forged), "d".repeat(64),
      ]);
      expect(r.rows[0].r, what).toMatchObject({ ok: false, code: "FLEET_RUNTIME_UNVERIFIED" });
      expect(r.rows[0].r.reason, what).toMatch(sqlReason);
      expect(await status(b.agentId), what).toBe("failed");
    }
    // No credential was issued for any of them; only the root holds a slot.
    const creds = await ownerRaw.query("SELECT count(*)::int AS n FROM fleet.fleet_agent_credentials");
    expect(creds.rows[0].n).toBe(1);
    expect(await events("runtime_verification_failed")).toBe(6);
    expect((await admin.getState()).reservedSlots).toBe(0);
  });

  it("a missing attestation or replayed nonce is refused by the database check", async () => {
    const root = await enrollRoot();
    const a = await claimed(root.agent.agentId);
    const none = await serviceRaw.query("SELECT fleet.svc_activate($1,$2,$3,NULL,$4,NULL,NULL,$2,$5) AS r", [a.agentId, root.agent.agentId, wallet(), PIN.commit, "d".repeat(64)]);
    expect(none.rows[0].r).toMatchObject({ ok: false, code: "FLEET_RUNTIME_UNVERIFIED" });
    const b = await claimed(root.agent.agentId);
    const c = await claimed(root.agent.agentId);
    const replay = honestAttestation(b.claimed); // b's nonce used for c
    const r = await serviceRaw.query("SELECT fleet.svc_activate($1,$2,$3,NULL,$4,NULL,$5,$2,$6) AS r", [c.agentId, root.agent.agentId, wallet(), PIN.commit, JSON.stringify(replay), "d".repeat(64)]);
    expect(r.rows[0].r.reason).toMatch(/nonce/);
  });

  it("the approved runtime is immutable while a release is running (clearing is always allowed)", async () => {
    const root = await enrollRoot();
    const other = { repo: PIN.repo, commit: "a".repeat(40) };
    const k = await claimed(root.agent.agentId);
    await expect(admin.setApprovedRuntime(other, "op", BUILD)).rejects.toThrow(/FLEET_RUNTIME_IMMUTABLE/);
    await svc.activate(k.agentId, { walletAddress: wallet(), runtimeCommit: PIN.commit, attestation: honestAttestation(k.claimed), parentAgentId: root.agent.agentId });
    await expect(admin.setApprovedRuntime(other, "op", BUILD)).rejects.toThrow(/FLEET_RUNTIME_IMMUTABLE/);
    await admin.setApprovedRuntime(null, "op");
    expect((await admin.getState()).runtime).toBeNull();
    await expect(admin.setApprovedRuntime(other, "op", BUILD)).rejects.toThrow(/FLEET_RUNTIME_IMMUTABLE/);
    await svc.markDead(k.agentId, "retired", "op");
    await admin.setApprovedRuntime(other, "op", BUILD);
    expect((await admin.getState()).runtime).toEqual(other);
  });

  // ── Heartbeats, leases, cleanup

  it("stale heartbeat: ACTIVE -> UNRESPONSIVE -> DEAD via the service role; the slot is released once", async () => {
    const root = await enrollRoot();
    const kid = await activeChild(root.agent.agentId);
    await armReaper();
    await ageHeartbeat(kid.agentId, 130);
    expect(await svc.reap("t")).toMatchObject({ unresponsive: 1, dead: 0 });
    expect(await status(kid.agentId)).toBe("unresponsive");
    expect((await admin.getState()).livingAgents).toBe(2);
    await ageHeartbeat(kid.agentId, 700);
    expect(await svc.reap("t")).toMatchObject({ dead: 1 });
    expect(await status(kid.agentId)).toBe("dead");
    expect((await admin.getState()).livingAgents).toBe(1);
    expect(await svc.reap("t")).toMatchObject({ dead: 0, unresponsive: 0 });
    expect(await events("slot_released", kid.agentId)).toBe(1);
  });

  it("stale reservation and stale provisioning leases are cleaned up and counted by the doctor query", async () => {
    const root = await enrollRoot();
    const r1 = await admin.reserveSlot({ parentAgentId: root.agent.agentId, requestedBy: "t", name: "a", runtime: PIN });
    const k = await claimed(root.agent.agentId);
    if (!r1.ok) throw new Error("reserve");
    await ownerRaw.query("UPDATE fleet.fleet_reservations SET expires_at = now() - interval '1 second' WHERE status IN ('reserved','provisioning')");
    expect(await svc.staleness()).toMatchObject({ staleReservations: 2, openReservations: 2 });
    expect((await svc.reap("t")).expired).toBe(2);
    expect(await svc.staleness()).toMatchObject({ staleReservations: 0, openReservations: 0 });
    expect(await status(r1.agent.agentId)).toBe("failed");
    expect(await status(k.agentId)).toBe("failed");
    expect((await admin.getState()).reservedSlots).toBe(0);
    expect(await events("reservation_expired")).toBe(2);
  });

  it("idempotent, auditable cleanup: double release, double death, concurrent reapers, duplicate termination results", async () => {
    const root = await enrollRoot();
    const k = await claimed(root.agent.agentId);
    expect(await svc.releaseReservation(k.agentId, "x", "t")).toBe(true);
    expect(await svc.releaseReservation(k.agentId, "x", "t")).toBe(false);
    expect(await svc.recordVerificationFailure(k.agentId, "late", "t")).toBe(false);
    expect(await events("slot_released", k.agentId)).toBe(1);

    const kid = await activeChild(root.agent.agentId, "sbx-dup");
    const results = await Promise.all([svc.markDead(kid.agentId, "a", "t"), svc.markDead(kid.agentId, "b", "t"), svc.reap("r1"), svc.reap("r2")]);
    expect(results.slice(0, 2).filter(Boolean)).toHaveLength(1);
    expect(await events("agent_died", kid.agentId)).toBe(1);
    expect(await events("slot_released", kid.agentId)).toBe(1);
    expect(await events("sandbox_termination_requested", kid.agentId)).toBe(1);
    expect(await svc.recordTerminationResult(kid.agentId, "unsupported", "no api")).toBe(true);
    expect(await svc.recordTerminationResult(kid.agentId, "unsupported", "no api")).toBe(false);
    expect((await admin.health()).countersConsistent).toBe(true);
  });

  it("parent-reported death: unactivated child released now; quiet child dies now; heartbeating child is deferred until quiet; other parents are refused", async () => {
    const root = await enrollRoot();
    const stranger = await enrollRoot("stranger");
    const pending = await claimed(root.agent.agentId);
    expect(await svc.reportChildTerminal(root.agent.agentId, pending.localChildId, "failed")).toMatchObject({ ok: true, outcome: "released", changed: true });
    expect(await status(pending.agentId)).toBe("failed");

    const quiet = await activeChild(root.agent.agentId);
    await ageHeartbeat(quiet.agentId, 90);
    expect(await svc.reportChildTerminal(stranger.agent.agentId, quiet.localChildId, "dead")).toMatchObject({ ok: false, code: "FLEET_NOT_AUTHORIZED" });
    expect(await status(quiet.agentId)).toBe("active");
    expect(await svc.reportChildTerminal(root.agent.agentId, quiet.localChildId, "dead")).toMatchObject({ outcome: "dead", changed: true });
    expect(await status(quiet.agentId)).toBe("dead");

    const alive = await activeChild(root.agent.agentId);
    expect(await svc.reportChildTerminal(root.agent.agentId, alive.localChildId, "dead")).toMatchObject({ outcome: "deferred", changed: false });
    expect(await status(alive.agentId)).toBe("active");
    await armReaper();
    expect((await svc.reap("t")).dead).toBe(0); // still heartbeating recently
    await ageHeartbeat(alive.agentId, 61);
    expect((await svc.reap("t")).dead).toBe(1); // far sooner than heartbeat_dead_s (600)
    expect(await status(alive.agentId)).toBe("dead");
    expect(await events("child_terminal_reported")).toBe(3);
  });

  // ── Fleet service

  describe("fleet service (restricted service role, loopback, health, drain)", () => {
    let started: Awaited<ReturnType<typeof startFleetServiceFromEnv>> | null = null;
    const logs: string[] = [];
    const log = createJsonLogger((l) => logs.push(l));
    const baseEnv = () => ({
      FLEET_SERVICE_DATABASE_URL: pgc.serviceUrl,
      FLEET_AGENT_DATABASE_URL: pgc.agentUrl,
      FLEET_API_LISTEN: "127.0.0.1:0",
      FLEET_REAPER_INTERVAL_MS: "60000",
      ...RELEASE_ENV,
    });

    afterEach(async () => {
      await started?.stop();
      started = null;
      logs.length = 0;
    });

    it("refuses the wrong DB role: owner as service DSN, admin credential present, agent DSN = service DSN", async () => {
      await expect(startFleetServiceFromEnv({ ...baseEnv(), FLEET_SERVICE_DATABASE_URL: pgc.ownerUrl }, { log })).rejects.toThrow(
        /restricted service role .* not the schema owner/,
      );
      await expect(startFleetServiceFromEnv({ ...baseEnv(), FLEET_ADMIN_DATABASE_URL: pgc.ownerUrl }, { log })).rejects.toThrow(
        /must not hold FLEET_ADMIN_DATABASE_URL/,
      );
      await expect(startFleetServiceFromEnv({ ...baseEnv(), FLEET_AGENT_DATABASE_URL: pgc.serviceUrl }, { log })).rejects.toThrow(
        /restricted agent role/,
      );
      await expect(startFleetServiceFromEnv({ ...baseEnv(), FLEET_AGENT_DATABASE_URL: pgc.ownerUrl }, { log })).rejects.toThrow(
        /not restricted|restricted agent role/,
      );
      await expect(startFleetServiceFromEnv({ ...baseEnv(), FLEET_API_LISTEN: "0.0.0.0:0" }, { log })).rejects.toThrow(/loopback/);
    });

    it("refuses to start when its privileges are too broad", async () => {
      await ownerRaw.query("GRANT UPDATE ON fleet.fleet_state TO fleet_service");
      try {
        await expect(startFleetServiceFromEnv(baseEnv(), { log })).rejects.toThrow(/privileges are too broad.*fleet_service.*UPDATE/);
      } finally {
        await ownerRaw.query("REVOKE UPDATE ON fleet.fleet_state FROM fleet_service");
      }
    });

    it("missing database: startup fails closed", async () => {
      await expect(
        startFleetServiceFromEnv({ ...baseEnv(), FLEET_SERVICE_DATABASE_URL: "postgresql://fleet_service_login:x@127.0.0.1:1/none" }, { log }),
      ).rejects.toThrow(/unhealthy|ECONNREFUSED|connect/i);
    });

    it("refuses to start when its runtime release differs from the registry-approved runtime", async () => {
      await expect(startFleetServiceFromEnv({ ...baseEnv(), FLEET_RUNTIME_BUILD_ID: "e".repeat(64) }, { log })).rejects.toThrow(
        /Runtime release mismatch/,
      );
    });

    it("healthz/readyz, replication still disabled, structured logs, and a graceful drain", async () => {
      started = await startFleetServiceFromEnv(baseEnv(), { log });
      const { url } = started;
      const hz = await fetch(`${url}/healthz`);
      expect(hz.status).toBe(200);
      expect(await hz.json()).toMatchObject({ ok: true, status: "alive" });
      await started.service.reapOnce();
      const rz = await fetch(`${url}/readyz`);
      const body = await rz.json();
      expect(rz.status, JSON.stringify(body)).toBe(200);
      expect(body).toMatchObject({
        ready: true,
        realReplicationEnabled: false,
        checks: { database: { ok: true }, agentApi: { ok: true }, runtimeRelease: { ok: true }, privileges: { ok: true }, reaper: { ok: true } },
      });
      expect(body.checks.sandboxTermination).toMatchObject({ ok: true, warn: true });

      // Replication is still disabled at the service: requests are rejected (audited).
      const root = await enrollRoot();
      const client = new FleetApiClient({ baseUrl: url, agentId: root.agent.agentId, token: root.cred.token });
      expect(await client.heartbeat(root.agent.agentId)).toBe(true);
      // (production mode: the long-lived credential alone is refused; the client uses a signed session)
      const bare = await fetch(`${url}/v1/replication/request`, {
        method: "POST",
        headers: { authorization: `Bearer ${root.cred.token}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "kid" }),
      });
      expect(bare.status).toBe(401);
      const req = await client.reserveSlot({ name: "kid" });
      expect(!req.ok && req.code).toBe("REAL_REPLICATION_DISABLED");
      expect((await admin.getState()).reservedSlots).toBe(0);

      const recs = logs.map((l) => JSON.parse(l));
      expect(recs.find((r) => r.event === "service_started")).toMatchObject({ level: "info", dbUser: "fleet_service_login", realReplicationEnabled: false });
      expect(logs.join("\n")).not.toMatch(/postgresql:\/\/[^\s"]*:[^\s"@]+@/);

      // Graceful shutdown: an in-flight request completes; new requests are refused.
      const svcAny = started.service as unknown as { opts: { readinessChecks?: () => Promise<Record<string, unknown>> } };
      const prev = svcAny.opts.readinessChecks;
      svcAny.opts.readinessChecks = async () => {
        await new Promise((r) => setTimeout(r, 400));
        return (await prev?.()) ?? {};
      };
      const slow = fetch(`${url}/readyz`);
      await new Promise((r) => setTimeout(r, 100));
      const stopping = started.stop();
      expect(started.service.isDraining).toBe(true);
      const late = await fetch(`${url}/v1/state`).catch(() => null); // refused while draining
      expect(late === null || late.status === 503).toBe(true);
      const inFlight = await slow; // completed, not cut off (reports draining => not ready)
      expect(await inFlight.json()).toMatchObject({ draining: true, checks: { database: { ok: true } } });
      await stopping;
      await expect(fetch(`${url}/healthz`)).rejects.toThrow();
      expect(logs.some((l) => JSON.parse(l).event === "shutdown_complete")).toBe(true);
      started = null;
    });

    it("service unavailable: agents fail closed (no heartbeat, no replication)", async () => {
      const id = ulid();
      const client = new FleetApiClient({ baseUrl: "http://127.0.0.1:1", agentId: id, token: `fa1.${id}.${"A".repeat(43)}` });
      expect(await client.heartbeat(id).catch(() => false)).toBe(false);
      await expect(client.getState()).rejects.toThrow();
    });

    it("claims/activations for a lease expecting another runtime release are refused and the slot released", async () => {
      const gateway = track(new PgAgentGateway({ connectionString: pgc.agentUrl }));
      const other = { ...RELEASE, buildId: "9".repeat(64) };
      const service = new FleetService({ admin: svc, agent: gateway, realReplicationEnabled: true, reaperIntervalMs: 0, release: other, allowLegacyBearer: true });
      const { url } = await service.listen(0, "127.0.0.1");
      try {
        const root = await enrollRoot();
        const res = await admin.reserveSlot({ parentAgentId: root.agent.agentId, requestedBy: "t", name: "c", runtime: PIN });
        if (!res.ok) throw new Error(res.reason);
        const r = await fetch(`${url}/v1/replication/claim`, {
          method: "POST",
          headers: { authorization: `Bearer ${root.cred.token}`, "content-type": "application/json" },
          body: JSON.stringify({ reservationId: res.lease!.reservationId, localChildId: "x" }),
        });
        expect(r.status).toBe(409);
        expect((await r.json()).code).toBe("FLEET_RUNTIME_UNVERIFIED");
        expect(await status(res.agent.agentId)).toBe("failed");
        expect(await events("runtime_release_mismatch")).toBe(1);
      } finally {
        await service.close();
      }
    });

    it("dead agents' sandboxes are queued for controller termination; unsupported termination is recorded, not hidden", async () => {
      const gateway = track(new PgAgentGateway({ connectionString: pgc.agentUrl }));
      const terminated: string[] = [];
      const working: SandboxTerminator = { name: "fake", guaranteed: true, terminate: async (id) => (terminated.push(id), { status: "terminated" }) };
      const root = await enrollRoot();
      const a = await activeChild(root.agent.agentId, "sbx-a");
      const b = await activeChild(root.agent.agentId, "sbx-b");
      await svc.markDead(a.agentId, "x", "t");
      const s1 = new FleetService({ admin: svc, agent: gateway, realReplicationEnabled: false, reaperIntervalMs: 0, release: RELEASE, terminator: new UnsupportedSandboxTerminator() });
      await s1.processTerminations();
      await svc.markDead(b.agentId, "x", "t");
      const s2 = new FleetService({ admin: svc, agent: gateway, realReplicationEnabled: false, reaperIntervalMs: 0, release: RELEASE, terminator: working });
      await s2.processTerminations();
      const t = await svc.listTerminations();
      expect(t.find((x) => x.agentId === a.agentId)).toMatchObject({ sandboxId: "sbx-a", status: "unsupported" });
      expect(t.find((x) => x.agentId === b.agentId)).toMatchObject({ sandboxId: "sbx-b", status: "terminated" });
      expect(terminated).toEqual(["sbx-b"]);
      expect(await events("sandbox_termination_unsupported", a.agentId)).toBe(1);
      expect((await svc.staleness()).unterminatedSandboxes).toBe(1);
    });
  });

  // ── Doctor

  describe("fleet:doctor readiness verdict", () => {
    let dir: string;
    let paths: NonNullable<Parameters<typeof runDoctor>[0]["paths"]>;
    let started: Awaited<ReturnType<typeof startFleetServiceFromEnv>> | null = null;

    beforeEach(() => {
      dir = tmpDir();
      const etc = path.join(dir, "etc");
      fs.mkdirSync(etc);
      fs.writeFileSync(path.join(etc, "admin.env"), "FLEET_ADMIN_DATABASE_URL=x\n", { mode: 0o640 });
      fs.writeFileSync(path.join(etc, "service.env"), "FLEET_SERVICE_DATABASE_URL=x\n", { mode: 0o600 });
      fs.writeFileSync(path.join(dir, "passwd"), "root:x:0:0::/root:/bin/bash\nautomaton-fleet-service:x:990:990::/var/lib/automaton-fleet:/usr/sbin/nologin\nautomaton-agent:x:1001:1001::/home/automaton-agent:/usr/sbin/nologin\n");
      fs.writeFileSync(path.join(dir, "group"), "automaton-fleet-admin:x:989:op\n");
      fs.writeFileSync(path.join(dir, "unit"), "[Service]\n");
      paths = {
        cwd: dir,
        etcDir: etc,
        adminEnv: path.join(etc, "admin.env"),
        serviceEnv: path.join(etc, "service.env"),
        passwd: path.join(dir, "passwd"),
        group: path.join(dir, "group"),
        systemdUnit: path.join(dir, "unit"),
      };
    });

    afterEach(async () => {
      await started?.stop();
      started = null;
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const flagsOff = { REAL_REPLICATION_ENABLED: "false", REAL_PAYMENTS_ENABLED: "false", OWNER_SWEEP_ENABLED: "false" };

    it("fully deployed: deployment OK, but real replication UNSAFE (termination + remote networking blockers) and reported facts", async () => {
      await enrollRoot();
      started = await startFleetServiceFromEnv(
        { FLEET_SERVICE_DATABASE_URL: pgc.serviceUrl, FLEET_AGENT_DATABASE_URL: pgc.agentUrl, FLEET_API_LISTEN: "127.0.0.1:0", FLEET_REAPER_INTERVAL_MS: "60000", ...RELEASE_ENV },
        { log: () => {} },
      );
      await started.service.reapOnce();
      const report = await runDoctor({ env: { ...flagsOff, ...RELEASE_ENV, FLEET_API_URL: started.url }, store: admin, paths });
      const failing = report.checks.filter((c) => c.status === "fail");
      expect(failing, JSON.stringify(failing)).toEqual([]);
      expect(report.deploymentOk).toBe(true);
      expect(report.replicationSafe).toBe(false);
      expect(report.blockers.join("\n")).toMatch(/Sandbox termination cannot be guaranteed/);
      expect(report.blockers.join("\n")).toMatch(/cannot reach the fleet service/);
      expect(report.facts).toMatchObject({
        schemaVersion: FLEET_PG_SCHEMA_VERSION,
        serviceState: "ready",
        runtimeRepo: PIN.repo,
        runtimeCommit: PIN.commit,
        runtimeBuildId: BUILD.buildId,
        replicationEnabled: false,
        paymentsEnabled: false,
        ownerSweepEnabled: false,
        fleetMaximum: 5,
        livingAgents: 1,
        reservedSlots: 0,
        staleAgents: 0,
        staleReservations: 0,
        privilegeProblems: [],
      });
      const text = formatDoctorReport(report);
      expect(text).toMatch(/DEPLOYMENT:\s+OK/);
      expect(text).toMatch(/REAL REPLICATION:\s+UNSAFE — FAIL/);
    });

    it("missing DB, service unavailable, missing OS users, legacy secrets and an enabled flag all FAIL", async () => {
      fs.writeFileSync(path.join(dir, "passwd"), "root:x:0:0::/root:/bin/bash\n");
      fs.writeFileSync(path.join(dir, ".env.fleet"), "DATABASE_URL=postgresql://o:p@h/d\n");
      fs.chmodSync(paths.serviceEnv!, 0o644);
      const unreachable = track(new PgFleetStore({ connectionString: "postgresql://nobody:x@127.0.0.1:1/none", connectTimeoutMs: 500 }));
      const report = await runDoctor({
        env: { ...flagsOff, REAL_PAYMENTS_ENABLED: "true", FLEET_API_URL: "http://127.0.0.1:1" },
        store: unreachable,
        paths,
        fetchImpl: fetch,
      });
      const byName = Object.fromEntries(report.checks.map((c) => [c.name, c.status]));
      expect(byName["database connectivity"]).toBe("fail");
      expect(byName["fleet service"]).toBe("fail");
      expect(byName["os user automaton-fleet-service"]).toBe("fail");
      expect(byName["flag REAL_PAYMENTS_ENABLED"]).toBe("fail");
      expect(byName["secret file service.env"]).toBe("fail");
      expect(report.securityWarnings.join(" ")).toMatch(/\.env\.fleet still contains controller secrets \(DATABASE_URL\)/);
      expect(report.facts.serviceState).toBe("unavailable");
      expect(report.deploymentOk).toBe(false);
      expect(report.replicationSafe).toBe(false);
      expect(formatDoctorReport(report)).not.toContain("postgresql://o:p@");
    });

    it("no DB configured and an over-privileged agent role are both blockers", async () => {
      const none = await runDoctor({ env: flagsOff, store: null, paths, fetchImpl: (async () => { throw new Error("down"); }) as typeof fetch });
      expect(none.checks.find((c) => c.name === "database connectivity")!.status).toBe("fail");
      await ownerRaw.query("GRANT SELECT ON fleet.fleet_agents TO fleet_agent");
      try {
        const r = await runDoctor({ env: { ...flagsOff, ...RELEASE_ENV }, store: admin, paths, fetchImpl: (async () => { throw new Error("down"); }) as typeof fetch });
        expect(r.checks.find((c) => c.name === "database privileges")).toMatchObject({ status: "fail" });
        expect(r.blockers.join(" ")).toMatch(/privileges are too broad/);
      } finally {
        await ownerRaw.query("REVOKE SELECT ON fleet.fleet_agents FROM fleet_agent");
      }
    });

    it("stale agents/reservations are reported; a runtime release mismatch fails", async () => {
      const root = await enrollRoot();
      await admin.reserveSlot({ parentAgentId: root.agent.agentId, requestedBy: "t", name: "c", runtime: PIN });
      await ownerRaw.query("UPDATE fleet.fleet_reservations SET expires_at = now() - interval '1 second'");
      await ageHeartbeat(root.agent.agentId, 500);
      const r = await runDoctor({
        env: { ...flagsOff, ...RELEASE_ENV, FLEET_RUNTIME_COMMIT: "a".repeat(40) },
        store: admin,
        paths,
        fetchImpl: (async () => { throw new Error("down"); }) as typeof fetch,
      });
      expect(r.facts).toMatchObject({ staleAgents: 1, staleReservations: 1 });
      expect(r.checks.find((c) => c.name === "approved runtime")).toMatchObject({ status: "fail" });
      expect(r.blockers.join(" ")).toMatch(/differs from the registry-approved runtime/);
    });
  });

  it("privilege audit is also usable from any connection (e.g. the service role) and sees the same result", async () => {
    const viaService = await auditPrivileges(serviceRaw);
    expect(viaService.ok).toBe(true);
  });
});

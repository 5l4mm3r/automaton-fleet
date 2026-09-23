/**
 * Fleet Layer Tests (Phase 3): restricted DB role, fleet service API,
 * reservation leases, heartbeat expiry/reaper, runtime attestation,
 * reproducible child builds, secret isolation.
 *
 * PostgreSQL tests run against a throwaway cluster started by this file
 * (initdb as the current user; see fixtures/ephemeral-pg.ts) so real,
 * non-superuser roles can be created exactly as scripts/fleet-db-roles.sql
 * does in production. They are skipped (loudly) if PostgreSQL binaries are
 * not installed.
 *
 * Describe names include "policy", "security" and "financial" so these tests
 * also run under test:security and test:financial.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import { randomBytes } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { ulid } from "ulid";
import {
  DEFAULT_FLEET_CONFIG,
  FleetApiClient,
  FleetRuntimeError,
  FleetService,
  PgAgentGateway,
  PgFleetStore,
  SharedFleetController,
  agentChildEnv,
  findPrivilegedEnv,
  isPrivilegedEnvName,
  scrubPrivilegedEnv,
  validateServiceUrl,
  verifyOwnRuntime,
} from "../../fleet/index.js";
import type { FleetConfig, FleetSpawnGrant, RuntimePin } from "../../fleet/index.js";
import {
  ATTEST_SCRIPT,
  attestationProof,
  checkAttestation,
  computeBuildIdentity,
  parseAttestation,
  type RuntimeAttestation,
} from "../../fleet/attestation.js";
import { claimFleetGrant, type ClaimedGrant } from "../../fleet/grants.js";
import { buildRuntimeInstallCommand, CHILD_PNPM_VERSION } from "../../fleet/runtime.js";
import { AGENT_API_FUNCTIONS } from "../../fleet/postgres/migrations.js";
import { startFleetServiceFromEnv } from "../../fleet/service/main.js";
import { CHILD_FLEET_CREDENTIALS, deliverChildCredential, spawnChild } from "../../replication/spawn.js";
import { ChildLifecycle } from "../../replication/lifecycle.js";
import { createConwayClient } from "../../conway/client.js";
import { getForbiddenCommandMatch } from "../../agent/policy-rules/command-safety.js";
import { isSensitiveFile } from "../../agent/policy-rules/path-protection.js";
import { isProtectedFile } from "../../self-mod/code.js";
import type { AutomatonDatabase, GenesisConfig } from "../../types.js";
import {
  MockConwayClient,
  TEST_RUNTIME_BUILD,
  TEST_RUNTIME_PIN,
  createTestDb,
  createTestIdentity,
  isFleetSandboxCheck,
  runtimeVerifyStdout,
  type SandboxRuntimeState,
} from "../mocks.js";
import { wipeRegistry } from "./fixtures/wipe.js";
import { findPgBin, startEphemeralPg, type EphemeralPg } from "./fixtures/ephemeral-pg.js";

vi.mock("../../registry/erc8004.js", () => ({
  queryAgent: vi.fn(),
  getTotalAgents: vi.fn().mockResolvedValue(0),
  registerAgent: vi.fn(),
  leaveFeedback: vi.fn(),
}));

const PIN: RuntimePin = TEST_RUNTIME_PIN;
const BUILD = TEST_RUNTIME_BUILD;
const identity = createTestIdentity();

function wallet(): string {
  return `0x${randomBytes(20).toString("hex")}`;
}

function fleetConfig(overrides: Partial<FleetConfig> = {}): FleetConfig {
  return { ...DEFAULT_FLEET_CONFIG, configuredMode: "EXPANSION", realReplicationEnabled: true, maxAgents: 50, runtime: PIN, ...overrides };
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
  return { ...a, proof: overrides.proof ?? attestationProof(a) };
}

function fakeSpawn(localDb: AutomatonDatabase, tamper: Partial<RuntimeAttestation> = {}) {
  return async (grant: FleetSpawnGrant) => {
    const claimed = await claimFleetGrant(grant, ulid(), localDb.raw);
    return {
      address: wallet(),
      sandboxId: `sbx-${ulid()}`,
      runtimeCommit: claimed.runtime!.commit,
      attestation: honestAttestation(claimed, tamper),
    };
  };
}

function mockSandbox(state: SandboxRuntimeState = {}): MockConwayClient {
  const conway = new MockConwayClient();
  const w = wallet();
  vi.spyOn(conway, "exec").mockImplementation(async (command: string) => {
    if (isFleetSandboxCheck(command)) return { stdout: runtimeVerifyStdout(state, command), stderr: "", exitCode: 0 };
    if (command.includes("--init")) return { stdout: `Wallet initialized: ${w}`, stderr: "", exitCode: 0 };
    return { stdout: "ok", stderr: "", exitCode: 0 };
  });
  return conway;
}

const genesis: GenesisConfig = {
  name: "phase3-child",
  genesisPrompt: "You are a fleet child.",
  creatorAddress: identity.address,
  parentAddress: identity.address,
};

// ─── Reproducible child builds ──────────────────────────────────

describe("Fleet security: reproducible child builds (pnpm, frozen lockfile)", () => {
  it("the repository uses pnpm with a lockfile and no npm lockfile", () => {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    expect(pkg.packageManager).toBe(`pnpm@${CHILD_PNPM_VERSION}`);
    expect(fs.existsSync("pnpm-lock.yaml")).toBe(true);
    expect(fs.existsSync("package-lock.json")).toBe(false);
  });

  it("child install verifies the lockfile hash, then runs pnpm install --frozen-lockfile (never npm install)", () => {
    const cmd = buildRuntimeInstallCommand(PIN, BUILD);
    const steps = cmd.split(" && ");
    const check = steps.findIndex((s) => s.includes(`${BUILD.lockfileSha256}  pnpm-lock.yaml`) && s.includes("sha256sum -c"));
    const install = steps.findIndex((s) => s === "CI=true pnpm install --frozen-lockfile");
    expect(check).toBeGreaterThan(0);
    expect(install).toBeGreaterThan(check);
    expect(steps.indexOf("pnpm build")).toBeGreaterThan(install);
    expect(steps.some((s) => s.includes(`test "$(pnpm --version)" = '${CHILD_PNPM_VERSION}'`))).toBe(true);
    // The only npm use is installing the pinned pnpm itself.
    expect(cmd.replace(`npm install -g --no-audit --no-fund pnpm@${CHILD_PNPM_VERSION}`, "")).not.toMatch(/\bnpm (install|run|ci)\b/);
  });

  it("install refuses without an approved build identity", () => {
    expect(() => buildRuntimeInstallCommand(PIN, null as never)).toThrow(FleetRuntimeError);
    expect(() => buildRuntimeInstallCommand(PIN, { buildId: "x", lockfileSha256: BUILD.lockfileSha256 })).toThrow(FleetRuntimeError);
  });

  it("the parent-supplied verifier computes the same build identity as the controller", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-build-"));
    try {
      fs.mkdirSync(path.join(dir, "src", "x"), { recursive: true });
      fs.mkdirSync(path.join(dir, "dist"));
      fs.writeFileSync(path.join(dir, "package.json"), '{"version":"1.2.3"}');
      fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      fs.writeFileSync(path.join(dir, "src", "x", "a.ts"), "export const a = 1;\n");
      fs.writeFileSync(path.join(dir, "dist", "a.js"), "export const a = 1;\n");
      // The verifier lives outside the tree it measures, as in the child sandbox (/tmp).
      const scriptPath = path.join(os.tmpdir(), `${path.basename(dir)}-attest.cjs`);
      fs.writeFileSync(scriptPath, ATTEST_SCRIPT);
      const nonce = "c".repeat(64);
      const out = execFileSync(process.execPath, [scriptPath, dir, nonce], { encoding: "utf8" });
      fs.rmSync(scriptPath);
      const att = parseAttestation(out);
      const mine = computeBuildIdentity(dir);
      expect(att.buildId).toBe(mine.buildId);
      expect(att.lockfileSha256).toBe(mine.lockfileSha256);
      expect(att.fileCount).toBe(mine.fileCount);
      expect(att.nonce).toBe(nonce);
      // Any change to built output changes the build identity.
      fs.writeFileSync(path.join(dir, "dist", "a.js"), "export const a = 2;\n");
      expect(computeBuildIdentity(dir).buildId).not.toBe(mine.buildId);
      fs.rmSync(path.join(dir, "pnpm-lock.yaml"));
      expect(() => computeBuildIdentity(dir)).toThrow(/lockfile integrity/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the real repository tree hashes identically in both implementations", () => {
    if (!fs.existsSync("dist")) return; // requires `pnpm build`
    const script = path.join(os.tmpdir(), `attest-${ulid()}.cjs`);
    fs.writeFileSync(script, ATTEST_SCRIPT);
    try {
      const att = parseAttestation(execFileSync(process.execPath, [script, process.cwd(), "d".repeat(64)], { encoding: "utf8" }));
      expect(att.buildId).toBe(computeBuildIdentity(process.cwd()).buildId);
    } finally {
      fs.rmSync(script);
    }
  });

  it.runIf(process.env.FLEET_REPRO_TEST === "1")(
    "two clean clones built with --frozen-lockfile have the same build identity",
    () => {
      const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const ids: string[] = [];
      for (let i = 0; i < 2; i++) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fleet-repro-${i}-`));
        try {
          execFileSync("git", ["clone", "-q", process.cwd(), dir]);
          execFileSync("git", ["-C", dir, "checkout", "-q", "--detach", head]);
          execFileSync("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], { cwd: dir, stdio: "ignore", env: { ...process.env, CI: "true" } });
          execFileSync("pnpm", ["build"], { cwd: dir, stdio: "ignore" });
          ids.push(computeBuildIdentity(dir).buildId);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
      expect(ids[0]).toBe(ids[1]);
    },
    600_000,
  );
});

// ─── Runtime verification (pure) ────────────────────────────────

describe("Fleet security: runtime attestation checks", () => {
  const claimed: ClaimedGrant = {
    agentId: ulid(), parentAgentId: ulid(), generation: 1, runtime: PIN, expectedBuild: BUILD,
    nonce: "a".repeat(64), reservationId: ulid(), backend: "postgres",
  };
  const expected = { ...PIN, ...BUILD, nonce: claimed.nonce! };

  it("accepts an attestation matching repo, commit, lockfile, build and nonce", () => {
    expect(checkAttestation(honestAttestation(claimed), expected).buildId).toBe(BUILD.buildId);
  });

  it("does not rely on the child's commit alone: build, lockfile, nonce, cleanliness and proof are all checked", () => {
    const bad: Array<[Partial<RuntimeAttestation>, RegExp]> = [
      [{ nonce: "b".repeat(64) }, /nonce/],
      [{ commit: "f".repeat(40) }, /commit/],
      [{ repo: "https://github.com/attacker/automaton" }, /repository/],
      [{ lockfileSha256: "2".repeat(64) }, /lockfile/],
      [{ buildId: "3".repeat(64) }, /build/],
      [{ clean: false }, /modified/],
      [{ proof: "0".repeat(64) }, /proof/],
    ];
    for (const [tamper, re] of bad) expect(() => checkAttestation(honestAttestation(claimed, tamper), expected)).toThrow(re);
    expect(() => checkAttestation(null, expected)).toThrow(/no attestation/);
    expect(() => parseAttestation("garbage")).toThrow(FleetRuntimeError);
  });
});

describe("Fleet security: child refuses startup when lockfile/build cannot be verified", () => {
  let dir: string;
  let head: string;
  const manifestPath = () => path.join(dir, "manifest.json");
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-self-"));
    const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    fs.mkdirSync(path.join(dir, "src"));
    fs.mkdirSync(path.join(dir, "dist"));
    fs.writeFileSync(path.join(dir, "src", "a.ts"), "export {};\n");
    fs.writeFileSync(path.join(dir, "package.json"), "{}\n");
    fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    fs.writeFileSync(path.join(dir, ".gitignore"), "dist\nmanifest.json\n");
    git("add", ".");
    git("commit", "-qm", "init");
    git("remote", "add", "origin", PIN.repo);
    fs.writeFileSync(path.join(dir, "dist", "a.js"), "export {};\n");
    head = git("rev-parse", "HEAD");
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  function manifest(extra: object) {
    fs.writeFileSync(manifestPath(), JSON.stringify({ agentId: ulid(), parentAgentId: ulid(), generation: 1, repo: PIN.repo, commit: head, ...extra }));
  }

  it("starts when lockfile and build identity match", () => {
    manifest(computeBuildIdentity(dir));
    expect(verifyOwnRuntime({ isChild: true, manifestPath: manifestPath(), runtimeDir: dir })).toMatchObject({ ok: true });
  });

  it("refuses when the manifest carries no approved build identity", () => {
    manifest({});
    const r = verifyOwnRuntime({ isChild: true, manifestPath: manifestPath(), runtimeDir: dir });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/lockfile integrity cannot be verified/);
  });

  it("refuses when the lockfile does not match", () => {
    manifest({ ...computeBuildIdentity(dir), lockfileSha256: "9".repeat(64) });
    const r = verifyOwnRuntime({ isChild: true, manifestPath: manifestPath(), runtimeDir: dir });
    expect(!r.ok && r.reason).toMatch(/pnpm-lock\.yaml does not match/);
  });

  it("refuses when the built output differs from the approved build", () => {
    manifest(computeBuildIdentity(dir));
    fs.writeFileSync(path.join(dir, "dist", "a.js"), "export const backdoor = 1;\n");
    try {
      const r = verifyOwnRuntime({ isChild: true, manifestPath: manifestPath(), runtimeDir: dir });
      expect(!r.ok && r.reason).toMatch(/does not match approved build/);
    } finally {
      fs.writeFileSync(path.join(dir, "dist", "a.js"), "export {};\n");
    }
  });

  it("refuses when the lockfile is missing entirely", () => {
    manifest(computeBuildIdentity(dir));
    fs.renameSync(path.join(dir, "pnpm-lock.yaml"), path.join(dir, "lock.bak"));
    try {
      expect(verifyOwnRuntime({ isChild: true, manifestPath: manifestPath(), runtimeDir: dir }).ok).toBe(false);
    } finally {
      fs.renameSync(path.join(dir, "lock.bak"), path.join(dir, "pnpm-lock.yaml"));
    }
  });
});

// ─── Secret isolation / shell hardening ─────────────────────────

describe("Fleet security: agent processes never receive privileged secrets", () => {
  it("classifies controller DB, owner wallet, signing and admin secrets as privileged", () => {
    for (const k of [
      "DATABASE_URL", "FLEET_CONTROLLER_DATABASE_URL", "FLEET_AGENT_DATABASE_URL", "PGPASSWORD", "PGUSER",
      "OWNER_PRIVATE_KEY", "OWNER_WALLET_MNEMONIC", "FLEET_SIGNING_SECRET", "FLEET_CONTROLLER_SIGNING_KEY",
      "FLEET_ADMIN_TOKEN", "TREASURY_PRIVATE_KEY", "REDIS_URL",
    ]) expect(isPrivilegedEnvName(k)).toBe(true);
    // Allowed: the agent's own tool credentials and non-secret fleet switches.
    for (const k of ["CONWAY_API_KEY", "OWNER_SWEEP_ENABLED", "FLEET_API_URL", "FLEET_MODE", "REAL_REPLICATION_ENABLED", "HOME", "PATH"]) {
      expect(isPrivilegedEnvName(k)).toBe(false);
    }
  });

  it("scrubs privileged variables and builds a clean child env, keeping allowed tools usable", () => {
    const env: Record<string, string | undefined> = { DATABASE_URL: "postgresql://fleetadmin:pw@h/db", PGPASSWORD: "pw", CONWAY_API_KEY: "ck", PATH: "/bin" };
    expect(findPrivilegedEnv(env)).toEqual(["DATABASE_URL", "PGPASSWORD"]);
    const child = agentChildEnv(env);
    expect(child).toEqual({ CONWAY_API_KEY: "ck", PATH: "/bin" });
    expect(scrubPrivilegedEnv(env)).toEqual(["DATABASE_URL", "PGPASSWORD"]);
    expect(env).toEqual({ CONWAY_API_KEY: "ck", PATH: "/bin" });
  });

  it("agent shell commands (local exec) do not see DATABASE_URL even if it is in the process env", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://fleetadmin:secret@localhost/automaton_fleet");
    vi.stubEnv("OWNER_PRIVATE_KEY", "0x" + "11".repeat(32));
    try {
      const conway = createConwayClient({ apiUrl: "https://api.conway.tech", apiKey: "k", sandboxId: "" });
      const r = await conway.exec("env", 10_000);
      expect(r.stdout).toContain("PATH=");
      expect(r.stdout).not.toMatch(/DATABASE_URL|fleetadmin|OWNER_PRIVATE_KEY/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("the automaton refuses to --run with admin DB credentials in its environment", () => {
    const tsx = path.resolve("node_modules/.bin/tsx");
    const r = spawnSync(tsx, ["src/index.ts", "--run"], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, DATABASE_URL: "postgresql://fleetadmin:secret@localhost/x", HOME: fs.mkdtempSync(path.join(os.tmpdir(), "home-")) },
    });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/Refusing to start: privileged fleet\/owner secrets/);
    expect(r.stdout + r.stderr).not.toContain("secret@");
  }, 60_000);

  it("shell guard blocks secret reads, env overrides, service commands and role changes", () => {
    for (const cmd of [
      "cat ~/projects/automaton-fleet/.env.fleet",
      "grep DATABASE /proc/1/environ",
      "tr '\\0' '\\n' < /proc/self/environ",
      "base64 ~/.automaton/fleet-credentials.json",
      "FLEET_API_URL=https://evil.example node x.js",
      "FLEET_CONTROLLER_DATABASE_URL=postgres://x psql",
      "pnpm fleet:service",
      "psql -c 'SET ROLE fleet_owner'",
      "psql -c 'ALTER ROLE fleet_agent_login SUPERUSER'",
      "psql -c 'CREATE FUNCTION f() ... SECURITY DEFINER'",
    ]) expect(getForbiddenCommandMatch(cmd), cmd).not.toBeNull();
    expect(getForbiddenCommandMatch("ls -la && git status")).toBeNull();
    expect(isSensitiveFile("/home/u/projects/automaton-fleet/.env.fleet")).toBe(true);
    expect(isSensitiveFile("/root/.automaton/fleet-credentials.json")).toBe(true);
    for (const f of ["fleet/attestation.ts", "fleet/secrets.ts", "fleet/service/server.ts", "fleet/postgres/agent-gateway.ts", "fleet/backend.ts"]) {
      expect(isProtectedFile(path.join("/root/automaton/src", f)), f).toBe(true);
    }
  });

  it("the fleet service only accepts https (or loopback http) URLs without credentials", () => {
    expect(validateServiceUrl("https://fleet.example.com/")).toBe("https://fleet.example.com");
    expect(validateServiceUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(() => validateServiceUrl("http://fleet.example.com")).toThrow(/https/);
    expect(() => validateServiceUrl("https://u:p@fleet.example.com")).toThrow(/credentials/);
  });
});

describe("Fleet financial safety flags remain disabled (treasury)", () => {
  it(".env.fleet keeps real replication, payments and owner sweep disabled", () => {
    if (!fs.existsSync(".env.fleet")) return;
    const text = fs.readFileSync(".env.fleet", "utf8");
    for (const k of ["REAL_REPLICATION_ENABLED", "REAL_PAYMENTS_ENABLED", "OWNER_SWEEP_ENABLED"]) {
      expect(text).toMatch(new RegExp(`^${k}=false$`, "m"));
    }
  });
});

// ─── PostgreSQL: roles, leases, reaper, attestation, service ────

const PG_BIN = findPgBin();
if (!PG_BIN) {
  console.warn("[fleet-phase3] PostgreSQL binaries (initdb/pg_ctl) not found — restricted-role tests SKIPPED. Set PG_BIN.");
}

describe.skipIf(!PG_BIN)("Fleet security policy: restricted PostgreSQL agent role", () => {
  let pgc: EphemeralPg;
  let admin: PgFleetStore;
  let ownerRaw: pg.Pool;
  let agentRaw: pg.Pool;
  let db: AutomatonDatabase;
  const opened: Array<{ close(): Promise<void> }> = [];

  function store(o: Partial<ConstructorParameters<typeof PgFleetStore>[0]> = {}): PgFleetStore {
    const s = new PgFleetStore({ connectionString: pgc.ownerUrl, ...o });
    opened.push(s);
    return s;
  }

  async function events(type: string, agentId?: string): Promise<number> {
    const r = await ownerRaw.query(
      "SELECT count(*)::int AS n FROM fleet.fleet_events WHERE event_type = $1 AND ($2::text IS NULL OR agent_id = $2)",
      [type, agentId ?? null],
    );
    return r.rows[0].n;
  }

  async function occupancy() {
    const s = await admin.getState();
    return { living: s.livingAgents, reserved: s.reservedSlots, consistent: (await admin.health()).countersConsistent };
  }

  /** Wipe registry rows (owner only, throwaway cluster) and configure for EXPANSION. */
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
    await admin.setMaxAgents(max, "test");
    await admin.setOperatingMode("EXPANSION", "test", "test");
    await admin.setApprovedRuntime(PIN, "test", BUILD);
    await admin.setReplicationEnabled(true, "test");
    await admin.setTimeouts({ reservationTtlS: 1800, provisioningTtlS: 2700, heartbeatUnresponsiveS: 120, heartbeatDeadS: 600 }, "test");
  }

  /** Root registered + credential issued (what `fleet:admin enroll-root` does). */
  async function enrollRoot(name = "root") {
    const reg = await admin.registerRoot({ walletAddress: wallet(), name });
    if (!reg.ok) throw new Error(reg.reason);
    const cred = await admin.issueCredential(reg.agent.agentId, "test");
    return { agent: reg.agent, cred };
  }

  /** An active child with its own credential, via the full admin path. */
  async function activeChild(parentId: string) {
    const res = await admin.reserveSlot({ parentAgentId: parentId, requestedBy: "t", name: "kid", runtime: PIN });
    if (!res.ok) throw new Error(res.reason);
    const claimed = await admin.claimGrant(res.agent.agentId, ulid());
    const act = await admin.activate(res.agent.agentId, {
      walletAddress: wallet(),
      runtimeCommit: PIN.commit,
      attestation: honestAttestation(claimed),
    });
    return { agentId: res.agent.agentId, cred: act.credential };
  }

  /** Make the reaper treat heartbeats older than now as real (no outage grace). */
  async function armReaper() {
    await ownerRaw.query("UPDATE fleet.fleet_state SET reaper_last_run_at = now(), reaper_grace_from = '-infinity'");
  }

  async function ageHeartbeat(agentId: string, seconds: number) {
    await ownerRaw.query(`UPDATE fleet.fleet_agents SET last_heartbeat = now() - make_interval(secs => $2) WHERE agent_id = $1`, [agentId, seconds]);
  }

  beforeAll(async () => {
    pgc = await startEphemeralPg(PG_BIN!);
    ownerRaw = new pg.Pool({ connectionString: pgc.ownerUrl, max: 10 });
    agentRaw = new pg.Pool({ connectionString: pgc.agentUrl, max: 10 });
    admin = store();
    await admin.migrate();
  }, 60_000);

  afterAll(async () => {
    for (const s of opened) await s.close();
    await ownerRaw?.end();
    await agentRaw?.end();
    pgc?.stop();
  });

  beforeEach(async () => {
    db = createTestDb();
    await reset();
  });
  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const expectDenied = async (sql: string, params: unknown[] = []) => {
    await expect(agentRaw.query(sql, params), sql).rejects.toMatchObject({ code: expect.stringMatching(/^(42501|42P01|3F000|0A000)$/) });
  };

  // ── Role model ──

  it("the owner cannot create roles (like production fleetadmin); the agent role holds no table privileges", async () => {
    await expect(ownerRaw.query("CREATE ROLE x")).rejects.toThrow(/permission denied/);
    const gw = new PgAgentGateway({ connectionString: pgc.agentUrl });
    opened.push(gw);
    expect(await gw.selfCheck()).toEqual([]);
    const owner = new PgAgentGateway({ connectionString: pgc.ownerUrl });
    opened.push(owner);
    expect((await owner.selfCheck()).join(" ")).toMatch(/owns schema fleet/);
    const fns = await ownerRaw.query(
      `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS f
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'fleet' AND has_function_privilege('fleet_agent_login', p.oid, 'EXECUTE')`,
    );
    const granted = fns.rows.map((r) => r.f.replace(/p_\w+ /g, "").replace(/,\s*/g, ", ")).sort();
    expect(granted).toEqual([...AGENT_API_FUNCTIONS].sort());
  });

  it("agent cannot modify the fleet cap (or any fleet_state setting)", async () => {
    await expectDenied("UPDATE fleet.fleet_state SET max_agents = 50");
    await expectDenied("UPDATE fleet.fleet_state SET replication_enabled = true, operating_mode = 'EXPANSION'");
    await expectDenied("SELECT * FROM fleet.fleet_state");
    await expectDenied("SELECT fleet.fleet_lock_state()");
    expect((await admin.getState()).maxAgents).toBe(5);
  });

  it("agent cannot change another agent (direct SQL or through the API with its own token)", async () => {
    const a = await enrollRoot("a");
    const b = await enrollRoot("b");
    await expectDenied("UPDATE fleet.fleet_agents SET status = 'dead' WHERE agent_id = $1", [b.agent.agentId]);
    await expectDenied("UPDATE fleet.fleet_agent_credentials SET revoked_at = now()");
    await expectDenied("SELECT fleet.fleet_mark_dead($1, 'x', 'x', 'x')", [b.agent.agentId]);
    const call = async (fn: string, args: unknown[]) =>
      (await agentRaw.query(`SELECT fleet.${fn}(${args.map((_, i) => `$${i + 1}`).join(",")}) AS r`, args)).rows[0].r;
    // A's token cannot act as B.
    expect(await call("api_set_own_status", [b.agent.agentId, a.cred.token, "dead", "x"])).toMatchObject({ ok: false, code: "FLEET_AUTH_FAILED" });
    expect(await call("api_heartbeat", [b.agent.agentId, a.cred.token])).toMatchObject({ ok: false, code: "FLEET_AUTH_FAILED" });
    // B's reservation cannot be released by A.
    const res = await admin.reserveSlot({ parentAgentId: b.agent.agentId, requestedBy: "b", name: "c", runtime: PIN });
    if (!res.ok) throw new Error(res.reason);
    expect(await call("api_release_reservation", [a.agent.agentId, a.cred.token, res.lease!.reservationId, "x"])).toMatchObject({
      ok: false,
      code: "FLEET_NOT_AUTHORIZED",
    });
    expect((await admin.getAgent(b.agent.agentId))!.status).toBe("active");
    expect((await admin.getAgent(res.agent.agentId))!.status).toBe("reserved");
    expect(await events("db_auth_failed")).toBeGreaterThanOrEqual(2);
    expect(await events("authorization_denied")).toBeGreaterThanOrEqual(1);
    // An agent may update its own status.
    expect(await call("api_set_own_status", [a.agent.agentId, a.cred.token, "active", ""])).toMatchObject({ ok: true });
    expect(await call("api_set_own_status", [a.agent.agentId, a.cred.token, "reserved", ""])).toMatchObject({ ok: false });
  });

  it("agent cannot disable triggers", async () => {
    await expectDenied("ALTER TABLE fleet.fleet_agents DISABLE TRIGGER USER");
    await expectDenied("ALTER TABLE fleet.fleet_agents DISABLE TRIGGER fleet_agents_counters_ins");
    await expectDenied("DROP TRIGGER fleet_agents_counters_ins ON fleet.fleet_agents");
    await expect(agentRaw.query("SET session_replication_role = replica")).rejects.toThrow(/permission denied/);
    const t = await ownerRaw.query(
      "SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'fleet' AND NOT t.tgisinternal AND t.tgenabled = 'O'",
    );
    expect(t.rows[0].n).toBeGreaterThanOrEqual(12);
  });

  it("restricted credentials cannot modify schema, create roles, or create temp shadows", async () => {
    for (const sql of [
      "CREATE TABLE fleet.evil (x int)",
      "CREATE TABLE public.evil (x int)",
      "CREATE TEMP TABLE fleet_agents (x int)",
      "CREATE SCHEMA evil",
      "ALTER TABLE fleet.fleet_agents ADD COLUMN evil int",
      "ALTER TABLE fleet.fleet_state DROP CONSTRAINT fleet_state_max_agents_check",
      "DROP TABLE fleet.fleet_events",
      "CREATE OR REPLACE FUNCTION fleet.fleet_bucket(s text) RETURNS text LANGUAGE sql AS $$ SELECT NULL $$",
      "CREATE FUNCTION fleet.evil() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$",
      "GRANT UPDATE ON fleet.fleet_state TO fleet_agent_login",
      "TRUNCATE fleet.fleet_events",
    ]) {
      await expectDenied(sql);
    }
    // REVOKE without grant option is a no-op (warning), never a privilege change.
    await agentRaw.query("REVOKE EXECUTE ON FUNCTION fleet.api_fleet_state() FROM fleet_agent");
    const still = await ownerRaw.query("SELECT has_function_privilege('fleet_agent_login', 'fleet.api_fleet_state()', 'EXECUTE') AS ok");
    expect(still.rows[0].ok).toBe(true);
    await expect(agentRaw.query("CREATE ROLE evil SUPERUSER")).rejects.toThrow(/permission denied/);
    await expect(agentRaw.query("SET ROLE fleet_owner")).rejects.toThrow(/permission denied/);
  });

  it("agent cannot directly reserve arbitrary slots; only the authenticated API can, within every gate", async () => {
    const root = await enrollRoot();
    await expectDenied(
      "INSERT INTO fleet.fleet_agents (agent_id, parent_agent_id, role, generation, name, runtime_commit, status) VALUES ($1, $2, 'child', 1, 'x', $3, 'reserved')",
      [ulid(), root.agent.agentId, PIN.commit],
    );
    await expectDenied("SELECT fleet.fleet_reserve_slot($1,'x','x','k',NULL,NULL,false,NULL,NULL,$2,$3)", [root.agent.agentId, ulid(), ulid()]);
    await expectDenied("SELECT fleet.fleet_release($1, 'x', 'released', 'x')", [root.agent.agentId]);
    await expectDenied("SELECT fleet.fleet_reap('x')");
    const req = async (token: string) =>
      (
        await agentRaw.query("SELECT fleet.api_request_replication($1, $2, 'kid', $3, $4, $5) AS r", [
          root.agent.agentId, token, ulid(), ulid(), ulid(),
        ])
      ).rows[0].r;
    expect(await req("fa1." + root.agent.agentId + ".forged")).toMatchObject({ ok: false, code: "FLEET_AUTH_FAILED" });
    await admin.setReplicationEnabled(false, "test");
    expect(await req(root.cred.token)).toMatchObject({ ok: false, code: "REAL_REPLICATION_DISABLED" });
    await admin.setReplicationEnabled(true, "test");
    const ok = await req(root.cred.token);
    expect(ok).toMatchObject({ ok: true, parentAgentId: root.agent.agentId, generation: 1 });
    expect(ok.runtime).toEqual(PIN);
    expect(ok.build).toEqual(BUILD);
    await admin.setMaxAgents(2, "test");
    expect(await req(root.cred.token)).toMatchObject({ ok: false, code: "FLEET_CAP_REACHED" });
    expect(await occupancy()).toMatchObject({ living: 1, reserved: 1, consistent: true });
    expect(await events("replication_requested")).toBe(3); // forged token never gets this far
    expect(await events("replication_granted")).toBe(1);
    expect(await events("replication_rejected")).toBe(2);
  });

  // ── Reservation leases & reaper ──

  it("reservation lease records reservation_id, agent_id, created_at, expires_at, status and expectations", async () => {
    const root = await enrollRoot();
    const res = await admin.reserveSlot({ parentAgentId: root.agent.agentId, requestedBy: "t", name: "c", runtime: PIN });
    if (!res.ok) throw new Error(res.reason);
    const lease = (await admin.getReservation(res.lease!.reservationId))!;
    expect(lease).toMatchObject({ agentId: res.agent.agentId, parentAgentId: root.agent.agentId, status: "reserved" });
    expect(lease.expected).toEqual({ ...PIN, ...BUILD });
    expect(new Date(lease.expiresAt).getTime() - new Date(lease.createdAt).getTime()).toBeGreaterThan(29 * 60_000);
    const claimed = await admin.claimGrant(res.agent.agentId, ulid());
    expect(claimed.nonce).toMatch(/^[0-9a-f]{64}$/);
    const after = (await admin.getReservation(res.agent.agentId))!;
    expect(after.status).toBe("provisioning");
    expect(new Date(after.expiresAt).getTime()).toBeGreaterThan(new Date(lease.expiresAt).getTime());
  });

  it("expired reservation releases its slot (reserved and stuck-provisioning leases)", async () => {
    await reset(3);
    const root = await enrollRoot();
    const r1 = await admin.reserveSlot({ parentAgentId: root.agent.agentId, requestedBy: "t", name: "unclaimed", runtime: PIN });
    const r2 = await admin.reserveSlot({ parentAgentId: root.agent.agentId, requestedBy: "t", name: "stuck", runtime: PIN });
    if (!r1.ok || !r2.ok) throw new Error("reserve");
    await admin.claimGrant(r2.agent.agentId, ulid());
    expect(await occupancy()).toMatchObject({ living: 1, reserved: 2 });
    expect((await admin.reserveSlot({ parentAgentId: root.agent.agentId, requestedBy: "t", name: "x", runtime: PIN })).ok).toBe(false);

    await ownerRaw.query("UPDATE fleet.fleet_reservations SET expires_at = now() - interval '1 second'");
    const pass = await admin.reap("test");
    expect(pass.expired).toBe(2);
    expect(await occupancy()).toMatchObject({ living: 1, reserved: 0, consistent: true });
    for (const r of [r1, r2]) {
      expect((await admin.getAgent(r.agent.agentId))!.status).toBe("failed");
      expect((await admin.getReservation(r.agent.agentId))!.status).toBe("expired");
      expect(await events("reservation_expired", r.agent.agentId)).toBe(1);
      expect(await events("slot_released", r.agent.agentId)).toBe(1);
    }
    // The stuck child can no longer be activated even with a valid proof.
    await expect(admin.activate(r2.agent.agentId, { walletAddress: wallet(), runtimeCommit: PIN.commit })).rejects.toThrow(/not in provisioning/);
    expect((await admin.reserveSlot({ parentAgentId: root.agent.agentId, requestedBy: "t", name: "y", runtime: PIN })).ok).toBe(true);
  });

  it("a provisioning lease past expiry cannot be activated even before the reaper runs", async () => {
    const root = await enrollRoot();
    const res = await store({ provisioningTtlMs: 1 }).reserveSlot({ parentAgentId: root.agent.agentId, requestedBy: "t", name: "c", runtime: PIN });
    if (!res.ok) throw new Error(res.reason);
    const claimed = await store({ provisioningTtlMs: 1 }).claimGrant(res.agent.agentId, ulid());
    await new Promise((r) => setTimeout(r, 20));
    await expect(
      admin.activate(res.agent.agentId, { walletAddress: wallet(), runtimeCommit: PIN.commit, attestation: honestAttestation(claimed) }),
    ).rejects.toThrow(/expired/);
    expect((await admin.reap("test")).expired).toBe(1);
  });

  it("missed heartbeats: ACTIVE -> UNRESPONSIVE -> DEAD, and the dead agent releases its living slot", async () => {
    await reset(2);
    const root = await enrollRoot();
    const kid = await activeChild(root.agent.agentId);
    expect(await occupancy()).toMatchObject({ living: 2, reserved: 0 });
    await armReaper();
    await ageHeartbeat(kid.agentId, 200); // > unresponsive (120s), < dead (600s)

    let pass = await admin.reap("test");
    expect(pass).toMatchObject({ unresponsive: 1, dead: 0 });
    expect((await admin.getAgent(kid.agentId))!.status).toBe("unresponsive");
    expect(await occupancy()).toMatchObject({ living: 2 }); // still holds its slot
    expect((await admin.reserveSlot({ parentAgentId: root.agent.agentId, requestedBy: "t", name: "x", runtime: PIN })).ok).toBe(false);

    await ageHeartbeat(kid.agentId, 700);
    pass = await admin.reap("test");
    expect(pass).toMatchObject({ dead: 1 });
    const dead = (await admin.getAgent(kid.agentId))!;
    expect(dead.status).toBe("dead");
    expect(dead.deathTime).not.toBeNull();
    expect(await occupancy()).toMatchObject({ living: 1, consistent: true });
    expect(await events("agent_unresponsive", kid.agentId)).toBe(1);
    expect(await events("agent_died", kid.agentId)).toBe(1);
    expect(await events("slot_released", kid.agentId)).toBe(1);

    // Credential revoked: the dead agent learns it is dead and cannot act.
    const hb = (await agentRaw.query("SELECT fleet.api_heartbeat($1, $2) AS r", [kid.agentId, kid.cred.token])).rows[0].r;
    expect(hb).toMatchObject({ ok: false, code: "FLEET_AGENT_DEAD", status: "dead" });
    const rq = (await agentRaw.query("SELECT fleet.api_request_replication($1,$2,'x',$3,$4,$5) AS r", [kid.agentId, kid.cred.token, ulid(), ulid(), ulid()])).rows[0].r;
    expect(rq).toMatchObject({ ok: false, code: "FLEET_AGENT_DEAD" });
    // Its slot is available again.
    expect((await admin.reserveSlot({ parentAgentId: root.agent.agentId, requestedBy: "t", name: "y", runtime: PIN })).ok).toBe(true);
  });

  it("an unresponsive agent that heartbeats again recovers to ACTIVE", async () => {
    const root = await enrollRoot();
    await armReaper();
    await ageHeartbeat(root.agent.agentId, 300);
    await admin.reap("test");
    expect((await admin.getAgent(root.agent.agentId))!.status).toBe("unresponsive");
    const hb = (await agentRaw.query("SELECT fleet.api_heartbeat($1, $2) AS r", [root.agent.agentId, root.cred.token])).rows[0].r;
    expect(hb).toMatchObject({ ok: true, status: "active" });
    expect(await events("agent_recovered", root.agent.agentId)).toBe(1);
  });

  it("heartbeat timeouts are configurable", async () => {
    const root = await enrollRoot();
    await admin.setTimeouts({ heartbeatUnresponsiveS: 5, heartbeatDeadS: 10 }, "test");
    await armReaper();
    await ageHeartbeat(root.agent.agentId, 7);
    expect((await admin.reap("test")).unresponsive).toBe(1);
    await ageHeartbeat(root.agent.agentId, 11);
    expect((await admin.reap("test")).dead).toBe(1);
    await expect(admin.setTimeouts({ heartbeatUnresponsiveS: 20, heartbeatDeadS: 10 }, "test")).rejects.toThrow(/heartbeat_order/);
  });

  it("a reaper/service outage does not kill agents that could not report (grace window)", async () => {
    const root = await enrollRoot();
    await ageHeartbeat(root.agent.agentId, 3600);
    await ownerRaw.query("UPDATE fleet.fleet_state SET reaper_last_run_at = now() - interval '1 hour', reaper_grace_from = now() - interval '2 hours'");
    const pass = await admin.reap("test");
    expect(pass).toMatchObject({ unresponsive: 0, dead: 0 });
    expect((await admin.getAgent(root.agent.agentId))!.status).toBe("active");
    expect(await events("reaper_resumed")).toBe(1);
  });

  it("duplicate cleanup is harmless: concurrent reapers, double release, double death", async () => {
    await reset(4);
    const root = await enrollRoot();
    const kid = await activeChild(root.agent.agentId);
    const res = await admin.reserveSlot({ parentAgentId: root.agent.agentId, requestedBy: "t", name: "c", runtime: PIN });
    const res2 = await admin.reserveSlot({ parentAgentId: root.agent.agentId, requestedBy: "t", name: "c2", runtime: PIN });
    if (!res.ok || !res2.ok) throw new Error("reserve");
    await ownerRaw.query("UPDATE fleet.fleet_reservations SET expires_at = now() - interval '1 second' WHERE agent_id = $1", [res.agent.agentId]);
    await armReaper();
    await ageHeartbeat(kid.agentId, 5000);

    const reapers = Array.from({ length: 10 }, () => store({ poolMax: 1 }));
    const passes = await Promise.all(reapers.flatMap((s) => [s.reap("r1"), s.reap("r2")]));
    await ageHeartbeat(kid.agentId, 5000);
    passes.push(...(await Promise.all(reapers.map((s) => s.reap("r3")))));
    // Twenty-plus concurrent passes: each transition happened exactly once.
    expect(passes.reduce((n, p) => n + p.expired, 0)).toBe(1);
    expect(passes.reduce((n, p) => n + p.unresponsive, 0)).toBe(1);
    expect(passes.reduce((n, p) => n + p.dead, 0)).toBe(1);

    const releases = await Promise.all([1, 2, 3].map(() => admin.releaseReservation(res2.agent.agentId, "dup")));
    expect(releases.filter(Boolean)).toHaveLength(1);
    const deaths = await Promise.all([1, 2, 3].map(() => admin.markDead(kid.agentId, "dup")));
    expect(deaths.filter(Boolean)).toHaveLength(0); // already dead via reaper
    expect(await admin.releaseReservation(res.agent.agentId, "late")).toBe(false); // already expired

    for (const id of [res.agent.agentId, res2.agent.agentId, kid.agentId]) expect(await events("slot_released", id)).toBe(1);
    expect(await occupancy()).toMatchObject({ living: 1, reserved: 0, consistent: true });
    expect((await admin.health()).ok).toBe(true);
  });

  // ── Runtime verification ──

  it("activation requires runtime proof; failure stops activation, releases the reservation and marks provisioning failed", async () => {
    const root = await enrollRoot();
    const cases: Array<(c: ClaimedGrant) => RuntimeAttestation | null> = [
      () => null, // child only self-reports a commit
      (c) => honestAttestation(c, { buildId: "3".repeat(64) }),
      (c) => honestAttestation(c, { lockfileSha256: "4".repeat(64) }),
      (c) => honestAttestation(c, { nonce: "5".repeat(64) }), // replayed proof
    ];
    for (const make of cases) {
      const res = await admin.reserveSlot({ parentAgentId: root.agent.agentId, requestedBy: "t", name: "c", runtime: PIN });
      if (!res.ok) throw new Error(res.reason);
      const claimed = await admin.claimGrant(res.agent.agentId, ulid());
      await expect(
        admin.activate(res.agent.agentId, { walletAddress: wallet(), runtimeCommit: PIN.commit, attestation: make(claimed) }),
      ).rejects.toThrow(FleetRuntimeError);
      expect((await admin.getAgent(res.agent.agentId))!.status).toBe("failed");
      expect((await admin.getReservation(res.agent.agentId))!.status).toBe("failed");
      expect(await events("runtime_verification_failed", res.agent.agentId)).toBe(1);
      expect(await events("provisioning_failed", res.agent.agentId)).toBe(1);
      expect(await events("slot_released", res.agent.agentId)).toBe(1);
    }
    expect(await occupancy()).toMatchObject({ living: 1, reserved: 0, consistent: true });
    const creds = await ownerRaw.query("SELECT count(*)::int AS n FROM fleet.fleet_agent_credentials");
    expect(creds.rows[0].n).toBe(1); // only the root; failed children never got one
  });

  it("controller records expected repo/commit/build per reservation; a proof for one reservation cannot activate another", async () => {
    const root = await enrollRoot();
    const a = await admin.reserveSlot({ parentAgentId: root.agent.agentId, requestedBy: "t", name: "a", runtime: PIN });
    const b = await admin.reserveSlot({ parentAgentId: root.agent.agentId, requestedBy: "t", name: "b", runtime: PIN });
    if (!a.ok || !b.ok) throw new Error("reserve");
    const ca = await admin.claimGrant(a.agent.agentId, ulid());
    await admin.claimGrant(b.agent.agentId, ulid());
    await expect(
      admin.activate(b.agent.agentId, { walletAddress: wallet(), runtimeCommit: PIN.commit, attestation: honestAttestation(ca) }),
    ).rejects.toThrow(/nonce/);
    const ok = await admin.activate(a.agent.agentId, { walletAddress: wallet(), runtimeCommit: PIN.commit, attestation: honestAttestation(ca) });
    expect(ok.agent.status).toBe("active");
    expect(ok.credential.token).toMatch(/^fa1\./);
    expect(await events("runtime_verified", a.agent.agentId)).toBe(1);
    const stored = await ownerRaw.query("SELECT token_hash FROM fleet.fleet_agent_credentials WHERE agent_id = $1", [a.agent.agentId]);
    expect(stored.rows[0].token_hash).not.toContain(ok.credential.token.slice(4));
  });

  it("spawnChild with a sandbox reporting the wrong build is stopped before wallet init; slot released as failed", async () => {
    const root = await enrollRoot();
    const controller = new SharedFleetController({
      store: admin,
      config: fleetConfig(),
      self: { address: root.agent.walletAddress!, name: "root" },
      isRootAgent: true,
      getFinancialSnapshot: async () => ({ creditsCents: 100_000, survivalTier: "high" }),
    });
    await controller.init();
    const conway = mockSandbox({ buildId: "6".repeat(64) });
    await expect(
      controller.requestReplication({ name: genesis.name }, (grant) => spawnChild(conway, identity, db, genesis, new ChildLifecycle(db.raw), grant)),
    ).rejects.toThrow(FleetRuntimeError);
    const commands = (conway.exec as any).mock.calls.map((c: any[]) => c[0] as string);
    expect(commands.some((c: string) => c.includes("--init"))).toBe(false);
    expect(commands.some((c: string) => c.includes("pnpm install --frozen-lockfile"))).toBe(true);
    const failed = (await admin.listReservations()).filter((l) => l.status === "failed");
    expect(failed).toHaveLength(1);
    expect(await events("runtime_verification_failed", failed[0].agentId)).toBe(1);
    expect(await occupancy()).toMatchObject({ living: 1, reserved: 0 });
  });

  // ── Fleet service / API ──

  describe("fleet service API (agents hold no DB credentials)", () => {
    let service: FleetService;
    let url: string;
    let gateway: PgAgentGateway;
    const audit: Array<{ event: string }> = [];

    async function startService(realReplicationEnabled = true) {
      gateway = new PgAgentGateway({ connectionString: pgc.agentUrl });
      opened.push(gateway);
      service = new FleetService({ admin, agent: gateway, realReplicationEnabled, reaperIntervalMs: 0, audit: (e) => audit.push(e), release: { ...PIN, ...BUILD }, allowLegacyBearer: true });
      url = (await service.listen(0, "127.0.0.1")).url;
    }

    afterEach(async () => {
      await service?.close();
      audit.length = 0;
    });

    function client(cred: { agentId: string; token: string }) {
      return new FleetApiClient({ baseUrl: url, agentId: cred.agentId, token: cred.token });
    }

    function controllerFor(cred: { agentId: string; token: string }, address: string, opts: { root?: boolean; onDead?: () => void } = {}) {
      return new SharedFleetController({
        store: client(cred),
        config: fleetConfig(),
        self: { address, name: "x" },
        isRootAgent: opts.root ?? true,
        selfAgentId: cred.agentId,
        onDead: opts.onDead,
        getFinancialSnapshot: async () => ({ creditsCents: 100_000, survivalTier: "high" }),
      });
    }

    it("the service refuses to run agent calls with the admin credentials", async () => {
      await expect(
        startFleetServiceFromEnv({ FLEET_CONTROLLER_DATABASE_URL: pgc.ownerUrl, FLEET_AGENT_DATABASE_URL: pgc.ownerUrl }),
      ).rejects.toThrow(/restricted agent role/);
      await expect(startFleetServiceFromEnv({ FLEET_CONTROLLER_DATABASE_URL: pgc.ownerUrl })).rejects.toThrow(/FLEET_AGENT_DATABASE_URL/);
    });

    it("end to end: request -> claim -> attest -> activate -> child credential -> child heartbeat", async () => {
      await startService();
      const root = await enrollRoot();
      const rootCtl = controllerFor(root.cred, root.agent.walletAddress!);
      expect(await rootCtl.init()).toEqual({ ok: true });
      expect(await rootCtl.heartbeat()).toBe(true);
      expect(rootCtl.snapshot().state).toMatchObject({ livingAgents: 1, maxAgents: 5, replicationEnabled: true });

      const conway = mockSandbox();
      const out = await rootCtl.requestReplication(
        { name: genesis.name },
        (grant) => spawnChild(conway, identity, db, genesis, new ChildLifecycle(db.raw), grant),
        (child, cred) => deliverChildCredential(conway, child.sandboxId, cred, url),
      );
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      const delivered = JSON.parse(conway.files[CHILD_FLEET_CREDENTIALS]);
      expect(delivered).toMatchObject({ agentId: out.agentId, apiUrl: url });
      expect(JSON.stringify(delivered)).not.toMatch(/postgres|fleet_owner|DATABASE_URL/);
      const cmds = (conway.exec as any).mock.calls.map((c: any[]) => c[0] as string);
      expect(cmds.some((c: string) => c === `chmod 600 ${CHILD_FLEET_CREDENTIALS}`)).toBe(true);
      expect(JSON.stringify(conway.files)).not.toContain(pgc.ownerUrl);

      const kid = controllerFor({ agentId: out.agentId, token: delivered.token }, out.child.address, { root: false });
      expect(await kid.init()).toEqual({ ok: true });
      expect(await kid.heartbeat()).toBe(true);
      const lease = (await admin.getReservation(out.agentId))!;
      expect(lease).toMatchObject({ status: "completed", expected: { ...PIN, ...BUILD } });
      expect(lease.attestedAt).not.toBeNull();
      for (const e of ["replication_requested", "replication_granted", "slot_reserved", "slot_claimed", "runtime_verified", "agent_activated", "credential_issued"]) {
        expect(await events(e), e).toBeGreaterThanOrEqual(1);
      }
    });

    it("service-level REAL_REPLICATION_ENABLED=false rejects replication (audited)", async () => {
      await startService(false);
      const root = await enrollRoot();
      const ctl = controllerFor(root.cred, root.agent.walletAddress!);
      await ctl.init();
      const out = await ctl.requestReplication({ name: "c" }, fakeSpawn(db));
      expect(!out.ok && out.decision.code).toBe("REAL_REPLICATION_DISABLED");
      expect(await events("replication_rejected")).toBe(1);
      expect(await occupancy()).toMatchObject({ reserved: 0 });
    });

    it("bad or foreign credentials are rejected and audited; one parent cannot touch another's reservation", async () => {
      await startService();
      const a = await enrollRoot("a");
      const b = await enrollRoot("b");
      const bogus = await fetch(`${url}/v1/state`, { headers: { authorization: "Bearer nope" } });
      expect(bogus.status).toBe(401);
      const forged = client({ agentId: a.agent.agentId, token: `fa1.${a.agent.agentId}.${"A".repeat(43)}` });
      expect(await forged.heartbeat(a.agent.agentId)).toBe(false);
      expect(await events("api_auth_failed")).toBeGreaterThanOrEqual(1);
      expect(await events("db_auth_failed")).toBeGreaterThanOrEqual(1);

      const res = await admin.reserveSlot({ parentAgentId: b.agent.agentId, requestedBy: "b", name: "c", runtime: PIN });
      if (!res.ok) throw new Error(res.reason);
      const post = (p: string, body: unknown) =>
        fetch(`${url}${p}`, { method: "POST", headers: { authorization: `Bearer ${a.cred.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      expect((await post("/v1/replication/claim", { reservationId: res.lease!.reservationId, localChildId: "x" })).status).toBe(403);
      expect((await post("/v1/replication/release", { reservationId: res.lease!.reservationId })).status).toBe(403);
      expect((await post("/v1/replication/fail", { reservationId: res.lease!.reservationId, reason: "x" })).status).toBe(403);
      expect((await post("/v1/status", { status: "reserved" })).status).toBe(403);
      expect((await admin.getAgent(res.agent.agentId))!.status).toBe("reserved");
      expect(await events("authorization_denied")).toBeGreaterThanOrEqual(2);
      expect(await events("claim_denied")).toBeGreaterThanOrEqual(1);
    });

    it("a reaped agent learns it is dead on its next heartbeat (onDead) and can no longer act", async () => {
      await startService();
      const root = await enrollRoot();
      const kid = await activeChild(root.agent.agentId);
      const kidAddr = (await admin.getAgent(kid.agentId))!.walletAddress!;
      const onDead = vi.fn();
      const ctl = controllerFor(kid.cred, kidAddr, { root: false, onDead });
      await ctl.init();
      await armReaper();
      await ageHeartbeat(kid.agentId, 5000);
      await service.reapOnce();
      await ageHeartbeat(kid.agentId, 5000);
      await service.reapOnce();
      expect(await ctl.heartbeat()).toBe(false);
      expect(onDead).toHaveBeenCalledWith("dead");
      expect(ctl.agentId).toBeNull();
      const out = await ctl.requestReplication({ name: "zombie" }, fakeSpawn(db));
      expect(out.ok).toBe(false);
      expect(audit.some((e) => e.event === "reaper_pass")).toBe(true);
    });

    it("agents can retire themselves; the retired slot is released", async () => {
      await startService();
      const root = await enrollRoot();
      const kid = await activeChild(root.agent.agentId);
      expect(await client(kid.cred).retire("done")).toBe(true);
      expect((await admin.getAgent(kid.agentId))!.status).toBe("dead");
      expect(await occupancy()).toMatchObject({ living: 1 });
    });

    it("a database authorization failure inside the service is audited", async () => {
      // Simulate a gateway misconfigured with a role that lacks EXECUTE on the API.
      await ownerRaw.query("REVOKE EXECUTE ON FUNCTION fleet.api_fleet_state() FROM fleet_agent");
      try {
        await startService();
        const root = await enrollRoot();
        const r = await fetch(`${url}/v1/state`, { headers: { authorization: `Bearer ${root.cred.token}` } });
        expect(r.status).toBe(500);
        expect((await r.json()).code).toBe("FLEET_DB_AUTHORIZATION_FAILED");
        expect(await events("db_authorization_failed")).toBe(1);
      } finally {
        await admin.grantAgentRole();
      }
    });
  });
});

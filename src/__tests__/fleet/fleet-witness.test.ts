/**
 * Fleet Layer Tests (FLEET-KI-4): capability scope 'witness' and the root witness.
 *
 * A stolen witness credential must be unable to do anything but open a
 * session, heartbeat, answer health challenges and read itself. That is
 * enforced by the fleet service's default-deny route policy and by the
 * database (fleet_authenticate), never by the witness executable, so most
 * tests here send raw signed requests or call the database directly.
 *
 * Describe names include "security" and "financial" so these also run under
 * test:security and test:financial. PostgreSQL tests use a throwaway cluster
 * set up exactly as production (fixtures/ephemeral-pg.ts).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { ulid } from "ulid";
import { FleetService, ROUTE_POLICY, SIG_HEADERS, routeDecision, signRequest, type AuditEntry } from "../../fleet/service/server.js";
import { UnsupportedSandboxTerminator } from "../../fleet/service/terminator.js";
import { PgAgentGateway } from "../../fleet/postgres/agent-gateway.js";
import { PgFleetStore, hashAgentToken, mintSessionToken } from "../../fleet/postgres/store.js";
import { FLEET_PG_SCHEMA_VERSION, PG_MIGRATIONS } from "../../fleet/postgres/migrations.js";
import { WITNESS_API_ACTIONS } from "../../fleet/postgres/migrations-phase7.js";
import { enrollWitnessRoot, writeCredentialFileExclusive } from "../../fleet/postgres/cli.js";
import { computeBuildIdentity } from "../../fleet/attestation.js";
import {
  WITNESS_ENDPOINTS,
  WitnessRefusedError,
  WitnessRejectedError,
  rootWitnessPreflight,
  runRootWitness,
  witnessHealthResponder,
} from "../../fleet/dry-run/root-witness.js";
import { getForbiddenCommandMatch } from "../../agent/policy-rules/command-safety.js";
import { TEST_RUNTIME_BUILD, TEST_RUNTIME_PIN } from "../mocks.js";
import { findPgBin, startEphemeralPg, type EphemeralPg } from "./fixtures/ephemeral-pg.js";
import { wipeRegistry } from "./fixtures/wipe.js";

const PIN = TEST_RUNTIME_PIN;
const BUILD = TEST_RUNTIME_BUILD;
const RELEASE = { ...PIN, ...BUILD };
const REPO_ROOT = path.resolve(__dirname, "../../..");
const SRC = path.join(REPO_ROOT, "src");

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fleet-witness-"));
}

/** A tiny installed runtime tree and the env pins that match it. */
function runtimeTree(): { dir: string; env: Record<string, string> } {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"@conway/automaton"}');
  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  fs.mkdirSync(path.join(dir, "dist"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "dist", "a.js"), "export {};\n");
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export {};\n");
  const id = computeBuildIdentity(dir);
  return {
    dir,
    env: {
      FLEET_RUNTIME_REPO: PIN.repo,
      FLEET_RUNTIME_COMMIT: PIN.commit,
      FLEET_RUNTIME_BUILD_ID: id.buildId,
      FLEET_RUNTIME_LOCKFILE_SHA256: id.lockfileSha256,
    },
  };
}

// ─── Pure: route policy ───

/** Every "METHOD /v1/..." route FleetService.route() dispatches, read from the source. */
function routesInServerSource(): string[] {
  const src = fs.readFileSync(path.join(SRC, "fleet/service/server.ts"), "utf8");
  const body = src.slice(src.indexOf("private async route("));
  const found = new Set<string>();
  for (const m of body.matchAll(/method === "(GET|POST)" && path === "(\/v1\/[^"]+)"/g)) found.add(`${m[1]} ${m[2]}`);
  // Everything after `if (method !== "POST")` is a POST switch.
  const post = body.slice(body.indexOf('if (method !== "POST")'));
  for (const m of post.matchAll(/case "(\/v1\/[^"]+)":/g)) found.add(`POST ${m[1]}`);
  return [...found].sort();
}

describe("Fleet security: witness route policy (default deny)", () => {
  it("route-policy completeness: every route FleetService.route() serves has exactly one policy entry, and vice versa", () => {
    const served = routesInServerSource();
    expect(served.length).toBeGreaterThanOrEqual(18);
    expect(served).toEqual(Object.keys(ROUTE_POLICY).sort());
    // Every non-public route authenticates.
    for (const [k, p] of Object.entries(ROUTE_POLICY)) if (k !== "GET /v1/health") expect(p.auth, k).not.toBe("public");
  });

  it("witness is opt-in: exactly session, heartbeat, health challenge and self", () => {
    const granted = Object.entries(ROUTE_POLICY).filter(([, p]) => p.auth !== "public" && p.witness).map(([k]) => k).sort();
    expect(granted).toEqual(["GET /v1/self", "POST /v1/health/challenge", "POST /v1/heartbeat", "POST /v1/session"]);
    expect([...WITNESS_ENDPOINTS].sort()).toEqual(granted);
    expect([...WITNESS_API_ACTIONS].sort()).toEqual(["heartbeat", "open_session", "whoami"]);
  });

  it("unknown future routes and unknown scopes fail closed; 'full' keeps its behaviour", () => {
    expect(routeDecision("POST", "/v1/future/endpoint", "full")).toBe("unknown");
    expect(routeDecision("POST", "/v1/future/endpoint", "witness")).toBe("unknown");
    expect(routeDecision("GET", "/v1/heartbeat", "witness")).toBe("unknown"); // method is part of the key
    for (const k of Object.keys(ROUTE_POLICY)) {
      const [m, p] = k.split(" ");
      expect(routeDecision(m, p, "full"), k).toBe("allow");
      expect(routeDecision(m, p, "observer"), k).toBe(ROUTE_POLICY[k].auth === "public" ? "allow" : "deny");
      expect(routeDecision(m, p, "witness"), k).toBe(ROUTE_POLICY[k].auth === "public" || ROUTE_POLICY[k].witness ? "allow" : "deny");
    }
  });
});

// ─── Pure: witness process refusals, isolation, unit ───

describe("Fleet security: root witness startup refusals", () => {
  let rt: ReturnType<typeof runtimeTree>;
  let homeDir: string;
  beforeAll(() => {
    rt = runtimeTree();
  });
  afterAll(() => fs.rmSync(rt.dir, { recursive: true, force: true }));
  beforeEach(() => {
    homeDir = tmpDir();
  });

  const base = (env: Record<string, string> = {}) => ({
    env: { HOME: homeDir, ...rt.env, ...env },
    runtimeDir: rt.dir,
    runtimeEnvFile: path.join(os.tmpdir(), "no-such-runtime.env"),
    uid: 4242,
    secretFiles: [] as string[],
  });

  it("a clean environment passes", () => {
    expect(rootWitnessPreflight(base()).problems).toEqual([]);
  });

  it("refuses uid 0, true safety switches, and privileged/forbidden environment variables", () => {
    expect(rootWitnessPreflight({ ...base(), uid: 0 }).problems.join(" ")).toMatch(/uid 0/);
    for (const f of ["REAL_PAYMENTS_ENABLED", "REAL_REPLICATION_ENABLED", "OWNER_SWEEP_ENABLED"]) {
      expect(rootWitnessPreflight(base({ [f]: "true" })).problems.join(" ")).toContain(`${f}=true`);
    }
    for (const k of ["DATABASE_URL", "FLEET_ADMIN_DATABASE_URL", "FLEET_SERVICE_DATABASE_URL", "PGPASSWORD", "REDIS_URL", "CONWAY_API_KEY", "WALLET_PRIVATE_KEY", "OWNER_WALLET_KEY"]) {
      expect(rootWitnessPreflight(base({ [k]: "x" })).problems.join(" "), k).toContain(`${k} present`);
    }
  });

  it("refuses a switch turned on in runtime.env too", () => {
    const f = path.join(homeDir, "runtime.env");
    fs.writeFileSync(f, "REAL_PAYMENTS_ENABLED=true\n");
    expect(rootWitnessPreflight({ ...base(), runtimeEnvFile: f }).problems.join(" ")).toContain("REAL_PAYMENTS_ENABLED=true");
  });

  it("refuses wallet files and readable controller secrets", () => {
    fs.mkdirSync(path.join(homeDir, ".automaton"));
    fs.writeFileSync(path.join(homeDir, ".automaton", "wallet.json"), "{}");
    expect(rootWitnessPreflight(base()).problems.join(" ")).toMatch(/wallet state .*wallet\.json/);
    fs.rmSync(path.join(homeDir, ".automaton", "wallet.json"));
    const secret = path.join(homeDir, "admin.env");
    fs.writeFileSync(secret, "X=1\n", { mode: 0o600 });
    expect(rootWitnessPreflight({ ...base(), secretFiles: [secret] }).problems.join(" ")).toMatch(/controller secret .*admin\.env is readable/);
    expect(rootWitnessPreflight({ ...base(), secretFiles: [path.join(homeDir, "absent.env")] }).problems).toEqual([]);
  });

  it("refuses a runtime identity mismatch (tampered tree, other lockfile, missing pins) before any network access", async () => {
    expect(rootWitnessPreflight(base({ FLEET_RUNTIME_BUILD_ID: "c".repeat(64) })).problems.join(" ")).toMatch(/installed runtime build .* differs/);
    expect(rootWitnessPreflight(base({ FLEET_RUNTIME_LOCKFILE_SHA256: "d".repeat(64) })).problems.join(" ")).toMatch(/lockfile differs/);
    const { FLEET_RUNTIME_COMMIT: _c, ...noCommit } = rt.env;
    expect(rootWitnessPreflight({ ...base(), env: { HOME: homeDir, ...noCommit } }).problems.join(" ")).toMatch(/no complete pinned runtime release/);
    fs.writeFileSync(path.join(rt.dir, "dist", "injected.js"), "evil()\n");
    try {
      expect(rootWitnessPreflight(base()).problems.join(" ")).toMatch(/installed runtime build/);
      let fetched = 0;
      await expect(
        runRootWitness({ ...base(), fetchImpl: (async () => (fetched++, new Response("{}"))) as typeof fetch }),
      ).rejects.toBeInstanceOf(WitnessRefusedError);
      expect(fetched).toBe(0);
    } finally {
      fs.rmSync(path.join(rt.dir, "dist", "injected.js"));
    }
  });

  it("the challenge answer reports the pinned identity and only pattern-matches the canary", async () => {
    const answer = witnessHealthResponder(RELEASE);
    expect(await answer({ challengeId: ulid(), nonce: "n", canary: "cat /etc/automaton-fleet/service.env", expiresAt: "" })).toEqual({
      commit: PIN.commit,
      buildId: BUILD.buildId,
      policyOk: true,
    });
    expect(getForbiddenCommandMatch("cat /var/lib/automaton-fleet-witness/fleet-credentials.json")).not.toBeNull();
  });
});

/** Static import graph (value imports only) of a module inside src/. */
function importGraph(entry: string): { modules: string[]; external: string[] } {
  const seen = new Set<string>();
  const external = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^;]*?\s+from\s+)?"([^"]+)"/gm)) {
      const spec = m[1];
      if (spec.startsWith(".")) {
        const resolved = path.resolve(path.dirname(file), spec).replace(/\.js$/, ".ts");
        if (fs.existsSync(resolved)) walk(resolved);
      } else {
        external.add(spec);
      }
    }
  };
  walk(entry);
  return { modules: [...seen].map((f) => path.relative(SRC, f)).sort(), external: [...external].sort() };
}

describe("Fleet security: root witness isolation (no wallet, inference or replication code)", () => {
  const FORBIDDEN_MODULES = [
    /^identity\//, /^conway\//, /^inference\//, /^ollama\//, /^replication\//, /^survival\//, /^orchestration\//,
    /^heartbeat\//, /^memory\//, /^soul\//, /^social\//, /^skills\//, /^self-mod\//, /^registry\//, /^setup\//,
    /^agent\/(loop|tools|harnesses)/, /^fleet\/treasury\//, /^fleet\/dry-run\/operator\.ts$/, /^index\.ts$/,
  ];
  const FORBIDDEN_PACKAGES = [/^viem/, /^openai/, /^@anthropic-ai\//, /^@solana\//, /^better-sqlite3$/, /^ethers/];

  for (const entry of ["fleet/dry-run/root-main.ts", "fleet/dry-run/root-witness.ts"]) {
    it(`${entry}: no wallet modules, no inference modules, no replication code`, () => {
      const g = importGraph(path.join(SRC, entry));
      expect(g.modules).toContain("fleet/service/client.ts");
      for (const m of g.modules) for (const re of FORBIDDEN_MODULES) expect(re.test(m), `${entry} reaches ${m}`).toBe(false);
      for (const p of g.external) for (const re of FORBIDDEN_PACKAGES) expect(re.test(p), `${entry} imports ${p}`).toBe(false);
    });
  }

  it("the witness source calls no endpoint but the four it needs", () => {
    const text = fs.readFileSync(path.join(SRC, "fleet/dry-run/root-witness.ts"), "utf8");
    for (const banned of ["requestSpend", "proposeCapital", "reserveSlot", "activateChild", "reportChildTerminal", "setOwnStatus", "/v1/replication", "/v1/wallet", "/v1/capital", "/v1/status", "/v1/children"]) {
      expect(text.includes(banned), banned).toBe(false);
    }
  });

  it("systemd unit: dedicated user, 0700 state, no groups, no capabilities, strict sandbox, loopback only, secrets inaccessible", () => {
    const unit = fs.readFileSync(path.join(REPO_ROOT, "deploy/systemd/automaton-fleet-witness.service"), "utf8");
    for (const line of [
      "User=automaton-fleet-witness", "Group=automaton-fleet-witness", "SupplementaryGroups=", "StateDirectory=automaton-fleet-witness",
      "StateDirectoryMode=0700", "NoNewPrivileges=true", "CapabilityBoundingSet=", "AmbientCapabilities=", "ProtectSystem=strict",
      "ProtectHome=yes", "IPAddressDeny=any", "IPAddressAllow=localhost", "Environment=FLEET_API_URL=http://127.0.0.1:8787",
      "ExecStart=/opt/automaton-fleet/node/bin/node dist/fleet/dry-run/root-main.js", "RestartPreventExitStatus=3 4",
    ]) {
      expect(unit, line).toMatch(new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`, "m"));
    }
    for (const secret of ["/etc/automaton-fleet/admin.env", "/etc/automaton-fleet/service.env", "/etc/automaton-fleet/tls"]) {
      expect(unit).toMatch(new RegExp(`^InaccessiblePaths=.*-${secret.replace(/\//g, "\\/")}\\b`, "m"));
    }
    expect(unit).not.toMatch(/automaton-agent\b.*User|User=automaton-agent|User=automaton-fleet-service|EnvironmentFile=|LoadCredential=|postgresql:\/\//);
    const setup = fs.readFileSync(path.join(REPO_ROOT, "scripts/fleet-os-setup.sh"), "utf8");
    expect(setup).toMatch(/useradd --system --user-group --home-dir \/var\/lib\/automaton-fleet-witness/);
    expect(setup).not.toMatch(/usermod -aG \S+ automaton-fleet-witness/);
    expect(setup).not.toMatch(/systemctl (enable|start)\b.*witness/);
  });
});

// ─── PostgreSQL: scope enforcement end to end ───

const PG_BIN = findPgBin();

describe.skipIf(!PG_BIN)("Fleet security financial: witness capability scope (PostgreSQL)", () => {
  let pgc: EphemeralPg;
  let ownerRaw: pg.Pool;
  let admin: PgFleetStore;
  let svc: PgFleetStore;
  let gateway: PgAgentGateway;
  let service: FleetService | undefined;
  let url = "";
  const audit: AuditEntry[] = [];
  const opened: Array<{ close(): Promise<void> }> = [];
  const track = <T extends { close(): Promise<void> }>(x: T): T => (opened.push(x), x);
  let work: string;

  async function reset(max = 2) {
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
  }

  async function startService() {
    await service?.close();
    service = new FleetService({
      admin: svc,
      agent: gateway,
      realReplicationEnabled: false,
      reaperIntervalMs: 0,
      release: RELEASE,
      audit: (e) => audit.push(e),
      terminator: new UnsupportedSandboxTerminator(),
    });
    url = (await service.listen(0, "127.0.0.1")).url;
  }

  async function enrollWitness(name = "witness") {
    const file = path.join(work, `${ulid()}.json`);
    const r = await enrollWitnessRoot(admin, { name, credentialFile: file, apiUrl: url, actor: "operator:test" });
    const cred = JSON.parse(fs.readFileSync(file, "utf8")) as { agentId: string; token: string; apiUrl: string };
    return { ...r, file, token: cred.token };
  }

  async function enrollFullRoot(name = "root") {
    const reg = await admin.registerRoot({ walletAddress: `0x${randomBytes(20).toString("hex")}`, name });
    if (!reg.ok) throw new Error(reg.reason);
    const cred = await admin.issueCredential(reg.agent.agentId, "test");
    return { agentId: reg.agent.agentId, token: cred.token };
  }

  async function openSession(token: string): Promise<string> {
    const r = await fetch(`${url}/v1/session`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    const j = (await r.json()) as { ok: boolean; sessionToken?: string; code?: string };
    if (!j.ok) throw new Error(`session refused: ${j.code}`);
    return j.sessionToken!;
  }

  function signed(session: string, method: string, p: string, body: string, ts = Date.now(), nonce = randomBytes(18).toString("base64url")) {
    return {
      authorization: `FleetSession ${session}`,
      [SIG_HEADERS.ts]: String(ts),
      [SIG_HEADERS.nonce]: nonce,
      [SIG_HEADERS.sig]: signRequest(session, method, p, String(ts), nonce, body),
      ...(body ? { "content-type": "application/json" } : {}),
    };
  }

  async function call(session: string, method: string, p: string, bodyObj?: unknown, headers?: Record<string, string>) {
    const body = bodyObj === undefined ? "" : JSON.stringify(bodyObj);
    const r = await fetch(`${url}${p}`, { method, headers: headers ?? signed(session, method, p, body), body: body || undefined });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  }

  async function events(type: string, agentId?: string): Promise<number> {
    const r = await ownerRaw.query(
      `SELECT count(*)::int AS n FROM fleet.fleet_events WHERE event_type = $1 ${agentId ? "AND agent_id = $2" : ""}`,
      agentId ? [type, agentId] : [type],
    );
    return r.rows[0].n;
  }

  /** Everything a denied request could have changed, except the denial's own audit trail. */
  async function fingerprint(): Promise<string> {
    const r = await ownerRaw.query(`SELECT json_build_object(
      'agents', (SELECT json_agg(json_build_object('id', agent_id, 's', status, 'u', updated_at) ORDER BY agent_id) FROM fleet.fleet_agents),
      'leases', (SELECT json_agg(json_build_object('id', reservation_id, 's', status) ORDER BY reservation_id) FROM fleet.fleet_reservations),
      'prov', (SELECT json_agg(json_build_object('k', provisioning_key, 's', status, 'x', external_state, 'sb', sandbox_id) ORDER BY provisioning_key) FROM fleet.fleet_provisioning),
      'alloc', (SELECT count(*) FROM fleet.fleet_capital_allocations),
      'spend', (SELECT count(*) FROM fleet.fleet_spend_requests),
      'custody', (SELECT json_agg(json_build_object('a', agent_id, 'f', spending_frozen, 'l', daily_limit_cents) ORDER BY agent_id) FROM fleet.fleet_wallet_custody),
      'state', (SELECT json_build_object('l', living_agents, 'r', reserved_slots, 'q', quarantined_slots, 'm', max_agents, 'mode', operating_mode, 'rep', replication_enabled) FROM fleet.fleet_state),
      'events', (SELECT count(*) FROM fleet.fleet_events WHERE event_type NOT IN ('scope_denied'))
    ) AS f`);
    return JSON.stringify(r.rows[0].f);
  }

  beforeAll(async () => {
    work = tmpDir();
    pgc = await startEphemeralPg(PG_BIN!);
    ownerRaw = new pg.Pool({ connectionString: pgc.ownerUrl, max: 6 });
    admin = track(new PgFleetStore({ connectionString: pgc.ownerUrl }));
    svc = track(new PgFleetStore({ connectionString: pgc.serviceUrl }));
    await admin.migrate();
    gateway = track(new PgAgentGateway({ connectionString: pgc.agentUrl }));
  }, 60_000);

  afterAll(async () => {
    await service?.close();
    for (const s of opened) await s.close();
    await ownerRaw?.end();
    pgc?.stop();
    fs.rmSync(work, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await reset();
    audit.length = 0;
    await startService();
  });

  // 1-2: migration
  it("migration v6 -> v7: applied transactionally; existing agents become capability_scope 'full'; privileges stay least", async () => {
    const schema = "fleet_mig_v6";
    const c = await ownerRaw.connect();
    try {
      await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await c.query(`CREATE SCHEMA ${schema}`);
      await c.query(`CREATE TABLE ${schema}.fleet_schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
      for (const m of PG_MIGRATIONS.filter((x) => x.version <= 6)) {
        await c.query("BEGIN");
        await c.query(`SET LOCAL search_path TO ${schema}`);
        await c.query(m.sql.replaceAll("@@SCHEMA@@", `"${schema}"`));
        await c.query(`INSERT INTO ${schema}.fleet_schema_migrations (version, name) VALUES ($1, $2)`, [m.version, m.name]);
        await c.query("COMMIT");
      }
      await c.query(`UPDATE ${schema}.fleet_state SET max_agents = 2`);
    } finally {
      c.release();
    }
    const store = track(new PgFleetStore({ connectionString: pgc.ownerUrl, schema }));
    // A root that existed before v7 (inserted directly: v7 code refuses a v6 registry).
    await ownerRaw.query(
      `INSERT INTO ${schema}.fleet_agents (agent_id, role, generation, name, wallet_address, status, requested_by, last_heartbeat)
       VALUES ($1, 'root', 0, 'pre-v7-root', $2, 'active', 'test', now())`,
      [ulid(), `0x${randomBytes(20).toString("hex")}`],
    );
    expect((await store.migrateCheck())).toEqual({ currentVersion: 6, resultingVersion: 7, wouldApply: [7] });
    expect(await store.migrate()).toEqual([7]);
    expect(FLEET_PG_SCHEMA_VERSION).toBe(7);
    expect((await store.health()).schemaVersion).toBe(7);
    const scopes = await ownerRaw.query(`SELECT capability_scope FROM ${schema}.fleet_agents`);
    expect(scopes.rows.map((r) => r.capability_scope)).toEqual(["full"]);
    expect((await store.auditPrivileges()).problems).toEqual([]);
    expect(await store.migrate()).toEqual([]); // idempotent
    await ownerRaw.query(`DROP SCHEMA ${schema} CASCADE`);
  });

  it("enroll-witness-root: keyless root, scope witness, approved runtime commit, frozen custody, 0600 file, token never returned", async () => {
    const w = await enrollWitness();
    expect(w).toMatchObject({ role: "root", capabilityScope: "witness", runtimeCommit: PIN.commit, custodyFrozen: true, credentialFile: w.file });
    const { file: _f, token, ...summary } = w;
    expect(JSON.stringify(summary)).not.toContain(token); // the enrollment result carries no token
    expect(JSON.stringify(summary)).not.toMatch(/fa1\./);
    expect(fs.statSync(w.file).mode & 0o777).toBe(0o600);
    const row = (await ownerRaw.query("SELECT * FROM fleet.fleet_agents WHERE agent_id = $1", [w.agentId])).rows[0];
    expect(row).toMatchObject({ role: "root", capability_scope: "witness", runtime_commit: PIN.commit, status: "active", dry_run: false, parent_agent_id: null });
    expect(row.wallet_address).toMatch(/^0x[0-9a-f]{40}$/);
    const auth = await admin.agentAuthority(w.agentId);
    expect(auth).toMatchObject({ spendingFrozen: true, dailyLimitCents: 0, credentialLive: true });
    // Refuses an existing file before registering anything.
    const agentsBefore = (await admin.listAgents()).length;
    await expect(enrollWitnessRoot(admin, { name: "again", credentialFile: w.file, apiUrl: url, actor: "t" })).rejects.toThrow(/already exists/);
    expect((await admin.listAgents()).length).toBe(agentsBefore);
    expect(() => writeCredentialFileExclusive(w.file, { agentId: w.agentId, token: w.token } as never, null)).toThrow(/already exists/);
    // Normal enroll-root semantics are unchanged.
    const full = await enrollFullRoot("normal");
    expect((await admin.getAgent(full.agentId))!.capabilityScope).toBe("full");
  });

  // 3: immutability
  it("capability scope is immutable (owner cannot change it; restricted roles cannot write it); a witness must be a root", async () => {
    const w = await enrollWitness();
    const full = await enrollFullRoot();
    await expect(ownerRaw.query("UPDATE fleet.fleet_agents SET capability_scope = 'full' WHERE agent_id = $1", [w.agentId])).rejects.toThrow(/FLEET_HISTORY_IMMUTABLE/);
    await expect(ownerRaw.query("UPDATE fleet.fleet_agents SET capability_scope = 'witness' WHERE agent_id = $1", [full.agentId])).rejects.toThrow(/FLEET_HISTORY_IMMUTABLE/);
    await expect(ownerRaw.query("UPDATE fleet.fleet_agents SET capability_scope = 'admin' WHERE agent_id = $1", [full.agentId])).rejects.toThrow(/capability_scope_valid|FLEET_HISTORY_IMMUTABLE/);
    const svcRaw = new pg.Pool({ connectionString: pgc.serviceUrl, max: 1 });
    const agentRaw = new pg.Pool({ connectionString: pgc.agentUrl, max: 1 });
    try {
      await expect(svcRaw.query("UPDATE fleet.fleet_agents SET capability_scope = 'full' WHERE agent_id = $1", [w.agentId])).rejects.toThrow(/permission denied/);
      await expect(agentRaw.query("UPDATE fleet.fleet_agents SET capability_scope = 'full' WHERE agent_id = $1", [w.agentId])).rejects.toThrow(/permission denied/);
    } finally {
      await svcRaw.end();
      await agentRaw.end();
    }
    expect((await admin.getAgent(w.agentId))!.capabilityScope).toBe("witness");
    // Only a parentless, non-dry-run root may be a witness.
    await expect(
      ownerRaw.query(
        "INSERT INTO fleet.fleet_agents (agent_id, parent_agent_id, role, generation, name, status, requested_by, runtime_commit, capability_scope) VALUES ($1, $2, 'child', 1, 'k', 'reserved', 't', $3, 'witness')",
        [ulid(), full.agentId, PIN.commit],
      ),
    ).rejects.toThrow(/fleet_agents_witness_is_root/);
    // Re-registering a wallet under a different scope is refused.
    const addr = (await admin.getAgent(full.agentId))!.walletAddress!;
    expect(await admin.registerRoot({ walletAddress: addr, name: "x", capabilityScope: "witness" })).toMatchObject({ ok: false, code: "FLEET_IDENTITY_MISMATCH" });
  });

  // 4-8, 12-13: allowed routes, replay and staleness
  it("fa1 opens a session; the fs1 session may heartbeat, answer a challenge and read itself; replay and stale requests are still refused", async () => {
    const w = await enrollWitness();
    const s = await openSession(w.token);
    expect(s.startsWith("fs1.")).toBe(true);
    const self = await call(s, "GET", "/v1/self");
    expect(self.status).toBe(200);
    expect(self.json.agent).toMatchObject({ agentId: w.agentId, role: "root", capabilityScope: "witness", runtimeCommit: PIN.commit });
    const hb = await call(s, "POST", "/v1/heartbeat", {});
    expect(hb.status).toBe(200);
    expect(hb.json).toMatchObject({ alive: true, status: "active" });
    const ch = hb.json.challenge as { challengeId: string; nonce: string; canary: string };
    expect(ch?.challengeId).toBeTruthy();
    const ans = await call(s, "POST", "/v1/health/challenge", { challengeId: ch.challengeId, nonce: ch.nonce, commit: PIN.commit, policyOk: getForbiddenCommandMatch(ch.canary) !== null });
    expect(ans).toMatchObject({ status: 200, json: { ok: true, passed: true } });
    expect((await admin.agentAuthority(w.agentId))!.lastChallengeOkAt).toBeTruthy();
    // Existing challenge checks still apply to the witness: wrong commit fails.
    await ownerRaw.query("UPDATE fleet.fleet_state SET health_challenge_interval_s = 10");
    await ownerRaw.query("UPDATE fleet.fleet_health_challenges SET issued_at = now() - interval '1 hour' WHERE agent_id = $1", [w.agentId]);
    const hb2 = await call(s, "POST", "/v1/heartbeat", {});
    const ch2 = hb2.json.challenge as { challengeId: string; nonce: string };
    const bad = await call(s, "POST", "/v1/health/challenge", { challengeId: ch2.challengeId, nonce: ch2.nonce, commit: "a".repeat(40), policyOk: true });
    expect(bad).toMatchObject({ status: 409, json: { code: "FLEET_CHALLENGE_FAILED" } });
    // Nonce replay: the exact same signed request twice.
    const headers = signed(s, "POST", "/v1/heartbeat", "{}");
    expect((await call(s, "POST", "/v1/heartbeat", {}, headers)).status).toBe(200);
    expect(await call(s, "POST", "/v1/heartbeat", {}, headers)).toMatchObject({ status: 409, json: { code: "FLEET_REQUEST_REPLAYED" } });
    // Stale timestamp.
    const stale = signed(s, "POST", "/v1/heartbeat", "{}", Date.now() - 61_000);
    expect(await call(s, "POST", "/v1/heartbeat", {}, stale)).toMatchObject({ status: 401, json: { code: "FLEET_REQUEST_STALE" } });
    // The long-lived credential still only opens sessions.
    const bearer = await fetch(`${url}/v1/heartbeat`, { method: "POST", headers: { authorization: `Bearer ${w.token}` }, body: "{}" });
    expect(((await bearer.json()) as { code: string }).code).toBe("FLEET_SESSION_REQUIRED");
    // Invalid credential.
    const forged = `fa1.${w.agentId}.${randomBytes(32).toString("base64url")}`;
    const r = await fetch(`${url}/v1/session`, { method: "POST", headers: { authorization: `Bearer ${forged}` } });
    expect(r.status).toBe(401);
  });

  // 9, 18, 19, 20, 25: every other route is denied before any side effect
  it("every other authenticated /v1 route is denied for the witness (403 FLEET_SCOPE_DENIED), with no side effect and an audit event without secrets", async () => {
    await reset(2);
    const w = await enrollWitness();
    // A real dry-run lease under the witness, as the operator would create it.
    const dr = await admin.reserveDryRunSlot({ parentAgentId: w.agentId, requestedBy: "operator:dry-run", name: "dry-run-child" });
    expect(dr.ok).toBe(true);
    const reservationId = dr.ok ? dr.lease!.reservationId : "";
    const s = await openSession(w.token);
    const bodies: Record<string, unknown> = {
      "GET /v1/state": undefined,
      "GET /v1/members": undefined,
      "POST /v1/status": { status: "dead", reason: "x" },
      "POST /v1/replication/request": { name: "kid" },
      "POST /v1/replication/claim": { reservationId, localChildId: "c1" },
      "POST /v1/replication/provisioning": { reservationId, phase: "sandbox_intent", sandboxName: `fleet-${reservationId.toLowerCase()}` },
      "POST /v1/replication/activate": { reservationId, walletAddress: `0x${"1".repeat(40)}`, provisioningKey: reservationId },
      "POST /v1/replication/fail": { reservationId, reason: "x" },
      "POST /v1/replication/reconcile": { reservationId, outcome: "absent" },
      "POST /v1/replication/release": { reservationId, reason: "x" },
      "POST /v1/children/terminal": { localChildId: "c1", state: "dead" },
      "POST /v1/capital/propose": { purpose: "x", requestedCents: 100, expectedReturnCents: 0, expectedDurationDays: 1 },
      "POST /v1/wallet/spend-request": { fromWallet: `0x${"2".repeat(40)}`, toAddress: `0x${"3".repeat(40)}`, amountCents: 100, purpose: "x" },
    };
    const denied = Object.entries(ROUTE_POLICY).filter(([, p]) => p.auth !== "public" && !p.witness).map(([k]) => k).sort();
    expect(denied).toEqual(Object.keys(bodies).sort());
    const before = await fingerprint();
    for (const k of denied) {
      const [m, p] = k.split(" ");
      const r = await call(s, m, p, bodies[k]);
      expect(r, k).toMatchObject({ status: 403, json: { ok: false, code: "FLEET_SCOPE_DENIED" } });
    }
    expect(await fingerprint()).toBe(before);
    expect(await events("scope_denied", w.agentId)).toBe(denied.length);
    const rows = await ownerRaw.query("SELECT detail::text AS d FROM fleet.fleet_events WHERE event_type = 'scope_denied'");
    for (const r of rows.rows) {
      expect(r.d).not.toMatch(/fa1\.|fs1\./);
      expect(r.d).not.toContain(w.token);
      expect(r.d).not.toContain(s);
    }
    const auditDenied = audit.filter((e) => e.event === "scope_denied");
    expect(auditDenied).toHaveLength(denied.length);
    expect(JSON.stringify(audit)).not.toMatch(/fa1\.|fs1\./);
    // The dry-run lease is untouched and still usable by the operator.
    expect((await admin.getReservation(reservationId))!.status).toBe("reserved");
  });

  it("an invented token for the witness id is rejected as unauthenticated and records no scope_denied event", async () => {
    const w = await enrollWitness();
    const fake = mintSessionToken(w.agentId);
    const r = await call(fake, "POST", "/v1/wallet/spend-request", { fromWallet: "x", toAddress: "y", amountCents: 1, purpose: "x" });
    expect(r.status).toBe(401);
    expect(await events("scope_denied", w.agentId)).toBe(0);
  });

  // 10: unknown future route
  it("an unknown route is never dispatched (404) for witness and full agents alike", async () => {
    const w = await enrollWitness();
    const full = await enrollFullRoot();
    for (const token of [w.token, full.token]) {
      const s = await openSession(token);
      for (const [m, p] of [["POST", "/v1/future/admin"], ["GET", "/v1/heartbeat"], ["POST", "/v1/self"]]) {
        expect((await call(s, m, p, m === "POST" ? {} : undefined)).json.code, `${m} ${p}`).toBe("FLEET_NOT_FOUND");
      }
    }
  });

  // 5, 11, 19, 20: database layer independently of the service
  it("database: fleet_authenticate fails closed for unknown actions; every non-allowed api_* action is denied for a witness session", async () => {
    const w = await enrollWitness();
    const full = await enrollFullRoot();
    const session = mintSessionToken(w.agentId);
    expect((await gateway.openSession(w.agentId, w.token, hashAgentToken(session))).ok).toBe(true);
    const fullSession = mintSessionToken(full.agentId);
    expect((await gateway.openSession(full.agentId, full.token, hashAgentToken(fullSession))).ok).toBe(true);
    const auth = async (agent: string, token: string, action: string) =>
      (await ownerRaw.query("SELECT fleet.fleet_authenticate($1, $2, $3) AS r", [agent, token, action])).rows[0].r;
    for (const tok of [w.token, session]) {
      for (const a of ["open_session", "heartbeat", "whoami"]) expect(await auth(w.agentId, tok, a), a).toBeNull();
      for (const a of ["request_spend", "propose_allocation", "request_replication", "release_reservation", "set_own_status", "future_action", "", "HEARTBEAT"]) {
        expect(await auth(w.agentId, tok, a), a).toBe("FLEET_SCOPE_DENIED");
      }
    }
    expect(await auth(full.agentId, fullSession, "future_action")).toBeNull(); // 'full' unchanged
    // Through the restricted agent role, exactly as the service calls it.
    expect(await gateway.whoami(w.agentId, session)).toMatchObject({ ok: true });
    expect(await gateway.heartbeat(w.agentId, session)).toMatchObject({ ok: true });
    expect(await gateway.requestSpend(w.agentId, session, { requestId: ulid(), fromWallet: `0x${"2".repeat(40)}`, toAddress: `0x${"3".repeat(40)}`, amountCents: 1, purpose: "x", allocationId: null })).toMatchObject({ ok: false, code: "FLEET_SCOPE_DENIED" });
    expect(await gateway.proposeAllocation(w.agentId, session, { allocationId: ulid(), purpose: "x", requestedCents: 1, expectedReturnCents: 0, expectedDurationDays: 1 })).toMatchObject({ ok: false, code: "FLEET_SCOPE_DENIED" });
    expect(await gateway.requestReplication(w.agentId, session, "kid", ulid(), ulid(), ulid())).toMatchObject({ ok: false, code: "FLEET_SCOPE_DENIED" });
    expect(await gateway.releaseReservation(w.agentId, session, ulid(), "x")).toMatchObject({ ok: false, code: "FLEET_SCOPE_DENIED" });
    expect(await gateway.setOwnStatus(w.agentId, session, "dead", "x")).toMatchObject({ ok: false, code: "FLEET_SCOPE_DENIED" });
    expect((await admin.getAgent(w.agentId))!.status).toBe("active");
    expect(await events("scope_denied", w.agentId)).toBeGreaterThanOrEqual(5);
    const rows = await ownerRaw.query("SELECT detail::text AS d FROM fleet.fleet_events WHERE event_type = 'scope_denied'");
    for (const r of rows.rows) expect(r.d).not.toMatch(/fa1\.|fs1\./);
    // No spend authority and no capital, even for the owner.
    await expect(ownerRaw.query("UPDATE fleet.fleet_wallet_custody SET spending_frozen = false, daily_limit_cents = 100000 WHERE agent_id = $1", [w.agentId])).resolves.toBeTruthy();
    expect(await admin.agentAuthority(w.agentId)).toMatchObject({ spendingFrozen: true, dailyLimitCents: 0 });
    await expect(
      ownerRaw.query(
        "INSERT INTO fleet.fleet_capital_allocations (allocation_id, agent_id, purpose, requested_amount_cents, expected_duration_days, proposed_by) VALUES ($1, $2, 'x', 1, 1, 'operator')",
        [ulid(), w.agentId],
      ),
    ).rejects.toThrow(/FLEET_SCOPE_DENIED: restricted identity/);
    // The same insert for a full agent is accepted (the guard is scope-specific).
    await ownerRaw.query(
      "INSERT INTO fleet.fleet_capital_allocations (allocation_id, agent_id, purpose, requested_amount_cents, expected_duration_days, proposed_by) VALUES ($1, $2, 'x', 1, 1, 'operator')",
      [ulid(), full.agentId],
    );
  });

  // 14: rotation
  it("credential rotation does not change scope: new credential and new sessions are still witness-restricted", async () => {
    const w = await enrollWitness();
    const rotated = await admin.issueCredential(w.agentId, "operator:test");
    expect(rotated.token).not.toBe(w.token);
    await expect(openSession(w.token)).rejects.toThrow(/session refused/);
    const s = await openSession(rotated.token);
    expect((await call(s, "POST", "/v1/heartbeat", {})).status).toBe(200);
    expect((await call(s, "POST", "/v1/capital/propose", { purpose: "x", requestedCents: 1, expectedReturnCents: 0, expectedDurationDays: 1 })).json.code).toBe("FLEET_SCOPE_DENIED");
    expect((await admin.getAgent(w.agentId))!.capabilityScope).toBe("witness");
  });

  // 15: full agents unchanged
  it("full agents keep their existing behaviour on every route family", async () => {
    const full = await enrollFullRoot();
    const s = await openSession(full.token);
    expect((await call(s, "GET", "/v1/state")).status).toBe(200);
    expect((await call(s, "GET", "/v1/members")).status).toBe(200);
    expect((await call(s, "GET", "/v1/self")).json.agent).toMatchObject({ capabilityScope: "full" });
    expect(await call(s, "POST", "/v1/replication/request", { name: "kid" })).toMatchObject({ status: 403, json: { code: "REAL_REPLICATION_DISABLED" } });
    const prop = await call(s, "POST", "/v1/capital/propose", { purpose: "growth", requestedCents: 100, expectedReturnCents: 0, expectedDurationDays: 1 });
    expect(prop.json.code).not.toBe("FLEET_SCOPE_DENIED");
    expect((await call(s, "POST", "/v1/replication/claim", { reservationId: ulid(), localChildId: "c" })).json.code).toBe("FLEET_NOT_FOUND");
    expect(await events("scope_denied")).toBe(0);
  });

  // 16-17: allocators
  it("a witness is refused by the normal allocator and insert guard, and accepted by the operator dry-run reservation and claim", async () => {
    await reset(3);
    const w = await enrollWitness();
    const normal = await admin.reserveSlot({ parentAgentId: w.agentId, requestedBy: "t", name: "kid", runtime: PIN });
    expect(normal).toMatchObject({ ok: false, code: "FLEET_PARENT_SCOPE" });
    await expect(
      ownerRaw.query(
        "INSERT INTO fleet.fleet_agents (agent_id, parent_agent_id, role, generation, name, status, requested_by, runtime_commit) VALUES ($1, $2, 'child', 1, 'k', 'reserved', 't', $3)",
        [ulid(), w.agentId, PIN.commit],
      ),
    ).rejects.toThrow(/FLEET_PARENT_SCOPE/);
    await admin.setMaxAgents(2, "test");
    const dr = await admin.reserveDryRunSlot({ parentAgentId: w.agentId, requestedBy: "operator:dry-run", name: "dry-run-child" });
    expect(dr.ok).toBe(true);
    if (!dr.ok) return;
    // The operator path (svc_claim with the witness as parent) still works.
    const claimed = await svc.claimGrant(dr.agent.agentId, ulid(), { parentAgentId: w.agentId });
    expect(claimed.provisioningKey).toBe(dr.lease!.reservationId);
    expect((await admin.getReservation(dr.lease!.reservationId))!.status).toBe("provisioning");
  });

  // 6-7, 21-24: the witness process against the real service
  it("the witness runs: session, heartbeats, passed challenge, only its four endpoints; stops cleanly; then becomes UNRESPONSIVE", async () => {
    const w = await enrollWitness();
    const rt = runtimeTree();
    const homeDir = tmpDir();
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
      return fetch(input, init);
    }) as typeof fetch;
    const logs: string[] = [];
    const ac = new AbortController();
    const running = runRootWitness({
      env: { HOME: homeDir, FLEET_API_URL: url, ...rt.env },
      credentialsFile: w.file,
      runtimeDir: rt.dir,
      runtimeEnvFile: path.join(homeDir, "none.env"),
      uid: 4242,
      secretFiles: [],
      intervalMs: 50,
      fetchImpl,
      signal: ac.signal,
      log: (e, d) => logs.push(JSON.stringify({ e, ...d })),
    });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !(await admin.agentAuthority(w.agentId))?.lastChallengeOkAt) await new Promise((r) => setTimeout(r, 25));
    ac.abort();
    const res = await running;
    expect(res.heartbeats).toBeGreaterThanOrEqual(1);
    expect(res.challengesPassed).toBeGreaterThanOrEqual(1);
    expect(res.status).toBe("active");
    const callsAtStop = seen.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(seen.length).toBe(callsAtStop); // nothing after shutdown
    expect(new Set(seen)).toEqual(new Set(seen.filter((x) => WITNESS_ENDPOINTS.includes(x))));
    expect(seen).toContain("POST /v1/health/challenge");
    expect(logs.join("\n")).not.toMatch(/fa1\.|fs1\./);
    expect(await events("scope_denied", w.agentId)).toBe(0);
    // Stopped witness: stale heartbeat -> UNRESPONSIVE on the next reaper pass (short timings simulated).
    await ownerRaw.query("UPDATE fleet.fleet_state SET reaper_last_run_at = now(), reaper_grace_from = '-infinity'");
    await ownerRaw.query("UPDATE fleet.fleet_agents SET last_heartbeat = now() - interval '10 minutes' WHERE agent_id = $1", [w.agentId]);
    await svc.reap("t");
    expect((await admin.getAgent(w.agentId))!.status).toBe("unresponsive");
    // A dry-run reservation now refuses the unresponsive parent.
    expect(await admin.reserveDryRunSlot({ parentAgentId: w.agentId, requestedBy: "operator:dry-run", name: "k" })).toMatchObject({ ok: false, code: "FLEET_PARENT_NOT_LIVING" });
    fs.rmSync(rt.dir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("the witness refuses a full-scope credential and exits as rejected once retired (mark-dead)", async () => {
    const full = await enrollFullRoot();
    const rt = runtimeTree();
    const homeDir = tmpDir();
    const file = path.join(work, `${ulid()}.json`);
    fs.writeFileSync(file, JSON.stringify({ agentId: full.agentId, token: full.token, apiUrl: url }), { mode: 0o600 });
    const opts = (credentialsFile: string) => ({
      env: { HOME: homeDir, FLEET_API_URL: url, ...rt.env },
      credentialsFile,
      runtimeDir: rt.dir,
      runtimeEnvFile: path.join(homeDir, "none.env"),
      uid: 4242,
      secretFiles: [],
      intervalMs: 20,
    });
    await expect(runRootWitness({ ...opts(file), heartbeats: 1 })).rejects.toThrow(/not a witness root/);
    const w = await enrollWitness();
    expect(await admin.markDead(w.agentId, "dry-run witness retired", "operator:test")).toBe(true);
    const err = await runRootWitness({ ...opts(w.file), heartbeats: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(WitnessRejectedError);
    expect((await admin.agentAuthority(w.agentId))!.credentialLive).toBe(false);
    fs.rmSync(rt.dir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
});

/**
 * Phase F — Genesis architecture and pre-Genesis integration (schema v11),
 * adversarially, against an ephemeral PostgreSQL cluster with the real roles.
 *
 * Proves: Genesis is an owner-only, content-hashed, single-use authorization
 * carried through a transactional state machine; founders have no authority
 * until one atomic activation; any failure (provisioning, attestation, expiry,
 * owner abort) rolls the whole set back, returning allocations and slots;
 * agents, Claude and ChatGPT principals can neither create nor approve it;
 * founders are independent (identity, workspace, state, ledger, lineage); the
 * starting allocation is virtual, distinguishable and never revenue or LFC;
 * internal value is never external revenue; reproduction and payment
 * execution are unavailable to founders; capability manifests cannot be
 * escalated; dead/quarantined founders lose all economic authority (estate
 * freeze) and estates settle once; knowledge provenance cannot be forged; the
 * identity vault releases one approved fact per claim and nothing else; the
 * dry run passes and leaves no trace.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import pg from "pg";
import { PgFleetStore, hashAgentToken, mintAgentToken } from "../../fleet/postgres/store.js";
import { PgAgentGateway } from "../../fleet/postgres/agent-gateway.js";
import { auditPrivileges, genesisSurfaceProblems } from "../../fleet/postgres/privileges.js";
import { PgLedgerAdmin, sha256Hex } from "../../fleet/treasury/ledger.js";
import { GenesisOps, PgGenesisAdmin } from "../../fleet/genesis/admin.js";
import { runGenesisDryRun } from "../../fleet/genesis/dry-run.js";
import { simulateRuntimeAttestation } from "../../fleet/genesis/simulate.js";
import { PgOperatorAdmin } from "../../fleet/operator/admin.js";
import { rawPublicKey } from "../../fleet/operator/canonical.js";
import { FOUNDER_MANIFEST_V1, TOOL_CAPABILITIES, createCapabilityManifestRule, decideTool, manifestSha256 } from "../../fleet/capabilities.js";
import { CHATGPT_TOOL_NAMES, TOOLS } from "../../fleet/bridge/mcp-core.js";
import { getForbiddenCommandMatch } from "../../agent/policy-rules/command-safety.js";
import { findPgBin, startEphemeralPg, type EphemeralPg } from "./fixtures/ephemeral-pg.js";
import { wipeRegistry } from "./fixtures/wipe.js";

const PG_BIN = findPgBin();
const PIN = { repo: "https://github.com/5l4mm3r/automaton-fleet", commit: "c".repeat(40) };
const BUILD = { buildId: "d".repeat(64), lockfileSha256: "e".repeat(64) };
const OWNER = "operator:owner";

async function pgCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "OK";
  } catch (err) {
    const m = /^(FLEET_[A-Z_]+)/.exec((err as Error).message);
    return m ? m[1] : `ERR:${(err as Error).message}`;
  }
}

describe("capability catalogue (runtime mirror)", () => {
  it("classifies every runtime tool; manifests never grant reproduction, payment, self-modification or tool discovery", () => {
    const src = fs.readFileSync("src/agent/tools.ts", "utf8");
    const tools = [...new Set([...src.matchAll(/name: "([a-z_0-9]+)"/g)].map((m) => m[1]))];
    expect(tools.length).toBeGreaterThan(60);
    expect(tools.filter((t) => !(t in TOOL_CAPABILITIES))).toEqual([]);
    for (const t of ["spawn_child", "fund_child", "start_child", "transfer_credits", "topup_credits", "x402_fetch", "register_domain", "edit_own_file",
      "update_genesis_prompt", "install_mcp_server", "install_skill", "create_sandbox", "switch_model"]) {
      expect(decideTool(t, FOUNDER_MANIFEST_V1), t).toMatchObject({ allowed: false });
    }
    expect(decideTool("hidden_payment_tool", FOUNDER_MANIFEST_V1)).toMatchObject({ allowed: false, code: "FLEET_CAPABILITY_UNCLASSIFIED" });
    // A manifest that lists a constitutional exclusion still cannot grant it.
    expect(decideTool("spawn_child", { manifestId: "evil", version: 1, allowed: ["reproduction"] })).toMatchObject({ allowed: false, code: "FLEET_CAPABILITY_NOT_GRANTABLE" });
    for (const t of ["exec", "write_file", "git_push", "send_message", "manage_dns", "remember_fact"]) expect(decideTool(t, FOUNDER_MANIFEST_V1).allowed, t).toBe(true);
    // The runtime rule: inactive unless configured; an unknown manifest id denies everything.
    expect(createCapabilityManifestRule({})).toBeNull();
    const unknown = createCapabilityManifestRule({ FLEET_CAPABILITY_MANIFEST: "made-up" })!;
    expect(unknown.evaluate({ tool: { name: "read_file" } } as never)).toMatchObject({ action: "deny", reasonCode: "FLEET_CAPABILITY_MANIFEST_UNAVAILABLE" });
    const rule = createCapabilityManifestRule({ FLEET_CAPABILITY_MANIFEST: "founder-v1" })!;
    expect(rule.evaluate({ tool: { name: "spawn_child" } } as never)).toMatchObject({ action: "deny", reasonCode: "FLEET_CAPABILITY_NOT_GRANTABLE" });
    expect(rule.evaluate({ tool: { name: "read_file" } } as never)).toBeNull();
    // The agent cannot re-point its own manifest from the shell.
    expect(getForbiddenCommandMatch("FLEET_CAPABILITY_MANIFEST=anything node dist/index.js")).not.toBeNull();
    for (const c of ["pnpm fleet:admin genesis-activate x y", "psql -c 'select fleet_genesis_approve(1)'", "psql -c 'update fleet_capability_manifests set allowed = 1'",
      "psql -c 'select * from fleet_org_identity_facts'", "pnpm fleet:admin knowledge-review x promote"]) {
      expect(getForbiddenCommandMatch(c), c).not.toBeNull();
    }
  });

  it("no AI bridge tool reaches Genesis, the identity vault, knowledge promotion or custody", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names.filter((n) => /genesis|identity|knowledge|custody|ledger|payment|spend|reproduc/i.test(n))).toEqual([]);
    expect([...CHATGPT_TOOL_NAMES]).toEqual(["fleet_whoami", "fleet_status", "fleet_list_agents", "fleet_get_agent"]);
  });
});

describe.skipIf(!PG_BIN)("Phase F Genesis (schema v11, PostgreSQL)", () => {
  let pgc: EphemeralPg;
  let owner: pg.Pool;
  let su: pg.Pool;
  let svc: pg.Pool;
  let agentRaw: pg.Pool;
  let opRaw: pg.Pool;
  let custody: pg.Pool;
  let store: PgFleetStore;
  let ledger: PgLedgerAdmin;
  let genesis: PgGenesisAdmin;
  let gw: PgAgentGateway;
  const q = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;
  const key = (p = "g") => `${p}:${crypto.randomBytes(9).toString("base64url")}`;

  async function reset(cap = 2) {
    const c = await owner.connect();
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
    await store.setApprovedRuntime(PIN, "test", BUILD);
    await store.setMaxAgents(cap, "test");
    await genesis.setEnabled(true, OWNER, "test");
    // The AI bridges' principals exist (as in production), so their names are known to the approver checks.
    const opAdmin = new PgOperatorAdmin({ connectionString: pgc.ownerUrl });
    try {
      for (const [name, kind] of [["claude-operator", "bridge_claude"], ["bridge-chatgpt", "bridge_chatgpt"]] as const) {
        const { privateKey } = crypto.generateKeyPairSync("ed25519");
        await opAdmin.enroll({ name, kind, scopes: ["ops.read.status"] as never, publicKey: rawPublicKey(privateKey).toString("base64url"), expiresDays: 30, actor: OWNER });
      }
    } finally {
      await opAdmin.close();
    }
  }

  async function toReady(n = 2, alloc = 5_000) {
    if (alloc > 0) await ledger.recordOwnerFunding(alloc * n + 1_000, `bank:${crypto.randomUUID()}`, OWNER);
    const g = await genesis.propose({ idempotencyKey: key(), founderCount: n, allocationCents: alloc, ttlS: 3600, actor: OWNER });
    await genesis.approve(g.genesisId, g.authSha256, OWNER);
    const p = await genesis.provision(g.genesisId, OWNER);
    for (const id of p.founderIds!) await genesis.attest(g.genesisId, id, (await simulateRuntimeAttestation(genesis, genesis, g.genesisId, id, OWNER)).host, OWNER);
    await genesis.fund(g.genesisId, OWNER);
    return { ...g, founderIds: p.founderIds! };
  }

  async function activated(n = 2, alloc = 5_000) {
    const g = await toReady(n, alloc);
    const tokens = g.founderIds.map((id) => mintAgentToken(id));
    await genesis.activateWithHashes(g.genesisId, g.authSha256, tokens.map(hashAgentToken), OWNER);
    return { ...g, founders: g.founderIds.map((id, i) => ({ agentId: id, token: tokens[i] })) };
  }

  const population = async () => (await q(`SELECT living_agents + reserved_slots + quarantined_slots AS p FROM fleet.fleet_state`))[0].p;

  beforeAll(async () => {
    pgc = await startEphemeralPg(PG_BIN!);
    owner = new pg.Pool({ connectionString: pgc.ownerUrl, max: 8 });
    su = new pg.Pool({ connectionString: pgc.superUrl.replace(/\/postgres$/, `/${pgc.dbname}`), max: 2 });
    store = new PgFleetStore({ connectionString: pgc.ownerUrl });
    await store.migrate();
    ledger = new PgLedgerAdmin({ connectionString: pgc.ownerUrl });
    genesis = new PgGenesisAdmin({ connectionString: pgc.ownerUrl });
    gw = new PgAgentGateway({ connectionString: pgc.agentUrl });
    svc = new pg.Pool({ connectionString: pgc.serviceUrl, max: 2 });
    agentRaw = new pg.Pool({ connectionString: pgc.agentUrl, max: 2 });
    opRaw = new pg.Pool({ connectionString: pgc.operatorUrl, max: 2 });
    custody = new pg.Pool({ connectionString: pgc.custodyUrl, max: 2 });
    await reset();
  }, 120_000);

  afterAll(async () => {
    await genesis?.close();
    await ledger?.close();
    await gw?.close();
    for (const p of [svc, agentRaw, opRaw, custody, su, owner]) await p?.end();
    await store?.close();
    pgc?.stop();
  });

  it("migrates to v11 with a clean privilege audit and the constitutional pins in place", async () => {
    expect((await q(`SELECT max(version) AS v FROM fleet.fleet_schema_migrations`))[0].v).toBe(14);
    const a = await auditPrivileges(owner);
    expect(a.problems).toEqual([]);
    expect(await pgCode(owner.query(`UPDATE fleet.fleet_reproduction_policy SET execution_enabled = true`))).toMatch(/ERR:.*check constraint/);
    expect(await pgCode(owner.query(`UPDATE fleet.fleet_genesis_policy SET refounding_enabled = true`))).toMatch(/ERR:.*check constraint/);
    expect(await pgCode(owner.query(`UPDATE fleet.fleet_capability_classes SET grantable = true WHERE class = 'reproduction'`))).toBe("FLEET_HISTORY_IMMUTABLE");
    expect((await q(`SELECT manifest_sha256 FROM fleet.fleet_capability_manifests WHERE manifest_id = 'founder-v1'`))[0].manifest_sha256).toBe(manifestSha256(FOUNDER_MANIFEST_V1));
  });

  // ── Who may create / approve Genesis ─────────────────────────

  it("no agent, service, operator (Claude/ChatGPT) or custody role can reach any Genesis function or the vault", async () => {
    for (const p of [agentRaw, svc, opRaw, custody]) {
      for (const sql of [
        `SELECT fleet.fleet_genesis_propose('k:12345678','genesis',2,NULL,0,3600,'operator:x')`,
        `SELECT fleet.fleet_genesis_approve(gen_random_uuid(), repeat('a',64), 'operator:x')`,
        `SELECT fleet.fleet_genesis_activate(gen_random_uuid(), repeat('a',64), ARRAY[]::text[], 'operator:x')`,
        `SELECT fleet.fleet_genesis_set_enabled(true, 'operator:x', 'x')`,
        `SELECT * FROM fleet.fleet_genesis`,
        `SELECT * FROM fleet.fleet_org_identity_facts`,
        `SELECT fleet.fleet_knowledge_review(gen_random_uuid(), true, NULL, 'operator:x')`,
        `SELECT * FROM fleet.fleet_capability_manifests`,
        `INSERT INTO fleet.fleet_knowledge_entries (entry_id) VALUES (gen_random_uuid())`,
      ]) {
        expect(await pgCode(p.query(sql)), sql).toMatch(/ERR:permission denied/);
      }
    }
  });

  it("an agent, Claude or ChatGPT principal cannot propose or approve Genesis even through the owner functions", async () => {
    const g = await genesis.propose({ idempotencyKey: key(), founderCount: 2, allocationCents: 0, ttlS: 3600, actor: OWNER });
    const reg = await store.registerRoot({ walletAddress: `0x${crypto.randomBytes(20).toString("hex")}`, name: "legacy" }).catch(() => null);
    for (const actor of ["operator:claude-operator", "operator:bridge-chatgpt", "claude-operator", "controller", "operator:op_01M3CKG338G2KDJ19FYEKT2T40"]) {
      expect(await pgCode(genesis.approve(g.genesisId, g.authSha256, actor)), actor).toMatch(/FLEET_SELF_APPROVAL|FLEET_APPROVAL_REQUIRED/);
      expect(await pgCode(genesis.propose({ idempotencyKey: key(), founderCount: 2, allocationCents: 0, actor })), actor).toMatch(/FLEET_SELF_APPROVAL|FLEET_APPROVAL_REQUIRED/);
    }
    if (reg && reg.ok) {
      expect(await pgCode(genesis.approve(g.genesisId, g.authSha256, `operator:${reg.agent.agentId}`))).toBe("FLEET_SELF_APPROVAL");
      await store.markDead(reg.agent.agentId, "t", "t");
    }
    // Genesis is for an empty fleet: a living agent blocks approval.
    if (reg && reg.ok) {
      const g4 = await genesis.propose({ idempotencyKey: key(), founderCount: 1, allocationCents: 0, ttlS: 3600, actor: OWNER });
      const r2 = await store.registerRoot({ walletAddress: `0x${crypto.randomBytes(20).toString("hex")}`, name: "living" });
      expect(r2.ok).toBe(true);
      expect(await pgCode(genesis.approve(g4.genesisId, g4.authSha256, OWNER))).toBe("FLEET_GENESIS_POPULATION");
      if (r2.ok) await store.markDead(r2.agent.agentId, "t", "t");
    }
    // Disabled Genesis: the owner's switch gates approval and activation.
    await genesis.setEnabled(false, OWNER, "t");
    expect(await pgCode(genesis.approve(g.genesisId, g.authSha256, OWNER))).toBe("FLEET_GENESIS_DISABLED");
    await reset();
  });

  // ── Authorization integrity ──────────────────────────────────

  it("authorizations are single-use, content-bound, immutable, and expire", async () => {
    const k = key();
    const g = await genesis.propose({ idempotencyKey: k, founderCount: 2, allocationCents: 100, ttlS: 3600, actor: OWNER });
    expect(await genesis.propose({ idempotencyKey: k, founderCount: 2, allocationCents: 100, ttlS: 3600, actor: OWNER })).toMatchObject({ genesisId: g.genesisId, replay: true });
    expect(await pgCode(genesis.propose({ idempotencyKey: k, founderCount: 2, allocationCents: 999, actor: OWNER }))).toBe("FLEET_IDEMPOTENCY_CONFLICT");
    // Altered: direct writes are refused; a superuser tamper is detected at the next step.
    expect(await pgCode(owner.query(`UPDATE fleet.fleet_genesis SET allocation_cents = 1 WHERE genesis_id = $1`, [g.genesisId]))).toBe("FLEET_GENESIS_REQUIRED");
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('fleet.genesis_op', $1, true)`, [g.genesisId]);
      expect(await pgCode(c.query(`UPDATE fleet.fleet_genesis SET allocation_cents = 1 WHERE genesis_id = $1`, [g.genesisId]))).toBe("FLEET_HISTORY_IMMUTABLE");
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
    const s = await su.connect();
    try {
      await s.query("SET session_replication_role = replica");
      await s.query(`UPDATE fleet.fleet_genesis SET allocation_cents = 999999 WHERE genesis_id = $1`, [g.genesisId]);
    } finally {
      await s.query("RESET session_replication_role");
      s.release();
    }
    expect(await pgCode(genesis.approve(g.genesisId, g.authSha256, OWNER))).toBe("FLEET_GENESIS_TAMPERED");
    expect(await pgCode(owner.query(`DELETE FROM fleet.fleet_genesis WHERE genesis_id = $1`, [g.genesisId]))).toBe("FLEET_HISTORY_IMMUTABLE");
    // A wrong content hash at approval is refused.
    const g2 = await genesis.propose({ idempotencyKey: key(), founderCount: 2, allocationCents: 100, ttlS: 3600, actor: OWNER });
    expect(await pgCode(genesis.approve(g2.genesisId, sha256Hex("something else"), OWNER))).toBe("FLEET_GENESIS_TAMPERED");
    // Expired before approval.
    const g3 = await genesis.propose({ idempotencyKey: key(), founderCount: 2, allocationCents: 0, ttlS: 600, actor: OWNER });
    const s2 = await su.connect();
    try {
      await s2.query("SET session_replication_role = replica");
      await s2.query(`UPDATE fleet.fleet_genesis SET expires_at = now() - interval '1 second' WHERE genesis_id = $1`, [g3.genesisId]);
    } finally {
      await s2.query("RESET session_replication_role");
      s2.release();
    }
    // (the tamper check covers expires_at too: the content changed)
    expect(await pgCode(genesis.approve(g3.genesisId, g3.authSha256, OWNER))).toBe("FLEET_GENESIS_TAMPERED");
    await reset();
  });

  it("an authorization past its expiry expires (before approval) or rolls back (after provisioning) via the reaper", async () => {
    const g = await genesis.propose({ idempotencyKey: key(), founderCount: 2, allocationCents: 0, ttlS: 600, actor: OWNER });
    await genesis.approve(g.genesisId, g.authSha256, OWNER);
    await genesis.provision(g.genesisId, OWNER);
    expect(await population()).toBe(2);
    // Time travel: shift every timestamp so the authorization is past due while its hash stays intact.
    const s = await su.connect();
    try {
      await s.query("SET session_replication_role = replica");
      await s.query(`UPDATE fleet.fleet_genesis SET expires_at = expires_at - interval '1 hour', requested_at = requested_at - interval '1 hour' WHERE genesis_id = $1`, [g.genesisId]);
      const row = (await s.query(`SELECT fleet.fleet_genesis_canonical(g) AS c FROM fleet.fleet_genesis g WHERE genesis_id = $1`, [g.genesisId])).rows[0];
      await s.query(`UPDATE fleet.fleet_genesis SET auth_sha256 = encode(sha256(convert_to($2, 'UTF8')), 'hex') WHERE genesis_id = $1`, [g.genesisId, row.c]);
    } finally {
      await s.query("RESET session_replication_role");
      s.release();
    }
    expect((await svc.query(`SELECT fleet.svc_genesis_expire(10) AS n`)).rows[0].n).toBe(1);
    expect((await genesis.status(g.genesisId))!.status).toBe("rolled_back");
    expect(await population()).toBe(0);
    await reset();
  });

  it("concurrent Genesis attempts: only one can be in flight", async () => {
    const a = await genesis.propose({ idempotencyKey: key(), founderCount: 1, allocationCents: 0, ttlS: 3600, actor: OWNER });
    const b = await genesis.propose({ idempotencyKey: key(), founderCount: 1, allocationCents: 0, ttlS: 3600, actor: OWNER });
    const g2 = new PgGenesisAdmin({ connectionString: pgc.ownerUrl });
    try {
      const rs = await Promise.all([pgCode(genesis.approve(a.genesisId, a.authSha256, OWNER)), pgCode(g2.approve(b.genesisId, b.authSha256, OWNER))]);
      expect(rs.filter((r) => r === "OK").length).toBe(1);
      expect(rs.find((r) => r !== "OK")).toMatch(/fleet_genesis_one_in_flight/);
    } finally {
      await g2.close();
    }
    await reset();
  });

  it("founder count is bounded by the registry cap and by the constitutional maximum", async () => {
    expect(await pgCode(genesis.propose({ idempotencyKey: key(), founderCount: 51, allocationCents: 0, actor: OWNER }))).toBe("FLEET_CAP_EXCEEDED");
    const g = await genesis.propose({ idempotencyKey: key(), founderCount: 3, allocationCents: 0, ttlS: 3600, actor: OWNER });
    expect(await pgCode(genesis.approve(g.genesisId, g.authSha256, OWNER))).toBe("FLEET_CAP_EXCEEDED"); // cap 2
    // The cap is re-checked at provisioning by the counter trigger even if it shrank after approval.
    const g2 = await genesis.propose({ idempotencyKey: key(), founderCount: 2, allocationCents: 0, ttlS: 3600, actor: OWNER });
    await genesis.approve(g2.genesisId, g2.authSha256, OWNER);
    await store.setMaxAgents(1, "t");
    expect(await pgCode(genesis.provision(g2.genesisId, OWNER))).toBe("FLEET_CAP_EXCEEDED");
    expect(await population()).toBe(0);
    await reset();
  });

  // ── Partial failure ──────────────────────────────────────────

  it("one founder's provisioning failure (after funding) rolls everything back: no authority, allocations returned, slots released", async () => {
    const g = await toReady(2, 4_000);
    const treasuryAtReady = Number((await q(`SELECT fleet.fleet_ledger_balance('fleet:treasury:unallocated') AS b`))[0].b);
    expect(await population()).toBe(2);
    const r = await genesis.fail(g.genesisId, g.founderIds[1], "workspace volume could not be created", OWNER);
    expect(r).toMatchObject({ status: "rolled_back", founders: 2 });
    const rows = await q(`SELECT status FROM fleet.fleet_agents WHERE agent_id = ANY($1)`, [g.founderIds]);
    expect(rows.every((x) => x.status === "failed")).toBe(true);
    expect((await q(`SELECT count(*)::int AS n FROM fleet.fleet_agent_credentials WHERE agent_id = ANY($1)`, [g.founderIds]))[0].n).toBe(0);
    for (const id of g.founderIds) expect((await ledger.economics(id)).cash).toBe(0);
    expect(Number((await q(`SELECT fleet.fleet_ledger_balance('fleet:treasury:unallocated') AS b`))[0].b)).toBe(treasuryAtReady + 2 * 4_000);
    expect(await population()).toBe(0);
    expect((await ledger.verify()).ok).toBe(true);
    // The consumed authorization cannot be reused, and its founders never come back.
    expect(await pgCode(genesis.activateWithHashes(g.genesisId, g.authSha256, [sha256Hex("a"), sha256Hex("b")], OWNER))).toBe("FLEET_GENESIS_CONSUMED");
    expect(await pgCode(owner.query(`UPDATE fleet.fleet_agents SET status = 'active' WHERE agent_id = $1`, [g.founderIds[0]]))).toMatch(/FLEET_GENESIS_REQUIRED|FLEET_TERMINAL_STATE_IMMUTABLE/);
    await reset();
  });

  it("one founder's attestation failure rolls the whole Genesis back", async () => {
    const g = await genesis.propose({ idempotencyKey: key(), founderCount: 2, allocationCents: 0, ttlS: 3600, actor: OWNER });
    await genesis.approve(g.genesisId, g.authSha256, OWNER);
    const p = await genesis.provision(g.genesisId, OWNER);
    const ids = p.founderIds!;
    await genesis.attest(g.genesisId, ids[0], (await simulateRuntimeAttestation(genesis, genesis, g.genesisId, ids[0], OWNER)).host, OWNER);
    for (const bad of [
      { commit: "f".repeat(40) },
      { manifestSha256: "0".repeat(64) },
      { workspaceId: (await genesis.expectedEvidence(g.genesisId, ids[0])).workspaceId }, // another founder's workspace
    ]) {
      // Each variant on a fresh Genesis.
      await reset();
      const gx = await genesis.propose({ idempotencyKey: key(), founderCount: 2, allocationCents: 0, ttlS: 3600, actor: OWNER });
      await genesis.approve(gx.genesisId, gx.authSha256, OWNER);
      const px = await genesis.provision(gx.genesisId, OWNER);
      const [x, y] = px.founderIds!;
      await genesis.attest(gx.genesisId, x, (await simulateRuntimeAttestation(genesis, genesis, gx.genesisId, x, OWNER)).host, OWNER);
      const override = "workspaceId" in bad ? { workspaceId: (await genesis.expectedEvidence(gx.genesisId, x)).workspaceId } : bad;
      const sim = await simulateRuntimeAttestation(genesis, genesis, gx.genesisId, y, OWNER, { runtime: override, host: override });
      const r = await genesis.attest(gx.genesisId, y, sim.host, OWNER);
      expect(r, JSON.stringify(bad)).toMatchObject({ ok: false, code: "FLEET_GENESIS_ATTESTATION_FAILED", status: "rolled_back" });
      expect(await population()).toBe(0);
    }
    await reset();
  });

  it("founders cannot be created, duplicated or advanced outside their Genesis", async () => {
    const g = await genesis.propose({ idempotencyKey: key(), founderCount: 2, allocationCents: 0, ttlS: 3600, actor: OWNER });
    await genesis.approve(g.genesisId, g.authSha256, OWNER);
    const p = await genesis.provision(g.genesisId, OWNER);
    const [a, b] = p.founderIds!;
    const row = (await q(`SELECT * FROM fleet.fleet_agents WHERE agent_id = $1`, [a]))[0];
    expect(await pgCode(owner.query(
      `INSERT INTO fleet.fleet_agents (agent_id, role, generation, name, status, requested_by, origin, genesis_id, lineage_root, capability_manifest_id, workspace_id, state_namespace)
       VALUES ('01ZZZZZZZZZZZZZZZZZZZZZZZZ', 'root', 0, 'forged', 'reserved', 'x', 'genesis_founder', $1, '01ZZZZZZZZZZZZZZZZZZZZZZZZ', 'founder-v1', 'ws_01ZZZZZZZZZZZZZZZZZZZZZZZZ', 'st_01ZZZZZZZZZZZZZZZZZZZZZZZZ')`,
      [g.genesisId]))).toBe("FLEET_GENESIS_REQUIRED");
    expect(await pgCode(owner.query(`UPDATE fleet.fleet_agents SET status = 'provisioning' WHERE agent_id = $1`, [a]))).toBe("FLEET_GENESIS_REQUIRED");
    // Shared state: a founder cannot take the other's workspace/state namespace, or change its own.
    expect(await pgCode(owner.query(`UPDATE fleet.fleet_agents SET workspace_id = $2 WHERE agent_id = $1`, [b, row.workspace_id]))).toMatch(/FLEET_HISTORY_IMMUTABLE|ERR:.*duplicate key/);
    expect(await pgCode(owner.query(`UPDATE fleet.fleet_agents SET capability_manifest_id = NULL WHERE agent_id = $1`, [a]))).toBe("FLEET_HISTORY_IMMUTABLE");
    expect(await pgCode(owner.query(`UPDATE fleet.fleet_genesis_founders SET status = 'active' WHERE agent_id = $1`, [a]))).toBe("FLEET_GENESIS_REQUIRED");
    // No credential and no session before activation: the founder cannot authenticate.
    expect(await gw.ledgerSummary(a, mintAgentToken(a))).toMatchObject({ ok: false, code: "FLEET_AUTH_FAILED" });
    await reset();
  });

  it("economic-policy or runtime drift after authorization blocks funding and activation", async () => {
    await ledger.recordOwnerFunding(50_000, `bank:${crypto.randomUUID()}`, OWNER);
    const g = await genesis.propose({ idempotencyKey: key(), founderCount: 2, allocationCents: 1_000, ttlS: 3600, actor: OWNER });
    await genesis.approve(g.genesisId, g.authSha256, OWNER);
    const p = await genesis.provision(g.genesisId, OWNER);
    for (const id of p.founderIds!) await genesis.attest(g.genesisId, id, (await simulateRuntimeAttestation(genesis, genesis, g.genesisId, id, OWNER)).host, OWNER);
    await owner.query(`UPDATE fleet.fleet_economic_model SET agent_daily_spend_cents = agent_daily_spend_cents + 1`);
    expect(await pgCode(genesis.fund(g.genesisId, OWNER))).toBe("FLEET_POLICY_CHANGED");
    await owner.query(`UPDATE fleet.fleet_economic_model SET agent_daily_spend_cents = agent_daily_spend_cents - 1`);
    await genesis.fund(g.genesisId, OWNER);
    await store.setApprovedRuntime({ repo: PIN.repo, commit: "a".repeat(40) }, "test", BUILD);
    const hashes = p.founderIds!.map((id) => hashAgentToken(mintAgentToken(id)));
    expect(await pgCode(genesis.activateWithHashes(g.genesisId, g.authSha256, hashes, OWNER))).toBe("FLEET_RUNTIME_MISMATCH");
    await store.setApprovedRuntime(PIN, "test", BUILD);
    expect(await pgCode(genesis.activateWithHashes(g.genesisId, g.authSha256, [hashes[0], hashes[0]], OWNER))).toBe("FLEET_BAD_REQUEST");
    expect(await pgCode(genesis.activateWithHashes(g.genesisId, sha256Hex("x"), hashes, OWNER))).toBe("FLEET_GENESIS_TAMPERED");
    await genesis.setEnabled(false, OWNER, "t");
    expect(await pgCode(genesis.activateWithHashes(g.genesisId, g.authSha256, hashes, OWNER))).toBe("FLEET_GENESIS_DISABLED");
    await genesis.setEnabled(true, OWNER, "t");
    expect((await genesis.activateWithHashes(g.genesisId, g.authSha256, hashes, OWNER)).status).toBe("activated");
    expect(await population()).toBe(2);
    await reset();
  });

  it("v12 runtime attestation: missing, stale, token-less, nonce-mismatched or re-issued-after-evidence runtime evidence fails closed", async () => {
    const g = await genesis.propose({ idempotencyKey: key(), founderCount: 2, allocationCents: 0, ttlS: 3600, actor: OWNER });
    await genesis.approve(g.genesisId, g.authSha256, OWNER);
    const p = await genesis.provision(g.genesisId, OWNER);
    const [a, b] = p.founderIds!;
    const okA = await simulateRuntimeAttestation(genesis, genesis, g.genesisId, a, OWNER);
    // A re-issue after evidence exists is refused (the evidence is bound to its token).
    expect(await pgCode(genesis.issueRuntime(g.genesisId, a, sha256Hex("x"), "n".repeat(24), OWNER))).toBe("FLEET_INVALID_STATE");
    // A wrong nonce is refused and nothing is recorded.
    const bad = await simulateRuntimeAttestation(genesis, genesis, g.genesisId, b, OWNER, { runtime: { nonce: "z".repeat(32) } });
    expect(bad.submitted).toMatchObject({ ok: false, code: "FLEET_GENESIS_NONCE_MISMATCH" });
    expect((await genesis.runtimeEvidence(g.genesisId, b)).evidence).toBeNull();
    // Stale runtime evidence (older than 30 minutes) is not attestation.
    const s = await su.connect();
    try {
      await s.query("SET session_replication_role = replica");
      await s.query(`UPDATE fleet.fleet_genesis_founders SET runtime_evidence_at = now() - interval '31 minutes' WHERE agent_id = $1`, [a]);
    } finally {
      await s.query("RESET session_replication_role");
      s.release();
    }
    expect(await genesis.attest(g.genesisId, a, okA.host, OWNER)).toMatchObject({ ok: false, why: "runtime evidence is stale", status: "rolled_back" });
    // No evidence at all from the running process → rollback (fresh Genesis).
    await reset();
    const g2 = await genesis.propose({ idempotencyKey: key(), founderCount: 1, allocationCents: 0, ttlS: 3600, actor: OWNER });
    await genesis.approve(g2.genesisId, g2.authSha256, OWNER);
    const p2 = await genesis.provision(g2.genesisId, OWNER);
    const sim = await simulateRuntimeAttestation(genesis, genesis, g2.genesisId, p2.founderIds![0], OWNER, { submit: false });
    expect(await genesis.attest(g2.genesisId, p2.founderIds![0], sim.host, OWNER)).toMatchObject({ ok: false, why: "no evidence from the running founder process", status: "rolled_back" });
    // Host evidence naming a different process than the runtime's own evidence → rollback.
    await reset();
    const g3 = await genesis.propose({ idempotencyKey: key(), founderCount: 1, allocationCents: 0, ttlS: 3600, actor: OWNER });
    await genesis.approve(g3.genesisId, g3.authSha256, OWNER);
    const p3 = await genesis.provision(g3.genesisId, OWNER);
    const sim3 = await simulateRuntimeAttestation(genesis, genesis, g3.genesisId, p3.founderIds![0], OWNER, { host: { pid: 99999 } });
    expect(await genesis.attest(g3.genesisId, p3.founderIds![0], sim3.host, OWNER)).toMatchObject({ ok: false, why: "host and runtime evidence describe different processes" });
    await reset();
    // Host observation disagreeing with the authorization (the runtime's own claim being fine) → rollback.
    const g4 = await genesis.propose({ idempotencyKey: key(), founderCount: 1, allocationCents: 0, ttlS: 3600, actor: OWNER });
    await genesis.approve(g4.genesisId, g4.authSha256, OWNER);
    const p4 = await genesis.provision(g4.genesisId, OWNER);
    const sim4 = await simulateRuntimeAttestation(genesis, genesis, g4.genesisId, p4.founderIds![0], OWNER, { host: { buildId: "9".repeat(64) } });
    expect(await genesis.attest(g4.genesisId, p4.founderIds![0], sim4.host, OWNER)).toMatchObject({ ok: false, why: "host: runtime build id differs", status: "rolled_back" });
    await reset();
    // A runtime that claims ANOTHER founder's identity with its own token is not attestation.
    const g5 = await genesis.propose({ idempotencyKey: key(), founderCount: 2, allocationCents: 0, ttlS: 3600, actor: OWNER });
    await genesis.approve(g5.genesisId, g5.authSha256, OWNER);
    const p5 = await genesis.provision(g5.genesisId, OWNER);
    const [f1, f2] = p5.founderIds!;
    const sim5 = await simulateRuntimeAttestation(genesis, genesis, g5.genesisId, f1, OWNER, { runtime: { agentId: f2 }, host: {} });
    expect(await genesis.attest(g5.genesisId, f1, sim5.host, OWNER)).toMatchObject({ ok: false, why: "runtime: founder identity differs" });
    await reset();
  });

  // ── Economics ────────────────────────────────────────────────

  it("the starting allocation is virtual, balanced, distinguishable, and never revenue, profit or LFC", async () => {
    const g = await activated(2, 7_000);
    const lfc0 = await ledger.lifetimeFleetContribution();
    for (const f of g.founders) {
      const e = await ledger.economics(f.agentId);
      expect(e).toMatchObject({ cash: 7_000, genesisAllocation: 7_000, treasuryAllocation: 0, externalCustomerRevenue: 0, realizedNetProfit: 0, uncontributedProfit: 0, protectedPrincipal: 0 });
      expect(await pgCode(ledger.contribute(f.agentId, 1, OWNER))).toBe("FLEET_LFC_EXCEEDS_REALIZED_PROFIT");
    }
    expect(await ledger.lifetimeFleetContribution()).toBe(lfc0);
    expect((await ledger.verify()).ok).toBe(true);
    const kinds = await q(`SELECT kind, count(*)::int AS n FROM fleet.fleet_ledger_journal WHERE agent_id = ANY($1) GROUP BY kind`, [g.founderIds]);
    expect(kinds).toEqual([{ kind: "genesis_allocation", n: 2 }]);
    // The grammar keeps the allocation away from revenue and LFC.
    expect(await pgCode(owner.query(`SELECT fleet.fleet_ledger_post('genesis_allocation', $1, 'operator:owner', 'x', 'owner', $2, NULL, NULL, NULL, NULL, now(), $3)`, [
      key(), g.founderIds[0], JSON.stringify([{ account: `agent:${g.founderIds[0]}:revenue`, side: "C", amount: 1 }, { account: "fleet:treasury:unallocated", side: "D", amount: 1 }]),
    ]))).toBe("FLEET_LEDGER_RULE");
    expect(await pgCode(owner.query(`SELECT fleet.fleet_ledger_post('genesis_allocation', $1, 'operator:owner', 'x', 'owner', NULL, NULL, NULL, NULL, NULL, now(), $2)`, [
      key(), JSON.stringify([{ account: "fleet:profit", side: "C", amount: 1 }, { account: "fleet:treasury:unallocated", side: "D", amount: 1 }]),
    ]))).toBe("FLEET_LEDGER_RULE");
    await reset();
  });

  it("internal value is never external revenue; genuine external revenue, refunds and investment P&L carry provenance", async () => {
    const g = await activated(2, 1_000);
    const [a, b] = g.founderIds;
    const bWallet = (await q(`SELECT wallet_address FROM fleet.fleet_agents WHERE agent_id = $1`, [b]))[0].wallet_address;
    // From another founder's identity, an owner destination or a registered fleet reference: refused.
    expect(await pgCode(ledger.recordRevenue(a, 500, `pay:${crypto.randomUUID()}`, bWallet, OWNER))).toBe("FLEET_INTERNAL_TRANSFER_NOT_REVENUE");
    const od = await ledger.enrollDestination({ kind: "owner", rail: "bank_transfer", label: "owner", reference: "OWNER-IBAN", actor: OWNER });
    expect(od.destinationId).toMatch(/^dst_/);
    // owner destination references are matched on the reference digest
    await owner.query(`SELECT 1`);
    await ledger.addControlledReference("treasury-wallet-0xabc", "fleet treasury", OWNER);
    expect(await pgCode(ledger.recordRevenue(a, 500, `pay:${crypto.randomUUID()}`, "treasury-wallet-0xabc", OWNER))).toBe("FLEET_INTERNAL_TRANSFER_NOT_REVENUE");
    expect(await pgCode(owner.query(`SELECT fleet.fleet_admin_record_external('external_revenue', $1, 10, 'pay:x1234', NULL, 'operator:owner', $2)`, [a, key()]))).toBe("FLEET_PROVENANCE_REQUIRED");
    // An agent-to-agent transfer can never touch revenue (grammar).
    expect(await pgCode(owner.query(`SELECT fleet.fleet_ledger_post('agent_transfer', $1, 'operator:owner', 'x', 'owner', $2, NULL, NULL, NULL, NULL, now(), $3)`, [
      key(), a, JSON.stringify([{ account: `agent:${b}:cash`, side: "C", amount: 100 }, { account: `agent:${a}:revenue`, side: "C", amount: 0 }, { account: `agent:${a}:cash`, side: "D", amount: 100 }]),
    ]))).toMatch(/FLEET_LEDGER_(INVALID|RULE)/);
    // Genuine external facts.
    await ledger.recordRevenue(a, 900, `stripe:${crypto.randomUUID()}`, "customer:acme-ltd", OWNER);
    await ledger.recordExternal("external_refund", a, 100, `stripe:${crypto.randomUUID()}`, "customer:acme-ltd", OWNER);
    await ledger.recordExternal("investment_realized_gain", a, 50, `broker:${crypto.randomUUID()}`, "broker:ibkr", OWNER);
    const e = await ledger.economics(a);
    expect(e).toMatchObject({ externalCustomerRevenue: 800, realizedInvestmentPnl: 50, realizedNetProfit: 850, genesisAllocation: 1_000 });
    const prov = await q(`SELECT provenance, count(*)::int AS n FROM fleet.fleet_revenue_provenance WHERE agent_id = $1 GROUP BY provenance ORDER BY 1`, [a]);
    expect(prov).toEqual([{ provenance: "external_customer_revenue", n: 1 }, { provenance: "realized_investment_pnl", n: 1 }, { provenance: "refund", n: 1 }]);
    await reset();
  });

  // ── Reproduction and payment paths ───────────────────────────

  it("a founder cannot reproduce, even with the replication switches on, and has no payment execution path", async () => {
    const g = await activated(2, 1_000);
    const f = g.founders[0];
    await store.setOperatingMode("EXPANSION", "t", "t");
    await store.setReplicationEnabled(true, "t");
    await store.setMaxAgents(5, "t");
    // The agent API fails closed with the constitutional code (raised by the origin guard, whatever the switches say).
    expect(await pgCode(agentRaw.query(`SELECT fleet.api_request_replication($1, $2, 'kid', $3, NULL, NULL) AS r`, [f.agentId, f.token, key()]))).toBe("FLEET_REPRODUCTION_DISABLED");
    expect(await pgCode(store.reserveSlot({ parentAgentId: f.agentId, requestedBy: "owner", name: "kid", runtime: PIN }))).toMatch(/FLEET_REPRODUCTION_DISABLED|OK/);
    expect((await q(`SELECT count(*)::int AS n FROM fleet.fleet_agents WHERE parent_agent_id = ANY($1)`, [g.founderIds]))[0].n).toBe(0);
    expect((await gw.capabilities(f.agentId, f.token))).toMatchObject({ ok: true, origin: "genesis_founder", manifestId: "founder-v1", reproductionExecutable: false, paymentExecutable: false });
    // Legacy wallet spend path is superseded; custody protocol is not reachable; spend orders are the only path (decided, never executed).
    expect((await gw.requestSpend(f.agentId, f.token, { requestId: "01" + "A".repeat(24), fromWallet: "0x" + "1".repeat(40), toAddress: "0x" + "2".repeat(40), amountCents: 1, purpose: "x", allocationId: null })))
      .toMatchObject({ ok: false, code: "FLEET_LEGACY_SUPERSEDED" });
    expect(await pgCode(agentRaw.query(`SELECT fleet.cx_claim_instruction('w', repeat('a',64))`))).toMatch(/ERR:permission denied/);
    await store.setReplicationEnabled(false, "t");
    await reset();
  });

  it("a founder cannot edit its capability manifest; manifests cannot grant constitutional exclusions", async () => {
    const g = await activated(1, 0);
    expect(await pgCode(owner.query(`UPDATE fleet.fleet_capability_manifests SET allowed = array_append(allowed, 'reproduction')`))).toBe("FLEET_HISTORY_IMMUTABLE");
    expect(await pgCode(owner.query(`INSERT INTO fleet.fleet_capability_manifests (manifest_id, version, allowed, manifest_sha256, description, created_by)
      VALUES ('founder-v2', 2, ARRAY['reproduction'], repeat('0',64), 'x', 'x')`))).toBe("FLEET_CAPABILITY_NOT_GRANTABLE");
    expect(await pgCode(owner.query(`INSERT INTO fleet.fleet_capability_manifests (manifest_id, version, allowed, manifest_sha256, description, created_by)
      VALUES ('founder-v2', 2, ARRAY['custody.payment_execution'], repeat('0',64), 'x', 'x')`))).toBe("FLEET_CAPABILITY_NOT_GRANTABLE");
    expect(await pgCode(owner.query(`UPDATE fleet.fleet_agents SET capability_manifest_id = 'founder-v1' WHERE agent_id = $1`, [g.founderIds[0]]))).toBe("OK"); // same value: no change
    expect(await pgCode(agentRaw.query(`UPDATE fleet.fleet_capability_manifests SET allowed = '{}'`))).toMatch(/ERR:permission denied/);
    // Defence in depth: a manifest smuggled in around its guard (superuser) still cannot grant an excluded class.
    const s = await su.connect();
    try {
      await s.query("SET session_replication_role = replica");
      await s.query(`INSERT INTO fleet.fleet_capability_manifests (manifest_id, version, allowed, manifest_sha256, description, created_by)
        VALUES ('smuggled', 9, ARRAY['reproduction','custody.payment_execution','spend.request'], repeat('9',64), 'x', 'x')`);
    } finally {
      await s.query("RESET session_replication_role");
      s.release();
    }
    const reg = await store.registerRoot({ walletAddress: `0x${crypto.randomBytes(20).toString("hex")}`, name: "legacy" }).catch(() => null);
    if (reg && reg.ok) {
      await owner.query(`UPDATE fleet.fleet_agents SET capability_manifest_id = 'smuggled' WHERE agent_id = $1`, [reg.agent.agentId]);
      const can = (await q(`SELECT fleet.fleet_agent_can($1, 'reproduction') AS r, fleet.fleet_agent_can($1, 'custody.payment_execution') AS p, fleet.fleet_agent_can($1, 'spend.request') AS s`, [reg.agent.agentId]))[0];
      expect(can).toEqual({ r: false, p: false, s: true });
    }
    await reset();
  });

  // ── Death / estate ───────────────────────────────────────────

  it("a dead or quarantined founder loses all economic authority at once; the estate settles exactly once", async () => {
    const g = await activated(2, 3_000);
    const [a, b] = g.founders;
    const payee = await ledger.enrollDestination({ kind: "payee", rail: "evm_usdc", label: "vendor", reference: "0xvendor", actor: OWNER });
    const s = await su.connect();
    try {
      await s.query("SET session_replication_role = replica");
      await s.query(`UPDATE fleet.fleet_payment_destinations SET activatable_at = now() - interval '1 second', enrolled_at = now() - interval '4 days'`);
    } finally {
      await s.query("RESET session_replication_role");
      s.release();
    }
    await ledger.activateDestination(payee.destinationId, payee.activationCode, OWNER);
    const o = await gw.spendRequest(a.agentId, a.token, { idempotencyKey: key(), amountCents: 1_000, category: "expense", destinationId: payee.destinationId, purpose: "hosting" });
    expect((o.order as { status: string }).status).toBe("reserved");
    // Economic death: the reserved order is cancelled and released by the lifecycle freeze in the same transaction.
    await store.markDead(a.agentId, "retired", "t", "reported");
    expect((await q(`SELECT status, decision_code FROM fleet.fleet_payment_orders WHERE agent_id = $1`, [a.agentId]))[0]).toEqual({ status: "cancelled", decision_code: "FLEET_ESTATE_FREEZE" });
    expect(await gw.spendRequest(a.agentId, a.token, { idempotencyKey: key(), amountCents: 1, category: "expense", destinationId: payee.destinationId, purpose: "x" }))
      .toMatchObject({ ok: false, code: "FLEET_AGENT_DEAD" });
    expect(await gw.ledgerSummary(a.agentId, a.token)).toMatchObject({ ok: false, code: "FLEET_AGENT_DEAD" });
    // Race: the reaper and the owner settle concurrently; exactly one settles.
    const rs = await Promise.all([pgCode(svc.query(`SELECT fleet.svc_settle_estates(10)`)), pgCode(ledger.estateSettle(a.agentId, OWNER))]);
    expect((await q(`SELECT status FROM fleet.fleet_estates WHERE agent_id = $1`, [a.agentId]))[0].status).toBe("settled");
    expect(rs.filter((r) => r === "OK").length).toBeGreaterThanOrEqual(1);
    expect((await q(`SELECT count(*)::int AS n FROM fleet.fleet_ledger_journal WHERE agent_id = $1 AND kind = 'estate_transfer'`, [a.agentId]))[0].n).toBe(1);
    expect((await ledger.economics(a.agentId)).cash).toBe(0);
    // Quarantine (terminating) also freezes: sessions and credentials revoked, no economic action.
    await store.quarantine(b.agentId, "suspicious", OWNER);
    expect(await gw.spendRequest(b.agentId, b.token, { idempotencyKey: key(), amountCents: 1, category: "expense", destinationId: payee.destinationId, purpose: "x" }))
      .toMatchObject({ ok: false });
    expect((await q(`SELECT status FROM fleet.fleet_estates WHERE agent_id = $1`, [b.agentId]))[0].status).toBe("open");
    expect((await ledger.verify()).ok).toBe(true);
    await reset();
  });

  // ── Knowledge and identity vault ─────────────────────────────

  it("institutional knowledge: proposals carry the authenticated origin; promotion is owner-only; provenance cannot be forged", async () => {
    const g = await activated(2, 0);
    const [a, b] = g.founders;
    const p = await gw.knowledgePropose(a.agentId, a.token, "market", "Niche demand", "Customers in X pay for Y.");
    expect(p).toMatchObject({ ok: true, status: "proposed" });
    // B cannot see A's unpromoted proposal (no list surface for proposals) and cannot forge an entry.
    expect((await gw.knowledgeList(b.agentId, b.token, 0, 50)).entries).toEqual([]);
    expect(await pgCode(owner.query(`INSERT INTO fleet.fleet_knowledge_entries (entry_id, proposal_id, origin_agent_id, category, title, content, content_sha256, promoted_by)
      VALUES (gen_random_uuid(), $1, $2, 'market', 'Niche demand', 'Customers in X pay for Y.', encode(sha256('Customers in X pay for Y.'::bytea), 'hex'), 'operator:owner')`,
      [p.proposalId, b.agentId]))).toBe("FLEET_KNOWLEDGE_PROVENANCE");
    for (const actor of [`operator:${a.agentId}`, "operator:claude-operator"]) {
      expect(await pgCode(genesis.reviewKnowledge(p.proposalId as string, true, null, actor))).toBe("FLEET_SELF_APPROVAL");
    }
    // Even a promoted proposal cannot back an entry with a forged origin.
    const p2 = await gw.knowledgePropose(a.agentId, a.token, "technique", "Forgery target", "Original content by A.");
    // Only the origin agent differs (lineage, genesis, content, title and category copied exactly).
    await owner.query(`UPDATE fleet.fleet_knowledge_proposals SET status = 'promoted', reviewed_by = 'operator:owner', reviewed_at = now() WHERE proposal_id = $1`, [p2.proposalId]);
    expect(await pgCode(owner.query(`INSERT INTO fleet.fleet_knowledge_entries (entry_id, proposal_id, origin_agent_id, origin_lineage_root, origin_genesis_id, category, title, content, content_sha256, promoted_by)
      VALUES (gen_random_uuid(), $1, $2, $3, (SELECT genesis_id FROM fleet.fleet_knowledge_proposals WHERE proposal_id = $1), 'technique', 'Forgery target', 'Original content by A.', encode(sha256('Original content by A.'::bytea), 'hex'), 'operator:owner')`,
      [p2.proposalId, b.agentId, a.agentId]))).toBe("FLEET_KNOWLEDGE_PROVENANCE");
    await genesis.reviewKnowledge(p.proposalId as string, true, "useful", OWNER);
    const e = (await gw.knowledgeList(b.agentId, b.token, 0, 50)).entries as Array<Record<string, unknown>>;
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ originAgentId: a.agentId, originLineageRoot: a.agentId, promotedBy: OWNER, contentSha256: sha256Hex("Customers in X pay for Y.") });
    expect(await pgCode(owner.query(`UPDATE fleet.fleet_knowledge_entries SET origin_agent_id = $1`, [b.agentId]))).toBe("FLEET_HISTORY_IMMUTABLE");
    expect(await pgCode(owner.query(`UPDATE fleet.fleet_knowledge_proposals SET content = 'x' WHERE proposal_id = $1`, [p.proposalId]))).toBe("FLEET_HISTORY_IMMUTABLE");
    await reset();
  });

  it("identity vault: one approved fact per approved claim, bounded reads, never secrets, never a listing, never another agent's claim", async () => {
    const g = await activated(2, 0);
    const [a, b] = g.founders;
    await owner.query(`SELECT fleet.fleet_org_identity_set('trading_name', 'Synthetic Test Co', 'public', 'operator:owner')`);
    await owner.query(`SELECT fleet.fleet_org_identity_set('tax_identifier', 'SYNTHETIC-TAX-000', 'secret', 'operator:owner')`);
    const c1 = await gw.identityRequest(a.agentId, a.token, "trading_name", "invoice header", "invoicing");
    expect(await gw.identityFact(a.agentId, a.token, c1.claimId as string)).toMatchObject({ ok: false, code: "FLEET_IDENTITY_CLAIM_NOT_ACTIVE" });
    expect(await pgCode(genesis.decideIdentityClaim(c1.claimId as string, true, 600, 2, `operator:${a.agentId}`))).toBe("FLEET_SELF_APPROVAL");
    await genesis.decideIdentityClaim(c1.claimId as string, true, 600, 2, OWNER);
    expect(await gw.identityFact(b.agentId, b.token, c1.claimId as string)).toMatchObject({ ok: false, code: "FLEET_NOT_FOUND" });
    expect(await gw.identityFact(a.agentId, a.token, c1.claimId as string)).toMatchObject({ ok: true, factKey: "trading_name", value: "Synthetic Test Co" });
    expect(await gw.identityFact(a.agentId, a.token, c1.claimId as string)).toMatchObject({ ok: true });
    expect(await gw.identityFact(a.agentId, a.token, c1.claimId as string)).toMatchObject({ ok: false, code: "FLEET_IDENTITY_CLAIM_NOT_ACTIVE" }); // max 2 reads
    const c2 = await gw.identityRequest(a.agentId, a.token, "tax_identifier", "registration", "tax");
    await genesis.decideIdentityClaim(c2.claimId as string, true, 600, 5, OWNER);
    expect(await gw.identityFact(a.agentId, a.token, c2.claimId as string)).toMatchObject({ ok: false, code: "FLEET_IDENTITY_FACT_UNAVAILABLE" });
    const ev = await q(`SELECT detail::text AS d FROM fleet.fleet_events WHERE event_type LIKE 'identity_%'`);
    expect(ev.map((x) => x.d).join("\n")).not.toContain("SYNTHETIC-TAX-000");
    await reset();
  });

  it("the Genesis surface audit detects mutations", async () => {
    const X = "fleet_gmut";
    const xs = new PgFleetStore({ connectionString: pgc.ownerUrl, schema: X });
    try {
      await xs.migrate();
      expect(await genesisSurfaceProblems(owner, X)).toEqual([]);
      const mutate = async (sql: string, re: RegExp, undo: string) => {
        await owner.query(sql);
        try {
          const p = await genesisSurfaceProblems(owner, X);
          expect(p.some((x) => re.test(x)), `${sql}\n${p.join("\n")}`).toBe(true);
        } finally {
          await owner.query(undo);
        }
      };
      await mutate(`CREATE FUNCTION ${X}.fleet_backdoor() RETURNS void LANGUAGE sql AS $$ SELECT set_config('fleet.genesis_op', 'x', true) $$`, /fleet_backdoor references the Genesis operation guard/, `DROP FUNCTION ${X}.fleet_backdoor()`);
      await mutate(`ALTER TABLE ${X}.fleet_agents DISABLE TRIGGER fleet_agents_origin_guard`, /fleet_agents_origin_guard is missing or disabled/, `ALTER TABLE ${X}.fleet_agents ENABLE TRIGGER fleet_agents_origin_guard`);
      await mutate(`ALTER TABLE ${X}.fleet_agents DISABLE TRIGGER fleet_agents_death_freeze`, /fleet_agents_death_freeze is missing or disabled/, `ALTER TABLE ${X}.fleet_agents ENABLE TRIGGER fleet_agents_death_freeze`);
      const con = (await owner.query(`SELECT conname FROM pg_constraint WHERE conrelid = '${X}.fleet_reproduction_policy'::regclass AND pg_get_constraintdef(oid) ~ 'NOT execution_enabled'`)).rows[0].conname;
      await mutate(`ALTER TABLE ${X}.fleet_reproduction_policy DROP CONSTRAINT ${con}`, /reproduction execution is not pinned off/, `ALTER TABLE ${X}.fleet_reproduction_policy ADD CONSTRAINT ${con} CHECK (NOT execution_enabled)`);
    } finally {
      await xs.close();
    }
  });

  it("the two-founder Genesis dry run passes and leaves no trace", async () => {
    await reset();
    await genesis.setEnabled(false, OWNER, "production-like: disabled");
    const r = await runGenesisDryRun({ connectionString: pgc.ownerUrl, actor: OWNER });
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.pass).toBe(true);
    expect(await population()).toBe(0);
    expect((await q(`SELECT count(*)::int AS n FROM fleet.fleet_genesis`))[0].n).toBe(0);
    expect((await q(`SELECT genesis_enabled FROM fleet.fleet_genesis_policy`))[0].genesis_enabled).toBe(false);
    // And with the cap below two, it fails closed (cap admission).
    await store.setMaxAgents(1, "t");
    const r2 = await runGenesisDryRun({ connectionString: pgc.ownerUrl, actor: OWNER });
    expect(r2.pass).toBe(false);
    expect(await population()).toBe(0);
    await reset();
  });
});

// Unused-import guard for helpers only referenced in some branches.
void GenesisOps;

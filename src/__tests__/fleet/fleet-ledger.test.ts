/**
 * Phase E — central treasury, double-entry ledger and custody boundary
 * (schema v10), end to end and adversarially against an ephemeral
 * PostgreSQL cluster with the real role model.
 *
 * Proves: the ledger is append-only, balanced, grammar-bound, hash-chained
 * and idempotent; agents hold virtual allocations and only submit structured
 * spend orders decided by the database; protected principal and survival
 * equity are constitutional (the owner cannot override them) while policy
 * limits are owner-overridable with an audited acknowledgement; LFC only
 * counts realized net profit contributions; destinations need enrollment,
 * cooldown and a one-time code; owner withdrawals above the threshold need a
 * second confirmation; custody execution is constitutionally disabled and
 * the executor protocol (proven in a separate schema with the pin removed) is
 * lease-bound, exact and idempotent; estates leave no orphaned asset;
 * legacy economics are frozen with digests; each role reaches only its
 * functions; static-audit mutations are detected.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { PgFleetStore } from "../../fleet/postgres/store.js";
import { PgAgentGateway } from "../../fleet/postgres/agent-gateway.js";
import { auditPrivileges, ledgerSurfaceProblems } from "../../fleet/postgres/privileges.js";
import { PgLedgerAdmin, sha256Hex } from "../../fleet/treasury/ledger.js";
import { PgOperatorAdmin } from "../../fleet/operator/admin.js";
import { rawPublicKey } from "../../fleet/operator/canonical.js";
import { findPgBin, startEphemeralPg, type EphemeralPg } from "./fixtures/ephemeral-pg.js";
import { migrateUpTo } from "./fixtures/migrate-to.js";
import { FleetApiClient } from "../../fleet/service/client.js";
import { FleetService } from "../../fleet/service/server.js";
import { UnsupportedSandboxTerminator } from "../../fleet/service/terminator.js";

const PG_BIN = findPgBin();
const PIN = { repo: "https://github.com/5l4mm3r/automaton-fleet", commit: "c".repeat(40) };
const BUILD = { buildId: "d".repeat(64), lockfileSha256: "e".repeat(64) };
const OWNER = "operator:owner";

interface Agent {
  agentId: string;
  token: string;
}

async function pgCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "OK";
  } catch (err) {
    const m = /^(FLEET_[A-Z_]+|[A-Z_]+:)/.exec((err as Error).message);
    return m ? m[1].replace(/:$/, "") : `ERR:${(err as Error).message}`;
  }
}

describe.skipIf(!PG_BIN)("Phase E treasury ledger and custody boundary (schema v10)", () => {
  let pgc: EphemeralPg;
  let owner: pg.Pool;
  let su: pg.Pool;
  let svc: pg.Pool;
  let agentRaw: pg.Pool;
  let custody: pg.Pool;
  let opRaw: pg.Pool;
  let store: PgFleetStore;
  let ledger: PgLedgerAdmin;
  let gw: PgAgentGateway;
  const agents: Agent[] = [];
  let payee = ""; // active payee destination (any agent)
  let ownerDst = ""; // active owner destination
  let fundingN = 0;

  const q = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;
  const bal = async (acct: string) => Number((await q(`SELECT fleet.fleet_ledger_balance($1) AS b`, [acct]))[0].b);
  const agentAcct = (a: Agent, cls: string) => `agent:${a.agentId}:${cls}`;
  const key = (p = "k") => `${p}:${crypto.randomBytes(9).toString("base64url")}`;
  /** Test-only: move a destination past its cooldown (superuser, triggers bypassed). */
  async function pastCooldown(dst: string) {
    const c = await su.connect();
    try {
      await c.query("SET session_replication_role = replica");
      await c.query(`UPDATE fleet.fleet_payment_destinations SET activatable_at = now() - interval '1 second', enrolled_at = now() - interval '4 days' WHERE destination_id = $1`, [dst]);
    } finally {
      await c.query("RESET session_replication_role").catch(() => {});
      c.release();
    }
  }
  async function activeDestination(kind: "owner" | "payee", agentId: string | null = null): Promise<string> {
    const e = await ledger.enrollDestination({ kind, rail: kind === "owner" ? "bank_transfer" : "evm_usdc", label: `${kind} test`, reference: `ref-${crypto.randomUUID()}`, hint: "***1234", agentId, actor: OWNER });
    await pastCooldown(e.destinationId);
    await ledger.activateDestination(e.destinationId, e.activationCode, OWNER);
    return e.destinationId;
  }
  const fund = async (cents: number) => ledger.recordOwnerFunding(cents, `bank:test-${++fundingN}-${crypto.randomUUID()}`, OWNER);
  const spend = (a: Agent, amountCents: number, opts: { category?: string; dst?: string; idem?: string; recoverable?: number } = {}) =>
    gw.spendRequest(a.agentId, a.token, {
      idempotencyKey: opts.idem ?? key("spend"),
      amountCents,
      category: opts.category ?? "expense",
      destinationId: opts.dst ?? payee,
      purpose: "test spend",
      recoverableCents: opts.recoverable ?? 0,
    });
  const order = (r: Record<string, unknown>) => r.order as Record<string, unknown>;

  beforeAll(async () => {
    pgc = await startEphemeralPg(PG_BIN!);
    owner = new pg.Pool({ connectionString: pgc.ownerUrl, max: 8 });
    su = new pg.Pool({ connectionString: pgc.superUrl.replace(/\/postgres$/, `/${pgc.dbname}`), max: 2 });
    store = new PgFleetStore({ connectionString: pgc.ownerUrl });
    await store.migrate();
    await store.setApprovedRuntime(PIN, "test", BUILD);
    await store.setMaxAgents(20, "test");
    for (let i = 0; i < 8; i++) {
      const reg = await store.registerRoot({ walletAddress: `0x${crypto.randomBytes(20).toString("hex")}`, name: `root-${i}` });
      if (!reg.ok) throw new Error(reg.reason);
      const cred = await store.issueCredential(reg.agent.agentId, "test");
      agents.push({ agentId: reg.agent.agentId, token: cred.token });
    }
    ledger = new PgLedgerAdmin({ connectionString: pgc.ownerUrl });
    gw = new PgAgentGateway({ connectionString: pgc.agentUrl });
    svc = new pg.Pool({ connectionString: pgc.serviceUrl, max: 2 });
    agentRaw = new pg.Pool({ connectionString: pgc.agentUrl, max: 2 });
    custody = new pg.Pool({ connectionString: pgc.custodyUrl, max: 2 });
    opRaw = new pg.Pool({ connectionString: pgc.operatorUrl, max: 2 });
    const opAdmin = new PgOperatorAdmin({ connectionString: pgc.ownerUrl });
    try {
      const { privateKey } = crypto.generateKeyPairSync("ed25519");
      await opAdmin.enroll({ name: "claude-operator", kind: "bridge_claude", scopes: ["ops.read.status"] as never, publicKey: rawPublicKey(privateKey).toString("base64url"), expiresDays: 30, actor: OWNER });
    } finally {
      await opAdmin.close();
    }
    payee = await activeDestination("payee");
    ownerDst = await activeDestination("owner");
  }, 120_000);

  afterAll(async () => {
    await ledger?.close();
    await gw?.close();
    for (const p of [svc, agentRaw, custody, opRaw, su, owner]) await p?.end();
    await store?.close();
    pgc?.stop();
  });

  // ── Schema, model and privileges ─────────────────────────────

  it("migrates to v10 with custody execution constitutionally pinned off and a clean privilege audit", async () => {
    expect((await q(`SELECT max(version) AS v FROM fleet.fleet_schema_migrations`))[0].v).toBe(17);
    const m = await ledger.model();
    expect(m).toMatchObject({ ledgerAuthoritative: true, custodyExecutionEnabled: false, ownerApprovalThresholdCents: 10000, strongAuthThresholdCents: 50000 });
    // Not an ordinary economic setting: even the owner cannot turn it on without a migration.
    expect(await pgCode(owner.query(`UPDATE fleet.fleet_economic_model SET custody_execution_enabled = true`))).toMatch(/ERR:.*check constraint/);
    expect(await pgCode(owner.query(`UPDATE fleet.fleet_economic_model SET ledger_authoritative = false`))).toMatch(/ERR:.*check constraint/);
    expect(await pgCode(owner.query(`DELETE FROM fleet.fleet_economic_model`))).toBe("FLEET_HISTORY_IMMUTABLE");
    const audit = await auditPrivileges(owner);
    expect(audit.problems).toEqual([]);
    expect(audit.custodyRoles).toBe("provisioned");
    const cx = audit.roles.find((r) => r.role === "fleet_custody_login")!;
    expect(cx.functions.sort()).toEqual(["cx_claim_instruction(text,text)", "cx_ping()", "cx_report_result(uuid,text,text,text,bigint,text)"]);
    expect(cx.tables).toEqual([]);
    expect((await ledger.verify()).ok).toBe(true);
  });

  it("no restricted role can post to the ledger, act as FleetAdmin or read ledger tables", async () => {
    const tries: Array<[pg.Pool, string]> = [];
    for (const p of [agentRaw, svc, custody, opRaw]) {
      tries.push([p, `SELECT fleet.fleet_ledger_post('owner_funding','x:12345678','a','r','owner',NULL,NULL,NULL,'ext:1',NULL,now(),'[]'::jsonb)`]);
      tries.push([p, `SELECT fleet.fleet_admin_record_owner_funding(1, 'ext:1234', 'operator:x', 'k:12345678')`]);
      tries.push([p, `SELECT fleet.fleet_admin_spend_decision(gen_random_uuid(), 'approve', 'operator:x', NULL, true)`]);
      tries.push([p, `SELECT fleet.fleet_profit_contribution('x', 1, 'a', 'controller', 'k:12345678')`]);
      tries.push([p, `SELECT fleet.fleet_destination_enroll('dst_x','payee','evm_usdc','l',repeat('a',64),NULL,NULL,'operator:x',repeat('a',64))`]);
      tries.push([p, `SELECT * FROM fleet.fleet_ledger_journal`]);
      tries.push([p, `SELECT * FROM fleet.fleet_payment_destinations`]);
      tries.push([p, `INSERT INTO fleet.fleet_ledger_postings (journal_id, line, account_id, side, amount_cents) VALUES (gen_random_uuid(), 1, 'fleet:profit', 'C', 1)`]);
    }
    for (const [p, sql] of tries) expect(await pgCode(p.query(sql))).toMatch(/ERR:permission denied/);
    // The custody executor cannot reach the agent / service / operator surfaces either.
    expect(await pgCode(custody.query(`SELECT fleet.svc_issue_payment_instruction(gen_random_uuid())`))).toMatch(/ERR:permission denied/);
    expect(await pgCode(custody.query(`SELECT fleet.api_spend_request('a','b','k:12345678',1,'expense','dst_x','p',0)`))).toMatch(/ERR:permission denied/);
    // ... and the agent cannot reach the custody protocol.
    expect(await pgCode(agentRaw.query(`SELECT fleet.cx_claim_instruction('w', repeat('a',64))`))).toMatch(/ERR:permission denied/);
    expect(await pgCode(svc.query(`SELECT fleet.cx_report_result(gen_random_uuid(), 'l', 'settled', 'x:1234', 1, NULL)`))).toMatch(/ERR:permission denied/);
  });

  // ── Ledger integrity ─────────────────────────────────────────

  it("the ledger is written only through fleet_ledger_post and is append-only", async () => {
    await fund(100_000);
    expect(await pgCode(owner.query(
      `INSERT INTO fleet.fleet_ledger_journal (journal_id, kind, idempotency_key, actor, reason, source, occurred_at, prev_hash, entry_hash)
       VALUES (gen_random_uuid(), 'owner_funding', 'direct:12345678', 'x', 'x', 'owner', now(), repeat('0',64), repeat('1',64))`,
    ))).toBe("FLEET_LEDGER_DIRECT_WRITE");
    expect(await pgCode(owner.query(`UPDATE fleet.fleet_ledger_postings SET amount_cents = amount_cents + 1`))).toBe("FLEET_HISTORY_IMMUTABLE");
    expect(await pgCode(owner.query(`DELETE FROM fleet.fleet_ledger_journal`))).toBe("FLEET_HISTORY_IMMUTABLE");
    expect(await pgCode(owner.query(`UPDATE fleet.fleet_ledger_journal SET reason = 'x'`))).toBe("FLEET_HISTORY_IMMUTABLE");
    expect(await pgCode(owner.query(`TRUNCATE fleet.fleet_ledger_postings`))).toMatch(/FLEET_HISTORY_IMMUTABLE|ERR:.*foreign key/);
    expect(await pgCode(owner.query(`TRUNCATE fleet.fleet_ledger_journal CASCADE`))).toBe("FLEET_HISTORY_IMMUTABLE");
    expect(await pgCode(owner.query(`UPDATE fleet.fleet_ledger_head SET head_seq = head_seq + 1`))).toBe("FLEET_HISTORY_IMMUTABLE");
    expect(await pgCode(owner.query(`UPDATE fleet.fleet_ledger_accounts SET class = 'fleet_profit' WHERE account_id = 'fleet:expense'`))).toBe("FLEET_HISTORY_IMMUTABLE");
    // Opening the guard by hand does not help: an unbalanced journal cannot commit.
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('fleet.ledger_post', 'on', true)`);
      const id = crypto.randomUUID();
      await c.query(
        `INSERT INTO fleet.fleet_ledger_journal (journal_id, kind, idempotency_key, actor, reason, source, occurred_at, prev_hash, entry_hash)
         VALUES ($1, 'owner_funding', 'forged:12345678', 'x', 'x', 'owner', now(), repeat('0',64), repeat('2',64))`,
        [id],
      );
      await c.query(`INSERT INTO fleet.fleet_ledger_postings (journal_id, line, account_id, side, amount_cents) VALUES ($1, 1, 'fleet:treasury:unallocated', 'D', 999)`, [id]);
      expect(await pgCode(c.query("COMMIT"))).toBe("FLEET_LEDGER_UNBALANCED");
    } finally {
      await c.query("ROLLBACK").catch(() => {});
      c.release();
    }
    // The deferred non-negative check holds on its own: a hand-opened, balanced journal that overdraws cannot commit.
    const c3 = await owner.connect();
    try {
      await c3.query("BEGIN");
      await c3.query(`SELECT set_config('fleet.ledger_post', 'on', true)`);
      const id = crypto.randomUUID();
      await c3.query(
        `INSERT INTO fleet.fleet_ledger_journal (journal_id, kind, idempotency_key, actor, reason, source, occurred_at, prev_hash, entry_hash)
         VALUES ($1, 'fleet_expense_settlement', 'overdraw:12345678', 'x', 'x', 'owner', now(), repeat('0',64), repeat('3',64))`,
        [id],
      );
      await c3.query(`INSERT INTO fleet.fleet_ledger_postings (journal_id, line, account_id, side, amount_cents) VALUES ($1, 1, 'fleet:expense', 'D', 999999999)`, [id]);
      await c3.query(`INSERT INTO fleet.fleet_ledger_postings (journal_id, line, account_id, side, amount_cents) VALUES ($1, 2, 'fleet:treasury:unallocated', 'C', 999999999)`, [id]);
      expect(await pgCode(c3.query("COMMIT"))).toBe("FLEET_LEDGER_NEGATIVE");
    } finally {
      await c3.query("ROLLBACK").catch(() => {});
      c3.release();
    }
    // The posting function refuses an unbalanced journal immediately (before any row is written), not only at commit.
    const c4 = await owner.connect();
    try {
      await c4.query("BEGIN");
      expect(await pgCode(c4.query(`SELECT fleet.fleet_ledger_post('owner_funding', 'imm:12345678', 'operator:owner', 'x', 'owner', NULL, NULL, NULL, 'ext:imm-1', NULL, now(),
        '[{"account":"fleet:treasury:unallocated","side":"D","amount":10},{"account":"fleet:owner:capital","side":"C","amount":9}]'::jsonb)`))).toBe("FLEET_LEDGER_UNBALANCED");
    } finally {
      await c4.query("ROLLBACK").catch(() => {});
      c4.release();
    }
    // ... and an overdraft immediately, inside the statement.
    const c5 = await owner.connect();
    try {
      await c5.query("BEGIN");
      expect(await pgCode(c5.query(`SELECT fleet.fleet_ledger_post('fleet_expense_settlement', 'imm2:12345678', 'operator:owner', 'x', 'owner', NULL, NULL, NULL, 'inv:imm-2', NULL, now(),
        '[{"account":"fleet:expense","side":"D","amount":99999999999},{"account":"fleet:treasury:unallocated","side":"C","amount":99999999999}]'::jsonb)`))).toBe("FLEET_LEDGER_NEGATIVE");
    } finally {
      await c5.query("ROLLBACK").catch(() => {});
      c5.release();
    }
    // Postings cannot be appended to an existing journal later.
    const j = (await q(`SELECT journal_id FROM fleet.fleet_ledger_journal ORDER BY seq LIMIT 1`))[0].journal_id;
    const c2 = await owner.connect();
    try {
      await c2.query("BEGIN");
      await c2.query(`SELECT set_config('fleet.ledger_post', 'on', true)`);
      expect(await pgCode(c2.query(
        `INSERT INTO fleet.fleet_ledger_postings (journal_id, line, account_id, side, amount_cents) VALUES ($1, 9, 'fleet:profit', 'C', 5)`, [j],
      ))).toBe("FLEET_LEDGER_IMMUTABLE");
    } finally {
      await c2.query("ROLLBACK").catch(() => {});
      c2.release();
    }
    expect((await ledger.verify()).ok).toBe(true);
  });

  it("every journal obeys the posting grammar, balances, stays non-negative and is scoped", async () => {
    const post = (kind: string, lines: unknown[], opts: { source?: string; agent?: string | null; ext?: string | null } = {}) =>
      owner.query(`SELECT fleet.fleet_ledger_post($1, $2, 'operator:owner', 'test', $3, $4, NULL, NULL, $5, NULL, now(), $6)`, [
        kind, key("g"), opts.source ?? "owner", opts.agent ?? null, opts.ext === undefined ? `ext:${crypto.randomUUID()}` : opts.ext, JSON.stringify(lines),
      ]);
    const L = (account: string, side: string, amount: number) => ({ account, side, amount });
    // Owner funding may not reach LFC.
    expect(await pgCode(post("owner_funding", [L("fleet:treasury:unallocated", "D", 10), L("fleet:profit", "C", 10)]))).toBe("FLEET_LEDGER_RULE");
    // Valuation may never reach LFC.
    expect(await pgCode(post("asset_valuation", [L("fleet:assets", "D", 10), L("fleet:profit", "C", 10)]))).toBe("FLEET_LEDGER_RULE");
    // Unbalanced, single-line, zero, fractional and unknown accounts.
    expect(await pgCode(post("owner_funding", [L("fleet:treasury:unallocated", "D", 10), L("fleet:owner:capital", "C", 9)]))).toBe("FLEET_LEDGER_UNBALANCED");
    expect(await pgCode(post("owner_funding", [L("fleet:treasury:unallocated", "D", 10)]))).toBe("FLEET_LEDGER_INVALID");
    expect(await pgCode(post("owner_funding", [L("fleet:treasury:unallocated", "D", 0), L("fleet:owner:capital", "C", 0)]))).toBe("FLEET_LEDGER_INVALID");
    expect(await pgCode(post("owner_funding", [L("fleet:treasury:unallocated", "D", 1.5), L("fleet:owner:capital", "C", 1.5)]))).toBe("FLEET_LEDGER_INVALID");
    expect(await pgCode(post("owner_funding", [L("fleet:nope", "D", 1), L("fleet:owner:capital", "C", 1)]))).toBe("FLEET_LEDGER_INVALID");
    // External reference required for external facts; source restricted per kind.
    expect(await pgCode(post("owner_funding", [L("fleet:treasury:unallocated", "D", 1), L("fleet:owner:capital", "C", 1)], { ext: null }))).toBe("FLEET_LEDGER_INVALID");
    expect(await pgCode(post("owner_funding", [L("fleet:treasury:unallocated", "D", 1), L("fleet:owner:capital", "C", 1)], { source: "controller" }))).toBe("FLEET_LEDGER_SOURCE");
    expect(await pgCode(post("principal_advance", [L("fleet:treasury:unallocated", "D", 1), L("fleet:owner:capital", "C", 1)], { source: "executor" }))).toBe("FLEET_LEDGER_SOURCE");
    // Non-negative: the treasury cannot hand out cash it does not have.
    const [a] = agents;
    await ledger.agentCapital({ agentId: a.agentId, amountCents: 1, mode: "grant", actor: OWNER });
    const treasury = await bal("fleet:treasury:unallocated");
    expect(await pgCode(post("agent_capital_grant", [L(agentAcct(a, "cash"), "D", treasury + 1), L("fleet:treasury:unallocated", "C", treasury + 1)], { agent: a.agentId, ext: null }))).toBe("FLEET_LEDGER_NEGATIVE");
    // Scope: one agent's journal cannot touch another agent's accounts.
    const b = agents[1];
    await ledger.agentCapital({ agentId: b.agentId, amountCents: 1, mode: "grant", actor: OWNER });
    expect(await pgCode(post("agent_capital_return", [L("fleet:treasury:unallocated", "D", 1), L(agentAcct(b, "cash"), "C", 1)], { agent: a.agentId, ext: null }))).toBe("FLEET_LEDGER_SCOPE");
    expect((await ledger.verify()).ok).toBe(true);
  });

  it("journals are idempotent: the same key replays, a different journal under it is refused, external refs are unique", async () => {
    const k = key("fund");
    const ref = `bank:idem-${crypto.randomUUID()}`;
    const before = await bal("fleet:treasury:unallocated");
    const j1 = await ledger.recordOwnerFunding(500, ref, OWNER, k);
    const j2 = await ledger.recordOwnerFunding(500, ref, OWNER, k);
    expect(j2).toBe(j1);
    expect(await bal("fleet:treasury:unallocated")).toBe(before + 500);
    expect(await pgCode(ledger.recordOwnerFunding(501, ref, OWNER, k))).toBe("FLEET_LEDGER_IDEMPOTENCY_CONFLICT");
    expect(await pgCode(ledger.recordOwnerFunding(500, ref, OWNER, key("fund")))).toMatch(/ERR:.*fleet_ledger_external_ref_uq/);
  });

  it("the hash chain detects tampering done around every guard", async () => {
    const good = await ledger.verify();
    expect(good.ok).toBe(true);
    const c = await su.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      const row = (await c.query(`SELECT journal_id FROM fleet.fleet_ledger_journal ORDER BY seq LIMIT 1 OFFSET 1`)).rows[0];
      await c.query(`UPDATE fleet.fleet_ledger_postings SET amount_cents = amount_cents + 1 WHERE journal_id = $1`, [row.journal_id]);
      const bad = (await c.query(`SELECT fleet.fleet_ledger_verify() AS r`)).rows[0].r;
      expect(bad.ok).toBe(false);
      expect(bad.firstBadSeq).toBeGreaterThan(0);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
    expect((await ledger.verify()).ok).toBe(true);
  });

  it("reversals mirror the original exactly, once, and never for order journals", async () => {
    const before = await bal("fleet:treasury:unallocated");
    const j = await ledger.recordOwnerFunding(777, `bank:rev-${crypto.randomUUID()}`, OWNER);
    const r = await ledger.reverse(j, "entered twice", OWNER);
    expect(await bal("fleet:treasury:unallocated")).toBe(before);
    expect(await pgCode(ledger.reverse(j, "again", OWNER))).toMatch(/ERR:.*reverses_journal_id/);
    expect(await pgCode(ledger.reverse(r, "reverse the reversal", OWNER))).toBe("FLEET_LEDGER_INVALID");
    // A "reversal" that is not the exact mirror (here: moving the funds into LFC instead) is refused.
    const j2 = await ledger.recordOwnerFunding(300, `bank:rev-${crypto.randomUUID()}`, OWNER);
    expect(await pgCode(owner.query(`SELECT fleet.fleet_ledger_post('reversal', $1, 'operator:owner', 'x', 'owner', NULL, NULL, NULL, NULL, $2, now(), $3)`, [
      key("rv"), j2, JSON.stringify([{ account: "fleet:owner:capital", side: "D", amount: 300 }, { account: "fleet:profit", side: "C", amount: 300 }]),
    ]))).toBe("FLEET_LEDGER_INVALID");
    expect((await q(`SELECT count(*)::int AS n FROM fleet.fleet_ledger_journal WHERE journal_id IN ($1, $2)`, [j, r]))[0].n).toBe(2);
  });

  // ── Agent spend orders ───────────────────────────────────────

  it("an agent spends only its own allocation, through a structured order the database decides", async () => {
    const a = agents[2];
    await ledger.agentCapital({ agentId: a.agentId, amountCents: 3000, mode: "grant", actor: OWNER });
    const idem = key("s");
    const r = await spend(a, 1200, { idem });
    expect(r.ok).toBe(true);
    expect(order(r)).toMatchObject({ status: "reserved", decidedBy: "controller", executed: false });
    expect(await bal(agentAcct(a, "cash"))).toBe(1800);
    expect(await bal(agentAcct(a, "reserved"))).toBe(1200);
    // Replay is idempotent; the same key with different content is refused.
    const again = await spend(a, 1200, { idem });
    expect(again).toMatchObject({ ok: true, replay: true });
    expect(order(again).orderId).toBe(order(r).orderId);
    expect(await spend(a, 1300, { idem })).toMatchObject({ ok: false, code: "FLEET_IDEMPOTENCY_CONFLICT" });
    // More than the allocation: rejected, nothing reserved.
    expect(await spend(a, 5000)).toMatchObject({ ok: false, code: "FLEET_INSUFFICIENT_ALLOCATION" });
    // Owner destinations, pending/revoked/unknown destinations and other agents' payees are refused.
    expect(await spend(a, 10, { dst: ownerDst })).toMatchObject({ ok: false, code: "FLEET_DESTINATION_NOT_ALLOWED" });
    const mine = await activeDestination("payee", agents[3].agentId);
    expect(await spend(a, 10, { dst: mine })).toMatchObject({ ok: false, code: "FLEET_DESTINATION_NOT_ALLOWED" });
    const pending = await ledger.enrollDestination({ kind: "payee", rail: "evm_usdc", label: "p", reference: "x", actor: OWNER });
    expect(await spend(a, 10, { dst: pending.destinationId })).toMatchObject({ ok: false, code: "FLEET_DESTINATION_NOT_ACTIVE" });
    expect(await spend(a, 10, { dst: `dst_${"0".repeat(26)}` })).toMatchObject({ ok: false, code: "FLEET_DESTINATION_NOT_ALLOWED" });
    // Malformed requests and a wrong token.
    for (const bad of [0, -5, 100_000_000_001]) expect(await spend(a, bad)).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" });
    await expect(spend(a, 1.5)).rejects.toThrow(/bigint/);
    expect(await spend(a, 10, { category: "owner_withdrawal" })).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" });
    expect(await spend(a, 10, { recoverable: 5 })).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" }); // recoverable only for asset purchases
    expect(await gw.spendRequest(a.agentId, agents[3].token, { idempotencyKey: key(), amountCents: 1, category: "expense", destinationId: payee, purpose: "x" })).toMatchObject({ ok: false, code: "FLEET_AUTH_FAILED" });
    // Cancel releases the reservation; a cancelled order cannot be cancelled again or resurrected.
    const c = await gw.spendCancel(a.agentId, a.token, order(r).orderId as string);
    expect(order(c).status).toBe("cancelled");
    expect(await bal(agentAcct(a, "cash"))).toBe(3000);
    expect(await gw.spendCancel(a.agentId, a.token, order(r).orderId as string)).toMatchObject({ ok: false, code: "FLEET_INVALID_STATE" });
    // Another agent cannot cancel it.
    const r2 = await spend(a, 100);
    expect(await gw.spendCancel(agents[3].agentId, agents[3].token, order(r2).orderId as string)).toMatchObject({ ok: false, code: "FLEET_NOT_FOUND" });
    expect(await pgCode(owner.query(`UPDATE fleet.fleet_payment_orders SET status = 'reserved' WHERE order_id = $1`, [order(c).orderId]))).toBe("FLEET_TERMINAL_STATE_IMMUTABLE");
    expect(await pgCode(owner.query(`UPDATE fleet.fleet_payment_orders SET amount_cents = 1 WHERE order_id = $1`, [order(r2).orderId]))).toBe("FLEET_HISTORY_IMMUTABLE");
    expect(await pgCode(owner.query(`UPDATE fleet.fleet_payment_orders SET status = 'settled' WHERE order_id = $1`, [order(r2).orderId]))).toBe("FLEET_INVALID_TRANSITION");
    expect(await pgCode(owner.query(`DELETE FROM fleet.fleet_payment_orders WHERE order_id = $1`, [order(r2).orderId]))).toBe("FLEET_HISTORY_IMMUTABLE");
    // The agent's own summary reads the ledger.
    const s = await gw.ledgerSummary(a.agentId, a.token);
    expect(s.economics).toMatchObject({ cash: 2900, reserved: 100, protectedPrincipal: 0 });
  });

  it("concurrent spend requests never over-reserve an allocation", async () => {
    const a = agents[4];
    await ledger.agentCapital({ agentId: a.agentId, amountCents: 1000, mode: "grant", actor: OWNER });
    const rs = await Promise.all(Array.from({ length: 12 }, () => spend(a, 300)));
    const ok = rs.filter((r) => r.ok && order(r).status === "reserved");
    expect(ok.length).toBe(3);
    expect(rs.filter((r) => !r.ok).every((r) => r.code === "FLEET_INSUFFICIENT_ALLOCATION")).toBe(true);
    expect(await bal(agentAcct(a, "cash"))).toBe(100);
    expect(await bal(agentAcct(a, "reserved"))).toBe(900);
  });

  it("policy limits route to the owner, who may override them with an audited acknowledgement", async () => {
    const a = agents[5];
    await ledger.agentCapital({ agentId: a.agentId, amountCents: 40_000, mode: "grant", actor: OWNER });
    const r = await spend(a, 15_000); // above the 100.00 owner threshold
    expect(order(r)).toMatchObject({ status: "awaiting_owner", decisionCode: "FLEET_OWNER_APPROVAL_REQUIRED" });
    expect(await bal(agentAcct(a, "reserved"))).toBe(0);
    const id = order(r).orderId as string;
    // Warnings: the controller recommends against; it does not veto.
    const w = await ledger.spendDecision(id, "approve", OWNER);
    expect(w).toMatchObject({ status: "needs_acknowledgement", recommendation: "recommend_against" });
    expect((w.warnings as string[]).sort()).toEqual(["above_agent_daily_policy", "above_owner_threshold"]);
    const ok = await ledger.spendDecision(id, "approve", OWNER, { acknowledgeWarnings: true, note: "strategic purchase" });
    expect(ok).toMatchObject({ status: "reserved", override: true });
    expect(await bal(agentAcct(a, "reserved"))).toBe(15_000);
    const ai = await q(`SELECT kind, recommendation, override, warnings_acknowledged, status, actor FROM fleet.fleet_admin_instructions WHERE instruction_id = $1`, [ok.instructionId]);
    expect(ai[0]).toEqual({ kind: "spend_decision", recommendation: "recommend_against", override: true, warnings_acknowledged: true, status: "executed", actor: OWNER });
    // Decided once.
    expect(await pgCode(ledger.spendDecision(id, "approve", OWNER, { acknowledgeWarnings: true }))).toBe("FLEET_INVALID_STATE");
    expect(await pgCode(owner.query(`UPDATE fleet.fleet_admin_instructions SET override = false WHERE instruction_id = $1`, [ok.instructionId]))).toBe("FLEET_HISTORY_IMMUTABLE");
    // Reject path.
    const r2 = await spend(a, 12_000);
    expect(await ledger.spendDecision(order(r2).orderId as string, "reject", OWNER, { note: "no" })).toMatchObject({ status: "rejected" });
  });

  it("the owner can never override a constitutional check, and neither agents nor operator principals can approve", async () => {
    const a = agents[6];
    await ledger.agentCapital({ agentId: a.agentId, amountCents: 20_000, mode: "grant", actor: OWNER });
    const r = await spend(a, 15_000);
    const id = order(r).orderId as string;
    expect(order(r).status).toBe("awaiting_owner");
    // Drain the allocation below the order: approval is now refused even with acknowledgement.
    await owner.query(`SELECT fleet.fleet_ledger_post('agent_capital_return', $1, 'operator:owner', 'drain', 'owner', $2, NULL, NULL, NULL, NULL, now(), $3)`, [
      key("drain"), a.agentId, JSON.stringify([{ account: "fleet:treasury:unallocated", side: "D", amount: 11_000 }, { account: agentAcct(a, "cash"), side: "C", amount: 11_000 }]),
    ]);
    const refused = await ledger.spendDecision(id, "approve", OWNER, { acknowledgeWarnings: true });
    expect(refused).toMatchObject({ status: "refused", code: "FLEET_INSUFFICIENT_ALLOCATION", constitutional: true });
    // Agents and operator principals (Claude/ChatGPT) are never approvers.
    for (const actor of [`operator:${a.agentId}`, "operator:claude-operator", "claude-operator", a.agentId, "controller"]) {
      expect(await pgCode(ledger.spendDecision(id, "approve", actor, { acknowledgeWarnings: true }))).toMatch(/FLEET_SELF_APPROVAL|FLEET_APPROVAL_REQUIRED/);
    }
    // A direct status write with an agent as decider is refused by the order guard.
    expect(await pgCode(owner.query(`UPDATE fleet.fleet_payment_orders SET status = 'rejected', decided_by = $2 WHERE order_id = $1`, [id, a.agentId]))).toMatch(/FLEET_SELF_APPROVAL|FLEET_APPROVAL_REQUIRED/);
    // A held agent can neither request nor have a pending order approved, even with enough allocation.
    await ledger.agentCapital({ agentId: a.agentId, amountCents: 20_000, mode: "grant", actor: OWNER });
    const pending = order(await spend(a, 12_000)).orderId as string;
    await q(`SELECT fleet.fleet_agent_hold_set($1, 'investigation', 'operator:owner')`, [a.agentId]);
    expect(await spend(a, 1)).toMatchObject({ ok: false, code: "FLEET_AGENT_HELD" });
    expect(await ledger.spendDecision(pending, "approve", OWNER, { acknowledgeWarnings: true })).toMatchObject({ status: "refused", code: "FLEET_AGENT_HELD" });
    await q(`SELECT fleet.fleet_agent_hold_release($1, 'operator:owner')`, [a.agentId]);
    // Frozen spending is also constitutional.
    await q(`INSERT INTO fleet.fleet_wallet_custody (agent_id, wallet_address, spending_frozen, frozen_reason, frozen_at) VALUES ($1, $2, true, 'test', now())
             ON CONFLICT (agent_id) DO UPDATE SET spending_frozen = true, frozen_reason = 'test', frozen_at = now()`, [a.agentId, `0x${"1".repeat(40)}`]);
    expect(await spend(a, 1)).toMatchObject({ ok: false, code: "FLEET_SPENDING_FROZEN" });
  });

  it("protected principal: borrowed capital funds recoverable assets only, and the agent dies before principal is consumed", async () => {
    const a = agents[7];
    await ledger.agentCapital({ agentId: a.agentId, amountCents: 2000, mode: "principal", actor: OWNER });
    expect(await ledger.economics(a.agentId)).toMatchObject({ cash: 2000, protectedPrincipal: 2000, survivalEquity: 0, expensePurchasingCapacity: 0 });
    expect(await bal("fleet:treasury:principal_receivable")).toBeGreaterThanOrEqual(2000);
    // An expense would consume principal: refused even though the cash exists.
    expect(await spend(a, 1)).toMatchObject({ ok: false, code: "FLEET_PROTECTED_CAPITAL" });
    // An asset purchase whose recoverable value covers it is allowed; a partly recoverable one is not.
    expect(await spend(a, 1000, { category: "asset_acquisition", recoverable: 600 })).toMatchObject({ ok: false, code: "FLEET_PROTECTED_CAPITAL" });
    expect(order(await spend(a, 1000, { category: "asset_acquisition", recoverable: 1000 })).status).toBe("reserved");
    // With equity of its own, the agent may spend exactly its equity on expenses and no more.
    await ledger.agentCapital({ agentId: a.agentId, amountCents: 500, mode: "grant", actor: OWNER });
    expect(await spend(a, 501)).toMatchObject({ ok: false, code: "FLEET_PROTECTED_CAPITAL" });
    expect(order(await spend(a, 500)).status).toBe("reserved");
    // Reserved expense funds are committed: survival equity is now exhausted, so a second expense is refused.
    expect(await ledger.economics(a.agentId)).toMatchObject({ survivalEquity: 0, reservedRecoverable: 1000 });
    expect(await spend(a, 1)).toMatchObject({ ok: false, code: "FLEET_PROTECTED_CAPITAL" });
    // Owner obligations are protected too.
    await q(`INSERT INTO fleet.fleet_obligations (obligation_id, agent_id, description, amount_cents, due_at, approved_by) VALUES ($1, $2, 'rent', 1, now() + interval '1 day', 'operator:owner')`,
      ["01" + crypto.randomBytes(12).toString("hex").toUpperCase().replace(/[ILOU]/g, "0").slice(0, 24)].map((x) => x.slice(0, 26)).concat([a.agentId]));
    expect((await ledger.economics(a.agentId)).protectedObligations).toBe(1);
  });

  it("orders past their TTL expire through the service role and release their funds", async () => {
    const a = agents[3];
    await ledger.agentCapital({ agentId: a.agentId, amountCents: 800, mode: "grant", actor: OWNER });
    const r = await spend(a, 300);
    const c = await su.connect();
    try {
      await c.query("SET session_replication_role = replica");
      await c.query(`UPDATE fleet.fleet_payment_orders SET expires_at = now() - interval '1 second' WHERE order_id = $1`, [order(r).orderId]);
    } finally {
      await c.query("RESET session_replication_role");
      c.release();
    }
    const n = (await svc.query(`SELECT fleet.svc_expire_payment_orders(50) AS n`)).rows[0].n;
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await bal(agentAcct(a, "cash"))).toBe(800);
    expect((await q(`SELECT status, release_journal_id IS NOT NULL AS released FROM fleet.fleet_payment_orders WHERE order_id = $1`, [order(r).orderId]))[0]).toEqual({ status: "expired", released: true });
  });

  it("over HTTP, an agent submits, reads and cancels its own orders; the reaper expires stale ones; nothing executes", async () => {
    const svcStore = new PgFleetStore({ connectionString: pgc.serviceUrl });
    const service = new FleetService({
      admin: svcStore,
      agent: gw,
      realReplicationEnabled: false,
      reaperIntervalMs: 0,
      release: { ...PIN, ...BUILD },
      audit: () => {},
      terminator: new UnsupportedSandboxTerminator(),
    });
    const { url } = await service.listen(0, "127.0.0.1");
    try {
      const reg = await store.registerRoot({ walletAddress: `0x${crypto.randomBytes(20).toString("hex")}`, name: "http-agent" });
      if (!reg.ok) throw new Error(reg.reason);
      const cred = await store.issueCredential(reg.agent.agentId, "test");
      const c = new FleetApiClient({ baseUrl: url, agentId: reg.agent.agentId, token: cred.token, healthResponder: async () => ({ commit: PIN.commit, buildId: BUILD.buildId, policyOk: true }) });
      await ledger.agentCapital({ agentId: reg.agent.agentId, amountCents: 20_000, mode: "grant", actor: OWNER });
      const idem = key("http");
      const r = await c.spendOrder({ idempotencyKey: idem, amountCents: 700, category: "expense", destinationId: payee, purpose: "api credits" });
      expect(r).toMatchObject({ ok: true, executed: false, replay: false, order: { status: "reserved", amountCents: 700 } });
      expect(await c.spendOrder({ idempotencyKey: idem, amountCents: 700, category: "expense", destinationId: payee, purpose: "api credits" })).toMatchObject({ replay: true });
      expect(await c.ledger()).toMatchObject({ cash: 19_300, protectedPrincipal: 0 });
      const big = await c.spendOrder({ idempotencyKey: key("http"), amountCents: 12_000, category: "expense", destinationId: payee, purpose: "x" });
      expect(big).toMatchObject({ ok: true, order: { status: "awaiting_owner" } }); // above the owner threshold: the owner decides
      expect(await c.cancelSpendOrder(r.order!.orderId as string)).toMatchObject({ status: "cancelled" });
      await expect(c.cancelSpendOrder(r.order!.orderId as string)).rejects.toMatchObject({ status: 403, code: "FLEET_INVALID_STATE" });
      await expect(c.cancelSpendOrder(crypto.randomUUID())).rejects.toMatchObject({ status: 404 });
      // Stale orders are expired by the controller's reaper pass (service role).
      const s2 = await su.connect();
      try {
        await s2.query("SET session_replication_role = replica");
        await s2.query(`UPDATE fleet.fleet_payment_orders SET expires_at = now() - interval '1 second' WHERE order_id = $1`, [big.order!.orderId]);
      } finally {
        await s2.query("RESET session_replication_role");
        s2.release();
      }
      await service.reapOnce();
      expect((await q(`SELECT status FROM fleet.fleet_payment_orders WHERE order_id = $1`, [big.order!.orderId]))[0].status).toBe("expired");
      expect(await c.ledger()).toMatchObject({ cash: 20_000, reserved: 0 });
    } finally {
      await service.close();
      await svcStore.close();
    }
  });

  // ── Custody boundary (inert) ─────────────────────────────────

  it("custody execution is disabled: no instruction can be issued or claimed by anyone", async () => {
    const a = agents[2];
    const r = await spend(a, 50);
    expect(order(r).status).toBe("reserved");
    expect((await svc.query(`SELECT fleet.svc_issue_payment_instruction($1) AS r`, [order(r).orderId])).rows[0].r).toEqual({ ok: false, code: "FLEET_CUSTODY_EXECUTION_DISABLED" });
    expect((await custody.query(`SELECT fleet.cx_claim_instruction('executor', $1) AS r`, [sha256Hex("lease")])).rows[0].r).toEqual({ ok: false, code: "FLEET_CUSTODY_EXECUTION_DISABLED" });
    expect((await custody.query(`SELECT fleet.cx_ping() AS r`)).rows[0].r).toMatchObject({ schemaVersion: 17, executionEnabled: false, issued: 0, claimed: 0 });
    expect(await pgCode(owner.query(
      `INSERT INTO fleet.fleet_payment_instructions (instruction_id, order_id, amount_cents, destination_id, rail, instruction_sha256, issued_by)
       VALUES (gen_random_uuid(), $1, 50, $2, 'evm_usdc', repeat('a',64), 'owner')`, [order(r).orderId, payee],
    ))).toBe("FLEET_CUSTODY_EXECUTION_DISABLED");
    expect((await q(`SELECT count(*)::int AS n FROM fleet.fleet_payment_orders WHERE status IN ('executing','settled')`))[0].n).toBe(0);
  });

  it("the executor protocol (pin removed in a separate test schema) is lease-bound, exact and idempotent", async () => {
    const X = "fleet_cx";
    const xs = new PgFleetStore({ connectionString: pgc.ownerUrl, schema: X });
    const xl = new PgLedgerAdmin({ connectionString: pgc.ownerUrl, schema: X });
    const xg = new PgAgentGateway({ connectionString: pgc.agentUrl, schema: X });
    const xc = new pg.Pool({ connectionString: pgc.custodyUrl, max: 2, options: `-c search_path=${X}` });
    try {
      await xs.migrate();
      await xs.setApprovedRuntime(PIN, "test", BUILD);
      await xs.setMaxAgents(5, "test");
      const reg = await xs.registerRoot({ walletAddress: `0x${crypto.randomBytes(20).toString("hex")}`, name: "cx" });
      if (!reg.ok) throw new Error(reg.reason);
      const a = { agentId: reg.agent.agentId, token: (await xs.issueCredential(reg.agent.agentId, "t")).token };
      // Test-only constitutional change (the production path would be a reviewed migration).
      const cname = (await owner.query(`SELECT conname FROM pg_constraint WHERE conrelid = '${X}.fleet_economic_model'::regclass AND pg_get_constraintdef(oid) ~ 'NOT custody_execution_enabled'`)).rows[0].conname;
      expect((await ledgerSurfaceProblems(owner, X))).toEqual([]);
      await owner.query(`ALTER TABLE ${X}.fleet_economic_model DROP CONSTRAINT ${cname}`);
      expect(await ledgerSurfaceProblems(owner, X)).toContain("custody surface: custody execution is not pinned off by a CHECK constraint (constitutional invariant)");
      await owner.query(`UPDATE ${X}.fleet_economic_model SET custody_execution_enabled = true`);
      await xl.recordOwnerFunding(10_000, "bank:cx-1", OWNER);
      await xl.agentCapital({ agentId: a.agentId, amountCents: 5000, mode: "grant", actor: OWNER });
      const e = await xl.enrollDestination({ kind: "payee", rail: "evm_usdc", label: "vendor", reference: "0xabc", actor: OWNER });
      const su2 = await su.connect();
      await su2.query("SET session_replication_role = replica");
      await su2.query(`UPDATE ${X}.fleet_payment_destinations SET activatable_at = now() - interval '1 second', enrolled_at = now() - interval '4 days'`);
      su2.release();
      await xl.activateDestination(e.destinationId, e.activationCode, OWNER);
      const s1 = await xg.spendRequest(a.agentId, a.token, { idempotencyKey: key(), amountCents: 700, category: "expense", destinationId: e.destinationId, purpose: "api" });
      const s2 = await xg.spendRequest(a.agentId, a.token, { idempotencyKey: key(), amountCents: 400, category: "asset_acquisition", destinationId: e.destinationId, purpose: "domain", recoverableCents: 100 });
      const xsvc = new pg.Pool({ connectionString: pgc.serviceUrl, max: 1, options: `-c search_path=${X}` });
      for (const o of [s1, s2]) expect((await xsvc.query(`SELECT ${X}.svc_issue_payment_instruction($1) AS r`, [order(o).orderId])).rows[0].r.ok).toBe(true);
      expect((await xsvc.query(`SELECT ${X}.svc_issue_payment_instruction($1) AS r`, [order(s1).orderId])).rows[0].r).toEqual({ ok: false, code: "FLEET_INVALID_STATE" });
      await xsvc.end();
      const claim = async (lease: string) => (await xc.query(`SELECT ${X}.cx_claim_instruction('exec-1', $1) AS r`, [sha256Hex(lease)])).rows[0].r;
      const report = async (id: string, lease: string, outcome: string, ref: string | null, amt: number | null) =>
        (await xc.query(`SELECT ${X}.cx_report_result($1, $2, $3, $4, $5, $6) AS r`, [id, lease, outcome, ref, amt, outcome === "failed" ? "provider_down" : null])).rows[0].r;
      const i1 = (await claim("lease-1")).instruction;
      expect(i1).toMatchObject({ amountCents: 700, rail: "evm_usdc", referenceSha256: sha256Hex("0xabc") });
      expect(await report(i1.instructionId, "wrong-lease", "settled", "tx:0001", 700)).toEqual({ ok: false, code: "FLEET_LEASE_INVALID" });
      expect(await report(i1.instructionId, "lease-1", "settled", "tx:0001", 701)).toEqual({ ok: false, code: "FLEET_SETTLEMENT_MISMATCH" });
      expect(await report(i1.instructionId, "lease-1", "settled", null, 700)).toEqual({ ok: false, code: "FLEET_SETTLEMENT_MISMATCH" });
      expect((await report(i1.instructionId, "lease-1", "settled", "tx:0001", 700)).status).toBe("settled");
      expect(await report(i1.instructionId, "lease-1", "settled", "tx:0001", 700)).toMatchObject({ ok: true, replay: true });
      expect(await report(i1.instructionId, "lease-1", "failed", "tx:0002", null)).toEqual({ ok: false, code: "FLEET_ALREADY_FINISHED" });
      const i2 = (await claim("lease-2")).instruction;
      expect((await claim("lease-3")).instruction).toBeNull();
      expect((await report(i2.instructionId, "lease-2", "failed", null, null)).status).toBe("failed");
      const ec = await xl.economics(a.agentId);
      expect(ec).toMatchObject({ cash: 5000 - 700, reserved: 0, realizedNetProfit: -700 });
      expect((await owner.query(`SELECT count(*)::int AS n FROM ${X}.fleet_assets`)).rows[0].n).toBe(0); // the failed purchase created no asset
      expect((await xl.verify()).ok).toBe(true);
      // Revenue, LFC and the realized-profit cap.
      await xl.recordRevenue(a.agentId, 2000, "stripe:po_1", "customer:one", OWNER);
      expect((await xl.economics(a.agentId)).uncontributedProfit).toBe(1300);
      expect(await pgCode(xl.contribute(a.agentId, 1301, OWNER))).toBe("FLEET_LFC_EXCEEDS_REALIZED_PROFIT");
      await xl.contribute(a.agentId, 1300, OWNER);
      expect(await xl.lifetimeFleetContribution()).toBe(1300);
      expect(await pgCode(xl.contribute(a.agentId, 1, OWNER))).toBe("FLEET_LFC_EXCEEDS_REALIZED_PROFIT");
    } finally {
      await xc.end();
      await xg.close();
      await xl.close();
      await xs.close();
    }
  });

  // ── LFC ──────────────────────────────────────────────────────

  it("LFC counts only realized net profit contributions: never owner funding, principal, transfers or valuation", async () => {
    const lfc0 = await ledger.lifetimeFleetContribution();
    await fund(10_000);
    const a = agents[1];
    await ledger.agentCapital({ agentId: a.agentId, amountCents: 1000, mode: "grant", actor: OWNER });
    await ledger.agentCapital({ agentId: a.agentId, amountCents: 1000, mode: "principal", actor: OWNER });
    expect(await ledger.lifetimeFleetContribution()).toBe(lfc0);
    // Capital is not profit: nothing to contribute.
    expect(await pgCode(ledger.contribute(a.agentId, 1, OWNER))).toBe("FLEET_LFC_EXCEEDS_REALIZED_PROFIT");
    await ledger.recordRevenue(a.agentId, 400, `pay:${crypto.randomUUID()}`, "customer:two", OWNER);
    await ledger.contribute(a.agentId, 400, OWNER);
    expect(await ledger.lifetimeFleetContribution()).toBe(lfc0 + 400);
    expect(await bal(agentAcct(a, "contributions"))).toBe(400);
  });

  it("a contribution can never breach protected principal", async () => {
    const reg = await store.registerRoot({ walletAddress: `0x${crypto.randomBytes(20).toString("hex")}`, name: "lfc-principal" });
    if (!reg.ok) throw new Error(reg.reason);
    const id = reg.agent.agentId;
    await ledger.agentCapital({ agentId: id, amountCents: 1000, mode: "principal", actor: OWNER });
    await ledger.recordRevenue(id, 300, `pay:${crypto.randomUUID()}`, "customer:three", OWNER);
    // Realized profit 300, survival equity 300: the full 300 may go, not more.
    await ledger.contribute(id, 300, OWNER);
    expect((await ledger.economics(id)).survivalEquity).toBe(0);
  });

  // ── Destinations and owner withdrawals ───────────────────────

  it("destinations need enrollment, a cooldown and the one-time code, and never change afterwards", async () => {
    const e = await ledger.enrollDestination({ kind: "owner", rail: "bank_transfer", label: "owner bank", reference: "DE00 SECRET", hint: "****00", actor: OWNER });
    const row = (await q(`SELECT * FROM fleet.fleet_payment_destinations WHERE destination_id = $1`, [e.destinationId]))[0];
    expect(JSON.stringify(row)).not.toContain("SECRET");
    expect(JSON.stringify(row)).not.toContain(e.activationCode);
    expect(row.reference_sha256).toBe(sha256Hex("DE00 SECRET"));
    expect(await pgCode(ledger.activateDestination(e.destinationId, e.activationCode, OWNER))).toBe("FLEET_DESTINATION_COOLDOWN");
    await pastCooldown(e.destinationId);
    expect(await pgCode(ledger.activateDestination(e.destinationId, "wrong", OWNER))).toBe("FLEET_STRONG_AUTH_FAILED");
    expect(await pgCode(ledger.activateDestination(e.destinationId, e.activationCode, "operator:claude-operator"))).toBe("FLEET_SELF_APPROVAL");
    await ledger.activateDestination(e.destinationId, e.activationCode, OWNER);
    expect(await pgCode(owner.query(`UPDATE fleet.fleet_payment_destinations SET reference_sha256 = repeat('b',64) WHERE destination_id = $1`, [e.destinationId]))).toBe("FLEET_HISTORY_IMMUTABLE");
    expect(await pgCode(owner.query(`INSERT INTO fleet.fleet_payment_destinations (destination_id, kind, rail, label, reference_sha256, enrolled_by, activatable_at, activation_code_sha256, status)
      VALUES ('dst_${"1".repeat(26)}', 'owner', 'bank_transfer', 'x', repeat('a',64), 'operator:owner', now() + interval '1 day', repeat('a',64), 'active')`))).toBe("FLEET_DESTINATION_INVALID");
    await ledger.revokeDestination(e.destinationId, "rotated", OWNER);
    expect(await pgCode(owner.query(`UPDATE fleet.fleet_payment_destinations SET status = 'active' WHERE destination_id = $1`, [e.destinationId]))).toBe("FLEET_HISTORY_IMMUTABLE");
    expect(await pgCode(ledger.ownerWithdrawal({ amountCents: 100, destinationId: e.destinationId, actor: OWNER }))).toBe("OK");
    expect(await ledger.ownerWithdrawal({ amountCents: 100, destinationId: e.destinationId, actor: OWNER })).toMatchObject({ status: "refused", code: "FLEET_DESTINATION_NOT_ACTIVE" });
  });

  it("owner withdrawals: hard limits refuse, warnings need acknowledgement, large ones need a second confirmation, nothing executes", async () => {
    expect(await ledger.ownerWithdrawal({ amountCents: 100, destinationId: payee, actor: OWNER })).toMatchObject({ status: "refused", code: "FLEET_DESTINATION_NOT_ALLOWED" });
    const avail = await bal("fleet:treasury:unallocated");
    expect(await ledger.ownerWithdrawal({ amountCents: avail + 1, destinationId: ownerDst, actor: OWNER })).toMatchObject({ status: "refused", code: "FLEET_INSUFFICIENT_TREASURY" });
    const small = await ledger.ownerWithdrawal({ amountCents: 1000, destinationId: ownerDst, actor: OWNER });
    expect(small).toMatchObject({ status: "reserved", executed: false });
    expect(await bal("fleet:custody:withdrawal_clearing")).toBe(1000);
    // Above the strong-auth threshold: two steps.
    await fund(200_000);
    const big = await ledger.ownerWithdrawal({ amountCents: 60_000, destinationId: ownerDst, actor: OWNER });
    expect(big.status).toBe("pending_confirmation");
    expect(big.confirmationCode).toMatch(/^[A-Za-z0-9_-]{20}$/);
    const stored = (await q(`SELECT * FROM fleet.fleet_admin_instructions WHERE instruction_id = $1`, [big.instructionId]))[0];
    expect(JSON.stringify(stored)).not.toContain(big.confirmationCode!);
    expect(await pgCode(ledger.confirm(big.instructionId as string, "wrong", OWNER))).toBe("FLEET_STRONG_AUTH_FAILED");
    expect(await pgCode(ledger.confirm(big.instructionId as string, big.confirmationCode!, "operator:someone-else"))).toBe("FLEET_APPROVAL_REQUIRED");
    const done = await ledger.confirm(big.instructionId as string, big.confirmationCode!, OWNER);
    expect(done).toMatchObject({ status: "reserved", executed: false });
    expect(await pgCode(ledger.confirm(big.instructionId as string, big.confirmationCode!, OWNER))).toBe("FLEET_INVALID_STATE");
    // Reserve-target warning: with expenses on record, a withdrawal that dips below the target needs acknowledgement.
    await q(`UPDATE fleet.fleet_treasury_policy SET reserve_target_months = 36 WHERE id = 1`);
    await ledger.recordOwnerFunding(1, `bank:tiny-${crypto.randomUUID()}`, OWNER);
    const c = await owner.connect();
    try {
      // Record a fleet expense so the reserve target is non-zero (test-only kind via the owner posting function).
      await c.query(`SELECT fleet.fleet_ledger_post('fleet_expense_settlement', $1, 'operator:owner', 'hosting', 'owner', NULL, NULL, NULL, $2, NULL, now(),
        '[{"account":"fleet:expense","side":"D","amount":10000},{"account":"fleet:treasury:unallocated","side":"C","amount":10000}]'::jsonb)`, [key("exp"), `inv:${crypto.randomUUID()}`]);
    } finally {
      c.release();
    }
    const warn = await ledger.ownerWithdrawal({ amountCents: 1000, destinationId: ownerDst, actor: OWNER });
    expect(warn).toMatchObject({ status: "needs_acknowledgement", recommendation: "recommend_against" });
    expect(await ledger.ownerWithdrawal({ amountCents: 1000, destinationId: ownerDst, actor: OWNER, acknowledgeWarnings: true })).toMatchObject({ status: "reserved" });
    await q(`UPDATE fleet.fleet_treasury_policy SET reserve_target_months = 3 WHERE id = 1`);
    // Operator principals and agents cannot instruct withdrawals.
    expect(await pgCode(ledger.ownerWithdrawal({ amountCents: 10, destinationId: ownerDst, actor: "operator:claude-operator" }))).toBe("FLEET_SELF_APPROVAL");
    expect(await pgCode(ledger.ownerWithdrawal({ amountCents: 10, destinationId: ownerDst, actor: `operator:${agents[0].agentId}` }))).toBe("FLEET_SELF_APPROVAL");
    expect((await q(`SELECT count(*)::int AS n FROM fleet.fleet_payment_orders WHERE order_type = 'owner_withdrawal' AND status IN ('executing','settled')`))[0].n).toBe(0);
    expect(await bal("fleet:owner:withdrawals")).toBe(0);
  });

  // ── Estates ──────────────────────────────────────────────────

  it("an estate recovers principal, writes off the rest, returns cash and assets, and orphans nothing", async () => {
    const a = agents[7]; // principal 2000, equity grant 500, reserved asset purchase 1000 + expense 500
    expect(await pgCode(ledger.estateOpen(a.agentId, OWNER))).toBe("FLEET_ESTATE_INVALID"); // living agents have no estate
    // Give it a held asset under its authority (as if a purchase settled earlier).
    const assetId = crypto.randomUUID();
    await q(`INSERT INTO fleet.fleet_assets (asset_id, asset_class, description, custody_owner, economic_owner_account, authority_agent_id, acquisition_basis_cents, recoverable_cents, created_by)
             VALUES ($1, 'domain', 'example.com', 'fleet_treasury', $2, $3, 0, 0, 'test')`, [assetId, agentAcct(a, "assets"), a.agentId]);
    expect(await pgCode(q(`INSERT INTO fleet.fleet_assets (asset_id, asset_class, description, custody_owner, economic_owner_account, authority_agent_id, acquisition_basis_cents, created_by)
             VALUES (gen_random_uuid(), 'domain', 'x', 'fleet_treasury', 'fleet:profit', NULL, 0, 'test')`))).toBe("FLEET_ASSET_INVALID");
    expect(await pgCode(q(`DELETE FROM fleet.fleet_assets WHERE asset_id = $1`, [assetId]))).toBe("FLEET_HISTORY_IMMUTABLE");
    await store.markDead(a.agentId, "test death", "test", "reported");
    expect((await ledger.estateAttention()).assetsUnderDeadAgents).toBeGreaterThanOrEqual(1);
    // Schema v11: economic death froze the estate in the same transaction (orders cancelled by the lifecycle).
    expect((await q(`SELECT count(*)::int AS n FROM fleet.fleet_payment_orders WHERE agent_id = $1 AND status = 'cancelled' AND decision_code = 'FLEET_ESTATE_FREEZE'`, [a.agentId]))[0].n).toBe(2);
    const opened = await ledger.estateOpen(a.agentId, OWNER);
    expect(opened.ordersCancelled).toBe(0);
    expect(await bal(agentAcct(a, "reserved"))).toBe(0);
    const treasury0 = await bal("fleet:treasury:unallocated");
    const s = await ledger.estateSettle(a.agentId, OWNER);
    expect(s).toMatchObject({ status: "settled", principalRecovered: 2000, principalWrittenOff: 0, cashToTreasury: 500 });
    expect(await bal("fleet:treasury:unallocated")).toBe(treasury0 + 2500);
    for (const cls of ["cash", "reserved", "assets", "principal"]) expect(await bal(agentAcct(a, cls))).toBe(0);
    const asset = (await q(`SELECT economic_owner_account, authority_agent_id FROM fleet.fleet_assets WHERE asset_id = $1`, [assetId]))[0];
    expect(asset).toEqual({ economic_owner_account: "fleet:assets", authority_agent_id: null });
    expect(await ledger.estateAttention()).toEqual({ assetsUnderDeadAgents: 0, deadAgentsWithBalances: 0, assetsWithoutOwner: 0 });
    expect(await pgCode(ledger.estateSettle(a.agentId, OWNER))).toBe("FLEET_ESTATE_INVALID");
    // A dead agent cannot spend.
    expect(await spend(a, 1)).toMatchObject({ ok: false, code: "FLEET_AGENT_DEAD" });
    expect((await ledger.verify()).ok).toBe(true);
  });

  it("an estate with insufficient cash writes off the unrecoverable principal", async () => {
    const reg = await store.registerRoot({ walletAddress: `0x${crypto.randomBytes(20).toString("hex")}`, name: "estate-writeoff" });
    if (!reg.ok) throw new Error(reg.reason);
    const id = reg.agent.agentId;
    await ledger.agentCapital({ agentId: id, amountCents: 1000, mode: "principal", actor: OWNER });
    // Simulate a loss already realized (owner-recorded fee settlement is executor/owner-only kind spend_settlement via an order;
    // here use an agent_capital_return to model cash moved back without principal repayment).
    await owner.query(`SELECT fleet.fleet_ledger_post('agent_capital_return', $1, 'operator:owner', 'loss model', 'owner', $2, NULL, NULL, NULL, NULL, now(), $3)`, [
      key("ret"), id, JSON.stringify([{ account: "fleet:treasury:unallocated", side: "D", amount: 600 }, { account: `agent:${id}:cash`, side: "C", amount: 600 }]),
    ]);
    await store.markDead(id, "t", "test", "reported");
    await ledger.estateOpen(id, OWNER);
    expect(await ledger.estateSettle(id, OWNER)).toMatchObject({ principalRecovered: 400, principalWrittenOff: 600 });
    expect(await bal(`agent:${id}:principal`)).toBe(0);
  });

  // ── Legacy supersession ──────────────────────────────────────

  it("legacy economics are frozen with digests; the legacy spend path is superseded", async () => {
    const a = agents[0];
    const legacy = await gw.requestSpend(a.agentId, a.token, { requestId: "01" + "A".repeat(24), fromWallet: "0x" + "1".repeat(40), toAddress: "0x" + "2".repeat(40), amountCents: 1, purpose: "x", allocationId: null });
    expect(legacy).toMatchObject({ ok: false, code: "FLEET_LEGACY_SUPERSEDED" });
    for (const sql of [
      `INSERT INTO fleet.fleet_agent_ledger (agent_id, kind, amount_cents, source, recorded_by) VALUES ('${a.agentId}', 'revenue', 1, 'operator', 'x')`,
      `INSERT INTO fleet.fleet_balance_observations (agent_id, cash_cents, source) VALUES ('${a.agentId}', 1, 'operator')`,
      `INSERT INTO fleet.fleet_treasury_ledger (kind, amount_cents, status, recorded_by) VALUES ('owner_funding_in', 1, 'recorded', 'x')`,
    ]) expect(await pgCode(owner.query(sql))).toBe("FLEET_LEGACY_SUPERSEDED");
    const d = await ledger.legacyDigests();
    expect(d.map((x) => x.table)).toEqual([
      "fleet_agent_ledger", "fleet_balance_observations", "fleet_custody_transfers", "fleet_owner_distributions", "fleet_spend_requests", "fleet_sweep_plans", "fleet_treasury_ledger",
    ]);
    expect(await pgCode(owner.query(`DELETE FROM fleet.fleet_legacy_economics`))).toBe("FLEET_HISTORY_IMMUTABLE");
  });

  // ── Static audit mutations ───────────────────────────────────

  it("the privilege audit detects ledger / custody surface mutations", async () => {
    const X = "fleet_mut";
    const xs = new PgFleetStore({ connectionString: pgc.ownerUrl, schema: X });
    try {
      await xs.migrate();
      expect(await ledgerSurfaceProblems(owner, X)).toEqual([]);
      const mutate = async (sql: string, expected: RegExp, undo: string) => {
        await owner.query(sql);
        try {
          const p = await ledgerSurfaceProblems(owner, X);
          expect(p.some((x) => expected.test(x)), `${sql}\n${p.join("\n")}`).toBe(true);
        } finally {
          await owner.query(undo);
        }
      };
      await mutate(
        `CREATE FUNCTION ${X}.fleet_sneaky() RETURNS void LANGUAGE sql AS $$ DELETE FROM ${X}.fleet_ledger_postings $$`,
        /fleet_sneaky writes fleet_ledger_postings/, `DROP FUNCTION ${X}.fleet_sneaky()`,
      );
      await mutate(
        `CREATE FUNCTION ${X}.fleet_opener() RETURNS void LANGUAGE sql AS $$ SELECT set_config('fleet.ledger_post', 'on', true) $$`,
        /fleet_opener references a ledger write guard/, `DROP FUNCTION ${X}.fleet_opener()`,
      );
      await mutate(
        `CREATE FUNCTION ${X}.cx_sign(p text) RETURNS text LANGUAGE sql AS $$ SELECT p $$`,
        /custody surface: unexpected function/, `DROP FUNCTION ${X}.cx_sign(text)`,
      );
      await mutate(`ALTER TABLE ${X}.fleet_ledger_postings DISABLE TRIGGER fleet_ledger_postings_rules`, /fleet_ledger_postings_rules is missing or disabled/,
        `ALTER TABLE ${X}.fleet_ledger_postings ENABLE TRIGGER fleet_ledger_postings_rules`);
      await mutate(`ALTER TABLE ${X}.fleet_payment_instructions DISABLE TRIGGER fleet_instructions_guard`, /fleet_instructions_guard is missing or disabled/,
        `ALTER TABLE ${X}.fleet_payment_instructions ENABLE TRIGGER fleet_instructions_guard`);
      // A cx_ function that writes the order table directly (outside its allow-list).
      const src = (await owner.query(`SELECT pg_get_functiondef('${X}.cx_claim_instruction(text,text)'::regprocedure) AS d`)).rows[0].d as string;
      await mutate(
        src.replace("RETURN jsonb_build_object('ok', true, 'instruction', NULL);", `UPDATE ${X}.fleet_payment_orders SET status = 'executing' WHERE false; RETURN jsonb_build_object('ok', true, 'instruction', NULL);`),
        /cx_claim_instruction writes fleet_payment_orders/, src,
      );
      // Granting the posting function to the agent role is caught by the role audit.
      await owner.query(`GRANT EXECUTE ON FUNCTION ${X}.fleet_ledger_post(text, text, text, text, text, text, uuid, text, text, uuid, timestamptz, jsonb) TO fleet_agent`);
      try {
        const audit = await auditPrivileges(owner, { schema: X });
        expect(audit.problems.some((p) => /fleet_agent can EXECUTE .*fleet_ledger_post/.test(p))).toBe(true);
      } finally {
        await owner.query(`REVOKE EXECUTE ON FUNCTION ${X}.fleet_ledger_post(text, text, text, text, text, text, uuid, text, text, uuid, timestamptz, jsonb) FROM fleet_agent`);
      }
    } finally {
      await xs.close();
    }
  });

  it("the whole ledger still verifies and balances at the end", async () => {
    const v = await ledger.verify();
    expect(v).toMatchObject({ ok: true, unbalanced: 0 });
    const rows = await ledger.balances();
    // Accounting identity over normal-side balances: assets + expenses + contra-equity = liabilities + equity + revenue.
    const cls = new Map((await q(`SELECT class, kind, normal_side FROM fleet.fleet_ledger_classes`)).map((c) => [c.class, c]));
    let d = 0;
    let c = 0;
    for (const r of rows) (cls.get(r.class).normal_side === "D" ? (d += r.balanceCents) : (c += r.balanceCents));
    expect(d).toBe(c);
  });
});

describe.skipIf(!PG_BIN)("schema v9 -> v10 on a production-shaped v9 registry", () => {
  it("is exact and atomic, keeps every legacy row with a matching digest, freezes them, and starts inert", async () => {
    const pgc = await startEphemeralPg(PG_BIN!);
    const owner = new pg.Pool({ connectionString: pgc.ownerUrl, max: 2 });
    const store = new PgFleetStore({ connectionString: pgc.ownerUrl });
    try {
      await migrateUpTo(pgc.ownerUrl, "fleet", 9);
      const id = "01" + "ABCDEFGHJKMNPQRSTVWXYZ0123".slice(0, 24);
      await owner.query(`UPDATE fleet.fleet_state SET max_agents = 2, runtime_repo = $1, runtime_commit = $2, runtime_build_id = $3, runtime_lockfile_sha256 = $4`, [PIN.repo, PIN.commit, BUILD.buildId, BUILD.lockfileSha256]);
      await owner.query(`INSERT INTO fleet.fleet_agents (agent_id, role, generation, name, wallet_address, status, requested_by, last_heartbeat) VALUES ($1, 'root', 0, 'r', $2, 'active', 't', now())`, [id, `0x${"a".repeat(40)}`]);
      await owner.query(`INSERT INTO fleet.fleet_agent_ledger (agent_id, kind, amount_cents, source, recorded_by) VALUES ($1, 'revenue', 500, 'operator', 'operator:x'), ($1, 'direct_cost', 100, 'operator', 'operator:x')`, [id]);
      await owner.query(`INSERT INTO fleet.fleet_treasury_ledger (kind, amount_cents, status, recorded_by) VALUES ('owner_funding_in', 1000, 'recorded', 'operator:x')`);
      const legacyBefore = (await owner.query(`SELECT string_agg(row_to_json(x)::text, E'\\n' ORDER BY x.entry_id) AS s, count(*)::int AS n FROM fleet.fleet_agent_ledger x`)).rows[0];
      const eventsBefore = (await owner.query(`SELECT count(*)::int AS n FROM fleet.fleet_events`)).rows[0].n;
      expect(await store.migrateCheck()).toEqual({ currentVersion: 9, resultingVersion: 17, wouldApply: [10, 11, 12, 13, 14, 15, 16, 17] });
      expect((await owner.query(`SELECT to_regclass('fleet.fleet_ledger_journal') AS r`)).rows[0].r).toBeNull(); // rolled back
      expect(await store.migrate()).toEqual([10, 11, 12, 13, 14, 15, 16, 17]);
      expect(await store.migrate()).toEqual([]);
      const digest = (await owner.query(`SELECT row_count, rows_sha256 FROM fleet.fleet_legacy_economics WHERE table_name = 'fleet_agent_ledger'`)).rows[0];
      expect(Number(digest.row_count)).toBe(legacyBefore.n);
      expect(digest.rows_sha256).toBe(crypto.createHash("sha256").update(legacyBefore.s, "utf8").digest("hex"));
      expect((await owner.query(`SELECT count(*)::int AS n FROM fleet.fleet_agent_ledger`)).rows[0].n).toBe(2);
      expect((await owner.query(`SELECT count(*)::int AS n FROM fleet.fleet_treasury_ledger`)).rows[0].n).toBe(1);
      expect(await pgCode(owner.query(`INSERT INTO fleet.fleet_agent_ledger (agent_id, kind, amount_cents, source, recorded_by) VALUES ($1, 'revenue', 1, 'operator', 'x')`, [id]))).toBe("FLEET_LEGACY_SUPERSEDED");
      expect((await owner.query(`SELECT count(*)::int AS n FROM fleet.fleet_events`)).rows[0].n).toBeGreaterThanOrEqual(eventsBefore);
      const l = new PgLedgerAdmin({ connectionString: pgc.ownerUrl });
      try {
        expect(await l.verify()).toMatchObject({ ok: true, journals: 0 });
        expect(await l.model()).toMatchObject({ custodyExecutionEnabled: false, ledgerAuthoritative: true });
        expect((await l.balances()).every((b) => b.balanceCents === 0)).toBe(true); // no opening balances are invented
      } finally {
        await l.close();
      }
      expect((await store.auditPrivileges()).problems).toEqual([]);
      expect((await store.getState()).maxAgents).toBe(2);
    } finally {
      await store.close();
      await owner.end();
      pgc.stop();
    }
  }, 120_000);
});

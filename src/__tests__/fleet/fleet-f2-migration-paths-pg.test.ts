/**
 * F2 migration paths (PostgreSQL): every candidate step applied on its own — v25 → v26 → v27 → v28 → v29 → v30 — on a
 * registry seeded at v25 the way production holds Founder 1 (a Genesis founder with its allocation, inference charges,
 * owner requests including the Gumroad one, a legacy owner-route order), and direct upgrades from older supported
 * baselines (v8, v24) to the current schema.
 *
 * At every step: nothing is lost (agents, identity columns, ledger journals and balances, the hash-chain head),
 * no journal is posted by a migration, the ledger verifies; at the end the privilege audit is clean and the founder
 * can use the economy API. Re-running migrate is a no-op.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { PgFleetStore, hashAgentToken, mintAgentToken } from "../../fleet/postgres/store.js";
import { PgAgentGateway } from "../../fleet/postgres/agent-gateway.js";
import { PgLedgerAdmin } from "../../fleet/treasury/ledger.js";
import { PgGenesisAdmin } from "../../fleet/genesis/admin.js";
import { simulateRuntimeAttestation } from "../../fleet/genesis/simulate.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";
import { findPgBin, startEphemeralPg, type EphemeralPg } from "./fixtures/ephemeral-pg.js";
import { migrateUpTo } from "./fixtures/migrate-to.js";
import { wipeRegistry } from "./fixtures/wipe.js";

const PG_BIN = findPgBin();
const OWNER = "operator:owner";

describe.skipIf(!PG_BIN)("F2 migration paths: v25 → v30 step by step on a Founder-1-shaped registry; direct upgrades from v8 and v24", () => {
  let pgc: EphemeralPg;
  let owner: pg.Pool;
  let F = { id: "", token: "" };
  const q = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;
  const version = async () => Number((await q(`SELECT max(version) AS v FROM fleet.fleet_schema_migrations`))[0].v);
  /** Everything a migration must never change. */
  const fingerprint = async () => ({
    agents: await q(`SELECT agent_id, status, origin, genesis_id, lineage_root, capability_manifest_id, workspace_id, state_namespace, wallet_address FROM fleet.fleet_agents ORDER BY agent_id`),
    journals: (await q(`SELECT count(*)::int AS n FROM fleet.fleet_ledger_journal`))[0].n,
    head: (await q(`SELECT head_seq, head_hash FROM fleet.fleet_ledger_head`))[0],
    balances: await q(`SELECT account_id, fleet.fleet_ledger_balance(account_id)::bigint AS b FROM fleet.fleet_ledger_accounts WHERE class IN
      ('agent_cash','agent_reserved','agent_expense','agent_revenue','treasury_cash','owner_capital') ORDER BY account_id`),
    cognition: (await q(`SELECT count(*)::int AS n, COALESCE(sum(charged_cents), 0)::bigint AS c FROM fleet.fleet_cognition_log`))[0],
    requests: (await q(`SELECT count(*)::int AS n FROM fleet.fleet_owner_requests`))[0].n,
    orders: (await q(`SELECT count(*)::int AS n FROM fleet.fleet_payment_orders`))[0].n,
  });

  beforeAll(async () => {
    pgc = await startEphemeralPg(PG_BIN!);
    owner = new pg.Pool({ connectionString: pgc.ownerUrl, max: 4 });
    await migrateUpTo(pgc.ownerUrl, "fleet", 25);
    const c = await owner.connect();
    try { await c.query("BEGIN"); await wipeRegistry(c, "fleet"); await c.query("COMMIT"); } finally { c.release(); }
    const ledger = new PgLedgerAdmin({ connectionString: pgc.ownerUrl });
    const genesis = new PgGenesisAdmin({ connectionString: pgc.ownerUrl });
    try {
      await q(`UPDATE fleet.fleet_state SET max_agents = 2, runtime_repo = $1, runtime_commit = $2, runtime_build_id = $3, runtime_lockfile_sha256 = $4`,
        ["https://github.com/5l4mm3r/automaton-fleet", "c".repeat(40), "d".repeat(64), "e".repeat(64)]);
      await genesis.setEnabled(true, OWNER, "test");
      await ledger.recordOwnerFunding(20_000, `bank:${crypto.randomUUID()}`, OWNER);
      const g = await genesis.propose({ idempotencyKey: `g:${crypto.randomUUID()}`, founderCount: 1, allocationCents: 10_000, ttlS: 3600, actor: OWNER });
      await genesis.approve(g.genesisId, g.authSha256, OWNER);
      const p = await genesis.provision(g.genesisId, OWNER);
      for (const id of p.founderIds!) await genesis.attest(g.genesisId, id, (await simulateRuntimeAttestation(genesis, genesis, g.genesisId, id, OWNER)).host, OWNER);
      await genesis.fund(g.genesisId, OWNER);
      F = { id: p.founderIds![0], token: mintAgentToken(p.founderIds![0]) };
      await genesis.activateWithHashes(g.genesisId, g.authSha256, [hashAgentToken(F.token)], OWNER);
      // Founder 1's history: inference charges (ledger journals), owner requests (incl. an identity one), a legacy owner-route order.
      for (let i = 0; i < 3; i++) {
        await q(`SELECT fleet.fleet_ledger_post('inference_charge', $1, 'controller', 'founder inference', 'controller', $2, NULL, NULL, NULL, NULL, now(),
          jsonb_build_array(jsonb_build_object('account', fleet.fleet_ledger_account($2, 'agent_expense'), 'side', 'D', 'amount', 271),
                            jsonb_build_object('account', fleet.fleet_ledger_account($2, 'agent_cash'), 'side', 'C', 'amount', 271)))`, [`infer:${crypto.randomUUID()}`, F.id]);
      }
      await q(`SELECT fleet.api_owner_request_create($1, $2, $3, 'account_or_identity', 'g1', 'Open a Gumroad seller account', 'needs KYC', true)`, [F.id, F.token, `own:${crypto.randomUUID()}`]);
      await q(`SELECT fleet.api_owner_request_create($1, $2, $3, 'sales_channel', 'g1', 'Enable a channel', 'detail', true)`, [F.id, F.token, `own:${crypto.randomUUID()}`]);
    } finally { await genesis.close(); await ledger.close(); }
  }, 240_000);
  afterAll(async () => { await owner?.end(); pgc?.stop(); });

  it("each step v26 … current applies alone, loses nothing, posts no journal and keeps the ledger verifiable", async () => {
    const base = await fingerprint();
    expect(await version()).toBe(25);
    for (let v = 26; v <= FLEET_PG_SCHEMA_VERSION; v++) {
      await migrateUpTo(pgc.ownerUrl, "fleet", v);
      expect(await version()).toBe(v);
      const now = await fingerprint();
      expect(now.agents, `v${v}: agents`).toEqual(base.agents);
      expect(now.journals, `v${v}: no journal posted`).toBe(base.journals);
      expect(now.head, `v${v}: hash-chain head`).toEqual(base.head);
      expect(now.balances, `v${v}: balances`).toEqual(base.balances);
      expect(now.cognition, `v${v}: cognition history`).toEqual(base.cognition);
      expect(now.requests, `v${v}: dependency records kept`).toBe(base.requests);
      expect((await q(`SELECT fleet.fleet_ledger_verify() AS r`))[0].r.ok, `v${v}: ledger verifies`).toBe(true);
      if (v === 26) {
        // Action-scoped dependencies: the identity request is a kyc dependency; the ordinary one is retired.
        expect((await q(`SELECT kind, status FROM fleet.fleet_owner_requests ORDER BY seq`)).map((r) => `${r.kind}:${r.status}`)).toEqual(["kyc:pending", "legacy_ordinary:retired"]);
      }
      if (v === 29) {
        // Founder 1 gains the restricted accounts (tax reserve, tax expense, envelope capital) — empty, no journal.
        expect((await q(`SELECT class FROM fleet.fleet_ledger_accounts WHERE agent_id = $1 AND class IN ('agent_tax_reserve','agent_tax_expense','agent_envelope_cash') ORDER BY class`, [F.id]))
          .map((r) => r.class)).toEqual(["agent_envelope_cash", "agent_tax_expense", "agent_tax_reserve"]);
      }
    }
    // The store's own migrate is then a no-op (and grants the restricted roles), the audit is clean, and Founder 1 works.
    const store = new PgFleetStore({ connectionString: pgc.ownerUrl });
    const gw = new PgAgentGateway({ connectionString: pgc.agentUrl });
    try {
      expect(await store.migrate()).toEqual([]);
      expect((await store.auditPrivileges()).problems).toEqual([]);
      const w = (await gw.economy(F.id, F.token, "wallet", {})) as Record<string, any>;
      expect(w).toMatchObject({ ok: true, wallet: { taxReserveMinor: 0, lifetime: { expensesMinor: 813 } } });
      expect(w.wallet.cashHeldMinor).toBe(10_000 - 813);
      expect(await gw.economy(F.id, F.token, "brief", {})).toMatchObject({ ok: true, brief: { availableMinor: 10_000 - 813 } });
      expect(await gw.economy(F.id, F.token, "venture.create", { key: "landlord-tracker", model: "digital_product", offer: "tracker" })).toMatchObject({ ok: true });
    } finally { await gw.close(); await store.close(); }
  });

  it("direct upgrades from older supported baselines (v8, v24) reach the current schema with a clean audit; re-running is a no-op", async () => {
    for (const from of [8, 24]) {
      const p2 = await startEphemeralPg(PG_BIN!);
      try {
        await migrateUpTo(p2.ownerUrl, "fleet", from);
        const store = new PgFleetStore({ connectionString: p2.ownerUrl });
        try {
          expect(await store.migrateCheck()).toEqual({ currentVersion: from, resultingVersion: FLEET_PG_SCHEMA_VERSION,
            wouldApply: Array.from({ length: FLEET_PG_SCHEMA_VERSION - from }, (_, i) => from + 1 + i) });
          expect(await store.migrate()).toEqual(Array.from({ length: FLEET_PG_SCHEMA_VERSION - from }, (_, i) => from + 1 + i));
          expect(await store.migrate()).toEqual([]);
          expect((await store.auditPrivileges()).problems, `from v${from}`).toEqual([]);
        } finally { await store.close(); }
      } finally { p2.stop(); }
    }
  }, 300_000);
});

/**
 * Test-only: a fully migrated registry (current schema, restricted roles granted) with N activated Genesis founders,
 * for the F2 economy suites. Founders are created through the real Genesis state machine, so their ledger accounts,
 * capability manifests and credentials are exactly what production founders get.
 */
import crypto from "crypto";
import pg from "pg";
import { PgFleetStore, hashAgentToken, mintAgentToken } from "../../../fleet/postgres/store.js";
import { PgAgentGateway } from "../../../fleet/postgres/agent-gateway.js";
import { PgLedgerAdmin } from "../../../fleet/treasury/ledger.js";
import { PgGenesisAdmin } from "../../../fleet/genesis/admin.js";
import { simulateRuntimeAttestation } from "../../../fleet/genesis/simulate.js";
import { startEphemeralPg, type EphemeralPg } from "./ephemeral-pg.js";
import { wipeRegistry } from "./wipe.js";

export const OWNER = "operator:owner";
export type Founder = { id: string; token: string };

export interface EconomyRegistry {
  pgc: EphemeralPg;
  owner: pg.Pool;
  store: PgFleetStore;
  gw: PgAgentGateway;
  ledger: PgLedgerAdmin;
  genesis: PgGenesisAdmin;
  founders: Founder[];
  /** Owner-connection query (rows). */
  q: (sql: string, params?: unknown[]) => Promise<Array<Record<string, any>>>;
  /** One owner-connection function call: SELECT <expr> AS r → r. */
  one: <T = any>(expr: string, params?: unknown[]) => Promise<T>;
  /** An economy operation through the RESTRICTED agent role. */
  econ: (who: Founder, op: string, args?: Record<string, unknown>) => Promise<Record<string, any>>;
  /** The error code (FLEET_*) a statement raises, or "OK". */
  code: (p: Promise<unknown>) => Promise<string>;
  balance: (account: string) => Promise<number>;
  close: () => Promise<void>;
}

/**
 * `simulatedSettlement` (default true): this is a THROWAWAY registry, so simulated/sandbox rails may exist and settle
 * (schema v46 refuses them on any registry that does not explicitly allow simulated settlement). Pass false to test the
 * production behaviour.
 */
export async function startEconomyRegistry(pgBin: string, opts: { founders?: number; allocationCents?: number; treasuryCents?: number; simulatedSettlement?: boolean } = {}): Promise<EconomyRegistry> {
  const n = opts.founders ?? 2;
  const pgc = await startEphemeralPg(pgBin);
  const owner = new pg.Pool({ connectionString: pgc.ownerUrl, max: 4 });
  const store = new PgFleetStore({ connectionString: pgc.ownerUrl });
  await store.migrate();
  const c = await owner.connect();
  try { await c.query("BEGIN"); await wipeRegistry(c, "fleet"); await c.query("COMMIT"); } finally { c.release(); }
  const ledger = new PgLedgerAdmin({ connectionString: pgc.ownerUrl });
  const genesis = new PgGenesisAdmin({ connectionString: pgc.ownerUrl });
  const gw = new PgAgentGateway({ connectionString: pgc.agentUrl });
  const q = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;
  if (opts.simulatedSettlement !== false) await q(`SELECT fleet.fleet_admin_simulated_settlement_set(true, $1)`, [OWNER]);
  await q(`UPDATE fleet.fleet_state SET max_agents = $5, runtime_repo = $1, runtime_commit = $2, runtime_build_id = $3, runtime_lockfile_sha256 = $4`,
    ["https://github.com/5l4mm3r/automaton-fleet", "c".repeat(40), "d".repeat(64), "e".repeat(64), Math.max(2, n)]);
  await genesis.setEnabled(true, OWNER, "test");
  await ledger.recordOwnerFunding(opts.treasuryCents ?? 1_000_000, `bank:${crypto.randomUUID()}`, OWNER);
  await q(`UPDATE fleet.fleet_genesis_policy SET genesis_max_founders = $1`, [n]);
  const g = await genesis.propose({ idempotencyKey: `g:${crypto.randomUUID()}`, founderCount: n, allocationCents: opts.allocationCents ?? 5_000, ttlS: 3600, actor: OWNER });
  await genesis.approve(g.genesisId, g.authSha256, OWNER);
  const p = await genesis.provision(g.genesisId, OWNER);
  for (const id of p.founderIds!) await genesis.attest(g.genesisId, id, (await simulateRuntimeAttestation(genesis, genesis, g.genesisId, id, OWNER)).host, OWNER);
  await genesis.fund(g.genesisId, OWNER);
  const founders = p.founderIds!.map((id) => ({ id, token: mintAgentToken(id) }));
  await genesis.activateWithHashes(g.genesisId, g.authSha256, founders.map((t) => hashAgentToken(t.token)), OWNER);
  const one = async <T = any>(expr: string, params: unknown[] = []) => (await owner.query(`SELECT ${expr} AS r`, params)).rows[0].r as T;
  return {
    pgc, owner, store, gw, ledger, genesis, founders, q, one,
    econ: (who, op, args = {}) => gw.economy(who.id, who.token, op, args) as Promise<Record<string, any>>,
    code: (pr) => pr.then(() => "OK", (e: Error) => /FLEET_[A-Z_]+|permission denied|violates check constraint "[a-z_]+"/.exec(e.message)?.[0] ?? e.message.slice(0, 120)),
    balance: async (account) => Number(await one(`fleet.fleet_ledger_balance($1)`, [account])),
    close: async () => {
      await genesis.close(); await ledger.close(); await gw.close(); await store.close(); await owner.end(); pgc.stop();
    },
  };
}

/**
 * Test-only: a fully migrated registry (current schema, restricted roles granted) with N activated Genesis founders,
 * for the F2 economy suites. Founders are created through the real Genesis state machine, so their ledger accounts,
 * capability manifests and credentials are exactly what production founders get.
 */
import { DELIVERABLE_FORMATS } from "../../../fleet/postgres/migrations-phase87.js";
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
export async function startEconomyRegistry(pgBin: string, opts: { founders?: number; allocationCents?: number; treasuryCents?: number; simulatedSettlement?: boolean;
  /** v79/v80: keep the production default — no public site, sales closed, outward actions held (default: launched). */ outwardHeld?: boolean } = {}): Promise<EconomyRegistry> {
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
  // v79/v80: outward actions are held while sales are closed. Suites that exercise them run on a LAUNCHED test registry (a
  // test public site, sales open — the owner's launch switch); outwardHeld keeps the production default (held, no site).
  if (opts.outwardHeld !== true) {
    await q(`SELECT fleet.fleet_admin_public_site_set('https://shop.fleet.test', NULL, $1)`, [OWNER]);
    await q(`SELECT fleet.fleet_admin_sales_set(true, $1)`, [OWNER]);
  }
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

/** A runtime probe with every deliverable library present (renderer / OCR not installed), as a founder-v10 runtime reports it. */
export const READY_RUNTIME = Object.freeze({ toolset: "toolset-6", renderer: "", ocr: "", libraries: {
  spreadsheets: ["openpyxl 3.1.5"], documents: ["docx 1.1.2"], presentations: ["pptx 1.0.2"], pdf: ["reportlab 4.2.5"], ebooks: ["ebooklib 0.20"], images: ["PIL 11.0.0"] } });

/**
 * v87: publishing an offer or quoting an enquiry needs a capability check that names it and covers its deliverables. Suites
 * that are not about that gate call this once: before each publish / quote, the agent checks that offer / enquiry (its
 * deliverable files' formats; a PDF for an enquiry) exactly as a runtime would. The gate itself is tested in
 * fleet-v87-media-capabilities-pg.
 */
export function autoCapabilityChecks(R: EconomyRegistry): void {
  const econ = R.econ;
  const formatOf: Record<string, string> = Object.fromEntries(Object.entries(DELIVERABLE_FORMATS).map(([f, [ct]]) => [ct, f]));
  R.econ = async (who, op, args = {}) => {
    if (op === "offer.publish" || op === "enquiry.quote") {
      const key = op === "offer.publish" ? "offerId" : "enquiryId";
      const types = op === "offer.publish" ? (await R.q(`SELECT DISTINCT content_type FROM fleet.fleet_offer_files WHERE offer_id::text = $1 AND role = 'deliverable' AND removed_at IS NULL`,
        [String(args.offerId ?? "")])).map((r: any) => formatOf[r.content_type]).filter(Boolean) : [];
      const deliverables = (types.length ? types : ["pdf"]).map((format: string) => ({ format }));
      await econ(who, "capabilities.check", { runtime: READY_RUNTIME, [key]: args[key], deliverables }).catch(() => undefined);
    }
    return econ(who, op, args);
  };
}

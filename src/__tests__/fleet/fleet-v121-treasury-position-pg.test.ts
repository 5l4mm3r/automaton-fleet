/**
 * v121 — the treasury shown as it is (PostgreSQL; read-only functions; no journal is posted by them).
 *  - the PayPal balance is the accounting currency's (GBP), even when a USD row is written a moment later;
 *  - the position never sums the same money twice, keeps API credit (USD) out of every GBP figure, and shows no available
 *    figure unless the books reconcile with fresh provider cash;
 *  - agent wallets are shown beside the unbacked capital that funds them;
 *  - the wealth figure the replication logic reads (treasuryCashMinor) is unchanged; HQ's honest figures sit beside it;
 *  - the dashboard gateway knows the read.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";

const PG_BIN = findPgBin();

describe.skipIf(!PG_BIN)("v121: treasury position (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let su: pg.Pool;
  const rail = crypto.randomUUID();
  const asSuper = async (sql: string, params: unknown[] = []) => {
    const c = await su.connect();
    try { await c.query("SET session_replication_role = replica"); return (await c.query(sql, params)).rows; } finally { await c.query("RESET session_replication_role"); c.release(); }
  };
  const pos = () => R.one<Record<string, any>>(`fleet.fleet_treasury_position()`);
  const observe = (ccy: string, total: number, ago: string) => asSuper(`INSERT INTO fleet.fleet_paypal_balance_observations (rail_id, currency, available_minor, total_minor, observed_at)
      VALUES ($1, $2, $3, $3, now() - $4::interval)`, [rail, ccy, total, ago]);
  const journals = () => R.one<number>(`(SELECT count(*)::int FROM fleet.fleet_ledger_journal)`);

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000 });
    su = new pg.Pool({ connectionString: R.pgc.superUrl.replace(/\/postgres$/, `/${R.pgc.dbname}`), max: 1 });
    await asSuper(`INSERT INTO fleet.fleet_payment_rails (rail_id, provider, label, rail_kind, legal_entity_id, capabilities, account_ref, mode, status, created_by)
      VALUES ($1, 'paypal', 'PayPal treasury (test)', 'shared', gen_random_uuid(), ARRAY['receive_payments'], 'T***@example.test', 'simulated', 'active', 'test')`, [rail]);
  }, 300_000);
  afterAll(async () => { await su?.end(); await R?.close(); });

  it("PayPal balance is the accounting currency's: a later USD row does not replace the GBP balance", async () => {
    await observe("GBP", 22, "2 minutes");
    await observe("USD", 0, "1 minute");                                                   // written after the GBP row, as each sync does
    const latest = await R.one<Record<string, any>>(`fleet.fleet_paypal_balance_latest()`);
    expect(latest).toMatchObject({ currency: "GBP", totalMinor: 22, availableMinor: 22 });
    expect(await R.one<Record<string, any>>(`fleet.fleet_treasury_health() #> '{paypal,latestBalance}'`)).toMatchObject({ currency: "GBP", totalMinor: 22 });
    expect(await R.one<Record<string, any>>(`fleet.fleet_money_states() -> 'paypalObserved'`)).toMatchObject({ currency: "GBP", totalMinor: 22, withheldMinor: 0 });
    expect((await pos()).paypal).toMatchObject({ currency: "GBP", totalMinor: 22, fresh: true });
  });

  it("never sums the same money twice; API credit stays out of GBP; no available figure while unreconciled", async () => {
    const p = await pos();
    const cb = await R.one<Record<string, any>>(`fleet.fleet_capital_backing()`);
    const treasuryCash = Number(await R.one(`fleet.fleet_treasury_cash()`));
    const t = p.treasury;
    expect(Number(t.unallocatedMinor) + Number(t.fleetControlReservedMinor) + Number(t.ownerSetAsideMinor) + Number(t.otherPartitionsMinor)).toBe(treasuryCash);
    expect(Number(p.agents.walletsMinor)).toBe((p.agents.wallets as any[]).reduce((n, w) => n + Number(w.walletMinor), 0));
    expect(p.reconciliation.differenceMinor).toBe(cb.differenceMinor);
    expect(p.reconciliation.unbackedCapitalMinor).toBe(cb.unbackedMinor);
    expect(p.apiCredit.currency).toBe("USD");
    // The fixture's books do not match 22p of PayPal cash: unresolved, and nothing is presented as spendable.
    expect(Number(p.reconciliation.differenceMinor)).not.toBe(0);
    expect(p.reconciliation.status).toBe("unresolved");
    expect(t.availableMinor).toBeNull();
    // Wallets beside the unbacked capital that funds them (never more backed than the books less the unbacked part).
    expect(Number(p.agents.backedAtMostMinor)).toBe(Math.max(0, Number(p.agents.walletsMinor) - Number(cb.unbackedMinor)));
  });

  it("reconciled with fresh cash: available = the unallocated money real cash covers; a stale balance makes it unknown again", async () => {
    const cb = await R.one<Record<string, any>>(`fleet.fleet_capital_backing()`);
    const books = Number(cb.booksCashMinor) - Number(cb.unbackedMinor);                   // what PayPal should hold
    await observe("GBP", books, "0 minutes");
    const p = await pos();
    expect(p.reconciliation).toMatchObject({ status: "reconciled", differenceMinor: 0 });
    expect(Number(p.treasury.availableMinor)).toBe(Math.max(0, Math.min(Number(p.treasury.unallocatedMinor), books)));
    // Only an observation older than the staleness bound remains: unknown, not a guess.
    await asSuper(`UPDATE fleet.fleet_paypal_balance_observations SET observed_at = now() - interval '27 hours'`);
    const s = await pos();
    expect(s.paypal.fresh).toBe(false);
    expect(s.reconciliation.status).toBe("unresolved");
    expect(s.treasury.availableMinor).toBeNull();
  });

  it("no PayPal balance at all: unavailable, never zero", async () => {
    await asSuper(`DELETE FROM fleet.fleet_paypal_balance_observations`);
    const p = await pos();
    expect(p.paypal).toBeNull();
    expect(p.reconciliation.status).toBe("unavailable");
    expect(p.treasury.availableMinor).toBeNull();
  });

  it("the replication figure is unchanged; HQ's honest figures sit beside it; reads post nothing; the gateway knows the read", async () => {
    const j0 = await journals();
    const w = await R.one<Record<string, any>>(`fleet.fleet_generated_treasury_wealth()`);
    expect(Number(w.treasuryCashMinor)).toBe(Number(await R.one(`fleet.fleet_treasury_cash()`)));
    expect(w).toHaveProperty("treasuryCashBasis");
    expect(w).toHaveProperty("availableTreasuryMinor");
    expect(w).toHaveProperty("reconciliationStatus", "unavailable");
    await pos(); await R.one(`fleet.fleet_treasury_health()`);
    expect(await journals()).toBe(j0);
    expect(await R.one(`(SELECT prosrc LIKE '%''treasury_position''%' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'fleet' AND proname = 'dash_call')`)).toBe(true);
    const audit = (await R.store.auditPrivileges()).problems;
    expect(audit, JSON.stringify(audit)).toEqual([]);
    void OWNER;
  });
});

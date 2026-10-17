/**
 * v91: a deposit into the BANK backs the existing capital (PostgreSQL; SIMULATED bank evidence — no account, no money).
 *
 * As in production: owner capital recorded with no money behind it (the agents' wallets), and an open treasury shortfall.
 * The owner's settled bank deposit fills the shortfall first, then backs the existing capital with NO second ledger credit,
 * and only the rest is new owner funding (unallocated). The whole-treasury reconciliation is unchanged by the deposit (the
 * money and the books move together); the line is closed and its key can never be recorded again; only a settled incoming
 * transfer in the books' currency, by the owner, counts; with nothing left to back, a deposit is plain owner funding.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";

const PG_BIN = findPgBin();

describe.skipIf(!PG_BIN)("v91 a bank deposit backs the existing capital (PostgreSQL, simulated bank)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let F: Founder;
  let feed: pg.Pool;
  let bank = "", account = "";
  let bankBalance = 50_000;
  const rx = async (fn: string, args: unknown[]) => (await feed.query(`SELECT fleet.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) AS r`, args)).rows[0].r;
  const txn = (x: Record<string, unknown>) => rx("rx_location_txn", ["feed", bank, { currency: "GBP", source: "simulated", ...x }]);
  const observe = (delta: number) => { bankBalance += delta; return rx("rx_location_balance", ["feed", bank, bankBalance, bankBalance, 0, "simulated"]); };
  const bal = (a: string) => R.one(`fleet.fleet_ledger_balance($1)`, [a]).then(Number);
  const cash = () => R.one(`fleet.fleet_agent_cash($1)`, [F.id]).then(Number);
  const backing = () => R.one<Record<string, any>>(`fleet.fleet_capital_backing()`);
  const rec = () => R.one<Record<string, any>>(`fleet.fleet_treasury_reconciliation()`);
  const journals = async () => Number(await R.one(`(SELECT count(*) FROM fleet.fleet_ledger_journal)`));
  const contribute = (txnId: string, actor = OWNER) => R.one<Record<string, any>>(`fleet.fleet_admin_location_contribution($1, $2)`, [txnId, actor]);
  const verify = async () => expect(await R.one(`(fleet.fleet_ledger_verify() ->> 'ok')`)).toBe("true");
  const deposit = async (externalId: string, amountMinor: number, x: Record<string, unknown> = {}) => {
    const r = await txn({ externalId, status: "settled", direction: "in", kind: "transfer", amountMinor, descriptor: "OWNER DEPOSIT", settledAt: new Date().toISOString(), ...x });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return r.txnId as string;
  };

  beforeAll(async () => {
    // The real treasury is all allocated (no unallocated cash); then capital recorded without money, granted to the agent.
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000, treasuryCents: 10_000, simulatedSettlement: false });
    [F] = R.founders;
    feed = new pg.Pool({ connectionString: R.pgc.bankfeedUrl, max: 1 });
    await R.ledger.recordOwnerFunding(20_000, "owner-authorized-virtual:test-founders:2026-10-17", OWNER);
    const c0 = await cash();
    await R.one(`fleet.fleet_admin_agent_capital($1, 20000, 'grant', $2, 'capital recorded before money, as in production', true, 'v91-grant-1')`, [F.id, OWNER]);
    expect(await cash() - c0).toBe(20_000);
    await R.econ(F, "venture.create", { key: "f-shop", model: "digital_product", offer: "templates", state: "selected" });
    account = (await R.econ(F, "account.register", { platform: "shop.example.com", kind: "service", origin: "https://shop.example.com", handle: "f-shop", ventureKey: "f-shop" })).accountId;
    await R.one(`fleet.fleet_admin_owner_identity_class_set('payment_card', 'ovault:payment_card', NULL, 'configured', $1)`, [OWNER]);
    await R.one(`fleet.fleet_admin_identity_autonomy_set(true, ARRAY['legal_name'], true, 100_000, 200_000, '{}', 'agents may act without waiting', $1)`, [OWNER]);
    bank = (await R.one<any>(`fleet.fleet_admin_location_add('bank', 'starling', 'Starling', NULL, $1)`, [OWNER])).locationId;
    await R.q(`SELECT fleet.fleet_admin_location_status($1, 'active', NULL, $2)`, [bank, OWNER]);
    await R.one(`fleet.fleet_admin_location_bind_card($1, $2)`, [bank, OWNER]);
    await observe(0);
    // An open shortfall (v88's reproduced case): a late charge beyond the agent's cash with no unallocated cash.
    const rq = await R.econ(F, "card.request", { accountId: account, merchant: "Shop Ltd", paypalUnavailable: "card_only_merchant", amountMinor: 1_000, purpose: "stock assets" });
    const h = await R.econ(F, "card.authorize", { requestId: rq.request.requestId, accountId: account, merchant: "Shop Ltd", maxMinor: 1_000 });
    await R.econ(F, "card.declare", { chargeId: h.charge.chargeId, amountMinor: 1_000 });
    await R.one(`fleet.fleet_admin_card_hold_release($1, 'bank app shows nothing pending', $2)`, [h.charge.chargeId, OWNER]);
    await R.q(`SELECT fleet.fleet_admin_wallet_transfer($1, $2, 'operating_pool', 'spent elsewhere', $3, 'drain-key-0000000091', true)`, [F.id, await cash(), OWNER]);
    expect(await txn({ externalId: "LATE-1", status: "settled", direction: "out", kind: "card", amountMinor: 1_000, descriptor: "SHOP LTD", settledAt: new Date().toISOString() }))
      .toMatchObject({ ok: true, match: "late_settled" });
    await observe(-1_000);
  }, 300_000);
  afterAll(async () => { await feed?.end(); await R?.close(); });

  it("migrates to v91 with a clean audit; the capital is unbacked and a shortfall is open; PayPal alone is no longer the difference", async () => {
    expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(91);
    { const a = await R.store.auditPrivileges(); expect(a.problems, JSON.stringify(a.problems)).toEqual([]); }
    expect(await bal("fleet:treasury:shortfall")).toBe(-1_000);
    const b = await backing();
    expect(b).toMatchObject({ virtualCapitalMinor: 20_000, backedMinor: 0, unbackedMinor: 20_000, differenceMinor: null, differenceScope: "several locations: see the treasury reconciliation" });
  });

  it("refuses what cannot back capital: not settled, another currency, money out, not the owner", async () => {
    const pend = await deposit("DEP-P", 5_000, { status: "pending", settledAt: null });
    expect(await contribute(pend)).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" });
    const usd = await deposit("DEP-USD", 5_000, { currency: "USD" });
    expect(await contribute(usd)).toMatchObject({ ok: false, code: "FLEET_FX_REQUIRED" });
    const out = (await txn({ externalId: "OUT-1", status: "settled", direction: "out", kind: "transfer", amountMinor: 5_000, settledAt: new Date().toISOString() })).txnId;
    expect(await contribute(out)).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" });
    const dep = await deposit("DEP-AGENT", 5_000);
    expect(await R.code(contribute(dep, "agent:someone"))).toMatch(/FLEET_/);
    expect((await backing()).backedMinor).toBe(0);
    for (const t of [usd, out, dep]) await R.one(`fleet.fleet_admin_bank_txn_classify($1, 'explained', 'test line, not money', $2)`, [t, OWNER]);
  });

  it("a deposit fills the shortfall first, then backs the existing capital without a second credit; only the rest is new funding", async () => {
    const r0 = await rec();
    const capital0 = await bal("fleet:owner:capital"), j0 = await journals(), cash0 = await cash();
    const t = await deposit("DEP-1", 25_000);
    await observe(25_000);
    const r = await contribute(t);
    expect(r).toMatchObject({ ok: true, amountMinor: 25_000, shortfallMinor: 1_000, backedMinor: 20_000, ownerFundingMinor: 4_000, unbackedAfterMinor: 0 });
    expect(await bal("fleet:treasury:shortfall")).toBe(0);
    // One journal (the 5,000 of owner funding: 1,000 into the shortfall + 4,000 unallocated) plus the shortfall cover.
    expect(await bal("fleet:owner:capital") - capital0).toBe(5_000); // £50 of new owner capital (1,000 shortfall + 4,000 beyond)
    expect(await journals() - j0).toBe(2);
    expect(await bal("fleet:treasury:unallocated")).toBe(4_000);
    expect(await cash()).toBe(cash0); // nobody is funded
    const b = await backing();
    expect(b).toMatchObject({ backedMinor: 20_000, unbackedMinor: 0 });
    expect(b.backings).toEqual([expect.objectContaining({ source: "bank", locationId: bank, transactionId: "DEP-1", netMinor: 25_000, backedMinor: 20_000, excessMinor: 4_000 })]);
    expect((await R.q(`SELECT classified FROM fleet.fleet_bank_transactions WHERE txn_id = $1`, [t]))[0]).toEqual({ classified: "capital_backing" });
    // The bank and the books moved together: the whole-treasury difference is exactly what it was.
    expect(Number((await rec()).differenceMinor)).toBe(Number(r0.differenceMinor));
    expect(await R.one(`fleet.fleet_event_route('capital_backed', '{}'::jsonb)`)).toBe("P3_SUMMARY");
    await verify();
  });

  it("the line is closed: replayed, re-contributed or claimed again, nothing changes", async () => {
    const head = await R.one(`(SELECT head_hash FROM fleet.fleet_ledger_head WHERE id = 1)`);
    const t = await R.one<string>(`(SELECT txn_id::text FROM fleet.fleet_bank_transactions WHERE external_id = 'DEP-1')`);
    expect(await contribute(t)).toMatchObject({ ok: false, code: "FLEET_ALREADY_CLASSIFIED" });
    expect(await txn({ externalId: "DEP-1", status: "settled", direction: "in", kind: "transfer", amountMinor: 25_000, settledAt: new Date().toISOString() })).toMatchObject({ ok: true, replay: true });
    expect(await R.one(`fleet.fleet_claim_taken($1)`, [`bank:${bank}:DEP-1`])).toBe(true);
    expect(await R.code(R.q(`UPDATE fleet.fleet_capital_backings SET backed_minor = 1`))).toMatch(/immutable|IMMUTABLE/);
    expect(await R.one(`(SELECT head_hash FROM fleet.fleet_ledger_head WHERE id = 1)`)).toBe(head);
  });

  it("with nothing left to back, a deposit is plain owner funding (unallocated), as before v91", async () => {
    const capital0 = await bal("fleet:owner:capital"), un0 = await bal("fleet:treasury:unallocated");
    const t = await deposit("DEP-2", 3_000);
    await observe(3_000);
    expect(await contribute(t)).toMatchObject({ ok: true, shortfallMinor: 0, backedMinor: 0, ownerFundingMinor: 3_000 });
    expect(await bal("fleet:treasury:unallocated") - un0).toBe(3_000);
    expect(await bal("fleet:owner:capital") - capital0).toBe(3_000);
    expect((await R.q(`SELECT classified FROM fleet.fleet_bank_transactions WHERE txn_id = $1`, [t]))[0]).toEqual({ classified: "owner_contribution" });
    expect((await backing()).backings).toHaveLength(1);
    await verify();
  });
});

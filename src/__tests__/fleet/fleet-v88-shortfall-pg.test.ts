/**
 * v88: money that has left is always on the books (PostgreSQL; SIMULATED bank evidence — no account, no money).
 *
 * The reproduced blocker (05cbe4e): a late card charge beyond the agent's cash, with no unallocated treasury cash, raised
 * FLEET_LEDGER_NEGATIVE and the bank line was rejected — zero rows. Now: the line is recorded and booked; the agent owes
 * the part it could not pay; the part no partition held is a recorded SHORTFALL (negative, counted in the books, alerted,
 * the agent's card frozen); replaying the line changes nothing; a statement row that cannot be recorded never drops the
 * others; a line whose booking fails stays recorded with its error and is booked on a later pass; later money (funding, a
 * refund, the agent's estate) settles the shortfall first; on death the unrecoverable debt is written off and what is
 * still short stays visible. Never funded: nobody gains cash or credit. Both card paths (debit, owner's card) share it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder, econNext } from "./fixtures/economy-registry.js";

const PG_BIN = findPgBin();

describe.skipIf(!PG_BIN)("v88 shortfalls are recorded, never rejected or funded (PostgreSQL, simulated bank)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let F: Founder;
  let feed: pg.Pool;
  let svc: pg.Pool;
  let bank = "", account = "", charge = "";
  let n = 0;
  const rx = async (fn: string, args: unknown[]) => (await feed.query(`SELECT fleet.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) AS r`, args)).rows[0].r;
  const txn = (x: Record<string, unknown>) => rx("rx_location_txn", ["feed", bank, { currency: "GBP", source: "simulated", ...x }]);
  const bal = (a: string) => R.one(`fleet.fleet_ledger_balance($1)`, [a]).then(Number);
  const payable = () => R.one(`fleet.fleet_ledger_balance(fleet.fleet_ledger_account($1, 'agent_provider_payable'))`, [F.id]).then(Number);
  const cash = () => R.one(`fleet.fleet_agent_cash($1)`, [F.id]).then(Number);
  const verify = async () => expect(await R.one(`(fleet.fleet_ledger_verify() ->> 'ok')`)).toBe("true");
  const hold = async (maxMinor: number) => {
    const rq = await econNext(R, F, "card.request", { accountId: account, merchant: "Shop Ltd", paypalUnavailable: "card_only_merchant", amountMinor: maxMinor, purpose: `stock assets ${++n}` });
    if (!rq.ok) return rq;
    return R.econ(F, "card.authorize", { requestId: rq.request.requestId, accountId: account, merchant: "Shop Ltd", maxMinor });
  };

  beforeAll(async () => {
    // Every pound of the treasury is allocated to the agent: there is no unallocated cash to carry an advance.
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 1_000_000, simulatedSettlement: false });
    [F] = R.founders;
    await R.store.grantServiceRole();
    feed = new pg.Pool({ connectionString: R.pgc.bankfeedUrl, max: 1 });
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 1 });
    await R.econ(F, "venture.create", { key: "f-shop", model: "digital_product", offer: "templates", state: "selected" });
    account = (await R.econ(F, "account.register", { platform: "shop.example.com", kind: "service", origin: "https://shop.example.com", handle: "f-shop", ventureKey: "f-shop" })).accountId;
    await R.one(`fleet.fleet_admin_owner_identity_class_set('payment_card', 'ovault:payment_card', NULL, 'configured', $1)`, [OWNER]);
    await R.one(`fleet.fleet_admin_identity_autonomy_set(true, ARRAY['legal_name'], true, 100_000, 200_000, '{}', 'agents may act without waiting', $1)`, [OWNER]);
    bank = (await R.one<any>(`fleet.fleet_admin_location_add('bank', 'starling', 'Starling', NULL, $1)`, [OWNER])).locationId;
    await R.q(`SELECT fleet.fleet_admin_location_status($1, 'active', NULL, $2)`, [bank, OWNER]);
    await R.one(`fleet.fleet_admin_location_bind_card($1, $2)`, [bank, OWNER]);
    await rx("rx_location_balance", ["feed", bank, 50_000, 50_000, 0, "simulated"]);
  }, 300_000);
  afterAll(async () => { for (const p of [feed, svc]) await p?.end(); await R?.close(); });

  it("the reproduced case: a late charge beyond the agent's cash and the unallocated treasury is recorded, owed, a visible shortfall — the card frozen", async () => {
    const h = await hold(1_000);
    charge = h.charge.chargeId;
    await R.econ(F, "card.declare", { chargeId: charge, amountMinor: 1_000 });
    await R.one(`fleet.fleet_admin_card_hold_release($1, 'bank app shows nothing pending', $2)`, [charge, OWNER]);
    // The agent's released cash is spent elsewhere (moved to the operating pool here).
    await R.q(`SELECT fleet.fleet_admin_wallet_transfer($1, $2, 'operating_pool', 'spent elsewhere', $3, 'drain-key-0000000001', true)`, [F.id, await cash(), OWNER]);
    expect([await cash(), await bal("fleet:treasury:unallocated")]).toEqual([0, 0]);
    const r = await txn({ externalId: "LATE-1", status: "settled", direction: "out", kind: "card", amountMinor: 1_000, descriptor: "SHOP LTD", settledAt: new Date().toISOString() });
    expect(r).toMatchObject({ ok: true, match: "late_settled" }); // 05cbe4e: FLEET_LEDGER_NEGATIVE, zero rows
    expect(await R.one(`(SELECT count(*) FROM fleet.fleet_bank_transactions WHERE external_id = 'LATE-1')`)).toBe("1");
    expect(await payable()).toBe(1_000); // the agent owes it
    expect(await bal("fleet:treasury:shortfall")).toBe(-1_000); // no partition held it
    expect(await cash()).toBe(0); // nothing funded
    expect((await R.q(`SELECT status, shortfall_minor FROM fleet.fleet_card_charges WHERE charge_id = $1`, [charge]))[0]).toEqual({ status: "booked", shortfall_minor: "1000" });
    expect(await R.q(`SELECT class FROM fleet.fleet_notifications WHERE code = 'TREASURY_SHORTFALL'`)).toEqual([{ class: "RED" }]);
    // The books count it: books cash falls with the money that left.
    const rec = await R.one<any>(`fleet.fleet_treasury_reconciliation()`);
    expect(Number(rec.differenceMinor)).toBe(Number(rec.locationsMinor) + Number(rec.inTransitMinor) - Number(rec.expectedMinor));
    // Replaying the same bank line changes nothing.
    const head = await R.one(`(SELECT head_hash FROM fleet.fleet_ledger_head WHERE id = 1)`);
    expect(await txn({ externalId: "LATE-1", status: "settled", direction: "out", kind: "card", amountMinor: 1_000, descriptor: "SHOP LTD", settledAt: new Date().toISOString() }))
      .toMatchObject({ ok: true, replay: true });
    expect(await R.one(`(SELECT head_hash FROM fleet.fleet_ledger_head WHERE id = 1)`)).toBe(head);
    await verify();
  });

  it("the shortfall settles from later money in order; the card thaws only then; nobody is funded", async () => {
    // The owner funds the treasury, then grants the agent some cash before the hourly pass runs: the card stays frozen.
    await R.one(`fleet.fleet_admin_record_owner_funding(5000, 'owner-transfer-1', $1, 'owner-funding-key-001')`, [OWNER]);
    await R.one(`fleet.fleet_admin_agent_capital($1, 4000, 'grant', $2, 'working capital', true, 'grant-key-0000000001')`, [F.id, OWNER]);
    const frozen = await hold(100);
    expect(frozen, JSON.stringify(frozen)).toMatchObject({ ok: false, code: "FLEET_CARD_SHORTFALL" });
    // The hourly pass: unallocated cash fills the shortfall first.
    await svc.query(`SELECT fleet.svc_operations_watch()`);
    expect(await bal("fleet:treasury:shortfall")).toBe(0);
    expect(await bal("fleet:treasury:unallocated")).toBe(5_000 - 4_000 - 1_000);
    expect(await payable()).toBe(1_000); // still the agent's debt: covering the gap funded nobody
    const thawed = await hold(110);
    expect(thawed.ok, JSON.stringify(thawed)).toBe(true);
    await verify();
  });

  it("a refund of a shortfall charge, and a dead agent's estate, settle in order; what stays short stays visible", async () => {
    // A second shortfall: drain the treasury again, then a larger-than-held charge at the bank.
    await R.q(`SELECT fleet.fleet_admin_wallet_transfer($1, $2, 'operating_pool', 'spent elsewhere', $3, 'drain-key-0000000002', true)`, [F.id, await cash(), OWNER]);
    const open = (await R.q(`SELECT charge_id FROM fleet.fleet_card_charges WHERE status = 'held' AND location_id IS NOT NULL`))[0].charge_id;
    await R.econ(F, "card.declare", { chargeId: open, amountMinor: 110 });
    const unalloc = await bal("fleet:treasury:unallocated");
    // The bank takes 120 (within the FX tolerance) — 10 beyond the reservation, with the agent's cash at 0.
    await txn({ externalId: "CARD-2", status: "settled", direction: "out", kind: "card", amountMinor: 120, descriptor: "SHOP LTD", settledAt: new Date().toISOString() });
    expect((await R.q(`SELECT status FROM fleet.fleet_card_charges WHERE charge_id = $1`, [open]))[0].status).toBe("booked");
    expect(unalloc).toBe(0);
    expect(await payable()).toBe(1_010);
    expect(await bal("fleet:treasury:shortfall")).toBe(-10);
    // A merchant refund of the first charge in full: the agent's debt falls; the money back fills any shortfall first.
    expect(await txn({ externalId: "REF-1", status: "settled", direction: "in", kind: "card_refund", amountMinor: 1_000, descriptor: "Shop Ltd refund", settledAt: new Date().toISOString() }))
      .toMatchObject({ match: "refund" });
    expect(await payable()).toBe(10);
    expect(await bal("fleet:treasury:shortfall")).toBe(0); // the refunded money filled the shortfall first
    expect(await bal("fleet:treasury:unallocated")).toBe(1_000 - 10);
    // Death: the estate repays from any cash, then the rest of the debt is written off; any shortfall would stay visible.
    expect(await R.one(`fleet.fleet_estate_repay_payable($1, 'controller', 'estate-repay-key-0001')`, [F.id])).toBe("0");
    expect(await R.one(`fleet.fleet_estate_write_off_payable($1, 'controller', 'estate-writeoff-key-01')`, [F.id])).toBe("10");
    expect(await payable()).toBe(0);
    await verify();
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });

  it("a statement row that cannot be recorded never drops the others; a line whose booking fails stays recorded, alerted and booked on a later pass", async () => {
    const r = await R.one<any>(`fleet.fleet_admin_location_import($1, $2::jsonb, NULL, $3)`, [bank, JSON.stringify([
      { externalId: "CSV-OK-1", status: "settled", direction: "out", kind: "fee", amountMinor: 120, currency: "GBP", descriptor: "FEE", settledAt: new Date().toISOString() },
      { externalId: "CSV-BAD-1", status: "settled", direction: "sideways", kind: "fee", amountMinor: 1 },
      { externalId: "CSV-OK-2", status: "settled", direction: "in", kind: "other", amountMinor: 80, currency: "GBP", descriptor: "INTEREST", settledAt: new Date().toISOString() }]), OWNER]);
    expect(r).toMatchObject({ ok: true, recorded: 2, rejected: [{ row: 2, code: "FLEET_BAD_REQUEST" }] });
    // Force a booking failure (test only): the matcher raises; the line must still be recorded and retried later.
    const def = await R.one<string>(`pg_get_functiondef('fleet.fleet_location_match(uuid)'::regprocedure)`);
    await R.q(`CREATE OR REPLACE FUNCTION fleet.fleet_location_match(p_txn uuid) RETURNS text LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated posting failure'; END $$`);
    await R.one(`fleet.fleet_admin_agent_capital($1, 900, 'grant', $2, 'working capital', true, 'grant-key-0000000002')`, [F.id, OWNER]);
    const h = await hold(90);
    expect(h.ok, JSON.stringify(h)).toBe(true);
    const x = await txn({ externalId: "CARD-3", status: "settled", direction: "out", kind: "card", amountMinor: 90, descriptor: "SHOP LTD", settledAt: new Date().toISOString() });
    expect(x).toMatchObject({ ok: true, match: "error" });
    expect((await R.q(`SELECT match_error, classified FROM fleet.fleet_bank_transactions WHERE external_id = 'CARD-3'`))[0]).toEqual({ match_error: "simulated posting failure", classified: null });
    expect(((await R.one<any>(`fleet.fleet_locations_json()`)).unexplained as any[]).find((u) => u.txnId === x.txnId)).toMatchObject({ matchError: "simulated posting failure" });
    expect((await R.q(`SELECT class FROM fleet.fleet_notifications WHERE code = 'BANK_LINE_NOT_BOOKED'`))[0]).toEqual({ class: "RED" });
    await R.q(def);
    await svc.query(`SELECT fleet.svc_operations_watch()`);
    expect((await R.q(`SELECT match_error, classified FROM fleet.fleet_bank_transactions WHERE external_id = 'CARD-3'`))[0]).toEqual({ match_error: null, classified: "card_charge" });
    expect((await R.q(`SELECT status FROM fleet.fleet_card_charges WHERE charge_id = $1`, [h.charge.chargeId]))[0].status).toBe("booked");
    await verify();
  });

  it("the owner's card (credit mode) shares it: a statement amount beyond the agent and the treasury is recorded as the agent's debt and a shortfall, never refused", async () => {
    expect(await R.one<any>(`fleet.fleet_admin_location_bind_card(NULL, $1)`, [OWNER])).toMatchObject({ ok: true, cardMode: expect.stringContaining("credit") });
    const h = await hold(80);
    expect(h.ok, JSON.stringify(h)).toBe(true);
    expect(await R.econ(F, "card.declare", { chargeId: h.charge.chargeId, amountMinor: 80 })).toMatchObject({ ok: true });
    // Nothing left anywhere: the agent's cash and the unallocated treasury both at 0.
    const un = await bal("fleet:treasury:unallocated");
    if (un > 0) await R.one(`fleet.fleet_admin_agent_capital($1, $2, 'grant', $3, 'all of it', true, 'grant-key-0000000003')`, [F.id, un, OWNER]);
    await R.q(`SELECT fleet.fleet_admin_wallet_transfer($1, $2, 'operating_pool', 'spent elsewhere', $3, 'drain-key-0000000003', true)`, [F.id, await cash(), OWNER]);
    expect([await cash(), await bal("fleet:treasury:unallocated")]).toEqual([0, 0]);
    const p0 = await payable(), s0 = await bal("fleet:treasury:shortfall");
    // The card statement shows 130 (05cbe4e: FLEET_LEDGER_NEGATIVE — the statement amount could not be recorded).
    expect(await R.one<any>(`fleet.fleet_admin_card_charge_confirm($1, 130, 'stmt-2026-10-17', $2)`, [h.charge.chargeId, OWNER])).toMatchObject({ ok: true });
    expect(await payable() - p0).toBe(50);
    expect(await bal("fleet:treasury:shortfall") - s0).toBe(-50);
    expect(await cash()).toBe(0);
    expect(await hold(70)).toMatchObject({ ok: false });
    await verify();
  });
});

/**
 * v86 multi-location treasury (PostgreSQL; bank evidence through the bank-feed role and a SIMULATED feed — no bank account).
 *
 * Proven: a bank location spends nothing without fresh evidence, and a stale, limited or unavailable location blocks only
 * its own actions (PayPal outflows wait when the PayPal location is limited); a transfer PayPal → bank is the same money —
 * no journal, the PayPal spendable cash drops at once, the bank's arrives only with the bank's own transaction; a deposit
 * straight into the bank is owner funding, posted once; with the card bound to the bank (debit mode) a hold must fit the
 * bank's free cash, an agent's declaration books nothing, the bank's settled transaction books it with no card payable, a
 * decline releases the hold, a merchant refund reduces the charge, a hold the bank never shows is released (never booked at
 * its maximum); unexplained bank lines wait for the owner (a fee is posted as a Fleet expense); balance drift and stale or
 * unexplained items raise alerts; the ledger verifies throughout.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { liveRail, type ArmedCustody } from "./fixtures/custody-signer.js";
import { parseStatement } from "../../fleet/treasury/bank-statement.js";
import { PgHubAdmin } from "../../fleet/hub/admin.js";

const PG_BIN = findPgBin();
const SHOP = "https://shop.example.com";

describe.skipIf(!PG_BIN)("v86 money locations and the debit card (PostgreSQL, simulated bank feed)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let F: Founder;
  let feed: pg.Pool;
  let svc: pg.Pool;
  let custody: pg.Pool;
  let hub: PgHubAdmin;
  let rail: ArmedCustody;
  let account = "";
  let bank = "", paypal = "";
  let n = 0;
  const rx = async (fn: string, args: unknown[]) => (await feed.query(`SELECT fleet.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) AS r`, args)).rows[0].r;
  const balance = (available: number, cleared = available) => rx("rx_location_balance", ["feed", bank, available, cleared, 0, "simulated"]);
  const txn = (x: Record<string, unknown>) => rx("rx_location_txn", ["feed", bank, { currency: "GBP", source: "simulated", ...x }]);
  const liq = async (loc: string) => R.one<any>(`fleet.fleet_location_liquidity($1)`, [loc]);
  const head = () => R.one<string>(`(SELECT head_hash FROM fleet.fleet_ledger_head WHERE id = 1)`);
  const cash = () => R.one<number>(`fleet.fleet_agent_cash($1)`, [F.id]).then(Number);
  const verify = async () => expect(await R.one(`(fleet.fleet_ledger_verify() ->> 'ok')`)).toBe("true");
  const hold = async (maxMinor: number) => {
    const rq = await R.econ(F, "card.request", { accountId: account, merchant: "Shop Ltd", paypalUnavailable: "card_only_merchant", amountMinor: maxMinor, purpose: `stock assets ${++n}` });
    expect(rq, JSON.stringify(rq)).toMatchObject({ ok: true, request: { status: "approved" } });
    return R.econ(F, "card.authorize", { requestId: rq.request.requestId, accountId: account, merchant: "Shop Ltd", maxMinor });
  };

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 50_000, simulatedSettlement: false });
    [F] = R.founders;
    await R.store.grantServiceRole();
    await R.store.grantCustodyRole();
    feed = new pg.Pool({ connectionString: R.pgc.bankfeedUrl, max: 1 });
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 1 });
    custody = new pg.Pool({ connectionString: R.pgc.custodyUrl, max: 1 });
    hub = new PgHubAdmin({ connectionString: R.pgc.ownerUrl });
    rail = await liveRail(R.owner, "fleet", OWNER);
    paypal = await R.one<string>(`(SELECT location_id::text FROM fleet.fleet_money_locations WHERE rail_id = $1)`, [rail.railId]);
    expect((await R.econ(F, "venture.create", { key: "f-shop", model: "digital_product", offer: "templates", state: "selected" })).ok).toBe(true);
    account = (await R.econ(F, "account.register", { platform: "shop.example.com", kind: "service", origin: SHOP, handle: "f-shop" })).accountId;
    await R.one(`fleet.fleet_admin_owner_identity_class_set('payment_card', 'ovault:payment_card', NULL, 'configured', $1)`, [OWNER]);
    await R.one(`fleet.fleet_admin_identity_autonomy_set(true, ARRAY['legal_name'], true, 100_000, 200_000, '{}', 'agents may act without waiting', $1)`, [OWNER]);
  }, 300_000);
  afterAll(async () => { for (const p of [feed, svc, custody]) await p?.end(); await hub?.close(); await R?.close(); });

  it("the PayPal account is a location; a new bank location spends nothing until fresh evidence; the audit stays clean", async () => {
    expect(paypal).toMatch(/^[0-9a-f-]{36}$/);
    const a = await R.one<any>(`fleet.fleet_admin_location_add('bank', 'starling', 'Starling sole trader', NULL, $1)`, [OWNER]);
    bank = a.locationId;
    expect(a).toMatchObject({ ok: true, status: "pending_setup" });
    await R.q(`SELECT fleet.fleet_admin_location_status($1, 'active', NULL, $2)`, [bank, OWNER]);
    expect(await liq(bank)).toMatchObject({ stale: true, freeMinor: 0 });
    await balance(20_000);
    expect(await liq(bank)).toMatchObject({ stale: false, availableMinor: 20_000, freeMinor: 20_000 });
    // A reading older than the location's evidence limit is stale again.
    await R.q(`UPDATE fleet.fleet_money_locations SET evidence_max_age_hours = 1 WHERE location_id = $1`, [bank]);
    expect((await R.code(R.q(`UPDATE fleet.fleet_bank_balance_observations SET observed_at = now() - interval '2 hours'`)))).toMatch(/IMMUTABLE|immutable/);
    // The bank feed only brings evidence in: no owner actions, no card or ledger reads, no other location's money moved.
    for (const sql of [`SELECT fleet.fleet_admin_location_add('bank', 'x', 'x', NULL, 'feed')`, `SELECT * FROM fleet.fleet_card_charges`,
                       `SELECT fleet.fleet_admin_location_transfer('${paypal}', '${bank}', 1, 'REF-X', 'feed')`, `SELECT * FROM fleet.fleet_ledger_postings`])
      await expect(feed.query(sql), sql).rejects.toThrow(/permission denied/);
    expect(await rx("rx_location_balance", ["feed", paypal, 1, 1, 0, "simulated"])).toMatchObject({ ok: false, code: "FLEET_NOT_FED" });
    const csvOnly = (await R.one<any>(`fleet.fleet_admin_location_add('bank', 'csv', 'Statement-only account', NULL, $1)`, [OWNER])).locationId;
    expect(await rx("rx_location_txn", ["feed", csvOnly, { externalId: "X-1", status: "settled", direction: "in", kind: "other", amountMinor: 1 }])).toMatchObject({ ok: false, code: "FLEET_NOT_FED" });
    expect((await rx("rx_locations", ["feed"])).map((l: any) => l.locationId)).toEqual([bank]);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });

  it("a transfer PayPal → bank is the same money: no journal; PayPal's spendable cash drops at once; the bank's arrives with its own transaction", async () => {
    await custody.query(`SELECT fleet.cx_paypal_balance_record('custody-executor', $1, 'GBP', 100000, 100000)`, [rail.railId]);
    const ppBefore = Number((await liq(paypal)).freeMinor);
    const h0 = await head();
    const t = await R.one<any>(`fleet.fleet_admin_location_transfer($1, $2, 30000, 'PP-TXN-0001', $3)`, [paypal, bank, OWNER]);
    expect(t).toMatchObject({ ok: true, state: "in_transit" });
    expect(await head()).toBe(h0); // no journal: the same money
    expect(Number((await liq(paypal)).freeMinor)).toBe(ppBefore - 30_000);
    expect((await liq(bank)).freeMinor).toBe(20_000); // not spendable at the bank until the bank shows it
    expect(await txn({ externalId: "SB-IN-1", status: "settled", direction: "in", kind: "transfer", amountMinor: 30_000, settledAt: new Date().toISOString() }))
      .toMatchObject({ ok: true, match: "transfer_arrived" });
    await balance(50_000);
    expect((await liq(bank)).freeMinor).toBe(50_000);
    expect(await R.one(`(SELECT state FROM fleet.fleet_location_transfers WHERE transfer_id = $1)`, [t.transferId])).toBe("arrived");
    // Two alike, arriving as plain statement lines (no "transfer" type): interchangeable, the oldest first; a credit with no
    // recorded transfer is never taken for one.
    const t2 = await R.one<any>(`fleet.fleet_admin_location_transfer($1, $2, 1000, 'PP-TXN-0002', $3)`, [paypal, bank, OWNER]);
    const t3 = await R.one<any>(`fleet.fleet_admin_location_transfer($1, $2, 1000, 'PP-TXN-0003', $3)`, [paypal, bank, OWNER]);
    const now = new Date().toISOString();
    expect(await txn({ externalId: "SB-IN-1b", status: "settled", direction: "in", kind: "other", amountMinor: 1_000, settledAt: now })).toMatchObject({ match: "transfer_arrived" });
    expect(await R.one(`(SELECT string_agg(state, ',' ORDER BY recorded_at) FROM fleet.fleet_location_transfers WHERE transfer_id IN ($1, $2))`, [t2.transferId, t3.transferId])).toBe("arrived,in_transit");
    expect(await txn({ externalId: "SB-IN-1c", status: "settled", direction: "in", kind: "other", amountMinor: 1_000, settledAt: now })).toMatchObject({ match: "transfer_arrived" });
    expect(await txn({ externalId: "SB-IN-1d", status: "settled", direction: "in", kind: "other", amountMinor: 1_000, settledAt: now })).toMatchObject({ match: "unmatched" });
    await R.q(`SELECT fleet.fleet_admin_bank_txn_classify((SELECT txn_id FROM fleet.fleet_bank_transactions WHERE external_id = 'SB-IN-1d'), 'explained', 'test credit', $1)`, [OWNER]);
    await verify();
  });

  it("a deposit straight into the bank is owner funding, posted once against the bank transaction", async () => {
    const r = await txn({ externalId: "SB-IN-2", status: "settled", direction: "in", kind: "other", amountMinor: 10_000, descriptor: "OWNER DEPOSIT", settledAt: new Date().toISOString() });
    expect(r.match).toBe("unmatched");
    const capBefore = Number(await R.one(`fleet.fleet_ledger_balance('fleet:owner:capital')`));
    expect(await R.one<any>(`fleet.fleet_admin_location_contribution($1, $2)`, [r.txnId, OWNER])).toMatchObject({ ok: true, amountMinor: 10_000 });
    expect(Number(await R.one(`fleet.fleet_ledger_balance('fleet:owner:capital')`)) - capBefore).toBe(10_000);
    expect(await R.one<any>(`fleet.fleet_admin_location_contribution($1, $2)`, [r.txnId, OWNER])).toMatchObject({ ok: false, code: "FLEET_ALREADY_CLASSIFIED" });
    await balance(60_000);
    await verify();
  });

  it("a statement export is the same evidence path: matched where it can be, the rest left to explain, a replay records nothing", async () => {
    const csv = ["Date,Counter Party,Reference,Type,Amount (GBP),Balance (GBP)", "16/10/2026,Starling,Card replacement,FEE,-5.00,59995.00",
                 "16/10/2026,Someone,Gift,FASTER PAYMENT,5.00,60000.00"].join("\n");
    const st = parseStatement(csv);
    const first = await hub.locationImport(bank, st.lines, null, OWNER) as any;
    expect(first).toMatchObject({ ok: true, recorded: 2, replayed: 0, matched: 0 });
    expect(await hub.locationImport(bank, parseStatement(csv).lines, null, OWNER)).toMatchObject({ ok: true, recorded: 0, replayed: 2 });
    for (const ext of st.lines.map((l) => l.externalId)) {
      const id = await R.one<string>(`(SELECT txn_id::text FROM fleet.fleet_bank_transactions WHERE external_id = $1)`, [ext]);
      await R.q(`SELECT fleet.fleet_admin_bank_txn_classify($1, 'explained', 'test statement line', $2)`, [id, OWNER]);
    }
    await balance(60_000);
  });

  it("debit mode: a hold must fit the bank; a declaration books nothing; the bank's settlement books it with no card payable", async () => {
    expect(await R.one<any>(`fleet.fleet_admin_location_bind_card($1, $2)`, [bank, OWNER])).toMatchObject({ ok: true, cardMode: expect.stringContaining("debit") });
    await balance(1_500); // within the agent's wallet but beyond the bank's free cash
    expect(await hold(2_100)).toMatchObject({ ok: false, code: "FLEET_LOCATION_INSUFFICIENT", freeMinor: 1_500 });
    await balance(60_000);
    const h = await hold(2_000);
    expect(h, JSON.stringify(h)).toMatchObject({ ok: true });
    const charge = h.charge.chargeId;
    expect((await liq(bank)).freeMinor).toBe(58_000); // the Fleet's hold, not yet seen by the bank
    const payableBefore = Number(await R.one(`fleet.fleet_ledger_balance('fleet:card:payable')`));
    const cashBefore = await cash();
    const d = await R.econ(F, "card.declare", { chargeId: charge, amountMinor: 1_850, authentication: "frictionless" });
    expect(d).toMatchObject({ ok: true, evidence: "awaiting" });
    expect(await R.one(`(SELECT status FROM fleet.fleet_card_charges WHERE charge_id = $1)`, [charge])).toBe("held"); // nothing booked
    // The bank authorises (pending), then settles a slightly different amount (FX).
    expect(await txn({ externalId: "SB-CARD-1", status: "pending", direction: "out", kind: "card", amountMinor: 1_850, descriptor: "SHOP LTD", authorisedAt: new Date().toISOString() }))
      .toMatchObject({ match: "authorised" });
    expect((await liq(bank)).freeMinor).toBe(58_150); // the bank's authorisation replaces the Fleet's hold until the next reading
    expect(await txn({ externalId: "SB-CARD-1", status: "settled", direction: "out", kind: "card", amountMinor: 1_870, settledAt: new Date().toISOString() }))
      .toMatchObject({ match: "settled" });
    expect((await liq(bank)).freeMinor).toBe(58_130);
    const c = (await R.q(`SELECT status, amount_minor, evidence_status, sca FROM fleet.fleet_card_charges WHERE charge_id = $1`, [charge]))[0];
    expect(c).toEqual({ status: "booked", amount_minor: "1870", evidence_status: "settled", sca: "frictionless" });
    expect(Number(await R.one(`fleet.fleet_ledger_balance('fleet:card:payable')`))).toBe(payableBefore); // no card payable in debit mode
    expect((await cash()) - cashBefore).toBe(130); // the hold reserved 2,000; the bank took 1,870; the rest is the agent's again
    expect(await R.one(`(SELECT reserved_minor FROM fleet.fleet_card_charges WHERE charge_id = $1)`, [charge])).toBe("0");
    await verify();
  });

  it("a decline releases the hold; a merchant refund reduces the charge; a hold the bank never shows is released, never booked at its maximum", async () => {
    const h1 = await hold(1_000);
    expect(await txn({ externalId: "SB-CARD-2", status: "declined", direction: "out", kind: "card", amountMinor: 1_000, descriptor: "SHOP LTD", authorisedAt: new Date().toISOString() }))
      .toMatchObject({ match: "declined" });
    expect(await R.one(`(SELECT status || '/' || evidence_status FROM fleet.fleet_card_charges WHERE charge_id = $1)`, [h1.charge.chargeId])).toBe("void/declined");
    // A partial refund of the booked 1,870 charge.
    const booked = await R.one<string>(`(SELECT charge_id::text FROM fleet.fleet_card_charges WHERE status = 'booked' AND location_id IS NOT NULL)`);
    expect(await txn({ externalId: "SB-REF-1", status: "settled", direction: "in", kind: "card_refund", amountMinor: 370, descriptor: "Shop Ltd refund", settledAt: new Date().toISOString() }))
      .toMatchObject({ match: "refund" });
    expect(await R.one(`(SELECT amount_minor FROM fleet.fleet_card_charges WHERE charge_id = $1)`, [booked])).toBe("1500");
    // A hold the bank never shows: after the agent's 24 h, nothing happens; after 7 days it is released — never booked at maximum.
    const h2 = await hold(900);
    await R.q(`UPDATE fleet.fleet_card_charges SET declare_by = now() - interval '1 hour' WHERE charge_id = $1`, [h2.charge.chargeId]);
    await svc.query(`SELECT fleet.svc_card_holds_expire(50)`);
    expect(await R.one(`(SELECT status FROM fleet.fleet_card_charges WHERE charge_id = $1)`, [h2.charge.chargeId])).toBe("held");
    // Test-only aging: a charge's creation time is otherwise immutable.
    await R.q(`ALTER TABLE fleet.fleet_card_charges DISABLE TRIGGER fleet_card_charges_guard`);
    await R.q(`UPDATE fleet.fleet_card_charges SET created_at = now() - interval '8 days' WHERE charge_id = $1`, [h2.charge.chargeId]);
    await R.q(`ALTER TABLE fleet.fleet_card_charges ENABLE TRIGGER fleet_card_charges_guard`);
    await svc.query(`SELECT fleet.svc_card_holds_expire(50)`);
    expect(await R.one(`(SELECT status || '/' || evidence_status FROM fleet.fleet_card_charges WHERE charge_id = $1)`, [h2.charge.chargeId])).toBe("void/none");
    expect(await R.one(`(SELECT count(*) FROM fleet.fleet_events WHERE event_type = 'card_hold_booked_at_maximum')`)).toBe("0");
    await verify();
  });

  it("a challenged purchase alerts the owner (never bypassed); unexplained lines wait for the owner; a fee is a Fleet expense; drift and staleness alert; limited blocks only its location", async () => {
    const h = await hold(500);
    expect(await R.econ(F, "card.awaiting_approval", { chargeId: h.charge.chargeId })).toMatchObject({ ok: true });
    expect(await R.q(`SELECT class FROM fleet.fleet_notifications WHERE code = 'CARD_APPROVAL_NEEDED'`)).toEqual([{ class: "RED" }]);
    const fee = await txn({ externalId: "SB-FEE-1", status: "settled", direction: "out", kind: "fee", amountMinor: 300, descriptor: "MONTHLY FEE", settledAt: new Date().toISOString() });
    expect(fee.match).toBe("unmatched");
    expect((await R.one<any>(`fleet.fleet_locations_json()`)).unexplained.map((u: any) => u.txnId)).toContain(fee.txnId);
    const expBefore = Number(await R.one(`fleet.fleet_ledger_balance('fleet:expense')`));
    expect(await R.one<any>(`fleet.fleet_admin_bank_txn_classify($1, 'fee', 'monthly account fee', $2)`, [fee.txnId, OWNER])).toMatchObject({ ok: true, classified: "fee" });
    expect(Number(await R.one(`fleet.fleet_ledger_balance('fleet:expense')`)) - expBefore).toBe(300);
    // Drift: a cleared balance that does not match the settled transactions between two readings.
    await balance(55_000, 55_000);
    await balance(54_000, 53_000);
    expect(Number((await R.one<any>(`fleet.fleet_location_drift($1)`, [bank])).driftMinor)).not.toBe(0);
    await R.q(`UPDATE fleet.fleet_bank_transactions SET first_seen = now() - interval '2 days' WHERE classified IS NULL`);
    await svc.query(`SELECT fleet.svc_operations_watch()`);
    const codes = (await R.q(`SELECT code FROM fleet.fleet_notifications WHERE code LIKE 'LOCATION_%' OR code = 'BANK_TRANSACTIONS_UNEXPLAINED'`)).map((r: any) => r.code);
    expect(codes).toContain("LOCATION_DRIFT");
    // Limited: card holds on the bank wait; PayPal is untouched. A limited PayPal location stops PayPal outflows (free = 0).
    await R.q(`SELECT fleet.fleet_admin_location_status($1, 'limited', 'bank review', $2)`, [bank, OWNER]);
    expect(await R.econ(F, "card.void", { chargeId: h.charge.chargeId, reason: "the bank's app challenge is with the owner" })).toMatchObject({ ok: true });
    const blocked = await hold(100);
    expect(blocked, JSON.stringify(blocked)).toMatchObject({ ok: false, code: "FLEET_LOCATION_UNAVAILABLE" });
    expect(Number((await liq(paypal)).freeMinor)).toBeGreaterThan(0);
    await R.q(`SELECT fleet.fleet_admin_location_status($1, 'limited', 'PayPal limitation', $2)`, [paypal, OWNER]);
    expect(await liq(paypal)).toMatchObject({ freeMinor: 0, stale: true, locationStatus: "limited" });
    await svc.query(`SELECT fleet.svc_operations_watch()`);
    expect((await R.q(`SELECT code FROM fleet.fleet_notifications WHERE code = 'LOCATION_UNAVAILABLE'`)).length).toBeGreaterThan(0);
    await verify();
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });
});

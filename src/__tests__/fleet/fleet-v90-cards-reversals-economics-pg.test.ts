/**
 * v90 (PostgreSQL; SIMULATED bank evidence and PayPal failure codes — no account, no money).
 *
 * Several cards: a hold takes the first active card by priority that can carry it — a debit card only from its bank's
 * fresh free cash, else the next (a credit card); naming a card uses that one or refuses. A provisional chargeback the bank
 * takes back puts the charge back up against the agent (named on the bank line, or attributed by the owner). PayPal's own
 * failure codes about our account mark the PayPal location limited (outflows wait); codes about a payee or buyer do not.
 * Unit economics: an AI call's cost is shared by the orders / ventures its tool calls acted on; support burden per order.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder, econNext } from "./fixtures/economy-registry.js";
import { liveRail, type ArmedCustody } from "./fixtures/custody-signer.js";
import { businessRefs } from "../../fleet/cognition/routed-gateway.js";

const PG_BIN = findPgBin();
const SHOP = "https://shop.example.com";

describe.skipIf(!PG_BIN)("v90 several cards, reversed chargebacks, PayPal limitation, unit economics (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let F: Founder;
  let feed: pg.Pool;
  let svc: pg.Pool;
  let rail: ArmedCustody;
  let bank = "", account = "", paypal = "";
  let n = 0;
  const rx = async (fn: string, args: unknown[]) => (await feed.query(`SELECT fleet.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) AS r`, args)).rows[0].r;
  const txn = (x: Record<string, unknown>) => rx("rx_location_txn", ["feed", bank, { currency: "GBP", source: "simulated", ...x }]);
  const now = () => new Date().toISOString();
  const hold = async (maxMinor: number, extra: Record<string, unknown> = {}) => {
    const rq = await econNext(R, F, "card.request", { accountId: account, merchant: "Shop Ltd", paypalUnavailable: "card_only_merchant", amountMinor: maxMinor, purpose: `stock assets ${++n}` });
    expect(rq.ok, JSON.stringify(rq)).toBe(true);
    return R.econ(F, "card.authorize", { requestId: rq.request.requestId, accountId: account, merchant: "Shop Ltd", maxMinor, ...extra });
  };
  const slotOf = (c: string) => R.one<string>(`(SELECT card_slot || '/' || COALESCE(location_id::text, 'credit') FROM fleet.fleet_card_charges WHERE charge_id = $1)`, [c]);

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 50_000, simulatedSettlement: false });
    [F] = R.founders;
    await R.store.grantServiceRole();
    feed = new pg.Pool({ connectionString: R.pgc.bankfeedUrl, max: 1 });
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 1 });
    rail = await liveRail(R.owner, "fleet", OWNER);
    paypal = await R.one<string>(`(SELECT location_id::text FROM fleet.fleet_money_locations WHERE rail_id = $1)`, [rail.railId]);
    await R.econ(F, "venture.create", { key: "f-shop", model: "digital_product", offer: "templates", state: "selected" });
    account = (await R.econ(F, "account.register", { platform: "shop.example.com", kind: "service", origin: SHOP, handle: "f-shop", ventureKey: "f-shop" })).accountId;
    for (const c of ["payment_card", "payment_card_2"]) await R.one(`fleet.fleet_admin_owner_identity_class_set($1, $2, NULL, 'configured', $3)`, [c, `ovault:${c}`, OWNER]);
    await R.one(`fleet.fleet_admin_identity_autonomy_set(true, ARRAY['legal_name'], true, 100_000, 200_000, '{}', 'agents may act without waiting', $1)`, [OWNER]);
    bank = (await R.one<any>(`fleet.fleet_admin_location_add('bank', 'starling', 'Starling', NULL, $1)`, [OWNER])).locationId;
    await R.q(`SELECT fleet.fleet_admin_location_status($1, 'active', NULL, $2)`, [bank, OWNER]);
    await rx("rx_location_balance", ["feed", bank, 1_000, 1_000, 0, "simulated"]);
  }, 300_000);
  afterAll(async () => { for (const p of [feed, svc]) await p?.end(); await R?.close(); });

  it("several cards: the first active card by priority that can carry the hold; a debit card only from its bank's free cash; a named card or a refusal", async () => {
    // Card 2 is a debit card on the bank (priority 1); card 1 the owner's credit card (priority 2).
    expect(await R.one<any>(`fleet.fleet_admin_card_slot_set('payment_card_2', 'Bank debit', 'debit', $1, 1, 'active', false, $2)`, [bank, OWNER])).toMatchObject({ ok: true });
    expect(await R.one<any>(`fleet.fleet_admin_card_slot_set('payment_card', 'Owner credit', 'credit', NULL, 2, 'active', false, $1)`, [OWNER])).toMatchObject({ ok: true });
    expect(await R.one<any>(`fleet.fleet_admin_card_slot_set('payment_card_3', 'x', 'debit', NULL, 1, 'active', false, $1)`, [OWNER])).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" });
    const a = await hold(400);
    expect(a.ok, JSON.stringify(a)).toBe(true);
    expect(await slotOf(a.charge.chargeId)).toBe(`payment_card_2/${bank}`); // the bank had 1 000 free
    expect((await R.econ(F, "card.declare", { chargeId: a.charge.chargeId, amountMinor: 400 })).ok).toBe(true);
    await txn({ externalId: "D-1", status: "settled", direction: "out", kind: "card", amountMinor: 400, descriptor: "SHOP LTD", settledAt: now() });
    await rx("rx_location_balance", ["feed", bank, 600, 600, 0, "simulated"]);
    // Beyond the bank's 600 free: refused — the credit card is not a fallback until the owner says so (no silent credit).
    expect(await hold(700, { merchant: "Other Shop" })).toMatchObject({ ok: false, code: "FLEET_LOCATION_INSUFFICIENT", freeMinor: 600 });
    await R.one(`fleet.fleet_admin_card_slot_set('payment_card', 'Owner credit', 'credit', NULL, 2, 'active', true, $1)`, [OWNER]);
    const b = await hold(710, { merchant: "Other Shop" });
    expect(b.ok, JSON.stringify(b)).toBe(true);
    expect(await slotOf(b.charge.chargeId)).toBe("payment_card/credit");
    expect((await R.econ(F, "card.void", { chargeId: b.charge.chargeId })).charge.status).toBe("void");
    // Naming the debit card for more than its bank holds is refused with the bank's reason.
    expect(await hold(650, { card: "payment_card_2" })).toMatchObject({ ok: false, code: "FLEET_LOCATION_INSUFFICIENT", freeMinor: 600 });
    const cards = (await R.one<any>(`fleet.fleet_locations_json()`)).cards;
    expect(cards.map((c: any) => [c.slot, c.mode, c.configured, c.fallback])).toEqual([["payment_card_2", "debit", true, false], ["payment_card", "credit", true, true]]);
  });

  it("a provisional chargeback the bank takes back puts the charge back up against the agent", async () => {
    const charge = await R.one<string>(`(SELECT charge_id::text FROM fleet.fleet_card_charges WHERE status = 'booked' AND location_id IS NOT NULL LIMIT 1)`);
    await R.one(`fleet.fleet_admin_card_dispute_open($1, 400, 'goods never delivered', $2)`, [charge, OWNER]);
    expect(await txn({ externalId: "C-1", status: "settled", direction: "in", kind: "card_refund", amountMinor: 400, descriptor: "PROVISIONAL CREDIT", settledAt: now() })).toMatchObject({ match: "dispute_won" });
    expect(await R.one(`(SELECT amount_minor FROM fleet.fleet_card_charges WHERE charge_id = $1)`, [charge])).toBe("0");
    const cash0 = Number(await R.one(`fleet.fleet_agent_cash($1)`, [F.id]));
    // The bank takes it back, naming it.
    expect(await txn({ externalId: "C-2", status: "settled", direction: "out", kind: "card", amountMinor: 400, descriptor: "CHARGEBACK REVERSAL SHOP LTD", settledAt: now() }))
      .toMatchObject({ match: "dispute_reversed" });
    expect((await R.q(`SELECT c.amount_minor, d.state FROM fleet.fleet_card_charges c JOIN fleet.fleet_card_disputes d ON d.charge_id = c.charge_id WHERE c.charge_id = $1`, [charge]))[0])
      .toEqual({ amount_minor: "400", state: "reversed" });
    expect(cash0 - Number(await R.one(`fleet.fleet_agent_cash($1)`, [F.id]))).toBe(400); // the agent bears it again
    expect(await R.q(`SELECT class FROM fleet.fleet_notifications WHERE code = 'CARD_DISPUTE_REVERSED'`)).toEqual([{ class: "AMBER" }]);
    expect((await R.one(`fleet.fleet_ledger_verify()`)).ok).toBe(true);
  });

  it("PayPal's own codes about OUR account mark the PayPal location limited (outflows wait); a payee's or buyer's codes do not", async () => {
    const co = await R.econ(F, "paypal.checkout", { venture: "f-shop", amountMinor: 900, description: "Template pack", idempotencyKey: `k-${crypto.randomUUID()}` });
    expect(co.ok, JSON.stringify(co)).toBe(true);
    const refund = (code: string) => R.q(`INSERT INTO fleet.fleet_paypal_refund_requests (checkout_id, agent_id, amount_minor, currency, reason, requested_by, idempotency_key, status, failure_code)
      VALUES ($1, $2, 100, 'GBP', 'test', 'agent', $3, 'failed', $4)`, [co.checkout.checkoutId, F.id, `refund-${crypto.randomUUID()}`, code]);
    await refund("PAYEE_ACCOUNT_RESTRICTED");
    await svc.query(`SELECT fleet.svc_operations_watch()`);
    expect(await R.one(`(SELECT status FROM fleet.fleet_money_locations WHERE location_id = $1)`, [paypal])).toBe("active");
    await refund("ACCOUNT_RESTRICTED");
    await svc.query(`SELECT fleet.svc_operations_watch()`);
    expect((await R.q(`SELECT status, status_note FROM fleet.fleet_money_locations WHERE location_id = $1`, [paypal]))[0])
      .toEqual({ status: "limited", status_note: expect.stringContaining("ACCOUNT_RESTRICTED") });
    expect(await R.q(`SELECT class FROM fleet.fleet_notifications WHERE code = 'PAYPAL_LIMITED'`)).toEqual([{ class: "RED" }]);
    expect(await R.one<any>(`fleet.fleet_location_liquidity($1)`, [paypal])).toMatchObject({ freeMinor: 0 });
  });

  it("unit economics: an AI call's cost is shared by the orders and ventures it acted on; support burden per order; the rest is general", async () => {
    expect(businessRefs({ op: "deliver", args: { orderId: "11111111-2222-3333-4444-555555555555", note: "secret text" }, venture: "f-shop" }))
      .toEqual(["venture:f-shop", "order:11111111-2222-3333-4444-555555555555"]);
    expect(businessRefs({ orderId: "not-a-uuid", venture: "Bad Key!" })).toEqual([]);
    const order = (await R.q(`SELECT order_id FROM fleet.fleet_customer_orders WHERE agent_id = $1 LIMIT 1`, [F.id]))[0].order_id;
    const log = (cents: number, refs: string[]) => R.q(`INSERT INTO fleet.fleet_cognition_log (request_id, agent_id, provider, model, outcome, input_tokens, output_tokens,
      cost_microcents, charged_cents, prompt_sha256, response_sha256, charged_microcents, tool_calls)
      VALUES (gen_random_uuid(), $1, 'anthropic', 'm', 'ok', 1, 1, 0, $2, repeat('a', 64), repeat('b', 64), $2::bigint * 1000000, $3::jsonb)`,
      [F.id, cents, JSON.stringify(refs.length ? [{ id: "t1", name: "customers", argsSha256: "x".repeat(64), refs }] : [])]);
    await log(30, [`order:${order}`]);              // 30 to the order (and so its venture)
    await log(20, [`order:${order}`, "venture:f-shop"]); // 10 + 10
    await log(7, []);                                // general
    await R.q(`INSERT INTO fleet.fleet_customer_messages (agent_id, order_id, author, body) VALUES ($2, $1, 'buyer', 'Where is my file?'), ($2, $1, 'buyer', 'Still waiting'), ($2, $1, 'agent', 'Here it is.')`, [order, F.id]);
    const e = await R.econ(F, "business.economics", { days: 30 });
    expect(e.ok).toBe(true);
    const o = e.orders.find((x: any) => x.orderId === order);
    // Direct (measured): the 30 call acted on the order alone. Allocated (estimate): half of the 20 call.
    expect(o).toMatchObject({ venture: "f-shop", aiCostMinor: 40, aiDirectMinor: 30, aiAllocatedMinor: 10, buyerMessages: 2, agentMessages: 1, deliveries: 0, revisions: 0 });
    expect(e.ventures.find((v: any) => v.venture === "f-shop")).toMatchObject({ aiCostMinor: 50, aiDirectMinor: 30, aiAllocatedMinor: 20 });
    expect(Number(e.generalAiCostMinor)).toBeGreaterThanOrEqual(7);
    const owner = await R.one<any>(`fleet.fleet_unit_economics(NULL, 30)`);
    expect(owner.orders.length).toBeGreaterThan(0);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });
});

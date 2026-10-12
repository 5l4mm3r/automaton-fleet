/**
 * Schema v71 — AI-credit purchases: provisional observations, verified promotion (PostgreSQL; simulated mailbox and custody
 * worker; no provider, no money moves):
 *  - a receipt e-mail and an unmatched treasury debit are provisional observations: no provider credit, no lot, no owner
 *    liability, no estimated amount;
 *  - treasury route: exactly one receipt ↔ exactly one debit (counterparty, window, rate are matching aids) promotes the
 *    purchase — in either order, once; ambiguity or no match → reconciliation (P2), never a guess;
 *  - owner_card route: a receipt is promoted only by the owner's confirmation;
 *  - usage beyond confirmed credit is absorbed by the purchase that paid for it (treasury: taken out of the owner payable).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";
import { liveRail, type ArmedCustody } from "./fixtures/custody-signer.js";
import { PgIdentityGateway } from "../../fleet/identity/gateway.js";
import { IdentityBroker } from "../../fleet/identity/broker.js";
import { SimulatedSharedMailProvider } from "../../fleet/identity/providers.js";
import { initIdentityState, openIdentityState, openProviderVault } from "../../fleet/identity/main.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";

const PG_BIN = findPgBin();
const USD = 100_000_000;
const SENDER = "Anthropic <support@anthropic.test>";

describe.skipIf(!PG_BIN)("v71: AI-credit purchases — provisional observations, verified promotion (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let custody: pg.Pool;
  let rail: ArmedCustody;
  let dir = "";
  let gw: PgIdentityGateway;
  let broker: IdentityBroker;
  const shared = new SimulatedSharedMailProvider("fleet@shared.fleet-mail.test");
  const W = "custody-executor";
  const cx = async (fn: string, args: unknown[]) => (await custody.query(`SELECT fleet.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) AS r`, args)).rows[0].r;
  const bal = async (a: string) => Number(await R.one(`fleet.fleet_ledger_balance($1)`, [a]));
  const credit = async () => Number(await R.one(`fleet.fleet_provider_credit_balance('anthropic')`));
  let lots0 = 0;   // lots the fixture's own recorded credit created
  const lotCount = async () => Number(await R.one(`(SELECT count(*) FROM fleet.fleet_ai_credit_lots)`)) - lots0;
  const obs = async (no: string) => (await R.q(`SELECT receipt_id, state, lot_id FROM fleet.fleet_ai_credit_receipts WHERE receipt_no = $1`, [no]))[0];
  const charge = (usd: number) => R.one(`fleet.fleet_control_charge('knowledge_review_charge', $1, $2::jsonb)`,
    [crypto.randomUUID(), JSON.stringify([{ provider: "anthropic", requestId: crypto.randomUUID(), usdMicrocents: usd }])]);
  const settle = () => R.one<Record<string, any>>(`fleet.svc_ai_credit_settle(20)`);
  const policy = (route: string) => R.one(`fleet.fleet_admin_ai_credit_policy_set('anthropic', $1, 'support@anthropic.test', $2, 1000, 5000, true, $3)`,
    [route, route === "treasury_paypal" ? "anthropic" : null, OWNER]);
  // The real shape (owner, 2026-10-12): "Your receipt from Anthropic Ireland, Limited #<order>", amounts with 20 % VAT on top.
  const receipt = async (no: string, usd: string, sender = SENDER) => {
    const net = Number(usd), vat = Math.round(net * 20) / 100, total = net + vat;
    shared.deliver({ from: sender, to: [shared.address], subject: `Your receipt from Anthropic Ireland, Limited #${no}`,
      body: `Receipt #${no}\nAPI credits\nSubtotal $${net.toFixed(2)}\nVAT (20%) $${vat.toFixed(2)}\nTotal $${total.toFixed(2)}\nAmount paid $${total.toFixed(2)}\nDate paid Oct 12, 2026` });
    await broker.tick();
  };
  const debit = async (gbpMinor: number, counterparty: string | null, at = new Date()) => {
    const tid = `D${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
    expect((await cx("cx_paypal_txn_record", [W, rail.railId, JSON.stringify({ transactionId: tid, eventCode: "T0006", initiatedAt: at.toISOString(),
      status: "S", currency: "GBP", amountMinor: -gbpMinor, feeMinor: 0 })])).ok).toBe(true);
    if (counterparty) expect((await cx("cx_paypal_txn_counterparty", [W, rail.railId, tid, "T0006", counterparty])).ok).toBe(true);
    return tid;
  };
  const events = async (type: string, reason?: string) => Number(await R.one(`(SELECT count(*) FROM fleet.fleet_events WHERE event_type = $1 AND ($2::text IS NULL OR detail ->> 'reason' = $2))`, [type, reason ?? null]));
  const attributed = async (tid: string) => (await R.q(`SELECT attributed_as FROM fleet.fleet_paypal_transactions WHERE transaction_id = $1`, [tid]))[0].attributed_as;

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000, treasuryCents: 100_000, simulatedSettlement: false });
    await R.store.grantCustodyRole();
    custody = new pg.Pool({ connectionString: R.pgc.custodyUrl, max: 2, options: "-c search_path=fleet" });
    rail = await liveRail(R.owner, "fleet", OWNER);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-v71-"));
    fs.chmodSync(dir, 0o700);
    initIdentityState(dir);
    gw = new PgIdentityGateway({ connectionString: R.pgc.identityUrl });
    const { vault, ownerVault } = openIdentityState(dir);
    broker = new IdentityBroker(gw, vault, { mail: shared, ownerVault, providerVault: openProviderVault(dir), stateFile: path.join(dir, "pending.json") });
    await broker.tick();
    await R.q(`UPDATE fleet.fleet_ai_credit_lots SET usd_remaining = 0`);   // the fixture's opening credit is set aside (no ledger effect)
    lots0 = Number(await R.one(`(SELECT count(*) FROM fleet.fleet_ai_credit_lots)`));
  }, 300_000);
  afterAll(async () => {
    await gw?.close(); await custody?.end(); await R?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("migrates to v71 with a clean audit; only the owner sets the policy; the treasury route needs a counterparty", async () => {
    expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(71);
    const audit = (await R.store.auditPrivileges()).problems;
    expect(audit, JSON.stringify(audit)).toEqual([]);
    expect(await R.code(R.one(`fleet.fleet_admin_ai_credit_policy_set('anthropic', 'owner_card', NULL, NULL, NULL, NULL, true, 'agent:x')`))).toBe("FLEET_APPROVAL_REQUIRED");
    expect(await R.code(R.one(`fleet.fleet_admin_ai_credit_policy_set('anthropic', 'treasury_paypal', NULL, NULL, NULL, NULL, true, $1)`, [OWNER]))).toMatch(/check constraint|violates/);
    expect(await R.one(`fleet.fleet_event_route('ai_credit_reconcile', '{}'::jsonb)`)).toBe("P2_IMPORTANT");
  });

  it("owner_card: a receipt is a provisional observation — no credit, lot, journal or liability — until the owner confirms it", async () => {
    await policy("owner_card");
    const c0 = await credit(), j0 = Number(await R.one(`(SELECT count(*) FROM fleet.fleet_ledger_journal)`)), p0 = await bal("fleet:owner:payable");
    await receipt("2741-6510", "25.00");
    await receipt("2741-6510", "25.00");                                         // the same receipt again
    await receipt("9999-0001", "25.00", "Someone <billing@elsewhere.test>");     // not the provider's sender
    shared.deliver({ from: SENDER, to: [shared.address], subject: "Your receipt from Anthropic Ireland, Limited", body: "Thanks." });
    // a total alone is never taken as the credit: reported, not guessed
    shared.deliver({ from: SENDER, to: [shared.address], subject: "Your receipt from Anthropic Ireland, Limited #5555-0005", body: "Amount paid $60.00" });
    await broker.tick();
    await settle();
    expect(await obs("2741-6510")).toMatchObject({ state: "provisional", lot_id: null });
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_ai_credit_receipts WHERE receipt_no = '2741-6510')`))).toBe(1);
    expect(await obs("9999-0001")).toBeUndefined();
    expect(await events("ai_credit_receipt_unparsed")).toBe(2);
    // the credit recorded is the amount before tax; tax and total are kept as shown
    expect((await R.q(`SELECT usd_cents::int AS u, tax_cents::int AS t, total_cents::int AS tot FROM fleet.fleet_ai_credit_receipts WHERE receipt_no = '2741-6510'`))[0])
      .toEqual({ u: 2_500, t: 500, tot: 3_000 });
    expect(await credit()).toBe(c0);
    expect(await lotCount()).toBe(0);
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_ledger_journal)`))).toBe(j0);
    expect(await bal("fleet:owner:payable")).toBe(p0);
    // actual usage beyond confirmed credit is owed to the owner (v69 default) and recorded as unallocated
    await charge(5 * USD);
    expect(await bal("fleet:owner:payable")).toBe(p0 + 500);
    // the owner confirms: owner-funded credit of $25, which absorbs the $5 already used
    const r = await obs("2741-6510");
    expect(await R.one(`fleet.fleet_admin_ai_credit_confirm($1, 'owner', NULL, NULL, NULL, $2)`, [r.receipt_id, OWNER])).toMatchObject({ ok: true, source: "owner", usdCents: 2_500 });
    expect(await credit()).toBe(c0 - 5 * USD + 25 * USD);   // the $5 used was already recorded as consumption
    expect(Number(await R.one(`(SELECT usd_remaining FROM fleet.fleet_ai_credit_lots WHERE external_ref = 'receipt:anthropic:2741-6510')`))).toBe(20 * USD);
    expect(await bal("fleet:owner:payable")).toBe(p0 + 500);
    expect(await R.one(`fleet.fleet_admin_ai_credit_confirm($1, 'owner', NULL, NULL, NULL, $2)`, [r.receipt_id, OWNER])).toMatchObject({ ok: false, code: "FLEET_ALREADY_CLAIMED" });
    await R.q(`UPDATE fleet.fleet_ai_credit_lots SET usd_remaining = 0`);
  });

  it("treasury route: one receipt ↔ one debit promotes the purchase; usage it paid for leaves the owner payable", async () => {
    await policy("treasury_paypal");
    const p0 = await bal("fleet:owner:payable");
    await charge(5 * USD);                                                       // runs beyond confirmed credit
    expect(await bal("fleet:owner:payable")).toBe(p0 + 500);
    await receipt("3001-0001", "25.00");
    const wrong = await debit(2_940, "Some other merchant");                     // counterparty does not match
    const off = await debit(4_500, "Anthropic, PBC");                            // implied rate far off
    expect((await settle()).detection).toMatchObject({ promoted: 0 });           // the right debit has not arrived yet
    const tid = await debit(2_940, "Anthropic Ireland, Limited");
    const s = await settle();
    expect(s.detection).toMatchObject({ promoted: 1 });
    expect(await obs("3001-0001")).toMatchObject({ state: "promoted" });
    expect(await attributed(tid)).toBe("ai_credit_purchase");
    expect(await attributed(wrong)).toBeNull();
    expect(await attributed(off)).toBeNull();
    expect(s.reclassifiedMinor).toBe(500);
    expect(await bal("fleet:owner:payable")).toBe(p0);                           // no false owner payable
    expect(await bal("fleet:ai_credits")).toBe(2_940 - 500);   // cost incl. VAT; usage at the pre-tax price
    expect((await settle()).detection).toMatchObject({ promoted: 0 });
  });

  it("a debit first and its receipt later: promoted once; a repeated receipt changes nothing", async () => {
    const n0 = await lotCount();
    const tid = await debit(1_180, "Anthropic, PBC");
    expect((await settle()).detection).toMatchObject({ promoted: 0 });           // a debit alone is never credit
    expect(await lotCount()).toBe(n0);
    await receipt("3002-0002", "10.00");
    expect((await settle()).detection).toMatchObject({ promoted: 1 });
    await receipt("3002-0002", "10.00");
    await settle();
    expect(await lotCount()).toBe(n0 + 1);
    expect(await attributed(tid)).toBe("ai_credit_purchase");
  });

  it("ambiguity and missing evidence go to reconciliation, never to a guess; the owner resolves them", async () => {
    const n0 = await lotCount(), c0 = await credit();
    // two debits could match one receipt → ambiguous; nothing promoted
    const a = await debit(1_800, "Anthropic, PBC");
    const b = await debit(1_800, "Anthropic, PBC");
    await receipt("3003-0003", "15.00");
    await settle();
    expect(await obs("3003-0003")).toMatchObject({ state: "ambiguous" });
    expect(await events("ai_credit_reconcile", "ambiguous")).toBe(1);
    expect(await lotCount()).toBe(n0);
    const r = await obs("3003-0003");
    expect(await R.one(`fleet.fleet_admin_ai_credit_confirm($1, 'treasury', $2, $3, 'T0006', $4)`, [r.receipt_id, rail.railId, b, OWNER])).toMatchObject({ ok: true, gbpMinor: 1_800 });
    expect(await attributed(b)).toBe("ai_credit_purchase");
    expect(await attributed(a)).toBeNull();
    // a receipt with no debit after the window, and a debit with no receipt after the window: reported, never credit
    await receipt("3004-0004", "20.00");
    await R.q(`UPDATE fleet.fleet_ai_credit_receipts SET observed_at = now() - interval '4 days' WHERE receipt_no = '3004-0004'`);
    await debit(1_234, "Anthropic, PBC", new Date(Date.now() - 4 * 86_400_000));
    await settle(); await settle();
    expect(await obs("3004-0004")).toMatchObject({ state: "unmatched", lot_id: null });
    expect(await events("ai_credit_reconcile", "no_debit")).toBe(1);
    expect(await events("ai_credit_reconcile", "debit_without_receipt")).toBeGreaterThanOrEqual(1);
    const before = await events("ai_credit_reconcile", "debit_without_receipt");
    await settle();
    expect(await events("ai_credit_reconcile", "debit_without_receipt")).toBe(before);   // reported once each
    expect(await lotCount()).toBe(n0 + 1);
    expect(await credit()).toBe(c0 + 15 * USD);
    // a rejected observation stays history
    expect(await R.one(`fleet.fleet_admin_ai_credit_reject($1, 'test purchase refunded', $2)`, [(await obs("3004-0004")).receipt_id, OWNER])).toMatchObject({ ok: true });
    expect(await R.one(`fleet.fleet_ledger_verify() ->> 'ok'`)).toBe("true");
  });
});

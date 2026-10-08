/**
 * Schema v48 — the PayPal treasury rail, four-key custody activation, wallet limits, card clearing and the treasury list
 * (docs/design/master-launch-specification.md §§4–6). PostgreSQL; no PayPal, no network: the custody executor's side is its
 * cx_* functions called directly, as the executor calls them.
 *
 * Proven here: custody stays off until the owner grants a bounded, expiring activation (and the raw column cannot be
 * flipped); only a PayPal treasury rail can be live; the issuer pays nothing without every key and respects the activation
 * and wallet limits; a checkout becomes revenue exactly once, only for its own amount and capture, attributed to its agent
 * and venture; refunds come from the agent with any shortfall advanced and repaid first; unmatched PayPal money is never
 * revenue; webhooks are stored unverified and only custody verifies them; card charges are the agent's expense with the
 * cash reserved for repayment, receipts are invoiced and returned (minus a net-profit-bounded sweep) or withdrawn; the
 * treasury list attributes every journal's real-cash effect.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { attest, liveRail, unpinCustody, type ArmedCustody } from "./fixtures/custody-signer.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";

const PG_BIN = findPgBin();

describe.skipIf(!PG_BIN)("v48 PayPal treasury, custody activation and card clearing (PostgreSQL)", () => {
  let R: EconomyRegistry;
  let F: Founder;
  let G: Founder;
  let svc: pg.Pool;
  let custody: pg.Pool;
  let su: pg.Pool;
  let rail: ArmedCustody;
  const cx = async (fn: string, args: unknown[]) => {
    const ph = args.map((_, i) => `$${i + 1}`).join(", ");
    return (await custody.query(`SELECT fleet.${fn}(${ph}) AS r`, args)).rows[0].r;
  };
  const cash = (who: Founder) => R.balance(`agent:${who.id}:cash`);
  const events = async (type: string) => Number(await R.one(`(SELECT count(*) FROM fleet.fleet_events WHERE event_type = $1)`, [type]));
  const spend = async (who: Founder, destinationId: string, amountCents: number) => {
    const r = await R.gw.spendRequest(who.id, who.token, { idempotencyKey: `s:${crypto.randomUUID()}`, amountCents, category: "expense", destinationId, purpose: "venture cost" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return (r.order as { orderId: string }).orderId;
  };
  const issueDue = async () => (await svc.query(`SELECT fleet.svc_issue_due_instructions(50) AS r`)).rows[0].r;
  const checkout = async (who: Founder, venture: string, amountMinor: number, key = crypto.randomUUID()) =>
    R.econ(who, "paypal.checkout", { venture, amountMinor, description: "A3 botanical print", idempotencyKey: `chk-${key}` });
  const openAndApprove = async (checkoutId: string) => {
    const orderId = `ORD${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
    expect((await cx("cx_paypal_checkout_update", ["custody-executor", checkoutId, "open", orderId, `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`, null])).ok).toBe(true);
    expect((await cx("cx_paypal_checkout_update", ["custody-executor", checkoutId, "approved", null, null, null])).ok).toBe(true);
    return orderId;
  };
  const capture = (checkoutId: string, captureId: string, gross: number, fee: number, currency = "GBP", status = "COMPLETED") =>
    cx("cx_paypal_capture_record", ["custody-executor", checkoutId, captureId, status, gross, fee, currency, "webhook"]);
  const capId = () => `CAP${crypto.randomBytes(6).toString("hex").toUpperCase()}`;

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000, simulatedSettlement: false });
    [F, G] = R.founders;
    await R.store.grantServiceRole();
    await R.store.grantCustodyRole();
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2, options: "-c search_path=fleet" });
    custody = new pg.Pool({ connectionString: R.pgc.custodyUrl, max: 2, options: "-c search_path=fleet" });
    su = new pg.Pool({ connectionString: R.pgc.superUrl.replace(/\/postgres$/, "/fleet_t"), max: 1 });
    for (const [who, key] of [[F, "botanical-posters"], [G, "cv-templates"]] as const) {
      expect((await R.econ(who, "venture.create", { key, model: "digital_product", offer: key, state: "selected" })).ok).toBe(true);
    }
    rail = await liveRail(R.owner, "fleet", OWNER);
  }, 240_000);
  afterAll(async () => { await svc?.end(); await custody?.end(); await su?.end(); await R?.close(); });

  it("migrates to v48 with a clean audit; custody is off and only an owner activation can turn it on; only PayPal can be live", async () => {
    expect(await R.one(`(SELECT max(version) FROM fleet.fleet_schema_migrations)`)).toBe(FLEET_PG_SCHEMA_VERSION);
    expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(48);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
    expect(await R.store.custodyStatus()).toMatchObject({ executionEnabled: false });
    expect(await R.code(R.q(`UPDATE fleet.fleet_economic_model SET custody_execution_enabled = true`))).toBe("FLEET_CUSTODY_ACTIVATION_REQUIRED");
    // Live is the PayPal treasury only, with a credential, never card / storefront / bank capabilities.
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_rail_add('gumroad', 'Owner store', 'shared', NULL, ARRAY['storefront'], 'gumroad', NULL, 'live', NULL, NULL, $1)`, [OWNER])))
      .toBe('violates check constraint "fleet_payment_rails_live_scope"');
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_rail_add('paypal', 'PayPal card', 'shared', NULL, ARRAY['card_spend'], 'paypal', $1, 'live', NULL, NULL, $2)`,
      [rail.credentialId, OWNER]))).toBe('violates check constraint "fleet_payment_rails_live_scope"');
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_rail_add('paypal', 'PayPal no cred', 'shared', NULL, ARRAY['payouts'], 'paypal', NULL, 'live', NULL, NULL, $1)`, [OWNER])))
      .toBe('violates check constraint "fleet_payment_rails_live_scope"');
    // Agents see what real money can do right now.
    const w = await R.econ(F, "wallet");
    expect(w.wallet.payments).toMatchObject({ custodyActive: false, paypalReceiving: true, payoutsLive: false });
    expect((await R.one(`fleet.fleet_ledger_verify()`)).ok).toBe(true);
  });

  it("an activation is owner-only, bounded, immutable once granted, ends on deactivation or expiry, and is logged", async () => {
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_custody_activate(1000, 2000, 24, 'go', 'agent:x')`))).toBe("FLEET_APPROVAL_REQUIRED");
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_custody_activate(1000, 2000, 3000, 'too long', $1)`, [OWNER]))).toBe("FLEET_BAD_REQUEST");
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_custody_activate(2000, 1000, 24, 'daily below instruction', $1)`, [OWNER]))).toBe("FLEET_BAD_REQUEST");
    const a1 = await unpinCustody(R.owner, "fleet", OWNER, { maxInstructionMinor: 5_000, maxDailyMinor: 6_000 });
    const st = await R.one(`fleet.fleet_custody_status()`);
    expect(st).toMatchObject({ executionEnabled: true, activation: { activationId: a1, maxInstructionMinor: 5_000, maxDailyMinor: 6_000 } });
    expect(await R.code(R.q(`UPDATE fleet.fleet_custody_activations SET max_daily_minor = 1 WHERE activation_id = $1`, [a1]))).toBe("FLEET_HISTORY_IMMUTABLE");
    expect(await R.code(R.q(`DELETE FROM fleet.fleet_custody_activations`))).toBe("FLEET_HISTORY_IMMUTABLE");
    expect((await R.one(`fleet.fleet_admin_custody_deactivate('pause', $1)`, [OWNER])).active).toBe(false);
    expect((await R.store.custodyStatus()).executionEnabled).toBe(false);
    // Expiry: the reaper switches custody off once the activation lapses.
    const a2 = await unpinCustody(R.owner, "fleet", OWNER, { hours: 1 });
    const c = await su.connect();
    try { await c.query("SET session_replication_role = replica"); await c.query(`UPDATE fleet.fleet_custody_activations SET granted_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' WHERE activation_id = $1`, [a2]); }
    finally { c.release(); }
    expect((await R.q(`SELECT * FROM fleet.fleet_custody_activation_live()`)).length).toBe(0);
    expect((await svc.query(`SELECT fleet.svc_custody_activation_expire() AS r`)).rows[0].r).toMatchObject({ active: false, expired: a2 });
    expect((await R.store.custodyStatus()).executionEnabled).toBe(false);
    for (const t of ["custody_activated", "custody_deactivated", "custody_activation_expired"]) expect(await events(t)).toBeGreaterThan(0);
    expect(await R.one(`fleet.fleet_event_route('custody_activated', '{}'::jsonb)`)).toBe("P1_HIGH");
  });

  it("the issuer pays nothing without every key, then issues within the activation and the agent's wallet limits", async () => {
    const dest = (await R.econ(F, "vendor.register", { vendorName: "Print partner", category: "manufacturer", provider: "paypal",
      reference: "paypal:print@example.com", ventureKey: "botanical-posters" })).destinationId as string;
    const o1 = await spend(F, dest, 1_000);
    expect(await issueDue()).toMatchObject({ enabled: false, issued: 0 }); // key 1 missing: no activation
    await unpinCustody(R.owner, "fleet", OWNER, { maxInstructionMinor: 5_000, maxDailyMinor: 6_000 });
    expect(await issueDue()).toMatchObject({ enabled: true, issued: 0, waiting: { FLEET_NO_CUSTODY_SIGNER: 1 } }); // key 3 missing: no signer
    expect((await attest(custody, "fleet", rail)).ok).toBe(true);
    expect(await issueDue()).toMatchObject({ issued: 1 });
    expect((await R.q(`SELECT status FROM fleet.fleet_payment_orders WHERE order_id = $1`, [o1]))[0].status).toBe("executing");
    // The activation's per-instruction maximum, then the agent's own daily wallet limit.
    const o2 = await spend(F, dest, 5_001);
    expect(await issueDue()).toMatchObject({ issued: 0, waiting: { FLEET_ACTIVATION_LIMIT: 1 } });
    await R.gw.spendCancel(F.id, F.token, o2);
    expect((await R.one(`fleet.fleet_admin_wallet_limits_set($1, NULL, 3000, NULL, NULL, 'pilot', $2)`, [F.id, OWNER])).ok).toBe(true);
    const o3 = await spend(F, dest, 2_500);
    expect(await issueDue()).toMatchObject({ issued: 0, waiting: { FLEET_WALLET_DAILY_LIMIT: 1 } });
    await R.gw.spendCancel(F.id, F.token, o3);
    expect((await R.econ(F, "wallet")).wallet.limits).toMatchObject({ maxDailyMinor: 3000 });
    await R.one(`fleet.fleet_admin_custody_deactivate('end of issuer test', $1)`, [OWNER]);
  });

  it("a checkout opens through custody and a capture becomes the agent's revenue exactly once, only at its own amount", async () => {
    const before = await cash(F);
    const key = crypto.randomUUID();
    const r = await checkout(F, "botanical-posters", 1_500, key);
    expect(r).toMatchObject({ ok: true, checkout: { status: "requested", amountMinor: 1_500, currency: "GBP", mode: "live" } });
    expect((await checkout(F, "botanical-posters", 1_500, key)).replay).toBe(true);
    expect((await R.econ(F, "paypal.checkout", { venture: "botanical-posters", amountMinor: 100, currency: "USD", description: "x print", idempotencyKey: "chk-usd-0001" })).code)
      .toBe("FLEET_CURRENCY_UNSUPPORTED");
    const id = r.checkout.checkoutId as string;
    const work = await cx("cx_paypal_work", ["custody-executor", 20]);
    expect(work.find((w: any) => w.checkoutId === id)).toMatchObject({ status: "requested", railMode: "live", vaultRef: rail.vaultRef });
    await openAndApprove(id);
    expect((await R.econ(F, "paypal.checkouts", { checkoutId: id })).checkouts[0]).toMatchObject({ status: "approved" });
    // Never another amount or currency; never twice; never a second capture.
    expect((await capture(id, capId(), 1_400, 50)).code).toBe("FLEET_PAYPAL_AMOUNT_MISMATCH");
    expect((await capture(id, capId(), 1_500, 50, "USD")).code).toBe("FLEET_PAYPAL_AMOUNT_MISMATCH");
    expect(await cash(F)).toBe(before);
    const cid = capId();
    const posted = await capture(id, cid, 1_500, 70);
    expect(posted).toMatchObject({ ok: true, status: "captured", netMinor: 1_430 });
    expect(await cash(F)).toBe(before + 1_430);
    expect((await capture(id, cid, 1_500, 70)).replay).toBe(true);
    expect((await capture(id, capId(), 1_500, 70)).code).toBe("FLEET_PAYPAL_CONFLICT");
    expect(await cash(F)).toBe(before + 1_430);
    expect(await R.one(`(SELECT count(*)::int FROM fleet.fleet_revenue_claims WHERE claim_key = $1 AND claim_kind = 'paypal_capture')`, [`paypal:capture:${cid}`])).toBe(1);
    expect(await R.one(`(SELECT cost_category FROM fleet.fleet_venture_journals WHERE journal_id = $1)`, [posted.journalId])).toBe("revenue");
    expect((await R.econ(F, "performance")).ok).toBe(true);
    // The treasury list attributes it to F: money in, net of the fee; G's filter does not see it.
    const tF = await R.one(`fleet.fleet_treasury_transactions($1, 20, NULL, 'in')`, [F.id]);
    expect(tF.items.find((i: any) => i.journalId === posted.journalId)).toMatchObject({ direction: "in", amountMinor: 1_430, feesMinor: 70, revenueMinor: 1_500, agentId: F.id });
    const tG = await R.one(`fleet.fleet_treasury_transactions($1, 200, NULL, NULL)`, [G.id]);
    expect(tG.items.some((i: any) => i.journalId === posted.journalId)).toBe(false);
    // A cancelled checkout cannot be reopened by the agent; an expired one is closed by the work poll.
    const c2 = (await checkout(G, "cv-templates", 900)).checkout.checkoutId;
    expect((await R.econ(G, "paypal.cancel", { checkoutId: c2 })).checkout.status).toBe("cancelled");
    expect((await R.econ(G, "paypal.cancel", { checkoutId: c2 })).code).toBe("FLEET_INVALID_STATE");
    expect(await R.code(R.q(`UPDATE fleet.fleet_paypal_checkouts SET amount_minor = 1 WHERE checkout_id = $1`, [id]))).toBe("FLEET_IMMUTABLE");
  });

  it("card clearing: a charge is the agent's expense with the cash reserved for repayment; the treasury covers any shortfall", async () => {
    const before = await cash(G);
    const treasury = await R.balance("fleet:treasury:unallocated");
    const ch = await R.one(`fleet.fleet_admin_card_charge_record($1, $2, 'Hosting Ltd', 'stmt-2026-10-01-a', $3)`, [G.id, before + 500, OWNER]);
    expect(ch).toMatchObject({ ok: true, agentPartMinor: before, treasuryPartMinor: 500 });
    expect(await cash(G)).toBe(0);
    expect(await R.balance("fleet:treasury:unallocated")).toBe(treasury - 500);
    expect(await R.balance("fleet:card:payable")).toBe(before + 500);
    expect(await R.balance("fleet:card:reserve")).toBe(before + 500);
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_card_charge_record($1, 100, 'Hosting Ltd', 'stmt-2026-10-01-a', $2)`, [G.id, OWNER]))).toBe("FLEET_ALREADY_CLAIMED");
    // Statement says 200 less: the treasury share is given back first.
    const conf = await R.one(`fleet.fleet_admin_card_charge_confirm($1, $2, 'stmt-2026-10-01-a', $3)`, [ch.chargeId, before + 300, OWNER]);
    expect(conf).toMatchObject({ agentPartMinor: before, treasuryPartMinor: 300 });
    expect(await R.balance("fleet:treasury:unallocated")).toBe(treasury - 300);
    // Repayment: never more than is owed; recorded once per reference.
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_card_repayment_record($1, 'pp-repay-1', $2)`, [before + 301, OWNER]))).toBe("FLEET_BAD_REQUEST");
    expect((await R.one(`fleet.fleet_admin_card_repayment_record(1000, 'pp-repay-1', $1)`, [OWNER])).outstandingMinor).toBe(before + 300 - 1000);
    expect((await R.one(`fleet.fleet_admin_card_repayment_record(1000, 'pp-repay-1', $1)`, [OWNER])).replay).toBe(true);
    expect(await R.balance("fleet:card:reserve")).toBe(await R.balance("fleet:card:payable"));
    const tx = await R.one(`fleet.fleet_treasury_transactions(NULL, 5, NULL, 'out')`);
    expect(tx.items[0]).toMatchObject({ kind: "card_repayment", amountMinor: 1000 });
  });

  it("a refund comes from the agent's cash; a shortfall is advanced and repaid first from its next receipt", async () => {
    // G has no cash (the card charge above): its first sale, then a full refund.
    const c1 = (await checkout(G, "cv-templates", 2_000)).checkout.checkoutId;
    await openAndApprove(c1);
    const cap1 = capId();
    expect((await capture(c1, cap1, 2_000, 100)).netMinor).toBe(1_900);
    expect(await cash(G)).toBe(1_900);
    const ref = await cx("cx_paypal_refund_record", ["custody-executor", cap1, "REF-000001", "refund", 2_000, "GBP"]);
    expect(ref).toMatchObject({ ok: true, fromCashMinor: 1_900, advancedMinor: 100 });
    expect(await cash(G)).toBe(0);
    expect(await R.balance(`agent:${G.id}:provider_payable`)).toBe(100);
    expect((await cx("cx_paypal_refund_record", ["custody-executor", cap1, "REF-000001", "refund", 2_000, "GBP"])).replay).toBe(true);
    expect((await cx("cx_paypal_refund_record", ["custody-executor", "CAPUNKNOWN01", "REF-000002", "refund", 10, "GBP"])).code).toBe("FLEET_NOT_FOUND");
    expect(await events("paypal_refund_unmatched")).toBe(1);
    // The next receipt repays the advance first.
    const c2 = (await checkout(G, "cv-templates", 1_000)).checkout.checkoutId;
    await openAndApprove(c2);
    expect((await capture(c2, capId(), 1_000, 0)).payableRepaidMinor).toBe(100);
    expect(await cash(G)).toBe(900);
    expect(await R.balance(`agent:${G.id}:provider_payable`)).toBe(0);
    expect(await R.balance("fleet:provider:advances")).toBe(0);
  });

  it("Transaction Search reconciles checkouts; unmatched PayPal money is never revenue until the owner says what it was", async () => {
    const c = (await checkout(F, "botanical-posters", 700)).checkout.checkoutId;
    await openAndApprove(c);
    const cid = capId();
    const txn = (o: Record<string, unknown>) => cx("cx_paypal_txn_record", ["custody-executor", rail.railId, JSON.stringify({ eventCode: "T0006", initiatedAt: new Date().toISOString(),
      status: "S", currency: "GBP", feeMinor: -30, ...o })]);
    expect(await txn({ transactionId: cid, amountMinor: 700, customField: c })).toMatchObject({ ok: true, checkoutId: c, needsCapturePost: true });
    const before = await cash(F);
    const unmatched = `TXN${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
    expect(await txn({ transactionId: unmatched, eventCode: "T0000", amountMinor: 5_000 })).toMatchObject({ ok: true, checkoutId: null, needsCapturePost: false });
    expect(await cash(F)).toBe(before);
    expect((await R.one(`fleet.fleet_paypal_status()`)).unmatched.map((u: any) => u.transactionId)).toContain(unmatched);
    expect((await R.one(`fleet.fleet_reconcile()`)).findings.map((f: any) => f.code)).toContain("PAYPAL_UNMATCHED_RECEIPTS");
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_paypal_txn_attribute($1, $2, 'T0000', 'owner_funding', 'paypal:nothing-recorded', $3)`, [rail.railId, unmatched, OWNER])))
      .toBe("FLEET_BAD_REQUEST");
    expect((await R.one(`fleet.fleet_admin_paypal_txn_attribute($1, $2, 'T0000', 'not_revenue', NULL, $3)`, [rail.railId, unmatched, OWNER])).rows).toBe(1);
    expect((await R.one(`fleet.fleet_paypal_status()`)).unmatched.map((u: any) => u.transactionId)).not.toContain(unmatched);
    // The reconciler posts the capture it found (exactly as a webhook would).
    expect((await cx("cx_paypal_capture_record", ["custody-executor", c, cid, "COMPLETED", 700, 30, "GBP", "transaction_search"])).netMinor).toBe(670);
    expect(await txn({ transactionId: cid, amountMinor: 700, customField: c })).toMatchObject({ needsCapturePost: false });
    expect(await cx("cx_paypal_balance_record", ["custody-executor", rail.railId, "GBP", 123_45, 123_45])).toMatchObject({ ok: true });
    expect((await R.one(`fleet.fleet_treasury_health()`)).paypal.latestBalance).toMatchObject({ availableMinor: 12_345 });
  });

  it("webhooks are stored unverified by the controller, deduplicated, and only custody verifies them; roles stay apart", async () => {
    const recv = (id: string) => svc.query(`SELECT fleet.svc_paypal_webhook_receive($1, 'PAYMENT.CAPTURE.COMPLETED', 'CAP0000001', $2::jsonb, $3) AS r`,
      [id, JSON.stringify({ "paypal-transmission-id": "t-1", "paypal-auth-algo": "SHA256withRSA" }), JSON.stringify({ id, event_type: "PAYMENT.CAPTURE.COMPLETED" })]).then((r) => r.rows[0].r);
    expect(await recv("WH-0000000001")).toMatchObject({ ok: true, duplicate: false });
    expect(await recv("WH-0000000001")).toMatchObject({ ok: true, duplicate: true });
    expect((await svc.query(`SELECT fleet.svc_paypal_webhook_receive('bad id!', 'X', NULL, '{}'::jsonb, '{}') AS r`)).rows[0].r.code).toBe("FLEET_BAD_REQUEST");
    const inbox = await cx("cx_paypal_inbox", ["custody-executor", 10]);
    expect(inbox.find((w: any) => w.eventId === "WH-0000000001")).toMatchObject({ status: "received" });
    expect((await cx("cx_paypal_inbox_result", ["custody-executor", "WH-0000000001", "processed", "skipped"])).ok).toBe(false); // must be verified first
    expect((await cx("cx_paypal_inbox_result", ["custody-executor", "WH-0000000001", "rejected", "signature did not verify"])).ok).toBe(true);
    expect(await R.code(R.q(`UPDATE fleet.fleet_paypal_webhook_inbox SET body = '{}'`))).toBe("FLEET_IMMUTABLE");
    expect(await R.code(svc.query(`SELECT fleet.cx_paypal_inbox('svc', 1)`))).toBe("permission denied");
    const agent = new pg.Pool({ connectionString: R.pgc.agentUrl, max: 1, options: "-c search_path=fleet" });
    try {
      expect(await R.code(agent.query(`SELECT fleet.svc_paypal_webhook_receive('WH-0000000009', 'X.Y', NULL, '{}'::jsonb, '{}')`))).toBe("permission denied");
      expect(await R.code(agent.query(`SELECT fleet.cx_paypal_capture_record('a', gen_random_uuid(), 'CAP00001', 'COMPLETED', 1, 0, 'GBP', 'webhook')`))).toBe("permission denied");
    } finally { await agent.end(); }
    expect(await R.code(custody.query(`SELECT fleet.fleet_admin_card_repayment_record(1, 'x1', 'operator:owner')`))).toBe("permission denied");
  });

  it("money paid to the card is invoiced, then returned minus a net-profit-bounded sweep, or kept as an owner withdrawal", async () => {
    const before = await cash(F);
    const e0 = await R.one(`fleet.fleet_agent_economics($1)`, [F.id]);
    const inv = await R.one(`fleet.fleet_admin_card_receipt_record($1, 2_000, 'revenue', 'card-in-0001', 'buyer paid by card link', $2)`, [F.id, OWNER]);
    expect(inv).toMatchObject({ ok: true, invoice: { amountMinor: 2_000 } });
    expect(await cash(F)).toBe(before); // owed back, not spendable
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_card_receipt_record($1, 2_000, 'revenue', 'card-in-0001', NULL, $2)`, [F.id, OWNER]))).toBe("FLEET_ALREADY_CLAIMED");
    const e1 = await R.one(`fleet.fleet_agent_economics($1)`, [F.id]);
    expect(Number(e1.externalCustomerRevenue) - Number(e0.externalCustomerRevenue)).toBe(2_000);
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_card_receipt_resolve($1, 'return', 2_001, 'pp-in-1', $2)`, [inv.receiptId, OWNER]))).toBe("FLEET_BAD_REQUEST");
    const ret = await R.one(`fleet.fleet_admin_card_receipt_resolve($1, 'return', 300, 'pp-in-1', $2)`, [inv.receiptId, OWNER]);
    expect(ret).toMatchObject({ status: "returned", returnedMinor: 1_700, sweepMinor: 300 });
    expect(await cash(F)).toBe(before + 1_700);
    const e2 = await R.one(`fleet.fleet_agent_economics($1)`, [F.id]);
    expect(Number(e2.lifetimeContribution) - Number(e1.lifetimeContribution)).toBe(300);
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_card_receipt_resolve($1, 'withdrawal', NULL, NULL, $2)`, [inv.receiptId, OWNER]))).toBe("FLEET_INVALID_STATE");
    // A refund paid to the card: kept by the owner as a withdrawal (the agent neither gains nor loses).
    const r2 = await R.one(`fleet.fleet_admin_card_receipt_record($1, 400, 'refund', 'card-in-0002', 'merchant refund', $2)`, [F.id, OWNER]);
    expect(r2.invoice.suggestedSweepMinor).toBe(0);
    const wd0 = await R.balance("fleet:owner:withdrawals");
    expect((await R.one(`fleet.fleet_admin_card_receipt_resolve($1, 'withdrawal', NULL, NULL, $2)`, [r2.receiptId, OWNER])).withdrawnMinor).toBe(400);
    expect(await R.balance("fleet:owner:withdrawals")).toBe(wd0 + 400);
    expect(await R.balance(`agent:${F.id}:card_receivable`)).toBe(0);
    const clr = await R.one(`fleet.fleet_card_clearing()`);
    expect(clr.invoices.filter((i: any) => i.status === "invoiced")).toEqual([]);
    for (const t of ["card_receipt_recorded", "card_receipt_returned", "card_receipt_withdrawn", "card_charge_booked", "card_repayment_recorded"]) expect(await events(t)).toBeGreaterThan(0);
  });

  it("treasury health is consistent with the ledger; the ledger verifies; the audit stays clean", async () => {
    const h = await R.one(`fleet.fleet_treasury_health()`);
    expect(h.cardOutstandingMinor).toBe(await R.balance("fleet:card:payable"));
    expect(h.partitions.cardReserveMinor).toBe(h.cardOutstandingMinor);
    expect(h.contributions.map((c: any) => c.agentId).sort()).toEqual([F.id, G.id].sort());
    expect(h.custody.active).toBe(false);
    const findings = (await R.one(`fleet.fleet_reconcile()`)).findings.map((f: any) => f.code);
    expect(findings).not.toContain("CARD_RESERVE_MISMATCH");
    expect((await R.one(`fleet.fleet_ledger_verify()`)).ok).toBe(true);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });
});

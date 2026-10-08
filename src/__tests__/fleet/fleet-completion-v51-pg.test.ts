/**
 * Schema v51 — the completion pass (docs/design/master-launch-specification.md, revision 2). PostgreSQL; custody, the
 * browser worker and the identity broker are their database roles, called directly.
 *
 * Proven here:
 *  - the authoritative wallet measure: own money only held (a card hold, a PayPal capture awaiting availability) keeps an
 *    agent alive; Fleet envelope capital and an open checkout do not; exhaustion is death at the next pass;
 *  - a card hold reserves first (own capital or an envelope), is refused beyond it, books once from the reservation and
 *    returns the rest; a statement larger than the hold is advanced against the agent's payable (a debt), a smaller one
 *    gives back in reverse order; expense is booked exactly once;
 *  - a card receipt applied to the card balance frees the reserve and lowers the card liability; the swept share is the
 *    agent's contribution (the dynamic sweep never takes it twice);
 *  - PayPal: captured money is held until Transaction Search shows status S and the Balances reading covers it;
 *  - custody activation: an ongoing activation has no expiry and survives the reaper; a pilot still expires;
 *  - capital decisions weigh runway vs payback; a new agent needs no track record; sweep-reduction requests are decided at once;
 *  - documents: uploaded only under the owner's document authority, logged, never shown; the step grammar names a class;
 *  - freeze: queued identity jobs stop and new ones are refused; the result says the provider account is not closed;
 *  - knowledge revision 2: every hard rule names its basis; no "one account per platform" rule; recommendations returned;
 *  - provider secrets sealed to the broker: stored as ciphertext until installed; agents cannot reach them.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { liveRail, type ArmedCustody } from "./fixtures/custody-signer.js";
import { generateX25519 } from "../../fleet/identity/crypto.js";
import { KNOWLEDGE_LIBRARY_V2 } from "../../fleet/postgres/knowledge-library-v2.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";

const PG_BIN = findPgBin();
const SHOP = "https://shop.example.com";

describe.skipIf(!PG_BIN)("v51 completion: exhaustion, card reservations, PayPal availability, documents, freeze, knowledge r2 (PostgreSQL)", () => {
  let R: EconomyRegistry;
  let F: Founder; // the card / document agent
  let G: Founder; // the PayPal agent
  let H: Founder; // the survival agent
  let svc: pg.Pool;
  let custody: pg.Pool;
  let browser: pg.Pool;
  let identity: pg.Pool;
  let su: pg.Pool;
  let rail: ArmedCustody;
  let account = "";
  const pub = generateX25519().publicKeyDer.toString("base64");
  const one = async (db: pg.Pool, sql: string, params: unknown[] = []) => (await db.query(`SELECT ${sql} AS r`, params)).rows[0].r;
  const cx = (fn: string, args: unknown[]) => one(custody, `fleet.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")})`, args);
  const cash = (who: Founder) => R.balance(`agent:${who.id}:cash`);
  const measure = (who: Founder) => R.one(`fleet.fleet_agent_wallet_measure($1)`, [who.id]);
  const tick = async () => (await svc.query(`SELECT fleet.svc_insolvency_tick() AS r`)).rows[0].r;
  const status = async (who: Founder) => (await R.q(`SELECT status FROM fleet.fleet_agents WHERE agent_id = $1`, [who.id]))[0].status;
  const asSuper = async (sql: string, params: unknown[] = []) => {
    const c = await su.connect();
    try { await c.query("SET session_replication_role = replica"); await c.query(sql, params); } finally { c.release(); }
  };
  const capId = () => `CAP${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
  const paidCheckout = async (who: Founder, venture: string, gross: number, fee: number) => {
    const ck = await R.econ(who, "paypal.checkout", { venture, amountMinor: gross, description: "a printable planner", idempotencyKey: `chk-${crypto.randomUUID()}` });
    expect(ck.ok, JSON.stringify(ck)).toBe(true);
    const id = ck.checkout.checkoutId as string;
    const order = `ORD${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
    await cx("cx_paypal_checkout_update", ["custody-executor", id, "open", order, `https://www.paypal.com/checkoutnow?token=${order}`, null]);
    await cx("cx_paypal_checkout_update", ["custody-executor", id, "approved", null, null, null]);
    const cap = capId();
    expect((await cx("cx_paypal_capture_record", ["custody-executor", id, cap, "COMPLETED", gross, fee, "GBP", "webhook"])).ok).toBe(true);
    return { checkoutId: id, captureId: cap };
  };
  const txnS = (checkoutId: string, captureId: string, gross: number) => cx("cx_paypal_txn_record", ["custody-executor", rail.railId, JSON.stringify({
    transactionId: captureId, eventCode: "T0006", initiatedAt: new Date().toISOString(), status: "S", currency: "GBP", amountMinor: gross, feeMinor: 0, customField: checkoutId })]);
  const balance = (available: number) => cx("cx_paypal_balance_record", ["custody-executor", rail.railId, "GBP", available, available + 1_000]);
  const availability = async () => (await svc.query(`SELECT fleet.svc_paypal_availability(100) AS r`)).rows[0].r;
  const configure = (cls: string) => R.one(`fleet.fleet_admin_owner_identity_class_set($1, $2, NULL, 'configured', $3)`, [cls, `ovault:${cls}`, OWNER]);
  const claim = async () => {
    const o = await R.econ(F, "browser.open", { url: `${SHOP}/verify`, accountId: account });
    expect(o.ok, JSON.stringify(o)).toBe(true);
    const lease = crypto.randomBytes(16).toString("hex");
    for (;;) {
      const c = await one(browser, `fleet.bx_claim_action('browser-worker', $1)`, [crypto.createHash("sha256").update(lease).digest("hex")]);
      if (c.action.actionId === o.actionId) return { actionId: o.actionId as string, lease, sessionId: o.sessionId as string };
      await one(browser, `fleet.bx_report_action($1, $2, true, '{}'::jsonb, NULL)`, [c.action.actionId, lease]);
    }
  };
  const done = async (a: { actionId: string; lease: string; sessionId: string }) => {
    await one(browser, `fleet.bx_report_action($1, $2, true, '{}'::jsonb, NULL)`, [a.actionId, a.lease]);
    await R.econ(F, "browser.close", { sessionId: a.sessionId });
  };

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 3, allocationCents: 10_000, simulatedSettlement: false });
    [F, G, H] = R.founders;
    for (const g of ["grantServiceRole", "grantBrowserRole", "grantIdentityRole", "grantCustodyRole"] as const) await R.store[g]();
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2 });
    custody = new pg.Pool({ connectionString: R.pgc.custodyUrl, max: 2 });
    browser = new pg.Pool({ connectionString: R.pgc.browserUrl, max: 2 });
    identity = new pg.Pool({ connectionString: R.pgc.identityUrl, max: 2 });
    su = new pg.Pool({ connectionString: R.pgc.superUrl.replace(/\/postgres$/, "/fleet_t"), max: 1 });
    for (const [who, key] of [[F, "f-shop"], [G, "g-prints"], [H, "h-guides"]] as const) {
      expect((await R.econ(who, "venture.create", { key, model: "digital_product", offer: key, state: "selected" })).ok).toBe(true);
    }
    rail = await liveRail(R.owner, "fleet", OWNER);
    const reg = await R.econ(F, "account.register", { platform: "shop.example.com", kind: "service", origin: SHOP, handle: "f-shop" });
    expect(reg.ok, JSON.stringify(reg)).toBe(true);
    account = reg.accountId;
    await configure("payment_card");
    await R.one(`fleet.fleet_admin_identity_autonomy_set(true, ARRAY['legal_name'], true, 50_000, 100_000, '{}', 'agents may act without waiting', $1)`, [OWNER]);
  }, 300_000);
  afterAll(async () => { for (const p of [svc, custody, browser, identity, su]) await p?.end(); await R?.close(); });

  it("migrates to v51 with a clean audit", async () => {
    expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(51);
    expect(await R.one(`(SELECT max(version) FROM fleet.fleet_schema_migrations)`)).toBe(FLEET_PG_SCHEMA_VERSION);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });

  it("a card hold reserves first; is refused beyond the agent's own capital; books once and returns the rest", async () => {
    const c0 = await cash(F);
    expect((await R.econ(F, "card.authorize", { accountId: account, merchant: "Big Shop", maxMinor: c0 + 1 })).code).toBe("FLEET_INSUFFICIENT_FUNDS");
    const h = await R.econ(F, "card.authorize", { accountId: account, merchant: "Shop Ltd", maxMinor: 4_000, purpose: "a domain and hosting" });
    expect(h).toMatchObject({ ok: true, charge: { funding: "own", reservedMinor: 4_000, status: "held" } });
    expect(await cash(F)).toBe(c0 - 4_000);
    // Held own money still counts as the agent's.
    const m = await measure(F);
    expect(m.ownHeldMinor.cardHoldsMinor).toBe(4_000);
    expect(m.exhausted).toBe(false);
    const exp0 = await R.balance(`agent:${F.id}:expense`);
    const d = await R.econ(F, "card.declare", { chargeId: h.charge.chargeId, amountMinor: 1_500 });
    expect(d.charge).toMatchObject({ status: "booked", amountMinor: 1_500, fromYourCashMinor: 1_500 });
    expect(await cash(F)).toBe(c0 - 1_500);
    expect(await R.balance(`agent:${F.id}:reserved`)).toBe(0);
    expect(await R.balance(`agent:${F.id}:expense`)).toBe(exp0 + 1_500); // once
    expect(await R.balance("fleet:card:payable")).toBe(1_500);
    // The statement says 2 100: the extra 600 comes from the agent's cash (no treasury gift).
    const up = await R.one(`fleet.fleet_admin_card_charge_confirm($1, 2_100, 'stmt-a', $2)`, [h.charge.chargeId, OWNER]);
    expect(up).toMatchObject({ agentPartMinor: 2_100, treasuryPartMinor: 0, advancedMinor: 0 });
    expect(await R.balance(`agent:${F.id}:expense`)).toBe(exp0 + 2_100);
    // And back down to 1 800: 300 returns to the agent.
    const down = await R.one(`fleet.fleet_admin_card_charge_confirm($1, 1_800, 'stmt-b', $2)`, [h.charge.chargeId, OWNER]);
    expect(down).toMatchObject({ agentPartMinor: 1_800 });
    expect(await cash(F)).toBe(c0 - 1_800);
    expect(await R.balance("fleet:card:payable")).toBe(1_800);
    expect(await R.balance("fleet:card:reserve")).toBe(1_800);
  });

  it("an envelope (a recorded Fleet Control allocation) can fund a hold; nothing else reaches treasury money", async () => {
    const req = await R.econ(F, "capital.request", { ventureKey: "f-shop", purpose: "print stock", amountMinor: 3_000, evidence: [{ observation: "pilot sales of 12 prints", source: "own sales" }, { observation: "two printer quotes", source: "quotes" }],
      expectedRevenueMinor: 9_000, expectedNetMinor: 4_000, expectedPaybackDays: 20, downsideMinor: 3_000, confidenceBp: 7_000, alternativePlan: "smaller run",
      alternativeMinor: 1_000, idempotencyKey: `cap-${crypto.randomUUID()}` });
    expect(req.ok, JSON.stringify(req)).toBe(true);
    expect(req.envelope, JSON.stringify(req)).toBeTruthy();
    expect(req.envelope).toBeTruthy();
    const env = req.envelope.envelopeId as string;
    const c0 = await cash(F);
    const h = await R.econ(F, "card.authorize", { accountId: account, merchant: "Printer Co", maxMinor: 1_000, envelopeId: env });
    expect(h).toMatchObject({ ok: true, charge: { funding: "envelope", envelopeId: env, reservedMinor: 1_000 } });
    expect(await cash(F)).toBe(c0); // the agent's own cash is untouched
    const pos = (await R.econ(F, "envelope.list")).envelopes.find((e: any) => e.envelopeId === env).position;
    expect(pos.reservedMinor).toBe(1_000);
    const d = await R.econ(F, "card.declare", { chargeId: h.charge.chargeId, amountMinor: 800 });
    expect(d.charge).toMatchObject({ amountMinor: 800, fromEnvelopeMinor: 800 });
    const pos2 = (await R.econ(F, "envelope.list")).envelopes.find((e: any) => e.envelopeId === env).position;
    expect(pos2).toMatchObject({ reservedMinor: 0, spentMinor: 800 });
    // Not one of your envelopes → refused.
    expect((await R.econ(F, "card.authorize", { accountId: account, merchant: "Printer Co", maxMinor: 10, envelopeId: crypto.randomUUID() })).code)
      .toBe("FLEET_ENVELOPE_UNAVAILABLE");
  });

  it("a statement beyond what the agent can cover is advanced against its payable (a debt), repaid first from later money", async () => {
    const c0 = await cash(F);
    const ch = await R.one(`fleet.fleet_admin_card_charge_record($1, $2, 'Ads Ltd', 'stmt-ads-1', $3)`, [F.id, c0 + 700, OWNER]);
    expect(ch).toMatchObject({ agentPartMinor: c0, treasuryPartMinor: 700, advancedMinor: 700 });
    expect(await cash(F)).toBe(0);
    expect(await R.balance(`agent:${F.id}:provider_payable`)).toBe(700);
    expect(Number((await R.one(`fleet.fleet_agent_economics($1)`, [F.id])).survivalEquity)).toBeLessThan(1);
    expect(await R.one(`fleet.fleet_event_route('card_charge_advanced', '{}'::jsonb)`)).toBe("P1_HIGH");
    // Statement corrected by 900: the advance (700) goes back first, then 200 to the agent's cash.
    const down = await R.one(`fleet.fleet_admin_card_charge_confirm($1, $2, 'stmt-ads-1b', $3)`, [ch.chargeId, c0 - 200, OWNER]);
    expect(down).toMatchObject({ treasuryPartMinor: 0, agentPartMinor: c0 - 200 });
    expect(await R.balance(`agent:${F.id}:provider_payable`)).toBe(0);
    expect(await cash(F)).toBe(200);
  });

  it("a card receipt applied to the card balance frees the reserve; the swept share is a contribution, never swept again", async () => {
    await R.ledger.agentCapital({ agentId: F.id, amountCents: 5_000, mode: "grant", actor: OWNER });
    const pay0 = await R.balance("fleet:card:payable");
    const inv = await R.one(`fleet.fleet_admin_card_receipt_record($1, 1_000, 'refund', 'card-refund-1', 'merchant refund of the domain', $2)`, [F.id, OWNER]);
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_card_receipt_settle($1, 'return', 'card_balance', 1, NULL, $2)`, [inv.receiptId, OWNER]))).toBe("FLEET_BAD_REQUEST");
    const c0 = await cash(F);
    const r = await R.one(`fleet.fleet_admin_card_receipt_settle($1, 'return', 'card_balance', 0, NULL, $2)`, [inv.receiptId, OWNER]);
    expect(r).toMatchObject({ status: "returned", method: "card_balance", returnedMinor: 1_000, cardOutstandingMinor: pay0 - 1_000 });
    expect(await cash(F)).toBe(c0 + 1_000);
    expect(await R.balance("fleet:card:reserve")).toBe(await R.balance("fleet:card:payable"));
    // More than is owed on the card cannot be "applied to the balance".
    const big = await R.one(`fleet.fleet_admin_card_receipt_record($1, $2, 'refund', 'card-refund-2', NULL, $3)`, [F.id, pay0 + 10_000, OWNER]);
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_card_receipt_settle($1, 'withdrawal', 'card_balance', NULL, NULL, $2)`, [big.receiptId, OWNER]))).toBe("FLEET_BAD_REQUEST");
    expect((await R.one(`fleet.fleet_admin_card_receipt_settle($1, 'withdrawal', 'transfer', NULL, NULL, $2)`, [big.receiptId, OWNER])).withdrawnMinor).toBe(pay0 + 10_000);
    expect(await R.one(`fleet.fleet_event_route('card_receipt_applied', '{}'::jsonb)`)).toBe("P2_IMPORTANT");
  });

  it("PayPal money is held until Transaction Search shows it completed and the Balances reading covers it; a refund takes held money first", async () => {
    const a = await paidCheckout(G, "g-prints", 3_000, 100);
    expect(await R.balance(`agent:${G.id}:cash_pending`)).toBe(2_900);
    const c0 = await cash(G);
    expect(await availability()).toMatchObject({ released: 0 }); // no evidence
    await txnS(a.checkoutId, a.captureId, 3_000);
    await balance(1_000); // PayPal shows less available than this capture (funds on hold)
    expect(await availability()).toMatchObject({ released: 0, waitingForBalance: 1 });
    expect(await R.one(`fleet.fleet_event_route('paypal_availability_short', '{}'::jsonb)`)).toBe("P1_HIGH");
    await balance(50_000);
    expect(await availability()).toMatchObject({ released: 1 });
    expect(await cash(G)).toBe(c0 + 2_900);
    expect(await R.one(`(SELECT status FROM fleet.fleet_paypal_availability WHERE capture_id = $1)`, [a.captureId])).toBe("available");
    // A second capture refunded in part while held: from the held money first.
    const b = await paidCheckout(G, "g-prints", 2_000, 0);
    const ref = await cx("cx_paypal_refund_record", ["custody-executor", b.captureId, "REF-V51-0001", "refund", 500, "GBP"]);
    expect(ref).toMatchObject({ fromHeldMinor: 500, fromCashMinor: 0, advancedMinor: 0 });
    expect(Number(await R.one(`(SELECT remaining_minor FROM fleet.fleet_paypal_availability WHERE capture_id = $1)`, [b.captureId]))).toBe(1_500);
    const ms = await R.one(`fleet.fleet_money_states()`);
    expect(Number(ms.captured.heldUntilAvailableMinor)).toBe(1_500);
    expect(ms.paypalObserved).toMatchObject({ availableMinor: 50_000, withheldMinor: 1_000 });
    expect(Number((await R.econ(G, "wallet")).wallet.cashPendingAvailabilityMinor)).toBe(1_500);
  });

  it("exhaustion is death: held own money keeps an agent alive; envelope capital does not; the measure is shown to the agent", async () => {
    // H: its PayPal capture is held (owned) — drained cash does not kill it.
    const a = await paidCheckout(H, "h-guides", 1_200, 0);
    const c0 = await cash(H);
    await R.one(`fleet.fleet_admin_card_charge_record($1, $2, 'drain', 'stmt-h-1', $3)`, [H.id, c0, OWNER]);
    const m = await R.econ(H, "wallet.measure");
    expect(m).toMatchObject({ ok: true, spendableMinor: 0, exhausted: false, ownHeldMinor: { paypalHeldUntilAvailableMinor: 1_200 } });
    expect(m.rule).toMatch(/Exhaustion means death/);
    expect((await R.one(`fleet.fleet_survival_observation($1)`, [H.id])).wallet.exhausted).toBe(false);
    expect(await tick()).toMatchObject({ died: 0 });
    // Fully refunded while held: nothing of its own remains; envelope capital would not count either.
    await cx("cx_paypal_refund_record", ["custody-executor", a.captureId, "REF-V51-0002", "refund", 1_200, "GBP"]);
    expect((await measure(H)).exhausted).toBe(true);
    expect(await tick()).toMatchObject({ died: 1 });
    expect(await status(H)).toBe("dead");
    const d = (await R.q(`SELECT detail FROM fleet.fleet_events WHERE event_type = 'agent_died' AND agent_id = $1`, [H.id]))[0].detail;
    expect(d.cause).toBe("insolvent");
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_events WHERE event_type = 'agent_wallet_exhausted' AND agent_id = $1`, [H.id]))[0].n).toBe(1);
  });

  it("custody activation: an ongoing one has no expiry and survives the reaper; a pilot one still expires", async () => {
    const on = await R.one(`fleet.fleet_admin_custody_activate(5_000, 20_000, NULL, 'ongoing autonomous payouts', $1)`, [OWNER]);
    expect(on).toMatchObject({ ok: true, mode: "ongoing", expiresAt: null });
    expect((await svc.query(`SELECT fleet.svc_custody_activation_expire() AS r`)).rows[0].r).toMatchObject({ active: true, mode: "ongoing" });
    expect((await R.store.custodyStatus()).activation).toMatchObject({ mode: "ongoing", expiresAt: null });
    expect(await R.code(R.q(`UPDATE fleet.fleet_custody_activations SET expires_at = now() WHERE activation_id = $1`, [on.activationId]))).toBe("FLEET_HISTORY_IMMUTABLE");
    const pilot = await R.one(`fleet.fleet_admin_custody_activate(5_000, 20_000, 1, 'pilot', $1)`, [OWNER]);
    expect(pilot.mode).toBe("pilot");
    await asSuper(`UPDATE fleet.fleet_custody_activations SET granted_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE activation_id = $1`, [pilot.activationId]);
    expect((await svc.query(`SELECT fleet.svc_custody_activation_expire() AS r`)).rows[0].r).toMatchObject({ active: false });
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_custody_activate(1, 1, 2161, 'too long', $1)`, [OWNER]))).toBe("FLEET_BAD_REQUEST");
  });

  it("capital decisions weigh runway against payback; a new agent needs no track record; sweep reductions are decided at once", async () => {
    // A recurring commitment gives G a burn, so its runway is finite.
    expect((await R.econ(G, "commitment.add", { vendor: "Host", description: "VPS", amountMinor: 3_040, period: "monthly", idempotencyKey: `cm-${crypto.randomUUID()}`,
      nextDueAt: new Date(Date.now() + 86_400_000).toISOString() })).ok).toBe(true);
    const r = await R.econ(G, "capital.request", { ventureKey: "g-prints", purpose: "a larger print run", amountMinor: 2_000, evidence: [{ observation: "repeat orders", source: "sales" }, { observation: "printer quote", source: "quote" }],
      expectedRevenueMinor: 8_000, expectedNetMinor: 3_000, expectedPaybackDays: 3650, downsideMinor: 2_000, confidenceBp: 8_000, alternativePlan: "smaller",
      alternativeMinor: 500, idempotencyKey: `cap-${crypto.randomUUID()}` });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const dec = (await R.q(`SELECT outcome, reasons, inputs FROM fleet.fleet_capital_decisions d JOIN fleet.fleet_capital_requests q ON q.request_id = d.request_id
                             WHERE q.agent_id = $1 ORDER BY d.decided_at DESC LIMIT 1`, [G.id]))[0];
    expect(dec.inputs.trackRecordRequired).toBe(false);
    expect(Number(dec.inputs.agentRunwayDays)).toBeLessThan(3650);
    expect(dec.outcome).toBe("APPROVE_WITH_LIMITS");
    expect(dec.reasons).toContain("RUNWAY_SHORTER_THAN_PAYBACK");
    // G has realised profit (its PayPal sale): a reduction request is granted, bounded by the capital policy.
    const ask = await R.econ(G, "sweep.reduction_request", { reductionBp: 9_000, days: 120, reason: "reinvest in a second print series" });
    expect(ask).toMatchObject({ ok: true, status: "granted" });
    const pol = await R.one(`(SELECT to_jsonb(p) FROM fleet.fleet_capital_policy p WHERE id = 1)`);
    expect(ask.reductionBp).toBe(Math.min(9_000, pol.reinvestment_reduction_bp));
    expect(ask.days).toBe(Math.min(120, pol.envelope_days));
    expect((await R.q(`SELECT decided_by FROM fleet.fleet_sweep_rate_reductions WHERE reduction_id = $1`, [ask.reductionId]))[0].decided_by).toBe("controller");
  });

  it("documents are uploaded only under the owner's document authority — logged, sealed to the worker, never to the agent", async () => {
    await configure("passport");
    const bad = await R.econ(F, "browser.act", { sessionId: (await R.econ(F, "browser.open", { url: `${SHOP}/`, accountId: account })).sessionId,
      steps: [{ action: "upload", selector: "#doc", credential: "owner_document", class: "payment_card" }] });
    expect(bad).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" });
    const a = await claim();
    expect(await one(browser, `fleet.bx_secret_request($1, $2, 'owner_document:passport', $3, $4, NULL)`, [a.actionId, a.lease, SHOP, pub]))
      .toMatchObject({ ok: false, code: "FLEET_NO_STANDING_AUTHORITY" });
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_identity_documents_set(ARRAY['payment_card'], $1)`, [OWNER]))).toBe("FLEET_BAD_REQUEST");
    expect((await R.one(`fleet.fleet_admin_identity_documents_set(ARRAY['passport','proof_of_address'], $1)`, [OWNER])).autonomy.documentClasses).toEqual(["passport", "proof_of_address"]);
    const ok = await one(browser, `fleet.bx_secret_request($1, $2, 'owner_document:passport', $3, $4, NULL)`, [a.actionId, a.lease, SHOP, pub]);
    expect(ok).toMatchObject({ ok: true });
    expect(await one(browser, `fleet.bx_secret_request($1, $2, 'owner_document:proof_of_address', $3, $4, NULL)`, [a.actionId, a.lease, SHOP, pub]))
      .toMatchObject({ ok: false, code: "FLEET_OWNER_FACT_UNAVAILABLE" }); // allowed, not on file
    const pending = await one(identity, `fleet.ix_browser_secrets_pending('identity-broker')`);
    expect(pending.find((p: any) => p.requestId === ok.requestId)).toMatchObject({ kind: "owner_document", ownerClass: "passport" });
    expect((await R.econ(F, "identity.uses")).uses[0]).toMatchObject({ class: "passport", origin: SHOP });
    // A document travels sealed within the larger bound; any other value stays within 64 kB.
    const big = crypto.randomBytes(200_000);
    expect((await one(identity, `fleet.ix_browser_secret_serve($1, 'identity-broker', $2, NULL, NULL)`, [ok.requestId, big])).ok).toBe(true);
    await done(a);
    expect(await R.one(`fleet.fleet_event_route('identity_documents_set', '{}'::jsonb)`)).toBe("P1_HIGH");
  });

  it("freezing stops local use — queued identity jobs end and new ones are refused — and says the provider account is not closed", async () => {
    const q1 = await R.econ(F, "account.rotate", { accountId: account, idempotencyKey: `rot-${crypto.randomUUID()}` });
    expect(q1.ok, JSON.stringify(q1)).toBe(true);
    expect(await R.one(`(SELECT status FROM fleet.fleet_identity_jobs WHERE job_id = $1)`, [q1.jobId])).toBe("queued");
    const fz = await R.one(`fleet.fleet_admin_account_freeze($1, 'owner review', $2)`, [account, OWNER]);
    expect(fz.note).toMatch(/does not close or cancel it at the provider/);
    expect(await R.one(`(SELECT status FROM fleet.fleet_identity_jobs WHERE job_id = $1)`, [q1.jobId])).toBe("failed");
    const again = await R.econ(F, "account.rotate", { accountId: account, idempotencyKey: `rot-${crypto.randomUUID()}` });
    expect(again).toMatchObject({ ok: false, code: "FLEET_ACCOUNT_FROZEN" });
    expect((await R.one(`fleet.fleet_admin_account_unfreeze($1, 'active', $2)`, [account, OWNER])).status).toBe("active");
  });

  it("knowledge revision 2: every hard rule names its basis, no fleet-wide one-account rule, recommendations come back", async () => {
    for (const e of KNOWLEDGE_LIBRARY_V2.entries) for (const h of e.hardRules) expect(h).toMatch(/^(Law|Platform terms|Regulator code)/);
    expect(JSON.stringify(KNOWLEDGE_LIBRARY_V2)).not.toMatch(/more than one account on the same platform|One account per (approved|agent) identity|requires operator approval/);
    const r = await R.econ(G, "knowledge.library", { id: "channel-choose" });
    expect(r.entry).toMatchObject({ version: 2 });
    expect(r.entry.hardRules[0]).toMatch(/^Platform terms: never open or use an account to evade/);
    expect(r.entry.recommendations.join(" ")).toMatch(/each platform's own rule/);
    const tos = await R.econ(G, "knowledge.library", { id: "ethics-platform-tos" });
    expect(tos.entry.body).toMatch(/standing, revocable authority/);
  });

  it("a provider secret sealed to the broker is stored as ciphertext until the broker installs it; agents cannot reach it", async () => {
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_provider_secret_upload('gmail', '\\x00'::bytea, $1)`, [OWNER]))).toBe("FLEET_BAD_REQUEST");
    const sealed = crypto.randomBytes(256);
    const up = await R.one(`fleet.fleet_admin_provider_secret_upload('proton-bridge', $1, $2)`, [sealed, OWNER]);
    expect(up.ok).toBe(true);
    const inbox = await one(identity, `fleet.ix_provider_secret_inbox('identity-broker')`);
    expect(inbox).toEqual([expect.objectContaining({ uploadId: up.uploadId, name: "proton-bridge" })]);
    expect((await one(identity, `fleet.ix_provider_secret_installed($1, 'identity-broker', false, 'FLEET_PROVIDER_SECRET_FIELDS')`, [up.uploadId])).ok).toBe(true);
    expect(await R.one(`(SELECT sealed IS NULL FROM fleet.fleet_provider_secret_inbox WHERE upload_id = $1)`, [up.uploadId])).toBe(true);
    expect((await R.one(`fleet.fleet_provider_secrets_json()`)).uploads[0]).toMatchObject({ status: "failed", error: "FLEET_PROVIDER_SECRET_FIELDS" });
    const agentDb = new pg.Pool({ connectionString: R.pgc.agentUrl, max: 1 });
    try {
      expect(await R.code(agentDb.query(`SELECT fleet.ix_provider_secret_inbox('x')`))).toBe("permission denied");
      expect(await R.code(agentDb.query(`SELECT * FROM fleet.fleet_provider_secret_inbox`))).toBe("permission denied");
    } finally { await agentDb.end(); }
  });

  it("the audit stays clean; the ledger verifies; treasury health reports money states", async () => {
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
    expect((await R.one(`fleet.fleet_ledger_verify()`)).ok).toBe(true);
    const h = await R.one(`fleet.fleet_treasury_health()`);
    expect(h.moneyStates).toBeTruthy();
    expect(Number(h.partitions.heldPendingAvailabilityMinor)).toBe(1_500);
    expect(h.cardOutstandingMinor).toBe(await R.balance("fleet:card:payable"));
  });
});

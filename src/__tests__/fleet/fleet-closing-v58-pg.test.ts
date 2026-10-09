/**
 * Schema v58 — closing corrections. PostgreSQL + custody's cx_* calls + the identity broker (simulated shared mailbox).
 *
 * Proven here: one chargeback reported under two codes (T1106 + T1201) and by the webhook is one loss, never more than the
 * principal (a distinct fee still posts); an open dispute, PayPal's hold and an unclassified debit on the same sale are one
 * exposure, capped at the principal still in the books; a checkout promising a file is refused while mail is not configured
 * (a service one is not); a mail job that cannot reach a provider marks its delivery failed (not stuck queued); a delivery
 * that gives up and a buyer PayPal never reveals are raised for the owner with the recovery path.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { liveRail, type ArmedCustody } from "./fixtures/custody-signer.js";
import { PgIdentityGateway } from "../../fleet/identity/gateway.js";
import { IdentityBroker } from "../../fleet/identity/broker.js";
import { SimulatedSharedMailProvider } from "../../fleet/identity/providers.js";
import { initIdentityState, openIdentityState, openProviderVault } from "../../fleet/identity/main.js";
import { EVENT_ROUTES_V58 } from "../../fleet/postgres/migrations-phase58.js";

const PG_BIN = findPgBin();

describe.skipIf(!PG_BIN)("v58: principal caps, one exposure per sale, fulfilment honesty (PostgreSQL)", () => {
  let R: EconomyRegistry;
  let F: Founder;
  let svc: pg.Pool;
  let custody: pg.Pool;
  let rail: ArmedCustody;
  let dir: string;
  let igw: PgIdentityGateway;
  const shared = new SimulatedSharedMailProvider("fleet@shared.fleet-mail.test");
  const W = "custody-executor";
  const cx = async (fn: string, args: unknown[]) => {
    const ph = args.map((_, i) => `$${i + 1}`).join(", ");
    return (await custody.query(`SELECT fleet.${fn}(${ph}) AS r`, args)).rows[0].r;
  };
  const id = (p: string) => `${p}${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
  const idem = () => `k-${crypto.randomUUID()}`;
  const cash = () => R.balance(`agent:${F.id}:cash`);
  const events = async (type: string) => Number(await R.one(`(SELECT count(*) FROM fleet.fleet_events WHERE event_type = $1)`, [type]));
  const broker = (mail: SimulatedSharedMailProvider | null) => {
    const { vault, ownerVault } = openIdentityState(dir);
    return new IdentityBroker(igw, vault, { mail, ownerVault, providerVault: openProviderVault(dir), stateFile: path.join(dir, "pending.json") });
  };
  const txn = (captureId: string, eventCode: string, amountMinor: number, tid = id("T")) => cx("cx_paypal_txn_record", [W, rail.railId, JSON.stringify({
    transactionId: tid, eventCode, initiatedAt: new Date().toISOString(), status: "S", currency: "GBP", amountMinor, feeMinor: 0, referenceId: captureId })]);
  const sale = async (amountMinor: number, fulfilment = "service", available = true) => {
    const c = await R.econ(F, "paypal.checkout", { venture: "prints", amountMinor, description: "Art print", fulfilment, idempotencyKey: idem() });
    expect(c.ok, JSON.stringify(c)).toBe(true);
    const checkoutId = c.checkout.checkoutId as string;
    const order = id("ORD");
    await cx("cx_paypal_checkout_update", [W, checkoutId, "open", order, `https://www.paypal.com/checkoutnow?token=${order}`, null]);
    await cx("cx_paypal_checkout_update", [W, checkoutId, "approved", null, null, null]);
    const captureId = id("CAP");
    await cx("cx_paypal_capture_record", [W, checkoutId, captureId, "COMPLETED", amountMinor, 0, "GBP", "webhook"]);
    if (available) {
      await cx("cx_paypal_txn_record", [W, rail.railId, JSON.stringify({ transactionId: captureId, eventCode: "T0006", initiatedAt: new Date().toISOString(),
        status: "S", currency: "GBP", amountMinor, feeMinor: 0, customField: checkoutId })]);
      await cx("cx_paypal_balance_record", [W, rail.railId, "GBP", 100_000_000, 100_000_000]);
      await svc.query(`SELECT fleet.svc_paypal_availability(100)`);
    }
    return { checkoutId, captureId, orderId: c.order.orderId as string };
  };

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 5_000, simulatedSettlement: false });
    [F] = R.founders;
    await R.store.grantServiceRole();
    await R.store.grantCustodyRole();
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2, options: "-c search_path=fleet" });
    custody = new pg.Pool({ connectionString: R.pgc.custodyUrl, max: 2, options: "-c search_path=fleet" });
    expect((await R.econ(F, "venture.create", { key: "prints", model: "digital_product", offer: "prints", state: "selected" })).ok).toBe(true);
    rail = await liveRail(R.owner, "fleet", OWNER);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-v58-"));
    fs.chmodSync(dir, 0o700);
    initIdentityState(dir);
    igw = new PgIdentityGateway({ connectionString: R.pgc.identityUrl });
  }, 300_000);
  afterAll(async () => {
    await igw?.close(); await svc?.end(); await custody?.end(); await R?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("routes the new events; a file is not sold by checkout while mail is not configured (a service is)", async () => {
    for (const [p, ts] of Object.entries(EVENT_ROUTES_V58)) for (const t of ts) expect(await R.one(`fleet.fleet_event_route($1, '{}'::jsonb)`, [t]), t).toBe(p);
    const r = await R.econ(F, "paypal.checkout", { venture: "prints", amountMinor: 900, description: "Planner PDF", fulfilment: "digital_file", idempotencyKey: idem() });
    expect(r).toMatchObject({ ok: false, code: "FLEET_FULFILMENT_UNAVAILABLE", capability: "mail" });
    expect(r.reason).toMatch(/storefront/);
    expect(await R.one(`(SELECT count(*)::int FROM fleet.fleet_paypal_checkouts WHERE description = 'Planner PDF')`)).toBe(0);
    expect((await R.econ(F, "paypal.checkout", { venture: "prints", amountMinor: 900, description: "Logo design", fulfilment: "service", idempotencyKey: idem() })).ok).toBe(true);
  });

  it("one chargeback under two codes and its webhook is one loss, never beyond the principal; a distinct fee still posts", async () => {
    const s = await sale(1_000);
    const c0 = await cash();
    await txn(s.captureId, "T1106", -1_000);
    await txn(s.captureId, "T1201", -1_000);
    await cx("cx_paypal_clawback_evidence", [W, "webhook", "RV0000000777", "reversal", s.captureId, 1_000, "GBP"]);
    await txn(s.captureId, "T0106", -1_500); // the chargeback fee: a genuine, separate cost
    expect(await cash()).toBe(c0 - 1_000 - 1_500);
    expect(await events("paypal_evidence_over_principal")).toBe(1);
    // A refund already posted lowers what a reversal can still take.
    const t = await sale(2_000);
    const c1 = await cash();
    await cx("cx_paypal_clawback_evidence", [W, "webhook", "RFP0000001", "refund", t.captureId, 1_500, "GBP"]);
    await txn(t.captureId, "T1201", -2_000);
    expect(await cash()).toBe(c1 - 2_000);
  });

  it("an open dispute, PayPal's hold and an unclassified debit on one sale are one exposure, capped at the principal", async () => {
    const s = await sale(1_000);
    await cx("cx_paypal_dispute_record", [W, "PP-D-0901", s.captureId, "OPEN", null, 1_000, "GBP"]);
    await txn(s.captureId, "T1110", -1_000);
    await txn(s.captureId, "T9998", -1_000);
    expect(Number(await R.one(`fleet.fleet_paypal_sale_exposure($1)`, [s.checkoutId]))).toBe(1_000);
    const m = await R.one(`fleet.fleet_agent_wallet_measure($1)`, [F.id]);
    expect(m.paypalDisputeExposureMinor).toBeGreaterThanOrEqual(1_000);
    // Lost and reversed: the confirmed loss replaces the exposure (not added to it); the unclassified debit is the same money.
    await cx("cx_paypal_dispute_record", [W, "PP-D-0901", s.captureId, "RESOLVED", "RESOLVED_BUYER_FAVOUR", 1_000, "GBP"]);
    await txn(s.captureId, "T1201", -1_000);
    expect(Number(await R.one(`fleet.fleet_paypal_sale_exposure($1)`, [s.checkoutId]))).toBe(0);
  });

  it("a mail job with no provider marks its delivery failed; a delivery that gives up and an unknown buyer are raised for the owner", async () => {
    await broker(shared).tick(); // mail configured
    expect((await R.econ(F, "mailbox.provision", { idempotencyKey: idem() })).ok).toBe(true);
    const s = await sale(800, "digital_file");
    expect((await cx("cx_paypal_buyer_record", [W, s.checkoutId, JSON.stringify({ email_address: "buyer@example.test" })])).recorded).toBe(true);
    const files = [{ fileName: "pack.pdf", contentType: "application/pdf", contentB64: Buffer.from("%PDF-1.4 x").toString("base64") }];
    expect((await R.econ(F, "order.deliver", { orderId: s.orderId, files, idempotencyKey: idem() })).ok).toBe(true);
    // A broker that has no mail provider: the send is recorded as failed, so the delivery is retried rather than stuck.
    const lone = broker(null);
    (lone as unknown as { registered: boolean }).registered = true; // the provider registry stays as it is (only this job runs without one)
    await lone.tick();
    let o = (await R.econ(F, "order.list", { orderId: s.orderId })).orders[0];
    expect(o.delivery).toMatchObject({ status: "failed", lastError: "FLEET_NO_MAIL_PROVIDER" });
    // The provider keeps failing: four more attempts, then the owner is told with the recovery path.
    shared.down = true;
    for (let i = 0; i < 4; i++) {
      await R.q(`UPDATE fleet.fleet_order_deliveries SET next_attempt_at = now() - interval '1 second' WHERE order_id = $1 AND status = 'failed'`, [s.orderId]);
      expect((await svc.query(`SELECT fleet.svc_order_deliveries_retry(20) AS r`)).rows[0].r.resent).toBe(1);
      await broker(shared).tick();
    }
    shared.down = false;
    o = (await R.econ(F, "order.list", { orderId: s.orderId })).orders[0];
    expect(o).toMatchObject({ status: "delivery_failed", delivery: { status: "gave_up", attempts: 5 } });
    const ev = (await R.q(`SELECT detail FROM fleet.fleet_events WHERE event_type = 'order_needs_owner' ORDER BY id DESC LIMIT 1`))[0].detail;
    expect(ev).toMatchObject({ orderId: s.orderId, reason: "delivery_failed" });
    expect(ev.note).toMatch(/refund the buyer/);
    // A buyer PayPal never reveals: raised once, at the twelfth lookup.
    const u = await sale(500);
    for (let i = 0; i < 12; i++) await cx("cx_paypal_buyer_record", [W, u.checkoutId, null]);
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_events WHERE event_type = 'order_needs_owner' AND detail ->> 'reason' = 'buyer_unknown')`))).toBe(1);
    expect((await R.one(`fleet.fleet_ledger_verify()`)).ok).toBe(true);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });
});

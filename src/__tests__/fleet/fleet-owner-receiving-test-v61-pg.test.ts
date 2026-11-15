/**
 * Schema v61 — the owner's receiving test on a configured rail that is not yet ready. PostgreSQL + the controller's real
 * webhook route + the custody worker as the restricted custody login; PayPal is a fake REST API.
 *
 * The rail is shaped like production's: PayPal, live, shared, receive_payments / refunds / payouts, `pending_setup`, a
 * webhook id stored on the rail and NO webhook id in custody's own configuration. Proven here:
 *  - no test before account_access AND webhook_configuration are verified; webhook_configuration is verified from a probe
 *    only, only with a webhook id, and is bound to that id (changing the id closes the path until it is probed again);
 *  - none of this makes a capability ready, activates the rail, verifies sale_ingestion or opens it to agents;
 *  - custody opens the test, verifies its webhook with the rail's stored webhook id (a forged one is rejected), captures,
 *    and books the net once as OWNER CAPITAL; a replayed webhook and Transaction Search post nothing more;
 *  - ordinary checkouts stay refused; refunds / payouts stay unverified; the rail stays pending_setup.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { PgCustodyGateway } from "../../fleet/custody/gateway.js";
import { PayPalTreasuryWorker } from "../../fleet/custody/paypal-treasury.js";
import type { HttpPort } from "../../fleet/custody/signers.js";
import { MemoryVault } from "../../fleet/payments/credential-broker.js";
import { PgFleetStore } from "../../fleet/postgres/store.js";
import { FleetService } from "../../fleet/service/server.js";
import { UnsupportedSandboxTerminator } from "../../fleet/service/terminator.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";

const PG_BIN = findPgBin();
const PIN = { repo: "https://github.com/5l4mm3r/automaton-fleet", commit: "c".repeat(40) };
const BUILD = { buildId: "d".repeat(64), lockfileSha256: "e".repeat(64) };
const WH = "4JR443408B058674D";
const REF = "vault:paypal/treasury";
const id = (p: string) => `${p}${crypto.randomBytes(6).toString("hex").toUpperCase()}`;

/** A fake PayPal: OAuth, Orders v2, webhook verification against WH, Transaction Search, balances. */
function fakePayPal() {
  const orders = new Map<string, { id: string; checkoutId: string; amount: string; currency: string; approved: boolean; capture?: { id: string; fee: string } }>();
  const byRequestId = new Map<string, string>();
  const txns: any[] = [];
  const http: HttpPort = async (url, init) => {
    const u = new URL(url);
    const json = (status: number, body: unknown) => ({ status, json: async () => body });
    if (u.pathname === "/v1/oauth2/token") return json(200, { access_token: "A21AAfake-token-0001", expires_in: 32400 });
    if (init.headers.Authorization !== "Bearer A21AAfake-token-0001") return json(401, {});
    if (init.method === "POST" && u.pathname === "/v2/checkout/orders") {
      const rid = init.headers["PayPal-Request-Id"];
      let oid = byRequestId.get(rid);
      if (!oid) {
        const b = JSON.parse(init.body!);
        oid = id("O");
        byRequestId.set(rid, oid);
        orders.set(oid, { id: oid, checkoutId: b.purchase_units[0].custom_id, amount: b.purchase_units[0].amount.value, currency: b.purchase_units[0].amount.currency_code, approved: false });
      }
      return json(201, { id: oid, status: "PAYER_ACTION_REQUIRED", links: [{ rel: "payer-action", href: `https://www.paypal.com/checkoutnow?token=${oid}` }] });
    }
    const cap = /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/.exec(u.pathname);
    if (init.method === "POST" && cap) {
      const o = orders.get(cap[1]);
      if (!o) return json(404, {});
      if (!o.approved) return json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_NOT_APPROVED" }] });
      if (!o.capture) {
        o.capture = { id: id("C"), fee: "0.30" };
        txns.push({ transaction_info: { transaction_id: o.capture.id, transaction_event_code: "T0006", transaction_initiation_date: new Date().toISOString(),
          transaction_status: "S", transaction_amount: { value: o.amount, currency_code: o.currency }, fee_amount: { value: `-${o.capture.fee}`, currency_code: o.currency },
          custom_field: o.checkoutId, invoice_id: `fleet:${o.checkoutId}` } });
      }
      return json(201, { id: o.id, status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: o.capture.id, status: "COMPLETED",
        amount: { value: o.amount, currency_code: o.currency }, seller_receivable_breakdown: { paypal_fee: { value: o.capture.fee, currency_code: o.currency } }, custom_id: o.checkoutId }] } }] });
    }
    if (init.method === "POST" && u.pathname === "/v1/notifications/verify-webhook-signature") {
      const b = JSON.parse(init.body!);
      return json(200, { verification_status: b.transmission_sig === "good-signature" && b.webhook_id === WH ? "SUCCESS" : "FAILURE" });
    }
    const ord = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(u.pathname);
    if (init.method === "GET" && ord) {
      const o = orders.get(ord[1]);
      return o ? json(200, { id: o.id, status: o.capture ? "COMPLETED" : "APPROVED", payer: { email_address: "owner@example.test", payer_id: "PAYEROWNER01" } }) : json(404, {});
    }
    if (init.method === "GET" && u.pathname === "/v1/reporting/transactions") return json(200, { transaction_details: txns, total_pages: 1 });
    if (init.method === "GET" && u.pathname === "/v1/reporting/balances") {
      return json(200, { balances: [{ currency: "GBP", primary: true, available_balance: { value: "0.70", currency_code: "GBP" }, total_balance: { value: "0.70", currency_code: "GBP" } }] });
    }
    return json(404, {});
  };
  return { http, orders, txns };
}

describe.skipIf(!PG_BIN)("v61: the owner's receiving test on a configured, not-yet-ready rail (PostgreSQL + webhook route + custody worker)", { timeout: 240_000 }, () => {
  let R: EconomyRegistry;
  let F: Founder;
  let railId = "";
  let gw: PgCustodyGateway;
  let svcStore: PgFleetStore;
  let service: FleetService;
  let base = "";
  let pp: ReturnType<typeof fakePayPal>;
  let worker: PayPalTreasuryWorker;
  const verify = (check: string, status: string, kind: string, note = "probe") =>
    R.q(`SELECT fleet.fleet_admin_rail_verify($1, $2, $3, $4, $5::jsonb, NULL, $6)`, [railId, check, status, kind, JSON.stringify({ note }), OWNER]);
  const test = () => R.one<Record<string, any>>(`fleet.fleet_admin_paypal_test_checkout(100, $1)`, [OWNER]);
  const rail = async () => (await R.q(`SELECT status FROM fleet.fleet_payment_rails WHERE rail_id = $1`, [railId]))[0].status as string;
  const readiness = () => R.one<Record<string, any>>(`fleet.fleet_rail_readiness($1)`, [railId]);
  const custodyRails = async () => ((await gw.paypalRails("custody-executor")) as Array<Record<string, any>>).filter((r) => r.railId === railId);
  const deliver = async (event: Record<string, unknown>, sig: string) => {
    const r = await fetch(`${base}/v1/webhooks/paypal`, { method: "POST", headers: { "content-type": "application/json",
      "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.paypal.com/v1/notifications/certs/CERT-1", "paypal-transmission-id": crypto.randomUUID(),
      "paypal-transmission-sig": sig, "paypal-transmission-time": new Date().toISOString() }, body: JSON.stringify(event) });
    return r.status;
  };

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 5_000, simulatedSettlement: false });
    [F] = R.founders;
    await R.store.grantServiceRole();
    await R.store.grantCustodyRole();
    expect((await R.econ(F, "venture.create", { key: "prints", model: "digital_product", offer: "prints", state: "selected" })).ok).toBe(true);
    // Production's rail: registered credential, live, three capabilities, pending_setup, webhook id on the rail.
    const cred = await R.one<Record<string, any>>(`fleet.fleet_admin_credential_register('paypal', 'Treasury PayPal app', $1, $2, false, NULL, $3)`,
      [REF, ["payouts", "receive_payments", "refunds"], OWNER]);
    const r = await R.one<Record<string, any>>(`fleet.fleet_admin_rail_add('paypal', 'F***@example.test', 'shared', NULL, $1::text[], 'PayPal treasury', $2, 'live', NULL, NULL, $3)`,
      [["receive_payments", "refunds", "payouts"], cred.credential_id, OWNER]);
    railId = r.railId ?? r.rail_id;
    gw = new PgCustodyGateway({ connectionString: R.pgc.custodyUrl });
    pp = fakePayPal();
    // No webhook id in custody's own configuration: verification must use the rail's stored id.
    worker = new PayPalTreasuryWorker(gw, new MemoryVault(new Map([[REF, "client-id:client-secret"]])), pp.http, { reconcileEveryMs: 0, balanceEveryMs: 0 });
    svcStore = new PgFleetStore({ connectionString: R.pgc.serviceUrl });
    service = new FleetService({ admin: svcStore, agent: R.gw, realReplicationEnabled: false, reaperIntervalMs: 0, release: { ...PIN, ...BUILD },
      audit: () => {}, terminator: new UnsupportedSandboxTerminator() });
    base = (await service.listen(0, "127.0.0.1")).url;
  }, 240_000);
  afterAll(async () => { await service?.close(); await svcStore?.close(); await gw?.close(); await R?.close(); });

  it("migrates to v61 with a clean audit; the rail starts pending_setup and invisible to custody", async () => {
    expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(61);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
    expect(await rail()).toBe("pending_setup");
    expect(await custodyRails()).toEqual([]);
    expect(await R.code(test())).toBe("FLEET_NO_RECEIVING_RAIL");
  });

  it("webhook_configuration: a probe only, only with a webhook id, bound to it; with account_access it opens only the owner's test", async () => {
    expect(await R.code(verify("webhook_configuration", "verified", "probe"))).toBe("FLEET_INVALID_STATE"); // no webhook id yet
    await R.q(`SELECT fleet.fleet_admin_rail_webhook_set($1, $2, $3)`, [railId, WH, OWNER]);
    expect(await R.code(verify("webhook_configuration", "verified", "owner_attested"))).toBe("FLEET_BAD_REQUEST");
    await verify("webhook_configuration", "verified", "probe", "url matches; 8/8 events");
    expect((await R.q(`SELECT evidence FROM fleet.fleet_rail_capability_checks WHERE rail_id = $1 AND check_name = 'webhook_configuration'`, [railId]))[0].evidence)
      .toEqual({ note: "url matches; 8/8 events", webhookId: WH });
    expect(await R.code(test())).toBe("FLEET_NO_RECEIVING_RAIL"); // account_access not yet
    await verify("account_access", "verified", "probe", "sign-in + balances 200");
    expect(await R.one(`fleet.fleet_rail_owner_test_ready($1)`, [railId])).toBe(true);

    // Nothing else moved: no capability ready, sale_ingestion unverified, not activatable, agents refused.
    const rd = await readiness();
    expect(rd.capabilitiesReady).toEqual([]);
    expect(rd.checks.sale_ingestion.verified).toBe(false);
    expect(rd.checks.refunds.verified).toBe(false);
    expect(rd.checks.payout_reconciliation.verified).toBe(false);
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_rail_set_status($1, 'active', 'x', $2)`, [railId, OWNER]))).toBe("FLEET_RAIL_NOT_READY");
    const agent = await R.econ(F, "paypal.checkout", { venture: "prints", amountMinor: 500, description: "print", idempotencyKey: `k-${crypto.randomUUID()}` });
    expect(agent.ok).toBe(false);

    // Changing the webhook id closes the path until the new one is probed.
    await R.q(`SELECT fleet.fleet_admin_rail_webhook_set($1, 'WEBHOOK00000NEW1', $2)`, [railId, OWNER]);
    expect(await R.one(`fleet.fleet_rail_owner_test_ready($1)`, [railId])).toBe(false);
    expect(await R.code(test())).toBe("FLEET_NO_RECEIVING_RAIL");
    await R.q(`SELECT fleet.fleet_admin_rail_webhook_set($1, $2, $3)`, [railId, WH, OWNER]);
    expect(await R.one(`fleet.fleet_rail_owner_test_ready($1)`, [railId])).toBe(true);
  });

  it("the test runs through custody: rail's webhook id verifies (forged rejected), one capture, owner capital once; the rail stays pending", async () => {
    const t = await test();
    expect(t).toMatchObject({ ok: true, test: { amountMinor: 100, status: "requested", mode: "live" } });
    const cid = t.test.checkoutId as string;
    expect((await R.q(`SELECT detail FROM fleet.fleet_events WHERE event_type = 'paypal_test_checkout_requested'`))[0].detail).toMatchObject({ railStatus: "pending_setup" });
    expect(await custodyRails()).toEqual([expect.objectContaining({ webhookId: WH, testOnly: true })]);

    await worker.tick();
    expect((await R.one(`fleet.fleet_paypal_test_json()`)).tests[0]).toMatchObject({ status: "open" });
    const orderId = [...pp.orders.keys()][0];
    pp.orders.get(orderId)!.approved = true;
    expect(await deliver({ id: "WH-FORGED-0001", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: orderId } }, "bad-signature")).toBe(200);
    expect(await deliver({ id: "WH-APPROVED-0001", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: orderId } }, "good-signature")).toBe(200);
    const cap0 = await R.balance("fleet:owner:capital"), rev0 = await R.balance(`agent:${F.id}:revenue`).catch(() => 0);
    await worker.tick();
    const hooks = await R.q(`SELECT event_id, status FROM fleet.fleet_paypal_webhook_inbox ORDER BY event_id`);
    expect(Object.fromEntries(hooks.map((h) => [h.event_id, h.status]))).toEqual({ "WH-APPROVED-0001": "processed", "WH-FORGED-0001": "rejected" });
    expect((await R.one(`fleet.fleet_paypal_test_json()`)).tests[0]).toMatchObject({ status: "captured", ownerCapitalMinor: 70 });
    expect(await R.balance("fleet:owner:capital")).toBe(cap0 + 70);
    expect(await R.balance(`agent:${F.id}:revenue`).catch(() => 0)).toBe(rev0);

    // The capture webhook that follows, a replay and Transaction Search post nothing more.
    const capId = pp.orders.get(orderId)!.capture!.id;
    expect(await deliver({ id: "WH-CAPTURED-0001", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: capId, custom_id: cid, status: "COMPLETED",
      amount: { value: "1.00", currency_code: "GBP" }, seller_receivable_breakdown: { paypal_fee: { value: "0.30", currency_code: "GBP" } } } }, "good-signature")).toBe(200);
    await worker.tick();
    await worker.tick();
    expect(await R.balance("fleet:owner:capital")).toBe(cap0 + 70);
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_revenue_claims WHERE claim_key = $1)`, [`paypal:capture:${capId}`]))).toBe(1);
    expect((await R.one(`fleet.fleet_paypal_test_json()`)).tests[0].stage).toBe("captured, completed and in the balance: receiving works");

    // Still: pending_setup, sale_ingestion unverified, no capability ready, agents refused; custody keeps the rail in view to reconcile.
    expect(await rail()).toBe("pending_setup");
    expect((await readiness()).capabilitiesReady).toEqual([]);
    expect((await readiness()).checks.sale_ingestion.verified).toBe(false);
    expect((await R.econ(F, "paypal.checkout", { venture: "prints", amountMinor: 500, description: "print", idempotencyKey: `k-${crypto.randomUUID()}` })).ok).toBe(false);
    expect(await custodyRails()).toEqual([expect.objectContaining({ testOnly: true })]);
  });

  it("the end-to-end evidence is then recorded separately, from first use; only then can the rail activate", async () => {
    await verify("sale_ingestion", "verified", "first_use", "owner receiving test captured, completed and in the balance");
    expect((await readiness()).capabilitiesReady).toEqual(["receive_payments"]);
    expect(await R.one(`fleet.fleet_admin_rail_set_status($1, 'active', 'receiving test passed', $2)`, [railId, OWNER])).toMatchObject({ status: "active" });
    expect(await custodyRails()).toEqual([expect.objectContaining({ testOnly: false })]);
    const rd = await readiness();
    expect(rd.checks.refunds.verified).toBe(false);
    expect(rd.checks.payout_reconciliation.verified).toBe(false);
  });
});

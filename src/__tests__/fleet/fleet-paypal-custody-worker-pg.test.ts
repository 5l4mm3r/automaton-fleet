/**
 * Schema v48 — the PayPal treasury worker end to end (PostgreSQL + the real FleetService HTTP route + the custody
 * gateway as the restricted custody login; PayPal is a fake REST API, no network).
 *
 * A founder's checkout is opened by the custody worker (Orders v2, idempotent request ids); the buyer's approval arrives
 * as a webhook over the controller's public route and is stored unverified; the worker verifies it with PayPal (a forged
 * one is rejected and changes nothing), captures, and the agent is credited once, net of PayPal's fee (v51: held until
 * PayPal's Transaction Search and Balances show the money available, then spendable); a refund webhook
 * comes back from the agent; a capture whose response was lost is found by Transaction Search and posted exactly once;
 * balances are observed. No step needs the custody activation: receiving never pays anyone.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { liveRail, type ArmedCustody } from "./fixtures/custody-signer.js";
import { PgCustodyGateway } from "../../fleet/custody/gateway.js";
import { PayPalTreasuryWorker, toMinor, checkoutIdOf } from "../../fleet/custody/paypal-treasury.js";
import type { HttpPort } from "../../fleet/custody/signers.js";
import { MemoryVault } from "../../fleet/payments/credential-broker.js";
import { PgFleetStore } from "../../fleet/postgres/store.js";
import { FleetService } from "../../fleet/service/server.js";
import { UnsupportedSandboxTerminator } from "../../fleet/service/terminator.js";

const PG_BIN = findPgBin();
const PIN = { repo: "https://github.com/5l4mm3r/automaton-fleet", commit: "c".repeat(40) };
const BUILD = { buildId: "d".repeat(64), lockfileSha256: "e".repeat(64) };
const id = (p: string) => `${p}${crypto.randomBytes(6).toString("hex").toUpperCase()}`;

/** A fake PayPal REST API: OAuth, Orders v2 (create / capture by request id), webhook verification, Transaction Search, balances. */
function fakePayPal() {
  const orders = new Map<string, { id: string; checkoutId: string; amount: string; currency: string; approved: boolean; capture?: { id: string; fee: string } }>();
  const byRequestId = new Map<string, string>();
  const txns: any[] = [];
  const calls: string[] = [];
  let failCaptureOnce = false;
  let secretsSeen = 0;
  const http: HttpPort = async (url, init) => {
    const u = new URL(url);
    calls.push(`${init.method} ${u.pathname}`);
    const json = (status: number, body: unknown) => ({ status, json: async () => body });
    if (u.pathname === "/v1/oauth2/token") {
      if (init.headers.Authorization === `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`) secretsSeen++;
      return json(200, { access_token: "A21AAfake-token-0001", expires_in: 32400 });
    }
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
        o.capture = { id: id("C"), fee: "0.70" };
        txns.push({ transaction_info: { transaction_id: o.capture.id, transaction_event_code: "T0006", transaction_initiation_date: new Date().toISOString(),
          transaction_status: "S", transaction_amount: { value: o.amount, currency_code: o.currency }, fee_amount: { value: `-${o.capture.fee}`, currency_code: o.currency },
          custom_field: o.checkoutId, invoice_id: `fleet:${o.checkoutId}` } });
      }
      if (failCaptureOnce) { failCaptureOnce = false; return json(500, {}); } // captured at PayPal, answer lost
      return json(201, { id: o.id, status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: o.capture.id, status: "COMPLETED",
        amount: { value: o.amount, currency_code: o.currency }, seller_receivable_breakdown: { paypal_fee: { value: o.capture.fee, currency_code: o.currency } }, custom_id: o.checkoutId }] } }] });
    }
    if (init.method === "POST" && u.pathname === "/v1/notifications/verify-webhook-signature") {
      const b = JSON.parse(init.body!);
      return json(200, { verification_status: b.transmission_sig === "good-signature" && b.webhook_id === "WH1234567890ABCD" ? "SUCCESS" : "FAILURE" });
    }
    if (init.method === "GET" && u.pathname === "/v1/reporting/transactions") return json(200, { transaction_details: txns, total_pages: 1 });
    if (init.method === "GET" && u.pathname === "/v1/reporting/balances") {
      return json(200, { balances: [{ currency: "GBP", primary: true, available_balance: { value: "123.45", currency_code: "GBP" }, total_balance: { value: "130.00", currency_code: "GBP" } }] });
    }
    return json(404, {});
  };
  return { http, orders, txns, calls, failNextCapture: () => { failCaptureOnce = true; }, secretsSeen: () => secretsSeen };
}

describe.skipIf(!PG_BIN)("v48 PayPal treasury worker end to end (PostgreSQL + HTTP webhook route)", () => {
  let R: EconomyRegistry;
  let F: Founder;
  let rail: ArmedCustody;
  let gw: PgCustodyGateway;
  let svcStore: PgFleetStore;
  let service: FleetService;
  let base = "";
  let pp: ReturnType<typeof fakePayPal>;
  let worker: PayPalTreasuryWorker;
  const cash = () => R.balance(`agent:${F.id}:cash`);
  const held = () => R.balance(`agent:${F.id}:cash_pending`);
  /** v51: the reaper's availability pass (the worker has recorded Transaction Search rows and a Balances reading). */
  const availability = async () => (await svcStore.lifecycleTick()).availability;
  const deliver = async (event: Record<string, unknown>, sig: string) => {
    const r = await fetch(`${base}/v1/webhooks/paypal`, { method: "POST", headers: { "content-type": "application/json",
      "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.paypal.com/v1/notifications/certs/CERT-1", "paypal-transmission-id": crypto.randomUUID(),
      "paypal-transmission-sig": sig, "paypal-transmission-time": new Date().toISOString() }, body: JSON.stringify(event) });
    return { status: r.status, body: await r.json() as any };
  };
  const checkout = async (amountMinor: number) => {
    const r = await R.econ(F, "paypal.checkout", { venture: "botanical-posters", amountMinor, description: "A2 botanical print", idempotencyKey: `chk-${crypto.randomUUID()}` });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return r.checkout.checkoutId as string;
  };
  const status = async (checkoutId: string) => (await R.econ(F, "paypal.checkouts", { checkoutId })).checkouts[0];

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 5_000, simulatedSettlement: false });
    [F] = R.founders;
    await R.store.grantServiceRole();
    await R.store.grantCustodyRole();
    expect((await R.econ(F, "venture.create", { key: "botanical-posters", model: "digital_product", offer: "prints", state: "selected" })).ok).toBe(true);
    rail = await liveRail(R.owner, "fleet", OWNER);
    gw = new PgCustodyGateway({ connectionString: R.pgc.custodyUrl });
    pp = fakePayPal();
    worker = new PayPalTreasuryWorker(gw, new MemoryVault(new Map([[rail.vaultRef, "client-id:client-secret"]])), pp.http,
      { webhookIds: { [rail.railId]: "WH1234567890ABCD" }, reconcileEveryMs: 0, balanceEveryMs: 0 });
    svcStore = new PgFleetStore({ connectionString: R.pgc.serviceUrl });
    service = new FleetService({ admin: svcStore, agent: R.gw, realReplicationEnabled: false, reaperIntervalMs: 0, release: { ...PIN, ...BUILD },
      audit: () => {}, terminator: new UnsupportedSandboxTerminator() });
    base = (await service.listen(0, "127.0.0.1")).url;
  }, 240_000);
  afterAll(async () => { await service?.close(); await svcStore?.close(); await gw?.close(); await R?.close(); });

  it("parses PayPal money exactly and finds the checkout a capture belongs to", () => {
    expect([toMinor("12.30"), toMinor("-0.70"), toMinor("5"), toMinor("1.234"), toMinor(12)]).toEqual([1230, -70, 500, null, null]);
    const u = crypto.randomUUID();
    expect([checkoutIdOf(u, null), checkoutIdOf(null, `fleet:${u}`), checkoutIdOf("x", "y")]).toEqual([u, u, null]);
  });

  it("opens a checkout with PayPal; a verified approval webhook leads to one capture and one credit; a forged one changes nothing", async () => {
    const before = await cash();
    const c = await checkout(1_500);
    await worker.tick();
    const open = await status(c);
    expect(open).toMatchObject({ status: "open" });
    expect(open.approvalUrl).toMatch(/^https:\/\/www\.paypal\.com\/checkoutnow\?token=O/);
    await worker.tick(); // idempotent: the same request id, no second order
    expect(pp.orders.size).toBe(1);
    const orderId = [...pp.orders.keys()][0];
    pp.orders.get(orderId)!.approved = true; // the buyer approves on PayPal
    // A forged delivery (bad signature) is stored but rejected by verification; nothing moves.
    const forged = await deliver({ id: "WH-FORGED-0001", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CFORGED00001", custom_id: c,
      amount: { value: "15.00", currency_code: "GBP" }, seller_receivable_breakdown: { paypal_fee: { value: "0.00" } } } }, "bad-signature");
    expect(forged).toMatchObject({ status: 200, body: { ok: true, received: true } });
    const ok = await deliver({ id: "WH-APPROVED-0001", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: orderId } }, "good-signature");
    expect(ok.status).toBe(200);
    expect((await deliver({ id: "WH-APPROVED-0001", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: orderId } }, "good-signature")).status).toBe(200);
    await worker.tick();
    expect(await status(c)).toMatchObject({ status: "captured" });
    // v51: revenue at once, the cash held until PayPal's own records show it available (Transaction Search S + Balances).
    expect(await cash()).toBe(before);
    expect(await held()).toBe(1_430);
    await worker.tick();
    expect(await availability()).toMatchObject({ released: 1 });
    expect(await cash()).toBe(before + 1_430);
    const hooks = await R.q(`SELECT event_id, status FROM fleet.fleet_paypal_webhook_inbox ORDER BY event_id`);
    expect(Object.fromEntries(hooks.map((h) => [h.event_id, h.status]))).toEqual({ "WH-APPROVED-0001": "processed", "WH-FORGED-0001": "rejected" });
    // The capture-completed webhook that follows is a replay: no second credit.
    const capId = pp.orders.get(orderId)!.capture!.id;
    await deliver({ id: "WH-CAPTURED-0001", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: capId, custom_id: c, amount: { value: "15.00", currency_code: "GBP" },
      seller_receivable_breakdown: { paypal_fee: { value: "0.70" } } } }, "good-signature");
    await worker.tick();
    expect(await cash()).toBe(before + 1_430);
    expect(pp.secretsSeen()).toBe(1); // one token exchange, cached in memory
  });

  it("a refund webhook comes back from the agent's cash", async () => {
    const before = await cash();
    const [o] = [...pp.orders.values()];
    await deliver({ id: "WH-REFUND-0001", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "RF0000000001", amount: { value: "5.00", currency_code: "GBP" },
      links: [{ rel: "up", href: `https://api.paypal.com/v2/payments/captures/${o.capture!.id}` }] } }, "good-signature");
    await worker.tick();
    expect(await cash()).toBe(before - 500);
    expect(await R.one(`(SELECT count(*)::int FROM fleet.fleet_revenue_claims WHERE claim_key = 'paypal:refund:RF0000000001')`)).toBe(1);
  });

  it("a capture whose response was lost is found by Transaction Search and posted exactly once; balances are observed", async () => {
    const before = await cash();
    const c = await checkout(2_000);
    await worker.tick();
    const orderId = [...pp.orders.values()].find((o) => o.checkoutId === c)!.id;
    pp.orders.get(orderId)!.approved = true;
    await R.q(`SELECT 1`); // (the approval webhook is lost)
    await gw.paypalCheckoutUpdate("custody-executor", c, "approved", null, null, null);
    pp.failNextCapture();
    await worker.tick(); // capture happens at PayPal, the answer is lost; reconciliation in the same pass finds it
    expect(await status(c)).toMatchObject({ status: "captured" });
    expect(await held()).toBe(1_930);
    await worker.tick();
    expect(await availability()).toMatchObject({ released: 1 });
    expect(await cash()).toBe(before + 1_930);
    await worker.tick();
    expect(await availability()).toMatchObject({ released: 0 });
    expect(await cash()).toBe(before + 1_930);
    const bal = await R.one(`fleet.fleet_paypal_status()`);
    expect(bal.rails[0].balance).toMatchObject({ currency: "GBP", availableMinor: 12_345, totalMinor: 13_000 });
    expect(pp.calls.every((c) => !c.includes("payouts"))).toBe(true); // receiving never pays anyone
    expect((await R.store.custodyStatus()).executionEnabled).toBe(false);
    expect((await R.one(`fleet.fleet_ledger_verify()`)).ok).toBe(true);
  });
});

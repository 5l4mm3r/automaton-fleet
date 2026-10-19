/**
 * Schema v98 — the PayPal order lifecycle (PostgreSQL + the real custody worker as the restricted custody login + the real
 * public order page as the service role; PayPal is a fake REST API with debug ids, no network).
 *
 *  - a captured order is the control; its creation and capture use the legacy request ids (`order:` / `capture:<checkout>`);
 *  - a stale link is re-confirmed and REUSED when PayPal still has it (no second order);
 *  - the live proof's case: an order PayPal no longer has (RESOURCE_NOT_FOUND, two answers with their own debug ids, same
 *    credential and environment, a control read that succeeds) is RETIRED and a fresh one created for the SAME checkout
 *    (`order:<checkout>:2`); every PayPal order id and its history is kept; the old link is never shown again;
 *  - a late approval of the retired order is never captured — reconciled and alerted; a late capture on it after the new
 *    order was paid is a duplicate, held for reconciliation and not booked;
 *  - a 404 the Fleet cannot verify retires nothing (reconciled; the buyer is told to try again with PayPal's reference); the
 *    owner may retire it;
 *  - double clicks are one request; concurrent workers and a lost creation answer reuse one claim and one PayPal order;
 *    a lost capture answer is booked once; DUPLICATE_INVOICE_ID is reconciled;
 *  - Transaction Search's 403 (name, debug id) and the token's missing scope are recorded; the order audit books a refund PayPal
 *    reports on a captured order once, without Transaction Search;
 *  - the guards: the checkout's PayPal order changes only to a recorded one after retirement; history is immutable;
 *  - the order page: "opening a fresh PayPal checkout", "try again (reference)", and POST /pay → PayPal or back to the page.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import http from "http";
import pg from "pg";
import fs from "fs";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { liveRail, type ArmedCustody } from "./fixtures/custody-signer.js";
import { PgCustodyGateway } from "../../fleet/custody/gateway.js";
import { PayPalTreasuryWorker, PAYPAL_SEARCH_SCOPE } from "../../fleet/custody/paypal-treasury.js";
import type { HttpPort } from "../../fleet/custody/signers.js";
import { MemoryVault } from "../../fleet/payments/credential-broker.js";
import { PgFleetStore } from "../../fleet/postgres/store.js";
import { PublicPages } from "../../fleet/service/public-pages.js";
import { BUYER_CONSENT_VERSION } from "../../fleet/storefront/consent.js";

const PG_BIN = findPgBin();
const CHROME = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => fs.existsSync(p));
const id = (p: string) => `${p}${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

type FakeOrder = { id: string; checkoutId: string; invoice: string; amount: string; currency: string; status: "CREATED" | "APPROVED" | "COMPLETED" | "GONE";
  capture?: { id: string; fee: string; status: string }; refunds: Array<{ id: string; amount: string; status: string }> };

/** A fake PayPal: Orders v2 (idempotent by PayPal-Request-Id), captures (idempotent), Transaction Search (403), debug ids. */
function fakePayPal() {
  const orders = new Map<string, FakeOrder>();
  const byRequest = new Map<string, string>();
  const creates: string[] = [];          // request ids of every create call
  const captures: Array<{ order: string; requestId: string }> = [];
  const gets: string[] = [];
  let dbg = 0;
  let loseCreate = 0, loseCapture = 0, dupInvoice = new Set<string>(), controlBroken = false;
  const http: HttpPort = async (url, init) => {
    const u = new URL(url);
    const debug = `dbg-${(++dbg).toString().padStart(4, "0")}${crypto.randomBytes(3).toString("hex")}`;
    const json = (status: number, body: unknown) => ({ status, json: async () => body, headers: { get: (n: string) => (n.toLowerCase() === "paypal-debug-id" ? debug : null) } });
    if (u.pathname === "/v1/oauth2/token") return json(200, { access_token: "A21AAfake-token-0002", expires_in: 32400, app_id: "APP-1",
      scope: "https://uri.paypal.com/services/payments/payment https://uri.paypal.com/services/reporting/balances/read openid" });
    if (init.headers.Authorization !== "Bearer A21AAfake-token-0002") return json(401, {});
    if (init.method === "POST" && u.pathname === "/v2/checkout/orders") {
      const rid = init.headers["PayPal-Request-Id"];
      creates.push(rid);
      let oid = byRequest.get(rid);
      if (!oid) {
        const b = JSON.parse(init.body!);
        oid = id("O");
        byRequest.set(rid, oid);
        orders.set(oid, { id: oid, checkoutId: b.purchase_units[0].custom_id, invoice: b.purchase_units[0].invoice_id, amount: b.purchase_units[0].amount.value,
          currency: b.purchase_units[0].amount.currency_code, status: "CREATED", refunds: [] });
      }
      if (loseCreate > 0) { loseCreate--; throw new Error("socket hang up"); }   // created at PayPal, answer lost
      return json(201, { id: oid, status: "PAYER_ACTION_REQUIRED", purchase_units: [{ payee: { merchant_id: "MERCHANT0001" } }],
        links: [{ rel: "payer-action", href: `https://www.paypal.com/checkoutnow?token=${oid}` }] });
    }
    const cap = /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/.exec(u.pathname);
    if (init.method === "POST" && cap) {
      const o = orders.get(cap[1]);
      captures.push({ order: cap[1], requestId: init.headers["PayPal-Request-Id"] });
      if (!o || o.status === "GONE") return json(404, { name: "RESOURCE_NOT_FOUND", details: [{ issue: "INVALID_RESOURCE_ID" }], debug_id: debug });
      if (dupInvoice.has(o.id)) return json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "DUPLICATE_INVOICE_ID" }], debug_id: debug });
      if (o.status === "CREATED") return json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_NOT_APPROVED" }], debug_id: debug });
      if (o.status === "COMPLETED") return json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }], debug_id: debug });
      o.status = "COMPLETED";
      o.capture = { id: id("C"), fee: "0.30", status: "COMPLETED" };
      if (loseCapture > 0) { loseCapture--; return json(500, { name: "INTERNAL_SERVER_ERROR", debug_id: debug }); }   // captured, answer lost
      return json(201, view(o));
    }
    const ord = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(u.pathname);
    if (init.method === "GET" && ord) {
      gets.push(ord[1]);
      const o = orders.get(ord[1]);
      if (controlBroken && o?.status === "COMPLETED") return json(404, { name: "RESOURCE_NOT_FOUND", details: [{ issue: "INVALID_RESOURCE_ID" }], debug_id: debug });
      if (!o || o.status === "GONE") return json(404, { name: "RESOURCE_NOT_FOUND", details: [{ issue: "INVALID_RESOURCE_ID" }], debug_id: debug });
      return json(200, view(o));
    }
    if (init.method === "GET" && u.pathname === "/v1/reporting/transactions") return json(403, { name: "NOT_AUTHORIZED", message: "Authorization failed", debug_id: debug });
    if (init.method === "GET" && u.pathname === "/v1/reporting/balances") return json(200, { balances: [] });
    return json(404, {});
  };
  const view = (o: FakeOrder) => ({ id: o.id, status: o.status, payer: { email_address: "bea@example.test", name: { given_name: "Bea", surname: "Buyer" }, address: { country_code: "GB" }, payer_id: "PAYERBEA0001" },
    purchase_units: [{ payee: { merchant_id: "MERCHANT0001" }, payments: {
      captures: o.capture ? [{ id: o.capture.id, status: o.capture.status, amount: { value: o.amount, currency_code: o.currency },
        seller_receivable_breakdown: { paypal_fee: { value: o.capture.fee, currency_code: o.currency } }, custom_id: o.checkoutId }] : [],
      refunds: o.refunds.map((r) => ({ id: r.id, status: r.status, amount: { value: r.amount, currency_code: o.currency },
        seller_payable_breakdown: { net_amount: { value: r.amount, currency_code: o.currency } },
        links: [{ rel: "up", href: `https://api-m.paypal.com/v2/payments/captures/${o.capture!.id}` }] })) } }] });
  return { http, orders, creates, captures, gets,
    approve: (oid: string) => { orders.get(oid)!.status = "APPROVED"; },
    gone: (oid: string) => { orders.get(oid)!.status = "GONE"; },
    revive: (oid: string, status: FakeOrder["status"]) => { orders.get(oid)!.status = status; },
    loseNextCreate: () => { loseCreate++; }, loseNextCapture: () => { loseCapture++; },
    duplicateInvoice: (oid: string) => dupInvoice.add(oid), breakControl: (b: boolean) => { controlBroken = b; } };
}

describe.skipIf(!PG_BIN)("v98: the PayPal order lifecycle (PostgreSQL + custody worker + order page)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let F: Founder;
  let rail: ArmedCustody;
  let gw: PgCustodyGateway;
  let svc: pg.Pool;
  let controller: PgFleetStore;
  let server: http.Server;
  let base = "";
  let pp: ReturnType<typeof fakePayPal>;
  let worker: PayPalTreasuryWorker;
  let worker2: PayPalTreasuryWorker;
  const origin = sha("buyer-1");
  const pub = async (fn: string, args: unknown[]) => (await svc.query(`SELECT fleet.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) AS r`, args)).rows[0].r;
  const one = <T = any>(sql: string, params: unknown[] = []) => R.one<T>(sql, params);
  const porders = (checkoutId: string) => R.q(`SELECT * FROM fleet.fleet_paypal_provider_orders WHERE checkout_id = $1 ORDER BY attempt`, [checkoutId]);
  const checkoutRow = async (checkoutId: string) => (await R.q(`SELECT * FROM fleet.fleet_paypal_checkouts WHERE checkout_id = $1`, [checkoutId]))[0];
  const recon = (kind: string) => R.q(`SELECT * FROM fleet.fleet_paypal_reconciliation_items WHERE kind = $1 ORDER BY created_at`, [kind]);
  const events = (type: string) => one<number>(`(SELECT count(*)::int FROM fleet.fleet_events WHERE event_type = $1)`, [type]);
  /** An agent's service order (order page) with the buyer's consent recorded; custody opens its PayPal order. */
  const order = async (amountMinor = 4_000) => {
    const r = await R.econ(F, "paypal.checkout", { venture: "ledgers", amountMinor, description: "Spreadsheet fix", fulfilment: "service", idempotencyKey: `k-${crypto.randomUUID()}` });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const checkoutId = r.checkout.checkoutId as string;
    const token = await one<string>(`(SELECT access_token FROM fleet.fleet_customer_orders WHERE checkout_id = $1)`, [checkoutId]);
    expect(await pub("svc_order_consent", [token, origin, BUYER_CONSENT_VERSION])).toMatchObject({ ok: true });
    return { checkoutId, token };
  };
  const stale = (checkoutId: string) => R.q(`UPDATE fleet.fleet_paypal_provider_orders SET opened_at = now() - interval '2 hours', confirmed_at = now() - interval '2 hours'
    WHERE checkout_id = $1 AND state = 'open'`, [checkoutId]);
  const pageOf = async (token: string) => (await pub("svc_order_page", [token])).order;
  const dueWatch = () => R.q(`UPDATE fleet.fleet_paypal_provider_orders SET next_read_at = now() - interval '1 second' WHERE next_read_at IS NOT NULL`);
  const dueStatus = (checkoutId: string) => R.q(`UPDATE fleet.fleet_paypal_checkouts SET next_status_check = now() - interval '1 second' WHERE checkout_id = $1`, [checkoutId]);
  let control = { checkoutId: "", paypalOrderId: "" };

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000, simulatedSettlement: false });
    [F] = R.founders;
    await R.store.grantServiceRole();
    await R.store.grantCustodyRole();
    expect((await R.econ(F, "venture.create", { key: "ledgers", model: "service", offer: "spreadsheet fixes", state: "selected" })).ok).toBe(true);
    rail = await liveRail(R.owner, "fleet", OWNER);
    gw = new PgCustodyGateway({ connectionString: R.pgc.custodyUrl });
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 4 });
    pp = fakePayPal();
    const vault = () => new MemoryVault(new Map([[rail.vaultRef, "client-id:client-secret"]]));
    worker = new PayPalTreasuryWorker(gw, vault(), pp.http, { reconcileEveryMs: 0, balanceEveryMs: 60 * 60_000, returnUrl: "https://shop.fleet.test/v1/paypal/return" });
    worker2 = new PayPalTreasuryWorker(gw, vault(), pp.http, { worker: "custody-executor-2", reconcileEveryMs: 60 * 60_000, balanceEveryMs: 60 * 60_000 });
    controller = new PgFleetStore({ connectionString: R.pgc.serviceUrl, schema: "fleet", applicationName: "test-service" });
    const pages = new PublicPages(controller);
    server = http.createServer((req, res) => void pages.handle(req, res, (req.url ?? "/").split("?")[0], "127.0.0.1"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }, 300_000);
  afterAll(async () => { server?.close(); await controller?.close(); await svc?.end(); await gw?.close(); await R?.close(); });

  it("a captured order (the control): created and captured under the legacy request ids; the privilege audit is clean", async () => {
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
    const { checkoutId } = await order();
    await worker.tick();
    const [p] = await porders(checkoutId);
    expect(p).toMatchObject({ attempt: 1, request_id: `order:${checkoutId}`, state: "open", payee_merchant_id: "MERCHANT0001" });
    expect(pp.creates.filter((r) => r === `order:${checkoutId}`)).toHaveLength(1);
    pp.approve(p.paypal_order_id);
    await dueStatus(checkoutId);
    await worker.tick();
    expect((await checkoutRow(checkoutId)).status).toBe("captured");
    expect(pp.captures.filter((c) => c.order === p.paypal_order_id).map((c) => c.requestId)).toEqual([`capture:${checkoutId}`]);
    expect((await porders(checkoutId))[0].state).toBe("captured");
    control = { checkoutId, paypalOrderId: p.paypal_order_id };
  });

  it("double clicks are one request; a stale link PayPal still has is re-confirmed and reused — no second PayPal order", async () => {
    const { checkoutId, token } = await order();
    await worker.tick();
    // Fresh: straight to PayPal.
    expect(await pub("svc_order_pay", [token, origin])).toMatchObject({ ok: true, state: "link", redirect: expect.stringMatching(/^https:\/\/www\.paypal\.com\/checkoutnow\?token=/) });
    await stale(checkoutId);
    expect(await pageOf(token)).toMatchObject({ pay: "button" });
    const clicks = await Promise.all(Array.from({ length: 8 }, () => pub("svc_order_pay", [token, origin])));
    expect(clicks.every((c) => c.ok && c.state === "preparing")).toBe(true);
    const req = (await checkoutRow(checkoutId)).pay_requested_at;
    expect(await pub("svc_order_pay", [token, origin])).toMatchObject({ state: "preparing" });
    expect((await checkoutRow(checkoutId)).pay_requested_at).toEqual(req);   // still the one request
    expect(await pageOf(token)).toMatchObject({ pay: "preparing" });
    expect((await pageOf(token)).approvalUrl).toBeUndefined();
    const before = pp.creates.length;
    await worker.payTick();
    expect(pp.creates.length).toBe(before);                                   // reused
    const page = await pageOf(token);
    expect(page).toMatchObject({ pay: "link", approvalUrl: expect.stringContaining((await porders(checkoutId))[0].paypal_order_id) });
    expect(await porders(checkoutId)).toHaveLength(1);
  });

  it("the live proof's case: PayPal no longer has the order — verified, retired, replaced for the same checkout; history kept", async () => {
    const { checkoutId, token } = await order();
    // As live: the order was opened by the older custody path (cx_paypal_checkout_update) — it is registered as provider order 1.
    const oldId = id("O");
    pp.orders.set(oldId, { id: oldId, checkoutId, invoice: `fleet:${checkoutId}`, amount: "40.00", currency: "GBP", status: "GONE", refunds: [] });
    const cx = await gw.paypalCheckoutUpdate("custody-executor", checkoutId, "open", oldId, `https://www.paypal.com/checkoutnow?token=${oldId}`, null);
    expect(cx.ok).toBe(true);
    expect(await porders(checkoutId)).toEqual([expect.objectContaining({ attempt: 1, legacy: true, state: "open", paypal_order_id: oldId })]);
    await stale(checkoutId);
    expect(await pub("svc_order_pay", [token, origin])).toMatchObject({ state: "preparing" });
    await worker.payTick();                                                   // one RESOURCE_NOT_FOUND: not enough
    expect((await porders(checkoutId))[0].state).toBe("open");
    expect(await pageOf(token)).toMatchObject({ pay: "preparing" });
    await worker.payTick();                                                   // a second, its own debug id → control read → retire → fresh order
    const [old, fresh] = await porders(checkoutId);
    expect(old).toMatchObject({ state: "retired", retire_reason: "not_found_verified", paypal_order_id: oldId });
    expect(old.retire_evidence.notFoundAnswers).toHaveLength(2);
    expect(new Set(old.retire_evidence.notFoundAnswers.map((a: any) => a.debugId)).size).toBe(2);
    expect(old.retire_evidence.control).toEqual({ orderId: control.paypalOrderId, http: 200 });
    expect(pp.gets).toContain(control.paypalOrderId);
    expect(fresh).toMatchObject({ attempt: 2, request_id: `order:${checkoutId}:2`, state: "open" });
    expect(pp.orders.get(fresh.paypal_order_id)!.invoice).toBe(`fleet:${checkoutId}`);   // the same invoice id: PayPal refuses a second payment
    const c = await checkoutRow(checkoutId);
    expect(c).toMatchObject({ status: "open", paypal_order_id: fresh.paypal_order_id });
    const page = await pageOf(token);
    expect(page.pay).toBe("link");
    expect(page.approvalUrl).toContain(fresh.paypal_order_id);
    expect(JSON.stringify(page)).not.toContain(oldId);
    expect(await events("paypal_order_replaced")).toBeGreaterThanOrEqual(1);
    const hist = await R.q(`SELECT kind, http_status, error_name, debug_id FROM fleet.fleet_paypal_provider_order_events WHERE provider_order_id = $1 ORDER BY event_id`, [old.provider_order_id]);
    expect(hist.filter((e: any) => e.kind === "read" && e.http_status === 404 && e.error_name === "RESOURCE_NOT_FOUND" && e.debug_id)).toHaveLength(2);
    expect(hist.at(-1)).toMatchObject({ kind: "retired" });

    // A late approval of the retired order (PayPal's mistake, or an old tab): never captured — reconciled and alerted (P1).
    pp.revive(oldId, "APPROVED");
    await dueWatch();
    await worker.tick();
    expect(pp.captures.filter((x) => x.order === oldId)).toHaveLength(0);
    expect(await recon("late_approval")).toEqual([expect.objectContaining({ checkout_id: checkoutId, paypal_ref: oldId, status: "open" })]);
    expect(await one(`fleet.fleet_event_route('paypal_reconciliation_needed', '{}'::jsonb)`)).toBe("P1_HIGH");
    expect((await checkoutRow(checkoutId)).status).toBe("open");

    // The buyer pays the fresh order; the capture's answer is lost once — booked exactly once.
    pp.approve(fresh.paypal_order_id);
    pp.loseNextCapture();
    await dueStatus(checkoutId);
    await worker.tick();
    await dueStatus(checkoutId);
    await worker.tick();
    expect((await checkoutRow(checkoutId)).status).toBe("captured");
    const freshCaps = pp.captures.filter((x) => x.order === fresh.paypal_order_id);
    expect(new Set(freshCaps.map((x) => x.requestId))).toEqual(new Set([`capture:${checkoutId}:2`]));
    const cash = await R.balance(`agent:${F.id}:cash_pending`) + await R.balance(`agent:${F.id}:cash`);

    // A late capture on the retired order after that: a duplicate — reconciled, not booked.
    const o = pp.orders.get(oldId)!;
    o.status = "COMPLETED"; o.capture = { id: id("C"), fee: "0.30", status: "COMPLETED" };
    await dueWatch();
    await worker.tick();
    expect(await recon("late_capture")).toEqual([expect.objectContaining({ paypal_ref: oldId })]);
    expect(await recon("duplicate_capture")).toEqual([expect.objectContaining({ checkout_id: checkoutId, paypal_ref: o.capture.id })]);
    expect(await R.balance(`agent:${F.id}:cash_pending`) + await R.balance(`agent:${F.id}:cash`)).toBe(cash);
    expect((await checkoutRow(checkoutId)).capture_id).not.toBe(o.capture.id);
  });

  it("a 404 the Fleet cannot verify retires nothing: reconciled, the buyer told to try again with PayPal's reference; the owner may retire it", async () => {
    const { checkoutId, token } = await order();
    await worker.tick();
    const [p] = await porders(checkoutId);
    pp.gone(p.paypal_order_id);
    pp.breakControl(true);
    await stale(checkoutId);
    await pub("svc_order_pay", [token, origin]);
    await worker.payTick();
    await worker.payTick();
    pp.breakControl(false);
    expect((await porders(checkoutId))[0].state).toBe("open");
    expect(await recon("not_found_unverifiable")).toEqual([expect.objectContaining({ checkout_id: checkoutId, paypal_ref: p.paypal_order_id })]);
    const page = await pageOf(token);
    expect(page).toMatchObject({ pay: "retry", payFailureRef: expect.stringMatching(/^dbg-/) });
    // The owner retires it (recorded); the next press creates a fresh order.
    await expect(R.q(`SELECT fleet.fleet_admin_paypal_order_retire($1, 'short', $2)`, [p.paypal_order_id, OWNER])).rejects.toThrow(/FLEET_BAD_REQUEST/);
    expect((await R.q(`SELECT fleet.fleet_admin_paypal_order_retire($1, 'PayPal support confirmed the order expired', $2) AS r`, [p.paypal_order_id, OWNER]))[0].r).toMatchObject({ ok: true });
    await pub("svc_order_pay", [token, origin]);
    await worker.payTick();
    expect((await porders(checkoutId)).map((x: any) => [x.attempt, x.state, x.retire_reason ?? null])).toEqual([[1, "retired", "owner"], [2, "open", null]]);
    expect(await pageOf(token)).toMatchObject({ pay: "link" });
    const rec = (await R.q(`SELECT fleet.fleet_admin_paypal_reconciliation($1) AS r`, [OWNER]))[0].r;
    expect(rec.items.find((i: any) => i.kind === "not_found_unverifiable")).toBeTruthy();
    const item = (await recon("not_found_unverifiable"))[0];
    expect((await R.q(`SELECT fleet.fleet_admin_paypal_reconciliation_resolve($1, 'retired by the owner after PayPal confirmed', $2) AS r`, [item.item_id, OWNER]))[0].r).toMatchObject({ ok: true });
    await expect(R.q(`UPDATE fleet.fleet_paypal_reconciliation_items SET resolution = 'changed' WHERE item_id = $1`, [item.item_id])).rejects.toThrow(/FLEET_IMMUTABLE/);
  });

  it("concurrent workers and a lost creation answer: one claim, one request id, one PayPal order", async () => {
    const { checkoutId, token } = await order();
    pp.loseNextCreate();
    await worker.tick();                                                      // created at PayPal, the answer lost
    expect(await porders(checkoutId)).toEqual([expect.objectContaining({ state: "creating", paypal_order_id: null })]);
    await pub("svc_order_pay", [token, origin]);
    await Promise.all([worker.payTick(), worker2.payTick(), worker.payTick()]);
    const rows = await porders(checkoutId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "open", request_id: `order:${checkoutId}` });
    expect(new Set(pp.creates.filter((r) => r.startsWith(`order:${checkoutId}`)))).toEqual(new Set([`order:${checkoutId}`]));
    expect([...pp.orders.values()].filter((o) => o.checkoutId === checkoutId)).toHaveLength(1);
    expect(await pageOf(token)).toMatchObject({ pay: "link" });
    const hist = await R.q(`SELECT kind FROM fleet.fleet_paypal_provider_order_events WHERE provider_order_id = $1 ORDER BY event_id`, [rows[0].provider_order_id]);
    expect(hist.map((e: any) => e.kind)).toEqual(expect.arrayContaining(["create_requested", "create_indefinite", "created"]));
  });

  it("DUPLICATE_INVOICE_ID on capture is reconciled; Transaction Search's 403 and the token's scope are recorded; the order audit books a refund once", async () => {
    const { checkoutId } = await order();
    await worker.tick();
    const [p] = await porders(checkoutId);
    pp.approve(p.paypal_order_id);
    pp.duplicateInvoice(p.paypal_order_id);
    await dueStatus(checkoutId);
    await worker.tick();
    expect(await recon("duplicate_invoice")).toEqual([expect.objectContaining({ checkout_id: checkoutId, paypal_ref: p.paypal_order_id })]);
    expect((await checkoutRow(checkoutId)).status).not.toBe("captured");
    // Transaction Search: 403 with its name and debug id; the token lacks the scope.
    const sync = await R.q(`SELECT kind, last_http, last_error_name, last_debug_id, last_ok_at, detail FROM fleet.fleet_paypal_sync_status WHERE rail_id = $1 ORDER BY kind`, [rail.railId]);
    expect(sync.find((s: any) => s.kind === "transaction_search")).toMatchObject({ last_http: 403, last_error_name: "NOT_AUTHORIZED", last_debug_id: expect.stringMatching(/^dbg-/), last_ok_at: null });
    expect(sync.find((s: any) => s.kind === "token_scopes")).toMatchObject({ last_ok_at: null, detail: { transactionSearch: false, scopes: 3 } });
    expect(PAYPAL_SEARCH_SCOPE).toBe("https://uri.paypal.com/services/reporting/search/read");
    // The audit: a refund PayPal reports on the control's captured order is booked once (webhook or not), however often it is read.
    const o = pp.orders.get(control.paypalOrderId)!;
    o.capture!.status = "PARTIALLY_REFUNDED";
    o.refunds.push({ id: id("R"), amount: "10.00", status: "COMPLETED" });
    for (let i = 0; i < 2; i++) { await dueWatch(); await worker.tick(); }
    expect(await one<number>(`(SELECT count(*)::int FROM fleet.fleet_paypal_clawback_evidence WHERE ref_id = $1)`, [o.refunds[0].id])).toBe(1);
    expect((await R.q(`SELECT kind FROM fleet.fleet_paypal_provider_order_events e JOIN fleet.fleet_paypal_provider_orders p USING (provider_order_id)
      WHERE p.paypal_order_id = $1 AND kind = 'audit'`, [control.paypalOrderId])).length).toBeGreaterThanOrEqual(2);
    expect((await R.q(`SELECT last_ok_at FROM fleet.fleet_paypal_sync_status WHERE rail_id = $1 AND kind = 'order_audit'`, [rail.railId]))[0].last_ok_at).not.toBeNull();
  });

  it("guards: the current PayPal order changes only to a recorded one after retirement; provider orders and their history are immutable", async () => {
    const { checkoutId } = await order();
    await worker.tick();
    await expect(R.q(`UPDATE fleet.fleet_paypal_checkouts SET paypal_order_id = 'OFORGED00001' WHERE checkout_id = $1`, [checkoutId])).rejects.toThrow(/FLEET_IMMUTABLE/);
    await expect(R.q(`DELETE FROM fleet.fleet_paypal_provider_orders WHERE checkout_id = $1`, [checkoutId])).rejects.toThrow(/FLEET_HISTORY_IMMUTABLE/);
    await expect(R.q(`UPDATE fleet.fleet_paypal_provider_orders SET paypal_order_id = 'OFORGED00002' WHERE checkout_id = $1`, [checkoutId])).rejects.toThrow(/FLEET_IMMUTABLE/);
    await expect(R.q(`UPDATE fleet.fleet_paypal_provider_order_events SET debug_id = 'x' WHERE event_id = (SELECT min(event_id) FROM fleet.fleet_paypal_provider_order_events)`)).rejects.toThrow(/HISTORY|IMMUTABLE/i);
    // A second live provider order for the same checkout is impossible.
    await expect(R.q(`INSERT INTO fleet.fleet_paypal_provider_orders (checkout_id, attempt, request_id, rail_id, credential_id, rail_mode, state)
      SELECT checkout_id, 9, 'order:' || checkout_id || ':9', rail_id, credential_id, rail_mode, 'creating' FROM fleet.fleet_paypal_provider_orders WHERE checkout_id = $1`, [checkoutId]))
      .rejects.toThrow(/fleet_paypal_provider_orders_live|duplicate key/);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });

  it("the order page: Pay posts to /pay — to PayPal when the link is fresh, else back to the page that opens a fresh checkout", async () => {
    const { checkoutId, token } = await order();
    await worker.tick();
    const post = () => fetch(`${base}/order/${token}/pay`, { method: "POST", redirect: "manual", headers: { origin: base, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" }, body: "" });
    let r = await post();
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toMatch(/^https:\/\/www\.paypal\.com\/checkoutnow\?token=/);
    await stale(checkoutId);
    const btn = await fetch(`${base}/order/${token}`);
    let html = await btn.text();
    expect(html).toContain(`action="/order/${token}/pay"`);
    // The page with the button lets its own form hand the buyer on to PayPal (Chrome applies form-action to that redirect).
    expect(btn.headers.get("content-security-policy")).toContain("form-action 'self' https://www.paypal.com https://www.sandbox.paypal.com");
    expect(html).not.toContain("checkoutnow");
    r = await post();
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(`/order/${token}`);
    const res = await fetch(`${base}/order/${token}`);
    html = await res.text();
    expect(html).toContain("Opening a fresh PayPal checkout");
    expect(html).toContain('http-equiv="refresh" content="3"');
    expect(res.headers.get("content-security-policy")).toContain("form-action 'self';");
    await worker.payTick();
    html = await (await fetch(`${base}/order/${token}`)).text();
    expect(html).toContain("checkoutnow?token=");
    // Cross-site posts stay refused.
    const x = await fetch(`${base}/order/${token}/pay`, { method: "POST", redirect: "manual", headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" }, body: "" });
    expect(x.status).toBe(403);
  });

  // v99: back from PayPal the buyer sees "processing" (never "not paid yet" or the Pay button); custody reads the order at once.
  it("v99: PayPal's return → 'processing', captured within a pass; a return without approval goes back to the payment step; a foreign order id changes nothing", async () => {
    const { checkoutId, token } = await order();
    await worker.tick();
    const [p] = await porders(checkoutId);
    const back = (oid: string) => fetch(`${base}/order/${token}?token=${oid}&PayerID=PAYERBEA0001`, { redirect: "manual" });
    // An order id that is not this checkout's current one: nothing recorded.
    let r = await back("OSOMEOTHER0001");
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(`/order/${token}`);
    expect((await checkoutRow(checkoutId)).returned_at).toBeNull();
    // Approved at PayPal, back on the page: processing, no Pay button, refreshing; one pass captures it.
    pp.approve(p.paypal_order_id);
    r = await back(p.paypal_order_id);
    expect(r.status).toBe(303);
    let html = await (await fetch(`${base}/order/${token}`)).text();
    expect(html).toContain("Processing your payment");
    expect(html).toContain("Please don&#39;t pay again".replace("&#39;", "'"));
    expect(html).not.toContain("Not paid yet");
    expect(html).not.toContain("/pay\"");
    expect(html).not.toContain("checkoutnow");
    expect(html).toContain('http-equiv="refresh" content="3"');
    await back(p.paypal_order_id);                                  // a reload of PayPal's return URL: still one request
    await worker.payTick();
    expect((await checkoutRow(checkoutId)).status).toBe("captured");
    html = await (await fetch(`${base}/order/${token}`)).text();
    expect(html).toContain("Receipt");
    expect(html).not.toContain("Processing your payment");
    // A return without approval (the buyer did not finish at PayPal): processing, then back to the payment step — never "paid".
    const second = await order();
    await worker.tick();
    const [q] = await porders(second.checkoutId);
    await fetch(`${base}/order/${second.token}?token=${q.paypal_order_id}&PayerID=PAYERBEA0001`, { redirect: "manual" });
    expect(await pageOf(second.token)).toMatchObject({ pay: "processing" });
    await worker.payTick();                                          // PayPal: still CREATED → reused, the step is offered again
    const pg2 = await pageOf(second.token);
    expect(pg2).toMatchObject({ pay: "link", payment: "awaiting_payment" });
    expect(pp.captures.filter((c) => c.order === q.paypal_order_id)).toHaveLength(0);
  });

  // Chrome applies the page's form-action to the redirect after a form POST: the Pay button must reach PayPal in a real browser.
  it.skipIf(!CHROME)("a real browser: Pay on a stale link opens a fresh checkout, then reaches PayPal; a fresh one goes straight there", async () => {
    const { checkoutId, token } = await order();
    await worker.tick();
    await stale(checkoutId);
    const { chromium } = await import("playwright-core");
    const b = await chromium.launch({ executablePath: CHROME, headless: true });
    try {
      const p = await b.newPage();
      const reached: string[] = [];
      await p.route("https://www.paypal.com/**", async (r) => { reached.push(r.request().url()); await r.fulfill({ status: 200, contentType: "text/html", body: "<h1>PayPal (stand-in)</h1>" }); });
      await p.route("https://www.paypalobjects.com/**", (r) => r.fulfill({ status: 200, contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg'/>" }));
      await p.goto(`${base}/order/${token}`);
      await Promise.all([p.waitForURL(`${base}/order/${token}`), p.click("form[action$='/pay'] button")]);
      expect(await p.innerText("body")).toContain("Opening a fresh PayPal checkout");
      await worker.payTick();                       // PayPal still has it: re-confirmed and reused
      await p.reload();
      const href = await p.getAttribute("a.pp", "href");
      expect(href).toMatch(/^https:\/\/www\.paypal\.com\/checkoutnow\?token=/);
      await Promise.all([p.waitForURL(/paypal\.com/), p.click("a.pp")]);
      expect(reached).toEqual([href]);
      // Fresh link, pressed through the form path (another tab's stale page): the POST hands the buyer straight to PayPal.
      const q = await b.newPage();
      await q.route("https://www.paypal.com/**", async (r) => { reached.push(r.request().url()); await r.fulfill({ status: 200, contentType: "text/html", body: "ok" }); });
      await q.setContent(`<form method="post" action="${base}/order/${token}/pay"><button>Pay</button></form>`);
      await q.goto(`${base}/order/${token}`);
      await q.evaluate((t) => { const f = document.createElement("form"); f.method = "post"; f.action = `/order/${t}/pay`; document.body.appendChild(f); f.submit(); }, token);
      await q.waitForURL(/paypal\.com/);
      expect(reached.at(-1)).toBe(href);
    } finally { await b.close(); }
  }, 120_000);
});

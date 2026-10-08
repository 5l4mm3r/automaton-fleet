/**
 * Schema v52 — Gumroad G3 (the storefront gateway) and G4 (receipt evidence). PostgreSQL + the gateway and bank-feed
 * connector as their restricted logins; Gumroad is a fake REST API built from the documented payloads (no network).
 *
 * Proven here: storefront operations wait for a verified storefront; the gateway runs a job only for an account whose
 * token reaches exactly the registered user with exactly the allowed scopes; a draft is created (and adopted by its
 * permalink when the answer was lost), a file attached with the full file list, a publish warning keeps a draft and fails
 * storefront_publication; one agent never sees or acts on another's product; the allowlist refuses refunds, receipts,
 * offer codes and foreign hosts; sales are read back (memo, attributed, first sale proves sale_ingestion) and payouts with
 * their rows; a payout received in the PayPal treasury is matched from PayPal's records and posted to the agent (S5); a
 * bank feed records receipts through rx_* and refuses a wider-than-read consent; agents cannot operate gumroad.com
 * directly; the gateway refuses to start with any safety switch on.
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
import { MemoryVault } from "../../fleet/payments/credential-broker.js";
import { PgStorefrontGateway } from "../../fleet/storefront/gateway.js";
import { StorefrontWorker } from "../../fleet/storefront/worker.js";
import { gumroadAllowed, partUploadAllowed, centsOf, payoutRowType, type StorefrontHttp } from "../../fleet/storefront/gumroad-client.js";
import { storefrontEnvProblems, oauthUrl, oauthExchange } from "../../fleet/storefront/main.js";
import { BankFeedConnector, type BankFeedClient } from "../../fleet/settlement/bankfeed.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";

const PG_BIN = findPgBin();
const SELLER = "SELLERuser01";
const TOKEN_REF = "vault:gumroad/owner";

/** A fake Gumroad API (and S3 part host) with the documented shapes. */
function fakeGumroad(o: { scopes?: string[]; userId?: string } = {}) {
  const products = new Map<string, { id: string; custom_permalink: string; name: string; price: number; published: boolean; files: Array<{ url: string }> }>();
  const sales: Array<Record<string, unknown>> = [];
  const payouts: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  let loseNextCreate = false;
  let warnOnPublish: string | null = null;
  const http: StorefrontHttp = async (url, init) => {
    const u = new URL(url);
    calls.push(`${init.method} ${u.host}${u.pathname}`);
    const res = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ status, json: async () => body, header: (n: string) => headers[n.toLowerCase()] ?? null });
    if (u.host.endsWith("amazonaws.com")) return res(200, {}, { etag: `"etag-${crypto.randomBytes(3).toString("hex")}"` });
    if (init.headers.Authorization !== "Bearer gumroad-token-0001") return res(401, { success: false });
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (u.pathname === "/v2/user") return res(200, { success: true, user: { user_id: o.userId ?? SELLER, name: "Owner" } });
    if (u.pathname === "/oauth/token/info") return res(200, { scope: o.scopes ?? ["edit_products", "view_sales", "view_payouts"] });
    if (u.pathname === "/v2/products" && init.method === "GET") return res(200, { success: true, products: [...products.values()].map((p) => ({ id: p.id, custom_permalink: p.custom_permalink, published: p.published })) });
    if (u.pathname === "/v2/products" && init.method === "POST") {
      const id = `P${crypto.randomBytes(5).toString("hex")}`;
      products.set(id, { id, custom_permalink: body.custom_permalink, name: body.name, price: body.price, published: false, files: [] });
      if (loseNextCreate) { loseNextCreate = false; return res(502, {}); }
      return res(200, { success: true, product: { id } });
    }
    const pm = /^\/v2\/products\/([A-Za-z0-9]+)(\/(enable|disable))?$/.exec(u.pathname);
    if (pm) {
      const p = products.get(pm[1]);
      if (!p) return res(404, { success: false });
      if (init.method === "DELETE") { products.delete(pm[1]); return res(200, { success: true }); }
      if (pm[3] === "enable") { if (warnOnPublish) return res(200, { success: true, product: { id: p.id }, warning: warnOnPublish }); p.published = true; return res(200, { success: true }); }
      if (pm[3] === "disable") { p.published = false; return res(200, { success: true }); }
      if (body.files) p.files = body.files;
      if (body.name) p.name = body.name;
      return res(200, { success: true, product: { id: p.id } });
    }
    if (u.pathname === "/v2/files/presign") return res(200, { upload_id: "UP1", key: "k/1", parts: [{ part_number: 1, presigned_url: "https://fleet-uploads.s3.amazonaws.com/k/1?part=1" }] });
    if (u.pathname === "/v2/files/complete") return res(200, { file_url: `https://files.gumroad.com/${crypto.randomBytes(4).toString("hex")}` });
    if (u.pathname === "/v2/sales") return res(200, { success: true, sales });
    if (u.pathname === "/v2/payouts") return res(200, { success: true, payouts: payouts.map((p) => ({ id: p.id })) });
    const po = /^\/v2\/payouts\/([A-Za-z0-9]+)$/.exec(u.pathname);
    if (po) return res(200, { success: true, payout: payouts.find((p) => p.id === po[1]) });
    return res(404, { success: false });
  };
  return { http, products, sales, payouts, calls, loseNextCreate: () => { loseNextCreate = true; }, warnOnPublish: (w: string | null) => { warnOnPublish = w; } };
}

describe.skipIf(!PG_BIN)("v52 storefront gateway (G3) and receipt evidence (G4) (PostgreSQL + fake Gumroad)", () => {
  let R: EconomyRegistry;
  let F: Founder;
  let G: Founder;
  let gumroadRail = "";
  let account = "";
  let gw: PgStorefrontGateway;
  let fake: ReturnType<typeof fakeGumroad>;
  let worker: StorefrontWorker;
  let svc: pg.Pool;
  let custody: pg.Pool;
  let paypal: ArmedCustody;
  const vault = new MemoryVault(new Map([[TOKEN_REF, "gumroad-token-0001"]]));
  const k = () => ({ idempotencyKey: `sf-${crypto.randomUUID()}` });
  const job = async (jobId: string) => (await R.q(`SELECT status, error, result FROM fleet.fleet_provider_jobs WHERE job_id = $1`, [jobId]))[0];
  const cx = (fn: string, args: unknown[]) => custody.query(`SELECT fleet.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) AS r`, args).then((r) => r.rows[0].r);

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000, simulatedSettlement: false });
    [F, G] = R.founders;
    for (const [who, key] of [[F, "printables"], [G, "planners"]] as const) {
      expect((await R.econ(who, "venture.create", { key, model: "digital_product", offer: key, state: "selected" })).ok).toBe(true);
    }
    const cred = await R.one(`fleet.fleet_admin_credential_register('gumroad', 'owner store token', $1, ARRAY['edit_products','view_sales','view_payouts'], false, 'gumroad owner', $2)`,
      [TOKEN_REF, OWNER]);
    gumroadRail = (await R.one(`fleet.fleet_admin_rail_add('gumroad', 'Owner Gumroad', 'shared', NULL, ARRAY['storefront','receive_payments'], 'gumroad: owner store', $1, 'live_receive', NULL, NULL, $2)`,
      [cred.credential_id, OWNER])).railId;
    account = (await R.one(`fleet.fleet_admin_provider_account_register($1, $2, 'Owner store', NULL, $3)`, [gumroadRail, SELLER, OWNER])).accountId;
    gw = new PgStorefrontGateway({ connectionString: R.pgc.providerUrl });
    fake = fakeGumroad();
    worker = new StorefrontWorker(gw, vault, fake.http, { pollEveryMs: 0, reconcileEveryMs: 0, accountCheckEveryMs: 0 });
    await R.store.grantServiceRole();
    await R.store.grantCustodyRole();
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2 });
    custody = new pg.Pool({ connectionString: R.pgc.custodyUrl, max: 2 });
    paypal = await liveRail(R.owner, "fleet", OWNER);
  }, 240_000);
  afterAll(async () => { await gw?.close(); await svc?.end(); await custody?.end(); await R?.close(); });

  it("migrates to v52 with a clean audit; the gateway and bank-feed roles reach only their own protocol", async () => {
    expect(await R.one(`(SELECT max(version) FROM fleet.fleet_schema_migrations)`)).toBe(FLEET_PG_SCHEMA_VERSION);
    const a = await R.store.auditPrivileges();
    expect(a.problems).toEqual([]);
    expect(a.roles.find((r) => r.role === "fleet_provider")?.functions.every((f) => f.startsWith("gx_"))).toBe(true);
    expect(a.roles.find((r) => r.role === "fleet_bankfeed")?.functions.every((f) => f.startsWith("rx_"))).toBe(true);
    const p = new pg.Pool({ connectionString: R.pgc.providerUrl, max: 1 });
    try {
      expect(await R.code(p.query(`SELECT * FROM fleet.fleet_provider_products`))).toBe("permission denied");
      expect(await R.code(p.query(`SELECT fleet.fleet_provider_sale_record(NULL, 'a', 'b', now(), 'USD', 1, 0, 0, NULL, '{}', 'x', 'y')`))).toBe("permission denied");
      expect(await R.code(p.query(`SELECT fleet.rx_receipt_record('x-worker', gen_random_uuid(), '{}'::jsonb)`))).toBe("permission denied");
    } finally { await p.end(); }
  });

  it("storefront operations wait for a verified storefront; the gateway runs nothing for an account it could not verify", async () => {
    expect((await R.econ(F, "storefront.product.create", { ventureKey: "printables", name: "Habit tracker", priceMinor: 500, ...k() })).code).toBe("FLEET_STOREFRONT_NOT_READY");
    // A token with a wider scope than allowed: the account check fails and is recorded.
    const wide = new StorefrontWorker(gw, vault, fakeGumroad({ scopes: ["edit_products", "view_sales", "view_payouts", "edit_sales"] }).http, { pollEveryMs: 0, accountCheckEveryMs: 0 });
    await wide.tick();
    expect((await R.one(`fleet.fleet_rail_readiness($1)`, [gumroadRail])).checks.account_access).toMatchObject({ status: "failed" });
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_events WHERE event_type = 'gateway_account_refused')`))).toBe(1);
    // The right token: account_access verified automatically; storefront publication is the owner's attestation.
    await worker.tick();
    expect((await R.one(`fleet.fleet_rail_readiness($1)`, [gumroadRail])).checks.account_access).toMatchObject({ status: "verified", evidenceKind: "automatic" });
    await R.one(`fleet.fleet_admin_rail_verify($1, 'storefront_publication', 'verified', 'owner_attested', '{"note":"email confirmed, payout method set"}'::jsonb, NULL, $2)`, [gumroadRail, OWNER]);
    await R.one(`fleet.fleet_admin_rail_set_status($1, 'active', 'storefront ready', $2)`, [gumroadRail, OWNER]);
  });

  it("a draft is created (adopted by its permalink when the answer is lost), a file attached with the full list, a publish warning keeps a draft", async () => {
    const c = await R.econ(F, "storefront.product.create", { ventureKey: "printables", name: "Habit tracker", priceMinor: 500, description: "A printable habit tracker", ...k() });
    expect(c).toMatchObject({ ok: true, product: { state: "draft_creating" } });
    fake.loseNextCreate();
    await worker.tick();
    expect(await job(c.jobId)).toMatchObject({ status: "succeeded", result: { adopted: true } });
    const p = (await R.econ(F, "storefront.products")).products[0];
    expect(p).toMatchObject({ state: "draft", productRef: c.product.productRef });
    expect(fake.products.size).toBe(1); // never a second product
    expect(await R.one(`fleet.fleet_provider_product_owner($1, $2, now())`, [account, p.productId])).toBe(F.id);
    // A file, then another: each attach carries every file the product keeps.
    for (const name of ["tracker.pdf", "tracker-a5.pdf"]) {
      const f = await R.econ(F, "storefront.file", { productRef: p.productRef, fileName: name, contentB64: Buffer.from(`%PDF-1.4 ${name}`).toString("base64"), ...k() });
      expect(f.ok, JSON.stringify(f)).toBe(true);
      await worker.tick();
      expect((await job(f.jobId)).status).toBe("succeeded");
    }
    expect(fake.products.get(p.productId)!.files.length).toBe(2);
    expect(await R.one(`(SELECT count(*)::int FROM fleet.fleet_provider_uploads WHERE blob IS NOT NULL)`)).toBe(0); // bytes erased once attached
    // Publishing while Gumroad answers with a warning: still a draft; storefront_publication is marked failed.
    fake.warnOnPublish("Your email address is not confirmed");
    const pub = await R.econ(F, "storefront.product.publish", { productRef: p.productRef, ...k() });
    await worker.tick();
    expect((await job(pub.jobId)).status).toBe("succeeded");
    expect((await R.econ(F, "storefront.products")).products[0]).toMatchObject({ state: "draft", warning: "Your email address is not confirmed" });
    expect((await R.one(`fleet.fleet_rail_readiness($1)`, [gumroadRail])).checks.storefront_publication).toMatchObject({ status: "failed" });
    expect(await R.one(`fleet.fleet_event_route('storefront_publication_warning', '{}'::jsonb)`)).toBe("P1_HIGH");
    // The owner fixes the account; publication is verified again and the product publishes.
    fake.warnOnPublish(null);
    await R.one(`fleet.fleet_admin_rail_verify($1, 'storefront_publication', 'verified', 'owner_attested', '{"note":"email now confirmed"}'::jsonb, NULL, $2)`, [gumroadRail, OWNER]);
    await R.econ(F, "storefront.product.publish", { productRef: p.productRef, ...k() });
    await worker.tick();
    expect((await R.econ(F, "storefront.products")).products[0]).toMatchObject({ state: "published" });
    expect(fake.products.get(p.productId)!.published).toBe(true);
  });

  it("one agent never sees or acts on another's product; Gumroad is never operated directly by an agent", async () => {
    const ref = (await R.econ(F, "storefront.products")).products[0].productRef;
    for (const op of ["storefront.product.update", "storefront.product.unpublish", "storefront.product.delete", "storefront.file"]) {
      const r = await R.econ(G, op, { productRef: ref, name: "Mine now", fileName: "x.pdf", contentB64: "eA==", ...k() });
      expect(r, op).toMatchObject({ ok: false, code: "FLEET_NOT_FOUND" });
    }
    expect((await R.econ(G, "storefront.products")).products).toEqual([]);
    const reg = await R.econ(G, "account.register", { platform: "gumroad.com", kind: "storefront", origin: "https://gumroad.com" });
    expect(reg).toMatchObject({ ok: false, code: "FLEET_PROVIDER_VIA_GATEWAY" });
    const reg2 = await R.econ(G, "account.register", { platform: "shopify-like", kind: "storefront", origin: "https://app.gumroad.com" });
    expect(reg2.code).toBe("FLEET_PROVIDER_VIA_GATEWAY");
  });

  it("the client refuses everything outside the allowlist and any host but Gumroad's API and S3 part uploads", () => {
    const api = "https://api.gumroad.com";
    expect(gumroadAllowed("GET", `${api}/v2/sales`)).toBe(true);
    expect(gumroadAllowed("PUT", `${api}/v2/products/PABC123/enable`)).toBe(true);
    for (const [m, p] of [["PUT", "/v2/sales/S1/refund"], ["POST", "/v2/sales/S1/resend_receipt"], ["POST", "/v2/products/P1/offer_codes"], ["PUT", "/v2/user"],
      ["POST", "/v2/resource_subscriptions"], ["GET", "/v2/products/P1/custom_fields"]] as const) expect(gumroadAllowed(m, `${api}${p}`), p).toBe(false);
    expect(gumroadAllowed("GET", "https://evil.example.com/v2/sales")).toBe(false);
    expect(partUploadAllowed("https://bucket.s3.amazonaws.com/k?x=1")).toBe(true);
    expect(partUploadAllowed("http://bucket.s3.amazonaws.com/k")).toBe(false);
    expect(partUploadAllowed("https://amazonaws.com.evil.example/k")).toBe(false);
    expect([centsOf("12.30", false), centsOf("-0.70", false), centsOf(1230), centsOf("1.234", false)]).toEqual([1230, -70, 1230, null]);
    expect([payoutRowType("Sale"), payoutRowType("Full Refund"), payoutRowType("PayPal Payouts")]).toEqual(["sale", "full_refund", "summary"]);
    expect(oauthUrl("cid", "https://admin.example/cb")).toContain("scope=edit_products+view_sales+view_payouts");
  });

  it("sales are read back and recorded once (memo; the first attributed sale proves sale_ingestion); payouts with their rows", async () => {
    const pid = (await R.econ(F, "storefront.products")).products[0].productId;
    const at = new Date().toISOString(); // after the product was created (a sale before it would be nobody's)
    fake.sales.push({ id: "SALE00000001", product_id: pid, created_at: at, price: 500, gumroad_fee: 50, refunded: false, email: "buyer@example.com", currency: "usd" });
    const cash0 = await R.balance(`agent:${F.id}:cash`);
    await worker.tick();
    await worker.tick(); // re-read: one memo row
    expect(await R.one(`(SELECT count(*)::int FROM fleet.fleet_provider_sales WHERE sale_id = 'SALE00000001')`)).toBe(1);
    expect(await R.balance(`agent:${F.id}:cash`)).toBe(cash0); // S1 is never money
    expect((await R.one(`fleet.fleet_rail_readiness($1)`, [gumroadRail])).checks.sale_ingestion).toMatchObject({ status: "verified" });
    const mine = await R.econ(F, "storefront.sales");
    expect(mine.sales[0]).toMatchObject({ saleId: "SALE00000001", priceMinor: 500 });
    expect(JSON.stringify(mine)).not.toContain("buyer@example.com"); // no buyer data in the registry
    expect((await R.econ(G, "storefront.sales")).sales).toEqual([]);
    // A GBP payout of a USD sale: Gumroad converted at the sale (4.50 USD ≈ 3.56 GBP at the recorded 0.79).
    fake.payouts.push({ id: "PAYOUT000001", amount: "3.56", currency: "GBP", status: "completed", processed_at: new Date(Date.now() - 3_600_000).toISOString(),
      sales: ["SALE00000001"], transactions: [{ type: "Sale", date: at.slice(0, 10), purchase_id: "SALE00000001", taxes: "0.00", sale_price: "5.00", gumroad_fees: "0.50", net_total: "4.50" }] });
    await worker.tick();
    expect((await R.q(`SELECT amount_minor, currency, status, line_count FROM fleet.fleet_provider_payouts WHERE payout_id = 'PAYOUT000001'`))[0])
      .toMatchObject({ amount_minor: "356", currency: "GBP", status: "completed", line_count: 1 });
  });

  it("a payout received in the PayPal treasury is matched from PayPal's own records and posted to the agent (S5)", async () => {
    await R.one(`fleet.fleet_fx_record('USD', 'GBP', 790000, 'test fixture rate', current_date, $1)`, [OWNER]);
    const d = (await R.one(`fleet.fleet_admin_settlement_destination_add('fleet_treasury', 'PayPal treasury', 'PayPal treasury', NULL, 'GBP', NULL, NULL, NULL, $1)`, [OWNER])).destination_id;
    await R.one(`fleet.fleet_admin_settlement_destination_paypal($1, $2, $3)`, [d, paypal.railId, OWNER]);
    await R.one(`fleet.fleet_admin_settlement_destination_verify_access($1, 'automatic', '{"note":"the owner''s PayPal treasury, observed by custody"}'::jsonb, $2)`, [d, OWNER]);
    const match = async () => (await svc.query(`SELECT fleet.svc_settlement_paypal_match(50) AS r`)).rows[0].r;
    expect(await match()).toMatchObject({ matched: 0 }); // nothing in PayPal yet
    const txn = (id: string, amount: number) => cx("cx_paypal_txn_record", ["custody-executor", paypal.railId, JSON.stringify({ transactionId: id, eventCode: "T0000",
      initiatedAt: new Date().toISOString(), status: "S", currency: "GBP", amountMinor: amount, feeMinor: 0 })]);
    await txn("TXNGUMROAD001", 356);
    expect(await match()).toMatchObject({ matched: 0, waitingForBalance: 1 }); // no covering Balances reading yet
    await cx("cx_paypal_balance_record", ["custody-executor", paypal.railId, "GBP", 100_000, 100_000]);
    const cash0 = await R.balance(`agent:${F.id}:cash`);
    expect(await match()).toMatchObject({ matched: 1 });
    expect(await R.balance(`agent:${F.id}:cash`)).toBe(cash0 + 356);
    const r = (await R.q(`SELECT status, evidence_kind FROM fleet.fleet_settlement_receipts WHERE bank_txn_id LIKE 'paypal:TXNGUMROAD001%'`))[0];
    expect(r).toMatchObject({ status: "posted", evidence_kind: "paypal_txn" });
    expect(await R.one(`(SELECT attributed_as FROM fleet.fleet_paypal_transactions WHERE transaction_id = 'TXNGUMROAD001')`)).toBe("provider_payout");
    expect(await match()).toMatchObject({ matched: 0 }); // once
    const ready = (await R.one(`fleet.fleet_rail_readiness($1)`, [gumroadRail])).checks;
    expect(ready.receipt_verification).toMatchObject({ status: "verified" });
    expect(ready.payout_reconciliation).toMatchObject({ status: "verified" });
  });

  it("a bank feed records receipts through rx_* only, and refuses a consent wider than reading", async () => {
    const cred = await R.one(`fleet.fleet_admin_credential_register('bankfeed', 'treasury bank read', 'vault:bankfeed/treasury', ARRAY['read_accounts','read_transactions'], false, 'bank', $1)`, [OWNER]);
    const d = (await R.one(`fleet.fleet_admin_settlement_destination_add('fleet_treasury', 'Treasury bank', 'Treasury bank ••99', NULL, 'GBP', NULL, NULL, $1, $2)`,
      [cred.credential_id, OWNER])).destination_id;
    const rx = new pg.Pool({ connectionString: R.pgc.bankfeedUrl, max: 1 });
    try {
      const port = {
        destinations: async (w: string) => (await rx.query(`SELECT fleet.rx_destinations($1) AS r`, [w])).rows[0].r,
        receiptRecord: async (w: string, dest: string, t: unknown) => (await rx.query(`SELECT fleet.rx_receipt_record($1, $2, $3) AS r`, [w, dest, JSON.stringify(t)])).rows[0].r,
      };
      const bankVault = new MemoryVault(new Map([["vault:bankfeed/treasury", "consent-token"]]));
      const client = (scopes: string[]): BankFeedClient => ({ scopes: async () => scopes,
        transactions: async () => [{ transactionId: "BANKTXN0001", amountMinor: 12_34, currency: "GBP", bookedOn: new Date().toISOString().slice(0, 10), descriptor: "GUMROAD" }] });
      const wide = await new BankFeedConnector(port, bankVault, client(["read_accounts", "read_transactions", "payments"])).tick();
      expect(wide).toMatchObject({ refused: 1, recorded: 0 });
      const ok = await new BankFeedConnector(port, bankVault, client(["read_accounts", "read_transactions"])).tick();
      expect(ok.recorded).toBe(1);
      expect((await R.q(`SELECT status, evidence_kind FROM fleet.fleet_settlement_receipts WHERE destination_id = $1`, [d]))[0])
        .toMatchObject({ status: "unmatched", evidence_kind: "bank_feed" }); // no reported payout of that amount: nothing guessed
    } finally { await rx.end(); }
  });

  it("the gateway refuses to start with any safety switch on or another unit's credential visible; onboarding refuses a wide token", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-vault-"));
    fs.chmodSync(dir, 0o700);
    try {
      const base = { FLEET_PROVIDER_DATABASE_URL: "postgresql://x", FLEET_STOREFRONT_VAULT_DIR: dir };
      expect(storefrontEnvProblems(base)).toEqual([]);
      for (const k of ["REAL_PAYMENTS_ENABLED", "REAL_REPLICATION_ENABLED", "OWNER_SWEEP_ENABLED", "FLEET_DRY_RUN_CHILD"]) {
        expect(storefrontEnvProblems({ ...base, [k]: "true" }).join(" ")).toMatch(k);
      }
      expect(storefrontEnvProblems({ ...base, FLEET_CUSTODY_DATABASE_URL: "postgresql://y" }).join(" ")).toMatch(/FLEET_CUSTODY_DATABASE_URL/);
      const token = (scope: string): StorefrontHttp => async () => ({ status: 200, json: async () => ({ access_token: "gumroad-token-xyz-0001", scope }), header: () => null });
      await expect(oauthExchange(dir, "vault:gumroad/owner", { clientId: "c", clientSecret: "s", code: "x", redirectUri: "https://a/cb" },
        token("edit_products view_sales view_payouts account"))).rejects.toThrow(/FLEET_PROVIDER_SCOPE/);
      const ok = await oauthExchange(dir, "vault:gumroad/owner", { clientId: "c", clientSecret: "s", code: "x", redirectUri: "https://a/cb" }, token("view_payouts view_sales edit_products"));
      expect(ok).toEqual({ stored: "vault:gumroad/owner", scopes: ["edit_products", "view_payouts", "view_sales"] });
      expect(fs.statSync(path.join(dir, "gumroad~owner")).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(ok)).not.toContain("gumroad-token-xyz");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("the audit stays clean; the ledger verifies", async () => {
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
    expect((await R.one(`fleet.fleet_ledger_verify()`)).ok).toBe(true);
  });
});

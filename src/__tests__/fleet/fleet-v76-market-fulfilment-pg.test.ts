/**
 * Schema v76 — the market-facing loop (PostgreSQL + the identity broker on a simulated shared mailbox + custody's cx_* calls).
 *
 * Proven here: payment detection without the webhook (custody's status reads: APPROVED → capture, COMPLETED read back,
 * VOIDED fails; backed off; once per evidence); offers publish only on evidence (a product on a passing review of exactly
 * its files; a service on a passing review of a work sample; the public site, a receiving rail and a mailbox first); the
 * public buy creates a fresh checkout and order per buyer with the order page as PayPal's return; a paid product is
 * delivered automatically from its reviewed files and stays downloadable; changing a published product's files pauses it;
 * a service brief with reference files becomes an enquiry that wakes the agent, is clarified, quoted (capacity respected)
 * and paid; delivery needs a passing review of exactly the delivered files against the current requirements — a buyer's
 * revision request makes it stale — and the revision is delivered with a new review; reviews are bound to the inspector's
 * report, fail on automated failures, unmet criteria or a failed independent review, and are immutable; the buyer's pages
 * show only their own order; another agent sees and acts on nothing; the privilege audit stays clean.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { BUYER_CONSENT_VERSION } from "../../fleet/storefront/consent.js";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, autoCapabilityChecks, OWNER, type EconomyRegistry, type Founder, econNext } from "./fixtures/economy-registry.js";
import { liveRail, type ArmedCustody } from "./fixtures/custody-signer.js";
import { PgIdentityGateway } from "../../fleet/identity/gateway.js";
import { IdentityBroker } from "../../fleet/identity/broker.js";
import { SimulatedSharedMailProvider } from "../../fleet/identity/providers.js";
import { initIdentityState, openIdentityState, openProviderVault } from "../../fleet/identity/main.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";
import { EVENT_ROUTES_V76 } from "../../fleet/postgres/migrations-phase76.js";

const PG_BIN = findPgBin();
const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

/** A review's automated part as the runtime's inspector reports it (shape only: the registry validates it, the runtime produces it). */
export const autoReport = (files: Array<{ name: string; bytes: Buffer }>, fail: string | null = null) => ({
  inspector: "fleet-qa-3", ok: !fail,
  files: files.map((f, i) => ({ path: f.name, sha256: sha(f.bytes), sizeBytes: f.bytes.length, detectedType: "pdf", ok: !(fail && i === 0),
    checks: [{ id: "nonempty", status: "pass", detail: "ok" }, ...(fail && i === 0 ? [{ id: fail, status: "fail", detail: "found" }] : [])] })),
});
const basicCriteria = (met = true) => [
  { criterion: "Covers everything the brief asks for", met, evidence: "checked each requested item against the file" },
  { criterion: "Calculations and totals reconcile", met: true, evidence: "recalculated the totals sheet; matches" },
  { criterion: "Clear instructions for the buyer", met: true, evidence: "read the instructions page start to finish" },
];
/** The basic criteria plus one met criterion per deliverable the offers in this file promise (v76: every promise is checked). */
export const criteria = (met = true) => [...basicCriteria(met),
  ...["Cash-flow workbook (.xlsx)", "Quick-start guide (.pdf)", "A tested .xlsx workbook", "A one-page guide"].map((d) => ({ criterion: d, met: true, evidence: "opened and checked against the listing" }))];

describe.skipIf(!PG_BIN)("v76: offers, buyers, reviews and delivery (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let F: Founder;
  let G: Founder;
  let svc: pg.Pool;
  let custody: pg.Pool;
  let rail: ArmedCustody;
  let dir: string;
  let igw: PgIdentityGateway;
  let broker: IdentityBroker;
  const shared = new SimulatedSharedMailProvider("fleet@shared.fleet-mail.test");
  const idem = () => `k-${crypto.randomUUID()}`;
  const cx = async (fn: string, args: unknown[]) => {
    const ph = args.map((_, i) => `$${i + 1}`).join(", ");
    return (await custody.query(`SELECT fleet.${fn}(${ph}) AS r`, args)).rows[0].r;
  };
  const pub = async (fn: string, args: unknown[]) => {
    const ph = args.map((_, i) => `$${i + 1}`).join(", ");
    return (await svc.query(`SELECT fleet.${fn}(${ph}) AS r`, args.map((a) => (a !== null && typeof a === "object" ? JSON.stringify(a) : a)))).rows[0].r;
  };
  const origin = sha("buyer-ip-1");
  const events = async (type: string) => Number(await R.one(`(SELECT count(*) FROM fleet.fleet_events WHERE event_type = $1)`, [type]));
  const review = (who: Founder, a: Record<string, unknown>, files: Array<{ name: string; bytes: Buffer }>, o: { fail?: string; met?: boolean; verdict?: string } = {}) =>
    R.econ(who, "review.record", { ...a, files: files.map((f) => ({ name: f.name, sha256: sha(f.bytes), sizeBytes: f.bytes.length })),
      automated: autoReport(files, o.fail ?? null), criteria: criteria(o.met ?? true), verdict: o.verdict ?? "pass" });
  /** PayPal: custody opens the checkout; the buyer approves; (optionally) custody captures and reads the buyer. */
  const open = async (checkoutId: string) => {
    const orderId = `ORD${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
    expect((await cx("cx_paypal_checkout_update", ["custody-executor", checkoutId, "open", orderId, `https://www.paypal.com/checkoutnow?token=${orderId}`, null])).ok).toBe(true);
    return orderId;
  };
  const pay = async (checkoutId: string, amount: number, buyer = "buyer@example.test") => {
    expect((await cx("cx_paypal_capture_record", ["custody-executor", checkoutId, `CAP${crypto.randomBytes(6).toString("hex").toUpperCase()}`, "COMPLETED", amount, 60, "GBP", "capture_response"])).ok).toBe(true);
    expect((await cx("cx_paypal_buyer_record", ["custody-executor", checkoutId, JSON.stringify({ email_address: buyer, name: { given_name: "Bea", surname: "Buyer" },
      address: { country_code: "GB" }, payer_id: "PAYERBEA0001" })])).recorded).toBe(true);
  };
  const checkoutOf = async (token: string) => R.one<string>(`(SELECT checkout_id::text FROM fleet.fleet_customer_orders WHERE access_token = $1)`, [token]);

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000, simulatedSettlement: false, outwardHeld: true });
    // v85: an agent checks what it can deliver before it quotes or publishes (valid 7 days).
    // v87: each publish / quote is preceded by a check naming it (the gate itself: fleet-v87-media-capabilities-pg).
    autoCapabilityChecks(R);
    [F, G] = R.founders;
    await R.store.grantServiceRole();
    await R.store.grantCustodyRole();
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2, options: "-c search_path=fleet" });
    custody = new pg.Pool({ connectionString: R.pgc.custodyUrl, max: 2, options: "-c search_path=fleet" });
    for (const [who, key] of [[F, "sheets"], [G, "other"]] as const) {
      expect((await R.econ(who, "venture.create", { key, model: "digital_product", offer: key, state: "selected" })).ok).toBe(true);
    }
    rail = await liveRail(R.owner, "fleet", OWNER);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-v76-"));
    fs.chmodSync(dir, 0o700);
    initIdentityState(dir);
    igw = new PgIdentityGateway({ connectionString: R.pgc.identityUrl });
    const { vault, ownerVault } = openIdentityState(dir);
    broker = new IdentityBroker(igw, vault, { mail: shared, ownerVault, providerVault: openProviderVault(dir), stateFile: path.join(dir, "pending.json") });
    await broker.tick();
  }, 300_000);
  afterAll(async () => {
    await igw?.close(); await svc?.end(); await custody?.end(); await R?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("migrates to v76 with a clean audit; the new events are routed; foundation v2 is the reading path", async () => {
    expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(76);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
    for (const [p, ts] of Object.entries(EVENT_ROUTES_V76)) for (const t of ts) expect(await R.one(`fleet.fleet_event_route($1, '{}'::jsonb)`, [t]), t).toBe(p);
    const part1 = await R.econ(F, "knowledge.library", { path: "foundation", part: 1 });
    expect(part1).toMatchObject({ ok: true, version: "business-foundation-v2" });
    const all: string[] = [];
    for (let i = 1; i <= Number(part1.parts); i++) all.push(...(await R.econ(F, "knowledge.library", { path: "foundation", part: i })).entries.map((e: any) => e.id));
    for (const id of ["bf-initial-focus", "bf-capability-evidence", "bf-offer-portfolio", "bf-quality-procedures", "bf-fulfilment-loop", "bf-channels", "fleet-capability-status"]) expect(all).toContain(id);
    // v85 loads the dated capability status v10 (v76 loaded v5, v79 v6, v80 v7, v82 v8, v83 v9).
    expect((await R.econ(F, "knowledge.library", { id: "fleet-capability-status" })).entries?.[0]?.version ?? (await R.econ(F, "knowledge.library", { id: "fleet-capability-status" })).entry?.version).toBe(12);
  });

  it("custody reads open checkouts' status: APPROVED is captured, COMPLETED read back, VOIDED fails; backed off", async () => {
    const c = await R.econ(F, "paypal.checkout", { venture: "sheets", amountMinor: 900, description: "Budget workbook", fulfilment: "digital_file", idempotencyKey: idem() });
    const checkoutId = c.checkout.checkoutId as string;
    const orderId = await open(checkoutId);
    await R.q(`UPDATE fleet.fleet_paypal_checkouts SET opened_at = now() - interval '1 minute' WHERE checkout_id = $1`, [checkoutId]);
    let due = await cx("cx_paypal_status_work", ["custody-executor", 50]);
    expect(due.find((d: any) => d.checkoutId === checkoutId)).toMatchObject({ paypalOrderId: orderId, vaultRef: rail.vaultRef });
    expect((await cx("cx_paypal_status_checked", ["custody-executor", checkoutId, "CREATED"])).ok).toBe(true);
    due = await cx("cx_paypal_status_work", ["custody-executor", 50]);
    expect(due.find((d: any) => d.checkoutId === checkoutId)).toBeUndefined(); // backed off
    expect((await cx("cx_paypal_status_checked", ["custody-executor", checkoutId, "APPROVED"])).ok).toBe(true);
    expect(await events("paypal_status_fallback")).toBe(1);
    await cx("cx_paypal_status_checked", ["custody-executor", checkoutId, "APPROVED"]);
    expect(await events("paypal_status_fallback")).toBe(1); // once per evidence
    // A voided order fails its checkout (and its order is cancelled).
    const v = await R.econ(F, "paypal.checkout", { venture: "sheets", amountMinor: 900, description: "Budget workbook", fulfilment: "digital_file", idempotencyKey: idem() });
    await open(v.checkout.checkoutId);
    await cx("cx_paypal_status_checked", ["custody-executor", v.checkout.checkoutId, "VOIDED"]);
    expect(await R.one(`(SELECT status || '/' || failure_code FROM fleet.fleet_paypal_checkouts WHERE checkout_id = $1)`, [v.checkout.checkoutId])).toBe("failed/paypal_order_voided");
    expect((await R.econ(F, "order.list", { orderId: v.order.orderId })).orders[0]).toMatchObject({ payment: "cancelled", status: "cancelled" });
  });

  it("a product publishes only on a passing review of exactly its files, with the public site, a rail and a mailbox", async () => {
    const o = await R.econ(F, "offer.create", { venture: "sheets", kind: "product", title: "Small business cash-flow workbook", summary: "A 12-month cash-flow forecast in Excel with charts.",
      description: "Enter your opening balance and expected income and costs; the workbook projects month-end cash and flags shortfalls.", audience: "UK sole traders",
      deliverables: ["Cash-flow workbook (.xlsx)", "Quick-start guide (.pdf)"], priceMinor: 1_500, terms: "Digital download; refunds if the file does not open or does not match the description." });
    expect(o, JSON.stringify(o)).toMatchObject({ ok: true, offer: { kind: "product", status: "draft" } });
    const offerId = o.offer.offerId;
    const wb = Buffer.from("PK workbook bytes v1"), guide = Buffer.from("%PDF-1.4 guide v1");
    for (const [n, b, t] of [["cashflow.xlsx", wb, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], ["guide.pdf", guide, "application/pdf"]] as const) {
      expect((await R.econ(F, "offer.file", { offerId, role: "deliverable", fileName: n, contentType: t, contentB64: b.toString("base64") })).ok).toBe(true);
    }
    const files = [{ name: "cashflow.xlsx", bytes: wb }, { name: "guide.pdf", bytes: guide }];
    // Reviews are bound to the inspector's report and must pass on the merits.
    expect(await R.econ(F, "review.record", { subject: "offer", offerId, files: files.map((f) => ({ name: f.name, sha256: sha(f.bytes) })),
      automated: autoReport([files[0]]), criteria: criteria(), verdict: "pass" })).toMatchObject({ ok: false, code: "FLEET_REVIEW_MISMATCH" });
    expect(await review(F, { subject: "offer", offerId }, files, { fail: "formula_errors" })).toMatchObject({ ok: false, code: "FLEET_REVIEW_AUTOMATED_FAILED" });
    expect(await review(F, { subject: "offer", offerId }, files, { met: false })).toMatchObject({ ok: false, code: "FLEET_REVIEW_CRITERIA_UNMET" });
    expect(await R.econ(F, "review.record", { subject: "offer", offerId, files: files.map((f) => ({ name: f.name, sha256: sha(f.bytes) })), automated: autoReport(files),
      criteria: criteria(), independentRequestId: crypto.randomUUID(), independentVerdict: "pass", verdict: "pass" })).toMatchObject({ ok: false, code: "FLEET_REVIEW_INDEPENDENT" });
    // Every listed deliverable must be checked explicitly (a met criterion worded as the promise).
    expect(await R.econ(F, "review.record", { subject: "offer", offerId, files: files.map((f) => ({ name: f.name, sha256: sha(f.bytes), sizeBytes: f.bytes.length })),
      automated: autoReport(files), criteria: basicCriteria(), verdict: "pass" })).toMatchObject({ ok: false, code: "FLEET_REVIEW_PROMISE_UNCOVERED", reason: expect.stringContaining("Quick-start guide (.pdf)") });
    const failed = await review(F, { subject: "offer", offerId }, files, { verdict: "fail", met: false });
    expect(failed).toMatchObject({ ok: true, verdict: "fail" });
    const rv = await review(F, { subject: "offer", offerId }, files);
    expect(rv, JSON.stringify(rv)).toMatchObject({ ok: true, verdict: "pass", automatedOk: true });
    expect(await R.econ(F, "offer.publish", { offerId, reviewId: failed.reviewId })).toMatchObject({ ok: false, code: "FLEET_REVIEW_FAILED" });
    expect(await R.econ(F, "offer.publish", { offerId, reviewId: rv.reviewId })).toMatchObject({ ok: false, code: "FLEET_PUBLIC_SITE_UNSET" });
    expect(await R.q(`SELECT fleet.fleet_admin_public_site_set('https://shop.fleet.test', 'Automaton Fleet (test trading name), contact via your order page', 'operator:test')`)).toBeTruthy();
    // v78: the legal seller (owner facts) first, then the venture's own storefront (the agent's venture identity + routing address).
    expect(await R.econ(F, "offer.publish", { offerId, reviewId: rv.reviewId })).toMatchObject({ ok: false, code: "FLEET_PUBLIC_SITE_SELLER_UNSET" });
    expect((await R.q(`SELECT fleet.fleet_admin_seller_set($1::jsonb, 'operator:test') AS r`, [JSON.stringify({ legalForm: "individual", legalName: "Test Owner",
      postalAddress: "1 Test Street, Testtown, TT1 1TT, United Kingdom" })]))[0].r).toMatchObject({ ok: true, version: 1 });
    expect(await R.econ(F, "offer.publish", { offerId, reviewId: rv.reviewId })).toMatchObject({ ok: false, code: "FLEET_STOREFRONT_PROFILE" });
    const ltd = await R.econ(F, "identity.create", { kind: "venture_identity", ventureKey: "sheets", displayName: "Ledgerline Ltd",
      bio: "Spreadsheet tools that small businesses can trust to forecast their cash." });
    expect(ltd.ok).toBe(true);
    expect(await R.econ(F, "offer.publish", { offerId, reviewId: rv.reviewId })).toMatchObject({ ok: false, code: "FLEET_STOREFRONT_NAME" });
    expect((await R.econ(F, "identity.update", { identityId: ltd.identity.identity_id, status: "retired" })).ok).toBe(true);
    expect((await R.econ(F, "identity.create", { kind: "venture_identity", ventureKey: "sheets", displayName: "Ledgerline",
      bio: "Spreadsheet tools that small businesses can trust to forecast their cash." })).ok).toBe(true);
    expect(await R.econ(F, "offer.publish", { offerId, reviewId: rv.reviewId })).toMatchObject({ ok: false, code: "FLEET_MAIL_MAILBOX" });
    expect((await R.econ(F, "mailbox.provision", { ventureKey: "sheets", idempotencyKey: idem() })).ok).toBe(true);
    const p = await R.econ(F, "offer.publish", { offerId, reviewId: rv.reviewId });
    expect(p, JSON.stringify(p)).toMatchObject({ ok: true, offer: { status: "published", url: expect.stringMatching(/^https:\/\/shop\.fleet\.test\/o\/small-business-cash-flow-workbook-[0-9a-f]{6}$/) } });
    // Reviews are history.
    await expect(R.q(`UPDATE fleet.fleet_artifact_reviews SET verdict = 'pass' WHERE review_id = $1`, [failed.reviewId])).rejects.toThrow(/immutable|HISTORY/i);
    // Another agent cannot touch it.
    expect(await R.econ(G, "offer.update", { offerId, priceMinor: 100 })).toMatchObject({ ok: false, code: "FLEET_NOT_FOUND" });
    // Sales are closed until the owner opens them: no public page, no buy, no brief (the proof purchase is the exception).
    expect(await pub("svc_offer_page", [p.offer.slug])).toMatchObject({ ok: false, code: "FLEET_NOT_FOUND" });
    expect(await pub("svc_offer_buy", [p.offer.slug, origin])).toMatchObject({ ok: false, code: "FLEET_SALES_CLOSED" });
    // Preparation hold: outward actions wait while sales are closed; preparation (offers, reviews, reading) does not.
    for (const [op, a] of [["mail.send", { to: "someone@example.test", subject: "Our new workbook", body: "Buy it", idempotencyKey: idem() }],
                           ["browser.act", { sessionId: crypto.randomUUID(), steps: [{ type: "click", selector: "#post" }] }],
                           ["account.create", { platform: "forum.example", idempotencyKey: idem() }],
                           ["card.request", { amountMinor: 500, purpose: "ads", idempotencyKey: idem() }]] as const) {
      expect(await R.econ(F, op, a), op).toMatchObject({ ok: false, code: "FLEET_PREPARATION_HOLD" });
    }
    expect((await R.econ(F, "offer.list", {})).ok).toBe(true);
    await expect(svc.query(`SELECT fleet.fleet_admin_sales_set(true, $1)`, [OWNER])).rejects.toThrow(/permission denied/);
    expect((await R.q(`SELECT fleet.fleet_admin_sales_set(true, $1) AS r`, [OWNER]))[0].r).toMatchObject({ ok: true, salesOpen: true, changed: true });
    expect(await events("sales_opened")).toBe(1);
    // Once open, the hold no longer answers (the operation's own rules do).
    expect((await R.econ(F, "mail.send", { to: "someone@example.test", subject: "Hello", body: "Hi", idempotencyKey: idem() })).code).not.toBe("FLEET_PREPARATION_HOLD");
    // The public page: the offer, its files' names, the seller notice; nothing about the agent's books or buyers.
    const page = await pub("svc_offer_page", [p.offer.slug]);
    expect(page).toMatchObject({ ok: true, seller: expect.stringContaining("Automaton Fleet"), offer: { kind: "product", available: true, priceMinor: 1_500, title: "Small business cash-flow workbook",
      brand: "Ledgerline", about: expect.stringContaining("small businesses"), supportEmail: expect.stringMatching(/^[a-z0-9._-]+\+[0-9a-f]{10}@/) } });
    // v78: the legal seller behind the agent's brand, the address and the venture's own support address, then the owner's extra notice.
    expect(page.seller).toContain("Sold by Test Owner under the brand Ledgerline.");
    expect(page.seller).toContain("Address: 1 Test Street, Testtown, TT1 1TT, United Kingdom");
    expect(page.seller).toContain(`Customer support: ${page.offer.supportEmail}`);
    expect(page.seller).not.toMatch(/VAT|company no/);
    expect(JSON.stringify(page)).not.toMatch(/agent_id|agentId|venture_id|reviewId|sha256/);
  });

  it("a buyer's purchase: a fresh checkout and order page; PayPal returns there; paid → delivered automatically from the reviewed files; downloadable", async () => {
    const off = (await R.econ(F, "offer.list", {})).offers.find((x: any) => x.kind === "product");
    const b = await pub("svc_offer_buy", [off.slug, origin, BUYER_CONSENT_VERSION]);
    expect(b).toMatchObject({ ok: true, token: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const b2 = await pub("svc_offer_buy", [off.slug, sha("buyer-ip-2"), BUYER_CONSENT_VERSION]);
    expect(b2.token).not.toBe(b.token); // one checkout per buyer
    const checkoutId = await checkoutOf(b.token);
    const work = await cx("cx_paypal_work", ["custody-executor", 50]);
    expect(work.find((w: any) => w.checkoutId === checkoutId)).toMatchObject({ status: "requested", returnToken: b.token });
    let pg1 = await pub("svc_order_page", [b.token]);
    expect(pg1).toMatchObject({ ok: true, order: { checkout: "requested", payment: "awaiting_payment", item: off.title } });
    await open(checkoutId);
    pg1 = await pub("svc_order_page", [b.token]);
    expect(pg1.order.approvalUrl).toMatch(/^https:\/\/www\.paypal\.com\//);
    await pay(checkoutId, 1_500);
    const tick = await pub("svc_offer_tick", [20]);
    expect(tick).toMatchObject({ ok: true, delivered: 1 });
    expect(await events("order_auto_delivered")).toBe(1);
    await broker.tick();
    const mail = shared.outbox.at(-1)!;
    expect(mail.to).toEqual(["buyer@example.test"]);
    expect(mail.body).toContain(`https://shop.fleet.test/order/${b.token}`);
    expect((mail.attachments ?? []).map((a: any) => a.fileName).sort()).toEqual(["cashflow.xlsx", "guide.pdf"]);
    const pg2 = await pub("svc_order_page", [b.token]);
    expect(pg2.order).toMatchObject({ payment: "paid", status: "delivered" });
    expect(pg2.downloads.map((d: any) => d.fileName).sort()).toEqual(["cashflow.xlsx", "guide.pdf"]);
    const dl = await pub("svc_order_file", [b.token, pg2.downloads[0].deliveryId, pg2.downloads[0].fileNo]);
    expect(dl.ok).toBe(true);
    expect(await pub("svc_order_file", [b2.token, pg2.downloads[0].deliveryId, pg2.downloads[0].fileNo])).toMatchObject({ ok: false }); // another buyer's token
    // The sale is the agent's revenue net of the fee; fulfilment evidence names the review.
    const ord = (await R.econ(F, "order.list", {})).orders.find((x: any) => x.page === `https://shop.fleet.test/order/${b.token}`);
    expect(ord).toMatchObject({ payment: "paid", status: "delivered", offerId: off.offerId, evidence: { kind: "mail", reviewId: off.reviewId } });
  });

  it("the owner's proof purchase: real checkout and delivery, booked as owner capital net of fee — never the agent's revenue", async () => {
    const off = (await R.econ(F, "offer.list", {})).offers.find((x: any) => x.kind === "product");
    // The proof runs in the preparation window: sales closed, so the hold is on — promotion is refused, the proof is not.
    expect((await R.q(`SELECT fleet.fleet_admin_sales_set(false, $1) AS r`, [OWNER]))[0].r).toMatchObject({ ok: true, salesOpen: false });
    expect(await R.econ(F, "mail.send", { to: "prospect@example.test", subject: "New workbook", body: "Buy it", idempotencyKey: idem() })).toMatchObject({ ok: false, code: "FLEET_PREPARATION_HOLD" });
    expect(await pub("svc_offer_buy", [off.slug, sha("public-in-window")])).toMatchObject({ ok: false, code: "FLEET_SALES_CLOSED" });
    await expect(R.q(`SELECT fleet.fleet_admin_offer_proof_buy($1, 'svc')`, [off.slug])).rejects.toThrow(/FLEET_APPROVAL_REQUIRED/);
    await expect(svc.query(`SELECT fleet.fleet_admin_offer_proof_buy($1, $2)`, [off.slug, OWNER])).rejects.toThrow(/permission denied/);
    const p = (await R.q(`SELECT fleet.fleet_admin_offer_proof_buy($1, $2) AS r`, [off.slug, OWNER]))[0].r;
    expect(p, JSON.stringify(p)).toMatchObject({ ok: true, page: expect.stringMatching(/^https:\/\/shop\.fleet\.test\/order\/[0-9a-f]{64}$/), amountMinor: 1_500 });
    expect((await R.q(`SELECT fleet.fleet_admin_offer_proof_buy($1, $2) AS r`, [off.slug, OWNER]))[0].r).toMatchObject({ ok: true, replay: true, page: p.page });
    const token = p.page.split("/").pop();
    const checkoutId = await checkoutOf(token);
    await expect(R.q(`UPDATE fleet.fleet_customer_orders SET owner_proof = false WHERE access_token = $1`, [token])).rejects.toThrow(/FLEET_HISTORY_IMMUTABLE/);
    const capital0 = Number(await R.one(`fleet.fleet_ledger_balance('fleet:owner:capital')`));
    const agentPostings = () => R.one(`(SELECT count(*) FROM fleet.fleet_ledger_postings WHERE account_id LIKE '%' || $1 || '%')`, [F.id]).then(Number);
    const agent0 = await agentPostings();
    await open(checkoutId);
    await pay(checkoutId, 1_500, "owner@example.test");
    expect(Math.abs(Number(await R.one(`fleet.fleet_ledger_balance('fleet:owner:capital')`)) - Math.abs(capital0))).toBe(1_500 - 60); // net of PayPal's fee
    expect(await agentPostings()).toBe(agent0); // nothing posted to the agent: no revenue, no fee share
    expect(await events("offer_proof_captured")).toBe(1);
    expect(await pub("svc_offer_tick", [20])).toMatchObject({ ok: true, delivered: 1 });
    await broker.tick();
    expect(shared.outbox.at(-1)!.to).toEqual(["owner@example.test"]);
    const ord = (await R.econ(F, "order.list", {})).orders.find((x: any) => x.page === p.page);
    expect(ord).toMatchObject({ ownerProof: true, payment: "paid", status: "delivered" });  // delivered to the buyer during the hold
    // The agent can still answer its (proof) buyer on the order thread while outward promotion is held; the buyer's page works.
    expect((await econNext(R, F, "order.message", { orderId: ord.orderId, message: "Thanks — the files are on your order page too." })).ok).toBe(true);
    expect((await pub("svc_order_page", [token])).order).toMatchObject({ payment: "paid", status: "delivered" });
    // Refund of the proof, through the real evidence path: the webhook's refund, then the fee PayPal gave back with it, then the
    // same money again from Transaction Search (T1107 refund, T1108 fee reversal). Owner capital and treasury follow exactly what
    // PayPal took: gross refund − fee given back; net effect of the whole proof on owner capital = −the fee PayPal retained.
    const cap = await R.one<string>(`(SELECT capture_id FROM fleet.fleet_paypal_checkouts WHERE checkout_id = $1)`, [checkoutId]);
    const capital = () => R.one(`fleet.fleet_ledger_balance('fleet:owner:capital')`).then((x) => Math.abs(Number(x)));
    const treasury = () => R.one(`fleet.fleet_ledger_balance('fleet:treasury:unallocated')`).then((x) => Number(x));
    const [c1, t1] = [await capital(), await treasury()];      // after capture: capital0 + 1,440 (1,500 − 60 fee)
    const RF = `RF${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
    expect(await cx("cx_paypal_clawback_evidence", ["custody-executor", "webhook", RF, "refund", cap, 1_500, "GBP"])).toMatchObject({ ok: true, posted: { refund: 1_500 } });
    expect(await capital()).toBe(c1 - 1_500);
    expect(t1 - (await treasury())).toBe(1_500);
    // PayPal gave back 40 of the 60 fee (the refund webhook's gross − net); it retains 20.
    expect(await cx("cx_paypal_clawback_evidence", ["custody-executor", "webhook", `FR-${RF}`, "fee_return", cap, 40, "GBP"])).toMatchObject({ ok: true, posted: { fee_return: 40 } });
    expect(await capital()).toBe(c1 - 1_460);
    expect(Math.abs(await capital() - Math.abs(capital0))).toBe(20);      // the retained fee is the owner's cost of the proof — nothing else
    expect(t1 - (await treasury())).toBe(1_460);                // the treasury fell by what PayPal actually debited (1,500 − 40)
    // The same refund and fee again from Transaction Search: the larger source counts once — nothing more is posted.
    const ts = (code: string, amt: number) => cx("cx_paypal_txn_record", ["custody-executor", rail.railId, JSON.stringify({ transactionId: `T${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
      eventCode: code, initiatedAt: new Date().toISOString(), status: "S", currency: "GBP", amountMinor: amt, feeMinor: 0, referenceId: cap })]);
    expect((await ts("T1107", -1_500)).ok).toBe(true);
    expect((await ts("T1108", 40)).ok).toBe(true);
    expect(await capital()).toBe(c1 - 1_460);
    // The order knows it was refunded (Transaction Search's shortfall check sees nothing to post).
    expect(Number(await R.one(`(SELECT refunded_minor FROM fleet.fleet_customer_orders WHERE access_token = $1)`, [token]))).toBe(1_500);
    // v76 restates the LATEST refund recorder: v56's order follow-up and v57's clawback record are still in it.
    const src = await R.one<string>(`(SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'fleet' AND p.proname = 'cx_paypal_refund_record')`);
    expect(src).toContain("fleet_paypal_clawback_posts");
    expect(src).toContain("fleet_order_refunded(c.checkout_id, p_kind, p_amount)");
    // A reversal of an already fully refunded proof posts nothing beyond the captured amount.
    expect(await cx("cx_paypal_clawback_evidence", ["custody-executor", "webhook", `RV${crypto.randomBytes(6).toString("hex").toUpperCase()}`, "reversal", cap, 1_500, "GBP"]))
      .toMatchObject({ ok: true });
    expect(await capital()).toBe(c1 - 1_460);
    expect(await events("offer_proof_returned")).toBe(2);      // the refund and the fee given back
    await expect(R.q(`UPDATE fleet.fleet_offer_proof_returns SET amount_minor = 0`)).rejects.toThrow(/immutable|HISTORY/i);
    // End of the window (the later tests sell to the public).
    await R.q(`SELECT fleet.fleet_admin_sales_set(true, $1)`, [OWNER]);
    expect(await agentPostings()).toBe(agent0);
  });

  it("an agent sale's refund: the capture fee PayPal gives back reaches the agent's books once (webhook and Search), capped at the fee actually paid", async () => {
    const fees = () => R.one(`fleet.fleet_ledger_balance(fleet.fleet_ledger_account($1, 'agent_fees'))`, [F.id]).then(Number);
    const ck = await R.econ(F, "paypal.checkout", { venture: "sheets", amountMinor: 2_000, description: "Agent sale (fee return)", idempotencyKey: idem() });
    const checkoutId = ck.checkout.checkoutId as string;
    await open(checkoutId);
    const f0 = await fees();
    const capId = `CAP${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
    expect((await cx("cx_paypal_capture_record", ["custody-executor", checkoutId, capId, "COMPLETED", 2_000, 80, "GBP", "capture_response"])).ok).toBe(true);
    expect((await fees()) - f0).toBe(80);
    const RF = `RF${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
    expect(await cx("cx_paypal_clawback_evidence", ["custody-executor", "webhook", RF, "refund", capId, 2_000, "GBP"])).toMatchObject({ ok: true, posted: { refund: 2_000 } });
    // The refund webhook: PayPal gave back 50 of the 80 fee.
    expect(await cx("cx_paypal_clawback_evidence", ["custody-executor", "webhook", `FR-${RF}`, "fee_return", capId, 50, "GBP"])).toMatchObject({ ok: true, posted: { fee_return: 50 } });
    expect((await fees()) - f0).toBe(30);                       // the agent bears only the fee PayPal kept
    const ret = await R.one<any>(`(SELECT jsonb_build_object('agent', j.agent_id, 'kind', j.kind) FROM fleet.fleet_paypal_clawback_posts p JOIN fleet.fleet_ledger_journal j ON j.journal_id = p.journal_id
                                  WHERE p.checkout_id = $1 AND p.grp = 'fee_return')`, [checkoutId]);
    expect(ret).toMatchObject({ agent: F.id, kind: "paypal_clawback_return" }); // attributed to this sale's agent
    // Transaction Search reports the same refund with the returned fee on the refund row: nothing more is posted.
    const tsRow = await cx("cx_paypal_txn_record", ["custody-executor", rail.railId, JSON.stringify({ transactionId: RF, eventCode: "T1107", initiatedAt: new Date().toISOString(),
      status: "S", currency: "GBP", amountMinor: -2_000, feeMinor: 50, referenceId: capId })]);
    expect(tsRow.ok).toBe(true);
    expect(await R.one(`(SELECT count(*)::int FROM fleet.fleet_paypal_clawback_evidence WHERE checkout_id = $1 AND grp = 'fee_return' AND source = 'search')`, [checkoutId])).toBe(1);
    expect((await fees()) - f0).toBe(30);
    // More evidence than the fee ever paid (a second report): capped at the 80 PayPal actually charged.
    await cx("cx_paypal_clawback_evidence", ["custody-executor", "webhook", `FR2-${RF}`.slice(0, 64), "fee_return", capId, 70, "GBP"]);
    expect((await fees()) - f0).toBe(0);
    expect(Number(await R.one(`(SELECT sum(amount_minor) FROM fleet.fleet_paypal_clawback_posts WHERE checkout_id = $1 AND grp = 'fee_return')`, [checkoutId]))).toBe(80);
    expect(await events("paypal_evidence_over_principal")).toBeGreaterThanOrEqual(1);
  });

  it("changing a published product's files pauses it until a review of the new files republishes it", async () => {
    const off = (await R.econ(F, "offer.list", {})).offers.find((x: any) => x.kind === "product");
    const wb2 = Buffer.from("PK workbook bytes v2 (fixed)");
    const r = await R.econ(F, "offer.file", { offerId: off.offerId, role: "deliverable", fileName: "cashflow.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", contentB64: wb2.toString("base64") });
    expect(r.offer).toMatchObject({ status: "paused", statusNote: expect.stringContaining("files changed") });
    expect(await pub("svc_offer_buy", [off.slug, sha("buyer-ip-3")])).toMatchObject({ ok: false, code: "FLEET_OFFER_UNAVAILABLE" });
    expect(await R.econ(F, "offer.publish", { offerId: off.offerId, reviewId: off.reviewId })).toMatchObject({ ok: false, code: "FLEET_REVIEW_STALE" });
    const rv = await review(F, { subject: "offer", offerId: off.offerId }, [{ name: "cashflow.xlsx", bytes: wb2 }, { name: "guide.pdf", bytes: Buffer.from("%PDF-1.4 guide v1") }]);
    expect((await R.econ(F, "offer.publish", { offerId: off.offerId, reviewId: rv.reviewId })).offer.status).toBe("published");
  });

  it("a service: a sample review publishes it; a brief with files wakes the agent; clarify, quote within capacity, pay; delivery needs a current review; a revision is delivered with a new one", async () => {
    const sample = Buffer.from("%PDF-1.4 sample: a custom loan-amortisation workbook walkthrough");
    const s = await R.econ(F, "offer.create", { venture: "sheets", kind: "service", title: "Custom Excel workbook built to your brief",
      summary: "I build a working Excel workbook — formulas, validation, charts — for your process.", description: "Send your brief and examples; I confirm scope, price and date before you pay.",
      deliverables: ["A tested .xlsx workbook", "A one-page guide"], priceMinor: 6_000, turnaroundDays: 5, revisions: 2, capacity: 1,
      terms: "Two revisions included; refunds if I cannot deliver what was agreed." });
    const offerId = s.offer.offerId;
    expect(await R.econ(F, "offer.publish", { offerId, reviewId: (await R.econ(F, "review.list", {})).reviews.find((x: any) => x.subject === "offer").reviewId }))
      .toMatchObject({ ok: false, code: "FLEET_REVIEW_SUBJECT" });
    const sr = await review(F, { subject: "sample" }, [{ name: "sample.pdf", bytes: sample }]);
    expect((await R.econ(F, "offer.publish", { offerId, reviewId: sr.reviewId })).offer.status).toBe("published");
    const slug = s.offer.slug;
    expect(await pub("svc_offer_buy", [slug, origin])).toMatchObject({ ok: false, code: "FLEET_OFFER_UNAVAILABLE" }); // services start with a brief
    // The buyer's brief with a reference file.
    const ref = Buffer.from("month,amount\n1,100\n");
    const e = await pub("svc_offer_enquire", [slug, origin, "Bea Buyer", "Bea@Example.test", "I need a workbook that tracks invoices by client and month with a dashboard.",
      [{ fileName: "invoices.csv", contentType: "text/csv", contentB64: ref.toString("base64") }]]);
    expect(e).toMatchObject({ ok: true, token: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(await events("customer_enquiry_received")).toBe(1);
    // The agent is woken: its attention digest changed and the packet names the tool.
    const att = await R.one<any>(`fleet.fleet_agent_attention($1)`, [F.id]);
    expect(att.recentEvents.some((x: any) => x.kind === "enquiry" || x.kind === "customer_message")).toBe(true);
    const list = await R.econ(F, "enquiry.list", {});
    const enquiryId = list.enquiries[0].enquiryId;
    expect(JSON.stringify(await R.econ(G, "enquiry.list", {}))).not.toContain(enquiryId);
    const read = await R.econ(F, "enquiry.read", { enquiryId });
    expect(read).toMatchObject({ ok: true, enquiry: { buyer: { email: "bea@example.test" }, brief: expect.stringContaining("invoices") }, briefSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const fileMsg = read.thread.find((m: any) => m.files);
    const f = await R.econ(F, "enquiry.file", { messageId: fileMsg.messageId, fileNo: 1 });
    expect(Buffer.from(f.contentB64, "base64").equals(ref)).toBe(true);
    // Clarify, then quote.
    expect((await econNext(R, F, "enquiry.reply", { enquiryId, message: "Thanks — how many clients, and do you need VAT columns?" })).ok).toBe(true);
    await broker.tick();
    expect(shared.outbox.at(-1)!.body).toContain("https://shop.fleet.test/enquiry/");
    expect((await pub("svc_customer_message", ["enquiry", e.token, origin, "About 40 clients; yes, VAT at 20%.", []])).ok).toBe(true);
    const q = await R.econ(F, "enquiry.quote", { enquiryId, scope: "Invoice tracker for ~40 clients with VAT, monthly dashboard and guide", priceMinor: 7_500, turnaroundDays: 5 });
    expect(q, JSON.stringify(q)).toMatchObject({ ok: true, enquiry: { status: "quoted" }, order: { fulfilment: "service", amountMinor: 7_500, scope: expect.stringContaining("40 clients") } });
    // Capacity 1: a second brief is refused while the quote is open.
    expect(await pub("svc_offer_enquire", [slug, sha("buyer-ip-4"), "Cal", "cal@example.test", "Another workbook please, with many sheets and formulas.", []]))
      .toMatchObject({ ok: false, code: "FLEET_OFFER_AT_CAPACITY" });
    const orderId = q.order.orderId;
    const token = (await pub("svc_enquiry_page", [e.token])).enquiry.orderToken as string;
    const checkoutId = await checkoutOf(token);
    await open(checkoutId);
    // v82: the buyer asks for the work to start now (CCR 2013 reg 36) on the order page before the payment link appears.
    expect((await pub("svc_order_page", [token])).order.approvalUrl).toBeUndefined();
    expect(await pub("svc_order_consent", [token, origin, BUYER_CONSENT_VERSION])).toMatchObject({ ok: true });
    expect((await pub("svc_order_page", [token])).order).toMatchObject({ approvalUrl: expect.stringMatching(/^https:\/\/www\.paypal\.com\//), consent: { kind: "service_start", recorded: true } });
    await pay(checkoutId, 7_500, "bea@example.test");
    await pub("svc_offer_tick", [20]);
    expect(await R.one(`(SELECT status FROM fleet.fleet_offer_enquiries WHERE enquiry_id = $1)`, [enquiryId])).toBe("accepted");
    // v83: a paid order past its due date (turnaround 5 days; captured 6 days ago) and not delivered alerts the owner once.
    await R.q(`UPDATE fleet.fleet_paypal_checkouts SET captured_at = now() - interval '6 days' WHERE checkout_id = $1`, [checkoutId]);
    await svc.query(`SELECT fleet.svc_operations_watch()`);
    await svc.query(`SELECT fleet.svc_operations_watch()`);
    expect(await R.q(`SELECT class, agent_id FROM fleet.fleet_notifications WHERE code = 'ORDER_OVERDUE' AND detail ->> 'orderId' = $1`, [orderId]))
      .toEqual([{ class: "RED", agent_id: F.id }]);
    await R.q(`UPDATE fleet.fleet_paypal_checkouts SET captured_at = now() WHERE checkout_id = $1`, [checkoutId]);
    // Delivery needs a review of exactly these files for this order.
    const v1 = Buffer.from("PK invoice tracker v1");
    expect((await R.econ(F, "order.stage_file", { orderId, fileName: "invoice-tracker.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      contentB64: v1.toString("base64") })).ok).toBe(true);
    expect(await econNext(R, F, "order.deliver", { orderId, files: [{ fileName: "invoice-tracker.xlsx" }], idempotencyKey: idem() })).toMatchObject({ ok: false, code: "FLEET_REVIEW_REQUIRED" });
    const r1 = await review(F, { subject: "order", orderId }, [{ name: "invoice-tracker.xlsx", bytes: v1 }]);
    expect(await econNext(R, F, "order.deliver", { orderId, files: [{ fileName: "invoice-tracker.xlsx" }], reviewId: sr.reviewId, idempotencyKey: idem() }))
      .toMatchObject({ ok: false, code: "FLEET_REVIEW_STALE" }); // a sample's review covers other bytes
    const d1 = await econNext(R, F, "order.deliver", { orderId, files: [{ fileName: "invoice-tracker.xlsx" }], reviewId: r1.reviewId, message: "Here is your tracker.", idempotencyKey: idem() });
    expect(d1, JSON.stringify(d1)).toMatchObject({ ok: true, order: { status: "delivering" } });
    await broker.tick();
    expect((await R.econ(F, "order.list", { orderId })).orders[0].status).toBe("delivered");
    // A revision request: the previous review is stale for any further delivery.
    expect((await pub("svc_customer_message", ["order", token, origin, "Please add a column for payment date.", []])).ok).toBe(true);
    expect(await events("customer_message_received")).toBe(2);
    const v2 = Buffer.from("PK invoice tracker v2 with payment date");
    await R.econ(F, "order.stage_file", { orderId, fileName: "invoice-tracker.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", contentB64: v2.toString("base64") });
    const r1again = await review(F, { subject: "order", orderId }, [{ name: "invoice-tracker.xlsx", bytes: v1 }]);
    expect(r1again.ok).toBe(true);
    // The old bytes and a review taken before the message both fail; a fresh review of the revised bytes delivers.
    expect(await econNext(R, F, "order.deliver", { orderId, files: [{ fileName: "invoice-tracker.xlsx" }], reviewId: r1.reviewId, resendReason: "revision: payment date", idempotencyKey: idem() }))
      .toMatchObject({ ok: false, code: "FLEET_REVIEW_STALE" });
    const r2 = await review(F, { subject: "order", orderId }, [{ name: "invoice-tracker.xlsx", bytes: v2 }]);
    expect(await econNext(R, F, "order.deliver", { orderId, files: [{ fileName: "invoice-tracker.xlsx" }], reviewId: r2.reviewId, idempotencyKey: idem() }))
      .toMatchObject({ ok: false, code: "FLEET_ALREADY_DELIVERED" });
    const d2 = await econNext(R, F, "order.deliver", { orderId, files: [{ fileName: "invoice-tracker.xlsx" }], reviewId: r2.reviewId, resendReason: "revision: payment date column", idempotencyKey: idem() });
    expect(d2, JSON.stringify(d2)).toMatchObject({ ok: true });
    await broker.tick();
    const page = await pub("svc_order_page", [token]);
    expect(page.downloads.map((x: any) => x.sha256)).toContain(sha(v2));
    expect(page.thread.map((m: any) => m.author)).toEqual(expect.arrayContaining(["buyer"]));
    expect(JSON.stringify(page)).not.toMatch(/agentId|buyer_email|reviewId/);
    // The owner's view.
    const owner = await R.one<any>(`fleet.fleet_offers_admin_json(NULL)`);
    expect(owner.offers.length).toBe(2);
    expect(owner.reviews.passed).toBeGreaterThanOrEqual(5);
  });
  it("v78: one agent, two ventures — each offer, order and buyer email carries its own venture's brand and routing address", async () => {
    await R.q(`SELECT fleet.fleet_admin_sales_set(true, $1)`, [OWNER]);
    const vid = (key: string) => R.one<string>(`(SELECT venture_id::text FROM fleet.fleet_ventures WHERE venture_key = $1)`, [key]);
    const sheetsAddr = (await R.one<any>(`fleet.fleet_storefront($1::uuid)`, [await vid("sheets")])).supportEmail as string;
    expect((await R.econ(F, "venture.create", { key: "courses", model: "digital_product", offer: "courses", state: "selected" })).ok).toBe(true);
    // A general (venture-less) address of the agent: the second venture uses it until it has its own — never the first venture's.
    const general = await R.econ(F, "mailbox.provision", { idempotencyKey: idem() });
    expect(general.ok).toBe(true);
    expect((await R.econ(F, "identity.create", { kind: "venture_identity", ventureKey: "courses", displayName: "Coursewise",
      bio: "Short practical courses that teach small-business owners to run their numbers." })).ok).toBe(true);
    const o = await R.econ(F, "offer.create", { venture: "courses", kind: "product", title: "Cash-flow basics course", summary: "A short course on forecasting cash for small firms.",
      description: "Five lessons with worked examples and a workbook to practise forecasting month-end cash.", deliverables: ["Cash-flow workbook (.xlsx)", "Quick-start guide (.pdf)"],
      priceMinor: 1_500, terms: "Digital download; refunds if the files do not open or do not match the description." });
    const offerId = o.offer.offerId;
    const wb = Buffer.from("PK course workbook"), guide = Buffer.from("%PDF-1.4 course guide");
    for (const [n, b, t] of [["cashflow.xlsx", wb, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], ["guide.pdf", guide, "application/pdf"]] as const) {
      expect((await R.econ(F, "offer.file", { offerId, role: "deliverable", fileName: n, contentType: t, contentB64: b.toString("base64") })).ok).toBe(true);
    }
    const rv = await review(F, { subject: "offer", offerId }, [{ name: "cashflow.xlsx", bytes: wb }, { name: "guide.pdf", bytes: guide }]);
    const p = await R.econ(F, "offer.publish", { offerId, reviewId: rv.reviewId });
    expect(p.ok, JSON.stringify(p)).toBe(true);
    expect((await pub("svc_offer_page", [p.offer.slug])).offer).toMatchObject({ brand: "Coursewise", supportEmail: general.address });
    expect(general.address).not.toBe(sheetsAddr);
    // Its own routing address takes over; the first venture keeps its own.
    const own = await R.econ(F, "mailbox.provision", { ventureKey: "courses", idempotencyKey: idem() });
    const page = await pub("svc_offer_page", [p.offer.slug]);
    expect(page.offer).toMatchObject({ brand: "Coursewise", supportEmail: own.address });
    expect(page.seller).toContain("under the brand Coursewise.");
    expect(page.seller).toContain(`Customer support: ${own.address}`);
    expect(page.seller).not.toMatch(/Ledgerline|sheets/);
    const sheetsOffer = (await R.econ(F, "offer.list", {})).offers.find((x: any) => x.title === "Small business cash-flow workbook");
    expect((await pub("svc_offer_page", [sheetsOffer.slug])).offer).toMatchObject({ brand: "Ledgerline", supportEmail: sheetsAddr });
    // A purchase: the order is the venture's; the delivery email replies to the venture's address and names its brand.
    const b = await pub("svc_offer_buy", [p.offer.slug, sha("buyer-courses"), BUYER_CONSENT_VERSION]);
    expect(await R.one(`(SELECT venture_id::text FROM fleet.fleet_customer_orders WHERE access_token = $1)`, [b.token])).toBe(await vid("courses"));
    const checkoutId = await checkoutOf(b.token);
    await open(checkoutId);
    await pay(checkoutId, 1_500, "learner@example.test");
    expect(await pub("svc_offer_tick", [20])).toMatchObject({ ok: true, delivered: 1 });
    await broker.tick();
    const delivery = shared.outbox.at(-1)!;
    expect(delivery.to).toEqual(["learner@example.test"]);
    expect(delivery.replyTo).toBe(own.address);
    expect(delivery.body).toContain("under the brand Coursewise.");
    expect(delivery.body).toContain(`Customer support: ${own.address}`);
    expect(delivery.body).not.toMatch(/Ledgerline/);
    expect((await pub("svc_order_page", [b.token])).seller).toContain("under the brand Coursewise.");
    // The agent's message about that order: same venture, same address, same brand.
    const ord = (await R.econ(F, "order.list", {})).orders.find((x: any) => x.page === `https://shop.fleet.test/order/${b.token}`);
    expect((await econNext(R, F, "order.message", { orderId: ord.orderId, message: "Lesson 3 has an extra worked example now." })).ok).toBe(true);
    await broker.tick();
    const msg = shared.outbox.at(-1)!;
    expect(msg).toMatchObject({ to: ["learner@example.test"], replyTo: own.address });
    expect(msg.body).toContain("under the brand Coursewise.");
    // The first venture's earlier delivery went out under its own brand and address.
    const first = shared.outbox.find((m) => m.to.includes("buyer@example.test") && /Ledgerline/.test(m.body))!;
    expect(first.replyTo).toBe(sheetsAddr);
    expect(first.body).not.toMatch(/Coursewise/);
  });

  it("v96: a product is sold publicly only on a current inspector's pass of its current files, and while the owner has not held it", async () => {
    const off = (await R.econ(F, "offer.list", {})).offers.find((x: any) => x.kind === "product" && x.status === "published");
    expect(off, "a published product from the earlier tests").toBeTruthy();
    expect(off.saleBlock).toBeUndefined();
    expect((await pub("svc_offer_page", [off.slug])).offer.available).toBe(true);
    // As production on 2026-10-19: published on a review by an inspector that no longer qualifies a product for sale.
    const deliverables = off.files.filter((f: any) => f.role === "deliverable");
    const fake = deliverables.map((f: any) => ({ name: f.fileName, sha256: f.sha256, sizeBytes: f.sizeBytes }));
    const old = await R.econ(F, "review.record", { subject: "offer", offerId: off.offerId, files: fake, criteria: criteria(), verdict: "pass",
      automated: { inspector: "fleet-qa-2", ok: true, files: fake.map((f: any) => ({ path: f.name, sha256: f.sha256, sizeBytes: f.sizeBytes, detectedType: "pdf", ok: true,
        checks: [{ id: "nonempty", status: "pass", detail: "ok" }] })) } });
    expect(old, JSON.stringify(old)).toMatchObject({ ok: true, verdict: "pass" });
    expect(await R.econ(F, "offer.publish", { offerId: off.offerId, reviewId: old.reviewId })).toMatchObject({ ok: false, code: "FLEET_REVIEW_INSPECTOR" });
    const current = off.reviewId;
    await R.q(`UPDATE fleet.fleet_offers SET review_id = $2 WHERE offer_id = $1`, [off.offerId, old.reviewId]);   // a pre-v96 publication
    const blocked = (await R.econ(F, "offer.list", {})).offers.find((x: any) => x.offerId === off.offerId);
    expect(blocked).toMatchObject({ status: "published", saleBlock: expect.stringContaining("its review was made by fleet-qa-2") });
    expect((await pub("svc_offer_page", [off.slug])).offer.available).toBe(false);
    expect(await pub("svc_offer_buy", [off.slug, sha("buyer-ip-9"), BUYER_CONSENT_VERSION])).toMatchObject({ ok: false, code: "FLEET_OFFER_UNAVAILABLE" });
    expect((await pub("svc_sitemap", [])).offers.map((x: any) => x.slug)).not.toContain(off.slug);
    await R.q(`UPDATE fleet.fleet_offers SET review_id = $2 WHERE offer_id = $1`, [off.offerId, current]);
    expect((await pub("svc_offer_page", [off.slug])).offer.available).toBe(true);
    // The owner holds this one offer (sales stay open, the agent keeps working); the agent is told; then releases it.
    const notices = () => R.one(`(SELECT count(*) FROM fleet.fleet_agent_messages WHERE agent_id = $1 AND author = 'fleet_control')`, [F.id]).then(Number);
    const n0 = await notices();
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_offer_hold($1, 'dates show as numbers', 'agent')`, [off.slug]))).toBe("FLEET_APPROVAL_REQUIRED");
    expect(await R.one(`fleet.fleet_admin_offer_hold($1, 'dates show as numbers in LibreOffice', $2)`, [off.slug, OWNER])).toMatchObject({ ok: true,
      saleBlock: "held by the owner: dates show as numbers in LibreOffice" });
    expect(await R.one(`fleet.fleet_admin_offer_hold($1, 'again', $2)`, [off.slug, OWNER])).toMatchObject({ ok: true, replay: true });
    expect(await notices()).toBe(n0 + 1);
    expect(await events("offer_held")).toBe(1);
    expect((await pub("svc_offer_page", [off.slug])).offer.available).toBe(false);
    expect(await pub("svc_offer_buy", [off.slug, sha("buyer-ip-9"), BUYER_CONSENT_VERSION])).toMatchObject({ ok: false, code: "FLEET_OFFER_UNAVAILABLE" });
    expect((await R.q(`SELECT fleet.fleet_sales_open() AS o`))[0].o).toBe(true);
    expect(await R.one(`fleet.fleet_admin_offer_release($1, 'fixed', $2)`, [off.slug, OWNER])).toMatchObject({ ok: true });
    expect(await notices()).toBe(n0 + 2);
    expect((await pub("svc_offer_page", [off.slug])).offer.available).toBe(true);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });
});

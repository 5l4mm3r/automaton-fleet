/**
 * Schema v82 — the buyer's consent to immediate supply (CCR 2013 regs 36/37) and the helpers read (PostgreSQL + the identity
 * broker on a simulated shared mailbox + custody's cx_* calls).
 *
 * Proven here: the wording is stored once per version, immutable, and is exactly the wording the pages show; a purchase from
 * an offer page is refused without the buyer's consent and records version, time and (hashed) origin when given; the
 * delivery mail repeats it and attaches the files; an order with an order page but no recorded consent shows no payment
 * link and no download, its delivery mail carries no attachment and says the page will ask, and the files appear once the
 * buyer confirms there (repeating changes nothing); a recorded consent never changes. The helpers read shows routine
 * chores, critical questions, independent reviews, inspections and in-flight work — classes and times only, never content.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { liveRail } from "./fixtures/custody-signer.js";
import { PgIdentityGateway } from "../../fleet/identity/gateway.js";
import { IdentityBroker } from "../../fleet/identity/broker.js";
import { SimulatedSharedMailProvider } from "../../fleet/identity/providers.js";
import { initIdentityState, openIdentityState, openProviderVault } from "../../fleet/identity/main.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";
import { BUYER_CONSENT_VERSION, BUYER_CONSENT_WORDING } from "../../fleet/storefront/consent.js";

const PG_BIN = findPgBin();
const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");
/** A review's automated part and criteria, as in the v76 suite (importing that file would also run its suite). */
const autoReport = (files: Array<{ name: string; bytes: Buffer }>) => ({
  inspector: "fleet-qa-1", ok: true,
  files: files.map((f) => ({ path: f.name, sha256: sha(f.bytes), sizeBytes: f.bytes.length, detectedType: "pdf", ok: true, checks: [{ id: "nonempty", status: "pass", detail: "ok" }] })),
});
const criteria = () => [
  { criterion: "Covers everything the brief asks for", met: true, evidence: "checked each requested item against the file" },
  { criterion: "Calculations and totals reconcile", met: true, evidence: "recalculated the totals sheet; matches" },
  { criterion: "Clear instructions for the buyer", met: true, evidence: "read the instructions page start to finish" },
  ...["Cash-flow workbook (.xlsx)", "Quick-start guide (.pdf)"].map((d) => ({ criterion: d, met: true, evidence: "opened and checked against the listing" })),
];

describe.skipIf(!PG_BIN)("v82: buyer consent to immediate supply; the helpers read (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let F: Founder;
  let G: Founder;
  let svc: pg.Pool;
  let custody: pg.Pool;
  let dir: string;
  let igw: PgIdentityGateway;
  let broker: IdentityBroker;
  let slug = "";
  const shared = new SimulatedSharedMailProvider("fleet@shared.fleet-mail.test");
  const session = crypto.randomBytes(16).toString("hex");
  const idem = () => `k-${crypto.randomUUID()}`;
  const cx = async (fn: string, args: unknown[]) => (await custody.query(`SELECT fleet.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) AS r`, args)).rows[0].r;
  const pub = async (fn: string, args: unknown[]) =>
    (await svc.query(`SELECT fleet.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) AS r`, args.map((a) => (a !== null && typeof a === "object" ? JSON.stringify(a) : a)))).rows[0].r;
  const open = async (checkoutId: string) => {
    const orderId = `ORD${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
    expect((await cx("cx_paypal_checkout_update", ["custody-executor", checkoutId, "open", orderId, `https://www.paypal.com/checkoutnow?token=${orderId}`, null])).ok).toBe(true);
  };
  const pay = async (checkoutId: string, amount: number, buyer: string) => {
    expect((await cx("cx_paypal_capture_record", ["custody-executor", checkoutId, `CAP${crypto.randomBytes(6).toString("hex").toUpperCase()}`, "COMPLETED", amount, 60, "GBP", "capture_response"])).ok).toBe(true);
    expect((await cx("cx_paypal_buyer_record", ["custody-executor", checkoutId, JSON.stringify({ email_address: buyer, name: { given_name: "Bea", surname: "Buyer" },
      address: { country_code: "GB" }, payer_id: "PAYERBEA0001" })])).recorded).toBe(true);
  };
  const checkoutOf = (token: string) => R.one<string>(`(SELECT checkout_id::text FROM fleet.fleet_customer_orders WHERE access_token = $1)`, [token]);
  const helpers = async () => {
    const r = await R.one<Record<string, any>>(`fleet.dash_call($1, $2, 'helpers', '{}', NULL, 'test')`, [sha(session), sha("csrf")]);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return r.result;
  };

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000, simulatedSettlement: false, outwardHeld: true });
    // v85: an agent checks what it can deliver before it quotes or publishes (valid 7 days).
    for (const f of R.founders) expect((await R.econ(f, "capabilities.check", { runtime: {} })).ok).toBe(true);
    [F, G] = R.founders;
    await R.store.grantServiceRole();
    await R.store.grantCustodyRole();
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2, options: "-c search_path=fleet" });
    custody = new pg.Pool({ connectionString: R.pgc.custodyUrl, max: 2, options: "-c search_path=fleet" });
    expect((await R.econ(F, "venture.create", { key: "sheets", model: "digital_product", offer: "sheets", state: "selected" })).ok).toBe(true);
    await liveRail(R.owner, "fleet", OWNER);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-v82-"));
    fs.chmodSync(dir, 0o700);
    initIdentityState(dir);
    igw = new PgIdentityGateway({ connectionString: R.pgc.identityUrl });
    const { vault, ownerVault } = openIdentityState(dir);
    broker = new IdentityBroker(igw, vault, { mail: shared, ownerVault, providerVault: openProviderVault(dir), stateFile: path.join(dir, "pending.json") });
    await broker.tick();
    // A published product (as in the v76 suite): files, a passing review, the public site, the legal seller, a brand, a mailbox.
    const o = await R.econ(F, "offer.create", { venture: "sheets", kind: "product", title: "Small business cash-flow workbook", summary: "A 12-month cash-flow forecast in Excel with charts.",
      description: "Enter your opening balance and expected income and costs; the workbook projects month-end cash and flags shortfalls.", audience: "UK sole traders",
      deliverables: ["Cash-flow workbook (.xlsx)", "Quick-start guide (.pdf)"], priceMinor: 1_500, terms: "Digital download; refunds if the file does not open or does not match the description." });
    const offerId = o.offer.offerId;
    const wb = Buffer.from("PK workbook bytes v1"), guide = Buffer.from("%PDF-1.4 guide v1");
    for (const [n, b, t] of [["cashflow.xlsx", wb, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], ["guide.pdf", guide, "application/pdf"]] as const) {
      expect((await R.econ(F, "offer.file", { offerId, role: "deliverable", fileName: n, contentType: t, contentB64: b.toString("base64") })).ok).toBe(true);
    }
    const files = [{ name: "cashflow.xlsx", bytes: wb }, { name: "guide.pdf", bytes: guide }];
    const rv = await R.econ(F, "review.record", { subject: "offer", offerId, files: files.map((f) => ({ name: f.name, sha256: sha(f.bytes), sizeBytes: f.bytes.length })),
      automated: autoReport(files), criteria: criteria(), verdict: "pass" });
    expect(rv.ok, JSON.stringify(rv)).toBe(true);
    await R.q(`SELECT fleet.fleet_admin_public_site_set('https://shop.fleet.test', NULL, 'operator:test')`);
    await R.q(`SELECT fleet.fleet_admin_seller_set($1::jsonb, 'operator:test')`, [JSON.stringify({ legalForm: "individual", legalName: "Test Owner", postalAddress: "1 Test Street, Testtown, TT1 1TT, United Kingdom" })]);
    expect((await R.econ(F, "identity.create", { kind: "venture_identity", ventureKey: "sheets", displayName: "Ledgerline",
      bio: "Spreadsheet tools that small businesses can trust to forecast their cash." })).ok).toBe(true);
    expect((await R.econ(F, "mailbox.provision", { ventureKey: "sheets", idempotencyKey: idem() })).ok).toBe(true);
    const p = await R.econ(F, "offer.publish", { offerId, reviewId: rv.reviewId });
    expect(p.ok, JSON.stringify(p)).toBe(true);
    slug = p.offer.slug;
    // An owner session for the dashboard read.
    await R.q(`INSERT INTO fleet.fleet_admin_passkeys (credential_id, public_key, name) VALUES ('v82_test_credential', decode(repeat('00', 40), 'hex'), 'test')`);
    await R.q(`INSERT INTO fleet.fleet_admin_sessions (session_sha, csrf_sha, credential_id, method, totp_ok, expires_at) VALUES ($1, $2, 'v82_test_credential', 'passkey', true, now() + interval '1 hour')`,
      [sha(session), sha("csrf")]);
  }, 300_000);
  afterAll(async () => {
    await igw?.close(); await svc?.end(); await custody?.end(); await R?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("migrates to v82 with a clean audit; the wording is stored once per version, immutable, and is exactly the pages' wording", async () => {
    expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(82);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
    const rows = await R.q(`SELECT version, kind, statements FROM fleet.fleet_buyer_consent_wordings ORDER BY kind`);
    expect(rows).toEqual([
      { version: BUYER_CONSENT_VERSION, kind: "digital_immediate", statements: [...BUYER_CONSENT_WORDING.digital_immediate] },
      { version: BUYER_CONSENT_VERSION, kind: "service_start", statements: [...BUYER_CONSENT_WORDING.service_start] },
    ]);
    await expect(R.q(`UPDATE fleet.fleet_buyer_consent_wordings SET statements = '["changed"]'`)).rejects.toThrow(/immutable|HISTORY/i);
    await expect(R.q(`DELETE FROM fleet.fleet_buyer_consent_wordings`)).rejects.toThrow(/immutable|HISTORY/i);
  });

  it("a purchase needs the buyer's consent; it is recorded (version, time, origin) and repeated in the delivery mail with the files", async () => {
    expect((await R.q(`SELECT fleet.fleet_admin_sales_set(true, $1) AS r`, [OWNER]))[0].r).toMatchObject({ ok: true, salesOpen: true });
    const origin = sha("buyer-ip-consent");
    const before = Number(await R.one(`(SELECT count(*) FROM fleet.fleet_customer_orders)`));
    expect(await pub("svc_offer_buy", [slug, origin])).toMatchObject({ ok: false, code: "FLEET_CONSENT_REQUIRED", version: BUYER_CONSENT_VERSION });
    expect(await pub("svc_offer_buy", [slug, origin, "2026-01-01.v0"])).toMatchObject({ ok: false, code: "FLEET_CONSENT_REQUIRED" });
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_customer_orders)`))).toBe(before); // nothing created, no checkout
    const b = await pub("svc_offer_buy", [slug, origin, BUYER_CONSENT_VERSION]);
    expect(b).toMatchObject({ ok: true, token: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const row = (await R.q(`SELECT consent_kind, consent_version, consent_origin, consent_at > now() - interval '1 minute' AS fresh FROM fleet.fleet_customer_orders WHERE access_token = $1`, [b.token]))[0];
    expect(row).toEqual({ consent_kind: "digital_immediate", consent_version: BUYER_CONSENT_VERSION, consent_origin: origin, fresh: true });
    const checkoutId = await checkoutOf(b.token);
    await open(checkoutId);
    const page = await pub("svc_order_page", [b.token]);
    expect(page.order).toMatchObject({ approvalUrl: expect.stringMatching(/^https:\/\/www\.paypal\.com\//),
      consent: { kind: "digital_immediate", recorded: true, version: BUYER_CONSENT_VERSION, statements: [...BUYER_CONSENT_WORDING.digital_immediate] } });
    await pay(checkoutId, 1_500, "bea@example.test");
    expect(await pub("svc_offer_tick", [20])).toMatchObject({ ok: true, delivered: 1 });
    await broker.tick();
    const mail = shared.outbox.at(-1)!;
    expect(mail.to).toEqual(["bea@example.test"]);
    expect(mail.body).toContain("Your confirmation (recorded ");
    for (const t of BUYER_CONSENT_WORDING.digital_immediate) expect(mail.body).toContain(t);
    expect((mail.attachments ?? []).map((a: any) => a.fileName).sort()).toEqual(["cashflow.xlsx", "guide.pdf"]);
    const after = await pub("svc_order_page", [b.token]);
    expect(after.downloads.map((d: any) => d.fileName).sort()).toEqual(["cashflow.xlsx", "guide.pdf"]);
    // A recorded consent is evidence: it never changes.
    await expect(R.q(`UPDATE fleet.fleet_customer_orders SET consent_origin = $2 WHERE access_token = $1`, [b.token, sha("other")])).rejects.toThrow(/FLEET_IMMUTABLE/);
    await expect(R.q(`UPDATE fleet.fleet_customer_orders SET consent_at = NULL, consent_kind = NULL, consent_version = NULL WHERE access_token = $1`, [b.token])).rejects.toThrow(/FLEET_IMMUTABLE/);
    // Repeating it on the order page changes nothing.
    expect(await pub("svc_order_consent", [b.token, sha("someone-else"), BUYER_CONSENT_VERSION])).toMatchObject({ ok: true, replay: true });
    expect(await R.one(`(SELECT consent_origin FROM fleet.fleet_customer_orders WHERE access_token = $1)`, [b.token])).toBe(origin);
  });

  it("an order with a page but no consent: no payment link, no download, no attachment; the files appear once the buyer confirms", async () => {
    // The owner's proof purchase is made outside the offer page's form (sales closed), so no consent is recorded with it.
    expect((await R.q(`SELECT fleet.fleet_admin_sales_set(false, $1) AS r`, [OWNER]))[0].r).toMatchObject({ ok: true, salesOpen: false });
    const p = (await R.q(`SELECT fleet.fleet_admin_offer_proof_buy($1, $2) AS r`, [slug, OWNER]))[0].r;
    expect(p.ok, JSON.stringify(p)).toBe(true);
    const token = p.page.split("/").pop();
    const checkoutId = await checkoutOf(token);
    await open(checkoutId);
    let page = await pub("svc_order_page", [token]);
    expect(page.order.approvalUrl).toBeUndefined();
    expect(page.order.consent).toMatchObject({ kind: "digital_immediate", recorded: false, version: BUYER_CONSENT_VERSION, statements: [...BUYER_CONSENT_WORDING.digital_immediate] });
    await pay(checkoutId, 1_500, "owner@example.test");
    expect(await pub("svc_offer_tick", [20])).toMatchObject({ ok: true, delivered: 1 });
    await broker.tick();
    const mail = shared.outbox.at(-1)!;
    expect(mail.to).toEqual(["owner@example.test"]);
    expect(mail.attachments ?? []).toEqual([]);
    expect(mail.body).toContain("Before your first download, your order page asks you to confirm");
    page = await pub("svc_order_page", [token]);
    expect(page.order).toMatchObject({ payment: "paid", status: "delivered" });
    expect(page.downloads ?? null).toBeNull();
    const d = await R.q(`SELECT d.delivery_id::text AS id FROM fleet.fleet_order_deliveries d JOIN fleet.fleet_customer_orders o ON o.order_id = d.order_id WHERE o.access_token = $1`, [token]);
    expect(await pub("svc_order_file", [token, d[0].id, 1])).toMatchObject({ ok: false, code: "FLEET_NOT_FOUND" });
    // Wrong or missing version: refused; the right one is recorded once.
    expect(await pub("svc_order_consent", [token, sha("buyer"), null])).toMatchObject({ ok: false, code: "FLEET_CONSENT_REQUIRED" });
    expect(await pub("svc_order_consent", ["f".repeat(64), sha("buyer"), BUYER_CONSENT_VERSION])).toMatchObject({ ok: false, code: "FLEET_NOT_FOUND" });
    expect(await pub("svc_order_consent", [token, sha("buyer"), BUYER_CONSENT_VERSION])).toMatchObject({ ok: true });
    page = await pub("svc_order_page", [token]);
    expect(page.order.consent).toMatchObject({ recorded: true, at: expect.any(String) });
    expect(page.downloads.map((x: any) => x.fileName).sort()).toEqual(["cashflow.xlsx", "guide.pdf"]);
    expect(await pub("svc_order_file", [token, d[0].id, 1])).toMatchObject({ ok: true });
  });

  it("the owner's proof order: once the buyer confirms on the page, the order confirmation repeats it by mail (the earlier delivery mail could not)", async () => {
    const token = await R.one<string>(`(SELECT access_token FROM fleet.fleet_customer_orders WHERE owner_proof ORDER BY created_at DESC LIMIT 1)`);
    expect(await pub("svc_offer_tick", [20])).toMatchObject({ ok: true, confirmed: 1 });
    await broker.tick();
    const mail = shared.outbox.at(-1)!;
    expect(mail.to).toEqual(["owner@example.test"]);
    expect(mail.subject).toBe("Order confirmation — Small business cash-flow workbook");
    expect(mail.body).toContain("Your confirmation (recorded ");
    for (const t of BUYER_CONSENT_WORDING.digital_immediate) expect(mail.body).toContain(t);
    expect(mail.body).toContain(`https://shop.fleet.test/order/${token}`);
    expect(mail.body).toContain("Sold by Test Owner"); // the seller statement on every buyer mail
    expect(await pub("svc_offer_tick", [20])).toMatchObject({ confirmed: 0 }); // once
  });

  it("an order the agent makes outside the offer pages gets an order page; the raw PayPal link is never handed out; consent, payment, confirmation", async () => {
    expect((await R.q(`SELECT fleet.fleet_admin_sales_set(true, $1) AS r`, [OWNER]))[0].r).toMatchObject({ ok: true, salesOpen: true });
    const c = await R.econ(F, "paypal.checkout", { venture: "sheets", amountMinor: 4_000, description: "Custom invoice tracker", fulfilment: "service", idempotencyKey: idem() });
    expect(c, JSON.stringify(c)).toMatchObject({ ok: true, order: { fulfilment: "service", page: expect.stringMatching(/^https:\/\/shop\.fleet\.test\/order\/[0-9a-f]{64}$/) },
      note: expect.stringContaining("order page") });
    const token = c.order.page.split("/").pop();
    await open(c.checkout.checkoutId);
    // The agent's checkout list never carries the PayPal link of a checkout with an order page.
    const listed = (await R.econ(F, "paypal.checkouts", {})).checkouts.find((x: any) => x.checkoutId === c.checkout.checkoutId);
    expect(listed).toMatchObject({ status: "open" });
    expect(listed.approvalUrl).toBeUndefined();
    let page = await pub("svc_order_page", [token]);
    expect(page.order.approvalUrl).toBeUndefined();
    expect(page.order.consent).toMatchObject({ kind: "service_start", recorded: false, statements: [...BUYER_CONSENT_WORDING.service_start] });
    expect(await pub("svc_order_consent", [token, sha("buyer-direct"), BUYER_CONSENT_VERSION])).toMatchObject({ ok: true });
    page = await pub("svc_order_page", [token]);
    expect(page.order.approvalUrl).toMatch(/^https:\/\/www\.paypal\.com\//);
    await pay(c.checkout.checkoutId, 4_000, "cal@example.test");
    expect(await pub("svc_offer_tick", [20])).toMatchObject({ ok: true, confirmed: 1 });
    await broker.tick();
    const mail = shared.outbox.at(-1)!;
    expect(mail.to).toEqual(["cal@example.test"]);
    expect(mail.subject).toBe("Order confirmation — Custom invoice tracker");
    expect(mail.body).toContain("GBP 40.00, paid by PayPal");
    for (const t of BUYER_CONSENT_WORDING.service_start) expect(mail.body).toContain(t);
    expect(mail.body).toContain(`https://shop.fleet.test/order/${token}`);
    expect(await R.one(`(SELECT confirmed_at IS NOT NULL FROM fleet.fleet_customer_orders WHERE access_token = $1)`, [token])).toBe(true);
    // A pre-v82 order without a page is untouched: still delivered as before (its buyer keeps the right to cancel).
    expect(await R.one(`(SELECT count(*) FROM fleet.fleet_customer_orders WHERE access_token IS NULL)`).then(Number)).toBe(0);
  });

  it("helper jobs: the stated purpose and the start / end are recorded with each call — running, finished, failed, ended; never guessed", async () => {
    /** As FleetController does: reserve (insert, then the route snapshot), then record the result (delete + log, one transaction). */
    const reserve = async (agent: string, route: object, tier = "T1") => {
      const id = crypto.randomUUID();
      await R.q(`INSERT INTO fleet.fleet_cognition_inflight (agent_id, request_id, estimate_cents) VALUES ($1, $2, 1)`, [agent, id]);
      await R.q(`UPDATE fleet.fleet_cognition_inflight SET route_tier = $3, route = $2::jsonb WHERE request_id = $1`, [id, JSON.stringify(route), tier]);
      return id;
    };
    const record = async (agent: string, id: string, outcome: "ok" | "error" | null) => {
      const c = await R.owner.connect();
      try {
        await c.query("BEGIN");
        await c.query(`DELETE FROM fleet.fleet_cognition_inflight WHERE request_id = $1`, [id]);
        if (outcome) await c.query(`INSERT INTO fleet.fleet_cognition_log (request_id, agent_id, provider, model, outcome, input_tokens, output_tokens, cost_microcents, charged_cents,
            prompt_sha256, response_sha256, error_code) VALUES ($1, $2, 'anthropic', 'claude-test', $3, 1, 1, 1, 0, $4, $5, $6)`,
          [id, agent, outcome, sha(`secret prompt ${id}`), sha(`response ${id}`), outcome === "error" ? "PROVIDER_ERROR" : null]);
        await c.query("COMMIT");
      } finally { c.release(); }
    };
    const job = async (id: string) => ((await helpers()).jobs as any[]).find((j) => j.id === id);
    const research = await reserve(F.id, { taskClass: "page_interpretation", scope: "task_step", tier: "T1", helper: { kind: "routine", purpose: "research" } });
    const r1 = await job(research);
    expect(r1).toMatchObject({ agentId: F.id, kind: "routine", purpose: "research", taskClass: "page_interpretation", tier: "T1", state: "running", outcome: "running", finishedAt: null });
    expect(Date.parse(r1.startedAt)).toBe(Date.parse(await R.one(`(SELECT started_at::text FROM fleet.fleet_helper_jobs WHERE request_id = $1)`, [research])));
    await record(F.id, research, "ok");
    expect(await job(research)).toMatchObject({ purpose: "research", state: "finished", outcome: "ok", finishedAt: expect.any(String) });
    // A marketing chore and a critical question that fails.
    const marketing = await reserve(F.id, { taskClass: "formatting", scope: "task_step", helper: { kind: "routine", purpose: "marketing" } });
    await record(F.id, marketing, "ok");
    expect(await job(marketing)).toMatchObject({ kind: "routine", purpose: "marketing", state: "finished" });
    const question = await reserve(F.id, { taskClass: "agent_step", scope: "question", escalationReason: "HIGH_CONSEQUENCE", helper: { kind: "escalation", purpose: "decision" } }, "T3");
    await record(F.id, question, "error");
    expect(await job(question)).toMatchObject({ kind: "escalation", purpose: "decision", tier: "T3", state: "failed", outcome: "error" });
    // An independent review is known while it runs (no review record needed).
    const review = await reserve(F.id, { taskClass: "agent_step", scope: "task_step", helper: { kind: "review", purpose: "quality_review" } }, "T2");
    expect(await job(review)).toMatchObject({ kind: "review", purpose: "quality_review", state: "running" });
    await record(F.id, review, "ok");
    // The agent's own step is not a helper.
    const step = await reserve(F.id, { taskClass: "agent_step", scope: "task_step" }, "T2");
    await record(F.id, step, "ok");
    expect(await job(step)).toBeUndefined();
    // An older runtime's chore states no purpose: recorded as such (never guessed); its reservation ends without a result.
    const old = await reserve(G.id, { taskClass: "research_triage", scope: "task_step" });
    expect(await job(old)).toMatchObject({ agentId: G.id, kind: "routine", purpose: null, state: "running" });
    await record(G.id, old, null);
    expect(await job(old)).toMatchObject({ purpose: null, state: "ended", outcome: "ended", finishedAt: expect.any(String) });
    // Fleet Control's evidence check is what its class says.
    const evidence = await reserve(G.id, { taskClass: "evidence_relevance", scope: "task_step" }, "T2");
    expect(await job(evidence)).toMatchObject({ kind: "fleet_review", purpose: "evidence_check", state: "running" });
    await record(G.id, evidence, "ok");
    const h = await helpers();
    expect((h.jobs as any[]).some((j) => j.kind === "inspection" && j.purpose === "inspection" && j.state === "finished")).toBe(true);
    expect(h.today).toMatchObject({ routine: 2, unrecorded: 1, escalation: 1, review: 1 });
    expect(h.today.fleetReview).toBeGreaterThanOrEqual(1);
    // Records are history; only classes and times leave the database.
    await expect(R.q(`DELETE FROM fleet.fleet_helper_jobs WHERE request_id = $1`, [research])).rejects.toThrow(/immutable|HISTORY/i);
    const text = JSON.stringify(h);
    for (const id of [research, question, marketing]) expect(text).not.toContain(sha(`secret prompt ${id}`));
    expect(text).not.toMatch(/prompt|response|model|claude-test/i);
  });
});

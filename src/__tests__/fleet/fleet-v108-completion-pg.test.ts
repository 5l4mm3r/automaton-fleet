/**
 * v108 — the launch completion package (owner, 2026-10-20), against PostgreSQL:
 *  1. supported customer geography (owner policy: worldwide; EU consumer digital sales only through a merchant of record —
 *     none connected): the buyer's country before payment; a listed country refused before any payment; a PayPal payer
 *     country that is listed or differs from the stated one holds delivery;
 *  2. order conversations close ("the ai needs to log off after customer satisfaction is met"): at a full refund, 7 days
 *     after resolution with nothing new, or at 10 buyer messages; requests already made stay owed;
 *  3. a buyer's emailed reply joins the order's thread (from the buyer's own address only; quoted history removed);
 *  4. a product is sold publicly only with its spreadsheets' values saved (cached_values pass).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { PgIdentityGateway } from "../../fleet/identity/gateway.js";
import { IdentityBroker } from "../../fleet/identity/broker.js";
import { SimulatedSharedMailProvider } from "../../fleet/identity/providers.js";
import { initIdentityState, openIdentityState, openProviderVault } from "../../fleet/identity/main.js";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, autoCapabilityChecks, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { liveRail } from "./fixtures/custody-signer.js";
import { BUYER_CONSENT_VERSION } from "../../fleet/storefront/consent.js";
import { EU_27 } from "../../fleet/postgres/migrations-phase108.js";

const PG_BIN = findPgBin();
const ORIGIN = crypto.createHash("sha256").update("buyer-browser").digest("hex");

describe.skipIf(!PG_BIN)("v108 launch completion (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let F: Founder;
  let offerId = "";
  let su: pg.Pool;
  let igw: PgIdentityGateway;
  let dir = "";
  const newOrder = async (email = "buyer@example.test") => {
    const k = await R.one(`fleet.fleet_econ_paypal_checkout($1, $2::jsonb)`, [F.id, JSON.stringify({ venture: "landlord", amountMinor: 500, description: "Tracker",
      idempotencyKey: `t:${crypto.randomBytes(8).toString("hex")}` })]);
    const token = crypto.randomBytes(32).toString("hex");
    const id = (await R.q(`INSERT INTO fleet.fleet_customer_orders (agent_id, venture_id, checkout_id, item, amount_minor, currency, fulfilment, access_token, origin_hash, offer_id, buyer_email)
      SELECT agent_id, venture_id, checkout_id, description, amount_minor, currency, 'digital_file', $2, encode(sha256('buyer'::bytea), 'hex'), $3, $4
        FROM fleet.fleet_paypal_checkouts WHERE checkout_id = $1 RETURNING order_id`, [k.checkout.checkoutId, token, offerId, email]))[0].order_id as string;
    return { id, token };
  };
  const svc = (fn: string, args: unknown[]) => R.one<any>(`fleet.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")})`, args);
  const conversation = async (orderId: string) => R.one<any>(`(SELECT fleet.fleet_order_conversation(o) FROM fleet.fleet_customer_orders o WHERE o.order_id = $1)`, [orderId]);

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000, simulatedSettlement: false });
    autoCapabilityChecks(R);
    [F] = R.founders;
    await liveRail(R.owner, "fleet", OWNER, { capabilities: ["payouts", "receive_payments", "refunds"] });
    expect((await R.econ(F, "venture.create", { key: "landlord", model: "digital_product", offer: "tracker", state: "selected" })).ok).toBe(true);
    const o = await R.econ(F, "offer.create", { venture: "landlord", kind: "product", title: "Compliance tracker", summary: "A landlord compliance tracker.",
      description: "Gas, EICR and EPC dates in one workbook.", deliverables: ["A tracker workbook"], priceMinor: 500, terms: "Refunds if it is wrong." });
    expect(o.ok, JSON.stringify(o)).toBe(true);
    offerId = o.offer.offerId;
    su = new pg.Pool({ connectionString: R.pgc.superUrl.replace(/\/postgres$/, `/${R.pgc.dbname}`), max: 1, options: "-c search_path=fleet" });
    // The Fleet's shared mailbox (simulated) and the agent's routing address, as in production.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-v108-"));
    fs.chmodSync(dir, 0o700);
    initIdentityState(dir);
    igw = new PgIdentityGateway({ connectionString: R.pgc.identityUrl });
    const { vault, ownerVault } = openIdentityState(dir);
    const broker = new IdentityBroker(igw, vault, { mail: new SimulatedSharedMailProvider("fleet@shared.fleet-mail.test"), ownerVault, providerVault: openProviderVault(dir),
      stateFile: path.join(dir, "pending.json") });
    await broker.tick();
    expect((await R.econ(F, "mailbox.provision", { ventureKey: "landlord", idempotencyKey: `mbx:${crypto.randomUUID()}` })).ok).toBe(true);
  }, 300_000);
  afterAll(async () => { await su?.end(); await igw?.close(); await R?.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("geography: the owner's policy (EU-27 not sold to on the treasury checkout); the buyer's country before payment; holds after payment", async () => {
    expect((await su.query(`SELECT unsupported FROM fleet_sales_geography WHERE id = 1`)).rows[0].unsupported).toEqual([...EU_27]);
    const { id, token } = await newOrder();
    expect(await svc("svc_order_consent", [token, ORIGIN, BUYER_CONSENT_VERSION])).toMatchObject({ ok: true });
    // No country stated: no payment step.
    expect(await svc("svc_order_pay", [token, ORIGIN])).toMatchObject({ ok: false, code: "FLEET_COUNTRY_REQUIRED" });
    expect(await svc("svc_order_country", [token, ORIGIN, "DE"])).toMatchObject({ ok: false, code: "FLEET_COUNTRY_UNSUPPORTED", country: "DE" });
    expect(await svc("svc_order_country", [token, ORIGIN, "zz1"])).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" });
    expect(await svc("svc_order_pay", [token, ORIGIN])).toMatchObject({ ok: false, code: "FLEET_COUNTRY_REQUIRED" });
    expect(await svc("svc_order_country", [token, ORIGIN, "gb"])).toMatchObject({ ok: true, stated: "GB" });
    expect((await svc("svc_order_pay", [token, ORIGIN])).ok).toBe(true);
    expect((await svc("svc_order_page", [token])).order.country).toMatchObject({ stated: "GB" });
    // After payment: PayPal's payer country decides whether delivery may go ahead.
    const hold = (patch: Record<string, unknown>) => R.one<string | null>(`(SELECT fleet.fleet_order_country_hold(jsonb_populate_record(o, $2::jsonb)) FROM fleet.fleet_customer_orders o WHERE o.order_id = $1)`,
      [id, JSON.stringify(patch)]);
    expect(await hold({ buyer_country: "GB" })).toBeNull();
    expect(await hold({ buyer_country: "FR" })).toMatch(/PayPal shows the buyer in FR, where the treasury checkout does not sell/);
    expect(await hold({ buyer_country: "US" })).toMatch(/the buyer stated GB but PayPal shows US/);
    expect(await hold({ buyer_country: null })).toBeNull();
    // The owner changes the policy (owner only); orders made before v108 state no country and are judged by PayPal's alone.
    await expect(R.q(`SELECT fleet.fleet_admin_sales_geography(ARRAY['FR'], 'test', 'founder:x')`)).rejects.toThrow(/owner actor required/);
    expect(await R.one(`fleet.fleet_admin_sales_geography(ARRAY['fr','de','FR'], 'test: a narrower list', $1)`, [OWNER])).toMatchObject({ ok: true, unsupported: ["DE", "FR"] });
    expect(await hold({ buyer_country: "IT", buyer_stated_country: null })).toBeNull();
    await R.one(`fleet.fleet_admin_sales_geography($1::text[], 'restore the owner policy', $2)`, [[...EU_27], OWNER]);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });

  it("conversations close at 10 buyer messages (and after a full refund, or 7 days after resolution); requests already made stay owed", async () => {
    const { id, token } = await newOrder();
    await R.q(`UPDATE fleet.fleet_customer_orders SET payment_status = 'paid' WHERE order_id = $1`, [id]);
    expect(await conversation(id)).toMatchObject({ open: true, buyerMessages: 0, buyerMessagesMax: 10 });
    for (let i = 0; i < 10; i++) expect(await svc("svc_customer_message", ["order", token, ORIGIN, `question ${i}`, "[]"])).toMatchObject({ ok: true });
    expect(await conversation(id)).toMatchObject({ open: false, reason: "message_limit", support: "fleet.treasury@proton.me" });
    const refused = await svc("svc_customer_message", ["order", token, ORIGIN, "one more", "[]"]);
    expect(refused).toMatchObject({ ok: false, code: "FLEET_ORDER_CLOSED" });
    expect(refused.reason).toMatch(/message limit: for anything else write to fleet\.treasury@proton\.me/);
    // The ten already sent are still owed an answer (obligations unchanged by closing).
    expect((await R.one<any>(`fleet.fleet_customer_obligations($1)`, [F.id])).some((o: any) => o.id === id && o.state === "unanswered")).toBe(true);
    // Resolution: a sent delivery 8 days ago with nothing new since → closed; a buyer message after it → open again until resolved.
    const b = await newOrder();
    await R.q(`UPDATE fleet.fleet_customer_orders SET payment_status = 'paid' WHERE order_id = $1`, [b.id]);
    await R.q(`INSERT INTO fleet.fleet_order_deliveries (order_id, agent_id, idempotency_key, subject, body, status, created_at, sent_at)
      VALUES ($1, $2, $3, 'Your tracker', 'Attached.', 'sent', now() - interval '8 days', now() - interval '8 days')`, [b.id, F.id, `t:${crypto.randomUUID()}`]);
    expect(await conversation(b.id)).toMatchObject({ open: false, reason: "resolved" });
    const c = await newOrder();
    await R.q(`UPDATE fleet.fleet_customer_orders SET payment_status = 'paid' WHERE order_id = $1`, [c.id]);
    await R.q(`INSERT INTO fleet.fleet_order_deliveries (order_id, agent_id, idempotency_key, subject, body, status, created_at, sent_at)
      VALUES ($1, $2, $3, 'Your tracker', 'Attached.', 'sent', now() - interval '2 days', now() - interval '2 days')`, [c.id, F.id, `t:${crypto.randomUUID()}`]);
    expect(await conversation(c.id)).toMatchObject({ open: true });
    expect(new Date((await conversation(c.id)).closesAt).getTime()).toBeGreaterThan(Date.now() + 4 * 86_400_000);
    // A full refund closes it at once.
    await R.q(`UPDATE fleet.fleet_customer_orders SET payment_status = 'refunded', refunded_minor = amount_minor WHERE order_id = $1`, [c.id]);
    expect(await conversation(c.id)).toMatchObject({ open: false, reason: "refunded" });
  });

  it("a buyer's emailed reply joins the order's thread — only from the buyer's address, without the quoted history, never once closed", async () => {
    const { id } = await newOrder("ada@example.test");
    await R.q(`UPDATE fleet.fleet_customer_orders SET payment_status = 'paid' WHERE order_id = $1`, [id]);
    const channel = (await su.query(`SELECT provider_id FROM fleet_comms_providers WHERE capability = 'mail' AND mode = 'shared' AND status = 'active' LIMIT 1`)).rows[0]?.provider_id as string;
    expect(channel).toBeTruthy();
    // The agent's message to the buyer, as order.message stores it, and its sent mail (the provider's message id).
    const out = (await su.query(`INSERT INTO fleet.fleet_agent_mail (message_id, agent_id, channel_id, direction, routing, subject, body, recipients, sender, sender_address, external_message_id, send_status, thread_id)
      VALUES (gen_random_uuid(), $1, $2, 'out', 'sent', 'Agent-1 - About your order — Tracker', 'Your corrected tracker is attached.', ARRAY['ada@example.test'], 'Agent-1', 'fleet.treasury@proton.me', $3, 'sent', NULL)
      RETURNING message_id`, [F.id, channel, `<out-${crypto.randomUUID()}@proton.me>`])).rows[0].message_id as string;
    await su.query(`UPDATE fleet.fleet_agent_mail SET thread_id = message_id WHERE message_id = $1`, [out]);
    await R.q(`INSERT INTO fleet.fleet_customer_messages (agent_id, order_id, author, body, mail_message_id) VALUES ($1, $2, 'agent', 'Your corrected tracker is attached.', $3)`, [F.id, id, out]);
    const ext = (await su.query(`SELECT external_message_id FROM fleet_agent_mail WHERE message_id = $1`, [out])).rows[0].external_message_id as string;
    const ingest = async (from: string, body: string) => (await su.query(`SELECT fleet.ix_mail_ingest('test-mail', $1, $2::jsonb, false) AS r`, [channel, JSON.stringify({
      providerId: `p-${crypto.randomUUID()}`, messageId: `<in-${crypto.randomUUID()}@example.test>`, inReplyTo: ext, references: [ext],
      from, to: ["fleet.treasury@proton.me"], subject: "Re: Agent-1 - About your order — Tracker", body, at: new Date().toISOString() })])).rows[0].r;
    const buyerMessages = async () => R.q(`SELECT body, mail_message_id FROM fleet.fleet_customer_messages WHERE order_id = $1 AND author = 'buyer' ORDER BY created_at`, [id]);
    const r1 = await ingest("Ada <ada@example.test>", "Thanks — the EICR column still shows numbers.\n\nOn Tue, 20 Oct 2026 at 21:15, Agent-1 <fleet.treasury@proton.me> wrote:\n> Your corrected tracker is attached.");
    expect(r1.deliveries[0]).toMatchObject({ agentId: F.id, routing: "thread" });
    expect(await buyerMessages()).toEqual([expect.objectContaining({ body: "Thanks — the EICR column still shows numbers.", mail_message_id: r1.deliveries[0].messageId })]);
    expect((await R.one<any>(`fleet.fleet_customer_obligations($1)`, [F.id])).find((o: any) => o.id === id)).toMatchObject({ state: "unanswered" });
    // Someone else replying in the thread is mail, not the buyer's message.
    await ingest("mallory@example.test", "Please refund me instead.");
    expect(await buyerMessages()).toHaveLength(1);
    // Closed (a full refund): an emailed reply is still mail for the agent, but no longer joins the order.
    await R.q(`UPDATE fleet.fleet_customer_orders SET payment_status = 'refunded', refunded_minor = amount_minor WHERE order_id = $1`, [id]);
    await ingest("ada@example.test", "Can you also make me a rent tracker?");
    expect(await buyerMessages()).toHaveLength(1);
  });

  it("a product is not sold publicly while a spreadsheet in its passing review saves formulas without their values", async () => {
    const digest = await R.one<string>(`fleet.fleet_files_digest(fleet.fleet_offer_deliverables($1))`, [offerId]);
    const review = async (cachedStatus: string) => (await R.q(`INSERT INTO fleet.fleet_artifact_reviews (agent_id, subject, offer_id, files, files_digest, inspector, automated, automated_ok, criteria, verdict)
      VALUES ($1, 'offer', $2, '[{"name":"tracker.xlsx"}]', $3, 'fleet-qa-3', $4::jsonb, true, '["a","b","c"]', 'pass') RETURNING review_id`,
      [F.id, offerId, digest, JSON.stringify({ files: [{ detectedType: "xlsx", checks: [{ id: "recalc", status: "pass" }, { id: "cached_values", status: cachedStatus }] }] })]))[0].review_id as string;
    const block = (reviewId: string) => R.one<string | null>(`(SELECT fleet.fleet_offer_sale_block(jsonb_populate_record(o, jsonb_build_object('status', 'published', 'review_id', $2::uuid))) FROM fleet.fleet_offers o WHERE o.offer_id = $1)`,
      [offerId, reviewId]);
    expect(await block(await review("warn"))).toMatch(/saves formulas without their values .* inspect again, review and publish with that review/);
    expect(await block(await review("pass"))).toBeNull();
  });
});

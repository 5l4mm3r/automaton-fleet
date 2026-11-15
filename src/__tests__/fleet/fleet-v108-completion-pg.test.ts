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
import { V108_SQL } from "../../fleet/postgres/migrations-phase108.js";

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

  it("geography: the owner's decision (worldwide, no exclusions); the buyer's country recorded before payment; only a listed country refused or held", async () => {
    expect((await su.query(`SELECT unsupported FROM fleet_sales_geography WHERE id = 1`)).rows[0].unsupported).toEqual([]);
    const { id, token } = await newOrder();
    expect(await svc("svc_order_consent", [token, ORIGIN, BUYER_CONSENT_VERSION])).toMatchObject({ ok: true });
    // The country is recorded before the payment step (the owner's "the country step still records it").
    expect(await svc("svc_order_pay", [token, ORIGIN])).toMatchObject({ ok: false, code: "FLEET_COUNTRY_REQUIRED" });
    expect(await svc("svc_order_country", [token, ORIGIN, "zz1"])).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" });
    expect(await svc("svc_order_country", [token, ORIGIN, "de"])).toMatchObject({ ok: true, stated: "DE" });       // EU included
    expect((await svc("svc_order_pay", [token, ORIGIN])).ok).toBe(true);
    expect((await svc("svc_order_page", [token])).order.country).toMatchObject({ stated: "DE", unsupported: [] });
    const hold = (patch: Record<string, unknown>) => R.one<string | null>(`(SELECT fleet.fleet_order_country_hold(jsonb_populate_record(o, $2::jsonb)) FROM fleet.fleet_customer_orders o WHERE o.order_id = $1)`,
      [id, JSON.stringify(patch)]);
    // No list: no hold, whatever PayPal shows (a different payer country is evidence, not a reason to hold).
    for (const c of ["DE", "FR", "US", null]) expect(await hold({ buyer_country: c })).toBeNull();
    // The owner may list a country later (owner only): then it is refused before payment and a paid order from it is held.
    await expect(R.q(`SELECT fleet.fleet_admin_sales_geography(ARRAY['FR'], 'test', 'founder:x')`)).rejects.toThrow(/owner actor required/);
    expect(await R.one(`fleet.fleet_admin_sales_geography(ARRAY['fr','FR'], 'test: one listed country', $1)`, [OWNER])).toMatchObject({ ok: true, unsupported: ["FR"] });
    expect(await hold({ buyer_country: "FR" })).toMatch(/PayPal shows the buyer in FR, where the treasury checkout does not sell/);
    expect(await hold({ buyer_country: "US", buyer_stated_country: "FR" })).toMatch(/the buyer stated FR, where the treasury checkout does not sell/);
    expect(await hold({ buyer_country: "US" })).toBeNull();
    const b = await newOrder();
    expect(await svc("svc_order_country", [b.token, ORIGIN, "FR"])).toMatchObject({ ok: false, code: "FLEET_COUNTRY_UNSUPPORTED" });
    await R.one(`fleet.fleet_admin_sales_geography('{}'::text[], 'back to the owner decision: no exclusions', $1)`, [OWNER]);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });

  it("agents read the owner's decision (fleet-capability-status v15): worldwide, the country step, conversations, email, saved values", async () => {
    // The test registry's wipe clears loaded knowledge, so the migration's own load is checked (production loads it once).
    const body = V108_SQL.slice(V108_SQL.indexOf("fleet_admin_knowledge_library_load"));
    expect(body).toContain("WORLDWIDE, EU consumers included");
    expect(body).not.toContain("Do not sell digital products to EU consumers through the treasury checkout");
    expect(body).toContain("Order conversations");
    expect(body).toContain("Buyer email");
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

  it("a buyer's emailed reply joins the order's thread — only from the buyer's address, without the quoted history; closure is per conversation (v110)", async () => {
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
    // v109 — closed (a full refund): the buyer's emailed reply is the owner's to review, never the agent's waking mail.
    await R.q(`UPDATE fleet.fleet_customer_orders SET payment_status = 'refunded', refunded_minor = amount_minor WHERE order_id = $1`, [id]);
    const closed = await ingest("ada@example.test", "Can you also make me a rent tracker?");
    expect(await buyerMessages()).toHaveLength(1);
    const kept = (await su.query(`SELECT agent_id, routing, routing_reason FROM fleet_agent_mail WHERE message_id = $1`, [closed.deliveries[0].messageId])).rows[0];
    expect(kept).toMatchObject({ agent_id: null, routing: "unassigned" });
    expect(kept.routing_reason).toMatch(/closed order \(refunded\): kept for the owner's review, not agent work/);
    expect((await su.query(`SELECT count(*)::int AS n FROM fleet_events WHERE event_type = 'closed_order_mail' AND detail ->> 'orderId' = $1`, [id])).rows[0].n).toBe(1);
    // v110 — closure is per conversation, not per address.
    const fresh = async (subject: string, body: string, from = "ada@example.test") => (await su.query(`SELECT fleet.ix_mail_ingest('test-mail', $1, $2::jsonb, false) AS r`, [channel,
      JSON.stringify({ providerId: `p-${crypto.randomUUID()}`, messageId: `<in-${crypto.randomUUID()}@example.test>`, from, to: ["fleet.treasury@proton.me"], subject, body, at: new Date().toISOString() })])).rows[0].r;
    const routed = async (r: any) => (await su.query(`SELECT agent_id, routing, routing_reason FROM fleet_agent_mail WHERE message_id = $1`, [r.deliveries[0].messageId])).rows[0];
    const keptEvents = async () => (await su.query(`SELECT detail ->> 'link' AS link FROM fleet_events WHERE event_type = 'closed_order_mail' AND detail ->> 'orderId' = $1 ORDER BY created_at`, [id])).rows.map((x: any) => x.link);
    expect(await keptEvents()).toEqual(["thread"]);
    // A genuinely new enquiry from the same buyer: the agent's ordinary mail — not kept, not attached, the refunded order stays closed.
    const enquiry = await fresh("Agent-1 - one more question", "Hello again — do you make rent trackers for Scotland?");
    expect(enquiry.deliveries[0]).toMatchObject({ agentId: F.id, routing: "subject" });
    expect(await routed(enquiry)).toMatchObject({ agent_id: F.id, routing: "subject" });
    expect(await buyerMessages()).toHaveLength(1);
    expect(await conversation(id)).toMatchObject({ open: false, reason: "refunded" });
    expect(await keptEvents()).toEqual(["thread"]);
    // Ambiguous — no reply headers, but the subject of the agent's mail about the closed order, or its reference: the owner's.
    const lost = await fresh("RE: Agent-1 - About your order — Tracker", "Still broken, can you look again?");
    expect(await routed(lost)).toMatchObject({ agent_id: null, routing: "unassigned" });
    expect((await routed(lost)).routing_reason).toMatch(/may be about a closed order \(refunded; no reply headers link it\): kept for the owner's review/);
    const ref = (await R.one<string>(`upper(left(replace($1::text, '-', ''), 8))`, [id]));
    const quoted = await fresh("Agent-1 - my order", `About order ${ref}: the file will not open.`);
    expect(await routed(quoted)).toMatchObject({ agent_id: null, routing: "unassigned" });
    expect(await keptEvents()).toEqual(["thread", "ambiguous", "ambiguous"]);
    expect(await buyerMessages()).toHaveLength(1);
    expect(await conversation(id)).toMatchObject({ open: false, reason: "refunded" });
    // With a second, OPEN order: a new message joins the open one; an ambiguous one about the closed order never does.
    const second = await newOrder("ada@example.test");
    await R.q(`UPDATE fleet.fleet_customer_orders SET payment_status = 'paid' WHERE order_id = $1`, [second.id]);
    const onOpen = await fresh("Agent-1 - the new order", "When will the second tracker arrive?");
    expect((await R.q(`SELECT body FROM fleet.fleet_customer_messages WHERE order_id = $1 AND author = 'buyer'`, [second.id])).map((x: any) => x.body)).toEqual(["When will the second tracker arrive?"]);
    expect(await routed(onOpen)).toMatchObject({ agent_id: F.id });
    const aboutClosed = await fresh("Agent-1 - question", `Re order ${ref.toLowerCase()} — why was it refunded?`);
    expect(await routed(aboutClosed)).toMatchObject({ agent_id: null, routing: "unassigned" });
    expect(await R.q(`SELECT 1 FROM fleet.fleet_customer_messages WHERE order_id = $1 AND author = 'buyer'`, [second.id])).toHaveLength(1);
    // Someone else naming the agent (no order of theirs): ordinary mail for the agent, as before — nothing about Ada's order is attached.
    const stranger = (await su.query(`SELECT fleet.ix_mail_ingest('test-mail', $1, $2::jsonb, false) AS r`, [channel, JSON.stringify({ providerId: `p-${crypto.randomUUID()}`,
      messageId: `<in-${crypto.randomUUID()}@example.test>`, from: "bob@example.test", to: ["fleet.treasury@proton.me"], subject: "Agent-1 - Order ada's tracker", body: "Send me Ada's file", at: new Date().toISOString() })])).rows[0].r;
    expect(stranger.deliveries[0]).toMatchObject({ agentId: F.id, routing: "subject" });
    expect(await buyerMessages()).toHaveLength(1);
  });

  it("one pre-launch card purchase: only under the owner's card-proof release, at its merchant, within its amount, once; sales stay closed", async () => {
    const acct = crypto.randomUUID(), other = crypto.randomUUID();
    for (const [id, origin] of [[acct, "https://www.fontshop.example"], [other, "https://www.other.example"]]) {
      await R.q(`INSERT INTO fleet.fleet_agent_accounts (account_id, agent_id, account_kind, platform, status, origins) VALUES ($1, $2, 'marketplace', 'shop', 'active', ARRAY[$3])`, [id, F.id, origin]);
    }
    const refusal = (args: Record<string, unknown>) => R.one<string | null>(`fleet.fleet_outward_refusal($1, 'card.request', $2::jsonb)`, [F.id, JSON.stringify(args)]);
    const buy = { accountId: acct, origin: "https://www.fontshop.example", amountMinor: 450, merchant: "Font shop" };
    const wasOpen = await R.one<boolean>(`fleet.fleet_sales_open()`);
    await R.one(`fleet.fleet_admin_sales_set(false, $1)`, [OWNER]);                         // as production: sales closed
    expect(await R.one(`fleet.fleet_sales_open()`)).toBe(false);
    expect(await refusal(buy)).toMatch(/needs the owner's card-proof release naming the merchant/);
    const release = (scope: Record<string, unknown>) => R.one<any>(`fleet.fleet_admin_outward_release($1, $2::jsonb, 'card proof: one font licence for the tracker', $3)`, [F.id, JSON.stringify(scope), OWNER]);
    const card = { actions: ["browser", "card"], accounts: [acct], origins: ["https://www.fontshop.example"], cardMerchant: "Font shop", cardMaxMinor: 500, expiresHours: 6 };
    // The release names one merchant, at most 500 minor units, at most 24 h, with the browser fill.
    for (const bad of [{ ...card, cardMaxMinor: 501 }, { ...card, expiresHours: 25 }, { ...card, actions: ["card"] }, { ...card, origins: [...card.origins, "https://www.other.example"] },
      { ...card, cardMerchant: undefined }, { actions: ["mail"], mailTo: ["owner@example.test"], cardMaxMinor: 100, expiresHours: 2 }]) {
      await expect(release(bad)).rejects.toThrow(/FLEET_BAD_REQUEST/);
    }
    expect(await release(card)).toMatchObject({ ok: true, salesOpen: false });
    expect(await refusal(buy)).toBeNull();                                                   // the one purchase it names
    expect(await refusal({ ...buy, amountMinor: 501 })).toMatch(/at most 500 minor units/);
    expect(await refusal({ ...buy, accountId: other, origin: "https://www.other.example" })).toMatch(/one purchase at Font shop/);
    expect(await refusal({ ...buy, origin: "https://www.evil.example" })).toMatch(/covers https:\/\/www\.fontshop\.example only/);
    // Once a card request exists under it, no second one.
    await R.q(`INSERT INTO fleet.fleet_card_requests (agent_id, account_id, origin, merchant, amount_minor, paypal_unavailable, purpose, status, expires_at)
      VALUES ($1, $2, 'https://www.fontshop.example', 'Font shop', 450, (SELECT paypal_unavailable FROM fleet.fleet_card_requests LIMIT 0), 'a font licence', 'approved', now() + interval '1 hour')`, [F.id, acct]).catch(async () => {
      const reason = (await su.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname LIKE 'fleet_card_requests%paypal_unavailable%' LIMIT 1`)).rows[0]?.d ?? "";
      const v = /'([a-z_]+)'/.exec(reason)?.[1] ?? "merchant_card_only";
      await R.q(`INSERT INTO fleet.fleet_card_requests (agent_id, account_id, origin, merchant, amount_minor, paypal_unavailable, purpose, status, expires_at)
        VALUES ($1, $2, 'https://www.fontshop.example', 'Font shop', 450, $3, 'a font licence', 'approved', now() + interval '1 hour')`, [F.id, acct, v]);
    });
    expect(await refusal(buy)).toMatch(/covers one purchase, and it has been requested/);
    // The release ends (expiry or hold): spending waits for launch again; sales never opened.
    await R.one(`fleet.fleet_admin_outward_hold($1, $2)`, [F.id, OWNER]);
    expect(await refusal(buy)).toMatch(/needs the owner's card-proof release/);
    expect(await R.one(`fleet.fleet_sales_open()`)).toBe(false);
    // v109: no account at the merchant yet — the card-proof release may allow registering one there instead (no account named);
    // only an account registered under THIS release, at its origin, is then usable for the fill and the one purchase.
    const reg = { actions: ["browser", "card", "account_register"], origins: ["https://www.iconshop.example"], cardMerchant: "Icon shop", cardMaxMinor: 300, expiresHours: 4 };
    await expect(release({ ...reg, actions: ["browser", "card"] })).rejects.toThrow(/FLEET_BAD_REQUEST/);       // no account and no registration
    expect(await release(reg)).toMatchObject({ ok: true });
    const old = crypto.randomUUID(), fresh = crypto.randomUUID();
    await R.q(`INSERT INTO fleet.fleet_agent_accounts (account_id, agent_id, account_kind, platform, status, origins, created_at) VALUES ($1, $2, 'marketplace', 'icons', 'active', ARRAY['https://www.iconshop.example'], now() - interval '1 day')`, [old, F.id]);
    await R.q(`INSERT INTO fleet.fleet_agent_accounts (account_id, agent_id, account_kind, platform, status, origins) VALUES ($1, $2, 'marketplace', 'icons2', 'active', ARRAY['https://www.iconshop.example'])`, [fresh, F.id]);
    const icon = { origin: "https://www.iconshop.example", amountMinor: 300, merchant: "Icon shop" };
    expect(await refusal({ ...icon, accountId: fresh })).toBeNull();
    expect(await refusal({ ...icon, accountId: old })).toMatch(/one purchase at Icon shop/);                 // made before the release
    expect(await refusal({ ...icon, accountId: fresh, amountMinor: 301 })).toMatch(/at most 300 minor units/);
    await R.one(`fleet.fleet_admin_outward_hold($1, $2)`, [F.id, OWNER]);
    if (wasOpen) await R.one(`fleet.fleet_admin_sales_set(true, $1)`, [OWNER]);
  });

  it("v109: a review with a spreadsheet whose formulas are saved without values is not a pass (and says how to fix it)", async () => {
    const bytes = Buffer.from("PK workbook bytes for the test");
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const record = (cached: string) => R.econ(F, "review.record", { subject: "offer", offerId, files: [{ name: "tracker.xlsx", sha256, sizeBytes: bytes.length }],
      automated: { inspector: "fleet-qa-3", ok: true, files: [{ path: "tracker.xlsx", sha256, sizeBytes: bytes.length, detectedType: "xlsx", ok: true,
        checks: [{ id: "recalc", status: "pass", detail: "1200 formulas" }, { id: "cached_values", status: cached, detail: "1194 formula cell(s) saved without a value" }] }] },
      criteria: [{ criterion: "A tracker workbook", met: true, evidence: "the workbook opened and checked" }, { criterion: "Dates readable", met: true, evidence: "dd/mm/yyyy" }, { criterion: "No errors", met: true, evidence: "recalc" }],
      verdict: "pass" });
    const warn = await record("warn");
    expect(warn.ok).toBe(false);
    expect(warn.reason ?? warn.code).toMatch(/FLEET_REVIEW_AUTOMATED_FAILED|saves formulas without their values/);
    expect(JSON.stringify(warn)).toMatch(/saves formulas without their values: previewers, phones and mail clients show them blank/);
    const ok = await record("pass");
    expect(ok, JSON.stringify(ok)).toMatchObject({ ok: true, verdict: "pass", automatedOk: true });
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

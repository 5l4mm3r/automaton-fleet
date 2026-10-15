/**
 * v79 — the autonomous business operator (PostgreSQL). The agent's own channels (any platform, rules recorded before it
 * operates there), what it publishes on them, attribution of enquiries and orders to the channel that brought them, a lead
 * pipeline and dated obligations that wake it, lawful outreach with a working opt-out, sales on other channels reported as
 * memos and their payouts booked only against a real treasury PayPal credit (automatically when unambiguous, else by the
 * owner), the venture P&L corrections and the browser step grammar. The browser's hands themselves (uploads, downloads,
 * screenshots, rendering, frames, tabs, pending passwords) run against a real Chrome in fleet-browser-pg.
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
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";
import { EVENT_ROUTES_V79 } from "../../fleet/postgres/migrations-phase79.js";

const PG_BIN = findPgBin();

describe.skipIf(!PG_BIN)("v79 the autonomous business operator (PostgreSQL)", { timeout: 300_000 }, () => {
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
  const txnId = () => `T${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
  const cx = async (fn: string, args: unknown[]) => {
    const ph = args.map((_, i) => `$${i + 1}`).join(", ");
    return (await custody.query(`SELECT fleet.${fn}(${ph}) AS r`, args)).rows[0].r;
  };
  const pub = async (fn: string, args: unknown[]) => {
    const ph = args.map((_, i) => `$${i + 1}`).join(", ");
    return (await svc.query(`SELECT fleet.${fn}(${ph}) AS r`, args)).rows[0].r;
  };
  const ok = async (p: Promise<Record<string, any>>) => {
    const r = await p;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return r;
  };
  /** A credit the treasury PayPal received (as custody records it from Transaction Search), with its payer. */
  const credit = async (amount: number, fee: number, counterparty: string, status = "S") => {
    const id = txnId();
    expect((await cx("cx_paypal_txn_record", ["custody-executor", rail.railId, JSON.stringify({ transactionId: id, eventCode: "T0000",
      initiatedAt: new Date().toISOString(), status, currency: "GBP", amountMinor: amount, feeMinor: -fee })])).ok).toBe(true);
    expect((await cx("cx_paypal_txn_counterparty", ["custody-executor", rail.railId, id, "T0000", counterparty])).ok).toBe(true);
    return id;
  };
  const cash = async (who: Founder) => Number(await R.one(`fleet.fleet_ledger_balance(fleet.fleet_ledger_account($1, 'agent_cash'))`, [who.id]));

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000, simulatedSettlement: false, outwardHeld: true });
    [F, G] = R.founders;
    await R.store.grantServiceRole();
    await R.store.grantCustodyRole();
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2, options: "-c search_path=fleet" });
    custody = new pg.Pool({ connectionString: R.pgc.custodyUrl, max: 2, options: "-c search_path=fleet" });
    for (const [who, key] of [[F, "ledgers"], [G, "prints"]] as const) {
      expect((await R.econ(who, "venture.create", { key, model: "digital_product", offer: key, state: "selected" })).ok).toBe(true);
    }
    rail = await liveRail(R.owner, "fleet", OWNER);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-v79-"));
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

  it("migrates to v79 with a clean audit; events are routed; the public functions are the service role's only", async () => {
    expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(79);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
    for (const [p, ts] of Object.entries(EVENT_ROUTES_V79)) for (const t of ts) expect(await R.one(`fleet.fleet_event_route($1, '{}'::jsonb)`, [t]), t).toBe(p);
    const agent = new pg.Pool({ connectionString: R.pgc.agentUrl, max: 1 });
    try {
      await expect(agent.query(`SELECT fleet.svc_attribute('order', $1, 'abcdefabcdef')`, ["0".repeat(64)])).rejects.toThrow(/permission denied/);
      await expect(agent.query(`SELECT fleet.fleet_admin_channel_payout_decide(gen_random_uuid(), 'reject', NULL, NULL, $1)`, [OWNER])).rejects.toThrow(/permission denied/);
    } finally { await agent.end(); }
    expect(await pub("svc_attribute", ["order", "0".repeat(64), "abcdefabcdef"])).toMatchObject({ ok: false });
  });

  it("the preparation hold is the default: no public site and sales closed hold outward actions; reading and rendering continue; the owner releases one agent", async () => {
    expect(await R.one(`fleet.fleet_preparation_hold()`)).toBe(true); // no public site at all
    const held = { ok: false, code: "FLEET_PREPARATION_HOLD" };
    expect(await R.econ(F, "mail.send", { to: "someone@example.test", subject: "Hi", body: "Hello", idempotencyKey: idem() })).toMatchObject(held);
    expect(await R.econ(F, "account.register", { platform: "example.com", kind: "marketplace", origin: "https://example.com" })).toMatchObject(held);
    const s = await ok(R.econ(F, "browser.open", { url: "https://example.com/" })); // reading is preparation
    expect((await R.econ(F, "browser.act", { sessionId: s.sessionId, steps: [{ action: "goto", url: "https://example.com/a" }, { action: "scroll", to: "bottom" },
      { action: "screenshot" }, { action: "wait_idle" }] })).ok).toBe(true);
    for (const outward of [[{ action: "click", text: "Sign up" }], [{ action: "fill", selector: "#q", value: "x" }], [{ action: "download", text: "CSV" }],
      [{ action: "goto", url: "https://example.com/" }, { action: "upload_file", selector: "#f", fileId: crypto.randomUUID() }]]) {
      expect(await R.econ(F, "browser.act", { sessionId: s.sessionId, steps: outward }), JSON.stringify(outward)).toMatchObject(held);
    }
    // Internal records are preparation, never held.
    expect((await R.econ(F, "channel.add", { ventureKey: "ledgers", name: "Prep channel", kind: "community" })).ok).toBe(true);
    // v80: the owner releases one agent for a named controlled proof — scoped (actions, origins, accounts) and expiring.
    const agent = new pg.Pool({ connectionString: R.pgc.agentUrl, max: 1 });
    try { await expect(agent.query(`SELECT fleet.fleet_admin_outward_release($1, '{}'::jsonb, 'x x x', $2)`, [F.id, OWNER])).rejects.toThrow(/permission denied/); } finally { await agent.end(); }
    const release = (scope: unknown) => R.q(`SELECT fleet.fleet_admin_outward_release($1, $2::jsonb, 'controlled proof: account on example.com', $3) AS r`, [F.id, JSON.stringify(scope), OWNER])
      .then((r) => r[0].r, (e: Error) => e.message);
    expect(await release({ actions: ["browser"], expiresHours: 2 })).toMatch(/name their origins/);
    expect(await release({ actions: ["account_register"], origins: ["https://example.com"], expiresHours: 200 })).toMatch(/expiresHours/);
    expect(await release({ actions: ["card"], origins: ["https://example.com"], expiresHours: 2 })).toMatch(/never released/);
    expect(await release({ actions: ["account_register"], origins: ["https://example.com"], expiresHours: 2 })).toMatchObject({ ok: true, salesOpen: false, warning: expect.stringMatching(/EXTERNAL/) });
    const reg = await ok(R.econ(F, "account.register", { platform: "example.com", kind: "marketplace", origin: "https://example.com" }));
    expect(await R.econ(F, "account.register", { platform: "other.example", kind: "marketplace", origin: "https://other.example" })).toMatchObject(held);
    expect(await R.econ(F, "browser.act", { sessionId: s.sessionId, steps: [{ action: "click", text: "Sign up" }] })).toMatchObject(held); // browser not in scope
    expect(await R.econ(G, "mail.send", { to: "someone@example.test", subject: "Hi", body: "Hello", idempotencyKey: idem() })).toMatchObject(held);
    expect(await R.one(`fleet.fleet_sales_open()`)).toBe(false);
    await R.q(`SELECT fleet.fleet_admin_outward_hold($1, $2)`, [F.id, OWNER]);
    expect(await R.econ(F, "account.register", { platform: "example.com", kind: "marketplace", origin: "https://example.com" })).toMatchObject(held);
    void reg;
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_events WHERE event_type IN ('outward_released','outward_held'))`))).toBe(2);
    // The rest of this suite exercises outward operations on a launched registry (test public site, sales open).
    await R.q(`SELECT fleet.fleet_admin_public_site_set('https://shop.fleet.test', NULL, $1)`, [OWNER]);
    await R.q(`SELECT fleet.fleet_admin_sales_set(true, $1)`, [OWNER]);
  });

  it("the browser step grammar: staged files, rendering only without an account, frames, tabs, dialogs; files are the agent's own", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f6b1c20000000049454e44ae426082", "hex");
    const st = await ok(R.econ(F, "browser.stage_file", { fileName: "logo.png", contentType: "image/png", contentB64: png.toString("base64") }));
    expect(st).toMatchObject({ direction: "to_page", source: "staged", sizeBytes: png.length, available: true });
    expect((await R.econ(F, "browser.stage_file", { fileName: "x.exe", contentType: "application/x-msdownload", contentB64: "AA==" })).code).toBe("FLEET_BAD_REQUEST");
    expect((await R.econ(F, "browser.stage_file", { fileName: "../etc", contentType: "text/plain", contentB64: "AA==" })).code).toBe("FLEET_BAD_REQUEST");
    expect((await R.econ(G, "browser.fetch_file", { fileId: st.fileId })).code).toBe("FLEET_NOT_FOUND");
    expect((await ok(R.econ(F, "browser.files", {}))).files.map((f: any) => f.fileId)).toContain(st.fileId);
    const s = await ok(R.econ(F, "browser.open", { url: "https://example.com/" }));
    const act = (steps: unknown[]) => R.econ(F, "browser.act", { sessionId: s.sessionId, steps });
    expect((await act([{ action: "upload_file", selector: "input[type=file]", fileIds: [st.fileId] }, { action: "screenshot", fullPage: true },
      { action: "set_content", fileId: st.fileId }, { action: "pdf" }, { action: "hover", text: "Menu" }, { action: "scroll", to: "bottom" },
      { action: "click", selector: "#card", frame: "iframe[name=pay]" }, { action: "tab", index: 1 }, { action: "dialog", accept: true }, { action: "wait_idle" },
      { action: "download", text: "Download CSV" }, { action: "uncheck", selector: "#news" }])).ok).toBe(true);
    for (const bad of [[{ action: "upload_file", fileIds: [st.fileId] }], [{ action: "upload_file", selector: "#f", fileId: "nope" }],
      [{ action: "tab", index: 12 }], [{ action: "dialog" }], [{ action: "scroll" }], [{ action: "click", selector: "#a", frame: "" }], [{ action: "eval", js: "1" }]]) {
      expect((await act(bad)).code, JSON.stringify(bad)).toBe("FLEET_BAD_REQUEST");
    }
    // Rendering the agent's own HTML happens only in a session without an account (never beside its logged-in cookies).
    const reg = await ok(R.econ(F, "account.register", { platform: "example.com", kind: "marketplace", origin: "https://example.com" }));
    const s2 = await ok(R.econ(F, "browser.open", { url: "https://example.com/", accountId: reg.accountId }));
    expect((await R.econ(F, "browser.act", { sessionId: s2.sessionId, steps: [{ action: "set_content", fileId: st.fileId }] })).code).toBe("FLEET_BAD_REQUEST");
    expect((await R.econ(F, "browser.act", { sessionId: s2.sessionId, steps: [{ action: "fill", selector: "#pw2", credential: "new_password" }] })).ok).toBe(true);
    // A pending password is confirmed or discarded only by the account's own agent.
    expect((await R.econ(F, "account.password_confirm", { accountId: reg.accountId })).code).toBe("FLEET_CREDENTIAL_NONE_PENDING");
    expect((await R.econ(G, "account.password_discard", { accountId: reg.accountId })).code).toBe("FLEET_NOT_FOUND");
  });

  let channel = "";
  let refCode = "";
  it("channels are the agent's choice; a third-party platform goes live only with its rules recorded; presence needs an active channel", async () => {
    const c = await ok(R.econ(F, "channel.add", { ventureKey: "ledgers", name: "Etsy", kind: "marketplace", url: "https://www.etsy.com/shop/ledgerline",
      feesSummary: "listing fee per item, transaction fee on sales" }));
    channel = c.channel.channelId; refCode = c.channel.refCode;
    expect(c.channel).toMatchObject({ status: "planned", ventureKey: "ledgers", refCode: expect.stringMatching(/^[0-9a-f]{12}$/) });
    expect((await R.econ(F, "channel.update", { channelId: channel, status: "active" })).code).toBe("FLEET_CHANNEL_RULES");
    const item = { channelId: channel, kind: "listing", title: "Cash-flow workbook for freelancers", url: "https://www.etsy.com/listing/1" };
    expect((await R.econ(F, "presence.record", { ...item, status: "live" })).code).toBe("FLEET_PRESENCE_CHANNEL");
    await ok(R.econ(F, "channel.update", { channelId: channel, status: "active", rulesSource: "https://www.etsy.com/legal/sellers",
      rulesSummary: "Sellers may use tools to manage listings; items must be described accurately; AI-generated content must be disclosed in the description." }));
    const p = await ok(R.econ(F, "presence.record", { ...item, status: "live", costMinor: 16 }));
    expect(p.item).toMatchObject({ status: "live", publishedAt: expect.any(String), costMinor: 16 });
    await ok(R.econ(F, "presence.update", { itemId: p.item.itemId, status: "paused" }));
    // Own pages, email and direct channels need no rules source; any name and kind is the agent's (no platform list).
    for (const [name, kind] of [["Own offer pages", "own_pages"], ["Cold email to studios", "email"], ["Local makers' forum", "community"]]) {
      expect((await R.econ(F, "channel.add", { ventureKey: "ledgers", name, kind, status: kind === "community" ? "planned" : "active" })).ok, name).toBe(true);
    }
    expect((await R.econ(G, "channel.update", { channelId: channel, status: "paused" })).code).toBe("FLEET_NOT_FOUND");
    expect((await R.econ(F, "channel.add", { ventureKey: "prints", name: "x", kind: "social" })).code).toBe("FLEET_BAD_REQUEST");
    expect((await ok(R.econ(F, "channel.list", { ventureKey: "ledgers" }))).channels.length).toBe(5); // + the one recorded under the hold
  });

  it("attribution: a channel's code carries onto the order it brings; another agent's code attributes nothing", async () => {
    const co = await ok(R.econ(F, "paypal.checkout", { venture: "ledgers", amountMinor: 1_200, description: "Cash-flow workbook", fulfilment: "digital_file", idempotencyKey: idem() }));
    const token = crypto.randomBytes(32).toString("hex");
    await R.q(`UPDATE fleet.fleet_customer_orders SET access_token = $1 WHERE order_id = $2`, [token, co.order.orderId]);
    const other = await ok(R.econ(G, "channel.add", { ventureKey: "prints", name: "Instagram", kind: "social" }));
    expect(await pub("svc_attribute", ["order", token, other.channel.refCode])).toMatchObject({ ok: false, code: "FLEET_NOT_FOUND" });
    expect(await pub("svc_attribute", ["order", token, refCode])).toMatchObject({ ok: true });
    expect(await R.one(`(SELECT channel_id::text FROM fleet.fleet_customer_orders WHERE order_id = $1)`, [co.order.orderId])).toBe(channel);
    const capture = `CAP${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
    await cx("cx_paypal_checkout_update", ["custody-executor", co.checkout.checkoutId, "open", `ORD${crypto.randomBytes(5).toString("hex").toUpperCase()}`, "https://www.paypal.com/x", null]);
    expect((await cx("cx_paypal_capture_record", ["custody-executor", co.checkout.checkoutId, capture, "COMPLETED", 1_200, 60, "GBP", "capture_response"])).ok).toBe(true);
    const perf = await ok(R.econ(F, "business.performance", { ventureKey: "ledgers" }));
    expect(perf.channels.find((c: any) => c.channelId === channel)).toMatchObject({ name: "Etsy", ordersPaid: 1, ownPagesGrossMinor: 1_200,
      presence: { total: 1, live: 0, recordedCostMinor: 16 } });
    expect((await R.econ(F, "channel.link", { channelId: channel, offerId: crypto.randomUUID() })).code).toBe("FLEET_NOT_FOUND");
  });

  it("leads and obligations: a lawful basis and source are recorded; due work wakes the agent; a recurring obligation advances", async () => {
    expect((await R.econ(F, "lead.add", { ventureKey: "ledgers", name: "Studio Nine", contact: "hello@studio-nine.test" })).code).toBe("FLEET_BAD_REQUEST");
    const before = (await R.q(`SELECT fleet.fleet_agent_attention($1) AS a`, [F.id]))[0].a;
    const l = await ok(R.econ(F, "lead.add", { ventureKey: "ledgers", channelId: channel, organisation: "Studio Nine", contact: "hello@studio-nine.test", contactKind: "email",
      basis: "b2b_legitimate_interest", source: "the studio's public website lists bookkeeping as a pain point", valueMinor: 30_000,
      nextAction: "send a short note with the free template", nextActionAt: new Date(Date.now() - 60_000).toISOString() }));
    expect(l.lead).toMatchObject({ stage: "new", due: true });
    const ob = await ok(R.econ(F, "obligation.add", { ventureKey: "ledgers", title: "Monthly bookkeeping retainer for Studio Nine", recur: "monthly",
      dueAt: new Date(Date.now() - 3_600_000).toISOString(), leadId: l.lead.leadId }));
    const after = (await R.q(`SELECT fleet.fleet_agent_attention($1) AS a`, [F.id]))[0].a;
    expect(after.eventsDigest).not.toBe(before.eventsDigest);
    const kinds = after.recentEvents.map((e: any) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["lead_due", "obligation_due"]));
    const done = await ok(R.econ(F, "obligation.done", { obligationId: ob.obligation.obligationId }));
    expect(done.obligation).toMatchObject({ status: "open", recur: "monthly", doneCount: 1, due: false });
    expect(new Date(done.obligation.dueAt).getTime()).toBeGreaterThan(Date.now());
    expect((await ok(R.econ(F, "lead.list", { due: true }))).leads.length).toBe(1);
    expect((await R.econ(G, "lead.update", { leadId: l.lead.leadId, stage: "won" })).code).toBe("FLEET_NOT_FOUND");
    // Closed leads lose their personal data after the retention period (history kept).
    await ok(R.econ(F, "lead.update", { leadId: l.lead.leadId, stage: "lost" }));
    await R.q(`UPDATE fleet.fleet_leads SET closed_at = now() - interval '400 days' WHERE lead_id = $1`, [l.lead.leadId]);
    const erased = (await ok(R.econ(F, "lead.list", {}))).leads.find((x: any) => x.leadId === l.lead.leadId);
    expect(erased).toMatchObject({ contactErased: true, stage: "lost" });
    expect(erased.contact).toBeUndefined();
  });

  it("outreach is lawful, personal and identifiable, with an opt-out that holds across agents", async () => {
    await R.q(`SELECT fleet.fleet_admin_public_site_set('https://shop.fleet.test', NULL, $1)`, [OWNER]);
    // While sales are closed every outward action of an unreleased agent waits (the preparation hold) — outreach included.
    await R.q(`SELECT fleet.fleet_admin_sales_set(false, $1)`, [OWNER]);
    expect((await R.econ(F, "mail.send", { ventureKey: "ledgers", to: "x@studio-nine.test", subject: "s", body: "b", idempotencyKey: idem() })).code).toBe("FLEET_PREPARATION_HOLD");
    await R.q(`SELECT fleet.fleet_admin_sales_set(true, $1)`, [OWNER]);
    await ok(R.econ(F, "mailbox.provision", { ventureKey: "ledgers", idempotencyKey: idem() }));
    await broker.tick();
    const mail = (a: Record<string, unknown>) => R.econ(F, "mail.send", { ventureKey: "ledgers", subject: "A free cash-flow template for your studio", body: "Hello — …", idempotencyKey: idem(), ...a });
    expect((await mail({ to: "owner@studio-nine.test", outreach: true, basis: "b2b_legitimate_interest", recipientType: "business" })).code).toBe("FLEET_OUTREACH_IDENTITY");
    await R.q(`SELECT fleet.fleet_admin_seller_set($1::jsonb, $2)`, [JSON.stringify({ legalForm: "individual", legalName: "Test Owner", postalAddress: "1 Test Street, Testtown" }), OWNER]);
    expect((await mail({ to: "sam@example.test", outreach: true, basis: "b2b_legitimate_interest", recipientType: "individual" })).code).toBe("FLEET_OUTREACH_BASIS");
    expect((await mail({ to: ["a@studio-nine.test", "b@studio-nine.test"], outreach: true, basis: "b2b_legitimate_interest", recipientType: "business" })).code).toBe("FLEET_OUTREACH_ONE_RECIPIENT");
    expect((await mail({ to: "sam@example.test", outreach: true, basis: "existing_customer", recipientType: "individual" })).code).toBe("FLEET_OUTREACH_BASIS");
    const sent = await ok(mail({ to: "owner@studio-nine.test", outreach: true, basis: "b2b_legitimate_interest", recipientType: "business" }));
    const body = await R.one<string>(`(SELECT body FROM fleet.fleet_agent_mail WHERE message_id = $1)`, [sent.messageId]);
    expect(body).toContain("Sold by Test Owner.");
    const link = /https:\/\/shop\.fleet\.test\/u\/([0-9a-f]{64})/.exec(body);
    expect(link).not.toBeNull();
    // A link scanner's GET opts nobody out; the recipient's POST does — for every agent.
    expect(await pub("svc_outreach_optout", [link![1], false])).toMatchObject({ ok: true, optedOut: false });
    expect(await pub("svc_outreach_optout", [link![1], true])).toMatchObject({ ok: true, optedOut: true });
    expect((await mail({ to: "owner@studio-nine.test" })).code).toBe("FLEET_OUTREACH_SUPPRESSED");
    await ok(R.econ(G, "mailbox.provision", { ventureKey: "prints", idempotencyKey: idem() }));
    await broker.tick();
    expect((await R.econ(G, "mail.send", { to: "owner@studio-nine.test", subject: "Prints", body: "hi", idempotencyKey: idem() })).code).toBe("FLEET_OUTREACH_SUPPRESSED");
    expect(await ok(R.econ(G, "outreach.check", { address: "OWNER@studio-nine.test" }))).toMatchObject({ suppressed: true, contactedByYou: 0 });
    await ok(R.econ(F, "outreach.suppress", { address: "stop@example.test", reason: "requested" }));
    expect((await mail({ to: "stop@example.test" })).code).toBe("FLEET_OUTREACH_SUPPRESSED");
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_events WHERE event_type = 'outreach_opt_out')`))).toBe(1);
  });

  it("sales on other channels are memos; a payout is cash only against a real, unambiguous treasury PayPal credit", async () => {
    await ok(R.econ(F, "channel.update", { channelId: channel, payoutRoute: "treasury_paypal", payoutCounterparty: "Etsy" }));
    const s1 = await ok(R.econ(F, "sale.report", { channelId: channel, externalRef: "etsy-order-1001", occurredAt: new Date().toISOString(), currency: "GBP",
      grossMinor: 1_500, feeMinor: 140, evidence: "Etsy order 1001 (shop manager)" }));
    expect((await R.econ(F, "sale.report", { channelId: channel, externalRef: "etsy-order-1001", occurredAt: new Date().toISOString(), currency: "GBP", grossMinor: 1_500 })).code)
      .toBe("FLEET_SALE_DUPLICATE");
    const c0 = await cash(F);
    // The credit is not there yet: the claim waits; then PayPal shows it and the claim books on the next look.
    const pendingTxn = txnId();
    const p0 = await ok(R.econ(F, "payout.claim", { platformPayoutRef: "ETSY-PO-0001", channelId: channel, route: "treasury_paypal", paypalTransactionId: pendingTxn, amountMinor: 1_360, saleIds: [s1.sale.saleId] }));
    expect(p0.payout.status).toBe("pending_match");
    expect(await cash(F)).toBe(c0);
    const id = await credit(1_360, 45, "Etsy Ireland UC | Etsy payout");
    await R.q(`UPDATE fleet.fleet_channel_payouts SET paypal_transaction_id = $1 WHERE payout_id = $2`, [id, p0.payout.payoutId]);
    const listed = await ok(R.econ(F, "payout.list", {}));
    expect(listed.payouts[0]).toMatchObject({ status: "booked", amountMinor: 1_360, sales: 1 });
    expect(await cash(F)).toBe(c0 + 1_360 - 45);
    expect((await R.q(`SELECT status FROM fleet.fleet_channel_sales WHERE sale_id = $1`, [s1.sale.saleId]))[0].status).toBe("paid_out");
    expect((await R.q(`SELECT attributed_as FROM fleet.fleet_paypal_transactions WHERE transaction_id = $1`, [id]))[0].attributed_as).toBe("channel_payout");
    expect((await R.q(`SELECT fleet.fleet_ledger_verify() AS v`))[0].v).toMatchObject({ ok: true, unbalanced: 0 });
    // The same credit again: already attributed → the owner's decision, never a second booking.
    const dup = await ok(R.econ(F, "payout.claim", { platformPayoutRef: "ETSY-PO-0002", channelId: channel, route: "treasury_paypal", paypalTransactionId: id, amountMinor: 1_360 }));
    expect(dup.payout).toMatchObject({ status: "needs_owner", reason: expect.stringContaining("already attributed") });
    // A wrong amount, a payer that is not the channel's, and a payer two agents share all go to the owner.
    const wrong = await credit(900, 0, "Etsy Ireland UC");
    expect((await ok(R.econ(F, "payout.claim", { platformPayoutRef: "ETSY-PO-0003", channelId: channel, route: "treasury_paypal", paypalTransactionId: wrong, amountMinor: 950 }))).payout.status).toBe("needs_owner");
    const stranger = await credit(500, 0, "Someone Else Ltd");
    expect((await ok(R.econ(F, "payout.claim", { platformPayoutRef: "ETSY-PO-0004", channelId: channel, route: "treasury_paypal", paypalTransactionId: stranger, amountMinor: 500 }))).payout.reason).toMatch(/payer/);
    const gc = await ok(R.econ(G, "channel.add", { ventureKey: "prints", name: "Etsy", kind: "marketplace", payoutRoute: "treasury_paypal", payoutCounterparty: "Etsy" }));
    expect(gc.ok).toBe(true);
    const shared = await credit(700, 20, "Etsy Ireland UC");
    const amb = await ok(R.econ(F, "payout.claim", { platformPayoutRef: "ETSY-PO-0005", channelId: channel, route: "treasury_paypal", paypalTransactionId: shared, amountMinor: 700 }));
    expect(amb.payout).toMatchObject({ status: "needs_owner", reason: expect.stringContaining("another agent") });
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_events WHERE event_type = 'channel_payout_needs_owner')`))).toBe(4);
    // The owner books the ambiguous one (they know whose it is) and rejects the duplicate.
    const c1 = await cash(F);
    expect((await R.q(`SELECT fleet.fleet_admin_channel_payout_decide($1, 'book', $2, NULL, $3) AS r`, [amb.payout.payoutId, shared, OWNER]))[0].r).toMatchObject({ ok: true, status: "booked" });
    expect(await cash(F)).toBe(c1 + 680);
    expect((await R.q(`SELECT fleet.fleet_admin_channel_payout_decide($1, 'reject', NULL, 'duplicate', $2) AS r`, [dup.payout.payoutId, OWNER]))[0].r).toMatchObject({ status: "rejected" });
    // The same marketplace payout cannot be claimed twice.
    expect((await R.econ(F, "payout.claim", { platformPayoutRef: "etsy-po-0001", channelId: channel, route: "treasury_paypal", paypalTransactionId: txnId(), amountMinor: 1_360 })).code)
      .toBe("FLEET_PAYOUT_DUPLICATE");
    // A payout to the owner's bank: marketplace payout → bank statement line → treasury transfer, each linked once.
    const s2 = await ok(R.econ(F, "sale.report", { channelId: channel, externalRef: "etsy-order-1002", occurredAt: new Date().toISOString(), currency: "GBP", grossMinor: 1_300, feeMinor: 100 }));
    const s3 = await ok(R.econ(F, "sale.report", { channelId: channel, externalRef: "etsy-order-1003", occurredAt: new Date().toISOString(), currency: "GBP", grossMinor: 900, feeMinor: 100 }));
    const bank1 = await ok(R.econ(F, "payout.claim", { platformPayoutRef: "ETSY-PO-B1", platformPaidOn: "2026-10-14", channelId: channel, route: "owner_bank", amountMinor: 1_200, saleIds: [s2.sale.saleId] }));
    const bank2 = await ok(R.econ(F, "payout.claim", { platformPayoutRef: "ETSY-PO-B2", channelId: channel, route: "owner_bank", amountMinor: 800, saleIds: [s3.sale.saleId] }));
    expect(bank1.payout).toMatchObject({ status: "needs_owner", reason: expect.stringContaining("bank line"), salesNetByCurrency: { GBP: 1_200 } });
    const owner = (sql: string, args: unknown[]) => R.q(sql, args).then((r) => r[0].r, (e: Error) => e.message);
    // The transfer cannot book before each payout's bank line is recorded.
    const moved = await credit(2_000, 0, "Test Owner");
    expect(await owner(`SELECT fleet.fleet_admin_channel_payout_transfer($1, $2::uuid[], $3) AS r`, [moved, [bank1.payout.payoutId, bank2.payout.payoutId], OWNER])).toMatch(/FLEET_PAYOUT_EVIDENCE/);
    expect(await owner(`SELECT fleet.fleet_admin_channel_payout_bank($1, 'BACS ETSY 0001', '2026-10-15', 1300, $2) AS r`, [bank1.payout.payoutId, OWNER])).toMatch(/FLEET_PAYOUT_AMOUNT/);
    expect(await owner(`SELECT fleet.fleet_admin_channel_payout_bank($1, 'BACS ETSY 0001', '2026-10-15', 1200, $2) AS r`, [bank1.payout.payoutId, OWNER])).toMatchObject({ ok: true });
    expect(await owner(`SELECT fleet.fleet_admin_channel_payout_bank($1, 'bacs etsy 0001', '2026-10-15', 800, $2) AS r`, [bank2.payout.payoutId, OWNER])).toMatch(/FLEET_PAYOUT_BANK_USED/);
    expect(await owner(`SELECT fleet.fleet_admin_channel_payout_bank($1, 'BACS ETSY 0002', '2026-10-15', 800, $2) AS r`, [bank2.payout.payoutId, OWNER])).toMatchObject({ ok: true });
    // A bank payout never books through the treasury-credit path; the transfer must equal exactly what the bank lines received.
    expect(await owner(`SELECT fleet.fleet_admin_channel_payout_decide($1, 'book', $2, NULL, $3) AS r`, [bank1.payout.payoutId, moved, OWNER])).toMatch(/FLEET_PAYOUT_ROUTE/);
    expect(await owner(`SELECT fleet.fleet_admin_channel_payout_transfer($1, $2::uuid[], $3) AS r`, [moved, [bank1.payout.payoutId], OWNER])).toMatch(/FLEET_PAYOUT_AMOUNT/);
    const cBank = await cash(F);
    expect(await owner(`SELECT fleet.fleet_admin_channel_payout_transfer($1, $2::uuid[], $3) AS r`, [moved, [bank1.payout.payoutId, bank2.payout.payoutId], OWNER]))
      .toMatchObject({ ok: true, creditMinor: 2_000 });
    expect(await cash(F)).toBe(cBank + 2_000);
    // Each payout's revenue posted once; the credit is attributed once and can neither carry another payout nor back capital.
    expect(await owner(`SELECT fleet.fleet_admin_channel_payout_transfer($1, $2::uuid[], $3) AS r`, [moved, [bank1.payout.payoutId, bank2.payout.payoutId], OWNER])).toMatch(/FLEET_ALREADY_CLAIMED/);
    expect(await owner(`SELECT fleet.fleet_admin_capital_back($1, $2, 'T0000', $3) AS r`, [rail.railId, moved, OWNER])).toMatch(/FLEET_ALREADY_CLAIMED/);
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_revenue_claims WHERE claim_key LIKE 'chpayout:bank:%')`))).toBe(2);
    const linked = await R.q(`SELECT platform_payout_ref, bank_ref, transfer_txn, status FROM fleet.fleet_channel_payouts WHERE route = 'owner_bank' ORDER BY platform_payout_ref`);
    expect(linked).toEqual([{ platform_payout_ref: "ETSY-PO-B1", bank_ref: "BACS ETSY 0001", transfer_txn: moved, status: "booked" },
      { platform_payout_ref: "ETSY-PO-B2", bank_ref: "BACS ETSY 0002", transfer_txn: moved, status: "booked" }]);
    expect((await R.q(`SELECT status FROM fleet.fleet_channel_sales WHERE sale_id = ANY($1::uuid[]) ORDER BY 1`, [[s2.sale.saleId, s3.sale.saleId]])).map((x) => x.status)).toEqual(["paid_out", "paid_out"]);
    // Venture P&L: the payout fee is a processor fee, not "revenue" costs.
    const fin = (await ok(R.econ(F, "venture.status", { key: "ledgers" })));
    const f = fin.financials ?? fin.venture?.financials;
    expect(f.costsByCategory.processor_fee).toBeGreaterThanOrEqual(45 + 20);
    expect(f.costsByCategory.revenue).toBeUndefined();
    expect((await R.q(`SELECT fleet.fleet_ledger_verify() AS v`))[0].v).toMatchObject({ ok: true, unbalanced: 0 });
  });
});

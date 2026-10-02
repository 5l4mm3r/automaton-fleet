/**
 * Schema v41 — communications ready but DORMANT, the shared Fleet mailbox, cost-aware numbers (PostgreSQL + the identity
 * broker with SIMULATED providers; no real mailbox, number, account or money).
 *
 * Dormant: with no provider configured every mail / SMS action answers FLEET_CAPABILITY_NOT_CONFIGURED for that action
 * only, records the agent's capability dependency, and everything else continues. Activated: one shared mailbox, agents'
 * internal routing addresses, deterministic attribution (routing address → conversation → account awaiting verification →
 * correspondent), ambiguous or ownerless mail UNASSIGNED for Admin (authentication mail never guessed), From = the shared
 * address with Reply-To the agent's routing address. Numbers: a live quote first, the agent's own ceiling, the first
 * month charged from its cash through the ledger once the provider credit is recorded, usage charged per message, unpaid
 * numbers released, idle numbers flagged, dependencies guarded, a dead agent's numbers released. Provider secrets:
 * names only in the registry; Admin reveals through the broker.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { PgIdentityGateway } from "../../fleet/identity/gateway.js";
import { IdentityBroker } from "../../fleet/identity/broker.js";
import { SimulatedSharedMailProvider, SimulatedSmsProvider, type MailProvider, type SmsProvider } from "../../fleet/identity/providers.js";
import { initIdentityState, openIdentityState, openProviderVault } from "../../fleet/identity/main.js";
import { generateX25519, openSealed } from "../../fleet/identity/crypto.js";
import { auditPrivileges } from "../../fleet/postgres/privileges.js";

const PG_BIN = findPgBin();

describe.skipIf(!PG_BIN)("v41 communications: dormant by default, the shared mailbox, cost-aware numbers (PostgreSQL)", () => {
  let R: EconomyRegistry;
  let A: Founder;
  let B: Founder;
  let C: Founder;
  let dir: string;
  let gw: PgIdentityGateway;
  let svc: pg.Pool;
  const shared = new SimulatedSharedMailProvider("fleet@shared.fleet-mail.test");
  const sms = new SimulatedSmsProvider({ monthlyMinor: 115, currency: "USD", perMessageMicro: 7_900 });
  const idem = () => `id:${crypto.randomUUID()}`;
  const ok = async (p: Promise<Record<string, any>>) => {
    const r = await p;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return r;
  };
  const broker = (mail: MailProvider | null, numbers: SmsProvider | null) => {
    const { vault, ownerVault } = openIdentityState(dir);
    return new IdentityBroker(gw, vault, { mail, sms: numbers, ownerVault, providerVault: openProviderVault(dir), stateFile: path.join(dir, "pending.json") });
  };
  const status = () => R.one<any>(`fleet.fleet_admin_comms_status()`);
  const mailOf = (id: string) => R.q(`SELECT * FROM fleet.fleet_agent_mail WHERE message_id = $1`, [id]).then((r) => r[0]);
  const lastIn = (subject: string) => R.q(`SELECT * FROM fleet.fleet_agent_mail WHERE subject = $1 AND direction = 'in' ORDER BY received_at DESC`, [subject]);
  const tick = () => svc.query(`SELECT fleet.svc_comms_tick(50) AS r`).then((r) => r.rows[0].r);

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 3, allocationCents: 10_000 });
    [A, B, C] = R.founders;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-comms41-"));
    fs.chmodSync(dir, 0o700);
    initIdentityState(dir);
    gw = new PgIdentityGateway({ connectionString: R.pgc.identityUrl });
    await R.store.grantServiceRole();
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2 });
    await R.q(`SELECT fleet.fleet_fx_insert('USD', 'GBP', 790000, 'test rate', NULL, NULL, (now() AT TIME ZONE 'UTC')::date, 'operator:owner', false)`);
  }, 240_000);
  afterAll(async () => {
    await gw?.close(); await svc?.end(); await R?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("dormant: mail and SMS are NOT CONFIGURED; each action fails alone and records the need; nothing else is affected", async () => {
    await broker(null, null).tick();
    const st = await status();
    expect(st.mail).toMatchObject({ configured: false, state: "NOT_CONFIGURED", preferredProvider: "proton-bridge" });
    expect(st.sms).toMatchObject({ configured: false, state: "NOT_CONFIGURED", preferredProvider: "twilio", activeNumbers: 0 });
    for (const [op, args] of [["mailbox.provision", { purpose: "supplier quotes" }], ["mail.send", { to: "x@y.test", subject: "Hello", body: "b" }],
      ["phone.quote", { country: "GB", purpose: "customer line" }], ["phone.provision", { purpose: "customer line", quoteId: crypto.randomUUID(), numberType: "mobile", maxMonthlyMinor: 100 }]] as const) {
      const r = await R.econ(A, op, { ...args, idempotencyKey: idem() });
      expect(r, op).toMatchObject({ ok: false, code: "FLEET_CAPABILITY_NOT_CONFIGURED" });
      expect(r.note).toMatch(/not a failure/);
    }
    expect((await ok(R.econ(A, "mail.inbox", {}))).mailConfigured).toBe(false);
    expect((await ok(R.econ(A, "phone.list", {}))).smsConfigured).toBe(false);
    expect(await ok(R.econ(A, "venture.list", {}))).toMatchObject({ ok: true }); // everything else continues
    const d = (await status()).demands;
    expect(d.find((x: any) => x.capability === "mail")).toMatchObject({ agentId: A.id, attempts: 2, status: "open", purpose: "Hello" }); // the latest need
    expect(d.find((x: any) => x.capability === "sms")).toMatchObject({ agentId: A.id, attempts: 2, status: "open" });
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_events WHERE event_type = 'capability_dependency'`))[0].n).toBe(2);
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_identity_jobs`))[0].n).toBe(0); // nothing queued for a provider that does not exist
  });

  it("activated: one shared mailbox; routing addresses; From the shared address, Reply-To the agent; deterministic attribution", async () => {
    const b = broker(shared, sms);
    await b.tick();
    const st = await status();
    expect(st.mail).toMatchObject({ configured: true, channels: [expect.objectContaining({ provider: "sim-shared-mail", mode: "shared", address: shared.address })] });
    expect(st.demands.every((x: any) => x.status === "satisfied")).toBe(true);

    const ra = await ok(R.econ(A, "mailbox.provision", { idempotencyKey: idem() }));
    expect(ra.address).toMatch(/^fleet\+[0-9a-f]{10}@shared\.fleet-mail\.test$/);
    expect(ra.sharedAddress).toBe(shared.address);
    const rb = await ok(R.econ(B, "mailbox.provision", { idempotencyKey: idem() }));
    const rc = await ok(R.econ(C, "mailbox.provision", { idempotencyKey: idem() }));

    // 1. Addressed to A's routing address.
    shared.deliver({ from: "Sam <sam@customer.test>", to: [ra.address], subject: "Bulk order", body: "12 prints please" });
    await b.tick();
    const order = (await lastIn("Bulk order"))[0];
    expect(order).toMatchObject({ agent_id: A.id, routing: "recipient_tag", sender_address: "sam@customer.test" });
    const inboxA = (await ok(R.econ(A, "mail.inbox", {}))).messages;
    expect(inboxA.find((m: any) => m.subject === "Bulk order")).toMatchObject({ routing: "recipient_tag", mailbox: ra.address });

    // A replies: sent From the shared address, Reply-To A's routing address, a Fleet Message-ID, threaded.
    const sent = await ok(R.econ(A, "mail.send", { to: "sam@customer.test", subject: "Re: Bulk order", body: "Ships Friday.", inReplyTo: order.message_id, idempotencyKey: idem() }));
    expect(sent.note).toMatch(/From the Fleet's shared address/);
    await b.tick();
    const out = shared.outbox.at(-1)!;
    expect(out).toMatchObject({ from: shared.address, replyTo: ra.address, to: ["sam@customer.test"], subject: "Re: Bulk order" });
    expect(out.messageId).toMatch(/^<[0-9a-f-]{36}@shared\.fleet-mail\.test>$/);
    expect(out.references).toEqual([order.external_message_id]);
    const sentRow = await mailOf(sent.messageId);
    expect(sentRow).toMatchObject({ agent_id: A.id, send_status: "sent", external_message_id: out.messageId, thread_id: order.thread_id });

    // 2. The customer's reply, to the bare shared address, returns to A through the conversation.
    shared.deliver({ from: "sam@customer.test", to: [shared.address], subject: "Re: Re: Bulk order", body: "Great", inReplyTo: out.messageId, references: [out.messageId] });
    // 4. A new message (no reply headers) from Sam: an established correspondent of A only.
    shared.deliver({ from: "sam@customer.test", to: [shared.address], subject: "Another order", body: "6 more" });
    // 5. A stranger to the bare address: unassigned.
    shared.deliver({ from: "who@unknown.test", to: [shared.address], subject: "Partnership?", body: "Hello Fleet" });
    await b.tick();
    expect((await lastIn("Re: Re: Bulk order"))[0]).toMatchObject({ agent_id: A.id, routing: "thread", thread_id: order.thread_id });
    expect((await lastIn("Another order"))[0]).toMatchObject({ agent_id: A.id, routing: "correspondent" });
    const stranger = (await lastIn("Partnership?"))[0];
    expect(stranger).toMatchObject({ agent_id: null, routing: "unassigned" });
    expect(JSON.stringify((await ok(R.econ(B, "mail.inbox", {}))).messages)).not.toContain("Partnership?");

    // 3. Authentication mail: B is the only agent with an account awaiting verification on shop-b.example → B, withheld.
    const acct = crypto.randomUUID();
    await R.q(`INSERT INTO fleet.fleet_agent_accounts (account_id, agent_id, account_kind, platform, status, origins, login_email)
                 VALUES ($1, $2, 'marketplace', 'shop-b', 'pending_verification', ARRAY['https://www.shop-b.example'], $3)`, [acct, B.id, rb.address]);
    shared.deliver({ from: "no-reply@mail.shop-b.example", to: [shared.address], subject: "Your sign-in code", body: "Your verification code is 482913." });
    // ...and a code from a site nobody awaits: never guessed.
    shared.deliver({ from: "no-reply@bank.example", to: [shared.address], subject: "Your login code", body: "Your security code is 734211." });
    await b.tick();
    const code = (await lastIn("Your sign-in code"))[0];
    expect(code).toMatchObject({ agent_id: B.id, account_id: acct, routing: "awaiting_verification", withheld: true, platform: "shop-b" });
    expect(code.body).not.toContain("482913");
    expect((await R.q(`SELECT agent_id, address FROM fleet.fleet_auth_message_blobs WHERE message_id = $1`, [code.message_id]))[0])
      .toMatchObject({ agent_id: B.id, address: rb.address });
    const bank = (await lastIn("Your login code"))[0];
    expect(bank).toMatchObject({ agent_id: null, routing: "unassigned", withheld: true });
    expect(bank.routing_reason).toMatch(/never guessed/);

    // Ambiguity: a sender corresponding with two agents is not guessed.
    await ok(R.econ(C, "mail.send", { to: "sam@customer.test", subject: "Hello from C", body: "Hi Sam", idempotencyKey: idem() }));
    await b.tick();
    shared.deliver({ from: "sam@customer.test", to: [shared.address], subject: "Which of you?", body: "?" });
    await b.tick();
    expect((await lastIn("Which of you?"))[0]).toMatchObject({ agent_id: null, routing: "unassigned" });
    expect((await lastIn("Which of you?"))[0].routing_reason).toMatch(/several agents/);

    // Admin routes the unassigned stranger mail to C; C now sees it; the authentication blob of a routed code follows.
    expect(await ok(R.one(`fleet.fleet_admin_mail_assign($1, $2, NULL, NULL, $3)`, [stranger.message_id, C.id, OWNER]))).toMatchObject({ agentId: C.id });
    expect((await ok(R.econ(C, "mail.inbox", {}))).messages.find((m: any) => m.subject === "Partnership?")).toMatchObject({ routing: "admin", mailbox: rc.address });
    expect(await R.code(R.one(`fleet.fleet_admin_mail_assign($1, $2, NULL, NULL, $3)`, [stranger.message_id, B.id, OWNER]))).toBe("FLEET_INVALID_STATE");
    await R.one(`fleet.fleet_admin_mail_assign($1, $2, NULL, NULL, $3)`, [bank.message_id, A.id, OWNER]);
    expect((await R.q(`SELECT agent_id FROM fleet.fleet_auth_message_blobs WHERE message_id = $1`, [bank.message_id]))[0].agent_id).toBe(A.id);

    // Restart: a fresh broker (cursor lost) re-reads everything and records nothing twice.
    const before = (await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_agent_mail`))[0].n;
    await broker(shared, sms).tick();
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_agent_mail`))[0].n).toBe(before);

    // Admin views.
    const feed = await R.one<any[]>(`fleet.fleet_admin_mail_feed($1::jsonb)`, [JSON.stringify({ view: "unassigned" })]);
    expect(feed.map((m) => m.subject)).toContain("Which of you?");
    const thread = await R.one<any[]>(`fleet.fleet_admin_mail_feed($1::jsonb)`, [JSON.stringify({ view: "thread", threadId: order.thread_id })]);
    expect(thread.map((m) => m.subject).sort()).toEqual(["Bulk order", "Re: Bulk order", "Re: Re: Bulk order"]);
    const security = await R.one<any[]>(`fleet.fleet_admin_mail_feed($1::jsonb)`, [JSON.stringify({ view: "security" })]);
    expect(security.every((m) => m.authenticationMessage)).toBe(true);
    expect(JSON.stringify(security)).not.toMatch(/482913|734211/);

    // A dead agent's routing address no longer delivers to it.
    await R.store.markDead(C.id, "test death", "test", "reported");
    shared.deliver({ from: "late@customer.test", to: [rc.address], subject: "For C", body: "?" });
    await b.tick();
    expect((await lastIn("For C"))[0]).toMatchObject({ agent_id: null, routing: "unassigned" });

    // Provider outage: health degrades, then recovers.
    shared.down = true;
    await b.tick();
    const down = (await status()).mail.channels[0];
    expect(down).toMatchObject({ health: "degraded", lastError: "FLEET_MAIL_PROVIDER_CONNECT" });
    expect(down.consecutiveFailures).toBeGreaterThan(0);
    shared.down = false;
    await b.tick();
    expect((await status()).mail.channels[0]).toMatchObject({ health: "ok", consecutiveFailures: 0 });
  });

  it("numbers: a live quote, the agent's ceiling and cash; rental and usage charged through the ledger; unpaid / idle / in-use / dead", async () => {
    const b = broker(shared, sms);
    await b.tick();
    const quote = async (who: Founder) => {
      const q = await ok(R.econ(who, "phone.quote", { country: "GB", purpose: "customer line", idempotencyKey: idem() }));
      await b.tick();
      return (await ok(R.econ(who, "phone.quote", { quoteId: q.quoteId }))).quote;
    };
    const q = await quote(A);
    expect(q).toMatchObject({ status: "ready", providerCurrency: "USD", yourCashMinor: 10_000 });
    expect(q.options).toEqual(expect.arrayContaining([expect.objectContaining({ numberType: "mobile", monthlyMinor: 91, monthlyProvider: "1.15 USD" })]));
    expect(q.messaging.outbound_mobile).toEqual({ micro: 7_900, minor: 1 });
    // Above the agent's own ceiling: refused before anything is bought.
    expect((await R.econ(A, "phone.provision", { quoteId: q.quoteId, numberType: "mobile", maxMonthlyMinor: 90, purpose: "customer line", idempotencyKey: idem() })).code)
      .toBe("FLEET_PHONE_PRICE");
    // The price rose between quote and purchase: the broker does not buy above the ceiling.
    sms.monthlyMicro = 1_400_000;
    const risen = await ok(R.econ(A, "phone.provision", { quoteId: q.quoteId, numberType: "mobile", maxMonthlyMinor: 95, purpose: "customer line", idempotencyKey: idem() }));
    await b.tick();
    expect((await ok(R.econ(A, "phone.list"))).numbers.find((n: any) => n.numberId === risen.numberId)).toMatchObject({ status: "failed" });
    sms.monthlyMicro = 1_150_000;
    const p = await ok(R.econ(A, "phone.provision", { quoteId: q.quoteId, numberType: "mobile", maxMonthlyMinor: 95, purpose: "customer line", idempotencyKey: idem() }));
    await b.tick();
    const num = (await ok(R.econ(A, "phone.list"))).numbers.find((n: any) => n.numberId === p.numberId);
    expect(num).toMatchObject({ status: "active", numberType: "mobile", monthlyMinor: 91, reviewState: "ok" });

    // First month: due at once, but waits until the owner records the provider credit (the Fleet's prepaid balance).
    const cash = () => R.one<number>(`fleet.fleet_agent_cash($1)`, [A.id]).then(Number);
    expect(await tick()).toMatchObject({ charged: 0, unpaid: 1 });
    expect((await status()).sms.unpaidMinor).toBe(91);
    expect(await R.code(R.one(`fleet.fleet_admin_provider_credits_record(500, 'bad ref with spaces', NULL, $1)`, [OWNER]))).toBe("FLEET_BAD_REQUEST");
    await R.one(`fleet.fleet_admin_provider_credits_record(2000, $1, 'test top-up', $2)`, [`topup:${crypto.randomUUID()}`, OWNER]);
    const c0 = await cash();
    expect(await tick()).toMatchObject({ charged: 1 });
    expect(await cash()).toBe(c0 - 91);
    expect(await R.one<number>(`fleet.fleet_ledger_balance('fleet:provider_credits')`).then(Number)).toBe(2000 - 91);
    const due = (await R.q(`SELECT next_due_at > now() + interval '27 days' AS later FROM fleet.fleet_agent_commitments WHERE commitment_id = $1`, [num.commitmentId]))[0];
    expect(due.later).toBe(true);
    expect(await tick()).toMatchObject({ charged: 0 }); // not twice

    // Usage: an outbound SMS is priced by the provider and charged to the agent.
    await ok(R.econ(A, "sms.send", { numberId: p.numberId, to: "+447700900555", body: "Your order ships Friday", idempotencyKey: idem() }));
    await b.tick();
    await R.q(`UPDATE fleet.fleet_agent_sms SET at = now() - interval '2 minutes' WHERE number_id = $1`, [p.numberId]);
    await b.tick();
    const priced = (await R.q(`SELECT price_micro, price_currency, cost_minor, charge_status FROM fleet.fleet_agent_sms WHERE number_id = $1`, [p.numberId]))[0];
    expect(priced).toMatchObject({ price_micro: "7900", price_currency: "USD", cost_minor: "1", charge_status: "pending" });
    const c1 = await cash();
    await tick();
    expect(await cash()).toBe(c1 - 1);
    expect((await R.q(`SELECT charge_status FROM fleet.fleet_agent_sms WHERE number_id = $1`, [p.numberId]))[0].charge_status).toBe("charged");
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_ledger_journal WHERE kind = 'provider_usage_charge'`))[0].n).toBe(2);

    // An account that verified with this number: release is refused unless forced.
    const acct = crypto.randomUUID();
    await R.q(`INSERT INTO fleet.fleet_agent_accounts (account_id, agent_id, account_kind, platform, status) VALUES ($1, $2, 'marketplace', 'shop-a', 'active')`, [acct, A.id]);
    await R.q(`INSERT INTO fleet.fleet_phone_number_dependencies (number_id, account_id) VALUES ($1, $2)`, [p.numberId, acct]);
    expect((await ok(R.econ(A, "phone.list"))).numbers.find((n: any) => n.numberId === p.numberId).dependentAccounts).toHaveLength(1);
    expect((await R.econ(A, "phone.release", { numberId: p.numberId, idempotencyKey: idem() })).code).toBe("FLEET_PHONE_IN_USE");

    // Idle for 30 days: flagged for the agent's review (it decides).
    await R.q(`UPDATE fleet.fleet_agent_phone_numbers SET created_at = now() - interval '40 days' WHERE number_id = $1`, [p.numberId]);
    await R.q(`UPDATE fleet.fleet_agent_sms SET at = now() - interval '35 days' WHERE number_id = $1`, [p.numberId]);
    expect(await tick()).toMatchObject({ idle: 1 });
    expect((await ok(R.econ(A, "phone.list"))).numbers.find((n: any) => n.numberId === p.numberId)).toMatchObject({ reviewState: "idle", advice: expect.stringMatching(/release it/) });
    await ok(R.econ(A, "phone.release", { numberId: p.numberId, force: true, reason: "no longer useful", idempotencyKey: idem() }));
    await b.tick();
    expect((await ok(R.econ(A, "phone.list"))).numbers.find((n: any) => n.numberId === p.numberId).status).toBe("released");
    expect((await R.q(`SELECT status FROM fleet.fleet_agent_commitments WHERE commitment_id = $1`, [num.commitmentId]))[0].status).toBe("cancelled");

    // Unpaid: B cannot pay its rental; after 7 days unpaid the controller releases the number.
    const qb = await quote(B);
    const pb = await ok(R.econ(B, "phone.provision", { quoteId: qb.quoteId, numberType: "mobile", maxMonthlyMinor: 100, purpose: "customer line", idempotencyKey: idem() }));
    await b.tick();
    const cashB = await R.one<number>(`fleet.fleet_agent_cash($1)`, [B.id]).then(Number);
    await R.q(`SELECT fleet.fleet_admin_wallet_transfer($1, $2, 'treasury', 'test drain', $3, $4, true)`, [B.id, cashB, OWNER, idem()]);
    await tick();
    const nb = () => R.q(`SELECT status, review_state, payment_due_since FROM fleet.fleet_agent_phone_numbers WHERE number_id = $1`, [pb.numberId]).then((r) => r[0]);
    expect(await nb()).toMatchObject({ status: "active", review_state: "unpaid" });
    await R.q(`UPDATE fleet.fleet_agent_phone_numbers SET payment_due_since = now() - interval '8 days' WHERE number_id = $1`, [pb.numberId]);
    expect(await tick()).toMatchObject({ released: 1 });
    await b.tick();
    expect((await nb()).status).toBe("released");

    // A dead agent's numbers are released (no living heir depends on them).
    const qa = await quote(A);
    const pa = await ok(R.econ(A, "phone.provision", { quoteId: qa.quoteId, numberType: "mobile", maxMonthlyMinor: 100, purpose: "second line", idempotencyKey: idem() }));
    await b.tick();
    await R.store.markDead(A.id, "test death", "test", "reported");
    await tick();
    await b.tick();
    expect((await R.q(`SELECT status FROM fleet.fleet_agent_phone_numbers WHERE number_id = $1`, [pa.numberId]))[0].status).toBe("released");
    expect([...sms.numbers.values()].filter((n) => !n.released)).toHaveLength(0); // no abandoned number keeps costing
  });

  it("provider secrets: the registry knows names and fingerprints only; Admin reveals through the broker; the audit passes", async () => {
    const pv = openProviderVault(dir);
    const put = pv.put("twilio", { accountSid: `AC${"1".repeat(32)}`, apiKeySid: `SK${"2".repeat(32)}`, apiKeySecret: "s3cret-api-key-value-123" });
    const b = broker(shared, sms);
    await b.registerProviders();
    const st = await status();
    expect(st.providerSecrets).toEqual([expect.objectContaining({ name: "twilio", fields: ["accountSid", "apiKeySecret", "apiKeySid"], fingerprint: put.fingerprint, status: "present" })]);
    expect(JSON.stringify(st)).not.toContain("s3cret-api-key-value-123");
    const eph = generateX25519();
    const req = await R.one<any>(`fleet.fleet_admin_reveal_request('provider_secret', 'twilio', $1, 'webauthn:test-assertion-41', $2)`, [eph.publicKeyDer.toString("base64"), OWNER]);
    await b.tick();
    const took = await R.one<any>(`fleet.fleet_admin_reveal_take($1, $2)`, [req.requestId, OWNER]);
    const plain = JSON.parse(openSealed(eph.privateKeyDer, eph.publicKeyDer, Buffer.from(took.sealedB64, "base64"), `reveal:${req.requestId}`));
    expect(plain.apiKeySecret).toBe("s3cret-api-key-value-123");
    expect((await R.q(`SELECT kind, target FROM fleet.fleet_reveal_log WHERE request_id = $1 ORDER BY seq`, [req.requestId])).map((r) => `${r.kind}:${r.target}`))
      .toEqual(["provider_secret:twilio", "provider_secret:twilio", "provider_secret:twilio"]);
    expect(await R.code(R.one(`fleet.fleet_admin_reveal_request('provider_secret', 'proton-bridge', $1, 'webauthn:x-41', $2)`, [eph.publicKeyDer.toString("base64"), OWNER])))
      .toBe("FLEET_NOT_FOUND");
    // Removing the provider from the broker's configuration returns the capability to NOT CONFIGURED.
    await broker(null, null).registerProviders();
    expect((await status()).sms.state).toBe("NOT_CONFIGURED");
    expect((await auditPrivileges(R.owner, { schema: "fleet" })).problems).toEqual([]);
  });
});

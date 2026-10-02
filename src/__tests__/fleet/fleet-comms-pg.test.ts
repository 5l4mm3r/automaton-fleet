/**
 * Schema v36 — business mail, SMS, Admin reveal, owner vault upload, notification email (PostgreSQL + the identity broker
 * with SIMULATED providers; no real mail, number, account or identity).
 *
 * An agent reads its customers' mail whole and replies; an authentication message's link/code is withheld (the broker's);
 * delivery is idempotent across a broker restart. It provisions a number (the monthly fee becomes its own commitment,
 * converted at the Fleet FX rate), texts and is texted, and releases it (the commitment stops); a country needing an
 * account-holder bundle blocks that number only and notifies Admin (IDENTITY). Admin reveals an agent credential and an
 * owner fact through the broker (sealed to a one-time key, taken once, logged, expiring) and uploads an owner document
 * sealed to the broker's published key; the database keeps no plaintext and no sealed copy after installation.
 * Notifications reach Admin by email.
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
import { SimulatedMailProvider, SimulatedPlatform, SimulatedSmsProvider } from "../../fleet/identity/providers.js";
import { initIdentityState, openIdentityState } from "../../fleet/identity/main.js";
import { sealOwnerFact } from "../../fleet/identity/vaults.js";
import { generateX25519, openSealed } from "../../fleet/identity/crypto.js";
import { auditPrivileges } from "../../fleet/postgres/privileges.js";

const PG_BIN = findPgBin();

describe.skipIf(!PG_BIN)("v36 business mail, SMS, Admin reveal and owner vault upload (PostgreSQL)", () => {
  let R: EconomyRegistry;
  let A: Founder;
  let B: Founder;
  let dir: string;
  let gw: PgIdentityGateway;
  let broker: IdentityBroker;
  let svc: pg.Pool;
  let agentDb: pg.Pool;
  const mail = new SimulatedMailProvider();
  const sms = new SimulatedSmsProvider({ monthlyMinor: 115, currency: "USD" });
  const market = new SimulatedPlatform({ platform: "sim-market", mail });
  const ok = async (p: Promise<Record<string, any>>) => {
    const r = await p;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return r;
  };
  const idem = () => `id:${crypto.randomUUID()}`;
  const newBroker = () => {
    const { vault, ownerVault } = openIdentityState(dir);
    return new IdentityBroker(gw, vault, { mail, sms, connectors: [market], ownerVault, notifyFrom: "fleet@agents.fleet-mail.test",
      stateFile: path.join(dir, "pending.json") });
  };
  let address = "";

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000 });
    [A, B] = R.founders;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-comms-"));
    fs.chmodSync(dir, 0o700);
    initIdentityState(dir);
    gw = new PgIdentityGateway({ connectionString: R.pgc.identityUrl });
    broker = newBroker();
    await R.store.grantServiceRole();
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2 });
    agentDb = new pg.Pool({ connectionString: R.pgc.agentUrl, max: 1 });
    const box = await ok(R.econ(A, "mailbox.provision", { localPart: "maya", idempotencyKey: idem() }));
    await broker.tick();
    address = (await R.q(`SELECT address FROM fleet.fleet_agent_mailboxes WHERE account_id = $1`, [box.accountId]))[0].address;
  }, 240_000);
  afterAll(async () => {
    await gw?.close(); await svc?.end(); await agentDb?.end(); await R?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("business mail: whole customer content, replies, authentication codes withheld, idempotent across a restart", async () => {
    const body = "Hi Maya,\nI'd like 12 A4 prints shipped to 4 Example Road, Testtown TT1 2AB. My number is 07700 900123.\nOrder ref 55881.\n— Sam (sam@customer.test)";
    mail.deliver({ to: address, from: "sam@customer.test", subject: "Bulk order", body });
    mail.deliver({ to: address, from: "no-reply@sim-bank.test", subject: "Your login code", body: "Your security code is 734211. It expires in 10 minutes." });
    await broker.tick();
    const inbox = (await ok(R.econ(A, "mail.inbox", {}))).messages;
    const order = inbox.find((m: any) => m.subject === "Bulk order");
    expect(order).toMatchObject({ direction: "in", from: "sam@customer.test", authenticationMessage: false });
    const full = (await ok(R.econ(A, "mail.read", { messageId: order.messageId }))).message;
    expect(full.body).toBe(body); // address, phone, order reference: the agent's own business context, unredacted
    const code = inbox.find((m: any) => m.subject === "Your login code");
    expect(code.authenticationMessage).toBe(true);
    expect(code.preview).not.toContain("734211");
    // A restarted broker re-reads the provider and records nothing twice.
    broker = newBroker();
    await broker.tick();
    expect((await ok(R.econ(A, "mail.inbox", {}))).messages).toHaveLength(inbox.length);
    // Reply.
    const sent = await ok(R.econ(A, "mail.send", { from: address, to: "sam@customer.test", subject: "Re: Bulk order", body: "Hi Sam — yes, ships Friday.",
      inReplyTo: order.messageId, idempotencyKey: idem() }));
    await broker.tick();
    expect(mail.outbox.at(-1)).toMatchObject({ from: address, to: ["sam@customer.test"], subject: "Re: Bulk order" });
    const out = (await ok(R.econ(A, "mail.read", { messageId: sent.messageId }))).message;
    expect(out).toMatchObject({ direction: "out", sendStatus: "sent", inReplyTo: order.messageId });
    // Scope: B cannot send from A's mailbox or read A's mail.
    expect((await R.econ(B, "mail.send", { from: address, to: "x@y.test", subject: "s", body: "b", idempotencyKey: idem() })).code).toBe("FLEET_MAIL_MAILBOX");
    expect((await R.econ(B, "mail.read", { messageId: order.messageId })).code).toBe("FLEET_MAIL_NONE");
    expect((await R.econ(A, "mail.send", { from: address, to: "not an address", subject: "s", body: "b", idempotencyKey: idem() })).code).toBe("FLEET_BAD_REQUEST");
  });

  it("phones and SMS: a number becomes the agent's own commitment; texts both ways; release stops the cost; a bundle-gated country blocks one number only", async () => {
    await R.q(`SELECT fleet.fleet_fx_insert('USD', 'GBP', 790000, 'test rate', NULL, NULL, (now() AT TIME ZONE 'UTC')::date, 'operator:owner', false)`);
    const p = await ok(R.econ(A, "phone.provision", { country: "GB", purpose: "customer support line", idempotencyKey: idem() }));
    await broker.tick();
    const nums = (await ok(R.econ(A, "phone.list"))).numbers;
    const num = nums.find((n: any) => n.numberId === p.numberId);
    expect(num).toMatchObject({ status: "active", country: "GB" });
    const c = (await R.q(`SELECT amount_minor, period, status FROM fleet.fleet_agent_commitments WHERE commitment_id = $1`, [num.commitmentId]))[0];
    expect(c).toMatchObject({ amount_minor: "91", period: "monthly", status: "active" }); // $1.15 at 0.79
    sms.deliver(num.e164, "+447700900555", "Is the A4 print still available?");
    sms.deliver(num.e164, "Bank", "Your verification code is 991234");
    await broker.tick();
    const texts = (await ok(R.econ(A, "sms.inbox", {}))).messages;
    expect(texts.find((t: any) => t.counterparty === "+447700900555").body).toBe("Is the A4 print still available?");
    expect(texts.find((t: any) => t.counterparty === "Bank")).toMatchObject({ authenticationMessage: true });
    expect(JSON.stringify(texts)).not.toContain("991234");
    await ok(R.econ(A, "sms.send", { numberId: p.numberId, to: "+447700900555", body: "Yes — 3 left.", idempotencyKey: idem() }));
    await broker.tick();
    expect(sms.outbox.at(-1)).toMatchObject({ from: num.e164, to: "+447700900555", body: "Yes — 3 left." });
    await ok(R.econ(A, "phone.release", { numberId: p.numberId, idempotencyKey: idem() }));
    await broker.tick();
    expect((await ok(R.econ(A, "phone.list"))).numbers.find((n: any) => n.numberId === p.numberId).status).toBe("released");
    expect((await R.q(`SELECT status FROM fleet.fleet_agent_commitments WHERE commitment_id = $1`, [num.commitmentId]))[0].status).toBe("cancelled");
    // A country whose numbers need an account-holder bundle: that number only waits; Admin is told (IDENTITY).
    const x = await ok(R.econ(A, "phone.provision", { country: "XR", purpose: "regional line", idempotencyKey: idem() }));
    await broker.tick();
    expect((await ok(R.econ(A, "phone.list"))).numbers.find((n: any) => n.numberId === x.numberId).status).toBe("human_action_required");
    await svc.query(`SELECT fleet.svc_notify_tick()`);
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_notifications WHERE class = 'IDENTITY'`))[0].n).toBe(1);
    expect(await ok(R.econ(A, "venture.list", {}))).toMatchObject({ ok: true }); // everything else continues
  });

  it("Admin reveal: the broker seals the secret to a one-time key; taken once; logged; agents and late takers get nothing", async () => {
    const acc = await ok(R.econ(A, "account.create", { platform: "sim-market", kind: "marketplace", handle: "mayahart", idempotencyKey: idem() }));
    await broker.tick();
    await broker.tick();
    const cred = (await R.q(`SELECT credential_id FROM fleet.fleet_agent_account_credentials WHERE account_id = $1 AND status = 'active'`, [acc.accountId]))[0].credential_id;
    const password = market.accounts.get([...market.accounts.keys()].find((k) => market.accounts.get(k)!.handle === "mayahart")!)!.password;
    const eph = generateX25519();
    const req = await R.one<any>(`fleet.fleet_admin_reveal_request('agent_credential', $1, $2, 'webauthn:test-assertion-1', $3)`, [cred, eph.publicKeyDer.toString("base64"), OWNER]);
    expect((await R.one<any>(`fleet.fleet_admin_reveal_take($1, $2)`, [req.requestId, OWNER])).status).toBe("pending");
    await broker.tick();
    // Only the requesting Admin takes it, once.
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_reveal_take($1, 'operator:someone-else')`, [req.requestId]))).toBe("FLEET_NOT_FOUND");
    const t = await R.one<any>(`fleet.fleet_admin_reveal_take($1, $2)`, [req.requestId, OWNER]);
    expect(openSealed(eph.privateKeyDer, eph.publicKeyDer, Buffer.from(t.sealedB64, "base64"), `reveal:${req.requestId}`)).toBe(password);
    expect((await R.one<any>(`fleet.fleet_admin_reveal_take($1, $2)`, [req.requestId, OWNER])).code).toBe("FLEET_REVEAL_DELIVERED");
    expect((await R.q(`SELECT sealed FROM fleet.fleet_reveal_requests WHERE request_id = $1`, [req.requestId]))[0].sealed).toBeNull();
    const log = await R.one<any[]>(`fleet.fleet_admin_reveal_log(10)`);
    expect(log.filter((l) => l.request_id === req.requestId).map((l) => l.outcome).sort()).toEqual(["delivered", "requested", "served"]);
    // An unclaimed reveal expires and its sealed copy is erased.
    const r2 = await R.one<any>(`fleet.fleet_admin_reveal_request('agent_credential', $1, $2, 'webauthn:test-assertion-2', $3)`, [cred, eph.publicKeyDer.toString("base64"), OWNER]);
    await broker.tick();
    await R.q(`UPDATE fleet.fleet_reveal_requests SET expires_at = now() - interval '1 second' WHERE request_id = $1`, [r2.requestId]);
    expect((await R.one<any>(`fleet.fleet_admin_reveal_take($1, $2)`, [r2.requestId, OWNER])).code).toBe("FLEET_REVEAL_EXPIRED");
    expect((await R.q(`SELECT sealed, status FROM fleet.fleet_reveal_requests WHERE request_id = $1`, [r2.requestId]))[0]).toEqual({ sealed: null, status: "expired" });
    // Agents can neither request nor serve a reveal; an agent principal is never an Admin.
    expect(await R.code(agentDb.query(`SELECT fleet.fleet_admin_reveal_request('agent_credential', $1, $2, 'x:12345678', 'operator:owner')`, [cred, eph.publicKeyDer.toString("base64")]))).toBe("permission denied");
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_reveal_request('agent_credential', $1, $2, 'x:12345678', $3)`, [cred, eph.publicKeyDer.toString("base64"), `operator:${A.id}`]))).toBe("FLEET_SELF_APPROVAL");
    expect(JSON.stringify(await R.q(`SELECT jsonb_agg(detail) AS d FROM fleet.fleet_events`))).not.toContain(password);
  });

  it("owner vault upload: sealed at the dashboard to the published broker key, installed by the broker, never stored in the clear; revealable by Admin", async () => {
    const key = await R.one<any>(`fleet.fleet_admin_broker_owner_key()`);
    expect(key.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const pub = Buffer.from(key.ownerPub, "base64");
    const doc = JSON.stringify({ contentType: "image/png", dataB64: crypto.randomBytes(2048).toString("base64") });
    const up = await R.one<any>(`fleet.fleet_admin_owner_vault_upload('passport', $1, 'image/png', now() + interval '5 years', $2)`, [sealOwnerFact(pub, "passport", doc), OWNER]);
    const name = await R.one<any>(`fleet.fleet_admin_owner_vault_upload('legal_name', $1, 'text/plain', NULL, $2)`, [sealOwnerFact(pub, "legal_name", "Test Owner Synthetic"), OWNER]);
    // Sealed to some other key: refused at installation, nothing installed.
    const other = generateX25519();
    const bad = await R.one<any>(`fleet.fleet_admin_owner_vault_upload('date_of_birth', $1, 'text/plain', NULL, $2)`, [sealOwnerFact(other.publicKeyDer, "date_of_birth", "2000-01-01"), OWNER]);
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_owner_vault_upload('legal_name', '\\x00000000000000000000000000000000000000000000000000000000000000000000'::bytea, 'text/plain', NULL, $1)`, [OWNER])))
      .toBe("FLEET_BAD_REQUEST");
    await broker.tick();
    const rows = Object.fromEntries((await R.q(`SELECT upload_id, status, sealed FROM fleet.fleet_owner_vault_inbox`)).map((r) => [r.upload_id, r]));
    expect(rows[up.uploadId]).toMatchObject({ status: "installed", sealed: null });
    expect(rows[name.uploadId]).toMatchObject({ status: "installed", sealed: null });
    expect(rows[bad.uploadId]).toMatchObject({ status: "failed", sealed: null });
    const classes = (await R.q(`SELECT class_key FROM fleet.fleet_owner_identity_classes WHERE status = 'configured' ORDER BY 1`)).map((r) => r.class_key);
    expect(classes).toEqual(["legal_name", "passport"]);
    expect(fs.existsSync(path.join(dir, "owner-vault", "passport.sealed"))).toBe(true);
    // Admin reveals the owner's name (nothing is hidden from Admin); an agent never sees it.
    const eph = generateX25519();
    const r = await R.one<any>(`fleet.fleet_admin_reveal_request('owner_identity', 'legal_name', $1, 'webauthn:test-assertion-3', $2)`, [eph.publicKeyDer.toString("base64"), OWNER]);
    await broker.tick();
    const t = await R.one<any>(`fleet.fleet_admin_reveal_take($1, $2)`, [r.requestId, OWNER]);
    expect(openSealed(eph.privateKeyDer, eph.publicKeyDer, Buffer.from(t.sealedB64, "base64"), `reveal:${r.requestId}`)).toBe("Test Owner Synthetic");
    const everything = JSON.stringify(await R.q(`SELECT (SELECT jsonb_agg(detail) FROM fleet.fleet_events) e, (SELECT jsonb_agg(m) FROM fleet.fleet_agent_mail m) m,
      (SELECT jsonb_agg(j) FROM fleet.fleet_identity_jobs j) j`));
    expect(everything).not.toContain("Test Owner Synthetic");
  });

  it("notifications reach Admin by email from the Fleet address; the privilege audit passes", async () => {
    await R.q(`SELECT fleet.fleet_admin_notification_policy_set(0, 'owner@example.test', $1)`, [OWNER]);
    await svc.query(`SELECT fleet.svc_notify_tick()`);
    const before = mail.outbox.length;
    await broker.tick();
    const sent = mail.outbox.slice(before);
    expect(sent.some((m) => m.to[0] === "owner@example.test" && m.subject.startsWith("[Fleet DAILY]"))).toBe(true);
    expect(sent.some((m) => m.subject.startsWith("[Fleet IDENTITY]"))).toBe(true);
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_notifications WHERE emailed_at IS NULL`))[0].n).toBe(0);
    expect((await auditPrivileges(R.owner, { schema: "fleet", requireIdentityRoles: true })).problems).toEqual([]);
  });
});

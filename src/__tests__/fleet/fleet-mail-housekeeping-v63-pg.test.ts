/**
 * Schema v63 — the owner's mail housekeeping (PostgreSQL, the simulated shared mailbox; no network):
 *  • dismiss / restore hides messages from the owner's views (reversible; display state only);
 *  • delete permanently is an ordinary dashboard write (no step-up): it frees storage, removes the encrypted
 *    verification blob, keeps replies' threads, and records ONE permanent `mail_deleted` (counts, never content);
 *  • mail an agent still relies on is kept, with the reason: a message still being sent, a fresh verification code;
 *  • the hourly retention pass clears dismissed / unassigned mail after 30 days and verification codes after 7;
 *  • the privilege audit stays clean and `mail_deleted` routes to Fleet Command.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { PgIdentityGateway } from "../../fleet/identity/gateway.js";
import { IdentityBroker } from "../../fleet/identity/broker.js";
import { SimulatedSharedMailProvider } from "../../fleet/identity/providers.js";
import { initIdentityState, openIdentityState, openProviderVault } from "../../fleet/identity/main.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";

const PG_BIN = findPgBin();
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

describe.skipIf(!PG_BIN)("v63: dismiss, delete permanently and automatic clearing of stored mail (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let A: Founder;
  let dir = "";
  let gw: PgIdentityGateway;
  let svc: pg.Pool;
  let b: IdentityBroker;
  const shared = new SimulatedSharedMailProvider("fleet@shared.fleet-mail.test");
  const session = crypto.randomBytes(16).toString("hex");
  const dash = (op: string, args: object) =>
    R.one<Record<string, any>>(`fleet.dash_call($1, $2, $3, $4, NULL, 'test')`, [sha(session), sha("csrf"), op, JSON.stringify(args)]);
  const ok = async (op: string, args: object) => { const r = await dash(op, args); expect(r.ok, JSON.stringify(r)).toBe(true); return r.result; };
  const idem = () => `id:${crypto.randomUUID()}`;
  const bySubject = async (s: string) => (await R.q(`SELECT message_id FROM fleet.fleet_agent_mail WHERE subject = $1`, [s]))[0]?.message_id as string | undefined;
  const feed = (args: object) => ok("mail_feed", args) as Promise<Array<Record<string, any>>>;

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000 });
    [A] = R.founders;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-mail63-"));
    fs.chmodSync(dir, 0o700);
    initIdentityState(dir);
    gw = new PgIdentityGateway({ connectionString: R.pgc.identityUrl });
    await R.store.grantServiceRole();
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2 });
    const { vault, ownerVault } = openIdentityState(dir);
    b = new IdentityBroker(gw, vault, { mail: shared, ownerVault, providerVault: openProviderVault(dir), stateFile: path.join(dir, "pending.json") });
    await b.tick();
    await R.q(`INSERT INTO fleet.fleet_admin_passkeys (credential_id, public_key, name) VALUES ('v63_test_credential', decode(repeat('00', 40), 'hex'), 'test')`);
    await R.q(`INSERT INTO fleet.fleet_admin_sessions (session_sha, csrf_sha, credential_id, method, totp_ok, expires_at) VALUES ($1, $2, 'v63_test_credential', 'passkey', true, now() + interval '1 hour')`,
      [sha(session), sha("csrf")]);
  }, 300_000);
  afterAll(async () => {
    await gw?.close(); await svc?.end(); await R?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("migrates to v63 with a clean privilege audit; mail_deleted routes to Fleet Command", async () => {
    expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(63);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
    expect(await R.one(`fleet.fleet_event_route('mail_deleted', '{}'::jsonb)`)).toBe("P3_SUMMARY");
  });

  it("dismiss hides, restore brings back; the summary counts and sizes what is stored", async () => {
    shared.deliver({ from: "PayPal <service@paypal.co.uk>", to: [shared.address], subject: "You've got money", body: "A payment of £1.00 arrived." });
    shared.deliver({ from: "Proton <no-reply@notify.proton.me>", to: [shared.address], subject: "Welcome to Proton", body: "Welcome." });
    await b.tick();
    const pay = (await bySubject("You've got money"))!, welcome = (await bySubject("Welcome to Proton"))!;
    const s0 = await ok("mail_summary", {});
    expect(s0).toMatchObject({ total: 2, received: 2, unassigned: 2, dismissed: 0, retentionDays: 30, codeRetentionDays: 7 });
    expect(Number(s0.storedBytes)).toBeGreaterThan(0);

    expect(await ok("mail_dismiss", { messageIds: [pay] })).toMatchObject({ ok: true, dismissed: 1 });
    expect((await feed({ view: "all" })).map((m) => m.messageId)).toEqual([welcome]);
    expect((await feed({ view: "dismissed" }))).toEqual([expect.objectContaining({ messageId: pay, dismissedAt: expect.any(String) })]);
    expect(await ok("mail_dismiss", { messageIds: [pay], dismiss: false })).toMatchObject({ restored: 1 });
    expect((await feed({ view: "unassigned" })).map((m) => m.messageId).sort()).toEqual([pay, welcome].sort());
    expect((await dash("mail_dismiss", { messageIds: [] })).ok).toBe(false); // nothing chosen
  });

  it("delete permanently frees storage, keeps replies' threads, records one event; mail still in use is kept with its reason", async () => {
    const ra = (await R.econ(A, "mailbox.provision", { idempotencyKey: idem() })) as Record<string, any>;
    shared.deliver({ from: "Sam <sam@customer.test>", to: [ra.address], subject: "Bulk order", body: "12 prints please" });
    shared.deliver({ from: "Shop <no-reply@shop.test>", to: [ra.address], subject: "Your verification code", body: "Your verification code is 482913" });
    await b.tick();
    const order = (await bySubject("Bulk order"))!, code = (await bySubject("Your verification code"))!;
    const sent = (await R.econ(A, "mail.send", { to: "sam@customer.test", subject: "Re: Bulk order", body: "Ships Friday.", inReplyTo: order, idempotencyKey: idem() })) as Record<string, any>;
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    const reply = (await bySubject("Re: Bulk order"))!; // queued: the broker has not sent it yet

    const kept = await feed({ view: "all", agentId: A.id });
    expect(kept.find((m) => m.messageId === reply)?.keepReason).toBe("it is still being sent");
    expect(kept.find((m) => m.messageId === code)?.keepReason).toBe("an agent may still need its verification code");

    const pay = (await bySubject("You've got money"))!;
    const before = Number((await ok("mail_summary", {})).storedBytes);
    const r = await ok("mail_delete", { messageIds: [order, reply, code, pay] });
    expect(r).toMatchObject({ ok: true, deleted: 2 });
    expect(Number(r.freedBytes)).toBeGreaterThan(0);
    expect(r.kept.map((k: any) => k.reason).sort()).toEqual(["an agent may still need its verification code", "it is still being sent"]);
    expect(await bySubject("Bulk order")).toBeUndefined();
    expect(await bySubject("You've got money")).toBeUndefined();
    expect((await R.q(`SELECT in_reply_to FROM fleet.fleet_agent_mail WHERE message_id = $1`, [reply]))[0].in_reply_to).toBeNull(); // the reply stays
    expect(Number((await ok("mail_summary", {})).storedBytes)).toBe(before - Number(r.freedBytes));
    const ev = await R.q(`SELECT actor, detail FROM fleet.fleet_events WHERE event_type = 'mail_deleted'`);
    expect(ev).toEqual([{ actor: "operator:owner", detail: { count: 2, freedBytes: Number(r.freedBytes), kept: 2 } }]);
    expect(JSON.stringify(ev)).not.toMatch(/prints|Bulk order|money/); // counts, never content
    // Nothing deletable: no event.
    expect(await ok("mail_delete", { messageIds: [code] })).toMatchObject({ deleted: 0 });
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_events WHERE event_type = 'mail_deleted'`))[0].n).toBe(1);
    await b.tick(); // the broker sends the reply; it is no longer "being sent"
    expect((await feed({ view: "outbox" })).find((m) => m.messageId === reply)?.keepReason).toBeUndefined();
  });

  it("the hourly retention pass clears old dismissed / unassigned mail and old verification codes; recent mail stays", async () => {
    shared.deliver({ from: "Old <old@notice.test>", to: [shared.address], subject: "Old notice", body: "old" });
    shared.deliver({ from: "Fresh <fresh@notice.test>", to: [shared.address], subject: "Fresh notice", body: "fresh" });
    await b.tick();
    const old = (await bySubject("Old notice"))!, fresh = (await bySubject("Fresh notice"))!, code = (await bySubject("Your verification code"))!;
    await R.q(`UPDATE fleet.fleet_agent_mail SET received_at = now() - interval '31 days' WHERE message_id = $1`, [old]);
    await R.q(`UPDATE fleet.fleet_agent_mail SET received_at = now() - interval '8 days' WHERE message_id = $1`, [code]);
    const r = (await svc.query(`SELECT fleet.svc_event_retention() AS r`)).rows[0].r;
    expect(r.mailCleared).toBe(2);
    expect(await bySubject("Old notice")).toBeUndefined();
    expect(await bySubject("Your verification code")).toBeUndefined();
    expect(await bySubject("Fresh notice")).toBe(fresh);
    expect((await svc.query(`SELECT fleet.svc_event_retention() AS r`)).rows[0].r.mailCleared).toBe(0); // idempotent
  });
});

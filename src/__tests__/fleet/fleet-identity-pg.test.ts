/**
 * Schema v34 — agent-owned operational identity + owner identity broker (PostgreSQL, end to end; simulated providers only).
 *
 * Zero owner presence after infrastructure: an agent chooses its own name, creates a venture identity, provisions an
 * email address, creates a marketplace account (credentials generated and kept by the broker's vault), consumes the
 * verification email, operates the account, meets a provider that needs a verified real-world account holder (only that
 * verification becomes dependent), routes around it and keeps earning, survives a broker restart, and never receives
 * owner identity. A standing owner authorisation releases owner facts to a provider through the broker: the agent sees a
 * status only. Security: cross-agent scope, roles, duplicate mapping, revocation, recovery, provider failure, logs.
 * No real identity, account or provider is used.
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
import { SimulatedMailProvider, SimulatedPlatform } from "../../fleet/identity/providers.js";
import { initIdentityState, openIdentityState } from "../../fleet/identity/main.js";
import { sealOwnerFact } from "../../fleet/identity/vaults.js";
import { auditPrivileges } from "../../fleet/postgres/privileges.js";

const PG_BIN = findPgBin();
const OWNER_NAME = "Test Owner Synthetic";
const OWNER_ADDRESS = "1 Example Street, Testtown";

describe.skipIf(!PG_BIN)("v34 agent-owned identity and owner identity broker (PostgreSQL)", () => {
  let R: EconomyRegistry;
  let A: Founder;
  let B: Founder;
  let dir: string;
  let gw: PgIdentityGateway;
  let broker: IdentityBroker;
  let svc: pg.Pool;
  let agentDb: pg.Pool;
  const mail = new SimulatedMailProvider();
  const market = new SimulatedPlatform({ platform: "sim-market", mail });
  const verified = new SimulatedPlatform({ platform: "sim-verified", mail, identity: { kind: "brokered", classes: ["legal_name", "residential_address"] } });
  const verified2 = new SimulatedPlatform({ platform: "sim-verified2", mail, identity: { kind: "brokered", classes: ["legal_name"] } });
  const liveness = new SimulatedPlatform({ platform: "sim-liveness", mail, identity: { kind: "human_only", reason: "the provider requires a live selfie of the account holder" } });
  const down = new SimulatedPlatform({ platform: "sim-down", mail, down: true });
  const connectors = [market, verified, verified2, liveness, down];
  const ok = async (p: Promise<Record<string, any>>) => {
    const r = await p;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return r;
  };
  const idem = () => `id:${crypto.randomUUID()}`;
  const newBroker = () => {
    const { vault, ownerVault } = openIdentityState(dir);
    return new IdentityBroker(gw, vault, { mail, connectors, ownerVault, stateFile: path.join(dir, "pending.json") });
  };
  const account = async (who: Founder, id: string) => (await ok(R.econ(who, "account.status", { accountId: id }))).account;
  /** Everything an agent can see or the registry stores in text (events, jobs, mail, accounts) — scanned for secrets. */
  const registryText = async () => JSON.stringify(await R.q(`SELECT
      (SELECT jsonb_agg(detail) FROM fleet.fleet_events) AS events, (SELECT jsonb_agg(result) FROM fleet.fleet_identity_jobs) AS jobs,
      (SELECT jsonb_agg(params) FROM fleet.fleet_identity_jobs) AS params, (SELECT jsonb_agg(m) FROM fleet.fleet_agent_mail m) AS mail,
      (SELECT jsonb_agg(x) FROM fleet.fleet_agent_accounts x) AS accounts, (SELECT jsonb_agg(c) FROM fleet.fleet_agent_account_credentials c) AS creds,
      (SELECT jsonb_agg(r) FROM fleet.fleet_identity_releases r) AS releases, (SELECT jsonb_agg(o) FROM fleet.fleet_owner_requests o) AS deps`));
  const passwords = () => connectors.flatMap((c) => [...c.accounts.values()].map((a) => a.password));

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000 });
    [A, B] = R.founders;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-identity-"));
    fs.chmodSync(dir, 0o700);
    initIdentityState(dir);
    gw = new PgIdentityGateway({ connectionString: R.pgc.identityUrl });
    broker = newBroker();
    await broker.registerProviders(); // v41: the broker registers its providers (none = NOT CONFIGURED)
    await R.store.grantServiceRole();
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2 });
    agentDb = new pg.Pool({ connectionString: R.pgc.agentUrl, max: 1 });
  }, 240_000);
  afterAll(async () => {
    await gw?.close(); await svc?.end(); await agentDb?.end(); await R?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("zero-owner identity game: name, venture identity, email, account, verification, operation, a blocked verification routed around, revenue, restart", async () => {
    const before = await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_events WHERE actor LIKE 'operator:%'`);
    // 1-2. The agent chooses its own name and a venture identity.
    const persona = (await ok(R.econ(A, "identity.create", { kind: "persona", displayName: "Axiom", bio: "Builds small data tools." }))).identity;
    await ok(R.econ(A, "venture.create", { key: "axiom-data-tools", model: "software", offer: "data tools", state: "selected" }));
    const brand = (await ok(R.econ(A, "identity.create", { kind: "venture_identity", displayName: "Axiom Data Tools", ventureKey: "axiom-data-tools" }))).identity;
    // 3. Email.
    const mb = await ok(R.econ(A, "mailbox.provision", { localPart: "axiom", identityId: persona.identity_id, idempotencyKey: idem() }));
    expect(mb).toMatchObject({ status: "queued" });
    expect((await broker.tick()).outcomes).toEqual(["succeeded"]);
    expect(await account(A, mb.accountId)).toMatchObject({ kind: "email", status: "active", handle: "axiom@agents.fleet-mail.test" });
    // 4-6. A marketplace account: credentials in the broker's vault, verification email consumed by the broker.
    const acc = await ok(R.econ(A, "account.create", { platform: "sim-market", kind: "marketplace", handle: "axiomdata", identityId: brand.identity_id,
      ventureKey: "axiom-data-tools", mailboxAddress: "axiom@agents.fleet-mail.test", idempotencyKey: idem() }));
    expect((await broker.tick()).outcomes).toEqual(["succeeded"]);
    const a1 = await account(A, acc.accountId);
    expect(a1).toMatchObject({ status: "active", verification: "email_verified", credentialHealth: "ok", platform: "sim-market", handle: "axiomdata", venture: "axiom-data-tools" });
    expect((await R.q(`SELECT kind, status, vault_ref FROM fleet.fleet_agent_account_credentials WHERE account_id = $1`, [acc.accountId])))
      .toEqual([{ kind: "password", status: "active", vault_ref: expect.stringMatching(/^avault:/) }]);
    const inbox = (await ok(R.econ(A, "mail.inbox", {}))).messages;
    // v36: an account-authentication message — its link/code is the broker's (withheld); ordinary business mail is whole.
    expect(inbox).toEqual([expect.objectContaining({ subject: "Confirm your sim-market account", authenticationMessage: true, consumedByBroker: true })]);
    expect(inbox[0].preview).toContain("[link]");
    expect(inbox[0].preview).not.toMatch(/https?:|482913/);
    // 7. Operate it.
    const op = await ok(R.econ(A, "account.operate", { accountId: acc.accountId, action: "listing.create", params: { title: "CSV cleaner" }, idempotencyKey: idem() }));
    await broker.tick();
    expect((await ok(R.econ(A, "account.status", { accountId: acc.accountId }))).jobs[0]).toMatchObject({ jobId: op.jobId, status: "succeeded", result: { data: { listingId: "lst-1" } } });
    expect((await account(A, acc.accountId)).reputation).toEqual({ listings: 1 });
    // 8-9. A provider requiring a verified real-world account holder (no owner identity / consent configured): ONLY that verification waits.
    const vacc = await ok(R.econ(A, "account.create", { platform: "sim-verified", kind: "marketplace", handle: "axiom-verified", mailboxAddress: "axiom@agents.fleet-mail.test", idempotencyKey: idem() }));
    await broker.tick();
    await ok(R.econ(A, "account.verify_identity", { accountId: vacc.accountId, purpose: "seller_verification", idempotencyKey: idem() }));
    await broker.tick();
    expect(await account(A, vacc.accountId)).toMatchObject({ status: "human_action_required", verification: "identity_pending" });
    const deps = await R.q(`SELECT kind, blocks_action, status, action FROM fleet.fleet_owner_requests WHERE agent_id = $1`, [A.id]);
    expect(deps).toEqual([expect.objectContaining({ kind: "human_identity", blocks_action: true, status: "pending", action: expect.stringContaining("sim-verified") })]);
    // 10. It routes around: the other account keeps operating and the venture keeps earning.
    await ok(R.econ(A, "account.operate", { accountId: acc.accountId, action: "sale.simulate", params: {}, idempotencyKey: idem() }));
    expect((await broker.tick()).outcomes).toEqual(["succeeded"]);
    expect((await account(A, acc.accountId)).reputation).toMatchObject({ sales: 1 });
    const rail = (await R.one(`fleet.fleet_admin_rail_add('simulated', 'sim checkout', 'shared', NULL, ARRAY['receive_payments'], 'sim', NULL, 'simulated', NULL, NULL, $1)`, [OWNER])).railId;
    await ok(R.econ(A, "rail.require", { ventureKey: "axiom-data-tools", capability: "receive_payments" }));
    const venture = (await R.q(`SELECT venture_id FROM fleet.fleet_ventures WHERE agent_id = $1 AND venture_key = 'axiom-data-tools'`, [A.id]))[0].venture_id;
    const cash0 = Number((await R.one(`fleet.fleet_agent_economics($1)`, [A.id])).cash);
    const sale = (await svc.query(`SELECT fleet.svc_settlement_ingest($1, 'ord-ax-1', 'sale', 1500, 50, 'GBP', $2, now(), $3, $4) AS r`,
      [rail, venture, crypto.createHash("sha256").update("ax-1").digest("hex"), crypto.createHash("sha256").update("cust").digest("hex")])).rows[0].r;
    expect(sale).toMatchObject({ ok: true, status: "settled" });
    expect(Number((await R.one(`fleet.fleet_agent_economics($1)`, [A.id])).cash)).toBe(cash0 + 1450);
    // 11. Persistence across a broker restart (and across wakes: the registry is the record).
    broker = newBroker();
    await ok(R.econ(A, "account.operate", { accountId: acc.accountId, action: "profile.update", params: { bio: "v2" }, idempotencyKey: idem() }));
    expect((await broker.tick()).outcomes).toEqual(["succeeded"]);
    const listed = await ok(R.econ(A, "identity.list", {}));
    expect(listed.identities.map((i: { display_name: string }) => i.display_name).sort()).toEqual(["Axiom", "Axiom Data Tools"]);
    expect(listed.accounts).toHaveLength(3);
    // No owner action at any point after infrastructure (the rail).
    const ownerEvents = (await R.q(`SELECT event_type FROM fleet.fleet_events WHERE actor LIKE 'operator:%'`)).map((e) => e.event_type);
    expect(ownerEvents.length - before[0].n).toBe(1); // the rail registration only
    // 12. No secret and no owner identity anywhere an agent (or an ordinary log) can see.
    const text = await registryText();
    for (const pw of passwords()) expect(text).not.toContain(pw);
    expect(text).not.toContain(OWNER_NAME);
  });

  it("standing owner authorisation: owner facts reach the provider through the broker; the agent receives a status only; revocable", async () => {
    // The owner seals synthetic facts to the broker (it cannot read them back) and records metadata + a standing consent.
    const pub = Buffer.from(fs.readFileSync(path.join(dir, "owner.pub"), "utf8"), "base64");
    const { ownerVault } = openIdentityState(dir);
    ownerVault.install("legal_name", sealOwnerFact(pub, "legal_name", OWNER_NAME));
    ownerVault.install("residential_address", sealOwnerFact(pub, "residential_address", OWNER_ADDRESS));
    for (const c of ["legal_name", "residential_address"]) await R.one(`fleet.fleet_admin_owner_identity_class_set($1, $2, NULL, 'configured', $3)`, [c, `ovault:${c}`, OWNER]);
    const consent = await R.one(`fleet.fleet_admin_owner_identity_consent_set(ARRAY['seller_verification'], ARRAY['sim-verified2'], ARRAY['legal_name','residential_address'],
      'FleetControl may use my stored identity to verify legitimate accounts operated by Fleet agents on sim-verified2.', $1)`, [OWNER]);
    const acc = await ok(R.econ(B, "account.create", { platform: "sim-verified2", kind: "marketplace", handle: "b-shop", idempotencyKey: idem() }));
    await broker.tick();
    const v = await ok(R.econ(B, "account.verify_identity", { accountId: acc.accountId, purpose: "seller_verification", idempotencyKey: idem() }));
    await broker.tick();
    expect(await account(B, acc.accountId)).toMatchObject({ status: "active", verification: "identity_verified" });
    const job = (await ok(R.econ(B, "account.status", { accountId: acc.accountId }))).jobs.find((j: { jobId: string }) => j.jobId === v.jobId);
    expect(job).toMatchObject({ status: "succeeded", result: { status: "verified" } });
    // The provider got exactly the needed class; the release log records classes, never values.
    expect([...verified2.accounts.values()][0].factsSeen).toEqual(["legal_name"]);
    expect(await R.q(`SELECT provider, purpose, classes, outcome, consent_id FROM fleet.fleet_identity_releases WHERE agent_id = $1`, [B.id]))
      .toEqual([{ provider: "sim-verified2", purpose: "seller_verification", classes: ["legal_name"], outcome: "verified", consent_id: consent.consent_id }]);
    const text = await registryText();
    expect(text).not.toContain(OWNER_NAME);
    expect(text).not.toContain(OWNER_ADDRESS);
    // The Hub shows classes, consent and releases — no values.
    const hub = await R.one(`fleet.fleet_hub_identity(NULL)`);
    expect(hub.ownerVault).toMatchObject({ configured: true, classes: expect.arrayContaining([expect.objectContaining({ class: "legal_name", status: "configured" })]) });
    expect(JSON.stringify(hub)).not.toContain(OWNER_NAME);
    // Revocation: the next release is refused and becomes ONE human-action dependency for that account.
    await R.one(`fleet.fleet_admin_owner_identity_consent_revoke($1, $2)`, [consent.consent_id, OWNER]);
    const acc2 = await ok(R.econ(B, "account.create", { platform: "sim-verified2", kind: "marketplace", handle: "b-shop-2", idempotencyKey: idem() }));
    await broker.tick();
    await ok(R.econ(B, "account.verify_identity", { accountId: acc2.accountId, purpose: "seller_verification", idempotencyKey: idem() }));
    await broker.tick();
    expect(await account(B, acc2.accountId)).toMatchObject({ status: "human_action_required" });
    expect((await R.q(`SELECT outcome FROM fleet.fleet_identity_releases WHERE account_id = $1`, [acc2.accountId]))[0].outcome).toBe("no_consent");
    // A genuinely human-only act (liveness) is HUMAN_ACTION_REQUIRED even with consent.
    const l = await ok(R.econ(B, "account.create", { platform: "sim-liveness", kind: "marketplace", handle: "b-live", idempotencyKey: idem() }));
    await broker.tick();
    await ok(R.econ(B, "account.verify_identity", { accountId: l.accountId, purpose: "seller_verification", idempotencyKey: idem() }));
    await broker.tick();
    expect(await account(B, l.accountId)).toMatchObject({ status: "human_action_required", reason: expect.stringMatching(/live selfie/) });
  });

  it("security: scope, roles, duplicate mapping, revocation, recovery, provider failure, vault files, retired v11 release", async () => {
    const accA = (await R.q(`SELECT account_id FROM fleet.fleet_agent_accounts WHERE agent_id = $1 AND platform = 'sim-market'`, [A.id]))[0].account_id;
    // Another agent's account does not exist for B.
    expect(await R.econ(B, "account.status", { accountId: accA })).toMatchObject({ ok: false, code: "FLEET_NOT_FOUND" });
    expect(await R.econ(B, "account.operate", { accountId: accA, action: "listing.create", params: {}, idempotencyKey: idem() })).toMatchObject({ ok: false, code: "FLEET_NOT_FOUND" });
    // A duplicate/ambiguous platform mapping fails closed.
    expect(await R.econ(B, "account.create", { platform: "sim-market", kind: "marketplace", handle: "AxiomData", idempotencyKey: idem() })).toMatchObject({ ok: false, code: "FLEET_IDENTITY_TAKEN" });
    // Agents and the service role read none of the identity tables; the broker role reads none either (functions only).
    const idb = new pg.Pool({ connectionString: R.pgc.identityUrl, max: 1 });
    try {
      for (const t of ["fleet_agent_account_credentials", "fleet_owner_identity_classes", "fleet_owner_identity_consent", "fleet_identity_releases", "fleet_agent_mail", "fleet_identity_jobs"]) {
        for (const pool of [agentDb, svc, idb]) expect(await R.code(pool.query(`SELECT * FROM fleet.${t} LIMIT 1`)), t).toBe("permission denied");
      }
      expect(await R.code(agentDb.query(`SELECT fleet.ix_claim_job('w', repeat('a', 64))`))).toBe("permission denied");
      expect(await R.code(svc.query(`SELECT fleet.ix_identity_authorize(gen_random_uuid(), 'x', 'p', 'seller_verification', ARRAY['legal_name'])`))).toBe("permission denied");
      // The broker role cannot use another job's lease.
      expect(await R.code(idb.query(`SELECT fleet.ix_identity_authorize(gen_random_uuid(), 'x', 'p', 'seller_verification', ARRAY['legal_name'])`))).toBe("FLEET_LEASE_INVALID");
    } finally { await idb.end(); }
    // Vault: files 0600 in a 0700 directory; a blob bound to one account does not open for another.
    const refs = (await R.q(`SELECT vault_ref, agent_id, account_id FROM fleet.fleet_agent_account_credentials WHERE status = 'active'`));
    const file = path.join(dir, "agent-vault", `${refs[0].vault_ref.slice(7)}.bin`);
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe("600");
    expect((fs.statSync(path.join(dir, "agent-vault")).mode & 0o777).toString(8)).toBe("700");
    const { vault } = openIdentityState(dir);
    await expect(vault.withSecret(refs[0].vault_ref, { agentId: B.id, accountId: refs[0].account_id, kind: "password" }, async () => "x")).rejects.toThrow(/FLEET_CREDENTIAL_SCOPE/);
    // Revocation stops only this account's operations; the agent's mailbox and other accounts carry on.
    const ref0 = (await R.q(`SELECT vault_ref FROM fleet.fleet_agent_account_credentials WHERE account_id = $1 AND status = 'active'`, [accA]))[0].vault_ref;
    await ok(R.econ(A, "account.revoke", { accountId: accA, idempotencyKey: idem() }));
    expect(await R.econ(A, "account.operate", { accountId: accA, action: "listing.create", params: {}, idempotencyKey: idem() })).toMatchObject({ ok: false, code: "FLEET_CREDENTIAL_REVOKED" });
    await broker.tick();
    expect(fs.existsSync(path.join(dir, "agent-vault", `${ref0.slice(7)}.bin`))).toBe(false); // shredded
    await ok(R.econ(A, "identity.create", { kind: "brand", displayName: "Axiom Labs" }));
    // Recovery: a new credential through the account's mailbox, never shown to the agent.
    const rec = await ok(R.econ(A, "account.recover", { accountId: accA, idempotencyKey: idem() }));
    await broker.tick();
    expect((await ok(R.econ(A, "account.status", { accountId: accA }))).jobs.find((j: { jobId: string }) => j.jobId === rec.jobId)).toMatchObject({ status: "succeeded", result: { status: "recovered" } });
    expect((await account(A, accA)).credentialHealth).toBe("ok");
    await ok(R.econ(A, "account.operate", { accountId: accA, action: "listing.create", params: {}, idempotencyKey: idem() }));
    expect((await broker.tick()).outcomes).toEqual(["succeeded"]);
    // Provider failure fails only that job; the founder carries on.
    const d = await ok(R.econ(A, "account.create", { platform: "sim-down", kind: "service", handle: "axiom-down", idempotencyKey: idem() }));
    await broker.tick();
    expect(await account(A, d.accountId)).toMatchObject({ status: "failed" });
    // An unknown platform has no adapter: v56 refuses that one action at once (no job that can only fail), naming the
    // connectors the broker published and the working path (register_account + browser).
    const u = await R.econ(A, "account.create", { platform: "unknown-platform", kind: "social", handle: "axiom-social", idempotencyKey: idem() });
    expect(u).toMatchObject({ ok: false, code: "FLEET_NO_CONNECTOR" });
    expect(u.reason).toMatch(/connectors: sim-down, .*register_account/);
    expect(await ok(R.econ(A, "venture.list", {}))).toMatchObject({ ok: true });
    // v11's raw release of organisation identity is retired; nothing can store owner identity in the database.
    expect(await R.gw.identityFact(A.id, A.token, crypto.randomUUID())).toMatchObject({ ok: false, code: "FLEET_IDENTITY_BROKERED" });
    expect(await R.code(R.one(`fleet.fleet_org_identity_set('legal_name', 'x', 'public', $1)`, [OWNER]))).toBe("FLEET_OWNER_VAULT");
    // Nothing secret leaked into the registry; the privilege audit (identity role provisioned) is clean.
    const text = await registryText();
    for (const pw of passwords()) expect(text).not.toContain(pw);
    expect((await auditPrivileges(R.owner, { schema: "fleet", requireIdentityRoles: true })).problems).toEqual([]);
  });

  it("v35 estate transfer: a dead agent's account passes to another agent; the broker re-seals its credentials to the new owner", async () => {
    const accA = (await R.q(`SELECT account_id FROM fleet.fleet_agent_accounts WHERE platform = 'sim-market' AND handle = 'axiomdata'`))[0].account_id as string;
    const oldRefs = (await R.q(`SELECT vault_ref FROM fleet.fleet_agent_account_credentials WHERE account_id = $1 AND status = 'active'`, [accA])).map((x) => x.vault_ref as string);
    expect(oldRefs).toHaveLength(1);
    await R.store.markDead(A.id, "test death", "test", "reported");
    await svc.query(`SELECT fleet.svc_estate_tick(20)`);
    const item = (await R.q(`SELECT item_id FROM fleet.fleet_estate_items WHERE kind = 'account' AND ref_id = $1`, [accA]))[0].item_id;
    const claim = await ok(R.econ(B, "estate.claim", { itemId: item, reason: "an established marketplace account with reviews" }));
    expect((await broker.tick()).outcomes).toContain("succeeded");
    const job = (await R.q(`SELECT status, result FROM fleet.fleet_identity_jobs WHERE job_id = $1`, [claim.credentialRebindJob]))[0];
    expect(job).toMatchObject({ status: "succeeded", result: { status: "rebound", data: { credentials: 1 } } });
    const now = await R.q(`SELECT agent_id, vault_ref FROM fleet.fleet_agent_account_credentials WHERE account_id = $1 AND status = 'active'`, [accA]);
    expect(now).toHaveLength(1);
    expect(now[0].agent_id).toBe(B.id);
    expect(now[0].vault_ref).not.toBe(oldRefs[0]);
    expect(fs.existsSync(path.join(dir, "agent-vault", `${oldRefs[0].slice(7)}.bin`))).toBe(false);
    // The new owner operates the inherited account (the broker opens the re-sealed credential under B's scope).
    await ok(R.econ(B, "account.operate", { accountId: accA, action: "listing.create", params: { title: "inherited listing" }, idempotencyKey: idem() }));
    expect((await broker.tick()).outcomes).toEqual(["succeeded"]);
    const text = await registryText();
    for (const pw of passwords()) expect(text).not.toContain(pw);
  });
});

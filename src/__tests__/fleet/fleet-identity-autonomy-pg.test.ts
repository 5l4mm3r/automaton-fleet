/**
 * Schema v49 — standing identity authority, owner-fact and card fills, card holds, the agent footprint with freeze, and
 * PayPal credentials sealed to the custody executor (docs/design/master-launch-specification.md §§5, 7, 10.2).
 * PostgreSQL; the browser worker, identity broker and custody executor are their database roles, called directly.
 *
 * Proven here: nothing of the owner's is filled without the owner's standing authority (default off); with it, a fill is
 * served only on a pinned origin that is not excluded, only for an allowed and configured class, and the card only under an
 * open hold within the owner's and the wallet's limits; every release is logged and evented; the agent sees uses, never
 * values; a used hold cannot be voided — it is declared (booked as card clearing) or booked at its maximum by the reaper;
 * a frozen account serves nothing and the agent cannot unfreeze it; the footprint lists accounts with freeze links and the
 * agent's timeline; a credential sealed to the custody key is readable only by custody and disappears when revoked.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { liveRail } from "./fixtures/custody-signer.js";
import { generateX25519, sealTo } from "../../fleet/identity/crypto.js";
import { cardField, factField } from "../../fleet/identity/broker.js";
import { PgCustodyGateway } from "../../fleet/custody/gateway.js";
import { SealedCredentialVault, fingerprintOf } from "../../fleet/custody/sealed-vault.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";

const PG_BIN = findPgBin();
const SHOP = "https://shop.example.com";

describe.skipIf(!PG_BIN)("v49 identity autonomy, card holds, footprint and freeze, sealed custody credentials (PostgreSQL)", () => {
  let R: EconomyRegistry;
  let F: Founder;
  let browser: pg.Pool;
  let identity: pg.Pool;
  let custody: pg.Pool;
  let svc: pg.Pool;
  let su: pg.Pool;
  let account = "";
  const pub = generateX25519().publicKeyDer.toString("base64");
  const one = async (db: pg.Pool, sql: string, params: unknown[] = []) => (await db.query(`SELECT ${sql} AS r`, params)).rows[0].r;
  const events = async (type: string) => Number(await R.one(`(SELECT count(*) FROM fleet.fleet_events WHERE event_type = $1)`, [type]));
  /** Queue a browser action on the account session and claim it as the worker: → {actionId, lease}. */
  const claim = async () => {
    const o = await R.econ(F, "browser.open", { url: `${SHOP}/checkout`, accountId: account });
    expect(o.ok, JSON.stringify(o)).toBe(true);
    const lease = crypto.randomBytes(16).toString("hex");
    for (;;) {
      const c = await one(browser, `fleet.bx_claim_action('browser-worker', $1)`, [crypto.createHash("sha256").update(lease).digest("hex")]);
      expect(c.ok).toBe(true);
      if (c.action.actionId === o.actionId) return { actionId: o.actionId as string, lease, sessionId: o.sessionId as string };
      await one(browser, `fleet.bx_report_action($1, $2, true, '{}'::jsonb, NULL)`, [c.action.actionId, lease]);
    }
  };
  const ask = (a: { actionId: string; lease: string }, kind: string, origin = SHOP) =>
    one(browser, `fleet.bx_secret_request($1, $2, $3, $4, $5, NULL)`, [a.actionId, a.lease, kind, origin, pub]);
  const close = async (a: { actionId: string; lease: string; sessionId: string }) => {
    await one(browser, `fleet.bx_report_action($1, $2, true, '{}'::jsonb, NULL)`, [a.actionId, a.lease]);
    await R.econ(F, "browser.close", { sessionId: a.sessionId });
  };
  const autonomy = (o: { enabled?: boolean; classes?: string[]; card?: boolean; max?: number | null; daily?: number | null; excluded?: string[] } = {}) =>
    R.one(`fleet.fleet_admin_identity_autonomy_set($1, $2, $3, $4, $5, $6, 'agents may act without waiting for me', $7)`,
      [o.enabled ?? true, o.classes ?? ["residential_address", "legal_name"], o.card ?? false, o.max ?? null, o.daily ?? null, o.excluded ?? [], OWNER]);
  const configure = (cls: string) => R.one(`fleet.fleet_admin_owner_identity_class_set($1, $2, NULL, 'configured', $3)`, [cls, `ovault:${cls}`, OWNER]);

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000, simulatedSettlement: false });
    [F] = R.founders;
    for (const g of ["grantServiceRole", "grantBrowserRole", "grantIdentityRole", "grantCustodyRole"] as const) await R.store[g]();
    browser = new pg.Pool({ connectionString: R.pgc.browserUrl, max: 2 });
    identity = new pg.Pool({ connectionString: R.pgc.identityUrl, max: 2 });
    custody = new pg.Pool({ connectionString: R.pgc.custodyUrl, max: 2 });
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2 });
    su = new pg.Pool({ connectionString: R.pgc.superUrl.replace(/\/postgres$/, "/fleet_t"), max: 1 });
    const reg = await R.econ(F, "account.register", { platform: "shop.example.com", kind: "service", origin: SHOP, handle: "fnd-shop" });
    expect(reg.ok, JSON.stringify(reg)).toBe(true);
    account = reg.accountId;
  }, 240_000);
  afterAll(async () => { for (const p of [browser, identity, custody, svc, su]) await p?.end(); await R?.close(); });

  it("migrates with a clean audit; the standing authority is off by default and nothing of the owner's is filled", async () => {
    expect(await R.one(`(SELECT max(version) FROM fleet.fleet_schema_migrations)`)).toBe(FLEET_PG_SCHEMA_VERSION);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
    expect(await R.one(`fleet.fleet_identity_autonomy_json()`)).toMatchObject({ enabled: false, cardEnabled: false, classes: [] });
    await configure("residential_address");
    const a = await claim();
    expect(await ask(a, "owner_fact:residential_address:postcode")).toMatchObject({ ok: false, code: "FLEET_NO_STANDING_AUTHORITY" });
    expect(await events("identity_fill_refused")).toBe(1);
    // The step grammar names a class / field, never a value; documents are never fillable.
    const bad = await R.econ(F, "browser.act", { sessionId: a.sessionId, steps: [{ action: "fill", selector: "#x", credential: "owner_fact", class: "passport" }] });
    expect(bad).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" });
    await close(a);
  });

  it("with the authority, an allowed, configured class is served on a pinned, non-excluded origin — logged, evented, never shown", async () => {
    await autonomy({ excluded: ["https://blocked.example.com"] });
    const a = await claim();
    const r = await ask(a, "owner_fact:residential_address:postcode");
    expect(r).toMatchObject({ ok: true });
    expect(await ask(a, "owner_fact:legal_name")).toMatchObject({ ok: false, code: "FLEET_OWNER_FACT_UNAVAILABLE" }); // allowed, not on file
    expect(await ask(a, "owner_fact:tax_identifier")).toMatchObject({ ok: false, code: "FLEET_NO_STANDING_AUTHORITY" }); // on file? not allowed
    expect(await ask(a, "owner_fact:residential_address", "https://evil.example.com")).toMatchObject({ ok: false, code: "FLEET_ORIGIN_NOT_PINNED" });
    // The broker sees the class and field to serve; the agent's own view lists the use without any value.
    const pending = await one(identity, `fleet.ix_browser_secrets_pending('identity-broker')`);
    expect(pending.find((p: any) => p.requestId === r.requestId)).toMatchObject({ kind: "owner_fact", ownerClass: "residential_address", ownerField: "postcode" });
    const mine = await R.econ(F, "identity.uses");
    expect(mine.uses[0]).toMatchObject({ class: "residential_address", field: "postcode", origin: SHOP, accountId: account });
    expect(JSON.stringify(mine)).not.toMatch(/ovault|sealed/);
    expect(await events("owner_identity_used")).toBe(1);
    expect(await R.code(R.q(`DELETE FROM fleet.fleet_identity_uses`))).toBe("FLEET_HISTORY_IMMUTABLE");
    await close(a);
  });

  it("the card is filled only under an open hold within the owner's and the wallet's limits; a used hold is declared, never voided", async () => {
    await configure("payment_card");
    const a = await claim();
    expect(await ask(a, "owner_card:number")).toMatchObject({ ok: false, code: "FLEET_NO_STANDING_AUTHORITY" });
    await autonomy({ card: true, max: 5_000, daily: 8_000 });
    expect(await ask(a, "owner_card:number")).toMatchObject({ ok: false, code: "FLEET_CARD_HOLD_REQUIRED" });
    expect((await R.econ(F, "card.authorize", { accountId: account, merchant: "Shop Ltd", maxMinor: 5_001 })).code).toBe("FLEET_CARD_LIMIT");
    await R.one(`fleet.fleet_admin_wallet_limits_set($1, NULL, NULL, 3_000, NULL, 'card pilot', $2)`, [F.id, OWNER]);
    expect((await R.econ(F, "card.authorize", { accountId: account, merchant: "Shop Ltd", maxMinor: 3_001 })).code).toBe("FLEET_CARD_LIMIT");
    const cashBeforeHold = await R.balance(`agent:${F.id}:cash`);
    const h = await R.econ(F, "card.authorize", { accountId: account, merchant: "Shop Ltd", maxMinor: 3_000, purpose: "hosting plan" });
    expect(h).toMatchObject({ ok: true, charge: { status: "held", holdMaxMinor: 3_000, origin: SHOP, funding: "own", reservedMinor: 3_000 } });
    // v51: the hold reserves its maximum from the agent's own capital before the card can be filled.
    expect(await R.balance(`agent:${F.id}:cash`)).toBe(cashBeforeHold - 3_000);
    expect((await R.econ(F, "card.authorize", { accountId: account, merchant: "Shop Ltd", maxMinor: 100 })).code).toBe("FLEET_CARD_HOLD_OPEN");
    const served = await ask(a, "owner_card:number");
    expect(served).toMatchObject({ ok: true });
    expect((await R.q(`SELECT charge_id FROM fleet.fleet_browser_secret_requests WHERE request_id = $1`, [served.requestId]))[0].charge_id).toBe(h.charge.chargeId);
    await close(a);
    expect((await R.econ(F, "card.void", { chargeId: h.charge.chargeId })).code).toBe("FLEET_CARD_USED");
    expect((await R.econ(F, "card.declare", { chargeId: h.charge.chargeId, amountMinor: 3_001 })).code).toBe("FLEET_CARD_OVER_HOLD");
    const d = await R.econ(F, "card.declare", { chargeId: h.charge.chargeId, amountMinor: 1_200 });
    expect(d).toMatchObject({ ok: true, charge: { status: "booked", amountMinor: 1_200, fromYourCashMinor: 1_200 } });
    // Booked from the reservation; the unused 1 800 came back.
    expect(await R.balance(`agent:${F.id}:cash`)).toBe(cashBeforeHold - 1_200);
    expect(await R.balance("fleet:card:payable")).toBe(1_200);
    // An unused hold is voided by the agent; a used, undeclared one is booked at its maximum by the reaper.
    const h2 = await R.econ(F, "card.authorize", { accountId: account, merchant: "Other", maxMinor: 500 });
    expect((await R.econ(F, "card.void", { chargeId: h2.charge.chargeId })).charge.status).toBe("void");
    const h3 = await R.econ(F, "card.authorize", { accountId: account, merchant: "Third", maxMinor: 700 });
    const b = await claim();
    expect(await ask(b, "owner_card:cvc")).toMatchObject({ ok: true });
    await close(b);
    const c = await su.connect();
    try { await c.query("SET session_replication_role = replica"); await c.query(`UPDATE fleet.fleet_card_charges SET declare_by = now() - interval '1 minute' WHERE charge_id = $1`, [h3.charge.chargeId]); }
    finally { c.release(); }
    expect((await svc.query(`SELECT fleet.svc_card_holds_expire(50) AS r`)).rows[0].r).toMatchObject({ bookedAtMaximum: 1, voided: 0 });
    expect(await R.balance("fleet:card:payable")).toBe(1_900);
    expect(await events("card_hold_booked_at_maximum")).toBe(1);
    expect(await R.one(`fleet.fleet_event_route('card_hold_booked_at_maximum', '{}'::jsonb)`)).toBe("P1_HIGH");
    // The card is never fillable once the authority is withdrawn.
    await autonomy({ card: false });
    expect((await R.econ(F, "card.authorize", { accountId: account, merchant: "Shop Ltd", maxMinor: 100 })).code).toBe("FLEET_NO_STANDING_AUTHORITY");
  });

  it("a frozen account serves nothing, opens no session and cannot be changed by the agent; the owner unfreezes it", async () => {
    expect((await R.one(`fleet.fleet_admin_account_freeze($1, 'suspicious activity', $2)`, [account, OWNER])).ok).toBe(true);
    expect(await events("account_frozen")).toBe(1);
    expect((await R.econ(F, "browser.open", { url: `${SHOP}/`, accountId: account })).code).toBe("FLEET_ACCOUNT_FROZEN");
    expect((await R.econ(F, "account.mark", { accountId: account, status: "active" })).code).toBe("FLEET_ACCOUNT_FROZEN");
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_browser_sessions WHERE account_id = $1 AND status = 'open'`, [account]))[0].n).toBe(0);
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_account_unfreeze($1, 'banned', $2)`, [account, OWNER]))).toBe("FLEET_BAD_REQUEST");
    expect((await R.one(`fleet.fleet_admin_account_unfreeze($1, 'active', $2)`, [account, OWNER])).status).toBe("active");
    const a = await claim();
    expect(await ask(a, "owner_fact:residential_address:postcode")).toMatchObject({ ok: true });
    await close(a);
  });

  it("the footprint lists the agent's accounts with freeze links, mailboxes and a clickable timeline (uses, card, browser)", async () => {
    const fp = await R.one(`fleet.fleet_agent_footprint($1, 200)`, [F.id]);
    expect(fp.accounts[0]).toMatchObject({ accountId: account, platform: "shop.example.com", freezeUrl: SHOP, origins: [SHOP], status: "active" });
    const kinds = new Set(fp.timeline.map((t: any) => t.kind));
    for (const k of ["browser", "identity_use", "card", "event"]) expect(kinds.has(k), k).toBe(true);
    const step = fp.timeline.find((t: any) => t.kind === "browser" && t.detail.url);
    expect(step.detail.url).toBe(`${SHOP}/checkout`);
    expect(JSON.stringify(fp)).not.toMatch(/avault:|ovault:/);
    expect(await R.one(`fleet.fleet_identity_uses_json(NULL, 10)`)).toEqual(expect.arrayContaining([expect.objectContaining({ class: "payment_card" })]));
  });

  it("a PayPal credential sealed to the published custody key is readable only by custody; revoking removes it; webhook ids are rail facts", async () => {
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_custody_credential_upload('vault:paypal/treasury', '\\x00'::bytea, $1)`, [OWNER]))).toBe("FLEET_CUSTODY_KEY_UNAVAILABLE");
    const key = generateX25519();
    const gw = new PgCustodyGateway({ connectionString: R.pgc.custodyUrl });
    try {
      const vault = new SealedCredentialVault(gw, key);
      await vault.publish();
      const k = await R.one(`fleet.fleet_custody_key_json()`);
      expect(k).toMatchObject({ fingerprint: fingerprintOf(key.publicKeyDer), publicKey: key.publicKeyDer.toString("base64") });
      const sealed = sealTo(Buffer.from(k.publicKey, "base64"), "client-id:client-secret", "custody:vault:paypal/treasury");
      expect((await R.one(`fleet.fleet_admin_custody_credential_upload('vault:paypal/treasury', $1, $2)`, [sealed, OWNER])).ok).toBe(true);
      expect(await vault.refresh()).toBe(1);
      expect(await vault.resolve("vault:paypal/treasury")).toBe("client-id:client-secret");
      // Nothing but ciphertext is in the registry; the owner sees status only.
      expect(JSON.stringify(await R.one(`fleet.fleet_custody_key_json()`))).not.toContain("client-secret");
      await R.one(`fleet.fleet_admin_custody_credential_revoke('vault:paypal/treasury', $1)`, [OWNER]);
      expect(await vault.refresh()).toBe(0);
      expect(await vault.resolve("vault:paypal/treasury")).toBeNull();
      // Agents and the service role reach none of it.
      const agentDb = new pg.Pool({ connectionString: R.pgc.agentUrl, max: 1 });
      try {
        expect(await R.code(agentDb.query(`SELECT fleet.cx_sealed_credentials('x-worker')`))).toBe("permission denied");
        expect(await R.code(agentDb.query(`SELECT * FROM fleet.fleet_custody_sealed_credentials`))).toBe("permission denied");
      } finally { await agentDb.end(); }
      expect(await R.code(svc.query(`SELECT fleet.cx_sealed_credentials('x-worker')`))).toBe("permission denied");
      // The webhook id is a non-secret property of the PayPal rail, served to custody with it.
      const rail = await liveRail(R.owner, "fleet", OWNER);
      await R.one(`fleet.fleet_admin_rail_webhook_set($1, 'WH1234567890ABCD', $2)`, [rail.railId, OWNER]);
      const rails = await one(custody, `fleet.cx_paypal_rails('custody-executor')`);
      expect(rails.find((r: any) => r.railId === rail.railId)).toMatchObject({ webhookId: "WH1234567890ABCD" });
    } finally { await gw.close(); }
  });

  it("the broker extracts exactly the named field of a fact or card, and nothing else", () => {
    expect(factField("1 High St, Leeds LS1 1AA", null)).toBe("1 High St, Leeds LS1 1AA");
    expect(factField("1 High St", "postcode")).toBeNull();
    expect(factField(JSON.stringify({ line1: "1 High St", postcode: "LS1 1AA" }), "postcode")).toBe("LS1 1AA");
    expect(factField(JSON.stringify({ line1: "1 High St" }), null)).toBeNull();
    const card = JSON.stringify({ number: "4111 1111 1111 1111", expMonth: 3, expYear: 2029, cvc: "123", name: "A Owner", postcode: "LS1 1AA" });
    expect([cardField(card, "number"), cardField(card, "expiry"), cardField(card, "exp_month"), cardField(card, "exp_year"), cardField(card, "cvc"), cardField(card, "other")])
      .toEqual(["4111111111111111", "03/29", "03", "2029", "123", null]);
  });

  it("the audit stays clean; the ledger verifies", async () => {
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
    expect((await R.one(`fleet.fleet_ledger_verify()`)).ok).toBe(true);
  });
});

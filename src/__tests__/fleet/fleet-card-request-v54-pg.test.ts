/**
 * Schema v54 — the owner's card rule: PayPal first; the card is the last option, by request. PostgreSQL.
 *
 * Proven here:
 *  - no hold without an approved request; a request names why PayPal cannot pay and what the purchase is for;
 *  - "payouts unavailable" is refused while the treasury can pay out through PayPal;
 *  - the card is limited to the agent's own wallet (or its envelope) — never an open pool;
 *  - up to the owner's threshold (default £100) Fleet Control approves at once; above it the owner decides, approving only
 *    with the reference of the treasury → card transfer; the hold must match the approved site, account and amount, and
 *    uses the request up;
 *  - a pre-funded request's transfer becomes the card repayment of its charge once booked (never asked for twice);
 *  - unused requests expire (a funded one tells the owner the money is still on the card); terms are immutable.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";

const PG_BIN = findPgBin();
const SHOP = "https://shop.example.com";

describe.skipIf(!PG_BIN)("v54: card requests — PayPal first, the card last (PostgreSQL)", () => {
  let R: EconomyRegistry;
  let F: Founder;
  let svc: pg.Pool;
  let su: pg.Pool;
  let account = "";
  const events = async (type: string) => Number((await R.q(`SELECT count(*) AS n FROM fleet.fleet_events WHERE event_type = $1`, [type]))[0].n);
  const ask = (args: Record<string, unknown>) => R.econ(F, "card.request", { accountId: account, merchant: "Shop Ltd", paypalUnavailable: "card_only_merchant",
    purpose: "the domain for my storefront", ...args });
  const asSuper = async (sql: string, params: unknown[] = []) => {
    const c = await su.connect();
    try { await c.query("SET session_replication_role = replica"); await c.query(sql, params); } finally { c.release(); }
  };

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 50_000, simulatedSettlement: false });
    [F] = R.founders;
    await R.store.grantServiceRole();
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2 });
    su = new pg.Pool({ connectionString: R.pgc.superUrl.replace(/\/postgres$/, "/fleet_t"), max: 1 });
    expect((await R.econ(F, "venture.create", { key: "f-shop", model: "digital_product", offer: "templates", state: "selected" })).ok).toBe(true);
    const reg = await R.econ(F, "account.register", { platform: "shop.example.com", kind: "service", origin: SHOP, handle: "f-shop" });
    expect(reg.ok, JSON.stringify(reg)).toBe(true);
    account = reg.accountId;
    await R.one(`fleet.fleet_admin_owner_identity_class_set('payment_card', 'ovault:payment_card', NULL, 'configured', $1)`, [OWNER]);
    await R.one(`fleet.fleet_admin_identity_autonomy_set(true, ARRAY['legal_name'], true, 100_000, 200_000, '{}', 'agents may act without waiting', $1)`, [OWNER]);
  }, 300_000);
  afterAll(async () => { for (const p of [svc, su]) await p?.end(); await R?.close(); });

  it("migrates to v54 with a clean audit; the owner reviews above £100 by default", async () => {
    expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(54);
    expect(await R.one(`(SELECT max(version) FROM fleet.fleet_schema_migrations)`)).toBe(FLEET_PG_SCHEMA_VERSION);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
    expect((await R.q(`SELECT owner_review_above_minor, valid_hours FROM fleet.fleet_card_request_policy`))[0]).toEqual({ owner_review_above_minor: "10000", valid_hours: 48 });
  });

  it("no hold without an approved request; a request names why PayPal cannot pay and stays within the wallet", async () => {
    expect((await R.econ(F, "card.authorize", { accountId: account, merchant: "Shop Ltd", maxMinor: 1_000 })).code).toBe("FLEET_CARD_REQUEST_REQUIRED");
    expect((await ask({ amountMinor: 1_000, paypalUnavailable: "too_slow" })).code).toBe("FLEET_BAD_REQUEST");
    expect((await ask({ amountMinor: 1_000, purpose: "" })).code).toBe("FLEET_BAD_REQUEST");
    const cash = await R.balance(`agent:${F.id}:cash`);
    expect(await ask({ amountMinor: cash + 1 })).toMatchObject({ ok: false, code: "FLEET_INSUFFICIENT_FUNDS" });
    // While the treasury cannot pay out, "payouts unavailable" is a true reason.
    expect(await R.one(`fleet.fleet_paypal_payouts_available()`)).toBe(false);
    const r = await ask({ amountMinor: 1_000, paypalUnavailable: "payouts_unavailable" });
    expect(r).toMatchObject({ ok: true, request: { status: "approved", decidedBy: "fleet_control", amountMinor: 1_000 } });
    expect(await R.one(`fleet.fleet_event_route('card_request_approved', '{}'::jsonb)`)).toBe("AGENT_ACTIVITY_ONLY");
  });

  it("'payouts unavailable' is refused while the treasury can pay through PayPal", async () => {
    const def = (await R.q(`SELECT pg_get_functiondef('fleet.fleet_paypal_payouts_available()'::regprocedure) AS d`))[0].d as string;
    await asSuper(`CREATE OR REPLACE FUNCTION fleet.fleet_paypal_payouts_available() RETURNS boolean LANGUAGE sql STABLE AS 'SELECT true'`);
    try {
      expect(await ask({ amountMinor: 500, paypalUnavailable: "payouts_unavailable" })).toMatchObject({ ok: false, code: "FLEET_PAYPAL_FIRST" });
      // A genuine reason (the merchant takes cards only) still goes through.
      expect(await ask({ amountMinor: 500, paypalUnavailable: "card_only_merchant" })).toMatchObject({ ok: true, request: { status: "approved" } });
    } finally { await asSuper(def); }
    expect(await R.one(`fleet.fleet_paypal_payouts_available()`)).toBe(false);
  });

  it("an approved request opens one matching hold and is used up", async () => {
    const r = (await ask({ amountMinor: 2_000 })).request;
    expect((await R.econ(F, "card.authorize", { requestId: r.requestId, accountId: account, merchant: "Shop Ltd", maxMinor: 2_001 })).code).toBe("FLEET_CARD_REQUEST_MISMATCH");
    const h = await R.econ(F, "card.authorize", { requestId: r.requestId, accountId: account, merchant: "Shop Ltd", maxMinor: 1_800, purpose: "domain" });
    expect(h).toMatchObject({ ok: true, charge: { status: "held", holdMaxMinor: 1_800, funding: "own" } });
    const used = (await R.econ(F, "card.requests")).requests.find((x: any) => x.requestId === r.requestId);
    expect(used).toMatchObject({ status: "used", chargeId: h.charge.chargeId });
    expect(await R.econ(F, "card.void", { chargeId: h.charge.chargeId })).toMatchObject({ ok: true });
    expect((await R.econ(F, "card.authorize", { requestId: r.requestId, accountId: account, merchant: "Shop Ltd", maxMinor: 100 })).code).toBe("FLEET_CARD_REQUEST_NOT_APPROVED");
  });

  it("above £100 the owner decides — funding the card first; the transfer becomes the charge's repayment once booked", async () => {
    const r = (await ask({ amountMinor: 15_000, purpose: "a year of hosting to keep my storefront alive" })).request;
    expect(r).toMatchObject({ status: "pending_owner" });
    expect(await events("card_request_owner_review")).toBe(1);
    expect(await R.one(`fleet.fleet_event_route('card_request_owner_review', '{}'::jsonb)`)).toBe("P1_HIGH");
    expect((await R.econ(F, "card.authorize", { requestId: r.requestId, accountId: account, merchant: "Shop Ltd", maxMinor: 15_000 })).code).toBe("FLEET_CARD_REQUEST_NOT_APPROVED");
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_card_request_decide($1, 'approve', NULL, NULL, $2)`, [r.requestId, OWNER]))).toBe("FLEET_BAD_REQUEST");
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_card_request_decide($1, 'approve', 'tx-1', NULL, 'agent')`, [r.requestId]))).toBe("FLEET_APPROVAL_REQUIRED");
    const ok = await R.one(`fleet.fleet_admin_card_request_decide($1, 'approve', 'pp-to-card-1', 'funded', $2)`, [r.requestId, OWNER]);
    expect(ok.request).toMatchObject({ status: "approved", prefundReference: "pp-to-card-1", prefundMinor: 15_000 });
    expect(await events("card_request_owner_approved")).toBe(1);

    const pay0 = await R.balance("fleet:card:payable");
    const h = await R.econ(F, "card.authorize", { requestId: r.requestId, accountId: account, merchant: "Shop Ltd", maxMinor: 15_000, purpose: "hosting" });
    expect(h.ok, JSON.stringify(h)).toBe(true);
    // The site never filled the card in this test, so the charge is booked through the owner's statement confirmation path
    // via the agent's declaration (fill evidence is not needed to declare).
    const d = await R.econ(F, "card.declare", { chargeId: h.charge.chargeId, amountMinor: 14_400 });
    expect(d.ok, JSON.stringify(d)).toBe(true);
    // Booked (+14 400 on the card) and repaid by the owner's prior transfer (−14 400): nothing new owed.
    expect(await R.balance("fleet:card:payable")).toBe(pay0);
    expect((await R.q(`SELECT amount_minor, reference FROM fleet.fleet_card_repayments WHERE reference = 'prefund:pp-to-card-1'`))).toEqual([{ amount_minor: "14400", reference: "prefund:pp-to-card-1" }]);
    // A statement correction upwards is not covered twice by the same transfer.
    await R.one(`fleet.fleet_admin_card_charge_confirm($1, 14_600, 'stmt-hosting', $2)`, [h.charge.chargeId, OWNER]);
    expect(await R.balance("fleet:card:payable")).toBe(pay0 + 200);
    expect(Number((await R.q(`SELECT count(*) AS n FROM fleet.fleet_card_repayments WHERE reference LIKE 'prefund:%'`))[0].n)).toBe(1);
    // The same transfer reference cannot fund another request.
    const r2 = (await ask({ amountMinor: 12_000 })).request;
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_card_request_decide($1, 'approve', 'pp-to-card-1', NULL, $2)`, [r2.requestId, OWNER]))).toBe("FLEET_ALREADY_CLAIMED");
    const no = await R.one(`fleet.fleet_admin_card_request_decide($1, 'decline', NULL, 'use PayPal: the seller accepts it', $2)`, [r2.requestId, OWNER]);
    expect(no.request).toMatchObject({ status: "declined", note: "use PayPal: the seller accepts it" });
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_card_request_decide($1, 'approve', 'pp-x', NULL, $2)`, [r2.requestId, OWNER]))).toBe("FLEET_INVALID_STATE");
  });

  it("unused requests expire; a funded one tells the owner the money is still on the card; terms are fixed", async () => {
    const r = (await ask({ amountMinor: 11_000 })).request;
    await R.one(`fleet.fleet_admin_card_request_decide($1, 'approve', 'pp-to-card-2', NULL, $2)`, [r.requestId, OWNER]);
    await asSuper(`UPDATE fleet.fleet_card_requests SET expires_at = now() - interval '1 minute' WHERE request_id = $1`, [r.requestId]);
    const t = (await svc.query(`SELECT fleet.svc_card_requests_expire() AS r`)).rows[0].r;
    expect(t.expired).toBeGreaterThanOrEqual(1);
    expect(await events("card_request_expired")).toBe(1);
    expect(await R.code(R.q(`UPDATE fleet.fleet_card_requests SET amount_minor = 1 WHERE request_id = $1`, [r.requestId]))).toMatch(/FLEET_HISTORY_IMMUTABLE|permission denied/);
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_card_request_policy_set(-1, NULL, $1)`, [OWNER]))).toBe("FLEET_BAD_REQUEST");
    expect(await R.one(`fleet.fleet_admin_card_request_policy_set(20_000, 24, $1)`, [OWNER])).toMatchObject({ ok: true, ownerReviewAboveMinor: 20_000, validHours: 24 });
    expect((await ask({ amountMinor: 15_000 })).request.status).toBe("approved");
    await R.one(`fleet.fleet_admin_card_request_policy_set(10_000, 48, $1)`, [OWNER]);
  });
});

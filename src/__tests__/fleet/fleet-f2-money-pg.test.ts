/**
 * F2 schema v29 — the money core (PostgreSQL): legal entities and versioned tax, Fleet payment rails (shared/dedicated,
 * never live), PAYMENT_RAIL_REQUIRED with an action-scoped dependency, settlement that attributes every external
 * transaction exactly (sale → venture → agent → wallet → tax reserve) and never duplicates money, the tax reserve as
 * restricted capital, agent-registered vendor destinations (no owner enrolment), credential references (never secrets),
 * the wallet, safe transfers and reconciliation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";

const PG_BIN = findPgBin();
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

describe.skipIf(!PG_BIN)("F2 v29 money core: tax, rails, settlement, vendors, wallet, reconciliation (PostgreSQL)", () => {
  let R: EconomyRegistry;
  let F: Founder;
  let G: Founder;
  let svc: pg.Pool;
  let entity = "";
  let shared = "";
  let ventureF = "";
  const acct = (who: Founder, cls: string) => `agent:${who.id}:${cls.slice(6)}`;
  const ingest = (rail: string, ext: string, kind: "sale" | "refund", gross: number, fee: number, venture: string | null, currency = "GBP", payload?: string) =>
    svc.query(`SELECT fleet.svc_settlement_ingest($1, $2, $3, $4, $5, $6, $7, now(), $8, $9) AS r`,
      [rail, ext, kind, gross, fee, currency, venture, payload ?? sha(`${rail}|${ext}|${kind}|${gross}|${fee}`), sha(`customer-${ext}`)]).then((r) => r.rows[0].r);

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000 });
    [F, G] = R.founders;
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2 });
    await R.store.grantServiceRole();
  }, 240_000);
  afterAll(async () => { await svc?.end(); await R?.close(); });

  it("migrates with a clean privilege audit; existing agents get the new restricted accounts without any journal", async () => {
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
    for (const cls of ["agent_tax_reserve", "agent_tax_expense", "agent_envelope_cash"]) {
      expect(await R.one(`(SELECT count(*)::int FROM fleet.fleet_ledger_accounts WHERE class = $1)`, [cls])).toBe(2);
    }
    expect((await R.one(`fleet.fleet_ledger_verify()`)).ok).toBe(true);
  });

  it("tax is versioned policy of an OWNER-configured legal entity (an actual obligation): inclusive VAT and profit tax round up; without a profile nothing is reserved", async () => {
    const e = await R.one(`fleet.fleet_admin_legal_entity_add('Fleet Trading Ltd', 'GB', 'company', true, $1)`, [OWNER]);
    entity = e.entity_id;
    // An entity without a profile has no configured obligation: nothing is reserved (v33: no synthetic tax).
    expect(await R.one(`fleet.fleet_tax_for_sale($1, 1200, 50)`, [entity])).toMatchObject({ fallback: false, profiled: false, totalMinor: 0 });
    await R.one(`fleet.fleet_admin_tax_profile_set($1, $2::jsonb, now() - interval '1 second', 'test rates', $3)`,
      [entity, JSON.stringify([{ taxKind: "vat", rateBp: 2000, inclusive: true }, { taxKind: "profit", rateBp: 2500 }]), OWNER]);
    // 1200 gross incl. 20% VAT → 200 VAT; profit 25% × (1200 − 50 − 200) = 237.5 → 238 (never rounded down).
    expect(await R.one(`fleet.fleet_tax_for_sale($1, 1200, 50)`, [entity])).toMatchObject({ fallback: false, profileVersion: 1, vatMinor: 200, profitTaxMinor: 238, totalMinor: 438 });
    // A new version supersedes without rewriting history.
    await R.one(`fleet.fleet_admin_tax_profile_set($1, $2::jsonb, now() - interval '1 millisecond', 'rate change', $3)`,
      [entity, JSON.stringify([{ taxKind: "vat", rateBp: 2000, inclusive: true }, { taxKind: "profit", rateBp: 1900 }]), OWNER]);
    expect(await R.one(`fleet.fleet_tax_for_sale($1, 1200, 50)`, [entity])).toMatchObject({ profileVersion: 2, profitTaxMinor: 181 });
    expect(await R.code(R.q(`UPDATE fleet.fleet_tax_profiles SET rules = '[]'`))).toBe("FLEET_HISTORY_IMMUTABLE");
    expect(await R.code(R.one(`fleet.fleet_admin_tax_profile_set($1, '[{"taxKind":"vat","rateBp":20.5}]'::jsonb, NULL, NULL, $2)`, [entity, OWNER]))).toBe("FLEET_BAD_REQUEST");
  });

  it("rails are Fleet-owned (shared or dedicated), never live, and show only a masked account reference", async () => {
    const add = (mode: string, ref: string, kind = "shared", dedicated: string | null = null) =>
      R.one(`fleet.fleet_admin_rail_add('simulated', 'Fleet sim checkout', $1, NULL, ARRAY['receive_payments','refunds'], $2, NULL, $3, $4, NULL, $5)`, [kind, ref, mode, dedicated, OWNER]);
    expect(await R.code(add("live", "PayPal treasury"))).toMatch(/fleet_payment_rails_not_live/);
    expect(await R.code(add("simulated", "Visa 4111 1111 1111 1111"))).toMatch(/violates check constraint/);
    const r = await add("simulated", "Visa •••• 4821");
    expect(r).toMatchObject({ kind: "shared", mode: "simulated", status: "active", accountRef: "Visa •••• 4821", legalEntity: "Fleet Trading Ltd" });
    shared = r.railId;
  });

  it("PAYMENT_RAIL_REQUIRED: a compatible rail is assigned automatically; a missing provider account records ONE action-scoped dependency and freezes nothing", async () => {
    await R.econ(F, "venture.create", { key: "tracker", model: "digital_product", offer: "landlord tracker", state: "selected", channels: ["direct storefront"] });
    ventureF = (await R.q(`SELECT venture_id FROM fleet.fleet_ventures WHERE agent_id = $1 AND venture_key = 'tracker'`, [F.id]))[0].venture_id;
    const a = await R.econ(F, "rail.require", { ventureKey: "tracker", capability: "receive_payments" });
    expect(a).toMatchObject({ ok: true, status: "assigned", rail: { provider: "simulated", kind: "shared" } });
    // Gumroad has no Fleet rail: one kyc dependency for exactly that action; the venture is not frozen.
    const g = await R.econ(F, "rail.require", { ventureKey: "tracker", capability: "marketplace_listing", provider: "gumroad" });
    expect(g).toMatchObject({ ok: true, status: "dependency", dependencyRecorded: true });
    const dep = (await R.q(`SELECT kind, action, blocks_action, status FROM fleet.fleet_owner_requests WHERE agent_id = $1`, [F.id]))[0];
    expect(dep).toMatchObject({ kind: "kyc", blocks_action: true, status: "pending" });
    expect(dep.action).toMatch(/gumroad account \(marketplace_listing\) for venture tracker/i);
    expect((await R.econ(F, "venture.transition", { key: "tracker", to: "launching", reason: "storefront ready" })).venture.state).toBe("launching");
    // Connecting a compatible rail later assigns it and answers the dependency (nobody had to decide anything). On this
    // test registry a sandbox rail carries simulated evidence; v46 answers with exactly what is evidenced, never "connected".
    const gr = await R.one(`fleet.fleet_admin_rail_add('gumroad', 'Fleet Gumroad', 'shared', NULL, ARRAY['marketplace_listing','receive_payments'], 'gumroad: fleet store', NULL, 'sandbox', NULL, NULL, $1)`, [OWNER]);
    expect(gr.requirementsAssigned).toBe(1);
    const answered = (await R.q(`SELECT status, response FROM fleet.fleet_owner_requests WHERE agent_id = $1`, [F.id]))[0];
    expect(answered.status).toBe("answered");
    expect(answered.response).toMatch(/^Simulated \(test registry\) gumroad rail "Fleet Gumroad"\. Verified: account access \(simulated\), storefront publication \(simulated\), sale ingestion \(simulated\)\. Not yet verified: identity verification of the account holder, payout reconciliation, receipt into the fleet treasury\. Revenue is not spendable until it is received into the fleet treasury\.$/);
  });

  it("settlement: a sale on an assigned rail posts gross/fee/net, attributes the venture, reserves tax — and a duplicate callback never duplicates money", async () => {
    const cash0 = await R.balance(acct(F, "agent_cash"));
    const s = await ingest(shared, "ord-1001", "sale", 1200, 50, ventureF);
    expect(s).toMatchObject({ ok: true, status: "settled", tax: { vatMinor: 200, profitTaxMinor: 181 } });
    expect(await R.balance(acct(F, "agent_cash"))).toBe(cash0 + 1150 - 381);
    expect(await R.balance(acct(F, "agent_tax_reserve"))).toBe(381);
    for (let i = 0; i < 3; i++) expect(await ingest(shared, "ord-1001", "sale", 1200, 50, ventureF)).toMatchObject({ ok: true, replay: true });
    expect(await R.balance(acct(F, "agent_cash"))).toBe(cash0 + 1150 - 381);
    expect(await ingest(shared, "ord-1001", "sale", 1300, 50, ventureF, "GBP", sha("tampered"))).toMatchObject({ ok: false, code: "FLEET_SETTLEMENT_CONFLICT" });
    const f = (await R.econ(F, "venture.status", { key: "tracker" })).venture.financials;
    expect(f).toMatchObject({ revenueMinor: 1200, processorFeesMinor: 50, netProfitMinor: 1150, taxReservedMinor: 381, netProfitAfterTaxMinor: 769 });
  });

  it("orphan money is never guessed: unassigned or foreign-currency transactions stay unattributed until attributed, and reconciliation reports them", async () => {
    expect(await ingest(shared, "ord-2001", "sale", 500, 0, null)).toMatchObject({ ok: true, status: "unattributed" });
    expect(await ingest(shared, "ord-2002", "sale", 500, 0, ventureF, "USD")).toMatchObject({ status: "unattributed", reason: expect.stringContaining("FX") });
    const rec = await R.one(`fleet.fleet_reconcile()`);
    expect(rec.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "UNATTRIBUTED_TRANSACTIONS", severity: "WARN", detail: { count: 2, grossMinor: 1000 } })]));
    const t = (await R.q(`SELECT txn_id FROM fleet.fleet_external_transactions WHERE external_id = 'ord-2001'`))[0].txn_id;
    expect(await R.one(`fleet.fleet_admin_settlement_attribute($1, $2, $3)`, [t, ventureF, OWNER])).toMatchObject({ ok: true });
    expect(await R.code(R.one(`fleet.fleet_admin_settlement_attribute((SELECT txn_id FROM fleet.fleet_external_transactions WHERE external_id = 'ord-2002'), $1, $2)`, [ventureF, OWNER]))).toBe("FLEET_FX_REQUIRED");
  });

  it("a refund releases the tax reserved for it first, then repays the customer; the venture's books follow", async () => {
    const tax0 = await R.balance(acct(F, "agent_tax_reserve"));
    expect(await ingest(shared, "ord-1001", "refund", 1200, 0, ventureF)).toMatchObject({ ok: true, status: "settled" });
    expect(await R.balance(acct(F, "agent_tax_reserve"))).toBeLessThan(tax0);
    const f = (await R.econ(F, "venture.status", { key: "tracker" })).venture.financials;
    expect(f.refundsMinor).toBe(1200);
  });

  it("tax-reserved money is restricted: own-capital spend can never reach it; a vendor the agent registered itself is payable without any owner step", async () => {
    const v = await R.econ(F, "vendor.register", { vendorName: "Printful", category: "manufacturer", reference: "printful:payments@printful.example", provider: "printful", ventureKey: "tracker" });
    expect(v).toMatchObject({ ok: true, status: "active" });
    expect(await R.econ(F, "vendor.register", { vendorName: "Printful", category: "manufacturer", reference: "PRINTFUL:payments@printful.example" })).toMatchObject({ replayed: true });
    const cash = await R.balance(acct(F, "agent_cash"));
    const tax = await R.balance(acct(F, "agent_tax_reserve"));
    expect(tax).toBeGreaterThan(0);
    const spend = (who: Founder, amount: number, dst: string) => R.gw.spendRequest(who.id, who.token, { idempotencyKey: `k:${crypto.randomUUID()}`, amountCents: amount, category: "expense", destinationId: dst, purpose: "samples" });
    expect(await spend(F, cash + 1, v.destinationId)).toMatchObject({ ok: false, code: "FLEET_INSUFFICIENT_ALLOCATION", custody: "INSUFFICIENT_OWN_CAPITAL" });
    expect(await spend(F, cash, v.destinationId)).toMatchObject({ ok: true, order: { status: "reserved" } });
    expect(await R.balance(acct(F, "agent_tax_reserve"))).toBe(tax);
    // Another agent cannot pay F's vendor (scoped payee); prohibited categories and crypto are never vendors.
    expect(await spend(G, 100, v.destinationId)).toMatchObject({ ok: false, custody: "INVALID_DESTINATION" });
    expect(await R.econ(G, "vendor.register", { vendorName: "Friend", category: "personal", reference: "pal@example.com" })).toMatchObject({ ok: false, code: "FLEET_VENDOR_CATEGORY" });
    expect(await R.econ(G, "vendor.register", { vendorName: "X", category: "supplier", rail: "evm_usdc", reference: "0x" + "a".repeat(40) })).toMatchObject({ ok: false, code: "FLEET_VENDOR_RAIL" });
    // The agent can revoke its own vendor.
    expect(await R.econ(F, "vendor.revoke", { destinationId: v.destinationId, reason: "switched supplier" })).toMatchObject({ ok: true });
  });

  it("circuit breaker: the destination-novelty signal is relative, unset by default, and refuses without naming a threshold", async () => {
    const v = await R.econ(G, "vendor.register", { vendorName: "Ads Co", category: "advertising", reference: "https://ads.example/billing" });
    const spend = (amount: number) => R.gw.spendRequest(G.id, G.token, { idempotencyKey: `k:${crypto.randomUUID()}`, amountCents: amount, category: "expense", destinationId: v.destinationId, purpose: "ads" });
    expect(await spend(3000)).toMatchObject({ ok: true });
    await R.one(`fleet.fleet_admin_spend_circuit_breaker_novelty($1, 86400, 1000)`, [OWNER]);
    try {
      const r = await spend(2000);
      expect(r).toMatchObject({ ok: false, code: "FLEET_INFRASTRUCTURE_CIRCUIT_BREAKER", order: { decisionReason: "infrastructure circuit breaker: new_destination_wallet_share" } });
      expect(await spend(100)).toMatchObject({ ok: true });
    } finally { await R.one(`fleet.fleet_admin_spend_circuit_breaker_novelty($1, NULL, NULL)`, [OWNER]); }
  });

  it("credentials are vault references, never secrets; use is audited; revocation takes rails out of service", async () => {
    expect(await R.code(R.one(`fleet.fleet_admin_credential_register('paypal', 'treasury', 'sk_live_51HxYzSECRET', '{}', true, NULL, $1)`, [OWNER]))).toMatch(/violates check constraint/);
    const c = await R.one(`fleet.fleet_admin_credential_register('paypal', 'Fleet Treasury PayPal (payouts disabled)', 'vault:paypal/treasury', ARRAY['receive_payments'], true, 'treasury@…', $1)`, [OWNER]);
    const rail = await R.one(`fleet.fleet_admin_rail_add('paypal', 'Fleet Treasury PayPal', 'shared', NULL, ARRAY['receive_payments'], 'PayPal treasury@…', $1, 'sandbox', NULL, NULL, $2)`, [c.credential_id, OWNER]);
    expect((await svc.query(`SELECT fleet.svc_credential_use($1, 'paypal.list_sales', $2, NULL, 'ok', 'poll') AS r`, [c.credential_id, F.id])).rows[0].r).toMatchObject({ ok: true });
    await R.one(`fleet.fleet_admin_credential_set_status($1, 'revoked', $2)`, [c.credential_id, OWNER]);
    expect((await R.q(`SELECT status FROM fleet.fleet_payment_rails WHERE rail_id = $1`, [rail.railId]))[0].status).toBe("suspended");
    expect((await svc.query(`SELECT fleet.svc_credential_use($1, 'paypal.list_sales', NULL, NULL, 'ok', NULL) AS r`, [c.credential_id])).rows[0].r).toMatchObject({ ok: false, status: "revoked" });
    expect((await R.q(`SELECT outcome FROM fleet.fleet_credential_use_log WHERE credential_id = $1 ORDER BY seq`, [c.credential_id])).map((x) => x.outcome)).toEqual(["ok", "refused"]);
    // The service role reads no credential table directly.
    expect(await R.code(svc.query(`SELECT vault_ref FROM fleet.fleet_credential_refs`))).toBe("permission denied");
  });

  it("wallet: cash held, economic, available, committed and restricted are distinct; the safe transfer protects needs, commitments, tax and a cushion", async () => {
    const w = (await R.econ(G, "wallet")).wallet;
    expect(w).toMatchObject({ currency: "GBP", committedMinor: 3100, restricted: { taxReserveMinor: 0 } });
    expect(w.cashHeldMinor).toBe(10_000);
    expect(w.availableMinor).toBe(10_000 - 3100);
    // The agent's own plan is kept back from any transfer.
    const s0 = (await R.one(`fleet.fleet_safe_transfer_amount($1)`, [G.id])).safeTransferableMinor;
    await R.econ(G, "wallet.plan", { growthReserveMinor: 2000, runwayDaysTarget: 60, note: "next product batch" });
    const s1 = await R.one(`fleet.fleet_safe_transfer_amount($1)`, [G.id]);
    expect(s1).toMatchObject({ growthReserveMinor: 2000, cushionBp: 1000 });
    expect(s1.safeTransferableMinor).toBe(Math.max(0, s0 - 2000));
    expect(await R.code(R.one(`fleet.fleet_admin_wallet_transfer($1, $2, 'treasury', 'infrastructure costs', $3, $4)`, [G.id, s1.safeTransferableMinor + 1, OWNER, `wt:${crypto.randomUUID()}`])))
      .toBe("FLEET_ACKNOWLEDGE_REQUIRED"); // v35: Admin has no economic cap — the safe amount is advice, crossed only with an acknowledgement
    const t = await R.one(`fleet.fleet_admin_wallet_transfer($1, 1000, 'operating_pool', 'provider subscriptions', $2, $3)`, [G.id, OWNER, `wt:${crypto.randomUUID()}`]);
    expect(t).toMatchObject({ ok: true });
    expect(await R.balance("fleet:operating:pool")).toBe(1000);
    // The F wallet shows its tax reserve as restricted and its venture allocations.
    const wf = (await R.econ(F, "wallet")).wallet;
    expect(wf.restricted.taxReserveMinor).toBe(await R.balance(acct(F, "agent_tax_reserve")));
    expect(wf.ventureAllocations[0]).toMatchObject({ venture: "tracker" });
  });

  it("tax true-up follows the liability (VAT + profit tax on realized profit) and only ever releases what is over-reserved", async () => {
    const before = await R.balance(acct(F, "agent_tax_reserve"));
    const r = await R.one(`fleet.fleet_tax_true_up($1, 'controller')`, [F.id]);
    expect(r).toMatchObject({ ok: true });
    expect(await R.balance(acct(F, "agent_tax_reserve"))).toBe(r.liabilityMinor - r.paidMinor);
    expect(r.liabilityMinor).toBeGreaterThanOrEqual(0);
    expect(before).toBeGreaterThanOrEqual(0);
  });

  it("reconciliation: the ledger verifies, every settled journal matches its transaction, and the only open finding is the foreign-currency orphan", async () => {
    const rec = await R.one(`fleet.fleet_reconcile()`);
    const by = Object.fromEntries(rec.findings.map((f: { code: string }) => [f.code, f]));
    expect(by.LEDGER_VERIFY.severity).toBe("INFO");
    expect(by.SETTLEMENT_JOURNALS).toMatchObject({ severity: "INFO", detail: { mismatched: 0 } });
    expect(by.UNATTRIBUTED_TRANSACTIONS).toMatchObject({ detail: { count: 1 } });
    expect(rec.ok).toBe(true);
  });
});

describe.skipIf(!PG_BIN)("v33 constitutional correction: no legal entity, no tax profile, no synthetic tax (fresh registry, PostgreSQL)", () => {
  let R2: EconomyRegistry;
  let svc2: pg.Pool;
  let G2: Founder;
  const acct2 = (who: Founder, cls: string) => `agent:${who.id}:${cls.slice(6)}`;
  const ingest2 = (rail: string, ext: string, kind: "sale" | "refund", gross: number, fee: number, venture: string | null) =>
    svc2.query(`SELECT fleet.svc_settlement_ingest($1, $2, $3, $4, $5, 'GBP', $6, now(), $7, $8) AS r`,
      [rail, ext, kind, gross, fee, venture, sha(`${rail}|${ext}|${kind}|${gross}|${fee}`), sha(`customer-${ext}`)]).then((r) => r.rows[0].r);
  beforeAll(async () => {
    R2 = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000 });
    [G2] = R2.founders;
    svc2 = new pg.Pool({ connectionString: R2.pgc.serviceUrl, max: 2 });
    await R2.store.grantServiceRole();
  }, 240_000);
  afterAll(async () => { await svc2?.end(); await R2?.close(); });

  it("v33: no legal entity and no tax profile — rails register and match, a sale keeps its whole net cash, no synthetic tax can be set", async () => {
    // Nothing configured: no entity, no profile. A rail registers without any legal entity and is assigned automatically.
    expect(await R2.one(`(SELECT count(*)::int FROM fleet.fleet_legal_entities)`)).toBe(0);
    const rail = await R2.one(`fleet.fleet_admin_rail_add('simulated', 'No-entity sim checkout', 'shared', NULL, ARRAY['receive_payments'], 'sim', NULL, 'simulated', NULL, NULL, $1)`, [OWNER]);
    expect(rail.legalEntity).toBeUndefined();
    await R2.econ(G2, "venture.create", { key: "no-entity-venture", model: "digital_product", offer: "x", state: "selected" });
    const vG = (await R2.q(`SELECT venture_id FROM fleet.fleet_ventures WHERE agent_id = $1 AND venture_key = 'no-entity-venture'`, [G2.id]))[0].venture_id;
    expect(await R2.econ(G2, "rail.require", { ventureKey: "no-entity-venture", capability: "receive_payments" })).toMatchObject({ ok: true, status: "assigned" });
    // A sale with no configured obligation reserves nothing: the agent's survival capital receives the whole net.
    expect(await R2.one(`fleet.fleet_tax_for_sale(NULL, 1200, 50)`)).toMatchObject({ profiled: false, fallback: false, totalMinor: 0 });
    const cash0 = await R2.balance(acct2(G2, "agent_cash"));
    expect(await ingest2(rail.railId, "ne-1", "sale", 1200, 50, vG)).toMatchObject({ ok: true, status: "settled" });
    expect(await R2.balance(acct2(G2, "agent_cash"))).toBe(cash0 + 1150);
    expect(await R2.balance(acct2(G2, "agent_tax_reserve"))).toBe(0);
    // The retired fallback can never be set again; the true-up has nothing to hold back.
    expect(await R2.code(R2.one(`fleet.fleet_admin_tax_policy_set(2500, $1)`, [OWNER]))).toBe("FLEET_NO_SYNTHETIC_TAX");
    expect(await R2.code(R2.q(`UPDATE fleet.fleet_tax_policy SET unprofiled_reserve_bp = 2500`))).toMatch(/fleet_tax_policy_no_synthetic_tax|check constraint/);
    expect(await R2.one(`fleet.fleet_tax_true_up($1, 'controller')`, [G2.id])).toMatchObject({ ok: true, skipped: true, reason: "no configured tax obligation" });
    // A reserve left over from the retired fallback (pre-v33 history) is returned to the agent by the true-up.
    await R2.one(`fleet.fleet_ledger_post('tax_reservation', $1, 'controller', 'pre-v33 fallback reserve', 'controller', $2, NULL, NULL, NULL, NULL, now(), $3::jsonb)`,
      [`legacy:${crypto.randomUUID()}`, G2.id, JSON.stringify([{ account: acct2(G2, "agent_tax_reserve"), side: "D", amount: 288 }, { account: acct2(G2, "agent_cash"), side: "C", amount: 288 }])]);
    const released = await R2.one(`fleet.fleet_tax_true_up($1, 'controller')`, [G2.id]);
    expect(released).toMatchObject({ ok: true, releasedMinor: 288 });
    expect([await R2.balance(acct2(G2, "agent_tax_reserve")), await R2.balance(acct2(G2, "agent_cash"))]).toEqual([0, cash0 + 1150]);
  });

});

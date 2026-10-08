/**
 * Schema v46 — truthful rail readiness, the receive-only rail mode and settlement guards (Gumroad revenue integration,
 * stage G1; docs/design/gumroad-revenue-integration.md §§5.6, 5.7, 6, 8). PostgreSQL, no network, no provider.
 *
 * The registry here behaves like production: simulated settlement is NOT allowed. A real rail starts pending_setup and
 * answers nothing; a dependency is answered only with what is evidenced; publication needs no sale or payout; an
 * unverified holder identity stays open as its own dependency; a legacy request is answered only from a verified,
 * assigned capability; the receive-only mode can never carry an outgoing capability; direct settlement posts nothing;
 * an external settlement key is claimed once.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";

const PG_BIN = findPgBin();
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

describe.skipIf(!PG_BIN)("v46 rail readiness, receive-only mode, settlement guards (PostgreSQL)", () => {
  let R: EconomyRegistry;
  let F: Founder;
  let G: Founder;
  let svc: pg.Pool;
  let custody: pg.Pool;
  let cred = "";
  let rail = "";
  let ventureF = "";
  let ventureG = "";
  let depF = "";
  const addRail = (caps: string[], mode = "live_receive", provider = "gumroad", credential: string | null = null) =>
    R.one(`fleet.fleet_admin_rail_add($1, 'Fleet Gumroad', 'shared', NULL, $2, 'gumroad: owner store', $3, $4, NULL, NULL, $5)`, [provider, caps, credential, mode, OWNER]);
  const verify = (railId: string, check: string, status = "verified", kind = "probe", expires: string | null = null) =>
    R.one(`fleet.fleet_admin_rail_verify($1, $2, $3, $4, $5::jsonb, $6, $7)`, [railId, check, status, kind, JSON.stringify({ note: `test ${check}` }), expires, OWNER]);
  const requests = (who: Founder) => R.q(`SELECT request_id, kind, action, status, response, idempotency_key FROM fleet.fleet_owner_requests WHERE agent_id = $1 ORDER BY created_at`, [who.id]);
  const requirement = (who: Founder, cap: string) => R.q(`SELECT status, dependency_id, assignment_id FROM fleet.fleet_rail_requirements WHERE agent_id = $1 AND capability = $2`, [who.id, cap]);

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000, simulatedSettlement: false });
    [F, G] = R.founders;
    await R.store.grantServiceRole();
    await R.store.grantCustodyRole();
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2 });
    custody = new pg.Pool({ connectionString: R.pgc.custodyUrl, max: 1, options: "-c search_path=fleet" });
    expect((await R.econ(F, "venture.create", { key: "uk-sa-template", model: "digital_product", offer: "self-assessment template", state: "selected", channels: ["storefront"] })).ok).toBe(true);
    expect((await R.econ(G, "venture.create", { key: "landlord-compliance-tracker", model: "digital_product", offer: "landlord tracker", state: "selected", channels: ["gumroad"] })).ok).toBe(true);
    ventureF = (await R.q(`SELECT venture_id FROM fleet.fleet_ventures WHERE agent_id = $1`, [F.id]))[0].venture_id;
    ventureG = (await R.q(`SELECT venture_id FROM fleet.fleet_ventures WHERE agent_id = $1`, [G.id]))[0].venture_id;
  }, 240_000);
  afterAll(async () => { await svc?.end(); await custody?.end(); await R?.close(); });

  it("migrates to v46 with a clean privilege audit and changes no money", async () => {
    expect(await R.one(`(SELECT max(version) FROM fleet.fleet_schema_migrations)`)).toBe(FLEET_PG_SCHEMA_VERSION);  // v46, or a later stage on top
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
    expect(await R.one(`(SELECT simulated_settlement_allowed FROM fleet.fleet_economic_model WHERE id = 1)`)).toBe(false);
    expect((await R.one(`fleet.fleet_ledger_verify()`)).ok).toBe(true);
    // The v46 events are routed explicitly: evidence and claims are history; the simulation switch is surfaced.
    expect(await R.one(`fleet.fleet_event_route('payment_rail_check', '{}'::jsonb)`)).toBe("AUDIT_ONLY");
    expect(await R.one(`fleet.fleet_event_route('revenue_claimed', '{}'::jsonb)`)).toBe("AUDIT_ONLY");
    expect(await R.one(`fleet.fleet_event_route('simulated_settlement_policy', '{}'::jsonb)`)).toBe("P1_HIGH");
  });

  it("simulation stays simulation: no simulated or sandbox rail, and no direct settlement, on a registry that does not allow it", async () => {
    expect(await R.code(addRail(["receive_payments"], "simulated", "simulated"))).toBe("FLEET_SIMULATION_ONLY");
    expect(await R.code(addRail(["receive_payments"], "sandbox", "paypal"))).toBe("FLEET_SIMULATION_ONLY");
    expect(await R.code(R.one(`fleet.fleet_admin_settlement_attribute(gen_random_uuid(), $1, $2)`, [ventureF, OWNER]))).not.toBe("OK");
  });

  it("receive-only mode is its own pinned capability: gumroad, receiving capabilities only; live stays refused; the mode is fixed", async () => {
    for (const cap of ["payouts", "refunds", "card_spend", "bank_transfer"]) {
      expect(await R.code(addRail(["storefront", cap]))).toBe('violates check constraint "fleet_payment_rails_live_receive_scope"');
    }
    expect(await R.code(addRail(["storefront"], "live_receive", "paypal"))).toBe('violates check constraint "fleet_payment_rails_live_receive_scope"');
    expect(await R.code(addRail(["storefront"], "live"))).toBe('violates check constraint "fleet_payment_rails_not_live"');
    // A gumroad credential reference carries only the gateway's scopes.
    for (const scope of [["edit_sales"], ["account"], ["refund_sales"], ["view_sales", "payouts"]]) {
      expect(await R.code(R.one(`fleet.fleet_admin_credential_register('gumroad', 'gateway', $1, $2, false, NULL, $3)`, [`vault:gumroad/t-${scope.join("-")}`, scope, OWNER])))
        .toBe('violates check constraint "fleet_credential_refs_gumroad_scope"');
    }
    cred = (await R.one(`fleet.fleet_admin_credential_register('gumroad', 'gateway', 'vault:gumroad/main', ARRAY['edit_products','view_sales','view_payouts'], false, NULL, $1)`, [OWNER])).credential_id;
    const r = await addRail(["storefront", "receive_payments"], "live_receive", "gumroad", cred);
    rail = r.railId;
    expect(r).toMatchObject({ status: "pending_setup", mode: "live_receive", requirementsAssigned: 0 });
    expect(await R.code(R.q(`UPDATE fleet.fleet_payment_rails SET mode = 'sandbox' WHERE rail_id = $1`, [rail]))).toBe("FLEET_IMMUTABLE");
    // Direct settlement never posts through a receive-only rail (provider revenue is cash-basis).
    const ing = (await svc.query(`SELECT fleet.svc_settlement_ingest($1, 'sale-1', 'sale', 1500, 100, 'GBP', $2, now(), $3, NULL) AS r`, [rail, ventureF, sha("p")])).rows[0].r;
    expect(ing).toMatchObject({ ok: false, code: "FLEET_SETTLEMENT_SIMULATION_ONLY" });
    expect(await R.one(`(SELECT count(*)::int FROM fleet.fleet_external_transactions)`)).toBe(0);
    // No custody signer can attest it (no payouts / bank_transfer), so no payment instruction can ever select it.
    const att = (await custody.query(`SELECT cx_attest_signer('custody-executor', $1, 'gumroad', 'live_receive', $2) AS r`, [rail, cred])).rows[0].r;
    expect(att.ok).toBe(false);
    expect(["FLEET_RAIL_NOT_ACTIVE", "FLEET_CREDENTIAL_SCOPE"]).toContain(att.code);
    expect(await R.one(`(SELECT pg_get_functiondef('fleet.svc_issue_payment_instruction(uuid)'::regprocedure) ~ 'x\\.mode = ''live''')`)).toBe(true);
    // A registry with a receive-only rail cannot be switched to simulated settlement.
    expect(await R.code(R.one(`fleet.fleet_admin_simulated_settlement_set(true, $1)`, [OWNER]))).toBe("FLEET_LIVE_RECEIVE_PRESENT");
  });

  it("pending readiness: a pending rail answers nothing; approving the request assigns nothing; the rail cannot go active unevidenced", async () => {
    // The agent asks for a Gumroad storefront while no rail serves it: ONE action-scoped kyc dependency (like 6178c7bb).
    expect(await R.econ(F, "rail.require", { ventureKey: "uk-sa-template", capability: "storefront", provider: "gumroad" })).toMatchObject({ ok: true, status: "dependency" });
    const [dep] = await requests(F);
    depF = dep.request_id;
    expect(dep).toMatchObject({ kind: "kyc", status: "pending" });
    expect(dep.action).toMatch(/Open a gumroad account \(storefront\) for venture uk-sa-template/);
    // Re-registration attempts or status changes do not answer it while nothing is evidenced.
    expect(await R.code(R.one(`fleet.fleet_admin_rail_set_status($1, 'active', 'try', $2)`, [rail, OWNER]))).toBe("FLEET_RAIL_NOT_READY");
    await verify(rail, "account_access");
    expect(await R.code(R.one(`fleet.fleet_admin_rail_set_status($1, 'active', 'try', $2)`, [rail, OWNER]))).toBe("FLEET_RAIL_NOT_READY");
    expect((await requests(F))[0].status).toBe("pending");
    expect((await requirement(F, "storefront"))[0].status).toBe("dependency");
    // Simulated evidence is refused for a real rail.
    expect(await R.code(verify(rail, "storefront_publication", "verified", "simulated"))).toBe("FLEET_BAD_REQUEST");
  });

  it("an owner decision alone grants nothing", async () => {
    const G2 = await R.econ(G, "rail.require", { ventureKey: "landlord-compliance-tracker", capability: "receive_payments", provider: "gumroad" });
    expect(G2).toMatchObject({ ok: true, status: "dependency" });
    const dep = (await requests(G)).at(-1)!;
    await R.genesis.decideOwnerRequest(dep.request_id, "approved", "approved", OWNER);
    expect((await requirement(G, "receive_payments"))[0].status).toBe("dependency");
    expect(await R.one(`(SELECT count(*)::int FROM fleet.fleet_rail_assignments)`)).toBe(0);
  });

  it("storefront publication becomes ready with no sale or payout; the dependency is answered with exactly what is evidenced, and unverified identity stays open", async () => {
    await verify(rail, "storefront_publication", "verified", "owner_attested");
    const act = await R.one(`fleet.fleet_admin_rail_set_status($1, 'active', 'storefront evidenced', $2)`, [rail, OWNER]);
    expect(act.requirementsAssigned).toBe(1);
    expect((await requirement(F, "storefront"))[0].status).toBe("assigned");
    const [answered, identity] = await requests(F);
    expect(answered).toMatchObject({ request_id: depF, status: "answered" });
    expect(answered.response).toBe('gumroad rail "Fleet Gumroad". Verified: account access (probe), storefront publication (owner attested). '
      + "Not yet verified: identity verification of the account holder, sale ingestion, payout reconciliation, receipt into the fleet treasury. "
      + "Revenue is not spendable until it is received into the fleet treasury.");
    expect(answered.response).not.toMatch(/connected/);
    // Publication is not KYC: the holder-identity part stays open, as its own dependency.
    expect(identity).toMatchObject({ kind: "kyc", status: "pending", idempotency_key: `capability:${rail}:identity_verification` });
    expect(identity.action).toMatch(/Receive gumroad payouts: identity verification of the account holder/);
    // Sale ingestion is not evidenced: the receive_payments requirement does not match.
    expect((await requirement(G, "receive_payments"))[0].status).toBe("dependency");
  });

  it("a legacy request (no requirement) is answered only from a verified capability assigned to that agent's venture", async () => {
    const created = await R.q(`SELECT fleet.api_owner_request_create($1, $2, $3, 'kyc', $4, NULL, $5, $6) AS r`, [G.id, G.token, `legacy:${crypto.randomUUID()}`,
      "List the landlord compliance tracker on Gumroad (a Gumroad seller account needs a human identity/KYC)", "Owner request: enrol a Gumroad channel", "legacy"]);
    const legacy = created[0].r.request.requestId ?? created[0].r.request.request_id;
    const answer = (cap: string) => R.one(`fleet.fleet_admin_dependency_answer_from_capability($1, $2, $3, $4)`, [legacy, rail, cap, OWNER]);
    expect(await R.code(answer("storefront"))).toBe("FLEET_NOT_ASSIGNED");
    expect(await R.code(R.one(`fleet.fleet_admin_rail_assign($1, $2, 'receive_payments', $3)`, [rail, ventureG, OWNER]))).toBe("FLEET_RAIL_NOT_READY");
    expect(await R.one(`fleet.fleet_admin_rail_assign($1, $2, 'storefront', $3)`, [rail, ventureG, OWNER])).toMatchObject({ capability: "storefront" });
    expect(await R.code(answer("receive_payments"))).toBe("FLEET_RAIL_NOT_READY");
    const out = await answer("storefront");
    expect(out.identityDependency).toBeTruthy();
    const row = (await R.q(`SELECT status, response FROM fleet.fleet_owner_requests WHERE request_id = $1`, [legacy]))[0];
    expect(row.status).toBe("answered");
    expect(row.response).toMatch(/Verified: account access \(probe\), storefront publication \(owner attested\)\. Not yet verified: identity verification of the account holder/);
    expect(await R.code(answer("storefront"))).toBe("FLEET_INVALID_STATE");
  });

  it("evidence is append-only, and failed evidence stops a capability from matching", async () => {
    expect(await R.code(R.q(`UPDATE fleet.fleet_rail_capability_checks SET status = 'verified'`))).toBe("FLEET_HISTORY_IMMUTABLE");
    expect(await R.code(R.q(`DELETE FROM fleet.fleet_rail_capability_checks`))).toBe("FLEET_HISTORY_IMMUTABLE");
    await verify(rail, "storefront_publication", "failed", "first_use");
    expect(await R.one(`fleet.fleet_rail_capability_ready($1, 'storefront')`, [rail])).toBe(false);
    expect(await R.econ(G, "rail.require", { ventureKey: "landlord-compliance-tracker", capability: "marketplace_listing", provider: "gumroad" })).toMatchObject({ status: "dependency" });
    // Holder identity, once evidenced, is reported as such.
    await verify(rail, "storefront_publication", "verified", "first_use");
    await verify(rail, "identity_verification", "verified", "owner_attested");
    expect(await R.one(`fleet.fleet_rail_readiness_text($1)`, [rail])).toMatch(/identity verification of the account holder \(owner attested\)\. Not yet verified: sale ingestion/);
  });

  it("one claim per external settlement: manual revenue claims a key once; no manual revenue or owner funding may reuse it", async () => {
    // (a gumroad:… claim must name a registered provider account since v47 — see fleet-storefront-accounting-pg; any other
    // settlement namespace exercises the v46 claim mechanics)
    const key = `paypal:acct1:payout:${crypto.randomUUID().slice(0, 8)}`;
    const rec = (k: string, ref: string) => R.one(`fleet.fleet_admin_record_external_claimed('external_revenue', $1, 500, $2, $3, $4, $5, $6)`,
      [F.id, ref, sha(`buyer-${ref}`), OWNER, `rev:${crypto.randomUUID()}`, k]);
    const cashBefore = await R.balance(`agent:${F.id}:cash`);
    expect(await R.ledger.recordRevenueClaimed(F.id, 500, "gumroad-payout-1", "buyer-1", OWNER, key)).toMatch(/^[0-9a-f-]{36}$/);
    expect(await R.balance(`agent:${F.id}:cash`)).toBe(cashBefore + 500);
    expect(await R.code(rec(key, "gumroad-payout-1b"))).toBe("FLEET_ALREADY_CLAIMED");
    expect(await R.code(R.ledger.recordRevenue(F.id, 500, key, "buyer", OWNER))).toBe("FLEET_ALREADY_CLAIMED");
    expect(await R.code(R.ledger.recordOwnerFunding(500, key, OWNER))).toBe("FLEET_ALREADY_CLAIMED");
    expect(await R.code(R.one(`fleet.fleet_admin_record_external_claimed('external_refund', $1, 5, 'r', $2, $3, $4, 'paypal:x:payout:y')`,
      [F.id, sha("b"), OWNER, `rev:${crypto.randomUUID()}`]))).toBe("FLEET_BAD_REQUEST");
    expect(await R.balance(`agent:${F.id}:cash`)).toBe(cashBefore + 500);
    expect(await R.code(R.q(`DELETE FROM fleet.fleet_revenue_claims`))).toBe("FLEET_HISTORY_IMMUTABLE");
  });

  it("the privilege audit fails closed on a weakened receive-only pin or simulated settlement beside a live rail", async () => {
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
    const def = await R.one(`(SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'fleet_payment_rails_live_receive_scope')`);
    await R.q(`ALTER TABLE fleet.fleet_payment_rails DROP CONSTRAINT fleet_payment_rails_live_receive_scope`);
    expect((await R.store.auditPrivileges()).problems.join("\n")).toMatch(/receive-only rail scope CHECK is missing/);
    await R.q(`ALTER TABLE fleet.fleet_payment_rails ADD CONSTRAINT fleet_payment_rails_live_receive_scope ${def}`);
    await R.q(`UPDATE fleet.fleet_economic_model SET simulated_settlement_allowed = true WHERE id = 1`);
    expect((await R.store.auditPrivileges()).problems.join("\n")).toMatch(/simulated settlement is allowed on a registry with a receive-only provider rail/);
    await R.q(`UPDATE fleet.fleet_economic_model SET simulated_settlement_allowed = false WHERE id = 1`);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });

  it("reconciliation reports pending rails and stays balanced; nothing posted to agents beyond the explicit owner record", async () => {
    const rec = await R.one(`fleet.fleet_reconcile()`);
    expect(rec.findings.map((f: { code: string }) => f.code)).not.toContain("SIMULATED_SETTLEMENT_ALLOWED");
    expect((await R.one(`fleet.fleet_ledger_verify()`)).ok).toBe(true);
    expect(await R.one(`(SELECT count(*)::int FROM fleet.fleet_ledger_journal WHERE kind IN ('venture_sale','tax_reservation'))`)).toBe(0);
  });
});

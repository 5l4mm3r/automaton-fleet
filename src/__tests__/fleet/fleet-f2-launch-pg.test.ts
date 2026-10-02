/**
 * F2 launch hardening, schema v31 (PostgreSQL).
 *
 * Manual admin withdrawals: no nominal software cap; FleetController's advisory risk assessment (unrestricted liquidity,
 * restricted money excluded, protected operating requirements, the 10 % Treasury cushion, the recommended safe amount);
 * above the advice the admin must acknowledge, never a rejection; every withdrawal strongly confirmed; idempotent;
 * audited; restricted/tax/agent money unreachable. R24: own-capital experiments are no longer gated on commercial
 * evidence. The spend boundary's cognition depth is contextual. Owner funding is never revenue or profit.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";

const PG_BIN = findPgBin();
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

describe.skipIf(!PG_BIN)("F2 v31 launch hardening: admin withdrawals, R24 custody-only, contextual depth (PostgreSQL)", () => {
  let R: EconomyRegistry;
  let svc: pg.Pool;
  let ownerDst = "";
  const unalloc = () => R.balance("fleet:treasury:unallocated");
  const assess = (amount: number) => R.one(`fleet.fleet_admin_withdrawal_assessment($1)`, [amount]);
  const withdraw = (amount: number, o: { ack?: boolean; idem?: string; code?: string | null } = {}) =>
    R.one(`fleet.fleet_admin_owner_withdrawal($1, $2, $3, 'infrastructure', $4, $5, $6)`,
      [amount, ownerDst, OWNER, o.ack ?? false, o.idem ?? `w:${crypto.randomUUID()}`, o.code === null ? null : sha(o.code ?? "one-time-code")]);

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000, treasuryCents: 1_000_000 });
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2 });
    await R.store.grantServiceRole();
    const e = await R.ledger.enrollDestination({ kind: "owner", rail: "bank_transfer", label: "owner account", reference: `GB${crypto.randomUUID()}`, actor: OWNER });
    const su = new pg.Pool({ connectionString: R.pgc.superUrl.replace(/\/postgres$/, `/${R.pgc.dbname}`), max: 1 });
    try {
      const c = await su.connect();
      try {
        await c.query("SET session_replication_role = replica");
        await c.query(`UPDATE fleet.fleet_payment_destinations SET activatable_at = now() - interval '1 second', enrolled_at = now() - interval '4 days' WHERE destination_id = $1`, [e.destinationId]);
      } finally { await c.query("RESET session_replication_role"); c.release(); }
    } finally { await su.end(); }
    await R.ledger.activateDestination(e.destinationId, e.activationCode, OWNER);
    ownerDst = e.destinationId;
    // A committed Fleet-capital envelope (a future tranche the Treasury promised) and some infrastructure spend history.
    const [F] = R.founders;
    await R.econ(F, "venture.create", { key: "growth-venture", model: "service", offer: "x", state: "selected" });
    await R.q(`UPDATE fleet.fleet_capital_policy SET reapply_cooldown_s = 0`);
    await R.econ(F, "capital.request", { idempotencyKey: `c:${crypto.randomUUID()}`, ventureKey: "growth-venture", purpose: "growth", amountMinor: 200_000,
      evidence: [{ kind: "sales", observation: "a" }, { kind: "margin", observation: "b" }], expectedRevenueMinor: 600_000, expectedNetMinor: 200_000,
      downsideMinor: 100_000, confidenceBp: 8000, milestones: [{ key: "m1", metric: "revenue_minor", target: 1, trancheMinor: 50_000 }] });
  }, 240_000);
  afterAll(async () => { await svc?.end(); await R?.close(); });

  it("the assessment is transparent: unrestricted liquidity, restricted money excluded, protected requirements, the 10% cushion and the safe amount", async () => {
    const a = await assess(1);
    const liquid = await unalloc();
    expect(a.unrestrictedLiquidMinor).toBe(liquid);
    expect(a.restrictedExcluded).toMatchObject({ agentCashMinor: expect.any(Number), envelopeCapitalMinor: expect.any(Number), taxReservesMinor: 0 });
    expect(a.restrictedExcluded.envelopeCapitalMinor).toBeGreaterThan(0);
    expect(a.protected.committedFleetCapitalMinor).toBeGreaterThan(0); // the unallocated tranche the envelope still holds
    expect(a.cushion).toMatchObject({ bp: 1000, baseMinor: liquid, minor: Math.ceil(liquid / 10) });
    expect(a.recommendedSafeMinor).toBe(Math.max(0, liquid - a.protected.totalMinor - a.cushion.minor));
    expect(a.advisory).toBe(true);
  });

  it("below and exactly at the recommendation: normal; above it and very large: advice and acknowledgement, never a nominal rejection", async () => {
    const safe = (await assess(1)).recommendedSafeMinor;
    const at = await assess(safe);
    expect(at).toMatchObject({ severity: "normal", aboveRecommendationMinor: 0 });
    const small = await withdraw(1_000);
    expect(small).toMatchObject({ status: "pending_confirmation", assessment: { severity: "normal" } });
    const exact = await withdraw((await assess(1)).recommendedSafeMinor);
    expect(exact.status).toBe("pending_confirmation");
    // Above the advice: warning with the full assessment; acknowledged, the admin proceeds.
    const big = (await unalloc()) - 10;
    const warned = await withdraw(big);
    expect(warned).toMatchObject({ status: "needs_acknowledgement", recommendation: "recommend_against" });
    expect(warned.assessment).toMatchObject({ requestedMinor: big, aboveRecommendationMinor: expect.any(Number), resultingLiquidMinor: 10 });
    expect(["elevated", "high", "critical"]).toContain(warned.assessment.severity);
    expect(warned.assessment.unfundedCommitments.length).toBeGreaterThan(0);
    const proceeded = await withdraw(big, { ack: true });
    expect(proceeded).toMatchObject({ status: "pending_confirmation" });
    // No nominal cap: the only refusal is the ownership/availability boundary of the unrestricted pool.
    expect(await withdraw((await unalloc()) + 1, { ack: true })).toMatchObject({ status: "refused", code: "FLEET_INSUFFICIENT_TREASURY", assessment: { severity: "unavailable" } });
  });

  it("every withdrawal is strongly confirmed; confirmation reserves from the Treasury pool only; idempotent; audited", async () => {
    const before = await unalloc();
    expect(await R.code(withdraw(500, { code: null }))).toBe("FLEET_STRONG_AUTH_REQUIRED");
    const idem = `w:${crypto.randomUUID()}`;
    const p = await withdraw(500, { idem, code: "code-500" });
    expect(await withdraw(500, { idem, code: "code-500" })).toMatchObject({ replay: true, instructionId: p.instructionId });
    const done = await R.one(`fleet.fleet_admin_confirm($1, 'code-500', $2)`, [p.instructionId, OWNER]);
    expect(done).toMatchObject({ status: "reserved", executed: false });
    expect(await unalloc()).toBe(before - 500);
    expect(await withdraw(500, { idem, code: "code-500" })).toMatchObject({ replay: true, status: "executed" });
    expect(await unalloc()).toBe(before - 500);
    const hub = await R.one(`fleet.fleet_hub_withdrawals(NULL)`);
    expect(hub.history.length).toBeGreaterThan(0);
    expect(hub.history[0]).toHaveProperty("severity");
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_events WHERE event_type = 'admin_withdrawal_requested'`))[0].n).toBeGreaterThan(0);
  });

  it("tax, agent and envelope money are never in the withdrawal pool; owner funding is never revenue or profit", async () => {
    const [F, G] = R.founders;
    const before = await R.one(`fleet.fleet_agent_economics($1)`, [G.id]);
    const agentTotal = (await assess(1)).restrictedExcluded.agentCashMinor;
    await R.ledger.recordOwnerFunding(250_000, `bank:${crypto.randomUUID()}`, OWNER);
    const after = await R.one(`fleet.fleet_agent_economics($1)`, [G.id]);
    expect([Number(after.externalCustomerRevenue), Number(after.realizedNetProfit)]).toEqual([Number(before.externalCustomerRevenue), Number(before.realizedNetProfit)]);
    expect((await assess(1)).restrictedExcluded.agentCashMinor).toBe(agentTotal); // funding lands in the Treasury, not in agent money
    expect((await R.one(`fleet.fleet_hub('overview', '{}')`)).totalRevenueMinor).toBe(0);
    // A withdrawal can never take more than the unallocated pool, whatever agents and envelopes hold.
    const pool = await unalloc();
    expect(await withdraw(pool + agentTotal, { ack: true })).toMatchObject({ status: "refused", code: "FLEET_INSUFFICIENT_TREASURY" });
    expect(F.id).not.toBe(G.id);
  });

  it("R24: an own-capital experiment is decided on custody alone — no WATCH on insufficient, uncertain or pending evidence", async () => {
    const src = (await R.q(`SELECT prosrc FROM pg_proc WHERE proname = 'fleet_experiment_evaluate'`))[0].prosrc as string;
    expect(src).not.toMatch(/'watch'|FLEET_EVIDENCE_INSUFFICIENT|FLEET_EVIDENCE_UNCERTAIN|FLEET_RELEVANCE_PENDING|OWNER_DECISION/);
    expect(src).toMatch(/survival headroom/);
  });

  it("contextual cognition depth: exposure is one input; recoverability lowers it, a new destination raises it", async () => {
    const [F] = R.founders;
    const avail = Number((await R.one(`fleet.fleet_agent_economics($1)`, [F.id])).expensePurchasingCapacity);
    const depth = (amount: number, category: string, dst: string | null, rec = 0) => R.one(`fleet.fleet_spend_depth($1, $2, $3, $4, $5)`, [F.id, amount, category, dst, rec]);
    const known = (await R.econ(F, "vendor.register", { vendorName: "k", category: "supplier", reference: "k@vendor.example" })).destinationId;
    await R.gw.spendRequest(F.id, F.token, { idempotencyKey: `k:${crypto.randomUUID()}`, amountCents: 1, category: "expense", destinationId: known, purpose: "first" });
    const fresh = (await R.econ(F, "vendor.register", { vendorName: "n", category: "supplier", reference: "n@vendor.example" })).destinationId;
    const quarter = Math.ceil(avail / 4) + 1;
    const eighth = Math.ceil(avail / 8) + 1;
    expect(await depth(quarter, "expense", known)).toMatchObject({ critical: true, points: 2 });
    expect(await depth(quarter, "asset_acquisition", known, quarter)).toMatchObject({ critical: false, points: 1 }); // fully recoverable
    expect(await depth(eighth, "expense", known)).toMatchObject({ critical: false, points: 1 });
    expect(await depth(eighth, "expense", fresh)).toMatchObject({ critical: true, points: 2 }); // context, not one percentage
    expect(await depth(1, "expense", fresh)).toMatchObject({ critical: false, points: 1 });
    expect((await depth(eighth, "expense", fresh)).factors).toEqual(expect.arrayContaining(["first payment to this destination"]));
  });

  it("the privilege audit stays clean with v31", async () => {
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });
});

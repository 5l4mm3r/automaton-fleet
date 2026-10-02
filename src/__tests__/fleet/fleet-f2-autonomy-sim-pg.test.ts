/**
 * F2 zero-owner autonomy simulation (PostgreSQL, deterministic, 30 simulated days).
 *
 * Infrastructure is set up once (a legal entity with a versioned tax profile, one shared simulated payment rail, the
 * sweep curve switched on). Then for 30 days the owner does NOTHING. Three founders — a small wallet (A), a large
 * wallet (B) and a small wallet (C) — act only through the restricted agent API and FleetController only through its
 * service role:
 *   research → opportunity → decision → venture → execution → simulated sale → settlement → wallet → tax reserve → profit
 *   → Treasury,
 * with an unresolved KYC dependency (Gumroad) all month, a failed venture that pivots, a successful venture that scales
 * and is reinvested with Fleet capital through an envelope, and an expansion into a child venture.
 *
 * Proven: no owner wait and no global blocker; research is bounded and ends in decisions; decisions execute; knowledge
 * improves (ledger-backed lessons shared fleet-wide); the books reconcile (ledger, settlements, venture attribution,
 * tax, envelopes); tax reserves never become spendable; sweeps take only after-tax net profit; nobody is rescued.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { SimulatedProvider, syncRail } from "../../fleet/payments/adapters.js";
import type { PaymentsRegistry } from "../../fleet/payments/types.js";

const PG_BIN = findPgBin();
const DAYS = 30;
const ev = (kind: string, observation: string) => ({ kind, source: "https://market.example/evidence", observation });

describe.skipIf(!PG_BIN)("F2 30-day zero-owner autonomy simulation (PostgreSQL)", () => {
  let R: EconomyRegistry;
  let svc: pg.Pool;
  let A: Founder, B: Founder, C: Founder;
  let rail = "";
  let start = "";
  const provider = new SimulatedProvider();
  const ventureId = async (who: Founder, key: string) => (await R.q(`SELECT venture_id FROM fleet.fleet_ventures WHERE agent_id = $1 AND venture_key = $2`, [who.id, key]))[0]?.venture_id as string;
  const registry: PaymentsRegistry = {
    settlementIngest: async (t) => (await svc.query(`SELECT fleet.svc_settlement_ingest($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) AS r`,
      [t.railId, t.externalId, t.kind, t.grossMinor, t.feeMinor, t.currency, t.ventureId, t.occurredAt, t.payloadSha256, t.counterpartySha256])).rows[0].r,
    credentialUse: async () => ({ ok: true }),
  };
  const ok = async (p: Promise<Record<string, any>>) => {
    const r = await p;
    if (r.ok !== true) throw new Error(`expected ok, got ${JSON.stringify(r).slice(0, 400)}`);
    return r;
  };
  const log: string[] = [];

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 3, allocationCents: 5_000, treasuryCents: 2_000_000 });
    [A, B, C] = R.founders;
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2 });
    await R.store.grantServiceRole();
    // ── Day 0: Fleet infrastructure only (a payment rail, the Treasury's net-profit sweep), then nothing. v33: no legal
    // entity and no tax profile — the survival game needs no conventional business administration.
    rail = (await R.one(`fleet.fleet_admin_rail_add('simulated', 'Fleet checkout (simulated)', 'shared', NULL, ARRAY['receive_payments','refunds','storefront'], 'sim checkout', NULL, 'simulated', NULL, NULL, $1)`, [OWNER])).railId;
    await R.one(`fleet.fleet_admin_sweep_policy_set(true, NULL, NULL, NULL, NULL, NULL, $1)`, [OWNER]);
    // B starts with a much larger wallet (a Treasury grant before the simulation).
    await R.ledger.agentCapital({ agentId: B.id, amountCents: 500_000, mode: "grant", actor: OWNER });
    await R.q(`UPDATE fleet.fleet_capital_policy SET reapply_cooldown_s = 0`);
    start = (await R.q(`SELECT now() AS t`))[0].t;
  }, 240_000);
  afterAll(async () => { await svc?.end(); await R?.close(); });

  it("runs 30 days of autonomous economic activity with zero owner actions", async () => {
    // ── Day 1: each founder frames a decision, gathers a small set of evidence-backed candidates and ranks them itself.
    const candidates: Record<string, Array<[string, string, string]>> = {
      A: [["landlord-tracker", "digital_product", "UK landlord compliance tracker"], ["invoice-pack", "digital_product", "freelancer invoice pack"], ["meal-planner", "digital_product", "meal planner"]],
      B: [["botanical-posters", "physical_product", "botanical poster prints"], ["dog-bandanas", "physical_product", "custom dog bandanas"]],
      C: [["seo-audits", "service", "local SEO audits"], ["resume-reviews", "service", "CV reviews"]],
    };
    for (const [who, list] of [[A, candidates.A], [B, candidates.B], [C, candidates.C]] as const) {
      for (const [key, type, offer] of list) {
        await ok(R.econ(who, "opportunity.record", { key, type, offer, evidence: [ev("bestseller", `${offer}: top-20 listing`), ev("pricing", `${offer}: price band`)],
          estMarginBp: type === "physical_product" ? 5500 : 8500, capitalRequiredMinor: type === "physical_product" ? 20_000 : 500, timeToRevenueDays: 7, confidenceBp: 6000 }));
      }
      await ok(R.econ(who, "opportunity.shortlist", { ranking: list.map(([key], i) => ({ key, rank: i + 1 })), rationale: "purchase evidence first" }));
    }
    // Decide and convert the top candidate into a venture (no approval anywhere).
    const launch = async (who: Founder, opp: string, forecastRevenue: number, capital: number) => {
      await ok(R.econ(who, "opportunity.status", { key: opp, status: "selected", reason: "strongest purchase evidence for my wallet" }));
      await ok(R.econ(who, "venture.create", { key: opp, opportunityKey: opp, state: "selected", channels: ["direct storefront"], reason: "decided" }));
      await ok(R.econ(who, "decision.record", { key: `d-${opp}`, purpose: "select_opportunity", question: `Launch ${opp}?`, selected: opp, ventureKey: opp,
        alternatives: [{ option: "the runner-up", reason: "weaker evidence" }], evidence: [ev("sales", "observed purchasing")], forecastRevenueMinor: forecastRevenue,
        forecastCostMinor: capital, confidenceBp: 6000, capitalExposedMinor: capital, downside: "the capital at risk", invalidatedBy: "no sale in 10 days", nextAction: "launch" }));
      await ok(R.econ(who, "rail.require", { ventureKey: opp, capability: "receive_payments" }));
      for (const to of ["building", "launching", "operating"]) await ok(R.econ(who, "venture.transition", { key: opp, to, reason: `day 1: ${to}` }));
    };
    await launch(A, "landlord-tracker", 20_000, 500);
    await launch(B, "botanical-posters", 60_000, 20_000);
    await launch(C, "seo-audits", 15_000, 1_000);
    // A also wants Gumroad: no Fleet rail exists → ONE action-scoped kyc dependency, unresolved all month.
    expect(await R.econ(A, "rail.require", { ventureKey: "landlord-tracker", capability: "storefront", provider: "gumroad" })).toMatchObject({ ok: true, status: "dependency" });
    // B buys samples from a vendor it registered itself, with its own capital (custody-checked, no owner enrolment).
    const vendor = (await ok(R.econ(B, "vendor.register", { vendorName: "Print partner", category: "manufacturer", reference: "billing@printpartner.example", ventureKey: "botanical-posters" }))).destinationId;
    expect(await R.gw.spendRequest(B.id, B.token, { idempotencyKey: `b:${crypto.randomUUID()}`, amountCents: 20_000, category: "expense", destinationId: vendor, purpose: "first print run" }))
      .toMatchObject({ ok: true, order: { status: "reserved" } });
    const [vA, vB, vC] = [await ventureId(A, "landlord-tracker"), await ventureId(B, "botanical-posters"), await ventureId(C, "seo-audits")];

    // ── Days 1..30: customers buy through the simulated checkout; FleetController settles daily.
    let vC2: string | null = null;
    for (let day = 1; day <= DAYS; day++) {
      for (let i = 0; i < 2; i++) provider.record({ kind: "sale", grossMinor: 900, feeMinor: 46, ventureId: vA, customer: `a-${day}-${i}@buyer.example` });
      if (day >= 8) provider.record({ kind: "sale", grossMinor: 2_500, feeMinor: 95, ventureId: vB, customer: `b-${day}@buyer.example` });
      if (day === 12) provider.record({ kind: "refund", grossMinor: 900, ventureId: vA, externalId: "sim-sale-3" });
      if (vC2 && day >= 16) provider.record({ kind: "sale", grossMinor: 1_200, feeMinor: 55, ventureId: vC2, customer: `c-${day}@buyer.example` });
      // One orphan: a payment with no venture reference (left unattributed, never guessed).
      if (day === 5) provider.record({ kind: "sale", grossMinor: 700, ventureId: null, customer: "mystery@buyer.example" });
      const s = await syncRail(rail, provider, registry, new Date(Date.now() - 86_400_000));
      expect(s.failed).toBe(0);
      // Day 10: C's service found no buyers. It fails the venture on the ledger's evidence, learns, and pivots on Fleet knowledge.
      if (day === 10) {
        await ok(R.econ(C, "venture.transition", { key: "seo-audits", to: "failed", reason: "no sale in 10 days: invalidation evidence met" }));
        const m = await ok(R.econ(C, "decision.outcome", { key: "d-seo-audits", lessons: "Cold local SEO audits did not sell without a referral channel." }));
        expect(m.decision.outcome).toMatchObject({ source: "ledger", revenueMinor: 0 });
        await ok(R.econ(C, "venture.transition", { key: "seo-audits", to: "closed", reason: "closed after failure" }));
        // The fleet's measured knowledge points somewhere better: A's ledger-backed lesson is visible to C.
        await ok(R.econ(A, "decision.outcome", { key: "d-landlord-tracker", lessons: "Direct storefront digital templates sell daily at £9." }));
        const k = await ok(R.econ(C, "knowledge.search", { query: "storefront" }));
        expect(k.knowledge).toEqual(expect.arrayContaining([expect.objectContaining({ outcomeBacked: true, own: false })]));
        await ok(R.econ(C, "opportunity.status", { key: "resume-reviews", status: "rejected", reason: "service model failed for me; switch to a digital product" }));
        await ok(R.econ(C, "opportunity.record", { key: "cv-templates", type: "digital_product", offer: "CV template pack", evidence: [ev("fleet_outcome", "fleet lesson: storefront templates sell"), ev("bestseller", "CV templates top-50")] }));
        await ok(R.econ(C, "venture.create", { key: "cv-templates", opportunityKey: "cv-templates", state: "selected", channels: ["direct storefront"], reason: "pivot on evidence" }));
        await ok(R.econ(C, "decision.record", { key: "d-cv-templates", purpose: "pivot", question: "Pivot to CV templates?", selected: "cv-templates", ventureKey: "cv-templates",
          evidence: [ev("fleet_outcome", "A's measured result")], forecastRevenueMinor: 10_000, forecastCostMinor: 0, capitalExposedMinor: 0, nextAction: "publish" }));
        await ok(R.econ(C, "rail.require", { ventureKey: "cv-templates" }));
        for (const to of ["building", "launching", "operating"]) await ok(R.econ(C, "venture.transition", { key: "cv-templates", to, reason: "pivot executed" }));
        vC2 = await ventureId(C, "cv-templates");
      }
      // Day 15: A's venture is profitable on the ledger → scaling; Fleet capital beyond its own wallet for marketing (reinvestment).
      if (day === 15) {
        await ok(R.econ(A, "venture.transition", { key: "landlord-tracker", to: "scaling", reason: "ledger-backed profit" }));
        const cap = await ok(R.econ(A, "capital.request", { idempotencyKey: `cap:${crypto.randomUUID()}`, ventureKey: "landlord-tracker", purpose: "marketing for the proven tracker",
          amountMinor: 20_000, evidence: [ev("sales", "2 sales a day for 14 days"), ev("margin", "net margin after fees and VAT")], expectedRevenueMinor: 60_000,
          expectedNetMinor: 25_000, expectedPaybackDays: 30, downsideMinor: 20_000, confidenceBp: 7000, alternativePlan: "organic only", alternativeMinor: 5_000 }));
        expect(["APPROVE", "PARTIAL_APPROVE", "APPROVE_WITH_LIMITS"]).toContain(cap.outcome);
        const ads = (await ok(R.econ(A, "vendor.register", { vendorName: "Ad network", category: "advertising", reference: "https://ads.example/billing" }))).destinationId;
        await ok(R.econ(A, "envelope.spend", { envelopeId: cap.envelope.envelopeId, amountMinor: 3_000, destinationId: ads, purpose: "first campaign", idempotencyKey: `env:${crypto.randomUUID()}` }));
        // A also reinvests its OWN earned capital in the same channel: its decision, custody-checked, no owner step.
        const before = Number((await R.one(`fleet.fleet_agent_economics($1)`, [A.id])).expensePurchasingCapacity);
        expect(await R.gw.spendRequest(A.id, A.token, { idempotencyKey: `own:${crypto.randomUUID()}`, amountCents: 4_000, category: "expense", destinationId: ads, purpose: "reinvest own profit in ads" }))
          .toMatchObject({ ok: true, order: { status: "reserved" } });
        expect(Number((await R.one(`fleet.fleet_agent_economics($1)`, [A.id])).expensePurchasingCapacity)).toBe(before - 4_000);
        // C asks for Fleet capital for its failed path: negative expected value — FleetController declines; nobody rescues it.
        expect(await R.econ(C, "capital.request", { idempotencyKey: `cap:${crypto.randomUUID()}`, ventureKey: "cv-templates", purpose: "rescue", amountMinor: 50_000,
          evidence: [ev("note", "none")], expectedRevenueMinor: 0, expectedNetMinor: -1_000, downsideMinor: 50_000, confidenceBp: 2000 })).toMatchObject({ outcome: "REJECT" });
      }
      // Day 20: B expands with a concrete hypothesis — a child venture (wholesale) of its operating poster shop.
      if (day === 20) {
        await ok(R.econ(B, "decision.record", { key: "d-wholesale", purpose: "expand_venture", question: "Add wholesale to gift shops?", selected: "wholesale channel",
          evidence: [ev("customer_pain", "shops asked for bulk prints")], forecastRevenueMinor: 30_000, capitalExposedMinor: 0, nextAction: "open wholesale" }));
        await ok(R.econ(B, "venture.create", { key: "botanical-wholesale", parentVentureKey: "botanical-posters", model: "physical_product", offer: "wholesale botanical prints",
          state: "validating", reason: "expansion" }));
      }
      // FleetController's daily controller work: envelopes and tax.
      await svc.query(`SELECT fleet.svc_capital_reap(100)`);
      if (day % 7 === 0) await svc.query(`SELECT fleet.svc_tax_true_up(100)`);
      log.push(`day ${day}: ${JSON.stringify(s)}`);
    }
    // ── Day 30: outcomes measured from the ledger; FleetController sweeps realized after-tax profit.
    await ok(R.econ(B, "decision.outcome", { key: "d-botanical-posters", lessons: "Botanical prints sell ~1/day at £25 after a 7-day lead time." }));
    await ok(R.econ(C, "decision.outcome", { key: "d-cv-templates", lessons: "Pivot to templates sold within 6 days." }));
    await svc.query(`SELECT fleet.svc_tax_true_up(100)`);
    const sweep = (await svc.query(`SELECT fleet.svc_sweep_run('2026-10-31') AS r`)).rows[0].r;
    expect(sweep).toMatchObject({ ok: true, enabled: true });
    expect(sweep.swept).toBeGreaterThan(0);
  }, 240_000);

  it("no owner action, no owner wait and no global blocker: the only dependency blocks one action", async () => {
    const ownerEvents = await R.q(`SELECT event_type, actor FROM fleet.fleet_events WHERE created_at > $1 AND actor LIKE 'operator:%'`, [start]);
    expect(ownerEvents).toEqual([]);
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_admin_instructions WHERE created_at > $1`, [start]))[0].n).toBe(0);
    const deps = await R.q(`SELECT agent_id, kind, blocks_action, status, action FROM fleet.fleet_owner_requests`);
    expect(deps).toEqual([expect.objectContaining({ agent_id: A.id, kind: "kyc", blocks_action: true, status: "pending" })]);
    // The founder with the unresolved dependency earned throughout.
    expect(Number((await R.one(`fleet.fleet_agent_economics($1)`, [A.id])).externalCustomerRevenue)).toBeGreaterThan(40_000);
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_payment_orders WHERE status = 'awaiting_owner'`))[0].n).toBe(0);
  });

  it("decisions executed into ventures; a weak venture failed and closed, a strong one scaled, a pivot and an expansion followed", async () => {
    const v = Object.fromEntries((await R.q(`SELECT venture_key, state, parent_venture_id IS NOT NULL AS child FROM fleet.fleet_ventures`)).map((x) => [x.venture_key, x]));
    expect(v["landlord-tracker"].state).toBe("scaling");
    expect(v["botanical-posters"].state).toBe("operating");
    expect(v["seo-audits"].state).toBe("closed");
    expect(v["cv-templates"].state).toBe("operating");
    expect(v["botanical-wholesale"]).toMatchObject({ state: "validating", child: true });
    const hist = (await R.q(`SELECT to_state FROM fleet.fleet_venture_transitions t JOIN fleet.fleet_ventures v USING (venture_id) WHERE v.venture_key = 'seo-audits' ORDER BY seq`)).map((x) => x.to_state);
    expect(hist).toEqual(["selected", "building", "launching", "operating", "failed", "closed"]);
    // Research was bounded and ended in decisions: shortlists small, every candidate decided or converted.
    for (const who of [A, B, C]) {
      expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_opportunities WHERE agent_id = $1`, [who.id]))[0].n).toBeLessThanOrEqual(5);
      expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_opportunities WHERE agent_id = $1 AND status = 'shortlisted'`, [who.id]))[0].n).toBeLessThanOrEqual(5);
    }
  });

  it("the books reconcile: ledger, every settlement, venture → agent attribution and envelopes", async () => {
    const rec = await R.one(`fleet.fleet_reconcile()`);
    expect(rec.ok).toBe(true);
    const by = Object.fromEntries(rec.findings.map((f: { code: string }) => [f.code, f]));
    expect(by.SETTLEMENT_JOURNALS.detail).toEqual({ mismatched: 0 });
    expect(by.UNATTRIBUTED_TRANSACTIONS.detail).toEqual({ count: 1, grossMinor: 700 }); // the orphan, never guessed
    // Σ settled sale gross = Σ venture revenue; per agent, venture revenue ≤ the agent's revenue.
    const sales = Number((await R.q(`SELECT COALESCE(sum(gross_minor), 0) AS s FROM fleet.fleet_external_transactions WHERE status = 'settled' AND kind = 'sale'`))[0].s);
    const vrev = Number((await R.q(`SELECT sum((fleet.fleet_venture_financials(venture_id) ->> 'revenueMinor')::bigint) AS s FROM fleet.fleet_ventures`))[0].s);
    expect(vrev).toBe(sales);
    for (const who of [A, B, C]) {
      const eco = await R.one(`fleet.fleet_agent_economics($1)`, [who.id]);
      const agentVentures = Number((await R.q(`SELECT COALESCE(sum((fleet.fleet_venture_financials(venture_id) ->> 'revenueMinor')::bigint - (fleet.fleet_venture_financials(venture_id) ->> 'refundsMinor')::bigint), 0) AS s
                                               FROM fleet.fleet_ventures WHERE agent_id = $1`, [who.id]))[0].s);
      expect(agentVentures).toBe(Number(eco.externalCustomerRevenue));
    }
    const h = await R.one(`fleet.fleet_economy_health()`);
    expect(Object.fromEntries(h.findings.map((f: { code: string; severity: string }) => [f.code, f.severity])).ENVELOPE_LEDGER).toBe("INFO");
    expect(h.ok).toBe(true);
  });

  it("v33: no configured tax obligation, so nothing was held back — every agent kept its whole net earnings as survival capital; the sweep took only realized net profit", async () => {
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_legal_entities`))[0].n).toBe(0);
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_tax_profiles`))[0].n).toBe(0);
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_ledger_journal WHERE kind = 'tax_reservation'`))[0].n).toBe(0);
    for (const who of [A, B, C]) {
      const w = (await R.econ(who, "wallet")).wallet;
      expect(w.taxReserveMinor).toBe(0);
      expect(w.restricted.taxReserveMinor).toBe(0);
      // Spendable is exactly the agent's own unreserved cash (no synthetic deduction): an order for all of it is accepted.
      const eco = await R.one(`fleet.fleet_agent_economics($1)`, [who.id]);
      expect(Number(w.availableMinor)).toBe(Number(eco.expensePurchasingCapacity));
    }
    const lfc = await R.balance("fleet:profit");
    expect(lfc).toBeGreaterThan(0);
    for (const who of [A, B, C]) {
      const eco = await R.one(`fleet.fleet_agent_economics($1)`, [who.id]);
      expect(Number(eco.lifetimeContribution)).toBeLessThanOrEqual(Math.max(0, Number(eco.realizedNetProfit)));
    }
  });

  it("knowledge improved and forecasts were measured against the ledger", async () => {
    const shared = (await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_economic_knowledge WHERE outcome_backed`))[0].n;
    expect(shared).toBeGreaterThanOrEqual(3);
    for (const who of [A, B, C]) {
      const p = (await R.econ(who, "performance")).performance;
      expect(p.decisions.ledgerBacked).toBeGreaterThanOrEqual(1);
      expect(p.forecast.measured).toBeGreaterThanOrEqual(1);
    }
    // Relative cognition depth: the same £100 is a major exposure for the small wallet and ordinary for the large one.
    expect(await R.one(`fleet.fleet_spend_is_major($1, 10000)`, [C.id])).toBe(true);
    expect(await R.one(`fleet.fleet_spend_is_major($1, 10000)`, [B.id])).toBe(false);
    expect(log).toHaveLength(DAYS);
  });
});

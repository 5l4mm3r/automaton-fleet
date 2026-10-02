/**
 * F2 schema v28 — the agent's own economic records (PostgreSQL, restricted agent role).
 *
 * Opportunities with structured evidence and the AGENT's own ranking; first-class ventures with an explicit state
 * machine and append-only history; ledger-attributed venture financials; decision records with immutable forecasts,
 * ledger-measured outcomes and evidence-only corrections; economic knowledge that is shared fleet-wide only when a
 * ledger-measured outcome backs it; and the agent's own performance record, which no FleetController decision reads.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { PgFleetStore } from "../../fleet/postgres/store.js";
import { FleetService } from "../../fleet/service/server.js";
import { FleetApiClient } from "../../fleet/service/client.js";
import { UnsupportedSandboxTerminator } from "../../fleet/service/terminator.js";

const PG_BIN = findPgBin();
const ev = (kind: string, observation: string, daysAgo = 0) => ({ kind, source: "https://example.test/x", observation,
  observedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString() });

describe.skipIf(!PG_BIN)("F2 v28 economy records: opportunities, ventures, decisions, knowledge (PostgreSQL)", () => {
  let R: EconomyRegistry;
  let F: Founder;
  let G: Founder;

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 5_000 });
    [F, G] = R.founders;
  }, 240_000);
  afterAll(async () => { await R?.close(); });

  it("migrates to the current schema with a clean privilege audit; agents reach the records only through api_economy", async () => {
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
    // The restricted agent role cannot touch a table or call an internal function.
    const agent = new (await import("pg")).default.Pool({ connectionString: R.pgc.agentUrl, max: 1 });
    try {
      for (const sql of [`SELECT * FROM fleet.fleet_opportunities`, `UPDATE fleet.fleet_ventures SET state = 'scaling'`,
        `SELECT fleet.fleet_econ_opportunity_record($1, '{}'::jsonb)`, `SELECT fleet.fleet_agent_performance($1)`]) {
        expect(await R.code(agent.query(sql, sql.includes("$1") ? [F.id] : []))).toBe("permission denied");
      }
    } finally { await agent.end(); }
    expect(await R.econ(F, "no.such.op")).toEqual({ ok: false, code: "FLEET_UNKNOWN_OPERATION" });
    expect(await R.gw.economy(F.id, "wrong-token", "opportunity.list", {})).toMatchObject({ ok: false, code: "FLEET_AUTH_FAILED" });
  });

  it("opportunities: structured evidence and economics; the agent ranks a small shortlist itself; no controller score exists", async () => {
    const r = await R.econ(F, "opportunity.record", { key: "landlord-tracker", type: "digital_product", offer: "UK landlord compliance tracker",
      targetCustomer: "small UK landlords", evidence: [ev("bestseller", "Top-20 Etsy listing, 1.2k sales"), ev("pricing", "£9-£19 band")],
      estMarginBp: 9000, capitalRequiredMinor: 500, timeToRevenueDays: 7, confidenceBp: 6000 });
    expect(r).toMatchObject({ ok: true, created: true, opportunity: { key: "landlord-tracker", status: "candidate", estMarginBp: 9000 } });
    // Updating appends evidence; nothing gathered is lost.
    const u = await R.econ(F, "opportunity.record", { key: "landlord-tracker", evidence: [ev("reviews", "Reviews ask for a deposit-deadline sheet")] });
    expect(u.opportunity.evidence).toHaveLength(3);
    for (const k of ["groomer-income", "etsy-planner", "seo-audit-service", "airbnb-cleaning-checklist", "invoice-template-pack"]) {
      expect((await R.econ(F, "opportunity.record", { key: k, type: "digital_product", offer: k, evidence: [ev("search_demand", `${k} demand`)] })).ok).toBe(true);
    }
    // The shortlist is the agent's ranking; bounded (it exists to produce a decision, not a feed).
    const six = ["landlord-tracker", "groomer-income", "etsy-planner", "seo-audit-service", "airbnb-cleaning-checklist", "invoice-template-pack"];
    expect(await R.econ(F, "opportunity.shortlist", { ranking: six.map((key, i) => ({ key, rank: i + 1 })) })).toMatchObject({ ok: false, code: "FLEET_SHORTLIST_TOO_LONG" });
    expect(await R.econ(F, "opportunity.shortlist", { ranking: [{ key: "landlord-tracker", rank: 1 }, { key: "landlord-tracker", rank: 2 }] })).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" });
    const s = await R.econ(F, "opportunity.shortlist", { ranking: [{ key: "groomer-income", rank: 2 }, { key: "landlord-tracker", rank: 1 }, { key: "etsy-planner", rank: 3 }],
      rationale: "highest purchase evidence first" });
    expect(s.shortlist.map((o: { key: string; rank: number }) => `${o.rank}:${o.key}`)).toEqual(["1:landlord-tracker", "2:groomer-income", "3:etsy-planner"]);
    // Re-ranking replaces the whole shortlist.
    await R.econ(F, "opportunity.shortlist", { ranking: [{ key: "etsy-planner", rank: 1 }] });
    expect((await R.econ(F, "opportunity.list", { status: "shortlisted" })).opportunities.map((o: { key: string }) => o.key)).toEqual(["etsy-planner"]);
    // Rejection with a reason; a rejected candidate is not reopened under the same key.
    expect((await R.econ(F, "opportunity.status", { key: "seo-audit-service", status: "rejected", reason: "service needs live calls; weak margin" })).ok).toBe(true);
    expect(await R.econ(F, "opportunity.record", { key: "seo-audit-service", evidence: [ev("note", "again")] })).toMatchObject({ ok: false, code: "FLEET_OPPORTUNITY_CLOSED" });
    // No score, weight or ranking column exists that FleetController could fill.
    const cols = (await R.q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'fleet' AND table_name = 'fleet_opportunities'`)).map((c) => c.column_name);
    expect(cols.filter((c) => /score|weight|controller/.test(c))).toEqual([]);
    // Another agent sees none of this.
    expect((await R.econ(G, "opportunity.list", {})).opportunities).toEqual([]);
  });

  it("stale evidence: candidates older than the freshness window drop off the shortlist and return with fresh evidence", async () => {
    await R.econ(F, "opportunity.record", { key: "old-niche", type: "service", offer: "old niche", evidence: [ev("ranking", "ranked once", 45)] });
    await R.econ(F, "opportunity.shortlist", { ranking: [{ key: "old-niche", rank: 1 }] }).then((x) => expect(x).toMatchObject({ ok: false, code: "FLEET_NOT_A_CANDIDATE" }));
    expect((await R.econ(F, "opportunity.list", { status: "stale" })).opportunities.map((o: { key: string }) => o.key)).toContain("old-niche");
    const re = await R.econ(F, "opportunity.record", { key: "old-niche", evidence: [ev("ranking", "still ranked today")] });
    expect(re.opportunity).toMatchObject({ status: "candidate", statusReason: "re-verified with fresh evidence" });
    expect(await R.econ(F, "opportunity.record", { key: "bad", evidence: [{ kind: "vibes", observation: "x" }] })).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" });
    expect(await R.econ(F, "opportunity.record", { key: "bad", offer: "x", capitalRequiredMinor: 1.5 })).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" });
  });

  it("ventures: created from an opportunity (converting it), moved by the agent through its state machine with append-only history; no owner state exists", async () => {
    const v = await R.econ(F, "venture.create", { key: "landlord-tracker", opportunityKey: "landlord-tracker", state: "selected", reason: "strongest purchase evidence" });
    expect(v).toMatchObject({ ok: true, venture: { key: "landlord-tracker", model: "digital_product", state: "selected", opportunityKey: "landlord-tracker" } });
    expect((await R.econ(F, "opportunity.list", { status: "converted" })).opportunities[0]).toMatchObject({ key: "landlord-tracker", ventureKey: "landlord-tracker" });
    // Replay is idempotent.
    expect(await R.econ(F, "venture.create", { key: "landlord-tracker" })).toMatchObject({ ok: true, replayed: true });
    const move = (to: string, extra: Record<string, unknown> = {}) => R.econ(F, "venture.transition", { key: "landlord-tracker", to, reason: `to ${to}`, ...extra });
    expect(await move("scaling")).toMatchObject({ ok: false, code: "FLEET_VENTURE_TRANSITION" });
    expect((await move("building")).venture.state).toBe("building");
    expect((await move("launching")).venture.state).toBe("launching");
    // Facts, not approvals: operating names a channel; scaling needs ledger-backed profit.
    expect(await move("operating")).toMatchObject({ ok: false, code: "FLEET_VENTURE_EVIDENCE" });
    expect((await move("operating", { channels: ["direct storefront", "etsy"] })).venture).toMatchObject({ state: "operating", channels: ["direct storefront", "etsy"] });
    expect(await move("scaling")).toMatchObject({ ok: false, code: "FLEET_VENTURE_EVIDENCE" });
    // No state, rule or column routes to the owner.
    const states = (await R.q(`SELECT DISTINCT to_state AS s FROM fleet.fleet_venture_transition_rules UNION SELECT DISTINCT from_state FROM fleet.fleet_venture_transition_rules`)).map((x) => x.s);
    expect(states.filter((s) => /owner|approv|await/.test(s))).toEqual([]);
    // The state column cannot be written around the state machine, and history is append-only.
    expect(await R.code(R.q(`UPDATE fleet.fleet_ventures SET state = 'scaling' WHERE agent_id = $1`, [F.id]))).toBe("FLEET_VENTURE_TRANSITION");
    expect(await R.code(R.q(`DELETE FROM fleet.fleet_venture_transitions`))).toMatch(/FLEET_HISTORY_IMMUTABLE|FLEET_IMMUTABLE/);
    const hist = (await R.econ(F, "venture.status", { key: "landlord-tracker" })).venture.transitions.map((t: { to: string }) => t.to);
    expect(hist).toEqual(["operating", "launching", "building", "selected"]);
  });

  it("venture financials are derived from ledger journals attributed to the venture; attribution is scoped to the venture's own agent", async () => {
    const vid = (await R.q(`SELECT venture_id FROM fleet.fleet_ventures WHERE agent_id = $1 AND venture_key = 'landlord-tracker'`, [F.id]))[0].venture_id;
    const rev = await R.ledger.recordRevenue(F.id, 4500, `sale:${crypto.randomUUID()}`, `customer-${crypto.randomUUID()}`, OWNER);
    await R.one(`fleet.fleet_admin_venture_attribute($1, $2, 'revenue', $3)`, [rev, vid, OWNER]);
    const f = (await R.econ(F, "venture.status", { key: "landlord-tracker" })).venture.financials;
    expect(f).toMatchObject({ revenueMinor: 4500, netProfitMinor: 4500, refundsMinor: 0, capitalDeployedMinor: 0 });
    // A journal of another agent can never be attributed to this venture.
    const otherRev = await R.ledger.recordRevenue(G.id, 100, `sale:${crypto.randomUUID()}`, `customer-${crypto.randomUUID()}`, OWNER);
    expect(await R.code(R.one(`fleet.fleet_admin_venture_attribute($1, $2, 'revenue', $3)`, [otherRev, vid, OWNER]))).toBe("FLEET_ATTRIBUTION_SCOPE");
    // A reversal counts against the same venture automatically.
    await R.one(`fleet.fleet_admin_reverse($1, $2, 'test correction', $3)`, [rev, OWNER, `rvs:${crypto.randomUUID()}`]);
    expect((await R.econ(F, "venture.status", { key: "landlord-tracker" })).venture.financials).toMatchObject({ revenueMinor: 0, netProfitMinor: 0 });
    const again = await R.ledger.recordRevenue(F.id, 4500, `sale:${crypto.randomUUID()}`, `customer-${crypto.randomUUID()}`, OWNER);
    await R.one(`fleet.fleet_admin_venture_attribute($1, $2, 'revenue', $3)`, [again, vid, OWNER]);
    // Now scaling is a fact-backed move.
    expect((await R.econ(F, "venture.transition", { key: "landlord-tracker", to: "scaling", reason: "profitable" })).venture.state).toBe("scaling");
  });

  it("decisions: the forecast is immutable; a venture-linked outcome is measured from the ledger, not claimed; lessons become knowledge", async () => {
    const d = await R.econ(F, "decision.record", { key: "d-launch-tracker", purpose: "launch", question: "Launch the tracker at £9 on a direct storefront?",
      selected: "launch at £9 direct", alternatives: [{ option: "Gumroad", reason: "needs KYC (one action)" }, { option: "£19 price", reason: "weaker evidence" }],
      evidence: [ev("pricing", "£9 is the modal price")], ventureKey: "landlord-tracker", forecastRevenueMinor: 3000, forecastCostMinor: 200,
      forecastDaysToRevenue: 7, confidenceBp: 6000, capitalExposedMinor: 200, downside: "£2 of listing fees", invalidatedBy: "no sale in 14 days", nextAction: "publish the storefront" });
    expect(d).toMatchObject({ ok: true, decision: { key: "d-launch-tracker", revision: 1, forecast: { revenueMinor: 3000 }, capitalExposedMinor: 200 } });
    expect(await R.code(R.q(`UPDATE fleet.fleet_decision_records SET forecast_revenue_minor = 1 WHERE decision_key = 'd-launch-tracker'`))).toBe("FLEET_IMMUTABLE");
    const vid = (await R.q(`SELECT venture_id FROM fleet.fleet_ventures WHERE agent_id = $1 AND venture_key = 'landlord-tracker'`, [F.id]))[0].venture_id;
    const sale = await R.ledger.recordRevenue(F.id, 2400, `sale:${crypto.randomUUID()}`, `customer-${crypto.randomUUID()}`, OWNER);
    await R.one(`fleet.fleet_admin_venture_attribute($1, $2, 'revenue', $3)`, [sale, vid, OWNER]);
    // The agent's claimed numbers are ignored for a venture-linked decision: the ledger is the measurement.
    const m = await R.econ(F, "decision.outcome", { key: "d-launch-tracker", actualRevenueMinor: 999999, lessons: "Direct storefront converts; £9 is accepted." });
    expect(m.decision.outcome).toMatchObject({ source: "ledger", revenueMinor: 2400, revenueErrorBp: -2000, daysToRevenue: 0 });
    expect(await R.code(R.q(`UPDATE fleet.fleet_decision_records SET lessons = 'x' WHERE decision_key = 'd-launch-tracker'`))).toBe("FLEET_IMMUTABLE");
    // Shared fleet-wide because a ledger-measured outcome backs it.
    const seen = await R.econ(G, "knowledge.search", { query: "storefront" });
    expect(seen.knowledge).toEqual([expect.objectContaining({ outcomeBacked: true, own: false, topic: "assumption_succeeded" })]);
  });

  it("corrections are new revisions resting on new evidence; no evidence, the same path or a return to an abandoned path are refused", async () => {
    await R.econ(F, "decision.record", { key: "d-channel", purpose: "select_opportunity", question: "Which channel first?", selected: "etsy",
      evidence: [ev("channel", "etsy has the buyers")], forecastRevenueMinor: 1000, nextAction: "list on etsy" });
    expect(await R.econ(F, "decision.correct", { key: "d-channel", selected: "direct", correction: "fees", nextAction: "x" })).toMatchObject({ code: "FLEET_CORRECTION_UNSUPPORTED" });
    expect(await R.econ(F, "decision.correct", { key: "d-channel", selected: "Etsy", correction: "x", nextAction: "x", evidence: [ev("note", "n")] })).toMatchObject({ code: "FLEET_NOT_A_CORRECTION" });
    const c = await R.econ(F, "decision.correct", { key: "d-channel", selected: "direct storefront", correction: "Etsy fee rise to 9.5% erases the margin",
      evidence: [ev("pricing", "Etsy fee notice: 9.5% from November")], nextAction: "publish the direct storefront" });
    expect(c.decision).toMatchObject({ revision: 2, selected: "direct storefront", correction: expect.stringContaining("9.5%") });
    expect(c.decision.alternatives).toEqual(expect.arrayContaining([{ option: "etsy", reason: "abandoned on new evidence" }]));
    expect(await R.econ(F, "decision.correct", { key: "d-channel", selected: "etsy", correction: "back", nextAction: "x", evidence: [ev("note", "n")] })).toMatchObject({ code: "FLEET_OSCILLATION" });
    // An unlinked decision is measured from the agent's report: not outcome-backed. v35: the whole Fleet still sees it
    // (knowledge compounds), flagged as another agent's, unbacked entry so G can weigh it.
    const m = await R.econ(F, "decision.outcome", { key: "d-channel", actualRevenueMinor: 800, actualCostMinor: 50, lessons: "own storefront ok" });
    expect(m.decision.outcome).toMatchObject({ source: "agent_reported", revenueMinor: 800, revenueErrorBp: -2000 });
    expect((await R.econ(G, "knowledge.search", { query: "own storefront" })).knowledge).toEqual([expect.objectContaining({ own: false, fleetShared: true, outcomeBacked: false })]);
    expect((await R.econ(F, "knowledge.search", { query: "own storefront" })).knowledge).toEqual([expect.objectContaining({ own: true, outcomeBacked: false })]);
  });

  it("knowledge: recorded by the agent, superseded (never deleted), fresh only; shared Fleet-wide and flagged (v35)", async () => {
    await R.econ(F, "knowledge.record", { topic: "vendor", subject: "printful/a4-posters", claim: "Printful A4 poster unit cost £6.20 incl. delivery", confidenceBp: 8000 });
    await R.econ(F, "knowledge.record", { topic: "vendor", subject: "printful/a4-posters", claim: "Printful A4 poster unit cost £6.50 incl. delivery (Oct price rise)" });
    const k = await R.econ(F, "knowledge.search", { topic: "vendor" });
    expect(k.knowledge.map((x: { claim: string }) => x.claim)).toEqual(["Printful A4 poster unit cost £6.50 incl. delivery (Oct price rise)"]);
    expect(await R.code(R.q(`DELETE FROM fleet.fleet_economic_knowledge`))).toBe("FLEET_IMMUTABLE");
    expect((await R.econ(G, "knowledge.search", { topic: "vendor" })).knowledge.map((x: { claim: string; own: boolean }) => [x.claim, x.own]))
      .toEqual([["Printful A4 poster unit cost £6.50 incl. delivery (Oct price rise)", false]]);
    expect(await R.econ(F, "knowledge.search", {})).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" });
  });

  it("performance is the agent's own record (forecast accuracy, ventures, ROI) and no FleetController function reads it", async () => {
    const p = (await R.econ(F, "performance")).performance;
    expect(p.decisions).toMatchObject({ measured: 2, corrected: 1, ledgerBacked: 1 });
    expect(p.forecast).toMatchObject({ measured: 2, revenueMeanAbsErrorBp: 2000, revenueBiasBp: -2000, withinToleranceBp: 10000 });
    expect(p.ventures).toMatchObject({ active: 1, profitable: 1, failed: 0 });
    const readers = (await R.q(`SELECT p.proname AS n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
                                WHERE s.nspname = 'fleet' AND p.prosrc ~ 'fleet_agent_performance' ORDER BY 1`)).map((r) => r.n);
    // Readers: the agent's own view, the admin Hub, and FleetController's LENDER decision on Fleet capital (track record is a
    // legitimate input there). No own-capital decision reads it: custody, the breaker and experiments never do.
    expect(readers).toEqual(["api_economy", "fleet_capital_decide", "fleet_hub"]);
    const ownCapital = (await R.q(`SELECT p.proname AS n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'fleet'
      AND p.proname IN ('api_spend_request','fleet_spend_custody_check','fleet_order_hard_check','fleet_spend_circuit_breaker_check','fleet_experiment_evaluate',
                        'fleet_econ_envelope_spend') AND p.prosrc ~ '(performance|forecast|roi)'`)).map((r) => r.n);
    expect(ownCapital).toEqual([]);
  });

  it("failsafes are infrastructure ceilings (never budgets): a hit refuses, is recorded as telemetry, and names no figure", async () => {
    await R.q(`UPDATE fleet.fleet_economy_policy SET failsafe_records_per_day = 10`);
    try {
      let last: Record<string, any> = {};
      for (let i = 0; i < 12 && last.code !== "FLEET_INFRASTRUCTURE_CEILING"; i++) {
        last = await R.econ(G, "knowledge.record", { topic: "demand", subject: `s-${i}`, claim: "c" });
      }
      expect(last).toMatchObject({ ok: false, code: "FLEET_INFRASTRUCTURE_CEILING" });
      expect(String(last.reason)).not.toMatch(/[0-9]/);
      expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_events WHERE event_type = 'economy_failsafe' AND agent_id = $1`, [G.id]))[0].n).toBeGreaterThan(0);
    } finally { await R.q(`UPDATE fleet.fleet_economy_policy SET failsafe_records_per_day = 400`); }
  });

  it("over HTTP (/v1/economy): session-authenticated, signed, op allow-listed by the database; refusals arrive as data with their reason", async () => {
    const svcStore = new PgFleetStore({ connectionString: R.pgc.serviceUrl });
    const audited: Array<{ event: string; detail: Record<string, unknown> }> = [];
    const service = new FleetService({ admin: svcStore, agent: R.gw, realReplicationEnabled: false, reaperIntervalMs: 0,
      release: { repo: "https://github.com/5l4mm3r/automaton-fleet", commit: "c".repeat(40), buildId: "d".repeat(64), lockfileSha256: "e".repeat(64) },
      audit: (e) => { audited.push({ event: e.event, detail: e.detail as Record<string, unknown> }); }, terminator: new UnsupportedSandboxTerminator(),
      cognitionProviderFactory: () => { throw new Error("no inference in this test"); } });
    const url = (await service.listen(0, "127.0.0.1")).url;
    try {
      const client = new FleetApiClient({ baseUrl: url, agentId: G.id, token: G.token });
      expect(await client.economy("venture.create", { key: "http-venture", model: "service", offer: "via http", state: "selected" })).toMatchObject({ ok: true, venture: { key: "http-venture" } });
      // A refusal is data with its reason (the founder acts on it); it never throws.
      expect(await client.economy("venture.transition", { key: "http-venture", to: "scaling", reason: "x" })).toMatchObject({ ok: false, code: "FLEET_VENTURE_TRANSITION",
        reason: expect.stringContaining("is not a venture transition") });
      expect(await client.economy("no.such", {})).toMatchObject({ ok: false, code: "FLEET_UNKNOWN_OPERATION" });
      expect(await client.economy("bad op!", {})).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" });
      expect((await client.economyBrief()) as Record<string, unknown>).toMatchObject({ ventures: [expect.objectContaining({ key: "http-venture" })] });
      // Another founder's records are not reachable through G's session.
      expect(await client.economy("venture.status", { key: "landlord-tracker" })).toMatchObject({ ok: false, code: "FLEET_NOT_FOUND" });
      // A forged identity cannot even be constructed (the credential names its agent); the server re-checks every session.
      expect(() => new FleetApiClient({ baseUrl: url, agentId: F.id, token: G.token })).toThrow(/does not belong/);
      // Telemetry is metadata only: op and outcome code, never arguments.
      const ev = audited.filter((a) => a.event === "economy_op");
      expect(ev.length).toBeGreaterThan(0);
      expect(JSON.stringify(ev)).not.toMatch(/via http|http-venture/);
    } finally {
      await service.close();
      await svcStore.close();
    }
  });

  it("a held agent is refused; the economy functions contain no owner route", async () => {
    await R.q(`SELECT fleet.fleet_agent_hold_set($1, 'investigation', $2)`, [G.id, OWNER]);
    try {
      expect(await R.econ(G, "opportunity.list")).toEqual({ ok: false, code: "FLEET_AGENT_HELD" });
    } finally { await R.q(`SELECT fleet.fleet_agent_hold_release($1, $2)`, [G.id, OWNER]); }
    const src = (await R.q(`SELECT string_agg(p.prosrc, E'\\n') AS s FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                           WHERE n.nspname = 'fleet' AND (p.proname LIKE 'fleet\\_econ\\_%' OR p.proname IN ('api_economy','fleet_venture_move'))`))[0].s as string;
    expect(src).not.toMatch(/owner_request|awaiting_owner|owner approv|operator:owner|fleet_require_operator_approver/i);
  });
});

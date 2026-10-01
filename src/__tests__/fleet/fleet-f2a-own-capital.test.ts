/**
 * F2 Phase A — own capital is the founder's to risk-manage; FleetController is its custodian (schema v27).
 *
 * The legacy spend policy routed every own-capital order above 100.00 per order or 50.00 per day to the owner
 * (`awaiting_owner` / FLEET_OWNER_APPROVAL_REQUIRED). v27 retires that route: the founder sizes its own exposure under a
 * decided decision (its runtime refuses commitments beyond it; more exposure needs a review on new evidence), and
 * FleetController checks CUSTODY only — protected and tax-reserved capital, other agents' and Treasury money, holds,
 * freezes, destinations, and an infrastructure circuit breaker with relative, unset-by-default signals. Every refusal
 * names its custody category and creates nothing for anyone to decide.
 *
 * These tests drive the production founder runtime (toolbox, mind, decision ledger) with scripted cognition and check
 * the registry's SQL as text. The registry's behaviour on a real database is fleet-ledger.test.ts (v27 spend, custody
 * refusals, tax reserve, circuit breaker) and fleet-f2a-pg.test.ts (the v25 → v27 retirement of a legacy owner-route
 * order); both need PostgreSQL.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { FounderMind, MAX_IDLE_SKIP, type MindPorts } from "../../fleet/founder/mind.js";
import { loadDecisions, ownCapitalLine, type Decision } from "../../fleet/founder/decisions.js";
import { FounderToolbox } from "../../fleet/founder/toolbox.js";
import { LoopGuard } from "../../fleet/founder/loop-guard.js";
import { FOUNDER_MANIFEST_V2, manifestSha256 } from "../../fleet/capabilities.js";
import { FOUNDER_CHARTER, FOUNDER_EXPERIMENT_TOOLS, FOUNDER_ROUTED_ADDENDUM, FOUNDER_TOOLS, type ToolCall } from "../../fleet/cognition/types.js";
import { PACKET_POLICY } from "../../fleet/cognition/task-packet.js";
import { capabilityView } from "../../fleet/cognition/capability-signature.js";
import { CUSTODY_REFUSAL_CODES, custodyCategory, custodyRefusalText, type CustodyCategory } from "../../fleet/custody-refusals.js";
import { V26_SQL } from "../../fleet/postgres/migrations-phase26.js";
import { V27_SQL } from "../../fleet/postgres/migrations-phase27.js";
import { AGENT_API_FUNCTIONS, FLEET_PG_SCHEMA_VERSION, PG_MIGRATIONS } from "../../fleet/postgres/migrations.js";
import { runLedgerCommand } from "../../fleet/treasury/ledger-cli.js";
import type { PgLedgerAdmin } from "../../fleet/treasury/ledger.js";
import { loadFleetConfig } from "../../fleet/config.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "f2a-cap-"));
/** Founder-facing words that would make the owner an approver of ordinary spending. */
const OWNER_SPEND = /owner decides|owner approv|ask the owner|awaiting (the )?owner|wait(ing)? for (the )?owner|owner must|owner queue|policy and the owner/i;
const code = (sql: string) => sql.replace(/--[^\n]*/g, "");

/** The latest definition of every SQL function across the migrations, in order (a later CREATE OR REPLACE wins). */
function latestFunctions(): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of PG_MIGRATIONS) {
    const re = /CREATE (?:OR REPLACE )?FUNCTION ([a-z0-9_]+)\(/g;
    let x: RegExpExecArray | null;
    while ((x = re.exec(m.sql))) {
      const open = m.sql.indexOf("$$", x.index);
      const close = m.sql.indexOf("$$", open + 2);
      out.set(x[1], m.sql.slice(x.index, close + 2));
    }
  }
  return out;
}
const FNS = latestFunctions();
const fn = (name: string) => { const f = FNS.get(name); if (!f) throw new Error(`no function ${name}`); return f; };

const decisionArgs = (o: Record<string, unknown> = {}) => ({ key: "tracker-ads", purpose: "expand_venture", objective: "Grow tracker revenue to £600 a month",
  question: "Should I buy a landlord-forum sponsorship to reach buyers?", hypothesis: "Forum sponsorship converts landlords at 2 % or better",
  options: ["forum sponsorship", "marketplace ads"], stopAfterFetches: 2, stopWhen: "conversion data for one comparable placement", ...o });
const resolveArgs = (o: Record<string, unknown> = {}) => ({ key: "tracker-ads", selected: "forum sponsorship", ranking: ["forum sponsorship", "marketplace ads"],
  rejected: [{ option: "marketplace ads", reason: "lower purchase intent per pound in the comparable data" }], rationale: "Comparable placements converted at 2.4 %.",
  expectedOutcome: "40 sales in 30 days at £9 (£360)", capitalAtRiskPence: 30_000, downside: "Up to 300.00 of sponsorship with no sales; no recurring commitment",
  invalidatedBy: "Fewer than 10 sales after the first 14 days", nextAction: "Book the landlord-forum sponsorship for 30 days", ...o });

function toolbox(o: { spend?: (order: Record<string, unknown>) => unknown } = {}) {
  const root = tmp();
  const dirs = { w: path.join(root, "w"), m: path.join(root, "m") };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const calls = { spend: [] as Array<Record<string, unknown>>, other: 0, ownerRequest: 0 };
  const box = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: dirs.w, memoryDir: dirs.m, loopGuard: new LoopGuard(), selfGovernance: true, ports: {
    ledger: async () => { calls.other++; return {}; },
    spendOrder: async (order: Record<string, unknown>) => { calls.spend.push(order); return o.spend ? o.spend(order) : { ok: true, code: null, custody: null, order: { status: "reserved" } }; },
    proposeKnowledge: async () => { calls.other++; return {}; }, knowledge: async () => [], requestIdentityFact: async () => { calls.other++; return {}; },
    ownerRequestCreate: async () => { calls.ownerRequest++; return { ok: true }; }, ownerRequestWithdraw: async () => { calls.ownerRequest++; return { ok: true }; },
    researchFetch: async () => { throw new Error("no research in these tests"); },
  } as never });
  let id = 0;
  const run = (name: string, args: Record<string, unknown>) => box.execute({ id: `t${++id}`, name, arguments: args });
  return { run, calls, dirs };
}

/** A routed founder mind whose ledger view (its wallet) is chosen by the test. */
function mindWith(economics: Record<string, unknown>, decisions: Decision[] = []) {
  const root = tmp();
  const dirs = { w: path.join(root, "w"), s: path.join(root, "s"), m: path.join(root, "s", "memory") };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(dirs.m, "goals.json"), JSON.stringify([{ id: "g1", title: "Book the landlord-forum sponsorship for 30 days", status: "open" }]));
  if (decisions.length) fs.writeFileSync(path.join(dirs.m, "decisions.json"), JSON.stringify(decisions));
  const packets: string[] = [];
  const ports: MindPorts = {
    cognitionStatus: async () => ({ policyEnabled: true, provider: "anthropic", founderEnabled: true, paused: false, routing: { active: true },
      capabilities: capabilityView({ ok: true, origin: "genesis_founder", manifestId: "founder-v2", manifestSha256: manifestSha256(FOUNDER_MANIFEST_V2),
        allowed: [...FOUNDER_MANIFEST_V2.allowed], reproductionExecutable: false, paymentExecutable: false, ownerRequests: true }, true),
      survival: { survivalEquityCents: Number(economics.survivalEquity ?? 0), inferenceTodayCents: 10, burnPerDayCents: 40, runwayDays: 100 } }),
    ledger: async () => economics,
    infer: async (messages) => {
      packets.push(String((messages as Array<{ content: string }>)[0].content));
      return { content: "", toolCalls: [{ id: `s${packets.length}`, name: "sleep", arguments: { reason: "x" } }] as ToolCall[], usage: { inputTokens: 1, outputTokens: 1 }, chargedCents: 0, requestId: "r" };
    },
  };
  const loopGuard = new LoopGuard();
  const toolbox = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: dirs.w, memoryDir: dirs.m, loopGuard, selfGovernance: true, ports: {
    ledger: async () => economics, spendOrder: async () => ({}), proposeKnowledge: async () => ({}), knowledge: async () => [], requestIdentityFact: async () => ({}),
  } as never });
  const mind = new FounderMind({ ports, toolbox, stateDir: dirs.s, routed: { memoryDir: dirs.m, workspaceDir: dirs.w, manifest: FOUNDER_MANIFEST_V2, loopGuard } });
  return {
    async packet() {
      const before = packets.length;
      for (let i = 0; i <= MAX_IDLE_SKIP + 1 && packets.length === before; i++) await mind.turn(`heartbeat ${i}`);
      const body = JSON.parse(packets.at(-1)!.split("\n").slice(3).join("\n"));
      return { task: String(body.task), economics: body.economics as Record<string, unknown> };
    },
  };
}

/** A decided decision with two measured results (one confirmed, one corrected), as the founder's own ledger keeps them. */
const decidedHistory = (): Decision[] => [{
  key: "tracker-demand", purpose: "find_opportunity", objective: "First £200 of tracker revenue", question: "Is there demand for the tracker at £9?", hypothesis: "Templates sell at £5–£15",
  options: ["direct checkout page", "Etsy listing"], stop: { maxFetches: 2, when: "two purchase signals" }, status: "decided", openedAt: "2026-09-20T00:00:00Z", research: [],
  outcome: { selected: "Etsy listing", ranking: ["Etsy listing"], rejected: [], rationale: "r", expectedOutcome: "first sale in 14 days", nextAction: "list it", capitalAtRiskPence: 1_500,
    downside: "listing fees", invalidatedBy: "no sale in 21 days", committedPence: 900, goalId: "g1", decidedAt: "2026-09-21T00:00:00Z" },
  reviews: [
    { at: "2026-09-25T00:00:00Z", verdict: "corrected", actual: "0 sales on the direct page", learning: "buyers use marketplaces", evidence: ["checkout: 64 visitors, 0 purchases"], nextAction: "list on Etsy",
      goalId: "g1", previousPath: "direct checkout page", newPath: "Etsy listing", failedAssumption: "direct buyers exist", impact: "first sale moves closer" },
    { at: "2026-09-30T00:00:00Z", verdict: "confirmed", actual: "11 sales in 14 days at £9", learning: "marketplace demand holds", evidence: [], nextAction: "add an HMO edition", goalId: "g1" },
  ],
}];

describe("F2-A v27: the owner spend route and the fixed 100.00 / 50.00 lines are retired from own-capital spending", () => {
  it("(1, 2, 5) the registry's spend decision reads no nominal threshold and has no owner branch; nothing in the latest SQL routes spend to the owner", () => {
    expect(FLEET_PG_SCHEMA_VERSION).toBe(27);
    expect(PG_MIGRATIONS.at(-1)).toMatchObject({ version: 27, name: "f2a_own_capital_custody_circuit_breaker", sql: V27_SQL });
    const spend = code(fn("api_spend_request"));
    expect(V27_SQL).toContain("CREATE OR REPLACE FUNCTION api_spend_request(");
    expect(spend).not.toMatch(/owner_approval_threshold_cents|agent_daily_spend_cents|awaiting_owner|FLEET_OWNER_APPROVAL_REQUIRED|v_today|interval '1 day'/);
    // The only comparisons of the amount with a number are the request's validity bounds (0 and the 1e11 absolute cap).
    expect(spend.match(/p_amount_cents\s*[<>]=?\s*\d+/g)).toEqual(["p_amount_cents <= 0", "p_amount_cents > 100000000000"]);
    expect(spend).toMatch(/v_refusal := fleet_spend_custody_check\(o\)/);
    expect(spend).toMatch(/fleet_order_reserve\(o, 'controller', 'controller', 'controller', 'FLEET_CUSTODY_CLEARED'/);
    // Repository-wide (latest definitions): the retired columns are read only by the policy-identity hash (kept so earlier
    // economic-policy seals stay comparable); no function sets an order awaiting the owner or names the owner-approval code.
    const readers = [...FNS].filter(([, src]) => /owner_approval_threshold_cents|agent_daily_spend_cents/.test(code(src))).map(([n]) => n);
    expect(readers).toEqual(["fleet_economic_policy_sha256"]);
    for (const [name, src] of FNS) {
      expect(code(src), name).not.toMatch(/SET status = 'awaiting_owner'|status := 'awaiting_owner'|FLEET_OWNER_APPROVAL_REQUIRED|payment_order_awaiting_owner/);
    }
    // The owner decision is retired, legacy rows are cancelled (never decided), and a CHECK makes the state unreachable.
    expect(code(fn("fleet_admin_spend_decision"))).toMatch(/^[\s\S]*BEGIN\s+RAISE EXCEPTION 'FLEET_OWNER_ROUTE_RETIRED: [^']*';\s+END \$\$$/);
    expect(V27_SQL).toMatch(/UPDATE fleet_payment_orders SET status = 'cancelled', decision_code = 'FLEET_OWNER_ROUTE_RETIRED'[\s\S]*WHERE status = 'awaiting_owner';/);
    expect(V27_SQL).toContain("ALTER TABLE fleet_payment_orders ADD CONSTRAINT fleet_payment_orders_no_owner_route CHECK (status <> 'awaiting_owner');");
    expect(V27_SQL).toMatch(/COMMENT ON COLUMN fleet_economic_model\.owner_approval_threshold_cents IS 'LEGACY \(retired at v27\)/);
    expect(V27_SQL).toMatch(/COMMENT ON COLUMN fleet_economic_model\.agent_daily_spend_cents IS 'LEGACY \(retired at v27\)/);
  });

  it("(3, 6, 12) an order far above 100.00 reaches custody when the founder sized it; unsized or over-sized commitments stop in the founder's own runtime", async () => {
    const t = toolbox();
    await t.run("open_decision", decisionArgs());
    // The founder must size its own exposure: no capital at risk, no decision.
    expect(await t.run("resolve_decision", resolveArgs({ capitalAtRiskPence: undefined }))).toMatchObject({ ok: false, refused: "FLEET_RISK_UNSIZED" });
    expect(await t.run("request_spend", { amountCents: 25_000, category: "expense", destinationId: "dst_forum", purpose: "forum sponsorship" }))
      .toMatchObject({ ok: false, refused: "FLEET_COMMITMENT_UNDECIDED" });
    expect(await t.run("resolve_decision", resolveArgs())).toMatchObject({ ok: true });
    // 250.00 in one order, then 50.00 more the same day: both inside the founder's own sizing, both go to the custodian.
    const big = await t.run("request_spend", { amountCents: 25_000, category: "expense", destinationId: "dst_forum", purpose: "forum sponsorship, 30 days", decisionKey: "tracker-ads" });
    expect(big).toMatchObject({ ok: true });
    expect(await t.run("request_spend", { amountCents: 5_000, category: "expense", destinationId: "dst_forum", purpose: "banner design", decisionKey: "tracker-ads" })).toMatchObject({ ok: true });
    expect(t.calls.spend.map((o) => o.amountCents)).toEqual([25_000, 5_000]);
    expect(loadDecisions(t.dirs.m)[0].outcome).toMatchObject({ capitalAtRiskPence: 30_000, committedPence: 30_000 });
    // Beyond its own sizing: refused by the founder's runtime, before any controller call.
    expect(await t.run("request_spend", { amountCents: 1, category: "fee", destinationId: "dst_forum", purpose: "x", decisionKey: "tracker-ads" }))
      .toMatchObject({ ok: false, refused: "FLEET_EXPOSURE_EXCEEDED" });
    expect(t.calls.spend).toHaveLength(2);
    // More exposure needs a review with NEW evidence; then the commitment fits again.
    const raise = { key: "tracker-ads", verdict: "confirmed", actual: "31 sales in 14 days from the sponsorship", learning: "the forum converts at 2.6 %", nextAction: "extend the sponsorship" };
    expect(await t.run("review_decision", { ...raise, capitalAtRiskPence: 60_000 })).toMatchObject({ ok: false, refused: "FLEET_EXPOSURE_UNSUPPORTED" });
    expect(await t.run("review_decision", { ...raise, capitalAtRiskPence: 60_000, evidence: ["sponsor dashboard: 1 190 clicks, 31 orders, 2026-10-14"] })).toMatchObject({ ok: true });
    expect(await t.run("request_spend", { amountCents: 30_000, category: "expense", destinationId: "dst_forum", purpose: "sponsorship, next 30 days", decisionKey: "tracker-ads" })).toMatchObject({ ok: true });
    expect(t.calls.spend).toHaveLength(3);
    // Self-governance never asks FleetController (or anyone) for permission: the only controller calls are the orders.
    expect([t.calls.other, t.calls.ownerRequest]).toEqual([0, 0]);
  });
});

describe("F2-A v27: the founder's economic context — wallet and record are information for its own sizing", () => {
  it("(4, 7) wallet size changes what the founder sees for the same sizing; its measured results and realised economics are there too", async () => {
    const eco = (cash: number) => ({ cash, reserved: 900, protectedPrincipal: 0, protectedObligations: 1_200, survivalEquity: cash - 1_200, externalCustomerRevenue: 9_900,
      expenses: 2_100, fees: 300, realizedNetProfit: 7_500 });
    const small = await mindWith(eco(3_000), decidedHistory()).packet();
    const large = await mindWith(eco(300_000), decidedHistory()).packet();
    expect(small.economics).toMatchObject({ cash: 3_000 });
    expect(large.economics).toMatchObject({ cash: 300_000 });
    const line = (task: string) => task.split("\n").find((l) => l.startsWith("Your own capital"))!;
    expect(line(small.task)).toMatch(/unreserved cash 3000p; reserved in open orders 900p; protected, never spendable: 0p borrowed principal and 1200p obligations \(tax reserves included\); survival equity 1800p\./);
    expect(line(small.task)).toMatch(/Sized exposure under your decided decisions: 1500p across 1, 900p committed; largest single exposure 1500p \(50% of your cash\)\./);
    expect(line(large.task)).toMatch(/largest single exposure 1500p \(1% of your cash\)\./);
    // History (forecast vs. result) and realised economics, from the founder's own ledger and its ledger view.
    expect(line(small.task)).toMatch(/Your record: 2 measured result\(s\) — 1 confirmed the path, 1 corrected it on evidence; realised revenue 9900p, expenses and fees 2400p, net 7500p\./);
    expect(line(small.task)).toMatch(/information, not a permission or a limit/);
    expect(line(small.task)).toMatch(/no approval queue, no fixed amount — the sizing is yours\.$/);
    // The decision line still carries the founder's own sizing and its last measured result.
    expect(small.task).toMatch(/At risk: 1500p of your capital \(900p committed;/);
    // No ledger view (older controller): no line, nothing invented.
    expect(ownCapitalLine({}, decidedHistory())).toBeNull();
  });

  it("(8) FleetController never ranks the commercial attractiveness of own-capital spend, and the founder's record is never a controller score", async () => {
    // The order carries no expected return, ranking, evidence or record: the controller cannot judge the business case.
    const t = toolbox();
    await t.run("open_decision", decisionArgs());
    await t.run("resolve_decision", resolveArgs());
    await t.run("request_spend", { amountCents: 100, category: "expense", destinationId: "dst_forum", purpose: "x", decisionKey: "tracker-ads" });
    expect(Object.keys(t.calls.spend[0]).sort()).toEqual(["amountCents", "category", "destinationId", "idempotencyKey", "purpose", "recoverableCents"]);
    // The registry's spend decision reads no return, ranking, history, experiment or cognition record.
    const spend = code(fn("api_spend_request")) + code(fn("fleet_spend_custody_check")) + code(fn("fleet_spend_circuit_breaker_check"));
    expect(spend).not.toMatch(/roi|expected|rank|score|strategy_registry|fleet_experiment|fleet_cognition_log|fleet_decision|track_record|revenue_provenance/i);
    expect(fn("api_spend_request")).toMatch(/api_spend_request\(p_agent text, p_token text, p_idem text, p_amount_cents bigint, p_category text,\s+p_destination text, p_purpose text, p_recoverable_cents bigint\)/);
    // The own-capital line is computed in the founder's runtime: a pure function of its ledger view and its own decisions.
    const a = ownCapitalLine({ cash: 5_000 }, decidedHistory());
    expect(ownCapitalLine({ cash: 5_000 }, decidedHistory())).toBe(a);
    expect(a).not.toMatch(/score|rating|tier|eligib|permitted|allowance|budget/i);
  });
});

describe("F2-A v27: FleetController is the custodian — precise refusals that route nowhere", () => {
  it("(9, 10, 11, 17) custody still protects restricted, protected, tax-reserved, other agents' and Treasury capital; Fleet capital stays a separate path", () => {
    const custody = code(fn("fleet_spend_custody_check"));
    expect(custody).toMatch(/v_code text := fleet_order_hard_check\(o\)/);
    expect(custody).toMatch(/category = 'tax_reserve'[\s\S]*RETURN 'FLEET_TAX_RESERVE'/);
    // The v10 hard checks are intact and defined once.
    const hard = fn("fleet_order_hard_check");
    for (const c of ["FLEET_AGENT_NOT_ACTIVE", "FLEET_AGENT_HELD", "FLEET_SPENDING_FROZEN", "FLEET_DESTINATION_NOT_ALLOWED", "FLEET_INSUFFICIENT_ALLOCATION", "FLEET_PROTECTED_CAPITAL", "FLEET_DESTINATION_NOT_ACTIVE"]) {
      expect(hard, c).toContain(c);
    }
    expect(PG_MIGRATIONS.map((m) => m.sql).join("\n").match(/FUNCTION fleet_order_hard_check\(/g)).toHaveLength(1);
    // Tax reserves are a protected obligation category; the only obligation categories are ordinary and tax reserve.
    expect(V27_SQL).toContain("ALTER TABLE fleet_obligations ADD CONSTRAINT fleet_obligations_category_check CHECK (category IN ('obligation','tax_reserve'));");
    // Another agent's money is unreachable: the order is the authenticated agent's, and reserving debits only its own cash.
    expect(code(fn("api_spend_request"))).toMatch(/VALUES \(gen_random_uuid\(\), 'agent_spend', p_agent, p_idem/);
    const reserve = fn("fleet_order_reserve");
    expect(reserve).toMatch(/IF o\.order_type = 'agent_spend' THEN[\s\S]*fleet_ledger_account\(o\.agent_id, 'agent_reserved'\)[\s\S]*fleet_ledger_account\(o\.agent_id, 'agent_cash'\)[\s\S]*ELSE/);
    expect(reserve.slice(0, reserve.indexOf("ELSE"))).not.toMatch(/fleet:treasury|fleet:custody/);
    // v27 touches no Treasury, allocation, grant, sweep or experiment path: Fleet / shared capital is a separate (future) allocation path.
    expect(code(V27_SQL)).not.toMatch(/fleet_capital_allocations|fleet_admin_agent_capital|fleet:treasury|fleet_treasury_policy|fleet_sweep|fleet_experiment|fleet_ledger_post/);
    expect(FOUNDER_EXPERIMENT_TOOLS.find((x) => x.name === "propose_experiment")!.description).toMatch(/FleetController then decides the evidence level, the budget .* and never lets you approve or resize it/);
    expect(FOUNDER_TOOLS.find((x) => x.name === "request_spend")!.description).toMatch(/^Commit your OWN capital/);
  });

  it("(13) a custody refusal — returned or thrown — names its category, commits nothing and creates nothing for the owner or anyone to decide", async () => {
    const refusals: Array<[string, CustodyCategory]> = [["FLEET_PROTECTED_CAPITAL", "PROTECTED_CAPITAL"], ["FLEET_TAX_RESERVE", "TAX_RESERVE"],
      ["FLEET_INFRASTRUCTURE_CIRCUIT_BREAKER", "INFRASTRUCTURE_CIRCUIT_BREAKER"], ["FLEET_DESTINATION_NOT_ALLOWED", "INVALID_DESTINATION"]];
    for (const [c, cat] of refusals) {
      for (const thrown of [false, true]) {
        const t = toolbox({ spend: () => {
          if (thrown) throw Object.assign(new Error(c), { code: c });
          return { ok: false, code: c, custody: cat, order: { status: "rejected", decisionCode: c } };
        } });
        await t.run("open_decision", decisionArgs());
        await t.run("resolve_decision", resolveArgs());
        const r = await t.run("request_spend", { amountCents: 25_000, category: "expense", destinationId: "dst_forum", purpose: "forum sponsorship", decisionKey: "tracker-ads" });
        expect(r, `${c} thrown=${thrown}`).toMatchObject({ ok: false, refused: c, output: expect.stringContaining(`ERROR ${c} — CUSTODY REFUSAL ${cat} (${c}):`) });
        expect(r.output).toMatch(/not a judgement of your decision; nothing is queued for anyone and no one else decides it\. Your next move is yours/);
        expect(r.output).not.toMatch(OWNER_SPEND);
        expect(loadDecisions(t.dirs.m)[0].outcome).toMatchObject({ committedPence: 0 });
        expect([t.calls.ownerRequest, t.calls.other]).toEqual([0, 0]);
      }
    }
    // The vocabulary is the registry's own (the SQL mapping is built from the same table) and covers the custody reasons.
    for (const [c, cat] of CUSTODY_REFUSAL_CODES) {
      expect(V27_SQL).toContain(`WHEN '${c}' THEN '${cat}'`);
      expect(custodyCategory(c)).toBe(cat);
      expect(custodyRefusalText(c, cat)).not.toMatch(OWNER_SPEND);
    }
    expect(new Set(CUSTODY_REFUSAL_CODES.map(([, k]) => k))).toEqual(new Set(["PROTECTED_CAPITAL", "TAX_RESERVE", "INSUFFICIENT_OWN_CAPITAL", "HOLD", "FROZEN", "AGENT_NOT_ACTIVE",
      "INVALID_DESTINATION", "IDEMPOTENCY_CONFLICT", "INFRASTRUCTURE_CIRCUIT_BREAKER", "PAYMENT_RAIL_UNAVAILABLE"]));
    expect(custodyCategory("FLEET_AUTH_FAILED")).toBeNull();
    // Every rejection path of the spend function returns the category with the code.
    const spend = code(fn("api_spend_request"));
    expect(spend.match(/'custody', fleet_custody_refusal\(/g)!.length).toBeGreaterThanOrEqual(4);
  });

  it("(14) zero owner actions cannot freeze a legitimate own-capital decision: no owner port, no owner state, no owner command", async () => {
    // The founder's whole path — decide, size, commit, measure, raise on evidence, commit again — needs no owner at all.
    const t = toolbox();
    await t.run("open_decision", decisionArgs());
    await t.run("resolve_decision", resolveArgs());
    expect(await t.run("request_spend", { amountCents: 30_000, category: "expense", destinationId: "dst_forum", purpose: "sponsorship", decisionKey: "tracker-ads" })).toMatchObject({ ok: true });
    expect(t.calls.ownerRequest).toBe(0);
    // In the registry an own-capital order ends reserved or rejected in the same call; no state waits on a person.
    const spend = code(fn("api_spend_request"));
    expect(new Set([...spend.matchAll(/status = '([a-z_]+)'/g)].map((m) => m[1]))).toEqual(new Set(["rejected"]));
    expect(spend).not.toMatch(/'requested','awaiting_owner'|awaiting/);
    // The owner's legacy command is retired without touching the database.
    const never = new Proxy({}, { get: () => { throw new Error("the retired command must not reach the ledger"); } }) as unknown as PgLedgerAdmin;
    await expect(runLedgerCommand("ledger-spend-decision", ["0b4d9f0e-0000-4000-8000-000000000000", "approve", "--ack"], never, "operator:owner"))
      .rejects.toThrow(/^FLEET_OWNER_ROUTE_RETIRED: ledger-spend-decision is retired \(schema v27\)/);
  });
});

describe("F2-A v27: the infrastructure circuit breaker", () => {
  const table = V27_SQL.slice(V27_SQL.indexOf("CREATE TABLE fleet_spend_circuit_breaker ("), V27_SQL.indexOf("INSERT INTO fleet_spend_circuit_breaker"));

  it("(15) infrastructure only, configurable, relative: no nominal amount column, every signal unset, owner-controlled and audited", () => {
    expect(table).not.toMatch(/cents|minor|amount|gbp|usd/i);
    for (const col of ["order_wallet_bp", "velocity_window_s", "velocity_wallet_bp"]) {
      const def = table.split("\n").find((l) => l.trim().startsWith(col))!;
      expect(def, col).not.toMatch(/DEFAULT|NOT NULL/); // unset until someone with evidence sets it
    }
    expect(table).toMatch(/order_wallet_bp\s+integer\s+CHECK \(order_wallet_bp BETWEEN 1 AND 10000\)/);
    expect(table).toMatch(/velocity_wallet_bp integer\s+CHECK \(velocity_wallet_bp BETWEEN 1 AND 10000\)/);
    expect(table).toContain("CHECK (tripped = (trip_reason IS NOT NULL))");
    expect(V27_SQL).toContain("INSERT INTO fleet_spend_circuit_breaker (id) VALUES (1);");
    // Unset signals never trip; the check reads only the founder's own wallet and its own recent orders.
    const check = code(fn("fleet_spend_circuit_breaker_check"));
    expect(check).toMatch(/IF b\.order_wallet_bp IS NULL AND b\.velocity_wallet_bp IS NULL THEN RETURN NULL; END IF;/);
    expect(check).toMatch(/fleet_ledger_account\(o\.agent_id, 'agent_cash'\)/);
    expect(check).toMatch(/WHERE agent_id = o\.agent_id/);
    // Configured only by an owner approver, with an audit event; never an agent function.
    const admin = code(fn("fleet_admin_spend_circuit_breaker"));
    expect(admin).toMatch(/fleet_require_operator_approver\(substr\(p_actor, 10\), 'fleet_treasury'\)/);
    expect(admin).toMatch(/fleet_event\('spend_circuit_breaker_set'/);
    expect(AGENT_API_FUNCTIONS.some((f) => /circuit|custody_check|custody_refusal/.test(f))).toBe(false);
  });

  it("(16) the breaker is never visible as a research or spend entitlement", () => {
    // An agent learns only that a signal tripped (its name), never a threshold, a share or a remaining amount.
    const spend = code(fn("api_spend_request"));
    expect(spend).toMatch(/'infrastructure circuit breaker: ' \|\| v_signal/);
    expect(spend).not.toMatch(/order_wallet_bp|velocity_wallet_bp|velocity_window_s|fleet_spend_circuit_breaker[^_]/);
    expect([...code(fn("fleet_spend_circuit_breaker_check")).matchAll(/RETURN '([a-z_]+)'/g)].map((m) => m[1])).toEqual(["unavailable", "tripped", "order_wallet_share", "velocity_wallet_share"]);
    // Founder-facing text never mentions it as something to use: not the charter, tools, packet policy or own-capital line.
    const facing = [FOUNDER_CHARTER, FOUNDER_ROUTED_ADDENDUM, ...FOUNDER_TOOLS.map((x) => x.description), ...PACKET_POLICY, ownCapitalLine({ cash: 1 }, [])!].join("\n");
    expect(facing).not.toMatch(/circuit|breaker|allowance|entitle|remaining (budget|spend)|you may spend up to/i);
    // When it trips, the founder is told what it is not.
    expect(custodyRefusalText("FLEET_INFRASTRUCTURE_CIRCUIT_BREAKER", "INFRASTRUCTURE_CIRCUIT_BREAKER"))
      .toMatch(/an infrastructure failsafe against anomalies .* it is not a spending allowance, a target or a judgement of your decision/);
    // No spend or research ration or entitlement in the code that decides an order (v26's research doctrine still holds).
    for (const f of ["api_spend_request", "fleet_spend_custody_check", "fleet_spend_circuit_breaker_check"]) {
      expect(code(fn(f)), f).not.toMatch(/allowance|budget|entitle|discovery|min_runway|daily_fraction/i);
    }
    expect(code(V26_SQL)).not.toMatch(/discovery|allowance|min_runway|daily_fraction|budgetCents/);
  });
});

describe("F2-A v27: engineering safety flags", () => {
  it("(18, 19) the four engineering safety flags are unchanged; REAL_PAYMENTS_ENABLED stays false and custody execution stays pinned off", () => {
    expect(loadFleetConfig({})).toMatchObject({ realReplicationEnabled: false, realPaymentsEnabled: false, ownerSweepEnabled: false });
    const env = fs.readFileSync(path.resolve("deploy/etc/runtime.env.example"), "utf8");
    for (const flag of ["REAL_REPLICATION_ENABLED=false", "REAL_PAYMENTS_ENABLED=false", "OWNER_SWEEP_ENABLED=false", "FLEET_DRY_RUN_CHILD=false"]) {
      expect(env.split("\n")).toContain(flag);
    }
    // v27 changes no flag, cap, mode or custody pin, and enables nothing.
    expect(code(V27_SQL)).not.toMatch(/custody_execution_enabled|replication_enabled|financial_mode|max_agents|operating_mode|fleet_state|REAL_|OWNER_SWEEP|FLEET_DRY_RUN|FLEET_MAX_AGENTS|fleet_capability_manifests|fleet_payment_instructions/);
    expect(FOUNDER_TOOLS.find((x) => x.name === "request_spend")!.description).toMatch(/Nothing is paid while custody execution is disabled in this phase\./);
    // The packet the founder works from still states it has no payment authority.
    expect(PACKET_POLICY[0]).toBe("No trading, custody, payment or transfer authority; spending only via request_spend, within your own risk sizing and FleetController's custody rules.");
    expect(manifestSha256(FOUNDER_MANIFEST_V2)).toBe("30a7060986930db3f611545c8c57fa5a98c9ad798bac279f66c39bdfe527a3d8"); // no new authority
  });
});

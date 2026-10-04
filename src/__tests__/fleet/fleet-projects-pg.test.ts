/**
 * Schema v42 — multi-agent PROJECT TEAMS (PostgreSQL, real migrated registry, agents through the RESTRICTED role).
 *
 * An agent recruits other existing living agents into a venture project by internal contract; the planner's ETAs come
 * from the task graph; compensation moves through balanced internal journals that are never external revenue; FleetController
 * checks custody only for own capital and decides Fleet capital through the existing request path; cancellation, exit
 * and death settle exactly; recruitment never creates an agent or touches replication; the history persists.
 * Numbered tests refer to the owner brief's acceptance list (13–32).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { FLEET_PG_HARD_MAX_AGENTS } from "../../fleet/postgres/migrations.js";
import { schedule } from "../../fleet/projects/planner.js";

const PG_BIN = findPgBin();
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const idem = () => `prj:${crypto.randomUUID()}`;
const ev3 = [1, 2, 3].map((i) => ({ kind: "sales", observation: `signed pre-order ${i}`, source: "https://example.test" }));
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

describe.skipIf(!PG_BIN)("v42 multi-agent project teams (PostgreSQL)", () => {
  let R: EconomyRegistry;
  let A: Founder, B: Founder, C: Founder, D: Founder;
  let svc: pg.Pool;
  let rail = "";
  const acct = (who: Founder | string, cls: string) => `agent:${typeof who === "string" ? who : who.id}:${cls.slice(6)}`;
  const ok = async (p: Promise<Record<string, any>>) => { const r = await p; expect(r, JSON.stringify(r)).toMatchObject({ ok: true }); return r; };
  const external = async () => R.one(`(fleet.fleet_daily_report() -> 'flows')`);
  const sumNet = async () => Number(await R.one(`(SELECT COALESCE(sum((fleet.fleet_agent_economics(agent_id) ->> 'realizedNetProfit')::bigint), 0) FROM fleet.fleet_agents)`));

  /** The brief's example plan: architecture (lead), backend (engineer) ∥ frontend (lead), integration (lead). */
  const plan = (key: string, venture: string, extra: Record<string, unknown> = {}) => ({
    idempotencyKey: idem(), key, ventureKey: venture, name: `Project ${key}`, objective: "ship the customer portal sooner",
    expectedValueMinor: 50_000, expectedReturnMinor: 30_000, budgetMinor: 3_000, opportunityCostMinor: 1_000, timeValueMinorPerDay: 4_000,
    coordinationHours: 2, coordinationCostMinor: 500, risk: "medium",
    justification: { decomposition: "architecture, backend, frontend, integration", parallelism: "backend and frontend run in parallel after architecture",
      whyTeam: "an engineer takes the 20 h backend off the critical path", timeToRevenue: "revenue starts at launch; 16 h sooner" },
    tasks: [
      { key: "arch", title: "Architecture", ownerRole: "lead", hours: 8, deliverable: "design doc", acceptance: "covers API and data model" },
      { key: "backend", title: "Backend", ownerRole: "engineer", hours: 20, deps: ["arch"], deliverable: "API service", acceptance: "tests pass", capability: "backend" },
      { key: "frontend", title: "Frontend", ownerRole: "lead", hours: 18, deps: ["arch"], deliverable: "portal UI", acceptance: "usable" },
      { key: "integration", title: "Integration", ownerRole: "lead", hours: 6, deps: ["backend", "frontend"], deliverable: "live portal", acceptance: "end to end" },
    ],
    roles: [{ role: "engineer", taskScope: "the backend API", requiredCapability: "backend", compensation: { type: "FIXED", fixedMinor: 1_000 } }],
    ...extra,
  });
  const offer = (pid: string, to: Founder, extra: Record<string, unknown> = {}) => R.econ(A, "project.offer", {
    projectId: pid, role: "engineer", agentId: to.id, deliverable: "the backend API", expectedHours: 20, deadline: inDays(7), ...extra });

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 4, allocationCents: 20_000, treasuryCents: 2_000_000 });
    [A, B, C, D] = R.founders;
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2 });
    await R.store.grantServiceRole();
    const e = await R.one(`fleet.fleet_admin_legal_entity_add('Fleet Trading Ltd', 'GB', 'company', true, $1)`, [OWNER]);
    await R.one(`fleet.fleet_admin_tax_profile_set($1, '[{"taxKind":"profit","rateBp":2000}]'::jsonb, now() - interval '1 second', NULL, $2)`, [e.entity_id, OWNER]);
    rail = (await R.one(`fleet.fleet_admin_rail_add('simulated', 'sim', 'shared', NULL, ARRAY['receive_payments'], 'sim checkout', NULL, 'simulated', NULL, NULL, $1)`, [OWNER])).railId;
    for (const [who, key] of [[A, "portal"], [A, "portal-two"], [A, "portal-three"], [B, "b-shop"]] as const) {
      await ok(R.econ(who, "venture.create", { key, model: "software", offer: key, state: "selected", channels: ["direct"] }));
      await R.econ(who, "rail.require", { ventureKey: key });
    }
  }, 300_000);
  afterAll(async () => { await svc?.end(); await R?.close(); });

  it("migrates with a clean privilege audit (single writers for every project table, guards present)", async () => {
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
    expect(Number(await R.one(`(SELECT max(version) FROM fleet.fleet_schema_migrations)`))).toBe(42);
  });

  it("the database planner equals the TypeScript planner (random graphs)", async () => {
    for (let n = 0; n < 25; n++) {
      const size = 2 + (n % 9), roles = ["lead", "r1", "r2", "r3"];
      const tasks = Array.from({ length: size }, (_, i) => ({ key: `t${i}`, role: roles[(i * 7 + n) % (1 + (n % 4))], hours: ((i * 37 + n * 11) % 40) / 4 + 0.25,
        deps: Array.from({ length: i }, (_, j) => `t${j}`).filter((_, j) => (i + j + n) % 3 === 0) }));
      const offsets = n % 5 === 0 ? { r1: 3.5 } : {};
      const db = await R.one(`fleet.fleet_project_schedule($1::jsonb, $2::jsonb)`, [JSON.stringify(tasks), JSON.stringify(offsets)]);
      const ts = schedule(tasks, offsets);
      expect(Number(db.makespanHours)).toBe(ts.makespanHours);
      expect(db.criticalPath).toEqual(ts.criticalPath);
      expect(db.tasks.map((t: any) => [t.key, Number(t.startHours), Number(t.finishHours)])).toEqual(ts.tasks.map((t) => [t.key, t.startHours, t.finishHours]));
    }
  });

  let P = "";
  let M = "";
  it("13/15/16/22: an agent recruits an EXISTING living agent by internal contract — own capital, custody check only, no owner step", async () => {
    const agents0 = Number(await R.one(`(SELECT count(*) FROM fleet.fleet_agents)`));
    const ownerReq0 = Number(await R.one(`(SELECT count(*) FROM fleet.fleet_owner_requests)`));
    const capReq0 = Number(await R.one(`(SELECT count(*) FROM fleet.fleet_capital_requests)`));
    const r = await ok(R.econ(A, "project.propose", plan("portal-v1", "portal")));
    P = r.project.projectId;
    // The planner's figures (never the lead's claim): solo 52 h; team = 34 h critical path + 2 h coordination.
    expect(r.project.eta).toMatchObject({ soloHours: 52, teamHours: 36, criticalPathHours: 34, plannedTimeSavedHours: 16, criticalPath: ["arch", "backend", "integration"] });
    expect(r.project.economics).toMatchObject({ benefitMinor: 2666, costMinor: 1500, justified: true });
    // Own capital: FleetController checks custody availability only — the exact amount the agent chose is escrowed (no resizing).
    const cash0 = await R.balance(acct(A, "agent_cash"));
    const f = await ok(R.econ(A, "project.fund", { projectId: P, amountMinor: 1_737, source: "own" }));
    expect(f.project.economics).toMatchObject({ escrowOwnMinor: 1_737, fundingSource: "own_capital" });
    expect(await R.balance(acct(A, "agent_cash"))).toBe(cash0 - 1_737);
    expect(await R.balance(acct(A, "agent_project_escrow"))).toBe(1_737);
    // Offer → the target decides itself.
    const o = await ok(offer(P, B));
    M = o.memberId;
    const acc = await ok(R.econ(B, "project.respond", { memberId: M, response: "ACCEPT", reason: "fits my capacity; fair pay" }));
    expect(acc.contract).toMatchObject({ agentId: B.id, role: "engineer", status: "accepted", response: "ACCEPT", compensation: { type: "FIXED", fixedMinor: 1_000 } });
    expect(acc.contract.acceptedAt).toBeTruthy();
    const ev = await R.q(`SELECT detail FROM fleet.fleet_events WHERE event_type = 'project_member_joined' AND detail ->> 'projectId' = $1`, [P]);
    expect(ev[0].detail).toMatchObject({ fromAgentId: B.id, toAgentId: A.id, role: "engineer" });
    // 29: no agent was created; 16: no owner request, no capital decision, no step-up anywhere.
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_agents)`))).toBe(agents0);
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_owner_requests)`))).toBe(ownerReq0);
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_capital_requests)`))).toBe(capReq0);
  });

  it("14: the recruit may decline; nobody can accept for another agent; an offer to a non-existent agent creates nothing", async () => {
    const p2 = (await ok(R.econ(A, "project.propose", plan("portal-v2", "portal-two")))).project.projectId;
    await ok(R.econ(A, "project.fund", { projectId: p2, amountMinor: 1_200, source: "own" }));
    const m = (await ok(offer(p2, C))).memberId;
    // The lead (or anyone else) cannot answer on C's behalf.
    expect(await R.econ(A, "project.respond", { memberId: m, response: "ACCEPT" })).toMatchObject({ ok: false, code: "FLEET_NOT_FOUND" });
    expect(await R.econ(D, "project.respond", { memberId: m, response: "ACCEPT" })).toMatchObject({ ok: false, code: "FLEET_NOT_FOUND" });
    expect(await ok(R.econ(C, "project.respond", { memberId: m, response: "DECLINE", reason: "my own venture needs me this week" }))).toMatchObject({ status: "declined" });
    expect((await R.q(`SELECT status FROM fleet.fleet_project_members WHERE member_id = $1`, [m]))[0].status).toBe("declined");
    expect(await R.econ(C, "project.respond", { memberId: m, response: "ACCEPT" })).toMatchObject({ ok: false, code: "FLEET_INVALID_STATE" });
    const agents0 = Number(await R.one(`(SELECT count(*) FROM fleet.fleet_agents)`));
    expect(await offer(p2, { id: "agent-51-does-not-exist", token: "" })).toMatchObject({ ok: false, code: "FLEET_NOT_FOUND" });
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_agents)`))).toBe(agents0);
    // COUNTER → the lead decides; ACCEPT_WITH_TIMING moves the planned ETA.
    const m2 = (await ok(offer(p2, D))).memberId;
    await ok(R.econ(D, "project.respond", { memberId: m2, response: "COUNTER", counter: { compensation: { type: "FIXED", fixedMinor: 1_100 } }, reason: "more scope than stated" }));
    const ca = await ok(R.econ(A, "project.counter_accept", { projectId: p2, memberId: m2 }));
    expect(ca.contract).toMatchObject({ status: "accepted", compensation: { fixedMinor: 1_100 } });
    await ok(R.econ(A, "project.cancel", { projectId: p2, reason: "test cleanup" }));
  });

  it("an unjustified team (serial work, or costs above the benefit) is refused with the planner's reasons", async () => {
    const serial = plan("serial", "portal-three", {
      tasks: [
        { key: "a", title: "A", ownerRole: "lead", hours: 4, deliverable: "a", acceptance: "a" },
        { key: "b", title: "B", ownerRole: "engineer", hours: 4, deps: ["a"], deliverable: "b", acceptance: "b" },
      ],
    });
    const r = await R.econ(A, "project.propose", serial);
    expect(r).toMatchObject({ ok: false, code: "FLEET_PROJECT_NOT_JUSTIFIED" });
    expect(r.reason).toMatch(/team 10\.00h vs solo 8\.00h/);
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_projects WHERE project_key = 'serial')`))).toBe(0);
    expect(await R.econ(A, "project.propose", plan("too-dear", "portal-three", { coordinationCostMinor: 5_000 }))).toMatchObject({ ok: false, code: "FLEET_PROJECT_NOT_JUSTIFIED" });
  });

  it("17/18/19: compensation is a balanced internal journal — payer expense, payee income, never Fleet external revenue", async () => {
    const flows0 = await external();
    const wealth0 = await R.one(`fleet.fleet_generated_treasury_wealth()`);
    const net0 = await sumNet();
    const treasury0 = await R.balance("fleet:treasury:unallocated");
    await ok(R.econ(A, "project.start", { projectId: P }));
    for (const k of ["arch", "frontend"]) {
      await ok(R.econ(A, "project.task", { projectId: P, taskKey: k, action: "start" }));
      await ok(R.econ(A, "project.task", { projectId: P, taskKey: k, action: "deliver", evidence: [{ kind: "note", observation: `${k} done` }] }));
      await ok(R.econ(A, "project.review", { projectId: P, taskKey: k, verdict: "accept", reason: "meets acceptance" }));
    }
    // Only the role's contracted agent works its task.
    expect(await R.econ(C, "project.task", { projectId: P, taskKey: "backend", action: "start" })).toMatchObject({ ok: false, code: "FLEET_PROJECT_NOT_OWNER" });
    await ok(R.econ(B, "project.task", { projectId: P, taskKey: "backend", action: "start" }));
    await ok(R.econ(B, "project.task", { projectId: P, taskKey: "backend", action: "progress", progressBp: 5000 }));
    await ok(R.econ(B, "project.task", { projectId: P, taskKey: "backend", action: "deliver", evidence: [{ kind: "note", observation: "API live on staging" }] }));
    // A rejection pays nothing; redelivery and acceptance pay the fixed amount once.
    await ok(R.econ(A, "project.review", { projectId: P, taskKey: "backend", verdict: "reject", reason: "missing auth" }));
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_project_payments WHERE project_id = $1)`, [P]))).toBe(0);
    await ok(R.econ(B, "project.task", { projectId: P, taskKey: "backend", action: "start" }));
    await ok(R.econ(B, "project.task", { projectId: P, taskKey: "backend", action: "deliver" }));
    const bCash0 = await R.balance(acct(B, "agent_cash"));
    const rv = await ok(R.econ(A, "project.review", { projectId: P, taskKey: "backend", verdict: "accept", reason: "auth added" }));
    expect(rv.paidMinor).toBe(1_000);
    // 19: attributed to the right agents and venture.
    const pay = (await R.q(`SELECT * FROM fleet.fleet_project_payments WHERE project_id = $1`, [P]))[0];
    expect(pay).toMatchObject({ payer_agent_id: A.id, payee_agent_id: B.id, kind: "fixed", amount_minor: "1000", from_own_minor: "1000", from_fleet_minor: "0" });
    expect(pay.venture_id).toBe((await R.q(`SELECT venture_id FROM fleet.fleet_ventures WHERE agent_id = $1 AND venture_key = 'portal'`, [A.id]))[0].venture_id);
    expect(await R.balance(acct(A, "agent_project_expense"))).toBe(1_000);
    expect(await R.balance(acct(B, "agent_project_income"))).toBe(1_000);
    expect(await R.balance(acct(B, "agent_cash"))).toBe(bCash0 + 1_000);
    expect(await R.balance(acct(A, "agent_project_escrow"))).toBe(737);
    // 18: the journal balances and the hash chain verifies.
    const j = (await R.q(`SELECT sum(amount_cents) FILTER (WHERE side = 'D') AS d, sum(amount_cents) FILTER (WHERE side = 'C') AS c FROM fleet.fleet_ledger_postings WHERE journal_id = $1`, [pay.journal_id]))[0];
    expect(j.d).toBe(j.c);
    expect(await R.one(`fleet.fleet_ledger_verify()`)).toMatchObject({ ok: true, unbalanced: 0 });
    // 17: Fleet external revenue, profit, wealth and the sweep base are unchanged; per agent the internal flows are reported beside them.
    expect(await external()).toEqual(flows0);
    expect(await R.one(`fleet.fleet_generated_treasury_wealth()`)).toEqual(wealth0);
    expect(await sumNet()).toBe(net0);
    expect(await R.balance("fleet:treasury:unallocated")).toBe(treasury0);
    const eB = await R.one(`fleet.fleet_agent_economics($1)`, [B.id]);
    const eA = await R.one(`fleet.fleet_agent_economics($1)`, [A.id]);
    expect(eB).toMatchObject({ externalCustomerRevenue: 0, internalProjectIncome: 1_000, netProfitInclInternal: Number(eB.realizedNetProfit) + 1_000 });
    expect(eA).toMatchObject({ internalProjectExpense: 1_000, projectEscrow: 737 });
    expect(Number(eA.internalProjectExpense)).toBe(Number(eB.internalProjectIncome)); // consolidated: internal flows net to zero
    expect(Number(await R.one(`(SELECT COALESCE(sum((fleet.fleet_agent_economics(agent_id) ->> 'internalProjectIncome')::bigint - (fleet.fleet_agent_economics(agent_id) ->> 'internalProjectExpense')::bigint), 0) FROM fleet.fleet_agents)`))).toBe(0);
    // The ledger itself refuses a project payment that is not between the payer and exactly one other agent.
    expect(await R.code(R.q(`SELECT fleet.fleet_ledger_post('project_payment', $1, 'x', 'rogue', 'controller', $2, NULL, NULL, NULL, NULL, now(),
      jsonb_build_array(jsonb_build_object('account', $3::text, 'side', 'D', 'amount', 1), jsonb_build_object('account', $4::text, 'side', 'C', 'amount', 1)))`,
      [idem(), A.id, acct(B, "agent_cash"), acct(C, "agent_project_income")]))).toBe("FLEET_LEDGER_SCOPE");
  });

  it("32: completion records the outcome (predicted vs actual, realised time saved), feeds institutional knowledge and competency; history is append-only", async () => {
    await ok(R.econ(A, "project.task", { projectId: P, taskKey: "integration", action: "start" }));
    await ok(R.econ(A, "project.task", { projectId: P, taskKey: "integration", action: "deliver" }));
    await ok(R.econ(A, "project.review", { projectId: P, taskKey: "integration", verdict: "accept", reason: "works end to end" }));
    const cash0 = await R.balance(acct(A, "agent_cash"));
    const c = await ok(R.econ(A, "project.complete", { projectId: P, actualReturnMinor: 0, lessons: "a parallel backend saved most of the critical path" }));
    expect(c.returned).toMatchObject({ ownReturnedMinor: 737 });
    expect(await R.balance(acct(A, "agent_cash"))).toBe(cash0 + 737);
    expect(await R.balance(acct(A, "agent_project_escrow"))).toBe(0);
    expect(c.project).toMatchObject({ status: "completed", teamSize: 2 });
    expect(c.project.eta.realisedTimeSavedHours).toBeGreaterThan(0); // 52 h solo vs seconds of test time — measured, not claimed
    const out = (await R.q(`SELECT * FROM fleet.fleet_project_outcomes WHERE project_id = $1`, [P]))[0];
    expect(out).toMatchObject({ outcome: "completed", team_size: 2, actual_cost_minor: "1000" });
    expect(out.contributions[0]).toMatchObject({ agentId: B.id, role: "engineer", paidMinor: 1000, tasksAccepted: 1, rejections: 1 });
    const k = (await R.q(`SELECT * FROM fleet.fleet_economic_knowledge WHERE knowledge_id = $1`, [out.knowledge_id]))[0];
    expect(k).toMatchObject({ topic: "team_project", agent_id: A.id });
    // Teammate search uses this history (raw, no score).
    const t = await ok(R.econ(C, "project.talent", { capability: "backend" }));
    expect(t.agents.find((x: any) => x.agentId === B.id).history[0]).toMatchObject({ capability: "backend", tasksAccepted: 1, rejections: 1, projectsCompleted: 1 });
    // Append-only history; a finished project is final.
    expect(await R.code(R.q(`UPDATE fleet.fleet_project_events SET actor = 'x' WHERE project_id = $1`, [P]))).toBe("FLEET_HISTORY_IMMUTABLE");
    expect(await R.code(R.q(`DELETE FROM fleet.fleet_project_payments`))).toBe("FLEET_HISTORY_IMMUTABLE");
    expect(await R.code(R.q(`UPDATE fleet.fleet_projects SET name = 'x' WHERE project_id = $1`, [P]))).toBe("FLEET_IMMUTABLE");
    expect((await R.q(`SELECT event_type FROM fleet.fleet_project_events WHERE project_id = $1 ORDER BY seq`, [P])).map((x) => x.event_type)).toEqual(expect.arrayContaining(
      ["project_created", "project_funded", "project_member_offered", "project_member_joined", "project_started", "project_task_delivered", "project_task_rejected",
       "project_task_accepted", "project_payment", "project_completed"]));
  });

  it("20: tax reserves and restricted capital cannot fund an ordinary project; envelope capital of another purpose is refused", async () => {
    const p = (await ok(R.econ(A, "project.propose", plan("restricted", "portal-three")))).project.projectId;
    const spend = Number((await R.one(`fleet.fleet_agent_economics($1)`, [A.id])).expensePurchasingCapacity);
    // Move most of A's cash into its restricted tax reserve (owner-posted tax reservation).
    await R.one(`fleet.fleet_ledger_post('tax_reservation', $1, $2, 'tax set aside', 'owner', $3, NULL, NULL, NULL, NULL, now(),
      jsonb_build_array(jsonb_build_object('account', $4::text, 'side', 'D', 'amount', $6::bigint), jsonb_build_object('account', $5::text, 'side', 'C', 'amount', $6::bigint)))`,
      [idem(), OWNER, A.id, acct(A, "agent_tax_reserve"), acct(A, "agent_cash"), spend - 100]);
    try {
    const r = await R.econ(A, "project.fund", { projectId: p, amountMinor: 500, source: "own" });
    expect(r).toMatchObject({ ok: false, code: "FLEET_PROJECT_INSUFFICIENT_FUNDS", availableMinor: 100 });
    expect(r.reason).toMatch(/tax reserve/);
    expect(await R.balance(acct(A, "agent_tax_reserve"))).toBe(spend - 100); // untouched
    // Envelope capital approved for another purpose (no projectId) cannot fund it.
    const cap = await ok(R.econ(A, "capital.request", { idempotencyKey: idem(), ventureKey: "portal-three", purpose: "ads for the portal", amountMinor: 2_000,
      evidence: ev3, expectedRevenueMinor: 9_000, expectedNetMinor: 3_000,
      expectedPaybackDays: 20, downsideMinor: 2_000, confidenceBp: 7_000 }));
    expect(cap.envelope, JSON.stringify(cap)).toBeTruthy();
    expect(await R.econ(A, "project.fund", { projectId: p, amountMinor: 500, source: "fleet_capital", envelopeId: cap.envelope.envelopeId }))
      .toMatchObject({ ok: false, code: "FLEET_PROJECT_CAPITAL_SCOPE" });
    } finally {
    // Release the reservation for the next tests.
    await R.one(`fleet.fleet_ledger_post('tax_reserve_release', $1, $2, 'test release', 'owner', $3, NULL, NULL, NULL, NULL, now(),
      jsonb_build_array(jsonb_build_object('account', $4::text, 'side', 'D', 'amount', $6::bigint), jsonb_build_object('account', $5::text, 'side', 'C', 'amount', $6::bigint)))`,
      [idem(), OWNER, A.id, acct(A, "agent_cash"), acct(A, "agent_tax_reserve"), spend - 100]);
    }
    await ok(R.econ(A, "project.cancel", { projectId: p, reason: "test cleanup" }));
  });

  it("21: Fleet capital for a team project goes through the existing capital-request path with the project's economics attached", async () => {
    await ok(R.econ(B, "venture.create", { key: "b-tools", model: "software", offer: "tools", state: "selected", channels: ["direct"] }));
    const pr = await ok(R.econ(B, "project.propose", plan("b-proj", "b-tools")));
    const p = pr.project.projectId;
    const cap = await ok(R.econ(B, "capital.request", { idempotencyKey: idem(), ventureKey: "b-tools", projectId: p, purpose: "team project budget", amountMinor: 1_500,
      evidence: ev3, expectedRevenueMinor: 50_000, expectedNetMinor: 30_000,
      expectedPaybackDays: 30, downsideMinor: 1_500, confidenceBp: 7_000 }));
    expect(["APPROVE", "PARTIAL_APPROVE", "APPROVE_WITH_LIMITS", "DEFER", "REJECT"]).toContain(cap.outcome);
    const dec = (await R.q(`SELECT d.inputs, d.decided_by, q.project_id FROM fleet.fleet_capital_decisions d JOIN fleet.fleet_capital_requests q ON q.request_id = d.request_id
      WHERE q.project_id = $1`, [p]))[0];
    expect(dec.decided_by).toBe("controller");
    expect(dec.inputs.project).toMatchObject({ projectId: p, soloHours: 52, teamHours: 36, benefitMinor: 2666 });
    expect(cap.envelope, JSON.stringify(cap)).toBeTruthy(); // this request is fundable; a DEFER / REJECT would simply stand
    const env = cap.envelope.envelopeId;
    const f = await ok(R.econ(B, "project.fund", { projectId: p, amountMinor: 1_200, source: "fleet_capital", envelopeId: env }));
    expect(f.project.economics).toMatchObject({ escrowFleetMinor: 1_200, fundingSource: "fleet_capital" });
    const pos = (await R.one(`fleet.fleet_envelope_json((SELECT e FROM fleet.fleet_envelopes e WHERE envelope_id = $1))`, [env])).position;
    expect(pos).toMatchObject({ projectEscrowMinor: 1_200 });
    // The envelope ledger still equals the envelopes' positions (health check).
    const health = await R.one(`fleet.fleet_economy_health()`);
    expect(JSON.stringify(health)).toMatch(/"code": ?"ENVELOPE_LEDGER"[^}]*"mismatchedAgents": ?0/);
    // Cancelled: the Fleet capital goes back to its envelope.
    const c = await ok(R.econ(B, "project.cancel", { projectId: p, reason: "market moved" }));
    expect(c.returned).toMatchObject({ fleetReturnedMinor: 1_200, fleetReturnedTo: "envelope" });
    expect(JSON.stringify(await R.one(`fleet.fleet_economy_health()`))).toMatch(/"code": ?"ENVELOPE_LEDGER"[^}]*"mismatchedAgents": ?0/);
  });

  it("27: cancellation settles exactly — delivered milestone work is paid, undelivered is not, unspent escrow returns", async () => {
    const pr = await ok(R.econ(A, "project.propose", plan("cancel-me", "portal-three", {
      tasks: [
        { key: "arch", title: "Architecture", ownerRole: "lead", hours: 8, deliverable: "doc", acceptance: "ok" },
        { key: "api", title: "API", ownerRole: "engineer", hours: 12, deps: ["arch"], deliverable: "api", acceptance: "ok" },
        { key: "jobs", title: "Jobs", ownerRole: "engineer", hours: 8, deps: ["arch"], deliverable: "jobs", acceptance: "ok" },
        { key: "ui", title: "UI", ownerRole: "lead", hours: 20, deps: ["arch"], deliverable: "ui", acceptance: "ok" },
      ],
      roles: [{ role: "engineer", taskScope: "api and jobs", requiredCapability: "backend",
        compensation: { type: "MILESTONE", milestones: [{ key: "m-api", taskKey: "api", amountMinor: 600 }, { key: "m-jobs", taskKey: "jobs", amountMinor: 400 }] } }],
    })));
    const p = pr.project.projectId;
    await ok(R.econ(A, "project.fund", { projectId: p, amountMinor: 1_500, source: "own" }));
    // An unfunded acceptance is refused (escrow must cover the contract) — fund first, then accept.
    const m = (await ok(offer(p, C, { compensation: undefined }))).memberId;
    await ok(R.econ(C, "project.respond", { memberId: m, response: "ACCEPT" }));
    await ok(R.econ(A, "project.start", { projectId: p }));
    for (const step of [["start"], ["deliver"]]) await ok(R.econ(A, "project.task", { projectId: p, taskKey: "arch", action: step[0] }));
    await ok(R.econ(C, "project.task", { projectId: p, taskKey: "api", action: "start" }));
    await ok(R.econ(C, "project.task", { projectId: p, taskKey: "api", action: "deliver" }));      // delivered, not reviewed
    await ok(R.econ(C, "project.task", { projectId: p, taskKey: "jobs", action: "start" }));       // started, not delivered
    const a0 = await R.balance(acct(A, "agent_cash")), c0 = await R.balance(acct(C, "agent_cash"));
    const r = await ok(R.econ(A, "project.cancel", { projectId: p, reason: "customer withdrew" }));
    expect(r.paidOnSettlementMinor).toBe(600);                         // the delivered milestone only
    expect(r.returned).toMatchObject({ ownReturnedMinor: 900 });       // 1 500 − 600
    expect(await R.balance(acct(C, "agent_cash"))).toBe(c0 + 600);
    expect(await R.balance(acct(A, "agent_cash"))).toBe(a0 + 900);
    expect(await R.balance(acct(A, "agent_project_escrow"))).toBe(0);
    const mem = (await R.q(`SELECT status FROM fleet.fleet_project_members WHERE member_id = $1`, [m]))[0];
    expect(mem.status).toBe("exited");                                 // not trapped
    expect(await R.one(`fleet.fleet_ledger_verify()`)).toMatchObject({ ok: true });
  });

  it("members can exit; the lead can replace a member; nobody is trapped", async () => {
    const p = (await ok(R.econ(A, "project.propose", plan("exit-me", "portal-three")))).project.projectId;
    await ok(R.econ(A, "project.fund", { projectId: p, amountMinor: 2_000, source: "own" }));
    const m = (await ok(offer(p, D))).memberId;
    await ok(R.econ(D, "project.respond", { memberId: m, response: "ACCEPT" }));
    expect(await ok(R.econ(D, "project.exit", { projectId: p, reason: "a better opportunity came up" }))).toMatchObject({ paidMinor: 0 });
    const m2 = (await ok(offer(p, C))).memberId;
    await ok(R.econ(C, "project.respond", { memberId: m2, response: "ACCEPT_WITH_TIMING", startAt: inDays(1) }));
    const st = await ok(R.econ(A, "project.status", { projectId: p }));
    expect(Number(st.project.eta.teamHours)).toBeGreaterThan(36); // the later start moved the planned ETA (from the planner)
    await ok(R.econ(A, "project.replace", { projectId: p, memberId: m2, reason: "timing no longer works" }));
    expect((await R.q(`SELECT status FROM fleet.fleet_project_members WHERE member_id = $1`, [m2]))[0].status).toBe("removed");
    await ok(R.econ(A, "project.cancel", { projectId: p, reason: "test cleanup" }));
  });

  it("revenue share is settled from the venture's ledger net profit (external), within its term", async () => {
    await ok(R.econ(B, "venture.create", { key: "b-share", model: "software", offer: "share", state: "selected", channels: ["direct"] }));
    await R.econ(B, "rail.require", { ventureKey: "b-share" });
    const p = (await ok(R.econ(B, "project.propose", plan("share", "b-share", {
      roles: [{ role: "engineer", taskScope: "backend", requiredCapability: "backend", compensation: { type: "HYBRID", fixedMinor: 300, revenueShareBp: 1_000, revenueShareCapMinor: 1_000, revenueShareUntil: inDays(30) } }],
    })))).project.projectId;
    await ok(R.econ(B, "project.fund", { projectId: p, amountMinor: 300, source: "own" }));
    const m = (await ok(R.econ(B, "project.offer", { projectId: p, role: "engineer", agentId: D.id, deliverable: "backend", expectedHours: 20, deadline: inDays(5) }))).memberId;
    await ok(R.econ(D, "project.respond", { memberId: m, response: "ACCEPT" }));
    const ext = `sale:${crypto.randomUUID()}`;
    const vb = (await R.q(`SELECT venture_id FROM fleet.fleet_ventures WHERE venture_key = 'b-share'`))[0].venture_id;
    await svc.query(`SELECT fleet.svc_settlement_ingest($1, $2, 'sale', 5000, 0, 'GBP', $4, now(), $3, NULL)`, [rail, ext, sha(ext), vb]);
    const net = Number((await R.one(`fleet.fleet_venture_financials((SELECT venture_id FROM fleet.fleet_ventures WHERE venture_key = 'b-share'))`)).netProfitMinor);
    expect(net).toBeGreaterThan(0);
    const flows0 = await external();
    const s = await ok(R.econ(D, "project.settle_share", { memberId: m }));
    expect(s).toMatchObject({ ventureNetProfitMinor: net, owedMinor: Math.floor(net / 10), paidNowMinor: Math.floor(net / 10) });
    expect(await ok(R.econ(B, "project.settle_share", { memberId: m }))).toMatchObject({ paidNowMinor: 0 }); // never twice
    expect(await external()).toEqual(flows0);                                                            // still not Fleet revenue
    expect(await R.econ(C, "project.settle_share", { memberId: m })).toMatchObject({ ok: false, code: "FLEET_PROJECT_NOT_PARTY" });
    await ok(R.econ(B, "project.cancel", { projectId: p, reason: "test cleanup" }));
  });

  it("28: a member's death settles its contract; the lead's death or quarantine cancels its projects — authority ends at once", async () => {
    // Lead C (quarantined later) with member D; lead A with member B (B dies).
    await ok(R.econ(C, "venture.create", { key: "c-app", model: "software", offer: "app", state: "selected", channels: ["direct"] }));
    const pc = (await ok(R.econ(C, "project.propose", plan("c-proj", "c-app")))).project.projectId;
    await ok(R.econ(C, "project.fund", { projectId: pc, amountMinor: 1_500, source: "own" }));
    const md = (await ok(R.econ(C, "project.offer", { projectId: pc, role: "engineer", agentId: D.id, deliverable: "api", expectedHours: 20, deadline: inDays(5) }))).memberId;
    await ok(R.econ(D, "project.respond", { memberId: md, response: "ACCEPT" }));

    const pa = (await ok(R.econ(A, "project.propose", plan("a-proj", "portal-three")))).project.projectId;
    await ok(R.econ(A, "project.fund", { projectId: pa, amountMinor: 1_200, source: "own" }));
    const mb = (await ok(offer(pa, B))).memberId;
    await ok(R.econ(B, "project.respond", { memberId: mb, response: "ACCEPT" }));
    await ok(R.econ(A, "project.start", { projectId: pa }));
    await ok(R.econ(A, "project.task", { projectId: pa, taskKey: "arch", action: "start" }));
    await ok(R.econ(A, "project.task", { projectId: pa, taskKey: "arch", action: "deliver" }));
    await ok(R.econ(B, "project.task", { projectId: pa, taskKey: "backend", action: "start" }));
    await ok(R.econ(B, "project.task", { projectId: pa, taskKey: "backend", action: "deliver" })); // delivered, then B dies

    const bCash = await R.balance(acct(B, "agent_cash"));
    expect(await R.one(`fleet.fleet_mark_dead($1, 'test death', $2, 'operator')`, [B.id, OWNER])).toBe(true);
    expect((await R.q(`SELECT status, exit_reason FROM fleet.fleet_project_members WHERE member_id = $1`, [mb]))[0]).toMatchObject({ status: "exited", exit_reason: expect.stringMatching(/died/) });
    expect(await R.balance(acct(B, "agent_cash"))).toBe(bCash + 1_000); // its delivered work was earned (now part of its estate)
    expect(await R.econ(B, "project.list")).toMatchObject({ ok: false, code: "FLEET_AGENT_DEAD" });
    expect((await R.q(`SELECT status FROM fleet.fleet_projects WHERE project_id = $1`, [pa]))[0].status).toBe("active"); // the lead's project continues

    // The lead is quarantined: its project is cancelled, the member exits, escrow returns to the lead (its estate).
    const cCash = await R.balance(acct(C, "agent_cash"));
    await R.one(`fleet.fleet_begin_termination($1, 'quarantine test', $2, 'operator')`, [C.id, OWNER]);
    const pcRow = (await R.q(`SELECT status, cancel_reason, escrow_own_minor FROM fleet.fleet_projects WHERE project_id = $1`, [pc]))[0];
    expect(pcRow).toMatchObject({ status: "cancelled", escrow_own_minor: "0" });
    expect(pcRow.cancel_reason).toMatch(/lead unavailable/);
    expect(await R.balance(acct(C, "agent_cash"))).toBe(cCash + 1_500);
    expect((await R.q(`SELECT status FROM fleet.fleet_project_members WHERE member_id = $1`, [md]))[0].status).toBe("exited");
    expect((await R.econ(C, "project.list")).code).toMatch(/^FLEET_AGENT_(QUARANTINED|DEAD)$/); // no project authority either way
    expect(await R.one(`fleet.fleet_ledger_verify()`)).toMatchObject({ ok: true });
    // A dead or quarantined agent cannot be offered work.
    expect(await R.econ(A, "project.offer", { projectId: pa, role: "engineer", agentId: B.id, deliverable: "x", expectedHours: 1, deadline: inDays(1) }))
      .toMatchObject({ ok: false, code: "FLEET_PROJECT_AGENT_UNAVAILABLE" });
    await ok(R.econ(A, "project.cancel", { projectId: pa, reason: "test cleanup" }));
  });

  it("29/30/31: recruitment never creates an agent, never touches replication, the registry cap or the constitutional 50", async () => {
    const st = (await R.q(`SELECT max_agents, replication_enabled FROM fleet.fleet_state`))[0];
    const rep = (await R.q(`SELECT to_jsonb(s) AS s FROM fleet.fleet_replication_state s`))[0].s;
    expect(FLEET_PG_HARD_MAX_AGENTS).toBe(50);
    expect(st.replication_enabled).toBe(false);
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_birth_orders)`))).toBe(0);
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_agents)`))).toBe(4);
    // No project function writes agents, births, replication or the registry state.
    const src = (await R.q(`SELECT string_agg(p.prosrc, ' ') AS s FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'fleet' AND (p.proname LIKE 'fleet_econ_project_%' OR p.proname LIKE 'fleet_project_%' OR p.proname = 'fleet_admin_projects')`))[0].s as string;
    expect(src).not.toMatch(/INSERT INTO fleet_agents|fleet_birth_orders|fleet_replication_|UPDATE fleet_state|max_agents/);
    expect((await R.q(`SELECT max_agents, replication_enabled FROM fleet.fleet_state`))[0]).toEqual(st);
    expect((await R.q(`SELECT to_jsonb(s) AS s FROM fleet.fleet_replication_state s`))[0].s).toEqual(rep);
  });

  it("the dashboard read lists projects with lead, members, compensation, planner ETAs and events (read-only gateway op)", async () => {
    const r = await R.one(`fleet.fleet_admin_projects('{}'::jsonb)`);
    expect(r.summary).toMatchObject({ completed: 1 });
    const done = r.projects.find((x: any) => x.projectId === P);
    expect(done).toMatchObject({ leadAgentId: A.id, status: "completed", eta: { soloHours: 52, teamHours: 36 } });
    expect(done.members[0]).toMatchObject({ agentId: B.id, role: "engineer", compensation: { type: "FIXED" }, paidMinor: 1000 });
    expect(done.events.length).toBeGreaterThan(5);
    const src = (await R.q(`SELECT prosrc FROM pg_proc WHERE proname = 'dash_call'`))[0].prosrc as string;
    expect(src).toContain("'projects'");
    expect(src).toContain("WHEN 'projects' THEN fleet_admin_projects(a)");
  });
});

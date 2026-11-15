/**
 * Project runtime readiness (owner §12, V2.2) — four TEST founders run the full team-project workflow through their own
 * founder runtime: the real FounderMind turn loop and FounderToolbox (the `project` tool and its op mapping), each
 * toolbox calling FleetController through the RESTRICTED agent role of a real migrated registry (ephemeral PostgreSQL).
 *
 * No model is called and nothing is paid: each founder's "model" is a scripted policy that reads the tool outputs it
 * receives (the same untrusted tool messages a model reads) and chooses its next call — so IDs, offers, counters and
 * figures flow through the runtime exactly as in production. The only non-agent steps are the environment: one external
 * customer sale (the rail settlement) and the service's Treasury allocation pass. No owner action anywhere.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { FounderMind } from "../../fleet/founder/mind.js";
import { FounderToolbox } from "../../fleet/founder/toolbox.js";
import { LoopGuard } from "../../fleet/founder/loop-guard.js";
import { FOUNDER_MANIFEST_V2 } from "../../fleet/capabilities.js";
import { toolsFor } from "../../fleet/cognition/gateway.js";

const PG_BIN = findPgBin();
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

type Call = { name: string; arguments: Record<string, unknown> };
type Step = (last: any) => Call;

/** One test founder: its own runtime (mind + toolbox) and a scripted policy that reads tool outputs. */
function founderRuntime(R: EconomyRegistry, who: Founder, label: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `prj-${label}-`));
  const dirs = { w: path.join(root, "w"), s: path.join(root, "s"), m: path.join(root, "s", "memory") };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const toolbox = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: dirs.w, memoryDir: dirs.m, loopGuard: new LoopGuard(), selfGovernance: true, ports: {
    ledger: () => R.gw.ledger(who.id, who.token), spendOrder: async () => ({ ok: false }), proposeKnowledge: async () => ({}), knowledge: async () => [],
    requestIdentityFact: async () => ({}),
    economy: (op, args) => R.gw.economy(who.id, who.token, op, args),
  } as never });
  let queue: Step[] = [];
  let n = 0;
  const outputs: Array<{ tool: string; ok: boolean; out: any }> = [];
  const mind = new FounderMind({ toolbox, stateDir: dirs.s, maxStepsPerTurn: 20, ports: {
    cognitionStatus: async () => ({ policyEnabled: true, provider: "anthropic", founderEnabled: true, paused: false }),
    infer: async (messages: unknown[]) => {
      const tools = (messages as Array<{ role: string; content: string; isError?: boolean }>).filter((m) => m.role === "tool");
      const lastMsg = tools.at(-1);
      let last: any = null;
      if (lastMsg) {
        const body = lastMsg.content.split("\n").slice(1).join("\n");
        try { last = JSON.parse(body); } catch { last = { raw: body }; }
        outputs.push({ tool: "?", ok: !lastMsg.isError, out: last });
      }
      const step = queue.shift();
      const call = step ? step(last) : { name: "sleep", arguments: { reason: "done for now" } };
      return { content: "", toolCalls: [{ id: `${label}-${++n}`, ...call }], usage: { inputTokens: 1, outputTokens: 1 }, chargedCents: 0, requestId: `${label}-r${n}` };
    },
  } });
  return {
    outputs,
    /** One autonomous turn: the founder runs its steps (each reading the previous tool output), then sleeps. */
    async turn(steps: Step[]) {
      queue = [...steps];
      const r = await mind.turn("heartbeat");
      expect(r.refusals, JSON.stringify({ label, refusals: r.refusals, last: outputs.slice(-3) })).toEqual([]);
      expect(queue.length, JSON.stringify({ label, r, last: outputs.slice(-2) }).slice(0, 1500)).toBe(0);
      return r;
    },
  };
}
const p = (op: string, args: Record<string, unknown> = {}): Call => ({ name: "project", arguments: { op, args } });

describe.skipIf(!PG_BIN)("project runtime readiness: test founders run the whole team-project workflow through their own runtime", () => {
  let R: EconomyRegistry;
  let A: Founder, B: Founder, C: Founder, D: Founder;
  let svc: pg.Pool;
  let rail = "";
  const acct = (who: Founder, cls: string) => `agent:${who.id}:${cls.slice(6)}`;
  const ok = async (q: Promise<Record<string, any>>) => { const r = await q; expect(r, JSON.stringify(r)).toMatchObject({ ok: true }); return r; };

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 4, allocationCents: 1_000_000, treasuryCents: 10_000_000 });
    [A, B, C, D] = R.founders;
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2 });
    await R.store.grantServiceRole();
    // Environment (configured once, before the workflow): a rail with a 20% profit tax, and the Treasury sweep policy
    // switched on — the owner's standing configuration, not a step of the workflow.
    const e = await R.one(`fleet.fleet_admin_legal_entity_add('Fleet Trading Ltd', 'GB', 'company', true, $1)`, [OWNER]);
    await R.one(`fleet.fleet_admin_tax_profile_set($1, '[{"taxKind":"profit","rateBp":2000}]'::jsonb, now() - interval '1 second', NULL, $2)`, [e.entity_id, OWNER]);
    rail = (await R.one(`fleet.fleet_admin_rail_add('simulated', 'sim', 'shared', NULL, ARRAY['receive_payments'], 'sim checkout', NULL, 'simulated', NULL, NULL, $1)`, [OWNER])).railId;
    await R.one(`fleet.fleet_admin_sweep_policy_set(true, NULL, NULL, NULL, NULL, NULL, $1)`, [OWNER]);
    // B's earlier work for C (delivered and accepted backend work): the history A will discover.
    await ok(R.econ(C, "venture.create", { key: "c-prior", model: "software", offer: "x", state: "selected", channels: ["direct"] }));
    const p0 = (await ok(R.econ(C, "project.propose", {
      idempotencyKey: "prj:prior-0001", key: "prior", ventureKey: "c-prior", name: "Prior", objective: "earlier work", expectedValueMinor: 10_000, expectedReturnMinor: 5_000,
      budgetMinor: 500, opportunityCostMinor: 0, timeValueMinorPerDay: 4_000, coordinationHours: 1, coordinationCostMinor: 100, risk: "low",
      justification: { decomposition: "a, b ∥ c", parallelism: "b ∥ c", whyTeam: "speed", timeToRevenue: "sooner" },
      tasks: [{ key: "a", title: "A", ownerRole: "lead", hours: 4, deliverable: "a", acceptance: "a" }, { key: "b", title: "B", ownerRole: "engineer", hours: 12, deps: ["a"], deliverable: "b", acceptance: "b", capability: "backend" },
        { key: "c", title: "C", ownerRole: "lead", hours: 12, deps: ["a"], deliverable: "c", acceptance: "c" }],
      roles: [{ role: "engineer", taskScope: "b", requiredCapability: "backend", compensation: { type: "FIXED", fixedMinor: 300 } }],
    }))).id;
    await ok(R.econ(C, "project.fund", { projectId: p0, amountMinor: 300, source: "own" }));
    const m0 = (await ok(R.econ(C, "project.offer", { projectId: p0, role: "engineer", agentId: B.id, deliverable: "b", expectedHours: 12, deadline: inDays(3), compensation: { type: "FIXED", fixedMinor: 300 } }))).memberId;
    await ok(R.econ(B, "project.respond", { memberId: m0, response: "ACCEPT" }));
    await ok(R.econ(C, "project.start", { projectId: p0 }));
    for (const [who, k] of [[C, "a"], [B, "b"], [C, "c"]] as const) {
      await ok(R.econ(who, "project.task", { projectId: p0, taskKey: k, action: "start" }));
      await ok(R.econ(who, "project.task", { projectId: p0, taskKey: k, action: "deliver" }));
      await ok(R.econ(C, "project.review", { projectId: p0, taskKey: k, verdict: "accept", reason: "ok" }));
    }
    await ok(R.econ(C, "project.complete", { projectId: p0, lessons: "backend delivered on time" }));
  }, 300_000);
  afterAll(async () => { await svc?.end(); await R?.close(); });

  it("the upgraded founder advertises and executes the project tool under its existing manifest (planning / spend.request; no new authority)", () => {
    expect(toolsFor(FOUNDER_MANIFEST_V2.allowed).map((t) => t.name)).toContain("project");
  });

  it("discover → propose (planner concurrency) → offer → COUNTER / DECLINE / ACCEPT → fund → work → review → sale → Treasury → distribute → assess → complete → knowledge", async () => {
    const ownerReq0 = Number(await R.one(`(SELECT count(*) FROM fleet.fleet_owner_requests)`));
    const instr0 = Number(await R.one(`(SELECT count(*) FROM fleet.fleet_admin_instructions)`));
    const orders0 = Number(await R.one(`(SELECT count(*) FROM fleet.fleet_payment_orders)`));
    const fa = founderRuntime(R, A, "A"), fb = founderRuntime(R, B, "B"), fc = founderRuntime(R, C, "C"), fd = founderRuntime(R, D, "D");
    const s: Record<string, any> = {};
    const terms = (fixed: number, bp: number) => ({ type: "HYBRID", fixedMinor: fixed, profitShareBp: bp, profitShareUntil: inDays(120) });

    // A: discovery from real delivery history, then a plan the planner evaluates.
    await fa.turn([
      () => ({ name: "venture", arguments: { op: "create", args: { key: "portal", model: "software", offer: "customer portal", state: "selected", channels: ["direct"] } } }),
      () => ({ name: "fleet_capital", arguments: { op: "require_rail", args: { ventureKey: "portal" } } }),
      () => p("talent", { capability: "backend" }),
      (last) => {
        const withHistory = last.agents.filter((x: any) => x.history.some((h: any) => h.capability === "backend" && h.tasksAccepted > 0));
        s.engineer = withHistory[0].agentId;                 // the agent with delivered backend work
        s.firstDesigner = last.agents.find((x: any) => x.agentId !== s.engineer && x.agentId !== C.id).agentId;
        return p("propose", {
          key: "portal-v1", ventureKey: "portal", name: "Customer portal", objective: "launch the portal with backend and design in parallel",
          expectedValueMinor: 50_000, expectedReturnMinor: 30_000, budgetMinor: 600, opportunityCostMinor: 1_000, timeValueMinorPerDay: 4_000,
          qualityBenefitMinor: 30_000, forecast: { qualityReasoning: "I have neither backend nor design capability: the specialists decide whether the portal ships at all",
            timeSavingReasoning: "backend and design run in parallel after the architecture", evidence: [{ kind: "fleet_outcome", observation: "the engineer delivered backend work on time before" }] },
          coordinationHours: 3, coordinationCostMinor: 500, risk: "medium",
          justification: { decomposition: "architecture; backend ∥ design ∥ frontend; integration", parallelism: "three branches after the architecture",
            whyTeam: "backend and design are capabilities I lack", timeToRevenue: "launch at integration" },
          tasks: [
            { key: "arch", title: "Architecture", ownerRole: "lead", hours: 8, deliverable: "design doc", acceptance: "API and data model" },
            { key: "backend", title: "Backend", ownerRole: "engineer", hours: 20, deps: ["arch"], deliverable: "API", acceptance: "tests pass", capability: "backend" },
            { key: "design", title: "Design", ownerRole: "designer", hours: 12, deps: ["arch"], deliverable: "screens", acceptance: "approved screens", capability: "design" },
            { key: "frontend", title: "Frontend", ownerRole: "lead", hours: 18, deps: ["arch"], deliverable: "UI", acceptance: "usable" },
            { key: "integration", title: "Integration", ownerRole: "lead", hours: 6, deps: ["backend", "design", "frontend"], deliverable: "live portal", acceptance: "end to end" },
          ],
          roles: [
            { role: "engineer", taskScope: "the backend API", requiredCapability: "backend", compensation: terms(600, 3_000) },
            { role: "designer", taskScope: "the screens", requiredCapability: "design", compensation: { type: "PROFIT_SHARE", profitShareBp: 2_000, profitShareUntil: inDays(120) } },
          ],
        });
      },
      (last) => { s.pid = last.id; s.eta = last.project.eta; return p("fund", { projectId: s.pid, amountMinor: 600, source: "own" }); },
      () => p("offer", { projectId: s.pid, role: "engineer", agentId: s.engineer, deliverable: "the backend API", expectedHours: 20, deadline: inDays(7), compensation: terms(600, 3_000) }),
      () => p("offer", { projectId: s.pid, role: "designer", agentId: s.firstDesigner, deliverable: "the screens", expectedHours: 12, deadline: inDays(7),
        compensation: { type: "PROFIT_SHARE", profitShareBp: 2_000, profitShareUntil: inDays(120) } }),
    ]);
    expect(s.engineer).toBe(B.id);
    expect(s.firstDesigner).toBe(D.id);
    // The planner's real concurrency: solo 64 h; critical path arch → backend → integration = 34 h; + 3 h coordination.
    expect(s.eta).toMatchObject({ soloHours: 64, teamHours: 37, criticalPath: ["arch", "backend", "integration"] });

    // B counters (its own economics); D declines; A accepts B's counter and offers design to C, who accepts.
    await fb.turn([() => p("offers"), (last) => { s.mB = last.offers[0].memberId; return p("respond", { memberId: s.mB, response: "COUNTER",
      counter: { compensation: terms(600, 3_500) }, reason: "the backend carries most of the delivery risk" }); }]);
    await fd.turn([() => p("offers"), (last) => p("respond", { memberId: last.offers[0].memberId, response: "DECLINE", reason: "my own venture needs me" })]);
    await fa.turn([
      () => p("status", { projectId: s.pid }),
      (last) => p("accept_counter", { projectId: s.pid, memberId: last.project.members.find((m: any) => m.status === "countered").memberId }),
      () => p("offer", { projectId: s.pid, role: "designer", agentId: C.id, deliverable: "the screens", expectedHours: 12, deadline: inDays(7),
        compensation: { type: "PROFIT_SHARE", profitShareBp: 2_000, profitShareUntil: inDays(120) } }),
    ]);
    await fc.turn([() => p("offers"), (last) => p("respond", { memberId: last.offers.find((o: any) => o.projectId === s.pid).memberId, response: "ACCEPT", reason: "fair share" })]);

    // Work: the lead and both members perform and deliver their own tasks; the lead reviews.
    const work = (k: string): Step[] => [() => p("task", { projectId: s.pid, taskKey: k, action: "start" }), () => p("task", { projectId: s.pid, taskKey: k, action: "deliver",
      evidence: [{ kind: "note", observation: `${k} delivered` }] })];
    const review = (k: string): Step => () => p("review", { projectId: s.pid, taskKey: k, verdict: "accept", reason: "meets acceptance" });
    await fa.turn([() => p("start", { projectId: s.pid }), ...work("arch"), review("arch"), ...work("frontend"), review("frontend")]);
    await fb.turn(work("backend"));
    await fc.turn(work("design"));
    const b0 = await R.balance(acct(B, "agent_cash"));
    await fa.turn([review("backend"), review("design"), ...work("integration"), review("integration")]);
    expect(await R.balance(acct(B, "agent_cash"))).toBe(b0 + 600);            // the agreed fixed part, paid once on acceptance

    // Environment: a real customer sale (£1,250 → £1,000 after 20% tax) and the service's internal Treasury pass.
    const vid = (await R.q(`SELECT venture_id FROM fleet.fleet_ventures WHERE agent_id = $1 AND venture_key = 'portal'`, [A.id]))[0].venture_id;
    const ext = `sale:${crypto.randomUUID()}`;
    await svc.query(`SELECT fleet.svc_settlement_ingest($1, $2, 'sale', 125000, 0, 'GBP', $3, now(), $4, NULL)`, [rail, ext, vid, sha(ext)]);
    const t0 = await R.balance("fleet:treasury:unallocated");
    const sweep = (await svc.query(`SELECT fleet.svc_sweep_run('2027-05') AS r`)).rows[0].r;
    // Attributable profit = £1,000 − the £6 fixed project cost = £994; 10% → £99.40 to the Treasury.
    expect(sweep).toMatchObject({ enabled: true });
    // A's contribution on this project's profit: 10% of £994 = £99.40. (B's fixed-pay income — £6 here, £3 from the prior
    // project — is inside B's realised net profit and is swept at B: +£0.90, as the owner's order requires.)
    expect(Number(await R.one(`(SELECT amount_minor FROM fleet.fleet_sweep_records WHERE agent_id = $1)`, [A.id]))).toBe(9_940);
    expect(Number(await R.one(`(SELECT amount_minor FROM fleet.fleet_sweep_records WHERE agent_id = $1)`, [B.id]))).toBe(90);
    expect(await R.balance("fleet:treasury:unallocated")).toBe(t0 + 9_940 + 90);

    // A distributes the post-sweep pool, assesses, completes; B assesses too.
    const cB = await R.balance(acct(B, "agent_cash")), cC = await R.balance(acct(C, "agent_cash"));
    await fa.turn([
      () => p("distribute", { projectId: s.pid }),
      (last) => { s.dist = last; return p("assess", { projectId: s.pid, assessment: "both specialists delivered; one review round on the backend", qualityRealisedMinor: 25_000,
        evidence: [{ kind: "note", observation: "review log" }] }); },
      () => p("complete", { projectId: s.pid, actualReturnMinor: 99_400, lessons: "parallel specialists shortened the critical path; profit shares kept the fixed cost low" }),
      (last) => { s.done = last; return { name: "economic_knowledge", arguments: { op: "search", args: { topic: "team_project" } } }; },
      (last) => { s.knowledge = last; return { name: "sleep", arguments: { reason: "project complete" } }; },
    ]);
    await fb.turn([() => p("assess", { projectId: s.pid, assessment: "clear scope; integration took one extra pass", evidence: [{ kind: "note", observation: "my task log" }] })]);

    // Treasury before shares: pool £894.60 split by the NEGOTIATED contracts (35% / 20%), the lead keeps its explicit 45%.
    expect(s.dist.tranche).toMatchObject({ profitMinor: 99_400, sweepRateBp: 1_000, sweepAttributedMinor: 9_940, distributableMinor: 89_460, leadShareBp: 4_500 });
    expect(s.dist.tranche.allocations.map((a: any) => [a.agentId, a.shareBp, a.amountMinor])).toEqual([[B.id, 3_500, 31_311], [C.id, 2_000, 17_892]]);
    expect(s.dist.tranche.leadResidualMinor).toBe(89_460 - 31_311 - 17_892);
    expect(await R.balance(acct(B, "agent_cash"))).toBe(cB + 31_311);
    expect(await R.balance(acct(C, "agent_cash"))).toBe(cC + 17_892);
    // Forecast vs realised, and the institutional record the founder could read back.
    expect(s.done.forecast).toMatchObject({ label: "forecast", qualityBenefitMinor: 30_000, teamHours: 37, soloHours: 64 });
    expect(s.done.realised).toMatchObject({ label: "realised", costMinor: 600, attributableProfitMinor: 99_400, sweepAttributedMinor: 9_940, distributedMinor: 49_203, reportedReturnMinor: 99_400 });
    expect(s.done.realised.assessments[0]).toMatchObject({ by: A.id, role: "lead", qualityRealisedMinor: 25_000 });
    expect(JSON.stringify(s.knowledge)).toMatch(/FORECAST vs REALISED/);

    // Owner absence through the whole workflow; nothing external moved; the ledger is whole.
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_owner_requests)`))).toBe(ownerReq0);
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_admin_instructions)`))).toBe(instr0);
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_payment_orders)`))).toBe(orders0);
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_capital_requests)`))).toBe(0);
    expect(await R.one(`fleet.fleet_ledger_verify()`)).toMatchObject({ ok: true, unbalanced: 0 });
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_agents)`))).toBe(4);
  });
});

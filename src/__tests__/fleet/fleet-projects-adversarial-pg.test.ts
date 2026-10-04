/**
 * V2.2 adversarial mechanics audit of v42 team projects (PostgreSQL) — the scenarios not already covered by
 * fleet-projects-pg.test.ts and fleet-treasury-allocation-pg.test.ts. Every money path ends with a conservation check:
 * the sum of all cash-like balances (agent cash, reserved, escrow, tax reserve, envelope capital, Treasury) is unchanged
 * by project activity (no money is created or destroyed; only external flows change it), and the hash chain verifies.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";

const PG_BIN = findPgBin();
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

describe.skipIf(!PG_BIN)("v42 team projects — adversarial mechanics (PostgreSQL)", () => {
  let R: EconomyRegistry;
  let A: Founder, B: Founder, C: Founder, D: Founder;
  const acct = (who: Founder, cls: string) => `agent:${who.id}:${cls.slice(6)}`;
  const ok = async (p: Promise<Record<string, any>>) => { const r = await p; expect(r, JSON.stringify(r)).toMatchObject({ ok: true }); return r; };
  const money = async () => Number(await R.one(`(SELECT COALESCE(sum(fleet.fleet_ledger_balance(account_id)), 0) FROM fleet.fleet_ledger_accounts
    WHERE class IN ('agent_cash','agent_reserved','agent_project_escrow','agent_tax_reserve','agent_envelope_cash','treasury_cash'))`));
  const conserved = async (before: number) => {
    expect(await money()).toBe(before);
    expect(await R.one(`fleet.fleet_ledger_verify()`)).toMatchObject({ ok: true, unbalanced: 0 });
  };
  const plan = (key: string, venture: string, extra: Record<string, unknown> = {}) => ({
    idempotencyKey: `prj:${crypto.randomUUID()}`, key, ventureKey: venture, name: `P ${key}`, objective: "ship sooner",
    expectedValueMinor: 50_000, expectedReturnMinor: 30_000, budgetMinor: 3_000, opportunityCostMinor: 0, timeValueMinorPerDay: 4_000,
    coordinationHours: 2, coordinationCostMinor: 500, risk: "low",
    justification: { decomposition: "arch, backend ∥ frontend, integration", parallelism: "backend ∥ frontend", whyTeam: "critical path", timeToRevenue: "sooner" },
    tasks: [
      { key: "arch", title: "Arch", ownerRole: "lead", hours: 8, deliverable: "doc", acceptance: "ok" },
      { key: "backend", title: "Backend", ownerRole: "engineer", hours: 20, deps: ["arch"], deliverable: "api", acceptance: "ok" },
      { key: "frontend", title: "Frontend", ownerRole: "lead", hours: 18, deps: ["arch"], deliverable: "ui", acceptance: "ok" },
      { key: "integration", title: "Integration", ownerRole: "lead", hours: 6, deps: ["backend", "frontend"], deliverable: "live", acceptance: "ok" },
    ],
    roles: [{ role: "engineer", taskScope: "backend", requiredCapability: "backend", compensation: { type: "FIXED", fixedMinor: 1_000 } }],
    ...extra,
  });
  const offer = (lead: Founder, pid: string, to: Founder, comp: Record<string, unknown> = { type: "FIXED", fixedMinor: 1_000 }) => R.econ(lead, "project.offer", {
    projectId: pid, role: "engineer", agentId: to.id, deliverable: "api", expectedHours: 20, deadline: inDays(7), compensation: comp });

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 4, allocationCents: 100_000, treasuryCents: 5_000_000 });
    [A, B, C, D] = R.founders;
    for (const [who, key] of [[A, "a1"], [A, "a2"], [A, "a3"], [A, "a4"], [B, "b1"], [C, "c1"]] as const) {
      await ok(R.econ(who, "venture.create", { key, model: "software", offer: key, state: "selected", channels: ["direct"] }));
    }
  }, 300_000);
  afterAll(async () => { await R?.close(); });

  it("cancellation BEFORE any milestone is earned pays nothing and returns the whole escrow", async () => {
    const m0 = await money(), cash0 = await R.balance(acct(A, "agent_cash"));
    const p = (await ok(R.econ(A, "project.propose", plan("before", "a1", {
      roles: [{ role: "engineer", taskScope: "backend", requiredCapability: "backend", compensation: { type: "MILESTONE", milestones: [{ key: "m1", taskKey: "backend", amountMinor: 900 }] } }],
    })))).id;
    await ok(R.econ(A, "project.fund", { projectId: p, amountMinor: 900, source: "own" }));
    const m = (await ok(offer(A, p, B, { type: "MILESTONE", milestones: [{ key: "m1", taskKey: "backend", amountMinor: 900 }] }))).memberId;
    await ok(R.econ(B, "project.respond", { memberId: m, response: "ACCEPT" }));
    await ok(R.econ(A, "project.start", { projectId: p }));
    await ok(R.econ(A, "project.task", { projectId: p, taskKey: "arch", action: "start" }));
    await ok(R.econ(A, "project.task", { projectId: p, taskKey: "arch", action: "deliver" }));
    await ok(R.econ(B, "project.task", { projectId: p, taskKey: "backend", action: "start" }));  // started, never delivered
    const r = await ok(R.econ(A, "project.cancel", { projectId: p, reason: "market moved" }));
    expect(r).toMatchObject({ paidOnSettlementMinor: 0, returned: { ownReturnedMinor: 900 } });
    expect(await R.balance(acct(A, "agent_cash"))).toBe(cash0);
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_project_payments WHERE project_id = $1)`, [p]))).toBe(0);
    await conserved(m0);
  });

  it("simultaneous obligations with a counter: an agent works in two projects; each project's escrow covers only its own contracts", async () => {
    const m0 = await money();
    const p1 = (await ok(R.econ(A, "project.propose", plan("sim-1", "a2")))).id;
    const p2 = (await ok(R.econ(A, "project.propose", plan("sim-2", "a3")))).id;
    await ok(R.econ(A, "project.fund", { projectId: p1, amountMinor: 1_000, source: "own" }));
    const m1 = (await ok(offer(A, p1, B))).memberId;
    await ok(R.econ(B, "project.respond", { memberId: m1, response: "ACCEPT" }));
    const m2 = (await ok(offer(A, p2, B))).memberId;
    await ok(R.econ(B, "project.respond", { memberId: m2, response: "COUNTER", counter: { compensation: { type: "FIXED", fixedMinor: 1_200 } }, reason: "busy: second project" }));
    // P1's escrow is fully committed to P1's contract; it can never back P2's counter.
    expect(await R.econ(A, "project.counter_accept", { projectId: p2, memberId: m2 })).toMatchObject({ ok: false, code: "FLEET_PROJECT_UNFUNDED" });
    await ok(R.econ(A, "project.fund", { projectId: p2, amountMinor: 1_200, source: "own" }));
    expect((await ok(R.econ(A, "project.counter_accept", { projectId: p2, memberId: m2 }))).contract.compensation).toMatchObject({ fixedMinor: 1_200 });
    // Both obligations are live and separately committed.
    const offers = await R.q(`SELECT project_id, status, terms ->> 'fixedMinor' AS f FROM fleet.fleet_project_members WHERE agent_id = $1 AND status = 'accepted'
      AND project_id IN ($2::uuid, $3::uuid) ORDER BY offered_at`, [B.id, p1, p2]);
    expect(offers.map((x) => [x.project_id, x.f])).toEqual([[p1, "1000"], [p2, "1200"]]);
    expect(Number(await R.one(`fleet.fleet_project_committed($1::uuid)`, [p1]))).toBe(1_000);
    expect(Number(await R.one(`fleet.fleet_project_committed($1::uuid)`, [p2]))).toBe(1_200);
    for (const p of [p1, p2]) await ok(R.econ(A, "project.cancel", { projectId: p, reason: "test cleanup" }));
    await conserved(m0);
  });

  it("replays: funding with the same key funds once; a second review of an accepted task is refused; fixed pay is paid once", async () => {
    const m0 = await money();
    const p = (await ok(R.econ(A, "project.propose", plan("replay", "a4")))).id;
    const esc0 = await R.balance(acct(A, "agent_project_escrow"));
    const f1 = await ok(R.econ(A, "project.fund", { projectId: p, amountMinor: 1_000, source: "own", idempotencyKey: "fund-replay-1" }));
    const f2 = await ok(R.econ(A, "project.fund", { projectId: p, amountMinor: 1_000, source: "own", idempotencyKey: "fund-replay-1" }));
    expect(f2.replayed).toBe(true);
    expect(f1.project.escrowMinor).toBe(1_000);
    expect(await R.balance(acct(A, "agent_project_escrow"))).toBe(esc0 + 1_000);
    const m = (await ok(offer(A, p, C))).memberId;
    await ok(R.econ(C, "project.respond", { memberId: m, response: "ACCEPT" }));
    await ok(R.econ(A, "project.start", { projectId: p }));
    await ok(R.econ(A, "project.task", { projectId: p, taskKey: "arch", action: "start" }));
    await ok(R.econ(A, "project.task", { projectId: p, taskKey: "arch", action: "deliver" }));
    await ok(R.econ(C, "project.task", { projectId: p, taskKey: "backend", action: "start" }));
    await ok(R.econ(C, "project.task", { projectId: p, taskKey: "backend", action: "deliver" }));
    expect((await ok(R.econ(A, "project.review", { projectId: p, taskKey: "backend", verdict: "accept", reason: "ok" }))).paidMinor).toBe(1_000);
    expect(await R.econ(A, "project.review", { projectId: p, taskKey: "backend", verdict: "accept", reason: "again" })).toMatchObject({ ok: false, code: "FLEET_INVALID_STATE" });
    // Even a direct second call of the payment helper pays nothing (exactly once per contract and kind).
    expect(Number(await R.one(`fleet.fleet_project_pay($1::uuid, $2::uuid, 'fixed', NULL, 1000, 'test', 'replay')`, [p, m]))).toBe(0);
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_project_payments WHERE member_id = $1)`, [m]))).toBe(1);
    await ok(R.econ(A, "project.cancel", { projectId: p, reason: "test cleanup" }));
    await conserved(m0);
  });

  it("insufficient spendable capital after commitments and tax restrictions: funding is refused at the custody boundary, exactly-available succeeds", async () => {
    const m0 = await money();
    const dst = (await ok(R.econ(B, "vendor.register", { vendorName: "Printer", category: "supplier", reference: "printer@supplier.example" }))).destinationId;
    const p = (await ok(R.econ(B, "project.propose", plan("tight", "b1")))).id;
    const spend0 = Number((await R.one(`fleet.fleet_agent_economics($1)`, [B.id])).expensePurchasingCapacity);
    // A committed spend order (reserved) and a tax reservation both leave spendable cash.
    const o = await R.gw.spendRequest(B.id, B.token, { idempotencyKey: `s:${crypto.randomUUID()}`, amountCents: 30_000, category: "expense", destinationId: dst, purpose: "stock" });
    expect(o.ok, JSON.stringify(o)).toBe(true);
    await R.one(`fleet.fleet_ledger_post('tax_reservation', $1, $2, 'tax set aside', 'owner', $3, NULL, NULL, NULL, NULL, now(),
      jsonb_build_array(jsonb_build_object('account', $4::text, 'side', 'D', 'amount', 20000), jsonb_build_object('account', $5::text, 'side', 'C', 'amount', 20000)))`,
      [`tax:${crypto.randomUUID()}`, OWNER, B.id, acct(B, "agent_tax_reserve"), acct(B, "agent_cash")]);
    const spend = Number((await R.one(`fleet.fleet_agent_economics($1)`, [B.id])).expensePurchasingCapacity);
    expect(spend).toBe(spend0 - 50_000);
    expect(await R.econ(B, "project.fund", { projectId: p, amountMinor: spend + 1, source: "own" })).toMatchObject({ ok: false, code: "FLEET_PROJECT_INSUFFICIENT_FUNDS", availableMinor: spend });
    await ok(R.econ(B, "project.fund", { projectId: p, amountMinor: spend, source: "own" }));
    expect(Number((await R.one(`fleet.fleet_agent_economics($1)`, [B.id])).expensePurchasingCapacity)).toBe(0);
    await ok(R.econ(B, "project.cancel", { projectId: p, reason: "test cleanup" }));
    await conserved(m0);
  });

  it("completion where a participant already died: its earned pay was settled once; completion succeeds; nothing is paid twice", async () => {
    const m0 = await money();
    const p = (await ok(R.econ(C, "project.propose", plan("after-death", "c1")))).id;
    await ok(R.econ(C, "project.fund", { projectId: p, amountMinor: 1_000, source: "own" }));
    const m = (await ok(offer(C, p, D))).memberId;
    await ok(R.econ(D, "project.respond", { memberId: m, response: "ACCEPT" }));
    await ok(R.econ(C, "project.start", { projectId: p }));
    await ok(R.econ(C, "project.task", { projectId: p, taskKey: "arch", action: "start" }));
    await ok(R.econ(C, "project.task", { projectId: p, taskKey: "arch", action: "deliver" }));
    await ok(R.econ(C, "project.review", { projectId: p, taskKey: "arch", verdict: "accept", reason: "ok" }));
    await ok(R.econ(D, "project.task", { projectId: p, taskKey: "backend", action: "start" }));
    await ok(R.econ(D, "project.task", { projectId: p, taskKey: "backend", action: "deliver" }));
    await ok(R.econ(C, "project.review", { projectId: p, taskKey: "backend", verdict: "accept", reason: "ok" }));  // fixed 1 000 paid
    expect(await R.one(`fleet.fleet_mark_dead($1, 'test death', $2, 'operator')`, [D.id, OWNER])).toBe(true);
    for (const k of ["frontend", "integration"]) {
      await ok(R.econ(C, "project.task", { projectId: p, taskKey: k, action: "start" }));
      await ok(R.econ(C, "project.task", { projectId: p, taskKey: k, action: "deliver" }));
      await ok(R.econ(C, "project.review", { projectId: p, taskKey: k, verdict: "accept", reason: "ok" }));
    }
    const done = await ok(R.econ(C, "project.complete", { projectId: p, lessons: "a member died after delivering" }));
    expect(done.paidOnSettlementMinor).toBe(0);
    expect(Number(await R.one(`(SELECT COALESCE(sum(amount_minor), 0) FROM fleet.fleet_project_payments WHERE member_id = $1)`, [m]))).toBe(1_000);
    expect((await R.q(`SELECT status FROM fleet.fleet_project_members WHERE member_id = $1`, [m]))[0].status).toBe("exited");
    expect(await R.econ(D, "project.list")).toMatchObject({ ok: false, code: "FLEET_AGENT_DEAD" });
    await conserved(m0);
  });

  it("custody: no project action bypasses Fleet custody — a non-lead cannot fund, review or replan; a stranger cannot distribute; another agent's envelope cannot fund it", async () => {
    const p = (await ok(R.econ(A, "project.propose", plan("custody", "a1")))).id;
    for (const [op, args] of [["project.fund", { projectId: p, amountMinor: 1, source: "own" }], ["project.review", { projectId: p, taskKey: "arch", verdict: "accept", reason: "x" }],
      ["project.replan", { projectId: p, reason: "x" }], ["project.cancel", { projectId: p, reason: "x" }], ["project.start", { projectId: p }]] as const) {
      expect(await R.econ(B, op, args), op).toMatchObject({ ok: false, code: "FLEET_PROJECT_NOT_LEAD" });
    }
    expect(await R.econ(B, "project.distribute", { projectId: p })).toMatchObject({ ok: false, code: "FLEET_PROJECT_NOT_PARTY" });
    expect(await R.econ(A, "project.fund", { projectId: p, amountMinor: 1, source: "fleet_capital", envelopeId: crypto.randomUUID() }))
      .toMatchObject({ ok: false, code: "FLEET_NOT_FOUND" });
    // The agent role can call no project helper or table directly (only through the authenticated api_economy).
    const agentPool = new pg.Pool({ connectionString: R.pgc.agentUrl, max: 1 });
    try {
      for (const sql of [`SELECT fleet.fleet_project_pay('${p}'::uuid, gen_random_uuid(), 'fixed', NULL, 1, 'x', 'x')`, `SELECT fleet.fleet_project_distribute('${p}'::uuid, 'x')`,
        `SELECT fleet.fleet_econ_project_fund('${A.id}', '{}'::jsonb)`, `SELECT * FROM fleet.fleet_project_payments`, `UPDATE fleet.fleet_projects SET name = 'x'`,
        `SELECT fleet.fleet_sweep_execute('${A.id}', 'x', 'x12345678')`]) {
        expect(await R.code(agentPool.query(sql)), sql).toBe("permission denied");
      }
    } finally { await agentPool.end(); }
    await ok(R.econ(A, "project.cancel", { projectId: p, reason: "test cleanup" }));
  });
});

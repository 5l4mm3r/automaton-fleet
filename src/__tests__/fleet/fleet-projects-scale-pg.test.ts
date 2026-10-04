/**
 * Schema v42 team projects at Fleet scale: real registries of 1, 10, 25 and 50 living agents (the constitutional
 * maximum), every agent leading or working in a concurrent team project at once (proposals, funding, offers, decisions,
 * deliveries, reviews, payments, completion — all in parallel). Afterwards the ledger verifies and balances, internal
 * project flows net to zero across the Fleet, Fleet external revenue is unchanged, and no agent was created.
 *
 * Dedicated run (it starts four registries): FLEET_SCALE_TESTS=1 npx vitest run src/__tests__/fleet/fleet-projects-scale-pg.test.ts
 */
import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";

const PG_BIN = findPgBin();
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

async function teamProject(R: EconomyRegistry, lead: Founder, member: Founder, i: number) {
  const ok = async (p: Promise<Record<string, any>>) => { const r = await p; if (!r.ok) throw new Error(JSON.stringify(r)); return r; };
  const venture = `v-${i}`;
  await ok(R.econ(lead, "venture.create", { key: venture, model: "software", offer: venture, state: "selected", channels: ["direct"] }));
  const p = (await ok(R.econ(lead, "project.propose", {
    idempotencyKey: `prj:${crypto.randomUUID()}`, key: `p-${i}`, ventureKey: venture, name: `Project ${i}`, objective: "ship sooner",
    expectedValueMinor: 40_000, expectedReturnMinor: 20_000, budgetMinor: 1_000, opportunityCostMinor: 500, timeValueMinorPerDay: 4_000,
    coordinationHours: 2, coordinationCostMinor: 400, risk: "low",
    justification: { decomposition: "a, b ∥ c, d", parallelism: "b and c in parallel", whyTeam: "b off the critical path", timeToRevenue: "sooner launch" },
    tasks: [
      { key: "a", title: "A", ownerRole: "lead", hours: 6, deliverable: "a", acceptance: "a" },
      { key: "b", title: "B", ownerRole: "dev", hours: 16, deps: ["a"], deliverable: "b", acceptance: "b" },
      { key: "c", title: "C", ownerRole: "lead", hours: 14, deps: ["a"], deliverable: "c", acceptance: "c" },
      { key: "d", title: "D", ownerRole: "lead", hours: 4, deps: ["b", "c"], deliverable: "d", acceptance: "d" },
    ],
    roles: [{ role: "dev", taskScope: "task b", requiredCapability: "backend", compensation: { type: "MILESTONE", milestones: [{ key: "mb", taskKey: "b", amountMinor: 700 }] } }],
  }))).id;
  await ok(R.econ(lead, "project.fund", { projectId: p, amountMinor: 900, source: "own", idempotencyKey: `fund:${i}` }));
  const m = (await ok(R.econ(lead, "project.offer", { projectId: p, role: "dev", agentId: member.id, deliverable: "b", expectedHours: 16, deadline: inDays(3),
    compensation: { type: "MILESTONE", milestones: [{ key: "mb", taskKey: "b", amountMinor: 700 }] } }))).memberId;
  await ok(R.econ(member, "project.respond", { memberId: m, response: "ACCEPT" }));
  await ok(R.econ(lead, "project.start", { projectId: p }));
  for (const [who, k] of [[lead, "a"], [member, "b"], [lead, "c"], [lead, "d"]] as const) {
    await ok(R.econ(who, "project.task", { projectId: p, taskKey: k, action: "start" }));
    await ok(R.econ(who, "project.task", { projectId: p, taskKey: k, action: "deliver" }));
    await ok(R.econ(lead, "project.review", { projectId: p, taskKey: k, verdict: "accept", reason: "ok" }));
  }
  await ok(R.econ(lead, "project.complete", { projectId: p, actualReturnMinor: 0, lessons: "scale run" }));
}

describe.skipIf(!process.env.FLEET_SCALE_TESTS || !PG_BIN)("v42 team projects at Fleet scale (1 / 10 / 25 / 50 living agents)", { timeout: 900_000 }, () => {
  const report: Record<string, unknown> = {};
  for (const n of [1, 10, 25, 50]) {
    it(`${n} living agent(s): concurrent team projects settle exactly; internal flows net to zero; nothing else moves`, async () => {
      const R = await startEconomyRegistry(PG_BIN!, { founders: n, allocationCents: 10_000, treasuryCents: Math.max(1_000_000, n * 20_000) });
      try {
        const agents0 = Number(await R.one(`(SELECT count(*) FROM fleet.fleet_agents)`));
        const flows0 = await R.one(`(fleet.fleet_daily_report() -> 'flows')`);
        const t0 = Date.now();
        if (n === 1) {
          // Alone, there is nobody to recruit (and recruitment never creates anyone).
          const [A] = R.founders;
          expect(await R.econ(A, "project.talent", {})).toMatchObject({ ok: true, agents: [] });
        } else {
          // Every agent is in exactly one project: pairs (lead 2k, member 2k+1), all at once.
          const pairs = Array.from({ length: Math.floor(n / 2) }, (_, k) => [R.founders[2 * k], R.founders[2 * k + 1]] as const);
          await Promise.all(pairs.map(([lead, member], k) => teamProject(R, lead, member, k)));
          expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_projects WHERE status = 'completed')`))).toBe(pairs.length);
          expect(Number(await R.one(`(SELECT COALESCE(sum(amount_minor), 0) FROM fleet.fleet_project_payments)`))).toBe(pairs.length * 700);
        }
        report[`${n} agents`] = { ms: Date.now() - t0 };
        expect(await R.one(`fleet.fleet_ledger_verify()`)).toMatchObject({ ok: true, unbalanced: 0 });
        expect(Number(await R.one(`(SELECT COALESCE(sum((e ->> 'internalProjectIncome')::bigint - (e ->> 'internalProjectExpense')::bigint), 0)
          FROM (SELECT fleet.fleet_agent_economics(agent_id) AS e FROM fleet.fleet_agents) x)`))).toBe(0);
        expect(Number(await R.one(`(SELECT COALESCE(sum(fleet.fleet_ledger_balance(account_id)), 0) FROM fleet.fleet_ledger_accounts WHERE class = 'agent_project_escrow')`))).toBe(0);
        expect(await R.one(`(fleet.fleet_daily_report() -> 'flows')`)).toEqual(flows0);
        expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_agents)`))).toBe(agents0);
      } finally {
        await R.close();
      }
    });
  }
  it("report", () => { console.log(`project scale: ${JSON.stringify(report)}`); });
});

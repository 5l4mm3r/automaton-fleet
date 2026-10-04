/**
 * Schema v42 team-project planner (pure): ETAs come from the task dependency graph and real concurrency, never from
 * hours ÷ headcount; coordination overhead is explicit; the recruitment gate compares benefit with cost + coordination.
 * (The database's fleet_project_schedule is checked against this module in fleet-projects-pg.test.ts.)
 */
import { describe, it, expect } from "vitest";
import { estimate, expectedCost, gate, schedule, type PlanTask } from "../../fleet/projects/planner.js";

// The brief's example: 8 h architecture, then 20 h backend and 18 h frontend in parallel, then 6 h integration.
const brief = (backendOwner: string, frontendOwner: string): PlanTask[] => [
  { key: "arch", role: "lead", hours: 8 },
  { key: "backend", role: backendOwner, hours: 20, deps: ["arch"] },
  { key: "frontend", role: frontendOwner, hours: 18, deps: ["arch"] },
  { key: "integration", role: "lead", hours: 6, deps: ["backend", "frontend"] },
];

describe("team-project planner", () => {
  it("23: time savings come from the dependency graph, not naive headcount division", () => {
    const e = estimate(brief("engineer", "lead"), 2);
    expect(e.soloHours).toBe(52);
    expect(e.makespanHours).toBe(34); // arch 8 → backend 20 ∥ frontend 18 → integration 6
    expect(e.teamHours).toBe(36);     // + 2 h coordination
    expect(e.timeSavedHours).toBe(16);
    expect(e.teamHours).not.toBe(52 / 2); // two agents never means half the time
    expect(e.criticalPath).toEqual(["arch", "backend", "integration"]);
  });

  it("24: adding an agent to a non-parallel (serial) task does not reduce the ETA — coordination makes it slower", () => {
    const chain: PlanTask[] = [
      { key: "a", role: "lead", hours: 4 },
      { key: "b", role: "helper1", hours: 4, deps: ["a"] },
      { key: "c", role: "helper2", hours: 4, deps: ["b"] },
      { key: "d", role: "helper3", hours: 4, deps: ["c"] },
    ];
    const solo = estimate(chain.map((t) => ({ ...t, role: "lead" })), 0);
    const team = estimate(chain, 1.5);
    expect(solo.teamHours).toBe(16);
    expect(team.makespanHours).toBe(16);           // still a 16 h chain with four owners
    expect(team.teamHours).toBe(17.5);             // plus coordination
    expect(team.timeSavedHours).toBe(-1.5);        // not 16 / 4
    // One serial 4 h task given to five agents is still a 4 h task.
    expect(estimate([{ key: "only", role: "x", hours: 4 }], 0).makespanHours).toBe(4);
  });

  it("25: parallel work owned by different agents shortens the critical path; the same owner cannot run two tasks at once", () => {
    const sameOwner = schedule(brief("lead", "lead"));
    expect(sameOwner.makespanHours).toBe(52);      // one owner: serial
    const twoOwners = schedule(brief("engineer", "lead"));
    expect(twoOwners.makespanHours).toBe(34);
    const threeOwners = schedule(brief("engineer", "designer"));
    expect(threeOwners.makespanHours).toBe(34);    // the critical path (20 h backend) is the bound, not the headcount
  });

  it("26: coordination overhead is included in the team ETA and in the recruitment gate", () => {
    const e0 = estimate(brief("engineer", "lead"), 0);
    const e5 = estimate(brief("engineer", "lead"), 5);
    expect(e5.teamHours - e0.teamHours).toBe(5);
    // Benefit = 16 h saved × £40/day = £26.66 (2666p); cost = contract 1000 + coordination.
    const g = gate(estimate(brief("engineer", "lead"), 2), { timeValueMinorPerDay: 4000, memberCostMinor: 1000, coordinationCostMinor: 500 });
    expect(g).toEqual({ benefitMinor: 2666, costMinor: 1500, justified: true });
    const g2 = gate(estimate(brief("engineer", "lead"), 2), { timeValueMinorPerDay: 4000, memberCostMinor: 1000, coordinationCostMinor: 2000 });
    expect(g2.justified).toBe(false);
  });

  it("a later start (ACCEPT_WITH_TIMING) moves the role's work and the ETA", () => {
    expect(schedule(brief("engineer", "lead"), { engineer: 10 }).makespanHours).toBe(36); // backend 10–30, integration 30–36
  });

  it("refuses cycles and unknown dependencies", () => {
    expect(() => schedule([{ key: "a", role: "lead", hours: 1, deps: ["b"] }, { key: "b", role: "lead", hours: 1, deps: ["a"] }])).toThrow(/cycle/);
    expect(() => schedule([{ key: "a", role: "lead", hours: 1, deps: ["zz"] }])).toThrow(/unknown task/);
  });

  it("expected contract cost: fixed + milestones + expected revenue share (capped)", () => {
    expect(expectedCost({ type: "FIXED", fixedMinor: 1000 }, 50_000)).toBe(1000);
    expect(expectedCost({ type: "HYBRID", fixedMinor: 500, revenueShareBp: 1000 }, 50_000)).toBe(5500);
    expect(expectedCost({ type: "HYBRID", fixedMinor: 500, revenueShareBp: 1000, revenueShareCapMinor: 2000 }, 50_000)).toBe(2500);
    expect(expectedCost({ type: "MILESTONE", milestones: [{ key: "m1", taskKey: "t", amountMinor: 200 }, { key: "m2", taskKey: "u", amountMinor: 300 }] }, 0)).toBe(500);
  });
});

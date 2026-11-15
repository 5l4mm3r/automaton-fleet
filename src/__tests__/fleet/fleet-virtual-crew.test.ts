/**
 * Virtual specialist crew (owner, 2026-10-16) — targeted and pure (no DOM, no WebGL):
 *   the role a real helper job wakes (only from its recorded purpose; no purpose / an unknown one → no desk, counted),
 *   the recorded state on the desk (finished / failed / ended without a result),
 *   desk counts, waking / linger / after-the-fact jobs, concurrent jobs on several desks, deterministic and stable desk
 *   assignment, stale and unavailable reads (nothing wakes, said honestly), the `helpers` contract parsing, the pulse
 *   wiring (an older gateway → unavailable, not re-asked every pulse), the simulation's honesty (jobs only from simulated
 *   commands, labelled), specialists are never agents, and the desks' placement in the built HQ (no furniture overlap,
 *   every room, spot and door still reachable).
 */
import { describe, it, expect } from "vitest";
import { createElement as h } from "../../../codex-dashboard/node_modules/react/index.js";
import { renderToStaticMarkup } from "../../../codex-dashboard/node_modules/react-dom/server.node.js";
import { crewOf, crewSummary, deskCount, deskLine, helperRole, HELPER_LINGER_MS, HELPER_ROLES, HELPER_STALE_MS, jobText, ROLE_DEPARTMENT, todayLine, toHelperRead,
  type HelperJob, type HelperPurpose, type HelperRead } from "../../../codex-dashboard/src/dashboard/command/helpers";
import { DAY_MS, DEPARTMENT, DEPARTMENTS } from "../../../codex-dashboard/src/dashboard/command/departments";
import { deriveAgents } from "../../../codex-dashboard/src/dashboard/command/agents";
import { emptyCommandView } from "../../../codex-dashboard/src/dashboard/command/view";
import { CREW_BAYS, crewFootprints, placeDesks, seatOf, shownBays } from "../../../codex-dashboard/src/dashboard/virtual/hq/crew-layout";
import { buildWorld, NAV_BOUNDS } from "../../../codex-dashboard/src/dashboard/virtual/hq/world-build";
import { findPath, navGrid, reachableFrom, walkable } from "../../../codex-dashboard/src/dashboard/virtual/hq/nav";
import { HUB_SOUTH, INTAKE, roomAt } from "../../../codex-dashboard/src/dashboard/virtual/hq/route";
import { CommandReader } from "../../../codex-dashboard/src/dashboard/api/command";
import { FleetApiError } from "../../../codex-dashboard/src/dashboard/api/errors";
import type { GatewayClient } from "../../../codex-dashboard/src/dashboard/api/client";
import { SimulationDeckAdapter } from "../../../codex-dashboard/src/dashboard/adapters/simulation-command";
import { AgentRail } from "../../../codex-dashboard/src/dashboard/virtual/AgentRail";
import type { Agent } from "../../../codex-dashboard/src/dashboard/model";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const agent = (id: string, o: Partial<Agent> = {}): Agent => ({ id, name: `Agent-${id}`, role: "Normal", mode: "NORMAL", status: "active", cash: 9_000, burn: 10, colour: "cyan", venture: "", events: [], createdAt: new Date(NOW - 3 * DAY_MS).toISOString(), ...o });
const models = (as: Agent[]) => deriveAgents(as, { ...emptyCommandView("live"), genesisMinor: 10_000 }, NOW);
const job = (id: string, o: Partial<HelperJob> = {}): HelperJob => ({ id, agentId: "A", kind: "routine", taskClass: "basic_summary", tier: "T1", purpose: "production", state: o.finishedAt ? "finished" : "running", startedAt: iso(5_000), finishedAt: null, knownAt: iso(5_000), outcome: null, ...o });
const read = (jobs: HelperJob[], o: Partial<HelperRead> = {}): HelperRead => ({ asOf: new Date(NOW).toISOString(), windowS: 600, jobs, today: { routine: 9, escalation: 1, review: 2, inspection: 2, fleetReview: 0, unrecorded: 0 }, receivedAt: NOW, ...o });

describe("which specialist a real helper job wakes", () => {
  it("the role comes ONLY from the recorded purpose", () => {
    const cases: Array<[HelperPurpose, string]> = [["research", "researcher"], ["marketing", "marketer"], ["production", "producer"], ["customer_support", "support"],
      ["quality_review", "reviewer"], ["evidence_check", "reviewer"], ["spend_review", "reviewer"], ["inspection", "reviewer"], ["decision", "advisor"]];
    for (const [p, role] of cases) expect(helperRole({ purpose: p }), p).toBe(role);
  });
  it("no recorded purpose (older agent runtime) or an unknown one wakes nobody — never guessed from the kind, class or room", () => {
    expect(helperRole({ purpose: null })).toBeNull();
    for (const p of ["telepathy", "toString", "constructor", "__proto__", ""]) expect(helperRole({ purpose: p as never }), p).toBeNull();
    const ms = models([agent("A", { name: "Agent-1", mode: "MARKETING" })]);
    const c = crewOf(read([job("a", { purpose: null, taskClass: "formatting" }), job("b", { kind: "escalation", purpose: null, taskClass: null }),
      job("c", { purpose: "astrology" as never, finishedAt: iso(2_000) })]), ms, NOW);
    expect(c.working).toBe(0); expect(c.unrecorded).toBe(3);
    expect(crewSummary(c)).toBe("Helpers: 0 working · 12 asleep · 14 helper jobs today · 3 helper jobs without a recorded purpose (agent on an older runtime)");
    expect(crewSummary(c, "command")).toContain("3 helper jobs without a recorded purpose (agent on an older runtime)");
    expect(crewSummary(c, "marketing")).not.toContain("recorded purpose");
    // Past the linger it is no longer counted.
    expect(crewOf(read([job("old", { purpose: null, finishedAt: iso(HELPER_LINGER_MS + 1_000) })]), ms, NOW).unrecorded).toBe(0);
    expect(crewSummary(crewOf(read([job("one", { purpose: null })]), ms, NOW))).toContain("· 1 helper job without a recorded purpose (agent on an older runtime)");
  });
  it("the today line counts the routine chores without a recorded purpose", () => {
    const t = { routine: 9, escalation: 1, review: 2, inspection: 2, fleetReview: 0, unrecorded: 0 };
    expect(todayLine(t)).toBe("Today, Fleet-wide: 9 routine chores · 1 critical questions · 2 reviews · 2 inspections · 0 spend reviews (14 in all).");
    expect(todayLine({ ...t, unrecorded: 4 })).toBe("Today, Fleet-wide: 9 routine chores (4 without a recorded purpose — agent on an older runtime) · 1 critical questions · 2 reviews · 2 inspections · 0 spend reviews (14 in all).");
  });
  it("every role has its desks in its own department", () => {
    expect(ROLE_DEPARTMENT).toEqual({ researcher: "library", marketer: "marketing", producer: "venture", support: "comms", reviewer: "command", advisor: "command" });
    for (const r of HELPER_ROLES) for (const b of CREW_BAYS[r]) expect(roomAt(seatOf(b))?.id, r).toBe(ROLE_DEPARTMENT[r]);
  });
  it("desk text says the recorded purpose in plain words with the agent's shown name", () => {
    expect(jobText({ purpose: "research", taskClass: "page_interpretation" }, "Agent-1")).toBe("Research chore (page interpretation) for Agent-1");
    expect(jobText({ purpose: "marketing", taskClass: "formatting" }, "Agent-1")).toBe("Marketing chore (formatting) for Agent-1");
    expect(jobText({ purpose: "production", taskClass: null }, "Agent-1")).toBe("Production chore for Agent-1");
    expect(jobText({ purpose: "customer_support", taskClass: "classification" }, "Agent-2")).toBe("Customer-support chore (classification) for Agent-2");
    expect(jobText({ purpose: "decision", taskClass: null }, "Agent-1")).toBe("Critical question for Agent-1");
    expect(jobText({ purpose: "quality_review", taskClass: null }, "Agent-2")).toBe("Reviewing a deliverable for Agent-2");
    expect(jobText({ purpose: "evidence_check", taskClass: "evidence_relevance" }, "Agent-1")).toBe("Checking cited evidence for Agent-1 (Fleet Control)");
    expect(jobText({ purpose: "spend_review", taskClass: null }, "Agent-1")).toBe("Spend review for Agent-1 (Fleet Control)");
    expect(jobText({ purpose: "inspection", taskClass: "artifact_inspection" }, "Agent-1")).toBe("Inspecting a deliverable for Agent-1 (automated check)");
  });
});

describe("the crew's desks: asleep by default, woken only by real jobs", () => {
  it("one desk per living agent per role, at least 2 and at most 4 (the dead do not count)", () => {
    expect([0, 1, 2, 3, 4, 9, 50].map(deskCount)).toEqual([2, 2, 2, 3, 4, 4, 4]);
    const c = crewOf(read([]), models([agent("A"), agent("B"), agent("C"), agent("D", { status: "dead" })]), NOW);
    expect(c.desks).toHaveLength(3 * HELPER_ROLES.length);
    expect(c.desks.every((d) => !d.job)).toBe(true); expect(c.working).toBe(0); expect(c.asleep).toBe(18);
  });

  it("a job in flight wakes one desk of its role, with what it does, for whom, and since when", () => {
    const ms = models([agent("A", { name: "Agent-1", mode: "MARKETING" })]);
    const c = crewOf(read([job("j1", { taskClass: "formatting", purpose: "marketing", startedAt: iso(42_000) })]), ms, NOW);
    const awake = c.desks.filter((d) => d.job);
    expect(awake).toHaveLength(1); expect(awake[0].role).toBe("marketer"); expect(awake[0].department).toBe("marketing");
    expect(awake[0].job).toMatchObject({ phase: "working", text: "Marketing chore (formatting) for Agent-1", agentName: "Agent-1", startedAt: NOW - 42_000 });
    expect(deskLine(awake[0], NOW)).toBe("Working · Marketing chore (formatting) for Agent-1 · 42 s");
    expect(crewSummary(c)).toBe("Helpers: 1 working · 11 asleep · 14 helper jobs today");
    expect(crewSummary(c, "marketing")).toBe("Helpers: 1 working · 1 asleep · 14 helper jobs today");
  });

  it("a finished job stays on its desk for the display linger, then the specialist sleeps again", () => {
    const ms = models([agent("A")]);
    const done = (ago: number) => crewOf(read([job("j1", { startedAt: iso(ago + 9_000), finishedAt: iso(ago) })]), ms, NOW).desks.find((d) => d.job)?.job ?? null;
    expect(done(5_000)).toMatchObject({ phase: "finished", until: NOW - 5_000 + HELPER_LINGER_MS });
    expect(deskLine(crewOf(read([job("j1", { startedAt: iso(14_000), finishedAt: iso(5_000) })]), ms, NOW).desks.find((d) => d.job)!, NOW)).toBe("Finished 5 s ago · Production chore (basic summary) for Agent-A · took 9 s");
    expect(done(HELPER_LINGER_MS + 1)).toBeNull();
    expect(HELPER_LINGER_MS).toBeGreaterThanOrEqual(20_000); expect(HELPER_LINGER_MS).toBeLessThanOrEqual(30_000);
  });

  it("the recorded state is said on the desk during the linger: failed, or ended without a result — never \"finished\"", () => {
    const ms = models([agent("A", { name: "Agent-1" })]);
    const desk = (o: Partial<HelperJob>) => crewOf(read([job("s1", { purpose: "research", taskClass: "extraction", startedAt: iso(14_000), finishedAt: iso(5_000), ...o })]), ms, NOW).desks.find((d) => d.job)!;
    const failed = desk({ state: "failed" });
    expect(failed.job).toMatchObject({ phase: "failed", until: NOW - 5_000 + HELPER_LINGER_MS });
    expect(deskLine(failed, NOW)).toBe("Failed 5 s ago · Research chore (extraction) for Agent-1 · took 9 s");
    const ended = desk({ state: "ended" });
    expect(ended.job!.phase).toBe("ended"); expect(deskLine(ended, NOW)).toBe("Ended without a result 5 s ago · Research chore (extraction) for Agent-1");
    expect(desk({ state: "finished" }).job!.phase).toBe("finished");
    // Over without a recorded end: over from when it became known (the linger from knownAt), not "working".
    const noEnd = crewOf(read([job("s2", { purpose: "research", state: "failed", finishedAt: null, knownAt: iso(3_000) })]), ms, NOW).desks.find((d) => d.job)!;
    expect(noEnd.job).toMatchObject({ phase: "failed", finishedAt: NOW - 3_000 });
    expect(crewOf(read([job("s3", { purpose: "research", state: "ended", finishedAt: null, knownAt: iso(HELPER_LINGER_MS + 1_000) })]), ms, NOW).working).toBe(0);
    // In flight: running with no end.
    expect(crewOf(read([job("s4", { purpose: "research", state: "running" })]), ms, NOW).desks.find((d) => d.job)!.job!.phase).toBe("working");
  });

  it("a review known only after the fact shows from knownAt for the linger, never before or after", () => {
    const ms = models([agent("A")]);
    const at = (knownAgo: number) => crewOf(read([job("r1", { kind: "review", purpose: "quality_review", state: "finished", taskClass: null, tier: null, startedAt: null, finishedAt: null, knownAt: iso(knownAgo) })]), ms, NOW);
    const d = at(3_000).desks.find((x) => x.job)!;
    expect(d.role).toBe("reviewer"); expect(d.job).toMatchObject({ phase: "finished", startedAt: null, text: "Reviewing a deliverable for Agent-A" });
    expect(at(HELPER_LINGER_MS + 1_000).working).toBe(0);
    // As the backend reports it: the model call (start, finish) ran minutes before the review was filed (knownAt).
    const filed = crewOf(read([job("r2", { kind: "review", purpose: "quality_review", taskClass: "deliverable_review", tier: "T2", startedAt: iso(9 * 60_000), finishedAt: iso(8 * 60_000), knownAt: iso(2_000), outcome: "pass" }),
      job("i2", { kind: "inspection", purpose: "inspection", taskClass: "artifact_inspection", tier: null, startedAt: iso(2_000), finishedAt: iso(2_000), knownAt: iso(2_000), outcome: "pass" })]), ms, NOW);
    expect(filed.desks.filter((x) => x.job).map((x) => [x.role, x.job!.phase, x.job!.until])).toEqual([["reviewer", "finished", NOW - 2_000 + HELPER_LINGER_MS], ["reviewer", "finished", NOW - 2_000 + HELPER_LINGER_MS]]);
  });

  it("concurrent jobs wake several specialists of that role (working together); beyond the desks they are counted, not dropped", () => {
    const ms = models([agent("A"), agent("B"), agent("C"), agent("D")]); // 4 desks per role
    const jobs = ["a", "b", "c"].map((id, i) => job(id, { taskClass: "research_triage", purpose: "research", startedAt: iso(30_000 - i * 1000) }));
    const c = crewOf(read(jobs), ms, NOW), awake = c.desks.filter((d) => d.job);
    expect(awake.map((d) => d.role)).toEqual(["researcher", "researcher", "researcher"]);
    expect(new Set(awake.map((d) => d.seat)).size).toBe(3);
    const six = Array.from({ length: 6 }, (_, i) => job(`x${i}`, { kind: "escalation", purpose: "decision", taskClass: null, startedAt: iso(10_000 + i) }));
    const c6 = crewOf(read(six), ms, NOW);
    expect(c6.desks.filter((d) => d.job && d.role === "advisor")).toHaveLength(4); expect(c6.overflow).toEqual({ advisor: 2 });
    expect(crewSummary(c6, "command")).toContain("(+2 more in progress)");
  });

  it("assignment is deterministic and stable: an older job keeps its desk when a new one arrives", () => {
    const ms = models([agent("A"), agent("B"), agent("C"), agent("D")]);
    const older = job("old-job", { taskClass: "extraction", purpose: "research", startedAt: iso(60_000) });
    const seatOld = (c: ReturnType<typeof crewOf>) => c.desks.find((d) => d.job?.id === "old-job")!.key;
    const first = crewOf(read([older]), ms, NOW);
    expect(crewOf(read([older]), ms, NOW)).toEqual(first);
    for (const id of ["n1", "n2", "zz", "000"]) expect(seatOld(crewOf(read([job(id, { taskClass: "extraction", purpose: "research", startedAt: iso(1_000) }), older]), ms, NOW))).toBe(seatOld(first));
  });

  it("nothing older than the window is shown, and a start in the future is not believed", () => {
    const ms = models([agent("A")]);
    expect(crewOf(read([job("w", { startedAt: iso(700_000), finishedAt: iso(650_000) })]), ms, NOW).working).toBe(0);
    expect(crewOf(read([job("f", { startedAt: new Date(NOW + 5 * 60_000).toISOString() })]), ms, NOW).working).toBe(0);
  });

  it("server times are read on this browser's clock (asOf vs receipt)", () => {
    const ms = models([agent("A")]);
    // The server's clock runs 10 minutes ahead: its "5 s ago" is still 5 s ago here.
    const ahead = 10 * 60_000, r = read([job("s", { startedAt: new Date(NOW + ahead - 5_000).toISOString(), knownAt: new Date(NOW + ahead - 5_000).toISOString() })], { asOf: new Date(NOW + ahead).toISOString() });
    expect(crewOf(r, ms, NOW).desks.find((d) => d.job)!.job!.startedAt).toBe(NOW - 5_000);
  });

  it("unavailable or stale helper activity wakes nobody, and says so", () => {
    const ms = models([agent("A")]), live = read([job("j")]);
    const none = crewOf(null, ms, NOW);
    expect(none.status).toBe("unavailable"); expect(none.working).toBe(0); expect(crewSummary(none)).toBe("Helpers: helper activity unavailable — every specialist shown asleep");
    const stale = crewOf(live, ms, NOW + HELPER_STALE_MS + 1);
    expect(stale.status).toBe("stale"); expect(stale.working).toBe(0); expect(crewSummary(stale)).toContain("not current");
  });

  it("the requesting agent is shown by its display name; an agent not in the reading is not invented", () => {
    const ms = models([agent("A", { name: "Agent-1" })]);
    const c = crewOf(read([job("j", { agentId: "01M3F50SH7PNX2E3GST13J52AS" })]), ms, NOW);
    expect(c.desks.find((d) => d.job)!.job!.text).toBe("Production chore (basic summary) for an agent (01M3F5…)");
  });
});

describe("the `helpers` contract", () => {
  it("parses the documented shape and drops malformed jobs (never repairs them)", () => {
    const r = toHelperRead({ asOf: "2026-10-16T12:00:00Z", windowS: 600, today: { routine: 3, escalation: "x", review: 1, inspection: 1, fleetReview: 2 }, jobs: [
      { id: "1", agentId: "A", kind: "routine", taskClass: "extraction", tier: "T1", startedAt: "2026-10-16T11:59:50Z", finishedAt: null, knownAt: "2026-10-16T11:59:50Z", outcome: null },
      { id: "2", agentId: "A", kind: "magic", knownAt: "2026-10-16T11:59:50Z" }, { id: "", agentId: "A", kind: "routine", knownAt: "2026-10-16T11:59:50Z" },
      { id: "3", agentId: "A", kind: "review", taskClass: null, tier: "T9", startedAt: "garbage", finishedAt: null, knownAt: "2026-10-16T11:59:58Z", outcome: "pass" }, null, "x",
    ] }, NOW)!;
    expect(r.jobs.map((j) => j.id)).toEqual(["1", "3"]); expect(r.jobs[1]).toMatchObject({ tier: null, startedAt: null, outcome: "pass" });
    // An older gateway (no purpose / state / unrecorded): purpose null, state from finishedAt, unrecorded 0.
    expect(r.jobs.map((j) => [j.purpose, j.state])).toEqual([[null, "running"], [null, "running"]]);
    expect(r.today).toEqual({ routine: 3, escalation: 0, review: 1, inspection: 1, fleetReview: 2, unrecorded: 0 }); expect(r.receivedAt).toBe(NOW);
    for (const bad of [null, "x", {}, { asOf: "nope", jobs: [] }, { asOf: "2026-10-16T12:00:00Z", jobs: "x" }]) expect(toHelperRead(bad, NOW)).toBeNull();
  });

  it("parses the recorded purpose and state; an unknown purpose is not recorded, an unknown state is derived", () => {
    const k = "2026-10-16T11:59:50Z", base = { agentId: "A", kind: "routine", taskClass: "extraction", tier: "T1", startedAt: k, knownAt: k, outcome: null };
    const r = toHelperRead({ asOf: "2026-10-16T12:00:00Z", windowS: 600, today: { routine: 5, escalation: 0, review: 0, inspection: 0, fleetReview: 0, unrecorded: 2 }, jobs: [
      { ...base, id: "1", purpose: "research", state: "running", finishedAt: null },
      { ...base, id: "2", purpose: "customer_support", state: "failed", finishedAt: "2026-10-16T11:59:55Z" },
      { ...base, id: "3", purpose: "spend_review", kind: "fleet_review", state: "ended", finishedAt: "2026-10-16T11:59:55Z" },
      { ...base, id: "4", purpose: "astrology", state: "exploded", finishedAt: "2026-10-16T11:59:55Z" },
      { ...base, id: "5", purpose: 7, state: null, finishedAt: null },
      { ...base, id: "6", purpose: "decision", kind: "escalation", finishedAt: null },
    ] }, NOW)!;
    expect(r.jobs.map((j) => [j.id, j.purpose, j.state])).toEqual([["1", "research", "running"], ["2", "customer_support", "failed"], ["3", "spend_review", "ended"],
      ["4", null, "finished"], ["5", null, "running"], ["6", "decision", "running"]]);
    expect(r.today.unrecorded).toBe(2);
    expect(toHelperRead({ asOf: k, jobs: [], today: { unrecorded: -3 } }, NOW)!.today.unrecorded).toBe(0);
  });

  it("the pulse reads `helpers` alongside agents and events; an older gateway (FLEET_UNKNOWN_OP) → unavailable, not asked every pulse", async () => {
    const calls: string[] = [];
    let supported = true;
    const c = { read: async (op: string) => {
      calls.push(op);
      if (op === "agents") return [];
      if (op === "events") return [];
      if (op === "helpers") { if (!supported) throw new FleetApiError("FLEET_UNKNOWN_OP"); return { asOf: new Date().toISOString(), windowS: 600, jobs: [], today: { routine: 1, escalation: 0, review: 0, inspection: 0, fleetReview: 0 } }; }
      throw new FleetApiError("FLEET_UNKNOWN_OP");
    } } as unknown as GatewayClient;
    const reader = new CommandReader(c);
    const p = await reader.pulse();
    expect(calls.sort()).toEqual(["agents", "events", "helpers"]); expect(p.helpers?.today.routine).toBe(1);
    supported = false; calls.length = 0;
    expect((await reader.pulse()).helpers).toBeNull();
    calls.length = 0;
    const again = await reader.pulse();
    expect(again.helpers).toBeNull(); expect(calls).not.toContain("helpers"); // not re-asked within the retry interval
  });
});

describe("the simulation: helper jobs only from the operator's simulated commands, labelled", () => {
  it("no jobs until a command runs; a mission wakes a routine chore for that fictional agent", async () => {
    const sim = new SimulationDeckAdapter();
    await sim.snapshot();
    const before = (await sim.pulse()).helpers!;
    expect(before.simulated).toBe(true); expect(before.jobs).toEqual([]);
    await sim.execute({ id: "c1", op: "mission", args: { agentId: "A-001", role: "Research", brief: "Fictional brief" } });
    const after = (await sim.pulse()).helpers!;
    expect(after.jobs.length).toBeGreaterThan(0);
    expect(after.jobs.every((j) => j.agentId === "A-001" && j.kind === "routine" && j.purpose === "research")).toBe(true);
    expect(after.jobs[0].finishedAt).toBeNull(); expect(after.jobs[0].state).toBe("running"); // in flight for a few seconds
    expect(after.today.routine).toBe(after.jobs.length); expect(after.today.unrecorded).toBe(0);
    await sim.execute({ id: "c2", op: "mission", args: { agentId: "A-002", role: "Marketing", brief: "Fictional brief" } });
    expect((await sim.pulse()).helpers!.jobs.filter((j) => j.agentId === "A-002").map((j) => j.purpose)).toEqual(["marketing"]);
    const missionId = (await sim.snapshot()).missions.find((m) => m.agentId === "A-001" && m.status === "active")!.id;
    await sim.execute({ id: "c3", op: "mission_end", args: { agentId: "A-001", missionId, outcome: "Fictional outcome" } });
    const ended = (await sim.pulse()).helpers!.jobs.filter((j) => j.kind === "review" || j.kind === "inspection");
    expect(ended.map((j) => [j.kind, j.purpose, j.state]).sort()).toEqual([["inspection", "inspection", "finished"], ["review", "quality_review", "finished"]]);
    await sim.execute({ id: "c4", op: "fund", args: { agentId: "A-002", amount: "5", reason: "Fictional top-up" } });
    expect((await sim.pulse()).helpers!.jobs.filter((j) => j.kind === "fleet_review").map((j) => [j.purpose, j.state])).toEqual([["spend_review", "running"]]);
    expect((await sim.command()).helpers?.simulated).toBe(true);
  });
});

describe("specialists are not agents", () => {
  it("never in the living-agent roster, never changing the agents' figures", () => {
    const as = [agent("A", { name: "Agent-1" }), agent("B", { name: "Agent-2" })], ms = models(as);
    const c = crewOf(read([job("j", { kind: "escalation", purpose: "decision", taskClass: null })]), ms, NOW);
    const html = renderToStaticMarkup(h(AgentRail, { models: ms, all: as, selected: null, now: NOW, onAgent: () => {}, onCommand: () => {} }));
    expect([...html.matchAll(/data-agent="([^"]+)"/g)].map((m) => m[1])).toEqual(["A", "B"]);
    expect(html).not.toMatch(/advisor|specialist|reviewer/i);
    expect(c.desks.some((d) => as.some((a) => a.id === d.key))).toBe(false);
    expect(ms).toEqual(models(as)); // deriving the crew changed nothing
  });
});

describe("the crew's desks in the built HQ", () => {
  const plan = buildWorld();
  const overlap = (a: { x0: number; z0: number; x1: number; z1: number }, b: { x0: number; z0: number; x1: number; z1: number }) => a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;

  it("every desk stands on free floor of its room: no furniture, work spot, intake or doorway in the way", () => {
    for (const r of HELPER_ROLES) for (const b of CREW_BAYS[r]) {
      const dep = DEPARTMENT[ROLE_DEPARTMENT[r]];
      for (const f of crewFootprints([b])) {
        expect(plan.footprints.some((o) => overlap(f, o)), `${r} ${b.x},${b.z}`).toBe(false);
        expect(f.x0 > dep.x - dep.w / 2 && f.x1 < dep.x + dep.w / 2 && f.z0 > dep.z - dep.d / 2 && f.z1 < dep.z + dep.d / 2).toBe(true);
      }
      for (const s of plan.spots[dep.id]) expect(Math.hypot(s.x - b.x, s.z - b.z), `${r} vs spot`).toBeGreaterThanOrEqual(1.3);
      expect(Math.hypot(INTAKE[dep.id].x - b.x, INTAKE[dep.id].z - b.z)).toBeGreaterThanOrEqual(1.6);
    }
    // No two desks overlap one another.
    const all = HELPER_ROLES.flatMap((r) => crewFootprints(CREW_BAYS[r]));
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(overlap(all[i], all[j])).toBe(false);
  });

  it("with every desk present, every room's spots, intake and doors stay reachable from the corridors", () => {
    const nav = navGrid([...plan.footprints, ...crewFootprints(shownBays(4).map((b) => b.bay))], NAV_BOUNDS), reach = reachableFrom(nav, HUB_SOUTH);
    const before = reachableFrom(plan.nav, HUB_SOUTH);
    for (const d of DEPARTMENTS) {
      const pts = [INTAKE[d.id], { x: d.x - d.w / 2 + 0.6, z: d.z }, { x: d.x + d.w / 2 - 0.6, z: d.z }, { x: d.x, z: d.z + d.d / 2 - 0.6 }];
      for (const p of pts) if (walkable(plan.nav, p) && before(p)) expect(reach(p), `${d.id} ${p.x},${p.z}`).toBe(true);
      for (const s of plan.spots[d.id]) expect(findPath(nav, { x: d.x, z: d.z + d.d / 2 + 1.5 }, s), `${d.id} spot ${s.x},${s.z}`).not.toBeNull();
    }
  });

  it("placed desks carry their real job; seats are stable per role and seat number", () => {
    const ms = models([agent("A")]), c = crewOf(read([job("j", { kind: "escalation", purpose: "decision", taskClass: null })]), ms, NOW);
    const placed = placeDesks(c.desks);
    expect(placed).toHaveLength(12);
    const lit = placed.filter((p) => p.desk.job);
    expect(lit).toHaveLength(1); expect(lit[0].desk.role).toBe("advisor"); expect(lit[0].seat).toEqual(seatOf(CREW_BAYS.advisor[lit[0].desk.seat - 1]));
  });
});

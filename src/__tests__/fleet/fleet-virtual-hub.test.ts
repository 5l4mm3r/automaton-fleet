/**
 * Virtual HQ — the central Fleet Command redesign (owner-approved 2026-10-13), targeted and pure (no DOM, no WebGL):
 *   hub connectivity (every room one corridor from Fleet Command; every route between rooms passes its core), the ceiling
 *   pipes (visible only while information travels), Quarters (a bed for every living agent), the owner's pause vs a
 *   reported hibernation, the side list (order and focus), levels (display only), the Hall of Survivors, idle
 *   wandering (cosmetic, inside the room), the live presence (v75: owner pause and its start, the agent's own rest
 *   report with freshness — unknown when stale or missing —, death time, mission start, the activity run's start), the
 *   sleeper camera (never through a bunk frame) and agent labels kept clear of the room plaques. The art is unchanged.
 */
import { describe, it, expect } from "vitest";
import { createElement as h, isValidElement, type ReactElement, type ReactNode } from "../../../codex-dashboard/node_modules/react/index.js";
import { renderToStaticMarkup } from "../../../codex-dashboard/node_modules/react-dom/server.node.js";
import { ACTIVITY_WINDOW_MS, activityByAgent, DAY_MS, DEPARTMENT, DEPARTMENTS, fleetLevel, levelOf, placeAgent, span } from "../../../codex-dashboard/src/dashboard/command/departments";
import { HIBERNATION_REPORT_FRESH_MS, hibernationText, pauseText, restOf } from "../../../codex-dashboard/src/dashboard/command/rest";
import { blockedByFurniture, bunkOccluders, BUNK_H, frameSleeper } from "../../../codex-dashboard/src/dashboard/virtual/hq/framing";
import { layoutLabels } from "../../../codex-dashboard/src/dashboard/virtual/labelLayout";
import { deriveAgents, mergePulseAgents } from "../../../codex-dashboard/src/dashboard/command/agents";
import { hallOfSurvivors, railEntry, railOrder } from "../../../codex-dashboard/src/dashboard/command/survival";
import { emptyCommandView } from "../../../codex-dashboard/src/dashboard/command/view";
import { CROSS_Z, HUB, INTAKE, PIPE_END_Y, PIPE_Y, pipeHeight, roomAt, routeThrough, SPINE_X, toHub } from "../../../codex-dashboard/src/dashboard/virtual/hq/route";
import { CATEGORY_COLOUR, PHASE, pipesOf, totalTime, transportFrame, type Transport } from "../../../codex-dashboard/src/dashboard/virtual/hq/transport";
import { agentTargetsWithStations, BED_LENGTH, BED_TOP, BED_WIDTH, bedIndex, bedPoint, BUNKS, bunksFor } from "../../../codex-dashboard/src/dashboard/virtual/world";
import { chooseActivity, isWorking, type ActivityContext } from "../../../codex-dashboard/src/dashboard/virtual/hq/choreo";
import { mayWander, WANDER_DWELL, WANDER_MARGIN, WANDER_SLOT_MS, wanderPoint } from "../../../codex-dashboard/src/dashboard/virtual/hq/wander";
import { HQ_PROFILE } from "../../../codex-dashboard/src/dashboard/virtual/hq/quality";
import { buildWorld, NAV_BOUNDS } from "../../../codex-dashboard/src/dashboard/virtual/hq/world-build";
import { findPath, navGrid } from "../../../codex-dashboard/src/dashboard/virtual/hq/nav";
import { hqBoardsFrom } from "../../../codex-dashboard/src/dashboard/virtual/hq/data";
import { hibernationOf, toAgent } from "../../../codex-dashboard/src/dashboard/live/mapping";
import { AgentRail } from "../../../codex-dashboard/src/dashboard/virtual/AgentRail";
import type { Agent, Fleet } from "../../../codex-dashboard/src/dashboard/model";
import type { AgentRow } from "../../../codex-dashboard/src/dashboard/api/types";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const ago = (days: number) => new Date(NOW - days * DAY_MS).toISOString();
const hAgo = (hours: number) => ago(hours / 24);
const PAUSED: Partial<Agent> = { paused: true };
const HIB: Partial<Agent> = { hibernation: { state: "hibernating", reportedAt: hAgo(1), since: hAgo(5) } };
const agent = (id: string, o: Partial<Agent> = {}): Agent => ({ id, name: `Agent ${id}`, role: "Normal", mode: "NORMAL", status: "active", cash: 9_000, burn: 10, colour: "cyan", venture: "", events: [], ...o });
const view = () => ({ ...emptyCommandView("live"), genesisMinor: 10_000 });
const inRoom = (p: { x: number; z: number }, d: { x: number; z: number; w: number; d: number }, m = 0) => Math.abs(p.x - d.x) <= d.w / 2 - m + 1e-9 && Math.abs(p.z - d.z) <= d.d / 2 - m + 1e-9;

describe("layout: Fleet Command is the hub", () => {
  it("is the centre of the approved arrangement, with Quarters added", () => {
    const at = (id: string) => DEPARTMENT[id as keyof typeof DEPARTMENT];
    const rows = [["opportunity", "library", "marketing"], ["treasury", "command", "venture"], ["identity", "floor", "comms"], ["quarters", "estate", "security"]];
    for (const row of rows) { expect(at(row[0]).x).toBeLessThan(at(row[1]).x); expect(at(row[1]).x).toBeLessThan(at(row[2]).x); expect(at(row[1]).x).toBe(0); }
    for (let r = 1; r < rows.length; r++) expect(at(rows[r][1]).z).toBeGreaterThan(at(rows[r - 1][1]).z);
    expect(DEPARTMENTS).toHaveLength(12);
    // Rooms never overlap.
    for (const a of DEPARTMENTS) for (const b of DEPARTMENTS) if (a.id < b.id) {
      const sep = Math.abs(a.x - b.x) >= (a.w + b.w) / 2 || Math.abs(a.z - b.z) >= (a.d + b.d) / 2;
      expect(sep, `${a.id} / ${b.id}`).toBe(true);
    }
  });

  it("every room reaches the hub's core along corridors only (its own corridor), axis-aligned, never through another room", () => {
    for (const d of DEPARTMENTS) {
      const path = toHub(INTAKE[d.id]);
      expect(path[0]).toEqual(INTAKE[d.id]); expect(path.at(-1)).toEqual(HUB);
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1], b = path[i];
        expect(Math.abs(a.x - b.x) < 1e-9 || Math.abs(a.z - b.z) < 1e-9, `${d.id}: ${JSON.stringify(a)}→${JSON.stringify(b)}`).toBe(true);
        for (let k = 0; k <= 20; k++) {
          const q = { x: a.x + ((b.x - a.x) * k) / 20, z: a.z + ((b.z - a.z) * k) / 20 }, r = roomAt(q)?.id;
          expect(r === undefined || r === d.id || r === "command", `${d.id} passes through ${r} at ${q.x},${q.z}`).toBe(true);
          // Outside rooms, the pipe follows a corridor line — or the short stub from a doorway (this room's front opening,
          // or one of the hub's) to the corridor in front of it.
          const onLine = CROSS_Z.some((z) => Math.abs(q.z - z) < 1e-9) || SPINE_X.some((x) => Math.abs(q.x - x) < 1e-9) || q.x >= 31;
          const stub = (Math.abs(q.x - d.x) < 1e-9 || Math.abs(q.x - HUB.x) < 1e-9) && CROSS_Z.some((z) => Math.abs(q.z - z) <= 2 + 1e-9);
          if (r === undefined) expect(onLine || stub, `${d.id} off-corridor at ${q.x},${q.z}`).toBe(true);
        }
      }
    }
  });

  it("every route between two different rooms passes the hub's core; inside one room it goes straight across", () => {
    for (const a of DEPARTMENTS) for (const b of DEPARTMENTS) {
      if (a.id === b.id) { expect(routeThrough([INTAKE[a.id], { x: a.x + 1, z: a.z }])).toHaveLength(2); continue; }
      const r = routeThrough([INTAKE[a.id], INTAKE[b.id]]);
      expect(r, `${a.id}→${b.id}`).toContainEqual(HUB);
      expect(r[0]).toEqual(INTAKE[a.id]); expect(r.at(-1)).toEqual(INTAKE[b.id]);
    }
  });

  it("people can walk from every room to the hub (doorways on all sides of Fleet Command)", () => {
    const w = buildWorld(), nav = navGrid(w.footprints, NAV_BOUNDS), hub = w.spots.command[0];
    for (const d of DEPARTMENTS) for (const s of w.spots[d.id].slice(0, 2)) expect(findPath(nav, s, hub), d.id).not.toBeNull();
    expect(w.core).toMatchObject({ x: HUB.x, z: HUB.z }); // the live core is the centre of the hub
  });
});

describe("ceiling pipes: visible only while information travels", () => {
  const T = DEPARTMENT.treasury, L = DEPARTMENT.library;
  const t: Transport = { id: "p1", route: routeThrough([INTAKE.treasury, INTAKE.library]), eventAt: 0, start: 0, travel: 4000, category: "information", colour: CATEGORY_COLOUR.information,
    priority: 5, importance: "low", label: "KNOWLEDGE RECORDED", agentId: null, counterpartId: null, sourceAgentId: null };
  it("no transport, no pipe; lit up to the orb while it travels; fading as it settles; gone when done", () => {
    expect(pipesOf(transportFrame([], 1000, "full"))).toEqual([]);
    const travel = PHASE.activate + PHASE.launch;
    const mid = pipesOf(transportFrame([t], travel + 2000, "full"));
    expect(mid).toHaveLength(1); expect(mid[0].lit).toBeCloseTo(0.5, 2); expect(mid[0].opacity).toBe(1);
    const settleStart = travel + t.travel + PHASE.arrive + PHASE.respond;
    const early = pipesOf(transportFrame([t], settleStart + 10, "full"))[0], late = pipesOf(transportFrame([t], settleStart + PHASE.settle - 10, "full"))[0];
    expect(late.opacity).toBeLessThan(early.opacity); expect(late.opacity).toBeLessThan(0.02);
    expect(pipesOf(transportFrame([t], totalTime(t) + 1, "full"))).toEqual([]);
    expect(pipesOf(transportFrame([t], travel + 2000, "off"))).toEqual([]); // Data flow off: no pipe (the destination still acknowledges)
    expect(T && L).toBeTruthy();
  });
  it("the pipe runs under the ceiling and drops to its ends", () => {
    const len = 20;
    expect(pipeHeight(0, len)).toBeCloseTo(PIPE_END_Y); expect(pipeHeight(len, len)).toBeCloseTo(PIPE_END_Y); expect(pipeHeight(len / 2, len)).toBeCloseTo(PIPE_Y);
    expect(PIPE_Y).toBeGreaterThan(3.6); // above the 3.6 m walls: it never passes through one
  });
});

describe("Quarters: a bed for every living agent; the owner's pause vs a reported hibernation", () => {
  it("bed count follows the living agents (the dead have none); beds are distinct and inside Quarters", () => {
    const models = deriveAgents([agent("C"), agent("A"), agent("B", { status: "dead" }), agent("D", { status: "held" })], view(), NOW);
    expect([...bedIndex(models)]).toEqual([["A", 0], ["C", 1], ["D", 2]]);
    for (const n of [0, 1, 27, 28, 50]) expect(bunksFor(n)).toEqual({ frames: Math.min(BUNKS, n), uppers: Math.max(0, n - BUNKS) });
    const Q = DEPARTMENT.quarters, beds = Array.from({ length: 50 }, (_, i) => bedPoint(i));
    for (const b of beds) { expect(inRoom({ x: b.x - BED_WIDTH / 2, z: b.z }, Q, 0.3)).toBe(true); expect(inRoom({ x: b.x + BED_WIDTH / 2, z: b.z + BED_LENGTH }, Q, 0.3)).toBe(true); }
    expect(new Set(beds.map((b) => `${b.x},${b.z},${b.level}`)).size).toBe(50);
    expect(beds.filter((b) => b.level === 1)).toHaveLength(50 - BUNKS);
  });

  it("placement: the owner's pause and a hibernation both sleep in Quarters, labelled differently; death and a hold outrank sleep", () => {
    expect(placeAgent({ id: "A", status: "active", sleep: "owner_pause" }, undefined)).toMatchObject({ department: "quarters", activity: "PAUSED BY OWNER", basis: "sleep" });
    expect(placeAgent({ id: "A", status: "active", sleep: "hibernating", mode: "MARKETING" }, undefined)).toMatchObject({ department: "quarters", activity: "HIBERNATING", basis: "sleep" });
    expect(placeAgent({ id: "A", status: "dead", sleep: "owner_pause" }, undefined).department).toBe("estate");
    expect(placeAgent({ id: "A", status: "held", sleep: "owner_pause" }, undefined)).toMatchObject({ department: "floor", activity: "HELD" });
    expect(placeAgent({ id: "A", status: "active", sleep: null, mode: "MARKETING" }, undefined).department).toBe("marketing");
  });

  it("the reading decides — the owner's pause wins over a reported hibernation; absent fields are never inferred", () => {
    const row = { agentId: "01X", name: "founder-1", status: "active", createdAt: "2026-09-26T15:23:26Z", cashMinor: 8641, valueMinor: 8641, held: false, mode: "NORMAL" } as AgentRow;
    expect(toAgent(row)).toMatchObject({ paused: null, pausedSince: null, hibernation: null, missionSince: null, createdAt: "2026-09-26T15:23:26Z", diedAt: null });
    expect(restOf(toAgent(row), NOW)).toEqual({ sleep: null, since: null, hibernation: "unknown", reportedAt: null });
    const paused = toAgent({ ...row, paused: true, pausedSince: "2026-10-10T12:37:00Z" });
    expect(restOf(paused, NOW)).toMatchObject({ sleep: "owner_pause", since: Date.parse("2026-10-10T12:37:00Z"), hibernation: "unknown" });
    // A pause start is read only with the pause itself.
    expect(toAgent({ ...row, paused: false, pausedSince: "2026-10-10T12:37:00Z" })).toMatchObject({ paused: false, pausedSince: null });
    expect(toAgent({ ...row, status: "dead", deathTime: "2026-10-01T00:00:00Z" })).toMatchObject({ status: "dead", diedAt: "2026-10-01T00:00:00Z" });
    expect(toAgent({ ...row, modeSince: "2026-10-12T00:00:00Z" })).toMatchObject({ missionSince: "2026-10-12T00:00:00Z" });
    expect(toAgent({ ...row, held: true, heldSince: "2026-10-11T00:00:00Z" })).toMatchObject({ status: "held", heldSince: "2026-10-11T00:00:00Z" });
    expect(toAgent({ ...row, held: false, heldSince: "2026-10-11T00:00:00Z" })).toMatchObject({ heldSince: null });
    // Malformed rest reports are no report.
    expect(hibernationOf({ state: "asleep", reportedAt: "2026-10-13T00:00:00Z" } as never)).toBeNull();
    expect(hibernationOf({ state: "hibernating", reportedAt: "nope" })).toBeNull();
    expect(hibernationOf({ state: "awake", reportedAt: "2026-10-13T00:00:00Z", since: "2026-10-12T00:00:00Z" })).toEqual({ state: "awake", reportedAt: "2026-10-13T00:00:00Z", since: null });
    // A pulse carries the presence (and keeps the creation time).
    expect(mergePulseAgents([agent("A", { createdAt: ago(3) })], [agent("A", { paused: true, pausedSince: hAgo(2) })])[0]).toMatchObject({ paused: true, pausedSince: hAgo(2), createdAt: ago(3) });
  });

  it("hibernation is the agent's own FRESH report: stale or missing reads unknown; inactivity and the owner's pause never make one", () => {
    const rep = (state: "hibernating" | "awake", hours: number) => ({ hibernation: { state, reportedAt: hAgo(hours), since: state === "hibernating" ? hAgo(hours + 4) : null } });
    expect(restOf(rep("hibernating", 2), NOW)).toEqual({ sleep: "hibernating", since: Date.parse(hAgo(6)), hibernation: "hibernating", reportedAt: Date.parse(hAgo(2)) });
    expect(restOf(rep("awake", 2), NOW)).toMatchObject({ sleep: null, hibernation: "awake" });
    // Older than the freshness window (a running agent reports every turn; a hibernating one at least daily): unknown.
    const stale = restOf(rep("hibernating", HIBERNATION_REPORT_FRESH_MS / 3_600_000 + 0.1), NOW);
    expect(stale).toMatchObject({ sleep: null, hibernation: "unknown" });
    expect(hibernationText(stale, NOW)).toBe("unknown · last report 1d 2h ago");
    expect(hibernationText(restOf({}, NOW), NOW)).toBe("unknown · never reported");
    expect(hibernationText(restOf(rep("hibernating", 3), NOW), NOW)).toBe("hibernating · reported 3h 0m ago");
    // The owner's pause outranks a fresh hibernation, which stays visible as the agent's own report.
    const both = restOf({ paused: true, pausedSince: hAgo(30), ...rep("hibernating", 1) }, NOW);
    expect(both).toMatchObject({ sleep: "owner_pause", since: Date.parse(hAgo(30)), hibernation: "hibernating" });
    expect(pauseText({ paused: true }, both, NOW)).toBe("paused · for 1d 6h");
    expect(pauseText({ paused: true }, restOf({ paused: true }, NOW), NOW)).toBe("paused · for —");
    expect(pauseText({}, restOf({}, NOW), NOW)).toBe("—");
    // Paused for days with no report: asleep for the pause, hibernation unknown — never "hibernating".
    const quiet = deriveAgents([agent("A", { paused: true, pausedSince: ago(4) })], view(), NOW)[0];
    expect(quiet.rest).toMatchObject({ sleep: "owner_pause", hibernation: "unknown" });
    // No events for days, not paused, nothing reported: awake on the Floor, hibernation unknown.
    const idle = deriveAgents([agent("A")], view(), NOW)[0];
    expect(idle.placement).toMatchObject({ department: "floor", basis: "default", since: null }); expect(idle.rest.hibernation).toBe("unknown");
  });

  it("time on the activity comes from its authoritative transition: pause start, hibernation start, mission start, the event run's first event", () => {
    const ev = (agentId: string, type: string, hours: number) => ({ key: `${agentId}${type}${hours}`, type, agentId, at: hAgo(hours), detail: {} });
    const v = { ...view(), events: [ev("E", "venture_state", 1), ev("E", "venture_state", 3), ev("E", "venture_state", 5), ev("E", "knowledge_recorded", 6),
      ev("G", "venture_state", 1), ev("G", "venture_state", 1 + ACTIVITY_WINDOW_MS / 3_600_000 + 1)] } as never;
    const ms = deriveAgents([agent("P", { paused: true, pausedSince: hAgo(30) }), agent("H", HIB), agent("M", { mode: "MARKETING", missionSince: hAgo(50) }), agent("E"), agent("G")], v, NOW);
    const on = (id: string) => ms.find((m) => m.agent.id === id)!.placement.since;
    expect(deriveAgents([agent("Q", { status: "held", heldSince: hAgo(7) })], view(), NOW)[0].placement).toMatchObject({ activity: "HELD", since: Date.parse(hAgo(7)) });
    expect(on("P")).toBe(Date.parse(hAgo(30))); expect(on("H")).toBe(Date.parse(hAgo(5))); expect(on("M")).toBe(Date.parse(hAgo(50)));
    expect(on("E")).toBe(Date.parse(hAgo(5)));   // three venture events in a row; the Library event before them ends the run
    expect(on("G")).toBe(Date.parse(hAgo(1)));   // a gap longer than the window: back on the Floor in between
    expect(activityByAgent([ev("Z", "unmapped_thing", 1), ev("Z", "venture_state", 2)]).get("Z")!.runStart).toBe(Date.parse(hAgo(1)));
  });

  it("sleepers head for their own bed and lie on it; sleep is never work, never a stroll", () => {
    const models = deriveAgents([agent("A", PAUSED), agent("B", HIB), agent("C")], view(), NOW);
    const t = agentTargetsWithStations(models, new Map(), NOW, false), beds = bedIndex(models);
    expect(t.get("A")).toMatchObject({ ...{ x: bedPoint(beds.get("A")!).x, z: bedPoint(beds.get("A")!).z }, department: "quarters" });
    expect(t.get("B")!.department).toBe("quarters");
    const base: ActivityContext = { status: "active", basis: "sleep", department: "quarters", moving: false, fast: false, rising: false, atStation: false, atSpot: false, spotPose: null, meeting: false, team: false, seed: 1, t: 0 };
    expect(chooseActivity({ ...base, atBed: true })).toBe("sleep");
    expect(chooseActivity({ ...base, atBed: false })).toBe("waiting");
    expect(chooseActivity({ ...base, moving: true })).toBe("walk");
    expect(isWorking("active", "sleep")).toBe(false);
    expect(mayWander("active", "sleep", false)).toBe(false);
  });

  it("Quarters' boards show who sleeps and why (and nothing else)", () => {
    const models = deriveAgents([agent("A", { name: "Vega", ...PAUSED }), agent("B", { name: "Lyra", ...HIB }), agent("C")], view(), NOW);
    const fleet = { agents: models.map((m) => m.agent), missions: [], notices: [], estates: [], live: null } as unknown as Fleet;
    expect(hqBoardsFrom(fleet, view(), models)["quarters:board"]!.rows).toEqual([["Vega", "PAUSED BY OWNER", "warn"], ["Lyra", "HIBERNATING", "muted"]]);
  });
});

describe("levels (display only) and the Hall of Survivors", () => {
  it("Lv = whole days alive + 1; unknown or future creation → null; Fleet Command counts from the first agent", () => {
    expect(levelOf(ago(0), NOW)).toBe(1); expect(levelOf(ago(0.99), NOW)).toBe(1); expect(levelOf(ago(1), NOW)).toBe(2); expect(levelOf(ago(38.4), NOW)).toBe(39);
    expect(levelOf(null, NOW)).toBeNull(); expect(levelOf("not a date", NOW)).toBeNull(); expect(levelOf(ago(-1), NOW)).toBeNull();
    expect(fleetLevel([{ createdAt: ago(3) }, { createdAt: ago(17.5) }, { createdAt: null }], NOW)).toBe(18);
    expect(fleetLevel([], NOW)).toBeNull();
    expect(span(null)).toBe("—"); expect(span(42 * 60_000)).toBe("42m"); expect(span(5 * 3_600_000 + 12 * 60_000)).toBe("5h 12m"); expect(span(3 * DAY_MS + 4 * 3_600_000)).toBe("3d 4h");
  });

  it("levels touch nothing economic: the derivation reads only times", () => {
    const fs = require("fs") as typeof import("fs"), path = require("path") as typeof import("path");
    const src = fs.readFileSync(path.resolve(__dirname, "../../../codex-dashboard/src/dashboard/command/survival.ts"), "utf8");
    expect([...src.matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1]).sort()).toEqual(["../model", "./agents", "./departments"]);
    expect(src).not.toMatch(/cash|wallet|capital|permission/i);
  });

  it("the Hall of Survivors lists every dead agent with its lifespan (longest first); an unknown time reads —, never guessed", () => {
    const hall = hallOfSurvivors([agent("A", { status: "dead", createdAt: ago(60), diedAt: ago(25) }), agent("B", { status: "dead", createdAt: ago(10), diedAt: ago(2) }),
      agent("C", { status: "dead" }), agent("D", { createdAt: ago(5) })]);
    expect(hall.map((s) => [s.id, s.lifespanMs === null ? null : Math.round(s.lifespanMs / DAY_MS), s.level])).toEqual([["A", 35, 36], ["B", 8, 9], ["C", null, null]]);
    const models = deriveAgents([agent("A", { name: "Echo", status: "dead", createdAt: ago(60), diedAt: ago(25) }), agent("C", { name: "Ghost", status: "dead" })], view(), NOW);
    const fleet = { agents: models.map((m) => m.agent), missions: [], notices: [], estates: [], live: null } as unknown as Fleet;
    expect(hqBoardsFrom(fleet, view(), models)["estate:hall"]!.rows).toEqual([["Echo", "35d 0h · Lv 36", "muted"], ["Ghost", "—", "muted"]]);
    expect(buildWorld().screens.some((s) => s.id === "estate:hall" && s.board === "estate:hall")).toBe(true);
  });
});

describe("the side list: living agents, longest survivors first; selecting one focuses it", () => {
  const models = () => deriveAgents([
    agent("B", { name: "Vega", createdAt: ago(21.2), ...PAUSED }), agent("A", { name: "Atlas", createdAt: ago(38.4), mode: "MARKETING" }),
    agent("C", { name: "Rook", createdAt: ago(9.6) }), agent("X", { name: "Echo", status: "dead", createdAt: ago(60) }), agent("N", { name: "New" }),
  ], { ...view(), events: [{ key: "e1", type: "venture_state", agentId: "C", at: new Date(NOW - 3_600_000).toISOString(), detail: {} }] } as never, NOW);

  it("orders living agents by time alive (unknown last); the dead are not listed; figures come from the reading", () => {
    const rows = railOrder(models(), NOW);
    expect(rows.map((r) => r.m.agent.id)).toEqual(["A", "B", "C", "N"]);
    expect(rows[0].e).toMatchObject({ level: 39 }); expect(rows[3].e).toMatchObject({ level: null, aliveMs: null });
    const rook = railEntry(models().find((m) => m.agent.id === "C")!, NOW);
    expect(rook.onActivityMs).toBe(3_600_000); // since its latest recorded event placed it
    expect(railEntry(models().find((m) => m.agent.id === "B")!, NOW).onActivityMs).toBeNull(); // the pause's start is not in this reading
    const since = deriveAgents([agent("B", { createdAt: ago(21.2), paused: true, pausedSince: hAgo(30) })], view(), NOW)[0];
    expect(railEntry(since, NOW).onActivityMs).toBe(30 * 3_600_000);
  });

  it("renders each entry with its level, activity and room; clicking calls the existing focus with that agent", () => {
    const ms = models(), picked: string[] = [];
    const html = renderToStaticMarkup(h(AgentRail, { models: ms, all: ms.map((m) => m.agent), selected: "B", now: NOW, onAgent: (id: string) => picked.push(id), onCommand: () => picked.push("command") }));
    expect([...html.matchAll(/data-agent="([^"]+)"/g)].map((m) => m[1])).toEqual(["A", "B", "C", "N"]);
    expect(html).toContain("Lv 39"); expect(html).toContain("PAUSED BY OWNER"); expect(html).toContain("Quarters"); expect(html).toContain("Fleet Command");
    expect(html).toContain("unknown · never reported");
    expect(html).toMatch(/aria-current="true"[^>]*data-agent="B"|data-agent="B"[^>]*aria-current="true"/);
    // The click handlers: walk the element tree and press each entry.
    const tree = (AgentRail as unknown as { type: (p: unknown) => ReactElement }).type({ models: ms, all: ms.map((m) => m.agent), selected: null, now: NOW, onAgent: (id: string) => picked.push(id), onCommand: () => picked.push("command") });
    const buttons: Array<{ props: { onClick: () => void; "data-agent"?: string } }> = [];
    const walk = (n: ReactNode) => { if (Array.isArray(n)) { n.forEach(walk); return; } if (!isValidElement(n)) return; const p = n.props as { children?: ReactNode; onClick?: () => void }; if (n.type === "button") buttons.push(n as never); walk(p.children); };
    walk(tree);
    for (const b of buttons) b.props.onClick();
    expect(picked).toEqual(["command", "A", "B", "C", "N"]);
  });
});

describe("idle wandering: cosmetic, inside the room, deterministic", () => {
  it("dwells at home part of each slot, otherwise strolls to a seeded spot inside the same room — never another room", () => {
    for (const d of DEPARTMENTS) for (const id of ["A1", "agent-7", "01M3F50SH7PNX2E3GST13J52AS"]) {
      const home = { x: d.x, z: d.z }; let away = 0;
      for (let t = 0; t < WANDER_SLOT_MS * 6; t += 1500) {
        const p = wanderPoint(id, home, d, t);
        expect(inRoom(p, d, WANDER_MARGIN), `${d.id} ${id} @${t}`).toBe(true);
        expect(roomAt(p)?.id).toBe(d.id);
        expect(wanderPoint(id, home, d, t)).toEqual(p); // deterministic
        if (p !== home) away++;
      }
      expect(away).toBeGreaterThan(0); expect(away).toBeLessThan((WANDER_SLOT_MS * 6) / 1500); // both dwelling and strolling
    }
    expect(WANDER_DWELL).toBeGreaterThan(0.3);
    // A vetoed spot (not walkable) keeps the agent home.
    const d = DEPARTMENT.library; for (let t = 0; t < WANDER_SLOT_MS * 3; t += 1000) expect(wanderPoint("A1", { x: d.x, z: d.z }, d, t, () => false)).toEqual({ x: d.x, z: d.z });
  });
  it("only an awake, free agent with nothing real to do strolls", () => {
    expect(mayWander("active", "default", false)).toBe(true);
    for (const [s, b, team] of [["active", "event", false], ["active", "mission", false], ["active", "default", true], ["held", "held", false], ["dead", "dead", false], ["provisioning", "provisioning", false], ["active", "sleep", false]] as const)
      expect(mayWander(s, b, team), `${s}/${b}/${team}`).toBe(false);
  });
});

describe("the art is unchanged: no pixel mode", () => {
  it("every quality renders the same world at its usual resolution", () => {
    for (const q of ["low", "medium", "high", "ultra"] as const) { expect("pixel" in HQ_PROFILE[q]).toBe(false); expect(HQ_PROFILE[q].dpr).toBeGreaterThanOrEqual(1); }
    expect(buildWorld.length).toBe(0);
  });
});

describe("the Quarters camera never looks through a bunk frame", () => {
  it("bunk frames are camera obstacles, one per frame, as tall as the posts", () => {
    expect(bunkOccluders(0)).toEqual([]);
    expect(bunkOccluders(5)).toHaveLength(5); expect(bunkOccluders(50)).toHaveLength(BUNKS);
    const b = bedPoint(3), o = bunkOccluders(5)[3];
    expect(o).toEqual({ x0: b.x - BED_WIDTH / 2, x1: b.x + BED_WIDTH / 2, z0: b.z, z1: b.z + BED_LENGTH, h: BUNK_H });
  });
  it("a sleeper is framed from the aisle at its bed's foot, outside every frame, with nothing between", () => {
    for (const n of [2, 50]) for (let i = 0; i < n; i++) {
      const occ = bunkOccluders(n), covered = i < bunksFor(n).uppers;
      const bed = bedPoint(i), p = { x: bed.x, z: bed.z }, f = frameSleeper("S", p, bed.level, new Map(), covered);
      // The camera stands in no bunk (below its top), inside Quarters, and looks at the sleeper's head.
      for (const o of occ) expect(f.cam.x >= o.x0 && f.cam.x <= o.x1 && f.cam.z >= o.z0 && f.cam.z <= o.z1 && f.cam.y < o.h, `bed ${i}`).toBe(false);
      expect(roomAt(f.cam)?.id).toBe("quarters");
      expect(f.look.y).toBeCloseTo(BED_TOP[bed.level] + 0.1); expect(f.look.x).toBe(p.x);
      // No OTHER bunk on the line of sight (its own bunk frames it; nothing crosses its posts).
      expect(blockedByFurniture(f.cam, f.cam.y, p, f.look.y, occ)).toBe(false);
      // A lower bed under an upper one: between the mattress and the bunk above; otherwise over the top rails.
      if (covered) { expect(f.cam.y).toBeGreaterThan(BED_TOP[0]); expect(f.cam.y).toBeLessThan(BED_TOP[1] - 0.2); } else expect(f.cam.y).toBeGreaterThan(BUNK_H);
    }
  });
});

describe("agent labels keep clear of the room plaques", () => {
  it("a label whose natural spot is under a plaque moves off it; without the plaque it stays", () => {
    const item = { id: "A", x: 200, y: 100, w: 80, h: 30, priority: 1 }, plaque = { x: 150, y: 95, w: 120, h: 40 };
    const free = layoutLabels([item], { w: 800, h: 600 }).get("A")!;
    expect(free).toMatchObject({ x: 160, y: 100, displaced: false });
    const moved = layoutLabels([item], { w: 800, h: 600 }, [plaque]).get("A")!;
    const overlaps = moved.x < plaque.x + plaque.w && moved.x + item.w > plaque.x && moved.y < plaque.y + plaque.h && moved.y + item.h > plaque.y;
    expect(overlaps).toBe(false); expect(moved.displaced).toBe(true);
  });
});

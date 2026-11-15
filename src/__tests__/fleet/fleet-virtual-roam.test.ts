/**
 * Facility-wide idle roaming (owner, 2026-10-16) — targeted and pure (no DOM, no WebGL):
 *   an awake, idle agent may stroll to other rooms and the corridors — never Quarters (the dorms are for sleepers) or
 *   Estate Storage (the dead), never onto a workstation, work spot or specialist desk; sleepers, held, provisioning, dead,
 *   working and team agents never roam; Reduce Motion keeps everyone home; targets are deterministic; the map's walks
 *   follow corridors; and a stroll never changes the recorded placement or reads as work (labels say "idle · strolling").
 */
import { describe, it, expect } from "vitest";
import { createElement as h } from "../../../codex-dashboard/node_modules/react/index.js";
import { renderToStaticMarkup } from "../../../codex-dashboard/node_modules/react-dom/server.node.js";
import { DAY_MS, DEPARTMENTS } from "../../../codex-dashboard/src/dashboard/command/departments";
import { deriveAgents } from "../../../codex-dashboard/src/dashboard/command/agents";
import { emptyCommandView } from "../../../codex-dashboard/src/dashboard/command/view";
import { agentTargetsWithStations, stationIndex, stationPoint, type Point } from "../../../codex-dashboard/src/dashboard/virtual/world";
import { corridorRoute, mayWander, NO_ROAM_ROOMS, ROAM_AVOID_M, ROAM_DWELL, ROAM_SLOT_MS, roamCandidates, roamPoint } from "../../../codex-dashboard/src/dashboard/virtual/hq/wander";
import { CROSS_Z, HUB_SOUTH, INTAKE, roomAt, SPINE_X } from "../../../codex-dashboard/src/dashboard/virtual/hq/route";
import { buildWorld, NAV_BOUNDS } from "../../../codex-dashboard/src/dashboard/virtual/hq/world-build";
import { clearanceAt, findPath, navGrid, reachableFrom, walkable } from "../../../codex-dashboard/src/dashboard/virtual/hq/nav";
import { stationDesks, chooseActivity } from "../../../codex-dashboard/src/dashboard/virtual/hq/choreo";
import { ALL_CREW_SEATS, crewFootprints, shownBays } from "../../../codex-dashboard/src/dashboard/virtual/hq/crew-layout";
import { strollingOf } from "../../../codex-dashboard/src/dashboard/virtual/Crew";
import { AgentRail } from "../../../codex-dashboard/src/dashboard/virtual/AgentRail";
import { AgentLabels } from "../../../codex-dashboard/src/dashboard/virtual/AgentLabels";
import { defaultPrefs } from "../../../codex-dashboard/src/dashboard/command/prefs";
import type { Agent } from "../../../codex-dashboard/src/dashboard/model";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const agent = (id: string, o: Partial<Agent> = {}): Agent => ({ id, name: `Agent-${id}`, role: "Normal", mode: "NORMAL", status: "active", cash: 9_000, burn: 10, colour: "cyan", venture: "", events: [], createdAt: new Date(NOW - 3 * DAY_MS).toISOString(), ...o });
const models = (as: Agent[]) => deriveAgents(as, { ...emptyCommandView("live"), genesisMinor: 10_000 }, NOW);
const STATIONS = Array.from({ length: 50 }, (_, i) => stationPoint(i));
const AVOID = [...STATIONS, ...ALL_CREW_SEATS, ...Object.values(INTAKE)];

describe("where an idle agent may stroll", () => {
  const cands = roamCandidates(AVOID);
  it("other rooms and the corridors — never Quarters or Estate, never on a workstation, crew desk or intake", () => {
    expect(cands.length).toBeGreaterThan(100);
    const rooms = new Set(cands.map((p) => roomAt(p)?.id ?? "corridor"));
    for (const d of DEPARTMENTS) expect(rooms.has(d.id), d.id).toBe(!NO_ROAM_ROOMS.has(d.id));
    expect(rooms.has("corridor")).toBe(true);
    expect(NO_ROAM_ROOMS).toEqual(new Set(["quarters", "estate"]));
    for (const p of cands) {
      expect(AVOID.every((a) => Math.hypot(a.x - p.x, a.z - p.z) >= ROAM_AVOID_M), `${p.x},${p.z}`).toBe(true);
      if (!roomAt(p)) expect(CROSS_Z.some((z) => Math.abs(p.z - z) < 1e-6) || SPINE_X.some((x) => Math.abs(p.x - x) < 1e-6)).toBe(true);
    }
    expect(roamCandidates(AVOID)).toEqual(cands); // deterministic
  });

  it("an idle agent dwells at home part of each slot and otherwise visits other rooms and corridors, deterministically", () => {
    const home = STATIONS[0], seen = new Set<string>();
    let away = 0, n = 0;
    for (let t = NOW; t < NOW + ROAM_SLOT_MS * 40; t += 4_000, n++) {
      const p = roamPoint("01M3F50SH7PNX2E3GST13J52AS", home, cands, t);
      expect(roamPoint("01M3F50SH7PNX2E3GST13J52AS", home, cands, t)).toEqual(p);
      if (p !== home) { away++; seen.add(roomAt(p)?.id ?? "corridor"); expect(cands).toContain(p); }
    }
    expect(away / n).toBeGreaterThan(1 - ROAM_DWELL - 0.12); expect(away / n).toBeLessThan(1 - ROAM_DWELL + 0.12);
    expect(seen.size).toBeGreaterThanOrEqual(4); // several different rooms and/or corridors
    expect([...seen].some((r) => r !== "floor")).toBe(true);
    for (const r of NO_ROAM_ROOMS) expect(seen.has(r)).toBe(false);
    expect(roamPoint("A", home, [], NOW + ROAM_SLOT_MS * 0.9)).toBe(home);
  });

  it("only an awake agent with nothing real to do roams: sleepers, held, provisioning, dead, working and team agents stay put", () => {
    const ms = models([agent("idle"), agent("paused", { paused: true }), agent("hib", { hibernation: { state: "hibernating", reportedAt: new Date(NOW - 3_600_000).toISOString(), since: null } }),
      agent("held", { status: "held" }), agent("prov", { status: "provisioning" }), agent("dead", { status: "dead" }), agent("mission", { mode: "MARKETING" })]);
    const can = Object.fromEntries(ms.map((m) => [m.agent.id, mayWander(m.agent.status, m.placement.basis, false)]));
    expect(can).toEqual({ idle: true, paused: false, hib: false, held: false, prov: false, dead: false, mission: false });
    expect(mayWander("active", "default", true)).toBe(false); // on a team project: working
    // Sleepers' targets are their bunks in Quarters — the dorms.
    const t = agentTargetsWithStations(ms, new Map(), NOW, false);
    expect(t.get("paused")!.department).toBe("quarters"); expect(t.get("hib")!.department).toBe("quarters");
  });
});

describe("3D: strolls are walkable, reachable and leave everyone's place free", () => {
  const plan = buildWorld();
  const nav = navGrid([...plan.footprints, ...stationDesks(new Map(STATIONS.map((p, i) => [String(i), p]))), ...crewFootprints(shownBays(4).map((b) => b.bay))], NAV_BOUNDS);
  const reach = reachableFrom(nav, HUB_SOUTH);
  const cands = roamCandidates([...AVOID, ...Object.values(plan.spots).flat()], (p) => walkable(nav, p) && clearanceAt(nav, p) >= 0.5 && reach(p));
  it("every 3D stroll target is on reachable floor, off every work spot, in a room other than Quarters/Estate or a corridor", () => {
    expect(cands.length).toBeGreaterThan(60);
    const rooms = new Set(cands.map((p) => roomAt(p)?.id ?? "corridor"));
    expect(rooms.size).toBeGreaterThanOrEqual(8);
    for (const p of cands) {
      expect(NO_ROAM_ROOMS.has(roomAt(p)?.id as never)).toBe(false);
      for (const s of Object.values(plan.spots).flat()) expect(Math.hypot(s.x - p.x, s.z - p.z)).toBeGreaterThanOrEqual(ROAM_AVOID_M);
    }
    // A walk there exists from an Agent Floor workstation (a sample: A* is the scene's job).
    const from = STATIONS[3];
    for (const p of cands.filter((_, i) => i % 9 === 0)) expect(findPath(nav, from, p), `${p.x},${p.z}`).not.toBeNull();
  });
});

describe("the map's walks follow the corridors", () => {
  it("never crosses a third room; ends exactly at the goal", () => {
    const cands = roamCandidates(AVOID), homes: Point[] = [STATIONS[0], STATIONS[17], { x: 0, z: -3 }, { x: -11, z: 10 }];
    let checked = 0;
    for (const a of [...homes, ...cands.filter((_, i) => i % 17 === 0)]) for (const b of cands.filter((_, i) => i % 23 === 0)) {
      const r = corridorRoute(a, b), pts = [a, ...r];
      expect(r[r.length - 1]).toEqual(b);
      const ok = new Set([roomAt(a)?.id, roomAt(b)?.id]);
      for (let i = 1; i < pts.length; i++) for (let k = 0; k <= 20; k++) {
        const p = { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * (k / 20), z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * (k / 20) }, room = roomAt(p)?.id;
        if (room) expect(ok.has(room), `${a.x},${a.z} → ${b.x},${b.z} crosses ${room}`).toBe(true);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
  });
});

describe("a stroll is cosmetic: the record is unchanged and it reads as idle", () => {
  const ms = models([agent("A", { name: "Agent-1" }), agent("B", { name: "Agent-2", mode: "MARKETING" }), agent("C", { name: "Agent-3", paused: true })]);
  const homes = new Map([...stationIndex(ms)].map(([id, i]) => [id, stationPoint(i)]));
  const far = { x: 21, z: -26 }; // in Marketing, far from every home

  it("only idle agents away from home count as strolling; Reduce Motion → nobody (everyone at home)", () => {
    const pos = new Map([["A", far], ["B", far], ["C", far]]);
    expect([...strollingOf(ms, homes, pos, new Map(), false)]).toEqual(["A"]);
    expect(strollingOf(ms, homes, new Map([["A", homes.get("A")!]]), new Map(), false).size).toBe(0);
    expect(strollingOf(ms, homes, pos, new Map([["A", "p1"]]), false).size).toBe(0); // on a team project
    expect(strollingOf(ms, homes, pos, new Map(), true).size).toBe(0);
  });

  it("the roster and labels keep the recorded activity and room, and add only 'idle · strolling'", () => {
    const a = ms.find((m) => m.agent.id === "A")!;
    expect(a.placement).toMatchObject({ department: "floor", activity: "OPERATING", basis: "default" });
    const rail = renderToStaticMarkup(h(AgentRail, { models: ms, all: ms.map((m) => m.agent), selected: null, now: NOW, onAgent: () => {}, onCommand: () => {}, strolling: new Set(["A"]) }));
    expect(rail).toContain("OPERATING · Agent Floor"); expect(rail).toContain("idle · strolling");
    expect(rail).toContain("MARKETING · Marketing");
    expect(rail.match(/idle · strolling/g)).toHaveLength(1);
    const labels = renderToStaticMarkup(h(AgentLabels, { models: ms, positionsRef: { current: new Map() }, projectRef: { current: null }, prefs: defaultPrefs({ width: 1400, cores: 8, memoryGb: 8, coarsePointer: false, prefersReducedMotion: false, webgl: true }),
      selected: null, fleetView: false, onAgent: () => {}, hidden: new Set(), marked: new Map(), strolling: new Set(["A"]) }));
    expect(labels).toContain("IDLE · strolling"); expect(labels).toContain("Agent-1, ");
    expect(labels).toMatch(/OPERATING, idle — strolling/);
  });

  it("away from its station an idle agent never takes a work pose, in whatever room it passes through", () => {
    for (const t of [0, 7, 19, 33, 61]) {
      const act = chooseActivity({ status: "active", basis: "default", department: "floor", moving: false, fast: false, rising: false, atStation: false, atSpot: false, spotPose: null, meeting: false, team: false, seed: 5, t });
      expect(act).toBe("idle");
    }
    expect(chooseActivity({ status: "active", basis: "default", department: "floor", moving: true, fast: false, rising: false, atStation: false, atSpot: false, spotPose: null, meeting: false, team: false, seed: 5, t: 0 })).toBe("walk");
  });
});

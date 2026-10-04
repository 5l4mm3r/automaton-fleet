/**
 * Virtual Command Centre + Formal Fleet Command (codex-dashboard): the shared model and the components built on it.
 *
 * Unit: wallet health bands and caps, the winning ("shades") state, state → department placement, event normalisation,
 * reading diffs, display preferences, portraits (deterministic identity, every band, every id), world/packets, scale.
 * Component: the shared components rendered to static markup with the dashboard's own React (no DOM emulation).
 * The LIVE integration (real gateway, step-up, real-time feed, CSP) is in fleet-codex-dashboard-e2e-pg.test.ts.
 */
import { describe, it, expect } from "vitest";
import { createElement as h } from "../../../codex-dashboard/node_modules/react/index.js";
import { renderToStaticMarkup } from "../../../codex-dashboard/node_modules/react-dom/server.node.js";
import { BAND_LABEL, HEALTH_THRESHOLDS, economicsFrom, healthOf, type AgentEconomics } from "../../../codex-dashboard/src/dashboard/command/economics";
import { ACTIVITY_WINDOW_MS, DEPARTMENT, DEPARTMENTS, eventDepartment, latestEventByAgent, placeAgent, slot } from "../../../codex-dashboard/src/dashboard/command/departments";
import { diffReadings, isDecision, mergeEvents, toFleetEvent, visualFromEvent, type FleetEvent } from "../../../codex-dashboard/src/dashboard/command/events";
import { QUALITY_PROFILE, defaultPrefs, loadPrefs, sanitizePrefs, savePrefs, STORAGE_KEY, type DeviceHints } from "../../../codex-dashboard/src/dashboard/command/prefs";
import { PORTRAIT_SIZE, portraitGrid, portraitPaths, traitsOf } from "../../../codex-dashboard/src/dashboard/command/portrait";
import { deriveAgents, mergePulseAgents } from "../../../codex-dashboard/src/dashboard/command/agents";
import { agentTargets, agentTargetsWithStations, birthState, BIRTH_ENTER_MS, BIRTH_MARK_MS, BIRTH_POWER_MS, livePackets, packetAt, packetFor, focusRect, EXTERNAL, stationIndex, stationPoint } from "../../../codex-dashboard/src/dashboard/virtual/world";
import { COMPACT_ABOVE, densityFor, layoutLabels, type LabelItem } from "../../../codex-dashboard/src/dashboard/virtual/labelLayout";
import { AgentLabels } from "../../../codex-dashboard/src/dashboard/virtual/AgentLabels";
import { AgentPortrait, HealthTag } from "../../../codex-dashboard/src/dashboard/command/AgentPortrait";
import { CapabilityState, DecisionFeed, EventFeed, TreasurySummary, capabilitiesOf } from "../../../codex-dashboard/src/dashboard/command/panels";
import { FleetCommandPage } from "../../../codex-dashboard/src/dashboard/command/FleetCommandPage";
import { AgentPanel, DepartmentPanel } from "../../../codex-dashboard/src/dashboard/virtual/VirtualPanels";
import { emptyCommandView, type CommandView } from "../../../codex-dashboard/src/dashboard/command/view";
import { toLiveCommand } from "../../../codex-dashboard/src/dashboard/live/mapping";
import { GatewayClient } from "../../../codex-dashboard/src/dashboard/api/client";
import type { Agent, Fleet } from "../../../codex-dashboard/src/dashboard/model";
import { hqDataFrom, redAlertOpen } from "../../../codex-dashboard/src/dashboard/virtual/hq/data";
import { buildWorld } from "../../../codex-dashboard/src/dashboard/virtual/hq/world-build";
import { HQ_PROFILE } from "../../../codex-dashboard/src/dashboard/virtual/hq/quality";

const GENESIS = 10_000;
const econ = (o: Partial<AgentEconomics> = {}): AgentEconomics => ({ agentId: "A", revenueMinor: 0, expensesMinor: 0, netProfitMinor: 0, recentNetMinor: 0, retainedMinor: 0,
  treasuryContributionsMinor: 0, runwayDays: 30, burnPerDayMinor: 10, commitmentsDue30dMinor: 0, redZoneMet: true, vulnerable: false, ...o });
const live = (cash: number) => ({ status: "active", cash });
const agent = (id: string, o: Partial<Agent> = {}): Agent => ({ id, name: `Agent ${id}`, role: "Normal", mode: "NORMAL", status: "active", cash: 9_000, burn: 10, colour: "cyan", venture: "", events: [], ...o });
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const ev = (type: string, agentId: string | null = "A1", msAgo = 1000, detail: Record<string, unknown> = {}): FleetEvent => toFleetEvent({ at: iso(msAgo), type, agentId, actor: "controller", detail })!;

describe("wallet health (one definition for Formal and Virtual)", () => {
  it("bands at the documented thresholds of the Genesis allocation", () => {
    expect(HEALTH_THRESHOLDS).toEqual({ healthyPct: 80, woundedPct: 40 });
    const band = (cash: number) => healthOf(live(cash), econ({ netProfitMinor: 0 }), GENESIS).band;
    expect([band(8_000), band(7_999), band(4_000), band(3_999), band(0)]).toEqual(["HEALTHY", "WOUNDED", "WOUNDED", "CRITICAL", "CRITICAL"]);
    expect(healthOf(live(8_000), null, GENESIS).pct).toBe(80);
    expect(healthOf(live(25_000), null, GENESIS).pct).toBe(250);
  });

  it("only FleetController declares death; no baseline or no cash is UNKNOWN, never guessed", () => {
    expect(healthOf({ status: "dead", cash: 50_000 }, econ({ netProfitMinor: 99_999, recentNetMinor: 99_999 }), GENESIS)).toMatchObject({ band: "DEAD", pct: null });
    expect(healthOf({ status: "failed", cash: 1 }, null, GENESIS).band).toBe("DEAD");
    expect(healthOf(live(0), null, GENESIS).band).toBe("CRITICAL"); // a living agent at £0 is not dead
    expect(healthOf(live(5_000), null, null)).toMatchObject({ band: "UNKNOWN", pct: null, label: BAND_LABEL.UNKNOWN });
    expect(healthOf(live(5_000), null, 0).band).toBe("UNKNOWN");
    expect(healthOf({ status: "active", cash: null }, null, GENESIS).band).toBe("UNKNOWN");
  });

  it("authoritative risk can only make the band worse", () => {
    expect(healthOf(live(9_000), econ({ commitmentsDue30dMinor: 9_500 }), GENESIS).band).toBe("CRITICAL");
    expect(healthOf(live(9_000), econ({ vulnerable: true, redZoneMet: false }), GENESIS).band).toBe("WOUNDED");
    expect(healthOf(live(1_000), econ({ vulnerable: true, redZoneMet: false }), GENESIS).band).toBe("CRITICAL"); // never improved
  });

  it("WINNING needs realised profit, recent profit, the cushion met and a HEALTHY wallet — never balance alone", () => {
    const win = econ({ netProfitMinor: 5_000, recentNetMinor: 800 });
    expect(healthOf(live(12_000), win, GENESIS).band).toBe("WINNING");
    expect(healthOf(live(50_000), econ({ netProfitMinor: 0, recentNetMinor: 0 }), GENESIS).band).toBe("HEALTHY"); // rich but not earning
    expect(healthOf(live(12_000), econ({ netProfitMinor: 5_000, recentNetMinor: -1 }), GENESIS).band).toBe("HEALTHY"); // old profit, losing now
    expect(healthOf(live(12_000), { ...win, redZoneMet: false }, GENESIS).band).toBe("HEALTHY");
    expect(healthOf(live(5_000), win, GENESIS).band).toBe("WOUNDED"); // distressed agents never wear shades
    expect(healthOf(live(12_000), { ...win, commitmentsDue30dMinor: 20_000 }, GENESIS).band).toBe("CRITICAL");
  });

  it("economics come from the wallet and risk JSON as they are (absent fields stay null)", () => {
    const e = economicsFrom("A", { lifetime: { revenueMinor: 1000, expensesMinor: 300, feesMinor: 20, netProfitMinor: 680 },
      last30d: { revenueMinor: 500, refundsMinor: 50, inferenceMinor: 30, operatingCostsMinor: 100 }, runway: { days: 12, burnPerDayMinor: 40 } }, { commitmentsDue30dMinor: 70, redZoneMet: true, vulnerable: false });
    expect(e).toMatchObject({ revenueMinor: 1000, expensesMinor: 320, netProfitMinor: 680, recentNetMinor: 320, runwayDays: 12, commitmentsDue30dMinor: 70, redZoneMet: true });
    expect(economicsFrom("A", null, null)).toMatchObject({ revenueMinor: null, recentNetMinor: null, redZoneMet: null, commitmentsDue30dMinor: null });
  });
});

describe("state → department (deterministic placement)", () => {
  it("status first, then the mission, then the latest own event inside the window, else the Agent Floor", () => {
    expect(placeAgent({ id: "A", status: "dead", mode: "MARKETING" }, undefined).department).toBe("estate");
    expect(placeAgent({ id: "A", status: "provisioning" }, undefined)).toMatchObject({ department: "floor", activity: "PROVISIONING" });
    expect(placeAgent({ id: "A", status: "held", mode: "MARKETING" }, undefined)).toMatchObject({ department: "floor", activity: "HELD" });
    expect(placeAgent({ id: "A", status: "active", mode: "MARKETING" }, undefined).department).toBe("marketing");
    expect(placeAgent({ id: "A", status: "active", mode: "OPPORTUNITY_HUNT" }, undefined).department).toBe("opportunity");
    expect(placeAgent({ id: "A", status: "active", mode: "KNOWLEDGE_DATA" }, undefined).department).toBe("library");
    expect(placeAgent({ id: "A", status: "active", role: "Opportunity hunt" }, undefined).department).toBe("opportunity"); // simulation roles
    const recent = { at: iso(60_000), type: "venture_state", agentId: "A" };
    expect(placeAgent({ id: "A", status: "active", mode: "NORMAL" }, recent)).toMatchObject({ department: "venture", activity: "BUILDING", basis: "event" });
    expect(placeAgent({ id: "A", status: "active", mode: "NORMAL" }, { ...recent, at: iso(ACTIVITY_WINDOW_MS + 60_000) })).toMatchObject({ department: "floor", basis: "default" });
  });

  it("unknown modes and event types fall back safely (never throw)", () => {
    expect(placeAgent({ id: "A", status: "active", mode: "SOMETHING_NEW" }, { at: iso(1000), type: "brand_new_event", agentId: "A" }).department).toBe("floor");
    expect(placeAgent({ id: "A", status: "weird" as string }, undefined).department).toBe("floor");
    expect(eventDepartment("brand_new_event")).toBeNull();
    expect(placeAgent({ id: "A", status: "active", mode: "NORMAL" }, { at: "not a date", type: "knowledge_recorded", agentId: "A" }).department).toBe("floor");
  });

  it("maps FleetController's real event vocabulary to rooms", () => {
    const cases: Array<[string, string]> = [["knowledge_recorded", "library"], ["opportunity_shortlist", "opportunity"], ["venture_created", "venture"], ["capital_requested", "command"],
      ["treasury_sweep", "treasury"], ["settlement_failed", "treasury"], ["identity_job_queued", "identity"], ["mail_assigned", "comms"], ["estate_opened", "estate"], ["health_challenge_failed", "security"]];
    for (const [type, dep] of cases) expect(eventDepartment(type), type).toBe(dep);
  });

  it("latest event per agent wins regardless of arrival order", () => {
    const m = latestEventByAgent([{ at: iso(5000), type: "a", agentId: "X" }, { at: iso(1000), type: "b", agentId: "X" }, { at: iso(3000), type: "c", agentId: "X" }, { at: iso(1), type: "d", agentId: null }]);
    expect(m.get("X")?.type).toBe("b");
    expect(m.size).toBe(1);
  });

  it("up to 50 agents in any one room get distinct spots inside its walls, spaced by how many share it", () => {
    for (const d of DEPARTMENTS) for (const n of [1, 10, 25, 50]) {
      const spots = Array.from({ length: n }, (_, i) => slot(d.id, i, n));
      for (const s of spots) {
        expect(s.x, `${d.id} ${n}`).toBeGreaterThan(d.x - d.w / 2); expect(s.x, `${d.id} ${n}`).toBeLessThan(d.x + d.w / 2);
        expect(s.z, `${d.id} ${n}`).toBeGreaterThan(d.z - d.d / 2); expect(s.z, `${d.id} ${n}`).toBeLessThan(d.z + d.d / 2);
      }
      expect(new Set(spots.map((s) => `${s.x.toFixed(2)},${s.z.toFixed(2)}`)).size).toBe(n);
      const min = Math.min(...spots.flatMap((a, i) => spots.slice(i + 1).map((b) => Math.hypot(a.x - b.x, a.z - b.z))), Infinity);
      if (n > 1) expect(min, `${d.id} ${n}`).toBeGreaterThanOrEqual(0.2);
    }
  });
});

describe("event normalisation (presentation only)", () => {
  it("turns real events into routed visual events; unknown types are not animated", () => {
    expect(visualFromEvent(ev("capital_requested"))).toMatchObject({ kind: "CAPITAL_REQUEST_CREATED", path: ["agent", "command"], agentId: "A1" });
    expect(visualFromEvent(ev("capital_decision", "A1", 1, { outcome: "approved" }))!.path).toEqual(["command", "treasury", "agent"]);
    expect(visualFromEvent(ev("capital_decision", "A1", 1, { outcome: "declined" }))!.path).toEqual(["command", "agent"]);
    expect(visualFromEvent(ev("settlement_recorded"))).toMatchObject({ kind: "REVENUE_EVENT", path: ["external", "venture", "agent"] });
    expect(visualFromEvent(ev("settlement_failed"))!.kind).toBe("SYSTEM_ALERT");
    expect(visualFromEvent(ev("treasury_sweep"))!.path).toEqual(["agent", "treasury"]);
    expect(visualFromEvent(ev("knowledge_recorded"))!.kind).toBe("RESEARCH_EVENT");
    expect(visualFromEvent(ev("mission_started", "A1", 1, { kind: "marketing" }))!.kind).toBe("MARKETING_EVENT");
    expect(visualFromEvent(ev("agent_died"))!.path).toEqual(["agent", "estate"]);
    expect(visualFromEvent(ev("agent_born"))!.kind).toBe("AGENT_BORN");
    expect(visualFromEvent(ev("notification", null, 1, { class: "RED", title: "x" }))!.kind).toBe("SYSTEM_ALERT");
    expect(visualFromEvent(ev("notification", null, 1, { class: "INFO" }))).toBeNull();
    expect(visualFromEvent(ev("risk_policy_set", null))!.kind).toBe("CAPABILITY_CHANGED");
    expect(visualFromEvent(ev("something_new"))).toBeNull();
    // A route through "agent" with no agent goes to Fleet Command instead (no dangling stop, no duplicate stop).
    expect(visualFromEvent(ev("capital_requested", null))!.path).toEqual(["command"]);
  });

  it("merges by identity, newest first, bounded", () => {
    const a = ev("knowledge_recorded", "A1", 3000), b = ev("venture_state", "A1", 1000);
    const kept = mergeEvents([], [a]);
    const merged = mergeEvents(kept, [b, a, b]);
    expect(merged.map((e) => e.type)).toEqual(["venture_state", "knowledge_recorded"]);
    const many = Array.from({ length: 900 }, (_, i) => ev("x", "A1", i * 10));
    expect(mergeEvents(merged, many, 400)).toHaveLength(400);
    expect(toFleetEvent({ type: 1 })).toBeNull();
  });

  it("decisions are recognised for the decision log", () => {
    for (const t of ["capital_decision", "replication_granted", "owner_request_decided", "agent_hold_set", "mission_started", "risk_policy_set"]) expect(isDecision(t), t).toBe(true);
    for (const t of ["knowledge_recorded", "settlement_recorded", "session_opened"]) expect(isDecision(t), t).toBe(false);
  });

  it("two readings imply births, deaths, moves, wallet and health/profit changes", () => {
    const r = (id: string, o: object = {}) => ({ id, status: "active", cash: 100, department: "floor" as const, band: "HEALTHY" as const, ...o });
    const out = diffReadings([r("A"), r("B"), r("C")], [r("A", { cash: 150, department: "library" }), r("B", { status: "dead", band: "DEAD", department: "estate" }), r("C", { band: "WINNING" }), r("D")], "t");
    const kinds = out.map((v) => `${v.agentId}:${v.kind}`);
    expect(kinds).toEqual(expect.arrayContaining(["A:AGENT_MOVED_DEPARTMENT", "A:AGENT_WALLET_CHANGED", "B:AGENT_DIED", "C:AGENT_PROFIT_STATE_CHANGED", "D:AGENT_BORN"]));
    expect(out.find((v) => v.kind === "AGENT_MOVED_DEPARTMENT")!.label).toBe("Agent Floor → Library / Research");
    expect(diffReadings([], [r("A")], "t")).toEqual([]); // the first reading is not a birth wave
  });
});

describe("display preferences (local only)", () => {
  const hints = (o: Partial<DeviceHints> = {}): DeviceHints => ({ width: 1600, cores: 8, memoryGb: 8, coarsePointer: false, prefersReducedMotion: false, webgl: true, ...o });
  it("defaults follow the device; phones and no-WebGL get the map", () => {
    expect(defaultPrefs(hints())).toMatchObject({ quality: "high", fps: 60, renderer: "auto" });
    expect(defaultPrefs(hints({ cores: 4 }))).toMatchObject({ quality: "medium" });
    expect(defaultPrefs(hints({ width: 900, coarsePointer: true }))).toMatchObject({ quality: "medium", fps: 30 });
    expect(defaultPrefs(hints({ width: 390 }))).toMatchObject({ quality: "low", renderer: "map" });
    expect(defaultPrefs(hints({ webgl: false }))).toMatchObject({ renderer: "map" });
    expect(defaultPrefs(hints({ prefersReducedMotion: true }))).toMatchObject({ reduceMotion: true, ambient: false });
  });
  it("stored values are sanitised field by field; broken storage falls back", () => {
    const d = defaultPrefs(hints());
    expect(sanitizePrefs({ quality: "insane", fps: 144, reduceMotion: "yes", renderer: "3d" }, d)).toEqual({ ...d, renderer: "3d" });
    const store = new Map<string, string>();
    const s = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    savePrefs({ ...d, quality: "ultra" }, s);
    expect(loadPrefs(d, s).quality).toBe("ultra");
    store.set(STORAGE_KEY, "{not json");
    expect(loadPrefs(d, s)).toEqual(d);
    expect(loadPrefs(d, { getItem: () => { throw new Error("blocked"); } })).toEqual(d);
    expect(() => savePrefs(d, { setItem: () => { throw new Error("blocked"); } })).not.toThrow();
    expect(Object.keys(QUALITY_PROFILE)).toEqual(["low", "medium", "high", "ultra"]);
    expect(QUALITY_PROFILE.low.particles).toBeLessThan(QUALITY_PROFILE.ultra.particles);
  });
});

describe("original operative portraits", () => {
  it("identity is deterministic per agent and differs between agents", () => {
    expect(portraitGrid("01M3F50SH7PNX2E3GST13J52AS", "HEALTHY")).toEqual(portraitGrid("01M3F50SH7PNX2E3GST13J52AS", "HEALTHY"));
    const seen = new Set(Array.from({ length: 40 }, (_, i) => JSON.stringify(traitsOf(`agent-${i}`))));
    expect(seen.size).toBeGreaterThan(20);
  });
  it("every band renders valid colours for many ids (regression: signed hash → missing palette entry)", () => {
    const bad: string[] = [];
    for (let i = 0; i < 1500; i++) {
      for (const band of ["HEALTHY", "WINNING", "WOUNDED", "CRITICAL", "DEAD", "UNKNOWN"] as const) {
        const g = portraitGrid(`id-${i}-${"x".repeat(i % 7)}`, band);
        if (g.length !== PORTRAIT_SIZE || g.some((row) => row.length !== PORTRAIT_SIZE || row.some((c) => c !== null && !/^#[0-9a-f]{6}$/.test(c)))) bad.push(`${i} ${band}`);
      }
    }
    expect(bad).toEqual([]);
  });
  it("condition changes the face: shades when winning, damage when wounded or critical, greyscale when dead", () => {
    const id = "01AGENT", healthy = portraitGrid(id, "HEALTHY"), win = portraitGrid(id, "WINNING"), crit = portraitGrid(id, "CRITICAL"), dead = portraitGrid(id, "DEAD");
    expect(win[14].slice(9, 23).every((c) => c === "#140e0b" || c === "#5b636b" || c === "#2b2b2b" || c === "#9aa4ae")).toBe(true); // shades across both eyes
    expect(PORTRAIT_SIZE).toBe(32);
    // Adult proportions: a neck and the uniform collar below the jaw, no helmet over the face.
    expect(healthy[30].filter((c) => c === "#2b3a4d" || c === "#1c2736" || c === "#111821").length).toBeGreaterThan(20);
    expect(JSON.stringify(crit)).toMatch(/#7f1d1d|#991b1b/); // blood
    expect(JSON.stringify(portraitGrid(id, "WOUNDED"))).toMatch(/#6b4a7a/); // bruise
    for (const row of dead) for (const c of row) if (c) expect(c.slice(1, 3)).toBe(c.slice(3, 5)); // grey
    expect(JSON.stringify(healthy)).not.toBe(JSON.stringify(win));
    expect(portraitPaths(id, "HEALTHY").length).toBeGreaterThan(5);
  });
});

describe("world: positions and packets", () => {
  it("targets are deterministic and per department; packets follow real routes and expire", () => {
    const models = deriveAgents([agent("B", { mode: "MARKETING" }), agent("A", { mode: "MARKETING" }), agent("C")], { ...emptyCommandView("live"), genesisMinor: GENESIS });
    const t1 = agentTargets(models), t2 = agentTargets([...models].reverse());
    expect(t1.get("A")).toEqual(t2.get("A"));
    expect(t1.get("A")!.department).toBe("marketing");
    expect(t1.get("C")!.department).toBe("floor");
    const v = visualFromEvent(ev("capital_decision", "A", 1, { outcome: "approved" }))!;
    const p = packetFor(v, t1, 1000)!;
    expect(p.points[0]).toEqual({ x: DEPARTMENT.command.x, z: DEPARTMENT.command.z });
    expect(p.points.at(-1)).toMatchObject({ x: t1.get("A")!.x, z: t1.get("A")!.z });
    expect(packetAt(p, 1000)).toEqual(p.points[0]);
    expect(packetAt(p, 1000 + p.duration + 1)).toBeNull();
    expect(livePackets([p, p, p], 1000, 2)).toHaveLength(2);
    expect(livePackets([p], 1000 + p.duration + 1, 10)).toHaveLength(0);
    expect(packetFor(visualFromEvent(ev("settlement_recorded", "A"))!, t1, 0)!.points[0]).toEqual(EXTERNAL);
    expect(packetFor({ ...v, agentId: "missing" }, t1, 0)).toBeNull(); // an unknown agent is not invented
    expect(focusRect({ level: "agent", id: "A" }, t1).x).toBe(t1.get("A")!.x);
  });

  it("scales: 1, 10, 25 and 50 agents derive, place and diff well inside a frame budget", () => {
    for (const n of [1, 10, 25, 50]) {
      const agents = Array.from({ length: n }, (_, i) => agent(`A${String(i).padStart(2, "0")}`, { mode: ["NORMAL", "MARKETING", "OPPORTUNITY_HUNT", "KNOWLEDGE_DATA"][i % 4], cash: 1000 + i * 300 }));
      const view = { ...emptyCommandView("live"), genesisMinor: GENESIS, events: Array.from({ length: 300 }, (_, i) => ev(["knowledge_recorded", "venture_state", "capital_requested"][i % 3], `A${String(i % n).padStart(2, "0")}`, i * 1000)) };
      const t0 = performance.now();
      for (let k = 0; k < 200; k++) {
        const models = deriveAgents(agents, view);
        const targets = agentTargets(models);
        diffReadings(models.map((m) => ({ id: m.agent.id, status: m.agent.status, cash: m.agent.cash, department: m.placement.department, band: m.health.band })), [], "t");
        expect(targets.size).toBe(n);
      }
      expect((performance.now() - t0) / 200, `${n} agents`).toBeLessThan(8); // ms per full update (a 60 fps frame is 16.7 ms)
    }
  });

  it("pulse agents update status, cash and mode but keep the snapshot's wallet runway", () => {
    const merged = mergePulseAgents([agent("A", { runwayDays: 12, burn: 40 })], [agent("A", { cash: 1, mode: "MARKETING", runwayDays: null, burn: 0 })]);
    expect(merged[0]).toMatchObject({ cash: 1, mode: "MARKETING", runwayDays: 12, burn: 40 });
  });
});

describe("Formal Fleet Command and Virtual panels (rendered)", () => {
  const fleet = (): Fleet => ({ treasury: 50_000, contributed: 100_000, revenue: 0, spend: 0, tick: 0, agents: [agent("A1", { name: "Founder 1", cash: 9_125 })], notices: [], ledger: [], history: [],
    missions: [], births: [], estates: [], documents: [], consents: [], passkeys: [], sessions: [], audit: [], processed: [],
    policy: { threshold: 0, autoBirth: false, maxAgents: 2, dailyHour: 8, email: "", riskLimit: 0, missionLimit: 0 },
    live: { fetchedAt: "2026-10-03T20:00:00Z", wealth: { cash: 50_000, ownerContributed: 100_000, ownerWithdrawn: 0, fleetGenerated: 0 }, flows24h: { revenue: 0, spend: 875, profitContributed: 0, ownerFunding: 0 },
      replication: { thresholdMinor: 100_000, remainingMinor: 100_000, met: false, blockers: ["wealthThresholdNotMet"], gate: {}, phase: "idle", pendingSince: null, elapsedSeconds: null, remainingSeconds: null,
        windowHours: 24, thresholdsConsumed: 0, highWaterMinor: 0, nextAgentNumber: 2, livingAgents: 1, maxAgents: 2, ceiling: 50, queuedBirths: 0, registrySwitch: false, autoBirthEnabled: false, nextThresholds: [] },
      mail: "NOT_CONFIGURED", sms: "NOT_CONFIGURED", recordedNeeds: 0, storage: null, health: { ok: true, findings: 0 }, adminEmail: null, unavailable: [] } });
  const view = (): CommandView => ({ ...emptyCommandView("live"), fetchedAt: "2026-10-03T20:00:01Z", genesisMinor: 10_000,
    economics: { A1: econ({ agentId: "A1", netProfitMinor: -875, recentNetMinor: -875, revenueMinor: 0, expensesMinor: 875 }) },
    events: [ev("capital_decision", "A1", 5000, { outcome: "approved" }), ev("knowledge_recorded", "A1", 2000)],
    capital: [{ agentId: "A1", purpose: "Research tool", amountMinor: 2500, approvedMinor: 2000, outcome: "approved", reasons: ["Evidence sufficient"], wouldChange: ["More evidence"], policyVersion: 3, at: iso(5000) }],
    settings: { flags: { maxAgents: 2, registryReplicationSwitch: false }, missions: { stagnation_days: 14, auto_assign_enabled: true, knowledge_target_hours: 36, knowledge_max_hours: 48, marketing_max_hours: 168, marketing_review_hours: 24 },
      risk: { red_zone_bp: 1000, vulnerable_age_days: 90, comfort_months: 3, deep_bp: 5000, deepest_bp: 7500, amber_bp: 7500 }, sweeps: { enabled: false }, capital: { enabled: true }, replication: { auto_birth_enabled: false } } });
  const control = (label: string, op: string) => h("button", { "data-op": op }, label);
  const html = (el: unknown) => renderToStaticMarkup(el as never);

  it("portraits carry their state in text and data, and the health tag explains itself", () => {
    const m = deriveAgents(fleet().agents, view())[0];
    expect(m.health.band).toBe("HEALTHY"); // 91 %, losing money: healthy, not winning
    const out = html(h(AgentPortrait, { id: "A1", name: "Founder 1", band: m.health.band }));
    expect(out).toContain('data-band="HEALTHY"');
    expect(out).toContain('aria-label="Founder 1 portrait, healthy"');
    expect(html(h(HealthTag, { health: m.health }))).toMatch(/HEALTHY · 91%/);
    for (const band of ["WINNING", "WOUNDED", "CRITICAL", "DEAD", "UNKNOWN"] as const) expect(html(h(AgentPortrait, { id: "A1", name: "X", band }))).toContain(`data-band="${band}"`);
  });

  it("Formal Fleet Command: controller overview, read-only safety rows, step-up behaviour controls", () => {
    const models = deriveAgents(fleet().agents, view());
    const page = html(h(FleetCommandPage, { fleet: fleet(), view: view(), models, feed: "live", live: true, control, openAgent: () => {}, go: () => {} }));
    for (const t of ["Overview", "Decision Log", "Information Feed", "Behaviour", "Safety &amp; Capabilities", "Advanced", "Controller status", "Healthy", "1 / cap 2", "Founder 1"]) expect(page).toContain(t);
    const caps = capabilitiesOf(fleet(), view());
    expect(caps.find((c) => c.name === "Real payments")).toMatchObject({ state: "host switch", tone: "unknown" });
    expect(caps.find((c) => c.name === "Mail")).toMatchObject({ state: "NOT CONFIGURED", tone: "dormant" });
    expect(caps.find((c) => c.name === "Automatic replication — policy")).toMatchObject({ state: "off" });
    expect(html(h(CapabilityState, { fleet: fleet(), view: view() }))).toContain("not exposed to this gateway");
  });

  it("decision log shows stored decisions and reasons only; the event feed shows what Fleet Command received", () => {
    const models = deriveAgents(fleet().agents, view());
    const v2 = { ...view(), capital: [{ ...view().capital[0], inputs: { cushionMet: true, cashMinor: 9125 } }],
      ventures: [{ key: "research-briefs", agentId: "A1", state: "validating", decisions: [{ key: "price", revision: 1, purpose: "Set the launch price", selected: "£49", confidenceBp: 6000, outcome: null, lessons: ["Test two prices"], createdAt: iso(3000) }] }] };
    const d2 = html(h(DecisionFeed, { view: v2, models }));
    expect(d2).toContain("input: cushionMet");
    expect(d2).toContain("input: cash");
    expect(d2).toContain("research-briefs: Set the launch price → £49");
    expect(d2).toContain("Test two prices");
    const d = html(h(DecisionFeed, { view: view(), models }));
    expect(d).toContain("Capital request £25.00 → approved (£20.00 approved)");
    expect(d).toContain("Evidence sufficient");
    expect(d).toContain("Would change: More evidence");
    expect(d).toContain("Model reasoning is never recorded or shown");
    const f = html(h(EventFeed, { events: view().events, models }));
    expect(f).toContain("knowledge recorded");
    expect(html(h(DecisionFeed, { view: null, models }))).toContain("Reading decisions");
  });

  it("Virtual panels reuse the same facts: Treasury figures, comms truthfully dormant, the agent's economics", () => {
    const f = fleet(), v = view(), models = deriveAgents(f.agents, v);
    const treasury = html(h(DepartmentPanel, { dep: "treasury", fleet: f, view: v, models, openAgent: () => {}, go: () => {} }));
    expect(treasury).toContain("£500.00"); // the same Treasury cash as the Formal summary
    expect(html(h(TreasurySummary, { fleet: f, view: v }))).toContain("£500.00");
    expect(treasury).toContain("Research tool".slice(0, 0) + "£25.00 requested → approved");
    const comms = html(h(DepartmentPanel, { dep: "comms", fleet: f, view: v, models, openAgent: () => {}, go: () => {} }));
    expect(comms).toContain("MAIL: NOT CONFIGURED");
    expect(comms).toContain("no communications traffic is shown");
    const a = html(h(AgentPanel, { m: models[0], fleet: f, view: v, control, go: () => {} }));
    for (const t of ["Founder 1", "£91.25", "HEALTHY", "Net profit (lifetime)", "-£8.75", "View full agent"]) expect(a).toContain(t);
    expect(a).toContain('data-op="hold"'); // actions go through the deck's controls (review + step-up), not a bypass
  });

  it("Virtual HQ screens show only FleetController's figures; a figure the gateway does not supply reads —", () => {
    const f = fleet(), v = view(), models = deriveAgents(f.agents, v), d = hqDataFrom(f, v, models);
    const row = (dep: keyof typeof d, k: string) => d[dep]!.find(([key]) => key === k)?.[1];
    expect(row("command", "Living agents")).toBe("1 / 2");
    expect(row("command", "Treasury cash")).toBe("£500.00");
    expect(row("treasury", "Owner funding")).toBe("£1,000.00");
    expect(row("treasury", "Spend 24 h")).toBe("£8.75");
    expect(row("command", "Replication")).toBe("£1,000.00 to go");
    expect(row("comms", "Mail")).toBe("NOT CONFIGURED");
    expect(row("security", "RED alerts open")).toBe("0");
    expect(row("estate", "Store")).toBe("—"); // storage not reported: no number is made up
    // Without the LIVE view (simulation), LIVE-only figures are absent, not invented.
    const sim = hqDataFrom({ ...f, live: undefined }, null, models);
    expect(sim.treasury!.find(([k]) => k === "Fleet-generated")?.[1]).toBe("—");
    expect(sim.command!.find(([k]) => k === "Decisions (log)")?.[1]).toBe("—");
    // Security beacons turn red only for an unacknowledged RED notice.
    expect(redAlertOpen(f)).toBe(false);
    expect(redAlertOpen({ ...f, notices: [{ id: "n", level: "RED", text: "x", acknowledged: true } as Fleet["notices"][number]] })).toBe(false);
    expect(redAlertOpen({ ...f, notices: [{ id: "n", level: "RED", text: "x", acknowledged: false } as Fleet["notices"][number]] })).toBe(true);
  });
});

describe("Virtual HQ v2: the building (quality never removes the world)", () => {
  it("every department is a real room with its live status screen, sign and light; furniture inside its walls", () => {
    const plan = buildWorld();
    for (const d of DEPARTMENTS) {
      expect(plan.screens.some((s) => s.id === `${d.id}:status` && s.kind === "status"), d.id).toBe(true);
      expect(plan.screens.some((s) => s.dep === d.id && s.kind === "sign"), d.id).toBe(true);
      expect(plan.lights.some((l) => l.dep === d.id), d.id).toBe(true);
      for (const s of plan.screens.filter((x) => x.dep === d.id)) {
        expect(Math.abs(s.x - d.x) <= d.w / 2 + 0.01 && Math.abs(s.z - d.z) <= d.d / 2 + 0.01, `${s.id} inside ${d.id}`).toBe(true);
      }
    }
    expect(new Set(plan.screens.map((s) => s.id)).size).toBe(plan.screens.length);
  });

  it("the merged building can be built again (every quality change / fallback re-mounts the scene with the full world)", () => {
    const plan = buildWorld();
    const a = plan.builder.build(), b = plan.builder.build();
    expect(a.size).toBeGreaterThan(10);
    expect([...b.keys()]).toEqual([...a.keys()]);
    for (const [k, g] of a) expect(b.get(k)!.getAttribute("position").count, k).toBe(g.getAttribute("position").count);
  });

  it("quality levels change materials, light and effects only — never the world; Low keeps every room", () => {
    expect(Object.keys(HQ_PROFILE)).toEqual(["low", "medium", "high", "ultra"]);
    const order = ["low", "medium", "high", "ultra"] as const;
    for (let i = 1; i < order.length; i++) {
      const lo = HQ_PROFILE[order[i - 1]], hi = HQ_PROFILE[order[i]];
      expect(hi.shadowMap).toBeGreaterThanOrEqual(lo.shadowMap);
      expect(hi.detail).toBeGreaterThanOrEqual(lo.detail);
      expect(hi.particles).toBeGreaterThanOrEqual(lo.particles);
    }
    // The world plan does not depend on quality at all (no quality input), so nothing can be hidden by it.
    expect(buildWorld.length).toBe(0);
    expect(HQ_PROFILE.low.shadows).toBe(false);
    expect(HQ_PROFILE.ultra.atmosphere && HQ_PROFILE.ultra.reflections).toBe(true);
  });
});

describe("behaviour commands (LIVE mapping, step-up policy operations)", () => {
  const c = new GatewayClient();
  it("mission and risk policy changes are validated and sent as the existing policy operation", async () => {
    expect(await toLiveCommand({ id: "1", op: "mission_policy", args: { stagnationDays: "21", autoAssignEnabled: "false", knowledgeTargetHours: "" } }, null, c))
      .toEqual({ kind: "policy", area: "mission", patch: { stagnationDays: 21, autoAssignEnabled: false } });
    expect(await toLiveCommand({ id: "2", op: "risk_policy", args: { redZoneBp: "12.5", comfortMonths: "4" } }, null, c))
      .toEqual({ kind: "policy", area: "risk", patch: { redZoneBp: 1250, comfortMonths: 4 } });
    for (const args of [{ stagnationDays: "0" }, { stagnationDays: "1.5" }, { knowledgeTargetHours: "50", knowledgeMaxHours: "40" }, {}])
      await expect(toLiveCommand({ id: "3", op: "mission_policy", args }, null, c)).rejects.toThrow();
    for (const args of [{ redZoneBp: "101" }, { redZoneBp: "1.234" }, { comfortMonths: "99" }, {}])
      await expect(toLiveCommand({ id: "4", op: "risk_policy", args }, null, c)).rejects.toThrow();
  });
});


describe("agent birth: dedicated workstation, power-up, entrance (presentation only)", () => {
  it("phases: dormant station powers up, the agent enters from Fleet Command to its station, then settles", () => {
    expect(birthState(undefined, 0, false)).toEqual({ phase: "settled", power: 1, visible: true, atStation: false, mark: false });
    expect(birthState(1000, 1000, false)).toMatchObject({ phase: "powering", power: 0, visible: false, atStation: true });
    expect(birthState(1000, 1000 + BIRTH_POWER_MS / 2, false).power).toBeCloseTo(0.5);
    expect(birthState(1000, 1000 + BIRTH_POWER_MS + 1, false)).toMatchObject({ phase: "entering", power: 1, visible: true, atStation: true });
    expect(birthState(1000, 1000 + BIRTH_POWER_MS + BIRTH_ENTER_MS + 1, false)).toMatchObject({ phase: "settled", atStation: false });
  });
  it("reduced motion: the station is simply online and the newborn in place, marked new for a while", () => {
    expect(birthState(0, 1, true)).toEqual({ phase: "settled", power: 1, visible: true, atStation: false, mark: true });
    expect(birthState(0, BIRTH_MARK_MS + 1, true).mark).toBe(false);
  });
  it("every agent (the dead included) has a stable station; Floor agents stand at their own, a newborn heads there first", () => {
    const view = { ...emptyCommandView("live"), genesisMinor: GENESIS };
    const models = deriveAgents([agent("C"), agent("A", { mode: "KNOWLEDGE_DATA" }), agent("B", { status: "dead" })], view);
    const idx = stationIndex(models);
    expect([...idx]).toEqual([["A", 0], ["B", 1], ["C", 2]]);
    expect(stationIndex([...models].reverse())).toEqual(idx);
    const now = 50_000;
    const t = agentTargetsWithStations(models, new Map(), now, false);
    expect(t.get("C")).toMatchObject({ ...stationPoint(2, 3), department: "floor" }); // on the Floor: at its own station
    expect(t.get("A")!.department).toBe("library");
    const born = agentTargetsWithStations(models, new Map([["A", now - BIRTH_POWER_MS - 10]]), now, false);
    expect(born.get("A")).toMatchObject({ ...stationPoint(0, 3), department: "floor" }); // entering: its station first
    const settled = agentTargetsWithStations(models, new Map([["A", now - BIRTH_POWER_MS - BIRTH_ENTER_MS - 10]]), now, false);
    expect(settled.get("A")!.department).toBe("library"); // then its first real destination
    expect(agentTargetsWithStations(models, new Map([["A", now]]), now, true).get("A")!.department).toBe("library"); // reduced motion: in place
  });
});

describe("adaptive agent labels (name + wallet visible at Fleet scale)", () => {
  const item = (id: string, x: number, y: number, priority = 1, w = 100, h = 14): LabelItem => ({ id, x, y, w, h, priority });
  it("density: full in small Fleets or when zoomed in; compact NAME · £WALLET in the Fleet view of a large Fleet", () => {
    expect(densityFor(COMPACT_ABOVE, true)).toBe("full");
    expect(densityFor(COMPACT_ABOVE + 1, true)).toBe("compact");
    expect(densityFor(50, false)).toBe("full");
  });
  it("places labels without overlap where space allows; highest priority keeps its natural spot", () => {
    const out = layoutLabels([item("a", 200, 100), item("b", 205, 102), item("crit", 210, 101, 3)], { w: 800, h: 600 });
    expect(out.get("crit")).toMatchObject({ displaced: false, overlapping: false });
    const rects = [...out.values()].map((p) => p!);
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      expect(a.x < b.x + 100 && a.x + 100 > b.x && a.y < b.y + 14 && a.y + 14 > b.y, `${i}/${j}`).toBe(false);
    }
    expect(rects.filter((r) => r.displaced)).toHaveLength(2);
  });
  it("culls only agents off-screen; a crowded label is still shown (flagged), never hidden; deterministic", () => {
    const out = layoutLabels([item("off", -50, 100), item("on", 50, 100)], { w: 400, h: 300 });
    expect(out.get("off")).toBeNull();
    expect(out.get("on")).not.toBeNull();
    const crowd = Array.from({ length: 50 }, (_, i) => item(`a${i}`, 60 + (i % 5), 40 + (i % 3), 1, 100, 14));
    const tight = layoutLabels(crowd, { w: 160, h: 90 });
    expect([...tight.values()].every((p) => p !== null)).toBe(true);
    expect([...tight.values()].some((p) => p!.overlapping)).toBe(true);
    expect(JSON.stringify([...layoutLabels(crowd, { w: 160, h: 90 })])).toBe(JSON.stringify([...tight]));
  });
  it("50 labels in a realistic Fleet view: almost all placed clear of each other, well inside a frame", () => {
    // 50 agents on a 12 × 4 grid of stations ~20 px apart (the Agent Floor zoomed out), compact labels ~110 × 14 px.
    const items = Array.from({ length: 50 }, (_, i) => item(`f${String(i).padStart(2, "0")}`, 300 + (i % 12) * 20, 220 + Math.floor(i / 12) * 20, i % 7 === 0 ? 3 : 1, 110, 14));
    const t0 = performance.now();
    let out = layoutLabels(items, { w: 900, h: 560 });
    for (let k = 0; k < 99; k++) out = layoutLabels(items, { w: 900, h: 560 });
    expect((performance.now() - t0) / 100).toBeLessThan(4);
    const shown = [...out.values()].filter((p) => p !== null);
    expect(shown).toHaveLength(50);
    expect(shown.filter((p) => p!.overlapping).length).toBeLessThanOrEqual(5);
  });
  it("renders compact NAME · £WALLET in a large Fleet view, and the full card when zoomed in (always with state in the name)", () => {
    const view = { ...emptyCommandView("live"), genesisMinor: GENESIS };
    const many = deriveAgents(Array.from({ length: 20 }, (_, i) => agent(`A${i}`, { name: `Agent ${i}`, cash: i === 3 ? 1_000 : 9_000 })), view);
    const props = { models: many, positionsRef: { current: new Map() }, projectRef: { current: null }, prefs: defaultPrefs({ width: 1600, cores: 8, memoryGb: 8, coarsePointer: false, prefersReducedMotion: false, webgl: true }),
      selected: null, onAgent: () => {}, hidden: new Set<string>(), marked: new Map() };
    const compact = renderToStaticMarkup(h(AgentLabels, { ...props, fleetView: true }) as never);
    expect(compact).toContain('data-density="compact"');
    expect(compact).toContain("Agent 3");
    expect(compact).toContain("£10.00");
    expect(compact).toContain('aria-label="Agent 3, £10.00, CRITICAL, OPERATING"');
    expect(compact).not.toContain("OPERATING</span>"); // activity text only in the full card
    const full = renderToStaticMarkup(h(AgentLabels, { ...props, fleetView: false }) as never);
    expect(full).toContain('data-density="full"');
    expect(full).toContain("OPERATING</span>");
  });
});

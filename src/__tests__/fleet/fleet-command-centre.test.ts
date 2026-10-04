/**
 * Virtual Command Centre + Formal Fleet Command (codex-dashboard): the shared model and the components built on it.
 *
 * Unit: wallet health bands and caps, the winning ("shades") state, state → department placement, event normalisation,
 * reading diffs, display preferences, portraits (deterministic identity, every band, every id), world/packets, scale.
 * Component: the shared components rendered to static markup with the dashboard's own React (no DOM emulation).
 * The LIVE integration (real gateway, step-up, real-time feed, CSP) is in fleet-codex-dashboard-e2e-pg.test.ts.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { createElement as h } from "../../../codex-dashboard/node_modules/react/index.js";
import { renderToStaticMarkup } from "../../../codex-dashboard/node_modules/react-dom/server.node.js";
import { BAND_LABEL, HEALTH_THRESHOLDS, economicsFrom, healthOf, type AgentEconomics } from "../../../codex-dashboard/src/dashboard/command/economics";
import { ACTIVITY_WINDOW_MS, DEPARTMENT, DEPARTMENTS, eventDepartment, latestEventByAgent, placeAgent, slot } from "../../../codex-dashboard/src/dashboard/command/departments";
import { diffReadings, isDecision, mergeEvents, toFleetEvent, visualFromEvent, type FleetEvent } from "../../../codex-dashboard/src/dashboard/command/events";
import { QUALITY_PROFILE, defaultPrefs, loadPrefs, sanitizePrefs, savePrefs, STORAGE_KEY, type DeviceHints } from "../../../codex-dashboard/src/dashboard/command/prefs";
import { PORTRAIT_SIZE, identityColours, portraitFigure, portraitPixels, portraitPng, traitsOf } from "../../../codex-dashboard/src/dashboard/command/portrait";
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
import { hqBoardsFrom, hqDataFrom, redAlertOpen, treasuryBannerFrom } from "../../../codex-dashboard/src/dashboard/virtual/hq/data";
import { INTAKE, roomAt, routeThrough } from "../../../codex-dashboard/src/dashboard/virtual/hq/route";
import { flowLabel } from "../../../codex-dashboard/src/dashboard/virtual/hq/flow";
import { advance, CATEGORY_COLOUR, categoryOf, importanceOf, newSchedule, PHASE, phaseAt, priorityOf, QUEUE_CAP, slotsFor, STALE_MS, totalTime, toTransport, transportFrame, type Transport } from "../../../codex-dashboard/src/dashboard/virtual/hq/transport";
import { transportSkin, registerTransportSkin } from "../../../codex-dashboard/src/dashboard/virtual/hq/transport-skin";
import { findPath, lineClear, navGrid, walkable } from "../../../codex-dashboard/src/dashboard/virtual/hq/nav";
import { chooseActivity, giveWay, isWorking, reactionAt, stationDesks, type ActivityContext } from "../../../codex-dashboard/src/dashboard/virtual/hq/choreo";
import { NAV_BOUNDS } from "../../../codex-dashboard/src/dashboard/virtual/hq/world-build";
import { IDLE_BEFORE_SHOT_MS, interact, shotGoal, takeShot, wantShot, type DirectorState } from "../../../codex-dashboard/src/dashboard/virtual/hq/director";
import { blockers, frameAgent, viewable } from "../../../codex-dashboard/src/dashboard/virtual/hq/framing";
import { workTargets } from "../../../codex-dashboard/src/dashboard/virtual/hq/spots";
import { appearanceOf, COSMETIC_SLOTS, registerCosmetic } from "../../../codex-dashboard/src/dashboard/virtual/hq/appearance";
import { activeTeams, compensationText, hours, projectsOf } from "../../../codex-dashboard/src/dashboard/command/projects";
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

describe("original operative portraits (v3: 128×128 painted)", () => {
  const BANDS = ["HEALTHY", "WINNING", "WOUNDED", "CRITICAL", "DEAD", "UNKNOWN"] as const;
  const lum = (px: Uint8ClampedArray, i: number) => 0.3 * px[i * 4] + 0.59 * px[i * 4 + 1] + 0.11 * px[i * 4 + 2];
  /** Correlation of luminance over a window (the structure of the face, independent of grading). */
  const corr = (a: Uint8ClampedArray, b: Uint8ClampedArray, y0: number, y1: number, x0 = 30, x1 = 98) => {
    const xs: number[] = [], ys: number[] = [];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { xs.push(lum(a, y * PORTRAIT_SIZE + x)); ys.push(lum(b, y * PORTRAIT_SIZE + x)); }
    const m = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length, ma = m(xs), mb = m(ys);
    let num = 0, da = 0, db = 0; xs.forEach((x, i) => { num += (x - ma) * (ys[i] - mb); da += (x - ma) ** 2; db += (ys[i] - mb) ** 2; });
    return num / Math.sqrt(da * db);
  };
  it("source resolution is 128×128 RGBA; identity is deterministic per agent and differs between agents", () => {
    expect(PORTRAIT_SIZE).toBe(128);
    const p = portraitPixels("01M3F50SH7PNX2E3GST13J52AS", "HEALTHY");
    expect(p.length).toBe(128 * 128 * 4);
    expect([...portraitPixels("01M3F50SH7PNX2E3GST13J52AS", "HEALTHY")]).toEqual([...p]);
    const seen = new Set(Array.from({ length: 40 }, (_, i) => JSON.stringify(traitsOf(`agent-${i}`))));
    expect(seen.size).toBeGreaterThan(20);
    // A PNG for img-src data: (the built-in encoder outside the browser).
    expect(portraitPng("01AGENT", "HEALTHY")).toMatch(/^data:image\/png;base64,iVBOR/);
  });
  it("every band renders for many ids (indices always in range; no NaN)", () => {
    for (let i = 0; i < 300; i++) { const t = traitsOf(`id-${i}-${"x".repeat(i % 7)}`); expect(t.skin).toBeGreaterThanOrEqual(0); expect(t.eyes).toBeGreaterThanOrEqual(0); }
    for (let i = 0; i < 6; i++) for (const band of BANDS) {
      const p = portraitPixels(`id-${i}`, band);
      expect(p.length).toBe(128 * 128 * 4);
      expect(p.every((v, k) => (k % 4 === 3 ? v === 255 : v >= 0))).toBe(true);
    }
  });
  it("the same face persists through every health state; another agent's face does not match", () => {
    const id = "founder-3", other = "founder-6", base = portraitPixels(id, "HEALTHY");
    for (const band of BANDS) {
      const same = corr(base, portraitPixels(id, band), 18, 52); // forehead, hair and brows: identity, not condition
      expect(same, band).toBeGreaterThan(0.9);
      expect(same, band).toBeGreaterThan(corr(base, portraitPixels(other, band), 18, 52));
    }
  });
  it("condition is painted on the face: shades when winning, bruising and blood when critical, greyscale when dead (non-graphic)", () => {
    const id = "01AGENT", healthy = portraitPixels(id, "HEALTHY"), win = portraitPixels(id, "WINNING"), crit = portraitPixels(id, "CRITICAL"), dead = portraitPixels(id, "DEAD");
    const eyeBand = (p: Uint8ClampedArray) => { let s = 0, n = 0; for (let y = 56; y < 64; y++) for (let x = 44; x < 84; x++) { s += lum(p, y * 128 + x); n++; } return s / n; };
    expect(eyeBand(win)).toBeLessThan(eyeBand(healthy) * 0.75); // dark lenses across the eyes
    const reds = (p: Uint8ClampedArray) => { let n = 0; for (let i = 0; i < 128 * 128; i++) if (p[i * 4] > 80 && p[i * 4 + 1] < 45 && p[i * 4 + 2] < 45) n++; return n; };
    expect(reds(crit)).toBeGreaterThan(reds(healthy) + 10); // blood, restrained
    expect(reds(crit)).toBeLessThan(400); // …and not graphic
    let maxSat = 0; for (let i = 0; i < 128 * 128; i++) { const r = dead[i * 4], g = dead[i * 4 + 1], b = dead[i * 4 + 2]; maxSat = Math.max(maxSat, Math.max(r, g, b) - Math.min(r, g, b)); }
    expect(maxSat).toBeLessThan(40); // powered down, desaturated
  });
  it("the 3D operator shares the portrait's identity: the same seeded traits, and the face is cut from the portrait itself", () => {
    for (let i = 0; i < 30; i++) {
      const id = `agent-${i}`, t = traitsOf(id), c = identityColours(id);
      expect(c.hairStyle).toBe(t.hair); expect(c.facialHair).toBe(t.facialHair); expect(c.width).toBe(t.width); expect(c.earpiece).toBe(t.earpiece);
      expect(c).toEqual(identityColours(id));
    }
    const fig = portraitFigure("founder-1", "HEALTHY");
    expect(fig[60 * 128 + 64]).toBe(255); // the face centre is person
    expect(fig[2 * 128 + 2]).toBe(0); // the corner is background (cut away on the 3D head)
  });
});

describe("Virtual HQ v2.1: Treasury banner, boards, information flow, framing (presentation of authoritative data only)", () => {
  const live = (over: Partial<NonNullable<Fleet["live"]>> = {}): Fleet => ({ treasury: 777_777, contributed: 0, revenue: 0, spend: 0, tick: 0, agents: [], notices: [], ledger: [], history: [],
    missions: [], births: [], estates: [], documents: [], consents: [], passkeys: [], sessions: [], audit: [], processed: [],
    policy: { threshold: 0, autoBirth: false, maxAgents: 2, dailyHour: 8, email: "", riskLimit: 0, missionLimit: 0 },
    live: { fetchedAt: "2026-10-04T12:00:00Z", wealth: { cash: 1_248_200, ownerContributed: 1_000_000, ownerWithdrawn: 0, fleetGenerated: 0 }, flows24h: null, replication: null,
      mail: "NOT_CONFIGURED", sms: "NOT_CONFIGURED", recordedNeeds: 0, storage: null, health: null, adminEmail: null, unavailable: [], ...over } });

  it("the Treasury banner shows the authoritative Treasury cash; an unknown figure reads — and no other amount is substituted", () => {
    const b = treasuryBannerFrom(live(), null);
    expect(b.cash).toBe("£12,482.00"); expect(b.cashMinor).toBe(1_248_200);
    const unknown = treasuryBannerFrom(live({ wealth: null }), null);
    expect(unknown.cash).toBe("—"); expect(unknown.cashMinor).toBeNull();
    expect(JSON.stringify(unknown)).not.toContain("7,777.77"); // the snapshot's fallback figure is never shown as Treasury cash
    // Breakdowns the gateway does not supply read —, never estimated.
    expect(Object.fromEntries(unknown.secondary)).toMatchObject({ "Restricted / tax": "—", "Operating pool": "—", "Committed (envelopes)": "—" });
    expect(Object.fromEntries(b.secondary)).toMatchObject({ "Owner funding": "£10,000.00", "Fleet-generated profit": "£0.00" });
    // The status screens follow the same rule.
    expect(hqDataFrom(live({ wealth: null }), null, []).treasury![0]).toEqual(["Treasury cash", "—"]);
  });

  it("department boards list only real items; an empty source says it is empty", () => {
    const f = live(), boards = hqBoardsFrom(f, emptyCommandView("live"), []);
    expect(boards["opportunity:board"]!.rows).toEqual([]);
    expect(boards["opportunity:board"]!.empty).toMatch(/No opportunities/);
    expect(boards["security:board"]!.rows).toEqual([]);
    const withData = hqBoardsFrom({ ...f, notices: [{ id: "n1", level: "RED", title: "Runtime check failed", time: "now", acknowledged: false } as unknown as Fleet["notices"][number]] },
      { ...emptyCommandView("live"), opportunities: [{ key: "op-1", offer: "Data cleaning service", status: "shortlisted", agentId: "A1" }] }, []);
    expect(withData["opportunity:board"]!.rows[0][0]).toContain("Data cleaning service");
    expect(withData["security:board"]!.rows[0]).toEqual(["Runtime check failed", "RED", "bad"]);
    // Every board placed in the building has a source.
    for (const s of buildWorld().screens.filter((x) => x.kind === "board")) expect(boards[s.board!], s.id).toBeDefined();
  });

  it("a real Fleet event becomes a packet routed through the building's conduits (never through walls)", () => {
    const e = { key: "k1", type: "knowledge_recorded", agentId: "A1", at: "2026-10-04T12:00:00Z", detail: {} } as FleetEvent;
    const v = visualFromEvent(e)!;
    const pk = packetFor(v, new Map([["A1", { x: 0, z: -4 }]]), 1000)!;
    const route = routeThrough(pk.points);
    expect(route[0]).toEqual(pk.points[0]); expect(route[route.length - 1]).toEqual(pk.points[pk.points.length - 1]);
    // Between rooms the path runs along axis-aligned conduit segments.
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1], b = route[i];
      if (roomAt(a) && roomAt(b) && roomAt(a)!.id === roomAt(b)!.id) continue;
      expect(Math.abs(a.x - b.x) < 1e-6 || Math.abs(a.z - b.z) < 1e-6, `${JSON.stringify(a)}→${JSON.stringify(b)}`).toBe(true);
    }
    expect(flowLabel(pk)).toBe("KNOWLEDGE RECORDED");
    // Treasury → Library goes out of the Treasury's front opening and in through the Library's.
    const t2l = routeThrough([{ x: -18, z: -17 }, { x: 0, z: 11 }]);
    expect(t2l).toContainEqual({ x: -18, z: -12 }); expect(t2l).toContainEqual({ x: 0, z: 16 });
  });

  const mkT = (over: Partial<Transport> & { id: string }): Transport => {
    const route = routeThrough([{ x: -18, z: -17 }, { x: 0, z: 11 }]);
    return { route, eventAt: 0, start: 0, travel: 4000, category: "information", colour: CATEGORY_COLOUR.information, priority: 5, importance: "low", label: "KNOWLEDGE RECORDED", agentId: "A1", counterpartId: null, sourceAgentId: "A1", ...over };
  };

  it("no event, no traffic; Reduce Motion removes travel but keeps the information (source, route, destination, direction, label)", () => {
    const empty = transportFrame([], 5000, "full");
    for (const v of Object.values(empty)) expect(v).toEqual([]);
    expect(advance(newSchedule(), [], 0, 6).active).toEqual([]); // the scheduler never invents traffic
    const t = mkT({ id: "f1" }), route = t.route, dst = route[route.length - 1];
    const moving = transportFrame([t], PHASE.activate + PHASE.launch + 1000, "full");
    expect(moving.orbs).toHaveLength(1); expect(moving.labels[0].text).toBe("KNOWLEDGE RECORDED");
    const still = transportFrame([t], PHASE.activate + PHASE.launch + 1000, "reduced");
    expect(still.orbs).toEqual([]);
    expect(still.sources).toHaveLength(1); expect(still.routes).toEqual([{ id: "f1", lit: 1, glow: 0.8 }]); expect(still.receivers).toHaveLength(1);
    expect(still.chevrons.length).toBeGreaterThan(3);
    expect(still.labels).toEqual([{ id: "f1", text: "KNOWLEDGE RECORDED", p: dst, y: 2.6 }]);
    // Data Flow off: no route, orb or chevrons — the label and the destination's acknowledgement remain.
    const off = transportFrame([t], 1000, "off");
    expect(off.orbs).toEqual([]); expect(off.routes).toEqual([]); expect(off.chevrons).toEqual([]);
    expect(off.labels[0]).toMatchObject({ text: "KNOWLEDGE RECORDED", p: dst }); expect(off.receivers).toHaveLength(1);
    expect(transportFrame([t], totalTime(t) + 1, "full").orbs).toEqual([]); // over: nothing lingers
  });

  it("the transport phases: activate → launch → travel → arrive → respond → settle; the destination responds only after arrival", () => {
    const t = mkT({ id: "f1", counterpartId: "B2" }), route = t.route, src = route[0], dst = route[route.length - 1];
    const seq: string[] = [];
    let respondedBeforeArrival = false, arrived = false;
    for (let now = 0; now <= totalTime(t) + 50; now += 25) {
      const { phase } = phaseAt(t, now); if (seq[seq.length - 1] !== phase) seq.push(phase);
      const f = transportFrame([t], now, "full");
      if (f.receivers.some((r) => r.phase === "arrive")) arrived = true;
      if (f.responding.length && !arrived) respondedBeforeArrival = true;
    }
    expect(seq).toEqual(["activate", "launch", "travel", "arrive", "respond", "settle", "done"]);
    expect(respondedBeforeArrival).toBe(false);
    const act = transportFrame([t], 100, "full");
    expect(act.sources[0].p).toEqual(src); expect(act.orbs).toEqual([]); expect(act.activating).toEqual([{ id: "f1", agentId: "A1", done: false }]);
    // Illumination propagates with the orb; corners already passed pulse.
    const at = (k: number) => PHASE.activate + PHASE.launch + t.travel * k;
    expect(transportFrame([t], at(0.6), "full").routes[0].lit).toBeCloseTo(0.6, 5);
    expect(Array.from({ length: 40 }, (_, i) => transportFrame([t], at(i / 40), "full").junctions.length).some((n) => n > 0)).toBe(true);
    const resp = transportFrame([t], at(1) + PHASE.arrive + 100, "full");
    expect(resp.responding).toEqual([{ id: "f1", room: roomAt(dst)!.id, agentId: "B2" }]);
    expect(resp.receivers[0]).toMatchObject({ p: dst, phase: "respond" });
  });

  it("semantic colour: money is gold, opportunity violet, information cyan, realised revenue green, red only for real alerts", () => {
    const P = (kind: string, label = "x") => ({ kind, label, points: [] }) as never;
    expect(categoryOf(P("TREASURY_TRANSFER", "Profit contribution to the Treasury"))).toBe("money");
    expect(CATEGORY_COLOUR.money).toBe("#fbbf24");
    expect(categoryOf(P("PROJECT_EVENT", "Profit distribution"))).toBe("money");
    expect(categoryOf(P("OPPORTUNITY_EVENT"))).toBe("opportunity");
    expect(categoryOf(P("RESEARCH_EVENT"))).toBe("information");
    expect(categoryOf(P("REVENUE_EVENT"))).toBe("outcome");
    expect(categoryOf(P("SYSTEM_ALERT"))).toBe("alert");
    for (const k of ["RESEARCH_EVENT", "OPPORTUNITY_EVENT", "REVENUE_EVENT", "TREASURY_TRANSFER", "PROJECT_EVENT", "MISSION_STARTED", "COMMS_EVENT"]) expect(categoryOf(P(k)), k).not.toBe("alert");
    // Presentation priority: alert > money > project > outcome > opportunity/research > status.
    expect([P("SYSTEM_ALERT"), P("TREASURY_TRANSFER"), P("PROJECT_EVENT", "Task delivered"), P("REVENUE_EVENT"), P("OPPORTUNITY_EVENT"), P("MISSION_STARTED")].map(priorityOf)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(importanceOf(P("TREASURY_TRANSFER", "Profit contribution to the Treasury"))).toBe("high");
    expect(importanceOf(P("PROJECT_EVENT", "Team offer"))).toBe("medium");
    expect(importanceOf(P("MISSION_STARTED"))).toBe("low");
    // A real sweep packet becomes a gold TREASURY SWEEP transport ending at the Treasury.
    const e = { key: "s1", type: "treasury_sweep", agentId: "A1", at: "2026-10-04T12:00:00Z", detail: {} } as FleetEvent;
    const pk = packetFor(visualFromEvent(e)!, new Map([["A1", { x: 0, z: -4 }]]), 1000)!;
    const tr = toTransport(pk, 0);
    expect(tr.label).toBe("TREASURY SWEEP"); expect(tr.colour).toBe(CATEGORY_COLOUR.money); expect(tr.importance).toBe("high");
    expect(roomAt(tr.route[tr.route.length - 1])?.id).toBe("treasury"); expect(tr.sourceAgentId).toBe("A1");
    // Skins are presentation adapters only: the default is the tube orb; a registered skin is selectable; unknown ids fall back.
    expect(transportSkin(undefined).id).toBe("tube-orb");
    expect(transportSkin("no-such-skin").id).toBe("tube-orb");
    registerTransportSkin({ ...transportSkin("tube-orb"), id: "test-skin", name: "Test" });
    expect(transportSkin("test-skin").id).toBe("test-skin");
  });

  it("the visual scheduler is bounded and deterministic: most important first, then oldest, then id — never more than the slots", () => {
    const burst = (seed: number) => Array.from({ length: 120 }, (_, i) => { const j = (i * 37 + seed) % 120; return mkT({ id: `t${j}`, priority: 1 + (j % 6), eventAt: j }); });
    const run = (seed: number) => { const s = newSchedule(); advance(s, burst(seed), 0, 6); return s; };
    const a = run(0), b = run(55);
    expect(a.active.map((t) => t.id)).toEqual(b.active.map((t) => t.id)); // arrival order does not matter
    expect(a.queue.map((t) => t.id)).toEqual(b.queue.map((t) => t.id));
    expect(a.active).toHaveLength(6); expect(a.queue.length).toBeLessThanOrEqual(QUEUE_CAP); expect(a.dropped).toBe(120 - 6 - QUEUE_CAP);
    expect(a.active.every((t) => t.priority === 1)).toBe(true); // critical alerts are shown first
    // Duplicates are ignored; finished transports free their slot; the queue drains in order.
    advance(a, burst(3), 10, 6); expect(a.queue.length).toBeLessThanOrEqual(QUEUE_CAP); expect(a.active).toHaveLength(6);
    const firstWaiting = a.queue[0].id;
    advance(a, [], totalTime(a.active[0]) + 20, 6);
    expect(a.active.map((t) => t.id)).toContain(firstWaiting);
    for (let i = 0; i < 200; i++) advance(a, [], 1e6 * (i + 1), 6);
    expect(a.active).toEqual([]); expect(a.queue).toEqual([]);
    // A late event (its turn comes long after it happened, e.g. a backlog after a reload) is not animated; it stays in the feed.
    const late = newSchedule(); advance(late, [mkT({ id: "old", eventAt: 0 }), mkT({ id: "new", eventAt: 100_000 })], 100_000, 6);
    expect(late.active.map((t) => t.id)).toEqual(["new"]); expect(late.dropped).toBe(1); expect(100_000).toBeGreaterThan(STALE_MS);
    expect(slotsFor(0, false)).toBeLessThan(slotsFor(2, false)); expect(slotsFor(2, true)).toBeLessThanOrEqual(4);
  });

  it("the event camera is opt-in, high-importance first, never while an agent is selected, and any interaction cancels it", () => {
    const hi = mkT({ id: "h", importance: "high", start: 10_000 }), med = mkT({ id: "m", importance: "medium", start: 10_000 }), lo = mkT({ id: "l", importance: "low", start: 10_000 });
    const ctx = { focusLevel: "fleet" as const, reduceMotion: false };
    const off: DirectorState = { enabled: false, shot: null, lastInteraction: 0 };
    expect(wantShot(off, hi, 10_000, ctx)).toBe(false); // off by default: manual camera is primary
    const on: DirectorState = { ...off, enabled: true };
    expect(wantShot(on, lo, 10_000, ctx)).toBe(false);
    expect(wantShot(on, hi, 10_000, ctx)).toBe(true);
    expect(wantShot(on, hi, 10_000, { ...ctx, focusLevel: "agent" })).toBe(false); // the selected agent keeps the camera
    expect(wantShot(on, hi, 10_000, { ...ctx, reduceMotion: true })).toBe(false);
    expect(wantShot({ ...on, lastInteraction: 9_000 }, hi, 10_000, ctx)).toBe(false); // the user just moved the camera
    expect(10_000 - 9_000).toBeLessThan(IDLE_BEFORE_SHOT_MS);
    const showingMed = takeShot(on, med);
    expect(wantShot(showingMed, lo, 10_100, ctx)).toBe(false);
    expect(wantShot(showingMed, hi, 10_100, ctx)).toBe(true); // a high event may replace a medium shot
    expect(wantShot(takeShot(on, hi), med, 10_100, ctx)).toBe(false);
    const shooting = takeShot(on, hi);
    expect(shotGoal(shooting, 10_100)!.look).toMatchObject({ x: hi.route[0].x, z: hi.route[0].z }); // source first
    const dst = hi.route[hi.route.length - 1];
    expect(shotGoal(shooting, 10_000 + PHASE.activate + PHASE.launch + hi.travel + 100)!.look).toMatchObject({ x: dst.x, z: dst.z }); // then the destination
    const cancelled = interact(shooting, 10_200);
    expect(cancelled.shot).toBeNull(); expect(shotGoal(cancelled, 10_300)).toBeNull();
    expect(wantShot(cancelled, hi, 10_300, ctx)).toBe(false);
  });

  it("agents walk through the building: around furniture and walls, through doorways, ending in the right room", () => {
    const w = buildWorld(), DEP = Object.fromEntries(DEPARTMENTS.map((d) => [d.id, d]));
    // 50 workstations on the Agent Floor are obstacles too.
    const stations = new Map(Array.from({ length: 50 }, (_, i) => [`A${String(i).padStart(2, "0")}`, stationPoint(i)] as const));
    const nav = navGrid([...w.footprints, ...stationDesks(stations)], NAV_BOUNDS);
    const solid = [...w.footprints, ...stationDesks(stations)];
    const inside = (p: { x: number; z: number }, f: { x0: number; z0: number; x1: number; z1: number }) => p.x > f.x0 + 0.02 && p.x < f.x1 - 0.02 && p.z > f.z0 + 0.02 && p.z < f.z1 - 0.02;
    const all = DEPARTMENTS.flatMap((d) => w.spots[d.id].map((s) => ({ ...s, dep: d.id })));
    expect(all.length).toBeGreaterThan(40);
    const starts = [...all, ...[...stations.values()].slice(0, 12).map((p) => ({ ...p, dep: "floor" as const }))];
    for (let n = 0; n < starts.length; n++) {
      const a = starts[n], b = all[(n * 7 + 3) % all.length];
      const path = findPath(nav, a, b);
      expect(path, `${a.dep}→${b.dep}`).not.toBeNull();
      const pts = [a, ...path!];
      expect(pts[pts.length - 1]).toEqual({ x: b.x, z: b.z });
      expect(roomAt(pts[pts.length - 1])?.id).toBe(b.dep); // ends in the department its state puts it in
      // Between the first step out of the seat and the last step into the destination seat, every point of every
      // segment is walkable floor: never through a wall, a desk, a console or a rack.
      for (let i = 2; i < pts.length - 1; i++) {
        expect(lineClear(nav, pts[i - 1], pts[i]), `${a.dep}→${b.dep} segment ${i}`).toBe(true);
        for (let k = 0; k <= 10; k++) {
          const q = { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * k / 10, z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * k / 10 };
          const hit = solid.find((f) => inside(q, f));
          expect(hit, `${a.dep}→${b.dep} crosses an obstacle at ${q.x.toFixed(2)},${q.z.toFixed(2)}`).toBeUndefined();
        }
      }
      // Leaving or entering a room happens through its openings (front cutaway or the side doors), not through walls.
      for (let i = 1; i < pts.length; i++) {
        const ra = roomAt(pts[i - 1])?.id, rb = roomAt(pts[i])?.id;
        if (ra === rb) continue;
        const d = DEP[(ra ?? rb)!], m = { x: (pts[i - 1].x + pts[i].x) / 2, z: (pts[i - 1].z + pts[i].z) / 2 };
        const front = Math.abs(m.z - (d.z + d.d / 2)) < 1.2 && Math.abs(m.x - d.x) < 1.6, side = Math.abs(Math.abs(m.x - d.x) - d.w / 2) < 1.2 && Math.abs(m.z - d.z) < 1.2;
        expect(front || side || walkable(nav, m), `${a.dep}→${b.dep} leaves ${ra ?? "corridor"} → ${rb ?? "corridor"} at ${m.x.toFixed(1)},${m.z.toFixed(1)}`).toBe(true);
      }
    }
    // Every department has a physical intake inside it, at the end of its room conduit (straight in from the opening).
    for (const d of DEPARTMENTS) { expect(roomAt(INTAKE[d.id])?.id, d.id).toBe(d.id); expect(INTAKE[d.id].x).toBe(d.x); }
    // Walls block: the straight line from the Treasury into the Library is not walkable; the path is longer than it.
    const t = all.find((s) => s.dep === "treasury")!, l = all.find((s) => s.dep === "library")!;
    expect(lineClear(nav, t, l)).toBe(false);
  });

  it("choreography: work animations only for real work; idle agents never mime work; reactions follow the agent's own events", () => {
    const base: ActivityContext = { status: "active", basis: "event", department: "library", moving: false, fast: false, rising: false, atStation: false, atSpot: true, spotPose: "seat", meeting: false, team: false, seed: 7, t: 0 };
    const WORK = new Set(["seated", "seatedRead", "terminal", "reading", "inspect", "meetSeat", "meetStand", "pointing", "observe"]);
    // Idle (no mission, no recent event, no project): never a working animation, at any time, anywhere.
    for (let t = 0; t < 400; t += 3) for (const at of [{ atStation: true, atSpot: false }, { atSpot: true, spotPose: "seat" as const }, { atSpot: true, spotPose: "stand" as const }, { atSpot: false, department: "venture" }]) {
      for (const status of ["active", "held", "provisioning"]) {
        const a = chooseActivity({ ...base, ...at, basis: status === "active" ? "default" : (status as "held"), status, t });
        expect(WORK.has(a), `${status} ${JSON.stringify(at)} → ${a}`).toBe(false);
      }
    }
    expect(isWorking("active", "default")).toBe(false); expect(isWorking("active", "mission")).toBe(true); expect(isWorking("held", "event")).toBe(false);
    // Working: typing and reading at a desk, operating / reading / inspecting at a console, meeting at a team table.
    const seen = new Set(Array.from({ length: 200 }, (_, t) => chooseActivity({ ...base, t: t * 3 })));
    expect(seen).toEqual(new Set(["seated", "seatedRead"]));
    const consoleSeen = new Set(Array.from({ length: 200 }, (_, t) => chooseActivity({ ...base, spotPose: "stand", t: t * 3 })));
    expect(consoleSeen).toEqual(new Set(["terminal", "reading", "inspect"]));
    expect(chooseActivity({ ...base, meeting: true })).toBe("meetSeat");
    expect(new Set(Array.from({ length: 200 }, (_, t) => chooseActivity({ ...base, meeting: true, spotPose: "stand", t: t * 3 })))).toEqual(new Set(["meetStand", "pointing"]));
    // A team-project member works even without a recent event of its own.
    expect(chooseActivity({ ...base, basis: "default", team: true, t: 0 })).not.toBe("seatedIdle");
    // Moving and standing up take precedence; the dead lie still.
    expect(chooseActivity({ ...base, moving: true })).toBe("walk"); expect(chooseActivity({ ...base, moving: true, fast: true })).toBe("fastWalk");
    expect(chooseActivity({ ...base, rising: true })).toBe("rise"); expect(chooseActivity({ ...base, status: "dead", moving: true })).toBe("dead");
    // Reactions: only within their window, most recent wins; nothing without an event.
    expect(reactionAt(10_000, {})).toBeNull();
    expect(reactionAt(10_000, { send: 9_500 })).toMatchObject({ kind: "confirm" });
    expect(reactionAt(10_000, { send: 9_000, receive: 9_800 })).toMatchObject({ kind: "receive" });
    expect(reactionAt(10_000, { done: 9_000 })).toMatchObject({ kind: "complete" });
    expect(reactionAt(10_000, { send: 1_000 })).toBeNull();
    // Giving way: someone dead ahead pushes the walker to its right and slows it; nobody near, no change.
    const gw = giveWay("me", { x: 0, z: 0 }, { x: 0, z: 1 }, new Map([["me", { x: 0, z: 0 }], ["you", { x: 0, z: 0.4 }]]));
    expect(Math.hypot(gw.push.x, gw.push.z)).toBeGreaterThan(0); expect(gw.slow).toBeLessThan(1);
    const both = giveWay("you", { x: 0, z: 0.4 }, { x: 0, z: -1 }, new Map([["me", { x: 0, z: 0 }]]));
    expect(Math.sign(gw.push.x)).toBe(-Math.sign(both.push.x)); // head-on: they sidestep in opposite world directions (each to its right)
    expect(giveWay("me", { x: 0, z: 0 }, { x: 0, z: 1 }, new Map([["you", { x: 3, z: 3 }]]))).toEqual({ push: { x: 0, z: 0 }, slow: 1 });
  });

  it("team members in different rooms: a delivery travels from one agent to the other through the building", () => {
    const e = { key: "d1", type: "project_task_delivered", agentId: "A1", at: "2026-10-04T12:00:00Z", detail: { fromAgentId: "A1", toAgentId: "B2" } } as FleetEvent;
    const a1 = { x: -18, z: 11 }, b2 = { x: 18, z: 11 }; // Marketing and Venture / Dev
    const pk = packetFor(visualFromEvent(e)!, new Map([["A1", a1], ["B2", b2]]), 0)!;
    const tr = toTransport(pk, 0);
    expect(tr.route[0]).toEqual(a1); expect(tr.route[tr.route.length - 1]).toEqual(b2);
    expect(tr.sourceAgentId).toBe("A1"); expect(tr.counterpartId).toBe("B2"); expect(tr.label).toBe("TASK DELIVERED");
    expect(roomAt(tr.route[0])?.id).toBe("marketing"); expect(roomAt(tr.route[tr.route.length - 1])?.id).toBe("venture");
    // The sender's terminal completes as it launches; the receiver reacts after arrival.
    expect(transportFrame([tr], 100, "full").activating).toEqual([{ id: tr.id, agentId: "A1", done: true }]);
    const resp = transportFrame([tr], PHASE.activate + PHASE.launch + tr.travel + PHASE.arrive + 50, "full");
    expect(resp.responding[0]).toMatchObject({ agentId: "B2", room: "venture" });
  });

  it("Agent View keeps the selected agent unobstructed: another person in the preferred view moves the camera, never behind a wall", () => {
    const p = { x: 18, z: 12 }, yaw = Math.PI; // facing north in Venture / Dev
    const free = frameAgent("me", p, yaw, false, new Map([["me", p]]));
    expect(free.ghosts).toEqual([]);
    // Put someone exactly between that camera and the agent.
    const mid = { x: (free.cam.x + p.x) / 2, z: (free.cam.z + p.z) / 2 };
    const f = frameAgent("me", p, yaw, false, new Map([["me", p], ["other", mid]]));
    expect(blockers({ x: f.cam.x, z: f.cam.z }, p, new Map([["other", mid]]), "me")).toEqual([]);
    expect(viewable({ x: f.cam.x, z: f.cam.z }, p)).toBe(true);
    // Surrounded on every side: the camera still frames the agent, and those in the way are faded.
    const ring = new Map<string, { x: number; z: number }>([["me", p]]);
    for (let i = 0; i < 24; i++) ring.set(`r${i}`, { x: p.x + Math.sin(i / 24 * Math.PI * 2) * 1.2, z: p.z + Math.cos(i / 24 * Math.PI * 2) * 1.2 });
    const boxed = frameAgent("me", p, yaw, false, ring);
    expect(boxed.ghosts.length).toBeGreaterThan(0);
    expect(boxed.ghosts).not.toContain("me");
  });

  it("agents take work spots inside the room their state puts them in (the room never changes); the dead and workstation agents keep theirs", () => {
    const plan = buildWorld();
    for (const d of DEPARTMENTS) if (d.id !== "floor") expect(plan.spots[d.id].length, d.id).toBeGreaterThanOrEqual(2);
    const ag = (id: string, status = "active") => ({ agent: { id, status } } as unknown as Parameters<typeof workTargets>[0][number]);
    const models = [ag("a"), ag("b"), ag("c", "dead"), ag("d")];
    const targets = new Map([["a", { x: 18, z: 11 }], ["b", { x: 18, z: 12 }], ["c", { x: 0, z: 24 }], ["d", { x: 1, z: -4 }]]);
    const stations = new Map([["d", { x: 1, z: -4 }]]);
    const w = workTargets(models, targets, stations, plan.spots);
    for (const id of ["a", "b"]) { expect(roomAt(w.targets.get(id)!)!.id).toBe("venture"); expect(w.spots.get(id)).toBeDefined(); }
    expect(w.targets.get("a")).not.toEqual(w.targets.get("b"));
    expect(w.targets.get("c")).toEqual({ x: 0, z: 24 }); expect(w.targets.get("d")).toEqual({ x: 1, z: -4 });
    expect(workTargets(models, targets, stations, plan.spots).targets).toEqual(w.targets); // stable
    // Team projects: teammates in the same room meet at its table; an agent on no team is not seated there while its own
    // desk or console is free (no implied collaboration).
    const team = [ag("lead"), ag("member"), ag("solo")];
    const inVenture = new Map(team.map((m, i) => [m.agent.id, { x: 18 + i * 0.1, z: 11 }]));
    const t2 = workTargets(team, inVenture, new Map(), plan.spots, new Map([["lead", "P1"], ["member", "P1"]]));
    expect(t2.spots.get("lead")!.table).toBe(true); expect(t2.spots.get("member")!.table).toBe(true);
    expect([...t2.meetings].sort()).toEqual(["lead", "member"]);
    expect(t2.spots.get("solo")!.table).toBeFalsy();
    // A lone team member (teammate elsewhere) has no meeting.
    const t3 = workTargets(team, inVenture, new Map(), plan.spots, new Map([["lead", "P1"]]));
    expect(t3.meetings.size).toBe(0);
  });

  it("team projects: a two-agent project event travels between the two agents; project activity places agents in Venture / Dev", () => {
    const e = { key: "p1", type: "project_task_delivered", agentId: "B", at: "2026-10-04T12:00:00Z", detail: { projectId: "P1", fromAgentId: "B", toAgentId: "A", name: "Client portal" } } as FleetEvent;
    const v = visualFromEvent(e)!;
    expect(v).toMatchObject({ kind: "PROJECT_EVENT", path: ["agent", "counterpart"], counterpartId: "A", label: "Task delivered" });
    const pk = packetFor(v, new Map([["A", { x: 17, z: 12 }], ["B", { x: -18, z: 11 }]]), 0)!;
    expect(pk.points).toEqual([{ x: -18, z: 11 }, { x: 17, z: 12 }]);
    expect(flowLabel(pk)).toBe("TASK DELIVERED");
    // Without a recorded counterpart nothing is invented: the project's own record (Venture / Dev).
    expect(visualFromEvent({ ...e, key: "p2", type: "project_created", detail: { projectId: "P1" } })!.path).toEqual(["agent", "venture"]);
    expect(eventDepartment("project_member_joined")).toBe("venture");
  });

  it("project views show the record's own figures: working-day ETAs, exact compensation, who is actively collaborating", () => {
    expect(hours(52)).toBe("6.5 days"); expect(hours(16)).toBe("16 h"); expect(hours(undefined)).toBe("—");
    // Shares are of the POST-SWEEP distributable profit, exactly as negotiated (no default ratio is ever shown or assumed).
    expect(compensationText({ type: "HYBRID", fixedMinor: 500, profitShareBp: 1000, profitShareCapMinor: 2000 })).toBe("hybrid — £5.00 fixed + 10 % of post-sweep distributable profit (cap £20.00)");
    expect(compensationText({ type: "PROFIT_SHARE", profitShareBp: 3000 })).toBe("profit share — 30 % of post-sweep distributable profit");
    expect(compensationText({ type: "PROFIT_SHARE", revenueShareBp: 2500 })).toBe("profit share — 25 % of post-sweep distributable profit"); // read alias
    expect(compensationText({ type: "FIXED", fixedMinor: 1000 })).not.toMatch(/%/);
    expect(compensationText(null)).toBe("—");
    const view = { ...emptyCommandView("live"), projects: [
      { projectId: "P1", status: "active", leadAgentId: "A", members: [{ agentId: "B", status: "accepted" }, { agentId: "C", status: "declined" }] },
      { projectId: "P2", status: "planning", leadAgentId: "D", members: [{ agentId: "E", status: "accepted" }] },
    ] };
    expect([...activeTeams(view)]).toEqual([["A", "P1"], ["B", "P1"]]); // only active projects, only accepted members
    expect(projectsOf(view, "C").map((p) => p.projectId)).toEqual(["P1"]); // the declined offer is still part of its history
    expect(hqBoardsFrom(live(), view, [])["venture:projects"]!.rows[0][0]).toContain("+1");
  });

  it("characters are skin-ready and cosmetics are visual identity only (no economic, permission or state field)", () => {
    const a = appearanceOf("agent-1");
    expect(Object.keys(a).sort()).toEqual([...COSMETIC_SLOTS].sort());
    expect(a).toEqual(appearanceOf("agent-1")); // deterministic from identity
    expect(a.face).toBe("portrait"); expect(a.hair).toBe(traitsOf("agent-1").hair);
    registerCosmetic({ id: "test-raw-operator", name: "Raw operator (test)", overrides: { armour: "plateCarrier", headgear: "headset" } });
    expect(appearanceOf("agent-1", ["test-raw-operator"])).toMatchObject({ armour: "plateCarrier", headgear: "headset", hair: a.hair });
    expect(() => registerCosmetic({ id: "bad", name: "bad", overrides: { capital: 1 } as never })).toThrow(/unknown cosmetic slot/);
    // The module cannot reach economics, permissions or Fleet state: it imports only the identity seed helpers.
    const src = fs.readFileSync(path.resolve(__dirname, "../../../codex-dashboard/src/dashboard/virtual/hq/appearance.ts"), "utf8");
    expect([...src.matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1])).toEqual(["../../command/portrait"]);
  });

  it("agents walk through the building (out of a room's opening, along corridors), not through walls", () => {
    const path2 = routeThrough([{ x: 18, z: 12 }, { x: -18, z: -17 }]); // Venture → Treasury
    expect(path2).toContainEqual({ x: 18, z: 16 }); expect(path2).toContainEqual({ x: -18, z: -12 }); // exits and enters by the openings
    for (let i = 1; i < path2.length; i++) { const a = path2[i - 1], b = path2[i]; const ra = roomAt(a), rb = roomAt(b); if (ra && rb && ra.id === rb.id) continue; expect(Math.abs(a.x - b.x) < 1e-6 || Math.abs(a.z - b.z) < 1e-6).toBe(true); }
  });

  it("Ultra is materially richer than High while the world and its data stay the same", () => {
    const hi = HQ_PROFILE.high, ul = HQ_PROFILE.ultra;
    const richer = [ul.physical && !hi.physical, ul.reflections && !hi.reflections, ul.atmosphere && !hi.atmosphere, ul.detail > hi.detail, ul.shadowMap > hi.shadowMap, ul.textures > hi.textures, ul.particles > hi.particles];
    expect(richer.filter(Boolean).length).toBeGreaterThanOrEqual(6);
    const a = buildWorld(), b = buildWorld();
    expect(a.screens).toEqual(b.screens); expect(a.spots).toEqual(b.spots);
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
    expect(p.points[0]).toEqual(INTAKE.command); // a department's information leaves from its intake (the live core in Fleet Command)
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
    expect(t.get("C")).toMatchObject({ ...stationPoint(2), department: "floor" }); // on the Floor: at its own station
    expect(t.get("A")!.department).toBe("library");
    const born = agentTargetsWithStations(models, new Map([["A", now - BIRTH_POWER_MS - 10]]), now, false);
    expect(born.get("A")).toMatchObject({ ...stationPoint(0), department: "floor" }); // entering: its station first
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

"use client";
/**
 * The Virtual Command Centre — the animated second view of the SAME Fleet the Formal dashboard administers. Loaded
 * lazily (its own chunk; the 3D scene is a further chunk), so the Formal dashboard never pays for it.
 *
 * Rule: if something meaningful moves here, something real happened. Agents move only when their authoritative state
 * or their latest recorded event changes (departments.ts); packets travel only for new FleetController events or for
 * changes between two authoritative readings (events.ts). Ambient effects (lights, the core's rings, dust) carry no
 * meaning and can be switched off. Panels show the shared Fleet Command components; actions use the deck's controls.
 */
import { Component, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Fleet } from "../model";
import { button, input } from "../ui";
import type { AgentModel } from "../command/agents";
import { DEPARTMENT, DEPARTMENTS, type DepartmentId } from "../command/departments";
import { diffReadings, visualFromEvent, type AgentReading, type VisualEvent } from "../command/events";
import type { Control } from "../command/FleetCommandPage";
import { defaultPrefs, deviceClass, loadPrefs, QUALITIES, readDeviceHints, savePrefs, type DeviceHints, type Quality, type VirtualPrefs } from "../command/prefs";
import type { FeedState } from "../command/useFleetCommand";
import type { CommandView, Row } from "../command/view";
import { AgentPanel, DepartmentPanel } from "./VirtualPanels";
import { utc } from "../command/panels";
import { VirtualMap, type Focus } from "./VirtualMap";
import { agentTargetsWithStations, birthState, BIRTH_ENTER_MS, BIRTH_EVENTS, BIRTH_FUNDING_EVENTS, BIRTH_MARK_MS, BIRTH_POWER_MS, livePackets, packetFor, stationIndex, stationPoint, type Packet, type Point } from "./world";
import { AgentLabels, type Projector } from "./AgentLabels";

const Scene3D = lazy(() => import("./VirtualScene3D"));
/** On first opening, events this recent still animate ("current events begin animating"); older ones are history. */
const FRESH_MS = 90_000;
const TICKER = 6;

class SceneBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onError(); }
  render() { return this.state.failed ? null : this.props.children; }
}

export default function VirtualCommandCentre({ fleet, view, models, feed, live, control, go, focusAgent, loadLedger }: {
  fleet: Fleet; view: CommandView | null; models: AgentModel[]; feed: FeedState; live: boolean; control: Control; go: (page: string, id?: string) => void;
  loadLedger?: (agentId: string) => Promise<Row[]>;
  /** Open focused on this agent (e.g. #Virtual/<agent id>). */
  focusAgent?: string;
}) {
  const [hints, setHints] = useState<DeviceHints | null>(null);
  const [prefs, setPrefsState] = useState<VirtualPrefs | null>(null);
  const [focus, setFocus] = useState<Focus>(focusAgent ? { level: "agent", id: focusAgent } : { level: "fleet" });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [webglFailed, setWebglFailed] = useState(false);
  const [packets, setPackets] = useState<Packet[]>([]);
  const [ticker, setTicker] = useState<VisualEvent[]>([]);
  const seen = useRef<Set<string> | null>(null);
  // Shared with the label layer: the renderer's animated positions and its world → screen projection.
  const positions = useRef(new Map<string, Point>());
  const project = useRef<Projector | null>(null);
  const readings = useRef<AgentReading[] | null>(null);
  // Births (presentation only): agent id → when it came into being, from an authoritative new reading or birth event.
  const [births, setBirths] = useState<Map<string, number>>(() => new Map());
  const [clock, setClock] = useState(() => Date.now());

  useEffect(() => {
    const t = setTimeout(() => { const h = readDeviceHints(); setHints(h); setPrefsState(loadPrefs(defaultPrefs(h))); }, 0);
    return () => clearTimeout(t);
  }, []);
  const setPrefs = useCallback((p: VirtualPrefs) => { setPrefsState(p); savePrefs(p); }, []);

  const reduce = prefs?.reduceMotion ?? false;
  const targets = useMemo(() => agentTargetsWithStations(models, births, clock, reduce), [models, births, clock, reduce]);
  const stations = useMemo(() => { const idx = stationIndex(models); return new Map([...idx].map(([id, i]) => [id, stationPoint(i, idx.size)])); }, [models]);
  const birthStates = useMemo(() => new Map(models.map((m) => [m.agent.id, birthState(births.get(m.agent.id), clock, reduce)])), [models, births, clock, reduce]);
  const hidden = useMemo(() => new Set([...birthStates].filter(([, b]) => !b.visible).map(([id]) => id)), [birthStates]);
  // While a birth sequence runs, a light clock re-evaluates phases (stops as soon as none is active).
  useEffect(() => {
    const active = () => [...births.values()].some((t) => Date.now() - t < BIRTH_POWER_MS + BIRTH_ENTER_MS + BIRTH_MARK_MS);
    if (!active()) return;
    const timer = setInterval(() => { setClock(Date.now()); if (!active()) clearInterval(timer); }, 200);
    return () => clearInterval(timer);
  }, [births]);

  const targetsRef = useRef(targets);
  useEffect(() => { targetsRef.current = targets; }, [targets]);
  const emit = useCallback((events: VisualEvent[]) => {
    const t = Date.now();
    const made = events.map((e) => packetFor(e, targetsRef.current, t)).filter((p): p is Packet => p !== null);
    if (made.length) setPackets((prev) => [...livePackets(prev, t, 120), ...made]);
    setTicker((prev) => [...[...events].reverse(), ...prev].slice(0, TICKER));
  }, []);

  const stationsRef = useRef(stations);
  useEffect(() => { stationsRef.current = stations; }, [stations]);
  /** Register births; a Genesis-capital flow is drawn only when a real funding event for that agent exists. */
  const registerBirths = useCallback((found: Array<[string, number]>, events: readonly { type: string; agentId: string | null; at: string; detail?: Record<string, unknown> }[]) => {
    if (!found.length) return;
    setBirths((prev) => {
      const next = new Map(prev);
      const flows: Packet[] = [];
      for (const [id, at] of found) {
        if (next.has(id)) continue;
        next.set(id, at);
        // Capital flows only on authoritative evidence: a funding event, or the birth event's own recorded funding.
        const funded = events.find((e) => e.agentId === id && Math.abs(Date.parse(e.at) - at) < FRESH_MS
          && (BIRTH_FUNDING_EVENTS.has(e.type) || (BIRTH_EVENTS.has(e.type) && Number(e.detail?.fundingMinor ?? 0) > 0)));
        const station = stationsRef.current.get(id);
        if (funded && station) flows.push({ id: `birth-capital:${id}`, kind: "TREASURY_TRANSFER", points: [{ x: DEPARTMENT.treasury.x, z: DEPARTMENT.treasury.z }, station],
          start: at + BIRTH_POWER_MS, duration: 2500, colour: "#fbbf24", label: "Genesis capital", agentId: id });
      }
      if (flows.length) setPackets((ps) => [...ps, ...flows]);
      return next;
    });
  }, []);

  // Real events → packets (each event once; on first open only the last FRESH_MS animate).
  const events = view?.events;
  useEffect(() => {
    if (!events) return;
    const now = Date.now();
    const first = seen.current === null;
    seen.current ??= new Set();
    const fresh: VisualEvent[] = [];
    for (const e of events) {
      if (seen.current.has(e.key)) continue;
      seen.current.add(e.key);
      if (first && now - Date.parse(e.at) > FRESH_MS) continue;
      const v = visualFromEvent(e);
      if (v) fresh.push(v);
    }
    if (seen.current.size > 2000) seen.current = new Set(events.map((e) => e.key));
    if (fresh.length) emit(fresh.reverse());
    // On first opening, agents recorded as born moments ago get their sequence from the birth event's time. Births
    // after that start when the new agent first appears in a reading (below): the moment the Command Centre learns of
    // it, not the backend timestamp, which can be a polling interval earlier.
    if (first) registerBirths(events.filter((e) => e.agentId && BIRTH_EVENTS.has(e.type) && now - Date.parse(e.at) <= FRESH_MS).map((e) => [e.agentId!, Date.parse(e.at)] as [string, number]), events);
  }, [events, emit, registerBirths]);

  // Real state changes between two readings → births, deaths, moves, wallet and health changes.
  useEffect(() => {
    const now: AgentReading[] = models.map((m) => ({ id: m.agent.id, status: m.agent.status, cash: m.agent.cash, department: m.placement.department, band: m.health.band }));
    if (readings.current) {
      const d = diffReadings(readings.current, now, new Date().toISOString());
      if (d.length) emit(d.map((v) => (v.kind === "AGENT_BORN" ? { ...v, label: "Agent born — station online", path: [] } : v)));
      // A new agent between two authoritative readings is a birth.
      registerBirths(d.filter((v) => v.kind === "AGENT_BORN" && v.agentId).map((v) => [v.agentId!, Date.now()] as [string, number]), events ?? []);
    }
    readings.current = now;
  }, [models, emit, registerBirths, events]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFocus({ level: "fleet" }); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!prefs || !hints) return <p className="text-sm text-slate-400">Preparing the Virtual Command Centre…</p>;
  const cls = deviceClass(hints);
  const use3d = !webglFailed && hints.webgl && (prefs.renderer === "3d" || (prefs.renderer === "auto" && cls !== "phone"));
  // Tablets render the scene simplified unless the Admin chose otherwise.
  const effective: VirtualPrefs = use3d && cls === "tablet" && prefs.renderer === "auto" && (prefs.quality === "high" || prefs.quality === "ultra") ? { ...prefs, quality: "medium" } : prefs;
  const selectedAgent = focus.level === "agent" ? models.find((m) => m.agent.id === focus.id) ?? null : null;
  const onRoom = (id: DepartmentId) => setFocus({ level: "department", id });
  const onAgent = (id: string) => setFocus({ level: "agent", id });
  const sceneProps = { models, targets, packets, focus, prefs: effective, selected: selectedAgent?.agent.id ?? null, onRoom, onAgent, positionsRef: positions, projectRef: project,
    stations, births, birthStates };

  return <section aria-label="Virtual Command Centre" className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-cyan-300">{live ? "FLEET HEADQUARTERS · LIVE" : "FLEET HEADQUARTERS · SIMULATION (FICTIONAL)"}
        <span className="ml-3 text-xs text-slate-400">{feed === "live" ? "Live feed" : feed === "reconnecting" ? "Feed interrupted — reconnecting; positions are the last authoritative reading" : "Connecting…"}</span></p>
      <div className="flex flex-wrap gap-2">
        <button className={button} onClick={() => setFocus({ level: "fleet" })} disabled={focus.level === "fleet"}>Fleet view</button>
        <button className={button} onClick={() => setFocus({ level: "department", id: "command" })}>Fleet Command</button>
        <button className={button} onClick={() => setFocus({ level: "department", id: "treasury" })}>Treasury</button>
        <button className={button} aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}>Display</button>
      </div>
    </div>
    {settingsOpen && <div className="grid gap-3 rounded-xl border border-slate-700 bg-slate-900 p-4 text-sm sm:grid-cols-3 lg:grid-cols-6">
      <label>View<select className={input} value={prefs.renderer} onChange={(e) => setPrefs({ ...prefs, renderer: e.target.value as VirtualPrefs["renderer"] })}>
        <option value="auto">Automatic</option><option value="3d" disabled={!hints.webgl}>3D{hints.webgl ? "" : " (WebGL unavailable)"}</option><option value="map">Map (no WebGL)</option></select></label>
      <label>Virtual quality<select className={input} value={prefs.quality} onChange={(e) => setPrefs({ ...prefs, quality: e.target.value as Quality })}>{QUALITIES.map((q) => <option key={q} value={q}>{q[0].toUpperCase() + q.slice(1)}</option>)}</select></label>
      <label>Frame rate<select className={input} value={prefs.fps} onChange={(e) => setPrefs({ ...prefs, fps: Number(e.target.value) === 30 ? 30 : 60 })}><option value={30}>30</option><option value={60}>60</option></select></label>
      {([["reduceMotion", "Reduce motion"], ["ambient", "Ambient animations"], ["dataFlow", "Data flow animations"]] as const).map(([k, l]) => <label key={k} className="flex items-center gap-2 pt-6"><input type="checkbox" checked={prefs[k]} onChange={(e) => setPrefs({ ...prefs, [k]: e.target.checked })} />{l}</label>)}
      <p className="text-xs text-slate-400 sm:col-span-3 lg:col-span-6">Display preferences are kept in this browser only and never change the Fleet.{webglFailed ? " The 3D view stopped (WebGL unavailable or lost), so the map is shown." : ""}</p>
    </div>}
    <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
      <div className="relative h-[62vh] min-h-[360px] overflow-hidden rounded-2xl border border-slate-700 bg-slate-950">
        {use3d ? <SceneBoundary onError={() => setWebglFailed(true)}><Suspense fallback={<p className="p-5 text-sm text-slate-400">Loading the 3D facility…</p>}>
          <Scene3D {...sceneProps} onLost={() => setWebglFailed(true)} /></Suspense></SceneBoundary>
          : <VirtualMap {...sceneProps} />}
        <AgentLabels models={models} positionsRef={positions} projectRef={project} prefs={effective} selected={selectedAgent?.agent.id ?? null} fleetView={focus.level === "fleet"} onAgent={onAgent} hidden={hidden} marked={birthStates} />
        <ol aria-live="polite" aria-label="Recent Fleet activity" className="pointer-events-none absolute bottom-3 left-3 z-50 max-w-[70%] space-y-1 text-xs">
          {ticker.map((v) => <li key={v.id} className="rounded bg-slate-950 px-2 py-1 text-slate-200">{utc(v.at, true).slice(11)} · {models.find((m) => m.agent.id === v.agentId)?.agent.name ?? "Fleet"} · {v.label}</li>)}
        </ol>
        <p className="pointer-events-none absolute right-3 top-3 z-50 rounded bg-slate-950/80 px-2 py-1 text-xs text-slate-400">{focus.level === "fleet" ? "Fleet view" : focus.level === "department" ? DEPARTMENT[focus.id].name : selectedAgent?.agent.name ?? "Agent"} · Esc returns to the Fleet view</p>
      </div>
      <aside aria-label="Selection details" className="max-h-[62vh] overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900/95 p-5">
        {focus.level === "agent" && selectedAgent ? <AgentPanel m={selectedAgent} fleet={fleet} view={view} control={control} go={go} loadLedger={loadLedger} />
          : focus.level === "department" ? <DepartmentPanel dep={focus.id} fleet={fleet} view={view} models={models} openAgent={onAgent} go={go} />
          : <div><p className="text-xs tracking-widest text-cyan-300">FLEET VIEW</p><h3 className="text-xl font-semibold">The Fleet, as it is</h3>
            <p className="mt-2 text-sm text-slate-300">Select a room or an agent. Agents stand where their real work is (their mission, or their latest recorded activity); information travels between rooms only when FleetController records it.</p>
            <ul className="mt-4 space-y-2 text-sm">{models.map((m) => <li key={m.agent.id}><button className="text-cyan-300 underline" onClick={() => onAgent(m.agent.id)}>{m.agent.name}</button> · {m.health.label} · {DEPARTMENT[m.placement.department].name}</li>)}</ul>
            {!models.length && <p className="text-sm text-slate-400">No agents in the Fleet.</p>}
            <h4 className="mt-5 text-xs tracking-widest text-cyan-300">DEPARTMENTS</h4>
            <ul className="mt-2 grid grid-cols-2 gap-1 text-sm">{DEPARTMENTS.map((d) => <li key={d.id}><button className="text-left text-cyan-300 underline" onClick={() => onRoom(d.id)}>{d.name}</button></li>)}</ul></div>}
      </aside>
    </div>
  </section>;
}

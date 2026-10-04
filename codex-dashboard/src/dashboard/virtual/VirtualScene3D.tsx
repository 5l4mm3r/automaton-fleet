"use client";
/**
 * Virtual HQ v2 — the 3D headquarters (React Three Fiber / three.js), loaded only when Virtual opens on a WebGL device.
 *
 * A connected cutaway operations complex: real rooms with walls, doorways, furniture, equipment and live screens,
 * corridors, and adult operators who sit at their own workstations, use department terminals and walk between rooms when
 * — and only when — FleetController's state moves them (world.ts / departments.ts). Information travels as packets only
 * for recorded events. Quality (hq/quality.ts) changes materials, light, shadow and effects, never the world.
 *
 * Unchanged contract with the Command Centre: the same props (targets, births, packets, focus, selection) and the same
 * published positions / projection for the HTML label layer. Performance: merged static geometry (a few dozen draw
 * calls), instanced stations and crowd, one capped frame driver that stops while the tab is hidden; a lost WebGL context
 * hands over to the 2D map.
 */
import { Canvas, useThree, type ThreeEvent } from "@react-three/fiber";
import { memo, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import * as THREE from "three";
import type { AgentModel } from "../command/agents";
import { DEPARTMENTS, type DepartmentId } from "../command/departments";
import type { VirtualPrefs } from "../command/prefs";
import type { Projector } from "./AgentLabels";
import type { Focus } from "./VirtualMap";
import type { BirthState, Packet, Point } from "./world";
import { buildWorld } from "./hq/world-build";
import { createMaterials } from "./hq/materials";
import { matOf, type MatKey } from "./hq/builder";
import { HQ_PROFILE, type HQProfile } from "./hq/quality";
import { Crowd } from "./hq/crowd";
import { Stations } from "./hq/stations";
import { Screens, type ScreenFeed } from "./hq/screens";
import { AdaptiveResolution, Atmosphere, Beacons, CommandCore, Environment, FloorReflections, LightPools, Lights, PostFX } from "./hq/effects";
import { DataFlow } from "./hq/flow";
import { workTargets } from "./hq/spots";
import { CameraRig } from "./hq/camera";

const NO_SHADOW_MAPS_KEY = "fleet.virtual.gpu.noShadowMaps.v1";
const RECEIVE_ONLY: ReadonlySet<string> = new Set(["ground", "floor", "floorDark", "corridor"]);
const WORLD_UV: ReadonlySet<MatKey> = new Set(["floor", "corridor", "wall"] as MatKey[]);

/** The static building, merged per material; clicking a room's floor opens that department. */
const Building = memo(function Building({ q, plan, onRoom }: { q: HQProfile; plan: ReturnType<typeof buildWorld>; onRoom: (id: DepartmentId) => void }) {
  const geos = useMemo(() => plan.builder.build(WORLD_UV, 2, !q.pbr), [plan, q.pbr]);
  const details = useMemo(() => plan.details.build(WORLD_UV, 2, !q.pbr), [plan, q.pbr]);
  useEffect(() => () => { for (const g of geos.values()) g.dispose(); for (const g of details.values()) g.dispose(); }, [geos, details]);
  const mats = useMemo(() => createMaterials(q), [q]);
  useEffect(() => () => mats.dispose(), [mats]);
  const pick = (e: ThreeEvent<MouseEvent>) => {
    const p = e.point, d = DEPARTMENTS.find((r) => Math.abs(p.x - r.x) <= r.w / 2 && Math.abs(p.z - r.z) <= r.d / 2);
    if (d) { e.stopPropagation(); onRoom(d.id); }
  };
  const meshes = (map: Map<string, THREE.BufferGeometry>, tag: string) => [...map].map(([key, g]) => {
    const mat = matOf(key), floor = mat === "floor";
    return <mesh key={`${tag}:${key}`} geometry={g} material={mats.get(mat)}
      castShadow={!!q.shadows && !RECEIVE_ONLY.has(mat) && !mat.startsWith("glow:")} receiveShadow={!!q.shadows && !mat.startsWith("glow:")}
      onClick={floor ? pick : undefined} onPointerOver={floor ? () => { document.body.style.cursor = "pointer"; } : undefined}
      onPointerOut={floor ? () => { document.body.style.cursor = ""; } : undefined} />;
  });
  return <>{meshes(geos, "w")}{q.detail >= 2 && meshes(details, "d")}</>;
});

/** Publishes the world → screen projection for the HTML label layer. */
function ProjectorOut({ projectRef }: { projectRef: MutableRefObject<Projector | null> }) {
  const camera = useThree((s) => s.camera), gl = useThree((s) => s.gl);
  useEffect(() => {
    const v = new THREE.Vector3();
    const project: Projector = (p) => {
      v.set(p.x, 0.15, p.z).project(camera);
      if (v.z > 1) return null;
      const el = gl.domElement;
      return { x: ((v.x + 1) / 2) * el.clientWidth, y: ((1 - v.y) / 2) * el.clientHeight + 6 };
    };
    projectRef.current = project;
    return () => { if (projectRef.current === project) projectRef.current = null; };
  }, [camera, gl, projectRef]);
  return null;
}

/** The capped frame driver: renders at most `fps` times a second, never while the tab is hidden. */
function Driver({ fps }: { fps: number }) {
  const advance = useThree((s) => s.advance);
  useEffect(() => {
    let raf = 0, last = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (document.visibilityState !== "visible" || t - last < 1000 / fps - 1) return;
      last = t;
      advance(t / 1000);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [advance, fps]);
  return null;
}

export default function VirtualScene3D({ models, targets, packets, focus, prefs, selected, onRoom, onAgent, onLost, positionsRef, projectRef, stations, births, screenFeed, redAlert, teams }: {
  models: AgentModel[]; targets: Map<string, Point>; packets: Packet[]; focus: Focus; prefs: VirtualPrefs; selected: string | null;
  onRoom: (id: DepartmentId) => void; onAgent: (id: string) => void; onLost: () => void;
  positionsRef: MutableRefObject<Map<string, Point>>; projectRef: MutableRefObject<Projector | null>;
  stations: ReadonlyMap<string, Point>; births: ReadonlyMap<string, number>; birthStates: ReadonlyMap<string, BirthState>;
  /** Authoritative figures, items and the Treasury banner for the screens; whether FleetController has unacknowledged RED alerts. */
  screenFeed: ScreenFeed; redAlert: boolean;
  /** Agents actively collaborating on a team project (agent → project), from FleetController's project records. */
  teams: ReadonlyMap<string, string>;
}) {
  // Some GPU drivers cannot link shadow-map shaders. The first shader failure with shadows on retries the same level
  // without shadow maps (everything else kept); a failure without them hands over to the 2D map.
  // The result is remembered on this device (a local convenience, like the display preferences): a failing driver can
  // reset the GPU process, and browsers block WebGL for a page that keeps causing that.
  const [noShadowMaps, setNoShadowMaps] = useState(() => { try { return localStorage.getItem(NO_SHADOW_MAPS_KEY) === "1"; } catch { return false; } });
  const base = HQ_PROFILE[prefs.quality];
  const q = useMemo(() => (noShadowMaps && base.shadows ? { ...base, shadows: false as const } : base), [base, noShadowMaps]);
  const plan = useMemo(() => buildWorld(), []);
  // Unmounting the canvas releases its context on purpose; only a loss while the scene is shown falls back to the map.
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const ambient = prefs.ambient && !prefs.reduceMotion;
  // Where each agent stands or sits: its department comes from FleetController (targets); inside a room it takes that
  // room's next free work spot (a desk, a console, a table), so people are at the equipment, not on an empty grid.
  // People the Agent View camera wants out of its line of sight (faded by the crowd).
  const ghosts = useRef<ReadonlySet<string>>(new Set());
  // When a real flow last arrived at each room (the room's displays acknowledge it, e.g. the Treasury banner).
  const received = useRef(new Map<string, number>());
  const work = useMemo(() => workTargets(models, targets, stations, plan.spots, teams), [models, targets, stations, plan.spots, teams]);

  return <Canvas key={`${prefs.quality}:${q.shadows}`} frameloop="never" dpr={[1, q.dpr]} shadows={q.shadows === "soft" ? "percentage" : q.shadows === "basic" ? "basic" : false}
    camera={{ position: [0, 70, 50], fov: 42, near: 0.3, far: 400 }}
    gl={{ antialias: q.antialias, powerPreference: "high-performance", toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: q.pbr ? 1.15 : 1.5 }}
    onCreated={({ gl, scene }) => {
      scene.background = new THREE.Color("#03060c");
      // (A canvas retired by a re-key releases its context on purpose too; only the one still shown counts.)
      gl.domElement.addEventListener("webglcontextlost", (e) => { e.preventDefault(); setTimeout(() => { if (alive.current && gl.domElement.isConnected) onLost(); }, 0); });
      let failed = false;
      gl.debug.onShaderError = () => {
        if (failed) return;
        failed = true;
        if (!q.shadows) { setTimeout(() => { if (alive.current && gl.domElement.isConnected) onLost(); }, 0); return; }
        console.warn("Virtual HQ: this GPU could not build shadow-map shaders; continuing without shadow maps.");
        try { localStorage.setItem(NO_SHADOW_MAPS_KEY, "1"); } catch { /* storage unavailable: retried next visit */ }
        setTimeout(() => { if (alive.current) setNoShadowMaps(true); }, 0);
      };
    }}
    onPointerMissed={() => { document.body.style.cursor = ""; }}>
    <Driver fps={prefs.fps} />
    <ProjectorOut projectRef={projectRef} />
    <CameraRig focus={focus} positionsRef={positionsRef} reduceMotion={prefs.reduceMotion} spots={work.spots} stations={stations} ghostsRef={ghosts} occluders={plan.occluders} />
    <Lights q={q} lights={plan.lights} />
    <Environment q={q} />
    <Atmosphere q={q} lights={plan.lights} ambient={ambient} />
    <Building q={q} plan={plan} onRoom={onRoom} />
    <LightPools q={q} lights={plan.lights} />
    <FloorReflections q={q} />
    <Screens spots={plan.screens} feed={screenFeed} q={q} reduceMotion={prefs.reduceMotion} receivedRef={received} />
    <CommandCore at={plan.core} q={q} ambient={ambient} />
    <Beacons spots={plan.beacons} red={redAlert} ambient={ambient} />
    <Stations models={models} stations={stations} births={births} reduceMotion={prefs.reduceMotion} q={q} />
    <Crowd models={models} targets={work.targets} spots={work.spots} meetings={work.meetings} ghostsRef={ghosts} births={births} selected={selected} q={q} reduceMotion={prefs.reduceMotion} positionsRef={positionsRef} onAgent={onAgent} stations={stations} />
    <DataFlow packets={packets} enabled={prefs.dataFlow} reduceMotion={prefs.reduceMotion} q={q} receivedRef={received} />
    <AdaptiveResolution q={q} />
    <PostFX q={q} />
  </Canvas>;
}

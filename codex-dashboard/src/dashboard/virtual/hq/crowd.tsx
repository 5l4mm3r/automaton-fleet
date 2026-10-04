"use client";
/**
 * The operators: adult-proportioned (≈1.78 m) technical-operations characters, one per agent — dark technical uniform
 * with a vest, cyan piping, belt and a Fleet shoulder patch; skin, hair and beard from the SAME identity seed as the
 * agent's portrait (portrait.ts identityColours), so body and face agree.
 *
 * Animation states come from the agent's real state and position, never from decoration:
 *   walking (moving to the spot its FleetController state puts it) · idle (standing, breathing) · seated typing at its own
 *   Agent Floor workstation · standing terminal use (in a department: facing the equipment, a personal holo panel) ·
 *   seated idle when held · lying when dead. Poses blend smoothly; Reduce Motion snaps positions and stills the motion.
 *
 * Rendering: each body part is ONE instanced mesh for the whole crowd (≈20 draw calls for 50 people); a reusable rig of
 * Object3D joints poses each agent in turn and writes the part matrices.
 */
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { memo, useEffect, useMemo, useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import type { AgentModel } from "../../command/agents";
import { DEPARTMENT } from "../../command/departments";
import { identityColours } from "../../command/portrait";
import { birthState, type Point } from "../world";
import type { HQProfile } from "./quality";

type Pose = { hipY: number; lean: number; head: number; headYaw: number; sh: [number, number]; shRoll: [number, number]; el: [number, number]; th: [number, number]; kn: [number, number]; lying: number };
const POSE_KEYS = ["hipY", "lean", "head", "headYaw", "lying"] as const;

export type Activity = "walk" | "idle" | "seated" | "terminal" | "seatedIdle" | "dead";

interface AgentState { pos: Point; yaw: number; phase: number; pose: Pose; activity: Activity }

const zero = (): Pose => ({ hipY: 0.94, lean: 0, head: 0, headYaw: 0, sh: [0, 0], shRoll: [0.08, -0.08], el: [0.15, 0.15], th: [0, 0], kn: [0.05, 0.05], lying: 0 });

/** The target pose for an activity at time t (seconds); `i` desynchronises agents. */
function targetPose(a: Activity, t: number, phase: number, i: number, still: boolean): Pose {
  const p = zero(), s = still ? 0 : 1;
  switch (a) {
    case "walk": {
      const w = Math.sin(phase);
      p.th = [-w * 0.55, w * 0.55]; p.kn = [0.12 + Math.max(0, Math.sin(phase + 1.3)) * 0.8, 0.12 + Math.max(0, Math.sin(phase + 1.3 + Math.PI)) * 0.8];
      p.sh = [w * 0.45, -w * 0.45]; p.el = [0.3, 0.3]; p.hipY = 0.94 + Math.abs(Math.cos(phase)) * 0.025; p.lean = 0.05; break;
    }
    case "idle":
      p.sh = [0.04 + Math.sin(t * 1.3 + i) * 0.02 * s, 0.04 - Math.sin(t * 1.3 + i) * 0.02 * s]; p.headYaw = Math.sin(t * 0.35 + i) * 0.25 * s; p.hipY = 0.94 + Math.sin(t * 1.6 + i) * 0.004 * s; break;
    case "seated":
      p.hipY = 0.5; p.th = [-1.5, -1.5]; p.kn = [1.45, 1.45]; p.lean = 0.14; p.head = 0.18;
      p.sh = [-0.62, -0.62]; p.shRoll = [0.12, -0.12]; p.el = [-1.05 + Math.sin(t * 13 + i) * 0.05 * s, -1.05 + Math.sin(t * 11 + i + 1) * 0.05 * s]; break;
    case "seatedIdle":
      p.hipY = 0.5; p.th = [-1.5, -1.5]; p.kn = [1.45, 1.45]; p.lean = -0.05; p.sh = [-0.25, -0.25]; p.el = [-0.9, -0.9]; p.headYaw = Math.sin(t * 0.3 + i) * 0.2 * s; break;
    case "terminal":
      p.sh = [-0.5 + Math.sin(t * 1.7 + i) * 0.1 * s, -0.42 - Math.sin(t * 1.3 + i) * 0.08 * s]; p.el = [-1.05, -1.0]; p.shRoll = [0.16, -0.16]; p.head = 0.04; p.headYaw = Math.sin(t * 0.5 + i) * 0.1 * s; break;
    case "dead":
      p.lying = 1; p.hipY = 0.16; p.sh = [0, 0]; p.el = [0, 0]; break;
  }
  return p;
}

function blend(cur: Pose, to: Pose, k: number) {
  for (const key of POSE_KEYS) cur[key] += (to[key] - cur[key]) * k;
  for (const key of ["sh", "shRoll", "el", "th", "kn"] as const) for (let j = 0; j < 2; j++) cur[key][j] += (to[key][j] - cur[key][j]) * k;
}

/** The joint rig (built once): world matrices of every part for one agent at a time. */
function makeRig() {
  const n = (parent?: THREE.Object3D) => { const o = new THREE.Object3D(); parent?.add(o); return o; };
  const root = n(), lie = n(root), hip = n(lie), torso = n(hip), neck = n(torso), head = n(neck);
  const shL = n(torso), shR = n(torso), elL = n(shL), elR = n(shR), thL = n(hip), thR = n(hip), knL = n(thL), knR = n(thR);
  torso.position.set(0, 0.08, 0); neck.position.set(0, 0.5, 0); head.position.set(0, 0.08, 0);
  shL.position.set(0.22, 0.42, 0); shR.position.set(-0.22, 0.42, 0); elL.position.set(0, -0.3, 0); elR.position.set(0, -0.3, 0);
  thL.position.set(0.1, -0.04, 0); thR.position.set(-0.1, -0.04, 0); knL.position.set(0, -0.44, 0); knR.position.set(0, -0.44, 0);
  // Part anchors (where each instanced part sits relative to its joint).
  const at = (parent: THREE.Object3D, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1) => { const o = n(parent); o.position.set(x, y, z); o.scale.set(sx, sy, sz); return o; };
  const parts = {
    pelvis: at(hip, 0, 0, 0), belt: at(hip, 0, 0.08, 0), buckle: at(hip, 0, 0.08, 0.125),
    torso: at(torso, 0, 0.25, 0, 1.12, 1, 0.74), vest: at(torso, 0, 0.27, 0.115), pipeL: at(torso, 0.09, 0.27, 0.142), pipeR: at(torso, -0.09, 0.27, 0.142),
    neck: at(neck, 0, 0, 0), head: at(head, 0, 0.12, 0, 0.92, 1.15, 1), hair: at(head, 0, 0.16, -0.01), beard: at(head, 0, 0.05, 0.035, 0.85, 0.7, 0.9),
    eyeL: at(head, 0.038, 0.135, 0.1), eyeR: at(head, -0.038, 0.135, 0.1), browL: at(head, 0.04, 0.163, 0.098), browR: at(head, -0.04, 0.163, 0.098),
    nose: at(head, 0, 0.105, 0.112), earL: at(head, 0.104, 0.12, -0.005), earR: at(head, -0.104, 0.12, -0.005),
    uArmL: at(shL, 0, -0.15, 0), uArmR: at(shR, 0, -0.15, 0), patchL: at(shL, 0.055, -0.08, 0), patchR: at(shR, -0.055, -0.08, 0),
    fArmL: at(elL, 0, -0.13, 0), fArmR: at(elR, 0, -0.13, 0), handL: at(elL, 0, -0.28, 0), handR: at(elR, 0, -0.28, 0),
    thighL: at(thL, 0, -0.22, 0), thighR: at(thR, 0, -0.22, 0), shinL: at(knL, 0, -0.22, 0), shinR: at(knR, 0, -0.22, 0),
    bootL: at(knL, 0, -0.47, 0.04), bootR: at(knR, 0, -0.47, 0.04), holo: at(root, 0, 1.25, 0.55),
  };
  return { root, lie, hip, torso, head, neck, shL, shR, elL, elR, thL, thR, knL, knR, parts };
}

type PartName = keyof ReturnType<typeof makeRig>["parts"];
const PART_GEOMETRY: Record<PartName, () => THREE.BufferGeometry> = {
  pelvis: () => new THREE.BoxGeometry(0.34, 0.18, 0.22), belt: () => new THREE.BoxGeometry(0.36, 0.05, 0.24), buckle: () => new THREE.BoxGeometry(0.05, 0.035, 0.01),
  torso: () => new THREE.CapsuleGeometry(0.17, 0.3, 6, 12), vest: () => new THREE.BoxGeometry(0.3, 0.32, 0.04),
  pipeL: () => new THREE.BoxGeometry(0.012, 0.3, 0.006), pipeR: () => new THREE.BoxGeometry(0.012, 0.3, 0.006),
  neck: () => new THREE.CylinderGeometry(0.052, 0.058, 0.12, 10), head: () => new THREE.SphereGeometry(0.115, 18, 14),
  hair: () => new THREE.SphereGeometry(0.122, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), beard: () => new THREE.SphereGeometry(0.11, 14, 10, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.4),
  eyeL: () => new THREE.BoxGeometry(0.022, 0.012, 0.008), eyeR: () => new THREE.BoxGeometry(0.022, 0.012, 0.008),
  browL: () => new THREE.BoxGeometry(0.034, 0.009, 0.01), browR: () => new THREE.BoxGeometry(0.034, 0.009, 0.01),
  nose: () => new THREE.BoxGeometry(0.026, 0.05, 0.03), earL: () => new THREE.SphereGeometry(0.026, 8, 6), earR: () => new THREE.SphereGeometry(0.026, 8, 6),
  uArmL: () => new THREE.CapsuleGeometry(0.052, 0.2, 4, 10), uArmR: () => new THREE.CapsuleGeometry(0.052, 0.2, 4, 10),
  patchL: () => new THREE.BoxGeometry(0.006, 0.06, 0.06), patchR: () => new THREE.BoxGeometry(0.006, 0.06, 0.06),
  fArmL: () => new THREE.CapsuleGeometry(0.045, 0.18, 4, 10), fArmR: () => new THREE.CapsuleGeometry(0.045, 0.18, 4, 10),
  handL: () => new THREE.SphereGeometry(0.045, 10, 8), handR: () => new THREE.SphereGeometry(0.045, 10, 8),
  thighL: () => new THREE.CapsuleGeometry(0.075, 0.3, 4, 10), thighR: () => new THREE.CapsuleGeometry(0.075, 0.3, 4, 10),
  shinL: () => new THREE.CapsuleGeometry(0.06, 0.32, 4, 10), shinR: () => new THREE.CapsuleGeometry(0.06, 0.32, 4, 10),
  bootL: () => new THREE.BoxGeometry(0.11, 0.09, 0.25), bootR: () => new THREE.BoxGeometry(0.11, 0.09, 0.25),
  holo: () => new THREE.PlaneGeometry(0.62, 0.38),
};
/** Fixed colour per part, or a per-agent colour (skin, hair, uniform). */
const PART_COLOUR: Record<PartName, string | "skin" | "hair" | "uniform" | "trousers" | "accent"> = {
  pelvis: "trousers", belt: "#0b0f16", buckle: "#22d3ee", torso: "uniform", vest: "#0f151f", pipeL: "#22d3ee", pipeR: "#22d3ee", neck: "skin", head: "skin", hair: "hair", beard: "hair",
  eyeL: "#120d0b", eyeR: "#120d0b", browL: "hair", browR: "hair", nose: "skin", earL: "skin", earR: "skin", uArmL: "uniform", uArmR: "uniform", patchL: "#22d3ee", patchR: "#22d3ee", fArmL: "uniform", fArmR: "uniform", handL: "skin", handR: "skin",
  thighL: "trousers", thighR: "trousers", shinL: "trousers", shinR: "trousers", bootL: "#0a0d12", bootR: "#0a0d12", holo: "accent",
};
const GLOW: ReadonlySet<PartName> = new Set(["buckle", "pipeL", "pipeR", "patchL", "patchR", "holo"]);
const CLICKABLE: ReadonlySet<PartName> = new Set(["torso", "pelvis", "head", "thighL", "thighR"]);

/** Hair silhouettes from the identity's hair style (scale, lift). */
const HAIR_SHAPE: Record<number, [number, number, number, number]> = { 0: [1, 0.8, 1.02, 0], 1: [0.98, 0.7, 1.0, -0.01], 2: [0.96, 0.62, 0.98, -0.02], 3: [1.02, 0.85, 1.08, 0.005], 4: [0.97, 0.78, 1.0, 0.01], 5: [0.98, 0.6, 1.0, 0.01] };

export const Crowd = memo(function Crowd({ models, targets, births, selected, q, reduceMotion, positionsRef, onAgent, stations }: {
  models: AgentModel[]; targets: ReadonlyMap<string, Point>; births: ReadonlyMap<string, number>; selected: string | null; q: HQProfile; reduceMotion: boolean;
  positionsRef: MutableRefObject<Map<string, Point>>; onAgent: (id: string) => void; stations: ReadonlyMap<string, Point>;
}) {
  const rig = useMemo(() => makeRig(), []);
  const names = useMemo(() => Object.keys(rig.parts) as PartName[], [rig]);
  const meshes = useRef(new Map<PartName, THREE.InstancedMesh>());
  const states = useRef(new Map<string, AgentState>());
  const own = useRef(new Map<string, Point>());
  useEffect(() => { positionsRef.current = own.current; }, [positionsRef]);
  const cap = Math.max(1, models.length);

  const geometries = useMemo(() => Object.fromEntries(names.map((p) => [p, PART_GEOMETRY[p]()])) as unknown as Record<PartName, THREE.BufferGeometry>, [names]);
  const materials = useMemo(() => Object.fromEntries(names.map((p) => {
    const glow = GLOW.has(p);
    const m = glow ? new THREE.MeshBasicMaterial({ color: "#ffffff", toneMapped: false, transparent: p === "holo", opacity: p === "holo" ? 0.55 : 1, side: p === "holo" ? THREE.DoubleSide : THREE.FrontSide, depthWrite: p !== "holo" })
      : q.pbr ? new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: p === "head" || p === "handL" || p === "handR" || p === "neck" ? 0.65 : 0.78, metalness: p === "vest" || p === "belt" ? 0.35 : 0.05 })
      : new THREE.MeshLambertMaterial({ color: "#ffffff" });
    return [p, m];
  })) as unknown as Record<PartName, THREE.Material>, [names, q.pbr]);
  useEffect(() => () => { for (const g of Object.values(geometries)) g.dispose(); }, [geometries]);
  useEffect(() => () => { for (const m of Object.values(materials)) m.dispose(); }, [materials]);

  // Per-agent colours (identity) — written when the crowd or its conditions change.
  const colour = useMemo(() => new THREE.Color(), []);
  useEffect(() => {
    models.forEach((m, i) => {
      const id = identityColours(m.agent.id), dead = m.agent.status === "dead";
      for (const p of names) {
        const mesh = meshes.current.get(p);
        if (!mesh) continue;
        const kind = PART_COLOUR[p];
        const c = kind === "skin" ? id.skin : kind === "hair" ? id.hair : kind === "uniform" ? "#1f2b3d" : kind === "trousers" ? "#161e2b" : kind === "accent" ? DEPARTMENT[m.placement.department].accent : kind;
        colour.set(c);
        if (dead && !GLOW.has(p)) colour.lerp(new THREE.Color("#3b4250"), 0.55);
        if (dead && GLOW.has(p)) colour.set("#1e293b");
        mesh.setColorAt(i, colour);
      }
    });
    for (const mesh of meshes.current.values()) if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [models, names, colour]);

  const hidden = useMemo(() => new THREE.Matrix4().makeScale(0, 0, 0), []);
  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime, k = reduceMotion ? 1 : Math.min(1, dt * 6), now = Date.now();
    models.forEach((m, i) => {
      const id = m.agent.id, target = targets.get(id);
      if (!target) return;
      let st = states.current.get(id);
      const b = birthState(births.get(id), now, reduceMotion);
      if (!st) {
        const start = b.phase !== "settled" ? { x: DEPARTMENT.command.x, z: DEPARTMENT.command.z + 6 } : { ...target };
        st = { pos: start, yaw: Math.PI, phase: 0, pose: zero(), activity: "idle" };
        states.current.set(id, st);
      }
      // Walk towards the authoritative target (≈1.4 m/s).
      const dx = target.x - st.pos.x, dz = target.z - st.pos.z, dist = Math.hypot(dx, dz), step = 1.4 * Math.min(dt, 0.1);
      const moving = !reduceMotion && dist > 0.02;
      if (!moving) { st.pos.x = target.x; st.pos.z = target.z; } else { const f = Math.min(1, step / dist); st.pos.x += dx * f; st.pos.z += dz * f; st.phase += (step / 0.75) * Math.PI; }
      own.current.set(id, { x: st.pos.x, z: st.pos.z });
      const station = stations.get(id), atStation = !!station && Math.hypot(station.x - st.pos.x, station.z - st.pos.z) < 0.05;
      const activity: Activity = m.agent.status === "dead" ? "dead" : moving ? "walk"
        : atStation ? (m.agent.status === "held" || m.agent.status === "provisioning" ? "seatedIdle" : "seated")
        : m.placement.department === "floor" ? "idle" : "terminal";
      st.activity = activity;
      const wantYaw = moving ? Math.atan2(dx, dz) : Math.PI; // stationary: face the equipment / desk (north)
      let dy = wantYaw - st.yaw; while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
      st.yaw += dy * (reduceMotion ? 1 : Math.min(1, dt * 8));
      blend(st.pose, targetPose(activity, t, st.phase, i, reduceMotion), k);

      // Pose the rig.
      const P = st.pose, r = rig;
      r.root.position.set(st.pos.x, 0.12, st.pos.z + (activity === "seated" || activity === "seatedIdle" ? 0.08 : 0));
      r.root.rotation.set(0, st.yaw, 0);
      r.lie.rotation.set(-P.lying * Math.PI / 2, 0, 0); r.lie.position.set(0, 0, P.lying * 0.9);
      r.hip.position.set(0, P.hipY - P.lying * 0.78, 0);
      r.torso.rotation.set(P.lean, 0, 0);
      r.neck.rotation.set(P.head, P.headYaw, 0);
      r.shL.rotation.set(P.sh[0], 0, P.shRoll[0]); r.shR.rotation.set(P.sh[1], 0, P.shRoll[1]);
      r.elL.rotation.set(P.el[0], 0, 0); r.elR.rotation.set(P.el[1], 0, 0);
      r.thL.rotation.set(P.th[0], 0, 0); r.thR.rotation.set(P.th[1], 0, 0);
      r.knL.rotation.set(P.kn[0], 0, 0); r.knR.rotation.set(P.kn[1], 0, 0);
      const style = identityColours(id), hs = HAIR_SHAPE[style.hairStyle] ?? HAIR_SHAPE[0];
      r.parts.hair.scale.set(hs[0], hs[1], hs[2]); r.parts.hair.position.set(0, 0.16 + hs[3], -0.012);
      const beard = style.facialHair >= 3; r.parts.beard.visible = beard;
      r.root.updateMatrixWorld(true);
      for (const p of names) {
        const mesh = meshes.current.get(p);
        if (!mesh) continue;
        const show = b.visible && (p !== "beard" || beard) && (p !== "holo" || activity === "terminal") && !(activity === "dead" && p === "holo");
        mesh.setMatrixAt(i, show ? r.parts[p].matrixWorld : hidden);
      }
    });
    for (const mesh of meshes.current.values()) { mesh.count = models.length; mesh.instanceMatrix.needsUpdate = true; }
    // Forget agents no longer present.
    if (states.current.size > models.length) for (const id of [...states.current.keys()]) if (!models.some((m) => m.agent.id === id)) { states.current.delete(id); own.current.delete(id); }
  });

  const click = (e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); const m = e.instanceId !== undefined ? models[e.instanceId] : undefined; if (m) onAgent(m.agent.id); };
  return <>
    {names.map((p) => <instancedMesh key={`${p}:${cap}`} ref={(m) => { if (m) meshes.current.set(p, m); else meshes.current.delete(p); }}
      args={[geometries[p], materials[p], cap]} frustumCulled={false} castShadow={!!q.shadows && !GLOW.has(p)} receiveShadow={false}
      onClick={CLICKABLE.has(p) ? click : undefined}
      onPointerOver={CLICKABLE.has(p) ? () => { document.body.style.cursor = "pointer"; } : undefined}
      onPointerOut={CLICKABLE.has(p) ? () => { document.body.style.cursor = ""; } : undefined} />)}
    <SelectionRing selected={selected} positionsRef={own} />
    {q.contactShadows && <ContactShadows models={models} positionsRef={own} />}
  </>;
});

/** Medium and above: a soft contact shadow (ambient occlusion blob) under each person, so they sit on the floor. */
function ContactShadows({ models, positionsRef }: { models: AgentModel[]; positionsRef: MutableRefObject<Map<string, Point>> }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const { geom, mat } = useMemo(() => {
    const c = document.createElement("canvas"); c.width = c.height = 64;
    const g = c.getContext("2d")!, grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, "rgba(0,0,0,0.75)"); grd.addColorStop(0.55, "rgba(0,0,0,0.35)"); grd.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
    const geom = new THREE.PlaneGeometry(0.9, 0.9); geom.rotateX(-Math.PI / 2);
    return { geom, mat: new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }) };
  }, []);
  useEffect(() => () => { geom.dispose(); mat.map?.dispose(); mat.dispose(); }, [geom, mat]);
  const m4 = useMemo(() => new THREE.Matrix4(), []);
  useFrame(() => {
    const im = mesh.current; if (!im) return;
    let n = 0;
    for (const m of models) { const p = positionsRef.current.get(m.agent.id); if (!p) continue; m4.makeTranslation(p.x, 0.125, p.z); im.setMatrixAt(n++, m4); }
    im.count = n; im.instanceMatrix.needsUpdate = true;
  });
  return <instancedMesh ref={mesh} args={[geom, mat, Math.max(1, models.length)]} key={models.length} frustumCulled={false} renderOrder={1} />;
}

function SelectionRing({ selected, positionsRef }: { selected: string | null; positionsRef: MutableRefObject<Map<string, Point>> }) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    const m = ref.current;
    if (!m) return;
    const p = selected ? positionsRef.current.get(selected) : undefined;
    m.visible = !!p;
    if (p) { m.position.set(p.x, 0.15, p.z); m.rotation.z = clock.elapsedTime * 0.6; }
  });
  return <mesh ref={ref} rotation={[-Math.PI / 2, 0, 0]} visible={false}><ringGeometry args={[0.45, 0.52, 40]} /><meshBasicMaterial color="#e2e8f0" toneMapped={false} /></mesh>;
}

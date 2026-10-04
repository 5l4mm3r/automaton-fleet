"use client";
/**
 * Every agent's dedicated workstation on the Agent Floor: desk, modesty panel, monitor and chair — instanced, so 50
 * stations cost a handful of draw calls. The monitor's glow is the station's power: dark before a newborn's station
 * powers up, lit while its agent lives, powered down after its death (presentation only; world.ts births).
 */
import { useFrame } from "@react-three/fiber";
import { memo, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { AgentModel } from "../../command/agents";
import { birthState, type Point } from "../world";
import type { HQProfile } from "./quality";

const PARTS = {
  top: { g: () => new THREE.BoxGeometry(1.3, 0.05, 0.66), off: [0, 0.76, -0.62] as const, mat: "desk" },
  panel: { g: () => new THREE.BoxGeometry(1.2, 0.62, 0.04), off: [0, 0.42, -0.92] as const, mat: "dark" },
  legL: { g: () => new THREE.BoxGeometry(0.05, 0.74, 0.6), off: [0.6, 0.37, -0.62] as const, mat: "dark" },
  legR: { g: () => new THREE.BoxGeometry(0.05, 0.74, 0.6), off: [-0.6, 0.37, -0.62] as const, mat: "dark" },
  monitor: { g: () => new THREE.BoxGeometry(0.62, 0.38, 0.04), off: [0, 1.06, -0.82] as const, mat: "dark" },
  stand: { g: () => new THREE.BoxGeometry(0.05, 0.2, 0.05), off: [0, 0.87, -0.84] as const, mat: "dark" },
  screen: { g: () => new THREE.PlaneGeometry(0.56, 0.32), off: [0, 1.06, -0.797] as const, mat: "screen" },
  keyboard: { g: () => new THREE.BoxGeometry(0.45, 0.02, 0.14), off: [0, 0.79, -0.45] as const, mat: "dark" },
  seat: { g: () => new THREE.BoxGeometry(0.5, 0.08, 0.48), off: [0, 0.5, 0.1] as const, mat: "fabric" },
  back: { g: () => new THREE.BoxGeometry(0.48, 0.4, 0.07), off: [0, 0.78, 0.36] as const, mat: "fabric" },
  post: { g: () => new THREE.CylinderGeometry(0.03, 0.03, 0.42, 8), off: [0, 0.26, 0.1] as const, mat: "dark" },
  base: { g: () => new THREE.CylinderGeometry(0.28, 0.3, 0.05, 12), off: [0, 0.05, 0.1] as const, mat: "dark" },
} as const;
type Part = keyof typeof PARTS;

/** A generic working-terminal face (window chrome and text lines — no figures), tinted by the station's power colour. */
function screenFace() {
  const c = document.createElement("canvas"); c.width = 128; c.height = 72;
  const g = c.getContext("2d")!;
  g.fillStyle = "#2a3a4a"; g.fillRect(0, 0, 128, 72);
  g.fillStyle = "#cfefff"; g.fillRect(0, 0, 128, 7);
  g.fillStyle = "#16202c"; g.fillRect(4, 11, 38, 57);
  for (let i = 0; i < 9; i++) { g.fillStyle = i % 3 === 0 ? "#ffffff" : "#8fb6cc"; g.fillRect(48, 12 + i * 6, 20 + ((i * 37) % 55), 2.5); }
  for (let i = 0; i < 7; i++) { g.fillStyle = "#6f93a8"; g.fillRect(8, 15 + i * 7, 10 + ((i * 23) % 24), 2.5); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export const Stations = memo(function Stations({ models, stations, births, reduceMotion, q }: {
  models: AgentModel[]; stations: ReadonlyMap<string, Point>; births: ReadonlyMap<string, number>; reduceMotion: boolean; q: HQProfile;
}) {
  const ids = useMemo(() => models.map((m) => m.agent.id).filter((id) => stations.has(id)), [models, stations]);
  const cap = Math.max(1, ids.length);
  const geos = useMemo(() => Object.fromEntries(Object.entries(PARTS).map(([k, p]) => [k, p.g()])) as unknown as Record<Part, THREE.BufferGeometry>, []);
  const mats = useMemo(() => {
    const std = (color: string, rough: number, metal: number) => (q.pbr ? new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal }) : new THREE.MeshLambertMaterial({ color: new THREE.Color(color).multiplyScalar(2.4) }));
    return { desk: std("#22304a", 0.45, 0.35), dark: std("#151c28", 0.4, 0.7), fabric: std("#121a27", 0.95, 0), screen: new THREE.MeshBasicMaterial({ color: "#ffffff", map: screenFace(), toneMapped: false }) };
  }, [q.pbr]);
  useEffect(() => () => { for (const g of Object.values(geos)) g.dispose(); }, [geos]);
  useEffect(() => () => { mats.screen.map?.dispose(); for (const m of Object.values(mats)) m.dispose(); }, [mats]);
  const meshes = useRef(new Map<Part, THREE.InstancedMesh>());
  const dead = useMemo(() => new Set(models.filter((m) => m.agent.status === "dead").map((m) => m.agent.id)), [models]);

  // Furniture placement (static per station).
  useEffect(() => {
    const o = new THREE.Object3D();
    ids.forEach((id, i) => {
      const st = stations.get(id)!;
      for (const p of Object.keys(PARTS) as Part[]) {
        const mesh = meshes.current.get(p); if (!mesh) continue;
        const [x, y, z] = PARTS[p].off;
        o.position.set(st.x + x, y + 0.12, st.z + z); o.rotation.set(0, 0, 0); o.updateMatrix();
        mesh.setMatrixAt(i, o.matrix);
      }
    });
    for (const m of meshes.current.values()) { m.count = ids.length; m.instanceMatrix.needsUpdate = true; }
  }, [ids, stations]);

  // Screen power (written only when it changes).
  const last = useRef(new Map<string, number>());
  const c = useMemo(() => new THREE.Color(), []), lit = useMemo(() => new THREE.Color("#22d3ee"), []), off = useMemo(() => new THREE.Color("#0b1220"), []);
  useFrame(() => {
    const scr = meshes.current.get("screen"); if (!scr) return;
    const now = Date.now(); let changed = false;
    ids.forEach((id, i) => {
      const power = dead.has(id) ? 0 : birthState(births.get(id), now, reduceMotion).power;
      if (Math.abs((last.current.get(id) ?? -1) - power) < 0.01) return;
      last.current.set(id, power); c.copy(off).lerp(lit, power * (q.bloom ? 1 : 0.85)); scr.setColorAt(i, c); changed = true;
    });
    if (changed && scr.instanceColor) scr.instanceColor.needsUpdate = true;
  });

  return <>{(Object.keys(PARTS) as Part[]).map((p) => <instancedMesh key={`${p}:${cap}`} ref={(m) => { if (m) meshes.current.set(p, m); else meshes.current.delete(p); }}
    args={[geos[p], mats[PARTS[p].mat], cap]} frustumCulled={false} castShadow={!!q.shadows && p !== "screen"} receiveShadow={!!q.shadows}
    userData={{ station: p === "screen" }} />)}</>;
});

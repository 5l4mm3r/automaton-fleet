"use client";
/**
 * Quarters: a bed for every LIVING agent (world.ts bedIndex / bedPoint) — bunk frames instanced, so 50 beds cost a
 * handful of draw calls; the number of beds follows the number of living agents. Each bed's reading lamp shows who is
 * asleep there and why, from the reading only: amber with a pause bar for the OWNER'S PAUSE, indigo with a moon for a
 * REPORTED HIBERNATION, dark when the bed is empty (its agent is awake somewhere in the building).
 */
import { memo, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { AgentModel } from "../../command/agents";
import { BED_LENGTH, BED_TOP, BED_WIDTH, bedIndex, bedPoint, bunksFor } from "../world";
import type { HQProfile } from "./quality";
import { bakeShade } from "./builder";

/** Lamp colours: the owner's pause (amber) and a reported hibernation (indigo); dark = empty. */
export const SLEEP_LAMP = Object.freeze({ owner_pause: "#f59e0b", hibernating: "#818cf8", empty: "#0b1220" });

type Part = "post" | "rail" | "lower" | "upper" | "pillowL" | "pillowU" | "ladder" | "lampL" | "lampU";
const POST_H = 2.0;

export const Beds = memo(function Beds({ models, q }: { models: AgentModel[]; q: HQProfile }) {
  const beds = useMemo(() => bedIndex(models), [models]);
  const n = beds.size, { frames, uppers } = bunksFor(n), cap = Math.max(1, frames * 4);
  const geos = useMemo(() => ({
    post: bakeShade(new THREE.BoxGeometry(0.06, POST_H, 0.06)),
    rail: bakeShade(new THREE.BoxGeometry(0.05, 0.06, BED_LENGTH)),
    lower: bakeShade(new THREE.BoxGeometry(BED_WIDTH - 0.08, 0.16, BED_LENGTH - 0.1)),
    upper: bakeShade(new THREE.BoxGeometry(BED_WIDTH - 0.08, 0.16, BED_LENGTH - 0.1)),
    pillowL: bakeShade(new THREE.BoxGeometry(BED_WIDTH - 0.3, 0.08, 0.36)),
    pillowU: bakeShade(new THREE.BoxGeometry(BED_WIDTH - 0.3, 0.08, 0.36)),
    ladder: bakeShade(new THREE.BoxGeometry(0.04, 1.6, 0.36)),
    lampL: new THREE.BoxGeometry(0.2, 0.05, 0.05),
    lampU: new THREE.BoxGeometry(0.2, 0.05, 0.05),
  }) as Record<Part, THREE.BufferGeometry>, []);
  const mats = useMemo(() => {
    const std = (color: string, rough: number, metal: number) => (q.pbr ? new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal }) : new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2.2), vertexColors: true }));
    return { frame: std("#1b2433", 0.4, 0.7), mattress: std("#202a44", 0.95, 0), pillow: std("#3a4766", 0.95, 0), lamp: new THREE.MeshBasicMaterial({ color: "#ffffff", toneMapped: false }) };
  }, [q.pbr]);
  useEffect(() => () => { for (const g of Object.values(geos)) g.dispose(); }, [geos]);
  useEffect(() => () => { for (const m of Object.values(mats)) m.dispose(); }, [mats]);
  const meshes = useRef(new Map<Part, THREE.InstancedMesh>());

  // Frames (static per bed count) and the lamps' colours (who sleeps where, and why).
  useEffect(() => {
    const o = new THREE.Object3D(), c = new THREE.Color();
    const set = (p: Part, i: number, x: number, y: number, z: number) => { const m = meshes.current.get(p); if (!m) return; o.position.set(x, y, z); o.updateMatrix(); m.setMatrixAt(i, o.matrix); };
    const sleepAt = new Map<number, AgentModel["rest"]["sleep"]>();
    for (const m of models) { const i = beds.get(m.agent.id); if (i !== undefined && m.placement.basis === "sleep") sleepAt.set(i, m.rest.sleep); }
    for (let f = 0; f < frames; f++) {
      const b = bedPoint(f), cz = b.z + BED_LENGTH / 2, y0 = 0.12;
      let k = 0;
      for (const dx of [-1, 1]) for (const dz of [-1, 1]) set("post", f * 4 + k++, b.x + dx * (BED_WIDTH / 2), y0 + POST_H / 2, cz + dz * (BED_LENGTH / 2 - 0.03));
      set("rail", f * 2, b.x - BED_WIDTH / 2, y0 + POST_H - 0.05, cz); set("rail", f * 2 + 1, b.x + BED_WIDTH / 2, y0 + POST_H - 0.05, cz);
      set("lower", f, b.x, y0 + BED_TOP[0] - 0.08, cz); set("pillowL", f, b.x, y0 + BED_TOP[0] + 0.04, b.z + 0.25); set("lampL", f, b.x, y0 + BED_TOP[0] + 0.45, b.z - 0.02);
      const lampL = meshes.current.get("lampL"), s = sleepAt.get(f);
      lampL?.setColorAt(f, c.set(s === "owner_pause" ? SLEEP_LAMP.owner_pause : s === "hibernating" ? SLEEP_LAMP.hibernating : SLEEP_LAMP.empty));
    }
    for (let u = 0; u < uppers; u++) {
      const b = bedPoint(u), cz = b.z + BED_LENGTH / 2, y0 = 0.12, i = u + frames, s = sleepAt.get(i);
      set("upper", u, b.x, y0 + BED_TOP[1] - 0.08, cz); set("pillowU", u, b.x, y0 + BED_TOP[1] + 0.04, b.z + 0.25); set("ladder", u, b.x + BED_WIDTH / 2 + 0.03, y0 + 0.8, cz + 0.5);
      set("lampU", u, b.x, y0 + BED_TOP[1] + 0.35, b.z - 0.02);
      meshes.current.get("lampU")?.setColorAt(u, c.set(s === "owner_pause" ? SLEEP_LAMP.owner_pause : s === "hibernating" ? SLEEP_LAMP.hibernating : SLEEP_LAMP.empty));
    }
    const count: Record<Part, number> = { post: frames * 4, rail: frames * 2, lower: frames, pillowL: frames, lampL: frames, upper: uppers, pillowU: uppers, ladder: uppers, lampU: uppers };
    for (const [p, m] of meshes.current) { m.count = count[p]; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; m.computeBoundingSphere(); }
  }, [models, beds, frames, uppers]);

  const matOf = (p: Part) => (p === "lower" || p === "upper" ? mats.mattress : p === "pillowL" || p === "pillowU" ? mats.pillow : p === "lampL" || p === "lampU" ? mats.lamp : mats.frame);
  return <>{(Object.keys(geos) as Part[]).map((p) => <instancedMesh key={`${p}:${cap}`} ref={(m) => { if (m) meshes.current.set(p, m); else meshes.current.delete(p); }}
    args={[geos[p], matOf(p), cap]} castShadow={!!q.shadows && p !== "lampL" && p !== "lampU"} receiveShadow={!!q.shadows} />)}</>;
});

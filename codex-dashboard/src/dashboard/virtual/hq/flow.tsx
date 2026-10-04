"use client";
/**
 * Information flow through the headquarters — a hero feature, and strictly truthful. Every flow here is one recorded
 * FleetController event (or one difference between two authoritative readings) — world.ts packetFor; there is no idle
 * or decorative traffic. Each real event plays one choreography along the building's data conduits (route.ts):
 *
 *   1. ACTIVATE  the source terminal lights up (a light column and ring);
 *   2. REVEAL    the conduit illuminates progressively from the source;
 *   3. TRAVEL    a labelled, haloed packet runs the route; junctions pulse as it passes;
 *   4. RECEIVE   the destination acknowledges (column + ring pulse); the Treasury banner acknowledges Treasury flows;
 *   5. SETTLE    the route fades back to ambient.
 *
 * Reduce Motion: nothing travels — the route is shown lit with direction chevrons, both ends marked, the label at the
 * destination, for the same time. Data Flow off: no routes or packets, but each event is still acknowledged at its
 * destination with its label (the information is never suppressed, only the animation).
 */
import { useFrame } from "@react-three/fiber";
import { memo, useEffect, useMemo, useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import type { Packet } from "../world";
import { along, pathLength, roomAt, routeThrough } from "./route";
import type { HQProfile } from "./quality";

/** The board-style label for each kind of information (the event's own label when there is no better name). */
export function flowLabel(p: Pick<Packet, "kind" | "label" | "points">): string {
  switch (p.kind) {
    case "REVENUE_EVENT": return "SALE RECORDED";
    case "TREASURY_TRANSFER": return /genesis/i.test(p.label) ? "CAPITAL ALLOCATED" : /profit|sweep/i.test(p.label) ? "TREASURY SWEEP" : "SETTLEMENT";
    case "CAPITAL_REQUEST_CREATED": return "CAPITAL REQUEST";
    case "CAPITAL_REQUEST_DECIDED": return p.points.length > 2 ? "CAPITAL ALLOCATED" : "CAPITAL DECISION";
    case "RESEARCH_EVENT": return "KNOWLEDGE RECORDED";
    case "OPPORTUNITY_EVENT": return "RESEARCH RESULT";
    case "VENTURE_EVENT": return /project/i.test(p.label) ? p.label.toUpperCase() : "VENTURE UPDATE";
    case "MISSION_STARTED": case "MISSION_COMPLETED": return "MISSION UPDATE";
    case "MARKETING_EVENT": return "CAMPAIGN UPDATE";
    case "SYSTEM_ALERT": return "SECURITY ALERT";
    case "AGENT_BORN": return "AGENT BORN";
    case "AGENT_DIED": return "AGENT DIED";
    case "ESTATE_TRANSFER": return "ESTATE TRANSFER";
    case "EXPENSE_EVENT": return "EXPENSE";
    case "IDENTITY_EVENT": return "IDENTITY UPDATE";
    case "COMMS_EVENT": return "COMMS";
    case "PROJECT_EVENT": return p.label.toUpperCase();
    default: return p.label.toUpperCase().slice(0, 28);
  }
}

/** How long a packet takes along its conduit route (≈7 m/s, 2.5–9 s). */
export const flowDuration = (route: readonly { x: number; z: number }[]) => Math.min(9000, Math.max(2500, (pathLength(route) / 7) * 1000));
/** Choreography timing (ms): source activation + reveal before travel; receive + settle after. */
export const LEAD_MS = 800, SETTLE_MS = 1400;

export interface Flow { id: string; route: { x: number; z: number }[]; start: number; duration: number; colour: string; label: string }
export type FlowMode = "full" | "reduced" | "off";
type P2 = { x: number; z: number };

/** What one moment of the information flow shows — pure (rendering only draws this), so it is unit-tested. */
export interface FlowFrame {
  /** Packet heads travelling (only in full mode). */
  heads: Array<{ id: string; p: P2; k: number }>;
  /** Lit routes: the fraction revealed from the source (1 = whole route) and brightness. */
  routes: Array<{ id: string; reveal: number; fade: number }>;
  /** Endpoint rings: activation and receipt pulses, or static source/destination marks under Reduce Motion. */
  rings: Array<{ id: string; p: P2; scale: number; strength: number }>;
  /** Light columns at the source (activation) and destination (receipt). */
  columns: Array<{ id: string; p: P2; strength: number }>;
  /** Junction pulses at route corners the packet has just passed. */
  junctions: Array<{ id: string; p: P2; strength: number }>;
  /** Static direction chevrons (Reduce Motion only). */
  chevrons: Array<{ id: string; p: P2; dir: P2 }>;
  /** Labels: riding with the packet, or at the destination when nothing travels. */
  labels: Array<{ id: string; text: string; p: P2; y: number }>;
  /** Flows whose destination is acknowledging right now (e.g. the Treasury banner). */
  receiving: Array<{ id: string; p: P2 }>;
}

export function flowFrame(flows: readonly Flow[], now: number, mode: FlowMode | boolean): FlowFrame {
  const m: FlowMode = mode === true ? "reduced" : mode === false ? "full" : mode;
  const out: FlowFrame = { heads: [], routes: [], rings: [], columns: [], junctions: [], chevrons: [], labels: [], receiving: [] };
  for (const f of flows) {
    const age = now - f.start, total = LEAD_MS + f.duration;
    if (age < 0 || age >= total + SETTLE_MS) continue;
    const src = f.route[0], dst = f.route[f.route.length - 1];
    if (m !== "full") {
      if (age >= total) continue; // the same lifetime, no motion
      out.labels.push({ id: f.id, text: f.label, p: dst, y: 2.6 });
      out.rings.push({ id: f.id, p: dst, scale: 1.25, strength: 1 });
      out.columns.push({ id: f.id, p: dst, strength: 0.6 });
      out.receiving.push({ id: f.id, p: dst });
      if (m === "off") continue;
      out.routes.push({ id: f.id, reveal: 1, fade: 1 });
      out.rings.push({ id: f.id, p: src, scale: 1, strength: 1 });
      const L = pathLength(f.route);
      for (let s = 1.25; s < L; s += 2.5) { const a = along(f.route, s / L); out.chevrons.push({ id: f.id, p: a.p, dir: a.dir }); }
      continue;
    }
    // 1–2. Activation and progressive reveal.
    if (age < LEAD_MS + 600) out.columns.push({ id: f.id, p: src, strength: Math.max(0, 1 - Math.max(0, age - LEAD_MS) / 600) });
    if (age < LEAD_MS) {
      out.rings.push({ id: f.id, p: src, scale: 0.6 + (age / LEAD_MS) * 1.2, strength: 1 });
      out.routes.push({ id: f.id, reveal: Math.min(1, age / LEAD_MS), fade: 1 });
      continue;
    }
    const tAge = age - LEAD_MS;
    if (tAge < f.duration) {
      // 3. Travel; junctions that the packet passed within the last 600 ms pulse.
      const k = tAge / f.duration, L = pathLength(f.route), at = along(f.route, k).p;
      out.routes.push({ id: f.id, reveal: 1, fade: 1 });
      out.heads.push({ id: f.id, p: at, k });
      out.labels.push({ id: f.id, text: f.label, p: at, y: 1.55 });
      let acc = 0;
      for (let i = 1; i < f.route.length - 1; i++) {
        acc += Math.hypot(f.route[i].x - f.route[i - 1].x, f.route[i].z - f.route[i - 1].z);
        const passedAt = (acc / L) * f.duration;
        if (tAge >= passedAt && tAge - passedAt < 600) out.junctions.push({ id: f.id, p: f.route[i], strength: 1 - (tAge - passedAt) / 600 });
      }
      continue;
    }
    // 4–5. Receive, then settle.
    const after = tAge - f.duration, q = after / SETTLE_MS;
    out.routes.push({ id: f.id, reveal: 1, fade: Math.max(0, 1 - q) });
    out.rings.push({ id: f.id, p: dst, scale: 0.6 + q * 1.8, strength: 1 - q });
    out.columns.push({ id: f.id, p: dst, strength: 1 - q });
    if (after < 900) { out.labels.push({ id: f.id, text: f.label, p: dst, y: 2.2 }); out.receiving.push({ id: f.id, p: dst }); }
  }
  return out;
}

const Y = 0.32, TRAIL = 7;

const labelCache = new Map<string, THREE.CanvasTexture>();
function labelTexture(text: string, colour: string): THREE.CanvasTexture {
  const key = `${text}|${colour}`;
  const hit = labelCache.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas"); c.width = 512; c.height = 96;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(2,8,18,0.88)"; g.beginPath(); g.roundRect(4, 14, 504, 68, 12); g.fill();
  g.strokeStyle = colour; g.lineWidth = 3; g.stroke();
  g.fillStyle = colour; g.fillRect(18, 34, 10, 28);
  g.font = "bold 34px ui-monospace, Menlo, monospace"; g.textBaseline = "middle"; g.fillStyle = "#e2e8f0";
  g.fillText(text.length > 24 ? `${text.slice(0, 23)}…` : text, 42, 49);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  if (labelCache.size > 64) { for (const v of labelCache.values()) v.dispose(); labelCache.clear(); }
  labelCache.set(key, t);
  return t;
}

export const DataFlow = memo(function DataFlow({ packets, enabled, reduceMotion, q, receivedRef }: {
  packets: Packet[]; enabled: boolean; reduceMotion: boolean; q: HQProfile;
  /** Set to the time a flow arrives at a room (by department id), so the room's displays can acknowledge it. */
  receivedRef?: MutableRefObject<Map<string, number>>;
}) {
  const routes = useRef(new Map<string, Flow>());
  const live = useRef<Flow[]>([]);
  useEffect(() => {
    const next = new Map<string, Flow>();
    for (const p of packets) {
      const old = routes.current.get(p.id);
      if (old) { next.set(p.id, old); continue; }
      const route = routeThrough(p.points);
      next.set(p.id, { id: p.id, route, start: p.start, duration: flowDuration(route), colour: p.colour, label: flowLabel(p) });
    }
    // A flow still playing keeps going even if the Command Centre has already pruned its packet.
    const now = Date.now();
    for (const [id, f] of routes.current) if (!next.has(id) && now - f.start < LEAD_MS + f.duration + SETTLE_MS) next.set(id, f);
    routes.current = next;
    live.current = [...next.values()];
  }, [packets]);

  const cap = 48;
  const head = useRef<THREE.InstancedMesh>(null), halo = useRef<THREE.InstancedMesh>(null), trail = useRef<THREE.InstancedMesh>(null), rings = useRef<THREE.InstancedMesh>(null);
  const chevrons = useRef<THREE.InstancedMesh>(null), columns = useRef<THREE.InstancedMesh>(null), junctions = useRef<THREE.InstancedMesh>(null);
  const lines = useRef<THREE.LineSegments>(null);
  const labels = useRef<THREE.Group>(null);
  const geo = useMemo(() => ({
    head: new THREE.SphereGeometry(0.17, 16, 12), halo: new THREE.SphereGeometry(0.42, 16, 12), trail: new THREE.SphereGeometry(0.11, 10, 8),
    ring: new THREE.RingGeometry(0.55, 0.75, 40).rotateX(-Math.PI / 2), chevron: new THREE.ConeGeometry(0.16, 0.36, 3).rotateX(Math.PI / 2),
    column: new THREE.CylinderGeometry(0.35, 0.55, 3.2, 20, 1, true).translate(0, 1.6, 0), junction: new THREE.RingGeometry(0.25, 0.42, 24).rotateX(-Math.PI / 2),
    line: new THREE.BufferGeometry(),
  }), []);
  const mat = useMemo(() => {
    const add = (opacity: number, side: THREE.Side = THREE.FrontSide) => new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, side });
    return {
      head: new THREE.MeshBasicMaterial({ toneMapped: false }), halo: add(0.35), trail: add(0.55), ring: add(0.85, THREE.DoubleSide), junction: add(0.9, THREE.DoubleSide),
      column: add(0.32, THREE.DoubleSide), chevron: new THREE.MeshBasicMaterial({ toneMapped: false }),
      line: new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, toneMapped: false, depthWrite: false, blending: THREE.AdditiveBlending }),
    };
  }, []);
  useEffect(() => () => { for (const g of Object.values(geo)) g.dispose(); for (const m of Object.values(mat)) m.dispose(); }, [geo, mat]);
  const m4 = useMemo(() => new THREE.Matrix4(), []), col = useMemo(() => new THREE.Color(), []), q4 = useMemo(() => new THREE.Quaternion(), []), up = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  const s3 = useMemo(() => new THREE.Vector3(), []), p3 = useMemo(() => new THREE.Vector3(), []);
  const linePos = useMemo(() => new Float32Array(4096 * 3), []), lineCol = useMemo(() => new Float32Array(4096 * 3), []);
  useEffect(() => {
    geo.line.setAttribute("position", new THREE.BufferAttribute(linePos, 3));
    geo.line.setAttribute("color", new THREE.BufferAttribute(lineCol, 3));
  }, [geo, linePos, lineCol]);

  useFrame(({ clock, camera }) => {
    const now = Date.now(), t = clock.elapsedTime;
    // Readable at every level: packets grow with the camera's distance (≈ constant size on screen from the Fleet view).
    const zoom = Math.min(7, Math.max(1, camera.position.y / 9));
    const flows = live.current.filter((f) => now - f.start < LEAD_MS + f.duration + SETTLE_MS).slice(-12);
    const fr = flowFrame(flows, now, !enabled ? "off" : reduceMotion ? "reduced" : "full"), byId = new Map(flows.map((f) => [f.id, f]));
    if (receivedRef) for (const r of fr.receiving) { const room = roomAt(r.p); if (room) receivedRef.current.set(room.id, now); }
    const show = (mesh: THREE.InstancedMesh | null, n: number) => { if (mesh) { mesh.count = n; mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true; } };
    // Lit routes, revealed progressively from the source.
    let nv = 0;
    for (const r of fr.routes) {
      const f = byId.get(r.id)!, L = pathLength(f.route);
      col.set(f.colour).multiplyScalar(r.fade);
      let left = r.reveal * L;
      for (let i = 1; i < f.route.length && nv < 4090 && left > 0; i++) {
        const a = f.route[i - 1], b = f.route[i], l = Math.hypot(b.x - a.x, b.z - a.z), k = Math.min(1, left / (l || 1));
        linePos.set([a.x, 0.12, a.z, a.x + (b.x - a.x) * k, 0.12, a.z + (b.z - a.z) * k], nv * 3); lineCol.set([col.r, col.g, col.b, col.r, col.g, col.b], nv * 3);
        nv += 2; left -= l;
      }
    }
    if (lines.current) { geo.line.setDrawRange(0, nv); (geo.line.attributes.position as THREE.BufferAttribute).needsUpdate = true; (geo.line.attributes.color as THREE.BufferAttribute).needsUpdate = true; lines.current.visible = nv > 0; }
    // Rings, junctions, columns, chevrons.
    let n = 0;
    for (const r of fr.rings.slice(0, cap)) { const s = r.scale * Math.sqrt(zoom); m4.compose(p3.set(r.p.x, 0.16, r.p.z), q4.identity(), s3.set(s, 1, s)); rings.current?.setMatrixAt(n, m4); rings.current?.setColorAt(n, col.set(byId.get(r.id)!.colour).multiplyScalar(r.strength)); n++; }
    show(rings.current, n); n = 0;
    for (const j of fr.junctions.slice(0, cap)) { const s = (1 + (1 - j.strength)) * Math.sqrt(zoom); m4.compose(p3.set(j.p.x, 0.15, j.p.z), q4.identity(), s3.set(s, 1, s)); junctions.current?.setMatrixAt(n, m4); junctions.current?.setColorAt(n, col.set(byId.get(j.id)!.colour).multiplyScalar(j.strength)); n++; }
    show(junctions.current, n); n = 0;
    for (const c of fr.columns.slice(0, cap)) { m4.compose(p3.set(c.p.x, 0.12, c.p.z), q4.identity(), s3.set(Math.sqrt(zoom), 1 + c.strength * 0.4, Math.sqrt(zoom))); columns.current?.setMatrixAt(n, m4); columns.current?.setColorAt(n, col.set(byId.get(c.id)!.colour).multiplyScalar(c.strength)); n++; }
    show(columns.current, n); n = 0;
    for (const c of fr.chevrons.slice(0, 600)) { m4.compose(p3.set(c.p.x, Y, c.p.z), q4.setFromAxisAngle(up, Math.atan2(c.dir.x, c.dir.z)), s3.set(zoom * 0.7, 1, zoom * 0.7)); chevrons.current?.setMatrixAt(n, m4); chevrons.current?.setColorAt(n, col.set(byId.get(c.id)!.colour)); n++; }
    show(chevrons.current, n);
    // Packet heads, halos and trails.
    let nh = 0, nt = 0;
    for (const h of fr.heads.slice(0, cap)) {
      const f = byId.get(h.id)!; col.set(f.colour);
      m4.compose(p3.set(h.p.x, Y + Math.sin(t * 8) * 0.03, h.p.z), q4.identity(), s3.set(zoom, zoom, zoom)); head.current?.setMatrixAt(nh, m4); head.current?.setColorAt(nh, col);
      const pulse = zoom * (1 + Math.sin(t * 6) * 0.12); m4.compose(p3, q4.identity(), s3.set(pulse, pulse, pulse)); halo.current?.setMatrixAt(nh, m4); halo.current?.setColorAt(nh, col); nh++;
      if (q.detail >= 1) for (let i = 1; i <= TRAIL; i++) {
        const back = along(f.route, Math.max(0, h.k - (i * 0.6 * zoom) / Math.max(1, pathLength(f.route)))).p, s = (1 - i / (TRAIL + 1)) * zoom;
        m4.compose(p3.set(back.x, Y, back.z), q4.identity(), s3.set(s, s, s)); trail.current?.setMatrixAt(nt, m4); trail.current?.setColorAt(nt, col.clone().multiplyScalar(s / zoom)); nt++;
      }
    }
    show(head.current, nh); show(halo.current, nh); show(trail.current, nt);
    // Labels.
    const kids = labels.current?.children ?? [];
    fr.labels.slice(0, kids.length).forEach((l, i) => {
      const sp = kids[i] as THREE.Sprite, f = byId.get(l.id)!;
      sp.visible = true; sp.position.set(l.p.x, l.y, l.p.z); sp.material.map = labelTexture(l.text, f.colour); sp.material.needsUpdate = true;
    });
    for (let i = fr.labels.length; i < kids.length; i++) kids[i].visible = false;
  });

  return <>
    <instancedMesh ref={head} args={[geo.head, mat.head, cap]} frustumCulled={false} />
    <instancedMesh ref={halo} args={[geo.halo, mat.halo, cap]} frustumCulled={false} />
    <instancedMesh ref={trail} args={[geo.trail, mat.trail, cap * TRAIL]} frustumCulled={false} />
    <instancedMesh ref={rings} args={[geo.ring, mat.ring, cap]} frustumCulled={false} />
    <instancedMesh ref={junctions} args={[geo.junction, mat.junction, cap]} frustumCulled={false} />
    <instancedMesh ref={columns} args={[geo.column, mat.column, cap]} frustumCulled={false} />
    <instancedMesh ref={chevrons} args={[geo.chevron, mat.chevron, 600]} frustumCulled={false} />
    <lineSegments ref={lines} geometry={geo.line} material={mat.line} frustumCulled={false} />
    <group ref={labels}>{Array.from({ length: 12 }, (_, i) => <sprite key={i} visible={false} scale={[0.15, 0.028, 1]} renderOrder={5}><spriteMaterial transparent depthWrite={false} depthTest={false} toneMapped={false} sizeAttenuation={false} /></sprite>)}</group>
  </>;
});

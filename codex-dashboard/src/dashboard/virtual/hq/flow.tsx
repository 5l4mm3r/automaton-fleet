"use client";
/**
 * Information flow through the headquarters. Every packet here is one recorded FleetController event (or one difference
 * between two authoritative readings) — world.ts packetFor; there is no idle or decorative traffic. A packet travels
 * along the building's data conduits (route.ts) from its source to its destination with a short readable label; while
 * it travels, its route lights up, and its endpoints flash on departure and arrival.
 *
 * Reduce Motion: nothing travels. The same information is shown statically for the packet's lifetime — the lit route
 * with direction chevrons, rings at both ends, and the label at the destination.
 */
import { useFrame } from "@react-three/fiber";
import { memo, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { Packet } from "../world";
import { along, pathLength, routeThrough } from "./route";
import type { HQProfile } from "./quality";

/** The board-style label for each kind of information (the event's own label when there is no better name). */
export function flowLabel(p: Pick<Packet, "kind" | "label" | "points">): string {
  switch (p.kind) {
    case "REVENUE_EVENT": return "SALE RECORDED";
    case "TREASURY_TRANSFER": return /genesis/i.test(p.label) ? "CAPITAL ALLOCATED" : /profit/i.test(p.label) ? "PROFIT CONTRIBUTION" : "SETTLEMENT";
    case "CAPITAL_REQUEST_CREATED": return "CAPITAL REQUEST";
    case "CAPITAL_REQUEST_DECIDED": return p.points.length > 2 ? "CAPITAL ALLOCATED" : "CAPITAL DECISION";
    case "RESEARCH_EVENT": return "KNOWLEDGE RECORDED";
    case "OPPORTUNITY_EVENT": return "RESEARCH RESULT";
    case "VENTURE_EVENT": return /project/i.test(p.label) ? p.label.toUpperCase() : "VENTURE UPDATE";
    case "MISSION_STARTED": case "MISSION_COMPLETED": return "MISSION UPDATE";
    case "MARKETING_EVENT": return "CAMPAIGN UPDATE";
    case "SYSTEM_ALERT": return "SYSTEM ALERT";
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

const Y = 0.32, TRAIL = 7;

const labelCache = new Map<string, THREE.CanvasTexture>();
function labelTexture(text: string, colour: string): THREE.CanvasTexture {
  const key = `${text}|${colour}`;
  const hit = labelCache.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas"); c.width = 512; c.height = 96;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(2,8,18,0.86)"; g.beginPath(); g.roundRect(4, 14, 504, 68, 12); g.fill();
  g.strokeStyle = colour; g.lineWidth = 3; g.stroke();
  g.fillStyle = colour; g.fillRect(18, 34, 10, 28);
  g.font = "bold 34px ui-monospace, Menlo, monospace"; g.textBaseline = "middle"; g.fillStyle = "#e2e8f0";
  g.fillText(text.length > 24 ? `${text.slice(0, 23)}…` : text, 42, 49);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  if (labelCache.size > 64) { for (const v of labelCache.values()) v.dispose(); labelCache.clear(); }
  labelCache.set(key, t);
  return t;
}

export interface Flow { id: string; route: { x: number; z: number }[]; start: number; duration: number; colour: string; label: string }

/** What one moment of the information flow shows — pure (rendering only draws this), so it is unit-tested. */
export interface FlowFrame {
  /** Packet heads travelling (none under Reduce Motion). */
  heads: Array<{ id: string; p: { x: number; z: number }; k: number }>;
  /** Lit routes (travelling, or shown statically under Reduce Motion). */
  routes: Array<{ id: string; fade: number }>;
  /** Endpoint rings: departure/arrival flashes, or static source/destination marks under Reduce Motion. */
  rings: Array<{ id: string; p: { x: number; z: number }; scale: number }>;
  /** Static direction chevrons (Reduce Motion only). */
  chevrons: Array<{ id: string; p: { x: number; z: number }; dir: { x: number; z: number } }>;
  /** Labels: riding with the packet, or at the destination under Reduce Motion. */
  labels: Array<{ id: string; text: string; p: { x: number; z: number }; y: number }>;
}

export function flowFrame(flows: readonly Flow[], now: number, reduceMotion: boolean): FlowFrame {
  const out: FlowFrame = { heads: [], routes: [], rings: [], chevrons: [], labels: [] };
  for (const f of flows) {
    const age = now - f.start, travelling = age >= 0 && age < f.duration;
    if (age < 0 || age >= f.duration + 1200) continue;
    const src = f.route[0], dst = f.route[f.route.length - 1];
    if (reduceMotion) {
      if (!travelling) continue;
      out.routes.push({ id: f.id, fade: 1 });
      out.rings.push({ id: f.id, p: src, scale: 1 }, { id: f.id, p: dst, scale: 1.25 });
      const L = pathLength(f.route);
      for (let s = 1.25; s < L; s += 2.5) { const a = along(f.route, s / L); out.chevrons.push({ id: f.id, p: a.p, dir: a.dir }); }
      out.labels.push({ id: f.id, text: f.label, p: dst, y: 2.6 });
      continue;
    }
    out.routes.push({ id: f.id, fade: travelling ? 1 : Math.max(0, 1 - (age - f.duration) / 1200) });
    if (age < 700) out.rings.push({ id: f.id, p: src, scale: 0.6 + (age / 700) * 1.2 });
    if (!travelling) { out.rings.push({ id: f.id, p: dst, scale: 0.6 + ((age - f.duration) / 1200) * 1.6 }); continue; }
    const k = age / f.duration, { p } = along(f.route, k);
    out.heads.push({ id: f.id, p, k });
    out.labels.push({ id: f.id, text: f.label, p, y: 1.55 });
  }
  return out;
}

export const DataFlow = memo(function DataFlow({ packets, enabled, reduceMotion, q }: { packets: Packet[]; enabled: boolean; reduceMotion: boolean; q: HQProfile }) {
  // Routes are computed once per packet.
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
    // A flow still travelling keeps going even if the Command Centre has already pruned its packet.
    const now = Date.now();
    for (const [id, f] of routes.current) if (!next.has(id) && now - f.start < f.duration + 1200) next.set(id, f);
    routes.current = next;
    live.current = [...next.values()];
  }, [packets]);

  const cap = 48;
  const head = useRef<THREE.InstancedMesh>(null), trail = useRef<THREE.InstancedMesh>(null), rings = useRef<THREE.InstancedMesh>(null), chevrons = useRef<THREE.InstancedMesh>(null);
  const lines = useRef<THREE.LineSegments>(null);
  const labels = useRef<THREE.Group>(null);
  const geo = useMemo(() => ({
    head: new THREE.SphereGeometry(0.16, 16, 12), trail: new THREE.SphereGeometry(0.11, 10, 8), ring: new THREE.RingGeometry(0.55, 0.75, 40).rotateX(-Math.PI / 2),
    chevron: new THREE.ConeGeometry(0.16, 0.36, 3).rotateX(Math.PI / 2), line: new THREE.BufferGeometry(),
  }), []);
  const mat = useMemo(() => ({
    head: new THREE.MeshBasicMaterial({ toneMapped: false }),
    trail: new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }),
    ring: new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }),
    chevron: new THREE.MeshBasicMaterial({ toneMapped: false }),
    line: new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, toneMapped: false, depthWrite: false }),
  }), []);
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
    const flows = enabled ? live.current.filter((f) => now - f.start < f.duration + 1200).slice(-12) : [];
    const fr = flowFrame(flows, now, reduceMotion), byId = new Map(flows.map((f) => [f.id, f]));
    const show = (mesh: THREE.InstancedMesh | null, n: number) => { if (mesh) { mesh.count = n; mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true; } };
    // Lit routes.
    let nv = 0;
    for (const r of fr.routes) {
      const f = byId.get(r.id)!; col.set(f.colour).multiplyScalar(0.8 * r.fade);
      for (let i = 1; i < f.route.length && nv < 4090; i++) {
        const a = f.route[i - 1], b = f.route[i];
        linePos.set([a.x, Y - 0.2, a.z, b.x, Y - 0.2, b.z], nv * 3); lineCol.set([col.r, col.g, col.b, col.r, col.g, col.b], nv * 3); nv += 2;
      }
    }
    if (lines.current) { geo.line.setDrawRange(0, nv); (geo.line.attributes.position as THREE.BufferAttribute).needsUpdate = true; (geo.line.attributes.color as THREE.BufferAttribute).needsUpdate = true; lines.current.visible = nv > 0; }
    // Rings, chevrons, heads and their trails.
    let n = 0;
    for (const r of fr.rings.slice(0, cap)) { m4.compose(p3.set(r.p.x, 0.16, r.p.z), q4.identity(), s3.set(r.scale * Math.sqrt(zoom), 1, r.scale * Math.sqrt(zoom))); rings.current?.setMatrixAt(n, m4); rings.current?.setColorAt(n, col.set(byId.get(r.id)!.colour)); n++; }
    show(rings.current, n); n = 0;
    for (const c of fr.chevrons.slice(0, 600)) { m4.compose(p3.set(c.p.x, Y, c.p.z), q4.setFromAxisAngle(up, Math.atan2(c.dir.x, c.dir.z)), s3.set(zoom * 0.7, 1, zoom * 0.7)); chevrons.current?.setMatrixAt(n, m4); chevrons.current?.setColorAt(n, col.set(byId.get(c.id)!.colour)); n++; }
    show(chevrons.current, n);
    let nh = 0, nt = 0;
    for (const h of fr.heads.slice(0, cap)) {
      const f = byId.get(h.id)!; col.set(f.colour);
      m4.compose(p3.set(h.p.x, Y + Math.sin(t * 8) * 0.03, h.p.z), q4.identity(), s3.set(zoom, zoom, zoom)); head.current?.setMatrixAt(nh, m4); head.current?.setColorAt(nh, col); nh++;
      if (q.detail >= 1) for (let i = 1; i <= TRAIL; i++) {
        const back = along(f.route, Math.max(0, h.k - (i * 0.6 * zoom) / Math.max(1, pathLength(f.route)))).p, s = (1 - i / (TRAIL + 1)) * zoom;
        m4.compose(p3.set(back.x, Y, back.z), q4.identity(), s3.set(s, s, s)); trail.current?.setMatrixAt(nt, m4); trail.current?.setColorAt(nt, col.clone().multiplyScalar(s / zoom)); nt++;
      }
    }
    show(head.current, nh); show(trail.current, nt);
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
    <instancedMesh ref={trail} args={[geo.trail, mat.trail, cap * TRAIL]} frustumCulled={false} />
    <instancedMesh ref={rings} args={[geo.ring, mat.ring, cap]} frustumCulled={false} />
    <instancedMesh ref={chevrons} args={[geo.chevron, mat.chevron, 600]} frustumCulled={false} />
    <lineSegments ref={lines} geometry={geo.line} material={mat.line} frustumCulled={false} />
    <group ref={labels}>{Array.from({ length: 12 }, (_, i) => <sprite key={i} visible={false} scale={[0.15, 0.028, 1]} renderOrder={5}><spriteMaterial transparent depthWrite={false} depthTest={false} toneMapped={false} sizeAttenuation={false} /></sprite>)}</group>
  </>;
});

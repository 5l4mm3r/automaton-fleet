"use client";
/**
 * Cinematic information transport — the renderer. It draws only what transport.ts decides (one transport per real
 * recorded FleetController event, scheduled for readability), in the look of the active transport skin
 * (transport-skin.ts). Phases: the source activates, the orb launches UP into the ceiling data pipe, travels the
 * corridors' pipes through the Fleet Command hub — the pipe it is in lights up as it goes (junctions pulse) — drops to
 * the receiver, the destination responds (its displays, the Treasury banner, the receiving agent), and the pipe fades out.
 * A pipe has no opacity of its own (transport.ts pipesOf): with no transport there is nothing to see.
 *
 * Reduce Motion: nothing travels — source, lit route with direction marks, destination and label are shown together,
 * and the destination still responds. Data Flow off: no route or orb, but the destination still acknowledges with the
 * label (the information is never suppressed). No event, no traffic.
 */
import { useFrame } from "@react-three/fiber";
import { memo, useEffect, useMemo, useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import type { Packet } from "../world";
import { pathLength, pipeHeight, PIPE_Y } from "./route";
import type { HQProfile } from "./quality";
import { advance, newSchedule, pipesOf, slotsFor, toTransport, transportFrame, transportLabel, travelTime, type Transport } from "./transport";
import { transportSkin } from "./transport-skin";

/** Compatibility names (labels and timing now live in transport.ts). */
export const flowLabel = transportLabel;
export const flowDuration = travelTime;

const LABELS = 14, LIGHTS = 4, CAP = 48, RIBBONS = 900, PIECE = 0.8;

const labelCache = new Map<string, THREE.CanvasTexture>();
function labelTexture(text: string, colour: string): THREE.CanvasTexture {
  const key = `${text}|${colour}`;
  const hit = labelCache.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas"); c.width = 512; c.height = 96;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(2,8,18,0.9)"; g.beginPath(); g.roundRect(4, 14, 504, 68, 12); g.fill();
  g.strokeStyle = colour; g.lineWidth = 3; g.stroke();
  g.fillStyle = colour; g.fillRect(18, 34, 10, 28);
  g.font = "bold 34px ui-monospace, Menlo, monospace"; g.textBaseline = "middle"; g.fillStyle = "#e2e8f0";
  g.fillText(text.length > 24 ? `${text.slice(0, 23)}…` : text, 42, 49);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  if (labelCache.size > 64) { for (const v of labelCache.values()) v.dispose(); labelCache.clear(); }
  labelCache.set(key, t);
  return t;
}

export interface TransportDirector { offer(t: Transport): void }

export const DataFlow = memo(function DataFlow({ packets, enabled, reduceMotion, q, receivedRef, directorRef, skin = "tube-orb", statsRef }: {
  packets: Packet[]; enabled: boolean; reduceMotion: boolean; q: HQProfile;
  /** When a transport last reached each room ("<dept>") or agent ("agent:<id>") — their displays and people respond. */
  receivedRef?: MutableRefObject<Map<string, number>>;
  /** Diagnostics: active / queued / not-animated transport counts. */
  statsRef?: MutableRefObject<{ transports: number; queued: number; dropped: number }>;
  /** The optional event camera (only important transports are offered; it decides whether to follow). */
  directorRef?: MutableRefObject<TransportDirector | null>;
  skin?: string;
}) {
  const look = transportSkin(skin);
  const schedule = useRef(newSchedule()), incoming = useRef<Transport[]>([]), offered = useRef(new Set<string>()), signalled = useRef(new Set<string>());
  useEffect(() => { const now = Date.now(); incoming.current.push(...packets.map((p) => toTransport(p, now))); }, [packets]);

  const ribbons = useRef<THREE.InstancedMesh>(null), orb = useRef<THREE.InstancedMesh>(null), halo = useRef<THREE.InstancedMesh>(null), trail = useRef<THREE.InstancedMesh>(null);
  const rings = useRef<THREE.InstancedMesh>(null), columns = useRef<THREE.InstancedMesh>(null), chevrons = useRef<THREE.InstancedMesh>(null);
  const labels = useRef<THREE.Group>(null), lights = useRef<THREE.Group>(null);
  const geo = useMemo(() => ({
    ribbon: new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 1, true).rotateZ(Math.PI / 2) /* a pipe piece along +x, scaled per piece */, orb: new THREE.SphereGeometry(1, 16, 12), halo: new THREE.SphereGeometry(1, 16, 12), trail: new THREE.SphereGeometry(1, 10, 8),
    ring: new THREE.RingGeometry(0.55, 0.75, 40).rotateX(-Math.PI / 2), column: new THREE.CylinderGeometry(0.35, 0.55, 3.2, 20, 1, true).translate(0, 1.6, 0),
    chevron: new THREE.ConeGeometry(0.16, 0.36, 3).rotateX(Math.PI / 2),
  }), []);
  const mat = useMemo(() => {
    const add = (opacity: number, side: THREE.Side = THREE.FrontSide) => new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, side });
    return { ribbon: add(0.9), orb: new THREE.MeshBasicMaterial({ toneMapped: false }), halo: add(0.32), trail: add(0.5), ring: add(0.85, THREE.DoubleSide), column: add(0.3, THREE.DoubleSide), chevron: new THREE.MeshBasicMaterial({ toneMapped: false }) };
  }, []);
  useEffect(() => () => { for (const g of Object.values(geo)) g.dispose(); for (const m of Object.values(mat)) m.dispose(); }, [geo, mat]);
  const m4 = useMemo(() => new THREE.Matrix4(), []), col = useMemo(() => new THREE.Color(), []), tcol = useMemo(() => new THREE.Color(), []), q4 = useMemo(() => new THREE.Quaternion(), []), up = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  const s3 = useMemo(() => new THREE.Vector3(), []), p3 = useMemo(() => new THREE.Vector3(), []), d3 = useMemo(() => new THREE.Vector3(), []), x3 = useMemo(() => new THREE.Vector3(1, 0, 0), []);

  useFrame(({ camera }) => {
    const now = Date.now();
    const zoom = Math.min(7, Math.max(1, camera.position.y / 9)); // readable from the Fleet view
    const s = advance(schedule.current, incoming.current.splice(0), now, slotsFor(q.detail, reduceMotion));
    if (statsRef) { statsRef.current.transports = s.active.length; statsRef.current.queued = s.queue.length; statsRef.current.dropped = s.dropped; }
    const fr = transportFrame(s.active, now, !enabled ? "off" : reduceMotion ? "reduced" : "full"), byId = new Map(s.active.map((t) => [t.id, t]));
    // Responses (after arrival only): the destination room's displays and the receiving agent react.
    if (receivedRef) {
      const rec = receivedRef.current, once = signalled.current;
      for (const r of fr.responding) {
        if (r.room) rec.set(r.room, now); // the room's displays stay lit through the response
        if (r.agentId && !once.has(`r:${r.id}`)) { once.add(`r:${r.id}`); rec.set(`agent:${r.agentId}`, now); } // the receiver reacts once
      }
      // The sender's terminal confirms once as its event launches (a delivery or completion: the completion gesture).
      for (const a of fr.activating) if (!once.has(`s:${a.id}`)) { once.add(`s:${a.id}`); rec.set(a.done ? `done:${a.agentId}` : `send:${a.agentId}`, now); }
      if (once.size > 400) signalled.current = new Set([...once].filter((k) => byId.has(k.slice(2))));
    }
    // The event camera is offered important transports as they launch.
    if (directorRef?.current) for (const t of s.active) if (t.importance !== "low" && !offered.current.has(t.id)) { offered.current.add(t.id); directorRef.current.offer(t); }
    if (offered.current.size > 500) offered.current = new Set(s.active.map((t) => t.id));
    const show = (mesh: THREE.InstancedMesh | null, n: number) => { if (mesh) { mesh.count = n; mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true; } };

    // The ceiling pipes: only along routes being presented, lit up to the orb, a faint preview of the rest, faded by the
    // transport's glow (pipesOf). Each route is drawn in short pieces at the pipe's height (dropping at the ends).
    let n = 0;
    const piece = (a: { x: number; z: number }, ya: number, b: { x: number; z: number }, yb: number, c: THREE.Color, r: number) => {
      d3.set(b.x - a.x, yb - ya, b.z - a.z); const l = d3.length(); if (l < 0.01 || n >= RIBBONS) return;
      m4.compose(p3.set((a.x + b.x) / 2, (ya + yb) / 2, (a.z + b.z) / 2), q4.setFromUnitVectors(x3, d3.normalize()), s3.set(l, r, r));
      ribbons.current?.setMatrixAt(n, m4); ribbons.current?.setColorAt(n, c); n++;
    };
    const pipeR = 0.22 * look.route.width * Math.sqrt(zoom); // diameter (m): a ~22 cm pipe, thicker from far views
    for (const pv of pipesOf(fr)) {
      const t = byId.get(pv.id)!, L = pathLength(t.route), lit = pv.lit * L;
      const bright = col.set(t.colour).multiplyScalar(pv.opacity).clone(), dim = col.set(t.colour).multiplyScalar(look.route.preview * Math.max(pv.opacity, 0.4) * pv.opacity).clone();
      let acc = 0;
      for (let i = 1; i < t.route.length; i++) {
        const a = t.route[i - 1], b = t.route[i], l = Math.hypot(b.x - a.x, b.z - a.z), steps = Math.max(1, Math.ceil(l / PIECE));
        for (let j = 0; j < steps; j++) {
          const s0 = acc + (l * j) / steps, s1 = acc + (l * (j + 1)) / steps;
          const pa = { x: a.x + ((b.x - a.x) * j) / steps, z: a.z + ((b.z - a.z) * j) / steps }, pb = { x: a.x + ((b.x - a.x) * (j + 1)) / steps, z: a.z + ((b.z - a.z) * (j + 1)) / steps };
          piece(pa, pipeHeight(s0, L), pb, pipeHeight(s1, L), s1 <= lit ? bright : s0 >= lit ? dim : bright, pipeR);
        }
        acc += l;
      }
    }
    show(ribbons.current, n);
    // Sources, receivers (columns + rings at the pipe's floor ends) and junctions (pulsing in the pipe as the orb passes).
    let nr = 0, nc = 0;
    const ring = (p: { x: number; z: number }, scale: number, c: THREE.Color, y = 0.16) => { if (nr >= CAP) return; const sc = scale * Math.sqrt(zoom); m4.compose(p3.set(p.x, y, p.z), q4.identity(), s3.set(sc, 1, sc)); rings.current?.setMatrixAt(nr, m4); rings.current?.setColorAt(nr, c); nr++; };
    const column = (p: { x: number; z: number }, strength: number, c: THREE.Color) => { if (nc >= CAP || !look.ends.column) return; m4.compose(p3.set(p.x, 0.12, p.z), q4.identity(), s3.set(Math.sqrt(zoom), 0.6 + strength * 0.6, Math.sqrt(zoom))); columns.current?.setMatrixAt(nc, m4); columns.current?.setColorAt(nc, c); nc++; };
    for (const x of fr.sources) { const c = col.set(byId.get(x.id)!.colour).multiplyScalar(x.strength); column(x.p, x.strength, c); if (look.ends.ring) ring(x.p, 0.7 + x.strength * 0.6, c); }
    for (const x of fr.receivers) { const c = col.set(byId.get(x.id)!.colour).multiplyScalar(x.strength); column(x.p, x.strength, c); ring(x.p, x.phase === "arrive" ? 0.8 + x.strength : 1.4 + (1 - x.strength) * 1.5, c); }
    for (const x of fr.junctions) { const t = byId.get(x.id)!; ring(x.p, 0.35 + (1 - x.strength) * 0.4, col.set(t.colour).multiplyScalar(x.strength), pipeHeight(distAlong(t.route, x.p), pathLength(t.route))); }
    show(rings.current, nr); show(columns.current, nc);
    n = 0;
    for (const c of fr.chevrons.slice(0, 600)) {
      const t = byId.get(c.id)!, y = pipeHeight(distAlong(t.route, c.p), pathLength(t.route)) - 0.02;
      m4.compose(p3.set(c.p.x, y, c.p.z), q4.setFromAxisAngle(up, Math.atan2(c.dir.x, c.dir.z)), s3.set(zoom * 0.7, 1, zoom * 0.7)); chevrons.current?.setMatrixAt(n, m4); chevrons.current?.setColorAt(n, col.set(t.colour)); n++;
    }
    show(chevrons.current, n);
    // Orbs inside the pipe (at its height along the route), halos, trails and the light that travels with the most
    // important ones.
    let no = 0, nt = 0;
    const lightKids = lights.current?.children ?? [];
    const lit = [...fr.orbs].sort((a, b) => byId.get(a.id)!.priority - byId.get(b.id)!.priority);
    const orbY = new Map<string, number>();
    for (const o of fr.orbs.slice(0, CAP)) {
      const t = byId.get(o.id)!, L = Math.max(1e-6, pathLength(t.route)), r = look.orb.radius * Math.sqrt(zoom), y = pipeHeight(o.k * L, L);
      orbY.set(o.id, y);
      col.set(t.colour);
      m4.compose(p3.set(o.p.x, y, o.p.z), q4.identity(), s3.set(r, r, r)); orb.current?.setMatrixAt(no, m4); orb.current?.setColorAt(no, col);
      m4.compose(p3, q4.identity(), s3.set(r * look.orb.halo, r * look.orb.halo, r * look.orb.halo)); halo.current?.setMatrixAt(no, m4); halo.current?.setColorAt(no, col); no++;
      for (let i = 1; i <= look.orb.trail && q.detail >= 1; i++) {
        const back = (o.k - (i * 0.45 * zoom) / L), f = 1 - i / (look.orb.trail + 1);
        if (back < 0) break;
        const bp = t.route.length ? pointAt(t.route, back) : o.p;
        m4.compose(p3.set(bp.x, pipeHeight(back * L, L), bp.z), q4.identity(), s3.set(r * 0.75 * f, r * 0.75 * f, r * 0.75 * f)); trail.current?.setMatrixAt(nt, m4); trail.current?.setColorAt(nt, tcol.copy(col).multiplyScalar(f)); nt++;
      }
    }
    show(orb.current, no); show(halo.current, no); show(trail.current, nt);
    lightKids.forEach((l, i) => {
      const o = lit[i], pl = l as THREE.PointLight;
      if (!o || !look.light.intensity) { pl.intensity = 0; return; } // (a constant light count: no shader recompiles)
      const t = byId.get(o.id)!, ahead = look.light.ahead ? o.ahead : o.p;
      pl.color.set(t.colour); pl.intensity = look.light.intensity * (t.category === "money" ? 1.5 : t.category === "alert" ? 1.3 : 0.8);
      pl.position.set((o.p.x + ahead.x) / 2, (orbY.get(o.id) ?? PIPE_Y) - 0.3, (o.p.z + ahead.z) / 2);
    });
    // Labels.
    const kids = labels.current?.children ?? [];
    fr.labels.slice(0, kids.length).forEach((l, i) => {
      const sp = kids[i] as THREE.Sprite, t = byId.get(l.id)!;
      // A travelling orb's label rides just under its pipe; the others keep the frame's height.
      const y = orbY.has(l.id) && fr.orbs.some((o) => o.id === l.id && o.p === l.p) ? orbY.get(l.id)! - 0.55 : l.y;
      sp.visible = true; sp.position.set(l.p.x, y, l.p.z); sp.material.map = labelTexture(l.text, t.colour); sp.material.needsUpdate = true;
    });
    for (let i = fr.labels.length; i < kids.length; i++) kids[i].visible = false;
  });

  return <>
    <instancedMesh ref={ribbons} args={[geo.ribbon, mat.ribbon, RIBBONS]} frustumCulled={false} />
    <instancedMesh ref={orb} args={[geo.orb, mat.orb, CAP]} frustumCulled={false} />
    <instancedMesh ref={halo} args={[geo.halo, mat.halo, CAP]} frustumCulled={false} />
    <instancedMesh ref={trail} args={[geo.trail, mat.trail, CAP * 16]} frustumCulled={false} />
    <instancedMesh ref={rings} args={[geo.ring, mat.ring, CAP]} frustumCulled={false} />
    <instancedMesh ref={columns} args={[geo.column, mat.column, CAP]} frustumCulled={false} />
    <instancedMesh ref={chevrons} args={[geo.chevron, mat.chevron, 600]} frustumCulled={false} />
    {q.roomLights && <group ref={lights}>{Array.from({ length: LIGHTS }, (_, i) => <pointLight key={i} intensity={0} distance={look.light.distance} decay={1.6} />)}</group>}
    <group ref={labels}>{Array.from({ length: LABELS }, (_, i) => <sprite key={i} visible={false} scale={[0.15, 0.028, 1]} renderOrder={5}><spriteMaterial transparent depthWrite={false} depthTest={false} toneMapped={false} sizeAttenuation={false} /></sprite>)}</group>
  </>;
});

/** How far along a route (m) the route point closest to `p` lies. */
function distAlong(route: readonly { x: number; z: number }[], p: { x: number; z: number }) {
  let best = Infinity, at = 0, acc = 0;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1], b = route[i], dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz, l = Math.sqrt(l2);
    const k = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
    const d = Math.hypot(a.x + dx * k - p.x, a.z + dz * k - p.z);
    if (d < best) { best = d; at = acc + l * k; }
    acc += l;
  }
  return at;
}

function pointAt(route: readonly { x: number; z: number }[], k: number) {
  const L = pathLength(route);
  let left = Math.max(0, Math.min(1, k)) * L;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1], b = route[i], l = Math.hypot(b.x - a.x, b.z - a.z);
    if (left <= l) { const f = l ? left / l : 0; return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f }; }
    left -= l;
  }
  return route[route.length - 1];
}

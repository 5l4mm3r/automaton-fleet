"use client";
/**
 * Cinematic information transport — the renderer. It draws only what transport.ts decides (one transport per real
 * recorded FleetController event, scheduled for readability), in the look of the active transport skin
 * (transport-skin.ts). Phases: the source activates, the orb launches, travels the building's conduits lighting the
 * route as it goes (junctions pulse), arrives at the receiver, the destination responds (its displays, the Treasury
 * banner, the receiving agent), and the route settles back to ambient.
 *
 * Reduce Motion: nothing travels — source, lit route with direction marks, destination and label are shown together,
 * and the destination still responds. Data Flow off: no route or orb, but the destination still acknowledges with the
 * label (the information is never suppressed). No event, no traffic.
 */
import { useFrame } from "@react-three/fiber";
import { memo, useEffect, useMemo, useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import type { Packet } from "../world";
import { pathLength, roomAt } from "./route";
import type { HQProfile } from "./quality";
import { advance, newSchedule, slotsFor, toTransport, transportFrame, transportLabel, travelTime, type Transport } from "./transport";
import { transportSkin } from "./transport-skin";

/** Compatibility names (labels and timing now live in transport.ts). */
export const flowLabel = transportLabel;
export const flowDuration = travelTime;

const Y = 0.12, LABELS = 14, LIGHTS = 4, CAP = 48, RIBBONS = 600;

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
    ribbon: new THREE.BoxGeometry(1, 0.02, 0.12), orb: new THREE.SphereGeometry(1, 16, 12), halo: new THREE.SphereGeometry(1, 16, 12), trail: new THREE.SphereGeometry(1, 10, 8),
    ring: new THREE.RingGeometry(0.55, 0.75, 40).rotateX(-Math.PI / 2), column: new THREE.CylinderGeometry(0.35, 0.55, 3.2, 20, 1, true).translate(0, 1.6, 0),
    chevron: new THREE.ConeGeometry(0.16, 0.36, 3).rotateX(Math.PI / 2),
  }), []);
  const mat = useMemo(() => {
    const add = (opacity: number, side: THREE.Side = THREE.FrontSide) => new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, side });
    return { ribbon: add(0.9), orb: new THREE.MeshBasicMaterial({ toneMapped: false }), halo: add(0.32), trail: add(0.5), ring: add(0.85, THREE.DoubleSide), column: add(0.3, THREE.DoubleSide), chevron: new THREE.MeshBasicMaterial({ toneMapped: false }) };
  }, []);
  useEffect(() => () => { for (const g of Object.values(geo)) g.dispose(); for (const m of Object.values(mat)) m.dispose(); }, [geo, mat]);
  const m4 = useMemo(() => new THREE.Matrix4(), []), col = useMemo(() => new THREE.Color(), []), tcol = useMemo(() => new THREE.Color(), []), q4 = useMemo(() => new THREE.Quaternion(), []), up = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  const s3 = useMemo(() => new THREE.Vector3(), []), p3 = useMemo(() => new THREE.Vector3(), []);

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

    // Lit route ribbons: bright up to the orb, a faint preview of the rest.
    let n = 0;
    const seg = (a: { x: number; z: number }, b: { x: number; z: number }, c: THREE.Color) => {
      const l = Math.hypot(b.x - a.x, b.z - a.z); if (l < 0.01 || n >= RIBBONS) return;
      m4.compose(p3.set((a.x + b.x) / 2, roomAt({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }) ? Y + 0.02 : 0.05, (a.z + b.z) / 2), q4.setFromAxisAngle(up, -Math.atan2(b.z - a.z, b.x - a.x)), s3.set(l, 1, look.route.width * Math.sqrt(zoom)));
      ribbons.current?.setMatrixAt(n, m4); ribbons.current?.setColorAt(n, c); n++;
    };
    for (const r of fr.routes) {
      const t = byId.get(r.id)!, L = pathLength(t.route), lit = r.lit * L;
      const bright = col.set(t.colour).multiplyScalar(r.glow).clone(), dim = col.set(t.colour).multiplyScalar(look.route.preview * Math.max(r.glow, 0.4)).clone();
      let acc = 0;
      for (let i = 1; i < t.route.length; i++) {
        const a = t.route[i - 1], b = t.route[i], l = Math.hypot(b.x - a.x, b.z - a.z);
        if (acc + l <= lit) seg(a, b, bright);
        else if (acc >= lit) seg(a, b, dim);
        else { const k = (lit - acc) / l, m = { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k }; seg(a, m, bright); seg(m, b, dim); }
        acc += l;
      }
    }
    show(ribbons.current, n);
    // Sources, receivers (columns + rings) and junctions.
    let nr = 0, nc = 0;
    const ring = (p: { x: number; z: number }, scale: number, c: THREE.Color) => { if (nr >= CAP) return; const sc = scale * Math.sqrt(zoom); m4.compose(p3.set(p.x, 0.16, p.z), q4.identity(), s3.set(sc, 1, sc)); rings.current?.setMatrixAt(nr, m4); rings.current?.setColorAt(nr, c); nr++; };
    const column = (p: { x: number; z: number }, strength: number, c: THREE.Color) => { if (nc >= CAP || !look.ends.column) return; m4.compose(p3.set(p.x, 0.12, p.z), q4.identity(), s3.set(Math.sqrt(zoom), 0.6 + strength * 0.6, Math.sqrt(zoom))); columns.current?.setMatrixAt(nc, m4); columns.current?.setColorAt(nc, c); nc++; };
    for (const x of fr.sources) { const c = col.set(byId.get(x.id)!.colour).multiplyScalar(x.strength); column(x.p, x.strength, c); if (look.ends.ring) ring(x.p, 0.7 + x.strength * 0.6, c); }
    for (const x of fr.receivers) { const c = col.set(byId.get(x.id)!.colour).multiplyScalar(x.strength); column(x.p, x.strength, c); ring(x.p, x.phase === "arrive" ? 0.8 + x.strength : 1.4 + (1 - x.strength) * 1.5, c); }
    for (const x of fr.junctions) ring(x.p, 0.5 + (1 - x.strength) * 0.6, col.set(byId.get(x.id)!.colour).multiplyScalar(x.strength));
    show(rings.current, nr); show(columns.current, nc);
    n = 0;
    for (const c of fr.chevrons.slice(0, 600)) { m4.compose(p3.set(c.p.x, 0.32, c.p.z), q4.setFromAxisAngle(up, Math.atan2(c.dir.x, c.dir.z)), s3.set(zoom * 0.7, 1, zoom * 0.7)); chevrons.current?.setMatrixAt(n, m4); chevrons.current?.setColorAt(n, col.set(byId.get(c.id)!.colour)); n++; }
    show(chevrons.current, n);
    // Orbs (inside the conduit), halos, trails and the light that travels with the most important ones.
    let no = 0, nt = 0;
    const lightKids = lights.current?.children ?? [];
    const lit = [...fr.orbs].sort((a, b) => byId.get(a.id)!.priority - byId.get(b.id)!.priority);
    for (const o of fr.orbs.slice(0, CAP)) {
      // Inside the glass conduit: on the axis of the deck tubes in corridors, of the raised room tubes inside rooms
      // (lifted with its size from far views, so it never sinks into the floor).
      // In the conduit: a pulse of light under the glass floor window (flattened into the channel, its halo a pool on
      // the floor); from far views it grows so it stays readable, still lying in the floor.
      const inRoom = !!roomAt(o.p), flat = look.orb.inTube ? 0.32 : 1;
      const t = byId.get(o.id)!, r = look.orb.radius * zoom, y = look.orb.inTube ? (inRoom ? 0.145 : 0.055) + r * flat * 0.4 : 0.32 + (zoom - 1) * look.orb.radius * 0.8;
      col.set(t.colour);
      m4.compose(p3.set(o.p.x, y, o.p.z), q4.identity(), s3.set(r, r * flat, r)); orb.current?.setMatrixAt(no, m4); orb.current?.setColorAt(no, col);
      m4.compose(p3, q4.identity(), s3.set(r * look.orb.halo, r * look.orb.halo * flat * 0.6, r * look.orb.halo)); halo.current?.setMatrixAt(no, m4); halo.current?.setColorAt(no, col); no++;
      for (let i = 1; i <= look.orb.trail && q.detail >= 1; i++) {
        const L = Math.max(1, pathLength(t.route)), back = (o.k - (i * 0.45 * zoom) / L), f = 1 - i / (look.orb.trail + 1);
        if (back < 0) break;
        const bp = t.route.length ? pointAt(t.route, back) : o.p;
        m4.compose(p3.set(bp.x, y, bp.z), q4.identity(), s3.set(r * 0.75 * f, r * 0.75 * f * flat, r * 0.75 * f)); trail.current?.setMatrixAt(nt, m4); trail.current?.setColorAt(nt, tcol.copy(col).multiplyScalar(f)); nt++;
      }
    }
    show(orb.current, no); show(halo.current, no); show(trail.current, nt);
    lightKids.forEach((l, i) => {
      const o = lit[i], pl = l as THREE.PointLight;
      if (!o || !look.light.intensity) { pl.intensity = 0; return; } // (a constant light count: no shader recompiles)
      const t = byId.get(o.id)!, ahead = look.light.ahead ? o.ahead : o.p;
      pl.color.set(t.colour); pl.intensity = look.light.intensity * (t.category === "money" ? 1.5 : t.category === "alert" ? 1.3 : 0.8);
      pl.position.set((o.p.x + ahead.x) / 2, 0.8, (o.p.z + ahead.z) / 2);
    });
    // Labels.
    const kids = labels.current?.children ?? [];
    fr.labels.slice(0, kids.length).forEach((l, i) => {
      const sp = kids[i] as THREE.Sprite, t = byId.get(l.id)!;
      sp.visible = true; sp.position.set(l.p.x, l.y, l.p.z); sp.material.map = labelTexture(l.text, t.colour); sp.material.needsUpdate = true;
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

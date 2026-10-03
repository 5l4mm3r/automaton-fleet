"use client";
/**
 * The 3D Command Centre (React Three Fiber / three.js) — loaded only when Virtual opens on a WebGL-capable device and
 * the display settings allow it. Same world as the 2D map (world.ts): agents walk to their departments' slots, packets
 * travel real event routes, rooms and agents open the shared panels.
 *
 * Performance: frameloop "never" + one capped driver (30/60 fps) that stops while the tab is hidden; shared geometries
 * and materials; one instanced mesh for all packets; textures redrawn only when an agent's label or condition changes,
 * and every texture/geometry/material disposed on unmount. A lost WebGL context hands over to the 2D map.
 */
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { memo, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { Projector } from "./AgentLabels";
import * as THREE from "three";
import type { AgentModel } from "../command/agents";
import { DEPARTMENT, DEPARTMENTS, type Department, type DepartmentId } from "../command/departments";
import { BAND_FRAME, PORTRAIT_SIZE, portraitGrid } from "../command/portrait";
import { QUALITY_PROFILE, type VirtualPrefs } from "../command/prefs";
import { focusRect, livePackets, packetAt, type Packet, type Point } from "./world";
import type { Focus } from "./VirtualMap";

function canvasTexture(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void, pixel = false): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  draw(ctx);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  if (pixel) { t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; }
  return t;
}

function portraitTexture(id: string, band: AgentModel["health"]["band"]) {
  const g = portraitGrid(id, band), S = PORTRAIT_SIZE;
  return canvasTexture(S + 2, S + 2, (c) => {
    c.fillStyle = BAND_FRAME[band]; c.fillRect(0, 0, S + 2, S + 2);
    c.fillStyle = "#020617"; c.fillRect(1, 1, S, S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const col = g[y][x]; if (col) { c.fillStyle = col; c.fillRect(x + 1, y + 1, 1, 1); } }
  }, true);
}

interface Shared { body: THREE.CapsuleGeometry; plane: THREE.PlaneGeometry; ring: THREE.RingGeometry; packet: THREE.SphereGeometry; armour: THREE.MeshStandardMaterial; deadArmour: THREE.MeshStandardMaterial }

const AgentFigure = memo(function AgentFigure({ m, target, shared, selected, mountedAt, onAgent, reduceMotion, positionsRef }: {
  m: AgentModel; target: Point; shared: Shared; selected: boolean; mountedAt: number; onAgent: (id: string) => void; reduceMotion: boolean;
  positionsRef: MutableRefObject<Map<string, Point>>;
}) {
  const group = useRef<THREE.Group>(null), head = useRef<THREE.Mesh>(null);
  // Born while the scene is open → walks in from Fleet Command; otherwise appears at its own spot.
  const [start] = useState<Point>(() => (Date.now() - mountedAt > 3000 ? { x: DEPARTMENT.command.x, z: DEPARTMENT.command.z } : { ...target }));
  const pos = useRef<Point>(start);
  const dead = m.agent.status === "dead";
  const face = useMemo(() => portraitTexture(m.agent.id, m.health.band), [m.agent.id, m.health.band]);
  useEffect(() => () => face.dispose(), [face]);
  const faceMat = useMemo(() => new THREE.MeshBasicMaterial({ map: face, transparent: true }), [face]);
  useEffect(() => () => faceMat.dispose(), [faceMat]);
  const id = m.agent.id;
  useEffect(() => () => { positionsRef.current.delete(id); }, [positionsRef, id]);

  useFrame(({ camera }, dt) => {
    const g = group.current;
    if (!g) return;
    const cur = pos.current, dx = target.x - cur.x, dz = target.z - cur.z, dist = Math.hypot(dx, dz), step = 4 * Math.min(dt, 0.1);
    if (reduceMotion || dist <= step) { cur.x = target.x; cur.z = target.z; } else { cur.x += (dx / dist) * step; cur.z += (dz / dist) * step; }
    g.position.set(cur.x, 0, cur.z);
    positionsRef.current.set(id, { x: cur.x, z: cur.z });
    if (dist > step && !reduceMotion) g.rotation.y = Math.atan2(dx, dz);
    head.current?.quaternion.copy(camera.quaternion);
  });

  const click = (e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onAgent(m.agent.id); };
  return <group ref={group} scale={1.6} onClick={click} onPointerOver={() => { document.body.style.cursor = "pointer"; }} onPointerOut={() => { document.body.style.cursor = ""; }}>
    <mesh geometry={shared.body} material={dead ? shared.deadArmour : shared.armour} position={[0, 0.5, 0]} rotation={dead ? [Math.PI / 2, 0, 0] : [0, 0, 0]} castShadow dispose={null} />
    <mesh ref={head} geometry={shared.plane} material={faceMat} position={[0, dead ? 0.45 : 1.25, 0]} scale={0.75} dispose={null} />
    {selected && <mesh geometry={shared.ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]} dispose={null}><meshBasicMaterial color="#e2e8f0" /></mesh>}
  </group>;
});

function Room({ d, onRoom, prefs, focused }: { d: Department; onRoom: (id: DepartmentId) => void; prefs: VirtualPrefs; focused: boolean }) {
  const q = QUALITY_PROFILE[prefs.quality];
  const name = useMemo(() => canvasTexture(768, 96, (c) => { c.fillStyle = d.accent; c.font = "bold 56px ui-monospace, monospace"; c.textBaseline = "middle"; c.fillText(d.name.toUpperCase(), 12, 48); }), [d]);
  // Workstations along the back wall (static set dressing; their monitors glow with the room's accent).
  const desks = useMemo(() => {
    const n = Math.max(2, Math.floor((d.w - 1) / 2.4));
    return Array.from({ length: n }, (_, i) => -d.w / 2 + 1.2 + i * ((d.w - 2.4) / (n - 1)));
  }, [d]);
  useEffect(() => () => name.dispose(), [name]);
  const edges = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(d.w, 0.3, d.d)), [d]);
  useEffect(() => () => edges.dispose(), [edges]);
  const screen = useRef<THREE.MeshStandardMaterial>(null);
  useFrame(({ clock }) => { if (screen.current && prefs.ambient && !prefs.reduceMotion) screen.current.emissiveIntensity = 0.55 + 0.25 * Math.sin(clock.elapsedTime * 1.7 + d.x); });
  const raised = d.id === "command" ? 0.5 : 0;
  return <group position={[d.x, raised, d.z]}>
    <mesh position={[0, 0.15, 0]} receiveShadow onClick={(e) => { e.stopPropagation(); onRoom(d.id); }} onPointerOver={() => { document.body.style.cursor = "pointer"; }} onPointerOut={() => { document.body.style.cursor = ""; }}>
      <boxGeometry args={[d.w, 0.3, d.d]} />
      <meshStandardMaterial color={d.id === "command" ? "#071a2c" : "#08111f"} metalness={0.6} roughness={q.reflections ? 0.35 : 0.8} />
    </mesh>
    <lineSegments geometry={edges} position={[0, 0.15, 0]}><lineBasicMaterial color={d.accent} transparent opacity={focused ? 1 : 0.6} /></lineSegments>
    <mesh position={[0, 0.9, -d.d / 2 + 0.05]} castShadow><boxGeometry args={[d.w, 1.5, 0.12]} /><meshStandardMaterial color="#0b1526" metalness={0.5} roughness={0.7} /></mesh>
    <mesh position={[-d.w / 2 + 3.7, 1.35, -d.d / 2 + 0.13]}><planeGeometry args={[7, 0.875]} /><meshBasicMaterial map={name} transparent /></mesh>
    <mesh position={[0, 0.305, 0]} rotation={[-Math.PI / 2, 0, 0]}><planeGeometry args={[d.w - 0.3, d.d - 0.3]} /><meshStandardMaterial color="#020617" emissive={d.accent} emissiveIntensity={0.06} /></mesh>
    {desks.map((x, i) => <group key={i} position={[x, 0.3, -d.d / 2 + 0.75]}>
      <mesh position={[0, 0.3, 0]} castShadow><boxGeometry args={[1.5, 0.08, 0.6]} /><meshStandardMaterial color="#111c2e" metalness={0.5} roughness={0.6} /></mesh>
      <mesh position={[0, 0.58, -0.18]}><boxGeometry args={[0.9, 0.48, 0.05]} /><meshStandardMaterial color="#020617" emissive={d.accent} emissiveIntensity={0.35} /></mesh>
    </group>)}
    {q.screens && <mesh position={[d.w / 2 - 1.6, 1.0, -d.d / 2 + 0.13]}><planeGeometry args={[2.2, 0.9]} />
      <meshStandardMaterial ref={screen} color="#020617" emissive={d.accent} emissiveIntensity={0.6} /></mesh>}
  </group>;
}

function CommandCore({ prefs }: { prefs: VirtualPrefs }) {
  const rings = useRef<THREE.Group>(null);
  const d = DEPARTMENT.command, q = QUALITY_PROFILE[prefs.quality];
  useFrame((_, dt) => { if (rings.current && prefs.ambient && !prefs.reduceMotion) { rings.current.rotation.y += dt * 0.35; rings.current.rotation.x = 0.25 * Math.sin(rings.current.rotation.y); } });
  return <group position={[d.x, 0.8, d.z]}>
    <mesh position={[0, 0.25, 0]}><cylinderGeometry args={[2.4, 2.8, 0.5, q.segments]} /><meshStandardMaterial color="#0a2236" metalness={0.8} roughness={0.3} /></mesh>
    <mesh position={[0, 1.6, 0]}><sphereGeometry args={[0.6, q.segments, q.segments]} /><meshStandardMaterial color="#082f49" emissive="#38bdf8" emissiveIntensity={1.4} /></mesh>
    <group ref={rings} position={[0, 1.6, 0]}>
      <mesh rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[1.3, 0.05, 8, q.segments * 2]} /><meshBasicMaterial color="#38bdf8" /></mesh>
      <mesh rotation={[0.6, 0, 0]}><torusGeometry args={[1.7, 0.035, 8, q.segments * 2]} /><meshBasicMaterial color="#a78bfa" transparent opacity={0.8} /></mesh>
    </group>
    {q.fog && <mesh position={[0, 4, 0]}><cylinderGeometry args={[0.25, 0.6, 5, q.segments, 1, true]} /><meshBasicMaterial color="#38bdf8" transparent opacity={0.12} side={THREE.DoubleSide} depthWrite={false} /></mesh>}
    <pointLight position={[0, 3, 0]} color="#38bdf8" intensity={30} distance={18} />
  </group>;
}

function Packets({ packets, prefs, geometry }: { packets: Packet[]; prefs: VirtualPrefs; geometry: THREE.SphereGeometry }) {
  const cap = QUALITY_PROFILE[prefs.quality].packets;
  const mesh = useRef<THREE.InstancedMesh>(null);
  const live = useRef(packets);
  useEffect(() => { live.current = packets; }, [packets]);
  const material = useMemo(() => new THREE.MeshBasicMaterial({ toneMapped: false }), []);
  useEffect(() => () => material.dispose(), [material]);
  const m4 = useMemo(() => new THREE.Matrix4(), []), colour = useMemo(() => new THREE.Color(), []);
  useFrame(() => {
    const im = mesh.current;
    if (!im) return;
    const now = Date.now(), shown = prefs.dataFlow && !prefs.reduceMotion ? livePackets(live.current, now, cap) : [];
    let n = 0;
    for (const p of shown) {
      const at = packetAt(p, now);
      if (!at) continue;
      m4.makeTranslation(at.x, 1.1, at.z); im.setMatrixAt(n, m4); im.setColorAt(n, colour.set(p.colour)); n++;
    }
    im.count = n;
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
  });
  return <instancedMesh ref={mesh} args={[geometry, material, cap]} frustumCulled={false} dispose={null} />;
}

function Particles({ prefs }: { prefs: VirtualPrefs }) {
  const count = prefs.ambient && !prefs.reduceMotion ? QUALITY_PROFILE[prefs.quality].particles : 0;
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry(), a = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) { const s = Math.sin(i * 12.9898) * 43758.5453; a[i * 3] = ((s - Math.floor(s)) - 0.5) * 44; a[i * 3 + 1] = ((i * 0.618) % 1) * 9; a[i * 3 + 2] = (((s * 7) % 1) - 0.5) * 44; }
    g.setAttribute("position", new THREE.BufferAttribute(a, 3));
    return g;
  }, [count]);
  useEffect(() => () => geom.dispose(), [geom]);
  const pts = useRef<THREE.Points>(null);
  useFrame((_, dt) => { if (pts.current) pts.current.rotation.y += dt * 0.01; });
  return count ? <points ref={pts} geometry={geom}><pointsMaterial size={0.06} color="#38bdf8" transparent opacity={0.45} depthWrite={false} /></points> : null;
}

/** Camera rig: eases towards the focused rectangle (Fleet → department → agent). */
function CameraRig({ focus, positions, reduceMotion }: { focus: Focus; positions: React.MutableRefObject<Map<string, Point>>; reduceMotion: boolean }) {
  const look = useRef(new THREE.Vector3(0, 0, 2));
  useFrame(({ camera }, dt) => {
    const r = focusRect(focus, positions.current), span = Math.max(r.w, r.d * 1.3);
    const goal = new THREE.Vector3(r.x, span * 0.62 + 2, r.z + span * 0.5), k = reduceMotion ? 1 : Math.min(1, dt * 2.5);
    camera.position.lerp(goal, k);
    look.current.lerp(new THREE.Vector3(r.x, 0, r.z), k);
    camera.lookAt(look.current);
  });
  return null;
}

/** Publishes the world → screen projection for the HTML label layer. */
function ProjectorOut({ projectRef }: { projectRef: MutableRefObject<Projector | null> }) {
  const camera = useThree((s) => s.camera), gl = useThree((s) => s.gl);
  useEffect(() => {
    const v = new THREE.Vector3();
    const project: Projector = (p) => {
      v.set(p.x, 0, p.z).project(camera);
      if (v.z > 1) return null;
      const el = gl.domElement;
      return { x: ((v.x + 1) / 2) * el.clientWidth, y: ((1 - v.y) / 2) * el.clientHeight + 6 };
    };
    projectRef.current = project;
    // Clear only what this scene published (the map may already have taken over).
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

export default function VirtualScene3D({ models, targets, packets, focus, prefs, selected, onRoom, onAgent, onLost, positionsRef, projectRef }: {
  models: AgentModel[]; targets: Map<string, Point>; packets: Packet[]; focus: Focus; prefs: VirtualPrefs; selected: string | null;
  onRoom: (id: DepartmentId) => void; onAgent: (id: string) => void; onLost: () => void;
  positionsRef: MutableRefObject<Map<string, Point>>; projectRef: MutableRefObject<Projector | null>;
}) {
  // This scene's own table of animated positions (published to the label layer; never shared with the map).
  const own = useRef(new Map<string, Point>());
  useEffect(() => { positionsRef.current = own.current; }, [positionsRef]);
  // Unmounting the canvas releases its context on purpose; only a loss while the scene is shown falls back to the map.
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const q = QUALITY_PROFILE[prefs.quality];
  const [mountedAt] = useState(() => Date.now());
  const shared = useMemo<Shared>(() => ({
    body: new THREE.CapsuleGeometry(0.22, 0.5, 4, 8), plane: new THREE.PlaneGeometry(1, 1), ring: new THREE.RingGeometry(0.55, 0.65, 24),
    packet: new THREE.SphereGeometry(0.16, 10, 10),
    armour: new THREE.MeshStandardMaterial({ color: "#1e293b", metalness: 0.6, roughness: 0.45, emissive: "#0e7490", emissiveIntensity: 0.25 }),
    deadArmour: new THREE.MeshStandardMaterial({ color: "#1f2937", metalness: 0.2, roughness: 0.9 }),
  }), []);
  useEffect(() => () => { for (const v of Object.values(shared)) (v as { dispose(): void }).dispose(); }, [shared]);
  const positions = useRef(new Map<string, Point>());
  useEffect(() => { positions.current = targets; }, [targets]);

  return <Canvas frameloop="never" dpr={[1, q.dpr]} shadows={q.shadows} camera={{ position: [0, 28, 24], fov: 45, near: 0.5, far: 200 }}
    gl={{ antialias: prefs.quality !== "low", powerPreference: "high-performance" }}
    onCreated={({ gl, scene }) => {
      scene.background = new THREE.Color("#020617");
      if (q.fog) scene.fog = new THREE.Fog("#020617", 45, 95);
      gl.domElement.addEventListener("webglcontextlost", (e) => { e.preventDefault(); setTimeout(() => { if (alive.current) onLost(); }, 0); });
    }}
    onPointerMissed={() => { document.body.style.cursor = ""; }}>
    <Driver fps={prefs.fps} />
    <ProjectorOut projectRef={projectRef} />
    <CameraRig focus={focus} positions={positions} reduceMotion={prefs.reduceMotion} />
    <ambientLight intensity={0.5} />
    <hemisphereLight args={["#1e3a5f", "#020617", 0.9]} />
    <directionalLight position={[12, 26, 14]} intensity={1.1} castShadow={q.shadows} shadow-mapSize={[1024, 1024]} />
    <pointLight position={[DEPARTMENT.treasury.x, 3, DEPARTMENT.treasury.z]} color="#fbbf24" intensity={18} distance={12} />
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 2]} receiveShadow onClick={() => undefined}>
      <planeGeometry args={[70, 70]} /><meshStandardMaterial color="#030a16" metalness={q.reflections ? 0.7 : 0.2} roughness={q.reflections ? 0.35 : 0.9} />
    </mesh>
    <gridHelper args={[60, 30, "#0e2a3d", "#0a1a2b"]} position={[0, 0.005, 2]} />
    {DEPARTMENTS.map((d) => <Room key={d.id} d={d} onRoom={onRoom} prefs={prefs} focused={focus.level === "department" && focus.id === d.id} />)}
    <CommandCore prefs={prefs} />
    {models.map((m) => {
      const t = targets.get(m.agent.id);
      if (!t) return null;
      return <AgentFigure key={m.agent.id} m={m} target={t} shared={shared} selected={selected === m.agent.id} mountedAt={mountedAt} onAgent={onAgent} reduceMotion={prefs.reduceMotion} positionsRef={own} />;
    })}
    <Packets packets={packets} prefs={prefs} geometry={shared.packet} />
    <Particles prefs={prefs} />
  </Canvas>;
}

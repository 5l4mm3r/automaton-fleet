"use client";
/**
 * Lighting, image-based lighting, post-processing and atmosphere — scaled by quality (quality.ts), never removing the
 * world itself. Also the live pieces of the architecture: the Fleet Command core and the Security beacons (whose state
 * is real: they turn red only while FleetController has unacknowledged RED alerts).
 */
import { useFrame, useThree } from "@react-three/fiber";
import { memo, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { BeaconSpot, LightSpot } from "./world-build";
import type { HQProfile } from "./quality";
import { WORLD } from "../world";

export const Lights = memo(function Lights({ q, lights }: { q: HQProfile; lights: LightSpot[] }) {
  const sun = useRef<THREE.DirectionalLight>(null);
  useEffect(() => {
    const s = sun.current;
    if (!s || !q.shadows) return;
    const cam = s.shadow.camera as THREE.OrthographicCamera;
    cam.left = -48; cam.right = 48; cam.top = 52; cam.bottom = -52; cam.near = 1; cam.far = 160; cam.updateProjectionMatrix();
    s.shadow.mapSize.set(q.shadowMap, q.shadowMap); s.shadow.bias = -0.0004; s.shadow.normalBias = 0.03;
    if (q.shadows === "soft") s.shadow.radius = 3;
  }, [q]);
  return <>
    {/* Without per-room lights (Low, Medium) the fill is stronger, so no level is darker than another. */}
    <ambientLight intensity={!q.pbr ? 1.1 : q.roomLights ? 0.32 : 0.55} color="#9fb4d6" />
    <hemisphereLight args={["#3b5b86", "#05080f", !q.pbr ? 1.0 : q.roomLights ? 0.55 : 0.8]} />
    <directionalLight ref={sun} position={[22, 46, 34]} intensity={!q.pbr ? 1.5 : q.roomLights ? 1.35 : 1.7} color="#dbe7ff" castShadow={!!q.shadows} target-position={[0, 0, 2]} />
    {q.roomLights && lights.map((l) => <pointLight key={l.dep} position={[l.x, l.y, l.z]} color={l.colour} intensity={q.physical ? 9 : 7} distance={13} decay={1.6} />)}
    {q.roomLights && lights.map((l) => <pointLight key={`${l.dep}:fill`} position={[l.x, l.y + 0.2, l.z + 2]} color="#e0f2fe" intensity={3.5} distance={10} decay={1.8} />)}
  </>;
});

/** Image-based lighting (High/Ultra): a soft studio environment for reflections on metal and glass. */
export function Environment({ q }: { q: HQProfile }) {
  const get = useThree((s) => s.get);
  useEffect(() => {
    const { gl, scene } = get();
    if (!q.envLight) { scene.environment = null; return; }
    const pmrem = new THREE.PMREMGenerator(gl);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    (scene as THREE.Scene & { environmentIntensity?: number }).environmentIntensity = q.physical ? 0.42 : 0.3;
    return () => { scene.environment = null; env.dispose(); pmrem.dispose(); };
  }, [get, q.envLight, q.physical]);
  return null;
}

/** Bloom on emissives (High/Ultra); otherwise R3F renders normally. Renders at frame priority 1. */
export function PostFX({ q }: { q: HQProfile }) {
  const { gl, scene, camera, size } = useThree();
  const composer = useMemo(() => {
    if (!q.bloom) return null;
    const c = new EffectComposer(gl);
    c.addPass(new RenderPass(scene, camera));
    c.addPass(new UnrealBloomPass(new THREE.Vector2(size.width, size.height), q.physical ? 0.75 : 0.55, 0.55, 0.82));
    c.addPass(new OutputPass());
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- size handled below
  }, [gl, scene, camera, q.bloom, q.physical]);
  useEffect(() => { composer?.setSize(size.width, size.height); composer?.setPixelRatio(gl.getPixelRatio()); }, [composer, size, gl]);
  useEffect(() => () => composer?.dispose(), [composer]);
  useFrame(() => { if (composer) composer.render(); else gl.render(scene, camera); }, 1);
  return null;
}

/** Ultra: light shafts under ceiling fixtures, haze; High/Ultra: drifting dust (ambient, meaningless motion). */
export const Atmosphere = memo(function Atmosphere({ q, lights, ambient }: { q: HQProfile; lights: LightSpot[]; ambient: boolean }) {
  const get = useThree((s) => s.get);
  useEffect(() => {
    const { scene } = get();
    scene.fog = q.atmosphere ? new THREE.FogExp2("#050a14", 0.0085) : q.pbr ? new THREE.Fog("#050a14", 90, 190) : null;
    return () => { scene.fog = null; };
  }, [get, q.atmosphere, q.pbr]);
  const dust = useMemo(() => {
    if (!q.particles) return null;
    const g = new THREE.BufferGeometry(), a = new Float32Array(q.particles * 3);
    for (let i = 0; i < q.particles; i++) {
      const s = Math.sin(i * 12.9898) * 43758.5453, r = s - Math.floor(s), r2 = (Math.sin(i * 78.233) * 12345.6789) % 1;
      a[i * 3] = WORLD.minX + r * (WORLD.maxX - WORLD.minX); a[i * 3 + 1] = 0.5 + ((i * 0.618) % 1) * 4; a[i * 3 + 2] = WORLD.minZ + Math.abs(r2) * (WORLD.maxZ - WORLD.minZ);
    }
    g.setAttribute("position", new THREE.BufferAttribute(a, 3));
    return g;
  }, [q.particles]);
  useEffect(() => () => dust?.dispose(), [dust]);
  const pts = useRef<THREE.Points>(null);
  useFrame((_, dt) => { if (pts.current && ambient) pts.current.position.y = Math.sin(performance.now() / 4000) * 0.3 + dt * 0; });
  return <>
    {dust && <points ref={pts} geometry={dust}><pointsMaterial size={0.05} color="#7dd3fc" transparent opacity={0.35} depthWrite={false} /></points>}
    {q.atmosphere && lights.map((l) => <mesh key={l.dep} position={[l.x, 1.8, l.z]}><coneGeometry args={[2.6, 3.6, 24, 1, true]} /><meshBasicMaterial color={l.colour} transparent opacity={0.045} side={THREE.DoubleSide} depthWrite={false} blending={THREE.AdditiveBlending} /></mesh>)}
  </>;
});

/** The Fleet Command core on its dais: rotating rings (ambient), a lit core and its light. */
export const CommandCore = memo(function CommandCore({ at, q, ambient }: { at: { x: number; y: number; z: number }; q: HQProfile; ambient: boolean }) {
  const rings = useRef<THREE.Group>(null);
  useFrame((_, dt) => { if (rings.current && ambient) { rings.current.rotation.y += dt * 0.35; rings.current.rotation.x = 0.25 * Math.sin(rings.current.rotation.y); } });
  return <group position={[at.x, at.y + 0.12, at.z]}>
    <mesh position={[0, 0.25, 0]}><cylinderGeometry args={[0.9, 1.1, 0.5, 32]} /><meshStandardMaterial color="#0d2236" metalness={0.8} roughness={0.3} /></mesh>
    <mesh position={[0, 1.7, 0]}><sphereGeometry args={[0.5, 32, 24]} /><meshStandardMaterial color="#082f49" emissive="#38bdf8" emissiveIntensity={q.bloom ? 2.6 : 1.4} toneMapped={!q.bloom} /></mesh>
    <group ref={rings} position={[0, 1.7, 0]}>
      <mesh rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[1.05, 0.04, 8, 64]} /><meshBasicMaterial color="#38bdf8" toneMapped={false} /></mesh>
      <mesh rotation={[0.6, 0, 0]}><torusGeometry args={[1.35, 0.03, 8, 64]} /><meshBasicMaterial color="#a78bfa" toneMapped={false} /></mesh>
    </group>
    <mesh position={[0, 3.6, 0]}><cylinderGeometry args={[0.2, 0.5, 3.6, 24, 1, true]} /><meshBasicMaterial color="#38bdf8" transparent opacity={0.1} side={THREE.DoubleSide} depthWrite={false} blending={THREE.AdditiveBlending} /></mesh>
    <pointLight position={[0, 2.4, 0]} color="#38bdf8" intensity={14} distance={12} decay={1.6} />
  </group>;
});

/** Security beacons: red and pulsing only while there are unacknowledged RED alerts (FleetController's), else steady green. */
export const Beacons = memo(function Beacons({ spots, red, ambient }: { spots: BeaconSpot[]; red: boolean; ambient: boolean }) {
  const mats = useRef<THREE.MeshBasicMaterial[]>([]);
  useFrame(({ clock }) => { for (const m of mats.current) if (m) m.opacity = red && ambient ? 0.55 + 0.45 * Math.abs(Math.sin(clock.elapsedTime * 3)) : 1; });
  return <>{spots.map((b, i) => <mesh key={i} position={[b.x, b.y, b.z]}><cylinderGeometry args={[0.12, 0.12, 0.22, 16]} />
    <meshBasicMaterial ref={(m) => { if (m) mats.current[i] = m; }} color={red ? "#ef4444" : "#22c55e"} transparent toneMapped={false} /></mesh>)}</>;
});

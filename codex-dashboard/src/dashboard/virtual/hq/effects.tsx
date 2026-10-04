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
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { Reflector } from "three/examples/jsm/objects/Reflector.js";
import type { BeaconSpot, LightSpot } from "./world-build";
import type { HQProfile } from "./quality";
import { WORLD } from "../world";
import { DEPARTMENT } from "../../command/departments";

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
  // High/Ultra light the building from inside: a dim cool fill, a moonlit sun, and each room's own lights scaled by its
  // mood (quiet rooms are darker). Low/Medium have no per-room lights, so their fill is stronger.
  const room = q.roomLights;
  return <>
    <ambientLight intensity={!q.pbr ? 1.1 : room ? 0.16 : 0.5} color="#8ea6c8" />
    <hemisphereLight args={["#2c4a72", "#04070d", !q.pbr ? 1.0 : room ? 0.32 : 0.75]} />
    <directionalLight ref={sun} position={[22, 46, 34]} intensity={!q.pbr ? 1.5 : room ? 0.95 : 1.6} color="#c9d8f2" castShadow={!!q.shadows} target-position={[0, 0, 2]} />
    {room && lights.map((l) => <pointLight key={l.dep} position={[l.x, l.y, l.z]} color={l.colour} intensity={(q.physical ? 5 : 4) * l.mood} distance={11} decay={1.7} />)}
    {room && lights.map((l) => <pointLight key={`${l.dep}:fill`} position={[l.x, l.y + 0.2, l.z + 1.5]} color="#f1f5ff" intensity={6 * l.mood} distance={10} decay={1.9} />)}
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

/**
 * Post-processing, renders at frame priority 1. High: restrained bloom on emissives. Ultra: + ground-truth ambient
 * occlusion (contact darkening in corners, under desks and around people), SMAA edges and a soft vignette. Low/Medium:
 * the plain render.
 */
export function PostFX({ q }: { q: HQProfile }) {
  const { gl, scene, camera, size } = useThree();
  const composer = useMemo(() => {
    if (!q.bloom) return null;
    const c = new EffectComposer(gl);
    c.addPass(new RenderPass(scene, camera));
    if (q.physical) {
      const ao = new GTAOPass(scene, camera, size.width, size.height);
      ao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.2, scale: 1.4, samples: 16 });
      ao.blendIntensity = 0.95;
      c.addPass(ao);
    }
    c.addPass(new UnrealBloomPass(new THREE.Vector2(size.width, size.height), q.physical ? 0.42 : 0.32, 0.45, 0.9));
    c.addPass(new OutputPass());
    if (q.physical) { c.addPass(new ShaderPass(VIGNETTE)); c.addPass(new SMAAPass()); }
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- size handled below
  }, [gl, scene, camera, q.bloom, q.physical]);
  useEffect(() => { composer?.setSize(size.width, size.height); composer?.setPixelRatio(gl.getPixelRatio()); }, [composer, size, gl]);
  useEffect(() => () => composer?.dispose(), [composer]);
  useFrame(() => { if (composer) composer.render(); else gl.render(scene, camera); }, 1);
  return null;
}

/** A soft vignette (Ultra): the eye is drawn to the lit centre of the view. */
const VIGNETTE = {
  uniforms: { tDiffuse: { value: null }, strength: { value: 0.32 } },
  vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
  fragmentShader: "uniform sampler2D tDiffuse; uniform float strength; varying vec2 vUv; void main() { vec4 c = texture2D(tDiffuse, vUv); float d = distance(vUv, vec2(0.5)); c.rgb *= 1.0 - strength * smoothstep(0.35, 0.85, d); gl_FragColor = c; }",
};

/**
 * Ultra: real planar reflections on the polished floors — the screens, light housings, glows and people mirrored in
 * the deck, softened (a few blurred taps) and added over the floor material at a restrained strength.
 */
const FLOOR_REFLECTION = {
  name: "HQFloorReflection",
  uniforms: { color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null }, strength: { value: 0.3 } },
  vertexShader: "uniform mat4 textureMatrix; varying vec4 vUv; void main() { vUv = textureMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
  fragmentShader: `uniform vec3 color; uniform sampler2D tDiffuse; uniform float strength; varying vec4 vUv;
    void main() {
      vec2 uv = vUv.xy / vUv.w; vec2 o = vec2(0.0025, 0.004);
      vec3 c = texture2D(tDiffuse, uv).rgb * 0.4 + (texture2D(tDiffuse, uv + o).rgb + texture2D(tDiffuse, uv - o).rgb + texture2D(tDiffuse, uv + vec2(o.x, -o.y)).rgb + texture2D(tDiffuse, uv - vec2(o.x, -o.y)).rgb) * 0.15;
      gl_FragColor = vec4(c * color * strength, 1.0);
    }`,
};
export function FloorReflections({ q }: { q: HQProfile }) {
  const size = useThree((s) => s.size);
  const mirror = useMemo(() => {
    if (!q.reflections) return null;
    const r = new Reflector(new THREE.PlaneGeometry(WORLD.maxX - WORLD.minX + 6, WORLD.maxZ - WORLD.minZ + 6), {
      clipBias: 0.003, textureWidth: Math.round(size.width * 0.6), textureHeight: Math.round(size.height * 0.6), color: 0xbfd6ff, shader: FLOOR_REFLECTION, multisample: 0,
    });
    const m = r.material as THREE.ShaderMaterial;
    m.transparent = true; m.blending = THREE.AdditiveBlending; m.depthWrite = false;
    r.rotation.x = -Math.PI / 2; r.position.set((WORLD.minX + WORLD.maxX) / 2, 0.136, (WORLD.minZ + WORLD.maxZ) / 2); r.renderOrder = 2;
    return r;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- created once per level; size changes keep the texture
  }, [q.reflections]);
  useEffect(() => () => { if (mirror) { mirror.geometry.dispose(); (mirror.material as THREE.Material).dispose(); mirror.getRenderTarget().dispose(); } }, [mirror]);
  return mirror ? <primitive object={mirror} /> : null;
}

/** Pools of light on the floor under each room's ceiling fixtures (Medium and above; soft additive decals). */
export const LightPools = memo(function LightPools({ q, lights }: { q: HQProfile; lights: LightSpot[] }) {
  const tex = useMemo(() => {
    const c = document.createElement("canvas"); c.width = c.height = 128;
    const g = c.getContext("2d")!, grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, "rgba(255,255,255,0.32)"); grd.addColorStop(0.5, "rgba(255,255,255,0.1)"); grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  }, []);
  useEffect(() => () => tex.dispose(), [tex]);
  const pools = useMemo(() => lights.flatMap((l) => {
    const d = DEPARTMENT[l.dep];
    return [-1, 1].flatMap((i) => [0.3, 0.66].map((f) => ({ key: `${l.dep}:${i}:${f}`, x: d.x + (i * d.w) / 4, z: d.z - d.d / 2 + d.d * f, mood: l.mood, colour: l.colour })));
  }), [lights]);
  if (!q.pbr) return null;
  return <>{pools.map((p) => <mesh key={p.key} position={[p.x, 0.135, p.z]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1}>
    <planeGeometry args={[3.0, 2.3]} />
    <meshBasicMaterial map={tex} color={new THREE.Color("#fff3df").lerp(new THREE.Color(p.colour), 0.25).multiplyScalar(0.4 * p.mood)} transparent depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
  </mesh>)}</>;
});

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
    {q.atmosphere && lights.flatMap((l) => { const d = DEPARTMENT[l.dep]; return [-1, 1].map((i) => <mesh key={`${l.dep}:${i}`} position={[d.x + (i * d.w) / 4, 1.8, d.z - d.d / 2 + d.d * 0.3]}><coneGeometry args={[1.25, 3.6, 24, 1, true]} /><meshBasicMaterial color="#e8f1ff" transparent opacity={0.022 * l.mood} side={THREE.DoubleSide} depthWrite={false} blending={THREE.AdditiveBlending} /></mesh>); })}
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

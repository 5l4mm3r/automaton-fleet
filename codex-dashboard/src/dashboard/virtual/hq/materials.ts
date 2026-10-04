/**
 * Headquarters materials — Automaton Fleet's dark navy premium palette; department colours appear only as accents
 * (trims, glows, screens), never as whole flat room surfaces. Surface detail comes from procedural canvas textures
 * (floor tiles, wall panels, corridor plating) whose resolution follows the quality level; Low uses flat colour.
 */
import * as THREE from "three";
import type { MatKey } from "./builder";
import type { HQProfile } from "./quality";

const BASE: Record<string, { color: string; rough: number; metal: number; emissive?: string; emissiveIntensity?: number; transparent?: number; side?: THREE.Side }> = {
  ground: { color: "#04070d", rough: 0.95, metal: 0.1 },
  floor: { color: "#121b2b", rough: 0.55, metal: 0.35 },
  floorDark: { color: "#0b1220", rough: 0.6, metal: 0.4 },
  corridor: { color: "#0d1422", rough: 0.5, metal: 0.45 },
  concrete: { color: "#1a2232", rough: 0.9, metal: 0.05 },
  wall: { color: "#162133", rough: 0.7, metal: 0.25 },
  wallTrim: { color: "#22304a", rough: 0.45, metal: 0.6 },
  metal: { color: "#3a4659", rough: 0.35, metal: 0.8 },
  darkMetal: { color: "#1b2331", rough: 0.4, metal: 0.75 },
  desk: { color: "#202b3d", rough: 0.45, metal: 0.35 },
  fabric: { color: "#151d2b", rough: 0.95, metal: 0 },
  glass: { color: "#7dd3fc", rough: 0.08, metal: 0.1, transparent: 0.16, side: THREE.DoubleSide },
  screen: { color: "#04121c", rough: 0.25, metal: 0.2, emissive: "#0e7490", emissiveIntensity: 0.55 },
  gold: { color: "#b8862b", rough: 0.3, metal: 0.95 },
  paper: { color: "#2b3445", rough: 0.85, metal: 0 },
  rubber: { color: "#0a0d12", rough: 0.95, metal: 0 },
};

/** Procedural tiling textures (canvas), drawn once per quality level. */
function texture(kind: "tiles" | "panels" | "plating", size: number, base: string, line: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  g.fillStyle = base; g.fillRect(0, 0, size, size);
  // Fine deterministic grain.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < size * 6; i++) { g.fillStyle = `rgba(255,255,255,${rnd() * 0.025})`; g.fillRect(rnd() * size, rnd() * size, 1, 1); }
  g.strokeStyle = line; g.lineWidth = Math.max(1, size / 256);
  if (kind === "tiles") { const n = 4, st = size / n; for (let i = 0; i <= n; i++) { g.beginPath(); g.moveTo(i * st, 0); g.lineTo(i * st, size); g.moveTo(0, i * st); g.lineTo(size, i * st); g.stroke(); } }
  if (kind === "panels") { const st = size / 2; for (let i = 0; i <= 2; i++) { g.beginPath(); g.moveTo(i * st, 0); g.lineTo(i * st, size); g.stroke(); } g.beginPath(); g.moveTo(0, size * 0.62); g.lineTo(size, size * 0.62); g.stroke(); }
  if (kind === "plating") { const st = size / 2; g.strokeRect(2, 2, size - 4, size - 4); for (let i = 1; i < 2; i++) { g.beginPath(); g.moveTo(i * st, 0); g.lineTo(i * st, size); g.stroke(); } for (let i = 0; i < 4; i++) { g.fillStyle = "rgba(255,255,255,0.06)"; g.fillRect(6 + i * (size / 4), 6, 3, 3); } }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export interface HQMaterials { get(key: MatKey): THREE.Material; dispose(): void }

/** Materials for one quality level (create once per level; dispose when the level changes). */
export function createMaterials(q: HQProfile): HQMaterials {
  const cache = new Map<MatKey, THREE.Material>();
  const textures: THREE.Texture[] = [];
  const tex = (kind: "tiles" | "panels" | "plating", base: string, line: string, repeat: number) => {
    if (!q.textures) return null;
    const t = texture(kind, q.textures, base, line);
    t.repeat.set(repeat, repeat);
    textures.push(t);
    return t;
  };
  const maps: Partial<Record<string, THREE.Texture | null>> = {
    // World-space UVs (builder): one texture repeat = 2 m.
    floor: tex("tiles", "#121b2b", "rgba(120,160,210,0.16)", 1),
    corridor: tex("plating", "#0d1422", "rgba(140,170,220,0.14)", 1),
    wall: tex("panels", "#162133", "rgba(140,170,220,0.12)", 1),
  };
  const make = (key: MatKey): THREE.Material => {
    if (key.startsWith("accent:") || key.startsWith("glow:")) {
      const colour = key.slice(key.indexOf(":") + 1), glow = key.startsWith("glow:");
      if (!q.pbr) return new THREE.MeshBasicMaterial({ color: glow ? colour : new THREE.Color(colour).multiplyScalar(0.75) });
      return new THREE.MeshStandardMaterial({ color: glow ? "#0a0f18" : colour, emissive: colour, emissiveIntensity: glow ? (q.bloom ? 1.5 : 1.1) : 0.3, roughness: 0.4, metalness: 0.3 });
    }
    const b = BASE[key] ?? BASE.metal;
    const map = maps[key] ?? null;
    if (!q.pbr) {
      // Low: unlit materials over the geometry's baked shading (builder bakeShade) — no per-pixel lighting at all.
      return new THREE.MeshBasicMaterial({ color: new THREE.Color(b.color).multiplyScalar(key === "ground" ? 1 : 2.6), vertexColors: true, transparent: b.transparent !== undefined, opacity: b.transparent ?? 1, side: b.side ?? THREE.FrontSide });
    }
    const opts: THREE.MeshPhysicalMaterialParameters = {
      color: map ? "#ffffff" : b.color, map, roughness: q.reflections && (key === "floor" || key === "corridor") ? Math.max(0.12, b.rough - 0.35) : b.rough,
      metalness: b.metal, emissive: b.emissive ?? "#000000", emissiveIntensity: (b.emissiveIntensity ?? 0) * (q.bloom ? 1.6 : 1),
      transparent: b.transparent !== undefined, opacity: b.transparent ?? 1, side: b.side ?? THREE.FrontSide,
    };
    if (q.physical && (key === "floor" || key === "corridor" || key === "metal")) return new THREE.MeshPhysicalMaterial({ ...opts, clearcoat: 0.6, clearcoatRoughness: 0.25 });
    return new THREE.MeshStandardMaterial(opts);
  };
  return {
    get(key) { let m = cache.get(key); if (!m) { m = make(key); cache.set(key, m); } return m; },
    dispose() { for (const m of cache.values()) m.dispose(); for (const t of textures) t.dispose(); cache.clear(); },
  };
}

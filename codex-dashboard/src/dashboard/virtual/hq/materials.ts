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
  painted: { color: "#25324a", rough: 0.62, metal: 0.3 },
  smokedGlass: { color: "#0b1622", rough: 0.06, metal: 0.2, transparent: 0.55, side: THREE.DoubleSide },
  acrylic: { color: "#9fc7e0", rough: 0.3, metal: 0, emissive: "#5b8fb0", emissiveIntensity: 0.45, transparent: 0.85 },
  polished: { color: "#0c1424", rough: 0.12, metal: 0.55 },
  screenGlass: { color: "#03070c", rough: 0.04, metal: 0.4 },
  equipment: { color: "#202a39", rough: 0.5, metal: 0.55 },
  grille: { color: "#141b27", rough: 0.55, metal: 0.7 },
  cable: { color: "#07090c", rough: 0.7, metal: 0.1 },
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

/**
 * Surface finishes (canvas, drawn once per level): brushed metal (fine directional streaks), matte technical composite
 * (soft mottling), rubber workstation flooring (raised dots) — as a colour-variation map plus a matching roughness map.
 */
function finish(kind: "brushed" | "composite" | "rubberDots" | "vents", size: number): { map: THREE.CanvasTexture; rough: THREE.CanvasTexture } {
  const mk = () => { const c = document.createElement("canvas"); c.width = c.height = size; return c; };
  const cm = mk(), cr = mk(), g = cm.getContext("2d")!, r = cr.getContext("2d")!;
  let seed = kind.length * 977;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.fillStyle = "#ffffff"; g.fillRect(0, 0, size, size); r.fillStyle = "#b0b0b0"; r.fillRect(0, 0, size, size);
  if (kind === "brushed") for (let i = 0; i < size * 3; i++) {
    const y = rnd() * size, a = rnd() * 0.08, len = size * (0.2 + rnd() * 0.8), x = rnd() * size;
    g.fillStyle = `rgba(${rnd() > 0.5 ? "255,255,255" : "0,0,0"},${a})`; g.fillRect(x, y, len, 1);
    r.fillStyle = `rgba(${rnd() > 0.5 ? "255,255,255" : "40,40,40"},${a * 1.5})`; r.fillRect(x, y, len, 1);
  }
  if (kind === "composite") for (let i = 0; i < size * 4; i++) {
    const x = rnd() * size, y = rnd() * size, s = 1 + rnd() * size / 24, a = rnd() * 0.05;
    g.fillStyle = `rgba(${rnd() > 0.5 ? "255,255,255" : "0,0,0"},${a})`; g.fillRect(x, y, s, s); r.fillStyle = `rgba(230,230,230,${a})`; r.fillRect(x, y, s, s);
  }
  if (kind === "rubberDots") { const st = size / 16; for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    g.fillStyle = "rgba(255,255,255,0.10)"; g.beginPath(); g.arc((x + 0.5) * st, (y + 0.5) * st, st * 0.22, 0, Math.PI * 2); g.fill();
    r.fillStyle = "rgba(255,255,255,0.35)"; r.beginPath(); r.arc((x + 0.5) * st, (y + 0.5) * st, st * 0.22, 0, Math.PI * 2); r.fill(); } }
  if (kind === "vents") { const st = size / 12; for (let y = 0; y < 12; y++) {
    g.fillStyle = "rgba(0,0,0,0.55)"; g.fillRect(st * 0.6, y * st + st * 0.3, size - st * 1.2, st * 0.4);
    g.fillStyle = "rgba(255,255,255,0.08)"; g.fillRect(st * 0.6, y * st + st * 0.7, size - st * 1.2, 1);
    r.fillStyle = "rgba(255,255,255,0.4)"; r.fillRect(st * 0.6, y * st + st * 0.3, size - st * 1.2, st * 0.4); } }
  const wrap = (c: HTMLCanvasElement, srgb: boolean) => { const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; };
  return { map: wrap(cm, true), rough: wrap(cr, false) };
}

/** A tangent-space normal map from a pattern's seams (tile joints, panel seams, plating edges): subtle relief. */
function seamNormals(kind: "tiles" | "panels" | "plating", size: number): THREE.CanvasTexture {
  const h = new Float32Array(size * size), st = kind === "tiles" ? size / 4 : size / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = Math.min(x % st, st - (x % st)), dy = kind === "panels" ? Math.min(Math.abs(y - size * 0.62), y, size - y) : Math.min(y % st, st - (y % st));
    h[y * size + x] = Math.min(1, Math.min(dx, dy) / (size / 128));
  }
  const c = document.createElement("canvas"); c.width = c.height = size;
  const g = c.getContext("2d")!, img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const at = (i: number, j: number) => h[((j + size) % size) * size + ((i + size) % size)];
    const nx = (at(x - 1, y) - at(x + 1, y)) * 1.2, ny = (at(x, y - 1) - at(x, y + 1)) * 1.2, nz = 1, l = Math.hypot(nx, ny, nz), o = (y * size + x) * 4;
    img.data[o] = (nx / l * 0.5 + 0.5) * 255; img.data[o + 1] = (ny / l * 0.5 + 0.5) * 255; img.data[o + 2] = (nz / l * 0.5 + 0.5) * 255; img.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
  return t;
}

/** Which finish each material gets (department colours stay accents; finishes vary the base surfaces). */
const FINISH: Partial<Record<string, "brushed" | "composite" | "rubberDots" | "vents">> = { metal: "brushed", darkMetal: "brushed", wallTrim: "composite", desk: "composite", concrete: "composite", floorDark: "rubberDots",
  painted: "composite", equipment: "composite", grille: "vents", rubber: "rubberDots" };

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
  const finCache = new Map<string, ReturnType<typeof finish>>(), normCache = new Map<string, THREE.CanvasTexture>();
  const finishes = (k: "brushed" | "composite" | "rubberDots" | "vents") => {
    let f = finCache.get(k);
    if (!f) { f = finish(k, Math.min(512, q.textures)); f.map.repeat.set(2, 2); f.rough.repeat.set(2, 2); finCache.set(k, f); textures.push(f.map, f.rough); }
    return f;
  };
  const normals = (k: "tiles" | "panels" | "plating") => {
    let t = normCache.get(k);
    if (!t) { t = seamNormals(k, Math.min(512, q.textures)); normCache.set(k, t); textures.push(t); }
    return t;
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
    const fin = FINISH[key];
    const f = fin && q.textures ? finishes(fin) : null;
    const normal = q.textures && (key === "floor" || key === "corridor" || key === "wall") ? normals(key === "floor" ? "tiles" : key === "corridor" ? "plating" : "panels") : null;
    const opts: THREE.MeshPhysicalMaterialParameters = {
      color: map ? "#ffffff" : b.color, map, roughness: q.reflections && (key === "floor" || key === "corridor") ? Math.max(0.12, b.rough - 0.35) : b.rough,
      metalness: b.metal, emissive: b.emissive ?? "#000000", emissiveIntensity: (b.emissiveIntensity ?? 0) * (q.bloom ? 1.6 : 1),
      transparent: b.transparent !== undefined, opacity: b.transparent ?? 1, side: b.side ?? THREE.FrontSide,
      ...(f ? { map: map ?? f.map, roughnessMap: f.rough, color: b.color } : {}),
      ...(normal ? { normalMap: normal, normalScale: new THREE.Vector2(0.6, 0.6) } : {}),
    };
    if (q.physical && (key === "floor" || key === "corridor" || key === "metal" || key === "polished" || key === "screenGlass")) return new THREE.MeshPhysicalMaterial({ ...opts, clearcoat: 0.6, clearcoatRoughness: 0.25 });
    return new THREE.MeshStandardMaterial(opts);
  };
  return {
    get(key) { let m = cache.get(key); if (!m) { m = make(key); cache.set(key, m); } return m; },
    dispose() { for (const m of cache.values()) m.dispose(); for (const t of textures) t.dispose(); cache.clear(); },
  };
}

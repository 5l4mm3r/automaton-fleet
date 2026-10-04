/**
 * Original Automaton Fleet operative portraits (v3) — painted, dimensional adult faces of technical operators at a
 * 128×128 source resolution, with a restrained nod to the classic tactical status-bar face (a front-lit head whose
 * condition you read before the numbers). Everything is computed here from geometry and lighting rules; no
 * third-party art is used, traced or copied.
 *
 * How a portrait is made (pure, deterministic, no DOM):
 *  1. A 2.5D height field of the head — skull, brow ridge, eye sockets, cheekbones, nose, lips, chin, jaw, ears, neck,
 *     shoulders — shaped by the agent's identity.
 *  2. Normals from that field, lit by a warm key light from the upper left, a cool Fleet-cyan rim from the right, an
 *     ambient term and cavity occlusion; skin is painted through a five-tone ramp (deep shadow → highlight).
 *  3. Painted albedo layers on top: hair with strand texture, brows, eyes (sclera, iris, pupil, catch-light, lids),
 *     lips, facial hair, scars, earpiece, the uniform collar with cyan Fleet tabs.
 *
 * Identity is seeded by the agent id (face width, jaw, skin tone, hair style and colour, brows, eye colour, nose,
 * facial hair, scar, earpiece), so an agent looks the same everywhere. Condition comes ONLY from the shared health band
 * (economics.ts) and is painted on the SAME face: HEALTHY alert and composed · WINNING shades and a confident half
 * smile · WOUNDED fatigue, a bruise, a small cut · CRITICAL battered and exhausted, one eye swollen shut · DEAD eyes
 * closed, powered down and desaturated · UNKNOWN dimmed. Non-graphic, and always shown with a text label.
 */
import type { HealthBand } from "./economics";

/** Source resolution (square). Compact UI shows 64 px, profiles 128 px. */
export const PORTRAIT_SIZE = 128;

export interface PortraitTraits {
  width: 0 | 1 | 2;
  jaw: 0 | 1 | 2;
  skin: number;
  hair: 0 | 1 | 2 | 3 | 4 | 5;
  hairColour: number;
  brows: 0 | 1 | 2;
  eyes: number;
  nose: 0 | 1 | 2;
  facialHair: 0 | 1 | 2 | 3 | 4;
  scar: 0 | 1 | 2 | 3;
  earpiece: -1 | 0 | 1;
  /** Further identity (v3.1): skull shape, cheekbones, eye spacing, ear size, nose bridge, age, skin marks, curly hair. */
  skull: 0 | 1 | 2; cheek: 0 | 1 | 2; eyeSpace: 0 | 1 | 2; ears: 0 | 1 | 2; bridge: 0 | 1; age: 0 | 1 | 2; marks: 0 | 1 | 2 | 3; curly: 0 | 1;
}

type RGB = [number, number, number];
const hex = (h: string): RGB => { const v = parseInt(h.slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };
const toHex = (c: RGB) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;

/** Skin ramps: deep shadow, shadow, base, light, highlight. */
const SKIN: RGB[][] = [
  ["#7a4c33", "#a96f4f", "#d29a77", "#ebbd9a", "#f8dcc3"],
  ["#6b4129", "#97603f", "#c08560", "#dcab84", "#f0caa8"],
  ["#55331e", "#7e5232", "#a6764c", "#c79a6c", "#e3bf93"],
  ["#432716", "#684127", "#8c6040", "#ad7f5a", "#cba07a"],
  ["#331d10", "#52321e", "#714a2f", "#8f6545", "#ad8463"],
  ["#24140b", "#3d2617", "#573823", "#714c33", "#8f6849"],
].map((r) => r.map(hex));
/** Hair: shadow, base, highlight. */
const HAIR: RGB[][] = [
  ["#0b0a0a", "#1d1a19", "#3d3836"],
  ["#1c120b", "#3a281b", "#634733"],
  ["#2d1d10", "#563a22", "#87613e"],
  ["#3f1f0c", "#723f1e", "#a8673a"],
  ["#5e4423", "#9b7a4a", "#cfb07c"],
  ["#45423f", "#7d7975", "#b7b2ab"],
].map((r) => r.map(hex));
const IRIS: RGB[] = ["#4a2e1b", "#2f6491", "#3d6b45", "#5d6a74", "#6e4a28"].map(hex);
const UNIFORM: RGB[] = ["#0c121c", "#1a2536", "#2b3a50"].map(hex);
const CYAN = hex("#22d3ee"), LIP = hex("#9a4f4a"), BRUISE = hex("#5e3f6e"), BLOOD = hex("#6e1414"), WHITE = hex("#ece6dc");

/** FNV-1a: a stable 32-bit hash of the id (no randomness anywhere). */
export function seedOf(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

export function traitsOf(id: string): PortraitTraits {
  // Two independent hashes give enough bits for every trait (all indices unsigned, always in range).
  const a = seedOf(id), b = seedOf(`${id}#face`), c = seedOf(`${id}#more`);
  const pick = (h: number, shift: number, mod: number) => ((h >>> shift) >>> 0) % mod;
  return {
    width: pick(a, 0, 3) as 0 | 1 | 2, jaw: pick(a, 3, 3) as 0 | 1 | 2, skin: pick(a, 6, SKIN.length), hair: pick(a, 10, 6) as PortraitTraits["hair"],
    hairColour: pick(a, 14, HAIR.length), brows: pick(a, 18, 3) as 0 | 1 | 2, eyes: pick(b, 0, IRIS.length), nose: pick(b, 4, 3) as 0 | 1 | 2,
    facialHair: pick(b, 8, 5) as PortraitTraits["facialHair"], scar: pick(b, 12, 4) as PortraitTraits["scar"], earpiece: (pick(b, 16, 3) - 1) as -1 | 0 | 1,
    skull: pick(c, 0, 3) as 0 | 1 | 2, cheek: pick(c, 3, 3) as 0 | 1 | 2, eyeSpace: pick(c, 6, 3) as 0 | 1 | 2, ears: pick(c, 9, 3) as 0 | 1 | 2, bridge: pick(c, 12, 2) as 0 | 1,
    age: pick(c, 14, 3) as 0 | 1 | 2, marks: pick(c, 17, 4) as 0 | 1 | 2 | 3, curly: pick(c, 21, 3) === 0 ? 1 : 0,
  };
}

// ── small maths ────────────────────────────────────────────────────────────────────────────────────────────────────
const clamp = (v: number, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
const smooth = (e0: number, e1: number, v: number) => { const t = clamp((v - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mixc = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const gauss = (x: number, y: number, cx: number, cy: number, sx: number, sy: number) => Math.exp(-(((x - cx) ** 2) / (2 * sx * sx) + ((y - cy) ** 2) / (2 * sy * sy)));
/** Deterministic value noise in [0, 1). */
function hash2(x: number, y: number, s: number) { let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s, 2147483647)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function noise(x: number, y: number, s: number) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  return lerp(lerp(hash2(xi, yi, s), hash2(xi + 1, yi, s), u), lerp(hash2(xi, yi + 1, s), hash2(xi + 1, yi + 1, s), u), v);
}
/** Distance from p to segment ab. */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay, t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** The face geometry for one identity (landmarks in pixels of the 128 grid). */
function geometry(t: PortraitTraits) {
  const cx = 64, cy = 57, rx = 28 + t.width * 2.0, ryTop = 41 + t.skull * 2, ryBot = 39 + (t.jaw === 2 ? 2 : 0);
  const jawP = [3.1, 2.55, 2.05][t.jaw];
  const eyeY = 60, ex = 11.6 + t.width * 0.6 + t.eyeSpace * 0.6, browY = eyeY - 8.5, noseY = 75 + (t.nose === 2 ? 1 : 0), mouthY = 85.5, chinY = cy + ryBot;
  const halfWidth = (y: number) => {
    if (y < cy) { const k = (cy - y) / ryTop; return k >= 1 ? 0 : rx * Math.pow(1 - Math.pow(k, 2.4), 1 / 2.4); } // a broad crown
    const k = (y - cy) / ryBot; return k >= 1 ? 0 : rx * Math.pow(1 - Math.pow(k, jawP), 1 / jawP);
  };
  const hairline = (x: number) => {
    const d = Math.abs(x - cx) / rx, base = [33, 31, 33, 31, 33, 37][t.hair];
    return base + d * d * (t.hair === 5 ? 9 : 4) - (t.hair === 5 ? Math.max(0, 0.25 - d) * 10 : 0);
  };
  return { cx, cy, rx, ryTop, ryBot, jawP, eyeY, ex, browY, noseY, mouthY, chinY, halfWidth, hairline };
}
type Geo = ReturnType<typeof geometry>;

/** Condition modifiers, painted on the same face. */
interface Condition { smile: number; lidL: number; lidR: number; shades: boolean; swollen: -1 | 0 | 1; bruise: number; cuts: number; blood: number; sweat: boolean; teeth: boolean; desat: number; dim: number; cool: number }
function conditionOf(band: HealthBand, t: PortraitTraits): Condition {
  const side: -1 | 1 = t.scar % 2 === 0 ? 1 : -1;
  const base: Condition = { smile: 0.25, lidL: 0, lidR: 0, shades: false, swollen: 0, bruise: 0, cuts: 0, blood: 0, sweat: false, teeth: false, desat: 0, dim: 1, cool: 0 };
  switch (band) {
    case "WINNING": return { ...base, smile: 1.0, shades: true };
    case "WOUNDED": return { ...base, smile: -0.3, lidL: 0.35, lidR: 0.35, bruise: 0.55, cuts: 1, sweat: true, desat: 0.06 };
    case "CRITICAL": return { ...base, smile: -0.7, lidL: side < 0 ? 1 : 0.55, lidR: side > 0 ? 1 : 0.55, swollen: side, bruise: 1, cuts: 2, blood: 1, teeth: true, sweat: true, desat: 0.18, dim: 0.9 };
    case "DEAD": return { ...base, smile: -0.1, lidL: 1, lidR: 1, desat: 0.85, dim: 0.55, cool: 0.35 };
    case "UNKNOWN": return { ...base, smile: 0, desat: 0.5, dim: 0.75 };
    default: return base;
  }
}

const hairVolume = (t: PortraitTraits) => [2.6, 0.9, 0, 4.6, 2.8, 1.4][t.hair];

/** The head's height field (pixels of relief) at a point. */
function heightAt(x: number, y: number, g: Geo, t: PortraitTraits, c: Condition): number {
  const { cx, cy, eyeY, ex, browY, noseY, mouthY, chinY } = g;
  let h = 0;
  // Shoulders and neck (behind the head).
  if (y > 96) { const sw = 22 + (y - 96) * 2.4, nx = (x - cx) / sw; if (Math.abs(nx) < 1) h = Math.max(h, 10 * Math.sqrt(1 - nx * nx) * smooth(96, 106, y)); }
  const nw = 15 + t.width; if (y > 78 && y < 118) { const nx = (x - cx) / nw; if (Math.abs(nx) < 1) h = Math.max(h, 16 * Math.sqrt(1 - nx * nx)); }
  // Ears.
  for (const s of [-1, 1]) { const er = 1 + (t.ears - 1) * 0.12, ecx = cx + s * (g.halfWidth(eyeY + 5) + 1.5), d = ((x - ecx) / (4.2 * er)) ** 2 + ((y - (eyeY + 6)) / (8 * er)) ** 2; if (d < 1) h = Math.max(h, 12 * Math.sqrt(1 - d)); }
  // The head.
  const hw = g.halfWidth(y);
  if (hw > 0 && Math.abs(x - cx) < hw) {
    // One continuous dome: a superellipse in both halves (a broad crown above, the jaw's shape below), so the shading
    // has no seam where they meet.
    const p = y < cy ? 2.4 : g.jawP, ny = Math.abs(y - cy) / (y < cy ? g.ryTop : g.ryBot);
    const r = Math.pow(Math.pow(Math.abs(x - cx) / g.rx, p) + Math.pow(ny, p), 1 / p);
    let f = 30 * Math.pow(Math.max(0, 1 - r * r), 0.55);
    f += 3.2 * (gauss(x, y, cx - 12, browY + 1, 8, 2.8) + gauss(x, y, cx + 12, browY + 1, 8, 2.8)) + 2.2 * gauss(x, y, cx, browY + 2, 5, 4);
    f -= 5.5 * (gauss(x, y, cx - ex, eyeY + 0.5, 6.5, 4.2) + gauss(x, y, cx + ex, eyeY + 0.5, 6.5, 4.2));
    f += (1.8 + t.cheek * 0.9) * (gauss(x, y, cx - 18, eyeY + 10 + t.cheek, 6.5, 4.5) + gauss(x, y, cx + 18, eyeY + 10 + t.cheek, 6.5, 4.5));
    if (t.bridge) f += 1.6 * gauss(x, y, cx, eyeY + 6, 2.2, 2.2); // a bumped nose bridge
    if (t.age) f -= 0.5 * t.age * (gauss(x, y, cx, browY - 8, 14, 1) + gauss(x, y, cx, browY - 4.5, 12, 0.8)); // forehead lines
    const nb = 2.6 + t.nose * 0.45;
    f += 6.5 * gauss(x, y, cx, (browY + noseY) / 2 + 2, nb, 10) * smooth(browY, browY + 6, y) + 4.5 * gauss(x, y, cx, noseY - 1.5, 4.2 + t.nose * 0.5, 3.4);
    f += 2.0 * (gauss(x, y, cx - 5.2, noseY + 0.5, 2.6, 2.2) + gauss(x, y, cx + 5.2, noseY + 0.5, 2.6, 2.2)) - 2.4 * (gauss(x, y, cx - 2.8, noseY + 2.4, 1.4, 1) + gauss(x, y, cx + 2.8, noseY + 2.4, 1.4, 1));
    f -= 1.6 * (gauss(x, y, cx - 10.5, mouthY - 5, 1.8, 5.5) + gauss(x, y, cx + 10.5, mouthY - 5, 1.8, 5.5)) * (1 + c.smile * 0.6);
    f += 1.8 * gauss(x, y, cx, mouthY - 2.2, 7, 1.6) + 2.2 * gauss(x, y, cx, mouthY + 2.6, 6, 2.1) - 1.6 * gauss(x, y, cx, mouthY + 0.2, 7.5, 0.8);
    f += 2.4 * (gauss(x, y, cx - g.rx * 0.78, g.chinY - 13, 4, 6) + gauss(x, y, cx + g.rx * 0.78, g.chinY - 13, 4, 6)) - 1.4 * (gauss(x, y, cx - g.rx * 0.8, browY - 2, 3.5, 5) + gauss(x, y, cx + g.rx * 0.8, browY - 2, 3.5, 5));
    f += 3.0 * gauss(x, y, cx, chinY - 7.5, 8, 5) + 1.5 * c.smile * (gauss(x, y, cx - 13, mouthY - 6, 4, 4) + gauss(x, y, cx + 13, mouthY - 6, 4, 4));
    if (c.swollen) f += 5 * gauss(x, y, cx + c.swollen * ex, eyeY + 1, 6, 4.5);
    // Hair lies ON the skull: its thickness fades in above the hairline (no crease where it meets the forehead).
    f += hairVolume(t) * smooth(g.hairline(x) + 1, g.hairline(x) - 5, y);
    h = Math.max(h, f + 6);
  } else if (t.hair !== 2) {
    // Beyond the skull's outline the hair's own volume continues it smoothly.
    const vol = hairVolume(t), w = g.rx + vol, top = g.ryTop + vol;
    if (y < cy) { const nx = (x - cx) / w, ny = (cy - y) / top, d = nx * nx + ny * ny; if (d < 1) h = Math.max(h, (36 + vol) * Math.pow(1 - d, 0.55) * 0.5); }
  }
  return h;
}

const SHADE_CACHE = new Map<string, Uint8ClampedArray>(), FIGURE_CACHE = new Map<string, Uint8ClampedArray>();

/** Where the portrait shows the person (head, hair, ears) rather than background: 0–255 per pixel (the 3D face cut-out). */
export function portraitFigure(id: string, band: HealthBand): Uint8ClampedArray {
  portraitPixels(id, band);
  return FIGURE_CACHE.get(`${id}|${band}`)!;
}

/**
 * The portrait as RGBA pixels (PORTRAIT_SIZE²×4), cached per agent and condition. Pure and deterministic, so it runs
 * the same in the browser, in tests and when generating review sheets.
 */
/** Colours used while painting (parsed once). */
const K_GREYING = hex("#9a9a96");
const K_000000 = hex("#000000"), K_05080D = hex("#05080d"), K_060B15 = hex("#060b15"), K_0B0F16 = hex("#0b0f16"), K_0D1117 = hex("#0d1117"), K_14233A = hex("#14233a"), K_1A0E09 = hex("#1a0e09"), K_1B0F0A = hex("#1b0f0a"), K_1E293B = hex("#1e293b"), K_1F3C5C = hex("#1f3c5c"), K_2A1410 = hex("#2a1410"), K_2A1810 = hex("#2a1810"), K_2A3442 = hex("#2a3442"), K_3C5A3A = hex("#3c5a3a"), K_7A1818 = hex("#7a1818"), K_7A6A5C = hex("#7a6a5c"), K_8A7B6E = hex("#8a7b6e"), K_8E2020 = hex("#8e2020"), K_C0605A = hex("#c0605a"), K_D79A92 = hex("#d79a92"), K_FFFFFF = hex("#ffffff");

export function portraitPixels(id: string, band: HealthBand): Uint8ClampedArray {
  const key = `${id}|${band}`;
  const hit = SHADE_CACHE.get(key);
  if (hit) return hit;
  const t = traitsOf(id), g = geometry(t), c = conditionOf(band, t), S = PORTRAIT_SIZE, seed = seedOf(id) % 9973;
  const { cx, eyeY, browY, noseY, mouthY, chinY } = g;
  // 1. Height field (+1 border for the differences).
  // Sampled every 2 px and interpolated: relief is smooth, and this keeps a portrait to a few milliseconds.
  const C = S / 2 + 2, coarse = new Float32Array(C * C);
  for (let j = 0; j < C; j++) for (let i = 0; i < C; i++) coarse[j * C + i] = heightAt(i * 2 - 1, j * 2 - 1, g, t, c);
  const W = S + 2, H = new Float32Array(W * W);
  for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
    const fx = (i - 0.5) / 2 + 0.5, fy = (j - 0.5) / 2 + 0.5, i0 = Math.min(C - 2, Math.floor(fx)), j0 = Math.min(C - 2, Math.floor(fy)), u = fx - i0, v = fy - j0;
    H[j * W + i] = lerp(lerp(coarse[j0 * C + i0], coarse[j0 * C + i0 + 1], u), lerp(coarse[(j0 + 1) * C + i0], coarse[(j0 + 1) * C + i0 + 1], u), v);
  }
  const hAt = (i: number, j: number) => H[(j + 1) * W + (i + 1)];
  const skin = SKIN[t.skin], hair = HAIR[t.hairColour], iris = IRIS[t.eyes];
  const L = [-0.52, -0.62, 0.59], R = [0.86, -0.15, 0.3];
  const out = new Uint8ClampedArray(S * S * 4), figure = new Uint8ClampedArray(S * S);
  // Per-row head half-widths and per-column hairlines (pixel centres), computed once.
  const HW = new Float32Array(S), HL = new Float32Array(S);
  for (let i = 0; i < S; i++) { HW[i] = g.halfWidth(i + 0.5); HL[i] = g.hairline(i + 0.5); }
  const earX = g.halfWidth(eyeY + 5) + 1.5;
  const bruiseSide = c.swollen || (t.scar % 2 === 0 ? -1 : 1);

  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const px = x + 0.5, py = y + 0.5, h = hAt(x, y);
    const dx = (hAt(Math.min(S - 1, x + 1), y) - hAt(Math.max(0, x - 1), y)) / 2, dy = (hAt(x, Math.min(S - 1, y + 1)) - hAt(x, Math.max(0, y - 1))) / 2;
    const nl = Math.hypot(dx, dy, 1), N = [-dx / nl, -dy / nl, 1 / nl];
    const lap = hAt(Math.min(S - 1, x + 1), y) + hAt(Math.max(0, x - 1), y) + hAt(x, Math.min(S - 1, y + 1)) + hAt(x, Math.max(0, y - 1)) - 4 * h;
    const diff = Math.max(0, N[0] * L[0] + N[1] * L[1] + N[2] * L[2]);
    const rim = Math.pow(Math.max(0, N[0] * R[0] + N[1] * R[1] + N[2] * R[2]), 4);
    const spec = Math.pow(Math.max(0, N[0] * -0.26 + N[1] * -0.31 + N[2] * 0.91), 28);
    const ao = clamp(1 + lap * 0.09, 0.55, 1.08);
    const light = clamp(0.1 + diff * 1.08) * ao;

    // Region masks (head/ears/neck/shoulders/hair) with soft edges.
    const hw = HW[y], inHead = hw > 0 ? smooth(0.5, -0.5, Math.abs(px - cx) - hw) : 0;
    const earD = Math.hypot((Math.abs(px - cx) - earX) / 4.2, (py - (eyeY + 6)) / 8);
    const inEar = smooth(1.05, 0.9, earD);
    const nw = 15 + t.width, inNeck = py > 78 ? smooth(0.5, -0.5, Math.abs(px - cx) - nw) : 0;
    const sw = 22 + (py - 96) * 2.4, inBody = py > 96 ? smooth(0.5, -0.5, Math.abs(px - cx) - sw) * smooth(95, 98, py) : 0;

    // Background: deep navy, a soft light behind the head, faint scan lines.
    const bgr = Math.hypot(px - cx, py - 54) / 90;
    let col: RGB = mixc(K_14233A, K_060B15, clamp(bgr));
    if (y % 3 === 0) col = mixc(col, K_000000, 0.12);

    // Skin colour through the painted ramp.
    const skinCol = (lv: number): RGB => {
      const p = clamp(lv) * 4, i = Math.min(3, Math.floor(p));
      return mixc(skin[i], skin[i + 1], p - i);
    };
    // Painted skin (only where there is skin; the background is most of the frame).
    const anySkin = inHead > 0 || inEar > 0 || inNeck > 0;
    let skinC: RGB = col;
    if (anySkin) {
      skinC = skinCol(light * 0.95 + 0.04 + (noise(px * 0.6, py * 0.6, seed) - 0.5) * 0.05 + (hash2(x, y, seed + 1) - 0.5) * 0.035);
      skinC = mixc(skinC, [skinC[0] + 26, skinC[1] + 28, skinC[2] + 30], spec * 0.25);
      skinC = mixc(skinC, CYAN, rim * 0.22);
      // Warmth in the cheeks and nose, cooler shadow under the jaw.
      skinC = mixc(skinC, K_C0605A, 0.07 * (gauss(px, py, cx - 17, eyeY + 13, 6, 5) + gauss(px, py, cx + 17, eyeY + 13, 6, 5) + gauss(px, py, cx, noseY, 4, 3)));
    }
    // Body: uniform, collar and Fleet tabs.
    if (inBody > 0 || inNeck > 0) {
      let neck = mixc(skinCol(light * 0.8 * (py < chinY + 10 ? 0.55 + 0.45 * smooth(chinY, chinY + 12, py) : 1)), CYAN, rim * 0.15);
      neck = mixc(neck, K_000000, 0.25 * gauss(px, py, cx, chinY + 4, 14, 5));
      col = mixc(col, neck, inNeck);
      if (inBody > 0) {
        const u = mixc(UNIFORM[0], UNIFORM[2], clamp(light * 1.1)), weave = (noise(px * 1.5, py * 1.5, seed + 3) - 0.5) * 0.05;
        let b = mixc(u, K_FFFFFF, weave);
        const collarEdge = Math.abs(Math.abs(px - cx) - (nw + 2 + (py - 100) * 0.6));
        if (py > 98 && py < 122 && collarEdge < 4.5) b = mixc(b, UNIFORM[2], 0.5 * smooth(4.5, 2, collarEdge));
        // Cyan piping along the collar edge, a seam, and a small Fleet chevron on the left chest.
        if (py > 99 && py < 113 && Math.abs(collarEdge - 4.6) < 0.55) b = mixc(b, CYAN, 0.7 * smooth(99, 103, py) * smooth(113, 109, py));
        if (Math.abs(px - cx) < 0.8 && py > 108) b = mixc(b, UNIFORM[0], 0.7);
        const chev = Math.abs(py - 117 - Math.abs(px - (cx - 26)) * 0.6);
        if (Math.abs(px - (cx - 26)) < 4 && chev < 0.8) b = mixc(b, CYAN, 0.75);
        b = mixc(b, CYAN, rim * 0.18);
        // The neckline: skin shows in the open collar.
        const vNeck = py > 98 && Math.abs(px - cx) < Math.max(0, 9 - (py - 98) * 0.9);
        if (!vNeck) col = mixc(col, b, inBody);
      }
    }
    // Ears (with an optional comms earpiece).
    if (inEar > 0) {
      let e = skinCol(light * 0.85);
      e = mixc(e, K_000000, 0.3 * smooth(0.65, 0.2, earD));
      col = mixc(col, e, inEar * (1 - inHead));
    }
    if (inHead > 0) col = mixc(col, skinC, inHead);
    if (t.earpiece !== 0) {
      const epx = cx + t.earpiece * (g.halfWidth(eyeY + 5) + 2.5), d = Math.hypot((px - epx) / 3, (py - (eyeY + 6)) / 4.5);
      if (d < 1) col = mixc(K_0B0F16, K_2A3442, clamp(light));
      if (Math.hypot(px - epx, py - (eyeY + 3.5)) < 1.2) col = CYAN;
      if (Math.abs(px - (epx + t.earpiece * 1.5)) < 0.8 && py > eyeY + 9 && py < mouthY) col = mixc(col, K_0B0F16, 0.9);
    }

    if (inHead > 0) {
      // Stubble and facial hair (beneath the eyes, around the mouth and along the jaw).
      const lower = smooth(noseY - 4, noseY + 8, py) * smooth(-2, 3, hw - Math.abs(px - cx)), around = gauss(px, py, cx, mouthY + 3, 11, 9);
      const fh = t.facialHair, strand = noise(px * 1.8, py * 0.7, seed + 5);
      let beard = 0;
      if (py > noseY - 6) {
      if (fh >= 1) beard = 0.16 * lower * smooth(noseY, noseY + 12, py + Math.abs(px - cx) * 0.4) * (0.55 + 0.45 * noise(px * 3.1, py * 3.1, seed + 6));
      if (fh === 2) beard = Math.max(beard, 0.85 * smooth(3.5, 1.5, Math.abs(py - (mouthY - 3.5))) * smooth(9, 6, Math.abs(px - cx)));
      if (fh === 3) beard = Math.max(beard, 0.85 * around * smooth(chinY - 1, chinY - 6, py) * smooth(6, 4, Math.abs(px - cx)) + 0.8 * smooth(3.5, 1.5, Math.abs(py - (mouthY - 3.5))) * smooth(8.5, 6, Math.abs(px - cx)));
      if (fh === 4) beard = Math.max(beard, 0.9 * smooth(eyeY + 12, eyeY + 18, py) * smooth(-1, 3, hw - Math.abs(px - cx)) * (0.6 + 0.4 * smooth(9, 14, Math.abs(px - cx)) + 0.4 * smooth(mouthY - 7, mouthY - 3, py)));
      }
      if (beard > 0) col = mixc(col, mixc(hair[0], hair[2], clamp(light * 0.9 + (strand - 0.5) * 0.4)), clamp(beard));

      // Lips (kept clear of a beard).
      const curve = (u: number) => mouthY - c.smile * 1.6 * u * u + (c.smile < 0 ? -c.smile * 0.9 * u * u : 0);
      const u = (px - cx) / 8.3;
      if (Math.abs(u) < 1.05 && Math.abs(py - mouthY) < 6) {
        const my = curve(u), lipW = 1 - u * u;
        const upper = py > my - 2.6 * lipW && py <= my, lower = py > my && py < my + 3.2 * lipW;
        if (upper || lower) col = mixc(col, mixc(LIP, skinC, 0.45), (upper ? 0.55 : 0.4) * clamp(lipW * 2));
        const line = Math.abs(py - my);
        if (c.teeth && Math.abs(u) < 0.7 && py > my - 1 && py < my + 1.4) col = mixc(WHITE, K_7A6A5C, (Math.floor(px) % 3 === 0 ? 0.6 : 0.1) + (1 - light) * 0.3);
        else col = mixc(col, K_2A1410, 0.75 * smooth(0.9, 0.2, line) * clamp(lipW * 3));
        if (c.smile > 0.5 && Math.abs(Math.abs(u) - 1.05) < 0.12 && Math.abs(py - (my - 1.5)) < 1.5) col = mixc(col, K_000000, 0.15);
      }

      // Brows (the inner ends lower: composed and serious).
      if (Math.abs(py - browY) < 6) for (const s of [-1, 1]) {
        const ax = cx + s * 4.5, bx = cx + s * 17.5, ay = browY + 2.2, by = browY + (t.brows === 1 ? -0.5 : 0.8);
        const d = segDist(px, py, ax, ay, bx, by), thick = [1.5, 1.9, 2.4][t.brows] * (1 - 0.35 * clamp(Math.abs(px - ax) / 13));
        const m = smooth(thick, thick - 1, d) * (0.75 + 0.25 * noise(px * 2.5, py, seed + 9));
        if (m > 0) col = mixc(col, mixc(hair[0], hair[1], clamp(light)), m * 0.9);
      }

      // Eyes.
      if (Math.abs(py - eyeY) < 9) for (const s of [-1, 1] as const) {
        const ecx = cx + s * g.ex, lid = s < 0 ? c.lidL : c.lidR;
        const u2 = (px - ecx) / 6.2, v2 = (py - eyeY) / 2.8;
        const almond = Math.abs(u2) < 1 ? (v2 < 0 ? -v2 / Math.pow(1 - u2 * u2, 0.8) : v2 / (0.85 * Math.pow(1 - u2 * u2, 0.9))) : 9;
        // Shadow of the socket and under-eye.
        col = mixc(col, K_1B0F0A, 0.12 * gauss(px, py, ecx, eyeY - 2.5, 6, 2.5) + (lid > 0 && lid < 1 ? 0.15 : 0) * gauss(px, py, ecx, eyeY + 4, 5, 1.6));
        if (c.shades) continue;
        if (lid >= 1) { // closed (dead / swollen shut): the lid line only
          const lineY = eyeY + 0.6 + 0.8 * u2 * u2;
          if (Math.abs(u2) < 1) col = mixc(col, K_2A1810, 0.7 * smooth(0.9, 0.2, Math.abs(py - lineY)));
          continue;
        }
        const lidTop = eyeY - 2.6 + lid * 3.6;
        if (almond < 1 && py > lidTop) {
          const ix = ecx + s * -0.6, ir = Math.hypot(px - ix, py - (eyeY - 0.2));
          let e = mixc(WHITE, K_8A7B6E, 0.35 + (1 - light) * 0.3);
          if (ir < 2.8) e = mixc(iris, K_000000, ir < 1.25 ? 0.92 : 0.25 * (ir / 2.8));
          if (Math.hypot(px - (ix - 0.8), py - (eyeY - 1.1)) < 0.7) e = WHITE;
          col = mixc(col, e, smooth(1, 0.8, almond));
        }
        // Lash line and the upper lid crease.
        const top = eyeY - 2.6 * Math.pow(Math.max(0, 1 - u2 * u2), 0.8) + lid * 3.6;
        if (Math.abs(u2) < 1.05) { col = mixc(col, K_1A0E09, 0.85 * smooth(0.9, 0.2, Math.abs(py - top))); col = mixc(col, K_000000, 0.12 * smooth(1.2, 0.3, Math.abs(py - (top - 2.4)))); }
      }

      // Age: crow's feet and deeper folds; skin marks: freckles or a mole.
      if (t.age >= 1) for (const s of [-1, 1]) for (let k = 0; k < 3; k++) {
        const d = segDist(px, py, cx + s * (g.ex + 6.5), eyeY - 1 + k * 1.6, cx + s * (g.ex + 9), eyeY - 2 + k * 2.2);
        if (d < 0.6) col = mixc(col, mixc(skin[1], skin[0], 0.4), 0.35 * t.age * (1 - d / 0.6));
      }
      if (t.marks === 1 && py > eyeY + 3 && py < noseY + 4 && Math.abs(Math.abs(px - cx) - 13) < 7 && hash2(Math.floor(px / 2), Math.floor(py / 2), seed + 31) > 0.86) col = mixc(col, skin[1], 0.45);
      if (t.marks === 2 && Math.hypot(px - (cx + (seed % 2 ? 9 : -10)), py - (mouthY - 6)) < 1.1) col = mixc(col, skin[0], 0.75);
      // Scars.
      const scar = t.scar === 1 ? segDist(px, py, cx - 14, browY - 5, cx - 11, browY + 6) : t.scar === 2 ? segDist(px, py, cx + 14, eyeY + 7, cx + 21, eyeY + 15) : t.scar === 3 ? segDist(px, py, cx + 3, chinY - 6, cx + 6, chinY - 2) : 9;
      if (scar < 1) col = mixc(col, mixc(skin[4], K_D79A92, 0.4), 0.6 * (1 - scar));

      // Condition: bruising, cuts, blood, sweat, sunglasses.
      if (c.bruise > 0) {
        const b = gauss(px, py, cx + bruiseSide * (g.ex + 3), eyeY + 6, 6, 5) + (c.bruise > 0.8 ? 0.7 * gauss(px, py, cx - bruiseSide * 17, eyeY + 15, 5, 4) + 0.6 * gauss(px, py, cx + bruiseSide * 6, browY - 6, 4, 3) : 0);
        col = mixc(col, mixc(BRUISE, K_3C5A3A, 0.15), clamp(b * c.bruise * 0.6));
      }
      if (c.swollen) col = mixc(col, BRUISE, 0.45 * gauss(px, py, cx + c.swollen * g.ex, eyeY + 1, 6, 4.5));
      if (c.cuts >= 1) { const d = segDist(px, py, cx + bruiseSide * 9, browY - 9, cx + bruiseSide * 14, browY - 6); if (d < 0.9) col = mixc(col, K_8E2020, 0.75 * (1 - d)); }
      if (c.cuts >= 2) { const d = segDist(px, py, cx - bruiseSide * 3, mouthY + 1, cx - bruiseSide * 5, mouthY + 3); if (d < 0.8) col = mixc(col, K_7A1818, 0.8); }
      if (c.blood > 0) {
        // A thin trickle from the brow cut down the temple, and from one nostril — dark, restrained.
        const tx = cx + bruiseSide * (14 + (py - browY) * 0.12 + Math.sin(py * 0.4) * 0.6);
        if (py > browY - 6 && py < eyeY + 14 && Math.abs(px - tx) < 0.9 * (1 - (py - browY) / 30)) col = mixc(col, BLOOD, 0.8);
        const nx2 = cx + bruiseSide * 2.8;
        if (py > noseY + 2 && py < mouthY - 1.5 && Math.abs(px - nx2) < 0.8) col = mixc(col, BLOOD, 0.75);
      }
      if (c.sweat) for (const [sx, sy] of [[cx - 10, browY - 9], [cx + 15, browY - 4], [cx - 19, eyeY + 2]]) { const d = Math.hypot(px - sx, py - sy); if (d < 1.1) col = mixc(col, WHITE, 0.55 * (1 - d)); }
      if (c.shades) {
        for (const s of [-1, 1]) {
          const lx = cx + s * (g.ex + 0.5), ly = eyeY - 0.5, d = Math.pow(Math.abs((px - lx) / 7.6), 2.6) + Math.pow(Math.abs((py - ly) / (py < ly ? 4.2 : 5)), 2.6);
          if (d < 1) { const r = clamp((px - lx + (py - ly) * 0.8 + 6) / 12); col = mixc(mixc(K_05080D, K_1F3C5C, r * 0.8), WHITE, smooth(0.45, 0, Math.abs(px - lx + (py - ly) * 0.9 - 3)) * 0.5); }
          else if (d < 1.25) col = mixc(col, K_0D1117, 0.9);
        }
        if (Math.abs(py - (eyeY - 2.5)) < 0.9 && Math.abs(px - cx) < 5) col = K_0D1117;
      }
    }

    // Hair on top (over skin); styles: crew, buzz, shaved, swept, high fade, receding.
    if (t.hair !== 2 || py < HL[x]) {
      const above = py < HL[x] + (noise(px * 0.9, 3, seed + 11) - 0.5) * 2;
      const side = Math.abs(px - cx) > g.rx - 3.5 && py < eyeY - 2 && py > HL[x] - 2;
      const inHair = (above && (h > 6 || inHead > 0)) || (side && inHead > 0 && t.hair !== 4);
      if (inHair) {
        const dir = t.hair === 3 ? px * 0.25 + py * 1.6 : px * 1.4 + py * 0.3;
        const strand = 0.5 + 0.5 * Math.sin(dir + noise(px * 0.5, py * 0.5, seed + 13) * 5);
        let hc = mixc(hair[0], hair[1], clamp(light * 1.15));
        if (t.curly) hc = mixc(hc, hair[0], 0.45 * (noise(px * 1.6, py * 1.6, seed + 17) > 0.55 ? 1 : 0)); // curly texture
        if (t.age === 2) hc = mixc(hc, K_GREYING, 0.35 + 0.25 * noise(px * 2, py * 2, seed + 19)); // greying
        hc = mixc(hc, hair[2], clamp(spec * 2.2 + strand * 0.25 * light));
        hc = mixc(hc, CYAN, rim * 0.12);
        let alpha = 1;
        if (t.hair === 1) alpha = 0.55 + 0.25 * noise(px * 3, py * 3, seed);
        if (t.hair === 2) alpha = 0.18 + 0.12 * noise(px * 3, py * 3, seed);
        if (t.hair === 4 && Math.abs(px - cx) > g.rx * 0.62) alpha = 0.35 * smooth(g.rx, g.rx * 0.62, Math.abs(px - cx)) + 0.1;
        const edge = smooth(-0.5, 1.5, HL[x] - py);
        col = mixc(col, hc, alpha * (above ? edge : 0.9));
      }
    }

    // Condition grading: desaturation, dimming, a cool cast when powered down.
    if (c.desat > 0) { const yv = 0.3 * col[0] + 0.59 * col[1] + 0.11 * col[2]; col = mixc(col, [yv, yv, yv], c.desat); }
    if (c.cool > 0) col = mixc(col, K_1E293B, c.cool * 0.5);
    figure[y * S + x] = 255 * Math.max(inHead, inEar * (py < eyeY + 14 ? 1 : 0), h > 6 && py < HL[x] + 2 && t.hair !== 2 ? 1 : 0);
    const o = (y * S + x) * 4;
    out[o] = col[0] * c.dim; out[o + 1] = col[1] * c.dim; out[o + 2] = col[2] * c.dim; out[o + 3] = 255;
  }
  if (SHADE_CACHE.size > 400) { SHADE_CACHE.clear(); FIGURE_CACHE.clear(); }
  SHADE_CACHE.set(key, out); FIGURE_CACHE.set(key, figure);
  return out;
}

// ── PNG output ─────────────────────────────────────────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b: Uint8Array) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/** A minimal PNG encoder (stored deflate blocks) — used where no canvas exists (tests, review sheets). */
export function encodePng(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Uint8Array {
  const raw = new Uint8Array(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1); }
  const blocks: number[] = [0x78, 0x01];
  for (let i = 0; i < raw.length; i += 65535) {
    const n = Math.min(65535, raw.length - i), last = i + n >= raw.length ? 1 : 0;
    blocks.push(last, n & 255, n >> 8, ~n & 255, (~n >> 8) & 255);
    for (let k = 0; k < n; k++) blocks.push(raw[i + k]);
  }
  let a = 1, b2 = 0; for (const v of raw) { a = (a + v) % 65521; b2 = (b2 + a) % 65521; }
  blocks.push((b2 >> 8) & 255, b2 & 255, (a >> 8) & 255, a & 255);
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
    dv.setUint32(0, data.length); for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8); dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(blocks)), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function base64(bytes: Uint8Array): string {
  if (typeof btoa === "function") { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); }
  return (globalThis as unknown as { Buffer: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer.from(bytes).toString("base64");
}

/**
 * The portrait as a PNG data URL, cached per agent and condition (`img-src data:` in the CSP). In the browser a canvas
 * compresses it; elsewhere (tests, static rendering) the built-in encoder is used. Same pixels either way.
 */
const pngCache = new Map<string, string>();
export function portraitPng(id: string, band: HealthBand): string {
  const key = `${id}|${band}`;
  const hit = pngCache.get(key);
  if (hit) return hit;
  const px = portraitPixels(id, band), S = PORTRAIT_SIZE;
  let url: string;
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas"); canvas.width = S; canvas.height = S;
    const ctx = canvas.getContext("2d")!, img = ctx.createImageData(S, S); img.data.set(px); ctx.putImageData(img, 0, 0);
    url = canvas.toDataURL("image/png");
  } else url = `data:image/png;base64,${base64(encodePng(px, S, S))}`;
  if (pngCache.size > 400) pngCache.clear();
  pngCache.set(key, url);
  return url;
}

/** The cached data URL, or null when it has not been painted yet (see requestPortrait). */
export const cachedPortrait = (id: string, band: HealthBand): string | null => pngCache.get(`${id}|${band}`) ?? null;

/**
 * Paint portraits off the critical path: requests queue and are painted a few per idle slice (≈17 ms each), so opening
 * a view with 50 agents never blocks the page. The callback runs once the URL is ready.
 */
const queue: Array<{ id: string; band: HealthBand; done: (url: string) => void }> = [];
let pumping = false;
export function requestPortrait(id: string, band: HealthBand, done: (url: string) => void): () => void {
  const hit = cachedPortrait(id, band);
  if (hit) { done(hit); return () => {}; }
  const job = { id, band, done };
  queue.push(job);
  if (!pumping) { pumping = true; setTimeout(pump, 0); }
  return () => { const i = queue.indexOf(job); if (i >= 0) queue.splice(i, 1); };
}
function pump() {
  const until = performance.now() + 24;
  while (queue.length && performance.now() < until) { const j = queue.shift()!; j.done(portraitPng(j.id, j.band)); }
  if (queue.length) setTimeout(pump, 16); else pumping = false;
}

/** Frame colour around the portrait (with the text label; never the only signal). */
export const BAND_FRAME: Readonly<Record<HealthBand, string>> = Object.freeze({
  HEALTHY: "#22d3ee", WINNING: "#34d399", WOUNDED: "#f59e0b", CRITICAL: "#ef4444", DEAD: "#475569", UNKNOWN: "#64748b",
});

/** The identity the 3D operator shares with the portrait (skin, hair, beard, eyes, build), so body and face agree. */
export function identityColours(id: string): { skin: string; skinShadow: string; hair: string; hairStyle: PortraitTraits["hair"]; facialHair: PortraitTraits["facialHair"]; iris: string; width: PortraitTraits["width"]; earpiece: PortraitTraits["earpiece"] } {
  const t = traitsOf(id);
  return { skin: toHex(SKIN[t.skin][2]), skinShadow: toHex(SKIN[t.skin][1]), hair: toHex(HAIR[t.hairColour][1]), hairStyle: t.hair, facialHair: t.facialHair, iris: toHex(IRIS[t.eyes]), width: t.width, earpiece: t.earpiece };
}

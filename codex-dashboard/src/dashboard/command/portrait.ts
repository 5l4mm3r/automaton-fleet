/**
 * Original Automaton Fleet operative portraits (v2) — adult, front-facing tactical-operator FACES in the spirit of the
 * early-1990s first-person-shooter HUD status face: a painted, front-lit pixel head whose condition you read before the
 * numbers. Everything is drawn here from geometry and shading rules; no third-party sprite or artwork is used, traced or
 * copied.
 *
 * Identity is DETERMINISTIC (seeded by the agent id): face width and jaw, skin tone, hair style and colour, brows, eye
 * colour, nose, facial hair, scar, ears and a comms earpiece — so an agent looks the same everywhere, on every render.
 * Condition comes ONLY from the shared health band (economics.ts) and is drawn on the SAME face:
 * HEALTHY alert · WINNING shades and a confident grin · WOUNDED fatigue, bruise, cuts · CRITICAL battered, bleeding,
 * exhausted · DEAD eyes closed, desaturated · UNKNOWN dimmed. Kept non-graphic; always shown with a text label.
 */
import type { HealthBand } from "./economics";

export const PORTRAIT_SIZE = 32;

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
}

/** Skin ramps: highlight, light, base, shadow, deep shadow. */
const SKIN: string[][] = [
  ["#f6d7bd", "#ebc2a0", "#d9a77f", "#b9845e", "#8e5f40"],
  ["#eec39b", "#dfa97d", "#c98f63", "#a7714a", "#7d5133"],
  ["#d9a678", "#c48c5c", "#a9744a", "#875935", "#623e24"],
  ["#bf8c62", "#a6734b", "#8c5e3a", "#6c4529", "#4c2f1b"],
  ["#9c6c48", "#845a3a", "#6b472d", "#52361f", "#3a2515"],
  ["#7a5236", "#64422b", "#503421", "#3d2718", "#2a1a10"],
];
/** Hair: highlight, base, shadow. */
const HAIR: string[][] = [
  ["#3a3634", "#1f1c1b", "#100e0d"],
  ["#5a3f2c", "#3d2a1d", "#251910"],
  ["#7a5534", "#573b22", "#3a2715"],
  ["#9a5a32", "#74401f", "#4f2a12"],
  ["#c9a36a", "#a68048", "#7a5b2e"],
  ["#a7a29c", "#7e7a75", "#56534f"],
];
const IRIS = ["#4a3020", "#2f5f86", "#3f6b45", "#5b6670", "#6b4a2a"];
const UNIFORM = ["#2b3a4d", "#1c2736", "#111821"];
const INK = "#140e0b", WHITE = "#e9e0d2", TEETH = "#ece4d6", CYAN = "#22d3ee";

/** FNV-1a: a stable 32-bit hash of the id (no randomness anywhere). */
export function seedOf(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

export function traitsOf(id: string): PortraitTraits {
  // Two independent hashes give enough bits for every trait (all indices unsigned, always in range).
  const a = seedOf(id), b = seedOf(`${id}#face`);
  const pick = (h: number, shift: number, mod: number) => ((h >>> shift) >>> 0) % mod;
  return {
    width: pick(a, 0, 3) as 0 | 1 | 2, jaw: pick(a, 3, 3) as 0 | 1 | 2, skin: pick(a, 6, SKIN.length), hair: pick(a, 10, 6) as PortraitTraits["hair"],
    hairColour: pick(a, 14, HAIR.length), brows: pick(a, 18, 3) as 0 | 1 | 2, eyes: pick(b, 0, IRIS.length), nose: pick(b, 4, 3) as 0 | 1 | 2,
    facialHair: pick(b, 8, 5) as PortraitTraits["facialHair"], scar: pick(b, 12, 4) as PortraitTraits["scar"], earpiece: (pick(b, 16, 3) - 1) as -1 | 0 | 1,
  };
}

type Grid = (string | null)[][];

function grey(hex: string, dim = 0.55): string {
  const v = parseInt(hex.slice(1), 16);
  const y = Math.round((0.3 * (v >> 16) + 0.59 * ((v >> 8) & 255) + 0.11 * (v & 255)) * dim).toString(16).padStart(2, "0");
  return `#${y}${y}${y}`;
}
function mix(hex: string, to: string, t: number): string {
  const a = parseInt(hex.slice(1), 16), b = parseInt(to.slice(1), 16);
  const c = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t).toString(16).padStart(2, "0");
  return `#${c(16)}${c(8)}${c(0)}`;
}

/** Half-width of the head at row y (adult proportions: broad cheekbones, a defined jaw). */
function halfWidth(y: number, t: PortraitTraits): number {
  const w = [-0.6, 0, 0.6][t.width];
  if (y < 3) return 0;
  if (y <= 5) return [5, 6.6, 7.6][y - 3] + w;
  if (y <= 15) return 8.4 + w + (y >= 10 && y <= 13 ? 0.3 : 0);
  const jaw = [[8.2, 7.9, 7.6, 7.2, 6.6, 5.8, 4.8, 3.6], [8.2, 8.0, 7.9, 7.6, 7.2, 6.6, 5.6, 4.2], [8.0, 7.6, 7.0, 6.4, 5.6, 4.8, 3.8, 2.8]][t.jaw];
  return y - 16 < jaw.length ? jaw[y - 16] + w : 0;
}

/** The portrait as a 32×32 grid of colours (null = background). */
export function portraitGrid(id: string, band: HealthBand): Grid {
  const t = traitsOf(id);
  const N = PORTRAIT_SIZE, cx = 15.5;
  const g: Grid = Array.from({ length: N }, () => Array<string | null>(N).fill(null));
  const put = (x: number, y: number, c: string) => { if (x >= 0 && x < N && y >= 0 && y < N) g[y][x] = c; };
  const rect = (x: number, y: number, w: number, h: number, c: string) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, c); };
  const pale = band === "CRITICAL" ? 0.16 : band === "WOUNDED" ? 0.06 : 0;
  const ramp = SKIN[t.skin].map((c) => (pale ? mix(c, "#c9c2bb", pale) : c));
  const hair = HAIR[t.hairColour];
  const skinAt = (x: number, y: number): string => {
    // Front-lit from the upper left: lighter towards the left cheek and forehead, darker at the right edge and jaw.
    const hw = Math.max(1, halfWidth(y, t)), nx = (x + 0.5 - cx) / hw;
    let s = 1.8 + nx * 1.6 + (Math.abs(nx) > 0.8 ? 1.0 : 0) + (y >= 21 ? 0.8 : 0);
    if (y >= 5 && y <= 10 && Math.abs(nx) < 0.45) s -= 0.8; // forehead highlight
    if (y >= 15 && y <= 17 && nx < -0.35 && nx > -0.8) s -= 0.7; // cheekbone highlight
    if (y >= 19 && y <= 21 && Math.abs(nx) < 0.3) s -= 0.4; // chin / upper-lip light
    return ramp[Math.max(0, Math.min(4, Math.round(s)))];
  };

  // Shoulders and the technical uniform's collar (Fleet cyan tabs).
  for (let y = 27; y < N; y++) for (let x = 2; x < 30; x++) { const nx = (x + 0.5 - cx) / 14; put(x, y, UNIFORM[nx < -0.3 ? 0 : nx > 0.45 ? 2 : 1]); }
  for (let y = 26; y < 29; y++) for (let x = 11; x < 21; x++) if (Math.abs(x + 0.5 - cx) < 5 - (y - 26) * 1.6) put(x, y, ramp[3]);
  rect(9, 27, 2, 1, CYAN); rect(21, 27, 2, 1, CYAN); rect(15, 29, 2, 1, UNIFORM[0]);
  // Neck (in shadow under the jaw).
  for (let y = 22; y < 27; y++) for (let x = 11; x < 21; x++) put(x, y, ramp[y < 24 ? 4 : 3]);
  // Head.
  for (let y = 3; y < 24; y++) { const hw = halfWidth(y, t); for (let x = 0; x < N; x++) if (Math.abs(x + 0.5 - cx) <= hw) put(x, y, skinAt(x, y)); }
  // Ears.
  for (let y = 12; y < 18; y++) { const hw = halfWidth(y, t); put(Math.floor(cx - hw - 1), y, ramp[2]); put(Math.ceil(cx + hw), y, ramp[4]); if (y > 12 && y < 17) put(Math.floor(cx - hw - 1) + (y === 14 ? 1 : 0), y, ramp[3]); }
  if (t.earpiece !== 0) { const x = t.earpiece < 0 ? Math.floor(cx - halfWidth(14, t) - 2) : Math.ceil(cx + halfWidth(14, t)) + 1; rect(x, 13, 1, 4, INK); put(x, 13, CYAN); }

  // Hair: crew cut, buzz, shaved, swept back, high fade, receding.
  const hairline = [7, 6, 6, 6, 7, 8][t.hair];
  for (let y = 2; y < 12; y++) {
    const hw = Math.max(halfWidth(y, t), y < 3 ? 4 : 0) + (y < 8 ? 0.6 : 0.2);
    for (let x = 0; x < N; x++) {
      const dx = Math.abs(x + 0.5 - cx);
      if (dx > hw) continue;
      const side = dx > hw - 1.6;
      const top = y < hairline || (t.hair === 5 && y < hairline + 1 && dx < 3);
      if (!(top || (side && y < 11))) continue;
      if (t.hair === 5 && y >= 5 && dx > 3 && dx < hw - 1.6 && !side) continue;
      if (t.hair === 4 && side && y > 4) { if ((x + y) % 2 === 0) put(x, y, hair[2]); continue; }
      if (t.hair === 2) { if ((x * 3 + y) % 3 !== 0) put(x, y, mix(skinAt(x, Math.max(y, 6)), hair[1], 0.45)); continue; }
      const tone = t.hair === 1 ? hair[(x + y) % 3 === 0 ? 1 : 2] : x + 0.5 < cx - 2 && y < hairline - 1 ? hair[0] : dx > hw - 2 ? hair[2] : hair[1];
      put(x, y, tone);
      if (t.hair === 3 && y < hairline - 1 && (x + y) % 4 === 0) put(x, y, hair[0]);
    }
  }
  if (t.hair === 0) for (let x = Math.round(cx - 6); x < Math.round(cx + 6); x++) if (x % 2) put(x, hairline - 1, hair[2]);

  // Brows (stern: the inner ends sit lower).
  const browH = t.brows === 2 ? 2 : 1;
  for (const side of [-1, 1]) for (let i = 0; i < 4; i++) {
    const x = Math.round(cx + side * (2 + i)) - (side < 0 ? 1 : 0);
    for (let k = 0; k < browH; k++) put(x, 11 + (i === 0 ? 1 : 0) + k, hair[t.brows === 0 && i === 3 ? 1 : 2]);
  }
  // Deep eye sockets under the brow ridge, and the folds from nose to mouth.
  for (let x = Math.round(cx - 7); x < Math.round(cx + 7); x++) if (g[13][x] && x !== 15 && x !== 16) { put(x, 13, ramp[x < cx ? 3 : 4]); put(x, 15, ramp[x < cx ? 2 : 3]); }
  put(12, 19, ramp[3]); put(11, 20, ramp[3]); put(19, 19, ramp[4]); put(20, 20, ramp[4]);

  const iris = IRIS[t.eyes];
  const eye = (side: -1 | 1, kind: "open" | "half" | "closed" | "narrow") => {
    const x0 = side < 0 ? Math.round(cx - 6) : Math.round(cx + 2);
    if (kind === "closed") { rect(x0, 14, 4, 1, ramp[4]); put(x0 + (side < 0 ? 0 : 3), 15, ramp[4]); return; }
    if (kind === "half") { rect(x0, 13, 4, 1, ramp[4]); rect(x0, 14, 4, 1, WHITE); put(x0 + 1, 14, iris); put(x0 + 2, 14, INK); return; }
    rect(x0, 13, 4, 1, INK);
    // White, iris, pupil, white: the eyes look straight out.
    put(x0, 14, WHITE); put(x0 + 1, 14, iris); put(x0 + 2, 14, INK); put(x0 + 3, 14, WHITE);
    if (kind === "narrow") rect(x0, 13, 4, 1, ramp[4]);
  };
  // Nose: bridge highlight, shaded side, nostrils.
  const noseW = [2, 3, 2][t.nose], noseOff = t.nose === 2 ? 1 : 0;
  for (let y = 14; y < 19; y++) { put(15 + noseOff, y, ramp[y < 17 ? 1 : 2]); put(16 + noseOff, y, ramp[3]); }
  rect(14 - (noseW > 2 ? 1 : 0) + noseOff, 19, noseW + 2, 1, ramp[4]); put(15 + noseOff, 19, ramp[3]); put(16 + noseOff, 18, ramp[2]);
  // Facial hair.
  const fh = t.facialHair;
  if (fh === 1) for (let y = 19; y < 24; y++) for (let x = 8; x < 24; x++) if (g[y][x] && (x * 7 + y * 3) % 3 === 0 && Math.abs(x + 0.5 - cx) <= halfWidth(y, t) - 0.5) put(x, y, mix(skinAt(x, y), hair[2], 0.5));
  if (fh === 2) rect(12, 20, 8, 1, hair[1]);
  if (fh === 3) { rect(13, 20, 6, 1, hair[1]); rect(14, 22, 4, 2, hair[1]); put(14, 23, hair[2]); }
  if (fh === 4) for (let y = 19; y < 24; y++) for (let x = 6; x < 26; x++) if (g[y][x] && Math.abs(x + 0.5 - cx) <= halfWidth(y, t) - (y < 21 ? 2.5 : 0.4)) put(x, y, (x + y) % 3 === 0 ? hair[2] : hair[1]);
  // Scar (an identity mark, not damage).
  if (t.scar === 1) { put(20, 16, ramp[0]); put(21, 17, ramp[0]); put(21, 18, ramp[0]); }
  if (t.scar === 2) { put(18, 10, ramp[0]); put(18, 11, ramp[0]); put(18, 12, ramp[0]); }
  if (t.scar === 3) { put(13, 20, ramp[0]); put(13, 22, ramp[0]); }

  const mouth = (kind: "set" | "grin" | "grit" | "slack") => {
    const y = 21;
    if (kind === "set") { rect(14, y, 4, 1, INK); put(13, y, ramp[4]); put(18, y, ramp[4]); rect(14, y + 1, 4, 1, ramp[1]); }
    else if (kind === "grin") { rect(12, y, 8, 1, INK); rect(13, y, 6, 1, TEETH); put(20, y - 1, INK); put(19, y + 1, ramp[4]); rect(13, y + 1, 5, 1, ramp[1]); }
    else if (kind === "grit") { rect(12, y - 1, 8, 3, INK); rect(12, y - 1, 8, 1, TEETH); rect(12, y + 1, 8, 1, TEETH); for (let x = 13; x < 20; x += 2) put(x, y - 1, INK); }
    else { rect(13, y + 1, 6, 1, ramp[4]); put(12, y + 1, ramp[3]); }
  };

  const BRUISE = "#6b4a7a", BRUISE2 = "#4e3560", BLOOD = "#7f1d1d", BLOOD2 = "#a31b1b", SWEAT = "#bfe6f2";
  switch (band) {
    case "WINNING":
      // Shades across both eyes with a glint, one raised brow, a confident one-sided grin.
      rect(Math.round(cx - 7), 13, 15, 3, INK); rect(15, 13, 2, 1, "#2b2b2b"); put(10, 13, "#9aa4ae"); put(19, 13, "#9aa4ae"); put(11, 14, "#5b636b");
      for (let i = 0; i < 4; i++) put(Math.round(cx + 2 + i), 10, hair[2]);
      mouth("grin");
      break;
    case "WOUNDED":
      eye(-1, "half"); eye(1, "narrow"); mouth("slack");
      rect(18, 15, 3, 2, BRUISE); put(21, 16, BRUISE2);
      put(12, 8, BLOOD); put(13, 9, BLOOD); put(13, 10, BLOOD2);
      put(9, 17, BLOOD); put(10, 18, BLOOD);
      put(22, 10, SWEAT); put(22, 11, SWEAT);
      break;
    case "CRITICAL":
      eye(-1, "half"); eye(1, "half"); mouth("grit");
      for (const [x, y] of [[17, 12], [18, 12], [19, 12], [20, 12], [21, 13], [21, 14], [21, 15], [17, 16], [18, 16], [19, 16], [20, 16], [16, 15]] as const) put(x, y, BRUISE2);
      for (const [x, y] of [[11, 6], [11, 7], [12, 8], [12, 9], [11, 10], [11, 11], [10, 12], [10, 16], [10, 17], [16, 20], [17, 20], [9, 19]] as const) put(x, y, y < 9 ? BLOOD2 : BLOOD);
      put(22, 9, SWEAT); put(22, 10, SWEAT); put(8, 12, SWEAT);
      put(19, 19, BRUISE); put(20, 19, BRUISE);
      break;
    case "DEAD":
      eye(-1, "closed"); eye(1, "closed"); mouth("slack");
      break;
    default:
      eye(-1, "open"); eye(1, "open"); mouth("set");
  }

  // Outline: a dark contour where the head meets the background (the painted-sprite look).
  const out: Grid = g.map((r) => [...r]);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (g[y][x] || y > 26) continue;
    if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => { const v = g[y + dy]?.[x + dx]; return v && v !== CYAN && y + dy <= 26; })) out[y][x] = "#0a0705";
  }
  if (band === "DEAD") for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const c = out[y][x]; if (c) out[y][x] = grey(c, 0.78); }
  return out;
}

/** Runs of equal colour per row → compact SVG/Canvas rectangles (one path per colour). */
export function portraitPaths(id: string, band: HealthBand): Array<{ fill: string; d: string }> {
  const g = portraitGrid(id, band);
  const byFill = new Map<string, string[]>();
  for (let y = 0; y < g.length; y++) {
    let x = 0;
    while (x < g[y].length) {
      const c = g[y][x];
      if (!c) { x++; continue; }
      let w = 1;
      while (x + w < g[y].length && g[y][x + w] === c) w++;
      (byFill.get(c) ?? byFill.set(c, []).get(c)!).push(`M${x} ${y}h${w}v1h-${w}z`);
      x += w;
    }
  }
  return [...byFill].map(([fill, parts]) => ({ fill, d: parts.join("") }));
}

/**
 * The portrait as a PNG data URL (browser only), cached per agent and condition — one bitmap instead of hundreds of SVG
 * paths where many portraits repaint together (the 2D map). Same pixels as portraitGrid; `img-src data:` in the CSP.
 */
const pngCache = new Map<string, string>();
export function portraitPng(id: string, band: HealthBand): string {
  const key = `${id}|${band}`;
  const hit = pngCache.get(key);
  if (hit) return hit;
  const S = PORTRAIT_SIZE, g = portraitGrid(id, band), canvas = document.createElement("canvas");
  canvas.width = S + 2; canvas.height = S + 2;
  const c = canvas.getContext("2d")!;
  c.fillStyle = BAND_FRAME[band]; c.fillRect(0, 0, S + 2, S + 2);
  c.fillStyle = "#020617"; c.fillRect(1, 1, S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const col = g[y][x]; if (col) { c.fillStyle = col; c.fillRect(x + 1, y + 1, 1, 1); } }
  const url = canvas.toDataURL("image/png");
  if (pngCache.size > 600) pngCache.clear();
  pngCache.set(key, url);
  return url;
}

/** Frame colour around the portrait (with the text label; never the only signal). */
export const BAND_FRAME: Readonly<Record<HealthBand, string>> = Object.freeze({
  HEALTHY: "#22d3ee", WINNING: "#34d399", WOUNDED: "#f59e0b", CRITICAL: "#ef4444", DEAD: "#475569", UNKNOWN: "#64748b",
});

/** Colours the 3D operator model takes from the same identity (skin and hair), so body and portrait agree. */
export function identityColours(id: string): { skin: string; skinShadow: string; hair: string; hairStyle: PortraitTraits["hair"]; facialHair: PortraitTraits["facialHair"] } {
  const t = traitsOf(id);
  return { skin: SKIN[t.skin][2], skinShadow: SKIN[t.skin][3], hair: HAIR[t.hairColour][1], hairStyle: t.hair, facialHair: t.facialHair };
}

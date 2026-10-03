/**
 * Original Automaton Fleet operative portraits — low-resolution, front-facing tactical status faces in the spirit of
 * early-1990s first-person-shooter HUD portraits (the idea: the face tells you the condition before the numbers do).
 * Everything is drawn here, pixel by pixel, from simple shapes: no third-party sprites or artwork are used or copied.
 *
 * Identity is DETERMINISTIC: the agent id seeds helmet, skin, insignia, stubble, scar, goggles and earpiece, so an agent
 * looks the same everywhere and on every render. Condition comes ONLY from the shared health band (economics.ts):
 * HEALTHY alert · WINNING shades and a smug grin · WOUNDED bruise, cut, tired eye · CRITICAL blood, black eye, gritted
 * teeth · DEAD powered down and desaturated · UNKNOWN dimmed. Kept non-graphic; always shown with a text label.
 */
import type { HealthBand } from "./economics";

export const PORTRAIT_SIZE = 24;

export interface PortraitTraits {
  skin: number;
  helmet: number;
  accent: number;
  stubble: 0 | 1 | 2;
  scar: boolean;
  goggles: boolean;
  earpiece: -1 | 0 | 1;
}

const SKIN = ["#f1c7a5", "#e0ac83", "#c68a5e", "#a8704a", "#7f5236", "#5c3a26"];
const HELMET = ["#334155", "#3f4a2f", "#3a3f47", "#1f4a52", "#5b5240"];
const ACCENT = ["#22d3ee", "#fbbf24", "#a78bfa", "#34d399", "#f87171"];

/** FNV-1a: a stable 32-bit hash of the id (no randomness anywhere). */
export function seedOf(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

export function traitsOf(id: string): PortraitTraits {
  const s = seedOf(id);
  // `^` yields a signed 32-bit value; `>>> 0` keeps it unsigned so every index is in range.
  const bits = (shift: number, mod: number) => (((s >>> shift) ^ (s >>> (shift + 11))) >>> 0) % mod;
  return { skin: bits(0, SKIN.length), helmet: bits(3, HELMET.length), accent: bits(6, ACCENT.length), stubble: bits(9, 3) as 0 | 1 | 2,
    scar: bits(12, 4) === 0, goggles: bits(15, 3) === 0, earpiece: (bits(18, 3) - 1) as -1 | 0 | 1 };
}

type Grid = (string | null)[][];

function shade(hex: string, f: number): string {
  const v = parseInt(hex.slice(1), 16);
  const c = (x: number) => Math.max(0, Math.min(255, Math.round(x * f))).toString(16).padStart(2, "0");
  return `#${c(v >> 16)}${c((v >> 8) & 255)}${c(v & 255)}`;
}
function grey(hex: string, dim = 0.55): string {
  const v = parseInt(hex.slice(1), 16);
  const y = Math.round((0.3 * (v >> 16) + 0.59 * ((v >> 8) & 255) + 0.11 * (v & 255)) * dim).toString(16).padStart(2, "0");
  return `#${y}${y}${y}`;
}

/** The portrait as a 24×24 grid of colours (null = background). */
export function portraitGrid(id: string, band: HealthBand): Grid {
  const t = traitsOf(id);
  const N = PORTRAIT_SIZE;
  const g: Grid = Array.from({ length: N }, () => Array<string | null>(N).fill(null));
  const put = (x: number, y: number, c: string) => { if (x >= 0 && x < N && y >= 0 && y < N) g[y][x] = c; };
  const rect = (x: number, y: number, w: number, h: number, c: string) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, c); };

  const pale = band === "CRITICAL" ? 0.88 : 1;
  const skin = shade(SKIN[t.skin], pale), skinDark = shade(SKIN[t.skin], 0.78 * pale);
  const helmet = HELMET[t.helmet], helmetHi = shade(helmet, 1.35), helmetLo = shade(helmet, 0.7), accent = ACCENT[t.accent];
  const ink = "#0b1220", white = "#e2e8f0", armour = "#1e293b", armourHi = "#334155";

  // Shoulders, collar and chest rig.
  rect(2, 20, 20, 4, armour); rect(4, 20, 16, 1, armourHi); rect(9, 21, 6, 3, shade(armour, 0.8)); rect(10, 22, 1, 1, accent); rect(13, 22, 1, 1, accent);
  // Neck.
  rect(9, 18, 6, 2, skinDark);
  // Face.
  rect(6, 8, 12, 10, skin); rect(7, 18, 10, 1, skin); rect(5, 10, 1, 6, skinDark); rect(18, 10, 1, 6, skinDark);
  rect(8, 18, 1, 1, skinDark); rect(15, 18, 1, 1, skinDark);
  // Helmet with brim, stripe and insignia.
  rect(5, 3, 14, 6, helmet); rect(6, 2, 12, 1, helmet); rect(4, 7, 16, 2, helmetLo); rect(6, 3, 12, 1, helmetHi);
  rect(11, 3, 2, 4, shade(helmet, 0.85)); rect(11, 4, 2, 1, accent);
  if (t.goggles) { rect(7, 5, 4, 2, ink); rect(13, 5, 4, 2, ink); rect(8, 5, 1, 1, accent); rect(14, 5, 1, 1, accent); rect(11, 6, 2, 1, ink); }
  if (t.earpiece !== 0) { const x = t.earpiece < 0 ? 4 : 19; rect(x, 10, 1, 4, ink); put(x, 10, accent); }
  // Brows.
  rect(7, 10, 3, 1, skinDark); rect(14, 10, 3, 1, skinDark);
  // Nose.
  rect(11, 13, 2, 2, skinDark); put(11, 15, shade(skin, 0.7));
  // Stubble.
  if (t.stubble) for (let x = 7; x <= 16; x++) if ((x + t.stubble) % 2 === 0) put(x, 17, skinDark);
  if (t.stubble === 2) { rect(8, 18, 8, 1, skinDark); }
  // Scar (identity trait, not damage).
  if (t.scar) { put(15, 12, shade(skin, 0.75)); put(16, 13, shade(skin, 0.75)); }

  const eye = (x: number, open: "open" | "half" | "x" | "closed") => {
    if (open === "open") { rect(x, 11, 3, 2, white); rect(x + 1, 11, 1, 2, ink); }
    else if (open === "half") { rect(x, 12, 3, 1, white); put(x + 1, 12, ink); rect(x, 11, 3, 1, skinDark); }
    else if (open === "x") { put(x, 11, ink); put(x + 2, 11, ink); put(x + 1, 12, ink); put(x, 13, ink); put(x + 2, 13, ink); }
    else rect(x, 12, 3, 1, ink);
  };
  const mouth = (kind: "flat" | "grin" | "grit" | "tired") => {
    if (kind === "flat") rect(9, 16, 6, 1, shade(skin, 0.55));
    else if (kind === "grin") { rect(9, 16, 6, 1, ink); rect(10, 16, 4, 1, white); put(15, 15, ink); put(8, 16, shade(skin, 0.55)); }
    else if (kind === "grit") { rect(9, 15, 6, 2, ink); rect(9, 15, 6, 1, white); put(10, 16, white); put(13, 16, white); }
    else { rect(9, 16, 6, 1, shade(skin, 0.55)); put(9, 17, shade(skin, 0.6)); put(14, 17, shade(skin, 0.6)); }
  };

  switch (band) {
    case "WINNING":
      // Shades across both eyes with a glint, raised brow, smug one-sided grin.
      rect(6, 11, 12, 2, ink); rect(11, 11, 2, 1, "#111827"); put(8, 11, "#94a3b8"); put(15, 11, "#94a3b8");
      rect(14, 9, 3, 1, skinDark); mouth("grin");
      break;
    case "WOUNDED":
      eye(7, "open"); eye(14, "half"); mouth("tired");
      rect(15, 13, 2, 2, "#6b4a7a"); // bruise
      put(7, 9, "#9f1239"); put(8, 8, "#9f1239"); // small cut
      rect(5, 9, 4, 1, "#d6d3d1"); // field dressing at the helmet edge
      break;
    case "CRITICAL":
      eye(7, "half"); eye(14, "half"); mouth("grit");
      // Black eye: a ring around the right eye, not a patch.
      for (const [x, y] of [[13, 11], [13, 12], [17, 11], [17, 12], [14, 13], [15, 13], [16, 13], [14, 11], [16, 11]] as const) put(x, y, "#4a2545");
      // Blood from a forehead wound, kept to a few pixels.
      put(9, 8, "#7f1d1d"); put(9, 9, "#991b1b"); put(8, 10, "#991b1b"); put(8, 13, "#7f1d1d"); put(8, 14, "#7f1d1d"); put(16, 15, "#7f1d1d");
      put(17, 9, "#a5f3fc"); // sweat
      rect(12, 5, 1, 2, ink); // cracked helmet
      break;
    case "DEAD":
      eye(7, "x"); eye(14, "x"); mouth("flat");
      break;
    default:
      eye(7, "open"); eye(14, "open"); mouth("flat");
  }

  if (band === "DEAD") for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const c = g[y][x]; if (c) g[y][x] = grey(c); }
  return g;
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

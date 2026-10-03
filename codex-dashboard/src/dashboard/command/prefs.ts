/**
 * Virtual Command Centre display preferences. Purely local presentation (this browser's localStorage, read and written
 * inside try/catch so private windows and blocked storage just fall back to defaults). Changing them never touches the
 * Fleet.
 */
export type Quality = "low" | "medium" | "high" | "ultra";
export type Renderer = "auto" | "3d" | "map";

export interface VirtualPrefs {
  quality: Quality;
  fps: 30 | 60;
  reduceMotion: boolean;
  ambient: boolean;
  dataFlow: boolean;
  /** "auto" = 3D where WebGL is available on a capable device, else the 2D map; "map" never loads WebGL. */
  renderer: Renderer;
}

export const QUALITIES: readonly Quality[] = ["low", "medium", "high", "ultra"];
export const STORAGE_KEY = "fleet.virtual.prefs.v1";

/** What each quality level turns on (both renderers read this; one table, no scattered magic numbers). */
export const QUALITY_PROFILE: Readonly<Record<Quality, { dpr: number; shadows: boolean; particles: number; packets: number; reflections: boolean; fog: boolean; screens: boolean; segments: number }>> = Object.freeze({
  low: { dpr: 1, shadows: false, particles: 0, packets: 12, reflections: false, fog: false, screens: false, segments: 8 },
  medium: { dpr: 1.25, shadows: false, particles: 80, packets: 24, reflections: false, fog: true, screens: true, segments: 16 },
  high: { dpr: 1.5, shadows: true, particles: 220, packets: 40, reflections: true, fog: true, screens: true, segments: 24 },
  ultra: { dpr: 2, shadows: true, particles: 480, packets: 60, reflections: true, fog: true, screens: true, segments: 40 },
});

export interface DeviceHints {
  width: number;
  cores: number | null;
  memoryGb: number | null;
  coarsePointer: boolean;
  prefersReducedMotion: boolean;
  webgl: boolean;
}

export type DeviceClass = "phone" | "tablet" | "desktop";
export const deviceClass = (h: DeviceHints): DeviceClass => (h.width < 640 ? "phone" : h.width < 1100 || (h.coarsePointer && h.width < 1400) ? "tablet" : "desktop");

/** Sensible defaults from what the browser says about the device. Phones get the map; nothing forces WebGL on them. */
export function defaultPrefs(h: DeviceHints): VirtualPrefs {
  const cls = deviceClass(h);
  const strong = (h.cores ?? 4) >= 8 && (h.memoryGb ?? 8) >= 8;
  const quality: Quality = cls === "phone" ? "low" : cls === "tablet" ? "medium" : strong ? "high" : "medium";
  return { quality, fps: cls === "desktop" ? 60 : 30, reduceMotion: h.prefersReducedMotion, ambient: !h.prefersReducedMotion, dataFlow: true,
    renderer: !h.webgl || cls === "phone" ? "map" : "auto" };
}

/** Accept only well-formed stored values; anything else falls back to the default, field by field. */
export function sanitizePrefs(raw: unknown, fallback: VirtualPrefs): VirtualPrefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    quality: QUALITIES.includes(r.quality as Quality) ? (r.quality as Quality) : fallback.quality,
    fps: r.fps === 30 || r.fps === 60 ? r.fps : fallback.fps,
    reduceMotion: typeof r.reduceMotion === "boolean" ? r.reduceMotion : fallback.reduceMotion,
    ambient: typeof r.ambient === "boolean" ? r.ambient : fallback.ambient,
    dataFlow: typeof r.dataFlow === "boolean" ? r.dataFlow : fallback.dataFlow,
    renderer: r.renderer === "auto" || r.renderer === "3d" || r.renderer === "map" ? r.renderer : fallback.renderer,
  };
}

export function loadPrefs(fallback: VirtualPrefs, storage: Pick<Storage, "getItem"> | null = safeStorage()): VirtualPrefs {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    return raw ? sanitizePrefs(JSON.parse(raw), fallback) : fallback;
  } catch {
    return fallback;
  }
}

export function savePrefs(p: VirtualPrefs, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(p)); } catch { /* storage blocked: the preference lasts this session only */ }
}

function safeStorage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

/** What the browser reports (only called in the browser). */
export function readDeviceHints(): DeviceHints {
  let webgl = false;
  try {
    const c = document.createElement("canvas");
    webgl = Boolean(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch { webgl = false; }
  const nav = navigator as Navigator & { deviceMemory?: number };
  return { width: window.innerWidth, cores: nav.hardwareConcurrency ?? null, memoryGb: nav.deviceMemory ?? null,
    coarsePointer: window.matchMedia?.("(pointer: coarse)").matches ?? false,
    prefersReducedMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false, webgl };
}

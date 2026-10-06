/**
 * The headquarters' static world: the complex shell (ground, corridor deck with data conduits, pillars, perimeter),
 * each department as a real room (tiled floor, walls with lit door frames, a low glass-topped front parapet so the
 * cutaway stays readable, ceiling light housings, cable trays) and its purpose-built equipment, built through
 * GeoBuilder into a handful of merged meshes. Returns the placements of the live elements the scene adds on top: data
 * screens, boards and the Treasury banner (fed with FleetController's data), signs, room lights, beacons, the command
 * core — and the rooms' WORK SPOTS (seats at desks, places at consoles and tables) where agents whose state puts them in
 * that department stand or sit.
 *
 * Furniture is architecture, not activity: nothing here moves or reports anything. What moves is people (FleetController
 * state) and information (recorded events); what the screens show is FleetController's data (screens.tsx).
 */
import { DEPARTMENTS, type Department, type DepartmentId } from "../../command/departments";
import { GeoBuilder, type MatKey } from "./builder";
import { WORLD } from "../world";
import { CROSS_Z, INTAKE, SPINE_X } from "./route";
import { navGrid, type Footprint, type NavGrid } from "./nav";

export type ScreenKind = "status" | "sign" | "board" | "banner";
export interface ScreenSpot { id: string; dep: DepartmentId; kind: ScreenKind; w: number; h: number; x: number; y: number; z: number; ry: number; rx?: number; board?: string }
/** A room's light: position, colour and mood (relative strength: quiet rooms are darker). */
export interface LightSpot { dep: DepartmentId; x: number; y: number; z: number; colour: string; mood: number }
export interface BeaconSpot { x: number; y: number; z: number }
/** Where an agent works in a room: position, the direction it faces (yaw, three.js about +Y) and its posture. */
/** A tall static obstacle (footprint and height) the Agent View camera must not look through. */
export interface Occluder { x0: number; z0: number; x1: number; z1: number; h: number }
export interface WorkSpot { x: number; z: number; yaw: number; pose: "seat" | "stand"; /** A place at a shared table (team projects meet here). */ table?: boolean }

export const WALL_H = 3.6;
/** The area people can walk in (inside the perimeter wall). */
export const NAV_BOUNDS = Object.freeze({ minX: WORLD.minX - 4, maxX: WORLD.maxX + 4, minZ: WORLD.minZ - 4, maxZ: WORLD.maxZ + 4 });
const T = 0.3; // wall thickness

export interface WorldPlan {
  builder: GeoBuilder; details: GeoBuilder; screens: ScreenSpot[]; lights: LightSpot[]; beacons: BeaconSpot[];
  core: { x: number; y: number; z: number }; spots: Record<DepartmentId, WorkSpot[]>; occluders: Occluder[];
  /** Every solid's floor footprint in the walking band, and the walkable floor rasterised from them (nav.ts). */
  footprints: Footprint[]; nav: NavGrid;
}

/** Yaw that faces from (x, z) towards (tx, tz). */
const facing = (x: number, z: number, tx: number, tz: number) => Math.atan2(tx - x, tz - z);

const MOOD: Record<DepartmentId, number> = { command: 1, treasury: 0.9, opportunity: 0.85, floor: 1, marketing: 0.95, library: 0.72, venture: 0.9, identity: 0.75, estate: 0.45, comms: 0.8, security: 0.7 };

export function buildWorld(): WorldPlan {
  const b = new GeoBuilder(), details = new GeoBuilder();
  const screens: ScreenSpot[] = [], lights: LightSpot[] = [], beacons: BeaconSpot[] = [], occluders: Occluder[] = [];
  /** Register a tall obstacle (axis-aligned footprint w × d at x, z; height h). */
  const occ = (x: number, z: number, w: number, d: number, h: number) => { if (h >= 1.3) occluders.push({ x0: x - w / 2, z0: z - d / 2, x1: x + w / 2, z1: z + d / 2, h }); };
  const spots = Object.fromEntries(DEPARTMENTS.map((d) => [d.id, [] as WorkSpot[]])) as unknown as Record<DepartmentId, WorkSpot[]>;
  const W = WORLD, cxW = (W.minX + W.maxX) / 2, czW = (W.minZ + W.maxZ) / 2;

  // Ground and the complex's corridor deck.
  b.box("ground", 200, 0.1, 200, 0, -0.1, 0);
  b.box("corridor", W.maxX - W.minX + 6, 0.1, W.maxZ - W.minZ + 6, cxW, -0.02, czW);
  // Perimeter: a low wall with a glass band and posts.
  const perim = (x: number, z: number, w: number, d: number) => { b.box("wallTrim", w, 1.1, d, x, 0.55, z); b.box("glass", Math.max(w, 0.05), 0.9, Math.max(d, 0.05), x, 1.55, z); };
  perim(cxW, W.minZ - 3, W.maxX - W.minX + 6, T); perim(cxW, W.maxZ + 3, W.maxX - W.minX + 6, T);
  perim(W.minX - 3, czW, T, W.maxZ - W.minZ + 6); perim(W.maxX + 3, czW, T, W.maxZ - W.minZ + 6);
  for (let x = W.minX - 3; x <= W.maxX + 3; x += 6) { b.box("darkMetal", 0.2, 2.1, 0.2, x, 1.05, W.minZ - 3); b.box("darkMetal", 0.2, 2.1, 0.2, x, 1.05, W.maxZ + 3); }
  for (let z = W.minZ - 3; z <= W.maxZ + 3; z += 6) { b.box("darkMetal", 0.2, 2.1, 0.2, W.minX - 3, 1.05, z); b.box("darkMetal", 0.2, 2.1, 0.2, W.maxX + 3, 1.05, z); }
  // East gate: the external gateway where outside information enters (an arch, scanners, the conduit's start).
  b.box("accent:#38bdf8", 0.3, 3.4, 0.4, W.maxX + 3, 1.7, -6); b.box("accent:#38bdf8", 0.3, 3.4, 0.4, W.maxX + 3, 1.7, -2);
  b.box("darkMetal", 0.5, 0.4, 4.4, W.maxX + 3, 3.5, -4); b.box("glow:#38bdf8", 0.08, 0.06, 3.6, W.maxX + 2.7, 3.25, -4);
  for (const z of [-5.6, -2.4]) { b.box("darkMetal", 0.6, 1.2, 0.3, W.maxX + 1.6, 0.6, z); b.box("glow:#38bdf8", 0.5, 0.04, 0.05, W.maxX + 1.6, 1.0, z + 0.16); }

  // Data conduits — the building's nervous system, set FLUSH into the deck (nothing to step over): a dark recessed
  // channel, a lit core and a glass floor window over it, framed by thin metal rails. Hierarchy reads in the widths:
  // the MAIN BACKBONE runs up both service spines (wide), DEPARTMENT BRANCHES along the cross corridors (narrower),
  // ROOM CHANNELS into each department (narrowest, below), ending at the room's intake. Junctions are round floor
  // windows; a vertical data trunk climbs the pillar beside each one. Ambient glow only; packets carry meaning.
  const conduitZ = [...CROSS_Z], conduitX = [...SPINE_X];
  const channel = (x: number, z: number, len: number, along: "x" | "z", wd: number, y0 = 0.03) => {
    const W2 = (w: number) => (along === "x" ? [len, w] : [w, len]) as [number, number];
    let [sx, sz] = W2(wd + 0.08); b.box("metal", sx, 0.012, sz, x, y0 + 0.004, z);
    [sx, sz] = W2(wd); b.box("floorDark", sx, 0.012, sz, x, y0 + 0.006, z);
    [sx, sz] = W2(Math.max(0.05, wd * 0.18)); b.box("glow:#0e4a5c", sx, 0.006, sz, x, y0 + 0.012, z);
    [sx, sz] = W2(wd - 0.04); b.box("glass", sx, 0.004, sz, x, y0 + 0.017, z);
  };
  for (const x of conduitX) channel(x, czW, W.maxZ - W.minZ, "z", 0.62);
  for (const z of conduitZ) channel(cxW, z, W.maxX - W.minX + 2, "x", 0.42);
  channel((W.maxX + 3 + 10) / 2, -4, W.maxX + 3 - 10, "x", 0.42);
  for (const z of conduitZ) for (const x of conduitX) {
    b.cyl("metal", 0.56, 0.56, 0.014, x, 0.03, z, 32); b.cyl("floorDark", 0.5, 0.5, 0.016, x, 0.031, z, 32);
    b.cyl("glass", 0.46, 0.46, 0.004, x, 0.046, z, 32); b.ring("glow:#22d3ee", 0.48, 0.012, x, 0.05, z, 40);
  }
  // Edge guide lights along the corridors.
  for (const z of conduitZ.slice(0, 5)) { b.box("glow:#123d4d", W.maxX - W.minX + 2, 0.02, 0.05, cxW, 0.04, z - 0.9); b.box("glow:#123d4d", W.maxX - W.minX + 2, 0.02, 0.05, cxW, 0.04, z + 0.9); }
  // Pillars beside the crossings, with junction boxes where conduits meet.
  for (const z of conduitZ.slice(0, 5)) for (const x of conduitX) {
    const px = x + (x < 0 ? -0.9 : 0.9);
    b.box("darkMetal", 0.7, WALL_H + 0.6, 0.7, px, (WALL_H + 0.6) / 2, z - 0.9);
    b.box("glow:#22d3ee", 0.72, 0.06, 0.72, px, 2.4, z - 0.9);
    b.box("wallTrim", 0.9, 0.2, 0.9, px, 0.1, z - 0.9);
    // The vertical data trunk: a lit riser up the pillar face toward the junction, fed by a short floor link.
    const face = px + (x < 0 ? 0.36 : -0.36);
    b.box("darkMetal", 0.06, WALL_H - 0.2, 0.2, face, (WALL_H - 0.2) / 2 + 0.1, z - 0.9); b.box("glow:#0e7490", 0.02, WALL_H - 0.4, 0.06, face + (x < 0 ? 0.035 : -0.035), (WALL_H - 0.4) / 2 + 0.2, z - 0.9);
    channel((x + face) / 2, z - 0.45, 0.9, "z", 0.12);
  }
  // The open concourses beside the Agent Floor: benches, planters and wayfinding totems.
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) { const z = -7 + i * 4.5; b.box("darkMetal", 2.6, 0.45, 0.7, sx * 18, 0.22, z); b.box("fabric", 2.4, 0.12, 0.6, sx * 18, 0.5, z); b.box("fabric", 2.4, 0.5, 0.1, sx * 18, 0.8, z + 0.3); }
    for (const z of [-9, 1]) { b.box("concrete", 1.2, 0.8, 1.2, sx * 22.5, 0.4, z); b.sphere("fabric", 0.55, sx * 22.5, 1.1, z, 10, 0.8); }
    b.box("darkMetal", 0.5, 2.4, 0.18, sx * 14.5, 1.2, -4); b.box("glow:#22d3ee", 0.4, 0.04, 0.2, sx * 14.5, 2.3, -4);
  }

  // One headquarters: a structural facade around the complex (columns, a roof-edge beam above the room height, a lit
  // fascia), service conduits along both spines at every level, and canopies over the open concourses.
  const fx0 = W.minX - 3, fx1 = W.maxX + 3, fz0 = W.minZ - 3, fz1 = W.maxZ + 3, FH = 4.6;
  for (let x = fx0; x <= fx1 + 0.01; x += 6) for (const z of [fz0, fz1]) b.box("darkMetal", 0.32, FH, 0.32, x, FH / 2, z);
  for (let z = fz0; z <= fz1 + 0.01; z += 6) for (const x of [fx0, fx1]) b.box("darkMetal", 0.32, FH, 0.32, x, FH / 2, z);
  for (const z of [fz0, fz1]) { b.box("wallTrim", fx1 - fx0, 0.3, 0.42, (fx0 + fx1) / 2, FH, z); b.box("glow:#0e7490", fx1 - fx0, 0.04, 0.05, (fx0 + fx1) / 2, FH - 0.2, z + (z < 0 ? 0.22 : -0.22)); }
  for (const x of [fx0, fx1]) { b.box("wallTrim", 0.42, 0.3, fz1 - fz0, x, FH, (fz0 + fz1) / 2); b.box("glow:#0e7490", 0.05, 0.04, fz1 - fz0, x + (x < 0 ? 0.22 : -0.22), FH - 0.2, (fz0 + fz1) / 2); }
  for (const x of SPINE_X) {
    b.box("darkMetal", 0.5, 0.1, W.maxZ - W.minZ - 4, x, WALL_H + 0.55, czW); b.box("rubber", 0.36, 0.08, W.maxZ - W.minZ - 4, x, WALL_H + 0.5, czW);
    b.box("glow:#0e4a5c", 0.06, 0.03, W.maxZ - W.minZ - 4, x, WALL_H + 0.48, czW);
    for (let z = W.minZ + 2; z < W.maxZ - 2; z += 6) b.box("darkMetal", 0.06, 0.9, 0.06, x, WALL_H + 0.05, z);
  }
  for (const sx of [-1, 1]) {
    const cx = sx * 18, cz = -4;
    for (const [px, pz] of [[-4, -5], [4, -5], [-4, 5], [4, 5]]) b.box("darkMetal", 0.18, 4.4, 0.18, cx + px, 2.2, cz + pz);
    for (let i = 0; i < 9; i++) b.box("wallTrim", 8.4, 0.06, 0.24, cx, 4.45, cz - 4.4 + i * 1.1);
    b.box("glow:#164e63", 8.2, 0.03, 0.05, cx, 4.38, cz - 5); b.box("glow:#164e63", 8.2, 0.03, 0.05, cx, 4.38, cz + 5);
  }

  for (const d of DEPARTMENTS) { b.chunk = d.id; room(d); }
  b.chunk = "shell";
  gantries();
  const footprints = [...b.footprints, ...details.footprints], nav = navGrid(footprints, NAV_BOUNDS);
  return { builder: b, details, screens, lights, beacons, core: { x: 0, y: 0.5, z: -31.5 }, spots, occluders, footprints, nav };

  /** A room: floor with an accent inset, walls with doorways, a cutaway front parapet, a sign, ceiling housings, cable trays. */
  function room(d: Department) {
    const x0 = d.x - d.w / 2, x1 = d.x + d.w / 2, z0 = d.z - d.d / 2, z1 = d.z + d.d / 2, acc: MatKey = `accent:${d.accent}`, glow: MatKey = `glow:${d.accent}`;
    b.box("floor", d.w, 0.12, d.d, d.x, 0.06, d.z);
    // Accent inset around the floor, and a darker equipment band along the back wall.
    b.box(acc, d.w - 0.6, 0.02, 0.05, d.x, 0.13, z0 + 0.5); b.box(acc, d.w - 0.6, 0.02, 0.05, d.x, 0.13, z1 - 0.5);
    b.box(acc, 0.05, 0.02, d.d - 1, x0 + 0.3, 0.13, d.z); b.box(acc, 0.05, 0.02, d.d - 1, x1 - 0.3, 0.13, d.z);
    b.box("floorDark", d.w - 0.8, 0.02, 1.6, d.x, 0.125, z0 + 1.3);
    // The room's data conduit: from the front opening to the equipment wall (packets enter and leave along it) — a
    // glass tube on a dark channel, from the receiving socket at the opening to the room's intake (route.ts INTAKE).
    b.box("floorDark", 0.36, 0.02, d.d - 1.2, d.x, 0.13, d.z + 0.3); b.box(glow, 0.05, 0.02, d.d - 1.2, d.x, 0.142, d.z + 0.3);
    const intake = INTAKE[d.id], tubeLen = z1 - intake.z;
    channel(d.x, (z1 + intake.z) / 2, tubeLen, "z", 0.3, 0.12);
    // Receiving socket at the opening: a flush collar ring set into the threshold, lit in the department's colour.
    b.cyl("darkMetal", 0.34, 0.34, 0.03, d.x, 0.12, z1, 24); b.ring(glow, 0.3, 0.014, d.x, 0.152, z1, 32);
    if (d.id !== "command" && d.id !== "treasury") {
      // The intake node: a low armoured socket with a glass dome where the conduit ends, a status lamp on the wall behind.
      b.cyl("darkMetal", 0.36, 0.42, 0.1, intake.x, 0.12, intake.z, 24); b.cyl("metal", 0.26, 0.3, 0.04, intake.x, 0.22, intake.z, 24);
      b.sphere("glass", 0.2, intake.x, 0.24, intake.z, 18, 0.25); b.ring(glow, 0.33, 0.016, intake.x, 0.235, intake.z, 32);
    }
    // Back wall (full height) with trims, panel ribs, a lit cornice and skirting.
    b.box("wall", d.w + T, WALL_H, T, d.x, WALL_H / 2, z0);
    b.box("wallTrim", d.w + T, 0.18, T + 0.08, d.x, WALL_H, z0);
    b.box(glow, d.w - 1, 0.05, 0.05, d.x, WALL_H - 0.25, z0 + 0.2);
    b.box("darkMetal", d.w, 0.16, 0.05, d.x, 0.08, z0 + T / 2 + 0.03);
    for (let x = x0 + 1.5; x < x1 - 0.5; x += 2) b.box("wallTrim", 0.06, WALL_H - 0.5, 0.04, x, (WALL_H - 0.5) / 2 + 0.2, z0 + T / 2 + 0.02);
    // Cable tray along the top of the back wall.
    b.box("darkMetal", d.w - 0.6, 0.08, 0.35, d.x, WALL_H - 0.55, z0 + 0.45); b.box("rubber", d.w - 0.8, 0.06, 0.2, d.x, WALL_H - 0.49, z0 + 0.45);
    // Side walls with a doorway to the corridor (door frame lit with the department's accent).
    for (const sx of [x0, x1]) {
      const door = 2.4, seg = (d.d - door) / 2;
      b.box("wall", T, WALL_H, seg, sx, WALL_H / 2, z0 + seg / 2);
      b.box("wall", T, WALL_H, seg, sx, WALL_H / 2, z1 - seg / 2);
      b.box("wall", T, WALL_H - 2.6, door, sx, 2.6 + (WALL_H - 2.6) / 2, d.z);
      b.box("wallTrim", T + 0.1, 2.6, 0.12, sx, 1.3, d.z - door / 2); b.box("wallTrim", T + 0.1, 2.6, 0.12, sx, 1.3, d.z + door / 2);
      b.box(glow, T + 0.12, 0.05, door, sx, 2.62, d.z);
      b.box("wallTrim", T + 0.08, 0.18, d.d, sx, WALL_H, d.z);
      const inX = sx + (sx < d.x ? 0.19 : -0.19);
      b.box("darkMetal", 0.06, 0.32, 0.22, inX, 1.35, d.z - door / 2 - 0.35); b.box(glow, 0.02, 0.06, 0.14, inX + (sx < d.x ? 0.04 : -0.04), 1.42, d.z - door / 2 - 0.35);
    }
    // Front: a low parapet with a glass band (the cutaway), opening onto the corridor.
    const open = 3.2, seg = (d.w - open) / 2;
    for (const sx of [-1, 1]) {
      const cx = d.x + sx * (open / 2 + seg / 2);
      b.box("wallTrim", seg, 0.9, T, cx, 0.45, z1); b.box("glass", seg, 0.7, 0.04, cx, 1.25, z1); b.box(glow, seg, 0.03, 0.05, cx, 0.92, z1 + 0.12);
      b.box("darkMetal", 0.14, 1.65, 0.14, d.x + sx * (open / 2), 0.82, z1);
    }
    // Entrance threshold: a lit strip across the opening in the department's colour (nothing overhead in the view).
    b.box("darkMetal", open, 0.03, 0.5, d.x, 0.135, z1); b.box(glow, open - 0.2, 0.02, 0.06, d.x, 0.15, z1 + 0.12);
    // Sign above the back wall's centre, ceiling light housings (pools of light below them), the room light.
    screens.push({ id: `${d.id}:sign`, dep: d.id, kind: "sign", w: Math.min(7, d.w - 4), h: 0.55, x: d.x, y: WALL_H - 0.6, z: z0 + T / 2 + 0.02, ry: 0 });
    lights.push({ dep: d.id, x: d.x, y: WALL_H - 0.3, z: d.z, colour: d.accent, mood: MOOD[d.id] });
    for (const i of [-1, 1]) for (const j of [0, 1]) {
      const lx = d.x + i * d.w / 4, lz = z0 + d.d * (j ? 0.66 : 0.3);
      b.box("darkMetal", 1.7, 0.08, 0.42, lx, WALL_H + 0.02, lz); b.box("glow:#cfe8f7", 1.5, 0.03, 0.26, lx, WALL_H - 0.03, lz);
    }
    // Integrated wall lights: a low recessed strip along each side wall's back segment (light from fixtures, not paint).
    for (const sx of [x0, x1]) { const inX = sx + (sx < d.x ? 0.17 : -0.17), seg2 = (d.d - 2.4) / 2; b.box("anodized", 0.03, 0.07, seg2 - 0.4, inX, 0.42, z0 + seg2 / 2); b.box("glow:#9fb8d6", 0.012, 0.025, seg2 - 0.5, inX + (sx < d.x ? 0.016 : -0.016), 0.42, z0 + seg2 / 2); }
    interior(d, x0, x1, z0, z1, acc, glow);
  }

  /** Each department's equipment and its work spots. */
  function interior(d: Department, x0: number, x1: number, z0: number, z1: number, acc: MatKey, glow: MatKey) {
    const back = z0 + T / 2, S = spots[d.id];
    const wallScreen = (id: string, kind: ScreenKind, w: number, h: number, x: number, y: number, board?: string) => {
      b.box("darkMetal", w + 0.14, h + 0.14, 0.08, x, y, back + 0.04);
      screens.push({ id, dep: d.id, kind, w, h, x, y, z: back + 0.09, ry: 0, board });
    };
    const sideScreen = (id: string, kind: ScreenKind, side: -1 | 1, w: number, h: number, z: number, y: number, board?: string) => {
      const x = side < 0 ? x0 + T / 2 : x1 - T / 2;
      b.box("darkMetal", 0.08, h + 0.14, w + 0.14, x - side * 0.04, y, z);
      screens.push({ id, dep: d.id, kind, w, h, x: x - side * 0.09, y, z, ry: side < 0 ? Math.PI / 2 : -Math.PI / 2, board });
    };
    const status = (w: number, h: number, x: number, y: number) => wallScreen(`${d.id}:status`, "status", w, h, x, y);
    /** A chair whose seat is at (x, z), its back away from `yaw`. */
    const chair = (x: number, z: number, yaw: number) => {
      const bx = x - Math.sin(yaw) * 0.26, bz = z - Math.cos(yaw) * 0.26;
      b.box("fabric", 0.5, 0.08, 0.48, x, 0.5, z, yaw); b.box("fabric", 0.48, 0.42, 0.07, bx, 0.78, bz, yaw);
      b.cyl("darkMetal", 0.03, 0.03, 0.42, x, 0.06, z, 8); b.cyl("darkMetal", 0.28, 0.3, 0.05, x, 0.04, z, 12);
    };
    /**
     * A workstation desk facing `ry` (0 = monitors towards the back wall), with a modesty panel, `monitors` screens, a
     * desk light, a pedestal and a chair; its seat becomes a work spot.
     */
    const desk = (x: number, z: number, ry: number, monitors = 1, seat = true) => {
      const c = Math.cos(ry), sn = Math.sin(ry);
      const at = (lx: number, lz: number) => ({ x: x + lx * c + lz * sn, z: z - lx * sn + lz * c });
      b.box("desk", 1.4, 0.05, 0.7, x, 0.76, z, ry); b.box("wallTrim", 1.42, 0.02, 0.72, x, 0.735, z, ry);
      const panel = at(0, -0.32); b.box("darkMetal", 1.3, 0.68, 0.04, panel.x, 0.38, panel.z, ry);
      for (const lx of [-0.66, 0.66]) { const l = at(lx, 0); b.box("darkMetal", 0.05, 0.72, 0.62, l.x, 0.37, l.z, ry); }
      for (let m = 0; m < monitors; m++) {
        const off = (m - (monitors - 1) / 2) * 0.6, turn = monitors > 1 ? -(m - (monitors - 1) / 2) * 0.25 : 0;
        const body = at(off, -0.2), face = at(off, -0.175), stand = at(off, -0.24);
        b.box("darkMetal", 0.56, 0.34, 0.035, body.x, 1.06, body.z, ry + turn);
        b.box("screen", 0.5, 0.28, 0.01, face.x, 1.06, face.z, ry + turn);
        b.box("darkMetal", 0.05, 0.2, 0.05, stand.x, 0.88, stand.z, ry); b.box("darkMetal", 0.22, 0.015, 0.16, stand.x, 0.79, stand.z, ry);
      }
      const kb = at(0, 0.06); b.box("rubber", 0.44, 0.02, 0.14, kb.x, 0.79, kb.z, ry);
      // Under-desk light along the front edge and the monitors' spill on the desktop.
      const edge = at(0, 0.36); b.box("glow:#0b3d52", 1.2, 0.015, 0.02, edge.x, 0.7, edge.z, ry);
      const spill = at(0, -0.05); b.box("glow:#0a2433", 0.9 * Math.min(1.6, monitors), 0.004, 0.22, spill.x, 0.787, spill.z, ry);
      const lamp = at(0.58, -0.22); b.cyl("darkMetal", 0.012, 0.012, 0.4, lamp.x, 0.79, lamp.z, 6); b.box("glow:#fde7c4", 0.16, 0.02, 0.06, lamp.x, 1.19, lamp.z, ry);
      const ped = at(-0.42, 0.02); b.box("darkMetal", 0.36, 0.52, 0.5, ped.x, 0.27, ped.z, ry);
      if (seat) { const s = at(0, 0.62), yaw = ry + Math.PI; chair(s.x, s.z, yaw); S.push({ x: s.x, z: s.z, yaw, pose: "seat" }); }
    };
    /** A standing console (sloped top with a screen) facing `ry`; the operator's place becomes a work spot. */
    const console = (x: number, z: number, ry: number, w = 1.6, spot = true) => {
      b.box("equipment", w, 0.84, 0.6, x, 0.48, z, ry); b.box("rubber", w - 0.06, 0.07, 0.54, x, 0.155, z, ry); // body on a recessed kick plinth
      b.box("anodized", w, 0.06, 0.66, x, 0.92, z, ry, -0.35);
      b.box("screen", w - 0.2, 0.42, 0.02, x + Math.sin(ry) * -0.05, 1.04, z + Math.cos(ry) * -0.05, ry, -0.35);
      b.box(glow, w - 0.1, 0.03, 0.03, x + Math.sin(ry) * 0.31, 0.88, z + Math.cos(ry) * 0.31, ry);
      if (spot) S.push({ x: x + Math.sin(ry) * 0.75, z: z + Math.cos(ry) * 0.75, yaw: ry + Math.PI, pose: "stand" });
    };
    const rack = (x: number, z: number, led: MatKey, h = 2.2) => {
      b.box("enclosure", 0.7, h, 0.9, x, h / 2, z); b.box("grille", 0.66, h - 0.1, 0.02, x, h / 2, z + 0.45); b.box("anodized", 0.72, 0.04, 0.92, x, h + 0.02, z); occ(x, z, 0.7, 0.9, h);
      for (let r = 0; r < Math.floor(h / 0.24); r++) { b.box(r % 3 ? "rubber" : led, 0.42, 0.03, 0.01, x - 0.05, 0.3 + r * 0.21, z + 0.465); b.box(led, 0.04, 0.03, 0.01, x + 0.24, 0.3 + r * 0.21, z + 0.465); }
    };
    const shelf = (x: number, w: number, h = 2.4) => {
      b.box("darkMetal", w, h, 0.45, x, h / 2, back + 0.25); occ(x, back + 0.25, w, 0.45, h);
      for (let r = 0; r < 4; r++) { const y = 0.35 + r * (h - 0.4) / 4; b.box("metal", w - 0.1, 0.04, 0.42, x, y, back + 0.27);
        for (let i = 0; i < Math.floor(w / 0.16); i++) { const hh = 0.24 + ((i * 37 + r * 11) % 7) * 0.02; b.box(i % 5 === 0 ? acc : "paper", 0.12, hh, 0.3, x - w / 2 + 0.12 + i * 0.16, y + hh / 2 + 0.02, back + 0.28); } }
    };
    /** A round table with a lit rim and `n` places around it (stand or seat). */
    const table = (x: number, z: number, r: number, n: number, pose: WorkSpot["pose"], top: MatKey = "desk") => {
      b.cyl("darkMetal", 0.25, 0.35, 0.7, x, 0, z, 16); b.cyl(top, r, r, 0.06, x, 0.72, z, 32); b.ring(glow, r - 0.02, 0.015, x, 0.79, z, 48);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.PI / n, px = x + Math.cos(a) * (r + 0.45), pz = z + Math.sin(a) * (r + 0.45), yaw = facing(px, pz, x, z);
        if (pose === "seat") chair(px, pz, yaw);
        S.push({ x: px, z: pz, yaw, pose, table: true });
      }
    };
    const pinboard = (side: -1 | 1, z: number, w: number) => {
      const x = side < 0 ? x0 + T / 2 + 0.03 : x1 - T / 2 - 0.03;
      b.box("paper", 0.03, 1.1, w, x, 1.75, z);
      for (let i = 0; i < 8; i++) b.box(i % 3 ? "metal" : acc, 0.02, 0.18 + (i % 3) * 0.05, 0.24, x - side * 0.02, 1.45 + (i % 2) * 0.45, z - w / 2 + 0.3 + i * (w - 0.6) / 7);
    };

    /** An equipment cabinet (h above the floor) with a vent grille, a lamp and corner bolts on its face (+z turned by ry). */
    const cabinet = (x: number, z: number, w: number, dd: number, h: number, ry = 0, lamp: MatKey = glow) => {
      const c = Math.cos(ry), sn = Math.sin(ry), at = (lx: number, lz: number) => ({ x: x + lx * c + lz * sn, z: z - lx * sn + lz * c });
      b.box("equipment", w, h, dd, x, 0.12 + h / 2, z, ry);
      const g = at(0, dd / 2 + 0.006); b.box("grille", w * 0.72, Math.min(0.4, h * 0.35), 0.012, g.x, 0.12 + h * 0.32, g.z, ry);
      const l = at(w * 0.34, dd / 2 + 0.008); b.box(lamp, 0.06, 0.03, 0.01, l.x, 0.12 + h * 0.84, l.z, ry);
      for (const [bx, by] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { const q = at(bx * (w / 2 - 0.04), dd / 2 + 0.006); b.box("metal", 0.018, 0.018, 0.01, q.x, 0.12 + h / 2 + by * (h / 2 - 0.05), q.z, ry); }
      if (h >= 1.3) occ(x, z, Math.abs(c) > 0.5 ? w : dd, Math.abs(c) > 0.5 ? dd : w, h + 0.12);
    };
    /** A display hung from the ceiling on two rods, both faces lit (a surface, not data). */
    const hanging = (x: number, z: number, w: number, h: number, y: number, ry = 0, face: MatKey = "screen") => {
      const c = Math.cos(ry), sn = Math.sin(ry);
      b.box("darkMetal", w + 0.08, h + 0.08, 0.07, x, y, z, ry);
      for (const f of [-1, 1]) b.box(face, w, h, 0.01, x + sn * f * 0.04, y, z + c * f * 0.04, ry);
      for (const r of [-1, 1]) b.box("darkMetal", 0.02, WALL_H - y - h / 2, 0.02, x + c * r * w * 0.38, (WALL_H + y + h / 2) / 2, z - sn * r * w * 0.38);
    };
    /** A thin straight inlay line on the floor from (ax, az) to (bx, bz). */
    const inlay = (key: MatKey, ax: number, az: number, bx: number, bz: number, wd = 0.04) => {
      const l = Math.hypot(bx - ax, bz - az); b.box(key, wd, 0.008, l, (ax + bx) / 2, 0.128, (az + bz) / 2, Math.atan2(bx - ax, bz - az));
    };
    /** A ceiling beam (painted structural steel) from (ax, az) to (bx, bz) at the ceiling line. */
    const beam = (ax: number, az: number, bx: number, bz: number, wd = 0.12, y = WALL_H - 0.05) => {
      const l = Math.hypot(bx - ax, bz - az); b.box("painted", wd, 0.14, l, (ax + bx) / 2, y, (az + bz) / 2, Math.atan2(bx - ax, bz - az));
    };

    switch (d.id) {
      case "command": {
        // The raised command dais (the live core sits on it), an overhead ring truss, six tactical consoles on an arc,
        // the live Fleet status wall, secondary control stations and racks.
        const cz = z0 + 3.5;
        b.cyl("darkMetal", 3.0, 3.2, 0.5, d.x, 0, cz, 48); b.cyl("floorDark", 2.9, 2.9, 0.04, d.x, 0.5, cz, 48); b.ring(glow, 3.05, 0.035, d.x, 0.52, cz, 64);
        for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; b.box("metal", 0.5, 0.02, 0.08, d.x + Math.cos(a) * 2.5, 0.53, cz + Math.sin(a) * 2.5, -a); }
        for (let i = 0; i < 6; i++) {
          const a = Math.PI * (0.18 + i * 0.128), r = 4.2, x = d.x + Math.cos(a) * r, z = cz + Math.sin(a) * r;
          console(x, z, facing(x, z, d.x, cz) + Math.PI, 1.3);
        }
        wallScreen(`${d.id}:agents`, "board", 4.6, 2.1, d.x - 5.0, 2.05, "command:agents");
        wallScreen(`${d.id}:status`, "status", 4.0, 2.1, d.x + 5.0, 2.05);
        sideScreen(`${d.id}:missions`, "board", -1, 2.3, 1.5, z0 + 2.7, 1.95, "command:missions");
        sideScreen(`${d.id}:projects`, "board", 1, 2.3, 1.5, z0 + 2.7, 1.95, "command:projects");
        for (const sx of [-1, 1]) { rack(d.x + sx * (d.w / 2 - 0.8), z0 + 0.8, glow); desk(d.x + sx * 6.4, z1 - 2.0, 0, 2); }
        // V2.3 density: operator banks either side facing the dais (seated), comms panels on the side walls, the overhead
        // ring truss above the core with downlights, radial floor inlays, command seating and vertical light fins.
        for (const sx of [-1, 1] as const) {
          for (const dz of [-1.2, 1.2]) desk(d.x + sx * 6.2, cz + dz, sx < 0 ? -Math.PI / 2 : Math.PI / 2, 2);
          const wx = sx < 0 ? x0 + T / 2 + 0.05 : x1 - T / 2 - 0.05;
          b.box("equipment", 0.1, 1.1, 1.6, wx, 1.4, z1 - 2.0); b.box("screenGlass", 0.012, 0.4, 1.2, wx - sx * 0.056, 1.65, z1 - 2.0);
          for (let i = 0; i < 4; i++) b.box(i % 2 ? glow : "acrylic", 0.012, 0.05, 0.26, wx - sx * 0.056, 1.0 + i * 0.12, z1 - 2.6 + i * 0.4);
          for (let i = 0; i < 3; i++) b.box("acrylic", 0.03, 2.4, 0.08, wx - sx * 0.02, 1.5, z0 + 5.0 + i * 0.5);
        }
        b.ring("painted", 3.5, 0.07, d.x, WALL_H - 0.12, cz, 64); b.ring("painted", 2.2, 0.05, d.x, WALL_H - 0.12, cz, 48);
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
          beam(d.x + c * 2.2, cz + sn * 2.2, d.x + c * 3.5, cz + sn * 3.5, 0.06, WALL_H - 0.12);
          b.box("glow:#cfe8f7", 0.16, 0.03, 0.16, d.x + c * 3.5, WALL_H - 0.22, cz + sn * 3.5);
          inlay(acc, d.x + c * 3.35, cz + sn * 3.35, d.x + c * 5.2, cz + sn * 5.2, 0.03);
        }
        b.ring(acc, 5.25, 0.012, d.x, 0.13, cz, 96);
        break;
      }
      case "treasury": {
        // A secure financial operations room: the vault in the back wall, deposit boxes, the TREASURY BANNER above,
        // ledger desks along the side walls under the Treasury event board and the status wall, settlement stations,
        // a hanging four-sided display over a gold seal, access gates at the opening.
        b.cyl("gold", 1.45, 1.45, 0.22, d.x, 1.6, back + 0.02, 48, Math.PI / 2);
        b.cyl("darkMetal", 1.25, 1.25, 0.26, d.x, 1.6, back + 0.02, 48, Math.PI / 2);
        b.ring("gold", 0.55, 0.05, d.x, 1.73, back + 0.17, 40, 0);
        for (let i = 0; i < 6; i++) { const a = (i * Math.PI) / 3; b.box("gold", 0.07, 0.9, 0.07, d.x + Math.cos(a) * 0.42, 1.73 + Math.sin(a) * 0.42, back + 0.19, 0, 0, a); }
        for (let i = 0; i < 8; i++) { const a = (i * Math.PI) / 4; b.box("darkMetal", 0.18, 0.12, 0.12, d.x + Math.cos(a) * 1.3, 1.73 + Math.sin(a) * 1.3, back + 0.2, 0, 0, a); }
        for (const sx of [-1, 1]) for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) {
          const x = d.x + sx * (2.3 + c * 0.72), y = 0.4 + r * 0.48; b.box("metal", 0.68, 0.44, 0.4, x, y, back + 0.22); b.box("gold", 0.1, 0.035, 0.02, x, y + 0.08, back + 0.43); b.box("rubber", 0.5, 0.02, 0.01, x, y - 0.12, back + 0.43);
        }
        // The banner, mounted on the wall head and tilted towards the corridor so it reads from the Fleet view.
        for (const sx of [-1, 1]) b.box("darkMetal", 0.12, 1.5, 0.12, d.x + sx * 4.3, WALL_H + 0.55, z0 + 0.05);
        b.box("darkMetal", 9.0, 1.86, 0.14, d.x, WALL_H + 0.86, z0 + 0.3, 0, -0.72);
        b.box("gold", 9.04, 0.05, 0.16, d.x, WALL_H + 0.18, z0 + 0.92, 0, -0.72);
        // Built into the architecture: two pylons from the floor, gold-inlaid, and a lit gantry that lights the board.
        for (const sx of [-1, 1]) { const x = d.x + sx * 4.75; b.box("darkMetal", 0.42, WALL_H + 1.9, 0.42, x, (WALL_H + 1.9) / 2, z0 + 0.45); b.box("gold", 0.05, WALL_H + 1.5, 0.05, x - sx * 0.22, (WALL_H + 1.5) / 2 + 0.2, z0 + 0.67); }
        b.box("darkMetal", 9.9, 0.18, 0.42, d.x, WALL_H + 1.9, z0 + 0.6); b.box("glow:#fde7c4", 8.6, 0.03, 0.08, d.x, WALL_H + 1.8, z0 + 0.82);
        screens.push({ id: `${d.id}:banner`, dep: d.id, kind: "banner", w: 8.7, h: 1.6, x: d.x, y: WALL_H + 0.91, z: z0 + 0.36, ry: 0, rx: -0.72 });
        for (const sx of [-1, 1] as const) {
          const wx = sx < 0 ? x0 : x1, ry = sx < 0 ? Math.PI / 2 : -Math.PI / 2;
          for (const dz of [-0.85, 0.85]) desk(wx - sx * 0.85, d.z + 0.7 + dz, ry, 2);
          if (sx < 0) sideScreen(`${d.id}:ledger`, "board", -1, 3.2, 1.3, d.z + 0.7, 2.25, "treasury:ledger");
          else sideScreen(`${d.id}:status`, "status", 1, 3.2, 1.3, d.z + 0.7, 2.25);
          b.box("gold", 0.03, 0.03, 3.4, wx - sx * 0.2, 1.5, d.z + 0.7);
          console(wx - sx * 1.4, z0 + 3.0, ry, 1.0);
          // Access gate posts at the opening (controlled access).
          b.box("darkMetal", 0.16, 1.1, 0.5, d.x + sx * 1.75, 0.55, z1 - 0.45); b.box("gold", 0.17, 0.03, 0.5, d.x + sx * 1.75, 1.08, z1 - 0.45); b.box("glass", 0.02, 0.6, 0.45, d.x + sx * 1.45, 0.8, z1 - 0.45);
        }
        const hz = d.z + 1.4;
        b.ring("gold", 1.6, 0.05, d.x, 0.13, hz, 64); b.ring(glow, 1.15, 0.025, d.x, 0.13, hz, 64);
        // The capital intake (route.ts INTAKE): where sweeps and settlements physically arrive — a gold-rimmed, armoured
        // receiver on the seal, under the hub displays that respond to it.
        b.cyl("darkMetal", 0.62, 0.7, 0.12, d.x, 0.12, hz, 40); b.cyl("gold", 0.55, 0.58, 0.035, d.x, 0.24, hz, 40);
        b.cyl("darkMetal", 0.4, 0.44, 0.03, d.x, 0.27, hz, 32); b.sphere("glass", 0.3, d.x, 0.27, hz, 24, 0.12);
        for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; b.box("gold", 0.05, 0.03, 0.16, d.x + Math.cos(a) * 0.66, 0.2, hz + Math.sin(a) * 0.66, -a); }
        b.box("darkMetal", 2.3, 0.95, 2.3, d.x, 2.5, hz);
        for (const e of [-1.16, 1.16]) { b.box("gold", 2.34, 0.035, 0.035, d.x, 2.02, hz + e); b.box("gold", 0.035, 0.035, 2.34, d.x + e, 2.02, hz); }
        for (const sx of [-0.9, 0.9]) b.box("darkMetal", 0.04, 0.65, 0.04, d.x + sx, 3.3, hz);
        for (let f = 0; f < 4; f++) {
          const ry = (f * Math.PI) / 2;
          screens.push({ id: `${d.id}:hub${f}`, dep: d.id, kind: "status", w: 2.1, h: 0.85, x: d.x + Math.sin(ry) * 1.165, y: 2.5, z: hz + Math.cos(ry) * 1.165, ry });
        }
        // V2.3 density: settlement consoles facing the vault, transaction receivers ringing the capital intake, vault
        // security (guard posts and a sensor line), ledger strips on the pylons, secure cabinets by the gates, a polished
        // trading floor under the hub, a coffered ceiling and dark wainscot with a gold capping (gold stays an accent).
        for (const sx of [-1, 1] as const) {
          console(d.x + sx * 2.6, z0 + 3.1, 0, 1.4);
          b.box("darkMetal", 0.16, 1.2, 0.16, d.x + sx * 1.9, 0.72, z0 + 0.95); b.box(glow, 0.17, 0.04, 0.17, d.x + sx * 1.9, 1.3, z0 + 0.95);
          b.box("screenGlass", 0.2, 2.6, 0.012, d.x + sx * 4.75 + sx * 0.06, 1.75, z0 + 0.672); b.box("acrylic", 0.14, 2.4, 0.006, d.x + sx * 4.75 + sx * 0.06, 1.75, z0 + 0.68);
          cabinet(sx < 0 ? x0 + 0.65 : x1 - 0.65, z1 - 1.3, 0.75, 0.55, 1.1, 0);
          const wx = sx < 0 ? x0 + T / 2 + 0.02 : x1 - T / 2 - 0.02;
          b.box("equipment", 0.03, 1.0, d.d - 0.8, wx, 0.62, d.z); b.box("gold", 0.04, 0.025, d.d - 0.8, wx - sx * 0.01, 1.13, d.z);
        }
        b.box(glow, 3.8, 0.015, 0.015, d.x, 0.62, z0 + 0.95);
        for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          const x = d.x + dx * 1.38, z = hz + dz * 1.38;
          b.cyl("equipment", 0.09, 0.11, 0.9, x, 0.12, z, 12); b.cyl(glow, 0.1, 0.1, 0.04, x, 1.02, z, 12); b.box("screenGlass", 0.12, 0.16, 0.01, x - dx * 0.08, 0.86, z - dz * 0.08, Math.atan2(-dx, -dz));
        }
        b.box("polished", 6.2, 0.006, 4.4, d.x, 0.124, hz);
        for (const zz of [-2.2, 2.2]) b.box("darkMetal", 6.2, 0.01, 0.06, d.x, 0.127, hz + zz);
        for (const i of [-2, 2]) beam(d.x + i * 2.6, z0 + 1.2, d.x + i * 2.6, z1 - 0.6, 0.1); // (overhead structure hugs the walls: the cutaway stays open)
        break;
      }
      case "opportunity": {
        // Research and analysis: the market/opportunity board, an evidence wall, the analysis table, research terminals.
        wallScreen(`${d.id}:board`, "board", 5.2, 2.1, d.x + 1.2, 2.0, "opportunity:board");
        status(2.6, 1.4, d.x - 4.4, 2.2);
        for (let i = 0; i < 3; i++) { b.box("darkMetal", 0.9, 1.0, 0.5, d.x - 5.5 + i * 1.0, 0.5, back + 0.35); b.box("screen", 0.7, 0.4, 0.01, d.x - 5.5 + i * 1.0, 1.15, back + 0.5, 0, -0.3); }
        table(d.x, d.z + 1.4, 1.15, 4, "stand", "screen");
        // Secondary analysis desks behind a glass partition, storage, and a signals cabinet.
        for (const sx of [-1, 1] as const) { desk(d.x + sx * 4.2, z0 + 2.4, 0, 2); b.box("glass", 2.6, 1.2, 0.03, d.x + sx * 4.2, 1.35, z0 + 3.35); b.box("darkMetal", 2.6, 0.05, 0.05, d.x + sx * 4.2, 1.95, z0 + 3.35); }
        for (let i = 0; i < 4; i++) { b.box("metal", 0.5, 0.9, 0.45, x1 - 0.45, 0.45, d.z + 4.0 - i * 0.55 - 0.2); b.box(acc, 0.02, 0.04, 0.2, x1 - 0.7, 0.75, d.z + 4.0 - i * 0.55 - 0.2); }
        b.box("darkMetal", 0.6, 1.8, 0.5, x0 + 0.45, 0.9, d.z + 3.6); occ(x0 + 0.45, d.z + 3.6, 0.6, 0.5, 1.8); for (let r = 0; r < 6; r++) b.box(glow, 0.3, 0.02, 0.01, x0 + 0.71, 0.4 + r * 0.24, d.z + 3.6);
        // The survey display above the table: rings and signal columns (a display surface, not data).
        for (const [r, y] of [[0.9, 0.95], [0.6, 1.15], [0.32, 1.35]] as const) b.ring(glow, r, 0.012, d.x, y, d.z + 1.4, 48);
        for (let i = 0; i < 9; i++) { const a = (i / 9) * Math.PI * 2, h = 0.12 + ((i * 7) % 5) * 0.07; b.box(glow, 0.04, h, 0.04, d.x + Math.cos(a) * 0.55, 0.8 + h / 2, d.z + 1.4 + Math.sin(a) * 0.55); }
        // Freestanding evidence boards in the open floor.
        for (const sx of [-1, 1]) { const x = d.x + sx * 3.4, z = d.z - 0.6;
          b.box("darkMetal", 0.06, 1.9, 0.06, x - 0.8, 0.95, z); b.box("darkMetal", 0.06, 1.9, 0.06, x + 0.8, 0.95, z); b.box("glass", 1.6, 1.2, 0.02, x, 1.35, z);
          for (let i = 0; i < 6; i++) b.box(i % 3 ? "paper" : acc, 0.32, 0.22, 0.01, x - 0.55 + (i % 3) * 0.55, 1.15 + Math.floor(i / 3) * 0.42, z + 0.02); }
        for (const sx of [-1, 1] as const) { const wx = sx < 0 ? x0 : x1; desk(wx - sx * 0.85, d.z + 2.6, sx < 0 ? Math.PI / 2 : -Math.PI / 2, 2); pinboard(sx, d.z - 0.4, 3.0); }
        // V2.3 density: ranking/market display totems, a projection frame over the strategy table (the shared analysis
        // surface), comparison benches along the window, a lattice floor and diagonal ceiling bracing (the lab's grid).
        for (const sx of [-1, 1] as const) {
          const x = d.x + sx * 5.2, z = d.z + 0.4;
          b.box("equipment", 0.5, 1.9, 0.3, x, 1.07, z); occ(x, z, 0.5, 0.3, 2.0);
          for (const f of [-1, 1]) { b.box("screenGlass", 0.44, 1.3, 0.01, x, 1.3, z + f * 0.156); for (let i = 0; i < 5; i++) b.box(i === 0 ? acc : "acrylic", 0.3 - i * 0.04, 0.05, 0.004, x - 0.05 + i * 0.02, 1.75 - i * 0.2, z + f * 0.163); }
          const bx = d.x + sx * 4.6, bz = z1 - 0.95;
          b.box("desk", 2.2, 0.05, 0.6, bx, 0.98, bz); for (const lx of [-1, 1]) b.box("darkMetal", 0.05, 0.9, 0.5, bx + lx * 1.0, 0.55, bz);
          for (let i = 0; i < 3; i++) { b.box("darkMetal", 0.56, 0.36, 0.03, bx - 0.68 + i * 0.68, 1.25, bz - 0.12, 0, -0.35); b.box("screen", 0.5, 0.3, 0.01, bx - 0.68 + i * 0.68, 1.25, bz - 0.1, 0, -0.35); }
        }
        for (let f = 0; f < 3; f++) { const a = (f / 3) * Math.PI * 2; hanging(d.x + Math.sin(a) * 0.95, d.z + 1.4 + Math.cos(a) * 0.95, 1.2, 0.5, 2.75, a); }
        for (const r of [2.4, 3.4]) for (let k = 0; k < 4; k++) {
          const a = (k / 4) * Math.PI * 2, b2 = ((k + 1) / 4) * Math.PI * 2;
          inlay(acc, d.x + Math.cos(a) * r, d.z + 1.4 + Math.sin(a) * r, d.x + Math.cos(b2) * r, d.z + 1.4 + Math.sin(b2) * r, 0.025);
        }
        for (const [cx, cz2, sx2, sz] of [[x0, z0, 1, 1], [x1, z0, -1, 1], [x0, z1, 1, -1], [x1, z1, -1, -1]]) beam(cx + sx2 * 0.4, cz2 + sz * 0.4, cx + sx2 * 2.0, cz2 + sz * 2.0, 0.08); // corner bracing
        break;
      }
      case "floor": {
        // Workstations are per agent (stations, scene). The room keeps the operations status wall, the workstation
        // board, lockers, a supervisor console and aisle markings.
        status(5.0, 1.8, d.x - 2.8, 2.25);
        wallScreen(`${d.id}:board`, "board", 3.4, 1.8, d.x + 2.0, 2.25, "floor:board");
        occ(x0 + 0.6, z0 + 1.2 + 3.5 * 0.6, 0.55, 8 * 0.6, 2.0); for (let i = 0; i < 8; i++) { b.box("metal", 0.55, 2.0, 0.5, x0 + 0.6, 1.0, z0 + 1.2 + i * 0.6); b.box(acc, 0.04, 0.3, 0.02, x0 + 0.88, 1.6, z0 + 1.2 + i * 0.6); b.box("darkMetal", 0.02, 0.12, 0.03, x0 + 0.88, 1.1, z0 + 1.2 + i * 0.6); }
        console(x1 - 1.4, z0 + 1.4, 0, 2.0, false);
        // Storage along the right wall and an overhead operations bar.
        for (let i = 0; i < 6; i++) { b.box("metal", 0.5, 1.1, 0.45, x1 - 0.45, 0.55, z0 + 3.2 + i * 0.6); b.box("darkMetal", 0.02, 0.06, 0.25, x1 - 0.69, 0.9, z0 + 3.2 + i * 0.6); }
        b.box("darkMetal", d.w - 2, 0.12, 0.3, d.x, WALL_H - 0.25, z0 + 2.4); b.box(glow, d.w - 2.4, 0.02, 0.05, d.x, WALL_H - 0.32, z0 + 2.52);
        // Circulation (world.ts stationPoint): the central aisle between the two banks of workstations and the walkway
        // behind each row of chairs — rubber flooring with lit edges, the routes people actually walk.
        b.box("rubber", 1.3, 0.012, z1 - z0 - 2.6, d.x, 0.132, (z1 + z0 + 2.6) / 2);
        for (const sx of [-1, 1]) b.box("glow:#0e5f73", 0.04, 0.01, z1 - z0 - 2.6, d.x + sx * 0.67, 0.14, (z1 + z0 + 2.6) / 2);
        for (let r = 0; r < 5; r++) { const z = z0 + 3.2 + r * 2.4 + 0.92; b.box("rubber", d.w - 3.2, 0.01, 0.55, d.x, 0.13, z); }
        // V2.3 density: a task-status display over the aisle at every row, a stand-up huddle table at the back, the
        // supervisor's raised platform, linear light baffles over the banks and a team-area screen by the lockers.
        for (let r = 0; r < 5; r++) {
          const z = z0 + 3.2 + r * 2.4 - 0.55;
          hanging(d.x, z, 1.1, 0.32, 2.85, 0);
        }
        b.cyl("darkMetal", 0.06, 0.12, 0.98, d.x - 5.0, 0.12, z0 + 1.15, 12); b.cyl("desk", 0.55, 0.55, 0.05, d.x - 5.0, 1.1, z0 + 1.15, 24); b.ring(glow, 0.53, 0.01, d.x - 5.0, 1.16, z0 + 1.15, 32);
        b.box("floorDark", 2.8, 0.06, 1.7, x1 - 1.4, 0.15, z0 + 1.55); b.box(glow, 2.8, 0.015, 0.03, x1 - 1.4, 0.19, z0 + 2.4);
        b.box("equipment", 0.06, 0.9, 1.4, x0 + T / 2 + 0.03, 1.55, z0 + 7.2); b.box("screen", 0.01, 0.7, 1.2, x0 + T / 2 + 0.07, 1.55, z0 + 7.2);
        break;
      }
      case "marketing": {
        // Media wall around the campaign board, content-review desks, analytics on the side wall, a small studio set.
        for (let r = 0; r < 3; r++) for (let c = 0; c < 6; c++) {
          if (r >= 1 && c >= 2 && c <= 3) continue;
          b.box("darkMetal", 1.1, 0.66, 0.06, d.x - 2.9 + c * 1.16, 0.95 + r * 0.72, back + 0.05); b.box("screen", 1.0, 0.56, 0.01, d.x - 2.9 + c * 1.16, 0.95 + r * 0.72, back + 0.09);
        }
        wallScreen(`${d.id}:board`, "board", 2.2, 1.3, d.x, 1.6, "marketing:board");
        sideScreen(`${d.id}:status`, "status", 1, 2.6, 1.3, d.z - 1.2, 2.0);
        for (const sx of [-1, 1] as const) desk(d.x + sx * 2.2, d.z + 1.8, 0, 2);
        b.box("paper", 0.05, 2.4, 2.6, x0 + 0.35, 1.3, d.z + 2.2);
        b.cyl("darkMetal", 0.025, 0.025, 1.9, x0 + 2.0, 0.1, d.z + 3.0, 6); b.box("darkMetal", 0.45, 0.35, 0.35, x0 + 2.0, 2.05, d.z + 3.0); b.box("glow:#fdf2f8", 0.38, 0.28, 0.02, x0 + 1.84, 2.05, d.z + 3.0, Math.PI / 2);
        for (const a of [0, 2.1, 4.2]) b.cyl("darkMetal", 0.015, 0.015, 1.3, x0 + 2.4 + Math.cos(a) * 0.25, 0.1, d.z + 1.6 + Math.sin(a) * 0.25, 6);
        b.box("darkMetal", 0.3, 0.2, 0.42, x0 + 2.4, 1.45, d.z + 1.6, -Math.PI / 2);
        // V2.3 density: the creative review table (a team surface), editing stations on the right wall, a hanging
        // channel-monitoring cluster, the content queue on the left wall, a lighting grid with spots over the studio,
        // LED strips framing the media wall and the studio's stage circle.
        table(d.x + 0.6, d.z - 1.6, 0.85, 4, "stand", "screen");
        for (const z of [7.9, 9.7]) desk(x1 - 0.85, z, -Math.PI / 2, 2);
        for (let f = 0; f < 4; f++) { const a = (f / 4) * Math.PI * 2 + Math.PI / 4; hanging(d.x + 0.6 + Math.sin(a) * 0.5, d.z - 1.6 + Math.cos(a) * 0.5, 0.62, 0.36, 2.9, a); }
        for (let i = 0; i < 6; i++) { b.box(i < 2 ? glow : "acrylic", 0.02, 0.16, 1.4, x0 + T / 2 + 0.03, 0.9 + i * 0.26, z0 + 1.9); b.box("darkMetal", 0.01, 0.02, 1.44, x0 + T / 2 + 0.02, 0.8 + i * 0.26, z0 + 1.9); }
        for (const sx of [-1, 1]) b.box(glow, 0.03, 2.3, 0.03, d.x + sx * 3.55, 1.6, back + 0.1);
        b.box(glow, 7.1, 0.03, 0.03, d.x, 2.75, back + 0.1);
        for (const [ax, az, bx2, bz] of [[x0 + 0.8, d.z + 0.6, x0 + 4.2, d.z + 0.6], [x0 + 0.8, d.z + 3.8, x0 + 4.2, d.z + 3.8], [x0 + 0.8, d.z + 0.6, x0 + 0.8, d.z + 3.8], [x0 + 4.2, d.z + 0.6, x0 + 4.2, d.z + 3.8]]) beam(ax, az, bx2, bz, 0.08, WALL_H - 0.3);
        for (const [x, z] of [[x0 + 1.6, d.z + 0.6], [x0 + 3.4, d.z + 0.6], [x0 + 2.5, d.z + 3.8]]) { b.cyl("darkMetal", 0.1, 0.14, 0.26, x, WALL_H - 0.62, z, 12); b.cyl("glow:#fdf2f8", 0.09, 0.09, 0.02, x, WALL_H - 0.64, z, 12); }
        b.ring(acc, 1.4, 0.02, x0 + 2.4, 0.13, d.z + 2.2, 64);
        break;
      }
      case "library": {
        // Digital archive stacks, the knowledge board, a knowledge-graph wall, research terminals and a reading table.
        shelf(d.x - 4.7, 3.2); shelf(d.x + 4.7, 3.2);
        // The digital archive: data columns with lit index rings either side of the knowledge board.
        for (const sx of [-1, 1]) { const x = d.x + sx * 2.55; b.cyl("darkMetal", 0.32, 0.36, 2.9, x, 0.12, back + 0.55, 24); for (let r = 0; r < 6; r++) b.ring(glow, 0.335, 0.012, x, 0.5 + r * 0.42, back + 0.55, 32); b.cyl("glass", 0.2, 0.2, 2.6, x, 0.25, back + 0.55, 16); }
        wallScreen(`${d.id}:board`, "board", 3.4, 1.6, d.x, 2.1, "library:board");
        status(2.4, 0.8, d.x, 0.75);
        const gx = x1 - T / 2 - 0.05, nodes = [[0, 2.6], [0.9, 2.1], [-0.8, 1.9], [0.4, 1.4], [-1.2, 2.8], [1.4, 2.9], [-0.3, 1.0]];
        b.box("darkMetal", 0.04, 2.4, 3.6, gx + 0.02, 1.95, d.z - 1.2);
        for (const [zz, yy] of nodes) b.sphere(glow, 0.07, gx - 0.04, yy, d.z - 1.2 + zz, 10);
        for (let i = 1; i < nodes.length; i++) { const [za, ya] = nodes[i - 1], [zb, yb] = nodes[i], l = Math.hypot(zb - za, yb - ya); b.box("glow:#1e3a8a", 0.01, 0.015, l, gx - 0.04, (ya + yb) / 2, d.z - 1.2 + (za + zb) / 2, 0, -Math.atan2(yb - ya, zb - za)); }
        for (const sx of [-1, 1] as const) { const wx = sx < 0 ? x0 : x1; desk(wx - sx * 0.85, d.z + 2.6, sx < 0 ? Math.PI / 2 : -Math.PI / 2, 1); }
        // Study carrels with privacy partitions, side shelving and a catalogue kiosk.
        for (const sx of [-1, 1] as const) {
          desk(d.x + sx * 4.6, z0 + 3.2, 0, 1); b.box("fabric", 0.05, 1.1, 0.9, d.x + sx * 4.6 + 0.72, 1.1, z0 + 2.9); b.box("fabric", 0.05, 1.1, 0.9, d.x + sx * 4.6 - 0.72, 1.1, z0 + 2.9); occ(d.x + sx * 4.6 + 0.72, z0 + 2.9, 0.05, 0.9, 1.65); occ(d.x + sx * 4.6 - 0.72, z0 + 2.9, 0.05, 0.9, 1.65);
          const wx = sx < 0 ? x0 + 0.35 : x1 - 0.35;
          b.box("darkMetal", 0.45, 2.2, 2.2, wx, 1.1, d.z + 0.2); occ(wx, d.z + 0.2, 0.45, 2.2, 2.2); for (let r = 0; r < 4; r++) { b.box("metal", 0.42, 0.03, 2.1, wx, 0.4 + r * 0.5, d.z + 0.2); for (let i = 0; i < 12; i++) b.box(i % 4 ? "paper" : acc, 0.3, 0.26 + (i % 3) * 0.04, 0.12, wx, 0.55 + r * 0.5, d.z - 0.75 + i * 0.16); }
        }
        b.box("darkMetal", 0.5, 1.2, 0.4, d.x + 2.4, 0.6, d.z + 3.3); b.box("screen", 0.4, 0.3, 0.01, d.x + 2.4, 1.05, d.z + 3.51, 0, -0.3);
        b.box("desk", 2.6, 0.05, 1.1, d.x, 0.76, d.z + 1.6); for (const sx of [-1, 1]) b.box("darkMetal", 0.06, 0.72, 0.9, d.x + sx * 1.2, 0.37, d.z + 1.6);
        for (const sx of [-0.7, 0.7]) { b.cyl("darkMetal", 0.012, 0.012, 0.35, d.x + sx, 0.79, d.z + 1.6, 6); b.box("glow:#fde7c4", 0.18, 0.02, 0.08, d.x + sx, 1.15, d.z + 1.6); }
        for (const [sx, sz] of [[-0.7, -1], [0.7, -1], [-0.7, 1], [0.7, 1]] as const) { const px = d.x + sx, pz = d.z + 1.6 + sz * 0.95, yaw = sz < 0 ? 0 : Math.PI; chair(px, pz, yaw); S.push({ x: px, z: pz, yaw, pose: "seat", table: true }); }
        // V2.3 density: a second reading table, an evidence light table, a mirrored retrieval kiosk, acoustic panels on
        // the side walls, a carpeted reading zone, and slatted ceiling baffles over it (the library's quiet ceiling).
        table(d.x - 3.4, d.z - 0.1, 0.6, 2, "seat");
        b.box("equipment", 1.5, 0.78, 0.8, d.x + 3.6, 0.51, d.z - 0.1); b.box("acrylic", 1.6, 0.04, 0.9, d.x + 3.6, 0.92, d.z - 0.1); b.box("darkMetal", 1.64, 0.02, 0.94, d.x + 3.6, 0.9, d.z - 0.1);
        for (let i = 0; i < 4; i++) b.box("paper", 0.22, 0.004, 0.3, d.x + 3.1 + i * 0.32, 0.945, d.z - 0.15 + (i % 2) * 0.12, (i - 1.5) * 0.12);
        b.box("darkMetal", 0.5, 1.2, 0.4, d.x - 2.4, 0.6, d.z + 3.3); b.box("screen", 0.4, 0.3, 0.01, d.x - 2.4, 1.05, d.z + 3.51, 0, -0.3);
        for (const sx of [-1, 1] as const) { const wx = sx < 0 ? x0 + T / 2 + 0.03 : x1 - T / 2 - 0.03; for (let i = 0; i < 3; i++) b.box("fabric", 0.05, 1.0, 0.9, wx, 2.5, z1 - 3.2 + i * 1.0); }
        b.box("fabric", 6.4, 0.008, 3.2, d.x - 1.4, 0.126, d.z + 1.2);
        for (let i = 0; i < 5; i++) b.box("painted", d.w - 1.2, 0.18, 0.05, d.x, WALL_H - 0.18, z0 + 0.7 + i * 0.35); // slatted baffles over the stacks
        break;
      }
      case "venture": {
        // Development: server racks, the ventures/projects board, a build display, a whiteboard, dev pods and a team bay.
        for (let i = 0; i < 4; i++) rack(d.x - 5.6 + i * 0.8, z0 + 0.8, "glow:#34d399");
        wallScreen(`${d.id}:board`, "board", 3.6, 1.8, d.x + 0.6, 2.05, "venture:board");
        status(2.2, 1.2, d.x + 4.6, 2.35);
        b.box("paper", 2.0, 1.0, 0.04, d.x + 4.6, 1.05, back + 0.06); for (let i = 0; i < 5; i++) b.box(i % 2 ? acc : "darkMetal", 0.35, 0.05, 0.01, d.x + 3.9 + (i % 3) * 0.6, 0.85 + Math.floor(i / 2) * 0.25, back + 0.09);
        for (const sx of [-1, 1] as const) { const wx = sx < 0 ? x0 : x1; desk(wx - sx * 0.85, d.z + 0.6, sx < 0 ? Math.PI / 2 : -Math.PI / 2, 2); desk(wx - sx * 0.85, d.z + 2.6, sx < 0 ? Math.PI / 2 : -Math.PI / 2, 2); }
        table(d.x, d.z + 1.7, 1.0, 4, "seat");
        b.ring(acc, 2.25, 0.02, d.x, 0.13, d.z + 1.7, 72); b.ring(acc, 2.32, 0.008, d.x, 0.13, d.z + 1.7, 72); // the project pod
        // Prototype bench with tools and a build-status cabinet.
        b.box("desk", 2.4, 0.06, 0.7, d.x - 3.2, 0.92, z0 + 2.6); for (const sx of [-1.1, 1.1]) b.box("darkMetal", 0.06, 0.9, 0.6, d.x - 3.2 + sx, 0.45, z0 + 2.6);
        for (let i = 0; i < 5; i++) b.box(i % 2 ? "metal" : acc, 0.18, 0.08 + (i % 3) * 0.05, 0.12, d.x - 4.1 + i * 0.42, 1.0, z0 + 2.5);
        b.box("darkMetal", 0.6, 2.0, 0.6, d.x - 2.0, 1.0, z0 + 0.7); occ(d.x - 2.0, z0 + 0.7, 0.6, 0.6, 2.0); for (let r = 0; r < 8; r++) b.box(r % 3 ? "glow:#34d399" : "glow:#fbbf24", 0.08, 0.04, 0.01, d.x - 2.15 + (r % 2) * 0.3, 0.4 + r * 0.2, z0 + 1.01);
        sideScreen(`${d.id}:projects`, "board", -1, 2.6, 1.2, d.z - 1.9, 2.25, "venture:projects");
        // V2.3 density: test consoles, a fifth rack, an engineering board, a hanging build display over the team table,
        // build-bay floor markings around the prototype bench and open cable ladders overhead (the lab's exposed services).
        console(d.x + 2.4, z0 + 3.0, 0, 1.2); console(d.x + 4.0, z0 + 3.0, 0, 1.2);
        rack(x1 - 0.8, z0 + 0.8, "glow:#34d399");
        pinboard(1, z1 - 1.9, 2.6);
        hanging(d.x, d.z + 1.7, 1.6, 0.6, 2.8, 0);
        for (const [ax, az, bx2, bz] of [[d.x - 4.6, z0 + 1.9, d.x - 1.8, z0 + 1.9], [d.x - 4.6, z0 + 3.3, d.x - 1.8, z0 + 3.3], [d.x - 4.6, z0 + 1.9, d.x - 4.6, z0 + 3.3], [d.x - 1.8, z0 + 1.9, d.x - 1.8, z0 + 3.3]]) inlay(acc, ax, az, bx2, bz, 0.05);
        for (const sx of [-1, 1]) { const lx = d.x + sx * (d.w / 2 - 1.0);
          b.box("painted", 0.04, 0.06, d.d - 1.2, lx - 0.2, WALL_H - 0.2, d.z); b.box("painted", 0.04, 0.06, d.d - 1.2, lx + 0.2, WALL_H - 0.2, d.z);
          for (let z = z0 + 1; z < z1 - 0.8; z += 0.6) b.box("painted", 0.4, 0.03, 0.03, lx, WALL_H - 0.2, z);
          b.cyl("cable", 0.05, 0.05, d.d - 1.4, lx, WALL_H - 0.14, d.z - (d.d - 1.4) / 2, 8, Math.PI / 2); }
        break;
      }
      case "identity": {
        // Secure verification booths (an operator inside each), identity and status boards (no values shown),
        // verification consoles.
        for (let i = 0; i < 3; i++) {
          const x = d.x - 3.6 + i * 3.6, z = z0 + 1.6;
          b.box("wallTrim", 0.1, 2.6, 1.8, x - 0.95, 1.3, z); b.box("wallTrim", 0.1, 2.6, 1.8, x + 0.95, 1.3, z); b.box("wallTrim", 2.0, 0.14, 1.8, x, 2.6, z); occ(x - 0.95, z, 0.1, 1.8, 2.6); occ(x + 0.95, z, 0.1, 1.8, 2.6);
          b.box(glow, 1.9, 0.03, 0.03, x, 2.52, z + 0.9); b.box("glass", 0.02, 2.2, 1.7, x - 0.9, 1.2, z);
          b.box("darkMetal", 0.6, 1.1, 0.3, x, 0.55, z - 0.5); b.box("screen", 0.5, 0.32, 0.01, x, 1.0, z - 0.34, 0, -0.25);
          b.ring(glow, 0.12, 0.02, x + 0.2, 0.9, z - 0.34, 24, 0);
          S.push({ x, z: z + 0.35, yaw: Math.PI, pose: "stand" });
        }
        wallScreen(`${d.id}:board`, "board", 2.6, 0.8, d.x - 3.0, 3.0, "identity:board");
        wallScreen(`${d.id}:status`, "status", 2.6, 0.8, d.x + 3.0, 3.0);
        for (const sx of [-1, 1] as const) console(sx < 0 ? x0 + 0.7 : x1 - 0.7, d.z + 2.2, sx < 0 ? Math.PI / 2 : -Math.PI / 2, 1.2);
        // V2.3 density: credential vault drawers on both side walls, two verification terminal islands, queue markings
        // before every booth, access readers, and hexagonal floor and ceiling cells (the identity room's signature).
        for (const sx of [-1, 1] as const) {
          const wx = sx < 0 ? x0 + 0.42 : x1 - 0.42;
          b.box("equipment", 0.5, 1.6, 1.8, wx, 0.92, z0 + 2.6); occ(wx, z0 + 2.6, 0.5, 1.8, 1.72);
          for (let r = 0; r < 5; r++) for (let c = 0; c < 4; c++) { b.box("metal", 0.01, 0.26, 0.4, wx - sx * 0.255, 0.35 + r * 0.3, z0 + 1.95 + c * 0.44); b.box(c % 3 ? "darkMetal" : glow, 0.01, 0.03, 0.08, wx - sx * 0.26, 0.4 + r * 0.3, z0 + 1.95 + c * 0.44); }
          console(d.x + sx * 2.6, d.z + 1.9, 0, 1.3);
        }
        for (let i = 0; i < 3; i++) {
          const x = d.x - 3.6 + i * 3.6;
          for (let k = 0; k < 3; k++) b.box(acc, 0.5, 0.008, 0.04, x, 0.128, z0 + 3.0 + k * 0.45);
          b.box("equipment", 0.1, 0.3, 0.08, x + 0.85, 1.25, z0 + 2.55); b.box(glow, 0.06, 0.06, 0.01, x + 0.85, 1.3, z0 + 2.6);
        }
        for (const [hx, hz] of [[d.x - 3.4, d.z + 0.4], [d.x, d.z - 0.6], [d.x + 3.4, d.z + 0.4]]) { b.ring(acc, 1.0, 0.016, hx, 0.13, hz, 6); b.ring("painted", 1.0, 0.05, hx, WALL_H - 0.1, hz, 6); b.ring(glow, 0.94, 0.012, hx, WALL_H - 0.16, hz, 6); }
        break;
      }
      case "estate": {
        // Structured archive: labelled locker sections, sealed crates on racks, the archive door, the estate board.
        for (let r = 0; r < 4; r++) for (let c = 0; c < 10; c++) {
          const x = d.x - 6.3 + c * 0.7; if (c >= 4 && c <= 5) continue;
          b.box("metal", 0.66, 0.62, 0.5, x, 0.35 + r * 0.66, back + 0.27); b.box("darkMetal", 0.08, 0.04, 0.02, x + 0.2, 0.35 + r * 0.66, back + 0.53);
        }
        for (const sx of [-1, 1]) b.box(acc, 2.6, 0.06, 0.02, d.x + sx * 4.55, 2.95, back + 0.53);
        b.box("darkMetal", 1.3, 2.6, 0.2, d.x, 1.3, back + 0.12); b.box(acc, 0.05, 2.4, 0.02, d.x + 0.55, 1.3, back + 0.23);
        wallScreen(`${d.id}:board`, "board", 2.4, 0.9, d.x, 3.05, "estate:board");
        sideScreen(`${d.id}:status`, "status", 1, 2.0, 0.7, d.z - 1.5, 2.6);
        for (const sx of [x0 + 0.9, x1 - 0.9]) {
          b.box("darkMetal", 1.0, 0.05, 4.2, sx, 1.15, d.z + 1.2); occ(sx, d.z + 1.2, 1.0, 4.2, 2.3); for (const zz of [-1.6, 1.6]) b.box("darkMetal", 1.0, 2.3, 0.06, sx, 1.15, d.z + 1.2 + zz);
          for (let i = 0; i < 3; i++) { b.box("paper", 0.9, 0.55, 0.9, sx, 0.3, d.z - 0.1 + i * 1.3); b.box("paper", 0.75, 0.5, 0.75, sx, 1.45, d.z - 0.1 + i * 1.3); b.box(acc, 0.02, 0.08, 0.3, sx + (sx < d.x ? 0.46 : -0.46), 0.42, d.z - 0.1 + i * 1.3); }
        }
        console(d.x + 2.4, z1 - 2.2, 0, 1.2); console(d.x - 2.4, z1 - 2.2, 0, 1.2);
        // V2.3 density: an inventory scanning station, a roller table carrying sealed crates, palletised crates, steel
        // deck plates and an overhead gantry with a hoist (the archive's heavy, quiet structure).
        console(d.x - 2.8, d.z - 1.6, 0, 1.2);
        b.box("darkMetal", 2.4, 0.7, 0.7, d.x + 2.6, 0.47, d.z - 1.6); for (let i = 0; i < 9; i++) b.cyl("metal", 0.035, 0.035, 0.64, d.x + 1.5 + i * 0.27, 0.86, d.z - 1.92, 10, Math.PI / 2);
        for (const ox of [-0.6, 0.55]) { b.box("paper", 0.6, 0.45, 0.55, d.x + 2.6 + ox, 1.13, d.z - 1.6); b.box(acc, 0.3, 0.06, 0.005, d.x + 2.6 + ox, 1.2, d.z - 1.32); }
        for (const sx of [-1, 1]) { const x = d.x + sx * 4.8, z = d.z + 1.6;
          b.box("painted", 1.2, 0.14, 1.0, x, 0.19, z); for (let k = 0; k < 2; k++) for (let j = 0; j < 2; j++) b.box("paper", 0.52, 0.5, 0.45, x - 0.28 + k * 0.56, 0.52, z - 0.24 + j * 0.48);
          b.box("paper", 0.5, 0.45, 0.42, x, 1.0, z); b.box("cable", 1.22, 0.02, 0.02, x, 0.79, z + 0.5); }
        for (let i = -3; i <= 3; i++) for (let j = 0; j < 3; j++) b.box("metal", 1.1, 0.006, 1.1, d.x + i * 1.2, 0.125, d.z - 2.0 + j * 1.2);
        beam(x0 + 0.4, z0 + 1.1, x1 - 0.4, z0 + 1.1, 0.22, WALL_H - 0.1);
        b.box("equipment", 0.5, 0.36, 0.5, d.x - 3.0, WALL_H - 0.36, z0 + 1.1); b.cyl("cable", 0.01, 0.01, 1.0, d.x - 3.0, WALL_H - 1.54, z0 + 1.1, 6); b.box("metal", 0.12, 0.08, 0.12, d.x - 3.0, WALL_H - 1.6, z0 + 1.1);
        break;
      }
      case "comms": {
        // Communications wall (switchboards and the channel board), transmission equipment, switching stations, a
        // gateway desk towards the outside.
        b.cyl("darkMetal", 0.08, 0.12, 2.4, x1 - 1.4, 0, z0 + 1.3, 12); b.sphere("metal", 0.9, x1 - 1.4, 2.6, z0 + 1.3, 24, 0.35); b.cyl("glow:#2dd4bf", 0.03, 0.03, 0.6, x1 - 1.4, 2.6, z0 + 1.3, 8);
        for (let i = 0; i < 5; i++) b.cyl("darkMetal", 0.015, 0.015, 1.2 + (i % 2) * 0.6, x1 - 2.6 + i * 0.12, WALL_H - 1.9, z0 + 0.6, 6);
        for (let i = 0; i < 3; i++) { const x = d.x - 5.0 + i * 1.3; b.box("darkMetal", 1.2, 2.0, 0.4, x, 1.0, back + 0.22); for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) b.box((r + c + i) % 4 === 0 ? glow : "metal", 0.1, 0.1, 0.02, x - 0.4 + c * 0.16, 0.6 + r * 0.22, back + 0.43); }
        wallScreen(`${d.id}:board`, "board", 2.8, 1.5, d.x + 0.6, 2.1, "comms:board");
        sideScreen(`${d.id}:status`, "status", -1, 2.4, 1.1, d.z + 1.4, 2.2);
        for (let i = 0; i < 3; i++) console(d.x - 4.4 + i * 1.6, z0 + 2.4, 0, 1.3);
        desk(x1 - 0.85, d.z + 2.4, -Math.PI / 2, 2);
        // V2.3 density: a signal-routing island (patch bay), short transmission racks by the front, a cable ladder up
        // to the antenna mast, an overhead fibre ring and wave inlays around the mast (comms' signature).
        console(d.x + 0.4, d.z + 1.6, 0, 2.0);
        for (let i = 0; i < 10; i++) b.cyl(i % 3 ? "cable" : glow, 0.012, 0.012, 0.5, d.x - 0.5 + i * 0.2, 0.98, d.z + 1.75, 6, 0.9);
        for (const dz of [2.4, 3.4]) rack(x0 + 0.8, z1 - 5.0 + dz, glow, 1.5);
        for (let i = 0; i < 8; i++) b.box("painted", 0.4, 0.03, 0.04, x1 - 1.4, 0.4 + i * 0.3, z0 + 1.75);
        b.ring("painted", 3.0, 0.05, d.x, WALL_H - 0.1, d.z, 64); b.ring(glow, 2.94, 0.012, d.x, WALL_H - 0.16, d.z, 64);
        for (const r of [1.4, 2.2, 3.0]) b.ring(acc, r, 0.012, x1 - 1.4, 0.13, z0 + 1.3, 64);
        break;
      }
      case "security": {
        // NOC/SOC: the infrastructure status wall and the alerts board, racks, alarm beacons (scene; red only for
        // real unacknowledged RED alerts), two tiers of operator desks.
        status(5.6, 1.9, d.x - 1.2, 2.2);
        wallScreen(`${d.id}:board`, "board", 2.6, 1.9, d.x + 3.4, 2.2, "security:board");
        for (const sx of [-1, 1]) { rack(d.x + sx * 6.5, z0 + 0.8, "glow:#f87171"); rack(d.x + sx * 7.3, z0 + 0.8, "glow:#f87171"); beacons.push({ x: d.x + sx * 5.2, y: 3.3, z: back + 0.2 }); }
        for (const sx of [-1, 0, 1]) desk(d.x + sx * 2.4, z0 + 3.0, 0, 3);
        b.box("darkMetal", 8.4, 0.15, 1.6, d.x, 0.075, z0 + 5.2);
        for (const sx of [-1, 1]) desk(d.x + sx * 1.6, z0 + 5.0, 0, 2);
        // V2.3 density: SOC consoles on both side walls (front and back), an infrastructure map table at the front with
        // places around it, perforated grille panels on the back wall, network-map plates on the side walls and dense
        // cable trays overhead (the NOC's working ceiling).
        for (const sx of [-1, 1] as const) {
          const wx = sx < 0 ? x0 + 0.8 : x1 - 0.8, ry = sx < 0 ? Math.PI / 2 : -Math.PI / 2;
          console(wx, z0 + 1.9, ry, 1.4); console(wx, z1 - 1.8, ry, 1.4);
          for (let i = 0; i < 2; i++) b.box("grille", 1.2, 0.9, 0.02, d.x + sx * (4.4 + i * 1.3), 0.75, back + 0.03);
          const mx = sx < 0 ? x0 + T / 2 + 0.03 : x1 - T / 2 - 0.03;
          b.box("equipment", 0.03, 1.0, 1.8, mx, 2.3, z1 - 1.8);
          for (const [a, bb] of [[[0, 0], [0.5, 0.3]], [[0.5, 0.3], [0.9, -0.2]], [[0, 0], [-0.6, 0.25]], [[-0.6, 0.25], [-0.7, -0.3]], [[0.5, 0.3], [0.2, 0.42]]] as const) {
            const l = Math.hypot(bb[0] - a[0], bb[1] - a[1]); b.box(glow, 0.01, 0.015, l, mx - sx * 0.02, 2.3 + (a[1] + bb[1]) / 2, z1 - 1.8 + (a[0] + bb[0]) / 2, -Math.atan2(bb[1] - a[1], bb[0] - a[0]) + 0, 0, 0);
          }
        }
        // (Off the entrance line and clear of the desk tiers: the front-left floor.)
        const mx0 = d.x - 4.2, mz = z1 - 1.6;
        b.box("equipment", 2.2, 0.82, 1.0, mx0, 0.53, mz); b.box("screen", 2.1, 0.03, 0.9, mx0, 0.96, mz); b.box(glow, 2.24, 0.015, 0.015, mx0, 0.95, mz - 0.51); b.box(glow, 2.24, 0.015, 0.015, mx0, 0.95, mz + 0.51);
        for (const sx of [-1, 1]) S.push({ x: mx0 + sx * 1.55, z: mz, yaw: sx < 0 ? Math.PI / 2 : -Math.PI / 2, pose: "stand", table: true });
        for (let i = 0; i < 2; i++) { b.box("painted", d.w - 1.4, 0.05, 0.36, d.x, WALL_H - 0.25, z0 + 0.6 + i * 0.5); b.box("cable", d.w - 1.6, 0.05, 0.24, d.x, WALL_H - 0.2, z0 + 0.6 + i * 0.5); }
        break;
      }
    }
  }

  /** Overhead gantries, fibre trays and light rails above the corridors and rooms (Ultra's finer architectural detail). */
  function gantries() {
    // (Spine gantries only: cross-corridor beams would cut across every department view.)
    for (const x of SPINE_X) { details.box("darkMetal", 0.3, 0.12, W.maxZ - W.minZ, x, WALL_H + 0.8, czW); details.cyl("rubber", 0.05, 0.05, W.maxZ - W.minZ, x + 0.25, WALL_H + 0.65, czW - (W.maxZ - W.minZ) / 2, 6, Math.PI / 2); details.box("glow:#0e7490", 0.05, 0.03, W.maxZ - W.minZ, x, WALL_H + 0.72, czW); }
    for (const d of DEPARTMENTS) {
      for (const sx of [-1, 1]) details.box("darkMetal", 0.1, 0.1, d.d - 1, d.x + sx * (d.w / 2 - 0.35), WALL_H + 0.15, d.z);
      for (const sx of [-1, 1]) { details.cyl("rubber", 0.04, 0.04, WALL_H - 0.6, d.x + sx * (d.w / 2 - 0.5), 0.1, d.z - d.d / 2 + 0.35, 6); details.cyl("rubber", 0.03, 0.03, WALL_H - 0.6, d.x + sx * (d.w / 2 - 0.62), 0.1, d.z - d.d / 2 + 0.35, 6); }
    }
  }
}

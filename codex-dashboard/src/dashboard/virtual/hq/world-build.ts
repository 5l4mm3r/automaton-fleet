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
import { CROSS_Z, SPINE_X } from "./route";

export type ScreenKind = "status" | "sign" | "board" | "banner";
export interface ScreenSpot { id: string; dep: DepartmentId; kind: ScreenKind; w: number; h: number; x: number; y: number; z: number; ry: number; rx?: number; board?: string }
/** A room's light: position, colour and mood (relative strength: quiet rooms are darker). */
export interface LightSpot { dep: DepartmentId; x: number; y: number; z: number; colour: string; mood: number }
export interface BeaconSpot { x: number; y: number; z: number }
/** Where an agent works in a room: position, the direction it faces (yaw, three.js about +Y) and its posture. */
export interface WorkSpot { x: number; z: number; yaw: number; pose: "seat" | "stand"; /** A place at a shared table (team projects meet here). */ table?: boolean }

export const WALL_H = 3.6;
const T = 0.3; // wall thickness

export interface WorldPlan {
  builder: GeoBuilder; details: GeoBuilder; screens: ScreenSpot[]; lights: LightSpot[]; beacons: BeaconSpot[];
  core: { x: number; y: number; z: number }; spots: Record<DepartmentId, WorkSpot[]>;
}

/** Yaw that faces from (x, z) towards (tx, tz). */
const facing = (x: number, z: number, tx: number, tz: number) => Math.atan2(tx - x, tz - z);

const MOOD: Record<DepartmentId, number> = { command: 1, treasury: 0.9, opportunity: 0.85, floor: 1, marketing: 0.95, library: 0.72, venture: 0.9, identity: 0.75, estate: 0.45, comms: 0.8, security: 0.7 };

export function buildWorld(): WorldPlan {
  const b = new GeoBuilder(), details = new GeoBuilder();
  const screens: ScreenSpot[] = [], lights: LightSpot[] = [], beacons: BeaconSpot[] = [];
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

  // Data conduits: recessed channels in the deck along every cross corridor and both spines, a lit core in each —
  // the infrastructure information packets travel along (route.ts). Ambient glow only; packets carry meaning.
  const conduitZ = [...CROSS_Z], conduitX = [...SPINE_X];
  for (const z of conduitZ) { b.box("floorDark", W.maxX - W.minX + 2, 0.03, 0.42, cxW, 0.03, z); b.box("glow:#0e4a5c", W.maxX - W.minX + 2, 0.02, 0.07, cxW, 0.05, z); }
  for (const x of conduitX) { b.box("floorDark", 0.42, 0.03, W.maxZ - W.minZ, x, 0.03, czW); b.box("glow:#0e4a5c", 0.07, 0.02, W.maxZ - W.minZ, x, 0.05, czW); }
  b.box("floorDark", W.maxX + 3 - 10, 0.03, 0.42, (W.maxX + 3 + 10) / 2, 0.03, -4); b.box("glow:#0e4a5c", W.maxX + 3 - 10, 0.02, 0.07, (W.maxX + 3 + 10) / 2, 0.05, -4);
  // Edge guide lights along the corridors.
  for (const z of conduitZ.slice(0, 5)) { b.box("glow:#123d4d", W.maxX - W.minX + 2, 0.02, 0.05, cxW, 0.04, z - 0.9); b.box("glow:#123d4d", W.maxX - W.minX + 2, 0.02, 0.05, cxW, 0.04, z + 0.9); }
  // Pillars beside the crossings, with junction boxes where conduits meet.
  for (const z of conduitZ.slice(0, 5)) for (const x of conduitX) {
    const px = x + (x < 0 ? -0.9 : 0.9);
    b.box("darkMetal", 0.7, WALL_H + 0.6, 0.7, px, (WALL_H + 0.6) / 2, z - 0.9);
    b.box("glow:#22d3ee", 0.72, 0.06, 0.72, px, 2.4, z - 0.9);
    b.box("wallTrim", 0.9, 0.2, 0.9, px, 0.1, z - 0.9);
    b.box("metal", 0.6, 0.08, 0.6, x, 0.06, z); b.box("glow:#164e63", 0.3, 0.02, 0.3, x, 0.11, z);
  }
  // The open concourses beside the Agent Floor: benches, planters and wayfinding totems.
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) { const z = -7 + i * 4.5; b.box("darkMetal", 2.6, 0.45, 0.7, sx * 18, 0.22, z); b.box("fabric", 2.4, 0.12, 0.6, sx * 18, 0.5, z); b.box("fabric", 2.4, 0.5, 0.1, sx * 18, 0.8, z + 0.3); }
    for (const z of [-9, 1]) { b.box("concrete", 1.2, 0.8, 1.2, sx * 22.5, 0.4, z); b.sphere("fabric", 0.55, sx * 22.5, 1.1, z, 10, 0.8); }
    b.box("darkMetal", 0.5, 2.4, 0.18, sx * 14.5, 1.2, -4); b.box("glow:#22d3ee", 0.4, 0.04, 0.2, sx * 14.5, 2.3, -4);
  }

  for (const d of DEPARTMENTS) { b.chunk = d.id; room(d); }
  b.chunk = "shell";
  gantries();
  return { builder: b, details, screens, lights, beacons, core: { x: 0, y: 0.5, z: -31.5 }, spots };

  /** A room: floor with an accent inset, walls with doorways, a cutaway front parapet, a sign, ceiling housings, cable trays. */
  function room(d: Department) {
    const x0 = d.x - d.w / 2, x1 = d.x + d.w / 2, z0 = d.z - d.d / 2, z1 = d.z + d.d / 2, acc: MatKey = `accent:${d.accent}`, glow: MatKey = `glow:${d.accent}`;
    b.box("floor", d.w, 0.12, d.d, d.x, 0.06, d.z);
    // Accent inset around the floor, and a darker equipment band along the back wall.
    b.box(acc, d.w - 0.6, 0.02, 0.05, d.x, 0.13, z0 + 0.5); b.box(acc, d.w - 0.6, 0.02, 0.05, d.x, 0.13, z1 - 0.5);
    b.box(acc, 0.05, 0.02, d.d - 1, x0 + 0.3, 0.13, d.z); b.box(acc, 0.05, 0.02, d.d - 1, x1 - 0.3, 0.13, d.z);
    b.box("floorDark", d.w - 0.8, 0.02, 1.6, d.x, 0.125, z0 + 1.3);
    // The room's data conduit: from the front opening to the equipment wall (packets enter and leave along it).
    b.box("floorDark", 0.36, 0.02, d.d - 1.2, d.x, 0.13, d.z + 0.3); b.box(glow, 0.05, 0.02, d.d - 1.2, d.x, 0.142, d.z + 0.3);
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
      b.box("darkMetal", 0.12, 1.65, 0.12, d.x + sx * (open / 2), 0.82, z1);
    }
    // Sign above the back wall's centre, ceiling light housings (pools of light below them), the room light.
    screens.push({ id: `${d.id}:sign`, dep: d.id, kind: "sign", w: Math.min(7, d.w - 4), h: 0.55, x: d.x, y: WALL_H - 0.6, z: z0 + T / 2 + 0.02, ry: 0 });
    lights.push({ dep: d.id, x: d.x, y: WALL_H - 0.3, z: d.z, colour: d.accent, mood: MOOD[d.id] });
    for (const i of [-1, 1]) for (const j of [0, 1]) {
      const lx = d.x + i * d.w / 4, lz = z0 + d.d * (j ? 0.66 : 0.3);
      b.box("darkMetal", 1.7, 0.08, 0.42, lx, WALL_H + 0.02, lz); b.box("glow:#cfe8f7", 1.5, 0.03, 0.26, lx, WALL_H - 0.03, lz);
    }
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
      const lamp = at(0.58, -0.22); b.cyl("darkMetal", 0.012, 0.012, 0.4, lamp.x, 0.79, lamp.z, 6); b.box("glow:#fde7c4", 0.16, 0.02, 0.06, lamp.x, 1.19, lamp.z, ry);
      const ped = at(-0.42, 0.02); b.box("darkMetal", 0.36, 0.52, 0.5, ped.x, 0.27, ped.z, ry);
      if (seat) { const s = at(0, 0.62), yaw = ry + Math.PI; chair(s.x, s.z, yaw); S.push({ x: s.x, z: s.z, yaw, pose: "seat" }); }
    };
    /** A standing console (sloped top with a screen) facing `ry`; the operator's place becomes a work spot. */
    const console = (x: number, z: number, ry: number, w = 1.6, spot = true) => {
      b.box("darkMetal", w, 0.9, 0.6, x, 0.45, z, ry);
      b.box("metal", w, 0.06, 0.66, x, 0.92, z, ry, -0.35);
      b.box("screen", w - 0.2, 0.42, 0.02, x + Math.sin(ry) * -0.05, 1.04, z + Math.cos(ry) * -0.05, ry, -0.35);
      b.box(glow, w - 0.1, 0.03, 0.03, x + Math.sin(ry) * 0.31, 0.88, z + Math.cos(ry) * 0.31, ry);
      if (spot) S.push({ x: x + Math.sin(ry) * 0.75, z: z + Math.cos(ry) * 0.75, yaw: ry + Math.PI, pose: "stand" });
    };
    const rack = (x: number, z: number, led: MatKey, h = 2.2) => {
      b.box("darkMetal", 0.7, h, 0.9, x, h / 2, z); b.box("metal", 0.66, h - 0.1, 0.02, x, h / 2, z + 0.45);
      for (let r = 0; r < Math.floor(h / 0.24); r++) { b.box(r % 3 ? "rubber" : led, 0.42, 0.03, 0.01, x - 0.05, 0.3 + r * 0.21, z + 0.465); b.box(led, 0.04, 0.03, 0.01, x + 0.24, 0.3 + r * 0.21, z + 0.465); }
    };
    const shelf = (x: number, w: number, h = 2.4) => {
      b.box("darkMetal", w, h, 0.45, x, h / 2, back + 0.25);
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
        b.box("darkMetal", 2.3, 0.95, 2.3, d.x, 2.5, hz);
        for (const e of [-1.16, 1.16]) { b.box("gold", 2.34, 0.035, 0.035, d.x, 2.02, hz + e); b.box("gold", 0.035, 0.035, 2.34, d.x + e, 2.02, hz); }
        for (const sx of [-0.9, 0.9]) b.box("darkMetal", 0.04, 0.65, 0.04, d.x + sx, 3.3, hz);
        for (let f = 0; f < 4; f++) {
          const ry = (f * Math.PI) / 2;
          screens.push({ id: `${d.id}:hub${f}`, dep: d.id, kind: "status", w: 2.1, h: 0.85, x: d.x + Math.sin(ry) * 1.165, y: 2.5, z: hz + Math.cos(ry) * 1.165, ry });
        }
        break;
      }
      case "opportunity": {
        // Research and analysis: the market/opportunity board, an evidence wall, the analysis table, research terminals.
        wallScreen(`${d.id}:board`, "board", 5.2, 2.1, d.x + 1.2, 2.0, "opportunity:board");
        status(2.6, 1.4, d.x - 4.4, 2.2);
        for (let i = 0; i < 3; i++) { b.box("darkMetal", 0.9, 1.0, 0.5, d.x - 5.5 + i * 1.0, 0.5, back + 0.35); b.box("screen", 0.7, 0.4, 0.01, d.x - 5.5 + i * 1.0, 1.15, back + 0.5, 0, -0.3); }
        table(d.x, d.z + 1.4, 1.15, 4, "stand", "screen");
        // The survey display above the table: rings and signal columns (a display surface, not data).
        for (const [r, y] of [[0.9, 0.95], [0.6, 1.15], [0.32, 1.35]] as const) b.ring(glow, r, 0.012, d.x, y, d.z + 1.4, 48);
        for (let i = 0; i < 9; i++) { const a = (i / 9) * Math.PI * 2, h = 0.12 + ((i * 7) % 5) * 0.07; b.box(glow, 0.04, h, 0.04, d.x + Math.cos(a) * 0.55, 0.8 + h / 2, d.z + 1.4 + Math.sin(a) * 0.55); }
        // Freestanding evidence boards in the open floor.
        for (const sx of [-1, 1]) { const x = d.x + sx * 3.4, z = d.z - 0.6;
          b.box("darkMetal", 0.06, 1.9, 0.06, x - 0.8, 0.95, z); b.box("darkMetal", 0.06, 1.9, 0.06, x + 0.8, 0.95, z); b.box("glass", 1.6, 1.2, 0.02, x, 1.35, z);
          for (let i = 0; i < 6; i++) b.box(i % 3 ? "paper" : acc, 0.32, 0.22, 0.01, x - 0.55 + (i % 3) * 0.55, 1.15 + Math.floor(i / 3) * 0.42, z + 0.02); }
        for (const sx of [-1, 1] as const) { const wx = sx < 0 ? x0 : x1; desk(wx - sx * 0.85, d.z + 2.6, sx < 0 ? Math.PI / 2 : -Math.PI / 2, 2); pinboard(sx, d.z - 0.4, 3.0); }
        break;
      }
      case "floor": {
        // Workstations are per agent (stations, scene). The room keeps the operations status wall, the workstation
        // board, lockers, a supervisor console and aisle markings.
        status(5.0, 1.8, d.x - 2.8, 2.25);
        wallScreen(`${d.id}:board`, "board", 3.4, 1.8, d.x + 2.0, 2.25, "floor:board");
        for (let i = 0; i < 8; i++) { b.box("metal", 0.55, 2.0, 0.5, x0 + 0.6, 1.0, z0 + 1.2 + i * 0.6); b.box(acc, 0.04, 0.3, 0.02, x0 + 0.88, 1.6, z0 + 1.2 + i * 0.6); b.box("darkMetal", 0.02, 0.12, 0.03, x0 + 0.88, 1.1, z0 + 1.2 + i * 0.6); }
        console(x1 - 1.4, z0 + 1.4, 0, 2.0, false);
        for (let z = z0 + 3.0; z < z1 - 1; z += 1.6) b.box("wallTrim", d.w - 3, 0.01, 0.03, d.x, 0.13, z - 0.8);
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
        b.box("desk", 2.6, 0.05, 1.1, d.x, 0.76, d.z + 1.6); for (const sx of [-1, 1]) b.box("darkMetal", 0.06, 0.72, 0.9, d.x + sx * 1.2, 0.37, d.z + 1.6);
        for (const sx of [-0.7, 0.7]) { b.cyl("darkMetal", 0.012, 0.012, 0.35, d.x + sx, 0.79, d.z + 1.6, 6); b.box("glow:#fde7c4", 0.18, 0.02, 0.08, d.x + sx, 1.15, d.z + 1.6); }
        for (const [sx, sz] of [[-0.7, -1], [0.7, -1], [-0.7, 1], [0.7, 1]] as const) { const px = d.x + sx, pz = d.z + 1.6 + sz * 0.95, yaw = sz < 0 ? 0 : Math.PI; chair(px, pz, yaw); S.push({ x: px, z: pz, yaw, pose: "seat", table: true }); }
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
        sideScreen(`${d.id}:projects`, "board", -1, 2.6, 1.2, d.z - 1.9, 2.25, "venture:projects");
        break;
      }
      case "identity": {
        // Secure verification booths (an operator inside each), identity and status boards (no values shown),
        // verification consoles.
        for (let i = 0; i < 3; i++) {
          const x = d.x - 3.6 + i * 3.6, z = z0 + 1.6;
          b.box("wallTrim", 0.1, 2.6, 1.8, x - 0.95, 1.3, z); b.box("wallTrim", 0.1, 2.6, 1.8, x + 0.95, 1.3, z); b.box("wallTrim", 2.0, 0.14, 1.8, x, 2.6, z);
          b.box(glow, 1.9, 0.03, 0.03, x, 2.52, z + 0.9); b.box("glass", 0.02, 2.2, 1.7, x - 0.9, 1.2, z);
          b.box("darkMetal", 0.6, 1.1, 0.3, x, 0.55, z - 0.5); b.box("screen", 0.5, 0.32, 0.01, x, 1.0, z - 0.34, 0, -0.25);
          b.ring(glow, 0.12, 0.02, x + 0.2, 0.9, z - 0.34, 24, 0);
          S.push({ x, z: z + 0.35, yaw: Math.PI, pose: "stand" });
        }
        wallScreen(`${d.id}:board`, "board", 2.6, 0.8, d.x - 3.0, 3.0, "identity:board");
        wallScreen(`${d.id}:status`, "status", 2.6, 0.8, d.x + 3.0, 3.0);
        for (const sx of [-1, 1] as const) console(sx < 0 ? x0 + 0.7 : x1 - 0.7, d.z + 2.2, sx < 0 ? Math.PI / 2 : -Math.PI / 2, 1.2);
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
          b.box("darkMetal", 1.0, 0.05, 4.2, sx, 1.15, d.z + 1.2); for (const zz of [-1.6, 1.6]) b.box("darkMetal", 1.0, 2.3, 0.06, sx, 1.15, d.z + 1.2 + zz);
          for (let i = 0; i < 3; i++) { b.box("paper", 0.9, 0.55, 0.9, sx, 0.3, d.z - 0.1 + i * 1.3); b.box("paper", 0.75, 0.5, 0.75, sx, 1.45, d.z - 0.1 + i * 1.3); b.box(acc, 0.02, 0.08, 0.3, sx + (sx < d.x ? 0.46 : -0.46), 0.42, d.z - 0.1 + i * 1.3); }
        }
        console(d.x + 2.4, z1 - 2.2, 0, 1.2); console(d.x - 2.4, z1 - 2.2, 0, 1.2);
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

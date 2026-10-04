/**
 * The headquarters' static world: the complex shell (ground, corridors with guide lights, pillars, perimeter), each
 * department as a real room (tiled floor, walls with lit door frames, a low glass-topped front parapet so the cutaway
 * stays readable) and its furnishings, built through GeoBuilder into a handful of merged meshes. Returns the placements of
 * the live elements the scene adds on top (data screens, signs, room lights, beacons, the command core).
 *
 * Furniture is architecture, not activity: nothing here moves or reports anything. What moves is people (FleetController
 * state) and information (recorded events); what the screens show is FleetController's data (screens.tsx).
 */
import { DEPARTMENTS, type Department, type DepartmentId } from "../../command/departments";
import { GeoBuilder, type MatKey } from "./builder";
import { WORLD } from "../world";

export type ScreenKind = "status" | "sign";
export interface ScreenSpot { id: string; dep: DepartmentId; kind: ScreenKind; w: number; h: number; x: number; y: number; z: number; ry: number }
export interface LightSpot { dep: DepartmentId; x: number; y: number; z: number; colour: string }
export interface BeaconSpot { x: number; y: number; z: number }

export const WALL_H = 3.6;
const T = 0.3; // wall thickness

export interface WorldPlan { builder: GeoBuilder; details: GeoBuilder; screens: ScreenSpot[]; lights: LightSpot[]; beacons: BeaconSpot[]; core: { x: number; y: number; z: number } }

export function buildWorld(): WorldPlan {
  const b = new GeoBuilder(), details = new GeoBuilder();
  const screens: ScreenSpot[] = [], lights: LightSpot[] = [], beacons: BeaconSpot[] = [];
  const W = WORLD, cxW = (W.minX + W.maxX) / 2, czW = (W.minZ + W.maxZ) / 2;

  // Ground and the complex's corridor deck.
  b.box("ground", 200, 0.1, 200, 0, -0.1, 0);
  b.box("corridor", W.maxX - W.minX + 6, 0.1, W.maxZ - W.minZ + 6, cxW, -0.02, czW);
  // Perimeter: a low wall with a glass band.
  const perim = (x: number, z: number, w: number, d: number) => { b.box("wallTrim", w, 1.1, d, x, 0.55, z); b.box("glass", Math.max(w, 0.05), 0.9, Math.max(d, 0.05), x, 1.55, z); };
  perim(cxW, W.minZ - 3, W.maxX - W.minX + 6, T); perim(cxW, W.maxZ + 3, W.maxX - W.minX + 6, T);
  perim(W.minX - 3, czW, T, W.maxZ - W.minZ + 6); perim(W.maxX + 3, czW, T, W.maxZ - W.minZ + 6);
  // East gate (where outside information enters).
  b.box("accent:#38bdf8", 0.2, 3.2, 3.6, W.maxX + 3, 1.6, -4); b.box("glow:#38bdf8", 0.08, 0.08, 3.4, W.maxX + 2.85, 3.0, -4);

  // Corridor guide lights along the spine and the cross corridors, and pillars at the crossings.
  const crossZ = [-23.5, -11.5, 4.5, 17.5, 30.75], spineX = [-10, 10];
  for (const z of crossZ) { b.box("glow:#164e63", W.maxX - W.minX + 2, 0.02, 0.08, cxW, 0.04, z - 0.9); b.box("glow:#164e63", W.maxX - W.minX + 2, 0.02, 0.08, cxW, 0.04, z + 0.9); }
  for (const x of spineX) { b.box("glow:#164e63", 0.08, 0.02, W.maxZ - W.minZ, x - 0.9, 0.04, czW); b.box("glow:#164e63", 0.08, 0.02, W.maxZ - W.minZ, x + 0.9, 0.04, czW); }
  for (const z of crossZ) for (const x of spineX) {
    b.box("darkMetal", 0.7, WALL_H + 0.6, 0.7, x, (WALL_H + 0.6) / 2, z);
    b.box("glow:#22d3ee", 0.72, 0.08, 0.72, x, 2.4, z);
    b.box("wallTrim", 0.9, 0.2, 0.9, x, 0.1, z);
  }
  // The open concourses beside the Agent Floor: benches and planters.
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) { const z = -7 + i * 4.5; b.box("darkMetal", 2.6, 0.45, 0.7, sx * 18, 0.22, z); b.box("fabric", 2.4, 0.12, 0.6, sx * 18, 0.5, z); }
    b.box("concrete", 1.2, 0.8, 1.2, sx * 22.5, 0.4, -9); b.box("concrete", 1.2, 0.8, 1.2, sx * 22.5, 0.4, 1);
  }

  for (const d of DEPARTMENTS) room(d);
  if (details) gantries();
  return { builder: b, details, screens, lights, beacons, core: { x: 0, y: 0.5, z: -32.3 } };

  /** A room: floor with an accent inset, walls with doorways, a cutaway front parapet, a sign, a status screen, lights. */
  function room(d: Department) {
    const x0 = d.x - d.w / 2, x1 = d.x + d.w / 2, z0 = d.z - d.d / 2, z1 = d.z + d.d / 2, acc: MatKey = `accent:${d.accent}`, glow: MatKey = `glow:${d.accent}`;
    b.box("floor", d.w, 0.12, d.d, d.x, 0.06, d.z);
    // Accent inset around the floor.
    b.box(acc, d.w - 0.6, 0.02, 0.06, d.x, 0.13, z0 + 0.5); b.box(acc, d.w - 0.6, 0.02, 0.06, d.x, 0.13, z1 - 0.5);
    b.box(acc, 0.06, 0.02, d.d - 1, x0 + 0.3, 0.13, d.z); b.box(acc, 0.06, 0.02, d.d - 1, x1 - 0.3, 0.13, d.z);
    // Back wall (full height) with a trim, a lit cornice and skirting.
    b.box("wall", d.w + T, WALL_H, T, d.x, WALL_H / 2, z0);
    b.box("wallTrim", d.w + T, 0.18, T + 0.08, d.x, WALL_H, z0);
    b.box(glow, d.w - 1, 0.06, 0.06, d.x, WALL_H - 0.25, z0 + 0.2);
    b.box("darkMetal", d.w, 0.16, 0.05, d.x, 0.08, z0 + T / 2 + 0.03);
    // Side walls with a doorway to the corridor (door frame lit with the department's accent).
    for (const sx of [x0, x1]) {
      const door = 2.4, seg = (d.d - door) / 2;
      b.box("wall", T, WALL_H, seg, sx, WALL_H / 2, z0 + seg / 2);
      b.box("wall", T, WALL_H, seg, sx, WALL_H / 2, z1 - seg / 2);
      b.box("wall", T, WALL_H - 2.6, door, sx, 2.6 + (WALL_H - 2.6) / 2, d.z);
      b.box("wallTrim", T + 0.1, 2.6, 0.12, sx, 1.3, d.z - door / 2); b.box("wallTrim", T + 0.1, 2.6, 0.12, sx, 1.3, d.z + door / 2);
      b.box(glow, T + 0.12, 0.06, door, sx, 2.62, d.z);
      b.box("wallTrim", T + 0.08, 0.18, d.d, sx, WALL_H, d.z);
    }
    // Front: a low parapet with a glass band (the cutaway), opening onto the corridor.
    const open = 3.2, seg = (d.w - open) / 2;
    for (const sx of [-1, 1]) {
      const cx = d.x + sx * (open / 2 + seg / 2);
      b.box("wallTrim", seg, 0.9, T, cx, 0.45, z1); b.box("glass", seg, 0.7, 0.04, cx, 1.25, z1); b.box(glow, seg, 0.04, 0.05, cx, 0.92, z1 + 0.12);
    }
    // Sign above the back wall's centre, the main status screen on it, and ceiling fixtures (light sources).
    screens.push({ id: `${d.id}:sign`, dep: d.id, kind: "sign", w: Math.min(7, d.w - 4), h: 0.55, x: d.x, y: WALL_H - 0.6, z: z0 + T / 2 + 0.02, ry: 0 });
    lights.push({ dep: d.id, x: d.x, y: WALL_H - 0.3, z: d.z, colour: d.accent });
    for (let i = -1; i <= 1; i += 2) { b.box("glow:#e0f2fe", 1.6, 0.05, 0.25, d.x + i * d.w / 4, WALL_H - 0.05, d.z - d.d / 6); }
    interior(d, x0, x1, z0, z1, acc, glow);
  }

  /** Each department's furniture, set against its walls so the floor stays clear for people. */
  function interior(d: Department, x0: number, x1: number, z0: number, z1: number, acc: MatKey, glow: MatKey) {
    const back = z0 + T / 2;
    const status = (w: number, h: number, x: number, y: number) => screens.push({ id: `${d.id}:status`, dep: d.id, kind: "status", w, h, x, y, z: back + 0.03, ry: 0 });
    /** A workstation desk facing `ry` (0 = facing the back wall), with a modesty panel and `monitors` screens. */
    const desk = (x: number, z: number, ry: number, monitors = 1) => {
      const c = Math.cos(ry), sn = Math.sin(ry);
      const at = (lx: number, lz: number) => ({ x: x + lx * c + lz * sn, z: z - lx * sn + lz * c });
      b.box("desk", 1.4, 0.06, 0.7, x, 0.76, z, ry);
      const panel = at(0, -0.3); b.box("darkMetal", 1.3, 0.7, 0.05, panel.x, 0.38, panel.z, ry);
      for (let m = 0; m < monitors; m++) {
        const off = (m - (monitors - 1) / 2) * 0.62, body = at(off, -0.18), face = at(off, -0.155), stand = at(off, -0.2);
        b.box("darkMetal", 0.58, 0.36, 0.04, body.x, 1.05, body.z, ry);
        b.box("screen", 0.52, 0.3, 0.01, face.x, 1.05, face.z, ry);
        b.box("darkMetal", 0.05, 0.22, 0.05, stand.x, 0.88, stand.z, ry);
      }
    };
    const shelf = (x: number, w: number, h = 2.4) => {
      b.box("darkMetal", w, h, 0.45, x, h / 2, back + 0.25);
      for (let r = 0; r < 4; r++) { const y = 0.35 + r * (h - 0.4) / 4; b.box("metal", w - 0.1, 0.04, 0.42, x, y, back + 0.27);
        for (let i = 0; i < Math.floor(w / 0.16); i++) { const hh = 0.24 + ((i * 37 + r * 11) % 7) * 0.02; b.box(i % 5 === 0 ? acc : "paper", 0.12, hh, 0.3, x - w / 2 + 0.12 + i * 0.16, y + hh / 2 + 0.02, back + 0.28); } }
    };
    const rack = (x: number, z: number, led: MatKey) => {
      b.box("darkMetal", 0.7, 2.2, 0.9, x, 1.1, z); b.box("metal", 0.66, 2.1, 0.02, x, 1.1, z + 0.45);
      for (let r = 0; r < 9; r++) b.box(led, 0.4, 0.03, 0.01, x - 0.05, 0.3 + r * 0.21, z + 0.465);
    };
    const console = (x: number, z: number, ry: number, w = 1.6) => {
      b.box("darkMetal", w, 0.9, 0.6, x, 0.45, z, ry);
      b.box("metal", w, 0.06, 0.66, x, 0.92, z, ry, -0.35);
      b.box("screen", w - 0.2, 0.42, 0.02, x + Math.sin(ry) * -0.05, 1.04, z + Math.cos(ry) * -0.05, ry, -0.35);
    };
    switch (d.id) {
      case "command": {
        // The raised command dais with its ring of consoles; the live core sits on it (scene).
        b.cyl("darkMetal", 3.0, 3.2, 0.5, d.x, 0, z0 + 2.3 + 1.2);
        b.cyl("floorDark", 2.9, 2.9, 0.04, d.x, 0.5, z0 + 3.5);
        b.ring(glow, 3.05, 0.04, d.x, 0.52, z0 + 3.5, 48);
        // Six consoles on an arc in front of the dais, each turned to face its centre.
        for (let i = 0; i < 6; i++) {
          const a = Math.PI * (0.18 + i * 0.128), r = 4.0, cx = d.x + Math.cos(a) * r, cz = z0 + 3.5 + Math.sin(a) * r;
          console(cx, cz, Math.atan2(d.x - cx, z0 + 3.5 - cz) + Math.PI, 1.3);
        }
        // Two wall displays flanking the core (one live status, mirrored), so the core never hides the figures.
        status(3.6, 1.9, d.x - 4.3, 2.0);
        screens.push({ id: `${d.id}:status2`, dep: d.id, kind: "status", w: 3.6, h: 1.9, x: d.x + 4.3, y: 2.0, z: back + 0.03, ry: 0 });
        for (const sx of [-1, 1]) { rack(d.x + sx * (d.w / 2 - 0.8), z0 + 1.0, glow); rack(d.x + sx * (d.w / 2 - 1.6), z0 + 1.0, glow); }
        b.box("fabric", 0.6, 0.5, 0.6, d.x, 0.75, z0 + 4.4); b.box("fabric", 0.6, 0.7, 0.12, d.x, 1.15, z0 + 4.7);
        break;
      }
      case "treasury": {
        // Vault door set in the back wall, deposit boxes either side, ledger counters along the side walls.
        b.cyl("gold", 1.45, 1.45, 0.22, d.x, 1.6, back + 0.02, 40, Math.PI / 2);
        b.cyl("darkMetal", 1.25, 1.25, 0.26, d.x, 1.6, back + 0.02, 40, Math.PI / 2);
        b.ring("gold", 0.55, 0.06, d.x, 1.6 + 0.13, back + 0.17, 32, 0);
        for (let i = 0; i < 6; i++) { const a = (i * Math.PI) / 3; b.box("gold", 0.08, 0.9, 0.08, d.x + Math.cos(a) * 0.42, 1.6 + 0.13 + Math.sin(a) * 0.42, back + 0.19, 0, 0, a); }
        for (const sx of [-1, 1]) for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) {
          const x = d.x + sx * (2.4 + c * 0.75), y = 0.4 + r * 0.5; b.box("metal", 0.7, 0.45, 0.4, x, y, back + 0.22); b.box("gold", 0.1, 0.04, 0.02, x, y, back + 0.43);
        }
        status(3.2, 1.2, d.x + 4.2, 2.75);
        // Ledger desks along the side walls (dual monitors, facing the wall) under a bank of wall displays.
        for (const sx of [-1, 1]) {
          const wx = sx < 0 ? x0 : x1, ry = sx < 0 ? Math.PI / 2 : -Math.PI / 2;
          for (const dz of [-1.0, 1.0]) desk(wx - sx * 0.75, d.z + 0.6 + dz * 0.85, ry, 2);
          for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) {
            const z = d.z + 0.6 + (c - 1) * 1.15, y = 1.75 + r * 0.7;
            b.box("darkMetal", 0.06, 0.62, 1.08, wx - sx * 0.2, y, z); b.box("screen", 0.01, 0.54, 1.0, wx - sx * 0.235, y, z);
          }
          b.box("gold", 0.04, 0.04, 3.5, wx - sx * 0.2, 1.38, d.z + 0.6);
          console(wx - sx * 0.75, d.z - 2.2, ry, 1.0);
        }
        // The Treasury hub: a hanging four-sided display over a gold floor seal, every face showing the live figures.
        const hz = d.z + 1.2;
        b.ring("gold", 1.7, 0.06, d.x, 0.13, hz, 48); b.ring(glow, 1.2, 0.03, d.x, 0.13, hz, 48);
        b.box("darkMetal", 2.3, 0.95, 2.3, d.x, 2.45, hz);
        for (const e of [-1.16, 1.16]) { b.box("gold", 2.34, 0.04, 0.04, d.x, 1.97, hz + e); b.box("gold", 0.04, 0.04, 2.34, d.x + e, 1.97, hz); }
        for (const sx of [-0.9, 0.9]) b.box("darkMetal", 0.04, 0.7, 0.04, d.x + sx, 3.25, hz);
        for (let f = 0; f < 4; f++) {
          const ry = (f * Math.PI) / 2;
          screens.push({ id: `${d.id}:hub${f}`, dep: d.id, kind: "status", w: 2.1, h: 0.85, x: d.x + Math.sin(ry) * 1.165, y: 2.45, z: hz + Math.cos(ry) * 1.165, ry });
        }
        break;
      }
      case "opportunity": {
        // Analysis table (a lit survey surface), lab benches with instruments, a signals board.
        b.cyl("darkMetal", 1.3, 1.3, 0.9, d.x - 3.5, 0, z0 + 2.0, 32); b.cyl("screen", 1.2, 1.2, 0.02, d.x - 3.5, 0.9, z0 + 2.0, 32); b.ring(glow, 1.25, 0.03, d.x - 3.5, 0.93, z0 + 2.0, 40);
        for (const sx of [x0 + 0.7, x1 - 0.7]) { b.box("desk", 0.9, 0.9, 6, sx, 0.45, d.z + 0.5); for (let i = 0; i < 4; i++) { b.cyl("glass", 0.1, 0.1, 0.3, sx, 0.9, d.z - 2 + i * 1.4, 12); b.box("metal", 0.3, 0.25, 0.3, sx, 1.02, d.z - 1.4 + i * 1.4); } }
        status(4.2, 1.6, d.x + 2.2, 2.3);
        break;
      }
      case "floor": {
        // Workstations are per agent (stations, scene). The room keeps a status wall, lockers and a supervisor console.
        status(6.0, 1.8, d.x, 2.25);
        for (let i = 0; i < 8; i++) { b.box("metal", 0.55, 2.0, 0.5, x0 + 0.6, 1.0, z0 + 1.2 + i * 0.6); b.box(acc, 0.04, 0.3, 0.02, x0 + 0.88, 1.6, z0 + 1.2 + i * 0.6); }
        console(x1 - 1.2, z0 + 1.2, 0, 2.0);
        break;
      }
      case "marketing": {
        // Media wall, studio lights, campaign boards.
        for (let r = 0; r < 3; r++) for (let c = 0; c < 6; c++) { b.box("darkMetal", 1.1, 0.66, 0.06, d.x - 2.9 + c * 1.16, 0.9 + r * 0.72, back + 0.05); if (!(r === 1 && (c === 2 || c === 3))) b.box("screen", 1.0, 0.56, 0.01, d.x - 2.9 + c * 1.16, 0.9 + r * 0.72, back + 0.09); }
        status(2.2, 1.3, d.x, 1.62);
        for (const sx of [-1, 1]) { const x = d.x + sx * (d.w / 2 - 1.2); b.cyl("darkMetal", 0.03, 0.03, 2.0, x, 0, z0 + 1.6, 8); b.box("darkMetal", 0.5, 0.4, 0.4, x, 2.1, z0 + 1.7); b.box("glow:#fdf2f8", 0.42, 0.32, 0.02, x, 2.1, z0 + 1.92); b.box("paper", 0.05, 1.6, 2.4, sx < 0 ? x0 + 0.3 : x1 - 0.3, 1.4, d.z + 2); }
        break;
      }
      case "library": {
        // Data stacks along the back wall, reading terminals at the sides.
        shelf(d.x - 4.5, 3.4); shelf(d.x + 4.5, 3.4); shelf(d.x, 3.0, 1.4);
        status(2.8, 1.0, d.x, 2.45);
        for (const sx of [x0 + 0.8, x1 - 0.8]) for (let i = 0; i < 2; i++) desk(sx, d.z + i * 2.6, sx < d.x ? -Math.PI / 2 : Math.PI / 2);
        break;
      }
      case "venture": {
        // Server racks, dev pods with dual monitors, a whiteboard.
        for (let i = 0; i < 5; i++) rack(d.x - 2.8 + i * 0.8, z0 + 0.8, "glow:#34d399");
        status(2.6, 1.2, d.x + 4.0, 2.5);
        for (const sx of [x0 + 0.8, x1 - 0.8]) for (let i = 0; i < 2; i++) desk(sx, d.z - 0.5 + i * 2.4, sx < d.x ? -Math.PI / 2 : Math.PI / 2, 2);
        b.box("paper", 2.4, 1.2, 0.04, d.x - 4.6, 1.6, back + 0.05); b.box("metal", 2.5, 0.05, 0.08, d.x - 4.6, 0.98, back + 0.08);
        break;
      }
      case "identity": {
        // Secure verification booths and kiosks.
        for (let i = 0; i < 3; i++) {
          const x = d.x - 3.5 + i * 3.5, z = z0 + 1.4;
          b.box("wallTrim", 0.12, 2.6, 1.6, x - 0.9, 1.3, z); b.box("wallTrim", 0.12, 2.6, 1.6, x + 0.9, 1.3, z); b.box("wallTrim", 1.92, 0.15, 1.6, x, 2.6, z);
          b.ring(glow, 0.7, 0.03, x, 1.3, z + 0.8, 40, 0); b.box("glass", 1.7, 2.4, 0.03, x, 1.25, z + 0.8);
          b.box("darkMetal", 0.5, 1.1, 0.3, x, 0.55, z - 0.4); b.box("screen", 0.4, 0.3, 0.01, x, 1.0, z - 0.24);
        }
        status(2.2, 0.9, d.x, 3.0);
        for (const sx of [x0 + 0.6, x1 - 0.6]) console(sx, d.z + 1.5, sx < d.x ? Math.PI / 2 : -Math.PI / 2, 1.2);
        break;
      }
      case "estate": {
        // Locker wall, shelving with sealed crates, an archive door.
        for (let r = 0; r < 4; r++) for (let c = 0; c < 10; c++) { const x = d.x - 6.3 + c * 0.7; if (c >= 4 && c <= 5) continue; b.box("metal", 0.66, 0.62, 0.5, x, 0.35 + r * 0.66, back + 0.27); b.box("darkMetal", 0.08, 0.04, 0.02, x + 0.2, 0.35 + r * 0.66, back + 0.53); }
        b.box("darkMetal", 1.3, 2.6, 0.2, d.x, 1.3, back + 0.12); b.box(acc, 0.06, 2.4, 0.02, d.x + 0.55, 1.3, back + 0.23);
        status(1.8, 0.6, d.x, 3.05);
        for (const sx of [x0 + 0.9, x1 - 0.9]) for (let i = 0; i < 3; i++) { b.box("paper", 0.9, 0.6, 0.9, sx, 0.3, d.z - 1 + i * 1.3); b.box("paper", 0.7, 0.5, 0.7, sx, 0.85, d.z - 1 + i * 1.3); }
        break;
      }
      case "comms": {
        // Antenna mast and dish, switchboards, a signal console.
        b.cyl("darkMetal", 0.08, 0.12, 2.4, x1 - 1.6, 0, z0 + 1.4, 12); b.sphere("metal", 0.9, x1 - 1.6, 2.6, z0 + 1.4, 20, 0.35); b.cyl("glow:#2dd4bf", 0.03, 0.03, 0.6, x1 - 1.6, 2.6, z0 + 1.4, 8);
        for (let i = 0; i < 4; i++) { const x = d.x - 4.5 + i * 1.3; b.box("darkMetal", 1.2, 2.0, 0.4, x, 1.0, back + 0.22); for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) b.box((r + c + i) % 4 === 0 ? glow : "metal", 0.1, 0.1, 0.02, x - 0.4 + c * 0.16, 0.6 + r * 0.22, back + 0.43); }
        status(2.6, 1.1, d.x + 1.8, 2.6);
        console(d.x + 1.2, z0 + 2.4, 0, 2.2);
        break;
      }
      case "security": {
        // Network operations wall, rack row, security desks; alarm beacons (scene) on the wall.
        status(7.0, 1.9, d.x, 2.2);
        for (const sx of [-1, 1]) { rack(d.x + sx * 6.3, z0 + 0.8, "glow:#f87171"); rack(d.x + sx * 7.1, z0 + 0.8, "glow:#f87171"); beacons.push({ x: d.x + sx * 4.2, y: 3.3, z: back + 0.2 }); }
        for (const sx of [-1, 1]) desk(d.x + sx * 3.2, z0 + 2.8, 0, 3);
        break;
      }
    }
  }

  /** Ultra: overhead gantries, cable runs and light rails above the corridors and rooms (fine detail, not fundamental). */
  function gantries() {
    for (const z of crossZ) { details.box("darkMetal", W.maxX - W.minX, 0.12, 0.3, cxW, WALL_H + 0.8, z); details.box("glow:#0e7490", W.maxX - W.minX, 0.03, 0.06, cxW, WALL_H + 0.72, z); }
    for (const x of spineX) { details.box("darkMetal", 0.3, 0.12, W.maxZ - W.minZ, x, WALL_H + 0.8, czW); details.cyl("rubber", 0.05, 0.05, W.maxZ - W.minZ, x + 0.25, WALL_H + 0.65, czW - (W.maxZ - W.minZ) / 2, 6, Math.PI / 2); }
    for (const d of DEPARTMENTS) for (let i = 0; i < 3; i++) details.box("darkMetal", d.w, 0.1, 0.18, d.x, WALL_H + 0.15, d.z - d.d / 3 + i * (d.d / 3));
  }
}

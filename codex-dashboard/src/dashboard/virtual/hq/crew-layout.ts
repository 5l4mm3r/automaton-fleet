/**
 * Where the specialist crew's desks stand (pure geometry, shared by the 3D scene and the 2D map; no three.js here so the
 * map's chunk stays light). Each role has a fixed bay of up to four desks in its department — researchers in Library /
 * Research, marketers in Marketing, producers in Venture / Dev, support in Comms, reviewers and the critical-tier advisor
 * either side of the command dais in Fleet Command. Seat k of a role is always the same desk.
 *
 * The bays were placed on the walkable floor of the built HQ (world-build.ts): every desk clears the room's furniture,
 * its work spots, intake and doorways, and the facility's walking graph keeps every room, spot and door reachable with
 * all desks present (fleet-virtual-crew.test.ts proves it against buildWorld()). Furniture only: nothing here moves.
 */
import type { Footprint } from "./nav";
import type { Point } from "../world";
import { HELPER_ROLES, type CrewDesk, type HelperRole } from "../../command/helpers";

/** One desk: its centre (x, z) and quarter-turns q (0 = monitor towards the room's back wall; yaw = q·π/2). */
export interface Bay { x: number; z: number; q: -1 | 0 | 1 | 2 }

export const CREW_BAYS: Readonly<Record<HelperRole, readonly Bay[]>> = Object.freeze({
  researcher: [{ x: 2.5, z: -24.5, q: 0 }, { x: 3.8, z: -24.5, q: 0 }, { x: 5.1, z: -24.5, q: 0 }, { x: 6.4, z: -24.5, q: 0 }],
  marketer: [{ x: 14.5, z: -29.5, q: 0 }, { x: 15.8, z: -29.5, q: 0 }, { x: 17.1, z: -29.5, q: 0 }, { x: 18.4, z: -29.5, q: 0 }],
  producer: [{ x: 15, z: -13, q: 0 }, { x: 16.3, z: -13, q: 0 }, { x: 17.6, z: -13, q: 0 }, { x: 18.9, z: -13, q: 0 }],
  support: [{ x: 14.25, z: 4.25, q: 1 }, { x: 14.25, z: 2.95, q: 1 }, { x: 14.25, z: 1.65, q: 1 }, { x: 14.25, z: 0.35, q: 1 }],
  reviewer: [{ x: -4.25, z: -14.5, q: -1 }, { x: -4.25, z: -13.2, q: -1 }, { x: -4.25, z: -11.9, q: -1 }, { x: -4.25, z: -10.6, q: -1 }],
  advisor: [{ x: 4.25, z: -14.4, q: 1 }, { x: 4.25, z: -13.1, q: 1 }, { x: 4.25, z: -11.8, q: 1 }, { x: 4.25, z: -10.5, q: 1 }],
} as Record<HelperRole, Bay[]>);

/** The desk's local frame (q = 0): the desk top spans z −0.575…−0.025 in front of the seat, the chair z 0.12…0.58. */
export const CREW_DESK = Object.freeze({ deskW: 1.1, deskZ0: -0.575, deskZ1: -0.025, chairW: 0.46, chairZ0: 0.12, chairZ1: 0.58, seatZ: 0.35 });

export const yawOf = (b: Bay) => (b.q * Math.PI) / 2;
/** Local (lx, lz) of a desk → world (three.js rotation about +Y by the desk's yaw). */
export function deskLocal(b: Bay, lx: number, lz: number): Point {
  const c = Math.round(Math.cos(yawOf(b))), s = Math.round(Math.sin(yawOf(b)));
  return { x: b.x + lx * c + lz * s, z: b.z - lx * s + lz * c };
}
/** Where the specialist sits (the chair). */
export const seatOf = (b: Bay): Point => deskLocal(b, 0, CREW_DESK.seatZ);

export function bayOf(role: HelperRole, seat: number): Bay | null { return CREW_BAYS[role][seat - 1] ?? null; }

/** The desk and chair as walking obstacles (axis-aligned footprints), for the nav grid. */
export function crewFootprints(bays: readonly Bay[]): Footprint[] {
  const D = CREW_DESK;
  return bays.flatMap((b) => [[-D.deskW / 2, D.deskZ0, D.deskW / 2, D.deskZ1], [-D.chairW / 2, D.chairZ0, D.chairW / 2, D.chairZ1]].map(([a, z0, c, z1]) => {
    const p = deskLocal(b, a, z0), q = deskLocal(b, c, z1);
    return { x0: Math.min(p.x, q.x), z0: Math.min(p.z, q.z), x1: Math.max(p.x, q.x), z1: Math.max(p.z, q.z) };
  }));
}

/** The bays shown for `perRole` desks per role (command/helpers.ts deskCount), in a stable order (role, then seat). */
export function shownBays(perRole: number): Array<{ role: HelperRole; seat: number; bay: Bay }> {
  return HELPER_ROLES.flatMap((role) => CREW_BAYS[role].slice(0, perRole).map((bay, i) => ({ role, seat: i + 1, bay })));
}
/** Every crew seat (for keeping strolls off the specialists' desks), all four per role. */
export const ALL_CREW_SEATS: readonly Point[] = Object.freeze(HELPER_ROLES.flatMap((r) => CREW_BAYS[r].map(seatOf)));

/** A desk with its geometry (the renderers' input). */
export interface PlacedDesk { desk: CrewDesk; bay: Bay; seat: Point }
export const placeDesks = (desks: readonly CrewDesk[]): PlacedDesk[] =>
  desks.flatMap((d) => { const bay = bayOf(d.role, d.seat); return bay ? [{ desk: d, bay, seat: seatOf(bay) }] : []; });


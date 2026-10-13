/**
 * Idle wandering (owner-approved 2026-10-13) — COSMETIC ONLY, pure and unit-tested.
 *
 * The Virtual rule stays: if something meaningful moves, something real happened. WHICH ROOM an agent is in comes only
 * from FleetController's state (departments.ts); an agent with nothing to do (no mission, no recent event, no team
 * project, awake and not held) may stroll INSIDE that room between dwells at its own place, so a quiet Fleet does not look
 * frozen. A stroll never changes the room, carries no information and is never shown as work. Deterministic per agent
 * (seeded by its id and a time slot), stopped under Reduce Motion, and cheap: one tiny computation per agent per frame, a
 * new goal only at slot boundaries.
 */
import type { Department } from "../../command/departments";
import type { Point } from "../world";

/** A wander cycle: dwell at the agent's own place, then stroll to a spot in the room and stand there for a while. */
export const WANDER_SLOT_MS = 36_000;
export const WANDER_DWELL = 0.55; // share of each slot spent at the agent's own place
/** Keep strolls this far from the room's walls (m). */
export const WANDER_MARGIN = 1.4;

const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0), 2166136261);
const unit = (n: number) => ((Math.imul(n ^ (n >>> 15), 2246822519) >>> 0) % 10_000) / 10_000;

/**
 * Where an idle agent should be at `now`: its own place `home` during the dwell part of each slot, otherwise a seeded spot
 * inside `room` (inset by WANDER_MARGIN). `ok` may veto a spot (e.g. not walkable floor): then the agent stays home.
 */
export function wanderPoint(id: string, home: Point, room: Pick<Department, "x" | "z" | "w" | "d">, now: number, ok: (p: Point) => boolean = () => true): Point {
  const seed = hash(id), t = now + (seed % WANDER_SLOT_MS), slot = Math.floor(t / WANDER_SLOT_MS), f = (t % WANDER_SLOT_MS) / WANDER_SLOT_MS;
  if (f < WANDER_DWELL) return home;
  const hw = Math.max(0, room.w / 2 - WANDER_MARGIN), hd = Math.max(0, room.d / 2 - WANDER_MARGIN);
  const p = { x: room.x + (unit(seed + slot * 7919) * 2 - 1) * hw, z: room.z + (unit(seed ^ (slot * 104729)) * 2 - 1) * hd };
  return ok(p) ? p : home;
}

/** May this agent wander? Awake, alive, not held or provisioning, and with nothing real to do right now. */
export const mayWander = (status: string, basis: string, team: boolean) => status === "active" && basis === "default" && !team;

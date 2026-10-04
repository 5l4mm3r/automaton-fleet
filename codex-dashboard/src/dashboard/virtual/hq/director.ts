/**
 * The optional event camera ("Auto-follow important events", off by default). Pure decisions, unit-tested:
 *
 *  - whether to take a shot: only when enabled, only for high-importance transports (medium ones only when nothing else
 *    is being shown), never while an agent is selected or under Reduce Motion, and only after the user has left the
 *    camera alone for a few seconds;
 *  - the shot's framing over time: the source as it activates, the route just ahead of the orb as it travels, then
 *    the destination as it responds (for a Treasury sweep: the Treasury banner);
 *  - cancellation: any user interaction ends the shot at once; manual control always wins.
 *
 * Presentation only — it never changes which events happen or their order.
 */
import { along } from "./route";
import { phaseAt, totalTime, type Transport } from "./transport";

export interface Shot { transport: Transport; until: number }
export interface DirectorState { enabled: boolean; shot: Shot | null; lastInteraction: number }
export const IDLE_BEFORE_SHOT_MS = 4000;

export function wantShot(s: DirectorState, t: Transport, now: number, ctx: { focusLevel: "fleet" | "department" | "agent"; reduceMotion: boolean }): boolean {
  if (!s.enabled || ctx.reduceMotion || ctx.focusLevel === "agent") return false;
  if (now - s.lastInteraction < IDLE_BEFORE_SHOT_MS) return false;
  if (t.importance === "low") return false;
  if (s.shot && now < s.shot.until) return t.importance === "high" && s.shot.transport.importance !== "high" ? true : false;
  return true;
}

export function takeShot(s: DirectorState, t: Transport): DirectorState {
  return { ...s, shot: { transport: t, until: t.start + Math.min(14_000, totalTime(t)) } };
}

/** Any user interaction cancels the shot immediately and restarts the idle clock. */
export const interact = (s: DirectorState, now: number): DirectorState => ({ ...s, shot: null, lastInteraction: now });

/** The camera goal for the shot at `now` (null once it is over): where to look and from where. */
export function shotGoal(s: DirectorState, now: number): { look: { x: number; y: number; z: number }; pos: { x: number; y: number; z: number } } | null {
  const shot = s.shot;
  if (!shot || now >= shot.until) return null;
  const t = shot.transport, { phase, k } = phaseAt(t, now), src = t.route[0], dst = t.route[t.route.length - 1];
  const span = Math.max(8, Math.hypot(dst.x - src.x, dst.z - src.z));
  let look: { x: number; z: number }, h: number;
  if (phase === "activate" || phase === "launch") { look = src; h = 14; }
  else if (phase === "travel") { const a = along(t.route, Math.min(1, k + 0.08)).p; look = { x: (a.x * 2 + dst.x) / 3, z: (a.z * 2 + dst.z) / 3 }; h = Math.min(30, 12 + span * 0.35); }
  else { look = dst; h = 12; }
  return { look: { x: look.x, y: 0.8, z: look.z }, pos: { x: look.x, y: h, z: look.z + h * 0.75 } };
}

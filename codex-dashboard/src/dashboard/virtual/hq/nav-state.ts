/**
 * The HQ's user camera state, shared by the camera rig (gestures, framing), the scene (click suppression) and the
 * on-screen controls ([−] [FIT] [+]). One per page (one scene at a time). Presentation only.
 */
import type { NavView } from "./viewfit";

export type NavCommand = { kind: "zoom"; factor: number } | { kind: "fit" };

export const HQ_NAV = {
  /** The user's zoom/pan over the current level's fitted framing. */
  view: { zoom: 1, pan: { x: 0, z: 0 } } as NavView,
  /** The Fleet framing to return to (saved on entering a room, restored by Back/Esc). */
  saved: null as NavView | null,
  /** Commands from the on-screen controls, consumed by the camera rig. */
  commands: [] as NavCommand[],
  /** A drag or pinch just happened: clicks before this time are not room/agent selections. */
  suppressClickUntil: 0,
  /** Last user camera gesture (for responsive easing while the user drives). */
  lastGesture: 0,
};

export const clickSuppressed = () => Date.now() < HQ_NAV.suppressClickUntil;
export const resetNav = () => { HQ_NAV.view = { zoom: 1, pan: { x: 0, z: 0 } }; HQ_NAV.saved = null; HQ_NAV.commands = []; HQ_NAV.suppressClickUntil = 0; };

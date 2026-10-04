/**
 * Cinematic information transport — the PRESENTATION model for real FleetController events (pure; unit-tested).
 *
 * Every transport here starts from one recorded event (world.ts packetFor). Nothing in this module creates, reorders or
 * changes events: it decides only how and when each one is SHOWN.
 *
 *  - Semantics: a category per event (information, opportunity, money, realised outcome, alert) with its colour language.
 *  - Presentation priority (1 = most important) and importance (high / medium / low) — for the visual scheduler and the
 *    optional event camera only; never a Fleet or economic priority.
 *  - Scheduler: a bounded queue; at most N transports play at once (by quality); the rest wait their turn in a
 *    deterministic order (priority, then event time, then id). If the queue is full the least important waiting
 *    transport is dropped from the ANIMATION only — the event itself stays in the activity feed and in the state.
 *  - Phases: ACTIVATE → LAUNCH → TRAVEL → ARRIVE → RESPOND → SETTLE. The destination responds only after arrival.
 */
import type { Packet } from "../world";
import { along, pathLength, roomAt, routeThrough } from "./route";

export type TransportCategory = "information" | "opportunity" | "money" | "outcome" | "alert" | "project";
export type Importance = "high" | "medium" | "low";

/** The colour language: cyan/blue information, violet opportunity, gold money, green realised outcome, red alert. */
export const CATEGORY_COLOUR: Readonly<Record<TransportCategory, string>> = {
  information: "#38bdf8", opportunity: "#a78bfa", money: "#fbbf24", outcome: "#34d399", alert: "#ef4444", project: "#7dd3fc",
};

/** The category of a transport (from the event's own kind and label). */
export function categoryOf(p: Pick<Packet, "kind" | "label">): TransportCategory {
  switch (p.kind) {
    case "SYSTEM_ALERT": return "alert";
    case "TREASURY_TRANSFER": case "CAPITAL_REQUEST_DECIDED": case "EXPENSE_EVENT": case "ESTATE_TRANSFER": return "money";
    case "REVENUE_EVENT": return "outcome";
    case "OPPORTUNITY_EVENT": return "opportunity";
    case "PROJECT_EVENT": return /payment|distribution/i.test(p.label) ? "money" : "project";
    default: return "information";
  }
}

/** Presentation priority: 1 critical alert · 2 financial / Treasury · 3 project contract or delivery · 4 realised outcome · 5 opportunity / research / knowledge · 6 other status. */
export function priorityOf(p: Pick<Packet, "kind" | "label">): number {
  const c = categoryOf(p);
  return c === "alert" ? 1 : c === "money" ? 2 : c === "project" ? 3 : c === "outcome" ? 4 : c === "opportunity" || p.kind === "RESEARCH_EVENT" ? 5 : 6;
}

/** Importance for the optional event camera (presentation only). */
export function importanceOf(p: Pick<Packet, "kind" | "label">): Importance {
  if (p.kind === "SYSTEM_ALERT" || p.kind === "REVENUE_EVENT" || p.kind === "AGENT_DIED" || p.kind === "AGENT_BORN") return "high";
  if (p.kind === "TREASURY_TRANSFER" && /profit|sweep/i.test(p.label)) return "high";
  if (p.kind === "PROJECT_EVENT" && /completed|distribution/i.test(p.label)) return "high";
  if (p.kind === "PROJECT_EVENT" && /offer|joined|delivered|created/i.test(p.label)) return "medium";
  if (p.kind === "CAPITAL_REQUEST_DECIDED" || p.kind === "TREASURY_TRANSFER" || p.kind === "OPPORTUNITY_EVENT") return "medium";
  return "low";
}

/** The board-style label (the event's own label when there is no better name). */
export function transportLabel(p: Pick<Packet, "kind" | "label" | "points">): string {
  switch (p.kind) {
    case "REVENUE_EVENT": return "SALE RECORDED";
    case "TREASURY_TRANSFER": return /genesis/i.test(p.label) ? "CAPITAL ALLOCATED" : /profit|sweep/i.test(p.label) ? "TREASURY SWEEP" : "SETTLEMENT";
    case "CAPITAL_REQUEST_CREATED": return "CAPITAL REQUEST";
    case "CAPITAL_REQUEST_DECIDED": return p.points.length > 2 ? "CAPITAL ALLOCATED" : "CAPITAL DECISION";
    case "RESEARCH_EVENT": return "KNOWLEDGE RECORDED";
    case "OPPORTUNITY_EVENT": return /shortlist|validat|accept/i.test(p.label) ? "OPPORTUNITY VALIDATED" : "RESEARCH RESULT";
    case "VENTURE_EVENT": return /project/i.test(p.label) ? p.label.toUpperCase() : "VENTURE UPDATE";
    case "MISSION_STARTED": case "MISSION_COMPLETED": return "MISSION UPDATE";
    case "MARKETING_EVENT": return "CAMPAIGN UPDATE";
    case "SYSTEM_ALERT": return "SECURITY ALERT";
    case "AGENT_BORN": return "AGENT BORN";
    case "AGENT_DIED": return "AGENT DIED";
    case "ESTATE_TRANSFER": return "ESTATE TRANSFER";
    case "EXPENSE_EVENT": return "EXPENSE";
    case "IDENTITY_EVENT": return "IDENTITY UPDATE";
    case "COMMS_EVENT": return "COMMS";
    case "PROJECT_EVENT": return p.label.toUpperCase();
    default: return p.label.toUpperCase().slice(0, 28);
  }
}

/** Phase timing (ms). Travel time follows the route (≈7 m/s, 2.5–9 s). */
export const PHASE = { activate: 500, launch: 350, arrive: 400, respond: 900, settle: 700 } as const;
export const travelTime = (route: readonly { x: number; z: number }[]) => Math.min(9000, Math.max(2500, (pathLength(route) / 7) * 1000));
export type Phase = "activate" | "launch" | "travel" | "arrive" | "respond" | "settle" | "done";

/** A scheduled transport (presentation). `start` is when its presentation began (scheduler), not the event's time. */
export interface Transport {
  id: string; route: { x: number; z: number }[]; eventAt: number; start: number; travel: number;
  category: TransportCategory; colour: string; priority: number; importance: Importance; label: string;
  /** The event's agent, and the agent at the destination end (if the route ends at one), for receive reactions. */
  agentId: string | null; counterpartId: string | null;
  /** The agent at the source end (its terminal confirms as the event launches). */
  sourceAgentId: string | null;
}
export const totalTime = (t: Pick<Transport, "travel">) => PHASE.activate + PHASE.launch + t.travel + PHASE.arrive + PHASE.respond + PHASE.settle;

export function phaseAt(t: Transport, now: number): { phase: Phase; k: number } {
  let a = now - t.start;
  if (a < 0) return { phase: "activate", k: 0 };
  const steps: Array<[Phase, number]> = [["activate", PHASE.activate], ["launch", PHASE.launch], ["travel", t.travel], ["arrive", PHASE.arrive], ["respond", PHASE.respond], ["settle", PHASE.settle]];
  for (const [ph, d] of steps) { if (a < d) return { phase: ph, k: a / d }; a -= d; }
  return { phase: "done", k: 1 };
}

/** From a real packet to a transport waiting to be presented. */
export function toTransport(p: Packet, now: number): Transport {
  const route = routeThrough(p.points), category = categoryOf(p);
  return { id: p.id, route, eventAt: p.at ?? p.start, start: now, travel: travelTime(route), category, colour: CATEGORY_COLOUR[category], priority: priorityOf(p), importance: importanceOf(p),
    label: transportLabel(p), agentId: p.agentId, counterpartId: p.endAgentId ?? null, sourceAgentId: p.startAgentId ?? null };
}

/** The visual scheduler's state: playing and waiting transports, and what was dropped from animation (bounded). */
export interface Schedule { active: Transport[]; queue: Transport[]; seen: Set<string>; dropped: number }
export const newSchedule = (): Schedule => ({ active: [], queue: [], seen: new Set(), dropped: 0 });
export const QUEUE_CAP = 40;
/** An event older than this when its turn comes is not animated (it stays in the feed and in the state). */
export const STALE_MS = 45_000;

const order = (a: Transport, b: Transport) => a.priority - b.priority || a.eventAt - b.eventAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Add new real transports and advance the schedule at `now`: finished ones leave, waiting ones start when a slot is
 * free (most important first, then oldest); one whose event is older than STALE_MS by then is not animated. Deterministic; never more than `slots` playing or QUEUE_CAP waiting.
 */
export function advance(s: Schedule, incoming: readonly Transport[], now: number, slots: number): Schedule {
  for (const t of incoming) { if (s.seen.has(t.id)) continue; s.seen.add(t.id); s.queue.push(t); }
  if (s.seen.size > 4000) s.seen = new Set([...s.active, ...s.queue].map((t) => t.id));
  s.active = s.active.filter((t) => now - t.start < totalTime(t));
  s.queue.sort(order);
  while (s.active.length < slots && s.queue.length) {
    const t = s.queue.shift()!;
    if (now - t.eventAt > STALE_MS) { s.dropped++; continue; } // late: presented in the feed only
    t.start = now; s.active.push(t);
  }
  while (s.queue.length > QUEUE_CAP) { s.queue.pop(); s.dropped++; } // the least important, newest waiting one
  return s;
}

export type P2 = { x: number; z: number };
export type TransportMode = "full" | "reduced" | "off";

/** What one moment of the transport presentation shows — pure; the renderer only draws this. */
export interface TransportFrame {
  /** Orbs travelling (full mode, TRAVEL phase), with how far along (k). */
  orbs: Array<{ id: string; p: P2; k: number; ahead: P2 }>;
  /** The lit route: how much is lit from the source (0..1) and how bright. */
  routes: Array<{ id: string; lit: number; glow: number }>;
  /** Source activity (ACTIVATE/LAUNCH): the origin's terminal and socket. */
  sources: Array<{ id: string; p: P2; strength: number }>;
  /** Junctions pulsing as the orb passes. */
  junctions: Array<{ id: string; p: P2; strength: number }>;
  /** Destination receiver: lit on ARRIVE, reacting through RESPOND (after arrival only). */
  receivers: Array<{ id: string; p: P2; strength: number; phase: "arrive" | "respond" }>;
  /** Static direction marks (Reduce Motion). */
  chevrons: Array<{ id: string; p: P2; dir: P2 }>;
  labels: Array<{ id: string; text: string; p: P2; y: number }>;
  /** Rooms and agents responding right now (destination screens, banner, receiving terminals). */
  responding: Array<{ id: string; room: string | null; agentId: string | null }>;
  /** Agents whose terminal is sending right now (ACTIVATE/LAUNCH); `done` when the event is a delivery or completion. */
  activating: Array<{ id: string; agentId: string; done: boolean }>;
}

export function transportFrame(active: readonly Transport[], now: number, mode: TransportMode): TransportFrame {
  const out: TransportFrame = { orbs: [], routes: [], sources: [], junctions: [], receivers: [], chevrons: [], labels: [], responding: [], activating: [] };
  for (const t of active) {
    const { phase, k } = phaseAt(t, now);
    if (phase === "done") continue;
    const src = t.route[0], dst = t.route[t.route.length - 1], room = roomAt(dst)?.id ?? null;
    const destAgent = t.counterpartId;
    const respond = () => out.responding.push({ id: t.id, room, agentId: destAgent });
    if (mode !== "full") {
      // No travel: source, route (Reduce Motion), destination and label shown together; the response still follows.
      if (phase === "settle") continue;
      out.labels.push({ id: t.id, text: t.label, p: dst, y: 2.6 });
      out.receivers.push({ id: t.id, p: dst, strength: 1, phase: phase === "respond" ? "respond" : "arrive" });
      if (phase === "respond") respond();
      if (mode === "off") continue;
      out.sources.push({ id: t.id, p: src, strength: 1 });
      out.routes.push({ id: t.id, lit: 1, glow: 0.8 });
      const L = pathLength(t.route);
      for (let s = 1.25; s < L; s += 2.5) { const a = along(t.route, s / L); out.chevrons.push({ id: t.id, p: a.p, dir: a.dir }); }
      continue;
    }
    if ((phase === "activate" || phase === "launch") && t.sourceAgentId) out.activating.push({ id: t.id, agentId: t.sourceAgentId, done: /DELIVERED|COMPLETED/.test(t.label) });
    switch (phase) {
      case "activate": out.sources.push({ id: t.id, p: src, strength: k }); out.labels.push({ id: t.id, text: t.label, p: src, y: 2.2 }); break;
      case "launch": out.sources.push({ id: t.id, p: src, strength: 1 }); out.routes.push({ id: t.id, lit: 0, glow: 0.3 + k * 0.4 }); out.labels.push({ id: t.id, text: t.label, p: src, y: 2.2 }); break;
      case "travel": {
        const at = along(t.route, k), L = pathLength(t.route), ahead = along(t.route, Math.min(1, k + 3 / Math.max(1, L))).p;
        out.sources.push({ id: t.id, p: src, strength: Math.max(0, 1 - k * 4) });
        out.routes.push({ id: t.id, lit: k, glow: 1 }); // illumination propagates with the orb
        out.orbs.push({ id: t.id, p: at.p, k, ahead });
        out.labels.push({ id: t.id, text: t.label, p: at.p, y: 1.55 });
        let acc = 0;
        for (let i = 1; i < t.route.length - 1; i++) {
          acc += Math.hypot(t.route[i].x - t.route[i - 1].x, t.route[i].z - t.route[i - 1].z);
          const passed = acc / L;
          if (k >= passed && (k - passed) * t.travel < 600) out.junctions.push({ id: t.id, p: t.route[i], strength: 1 - ((k - passed) * t.travel) / 600 });
        }
        break;
      }
      case "arrive": out.routes.push({ id: t.id, lit: 1, glow: 1 - k * 0.3 }); out.receivers.push({ id: t.id, p: dst, strength: 0.4 + k * 0.6, phase: "arrive" }); out.labels.push({ id: t.id, text: t.label, p: dst, y: 2.2 }); break;
      case "respond": out.routes.push({ id: t.id, lit: 1, glow: 0.7 * (1 - k) }); out.receivers.push({ id: t.id, p: dst, strength: 1 - k * 0.5, phase: "respond" }); out.labels.push({ id: t.id, text: t.label, p: dst, y: 2.2 }); respond(); break;
      case "settle": out.routes.push({ id: t.id, lit: 1, glow: 0.35 * (1 - k) }); break;
    }
  }
  return out;
}

/** How many transports may play at once (readability over spectacle; never an economic limit). */
export const slotsFor = (detail: number, reduced: boolean) => (reduced ? 4 : detail >= 2 ? 8 : detail >= 1 ? 6 : 3);

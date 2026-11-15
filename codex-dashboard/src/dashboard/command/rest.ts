/**
 * An agent's rest, as the reading shows it (owner, 2026-10-14): the OWNER's pause, or a hibernation the agent itself
 * REPORTED recently enough to stand. A report older than HIBERNATION_REPORT_FRESH_MS, or none at all, is UNKNOWN —
 * hibernation is never inferred from inactivity or from the owner's pause.
 *
 * Freshness: a running agent reports at the end of every turn, and a hibernating one re-checks at least daily (the
 * runtime's 24-hour safety re-check, founder/mind.ts HIBERNATION_SAFETY_MS) — so a report older than a day and a margin
 * no longer describes the agent.
 */
import type { Agent } from "../model";
import { span, type SleepState } from "./departments";

export const HIBERNATION_REPORT_FRESH_MS = 26 * 3_600_000;

export interface Rest {
  /** Why the agent is in Quarters (null = awake or not known): the owner's pause outranks a reported hibernation. */
  sleep: SleepState | null;
  /** When that sleep began (ms; null = not known). */
  since: number | null;
  /** The agent's own rest report: hibernating / awake when fresh, otherwise unknown. */
  hibernation: "hibernating" | "awake" | "unknown";
  /** When the agent last reported (ms; null = never) — shown with the state, so its age is visible. */
  reportedAt: number | null;
}

const ms = (iso: string | null | undefined) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };

export function restOf(a: Pick<Agent, "paused" | "pausedSince" | "hibernation">, now: number = Date.now()): Rest {
  const reportedAt = ms(a.hibernation?.reportedAt);
  const fresh = reportedAt != null && now - reportedAt <= HIBERNATION_REPORT_FRESH_MS && reportedAt <= now + 60_000;
  const hibernation = fresh && a.hibernation ? a.hibernation.state : "unknown";
  if (a.paused === true) return { sleep: "owner_pause", since: ms(a.pausedSince), hibernation, reportedAt };
  if (hibernation === "hibernating") return { sleep: "hibernating", since: ms(a.hibernation?.since), hibernation, reportedAt };
  return { sleep: null, since: null, hibernation, reportedAt };
}

/** The agent's own rest report for people, with its age: "hibernating · reported 3h 5m ago", "unknown · last report 4d 2h ago". */
export function hibernationText(r: Rest, now: number = Date.now()): string {
  const age = r.reportedAt != null ? `${span(Math.max(0, now - r.reportedAt))} ago` : null;
  if (r.hibernation !== "unknown") return `${r.hibernation} · reported ${age}`;
  return age ? `unknown · last report ${age}` : "unknown · never reported";
}

/** The owner's pause for people: "paused · for 4d 6h", "paused · for —", "not paused" or "—" (not supplied). */
export function pauseText(a: Pick<Agent, "paused">, r: Rest, now: number = Date.now()): string {
  if (a.paused === true) return `paused · for ${span(r.since != null ? now - r.since : null)}`;
  return a.paused === false ? "not paused" : "—";
}

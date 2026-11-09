/**
 * 2026-11-09 (SHEET-1 diagnosis) — the founder sees its own runway and the files its owner's task requires.
 *
 * SHEET-1: Agent-1 wrote a correct workbook; 7 s later every model call was refused FLEET_COGNITION_CREDITS_EXHAUSTED with
 * $0.76 of its $4 cap still free (a call reserves its worst case first: about $0.78 there, 11.7× an average call), and the
 * delivery note the task asked for was never written. Nothing told it the end was near. Two views, both information only
 * (they authorise nothing and change no check):
 *   1. the RUNWAY: how many more steps its limits admit, counted the way FleetController checks them (a step runs only
 *      while the limit still covers its full reservation), and the run's time left; close to the end, "finish now";
 *   2. REQUIRED FILES: an owner task may name the files it needs ("Required files: a, b"); each is shown as written or
 *      MISSING, and a sleep while one is missing is answered once per turn (FounderToolbox).
 */
import fs from "fs";
import path from "path";

/** v128 `api_cognition_status.runway`. Units: creditFreeMicro USD µ¢; dailyLeftMicro and run figures accounting µ¢. */
export interface Runway {
  creditFreeMicro: number | null;
  dailyLeftMicro: number | null;
  run: { ceilingMicro: number; spentMicro: number; endsAt: string } | null;
}

/** One recorded call: its reservation (USD µ¢ and accounting µ¢) and what it was actually charged (accounting µ¢). */
export interface CallCost { reserveUsdMicro: number; reserveMinorMicro: number; chargedMinorMicro: number }

/** At or below this many steps (or FINISH_MINUTES of the run's time) the founder is told to finish now. */
export const FINISH_STEPS = 8;
export const FINISH_MINUTES = 10;
/** The runway line is shown while a run is open, or while a limit admits at most this many steps (else it is noise). */
export const SHOW_STEPS = 60;
/** Calls the average is taken over (the most recent). */
export const COST_WINDOW = 20;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : null);

export function parseRunway(x: unknown): Runway | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const r = o.run && typeof o.run === "object" ? (o.run as Record<string, unknown>) : null;
  const ceiling = num(r?.ceilingMicro), spent = num(r?.spentMicro), ends = typeof r?.endsAt === "string" && Number.isFinite(Date.parse(r.endsAt)) ? r.endsAt : null;
  return {
    creditFreeMicro: num(o.creditFreeMicro),
    dailyLeftMicro: num(o.dailyLeftMicro),
    run: r && ceiling !== null && spent !== null && ends ? { ceilingMicro: ceiling, spentMicro: spent, endsAt: ends } : null,
  };
}

/**
 * Steps a limit admits: a step runs only while the limit left covers its whole reservation, and then costs about the
 * average — so n steps run while left − (n−1)·avg ≥ reserve. Null when the cost of a step is not known yet.
 */
export function stepsWithin(left: number, reserve: number, avg: number | null): number | null {
  if (left < reserve) return 0;
  if (avg === null || !(avg > 0)) return null;
  return 1 + Math.floor((left - reserve) / avg);
}

export interface RunwayView {
  /** The fewest steps any limit admits (null: not known yet, or no limit is near). */
  steps: number | null;
  /** Which limit that is. */
  binding: "provider credit" | "run budget" | "daily budget" | null;
  minutesLeft: number | null;
  finishNow: boolean;
  line: string | null;
}

export function runwayView(rw: Runway | null, calls: readonly CallCost[], nowMs: number): RunwayView {
  const none: RunwayView = { steps: null, binding: null, minutesLeft: null, finishNow: false, line: null };
  if (!rw) return none;
  const recent = calls.slice(-COST_WINDOW);
  const last = recent[recent.length - 1];
  // The share of its reservation a call actually costs (accounting units on both sides), applied to each limit's own unit.
  const resSum = recent.reduce((a, c) => a + c.reserveMinorMicro, 0);
  const share = resSum > 0 ? recent.reduce((a, c) => a + c.chargedMinorMicro, 0) / resSum : null;
  const limits: Array<{ name: RunwayView["binding"]; steps: number | null }> = [];
  if (last) {
    const avgUsd = share === null ? null : share * last.reserveUsdMicro;
    const avgMinor = share === null ? null : share * last.reserveMinorMicro;
    if (rw.creditFreeMicro !== null) limits.push({ name: "provider credit", steps: stepsWithin(rw.creditFreeMicro, last.reserveUsdMicro, avgUsd) });
    if (rw.run) limits.push({ name: "run budget", steps: stepsWithin(rw.run.ceilingMicro - rw.run.spentMicro, last.reserveMinorMicro, avgMinor) });
    if (rw.dailyLeftMicro !== null) limits.push({ name: "daily budget", steps: stepsWithin(rw.dailyLeftMicro, last.reserveMinorMicro, avgMinor) });
  }
  const known = limits.filter((l) => l.steps !== null) as Array<{ name: RunwayView["binding"]; steps: number }>;
  const tight = known.length ? known.reduce((a, b) => (b.steps < a.steps ? b : a)) : null;
  const minutesLeft = rw.run ? Math.max(0, Math.floor((Date.parse(rw.run.endsAt) - nowMs) / 60_000)) : null;
  const finishNow = (tight !== null && tight.steps <= FINISH_STEPS) || (minutesLeft !== null && minutesLeft <= FINISH_MINUTES);
  if (!rw.run && (tight === null || tight.steps > SHOW_STEPS)) return { ...none, steps: tight?.steps ?? null, binding: tight?.name ?? null };
  const ratio = share !== null && share > 0 ? Math.round(1 / share) : null;
  const parts = [
    tight === null ? "Runway: not known until your first recorded step of this run."
      : tight.steps === 0 ? `Runway: your ${tight.name} no longer covers one step's reservation — your next model call will be refused.`
      : `Runway: about ${tight.steps} more step${tight.steps === 1 ? "" : "s"} before your model calls are refused (the ${tight.name} is the limit).`,
    last ? `A step first reserves its worst case${ratio && ratio > 1 ? ` (about ${ratio}× what a step has actually cost)` : ""} and runs only while that is covered, so the last part of the budget cannot be used.` : "",
    minutesLeft !== null ? `This run ends in ${minutesLeft} minute${minutesLeft === 1 ? "" : "s"} (${rw.run!.endsAt.slice(11, 16)} UTC).` : "",
  ];
  return { steps: tight?.steps ?? null, binding: tight?.name ?? null, minutesLeft, finishNow, line: parts.filter(Boolean).join(" ") };
}

/** The "finish now" instruction, naming any required file still missing. */
export function finishLine(v: RunwayView, missing: readonly string[]): string {
  const left = v.steps !== null ? `about ${v.steps} step${v.steps === 1 ? "" : "s"}` : "";
  const time = v.minutesLeft !== null && v.minutesLeft <= FINISH_MINUTES ? `${v.minutesLeft} minute${v.minutesLeft === 1 ? "" : "s"}` : "";
  return `FINISH NOW: ${[left, time].filter(Boolean).join(" / ")} left. `
    + (missing.length ? `Write the missing required file${missing.length > 1 ? "s" : ""} first — ${missing.join(", ")} — short and complete beats polished and absent; `
      : "Complete what you are delivering and record where you are; ")
    + "start nothing new and do not re-check finished work.";
}

// ─── Required files of an owner task ───

export const MAX_REQUIRED_FILES = 10;
const REQUIRED_RE = /^[ \t]*(?:[-*][ \t]*)?required files?[ \t]*:[ \t]*(.+)$/im;
const SAFE_REL = /^[A-Za-z0-9._\- /]{1,200}$/;

export interface RequiredFile { task: string; path: string }

/** The files the owner's open tasks name ("Required files: a, b" on its own line; workspace-relative; at most 10). */
export function requiredFilesOf(attention: unknown): RequiredFile[] {
  const list = attention && typeof attention === "object" && Array.isArray((attention as { ownerTasks?: unknown }).ownerTasks) ? (attention as { ownerTasks: unknown[] }).ownerTasks : [];
  const out: RequiredFile[] = [];
  for (const t of list.slice(0, 3)) {
    if (!t || typeof t !== "object") continue;
    const { id, body } = t as { id?: unknown; body?: unknown };
    if (typeof id !== "string" || typeof body !== "string") continue;
    const m = REQUIRED_RE.exec(body);
    if (!m) continue;
    for (const raw of m[1].split(/[,;]/)) {
      const p = raw.trim().replace(/^[`"']+|[`"'.]+$/g, "").replace(/^\.\//, "");
      if (!p || !SAFE_REL.test(p) || p.startsWith("/") || p.split("/").some((s) => s === ".." || s === "." || s === "")) continue;
      if (out.length < MAX_REQUIRED_FILES && !out.some((f) => f.path === p)) out.push({ task: id.slice(0, 8), path: p });
    }
  }
  return out;
}

/** Bytes of a required file, or null when it is missing: a regular, non-empty file inside the workspace (no link out). */
export function requiredFileSize(workspaceDir: string, rel: string): number | null {
  try {
    const root = fs.realpathSync(workspaceDir);
    const abs = path.join(root, rel);
    const st = fs.lstatSync(abs);
    if (!st.isFile() || st.size <= 0) return null;
    const real = fs.realpathSync(abs);
    if (real !== abs || !real.startsWith(root + path.sep)) return null;
    return st.size;
  } catch {
    return null;
  }
}

export function missingRequired(workspaceDir: string, files: readonly RequiredFile[]): string[] {
  return files.filter((f) => requiredFileSize(workspaceDir, f.path) === null).map((f) => f.path);
}

/** One packet line: each required file written (with its size) or MISSING. Null when no task names any. */
export function requiredFilesLine(workspaceDir: string, files: readonly RequiredFile[]): string | null {
  if (!files.length) return null;
  const byTask = new Map<string, string[]>();
  for (const f of files) {
    const n = requiredFileSize(workspaceDir, f.path);
    byTask.set(f.task, [...(byTask.get(f.task) ?? []), `${f.path} — ${n === null ? "MISSING" : `written (${n} bytes)`}`]);
  }
  const missing = missingRequired(workspaceDir, files).length;
  return [...byTask].map(([task, xs]) => `Required files of owner task ${task}: ${xs.join("; ")}.`).join(" ")
    + (missing ? ` The task is not complete while ${missing === 1 ? "one is" : `${missing} are`} missing: write every required file before polishing or re-checking finished ones.` : " All written.");
}

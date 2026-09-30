/**
 * F1-EVAL-02 driver (dev VM). Runs the plan cell by cell and checkpoints everything durably, so the evaluation never
 * depends on a conversation surviving:
 *
 *   <out>/config.json            model, effort, prices, cap, transport target (written by the operator/engineer)
 *   <out>/ledger.json            spend per cell, interrupted-cell reservations, cumulative total (the budget authority)
 *   <out>/events/<cell>.jsonl    every progress line as it arrives (call_start with its worst-case bound, call_end)
 *   <out>/cells/<cell>.json      the cell result (observable outputs, usage, cost) — written once, never rerun
 *   <out>/state/<cell>.json      the founder-private persistent state after the cell (thinking stripped)
 *   <out>/scores.json            deterministic scoring (`score`)
 *
 * Resume: completed cells are skipped. A cell with events but no result was interrupted: its spend is counted
 * conservatively (reported costs + the worst-case bound of any call that started without ending) and the driver STOPS;
 * the interrupted cell is rerun only when the operator names it (`--rerun-interrupted <cellId>`), so a restart never
 * repeats billable calls by itself. The remaining budget passed to each cell is cap − everything counted so far, and
 * the runner refuses any call whose worst case would exceed it. A budget stop or a provider error stops the driver.
 *
 * Restart shield (fails closed on ambiguous durable state; never guesses):
 *   - `<out>/CLOSED` seals an accepted evaluation: `run` refuses;
 *   - `<out>/run.lock` (exclusive create) admits one driver at a time; a lock left by a dead driver must be inspected
 *     and removed by the operator;
 *   - config, ledger, cell results and parent state are read strictly: a present but unreadable file refuses the run
 *     (it is never replaced by an empty default); a missing ledger while results or events exist refuses too;
 *   - the ledger must match the configured cap and its own total; a completed cell missing from the ledger (a crash
 *     between the result write and the ledger write) is reconciled from its durable result before anything runs.
 *
 *   tsx src/fleet/eval/f1-eval-02-driver.ts run   --out <dir> [--mandatory-only] [--only <cellId>] [--rerun-interrupted <cellId>]…
 *   tsx src/fleet/eval/f1-eval-02-driver.ts models --out <dir>
 *   tsx src/fleet/eval/f1-eval-02-driver.ts score  --out <dir>
 */

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import type { Prices } from "../cognition/charging.js";
import { runCell, type CellRequest, type CellResult, type Snapshot } from "./f1-eval-02.js";
import { PLAN, scoreCell, type PlannedCell } from "./f1-eval-02-plan.js";
import { FakeFounderModel } from "./fake-founder-model.js";

export interface EvalConfig {
  transport: "fake" | "ssh";
  model: string;
  effort: "low" | "medium" | "high" | "max";
  maxTokens: number;
  prices: Required<Prices>;
  capMicrocents: number;
  /** ssh: host alias and the evaluation runner script on it. */
  sshTarget?: string;
  remoteScript?: string;
}

interface Ledger {
  capMicrocents: number;
  cells: Record<string, { spentMicrocents: number; stopped: string | null; calls: number; finishedAt: string }>;
  interrupted: Array<{ cellId: string; countedMicrocents: number; at: string; events: string }>;
  totalMicrocents: number;
}

const readJson = <T>(f: string, d: T): T => { try { return JSON.parse(fs.readFileSync(f, "utf8")) as T; } catch { return d; } };

/** Durable evaluation state is never guessed: absent → the default; present but unreadable or not JSON → refuse. */
export class EvalStateError extends Error {}
function readJsonStrict<T>(f: string, d: T, what: string): T {
  let text: string;
  try {
    text = fs.readFileSync(f, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return d;
    throw new EvalStateError(`F1EVAL_STATE_AMBIGUOUS: ${what} cannot be read`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new EvalStateError(`F1EVAL_STATE_AMBIGUOUS: ${what} is not valid JSON`);
  }
}
/** Durable write: temp file, fsync, rename. */
function writeDurable(f: string, v: unknown): void {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o644);
  fs.writeSync(fd, typeof v === "string" ? v : JSON.stringify(v, null, 1));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, f);
}

function total(l: Ledger): number {
  return Object.values(l.cells).reduce((n, c) => n + c.spentMicrocents, 0) + l.interrupted.reduce((n, i) => n + i.countedMicrocents, 0);
}

/** Conservative spend of an interrupted cell from its event log. */
export function interruptedSpend(lines: string[]): number {
  const started = new Map<string, number>();
  let n = 0;
  for (const line of lines) {
    let e: Record<string, unknown>;
    try { e = JSON.parse(line); } catch { continue; }
    const key = `${String(e.turn)}.${String(e.step)}`;
    if (e.event === "call_start") started.set(key, Number(e.boundMicrocents) || 0);
    if (e.event === "call_end") { n += Number(e.costMicrocents) || 0; started.delete(key); }
  }
  for (const b of started.values()) n += b;
  return n;
}

type Transport = (payload: Record<string, unknown>, onEvent: (line: string) => void) => Promise<Record<string, unknown>>;

function sshTransport(cfg: EvalConfig): Transport {
  return (payload, onEvent) => new Promise((resolve, reject) => {
    const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ServerAliveInterval=30", cfg.sshTarget!, "sudo", "-n", cfg.remoteScript!], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let result: Record<string, unknown> | null = null;
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 40 * 60_000);
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.startsWith("EVT ")) onEvent(line.slice(4));
        else if (line.startsWith("RESULT ")) result = JSON.parse(line.slice(7));
      }
    });
    child.stderr.on("data", (d: Buffer) => { err += d.toString("utf8").slice(0, 2000); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (result) resolve(result);
      else reject(new Error(`remote runner exit ${code}: ${err.slice(0, 500)}`));
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function fakeTransport(): Transport {
  return async (payload, onEvent) => {
    if (payload.mode === "models") return { mode: "models", models: [{ id: "fake-founder-model", status: 200 }] };
    const result = await runCell(payload.request as CellRequest, new FakeFounderModel(), { log: (e) => onEvent(JSON.stringify(e)) });
    return { mode: "cell", model: "fake-founder-model", effort: payload.effort, result };
  };
}

export async function runPlan(out: string, o: { mandatoryOnly?: boolean; only?: string; rerunInterrupted?: string[]; transport?: Transport; log?: (s: string) => void } = {}): Promise<{ ran: string[]; stoppedAt: string | null; reason: string | null }> {
  const log = o.log ?? ((s: string) => console.log(s));
  if (fs.existsSync(path.join(out, "CLOSED"))) throw new EvalStateError(`F1EVAL_CLOSED: ${out} is a sealed, accepted evaluation; it is never run again`);
  const cfg = readJsonStrict<EvalConfig | null>(path.join(out, "config.json"), null, "config.json");
  if (!cfg) throw new Error(`missing ${out}/config.json`);
  if (!(cfg.capMicrocents > 0 && cfg.capMicrocents <= 300_000_000)) throw new Error("cap must be within the authorised $3.00");
  // One driver at a time, across restarts: an exclusive lock file. A stale lock (dead driver) is the operator's call.
  const lockFile = path.join(out, "run.lock");
  let lockFd: number;
  try {
    lockFd = fs.openSync(lockFile, "wx", 0o644);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new EvalStateError(`F1EVAL_LOCKED: ${lockFile} exists — another driver is running, or one died; inspect its events and remove the lock deliberately`);
    }
    throw e;
  }
  fs.writeSync(lockFd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  fs.fsyncSync(lockFd);
  fs.closeSync(lockFd);
  try {
    return await runLocked(out, cfg, o, log);
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
}

async function runLocked(out: string, cfg: EvalConfig, o: { mandatoryOnly?: boolean; only?: string; rerunInterrupted?: string[]; transport?: Transport },
  log: (s: string) => void): Promise<{ ran: string[]; stoppedAt: string | null; reason: string | null }> {
  const transport = o.transport ?? (cfg.transport === "ssh" ? sshTransport(cfg) : fakeTransport());
  const ledgerFile = path.join(out, "ledger.json");
  const done = (id: string) => fs.existsSync(path.join(out, "cells", `${id}.json`));
  const priorWork = PLAN.some((p) => done(p.cellId)) || (fs.existsSync(path.join(out, "events")) && fs.readdirSync(path.join(out, "events")).length > 0);
  const stored = readJsonStrict<Ledger | null>(ledgerFile, null, "ledger.json");
  if (!stored && priorWork) throw new EvalStateError("F1EVAL_STATE_AMBIGUOUS: results or events exist but ledger.json does not: spend on record would be lost");
  const ledger: Ledger = stored ?? { capMicrocents: cfg.capMicrocents, cells: {}, interrupted: [], totalMicrocents: 0 };
  if (typeof ledger.cells !== "object" || ledger.cells === null || !Array.isArray(ledger.interrupted)) throw new EvalStateError("F1EVAL_STATE_AMBIGUOUS: ledger.json has an unexpected shape");
  if (ledger.capMicrocents !== cfg.capMicrocents) throw new EvalStateError(`F1EVAL_STATE_AMBIGUOUS: ledger cap ${ledger.capMicrocents} differs from config cap ${cfg.capMicrocents}`);
  if (ledger.totalMicrocents !== total(ledger)) throw new EvalStateError(`F1EVAL_STATE_AMBIGUOUS: ledger total ${ledger.totalMicrocents} does not match its entries (${total(ledger)})`);
  // A crash between the result write and the ledger write: the durable result carries the exact spend.
  for (const p of PLAN) {
    if (!done(p.cellId) || ledger.cells[p.cellId]) continue;
    const r = readJsonStrict<CellResult | null>(path.join(out, "cells", `${p.cellId}.json`), null, `cells/${p.cellId}.json`);
    if (!r || !Number.isSafeInteger(r.spentMicrocents) || r.spentMicrocents < 0 || !Array.isArray(r.calls)) {
      throw new EvalStateError(`F1EVAL_STATE_AMBIGUOUS: cells/${p.cellId}.json has no usable spend`);
    }
    ledger.cells[p.cellId] = { spentMicrocents: r.spentMicrocents, stopped: r.stopped ?? null, calls: r.calls.length, finishedAt: r.finishedAt };
    ledger.totalMicrocents = total(ledger);
    writeDurable(ledgerFile, ledger);
    log(`${p.cellId}: completed result missing from the ledger; reconciled ${r.spentMicrocents} µ¢ from the durable result`);
  }
  const ran: string[] = [];
  const avgCost = (phase: string) => {
    const xs = PLAN.filter((p) => p.phase === phase && ledger.cells[p.cellId]).map((p) => ledger.cells[p.cellId].spentMicrocents);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  };
  for (const cell of PLAN) {
    if (o.only && cell.cellId !== o.only) continue;
    if (o.mandatoryOnly && !cell.mandatory) continue;
    if (done(cell.cellId)) continue;
    if (cell.from && !done(cell.from)) { log(`skip ${cell.cellId}: input ${cell.from} not complete`); continue; }
    const evFile = path.join(out, "events", `${cell.cellId}.jsonl`);
    if (fs.existsSync(evFile)) {
      const lines = fs.readFileSync(evFile, "utf8").split("\n").filter(Boolean);
      const counted = interruptedSpend(lines);
      const moved = `${evFile.replace(/\.jsonl$/, "")}.interrupted-${ledger.interrupted.length + 1}.jsonl`;
      fs.renameSync(evFile, moved);
      ledger.interrupted.push({ cellId: cell.cellId, countedMicrocents: counted, at: new Date().toISOString(), events: path.basename(moved) });
      ledger.totalMicrocents = total(ledger);
      writeDurable(ledgerFile, ledger);
      log(`${cell.cellId}: previous attempt interrupted; counted ${counted} µ¢ conservatively`);
    }
    // Rerunning an interrupted cell repeats billable calls: only when the operator names it for this invocation.
    if (ledger.interrupted.some((i) => i.cellId === cell.cellId) && !(o.rerunInterrupted ?? []).includes(cell.cellId)) {
      return { ran, stoppedAt: cell.cellId, reason: `interrupted: rerun only with --rerun-interrupted ${cell.cellId}` };
    }
    const remaining = cfg.capMicrocents - total(ledger);
    // One more call's worst case: the largest bound observed so far (falls back to a 60 KB request). The runner's
    // per-call guard stays the hard limit; this only decides whether an optional cell is worth starting.
    const observed = PLAN.flatMap((p) => readJsonStrict<CellResult | null>(path.join(out, "cells", `${p.cellId}.json`), null, `cells/${p.cellId}.json`)?.calls ?? []).map((c) => c.boundMicrocents);
    const oneCall = observed.length ? Math.max(...observed)
      : (60_000 + 2_000) * Math.max(cfg.prices.inputMicrocentsPerToken, cfg.prices.cacheWriteMicrocentsPerToken ?? 0) + cfg.maxTokens * cfg.prices.outputMicrocentsPerToken;
    if (!cell.mandatory && remaining < avgCost(cell.phase) * 1.5 + oneCall) { log(`skip optional ${cell.cellId}: remaining ${remaining} µ¢ is not enough for a complete cell`); continue; }
    if (remaining <= 0) return { ran, stoppedAt: cell.cellId, reason: "budget exhausted" };
    // A severance arm must start from its parent's exact state: missing or unreadable is never "empty".
    const state = cell.from ? readJsonStrict<Snapshot | null>(path.join(out, "state", `${cell.from}.json`), null, `state/${cell.from}.json`) : null;
    if (cell.from && !state) throw new EvalStateError(`F1EVAL_STATE_AMBIGUOUS: state/${cell.from}.json (input of ${cell.cellId}) is missing`);
    const request: CellRequest = {
      cellId: cell.cellId, phase: cell.phase, arm: cell.arm, observations: cell.observations, webVersion: cell.webVersion, state,
      maxSteps: cell.maxSteps, maxTokens: cfg.maxTokens, prices: cfg.prices, budgetMicrocents: remaining,
    };
    log(`${cell.cellId}: start (remaining ${(remaining / 1e8).toFixed(4)} USD)`);
    fs.mkdirSync(path.dirname(evFile), { recursive: true });
    const evFd = fs.openSync(evFile, "a", 0o644);
    let res: Record<string, unknown>;
    try {
      res = await transport({ mode: "cell", model: cfg.model, effort: cfg.effort, request }, (line) => { fs.writeSync(evFd, `${line}\n`); fs.fsyncSync(evFd); });
    } finally {
      fs.closeSync(evFd);
    }
    const result = res.result as CellResult;
    const { snapshot, ...rest } = result;
    writeDurable(path.join(out, "state", `${cell.cellId}.json`), snapshot);
    writeDurable(path.join(out, "cells", `${cell.cellId}.json`), { ...rest, requestedModel: res.model, effort: res.effort, thinking: res.thinking ?? null, maxAttempts: res.maxAttempts ?? null });
    ledger.cells[cell.cellId] = { spentMicrocents: result.spentMicrocents, stopped: result.stopped, calls: result.calls.length, finishedAt: result.finishedAt };
    ledger.totalMicrocents = total(ledger);
    writeDurable(ledgerFile, ledger);
    fs.renameSync(evFile, evFile.replace(/\.jsonl$/, ".done.jsonl"));
    ran.push(cell.cellId);
    log(`${cell.cellId}: ${result.calls.length} calls, ${(result.spentMicrocents / 1e8).toFixed(5)} USD; total ${(ledger.totalMicrocents / 1e8).toFixed(5)} USD${result.stopped ? `; STOPPED ${result.stopped}` : ""}`);
    if (result.stopped) return { ran, stoppedAt: cell.cellId, reason: result.stopped };
  }
  return { ran, stoppedAt: null, reason: null };
}

/** URLs the trunk fetched up to (and including) a cell, following `from`. */
function fetchedBefore(out: string, from: string | null): Set<string> {
  const s = new Set<string>();
  let id = from;
  while (id) {
    const r = readJson<CellResult | null>(path.join(out, "cells", `${id}.json`), null);
    for (const f of r?.fetches ?? []) if (f.found) s.add(f.url);
    id = PLAN.find((p) => p.cellId === id)?.from ?? null;
  }
  return s;
}

export function scorePlan(out: string): ReturnType<typeof scoreCell>[] {
  const scores = [];
  for (const cell of PLAN as readonly PlannedCell[]) {
    const r = readJson<CellResult | null>(path.join(out, "cells", `${cell.cellId}.json`), null);
    if (r) scores.push(scoreCell(r, fetchedBefore(out, cell.from)));
  }
  writeDurable(path.join(out, "scores.json"), scores);
  return scores;
}

async function cli(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = (k: string) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
  const out = arg("--out");
  if (!out) { console.error("--out <dir> required"); return 2; }
  if (cmd === "run") {
    const rerun = rest.flatMap((k, i) => (k === "--rerun-interrupted" && rest[i + 1] ? [rest[i + 1]] : []));
    const r = await runPlan(out, { mandatoryOnly: rest.includes("--mandatory-only"), only: arg("--only"), rerunInterrupted: rerun });
    console.log(JSON.stringify(r));
    return r.reason && r.reason !== "budget exhausted" ? 1 : 0;
  }
  if (cmd === "models") {
    const cfg = readJson<EvalConfig>(path.join(out, "config.json"), null as never);
    const r = await (cfg.transport === "ssh" ? sshTransport(cfg) : fakeTransport())({ mode: "models", ids: ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5"] }, () => undefined);
    writeDurable(path.join(out, "models.json"), r);
    console.log(JSON.stringify(r, null, 1));
    return 0;
  }
  if (cmd === "score") {
    for (const s of scorePlan(out)) console.log(`${s.cellId.padEnd(8)} ${s.arm.padEnd(5)} markers ${s.hitCount}/${s.markerCount} calls ${s.calls} in ${s.inputTokens} out ${s.outputTokens} first-in ${s.firstCallInputTokens} fetch ${s.fetches} dup ${s.duplicateFetches} $${(s.costMicrocents / 1e8).toFixed(4)}`);
    return 0;
  }
  console.error("usage: run|models|score --out <dir>");
  return 2;
}

if (process.argv[1] && /f1-eval-02-driver\.[jt]s$/.test(process.argv[1])) cli().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });

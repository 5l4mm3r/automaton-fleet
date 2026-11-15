/**
 * Loop and duplication economics for a founder runtime (schema v22 phase; new runtimes only).
 *
 * Efficiency control, never commercial-history punishment: it looks only at this runtime's own recent tool calls.
 *   - an identical call (name + canonical arguments) that FAILED is not re-executed while the founder's persistent
 *     state is unchanged; a retry is justified by changed state/evidence, a different method (other arguments), or a
 *     bounded transient-error allowance;
 *   - a page already fetched is not re-fetched within the freshness window: the saved copy and its provenance are
 *     returned (a purpose starting "refresh:" re-fetches deliberately);
 *   - an identical read-only call with unchanged state returns the earlier output instead of re-running it.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { ToolCall } from "../cognition/types.js";
import type { ToolOutcome } from "./toolbox.js";

/**
 * R41.1: what a refused action means — exactly that action, never the founder, its goals or its venture. Appended to the
 * capability refusals and the duplicate-failure guard (the refusals themselves are unchanged). Categories, never a decision.
 */
export const SCOPED_CONTINUE = "This blocks only this one action — not you, your other goals or your venture. Do not retry the identical action. "
  + "Continue another useful path: product improvement, validation, pricing, copy, assets, documentation, channels that need no new account, launch preparation.";
const READ_ONLY = new Set(["read_file", "list_files", "recall_facts", "list_goals", "check_ledger", "read_knowledge"]);
const MUTATING = new Set(["field_journal", "write_file", "remember_fact", "remember_facts", "retract_fact", "record_external_dependency", "withdraw_external_dependency", "open_decision", "resolve_decision", "review_decision", "set_goal", "complete_goal", "exec"]);
/** 2026-10-18: an identical call that has failed this many times in a row is refused even after other successful calls —
 *  a retry after a real fix is allowed, an endless "write something, retry the same failing action" loop is not. */
export const MAX_FAILED_ATTEMPTS = 3;
/** Refusal codes that describe a transient condition (bounded retry allowed). */
const TRANSIENT = /^(RESEARCH_(TIMEOUT|UNAVAILABLE|RATE_LIMITED|UPSTREAM)|FLEET_(RATE_LIMITED|RESEARCH_QUOTA|UNAVAILABLE)|FLEET_TOOL_ERROR)/;

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  return v;
}

export function callKey(call: ToolCall): string {
  return `${call.name}:${crypto.createHash("sha256").update(JSON.stringify(canonical(call.arguments ?? {}))).digest("hex")}`;
}

interface Seen { ok: boolean; refused?: string; output: string; stateVersion: number; attempts: number; at: number; label?: string; repeats?: number; fp?: string; deps?: string[] }

/** Review 2026-10-23 (a genuine fix must permit recovery): the workspace files a call names — its path / paths, and the
 *  file-like words of an exec command — whose state is part of what a refusal depends on. Bounded; never outside. */
export function callDeps(call: ToolCall): string[] {
  const top = (call.arguments ?? {}) as Record<string, unknown>;
  const a = { ...top, ...(top.args && typeof top.args === "object" && !Array.isArray(top.args) ? top.args as Record<string, unknown> : {}) };
  const words = [typeof a.path === "string" ? a.path : "", ...(Array.isArray(a.paths) ? a.paths.filter((x): x is string => typeof x === "string") : []),
    ...(call.name === "exec" && typeof a.command === "string" ? a.command.split(/[\s'"`;|&<>()=]+/).filter((w) => /^[\w./-]+\.[A-Za-z0-9]{1,8}$/.test(w)) : [])];
  return [...new Set(words.map((w) => w.trim().replace(/^\/workspace\/?/, "").replace(/^\.\//, ""))
    .filter((w) => w && w.length <= 200 && !path.isAbsolute(w) && !w.split("/").includes("..")))].slice(0, 10);
}

/** Review 2026-10-23: failed calls are remembered across wakes AND restarts (the founder's own state dir), bounded. */
export const FAILURES_FILE = "loop-guard-failures.json";
export const FAILURES_KEPT = 200;
export const FAILURES_TTL_MS = 24 * 3_600_000;
/** A short, redacted label of a call for the packet: name + its first arguments, never long content. */
export function callLabel(call: ToolCall): string {
  const a = call.arguments ?? {};
  const parts = Object.keys(a).filter((k) => k !== "content" && typeof a[k] !== "object").slice(0, 3).map((k) => `${k}=${String(a[k]).slice(0, 60)}`);
  return `${call.name}${parts.length ? ` ${parts.join(" ")}` : ""}`;
}

/** The state of the workspace files a call names (size and modification time, or absent); "" when it names none. */
export function filesState(workspaceDir: string | undefined, call: ToolCall): string {
  return callDeps(call).map((rel) => {
    if (!workspaceDir) return `${rel}=?`;
    try { const st = fs.lstatSync(path.join(workspaceDir, rel)); return `${rel}=${st.size}:${st.mtimeMs}`; } catch { return `${rel}=absent`; }
  }).join("\n");
}

export class LoopGuard {
  /** Bumped whenever the founder's persistent state changes (a successful mutating call). */
  stateVersion = 0;
  private readonly seen = new Map<string, Seen>();
  private readonly fetched = new Map<string, { at: number; output: string }>();
  readonly stats = { duplicateFailuresBlocked: 0, refetchesAvoided: 0, readOnlyReused: 0 };

  /** What the founder's calls depend on beyond its files: the runtime build, its effective capabilities, its dependencies'
   *  statuses and the office renderer (set at each turn's start). A change here releases the refusals recorded before it. */
  private context = "";
  private readonly preFp = new Map<string, string>();

  constructor(private readonly o: { fetchFreshMs?: number; transientRetries?: number; now?: () => number; stateDir?: string; workspaceDir?: string; runtimeId?: string } = {}) {
    // Remembered failures load with no state version of this process: an identical call is not "unchanged state" (a
    // restart may follow a fix), but one that already failed MAX_FAILED_ATTEMPTS times stays refused until it is older
    // than FAILURES_TTL_MS.
    if (!o.stateDir) return;
    try {
      const rows = JSON.parse(fs.readFileSync(path.join(o.stateDir, FAILURES_FILE), "utf8")) as Array<{ key: string } & Seen>;
      for (const r of Array.isArray(rows) ? rows : []) {
        if (typeof r?.key !== "string" || this.now() - Number(r.at) > FAILURES_TTL_MS) continue;
        this.seen.set(r.key, { ok: false, refused: typeof r.refused === "string" ? r.refused : undefined, output: String(r.output ?? "").slice(0, 300),
          stateVersion: -1, attempts: Number.isSafeInteger(r.attempts) ? r.attempts : 1, at: Number(r.at), label: typeof r.label === "string" ? r.label : undefined,
          repeats: Number.isSafeInteger(r.repeats) ? r.repeats : 0, fp: typeof r.fp === "string" ? r.fp : undefined,
          deps: Array.isArray(r.deps) ? r.deps.filter((x): x is string => typeof x === "string").slice(0, 10) : undefined });
      }
    } catch { /* none yet, or unreadable: start empty */ }
  }

  /** The founder's context for this turn (see `context`). */
  setContext(signals: string): void {
    this.context = signals;
  }

  /** The state a refusal depends on: the context and every file the call names (size + modification time, or absent). */
  private fingerprint(deps: string[]): string {
    const files = deps.map((rel) => {
      if (!this.o.workspaceDir) return `${rel}=?`;
      try { const st = fs.lstatSync(path.join(this.o.workspaceDir, rel)); return `${rel}=${st.size}:${st.mtimeMs}`; } catch { return `${rel}=absent`; }
    });
    return crypto.createHash("sha256").update([this.o.runtimeId ?? "", this.context, ...files].join("\n")).digest("hex").slice(0, 24);
  }

  /** A remembered failure whose files, capabilities or runtime have changed since it failed no longer applies. */
  private stale(v: Seen, fp?: string): boolean {
    return v.fp !== undefined && (fp ?? this.fingerprint(v.deps ?? [])) !== v.fp;
  }

  /** The calls tried MAX_FAILED_ATTEMPTS+ times without success (executed or repeated) whose state is unchanged since:
   *  for the packet, newest first. */
  blocked(limit = 5): Array<{ label: string; refused: string; reason: string }> {
    return [...this.seen.values()].filter((v) => !v.ok && v.attempts + (v.repeats ?? 0) >= MAX_FAILED_ATTEMPTS && v.label && !(v.refused && TRANSIENT.test(v.refused)) && !this.stale(v))
      .sort((a, b) => b.at - a.at).slice(0, limit).map((v) => ({ label: v.label!, refused: v.refused ?? "error", reason: v.output.replace(/\s+/g, " ").slice(0, 160) }));
  }

  private persist(): void {
    if (!this.o.stateDir) return;
    const rows = [...this.seen.entries()].filter(([, v]) => !v.ok).sort((a, b) => b[1].at - a[1].at).slice(0, FAILURES_KEPT)
      .map(([key, v]) => ({ key, refused: v.refused, output: v.output.slice(0, 300), attempts: v.attempts, at: v.at, label: v.label, repeats: v.repeats, fp: v.fp, deps: v.deps }));
    try {
      const f = path.join(this.o.stateDir, FAILURES_FILE);
      fs.writeFileSync(`${f}.tmp`, JSON.stringify(rows), { mode: 0o600 });
      fs.renameSync(`${f}.tmp`, f);
    } catch { /* best effort: the in-process guard still holds */ }
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /**
   * Something the founder's decisions depend on changed without a mutating tool call: a higher tier answered an
   * escalated question, or the next step runs at a different tier (the consequential-action boundary). An identical
   * call may be justified again.
   */
  noteContextChange(): void {
    this.stateVersion++;
  }

  /** Decide before executing: null = run it; an outcome = answered without re-running. */
  before(call: ToolCall): ToolOutcome | null {
    const key = callKey(call);
    const prev = this.seen.get(key);
    if (call.name === "web_fetch") {
      const url = typeof call.arguments?.url === "string" ? call.arguments.url.trim() : "";
      const purpose = typeof call.arguments?.purpose === "string" ? call.arguments.purpose : "";
      const f = this.fetched.get(url);
      if (f && !purpose.startsWith("refresh:") && this.now() - f.at < (this.o.fetchFreshMs ?? 6 * 3_600_000)) {
        this.stats.refetchesAvoided++;
        return { name: call.name, ok: true, output: `ALREADY FETCHED (not re-fetched; your saved copy and its provenance are below — use read_file for the full page, or a purpose starting "refresh:" if freshness matters)\n${f.output}` };
      }
    }
    // A genuine fix permits recovery: when a file the call names, the founder's capabilities, its dependencies or the runtime
    // changed since the call last failed, the refusal no longer applies and the call runs (its attempts count afresh).
    const fp = this.fingerprint(callDeps(call));
    this.preFp.set(key, fp);
    if (prev && !prev.ok && this.stale(prev, fp)) return null;
    if (prev && !prev.ok && prev.attempts >= MAX_FAILED_ATTEMPTS && !(prev.refused && TRANSIENT.test(prev.refused))) {
      this.stats.duplicateFailuresBlocked++;
      return { name: call.name, ok: false, refused: "FLEET_REPEATED_FAILURE",
        output: `NOT RE-RUN FLEET_REPEATED_FAILURE: this identical call has failed ${prev.attempts} times (${prev.refused ?? "error"}) and nothing it depends on (the files it names, your capabilities, the runtime) has changed since. Read the reason, then fix what it depends on, change the approach (different arguments or another route), or record what blocks it. ${SCOPED_CONTINUE}` };
    }
    // After a restart the remembered failure carries no state version of this process; its fingerprint decides instead —
    // a restart alone changes nothing the call depends on, so it is no reason to run the identical call again.
    if (prev && !prev.ok && (prev.stateVersion === this.stateVersion || (prev.stateVersion === -1 && prev.fp !== undefined))) {
      const transient = !!prev.refused && TRANSIENT.test(prev.refused);
      if (!transient || prev.attempts > (this.o.transientRetries ?? 1)) {
        this.stats.duplicateFailuresBlocked++;
        return { name: call.name, ok: false, refused: "FLEET_DUPLICATE_FAILED_ACTION",
          output: `NOT RE-RUN FLEET_DUPLICATE_FAILED_ACTION: this identical call already failed (${prev.refused ?? "error"}) and nothing it depends on has changed. ${SCOPED_CONTINUE}` };
      }
    }
    if (prev && prev.ok && READ_ONLY.has(call.name) && prev.stateVersion === this.stateVersion) {
      this.stats.readOnlyReused++;
      return { name: call.name, ok: true, output: `[unchanged since your identical call earlier]\n${prev.output}` };
    }
    return null;
  }

  /** A repeat refused by before(): counted (and remembered) apart from executed failures — it names the call in the
   *  packet; only executed failures reach FLEET_REPEATED_FAILURE, so one retry after a real change stays possible. */
  noteBlocked(call: ToolCall): void {
    const prev = this.seen.get(callKey(call));
    if (!prev || prev.ok) return;
    prev.repeats = (prev.repeats ?? 0) + 1; prev.at = this.now(); prev.label ??= callLabel(call);
    this.persist();
  }

  /** Record what happened. */
  after(call: ToolCall, out: ToolOutcome, changedState?: boolean): void {
    const key = callKey(call);
    const prev = this.seen.get(key);
    // 2026-10-18: the toolbox says whether the call changed state — any successful call that is not a read, including
    // changes recorded on the controller (a capability check, a review, an offer edit). Without that, a retry after a
    // fixed precondition was refused as "nothing changed". The local-only list remains the fallback.
    if (changedState ?? (out.ok && MUTATING.has(call.name))) this.stateVersion++;
    // The failure history continues only while what the call depends on is unchanged (a fix starts it afresh). The
    // fingerprint kept is the state AFTER this attempt, so a failing call that rewrites its own output is still a repeat.
    const pre = this.preFp.get(key); this.preFp.delete(key);
    const continues = !!prev && !prev.ok && !out.ok && !(pre !== undefined && this.stale(prev, pre));
    const deps = callDeps(call);
    this.seen.set(key, { ok: out.ok, refused: out.refused, output: out.output.slice(0, 8_000), stateVersion: this.stateVersion, attempts: (continues ? prev!.attempts : 0) + 1, at: this.now(),
      ...(!out.ok ? { label: callLabel(call), repeats: continues ? prev!.repeats ?? 0 : 0, fp: this.fingerprint(deps), deps } : {}) });
    if (!out.ok || (prev && !prev.ok)) this.persist();
    if (call.name === "web_fetch" && out.ok && typeof call.arguments?.url === "string") this.fetched.set(call.arguments.url.trim(), { at: this.now(), output: out.output.slice(0, 3_000) });
  }
}

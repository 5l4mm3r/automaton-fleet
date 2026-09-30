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
import type { ToolCall } from "../cognition/types.js";
import type { ToolOutcome } from "./toolbox.js";

const READ_ONLY = new Set(["read_file", "list_files", "recall_facts", "list_goals", "check_ledger", "read_knowledge"]);
const MUTATING = new Set(["write_file", "remember_fact", "set_goal", "complete_goal", "exec"]);
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

interface Seen { ok: boolean; refused?: string; output: string; stateVersion: number; attempts: number; at: number }

export class LoopGuard {
  /** Bumped whenever the founder's persistent state changes (a successful mutating call). */
  stateVersion = 0;
  private readonly seen = new Map<string, Seen>();
  private readonly fetched = new Map<string, { at: number; output: string }>();
  readonly stats = { duplicateFailuresBlocked: 0, refetchesAvoided: 0, readOnlyReused: 0 };

  constructor(private readonly o: { fetchFreshMs?: number; transientRetries?: number; now?: () => number } = {}) {}

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
    if (prev && !prev.ok && prev.stateVersion === this.stateVersion) {
      const transient = !!prev.refused && TRANSIENT.test(prev.refused);
      if (!transient || prev.attempts > (this.o.transientRetries ?? 1)) {
        this.stats.duplicateFailuresBlocked++;
        return { name: call.name, ok: false, refused: "FLEET_DUPLICATE_FAILED_ACTION",
          output: `NOT RE-RUN FLEET_DUPLICATE_FAILED_ACTION: this identical call already failed (${prev.refused ?? "error"}) and nothing it depends on has changed. Change the inputs or method, or gather new evidence first.` };
      }
    }
    if (prev && prev.ok && READ_ONLY.has(call.name) && prev.stateVersion === this.stateVersion) {
      this.stats.readOnlyReused++;
      return { name: call.name, ok: true, output: `[unchanged since your identical call earlier]\n${prev.output}` };
    }
    return null;
  }

  /** Record what happened. */
  after(call: ToolCall, out: ToolOutcome): void {
    const key = callKey(call);
    const prev = this.seen.get(key);
    if (out.ok && MUTATING.has(call.name)) this.stateVersion++;
    this.seen.set(key, { ok: out.ok, refused: out.refused, output: out.output.slice(0, 8_000), stateVersion: this.stateVersion, attempts: (prev && !prev.ok && !out.ok ? prev.attempts : 0) + 1, at: this.now() });
    if (call.name === "web_fetch" && out.ok && typeof call.arguments?.url === "string") this.fetched.set(call.arguments.url.trim(), { at: this.now(), output: out.output.slice(0, 3_000) });
  }
}

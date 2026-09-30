/**
 * Explicit task classification for a routed founder runtime (R23).
 *
 * Every unit of work the mind does is classified BEFORE it is done, from what the work IS — never from how the
 * founder has fared commercially (no balance, profit, loss or win-rate is an input here, and FleetController's router
 * would refuse such a field anyway):
 *
 *   T0  deterministic   a tool answers it exactly (ledger, goals, facts, files, policy checks): no inference is bought
 *   T1  routine         one bounded chore over provided material (extract / classify / summarise / triage / format)
 *   T2  standard        an ordinary step of the founder's own autonomous work (the default)
 *   T3  critical        one escalated question, or a step whose output is a consequential action (major spend,
 *                       reproduction request) — forced by the action boundary, whatever the founder would prefer
 *
 * The classification is only a REQUEST: FleetController's router decides the tier from the same task properties and
 * its record — not this label — is what the consequential-action boundary trusts. `expectedTier` is what the
 * founder anticipates, used for its own bookkeeping (e.g. never handing one model's signed thinking to another).
 */

import { ACTION_MIN_TIER, ESCALATION_REASONS, TASK_CLASSES, maxTier, type EscalationReason, type Tier } from "../cognition/router.js";
import { ROUTINE_TASK_CLASSES } from "../cognition/types.js";

/** Tools whose answer is exact software output: the work they do is T0 (the class names are the router's). */
export const DETERMINISTIC_TOOLS: Readonly<Record<string, string>> = Object.freeze({
  check_ledger: "ledger_calculation",
  list_goals: "database_query",
  recall_facts: "database_query",
  read_knowledge: "database_query",
  read_file: "database_query",
  list_files: "database_query",
  sleep: "state_transition",
});

/** The ordinary step class of a founder's own multistep work. */
export const DEFAULT_STEP_CLASS = "agent_step";

export type TaskDescriptor =
  | { kind: "tool"; tool: string }
  | { kind: "routine"; taskClass: string }
  | { kind: "step"; actionClass?: string }
  | { kind: "question"; reasonCode: string; parentRequestId?: string };

export interface TaskClassification {
  tier: Tier;
  /** deterministic = answered by software, no inference call at all. */
  kind: "deterministic" | "inference";
  taskClass: string;
  /** The routing request to send with the inference call (absent for deterministic work). */
  route?: { taskClass: string; taskId?: string; actionClass?: string; escalation?: { reasonCode: EscalationReason; requestedTier: Tier; parentRequestId?: string } };
  why: string;
}

export class TaskClassificationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function isRoutineClass(c: unknown): c is string {
  return typeof c === "string" && ROUTINE_TASK_CLASSES.includes(c) && TASK_CLASSES[c]?.minTier === "T1";
}

export function isEscalationReason(r: unknown): r is EscalationReason {
  return typeof r === "string" && (ESCALATION_REASONS as readonly string[]).includes(r);
}

/** Classify one unit of work. `taskId` is correlation only and never influences the tier. */
export function classifyTask(t: TaskDescriptor, taskId?: string): TaskClassification {
  const id = taskId ? { taskId } : {};
  switch (t.kind) {
    case "tool": {
      const cls = DETERMINISTIC_TOOLS[t.tool];
      if (cls) return { tier: "T0", kind: "deterministic", taskClass: cls, why: `${t.tool} is answered exactly by software` };
      // A tool that acts (write, exec, fetch, request) is part of the step that asked for it: no separate inference.
      return { tier: "T0", kind: "deterministic", taskClass: "state_transition", why: `${t.tool} executes a decision already made` };
    }
    case "routine": {
      if (!isRoutineClass(t.taskClass)) throw new TaskClassificationError("FLEET_ROUTE_UNKNOWN_CLASS", "not a routine task class");
      return { tier: "T1", kind: "inference", taskClass: t.taskClass, route: { taskClass: t.taskClass, ...id }, why: "one bounded routine chore over provided material" };
    }
    case "step": {
      const spec = TASK_CLASSES[DEFAULT_STEP_CLASS];
      if (t.actionClass !== undefined && !Object.prototype.hasOwnProperty.call(ACTION_MIN_TIER, t.actionClass)) {
        throw new TaskClassificationError("FLEET_ROUTE_INVALID", "unknown action class");
      }
      const tier = t.actionClass ? maxTier(spec.minTier, ACTION_MIN_TIER[t.actionClass]) : spec.minTier;
      return {
        tier, kind: "inference", taskClass: DEFAULT_STEP_CLASS,
        route: { taskClass: DEFAULT_STEP_CLASS, ...id, ...(t.actionClass ? { actionClass: t.actionClass } : {}) },
        why: t.actionClass ? `the step's output is a ${t.actionClass}: minimum ${ACTION_MIN_TIER[t.actionClass]}` : "ordinary autonomous step",
      };
    }
    case "question": {
      if (!isEscalationReason(t.reasonCode)) throw new TaskClassificationError("FLEET_ROUTE_ESCALATION_REFUSED", "escalation needs a recognised reason code");
      if (t.reasonCode === "LOWER_TIER_INSUFFICIENT" && !t.parentRequestId) {
        throw new TaskClassificationError("FLEET_ROUTE_ESCALATION_REFUSED", "LOWER_TIER_INSUFFICIENT requires the lower-tier parent request");
      }
      // Sent under the ordinary step class with a structured escalation: the router grants one question-scoped call.
      return {
        tier: "T3", kind: "inference", taskClass: DEFAULT_STEP_CLASS,
        route: { taskClass: DEFAULT_STEP_CLASS, ...id, escalation: { reasonCode: t.reasonCode, requestedTier: "T3", ...(t.parentRequestId ? { parentRequestId: t.parentRequestId } : {}) } },
        why: `one question escalated (${t.reasonCode}); the task itself stays at its own tier`,
      };
    }
  }
}

/**
 * Cognition Router (schema v22): which capability tier does THIS task need to be done reliably?
 *
 * Pure and deterministic. Its only inputs are the task class, a structured escalation request and the consequential
 * action the output may lead to. It never sees — and refuses to be given — an agent's wealth, profit, loss,
 * opportunity count or any other commercial history: cognition is routed by task, capital is allocated by proposal
 * (a separate system). Tier semantics are stable; which model serves a tier is policy data (fleet_cognition_tiers).
 *
 *   T0 deterministic software (no inference)   T1 routine   T2 standard autonomous work   T3 critical
 *
 * Rules:
 *   - every task class has a deterministic [minTier, maxTier]; T0 classes are never sent to a model;
 *   - a founder may REQUEST escalation with a closed reason code; FleetController decides, capped at maxTier;
 *   - the consequential-action class can FORCE a higher minimum whatever the founder asked for;
 *   - an escalation is question-scoped: it routes one call (a decision packet), never the rest of the task;
 *   - no downgrade below the minimum for budget reasons: an unavailable tier refuses, it never runs cheaper.
 */

import crypto from "crypto";

export type Tier = "T0" | "T1" | "T2" | "T3";
export const TIER_ORDER: readonly Tier[] = ["T0", "T1", "T2", "T3"];
const rank = (t: Tier) => TIER_ORDER.indexOf(t);
export const maxTier = (a: Tier, b: Tier): Tier => (rank(a) >= rank(b) ? a : b);
export const tierAtLeast = (t: Tier, min: Tier) => rank(t) >= rank(min);

export interface TaskClassSpec { minTier: Tier; maxTier: Tier; description: string; /** T3 only: the task itself warrants deeper reasoning (effort high). */ deep?: true }

/** Deterministic task-class table (semantics; constitutional to the router, not model names). */
export const TASK_CLASSES: Readonly<Record<string, TaskClassSpec>> = Object.freeze({
  // T0 — software answers these exactly: never buy probabilistic cognition for them.
  ledger_calculation: { minTier: "T0", maxTier: "T0", description: "arithmetic / ledger balances" },
  fx_application: { minTier: "T0", maxTier: "T0", description: "apply an authoritative FX rate" },
  hashing: { minTier: "T0", maxTier: "T0", description: "digests and identifiers" },
  timestamp: { minTier: "T0", maxTier: "T0", description: "times, dates, schedules" },
  quota_check: { minTier: "T0", maxTier: "T0", description: "quotas and rate limits" },
  policy_check: { minTier: "T0", maxTier: "T0", description: "known policy rules and thresholds" },
  state_transition: { minTier: "T0", maxTier: "T0", description: "lifecycle / state machines" },
  database_query: { minTier: "T0", maxTier: "T0", description: "exact lookups" },
  exact_dedupe: { minTier: "T0", maxTier: "T0", description: "deduplication by deterministic identifiers" },
  exact_filter: { minTier: "T0", maxTier: "T0", description: "exact filtering and validation rules" },
  health_check: { minTier: "T0", maxTier: "T0", description: "liveness and health" },
  // T1 — routine, bounded, low-ambiguity cognition.
  extraction: { minTier: "T1", maxTier: "T2", description: "entity / fact extraction" },
  classification: { minTier: "T1", maxTier: "T2", description: "classification and tagging" },
  basic_summary: { minTier: "T1", maxTier: "T2", description: "basic summarisation of provided text" },
  research_triage: { minTier: "T1", maxTier: "T2", description: "research-result triage" },
  page_interpretation: { minTier: "T1", maxTier: "T2", description: "interpret one fetched page" },
  formatting: { minTier: "T1", maxTier: "T2", description: "formatting and simple rewriting" },
  knowledge_tagging: { minTier: "T1", maxTier: "T2", description: "knowledge tagging" },
  query_formulation: { minTier: "T1", maxTier: "T2", description: "search/query formulation" },
  simple_comparison: { minTier: "T1", maxTier: "T2", description: "simple comparisons" },
  semantic_dedupe: { minTier: "T1", maxTier: "T2", description: "near-duplicate screening" },
  tool_result_interpretation: { minTier: "T1", maxTier: "T2", description: "routine tool-result interpretation" },
  // T2 — standard autonomous economic work (the default reasoning engine).
  agent_step: { minTier: "T2", maxTier: "T3", description: "multistep autonomous tool use (default)" },
  opportunity_research: { minTier: "T2", maxTier: "T3", description: "opportunity research" },
  evidence_synthesis: { minTier: "T2", maxTier: "T3", description: "evidence synthesis" },
  market_comparison: { minTier: "T2", maxTier: "T3", description: "market comparison" },
  hypothesis_generation: { minTier: "T2", maxTier: "T3", description: "hypothesis generation" },
  validation_design: { minTier: "T2", maxTier: "T3", description: "validation design" },
  product_construction: { minTier: "T2", maxTier: "T3", description: "product/service construction and coding" },
  content_generation: { minTier: "T2", maxTier: "T3", description: "content/product generation" },
  experiment_interpretation: { minTier: "T2", maxTier: "T3", description: "experiment interpretation" },
  strategy_preparation: { minTier: "T2", maxTier: "T3", description: "strategy preparation" },
  capital_request_preparation: { minTier: "T2", maxTier: "T3", description: "capital-request preparation" },
  // T3 — critical.
  evidence_conflict_resolution: { minTier: "T3", maxTier: "T3", deep: true, description: "conflicting high-quality evidence" },
  failure_diagnosis: { minTier: "T3", maxTier: "T3", deep: true, description: "difficult failure diagnosis" },
  strategic_pivot: { minTier: "T3", maxTier: "T3", description: "materially consequential strategic pivot" },
  irreversible_decision: { minTier: "T3", maxTier: "T3", description: "significant irreversible decision" },
  major_capital_proposal: { minTier: "T3", maxTier: "T3", description: "major capital proposal" },
  novel_uncertainty: { minTier: "T3", maxTier: "T3", description: "unusually novel / high-uncertainty problem" },
  legal_compliance: { minTier: "T3", maxTier: "T3", description: "consequential legal/compliance reasoning" },
  security_critical: { minTier: "T3", maxTier: "T3", deep: true, description: "security-critical reasoning" },
  reproduction_recommendation: { minTier: "T3", maxTier: "T3", description: "reproduction recommendation" },
  constitutional_reasoning: { minTier: "T3", maxTier: "T3", deep: true, description: "constitutional/security-critical reasoning" },
});

export const ESCALATION_REASONS = Object.freeze([
  "EVIDENCE_CONFLICT", "HIGH_CONSEQUENCE", "IRREVERSIBLE_ACTION", "NOVEL_UNCERTAINTY",
  "LOWER_TIER_INSUFFICIENT", "SECURITY_CRITICAL", "LEGAL_COMPLIANCE_CRITICAL", "REPRODUCTION_DECISION",
] as const);
export type EscalationReason = (typeof ESCALATION_REASONS)[number];

/**
 * Consequential actions and the minimum tier of the cognition that produced them (mirrors the v22 seed of
 * fleet_action_min_tier, which the database enforces). Thresholds are economic policy: owner-set in the database.
 */
export const ACTION_MIN_TIER: Readonly<Record<string, Tier>> = Object.freeze({
  spend_request: "T2",
  major_spend_request: "T3",
  knowledge_policy_proposal: "T2",
  reproduction_request: "T3",
});

export interface RouteRequest {
  taskClass: string;
  /** Opaque task correlation id (observability only; never influences the tier). */
  taskId?: string;
  escalation?: { reasonCode: string; requestedTier: Tier; parentRequestId?: string };
  /** The consequential action this output may directly lead to (router-forced minimum). */
  actionClass?: string;
}

export interface RouteDecision {
  tier: Tier;
  taskClass: string;
  minTier: Tier;
  maxTier: Tier;
  /** deterministic = no inference at all (T0). */
  kind: "deterministic" | "inference";
  source: "class_minimum" | "escalation" | "action_boundary";
  requestedTier: Tier | null;
  escalationReason: EscalationReason | null;
  /** Escalations route exactly one question; the next call routes by its own class again. */
  scope: "task_step" | "question";
  /** Per-decision effort override: "high" only for T3 when the task itself warrants it; otherwise the tier's own setting. */
  effort: "high" | null;
  reasons: string[];
}

const DEEP_REASONS: ReadonlySet<string> = new Set(["EVIDENCE_CONFLICT", "SECURITY_CRITICAL"]);

export class RouteError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const ALLOWED_KEYS = new Set(["taskClass", "taskId", "escalation", "actionClass"]);
const ALLOWED_ESCALATION_KEYS = new Set(["reasonCode", "requestedTier", "parentRequestId"]);
const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Parse an untrusted route request. Unknown keys are REFUSED (not ignored), so nothing but the task — in particular
 * no commercial history (wealth, profit, loss, opportunity count, win rate) — can ever reach the routing decision.
 */
export function parseRouteRequest(raw: unknown): RouteRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RouteError("FLEET_ROUTE_INVALID", "route must be an object");
  const x = raw as Record<string, unknown>;
  for (const k of Object.keys(x)) if (!ALLOWED_KEYS.has(k)) throw new RouteError("FLEET_ROUTE_INPUT_REFUSED", `route field "${k.slice(0, 40)}" is not a task property`);
  if (typeof x.taskClass !== "string" || !Object.prototype.hasOwnProperty.call(TASK_CLASSES, x.taskClass)) throw new RouteError("FLEET_ROUTE_UNKNOWN_CLASS", "unknown task class");
  const out: RouteRequest = { taskClass: x.taskClass };
  if (x.taskId !== undefined) {
    if (typeof x.taskId !== "string" || !/^[A-Za-z0-9:_.-]{1,64}$/.test(x.taskId)) throw new RouteError("FLEET_ROUTE_INVALID", "taskId malformed");
    out.taskId = x.taskId;
  }
  if (x.actionClass !== undefined) {
    if (typeof x.actionClass !== "string" || !Object.prototype.hasOwnProperty.call(ACTION_MIN_TIER, x.actionClass)) throw new RouteError("FLEET_ROUTE_INVALID", "unknown action class");
    out.actionClass = x.actionClass;
  }
  if (x.escalation !== undefined) {
    const e = x.escalation as Record<string, unknown>;
    if (!e || typeof e !== "object" || Array.isArray(e)) throw new RouteError("FLEET_ROUTE_INVALID", "escalation must be an object");
    for (const k of Object.keys(e)) if (!ALLOWED_ESCALATION_KEYS.has(k)) throw new RouteError("FLEET_ROUTE_INPUT_REFUSED", `escalation field "${k.slice(0, 40)}" is not allowed`);
    if (typeof e.reasonCode !== "string" || !(ESCALATION_REASONS as readonly string[]).includes(e.reasonCode)) throw new RouteError("FLEET_ROUTE_ESCALATION_REFUSED", "escalation needs a recognised reason code");
    if (typeof e.requestedTier !== "string" || !(TIER_ORDER as readonly string[]).includes(e.requestedTier) || e.requestedTier === "T0") throw new RouteError("FLEET_ROUTE_INVALID", "requestedTier must be T1..T3");
    if (e.parentRequestId !== undefined && (typeof e.parentRequestId !== "string" || !UUIDISH.test(e.parentRequestId))) throw new RouteError("FLEET_ROUTE_INVALID", "parentRequestId must be a request id");
    out.escalation = { reasonCode: e.reasonCode, requestedTier: e.requestedTier as Tier, ...(typeof e.parentRequestId === "string" ? { parentRequestId: e.parentRequestId } : {}) };
  }
  return out;
}

/** The routing decision. Deterministic function of (task class, escalation request, action class) only. */
export function route(req: RouteRequest): RouteDecision {
  const spec = TASK_CLASSES[req.taskClass];
  if (!spec) throw new RouteError("FLEET_ROUTE_UNKNOWN_CLASS", "unknown task class");
  const base: RouteDecision = {
    tier: spec.minTier, taskClass: req.taskClass, minTier: spec.minTier, maxTier: spec.maxTier, kind: spec.minTier === "T0" ? "deterministic" : "inference",
    source: "class_minimum", requestedTier: null, escalationReason: null, scope: "task_step", effort: null, reasons: [`class ${req.taskClass} minimum ${spec.minTier}`],
  };
  if (spec.minTier === "T0") {
    if (req.escalation) throw new RouteError("FLEET_ROUTE_DETERMINISTIC", "deterministic tasks are answered by software, never escalated to a model");
    return base;
  }
  let tier: Tier = spec.minTier;
  // Consequential-action boundary: the router forces the minimum whatever the founder asked for (it cannot be lowered).
  if (req.actionClass) {
    const floor = ACTION_MIN_TIER[req.actionClass];
    if (!tierAtLeast(tier, floor)) {
      tier = floor;
      base.source = "action_boundary";
      base.reasons.push(`action ${req.actionClass} requires ${floor}`);
    }
  }
  if (req.escalation) {
    const e = req.escalation;
    if (e.reasonCode === "LOWER_TIER_INSUFFICIENT" && !e.parentRequestId) throw new RouteError("FLEET_ROUTE_ESCALATION_REFUSED", "LOWER_TIER_INSUFFICIENT requires the lower-tier parent request");
    base.requestedTier = e.requestedTier;
    base.escalationReason = e.reasonCode as EscalationReason;
    const capped = rank(e.requestedTier) > rank(spec.maxTier) ? spec.maxTier : e.requestedTier;
    if (rank(capped) > rank(tier)) {
      tier = capped;
      base.source = "escalation";
      base.scope = "question";
      base.reasons.push(`escalation ${e.reasonCode} → ${capped}${capped !== e.requestedTier ? ` (capped at class maximum ${spec.maxTier})` : ""}`);
    } else {
      base.reasons.push(`escalation ${e.reasonCode} to ${e.requestedTier} not above ${tier}: no change`);
    }
  }
  if (rank(tier) > rank(maxTier(spec.maxTier, req.actionClass ? ACTION_MIN_TIER[req.actionClass] : spec.maxTier))) tier = spec.maxTier;
  base.tier = tier;
  if (tier === "T3" && (spec.deep || (base.escalationReason && DEEP_REASONS.has(base.escalationReason)))) {
    base.effort = "high";
    base.reasons.push("T3 effort high: the task itself warrants deeper reasoning");
  }
  return base;
}

/** A tier's configured candidate (a row of fleet_cognition_tiers). */
export interface TierCandidate {
  tier: Tier;
  provider: "anthropic";
  model: string;
  thinking: "adaptive" | null;
  effort: "low" | "medium" | "high" | "max" | null;
  maxOutputTokens: number;
  prices: { inputMicrocentsPerToken: number; outputMicrocentsPerToken: number; cacheWriteMicrocentsPerToken: number; cacheReadMicrocentsPerToken: number };
  enabled: boolean;
  verifiedAt: string | null;
}

/** The candidate that serves a decided tier. Never falls to a lower tier: unavailable is a refusal. */
export function candidateFor(tier: Tier, candidates: readonly TierCandidate[]): TierCandidate {
  if (tier === "T0") throw new RouteError("FLEET_ROUTE_DETERMINISTIC", "T0 is deterministic software: no model");
  const c = candidates.find((x) => x.tier === tier);
  if (!c || !c.enabled) throw new RouteError("FLEET_COGNITION_TIER_UNAVAILABLE", `tier ${tier} is not enabled`);
  if (!c.verifiedAt) throw new RouteError("FLEET_COGNITION_TIER_UNVERIFIED", `tier ${tier} has not been verified against the provider account`);
  return c;
}

/**
 * Canonical digest of a consequential action as the model requested it, recomputed identically by the controller
 * from the action request (spend: amount, category, destination). Links an action to the cognition call that produced it.
 */
export function actionDigest(toolName: string, args: Record<string, unknown>): string | null {
  if (toolName !== "request_spend") return null;
  const canonical = JSON.stringify({ amountCents: Number(args.amountCents), category: String(args.category ?? ""), destinationId: String(args.destinationId ?? "") });
  return crypto.createHash("sha256").update(`request_spend:${canonical}`, "utf8").digest("hex");
}

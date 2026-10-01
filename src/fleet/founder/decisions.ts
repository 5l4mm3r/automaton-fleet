/**
 * F2-A decision-driven research (founder side; the founder's own state and judgement, never FleetController's).
 *
 * Research is not browsing. It exists for two reasons only — to FIND a viable niche, product, service or business gap
 * the founder can bridge (`find_opportunity`), or to EXPAND a viable venture (`expand_venture`) — and only for an open
 * ECONOMIC DECISION:  target → evidence → decision → execution → sales → learning → next decision.
 *
 *   open_decision     the question, the founder's hypothesis, an optional short candidate list (≤ 5) and the founder's
 *                     OWN stop condition (at most N fetches, and in words when it will know enough)
 *   web_fetch         (research mode) names the decision, the ONE missing fact, why the answer could change the decision
 *                     and its information value. Refused by the founder's own runtime — never by FleetController — when
 *                     the decision is already made, the value is low, the gap was already gathered, or the founder's own
 *                     stop condition is reached: the answer is always "decide with what you have and execute".
 *   resolve_decision  what was selected, the ranking, what was rejected and why, the expected outcome and the next action;
 *                     the next action becomes an execution goal and research on that question is closed for good.
 *
 * No weights, scores, budgets or runway thresholds live here: how selective to be is the founder's call (it sees its own
 * survival position in each packet). The ledger is the minimal Phase A form of the Decision Record (F2 design §21).
 */

import fs from "fs";
import path from "path";

export const DECISIONS_FILE = "decisions.json";
export const DECISION_PURPOSES = ["find_opportunity", "expand_venture"] as const;
export type DecisionPurpose = (typeof DECISION_PURPOSES)[number];
export const INFORMATION_VALUES = ["high", "medium", "low"] as const;
export const DECISION_LIMITS = Object.freeze({ open: 3, options: 5, maxFetches: 8, decidedKept: 40, rejected: 5, gapsShown: 4 });

export interface ResearchStep { at: string; evidenceGap: string; expectedValue: string; informationValue: "high" | "medium"; url: string; attemptId: string | null }
export interface DecisionOutcome {
  selected: string; ranking: string[]; rejected: Array<{ option: string; reason: string }>; rationale: string; expectedOutcome: string; nextAction: string;
  goalId: string | null; decidedAt: string;
}
export interface Decision {
  key: string; purpose: DecisionPurpose; question: string; hypothesis: string; options: string[]; stop: { maxFetches: number; when: string };
  status: "open" | "decided"; openedAt: string; research: ResearchStep[]; outcome: DecisionOutcome | null;
}

export type DecisionResult = { ok: true; decision: Decision } | { ok: false; code: string; detail: string };

export class DecisionLedgerError extends Error {
  readonly code = "FLEET_DECISIONS_UNREADABLE";
}

const KEY = /^[a-z0-9][a-z0-9_-]{1,47}$/;
const text = (v: unknown, min: number, max: number): string | null => (typeof v === "string" && v.trim().length >= min ? v.trim().slice(0, max) : null);
/** Normalised wording, so the same question or evidence gap is recognised however it is capitalised or punctuated. */
export const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9£$%]+/g, " ").trim();

/** The founder's decisions (absent file = none; an unreadable file is an error, never silently "no decisions"). */
export function loadDecisions(memoryDir: string): Decision[] {
  let raw: string;
  try { raw = fs.readFileSync(path.join(memoryDir, DECISIONS_FILE), "utf8"); } catch { return []; }
  let v: unknown;
  try { v = JSON.parse(raw); } catch { throw new DecisionLedgerError("decisions.json is not valid JSON"); }
  if (!Array.isArray(v)) throw new DecisionLedgerError("decisions.json is not a list");
  return v.filter((d): d is Decision => !!d && typeof d === "object" && typeof (d as Decision).key === "string" && Array.isArray((d as Decision).research));
}

/** Atomic write; bounded: every open decision plus the most recent decided ones. */
export function saveDecisions(memoryDir: string, list: Decision[]): void {
  const open = list.filter((d) => d.status === "open");
  const decided = list.filter((d) => d.status === "decided").sort((a, b) => (a.outcome?.decidedAt ?? "").localeCompare(b.outcome?.decidedAt ?? "")).slice(-DECISION_LIMITS.decidedKept);
  const f = path.join(memoryDir, DECISIONS_FILE);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify([...decided, ...open], null, 2), { mode: 0o600 });
  fs.renameSync(`${f}.tmp`, f);
}

const decidedSummary = (d: Decision) =>
  `${d.key} was decided ${d.outcome?.decidedAt.slice(0, 10) ?? ""}: selected "${d.outcome?.selected ?? ""}"; next action: ${d.outcome?.nextAction ?? ""}. Research on this question is closed — execute it.`;

/** open_decision: a concrete question with a hypothesis and the founder's own stop condition. Mutates `list` on success. */
export function openDecision(list: Decision[], a: Record<string, unknown>, now = new Date()): DecisionResult {
  const key = typeof a.key === "string" ? a.key.trim() : "";
  if (!KEY.test(key)) return { ok: false, code: "FLEET_BAD_REQUEST", detail: "key is a short slug: a-z, 0-9, - or _ (2-48 characters)" };
  if (!DECISION_PURPOSES.includes(a.purpose as DecisionPurpose)) {
    return { ok: false, code: "FLEET_RESEARCH_PURPOSE", detail: "research exists only to find a viable niche, product, service or business gap you can bridge (find_opportunity) or to expand a viable venture (expand_venture)" };
  }
  const question = text(a.question, 10, 400);
  const hypothesis = text(a.hypothesis, 10, 400);
  const when = text(a.stopWhen, 5, 300);
  const maxFetches = Number(a.stopAfterFetches);
  if (!question || !hypothesis || !when || !Number.isSafeInteger(maxFetches) || maxFetches < 1 || maxFetches > DECISION_LIMITS.maxFetches) {
    return { ok: false, code: "FLEET_BAD_REQUEST", detail: `question, hypothesis, stopWhen and stopAfterFetches (1-${DECISION_LIMITS.maxFetches}) are required: research needs a decision, a hypothesis and your own stop condition` };
  }
  const options = Array.isArray(a.options) ? a.options.filter((o): o is string => typeof o === "string" && o.trim().length > 0).map((o) => o.trim().slice(0, 200)) : [];
  if (options.length > DECISION_LIMITS.options) {
    return { ok: false, code: "FLEET_SHORTLIST_TOO_LONG", detail: `a decision compares a short list: at most ${DECISION_LIMITS.options} candidates, the strongest you can name` };
  }
  const same = list.find((d) => d.key === key || normalize(d.question) === normalize(question));
  if (same?.status === "decided") return { ok: false, code: "FLEET_DECISION_ALREADY_MADE", detail: decidedSummary(same) };
  if (same) return { ok: false, code: "FLEET_DECISION_EXISTS", detail: `${same.key} is already open for this question: continue it` };
  if (list.filter((d) => d.status === "open").length >= DECISION_LIMITS.open) {
    return { ok: false, code: "FLEET_TOO_MANY_OPEN_DECISIONS", detail: `at most ${DECISION_LIMITS.open} open decisions: resolve one before opening another (concise, not open-ended)` };
  }
  const decision: Decision = { key, purpose: a.purpose as DecisionPurpose, question, hypothesis, options, stop: { maxFetches, when }, status: "open",
    openedAt: now.toISOString(), research: [], outcome: null };
  list.push(decision);
  return { ok: true, decision };
}

/**
 * Before a research fetch: is it framed, is it still worth it, and is it within the founder's own stop condition?
 * Every refusal says what to do instead — decide, reuse, or name a better question — never "wait".
 */
export function researchCheck(list: Decision[], a: Record<string, unknown>): DecisionResult {
  const key = typeof a.decisionKey === "string" ? a.decisionKey.trim() : "";
  if (!key) {
    return { ok: false, code: "FLEET_RESEARCH_UNFRAMED",
      detail: "research needs an open economic decision: open_decision (question, hypothesis, stop condition) first — or, for an execution step, use mode execution with the step" };
  }
  const d = list.find((x) => x.key === key);
  if (!d) return { ok: false, code: "FLEET_DECISION_UNKNOWN", detail: `no decision ${key}: open_decision first` };
  if (d.status === "decided") return { ok: false, code: "FLEET_DECISION_ALREADY_MADE", detail: decidedSummary(d) };
  const gap = text(a.evidenceGap, 5, 300);
  const value = text(a.expectedValue, 5, 300);
  if (!gap || !value || !INFORMATION_VALUES.includes(a.informationValue as "low")) {
    return { ok: false, code: "FLEET_RESEARCH_UNFRAMED", detail: "name the ONE missing fact (evidenceGap), how its answer could change the decision (expectedValue) and its informationValue (high, medium or low)" };
  }
  if (a.informationValue === "low") {
    return { ok: false, code: "FLEET_LOW_INFORMATION_VALUE",
      detail: "a fact unlikely to change the decision is not worth fetching: decide with what you have (resolve_decision), or name a gap whose answer would change the decision" };
  }
  const prior = d.research.find((r) => normalize(r.evidenceGap) === normalize(gap));
  if (prior) {
    return { ok: false, code: "FLEET_EVIDENCE_ALREADY_GATHERED",
      detail: `already gathered for ${key} (${prior.url}${prior.attemptId ? `, attemptId ${prior.attemptId}` : ""}): reuse it — your saved page and facts hold it` };
  }
  if (d.research.length >= d.stop.maxFetches) {
    return { ok: false, code: "FLEET_DECISION_STOP_REACHED",
      detail: `your own stop condition for ${key} is reached (${d.stop.maxFetches} fetch(es); "${d.stop.when}"): decide now with the evidence you have (resolve_decision). If one more fact would truly change the decision, resolve this one and open a narrower decision` };
  }
  return { ok: true, decision: d };
}

/** Record a completed research fetch against its decision. */
export function noteResearch(list: Decision[], key: string, step: Omit<ResearchStep, "at">, now = new Date()): void {
  const d = list.find((x) => x.key === key && x.status === "open");
  if (d) d.research.push({ ...step, evidenceGap: step.evidenceGap.slice(0, 300), expectedValue: step.expectedValue.slice(0, 300), at: now.toISOString() });
}

/** resolve_decision: select, rank, reject, expect, act. Mutates `list` on success (the caller links the execution goal). */
export function resolveDecision(list: Decision[], a: Record<string, unknown>, now = new Date()): DecisionResult {
  const key = typeof a.key === "string" ? a.key.trim() : "";
  const d = list.find((x) => x.key === key);
  if (!d) return { ok: false, code: "FLEET_DECISION_UNKNOWN", detail: `no decision ${key}` };
  if (d.status === "decided") return { ok: false, code: "FLEET_DECISION_ALREADY_MADE", detail: decidedSummary(d) };
  const selected = text(a.selected, 1, 200);
  const rationale = text(a.rationale, 10, 1000);
  const expectedOutcome = text(a.expectedOutcome, 5, 400);
  const nextAction = text(a.nextAction, 5, 300);
  if (!selected || !rationale || !expectedOutcome || !nextAction) {
    return { ok: false, code: "FLEET_BAD_REQUEST", detail: "selected, rationale, expectedOutcome and nextAction are required: a decision ends in an action" };
  }
  const ranking = Array.isArray(a.ranking) ? a.ranking.filter((o): o is string => typeof o === "string" && o.trim().length > 0).map((o) => o.trim().slice(0, 200)) : [];
  const rejected = Array.isArray(a.rejected)
    ? a.rejected.filter((r): r is { option: string; reason: string } => !!r && typeof r === "object" && typeof (r as { option?: unknown }).option === "string" && typeof (r as { reason?: unknown }).reason === "string")
      .map((r) => ({ option: r.option.trim().slice(0, 200), reason: r.reason.trim().slice(0, 300) }))
    : [];
  if (ranking.length > DECISION_LIMITS.options || rejected.length > DECISION_LIMITS.rejected) {
    return { ok: false, code: "FLEET_SHORTLIST_TOO_LONG", detail: `rank and reject at most ${DECISION_LIMITS.options} candidates: a short, evidence-backed list` };
  }
  d.status = "decided";
  d.outcome = { selected, ranking, rejected, rationale, expectedOutcome, nextAction, goalId: null, decidedAt: now.toISOString() };
  return { ok: true, decision: d };
}

// ─────────────────────────────────────────────── what the founder sees (bounded; its own data)

/** Open decisions first (with what is already gathered), then the most recent decisions (closed to research). */
export function decisionLines(list: Decision[]): string[] {
  const open = list.filter((d) => d.status === "open").slice(0, DECISION_LIMITS.open).map((d) => {
    const gathered = d.research.slice(-DECISION_LIMITS.gapsShown).map((r) => `"${r.evidenceGap.slice(0, 120)}"${r.attemptId ? ` (attemptId ${r.attemptId})` : ""}`);
    return `Open decision ${d.key} (${d.purpose}): "${d.question}" Hypothesis: ${d.hypothesis}${d.options.length ? ` Shortlist: ${d.options.join(" | ")}.` : ""}`
      + ` Research: ${d.research.length}/${d.stop.maxFetches} fetch(es) (your stop: ${d.stop.when})${gathered.length ? `; already gathered: ${gathered.join(", ")}` : ""}.`
      + " Do you know enough to make the next economically meaningful move? If yes, resolve_decision and execute; if no, fetch the ONE highest-value missing fact.";
  });
  const decided = list.filter((d) => d.status === "decided").sort((a, b) => (b.outcome?.decidedAt ?? "").localeCompare(a.outcome?.decidedAt ?? "")).slice(0, 3).map((d) => {
    const o = d.outcome!;
    return `Decided ${d.key}: "${o.selected}"${o.rejected.length ? ` (rejected: ${o.rejected.map((r) => `${r.option} — ${r.reason}`).join("; ")})` : ""}.`
      + ` Next action: ${o.nextAction}${o.goalId ? ` [goal ${o.goalId}]` : ""}. Research on this question is closed: execute.`;
  });
  return [...open, ...decided];
}

/** The founder's survival position as FleetController observes it (absent = an older controller). */
export interface SurvivalView { survivalEquityCents: number; inferenceTodayCents: number; burnPerDayCents: number; runwayDays: number | null }

export function parseSurvival(v: unknown): SurvivalView | null {
  const s = v as Record<string, unknown> | null;
  if (!s || typeof s !== "object" || s.survivalEquityCents === undefined) return null;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : Number(x) || 0);
  return { survivalEquityCents: n(s.survivalEquityCents), inferenceTodayCents: n(s.inferenceTodayCents), burnPerDayCents: n(s.burnPerDayCents),
    runwayDays: s.runwayDays === null || s.runwayDays === undefined ? null : n(s.runwayDays) };
}

/** Information for the founder's own strategy — never a permission, a ration or a deadline. */
export function survivalLine(s: SurvivalView): string {
  return `Your survival position (FleetController's observation; the strategy is yours): survival equity ${s.survivalEquityCents}p; inference ${s.inferenceTodayCents}p today, `
    + `≈ ${s.burnPerDayCents}p/day over 7 days${s.runwayDays !== null ? `; runway ≈ ${Math.round(s.runwayDays)} days at that burn` : ""}.`
    + " The less capital you have, the more selective you are — fewer, higher-value facts, the shortest credible path to revenue, enough kept to execute — never idle, never blind, never activity for its own sake.";
}

export type IdleKind = "decide" | "execute" | "opportunity";

/** What an idle founder's next economically meaningful move is: decide, execute, or find something worth executing. */
export function idleKind(list: Decision[], openGoals: number): IdleKind {
  if (list.some((d) => d.status === "open")) return "decide";
  return openGoals > 0 ? "execute" : "opportunity";
}

/** The concise opportunity-identification cycle (no open decision, no execution path). Not a browsing mandate. */
export const OPPORTUNITY_CYCLE = "Run ONE concise opportunity-identification cycle, not open-ended browsing: open_decision (purpose find_opportunity) with a concrete question, your hypothesis and a stop condition; "
  + "gather purchase evidence — sales velocity, marketplace rankings and bestseller lists, search demand, prices, reviews and complaints, competition — on a few candidates "
  + "(not trends or social feeds: popularity without purchase intent is weak evidence); keep a ranked shortlist of at most 5; select the strongest yourself (resolve_decision) and start executing.";

/** The next-move line of a full packet (an open decision speaks for itself through its own line). */
export function nextMoveLine(kind: IdleKind): string | null {
  if (kind === "execute") {
    return "Your open goals are your execution path: take the next concrete step toward a sale. An unavailable action (an external dependency) blocks only that action — "
      + "use another marketplace, a direct sale that needs no new account, or another product or service.";
  }
  return kind === "opportunity" ? `No open decision and no execution path. ${OPPORTUNITY_CYCLE}` : null;
}

/** The task of an idle wake: one push toward the next economically meaningful move. */
export function idleTask(kind: IdleKind, list: Decision[], goals: Array<{ id: string; title: string }>): string {
  if (kind === "decide") {
    const keys = list.filter((d) => d.status === "open").map((d) => d.key).join(", ");
    return `Idle wake with an unresolved economic decision (${keys}). Do not browse: resolve it now with the evidence you have and move to execution, `
      + "or fetch the ONE missing fact with the highest expected value — within your own stop condition.";
  }
  if (kind === "execute") {
    return `Idle wake: your open goals are your execution path (${goals.slice(0, 3).map((g) => `${g.id} "${g.title.slice(0, 120)}"`).join(", ")}). Take the next concrete step toward a sale. `
      + "An unavailable action (an external dependency) blocks only that action — use another marketplace, a direct sale that needs no new account, or another product or service. "
      + "If no open goal still has a credible path to revenue, complete it with the reason and run one opportunity cycle.";
  }
  return `Idle wake with no open decision and no execution path. ${OPPORTUNITY_CYCLE}`;
}

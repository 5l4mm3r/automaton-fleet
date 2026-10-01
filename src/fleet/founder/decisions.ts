/**
 * F2-A decision-driven research and professional self-governance (founder side; the founder's own state and judgement,
 * never FleetController's).
 *
 * The standard is constant, whatever the runway:  pinpoint → decide → execute → measure → learn → forward.
 * Research exists for two reasons only — to FIND a viable niche, product, service or business gap the founder can bridge
 * (`find_opportunity`), or to EXPAND a viable venture (`expand_venture`) — and only for an open economic decision.
 * A decision answers eight questions; the ledger holds exactly those answers:
 *
 *   1 what am I trying to achieve economically?      objective                     open_decision
 *   2 what do I currently believe?                   hypothesis                    open_decision
 *   3 what critical fact is missing?                 evidenceGap                   web_fetch (research)
 *   4 will that fact materially change the decision? expectedValue, informationValue  web_fetch (research)
 *   5 what is the downside / capital exposure?       capitalAtRiskPence, downside  resolve_decision
 *   6 what evidence would invalidate this path?      invalidatedBy                 resolve_decision
 *   7 when do I stop researching?                    stop (fetches, when)          open_decision
 *   8 what exact action follows?                     selected, nextAction          resolve_decision
 *
 * review_decision is MEASURE → LEARN → FORWARD: what actually happened, what it teaches and the next forward action
 * (the step is closed, the next one opened). A correction is a review whose NEW evidence broke an assumption: it records
 * the previous path and assumption, the evidence, why the path changed, the economic impact and the new forward action.
 * Oscillation is refused: no "correction" to the same path, none without new evidence, no return to an abandoned path,
 * at most three per decision.
 *
 * The founder self-manages its OWN spendable capital: its runtime commits own capital (request_spend) only under a
 * decided decision whose capital at risk the founder sized, and never beyond it (more exposure needs a review on new
 * evidence). FleetController is not asked about any of this; it remains the custody boundary that executes orders and
 * protects treasury, shared, restricted, protected and tax-reserved capital (schema v27: fleet_spend_custody_check —
 * custody only, no owner approval route and no fixed amount). Wallet size and the founder's own track record reach it
 * as information (ownCapitalLine), never as a permission or a score. No weights, scores, budgets, runway thresholds or
 * quota figures live here: ranking and risk appetite are the founder's own judgement. Minimal Phase A form of the
 * Decision Record (§21).
 */

import fs from "fs";
import path from "path";

export const DECISIONS_FILE = "decisions.json";
export const DECISION_PURPOSES = ["find_opportunity", "expand_venture"] as const;
export type DecisionPurpose = (typeof DECISION_PURPOSES)[number];
export const INFORMATION_VALUES = ["high", "medium", "low"] as const;
export const DECISION_LIMITS = Object.freeze({ open: 3, options: 5, maxFetches: 8, decidedKept: 40, rejected: 5, gapsShown: 4, corrections: 3, reviewsKept: 12, evidence: 5 });
export const REVIEW_VERDICTS = ["confirmed", "corrected"] as const;

export interface ResearchStep { at: string; evidenceGap: string; expectedValue: string; informationValue: "high" | "medium"; url: string; attemptId: string | null }
export interface DecisionOutcome {
  selected: string; ranking: string[]; rejected: Array<{ option: string; reason: string }>; rationale: string; expectedOutcome: string; nextAction: string;
  /** The founder's own sizing of what this path puts at risk (its own capital), and what would prove it wrong. */
  capitalAtRiskPence: number; downside: string; invalidatedBy: string;
  /** Own capital committed under this decision so far (spend orders the founder's runtime let through). */
  committedPence: number;
  goalId: string | null; decidedAt: string;
}
/** MEASURE → LEARN → FORWARD. A "corrected" review changes the path on NEW evidence (the corrective step). */
export interface DecisionReview {
  at: string; verdict: (typeof REVIEW_VERDICTS)[number]; actual: string; learning: string; evidence: string[]; nextAction: string; goalId: string | null;
  previousPath?: string; newPath?: string; failedAssumption?: string; impact?: string;
}
export interface Decision {
  key: string; purpose: DecisionPurpose; objective: string; question: string; hypothesis: string; options: string[]; stop: { maxFetches: number; when: string };
  status: "open" | "decided"; openedAt: string; research: ResearchStep[]; outcome: DecisionOutcome | null; reviews: DecisionReview[];
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
  return v.filter((d): d is Decision => !!d && typeof d === "object" && typeof (d as Decision).key === "string" && Array.isArray((d as Decision).research))
    .map((d) => ({ ...d, objective: typeof d.objective === "string" ? d.objective : "", reviews: Array.isArray(d.reviews) ? d.reviews : [],
      outcome: d.outcome ? ({ capitalAtRiskPence: 0, downside: "", invalidatedBy: "", committedPence: 0, ...(d.outcome as Partial<DecisionOutcome>) } as DecisionOutcome) : null }));
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
  const objective = text(a.objective, 10, 300);
  const question = text(a.question, 10, 400);
  const hypothesis = text(a.hypothesis, 10, 400);
  const when = text(a.stopWhen, 5, 300);
  const maxFetches = Number(a.stopAfterFetches);
  if (!objective || !question || !hypothesis || !when || !Number.isSafeInteger(maxFetches) || maxFetches < 1 || maxFetches > DECISION_LIMITS.maxFetches) {
    return { ok: false, code: "FLEET_BAD_REQUEST",
      detail: `objective, question, hypothesis, stopWhen and stopAfterFetches (1-${DECISION_LIMITS.maxFetches}) are required: research needs an economic objective, a decision, a hypothesis and your own stop condition` };
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
  const decision: Decision = { key, purpose: a.purpose as DecisionPurpose, objective, question, hypothesis, options, stop: { maxFetches, when }, status: "open",
    openedAt: now.toISOString(), research: [], outcome: null, reviews: [] };
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

/**
 * resolve_decision: select, rank, reject, size the risk, name what would invalidate it, act. The ranking and the
 * selection are the founder's own — stored exactly as given, never re-scored. Mutates `list` (the caller links the goal).
 */
export function resolveDecision(list: Decision[], a: Record<string, unknown>, now = new Date()): DecisionResult {
  const key = typeof a.key === "string" ? a.key.trim() : "";
  const d = list.find((x) => x.key === key);
  if (!d) return { ok: false, code: "FLEET_DECISION_UNKNOWN", detail: `no decision ${key}` };
  if (d.status === "decided") return { ok: false, code: "FLEET_DECISION_ALREADY_MADE", detail: decidedSummary(d) };
  const selected = text(a.selected, 1, 200);
  const rationale = text(a.rationale, 10, 1000);
  const expectedOutcome = text(a.expectedOutcome, 5, 400);
  const nextAction = text(a.nextAction, 5, 300);
  const downside = text(a.downside, 5, 300);
  const invalidatedBy = text(a.invalidatedBy, 5, 300);
  const capitalAtRiskPence = Number(a.capitalAtRiskPence);
  if (!selected || !rationale || !expectedOutcome || !nextAction) {
    return { ok: false, code: "FLEET_BAD_REQUEST", detail: "selected, rationale, expectedOutcome and nextAction are required: a decision ends in an action" };
  }
  if (!downside || !invalidatedBy || !Number.isSafeInteger(capitalAtRiskPence) || capitalAtRiskPence < 0) {
    return { ok: false, code: "FLEET_RISK_UNSIZED",
      detail: "size the path before you take it: capitalAtRiskPence (your own capital it may consume, 0 if none), downside (the worst case and how reversible it is) and invalidatedBy (the evidence that would prove it wrong)" };
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
  d.outcome = { selected, ranking, rejected, rationale, expectedOutcome, nextAction, capitalAtRiskPence, downside, invalidatedBy, committedPence: 0, goalId: null,
    decidedAt: now.toISOString() };
  return { ok: true, decision: d };
}

/**
 * review_decision: MEASURE → LEARN → FORWARD on a decided path. "confirmed" keeps the path; "corrected" is the one
 * permitted step backwards — new evidence broke an assumption — and must leave the founder better placed. Exposure may
 * be lowered at any time (preserve capital); raising it needs new evidence (evidence justifies committing more).
 * Mutates `list` on success; the caller closes the previous step's goal and opens the next.
 */
export function reviewDecision(list: Decision[], a: Record<string, unknown>, now = new Date()): DecisionResult & { previousGoalId?: string | null } {
  const key = typeof a.key === "string" ? a.key.trim() : "";
  const d = list.find((x) => x.key === key);
  if (!d) return { ok: false, code: "FLEET_DECISION_UNKNOWN", detail: `no decision ${key}` };
  if (d.status !== "decided" || !d.outcome) return { ok: false, code: "FLEET_DECISION_OPEN", detail: `${key} is still open: decide it (resolve_decision) before reviewing a result` };
  if (!REVIEW_VERDICTS.includes(a.verdict as "confirmed")) return { ok: false, code: "FLEET_BAD_REQUEST", detail: "verdict is confirmed (the path holds) or corrected (new evidence broke it)" };
  const actual = text(a.actual, 5, 400);
  const learning = text(a.learning, 5, 400);
  const nextAction = text(a.nextAction, 5, 300);
  if (!actual || !learning || !nextAction) {
    return { ok: false, code: "FLEET_BAD_REQUEST", detail: "actual (what you measured), learning (what it teaches) and nextAction (the next FORWARD step) are required" };
  }
  const evidence = Array.isArray(a.evidence) ? a.evidence.filter((e): e is string => typeof e === "string" && e.trim().length >= 3).map((e) => e.trim().slice(0, 300)) : [];
  if (evidence.length > DECISION_LIMITS.evidence) return { ok: false, code: "FLEET_BAD_REQUEST", detail: `cite at most ${DECISION_LIMITS.evidence} pieces of evidence: the decisive ones` };
  // Evidence the founder already had when it chose (or last corrected) this path cannot justify changing it.
  const known = new Set([...d.research.flatMap((r) => [r.attemptId ?? "", r.url, r.evidenceGap]), ...d.reviews.flatMap((r) => r.evidence)].filter(Boolean).map(normalize));
  const fresh = evidence.filter((e) => !known.has(normalize(e)));
  const o = d.outcome;
  const raise = a.capitalAtRiskPence !== undefined ? Number(a.capitalAtRiskPence) : null;
  if (raise !== null && (!Number.isSafeInteger(raise) || raise < 0)) return { ok: false, code: "FLEET_BAD_REQUEST", detail: "capitalAtRiskPence is a whole number of pence" };
  if (raise !== null && raise > o.capitalAtRiskPence && fresh.length === 0) {
    return { ok: false, code: "FLEET_EXPOSURE_UNSUPPORTED", detail: `committing more than the ${o.capitalAtRiskPence}p you sized needs new evidence that justifies it (cite it)` };
  }
  const review: DecisionReview = { at: now.toISOString(), verdict: a.verdict as DecisionReview["verdict"], actual, learning, evidence, nextAction, goalId: null };
  if (a.verdict === "corrected") {
    const newPath = text(a.newPath, 1, 200);
    const failedAssumption = text(a.failedAssumption, 5, 300);
    const impact = text(a.impact, 5, 300);
    if (!newPath || !failedAssumption || !impact) {
      return { ok: false, code: "FLEET_BAD_REQUEST", detail: "a correction records the failed assumption, the new path and its economic impact" };
    }
    if (normalize(newPath) === normalize(o.selected)) {
      return { ok: false, code: "FLEET_NOT_A_CORRECTION", detail: `"${o.selected}" is already your path: confirm it and move forward, or name the different path the evidence points to` };
    }
    const abandoned = d.reviews.map((r) => r.previousPath).filter((p): p is string => !!p);
    if (abandoned.some((p) => normalize(p) === normalize(newPath))) {
      return { ok: false, code: "FLEET_OSCILLATION",
        detail: `you already left "${newPath}" for ${key} on evidence: returning to it is oscillation. If the situation is genuinely new, open a new decision with a new question` };
    }
    if (fresh.length === 0) {
      return { ok: false, code: "FLEET_CORRECTION_UNSUPPORTED",
        detail: "a correction needs NEW evidence (research attemptIds, URLs or measured results) that you did not have when you chose this path" };
    }
    if (d.reviews.filter((r) => r.verdict === "corrected").length >= DECISION_LIMITS.corrections) {
      return { ok: false, code: "FLEET_CORRECTION_LIMIT",
        detail: `${key} has changed course ${DECISION_LIMITS.corrections} times: stop re-deciding it — open a new, narrower decision on what the evidence now shows` };
    }
    Object.assign(review, { previousPath: o.selected, newPath, failedAssumption, impact });
    o.selected = newPath;
  }
  const previousGoalId = o.goalId;
  o.nextAction = nextAction;
  if (raise !== null) o.capitalAtRiskPence = raise;
  if (typeof a.downside === "string" && a.downside.trim().length >= 5) o.downside = a.downside.trim().slice(0, 300);
  d.reviews = [...d.reviews, review].slice(-DECISION_LIMITS.reviewsKept);
  return { ok: true, decision: d, previousGoalId };
}

/**
 * Before committing OWN capital (request_spend): the founder's runtime checks the founder's own sizing. FleetController
 * is not consulted here; it remains the custody boundary that executes or refuses the order afterwards.
 */
export function commitmentCheck(list: Decision[], a: Record<string, unknown>, amountPence: number): DecisionResult {
  const key = typeof a.decisionKey === "string" ? a.decisionKey.trim() : "";
  const d = key ? list.find((x) => x.key === key) : undefined;
  if (!d || d.status !== "decided" || !d.outcome) {
    return { ok: false, code: "FLEET_COMMITMENT_UNDECIDED",
      detail: "commit your own capital only under a decided decision whose risk you sized (resolve_decision with capitalAtRiskPence, downside and invalidatedBy); name it as decisionKey" };
  }
  const o = d.outcome;
  if (o.committedPence + amountPence > o.capitalAtRiskPence) {
    return { ok: false, code: "FLEET_EXPOSURE_EXCEEDED",
      detail: `you sized ${key} at ${o.capitalAtRiskPence}p of capital at risk and have committed ${o.committedPence}p: ${amountPence}p more exceeds your own limit. Commit within it, or review_decision with the evidence that justifies more` };
  }
  return { ok: true, decision: d };
}

/** Record own capital committed under a decision (after the controller accepted the order). */
export function noteCommitment(list: Decision[], key: string, amountPence: number): void {
  const d = list.find((x) => x.key === key && x.outcome);
  if (d?.outcome) d.outcome.committedPence += amountPence;
}

// ─────────────────────────────────────────────── what the founder sees (bounded; its own data)

/** Open decisions first (with what is already gathered), then the most recent decisions (closed to research). */
export function decisionLines(list: Decision[]): string[] {
  const open = list.filter((d) => d.status === "open").slice(0, DECISION_LIMITS.open).map((d) => {
    const gathered = d.research.slice(-DECISION_LIMITS.gapsShown).map((r) => `"${r.evidenceGap.slice(0, 120)}"${r.attemptId ? ` (attemptId ${r.attemptId})` : ""}`);
    return `Open decision ${d.key} (${d.purpose}${d.objective ? `, objective: ${d.objective.slice(0, 160)}` : ""}): "${d.question}" Hypothesis: ${d.hypothesis}${d.options.length ? ` Shortlist: ${d.options.join(" | ")}.` : ""}`
      + ` Research: ${d.research.length}/${d.stop.maxFetches} fetch(es) (your stop: ${d.stop.when})${gathered.length ? `; already gathered: ${gathered.join(", ")}` : ""}.`
      + " Do you know enough to make the next economically meaningful move? If yes, resolve_decision and execute; if no, fetch the ONE highest-value missing fact.";
  });
  const decided = list.filter((d) => d.status === "decided").sort((a, b) => (b.outcome?.decidedAt ?? "").localeCompare(a.outcome?.decidedAt ?? "")).slice(0, 3).map((d) => {
    const o = d.outcome!;
    const last = d.reviews.at(-1);
    const review = !last ? "" : last.verdict === "corrected"
      ? ` Corrected ${last.at.slice(0, 10)}: "${last.previousPath}" → "${last.newPath}" — ${last.failedAssumption?.slice(0, 120)} failed (${last.learning.slice(0, 120)}); impact: ${last.impact?.slice(0, 120)}.`
      : ` Last result ${last.at.slice(0, 10)}: ${last.actual.slice(0, 120)} — ${last.learning.slice(0, 120)}.`;
    return `Decided ${d.key}: "${o.selected}"${o.rejected.length ? ` (rejected: ${o.rejected.map((r) => `${r.option} — ${r.reason}`).join("; ")})` : ""}.`
      + ` At risk: ${o.capitalAtRiskPence}p of your capital (${o.committedPence}p committed; downside: ${o.downside.slice(0, 120)}); invalidated if: ${o.invalidatedBy.slice(0, 160)}.${review}`
      + ` Next action: ${o.nextAction}${o.goalId ? ` [goal ${o.goalId}]` : ""}. Research on this question is closed: execute, measure, then review_decision.`;
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

/**
 * Information for the founder's own risk management — never a permission, a ration, a deadline or a change of standard.
 * The wording is identical at every runway: runway changes which opportunity is rational, not how precisely to work.
 */
export const CONSTANT_STANDARD = "Runway changes which opportunities are rational for you (capital required, time to revenue, downside) — never your standard: "
  + "the same precision at any runway, no casual research when capital is plentiful, no panic when it is scarce.";
export function survivalLine(s: SurvivalView): string {
  return `Your survival position (FleetController's observation; the risk management is yours): survival equity ${s.survivalEquityCents}p; inference ${s.inferenceTodayCents}p today, `
    + `≈ ${s.burnPerDayCents}p/day over 7 days${s.runwayDays !== null ? `; runway ≈ ${Math.round(s.runwayDays)} days at that burn` : ""}. ${CONSTANT_STANDARD}`;
}

/**
 * The founder's own-capital position and its own record, for its OWN sizing: wallet, protected capital, open exposure,
 * concentration, realised results and how its measured results compared with its decisions. Information only — never a
 * permission, a limit or a score: it is computed in the founder's runtime from its ledger view and its own decision
 * ledger, nothing here is sent to FleetController, and FleetController checks custody alone (no owner approval route,
 * no fixed amount). Null when the ledger view carries no cash figure.
 */
export function ownCapitalLine(economics: Record<string, unknown>, list: Decision[]): string | null {
  const n = (k: string): number | null => { const v = economics[k]; return v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)); };
  const cash = n("cash");
  if (cash === null) return null;
  const decided = list.filter((d) => d.status === "decided" && d.outcome);
  const sized = decided.reduce((s, d) => s + (d.outcome!.capitalAtRiskPence || 0), 0);
  const committed = decided.reduce((s, d) => s + (d.outcome!.committedPence || 0), 0);
  const largest = decided.reduce((m, d) => Math.max(m, d.outcome!.capitalAtRiskPence || 0), 0);
  const reviews = decided.flatMap((d) => d.reviews);
  const confirmed = reviews.filter((r) => r.verdict === "confirmed").length;
  return `Your own capital (for your own sizing — information, not a permission or a limit): unreserved cash ${cash}p; reserved in open orders ${n("reserved") ?? 0}p; `
    + `protected, never spendable: ${n("protectedPrincipal") ?? 0}p borrowed principal and ${n("protectedObligations") ?? 0}p obligations (tax reserves included); survival equity ${n("survivalEquity") ?? 0}p. `
    + `Sized exposure under your decided decisions: ${sized}p across ${decided.length}, ${committed}p committed`
    + `${largest > 0 ? `; largest single exposure ${largest}p${cash > 0 ? ` (${Math.round((largest / cash) * 100)}% of your cash)` : ""}` : ""}. `
    + `Your record: ${reviews.length} measured result(s) — ${confirmed} confirmed the path, ${reviews.length - confirmed} corrected it on evidence; `
    + `realised revenue ${n("externalCustomerRevenue") ?? 0}p, expenses and fees ${(n("expenses") ?? 0) + (n("fees") ?? 0)}p, net ${n("realizedNetProfit") ?? 0}p. `
    + "FleetController checks custody only (protected and tax-reserved capital, other agents' and Treasury money, holds, destinations, infrastructure safety): "
    + "no approval queue, no fixed amount — the sizing is yours.";
}

export type IdleKind = "decide" | "execute" | "opportunity";

/** What an idle founder's next economically meaningful move is: decide, execute, or find something worth executing. */
export function idleKind(list: Decision[], openGoals: number): IdleKind {
  if (list.some((d) => d.status === "open")) return "decide";
  return openGoals > 0 ? "execute" : "opportunity";
}

/** The concise opportunity-identification cycle (no open decision, no execution path). Not a browsing mandate. */
export const OPPORTUNITY_CYCLE = "Run ONE concise opportunity-identification cycle, not open-ended browsing: open_decision (purpose find_opportunity) with your economic objective, a concrete question, your hypothesis and a stop condition; "
  + "gather purchase evidence — sales velocity, marketplace rankings and bestseller lists, search demand, prices, reviews and complaints, competition — on a few candidates "
  + "(not trends or social feeds: popularity without purchase intent is weak evidence); rank at most 5 by your own judgement of expected return for your situation; "
  + "select one yourself (resolve_decision, with the capital at risk and what would invalidate it) and start executing.";

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

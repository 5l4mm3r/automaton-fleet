/**
 * F1-FRESH-EVAL-02 — can structured freshness enable correct use of CURRENT truth when legacy memory cannot reliably
 * tell which of several historically valid observations is current?
 *
 * What F1-FRESH-EVAL-01 (sealed: NOT_PROVEN) showed: with plain strings a capable model abstains (UNKNOWN) on
 * contradictions it cannot order; with observedAt it resolves them. This evaluation measures that capability directly
 * (current-truth accuracy) and no longer requires the control to consume stale facts.
 *
 * Design (pre-registered; PRE_REGISTRATION below, docs/evaluations/f1-fresh-eval-02/README.md):
 *   MODEL-DRIVEN trunk: three production-style turns (each starts severed: a packet built from memory + that turn's
 *   news, exactly like the routed founder runtime). The founder maintains its OWN memory with the production tools:
 *   nothing is scripted. Eight fact domains change over the turns: an unlinked newer observation, an explicit
 *   correction, three plain changes, a claim that is later retracted, and two unchanged controls.
 *   Arms (identical system prompt, tool definitions, model settings, task wording and step budget):
 *     FRESH   production fact store / packet builder / toolbox.
 *     LEGACY  the same tool schemas with best-realistic string semantics (F1-FRESH-EVAL-01's legacy store:
 *             overwrite; `supersedes` overwrites the old key with a pointer; `retract_fact` overwrites with
 *             "RETRACTED: …"; no observedAt, provenance or history) and the packet without the F1-FRESH-01 fields.
 *     NOMEM   no trunk, no memory, no packet (negative control).
 *   PROBE after a final severance: ten closed answers from memory only.
 *   Two effects are scored separately:
 *     MAINTENANCE     what the founder stored: per domain CLEAN / AMBIGUOUS / STALE_ONLY / MISSING (memory after trunk).
 *     REPRESENTATION  answers given the stored state (current-truth accuracy on AMBIGUOUS domains, FRESH vs LEGACY).
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { MAX_TOOL_CALLS_EXECUTED, ProviderError, type ChatMessage, type ChatResult, type CognitionProvider, type ToolCall } from "../cognition/types.js";
import { costMicrocents, type Prices } from "../cognition/charging.js";
import { FounderMind, type TurnResult } from "../founder/mind.js";
import { FounderToolbox } from "../founder/toolbox.js";
import { FOUNDER_MANIFEST_V2 } from "../capabilities.js";
import { buildTaskPacket, renderTaskPacket, type TaskPacket } from "../cognition/task-packet.js";
import { loadFacts } from "../founder/facts.js";
import { BudgetStop, worstCaseMicrocents, type CallRecord } from "./f1-eval-02.js";
import { EVAL_SYSTEM, evalTools, legacyFactTool, legacyPacket } from "./f1-fresh-eval-01.js";

export const EVALUATION = "f1-fresh-eval-02";
/** Hard ceiling of this evaluation: $2.00. */
export const FRESH2_CAP_CEILING_MICROCENTS = 200_000_000;
export type Arm2 = "FRESH" | "LEGACY" | "NOMEM";
export const ARMS2: readonly Arm2[] = ["FRESH", "LEGACY", "NOMEM"];
export const REPLICATES2 = 3;

// ─────────────────────────────────────────────── the world: three turns of news (identical in every arm)

export const TRUNK_TURNS: readonly string[] = Object.freeze([
  [
    "Date: 2026-09-20. Weekly check-in for O7 (the rent-tracker spreadsheet template you sell on Stallhub).",
    "News since your last turn:",
    "- Stallhub dashboard: the O7 template is listed at £12.00.",
    "- Stallhub help page: the transaction fee is 6.5% of each sale.",
    "- PrintCo price list: the printed unit cost is £2.00 at list price.",
    "- PrintCo: paper is in stock.",
    "- PrintCo: the standard lead time is 5 business days.",
    "- Stallhub policy: buyers may request a refund within 14 days.",
    "- Stallhub account: your listing quota is 20 listings per month.",
    "- Ads report: your cost per click averaged £0.35.",
    "Plan this week's work for O7. Your conversation will not be available on your next turn: keep in memory what you will need.",
  ].join("\n"),
  [
    "Date: 2026-09-24. Mid-week check-in for O7.",
    "News since your last turn:",
    "- A seller forum post says PrintCo gives a 30% bulk discount, which would make the printed unit cost £1.40.",
    "- Stallhub emailed a correction: the transaction fee you were told before (6.5%) is out of date; the fee is 9% of each sale.",
    "Decide what, if anything, changes in your plan. Your conversation will not be available on your next turn: keep in memory what you will need.",
  ].join("\n"),
  [
    "Date: 2026-09-29. Weekly check-in for O7.",
    "News since your last turn:",
    "- Stallhub dashboard: the O7 template is listed at £13.50.",
    "- PrintCo: the lead time is now 12 business days.",
    "- Stallhub policy update: the refund window is now 30 days.",
    "- PrintCo confirmed there is no bulk discount; the forum post was wrong.",
    "- PrintCo: paper is out of stock until 2026-10-20.",
    "Plan next week for O7. Your conversation will not be available on your next turn: keep in memory what you will need.",
  ].join("\n"),
]);

export const PROBE2_TASK = [
  "Date: 2026-10-01. PROBE (decision, from memory only). You are planning the next order and listing for O7.",
  "Use only your own memory: the facts and goals you hold. Do not research; do not request spending. If your memory does not settle a question, answer UNKNOWN for it.",
  "Answer ten questions, then end your final message with exactly one line in this form:",
  "ANSWERS: q1=<O7 single-template price in £ now>; q2=<Stallhub transaction fee in percent now>; q3=<PrintCo paper availability now: IN or OUT>; q4=<PrintCo lead time in business days now>; q5=<Stallhub refund window in days now>; q6=<printed unit cost in £ to use now>; q7=<Stallhub listing quota per month>; q8=<ad cost per click in £>; q9=<net margin in £ per sale of a £15 bundle containing 2 printed units, after the Stallhub fee on the £15 price, rounded to 2 decimals>; q10=<can PrintCo paper for an order placed today arrive within 10 business days: YES or NO>",
  "(each value may instead be UNKNOWN)",
].join("\n");

export const PROBE2_CONTRACT: TaskPacket["outputContract"] = { form: "decision", mustCite: false, instructions: "Answer the ten questions from memory, then the single ANSWERS line." };

// ─────────────────────────────────────────────── answer key and classes (pre-registered)

export type Q = "q1" | "q2" | "q3" | "q4" | "q5" | "q6" | "q7" | "q8" | "q9" | "q10";
export const QS: readonly Q[] = ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8", "q9", "q10"];
/** Domains whose truth changed during the trunk (the primary measure) and the unchanged controls (retention check). */
export const CHANGING: readonly Q[] = ["q1", "q2", "q3", "q4", "q5", "q6", "q9", "q10"];
export const CONTROLS: readonly Q[] = ["q7", "q8"];

type Num = { kind: "num"; current: number; stale?: number[]; retracted?: number[]; staleRetracted?: number[]; tol: number };
type Tok = { kind: "tok"; current: string; stale?: string[] };
export const KEY2: Readonly<Record<Q, (Num | Tok) & { update: string }>> = Object.freeze({
  q1: { kind: "num", current: 13.5, stale: [12], tol: 0.005, update: "unlinked newer observation" },
  q2: { kind: "num", current: 9, stale: [6.5], tol: 0.0001, update: "explicit correction" },
  q3: { kind: "tok", current: "OUT", stale: ["IN"], update: "change" },
  q4: { kind: "num", current: 12, stale: [5], tol: 0.0001, update: "change" },
  q5: { kind: "num", current: 30, stale: [14], tol: 0.0001, update: "change" },
  q6: { kind: "num", current: 2, retracted: [1.4], tol: 0.005, update: "claim later retracted" },
  q7: { kind: "num", current: 20, tol: 0.0001, update: "unchanged control" },
  q8: { kind: "num", current: 0.35, tol: 0.005, update: "unchanged control" },
  // 15 − 15·fee − 2·cost: current 9.65; stale fee 10.025; retracted cost 10.85; both 11.225
  q9: { kind: "num", current: 9.65, stale: [10.025], retracted: [10.85], staleRetracted: [11.225], tol: 0.02, update: "decision (fee, cost)" },
  // out of stock until 10-20 and 12-day lead time → NO; stale (in stock, 5 days) → YES
  q10: { kind: "tok", current: "NO", stale: ["YES"], update: "decision (stock, lead time)" },
});

export type Class2 = "CURRENT_CORRECT" | "STALE" | "RETRACTED" | "STALE+RETRACTED" | "UNKNOWN" | "OTHER" | "MISSING";

export const SCORING_RULES2 = "last ANSWERS line wins; values split on ';'; strip quotes/backticks/asterisks and trailing .,;:) ; numbers may carry £/$ prefix, % suffix, or a trailing unit word (days, business days, listings); tokens compared case-insensitively; UNKNOWN is its own class";

const clean = (s: string) => s.trim().replace(/^[`"'*\s]+|[`"'*\s]+$/g, "").replace(/[.,;:)]+$/, "").trim();
const num = (s: string): number | null => {
  const m = /^[£$]?\s*(-?\d+(?:\.\d+)?)\s*(?:%|(?:business |working )?days?|listings?(?: per month)?)?$/i.exec(clean(s));
  return m ? Number(m[1]) : null;
};

export function parseAnswers2(text: string): Partial<Record<Q, string>> | null {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => /^\**\s*ANSWERS\s*:/i.test(l));
  if (!lines.length) return null;
  const body = lines[lines.length - 1].replace(/^\**\s*ANSWERS\s*:\s*/i, "").replace(/\*+$/, "");
  const out: Partial<Record<Q, string>> = {};
  for (const part of body.split(";")) {
    const m = /^\s*(q(?:10|[1-9]))\s*=\s*(.*?)\s*$/i.exec(part);
    if (m) out[m[1].toLowerCase() as Q] = m[2];
  }
  return Object.keys(out).length ? out : null;
}

export function classify2(q: Q, raw: string | undefined): Class2 {
  if (raw === undefined) return "MISSING";
  const s = clean(raw);
  if (/^unknown$/i.test(s)) return "UNKNOWN";
  const k = KEY2[q];
  if (k.kind === "tok") {
    const t = s.toUpperCase();
    return t === k.current ? "CURRENT_CORRECT" : (k.stale ?? []).includes(t) ? "STALE" : "OTHER";
  }
  const n = num(s);
  if (n === null) return "OTHER";
  const near = (xs?: number[]) => (xs ?? []).some((x) => Math.abs(n - x) <= k.tol);
  return near([k.current]) ? "CURRENT_CORRECT" : near(k.staleRetracted) ? "STALE+RETRACTED" : near(k.stale) ? "STALE" : near(k.retracted) ? "RETRACTED" : "OTHER";
}

// ─────────────────────────────────────────────── memory maintenance (deterministic, from the memory after the trunk)

export type MemState = "CLEAN" | "AMBIGUOUS" | "STALE_ONLY" | "MISSING";
/** Value detectors over fact text, per primary domain (q9/q10 are derived and have no own memory state). */
export const DETECT: Readonly<Partial<Record<Q, { current: RegExp; stale: RegExp; negation?: RegExp }>>> = Object.freeze({
  q1: { current: /£\s?13\.50\b/, stale: /£\s?12(?:\.00)?(?!\.?\d)/ },
  q2: { current: /(?<![\d.])9(?:\.0+)?\s?%/, stale: /6\.5\s?%/ },
  q3: { current: /out of stock/i, stale: /(?<!out of )\bin stock\b/i },
  q4: { current: /\b12\s*(?:business |working )?days?\b/i, stale: /(?<![\d.])5\s*(?:business |working )?days?\b/i },
  q5: { current: /\b30[- ]?days?\b/i, stale: /\b14[- ]?days?\b/i },
  // the retracted claim; a fact that negates it ("no bulk discount", "wrong", "retracted") does not assert it
  q6: { current: /£\s?2(?:\.00)?(?!\.?\d)/, stale: /£\s?1\.40\b|30\s?% (?:bulk )?discount|bulk discount/i, negation: /\bno (?:bulk )?discount|\bwrong\b|\bfalse\b|retract/i },
  q7: { current: /\b20 listings\b/i, stale: /$^/ },
  q8: { current: /£\s?0\.35\b/, stale: /$^/ },
});

/** One domain's state in a set of CURRENT fact texts: does current truth stand alone, beside a stale-only fact, or not at all? */
export function memState(q: Q, currentFacts: readonly string[]): MemState {
  const d = DETECT[q];
  if (!d) throw new Error(`no detector for ${q}`);
  const assertsStale = (t: string) => d.stale.test(t) && !(d.negation?.test(t) ?? false) && !d.current.test(t);
  const hasCurrent = currentFacts.some((t) => d.current.test(t) && !(q === "q6" && assertsStale(t)));
  const staleOnly = currentFacts.some(assertsStale);
  return hasCurrent && !staleOnly ? "CLEAN" : hasCurrent && staleOnly ? "AMBIGUOUS" : staleOnly ? "STALE_ONLY" : "MISSING";
}

/** The current fact texts of an arm's memory (FRESH: the store's current facts; LEGACY: every string not overwritten as RETRACTED/SUPERSEDED). */
export function currentFactTexts(memoryDir: string, arm: Arm2): string[] {
  if (arm === "FRESH") return loadFacts(memoryDir).current.map((f) => `${f.key}: ${f.value}`);
  let facts: Record<string, string> = {};
  try { facts = JSON.parse(fs.readFileSync(path.join(memoryDir, "facts.json"), "utf8")); } catch { /* none */ }
  return Object.entries(facts).filter(([, v]) => !/^(RETRACTED|SUPERSEDED by)/.test(v)).map(([k, v]) => `${k}: ${v}`);
}

// ─────────────────────────────────────────────── scoring and the pre-registered rule

export interface Cell2Score {
  cellId: string;
  arm: Arm2;
  replicate: number;
  parsed: boolean;
  classes: Record<Q, Class2>;
  memory: Partial<Record<Q, MemState>> | null;
  maintenance: { rememberCalls: number; supersedesUsed: number; retractCalls: number } | null;
  trunkComplete: boolean;
}

export function scoreCell2(r: Pick<Fresh2CellResult, "cellId" | "arm" | "replicate" | "finalText" | "memoryAfterTrunk" | "maintenance" | "trunkComplete">): Cell2Score {
  const a = parseAnswers2(r.finalText);
  const classes = Object.fromEntries(QS.map((q) => [q, classify2(q, a?.[q])])) as Record<Q, Class2>;
  const memory = r.memoryAfterTrunk ? Object.fromEntries(Object.keys(DETECT).map((q) => [q, memState(q as Q, r.memoryAfterTrunk!)])) as Partial<Record<Q, MemState>> : null;
  return { cellId: r.cellId, arm: r.arm, replicate: r.replicate, parsed: !!a && QS.every((q) => q in a), classes, memory, maintenance: r.maintenance, trunkComplete: r.trunkComplete };
}

/**
 * PRE-REGISTERED decision rule (fixed before any paid call; sha256 recorded in the configs). Primary measure:
 * current-truth accuracy (CTA) over the 8 CHANGING answers × 3 replicates = 24 per arm. Thresholds are derived from
 * the instrument, not from F1-FRESH-EVAL-01's numbers: with n = 24 per arm and p ≈ 0.7 the standard error of a
 * difference of proportions is ≈ 0.13, so a required advantage of 0.25 (6 answers) is ≈ 1.9 SE; answers within a cell
 * are correlated, so the advantage must also hold in at least 2 of the 3 replicate pairs. Stale use is NOT required.
 */
export const PRE_REGISTRATION2 = Object.freeze({
  replicatesPerArm: REPLICATES2,
  changingAnswersPerArm: CHANGING.length * REPLICATES2,
  validity: { minParsedCells: 8, of: 9, minCompleteTrunks: 6 },
  negativeControl: { maxNomemCurrentCorrect: 2, maxNomemControlCorrect: 1 },
  retention: { minControlCorrectPerMemoryArm: 4, of: 6 },
  fresh: { minCurrentCorrect: 18 },
  superiority: { minCurrentCorrectAdvantage: 6, minReplicatePairsWon: 2 },
  descriptive: {
    maintenanceEffect: "per arm: share of the 6 primary changing domains (q1–q6) × 3 trunks in state CLEAN; FRESH − LEGACY",
    representationEffect: "CTA on answers whose domain was AMBIGUOUS in that cell's memory: FRESH − LEGACY (reported when both arms have ≥ 3 such answers)",
    abstention: "UNKNOWN share per arm, reported separately from STALE/RETRACTED",
  },
  verdicts: {
    PROVEN: "validity, negative control, retention, FRESH quality and superiority all hold",
    NOT_PROVEN: "validity, negative control and retention hold, but FRESH quality or superiority fails",
    INCONCLUSIVE: "validity, negative control or retention fails (the instrument, not the hypothesis, failed)",
  },
});
export const PRE_REGISTRATION2_SHA256 = crypto.createHash("sha256").update(JSON.stringify({
  PRE_REGISTRATION2, KEY2, DETECT: Object.fromEntries(Object.entries(DETECT).map(([q, d]) => [q, { current: String(d!.current), stale: String(d!.stale), negation: String(d!.negation ?? "") }])),
  TRUNK_TURNS, PROBE2_TASK, SCORING_RULES2, system: crypto.createHash("sha256").update(EVAL_SYSTEM).digest("hex"),
})).digest("hex");

export function summarize2(cells: Cell2Score[]) {
  const per = (arm: Arm2) => {
    const xs = cells.filter((c) => c.arm === arm);
    const count = (qs: readonly Q[], cls: Class2[]) => xs.reduce((n, c) => n + qs.filter((q) => cls.includes(c.classes[q])).length, 0);
    const amb = xs.flatMap((c) => (["q1", "q2", "q3", "q4", "q5", "q6"] as Q[]).filter((q) => c.memory?.[q] === "AMBIGUOUS").map((q) => c.classes[q]));
    const states = xs.flatMap((c) => (["q1", "q2", "q3", "q4", "q5", "q6"] as Q[]).map((q) => c.memory?.[q])).filter(Boolean);
    return {
      arm, cells: xs.length, parsed: xs.filter((c) => c.parsed).length, completeTrunks: xs.filter((c) => c.trunkComplete).length,
      currentCorrect: count(CHANGING, ["CURRENT_CORRECT"]), stale: count(CHANGING, ["STALE", "STALE+RETRACTED"]), retracted: count(CHANGING, ["RETRACTED", "STALE+RETRACTED"]),
      unknown: count(CHANGING, ["UNKNOWN"]), other: count(CHANGING, ["OTHER"]), missing: count(CHANGING, ["MISSING"]),
      controlCorrect: count(CONTROLS, ["CURRENT_CORRECT"]),
      byReplicate: Object.fromEntries(xs.map((c) => [c.replicate, CHANGING.filter((q) => c.classes[q] === "CURRENT_CORRECT").length])) as Record<number, number>,
      memoryStates: { CLEAN: states.filter((s) => s === "CLEAN").length, AMBIGUOUS: states.filter((s) => s === "AMBIGUOUS").length, STALE_ONLY: states.filter((s) => s === "STALE_ONLY").length, MISSING: states.filter((s) => s === "MISSING").length },
      ambiguousAnswers: amb.length, ambiguousCurrentCorrect: amb.filter((c) => c === "CURRENT_CORRECT").length,
      tools: xs.reduce((t, c) => ({ remember: t.remember + (c.maintenance?.rememberCalls ?? 0), supersedes: t.supersedes + (c.maintenance?.supersedesUsed ?? 0), retract: t.retract + (c.maintenance?.retractCalls ?? 0) }), { remember: 0, supersedes: 0, retract: 0 }),
    };
  };
  const arms = { FRESH: per("FRESH"), LEGACY: per("LEGACY"), NOMEM: per("NOMEM") };
  const P = PRE_REGISTRATION2;
  const f = arms.FRESH, l = arms.LEGACY, n = arms.NOMEM;
  const pairsWon = [1, 2, 3].filter((r) => (f.byReplicate[r] ?? 0) > (l.byReplicate[r] ?? 0)).length;
  const checks = {
    validity: f.parsed + l.parsed + n.parsed >= P.validity.minParsedCells && f.cells + l.cells + n.cells === P.validity.of && f.completeTrunks + l.completeTrunks >= P.validity.minCompleteTrunks,
    negativeControl: n.currentCorrect <= P.negativeControl.maxNomemCurrentCorrect && n.controlCorrect <= P.negativeControl.maxNomemControlCorrect,
    retention: f.controlCorrect >= P.retention.minControlCorrectPerMemoryArm && l.controlCorrect >= P.retention.minControlCorrectPerMemoryArm,
    freshQuality: f.currentCorrect >= P.fresh.minCurrentCorrect,
    superiority: f.currentCorrect - l.currentCorrect >= P.superiority.minCurrentCorrectAdvantage && pairsWon >= P.superiority.minReplicatePairsWon,
  };
  const verdict = !checks.validity || !checks.negativeControl || !checks.retention ? "INCONCLUSIVE" : checks.freshQuality && checks.superiority ? "PROVEN" : "NOT_PROVEN";
  const share = (a: typeof f) => (a.memoryStates.CLEAN + a.memoryStates.AMBIGUOUS + a.memoryStates.STALE_ONLY + a.memoryStates.MISSING ? a.memoryStates.CLEAN / (a.memoryStates.CLEAN + a.memoryStates.AMBIGUOUS + a.memoryStates.STALE_ONLY + a.memoryStates.MISSING) : null);
  const ambRate = (a: typeof f) => (a.ambiguousAnswers ? a.ambiguousCurrentCorrect / a.ambiguousAnswers : null);
  const descriptive = {
    maintenanceEffect: { freshClean: share(f), legacyClean: share(l) },
    representationEffect: f.ambiguousAnswers >= 3 && l.ambiguousAnswers >= 3
      ? { freshAmbiguousCTA: ambRate(f), legacyAmbiguousCTA: ambRate(l), difference: ambRate(f)! - ambRate(l)! }
      : { insufficient: true, freshAmbiguousAnswers: f.ambiguousAnswers, legacyAmbiguousAnswers: l.ambiguousAnswers },
    abstention: { FRESH: f.unknown, LEGACY: l.unknown, NOMEM: n.unknown },
    replicatePairsWon: pairsWon,
  };
  return { arms, checks, verdict: verdict as "PROVEN" | "NOT_PROVEN" | "INCONCLUSIVE", descriptive };
}

// ─────────────────────────────────────────────── one cell: trunk (FRESH/LEGACY) + severed probe

export interface Fresh2CellRequest { cellId: string; arm: Arm2; replicate: number; trunkMaxSteps: number; probeMaxSteps: number; maxTokens: number; prices: Prices; budgetMicrocents: number }
export interface Fresh2CellResult {
  cellId: string; evaluation: typeof EVALUATION; arm: Arm2; replicate: number; model: string; startedAt: string; finishedAt: string;
  calls: Array<CallRecord & { phase: string }>; turns: TurnResult[]; stopped: null | "budget" | "provider_error"; spentMicrocents: number;
  toolOutcomes: Array<{ phase: string; name: string; ok: boolean; refused?: string }>;
  trunkComplete: boolean;
  /** Current fact texts after the trunk (the maintenance evidence); null for NOMEM. */
  memoryAfterTrunk: string[] | null;
  /** The raw memory files after the trunk (facts.json, facts-ledger.json, goals.json). */
  memoryFiles: Record<string, string>;
  maintenance: { rememberCalls: number; supersedesUsed: number; retractCalls: number } | null;
  probePacketBytes: number;
  finalText: string;
  score: Cell2Score;
  snapshot: Record<string, string>;
}

const bytes = (v: unknown) => Buffer.byteLength(typeof v === "string" ? v : JSON.stringify(v), "utf8");

export async function runFresh2Cell(req: Fresh2CellRequest, provider: CognitionProvider, o: { log?: (e: Record<string, unknown>) => void } = {}): Promise<Fresh2CellResult> {
  if (!ARMS2.includes(req.arm)) throw new Error(`unknown arm ${String(req.arm)}`);
  const startedAt = new Date().toISOString();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-f1-fresh-eval-02-"));
  const dirs = { ws: path.join(root, "workspace"), mem: path.join(root, "memory") };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const tools = evalTools();
  const calls: Fresh2CellResult["calls"] = [];
  const toolOutcomes: Fresh2CellResult["toolOutcomes"] = [];
  const turns: TurnResult[] = [];
  const toolCallsSeen: ToolCall[] = [];
  let spent = 0;
  let stopped: Fresh2CellResult["stopped"] = null;
  let phase = "";
  const toolbox = new FounderToolbox({
    manifest: FOUNDER_MANIFEST_V2, workspaceDir: dirs.ws, memoryDir: dirs.mem,
    ports: {
      ledger: async () => ({ note: "evaluation: no ledger" }),
      spendOrder: async () => ({ status: "refused", code: "FLEET_EVAL_NO_SPEND", reason: "evaluation environment" }),
      proposeKnowledge: async () => ({ status: "refused", reason: "evaluation environment" }),
      knowledge: async () => ({ items: [] }),
      requestIdentityFact: async () => ({ status: "refused", reason: "evaluation environment" }),
    },
  });
  const exec = toolbox.execute.bind(toolbox);
  toolbox.execute = async (call: ToolCall) => {
    toolCallsSeen.push(call);
    const legacyOut = req.arm === "LEGACY" ? legacyFactTool(dirs.mem, call) : null;
    const out = legacyOut ?? await exec(call);
    toolOutcomes.push({ phase, name: out.name, ok: out.ok, ...(out.refused ? { refused: out.refused } : {}) });
    return out;
  };
  /** One severed turn: a fresh conversation whose first message is the packet built from memory (none for NOMEM). */
  const turn = async (label: string, observation: string, maxSteps: number): Promise<number> => {
    phase = label;
    const st = fs.mkdtempSync(path.join(root, "state-"));
    let packetText = "";
    if (req.arm !== "NOMEM") {
      const built = buildTaskPacket({ memoryDir: dirs.mem, workspaceDir: dirs.ws, task: observation, outputContract: label === "probe" ? PROBE2_CONTRACT : { form: "analysis", mustCite: false, instructions: "Do this turn's work; keep your memory current." }, economics: {} });
      packetText = renderTaskPacket(req.arm === "LEGACY" ? legacyPacket(built) : built);
      fs.writeFileSync(path.join(st, "mind-history.json"), JSON.stringify([{ role: "user", content: packetText }]), { mode: 0o600 });
    }
    let step = 0;
    const mind = new FounderMind({
      toolbox, stateDir: st, maxStepsPerTurn: maxSteps,
      ports: {
        cognitionStatus: async () => ({ policyEnabled: true, provider: provider.id, founderEnabled: true, paused: false }),
        infer: async (messages) => {
          const msgs = messages as ChatMessage[];
          const requestBytes = bytes({ system: EVAL_SYSTEM, messages: msgs, tools });
          const rec: CallRecord & { phase: string } = {
            phase: label, turn: turns.length + 1, step: step++, ok: false, requestBytes, contextBytes: bytes(msgs), messages: msgs.length,
            packetPresent: !!packetText && msgs.some((m) => m.role === "user" && m.content === packetText),
            boundMicrocents: worstCaseMicrocents(requestBytes, req.maxTokens, req.prices), costMicrocents: 0, thinkingBlocks: 0,
          };
          if (spent + rec.boundMicrocents > req.budgetMicrocents) {
            rec.code = "FLEET_EVAL_BUDGET_STOP";
            calls.push(rec);
            o.log?.({ event: "budget_stop", cellId: req.cellId, spent, bound: rec.boundMicrocents, budget: req.budgetMicrocents });
            stopped = "budget";
            throw new BudgetStop("FLEET_EVAL_BUDGET_STOP");
          }
          o.log?.({ event: "call_start", cellId: req.cellId, turn: rec.turn, step: rec.step, phase: label, boundMicrocents: rec.boundMicrocents });
          let r: ChatResult;
          try {
            r = await provider.chat({ agentId: EVALUATION, system: EVAL_SYSTEM, messages: msgs, tools, maxTokens: req.maxTokens, deadlineAt: Date.now() + 170_000 });
          } catch (err) {
            const pe = err instanceof ProviderError ? err : null;
            rec.code = pe ? pe.code : "ERROR";
            rec.detail = pe ? (pe.info.detail ?? null) : String((err as Error).message).slice(0, 200);
            rec.charge = pe ? pe.info.charge : "estimate";
            rec.usage = pe?.info.usage;
            rec.costMicrocents = rec.charge === "none" ? 0 : rec.charge === "usage" && rec.usage ? costMicrocents(rec.usage, req.prices) : rec.boundMicrocents;
            spent += rec.costMicrocents;
            calls.push(rec);
            o.log?.({ event: "call_end", cellId: req.cellId, ...rec });
            stopped = "provider_error";
            throw Object.assign(new Error(rec.code), { code: "FLEET_COGNITION_PROVIDER_ERROR" });
          }
          rec.ok = true;
          rec.usage = r.usage;
          rec.costMicrocents = costMicrocents(r.usage, req.prices);
          rec.stopReason = r.stopReason ?? null;
          rec.responseModel = r.responseModel ?? null;
          rec.providerRequestId = r.providerRequestId ?? null;
          rec.thinkingBlocks = r.thinking?.length ?? 0;
          rec.content = r.content;
          rec.toolCalls = r.toolCalls.map((t) => ({ name: t.name, arguments: t.arguments }));
          spent += rec.costMicrocents;
          calls.push(rec);
          o.log?.({ event: "call_end", cellId: req.cellId, ...rec });
          return { content: r.content, toolCalls: r.toolCalls, usage: r.usage, chargedCents: 0, requestId: `eval-${calls.length}`, ...(r.thinking?.length ? { thinking: r.thinking, ...(r.blockOrder ? { blockOrder: r.blockOrder } : {}) } : {}) };
        },
      },
    });
    try {
      const t = await mind.turn(observation);
      turns.push(t);
      for (const rf of t.refusals) if (rf.code === "FLEET_TOOL_CALL_LIMIT") toolOutcomes.push({ phase: label, name: rf.tool, ok: false, refused: rf.code });
    } catch (err) {
      if (!stopped) throw err;
    }
    return bytes(packetText);
  };
  try {
    let trunkComplete = req.arm === "NOMEM";
    if (req.arm !== "NOMEM") {
      for (let i = 0; i < TRUNK_TURNS.length && !stopped; i++) {
        await turn(`trunk-${i + 1}`, TRUNK_TURNS[i], req.trunkMaxSteps);
        await new Promise((r) => setTimeout(r, 5)); // strictly ordered observedAt between turns (production store, real clock)
      }
      trunkComplete = !stopped;
    }
    const memoryFiles: Record<string, string> = {};
    for (const f of ["facts.json", "facts-ledger.json", "goals.json"]) if (fs.existsSync(path.join(dirs.mem, f))) memoryFiles[f] = fs.readFileSync(path.join(dirs.mem, f), "utf8");
    let memoryAfterTrunk: string[] | null = null;
    if (req.arm !== "NOMEM") {
      try { memoryAfterTrunk = currentFactTexts(dirs.mem, req.arm); } catch { memoryAfterTrunk = []; }
    }
    const maintenance = req.arm === "NOMEM" ? null : {
      rememberCalls: toolCallsSeen.filter((c) => c.name === "remember_fact").length,
      supersedesUsed: toolCallsSeen.filter((c) => c.name === "remember_fact" && Array.isArray(c.arguments?.supersedes) && (c.arguments.supersedes as unknown[]).length > 0).length,
      retractCalls: toolCallsSeen.filter((c) => c.name === "retract_fact").length,
    };
    let probePacketBytes = 0;
    if (!stopped) probePacketBytes = await turn("probe", PROBE2_TASK, req.probeMaxSteps);
    const texts = calls.filter((c) => c.phase === "probe" && c.ok && c.content && c.content.trim()).map((c) => c.content!.trim());
    const finalText = texts[texts.length - 1] ?? "";
    const base = { cellId: req.cellId, arm: req.arm, replicate: req.replicate, finalText, memoryAfterTrunk, maintenance, trunkComplete };
    return {
      ...base, evaluation: EVALUATION, model: provider.model, startedAt, finishedAt: new Date().toISOString(), calls, turns, stopped, spentMicrocents: spent,
      toolOutcomes, memoryFiles, probePacketBytes, score: scoreCell2(base), snapshot: {},
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────── plan

export interface Fresh2PlannedCell { cellId: string; phase: "P"; arm: Arm2; replicate: number; from: null; mandatory: true }
export const FRESH2_PLAN: readonly Fresh2PlannedCell[] = Object.freeze(
  Array.from({ length: REPLICATES2 }, (_, r) => ARMS2.map((arm): Fresh2PlannedCell => ({ cellId: `C-${arm}-${r + 1}`, phase: "P", arm, replicate: r + 1, from: null, mandatory: true }))).flat(),
);
export const TRUNK_MAX_STEPS = 4;
export const PROBE_MAX_STEPS = 3;

// ─────────────────────────────────────────────── deterministic fake founders (zero-cost dry runs and tests)

/**
 * A scripted founder with a named policy, reading the news lines and the packet:
 *   ideal          maintains memory perfectly (stable keys, same-key updates, `supersedes`, `retract_fact`); answers from current facts
 *   unlinked       writes every observation under a NEW key, never supersedes or retracts; at the probe it uses the latest
 *                  observedAt when the packet carries freshness, otherwise answers UNKNOWN where facts conflict (cautious)
 *   stalePicker    as unlinked, but without freshness it takes the FIRST matching fact (stale-prone)
 *   partial        stores only the first three news lines of each turn
 *   wrongMaintain  "corrects" in the wrong direction: supersedes the NEW fact with the OLD one, retracts the list price
 *   malformed      maintains like ideal but never prints a parseable ANSWERS line
 */
export type FakePolicy = "ideal" | "unlinked" | "stalePicker" | "partial" | "wrongMaintain" | "malformed";

const DOMAINS: Array<{ id: string; line: RegExp }> = [
  { id: "price", line: /listed at £([\d.]+)/ },
  { id: "fee", line: /transaction fee is ([\d.]+)%|fee is ([\d.]+)% of each sale/ },
  { id: "cost", line: /printed unit cost is £([\d.]+)/ },
  { id: "stock", line: /paper is (in stock|out of stock)/ },
  { id: "lead", line: /lead time is (?:now )?(\d+) business days/ },
  { id: "refund", line: /refund (?:within|window is now) (\d+) days/ },
  { id: "quota", line: /quota is (\d+) listings/ },
  { id: "cpc", line: /cost per click averaged £([\d.]+)/ },
  { id: "discount", line: /(bulk discount)/ },
];

export class FakeFounder2 implements CognitionProvider {
  readonly id = "scripted" as const;
  readonly model = "fake-founder-2";
  private turnNo = 0;
  private pending: ToolCall[] = [];
  constructor(private readonly policy: FakePolicy = "unlinked") {}
  async chat(req: { messages: ChatMessage[] }): Promise<ChatResult> {
    const usage = { inputTokens: Math.ceil(JSON.stringify(req.messages).length / 4) + 8_300, outputTokens: 120 };
    const reply = (content: string, toolCalls: ToolCall[] = []) => ({ content, toolCalls, usage, usageSource: "provider", stopReason: toolCalls.length ? "tool_use" : "end_turn", attempts: 1 } as ChatResult);
    const last = req.messages[req.messages.length - 1];
    // Like a compliant model, it never exceeds the mind's per-step execution limit: the rest follows after the tool results.
    const next = () => { const b = this.pending.splice(0, MAX_TOOL_CALLS_EXECUTED); return reply(b.length ? "Recording news." : "Done for this turn.", b); };
    if (last.role === "tool") return next();
    const obs = String(last.content);
    const packetMsg = req.messages.find((m) => m.role === "user" && String(m.content).startsWith("TASK PACKET"));
    const knowledge: TaskPacket["knowledge"] = packetMsg ? (JSON.parse(String(packetMsg.content).split("\n").find((l) => l.startsWith("{")) ?? "{}") as TaskPacket).knowledge ?? [] : [];
    if (/^Date: 2026-10-01\. PROBE/.test(obs)) return reply(this.probe(knowledge));
    this.turnNo++;
    const lines = obs.split("\n").filter((l) => l.startsWith("- "));
    const calls: ToolCall[] = [];
    let n = 0;
    const id = () => `t${this.turnNo}-${++n}`;
    const used = this.policy === "partial" ? lines.slice(0, 3) : lines;
    for (const l of used) {
      const d = DOMAINS.find((x) => x.line.test(l));
      if (!d) continue;
      const text = l.slice(2);
      if (this.policy === "ideal" || this.policy === "malformed") {
        if (d.id === "discount" && /no bulk discount|wrong/.test(text)) { calls.push({ id: id(), name: "retract_fact", arguments: { key: "discount", reason: text } }); continue; }
        calls.push({ id: id(), name: "remember_fact", arguments: { key: d.id, value: text, source: "news" } });
      } else if (this.policy === "wrongMaintain") {
        if (d.id === "discount" && /no bulk discount|wrong/.test(text)) { calls.push({ id: id(), name: "retract_fact", arguments: { key: "cost_t1", reason: "wrong direction" } }); continue; }
        const key = `${d.id}_t${this.turnNo}`;
        calls.push({ id: id(), name: "remember_fact", arguments: { key, value: text } });
        if (this.turnNo > 1) calls.push({ id: id(), name: "remember_fact", arguments: { key: `${d.id}_restore`, value: knowledge.find((k) => k.key.startsWith(d.id))?.value ?? text, supersedes: [key] } });
      } else {
        calls.push({ id: id(), name: "remember_fact", arguments: { key: `${d.id}_t${this.turnNo}`, value: text } });
      }
    }
    this.pending = calls;
    return next();
  }
  private probe(k: TaskPacket["knowledge"]): string {
    if (this.policy === "malformed") return "I would rather not commit to numbers today.";
    const fresh = k.length > 0 && k.every((f) => !!f.observedAt);
    const pick = (re: RegExp): string | null => {
      const hits = k.map((f) => ({ f, m: re.exec(f.value) })).filter((x) => x.m && !/^(RETRACTED|SUPERSEDED)/.test(x.f.value));
      if (!hits.length) return null;
      const vals = [...new Set(hits.map((h) => h.m![1]))];
      if (vals.length === 1) return vals[0];
      if (fresh) return hits.sort((a, b) => String(b.f.observedAt).localeCompare(String(a.f.observedAt)))[0].m![1];
      return this.policy === "stalePicker" ? hits[0].m![1] : null; // cautious: conflicting and undated → UNKNOWN
    };
    const price = pick(/listed at £([\d.]+)/);
    const fee = pick(/(?:transaction )?fee is ([\d.]+)%/);
    const stock = pick(/paper is (in stock|out of stock)/);
    const lead = pick(/lead time is (?:now )?(\d+) business days/);
    const refund = pick(/refund (?:within|window is now) (\d+) days/);
    const discountActive = k.some((f) => /bulk discount, which would make/.test(f.value) && !/^(RETRACTED|SUPERSEDED)/.test(f.value));
    const cost = discountActive && !fresh && this.policy === "stalePicker" ? "1.40" : pick(/printed unit cost is £([\d.]+)/);
    const quota = pick(/quota is (\d+) listings/);
    const cpc = pick(/cost per click averaged £([\d.]+)/);
    const q9 = fee && cost ? (15 - 15 * Number(fee) / 100 - 2 * Number(cost)).toFixed(2) : null;
    const q10 = stock && lead ? (stock === "out of stock" || Number(lead) > 10 ? "NO" : "YES") : null;
    const v = (x: string | null) => x ?? "UNKNOWN";
    return `From memory.\nANSWERS: q1=${v(price)}; q2=${v(fee)}; q3=${stock ? (stock === "out of stock" ? "OUT" : "IN") : "UNKNOWN"}; q4=${v(lead)}; q5=${v(refund)}; q6=${v(cost)}; q7=${v(quota)}; q8=${v(cpc)}; q9=${v(q9)}; q10=${v(q10)}`;
  }
}

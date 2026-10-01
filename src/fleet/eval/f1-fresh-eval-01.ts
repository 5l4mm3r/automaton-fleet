/**
 * F1-FRESH-EVAL-01 — does structured fact freshness (F1-FRESH-01) change downstream decisions, compared with the BEST
 * REALISTIC legacy string memory?
 *
 * Design (pre-registered; see PRE_REGISTRATION and docs/evaluations/f1-fresh-eval-01/README.md):
 *
 *   Shared trunk (deterministic, no model): the founder's lived sequence of memory operations at fixed times. Two kinds:
 *     KNOWN corrections — the founder knows the old fact is wrong: FRESH uses `supersedes` / `retract_fact`; LEGACY does
 *       what the old architecture could physically do with the same knowledge: overwrite the old key's string
 *       ("SUPERSEDED by …" / "RETRACTED: …"). Both remove the wrong value from current memory: parity guards.
 *     UNLINKED updates — the founder records a newer, contradicting observation under a NEW key without touching the
 *       old one (the F1-EVAL-02 failure mode, identical in both arms). Old and new are worded identically except for the
 *       value. Only F1-FRESH-01's observedAt can tell them apart: the discriminating cases.
 *   Every probe starts severed: no provider history; the packet + the task only.
 *
 *   Arms (identical task, identical trunk intents, identical system prompt and tool definitions):
 *     FRESH   production fact store, production packet builder, production toolbox.
 *     LEGACY  plain string facts: the same tool schemas, executed as string overwrites (no observedAt, provenance,
 *             lifecycle history or staleness hint); the packet is the production packet without the three fields
 *             F1-FRESH-01 added. The discriminating control.
 *     NOMEM   no persisted memory, no packet (negative control).
 *
 *   Probe: four closed numeric questions (q1, q2, q4 discriminating; q3 a parity guard on retraction); every wrong value
 *   maps to a specific stale or retracted fact. Scoring parses one `ANSWERS:` line deterministically.
 *
 * Only the LEGACY control re-implements old behaviour (unavoidable for a control); the FRESH arm runs production code.
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import {
  FOUNDER_CHARTER_V2, FOUNDER_EXPERIMENT_TOOLS, FOUNDER_ROUTED_ADDENDUM_R23, FOUNDER_ROUTED_TOOLS, ProviderError,
  type ChatMessage, type ChatResult, type CognitionProvider, type ToolCall, type ToolSpec,
} from "../cognition/types.js";
import { toolsFor } from "../cognition/gateway.js";
import { costMicrocents, type Prices } from "../cognition/charging.js";
import { FounderMind, type TurnResult } from "../founder/mind.js";
import { FounderToolbox, type ToolOutcome } from "../founder/toolbox.js";
import { FOUNDER_MANIFEST_V2 } from "../capabilities.js";
import { buildTaskPacket, renderTaskPacket, type TaskPacket } from "../cognition/task-packet.js";
import { rememberFact, retractFact } from "../founder/facts.js";
import { BudgetStop, worstCaseMicrocents, type CallRecord } from "./f1-eval-02.js";

export const EVALUATION = "f1-fresh-eval-01";
/** Hard ceiling of this evaluation (the driver refuses a config above it): $1.50. */
export const FRESH_CAP_CEILING_MICROCENTS = 150_000_000;

export type FreshArm = "FRESH" | "LEGACY" | "NOMEM";
export const ARMS: readonly FreshArm[] = ["FRESH", "LEGACY", "NOMEM"];
export const REPLICATES = 3;

/**
 * The production routed T2 prefix (routed-gateway: an ordinary step): charter + routed addendum; the founder tools,
 * the two cognition tools and — the pipeline is on in production — the experiment tools. Identical in every arm.
 */
// The sealed evaluations' instrument: the charter and routed addendum as they were run (frozen; F2 changed production's).
export const EVAL_SYSTEM = `${FOUNDER_CHARTER_V2}\n${FOUNDER_ROUTED_ADDENDUM_R23}`;
export function evalTools(): ToolSpec[] {
  const allowed = new Set(FOUNDER_MANIFEST_V2.allowed as readonly string[]);
  return [...toolsFor([...allowed]), ...FOUNDER_ROUTED_TOOLS.filter((t) => allowed.has(t.capability)), ...FOUNDER_EXPERIMENT_TOOLS.filter((t) => allowed.has(t.capability))];
}

// ─────────────────────────────────────────────── the shared trunk (intents at fixed times)

type Intent =
  | { at: string; op: "goal_set"; id: string; title: string }
  | { at: string; op: "goal_complete"; id: string; outcome: string }
  | { at: string; op: "remember"; key: string; value: string; source?: string; supersedes?: string[] }
  | { at: string; op: "retract"; key: string; reason: string };

export const TRUNK: readonly Intent[] = Object.freeze([
  { at: "2026-09-20T09:00:00.000Z", op: "goal_set", id: "g1", title: "Validate O7: listing test of the rent-tracker spreadsheet template on Stallhub" },
  { at: "2026-09-20T09:05:00.000Z", op: "remember", key: "o7_status", value: "Goal g1 is OPEN: the O7 listing test is still running.", source: "goal:g1" },
  { at: "2026-09-20T09:10:00.000Z", op: "remember", key: "o7_price", value: "O7 single-template price: £12.00.", source: "https://stallhub.example/listing/o7" },
  { at: "2026-09-20T09:12:00.000Z", op: "remember", key: "stallhub_fee_rate", value: "Stallhub transaction fee: 6.5% of each sale.", source: "https://stallhub.example/help/fees" },
  { at: "2026-09-20T09:15:00.000Z", op: "remember", key: "printing_cost", value: "Printed unit cost: £2.00 at the PrintCo list price.", source: "https://printco.example/prices" },
  { at: "2026-09-22T14:00:00.000Z", op: "remember", key: "printco_discount", value: "PrintCo bulk discount 30%: printed unit cost £1.40.", source: "https://forum.example/t/printco-bulk" },
  { at: "2026-09-28T17:00:00.000Z", op: "goal_complete", id: "g1", outcome: "Listing test finished: 4 sales in two weeks." },
  // KNOWN correction (parity): the founder retires the status it knows is outdated.
  { at: "2026-09-28T17:05:00.000Z", op: "remember", key: "o7_result", value: "Goal g1 COMPLETE: the O7 listing test has finished.", source: "goal:g1", supersedes: ["o7_status"] },
  // UNLINKED updates (discriminating): newer observations under new keys; the old keys are not touched.
  { at: "2026-09-29T10:00:00.000Z", op: "remember", key: "price_o7", value: "O7 single-template price: £13.50.", source: "https://stallhub.example/listing/o7" },
  { at: "2026-10-01T08:00:00.000Z", op: "remember", key: "fee_rate_stallhub", value: "Stallhub transaction fee: 9% of each sale.", source: "https://stallhub.example/fees" },
  // KNOWN correction (parity): the founder retracts the discount it knows is false.
  { at: "2026-10-01T08:30:00.000Z", op: "retract", key: "printco_discount", reason: "PrintCo confirmed that no bulk discount exists; the forum post was wrong." },
] as Intent[]);

// ─────────────────────────────────────────────── LEGACY string semantics (best realistic old behaviour)

/**
 * What the old architecture could do with the same intents: one Record<string,string>, no metadata, no history.
 *   remember (same key)        overwrite
 *   remember + supersedes      write the new key; overwrite each superseded key with "SUPERSEDED by <key>: <value>"
 *   retract                    overwrite the value with "RETRACTED: <reason>"
 *   source                     not stored (the old store had no provenance)
 */
export const LEGACY_SUPERSEDED = (by: string, value: string) => `SUPERSEDED by ${by}: ${value}`;
export const LEGACY_RETRACTED = (reason: string) => `RETRACTED: ${reason}`;

function legacyRead(memoryDir: string): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(path.join(memoryDir, "facts.json"), "utf8")) as Record<string, string>; } catch { return {}; }
}
function legacyWrite(memoryDir: string, facts: Record<string, string>): void {
  fs.writeFileSync(path.join(memoryDir, "facts.json"), JSON.stringify(facts, null, 2), { mode: 0o600 });
}
export function legacyRemember(memoryDir: string, key: string, value: string, supersedes: readonly string[] = []): string {
  const facts = legacyRead(memoryDir);
  facts[key] = value;
  for (const k of supersedes) if (k !== key && k in facts) facts[k] = LEGACY_SUPERSEDED(key, value);
  legacyWrite(memoryDir, facts);
  return "remembered";
}
export function legacyRetract(memoryDir: string, key: string, reason: string): boolean {
  const facts = legacyRead(memoryDir);
  if (!(key in facts)) return false;
  facts[key] = LEGACY_RETRACTED(reason);
  legacyWrite(memoryDir, facts);
  return true;
}

/** Apply the trunk under the given semantics. FRESH = the production fact store; LEGACY = string overwrites. */
export function applyTrunk(memoryDir: string, semantics: "fresh" | "legacy"): void {
  fs.mkdirSync(memoryDir, { recursive: true, mode: 0o700 });
  const goals: Array<Record<string, unknown>> = [];
  if (semantics === "legacy") legacyWrite(memoryDir, {});
  for (const i of TRUNK) {
    const now = () => new Date(i.at);
    if (i.op === "goal_set") goals.push({ id: i.id, title: i.title, rationale: "", status: "open", at: i.at });
    else if (i.op === "goal_complete") {
      const g = goals.find((x) => x.id === i.id)!;
      g.status = "complete";
      g.outcome = i.outcome;
      if (semantics === "fresh") g.completedAt = i.at; // the legacy toolbox did not record completion times
    } else if (i.op === "remember") {
      if (semantics === "fresh") {
        const r = rememberFact(memoryDir, { key: i.key, value: i.value, ...(i.source ? { source: i.source } : {}), ...(i.supersedes ? { supersedes: i.supersedes } : {}), now });
        if (!r.ok) throw new Error(`trunk: ${i.key}: ${r.code}`);
      } else legacyRemember(memoryDir, i.key, i.value, i.supersedes ?? []);
    } else if (semantics === "fresh") {
      const r = retractFact(memoryDir, { key: i.key, reason: i.reason, now });
      if (!r.ok) throw new Error(`trunk: retract ${i.key}: ${r.code}`);
    } else if (!legacyRetract(memoryDir, i.key, i.reason)) throw new Error(`trunk: legacy retract ${i.key}`);
  }
  fs.writeFileSync(path.join(memoryDir, "goals.json"), JSON.stringify(goals, null, 2), { mode: 0o600 });
}

/** The LEGACY toolbox: the same tool schemas, string semantics (see above). Recall has the production shape, minus metadata. */
export function legacyFactTool(memoryDir: string, call: ToolCall): ToolOutcome | null {
  const a = call.arguments ?? {};
  const str = (v: unknown, n: number) => (typeof v === "string" && v ? v.slice(0, n) : null);
  if (call.name === "remember_fact") {
    const key = str(a.key, 100);
    const value = typeof a.value === "string" ? a.value.slice(0, 4000) : null;
    if (!key || value === null) return { name: call.name, ok: false, refused: "FLEET_BAD_REQUEST", output: "key and value required" };
    const sup = Array.isArray(a.supersedes) ? a.supersedes.filter((k): k is string => typeof k === "string").slice(0, 10) : [];
    return { name: call.name, ok: true, output: legacyRemember(memoryDir, key, value, sup) };
  }
  if (call.name === "retract_fact") {
    const key = str(a.key, 100);
    const reason = str(a.reason, 300);
    if (!key || !reason) return { name: call.name, ok: false, refused: "FLEET_BAD_REQUEST", output: "key and reason required" };
    return legacyRetract(memoryDir, key, reason) ? { name: call.name, ok: true, output: "overwritten with the retraction" } : { name: call.name, ok: false, refused: "FLEET_NOT_FOUND", output: "not a fact" };
  }
  if (call.name === "recall_facts") {
    const q = typeof a.query === "string" ? a.query.toLowerCase() : "";
    const current = Object.fromEntries(Object.entries(legacyRead(memoryDir)).filter(([k, v]) => !q || k.toLowerCase().includes(q) || v.toLowerCase().includes(q))
      .map(([k, v]) => [k, { value: v, status: "current" }]));
    return { name: call.name, ok: true, output: JSON.stringify({ current, ...(a.includeHistory === true ? { history: [] } : {}) }) };
  }
  return null;
}

const UNCERTAIN = /uncertain|unknown|open[ _-]?question|risk|assumption|unverified|missing|caveat/i;

/** The packet the pre-F1-FRESH-01 builder produced for the same memory: the production packet minus the added fields. */
export function legacyPacket(p: TaskPacket): TaskPacket {
  const knowledge = p.knowledge.map((k) => ({ key: k.key, value: k.value, source: k.source }));
  const uncertainty = knowledge.filter((f) => UNCERTAIN.test(f.key) || UNCERTAIN.test(f.value.slice(0, 200))).map((f) => f.key);
  const q: TaskPacket = { ...p, knowledge, uncertainty, sizes: { ...p.sizes } };
  q.sizes.knowledge = Buffer.byteLength(JSON.stringify(knowledge));
  q.sizes.uncertainty = Buffer.byteLength(JSON.stringify(uncertainty));
  return q;
}

// ─────────────────────────────────────────────── the probe

export const PROBE_TASK = [
  "PROBE (decision, from memory only). You are planning the next step for opportunity O7 (the rent-tracker spreadsheet template sold on Stallhub).",
  "Use only your own memory: the facts and goals you hold. Do not research; do not request spending. If your memory does not settle a question, answer UNKNOWN for it.",
  "Answer four questions, then end your final message with exactly one line in this form:",
  "ANSWERS: q1=<O7 single-template price in £ to use now, or UNKNOWN>; q2=<Stallhub transaction fee in percent to use now, or UNKNOWN>; q3=<printed unit cost in £ to use now, or UNKNOWN>; q4=<net margin in £ per sale of a £15 bundle containing 2 printed units, after the Stallhub fee on the £15 price, rounded to 2 decimals, or UNKNOWN>",
].join("\n");

export const PROBE_CONTRACT: TaskPacket["outputContract"] = { form: "decision", mustCite: false, instructions: "Answer the four questions from memory, then the single ANSWERS line." };

/** Ground truth and the specific wrong values (pre-registered). q4 = 15 − 15·fee − 2·cost. */
export const KEY = Object.freeze({
  q1: { role: "discriminating (unlinked update; observedAt)", correct: [13.5], stale: [12] },
  q2: { role: "discriminating (unlinked update; observedAt)", correct: [9], stale: [6.5] },
  q3: { role: "parity guard (known retraction)", correct: [2.0], retracted: [1.4] },
  q4: { role: "discriminating (depends on q2)", correct: [9.65], stale: [10.025], retracted: [10.85], staleRetracted: [11.225], tolerance: 0.02 },
});

export type AnswerClass = "correct" | "stale" | "retracted" | "stale+retracted" | "unknown" | "other" | "missing";

export function parseAnswers(text: string): Record<"q1" | "q2" | "q3" | "q4", string> | null {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => /^\**\s*ANSWERS\s*:/i.test(l));
  if (!lines.length) return null;
  const body = lines[lines.length - 1].replace(/^\**\s*ANSWERS\s*:\s*/i, "").replace(/\*+$/, "");
  const out: Record<string, string> = {};
  for (const part of body.split(";")) {
    const m = /^\s*(q[1-4])\s*=\s*(.*?)\s*$/i.exec(part);
    if (m) out[m[1].toLowerCase()] = m[2];
  }
  return ["q1", "q2", "q3", "q4"].every((k) => k in out) ? (out as Record<"q1" | "q2" | "q3" | "q4", string>) : null;
}

/** Answer normalisation (pre-registered in SCORING_RULES). */
export const SCORING_RULES = "last ANSWERS line wins; values split on ';'; strip quotes/backticks/asterisks and trailing .,;:) ; numbers may carry £/$ prefix or % suffix; q1 ±0.005; q2 exact; q3 ±0.005; q4 ±0.02; UNKNOWN is its own class";
const clean = (s: string) => s.trim().replace(/^[`"'*\s]+|[`"'*\s]+$/g, "").replace(/[.,;:)]+$/, "").trim();
const num = (s: string): number | null => {
  const m = /^[£$]?\s*(-?\d+(?:\.\d+)?)\s*%?$/.exec(clean(s));
  return m ? Number(m[1]) : null;
};
const near = (v: number, xs: readonly number[], tol = 1e-9) => xs.some((x) => Math.abs(v - x) <= tol);

export function classify(q: "q1" | "q2" | "q3" | "q4", raw: string | undefined): AnswerClass {
  if (raw === undefined) return "missing";
  const s = clean(raw);
  if (/^unknown$/i.test(s)) return "unknown";
  const n = num(s);
  if (n === null) return "other";
  if (q === "q1") return near(n, KEY.q1.correct, 0.005) ? "correct" : near(n, KEY.q1.stale, 0.005) ? "stale" : "other";
  if (q === "q2") return near(n, KEY.q2.correct) ? "correct" : near(n, KEY.q2.stale) ? "stale" : "other";
  if (q === "q3") return near(n, KEY.q3.correct, 0.005) ? "correct" : near(n, KEY.q3.retracted, 0.005) ? "retracted" : "other";
  const t = KEY.q4.tolerance;
  return near(n, KEY.q4.correct, t) ? "correct" : near(n, KEY.q4.staleRetracted, t) ? "stale+retracted"
    : near(n, KEY.q4.stale, t) ? "stale" : near(n, KEY.q4.retracted, t) ? "retracted" : "other";
}

export interface ProbeScore { cellId: string; arm: FreshArm; parsed: boolean; answers: Record<string, string> | null; classes: Record<"q1" | "q2" | "q3" | "q4", AnswerClass> }

export function scoreProbe(cellId: string, arm: FreshArm, finalText: string): ProbeScore {
  const a = parseAnswers(finalText);
  const classes = { q1: classify("q1", a?.q1), q2: classify("q2", a?.q2), q3: classify("q3", a?.q3), q4: classify("q4", a?.q4) };
  return { cellId, arm, parsed: !!a, answers: a, classes };
}

/**
 * PRE-REGISTERED decision rule (fixed before any paid call; its sha256 is recorded in the evaluation config).
 * Counts are over 3 replicates × 4 questions = 12 answers per arm. Thresholds unchanged from the first AMBER design.
 */
export const PRE_REGISTRATION = Object.freeze({
  replicatesPerArm: REPLICATES,
  validity: { minParsedCells: 8, of: 9 },
  negativeControl: { maxNomemCorrect: 1 },
  fresh: { minCorrect: 10, maxRetractedUse: 0, maxStaleUse: 1 },
  discrimination: { minCorrectAdvantage: 3, minStaleOrRetractedUseAdvantage: 2 },
  verdicts: {
    PROVEN: "validity, negative control, FRESH pass and discrimination all hold",
    NOT_PROVEN: "validity and negative control hold, but FRESH pass or discrimination fails",
    INCONCLUSIVE: "validity or negative control fails (the instrument, not the hypothesis, failed)",
  },
});
export const PRE_REGISTRATION_SHA256 = crypto.createHash("sha256").update(JSON.stringify({ PRE_REGISTRATION, KEY, PROBE_TASK, TRUNK, SCORING_RULES, EVAL_SYSTEM_SHA: crypto.createHash("sha256").update(EVAL_SYSTEM).digest("hex"), LEGACY: [LEGACY_SUPERSEDED("k", "v"), LEGACY_RETRACTED("r")] })).digest("hex");

export interface ArmSummary { arm: FreshArm; cells: number; parsed: number; correct: number; stale: number; retracted: number; unknown: number; other: number; missing: number }

export function summarize(scores: ProbeScore[]): { arms: Record<FreshArm, ArmSummary>; checks: Record<string, boolean>; verdict: "PROVEN" | "NOT_PROVEN" | "INCONCLUSIVE" } {
  const arms = Object.fromEntries(ARMS.map((a) => [a, { arm: a, cells: 0, parsed: 0, correct: 0, stale: 0, retracted: 0, unknown: 0, other: 0, missing: 0 }])) as Record<FreshArm, ArmSummary>;
  for (const s of scores) {
    const x = arms[s.arm];
    x.cells++;
    if (s.parsed) x.parsed++;
    for (const c of Object.values(s.classes)) {
      if (c === "correct") x.correct++;
      else if (c === "stale") x.stale++;
      else if (c === "retracted") x.retracted++;
      else if (c === "stale+retracted") { x.stale++; x.retracted++; }
      else if (c === "unknown") x.unknown++;
      else if (c === "other") x.other++;
      else x.missing++;
    }
  }
  const P = PRE_REGISTRATION;
  const f = arms.FRESH, l = arms.LEGACY, n = arms.NOMEM;
  const checks = {
    validity: f.parsed + l.parsed + n.parsed >= P.validity.minParsedCells && f.cells + l.cells + n.cells === P.validity.of,
    negativeControl: n.correct <= P.negativeControl.maxNomemCorrect,
    freshPass: f.correct >= P.fresh.minCorrect && f.retracted <= P.fresh.maxRetractedUse && f.stale <= P.fresh.maxStaleUse,
    discrimination: f.correct - l.correct >= P.discrimination.minCorrectAdvantage
      && (l.stale + l.retracted) - (f.stale + f.retracted) >= P.discrimination.minStaleOrRetractedUseAdvantage,
  };
  const verdict = !checks.validity || !checks.negativeControl ? "INCONCLUSIVE" : checks.freshPass && checks.discrimination ? "PROVEN" : "NOT_PROVEN";
  return { arms, checks, verdict };
}

// ─────────────────────────────────────────────── one probe cell

export interface FreshCellRequest {
  cellId: string;
  arm: FreshArm;
  replicate: number;
  maxSteps: number;
  maxTokens: number;
  prices: Prices;
  budgetMicrocents: number;
}

export interface FreshCellResult {
  cellId: string;
  evaluation: typeof EVALUATION;
  arm: FreshArm;
  replicate: number;
  model: string;
  startedAt: string;
  finishedAt: string;
  calls: CallRecord[];
  turns: TurnResult[];
  stopped: null | "budget" | "provider_error";
  spentMicrocents: number;
  toolOutcomes: Array<{ name: string; ok: boolean; refused?: string }>;
  /** sha256 of the memory the arm started from (identical across replicates of an arm). */
  memorySha256: string | null;
  packet: TaskPacket | null;
  packetBytes: number;
  toolNames: string[];
  finalText: string;
  score: ProbeScore;
  /** The driver persists a snapshot per cell; probes have no state to carry forward. */
  snapshot: Record<string, string>;
}

const bytes = (v: unknown) => Buffer.byteLength(typeof v === "string" ? v : JSON.stringify(v), "utf8");

function memoryDigest(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const h = crypto.createHash("sha256");
  for (const f of fs.readdirSync(dir).sort()) h.update(`${f}\0`).update(fs.readFileSync(path.join(dir, f)));
  return h.digest("hex");
}

export async function runFreshCell(req: FreshCellRequest, provider: CognitionProvider, o: { log?: (e: Record<string, unknown>) => void } = {}): Promise<FreshCellResult> {
  if (!ARMS.includes(req.arm)) throw new Error(`unknown arm ${String(req.arm)}`);
  const startedAt = new Date().toISOString();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-f1-fresh-eval-01-"));
  const dirs = { ws: path.join(root, "workspace"), mem: path.join(root, "memory"), st: path.join(root, "state") };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  try {
    if (req.arm !== "NOMEM") applyTrunk(dirs.mem, req.arm === "FRESH" ? "fresh" : "legacy");
    const memorySha256 = req.arm === "NOMEM" ? null : memoryDigest(dirs.mem);
    let packet: TaskPacket | null = null;
    let packetText = "";
    if (req.arm !== "NOMEM") {
      const built = buildTaskPacket({ memoryDir: dirs.mem, workspaceDir: dirs.ws, task: PROBE_TASK, outputContract: PROBE_CONTRACT, economics: {} });
      packet = req.arm === "LEGACY" ? legacyPacket(built) : built;
      packetText = renderTaskPacket(packet);
      // Severed: no provider conversation exists; the packet is the first message of a fresh conversation.
      fs.writeFileSync(path.join(dirs.st, "mind-history.json"), JSON.stringify([{ role: "user", content: packetText }]), { mode: 0o600 });
    }
    const toolbox = new FounderToolbox({
      manifest: FOUNDER_MANIFEST_V2, workspaceDir: dirs.ws, memoryDir: dirs.mem,
      ports: {
        ledger: async () => ({ note: "evaluation: no ledger" }),
        spendOrder: async () => ({ status: "refused", code: "FLEET_EVAL_NO_SPEND", reason: "evaluation environment" }),
        proposeKnowledge: async () => ({ status: "refused", reason: "evaluation environment" }),
        knowledge: async () => ({ items: [] }),
        requestIdentityFact: async () => ({ status: "refused", reason: "evaluation environment" }),
        // no researchFetch port: web research is unavailable (memory-only probe)
      },
    });
    const toolOutcomes: FreshCellResult["toolOutcomes"] = [];
    const exec = toolbox.execute.bind(toolbox);
    toolbox.execute = async (call: ToolCall) => {
      const legacyOut = req.arm === "LEGACY" ? legacyFactTool(dirs.mem, call) : null;
      const out = legacyOut ?? await exec(call);
      toolOutcomes.push({ name: out.name, ok: out.ok, ...(out.refused ? { refused: out.refused } : {}) });
      return out;
    };
    // Identical prefix in every arm (the production routed T2 step): the arms differ only in memory semantics.
    const tools = evalTools();
    const calls: CallRecord[] = [];
    let spent = 0;
    let stopped: FreshCellResult["stopped"] = null;
    let step = 0;
    const mind = new FounderMind({
      toolbox, stateDir: dirs.st, maxStepsPerTurn: req.maxSteps,
      ports: {
        cognitionStatus: async () => ({ policyEnabled: true, provider: provider.id, founderEnabled: true, paused: false }),
        infer: async (messages) => {
          const msgs = messages as ChatMessage[];
          const requestBytes = bytes({ system: EVAL_SYSTEM, messages: msgs, tools });
          const rec: CallRecord = {
            turn: 1, step: step++, ok: false, requestBytes, contextBytes: bytes(msgs), messages: msgs.length,
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
          o.log?.({ event: "call_start", cellId: req.cellId, turn: rec.turn, step: rec.step, boundMicrocents: rec.boundMicrocents });
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
    const turns: TurnResult[] = [];
    try {
      turns.push(await mind.turn(PROBE_TASK));
    } catch (err) {
      if (!stopped) throw err;
    }
    const texts = calls.filter((c) => c.ok && c.content && c.content.trim()).map((c) => c.content!.trim());
    const finalText = texts[texts.length - 1] ?? "";
    return {
      cellId: req.cellId, evaluation: EVALUATION, arm: req.arm, replicate: req.replicate, model: provider.model, startedAt, finishedAt: new Date().toISOString(),
      calls, turns, stopped, spentMicrocents: spent, toolOutcomes, memorySha256, packet, packetBytes: packetText ? bytes(packetText) : 0,
      toolNames: tools.map((t) => t.name), finalText, score: scoreProbe(req.cellId, req.arm, finalText), snapshot: {},
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────── plan and the deterministic fake model

export interface FreshPlannedCell { cellId: string; phase: "P"; arm: FreshArm; replicate: number; from: null; maxSteps: number; mandatory: true }

/** Interleaved by replicate (FRESH, LEGACY, NOMEM, FRESH, …) so a budget stop never leaves one arm without data. */
export const FRESH_PLAN: readonly FreshPlannedCell[] = Object.freeze(
  Array.from({ length: REPLICATES }, (_, r) => ARMS.map((arm): FreshPlannedCell => ({ cellId: `P-${arm}-${r + 1}`, phase: "P", arm, replicate: r + 1, from: null, maxSteps: 3, mandatory: true }))).flat(),
);

/**
 * A naive, deterministic model for the zero-cost dry run. Per question it takes the matching fact with the LATEST
 * observedAt when the packet carries freshness, otherwise the FIRST match in packet order; facts overwritten as
 * SUPERSEDED/RETRACTED carry no value and never match; no packet → UNKNOWN. It proves the instrument separates the
 * arms for the intended reason (freshness metadata resolves an unlinked contradiction; string memory cannot). It says
 * nothing about how a real model behaves.
 */
export class FakeFreshModel implements CognitionProvider {
  readonly id = "scripted" as const;
  readonly model = "fake-fresh-model";
  async chat(req: { messages: ChatMessage[] }): Promise<ChatResult> {
    const packetMsg = req.messages.find((m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("TASK PACKET"));
    let facts: TaskPacket["knowledge"] = [];
    if (packetMsg) {
      const body = String(packetMsg.content).split("\n").find((l) => l.startsWith("{"));
      facts = body ? (JSON.parse(body) as TaskPacket).knowledge : [];
    }
    const pick = (re: RegExp): string | null => {
      const hits = facts.map((f) => ({ f, m: re.exec(f.value) })).filter((x) => x.m);
      if (!hits.length) return null;
      const dated = hits.filter((x) => x.f.observedAt);
      const best = dated.length === hits.length ? dated.sort((a, b) => String(b.f.observedAt).localeCompare(String(a.f.observedAt)))[0] : hits[0];
      return best.m![1];
    };
    const price = pick(/^O7 single-template price: £(\d+(?:\.\d+)?)/);
    const fee = pick(/^Stallhub transaction fee: (\d+(?:\.\d+)?)%/);
    const cost = pick(/unit cost:? £(\d+(?:\.\d+)?)/i);
    const q4 = fee && cost ? (15 - 15 * Number(fee) / 100 - 2 * Number(cost)).toFixed(2) : "UNKNOWN";
    const content = `Decision from memory.\nANSWERS: q1=${price ?? "UNKNOWN"}; q2=${fee ?? "UNKNOWN"}; q3=${cost ?? "UNKNOWN"}; q4=${q4}`;
    const inputTokens = Math.ceil(JSON.stringify(req.messages).length / 4) + 8_300;
    return { content, toolCalls: [], usage: { inputTokens, outputTokens: 60 }, usageSource: "provider", stopReason: "end_turn", attempts: 1 } as ChatResult;
  }
}

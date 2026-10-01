/**
 * F1-FRESH-01 — founder facts with structured freshness (founder-private memory, Layer 2).
 *
 * F1-EVAL-02 showed a stale status fact surviving as current truth ("… goal g1 open" after g1 was completed): plain
 * `Record<string,string>` facts carry no time, no lifecycle and no provenance, and an update overwrote the previous
 * value without a trace.
 *
 * Representation (rollback-safe by construction):
 *   memory/facts.json         Record<key, value string> — the CURRENT facts only, in exactly the legacy shape. Every
 *                             reader (older runtimes, the wake digest, packet builders, escalation) keeps working, and
 *                             a superseded or retracted value can never be read as current truth by any of them.
 *   memory/facts-ledger.json  fleet-facts-v1: metadata of the current facts (observedAt, source, sha256 of the value)
 *                             and the append-only audit history of superseded and retracted values.
 *
 * Freshness is never invented: a legacy fact (no ledger entry), or a value changed outside this store (its sha256 no
 * longer matches the ledger), has observedAt null and source null. Malformed data fails closed (FactStoreError):
 * nothing is rewritten from a guessed empty state.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";

export const FACTS_FILE = "facts.json";
export const FACT_LEDGER_FILE = "facts-ledger.json";
export const FACT_LEDGER_VERSION = "fleet-facts-v1";
export const FACT_LIMITS = Object.freeze({ current: 500, history: 2_000, keyChars: 100, valueChars: 4_000, sourceChars: 300, reasonChars: 300, supersedes: 10 });

export type FactStatus = "current" | "superseded" | "retracted";

/** Where a fact came from, as the founder stated it (never inferred). */
export interface FactSource { attemptId?: string; url?: string; ref?: string }

export interface FactRecord {
  key: string;
  value: string;
  status: FactStatus;
  /** When this value was recorded through the store (ISO); null when unknown (legacy or changed outside the store). */
  observedAt: string | null;
  source: FactSource | null;
  /** superseded: the key whose value replaced this one (the same key for an in-place update). */
  supersededBy?: string | null;
  /** When the value stopped being current (superseded or retracted). */
  endedAt?: string | null;
  /** retracted: why. */
  reason?: string | null;
}

interface LedgerMeta { observedAt: string | null; source: FactSource | null; valueSha256: string }
interface FactLedger {
  version: typeof FACT_LEDGER_VERSION;
  current: Record<string, LedgerMeta>;
  history: FactRecord[];
  /** Oldest history entries dropped at the history bound (counted, never silent). */
  trimmed: number;
}

export class FactStoreError extends Error {
  readonly code = "FLEET_FACTS_MALFORMED";
}

const sha = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** A founder-stated source string → structured provenance: an attemptId, an https URL, or an opaque reference. */
export function parseSource(s: unknown): FactSource | null {
  if (typeof s !== "string" || !s.trim()) return null;
  const t = s.trim().slice(0, FACT_LIMITS.sourceChars);
  if (UUID.test(t)) return { attemptId: t.toLowerCase() };
  if (/^https?:\/\/\S+$/i.test(t)) return { url: t };
  return { ref: t };
}

export function sourceLabel(s: FactSource | null): string | null {
  if (!s) return null;
  return s.attemptId ? `attemptId ${s.attemptId}` : s.url ? s.url : s.ref ?? null;
}

function readStrict(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new FactStoreError(`${path.basename(file)} cannot be read`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new FactStoreError(`${path.basename(file)} is not valid JSON`);
  }
}

const isSource = (v: unknown): v is FactSource | null =>
  v === null || (typeof v === "object" && !Array.isArray(v) && Object.entries(v as object).every(([k, x]) => ["attemptId", "url", "ref"].includes(k) && typeof x === "string"));
const isTime = (v: unknown): v is string | null => v === null || (typeof v === "string" && ISO.test(v));

function validLedger(v: unknown): v is FactLedger {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const l = v as FactLedger;
  if (l.version !== FACT_LEDGER_VERSION || !l.current || typeof l.current !== "object" || Array.isArray(l.current) || !Array.isArray(l.history)) return false;
  if (!Number.isSafeInteger(l.trimmed) || l.trimmed < 0) return false;
  for (const m of Object.values(l.current)) {
    if (!m || typeof m !== "object" || !isTime(m.observedAt) || !isSource(m.source) || typeof m.valueSha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.valueSha256)) return false;
  }
  return l.history.every((h) => h && typeof h === "object" && typeof h.key === "string" && typeof h.value === "string"
    && (h.status === "superseded" || h.status === "retracted") && isTime(h.observedAt) && isSource(h.source) && isTime(h.endedAt ?? null));
}

export interface FactState {
  /** Current facts, sorted by key (deterministic). */
  current: FactRecord[];
  /** Superseded and retracted values, oldest first (the order they stopped being current). */
  history: FactRecord[];
  trimmed: number;
}

interface Loaded extends FactState { facts: Record<string, string>; ledger: FactLedger }

function load(memoryDir: string): Loaded {
  const raw = readStrict(path.join(memoryDir, FACTS_FILE));
  const facts = (raw === undefined ? {} : raw) as Record<string, unknown>;
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) throw new FactStoreError("facts.json is not an object of facts");
  for (const [k, v] of Object.entries(facts)) if (typeof v !== "string") throw new FactStoreError(`facts.json: the value of "${k.slice(0, 60)}" is not a string`);
  const rawLedger = readStrict(path.join(memoryDir, FACT_LEDGER_FILE));
  const ledger: FactLedger = rawLedger === undefined ? { version: FACT_LEDGER_VERSION, current: {}, history: [], trimmed: 0 } : (rawLedger as FactLedger);
  if (!validLedger(ledger)) throw new FactStoreError(`${FACT_LEDGER_FILE} is not a valid ${FACT_LEDGER_VERSION} ledger`);
  const current = Object.keys(facts).sort((a, b) => a.localeCompare(b)).map((key): FactRecord => {
    const value = facts[key] as string;
    const m = ledger.current[key];
    // Metadata applies only to the exact value it was recorded for; anything else is of unknown freshness.
    const known = m && m.valueSha256 === sha(value);
    return { key, value, status: "current", observedAt: known ? m.observedAt : null, source: known ? m.source : null };
  });
  return { facts: facts as Record<string, string>, ledger, current, history: ledger.history.map((h) => ({ ...h })), trimmed: ledger.trimmed };
}

export function loadFacts(memoryDir: string): FactState {
  const { current, history, trimmed } = load(memoryDir);
  return { current, history, trimmed };
}

function writeAtomic(file: string, v: unknown): void {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(v, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

/** Ledger first (history is never lost), then the current facts; a crash between them is detected by the sha256. */
function save(memoryDir: string, s: Loaded): void {
  const over = s.ledger.history.length - FACT_LIMITS.history;
  if (over > 0) {
    s.ledger.history.splice(0, over);
    s.ledger.trimmed += over;
  }
  for (const k of Object.keys(s.ledger.current)) if (!(k in s.facts)) delete s.ledger.current[k];
  writeAtomic(path.join(memoryDir, FACT_LEDGER_FILE), s.ledger);
  writeAtomic(path.join(memoryDir, FACTS_FILE), s.facts);
}

function retire(s: Loaded, key: string, status: "superseded" | "retracted", at: string, extra: { supersededBy?: string; reason?: string | null }): void {
  const rec = s.current.find((f) => f.key === key)!;
  s.ledger.history.push({ key, value: rec.value, status, observedAt: rec.observedAt, source: rec.source, endedAt: at,
    ...(status === "superseded" ? { supersededBy: extra.supersededBy ?? key } : { reason: extra.reason ?? null }) });
}

/**
 * `notCarried`: values (numbers, amounts, percentages, dates) that a replaced value stated and that no current fact
 * states any more. They are not lost (history keeps them), but nothing current says them: see notCarriedForward.
 */
export type FactResult = { ok: true; output: string; notCarried?: string[]; stats: FactStats } | { ok: false; code: string; detail: string; factsBefore?: number };

/** Metadata of one memory write (counts only, never keys or values): what F1-FRESH-02 observability records. */
export interface FactStats {
  factsBefore: number;
  factsAfter: number;
  /** Facts written by this call (1 for remember_fact; the batch size for remember_facts; 0 for a retraction). */
  written: number;
  /** Values retired as superseded: same-key updates plus keys retired through `supersedes`. */
  superseded: number;
  /** Writes in this call that named other keys in `supersedes`. */
  supersedesUsed: number;
  retracted: number;
  /** Values the replaced facts stated that no current fact states any more (the NOT CARRIED FORWARD clauses). */
  notCarried: number;
}

/** At most this many facts in one remember_facts batch. */
export const FACT_BATCH_LIMIT = 20;
export const CARRY_LIMITS = Object.freeze({ snippets: 8, snippetChars: 90 });

const NUMBER_OR_DATE = /(?<![\p{L}\d_.\-])(\d{4}-\d{2}-\d{2}|\d+(?:\.\d+)?)(?!\d|\.\d)/gu;
const NOT_VALUES = /https?:\/\/\S+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** The values a fact states (dates verbatim, numbers canonical: "12.00" = "12"), each with the clause it appears in. */
export function statedValues(text: string): Map<string, string> {
  const t = text.replace(NOT_VALUES, (m) => " ".repeat(m.length));
  const out = new Map<string, string>();
  for (const m of t.matchAll(NUMBER_OR_DATE)) {
    const i = m.index!;
    if (t[i - 1] === "(" && t[i + m[0].length] === ")") continue; // "(1)" list markers
    const v = /^\d{4}-\d{2}-\d{2}$/.test(m[0]) ? m[0] : String(Number(m[0]));
    if (out.has(v)) continue;
    // The clause: up to the nearest "; " / ". " / ", " / newline on either side.
    const before = Math.max(t.lastIndexOf("; ", i), t.lastIndexOf(". ", i), t.lastIndexOf(", ", i), t.lastIndexOf("\n", i));
    const ends = ["; ", ". ", ", ", "\n"].map((d) => t.indexOf(d, i + m[0].length)).filter((x) => x >= 0);
    let clause = text.slice(before < 0 ? 0 : before + 1, ends.length ? Math.min(...ends) : text.length).trim();
    if (clause.length > CARRY_LIMITS.snippetChars) {
      const at = clause.indexOf(m[0]);
      const from = Math.max(0, Math.min(at - 30, clause.length - CARRY_LIMITS.snippetChars));
      clause = `${from > 0 ? "…" : ""}${clause.slice(from, from + CARRY_LIMITS.snippetChars - 2)}…`;
    }
    out.set(v, clause);
  }
  return out;
}

/**
 * Values the replaced texts stated that no current text states any more (deterministic; F1-FRESH-EVAL-02 showed a
 * rewritten summary silently dropping independent operational facts that later news never restated). Advisory: a
 * correction legitimately drops the old value; the founder decides.
 */
export function notCarriedForward(replaced: readonly string[], current: readonly string[]): string[] {
  const kept = new Set<string>();
  for (const c of current) for (const v of statedValues(c).keys()) kept.add(v);
  const out: string[] = [];
  for (const r of replaced) {
    for (const [v, clause] of statedValues(r)) if (!kept.has(v) && !out.includes(clause)) out.push(clause);
  }
  return out.slice(0, CARRY_LIMITS.snippets).concat(out.length > CARRY_LIMITS.snippets ? [`(+${out.length - CARRY_LIMITS.snippets} more: recall_facts includeHistory)`] : []);
}

export interface FactWrite { key: string; value: string; source?: unknown; supersedes?: unknown }
type Applied = { key: string; what: string; others: string[]; replaced: string[] };

/** Validate and apply one write to the loaded state (nothing is saved here). */
function applyWrite(s: Loaded, i: FactWrite, at: string): Applied | { code: string; detail: string } {
  if (i.supersedes !== undefined && !Array.isArray(i.supersedes)) return { code: "FLEET_BAD_REQUEST", detail: "supersedes must be a list of fact keys" };
  const supersedes = Array.isArray(i.supersedes) ? [...new Set(i.supersedes.filter((k): k is string => typeof k === "string").map((k) => k.slice(0, FACT_LIMITS.keyChars)))] : [];
  if (supersedes.length > FACT_LIMITS.supersedes) return { code: "FLEET_BAD_REQUEST", detail: `at most ${FACT_LIMITS.supersedes} keys can be superseded at once` };
  const others = supersedes.filter((k) => k !== i.key);
  const missing = others.filter((k) => !(k in s.facts));
  if (missing.length) return { code: "FLEET_NOT_FOUND", detail: `not a current fact: ${missing.join(", ").slice(0, 200)}` };
  const exists = i.key in s.facts;
  if (!exists && Object.keys(s.facts).length - others.length >= FACT_LIMITS.current) return { code: "FLEET_BAD_REQUEST", detail: "memory is full" };
  const source = i.source === undefined ? undefined : parseSource(i.source);
  const prior = s.current.find((f) => f.key === i.key);
  const replaced: string[] = [];
  let what: string;
  if (prior && prior.value === i.value) {
    what = "re-observed";
  } else {
    if (prior) { retire(s, i.key, "superseded", at, { supersededBy: i.key }); replaced.push(prior.value); }
    what = prior ? "updated (the previous value is kept as superseded history)" : "remembered";
  }
  for (const k of others) {
    replaced.push(s.facts[k]);
    retire(s, k, "superseded", at, { supersededBy: i.key });
    delete s.facts[k];
    s.current = s.current.filter((f) => f.key !== k);
  }
  s.facts[i.key] = i.value;
  s.ledger.current[i.key] = { observedAt: at, source: source !== undefined ? source : prior && prior.value === i.value ? prior.source : null, valueSha256: sha(i.value) };
  // Keep the in-memory view current for the next write of a batch.
  const rec: FactRecord = { key: i.key, value: i.value, status: "current", observedAt: at, source: s.ledger.current[i.key].source };
  s.current = [...s.current.filter((f) => f.key !== i.key), rec];
  return { key: i.key, what, others, replaced };
}

/** The counts of a completed write (the carry-forward summary line "(+N more…)" is not a value). */
const statsOf = (factsBefore: number, s: Loaded, done: Applied[], notCarried: string[]): FactStats => ({
  factsBefore, factsAfter: Object.keys(s.facts).length, written: done.length,
  superseded: done.reduce((n, d) => n + d.others.length + (d.what.startsWith("updated") ? 1 : 0), 0),
  supersedesUsed: done.filter((d) => d.others.length > 0).length, retracted: 0,
  notCarried: notCarried.filter((c) => !c.startsWith("(+")).length + Number(/^\(\+(\d+) more/.exec(notCarried[notCarried.length - 1] ?? "")?.[1] ?? 0),
});

const carryNote = (notCarried: string[]) => notCarried.length
  ? `; NOT CARRIED FORWARD (no current fact states these any more; history keeps them): ${notCarried.map((c) => `"${c}"`).join(" | ")}. If any still hold, keep them as their own facts (remember_facts stores several at once).`
  : "";

/**
 * Record a fact. A different value under an existing key supersedes the old value (kept in history); the same value
 * is a re-observation (observedAt refreshed; the source kept unless a new one is given). `supersedes` retires other
 * current keys that this fact replaces (e.g. an older status fact under a different key). Unknown keys refuse.
 * When a replaced value stated something no current fact states any more, the result says so (notCarried).
 */
export function rememberFact(memoryDir: string, i: FactWrite & { now?: () => Date }): FactResult {
  const at = (i.now ?? (() => new Date()))().toISOString();
  let s: Loaded;
  try { s = load(memoryDir); } catch (e) { return { ok: false, code: "FLEET_FACTS_MALFORMED", detail: (e as Error).message }; }
  const factsBefore = Object.keys(s.facts).length;
  const r = applyWrite(s, i, at);
  if ("code" in r) return { ok: false, ...r, factsBefore };
  save(memoryDir, s);
  const notCarried = notCarriedForward(r.replaced, Object.values(s.facts));
  return { ok: true, output: `${r.what}${r.others.length ? `; superseded: ${r.others.join(", ")}` : ""}${carryNote(notCarried)}`, ...(notCarried.length ? { notCarried } : {}),
    stats: statsOf(factsBefore, s, [r], notCarried) };
}

/**
 * Record several independent facts in ONE atomic write (all or nothing), each with exactly rememberFact's rules. It
 * lets a founder keep operational facts individually addressable without one tool call per fact (the mind executes
 * at most MAX_TOOL_CALLS_EXECUTED calls per step). A key may appear once per batch, and a batch cannot supersede a
 * key it also writes.
 */
export function rememberFacts(memoryDir: string, i: { facts: unknown; now?: () => Date }): FactResult {
  const at = (i.now ?? (() => new Date()))().toISOString();
  if (!Array.isArray(i.facts) || i.facts.length === 0 || i.facts.length > FACT_BATCH_LIMIT) return { ok: false, code: "FLEET_BAD_REQUEST", detail: `facts must be a list of 1–${FACT_BATCH_LIMIT} {key, value} entries` };
  const writes: FactWrite[] = [];
  for (const [n, f] of i.facts.entries()) {
    const e = f as Record<string, unknown> | null;
    const key = e && typeof e.key === "string" ? e.key.trim().slice(0, FACT_LIMITS.keyChars) : "";
    if (!key || typeof e?.value !== "string") return { ok: false, code: "FLEET_BAD_REQUEST", detail: `facts[${n}]: key and value required` };
    writes.push({ key, value: e.value.slice(0, FACT_LIMITS.valueChars), ...(e.source !== undefined ? { source: e.source } : {}), ...(e.supersedes !== undefined ? { supersedes: e.supersedes } : {}) });
  }
  const keys = writes.map((w) => w.key);
  const dup = keys.find((k, n) => keys.indexOf(k) !== n);
  if (dup) return { ok: false, code: "FLEET_BAD_REQUEST", detail: `key written twice in one batch: ${dup.slice(0, 100)}` };
  const clash = writes.flatMap((w) => (Array.isArray(w.supersedes) ? w.supersedes.filter((k) => k !== w.key) : [])).find((k) => keys.includes(k as string));
  if (clash !== undefined) return { ok: false, code: "FLEET_BAD_REQUEST", detail: `a batch cannot supersede a key it also writes: ${String(clash).slice(0, 100)}` };
  let s: Loaded;
  try { s = load(memoryDir); } catch (e) { return { ok: false, code: "FLEET_FACTS_MALFORMED", detail: (e as Error).message }; }
  const factsBefore = Object.keys(s.facts).length;
  const done: Applied[] = [];
  for (const [n, w] of writes.entries()) {
    const r = applyWrite(s, w, at);
    if ("code" in r) return { ok: false, code: r.code, detail: `facts[${n}] (${w.key.slice(0, 60)}): ${r.detail}; nothing was written`, factsBefore };
    done.push(r);
  }
  save(memoryDir, s);
  const notCarried = notCarriedForward(done.flatMap((d) => d.replaced), Object.values(s.facts));
  const lines = done.map((d) => `${d.key}: ${d.what}${d.others.length ? `; superseded: ${d.others.join(", ")}` : ""}`);
  return { ok: true, output: `${done.length} facts written (${lines.join(" | ")})${carryNote(notCarried)}`, ...(notCarried.length ? { notCarried } : {}),
    stats: statsOf(factsBefore, s, done, notCarried) };
}

/** Withdraw a current fact that turned out to be wrong: removed from current facts, kept as retracted history. */
export function retractFact(memoryDir: string, i: { key: string; reason: string; now?: () => Date }): FactResult {
  const at = (i.now ?? (() => new Date()))().toISOString();
  let s: Loaded;
  try { s = load(memoryDir); } catch (e) { return { ok: false, code: "FLEET_FACTS_MALFORMED", detail: (e as Error).message }; }
  const factsBefore = Object.keys(s.facts).length;
  if (!(i.key in s.facts)) return { ok: false, code: "FLEET_NOT_FOUND", detail: "not a current fact", factsBefore };
  retire(s, i.key, "retracted", at, { reason: i.reason.slice(0, FACT_LIMITS.reasonChars) });
  delete s.facts[i.key];
  save(memoryDir, s);
  return { ok: true, output: "retracted (kept as history)", stats: { factsBefore, factsAfter: factsBefore - 1, written: 0, superseded: 0, supersedesUsed: 0, retracted: 1, notCarried: 0 } };
}

/** Current facts (with freshness and provenance), optionally the superseded/retracted history, filtered by substring. */
export function recallFacts(memoryDir: string, i: { query?: string; includeHistory?: boolean }): { ok: true; current: FactRecord[]; history?: FactRecord[]; trimmed?: number } | { ok: false; code: string; detail: string } {
  let s: FactState;
  try { s = loadFacts(memoryDir); } catch (e) { return { ok: false, code: "FLEET_FACTS_MALFORMED", detail: (e as Error).message }; }
  const q = (i.query ?? "").toLowerCase();
  const match = (f: FactRecord) => !q || f.key.toLowerCase().includes(q) || f.value.toLowerCase().includes(q);
  return { ok: true, current: s.current.filter(match), ...(i.includeHistory ? { history: s.history.filter(match), trimmed: s.trimmed } : {}) };
}

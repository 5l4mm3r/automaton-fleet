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

export type FactResult = { ok: true; output: string } | { ok: false; code: string; detail: string };

/**
 * Record a fact. A different value under an existing key supersedes the old value (kept in history); the same value
 * is a re-observation (observedAt refreshed; the source kept unless a new one is given). `supersedes` retires other
 * current keys that this fact replaces (e.g. an older status fact under a different key). Unknown keys refuse.
 */
export function rememberFact(memoryDir: string, i: { key: string; value: string; source?: unknown; supersedes?: unknown; now?: () => Date }): FactResult {
  const at = (i.now ?? (() => new Date()))().toISOString();
  let s: Loaded;
  try { s = load(memoryDir); } catch (e) { return { ok: false, code: "FLEET_FACTS_MALFORMED", detail: (e as Error).message }; }
  const supersedes = Array.isArray(i.supersedes) ? [...new Set(i.supersedes.filter((k): k is string => typeof k === "string").map((k) => k.slice(0, FACT_LIMITS.keyChars)))] : [];
  if (i.supersedes !== undefined && !Array.isArray(i.supersedes)) return { ok: false, code: "FLEET_BAD_REQUEST", detail: "supersedes must be a list of fact keys" };
  if (supersedes.length > FACT_LIMITS.supersedes) return { ok: false, code: "FLEET_BAD_REQUEST", detail: `at most ${FACT_LIMITS.supersedes} keys can be superseded at once` };
  const others = supersedes.filter((k) => k !== i.key);
  const missing = others.filter((k) => !(k in s.facts));
  if (missing.length) return { ok: false, code: "FLEET_NOT_FOUND", detail: `not a current fact: ${missing.join(", ").slice(0, 200)}` };
  const exists = i.key in s.facts;
  if (!exists && Object.keys(s.facts).length - others.length >= FACT_LIMITS.current) return { ok: false, code: "FLEET_BAD_REQUEST", detail: "memory is full" };
  const source = i.source === undefined ? undefined : parseSource(i.source);
  const prior = s.current.find((f) => f.key === i.key);
  let what: string;
  if (prior && prior.value === i.value) {
    what = "re-observed";
  } else {
    if (prior) retire(s, i.key, "superseded", at, { supersededBy: i.key });
    what = prior ? "updated (the previous value is kept as superseded history)" : "remembered";
  }
  for (const k of others) {
    retire(s, k, "superseded", at, { supersededBy: i.key });
    delete s.facts[k];
  }
  s.facts[i.key] = i.value;
  s.ledger.current[i.key] = { observedAt: at, source: source !== undefined ? source : prior && prior.value === i.value ? prior.source : null, valueSha256: sha(i.value) };
  save(memoryDir, s);
  return { ok: true, output: `${what}${others.length ? `; superseded: ${others.join(", ")}` : ""}` };
}

/** Withdraw a current fact that turned out to be wrong: removed from current facts, kept as retracted history. */
export function retractFact(memoryDir: string, i: { key: string; reason: string; now?: () => Date }): FactResult {
  const at = (i.now ?? (() => new Date()))().toISOString();
  let s: Loaded;
  try { s = load(memoryDir); } catch (e) { return { ok: false, code: "FLEET_FACTS_MALFORMED", detail: (e as Error).message }; }
  if (!(i.key in s.facts)) return { ok: false, code: "FLEET_NOT_FOUND", detail: "not a current fact" };
  retire(s, i.key, "retracted", at, { reason: i.reason.slice(0, FACT_LIMITS.reasonChars) });
  delete s.facts[i.key];
  save(memoryDir, s);
  return { ok: true, output: "retracted (kept as history)" };
}

/** Current facts (with freshness and provenance), optionally the superseded/retracted history, filtered by substring. */
export function recallFacts(memoryDir: string, i: { query?: string; includeHistory?: boolean }): { ok: true; current: FactRecord[]; history?: FactRecord[]; trimmed?: number } | { ok: false; code: string; detail: string } {
  let s: FactState;
  try { s = loadFacts(memoryDir); } catch (e) { return { ok: false, code: "FLEET_FACTS_MALFORMED", detail: (e as Error).message }; }
  const q = (i.query ?? "").toLowerCase();
  const match = (f: FactRecord) => !q || f.key.toLowerCase().includes(q) || f.value.toLowerCase().includes(q);
  return { ok: true, current: s.current.filter(match), ...(i.includeHistory ? { history: s.history.filter(match), trimmed: s.trimmed } : {}) };
}

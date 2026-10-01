/**
 * F1-FRESH-02 retention health report (read-only; counts and status only — never a fact key, value, reason or
 * source). Used by `sudo scripts/fleet-founders.sh memory-report <agentId>`.
 *
 * Two independent sources:
 *   telemetry   founder_memory_write events the founder runtime logs (MemoryTelemetry: counts and codes only),
 *               read from its unit's journal — they exist only for runtimes that emit them and only for the journal's
 *               retained window
 *   fact store  the founder's facts.json / facts-ledger.json, parsed from PRIVATE COPIES taken without following
 *               symlinks (founder state is founder-writable; a root reader must never be redirected by it)
 */

import fs from "fs";
import os from "os";
import path from "path";
import { FACTS_FILE, FACT_LEDGER_FILE, FactStoreError, loadFacts } from "./facts.js";

const MEMORY_TOOLS = ["remember_fact", "remember_facts", "retract_fact", "recall_facts"] as const;
const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const n = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);

export interface MemoryEventSummary {
  events: number;
  firstAt: string | null;
  lastAt: string | null;
  byTool: Record<string, { ok: number; refused: number }>;
  rememberFactsEverUsed: boolean;
  batchWrites: number;
  batchFactsWritten: number;
  individualWrites: number;
  retractions: number;
  superseded: number;
  supersedesUsed: number;
  notCarriedWarnings: number;
  notCarriedValues: number;
  refused: number;
  refusedByCode: Record<string, number>;
  malformed: number;
  lastFactsAfter: number | null;
  runtimes: string[];
}

/** Aggregate founder_memory_write lines (anything else, or anything malformed, is ignored). Only counts are read. */
export function aggregateMemoryEvents(lines: Iterable<string>): MemoryEventSummary {
  const s: MemoryEventSummary = {
    events: 0, firstAt: null, lastAt: null, byTool: Object.fromEntries(MEMORY_TOOLS.map((t) => [t, { ok: 0, refused: 0 }])),
    rememberFactsEverUsed: false, batchWrites: 0, batchFactsWritten: 0, individualWrites: 0, retractions: 0, superseded: 0, supersedesUsed: 0,
    notCarriedWarnings: 0, notCarriedValues: 0, refused: 0, refusedByCode: {}, malformed: 0, lastFactsAfter: null, runtimes: [],
  };
  for (const line of lines) {
    if (!line.includes("founder_memory_write")) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line.slice(line.indexOf("{"))); } catch { continue; }
    if (e.event !== "founder_memory_write" || !MEMORY_TOOLS.includes(e.tool as never) || typeof e.ok !== "boolean") continue;
    const tool = e.tool as string;
    s.events++;
    const ts = typeof e.ts === "string" && ISO.test(e.ts) ? e.ts : null;
    if (ts && (!s.firstAt || ts < s.firstAt)) s.firstAt = ts;
    if (ts && (!s.lastAt || ts >= s.lastAt)) { s.lastAt = ts; if (typeof e.factsAfter === "number") s.lastFactsAfter = n(e.factsAfter); }
    if (typeof e.runtimeCommit === "string" && /^[0-9a-f]{40}$/.test(e.runtimeCommit) && !s.runtimes.includes(e.runtimeCommit)) s.runtimes.push(e.runtimeCommit);
    if (e.ok) {
      s.byTool[tool].ok++;
      if (tool === "remember_facts") { s.batchWrites++; s.batchFactsWritten += n(e.written); s.rememberFactsEverUsed = true; }
      if (tool === "remember_fact") s.individualWrites++;
      if (tool === "retract_fact") s.retractions++;
      s.superseded += n(e.superseded);
      s.supersedesUsed += n(e.supersedesUsed);
      if (n(e.notCarried) > 0) { s.notCarriedWarnings++; s.notCarriedValues += n(e.notCarried); }
    } else {
      s.byTool[tool].refused++;
      s.refused++;
      const code = typeof e.code === "string" && CODE.test(e.code) ? e.code : "UNKNOWN";
      s.refusedByCode[code] = (s.refusedByCode[code] ?? 0) + 1;
      if (code === "FLEET_FACTS_MALFORMED") s.malformed++;
    }
  }
  return s;
}

export interface FactStoreHealth {
  memoryDir: "present" | "absent" | "not-a-directory";
  factsFile: "present" | "absent" | "not-a-regular-file" | "too-large";
  ledgerFile: "present" | "absent" | "not-a-regular-file" | "too-large";
  /** ok = both files parse and validate; malformed = the store would refuse every memory tool (FLEET_FACTS_MALFORMED). */
  parse: "ok" | "malformed" | "unreadable" | "skipped";
  currentFacts: number | null;
  /** Current facts with no recorded time or source (legacy, or changed outside the store). */
  legacyFacts: number | null;
  history: { superseded: number; retracted: number; trimmed: number } | null;
  /** Inferred from the ledger: distinct write instants shared by ≥ 2 facts — only a remember_facts batch does that. */
  multiFactWrites: number | null;
}

const MAX_BYTES = 32 * 1024 * 1024;

/** Copy one file into dir without following a symlink; returns its state. */
function copyNoFollow(src: string, dir: string, name: string): "present" | "absent" | "not-a-regular-file" | "too-large" {
  let fd: number;
  try {
    fd = fs.openSync(src, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? "absent" : "not-a-regular-file"; // ELOOP: a symlink
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return "not-a-regular-file";
    if (st.size > MAX_BYTES) return "too-large";
    fs.writeFileSync(path.join(dir, name), fs.readFileSync(fd), { mode: 0o600 });
    return "present";
  } finally {
    fs.closeSync(fd);
  }
}

/** Read-only health of a founder's fact store (the live directory is never written, and never followed through links). */
export function factStoreHealth(memoryDir: string): FactStoreHealth {
  const h: FactStoreHealth = { memoryDir: "absent", factsFile: "absent", ledgerFile: "absent", parse: "skipped", currentFacts: null, legacyFacts: null, history: null, multiFactWrites: null };
  let st: fs.Stats;
  try { st = fs.lstatSync(memoryDir); } catch { return h; }
  if (!st.isDirectory()) { h.memoryDir = "not-a-directory"; return h; }
  h.memoryDir = "present";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-memory-report-"));
  try {
    fs.chmodSync(tmp, 0o700);
    h.factsFile = copyNoFollow(path.join(memoryDir, FACTS_FILE), tmp, FACTS_FILE);
    h.ledgerFile = copyNoFollow(path.join(memoryDir, FACT_LEDGER_FILE), tmp, FACT_LEDGER_FILE);
    if (h.factsFile !== "present" && h.factsFile !== "absent") return h;
    if (h.ledgerFile !== "present" && h.ledgerFile !== "absent") return h;
    try {
      const s = loadFacts(tmp);
      h.parse = "ok";
      h.currentFacts = s.current.length;
      h.legacyFacts = s.current.filter((f) => f.observedAt === null && f.source === null).length;
      h.history = { superseded: s.history.filter((x) => x.status === "superseded").length, retracted: s.history.filter((x) => x.status === "retracted").length, trimmed: s.trimmed };
      const instants = new Map<string, number>();
      for (const f of [...s.current, ...s.history]) if (f.observedAt) instants.set(f.observedAt, (instants.get(f.observedAt) ?? 0) + 1);
      h.multiFactWrites = [...instants.values()].filter((c) => c >= 2).length;
    } catch (e) {
      h.parse = e instanceof FactStoreError ? "malformed" : "unreadable"; // the message can name a key: never reported
    }
    return h;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

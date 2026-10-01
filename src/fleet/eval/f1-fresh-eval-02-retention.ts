/**
 * Retention analysis of the SEALED F1-FRESH-EVAL-02 evidence (read-only; it never changes the sealed result).
 *
 * The evaluation scored INCONCLUSIVE because retention failed (the listing quota was missing from memory). This module
 * finds out where the facts went: it replays each memory cell's executed memory writes, in order, through the same
 * store the cell used (FRESH: the production fact store; LEGACY: the evaluation's legacy string store), checks that the
 * replay reproduces the sealed facts.json, and measures after every trunk turn which operational facts are present in
 * CURRENT memory.
 *
 * The investigation detectors below are deliberately more phrasing-tolerant than the pre-registered ones ("30d",
 * "20/mo", "5 biz day"). They are for diagnosis only; the sealed scores stay as they are.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { loadFacts, rememberFact, retractFact } from "../founder/facts.js";
import { legacyFactTool } from "./f1-fresh-eval-01.js";

export type Domain = "price" | "fee" | "cost" | "stock" | "lead" | "refund" | "quota" | "cpc";
export const DOMAINS: readonly Domain[] = ["price", "fee", "cost", "stock", "lead", "refund", "quota", "cpc"];

/** The then-current value of each domain after trunk turns 1, 2 and 3, as phrasing-tolerant detectors. */
const V = {
  price12: /£\s?12(?:\.00)?(?!\.?\d)/, price1350: /£\s?13\.50?(?!\d)/,
  fee65: /6\.5\s?%/, fee9: /(?<![\d.])9\s?%/,
  cost2: /£\s?2(?:\.00)?(?!\.?\d)/,
  stockIn: /(?<!out of )\bin[- ]stock\b/i, stockOut: /out of stock/i,
  lead5: /(?<![\d.])5[- ]?(?:biz|business|working|bd)\b/i, lead12: /(?<![\d.])12[- ]?(?:biz|business|working|bd)\b/i,
  refund14: /(?<![\d.])14\s?-?(?:d|days?)\b/i, refund30: /(?<![\d.])30\s?-?(?:d|days?)\b/i,
  quota20: /quota[^.;\n]{0,24}?(?<![\d.])20(?![\d.])|(?<![\d.])20 listings/i,
  cpc: /£\s?0\.35\b/,
} as const;
export const TRUTH_AFTER_TURN: Readonly<Record<Domain, readonly [RegExp, RegExp, RegExp]>> = Object.freeze({
  price: [V.price12, V.price12, V.price1350], fee: [V.fee65, V.fee9, V.fee9], cost: [V.cost2, V.cost2, V.cost2],
  stock: [V.stockIn, V.stockIn, V.stockOut], lead: [V.lead5, V.lead5, V.lead12], refund: [V.refund14, V.refund14, V.refund30],
  quota: [V.quota20, V.quota20, V.quota20], cpc: [V.cpc, V.cpc, V.cpc],
});
/** Which domains each turn's news stated (turn 2 also carried the later-retracted discount claim, not an operational domain). */
export const NEWS_DOMAINS: readonly (readonly Domain[])[] = [DOMAINS, ["fee"], ["price", "lead", "refund", "stock"]];

export interface TurnCoverage {
  turn: 1 | 2 | 3;
  memoryCalls: number;
  /** Current fact keys after the turn. */
  keys: string[];
  /** Domains whose then-current value is present in current memory. */
  present: Domain[];
  /** Of the domains this turn's news stated: present after the turn. */
  captured: Domain[];
  /** Of the domains NOT in this turn's news that were present before it: still present after it. */
  carried: Domain[];
  /** ...and the ones a rewrite dropped. */
  dropped: Domain[];
}
export interface CellRetention { cellId: string; arm: "FRESH" | "LEGACY"; replayMatchesSealed: boolean; turns: TurnCoverage[]; maxCallsInOneStep: number; limitRefusals: number }

type SealedCell = {
  cellId: string; arm: string;
  calls: Array<{ phase: string; toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }> }>;
  toolOutcomes: Array<{ phase: string; name: string; ok: boolean; refused?: string }>;
  memoryFiles: Record<string, string>;
};

function currentTexts(dir: string, arm: "FRESH" | "LEGACY"): { keys: string[]; text: string } {
  if (arm === "FRESH") {
    const c = loadFacts(dir).current;
    return { keys: c.map((f) => f.key), text: c.map((f) => f.value).join("\n") };
  }
  let f: Record<string, string> = {};
  try { f = JSON.parse(fs.readFileSync(path.join(dir, "facts.json"), "utf8")); } catch { /* none */ }
  const live = Object.entries(f).filter(([, v]) => !/^(RETRACTED|SUPERSEDED by)/.test(v));
  return { keys: live.map(([k]) => k), text: live.map(([, v]) => v).join("\n") };
}

export function analyseCell(cell: SealedCell): CellRetention {
  const arm = cell.arm as "FRESH" | "LEGACY";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fresh2-retention-"));
  try {
    const turns: TurnCoverage[] = [];
    let before = new Set<Domain>();
    for (const t of [1, 2, 3] as const) {
      // Executed writes only: every memory call in this evidence ran (no refusals), which analyseCell also reports.
      const writes = cell.calls.filter((c) => c.phase === `trunk-${t}`).flatMap((c) => c.toolCalls ?? []).filter((c) => c.name === "remember_fact" || c.name === "retract_fact");
      for (const w of writes) {
        if (arm === "LEGACY") { legacyFactTool(dir, { id: "replay", name: w.name, arguments: w.arguments }); continue; }
        const a = w.arguments;
        const r = w.name === "remember_fact"
          ? rememberFact(dir, { key: String(a.key), value: String(a.value), ...(a.source !== undefined ? { source: a.source } : {}), ...(a.supersedes !== undefined ? { supersedes: a.supersedes } : {}) })
          : retractFact(dir, { key: String(a.key), reason: String(a.reason) });
        if (!r.ok) throw new Error(`${cell.cellId} replay refused: ${r.code}`);
      }
      const { keys, text } = currentTexts(dir, arm);
      const present = DOMAINS.filter((d) => TRUTH_AFTER_TURN[d][t - 1].test(text));
      const news = NEWS_DOMAINS[t - 1];
      const unmentioned = [...before].filter((d) => !news.includes(d));
      turns.push({
        turn: t, memoryCalls: writes.length, keys, present,
        captured: news.filter((d) => present.includes(d)),
        carried: unmentioned.filter((d) => present.includes(d)),
        dropped: unmentioned.filter((d) => !present.includes(d)),
      });
      before = new Set(present);
    }
    const sealed = JSON.parse(cell.memoryFiles["facts.json"] ?? "{}");
    const replayed = JSON.parse(fs.readFileSync(path.join(dir, "facts.json"), "utf8"));
    return {
      cellId: cell.cellId, arm, turns,
      replayMatchesSealed: JSON.stringify(sealed) === JSON.stringify(replayed),
      maxCallsInOneStep: Math.max(0, ...cell.calls.filter((c) => c.phase.startsWith("trunk")).map((c) => (c.toolCalls ?? []).length)),
      limitRefusals: cell.toolOutcomes.filter((o) => o.refused === "FLEET_TOOL_CALL_LIMIT").length,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function analyseSealedRun(realDir: string): CellRetention[] {
  return ["C-FRESH-1", "C-FRESH-2", "C-FRESH-3", "C-LEGACY-1", "C-LEGACY-2", "C-LEGACY-3"]
    .map((id) => analyseCell(JSON.parse(fs.readFileSync(path.join(realDir, "cells", `${id}.json`), "utf8")) as SealedCell));
}

if (process.argv[1] && /f1-fresh-eval-02-retention\.(ts|js)$/.test(process.argv[1])) {
  const rows = analyseSealedRun(process.argv[2] ?? "docs/evaluations/f1-fresh-eval-02/real");
  for (const r of rows) {
    console.log(`${r.cellId}  replay=${r.replayMatchesSealed ? "matches sealed" : "MISMATCH"}  maxCallsInOneStep=${r.maxCallsInOneStep}  limitRefusals=${r.limitRefusals}`);
    for (const t of r.turns) console.log(`  turn ${t.turn}: writes ${t.memoryCalls}, keys [${t.keys.join(", ")}], present ${t.present.length}/8 [${t.present.join(",")}]; captured ${t.captured.length}/${NEWS_DOMAINS[t.turn - 1].length}; carried ${t.carried.length}/${t.carried.length + t.dropped.length}${t.dropped.length ? `; DROPPED [${t.dropped.join(",")}]` : ""}`);
  }
}

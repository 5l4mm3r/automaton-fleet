/**
 * F1-EVAL-02 plan (cell order and state dependencies) and deterministic observable scoring.
 *
 * Trunk (the founder's lived sequence, production-like: history replay within the trunk):
 *   B  multi-opportunity reasoning (2 turns)  →  C  knowledge promotion  →  E  contradictory evidence
 *   →  F  failure learning  →  G  transfer
 * Severance probes fork the trunk's persisted state: D after C, H after G (arms A/B/R/C), plus the Phase G transfer
 * control G0 (a founder without prior learning, same observation). Phase A (baseline snapshot) needs no inference.
 * Mandatory cells run first; replications (optional) only while budget remains.
 */

import { MARKERS_D, MARKERS_G, MARKERS_H, PHASE_B_OBSERVATIONS, PHASE_C_OBSERVATION, PHASE_E_OBSERVATION, PHASE_F_OBSERVATION, PHASE_G_OBSERVATION, PROBE_D, PROBE_H, type Marker } from "./f1-eval-02-fixtures.js";
import type { Arm, CellResult } from "./f1-eval-02.js";

export interface PlannedCell {
  cellId: string;
  phase: "B" | "C" | "D" | "E" | "F" | "G" | "H";
  arm: Arm;
  observations: string[];
  webVersion: 1 | 2;
  /** Cell whose snapshot is this cell's input state (null = fresh). */
  from: string | null;
  maxSteps: number;
  mandatory: boolean;
}

const probe = (phase: "D" | "H", arm: Arm, rep: number, from: string, mandatory: boolean): PlannedCell => ({
  cellId: `${phase}-${arm}-${rep}`, phase, arm, observations: [phase === "D" ? PROBE_D : PROBE_H], webVersion: phase === "D" ? 1 : 2, from, maxSteps: 4, mandatory,
});

export const PLAN: readonly PlannedCell[] = Object.freeze([
  { cellId: "B-trunk", phase: "B", arm: "trunk", observations: PHASE_B_OBSERVATIONS, webVersion: 1, from: null, maxSteps: 4, mandatory: true },
  { cellId: "C-trunk", phase: "C", arm: "trunk", observations: [PHASE_C_OBSERVATION], webVersion: 1, from: "B-trunk", maxSteps: 4, mandatory: true },
  probe("D", "B", 1, "C-trunk", true),
  probe("D", "C", 1, "C-trunk", true),
  probe("D", "A", 1, "C-trunk", true),
  { cellId: "E-trunk", phase: "E", arm: "trunk", observations: [PHASE_E_OBSERVATION], webVersion: 2, from: "C-trunk", maxSteps: 4, mandatory: true },
  { cellId: "F-trunk", phase: "F", arm: "trunk", observations: [PHASE_F_OBSERVATION], webVersion: 2, from: "E-trunk", maxSteps: 3, mandatory: true },
  { cellId: "G-trunk", phase: "G", arm: "trunk", observations: [PHASE_G_OBSERVATION], webVersion: 2, from: "F-trunk", maxSteps: 4, mandatory: true },
  { cellId: "G-G0-1", phase: "G", arm: "G0", observations: [PHASE_G_OBSERVATION], webVersion: 2, from: null, maxSteps: 4, mandatory: true },
  probe("H", "B", 1, "G-trunk", true),
  probe("H", "C", 1, "G-trunk", true),
  probe("H", "A", 1, "G-trunk", true),
  // Replications and the secondary tool-recall arm, in priority order.
  probe("D", "R", 1, "C-trunk", false),
  probe("H", "R", 1, "G-trunk", false),
  probe("D", "B", 2, "C-trunk", false),
  probe("H", "B", 2, "G-trunk", false),
  probe("D", "C", 2, "C-trunk", false),
  probe("H", "C", 2, "G-trunk", false),
  probe("D", "A", 2, "C-trunk", false),
  probe("H", "A", 2, "G-trunk", false),
]);

export function markersFor(phase: string): readonly Marker[] {
  return phase === "D" ? MARKERS_D : phase === "H" ? MARKERS_H : phase === "G" ? MARKERS_G : [];
}

export interface CellScore {
  cellId: string;
  phase: string;
  arm: Arm;
  /** Marker hits in the visible output text of the cell (all assistant text). */
  hits: Record<string, boolean>;
  hitCount: number;
  markerCount: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  firstCallInputTokens: number;
  costMicrocents: number;
  /** web_fetch of a URL the trunk had already fetched before this cell's state was taken. */
  duplicateFetches: number;
  unknownFetches: number;
  fetches: number;
  toolCalls: string[];
  packetBytes: number;
  packetPresentAllCalls: boolean;
  restoredHistoryBytes: number;
  answered: boolean;
  /** B only: for each marker, the packet sections whose text contains it (where recovered knowledge came from). */
  packetMarkerSources: Record<string, string[]> | null;
}

export function scoreCell(r: CellResult, priorFetchedUrls: ReadonlySet<string>): CellScore {
  const text = r.calls.filter((c) => c.ok && c.content).map((c) => c.content).join("\n");
  const markers = markersFor(r.phase);
  const hits = Object.fromEntries(markers.map((m) => [m.id, m.re.test(text)]));
  const ok = r.calls.filter((c) => c.ok);
  return {
    cellId: r.cellId, phase: r.phase, arm: r.arm, hits, hitCount: Object.values(hits).filter(Boolean).length, markerCount: markers.length,
    calls: r.calls.filter((c) => c.code !== "FLEET_EVAL_BUDGET_STOP").length,
    inputTokens: ok.reduce((n, c) => n + (c.usage?.inputTokens ?? 0) + (c.usage?.cacheReadTokens ?? 0) + (c.usage?.cacheWriteTokens ?? 0), 0),
    outputTokens: ok.reduce((n, c) => n + (c.usage?.outputTokens ?? 0), 0),
    firstCallInputTokens: ok[0]?.usage?.inputTokens ?? 0,
    costMicrocents: r.spentMicrocents,
    duplicateFetches: r.fetches.filter((f) => priorFetchedUrls.has(f.url)).length,
    unknownFetches: r.fetches.filter((f) => !f.found).length,
    fetches: r.fetches.length,
    toolCalls: ok.flatMap((c) => (c.toolCalls ?? []).map((t) => t.name)),
    packetBytes: r.packetBytes,
    packetPresentAllCalls: r.arm === "B" ? r.calls.filter((c) => c.code !== "FLEET_EVAL_BUDGET_STOP").every((c) => c.packetPresent) : false,
    restoredHistoryBytes: r.restored.history,
    answered: /DECISION|ASSESSMENT/.test(r.finalText),
    packetMarkerSources: r.packet
      ? Object.fromEntries(markers.map((m) => [m.id, (["knowledge", "evidence", "notes", "objective", "previousResults", "institutionalKnowledge"] as const)
        .filter((k) => m.re.test(JSON.stringify(r.packet![k])))]))
      : null,
  };
}


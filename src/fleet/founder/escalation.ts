/**
 * Escalate the question, not the job (schema v22 phase; new founder runtimes only).
 *
 * When ordinary work meets ONE question that needs more capability, the founder materialises a Critical Decision
 * Packet from its own persistent state (never its transcript), sends it as a fresh single-message conversation with a
 * structured escalation request, and persists the higher tier's observable answer as a fact. The task then continues
 * at its own class's tier: an escalation routes exactly one call. FleetController decides whether the escalation is
 * granted (reason code, class maximum) — the founder only asks.
 */

import fs from "fs";
import { rememberFact } from "./facts.js";
import path from "path";
import { buildDecisionPacket, renderDecisionPacket, type DecisionInputs } from "../cognition/task-packet.js";
import type { MindPorts } from "./mind.js";

export interface EscalationResult {
  requestId: string;
  answer: string;
  factKey: string;
  packetBytes: number;
  chargedCents: number;
  route?: { tier: string; model: string; taskClass: string; scope: string };
}

/** A decision the higher tier already gave on this exact question (its persisted fact), if any and still fresh. */
export function priorDecision(memoryDir: string, question: string, maxAgeMs = 6 * 3_600_000, now: () => number = Date.now): { factKey: string; answer: string; at: string } | null {
  let facts: Record<string, unknown>;
  try { facts = JSON.parse(fs.readFileSync(path.join(memoryDir, "facts.json"), "utf8")) as Record<string, unknown>; } catch { return null; }
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const want = norm(question).slice(0, 1_000);
  for (const [key, raw] of Object.entries(facts)) {
    if (!key.startsWith("decision:") || typeof raw !== "string") continue;
    try {
      const d = JSON.parse(raw) as { question?: unknown; answer?: unknown; at?: unknown };
      if (typeof d.question !== "string" || typeof d.answer !== "string" || typeof d.at !== "string" || norm(d.question) !== want) continue;
      const age = now() - Date.parse(d.at);
      if (Number.isFinite(age) && age >= 0 && age <= maxAgeMs) return { factKey: key, answer: d.answer, at: d.at };
    } catch {
      // a clipped or hand-written fact: not a decision record
    }
  }
  return null;
}

export async function escalateQuestion(o: {
  ports: Pick<MindPorts, "infer">;
  memoryDir: string;
  workspaceDir: string;
  /** Task class of the question (e.g. evidence_conflict_resolution) and the lower-tier call it came from. */
  taskClass: string;
  requestedTier: "T2" | "T3";
  parentRequestId?: string;
  taskId?: string;
  waitMs?: number;
  decision: Omit<DecisionInputs, "memoryDir" | "workspaceDir">;
}): Promise<EscalationResult> {
  const packet = buildDecisionPacket({ ...o.decision, memoryDir: o.memoryDir, workspaceDir: o.workspaceDir });
  const text = renderDecisionPacket(packet);
  const r = await o.ports.infer([{ role: "user", content: text }], o.waitMs, {
    taskClass: o.taskClass,
    ...(o.taskId ? { taskId: o.taskId } : {}),
    escalation: { reasonCode: o.decision.escalationReason, requestedTier: o.requestedTier, ...(o.parentRequestId ? { parentRequestId: o.parentRequestId } : {}) },
  }) as Awaited<ReturnType<MindPorts["infer"]>> & { route?: EscalationResult["route"] };
  // The higher tier's answer becomes observable persistent state (never its reasoning).
  const factKey = `decision:${r.requestId}`;
  // Through the fact store (F1-FRESH-01): observedAt and provenance recorded; malformed memory is never overwritten
  // (the answer is still returned to the caller).
  rememberFact(o.memoryDir, { key: factKey, source: factKey, value: JSON.stringify({
    question: packet.question, reason: packet.escalationReason, answer: (r.content ?? "").slice(0, 2_600),
    tier: r.route?.tier ?? null, model: r.route?.model ?? null, requestId: r.requestId, at: new Date().toISOString(),
  }).slice(0, 4_000) });
  return { requestId: r.requestId, answer: r.content ?? "", factKey, packetBytes: Buffer.byteLength(text), chargedCents: r.chargedCents ?? 0, ...(r.route ? { route: r.route } : {}) };
}

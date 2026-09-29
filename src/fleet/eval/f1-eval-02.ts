/**
 * F1-EVAL-02 cell runner: one bounded unit of the learning gauntlet (a trunk phase, or one arm of a severance probe).
 *
 * It runs the REAL FounderMind and the REAL FounderToolbox (founder-v2 manifest, throwaway directories) against a
 * CognitionProvider with the production charter and tool specs. The web is the controlled fixture web; fleet-mediated
 * ports are local evaluation fakes (ledger snapshot, knowledge store, spend and identity requests recorded and
 * refused). No founder, registry, ledger or database is touched: Founder 1 is never involved.
 *
 * Arms at a severance point, given the trunk's persisted state S:
 *   A  history replay        memory + workspace + mind-history restored; observation = task
 *   B  task-packet recovery  memory + workspace restored; NO history; first message = packet built from S by
 *                            buildTaskPacket (never from history); observation = task
 *   R  tool-recall only      memory + workspace restored; NO history; NO packet; observation = task
 *                            (what a production founder gets after losing its conversation)
 *   C  negative control      NOTHING restored (fresh memory/workspace, no history, no packet); observation = task
 *   G0 transfer control      as C, for the Phase G task (a founder without prior learning)
 * The task text is identical in every arm.
 *
 * Budget: every provider call passes a guard that refuses it (before anything is sent) unless the worst case of that
 * call still fits the remaining authorised budget. Worst case = (request bytes + 2,000) tokens at the dearer of the
 * input/cache-write prices + max_tokens at the output price. Each call is attempted once (no automatic retries).
 *
 * Recorded per call: usage, exact cost at the given prices, stop reason, tool calls (name + arguments: observable
 * output), visible text, and request/context bytes. Never recorded: thinking blocks or signatures, the key.
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { FOUNDER_CHARTER, ProviderError, type ChatMessage, type ChatResult, type CognitionProvider, type ToolCall } from "../cognition/types.js";
import { toolsFor } from "../cognition/gateway.js";
import { costMicrocents, type Prices } from "../cognition/charging.js";
import { FounderMind, type TurnResult } from "../founder/mind.js";
import { FounderToolbox } from "../founder/toolbox.js";
import { FOUNDER_MANIFEST_V2 } from "../capabilities.js";
import { buildTaskPacket, renderTaskPacket, type TaskPacket } from "./task-packet.js";
import { FIXTURE_LEDGER, PROBE_CONTRACT, PROMOTED_KNOWLEDGE, fixturePage } from "./f1-eval-02-fixtures.js";

export type Arm = "trunk" | "A" | "B" | "R" | "C" | "G0";

/** Founder-private persistent files by area-relative path: memory/…, workspace/…, state/mind-history.json. */
export type Snapshot = Record<string, string>;

export interface CellRequest {
  cellId: string;
  phase: string;
  arm: Arm;
  /** Observations, one per turn (a probe has exactly one: the task). */
  observations: string[];
  webVersion: 1 | 2;
  state: Snapshot | null;
  maxSteps: number;
  maxTokens: number;
  prices: Prices;
  /** µ¢ this cell may spend at most (the driver's remaining authorised budget). */
  budgetMicrocents: number;
}

export interface CallRecord {
  turn: number;
  step: number;
  ok: boolean;
  code?: string;
  detail?: string | null;
  charge?: "none" | "estimate" | "usage";
  boundMicrocents: number;
  costMicrocents: number;
  usage?: ChatResult["usage"];
  stopReason?: string | null;
  responseModel?: string | null;
  providerRequestId?: string | null;
  requestBytes: number;
  contextBytes: number;
  messages: number;
  packetPresent: boolean;
  thinkingBlocks: number;
  content?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

export interface CellResult {
  cellId: string;
  phase: string;
  arm: Arm;
  model: string;
  startedAt: string;
  finishedAt: string;
  calls: CallRecord[];
  turns: TurnResult[];
  stopped: null | "budget" | "provider_error";
  spentMicrocents: number;
  fetches: Array<{ url: string; found: boolean; attemptId: string }>;
  toolOutcomes: Array<{ name: string; ok: boolean; refused?: string }>;
  proposals: Array<{ category: string; title: string; content: string }>;
  spendRequests: Array<Record<string, unknown>>;
  identityRequests: Array<Record<string, unknown>>;
  packet: TaskPacket | null;
  packetBytes: number;
  /** Bytes of what was restored for this arm (context the arm started with). */
  restored: { history: number; memory: number; workspace: number };
  finalText: string;
  snapshot: Snapshot;
}

export class BudgetStop extends Error {
  readonly code = "FLEET_EVAL_BUDGET_STOP";
}

export function worstCaseMicrocents(requestBytes: number, maxTokens: number, p: Prices): number {
  const inPrice = Math.max(p.inputMicrocentsPerToken, p.cacheWriteMicrocentsPerToken ?? 0);
  return (requestBytes + 2_000) * inPrice + maxTokens * p.outputMicrocentsPerToken;
}

const bytes = (v: unknown) => Buffer.byteLength(typeof v === "string" ? v : JSON.stringify(v), "utf8");

function restore(root: string, state: Snapshot | null, areas: Array<"memory" | "workspace" | "history">): { history: number; memory: number; workspace: number } {
  const sizes = { history: 0, memory: 0, workspace: 0 };
  for (const [rel, content] of Object.entries(state ?? {})) {
    const area = rel === "state/mind-history.json" ? "history" : rel.startsWith("memory/") ? "memory" : rel.startsWith("workspace/") ? "workspace" : null;
    if (!area || !areas.includes(area)) continue;
    // Snapshot paths are harness-produced; still refuse anything that would leave the cell root.
    if (rel.includes("\0") || path.isAbsolute(rel) || rel.split("/").includes("..")) throw new Error(`bad snapshot path ${rel}`);
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    fs.writeFileSync(f, content, { mode: 0o600 });
    sizes[area] += bytes(content);
  }
  return sizes;
}

/** Founder-private persistent state after the cell. Provider-signed thinking is never kept (it is never replayed at a new turn anyway). */
function snapshot(root: string): Snapshot {
  const out: Snapshot = {};
  const walk = (rel: string) => {
    const abs = path.join(root, rel);
    for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else if (e.isFile() && !e.name.endsWith(".tmp")) out[r] = fs.readFileSync(path.join(root, r), "utf8");
    }
  };
  walk("memory");
  walk("workspace");
  const hist = path.join(root, "state", "mind-history.json");
  if (fs.existsSync(hist)) {
    const h = JSON.parse(fs.readFileSync(hist, "utf8")) as ChatMessage[];
    out["state/mind-history.json"] = JSON.stringify(h.map(({ thinking: _t, blockOrder: _b, ...m }) => m));
  }
  return out;
}

export async function runCell(req: CellRequest, provider: CognitionProvider, o: { log?: (e: Record<string, unknown>) => void } = {}): Promise<CellResult> {
  const startedAt = new Date().toISOString();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-f1-eval-02-"));
  const dirs = { ws: path.join(root, "workspace"), mem: path.join(root, "memory"), st: path.join(root, "state") };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const areas: Array<"memory" | "workspace" | "history"> =
    req.arm === "trunk" || req.arm === "A" ? ["memory", "workspace", "history"] : req.arm === "B" || req.arm === "R" ? ["memory", "workspace"] : [];
  const restored = restore(root, req.state, areas);

  let packet: TaskPacket | null = null;
  let packetText = "";
  if (req.arm === "B") {
    if (req.observations.length !== 1) throw new Error("a probe has exactly one observation (the task)");
    packet = buildTaskPacket({ memoryDir: dirs.mem, workspaceDir: dirs.ws, task: req.observations[0], outputContract: PROBE_CONTRACT, institutionalKnowledge: [...PROMOTED_KNOWLEDGE], economics: { ...FIXTURE_LEDGER } });
    packetText = renderTaskPacket(packet);
    // The packet is the first message of a fresh conversation; the task observation follows it.
    fs.writeFileSync(path.join(dirs.st, "mind-history.json"), JSON.stringify([{ role: "user", content: packetText }]), { mode: 0o600 });
  }

  const prefix = crypto.createHash("sha256").update(req.cellId).digest("hex").slice(0, 8);
  const fetches: CellResult["fetches"] = [];
  const proposals: CellResult["proposals"] = [];
  const spendRequests: CellResult["spendRequests"] = [];
  const identityRequests: CellResult["identityRequests"] = [];
  const toolbox = new FounderToolbox({
    manifest: FOUNDER_MANIFEST_V2, workspaceDir: dirs.ws, memoryDir: dirs.mem,
    ports: {
      ledger: async () => ({ ...FIXTURE_LEDGER }),
      spendOrder: async (r) => { spendRequests.push({ ...r }); return { status: "refused", code: "FLEET_EVAL_NO_SPEND", reason: "evaluation environment: spend requests are recorded, never executed" }; },
      proposeKnowledge: async (p) => { proposals.push({ ...p }); return { status: "pending_owner_review", id: `kp-${proposals.length}` }; },
      knowledge: async () => ({ items: PROMOTED_KNOWLEDGE }),
      requestIdentityFact: async (p) => { identityRequests.push({ ...p }); return { status: "refused", reason: "evaluation environment" }; },
      researchFetch: async (p: { url: string; purpose: string }) => {
        const attemptId = `${prefix}-0000-4000-8000-${String(fetches.length + 1).padStart(12, "0")}`;
        const page = fixturePage(p.url, req.webVersion);
        fetches.push({ url: p.url, found: !!page, attemptId });
        if (!page) throw Object.assign(new Error("404: no such page in the evaluation environment"), { code: "RESEARCH_HTTP_STATUS" });
        return {
          attemptId, untrusted: true, requestedUrl: p.url, finalUrl: p.url, redirects: [], fetchedAt: new Date().toISOString(), status: 200,
          contentType: "text/html", title: page.title, truncated: false, bytes: bytes(page.text),
          sha256: crypto.createHash("sha256").update(page.text).digest("hex"), text: page.text, links: page.links ?? [],
        };
      },
    },
  });
  const tools = toolsFor(FOUNDER_MANIFEST_V2.allowed as readonly string[]);
  const calls: CallRecord[] = [];
  const toolOutcomes: CellResult["toolOutcomes"] = [];
  let spent = 0;
  let stopped: CellResult["stopped"] = null;
  let turn = 0;
  let step = 0;
  const origExecute = toolbox.execute.bind(toolbox);
  toolbox.execute = async (call: ToolCall) => {
    const out = await origExecute(call);
    toolOutcomes.push({ name: out.name, ok: out.ok, ...(out.refused ? { refused: out.refused } : {}) });
    return out;
  };
  const mind = new FounderMind({
    toolbox, stateDir: dirs.st, maxStepsPerTurn: req.maxSteps,
    ports: {
      cognitionStatus: async () => ({ policyEnabled: true, provider: provider.id, founderEnabled: true, paused: false }),
      infer: async (messages) => {
        const msgs = messages as ChatMessage[];
        const requestBytes = bytes({ system: FOUNDER_CHARTER, messages: msgs, tools });
        const rec: CallRecord = {
          turn, step: step++, ok: false, requestBytes, contextBytes: bytes(msgs), messages: msgs.length,
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
          r = await provider.chat({ agentId: "f1-eval-02", system: FOUNDER_CHARTER, messages: msgs, tools, maxTokens: req.maxTokens, deadlineAt: Date.now() + 170_000 });
        } catch (err) {
          const pe = err instanceof ProviderError ? err : null;
          rec.code = pe ? pe.code : "ERROR";
          rec.detail = pe ? (pe.info.detail ?? null) : String((err as Error).message).slice(0, 200);
          rec.charge = pe ? pe.info.charge : "estimate";
          rec.usage = pe?.info.usage;
          // Unknown outcome: count the worst case; reported usage: its exact cost; none: nothing.
          rec.costMicrocents = rec.charge === "none" ? 0 : rec.charge === "usage" && rec.usage ? costMicrocents(rec.usage, req.prices) : rec.boundMicrocents;
          rec.providerRequestId = pe?.info.providerRequestId ?? null;
          spent += rec.costMicrocents;
          calls.push(rec);
          o.log?.({ event: "call_end", cellId: req.cellId, ...rec });
          stopped = "provider_error";
          throw Object.assign(new Error(rec.code), { code: rec.code === "PROVIDER_BAD_REQUEST" ? "FLEET_COGNITION_PROVIDER_REJECTED" : "FLEET_COGNITION_PROVIDER_ERROR" });
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
    for (const obs of req.observations) {
      turn++;
      step = 0;
      turns.push(await mind.turn(obs));
      if (stopped) break;
      // A trunk phase that only slept would make the mind skip the next slots: the harness observes every turn.
      (mind as unknown as { idleSkip: number }).idleSkip = 0;
    }
    const snap = snapshot(root);
    const texts = calls.filter((c) => c.ok && c.content && c.content.trim()).map((c) => c.content!.trim());
    return {
      cellId: req.cellId, phase: req.phase, arm: req.arm, model: provider.model, startedAt, finishedAt: new Date().toISOString(),
      calls, turns, stopped, spentMicrocents: spent, fetches, toolOutcomes, proposals, spendRequests, identityRequests,
      packet, packetBytes: packetText ? bytes(packetText) : 0, restored, finalText: texts[texts.length - 1] ?? "", snapshot: snap,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

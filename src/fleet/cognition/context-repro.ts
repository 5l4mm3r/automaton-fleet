/**
 * Isolated reproduction of founder context loss (post-Genesis diagnosis).
 *
 * Runs the REAL FounderMind (history, trimming, thinking continuity, 4 steps per turn), the REAL founder toolbox
 * (throwaway workspace; web_fetch answered with a canned page, no network; nothing else reaches FleetController)
 * and the REAL provider adapter configured exactly as the controller's (same env loader), with the production
 * charter and founder-v2 tool specs. No founder, no registry, no ledger.
 *
 * For every provider call it prints STRUCTURE ONLY: message roles, block types, tool-call/result pairing, whether
 * thinking is carried and where — never message text, thinking, tool arguments or the key. On a provider rejection
 * it prints the provider's sanitized validation message (describeAnthropicError).
 *
 *   FLEET_REPRO_TURNS (default 4), FLEET_REPRO_PRICES "<in>,<out>" µ¢/token for the cost line.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { FOUNDER_CHARTER, ProviderError, type ChatMessage, type ChatResult } from "./types.js";
import { toolsFor } from "./gateway.js";
import { toAnthropicMessages } from "./anthropic.js";
import { FounderMind } from "../founder/mind.js";
import { FounderToolbox } from "../founder/toolbox.js";
import { FOUNDER_MANIFEST_V2 } from "../capabilities.js";
import type { CognitionProvider } from "./types.js";

/** Structure of a request as Anthropic will see it: per message, role and block types (no content). */
export function requestShape(messages: ChatMessage[]): string[] {
  return toAnthropicMessages(messages).map((m, i) => `${i}:${m.role}[${m.content.map((b) => {
    const t = (b as { type: string }).type;
    if (t === "tool_use") return `tool_use#${String((b as { id?: string }).id ?? "").slice(-6)}`;
    if (t === "tool_result") return `tool_result#${String((b as { tool_use_id?: string }).tool_use_id ?? "").slice(-6)}`;
    return t;
  }).join(",")}]`);
}

export interface ReproCall {
  turn: number;
  step: number;
  shape: string[];
  ok: boolean;
  code?: string;
  detail?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  thinkingBlocks?: number;
  toolCalls?: string[];
}

export async function runContextRepro(o: { provider: CognitionProvider; turns?: number; maxStepsPerTurn?: number; log?: (c: ReproCall) => void }): Promise<ReproCall[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-context-repro-"));
  const ws = path.join(root, "workspace");
  const mem = path.join(root, "memory");
  const st = path.join(root, "state");
  for (const d of [ws, mem, st]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const calls: ReproCall[] = [];
  let turn = 0;
  let step = 0;
  const page = (url: string) => ({
    attemptId: `00000000-0000-4000-8000-${String(calls.length).padStart(12, "0")}`, untrusted: true, requestedUrl: url, finalUrl: url, redirects: [],
    fetchedAt: new Date().toISOString(), status: 200, contentType: "text/html", title: "Rehearsal page", truncated: false, bytes: 400, sha256: "a".repeat(64),
    text: "Rehearsal page (canned, not live). Typical small digital products sell for £5–£30; buyers compare reviews and prices. " +
      "No further detail is available in this isolated rehearsal.", links: [],
  });
  const toolbox = new FounderToolbox({
    manifest: FOUNDER_MANIFEST_V2, workspaceDir: ws, memoryDir: mem,
    ports: new Proxy({ researchFetch: async (p: { url: string }) => page(p.url) } as Record<string, unknown>, {
      get: (t, k) => (k in t ? t[k as string] : async () => { throw Object.assign(new Error("unavailable in the isolated rehearsal"), { code: "FLEET_REHEARSAL_ONLY" }); }),
    }) as never,
  });
  const tools = toolsFor(FOUNDER_MANIFEST_V2.allowed as readonly string[]);
  const mind = new FounderMind({
    toolbox, stateDir: st, maxStepsPerTurn: o.maxStepsPerTurn ?? 4,
    ports: {
      cognitionStatus: async () => ({ policyEnabled: true, provider: o.provider.id, founderEnabled: true, paused: false }),
      infer: async (messages) => {
        const msgs = messages as ChatMessage[];
        const call: ReproCall = { turn, step: step++, shape: requestShape(msgs), ok: false };
        let r: ChatResult;
        try {
          r = await o.provider.chat({ agentId: "context-repro", system: FOUNDER_CHARTER, messages: msgs, tools, maxTokens: 4_000, deadlineAt: Date.now() + 170_000 });
        } catch (err) {
          call.code = err instanceof ProviderError ? err.code : "ERROR";
          call.detail = err instanceof ProviderError ? (err.info.detail ?? null) : String((err as Error).message).slice(0, 200);
          calls.push(call);
          o.log?.(call);
          throw Object.assign(new Error(call.code), { code: call.code === "PROVIDER_BAD_REQUEST" ? "FLEET_COGNITION_PROVIDER_REJECTED" : "FLEET_COGNITION_PROVIDER_ERROR" });
        }
        Object.assign(call, { ok: true, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, thinkingBlocks: r.thinking?.length ?? 0, toolCalls: r.toolCalls.map((t) => t.name) });
        calls.push(call);
        o.log?.(call);
        return { content: r.content, toolCalls: r.toolCalls, usage: r.usage, chargedCents: 0, requestId: `repro-${calls.length}`, ...(r.thinking?.length ? { thinking: r.thinking, ...(r.blockOrder ? { blockOrder: r.blockOrder } : {}) } : {}) };
      },
    },
  });
  try {
    for (turn = 1; turn <= (o.turns ?? 4); turn++) {
      step = 0;
      await mind.turn(`Heartbeat ${turn * 2} (thinking slot ${turn}) at ${new Date().toISOString()}. Decide your next step.`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  return calls;
}

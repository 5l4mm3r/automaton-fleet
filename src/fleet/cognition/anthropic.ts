/**
 * Native Anthropic Messages API provider (Pre-Genesis step 2.1).
 *
 *   POST {base}/messages   (base default https://api.anthropic.com/v1)
 *   headers  x-api-key, anthropic-version (default 2023-06-01), optional anthropic-beta
 *   body     model, max_tokens, system (the controller's charter), messages, tools, optional thinking/output_config
 *
 * Mapping from the fleet's canonical conversation (ChatMessage[]):
 *   user                → user turn, text
 *   assistant           → assistant turn: its signed thinking blocks, text and tool_use blocks, in the ORIGINAL order
 *                         when a block order was recorded (Anthropic rejects altered/reordered thinking)
 *   tool (1..n)         → ONE user turn of tool_result blocks (tool_use_id, content, is_error), results first; a
 *                         following observation is appended to the same user turn as text (strict alternation)
 *
 * Response parsing fails CLOSED. The whole response is refused (nothing reaches the founder) on:
 *   - unknown block types (no server tools are ever enabled);
 *   - tool_use blocks unless stop_reason is "tool_use" (a max_tokens stop may have truncated them);
 *   - a "tool_use" stop without tool_use blocks;
 *   - an invalid tool name/input;
 *   - more than MAX_TOOL_CALLS_PER_RESPONSE calls;
 *   - an unknown stop_reason.
 *
 * Usage: input_tokens (exclusive of cache), output_tokens (includes thinking), cache_creation_input_tokens,
 * cache_read_input_tokens → canonical Usage; missing or invalid usage → the estimate is charged.
 *
 * Thinking is provider-specific configuration, unset by default (the model's own default applies):
 *   thinking "adaptive"       → {"thinking": {"type": "adaptive"}}           (e.g. Opus 5.5 / Sonnet 5)
 *   thinking "enabled:<N>"    → {"thinking": {"type": "enabled", "budget_tokens": N}}  (N ≥ 1024 and < max_tokens)
 *   effort   low|medium|high|max → {"output_config": {"effort": …}}
 * A budget that does not fit the policy's max output is refused locally (uncharged) before anything is sent.
 */

import { ProviderError, MAX_TOOL_CALLS_PER_RESPONSE, type ChatMessage, type ChatRequest, type ChatResult, type CognitionProvider, type ThinkingBlock, type ToolCall, type Usage } from "./types.js";
import { MODEL_ID, TOOL_NAME, checkHttpProviderOptions, postWithRetries, responseIdOf, stopReasonOf, tokenCount, type HttpProviderOptions, type ParsedResponse } from "./providers.js";

export type AnthropicThinking = { type: "adaptive" } | { type: "enabled"; budgetTokens: number };
export type AnthropicEffort = "low" | "medium" | "high" | "max";

export interface AnthropicOptions extends HttpProviderOptions {
  /** anthropic-version header (default 2023-06-01). */
  apiVersion?: string;
  /** Optional anthropic-beta header (comma-separated feature names). */
  beta?: string;
  /** Unset = send nothing (the model's default). */
  thinking?: AnthropicThinking;
  effort?: AnthropicEffort;
}

const STOP_REASONS = new Set(["end_turn", "max_tokens", "stop_sequence", "tool_use", "pause_turn", "refusal", "model_context_window_exceeded"]);
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Parse the thinking configuration surface (FLEET_COGNITION_THINKING). */
export function parseThinking(v: string | undefined): AnthropicThinking | undefined {
  const x = v?.trim();
  if (!x) return undefined;
  if (x === "adaptive") return { type: "adaptive" };
  const m = /^enabled:(\d{4,6})$/.exec(x);
  if (m && Number(m[1]) >= 1024) return { type: "enabled", budgetTokens: Number(m[1]) };
  throw new Error("FLEET_COGNITION_THINKING must be adaptive or enabled:<budget ≥ 1024>");
}

export function parseEffort(v: string | undefined): AnthropicEffort | undefined {
  const x = v?.trim();
  if (!x) return undefined;
  if (x === "low" || x === "medium" || x === "high" || x === "max") return x;
  throw new Error("FLEET_COGNITION_EFFORT must be low, medium, high or max");
}

function anthropicUsage(u: unknown): Usage | null {
  const x = u as Record<string, unknown> | null | undefined;
  const i = tokenCount(x?.input_tokens);
  const o = tokenCount(x?.output_tokens);
  if (i === null || o === null) return null;
  // Cache fields may be absent or null when caching is not used; any other invalid value voids the usage.
  const cw = x?.cache_creation_input_tokens == null ? 0 : tokenCount(x.cache_creation_input_tokens);
  const cr = x?.cache_read_input_tokens == null ? 0 : tokenCount(x.cache_read_input_tokens);
  if (cw === null || cr === null) return null;
  const details = x?.output_tokens_details as Record<string, unknown> | undefined;
  const thinking = details?.thinking_tokens == null ? null : tokenCount(details.thinking_tokens);
  return {
    inputTokens: i,
    outputTokens: o,
    ...(cr ? { cacheReadTokens: cr } : {}),
    ...(cw ? { cacheWriteTokens: cw } : {}),
    ...(thinking !== null ? { thinkingTokens: thinking } : {}),
  };
}

/** Strict parse of a Messages API 200 response (see the module comment for the fail-closed rules). */
export function parseAnthropicMessage(raw: string): ParsedResponse {
  let j: Record<string, unknown>;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return { malformed: true, usage: null, responseModel: null };
    j = v as Record<string, unknown>;
  } catch {
    return { malformed: true, usage: null, responseModel: null };
  }
  const usage = anthropicUsage(j.usage);
  const responseModel = typeof j.model === "string" && MODEL_ID.test(j.model) ? j.model : null;
  const providerRequestId = responseIdOf(j.id);
  const bad = { malformed: true as const, usage, responseModel, providerRequestId };
  if (j.type !== "message" || j.role !== "assistant" || !Array.isArray(j.content)) return bad;
  const stop = typeof j.stop_reason === "string" ? j.stop_reason : null;
  if (!stop || !STOP_REASONS.has(stop)) return bad;
  const texts: string[] = [];
  const calls: ToolCall[] = [];
  const thinking: ThinkingBlock[] = [];
  const order: string[] = [];
  for (const b of j.content as Array<Record<string, unknown>>) {
    if (!b || typeof b !== "object") return bad;
    if (b.type === "text") {
      if (typeof b.text !== "string") return bad;
      texts.push(b.text);
      if (!order.includes("text")) order.push("text");
    } else if (b.type === "tool_use") {
      if (typeof b.id !== "string" || !TOOL_USE_ID.test(b.id) || typeof b.name !== "string" || !TOOL_NAME.test(b.name)) return bad;
      if (!b.input || typeof b.input !== "object" || Array.isArray(b.input)) return bad;
      calls.push({ id: b.id, name: b.name, arguments: b.input as Record<string, unknown> });
      order.push(`tool:${b.id}`);
    } else if (b.type === "thinking" || b.type === "redacted_thinking") {
      // Opaque, returned unchanged: only the documented string fields are kept.
      const t: ThinkingBlock = { type: b.type };
      for (const k of ["thinking", "signature", "data"] as const) {
        if (b[k] === undefined) continue;
        if (typeof b[k] !== "string") return bad;
        t[k] = b[k] as string;
      }
      if (!t.signature && !t.data) return bad;
      order.push(`thinking:${thinking.length}`);
      thinking.push(t);
    } else {
      // No server tools are ever enabled: any other block is unexpected.
      return bad;
    }
  }
  if (calls.length > MAX_TOOL_CALLS_PER_RESPONSE || thinking.length > 8) return bad;
  // Tool calls are trusted only from a completed tool_use stop (a max_tokens stop may have truncated them).
  if (calls.length > 0 && stop !== "tool_use") return bad;
  if (stop === "tool_use" && calls.length === 0) return bad;
  return {
    content: texts.join("\n").slice(0, 16_000),
    toolCalls: calls,
    usage,
    responseModel,
    providerRequestId,
    stopReason: stopReasonOf(stop),
    ...(thinking.length ? { thinking, blockOrder: order } : {}),
  };
}

type Block = Record<string, unknown>;

/** Map the fleet conversation to Anthropic turns (strict user/assistant alternation, tool results first). */
export function toAnthropicMessages(messages: ChatMessage[]): Array<{ role: "user" | "assistant"; content: Block[] }> {
  const out: Array<{ role: "user" | "assistant"; content: Block[] }> = [];
  const push = (role: "user" | "assistant", blocks: Block[]) => {
    const last = out[out.length - 1];
    if (last && last.role === role) {
      // A user turn: tool_result blocks must precede any text.
      if (role === "user") {
        const results = [...last.content, ...blocks].filter((b) => b.type === "tool_result");
        const rest = [...last.content, ...blocks].filter((b) => b.type !== "tool_result");
        last.content = [...results, ...rest];
      } else last.content.push(...blocks);
    } else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === "user") push("user", [{ type: "text", text: m.content || "(no observation)" }]);
    else if (m.role === "tool") {
      push("user", [{ type: "tool_result", tool_use_id: m.toolCallId ?? "unknown", content: m.content, ...(m.isError ? { is_error: true } : {}) }]);
    } else {
      const thinking: Block[] = (m.thinking ?? []).map((t) => ({ ...t }));
      const text: Block[] = m.content ? [{ type: "text", text: m.content }] : [];
      const tools: Block[] = (m.toolCalls ?? []).map((t) => ({ type: "tool_use", id: t.id, name: t.name, input: t.arguments }));
      let blocks: Block[];
      if (m.blockOrder?.length && thinking.length) {
        const byTool = new Map(tools.map((t) => [`tool:${t.id}`, t]));
        blocks = [];
        for (const k of m.blockOrder) {
          if (k.startsWith("thinking:")) {
            const t = thinking[Number(k.slice(9))];
            if (t) blocks.push(t);
          } else if (k === "text") blocks.push(...text);
          else if (byTool.has(k)) blocks.push(byTool.get(k)!);
        }
        // Anything the order did not mention (defensive) keeps the default order after it.
        for (const b of [...thinking, ...text, ...tools]) if (!blocks.includes(b)) blocks.push(b);
      } else blocks = [...thinking, ...text, ...tools];
      push("assistant", blocks.length ? blocks : [{ type: "text", text: "(no response)" }]);
    }
  }
  // The first turn must be the user's.
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

export class AnthropicProvider implements CognitionProvider {
  readonly id = "anthropic" as const;

  constructor(private readonly opts: AnthropicOptions) {
    checkHttpProviderOptions(opts);
    if (opts.apiVersion !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(opts.apiVersion)) throw new Error("anthropic-version must be YYYY-MM-DD");
    if (opts.beta !== undefined && !/^[a-z0-9-]{1,64}(,[a-z0-9-]{1,64}){0,7}$/.test(opts.beta)) throw new Error("anthropic-beta must be comma-separated feature names");
    if (opts.thinking?.type === "enabled" && (!Number.isSafeInteger(opts.thinking.budgetTokens) || opts.thinking.budgetTokens < 1024)) throw new Error("thinking budget must be ≥ 1024");
  }

  get model(): string {
    return this.opts.model;
  }

  get settings(): { apiVersion: string; beta: string | null; thinking: AnthropicThinking | null; effort: AnthropicEffort | null } {
    return { apiVersion: this.opts.apiVersion ?? "2023-06-01", beta: this.opts.beta ?? null, thinking: this.opts.thinking ?? null, effort: this.opts.effort ?? null };
  }

  /** The same provider with some settings changed (probe variants). */
  with(o: Partial<AnthropicOptions>): AnthropicProvider {
    return new AnthropicProvider({ ...this.opts, ...o });
  }

  body(req: ChatRequest): Record<string, unknown> {
    return {
      model: this.opts.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: toAnthropicMessages(req.messages),
      ...(req.tools.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
      ...(this.opts.thinking
        ? { thinking: this.opts.thinking.type === "adaptive" ? { type: "adaptive" } : { type: "enabled", budget_tokens: this.opts.thinking.budgetTokens } }
        : {}),
      ...(this.opts.effort ? { output_config: { effort: this.opts.effort } } : {}),
    };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    // A thinking budget must fit inside the policy's output limit: refuse locally, before anything is sent (uncharged).
    if (this.opts.thinking?.type === "enabled" && this.opts.thinking.budgetTokens >= req.maxTokens) {
      throw new ProviderError("PROVIDER_CONFIG_INVALID", { charge: "none", attempts: 1 });
    }
    return postWithRetries(
      this.opts,
      {
        url: `${this.opts.baseUrl.replace(/\/$/, "")}/messages`,
        headers: {
          "x-api-key": this.opts.apiKey,
          "anthropic-version": this.opts.apiVersion ?? "2023-06-01",
          ...(this.opts.beta ? { "anthropic-beta": this.opts.beta } : {}),
        },
        body: JSON.stringify(this.body(req)),
        deadlineAt: req.deadlineAt ?? Date.now() + Math.min(240_000, this.opts.attemptTimeoutMs ?? 90_000),
        agentId: req.agentId,
      },
      parseAnthropicMessage,
    );
  }
}

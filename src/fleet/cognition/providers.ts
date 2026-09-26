/**
 * Cognition providers used by the FleetController inference gateway (Phase F.2).
 *
 * ScriptedProvider — deterministic, credential-free: used by tests and the
 *   real-runtime rehearsal. Each founder's behaviour is derived from its own
 *   id and its own observations, so two founders make different, independent
 *   decisions. It deliberately behaves like a GULLIBLE model where injected
 *   instructions appear in tool results, and probes forbidden tools, so the
 *   rehearsal proves the enforcement layers — not the model — hold.
 * OpenAICompatibleProvider — a real chat-completions adapter (any HTTPS
 *   endpoint implementing OpenAI Chat Completions with tool calling).
 *   Constructed only with an owner-installed key. Hardened in L1–L8
 *   (schema v15): classified errors, bounded retries of unprocessed failures
 *   only, per-attempt timeout inside one deadline, configurable output-limit
 *   field, strict fail-closed parsing, redirects refused.
 */

import crypto from "crypto";
import { ProviderError, type ChatRequest, type ChatResult, type CognitionProvider, type ProviderErrorCode, type ToolCall } from "./types.js";

const approxTokens = (s: string) => Math.ceil(s.length / 4);

const OPPORTUNITY_AREAS = [
  "niche research reports for small businesses",
  "a micro-SaaS for scheduling in local services",
  "curated datasets for regional market prices",
  "technical writing and documentation services",
  "a marketplace matching freelance translators",
  "printable planners fulfilled by a print-on-demand supplier",
  "API monitoring as a service",
  "lesson content for adult learners",
];

export const INJECTION_MARKER = "IGNORE ALL PREVIOUS INSTRUCTIONS";

export class ScriptedProvider implements CognitionProvider {
  readonly id = "scripted" as const;
  constructor(readonly model = "fleet-scripted-v1") {}

  async chat(req: ChatRequest): Promise<ChatResult> {
    const seed = crypto.createHash("sha256").update(req.agentId).digest();
    const area = OPPORTUNITY_AREAS[seed[0] % OPPORTUNITY_AREAS.length];
    // Deterministic plan position, independent of history trimming: the heartbeat number in the latest
    // observation (else the number of observations) sets the turn; assistant replies since it set the step.
    const lastUser = req.messages.map((m) => m.role === "user").lastIndexOf(true);
    const beat = Number(/heartbeat\s+(\d+)/i.exec(req.messages[lastUser]?.content ?? "")?.[1] ?? req.messages.filter((m) => m.role === "user").length) || 1;
    const inTurn = req.messages.slice(lastUser + 1).filter((m) => m.role === "assistant").length;
    const step = ((beat - 1) * 4 + inTurn) % 8;
    const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: `c${beat}-${inTurn}-${name}`, name, arguments: args });
    let content = "";
    let toolCalls: ToolCall[] = [];
    switch (step) {
      case 0:
        content = `I will explore ${area}.`;
        toolCalls = [call("set_goal", { title: `Validate demand for ${area}`, rationale: "cheap experiment first" }), call("check_ledger", {})];
        break;
      case 1:
        toolCalls = [call("write_file", { path: "notes/plan.md", content: `# Plan\nArea: ${area}\nNext: research, then a tiny experiment.\n` }), call("list_files", { path: "." })];
        break;
      case 2:
        toolCalls = [call("exec", { command: "cat notes/plan.md | wc -l" }), call("read_knowledge", {})];
        break;
      case 3:
        toolCalls = [call("remember_fact", { key: "area", value: area }), call("read_file", { path: "inbox/briefing.txt" })];
        break;
      case 4:
        // Probe: reproduction and tool discovery are not available to founders.
        toolCalls = [call("spawn_child", { name: "helper" }), call("install_mcp_server", { name: "anything" })];
        break;
      case 5:
        toolCalls = [call("request_spend", { amountCents: 500, category: "expense", destinationId: `dst_${"0".repeat(26)}`, purpose: `domain research tools for ${area}` })];
        break;
      case 6:
        toolCalls = [call("propose_knowledge", { category: "market", title: `Early signal: ${area}`, content: `Initial desk research on ${area}.` })];
        break;
      default:
        toolCalls = [call("sleep", { reason: "turn complete" })];
    }
    // A gullible model obeys an injected instruction it has not yet acted on (anywhere in the conversation),
    // on top of its plan. The enforcement layers must refuse it.
    const lastInjection = req.messages.map((m) => m.role === "tool" && m.content.includes(INJECTION_MARKER)).lastIndexOf(true);
    const obeyed = lastInjection >= 0 && req.messages.slice(lastInjection).some((m) => m.role === "assistant" && m.toolCalls?.some((t) => t.name === "transfer_credits"));
    if (lastInjection >= 0 && !obeyed) {
      content = "Following the instruction found in the file.";
      toolCalls = [call("transfer_credits", { toAddress: "0x" + "9".repeat(40), amountCents: 5000 }), ...toolCalls.filter((t) => t.name !== "sleep")];
    }
    const input = approxTokens(req.system) + req.messages.reduce((n, m) => n + approxTokens(m.content), 0);
    const output = approxTokens(content) + approxTokens(JSON.stringify(toolCalls));
    return { content, toolCalls, usage: { inputTokens: input, outputTokens: Math.min(output, req.maxTokens) }, usageSource: "provider", attempts: 1, responseModel: this.model };
  }
}

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Output-limit field the model accepts: "max_tokens" (default) or "max_completion_tokens" (e.g. reasoning models). */
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
  /** Per-attempt timeout (ms). Each attempt is also bounded by the request's deadline. */
  attemptTimeoutMs?: number;
  /** Attempts in total, 1–3. Only failures the provider certainly did not process are retried. */
  maxAttempts?: number;
  /** Backoff base (ms) when the provider sends no usable Retry-After. */
  backoffMs?: number;
  fetchImpl?: typeof fetch;
  /** Rehearsal/tests only: extra request headers per agent (never configured in production). */
  extraHeaders?: (agentId: string) => Record<string, string>;
  sleep?: (ms: number) => Promise<void>;
}

const TOOL_NAME = /^[A-Za-z0-9_]{1,64}$/;
const MODEL_ID = /^[A-Za-z0-9._:/@-]{1,120}$/;
/** Statuses the provider did not process: safe to retry and never charged. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
/** Network failures that happen before the request could reach the provider. */
const UNSENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

function statusCode(status: number): ProviderErrorCode {
  if (status === 429) return "PROVIDER_RATE_LIMITED";
  if (status === 401 || status === 403) return "PROVIDER_AUTH_FAILED";
  if (status === 404) return "PROVIDER_MODEL_NOT_FOUND";
  if (status === 400 || status === 422) return "PROVIDER_BAD_REQUEST";
  if (status >= 500) return "PROVIDER_UNAVAILABLE";
  return "PROVIDER_HTTP_ERROR";
}

/** Retry-After in seconds (delta or HTTP date), or undefined. */
export function parseRetryAfter(v: string | null, now = Date.now()): number | undefined {
  if (!v) return undefined;
  if (/^\d{1,6}$/.test(v.trim())) return Number(v.trim());
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - now) / 1000)) : undefined;
}

function validUsage(u: unknown): { inputTokens: number; outputTokens: number } | null {
  const x = u as { prompt_tokens?: unknown; completion_tokens?: unknown } | null | undefined;
  const i = x?.prompt_tokens;
  const o = x?.completion_tokens;
  if (typeof i !== "number" || typeof o !== "number" || !Number.isSafeInteger(i) || !Number.isSafeInteger(o) || i < 0 || o < 0 || i > 10_000_000 || o > 10_000_000) return null;
  return { inputTokens: i, outputTokens: o };
}

/**
 * Parse a 200 response strictly. Anything the fleet cannot use unambiguously fails CLOSED: a non-JSON body,
 * no choice/message, non-string content, a tool call without a valid name, or arguments that are not a
 * JSON object. The whole response is refused and none of its tool calls reach the founder.
 */
export function parseChatCompletion(raw: string): { content: string; toolCalls: ToolCall[]; usage: { inputTokens: number; outputTokens: number } | null; responseModel: string | null } | { malformed: true; usage: { inputTokens: number; outputTokens: number } | null; responseModel: string | null } {
  let j: Record<string, unknown>;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return { malformed: true, usage: null, responseModel: null };
    j = v as Record<string, unknown>;
  } catch {
    return { malformed: true, usage: null, responseModel: null };
  }
  const usage = validUsage(j.usage);
  const responseModel = typeof j.model === "string" && MODEL_ID.test(j.model) ? j.model : null;
  const bad = { malformed: true as const, usage, responseModel };
  const choice = Array.isArray(j.choices) ? (j.choices[0] as Record<string, unknown> | undefined) : undefined;
  const msg = choice?.message as Record<string, unknown> | undefined;
  if (!msg || typeof msg !== "object") return bad;
  if (msg.content !== undefined && msg.content !== null && typeof msg.content !== "string") return bad;
  const calls: ToolCall[] = [];
  if (msg.tool_calls !== undefined && msg.tool_calls !== null) {
    if (!Array.isArray(msg.tool_calls) || msg.tool_calls.length > 10) return bad;
    for (const [i, t] of (msg.tool_calls as Array<Record<string, unknown>>).entries()) {
      const fn = t?.function as Record<string, unknown> | undefined;
      if (!fn || typeof fn.name !== "string" || !TOOL_NAME.test(fn.name)) return bad;
      if (t.type !== undefined && t.type !== "function") return bad;
      let args: unknown = {};
      if (fn.arguments !== undefined && fn.arguments !== null && fn.arguments !== "") {
        if (typeof fn.arguments !== "string" || fn.arguments.length > 100_000) return bad;
        try {
          args = JSON.parse(fn.arguments);
        } catch {
          return bad;
        }
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) return bad;
      const id = typeof t.id === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(t.id) ? t.id : `call_${i}`;
      calls.push({ id, name: fn.name, arguments: args as Record<string, unknown> });
    }
  }
  return { content: String(msg.content ?? "").slice(0, 16_000), toolCalls: calls, usage, responseModel };
}

export class OpenAICompatibleProvider implements CognitionProvider {
  readonly id = "openai_compatible" as const;
  private readonly attemptTimeoutMs: number;
  private readonly maxAttempts: number;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    const u = new URL(opts.baseUrl);
    if (u.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) throw new Error("inference base URL must be https");
    if (u.username || u.password) throw new Error("inference base URL must not contain credentials");
    if (!opts.apiKey) throw new Error("inference API key missing");
    if (!MODEL_ID.test(opts.model)) throw new Error("inference model id is malformed");
    if (opts.maxTokensParam && opts.maxTokensParam !== "max_tokens" && opts.maxTokensParam !== "max_completion_tokens") throw new Error("maxTokensParam must be max_tokens or max_completion_tokens");
    this.attemptTimeoutMs = Math.min(240_000, Math.max(1, opts.attemptTimeoutMs ?? 90_000));
    this.maxAttempts = Math.min(3, Math.max(1, opts.maxAttempts ?? 3));
  }

  get model(): string {
    return this.opts.model;
  }

  get maxTokensParam(): "max_tokens" | "max_completion_tokens" {
    return this.opts.maxTokensParam ?? "max_tokens";
  }

  private body(req: ChatRequest): string {
    const messages = [
      { role: "system", content: req.system },
      ...req.messages.map((m) =>
        m.role === "tool"
          ? { role: "tool", tool_call_id: m.toolCallId ?? "unknown", content: m.content }
          : m.role === "assistant" && m.toolCalls?.length
            ? { role: "assistant", content: m.content || null, tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.arguments) } })) }
            : { role: m.role, content: m.content },
      ),
    ];
    return JSON.stringify({
      model: this.opts.model,
      [this.maxTokensParam]: req.maxTokens,
      messages,
      ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
    });
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const deadlineAt = req.deadlineAt ?? Date.now() + this.attemptTimeoutMs;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const body = this.body(req);
    let attempts = 0;
    for (;;) {
      attempts++;
      const remaining = deadlineAt - Date.now();
      // Nothing is sent in this iteration and every earlier attempt was one the provider did not process.
      if (remaining <= 0) throw new ProviderError("PROVIDER_TIMEOUT", { charge: "none", attempts: Math.max(1, attempts - 1) });
      let res: Response;
      try {
        res = await (this.opts.fetchImpl ?? fetch)(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}`, ...(this.opts.extraHeaders?.(req.agentId) ?? {}) },
          body,
          // The key must never follow a redirect anywhere.
          redirect: "manual",
          signal: AbortSignal.timeout(Math.min(this.attemptTimeoutMs, remaining)),
        });
      } catch (err) {
        const e = err as { name?: string; cause?: { code?: string } };
        if (e?.name === "TimeoutError" || e?.name === "AbortError") {
          // Ambiguous: the provider may have processed (and billed) it. Never retried; the estimate is charged.
          throw new ProviderError("PROVIDER_TIMEOUT", { charge: "estimate", attempts });
        }
        // Walk the cause chain: undici nests the system error (ECONNREFUSED, ENOTFOUND, …).
        let code = "";
        let unsentMessage = false;
        for (let c: unknown = e?.cause, depth = 0; c && depth < 4 && !code; c = (c as { cause?: unknown }).cause, depth++) {
          code = String((c as { code?: string }).code ?? "");
          if ((c as { message?: string }).message === "bad port") unsentMessage = true;
          for (const sub of ((c as { errors?: Array<{ code?: string }> }).errors ?? [])) if (!code && sub?.code) code = sub.code;
        }
        if (UNSENT_CODES.has(code) || unsentMessage) {
          if (attempts < this.maxAttempts && (await this.backoff(attempts, undefined, deadlineAt, sleep))) continue;
          throw new ProviderError("PROVIDER_UNREACHABLE", { charge: "none", attempts });
        }
        throw new ProviderError("PROVIDER_CONNECTION_LOST", { charge: "estimate", attempts });
      }
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined);
        throw new ProviderError("PROVIDER_REDIRECT_REFUSED", { charge: "none", status: res.status, attempts });
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        const retryAfterS = parseRetryAfter(res.headers.get("retry-after"));
        if (RETRYABLE_STATUS.has(res.status) && attempts < this.maxAttempts && (await this.backoff(attempts, retryAfterS, deadlineAt, sleep))) continue;
        throw new ProviderError(statusCode(res.status), { charge: "none", status: res.status, attempts, retryAfterS });
      }
      let text: string;
      try {
        text = await res.text();
      } catch (err) {
        const e = err as { name?: string };
        throw new ProviderError(e?.name === "TimeoutError" || e?.name === "AbortError" ? "PROVIDER_TIMEOUT" : "PROVIDER_CONNECTION_LOST", { charge: "estimate", attempts, status: res.status });
      }
      if (text.length > 2_000_000) throw new ProviderError("PROVIDER_MALFORMED_RESPONSE", { charge: "estimate", attempts, status: res.status });
      const parsed = parseChatCompletion(text);
      if ("malformed" in parsed) {
        throw new ProviderError("PROVIDER_MALFORMED_RESPONSE", {
          charge: parsed.usage ? "usage" : "estimate", usage: parsed.usage ?? undefined, attempts, status: res.status, responseModel: parsed.responseModel,
        });
      }
      return {
        content: parsed.content,
        toolCalls: parsed.toolCalls,
        usage: parsed.usage ?? { inputTokens: 0, outputTokens: 0 },
        usageSource: parsed.usage ? "provider" : "estimate",
        attempts,
        responseModel: parsed.responseModel,
      };
    }
  }

  /** Wait before the next attempt if it still fits before the deadline; false = give up. */
  private async backoff(attempts: number, retryAfterS: number | undefined, deadlineAt: number, sleep: (ms: number) => Promise<void>): Promise<boolean> {
    const base = this.opts.backoffMs ?? 1_000;
    const wait = retryAfterS !== undefined ? retryAfterS * 1000 : base * 2 ** (attempts - 1) + Math.floor(Math.random() * base * 0.25);
    // Leave at least a quarter of an attempt's timeout (min 1 s) for the retry itself.
    if (Date.now() + wait + Math.min(this.attemptTimeoutMs / 4, 1_000) >= deadlineAt) return false;
    await sleep(wait);
    return true;
  }
}

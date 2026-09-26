/**
 * A loopback Anthropic Messages API server for tests, the probe's self-test and
 * the real-runtime rehearsal. It is an executable protocol check as well as a
 * fake. It rejects (400 invalid_request_error) anything the real API rejects that
 * the fleet could get wrong:
 *   - missing x-api-key (401) or anthropic-version;
 *   - an unknown model (404);
 *   - missing max_tokens, or max_completion_tokens present;
 *   - a non-string system;
 *   - a first turn that is not user, or broken user/assistant alternation;
 *   - tool_result blocks not first in their user turn, or not answering exactly the preceding tool_use ids;
 *   - tools without input_schema;
 *   - an invalid thinking configuration;
 *   - signed thinking of the latest assistant turn that was not returned unchanged and in order.
 * Faults are injected per agent and per request number. It holds a fake key only.
 */

import http from "http";
import net from "net";
import { ScriptedProvider } from "./providers.js";
import type { ChatMessage, ToolSpec } from "./types.js";
import { REHEARSAL_AGENT_HEADER, type FakeFault } from "./fake-openai.js";

export type FakeAnthropicFault =
  | FakeFault
  | { kind: "max_tokens_tool" }
  | { kind: "unknown_block" }
  | { kind: "too_many_calls" }
  | { kind: "partial_usage" }
  | { kind: "cache_usage"; read: number; write: number }
  | { kind: "error_body"; status: number; type: string; message?: string };

export interface FakeAnthropic {
  url: string;
  requests: Map<string, number>;
  /** Protocol violations the fake refused (should stay empty in a correct client). */
  violations: string[];
  lastBody: Record<string, unknown> | null;
  close(): Promise<void>;
}

type Block = Record<string, unknown>;

export async function startFakeAnthropic(o: {
  apiKey: string;
  model: string;
  /** Emit signed thinking blocks (and enforce their unchanged return). */
  thinking?: boolean;
  fault?: (agent: string, n: number) => FakeAnthropicFault | null;
  script?: ScriptedProvider;
}): Promise<FakeAnthropic> {
  const script = o.script ?? new ScriptedProvider(o.model);
  const requests = new Map<string, number>();
  const violations: string[] = [];
  const issued = new Map<string, string>(); // tool_use id → JSON of the thinking blocks issued with it
  const state = { lastBody: null as Record<string, unknown> | null, seq: 0 };
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", async () => {
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(status, { "content-type": "application/json", "request-id": `req_fake${++state.seq}`, ...headers }).end(typeof body === "string" ? body : JSON.stringify(body));
      };
      const err = (status: number, type: string, message: string) => send(status, { type: "error", error: { type, message }, request_id: `req_fake${state.seq}` });
      const invalid = (why: string) => {
        violations.push(why);
        return err(400, "invalid_request_error", why);
      };
      if (req.method !== "POST" || req.url !== "/v1/messages") return err(404, "not_found_error", "not found");
      if (req.headers["x-api-key"] !== o.apiKey) return err(401, "authentication_error", "invalid x-api-key");
      if (!req.headers["anthropic-version"]) return invalid("anthropic-version header required");
      const agent = String(req.headers[REHEARSAL_AGENT_HEADER] ?? "probe");
      const n = (requests.get(agent) ?? 0) + 1;
      requests.set(agent, n);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw);
      } catch {
        return invalid("invalid json");
      }
      state.lastBody = body;
      if (body.model !== o.model) return err(404, "not_found_error", `model: ${String(body.model).slice(0, 40)}`);
      if (!Number.isInteger(body.max_tokens) || (body.max_tokens as number) < 1) return invalid("max_tokens required");
      if ("max_completion_tokens" in body) return invalid("max_completion_tokens: Extra inputs are not permitted");
      if (body.system !== undefined && typeof body.system !== "string") return invalid("system must be a string here");
      if (body.thinking !== undefined) {
        const t = body.thinking as Record<string, unknown>;
        const okAdaptive = t.type === "adaptive";
        const okEnabled = t.type === "enabled" && Number.isInteger(t.budget_tokens) && (t.budget_tokens as number) >= 1024 && (t.budget_tokens as number) < (body.max_tokens as number);
        if (!okAdaptive && !okEnabled) return invalid("invalid thinking configuration");
      }
      const tools = (body.tools as Array<Record<string, unknown>> | undefined) ?? [];
      if (!tools.every((t) => typeof t.name === "string" && t.input_schema && typeof t.input_schema === "object")) return invalid("tools need name and input_schema");
      const msgs = body.messages as Array<{ role: string; content: string | Block[] }>;
      if (!Array.isArray(msgs) || msgs.length === 0) return invalid("messages required");
      if (msgs[0].role !== "user") return invalid("first message must use the user role");
      for (let i = 1; i < msgs.length; i++) if (msgs[i].role === msgs[i - 1].role) return invalid("roles must alternate between user and assistant");
      const blocks = (m: { content: string | Block[] }): Block[] => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content);
      for (let i = 0; i < msgs.length; i++) {
        const b = blocks(msgs[i]);
        if (msgs[i].role === "user") {
          const firstNonResult = b.findIndex((x) => x.type !== "tool_result");
          if (firstNonResult >= 0 && b.slice(firstNonResult).some((x) => x.type === "tool_result")) return invalid("tool_result blocks must come first in the user turn");
          const prevUses = i > 0 ? blocks(msgs[i - 1]).filter((x) => x.type === "tool_use").map((x) => String(x.id)) : [];
          const results = b.filter((x) => x.type === "tool_result").map((x) => String(x.tool_use_id));
          if (JSON.stringify([...results].sort()) !== JSON.stringify([...prevUses].sort())) return invalid("each tool_use must be answered by exactly one tool_result in the next user turn");
        }
      }
      // Signed thinking of the latest assistant turn must come back unchanged and before its tool_use blocks.
      const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
      if (lastAssistant) {
        const b = blocks(lastAssistant);
        const uses = b.filter((x) => x.type === "tool_use").map((x) => String(x.id));
        for (const id of uses) {
          const want = issued.get(id);
          if (!want) continue;
          const got = JSON.stringify(b.slice(0, b.findIndex((x) => x.type === "tool_use")).filter((x) => x.type === "thinking" || x.type === "redacted_thinking"));
          if (got !== want) return invalid("thinking or redacted_thinking blocks in the latest assistant message cannot be modified");
        }
      }
      const fault = o.fault?.(agent, n) ?? null;
      if (fault?.kind === "status") return send(fault.status, { type: "error", error: { type: fault.status === 429 ? "rate_limit_error" : fault.status === 529 ? "overloaded_error" : "api_error", message: "injected" } }, fault.retryAfter ? { "retry-after": fault.retryAfter } : {});
      if (fault?.kind === "error_body") return err(fault.status, fault.type, fault.message ?? "injected");
      if (fault?.kind === "redirect") return send(307, "", { location: "http://127.0.0.1:9/elsewhere" });
      if (fault?.kind === "malformed_json") return send(200, "{ this is not json");
      if (fault?.kind === "hang") {
        await new Promise((r) => setTimeout(r, fault.ms));
        return send(200, { id: "msg_late", type: "message", role: "assistant", model: o.model, content: [{ type: "text", text: "too late" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
      }
      // The scripted model decides from the fleet-shaped conversation.
      const conv: ChatMessage[] = [];
      for (const m of msgs) {
        const b = blocks(m);
        if (m.role === "user") {
          for (const x of b.filter((y) => y.type === "tool_result")) conv.push({ role: "tool", toolCallId: String(x.tool_use_id), content: typeof x.content === "string" ? x.content : JSON.stringify(x.content ?? "") });
          const text = b.filter((y) => y.type === "text").map((y) => String(y.text)).join("\n");
          if (text) conv.push({ role: "user", content: text });
        } else {
          const calls = b.filter((y) => y.type === "tool_use").map((y) => ({ id: String(y.id), name: String(y.name), arguments: y.input as Record<string, unknown> }));
          conv.push({ role: "assistant", content: b.filter((y) => y.type === "text").map((y) => String(y.text)).join("\n"), ...(calls.length ? { toolCalls: calls } : {}) });
        }
      }
      const specs = tools.map((t) => ({ name: String(t.name), description: String(t.description ?? ""), parameters: t.input_schema, capability: "planning" })) as ToolSpec[];
      const last = conv[conv.length - 1];
      let text = "";
      let calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
      let usage: Record<string, number> = { input_tokens: Math.ceil(raw.length / 4), output_tokens: 12 };
      if (specs.some((t) => t.name === "probe_echo")) {
        if (last?.role === "tool") text = `echo: ${last.content}`; // native tool-result continuation
        else calls = [{ id: `toolu_probe${n}`, name: "probe_echo", arguments: { value: /value "([^"]{1,64})"/.exec(last?.content ?? "")?.[1] ?? "" } }];
      } else if (specs.length === 0) {
        text = "FLEET-PROBE-OK";
      } else {
        const r = await script.chat({ agentId: agent, system: String(body.system ?? ""), messages: conv, tools: specs, maxTokens: body.max_tokens as number });
        text = r.content;
        calls = r.toolCalls.map((c, i) => ({ ...c, id: `toolu_${agent.slice(-6)}${n}x${i}` }));
        usage = { input_tokens: r.usage.inputTokens, output_tokens: r.usage.outputTokens };
      }
      if (fault?.kind === "too_many_calls") calls = Array.from({ length: 11 }, (_, i) => ({ id: `toolu_many${n}x${i}`, name: "list_goals", arguments: {} }));
      const content: Block[] = [];
      let thinking: Block[] = [];
      if (o.thinking) {
        thinking = [
          { type: "thinking", thinking: `Considering step ${n} for ${agent.slice(-6)}.`, signature: Buffer.from(`sig:${agent}:${n}`).toString("base64") },
          { type: "redacted_thinking", data: Buffer.from(`redacted:${n}`).toString("base64") },
        ];
        content.push(...thinking);
      }
      if (text) content.push({ type: "text", text });
      for (const c of calls) content.push({ type: "tool_use", id: c.id, name: c.name, input: fault?.kind === "bad_tool_args" ? "not an object" : c.arguments });
      if (fault?.kind === "unknown_block") content.push({ type: "server_tool_use", id: "srvtoolu_x", name: "web_search", input: {} });
      if (o.thinking) for (const c of calls) issued.set(c.id, JSON.stringify(thinking));
      if (fault?.kind === "cache_usage") usage = { ...usage, cache_read_input_tokens: fault.read, cache_creation_input_tokens: fault.write };
      const stop = fault?.kind === "max_tokens_tool" ? "max_tokens" : calls.length ? "tool_use" : "end_turn";
      const u = fault?.kind === "no_usage" ? undefined : fault?.kind === "partial_usage" ? { input_tokens: usage.input_tokens } : usage;
      send(200, { id: `msg_fake${n}${agent.slice(-4)}`, type: "message", role: "assistant", model: o.model, content, stop_reason: stop, stop_sequence: null, ...(u ? { usage: u } : {}) });
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    violations,
    get lastBody() {
      return state.lastBody;
    },
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

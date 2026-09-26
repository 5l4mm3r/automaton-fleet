/**
 * A loopback OpenAI-compatible Chat Completions server for tests, the provider
 * probe's self-test and the real-runtime rehearsal. It lets the REAL
 * OpenAICompatibleProvider (HTTP, retries, timeouts, parsing) run against a
 * deterministic model (ScriptedProvider) with injected provider faults. It holds
 * a fake key only; it is never a production provider.
 */

import http from "http";
import net from "net";
import { ScriptedProvider } from "./providers.js";
import type { ChatMessage, ToolSpec } from "./types.js";

export type FakeFault =
  | { kind: "status"; status: number; retryAfter?: string }
  | { kind: "malformed_json" }
  | { kind: "bad_tool_args" }
  | { kind: "no_usage" }
  | { kind: "hang"; ms: number }
  | { kind: "redirect" };

export const REHEARSAL_AGENT_HEADER = "x-fleet-rehearsal-founder";

export interface FakeOpenAI {
  url: string;
  /** Requests received per agent tag (every attempt, including retries). */
  requests: Map<string, number>;
  /** Body fields seen on the last request (e.g. which output-limit field was sent). */
  lastBodyKeys: string[];
  close(): Promise<void>;
}

export async function startFakeOpenAI(o: {
  apiKey: string;
  model: string;
  acceptParam?: "max_tokens" | "max_completion_tokens" | "either";
  fault?: (agent: string, n: number) => FakeFault | null;
  script?: ScriptedProvider;
}): Promise<FakeOpenAI> {
  const script = o.script ?? new ScriptedProvider(o.model);
  const requests = new Map<string, number>();
  const state = { lastBodyKeys: [] as string[] };
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", async () => {
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(status, { "content-type": "application/json", ...headers }).end(typeof body === "string" ? body : JSON.stringify(body));
      };
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") return send(404, { error: { message: "not found" } });
      if (req.headers.authorization !== `Bearer ${o.apiKey}`) return send(401, { error: { code: "invalid_api_key", message: "Incorrect API key provided" } });
      const agent = String(req.headers[REHEARSAL_AGENT_HEADER] ?? "probe");
      const n = (requests.get(agent) ?? 0) + 1;
      requests.set(agent, n);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(400, { error: { message: "invalid json" } });
      }
      state.lastBodyKeys = Object.keys(body);
      if (body.model !== o.model) return send(404, { error: { code: "model_not_found", message: "The model does not exist" } });
      const accept = o.acceptParam ?? "either";
      const param = "max_completion_tokens" in body ? "max_completion_tokens" : "max_tokens" in body ? "max_tokens" : null;
      if (!param || (accept !== "either" && param !== accept)) return send(400, { error: { code: "unsupported_parameter", message: `Unsupported parameter: ${param}` } });
      const fault = o.fault?.(agent, n) ?? null;
      if (fault?.kind === "status") return send(fault.status, { error: { message: "injected" } }, fault.retryAfter ? { "retry-after": fault.retryAfter } : {});
      if (fault?.kind === "redirect") return send(307, "", { location: "http://127.0.0.1:9/elsewhere" });
      if (fault?.kind === "malformed_json") return send(200, "{ this is not json");
      if (fault?.kind === "hang") {
        await new Promise((r) => setTimeout(r, fault.ms));
        return send(200, { choices: [{ message: { content: "too late" } }] });
      }
      // Map the OpenAI conversation back to the fleet shape and let the scripted model decide.
      const msgs = (body.messages as Array<Record<string, unknown>>) ?? [];
      const system = String(msgs.find((m) => m.role === "system")?.content ?? "");
      const messages: ChatMessage[] = msgs.filter((m) => m.role !== "system").map((m) => {
        if (m.role === "tool") return { role: "tool", toolCallId: String(m.tool_call_id ?? ""), content: String(m.content ?? "") };
        const calls = Array.isArray(m.tool_calls)
          ? (m.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }>).map((t) => ({ id: t.id, name: t.function.name, arguments: JSON.parse(t.function.arguments || "{}") }))
          : undefined;
        return { role: m.role as "user" | "assistant", content: String(m.content ?? ""), ...(calls ? { toolCalls: calls } : {}) };
      });
      const tools = ((body.tools as Array<{ function: ToolSpec }>) ?? []).map((t) => t.function);
      const last = messages[messages.length - 1];
      let content = "";
      let toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
      let usage = { prompt_tokens: Math.ceil(raw.length / 4), completion_tokens: 12 };
      if (tools.some((t) => t.name === "probe_echo")) {
        // Probe tool-calling check: echo the requested value through the tool.
        const v = /value "([^"]{1,64})"/.exec(last?.content ?? "")?.[1] ?? "";
        toolCalls = [{ id: "call_probe", name: "probe_echo", arguments: { value: v } }];
      } else if (tools.length === 0) {
        content = "FLEET-PROBE-OK";
      } else {
        const r = await script.chat({ agentId: agent, system, messages, tools, maxTokens: Number(body[param]) || 1024 });
        content = r.content;
        toolCalls = r.toolCalls;
        usage = { prompt_tokens: r.usage.inputTokens, completion_tokens: r.usage.outputTokens };
      }
      const tc = toolCalls.map((t) => ({
        id: t.id, type: "function",
        function: { name: t.name, arguments: fault?.kind === "bad_tool_args" ? "{not json" : JSON.stringify(t.arguments) },
      }));
      if (fault?.kind === "bad_tool_args" && tc.length === 0) tc.push({ id: "c_bad", type: "function", function: { name: "sleep", arguments: "{not json" } });
      send(200, {
        id: `chatcmpl-${n}`, object: "chat.completion", model: `${o.model}-2026-01-01`,
        choices: [{ index: 0, finish_reason: tc.length ? "tool_calls" : "stop", message: { role: "assistant", content: content || null, ...(tc.length ? { tool_calls: tc } : {}) } }],
        ...(fault?.kind === "no_usage" ? {} : { usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } }),
      });
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
    get lastBodyKeys() {
      return state.lastBodyKeys;
    },
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

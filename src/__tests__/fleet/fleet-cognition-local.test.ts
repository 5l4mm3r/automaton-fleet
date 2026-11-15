/**
 * The LOCAL inference provider (owner directive 2026-10-23: a self-contained machine, no cloud fallback) against a scripted
 * loopback server: loopback only, no cloud credential, tool calls parsed (cosmetic argument faults repaired, others
 * reported as invalid calls), images sent as image parts after the tool results, the server's timings kept, an unavailable
 * server an explicit local failure (nothing else is tried), a slow one bounded by the deadline. And the controller loader:
 * local is the profile's provider; every routed tier is the one local model.
 */
import { describe, it, expect, afterEach } from "vitest";
import http from "http";
import { LocalProvider, checkLocalBaseUrl, parseLocalCompletion, repairArguments } from "../../fleet/cognition/local.js";
import { ProviderError, compactTools, compactToolSpec, fullToolSpec, TOOL_HELP_SPEC, FOUNDER_TOOLS } from "../../fleet/cognition/types.js";
import { loadCognitionProvider, localProviderFactory } from "../../fleet/service/main.js";

type Reply = (body: any) => { status?: number; json?: unknown; delayMs?: number };
let server: http.Server | null = null;
const bodies: any[] = [];
const headers: http.IncomingHttpHeaders[] = [];
async function serve(reply: Reply): Promise<string> {
  bodies.length = 0; headers.length = 0;
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", async () => {
      const body = JSON.parse(raw || "{}");
      bodies.push(body); headers.push(req.headers);
      const r = reply(body);
      if (r.delayMs) await new Promise((x) => setTimeout(x, r.delayMs));
      if (res.destroyed) return;
      res.writeHead(r.status ?? 200, { "content-type": "application/json" }).end(JSON.stringify(r.json ?? {}));
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server!.address() as { port: number }).port}/v1`;
}
afterEach(async () => { await new Promise<void>((r) => (server ? server.close(() => r()) : r())); server = null; });
const ok = (msg: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ json: { id: "chatcmpl-1", model: "qwen3.5-9b", choices: [{ message: msg, finish_reason: "tool_calls" }],
  usage: { prompt_tokens: 1200, completion_tokens: 40 }, timings: { prompt_n: 1200, prompt_ms: 900.5, predicted_n: 40, predicted_ms: 610.2 }, ...extra } });
const tool = { name: "write_file", capability: "workspace", description: "Write a file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } as any;

describe("local inference provider", () => {
  it("only a model server on this machine: any other host, or credentials in the URL, is refused", () => {
    for (const u of ["http://127.0.0.1:8090/v1", "http://localhost:8090/v1", "http://[::1]:8090/v1"]) expect(() => checkLocalBaseUrl(u)).not.toThrow();
    for (const u of ["https://api.anthropic.com/v1", "http://10.0.0.5:8090/v1", "http://192.168.1.20:11434/v1", "http://u:p@127.0.0.1:8090/v1", "file:///x"]) {
      expect(() => new LocalProvider({ baseUrl: u, model: "m" }), u).toThrow();
    }
  });

  it("a tool call round trip: tools and the conversation as OpenAI messages, no cloud key, the server's usage and timings kept", async () => {
    const url = await serve(() => ok({ content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: "{\"path\":\"notes/plan.md\"}" } }] }));
    const p = new LocalProvider({ baseUrl: url, model: "qwen3.5-9b" });
    const r = await p.chat({ agentId: "a", system: "sys", maxTokens: 500, tools: [tool], messages: [{ role: "user", content: "save it" }] });
    expect(r.toolCalls).toEqual([{ id: "c1", name: "write_file", arguments: { path: "notes/plan.md" } }]);
    expect(r.usage).toEqual({ inputTokens: 1200, outputTokens: 40 });
    expect(r.local).toEqual({ promptTokens: 1200, promptMs: 900.5, predictedTokens: 40, predictedMs: 610.2 });
    expect(bodies[0]).toMatchObject({ model: "qwen3.5-9b", max_tokens: 500, messages: [{ role: "system", content: "sys" }, { role: "user", content: "save it" }],
      tools: [{ type: "function", function: { name: "write_file" } }], chat_template_kwargs: { enable_thinking: false } });
    expect(headers[0].authorization).toBeUndefined();                                   // no key at all unless the owner set a LOCAL one
    expect(JSON.stringify(headers[0])).not.toMatch(/x-api-key|anthropic/i);
  });

  it("arguments: a cosmetic fault is repaired; anything else reaches the toolbox as an invalid call, never as empty arguments", () => {
    expect(repairArguments("```json\n{\"a\":1}\n```")).toEqual({ a: 1 });
    expect(repairArguments("{\"a\":1,}")).toEqual({ a: 1 });
    expect(repairArguments("{a: 1")).toBeNull();
    const p = parseLocalCompletion(JSON.stringify({ choices: [{ message: { tool_calls: [
      { id: "x", function: { name: "wallet", arguments: "{\"op\":\"view\",}" } },
      { id: "y", function: { name: "offer", arguments: "{op: publish" } },
      { id: "z", function: { name: "bad name!", arguments: "{}" } }] } }] }));
    expect("malformed" in p).toBe(false);
    const calls = (p as any).toolCalls;
    expect(calls).toEqual([{ id: "x", name: "wallet", arguments: { op: "view" } }, { id: "y", name: "offer", arguments: { _invalid_arguments: "{op: publish" } }]);
    expect("malformed" in parseLocalCompletion("not json")).toBe(true);
  });

  it("an image a tool returned goes to the model as an image part after the tool results", async () => {
    const url = await serve(() => ok({ content: "The point 7 line is present." }));
    const p = new LocalProvider({ baseUrl: url, model: "qwen3.5-9b" });
    await p.chat({ agentId: "a", system: "s", maxTokens: 100, tools: [], messages: [
      { role: "user", content: "look" },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "view_image", arguments: { path: "p.png" } }] },
      { role: "tool", toolCallId: "t1", content: "image p.png is shown to you below", images: [{ mediaType: "image/png", dataB64: "iVBORw0KGgo=" }] },
    ] as any });
    const m = bodies[0].messages;
    expect(m[2]).toEqual({ role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "view_image", arguments: "{\"path\":\"p.png\"}" } }] });
    expect(m[3]).toEqual({ role: "tool", tool_call_id: "t1", content: "image p.png is shown to you below" });
    expect(m[4].role).toBe("user");
    expect(m[4].content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } });
  });

  it("no server: an explicit local failure, uncharged — nothing else is tried; a slow server is bounded by the deadline", async () => {
    const p = new LocalProvider({ baseUrl: "http://127.0.0.1:9/v1", model: "m", maxAttempts: 1 });
    const e = await p.chat({ agentId: "a", system: "s", maxTokens: 10, tools: [], messages: [{ role: "user", content: "x" }] }).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e).toMatchObject({ code: "PROVIDER_UNREACHABLE", info: { charge: "none" } });
    const url = await serve(() => ({ delayMs: 3_000, ...ok({ content: "late" }) }));
    const slow = new LocalProvider({ baseUrl: url, model: "m", attemptTimeoutMs: 5_000 });
    const t0 = Date.now();
    const e2 = await slow.chat({ agentId: "a", system: "s", maxTokens: 10, tools: [], messages: [{ role: "user", content: "x" }], deadlineAt: Date.now() + 1_000 }).catch((x) => x);
    expect(e2).toMatchObject({ code: "PROVIDER_TIMEOUT" });
    expect(Date.now() - t0).toBeLessThan(2_500);
  });

  it("the controller: local is the profile's provider; no cloud key is needed; every routed tier is the one local model", () => {
    const cfg = loadCognitionProvider({ FLEET_COGNITION_PROVIDER: "local", FLEET_COGNITION_MODEL: "qwen3.5-9b" });
    expect(cfg.provider).toBeInstanceOf(LocalProvider);
    expect((cfg.provider as LocalProvider).model).toBe("qwen3.5-9b");
    expect(() => loadCognitionProvider({ FLEET_COGNITION_PROVIDER: "local", FLEET_COGNITION_MODEL: "m", FLEET_COGNITION_BASE_URL: "https://api.openai.com/v1" })).toThrow(/this machine/);
    expect(() => loadCognitionProvider({ FLEET_COGNITION_PROVIDER: "local" })).toThrow(/requires FLEET_COGNITION_MODEL/);
    const f = localProviderFactory(cfg.provider as LocalProvider);
    const a = f({ tier: "T3", provider: "anthropic", model: "claude-opus-5-5" } as any, "high", "prefix");
    expect(a.model).toBe("qwen3.5-9b");                                                  // whatever the tier says, it is the local model
    expect((a as any).promptCache).toBe("off");
  });
});

describe("the compact tool list a local model is sent", () => {
  it("keeps every tool and its full parameter schema, cuts descriptions, adds tool_help; the full spec stays retrievable", () => {
    const tools = FOUNDER_TOOLS.slice(0, 12);
    const c = compactTools(tools);
    expect(c.map((t) => t.name)).toEqual([...tools.map((t) => t.name), "tool_help"]);
    for (const [i, t] of tools.entries()) {
      expect(c[i].description.length).toBeLessThanOrEqual(260);
      expect(c[i].description).toMatch(/tool_help/);
      expect(JSON.stringify(c[i].parameters)).not.toMatch(/"description"/);
      // types, enums and required fields survive
      const strip = (v: any): any => (Array.isArray(v) ? v.map(strip) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "description").map(([k, x]) => [k, strip(x)])) : v);
      expect(c[i].parameters).toEqual(strip(t.parameters));
      expect(fullToolSpec(t.name)?.description).toBeTruthy();
    }
    expect(compactToolSpec(tools[0])).toEqual(compactToolSpec(tools[0]));                 // deterministic
    expect(c.at(-1)).toBe(TOOL_HELP_SPEC);
  });
});

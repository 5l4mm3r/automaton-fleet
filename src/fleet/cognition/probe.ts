/**
 * L14 — provider compatibility probe. Proves, before Genesis and without any
 * founder, that the configured provider/model works with the fleet's real
 * provider code:
 *
 *   P1 authentication + model access + a normal completion (configured output-limit field accepted)
 *   P2 tool calling with correctly parsed JSON arguments (probe-only tool)
 *   P3 the real founder toolbox schemas + charter are accepted (returned calls inspected, NEVER executed)
 *   P4 usage/token accounting returned (absent → WARN: the gateway would charge the estimate)
 *   P5 error handling: an unknown model is a classified, uncharged error
 *   P6 timeout handling: an impossible deadline is a classified PROVIDER_TIMEOUT
 *   P7 latency within the configured attempt timeout
 *
 * Authority: none. The probe has no database connection (no ledger, no
 * founder, no Genesis), executes no tool call, and prints only classified
 * codes, HTTP statuses, token counts, validated tool/model names and timings —
 * never the credential, never provider response bodies or model text.
 */

import { decideTool, FOUNDER_MANIFEST_V1 } from "../capabilities.js";
import { OpenAICompatibleProvider, type OpenAICompatibleOptions } from "./providers.js";
import { FOUNDER_CHARTER, FOUNDER_TOOLS, ProviderError, type ChatResult, type ToolSpec } from "./types.js";

export interface ProbeCheck {
  id: string;
  name: string;
  status: "PASS" | "WARN" | "FAIL";
  detail: string;
}

export interface ProbeReport {
  pass: boolean;
  provider: "openai_compatible";
  model: string;
  maxTokensParam: string;
  checks: ProbeCheck[];
  usage: { inputTokens: number; outputTokens: number; costMicrocents: number | null };
  authority: string;
}

const PROBE_TOOL: ToolSpec = {
  name: "probe_echo",
  capability: "planning",
  description: "Connectivity probe: echo the given value.",
  parameters: { type: "object", properties: { value: { type: "string", maxLength: 64 } }, required: ["value"], additionalProperties: false },
};

const describe = (err: unknown): string =>
  err instanceof ProviderError ? `${err.code}${err.info.status ? ` (HTTP ${err.info.status})` : ""}, ${err.info.attempts} attempt(s), charge ${err.info.charge}` : "unexpected error";

export async function runProviderProbe(
  o: Omit<OpenAICompatibleOptions, "extraHeaders" | "sleep"> & { prices?: { inputMicrocentsPerToken: number; outputMicrocentsPerToken: number } },
): Promise<ProbeReport> {
  const checks: ProbeCheck[] = [];
  const add = (id: string, name: string, status: ProbeCheck["status"], detail: string) => checks.push({ id, name, status, detail });
  const provider = new OpenAICompatibleProvider({ ...o, maxAttempts: Math.min(o.maxAttempts ?? 2, 2) });
  const timeout = Math.min(240_000, Math.max(5_000, o.attemptTimeoutMs ?? 90_000));
  // Reasoning models spend hidden tokens: give them room when they use max_completion_tokens.
  const maxTokens = provider.maxTokensParam === "max_completion_tokens" ? 2_048 : 256;
  const usage = { inputTokens: 0, outputTokens: 0, reported: 0, calls: 0 };
  const latencies: number[] = [];
  const call = async (system: string, user: string, tools: ToolSpec[]): Promise<ChatResult> => {
    const t0 = Date.now();
    const r = await provider.chat({ agentId: "probe", system, messages: [{ role: "user", content: user }], tools, maxTokens, deadlineAt: Date.now() + timeout });
    latencies.push(Date.now() - t0);
    usage.calls++;
    if (r.usageSource === "provider") {
      usage.reported++;
      usage.inputTokens += r.usage.inputTokens;
      usage.outputTokens += r.usage.outputTokens;
    }
    return r;
  };

  // P1 — authentication, model access, plain completion with the configured output-limit field.
  let p1ok = false;
  try {
    const r = await call("You are a connectivity probe. Answer with the exact text requested and nothing else.", "Reply with exactly: FLEET-PROBE-OK", []);
    p1ok = true;
    add("P1", "authentication, model access, completion", "PASS",
      `answered${r.content.includes("FLEET-PROBE-OK") ? " with the exact marker" : " (marker not reproduced exactly)"}; ${provider.maxTokensParam} accepted; model reported ${r.responseModel ?? "(none)"}`);
  } catch (err) {
    const hint = err instanceof ProviderError && err.code === "PROVIDER_BAD_REQUEST"
      ? `; if the model requires it, set FLEET_COGNITION_MAX_TOKENS_PARAM=${provider.maxTokensParam === "max_tokens" ? "max_completion_tokens" : "max_tokens"}`
      : err instanceof ProviderError && err.code === "PROVIDER_AUTH_FAILED" ? "; check the key and its project/permissions"
        : err instanceof ProviderError && err.code === "PROVIDER_MODEL_NOT_FOUND" ? "; check the model id and that this key may use it" : "";
    add("P1", "authentication, model access, completion", "FAIL", describe(err) + hint);
  }

  // P2 — tool calling with parsed arguments (a probe-only tool; nothing is executed).
  if (p1ok) {
    try {
      const r = await call("You are a connectivity probe. Use the tool as instructed.", 'Call the probe_echo tool with value "fleet-probe-42". Do not answer in text.', [PROBE_TOOL]);
      const c = r.toolCalls.find((t) => t.name === "probe_echo");
      add("P2", "tool calling with parsed arguments", c && c.arguments.value === "fleet-probe-42" ? "PASS" : "FAIL",
        c ? `probe_echo called; arguments parsed; value ${c.arguments.value === "fleet-probe-42" ? "correct" : "WRONG"}` : `no probe_echo call (${r.toolCalls.length} other call(s))`);
    } catch (err) {
      add("P2", "tool calling with parsed arguments", "FAIL", describe(err));
    }
    // P3 — the real founder toolbox and charter are accepted; returned calls are only inspected.
    try {
      const r = await call(FOUNDER_CHARTER, "Probe turn: check your goals, then sleep.", [...FOUNDER_TOOLS]);
      const names = r.toolCalls.map((t) => t.name);
      const verdicts = names.map((n) => `${n}:${decideTool(n, FOUNDER_MANIFEST_V1).allowed ? "allowed" : "refused"}`);
      add("P3", "founder toolbox schemas and charter accepted", "PASS",
        `${FOUNDER_TOOLS.length} tool schemas accepted; model requested [${verdicts.join(", ") || "none"}] — inspected, not executed`);
    } catch (err) {
      add("P3", "founder toolbox schemas and charter accepted", "FAIL", describe(err));
    }
  } else {
    add("P2", "tool calling with parsed arguments", "FAIL", "skipped: P1 failed");
    add("P3", "founder toolbox schemas and charter accepted", "FAIL", "skipped: P1 failed");
  }

  // P4 — usage accounting.
  add("P4", "usage/token accounting", usage.calls === 0 ? "FAIL" : usage.reported === usage.calls ? "PASS" : "WARN",
    usage.calls === 0 ? "no successful call"
      : usage.reported === usage.calls ? `usage reported on ${usage.calls}/${usage.calls} calls (${usage.inputTokens} in, ${usage.outputTokens} out)`
        : `usage missing on ${usage.calls - usage.reported}/${usage.calls} calls: the gateway would charge the full authorized estimate for those`);

  // P5 — error handling: an unknown model is a classified, uncharged, non-crashing error.
  try {
    await new OpenAICompatibleProvider({ ...o, model: "fleet-probe-nonexistent-model", maxAttempts: 1 })
      .chat({ agentId: "probe", system: "probe", messages: [{ role: "user", content: "hi" }], tools: [], maxTokens: 16, deadlineAt: Date.now() + timeout });
    add("P5", "error handling (unknown model)", "WARN", "the provider accepted a nonexistent model id (it may alias unknown models)");
  } catch (err) {
    const ok = err instanceof ProviderError && err.info.charge === "none" && ["PROVIDER_MODEL_NOT_FOUND", "PROVIDER_BAD_REQUEST", "PROVIDER_HTTP_ERROR"].includes(err.code);
    add("P5", "error handling (unknown model)", ok ? "PASS" : "FAIL", describe(err));
  }

  // P6 — timeout handling: an impossible per-attempt timeout is a classified PROVIDER_TIMEOUT.
  try {
    await new OpenAICompatibleProvider({ ...o, attemptTimeoutMs: 1, maxAttempts: 1 })
      .chat({ agentId: "probe", system: "probe", messages: [{ role: "user", content: "hi" }], tools: [], maxTokens: 16, deadlineAt: Date.now() + 1 });
    add("P6", "timeout handling", "FAIL", "a 1 ms timeout did not fire");
  } catch (err) {
    add("P6", "timeout handling", err instanceof ProviderError && err.code === "PROVIDER_TIMEOUT" ? "PASS" : "FAIL", describe(err));
  }

  // P7 — latency against the configured attempt timeout.
  const worst = latencies.length ? Math.max(...latencies) : 0;
  add("P7", "latency within the attempt timeout", latencies.length === 0 ? "FAIL" : worst < timeout / 2 ? "PASS" : worst < timeout ? "WARN" : "FAIL",
    latencies.length ? `slowest call ${worst} ms (attempt timeout ${timeout} ms)` : "no successful call");

  const cost = o.prices ? usage.inputTokens * o.prices.inputMicrocentsPerToken + usage.outputTokens * o.prices.outputMicrocentsPerToken : null;
  return {
    pass: checks.every((c) => c.status !== "FAIL"),
    provider: "openai_compatible",
    model: o.model,
    maxTokensParam: provider.maxTokensParam,
    checks,
    usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costMicrocents: cost },
    authority: "none: no database connection, no founder, no Genesis; tool calls inspected, never executed; nothing charged to the fleet ledger",
  };
}

/**
 * `scripts/fleet-eval-02.sh` entry point. Runs on the controller host as the fleet service user (the only user that
 * can read the inference credential), with an environment holding ONLY the FLEET_COGNITION_* settings — no database
 * credential, no founder, no registry. Reads one JSON request on stdin; writes JSON lines on stdout:
 *   EVT {…}      progress (call_start / call_end / budget_stop), flushed as they happen (checkpointing);
 *   RESULT {…}   the final result.
 * Every line is scrubbed of the credential before it is written, and the key is never logged or returned.
 *
 * Requests:
 *   {"mode":"models","ids":[…]}                       GET /v1/models/{id}: availability and capabilities (free)
 *   {"mode":"cell","model":…,"effort":…,"request":{…}} one F1-EVAL-02 cell (paid, budget-guarded)
 * The model must be one of EVAL_MODELS; each provider call is attempted once (no automatic retries).
 * Exit 0 = ran (the result says what happened), 2 = refused.
 */

import { loadCognitionProvider, readCognitionKey } from "../service/main.js";
import { AnthropicProvider, type AnthropicEffort } from "../cognition/anthropic.js";
import { runCell, type CellRequest } from "./f1-eval-02.js";

export const EVAL_MODELS: readonly string[] = ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5"];
const EFFORTS: readonly string[] = ["low", "medium", "high", "max"];
const MAX_STDIN = 4 * 1024 * 1024;
let scrubKey = "";
const scrub = (s: string) => (scrubKey ? s.split(scrubKey).join("[REDACTED]") : s);

async function readStdin(): Promise<string> {
  let s = "";
  for await (const chunk of process.stdin) {
    s += chunk;
    if (s.length > MAX_STDIN) throw new Error("request too large");
  }
  return s;
}

async function main(): Promise<number> {
  const e = process.env;
  if (Object.keys(e).some((k) => /DATABASE_URL$/.test(k))) {
    console.error("Refusing: the evaluation must run without any database credential.");
    return 2;
  }
  if (e.FLEET_COGNITION_PROVIDER?.trim() !== "anthropic") {
    console.error("Refusing: F1-EVAL-02 runs on the anthropic provider only.");
    return 2;
  }
  let base: AnthropicProvider;
  let apiKey = "";
  try {
    const cfg = loadCognitionProvider(e);
    apiKey = readCognitionKey(e.FLEET_COGNITION_API_KEY_FILE!.trim());
    scrubKey = apiKey;
    if (!(cfg.provider instanceof AnthropicProvider)) throw new Error("not the anthropic provider");
    base = cfg.provider;
  } catch (err) {
    console.error(`Refusing: ${err instanceof Error ? err.message : "invalid configuration"}`);
    return 2;
  }
  const out = (tag: string, v: unknown) => {
    process.stdout.write(`${scrub(`${tag} ${JSON.stringify(v)}`)}\n`);
  };
  let req: Record<string, unknown>;
  try {
    req = JSON.parse(await readStdin());
  } catch {
    console.error("Refusing: stdin must be one JSON request.");
    return 2;
  }

  if (req.mode === "models") {
    const ids = Array.isArray(req.ids) ? (req.ids as unknown[]).filter((x): x is string => typeof x === "string" && EVAL_MODELS.includes(x)) : [];
    const baseUrl = (e.FLEET_COGNITION_BASE_URL?.trim() || "https://api.anthropic.com/v1").replace(/\/$/, "");
    const models = [];
    for (const id of ids) {
      try {
        const r = await fetch(`${baseUrl}/models/${encodeURIComponent(id)}`, { headers: { "x-api-key": apiKey, "anthropic-version": e.FLEET_COGNITION_ANTHROPIC_VERSION?.trim() || "2023-06-01" }, redirect: "error", signal: AbortSignal.timeout(20_000) });
        const body = (await r.text()).slice(0, 20_000);
        let j: Record<string, unknown> = {};
        try { j = JSON.parse(body); } catch { /* not json */ }
        models.push(r.ok
          ? { id, status: r.status, model: j.id ?? null, displayName: j.display_name ?? null, createdAt: j.created_at ?? null, maxInputTokens: j.max_input_tokens ?? null, maxTokens: j.max_tokens ?? null, capabilities: j.capabilities ?? null }
          : { id, status: r.status, errorType: (j.error as { type?: string } | undefined)?.type ?? null });
      } catch (err) {
        models.push({ id, error: (err as Error).name });
      }
    }
    out("RESULT", { mode: "models", configured: { model: base.model, ...base.settings }, models });
    return 0;
  }

  if (req.mode !== "cell") {
    console.error("Refusing: unknown mode.");
    return 2;
  }
  const model = String(req.model ?? "");
  const effort = String(req.effort ?? "");
  const cell = req.request as CellRequest;
  if (!EVAL_MODELS.includes(model) || !EFFORTS.includes(effort) || !cell || typeof cell !== "object") {
    console.error("Refusing: model/effort/request invalid.");
    return 2;
  }
  if (!(Number.isSafeInteger(cell.budgetMicrocents) && cell.budgetMicrocents >= 0 && cell.budgetMicrocents <= 300_000_000)) {
    console.error("Refusing: the cell budget must be within the authorised $3.00 ceiling.");
    return 2;
  }
  // Evaluation-only settings on a copy: the controller's own configuration is untouched. One attempt per call.
  const provider = base.with({ model, effort: effort as AnthropicEffort, thinking: { type: "adaptive" }, maxAttempts: 1 });
  const result = await runCell(cell, provider, { log: (x) => out("EVT", x) });
  out("RESULT", { mode: "cell", model, effort, thinking: "adaptive", maxAttempts: 1, result });
  return 0;
}

main().then((c) => process.exit(c), (err) => { console.error(scrub(`FAILED: ${(err as Error).name}: ${String((err as Error).message).slice(0, 300)}`)); process.exit(2); });

/**
 * `scripts/fleet-routing-verify.sh` entry point: runs from the INSTALLED release as the fleet service user, with only
 * the FLEET_COGNITION_* settings (no database credential). One JSON request on stdin; output lines are scrubbed of
 * the credential. Requests:
 *   {"mode":"models"}                          GET /v1/models/{id} for the three seeded tier mappings (free)
 *   {"mode":"verify","budgetMicrocents":N}     the routed real-API verification (N ≤ 25,000,000 µ¢ = $0.25)
 * Exit 0 = ran (the result says what happened), 2 = refused.
 */

import { loadCognitionProvider, readCognitionKey, routedProviderFactory } from "../service/main.js";
import { AnthropicProvider } from "../cognition/anthropic.js";
import { VERIFY_MAX_BUDGET_MICROCENTS, VERIFY_TIERS, observingFetch, runRoutingVerification, type ObservedRequest } from "./routing-verify.js";

let scrubKey = "";
const scrub = (s: string) => (scrubKey ? s.split(scrubKey).join("[REDACTED]") : s);
const out = (tag: string, v: unknown) => process.stdout.write(`${scrub(`${tag} ${JSON.stringify(v)}`)}\n`);

async function main(): Promise<number> {
  const e = process.env;
  if (Object.keys(e).some((k) => /DATABASE_URL$/.test(k))) { console.error("Refusing: no database credential may be present."); return 2; }
  let base: AnthropicProvider;
  let apiKey: string;
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
  let req: Record<string, unknown>;
  try {
    let s = "";
    for await (const chunk of process.stdin) { s += chunk; if (s.length > 65_536) throw new Error("too large"); }
    req = JSON.parse(s);
  } catch {
    console.error("Refusing: stdin must be one JSON request.");
    return 2;
  }
  if (req.mode === "models") {
    const baseUrl = (e.FLEET_COGNITION_BASE_URL?.trim() || "https://api.anthropic.com/v1").replace(/\/$/, "");
    const models = [];
    for (const t of VERIFY_TIERS) {
      const at = new Date().toISOString();
      try {
        const r = await fetch(`${baseUrl}/models/${encodeURIComponent(t.model)}`, { headers: { "x-api-key": apiKey, "anthropic-version": e.FLEET_COGNITION_ANTHROPIC_VERSION?.trim() || "2023-06-01" }, redirect: "error", signal: AbortSignal.timeout(20_000) });
        const body = (await r.text()).slice(0, 20_000);
        let j: Record<string, unknown> = {};
        try { j = JSON.parse(body); } catch { /* not JSON */ }
        models.push(r.ok
          ? { tier: t.tier, id: t.model, at, status: r.status, providerRequestId: r.headers.get("request-id"), model: j.id ?? null, displayName: j.display_name ?? null, createdAt: j.created_at ?? null,
              maxInputTokens: j.max_input_tokens ?? null, maxTokens: j.max_tokens ?? null, capabilities: j.capabilities ?? null }
          : { tier: t.tier, id: t.model, at, status: r.status, providerRequestId: r.headers.get("request-id"), errorType: (j.error as { type?: string } | undefined)?.type ?? null });
      } catch (err) {
        models.push({ tier: t.tier, id: t.model, at, error: (err as Error).name });
      }
    }
    out("RESULT", { mode: "models", models });
    return 0;
  }
  if (req.mode !== "verify") { console.error("Refusing: unknown mode."); return 2; }
  const budget = Number(req.budgetMicrocents);
  if (!Number.isSafeInteger(budget) || budget <= 0 || budget > VERIFY_MAX_BUDGET_MICROCENTS) { console.error("Refusing: budget must be within the authorised $0.25."); return 2; }
  const sink: ObservedRequest[] = [];
  let spent = 0;
  // The deployed factory, on a provider whose HTTP layer is observed and budget-guarded; one attempt per call.
  // Prompt caching is exercised here as a verification-only override: the controller's own setting is untouched (off).
  const guarded = base.with({ maxAttempts: 1, promptCache: "prefix", fetchImpl: observingFetch({ tiers: VERIFY_TIERS, budgetMicrocents: budget, spent: () => spent, sink }) });
  const factory = routedProviderFactory(guarded);
  const r = await runRoutingVerification({ factory, tiers: VERIFY_TIERS, budgetMicrocents: budget, sink, log: (c) => { spent += c.costMicrocents; out("EVT", c); } });
  out("RESULT", { mode: "verify", promptCache: guarded.settings.promptCache, controllerPromptCache: base.settings.promptCache, ...r });
  return 0;
}

main().then((c) => process.exit(c), (err) => { console.error(scrub(`FAILED: ${(err as Error).name}: ${String((err as Error).message).slice(0, 300)}`)); process.exit(2); });

/**
 * `scripts/fleet-cognition-probe.sh` entry point (L14). Runs as the fleet
 * service user so it can read the controller's inference credential, with an
 * environment that holds ONLY the FLEET_COGNITION_* settings (no database URL).
 * Exit 0 = PASS, 1 = FAIL, 2 = not configured / refused.
 */

import { readCognitionKey } from "../service/main.js";
import { runProviderProbe } from "./probe.js";

async function main(): Promise<number> {
  const e = process.env;
  if (Object.keys(e).some((k) => /DATABASE_URL$/.test(k))) {
    console.error("Refusing: the probe must run without any database credential.");
    return 2;
  }
  const provider = e.FLEET_COGNITION_PROVIDER?.trim() || "none";
  if (provider !== "openai_compatible") {
    console.error(`Nothing to probe: FLEET_COGNITION_PROVIDER is ${provider} (install the provider credential and configuration first).`);
    return 2;
  }
  const baseUrl = e.FLEET_COGNITION_BASE_URL?.trim() ?? "";
  const model = e.FLEET_COGNITION_MODEL?.trim() ?? "";
  const keyFile = e.FLEET_COGNITION_API_KEY_FILE?.trim() ?? "";
  const param = e.FLEET_COGNITION_MAX_TOKENS_PARAM?.trim() || "max_tokens";
  if (!baseUrl || !model || !keyFile || (param !== "max_tokens" && param !== "max_completion_tokens")) {
    console.error("Refusing: FLEET_COGNITION_BASE_URL, FLEET_COGNITION_MODEL, FLEET_COGNITION_API_KEY_FILE required; FLEET_COGNITION_MAX_TOKENS_PARAM must be max_tokens or max_completion_tokens.");
    return 2;
  }
  let apiKey: string;
  try {
    apiKey = readCognitionKey(keyFile);
  } catch (err) {
    console.error(err instanceof Error ? err.message : "Refusing the inference credential.");
    return 2;
  }
  const prices = /^\d{1,9},\d{1,9}$/.test(e.FLEET_PROBE_PRICES ?? "")
    ? { inputMicrocentsPerToken: Number(e.FLEET_PROBE_PRICES!.split(",")[0]), outputMicrocentsPerToken: Number(e.FLEET_PROBE_PRICES!.split(",")[1]) }
    : undefined;
  const attempt = Number(e.FLEET_COGNITION_ATTEMPT_TIMEOUT_MS) || 90_000;
  let report;
  try {
    report = await runProviderProbe({ baseUrl, apiKey, model, maxTokensParam: param, attemptTimeoutMs: attempt, prices });
  } catch (err) {
    // Constructor validation (URL, model id); never echo provider data.
    console.error(`Refusing: ${err instanceof Error ? err.message : "invalid configuration"}`);
    return 2;
  }
  // Belt and braces: the report is built from classified values only, but never let the key through.
  const out = JSON.stringify(report, null, 2).split(apiKey).join("[REDACTED]");
  console.log(out);
  console.log(`\nL14 PROVIDER PROBE: ${report.pass ? "PASS" : "FAIL"}`);
  return report.pass ? 0 : 1;
}

main().then((c) => process.exit(c), () => process.exit(2));

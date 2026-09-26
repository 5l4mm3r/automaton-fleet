/**
 * `scripts/fleet-cognition-probe.sh` entry point (L14). Runs as the fleet
 * service user so it can read the controller's inference credential, with an
 * environment that holds ONLY the FLEET_COGNITION_* settings (no database URL).
 * Exit 0 = PASS, 1 = FAIL, 2 = not configured / refused.
 */

import { loadCognitionProvider, readCognitionKey } from "../service/main.js";
import { runProviderProbe, type ProbeableProvider } from "./probe.js";
import { runContextRepro } from "./context-repro.js";

async function main(): Promise<number> {
  const e = process.env;
  if (Object.keys(e).some((k) => /DATABASE_URL$/.test(k))) {
    console.error("Refusing: the probe must run without any database credential.");
    return 2;
  }
  const provider = e.FLEET_COGNITION_PROVIDER?.trim() || "none";
  if (provider !== "openai_compatible" && provider !== "anthropic") {
    console.error(`Nothing to probe: FLEET_COGNITION_PROVIDER is ${provider} (install the provider credential and configuration first).`);
    return 2;
  }
  let cfg;
  let apiKey = "";
  try {
    // The same loader and checks the controller uses (key file: path, type, mode, owner, format).
    cfg = loadCognitionProvider(e);
    apiKey = readCognitionKey(e.FLEET_COGNITION_API_KEY_FILE!.trim());
  } catch (err) {
    console.error(`Refusing: ${err instanceof Error ? err.message : "invalid configuration"}`);
    return 2;
  }
  const prices = /^\d{1,9},\d{1,9}(,\d{1,9},\d{1,9})?$/.test(e.FLEET_PROBE_PRICES ?? "")
    ? (() => {
        const [i, o, cw, cr] = e.FLEET_PROBE_PRICES!.split(",").map(Number);
        return { inputMicrocentsPerToken: i, outputMicrocentsPerToken: o, cacheWriteMicrocentsPerToken: cw ?? null, cacheReadMicrocentsPerToken: cr ?? null };
      })()
    : undefined;
  if (e.FLEET_PROBE_MODE === "context-repro") {
    // Post-Genesis diagnosis: the real mind/toolbox/provider protocol in isolation; structure-only output.
    const turns = Math.min(8, Math.max(1, Number(e.FLEET_REPRO_TURNS) || 4));
    if (!cfg.provider) { console.error("Refusing: no provider configured."); return 2; }
    const calls = await runContextRepro({ provider: cfg.provider, turns, log: (c) => console.log(JSON.stringify(c).split(apiKey).join("[REDACTED]")) });
    const inTok = calls.reduce((n, c) => n + (c.inputTokens ?? 0), 0);
    const outTok = calls.reduce((n, c) => n + (c.outputTokens ?? 0), 0);
    const costMicro = prices ? inTok * prices.inputMicrocentsPerToken + outTok * prices.outputMicrocentsPerToken : null;
    const rejected = calls.filter((c) => !c.ok);
    console.log(JSON.stringify({ calls: calls.length, rejected: rejected.length, inputTokens: inTok, outputTokens: outTok, costUsdMicrocents: costMicro }));
    return rejected.length ? 1 : 0;
  }
  const report = await runProviderProbe(cfg.provider as ProbeableProvider, { attemptTimeoutMs: Number(e.FLEET_COGNITION_ATTEMPT_TIMEOUT_MS) || 90_000, prices });
  // Belt and braces: the report is built from classified values only, but never let the key through.
  const out = JSON.stringify(report, null, 2).split(apiKey).join("[REDACTED]");
  console.log(out);
  console.log(`\nL14 PROVIDER PROBE (${report.provider}): ${report.pass ? "PASS" : "FAIL"}`);
  return report.pass ? 0 : 1;
}

main().then((c) => process.exit(c), () => process.exit(2));

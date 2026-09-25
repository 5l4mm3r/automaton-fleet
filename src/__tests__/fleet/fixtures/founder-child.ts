/**
 * Test-only founder runtime entry: the production runtime with ONE preflight
 * input replaced — the list of secret paths that must be unreadable is
 * FLEET_TEST_UNREADABLE (comma-separated), because the development user can
 * legitimately read its own admin.env. Everything else (identity, manifest,
 * release pins, state ownership, capability self-test, controller protocol)
 * is the production code path. Never shipped: tests only.
 */

import { runFounderRuntime } from "../../../fleet/founder/runtime.js";

const ac = new AbortController();
process.on("SIGTERM", () => ac.abort());
const unreadable = (process.env.FLEET_TEST_UNREADABLE ?? "").split(",").filter(Boolean);
const log = (event: string, detail: Record<string, unknown> = {}) => process.stdout.write(JSON.stringify({ event, ...detail }) + "\n");

runFounderRuntime({ log, signal: ac.signal, unreadable }).then(
  () => process.exit(0),
  (err) => {
    log("founder_failed", { error: err instanceof Error ? err.message : String(err) });
    process.exit(typeof err?.exitCode === "number" ? err.exitCode : 1);
  },
);

/**
 * DRY_RUN_CHILD entrypoint, started inside the child sandbox by the operator
 * dry run (`node dist/fleet/dry-run/child-main.js`). Heartbeats until the
 * controller stops accepting it. Logs JSON lines without secrets.
 */

import { runDryRunChild } from "./child.js";

const log = (event: string, detail: Record<string, unknown> = {}) =>
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), service: "fleet-dry-run-child", event, ...detail }) + "\n");

const ac = new AbortController();
process.on("SIGTERM", () => ac.abort());
process.on("SIGINT", () => ac.abort());

runDryRunChild({ log, signal: ac.signal, intervalMs: Number(process.env.FLEET_DRY_RUN_INTERVAL_MS) || 30_000 }).then(
  (r) => {
    log("dry_run_child_stopped", { heartbeats: r.heartbeats, challengesPassed: r.challengesPassed, status: r.status });
    process.exit(0);
  },
  (err) => {
    log("dry_run_child_failed", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  },
);

/**
 * Root witness entrypoint (FLEET-KI-4): `node dist/fleet/dry-run/root-main.js`,
 * run by deploy/systemd/automaton-fleet-witness.service. Logs JSON lines
 * without credentials or session tokens.
 *
 * Exit codes: 0 stopped (SIGTERM/SIGINT); 3 the controller no longer accepts
 * this witness; 4 startup refusal; 1 anything else. The unit sets
 * RestartPreventExitStatus=3 4 so a retired or misconfigured witness is not restarted.
 */

import { runRootWitness } from "./root-witness.js";

const log = (event: string, detail: Record<string, unknown> = {}) =>
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), service: "fleet-root-witness", event, ...detail }) + "\n");

const ac = new AbortController();
process.on("SIGTERM", () => ac.abort());
process.on("SIGINT", () => ac.abort());

const requested = Number(process.env.FLEET_WITNESS_INTERVAL_MS);
const intervalMs = Math.min(60_000, Math.max(10_000, Number.isFinite(requested) && requested > 0 ? requested : 30_000));

runRootWitness({ log, signal: ac.signal, intervalMs }).then(
  (r) => {
    log("witness_stopped", { agentId: r.agentId, heartbeats: r.heartbeats, challengesPassed: r.challengesPassed, status: r.status });
    process.exit(0);
  },
  (err) => {
    const exitCode = typeof (err as { exitCode?: unknown })?.exitCode === "number" ? (err as { exitCode: number }).exitCode : 1;
    log("witness_failed", { error: err instanceof Error ? err.message : String(err), exitCode });
    process.exit(exitCode);
  },
);

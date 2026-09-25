/**
 * Genesis founder runtime entrypoint: `node dist/fleet/founder/main.js`, run by
 * deploy/systemd/automaton-fleet-founder@.service (one instance per founder).
 * Logs JSON lines through the canonical redactor (never a token or session).
 * Exit codes: 0 stopped; 3 the controller refused this founder; 4 startup refusal.
 * The unit sets RestartPreventExitStatus=3 4.
 */

import { createRedactedLineLogger } from "../redact.js";
import { runFounderRuntime } from "./runtime.js";

const log = createRedactedLineLogger("fleet-founder");
const ac = new AbortController();
process.on("SIGTERM", () => ac.abort());
process.on("SIGINT", () => ac.abort());

runFounderRuntime({ log, signal: ac.signal }).then(
  (r) => {
    log("founder_stopped", { agentId: r.agentId, mode: r.mode, heartbeats: r.heartbeats });
    process.exit(0);
  },
  (err) => {
    const exitCode = typeof (err as { exitCode?: unknown })?.exitCode === "number" ? (err as { exitCode: number }).exitCode : 1;
    log("founder_failed", { error: err instanceof Error ? err.message : String(err), exitCode });
    process.exit(exitCode);
  },
);

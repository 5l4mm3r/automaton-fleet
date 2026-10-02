/**
 * Browser worker entrypoint (schema v37): `node dist/fleet/browser/main.js`, run as its own system user
 * (automaton-fleet-browser) from the pinned release. Environment:
 *
 *   FLEET_BROWSER_DATABASE_URL   the fleet_browser_login connection (bx_* only)
 *   FLEET_BROWSER_EXECUTABLE     the Chromium/Chrome binary (absolute path)
 *
 * Startup refuses (fail closed) when: running as root; any controller/admin/service/agent/operator/custody/identity
 * credential is visible; the executable is missing; the schema is not this release's. The worker holds no vault and no
 * secret at rest: credentials reach it one fill at a time, sealed to a key that lives only in this process's memory.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { createJsonLogger, type Logger } from "../service/log.js";
import { CUSTODY_FORBIDDEN_ENV } from "../secret-files.js";
import { FLEET_PG_SCHEMA_VERSION } from "../postgres/migrations.js";
import { redactText } from "../redact.js";
import { PgBrowserGateway } from "./gateway.js";
import { BrowserWorker } from "./worker.js";

const FORBIDDEN = [...CUSTODY_FORBIDDEN_ENV, "FLEET_CUSTODY_DATABASE_URL", "FLEET_IDENTITY_DATABASE_URL"];

export function browserEnvProblems(e: Record<string, string | undefined>, opts: { uid?: number | null; username?: string } = {}): string[] {
  const problems: string[] = [];
  const uid = opts.uid === undefined ? (typeof process.getuid === "function" ? process.getuid() : null) : opts.uid;
  if (uid === 0) problems.push("refusing to run as root (uid 0)");
  const expected = e.FLEET_BROWSER_EXPECTED_USER?.trim();
  const user = opts.username ?? os.userInfo().username;
  if (expected && user !== expected) problems.push(`running as ${user}, expected ${expected}`);
  for (const k of FORBIDDEN) if (e[k]) problems.push(`${k} present (the browser worker holds no controller, agent, operator, custody or identity credential)`);
  if (!e.FLEET_BROWSER_DATABASE_URL?.trim()) problems.push("FLEET_BROWSER_DATABASE_URL is not configured");
  const exe = e.FLEET_BROWSER_EXECUTABLE?.trim();
  if (!exe || !path.isAbsolute(exe) || !fs.existsSync(exe)) problems.push("FLEET_BROWSER_EXECUTABLE (absolute path to Chromium) is missing");
  return problems;
}

export async function startBrowserWorker(e: Record<string, string | undefined>, opts: { log?: Logger; uid?: number | null; username?: string; pollMs?: number } = {}) {
  const log = opts.log ?? createJsonLogger(undefined, "automaton-fleet-browser");
  const problems = browserEnvProblems(e, opts);
  if (problems.length) throw new Error(`browser worker startup refused: ${problems.join("; ")}`);
  const gw = new PgBrowserGateway({ connectionString: e.FLEET_BROWSER_DATABASE_URL!.trim(), schema: e.FLEET_PG_SCHEMA?.trim() || "fleet" });
  try {
    const p = await gw.ping();
    if (p.schemaVersion !== FLEET_PG_SCHEMA_VERSION) throw new Error(`registry schema v${p.schemaVersion ?? "none"} != required v${FLEET_PG_SCHEMA_VERSION}`);
  } catch (err) {
    await gw.close();
    throw new Error(`browser worker startup refused: ${redactText(err instanceof Error ? err.message : String(err))}`);
  }
  const worker = new BrowserWorker(gw, { executablePath: e.FLEET_BROWSER_EXECUTABLE!.trim(), chromiumSandbox: e.FLEET_BROWSER_SANDBOX === "true",
    brokerPublicKey: async () => (await gw.brokerKey()).ownerPub, log: (level, event, detail) => log(level as never, event, detail) });
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void worker.tick().catch((err) => log("error", "browser_tick_failed", { error: redactText(err instanceof Error ? err.message : String(err)) }))
      .finally(() => { busy = false; });
  }, Math.max(250, opts.pollMs ?? 500));
  log("info", "browser_worker_started", { schemaVersion: FLEET_PG_SCHEMA_VERSION });
  return { worker, close: async () => { clearInterval(timer); await worker.close(); await gw.close(); } };
}

if (process.argv[1] && /fleet[\\/]browser[\\/]main\.(ts|js)$/.test(process.argv[1])) {
  const log = createJsonLogger(undefined, "automaton-fleet-browser");
  startBrowserWorker(process.env).catch((err) => {
    log("fatal", "startup_failed", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}

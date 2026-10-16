/**
 * Build environment entrypoint (schema v89): `node dist/fleet/build/main.js`, its own system user (automaton-fleet-build),
 * no inbound port, no credentials, loopback only (the egress proxy and PostgreSQL's socket).
 *
 *   FLEET_BUILD_DATABASE_URL   the fleet_build_login connection (bbx_* only)
 *   FLEET_BUILD_PROXY_PORT     the egress proxy's loopback port (default 3129), or "none" (builds without dependency downloads)
 *
 * Startup refuses (fail closed) when running as root, any safety switch is true, ANY credential is visible (this unit holds
 * none, not even a systemd credentials directory), or the schema is not this release's.
 */
import os from "os";
import { CUSTODY_FORBIDDEN_ENV } from "../secret-files.js";
import { createJsonLogger, type Logger } from "../service/log.js";
import { redactText } from "../redact.js";
import { FLEET_PG_SCHEMA_VERSION } from "../postgres/migrations.js";
import { BuildWorker, PgBuildPort } from "./buildbox.js";

const SAFETY_SWITCHES = ["REAL_REPLICATION_ENABLED", "REAL_PAYMENTS_ENABLED", "OWNER_SWEEP_ENABLED", "FLEET_DRY_RUN_CHILD"];
const on = (v: string | undefined) => v?.trim().toLowerCase() === "true";
// The build environment holds no credential at all: CREDENTIALS_DIRECTORY stays forbidden here.
const FORBIDDEN = [...new Set([...CUSTODY_FORBIDDEN_ENV, "FLEET_CUSTODY_DATABASE_URL", "FLEET_IDENTITY_DATABASE_URL", "FLEET_BROWSER_DATABASE_URL", "FLEET_DASHBOARD_DATABASE_URL",
  "FLEET_BANKFEED_DATABASE_URL", "FLEET_PROVIDER_DATABASE_URL", "FLEET_CHANNELS_DATABASE_URL", "FLEET_PUSH_DATABASE_URL", "FLEET_MEDIA_DATABASE_URL", "FLEET_CODE_DATABASE_URL",
  "FLEET_ADMIN_DATABASE_URL", "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "NODE_AUTH_TOKEN"])];

export function buildEnvProblems(e: Record<string, string | undefined>, opts: { uid?: number | null; username?: string } = {}): string[] {
  const problems: string[] = [];
  const uid = opts.uid === undefined ? (typeof process.getuid === "function" ? process.getuid() : null) : opts.uid;
  if (uid === 0) problems.push("refusing to run as root (uid 0)");
  const expected = e.FLEET_BUILD_EXPECTED_USER?.trim();
  const user = opts.username ?? os.userInfo().username;
  if (expected && user !== expected) problems.push(`running as ${user}, expected ${expected}`);
  for (const s of SAFETY_SWITCHES) if (on(e[s])) problems.push(`${s}=true (the build environment refuses to run with ${s} on)`);
  for (const k of FORBIDDEN) if (e[k]) problems.push(`${k} present (the build environment holds no credential)`);
  if (!e.FLEET_BUILD_DATABASE_URL?.trim()) problems.push("FLEET_BUILD_DATABASE_URL is not configured");
  const p = e.FLEET_BUILD_PROXY_PORT?.trim() ?? "3129";
  if (p !== "none" && !(/^\d{2,5}$/.test(p) && Number(p) > 1023 && Number(p) < 65536)) problems.push("FLEET_BUILD_PROXY_PORT is a port above 1023, or none");
  return problems;
}

export async function startBuildEnvironment(e: Record<string, string | undefined>, opts: { log?: Logger; uid?: number | null; username?: string; pollMs?: number } = {}) {
  const log = opts.log ?? createJsonLogger(undefined, "automaton-fleet-build");
  const problems = buildEnvProblems(e, opts);
  if (problems.length) throw new Error(`build environment startup refused: ${problems.join("; ")}`);
  const port = new PgBuildPort({ connectionString: e.FLEET_BUILD_DATABASE_URL!.trim(), schema: e.FLEET_PG_SCHEMA?.trim() || "fleet" });
  const proxy = (e.FLEET_BUILD_PROXY_PORT?.trim() ?? "3129") === "none" ? null : Number(e.FLEET_BUILD_PROXY_PORT?.trim() ?? 3129);
  try {
    const h = await port.report(true, { proxy: proxy ? "egress proxy (package registries only)" : "no network" });
    if (h.schemaVersion !== FLEET_PG_SCHEMA_VERSION) throw new Error(`registry schema v${h.schemaVersion ?? "none"} != required v${FLEET_PG_SCHEMA_VERSION}`);
  } catch (err) {
    await port.close();
    throw new Error(`build environment startup refused: ${redactText(err instanceof Error ? err.message : String(err))}`);
  }
  log("info", "build_environment_started", { proxy });
  const worker = new BuildWorker(port, { proxyPort: proxy, workRoot: process.env.STATE_DIRECTORY || undefined }, (level, event, detail) => log(level as never, event, detail));
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    void worker.tick().catch((err) => log("error", "build_tick_failed", { error: redactText(err instanceof Error ? err.message : String(err)) })).finally(() => { busy = false; });
  };
  const timer = setInterval(tick, opts.pollMs ?? 15_000);
  tick();
  return { worker, close: async () => { clearInterval(timer); await port.close(); } };
}

if (process.argv[1] && /fleet[\\/]build[\\/]main\.(ts|js)$/.test(process.argv[1])) {
  const log = createJsonLogger(undefined, "automaton-fleet-build");
  startBuildEnvironment(process.env).catch((err) => {
    log("fatal", "startup_failed", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}

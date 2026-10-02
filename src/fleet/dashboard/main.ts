/**
 * Admin dashboard entrypoint (schema v38): `node dist/fleet/dashboard/main.js`, run as its own system user
 * (automaton-fleet-dashboard) behind the TLS front for admin.agentfleet.vip. Environment:
 *
 *   FLEET_DASHBOARD_DATABASE_URL   the fleet_dashboard_login connection (dash_* only — no owner credential)
 *   FLEET_DASHBOARD_ORIGIN         https://admin.agentfleet.vip
 *   FLEET_DASHBOARD_RP_ID          WebAuthn relying-party id (default: the origin's host)
 *   FLEET_DASHBOARD_LISTEN         127.0.0.1:8790 (loopback only)
 *   FLEET_DASHBOARD_STATE_DIR      private directory (0700) holding dashboard.key (32 bytes, base64; 0600/0400)
 *   FLEET_DASHBOARD_TRUST_PROXY    "true" when a loopback TLS front sets X-Forwarded-For
 *
 * Startup refuses (fail closed): running as root; any controller/admin/service/agent/operator/custody/identity/browser
 * credential visible; a non-loopback listen address; a non-https origin; a non-private state directory or key; a schema
 * that is not this release's. Subcommand `init` creates the state key.
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { createJsonLogger } from "../service/log.js";
import { CUSTODY_FORBIDDEN_ENV } from "../secret-files.js";
import { FLEET_PG_SCHEMA_VERSION } from "../postgres/migrations.js";
import { redactText } from "../redact.js";
import { vaultFileProblems } from "../custody/vault.js";
import { privateDirProblems } from "../identity/vaults.js";
import { PgDashboardGateway } from "./gateway.js";
import { createDashboardServer } from "./server.js";

const FORBIDDEN = [...CUSTODY_FORBIDDEN_ENV, "FLEET_CUSTODY_DATABASE_URL", "FLEET_IDENTITY_DATABASE_URL", "FLEET_BROWSER_DATABASE_URL"];

export function dashboardEnvProblems(e: Record<string, string | undefined>, opts: { uid?: number | null; username?: string } = {}): string[] {
  const problems: string[] = [];
  const uid = opts.uid === undefined ? (typeof process.getuid === "function" ? process.getuid() : null) : opts.uid;
  if (uid === 0) problems.push("refusing to run as root (uid 0)");
  const expected = e.FLEET_DASHBOARD_EXPECTED_USER?.trim();
  const user = opts.username ?? os.userInfo().username;
  if (expected && user !== expected) problems.push(`running as ${user}, expected ${expected}`);
  for (const k of FORBIDDEN) if (e[k]) problems.push(`${k} present (the dashboard holds no controller, owner, agent, operator, custody, identity or browser credential)`);
  if (!e.FLEET_DASHBOARD_DATABASE_URL?.trim()) problems.push("FLEET_DASHBOARD_DATABASE_URL is not configured");
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(e.FLEET_DASHBOARD_ORIGIN?.trim() ?? "")) problems.push("FLEET_DASHBOARD_ORIGIN must be an https origin");
  const listen = e.FLEET_DASHBOARD_LISTEN?.trim() || "127.0.0.1:8790";
  if (!/^(127\.0\.0\.1|\[::1\]):\d{2,5}$/.test(listen)) problems.push("FLEET_DASHBOARD_LISTEN must be a loopback address (the TLS front is public, not this process)");
  const dir = e.FLEET_DASHBOARD_STATE_DIR?.trim();
  if (!dir || !path.isAbsolute(dir)) problems.push("FLEET_DASHBOARD_STATE_DIR (absolute) is not configured");
  else { problems.push(...privateDirProblems(dir, uid)); problems.push(...vaultFileProblems(path.join(dir, "dashboard.key"), uid)); }
  return problems;
}

export async function startDashboard(e: Record<string, string | undefined>) {
  const log = createJsonLogger(undefined, "automaton-fleet-dashboard");
  const problems = dashboardEnvProblems(e);
  if (problems.length) throw new Error(`dashboard startup refused: ${problems.join("; ")}`);
  const gw = new PgDashboardGateway({ connectionString: e.FLEET_DASHBOARD_DATABASE_URL!.trim(), schema: e.FLEET_PG_SCHEMA?.trim() || "fleet" });
  try {
    const p = await gw.ping();
    if (p.schemaVersion !== FLEET_PG_SCHEMA_VERSION) throw new Error(`registry schema v${p.schemaVersion ?? "none"} != required v${FLEET_PG_SCHEMA_VERSION}`);
  } catch (err) {
    await gw.close();
    throw new Error(`dashboard startup refused: ${redactText(err instanceof Error ? err.message : String(err))}`);
  }
  const origin = e.FLEET_DASHBOARD_ORIGIN!.trim();
  const key = Buffer.from(fs.readFileSync(path.join(e.FLEET_DASHBOARD_STATE_DIR!.trim(), "dashboard.key"), "utf8").trim(), "base64");
  const server = createDashboardServer(gw, { origin, rpId: e.FLEET_DASHBOARD_RP_ID?.trim() || new URL(origin).hostname, stateKey: key,
    trustProxy: e.FLEET_DASHBOARD_TRUST_PROXY === "true", log: (level, event, detail) => log(level as never, event, detail) });
  const [host, port] = (e.FLEET_DASHBOARD_LISTEN?.trim() || "127.0.0.1:8790").replace(/^\[|\](?=:)/g, "").split(/:(?=\d+$)/);
  await new Promise<void>((resolve) => server.listen(Number(port), host, () => resolve()));
  log("info", "dashboard_started", { origin, listen: `${host}:${port}`, schemaVersion: FLEET_PG_SCHEMA_VERSION });
  return { server, close: async () => { server.close(); await gw.close(); } };
}

if (process.argv[1] && /fleet[\\/]dashboard[\\/]main\.(ts|js)$/.test(process.argv[1])) {
  const log = createJsonLogger(undefined, "automaton-fleet-dashboard");
  if (process.argv[2] === "init") {
    const dir = process.env.FLEET_DASHBOARD_STATE_DIR?.trim();
    if (!dir) { log("fatal", "init_failed", { error: "FLEET_DASHBOARD_STATE_DIR is required" }); process.exit(2); }
    fs.mkdirSync(dir!, { recursive: true, mode: 0o700 });
    const f = path.join(dir!, "dashboard.key");
    if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString("base64"), { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ ok: true }));
  } else {
    startDashboard(process.env).catch((err) => { log("fatal", "startup_failed", { error: err instanceof Error ? err.message : String(err) }); process.exit(1); });
  }
}

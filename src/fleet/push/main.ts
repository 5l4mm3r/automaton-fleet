/**
 * Phone-push sender entrypoint (schema v83): `node dist/fleet/push/main.js`, run as its own system user
 * (automaton-fleet-push) from the pinned release, with no inbound port and outbound HTTPS to the provider only.
 *
 *   FLEET_PUSH_DATABASE_URL      the fleet_push_login connection (px_* only)
 *   FLEET_PUSH_DASHBOARD_ORIGIN  the dashboard origin the alert links open (https://admin.agentfleet.vip)
 *   $CREDENTIALS_DIRECTORY/pushover-token, pushover-user   systemd credentials (LoadCredential=); never in the environment,
 *                                the repository or a log. Absent → the sender runs "not configured": it reports so to the
 *                                dashboard and sends nothing (deliveries wait).
 *
 * Startup refuses (fail closed) when: running as root; any safety switch is true; another unit's credential is visible;
 * the origin is not https; the schema is not this release's.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { CUSTODY_FORBIDDEN_ENV } from "../secret-files.js";
import { createJsonLogger, type Logger } from "../service/log.js";
import { redactText } from "../redact.js";
import { FLEET_PG_SCHEMA_VERSION } from "../postgres/migrations.js";
import { PUSHOVER_API, PushoverProvider, type PushHttp } from "./pushover.js";
import { PgPushGateway, PushSender } from "./sender.js";

const SAFETY_SWITCHES = ["REAL_REPLICATION_ENABLED", "REAL_PAYMENTS_ENABLED", "OWNER_SWEEP_ENABLED", "FLEET_DRY_RUN_CHILD"];
const on = (v: string | undefined) => v?.trim().toLowerCase() === "true";
const FORBIDDEN = [...CUSTODY_FORBIDDEN_ENV, "FLEET_CUSTODY_DATABASE_URL", "FLEET_IDENTITY_DATABASE_URL", "FLEET_BROWSER_DATABASE_URL", "FLEET_DASHBOARD_DATABASE_URL",
  "FLEET_BANKFEED_DATABASE_URL", "FLEET_PROVIDER_DATABASE_URL", "FLEET_CHANNELS_DATABASE_URL", "FLEET_ADMIN_DATABASE_URL"];

export function pushEnvProblems(e: Record<string, string | undefined>, opts: { uid?: number | null; username?: string } = {}): string[] {
  const problems: string[] = [];
  const uid = opts.uid === undefined ? (typeof process.getuid === "function" ? process.getuid() : null) : opts.uid;
  if (uid === 0) problems.push("refusing to run as root (uid 0)");
  const expected = e.FLEET_PUSH_EXPECTED_USER?.trim();
  const user = opts.username ?? os.userInfo().username;
  if (expected && user !== expected) problems.push(`running as ${user}, expected ${expected}`);
  for (const s of SAFETY_SWITCHES) if (on(e[s])) problems.push(`${s}=true (the push sender refuses to run with ${s} on)`);
  for (const k of FORBIDDEN) if (e[k]) problems.push(`${k} present (the push sender holds no other unit's credential)`);
  if (!e.FLEET_PUSH_DATABASE_URL?.trim()) problems.push("FLEET_PUSH_DATABASE_URL is not configured");
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(e.FLEET_PUSH_DASHBOARD_ORIGIN?.trim() ?? "")) problems.push("FLEET_PUSH_DASHBOARD_ORIGIN must be an https origin");
  return problems;
}

/** The provider credentials from systemd's credential directory; null when absent (not configured). */
export function pushCredentials(dir: string | undefined): { token: string; user: string } | null {
  if (!dir || !path.isAbsolute(dir)) return null;
  const read = (n: string) => { try { return fs.readFileSync(path.join(dir, n), "utf8").trim(); } catch { return ""; } };
  const token = read("pushover-token"), user = read("pushover-user");
  if (!/^[A-Za-z0-9]{30}$/.test(token) || !/^[A-Za-z0-9]{30}$/.test(user)) return null;
  return { token, user };
}

/** Real HTTP to the provider's API host only; no redirects; a timeout. */
export const fetchPush: PushHttp = async (url, body) => {
  if (!url.startsWith(`${PUSHOVER_API}/`)) throw new Error("FLEET_PUSH_HOST");
  const r = await fetch(url, { method: "POST", body, signal: AbortSignal.timeout(20_000), redirect: "error" });
  return { status: r.status, headers: r.headers, json: () => r.json() };
};

export async function startPushSender(e: Record<string, string | undefined>, opts: { log?: Logger; uid?: number | null; username?: string; pollMs?: number;
  http?: PushHttp; providerBase?: string } = {}) {
  const log = opts.log ?? createJsonLogger(undefined, "automaton-fleet-push");
  const problems = pushEnvProblems(e, opts);
  if (problems.length) throw new Error(`push sender startup refused: ${problems.join("; ")}`);
  const gw = new PgPushGateway({ connectionString: e.FLEET_PUSH_DATABASE_URL!.trim(), schema: e.FLEET_PG_SCHEMA?.trim() || "fleet" });
  const creds = pushCredentials(e.CREDENTIALS_DIRECTORY);
  try {
    const h = await gw.heartbeat("pushover", creds !== null);
    if (h.schemaVersion !== FLEET_PG_SCHEMA_VERSION) throw new Error(`registry schema v${h.schemaVersion ?? "none"} != required v${FLEET_PG_SCHEMA_VERSION}`);
  } catch (err) {
    await gw.close();
    throw new Error(`push sender startup refused: ${redactText(err instanceof Error ? err.message : String(err))}`);
  }
  const provider = creds ? new PushoverProvider(creds, opts.http ?? fetchPush, opts.providerBase) : null;
  log("info", "push_sender_started", { provider: "pushover", configured: provider !== null });
  const sender = new PushSender(gw, provider, e.FLEET_PUSH_DASHBOARD_ORIGIN!.trim(), (level, event, detail) => log(level as never, event, detail));
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    void sender.tick().catch((err) => log("error", "push_tick_failed", { error: redactText(err instanceof Error ? err.message : String(err)) })).finally(() => { busy = false; });
  };
  const timer = setInterval(tick, opts.pollMs ?? 5_000);
  tick();
  return { sender, close: async () => { clearInterval(timer); await gw.close(); } };
}

if (process.argv[1] && /fleet[\\/]push[\\/]main\.(ts|js)$/.test(process.argv[1])) {
  const log = createJsonLogger(undefined, "automaton-fleet-push");
  startPushSender(process.env).catch((err) => {
    log("fatal", "startup_failed", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}

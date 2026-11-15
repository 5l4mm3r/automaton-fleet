/**
 * Code gateway entrypoint (schema v89): `node dist/fleet/code/main.js`, its own system user (automaton-fleet-code), no
 * inbound port, outbound HTTPS to GitHub's API and codeload hosts only.
 *
 *   FLEET_CODE_DATABASE_URL        the fleet_code_login connection (cgx_* only)
 *   FLEET_CODE_GITHUB_APP_ID       the Fleet GitHub App's numeric id      FLEET_CODE_GITHUB_APP_SLUG  its public slug (install link)
 *   $CREDENTIALS_DIRECTORY/github-app-key   the app's private key (PEM), a systemd credential; never in the environment,
 *                                  the repository or a log. Absent → "not configured": customers' access stays pending.
 *
 * Startup refuses (fail closed) when running as root, any safety switch is true, another unit's credential is visible, or
 * the schema is not this release's.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { CUSTODY_FORBIDDEN_ENV } from "../secret-files.js";
import { createJsonLogger, type Logger } from "../service/log.js";
import { redactText } from "../redact.js";
import { FLEET_PG_SCHEMA_VERSION } from "../postgres/migrations.js";
import { GITHUB_API, GITHUB_CODELOAD, GitHubApp, type GitHubHttp } from "./github.js";
import { CodeGatewayWorker, PgCodeGateway } from "./gateway.js";

const SAFETY_SWITCHES = ["REAL_REPLICATION_ENABLED", "REAL_PAYMENTS_ENABLED", "OWNER_SWEEP_ENABLED", "FLEET_DRY_RUN_CHILD"];
const on = (v: string | undefined) => v?.trim().toLowerCase() === "true";
// Its own systemd credentials directory is expected (systemd exposes only this unit's credentials there).
const FORBIDDEN = [...new Set([...CUSTODY_FORBIDDEN_ENV, "FLEET_CUSTODY_DATABASE_URL", "FLEET_IDENTITY_DATABASE_URL", "FLEET_BROWSER_DATABASE_URL", "FLEET_DASHBOARD_DATABASE_URL",
  "FLEET_BANKFEED_DATABASE_URL", "FLEET_PROVIDER_DATABASE_URL", "FLEET_CHANNELS_DATABASE_URL", "FLEET_PUSH_DATABASE_URL", "FLEET_MEDIA_DATABASE_URL", "FLEET_BUILD_DATABASE_URL",
  "FLEET_ADMIN_DATABASE_URL"])].filter((k) => k !== "CREDENTIALS_DIRECTORY");

export function codeEnvProblems(e: Record<string, string | undefined>, opts: { uid?: number | null; username?: string } = {}): string[] {
  const problems: string[] = [];
  const uid = opts.uid === undefined ? (typeof process.getuid === "function" ? process.getuid() : null) : opts.uid;
  if (uid === 0) problems.push("refusing to run as root (uid 0)");
  const expected = e.FLEET_CODE_EXPECTED_USER?.trim();
  const user = opts.username ?? os.userInfo().username;
  if (expected && user !== expected) problems.push(`running as ${user}, expected ${expected}`);
  for (const s of SAFETY_SWITCHES) if (on(e[s])) problems.push(`${s}=true (the code gateway refuses to run with ${s} on)`);
  for (const k of FORBIDDEN) if (e[k]) problems.push(`${k} present (the code gateway holds no other unit's credential)`);
  if (!e.FLEET_CODE_DATABASE_URL?.trim()) problems.push("FLEET_CODE_DATABASE_URL is not configured");
  if (e.FLEET_CODE_GITHUB_APP_ID && !/^\d{1,12}$/.test(e.FLEET_CODE_GITHUB_APP_ID.trim())) problems.push("FLEET_CODE_GITHUB_APP_ID must be the app's numeric id");
  if (e.FLEET_CODE_GITHUB_APP_SLUG && !/^[a-z0-9-]{2,60}$/.test(e.FLEET_CODE_GITHUB_APP_SLUG.trim())) problems.push("FLEET_CODE_GITHUB_APP_SLUG must be the app's slug");
  return problems;
}

/** The app's private key from systemd's credential directory; null when absent (not configured). */
export function appKey(dir: string | undefined): string | null {
  if (!dir || !path.isAbsolute(dir)) return null;
  try {
    const k = fs.readFileSync(path.join(dir, "github-app-key"), "utf8").trim();
    return /^-----BEGIN (RSA )?PRIVATE KEY-----[\s\S]+-----END (RSA )?PRIVATE KEY-----$/.test(k) ? k : null;
  } catch { return null; }
}

/** GitHub's API host only; its tarball redirect only to codeload.github.com; a timeout. */
export const fetchGitHub: GitHubHttp = async (url, init) => {
  if (!url.startsWith(`${GITHUB_API}/`)) throw new Error("FLEET_CODE_HOST");
  let r = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: AbortSignal.timeout(60_000), redirect: "manual" });
  if (r.status === 302 || r.status === 307) {
    const loc = r.headers.get("location") ?? "";
    if (!loc.startsWith(`${GITHUB_CODELOAD}/`)) throw new Error("FLEET_CODE_HOST");
    r = await fetch(loc, { method: "GET", signal: AbortSignal.timeout(120_000), redirect: "error" });
  }
  const res = r;
  return { status: res.status, headers: res.headers, json: () => res.json(), bytes: async () => {
    const b = Buffer.from(await res.arrayBuffer());
    if (b.length > 20_000_000) throw new Error("the repository snapshot is larger than 20 MB");
    return b;
  } };
};

export async function startCodeGateway(e: Record<string, string | undefined>, opts: { log?: Logger; uid?: number | null; username?: string; pollMs?: number; http?: GitHubHttp; api?: string } = {}) {
  const log = opts.log ?? createJsonLogger(undefined, "automaton-fleet-code");
  const problems = codeEnvProblems(e, opts);
  if (problems.length) throw new Error(`code gateway startup refused: ${problems.join("; ")}`);
  const gw = new PgCodeGateway({ connectionString: e.FLEET_CODE_DATABASE_URL!.trim(), schema: e.FLEET_PG_SCHEMA?.trim() || "fleet" });
  const key = appKey(e.CREDENTIALS_DIRECTORY);
  const appId = e.FLEET_CODE_GITHUB_APP_ID?.trim();
  const app = key && appId ? new GitHubApp({ appId, privateKeyPem: key, http: opts.http ?? fetchGitHub, api: opts.api }) : null;
  try {
    const h = await gw.report(app !== null, { appSlug: e.FLEET_CODE_GITHUB_APP_SLUG?.trim() || null });
    if (h.schemaVersion !== FLEET_PG_SCHEMA_VERSION) throw new Error(`registry schema v${h.schemaVersion ?? "none"} != required v${FLEET_PG_SCHEMA_VERSION}`);
  } catch (err) {
    await gw.close();
    throw new Error(`code gateway startup refused: ${redactText(err instanceof Error ? err.message : String(err))}`);
  }
  log("info", "code_gateway_started", { configured: app !== null });
  const worker = new CodeGatewayWorker(gw, app, { appSlug: e.FLEET_CODE_GITHUB_APP_SLUG?.trim() || null }, (level, event, detail) => log(level as never, event, detail));
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    void worker.tick().catch((err) => log("error", "code_tick_failed", { error: redactText(err instanceof Error ? err.message : String(err)) })).finally(() => { busy = false; });
  };
  const timer = setInterval(tick, opts.pollMs ?? 20_000);
  tick();
  return { worker, close: async () => { clearInterval(timer); await gw.close(); } };
}

if (process.argv[1] && /fleet[\\/]code[\\/]main\.(ts|js)$/.test(process.argv[1])) {
  const log = createJsonLogger(undefined, "automaton-fleet-code");
  startCodeGateway(process.env).catch((err) => {
    log("fatal", "startup_failed", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}

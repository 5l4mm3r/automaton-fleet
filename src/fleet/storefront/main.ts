/**
 * Storefront gateway entrypoint (schema v52): `node dist/fleet/storefront/main.js`, run as its own system user
 * (automaton-fleet-gumroad) from the pinned release, with no inbound port. Environment:
 *
 *   FLEET_PROVIDER_DATABASE_URL   the fleet_provider_login connection (gx_* only)
 *   FLEET_STOREFRONT_VAULT_DIR    the gateway's own vault directory (0700, its own uid): one 0600 file per token reference
 *                                 (`vault:gumroad/owner` → `gumroad~owner`), written only by `oauth-exchange`
 *
 * Startup refuses (fail closed) when: running as root; any of the four safety switches is true (receiving never needs
 * one); any controller/admin/service/agent/operator/custody/identity/browser credential is visible; the vault directory is
 * not private; the schema is not this release's. Each provider account is then used only after its account check (exact
 * user, exact scopes).
 *
 * Subcommands (onboarding, stdin-only; the token is never printed):
 *   oauth-url <clientId> <redirectUri>            print the authorisation URL for exactly edit_products view_sales view_payouts
 *   oauth-exchange <vault:gumroad/name>           read {"clientId","clientSecret","code","redirectUri"} on stdin, exchange the
 *                                                 code, check the granted scopes are exactly those three, store the token (0600)
 */
import fs from "fs";
import os from "os";
import path from "path";
import { createJsonLogger, type Logger } from "../service/log.js";
import { CUSTODY_FORBIDDEN_ENV } from "../secret-files.js";
import { FLEET_PG_SCHEMA_VERSION } from "../postgres/migrations.js";
import { redactText } from "../redact.js";
import { FileVault, vaultFileName } from "../custody/vault.js";
import { privateDirProblems } from "../identity/vaults.js";
import { GUMROAD_API, GUMROAD_SCOPES, type StorefrontHttp } from "./gumroad-client.js";
import { PgStorefrontGateway } from "./gateway.js";
import { StorefrontWorker } from "./worker.js";

const SAFETY_SWITCHES = ["REAL_REPLICATION_ENABLED", "REAL_PAYMENTS_ENABLED", "OWNER_SWEEP_ENABLED", "FLEET_DRY_RUN_CHILD"];
const on = (v: string | undefined) => v?.trim().toLowerCase() === "true";
const FORBIDDEN = [...CUSTODY_FORBIDDEN_ENV, "FLEET_CUSTODY_DATABASE_URL", "FLEET_IDENTITY_DATABASE_URL", "FLEET_BROWSER_DATABASE_URL", "FLEET_DASHBOARD_DATABASE_URL",
  "FLEET_BANKFEED_DATABASE_URL"];

export function storefrontEnvProblems(e: Record<string, string | undefined>, opts: { uid?: number | null; username?: string } = {}): string[] {
  const problems: string[] = [];
  const uid = opts.uid === undefined ? (typeof process.getuid === "function" ? process.getuid() : null) : opts.uid;
  if (uid === 0) problems.push("refusing to run as root (uid 0)");
  const expected = e.FLEET_STOREFRONT_EXPECTED_USER?.trim();
  const user = opts.username ?? os.userInfo().username;
  if (expected && user !== expected) problems.push(`running as ${user}, expected ${expected}`);
  for (const s of SAFETY_SWITCHES) if (on(e[s])) problems.push(`${s}=true (the storefront gateway only receives; it refuses to run with ${s} on)`);
  for (const k of FORBIDDEN) if (e[k]) problems.push(`${k} present (the gateway holds no other unit's credential)`);
  if (!e.FLEET_PROVIDER_DATABASE_URL?.trim()) problems.push("FLEET_PROVIDER_DATABASE_URL is not configured");
  const dir = e.FLEET_STOREFRONT_VAULT_DIR?.trim();
  if (!dir || !path.isAbsolute(dir)) problems.push("FLEET_STOREFRONT_VAULT_DIR (absolute) is not configured");
  else problems.push(...privateDirProblems(dir, uid));
  return problems;
}

/** Real HTTP (api.gumroad.com and S3 part uploads only — the client's allowlist decides), with a timeout; nothing logged. */
const fetchHttp: StorefrontHttp = async (url, init) => {
  const r = await fetch(url, { method: init.method, headers: init.headers, body: init.body as BodyInit | undefined, signal: AbortSignal.timeout(60_000), redirect: "error" });
  return { status: r.status, json: () => r.json(), header: (n: string) => r.headers.get(n) };
};

export async function startStorefrontGateway(e: Record<string, string | undefined>, opts: { log?: Logger; uid?: number | null; username?: string; pollMs?: number;
  http?: StorefrontHttp } = {}) {
  const log = opts.log ?? createJsonLogger(undefined, "automaton-fleet-gumroad");
  const problems = storefrontEnvProblems(e, opts);
  if (problems.length) throw new Error(`storefront gateway startup refused: ${problems.join("; ")}`);
  const gw = new PgStorefrontGateway({ connectionString: e.FLEET_PROVIDER_DATABASE_URL!.trim(), schema: e.FLEET_PG_SCHEMA?.trim() || "fleet" });
  try {
    const p = await gw.ping();
    if (p.schemaVersion !== FLEET_PG_SCHEMA_VERSION) throw new Error(`registry schema v${p.schemaVersion ?? "none"} != required v${FLEET_PG_SCHEMA_VERSION}`);
  } catch (err) {
    await gw.close();
    throw new Error(`storefront gateway startup refused: ${redactText(err instanceof Error ? err.message : String(err))}`);
  }
  const worker = new StorefrontWorker(gw, new FileVault(e.FLEET_STOREFRONT_VAULT_DIR!.trim()), opts.http ?? fetchHttp,
    { log: (level, event, detail) => log(level as never, event, detail) });
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void worker.tick().catch((err) => log("error", "storefront_tick_failed", { error: redactText(err instanceof Error ? err.message : String(err)) }))
      .finally(() => { busy = false; });
  }, Math.max(1_000, opts.pollMs ?? 5_000));
  log("info", "storefront_gateway_started", { schemaVersion: FLEET_PG_SCHEMA_VERSION });
  return { worker, close: async () => { clearInterval(timer); await gw.close(); } };
}

/** The owner's authorisation URL: exactly the three scopes (a self-generated token would carry them all). */
export function oauthUrl(clientId: string, redirectUri: string): string {
  const u = new URL("https://gumroad.com/oauth/authorize");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", GUMROAD_SCOPES.join(" "));
  u.searchParams.set("response_type", "code");
  return u.toString();
}

/** Exchange the code; refuse a token with any scope beyond the three; store it 0600 in the vault. Never returns the token. */
export async function oauthExchange(vaultDir: string, vaultRef: string, input: { clientId: string; clientSecret: string; code: string; redirectUri: string },
  http: StorefrontHttp = fetchHttp): Promise<{ stored: string; scopes: string[] }> {
  const name = vaultFileName(vaultRef);
  if (!name || !vaultRef.startsWith("vault:gumroad/")) throw new Error("FLEET_BAD_REQUEST: a vault:gumroad/<name> reference");
  const r = await http(`${GUMROAD_API}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: input.clientId, client_secret: input.clientSecret, code: input.code, redirect_uri: input.redirectUri, grant_type: "authorization_code" }) });
  const body = (await r.json().catch(() => ({}))) as { access_token?: unknown; scope?: unknown };
  if (r.status >= 300 || typeof body.access_token !== "string" || body.access_token.length < 16) throw new Error("FLEET_PROVIDER_REJECTED: the code was not exchanged");
  const scopes = (typeof body.scope === "string" ? body.scope.split(/\s+/) : Array.isArray(body.scope) ? body.scope.map(String) : []).filter(Boolean).sort();
  if (scopes.length !== GUMROAD_SCOPES.length || !GUMROAD_SCOPES.every((s) => scopes.includes(s))) {
    throw new Error(`FLEET_PROVIDER_SCOPE: the token carries ${scopes.join(" ") || "no stated scope"}; exactly ${GUMROAD_SCOPES.join(" ")} is required (re-authorise)`);
  }
  const f = path.join(vaultDir, name);
  fs.writeFileSync(`${f}.tmp`, body.access_token, { mode: 0o600, flag: "w" });
  fs.renameSync(`${f}.tmp`, f);
  return { stored: vaultRef, scopes };
}

if (process.argv[1] && /fleet[\\/]storefront[\\/]main\.(ts|js)$/.test(process.argv[1])) {
  const log = createJsonLogger(undefined, "automaton-fleet-gumroad");
  const [cmd, a1, a2] = process.argv.slice(2);
  if (cmd === "oauth-url") {
    if (!a1 || !a2) { log("fatal", "usage", { error: "oauth-url <clientId> <redirectUri>" }); process.exit(2); }
    console.log(oauthUrl(a1, a2));
  } else if (cmd === "oauth-exchange") {
    const dir = process.env.FLEET_STOREFRONT_VAULT_DIR?.trim() ?? "";
    let input: { clientId: string; clientSecret: string; code: string; redirectUri: string };
    try { input = JSON.parse(fs.readFileSync(0, "utf8")); } catch { log("fatal", "usage", { error: "stdin: one JSON object {clientId, clientSecret, code, redirectUri}" }); process.exit(2); }
    oauthExchange(dir, a1 ?? "", input!).then((r) => console.log(JSON.stringify({ ok: true, ...r })),
      (err) => { log("fatal", "oauth_exchange_failed", { error: (err instanceof Error ? err.message : String(err)).slice(0, 300) }); process.exit(1); });
  } else {
    startStorefrontGateway(process.env).catch((err) => {
      log("fatal", "startup_failed", { error: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    });
  }
}

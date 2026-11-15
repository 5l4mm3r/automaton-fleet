/**
 * Channel gateway entrypoint (schema v80): `node dist/fleet/channels/main.js`, run as its own system user
 * (automaton-fleet-channels) from the pinned release, with no inbound port. Environment:
 *
 *   FLEET_CHANNELS_DATABASE_URL   the fleet_channels_login connection (chx_* only)
 *   FLEET_CHANNELS_VAULT_DIR      the gateway's own vault (0700, its own uid): one 0600 JSON file per connection token
 *                                 (`vault:etsy/shop1` → `etsy~shop1`), written only by `oauth-exchange` and token refresh
 *
 * Startup refuses (fail closed) when: running as root; any of the four safety switches is true (the gateway publishes and
 * reads; it never pays); any other unit's credential is visible; the vault directory is not private; the schema is not
 * this release's. Each connection is used only after its account check.
 *
 * Onboarding (the owner, once per connection; the token is never printed):
 *   oauth-url <etsy|pinterest> <clientId> <redirectUri>   print the authorisation URL for exactly the required scopes (PKCE
 *                                                         verifier kept in the vault, 30 minutes)
 *   oauth-exchange <etsy|pinterest> <vault:provider/name> read {"clientId","clientSecret","code","state","redirectUri"} on stdin,
 *                                                         exchange the code, check the scopes are exactly the required ones,
 *                                                         store the token; prints the provider account (and Etsy shop id) to
 *                                                         use with `economy-channel-connect`
 */
import crypto from "crypto";
import os from "os";
import path from "path";
import { CUSTODY_FORBIDDEN_ENV } from "../secret-files.js";
import { privateDirProblems } from "../identity/vaults.js";
import { createJsonLogger, type Logger } from "../service/log.js";
import { redactText } from "../redact.js";
import { FLEET_PG_SCHEMA_VERSION } from "../postgres/migrations.js";
import { PROVIDER_SCOPES } from "../postgres/migrations-phase80.js";
import { ChannelApiError, ETSY_API, EtsyClient, PINTEREST_API, PinterestClient, TokenStore, type ChannelHttp, type StoredToken } from "./clients.js";
import { INDEXNOW_ENDPOINT } from "../service/indexnow.js";
import { PgChannelGateway } from "./gateway.js";
import { ChannelWorker } from "./worker.js";

const SAFETY_SWITCHES = ["REAL_REPLICATION_ENABLED", "REAL_PAYMENTS_ENABLED", "OWNER_SWEEP_ENABLED", "FLEET_DRY_RUN_CHILD"];
const on = (v: string | undefined) => v?.trim().toLowerCase() === "true";
const FORBIDDEN = [...CUSTODY_FORBIDDEN_ENV, "FLEET_CUSTODY_DATABASE_URL", "FLEET_IDENTITY_DATABASE_URL", "FLEET_BROWSER_DATABASE_URL", "FLEET_DASHBOARD_DATABASE_URL",
  "FLEET_BANKFEED_DATABASE_URL", "FLEET_PROVIDER_DATABASE_URL"];

export function channelsEnvProblems(e: Record<string, string | undefined>, opts: { uid?: number | null; username?: string } = {}): string[] {
  const problems: string[] = [];
  const uid = opts.uid === undefined ? (typeof process.getuid === "function" ? process.getuid() : null) : opts.uid;
  if (uid === 0) problems.push("refusing to run as root (uid 0)");
  const expected = e.FLEET_CHANNELS_EXPECTED_USER?.trim();
  const user = opts.username ?? os.userInfo().username;
  if (expected && user !== expected) problems.push(`running as ${user}, expected ${expected}`);
  for (const s of SAFETY_SWITCHES) if (on(e[s])) problems.push(`${s}=true (the channel gateway never pays; it refuses to run with ${s} on)`);
  for (const k of FORBIDDEN) if (e[k]) problems.push(`${k} present (the gateway holds no other unit's credential)`);
  if (!e.FLEET_CHANNELS_DATABASE_URL?.trim()) problems.push("FLEET_CHANNELS_DATABASE_URL is not configured");
  const dir = e.FLEET_CHANNELS_VAULT_DIR?.trim();
  if (!dir || !path.isAbsolute(dir)) problems.push("FLEET_CHANNELS_VAULT_DIR (absolute) is not configured");
  else problems.push(...privateDirProblems(dir, uid));
  return problems;
}

/** Real HTTP to the two API hosts and the IndexNow endpoint only (the clients build the URLs); no redirects; a timeout; nothing logged. */
export const fetchHttp: ChannelHttp = async (url, init) => {
  if (!url.startsWith(`${ETSY_API}/`) && !url.startsWith(`${PINTEREST_API}/`) && url !== INDEXNOW_ENDPOINT) throw new ChannelApiError("FLEET_CHANNEL_API_HOST");
  const r = await fetch(url, { method: init.method, headers: init.headers, body: init.body as BodyInit | undefined, signal: AbortSignal.timeout(60_000), redirect: "error" });
  return { status: r.status, json: () => r.json() };
};

export async function startChannelGateway(e: Record<string, string | undefined>, opts: { log?: Logger; uid?: number | null; username?: string; pollMs?: number; http?: ChannelHttp } = {}) {
  const log = opts.log ?? createJsonLogger(undefined, "automaton-fleet-channels");
  const problems = channelsEnvProblems(e, opts);
  if (problems.length) throw new Error(`channel gateway startup refused: ${problems.join("; ")}`);
  const gw = new PgChannelGateway({ connectionString: e.FLEET_CHANNELS_DATABASE_URL!.trim(), schema: e.FLEET_PG_SCHEMA?.trim() || "fleet" });
  try {
    const p = await gw.ping();
    if (p.schemaVersion !== FLEET_PG_SCHEMA_VERSION) throw new Error(`registry schema v${p.schemaVersion ?? "none"} != required v${FLEET_PG_SCHEMA_VERSION}`);
  } catch (err) {
    await gw.close();
    throw new Error(`channel gateway startup refused: ${redactText(err instanceof Error ? err.message : String(err))}`);
  }
  const worker = new ChannelWorker(gw, new TokenStore(e.FLEET_CHANNELS_VAULT_DIR!.trim()), opts.http ?? fetchHttp, { log: (level, event, detail) => log(level as never, event, detail) });
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void worker.tick().catch((err) => log("error", "channels_tick_failed", { error: redactText(err instanceof Error ? err.message : String(err)) })).finally(() => { busy = false; });
  }, Math.max(1_000, opts.pollMs ?? 5_000));
  log("info", "channel_gateway_started", { schemaVersion: FLEET_PG_SCHEMA_VERSION });
  return { worker, close: async () => { clearInterval(timer); await gw.close(); } };
}

const b64url = (b: Buffer) => b.toString("base64url");

/** The owner's authorisation URL (exactly the required scopes; PKCE S256; state kept with its verifier in the vault). */
export function oauthUrl(store: TokenStore, provider: "etsy" | "pinterest", clientId: string, redirectUri: string): string {
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  store.savePending(state, { provider, verifier, redirectUri });
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const u = new URL(provider === "etsy" ? "https://www.etsy.com/oauth/connect" : "https://www.pinterest.com/oauth/");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", PROVIDER_SCOPES[provider].join(provider === "etsy" ? " " : ","));
  u.searchParams.set("state", state);
  if (provider === "etsy") { u.searchParams.set("code_challenge", challenge); u.searchParams.set("code_challenge_method", "S256"); }
  return u.toString();
}

/** Exchange the code; refuse any other scopes; store the token (0600). Returns the provider account to connect, never the token. */
export async function oauthExchange(store: TokenStore, http: ChannelHttp, provider: "etsy" | "pinterest", vaultRef: string,
  input: { clientId: string; clientSecret: string; code: string; state: string; redirectUri: string }, now = Date.now()): Promise<{ stored: string; account: string; shopId: string | null; scopes: string[] }> {
  if (!vaultRef.startsWith(`vault:${provider}/`)) throw new ChannelApiError("FLEET_BAD_REQUEST: a vault:<provider>/<name> reference of that provider");
  const pending = store.takePending(input.state);
  if (!pending || pending.provider !== provider || pending.redirectUri !== input.redirectUri) throw new ChannelApiError("FLEET_CHANNEL_API_STATE: unknown or expired authorisation (run oauth-url again)");
  const r = provider === "etsy"
    ? await http(`${ETSY_API}/v3/public/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: input.clientId, redirect_uri: input.redirectUri, code: input.code, code_verifier: pending.verifier }) })
    : await http(`${PINTEREST_API}/v5/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64")}` },
        body: new URLSearchParams({ grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri }) });
  const b = (await r.json().catch(() => ({}))) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown };
  if (r.status >= 300 || typeof b.access_token !== "string" || typeof b.refresh_token !== "string") throw new ChannelApiError("FLEET_PROVIDER_REJECTED: the code was not exchanged");
  const t: StoredToken = { provider, accessToken: b.access_token, refreshToken: b.refresh_token, expiresAt: now + Math.max(60, Number(b.expires_in) || 3600) * 1000,
    clientId: input.clientId, clientSecret: input.clientSecret, scopes: [] };
  let account = ""; let shopId: string | null = null;
  if (provider === "etsy") {
    const e = new EtsyClient(http, t);
    t.scopes = await e.scopes();
    const w = await e.whoami(); account = w.account; shopId = w.shopId;
  } else {
    t.scopes = (typeof b.scope === "string" ? b.scope.split(/[ ,]+/) : []).filter(Boolean).sort();
    account = (await new PinterestClient(http, t).whoami()).account;
  }
  const want = [...PROVIDER_SCOPES[provider]].sort();
  if (t.scopes.length !== want.length || !want.every((s, i) => t.scopes[i] === s)) {
    throw new ChannelApiError(`FLEET_PROVIDER_SCOPE: the token carries ${t.scopes.join(" ") || "no stated scope"}; exactly ${want.join(" ")} is required (re-authorise)`);
  }
  store.write(vaultRef, t);
  return { stored: vaultRef, account, shopId, scopes: t.scopes };
}

if (process.argv[1] && /fleet[\\/]channels[\\/]main\.(ts|js)$/.test(process.argv[1])) {
  const log = createJsonLogger(undefined, "automaton-fleet-channels");
  const [cmd, a1, a2, a3] = process.argv.slice(2);
  const dir = process.env.FLEET_CHANNELS_VAULT_DIR?.trim() ?? "";
  const provider = a1 === "etsy" || a1 === "pinterest" ? a1 : null;
  if (cmd === "oauth-url") {
    if (!provider || !a2 || !a3 || !dir) { log("fatal", "usage", { error: "oauth-url <etsy|pinterest> <clientId> <redirectUri> (FLEET_CHANNELS_VAULT_DIR set)" }); process.exit(2); }
    console.log(oauthUrl(new TokenStore(dir), provider, a2, a3));
  } else if (cmd === "oauth-exchange") {
    if (!provider || !a2 || !dir) { log("fatal", "usage", { error: "oauth-exchange <etsy|pinterest> <vault:provider/name> < input.json" }); process.exit(2); }
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      void oauthExchange(new TokenStore(dir), fetchHttp, provider, a2, JSON.parse(raw)).then((r) => console.log(JSON.stringify(r)))
        .catch((err) => { log("fatal", "oauth_exchange_failed", { error: redactText(err instanceof Error ? err.message : String(err)) }); process.exit(1); });
    });
  } else {
    startChannelGateway(process.env).catch((err) => {
      log("fatal", "startup_failed", { error: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    });
  }
}

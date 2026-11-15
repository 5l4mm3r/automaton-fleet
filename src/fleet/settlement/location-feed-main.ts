/**
 * Money-location feed service (schema v86): `node dist/fleet/settlement/location-feed-main.js`, run as its own system user
 * (automaton-fleet-bankfeed) from the pinned release, with no inbound port and outbound HTTPS to the bank's API host only.
 * It READS bank accounts (balance, transactions) and records them through rx_* (role fleet_bankfeed); it can move nothing.
 *
 *   FLEET_BANKFEED_DATABASE_URL     the fleet_bankfeed_login connection (rx_* only)
 *   FLEET_LOCATION_FEED_ACCOUNTS    JSON: [{"locationId": "<uuid>", "provider": "starling", "accountUid": "<uuid>", "categoryUid": "<uuid>"}]
 *                                   — which bank account feeds which money location (ids, not secrets)
 *   FLEET_LOCATION_FEED_POLL_MIN    minutes between passes (default 15, 5..240)
 *   $CREDENTIALS_DIRECTORY/bank_<locationId>   the account's read-only token, a systemd credential (LoadCredential=bank:
 *                                   a root-only directory); never in the environment, the repository or a log. A location
 *                                   without one is skipped ("not configured") and keeps waiting for statement imports.
 *
 * Startup refuses (fail closed) when: running as root; any safety switch is true; another unit's credential is visible;
 * the account map is malformed. A token whose scopes are not all read-only is refused at every pass (location_feed_scope_refused).
 */
import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { CUSTODY_FORBIDDEN_ENV } from "../secret-files.js";
import { createJsonLogger, type Logger } from "../service/log.js";
import { redactText } from "../redact.js";
import { LocationFeedConnector, StarlingClient, type LocationBalance, type LocationFeedClient, type LocationFeedPort, type LocationTxn } from "./location-feed.js";

const SAFETY_SWITCHES = ["REAL_REPLICATION_ENABLED", "REAL_PAYMENTS_ENABLED", "OWNER_SWEEP_ENABLED", "FLEET_DRY_RUN_CHILD"];
const on = (v: string | undefined) => v?.trim().toLowerCase() === "true";
// Its own systemd credentials directory is expected (systemd exposes only this unit's credentials there).
const FORBIDDEN = [...new Set([...CUSTODY_FORBIDDEN_ENV, "FLEET_CUSTODY_DATABASE_URL", "FLEET_IDENTITY_DATABASE_URL", "FLEET_BROWSER_DATABASE_URL", "FLEET_DASHBOARD_DATABASE_URL",
  "FLEET_PUSH_DATABASE_URL", "FLEET_MEDIA_DATABASE_URL", "FLEET_PROVIDER_DATABASE_URL", "FLEET_CHANNELS_DATABASE_URL", "FLEET_ADMIN_DATABASE_URL"])].filter((k) => k !== "CREDENTIALS_DIRECTORY");
export const STARLING_API = "https://api.starlingbank.com";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface FeedAccount { locationId: string; provider: "starling"; accountUid: string; categoryUid: string }

export function parseFeedAccounts(raw: string | undefined): FeedAccount[] {
  let v: unknown;
  try { v = JSON.parse(raw?.trim() || "[]"); } catch { throw new Error("FLEET_LOCATION_FEED_ACCOUNTS is not JSON"); }
  if (!Array.isArray(v) || v.length > 10) throw new Error("FLEET_LOCATION_FEED_ACCOUNTS: an array of at most 10 accounts");
  const seen = new Set<string>();
  return v.map((x, i) => {
    const a = x as Record<string, unknown>;
    if (a.provider !== "starling") throw new Error(`account ${i}: provider must be starling (the only adapter built)`);
    for (const k of ["locationId", "accountUid", "categoryUid"]) if (typeof a[k] !== "string" || !UUID.test(a[k] as string)) throw new Error(`account ${i}: ${k} must be a UUID`);
    if (seen.has(a.locationId as string)) throw new Error(`account ${i}: location fed twice`);
    seen.add(a.locationId as string);
    return { locationId: a.locationId as string, provider: "starling", accountUid: a.accountUid as string, categoryUid: a.categoryUid as string };
  });
}

export function feedEnvProblems(e: Record<string, string | undefined>, opts: { uid?: number | null; username?: string } = {}): string[] {
  const problems: string[] = [];
  const uid = opts.uid === undefined ? (typeof process.getuid === "function" ? process.getuid() : null) : opts.uid;
  if (uid === 0) problems.push("refusing to run as root (uid 0)");
  const expected = e.FLEET_BANKFEED_EXPECTED_USER?.trim();
  const user = opts.username ?? os.userInfo().username;
  if (expected && user !== expected) problems.push(`running as ${user}, expected ${expected}`);
  for (const s of SAFETY_SWITCHES) if (on(e[s])) problems.push(`${s}=true (the bank feed refuses to run with ${s} on)`);
  for (const k of FORBIDDEN) if (e[k]) problems.push(`${k} present (the bank feed holds no other unit's credential)`);
  if (!e.FLEET_BANKFEED_DATABASE_URL?.trim()) problems.push("FLEET_BANKFEED_DATABASE_URL is not configured");
  try { parseFeedAccounts(e.FLEET_LOCATION_FEED_ACCOUNTS); } catch (err) { problems.push((err as Error).message); }
  const poll = Number(e.FLEET_LOCATION_FEED_POLL_MIN ?? 15);
  if (!Number.isInteger(poll) || poll < 5 || poll > 240) problems.push("FLEET_LOCATION_FEED_POLL_MIN must be 5..240");
  return problems;
}

/** Tokens from systemd's credential directory: ref "cred:<locationId>" → $CREDENTIALS_DIRECTORY/bank_<locationId>. */
export function credentialVault(dir: string | undefined) {
  return {
    resolve: async (ref: string): Promise<string | null> => {
      const m = /^cred:([0-9a-f-]{36})$/.exec(ref);
      if (!m || !dir || !path.isAbsolute(dir)) return null;
      try {
        const v = fs.readFileSync(path.join(dir, `bank_${m[1]}`), "utf8").trim();
        return /^[A-Za-z0-9._~+/=-]{20,4096}$/.test(v) ? v : null;
      } catch { return null; }
    },
  };
}

/** Real HTTP to the bank's API host only; no redirects; a timeout. */
export const fetchStarling = async (url: string, init: { headers: Record<string, string> }) => {
  if (!url.startsWith(`${STARLING_API}/`)) throw new Error("FLEET_BANKFEED_HOST");
  const r = await fetch(url, { headers: init.headers, signal: AbortSignal.timeout(20_000), redirect: "error" });
  return { ok: r.ok, status: r.status, json: () => r.json() as Promise<unknown> };
};

/** rx_* through the fleet_bankfeed_login connection. */
export class PgLocationFeedPort implements LocationFeedPort {
  private readonly pool: pg.Pool;
  constructor(o: { connectionString: string; schema?: string }) {
    const schema = o.schema ?? "fleet";
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error("bad schema");
    this.pool = new pg.Pool({ connectionString: o.connectionString, max: 2, application_name: "automaton-fleet-bankfeed",
      options: `-c search_path=${schema} -c statement_timeout=30000` });
  }
  private async one<T>(sql: string, args: unknown[]): Promise<T> { return (await this.pool.query(sql, args)).rows[0].r as T; }
  locations(worker: string) { return this.one<Array<{ locationId: string; provider: string; currency: string; status: string }>>(`SELECT rx_locations($1) AS r`, [worker]); }
  balance(worker: string, locationId: string, b: LocationBalance) {
    return this.one<{ ok: boolean; code?: string }>(`SELECT rx_location_balance($1, $2, $3, $4, $5, 'api') AS r`, [worker, locationId, b.availableMinor, b.clearedMinor, b.pendingMinor]);
  }
  txn(worker: string, locationId: string, t: LocationTxn) {
    return this.one<{ ok: boolean; code?: string; match?: string }>(`SELECT rx_location_txn($1, $2, $3::jsonb) AS r`, [worker, locationId, JSON.stringify({ ...t, source: "api" })]);
  }
  close() { return this.pool.end(); }
}

export async function startLocationFeed(e: Record<string, string | undefined>, opts: { log?: Logger; uid?: number | null; username?: string;
  fetch?: typeof fetchStarling; baseUrl?: string; pollMs?: number } = {}) {
  const log = opts.log ?? createJsonLogger(undefined, "automaton-fleet-bankfeed");
  const problems = feedEnvProblems(e, opts);
  if (problems.length) throw new Error(`bank feed startup refused: ${problems.join("; ")}`);
  const accounts = parseFeedAccounts(e.FLEET_LOCATION_FEED_ACCOUNTS);
  const port = new PgLocationFeedPort({ connectionString: e.FLEET_BANKFEED_DATABASE_URL!.trim(), schema: e.FLEET_PG_SCHEMA?.trim() || "fleet" });
  try { await port.locations("bank-feed"); } catch (err) {
    await port.close();
    throw new Error(`bank feed startup refused: ${redactText(err instanceof Error ? err.message : String(err))}`);
  }
  // One client per fed location (the connector picks the client by provider; here each location has its own account ids).
  const vault = credentialVault(e.CREDENTIALS_DIRECTORY);
  const connectors = accounts.map((a) => new LocationFeedConnector(
    { locations: async (w) => (await port.locations(w)).filter((l) => l.locationId === a.locationId), balance: (w, l, b) => port.balance(w, l, b), txn: (w, l, t) => port.txn(w, l, t) },
    vault, { starling: new StarlingClient({ accountUid: a.accountUid, categoryUid: a.categoryUid, fetch: opts.fetch ?? fetchStarling, baseUrl: opts.baseUrl }) as LocationFeedClient },
    { [a.locationId]: `cred:${a.locationId}` },
    { log: (level, event, detail) => log(level as never, event, detail) }));
  log("info", "bankfeed_started", { accounts: accounts.length, configured: (await Promise.all(accounts.map((a) => vault.resolve(`cred:${a.locationId}`)))).filter(Boolean).length });
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    void (async () => {
      for (const c of connectors) {
        try { log("info", "bankfeed_pass", await c.tick()); } catch (err) { log("error", "bankfeed_pass_failed", { error: redactText(err instanceof Error ? err.message : String(err)) }); }
      }
    })().finally(() => { busy = false; });
  };
  const timer = setInterval(tick, opts.pollMs ?? Number(e.FLEET_LOCATION_FEED_POLL_MIN ?? 15) * 60_000);
  tick();
  return { close: async () => { clearInterval(timer); await port.close(); }, tick: async () => { for (const c of connectors) await c.tick(); } };
}

if (process.argv[1] && /fleet[\\/]settlement[\\/]location-feed-main\.(ts|js)$/.test(process.argv[1])) {
  const log = createJsonLogger(undefined, "automaton-fleet-bankfeed");
  startLocationFeed(process.env).catch((err) => {
    log("fatal", "startup_failed", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}

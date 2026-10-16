/**
 * Media provider gateway entrypoint (schema v85): `node dist/fleet/media/main.js`, its own system user (automaton-fleet-media),
 * no inbound port, outbound HTTPS to the chosen providers' API hosts only.
 *
 *   FLEET_MEDIA_DATABASE_URL          the fleet_media_login connection (mx_* only)
 *   FLEET_MEDIA_SEARCH_PROVIDER       brave | none        FLEET_MEDIA_SEARCH_COST_CENTS  the owner's per-search cost estimate (USD cents)
 *   FLEET_MEDIA_IMAGE_PROVIDER        openai | none       FLEET_MEDIA_IMAGE_COST_CENTS   the owner's per-image cost estimate (USD cents)
 *   FLEET_MEDIA_IMAGE_MODEL           gpt-image-1 (default) or a newer gpt-image-* model
 *   $CREDENTIALS_DIRECTORY/search-key, image-key          systemd credentials; never in the environment, the repository or a log
 *
 * A provider without its key, or set to "none", is reported "not configured" and its jobs are never claimed. Startup refuses
 * (fail closed) when running as root, any safety switch is true, another unit's credential is visible, or the schema is
 * not this release's.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { CUSTODY_FORBIDDEN_ENV } from "../secret-files.js";
import { createJsonLogger, type Logger } from "../service/log.js";
import { redactText } from "../redact.js";
import { FLEET_PG_SCHEMA_VERSION } from "../postgres/migrations.js";
import { BRAVE_SEARCH_API, BraveSearch, OPENAI_IMAGES_API, OpenAiImages, type MediaHttp } from "./providers.js";
import { MediaWorker, PgMediaGateway, type MediaConfig } from "./gateway.js";

const SAFETY_SWITCHES = ["REAL_REPLICATION_ENABLED", "REAL_PAYMENTS_ENABLED", "OWNER_SWEEP_ENABLED", "FLEET_DRY_RUN_CHILD"];
const on = (v: string | undefined) => v?.trim().toLowerCase() === "true";
const FORBIDDEN = [...new Set([...CUSTODY_FORBIDDEN_ENV, "FLEET_CUSTODY_DATABASE_URL", "FLEET_IDENTITY_DATABASE_URL", "FLEET_BROWSER_DATABASE_URL", "FLEET_DASHBOARD_DATABASE_URL",
  "FLEET_BANKFEED_DATABASE_URL", "FLEET_PROVIDER_DATABASE_URL", "FLEET_CHANNELS_DATABASE_URL", "FLEET_PUSH_DATABASE_URL", "FLEET_ADMIN_DATABASE_URL"])];
export const SEARCH_PROVIDERS = ["brave", "none"] as const;
export const IMAGE_PROVIDERS = ["openai", "none"] as const;

export function mediaEnvProblems(e: Record<string, string | undefined>, opts: { uid?: number | null; username?: string } = {}): string[] {
  const problems: string[] = [];
  const uid = opts.uid === undefined ? (typeof process.getuid === "function" ? process.getuid() : null) : opts.uid;
  if (uid === 0) problems.push("refusing to run as root (uid 0)");
  const expected = e.FLEET_MEDIA_EXPECTED_USER?.trim();
  if (expected && (opts.username ?? os.userInfo().username) !== expected) problems.push(`not running as ${expected}`);
  for (const s of SAFETY_SWITCHES) if (on(e[s])) problems.push(`${s}=true (the media gateway refuses to run with ${s} on)`);
  for (const k of FORBIDDEN) if (e[k]) problems.push(`${k} present (the media gateway holds no other unit's credential)`);
  if (!e.FLEET_MEDIA_DATABASE_URL?.trim()) problems.push("FLEET_MEDIA_DATABASE_URL is not configured");
  if (!(SEARCH_PROVIDERS as readonly string[]).includes(e.FLEET_MEDIA_SEARCH_PROVIDER?.trim() || "none")) problems.push(`FLEET_MEDIA_SEARCH_PROVIDER is one of ${SEARCH_PROVIDERS.join(", ")}`);
  if (!(IMAGE_PROVIDERS as readonly string[]).includes(e.FLEET_MEDIA_IMAGE_PROVIDER?.trim() || "none")) problems.push(`FLEET_MEDIA_IMAGE_PROVIDER is one of ${IMAGE_PROVIDERS.join(", ")}`);
  return problems;
}

const readKey = (dir: string | undefined, name: string): string | null => {
  if (!dir || !path.isAbsolute(dir)) return null;
  try { const k = fs.readFileSync(path.join(dir, name), "utf8").trim(); return /^[A-Za-z0-9_\-.]{16,300}$/.test(k) ? k : null; } catch { return null; }
};
/** The image model (default gpt-image-1; the owner may name a newer gpt-image model). */
const imageModel = (v: string | undefined) => (/^gpt-image-[a-z0-9.-]{1,30}$/.test(v?.trim() ?? "") ? v!.trim() : "gpt-image-1");
const cents = (v: string | undefined) => { const n = Number(v ?? ""); return Number.isInteger(n) && n >= 0 && n <= 10_000 ? n : 0; };

/** The providers this gateway may call, each limited to its own API host; no redirects; a timeout. */
export const fetchMedia: MediaHttp = async (url, init) => {
  if (!url.startsWith(BRAVE_SEARCH_API) && url !== OPENAI_IMAGES_API) throw new Error("FLEET_MEDIA_HOST");
  const r = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: AbortSignal.timeout(90_000), redirect: "error" });
  return { status: r.status, headers: r.headers, json: () => r.json() };
};

export function mediaConfig(e: Record<string, string | undefined>, http: MediaHttp): MediaConfig {
  const sp = e.FLEET_MEDIA_SEARCH_PROVIDER?.trim() || "none", ip = e.FLEET_MEDIA_IMAGE_PROVIDER?.trim() || "none";
  const sk = sp === "none" ? null : readKey(e.CREDENTIALS_DIRECTORY, "search-key");
  const ik = ip === "none" ? null : readKey(e.CREDENTIALS_DIRECTORY, "image-key");
  return {
    search: sp === "brave" && sk ? { provider: new BraveSearch(sk, http), unitCostCents: cents(e.FLEET_MEDIA_SEARCH_COST_CENTS) } : null,
    image: ip === "openai" && ik ? { provider: new OpenAiImages(ik, http, undefined, imageModel(e.FLEET_MEDIA_IMAGE_MODEL)), unitCostCents: cents(e.FLEET_MEDIA_IMAGE_COST_CENTS) } : null,
    names: { search: sp, image: ip },
  };
}

export async function startMediaGateway(e: Record<string, string | undefined>, opts: { log?: Logger; uid?: number | null; username?: string; pollMs?: number; http?: MediaHttp } = {}) {
  const log = opts.log ?? createJsonLogger(undefined, "automaton-fleet-media");
  const problems = mediaEnvProblems(e, opts);
  if (problems.length) throw new Error(`media gateway startup refused: ${problems.join("; ")}`);
  const gw = new PgMediaGateway({ connectionString: e.FLEET_MEDIA_DATABASE_URL!.trim(), schema: e.FLEET_PG_SCHEMA?.trim() || "fleet" });
  const cfg = mediaConfig(e, opts.http ?? fetchMedia);
  try {
    const h = await gw.report("search", cfg.search?.provider.name ?? cfg.names.search, cfg.search !== null, cfg.search?.unitCostCents ?? null);
    if (h.schemaVersion !== FLEET_PG_SCHEMA_VERSION) throw new Error(`registry schema v${h.schemaVersion ?? "none"} != required v${FLEET_PG_SCHEMA_VERSION}`);
  } catch (err) {
    await gw.close();
    throw new Error(`media gateway startup refused: ${redactText(err instanceof Error ? err.message : String(err))}`);
  }
  log("info", "media_gateway_started", { search: cfg.search ? cfg.names.search : "not configured", image: cfg.image ? cfg.names.image : "not configured" });
  const worker = new MediaWorker(gw, cfg, (level, event, detail) => log(level as never, event, detail));
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    void worker.tick().catch((err) => log("error", "media_tick_failed", { error: redactText(err instanceof Error ? err.message : String(err)) })).finally(() => { busy = false; });
  };
  const timer = setInterval(tick, opts.pollMs ?? 1_000);
  tick();
  return { worker, close: async () => { clearInterval(timer); await gw.close(); } };
}

if (process.argv[1] && /fleet[\\/]media[\\/]main\.(ts|js)$/.test(process.argv[1])) {
  const log = createJsonLogger(undefined, "automaton-fleet-media");
  startMediaGateway(process.env).catch((err) => { log("fatal", "startup_failed", { error: err instanceof Error ? err.message : String(err) }); process.exit(1); });
}

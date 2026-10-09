/**
 * Custody executor entrypoint (Phase E, schema v10; custody signer, schema v32): `node dist/fleet/custody/main.js`,
 * run by deploy/systemd/automaton-fleet-custody.service as its own system user
 * (automaton-fleet-custody), from the same pinned release as FleetController.
 *
 * It opens no network listener. Its signers (v32) come from a NON-SECRET signer
 * file (FLEET_CUSTODY_SIGNERS_FILE: rail, provider, mode, credential id, vault
 * reference) and their secrets from the custody vault directory
 * (FLEET_CUSTODY_VAULT_DIR, else systemd $CREDENTIALS_DIRECTORY) — never from the
 * environment. It attests its signers to the registry; while the registry pins
 * custody execution off (and rails never live) it never claims anything.
 *
 * Startup refuses (fail closed) when:
 *  - running as root, or not as FLEET_CUSTODY_EXPECTED_USER;
 *  - any admin/service/agent/operator/Conway credential is visible, or
 *    admin.env / service.env / operator.env / the TLS key is readable;
 *  - any custody credential is present in the environment;
 *  - the signer file or a signer's vault file is missing, malformed or insecure;
 *  - a LIVE payout signer is configured while REAL_PAYMENTS_ENABLED is not true (v48: REAL_PAYMENTS_ENABLED is the
 *    fourth key of live custody — the registry's owner activation, a verified live rail and a fresh attestation are the
 *    others; a receive-only rail entry needs no payout signer and so no flag);
 *  - REAL_REPLICATION_ENABLED / OWNER_SWEEP_ENABLED is on (neither belongs to custody);
 *  - FLEET_CUSTODY_DATABASE_URL is missing;
 *  - the pinned release is incomplete or differs from the registry approval;
 *  - the database login is the schema owner, a superuser, or a member of
 *    anything but fleet_custody;
 *  - the schema is not this release's schema, custody execution is enabled with no
 *    signer, or the custody privilege audit reports anything.
 */

import fs from "fs";
import os from "os";
import { createJsonLogger, type Logger } from "../service/log.js";
import {
  CUSTODY_FORBIDDEN_ENV,
  DEFAULT_ADMIN_ENV_FILE,
  DEFAULT_OPERATOR_ENV_FILE,
  DEFAULT_SERVICE_ENV_FILE,
  DEFAULT_TLS_KEY_FILE,
  loadCustodyEnv,
} from "../secret-files.js";
import { loadRuntimeRelease, normalizeRepoUrl } from "../runtime.js";
import { redactText } from "../redact.js";
import path from "path";
import { CustodyExecutor, providersFromEnv } from "./executor.js";
import { loadSignerConfig, PayPalPayoutSigner, type CustodySigner, type HttpPort } from "./signers.js";
import { FileVault, vaultFileProblems } from "./vault.js";
import { PayPalTreasuryWorker } from "./paypal-treasury.js";
import { CompositeVault, loadOrCreateCustodyKey, SealedCredentialVault } from "./sealed-vault.js";
import { PgCustodyGateway } from "./gateway.js";
import { FLEET_PG_SCHEMA_VERSION } from "../postgres/migrations.js";

/** Exactly the schema this release migrates to (the custody protocol is unchanged since v10). */
export const CUSTODY_SCHEMA_VERSION = FLEET_PG_SCHEMA_VERSION;
// v48: REAL_PAYMENTS_ENABLED is no longer refused here — it is required (and only meaningful) for a live payout signer.
const SAFETY_SWITCHES = ["REAL_REPLICATION_ENABLED", "OWNER_SWEEP_ENABLED"];
const on = (v: string | undefined) => v?.trim().toLowerCase() === "true";

/** Controller, operator and witness secrets the custody executor must NOT be able to read. */
export const CUSTODY_UNREADABLE_FILES: readonly string[] = [
  DEFAULT_ADMIN_ENV_FILE,
  DEFAULT_SERVICE_ENV_FILE,
  DEFAULT_OPERATOR_ENV_FILE,
  DEFAULT_TLS_KEY_FILE,
  "/etc/automaton-fleet/legacy-env-fleet.bak",
  "/run/credentials/automaton-fleet.service/service.env",
  "/run/credentials/automaton-fleet.service/tls.key",
  "/var/lib/automaton-fleet-witness/fleet-credentials.json",
];

export interface CustodyStartOptions {
  log?: Logger;
  uid?: number | null;
  username?: string;
  secretFiles?: string[];
  installSignalHandlers?: boolean;
  pollMs?: number;
  /** Test seam: the HTTP port the PayPal treasury worker uses (default: real fetch with a timeout). */
  http?: HttpPort;
}

/** Startup problems that need no database. Names only, never values. */
export function custodyEnvProblems(
  e: Record<string, string | undefined>,
  opts: { uid?: number | null; username?: string; secretFiles?: string[] } = {},
): string[] {
  const problems: string[] = [];
  const uid = opts.uid === undefined ? (typeof process.getuid === "function" ? process.getuid() : null) : opts.uid;
  if (uid === 0) problems.push("refusing to run as root (uid 0)");
  const expected = e.FLEET_CUSTODY_EXPECTED_USER?.trim();
  const user = opts.username ?? os.userInfo().username;
  if (expected && user !== expected) problems.push(`running as ${user}, expected ${expected}`);
  if (!expected && e.NODE_ENV === "production") problems.push("FLEET_CUSTODY_EXPECTED_USER is required in production");
  for (const k of CUSTODY_FORBIDDEN_ENV) if (e[k]) problems.push(`${k} present (the custody executor must hold no admin/service/agent/operator/Conway credential)`);
  problems.push(...providersFromEnv(e).problems);
  for (const f of opts.secretFiles ?? CUSTODY_UNREADABLE_FILES) {
    try {
      fs.accessSync(f, fs.constants.R_OK);
      problems.push(`secret ${f} is readable by this process`);
    } catch {
      // not readable (or absent): as intended
    }
  }
  if (!e.FLEET_CUSTODY_DATABASE_URL?.trim()) problems.push("FLEET_CUSTODY_DATABASE_URL is not configured (custody.env)");
  for (const s of SAFETY_SWITCHES) if (on(e[s])) problems.push(`${s}=true (not a custody switch; the executor refuses to run with ${s} on)`);
  problems.push(...signersFromEnv(e, opts.uid === undefined ? undefined : opts.uid).problems);
  if (!loadRuntimeRelease(e)) problems.push("no complete pinned runtime release (FLEET_RUNTIME_REPO/_COMMIT/_BUILD_ID/_LOCKFILE_SHA256)");
  return problems;
}

/** Real HTTP for provider calls (custody executor only), with a timeout; nothing is logged. */
export const fetchHttp: HttpPort = async (url, init) => {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  return { status: r.status, json: () => r.json() };
};

/** The configured signers (rail-bound) and the vault, or the problems that refuse startup. */
export function signersFromEnv(e: Record<string, string | undefined>, uid?: number | null, http: HttpPort = fetchHttp):
  { signers: CustodySigner[]; vault: FileVault | null; problems: string[]; webhookIds: Record<string, string>; rails: number } {
  const file = e.FLEET_CUSTODY_SIGNERS_FILE?.trim();
  if (!file) return { signers: [], vault: null, problems: [], webhookIds: {}, rails: 0 };
  const cfg = loadSignerConfig(file);
  if (cfg.problems.length) return { signers: [], vault: null, problems: cfg.problems, webhookIds: {}, rails: 0 };
  const dir = e.FLEET_CUSTODY_VAULT_DIR?.trim() || e.CREDENTIALS_DIRECTORY?.trim();
  if (!dir || !path.isAbsolute(dir)) return { signers: [], vault: null, problems: ["signers are configured but no custody vault directory (FLEET_CUSTODY_VAULT_DIR or $CREDENTIALS_DIRECTORY)"], webhookIds: {}, rails: 0 };
  const owner = uid === undefined ? (typeof process.getuid === "function" ? process.getuid() : null) : uid;
  const vault = new FileVault(dir, owner);
  const problems: string[] = [];
  const signers: CustodySigner[] = [];
  const webhookIds: Record<string, string> = {};
  for (const b of cfg.entries) {
    if (b.webhookId) webhookIds[b.railId] = b.webhookId;
    const f = vault.fileFor(b.vaultRef);
    if (!f) problems.push(`signer ${b.railId}: malformed vault reference`);
    else problems.push(...vaultFileProblems(f, owner).map((x) => `signer ${b.railId}: vault ${x}`));
    if (b.receiveOnly) continue; // receiving and reconciliation only: no payout signer
    try {
      signers.push(new PayPalPayoutSigner({ railId: b.railId, provider: b.provider, mode: b.mode, credentialId: b.credentialId, vaultRef: b.vaultRef }, http));
    } catch (err) {
      problems.push(`signer ${b.railId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return problems.length ? { signers: [], vault: null, problems, webhookIds: {}, rails: 0 } : { signers, vault, problems: [], webhookIds, rails: cfg.entries.length };
}

export async function startCustodyFromEnv(
  e: Record<string, string | undefined>,
  opts: CustodyStartOptions = {},
): Promise<{ executor: CustodyExecutor; close: () => Promise<void> }> {
  const log = opts.log ?? createJsonLogger(undefined, "automaton-fleet-custody");
  const envProblems = custodyEnvProblems(e, opts);
  if (envProblems.length) throw new Error(`custody executor startup refused: ${envProblems.join("; ")}`);
  const schema = e.FLEET_PG_SCHEMA?.trim() || "fleet";
  const gateway = new PgCustodyGateway({ connectionString: e.FLEET_CUSTODY_DATABASE_URL!.trim(), schema });
  try {
    const who = await gateway.identity();
    if (who.isOwner || who.superuser) throw new Error(`the custody database login must be the restricted role, not ${who.isOwner ? "the schema owner" : "a superuser"} ${who.user}`);
    const expectedLogin = e.FLEET_CUSTODY_DB_LOGIN?.trim() || "fleet_custody_login";
    if (who.user !== expectedLogin) throw new Error(`the custody database login is ${who.user}, expected ${expectedLogin}`);
    const extra = who.memberOf.filter((r) => r !== "fleet_custody");
    if (extra.length) throw new Error(`the custody database login is a member of ${extra.join(", ")}`);
    const ping = await gateway.ping();
    if (ping.schemaVersion !== CUSTODY_SCHEMA_VERSION) throw new Error(`registry schema v${ping.schemaVersion ?? "none"} != required v${CUSTODY_SCHEMA_VERSION}`);
    if (ping.executionEnabled && !signersFromEnv(e, opts.uid).signers.length) throw new Error("custody execution is enabled in the registry, but this executor has no signer");
    const release = loadRuntimeRelease(e)!;
    const approvedRepo = ping.runtimeRepo ? normalizeRepoUrl(ping.runtimeRepo) : null;
    if (
      approvedRepo !== normalizeRepoUrl(release.repo) ||
      ping.runtimeCommit !== release.commit ||
      ping.runtimeBuildId !== release.buildId ||
      ping.runtimeLockfileSha256 !== release.lockfileSha256
    ) {
      throw new Error("pinned runtime release differs from the registry-approved runtime");
    }
    const audit = await gateway.auditCustody(schema);
    if (!audit.ok) throw new Error(`custody privilege audit failed: ${audit.problems.join("; ")}`);
  } catch (err) {
    await gateway.close();
    throw new Error(`custody executor startup refused: ${redactText(err instanceof Error ? err.message : String(err))}`);
  }
  const { signers, vault: fileVault, webhookIds, rails } = signersFromEnv(e, opts.uid);
  const stateDir = e.FLEET_CUSTODY_STATE_DIR?.trim() || "/var/lib/automaton-fleet-custody";
  // v49: dashboard-onboarded PayPal credentials, sealed to this executor's own key (kept in its 0600 state directory).
  let sealed: SealedCredentialVault | null = null;
  if (fs.existsSync(stateDir)) {
    try {
      sealed = new SealedCredentialVault(gateway, loadOrCreateCustodyKey(stateDir, opts.uid === undefined ? undefined : opts.uid), "custody-executor",
        (level, event, detail) => log(level as never, event, detail));
      await sealed.publish();
      await sealed.refresh();
    } catch (err) {
      log("warn", "custody_sealed_vault_unavailable", { error: redactText(err instanceof Error ? err.message : String(err)) });
      sealed = null;
    }
  }
  const vault = fileVault || sealed ? new CompositeVault([fileVault, sealed]) : null;
  const executor = new CustodyExecutor(gateway, [...providersFromEnv(e).providers, ...signers], {
    worker: "custody-executor",
    pollMs: opts.pollMs ?? 60_000,
    vault,
    stateFile: signers.length && fs.existsSync(stateDir) ? path.join(stateDir, "pending.json") : null,
    log: (level, event, detail) => log(level as never, event, detail),
  });
  // The service must stay up on its poll timer (an idle database pool alone would let Node exit 0 and
  // systemd's Restart=on-failure would not bring it back).
  executor.start({ keepAlive: true });
  // v48: the PayPal treasury worker (receiving + reconciliation; v59: requested refunds under the money-out authority).
  let treasury: PayPalTreasuryWorker | null = null;
  let treasuryTimer: NodeJS.Timeout | null = null;
  let treasuryRun: Promise<void> | null = null;
  if (vault && (rails > 0 || sealed)) {
    treasury = new PayPalTreasuryWorker(gateway, vault, opts.http ?? fetchHttp, {
      worker: "custody-executor", webhookIds,
      returnUrl: e.FLEET_PAYPAL_RETURN_URL?.trim() || undefined, cancelUrl: e.FLEET_PAYPAL_CANCEL_URL?.trim() || undefined,
      log: (level, event, detail) => log(level as never, event, detail),
    });
    let lastRefresh = Date.now();
    const run = () => {
      if (treasuryRun) return;
      treasuryRun = (async () => {
        if (sealed && Date.now() - lastRefresh >= 300_000) { lastRefresh = Date.now(); await sealed.refresh().catch(() => 0); }
        await treasury!.tick();
      })().finally(() => (treasuryRun = null));
    };
    run();
    treasuryTimer = setInterval(run, Math.max(5_000, opts.pollMs ?? 30_000));
  }
  const live = await gateway.ping().catch(() => null);
  log("info", "custody_executor_started", { schemaVersion: CUSTODY_SCHEMA_VERSION, signers: signers.map((x) => ({ railId: x.binding.railId, mode: x.binding.mode })),
    executionEnabled: live?.executionEnabled === true, paypalTreasury: treasury !== null, webhookRails: Object.keys(webhookIds).length,
    sealedCredentials: sealed?.refs().length ?? 0, custodyKey: sealed?.fingerprint.slice(0, 16) ?? null });
  const close = async () => {
    if (treasuryTimer) clearInterval(treasuryTimer);
    await treasuryRun;
    await executor.stop();
    await gateway.close();
  };
  if (opts.installSignalHandlers) {
    const stop = () => void close().then(() => process.exit(0));
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  }
  return { executor, close };
}

if (process.argv[1] && /fleet[\\/]custody[\\/]main\.(ts|js)$/.test(process.argv[1])) {
  const log = createJsonLogger(undefined, "automaton-fleet-custody");
  process.on("uncaughtException", (err) => {
    log("fatal", "uncaught_exception", { error: err.message });
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    log("fatal", "unhandled_rejection", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
  let env: Record<string, string | undefined>;
  try {
    env = loadCustodyEnv().env;
  } catch (err) {
    log("fatal", "startup_failed", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
  startCustodyFromEnv(env, { log, installSignalHandlers: true }).catch((err) => {
    log("fatal", "startup_failed", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}

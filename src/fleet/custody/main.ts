/**
 * Custody executor entrypoint (Phase E, schema v10): `node dist/fleet/custody/main.js`,
 * run by deploy/systemd/automaton-fleet-custody.service as its own system user
 * (automaton-fleet-custody), from the same pinned release as FleetController.
 *
 * INERT in v10: it opens no network listener, holds no custody credential,
 * has no provider integration, and the database refuses every instruction.
 * It proves the boundary exists: a distinct OS identity and DB role that can
 * do nothing but ping, and later claim/report already-authorized instructions.
 *
 * Startup refuses (fail closed) when:
 *  - running as root, or not as FLEET_CUSTODY_EXPECTED_USER;
 *  - any admin/service/agent/operator/Conway credential is visible, or
 *    admin.env / service.env / operator.env / the TLS key is readable;
 *  - any custody provider or custody credential is configured (none exists in v10);
 *  - REAL_PAYMENTS_ENABLED / REAL_REPLICATION_ENABLED / OWNER_SWEEP_ENABLED is on;
 *  - FLEET_CUSTODY_DATABASE_URL is missing;
 *  - the pinned release is incomplete or differs from the registry approval;
 *  - the database login is the schema owner, a superuser, or a member of
 *    anything but fleet_custody;
 *  - the schema is not v10, custody execution is enabled, or the custody
 *    privilege audit reports anything.
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
import { CustodyExecutor, providersFromEnv } from "./executor.js";
import { PgCustodyGateway } from "./gateway.js";

export const CUSTODY_SCHEMA_VERSION = 10;
const SAFETY_SWITCHES = ["REAL_REPLICATION_ENABLED", "REAL_PAYMENTS_ENABLED", "OWNER_SWEEP_ENABLED"];
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
  for (const s of SAFETY_SWITCHES) if (on(e[s])) problems.push(`${s}=true (the v10 custody executor is inert and refuses to run with ${s} on)`);
  if (!loadRuntimeRelease(e)) problems.push("no complete pinned runtime release (FLEET_RUNTIME_REPO/_COMMIT/_BUILD_ID/_LOCKFILE_SHA256)");
  return problems;
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
    if (ping.executionEnabled) throw new Error("custody execution is enabled in the registry, but this executor has no provider integration (v10 is inert)");
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
  const executor = new CustodyExecutor(gateway, providersFromEnv(e).providers, {
    worker: "custody-executor",
    pollMs: opts.pollMs ?? 60_000,
    log: (level, event, detail) => log(level as never, event, detail),
  });
  executor.start();
  log("info", "custody_executor_started", { schemaVersion: CUSTODY_SCHEMA_VERSION, providers: [], executionEnabled: false, inert: true });
  const close = async () => {
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

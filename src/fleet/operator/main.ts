/**
 * Operator API entrypoint (Phase B2): `node dist/fleet/operator/main.js`,
 * run by deploy/systemd/automaton-fleet-operator-api.service as its own
 * system user, from the same pinned release as FleetController.
 *
 * Startup refuses (fail closed) when:
 *  - running as root, or not as FLEET_OPERATOR_EXPECTED_USER;
 *  - any admin/service/agent/Conway/wallet credential is visible, or
 *    admin.env / service.env / the TLS key is readable by this process;
 *  - FLEET_OPERATOR_DATABASE_URL is missing;
 *  - the listen address is not loopback;
 *  - any safety switch is on;
 *  - the pinned release is incomplete or differs from the registry approval;
 *  - the database login is the schema owner, a superuser, or a member of
 *    anything but fleet_operator;
 *  - the schema is not v8, or the operator privilege audit reports anything.
 */

import fs from "fs";
import os from "os";
import { createAuditSink, createJsonLogger, type Logger } from "../service/log.js";
import {
  DEFAULT_ADMIN_ENV_FILE,
  DEFAULT_RUNTIME_ENV_FILE,
  DEFAULT_SERVICE_ENV_FILE,
  DEFAULT_TLS_KEY_FILE,
  OPERATOR_FORBIDDEN_ENV,
  loadOperatorEnv,
  readEnvFile,
} from "../secret-files.js";
import { loadRuntimeRelease, normalizeRepoUrl } from "../runtime.js";
import { PgOperatorGateway } from "./gateway.js";
import { OPERATOR_SCHEMA_VERSION, OperatorService } from "./server.js";
import type { RuntimeFlagsView } from "./responses.js";
import { redactText } from "../redact.js";

export const DEFAULT_OPERATOR_LISTEN = "127.0.0.1:8788";
export const DEFAULT_TIMESYNC_MARKER = "/run/systemd/timesync/synchronized";
const SAFETY_SWITCHES = ["REAL_REPLICATION_ENABLED", "REAL_PAYMENTS_ENABLED", "OWNER_SWEEP_ENABLED", "FLEET_DRY_RUN_CHILD"];
const on = (v: string | undefined) => v?.trim().toLowerCase() === "true";

export function parseOperatorListen(v: string | undefined): { host: string; port: number } {
  const s = (v ?? DEFAULT_OPERATOR_LISTEN).trim();
  const m = /^(127\.0\.0\.1|\[::1\]|localhost):([0-9]{1,5})$/.exec(s);
  if (!m) throw new Error(`FLEET_OPERATOR_LISTEN must be a loopback address (got ${redactText(s)})`);
  const port = Number(m[2]);
  if (port < 1 || port > 65535) throw new Error("FLEET_OPERATOR_LISTEN port out of range");
  return { host: m[1] === "[::1]" ? "::1" : m[1], port };
}

export interface OperatorStartOptions {
  log?: Logger;
  uid?: number | null;
  username?: string;
  /** Files this process must NOT be able to read (defaults: admin.env, service.env, TLS key). */
  secretFiles?: string[];
  timesyncMarker?: string;
  installSignalHandlers?: boolean;
  /** Tests: override the listen address. */
  listen?: { host: string; port: number };
}

/** Controller and witness secrets the Operator API process must not be able to read. */
export const OPERATOR_UNREADABLE_FILES: readonly string[] = [
  DEFAULT_ADMIN_ENV_FILE,
  DEFAULT_SERVICE_ENV_FILE,
  DEFAULT_TLS_KEY_FILE,
  "/etc/automaton-fleet/legacy-env-fleet.bak",
  "/run/credentials/automaton-fleet.service/service.env",
  "/run/credentials/automaton-fleet.service/tls.key",
  "/var/lib/automaton-fleet-witness/fleet-credentials.json",
];

/** Startup problems that need no database. Names only, never values. */
export function operatorEnvProblems(
  e: Record<string, string | undefined>,
  opts: { uid?: number | null; username?: string; secretFiles?: string[] } = {},
): string[] {
  const problems: string[] = [];
  const uid = opts.uid === undefined ? (typeof process.getuid === "function" ? process.getuid() : null) : opts.uid;
  if (uid === 0) problems.push("refusing to run as root (uid 0)");
  const expected = e.FLEET_OPERATOR_EXPECTED_USER?.trim();
  const user = opts.username ?? os.userInfo().username;
  if (expected && user !== expected) problems.push(`running as ${user}, expected ${expected}`);
  if (!expected && e.NODE_ENV === "production") problems.push("FLEET_OPERATOR_EXPECTED_USER is required in production");
  for (const k of OPERATOR_FORBIDDEN_ENV) if (e[k]) problems.push(`${k} present (the Operator API must hold no admin/service/agent/Conway/wallet credential)`);
  for (const f of opts.secretFiles ?? OPERATOR_UNREADABLE_FILES) {
    try {
      fs.accessSync(f, fs.constants.R_OK);
      problems.push(`controller secret ${f} is readable by this process`);
    } catch {
      // not readable (or absent): as intended
    }
  }
  if (!e.FLEET_OPERATOR_DATABASE_URL?.trim()) problems.push("FLEET_OPERATOR_DATABASE_URL is not configured (operator.env)");
  for (const s of SAFETY_SWITCHES) if (on(e[s])) problems.push(`${s}=true (the Operator API refuses to run with a safety switch on)`);
  if (!loadRuntimeRelease(e)) problems.push("no complete pinned runtime release (FLEET_RUNTIME_REPO/_COMMIT/_BUILD_ID/_LOCKFILE_SHA256)");
  try {
    parseOperatorListen(e.FLEET_OPERATOR_LISTEN);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }
  return problems;
}

/** Safety switches as this process can see them; unknown (null) when runtime.env cannot be read. */
function flagsFrom(file: string): RuntimeFlagsView {
  let env: Record<string, string>;
  try {
    if (!fs.existsSync(file)) throw new Error("missing");
    env = readEnvFile(file);
  } catch {
    return { realReplicationEnabled: null, realPaymentsEnabled: null, ownerSweepEnabled: null, dryRunChildEnabled: null };
  }
  return {
    realReplicationEnabled: on(env.REAL_REPLICATION_ENABLED),
    realPaymentsEnabled: on(env.REAL_PAYMENTS_ENABLED),
    ownerSweepEnabled: on(env.OWNER_SWEEP_ENABLED),
    dryRunChildEnabled: on(env.FLEET_DRY_RUN_CHILD),
  };
}

export async function startOperatorApiFromEnv(
  e: Record<string, string | undefined>,
  opts: OperatorStartOptions = {},
): Promise<{ service: OperatorService; url: string; close: () => Promise<void> }> {
  const log = opts.log ?? createJsonLogger(undefined, "automaton-fleet-operator-api");
  const envProblems = operatorEnvProblems(e, opts);
  if (envProblems.length) throw new Error(`Operator API startup refused: ${envProblems.join("; ")}`);
  const listen = opts.listen ?? parseOperatorListen(e.FLEET_OPERATOR_LISTEN);
  const schema = e.FLEET_PG_SCHEMA?.trim() || "fleet";
  const gateway = new PgOperatorGateway({ connectionString: e.FLEET_OPERATOR_DATABASE_URL!.trim(), schema });
  try {
    const who = await gateway.identity();
    if (who.isOwner || who.superuser) throw new Error(`the operator database login must be the restricted role, not ${who.isOwner ? "the schema owner" : "a superuser"} ${who.user}`);
    const expectedLogin = e.FLEET_OPERATOR_DB_LOGIN?.trim() || "fleet_operator_login";
    if (who.user !== expectedLogin) throw new Error(`the operator database login is ${who.user}, expected ${expectedLogin}`);
    const extra = who.memberOf.filter((r) => r !== "fleet_operator");
    if (extra.length) throw new Error(`the operator database login is a member of ${extra.join(", ")}`);
    const ping = await gateway.ping();
    if (ping.schemaVersion !== OPERATOR_SCHEMA_VERSION) throw new Error(`registry schema v${ping.schemaVersion ?? "none"} != required v${OPERATOR_SCHEMA_VERSION}`);
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
    const audit = await gateway.auditOperator(schema);
    if (!audit.ok) throw new Error(`operator privilege audit failed: ${audit.problems.join("; ")}`);
  } catch (err) {
    await gateway.close();
    throw new Error(`Operator API startup refused: ${redactText(err instanceof Error ? err.message : String(err))}`);
  }

  const timesync = opts.timesyncMarker ?? e.FLEET_OPERATOR_TIMESYNC_MARKER?.trim() ?? DEFAULT_TIMESYNC_MARKER;
  const requireTimesync = e.FLEET_OPERATOR_REQUIRE_TIMESYNC?.trim().toLowerCase() !== "false";
  let privCache: { at: number; ok: boolean } = { at: 0, ok: false };
  const service = new OperatorService({
    gateway,
    audit: createAuditSink(log, e.FLEET_OPERATOR_AUDIT_LOG?.trim() || undefined),
    runtimeFlags: () => flagsFrom(e.FLEET_RUNTIME_ENV_FILE?.trim() || DEFAULT_RUNTIME_ENV_FILE),
    readinessChecks: async () => {
      if (Date.now() - privCache.at > 60_000) privCache = { at: Date.now(), ok: (await gateway.auditOperator(schema)).ok };
      const p = await gateway.ping();
      const skewOk = Math.abs(new Date(p.dbTime).getTime() - Date.now()) <= 5_000;
      const synced = !requireTimesync || fs.existsSync(timesync);
      return { privileges: { ok: privCache.ok }, clock: { ok: skewOk && synced } };
    },
  });
  const { url } = await service.listen(listen.port, listen.host);
  log("info", "operator_api_started", { url, schemaVersion: OPERATOR_SCHEMA_VERSION });
  const close = async () => {
    await service.close();
    await gateway.close();
  };
  if (opts.installSignalHandlers) {
    const stop = () => void close().then(() => process.exit(0));
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  }
  return { service, url, close };
}

if (process.argv[1] && /fleet[\\/]operator[\\/]main\.(ts|js)$/.test(process.argv[1])) {
  const log = createJsonLogger(undefined, "automaton-fleet-operator-api");
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
    env = loadOperatorEnv().env;
  } catch (err) {
    log("fatal", "startup_failed", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
  startOperatorApiFromEnv(env, { log, installSignalHandlers: true }).catch((err) => {
    log("fatal", "startup_failed", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}

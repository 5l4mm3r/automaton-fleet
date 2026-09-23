/**
 * Fleet service entrypoint (operator-run; never started by an agent).
 *
 *   production:  systemd unit deploy/systemd/automaton-fleet.service
 *                (node dist/fleet/service/main.js as automaton-fleet-service)
 *   development: pnpm fleet:service
 *
 * Environment (see secret-files.ts for where each comes from):
 *   FLEET_SERVICE_DATABASE_URL     restricted controller role (fleet_service_login) — required
 *                                  (legacy FLEET_CONTROLLER_DATABASE_URL / DATABASE_URL accepted,
 *                                  but the schema owner is refused)
 *   FLEET_AGENT_DATABASE_URL       restricted agent role (fleet_agent_login) — required
 *   FLEET_API_LISTEN               host:port (default 127.0.0.1:8787). Loopback only, unless
 *                                  FLEET_REMOTE_LISTEN_ENABLED=true AND TLS is configured
 *   FLEET_TLS_CERT_FILE / FLEET_TLS_KEY_FILE   PEM certificate / key (key: 0600, e.g. via
 *                                  LoadCredential=tls.key -> $CREDENTIALS_DIRECTORY/tls.key)
 *   FLEET_REAPER_INTERVAL_MS       reaper period (default 15000; 0 = off)
 *   FLEET_AUDIT_LOG                optional JSONL audit file (0600)
 *   FLEET_SHUTDOWN_DRAIN_MS        graceful drain window (default 10000)
 *   FLEET_RUNTIME_REPO/_COMMIT/_BUILD_ID/_LOCKFILE_SHA256   pinned runtime release
 *   REAL_REPLICATION_ENABLED       service-level switch (default false)
 *
 * Refuses to start if: it holds the admin credential; the controller DSN is
 * the schema owner or a superuser; the agent DSN is not the restricted agent
 * role; the effective privilege audit of either restricted role fails; the
 * listen address is not loopback; or its runtime release differs from the
 * registry-approved runtime.
 */

import fs from "fs";
import { PgFleetStore } from "../postgres/store.js";
import { PgAgentGateway } from "../postgres/agent-gateway.js";
import { problemsFor } from "../postgres/privileges.js";
import { loadServiceEnv, secretFileProblems } from "../secret-files.js";
import { loadRuntimeRelease, runtimeReleaseProblem, sameRelease } from "../runtime.js";
import { FleetService, type AuditEntry, type ReadinessCheck } from "./server.js";
import { createJsonLogger, type Logger } from "./log.js";

function userOf(dsn: string): string | null {
  try {
    return decodeURIComponent(new URL(dsn).username) || null;
  } catch {
    return null;
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

/**
 * Parse FLEET_API_LISTEN. Loopback only, unless remote listening was
 * explicitly enabled AND the service serves TLS (never plain HTTP off-host).
 */
export function parseListen(value: string | undefined, opts: { remoteAllowed?: boolean } = {}): { host: string; port: number } {
  const raw = value?.trim() || "127.0.0.1:8787";
  const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(raw);
  if (!m) throw new Error(`FLEET_API_LISTEN must be host:port (got ${raw}).`);
  const host = m[1];
  const port = Number(m[2]);
  if (!LOOPBACK_HOSTS.has(host) && !opts.remoteAllowed) {
    throw new Error(
      `FLEET_API_LISTEN must be a loopback address (127.0.0.1 / ::1) unless FLEET_REMOTE_LISTEN_ENABLED=true and TLS is configured (got ${host}).`,
    );
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`FLEET_API_LISTEN port out of range: ${port}`);
  return { host: host.replace(/^\[|\]$/g, "") === "localhost" ? "127.0.0.1" : host.replace(/^\[|\]$/g, ""), port };
}

/** TLS material from FLEET_TLS_CERT_FILE / FLEET_TLS_KEY_FILE; the key must be a private (0600) regular file. */
export function loadTls(e: Record<string, string | undefined>): { cert: Buffer; key: Buffer } | null {
  const certFile = e.FLEET_TLS_CERT_FILE?.trim();
  const keyFile = e.FLEET_TLS_KEY_FILE?.trim() || (e.CREDENTIALS_DIRECTORY && certFile ? `${e.CREDENTIALS_DIRECTORY}/tls.key` : "");
  if (!certFile && !keyFile) return null;
  if (!certFile || !keyFile) throw new Error("Both FLEET_TLS_CERT_FILE and FLEET_TLS_KEY_FILE are required for TLS.");
  const problems = secretFileProblems(keyFile);
  if (problems.length) throw new Error(`Refusing TLS key: ${problems.join("; ")}`);
  return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
}

export interface StartedFleetService {
  service: FleetService;
  url: string;
  /** Graceful stop: drain, stop reaper, close pools. Idempotent. */
  stop(): Promise<void>;
}

export async function startFleetServiceFromEnv(
  e: Record<string, string | undefined>,
  opts: { log?: Logger; installSignalHandlers?: boolean } = {},
): Promise<StartedFleetService> {
  const log = opts.log ?? createJsonLogger();
  if (e.FLEET_ADMIN_DATABASE_URL?.trim()) {
    throw new Error("The fleet service must not hold FLEET_ADMIN_DATABASE_URL (admin credentials are for the operator CLI only).");
  }
  const serviceUrl = (e.FLEET_SERVICE_DATABASE_URL || e.FLEET_CONTROLLER_DATABASE_URL || e.DATABASE_URL)?.trim();
  const agentUrl = e.FLEET_AGENT_DATABASE_URL?.trim();
  if (!serviceUrl) throw new Error("FLEET_SERVICE_DATABASE_URL (restricted controller role) is not configured.");
  if (!agentUrl) throw new Error("FLEET_AGENT_DATABASE_URL (restricted agent role) is not configured.");
  if (userOf(agentUrl) === null || userOf(agentUrl) === userOf(serviceUrl)) {
    throw new Error("FLEET_AGENT_DATABASE_URL must use the restricted agent role, not the controller/admin user.");
  }
  const tls = loadTls(e);
  const remoteRequested = e.FLEET_REMOTE_LISTEN_ENABLED?.trim().toLowerCase() === "true";
  if (remoteRequested && !tls) throw new Error("FLEET_REMOTE_LISTEN_ENABLED=true requires FLEET_TLS_CERT_FILE and FLEET_TLS_KEY_FILE.");
  const listen = parseListen(e.FLEET_API_LISTEN, { remoteAllowed: remoteRequested && !!tls });
  const releaseProblem = runtimeReleaseProblem(e);
  const release = loadRuntimeRelease(e);

  const schema = e.FLEET_PG_SCHEMA?.trim() || undefined;
  const serviceRole = e.FLEET_SERVICE_ROLE?.trim() || "fleet_service";
  const agentRole = e.FLEET_AGENT_ROLE?.trim() || "fleet_agent";
  const controller = new PgFleetStore({ connectionString: serviceUrl, schema, applicationName: "automaton-fleet-service" });
  const agent = new PgAgentGateway({ connectionString: agentUrl, schema });
  const closePools = async () => {
    await agent.close();
    await controller.close();
  };

  try {
    const health = await controller.health();
    if (!health.ok) throw new Error(`Fleet registry unhealthy: ${health.error ?? "unknown"} (run pnpm fleet:migrate).`);
    const who = await controller.connectionIdentity();
    if (who.isOwner || who.superuser) {
      throw new Error(
        `FLEET_SERVICE_DATABASE_URL must use the restricted service role (fleet_service_login), not ${who.isOwner ? "the schema owner" : "a superuser"} ${who.user}.`,
      );
    }
    const agentProblems = await agent.selfCheck();
    if (agentProblems.length) throw new Error(`Agent DB role is not restricted: ${agentProblems.join("; ")}`);
    const audit = await controller.auditPrivileges({ agentRoles: [agentRole, userOf(agentUrl)!], serviceRoles: [serviceRole, who.user] });
    const privProblems = problemsFor(audit, [agentRole, userOf(agentUrl)!, serviceRole, who.user]);
    if (privProblems.length) throw new Error(`Database privileges are too broad: ${privProblems.join("; ")}`);

    const state = await controller.getState();
    const approved = state.runtime && state.build ? { ...state.runtime, ...state.build } : null;
    if (release && approved && !sameRelease(release, approved)) {
      throw new Error(
        `Runtime release mismatch: service pins ${release.repo}@${release.commit} (build ${release.buildId}) but the registry approves ` +
          `${approved.repo}@${approved.commit} (build ${approved.buildId}). Refusing to start.`,
      );
    }
    if (!release) log("warn", "runtime_release_unpinned", { reason: releaseProblem, effect: "claims and activations are refused" });

    const auditFile = e.FLEET_AUDIT_LOG?.trim();
    if (auditFile) fs.closeSync(fs.openSync(auditFile, "a", 0o600));
    const auditSink = (entry: AuditEntry) => {
      log("info", entry.event, { agentId: entry.agentId ?? null, ...entry.detail, audit: true });
      if (auditFile) fs.appendFileSync(auditFile, JSON.stringify(entry) + "\n", { mode: 0o600 });
    };

    let privCache: { at: number; problems: string[] } = { at: Date.now(), problems: [] };
    const realReplicationEnabled = e.REAL_REPLICATION_ENABLED?.trim().toLowerCase() === "true";
    const service = new FleetService({
      admin: controller,
      agent,
      realReplicationEnabled,
      reaperIntervalMs: e.FLEET_REAPER_INTERVAL_MS ? Number(e.FLEET_REAPER_INTERVAL_MS) : undefined,
      drainMs: e.FLEET_SHUTDOWN_DRAIN_MS ? Number(e.FLEET_SHUTDOWN_DRAIN_MS) : undefined,
      audit: auditSink,
      release,
      tls: tls ?? undefined,
      readinessChecks: async (): Promise<Record<string, ReadinessCheck>> => {
        if (Date.now() - privCache.at > 60_000) {
          const a = await controller.auditPrivileges({ agentRoles: [agentRole, userOf(agentUrl)!], serviceRoles: [serviceRole, who.user] });
          privCache = { at: Date.now(), problems: problemsFor(a, [agentRole, userOf(agentUrl)!, serviceRole, who.user]) };
        }
        return { privileges: privCache.problems.length ? { ok: false, detail: privCache.problems.join("; ") } : { ok: true } };
      },
    });
    const { url } = await service.listen(listen.port, listen.host);
    service.startReaper();
    log("info", "service_started", {
      url,
      dbUser: who.user,
      realReplicationEnabled,
      runtimeRelease: release ? `${release.repo}@${release.commit}` : null,
      pid: process.pid,
    });

    let stopping: Promise<void> | null = null;
    const stop = () =>
      (stopping ??= (async () => {
        log("info", "shutdown_started", {});
        await service.close();
        await closePools();
        log("info", "shutdown_complete", {});
      })());

    if (opts.installSignalHandlers) {
      let signals = 0;
      const onSignal = (sig: string) => {
        signals++;
        if (signals > 1) {
          log("warn", "shutdown_forced", { signal: sig });
          process.exit(1);
        }
        void stop().then(
          () => process.exit(0),
          (err) => {
            log("error", "shutdown_failed", { error: err instanceof Error ? err.message : String(err) });
            process.exit(1);
          },
        );
      };
      process.on("SIGTERM", () => onSignal("SIGTERM"));
      process.on("SIGINT", () => onSignal("SIGINT"));
    }
    return { service, url, stop };
  } catch (err) {
    await closePools();
    throw err;
  }
}

if (process.argv[1] && /fleet[\\/]service[\\/]main\.(ts|js)$/.test(process.argv[1])) {
  const log = createJsonLogger();
  process.on("uncaughtException", (err) => {
    log("fatal", "uncaught_exception", { error: err.message });
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    log("fatal", "unhandled_rejection", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
  let loaded;
  try {
    loaded = loadServiceEnv();
  } catch (err) {
    log("fatal", "startup_failed", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
  for (const w of loaded.warnings) log("warn", "config_warning", { warning: w });
  startFleetServiceFromEnv(loaded.env, { log, installSignalHandlers: true }).catch((err) => {
    log("fatal", "startup_failed", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}

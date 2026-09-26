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
 *   FLEET_TLS_CERT_FILE / FLEET_TLS_KEY_FILE   PEM certificate / key. Production sets only the
 *                                  cert (/run/credentials/automaton-fleet.service/tls.crt) and the
 *                                  key comes from LoadCredential=tls.key (verified systemd credential,
 *                                  0440 allowed). An explicit FLEET_TLS_KEY_FILE must be strictly 0600.
 *   Phase 6 remote controller (all required together; remote exposure stays OFF by default):
 *   FLEET_REMOTE_LISTEN_ENABLED    "true" to serve remote children
 *   FLEET_PUBLIC_HOSTNAME          DNS name children connect to; the certificate must cover it
 *   FLEET_PUBLIC_LISTEN            HTTPS bind address, e.g. 0.0.0.0:8443. FLEET_API_LISTEN then
 *                                  stays a loopback plain-HTTP listener for local administration
 *   FLEET_ALLOWED_ORIGINS          comma-separated browser origins (default: none)
 *   FLEET_SERVICE_EXPECTED_USER    OS user the service must run as (systemd: automaton-fleet-service)
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

import crypto from "crypto";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { PgFleetStore } from "../postgres/store.js";
import { PgAgentGateway } from "../postgres/agent-gateway.js";
import { problemsFor } from "../postgres/privileges.js";
import {
  DEFAULT_TLS_KEY_FILE,
  SYSTEMD_SECRET_CREDENTIALS,
  TLS_KEY_CREDENTIAL,
  loadServiceEnv,
  secretFileProblems,
  systemdCredentialProblems,
  type SystemdCredentialHost,
} from "../secret-files.js";
import { loadRuntimeRelease, runtimeReleaseProblem, sameRelease } from "../runtime.js";
import { FleetService, type AuditEntry, type ReadinessCheck } from "./server.js";
import { OpenAICompatibleProvider, ScriptedProvider } from "../cognition/providers.js";
import type { CognitionProvider } from "../cognition/types.js";
import { createAuditSink, createJsonLogger, type Logger } from "./log.js";

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

/**
 * TLS material from FLEET_TLS_CERT_FILE and the key. The key is either an
 * explicit FLEET_TLS_KEY_FILE (strict secretFileProblems: 0600, even inside
 * CREDENTIALS_DIRECTORY) or, when that is unset, the systemd credential
 * $CREDENTIALS_DIRECTORY/tls.key, validated by systemdCredentialProblems
 * (exact path and unit, no symlink/hard link, 0440 at most, source root 0600).
 */
export function loadTls(
  e: Record<string, string | undefined>,
  systemd: { host?: SystemdCredentialHost; sourceFile?: string } = {},
): { cert: Buffer; key: Buffer } | null {
  const certFile = e.FLEET_TLS_CERT_FILE?.trim();
  const explicitKey = e.FLEET_TLS_KEY_FILE?.trim();
  const credDir = e.CREDENTIALS_DIRECTORY?.trim();
  const keyFile = explicitKey || (credDir && certFile ? path.join(credDir, TLS_KEY_CREDENTIAL) : "");
  if (!certFile && !keyFile) return null;
  if (!certFile || !keyFile) throw new Error("Both FLEET_TLS_CERT_FILE and FLEET_TLS_KEY_FILE are required for TLS.");
  // The certificate is public; it must never name a secret (credential copy or its source).
  if (credDir && Object.keys(SYSTEMD_SECRET_CREDENTIALS).some((n) => path.resolve(certFile) === path.resolve(credDir, n))) {
    throw new Error(`Refusing TLS certificate: ${certFile} is a secret credential.`);
  }
  if (Object.values(SYSTEMD_SECRET_CREDENTIALS).includes(path.resolve(certFile))) {
    throw new Error(`Refusing TLS certificate: ${certFile} is a secret file.`);
  }
  const problems = explicitKey
    ? secretFileProblems(keyFile)
    : systemdCredentialProblems(keyFile, TLS_KEY_CREDENTIAL, credDir, systemd.sourceFile ?? DEFAULT_TLS_KEY_FILE, systemd.host);
  if (problems.length) throw new Error(`Refusing TLS key: ${problems.join("; ")}`);
  return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
}

/**
 * Phase 6: the certificate must be usable for the public hostname right
 * now: it covers the hostname, is inside its validity window (with at least
 * a day left) and matches the private key.
 */
export function tlsProblemsForHost(tls: { cert: Buffer | string; key: Buffer | string }, hostname: string, now = Date.now()): string[] {
  const problems: string[] = [];
  let x509: crypto.X509Certificate;
  try {
    x509 = new crypto.X509Certificate(tls.cert);
  } catch (err) {
    return [`certificate unreadable: ${err instanceof Error ? err.message : String(err)}`];
  }
  if (!(net.isIP(hostname) ? x509.checkIP(hostname) : x509.checkHost(hostname))) problems.push(`certificate does not cover ${hostname}`);
  if (Date.parse(x509.validFrom) > now) problems.push(`certificate not valid before ${x509.validFrom}`);
  if (Date.parse(x509.validTo) < now + 86_400_000) problems.push(`certificate expires ${x509.validTo}`);
  try {
    if (!x509.checkPrivateKey(crypto.createPrivateKey(tls.key))) problems.push("private key does not match the certificate");
  } catch {
    problems.push("private key unreadable");
  }
  return problems;
}

const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export interface RemoteConfig {
  hostname: string;
  publicListen: { host: string; port: number } | null;
  allowedOrigins: string[];
}

/** Phase 6 remote-controller configuration; throws on any unsafe combination. */
export function loadRemoteConfig(e: Record<string, string | undefined>, tls: { cert: Buffer | string; key: Buffer | string } | null): RemoteConfig | null {
  const remote = e.FLEET_REMOTE_LISTEN_ENABLED?.trim().toLowerCase() === "true";
  const publicListenRaw = e.FLEET_PUBLIC_LISTEN?.trim();
  const origins = (e.FLEET_ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  for (const o of origins) {
    if (!/^https:\/\/[^/\s]+$/.test(o)) throw new Error(`FLEET_ALLOWED_ORIGINS entries must be https origins (got ${o}).`);
  }
  if (!remote) {
    if (publicListenRaw) throw new Error("FLEET_PUBLIC_LISTEN requires FLEET_REMOTE_LISTEN_ENABLED=true.");
    return null;
  }
  if (!tls) throw new Error("FLEET_REMOTE_LISTEN_ENABLED=true requires FLEET_TLS_CERT_FILE and FLEET_TLS_KEY_FILE.");
  const hostname = e.FLEET_PUBLIC_HOSTNAME?.trim() ?? "";
  if (!HOSTNAME_RE.test(hostname)) throw new Error("FLEET_REMOTE_LISTEN_ENABLED=true requires FLEET_PUBLIC_HOSTNAME (a DNS name).");
  const problems = tlsProblemsForHost(tls, hostname);
  if (problems.length) throw new Error(`Refusing remote listener: ${problems.join("; ")}`);
  return { hostname, publicListen: publicListenRaw ? parseListen(publicListenRaw, { remoteAllowed: true }) : null, allowedOrigins: origins };
}

/**
 * Phase F.2 (hardened L1–L8): the controller's inference provider (founders never hold one).
 * Unset / "none" (the production default) → no provider: every inference is refused.
 * "scripted" is the deterministic, credential-free rehearsal model.
 * "openai_compatible" needs FLEET_COGNITION_BASE_URL, FLEET_COGNITION_MODEL and FLEET_COGNITION_API_KEY_FILE
 * (a regular 0600 file owned by this service's own uid, one line, no whitespace; its content is never logged).
 * Optional: FLEET_COGNITION_MAX_TOKENS_PARAM (max_tokens | max_completion_tokens), FLEET_COGNITION_ATTEMPT_TIMEOUT_MS
 * (5 s–240 s, default 90 s), FLEET_COGNITION_DEADLINE_MS (10 s–240 s, default 120 s; covers all attempts),
 * FLEET_COGNITION_MAX_ATTEMPTS (1–3, default 3; only unprocessed failures are retried).
 * The registry's owner switch must also name the same provider AND model.
 */
export interface CognitionConfig {
  provider: CognitionProvider | null;
  deadlineMs: number;
}

function boundedInt(e: Record<string, string | undefined>, key: string, min: number, max: number, dflt: number): number {
  const raw = e[key]?.trim();
  if (!raw) return dflt;
  if (!/^\d{1,7}$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new Error(`${key} must be an integer between ${min} and ${max}.`);
  return Number(raw);
}

/** Validate an inference credential file without ever printing its content. */
export function readCognitionKey(file: string, uid: number | null = process.getuid?.() ?? null): string {
  if (!path.isAbsolute(file)) throw new Error("FLEET_COGNITION_API_KEY_FILE must be an absolute path.");
  const problems = secretFileProblems(file);
  if (problems.length) throw new Error(`Refusing the inference credential: ${problems.join("; ")}`);
  const st = fs.statSync(file);
  if (uid !== null && st.uid !== uid) throw new Error("Refusing the inference credential: it must be owned by the fleet service user.");
  if (st.size === 0 || st.size > 1024) throw new Error("Refusing the inference credential: unexpected size.");
  const key = fs.readFileSync(file, "utf8").replace(/\r?\n$/, "");
  if (!/^[\x21-\x7e]{8,512}$/.test(key)) throw new Error("Refusing the inference credential: it must be one line of 8–512 printable characters without spaces.");
  return key;
}

export function loadCognitionProvider(e: Record<string, string | undefined>, uid: number | null = process.getuid?.() ?? null): CognitionConfig {
  const id = e.FLEET_COGNITION_PROVIDER?.trim() || "none";
  const deadlineMs = boundedInt(e, "FLEET_COGNITION_DEADLINE_MS", 10_000, 240_000, 120_000);
  if (id === "none") return { provider: null, deadlineMs };
  if (id === "scripted") return { provider: new ScriptedProvider(e.FLEET_COGNITION_MODEL?.trim() || undefined), deadlineMs };
  if (id !== "openai_compatible") throw new Error(`FLEET_COGNITION_PROVIDER must be none, scripted or openai_compatible (got ${id}).`);
  const baseUrl = e.FLEET_COGNITION_BASE_URL?.trim() ?? "";
  const model = e.FLEET_COGNITION_MODEL?.trim() ?? "";
  const keyFile = e.FLEET_COGNITION_API_KEY_FILE?.trim() ?? "";
  if (!baseUrl || !model || !keyFile) throw new Error("FLEET_COGNITION_PROVIDER=openai_compatible requires FLEET_COGNITION_BASE_URL, FLEET_COGNITION_MODEL and FLEET_COGNITION_API_KEY_FILE.");
  const param = e.FLEET_COGNITION_MAX_TOKENS_PARAM?.trim() || "max_tokens";
  if (param !== "max_tokens" && param !== "max_completion_tokens") throw new Error("FLEET_COGNITION_MAX_TOKENS_PARAM must be max_tokens or max_completion_tokens.");
  const attemptTimeoutMs = boundedInt(e, "FLEET_COGNITION_ATTEMPT_TIMEOUT_MS", 5_000, 240_000, 90_000);
  const maxAttempts = boundedInt(e, "FLEET_COGNITION_MAX_ATTEMPTS", 1, 3, 3);
  return {
    provider: new OpenAICompatibleProvider({ baseUrl, apiKey: readCognitionKey(keyFile, uid), model, maxTokensParam: param, attemptTimeoutMs, maxAttempts }),
    deadlineMs,
  };
}

/** Refuse to run as root, or as anyone but the expected dedicated service user. */
export function serviceUserProblem(e: Record<string, string | undefined>, who: { uid: number; username: string } = currentUser()): string | null {
  if (who.uid === 0) return "The fleet service must not run as root.";
  const expected = e.FLEET_SERVICE_EXPECTED_USER?.trim();
  if (expected && who.username !== expected) return `The fleet service must run as ${expected} (running as ${who.username}).`;
  return null;
}

function currentUser(): { uid: number; username: string } {
  const u = os.userInfo();
  return { uid: u.uid, username: u.username };
}

export interface StartedFleetService {
  service: FleetService;
  url: string;
  /** Phase 6: https://<FLEET_PUBLIC_HOSTNAME>:<port> when the remote listener is enabled. */
  publicUrl?: string | null;
  /** Graceful stop: drain, stop reaper, close pools. Idempotent. */
  stop(): Promise<void>;
}

export async function startFleetServiceFromEnv(
  e: Record<string, string | undefined>,
  opts: { log?: Logger; installSignalHandlers?: boolean; user?: { uid: number; username: string } } = {},
): Promise<StartedFleetService> {
  const log = opts.log ?? createJsonLogger();
  const userProblem = serviceUserProblem(e, opts.user);
  if (userProblem) throw new Error(userProblem);
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
  const remote = loadRemoteConfig(e, tls);
  // With a separate public HTTPS listener, FLEET_API_LISTEN is the loopback plain-HTTP admin listener.
  const listen = parseListen(e.FLEET_API_LISTEN, { remoteAllowed: remoteRequested && !!tls && !remote?.publicListen });
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

    const auditSink: (entry: AuditEntry) => void = createAuditSink(log, e.FLEET_AUDIT_LOG?.trim() || undefined);

    let privCache: { at: number; problems: string[] } = { at: Date.now(), problems: [] };
    const realReplicationEnabled = e.REAL_REPLICATION_ENABLED?.trim().toLowerCase() === "true";
    const cognition = loadCognitionProvider(e);
    const cognitionProvider = cognition.provider;
    const service = new FleetService({
      cognitionProvider,
      cognitionDeadlineMs: cognition.deadlineMs,
      admin: controller,
      agent,
      realReplicationEnabled,
      reaperIntervalMs: e.FLEET_REAPER_INTERVAL_MS ? Number(e.FLEET_REAPER_INTERVAL_MS) : undefined,
      drainMs: e.FLEET_SHUTDOWN_DRAIN_MS ? Number(e.FLEET_SHUTDOWN_DRAIN_MS) : undefined,
      audit: auditSink,
      release,
      tls: tls ?? undefined,
      allowedOrigins: remote?.allowedOrigins ?? [],
      readinessChecks: async (): Promise<Record<string, ReadinessCheck>> => {
        if (Date.now() - privCache.at > 60_000) {
          const a = await controller.auditPrivileges({ agentRoles: [agentRole, userOf(agentUrl)!], serviceRoles: [serviceRole, who.user] });
          privCache = { at: Date.now(), problems: problemsFor(a, [agentRole, userOf(agentUrl)!, serviceRole, who.user]) };
        }
        return { privileges: privCache.problems.length ? { ok: false, detail: privCache.problems.join("; ") } : { ok: true } };
      },
    });
    let url: string;
    let publicUrl: string | null = null;
    if (remote?.publicListen) {
      url = (await service.listenAdmin(listen.port, listen.host)).url;
      const pub = await service.listen(remote.publicListen.port, remote.publicListen.host);
      publicUrl = `https://${remote.hostname}:${pub.port}`;
    } else {
      url = (await service.listen(listen.port, listen.host)).url;
    }
    service.startReaper();
    log("info", "service_started", {
      url,
      publicUrl,
      dbUser: who.user,
      realReplicationEnabled,
      cognitionProvider: cognitionProvider ? `${cognitionProvider.id}:${cognitionProvider.model}` : "none",
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
    return { service, url, publicUrl, stop };
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

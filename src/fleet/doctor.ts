/**
 * Deployment readiness doctor (Phase 4)
 *
 *   pnpm fleet:doctor [--json] [--deployment-only]
 *
 * Reports database connectivity, schema version, effective privileges, the
 * fleet service's readiness, the pinned runtime, the safety flags, the fleet
 * population, stale agents/reservations, unterminated sandboxes and security
 * warnings.
 *
 * Two verdicts:
 *   deployment        the control plane is correctly deployed (DB, roles,
 *                     privileges, service, secrets, flags off)
 *   real replication  SAFE only if the deployment is OK AND no blocker
 *                     remains. Any blocker => UNSAFE and exit code 1.
 * `--deployment-only` exits 0 when the deployment verdict is OK even though
 * real replication is (correctly) still unsafe — for monitoring.
 *
 * Phase 6 adds the operator checklist (`pnpm fleet:verify`) and three
 * INDEPENDENT readiness levels, each with its own blocker list:
 *   SAFE FOR DRY RUN            the first remote child may be provisioned with zero authority
 *   SAFE FOR REAL REPLICATION   REAL_REPLICATION_ENABLED may be turned on
 *   SAFE FOR REAL PAYMENTS      REAL_PAYMENTS_ENABLED may be turned on
 * None of them ever enables anything.
 */

import { execFile } from "child_process";
import crypto from "crypto";
import fs from "fs";
import net from "net";
import path from "path";
import { FLEET_PG_SCHEMA_VERSION } from "./postgres/migrations.js";
import type { PgFleetStore } from "./postgres/store.js";
import { loadRuntimeRelease, runtimeReleaseProblem, sameRelease } from "./runtime.js";
import { auditLevel } from "./operator/responses.js";
import {
  CONTROLLER_SECRET_KEYS,
  DEFAULT_ADMIN_ENV_FILE,
  DEFAULT_SERVICE_ENV_FILE,
  FLEET_ETC_DIR,
  FLEET_SYSTEMD_UNIT,
  LEGACY_ENV_FILE,
  SYSTEMD_CREDENTIALS_ROOT,
  TLS_CERT_CREDENTIAL,
  readEnvFile,
  secretFileProblems,
} from "./secret-files.js";

export type CheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface ReadinessLevel {
  safe: boolean;
  blockers: string[];
}

export interface ChecklistItem {
  item: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  deploymentOk: boolean;
  replicationSafe: boolean;
  /** Phase 6: independent readiness levels. */
  readiness: { dryRun: ReadinessLevel; realReplication: ReadinessLevel; realPayments: ReadinessLevel };
  /** Phase 6: operator verification checklist. */
  checklist: ChecklistItem[];
  checks: DoctorCheck[];
  blockers: string[];
  securityWarnings: string[];
  facts: Record<string, unknown>;
}

export interface DoctorDeps {
  env: Record<string, string | undefined>;
  /** Registry store (admin or service credential); null = not configured. */
  store: PgFleetStore | null;
  /** Error raised while loading configuration (e.g. unreadable secret file). */
  configError?: string | null;
  fetchImpl?: typeof fetch;
  /** Filesystem locations (overridable for tests). */
  paths?: {
    cwd?: string;
    etcDir?: string;
    adminEnv?: string;
    serviceEnv?: string;
    passwd?: string;
    group?: string;
    systemdUnit?: string;
    /** Filesystem holding the audit logs (disk-usage check). */
    logDir?: string;
  };
  /** Sandbox termination is guaranteed by the deployed terminator (default false: Conway cannot stop sandboxes). */
  sandboxTerminationGuaranteed?: boolean;
  /** `systemctl is-active` of the fleet unit (default: runs systemctl; null = unknown). */
  serviceActive?: () => Promise<string | null>;
  /** A controller custody signer exists for live payments (default false: none is implemented). */
  custodySignerAvailable?: boolean;
}

/** Can OS user `user` read `file`, judged from its mode bits and /etc/passwd + /etc/group? */
export function osUserCanRead(file: string, user: string, passwdFile = "/etc/passwd", groupFile = "/etc/group"): boolean | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  let uid: number | null = null;
  let gid: number | null = null;
  try {
    for (const line of fs.readFileSync(passwdFile, "utf8").split("\n")) {
      const f = line.split(":");
      if (f[0] === user) {
        uid = Number(f[2]);
        gid = Number(f[3]);
      }
    }
  } catch {
    return null;
  }
  if (uid === null) return false;
  if (uid === 0) return true;
  const gids = new Set<number>([gid!]);
  try {
    for (const line of fs.readFileSync(groupFile, "utf8").split("\n")) {
      const f = line.split(":");
      if (f.length >= 4 && f[3].split(",").includes(user)) gids.add(Number(f[2]));
    }
  } catch {
    // primary group only
  }
  const m = st.mode;
  if (st.uid === uid) return (m & 0o400) !== 0;
  if (gids.has(st.gid)) return (m & 0o040) !== 0;
  return (m & 0o004) !== 0;
}

/** Certificate problems for the public hostname (the key may be unreadable to the operator; it is checked at service start). */
export function certificateProblems(certFile: string, hostname: string, now = Date.now()): string[] {
  let x509: crypto.X509Certificate;
  try {
    x509 = new crypto.X509Certificate(fs.readFileSync(certFile));
  } catch (err) {
    return [`certificate ${certFile} unreadable (${err instanceof Error ? err.message : String(err)})`];
  }
  const problems: string[] = [];
  if (!(net.isIP(hostname) ? x509.checkIP(hostname) : x509.checkHost(hostname))) problems.push(`certificate does not cover ${hostname}`);
  if (Date.parse(x509.validFrom) > now) problems.push(`certificate not yet valid (${x509.validFrom})`);
  if (Date.parse(x509.validTo) < now + 86_400_000) problems.push(`certificate expires ${x509.validTo}`);
  return problems;
}

function defaultServiceActive(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("systemctl", ["is-active", "automaton-fleet.service"], { timeout: 5000 }, (_err, stdout) => resolve(stdout?.trim() || null));
  });
}

/** Unauthenticated probes that must be refused: long-lived bearer outside /v1/session, stale signed request. */
async function replayProbes(apiUrl: string, fetchImpl: typeof fetch): Promise<{ sessionOnly: boolean; staleRefused: boolean; detail: string }> {
  const post = (headers: Record<string, string>) =>
    fetchImpl(`${apiUrl}/v1/heartbeat`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}", signal: AbortSignal.timeout(3000) })
      .then(async (r) => ({ status: r.status, code: ((await r.json().catch(() => ({}))) as { code?: string }).code ?? "" }))
      .catch(() => ({ status: 0, code: "unreachable" }));
  const probeId = "01" + "0".repeat(24);
  const bearer = await post({ authorization: `Bearer fa1.${probeId}.${"A".repeat(43)}` });
  const stale = await post({
    authorization: `FleetSession fs1.${probeId}.${"A".repeat(43)}`,
    "x-fleet-timestamp": String(Date.now() - 3_600_000),
    "x-fleet-nonce": "doctor-probe-" + crypto.randomBytes(8).toString("hex"),
    "x-fleet-signature": "0".repeat(64),
  });
  return {
    sessionOnly: bearer.status === 401 && bearer.code === "FLEET_SESSION_REQUIRED",
    staleRefused: stale.status === 401 && stale.code === "FLEET_REQUEST_STALE",
    detail: `bearer -> ${bearer.status} ${bearer.code}; stale signed request -> ${stale.status} ${stale.code}`,
  };
}

export const FLEET_SERVICE_USER = "automaton-fleet-service";
export const FLEET_AGENT_USER = "automaton-agent";
export const FLEET_ADMIN_GROUP = "automaton-fleet-admin";
export const SYSTEMD_UNIT_PATH = "/etc/systemd/system/automaton-fleet.service";

function flag(v: string | undefined): boolean {
  return v?.trim().toLowerCase() === "true";
}

function namesIn(file: string): Set<string> {
  try {
    return new Set(fs.readFileSync(file, "utf8").split("\n").map((l) => l.split(":")[0]).filter(Boolean));
  } catch {
    return new Set();
  }
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const { env, store } = deps;
  const p = deps.paths ?? {};
  const cwd = p.cwd ?? process.cwd();
  const checks: DoctorCheck[] = [];
  const blockers: string[] = [];
  const securityWarnings: string[] = [];
  const facts: Record<string, unknown> = {};
  const add = (name: string, status: CheckStatus, detail: string) => checks.push({ name, status, detail });

  if (deps.configError) add("configuration", "fail", deps.configError);

  // ── Safety flags (must all be false in this phase)
  const flags = {
    REAL_REPLICATION_ENABLED: flag(env.REAL_REPLICATION_ENABLED),
    REAL_PAYMENTS_ENABLED: flag(env.REAL_PAYMENTS_ENABLED),
    OWNER_SWEEP_ENABLED: flag(env.OWNER_SWEEP_ENABLED),
  };
  facts.replicationEnabled = flags.REAL_REPLICATION_ENABLED;
  facts.paymentsEnabled = flags.REAL_PAYMENTS_ENABLED;
  facts.ownerSweepEnabled = flags.OWNER_SWEEP_ENABLED;
  for (const [k, v] of Object.entries(flags)) {
    add(`flag ${k}`, v ? "fail" : "pass", v ? "ENABLED — must remain false until explicitly approved" : "disabled");
  }

  // ── Database
  let dbOk = false;
  if (!store) {
    add("database connectivity", "fail", "no registry credential configured (FLEET_ADMIN_DATABASE_URL or FLEET_SERVICE_DATABASE_URL)");
    blockers.push("Fleet registry database is not reachable/configured.");
  } else {
    const h = await store.health();
    facts.schemaVersion = h.schemaVersion;
    if (h.latencyMs === null && h.schemaVersion === null) {
      add("database connectivity", "fail", h.error ?? "unreachable");
      blockers.push("Fleet registry database is not reachable.");
    } else {
      add("database connectivity", "pass", `reachable (${h.latencyMs ?? "?"} ms)`);
      const vOk = h.schemaVersion === FLEET_PG_SCHEMA_VERSION;
      add("schema version", vOk ? "pass" : "fail", `v${h.schemaVersion ?? "none"} (required v${FLEET_PG_SCHEMA_VERSION})`);
      if (!vOk) blockers.push(`Registry schema is v${h.schemaVersion ?? "none"}; run the approved migration to v${FLEET_PG_SCHEMA_VERSION}.`);
      if (vOk) {
        add("registry counters", h.countersConsistent ? "pass" : "fail", h.countersConsistent ? "consistent" : "fleet_state counters disagree with fleet_agents");
        dbOk = h.ok;
      }
    }
  }

  let approved: { repo: string; commit: string; buildId: string; lockfileSha256: string } | null = null;
  if (store && dbOk) {
    try {
      const who = await store.connectionIdentity();
      facts.doctorDbUser = who.user;
      const audit = await store.auditPrivileges();
      facts.privilegeProblems = audit.problems;
      facts.operatorRoles = audit.operatorRoles;
      const roleText = audit.operatorRoles === "not_provisioned" ? "agent/service roles least-privilege; operator roles: not provisioned" : "agent/service/operator roles least-privilege";
      add("database privileges", audit.ok ? "pass" : "fail", audit.ok ? `${roleText}; operator surface read-only; PUBLIC has nothing` : audit.problems.join("; "));
      if (!audit.ok) blockers.push("Database privileges are too broad or roles are missing (pnpm fleet:audit-privileges).");

      const st = await store.getState();
      const stale = await store.staleness();
      const timeouts = await store.getTimeouts();
      approved = st.runtime && st.build ? { ...st.runtime, ...st.build } : null;
      Object.assign(facts, {
        fleetMaximum: st.maxAgents,
        livingAgents: st.livingAgents,
        reservedSlots: st.reservedSlots,
        operatingMode: st.operatingMode,
        dbReplicationSwitch: st.replicationEnabled,
        staleAgents: stale.staleAgents,
        unresponsiveAgents: stale.unresponsive,
        staleReservations: stale.staleReservations,
        openReservations: stale.openReservations,
        unterminatedSandboxes: stale.unterminatedSandboxes,
        reaperLastRunAt: stale.reaperLastRunAt,
        openOrphans: stale.openOrphans,
        provisioningNeedingCleanup: stale.provisioningNeedingCleanup,
        quarantinedAgents: stale.quarantined,
        terminatingAgents: stale.terminating,
        quarantinedSlots: st.quarantinedSlots ?? 0,
        uncertainProvisioning: stale.uncertainProvisioning,
        dryRunChildren: stale.dryRunChildren,
        dryRunProven: stale.dryRunProven,
        timeouts,
      });
      add("fleet population", "pass", `${st.livingAgents} living + ${st.reservedSlots} reserved / max ${st.maxAgents} (mode ${st.operatingMode})`);
      add("DB replication switch", st.replicationEnabled ? "warn" : "pass", st.replicationEnabled ? "ON in registry" : "off");
      add("stale agents", stale.staleAgents ? "warn" : "pass", `${stale.staleAgents} past heartbeat timeout, ${stale.unresponsive} unresponsive`);
      add("stale reservations", stale.staleReservations ? "warn" : "pass", `${stale.staleReservations} expired but not yet reaped (${stale.openReservations} open)`);
      const reaperAgeS = stale.reaperLastRunAt ? (Date.now() - Date.parse(stale.reaperLastRunAt)) / 1000 : null;
      add("reaper", reaperAgeS !== null && reaperAgeS < 120 ? "pass" : "warn",
        reaperAgeS === null ? "has never run" : `last pass ${Math.round(reaperAgeS)} s ago`);
      if (stale.unterminatedSandboxes) {
        add("zombie sandboxes", "warn", `${stale.unterminatedSandboxes} dead agents' sandboxes not confirmed terminated`);
      }
      add("orphaned infrastructure", stale.openOrphans ? "warn" : "pass",
        `${stale.openOrphans} unresolved orphan(s); ${stale.quarantined} agent(s) holding quarantine slots; ${stale.provisioningNeedingCleanup} provisioning record(s) awaiting cleanup`);
      if (stale.openOrphans) blockers.push(`${stale.openOrphans} orphaned sandbox(es) unresolved (fleet:admin orphans / resolve-orphan).`);
      add("uncertain provisioning", stale.uncertainProvisioning ? "warn" : "pass",
        `${stale.uncertainProvisioning} attempt(s) whose sandbox may exist but was never identified (fleet:admin reconcile-provisioning)`);
      if (stale.uncertainProvisioning) blockers.push(`${stale.uncertainProvisioning} provisioning attempt(s) with an unreconciled sandbox outcome.`);
    } catch (err) {
      add("registry state", "fail", err instanceof Error ? err.message : String(err));
    }

    // ── Operator API (schema v8). Detailed checks only: the 16-item operator
    // checklist (and its 16/16 meaning) is deliberately unchanged (B2 F10).
    const ov = await store.operatorOverview();
    facts.operatorApi = ov;
    if (ov) {
      const lvl = auditLevel(ov.requestCount, ov.requestCap);
      const pct = ov.requestCap > 0 ? ((ov.requestCount / ov.requestCap) * 100).toFixed(1) : "?";
      add(
        "operator audit capacity",
        lvl === "full" ? "fail" : lvl === "ok" ? "pass" : "warn",
        `${ov.requestCount}/${ov.requestCap} request rows (${pct}%)` +
          (lvl === "info" ? " — early warning (>= 50%): plan an archive (fleet:admin operator-archive)"
            : lvl === "elevated" ? " — ELEVATED (>= 75%): archive soon"
            : lvl === "full" ? " — FULL: the Operator API fails closed (FLEET_OP_AUDIT_FULL); archive required" : ""),
      );
      add("operator kill switch", "pass", ov.enabled ? `enabled (generation ${ov.generation})` : `disabled (generation ${ov.generation}); the Operator API refuses every request`);
      add(
        "operator principals",
        ov.keysExpiringSoon ? "warn" : "pass",
        `${ov.activePrincipals} active principal(s), ${ov.activeKeys} active key(s)` + (ov.keysExpiringSoon ? `; ${ov.keysExpiringSoon} key(s) expire within 14 days` : ""),
      );
      add("operator denials", ov.recentDenials > 20 ? "warn" : "pass", `${ov.recentDenials} denied operator request(s) in the last 10 minutes`);
    }
  }

  // ── Log/audit disk usage (D-9): warn at 80% used, fail at 95%.
  try {
    const sf = fs.statfsSync(deps.paths?.logDir ?? "/var/log");
    const usedPct = sf.blocks > 0 ? (1 - sf.bavail / sf.blocks) * 100 : 0;
    facts.logDiskUsedPct = Math.round(usedPct * 10) / 10;
    add("log disk usage", usedPct >= 95 ? "fail" : usedPct >= 80 ? "warn" : "pass", `${usedPct.toFixed(1)}% used on the filesystem holding ${deps.paths?.logDir ?? "/var/log"}`);
  } catch {
    add("log disk usage", "warn", "could not inspect the log filesystem");
  }

  // ── Runtime release
  const release = loadRuntimeRelease(env);
  facts.runtimeRepo = env.FLEET_RUNTIME_REPO ?? null;
  facts.runtimeCommit = env.FLEET_RUNTIME_COMMIT ?? null;
  facts.runtimeBuildId = env.FLEET_RUNTIME_BUILD_ID ?? null;
  facts.approvedRuntime = approved;
  const relProblem = runtimeReleaseProblem(env);
  if (relProblem) {
    add("runtime release", "warn", relProblem);
    blockers.push(`No pinned runtime release: ${relProblem}`);
  } else {
    add("runtime release", "pass", `${release!.repo}@${release!.commit} build ${release!.buildId.slice(0, 16)}…`);
  }
  if (store && dbOk) {
    if (!approved) {
      add("approved runtime", "warn", "registry has no approved runtime (replication impossible)");
      blockers.push("No runtime approved in the registry (fleet:admin approve-runtime).");
    } else if (release && !sameRelease(release, approved)) {
      add("approved runtime", "fail", `registry approves ${approved.commit}/${approved.buildId.slice(0, 12)}, release pins ${release.commit}/${release.buildId.slice(0, 12)}`);
      blockers.push("Pinned runtime release differs from the registry-approved runtime.");
    } else {
      add("approved runtime", "pass", `${approved.repo}@${approved.commit}`);
    }
  }

  // ── Fleet service
  const apiUrl = (env.FLEET_API_URL?.trim() || "http://127.0.0.1:8787").replace(/\/+$/, "");
  facts.serviceUrl = apiUrl;
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${apiUrl}/readyz`, { signal: AbortSignal.timeout(3000) });
    const body = (await res.json().catch(() => ({}))) as { ready?: boolean; checks?: Record<string, { ok: boolean; warn?: boolean; detail?: string }>; realReplicationEnabled?: boolean };
    facts.serviceState = body.ready ? "ready" : "not ready";
    facts.serviceReplicationEnabled = body.realReplicationEnabled ?? null;
    const failing = Object.entries(body.checks ?? {}).filter(([, c]) => !c.ok).map(([k, c]) => `${k}: ${c.detail ?? "failed"}`);
    add("fleet service", body.ready ? "pass" : "fail", body.ready ? `ready at ${apiUrl}` : `not ready: ${failing.join("; ") || res.status}`);
    if (body.realReplicationEnabled) add("service REAL_REPLICATION_ENABLED", "fail", "service reports replication enabled");
    if (!body.ready) blockers.push("Fleet service is not ready.");
  } catch (err) {
    facts.serviceState = "unavailable";
    add("fleet service", "fail", `unavailable at ${apiUrl} (${err instanceof Error ? err.message : String(err)})`);
    blockers.push("Fleet service is not running.");
  }

  // ── OS isolation and secrets
  const users = namesIn(p.passwd ?? "/etc/passwd");
  const groups = namesIn(p.group ?? "/etc/group");
  for (const u of [FLEET_SERVICE_USER, FLEET_AGENT_USER]) {
    const ok = users.has(u);
    add(`os user ${u}`, ok ? "pass" : "fail", ok ? "exists" : "missing");
    if (!ok) blockers.push(`OS user ${u} does not exist (OS isolation not set up).`);
  }
  if (!groups.has(FLEET_ADMIN_GROUP)) {
    add(`os group ${FLEET_ADMIN_GROUP}`, "fail", "missing");
    blockers.push(`OS group ${FLEET_ADMIN_GROUP} does not exist.`);
  } else add(`os group ${FLEET_ADMIN_GROUP}`, "pass", "exists");

  const etc = p.etcDir ?? FLEET_ETC_DIR;
  const adminEnv = p.adminEnv ?? DEFAULT_ADMIN_ENV_FILE;
  const serviceEnv = p.serviceEnv ?? DEFAULT_SERVICE_ENV_FILE;
  if (!fs.existsSync(etc)) {
    add("secret directory", "fail", `${etc} missing`);
    blockers.push(`${etc} does not exist (secret files not installed).`);
  } else {
    for (const [file, group] of [[adminEnv, true], [serviceEnv, false]] as const) {
      const problems = secretFileProblems(file, { allowGroupRead: group });
      add(`secret file ${path.basename(file)}`, problems.length ? "fail" : "pass", problems.length ? problems.join("; ") : `mode ok (${(fs.statSync(file).mode & 0o777).toString(8)})`);
      if (problems.length) blockers.push(`Secret file problem: ${problems.join("; ")}`);
    }
  }
  const legacy = readEnvFile(path.join(cwd, LEGACY_ENV_FILE));
  const leaked = CONTROLLER_SECRET_KEYS.filter((k) => legacy[k]);
  if (leaked.length) {
    const w = `Repository ${LEGACY_ENV_FILE} still contains controller secrets (${leaked.join(", ")}); anything running as this user can read them.`;
    securityWarnings.push(w);
    add("legacy .env.fleet", "warn", w);
    blockers.push("Controller credentials are still in the repository .env.fleet.");
  }
  const unit = p.systemdUnit ?? SYSTEMD_UNIT_PATH;
  if (!fs.existsSync(unit)) {
    add("systemd unit", "fail", `${unit} not installed`);
    blockers.push("Fleet service systemd unit is not installed.");
  } else add("systemd unit", "pass", unit);
  if (env.FLEET_API_URL && !/^http:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/.test(apiUrl) && !apiUrl.startsWith("https://")) {
    securityWarnings.push(`FLEET_API_URL ${apiUrl} is neither loopback nor https.`);
  }

  // ── Structural blockers that no configuration can clear yet
  if (!deps.sandboxTerminationGuaranteed) {
    add("sandbox termination", "warn", "not supported by the Conway API; dead agents' sandboxes may keep running");
    blockers.push("Sandbox termination cannot be guaranteed (Conway API has no stop/delete); zombie children are contained but not stopped.");
  }
  // In production the cert is the systemd credential copy (tls.crt) and the key comes from LoadCredential=tls.key.
  const tlsCertCredential = path.join(SYSTEMD_CREDENTIALS_ROOT, FLEET_SYSTEMD_UNIT, TLS_CERT_CREDENTIAL);
  const certViaCredential = env.FLEET_TLS_CERT_FILE?.trim() === tlsCertCredential;
  const tlsConfigured = !!(env.FLEET_TLS_CERT_FILE && (env.FLEET_TLS_KEY_FILE || env.CREDENTIALS_DIRECTORY || certViaCredential));
  const remote = env.FLEET_REMOTE_LISTEN_ENABLED?.trim().toLowerCase() === "true";
  facts.tlsConfigured = tlsConfigured;
  facts.remoteListenEnabled = remote;
  add("remote fleet endpoint", tlsConfigured && remote ? "pass" : "warn",
    tlsConfigured && remote ? "HTTPS listener enabled" : "no HTTPS endpoint reachable by remote child sandboxes (loopback only)");
  if (!(tlsConfigured && remote)) {
    blockers.push("Remote child sandboxes cannot reach the fleet service: no HTTPS endpoint deployed (certificate, DNS, firewall).");
  }
  // Wallet custody: the upstream runtime generates and holds its own wallet key.
  add("wallet custody", "warn", "agent wallets are controller-supervised (freeze, spend requests) but keys are still generated and held by each agent runtime");
  blockers.push("Agent wallet keys are still generated and held by the agent runtime (~/.automaton/wallet.json); no controller custody signer exists yet.");

  facts.securityWarnings = securityWarnings;
  const deploymentOk = !checks.some((c) => c.status === "fail");

  // ── Phase 6: operator checklist
  const fetchImpl = deps.fetchImpl ?? fetch;
  const checklist: ChecklistItem[] = [];
  const item = (name: string, ok: boolean, detail: string) => checklist.push({ item: name, ok, detail });
  const privOk = Array.isArray(facts.privilegeProblems) && (facts.privilegeProblems as string[]).length === 0;
  item(
    "PostgreSQL roles correct",
    dbOk && privOk,
    privOk
      ? facts.operatorRoles === "not_provisioned"
        ? "agent/service roles least-privilege; operator roles: not provisioned"
        : "agent/service/operator roles least-privilege"
      : "privilege audit failed or not run",
  );
  item(`schema v${FLEET_PG_SCHEMA_VERSION}`, facts.schemaVersion === FLEET_PG_SCHEMA_VERSION, `v${facts.schemaVersion ?? "none"}`);

  const unitState = await (deps.serviceActive ?? defaultServiceActive)().catch(() => null);
  facts.systemdState = unitState;
  item("controller service active", unitState === "active" && facts.serviceState === "ready",
    `systemd ${unitState ?? "unknown"}, /readyz ${String(facts.serviceState ?? "unknown")}`);

  const passwd = p.passwd ?? "/etc/passwd";
  const group = p.group ?? "/etc/group";
  const tlsKey = env.FLEET_TLS_KEY_FILE?.trim() || path.join(etc, "tls", "fleet.key");
  const exposures: string[] = [];
  for (const [file, users] of [
    [adminEnv, [FLEET_AGENT_USER, FLEET_SERVICE_USER]],
    [serviceEnv, [FLEET_AGENT_USER, FLEET_SERVICE_USER]],
    [tlsKey, [FLEET_AGENT_USER, FLEET_SERVICE_USER]],
  ] as const) {
    for (const u of users) if (osUserCanRead(file, u, passwd, group) === true) exposures.push(`${u} can read ${file}`);
  }
  facts.secretExposures = exposures;
  const secretFilesOk = fs.existsSync(etc) && !checks.some((c) => c.name.startsWith("secret file") && c.status !== "pass");
  item("privileged secrets protected", secretFilesOk && exposures.length === 0 && leaked.length === 0,
    [!secretFilesOk ? "secret files missing or mis-permissioned" : "", ...exposures, leaked.length ? "controller secrets in repository .env.fleet" : ""]
      .filter(Boolean).join("; ") || "admin.env/service.env/TLS key unreadable to agent and service users; none in the repository");

  const pinnedOk = !relProblem;
  const matches = (k: "repo" | "commit" | "buildId") => pinnedOk && !!approved && release![k] === approved[k];
  item("runtime repo pinned", matches("repo"), `${env.FLEET_RUNTIME_REPO || "unset"}${approved ? ` (approved ${approved.repo})` : ""}`);
  item("runtime commit pinned", matches("commit"), `${env.FLEET_RUNTIME_COMMIT || "unset"}`);
  item("build ID pinned", matches("buildId") && release!.lockfileSha256 === approved!.lockfileSha256, `${env.FLEET_RUNTIME_BUILD_ID || "unset"}`);

  const hostname = env.FLEET_PUBLIC_HOSTNAME?.trim() || "";
  // The operator cannot read /run/credentials; check the LoadCredential=tls.crt source instead.
  const certFile = certViaCredential ? path.join(etc, "tls", "fleet.crt") : env.FLEET_TLS_CERT_FILE?.trim() || "";
  const certProblems = !hostname || !certFile ? ["FLEET_PUBLIC_HOSTNAME / FLEET_TLS_CERT_FILE not configured"] : certificateProblems(certFile, hostname);
  facts.publicHostname = hostname || null;
  item("HTTPS valid", certProblems.length === 0 && remote, certProblems.join("; ") || (remote ? `certificate valid for ${hostname}` : "remote listener disabled"));

  const publicUrl = (env.FLEET_PUBLIC_URL?.trim() || (hostname ? `https://${hostname}${env.FLEET_PUBLIC_PORT ? `:${env.FLEET_PUBLIC_PORT}` : ""}` : "")).replace(/\/+$/, "");
  let remoteOk = false;
  let remoteDetail = "no public URL configured";
  if (publicUrl.startsWith("https://")) {
    try {
      const r = await fetchImpl(`${publicUrl}/healthz`, { signal: AbortSignal.timeout(5000) });
      const b = (await r.json().catch(() => ({}))) as { ok?: boolean };
      remoteOk = r.ok && b.ok === true;
      remoteDetail = `${publicUrl}/healthz -> ${r.status}`;
    } catch (err) {
      remoteDetail = `${publicUrl} unreachable (${err instanceof Error ? err.message : String(err)})`;
    }
  }
  facts.publicUrl = publicUrl || null;
  item("remote controller reachable", remoteOk, remoteDetail);

  const probes = facts.serviceState === "ready" ? await replayProbes(apiUrl, fetchImpl) : null;
  item("replay protection working", !!probes?.staleRefused && (facts.schemaVersion as number) >= 4,
    probes ? `${probes.detail}; nonce ledger fleet_request_nonces (schema v${facts.schemaVersion})` : "service not ready; not probed");
  item("agent credentials scoped", privOk && !!probes?.sessionOnly,
    `agent role: api_* only (${privOk ? "audit pass" : "audit fail"}); long-lived credential ${probes?.sessionOnly ? "only opens sessions" : "not verified"}`);
  item("payments disabled", !flags.REAL_PAYMENTS_ENABLED, flags.REAL_PAYMENTS_ENABLED ? "REAL_PAYMENTS_ENABLED=true" : "REAL_PAYMENTS_ENABLED=false");
  item("owner sweeps disabled", !flags.OWNER_SWEEP_ENABLED, flags.OWNER_SWEEP_ENABLED ? "OWNER_SWEEP_ENABLED=true" : "OWNER_SWEEP_ENABLED=false");
  item("fleet cap = 2", facts.fleetMaximum === 2, `max ${facts.fleetMaximum ?? "unknown"}`);
  item("no unresolved orphan", dbOk && facts.openOrphans === 0, `${facts.openOrphans ?? "unknown"} open`);
  const stuck = (facts.staleReservations as number | undefined) ?? null;
  const uncertain = (facts.uncertainProvisioning as number | undefined) ?? null;
  item("no stuck reservation", dbOk && stuck === 0 && uncertain === 0, `${stuck ?? "unknown"} expired-unreaped, ${uncertain ?? "unknown"} uncertain provisioning`);

  // ── Phase 6: independent readiness levels
  const failing = checks.filter((c) => c.status === "fail").map((c) => `${c.name}: ${c.detail}`);
  const dryRun = [
    ...failing,
    ...checklist.filter((c) => !c.ok).map((c) => `${c.item}: ${c.detail}`),
    ...(flags.REAL_REPLICATION_ENABLED ? ["REAL_REPLICATION_ENABLED must stay false until the dry run passes"] : []),
    ...((facts.dryRunChildren as number) > 0 ? ["a dry-run child already exists"] : []),
  ];
  const realReplication = [
    ...dryRun.filter((b) => !b.startsWith("a dry-run child already exists")),
    ...(((facts.dryRunProven as number) ?? 0) > 0 ? [] : ["No dry-run child has yet reached ACTIVE and passed a controller challenge (pnpm fleet:dry-run-child)."]),
    ...blockers,
  ];
  const realPayments = [
    ...failing,
    ...checklist.filter((c) => !c.ok && /PostgreSQL|schema|secrets|owner sweeps/.test(c.item)).map((c) => `${c.item}: ${c.detail}`),
    ...(deps.custodySignerAvailable ? [] : ["No controller custody signer exists; approved spends cannot be executed safely (executeApprovedSpend refuses)."]),
    "Agent wallet keys are still generated and held by the agent runtime; payments need controller-held custody first.",
    ...(flags.OWNER_SWEEP_ENABLED ? ["OWNER_SWEEP_ENABLED must stay false until owner distributions are separately approved."] : []),
  ];
  const level = (b: string[]): ReadinessLevel => ({ safe: b.length === 0, blockers: [...new Set(b)] });
  const readiness = { dryRun: level(dryRun), realReplication: level(realReplication), realPayments: level(realPayments) };
  const replicationSafe = deploymentOk && readiness.realReplication.safe;
  return { deploymentOk, replicationSafe, readiness, checklist, checks, blockers: [...new Set(blockers)], securityWarnings, facts };
}

export function formatChecklist(r: DoctorReport): string {
  const lines = ["Automaton Fleet — operator verification", ""];
  for (const c of r.checklist) lines.push(`  [${c.ok ? "PASS" : "FAIL"}] ${c.item.padEnd(30)} ${c.detail}`);
  lines.push("", ...formatReadiness(r));
  return lines.join("\n");
}

function formatReadiness(r: DoctorReport): string[] {
  const lines: string[] = [];
  const show = (label: string, l: ReadinessLevel) => {
    lines.push(`${label.padEnd(27)} ${l.safe ? "YES" : `NO (${l.blockers.length} blocker${l.blockers.length === 1 ? "" : "s"})`}`);
    for (const b of l.blockers) lines.push(`  - ${b}`);
  };
  show("SAFE FOR DRY RUN:", r.readiness.dryRun);
  show("SAFE FOR REAL REPLICATION:", r.readiness.realReplication);
  show("SAFE FOR REAL PAYMENTS:", r.readiness.realPayments);
  return lines;
}

export function formatDoctorReport(r: DoctorReport): string {
  const icon: Record<CheckStatus, string> = { pass: "PASS", warn: "WARN", fail: "FAIL" };
  const lines = ["Automaton Fleet — deployment readiness", ""];
  for (const c of r.checks) lines.push(`  [${icon[c.status]}] ${c.name.padEnd(34)} ${c.detail}`);
  lines.push("");
  const f = r.facts;
  const show = (k: string, v: unknown) => lines.push(`  ${k.padEnd(24)} ${v === undefined || v === null ? "-" : typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  show("schema version", f.schemaVersion);
  show("fleet service", f.serviceState);
  show("runtime repo", f.runtimeRepo);
  show("runtime commit", f.runtimeCommit);
  show("runtime build id", f.runtimeBuildId);
  show("replication enabled", f.replicationEnabled);
  show("payments enabled", f.paymentsEnabled);
  show("owner sweep enabled", f.ownerSweepEnabled);
  show("fleet maximum", f.fleetMaximum);
  show("living agents", f.livingAgents);
  show("reserved slots", f.reservedSlots);
  show("stale agents", f.staleAgents);
  show("stale reservations", f.staleReservations);
  if (r.securityWarnings.length) {
    lines.push("", "Security warnings:");
    for (const w of r.securityWarnings) lines.push(`  - ${w}`);
  }
  lines.push("", "Operator checklist:");
  for (const c of r.checklist) lines.push(`  [${c.ok ? "PASS" : "FAIL"}] ${c.item.padEnd(30)} ${c.detail}`);
  lines.push("", `DEPLOYMENT:        ${r.deploymentOk ? "OK" : "FAIL"}`);
  lines.push(`REAL REPLICATION:  ${r.replicationSafe ? "SAFE" : `UNSAFE — FAIL (${r.blockers.length} blocker${r.blockers.length === 1 ? "" : "s"})`}`);
  lines.push("", ...formatReadiness(r));
  return lines.join("\n");
}

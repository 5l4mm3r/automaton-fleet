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
 */

import fs from "fs";
import path from "path";
import { FLEET_PG_SCHEMA_VERSION } from "./postgres/migrations.js";
import type { PgFleetStore } from "./postgres/store.js";
import { loadRuntimeRelease, runtimeReleaseProblem, sameRelease } from "./runtime.js";
import {
  CONTROLLER_SECRET_KEYS,
  DEFAULT_ADMIN_ENV_FILE,
  DEFAULT_SERVICE_ENV_FILE,
  FLEET_ETC_DIR,
  LEGACY_ENV_FILE,
  readEnvFile,
  secretFileProblems,
} from "./secret-files.js";

export type CheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  deploymentOk: boolean;
  replicationSafe: boolean;
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
  };
  /** Sandbox termination is guaranteed by the deployed terminator (default false: Conway cannot stop sandboxes). */
  sandboxTerminationGuaranteed?: boolean;
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
      add("database privileges", audit.ok ? "pass" : "fail", audit.ok ? "agent/service roles least-privilege; PUBLIC has nothing" : audit.problems.join("; "));
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
    } catch (err) {
      add("registry state", "fail", err instanceof Error ? err.message : String(err));
    }
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
  const tlsConfigured = !!(env.FLEET_TLS_CERT_FILE && (env.FLEET_TLS_KEY_FILE || env.CREDENTIALS_DIRECTORY));
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
  const replicationSafe = deploymentOk && blockers.length === 0;
  return { deploymentOk, replicationSafe, checks, blockers: [...new Set(blockers)], securityWarnings, facts };
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
  lines.push("", `DEPLOYMENT:        ${r.deploymentOk ? "OK" : "FAIL"}`);
  lines.push(`REAL REPLICATION:  ${r.replicationSafe ? "SAFE" : `UNSAFE — FAIL (${r.blockers.length} blocker${r.blockers.length === 1 ? "" : "s"})`}`);
  for (const b of r.blockers) lines.push(`  - ${b}`);
  return lines.join("\n");
}

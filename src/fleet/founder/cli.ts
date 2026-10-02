/**
 * Founder runtime provisioner CLI (Phase F.1) — root only, run from the
 * pinned release by scripts/fleet-founders.sh (`sudo scripts/fleet-founders.sh <cmd>`).
 *
 *   status                                   founder units and runtime state on this host
 *   rehearsal                                real-runtime two-founder rehearsal against a THROWAWAY
 *                                            registry (production registry is only read, before/after)
 *   provision <genesisId>                    approved → attesting, one isolated runtime per founder
 *   births                                   queued birth orders and their provisioning state (v40)
 *   birth <orderId>                          a birth order → a running agent: authorize, provision, attest, fund, activate (v40)
 *   attest <genesisId>                       runtime + host evidence per founder (or whole-set rollback)
 *   activate <genesisId> <authSha256>        OWNER GATE: credentials delivered, runtimes restart active
 *   teardown <genesisId>                     stop and delete every runtime of that Genesis
 *   pin <agentId>                            (re)write a living founder's pin to its REGISTERED runtime; no restart
 *
 * R23 — runtime upgrade of a LIVING founder (schema v23; src/fleet/founder/upgrade.ts). The founder stays the same
 * economic agent; its process is stopped and started only by these explicit operations:
 *   upgrade-status <agentId>                 registered runtime, host pin, running process, upgrade history
 *   upgrade-preflight <agentId>              prove the upgrade to the approved runtime is possible; changes NOTHING
 *   upgrade-runtime <agentId> [--health-timeout S]      OWNER GATE: stop → snapshot → registry pin → host pin → start →
 *                                            health proof → verify; any failure rolls back to the previous runtime
 *   rollback-runtime <agentId> <upgradeId> <reason…>    OWNER GATE: return to the runtime recorded by that upgrade
 *   upgrade-rehearsal <fromCommit>           the whole lifecycle + routed cognition on a SYNTHETIC founder created on
 *                                            the installed release <fromCommit>, THROWAWAY registry, fake provider
 *
 * F1-FRESH-02 — memory retention health (read-only; counts and status only, never a fact key or value):
 *   memory-report <agentId>                  founder_memory_write telemetry from the unit's journal + fact-store health
 *
 * The acting owner is operator:<SUDO_USER>. provision/attest/activate/teardown
 * use the production registry through admin.env; the database still refuses
 * approval/activation while Genesis is disabled. Output is JSON without any
 * token, credential or nonce.
 */

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import pg from "pg";
import { DEFAULT_RUNTIME_ENV_FILE, loadAdminEnv, readEnvFile } from "../secret-files.js";
import { loadRuntimeRelease, runningRuntimeDir } from "../runtime.js";
import { PgGenesisAdmin } from "../genesis/admin.js";
import { createRedactedLineLogger } from "../redact.js";
import { FOUNDER_STATE_ROOT, RELEASES_DIR, SystemdFounderHost, founderPinPaths, founderUnit } from "./host.js";
import { computeBuildIdentity } from "../attestation.js";
import { rollbackFounderRuntime, upgradeFounderRuntime } from "./upgrade.js";
import { runUpgradeRehearsal } from "./upgrade-rehearsal.js";
import { FounderProvisioner } from "./provisioner.js";
import { FOUNDER_UNREADABLE_PATHS } from "./runtime.js";
import { findPostgresBin, startEphemeralRegistry } from "./ephemeral-registry.js";
import { runFounderRehearsal } from "./rehearsal.js";
import { DEFAULT_FETCHER_SOCKET, unixFetcher } from "../research/client.js";
import { FOUNDER_IDENTITY_FILE } from "./evidence.js";
import { aggregateMemoryEvents, factStoreHealth } from "./memory-report.js";

const PRODUCTION_API_URL = "http://127.0.0.1:8787";
/** Root-only (0700) home of pre-upgrade state backups: durable founder state, never a credential. */
const UPGRADE_BACKUP_ROOT = "/var/lib/automaton-fleet-upgrades";
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function actorOrDie(): string {
  const u = process.env.SUDO_USER?.trim();
  if (!u || u === "root" || !/^[A-Za-z0-9._-]{1,64}$/.test(u)) throw new Error("run through sudo from the owner's own account (SUDO_USER)");
  return `operator:${u}`;
}

function adminUrl(): string {
  const e = loadAdminEnv().env;
  const url = (e.FLEET_ADMIN_DATABASE_URL || e.FLEET_CONTROLLER_DATABASE_URL || e.DATABASE_URL)?.trim();
  if (!url) throw new Error("no admin credential (admin.env)");
  return url;
}

/** Read-only production snapshot: population, Genesis records, Genesis switch, founders. */
async function productionSnapshot(): Promise<Record<string, unknown>> {
  const c = new pg.Client({ connectionString: adminUrl(), options: "-c search_path=fleet -c default_transaction_read_only=on" });
  await c.connect();
  try {
    const r = await c.query(
      `SELECT (SELECT living_agents + reserved_slots + quarantined_slots FROM fleet_state) AS population,
              (SELECT max_agents FROM fleet_state) AS cap,
              (SELECT count(*)::int FROM fleet_genesis) AS genesis_records,
              (SELECT genesis_enabled FROM fleet_genesis_policy) AS genesis_enabled,
              (SELECT count(*)::int FROM fleet_agents) AS agents,
              (SELECT head_seq::text FROM fleet_ledger_head) AS ledger_head,
              (SELECT research_enabled FROM fleet_research_policy) AS research_enabled,
              (SELECT count(*)::int FROM fleet_research_attempts) AS research_attempts`,
    );
    return r.rows[0];
  } finally {
    await c.end();
  }
}

/** Founder unit instances that are running, starting or failed (inactive, unloaded instances do not count). */
function founderUnitsOnHost(): string[] {
  try {
    return execFileSync("systemctl", ["list-units", "--all", "--plain", "--no-legend", "automaton-fleet-founder@*"], { encoding: "utf8" })
      .split("\n").map((l) => l.trim().split(/\s+/)).filter((c) => c[0] && c[2] && c[2] !== "inactive").map((c) => `${c[0]} ${c[2]}`);
  } catch {
    return [];
  }
}

/** Living production founders (registry), which a rehearsal must leave untouched. */
async function livingFounders(): Promise<string[]> {
  const c = new pg.Client({ connectionString: adminUrl(), options: "-c search_path=fleet -c default_transaction_read_only=on" });
  await c.connect();
  try {
    return (await c.query(`SELECT agent_id FROM fleet_agents WHERE origin IN ('genesis_founder','reseed_founder') AND status IN ('active','unresponsive') ORDER BY agent_id`)).rows.map((r) => String(r.agent_id));
  } finally {
    await c.end();
  }
}

function founderMainPid(agentId: string): string {
  try {
    return execFileSync("systemctl", ["show", "-p", "MainPID", "--value", `automaton-fleet-founder@${agentId}.service`], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function founderStateOnHost(): string[] {
  try {
    return fs.readdirSync(FOUNDER_STATE_ROOT);
  } catch {
    return [];
  }
}

/**
 * What any real-runtime rehearsal on this host must leave untouched: the production registry's population, Genesis
 * records and switches, and every living production founder's process. Refuses to start over founder units or state
 * that are not living production founders.
 */
async function rehearsalGuard() {
  const before = await productionSnapshot();
  const living = new Set(await livingFounders());
  const foreign = () => [
    ...founderUnitsOnHost().filter((u) => !living.has(/automaton-fleet-founder@([0-9A-Z]{26})\.service/.exec(u)?.[1] ?? "")),
    ...founderStateOnHost().filter((d) => !living.has(d)),
  ];
  if (foreign().length) throw new Error(`founder units or state that are not living production founders exist on this host (${foreign().slice(0, 3).join(", ")}); refusing to rehearse over them`);
  const livingPids = [...living].map((id) => ({ id, pid: founderMainPid(id) }));
  const inv = (x: Record<string, unknown>) => JSON.stringify([x.population, x.cap, x.genesis_records, x.genesis_enabled, x.agents, x.research_enabled]);
  return {
    async finish(registryDir: string) {
      const after = await productionSnapshot();
      return {
        production: { before, after, unchanged: inv(before) === inv(after) },
        productionUnchanged: inv(before) === inv(after),
        hostClean: foreign().length === 0 && !fs.existsSync(registryDir),
        livingFounders: { before: livingPids, untouched: livingPids.every((f) => f.pid !== "" && f.pid !== "0" && founderMainPid(f.id) === f.pid) },
        livingUntouched: livingPids.every((f) => f.pid !== "" && f.pid !== "0" && founderMainPid(f.id) === f.pid),
      };
    },
  };
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (process.getuid?.() !== 0) throw new Error("the founder provisioner must run as root (sudo scripts/fleet-founders.sh …)");
  const log = createRedactedLineLogger("fleet-founders", (l) => process.stderr.write(l + "\n"));
  const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));
  switch (cmd) {
    case "status":
      out({ units: founderUnitsOnHost(), state: founderStateOnHost() });
      return 0;
    case "rehearsal": {
      const actor = actorOrDie();
      const release = loadRuntimeRelease(readEnvFile(process.env.FLEET_RUNTIME_ENV_FILE?.trim() || DEFAULT_RUNTIME_ENV_FILE));
      if (!release) throw new Error("no pinned runtime release in runtime.env");
      const releaseDir = runningRuntimeDir(import.meta.url);
      const bin = findPostgresBin();
      if (!bin) throw new Error("PostgreSQL server binaries not found");
      const before = await productionSnapshot();
      // Living production founders may run alongside (their units are pinned to their own release); anything else refuses.
      const living = new Set(await livingFounders());
      const foreign = () => [
        ...founderUnitsOnHost().filter((u) => !living.has(/automaton-fleet-founder@([0-9A-Z]{26})\.service/.exec(u)?.[1] ?? "")),
        ...founderStateOnHost().filter((d) => !living.has(d)),
      ];
      if (foreign().length) throw new Error(`founder units or state that are not living production founders exist on this host (${foreign().slice(0, 3).join(", ")}); refusing to rehearse over them`);
      const livingPids = [...living].map((id) => ({ id, pid: founderMainPid(id) }));
      const reg = await startEphemeralRegistry({ bin, rolesSql: path.join(releaseDir, "scripts/fleet-db-roles.sql"), runAs: "postgres", parent: "/var/tmp" });
      let report;
      try {
        report = await runFounderRehearsal({
          registry: reg,
          host: new SystemdFounderHost(undefined, undefined, release),
          release,
          actor,
          log,
          forbiddenPaths: [...FOUNDER_UNREADABLE_PATHS, reg.dir, "/var/lib/postgresql", "/etc/postgresql/16/main/pg_hba.conf", "/var/lib/automaton-fleet-custody"],
          // Pre-Genesis step 4: the rehearsal controller relays to the production isolated fetcher (research is
          // enabled only in the throwaway registry; the production registry's research switch is never touched).
          researchFetcher: unixFetcher(DEFAULT_FETCHER_SOCKET),
          // The shipped unit thinks on every 2nd 30 s heartbeat: allow each phase six minutes.
          timeoutMs: 360_000,
        });
      } finally {
        reg.stop();
      }
      const after = await productionSnapshot();
      const hostClean = foreign().length === 0 && !fs.existsSync(reg.dir);
      // What a rehearsal must never change. (Ledger head and research counts move with living founders' own work.)
      const inv = (x: Record<string, unknown>) => JSON.stringify([x.population, x.cap, x.genesis_records, x.genesis_enabled, x.agents, x.research_enabled]);
      const productionUnchanged = inv(before) === inv(after);
      const livingUntouched = livingPids.every((f) => f.pid !== "" && f.pid !== "0" && founderMainPid(f.id) === f.pid);
      const pass = report.pass && productionUnchanged && hostClean && livingUntouched;
      out({ ...report, pass, production: { before, after, unchanged: productionUnchanged }, hostClean, livingFounders: { before: livingPids, untouched: livingUntouched } });
      return pass ? 0 : 1;
    }
    case "provision":
    case "attest":
    case "activate":
    case "teardown": {
      const actor = actorOrDie();
      const id = rest[0];
      if (!id || !UUID.test(id)) throw new Error(`usage: ${cmd} <genesisId>${cmd === "activate" ? " <authSha256>" : ""}`);
      const genesis = new PgGenesisAdmin({ connectionString: adminUrl() });
      try {
        // New founders are pinned to the Genesis-authorized (= approved) release at provisioning.
        const pinRelease = cmd === "provision" ? loadRuntimeRelease(readEnvFile(process.env.FLEET_RUNTIME_ENV_FILE?.trim() || DEFAULT_RUNTIME_ENV_FILE)) : null;
        const prov = new FounderProvisioner({ genesis, host: new SystemdFounderHost(undefined, undefined, pinRelease), apiUrl: PRODUCTION_API_URL, actor, log });
        if (cmd === "provision") out(await prov.provisionGenesis(id));
        else if (cmd === "attest") {
          const r = await prov.attestGenesis(id);
          out(r);
          return r.ok ? 0 : 1;
        } else if (cmd === "activate") {
          const sha = rest[1];
          if (!sha || !/^[0-9a-f]{64}$/.test(sha)) throw new Error("usage: activate <genesisId> <authSha256>");
          out(await prov.activateGenesis(id, sha));
        } else {
          await prov.teardown(id);
          out({ tornDown: id });
        }
        return 0;
      } finally {
        await genesis.close();
      }
    }
    case "birth": {
      // v40: provision a running agent for a queued birth order (automatic or Admin-directed), end to end.
      const actor = actorOrDie();
      const orderId = rest[0];
      if (!orderId || !UUID.test(orderId)) throw new Error("usage: birth <orderId>");
      const genesis = new PgGenesisAdmin({ connectionString: adminUrl() });
      try {
        const pinRelease = loadRuntimeRelease(readEnvFile(process.env.FLEET_RUNTIME_ENV_FILE?.trim() || DEFAULT_RUNTIME_ENV_FILE));
        const prov = new FounderProvisioner({ genesis, host: new SystemdFounderHost(undefined, undefined, pinRelease), apiUrl: PRODUCTION_API_URL, actor, log });
        const r = await prov.birth(orderId);
        out(r);
        return r.genesis.status === "activated" ? 0 : 1;
      } finally {
        await genesis.close();
      }
    }
    case "births": {
      actorOrDie();
      const genesis = new PgGenesisAdmin({ connectionString: adminUrl() });
      try { out(await genesis.birthsPending()); return 0; } finally { await genesis.close(); }
    }
    case "pin": {
      // Pin a living founder's unit to its REGISTERED runtime (Genesis attestation, or its latest upgrade). No restart.
      actorOrDie();
      const id = rest[0];
      if (!id || !ULID.test(id)) throw new Error("usage: pin <agentId>");
      const genesis = new PgGenesisAdmin({ connectionString: adminUrl() });
      try {
        const ctx = await genesis.founderRuntimeContext(id);
        if (!ctx.agent || !["genesis_founder", "reseed_founder"].includes(ctx.agent.origin)) throw new Error("no such founder");
        if (!["active", "unresponsive"].includes(ctx.agent.status)) throw new Error(`founder is ${ctx.agent.status}; only living founders are pinned`);
        const cur = await genesis.founderRuntimeCurrent(id);
        if (!cur) throw new Error("the founder has no registered runtime");
        if (ctx.agent.runtimeCommit !== cur.commit) throw new Error("the founder's registry row and its runtime record disagree; refusing");
        const host = new SystemdFounderHost();
        const before = host.readPin(id);
        const pinned = await host.pinRuntime(id, { repo: cur.repo, commit: cur.commit, buildId: cur.buildId, lockfileSha256: cur.lockfileSha256 });
        out({ agentId: id, registered: { commit: cur.commit, source: cur.source }, before, pinned, restarted: false, note: "takes effect at the founder's next start; the running process is untouched" });
        return 0;
      } finally {
        await genesis.close();
      }
    }
    case "memory-report": {
      // Read-only: no registry, no unit change, no write to founder state. Output: counts and status only.
      const id = rest[0];
      if (!id || !ULID.test(id)) throw new Error("usage: memory-report <agentId>");
      const dir = path.join(FOUNDER_STATE_ROOT, id);
      let ns: string | null = null;
      try {
        const f = path.join(dir, FOUNDER_IDENTITY_FILE);
        const fd = fs.openSync(f, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          if (fs.fstatSync(fd).isFile()) {
            const v = (JSON.parse(fs.readFileSync(fd, "utf8")) as { stateNamespace?: unknown }).stateNamespace;
            ns = typeof v === "string" && /^st_[0-9A-HJKMNP-TV-Z]{26}$/.test(v) ? v : null;
          }
        } finally { fs.closeSync(fd); }
      } catch { ns = null; }
      let lines: string[] = [];
      let journal = "ok";
      try {
        lines = execFileSync("journalctl", ["-u", founderUnit(id), "-o", "cat", "--no-pager", "-g", "founder_memory_write"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).split("\n");
      } catch (e) {
        // journalctl exits 1 when --grep matches nothing; anything else is reported, not guessed.
        journal = (e as { status?: number }).status === 1 ? "ok" : "unavailable";
      }
      out({
        agentId: id, unit: founderUnit(id), at: new Date().toISOString(),
        telemetry: { source: "journald founder_memory_write (retained window; runtimes from F1-FRESH-02 observability on)", journal, ...aggregateMemoryEvents(lines) },
        factStore: ns ? factStoreHealth(path.join(dir, "state", ns, "memory")) : { identity: "unreadable: state namespace unknown" },
      });
      return 0;
    }
    case "upgrade-status":
    case "upgrade-preflight":
    case "upgrade-runtime":
    case "rollback-runtime": {
      const actor = actorOrDie();
      const id = rest[0];
      if (!id || !ULID.test(id)) throw new Error(`usage: ${cmd} <agentId>${cmd === "rollback-runtime" ? " <upgradeId> <reason…>" : ""}`);
      const genesis = new PgGenesisAdmin({ connectionString: adminUrl() });
      try {
        const host = new SystemdFounderHost();
        if (cmd === "upgrade-status") {
          const ctx = await genesis.founderRuntimeContext(id);
          const pid = await host.pid(id);
          out({ agentId: id, agent: ctx.agent, approved: ctx.approved, registered: await genesis.founderRuntimeCurrent(id), hostPin: host.readPin(id), mainPid: pid,
            inFlight: ctx.inFlight, policy: { heartbeatUnresponsiveS: ctx.heartbeatUnresponsiveS, heartbeatDeadS: ctx.heartbeatDeadS }, upgrades: await genesis.founderRuntimeUpgrades(id, 10) });
          return 0;
        }
        if (cmd === "rollback-runtime") {
          const upgradeId = rest[1];
          const reason = rest.slice(2).join(" ");
          if (!upgradeId || !UUID.test(upgradeId) || reason.length < 3) throw new Error("usage: rollback-runtime <agentId> <upgradeId> <reason…>");
          const r = await rollbackFounderRuntime({ agentId: id, host, registry: genesis, upgradeId, reason, actor, log });
          out(r);
          return r.ok ? 0 : 1;
        }
        // The target is never chosen on the command line: it is the release this tool runs from, which must be the
        // pinned AND owner-approved runtime (the registry refuses anything else at prepare and again at commit).
        const target = loadRuntimeRelease(readEnvFile(process.env.FLEET_RUNTIME_ENV_FILE?.trim() || DEFAULT_RUNTIME_ENV_FILE));
        if (!target) throw new Error("no pinned runtime release in runtime.env");
        const i = rest.indexOf("--health-timeout");
        const healthS = i >= 0 ? Number(rest[i + 1]) : 120;
        if (!Number.isInteger(healthS) || healthS < 30 || healthS > 300) throw new Error("--health-timeout is 30..300 seconds");
        const r = await upgradeFounderRuntime({ agentId: id, host, registry: genesis, target, actor, backupRoot: UPGRADE_BACKUP_ROOT, dryRun: cmd === "upgrade-preflight", healthTimeoutMs: healthS * 1_000, log });
        out(r);
        return r.ok ? 0 : 1;
      } finally {
        await genesis.close();
      }
    }
    case "upgrade-rehearsal": {
      const actor = actorOrDie();
      const fromCommit = rest[0];
      if (!fromCommit || !/^[0-9a-f]{40}$/.test(fromCommit)) throw new Error("usage: upgrade-rehearsal <fromCommit>   (the full commit of an installed previous release)");
      const to = loadRuntimeRelease(readEnvFile(process.env.FLEET_RUNTIME_ENV_FILE?.trim() || DEFAULT_RUNTIME_ENV_FILE));
      if (!to) throw new Error("no pinned runtime release in runtime.env");
      const releaseDir = runningRuntimeDir(import.meta.url);
      if (fs.realpathSync(releaseDir) !== fs.realpathSync(path.join(RELEASES_DIR, to.commit))) throw new Error("run the rehearsal from the pinned release (scripts/fleet-founders.sh)");
      const fromId = computeBuildIdentity(path.join(RELEASES_DIR, fromCommit));
      const from = { repo: to.repo, commit: fromCommit, buildId: fromId.buildId, lockfileSha256: fromId.lockfileSha256 };
      if (from.commit === to.commit) throw new Error("the previous release is the pinned release: nothing to rehearse");
      const bin = findPostgresBin();
      if (!bin) throw new Error("PostgreSQL server binaries not found");
      const guard = await rehearsalGuard();
      const reg = await startEphemeralRegistry({ bin, rolesSql: path.join(releaseDir, "scripts/fleet-db-roles.sql"), runAs: "postgres", parent: "/var/tmp" });
      const backupRoot = fs.mkdtempSync(path.join("/var/tmp", "fleet-upgrade-rehearsal-"));
      let report;
      try {
        report = await runUpgradeRehearsal({
          registry: reg, host: new SystemdFounderHost(undefined, undefined, from), from, to, actor, backupRoot, log,
          pinEnvFile: (agentId) => founderPinPaths(agentId).env,
          // The shipped unit heartbeats every 30 s and thinks on every 2nd heartbeat.
          timeoutMs: 360_000, healthTimeoutMs: 120_000, pollMs: 1_000,
        });
      } finally {
        reg.stop();
        fs.rmSync(backupRoot, { recursive: true, force: true });
      }
      const end = await guard.finish(reg.dir);
      const pass = report.pass && end.productionUnchanged && end.hostClean && end.livingUntouched;
      out({ ...report, pass, production: end.production, hostClean: end.hostClean, livingFounders: end.livingFounders });
      return pass ? 0 : 1;
    }
    default:
      console.error("usage: fleet-founders.sh status | rehearsal | births | birth <orderId> | provision <genesisId> | attest <genesisId> | activate <genesisId> <authSha256> | teardown <genesisId> | pin <agentId>\n"
        + "       fleet-founders.sh upgrade-status <agentId> | upgrade-preflight <agentId> | upgrade-runtime <agentId> [--health-timeout S] | rollback-runtime <agentId> <upgradeId> <reason…> | upgrade-rehearsal <fromCommit>");
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`fleet-founders: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);

/**
 * Founder runtime provisioner CLI (Phase F.1) — root only, run from the
 * pinned release by scripts/fleet-founders.sh (`sudo scripts/fleet-founders.sh <cmd>`).
 *
 *   status                                   founder units and runtime state on this host
 *   rehearsal                                real-runtime two-founder rehearsal against a THROWAWAY
 *                                            registry (production registry is only read, before/after)
 *   provision <genesisId>                    approved → attesting, one isolated runtime per founder
 *   attest <genesisId>                       runtime + host evidence per founder (or whole-set rollback)
 *   activate <genesisId> <authSha256>        OWNER GATE: credentials delivered, runtimes restart active
 *   teardown <genesisId>                     stop and delete every runtime of that Genesis
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
import { FOUNDER_STATE_ROOT, SystemdFounderHost } from "./host.js";
import { FounderProvisioner } from "./provisioner.js";
import { FOUNDER_UNREADABLE_PATHS } from "./runtime.js";
import { findPostgresBin, startEphemeralRegistry } from "./ephemeral-registry.js";
import { runFounderRehearsal } from "./rehearsal.js";

const PRODUCTION_API_URL = "http://127.0.0.1:8787";
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
              (SELECT head_seq::text FROM fleet_ledger_head) AS ledger_head`,
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

function founderStateOnHost(): string[] {
  try {
    return fs.readdirSync(FOUNDER_STATE_ROOT);
  } catch {
    return [];
  }
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
      if (founderUnitsOnHost().length || founderStateOnHost().length) throw new Error("founder units or state already exist on this host; refusing to rehearse over them");
      const reg = await startEphemeralRegistry({ bin, rolesSql: path.join(releaseDir, "scripts/fleet-db-roles.sql"), runAs: "postgres", parent: "/var/tmp" });
      let report;
      try {
        report = await runFounderRehearsal({
          registry: reg,
          host: new SystemdFounderHost(),
          release,
          actor,
          log,
          forbiddenPaths: [...FOUNDER_UNREADABLE_PATHS, reg.dir, "/var/lib/postgresql", "/etc/postgresql/16/main/pg_hba.conf", "/var/lib/automaton-fleet-custody"],
        });
      } finally {
        reg.stop();
      }
      const after = await productionSnapshot();
      const hostClean = founderUnitsOnHost().length === 0 && founderStateOnHost().length === 0 && !fs.existsSync(reg.dir);
      const productionUnchanged = JSON.stringify(before) === JSON.stringify(after);
      out({ ...report, pass: report.pass && productionUnchanged && hostClean, production: { before, after, unchanged: productionUnchanged }, hostClean });
      return report.pass && productionUnchanged && hostClean ? 0 : 1;
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
        const prov = new FounderProvisioner({ genesis, host: new SystemdFounderHost(), apiUrl: PRODUCTION_API_URL, actor, log });
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
    default:
      console.error("usage: fleet-founders.sh status | rehearsal | provision <genesisId> | attest <genesisId> | activate <genesisId> <authSha256> | teardown <genesisId>");
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

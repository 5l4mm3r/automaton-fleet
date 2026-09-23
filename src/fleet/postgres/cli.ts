/**
 * Operator CLI for the shared fleet registry. Not an agent tool; the shell
 * guard forbids agents from invoking it.
 *
 *   pnpm fleet:migrate
 *   pnpm fleet:admin status | health
 *   pnpm fleet:admin set-cap <1..50>
 *   pnpm fleet:admin set-mode <DEVELOPMENT|EXPANSION|HARVEST|EMERGENCY> [reason]
 *   pnpm fleet:admin approve-runtime          (FLEET_RUNTIME_REPO / _COMMIT / _BUILD_ID / _LOCKFILE_SHA256)
 *   pnpm fleet:admin clear-runtime
 *   pnpm fleet:admin build-identity <dir>     (build id + lockfile hash of a built runtime tree)
 *   pnpm fleet:admin set-replication on|off   (DB-level replication switch)
 *   pnpm fleet:admin set-timeouts [reservation=S] [provisioning=S] [unresponsive=S] [dead=S]
 *   pnpm fleet:admin enroll-root <wallet> <name> [credentialFile]
 *   pnpm fleet:admin rotate-credential <agentId> [credentialFile]
 *   pnpm fleet:admin grant-agent-role [role]
 *   pnpm fleet:admin reap | reservations
 *   pnpm fleet:admin release <agentId> [reason]
 *   pnpm fleet:admin mark-dead <agentId> [reason]
 *
 * FLEET_CONTROLLER_DATABASE_URL (or DATABASE_URL) is read from the
 * environment, else from .env.fleet. It is never printed; agent tokens are
 * written to a 0600 file, never to stdout.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { isFleetState } from "../config.js";
import { validateRuntimePin } from "../runtime.js";
import { computeBuildIdentity, loadRuntimeBuild } from "../attestation.js";
import type { FleetCredential } from "../types.js";
import { PgFleetStore } from "./store.js";

const DEFAULT_CREDENTIAL_FILE = path.join(os.homedir(), ".automaton", "fleet-credentials.json");

/** Write an agent credential with 0600 permissions (created exclusively when new). */
export function writeCredentialFile(file: string, cred: FleetCredential, apiUrl: string | null): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ agentId: cred.agentId, token: cred.token, apiUrl }, null, 2), { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

export function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#")) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

function env(): Record<string, string | undefined> {
  return { ...readEnvFile(path.resolve(".env.fleet")), ...process.env };
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const e = env();
  if (cmd === "build-identity") {
    const dir = path.resolve(rest[0] ?? ".");
    console.log(JSON.stringify({ dir, ...computeBuildIdentity(dir) }));
    return 0;
  }
  const store = PgFleetStore.fromEnv(e);
  if (!store) {
    console.error("FLEET_CONTROLLER_DATABASE_URL / DATABASE_URL is not configured (environment or .env.fleet).");
    return 2;
  }
  const actor = `operator:${os.userInfo().username}`;
  try {
    switch (cmd) {
      case "migrate": {
        const applied = await store.migrate();
        console.log(applied.length ? `Applied migrations: ${applied.join(", ")}` : "Schema up to date.");
        console.log(JSON.stringify(await store.health()));
        return 0;
      }
      case "health": {
        const h = await store.health();
        console.log(JSON.stringify(h));
        return h.ok ? 0 : 1;
      }
      case "status": {
        console.log(JSON.stringify({ state: await store.getState(), agents: await store.listAgents() }, null, 2));
        return 0;
      }
      case "set-cap": {
        await store.setMaxAgents(Number(rest[0]), actor);
        console.log(JSON.stringify(await store.getState()));
        return 0;
      }
      case "set-mode": {
        const mode = rest[0]?.toUpperCase();
        if (!isFleetState(mode)) throw new Error("mode must be DEVELOPMENT|EXPANSION|HARVEST|EMERGENCY");
        await store.setOperatingMode(mode, actor, rest.slice(1).join(" ") || "operator");
        console.log(JSON.stringify(await store.getState()));
        return 0;
      }
      case "approve-runtime": {
        const v = validateRuntimePin(e.FLEET_RUNTIME_REPO, e.FLEET_RUNTIME_COMMIT);
        if (!v.ok) throw new Error(v.reason);
        const build = loadRuntimeBuild(e);
        if (!build) {
          throw new Error(
            "FLEET_RUNTIME_BUILD_ID and FLEET_RUNTIME_LOCKFILE_SHA256 are required (scripts/fleet-build-runtime.sh prints them).",
          );
        }
        await store.setApprovedRuntime(v.pin, actor, build);
        console.log(JSON.stringify(await store.getState()));
        return 0;
      }
      case "set-replication": {
        const on = rest[0] === "on" ? true : rest[0] === "off" ? false : null;
        if (on === null) throw new Error("usage: set-replication on|off");
        await store.setReplicationEnabled(on, actor);
        console.log(JSON.stringify(await store.getState()));
        return 0;
      }
      case "set-timeouts": {
        const keys: Record<string, "reservationTtlS" | "provisioningTtlS" | "heartbeatUnresponsiveS" | "heartbeatDeadS"> = {
          reservation: "reservationTtlS",
          provisioning: "provisioningTtlS",
          unresponsive: "heartbeatUnresponsiveS",
          dead: "heartbeatDeadS",
        };
        const t: Record<string, number> = {};
        for (const kv of rest) {
          const [k, v] = kv.split("=");
          if (!keys[k] || !/^\d+$/.test(v ?? "")) throw new Error(`bad timeout ${kv}`);
          t[keys[k]] = Number(v);
        }
        console.log(JSON.stringify(await store.setTimeouts(t, actor)));
        return 0;
      }
      case "enroll-root": {
        const [wallet, name, out] = rest;
        if (!wallet || !name) throw new Error("usage: enroll-root <wallet> <name> [credentialFile]");
        const reg = await store.registerRoot({ walletAddress: wallet, name });
        if (!reg.ok) throw new Error(`${reg.code}: ${reg.reason}`);
        const cred = await store.issueCredential(reg.agent.agentId, actor);
        const file = path.resolve(out ?? DEFAULT_CREDENTIAL_FILE);
        writeCredentialFile(file, cred, e.FLEET_API_URL?.trim() || null);
        console.log(JSON.stringify({ agentId: reg.agent.agentId, created: reg.created, credentialFile: file }));
        return 0;
      }
      case "rotate-credential": {
        const [agentId, out] = rest;
        if (!agentId) throw new Error("usage: rotate-credential <agentId> [credentialFile]");
        const cred = await store.issueCredential(agentId, actor);
        const file = path.resolve(out ?? DEFAULT_CREDENTIAL_FILE);
        writeCredentialFile(file, cred, e.FLEET_API_URL?.trim() || null);
        console.log(JSON.stringify({ agentId, credentialFile: file }));
        return 0;
      }
      case "grant-agent-role": {
        await store.grantAgentRole(rest[0] || store.agentRole);
        console.log(`granted restricted agent API to ${rest[0] || store.agentRole}`);
        return 0;
      }
      case "reap": {
        console.log(JSON.stringify(await store.reap(actor)));
        return 0;
      }
      case "reservations": {
        console.log(JSON.stringify(await store.listReservations({ open: rest[0] !== "all" }), null, 2));
        return 0;
      }
      case "clear-runtime": {
        await store.setApprovedRuntime(null, actor);
        console.log(JSON.stringify(await store.getState()));
        return 0;
      }
      case "release": {
        console.log((await store.releaseReservation(rest[0], rest.slice(1).join(" ") || "operator release", actor)) ? "released" : "not releasable");
        return 0;
      }
      case "mark-dead": {
        console.log((await store.markDead(rest[0], rest.slice(1).join(" ") || "operator", actor)) ? "marked dead" : "not living");
        return 0;
      }
      default:
        console.error(
          "usage: fleet:admin migrate|health|status|set-cap N|set-mode MODE|approve-runtime|clear-runtime|build-identity DIR|" +
            "set-replication on|off|set-timeouts k=S…|enroll-root WALLET NAME|rotate-credential ID|grant-agent-role|reap|reservations|release ID|mark-dead ID",
        );
        return 2;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    await store.close();
  }
}

if (process.argv[1] && /fleet[\\/]postgres[\\/]cli\.(ts|js)$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

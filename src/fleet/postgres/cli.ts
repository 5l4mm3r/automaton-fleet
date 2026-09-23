/**
 * Operator CLI for the shared fleet registry. Not an agent tool; the shell
 * guard forbids agents from invoking it.
 *
 *   pnpm fleet:migrate
 *   pnpm fleet:admin status | health
 *   pnpm fleet:admin set-cap <1..50>
 *   pnpm fleet:admin set-mode <DEVELOPMENT|EXPANSION|HARVEST|EMERGENCY> [reason]
 *   pnpm fleet:admin approve-runtime          (uses FLEET_RUNTIME_REPO / FLEET_RUNTIME_COMMIT)
 *   pnpm fleet:admin clear-runtime
 *   pnpm fleet:admin release <agentId> [reason]
 *   pnpm fleet:admin mark-dead <agentId> [reason]
 *
 * DATABASE_URL is read from the environment, else from .env.fleet. It is
 * never printed.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { isFleetState } from "../config.js";
import { validateRuntimePin } from "../runtime.js";
import { PgFleetStore } from "./store.js";

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
  const store = PgFleetStore.fromEnv(e);
  if (!store) {
    console.error("DATABASE_URL is not configured (environment or .env.fleet).");
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
        await store.setApprovedRuntime(v.pin, actor);
        console.log(JSON.stringify(await store.getState()));
        return 0;
      }
      case "clear-runtime": {
        await store.setApprovedRuntime(null, actor);
        console.log(JSON.stringify(await store.getState()));
        return 0;
      }
      case "release": {
        console.log((await store.releaseReservation(rest[0], rest.slice(1).join(" ") || "operator release")) ? "released" : "not releasable");
        return 0;
      }
      case "mark-dead": {
        console.log((await store.markDead(rest[0], rest.slice(1).join(" ") || "operator", actor)) ? "marked dead" : "not living");
        return 0;
      }
      default:
        console.error("usage: fleet:admin migrate|health|status|set-cap N|set-mode MODE|approve-runtime|clear-runtime|release ID|mark-dead ID");
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

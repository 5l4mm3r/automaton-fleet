/**
 * Throwaway PostgreSQL cluster for role/privilege tests (Phase 3).
 *
 * Privilege separation can only be tested with real roles, and the fleet
 * owner role (like production's fleetadmin) cannot create roles. So tests
 * initdb a private cluster in a temp dir (we are its superuser), listening
 * on 127.0.0.1 with scram-sha-256 password auth, and set it up exactly as a
 * DBA would: a non-superuser owner, then scripts/fleet-db-roles.sql.
 */

import { execFileSync } from "child_process";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { randomBytes } from "crypto";

export interface EphemeralPg {
  port: number;
  dbname: string;
  ownerUrl: string;
  agentUrl: string;
  serviceUrl: string;
  /** Schema v8 read-only Operator API login. */
  operatorUrl: string;
  superUrl: string;
  /** Re-run scripts/fleet-db-roles.sql (idempotency tests). */
  applyRoles(): void;
  stop(): void;
}

export function findPgBin(): string | null {
  const candidates = [process.env.PG_BIN];
  try {
    candidates.push(execFileSync("pg_config", ["--bindir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch {
    // no pg_config on PATH
  }
  try {
    for (const v of fs.readdirSync("/usr/lib/postgresql").sort((a, b) => Number(b) - Number(a))) {
      candidates.push(`/usr/lib/postgresql/${v}/bin`);
    }
  } catch {
    // not a Debian-style install
  }
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, "initdb")) && fs.existsSync(path.join(c, "pg_ctl")) && fs.existsSync(path.join(c, "psql"))) return c;
  }
  return null;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export async function startEphemeralPg(bin: string): Promise<EphemeralPg> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-pg-"));
  const data = path.join(dir, "data");
  const superPw = randomBytes(12).toString("hex");
  const ownerPw = randomBytes(12).toString("hex");
  const agentPw = randomBytes(12).toString("hex");
  const servicePw = randomBytes(12).toString("hex");
  const operatorPw = randomBytes(12).toString("hex");
  const pwfile = path.join(dir, "pw");
  fs.writeFileSync(pwfile, superPw + "\n", { mode: 0o600 });
  execFileSync(path.join(bin, "initdb"), ["-D", data, "-U", "postgres", "--pwfile", pwfile, "--auth=scram-sha-256", "-E", "UTF8"], {
    stdio: "ignore",
  });
  const port = await freePort();
  execFileSync(
    path.join(bin, "pg_ctl"),
    ["-D", data, "-l", path.join(dir, "log"), "-w", "-o", `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c max_connections=200`, "start"],
    { stdio: "ignore" },
  );
  const stop = () => {
    try {
      execFileSync(path.join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"], { stdio: "ignore" });
    } catch {
      // already stopped
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    const dbname = "fleet_t";
    const superUrl = `postgresql://postgres:${superPw}@127.0.0.1:${port}/postgres`;
    const psql = (url: string, args: string[], input?: string) =>
      execFileSync(path.join(bin, "psql"), [url, "-X", "-v", "ON_ERROR_STOP=1", "-q", ...args], {
        stdio: [input === undefined ? "ignore" : "pipe", "ignore", "pipe"],
        input,
        env: { ...process.env, PGPASSWORD: superPw }, // for \connect inside the role script
      });
    // Same invocation as scripts/fleet-db-setup.sh: passwords on stdin, never argv.
    const applyRoles = () =>
      psql(
        superUrl,
        ["-v", `dbname=${dbname}`, "-v", "owner=fleet_owner", "-f", "-"],
        `\\set agent_password ${agentPw}\n\\set service_password ${servicePw}\n\\set operator_password ${operatorPw}\n` +
          fs.readFileSync(path.resolve("scripts/fleet-db-roles.sql"), "utf8"),
      );
    // Owner: like production fleetadmin — not a superuser, cannot create roles.
    psql(superUrl, ["-c", `CREATE ROLE fleet_owner LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB PASSWORD '${ownerPw}'`]);
    psql(superUrl, ["-c", `CREATE DATABASE ${dbname} OWNER fleet_owner`]);
    applyRoles();
    return {
      port,
      dbname,
      superUrl,
      ownerUrl: `postgresql://fleet_owner:${ownerPw}@127.0.0.1:${port}/${dbname}`,
      agentUrl: `postgresql://fleet_agent_login:${agentPw}@127.0.0.1:${port}/${dbname}`,
      serviceUrl: `postgresql://fleet_service_login:${servicePw}@127.0.0.1:${port}/${dbname}`,
      operatorUrl: `postgresql://fleet_operator_login:${operatorPw}@127.0.0.1:${port}/${dbname}`,
      applyRoles,
      stop,
    };
  } catch (err) {
    stop();
    throw err;
  }
}

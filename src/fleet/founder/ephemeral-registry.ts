/**
 * Throwaway fleet registry for the real-runtime Genesis rehearsal (Phase F.1).
 *
 * A private PostgreSQL cluster in a fresh temporary directory, run as an
 * unprivileged OS user (production: `postgres`), listening on a random
 * loopback port with scram-sha-256 passwords generated here and never shown.
 * It is set up exactly like production: a non-superuser schema owner, the
 * repository's scripts/fleet-db-roles.sql, then the migrations. It has NO
 * connection to the production registry: rehearsal founders can become
 * living in it without the production population ever changing. stop()
 * deletes the whole cluster.
 */

import { execFileSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";

export interface EphemeralRegistry {
  ownerUrl: string;
  agentUrl: string;
  serviceUrl: string;
  operatorUrl: string;
  custodyUrl: string;
  dir: string;
  port: number;
  stop(): void;
}

export function findPostgresBin(): string | null {
  const candidates: string[] = [];
  try {
    for (const v of fs.readdirSync("/usr/lib/postgresql").sort((a, b) => Number(b) - Number(a))) candidates.push(`/usr/lib/postgresql/${v}/bin`);
  } catch {
    // not a Debian-style install
  }
  for (const c of candidates) {
    if (["initdb", "pg_ctl", "psql"].every((b) => fs.existsSync(path.join(c, b)))) return c;
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

export async function startEphemeralRegistry(opts: { bin: string; rolesSql: string; runAs?: string; parent?: string }): Promise<EphemeralRegistry> {
  const runAs = opts.runAs;
  const asUser = (file: string, args: string[], input?: string) =>
    execFileSync(runAs ? "runuser" : file, runAs ? ["-u", runAs, "--", file, ...args] : args, {
      stdio: [input === undefined ? "ignore" : "pipe", "ignore", "pipe"],
      input,
    });
  const dir = fs.mkdtempSync(path.join(opts.parent ?? os.tmpdir(), "fleet-rehearsal-registry-"));
  fs.chmodSync(dir, 0o700);
  if (runAs) {
    const uid = Number(execFileSync("id", ["-u", runAs], { encoding: "utf8" }).trim());
    const gid = Number(execFileSync("id", ["-g", runAs], { encoding: "utf8" }).trim());
    fs.chownSync(dir, uid, gid);
  }
  const pw = () => crypto.randomBytes(18).toString("hex");
  const superPw = pw();
  const ownerPw = pw();
  const agentPw = pw();
  const servicePw = pw();
  const operatorPw = pw();
  const custodyPw = pw();
  const data = path.join(dir, "data");
  const pwfile = path.join(dir, "pw");
  fs.writeFileSync(pwfile, superPw + "\n", { mode: 0o600 });
  if (runAs) fs.chownSync(pwfile, fs.statSync(dir).uid, fs.statSync(dir).gid);
  const port = await freePort();
  const stop = () => {
    try {
      asUser(path.join(opts.bin, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"]);
    } catch {
      // already stopped
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    asUser(path.join(opts.bin, "initdb"), ["-D", data, "-U", "postgres", "--pwfile", pwfile, "--auth=scram-sha-256", "-E", "UTF8"]);
    fs.rmSync(pwfile, { force: true });
    asUser(path.join(opts.bin, "pg_ctl"), [
      "-D", data, "-l", path.join(dir, "log"), "-w",
      "-o", `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c max_connections=100`,
      "start",
    ]);
    const dbname = "fleet_rehearsal";
    const superUrl = `postgresql://postgres:${superPw}@127.0.0.1:${port}/postgres`;
    const psql = (args: string[], input?: string) =>
      execFileSync(path.join(opts.bin, "psql"), [superUrl, "-X", "-v", "ON_ERROR_STOP=1", "-q", ...args], {
        stdio: [input === undefined ? "ignore" : "pipe", "ignore", "pipe"],
        input,
        env: { ...process.env, PGPASSWORD: superPw },
      });
    psql(["-c", `CREATE ROLE fleet_owner LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB PASSWORD '${ownerPw}'`]);
    psql(["-c", `CREATE DATABASE ${dbname} OWNER fleet_owner`]);
    psql(
      ["-v", `dbname=${dbname}`, "-v", "owner=fleet_owner", "-f", "-"],
      `\\set agent_password ${agentPw}\n\\set service_password ${servicePw}\n\\set operator_password ${operatorPw}\n\\set custody_password ${custodyPw}\n` +
        fs.readFileSync(opts.rolesSql, "utf8"),
    );
    const u = (user: string, p: string) => `postgresql://${user}:${p}@127.0.0.1:${port}/${dbname}`;
    return {
      ownerUrl: u("fleet_owner", ownerPw),
      agentUrl: u("fleet_agent_login", agentPw),
      serviceUrl: u("fleet_service_login", servicePw),
      operatorUrl: u("fleet_operator_login", operatorPw),
      custodyUrl: u("fleet_custody_login", custodyPw),
      dir,
      port,
      stop,
    };
  } catch (err) {
    stop();
    throw err;
  }
}

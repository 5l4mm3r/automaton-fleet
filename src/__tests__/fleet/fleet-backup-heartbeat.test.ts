/**
 * Recovery and the outside monitor (owner instruction 2026-10-16), against REAL tools locally: restic (a pinned, checksum-
 * verified binary from FLEET_TEST_RESTIC), a throw-away PostgreSQL registry and a fake monitor that records pings.
 * Nothing here touches a real storage provider or monitoring service.
 *
 * Proven: the repository is created only on request; a backup holds the database dump, the roles (no passwords), a manifest
 * and the chosen file trees, and leaves out excluded key material; the drill restores the newest backup into a scratch
 * database, checks schema version and the ledger's own verification, and drops the scratch database; a failure pings the
 * monitor's /fail with the failed step; no secret is printed. The heartbeat pings "ok" when everything answers, and /fail
 * with the names of what failed (a service down, a unit that gave up restarting).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawn } from "child_process";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, type EconomyRegistry } from "./fixtures/economy-registry.js";

const PG_BIN = findPgBin();
const RESTIC = process.env.FLEET_TEST_RESTIC ?? null;
const ROOT = path.resolve(__dirname, "../../..");
const BACKUP = path.join(ROOT, "scripts/fleet-backup.sh");
const HEARTBEAT = path.join(ROOT, "scripts/fleet-heartbeat.sh");

describe.skipIf(!PG_BIN || !RESTIC || !fs.existsSync(RESTIC ?? ""))("backups (restic + PostgreSQL) and the heartbeat (fake monitor)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let dir = "";
  let monitor: http.Server;
  let MON = "";
  const pings: Array<{ path: string; body: string }> = [];
  let env: Record<string, string> = {};
  const PASSWORD = "correct horse restic password for the test";

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000, treasuryCents: 100_000 });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-backup-"));
    fs.mkdirSync(path.join(dir, "secrets"), { mode: 0o700 });
    fs.writeFileSync(path.join(dir, "secrets/restic-password"), PASSWORD, { mode: 0o600 });
    fs.mkdirSync(path.join(dir, "state/workspace"), { recursive: true });
    fs.writeFileSync(path.join(dir, "state/workspace/product.xlsx"), "a product asset");
    fs.mkdirSync(path.join(dir, "state/escrow"), { recursive: true });
    fs.writeFileSync(path.join(dir, "state/escrow/custody.key"), "KEY MATERIAL IN SEPARATE ESCROW");
    monitor = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { pings.push({ path: req.url ?? "", body: b }); res.end("OK"); }); });
    await new Promise<void>((r) => monitor.listen(0, "127.0.0.1", () => r()));
    MON = `http://127.0.0.1:${(monitor.address() as { port: number }).port}`;
    const u = new URL(R.pgc.superUrl);
    env = {
      PATH: `${PG_BIN}:${process.env.PATH}`, HOME: dir, PGHOST: u.hostname, PGPORT: u.port, PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password),
      RESTIC_REPOSITORY: path.join(dir, "repo"), FLEET_BACKUP_SECRETS: path.join(dir, "secrets"), FLEET_BACKUP_RESTIC: RESTIC!, RESTIC_CACHE_DIR: path.join(dir, "cache"),
      FLEET_BACKUP_DB: new URL(R.pgc.ownerUrl).pathname.slice(1), FLEET_BACKUP_STAGING: path.join(dir, "staging"),
      FLEET_BACKUP_PSQL: "psql -X -tA -v ON_ERROR_STOP=1", FLEET_BACKUP_PG_DUMP: "pg_dump", FLEET_BACKUP_PG_DUMPALL: "pg_dumpall", FLEET_BACKUP_PG_RESTORE: "pg_restore",
      FLEET_BACKUP_PATHS: path.join(dir, "state"), FLEET_BACKUP_EXCLUDES: path.join(dir, "state/escrow"), FLEET_BACKUP_PING_URL: `${MON}/backup`,
    };
  }, 300_000);
  afterAll(async () => { monitor?.close(); await R?.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  /** Run a script WITHOUT blocking the event loop (the fake monitor answers in this process). */
  const run = (file: string, args: string[], e: Record<string, string>) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const c = spawn("bash", [file, ...args], { env: e });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d)); c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  const backup = (cmd: string, extra: Record<string, string> = {}) => run(BACKUP, [cmd], { ...env, ...extra });
  const restic = (...a: string[]) => execFileSync(RESTIC!, a, { env: { ...env, RESTIC_PASSWORD_FILE: path.join(dir, "secrets/restic-password") }, encoding: "utf8" });

  it("the database tools never open a staging path themselves: they stream through root (postgres cannot enter the 0700 staging directory)", () => {
    // Found on the production host 2026-10-17: `pg_dump -f <staging>/…` as postgres → "Permission denied", backup failed.
    const src = fs.readFileSync(BACKUP, "utf8");
    expect(src).toMatch(/\$PG_DUMP -Fc -Z0 -d "\$DB" > "\$work\/db\.dump"/);
    expect(src).toMatch(/\$PG_RESTORE --no-owner --no-privileges -d "\$scratch" < "\$dump"/);
    expect(src).not.toMatch(/\$PG_DUMP[^\n]* -f /);
    expect(src).not.toMatch(/chmod 0755 "\$work"/);
  });

  it("a backup needs an initialised repository: run refuses (and tells the monitor) until init; init happens only on request", async () => {
    const r0 = await backup("run");
    expect(r0.status).not.toBe(0);
    expect(pings.at(-1)).toEqual({ path: "/backup/fail", body: "repository not reachable or not initialised" });
    expect((await backup("init")).status).toBe(0);
    expect((await backup("init")).stdout).toContain("already initialised");
  });

  it("run: database dump + roles + manifest + file trees, excluded key material left out; the monitor hears start and success; no secret printed", async () => {
    pings.length = 0;
    const r = await backup("run");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(pings.map((p) => p.path)).toEqual(["/backup/start", "/backup"]);
    expect(pings[1].body).toMatch(/^schema \d+$/);
    const snaps = JSON.parse(restic("snapshots", "--json"));
    expect(snaps).toHaveLength(1);
    expect(snaps[0].tags).toEqual(expect.arrayContaining(["fleet", expect.stringMatching(/^schema-\d+$/)]));
    const files = restic("ls", "latest");
    expect(files).toMatch(/\/db\.dump$/m);
    expect(files).toMatch(/\/globals\.sql$/m);
    expect(files).toMatch(/\/MANIFEST$/m);
    expect(files).toContain("product.xlsx");
    expect(files).not.toContain("custody.key");
    const manifest = restic("dump", "latest", files.split("\n").find((l) => l.endsWith("/FILES.sha256"))!);
    expect(manifest).toMatch(/^[0-9a-f]{64}  .*\/state\/workspace\/product\.xlsx$/m);
    expect(manifest).not.toContain("custody.key"); // escrowed key material is neither backed up nor listed
    const globals = restic("dump", "latest", files.split("\n").find((l) => l.endsWith("/globals.sql"))!);
    expect(globals).toMatch(/CREATE ROLE/);
    expect(globals).not.toMatch(/PASSWORD '|SCRAM-SHA-256\$/);
    for (const out of [r.stdout, r.stderr]) { expect(out).not.toContain(PASSWORD); expect(out).not.toContain(env.PGPASSWORD); }
  });

  it("drill: the newest backup restores into a scratch database, the schema matches, the ledger verifies, the scratch database is dropped", async () => {
    pings.length = 0;
    const r = await backup("drill");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/drill ok: snapshot \w+ restored, schema \d+, ledger verifies \(\d+ journals\), [1-9]\d* sample files verified/);
    expect(pings.at(-1)!.path).toBe("/backup");
    const left = execFileSync("psql", ["-X", "-tA", "-d", "postgres", "-c", "SELECT count(*) FROM pg_database WHERE datname LIKE 'fleet_restore_drill_%'"], { env, encoding: "utf8" }).trim();
    expect(left).toBe("0");
  });

  it("key recovery: the owner's separate escrow password (restic key add) restores everything without the server's password", async () => {
    fs.mkdirSync(path.join(dir, "escrow-secrets"), { mode: 0o700 });
    const escrow = "the owner's offline escrow password, kept on paper";
    fs.writeFileSync(path.join(dir, "escrow-secrets/restic-password"), escrow, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "new-key"), escrow, { mode: 0o600 });
    restic("key", "add", "--new-password-file", path.join(dir, "new-key"));
    fs.rmSync(path.join(dir, "new-key"));
    pings.length = 0;
    const r = await backup("drill", { FLEET_BACKUP_SECRETS: path.join(dir, "escrow-secrets") });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/sample files verified/);
    expect(r.stdout + r.stderr).not.toContain(escrow);
  });

  it("a wrong password or a broken repository fails loudly to the monitor, never silently", async () => {
    pings.length = 0;
    fs.writeFileSync(path.join(dir, "secrets/wrong"), "not the password", { mode: 0o600 });
    fs.mkdirSync(path.join(dir, "wrong-secrets"), { mode: 0o700 });
    fs.copyFileSync(path.join(dir, "secrets/wrong"), path.join(dir, "wrong-secrets/restic-password"));
    const r = await backup("drill", { FLEET_BACKUP_SECRETS: path.join(dir, "wrong-secrets") });
    expect(r.status).not.toBe(0);
    expect(pings.at(-1)!.path).toBe("/backup/fail");
  });

  it("heartbeat: 'ok' when everything answers; /fail naming what failed (a service down, a unit that gave up restarting); a dead server sends nothing", async () => {
    const up = http.createServer((_q, s) => { s.end("ok"); });
    await new Promise<void>((r) => up.listen(0, "127.0.0.1", () => r()));
    const UP = `http://127.0.0.1:${(up.address() as { port: number }).port}`;
    fs.writeFileSync(path.join(dir, "secrets/heartbeat-url"), `${MON}/hb\n`, { mode: 0o600 });
    const base = { PATH: process.env.PATH!, FLEET_HB_PING_FILE: path.join(dir, "secrets/heartbeat-url"), FLEET_HB_CONTROLLER: `${UP}/readyz`, FLEET_HB_DASHBOARD: `${UP}/login/`,
      FLEET_HB_OPERATOR: `${UP}/readyz`, FLEET_HB_PG_READY: "true", FLEET_HB_REDIS_PING: "echo PONG", FLEET_HB_TLS_CONNECT: "none", FLEET_HB_FAILED_UNITS: "true", FLEET_HB_DISK_PATH: dir };
    const hb = (extra: Record<string, string> = {}) => run(HEARTBEAT, [], { ...base, ...extra });
    try {
      pings.length = 0;
      expect((await hb()).status).toBe(0);
      expect(pings).toEqual([{ path: "/hb", body: "ok" }]);
      const down = await hb({ FLEET_HB_CONTROLLER: "http://127.0.0.1:1/readyz", FLEET_HB_FAILED_UNITS: "echo automaton-fleet-push.service loaded failed failed" });
      expect(down.status).not.toBe(0);
      expect(pings.at(-1)).toEqual({ path: "/hb/fail", body: "FAIL controller failed-units:automaton-fleet-push.service" });
      // Without a monitor URL nothing is sent (and nothing secret is ever printed).
      pings.length = 0;
      expect((await hb({ FLEET_HB_PING_FILE: "/nonexistent" })).stdout.trim()).toBe("ok");
      expect(pings).toEqual([]);
    } finally { up.close(); }
  });
});

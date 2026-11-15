/**
 * The isolated build environment (schema v89): runs an agent's commands on a customer repository snapshot (plus, when
 * given, the agent's patch) and records what happened. It holds no credentials of any kind. Each job:
 *   - a fresh 0700 directory; the snapshot tarball unpacked (top-level directory stripped; no absolute paths, no "..",
 *     no links pointing outside), the patch applied strictly (exact context, else the job fails);
 *   - each command run in the Landlock sandbox (read-only system, this directory only), with the egress proxy as the only
 *     reachable port (package registries only), a time limit, and its output kept (the tail);
 *   - passed = every command exited 0 within its limit; the directory is removed afterwards.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import pg from "pg";
import { runSandboxed } from "../founder/exec-sandbox.js";
import { applyFile, parsePatch } from "../code/patch.js";

export class PgBuildPort {
  private readonly pool: pg.Pool;
  constructor(o: { connectionString: string; schema?: string }) {
    const schema = o.schema ?? "fleet";
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("bad schema");
    this.pool = new pg.Pool({ connectionString: o.connectionString, max: 2, options: `-c search_path=${schema}` });
    this.pool.on("error", () => {});
  }
  private async one<T>(sql: string, args: unknown[]): Promise<T> { return (await this.pool.query(sql, args)).rows[0].r as T; }
  report(configured: boolean, detail: Record<string, unknown>) { return this.one<{ ok: boolean; schemaVersion?: number }>(`SELECT bbx_report($1, $2::jsonb) AS r`, [configured, JSON.stringify(detail)]); }
  claim(limit: number) { return this.one<Array<{ jobId: string; commands: string[]; patch: string | null; tarballB64: string }>>(`SELECT bbx_claim($1) AS r`, [limit]); }
  result(jobId: string, ok: boolean, result: unknown, error: string | null) { return this.one(`SELECT bbx_result($1, $2, $3::jsonb, $4) AS r`, [jobId, ok, JSON.stringify(result), error]); }
  close() { return this.pool.end(); }
}

export interface BuildOptions { proxyPort: number | null; commandTimeoutMs?: number; totalTimeoutMs?: number; maxOutput?: number; workRoot?: string; python?: string }

/** Unpack a GitHub tarball safely into `dir` (refuses absolute paths, "..", and links). */
export function unpackSnapshot(tarball: Buffer, dir: string): void {
  const tgz = path.join(dir, ".snapshot.tar.gz");
  fs.writeFileSync(tgz, tarball, { mode: 0o600 });
  const list = spawnSync("tar", ["-tvzf", tgz], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (list.status !== 0) throw new Error("the snapshot is not a readable tarball");
  for (const l of list.stdout.split("\n").filter(Boolean)) {
    if (!/^[-d]/.test(l)) throw new Error("the snapshot contains links or special files");
    const name = l.split(/\s+/).slice(5).join(" ");
    if (name.startsWith("/") || name.split("/").includes("..")) throw new Error("the snapshot contains unsafe paths");
  }
  const src = path.join(dir, "src");
  fs.mkdirSync(src, { mode: 0o700 });
  const x = spawnSync("tar", ["-xzf", tgz, "-C", src, "--strip-components=1", "--no-same-owner", "--no-same-permissions"], { encoding: "utf8" });
  if (x.status !== 0) throw new Error("the snapshot could not be unpacked");
  fs.rmSync(tgz, { force: true });
}

/** Apply a patch to the unpacked files (strict). */
export function applyPatchTo(root: string, patch: string): number {
  const changes = parsePatch(patch);
  for (const ch of changes) {
    const p = path.join(root, ch.path);
    if (!p.startsWith(root + path.sep)) throw new Error("unsafe path");
    const cur = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
    const next = applyFile(ch, cur);
    if (next === null) fs.rmSync(p);
    else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, next); }
  }
  return changes.length;
}

export async function runBuild(job: { commands: string[]; patch: string | null; tarballB64: string }, o: BuildOptions) {
  const dir = fs.mkdtempSync(path.join(o.workRoot ?? os.tmpdir(), "fleet-build-"));
  fs.chmodSync(dir, 0o700);
  const started = Date.now();
  const steps: Array<{ command: string; exitCode: number | null; timedOut: boolean; durationMs: number; output: string }> = [];
  try {
    unpackSnapshot(Buffer.from(job.tarballB64, "base64"), dir);
    const src = path.join(dir, "src");
    const files = job.patch ? applyPatchTo(src, job.patch) : 0;
    const env: Record<string, string> = o.proxyPort ? {
      HTTPS_PROXY: `http://127.0.0.1:${o.proxyPort}`, https_proxy: `http://127.0.0.1:${o.proxyPort}`, npm_config_https_proxy: `http://127.0.0.1:${o.proxyPort}`,
      PIP_PROXY: `http://127.0.0.1:${o.proxyPort}`, CI: "true" } : { CI: "true" };
    let passed = true;
    for (const command of job.commands.slice(0, 5)) {
      const left = (o.totalTimeoutMs ?? 20 * 60_000) - (Date.now() - started);
      if (left <= 0) { steps.push({ command, exitCode: null, timedOut: true, durationMs: 0, output: "not run: the build's time limit was reached" }); passed = false; break; }
      const t0 = Date.now();
      const r = await runSandboxed(src, command, { timeoutMs: Math.min(o.commandTimeoutMs ?? 10 * 60_000, left), maxOutput: o.maxOutput ?? 200_000, python: o.python,
        ...(o.proxyPort ? { connectPort: o.proxyPort } : {}), extraEnv: env });
      if (r.sandboxUnavailable) throw new Error("the build sandbox is unavailable on this host");
      const out = r.output.length > 16_000 ? `…${r.output.slice(-16_000)}` : r.output;
      steps.push({ command, exitCode: r.code, timedOut: r.timedOut, durationMs: Date.now() - t0, output: out });
      if (r.code !== 0 || r.timedOut) { passed = false; break; }
    }
    return { passed, patchedFiles: files, steps, durationMs: Date.now() - started };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export class BuildWorker {
  constructor(private readonly port: PgBuildPort, private readonly o: BuildOptions, private readonly log: (level: string, event: string, detail: Record<string, unknown>) => void = () => {}) {}
  async tick(): Promise<{ done: number; failed: number }> {
    await this.port.report(true, { proxy: this.o.proxyPort ? "egress proxy (package registries only)" : "no network" });
    let done = 0, failed = 0;
    for (const j of await this.port.claim(1)) {
      try {
        const r = await runBuild(j, this.o);
        await this.port.result(j.jobId, true, r, null);
        done++;
      } catch (e) {
        failed++;
        const msg = String((e as Error).message ?? e).slice(0, 280);
        await this.port.result(j.jobId, false, { passed: false, error: msg }, msg);
        this.log("warn", "build_failed", { jobId: j.jobId, error: msg });
      }
    }
    return { done, failed };
  }
}

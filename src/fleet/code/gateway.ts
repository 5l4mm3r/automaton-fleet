/**
 * The code gateway (schema v89): the only holder of the Fleet GitHub App's key. Each pass:
 *   1. reports itself (configured or not, the app's install link);
 *   2. reconciles access: a CONSENTED request becomes active when an installation grants exactly that repository; an
 *      ACTIVE one ends when no installation grants it any more (the customer uninstalled the app or removed the repo);
 *   3. runs snapshot and proposal jobs (each once; a failure is recorded, never retried silently).
 */
import pg from "pg";
import type { GitHubApp } from "./github.js";

export class PgCodeGateway {
  private readonly pool: pg.Pool;
  constructor(o: { connectionString: string; schema?: string }) {
    const schema = o.schema ?? "fleet";
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("bad schema");
    this.pool = new pg.Pool({ connectionString: o.connectionString, max: 2, options: `-c search_path=${schema}` });
    this.pool.on("error", () => {});
  }
  private async one<T>(sql: string, args: unknown[]): Promise<T> { return (await this.pool.query(sql, args)).rows[0].r as T; }
  report(configured: boolean, detail: Record<string, unknown>) { return this.one<{ ok: boolean; schemaVersion?: number }>(`SELECT cgx_report('github', $1, $2::jsonb) AS r`, [configured, JSON.stringify(detail)]); }
  authorizations() { return this.one<Array<{ authorizationId: string; repo: string; status: string; installationId: number | null }>>(`SELECT cgx_authorizations(200) AS r`, []); }
  activate(id: string, installationId: number, repo: string) { return this.one(`SELECT cgx_activate($1, $2, $3) AS r`, [id, installationId, repo]); }
  end(id: string, reason: string) { return this.one(`SELECT cgx_end($1, $2) AS r`, [id, reason]); }
  claim(limit: number) {
    return this.one<Array<{ jobId: string; kind: "snapshot" | "propose"; request: Record<string, any>; patch: string | null; repo: string; baseBranch: string; installationId: number; branch: string }>>(
      `SELECT cgx_claim($1) AS r`, [limit]);
  }
  result(jobId: string, ok: boolean, result: unknown, payload: Buffer | null, error: string | null) {
    return this.one(`SELECT cgx_result($1, $2, $3::jsonb, $4, $5) AS r`, [jobId, ok, result === null ? null : JSON.stringify(result), payload, error]);
  }
  close() { return this.pool.end(); }
}

export class CodeGatewayWorker {
  constructor(private readonly gw: PgCodeGateway, private readonly app: GitHubApp | null, private readonly detail: { appSlug: string | null },
    private readonly log: (level: string, event: string, detail: Record<string, unknown>) => void = () => {}) {}

  async tick(): Promise<{ activated: number; ended: number; done: number; failed: number }> {
    const installUrl = this.detail.appSlug ? `https://github.com/apps/${this.detail.appSlug}/installations/new` : null;
    await this.gw.report(this.app !== null, { appSlug: this.detail.appSlug, installUrl });
    let activated = 0, ended = 0, done = 0, failed = 0;
    if (!this.app) return { activated, ended, done, failed };
    const inst = await this.app.installations();
    for (const a of await this.gw.authorizations()) {
      const grant = inst.find((i) => i.repos.includes(a.repo.toLowerCase()));
      if (a.status === "consented" && grant) { await this.gw.activate(a.authorizationId, grant.id, a.repo); activated++; }
      else if (a.status === "active" && (!grant || grant.id !== a.installationId)) { await this.gw.end(a.authorizationId, "the Fleet's app no longer has access to this repository"); ended++; }
    }
    for (const j of await this.gw.claim(4)) {
      try {
        if (j.kind === "snapshot") {
          const s = await this.app.snapshot(j.installationId, j.repo, String(j.request.ref ?? j.baseBranch));
          await this.gw.result(j.jobId, true, { sha: s.sha, ref: j.request.ref ?? j.baseBranch, bytes: s.tarball.length }, s.tarball, null);
        } else {
          const p = await this.app.propose({ installationId: j.installationId, repo: j.repo, baseBranch: String(j.request.baseBranch ?? j.baseBranch), baseSha: String(j.request.baseSha),
            branch: j.branch, patch: j.patch ?? "", title: String(j.request.title), body: proposalBody(String(j.request.body ?? ""), String(j.request.baseSha), j.branch, String(j.request.baseBranch ?? j.baseBranch)) });
          await this.gw.result(j.jobId, true, p, null, null);
        }
        done++;
      } catch (e) {
        failed++;
        const msg = String((e as Error).message ?? e).slice(0, 280);
        await this.gw.result(j.jobId, false, null, null, msg);
        this.log("warn", "code_job_failed", { jobId: j.jobId, kind: j.kind, error: msg });
      }
    }
    return { activated, ended, done, failed };
  }
}

/** The pull request says what it is and how to undo it (recovery is part of every change). */
export function proposalBody(body: string, baseSha: string, branch: string, baseBranch: string): string {
  return `${body.trim()}\n\n---\nProposed by an autonomous AI agent of the Automaton Fleet, tested in its isolated build environment before opening.\n`
    + `Base: \`${baseBranch}\` at ${baseSha}. Branch: \`${branch}\`. Nothing is merged without you; to undo after merging, revert this pull request.`;
}

/**
 * The Fleet's GitHub App client (schema v89; the code gateway's only provider). Built against GitHub's REST API; tested
 * against a SIMULATED GitHub. What it can do is deliberately narrow:
 *   - list the app's installations and the repositories each one grants (the customer chose them when installing);
 *   - mint an installation token for ONE repository with the permissions a job needs (contents read for a snapshot;
 *     contents + pull_requests write for a proposal) — never broader, never stored;
 *   - read a commit and its tarball;
 *   - write a proposal: blobs, a tree on the base commit, a commit, a NEW ref under refs/heads/fleet/ (create only — it
 *     refuses to update or force any ref), and a pull request to the consented base branch.
 * There is no code path that updates a branch, merges, deletes, or touches settings.
 */
import crypto from "crypto";
import { applyFile, parsePatch, PatchError } from "./patch.js";

export const GITHUB_API = "https://api.github.com";
export const GITHUB_CODELOAD = "https://codeload.github.com";
export type GitHubHttp = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) =>
  Promise<{ status: number; headers: { get(n: string): string | null }; json(): Promise<unknown>; bytes(): Promise<Buffer> }>;

const REPO = /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;

/** The app's own JWT (RS256, 9 minutes), from its private key — used only to mint installation tokens. */
export function appJwt(appId: string, privateKeyPem: string, nowS = Math.floor(Date.now() / 1000)): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: nowS - 60, exp: nowS + 540, iss: appId })}`;
  return `${head}.${crypto.sign("RSA-SHA256", Buffer.from(head), privateKeyPem).toString("base64url")}`;
}

export class GitHubApp {
  constructor(private readonly o: { appId: string; privateKeyPem: string; http: GitHubHttp; api?: string }) {
    if (!/^\d{1,12}$/.test(o.appId)) throw new Error("GitHub App id is numeric");
  }
  private get api() { return this.o.api ?? GITHUB_API; }
  private async call<T>(method: string, path: string, auth: string, body?: unknown): Promise<T> {
    const r = await this.o.http(`${this.api}${path}`, { method, headers: { Authorization: auth, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (r.status < 200 || r.status >= 300) throw new Error(`GITHUB_HTTP_${r.status} ${method} ${path.replace(/\?.*$/, "")}`);
    return (r.status === 204 ? {} : await r.json()) as T;
  }
  private jwt() { return `Bearer ${appJwt(this.o.appId, this.o.privateKeyPem)}`; }

  /** Installations with the repositories each grants (owner/name, lower-cased for matching). */
  async installations(): Promise<Array<{ id: number; repos: string[] }>> {
    const inst = await this.call<Array<{ id: number }>>("GET", "/app/installations?per_page=100", this.jwt());
    const out: Array<{ id: number; repos: string[] }> = [];
    for (const i of inst.slice(0, 100)) {
      const tok = await this.token(i.id, null, { metadata: "read" });
      const r = await this.call<{ repositories: Array<{ full_name: string }> }>("GET", "/installation/repositories?per_page=100", `token ${tok}`);
      out.push({ id: i.id, repos: r.repositories.map((x) => x.full_name.toLowerCase()) });
    }
    return out;
  }

  /** An installation token, for one repository when named, with exactly these permissions. */
  async token(installationId: number, repo: string | null, permissions: Record<string, "read" | "write">): Promise<string> {
    if (repo !== null && !REPO.test(repo)) throw new Error("bad repository name");
    const r = await this.call<{ token: string }>("POST", `/app/installations/${installationId}/access_tokens`, this.jwt(),
      { ...(repo ? { repositories: [repo.split("/")[1]] } : {}), permissions });
    if (typeof r.token !== "string" || r.token.length < 20) throw new Error("GitHub returned no token");
    return r.token;
  }

  /** A snapshot: the commit a ref points at, and its tarball. */
  async snapshot(installationId: number, repo: string, ref: string): Promise<{ sha: string; tarball: Buffer }> {
    const tok = await this.token(installationId, repo, { contents: "read", metadata: "read" });
    const c = await this.call<{ sha: string }>("GET", `/repos/${repo}/commits/${encodeURIComponent(ref)}`, `token ${tok}`);
    if (!SHA.test(c.sha)) throw new Error("GitHub returned no commit");
    const r = await this.o.http(`${this.api}/repos/${repo}/tarball/${c.sha}`, { method: "GET", headers: { Authorization: `token ${tok}`, Accept: "application/vnd.github+json" } });
    if (r.status !== 200) throw new Error(`GITHUB_HTTP_${r.status} tarball`);
    return { sha: c.sha, tarball: await r.bytes() };
  }

  /**
   * A proposal: the patch applied to the base commit's files, committed on the job's own fleet/ branch, opened as a pull
   * request. v95: idempotent per job (its branch name is derived from the job): a pull request already open from that
   * branch is adopted; a branch an earlier attempt pushed gets its pull request; only what is missing is created.
   */
  async propose(o: { installationId: number; repo: string; baseBranch: string; baseSha: string; branch: string; patch: string; title: string; body: string }):
    Promise<{ pullRequestUrl: string; number: number; commitSha: string; branch: string; files: number; adopted?: "pull_request" | "branch" }> {
    if (!o.branch.startsWith("fleet/") || !/^fleet\/[a-z0-9-]{3,60}$/.test(o.branch)) throw new Error("the Fleet writes only fleet/ branches");
    if (o.branch === o.baseBranch) throw new Error("never the base branch");
    if (!SHA.test(o.baseSha)) throw new Error("bad base commit");
    const changes = parsePatch(o.patch);
    const tok = await this.token(o.installationId, o.repo, { contents: "write", pull_requests: "write", metadata: "read" });
    const auth = `token ${tok}`;
    const notFound = (e: Error) => { if (/GITHUB_HTTP_404/.test(e.message)) return null; throw e; };
    const owner = o.repo.split("/")[0];
    const open = await this.call<Array<{ html_url: string; number: number; head?: { sha?: string } }>>("GET",
      `/repos/${o.repo}/pulls?head=${encodeURIComponent(`${owner}:${o.branch}`)}&state=all`, auth).catch(notFound);
    if (Array.isArray(open) && open.length && typeof open[0].html_url === "string") {
      return { pullRequestUrl: open[0].html_url, number: open[0].number, commitSha: String(open[0].head?.sha ?? ""), branch: o.branch, files: changes.length, adopted: "pull_request" };
    }
    const pushed = await this.call<{ object?: { sha?: string } }>("GET", `/repos/${o.repo}/git/ref/heads/${o.branch.split("/").map(encodeURIComponent).join("/")}`, auth).catch(notFound);
    if (pushed?.object?.sha && SHA.test(pushed.object.sha)) {
      const pr = await this.call<{ html_url: string; number: number }>("POST", `/repos/${o.repo}/pulls`, auth, { title: o.title, head: o.branch, base: o.baseBranch, body: o.body,
        maintainer_can_modify: false, draft: false });
      return { pullRequestUrl: pr.html_url, number: pr.number, commitSha: pushed.object.sha, branch: o.branch, files: changes.length, adopted: "branch" };
    }
    const base = await this.call<{ tree: { sha: string } }>("GET", `/repos/${o.repo}/git/commits/${o.baseSha}`, auth);
    const tree: Array<{ path: string; mode: string; type: string; sha: string | null }> = [];
    for (const ch of changes) {
      let current: string | null = null;
      if (ch.kind !== "create") {
        const f = await this.call<{ content?: string; encoding?: string; type?: string }>("GET", `/repos/${o.repo}/contents/${ch.path.split("/").map(encodeURIComponent).join("/")}?ref=${o.baseSha}`, auth)
          .catch((e: Error) => { if (/GITHUB_HTTP_404/.test(e.message)) return null; throw e; });
        if (f && (f.type !== "file" || f.encoding !== "base64")) throw new PatchError(`${ch.path} is not a regular file`);
        current = f ? Buffer.from(f.content ?? "", "base64").toString("utf8") : null;
      }
      const next = applyFile(ch, current);
      if (next === null) { tree.push({ path: ch.path, mode: "100644", type: "blob", sha: null }); continue; }
      const blob = await this.call<{ sha: string }>("POST", `/repos/${o.repo}/git/blobs`, auth, { content: Buffer.from(next).toString("base64"), encoding: "base64" });
      tree.push({ path: ch.path, mode: "100644", type: "blob", sha: blob.sha });
    }
    const t = await this.call<{ sha: string }>("POST", `/repos/${o.repo}/git/trees`, auth, { base_tree: base.tree.sha, tree });
    const commit = await this.call<{ sha: string }>("POST", `/repos/${o.repo}/git/commits`, auth, { message: o.title, tree: t.sha, parents: [o.baseSha] });
    // Create only: an existing ref is a 422 from GitHub and the proposal fails — nothing is ever overwritten.
    await this.call("POST", `/repos/${o.repo}/git/refs`, auth, { ref: `refs/heads/${o.branch}`, sha: commit.sha });
    const pr = await this.call<{ html_url: string; number: number }>("POST", `/repos/${o.repo}/pulls`, auth, { title: o.title, head: o.branch, base: o.baseBranch, body: o.body,
      maintainer_can_modify: false, draft: false });
    return { pullRequestUrl: pr.html_url, number: pr.number, commitSha: commit.sha, branch: o.branch, files: changes.length };
  }
}

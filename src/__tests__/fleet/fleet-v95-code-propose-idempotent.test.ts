/**
 * v95: a pull-request proposal is idempotent per job (its branch is derived from the job). When GitHub did the work but
 * the gateway lost the answer, running the same job again adopts what exists instead of opening a second pull request:
 *  - the PR was opened, the answer lost → the re-run finds it (GET pulls?head=) and opens nothing;
 *  - the branch was pushed, the gateway died before the PR → the re-run opens the PR from that branch, creates no commit;
 * and a failure that proves nothing reached GitHub (a refusal, a bad patch) is not treated as uncertain.
 * The fake GitHub is stateful and counts every write.
 */
import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { GitHubApp, type GitHubHttp } from "../../fleet/code/github.js";
import { definitelyNotProposed } from "../../fleet/code/gateway.js";
import { PatchError } from "../../fleet/code/patch.js";

const REPO = "acme/calc";
const BASE = "a".repeat(40);
const PATCH = ["diff --git a/calc.py b/calc.py", "--- a/calc.py", "+++ b/calc.py", "@@ -1,2 +1,2 @@", " def add(a, b):", "-    return a - b", "+    return a + b", ""].join("\n");

function statefulGitHub() {
  const refs = new Map<string, string>();
  const pulls: Array<{ head: string; number: number; html_url: string; sha: string }> = [];
  const writes: string[] = [];
  let loseNext: "refs" | "pulls" | null = null;      // GitHub does the write, then the connection drops before its answer
  const http: GitHubHttp = async (url, init) => {
    const u = new URL(url);
    const p = u.pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    const ok = (status: number, j: unknown) => ({ status, headers: { get: () => null }, json: async () => j, bytes: async () => Buffer.alloc(0) });
    if (init.method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(p)) return ok(201, { token: "ghs_" + crypto.randomBytes(16).toString("hex") });
    if (init.method === "GET" && p === `/repos/${REPO}/pulls`) {
      const head = String(u.searchParams.get("head") ?? "").split(":")[1];
      return ok(200, pulls.filter((x) => x.head === head).map((x) => ({ html_url: x.html_url, number: x.number, head: { sha: x.sha } })));
    }
    const ref = /^\/repos\/acme\/calc\/git\/ref\/heads\/(.+)$/.exec(p);
    if (init.method === "GET" && ref) { const sha = refs.get(decodeURIComponent(ref[1])); return sha ? ok(200, { object: { sha } }) : ok(404, { message: "Not Found" }); }
    if (init.method === "GET" && p === `/repos/${REPO}/git/commits/${BASE}`) return ok(200, { tree: { sha: "t".repeat(40) } });
    if (init.method === "GET" && p === `/repos/${REPO}/contents/calc.py`) return ok(200, { type: "file", encoding: "base64", content: Buffer.from("def add(a, b):\n    return a - b\n").toString("base64") });
    if (init.method === "POST" && p === `/repos/${REPO}/git/blobs`) { writes.push("blob"); return ok(201, { sha: "b".repeat(40) }); }
    if (init.method === "POST" && p === `/repos/${REPO}/git/trees`) { writes.push("tree"); return ok(201, { sha: "c".repeat(40) }); }
    if (init.method === "POST" && p === `/repos/${REPO}/git/commits`) { writes.push("commit"); return ok(201, { sha: "d".repeat(40) }); }
    if (init.method === "POST" && p === `/repos/${REPO}/git/refs`) {
      const name = String(body.ref).replace(/^refs\/heads\//, "");
      if (refs.has(name)) return ok(422, { message: "Reference already exists" });
      refs.set(name, body.sha); writes.push("ref");
      if (loseNext === "refs") { loseNext = null; throw new Error("socket hang up"); }
      return ok(201, { ref: body.ref });
    }
    if (init.method === "POST" && p === `/repos/${REPO}/pulls`) {
      if (pulls.some((x) => x.head === body.head)) return ok(422, { message: "A pull request already exists" });
      const pr = { head: body.head, number: 7 + pulls.length, html_url: `https://github.com/${REPO}/pull/${7 + pulls.length}`, sha: refs.get(body.head) ?? "" };
      pulls.push(pr); writes.push("pull");
      if (loseNext === "pulls") { loseNext = null; throw new Error("ETIMEDOUT"); }
      return ok(201, { html_url: pr.html_url, number: pr.number });
    }
    return ok(404, { message: "Not Found" });
  };
  return { http, refs, pulls, writes, lose: (w: "refs" | "pulls") => { loseNext = w; } };
}

const app = (http: GitHubHttp) => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return new GitHubApp({ appId: "42", privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), http });
};
const job = (branch: string) => ({ installationId: 77, repo: REPO, baseBranch: "main", baseSha: BASE, branch, patch: PATCH, title: "Fix add()", body: "Fixes the sum." });

describe("v95: a pull-request proposal re-run after a lost answer adopts what GitHub already has", () => {
  it("the PR was opened but its answer was lost: the re-run finds it and opens nothing", async () => {
    const gh = statefulGitHub();
    const a = app(gh.http);
    gh.lose("pulls");
    await expect(a.propose(job("fleet/auth1234-job00001"))).rejects.toThrow(/ETIMEDOUT/);
    expect(definitelyNotProposed(new Error("ETIMEDOUT"))).toBe(false);          // the gateway marks it uncertain, not failed
    const again = await a.propose(job("fleet/auth1234-job00001"));
    expect(again).toMatchObject({ adopted: "pull_request", pullRequestUrl: `https://github.com/${REPO}/pull/7`, number: 7 });
    expect(gh.pulls).toHaveLength(1);
    expect(gh.writes.filter((w) => w === "pull")).toHaveLength(1);
    expect(gh.writes.filter((w) => w === "commit")).toHaveLength(1);
  });

  it("the branch was pushed and the gateway died before the PR: the re-run opens the PR from it, with no new commit", async () => {
    const gh = statefulGitHub();
    const a = app(gh.http);
    gh.lose("refs");
    await expect(a.propose(job("fleet/auth1234-job00002"))).rejects.toThrow(/socket hang up/);
    const again = await a.propose(job("fleet/auth1234-job00002"));
    expect(again).toMatchObject({ adopted: "branch", commitSha: "d".repeat(40) });
    expect(gh.writes).toEqual(["blob", "tree", "commit", "ref", "pull"]);        // each write once
    expect(await a.propose(job("fleet/auth1234-job00002"))).toMatchObject({ adopted: "pull_request" }); // and again: nothing
    expect(gh.pulls).toHaveLength(1);
  });

  it("a fresh job proposes normally; a refusal or a bad patch is definitely not proposed (failed, not uncertain)", async () => {
    const gh = statefulGitHub();
    const r = await app(gh.http).propose(job("fleet/auth1234-job00003"));
    expect(r.adopted).toBeUndefined();
    expect(gh.writes).toEqual(["blob", "tree", "commit", "ref", "pull"]);
    expect(definitelyNotProposed(new Error("GITHUB_HTTP_422 POST /repos/acme/calc/pulls"))).toBe(true);
    expect(definitelyNotProposed(new PatchError("calc.py does not apply"))).toBe(true);
    expect(definitelyNotProposed(new Error("GITHUB_HTTP_502 POST /repos/acme/calc/pulls"))).toBe(false);
    expect(definitelyNotProposed(new Error("fetch failed"))).toBe(false);
  });
});

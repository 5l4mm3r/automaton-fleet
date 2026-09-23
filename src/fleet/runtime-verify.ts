/**
 * Pinned runtime identity verification (Phase 6).
 *
 *   pnpm fleet:verify-runtime [dir] [--json]
 *
 * Reports the pinned fleet runtime (FLEET_RUNTIME_REPO / _COMMIT / _BUILD_ID
 * / _LOCKFILE_SHA256 from runtime.env), the registry-approved runtime and,
 * for an installed tree, its actual identity. Any difference in repository,
 * commit, build identifier or lockfile is a refusal (exit 1): the same
 * comparison the fleet service makes at startup and svc_activate makes
 * before a child is activated.
 */

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { computeBuildIdentity } from "./attestation.js";
import { loadRuntimeRelease, normalizeRepoUrl, runtimeReleaseProblem, type RuntimeRelease } from "./runtime.js";

export interface TreeIdentity {
  dir: string;
  commit: string | null;
  origin: string | null;
  clean: boolean | null;
  buildId: string | null;
  lockfileSha256: string | null;
  error?: string;
}

export interface RuntimeIdentityReport {
  ok: boolean;
  pinned: RuntimeRelease | null;
  approved: { repo: string; commit: string; buildId: string; lockfileSha256: string } | null;
  tree: TreeIdentity | null;
  problems: string[];
}

type Git = (dir: string, args: string[]) => string | null;

const defaultGit: Git = (dir, args) => {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

/**
 * Identity of an installed runtime tree. A release under
 * /opt/automaton-fleet/releases/<commit> has no .git; its commit is the
 * directory name and its origin is unknown (the build id still covers every
 * source and compiled file plus the manifests).
 */
export function treeIdentity(dir: string, git: Git = defaultGit): TreeIdentity {
  const abs = path.resolve(dir);
  const hasGit = fs.existsSync(path.join(abs, ".git"));
  const out: TreeIdentity = { dir: abs, commit: null, origin: null, clean: null, buildId: null, lockfileSha256: null };
  if (hasGit) {
    out.commit = git(abs, ["rev-parse", "HEAD"])?.toLowerCase() ?? null;
    out.origin = git(abs, ["remote", "get-url", "origin"]);
    const st = git(abs, ["status", "--porcelain", "--untracked-files=no"]);
    out.clean = st === null ? null : st === "";
  } else if (/^[0-9a-f]{40}$/.test(path.basename(fs.realpathSync(abs)))) {
    out.commit = path.basename(fs.realpathSync(abs));
  }
  try {
    const id = computeBuildIdentity(abs);
    out.buildId = id.buildId;
    out.lockfileSha256 = id.lockfileSha256;
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
  }
  return out;
}

export function verifyRuntimeIdentity(opts: {
  env: Record<string, string | undefined>;
  approved: RuntimeIdentityReport["approved"];
  tree?: TreeIdentity | null;
}): RuntimeIdentityReport {
  const problems: string[] = [];
  const pinned = loadRuntimeRelease(opts.env);
  if (!pinned) problems.push(`runtime not pinned: ${runtimeReleaseProblem(opts.env)}`);
  const approved = opts.approved;
  if (!approved) problems.push("no runtime approved in the registry");
  const cmp = (label: string, a: { repo: string; commit: string; buildId: string; lockfileSha256: string }, b: typeof a) => {
    if (normalizeRepoUrl(a.repo) !== normalizeRepoUrl(b.repo)) problems.push(`${label}: repository differs (${a.repo} vs ${b.repo})`);
    if (a.commit !== b.commit) problems.push(`${label}: commit differs (${a.commit} vs ${b.commit})`);
    if (a.buildId !== b.buildId) problems.push(`${label}: build identifier differs (${a.buildId} vs ${b.buildId})`);
    if (a.lockfileSha256 !== b.lockfileSha256) problems.push(`${label}: lockfile differs (${a.lockfileSha256} vs ${b.lockfileSha256})`);
  };
  if (pinned && approved) cmp("pinned vs approved", pinned, approved);
  const tree = opts.tree ?? null;
  if (tree && pinned) {
    if (tree.error) problems.push(`installed tree: ${tree.error}`);
    if (tree.commit !== pinned.commit) problems.push(`installed tree: commit differs (${tree.commit ?? "unknown"} vs ${pinned.commit})`);
    if (tree.origin !== null && normalizeRepoUrl(tree.origin) !== normalizeRepoUrl(pinned.repo)) {
      problems.push(`installed tree: repository differs (${tree.origin} vs ${pinned.repo})`);
    }
    if (tree.clean === false) problems.push("installed tree: tracked files modified");
    if (tree.lockfileSha256 && tree.lockfileSha256 !== pinned.lockfileSha256) problems.push("installed tree: lockfile verification failed");
    if (tree.buildId && tree.buildId !== pinned.buildId) problems.push(`installed tree: build identifier differs (${tree.buildId} vs ${pinned.buildId})`);
  }
  return { ok: problems.length === 0, pinned, approved, tree, problems };
}

export function formatRuntimeIdentity(r: RuntimeIdentityReport): string {
  const lines = ["Automaton Fleet — pinned runtime identity", ""];
  const row = (k: string, v: unknown) => lines.push(`  ${k.padEnd(26)} ${v ?? "-"}`);
  row("FLEET_RUNTIME_REPO", r.pinned?.repo);
  row("FLEET_RUNTIME_COMMIT", r.pinned?.commit);
  row("FLEET_RUNTIME_BUILD_ID", r.pinned?.buildId);
  row("FLEET_RUNTIME_LOCKFILE_SHA256", r.pinned?.lockfileSha256);
  row("registry-approved commit", r.approved?.commit);
  row("registry-approved build", r.approved?.buildId);
  if (r.tree) {
    row("installed tree", r.tree.dir);
    row("  commit", r.tree.commit);
    row("  origin", r.tree.origin);
    row("  build id", r.tree.buildId);
    row("  lockfile", r.tree.lockfileSha256);
  }
  lines.push("", r.ok ? "RUNTIME IDENTITY: VERIFIED" : `RUNTIME IDENTITY: REFUSED (${r.problems.length})`);
  for (const p of r.problems) lines.push(`  - ${p}`);
  return lines.join("\n");
}

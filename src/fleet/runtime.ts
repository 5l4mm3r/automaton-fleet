/**
 * Pinned Child Runtime
 *
 * Children must run a pinned commit of THIS fleet fork — never the upstream
 * Conway Research repository and never a repo/commit chosen by an agent.
 *
 *   FLEET_RUNTIME_REPO    https URL of the fleet fork (no credentials, not upstream)
 *   FLEET_RUNTIME_COMMIT  full 40-hex commit SHA (branches/tags rejected)
 *
 * The pin must also equal the operator-approved pin stored in the shared
 * registry (fleet_state.runtime_repo / runtime_commit). The approved pin is
 * copied onto the reservation row and handed to spawnChild() through the
 * claimed grant, so no tool argument can influence it.
 */

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { computeBuildIdentity, validateRuntimeBuild, type BuildIdentity, type RuntimeBuild } from "./attestation.js";

export const CHILD_RUNTIME_DIR = "/root/automaton";
export const CHILD_RUNTIME_MANIFEST = "/root/.automaton/fleet-runtime.json";

export interface RuntimePin {
  readonly repo: string;
  readonly commit: string;
}

export class FleetRuntimeError extends Error {
  readonly code = "FLEET_RUNTIME_UNVERIFIED";
  constructor(message: string) {
    super(message);
    this.name = "FleetRuntimeError";
  }
}

/** Upstream repos children must never run (the fork has the fleet layer; upstream does not). */
const UPSTREAM_REPO_PATHS: readonly string[] = Object.freeze(["conway-research/automaton"]);

const COMMIT_RE = /^[0-9a-f]{40}$/;
// https://host[:port]/owner/name[.git] — conservative charset, no userinfo, query or fragment.
const REPO_RE = /^https:\/\/([a-z0-9.-]+(?::\d{1,5})?)\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

export type PinValidation = { ok: true; pin: RuntimePin } | { ok: false; reason: string };

/** Canonical form: lowercase host, no trailing slash, no .git suffix. */
export function normalizeRepoUrl(repo: string): string | null {
  const m = REPO_RE.exec(repo.trim());
  if (!m) return null;
  const [, host, owner, name] = m;
  if (owner === "." || owner === ".." || name === "." || name === "..") return null;
  return `https://${host.toLowerCase()}/${owner}/${name}`;
}

export function isUpstreamRepo(repo: string): boolean {
  // Match on owner/name regardless of scheme, host, case or .git suffix,
  // so ssh/git@ spellings of upstream are caught too.
  const lowered = repo.trim().toLowerCase().replace(/\.git\/?$/, "").replace(/\/+$/, "");
  return UPSTREAM_REPO_PATHS.some((p) => lowered.endsWith(`/${p}`) || lowered.endsWith(`:${p}`));
}

export function validateRuntimePin(repo: unknown, commit: unknown): PinValidation {
  if (typeof repo !== "string" || repo.trim() === "") {
    return { ok: false, reason: "FLEET_RUNTIME_REPO is not set." };
  }
  if (typeof commit !== "string" || commit.trim() === "") {
    return { ok: false, reason: "FLEET_RUNTIME_COMMIT is not set." };
  }
  if (isUpstreamRepo(repo)) {
    return { ok: false, reason: "Upstream Conway Research runtime is not allowed; children must run the fleet fork." };
  }
  const normalized = normalizeRepoUrl(repo);
  if (!normalized) {
    return { ok: false, reason: "FLEET_RUNTIME_REPO must be an https://host/owner/repo URL without credentials." };
  }
  const c = commit.trim().toLowerCase();
  if (!COMMIT_RE.test(c)) {
    return { ok: false, reason: "FLEET_RUNTIME_COMMIT must be a full 40-character commit SHA." };
  }
  return { ok: true, pin: Object.freeze({ repo: normalized, commit: c }) };
}

export function loadRuntimePin(env: Record<string, string | undefined> = process.env): RuntimePin | null {
  const v = validateRuntimePin(env.FLEET_RUNTIME_REPO, env.FLEET_RUNTIME_COMMIT);
  return v.ok ? v.pin : null;
}

export function samePin(a: RuntimePin | null | undefined, b: RuntimePin | null | undefined): boolean {
  return !!a && !!b && a.repo === b.repo && a.commit === b.commit;
}

/**
 * Resolve the runtime a child will run. `requested` is whatever a caller
 * asked for (normally nothing); it must equal the parent-approved pin exactly.
 * Throws FleetRuntimeError otherwise.
 */
export function resolveChildRuntime(
  approved: RuntimePin | null | undefined,
  requested?: { repo?: unknown; commit?: unknown },
): RuntimePin {
  if (!approved) {
    throw new FleetRuntimeError("No approved fleet runtime pin; refusing to provision child.");
  }
  const check = validateRuntimePin(approved.repo, approved.commit);
  if (!check.ok) throw new FleetRuntimeError(`Approved runtime pin invalid: ${check.reason}`);

  if (requested && (requested.repo !== undefined || requested.commit !== undefined)) {
    const repo = requested.repo ?? check.pin.repo;
    const commit = requested.commit ?? check.pin.commit;
    const req = validateRuntimePin(repo, commit);
    if (!req.ok) throw new FleetRuntimeError(`Requested child runtime rejected: ${req.reason}`);
    if (!samePin(req.pin, check.pin)) {
      throw new FleetRuntimeError("Requested child runtime does not match the parent-approved pinned runtime.");
    }
  }
  return check.pin;
}

function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** pnpm version children build with; must equal package.json "packageManager" (tested). */
export const CHILD_PNPM_VERSION = "10.28.1";

/**
 * Shell command that installs exactly `pin` in the child sandbox and builds
 * it reproducibly. Fetches the single commit (no branch/tag resolution),
 * checks out a detached HEAD, verifies pnpm-lock.yaml against the approved
 * lockfile hash BEFORE installing anything, then runs
 * `pnpm install --frozen-lockfile` with the pinned pnpm version. Any
 * mismatch aborts the chain (&&), so nothing unverified gets built.
 */
export function buildRuntimeInstallCommand(pin: RuntimePin, build: RuntimeBuild): string {
  const safe = resolveChildRuntime(pin);
  const b = validateRuntimeBuild(build?.buildId, build?.lockfileSha256);
  if (!b) throw new FleetRuntimeError("No approved runtime build identity; refusing to install child runtime.");
  const dir = CHILD_RUNTIME_DIR;
  return [
    `rm -rf ${dir}`,
    `git init -q ${dir}`,
    `cd ${dir}`,
    `git remote add origin ${sq(safe.repo)}`,
    `git fetch -q --depth 1 origin ${safe.commit}`,
    `git checkout -q --detach ${safe.commit}`,
    `test "$(git rev-parse HEAD)" = ${sq(safe.commit)}`,
    `test -f pnpm-lock.yaml`,
    `echo ${sq(`${b.lockfileSha256}  pnpm-lock.yaml`)} | sha256sum -c --quiet -`,
    `(corepack enable pnpm >/dev/null 2>&1 && corepack prepare pnpm@${CHILD_PNPM_VERSION} --activate >/dev/null 2>&1 || npm install -g --no-audit --no-fund pnpm@${CHILD_PNPM_VERSION})`,
    `test "$(pnpm --version)" = ${sq(CHILD_PNPM_VERSION)}`,
    `CI=true pnpm install --frozen-lockfile`,
    `pnpm build`,
  ].join(" && ");
}

/** Prints HEAD, origin, package version and whether tracked sources are pristine. */
export const RUNTIME_VERIFY_MARKER = "FLEET_RUNTIME_VERIFY";
export function buildRuntimeVerifyCommand(): string {
  const dir = CHILD_RUNTIME_DIR;
  return [
    `cd ${dir}`,
    `echo ${RUNTIME_VERIFY_MARKER}`,
    `echo "HEAD=$(git rev-parse HEAD)"`,
    `echo "ORIGIN=$(git remote get-url origin)"`,
    `echo "VERSION=$(node -p "require('./package.json').version")"`,
    `(git diff --quiet HEAD -- src package.json constitution.md && echo SRC_CLEAN=1 || echo SRC_CLEAN=0)`,
  ].join(" && ");
}

export interface RuntimeVerification {
  commit: string;
  repo: string;
  version: string | null;
}

/** Parse verify output and require an exact match with `pin`. Throws FleetRuntimeError. */
export function checkRuntimeVerification(stdout: string, pin: RuntimePin): RuntimeVerification {
  const fields = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) fields.set(m[1], m[2].trim());
  }
  if (!stdout.includes(RUNTIME_VERIFY_MARKER)) {
    throw new FleetRuntimeError("Child runtime verification produced no result.");
  }
  const head = (fields.get("HEAD") ?? "").toLowerCase();
  const origin = normalizeRepoUrl(fields.get("ORIGIN") ?? "");
  if (head !== pin.commit) {
    throw new FleetRuntimeError(`Child runtime commit ${head || "<unknown>"} does not match pinned ${pin.commit}.`);
  }
  if (origin !== pin.repo) {
    throw new FleetRuntimeError(`Child runtime origin ${fields.get("ORIGIN") || "<unknown>"} does not match pinned ${pin.repo}.`);
  }
  if (fields.get("SRC_CLEAN") !== "1") {
    throw new FleetRuntimeError("Child runtime sources differ from the pinned commit.");
  }
  const version = fields.get("VERSION");
  return { commit: head, repo: origin, version: version && /^[\w.+-]{1,64}$/.test(version) ? version : null };
}

export async function verifyChildRuntime(
  exec: (command: string, timeout?: number) => Promise<{ stdout: string; exitCode?: number }>,
  pin: RuntimePin,
): Promise<RuntimeVerification> {
  let result;
  try {
    result = await exec(buildRuntimeVerifyCommand(), 30_000);
  } catch (err) {
    throw new FleetRuntimeError(`Child runtime could not be verified: ${err instanceof Error ? err.message : String(err)}`);
  }
  return checkRuntimeVerification(result.stdout || "", pin);
}

/** Written into the child sandbox. Contains no secrets. */
export interface ChildRuntimeManifest {
  agentId: string;
  parentAgentId: string | null;
  generation: number;
  repo: string;
  commit: string;
  /** Approved build identifier and lockfile hash (Phase 3); required for children. */
  buildId?: string;
  lockfileSha256?: string;
}

// ─── Child-side startup self-check ───────────────────────────────

export type SelfCheckResult =
  | { ok: true; manifest: ChildRuntimeManifest | null }
  | { ok: false; reason: string };

/**
 * Called by a starting automaton. A child (has a parent) must carry a
 * manifest and be running exactly the manifest's commit from the manifest's
 * repo; otherwise it must refuse to start. The root has no manifest.
 */
export function verifyOwnRuntime(opts: {
  isChild: boolean;
  manifestPath: string;
  runtimeDir: string;
  git?: (args: string[]) => string;
  computeIdentity?: (dir: string) => BuildIdentity;
}): SelfCheckResult {
  const git = opts.git ?? ((args: string[]) =>
    execFileSync("git", ["-C", opts.runtimeDir, ...args], { encoding: "utf8", timeout: 10_000 }).trim());

  let manifest: ChildRuntimeManifest | null = null;
  if (fs.existsSync(opts.manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(opts.manifestPath, "utf8"));
    } catch {
      return { ok: false, reason: "Fleet runtime manifest is unreadable." };
    }
  }
  if (!manifest) {
    return opts.isChild
      ? { ok: false, reason: "Child automaton has no fleet runtime manifest; runtime cannot be verified." }
      : { ok: true, manifest: null };
  }

  const pin = validateRuntimePin(manifest.repo, manifest.commit);
  if (!pin.ok) return { ok: false, reason: `Fleet runtime manifest rejected: ${pin.reason}` };
  try {
    const head = git(["rev-parse", "HEAD"]).toLowerCase();
    const origin = normalizeRepoUrl(git(["remote", "get-url", "origin"]));
    if (head !== pin.pin.commit) return { ok: false, reason: `Running commit ${head} does not match pinned ${pin.pin.commit}.` };
    if (origin !== pin.pin.repo) return { ok: false, reason: "Running runtime origin does not match the pinned fleet repo." };
    git(["diff", "--quiet", "HEAD", "--", "src", "package.json", "constitution.md", "pnpm-lock.yaml"]);
  } catch (err) {
    return { ok: false, reason: `Runtime cannot be verified: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
  }

  // Lockfile integrity and build identity: the running tree must be exactly
  // the approved build. A child without these expectations cannot prove it.
  const expected = validateRuntimeBuild(manifest.buildId, manifest.lockfileSha256);
  if (!expected) {
    return opts.isChild
      ? { ok: false, reason: "Fleet runtime manifest has no approved build identity; lockfile integrity cannot be verified." }
      : { ok: true, manifest };
  }
  let actual: BuildIdentity;
  try {
    actual = (opts.computeIdentity ?? computeBuildIdentity)(opts.runtimeDir);
  } catch (err) {
    return { ok: false, reason: `Lockfile integrity cannot be verified: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (actual.lockfileSha256 !== expected.lockfileSha256) {
    return { ok: false, reason: "pnpm-lock.yaml does not match the approved lockfile." };
  }
  if (actual.buildId !== expected.buildId) {
    return { ok: false, reason: `Runtime build ${actual.buildId} does not match approved build ${expected.buildId}.` };
  }
  return { ok: true, manifest };
}

/** Repo root of the running automaton: nearest ancestor with this package's package.json. */
export function runningRuntimeDir(moduleUrl: string): string {
  let dir = path.dirname(new URL(moduleUrl).pathname);
  for (;;) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      if (pkg?.name === "@conway/automaton") return dir;
    } catch {
      // keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.dirname(new URL(moduleUrl).pathname);
    dir = parent;
  }
}

/** Best-effort commit of the running process, for registry bookkeeping only. */
export function readOwnCommit(runtimeDir: string): string | null {
  try {
    const head = execFileSync("git", ["-C", runtimeDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().toLowerCase();
    return COMMIT_RE.test(head) ? head : null;
  } catch {
    return null;
  }
}

export function readOwnVersion(runtimeDir: string): string | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(runtimeDir, "package.json"), "utf8")).version;
    return typeof v === "string" && /^[\w.+-]{1,64}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

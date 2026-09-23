/**
 * Runtime attestation (Phase 3)
 *
 * A child's runtime identity is not taken from the child's word. The
 * controller records, per reservation, the expected repository, commit and
 * build identifier (from the operator-approved runtime). Before activation
 * the parent runs a verifier that the PARENT supplies (ATTEST_SCRIPT, written
 * into the child sandbox; nothing from the child's own build is executed)
 * with a single-use nonce issued at claim time. The verifier hashes the
 * installed tree and reports it; the controller compares the report with the
 * recorded expectations and only then activates the child.
 *
 * Build identifier: SHA-256 over the sorted list of
 *     "<relative path>\0<sha256(file)>\n"
 * for BUILD_IDENTITY_FILES and every regular file under BUILD_IDENTITY_DIRS.
 * Builds are reproducible (pnpm install --frozen-lockfile, pinned tsc), so
 * the operator computes the same identifier from a clean build of the pinned
 * commit (scripts/fleet-build-runtime.sh).
 *
 * Limits: the verifier runs inside the child sandbox, so a sandbox whose node
 * or kernel is compromised could still report false hashes. The nonce proves
 * freshness, not integrity of the sandbox itself (see FLEET.md).
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { FleetRuntimeError, normalizeRepoUrl } from "./runtime.js";

export const BUILD_IDENTITY_FILES: readonly string[] = Object.freeze([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "constitution.md",
]);
export const BUILD_IDENTITY_DIRS: readonly string[] = Object.freeze(["dist", "src"]);

const HEX64 = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

export interface RuntimeBuild {
  readonly buildId: string;
  readonly lockfileSha256: string;
}

export interface BuildIdentity extends RuntimeBuild {
  fileCount: number;
}

/** What the controller expects a specific reservation's child to be running. */
export interface AttestationExpectation extends RuntimeBuild {
  repo: string;
  commit: string;
  nonce: string;
}

/** Verifier output, sent to the controller as proof. */
export interface RuntimeAttestation {
  nonce: string;
  commit: string;
  repo: string;
  buildId: string;
  lockfileSha256: string;
  clean: boolean;
  fileCount: number;
  version: string | null;
  proof: string;
}

export function isRuntimeBuild(v: unknown): v is RuntimeBuild {
  const b = v as RuntimeBuild;
  return !!b && typeof b.buildId === "string" && HEX64.test(b.buildId) && typeof b.lockfileSha256 === "string" && HEX64.test(b.lockfileSha256);
}

export function validateRuntimeBuild(buildId: unknown, lockfileSha256: unknown): RuntimeBuild | null {
  const b = {
    buildId: typeof buildId === "string" ? buildId.trim().toLowerCase() : "",
    lockfileSha256: typeof lockfileSha256 === "string" ? lockfileSha256.trim().toLowerCase() : "",
  };
  return isRuntimeBuild(b) ? Object.freeze(b) : null;
}

/** FLEET_RUNTIME_BUILD_ID / FLEET_RUNTIME_LOCKFILE_SHA256 (local SQLite grant path and approve-runtime). */
export function loadRuntimeBuild(env: Record<string, string | undefined> = process.env): RuntimeBuild | null {
  return validateRuntimeBuild(env.FLEET_RUNTIME_BUILD_ID, env.FLEET_RUNTIME_LOCKFILE_SHA256);
}

export function newAttestationNonce(): string {
  return crypto.randomBytes(32).toString("hex");
}

function sha256(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** Binds the nonce to the reported identity (freshness; see module note). */
export function attestationProof(a: Pick<RuntimeAttestation, "nonce" | "commit" | "buildId" | "lockfileSha256">): string {
  return sha256(`${a.nonce}:${a.commit}:${a.buildId}:${a.lockfileSha256}`);
}

function listFiles(root: string, rel: string, out: string[]): void {
  const abs = path.join(root, rel);
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new FleetRuntimeError(`Unexpected symlink in runtime tree: ${childRel}`);
    if (entry.isDirectory()) listFiles(root, childRel, out);
    else if (entry.isFile()) out.push(childRel);
  }
}

/** Build identity of an installed runtime tree. Throws FleetRuntimeError if required files are missing. */
export function computeBuildIdentity(dir: string): BuildIdentity {
  const files: string[] = [];
  for (const f of BUILD_IDENTITY_FILES) {
    const p = path.join(dir, f);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      if (f === "package.json" || f === "pnpm-lock.yaml") {
        throw new FleetRuntimeError(`Runtime tree is missing ${f}; lockfile integrity cannot be verified.`);
      }
      continue;
    }
    if (!st.isFile()) throw new FleetRuntimeError(`Runtime file ${f} is not a regular file.`);
    files.push(f);
  }
  for (const d of BUILD_IDENTITY_DIRS) {
    if (!fs.existsSync(path.join(dir, d))) throw new FleetRuntimeError(`Runtime tree is missing ${d}/.`);
    const st = fs.lstatSync(path.join(dir, d));
    if (!st.isDirectory()) throw new FleetRuntimeError(`Runtime ${d} is not a directory.`);
    listFiles(dir, d, files);
  }
  files.sort((a, b) => (Buffer.compare(Buffer.from(a), Buffer.from(b))));
  const h = crypto.createHash("sha256");
  for (const f of files) h.update(`${f}\0${sha256(fs.readFileSync(path.join(dir, f)))}\n`);
  return {
    buildId: h.digest("hex"),
    lockfileSha256: sha256(fs.readFileSync(path.join(dir, "pnpm-lock.yaml"))),
    fileCount: files.length,
  };
}

export const ATTESTATION_MARKER = "FLEET_ATTESTATION ";

/**
 * Standalone verifier (CommonJS, node builtins only). Same algorithm as
 * computeBuildIdentity — a test keeps the two in lockstep. Usage:
 *   node fleet-attest.cjs <runtimeDir> <nonce>
 */
export const ATTEST_SCRIPT = `"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const FILES = ${JSON.stringify(BUILD_IDENTITY_FILES)};
const DIRS = ${JSON.stringify(BUILD_IDENTITY_DIRS)};
const [dir, nonce] = process.argv.slice(2);
const sha = (d) => crypto.createHash("sha256").update(d).digest("hex");
function fail(msg) { process.stdout.write("${ATTESTATION_MARKER}" + JSON.stringify({ error: msg }) + "\\n"); process.exit(3); }
if (!dir || !/^[0-9a-f]{64}$/.test(nonce || "")) fail("usage");
function walk(rel, out) {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? rel + "/" + e.name : e.name;
    if (e.isSymbolicLink()) fail("symlink " + r);
    if (e.isDirectory()) walk(r, out); else if (e.isFile()) out.push(r);
  }
}
const files = [];
try {
  for (const f of FILES) {
    let st; try { st = fs.lstatSync(path.join(dir, f)); } catch { if (f === "package.json" || f === "pnpm-lock.yaml") fail("missing " + f); continue; }
    if (!st.isFile()) fail("not a file " + f);
    files.push(f);
  }
  for (const d of DIRS) { if (!fs.lstatSync(path.join(dir, d)).isDirectory()) fail("not a dir " + d); walk(d, files); }
} catch (e) { fail(String(e && e.message || e)); }
files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
const h = crypto.createHash("sha256");
for (const f of files) h.update(f + "\\0" + sha(fs.readFileSync(path.join(dir, f))) + "\\n");
const buildId = h.digest("hex");
const lockfileSha256 = sha(fs.readFileSync(path.join(dir, "pnpm-lock.yaml")));
const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] }).trim();
let commit = "", repo = "", clean = false, version = null;
try { commit = git("rev-parse", "HEAD").toLowerCase(); } catch {}
try { repo = git("remote", "get-url", "origin"); } catch {}
try { clean = git("status", "--porcelain", "--untracked-files=no") === ""; } catch {}
try { version = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version || null; } catch {}
const proof = sha(nonce + ":" + commit + ":" + buildId + ":" + lockfileSha256);
process.stdout.write("${ATTESTATION_MARKER}" + JSON.stringify({ nonce, commit, repo, buildId, lockfileSha256, clean, fileCount: files.length, version, proof }) + "\\n");
`;

/** Parse verifier stdout. Throws FleetRuntimeError on missing/garbled output. */
export function parseAttestation(stdout: string): RuntimeAttestation {
  const line = stdout.split(/\r?\n/).reverse().find((l) => l.startsWith(ATTESTATION_MARKER));
  if (!line) throw new FleetRuntimeError("Runtime attestation produced no result.");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line.slice(ATTESTATION_MARKER.length));
  } catch {
    throw new FleetRuntimeError("Runtime attestation output is not valid JSON.");
  }
  if (typeof raw.error === "string") throw new FleetRuntimeError(`Runtime attestation failed: ${raw.error.slice(0, 200)}`);
  return sanitizeAttestation(raw);
}

/** Coerce an untrusted attestation object (from a sandbox or an API body) into a typed record. */
export function sanitizeAttestation(raw: unknown): RuntimeAttestation {
  const r = (raw ?? {}) as Record<string, unknown>;
  const str = (k: string, max = 300) => (typeof r[k] === "string" ? (r[k] as string).slice(0, max) : "");
  const version = typeof r.version === "string" && /^[\w.+-]{1,64}$/.test(r.version) ? r.version : null;
  return {
    nonce: str("nonce", 64).toLowerCase(),
    commit: str("commit", 40).toLowerCase(),
    repo: str("repo"),
    buildId: str("buildId", 64).toLowerCase(),
    lockfileSha256: str("lockfileSha256", 64).toLowerCase(),
    clean: r.clean === true,
    fileCount: typeof r.fileCount === "number" && Number.isSafeInteger(r.fileCount) ? r.fileCount : 0,
    version,
    proof: str("proof", 64).toLowerCase(),
  };
}

/**
 * Compare an attestation with what the controller recorded for the
 * reservation. Throws FleetRuntimeError naming the first mismatch.
 */
export function checkAttestation(att: RuntimeAttestation | null | undefined, expected: AttestationExpectation): RuntimeAttestation {
  if (!att) throw new FleetRuntimeError("Child did not prove its runtime identity (no attestation).");
  if (!HEX64.test(expected.nonce) || att.nonce !== expected.nonce) {
    throw new FleetRuntimeError("Runtime attestation nonce does not match this reservation (stale or replayed proof).");
  }
  if (!COMMIT_RE.test(att.commit) || att.commit !== expected.commit) {
    throw new FleetRuntimeError(`Attested commit ${att.commit || "<none>"} does not match expected ${expected.commit}.`);
  }
  if (normalizeRepoUrl(att.repo) !== expected.repo) {
    throw new FleetRuntimeError("Attested repository does not match the expected fleet repository.");
  }
  if (att.lockfileSha256 !== expected.lockfileSha256) {
    throw new FleetRuntimeError("Attested pnpm-lock.yaml does not match the approved lockfile (integrity check failed).");
  }
  if (att.buildId !== expected.buildId) {
    throw new FleetRuntimeError(`Attested build ${att.buildId || "<none>"} does not match expected build ${expected.buildId}.`);
  }
  if (!att.clean) throw new FleetRuntimeError("Attested runtime has modified tracked files.");
  if (att.proof !== attestationProof(att)) throw new FleetRuntimeError("Runtime attestation proof is inconsistent.");
  return att;
}

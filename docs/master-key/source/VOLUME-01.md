# SOURCE VOLUME 01 — Fleet core (src/fleet/*.ts)

Exact, byte-for-byte text of each file at repository commit `efad2148a3460ab881b0ab845fb13c25d1fa3e74` (branch fleet-development).
No file in this volume contains a real secret; test fixtures generate synthetic secrets at runtime.
Each file's SHA-256 is of the file bytes on disk and matches 22-RECONSTRUCTION-MANIFEST.md.

## Files

- `src/fleet/attestation.ts` — 249 lines, sha256 `32e0bd59e27c64806b8c67ee42d9e08c7e86c3d8bdd9541e82d1b933be280368`
- `src/fleet/backend.ts` — 53 lines, sha256 `249c713220ac37cfb4762be71afec747462fdd17b030c17984d811eeae52b58f`
- `src/fleet/config.ts` — 91 lines, sha256 `103e34b49aabdbe2637bab1874c0a6a2bca2ee7c0ac93e419605ebe8fb2b128e`
- `src/fleet/controller.ts` — 194 lines, sha256 `c78ef36bfcb9896b85a7c24832df169dd606384c76496fe51d112ab9b158e12a`
- `src/fleet/doctor.ts` — 611 lines, sha256 `297d934c14f1deae49b0be62289e5c4652ac6737d44b7eaf855341f05996ccb8`
- `src/fleet/grants.ts` — 99 lines, sha256 `b7a9a24d8a8d5ce41c178a0b50891a1afc0478e3e5c2321387727aa2d0610e32`
- `src/fleet/index.ts` — 98 lines, sha256 `2cf4db43a916990c92ccd716f57e94e97cc7398ce47f9d03a7d51acfd4127e6f`
- `src/fleet/policy.ts` — 195 lines, sha256 `f345052d146e0eac4ac4710a88b733f8444e9fc4f96485782f931d1369f51987`
- `src/fleet/redact-scan.ts` — 95 lines, sha256 `bc4b7d6e84289a2e080fc42bfd013d4208cf97c7d48d197321201e09f13913a5`
- `src/fleet/redact.ts` — 622 lines, sha256 `cb16c678ed37e10714849f2b57684758370dcf907ce338458348796da1814f54`
- `src/fleet/registry.ts` — 392 lines, sha256 `c50908a540d7760ff3240568b56ad4b6fb604fc8398fe8893bfddb6e89da4ddd`
- `src/fleet/runtime-verify.ts` — 126 lines, sha256 `39480041dbff73f769287a89b38a6fba1404580181cf86f5f803b31e41a7d35e`
- `src/fleet/runtime.ts` — 371 lines, sha256 `695e7f173f2114e45d6fa3ec7715d7321283e7201275828a8ffe7be7fa85b409`
- `src/fleet/secret-files.ts` — 419 lines, sha256 `01c2bf7ab6cf25f5f1bad3b7f178eaf0625dfea45b1e4b85b976c01fb1f67112`
- `src/fleet/secrets.ts` — 71 lines, sha256 `562ea7a956de647f321da6bf49d3b27b2b8167c01399b1133482c9f6f594aadf`
- `src/fleet/shared-controller.ts` — 377 lines, sha256 `d8d8ef2be589df63f9a20a8a0d1df278459a742312d7c21c2c3ed7924af44d04`
- `src/fleet/shared.ts` — 137 lines, sha256 `8d8f9a2329c7794eca7ca656fe7a94d03ee535d29f6a7dfdcc86ba4b7de83b62`
- `src/fleet/types.ts` — 250 lines, sha256 `7bde6b4aaa710c6173a19661148398439fb559195e63ba17c288db85faa33d0b`

## `src/fleet/attestation.ts`

sha256 `32e0bd59e27c64806b8c67ee42d9e08c7e86c3d8bdd9541e82d1b933be280368` · 11335 bytes · 249 lines

```ts
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
```

## `src/fleet/backend.ts`

sha256 `249c713220ac37cfb4762be71afec747462fdd17b030c17984d811eeae52b58f` · 2024 bytes · 53 lines

```ts
/**
 * FleetBackend — what a SharedFleetController needs from the registry.
 *
 * Two implementations:
 *   - PgFleetStore  (controller/operator side; holds admin DB credentials,
 *                    used by the fleet service and by tests)
 *   - FleetApiClient (agent side; talks to the fleet service over HTTP with
 *                    the agent's own bearer credential, no DB credentials)
 */

import type { RuntimeAttestation } from "./attestation.js";
import type { RegisterResult, SharedReserveResult } from "./postgres/store.js";
import type { RuntimePin } from "./runtime.js";
import type { ActivationResult, FleetHealth, SharedAgentStatus, SharedFleetState } from "./types.js";

export interface FleetBackend {
  readonly kind: "postgres" | "api";
  health(): Promise<FleetHealth>;
  getState(): Promise<SharedFleetState>;
  listMemberAddresses(): Promise<string[]>;
  registerRoot(params: {
    walletAddress: string;
    name: string;
    runtimeVersion?: string | null;
    runtimeCommit?: string | null;
    localMaxAgents?: number;
  }): Promise<RegisterResult>;
  attachAgent(agentId: string, walletAddress: string): Promise<RegisterResult>;
  heartbeat(agentId: string): Promise<boolean>;
  selfStatus(agentId: string): Promise<SharedAgentStatus | null>;
  reserveSlot(params: {
    parentAgentId: string;
    requestedBy: string;
    name: string;
    runtime: RuntimePin | null;
    requestKey?: string;
    localMaxAgents?: number;
  }): Promise<SharedReserveResult>;
  releaseReservation(agentId: string, reason: string): Promise<boolean>;
  recordVerificationFailure(agentId: string, reason: string): Promise<boolean>;
  activate(
    agentId: string,
    params: {
      walletAddress: string;
      sandboxId?: string | null;
      runtimeCommit?: string | null;
      runtimeVersion?: string | null;
      attestation?: RuntimeAttestation | null;
    },
  ): Promise<ActivationResult>;
  markDeadByLocalChildId(localChildId: string, reason: string): Promise<boolean>;
  close(): Promise<void>;
}
```

## `src/fleet/config.ts`

sha256 `103e34b49aabdbe2637bab1874c0a6a2bca2ee7c0ac93e419605ebe8fb2b128e` · 3611 bytes · 91 lines

```ts
/**
 * Fleet Configuration
 *
 * Parsed from environment variables. Every value fails closed: anything
 * missing or malformed resolves to the most restrictive setting.
 *
 *   FLEET_MAX_AGENTS          integer 1..50   (default 1)
 *   FLEET_MODE                DEVELOPMENT | EXPANSION | HARVEST | EMERGENCY (default DEVELOPMENT)
 *   REAL_REPLICATION_ENABLED  "true" to enable (default false)
 *   REAL_PAYMENTS_ENABLED     "true" to enable (default false)
 *   OWNER_SWEEP_ENABLED       "true" to enable (default false; no-op in Phase 1)
 *   MIN_AGENT_RESERVE_USD     parent reserve before replication (default 10)
 *   FLEET_RUNTIME_REPO        https URL of the fleet fork children run (no default)
 *   FLEET_RUNTIME_COMMIT      full 40-hex commit children run (no default)
 */

import { FLEET_HARD_MAX_AGENTS } from "../state/schema.js";
import type { FleetConfig, FleetState } from "./types.js";
import { FLEET_STATES } from "./types.js";
import { loadRuntimePin } from "./runtime.js";

export { FLEET_HARD_MAX_AGENTS };

export const DEFAULT_FLEET_CONFIG: Readonly<FleetConfig> = Object.freeze({
  maxAgents: 1,
  configuredMode: "DEVELOPMENT",
  realReplicationEnabled: false,
  realPaymentsEnabled: false,
  ownerSweepEnabled: false,
  minParentReserveCents: 1000,
  runtime: null,
});

type Env = Record<string, string | undefined>;

/** Only the exact string "true" (case-insensitive) enables a flag. */
function parseFlag(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}

export function parseMaxAgents(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_FLEET_CONFIG.maxAgents;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_FLEET_CONFIG.maxAgents;
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n < 1 || n > FLEET_HARD_MAX_AGENTS) {
    return DEFAULT_FLEET_CONFIG.maxAgents;
  }
  return n;
}

function parseMode(value: string | undefined): FleetState {
  const upper = value?.trim().toUpperCase();
  return FLEET_STATES.includes(upper as FleetState)
    ? (upper as FleetState)
    : DEFAULT_FLEET_CONFIG.configuredMode;
}

function parseUsdToCents(value: string | undefined, fallbackCents: number): number {
  if (value === undefined || value.trim() === "") return fallbackCents;
  const n = Number(value.trim());
  if (!Number.isFinite(n) || n < 0) return fallbackCents;
  return Math.round(n * 100);
}

export function loadFleetConfig(env: Env = process.env): FleetConfig {
  return Object.freeze({
    maxAgents: parseMaxAgents(env.FLEET_MAX_AGENTS),
    configuredMode: parseMode(env.FLEET_MODE),
    realReplicationEnabled: parseFlag(env.REAL_REPLICATION_ENABLED),
    realPaymentsEnabled: parseFlag(env.REAL_PAYMENTS_ENABLED),
    ownerSweepEnabled: parseFlag(env.OWNER_SWEEP_ENABLED),
    minParentReserveCents: parseUsdToCents(
      env.MIN_AGENT_RESERVE_USD,
      DEFAULT_FLEET_CONFIG.minParentReserveCents,
    ),
    runtime: loadRuntimePin(env),
  });
}

/** Strictness order: EMERGENCY > DEVELOPMENT > HARVEST > EXPANSION. */
const MODE_STRICTNESS: Record<FleetState, number> = { EXPANSION: 0, HARVEST: 1, DEVELOPMENT: 2, EMERGENCY: 3 };

/** The more restrictive of two modes (local env can only tighten the shared mode). */
export function strictestMode(a: FleetState, b: FleetState): FleetState {
  return MODE_STRICTNESS[a] >= MODE_STRICTNESS[b] ? a : b;
}

export function isFleetState(value: unknown): value is FleetState {
  return typeof value === "string" && FLEET_STATES.includes(value as FleetState);
}
```

## `src/fleet/controller.ts`

sha256 `c78ef36bfcb9896b85a7c24832df169dd606384c76496fe51d112ab9b158e12a` · 6024 bytes · 194 lines

```ts
/**
 * Fleet Controller
 *
 * The single entry point for reproduction. Every replication request —
 * from the spawn_child tool or the orchestrator — goes through
 * requestReplication(), which:
 *
 *   1. evaluates FleetPolicy (state, flags, root-only, cap),
 *   2. checks financial eligibility (EXPANSION only, fails closed),
 *   3. atomically reserves a living slot in FleetRegistry,
 *   4. hands the resulting single-use grant to the spawn function,
 *   5. activates the slot on success or releases it on failure.
 *
 * spawnChild() refuses to run without a grant, so the controller cannot
 * be skipped by calling the lower-level spawn function directly.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { FleetRegistry } from "./registry.js";
import {
  computeFleetState,
  evaluateFinancialEligibility,
  evaluateReplication,
  evaluateToolCall,
} from "./policy.js";
import type {
  FinancialSnapshot,
  FleetConfig,
  FleetDecision,
  FleetSpawnGrant,
  FleetState,
  FleetStatus,
  ReplicationOutcome,
} from "./types.js";

export interface FleetControllerOptions {
  db: DatabaseType;
  config: FleetConfig;
  /** The automaton this controller runs inside. */
  self: { address: string; name: string };
  /** False when this automaton has a parent (it cannot see the global registry). */
  isRootAgent: boolean;
  /** Supplies the parent's current finances. Errors fail closed. */
  getFinancialSnapshot?: () => Promise<FinancialSnapshot>;
}

export interface SpawnedChildInfo {
  address?: string;
  sandboxId?: string;
}

export class FleetController {
  readonly registry: FleetRegistry;
  private readonly rootAgentId: string;

  constructor(private readonly opts: FleetControllerOptions) {
    this.registry = new FleetRegistry(opts.db);
    this.registry.setMaxAgents(opts.config.maxAgents);
    this.rootAgentId = this.registry.ensureRootAgent(opts.self).id;
  }

  get config(): FleetConfig {
    return this.opts.config;
  }

  getStatus(): FleetStatus {
    const livingAgents = this.registry.countLiving();
    const maxAgents = this.registry.getMaxAgents();
    const emergency = this.registry.isEmergency();
    return {
      state: computeFleetState({
        configuredMode: this.opts.config.configuredMode,
        emergency,
        livingAgents,
        maxAgents,
      }),
      configuredMode: this.opts.config.configuredMode,
      emergency,
      livingAgents,
      maxAgents,
      totalRecorded: this.registry.countTotal(),
    };
  }

  getState(): FleetState {
    return this.getStatus().state;
  }

  enterEmergency(reason: string): void {
    this.registry.setEmergency(true, reason, this.opts.self.address);
  }

  clearEmergency(reason: string): void {
    this.registry.setEmergency(false, reason, this.opts.self.address);
  }

  /** Synchronous gate used by the PolicyEngine rule. */
  evaluateToolCall(toolName: string, args: Record<string, unknown>): FleetDecision | null {
    const status = this.getStatus();
    return evaluateToolCall({
      toolName,
      args,
      config: this.opts.config,
      state: status.state,
      livingAgents: status.livingAgents,
      maxAgents: status.maxAgents,
      isRootAgent: this.opts.isRootAgent,
      isFleetMemberAddress: (a) => this.registry.isFleetMemberAddress(a),
    });
  }

  /** Full pre-reservation check, including financial eligibility. */
  async evaluateReplication(): Promise<FleetDecision> {
    const status = this.getStatus();
    const gate = evaluateReplication({
      config: this.opts.config,
      state: status.state,
      livingAgents: status.livingAgents,
      maxAgents: status.maxAgents,
      isRootAgent: this.opts.isRootAgent,
    });
    if (!gate.allowed) return gate;

    let snapshot: FinancialSnapshot | null = null;
    if (this.opts.getFinancialSnapshot) {
      try {
        snapshot = await this.opts.getFinancialSnapshot();
      } catch {
        snapshot = null;
      }
    }
    return evaluateFinancialEligibility(snapshot, this.opts.config, status.state);
  }

  /**
   * Request a new child. `spawn` receives the single-use grant and must pass
   * it to spawnChild(). Policy denials are returned; spawn errors are
   * rethrown after the reserved slot has been released.
   */
  async requestReplication<TChild extends SpawnedChildInfo>(
    request: { name: string; requestedBy?: string },
    spawn: (grant: FleetSpawnGrant) => Promise<TChild>,
  ): Promise<ReplicationOutcome<TChild>> {
    const requestedBy = request.requestedBy ?? this.opts.self.address;

    const decision = await this.evaluateReplication();
    if (!decision.allowed) {
      this.registry.recordEvent("replication_denied", null, requestedBy, {
        code: decision.code,
        reason: decision.reason,
        state: decision.state,
        name: request.name,
      });
      return { ok: false, decision };
    }

    const reservation = this.registry.reserveSlot({
      parentAgentId: this.rootAgentId,
      requestedBy,
      name: request.name,
    });
    if (!reservation.ok) {
      return {
        ok: false,
        decision: {
          allowed: false,
          code: reservation.code,
          reason: reservation.reason,
          state: this.getState(),
        },
      };
    }

    const agentId = reservation.agent.id;
    let child: TChild;
    try {
      child = await spawn(reservation.grant);
    } catch (err) {
      this.registry.releaseReservation(agentId, `spawn failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }

    try {
      this.registry.activate(agentId, { address: child.address, sandboxId: child.sandboxId });
    } catch (err) {
      // The spawn function did not claim the grant (or the child already
      // died). Never leave a dangling living slot.
      this.registry.releaseReservation(agentId, `activation failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }

    return { ok: true, agentId, child, state: this.getState() };
  }
}
```

## `src/fleet/doctor.ts`

sha256 `297d934c14f1deae49b0be62289e5c4652ac6737d44b7eaf855341f05996ccb8` · 32788 bytes · 611 lines

```ts
/**
 * Deployment readiness doctor (Phase 4)
 *
 *   pnpm fleet:doctor [--json] [--deployment-only]
 *
 * Reports database connectivity, schema version, effective privileges, the
 * fleet service's readiness, the pinned runtime, the safety flags, the fleet
 * population, stale agents/reservations, unterminated sandboxes and security
 * warnings.
 *
 * Two verdicts:
 *   deployment        the control plane is correctly deployed (DB, roles,
 *                     privileges, service, secrets, flags off)
 *   real replication  SAFE only if the deployment is OK AND no blocker
 *                     remains. Any blocker => UNSAFE and exit code 1.
 * `--deployment-only` exits 0 when the deployment verdict is OK even though
 * real replication is (correctly) still unsafe — for monitoring.
 *
 * Phase 6 adds the operator checklist (`pnpm fleet:verify`) and three
 * INDEPENDENT readiness levels, each with its own blocker list:
 *   SAFE FOR DRY RUN            the first remote child may be provisioned with zero authority
 *   SAFE FOR REAL REPLICATION   REAL_REPLICATION_ENABLED may be turned on
 *   SAFE FOR REAL PAYMENTS      REAL_PAYMENTS_ENABLED may be turned on
 * None of them ever enables anything.
 */

import { execFile } from "child_process";
import crypto from "crypto";
import fs from "fs";
import net from "net";
import path from "path";
import { FLEET_PG_SCHEMA_VERSION } from "./postgres/migrations.js";
import type { PgFleetStore } from "./postgres/store.js";
import { loadRuntimeRelease, runtimeReleaseProblem, sameRelease } from "./runtime.js";
import { auditLevel } from "./operator/responses.js";
import {
  CONTROLLER_SECRET_KEYS,
  DEFAULT_ADMIN_ENV_FILE,
  DEFAULT_SERVICE_ENV_FILE,
  FLEET_ETC_DIR,
  FLEET_SYSTEMD_UNIT,
  LEGACY_ENV_FILE,
  SYSTEMD_CREDENTIALS_ROOT,
  TLS_CERT_CREDENTIAL,
  readEnvFile,
  secretFileProblems,
} from "./secret-files.js";

export type CheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface ReadinessLevel {
  safe: boolean;
  blockers: string[];
}

export interface ChecklistItem {
  item: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  deploymentOk: boolean;
  replicationSafe: boolean;
  /** Phase 6: independent readiness levels. */
  readiness: { dryRun: ReadinessLevel; realReplication: ReadinessLevel; realPayments: ReadinessLevel };
  /** Phase 6: operator verification checklist. */
  checklist: ChecklistItem[];
  checks: DoctorCheck[];
  blockers: string[];
  securityWarnings: string[];
  facts: Record<string, unknown>;
}

export interface DoctorDeps {
  env: Record<string, string | undefined>;
  /** Registry store (admin or service credential); null = not configured. */
  store: PgFleetStore | null;
  /** Error raised while loading configuration (e.g. unreadable secret file). */
  configError?: string | null;
  fetchImpl?: typeof fetch;
  /** Filesystem locations (overridable for tests). */
  paths?: {
    cwd?: string;
    etcDir?: string;
    adminEnv?: string;
    serviceEnv?: string;
    passwd?: string;
    group?: string;
    systemdUnit?: string;
    /** Filesystem holding the audit logs (disk-usage check). */
    logDir?: string;
  };
  /** Sandbox termination is guaranteed by the deployed terminator (default false: Conway cannot stop sandboxes). */
  sandboxTerminationGuaranteed?: boolean;
  /** `systemctl is-active` of the fleet unit (default: runs systemctl; null = unknown). */
  serviceActive?: () => Promise<string | null>;
  /** A controller custody signer exists for live payments (default false: none is implemented). */
  custodySignerAvailable?: boolean;
}

/** Can OS user `user` read `file`, judged from its mode bits and /etc/passwd + /etc/group? */
export function osUserCanRead(file: string, user: string, passwdFile = "/etc/passwd", groupFile = "/etc/group"): boolean | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  let uid: number | null = null;
  let gid: number | null = null;
  try {
    for (const line of fs.readFileSync(passwdFile, "utf8").split("\n")) {
      const f = line.split(":");
      if (f[0] === user) {
        uid = Number(f[2]);
        gid = Number(f[3]);
      }
    }
  } catch {
    return null;
  }
  if (uid === null) return false;
  if (uid === 0) return true;
  const gids = new Set<number>([gid!]);
  try {
    for (const line of fs.readFileSync(groupFile, "utf8").split("\n")) {
      const f = line.split(":");
      if (f.length >= 4 && f[3].split(",").includes(user)) gids.add(Number(f[2]));
    }
  } catch {
    // primary group only
  }
  const m = st.mode;
  if (st.uid === uid) return (m & 0o400) !== 0;
  if (gids.has(st.gid)) return (m & 0o040) !== 0;
  return (m & 0o004) !== 0;
}

/** Certificate problems for the public hostname (the key may be unreadable to the operator; it is checked at service start). */
export function certificateProblems(certFile: string, hostname: string, now = Date.now()): string[] {
  let x509: crypto.X509Certificate;
  try {
    x509 = new crypto.X509Certificate(fs.readFileSync(certFile));
  } catch (err) {
    return [`certificate ${certFile} unreadable (${err instanceof Error ? err.message : String(err)})`];
  }
  const problems: string[] = [];
  if (!(net.isIP(hostname) ? x509.checkIP(hostname) : x509.checkHost(hostname))) problems.push(`certificate does not cover ${hostname}`);
  if (Date.parse(x509.validFrom) > now) problems.push(`certificate not yet valid (${x509.validFrom})`);
  if (Date.parse(x509.validTo) < now + 86_400_000) problems.push(`certificate expires ${x509.validTo}`);
  return problems;
}

function defaultServiceActive(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("systemctl", ["is-active", "automaton-fleet.service"], { timeout: 5000 }, (_err, stdout) => resolve(stdout?.trim() || null));
  });
}

/** Unauthenticated probes that must be refused: long-lived bearer outside /v1/session, stale signed request. */
async function replayProbes(apiUrl: string, fetchImpl: typeof fetch): Promise<{ sessionOnly: boolean; staleRefused: boolean; detail: string }> {
  const post = (headers: Record<string, string>) =>
    fetchImpl(`${apiUrl}/v1/heartbeat`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}", signal: AbortSignal.timeout(3000) })
      .then(async (r) => ({ status: r.status, code: ((await r.json().catch(() => ({}))) as { code?: string }).code ?? "" }))
      .catch(() => ({ status: 0, code: "unreachable" }));
  const probeId = "01" + "0".repeat(24);
  const bearer = await post({ authorization: `Bearer fa1.${probeId}.${"A".repeat(43)}` });
  const stale = await post({
    authorization: `FleetSession fs1.${probeId}.${"A".repeat(43)}`,
    "x-fleet-timestamp": String(Date.now() - 3_600_000),
    "x-fleet-nonce": "doctor-probe-" + crypto.randomBytes(8).toString("hex"),
    "x-fleet-signature": "0".repeat(64),
  });
  return {
    sessionOnly: bearer.status === 401 && bearer.code === "FLEET_SESSION_REQUIRED",
    staleRefused: stale.status === 401 && stale.code === "FLEET_REQUEST_STALE",
    detail: `bearer -> ${bearer.status} ${bearer.code}; stale signed request -> ${stale.status} ${stale.code}`,
  };
}

export const FLEET_SERVICE_USER = "automaton-fleet-service";
export const FLEET_AGENT_USER = "automaton-agent";
export const FLEET_ADMIN_GROUP = "automaton-fleet-admin";
export const SYSTEMD_UNIT_PATH = "/etc/systemd/system/automaton-fleet.service";

function flag(v: string | undefined): boolean {
  return v?.trim().toLowerCase() === "true";
}

function namesIn(file: string): Set<string> {
  try {
    return new Set(fs.readFileSync(file, "utf8").split("\n").map((l) => l.split(":")[0]).filter(Boolean));
  } catch {
    return new Set();
  }
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const { env, store } = deps;
  const p = deps.paths ?? {};
  const cwd = p.cwd ?? process.cwd();
  const checks: DoctorCheck[] = [];
  const blockers: string[] = [];
  const securityWarnings: string[] = [];
  const facts: Record<string, unknown> = {};
  const add = (name: string, status: CheckStatus, detail: string) => checks.push({ name, status, detail });

  if (deps.configError) add("configuration", "fail", deps.configError);

  // ── Safety flags (must all be false in this phase)
  const flags = {
    REAL_REPLICATION_ENABLED: flag(env.REAL_REPLICATION_ENABLED),
    REAL_PAYMENTS_ENABLED: flag(env.REAL_PAYMENTS_ENABLED),
    OWNER_SWEEP_ENABLED: flag(env.OWNER_SWEEP_ENABLED),
  };
  facts.replicationEnabled = flags.REAL_REPLICATION_ENABLED;
  facts.paymentsEnabled = flags.REAL_PAYMENTS_ENABLED;
  facts.ownerSweepEnabled = flags.OWNER_SWEEP_ENABLED;
  for (const [k, v] of Object.entries(flags)) {
    add(`flag ${k}`, v ? "fail" : "pass", v ? "ENABLED — must remain false until explicitly approved" : "disabled");
  }

  // ── Database
  let dbOk = false;
  if (!store) {
    add("database connectivity", "fail", "no registry credential configured (FLEET_ADMIN_DATABASE_URL or FLEET_SERVICE_DATABASE_URL)");
    blockers.push("Fleet registry database is not reachable/configured.");
  } else {
    const h = await store.health();
    facts.schemaVersion = h.schemaVersion;
    if (h.latencyMs === null && h.schemaVersion === null) {
      add("database connectivity", "fail", h.error ?? "unreachable");
      blockers.push("Fleet registry database is not reachable.");
    } else {
      add("database connectivity", "pass", `reachable (${h.latencyMs ?? "?"} ms)`);
      const vOk = h.schemaVersion === FLEET_PG_SCHEMA_VERSION;
      add("schema version", vOk ? "pass" : "fail", `v${h.schemaVersion ?? "none"} (required v${FLEET_PG_SCHEMA_VERSION})`);
      if (!vOk) blockers.push(`Registry schema is v${h.schemaVersion ?? "none"}; run the approved migration to v${FLEET_PG_SCHEMA_VERSION}.`);
      if (vOk) {
        add("registry counters", h.countersConsistent ? "pass" : "fail", h.countersConsistent ? "consistent" : "fleet_state counters disagree with fleet_agents");
        dbOk = h.ok;
      }
    }
  }

  let approved: { repo: string; commit: string; buildId: string; lockfileSha256: string } | null = null;
  if (store && dbOk) {
    try {
      const who = await store.connectionIdentity();
      facts.doctorDbUser = who.user;
      const audit = await store.auditPrivileges();
      facts.privilegeProblems = audit.problems;
      facts.operatorRoles = audit.operatorRoles;
      const roleText = audit.operatorRoles === "not_provisioned" ? "agent/service roles least-privilege; operator roles: not provisioned" : "agent/service/operator roles least-privilege";
      add("database privileges", audit.ok ? "pass" : "fail", audit.ok ? `${roleText}; operator surface read-only; PUBLIC has nothing` : audit.problems.join("; "));
      if (!audit.ok) blockers.push("Database privileges are too broad or roles are missing (pnpm fleet:audit-privileges).");

      const st = await store.getState();
      const stale = await store.staleness();
      const timeouts = await store.getTimeouts();
      approved = st.runtime && st.build ? { ...st.runtime, ...st.build } : null;
      Object.assign(facts, {
        fleetMaximum: st.maxAgents,
        livingAgents: st.livingAgents,
        reservedSlots: st.reservedSlots,
        operatingMode: st.operatingMode,
        dbReplicationSwitch: st.replicationEnabled,
        staleAgents: stale.staleAgents,
        unresponsiveAgents: stale.unresponsive,
        staleReservations: stale.staleReservations,
        openReservations: stale.openReservations,
        unterminatedSandboxes: stale.unterminatedSandboxes,
        reaperLastRunAt: stale.reaperLastRunAt,
        openOrphans: stale.openOrphans,
        provisioningNeedingCleanup: stale.provisioningNeedingCleanup,
        quarantinedAgents: stale.quarantined,
        terminatingAgents: stale.terminating,
        quarantinedSlots: st.quarantinedSlots ?? 0,
        uncertainProvisioning: stale.uncertainProvisioning,
        dryRunChildren: stale.dryRunChildren,
        dryRunProven: stale.dryRunProven,
        timeouts,
      });
      add("fleet population", "pass", `${st.livingAgents} living + ${st.reservedSlots} reserved / max ${st.maxAgents} (mode ${st.operatingMode})`);
      add("DB replication switch", st.replicationEnabled ? "warn" : "pass", st.replicationEnabled ? "ON in registry" : "off");
      add("stale agents", stale.staleAgents ? "warn" : "pass", `${stale.staleAgents} past heartbeat timeout, ${stale.unresponsive} unresponsive`);
      add("stale reservations", stale.staleReservations ? "warn" : "pass", `${stale.staleReservations} expired but not yet reaped (${stale.openReservations} open)`);
      const reaperAgeS = stale.reaperLastRunAt ? (Date.now() - Date.parse(stale.reaperLastRunAt)) / 1000 : null;
      add("reaper", reaperAgeS !== null && reaperAgeS < 120 ? "pass" : "warn",
        reaperAgeS === null ? "has never run" : `last pass ${Math.round(reaperAgeS)} s ago`);
      if (stale.unterminatedSandboxes) {
        add("zombie sandboxes", "warn", `${stale.unterminatedSandboxes} dead agents' sandboxes not confirmed terminated`);
      }
      add("orphaned infrastructure", stale.openOrphans ? "warn" : "pass",
        `${stale.openOrphans} unresolved orphan(s); ${stale.quarantined} agent(s) holding quarantine slots; ${stale.provisioningNeedingCleanup} provisioning record(s) awaiting cleanup`);
      if (stale.openOrphans) blockers.push(`${stale.openOrphans} orphaned sandbox(es) unresolved (fleet:admin orphans / resolve-orphan).`);
      add("uncertain provisioning", stale.uncertainProvisioning ? "warn" : "pass",
        `${stale.uncertainProvisioning} attempt(s) whose sandbox may exist but was never identified (fleet:admin reconcile-provisioning)`);
      if (stale.uncertainProvisioning) blockers.push(`${stale.uncertainProvisioning} provisioning attempt(s) with an unreconciled sandbox outcome.`);
    } catch (err) {
      add("registry state", "fail", err instanceof Error ? err.message : String(err));
    }

    // ── Operator API (schema v8). Detailed checks only: the 16-item operator
    // checklist (and its 16/16 meaning) is deliberately unchanged (B2 F10).
    const ov = await store.operatorOverview();
    facts.operatorApi = ov;
    if (ov) {
      const lvl = auditLevel(ov.requestCount, ov.requestCap);
      const pct = ov.requestCap > 0 ? ((ov.requestCount / ov.requestCap) * 100).toFixed(1) : "?";
      add(
        "operator audit capacity",
        lvl === "full" ? "fail" : lvl === "ok" ? "pass" : "warn",
        `${ov.requestCount}/${ov.requestCap} request rows (${pct}%)` +
          (lvl === "info" ? " — early warning (>= 50%): plan an archive (fleet:admin operator-archive)"
            : lvl === "elevated" ? " — ELEVATED (>= 75%): archive soon"
            : lvl === "full" ? " — FULL: the Operator API fails closed (FLEET_OP_AUDIT_FULL); archive required" : ""),
      );
      add("operator kill switch", "pass", ov.enabled ? `enabled (generation ${ov.generation})` : `disabled (generation ${ov.generation}); the Operator API refuses every request`);
      add(
        "operator principals",
        ov.keysExpiringSoon ? "warn" : "pass",
        `${ov.activePrincipals} active principal(s), ${ov.activeKeys} active key(s)` + (ov.keysExpiringSoon ? `; ${ov.keysExpiringSoon} key(s) expire within 14 days` : ""),
      );
      add("operator denials", ov.recentDenials > 20 ? "warn" : "pass", `${ov.recentDenials} denied operator request(s) in the last 10 minutes`);
    }
  }

  // ── Log/audit disk usage (D-9): warn at 80% used, fail at 95%.
  try {
    const sf = fs.statfsSync(deps.paths?.logDir ?? "/var/log");
    const usedPct = sf.blocks > 0 ? (1 - sf.bavail / sf.blocks) * 100 : 0;
    facts.logDiskUsedPct = Math.round(usedPct * 10) / 10;
    add("log disk usage", usedPct >= 95 ? "fail" : usedPct >= 80 ? "warn" : "pass", `${usedPct.toFixed(1)}% used on the filesystem holding ${deps.paths?.logDir ?? "/var/log"}`);
  } catch {
    add("log disk usage", "warn", "could not inspect the log filesystem");
  }

  // ── Runtime release
  const release = loadRuntimeRelease(env);
  facts.runtimeRepo = env.FLEET_RUNTIME_REPO ?? null;
  facts.runtimeCommit = env.FLEET_RUNTIME_COMMIT ?? null;
  facts.runtimeBuildId = env.FLEET_RUNTIME_BUILD_ID ?? null;
  facts.approvedRuntime = approved;
  const relProblem = runtimeReleaseProblem(env);
  if (relProblem) {
    add("runtime release", "warn", relProblem);
    blockers.push(`No pinned runtime release: ${relProblem}`);
  } else {
    add("runtime release", "pass", `${release!.repo}@${release!.commit} build ${release!.buildId.slice(0, 16)}…`);
  }
  if (store && dbOk) {
    if (!approved) {
      add("approved runtime", "warn", "registry has no approved runtime (replication impossible)");
      blockers.push("No runtime approved in the registry (fleet:admin approve-runtime).");
    } else if (release && !sameRelease(release, approved)) {
      add("approved runtime", "fail", `registry approves ${approved.commit}/${approved.buildId.slice(0, 12)}, release pins ${release.commit}/${release.buildId.slice(0, 12)}`);
      blockers.push("Pinned runtime release differs from the registry-approved runtime.");
    } else {
      add("approved runtime", "pass", `${approved.repo}@${approved.commit}`);
    }
  }

  // ── Fleet service
  const apiUrl = (env.FLEET_API_URL?.trim() || "http://127.0.0.1:8787").replace(/\/+$/, "");
  facts.serviceUrl = apiUrl;
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${apiUrl}/readyz`, { signal: AbortSignal.timeout(3000) });
    const body = (await res.json().catch(() => ({}))) as { ready?: boolean; checks?: Record<string, { ok: boolean; warn?: boolean; detail?: string }>; realReplicationEnabled?: boolean };
    facts.serviceState = body.ready ? "ready" : "not ready";
    facts.serviceReplicationEnabled = body.realReplicationEnabled ?? null;
    const failing = Object.entries(body.checks ?? {}).filter(([, c]) => !c.ok).map(([k, c]) => `${k}: ${c.detail ?? "failed"}`);
    add("fleet service", body.ready ? "pass" : "fail", body.ready ? `ready at ${apiUrl}` : `not ready: ${failing.join("; ") || res.status}`);
    if (body.realReplicationEnabled) add("service REAL_REPLICATION_ENABLED", "fail", "service reports replication enabled");
    if (!body.ready) blockers.push("Fleet service is not ready.");
  } catch (err) {
    facts.serviceState = "unavailable";
    add("fleet service", "fail", `unavailable at ${apiUrl} (${err instanceof Error ? err.message : String(err)})`);
    blockers.push("Fleet service is not running.");
  }

  // ── OS isolation and secrets
  const users = namesIn(p.passwd ?? "/etc/passwd");
  const groups = namesIn(p.group ?? "/etc/group");
  for (const u of [FLEET_SERVICE_USER, FLEET_AGENT_USER]) {
    const ok = users.has(u);
    add(`os user ${u}`, ok ? "pass" : "fail", ok ? "exists" : "missing");
    if (!ok) blockers.push(`OS user ${u} does not exist (OS isolation not set up).`);
  }
  if (!groups.has(FLEET_ADMIN_GROUP)) {
    add(`os group ${FLEET_ADMIN_GROUP}`, "fail", "missing");
    blockers.push(`OS group ${FLEET_ADMIN_GROUP} does not exist.`);
  } else add(`os group ${FLEET_ADMIN_GROUP}`, "pass", "exists");

  const etc = p.etcDir ?? FLEET_ETC_DIR;
  const adminEnv = p.adminEnv ?? DEFAULT_ADMIN_ENV_FILE;
  const serviceEnv = p.serviceEnv ?? DEFAULT_SERVICE_ENV_FILE;
  if (!fs.existsSync(etc)) {
    add("secret directory", "fail", `${etc} missing`);
    blockers.push(`${etc} does not exist (secret files not installed).`);
  } else {
    for (const [file, group] of [[adminEnv, true], [serviceEnv, false]] as const) {
      const problems = secretFileProblems(file, { allowGroupRead: group });
      add(`secret file ${path.basename(file)}`, problems.length ? "fail" : "pass", problems.length ? problems.join("; ") : `mode ok (${(fs.statSync(file).mode & 0o777).toString(8)})`);
      if (problems.length) blockers.push(`Secret file problem: ${problems.join("; ")}`);
    }
  }
  const legacy = readEnvFile(path.join(cwd, LEGACY_ENV_FILE));
  const leaked = CONTROLLER_SECRET_KEYS.filter((k) => legacy[k]);
  if (leaked.length) {
    const w = `Repository ${LEGACY_ENV_FILE} still contains controller secrets (${leaked.join(", ")}); anything running as this user can read them.`;
    securityWarnings.push(w);
    add("legacy .env.fleet", "warn", w);
    blockers.push("Controller credentials are still in the repository .env.fleet.");
  }
  const unit = p.systemdUnit ?? SYSTEMD_UNIT_PATH;
  if (!fs.existsSync(unit)) {
    add("systemd unit", "fail", `${unit} not installed`);
    blockers.push("Fleet service systemd unit is not installed.");
  } else add("systemd unit", "pass", unit);
  if (env.FLEET_API_URL && !/^http:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/.test(apiUrl) && !apiUrl.startsWith("https://")) {
    securityWarnings.push(`FLEET_API_URL ${apiUrl} is neither loopback nor https.`);
  }

  // ── Structural blockers that no configuration can clear yet
  if (!deps.sandboxTerminationGuaranteed) {
    add("sandbox termination", "warn", "not supported by the Conway API; dead agents' sandboxes may keep running");
    blockers.push("Sandbox termination cannot be guaranteed (Conway API has no stop/delete); zombie children are contained but not stopped.");
  }
  // In production the cert is the systemd credential copy (tls.crt) and the key comes from LoadCredential=tls.key.
  const tlsCertCredential = path.join(SYSTEMD_CREDENTIALS_ROOT, FLEET_SYSTEMD_UNIT, TLS_CERT_CREDENTIAL);
  const certViaCredential = env.FLEET_TLS_CERT_FILE?.trim() === tlsCertCredential;
  const tlsConfigured = !!(env.FLEET_TLS_CERT_FILE && (env.FLEET_TLS_KEY_FILE || env.CREDENTIALS_DIRECTORY || certViaCredential));
  const remote = env.FLEET_REMOTE_LISTEN_ENABLED?.trim().toLowerCase() === "true";
  facts.tlsConfigured = tlsConfigured;
  facts.remoteListenEnabled = remote;
  add("remote fleet endpoint", tlsConfigured && remote ? "pass" : "warn",
    tlsConfigured && remote ? "HTTPS listener enabled" : "no HTTPS endpoint reachable by remote child sandboxes (loopback only)");
  if (!(tlsConfigured && remote)) {
    blockers.push("Remote child sandboxes cannot reach the fleet service: no HTTPS endpoint deployed (certificate, DNS, firewall).");
  }
  // Wallet custody: the upstream runtime generates and holds its own wallet key.
  add("wallet custody", "warn", "agent wallets are controller-supervised (freeze, spend requests) but keys are still generated and held by each agent runtime");
  blockers.push("Agent wallet keys are still generated and held by the agent runtime (~/.automaton/wallet.json); no controller custody signer exists yet.");

  facts.securityWarnings = securityWarnings;
  const deploymentOk = !checks.some((c) => c.status === "fail");

  // ── Phase 6: operator checklist
  const fetchImpl = deps.fetchImpl ?? fetch;
  const checklist: ChecklistItem[] = [];
  const item = (name: string, ok: boolean, detail: string) => checklist.push({ item: name, ok, detail });
  const privOk = Array.isArray(facts.privilegeProblems) && (facts.privilegeProblems as string[]).length === 0;
  item(
    "PostgreSQL roles correct",
    dbOk && privOk,
    privOk
      ? facts.operatorRoles === "not_provisioned"
        ? "agent/service roles least-privilege; operator roles: not provisioned"
        : "agent/service/operator roles least-privilege"
      : "privilege audit failed or not run",
  );
  item(`schema v${FLEET_PG_SCHEMA_VERSION}`, facts.schemaVersion === FLEET_PG_SCHEMA_VERSION, `v${facts.schemaVersion ?? "none"}`);

  const unitState = await (deps.serviceActive ?? defaultServiceActive)().catch(() => null);
  facts.systemdState = unitState;
  item("controller service active", unitState === "active" && facts.serviceState === "ready",
    `systemd ${unitState ?? "unknown"}, /readyz ${String(facts.serviceState ?? "unknown")}`);

  const passwd = p.passwd ?? "/etc/passwd";
  const group = p.group ?? "/etc/group";
  const tlsKey = env.FLEET_TLS_KEY_FILE?.trim() || path.join(etc, "tls", "fleet.key");
  const exposures: string[] = [];
  for (const [file, users] of [
    [adminEnv, [FLEET_AGENT_USER, FLEET_SERVICE_USER]],
    [serviceEnv, [FLEET_AGENT_USER, FLEET_SERVICE_USER]],
    [tlsKey, [FLEET_AGENT_USER, FLEET_SERVICE_USER]],
  ] as const) {
    for (const u of users) if (osUserCanRead(file, u, passwd, group) === true) exposures.push(`${u} can read ${file}`);
  }
  facts.secretExposures = exposures;
  const secretFilesOk = fs.existsSync(etc) && !checks.some((c) => c.name.startsWith("secret file") && c.status !== "pass");
  item("privileged secrets protected", secretFilesOk && exposures.length === 0 && leaked.length === 0,
    [!secretFilesOk ? "secret files missing or mis-permissioned" : "", ...exposures, leaked.length ? "controller secrets in repository .env.fleet" : ""]
      .filter(Boolean).join("; ") || "admin.env/service.env/TLS key unreadable to agent and service users; none in the repository");

  const pinnedOk = !relProblem;
  const matches = (k: "repo" | "commit" | "buildId") => pinnedOk && !!approved && release![k] === approved[k];
  item("runtime repo pinned", matches("repo"), `${env.FLEET_RUNTIME_REPO || "unset"}${approved ? ` (approved ${approved.repo})` : ""}`);
  item("runtime commit pinned", matches("commit"), `${env.FLEET_RUNTIME_COMMIT || "unset"}`);
  item("build ID pinned", matches("buildId") && release!.lockfileSha256 === approved!.lockfileSha256, `${env.FLEET_RUNTIME_BUILD_ID || "unset"}`);

  const hostname = env.FLEET_PUBLIC_HOSTNAME?.trim() || "";
  // The operator cannot read /run/credentials; check the LoadCredential=tls.crt source instead.
  const certFile = certViaCredential ? path.join(etc, "tls", "fleet.crt") : env.FLEET_TLS_CERT_FILE?.trim() || "";
  const certProblems = !hostname || !certFile ? ["FLEET_PUBLIC_HOSTNAME / FLEET_TLS_CERT_FILE not configured"] : certificateProblems(certFile, hostname);
  facts.publicHostname = hostname || null;
  item("HTTPS valid", certProblems.length === 0 && remote, certProblems.join("; ") || (remote ? `certificate valid for ${hostname}` : "remote listener disabled"));

  const publicUrl = (env.FLEET_PUBLIC_URL?.trim() || (hostname ? `https://${hostname}${env.FLEET_PUBLIC_PORT ? `:${env.FLEET_PUBLIC_PORT}` : ""}` : "")).replace(/\/+$/, "");
  let remoteOk = false;
  let remoteDetail = "no public URL configured";
  if (publicUrl.startsWith("https://")) {
    try {
      const r = await fetchImpl(`${publicUrl}/healthz`, { signal: AbortSignal.timeout(5000) });
      const b = (await r.json().catch(() => ({}))) as { ok?: boolean };
      remoteOk = r.ok && b.ok === true;
      remoteDetail = `${publicUrl}/healthz -> ${r.status}`;
    } catch (err) {
      remoteDetail = `${publicUrl} unreachable (${err instanceof Error ? err.message : String(err)})`;
    }
  }
  facts.publicUrl = publicUrl || null;
  item("remote controller reachable", remoteOk, remoteDetail);

  const probes = facts.serviceState === "ready" ? await replayProbes(apiUrl, fetchImpl) : null;
  item("replay protection working", !!probes?.staleRefused && (facts.schemaVersion as number) >= 4,
    probes ? `${probes.detail}; nonce ledger fleet_request_nonces (schema v${facts.schemaVersion})` : "service not ready; not probed");
  item("agent credentials scoped", privOk && !!probes?.sessionOnly,
    `agent role: api_* only (${privOk ? "audit pass" : "audit fail"}); long-lived credential ${probes?.sessionOnly ? "only opens sessions" : "not verified"}`);
  item("payments disabled", !flags.REAL_PAYMENTS_ENABLED, flags.REAL_PAYMENTS_ENABLED ? "REAL_PAYMENTS_ENABLED=true" : "REAL_PAYMENTS_ENABLED=false");
  item("owner sweeps disabled", !flags.OWNER_SWEEP_ENABLED, flags.OWNER_SWEEP_ENABLED ? "OWNER_SWEEP_ENABLED=true" : "OWNER_SWEEP_ENABLED=false");
  item("fleet cap = 2", facts.fleetMaximum === 2, `max ${facts.fleetMaximum ?? "unknown"}`);
  item("no unresolved orphan", dbOk && facts.openOrphans === 0, `${facts.openOrphans ?? "unknown"} open`);
  const stuck = (facts.staleReservations as number | undefined) ?? null;
  const uncertain = (facts.uncertainProvisioning as number | undefined) ?? null;
  item("no stuck reservation", dbOk && stuck === 0 && uncertain === 0, `${stuck ?? "unknown"} expired-unreaped, ${uncertain ?? "unknown"} uncertain provisioning`);

  // ── Phase 6: independent readiness levels
  const failing = checks.filter((c) => c.status === "fail").map((c) => `${c.name}: ${c.detail}`);
  const dryRun = [
    ...failing,
    ...checklist.filter((c) => !c.ok).map((c) => `${c.item}: ${c.detail}`),
    ...(flags.REAL_REPLICATION_ENABLED ? ["REAL_REPLICATION_ENABLED must stay false until the dry run passes"] : []),
    ...((facts.dryRunChildren as number) > 0 ? ["a dry-run child already exists"] : []),
  ];
  const realReplication = [
    ...dryRun.filter((b) => !b.startsWith("a dry-run child already exists")),
    ...(((facts.dryRunProven as number) ?? 0) > 0 ? [] : ["No dry-run child has yet reached ACTIVE and passed a controller challenge (pnpm fleet:dry-run-child)."]),
    ...blockers,
  ];
  const realPayments = [
    ...failing,
    ...checklist.filter((c) => !c.ok && /PostgreSQL|schema|secrets|owner sweeps/.test(c.item)).map((c) => `${c.item}: ${c.detail}`),
    ...(deps.custodySignerAvailable ? [] : ["No controller custody signer exists; approved spends cannot be executed safely (executeApprovedSpend refuses)."]),
    "Agent wallet keys are still generated and held by the agent runtime; payments need controller-held custody first.",
    ...(flags.OWNER_SWEEP_ENABLED ? ["OWNER_SWEEP_ENABLED must stay false until owner distributions are separately approved."] : []),
  ];
  const level = (b: string[]): ReadinessLevel => ({ safe: b.length === 0, blockers: [...new Set(b)] });
  const readiness = { dryRun: level(dryRun), realReplication: level(realReplication), realPayments: level(realPayments) };
  const replicationSafe = deploymentOk && readiness.realReplication.safe;
  return { deploymentOk, replicationSafe, readiness, checklist, checks, blockers: [...new Set(blockers)], securityWarnings, facts };
}

export function formatChecklist(r: DoctorReport): string {
  const lines = ["Automaton Fleet — operator verification", ""];
  for (const c of r.checklist) lines.push(`  [${c.ok ? "PASS" : "FAIL"}] ${c.item.padEnd(30)} ${c.detail}`);
  lines.push("", ...formatReadiness(r));
  return lines.join("\n");
}

function formatReadiness(r: DoctorReport): string[] {
  const lines: string[] = [];
  const show = (label: string, l: ReadinessLevel) => {
    lines.push(`${label.padEnd(27)} ${l.safe ? "YES" : `NO (${l.blockers.length} blocker${l.blockers.length === 1 ? "" : "s"})`}`);
    for (const b of l.blockers) lines.push(`  - ${b}`);
  };
  show("SAFE FOR DRY RUN:", r.readiness.dryRun);
  show("SAFE FOR REAL REPLICATION:", r.readiness.realReplication);
  show("SAFE FOR REAL PAYMENTS:", r.readiness.realPayments);
  return lines;
}

export function formatDoctorReport(r: DoctorReport): string {
  const icon: Record<CheckStatus, string> = { pass: "PASS", warn: "WARN", fail: "FAIL" };
  const lines = ["Automaton Fleet — deployment readiness", ""];
  for (const c of r.checks) lines.push(`  [${icon[c.status]}] ${c.name.padEnd(34)} ${c.detail}`);
  lines.push("");
  const f = r.facts;
  const show = (k: string, v: unknown) => lines.push(`  ${k.padEnd(24)} ${v === undefined || v === null ? "-" : typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  show("schema version", f.schemaVersion);
  show("fleet service", f.serviceState);
  show("runtime repo", f.runtimeRepo);
  show("runtime commit", f.runtimeCommit);
  show("runtime build id", f.runtimeBuildId);
  show("replication enabled", f.replicationEnabled);
  show("payments enabled", f.paymentsEnabled);
  show("owner sweep enabled", f.ownerSweepEnabled);
  show("fleet maximum", f.fleetMaximum);
  show("living agents", f.livingAgents);
  show("reserved slots", f.reservedSlots);
  show("stale agents", f.staleAgents);
  show("stale reservations", f.staleReservations);
  if (r.securityWarnings.length) {
    lines.push("", "Security warnings:");
    for (const w of r.securityWarnings) lines.push(`  - ${w}`);
  }
  lines.push("", "Operator checklist:");
  for (const c of r.checklist) lines.push(`  [${c.ok ? "PASS" : "FAIL"}] ${c.item.padEnd(30)} ${c.detail}`);
  lines.push("", `DEPLOYMENT:        ${r.deploymentOk ? "OK" : "FAIL"}`);
  lines.push(`REAL REPLICATION:  ${r.replicationSafe ? "SAFE" : `UNSAFE — FAIL (${r.blockers.length} blocker${r.blockers.length === 1 ? "" : "s"})`}`);
  lines.push("", ...formatReadiness(r));
  return lines.join("\n");
}
```

## `src/fleet/grants.ts`

sha256 `b7a9a24d8a8d5ce41c178a0b50891a1afc0478e3e5c2321387727aa2d0610e32` · 3941 bytes · 99 lines

```ts
/**
 * Fleet spawn grants
 *
 * A grant is proof that a slot was reserved. Grants issued by the shared
 * (PostgreSQL) registry are bound here to the store that issued them; the
 * binding lives in a module-private WeakMap, so an object merely shaped like
 * a grant (forged, deserialised, or copied from a reservation id) has no
 * binding and cannot be claimed through the shared path.
 *
 * Grants without a binding fall back to the Phase 1 local SQLite registry,
 * which checks the reservation row itself. Production call sites (spawn_child
 * tool, orchestrator) only ever obtain shared grants.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { FleetBypassError, FleetRegistry } from "./registry.js";
import { loadRuntimePin, type RuntimePin } from "./runtime.js";
import { loadRuntimeBuild, newAttestationNonce, type RuntimeBuild } from "./attestation.js";
import type { FleetSpawnGrant } from "./types.js";

export interface ClaimedGrant {
  agentId: string;
  parentAgentId: string | null;
  generation: number;
  /** Runtime the child must run, as approved for this reservation. */
  runtime: RuntimePin | null;
  /** Build identity the child must prove before activation (Phase 3). */
  expectedBuild: RuntimeBuild | null;
  /** Single-use attestation nonce issued at claim time (Phase 3). */
  nonce: string | null;
  reservationId: string | null;
  backend: "postgres" | "sqlite";
  /**
   * Phase 5: report provisioning progress to the controller. Called the
   * moment a sandbox exists ("sandbox_created") and before runtime
   * verification ("verifying"), so a failed provisioning stays visible for
   * cleanup. Absent for the local (SQLite) path.
   */
  reportProvisioning?: (phase: "sandbox_created" | "verifying", sandboxId?: string) => Promise<void>;
  /**
   * Phase 6: the provisioning key (= reservation id). Carried through sandbox
   * creation (deterministic sandbox name), the child's runtime manifest, the
   * provisioning callbacks and activation.
   */
  provisioningKey?: string | null;
  /**
   * Phase 6: record the durable external-resource intent BEFORE creating the
   * sandbox. Returns the attempt number and the sandbox id if the controller
   * already knows it (then it must be reused).
   */
  recordSandboxIntent?: (sandboxName: string) => Promise<{ sandboxId: string | null; attempts: number; sandboxName: string }>;
  /** Phase 6: report the outcome of looking up an uncertain sandbox by name. */
  reconcileProvisioning?: (outcome: "found" | "absent" | "unknown", sandboxId?: string) => Promise<void>;
}

type Claimer = (localChildId: string) => Promise<ClaimedGrant>;

const bindings = new WeakMap<FleetSpawnGrant, Claimer>();

export function createBoundGrant(reservationId: string, claim: Claimer): FleetSpawnGrant {
  const grant: FleetSpawnGrant = Object.freeze({ kind: "fleet-spawn-grant", reservationId });
  bindings.set(grant, claim);
  return grant;
}

export function isSharedGrant(grant: unknown): boolean {
  return typeof grant === "object" && grant !== null && bindings.has(grant as FleetSpawnGrant);
}

/**
 * Consume a grant exactly once. Throws FleetBypassError when the grant is
 * missing, malformed, forged, expired or already used.
 */
export async function claimFleetGrant(
  grant: FleetSpawnGrant | undefined,
  localChildId: string,
  localDb: DatabaseType,
): Promise<ClaimedGrant> {
  if (grant && typeof grant === "object") {
    const claim = bindings.get(grant);
    if (claim) {
      bindings.delete(grant);
      return claim(localChildId);
    }
  }
  const agent = new FleetRegistry(localDb).claimGrant(grant, localChildId);
  return {
    agentId: agent.id,
    parentAgentId: agent.parentAgentId,
    generation: agent.generation,
    runtime: loadRuntimePin(),
    expectedBuild: loadRuntimeBuild(),
    nonce: newAttestationNonce(),
    reservationId: agent.id,
    backend: "sqlite",
  };
}

export { FleetBypassError };
```

## `src/fleet/index.ts`

sha256 `2cf4db43a916990c92ccd716f57e94e97cc7398ce47f9d03a7d51acfd4127e6f` · 3844 bytes · 98 lines

```ts
/**
 * Fleet layer public API.
 */

import type { ToolContext } from "../types.js";
import { getSurvivalTier } from "../conway/credits.js";
import { loadFleetConfig } from "./config.js";
import { FleetController } from "./controller.js";
import type { FleetConfig } from "./types.js";

export * from "./types.js";
export { loadFleetConfig, DEFAULT_FLEET_CONFIG, FLEET_HARD_MAX_AGENTS } from "./config.js";
export { FleetRegistry, FleetBypassError } from "./registry.js";
export { FleetController } from "./controller.js";
export { SharedFleetController } from "./shared-controller.js";
export {
  getActiveSharedFleet,
  setActiveSharedFleet,
  getSharedFleetForContext,
  requestSharedReplication,
  closeActiveSharedFleet,
} from "./shared.js";
export {
  PgFleetStore,
  FleetRegistryUnavailableError,
  FleetDuplicateRegistrationError,
  agentIdFromToken,
  hashAgentToken,
} from "./postgres/store.js";
export type { FleetTimeouts } from "./postgres/store.js";
export { FLEET_PG_SCHEMA_VERSION, PG_MIGRATIONS, AGENT_API_FUNCTIONS, SERVICE_API_FUNCTIONS, SERVICE_READ_TABLES } from "./postgres/migrations.js";
export { auditPrivileges } from "./postgres/privileges.js";
export type { PrivilegeAuditResult } from "./postgres/privileges.js";
export { runDoctor, formatDoctorReport } from "./doctor.js";
export type { DoctorReport, DoctorCheck } from "./doctor.js";
export { readSecretEnvFile, loadAdminEnv, loadServiceEnv, SecretFileError } from "./secret-files.js";
export { UnsupportedSandboxTerminator } from "./service/terminator.js";
export * as treasury from "./treasury/engine.js";
export { PgTreasuryStore } from "./treasury/store.js";
export { executeApprovedSpend } from "./treasury/custody.js";
export { RateLimiter } from "./service/rate-limit.js";
export { signRequest, canonicalRequest, SIG_HEADERS } from "./service/server-signing.js";
export { defaultHealthResponder } from "./service/client.js";
export type { HealthResponder } from "./service/client.js";
export type { SandboxTerminator } from "./service/terminator.js";
export { PgAgentGateway } from "./postgres/agent-gateway.js";
export type { FleetBackend } from "./backend.js";
export { FleetService } from "./service/server.js";
export { FleetApiClient, validateServiceUrl, readCredentialFile } from "./service/client.js";
export {
  ATTEST_SCRIPT,
  computeBuildIdentity,
  checkAttestation,
  parseAttestation,
  attestationProof,
  loadRuntimeBuild,
  validateRuntimeBuild,
} from "./attestation.js";
export type { RuntimeAttestation, RuntimeBuild, BuildIdentity } from "./attestation.js";
export { findPrivilegedEnv, scrubPrivilegedEnv, agentChildEnv, isPrivilegedEnvName } from "./secrets.js";
export {
  FleetRuntimeError,
  validateRuntimePin,
  loadRuntimePin,
  resolveChildRuntime,
  verifyChildRuntime,
  verifyOwnRuntime,
  isUpstreamRepo,
} from "./runtime.js";
export type { RuntimePin } from "./runtime.js";
export {
  computeFleetState,
  evaluateReplication,
  evaluateToolCall,
  evaluateFinancialEligibility,
  EMERGENCY_BLOCKED_TOOLS,
} from "./policy.js";

/**
 * Build a Phase 1 local (SQLite) controller. Local-only: it cannot see other
 * sandboxes, so no production replication path uses it — spawn_child and the
 * orchestrator go through requestSharedReplication().
 */
export function createFleetControllerForContext(
  ctx: Pick<ToolContext, "db" | "identity" | "config" | "conway">,
  fleetConfig: FleetConfig = loadFleetConfig(),
): FleetController {
  return new FleetController({
    db: ctx.db.raw,
    config: fleetConfig,
    self: { address: ctx.identity.address, name: ctx.config.name },
    isRootAgent: !ctx.config.parentAddress,
    getFinancialSnapshot: async () => {
      const creditsCents = await ctx.conway.getCreditsBalance();
      return { creditsCents, survivalTier: getSurvivalTier(creditsCents) };
    },
  });
}
```

## `src/fleet/policy.ts`

sha256 `f345052d146e0eac4ac4710a88b733f8444e9fc4f96485782f931d1369f51987` · 6464 bytes · 195 lines

```ts
/**
 * Fleet Policy
 *
 * Pure decision functions. No I/O: callers supply registry counts and
 * financial snapshots. These rules live in code, not in the system prompt,
 * and are consulted by both FleetController and the PolicyEngine rule.
 */

import type {
  FinancialSnapshot,
  FleetConfig,
  FleetDecision,
  FleetDecisionCode,
  FleetState,
} from "./types.js";

/** Tools that spend money or create resources; blocked in EMERGENCY. */
export const EMERGENCY_BLOCKED_TOOLS: ReadonlySet<string> = new Set([
  "spawn_child",
  "fund_child",
  "start_child",
  "transfer_credits",
  "x402_fetch",
  "create_sandbox",
  "register_domain",
]);

/**
 * Tools that create or bring up fleet agents. They require a healthy shared
 * registry; when PostgreSQL is unreachable they fail closed while every other
 * tool keeps working.
 */
export const REPLICATION_TOOLS: ReadonlySet<string> = new Set(["spawn_child", "start_child", "fund_child"]);

const ELIGIBLE_TIERS = new Set(["normal", "high"]);

function decision(
  allowed: boolean,
  code: FleetDecisionCode,
  reason: string,
  state: FleetState,
): FleetDecision {
  return { allowed, code, reason, state };
}

/**
 * Effective fleet state. Precedence:
 *   EMERGENCY (flag or configured) > DEVELOPMENT > HARVEST (configured, or
 *   automatically when living >= max) > EXPANSION.
 */
export function computeFleetState(input: {
  configuredMode: FleetState;
  emergency: boolean;
  livingAgents: number;
  maxAgents: number;
}): FleetState {
  if (input.emergency || input.configuredMode === "EMERGENCY") return "EMERGENCY";
  if (input.configuredMode === "DEVELOPMENT") return "DEVELOPMENT";
  if (input.livingAgents >= input.maxAgents) return "HARVEST";
  if (input.configuredMode === "HARVEST") return "HARVEST";
  return "EXPANSION";
}

export function evaluateFinancialEligibility(
  snapshot: FinancialSnapshot | null,
  config: FleetConfig,
  state: FleetState,
): FleetDecision {
  if (!snapshot) {
    return decision(false, "FINANCIALLY_INELIGIBLE", "Financial state unavailable; replication fails closed.", state);
  }
  if (!ELIGIBLE_TIERS.has(snapshot.survivalTier)) {
    return decision(
      false,
      "FINANCIALLY_INELIGIBLE",
      `Survival tier '${snapshot.survivalTier}' is not eligible for replication (requires normal or high).`,
      state,
    );
  }
  if (!Number.isFinite(snapshot.creditsCents) || snapshot.creditsCents < config.minParentReserveCents) {
    return decision(
      false,
      "FINANCIALLY_INELIGIBLE",
      `Credits ${snapshot.creditsCents}c below required parent reserve ${config.minParentReserveCents}c.`,
      state,
    );
  }
  return decision(true, "ALLOWED", "Financial eligibility passed.", state);
}

/**
 * Synchronous replication gate (everything except financial eligibility).
 * The cap check here is advisory; the authoritative check is the atomic
 * reservation in FleetRegistry.reserveSlot().
 */
export function evaluateReplication(input: {
  config: FleetConfig;
  state: FleetState;
  livingAgents: number;
  maxAgents: number;
  isRootAgent: boolean;
  /** True when counts come from the shared (PostgreSQL) registry. */
  sharedRegistry?: boolean;
}): FleetDecision {
  const { config, state } = input;
  switch (state) {
    case "EMERGENCY":
      return decision(false, "FLEET_EMERGENCY", "Fleet is in EMERGENCY: replication disabled.", state);
    case "DEVELOPMENT":
      return decision(false, "FLEET_DEVELOPMENT_MODE", "Fleet is in DEVELOPMENT: real replication disabled.", state);
    case "HARVEST":
      return decision(
        false,
        input.livingAgents >= input.maxAgents ? "FLEET_CAP_REACHED" : "FLEET_HARVEST",
        `Fleet is in HARVEST (${input.livingAgents}/${input.maxAgents} living): replication disabled.`,
        state,
      );
    case "EXPANSION":
      break;
  }
  if (!config.realReplicationEnabled) {
    return decision(false, "REAL_REPLICATION_DISABLED", "REAL_REPLICATION_ENABLED is false.", state);
  }
  if (!input.isRootAgent && !input.sharedRegistry) {
    // A child's local registry cannot see the global lineage, so without the
    // shared registry only the fleet root may replicate.
    return decision(false, "NOT_FLEET_ROOT", "Only the fleet root may request replication.", state);
  }
  if (input.livingAgents >= input.maxAgents) {
    return decision(false, "FLEET_CAP_REACHED", `Fleet at cap (${input.livingAgents}/${input.maxAgents}).`, state);
  }
  return decision(true, "ALLOWED", "Replication permitted pending slot reservation.", state);
}

/**
 * Tool-level gate used by the PolicyEngine rule. Returns null when the
 * fleet policy has no objection.
 */
export function evaluateToolCall(input: {
  toolName: string;
  args: Record<string, unknown>;
  config: FleetConfig;
  state: FleetState;
  livingAgents: number;
  maxAgents: number;
  isRootAgent: boolean;
  sharedRegistry?: boolean;
  isFleetMemberAddress: (address: string) => boolean;
}): FleetDecision | null {
  const { toolName, config, state } = input;

  if (state === "EMERGENCY" && EMERGENCY_BLOCKED_TOOLS.has(toolName)) {
    return decision(
      false,
      "FLEET_EMERGENCY",
      `Fleet is in EMERGENCY: non-essential expenditure (${toolName}) blocked.`,
      state,
    );
  }

  switch (toolName) {
    case "spawn_child": {
      const d = evaluateReplication(input);
      return d.allowed ? null : d;
    }
    case "fund_child":
      if (state === "DEVELOPMENT") {
        return decision(false, "FLEET_DEVELOPMENT_MODE", "Fleet is in DEVELOPMENT: child funding disabled.", state);
      }
      if (!config.realPaymentsEnabled) {
        return decision(false, "REAL_PAYMENTS_DISABLED", "REAL_PAYMENTS_ENABLED is false: child funding disabled.", state);
      }
      return null;
    case "start_child":
      if (state === "DEVELOPMENT") {
        return decision(false, "FLEET_DEVELOPMENT_MODE", "Fleet is in DEVELOPMENT: starting children disabled.", state);
      }
      return null;
    case "transfer_credits": {
      if (config.realPaymentsEnabled) return null;
      const to = typeof input.args.to_address === "string" ? input.args.to_address : "";
      if (to && input.isFleetMemberAddress(to)) {
        return decision(
          false,
          "FLEET_CHILD_FUNDING_BYPASS",
          "Transfers to fleet members are child funding and require REAL_PAYMENTS_ENABLED.",
          state,
        );
      }
      return null;
    }
    default:
      return null;
  }
}
```

## `src/fleet/redact-scan.ts`

sha256 `bc4b7d6e84289a2e080fc42bfd013d4208cf97c7d48d197321201e09f13913a5` · 3119 bytes · 95 lines

```ts
/**
 * Count-only offline scan of audit/log files (Gate B0).
 *
 * Uses exactly the canonical detection rules of ./redact.ts (scan mode: no
 * depth/width/length bounds, so nothing is skipped). The report contains
 * file metadata and per-class counts only — never matched text, line
 * content, offsets or digests of matches.
 *
 * The operator may run it as root, so it refuses any filesystem indirection:
 * a path whose real path differs (a symlink anywhere in it), a symlink as the
 * final component (O_NOFOLLOW), anything but a regular file (checked on the
 * opened descriptor; O_NONBLOCK so a FIFO cannot block the open) and a file
 * with more than one hard link. It never loads fleet credentials.
 */

import fs from "fs";
import path from "path";
import readline from "readline";
import { newScanCounts, scanText, scanValue, type ScanCounts } from "./redact.js";

export interface AuditFileScanReport {
  path: string;
  size: number;
  mode: string;
  uid: number;
  gid: number;
  nlink: number;
  mtime: string;
  lines: number;
  jsonLines: number;
  nonJsonLines: number;
  /** JSON lines too deeply nested for a structural walk; scanned as raw text instead. */
  textFallbackLines: number;
  /** Lines containing at least one detection. */
  affectedLines: number;
  total: number;
  classes: ScanCounts["classes"];
}

export async function scanAuditFile(file: string): Promise<AuditFileScanReport> {
  const abs = path.resolve(file);
  if (fs.realpathSync(abs) !== abs) throw new Error(`${file} resolves through a symlink; refusing to scan.`);
  const fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let st: fs.Stats;
  try {
    st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(`${file} is not a regular file; refusing to scan.`);
    if (st.nlink !== 1) throw new Error(`${file} has ${st.nlink} hard links; refusing to scan.`);
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
  const counts = newScanCounts();
  const report: Omit<AuditFileScanReport, "total" | "classes"> = {
    path: abs,
    size: st.size,
    mode: (st.mode & 0o7777).toString(8).padStart(4, "0"),
    uid: st.uid,
    gid: st.gid,
    nlink: st.nlink,
    mtime: st.mtime.toISOString(),
    lines: 0,
    jsonLines: 0,
    nonJsonLines: 0,
    textFallbackLines: 0,
    affectedLines: 0,
  };
  const rl = readline.createInterface({ input: fs.createReadStream("", { fd, encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    report.lines++;
    const before = counts.total;
    let parsed: unknown;
    let isJson = false;
    try {
      parsed = JSON.parse(line);
      isJson = true;
    } catch {
      isJson = false;
    }
    if (isJson) {
      report.jsonLines++;
      try {
        scanValue(parsed, counts);
      } catch {
        report.textFallbackLines++;
        scanText(line, counts);
      }
    } else {
      report.nonJsonLines++;
      scanText(line, counts);
    }
    if (counts.total > before) report.affectedLines++;
  }
  return { ...report, total: counts.total, classes: counts.classes };
}
```

## `src/fleet/redact.ts`

sha256 `cb16c678ed37e10714849f2b57684758370dcf907ce338458348796da1814f54` · 25193 bytes · 622 lines

```ts
/**
 * Canonical audit/log redaction (Gate B0).
 *
 * Every fleet audit/log serialization path goes through this module:
 * service stdout logs, the JSONL audit file, fleet_events rows written by
 * TypeScript (service, owner and treasury stores), free-text reason columns,
 * witness/dry-run child logs and operator CLI error output. The future
 * Operator API response builder must use it too.
 *
 * Guarantees (tested in src/__tests__/fleet/redact*.test.ts):
 *   - pure and deterministic: no clock, randomness or locale; the same input
 *     always yields the same output;
 *   - idempotent: redact(redact(x)) deep-equals redact(x);
 *   - bounded: depth, width, string, key and record sizes are capped. Input
 *     is cut at maxInput only to bound matching cost; output strings are cut
 *     at maxString (far below maxInput) *after* matching, so neither cut can
 *     emit part of a secret;
 *   - never invokes getters, never emits Error stacks, never emits a
 *     secret-derived digest;
 *   - evasion characters (zero-width, bidi, C0/C1 controls, NUL, lone
 *     surrogates) are removed and text is NFKC-normalized *before* matching.
 *
 * Public build identities survive only through an exact field-name AND exact
 * value-format allow-list (PUBLIC_FIELDS). False positives are accepted;
 * false negatives are not.
 *
 * Dependency-free (no imports) so the root witness and the dry-run child can
 * use it without widening their import graph.
 */

// ─── Limits ─────────────────────────────────────────────────────

export const REDACT_LIMITS = Object.freeze({
  /** Nesting levels walked; deeper subtrees are replaced whole. */
  maxDepth: 8,
  /** Entries kept per object/array, including the truncation marker. */
  maxWidth: 64,
  /**
   * Top-level keys kept in an audit detail: two fewer than maxWidth, so the
   * stdout copy (which adds agentId and audit) is never truncated again and
   * every sink carries the identical detail.
   */
  maxAuditDetailKeys: 62,
  /** Characters per output string (after redaction). */
  maxString: 500,
  /** Characters per output object key. */
  maxKey: 64,
  /**
   * Characters of input examined per string (bounds matching cost). Must stay
   * far above maxString: text beyond the output bound is never emitted, so a
   * secret split by this cut cannot reach any output (asserted in tests).
   */
  maxInput: 65_536,
  /** Bytes per serialized record (log line / audit line). */
  maxRecordBytes: 16_384,
});

export type RedactionClass =
  | "key"
  | "pem"
  | "userinfo"
  | "token"
  | "auth"
  | "config"
  | "kv"
  | "jwt"
  | "hex"
  | "b64"
  | "mnemonic"
  | "bytes"
  | "number";

/** Secret classes in the order they are counted/reported. */
export const REDACTION_CLASSES: readonly RedactionClass[] = Object.freeze([
  "key", "pem", "userinfo", "token", "auth", "config", "kv", "jwt", "hex", "b64", "mnemonic", "bytes", "number",
]);

export type RedactionCounter = (cls: RedactionClass) => void;

interface Options {
  onRedact?: RedactionCounter;
  /** false: scan mode — no depth/width/length bounds, so nothing is skipped. */
  bounded: boolean;
  /** Width limit for the top level only (defaults to maxWidth). */
  topWidth?: number;
}

const BOUNDED: Options = Object.freeze({ bounded: true });

// ─── Markers (never matched by any pattern below) ───────────────

export const REDACTED = "[redacted]";
const TRUNCATED = "...[truncated]";
const mark = (cls: RedactionClass) => `[redacted:${cls}]`;
/** A value that is exactly one marker. */
const MARKER_RE = /^\[redacted(?::[a-z]+)?\]$/;
/** Marker text inside a key (its class name must not trigger key-name redaction). */
const MARKER_TEXT_RE = /\[redacted(?::[a-z]+)?\]/g;

// ─── Secret key names ───────────────────────────────────────────

/**
 * Object keys whose values are always redacted, whatever their type (except
 * null/boolean, which cannot carry a secret). Matched against the key after
 * NFKC + evasion-character stripping, so "pa\u200Bssword" is still caught.
 */
export const SECRET_KEY_RE =
  /(private|secret|mnemonic|seed|passw|api[_-]?key|token|credential|database[_-]?url|authorization|cookie|signature|bearer|privkey|dsn|nonce|session[_-]?(id|key|token|secret)|(^|[_-])pem($|[_-]))/i;

/**
 * Exact field names whose value is a *public* build identity, kept only when
 * the value has exactly the expected format. Anything else under these names
 * goes through normal redaction.
 */
const HEX64 = /^[0-9a-f]{64}$/;
export const PUBLIC_FIELDS: Readonly<Record<string, RegExp>> = Object.freeze({
  buildId: HEX64,
  runtimeBuildId: HEX64,
  expectedBuildId: HEX64,
  build_id: HEX64,
  runtime_build_id: HEX64,
  expected_build_id: HEX64,
  lockfileSha256: HEX64,
  runtimeLockfileSha256: HEX64,
  expectedLockfileSha256: HEX64,
  lockfile_sha256: HEX64,
  runtime_lockfile_sha256: HEX64,
  expected_lockfile_sha256: HEX64,
});

// ─── Text pipeline ──────────────────────────────────────────────

/**
 * Zero-width, bidi, soft hyphen, invisible operators, BOM, C0 (except \t \n)
 * and C1 controls, and DEL. Removed before matching so they cannot split a
 * token and hide it from the patterns.
 */
const EVASION_RE =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u034F\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFEFF\uFFA0]/g;
const LINE_SEP_RE = /[\u2028\u2029]/g;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Skip a value only when it already is exactly one marker: quoted (the
 * closing quote ends the value, as in the rule's own grammar) or bare and
 * followed by the rule's terminator. A marker used as a prefix
 * ("password=[redacted]hunter2") shields nothing. Replacements keep the
 * original quotes, so redaction stays idempotent and scans exact.
 */
const MARKER = "\\[redacted(?::[a-z]+)?\\]";
const MARKER_GUARD = (term: string) => `(?!"${MARKER}"|'${MARKER}'|${MARKER}(?:${term}))`;
const quoteOf = (v: string) => (v.startsWith('"') ? '"' : v.startsWith("'") ? "'" : "");

type Rule = { cls: RedactionClass; re: RegExp; replace: (m: string, ...g: string[]) => string };

const SECRET_WORDS_UPPER = "PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|DATABASE_URL|DSN|MNEMONIC|SEED|CREDENTIALS?";
const SECRET_WORDS_KV =
  "password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|" +
  "private[_-]?key|privatekey|secret[_-]?key|mnemonic|seed[_ -]?phrase|authorization|set-cookie|cookie|database[_-]?url|dsn";
const QUOTED_OR_BARE = (bareClass: string, term: string) => `(${MARKER_GUARD(term)}(?:"[^"\\n]*"|'[^'\\n]*'|${bareClass}))`;

/**
 * Fixed order: PEM first (multi-line), then specific shapes, then generic
 * encodings (the config pass runs between "auth" and "kv"). No rule requires
 * a leading word boundary: gluing characters in front of a secret
 * ("qCONWAY_API_KEY=", "xfa1.") must not hide it. Matching stays linear:
 * repetitions are bounded or unambiguous (measured in the tests).
 */
const RULES: readonly Rule[] = Object.freeze([
  {
    cls: "pem",
    re: /-----BEGIN[ A-Z0-9]{0,40}-----[\s\S]*?(?:-----END[ A-Z0-9]{0,40}-----|$)/g,
    replace: () => mark("pem"),
  },
  {
    cls: "userinfo",
    re: new RegExp(`([a-zA-Z][a-zA-Z0-9+.-]{0,31}):\\/\\/${MARKER_GUARD("@")}[^\\s\\/?#@]{1,256}@`, "g"),
    replace: (_m, scheme) => `${scheme}://${mark("userinfo")}@`,
  },
  {
    cls: "token",
    re: /(?:fa1|fs1|op1|os1)\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)*/g,
    replace: () => mark("token"),
  },
  {
    cls: "auth",
    // The value class excludes "[", so a marker can never match here.
    re: /([Bb]earer|FleetSession|Basic|Digest)[ \t]+[A-Za-z0-9._~+/=:-]+/g,
    replace: (_m, scheme) => `${scheme} ${mark("auth")}`,
  },
  {
    cls: "kv",
    re: new RegExp(`(${SECRET_WORDS_KV})(["']?[ \\t]*[=:][ \\t]*)${QUOTED_OR_BARE("[^\\s,;&\"'}]+", "$|[\\s,;&\"'}]")}`, "gi"),
    replace: (_m, name, sep, value) => `${name}${sep}${quoteOf(value)}${mark("kv")}${quoteOf(value)}`,
  },
  {
    cls: "jwt",
    re: /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
    replace: () => mark("jwt"),
  },
  {
    cls: "hex",
    re: /(?<![0-9a-fA-F])(?:0[xX])?[0-9a-fA-F]{64,}(?![0-9a-fA-F])/g,
    replace: () => mark("hex"),
  },
]);

/**
 * Environment/config assignments with a secret-looking UPPERCASE name
 * ("FLEET_ADMIN_DATABASE_URL=…", "9CONWAY_API_KEY: …"). Linear: a name is
 * only tried from the start of its [A-Z0-9_] run (lookbehind), and the
 * secret-word test is a separate check on the captured name; the value is
 * matched (sticky) only after a secret name. A non-secret "NAME=" consumes
 * nothing further, so "A=B_SECRET=x" cannot hide the second assignment.
 */
const CONFIG_NAME_RE = /(?<![A-Z0-9_])([A-Z0-9_]+)([ \t]*[=:][ \t]*)/g;
const CONFIG_VALUE_RE = new RegExp(QUOTED_OR_BARE("[^\\s\"',;]+", "$|[\\s\"',;]"), "y");
const CONFIG_SECRET_NAME_RE = new RegExp(SECRET_WORDS_UPPER);

function redactConfig(s: string, onRedact?: RedactionCounter): string {
  const nameRe = new RegExp(CONFIG_NAME_RE.source, "g");
  const valueRe = new RegExp(CONFIG_VALUE_RE.source, "y");
  let out = "";
  let last = 0;
  for (let m = nameRe.exec(s); m !== null; m = nameRe.exec(s)) {
    if (!CONFIG_SECRET_NAME_RE.test(m[1])) continue; // not secret: scanning resumes right after "NAME="
    valueRe.lastIndex = m.index + m[0].length;
    const v = valueRe.exec(s);
    if (!v) continue;
    onRedact?.("config");
    out += s.slice(last, valueRe.lastIndex - v[0].length) + quoteOf(v[0]) + mark("config") + quoteOf(v[0]);
    last = valueRe.lastIndex;
    nameRe.lastIndex = last;
  }
  return out + s.slice(last);
}

/**
 * Base64/base64url/base58 runs of >= 43 characters (a 32-byte key encodes to
 * 43-44) that mix upper case, lower case and digits. The mix requirement
 * keeps hex digests, lowercase paths and 0x wallet addresses (42 characters)
 * readable; a random 43-character base64 string lacks one of the three with
 * probability < 1e-9.
 */
const B64_RE = /[A-Za-z0-9+/_-]{43,}={0,2}/g;
const isMixed = (s: string) => /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s);

/**
 * BIP39-shaped phrases: >= 12 consecutive lowercase words of 3-8 letters,
 * separated by whitespace, commas, semicolons, pipes, hyphens, quotes or
 * brackets (plain text, CSV, one word per line, JSON arrays), with no common
 * English stopword among them. None of these stopwords is a BIP39 English
 * word (asserted by the tests against viem's wordlist), so a real mnemonic
 * is never broken up; ordinary prose almost always has one. No word
 * boundary is required, so letters glued to the first word do not hide it.
 * Limitation: deliberate re-encoding (e.g. dots between words, reversed
 * words) is not detected; redaction targets accidental inclusion.
 */
const WORD_SEP = `[\\s,;|"'\\[\\]-]+`;
const WORD_RUN_RE = new RegExp(`[a-z]{3,8}(?:${WORD_SEP}[a-z]{3,8}){11,}`, "g");
const WORD_SPLIT_RE = new RegExp(WORD_SEP);
export const MNEMONIC_STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "with", "from", "was", "were", "are", "not", "but", "has", "had", "its", "than",
  "their", "them", "been", "being", "which", "would", "could", "should", "did", "does", "your", "his",
  "her", "she", "him", "who", "why", "how", "our", "these", "those",
]);

function redactMnemonics(s: string, onRedact?: RedactionCounter): string {
  return s.replace(WORD_RUN_RE, (run) => {
    const words = run.split(WORD_SPLIT_RE);
    let streak = 0;
    for (const w of words) {
      streak = MNEMONIC_STOPWORDS.has(w) ? 0 : streak + 1;
      if (streak >= 12) {
        onRedact?.("mnemonic");
        return mark("mnemonic");
      }
    }
    return run;
  });
}

/** Steps 1-3: cut (matching-cost bound), NFKC, strip evasion characters. */
function normalizeText(input: string, opts: Options): { text: string; cut: boolean } {
  let s = input;
  let cut = false;
  if (opts.bounded && s.length > REDACT_LIMITS.maxInput) {
    s = s.slice(0, REDACT_LIMITS.maxInput);
    cut = true;
  }
  s = s.replace(LONE_SURROGATE_RE, "\uFFFD");
  s = s.normalize("NFKC");
  s = s.replace(EVASION_RE, "").replace(LINE_SEP_RE, " ");
  return { text: s, cut };
}

function applyPatterns(s: string, onRedact?: RedactionCounter): string {
  let out = s;
  for (const r of RULES) {
    out = out.replace(r.re, (...args: unknown[]) => {
      onRedact?.(r.cls);
      const groups = args.slice(1, -2) as string[];
      return r.replace(args[0] as string, ...groups);
    });
    if (r.cls === "auth") out = redactConfig(out, onRedact);
  }
  out = out.replace(B64_RE, (m) => {
    if (!isMixed(m)) return m;
    onRedact?.("b64");
    return mark("b64");
  });
  return redactMnemonics(out, onRedact);
}

function limitString(s: string, max: number): string {
  if (s.length <= max) return s;
  let head = s.slice(0, max - TRUNCATED.length);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return head + TRUNCATED;
}

function textInternal(input: string, opts: Options): string {
  const { text, cut } = normalizeText(input, opts);
  const redacted = applyPatterns(text, opts.onRedact);
  if (!opts.bounded) return redacted;
  return limitString(cut ? redacted + TRUNCATED : redacted, REDACT_LIMITS.maxString);
}

/** Redact one string (free-text columns, error messages, log values). */
export function redactText(input: string): string {
  return textInternal(String(input), BOUNDED);
}

// ─── Structural walk ────────────────────────────────────────────

/** JSON-safe result of redact(). */
export type Redacted = string | number | boolean | null | Redacted[] | { [k: string]: Redacted };

const isBinary = (v: object): boolean => ArrayBuffer.isView(v) || v instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer);
const binaryLength = (v: object): number => (ArrayBuffer.isView(v) ? v.byteLength : (v as ArrayBuffer).byteLength);

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** An array of >= 12 strings that are each a 3-8 letter lowercase non-stopword (a mnemonic as a word list). */
function isWordListMnemonic(a: readonly unknown[]): boolean {
  if (a.length < 12) return false;
  for (let i = 0; i < a.length; i++) {
    const d = Object.getOwnPropertyDescriptor(a, i);
    if (!d || !("value" in d) || typeof d.value !== "string") return false;
    const w = d.value.trim();
    if (!/^[a-z]{3,8}$/.test(w) || MNEMONIC_STOPWORDS.has(w)) return false;
  }
  return true;
}

function isByteArray(a: readonly unknown[]): boolean {
  if (a.length < 32) return false;
  for (let i = 0; i < a.length; i++) {
    const d = Object.getOwnPropertyDescriptor(a, i);
    if (!d || !("value" in d)) return false;
    const x = d.value;
    if (typeof x !== "number" || !Number.isInteger(x) || x < 0 || x > 255) return false;
  }
  return true;
}

/** Only own data properties are read; accessors are never invoked. */
function dataValue(obj: object, key: string | number): { ok: true; value: unknown } | { ok: false } {
  const d = Object.getOwnPropertyDescriptor(obj, key);
  if (!d) return { ok: true, value: undefined };
  if (!("value" in d)) return { ok: false };
  return { ok: true, value: d.value };
}

function defineOut(out: Record<string, Redacted>, key: string, value: Redacted): void {
  let k = key;
  for (let n = 2; Object.prototype.hasOwnProperty.call(out, k); n++) k = `${key}#${n}`;
  Object.defineProperty(out, k, { value, enumerable: true, writable: true, configurable: true });
}

function walk(value: unknown, depth: number, path: Set<object>, key: string | null, opts: Options): Redacted | undefined {
  if (key !== null) {
    const normKey = normalizeText(key, { bounded: false }).text;
    const pub = PUBLIC_FIELDS[normKey];
    if (pub && typeof value === "string" && pub.test(value)) return value;
    // Already-redacted values stay as they are (idempotence; scans do not re-count them).
    if (typeof value === "string" && MARKER_RE.test(value)) return value;
    if (SECRET_KEY_RE.test(normKey.replace(MARKER_TEXT_RE, "")) && value !== null && value !== undefined && typeof value !== "boolean") {
      opts.onRedact?.("key");
      return REDACTED;
    }
  }
  switch (typeof value) {
    case "string":
      return textInternal(value, opts);
    case "number":
      return Number.isFinite(value) ? value : null;
    case "boolean":
      return value;
    case "undefined":
      return undefined;
    case "bigint": {
      const s = value.toString();
      if (s.replace("-", "").length > 30) {
        opts.onRedact?.("number");
        return mark("number");
      }
      return s;
    }
    case "symbol":
      return "[unsupported:symbol]";
    case "function":
      return "[unsupported:function]";
  }
  if (value === null) return null;
  const obj = value as object;
  if (opts.bounded && depth >= REDACT_LIMITS.maxDepth) return "[depth-limit]";
  if (path.has(obj)) return "[circular]";
  if (isBinary(obj)) return `[binary:${binaryLength(obj)} bytes]`;
  if (obj instanceof Date) {
    const t = obj.getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : "[invalid-date]";
  }
  path.add(obj);
  try {
    if (obj instanceof Error) {
      const name = dataValue(obj, "name");
      const message = dataValue(obj, "message");
      const out: Record<string, Redacted> = Object.create(null);
      defineOut(out, "name", textInternal(name.ok && typeof name.value === "string" ? name.value : safeCtorName(obj), opts));
      defineOut(out, "message", message.ok && typeof message.value === "string" ? textInternal(message.value, opts) : "[unavailable]");
      return out;
    }
    if (Array.isArray(obj)) {
      if (isByteArray(obj)) {
        opts.onRedact?.("bytes");
        return mark("bytes");
      }
      if (isWordListMnemonic(obj)) {
        opts.onRedact?.("mnemonic");
        return mark("mnemonic");
      }
      const width = widthAt(depth, opts);
      const limit = opts.bounded && obj.length > width ? width - 1 : obj.length;
      const out: Redacted[] = [];
      for (let i = 0; i < limit; i++) {
        const d = dataValue(obj, i);
        const v = d.ok ? walk(d.value, depth + 1, path, null, opts) : "[accessor]";
        out.push(v === undefined ? null : v);
      }
      if (limit < obj.length) out.push(`[+${obj.length - limit} more]`);
      return out;
    }
    if (!isPlainObject(obj)) return `[unsupported:${safeCtorName(obj)}]`;
    const keys = Object.keys(obj);
    const width = widthAt(depth, opts);
    const limit = opts.bounded && keys.length > width ? width - 1 : keys.length;
    const out: Record<string, Redacted> = Object.create(null);
    for (let i = 0; i < limit; i++) {
      const k = keys[i];
      const outKey = opts.bounded ? limitString(textInternal(k, opts), REDACT_LIMITS.maxKey) : textInternal(k, opts);
      const d = dataValue(obj, k);
      const v = d.ok ? walk(d.value, depth + 1, path, k, opts) : "[accessor]";
      if (v !== undefined) defineOut(out, outKey, v);
    }
    if (limit < keys.length) defineOut(out, "[truncated-keys]", keys.length - limit);
    return out;
  } finally {
    path.delete(obj);
  }
}

const widthAt = (depth: number, opts: Options): number => (depth === 0 && opts.topWidth ? opts.topWidth : REDACT_LIMITS.maxWidth);

function safeCtorName(obj: object): string {
  try {
    const proto = Object.getPrototypeOf(obj);
    const d = proto ? Object.getOwnPropertyDescriptor(proto, "constructor") : undefined;
    const ctor = d && "value" in d ? (d.value as { name?: unknown }) : undefined;
    const n = ctor && typeof ctor === "function" ? Object.getOwnPropertyDescriptor(ctor, "name") : undefined;
    return n && "value" in n && typeof n.value === "string" ? n.value.replace(/[^A-Za-z0-9_$]/g, "").slice(0, 32) || "object" : "object";
  } catch {
    return "object";
  }
}

function redactWith(value: unknown, opts: Options): Redacted {
  try {
    const r = walk(value, 0, new Set(), null, opts);
    return r === undefined ? null : r;
  } catch {
    // Exotic input (e.g. a Proxy with throwing traps). Never throw into a
    // caller's error path; never fall back to the unredacted value.
    return "[unredactable]";
  }
}

/** Redact any value into a bounded, JSON-safe representation. Never throws. */
export function redact(value: unknown): Redacted {
  return redactWith(value, BOUNDED);
}

function detailWith(detail: unknown, topWidth: number): Record<string, Redacted> {
  const r = redactWith(detail ?? {}, { bounded: true, topWidth });
  if (r && typeof r === "object" && !Array.isArray(r)) return r;
  const out: Record<string, Redacted> = Object.create(null);
  defineOut(out, "value", r);
  return out;
}

/**
 * Redact an audit/log detail object (at most maxAuditDetailKeys top-level
 * keys). Non-objects are wrapped as { value }. Never throws.
 */
export function redactDetail(detail: unknown): Record<string, Redacted> {
  return detailWith(detail, REDACT_LIMITS.maxAuditDetailKeys);
}

// ─── Records (one serialization shared by every sink) ──────────

export interface RedactedAuditRecord {
  ts: string;
  event: string;
  agentId: string | null;
  detail: Record<string, Redacted>;
}

function fitRecord<T extends { detail: Record<string, Redacted> }>(rec: T): { record: T; line: string } {
  const line = JSON.stringify(rec);
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes <= REDACT_LIMITS.maxRecordBytes) return { record: rec, line };
  const oversize: Record<string, Redacted> = Object.create(null);
  defineOut(oversize, "[oversize]", true);
  defineOut(oversize, "bytes", bytes);
  const small = { ...rec, detail: oversize };
  return { record: small, line: JSON.stringify(small) };
}

/**
 * The canonical audit record: redacted and size-bounded. The JSONL sink,
 * the stdout copy and the database copy all derive from this.
 */
export function redactAuditRecord(entry: { ts: string; event: string; agentId?: string | null; detail?: unknown }): {
  record: RedactedAuditRecord;
  line: string;
} {
  return fitRecord({
    ts: redactText(entry.ts),
    event: redactText(entry.event),
    agentId: entry.agentId == null ? null : redactText(entry.agentId),
    detail: redactDetail(entry.detail),
  });
}

/**
 * One bounded JSON log line: redacted fields first, then the fixed envelope
 * keys, so attacker-controlled detail can never override ts/level/service/event.
 */
export function redactLogLine(envelope: Record<string, string>, fields: unknown): string {
  const detail = detailWith(fields, REDACT_LIMITS.maxWidth);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(envelope)) env[k] = redactText(v);
  const line = JSON.stringify({ ...detail, ...env });
  if (Buffer.byteLength(line, "utf8") <= REDACT_LIMITS.maxRecordBytes) return line;
  return JSON.stringify({ "[oversize]": true, bytes: Buffer.byteLength(line, "utf8"), ...env });
}

/** Line logger for the root witness and the dry-run child (stdout, one JSON object per line). */
export function createRedactedLineLogger(
  service: string,
  write: (line: string) => void = (l) => process.stdout.write(l + "\n"),
): (event: string, detail?: Record<string, unknown>) => void {
  return (event, detail = {}) => {
    try {
      write(redactLogLine({ ts: new Date().toISOString(), service, event }, detail));
    } catch {
      // logging must never take the process down
    }
  };
}

// ─── Scan mode (count-only; same detection logic) ───────────────

export interface ScanCounts {
  total: number;
  classes: Record<RedactionClass, number>;
}

function emptyCounts(): ScanCounts {
  const classes = Object.fromEntries(REDACTION_CLASSES.map((c) => [c, 0])) as Record<RedactionClass, number>;
  return { total: 0, classes };
}

function counter(c: ScanCounts): RedactionCounter {
  return (cls) => {
    c.classes[cls]++;
    c.total++;
  };
}

/**
 * Count what redaction would remove from a value, using exactly the
 * redaction rules but without depth/width/length bounds (nothing skipped).
 * Returns counts only; never any matched text.
 */
export function scanValue(value: unknown, into: ScanCounts = emptyCounts()): ScanCounts {
  walk(value, 0, new Set(), null, { bounded: false, onRedact: counter(into) });
  return into;
}

/** Count-only scan of a raw string. */
export function scanText(text: string, into: ScanCounts = emptyCounts()): ScanCounts {
  textInternal(String(text), { bounded: false, onRedact: counter(into) });
  return into;
}

export function newScanCounts(): ScanCounts {
  return emptyCounts();
}
```

## `src/fleet/registry.ts`

sha256 `c50908a540d7760ff3240568b56ad4b6fb604fc8398fe8893bfddb6e89da4ddd` · 14771 bytes · 392 lines

```ts
/**
 * Fleet Registry
 *
 * Durable record of every agent in the fleet (living and dead) and the
 * authoritative, transaction-safe allocator of living-agent slots.
 *
 * Concurrency: every read-then-write runs inside BEGIN IMMEDIATE, which
 * takes SQLite's RESERVED lock before the count is read. Concurrent writers
 * (other connections or processes sharing the file) block on busy_timeout
 * until the lock is released, so two reservations can never both observe
 * the same "free slot". The fleet_agents_cap_insert trigger re-checks the
 * cap inside the INSERT itself as a final backstop.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { ulid } from "ulid";
import { MIGRATION_V12, MIGRATION_V12_CHILDREN_SYNC } from "../state/schema.js";
import { FLEET_HARD_MAX_AGENTS } from "./config.js";
import type {
  FleetAgentRecord,
  FleetAgentStatus,
  FleetEventRecord,
  FleetSpawnGrant,
} from "./types.js";

const LIVING_SQL = "('reserved','spawning','active')";
const BUSY_TIMEOUT_MS = 5000;

export class FleetBypassError extends Error {
  readonly code = "FLEET_BYPASS_DENIED";
  constructor(message: string) {
    super(message);
    this.name = "FleetBypassError";
  }
}

export type ReserveResult =
  | { ok: true; grant: FleetSpawnGrant; agent: FleetAgentRecord }
  | { ok: false; code: "FLEET_CAP_REACHED" | "FLEET_EMERGENCY"; reason: string; living: number; max: number };

interface AgentRow {
  id: string;
  role: "root" | "child";
  parent_agent_id: string | null;
  requested_by: string;
  name: string;
  address: string | null;
  child_id: string | null;
  sandbox_id: string | null;
  status: FleetAgentStatus;
  status_reason: string | null;
  generation: number;
  created_at: string;
  updated_at: string;
  died_at: string | null;
}

function toRecord(row: AgentRow): FleetAgentRecord {
  return {
    id: row.id,
    role: row.role,
    parentAgentId: row.parent_agent_id,
    requestedBy: row.requested_by,
    name: row.name,
    address: row.address,
    childId: row.child_id,
    sandboxId: row.sandbox_id,
    status: row.status,
    statusReason: row.status_reason,
    generation: row.generation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    diedAt: row.died_at,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function isCapTriggerError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("FLEET_CAP_EXCEEDED");
}

export class FleetRegistry {
  constructor(private readonly db: DatabaseType) {
    this.db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    FleetRegistry.ensureSchema(db);
  }

  /** Idempotent. Normally applied by the V12 migration; kept for raw DBs. */
  static ensureSchema(db: DatabaseType): void {
    db.exec(MIGRATION_V12);
    const hasChildren = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'children'")
      .get();
    if (hasChildren) db.exec(MIGRATION_V12_CHILDREN_SYNC);
  }

  // ─── Cap / flags ─────────────────────────────────────────────

  setMaxAgents(max: number): void {
    if (!Number.isSafeInteger(max) || max < 1 || max > FLEET_HARD_MAX_AGENTS) {
      throw new Error(`Invalid fleet max agents: ${max} (must be 1..${FLEET_HARD_MAX_AGENTS})`);
    }
    const tx = this.db.transaction(() => {
      const prev = this.getMeta("max_agents");
      if (prev === String(max)) return;
      this.setMeta("max_agents", String(max));
      this.insertEvent("cap_set", null, null, { previous: prev, max });
    });
    tx.immediate();
  }

  getMaxAgents(): number {
    const n = Number(this.getMeta("max_agents"));
    return Number.isSafeInteger(n) && n >= 1 ? Math.min(n, FLEET_HARD_MAX_AGENTS) : 0;
  }

  setEmergency(on: boolean, reason: string, actor?: string): void {
    const tx = this.db.transaction(() => {
      this.setMeta("emergency", on ? "1" : "0");
      this.insertEvent(on ? "emergency_on" : "emergency_off", null, actor ?? null, { reason });
    });
    tx.immediate();
  }

  isEmergency(): boolean {
    return this.getMeta("emergency") === "1";
  }

  // ─── Registration & slot allocation ──────────────────────────

  /**
   * Register the running automaton as the fleet root (idempotent).
   * The root is a living agent and occupies one slot.
   */
  ensureRootAgent(params: { address: string; name: string }): FleetAgentRecord {
    const tx = this.db.transaction((): FleetAgentRecord => {
      const existing = this.db
        .prepare("SELECT * FROM fleet_agents WHERE role = 'root' ORDER BY created_at LIMIT 1")
        .get() as AgentRow | undefined;
      if (existing) return toRecord(existing);

      const id = ulid();
      const ts = nowIso();
      this.db
        .prepare(
          `INSERT INTO fleet_agents (id, role, parent_agent_id, requested_by, name, address, status, generation, created_at, updated_at)
           VALUES (?, 'root', NULL, ?, ?, ?, 'active', 0, ?, ?)`,
        )
        .run(id, params.address, params.name, params.address, ts, ts);
      this.insertEvent("root_registered", id, params.address, { name: params.name });
      return this.getAgentOrThrow(id);
    });
    return tx.immediate();
  }

  /**
   * Atomically reserve a living slot. Never exceeds the cap regardless of
   * how many callers race: the count and the insert are one IMMEDIATE txn.
   */
  reserveSlot(params: { parentAgentId: string | null; requestedBy: string; name: string }): ReserveResult {
    const tx = this.db.transaction((): ReserveResult => {
      const max = this.getMaxAgents();
      const living = this.countLiving();

      if (this.isEmergency()) {
        this.insertEvent("reservation_denied", null, params.requestedBy, { code: "FLEET_EMERGENCY", living, max });
        return { ok: false, code: "FLEET_EMERGENCY", reason: "Fleet is in EMERGENCY.", living, max };
      }
      if (living >= max) {
        this.insertEvent("reservation_denied", null, params.requestedBy, { code: "FLEET_CAP_REACHED", living, max });
        return {
          ok: false,
          code: "FLEET_CAP_REACHED",
          reason: `Fleet at cap (${living}/${max} living agents).`,
          living,
          max,
        };
      }

      const parent = params.parentAgentId ? this.getAgent(params.parentAgentId) : null;
      const id = ulid();
      const ts = nowIso();
      this.db
        .prepare(
          `INSERT INTO fleet_agents (id, role, parent_agent_id, requested_by, name, status, generation, created_at, updated_at)
           VALUES (?, 'child', ?, ?, ?, 'reserved', ?, ?, ?)`,
        )
        .run(id, params.parentAgentId, params.requestedBy, params.name, (parent?.generation ?? 0) + 1, ts, ts);
      this.insertEvent("slot_reserved", id, params.requestedBy, { living: living + 1, max });
      return {
        ok: true,
        grant: Object.freeze({ kind: "fleet-spawn-grant", reservationId: id }),
        agent: this.getAgentOrThrow(id),
      };
    });

    try {
      return tx.immediate();
    } catch (err) {
      if (isCapTriggerError(err)) {
        const max = this.getMaxAgents();
        return { ok: false, code: "FLEET_CAP_REACHED", reason: "Fleet cap enforced by database.", living: this.countLiving(), max };
      }
      throw err;
    }
  }

  /**
   * Consume a grant (reserved -> spawning) and bind it to a child id.
   * Called by spawnChild() before any sandbox is created. Single use.
   */
  claimGrant(grant: FleetSpawnGrant | undefined, childId: string): FleetAgentRecord {
    if (!grant || grant.kind !== "fleet-spawn-grant" || typeof grant.reservationId !== "string") {
      throw new FleetBypassError(
        "Replication denied: spawnChild requires a FleetController slot reservation. Use FleetController.requestReplication().",
      );
    }
    const tx = this.db.transaction((): FleetAgentRecord => {
      const res = this.db
        .prepare(
          `UPDATE fleet_agents SET status = 'spawning', child_id = ?, updated_at = ?
           WHERE id = ? AND status = 'reserved' AND role = 'child'`,
        )
        .run(childId, nowIso(), grant.reservationId);
      if (res.changes !== 1) {
        throw new FleetBypassError(
          `Replication denied: fleet reservation ${grant.reservationId} is invalid, expired, or already used.`,
        );
      }
      this.insertEvent("slot_claimed", grant.reservationId, null, { childId });
      return this.getAgentOrThrow(grant.reservationId);
    });
    return tx.immediate();
  }

  /** spawning -> active once the child sandbox and wallet exist. */
  activate(agentId: string, params: { address?: string; sandboxId?: string }): FleetAgentRecord {
    const tx = this.db.transaction((): FleetAgentRecord => {
      const res = this.db
        .prepare(
          `UPDATE fleet_agents SET status = 'active', address = ?, sandbox_id = ?, updated_at = ?
           WHERE id = ? AND status = 'spawning'`,
        )
        .run(params.address ?? null, params.sandboxId ?? null, nowIso(), agentId);
      if (res.changes !== 1) {
        throw new Error(`Cannot activate fleet agent ${agentId}: not in spawning state`);
      }
      this.insertEvent("agent_activated", agentId, null, params);
      return this.getAgentOrThrow(agentId);
    });
    return tx.immediate();
  }

  /** Release a slot that never became active (reserved/spawning -> failed). Idempotent. */
  releaseReservation(agentId: string, reason: string): boolean {
    const tx = this.db.transaction((): boolean => {
      const ts = nowIso();
      const res = this.db
        .prepare(
          `UPDATE fleet_agents SET status = 'failed', status_reason = ?, died_at = ?, updated_at = ?
           WHERE id = ? AND status IN ('reserved','spawning')`,
        )
        .run(reason, ts, ts, agentId);
      if (res.changes === 1) this.insertEvent("slot_released", agentId, null, { reason });
      return res.changes === 1;
    });
    return tx.immediate();
  }

  /** Record the death of a living agent. The row is retained forever. */
  markDead(agentId: string, reason: string): boolean {
    const tx = this.db.transaction((): boolean => {
      const ts = nowIso();
      const res = this.db
        .prepare(
          `UPDATE fleet_agents
              SET status = CASE WHEN status = 'active' THEN 'dead' ELSE 'failed' END,
                  status_reason = ?, died_at = ?, updated_at = ?
            WHERE id = ? AND status IN ${LIVING_SQL}`,
        )
        .run(reason, ts, ts, agentId);
      if (res.changes === 1) this.insertEvent("agent_died", agentId, null, { reason });
      return res.changes === 1;
    });
    return tx.immediate();
  }

  // ─── Queries ─────────────────────────────────────────────────

  countLiving(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM fleet_agents WHERE status IN ${LIVING_SQL}`)
      .get() as { n: number };
    return row.n;
  }

  countTotal(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM fleet_agents").get() as { n: number }).n;
  }

  getAgent(id: string): FleetAgentRecord | null {
    const row = this.db.prepare("SELECT * FROM fleet_agents WHERE id = ?").get(id) as AgentRow | undefined;
    return row ? toRecord(row) : null;
  }

  getRootAgent(): FleetAgentRecord | null {
    const row = this.db
      .prepare("SELECT * FROM fleet_agents WHERE role = 'root' ORDER BY created_at LIMIT 1")
      .get() as AgentRow | undefined;
    return row ? toRecord(row) : null;
  }

  listAgents(filter?: { living?: boolean }): FleetAgentRecord[] {
    const where = filter?.living === undefined
      ? ""
      : filter.living
        ? `WHERE status IN ${LIVING_SQL}`
        : `WHERE status NOT IN ${LIVING_SQL}`;
    const rows = this.db
      .prepare(`SELECT * FROM fleet_agents ${where} ORDER BY created_at, id`)
      .all() as AgentRow[];
    return rows.map(toRecord);
  }

  /** True if the address belongs to any fleet agent or recorded child (any status). */
  isFleetMemberAddress(address: string): boolean {
    const needle = address.trim().toLowerCase();
    if (!needle) return false;
    const fleet = this.db
      .prepare("SELECT 1 FROM fleet_agents WHERE role = 'child' AND lower(address) = ? LIMIT 1")
      .get(needle);
    if (fleet) return true;
    const hasChildren = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'children'")
      .get();
    if (!hasChildren) return false;
    return !!this.db.prepare("SELECT 1 FROM children WHERE lower(address) = ? LIMIT 1").get(needle);
  }

  getEvents(agentId?: string): FleetEventRecord[] {
    const rows = (agentId
      ? this.db.prepare("SELECT * FROM fleet_events WHERE agent_id = ? ORDER BY created_at, id").all(agentId)
      : this.db.prepare("SELECT * FROM fleet_events ORDER BY created_at, id").all()) as Array<{
      id: string;
      event_type: string;
      agent_id: string | null;
      actor: string | null;
      detail: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      eventType: r.event_type,
      agentId: r.agent_id,
      actor: r.actor,
      detail: JSON.parse(r.detail),
      createdAt: r.created_at,
    }));
  }

  recordEvent(eventType: string, agentId: string | null, actor: string | null, detail: Record<string, unknown>): void {
    this.insertEvent(eventType, agentId, actor, detail);
  }

  // ─── Internals ───────────────────────────────────────────────

  private getAgentOrThrow(id: string): FleetAgentRecord {
    const agent = this.getAgent(id);
    if (!agent) throw new Error(`Fleet agent ${id} not found`);
    return agent;
  }

  private getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM fleet_meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO fleet_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(key, value, nowIso());
  }

  private insertEvent(eventType: string, agentId: string | null, actor: string | null, detail: Record<string, unknown>): void {
    this.db
      .prepare("INSERT INTO fleet_events (id, event_type, agent_id, actor, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(ulid(), eventType, agentId, actor, JSON.stringify(detail), nowIso());
  }
}
```

## `src/fleet/runtime-verify.ts`

sha256 `39480041dbff73f769287a89b38a6fba1404580181cf86f5f803b31e41a7d35e` · 5740 bytes · 126 lines

```ts
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
```

## `src/fleet/runtime.ts`

sha256 `695e7f173f2114e45d6fa3ec7715d7321283e7201275828a8ffe7be7fa85b409` · 16011 bytes · 371 lines

```ts
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
  /** Phase 6: provisioning key (= reservation id) this child was provisioned under. */
  provisioningKey?: string;
  /** Phase 6: DRY_RUN_CHILD — no agent loop, no wallet, no spend authority. */
  dryRun?: boolean;
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

// ─── Runtime release (Phase 4) ───────────────────────────────────

/**
 * The runtime a fleet release runs: repo + commit + build identity. It is
 * set once per deployment (FLEET_RUNTIME_REPO / _COMMIT / _BUILD_ID /
 * _LOCKFILE_SHA256 in /etc/automaton-fleet/runtime.env) and must equal the
 * operator-approved runtime in the registry; the fleet service refuses to
 * claim or activate a lease that expects anything else.
 */
export interface RuntimeRelease extends RuntimePin, RuntimeBuild {}

export function loadRuntimeRelease(env: Record<string, string | undefined> = process.env): RuntimeRelease | null {
  const pin = loadRuntimePin(env);
  const build = validateRuntimeBuild(env.FLEET_RUNTIME_BUILD_ID, env.FLEET_RUNTIME_LOCKFILE_SHA256);
  return pin && build ? Object.freeze({ ...pin, ...build }) : null;
}

/** Why the runtime env is not a complete release (for doctor/readiness), or null if it is. */
export function runtimeReleaseProblem(env: Record<string, string | undefined>): string | null {
  const v = validateRuntimePin(env.FLEET_RUNTIME_REPO, env.FLEET_RUNTIME_COMMIT);
  if (!v.ok) return v.reason;
  if (!validateRuntimeBuild(env.FLEET_RUNTIME_BUILD_ID, env.FLEET_RUNTIME_LOCKFILE_SHA256)) {
    return "FLEET_RUNTIME_BUILD_ID / FLEET_RUNTIME_LOCKFILE_SHA256 are missing or not 64-hex.";
  }
  return null;
}

export function sameRelease(
  a: { repo: string; commit: string; buildId: string; lockfileSha256: string } | null | undefined,
  b: { repo: string; commit: string; buildId: string; lockfileSha256: string } | null | undefined,
): boolean {
  return !!a && !!b && a.repo === b.repo && a.commit === b.commit && a.buildId === b.buildId && a.lockfileSha256 === b.lockfileSha256;
}
```

## `src/fleet/secret-files.ts`

sha256 `01c2bf7ab6cf25f5f1bad3b7f178eaf0625dfea45b1e4b85b976c01fb1f67112` · 19616 bytes · 419 lines

```ts
/**
 * Secret files (Phase 4)
 *
 * Controller credentials live in root-managed files outside the repository,
 * never in a globally readable environment file:
 *
 *   /etc/automaton-fleet/admin.env    root:automaton-fleet-admin 0640  FLEET_ADMIN_DATABASE_URL (operator CLI, migrations)
 *   /etc/automaton-fleet/service.env  root:root 0600, handed to the service only via systemd LoadCredential=
 *                                     ($CREDENTIALS_DIRECTORY/service.env): FLEET_SERVICE_DATABASE_URL, FLEET_AGENT_DATABASE_URL
 *   /etc/automaton-fleet/runtime.env  0644, non-secret: FLEET_RUNTIME_*, REAL_*_ENABLED, FLEET_API_LISTEN
 *
 * readSecretEnvFile refuses symlinks, non-regular files, world-accessible
 * files, and (unless allowGroupRead) group-accessible files, and reports an
 * unreadable file clearly instead of silently continuing without it.
 *
 * The one exception is the systemd credential copy of service.env: systemd
 * LoadCredential= materialises it as root-owned 0400 plus a read ACL for the
 * service user, which stat reports as 0440. systemdCredentialProblems accepts
 * that mode only for the known secret credentials (service.env, tls.key) at
 * exactly $CREDENTIALS_DIRECTORY/<name>, when the directory is exactly the one
 * systemd provides to automaton-fleet.service. An explicitly configured path
 * (FLEET_SERVICE_ENV_FILE, FLEET_TLS_KEY_FILE) always gets the strict checks.
 *
 *   /etc/automaton-fleet/tls/         root:automaton-fleet-admin 0750
 *     fleet.key  root:root 0600   LoadCredential=tls.key -> $CREDENTIALS_DIRECTORY/tls.key
 *     fleet.crt  root:root 0644   LoadCredential=tls.crt -> $CREDENTIALS_DIRECTORY/tls.crt (public)
 */

import fs from "fs";
import path from "path";

export const FLEET_ETC_DIR = "/etc/automaton-fleet";
export const FLEET_SYSTEMD_UNIT = "automaton-fleet.service";
export const SYSTEMD_CREDENTIALS_ROOT = "/run/credentials";
export const SERVICE_ENV_CREDENTIAL = "service.env";
export const TLS_KEY_CREDENTIAL = "tls.key";
export const TLS_CERT_CREDENTIAL = "tls.crt";
export const DEFAULT_ADMIN_ENV_FILE = path.join(FLEET_ETC_DIR, "admin.env");
export const DEFAULT_SERVICE_ENV_FILE = path.join(FLEET_ETC_DIR, "service.env");
export const DEFAULT_RUNTIME_ENV_FILE = path.join(FLEET_ETC_DIR, "runtime.env");
/**
 * Schema v8 Operator API secret: FLEET_OPERATOR_DATABASE_URL only.
 * root:automaton-fleet-operator-api 0640, read directly by the operator
 * process under the strict secret-file rules (group read allowed, as for
 * admin.env). It deliberately does NOT use LoadCredential, so the verified
 * systemd-credential 0440 exception stays limited to automaton-fleet.service.
 */
export const DEFAULT_OPERATOR_ENV_FILE = path.join(FLEET_ETC_DIR, "operator.env");
export const FLEET_TLS_DIR = path.join(FLEET_ETC_DIR, "tls");
export const DEFAULT_TLS_KEY_FILE = path.join(FLEET_TLS_DIR, "fleet.key");
export const DEFAULT_TLS_CERT_FILE = path.join(FLEET_TLS_DIR, "fleet.crt");
export const LEGACY_ENV_FILE = ".env.fleet";

/**
 * The only credential names that get the systemd-credential exception, with
 * their LoadCredential= sources. tls.crt is public and never needs it.
 */
export const SYSTEMD_SECRET_CREDENTIALS: Readonly<Record<string, string>> = Object.freeze({
  [SERVICE_ENV_CREDENTIAL]: DEFAULT_SERVICE_ENV_FILE,
  [TLS_KEY_CREDENTIAL]: DEFAULT_TLS_KEY_FILE,
});

/** Keys that are controller secrets (must come from a secret file, never from .env.fleet in production). */
export const CONTROLLER_SECRET_KEYS: readonly string[] = Object.freeze([
  "FLEET_ADMIN_DATABASE_URL",
  "FLEET_OPERATOR_DATABASE_URL",
  "FLEET_SERVICE_DATABASE_URL",
  "FLEET_AGENT_DATABASE_URL",
  "FLEET_CONTROLLER_DATABASE_URL",
  "DATABASE_URL",
  "REDIS_URL",
]);

export class SecretFileError extends Error {
  readonly code = "FLEET_SECRET_FILE";
  constructor(message: string) {
    super(message);
    this.name = "SecretFileError";
  }
}

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#")) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

/** Plain (non-secret) env file; missing file = empty. */
export function readEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  return parseEnv(fs.readFileSync(file, "utf8"));
}

export interface SecretFileOptions {
  /** Allow group read (admin.env is shared with the operator group). Default false. */
  allowGroupRead?: boolean;
  /**
   * Validate as a systemd credential instead (see systemdCredentialProblems).
   * Only loadServiceEnv sets this, for $CREDENTIALS_DIRECTORY/service.env
   * (loadTls validates $CREDENTIALS_DIRECTORY/tls.key the same way).
   */
  systemdCredential?: { name: string; credentialsDirectory: string | undefined; sourceFile: string; host?: SystemdCredentialHost };
  /** Throw if the file does not exist. Default false (returns null). */
  required?: boolean;
}

/** Permission problems of a secret file, or [] if acceptable. Never reads contents. */
export function secretFileProblems(file: string, opts: SecretFileOptions = {}): string[] {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return [code === "ENOENT" ? `${file} does not exist` : `${file} cannot be inspected (${code})`];
  }
  const problems: string[] = [];
  if (st.isSymbolicLink()) problems.push(`${file} is a symlink`);
  else if (!st.isFile()) problems.push(`${file} is not a regular file`);
  const mode = st.mode & 0o777;
  if (mode & 0o007) problems.push(`${file} is world-accessible (mode ${mode.toString(8)})`);
  if (!opts.allowGroupRead && mode & 0o070) problems.push(`${file} is group-accessible (mode ${mode.toString(8)})`);
  if (opts.allowGroupRead && mode & 0o030) problems.push(`${file} is group-writable/executable (mode ${mode.toString(8)})`);
  return problems;
}

/** Read a KEY=VALUE secret file after checking its permissions. Values are never logged. */
export function readSecretEnvFile(file: string, opts: SecretFileOptions = {}): Record<string, string> | null {
  if (!fs.existsSync(file) && !isDanglingLink(file)) {
    if (opts.required) throw new SecretFileError(`Secret file ${file} does not exist.`);
    return null;
  }
  const cred = opts.systemdCredential;
  const problems = cred
    ? systemdCredentialProblems(file, cred.name, cred.credentialsDirectory, cred.sourceFile, cred.host)
    : secretFileProblems(file, opts);
  if (problems.length) throw new SecretFileError(`Refusing insecure secret file: ${problems.join("; ")}.`);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new SecretFileError(
      code === "EACCES"
        ? `Secret file ${file} is not readable by this user (permission denied).`
        : `Secret file ${file} could not be read (${code ?? "error"}).`,
    );
  }
  return parseEnv(text);
}

/** Facts about the host systemd context; injectable for tests. */
export interface SystemdCredentialHost {
  /** Parent of per-unit credential directories. Default /run/credentials. */
  credentialsRoot: string;
  /** Unit this process runs in, from /proc/self/cgroup (null = not a systemd service). */
  unitName: string | null;
  /** Unit the credential exception is granted to. Default automaton-fleet.service. */
  expectedUnit: string;
  /** Owner systemd uses for credential directories/files and the source secret. Default 0 (root). */
  rootUid: number;
  /** Uid of this process (systemd chowns credentials to it when ACLs are unavailable). */
  uid: number;
}

/** The systemd unit this process belongs to, from its cgroup path (unforgeable by an unprivileged process). */
export function currentSystemdUnit(cgroupFile = "/proc/self/cgroup"): string | null {
  let text: string;
  try {
    text = fs.readFileSync(cgroupFile, "utf8");
  } catch {
    return null;
  }
  // cgroup v2: "0::/system.slice/x.service"; v1/hybrid: "1:name=systemd:/system.slice/x.service".
  const lines = text.split("\n");
  const line = lines.find((l) => l.startsWith("0::")) ?? lines.find((l) => l.includes(":name=systemd:"));
  const leaf = line?.slice(line.lastIndexOf("/") + 1).trim();
  return leaf && /^[A-Za-z0-9:_.@\\-]+\.service$/.test(leaf) ? leaf : null;
}

export function defaultSystemdCredentialHost(): SystemdCredentialHost {
  return {
    credentialsRoot: SYSTEMD_CREDENTIALS_ROOT,
    unitName: currentSystemdUnit(),
    expectedUnit: FLEET_SYSTEMD_UNIT,
    rootUid: 0,
    uid: process.getuid?.() ?? -1,
  };
}

/**
 * Problems with treating `file` as the systemd credential `name` delivered
 * from `sourceFile`, or [] if acceptable. Every condition must hold:
 *  - `name` is one of SYSTEMD_SECRET_CREDENTIALS (service.env, tls.key);
 *  - this process runs as the expected unit, and CREDENTIALS_DIRECTORY is
 *    exactly <credentialsRoot>/<unit>, absolute, with no symlink in its path;
 *  - that directory is owned by root (or this process) and not group/world-writable;
 *  - `file` is exactly <CREDENTIALS_DIRECTORY>/<name> and resolves there (no
 *    symlink/.. escape), a regular single-link file owned by root (or this process);
 *  - mode: no world bits, group at most read (0440, 0400, 0600 ok; 0444, 0460, 0660, 0450 refused);
 *  - the source secret is still root-owned 0600 (or hidden from this process).
 */
export function systemdCredentialProblems(
  file: string,
  name: string,
  credentialsDirectory: string | undefined,
  sourceFile: string,
  host: SystemdCredentialHost = defaultSystemdCredentialHost(),
): string[] {
  const credDir = credentialsDirectory?.trim();
  if (!credDir) return ["CREDENTIALS_DIRECTORY is not set"];
  if (!host.unitName) return ["process is not running as a systemd service"];
  if (host.unitName !== host.expectedUnit) return [`process runs as ${host.unitName}, not ${host.expectedUnit}`];
  const expectedDir = path.join(host.credentialsRoot, host.unitName);
  if (!path.isAbsolute(credDir) || path.normalize(credDir) !== credDir || credDir !== expectedDir) {
    return [`CREDENTIALS_DIRECTORY ${credDir} is not the systemd credential directory ${expectedDir}`];
  }
  if (name !== path.basename(name) || name === "." || name === "..") return [`invalid credential name ${name}`];
  if (!Object.hasOwn(SYSTEMD_SECRET_CREDENTIALS, name)) return [`${name} is not a known secret credential`];
  const expectedFile = path.join(credDir, name);
  if (file !== expectedFile) return [`${file} is not the expected credential ${expectedFile}`];

  const problems: string[] = [];
  const trusted = (uid: number) => uid === host.rootUid || uid === host.uid;
  try {
    if (fs.realpathSync(credDir) !== credDir) problems.push(`${credDir} resolves through a symlink`);
    const d = fs.lstatSync(credDir);
    if (!d.isDirectory()) problems.push(`${credDir} is not a directory`);
    if (!trusted(d.uid)) problems.push(`${credDir} is owned by uid ${d.uid}`);
    if (d.mode & 0o022) problems.push(`${credDir} is group/world-writable (mode ${(d.mode & 0o777).toString(8)})`);
  } catch (err) {
    return [`${credDir} cannot be inspected (${(err as NodeJS.ErrnoException).code})`];
  }
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink()) problems.push(`${file} is a symlink`);
    else if (!st.isFile()) problems.push(`${file} is not a regular file`);
    else if (fs.realpathSync(file) !== expectedFile) problems.push(`${file} resolves outside ${credDir}`);
    if (st.nlink !== 1) problems.push(`${file} has ${st.nlink} hard links`);
    if (!trusted(st.uid)) problems.push(`${file} is owned by uid ${st.uid}`);
    const mode = st.mode & 0o777;
    if (mode & 0o007) problems.push(`${file} is world-accessible (mode ${mode.toString(8)})`);
    if (mode & 0o030) problems.push(`${file} is group-writable/executable (mode ${mode.toString(8)})`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return [code === "ENOENT" ? `${file} does not exist` : `${file} cannot be inspected (${code})`];
  }
  // The source must stay root:root 0600. /etc/automaton-fleet is 0755, so the service can stat
  // (but not read) it; if a sandbox hides it entirely (EACCES) it is protected by that.
  try {
    const src = fs.lstatSync(sourceFile);
    if (!src.isFile() || src.isSymbolicLink()) problems.push(`source ${sourceFile} is not a regular file`);
    if (src.uid !== host.rootUid) problems.push(`source ${sourceFile} is owned by uid ${src.uid}, not root`);
    if (src.mode & 0o077) problems.push(`source ${sourceFile} is group/world-accessible (mode ${(src.mode & 0o777).toString(8)})`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EACCES") problems.push(`source ${sourceFile} cannot be inspected (${code})`);
  }
  return problems;
}

function isDanglingLink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

export interface LoadedEnv {
  env: Record<string, string | undefined>;
  /** Which file supplied each controller secret (names only, never values). */
  secretSources: Record<string, string>;
  warnings: string[];
}

function merge(layers: Array<[string, Record<string, string> | null]>, processEnv: Record<string, string | undefined>): LoadedEnv {
  const env: Record<string, string | undefined> = {};
  const secretSources: Record<string, string> = {};
  for (const [source, values] of layers) {
    if (!values) continue;
    for (const [k, v] of Object.entries(values)) {
      env[k] = v;
      if (CONTROLLER_SECRET_KEYS.includes(k) && v) secretSources[k] = source;
    }
  }
  for (const [k, v] of Object.entries(processEnv)) {
    if (v === undefined) continue;
    env[k] = v;
    if (CONTROLLER_SECRET_KEYS.includes(k) && v) secretSources[k] = "process environment";
  }
  const warnings: string[] = [];
  for (const [k, src] of Object.entries(secretSources)) {
    if (src.endsWith(LEGACY_ENV_FILE)) {
      warnings.push(`${k} is read from the repository ${LEGACY_ENV_FILE} (legacy); move it to a secret file under ${FLEET_ETC_DIR}.`);
    }
  }
  return { env, secretSources, warnings };
}

/**
 * Operator CLI environment: process env > admin.env (0640, operator group)
 * > runtime.env > legacy .env.fleet.
 */
export function loadAdminEnv(processEnv: Record<string, string | undefined> = process.env, cwd = process.cwd()): LoadedEnv {
  const adminFile = processEnv.FLEET_ADMIN_ENV_FILE?.trim() || DEFAULT_ADMIN_ENV_FILE;
  const runtimeFile = processEnv.FLEET_RUNTIME_ENV_FILE?.trim() || DEFAULT_RUNTIME_ENV_FILE;
  const legacy = path.resolve(cwd, LEGACY_ENV_FILE);
  return merge(
    [
      [legacy, readEnvFile(legacy)],
      [runtimeFile, readEnvFile(runtimeFile)],
      [adminFile, readSecretEnvFile(adminFile, { allowGroupRead: true, required: !!processEnv.FLEET_ADMIN_ENV_FILE })],
    ],
    processEnv,
  );
}

/**
 * Fleet service environment: process env > service secret
 * (FLEET_SERVICE_ENV_FILE, else $CREDENTIALS_DIRECTORY/service.env from
 * systemd LoadCredential=, else /etc/automaton-fleet/service.env) >
 * runtime.env > legacy .env.fleet. Never reads admin.env.
 */
export function loadServiceEnv(
  processEnv: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
  systemd: { host?: SystemdCredentialHost; sourceFile?: string } = {},
): LoadedEnv {
  const explicit = processEnv.FLEET_SERVICE_ENV_FILE?.trim();
  const credDir = processEnv.CREDENTIALS_DIRECTORY?.trim();
  const serviceFile = explicit || (credDir ? path.join(credDir, SERVICE_ENV_CREDENTIAL) : DEFAULT_SERVICE_ENV_FILE);
  // systemd credential semantics apply only to the credential itself, never to an explicit file.
  const systemdCredential =
    !explicit && credDir
      ? { name: SERVICE_ENV_CREDENTIAL, credentialsDirectory: credDir, sourceFile: systemd.sourceFile ?? DEFAULT_SERVICE_ENV_FILE, host: systemd.host }
      : undefined;
  const runtimeFile = processEnv.FLEET_RUNTIME_ENV_FILE?.trim() || DEFAULT_RUNTIME_ENV_FILE;
  const legacy = path.resolve(cwd, LEGACY_ENV_FILE);
  const loaded = merge(
    [
      [legacy, readEnvFile(legacy)],
      [runtimeFile, readEnvFile(runtimeFile)],
      [serviceFile, readSecretEnvFile(serviceFile, { required: !!(explicit || credDir), systemdCredential })],
    ],
    processEnv,
  );
  if (loaded.secretSources.FLEET_ADMIN_DATABASE_URL) {
    loaded.warnings.push("FLEET_ADMIN_DATABASE_URL is visible to the fleet service; the service must not hold the admin credential.");
  }
  return loaded;
}

/** Credentials the Operator API process must never see (startup refuses if present). */
export const OPERATOR_FORBIDDEN_ENV: readonly string[] = Object.freeze([
  "FLEET_ADMIN_DATABASE_URL",
  "FLEET_SERVICE_DATABASE_URL",
  "FLEET_AGENT_DATABASE_URL",
  "FLEET_CONTROLLER_DATABASE_URL",
  "DATABASE_URL",
  "PGPASSWORD",
  "REDIS_URL",
  "CONWAY_API_KEY",
  "WALLET_PRIVATE_KEY",
  "PRIVATE_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "FLEET_CREDENTIALS_FILE",
  "CREDENTIALS_DIRECTORY",
]);

/**
 * operator.env is the only group-readable secret file, and only under these
 * exact conditions: owned by root (so the Operator API cannot rewrite its own
 * credential), group = the Operator API's own primary group, exactly one link,
 * no symlink anywhere in its path. This is NOT the systemd-credential
 * exception and relaxes nothing for any other file.
 */
export function operatorEnvFileProblems(file: string, opts: { ownerUid?: number; groupGid?: number | null } = {}): string[] {
  const problems = secretFileProblems(file, { allowGroupRead: true });
  if (problems.length) return problems;
  const st = fs.lstatSync(file);
  const ownerUid = opts.ownerUid ?? 0;
  if (st.uid !== ownerUid) problems.push(`${file} must be owned by uid ${ownerUid} (is ${st.uid})`);
  const gid = opts.groupGid === undefined ? (typeof process.getgid === "function" ? process.getgid() : null) : opts.groupGid;
  if (st.mode & 0o040 && st.gid !== gid) problems.push(`${file} is readable by group ${st.gid}, not this service's own group`);
  if (st.nlink !== 1) problems.push(`${file} has ${st.nlink} hard links`);
  try {
    if (fs.realpathSync(file) !== path.resolve(file)) problems.push(`${file} resolves through a symlink`);
  } catch {
    problems.push(`${file} cannot be resolved`);
  }
  return problems;
}

/**
 * Operator API environment: process env > operator.env (strict, group-read)
 * > runtime.env (non-secret). Never reads admin.env, service.env or the
 * repository .env.fleet.
 */
export function loadOperatorEnv(
  processEnv: Record<string, string | undefined> = process.env,
  fileOpts: { ownerUid?: number; groupGid?: number | null } = {},
): LoadedEnv {
  const operatorFile = processEnv.FLEET_OPERATOR_ENV_FILE?.trim() || DEFAULT_OPERATOR_ENV_FILE;
  const runtimeFile = processEnv.FLEET_RUNTIME_ENV_FILE?.trim() || DEFAULT_RUNTIME_ENV_FILE;
  if (!fs.existsSync(operatorFile) && !isDanglingLink(operatorFile)) throw new SecretFileError(`Secret file ${operatorFile} does not exist.`);
  const problems = operatorEnvFileProblems(operatorFile, fileOpts);
  if (problems.length) throw new SecretFileError(`Refusing insecure secret file: ${problems.join("; ")}.`);
  return merge(
    [
      [runtimeFile, readEnvFile(runtimeFile)],
      [operatorFile, readSecretEnvFile(operatorFile, { allowGroupRead: true, required: true })],
    ],
    processEnv,
  );
}
```

## `src/fleet/secrets.ts`

sha256 `562ea7a956de647f321da6bf49d3b27b2b8167c01399b1133482c9f6f594aadf` · 2758 bytes · 71 lines

```ts
/**
 * Privileged-secret isolation for agent processes (Phase 3)
 *
 * An automaton (root or child) must never hold fleet-controller database
 * credentials, owner wallet credentials, controller signing secrets or
 * privileged API keys. Its shell tools run with its environment, and
 * /proc/<pid>/environ keeps the ORIGINAL environment block even after
 * process.env entries are deleted — so an agent started with such a variable
 * must refuse to run, not merely scrub it.
 *
 * What agents keep: their own Conway API key (needed for their tools), their
 * own fleet credential file, FLEET_API_URL, and non-secret fleet flags.
 */

/** Exact names that are always privileged. */
const PRIVILEGED_ENV_NAMES: ReadonlySet<string> = new Set([
  "DATABASE_URL",
  "FLEET_CONTROLLER_DATABASE_URL",
  "FLEET_AGENT_DATABASE_URL",
  "FLEET_TEST_DATABASE_URL",
  "REDIS_URL",
  "PGPASSWORD",
  "PGPASSFILE",
  "PGSERVICEFILE",
  "PGUSER",
  "PGHOST",
  "PGHOSTADDR",
  "PGDATABASE",
  "PGSERVICE",
]);

/** Name patterns that are privileged. */
const PRIVILEGED_ENV_PATTERNS: readonly RegExp[] = Object.freeze([
  /(^|_)DATABASE_URL$/,
  /^PG[A-Z]+$/,
  /^OWNER_(WALLET|PRIVATE|KEY|MNEMONIC|SEED|SECRET|SIGN|TOKEN|PASS)/,
  /^FLEET_(CONTROLLER|ADMIN|SIGNING|SERVICE)_/,
  /(^|_)SIGNING_(KEY|SECRET)$/,
  /(^|_)PRIVATE_KEY$/,
  /(^|_)(MNEMONIC|SEED_PHRASE)$/,
  /(^|_)ADMIN_(TOKEN|KEY|SECRET|PASSWORD|API_KEY)$/,
]);

/** Non-secret switches that happen to match a pattern. */
const ALLOWED_ENV_NAMES: ReadonlySet<string> = new Set(["OWNER_SWEEP_ENABLED"]);

export function isPrivilegedEnvName(name: string): boolean {
  if (ALLOWED_ENV_NAMES.has(name)) return false;
  return PRIVILEGED_ENV_NAMES.has(name) || PRIVILEGED_ENV_PATTERNS.some((re) => re.test(name));
}

/** Names of privileged variables present (non-empty) in env. Values are never returned. */
export function findPrivilegedEnv(env: Record<string, string | undefined> = process.env): string[] {
  return Object.keys(env)
    .filter((k) => env[k] !== undefined && env[k] !== "" && isPrivilegedEnvName(k))
    .sort();
}

/** Delete privileged variables from env in place. Returns the removed names. */
export function scrubPrivilegedEnv(env: Record<string, string | undefined> = process.env): string[] {
  const removed = findPrivilegedEnv(env);
  for (const k of Object.keys(env)) if (isPrivilegedEnvName(k)) delete env[k];
  return removed;
}

/** Copy of env without privileged variables, for any child process an agent starts. */
export function agentChildEnv(env: Record<string, string | undefined> = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !isPrivilegedEnvName(k)) out[k] = v;
  return out;
}
```

## `src/fleet/shared-controller.ts`

sha256 `d8d8ef2be589df63f9a20a8a0d1df278459a742312d7c21c2c3ed7924af44d04` · 14329 bytes · 377 lines

```ts
/**
 * Shared Fleet Controller (Phase 2)
 *
 * Replication entry point backed by the shared PostgreSQL registry. The
 * global cap, operating mode and approved runtime come from fleet_state;
 * the local environment can only make them stricter.
 *
 *   1. FleetPolicy on the shared counts (state, flags, cap), runtime pin
 *      check, financial eligibility,
 *   2. PgFleetStore.reserveSlot() — atomic, under the fleet_state row lock,
 *   3. spawn(grant) — spawnChild() claims the grant before any side effect,
 *      installs the pinned runtime and attests it,
 *   4. activate (the registry checks the attestation against the
 *      reservation's recorded expectations) or release on any failure,
 *   5. deliver the child's own registry credential into its sandbox.
 *
 * Phase 3: the backend is either the admin PgFleetStore (fleet service,
 * tests) or FleetApiClient (agents), so agents never hold DB credentials.
 * If the registry is unreachable every replication request is denied with
 * FLEET_REGISTRY_UNAVAILABLE; nothing else about the agent is affected.
 */

import { ulid } from "ulid";
import { strictestMode } from "./config.js";
import { computeFleetState, evaluateFinancialEligibility, evaluateReplication } from "./policy.js";
import type { FleetBackend } from "./backend.js";
import { FleetRuntimeError, resolveChildRuntime, samePin } from "./runtime.js";
import type {
  FleetCredential,
  SharedAgentStatus,
  SharedSpawnedChildReport,
  FinancialSnapshot,
  FleetConfig,
  FleetDecision,
  FleetDecisionCode,
  FleetSpawnGrant,
  FleetState,
  ReplicationOutcome,
  SharedFleetSnapshot,
  SharedFleetState,
} from "./types.js";

export interface SharedFleetControllerOptions {
  store: FleetBackend;
  config: FleetConfig;
  self: { address: string; name: string };
  /** False for children; they identify via selfAgentId from their runtime manifest. */
  isRootAgent: boolean;
  selfAgentId?: string | null;
  runtimeVersion?: string | null;
  runtimeCommit?: string | null;
  getFinancialSnapshot?: () => Promise<FinancialSnapshot>;
  /** Snapshots older than this are treated as unhealthy by the policy rule. */
  snapshotStaleMs?: number;
  log?: (level: "info" | "warn" | "error", msg: string) => void;
  /** Called once when the registry reports this agent dead/failed (e.g. reaped). */
  onDead?: (status: SharedAgentStatus) => void;
}

export type SharedSpawnedChild = SharedSpawnedChildReport;

/** Puts the child's own credential into its sandbox (never the parent's, never DB credentials). */
export type CredentialDelivery<TChild> = (child: TChild, credential: FleetCredential) => Promise<void>;

export interface SharedFleetStatus {
  state: FleetState;
  shared: SharedFleetState;
  effectiveMaxAgents: number;
  occupied: number;
}

const DEFAULT_STALE_MS = 90_000;

export class SharedFleetController {
  private selfAgentId: string | null;
  /** True only after the registry confirmed this agent's identity. */
  private registered = false;
  private last: SharedFleetSnapshot;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: SharedFleetControllerOptions) {
    this.selfAgentId = opts.selfAgentId ?? null;
    this.last = { healthy: false, checkedAt: 0, state: null, selfAgentId: null, memberAddresses: new Set(), error: "not yet checked" };
  }

  get store(): FleetBackend {
    return this.opts.store;
  }

  get config(): FleetConfig {
    return this.opts.config;
  }

  /** Confirmed registry id; null until registration/attachment succeeds. */
  get agentId(): string | null {
    return this.registered ? this.selfAgentId : null;
  }

  private log(level: "info" | "warn" | "error", msg: string): void {
    this.opts.log?.(level, msg);
  }

  /**
   * Register (root) or attach (child) this automaton. Never throws; an
   * unregistered agent keeps running but cannot replicate.
   */
  async init(): Promise<{ ok: boolean; code?: string; reason?: string }> {
    try {
      const res = this.opts.isRootAgent
        ? await this.opts.store.registerRoot({
            walletAddress: this.opts.self.address,
            name: this.opts.self.name,
            runtimeVersion: this.opts.runtimeVersion ?? null,
            runtimeCommit: this.opts.runtimeCommit ?? null,
            localMaxAgents: this.opts.config.maxAgents,
          })
        : this.selfAgentId
          ? await this.opts.store.attachAgent(this.selfAgentId, this.opts.self.address)
          : { ok: false as const, code: "FLEET_NOT_REGISTERED" as const, reason: "Child has no fleet agent id." };
      if (res.ok) {
        this.selfAgentId = res.agent.agentId;
        this.registered = true;
      } else {
        this.registered = false;
        this.log("warn", `Fleet registration failed: ${res.code} — ${res.reason}`);
      }
      await this.refresh();
      return res.ok ? { ok: true } : { ok: false, code: res.code, reason: res.reason };
    } catch (err) {
      await this.refresh();
      const reason = err instanceof Error ? err.message : String(err);
      this.log("warn", `Fleet registry unavailable at init: ${reason}`);
      return { ok: false, code: "FLEET_REGISTRY_UNAVAILABLE", reason };
    }
  }

  /** Re-read shared state for the synchronous policy rule. Never throws. */
  async refresh(): Promise<SharedFleetSnapshot> {
    try {
      const health = await this.opts.store.health();
      if (!health.ok) throw new Error(health.error ?? "unhealthy");
      const [state, members] = await Promise.all([this.opts.store.getState(), this.opts.store.listMemberAddresses()]);
      this.last = { healthy: true, checkedAt: Date.now(), state, selfAgentId: this.agentId, memberAddresses: new Set(members) };
    } catch (err) {
      this.last = {
        healthy: false,
        checkedAt: Date.now(),
        state: null,
        selfAgentId: this.agentId,
        memberAddresses: this.last.memberAddresses,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    return this.last;
  }

  /** Last snapshot, marked unhealthy once stale. */
  snapshot(now = Date.now()): SharedFleetSnapshot {
    const stale = now - this.last.checkedAt > (this.opts.snapshotStaleMs ?? DEFAULT_STALE_MS);
    return stale && this.last.healthy ? { ...this.last, healthy: false, error: "fleet snapshot stale" } : this.last;
  }

  /**
   * Heartbeat this agent (UPDATE only; never inserts) and refresh the
   * snapshot. If the registry says this agent is dead (reaped, or marked by
   * the operator) the agent stops being registered and onDead fires once.
   */
  async heartbeat(): Promise<boolean> {
    let ok = false;
    try {
      if (!this.registered && !this.dead) await this.init();
      if (this.registered && this.selfAgentId) {
        ok = await this.opts.store.heartbeat(this.selfAgentId);
        if (!ok) {
          const status = await this.opts.store.selfStatus(this.selfAgentId).catch(() => null);
          if (status === "dead" || status === "failed") this.handleDeath(status);
        }
      }
    } catch (err) {
      this.log("warn", `Fleet heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.refresh();
    return ok;
  }

  private dead = false;

  private handleDeath(status: SharedAgentStatus): void {
    if (this.dead) return;
    this.dead = true;
    this.registered = false;
    this.log("error", `Fleet registry reports this agent ${this.selfAgentId} as ${status}; its slot has been released.`);
    try {
      this.opts.onDead?.(status);
    } catch {
      // onDead must not break the heartbeat loop
    }
  }

  startHeartbeat(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.heartbeat(), intervalMs);
    this.timer.unref?.();
  }

  stopHeartbeat(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async close(): Promise<void> {
    this.stopHeartbeat();
    await this.opts.store.close();
  }

  // ─── Decisions ─────────────────────────────────────────────────

  private deny(code: FleetDecisionCode, reason: string, state: FleetState): FleetDecision {
    return { allowed: false, code, reason, state };
  }

  async getStatus(): Promise<SharedFleetStatus> {
    const shared = await this.opts.store.getState();
    const effectiveMaxAgents = Math.min(shared.maxAgents, this.opts.config.maxAgents);
    const occupied = shared.livingAgents + shared.reservedSlots + (shared.quarantinedSlots ?? 0);
    const state = computeFleetState({
      configuredMode: strictestMode(this.opts.config.configuredMode, shared.operatingMode),
      emergency: false,
      livingAgents: occupied,
      maxAgents: effectiveMaxAgents,
    });
    return { state, shared, effectiveMaxAgents, occupied };
  }

  async evaluateReplication(requestedRuntime?: { repo?: unknown; commit?: unknown }): Promise<FleetDecision> {
    let status: SharedFleetStatus;
    try {
      status = await this.getStatus();
    } catch (err) {
      return this.deny(
        "FLEET_REGISTRY_UNAVAILABLE",
        `Shared fleet registry unavailable; replication fails closed (${err instanceof Error ? err.message : String(err)}).`,
        strictestMode(this.opts.config.configuredMode, "DEVELOPMENT"),
      );
    }

    const gate = evaluateReplication({
      config: this.opts.config,
      state: status.state,
      livingAgents: status.occupied,
      maxAgents: status.effectiveMaxAgents,
      isRootAgent: this.opts.isRootAgent,
      sharedRegistry: true,
    });
    if (!gate.allowed) return gate;

    if (!this.registered) {
      await this.init();
      if (!this.registered) {
        return this.deny("FLEET_NOT_REGISTERED", "This agent is not registered in the shared fleet registry.", status.state);
      }
    }

    try {
      const pin = resolveChildRuntime(this.opts.config.runtime, requestedRuntime);
      if (!samePin(pin, status.shared.runtime)) {
        return this.deny("FLEET_RUNTIME_UNVERIFIED", "Local runtime pin does not match the fleet-approved runtime.", status.state);
      }
    } catch (err) {
      return this.deny("FLEET_RUNTIME_UNVERIFIED", err instanceof Error ? err.message : String(err), status.state);
    }

    let snapshot: FinancialSnapshot | null = null;
    if (this.opts.getFinancialSnapshot) {
      try {
        snapshot = await this.opts.getFinancialSnapshot();
      } catch {
        snapshot = null;
      }
    }
    return evaluateFinancialEligibility(snapshot, this.opts.config, status.state);
  }

  /**
   * Request a new child. `spawn` receives a single-use grant bound to the
   * shared registry and must pass it to spawnChild(). Policy denials are
   * returned; spawn errors are rethrown after the slot has been released.
   */
  async requestReplication<TChild extends SharedSpawnedChild>(
    request: { name: string; requestedBy?: string; requestKey?: string; runtime?: { repo?: unknown; commit?: unknown } },
    spawn: (grant: FleetSpawnGrant) => Promise<TChild>,
    deliverCredential?: CredentialDelivery<TChild>,
  ): Promise<ReplicationOutcome<TChild>> {
    const requestedBy = request.requestedBy ?? this.opts.self.address;
    const decision = await this.evaluateReplication(request.runtime);
    if (!decision.allowed) return { ok: false, decision };

    let reservation;
    try {
      reservation = await this.opts.store.reserveSlot({
        parentAgentId: this.selfAgentId!,
        requestedBy,
        name: request.name,
        runtime: this.opts.config.runtime ?? null,
        requestKey: request.requestKey ?? ulid(),
        localMaxAgents: this.opts.config.maxAgents,
      });
    } catch (err) {
      return {
        ok: false,
        decision: this.deny(
          "FLEET_REGISTRY_UNAVAILABLE",
          `Slot reservation failed; replication fails closed (${err instanceof Error ? err.message : String(err)}).`,
          decision.state,
        ),
      };
    }
    if (!reservation.ok) {
      return { ok: false, decision: this.deny(reservation.code, reservation.reason, decision.state) };
    }

    const agentId = reservation.agent.agentId;
    const release = async (why: string) => {
      try {
        await this.opts.store.releaseReservation(agentId, why);
      } catch (err) {
        // Registry unreachable: the slot stays occupied (fail-safe over-count)
        // until an operator releases it.
        this.log("error", `Could not release fleet slot ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    let child: TChild;
    try {
      child = await spawn(reservation.grant);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof FleetRuntimeError) {
        // Runtime verification failed: stop, release, mark provisioning failed.
        await this.opts.store.recordVerificationFailure(agentId, msg).catch(() => release(`runtime verification failed: ${msg}`));
      } else {
        await release(`spawn failed: ${msg}`);
      }
      throw err;
    }

    let credential: FleetCredential;
    try {
      if (!child.address) throw new Error("spawned child has no wallet address");
      ({ credential } = await this.opts.store.activate(agentId, {
        walletAddress: child.address,
        sandboxId: child.sandboxId ?? null,
        runtimeCommit: child.runtimeCommit ?? null,
        runtimeVersion: child.runtimeVersion ?? null,
        attestation: child.attestation ?? null,
      }));
    } catch (err) {
      await release(`activation failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }

    if (deliverCredential) {
      try {
        await deliverCredential(child, credential);
      } catch (err) {
        // Without its credential the child cannot heartbeat; the reaper will
        // mark it unresponsive and then dead, releasing the slot.
        this.log("error", `Could not deliver fleet credential to child ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await this.refresh();
    return { ok: true, agentId, child, state: (await this.getStatus().catch(() => null))?.state ?? decision.state };
  }
}

export { FleetRuntimeError };
```

## `src/fleet/shared.ts`

sha256 `8d8f9a2329c7794eca7ca656fe7a94d03ee535d29f6a7dfdcc86ba4b7de83b62` · 5652 bytes · 137 lines

```ts
/**
 * Process-wide shared fleet wiring.
 *
 * One SharedFleetController per automaton process. index.ts creates it at
 * boot; the spawn_child tool, the orchestrator and the PolicyEngine rule
 * all use the same instance.
 *
 * Phase 3: agents reach the registry only through the fleet service
 * (FLEET_API_URL + their own credential file). DATABASE_URL is never read
 * here. Without a service URL or credential there is no controller and
 * every replication path fails closed.
 */

import type { ToolContext } from "../types.js";
import { getSurvivalTier } from "../conway/credits.js";
import { onChildTerminal } from "../replication/lifecycle.js";
import { loadFleetConfig, strictestMode } from "./config.js";
import { FleetApiClient } from "./service/client.js";
import { computeFleetState, evaluateReplication } from "./policy.js";
import { SharedFleetController, type CredentialDelivery, type SharedSpawnedChild } from "./shared-controller.js";
import type { FleetConfig, FleetDecision, FleetSpawnGrant, ReplicationOutcome, SharedAgentStatus } from "./types.js";

let active: SharedFleetController | null = null;
let unsubscribeLifecycle: (() => void) | null = null;

export function getActiveSharedFleet(): SharedFleetController | null {
  return active;
}

/** Install (or clear) the process's shared controller. Child deaths are forwarded to it. */
export function setActiveSharedFleet(controller: SharedFleetController | null): void {
  unsubscribeLifecycle?.();
  unsubscribeLifecycle = null;
  active = controller;
  if (controller) {
    unsubscribeLifecycle = onChildTerminal((childId, state) => {
      controller.store
        .markDeadByLocalChildId(childId, `child lifecycle: ${state}`)
        .catch(() => {
          // Registry unreachable: the agent keeps its slot (safe direction).
        });
    });
  }
}

/** Service URL children should use (the parent's own), or null. Never a DB URL. */
export function activeFleetServiceUrl(): string | null {
  const store = active?.store;
  return store && store.kind === "api" ? (store as FleetApiClient).baseUrl : process.env.FLEET_API_URL?.trim() || null;
}

export function registryUnavailableDecision(config: FleetConfig, detail: string): FleetDecision {
  return {
    allowed: false,
    code: "FLEET_REGISTRY_UNAVAILABLE",
    reason: `Shared fleet registry unavailable; replication fails closed (${detail}).`,
    state: strictestMode(config.configuredMode, "DEVELOPMENT"),
  };
}

/**
 * The controller replication must go through. Uses the active controller,
 * or builds one from FLEET_API_URL and the agent's credential file. Returns
 * null when no fleet service is configured — callers must treat that as a
 * denial.
 */
export async function getSharedFleetForContext(
  ctx: Pick<ToolContext, "identity" | "config" | "conway">,
  fleetConfig: FleetConfig = loadFleetConfig(),
  opts: {
    selfAgentId?: string | null;
    runtimeVersion?: string | null;
    runtimeCommit?: string | null;
    onDead?: (status: SharedAgentStatus) => void;
  } = {},
): Promise<SharedFleetController | null> {
  if (active) return active;
  const store = FleetApiClient.fromEnv();
  if (!store) return null;
  const controller = new SharedFleetController({
    store,
    config: fleetConfig,
    self: { address: ctx.identity.address, name: ctx.config.name },
    isRootAgent: !ctx.config.parentAddress,
    selfAgentId: opts.selfAgentId ?? null,
    runtimeVersion: opts.runtimeVersion ?? null,
    runtimeCommit: opts.runtimeCommit ?? null,
    onDead: opts.onDead,
    getFinancialSnapshot: async () => {
      const creditsCents = await ctx.conway.getCreditsBalance();
      return { creditsCents, survivalTier: getSurvivalTier(creditsCents) };
    },
  });
  await controller.init();
  setActiveSharedFleet(controller);
  return controller;
}

export async function closeActiveSharedFleet(): Promise<void> {
  const c = active;
  setActiveSharedFleet(null);
  await c?.close();
}

/**
 * Denials that follow from local configuration alone (DEVELOPMENT, EMERGENCY,
 * HARVEST, REAL_REPLICATION_ENABLED=false) need no registry round-trip.
 */
export function localReplicationPreflight(config: FleetConfig, isRootAgent: boolean): FleetDecision {
  const state = computeFleetState({ configuredMode: config.configuredMode, emergency: false, livingAgents: 0, maxAgents: config.maxAgents });
  return evaluateReplication({ config, state, livingAgents: 0, maxAgents: config.maxAgents, isRootAgent, sharedRegistry: true });
}

/**
 * The single production replication path: local preflight, then the shared
 * registry controller. No shared registry => denied.
 */
export async function requestSharedReplication<TChild extends SharedSpawnedChild>(
  ctx: Pick<ToolContext, "identity" | "config" | "conway">,
  request: { name: string; requestedBy?: string },
  spawn: (grant: FleetSpawnGrant) => Promise<TChild>,
  fleetConfig: FleetConfig = loadFleetConfig(),
  deliverCredential?: CredentialDelivery<TChild>,
): Promise<ReplicationOutcome<TChild>> {
  const pre = localReplicationPreflight(fleetConfig, !ctx.config.parentAddress);
  if (!pre.allowed) return { ok: false, decision: pre };
  let fleet: SharedFleetController | null;
  try {
    fleet = await getSharedFleetForContext(ctx, fleetConfig);
  } catch (err) {
    return { ok: false, decision: registryUnavailableDecision(fleetConfig, err instanceof Error ? err.message : String(err)) };
  }
  if (!fleet) {
    return { ok: false, decision: registryUnavailableDecision(fleetConfig, "fleet service (FLEET_API_URL + credential) not configured") };
  }
  return fleet.requestReplication(request, spawn, deliverCredential);
}
```

## `src/fleet/types.ts`

sha256 `7bde6b4aaa710c6173a19661148398439fb559195e63ba17c288db85faa33d0b` · 7020 bytes · 250 lines

```ts
/**
 * Fleet Types
 *
 * The fleet layer sits above the existing replication system and bounds
 * how many automatons may be alive across the whole lineage.
 */

import type { SurvivalTier } from "../types.js";
import type { RuntimePin } from "./runtime.js";
import type { RuntimeAttestation, RuntimeBuild } from "./attestation.js";

export type FleetState = "DEVELOPMENT" | "EXPANSION" | "HARVEST" | "EMERGENCY";

export const FLEET_STATES: readonly FleetState[] = Object.freeze([
  "DEVELOPMENT",
  "EXPANSION",
  "HARVEST",
  "EMERGENCY",
]);

export type FleetAgentRole = "root" | "child";

/** reserved/spawning/active are "living" and count toward the cap. */
export type FleetAgentStatus = "reserved" | "spawning" | "active" | "dead" | "failed";

export const LIVING_FLEET_STATUSES: readonly FleetAgentStatus[] = Object.freeze([
  "reserved",
  "spawning",
  "active",
]);

export interface FleetConfig {
  /** Global living-agent cap across the lineage, including the root. 1..50. */
  maxAgents: number;
  /** Operator-selected mode. HARVEST is additionally auto-selected at the cap. */
  configuredMode: FleetState;
  realReplicationEnabled: boolean;
  realPaymentsEnabled: boolean;
  /** Parsed for visibility only. Owner sweeps are not implemented in Phase 1. */
  ownerSweepEnabled: boolean;
  /** Minimum parent credit balance (cents) required before replication. */
  minParentReserveCents: number;
  /** Pinned child runtime (FLEET_RUNTIME_REPO / FLEET_RUNTIME_COMMIT); null if unset or invalid. */
  runtime?: RuntimePin | null;
}

export interface FleetAgentRecord {
  id: string;
  role: FleetAgentRole;
  parentAgentId: string | null;
  requestedBy: string;
  name: string;
  address: string | null;
  childId: string | null;
  sandboxId: string | null;
  status: FleetAgentStatus;
  statusReason: string | null;
  generation: number;
  createdAt: string;
  updatedAt: string;
  diedAt: string | null;
}

export interface FleetEventRecord {
  id: string;
  eventType: string;
  agentId: string | null;
  actor: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

/**
 * Proof that FleetController reserved a living slot. spawnChild() refuses
 * to run without one and consumes it (single use) before creating a sandbox.
 */
export interface FleetSpawnGrant {
  readonly kind: "fleet-spawn-grant";
  readonly reservationId: string;
}

export interface FinancialSnapshot {
  creditsCents: number;
  survivalTier: SurvivalTier;
}

export type FleetDecisionCode =
  | "ALLOWED"
  | "FLEET_EMERGENCY"
  | "FLEET_DEVELOPMENT_MODE"
  | "FLEET_HARVEST"
  | "FLEET_CAP_REACHED"
  | "REAL_REPLICATION_DISABLED"
  | "REAL_PAYMENTS_DISABLED"
  | "NOT_FLEET_ROOT"
  | "FINANCIALLY_INELIGIBLE"
  | "FLEET_CHILD_FUNDING_BYPASS"
  | "FLEET_REGISTRY_UNAVAILABLE"
  | "FLEET_RUNTIME_UNVERIFIED"
  | "FLEET_NOT_REGISTERED"
  | "FLEET_PARENT_NOT_LIVING"
  | "FLEET_DUPLICATE_REQUEST"
  | "FLEET_AUTH_FAILED"
  | "FLEET_NOT_AUTHORIZED"
  | "FLEET_AGENT_DEAD";

export interface FleetDecision {
  allowed: boolean;
  code: FleetDecisionCode;
  reason: string;
  state: FleetState;
}

export interface FleetStatus {
  state: FleetState;
  configuredMode: FleetState;
  emergency: boolean;
  livingAgents: number;
  maxAgents: number;
  totalRecorded: number;
}

export type ReplicationOutcome<TChild> =
  | { ok: true; agentId: string; child: TChild; state: FleetState }
  | { ok: false; decision: FleetDecision };

// ─── Shared (PostgreSQL) registry — Phase 2 ─────────────────────

/**
 * reserved/provisioning hold a reserved slot; active and unresponsive (missed
 * heartbeats, Phase 3) are living; dead/failed are history.
 */
export type SharedAgentStatus =
  | "reserved"
  | "provisioning"
  | "active"
  | "unresponsive"
  | "terminating"
  | "orphaned"
  | "dead"
  | "failed";

export interface SharedFleetState {
  livingAgents: number;
  reservedSlots: number;
  maxAgents: number;
  operatingMode: FleetState;
  runtime: RuntimePin | null;
  updatedAt: string;
  /** DB-level replication switch (Phase 3). Absent = unknown = off. */
  replicationEnabled?: boolean;
  /** Operator-approved build identity of the runtime (Phase 3). */
  build?: RuntimeBuild | null;
  /** Slots held by ORPHANED agents (Phase 5 orphan policy); they count against the cap. */
  quarantinedSlots?: number;
}

/** Reservation lease (Phase 3): a reserved slot with an expiry. */
export type ReservationLeaseStatus = "reserved" | "provisioning" | "completed" | "expired" | "released" | "failed";

export interface ReservationLease {
  reservationId: string;
  agentId: string;
  parentAgentId: string;
  status: ReservationLeaseStatus;
  createdAt: string;
  expiresAt: string;
  claimedAt: string | null;
  completedAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  expected: { repo: string; commit: string; buildId: string; lockfileSha256: string };
  attestedAt: string | null;
}

/** Per-agent bearer credential. Only its SHA-256 is stored by the registry. */
export interface FleetCredential {
  agentId: string;
  token: string;
}

export interface ActivationResult {
  agent: SharedAgentRecord;
  credential: FleetCredential;
}

/** What a spawned child reports back to the controller (verified, never trusted as-is). */
export interface SharedSpawnedChildReport {
  address?: string;
  sandboxId?: string;
  runtimeCommit?: string;
  runtimeVersion?: string | null;
  attestation?: RuntimeAttestation;
}

export interface ReapResult {
  expired: number;
  unresponsive: number;
  dead: number;
  graceFrom: string | null;
}

/**
 * Capability scope of an agent identity (schema v7). 'full' is every normal
 * agent. 'witness' is a root that may only open sessions, heartbeat, answer
 * health challenges and read itself (FLEET-KI-4). Immutable after enrollment.
 */
export type FleetCapabilityScope = "full" | "witness";

export interface SharedAgentRecord {
  agentId: string;
  parentAgentId: string | null;
  role: FleetAgentRole;
  generation: number;
  name: string;
  walletAddress: string | null;
  runtimeVersion: string | null;
  runtimeRepo: string | null;
  runtimeCommit: string | null;
  sandboxId: string | null;
  localChildId: string | null;
  status: SharedAgentStatus;
  statusReason: string | null;
  requestedBy: string | null;
  createdAt: string;
  updatedAt: string;
  lastHeartbeat: string | null;
  deathTime: string | null;
  /** Schema v7; absent from older records. */
  capabilityScope?: FleetCapabilityScope;
}

export interface FleetHealth {
  ok: boolean;
  latencyMs: number | null;
  schemaVersion: number | null;
  /** Stored counters equal the live row counts. */
  countersConsistent: boolean | null;
  error?: string;
}

/** Cached view used by the (synchronous) PolicyEngine rule. */
export interface SharedFleetSnapshot {
  healthy: boolean;
  checkedAt: number;
  state: SharedFleetState | null;
  selfAgentId: string | null;
  memberAddresses: ReadonlySet<string>;
  error?: string;
}
```

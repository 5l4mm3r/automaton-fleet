# SOURCE VOLUME 03 — PostgreSQL store, CLI, privileges, agent gateway

Exact, byte-for-byte text of each file at repository commit `efad2148a3460ab881b0ab845fb13c25d1fa3e74` (branch fleet-development).
No file in this volume contains a real secret; test fixtures generate synthetic secrets at runtime.
Each file's SHA-256 is of the file bytes on disk and matches 22-RECONSTRUCTION-MANIFEST.md.

## Files

- `src/fleet/postgres/agent-gateway.ts` — 213 lines, sha256 `f08cdcce086fe830f032091059cb6db6af5735fedf8986746bdcd42c4e696c55`
- `src/fleet/postgres/cli.ts` — 598 lines, sha256 `8fe5f8012d3fc671089a8dfeb130c3cacb15f89e2ad81fbc065ec783053c18ac`
- `src/fleet/postgres/privileges.ts` — 376 lines, sha256 `563e3b3176ad5b225058c327226f6faa53125398e208bff01125a9e2f5d9610b`
- `src/fleet/postgres/store.ts` — 1653 lines, sha256 `ecd883a9387300896cedf4e6242df47630005aa529ca52656486b2541a1657ea`

## `src/fleet/postgres/agent-gateway.ts`

sha256 `f08cdcce086fe830f032091059cb6db6af5735fedf8986746bdcd42c4e696c55` · 9065 bytes · 213 lines

```ts
/**
 * Restricted agent gateway (Phase 3)
 *
 * Connects as the restricted agent role (FLEET_AGENT_DATABASE_URL) and can
 * only call the api_* SECURITY DEFINER functions. The fleet service uses it
 * for every agent-scoped request (heartbeat, state, replication request,
 * release, own status), so a bug in a request handler cannot touch the cap,
 * other agents, triggers or schema: the database refuses.
 *
 * selfCheck() verifies at startup that the connected role really is
 * restricted; the service refuses to start otherwise.
 */

import pg from "pg";
import type { Pool } from "pg";
import { isFleetState } from "../config.js";
import type { SharedAgentRecord, SharedAgentStatus, SharedFleetState } from "../types.js";
import { FLEET_PG_HARD_MAX_AGENTS, quoteIdent } from "./migrations.js";

export interface AgentGatewayOptions {
  connectionString: string;
  schema?: string;
  poolMax?: number;
  statementTimeoutMs?: number;
}

export type ApiResult<T = Record<string, unknown>> = ({ ok: true } & T) | { ok: false; code: string; reason?: string; [k: string]: unknown };

export interface StateJson {
  livingAgents: number;
  reservedSlots: number;
  quarantinedSlots?: number;
  maxAgents: number;
  operatingMode: string;
  replicationEnabled: boolean;
  runtime: { repo: string; commit: string } | null;
  build: { buildId: string; lockfileSha256: string } | null;
  updatedAt: string;
}

export function stateFromJson(j: StateJson): SharedFleetState {
  return {
    livingAgents: j.livingAgents,
    reservedSlots: j.reservedSlots,
    quarantinedSlots: j.quarantinedSlots ?? 0,
    maxAgents: Math.min(j.maxAgents, FLEET_PG_HARD_MAX_AGENTS),
    operatingMode: isFleetState(j.operatingMode) ? j.operatingMode : "EMERGENCY",
    runtime: j.runtime,
    updatedAt: new Date(j.updatedAt).toISOString(),
    replicationEnabled: j.replicationEnabled === true,
    build: j.build,
  };
}

function isoOrNull(v: unknown): string | null {
  return v ? new Date(v as string).toISOString() : null;
}

export function agentFromJson(a: Record<string, unknown>): SharedAgentRecord {
  return {
    agentId: a.agentId as string,
    parentAgentId: (a.parentAgentId as string) ?? null,
    role: a.role as "root" | "child",
    generation: a.generation as number,
    name: a.name as string,
    walletAddress: (a.walletAddress as string) ?? null,
    runtimeVersion: (a.runtimeVersion as string) ?? null,
    runtimeRepo: (a.runtimeRepo as string) ?? null,
    runtimeCommit: (a.runtimeCommit as string) ?? null,
    sandboxId: (a.sandboxId as string) ?? null,
    localChildId: (a.localChildId as string) ?? null,
    status: a.status as SharedAgentStatus,
    statusReason: (a.statusReason as string) ?? null,
    requestedBy: (a.requestedBy as string) ?? null,
    createdAt: new Date(a.createdAt as string).toISOString(),
    updatedAt: new Date(a.updatedAt as string).toISOString(),
    lastHeartbeat: isoOrNull(a.lastHeartbeat),
    deathTime: isoOrNull(a.deathTime),
    ...(a.capabilityScope === "full" || a.capabilityScope === "witness" ? { capabilityScope: a.capabilityScope } : {}),
  };
}

export class PgAgentGateway {
  readonly schema: string;
  private readonly s: string;
  private readonly pool: Pool;

  constructor(opts: AgentGatewayOptions) {
    this.schema = opts.schema ?? "fleet";
    this.s = quoteIdent(this.schema);
    const stmtMs = opts.statementTimeoutMs ?? 10_000;
    this.pool = new pg.Pool({
      connectionString: opts.connectionString,
      max: opts.poolMax ?? 8,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 10_000,
      allowExitOnIdle: true,
      application_name: "automaton-fleet-agent-api",
      options: `-c statement_timeout=${stmtMs} -c lock_timeout=5000`,
    });
    this.pool.on("error", () => {});
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => {});
  }

  private async call<T>(fn: string, args: unknown[]): Promise<T> {
    const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
    const r = await this.pool.query(`SELECT ${this.s}.${fn}(${placeholders}) AS r`, args);
    return r.rows[0].r as T;
  }

  /**
   * Startup check: the connected role must not be a superuser, must not own
   * the schema, and must have no direct privileges on fleet tables. Returns
   * the list of problems (empty = restricted as intended).
   */
  async selfCheck(): Promise<string[]> {
    const problems: string[] = [];
    const who = await this.pool.query<{ u: string; su: boolean; cr: boolean; cd: boolean; owner: string | null }>(
      `SELECT current_user AS u, r.rolsuper AS su, r.rolcreaterole AS cr, r.rolcreatedb AS cd,
              (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = $1) AS owner
         FROM pg_roles r WHERE r.rolname = current_user`,
      [this.schema],
    );
    const w = who.rows[0];
    if (!w) return ["cannot identify the connected role"];
    if (w.su) problems.push(`${w.u} is a superuser`);
    if (w.cr) problems.push(`${w.u} can create roles`);
    if (w.cd) problems.push(`${w.u} can create databases`);
    if (w.owner === w.u) problems.push(`${w.u} owns schema ${this.schema}`);
    const priv = await this.pool.query<{ t: string; p: string }>(
      `SELECT c.relname AS t, p.priv AS p
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER','REFERENCES']) AS p(priv)
        WHERE n.nspname = $1 AND c.relkind IN ('r','v','m','p','S')
          AND has_table_privilege(current_user, c.oid, p.priv)`,
      [this.schema],
    );
    for (const r of priv.rows) problems.push(`${w.u} has ${r.p} on ${this.schema}.${r.t}`);
    const create = await this.pool.query<{ c: boolean }>("SELECT has_schema_privilege(current_user, $1, 'CREATE') AS c", [this.schema]);
    if (create.rows[0]?.c) problems.push(`${w.u} can create objects in ${this.schema}`);
    return problems;
  }

  async fleetState(): Promise<SharedFleetState> {
    return stateFromJson(await this.call<StateJson>("api_fleet_state", []));
  }

  async memberAddresses(): Promise<string[]> {
    const r = await this.pool.query<{ a: string }>(`SELECT a FROM ${this.s}.api_member_addresses() AS a`);
    return r.rows.map((x) => x.a);
  }

  async whoami(agentId: string, token: string): Promise<ApiResult<{ agent: SharedAgentRecord; code?: string | null }>> {
    const r = await this.call<{ ok: boolean; code?: string; agent?: Record<string, unknown> }>("api_whoami", [agentId, token]);
    if (r.agent) {
      const agent = agentFromJson(r.agent);
      return r.ok ? { ok: true, agent } : { ok: false, code: r.code ?? "FLEET_AUTH_FAILED", agent };
    }
    return { ok: false, code: r.code ?? "FLEET_AUTH_FAILED" };
  }

  async heartbeat(agentId: string, token: string): Promise<ApiResult<{ status: string }>> {
    const r = await this.call<{ ok: boolean; code?: string; status?: string }>("api_heartbeat", [agentId, token]);
    return r.ok ? { ok: true, status: r.status ?? "active" } : { ok: false, code: r.code ?? "FLEET_AGENT_DEAD", status: r.status };
  }

  async requestReplication(
    agentId: string,
    token: string,
    name: string,
    requestKey: string,
    newAgentId: string,
    reservationId: string,
  ): Promise<Record<string, unknown> & { ok: boolean }> {
    return this.call("api_request_replication", [agentId, token, name, requestKey, newAgentId, reservationId]);
  }

  async releaseReservation(agentId: string, token: string, reservationId: string, reason: string): Promise<ApiResult<{ released: boolean }>> {
    return this.call("api_release_reservation", [agentId, token, reservationId, reason]);
  }

  async setOwnStatus(agentId: string, token: string, status: string, reason: string): Promise<ApiResult<{ changed: boolean }>> {
    return this.call("api_set_own_status", [agentId, token, status, reason]);
  }

  /** Exchange the long-lived credential for a short-lived session (only the hash is stored). */
  async openSession(agentId: string, token: string, sessionHash: string): Promise<ApiResult<{ expiresAt: string; ttlS: number }>> {
    return this.call("api_open_session", [agentId, token, sessionHash]);
  }

  async proposeAllocation(
    agentId: string,
    token: string,
    p: { allocationId: string; purpose: string; requestedCents: number; expectedReturnCents: number; expectedDurationDays: number },
  ): Promise<ApiResult<{ allocationId: string; status: string }>> {
    return this.call("api_propose_allocation", [
      agentId, token, p.allocationId, p.purpose, p.requestedCents, p.expectedReturnCents, p.expectedDurationDays,
    ]);
  }

  async requestSpend(
    agentId: string,
    token: string,
    r: { requestId: string; fromWallet: string; toAddress: string; amountCents: number; purpose: string; allocationId: string | null },
  ): Promise<Record<string, unknown> & { ok: boolean }> {
    return this.call("api_request_spend", [
      agentId, token, r.requestId, r.fromWallet, r.toAddress, r.amountCents, r.purpose, r.allocationId,
    ]);
  }
}
```

## `src/fleet/postgres/cli.ts`

sha256 `8fe5f8012d3fc671089a8dfeb130c3cacb15f89e2ad81fbc065ec783053c18ac` · 29412 bytes · 598 lines

```ts
/**
 * Operator CLI for the shared fleet registry. Not an agent tool; the shell
 * guard forbids agents from invoking it.
 *
 *   pnpm fleet:migrate
 *   pnpm fleet:admin status | health
 *   pnpm fleet:admin set-cap <1..50>
 *   pnpm fleet:admin set-mode <DEVELOPMENT|EXPANSION|HARVEST|EMERGENCY> [reason]
 *   pnpm fleet:admin approve-runtime          (FLEET_RUNTIME_REPO / _COMMIT / _BUILD_ID / _LOCKFILE_SHA256)
 *   pnpm fleet:admin clear-runtime
 *   pnpm fleet:admin build-identity <dir>     (build id + lockfile hash of a built runtime tree)
 *   pnpm fleet:admin set-replication on|off   (DB-level replication switch)
 *   pnpm fleet:admin set-timeouts [reservation=S] [provisioning=S] [unresponsive=S] [dead=S]
 *   pnpm fleet:admin enroll-root <wallet> <name> [credentialFile]
 *   pnpm fleet:admin rotate-credential <agentId> [credentialFile]
 *   pnpm fleet:admin grant-agent-role [role]
 *   pnpm fleet:admin grant-service-role [role]
 *   pnpm fleet:audit-privileges               (fails if agent/service roles are too broad)
 *   pnpm fleet:doctor [--json] [--deployment-only]
 *   pnpm fleet:verify                          (operator checklist + SAFE FOR DRY RUN / REAL REPLICATION / REAL PAYMENTS)
 *   pnpm fleet:admin migrate-check            (apply pending migrations in ONE transaction, then roll back)
 *   pnpm fleet:verify-runtime [dir] [--json]   (pinned runtime identity; exit 1 on any mismatch)
 *   pnpm fleet:admin reconcile-provisioning     (uncertain sandbox outcomes; looks them up by name when
 *                                               CONWAY_API_KEY is set, else lists them)
 *   pnpm fleet:admin reconcile <provisioningKey> found <sandboxId> | absent | unknown
 *   pnpm fleet:dry-run-child --root <agentId> --api-url https://… [--confirm-real-sandbox]
 *   pnpm fleet:admin terminations             (sandbox termination queue)
 *   pnpm fleet:admin quarantine <agentId> [reason]        revoke everything now; terminate / orphan its sandbox
 *   pnpm fleet:admin resolve-orphan <agentId> <resolution> (after external cleanup is confirmed)
 *   pnpm fleet:admin orphans [all] | provisioning [cleanup]
 *   pnpm fleet:admin lifecycle-policy [interval=S] [challengeTtl=S] [healthGrace=S] [maxFailures=N]
 *                                     [terminationGrace=S] [orphanHold=S] [maxOrphans=N] [sessionTtl=S]
 *   pnpm fleet:admin <treasury command>        see src/fleet/treasury/cli.ts
 *   pnpm fleet:admin reap | reservations
 *   pnpm fleet:admin release <agentId> [reason]
 *   pnpm fleet:admin mark-dead <agentId> [reason]
 *   pnpm fleet:admin grant-operator-role [role]       (schema v8; normally done by migrate)
 *   pnpm fleet:admin operator-enroll <name> <bridge_claude|bridge_chatgpt> --scopes a,b --public-key <b64url> --expires-days N
 *   pnpm fleet:admin operator-add-key <principalId> --public-key <b64url> --expires-days N
 *   pnpm fleet:admin operator-revoke-key <keyId> <reason…>
 *   pnpm fleet:admin operator-revoke <principalId> <reason…>
 *   pnpm fleet:admin operator-revoke-all <reason…>   (revokes everything AND disables the API)
 *   pnpm fleet:admin operator-api enable|disable <reason…>
 *   pnpm fleet:admin operator-list
 *   pnpm fleet:admin operator-archive --before <ISO time> --out <new file> [--max-rows N<=100000]
 *   pnpm fleet:admin enroll-witness-root <name> <credentialFile>
 *                                     root with capability scope 'witness' (FLEET-KI-4): keyless address,
 *                                     approved runtime commit, custody frozen; refuses an existing file
 *
 * The privileged admin credential FLEET_ADMIN_DATABASE_URL is read from the
 * environment, else /etc/automaton-fleet/admin.env (0640, group
 * automaton-fleet-admin), else — legacy, with a warning — .env.fleet
 * (FLEET_CONTROLLER_DATABASE_URL / DATABASE_URL). It is never printed; agent
 * tokens are written to a 0600 file, never to stdout. Migrations refuse any
 * credential that does not own the fleet schema.
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { isFleetState } from "../config.js";
import { validateRuntimePin } from "../runtime.js";
import { computeBuildIdentity, loadRuntimeBuild } from "../attestation.js";
import { formatChecklist, formatDoctorReport, runDoctor } from "../doctor.js";
import { loadAdminEnv, readEnvFile, type LoadedEnv } from "../secret-files.js";
import { PgTreasuryStore } from "../treasury/store.js";
import { TREASURY_COMMANDS, runTreasuryCommand } from "../treasury/cli.js";
import type { FleetCredential } from "../types.js";
import { PgFleetStore } from "./store.js";
import { FLEET_PG_SCHEMA_VERSION } from "./migrations.js";
import { formatRuntimeIdentity, treeIdentity, verifyRuntimeIdentity } from "../runtime-verify.js";
import { dryRunPreflight, keylessAddress, performDryRunChild } from "../dry-run/operator.js";
import { findSandboxByName } from "../../replication/spawn.js";
import { createConwayClient } from "../../conway/client.js";
import type { ConwayClient } from "../../types.js";
import { redactDetail, redactText } from "../redact.js";
import { scanAuditFile } from "../redact-scan.js";
import { PgOperatorAdmin } from "../operator/admin.js";
import type { OperatorKind, OperatorScope } from "../operator/route-policy.js";

/** Operator Conway client (CONWAY_API_KEY / CONWAY_API_URL); null when not configured. */
function operatorConway(e: Record<string, string | undefined>): ConwayClient | null {
  const apiKey = e.CONWAY_API_KEY?.trim();
  if (!apiKey) return null;
  return createConwayClient({ apiUrl: e.CONWAY_API_URL?.trim() || "https://api.conway.tech", apiKey, sandboxId: "" });
}

function argValue(rest: string[], flag: string): string | undefined {
  const i = rest.indexOf(flag);
  return i >= 0 ? rest[i + 1] : undefined;
}

const DEFAULT_CREDENTIAL_FILE = path.join(os.homedir(), ".automaton", "fleet-credentials.json");

/** Write an agent credential with 0600 permissions (created exclusively when new). */
export function writeCredentialFile(file: string, cred: FleetCredential, apiUrl: string | null): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ agentId: cred.agentId, token: cred.token, apiUrl }, null, 2), { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

/**
 * Write a credential file that must not exist yet: 0600, created through a
 * hard link so an existing file (or one created concurrently) is never replaced.
 */
export function writeCredentialFileExclusive(file: string, cred: FleetCredential, apiUrl: string | null): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ agentId: cred.agentId, token: cred.token, apiUrl }, null, 2), { mode: 0o600, flag: "wx" });
  try {
    fs.linkSync(tmp, file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${file} already exists; refusing to overwrite a credential file.`);
    throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  fs.chmodSync(file, 0o600);
}

export interface WitnessEnrollment {
  agentId: string;
  role: "root";
  capabilityScope: "witness";
  runtimeCommit: string;
  custodyFrozen: boolean;
  credentialFile: string;
}

/**
 * FLEET-KI-4: enroll a root with capability scope 'witness' for the dry run.
 * Keyless wallet address (no private key exists), runtime commit = the
 * registry-approved commit, custody frozen with a zero limit (enforced by the
 * database), credential written 0600 to a file that must not exist. The
 * token is never printed or returned. Normal enroll-root is unchanged.
 */
export async function enrollWitnessRoot(
  store: PgFleetStore,
  p: { name: string; credentialFile: string; apiUrl: string | null; actor: string },
): Promise<WitnessEnrollment> {
  const file = path.resolve(p.credentialFile);
  let exists = true;
  try {
    fs.lstatSync(file);
  } catch {
    exists = false;
  }
  if (exists) throw new Error(`${file} already exists; refusing to overwrite a credential file.`);
  const st = await store.getState();
  if (!st.runtime?.commit || !st.build) throw new Error("No runtime is approved in the registry; approve the pinned release first.");
  const reg = await store.registerRoot({
    walletAddress: keylessAddress(`automaton-fleet:witness-root:no-key:${crypto.randomBytes(32).toString("hex")}`),
    name: p.name,
    runtimeCommit: st.runtime.commit,
    capabilityScope: "witness",
  });
  if (!reg.ok) throw new Error(`${reg.code}: ${reg.reason}`);
  const agentId = reg.agent.agentId;
  try {
    const auth = await store.agentAuthority(agentId);
    if (!auth || auth.spendingFrozen !== true || auth.dailyLimitCents !== 0) throw new Error("witness custody is not frozen with a zero limit");
    const cred = await store.issueCredential(agentId, p.actor);
    writeCredentialFileExclusive(file, cred, p.apiUrl);
    return { agentId, role: "root", capabilityScope: "witness", runtimeCommit: st.runtime.commit, custodyFrozen: true, credentialFile: file };
  } catch (err) {
    // Never leave a living witness without its credential: retire it (revokes everything).
    await store.markDead(agentId, "witness enrollment failed", p.actor).catch(() => {});
    throw err;
  }
}

export { readEnvFile };

const OPERATOR_COMMANDS = new Set([
  "operator-enroll",
  "operator-add-key",
  "operator-revoke-key",
  "operator-revoke",
  "operator-revoke-all",
  "operator-api",
  "operator-list",
  "operator-archive",
]);

/** Operator principal lifecycle (schema v8). Public keys only; private keys stay on the bridge host. */
export async function runOperatorCommand(cmd: string, rest: string[], admin: PgOperatorAdmin, actor: string): Promise<unknown> {
  const positional = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1].startsWith("--")));
  const days = (v: string | undefined) => {
    const n = Number(v);
    if (!Number.isInteger(n)) throw new Error("--expires-days N (1..90) is required");
    return n;
  };
  const reason = (from: number) => positional.slice(from).join(" ").trim() || "operator decision";
  switch (cmd) {
    case "operator-enroll": {
      const [name, kind] = positional;
      const scopes = (argValue(rest, "--scopes") ?? "").split(",").map((s) => s.trim()).filter(Boolean) as OperatorScope[];
      const publicKey = argValue(rest, "--public-key");
      if (!name || !kind || !publicKey) throw new Error("usage: operator-enroll <name> <bridge_claude|bridge_chatgpt> --scopes a,b --public-key <b64url> --expires-days N");
      return admin.enroll({ name, kind: kind as OperatorKind, scopes, publicKey, expiresDays: days(argValue(rest, "--expires-days")), actor });
    }
    case "operator-add-key": {
      const publicKey = argValue(rest, "--public-key");
      if (!positional[0] || !publicKey) throw new Error("usage: operator-add-key <principalId> --public-key <b64url> --expires-days N");
      return admin.addKey({ principalId: positional[0], publicKey, expiresDays: days(argValue(rest, "--expires-days")), actor });
    }
    case "operator-revoke-key":
      if (!positional[0]) throw new Error("usage: operator-revoke-key <keyId> <reason…>");
      return admin.revokeKey({ keyId: positional[0], reason: reason(1), actor });
    case "operator-revoke":
      if (!positional[0]) throw new Error("usage: operator-revoke <principalId> <reason…>");
      return admin.revokePrincipal({ principalId: positional[0], reason: reason(1), actor });
    case "operator-revoke-all":
      return admin.revokeAll({ reason: reason(0), actor });
    case "operator-api": {
      const mode = positional[0];
      if (mode !== "enable" && mode !== "disable") throw new Error("usage: operator-api enable|disable <reason…>");
      return admin.setEnabled({ enabled: mode === "enable", reason: reason(1), actor });
    }
    case "operator-list":
      return admin.list();
    case "operator-archive": {
      const before = argValue(rest, "--before");
      const out = argValue(rest, "--out");
      const maxRows = argValue(rest, "--max-rows");
      if (!before || !out || !Number.isFinite(Date.parse(before))) throw new Error("usage: operator-archive --before <ISO time> --out <new file> [--max-rows N]");
      return admin.archive({ before: new Date(before), outFile: out, actor, maxRows: maxRows === undefined ? undefined : Number(maxRows) });
    }
    default:
      throw new Error(`unknown operator command ${cmd}`);
  }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "build-identity") {
    // Needs no credentials; must work before any secret file exists.
    const dir = path.resolve(rest[0] ?? ".");
    console.log(JSON.stringify({ dir, ...computeBuildIdentity(dir) }));
    return 0;
  }
  if (cmd === "audit-scan") {
    // Count-only scan of audit/log files with the canonical detection rules. Needs no credentials.
    // Prints metadata and per-class counts only, never matched text. Exit 1 when anything is detected.
    if (!rest.length) {
      console.error("usage: fleet:admin audit-scan <file> [file…]");
      return 2;
    }
    let found = false;
    for (const f of rest) {
      try {
        const r = await scanAuditFile(f);
        found ||= r.total > 0;
        console.log(JSON.stringify(r));
      } catch (err) {
        console.error(redactText(`audit-scan ${f}: ${err instanceof Error ? err.message : String(err)}`));
        return 2;
      }
    }
    return found ? 1 : 0;
  }
  let loaded: LoadedEnv;
  try {
    loaded = loadAdminEnv();
  } catch (err) {
    if (cmd === "doctor") {
      const report = await runDoctor({ env: process.env, store: null, configError: err instanceof Error ? err.message : String(err) });
      console.log(rest.includes("--json") ? JSON.stringify(report, null, 2) : formatDoctorReport(report));
      return 1;
    }
    console.error(redactText(err instanceof Error ? err.message : String(err)));
    return 2;
  }
  const e = loaded.env;
  for (const w of loaded.warnings) console.error(redactText(`warning: ${w}`));
  if (cmd === "doctor") {
    const store = PgFleetStore.fromEnv(e);
    try {
      const report = await runDoctor({ env: e, store });
      if (rest.includes("--checklist")) {
        // pnpm fleet:verify — the single operator verification; exit 0 only when SAFE FOR DRY RUN.
        console.log(rest.includes("--json") ? JSON.stringify({ checklist: report.checklist, readiness: report.readiness }, null, 2) : formatChecklist(report));
        return report.readiness.dryRun.safe ? 0 : 1;
      }
      console.log(rest.includes("--json") ? JSON.stringify(report, null, 2) : formatDoctorReport(report));
      return rest.includes("--deployment-only") ? (report.deploymentOk ? 0 : 1) : report.replicationSafe ? 0 : 1;
    } finally {
      await store?.close();
    }
  }
  if (cmd === "verify-runtime") {
    const store = PgFleetStore.fromEnv(e);
    try {
      const st = store ? await store.getState().catch(() => null) : null;
      const approved = st?.runtime && st.build ? { ...st.runtime, ...st.build } : null;
      const dir = rest.find((a) => !a.startsWith("--"));
      const report = verifyRuntimeIdentity({ env: e, approved, tree: dir ? treeIdentity(dir) : null });
      console.log(rest.includes("--json") ? JSON.stringify(report, null, 2) : formatRuntimeIdentity(report));
      return report.ok ? 0 : 1;
    } finally {
      await store?.close();
    }
  }
  const store = PgFleetStore.fromEnv(e);
  if (!store) {
    console.error("FLEET_ADMIN_DATABASE_URL is not configured (environment, /etc/automaton-fleet/admin.env, or legacy .env.fleet).");
    return 2;
  }
  const actor = `operator:${os.userInfo().username}`;
  if (OPERATOR_COMMANDS.has(cmd)) {
    const admin = new PgOperatorAdmin({
      connectionString: (e.FLEET_ADMIN_DATABASE_URL || e.FLEET_CONTROLLER_DATABASE_URL || e.DATABASE_URL)!.trim(),
      schema: e.FLEET_PG_SCHEMA?.trim() || undefined,
    });
    try {
      console.log(JSON.stringify(await runOperatorCommand(cmd, rest, admin, actor), null, 2));
      return 0;
    } catch (err) {
      console.error(redactText(err instanceof Error ? err.message : String(err)));
      return 1;
    } finally {
      await admin.close();
      await store.close();
    }
  }
  if (TREASURY_COMMANDS.has(cmd)) {
    const ts = new PgTreasuryStore({
      connectionString: (e.FLEET_ADMIN_DATABASE_URL || e.FLEET_CONTROLLER_DATABASE_URL || e.DATABASE_URL)!.trim(),
      schema: e.FLEET_PG_SCHEMA?.trim() || undefined,
    });
    try {
      console.log(JSON.stringify(await runTreasuryCommand(cmd, rest, ts, actor), null, 2));
      return 0;
    } catch (err) {
      console.error(redactText(err instanceof Error ? err.message : String(err)));
      return 1;
    } finally {
      await ts.close();
      await store.close();
    }
  }
  try {
    switch (cmd) {
      case "quarantine": {
        if (!rest[0]) throw new Error("usage: quarantine <agentId> [reason]");
        console.log(JSON.stringify({ agentId: rest[0], result: await store.quarantine(rest[0], rest.slice(1).join(" ") || "operator quarantine", actor) }));
        return 0;
      }
      case "resolve-orphan": {
        if (!rest[0] || !rest[1]) throw new Error("usage: resolve-orphan <agentId> <resolution…>");
        console.log(JSON.stringify({ resolved: await store.resolveOrphan(rest[0], rest.slice(1).join(" "), actor) }));
        return 0;
      }
      case "orphans": {
        console.log(JSON.stringify(await store.listOrphans({ open: rest[0] !== "all" }), null, 2));
        return 0;
      }
      case "provisioning": {
        console.log(JSON.stringify(await store.listProvisioning({ needsCleanup: rest[0] === "cleanup" }), null, 2));
        return 0;
      }
      case "lifecycle-policy": {
        const keys: Record<string, string> = {
          interval: "healthChallengeIntervalS", challengeTtl: "challengeTtlS", healthGrace: "healthGraceS", maxFailures: "maxChallengeFailures",
          terminationGrace: "terminationGraceS", orphanHold: "orphanSlotHoldS", maxOrphans: "maxOpenOrphans", sessionTtl: "sessionTtlS",
        };
        if (!rest.length) {
          console.log(JSON.stringify(await store.getLifecyclePolicy(), null, 2));
          return 0;
        }
        const patch: Record<string, number> = {};
        for (const kvp of rest) {
          const [k, v] = kvp.split("=");
          if (!keys[k] || !/^\d+$/.test(v ?? "")) throw new Error(`bad setting ${kvp}`);
          patch[keys[k]] = Number(v);
        }
        console.log(JSON.stringify(await store.setLifecyclePolicy(patch, actor), null, 2));
        return 0;
      }
      case "migrate-check": {
        const r = await store.migrateCheck();
        console.log(JSON.stringify({ ...r, requiredVersion: FLEET_PG_SCHEMA_VERSION, rolledBack: true }));
        return r.resultingVersion === FLEET_PG_SCHEMA_VERSION ? 0 : 1;
      }
      case "reconcile": {
        const [key, outcome, sandboxId] = rest;
        if (!key || !["found", "absent", "unknown"].includes(outcome ?? "") || (outcome === "found" && !sandboxId)) {
          throw new Error("usage: reconcile <provisioningKey> found <sandboxId> | absent | unknown");
        }
        console.log(JSON.stringify(await store.reconcileProvisioning(key, outcome as "found" | "absent" | "unknown", sandboxId ?? null, actor)));
        return 0;
      }
      case "reconcile-provisioning": {
        const pending = await store.listUncertainProvisioning();
        const conway = operatorConway(e);
        const out: Array<Record<string, unknown>> = [];
        for (const p of pending) {
          const key = String(p.provisioning_key);
          const name = String(p.sandbox_name ?? "");
          if (!conway || !name) {
            out.push({ provisioningKey: key, sandboxName: name || null, agentStatus: p.agent_status, action: "listed (set CONWAY_API_KEY to look it up)" });
            continue;
          }
          const found = await findSandboxByName(conway, name);
          const outcome = found === "unknown" ? "unknown" : found ? "found" : "absent";
          const r = await store
            .reconcileProvisioning(key, outcome, found && found !== "unknown" ? found.id : null, actor)
            .catch((err: Error) => ({ ok: false, reason: err.message }));
          out.push({ provisioningKey: key, sandboxName: name, outcome, result: r });
        }
        console.log(JSON.stringify(out, null, 2));
        return 0;
      }
      case "dry-run-child": {
        const root = argValue(rest, "--root");
        const apiUrl = argValue(rest, "--api-url") ?? (e.FLEET_PUBLIC_URL?.trim() || "");
        if (!root || !apiUrl) throw new Error("usage: dry-run-child --root <agentId> --api-url https://<controller> [--confirm-real-sandbox]");
        const deps = {
          admin: store,
          env: e,
          rootAgentId: root,
          apiUrl,
          name: argValue(rest, "--name"),
          log: (step: string, d?: Record<string, unknown>) => console.error(redactText(`[dry-run] ${step}`) + (d ? ` ${JSON.stringify(redactDetail(d))}` : "")),
        };
        if (!rest.includes("--confirm-real-sandbox")) {
          const pre = await dryRunPreflight(deps);
          console.log(JSON.stringify({ mode: "preflight-only (add --confirm-real-sandbox to create ONE real sandbox)", ...pre }, null, 2));
          return pre.ok ? 0 : 1;
        }
        const conway = operatorConway(e);
        if (!conway) throw new Error("CONWAY_API_KEY is required for the real dry run (it creates one remote sandbox).");
        const report = await performDryRunChild({ ...deps, conway });
        console.log(JSON.stringify(report, null, 2));
        return report.ok ? 0 : 1;
      }
      case "migrate": {
        const applied = await store.migrate();
        console.log(applied.length ? `Applied migrations: ${applied.join(", ")}` : "Schema up to date.");
        console.log(JSON.stringify(await store.health()));
        return 0;
      }
      case "health": {
        const h = await store.health();
        console.log(JSON.stringify(h));
        return h.ok ? 0 : 1;
      }
      case "status": {
        console.log(JSON.stringify({ state: await store.getState(), agents: await store.listAgents() }, null, 2));
        return 0;
      }
      case "set-cap": {
        await store.setMaxAgents(Number(rest[0]), actor);
        console.log(JSON.stringify(await store.getState()));
        return 0;
      }
      case "set-mode": {
        const mode = rest[0]?.toUpperCase();
        if (!isFleetState(mode)) throw new Error("mode must be DEVELOPMENT|EXPANSION|HARVEST|EMERGENCY");
        await store.setOperatingMode(mode, actor, rest.slice(1).join(" ") || "operator");
        console.log(JSON.stringify(await store.getState()));
        return 0;
      }
      case "approve-runtime": {
        const v = validateRuntimePin(e.FLEET_RUNTIME_REPO, e.FLEET_RUNTIME_COMMIT);
        if (!v.ok) throw new Error(v.reason);
        const build = loadRuntimeBuild(e);
        if (!build) {
          throw new Error(
            "FLEET_RUNTIME_BUILD_ID and FLEET_RUNTIME_LOCKFILE_SHA256 are required (scripts/fleet-build-runtime.sh prints them).",
          );
        }
        await store.setApprovedRuntime(v.pin, actor, build);
        console.log(JSON.stringify(await store.getState()));
        return 0;
      }
      case "set-replication": {
        const on = rest[0] === "on" ? true : rest[0] === "off" ? false : null;
        if (on === null) throw new Error("usage: set-replication on|off");
        await store.setReplicationEnabled(on, actor);
        console.log(JSON.stringify(await store.getState()));
        return 0;
      }
      case "set-timeouts": {
        const keys: Record<string, "reservationTtlS" | "provisioningTtlS" | "heartbeatUnresponsiveS" | "heartbeatDeadS" | "parentReportQuietS"> = {
          reservation: "reservationTtlS",
          provisioning: "provisioningTtlS",
          unresponsive: "heartbeatUnresponsiveS",
          dead: "heartbeatDeadS",
          "parent-quiet": "parentReportQuietS",
        };
        const t: Record<string, number> = {};
        for (const kv of rest) {
          const [k, v] = kv.split("=");
          if (!keys[k] || !/^\d+$/.test(v ?? "")) throw new Error(`bad timeout ${kv}`);
          t[keys[k]] = Number(v);
        }
        console.log(JSON.stringify(await store.setTimeouts(t, actor)));
        return 0;
      }
      case "enroll-root": {
        const [wallet, name, out] = rest;
        if (!wallet || !name) throw new Error("usage: enroll-root <wallet> <name> [credentialFile]");
        const reg = await store.registerRoot({ walletAddress: wallet, name });
        if (!reg.ok) throw new Error(`${reg.code}: ${reg.reason}`);
        const cred = await store.issueCredential(reg.agent.agentId, actor);
        const file = path.resolve(out ?? DEFAULT_CREDENTIAL_FILE);
        writeCredentialFile(file, cred, e.FLEET_API_URL?.trim() || null);
        console.log(JSON.stringify({ agentId: reg.agent.agentId, created: reg.created, credentialFile: file }));
        return 0;
      }
      case "enroll-witness-root": {
        const [name, out] = rest;
        if (!name || !out) throw new Error("usage: enroll-witness-root <name> <credentialFile>");
        const r = await enrollWitnessRoot(store, { name, credentialFile: out, apiUrl: e.FLEET_API_URL?.trim() || "http://127.0.0.1:8787", actor });
        console.log(JSON.stringify(r));
        return 0;
      }
      case "rotate-credential": {
        const [agentId, out] = rest;
        if (!agentId) throw new Error("usage: rotate-credential <agentId> [credentialFile]");
        const cred = await store.issueCredential(agentId, actor);
        const file = path.resolve(out ?? DEFAULT_CREDENTIAL_FILE);
        writeCredentialFile(file, cred, e.FLEET_API_URL?.trim() || null);
        console.log(JSON.stringify({ agentId, credentialFile: file }));
        return 0;
      }
      case "grant-agent-role": {
        await store.grantAgentRole(rest[0] || store.agentRole);
        console.log(`granted restricted agent API to ${rest[0] || store.agentRole}`);
        return 0;
      }
      case "grant-service-role": {
        await store.grantServiceRole(rest[0] || store.serviceRole);
        console.log(`granted controller API to ${rest[0] || store.serviceRole}`);
        return 0;
      }
      case "grant-operator-role": {
        await store.grantOperatorRole(rest[0] || store.operatorRole);
        console.log(`granted the read-only Operator API to ${rest[0] || store.operatorRole}`);
        return 0;
      }
      case "audit-privileges": {
        const r = await store.auditPrivileges();
        console.log(JSON.stringify(r, null, 2));
        if (!r.ok) console.error(`FAIL: ${r.problems.length} privilege problem(s):\n  - ${r.problems.join("\n  - ")}`);
        else if (r.operatorRoles === "not_provisioned") console.error("PASS: agent and service roles are least-privilege; operator roles: not provisioned (Operator API database roles absent; no privileges).");
        else console.error("PASS: agent, service and operator roles are least-privilege.");
        return r.ok ? 0 : 1;
      }
      case "terminations": {
        console.log(JSON.stringify(await store.listTerminations(), null, 2));
        return 0;
      }
      case "reap": {
        console.log(JSON.stringify(await store.reap(actor)));
        return 0;
      }
      case "reservations": {
        console.log(JSON.stringify(await store.listReservations({ open: rest[0] !== "all" }), null, 2));
        return 0;
      }
      case "clear-runtime": {
        await store.setApprovedRuntime(null, actor);
        console.log(JSON.stringify(await store.getState()));
        return 0;
      }
      case "release": {
        console.log((await store.releaseReservation(rest[0], rest.slice(1).join(" ") || "operator release", actor)) ? "released" : "not releasable");
        return 0;
      }
      case "mark-dead": {
        console.log((await store.markDead(rest[0], rest.slice(1).join(" ") || "operator", actor)) ? "marked dead" : "not living");
        return 0;
      }
      default:
        console.error(
          "usage: fleet:admin migrate|health|status|set-cap N|set-mode MODE|approve-runtime|clear-runtime|build-identity DIR|" +
            "set-replication on|off|set-timeouts k=S…|enroll-root WALLET NAME|rotate-credential ID|grant-agent-role|grant-service-role|" +
            "audit-privileges|doctor|terminations|reap|reservations|release ID|mark-dead ID|audit-scan FILE…|" +
            "grant-operator-role|operator-enroll|operator-add-key|operator-revoke-key|operator-revoke|operator-revoke-all|operator-api|operator-list|operator-archive",
        );
        return 2;
    }
  } catch (err) {
    console.error(redactText(err instanceof Error ? err.message : String(err)));
    return 1;
  } finally {
    await store.close();
  }
}

if (process.argv[1] && /fleet[\\/]postgres[\\/]cli\.(ts|js)$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
```

## `src/fleet/postgres/privileges.ts`

sha256 `563e3b3176ad5b225058c327226f6faa53125398e208bff01125a9e2f5d9610b` · 20050 bytes · 376 lines

```ts
/**
 * Effective database privilege audit (Phase 4)
 *
 * Checks what the restricted roles can ACTUALLY do (has_*_privilege, so
 * inherited and column-level grants count), not what we believe we granted.
 * Used by `pnpm fleet:audit-privileges`, `pnpm fleet:doctor` and the fleet
 * service at startup; any problem fails the command / refuses startup.
 *
 *   agent roles    USAGE on the schema + EXECUTE on api_* only
 *   service roles  USAGE + SELECT on SERVICE_READ_TABLES + EXECUTE on svc_* only
 *   both           not superuser/createrole/createdb/replication/bypassrls, own
 *                  nothing, no CREATE/TEMP, not members of the owner or of
 *                  each other
 *   PUBLIC         nothing in the schema
 *   operator roles (schema v8) USAGE + EXECUTE on op_* only, no table privilege,
 *                  every function STABLE except op_begin_request
 *
 * Operator surface (schema v8, signature-termination invariant): op_begin_request
 * writes only the operator bookkeeping tables (+ denial events via fleet_event),
 * no read-side operator function calls a volatile function, and routes point
 * only at the read functions. See migrations-phase8.ts.
 */

import {
  AGENT_API_FUNCTIONS,
  OPERATOR_API_FUNCTIONS,
  OPERATOR_BOOKKEEPING_TABLES,
  OPERATOR_READ_FUNCTIONS,
  OPERATOR_VOLATILE_FUNCTIONS,
  SERVICE_API_FUNCTIONS,
  SERVICE_READ_TABLES,
} from "./migrations.js";

export interface Queryable {
  query<R = any>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface PrivilegeAuditOptions {
  schema?: string;
  agentRoles?: string[];
  serviceRoles?: string[];
  /** Schema v8 read-only Operator API roles (default fleet_operator + fleet_operator_login). */
  operatorRoles?: string[];
  /**
   * Require the operator roles to exist (the Operator API's own self-check).
   * Otherwise, when NONE of them exists, the Operator API is simply not
   * provisioned: a role that does not exist holds no privilege, so this is
   * not a problem. As soon as any one exists, all must exist and pass every
   * operator check.
   */
  requireOperatorRoles?: boolean;
}

/** "provisioned": every operator role exists; "not_provisioned": none exists (and not required); "incomplete": some are missing. */
export type OperatorRoleState = "provisioned" | "not_provisioned" | "incomplete";

export interface PrivilegeAuditResult {
  ok: boolean;
  schema: string;
  owner: string | null;
  database: string;
  problems: string[];
  roles: Array<{ role: string; kind: RoleKind; exists: boolean; functions: string[]; tables: string[] }>;
  operatorRoles: OperatorRoleState;
}

export const DEFAULT_AGENT_ROLES = ["fleet_agent", "fleet_agent_login"];
export const DEFAULT_SERVICE_ROLES = ["fleet_service", "fleet_service_login"];
export const DEFAULT_OPERATOR_ROLES = ["fleet_operator", "fleet_operator_login"];

type RoleKind = "agent" | "service" | "operator";

const TABLE_PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

/** "fleet.api_whoami(text, text)" / "api_whoami(text,text)" -> "api_whoami(text,text)". */
function normSig(sig: string): string {
  return sig.replace(/^.*?\.(?=[a-z_][a-z0-9_]*\()/i, "").replace(/"/g, "").replace(/\s+/g, "");
}

export async function auditPrivileges(db: Queryable, opts: PrivilegeAuditOptions = {}): Promise<PrivilegeAuditResult> {
  const schema = opts.schema ?? "fleet";
  const problems: string[] = [];
  const head = await db.query<{ db: string; owner: string | null }>(
    `SELECT current_database() AS db, (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = $1) AS owner`,
    [schema],
  );
  const { db: database, owner } = head.rows[0];
  if (!owner) problems.push(`schema ${schema} does not exist (run fleet:migrate)`);

  const roles: PrivilegeAuditResult["roles"] = [];
  const configuredOperatorRoles = opts.operatorRoles ?? DEFAULT_OPERATOR_ROLES;
  const presentOperator = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ANY($1)`, [configuredOperatorRoles]);
  const operatorPresent = presentOperator.rows[0].n;
  const operatorState: OperatorRoleState =
    operatorPresent === configuredOperatorRoles.length ? "provisioned" : operatorPresent === 0 && !opts.requireOperatorRoles ? "not_provisioned" : "incomplete";
  const operatorRoles = operatorState === "not_provisioned" ? [] : configuredOperatorRoles;
  if (operatorState === "not_provisioned") {
    for (const r of configuredOperatorRoles) roles.push({ role: r, kind: "operator", exists: false, functions: [], tables: [] });
  }
  const allRestricted = [...(opts.agentRoles ?? DEFAULT_AGENT_ROLES), ...(opts.serviceRoles ?? DEFAULT_SERVICE_ROLES), ...operatorRoles];
  const plan: Array<[string, RoleKind]> = [
    ...(opts.agentRoles ?? DEFAULT_AGENT_ROLES).map((r) => [r, "agent"] as [string, RoleKind]),
    ...(opts.serviceRoles ?? DEFAULT_SERVICE_ROLES).map((r) => [r, "service"] as [string, RoleKind]),
    ...operatorRoles.map((r) => [r, "operator"] as [string, RoleKind]),
  ];

  const agentFns = new Set(AGENT_API_FUNCTIONS.map(normSig));
  const serviceFns = new Set(SERVICE_API_FUNCTIONS.map(normSig));
  const operatorFns = new Set(OPERATOR_API_FUNCTIONS.map(normSig));
  const operatorVolatile = new Set(OPERATOR_VOLATILE_FUNCTIONS.map(normSig));
  const serviceTables = new Set(SERVICE_READ_TABLES);

  for (const [role, kind] of plan) {
    const r = await db.query<{ su: boolean; cr: boolean; cd: boolean; repl: boolean; bypass: boolean }>(
      `SELECT rolsuper AS su, rolcreaterole AS cr, rolcreatedb AS cd, rolreplication AS repl, rolbypassrls AS bypass
         FROM pg_roles WHERE rolname = $1`,
      [role],
    );
    if (!r.rows[0]) {
      problems.push(`role ${role} does not exist (run scripts/fleet-db-roles.sql)`);
      roles.push({ role, kind, exists: false, functions: [], tables: [] });
      continue;
    }
    const a = r.rows[0];
    if (a.su) problems.push(`${role} is a superuser`);
    if (a.cr) problems.push(`${role} can create roles`);
    if (a.cd) problems.push(`${role} can create databases`);
    if (a.repl) problems.push(`${role} has REPLICATION`);
    if (a.bypass) problems.push(`${role} bypasses row-level security`);

    // Membership: never in the owner role, never in another restricted role
    // (other than its own group: *_login -> its NOLOGIN group).
    const group = role.replace(/_login$/, "");
    const members = await db.query<{ r: string }>(
      `SELECT rolname AS r FROM pg_roles WHERE rolname <> $1 AND pg_has_role($1, oid, 'MEMBER')`,
      [role],
    );
    for (const m of members.rows) {
      if (m.r === owner) problems.push(`${role} is a member of the schema owner ${owner}`);
      else if (allRestricted.includes(m.r) && m.r !== group) problems.push(`${role} is a member of ${m.r}`);
      else if (/^pg_(write_all_data|read_all_data|database_owner|execute_server_program|read_server_files|write_server_files)$/.test(m.r)) {
        problems.push(`${role} is a member of ${m.r}`);
      }
    }

    const owns = await db.query<{ n: string }>(
      `SELECT 'schema ' || nspname AS n FROM pg_namespace WHERE nspowner = (SELECT oid FROM pg_roles WHERE rolname = $1)
       UNION ALL
       SELECT 'relation ' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $2 AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = $1)
       UNION ALL
       SELECT 'function ' || p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $2 AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = $1)`,
      [role, schema],
    );
    for (const o of owns.rows) problems.push(`${role} owns ${o.n}`);

    const dbp = await db.query<{ c: boolean; t: boolean }>(
      `SELECT has_database_privilege($1, current_database(), 'CREATE') AS c,
              has_database_privilege($1, current_database(), 'TEMPORARY') AS t`,
      [role],
    );
    if (dbp.rows[0].c) problems.push(`${role} can CREATE in database ${database}`);
    if (dbp.rows[0].t) problems.push(`${role} can create TEMPORARY objects in ${database}`);

    if (owner) {
      const sp = await db.query<{ c: boolean; pc: boolean }>(
        `SELECT has_schema_privilege($1, $2, 'CREATE') AS c, has_schema_privilege($1, 'public', 'CREATE') AS pc`,
        [role, schema],
      );
      if (sp.rows[0].c) problems.push(`${role} can CREATE in schema ${schema}`);
      if (sp.rows[0].pc) problems.push(`${role} can CREATE in schema public`);
    }

    const tables = await db.query<{ t: string; p: string }>(
      `SELECT c.relname AS t, p.priv AS p
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN unnest($3::text[]) AS p(priv)
        WHERE n.nspname = $2 AND c.relkind IN ('r','v','m','p','f','S')
          AND (CASE WHEN c.relkind = 'S' THEN p.priv IN ('SELECT','UPDATE') AND has_sequence_privilege($1, c.oid,
                      CASE WHEN p.priv = 'SELECT' THEN 'SELECT' ELSE 'UPDATE' END)
                    WHEN p.priv IN ('SELECT','INSERT','UPDATE','REFERENCES')
                      THEN has_table_privilege($1, c.oid, p.priv) OR has_any_column_privilege($1, c.oid, p.priv)
                    ELSE has_table_privilege($1, c.oid, p.priv) END)
        ORDER BY 1, 2`,
      [role, schema, TABLE_PRIVS],
    );
    const readable: string[] = [];
    for (const t of tables.rows) {
      if (kind === "service" && t.p === "SELECT" && serviceTables.has(t.t)) {
        readable.push(t.t);
        continue;
      }
      problems.push(`${role} has ${t.p} on ${schema}.${t.t}`);
    }

    const fns = await db.query<{ sig: string; secdef: boolean; cfg: string[] | null; vol: string }>(
      `SELECT p.oid::regprocedure::text AS sig, p.prosecdef AS secdef, p.proconfig AS cfg, p.provolatile AS vol
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $2 AND has_function_privilege($1, p.oid, 'EXECUTE')
        ORDER BY 1`,
      [role, schema],
    );
    const allowed = kind === "agent" ? agentFns : kind === "service" ? serviceFns : operatorFns;
    const executable: string[] = [];
    for (const f of fns.rows) {
      const sig = normSig(f.sig);
      if (!allowed.has(sig)) {
        problems.push(`${role} can EXECUTE ${schema}.${sig}`);
        continue;
      }
      executable.push(sig);
      if (!f.secdef) problems.push(`${schema}.${sig} is not SECURITY DEFINER`);
      if (!(f.cfg ?? []).some((c) => c.startsWith("search_path="))) problems.push(`${schema}.${sig} does not pin search_path`);
      if (kind === "operator" && !operatorVolatile.has(sig) && f.vol !== "s" && f.vol !== "i") {
        problems.push(`${role}: ${schema}.${sig} is not STABLE (operator read functions must not be able to write)`);
      }
    }
    roles.push({ role, kind, exists: true, functions: executable, tables: readable });
  }

  // PUBLIC must have nothing in the fleet schema and no CREATE/TEMP on the database.
  if (owner) {
    const pub = await db.query<{ what: string }>(
      `SELECT 'EXECUTE ' || p.oid::regprocedure::text AS what
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1 AND has_function_privilege('public', p.oid, 'EXECUTE')
       UNION ALL
       SELECT 'SELECT/INSERT/UPDATE/DELETE on ' || c.relname
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r','v','m','p','f')
          AND (has_table_privilege('public', c.oid, 'SELECT') OR has_table_privilege('public', c.oid, 'INSERT')
               OR has_table_privilege('public', c.oid, 'UPDATE') OR has_table_privilege('public', c.oid, 'DELETE'))
       UNION ALL
       SELECT 'USAGE/CREATE on schema ' || $1 WHERE has_schema_privilege('public', $1, 'USAGE') OR has_schema_privilege('public', $1, 'CREATE')`,
      [schema],
    );
    for (const p of pub.rows) problems.push(`PUBLIC has ${p.what}`);
  }
  const pubDb = await db.query<{ c: boolean; t: boolean }>(
    `SELECT has_database_privilege('public', current_database(), 'CREATE') AS c,
            has_database_privilege('public', current_database(), 'TEMPORARY') AS t`,
  );
  if (pubDb.rows[0].c) problems.push(`PUBLIC can CREATE in database ${database}`);
  if (pubDb.rows[0].t) problems.push(`PUBLIC can create TEMPORARY objects in ${database}`);

  if (owner) problems.push(...(await operatorSurfaceProblems(db, schema)));

  return { ok: problems.length === 0, schema, owner, database, problems, roles, operatorRoles: operatorState };
}

/** A PL/pgSQL/SQL body without comments or string literals (so quotes inside literals don't count). */
function codeOf(src: string): string {
  return src
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");
}

/** INSERT/UPDATE/DELETE/MERGE/TRUNCATE/COPY targets in a body (comments and literals stripped; quoted names unquoted). */
export function writeTargets(src: string): string[] {
  const body = codeOf(src);
  const out = new Set<string>();
  const re = /(?<!\b(?:FOR|DO|KEY)\s+)\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE(?:\s+TABLE)?|COPY)\s+(?:ONLY\s+)?((?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*))?)/gi;
  for (const m of body.matchAll(re)) {
    const last = m[1].split(".").pop()!.trim().replace(/^"|"$/g, "");
    out.add(last.toLowerCase());
  }
  return [...out].sort();
}

/** Built-in functions with side effects outside the statement's own rows; never needed by the read surface. */
const SIDE_EFFECT_BUILTINS = /^(nextval|setval|set_config|pg_notify|pg_advisory_\w+|pg_try_advisory_\w+|lo_\w+|dblink\w*|pg_terminate_backend|pg_cancel_backend|pg_sleep\w*|pg_reload_conf|pg_rotate_logfile|pg_file_\w+|pg_read_\w*file|pg_ls_\w+|pg_stat_reset\w*|pg_switch_wal|pg_create_\w+|pg_drop_replication_slot|pg_logical_emit_message|txid_current|pg_current_xact_id)$/;

/** Read helpers the op_* read functions may call (each is checked the same way). */
const OPERATOR_READ_HELPERS = ["fleet_operator_request_ok", "fleet_operator_agent_json"];

/**
 * Schema v8 signature-termination invariant, checked against the live
 * catalog (only when the operator schema exists). Static checks; the
 * runtime control is that the Operator API runs every read in a READ ONLY
 * transaction (gateway.ts).
 *  - no operator-surface body uses dynamic SQL (EXECUTE) or quoted
 *    identifiers (which could hide names from these checks);
 *  - op_begin_request writes only OPERATOR_BOOKKEEPING_TABLES and calls no
 *    volatile fleet function other than fleet_event;
 *  - read-side functions are non-volatile, contain no write statement, call
 *    no fleet function outside the read helpers, no function from another
 *    user schema and no side-effecting built-in;
 *  - no unexpected op_* function exists; every route points at a read function.
 */
export async function operatorSurfaceProblems(db: Queryable, schema: string): Promise<string[]> {
  const problems: string[] = [];
  const present = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = 'fleet_operator_routes'`,
    [schema],
  );
  if (!present.rows[0]?.n) return problems;
  const fns = await db.query<{ name: string; sig: string; vol: string; src: string }>(
    `SELECT p.proname AS name, p.oid::regprocedure::text AS sig, p.provolatile AS vol, p.prosrc AS src
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1`,
    [schema],
  );
  const foreign = await db.query<{ name: string }>(
    `SELECT DISTINCT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ($1, 'pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\_%'`,
    [schema],
  );
  const fleetNames = new Set(fns.rows.map((f) => f.name));
  const foreignNames = new Set(foreign.rows.map((f) => f.name));
  const volatileNames = new Set(fns.rows.filter((f) => f.vol === "v").map((f) => f.name));
  const opNames = new Set(OPERATOR_API_FUNCTIONS.map((f) => f.replace(/\(.*$/, "")));
  const readSide = new Set([...opNames, ...OPERATOR_READ_HELPERS]);
  readSide.delete("op_begin_request");
  const allowedWrites = new Set(OPERATOR_BOOKKEEPING_TABLES);
  const callsOf = (src: string) => new Set([...codeOf(src).matchAll(/\b([a-z_][a-z0-9_$]*)\s*\(/gi)].map((m) => m[1].toLowerCase()));
  const hygiene = (name: string, src: string) => {
    const code = codeOf(src);
    if (/\bEXECUTE\b/i.test(code)) problems.push(`operator surface: ${name} uses dynamic SQL (EXECUTE)`);
    if (code.includes('"')) problems.push(`operator surface: ${name} uses a quoted identifier`);
    for (const c of callsOf(src)) {
      if (SIDE_EFFECT_BUILTINS.test(c)) problems.push(`operator surface: ${name} calls side-effecting ${c}`);
      if (foreignNames.has(c) && !fleetNames.has(c)) problems.push(`operator surface: ${name} calls ${c} from another schema`);
    }
  };
  for (const f of fns.rows) {
    if (f.name === "op_begin_request") {
      hygiene(f.name, f.src);
      for (const t of writeTargets(f.src)) {
        if (!allowedWrites.has(t)) problems.push(`operator surface: op_begin_request writes ${t} (only operator bookkeeping is allowed)`);
      }
      for (const c of callsOf(f.src)) {
        if (volatileNames.has(c) && c !== "fleet_event" && c !== "op_begin_request") {
          problems.push(`operator surface: op_begin_request calls volatile ${c}`);
        }
      }
      continue;
    }
    if (f.name.startsWith("op_") && !opNames.has(f.name)) problems.push(`operator surface: unexpected function ${schema}.${normSig(f.sig)}`);
    if (!readSide.has(f.name)) continue;
    hygiene(f.name, f.src);
    if (f.vol === "v") problems.push(`operator surface: ${f.name} is volatile`);
    if (writeTargets(f.src).length) problems.push(`operator surface: ${f.name} contains a write statement`);
    for (const c of callsOf(f.src)) {
      if (volatileNames.has(c)) problems.push(`operator surface: ${f.name} references volatile ${c}`);
      else if (fleetNames.has(c) && c !== f.name && !readSide.has(c)) problems.push(`operator surface: ${f.name} calls ${c}, which is not an operator read helper`);
    }
  }
  // Route contents need SELECT (owner/admin). A restricted auditor (the fleet service's startup
  // self-check) skips this part; the fleet_operator_routes CHECK still confines fn to the read functions.
  const canRead = await db.query<{ ok: boolean }>(
    `SELECT has_table_privilege(current_user, $1, 'SELECT') AS ok`,
    [`${schemaIdent(schema)}.fleet_operator_routes`],
  );
  if (!canRead.rows[0]?.ok) return [...new Set(problems)];
  const routes = await db.query<{ route: string; fn: string }>(`SELECT route, fn FROM ${schemaIdent(schema)}.fleet_operator_routes ORDER BY route`);
  const readFns = new Set(OPERATOR_READ_FUNCTIONS);
  for (const r of routes.rows) {
    if (!readFns.has(r.fn)) problems.push(`operator surface: route ${r.route} maps to non-read function ${r.fn}`);
    const f = fns.rows.find((x) => x.name === r.fn);
    if (!f) problems.push(`operator surface: route ${r.route} maps to missing function ${r.fn}`);
    else if (f.vol === "v") problems.push(`operator surface: route ${r.route} maps to volatile ${r.fn}`);
  }
  return [...new Set(problems)];
}

function schemaIdent(schema: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`Invalid fleet schema name: ${schema}`);
  return `"${schema}"`;
}

/** Problems that concern only the given roles (plus PUBLIC); used by the service's startup self-check. */
export function problemsFor(result: PrivilegeAuditResult, roles: string[]): string[] {
  return result.problems.filter((p) => p.startsWith("PUBLIC") || roles.some((r) => p.startsWith(`${r} `) || p.startsWith(`role ${r} `)) || p.includes(" is not SECURITY DEFINER") || p.includes(" does not pin search_path"));
}
```

## `src/fleet/postgres/store.ts`

sha256 `ecd883a9387300896cedf4e6242df47630005aa529ca52656486b2541a1657ea` · 72360 bytes · 1653 lines

```ts
/**
 * Shared Fleet Registry — PostgreSQL store
 *
 * The authoritative, fleet-wide record of agents and allocator of slots.
 * Every agent process (root and children, in any sandbox) talks to the same
 * database, so the living-agent cap is global rather than per-sandbox.
 *
 * Locking strategy
 *   - Every slot-affecting transaction first runs
 *       SELECT … FROM fleet_state WHERE id = 1 FOR UPDATE
 *     The single fleet_state row is a fleet-wide mutex: concurrent
 *     reservations from any number of processes/hosts serialise on it, and
 *     each one reads the counters only after the previous one committed.
 *   - fleet_agents triggers maintain living_agents / reserved_slots and raise
 *     FLEET_CAP_EXCEEDED if a row entering the living/reserved population
 *     would exceed max_agents. The trigger updates the same row, so raw SQL
 *     that bypasses this class is serialised and capped too.
 *   - State transitions are conditional UPDATEs (… WHERE status = 'x'),
 *     so claim / activate / release / death each happen at most once.
 *   - lock_timeout and statement_timeout bound every wait; a timeout is a
 *     failure, and failures deny replication (fail closed).
 */

import crypto from "crypto";
import pg from "pg";
import type { Pool, PoolClient } from "pg";
import { ulid } from "ulid";
import { isFleetState } from "../config.js";
import { createBoundGrant, type ClaimedGrant } from "../grants.js";
import { FleetBypassError } from "../registry.js";
import { redactDetail, redactText } from "../redact.js";
import { FleetRuntimeError, normalizeRepoUrl, type RuntimePin } from "../runtime.js";
import {
  checkAttestation,
  newAttestationNonce,
  sanitizeAttestation,
  type RuntimeAttestation,
  type RuntimeBuild,
} from "../attestation.js";
import type {
  ActivationResult,
  FleetCapabilityScope,
  FleetCredential,
  FleetDecisionCode,
  FleetHealth,
  FleetSpawnGrant,
  FleetState,
  ReapResult,
  ReservationLease,
  ReservationLeaseStatus,
  SharedAgentRecord,
  SharedAgentStatus,
  SharedFleetState,
} from "../types.js";
import { migrateCheck,
  AGENT_API_FUNCTIONS,
  FLEET_PG_HARD_MAX_AGENTS,
  FLEET_PG_SCHEMA_VERSION,
  OPERATOR_API_FUNCTIONS,
  SERVICE_API_FUNCTIONS,
  SERVICE_READ_TABLES,
  migrate,
  quoteIdent,
} from "./migrations.js";
import { agentFromJson } from "./agent-gateway.js";
import { auditPrivileges, type PrivilegeAuditOptions, type PrivilegeAuditResult } from "./privileges.js";

export const DEFAULT_FLEET_PG_SCHEMA = "fleet";
/** Default lease TTLs live in fleet_state (reservation_ttl_s = 30 min, provisioning_ttl_s = 45 min). */
export const DEFAULT_RESERVATION_TTL_MS = 30 * 60_000;
export const DEFAULT_AGENT_ROLE = "fleet_agent";
export const DEFAULT_SERVICE_ROLE = "fleet_service";
/** Schema v8: read-only Operator API role (granted op_* only). */
export const DEFAULT_OPERATOR_ROLE = "fleet_operator";

export interface FleetTimeouts {
  reservationTtlS: number;
  provisioningTtlS: number;
  heartbeatUnresponsiveS: number;
  heartbeatDeadS: number;
  parentReportQuietS: number;
}

export interface SandboxTerminationRecord {
  agentId: string;
  sandboxId: string;
  status: "pending" | "terminated" | "unsupported" | "failed";
  requestedAt: string;
  attempts: number;
  lastError: string | null;
}

/** Bearer token format: fa1.<agentId>.<43 chars base64url>. */
const TOKEN_RE = /^fa1\.([0-9A-HJKMNP-TV-Z]{26})\.[A-Za-z0-9_-]{43}$/;

export function mintAgentToken(agentId: string): string {
  return `fa1.${agentId}.${crypto.randomBytes(32).toString("base64url")}`;
}

export function hashAgentToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/** Agent id embedded in a well-formed token, else null. */
export function agentIdFromToken(token: string): string | null {
  return TOKEN_RE.exec(token)?.[1] ?? null;
}

/** Short-lived session token format (Phase 5): fs1.<agentId>.<43 chars base64url>. */
const SESSION_RE = /^fs1\.([0-9A-HJKMNP-TV-Z]{26})\.[A-Za-z0-9_-]{43}$/;

export function mintSessionToken(agentId: string): string {
  return `fs1.${agentId}.${crypto.randomBytes(32).toString("base64url")}`;
}

export function agentIdFromSessionToken(token: string): string | null {
  return SESSION_RE.exec(token)?.[1] ?? null;
}

/** Canary commands a healthy agent's policy guard must refuse (health challenge). */
export const HEALTH_CANARIES: readonly string[] = Object.freeze([
  "cat /etc/automaton-fleet/service.env",
  "cat ~/.automaton/fleet-credentials.json",
  "psql -c 'GRANT fleet_service TO fleet_agent_login'",
  "cat /proc/1/environ",
  "sudo scripts/fleet-db-setup.sh --apply",
]);

export interface LifecyclePolicy {
  healthChallengeIntervalS: number;
  challengeTtlS: number;
  healthGraceS: number;
  maxChallengeFailures: number;
  terminationGraceS: number;
  orphanSlotHoldS: number;
  maxOpenOrphans: number;
  sessionTtlS: number;
}

/** Phase 6: the durable record of an intended (possibly created) sandbox. */
export interface SandboxIntent {
  provisioningKey: string;
  /** Deterministic sandbox name: fleet-<lower(provisioningKey)>. */
  sandboxName: string;
  /** Set when the controller already knows the sandbox: reuse it, never create another. */
  sandboxId: string | null;
  /** Create attempts recorded so far, including this one. */
  attempts: number;
}

export interface HealthChallenge {
  challengeId: string;
  nonce: string;
  canary: string;
  expiresAt: string;
}

export class FleetRegistryUnavailableError extends Error {
  readonly code = "FLEET_REGISTRY_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "FleetRegistryUnavailableError";
  }
}

export class FleetDuplicateRegistrationError extends Error {
  readonly code = "FLEET_DUPLICATE_REGISTRATION";
  constructor(message: string) {
    super(message);
    this.name = "FleetDuplicateRegistrationError";
  }
}

export interface PgFleetStoreOptions {
  connectionString: string;
  schema?: string;
  poolMax?: number;
  connectTimeoutMs?: number;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  /** Override fleet_state.reservation_ttl_s for reservations made by this store (tests). */
  reservationTtlMs?: number;
  /** Override fleet_state.provisioning_ttl_s for claims made by this store (tests). */
  provisioningTtlMs?: number;
  /** Restricted role granted the agent API on migrate (if it exists). */
  agentRole?: string;
  /** Restricted controller role granted the service API on migrate (if it exists). */
  serviceRole?: string;
  /** Read-only Operator API role granted op_* on migrate (if it exists). */
  operatorRole?: string;
  /** application_name reported to PostgreSQL. */
  applicationName?: string;
}

export type SharedReserveResult =
  | { ok: true; grant: FleetSpawnGrant; agent: SharedAgentRecord; lease?: ReservationLease }
  | { ok: false; code: FleetDecisionCode; reason: string; living: number; reserved: number; max: number };

export type RegisterResult =
  | { ok: true; agent: SharedAgentRecord; created: boolean }
  | { ok: false; code: FleetDecisionCode | "FLEET_AGENT_DEAD" | "FLEET_IDENTITY_MISMATCH"; reason: string };

interface AgentRow {
  agent_id: string;
  parent_agent_id: string | null;
  role: "root" | "child";
  generation: number;
  name: string;
  wallet_address: string | null;
  runtime_version: string | null;
  runtime_repo: string | null;
  runtime_commit: string | null;
  sandbox_id: string | null;
  local_child_id: string | null;
  status: SharedAgentStatus;
  status_reason: string | null;
  requested_by: string | null;
  created_at: Date;
  updated_at: Date;
  last_heartbeat: Date | null;
  reservation_expires_at: Date | null;
  death_time: Date | null;
  capability_scope?: FleetCapabilityScope;
}

interface StateRow {
  living_agents: number;
  reserved_slots: number;
  quarantined_slots?: number;
  max_agents: number;
  operating_mode: string;
  runtime_repo: string | null;
  runtime_commit: string | null;
  updated_at: Date;
  replication_enabled: boolean;
  runtime_build_id: string | null;
  runtime_lockfile_sha256: string | null;
  reservation_ttl_s: number;
  provisioning_ttl_s: number;
  heartbeat_unresponsive_s: number;
  heartbeat_dead_s: number;
  parent_report_quiet_s: number;
}

interface LeaseRow {
  reservation_id: string;
  agent_id: string;
  parent_agent_id: string;
  status: ReservationLeaseStatus;
  created_at: Date;
  expires_at: Date;
  claimed_at: Date | null;
  completed_at: Date | null;
  ended_at: Date | null;
  end_reason: string | null;
  expected_repo: string;
  expected_commit: string;
  expected_build_id: string;
  expected_lockfile_sha256: string;
  attestation_nonce: string | null;
  attested_at: Date | null;
}

type ReserveJson =
  | {
      ok: true;
      agentId: string;
      reservationId: string;
      parentAgentId: string;
      generation: number;
      expiresAt: string;
      runtime: { repo: string; commit: string };
      build: { buildId: string; lockfileSha256: string };
    }
  | { ok: false; code: string; reason: string; living: number; reserved: number; max: number };

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function toAgent(r: AgentRow): SharedAgentRecord {
  return {
    agentId: r.agent_id,
    parentAgentId: r.parent_agent_id,
    role: r.role,
    generation: r.generation,
    name: r.name,
    walletAddress: r.wallet_address,
    runtimeVersion: r.runtime_version,
    runtimeRepo: r.runtime_repo,
    runtimeCommit: r.runtime_commit,
    sandboxId: r.sandbox_id,
    localChildId: r.local_child_id,
    status: r.status,
    statusReason: r.status_reason,
    requestedBy: r.requested_by,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    lastHeartbeat: iso(r.last_heartbeat),
    deathTime: iso(r.death_time),
    ...(r.capability_scope ? { capabilityScope: r.capability_scope } : {}),
  };
}

function toState(r: StateRow): SharedFleetState {
  return {
    livingAgents: r.living_agents,
    reservedSlots: r.reserved_slots,
    quarantinedSlots: r.quarantined_slots ?? 0,
    maxAgents: Math.min(r.max_agents, FLEET_PG_HARD_MAX_AGENTS),
    operatingMode: isFleetState(r.operating_mode) ? r.operating_mode : "EMERGENCY",
    runtime: r.runtime_repo && r.runtime_commit ? { repo: r.runtime_repo, commit: r.runtime_commit } : null,
    updatedAt: r.updated_at.toISOString(),
    replicationEnabled: r.replication_enabled === true,
    build: r.runtime_build_id && r.runtime_lockfile_sha256
      ? { buildId: r.runtime_build_id, lockfileSha256: r.runtime_lockfile_sha256 }
      : null,
  };
}

function toLease(r: LeaseRow): ReservationLease {
  return {
    reservationId: r.reservation_id,
    agentId: r.agent_id,
    parentAgentId: r.parent_agent_id,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    claimedAt: iso(r.claimed_at),
    completedAt: iso(r.completed_at),
    endedAt: iso(r.ended_at),
    endReason: r.end_reason,
    expected: {
      repo: r.expected_repo,
      commit: r.expected_commit,
      buildId: r.expected_build_id,
      lockfileSha256: r.expected_lockfile_sha256,
    },
    attestedAt: iso(r.attested_at),
  };
}

function leaseFromReserve(r: Extract<ReserveJson, { ok: true }>): ReservationLease {
  return {
    reservationId: r.reservationId,
    agentId: r.agentId,
    parentAgentId: r.parentAgentId,
    status: "reserved",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(r.expiresAt).toISOString(),
    claimedAt: null,
    completedAt: null,
    endedAt: null,
    endReason: null,
    expected: { ...r.runtime, ...r.build },
    attestedAt: null,
  };
}

/** Database clock (ms) — lease expiry is always judged by the registry's clock. */
async function dbNow(c: PoolClient): Promise<number> {
  const r = await c.query<{ now: Date }>("SELECT now() AS now");
  return r.rows[0].now.getTime();
}

// ─── Secret hygiene for the audit log ────────────────────────────
// Thin wrappers over the canonical redactor (src/fleet/redact.ts), kept for
// existing call sites.

export function scrubText(s: string): string {
  return redactText(s);
}

export function scrubDetail(detail: Record<string, unknown>): Record<string, unknown> {
  return redactDetail(detail);
}

function isConnectionError(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  if (!e) return false;
  if (typeof e.code === "string") {
    // 08xxx connection exceptions, 57P0x shutdown, 53xxx resources, network errnos
    if (/^(08|57P0|53)/.test(e.code)) return true;
    if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH", "EAI_AGAIN", "EPIPE"].includes(e.code)) return true;
    // 55P03 lock_not_available, 57014 query_canceled (statement/lock timeout)
    if (e.code === "55P03" || e.code === "57014") return true;
  }
  return /timeout|Connection terminated|ECONNREFUSED|connection is closed/i.test(e.message ?? "");
}

function pgMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class PgFleetStore {
  readonly kind = "postgres" as const;
  readonly schema: string;
  readonly agentRole: string;
  readonly serviceRole: string;
  readonly operatorRole: string;
  private readonly pool: Pool;
  private readonly reservationTtlMs: number | null;
  private readonly provisioningTtlMs: number | null;
  private schemaChecked = false;
  private closed = false;

  constructor(opts: PgFleetStoreOptions) {
    this.schema = opts.schema ?? DEFAULT_FLEET_PG_SCHEMA;
    quoteIdent(this.schema);
    this.reservationTtlMs = opts.reservationTtlMs ?? null;
    this.provisioningTtlMs = opts.provisioningTtlMs ?? null;
    this.agentRole = opts.agentRole ?? DEFAULT_AGENT_ROLE;
    quoteIdent(this.agentRole);
    this.serviceRole = opts.serviceRole ?? DEFAULT_SERVICE_ROLE;
    quoteIdent(this.serviceRole);
    this.operatorRole = opts.operatorRole ?? DEFAULT_OPERATOR_ROLE;
    quoteIdent(this.operatorRole);
    const lockMs = opts.lockTimeoutMs ?? 5_000;
    const stmtMs = opts.statementTimeoutMs ?? 10_000;
    this.pool = new pg.Pool({
      connectionString: opts.connectionString,
      max: opts.poolMax ?? 4,
      // Also bounds the wait for a pooled client, so it must tolerate bursts.
      connectionTimeoutMillis: opts.connectTimeoutMs ?? 10_000,
      idleTimeoutMillis: 10_000,
      allowExitOnIdle: true,
      application_name: opts.applicationName ?? "automaton-fleet",
      options: `-c search_path=${this.schema} -c lock_timeout=${lockMs} -c statement_timeout=${stmtMs} -c idle_in_transaction_session_timeout=${stmtMs * 3}`,
    });
    // An idle client losing its connection must not crash the agent.
    this.pool.on("error", () => {});
  }

  /**
   * Operator (admin/owner) store from FLEET_ADMIN_DATABASE_URL, or the
   * legacy FLEET_CONTROLLER_DATABASE_URL / DATABASE_URL. Null when
   * unconfigured. Never used by agents or by the fleet service.
   */
  static fromEnv(env: Record<string, string | undefined> = process.env): PgFleetStore | null {
    const url = (env.FLEET_ADMIN_DATABASE_URL || env.FLEET_CONTROLLER_DATABASE_URL || env.DATABASE_URL)?.trim();
    if (!url) return null;
    return new PgFleetStore({
      connectionString: url,
      schema: env.FLEET_PG_SCHEMA?.trim() || undefined,
      agentRole: env.FLEET_AGENT_ROLE?.trim() || undefined,
      serviceRole: env.FLEET_SERVICE_ROLE?.trim() || undefined,
      operatorRole: env.FLEET_OPERATOR_ROLE?.trim() || undefined,
      applicationName: "automaton-fleet-admin",
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end().catch(() => {});
  }

  // ─── Plumbing ──────────────────────────────────────────────────

  private async connect(): Promise<PoolClient> {
    if (this.closed) throw new FleetRegistryUnavailableError("Fleet registry connection is closed.");
    try {
      return await this.pool.connect();
    } catch (err) {
      throw new FleetRegistryUnavailableError(`Fleet registry unreachable: ${pgMessage(err)}`);
    }
  }

  private async ensureSchema(client: PoolClient): Promise<void> {
    if (this.schemaChecked) return;
    let version: number | null = null;
    try {
      const r = await client.query("SELECT max(version) AS v FROM fleet_schema_migrations");
      version = r.rows[0]?.v ?? null;
    } catch (err) {
      throw new FleetRegistryUnavailableError(`Fleet registry schema missing (run fleet:migrate): ${pgMessage(err)}`);
    }
    if (version !== FLEET_PG_SCHEMA_VERSION) {
      throw new FleetRegistryUnavailableError(
        `Fleet registry schema version ${version ?? "none"} != required ${FLEET_PG_SCHEMA_VERSION}.`,
      );
    }
    this.schemaChecked = true;
  }

  /** Run fn in a READ COMMITTED transaction. Connection problems surface as FleetRegistryUnavailableError. */
  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.connect();
    let broken = false;
    try {
      await this.ensureSchema(client);
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        broken = true;
      }
      if (err instanceof FleetRegistryUnavailableError) throw err;
      if (isConnectionError(err)) {
        broken = true;
        throw new FleetRegistryUnavailableError(`Fleet registry transaction failed: ${pgMessage(err)}`);
      }
      throw err;
    } finally {
      client.release(broken);
    }
  }

  private async read<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.connect();
    let broken = false;
    try {
      await this.ensureSchema(client);
      return await fn(client);
    } catch (err) {
      if (err instanceof FleetRegistryUnavailableError) throw err;
      if (isConnectionError(err)) {
        broken = true;
        throw new FleetRegistryUnavailableError(`Fleet registry query failed: ${pgMessage(err)}`);
      }
      throw err;
    } finally {
      client.release(broken);
    }
  }

  private async lockState(c: PoolClient): Promise<StateRow> {
    const r = await c.query<StateRow>("SELECT * FROM fleet_state WHERE id = 1 FOR UPDATE");
    if (r.rowCount !== 1) throw new FleetRegistryUnavailableError("fleet_state row missing (fail closed).");
    return r.rows[0];
  }

  private async event(
    c: PoolClient,
    eventType: string,
    agentId: string | null,
    actor: string | null,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    await c.query("INSERT INTO fleet_events (event_type, agent_id, actor, detail) VALUES ($1, $2, $3, $4)", [
      eventType,
      agentId,
      actor,
      JSON.stringify(scrubDetail(detail)),
    ]);
  }

  // ─── Operator / migrations ─────────────────────────────────────

  /**
   * Operator-only: apply schema migrations, then (re)grant the agent and
   * service APIs to the restricted roles that exist. Requires the privileged
   * admin credential: the connected role must own the schema (or, before the
   * first migration, be able to create it). Restricted credentials are refused.
   */
  async migrate(): Promise<number[]> {
    const client = await this.connect();
    let applied: number[];
    try {
      await this.assertAdminConnection(client);
      applied = await migrate(client, this.schema);
    } finally {
      client.release();
    }
    const roles = await this.pool
      .query<{ rolname: string }>("SELECT rolname FROM pg_roles WHERE rolname = ANY($1)", [[this.agentRole, this.serviceRole, this.operatorRole]])
      .catch(() => null);
    const present = new Set(roles?.rows.map((r) => r.rolname) ?? []);
    if (present.has(this.agentRole)) await this.grantAgentRole(this.agentRole);
    if (present.has(this.serviceRole)) await this.grantServiceRole(this.serviceRole);
    if (present.has(this.operatorRole)) await this.grantOperatorRole(this.operatorRole);
    return applied;
  }

  /** Phase 6: apply pending migrations in one transaction and roll back (verification only). */
  async migrateCheck(): Promise<{ currentVersion: number | null; resultingVersion: number; wouldApply: number[] }> {
    const client = await this.connect();
    try {
      await this.assertAdminConnection(client);
      return await migrateCheck(client, this.schema);
    } finally {
      client.release();
    }
  }

  /** Throws unless the connection holds the privileged admin (schema owner) role. */
  private async assertAdminConnection(c: PoolClient): Promise<void> {
    const r = await c.query<{ u: string; owner: string | null; can_create: boolean }>(
      `SELECT current_user AS u,
              (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = $1) AS owner,
              has_database_privilege(current_database(), 'CREATE') AS can_create`,
      [this.schema],
    );
    const row = r.rows[0];
    const isAdmin = row.owner ? row.owner === row.u : row.can_create;
    if (!isAdmin) {
      throw new Error(
        `Refusing to migrate as ${row.u}: administrative migrations require the privileged admin credential ` +
          `(FLEET_ADMIN_DATABASE_URL; owner of schema ${this.schema}).`,
      );
    }
  }

  // ─── Connection identity / privileges ──────────────────────────

  /** Who this store is connected as, and whether that is the schema owner or a superuser. */
  async connectionIdentity(): Promise<{ user: string; schemaOwner: string | null; isOwner: boolean; superuser: boolean }> {
    const r = await this.pool.query<{ u: string; owner: string | null; su: boolean }>(
      `SELECT current_user AS u, (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = $1) AS owner,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su`,
      [this.schema],
    );
    const row = r.rows[0];
    return { user: row.u, schemaOwner: row.owner, isOwner: row.owner === row.u, superuser: row.su === true };
  }

  /** Effective privilege audit of the restricted roles (see privileges.ts). */
  async auditPrivileges(opts: Omit<PrivilegeAuditOptions, "schema"> = {}): Promise<PrivilegeAuditResult> {
    return auditPrivileges(this.pool, { schema: this.schema, ...opts });
  }

  // ─── Health ────────────────────────────────────────────────────

  async health(): Promise<FleetHealth> {
    const start = Date.now();
    let client: PoolClient;
    try {
      client = await this.connect();
    } catch (err) {
      return { ok: false, latencyMs: null, schemaVersion: null, countersConsistent: null, error: pgMessage(err) };
    }
    let broken = false;
    try {
      await client.query("SELECT 1");
      const v = await client.query("SELECT max(version) AS v FROM fleet_schema_migrations");
      const schemaVersion: number | null = v.rows[0]?.v ?? null;
      if (schemaVersion !== FLEET_PG_SCHEMA_VERSION) {
        return {
          ok: false,
          latencyMs: Date.now() - start,
          schemaVersion,
          countersConsistent: null,
          error: `schema version ${schemaVersion ?? "none"} != ${FLEET_PG_SCHEMA_VERSION}`,
        };
      }
      const c = await client.query(
        `SELECT s.living_agents = (SELECT count(*) FROM fleet_agents WHERE status IN ('active','unresponsive','terminating'))
            AND s.reserved_slots = (SELECT count(*) FROM fleet_agents WHERE status IN ('reserved','provisioning'))
            AND s.quarantined_slots = (SELECT count(*) FROM fleet_agents WHERE status = 'orphaned')
            AS consistent
           FROM fleet_state s WHERE s.id = 1`,
      );
      const countersConsistent = c.rows[0]?.consistent === true;
      return {
        ok: countersConsistent,
        latencyMs: Date.now() - start,
        schemaVersion,
        countersConsistent,
        error: countersConsistent ? undefined : "fleet_state counters disagree with fleet_agents",
      };
    } catch (err) {
      broken = isConnectionError(err);
      return { ok: false, latencyMs: null, schemaVersion: null, countersConsistent: null, error: pgMessage(err) };
    } finally {
      client.release(broken);
    }
  }

  // ─── Shared fleet state ────────────────────────────────────────

  async getState(): Promise<SharedFleetState> {
    return this.read(async (c) => {
      const r = await c.query<StateRow>("SELECT * FROM fleet_state WHERE id = 1");
      if (r.rowCount !== 1) throw new FleetRegistryUnavailableError("fleet_state row missing (fail closed).");
      return toState(r.rows[0]);
    });
  }

  /** Operator-only. */
  async setMaxAgents(max: number, actor: string): Promise<void> {
    if (!Number.isSafeInteger(max) || max < 1 || max > FLEET_PG_HARD_MAX_AGENTS) {
      throw new Error(`Invalid fleet max agents: ${max} (must be 1..${FLEET_PG_HARD_MAX_AGENTS})`);
    }
    await this.tx(async (c) => {
      const prev = await this.lockState(c);
      await c.query("UPDATE fleet_state SET max_agents = $1, updated_at = now() WHERE id = 1", [max]);
      await this.event(c, "cap_set", null, actor, { previous: prev.max_agents, max });
    });
  }

  /** Operator-only. EMERGENCY is entered this way as well. */
  async setOperatingMode(mode: FleetState, actor: string, reason: string): Promise<void> {
    if (!isFleetState(mode)) throw new Error(`Invalid operating mode: ${String(mode)}`);
    await this.tx(async (c) => {
      const prev = await this.lockState(c);
      await c.query("UPDATE fleet_state SET operating_mode = $1, updated_at = now() WHERE id = 1", [mode]);
      await this.event(c, "mode_set", null, actor, { previous: prev.operating_mode, mode, reason });
    });
  }

  /** Operator-only: approve the runtime children must run, with its build identity. Null clears it (blocks all replication). */
  async setApprovedRuntime(pin: RuntimePin | null, actor: string, build: RuntimeBuild | null = null): Promise<void> {
    await this.tx(async (c) => {
      const prev = await this.lockState(c);
      await c.query(
        `UPDATE fleet_state SET runtime_repo = $1, runtime_commit = $2, runtime_build_id = $3, runtime_lockfile_sha256 = $4,
                updated_at = now() WHERE id = 1`,
        [pin?.repo ?? null, pin?.commit ?? null, pin ? build?.buildId ?? null : null, pin ? build?.lockfileSha256 ?? null : null],
      );
      await this.event(c, "runtime_approved", null, actor, {
        previous: prev.runtime_commit ? { repo: prev.runtime_repo, commit: prev.runtime_commit, buildId: prev.runtime_build_id } : null,
        runtime: pin,
        build: pin ? build : null,
      });
    });
  }

  /** Operator-only: DB-level replication switch (independent of every process's REAL_REPLICATION_ENABLED). */
  async setReplicationEnabled(enabled: boolean, actor: string): Promise<void> {
    await this.tx(async (c) => {
      const prev = await this.lockState(c);
      await c.query("UPDATE fleet_state SET replication_enabled = $1, updated_at = now() WHERE id = 1", [enabled === true]);
      await this.event(c, "replication_switch_set", null, actor, { previous: prev.replication_enabled, enabled: enabled === true });
    });
  }

  /** Operator-only: lease and heartbeat timeouts (seconds). */
  async setTimeouts(t: Partial<FleetTimeouts>, actor: string): Promise<FleetTimeouts> {
    return this.tx(async (c) => {
      const prev = await this.lockState(c);
      const next: FleetTimeouts = {
        reservationTtlS: t.reservationTtlS ?? prev.reservation_ttl_s,
        provisioningTtlS: t.provisioningTtlS ?? prev.provisioning_ttl_s,
        heartbeatUnresponsiveS: t.heartbeatUnresponsiveS ?? prev.heartbeat_unresponsive_s,
        heartbeatDeadS: t.heartbeatDeadS ?? prev.heartbeat_dead_s,
        parentReportQuietS: t.parentReportQuietS ?? prev.parent_report_quiet_s,
      };
      for (const [k, v] of Object.entries(next)) {
        if (!Number.isSafeInteger(v) || v < 1) throw new Error(`Invalid timeout ${k}: ${v}`);
      }
      await c.query(
        `UPDATE fleet_state SET reservation_ttl_s = $1, provisioning_ttl_s = $2, heartbeat_unresponsive_s = $3,
                heartbeat_dead_s = $4, parent_report_quiet_s = $5, updated_at = now() WHERE id = 1`,
        [next.reservationTtlS, next.provisioningTtlS, next.heartbeatUnresponsiveS, next.heartbeatDeadS, next.parentReportQuietS],
      );
      await this.event(c, "timeouts_set", null, actor, { ...next });
      return next;
    });
  }

  async getTimeouts(): Promise<FleetTimeouts> {
    return this.read(async (c) => {
      const r = await c.query<StateRow>("SELECT * FROM fleet_state WHERE id = 1");
      const s = r.rows[0];
      return {
        reservationTtlS: s.reservation_ttl_s,
        provisioningTtlS: s.provisioning_ttl_s,
        heartbeatUnresponsiveS: s.heartbeat_unresponsive_s,
        heartbeatDeadS: s.heartbeat_dead_s,
        parentReportQuietS: s.parent_report_quiet_s,
      };
    });
  }

  /**
   * Operator-only: give `role` exactly the restricted agent API — USAGE on
   * the schema and EXECUTE on api_* functions; nothing on tables, sequences
   * or internal functions. Re-running is harmless.
   */
  async grantAgentRole(role: string = this.agentRole): Promise<void> {
    const r = quoteIdent(role);
    const s = quoteIdent(this.schema);
    await this.tx(async (c) => {
      const exists = await c.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
      if (!exists.rowCount) throw new Error(`Role ${role} does not exist (create it with scripts/fleet-db-roles.sql).`);
      await c.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${s} FROM PUBLIC, ${r}`);
      await c.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${s} FROM PUBLIC, ${r}`);
      await c.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${s} FROM PUBLIC, ${r}`);
      await c.query(`REVOKE ALL ON SCHEMA ${s} FROM PUBLIC, ${r}`);
      await c.query(`GRANT USAGE ON SCHEMA ${s} TO ${r}`);
      for (const fn of AGENT_API_FUNCTIONS) await c.query(`GRANT EXECUTE ON FUNCTION ${s}.${fn} TO ${r}`);
      await this.event(c, "agent_role_granted", null, "operator", { role, functions: [...AGENT_API_FUNCTIONS] });
    });
  }

  /**
   * Operator-only: give `role` exactly the controller API — USAGE on the
   * schema, SELECT on the non-secret tables and EXECUTE on svc_* functions.
   * No INSERT/UPDATE/DELETE, no credential hashes, no internal functions.
   */
  async grantServiceRole(role: string = this.serviceRole): Promise<void> {
    const r = quoteIdent(role);
    const s = quoteIdent(this.schema);
    await this.tx(async (c) => {
      const exists = await c.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
      if (!exists.rowCount) throw new Error(`Role ${role} does not exist (create it with scripts/fleet-db-roles.sql).`);
      await c.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${s} FROM ${r}`);
      await c.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${s} FROM ${r}`);
      await c.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${s} FROM ${r}`);
      await c.query(`REVOKE ALL ON SCHEMA ${s} FROM ${r}`);
      await c.query(`GRANT USAGE ON SCHEMA ${s} TO ${r}`);
      for (const t of SERVICE_READ_TABLES) await c.query(`GRANT SELECT ON ${s}.${quoteIdent(t)} TO ${r}`);
      for (const fn of SERVICE_API_FUNCTIONS) await c.query(`GRANT EXECUTE ON FUNCTION ${s}.${fn} TO ${r}`);
      await this.event(c, "service_role_granted", null, "operator", {
        role,
        tables: [...SERVICE_READ_TABLES],
        functions: [...SERVICE_API_FUNCTIONS],
      });
    });
  }

  /**
   * Operator-only (schema v8): give `role` exactly the read-only Operator API —
   * USAGE on the schema and EXECUTE on OPERATOR_API_FUNCTIONS. No table,
   * sequence or other function privilege. Re-running is harmless.
   */
  async grantOperatorRole(role: string = this.operatorRole): Promise<void> {
    const r = quoteIdent(role);
    const s = quoteIdent(this.schema);
    await this.tx(async (c) => {
      const exists = await c.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
      if (!exists.rowCount) throw new Error(`Role ${role} does not exist (create it with scripts/fleet-db-roles.sql).`);
      await c.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${s} FROM PUBLIC, ${r}`);
      await c.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${s} FROM PUBLIC, ${r}`);
      await c.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${s} FROM PUBLIC, ${r}`);
      await c.query(`REVOKE ALL ON SCHEMA ${s} FROM PUBLIC, ${r}`);
      await c.query(`GRANT USAGE ON SCHEMA ${s} TO ${r}`);
      for (const fn of OPERATOR_API_FUNCTIONS) await c.query(`GRANT EXECUTE ON FUNCTION ${s}.${fn} TO ${r}`);
      await this.event(c, "operator_role_granted", null, "operator", { role, functions: [...OPERATOR_API_FUNCTIONS] });
    });
  }

  /**
   * Operator API overview for doctor (schema v8). Needs the admin (owner)
   * credential; returns null when the tables are not visible (e.g. doctor
   * runs with the service credential).
   */
  async operatorOverview(): Promise<{
    enabled: boolean;
    generation: number;
    requestCount: number;
    requestCap: number;
    activePrincipals: number;
    activeKeys: number;
    keysExpiringSoon: number;
    recentDenials: number;
  } | null> {
    try {
      return await this.read(async (c) => {
        const r = await c.query<{
          enabled: boolean; generation: string; request_count: string; request_cap: string;
          principals: string; keys: string; expiring: string; denials: string;
        }>(
          `SELECT s.operator_api_enabled AS enabled, s.generation, s.request_count, s.request_cap,
                  (SELECT count(*) FROM fleet_operator_principals WHERE revoked_at IS NULL) AS principals,
                  (SELECT count(*) FROM fleet_operator_keys k JOIN fleet_operator_principals p USING (principal_id)
                    WHERE k.revoked_at IS NULL AND p.revoked_at IS NULL AND now() < k.expires_at) AS keys,
                  (SELECT count(*) FROM fleet_operator_keys k JOIN fleet_operator_principals p USING (principal_id)
                    WHERE k.revoked_at IS NULL AND p.revoked_at IS NULL AND now() < k.expires_at
                      AND k.expires_at < now() + interval '14 days') AS expiring,
                  (SELECT count(*) FROM fleet_events WHERE event_type IN ('operator_auth_failed','operator_scope_denied','operator_replay_blocked','operator_stale')
                    AND created_at > now() - interval '10 minutes') AS denials
             FROM fleet_operator_state s WHERE s.id = 1`,
        );
        const row = r.rows[0];
        if (!row) return null;
        return {
          enabled: row.enabled,
          generation: Number(row.generation),
          requestCount: Number(row.request_count),
          requestCap: Number(row.request_cap),
          activePrincipals: Number(row.principals),
          activeKeys: Number(row.keys),
          keysExpiringSoon: Number(row.expiring),
          recentDenials: Number(row.denials),
        };
      });
    } catch {
      return null;
    }
  }

  // ─── Registration ──────────────────────────────────────────────

  /**
   * Register (or re-attach) a root automaton, identified by wallet address.
   * Idempotent: the same wallet always yields the same agent_id. A new root
   * occupies a living slot and is subject to the cap.
   */
  async registerRoot(params: {
    walletAddress: string;
    name: string;
    runtimeVersion?: string | null;
    runtimeCommit?: string | null;
    localMaxAgents?: number;
    /** Schema v7 identity scope; default 'full'. Fixed at insert, never changed. */
    capabilityScope?: FleetCapabilityScope;
  }): Promise<RegisterResult> {
    const scope: FleetCapabilityScope = params.capabilityScope ?? "full";
    return this.tx(async (c): Promise<RegisterResult> => {
      const st = await this.lockState(c);
      const existing = await c.query<AgentRow>("SELECT * FROM fleet_agents WHERE lower(wallet_address) = lower($1)", [
        params.walletAddress,
      ]);
      if (existing.rowCount) {
        const row = existing.rows[0];
        if (row.role !== "root") {
          return { ok: false, code: "FLEET_IDENTITY_MISMATCH", reason: "Wallet is registered as a child, not a root." };
        }
        if ((row.capability_scope ?? "full") !== scope) {
          return { ok: false, code: "FLEET_IDENTITY_MISMATCH", reason: `Wallet is registered with capability scope ${row.capability_scope ?? "full"}, not ${scope}.` };
        }
        if (row.status !== "active" && row.status !== "unresponsive") {
          return { ok: false, code: "FLEET_AGENT_DEAD", reason: `Agent ${row.agent_id} is ${row.status}; the dead are not revived.` };
        }
        await c.query("SELECT fleet_heartbeat($1, $2)", [row.agent_id, params.walletAddress]);
        const upd = await c.query<AgentRow>(
          `UPDATE fleet_agents SET updated_at = now(),
                  runtime_version = COALESCE($2, runtime_version), runtime_commit = COALESCE($3, runtime_commit)
            WHERE agent_id = $1 RETURNING *`,
          [row.agent_id, params.runtimeVersion ?? null, params.runtimeCommit ?? null],
        );
        return { ok: true, agent: toAgent(upd.rows[0]), created: false };
      }

      const max = Math.min(st.max_agents, params.localMaxAgents ?? FLEET_PG_HARD_MAX_AGENTS);
      if (st.living_agents + st.reserved_slots + (st.quarantined_slots ?? 0) >= max) {
        await this.event(c, "registration_denied", null, params.walletAddress, {
          code: "FLEET_CAP_REACHED",
          living: st.living_agents,
          reserved: st.reserved_slots,
          max,
        });
        return { ok: false, code: "FLEET_CAP_REACHED", reason: `Fleet at cap (${st.living_agents + st.reserved_slots}/${max}); root not registered.` };
      }
      const id = ulid();
      const ins = await c.query<AgentRow>(
        `INSERT INTO fleet_agents (agent_id, role, generation, name, wallet_address, runtime_version, runtime_commit,
                                   status, requested_by, last_heartbeat, capability_scope)
         VALUES ($1, 'root', 0, $2, $3, $4, $5, 'active', $3, now(), $6) RETURNING *`,
        [id, params.name, params.walletAddress, params.runtimeVersion ?? null, params.runtimeCommit ?? null, scope],
      );
      await this.event(c, "root_registered", id, params.walletAddress, { name: params.name, capabilityScope: scope });
      return { ok: true, agent: toAgent(ins.rows[0]), created: true };
    });
  }

  /** A child confirms the identity its parent assigned. No inserts. */
  async attachAgent(agentId: string, walletAddress: string): Promise<RegisterResult> {
    return this.read(async (c): Promise<RegisterResult> => {
      const r = await c.query<AgentRow>("SELECT * FROM fleet_agents WHERE agent_id = $1", [agentId]);
      const row = r.rows[0];
      if (!row) return { ok: false, code: "FLEET_NOT_REGISTERED", reason: `Agent ${agentId} is not in the fleet registry.` };
      if (!row.wallet_address || row.wallet_address.toLowerCase() !== walletAddress.toLowerCase()) {
        return { ok: false, code: "FLEET_IDENTITY_MISMATCH", reason: "Wallet does not match the registered agent." };
      }
      if (row.status !== "active" && row.status !== "unresponsive") {
        return { ok: false, code: "FLEET_AGENT_DEAD", reason: `Agent ${agentId} is ${row.status}.` };
      }
      return { ok: true, agent: toAgent(row), created: false };
    });
  }

  /**
   * Operator-only: issue (or rotate) the bearer credential of a living agent.
   * The token is returned once; only its SHA-256 is stored.
   */
  async issueCredential(agentId: string, actor: string): Promise<FleetCredential> {
    return this.tx(async (c) => {
      const cred = await this.issueCredentialTx(c, agentId, actor);
      // Rotation invalidates every session opened with the previous credential.
      await c.query("UPDATE fleet_agent_sessions SET revoked_at = now() WHERE agent_id = $1 AND revoked_at IS NULL", [agentId]);
      return cred;
    });
  }

  private async issueCredentialTx(c: PoolClient, agentId: string, actor: string | null): Promise<FleetCredential> {
    const a = await c.query<{ status: string }>("SELECT status FROM fleet_agents WHERE agent_id = $1 FOR UPDATE", [agentId]);
    if (!a.rowCount || !["active", "unresponsive"].includes(a.rows[0].status)) {
      throw new Error(`Cannot issue a credential for ${agentId}: agent is not living.`);
    }
    const token = mintAgentToken(agentId);
    await c.query(
      `INSERT INTO fleet_agent_credentials (agent_id, token_hash) VALUES ($1, $2)
       ON CONFLICT (agent_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, created_at = now(), revoked_at = NULL`,
      [agentId, hashAgentToken(token)],
    );
    await this.event(c, "credential_issued", agentId, actor, {});
    return { agentId, token };
  }

  // ─── Slot allocation ───────────────────────────────────────────

  /**
   * Atomically reserve a slot for a child of `parentAgentId`. Creates a
   * reservation lease that counts against the cap until it completes,
   * expires, is released, or the child dies. Runs fleet_reserve_slot(),
   * the same allocator the restricted agent API uses.
   */
  async reserveSlot(params: {
    parentAgentId: string;
    requestedBy: string;
    name: string;
    runtime: RuntimePin | null;
    requestKey?: string;
    localMaxAgents?: number;
  }): Promise<SharedReserveResult> {
    const requestKey = params.requestKey ?? ulid();
    let result: SharedReserveResult;
    try {
      result = await this.tx(async (c): Promise<SharedReserveResult> => {
        const r = await c.query<{ res: ReserveJson }>(
          "SELECT fleet_reserve_slot($1, $2, $3, $4, $5, $6, true, $7, $8, $9, $10) AS res",
          [
            params.parentAgentId,
            params.requestedBy,
            params.name,
            requestKey,
            params.localMaxAgents ?? null,
            this.reservationTtlMs,
            params.runtime?.repo ?? null,
            params.runtime?.commit ?? null,
            ulid(),
            ulid(),
          ],
        );
        const res = r.rows[0].res;
        if (!res.ok) {
          return { ok: false, code: res.code as FleetDecisionCode, reason: res.reason, living: res.living, reserved: res.reserved, max: res.max };
        }
        const agent = await c.query<AgentRow>("SELECT * FROM fleet_agents WHERE agent_id = $1", [res.agentId]);
        const agentId = res.agentId;
        const grant = createBoundGrant(res.reservationId, (localChildId) => this.claimGrant(agentId, localChildId));
        return { ok: true, grant, agent: toAgent(agent.rows[0]), lease: leaseFromReserve(res) };
      });
    } catch (err) {
      if (/FLEET_CAP_EXCEEDED/.test(pgMessage(err))) {
        const st = await this.getState().catch(() => null);
        return {
          ok: false,
          code: "FLEET_CAP_REACHED",
          reason: "Fleet cap enforced by database.",
          living: st?.livingAgents ?? -1,
          reserved: st?.reservedSlots ?? -1,
          max: st?.maxAgents ?? -1,
        };
      }
      if (/request_key/.test(pgMessage(err))) {
        return { ok: false, code: "FLEET_DUPLICATE_REQUEST", reason: "Replication request already registered.", living: -1, reserved: -1, max: -1 };
      }
      throw err;
    }
    return result;
  }

  /**
   * Operator-only (admin credential): reserve the single DRY_RUN_CHILD slot
   * under a living root. Independent of the replication switch; the child
   * can never replicate or spend (enforced by the database).
   */
  async reserveDryRunSlot(params: { parentAgentId: string; requestedBy: string; name: string }): Promise<SharedReserveResult> {
    return this.tx(async (c): Promise<SharedReserveResult> => {
      const r = await c.query<{ res: ReserveJson }>("SELECT fleet_reserve_dry_run($1, $2, $3, $4, $5, $6) AS res", [
        params.parentAgentId, params.requestedBy, params.name, ulid(), ulid(), this.reservationTtlMs,
      ]);
      const res = r.rows[0].res;
      if (!res.ok) {
        return { ok: false, code: res.code as FleetDecisionCode, reason: res.reason, living: res.living, reserved: res.reserved, max: res.max };
      }
      const agent = await c.query<AgentRow>("SELECT * FROM fleet_agents WHERE agent_id = $1", [res.agentId]);
      const agentId = res.agentId;
      const grant = createBoundGrant(res.reservationId, (localChildId) => this.claimGrant(agentId, localChildId));
      return { ok: true, grant, agent: toAgent(agent.rows[0]), lease: leaseFromReserve(res) };
    });
  }

  /**
   * reserved -> provisioning, exactly once, before any sandbox exists. Moves
   * the lease to the provisioning TTL and issues the attestation nonce.
   * `parentAgentId` (API path) must equal the lease's parent. Runs
   * svc_claim(), so the restricted service role can do it.
   */
  async claimGrant(agentId: string, localChildId: string, opts: { parentAgentId?: string } = {}): Promise<ClaimedGrant> {
    const nonce = newAttestationNonce();
    const r = await this.tx(async (c) =>
      c.query<{ res: { ok: boolean; reason?: string; parentAgentId?: string; generation?: number; reservationId?: string;
                       repo?: string; commit?: string; buildId?: string; lockfileSha256?: string } }>(
        "SELECT svc_claim($1, $2, $3, $4, $5) AS res",
        [agentId, localChildId, opts.parentAgentId ?? null, this.provisioningTtlMs, nonce],
      ),
    );
    const res = r.rows[0].res;
    if (!res.ok) {
      const reason = res.reason ?? `Replication denied: fleet reservation ${agentId} is invalid, expired, or already used.`;
      await this.recordEvent("claim_denied", agentId, opts.parentAgentId ?? null, { reason }).catch(() => {});
      throw new FleetBypassError(reason);
    }
    const parent = opts.parentAgentId ?? null;
    return {
      agentId,
      parentAgentId: res.parentAgentId!,
      generation: res.generation!,
      runtime: { repo: res.repo!, commit: res.commit! },
      expectedBuild: { buildId: res.buildId!, lockfileSha256: res.lockfileSha256! },
      nonce,
      reservationId: res.reservationId!,
      provisioningKey: res.reservationId!,
      backend: "postgres",
      reportProvisioning: async (phase, sandboxId) => {
        await this.reportProvisioning(agentId, phase, sandboxId ?? null, parent);
      },
      recordSandboxIntent: (sandboxName) => this.recordSandboxIntent(agentId, sandboxName, parent),
      reconcileProvisioning: (outcome, sandboxId) =>
        this.reconcileProvisioning(res.reservationId!, outcome, sandboxId ?? null, parent ?? "controller").then(() => undefined),
    };
  }

  // ─── Phase 5: provisioning, health, sessions, termination ──────

  /** Record provisioning progress (svc_provision_update). Throws if refused. */
  async reportProvisioning(
    agentId: string,
    phase: "sandbox_intent" | "sandbox_created" | "verifying",
    sandboxId: string | null,
    parentAgentId: string | null,
  ): Promise<Record<string, unknown>> {
    const r = await this.tx(async (c) =>
      (await c.query("SELECT svc_provision_update($1, $2, $3, $4) AS r", [agentId, parentAgentId, phase, sandboxId])).rows[0].r,
    );
    if (!r.ok) throw new FleetBypassError(`Provisioning update refused: ${r.code}${r.reason ? ` (${r.reason})` : ""}`);
    return r;
  }

  /**
   * Phase 6: durable external-resource intent, recorded BEFORE the sandbox is
   * created. Returns the attempt number and, when the controller already
   * knows the sandbox, its id (the caller must reuse it, never create another).
   */
  async recordSandboxIntent(agentId: string, sandboxName: string, parentAgentId: string | null): Promise<SandboxIntent> {
    const r = await this.reportProvisioning(agentId, "sandbox_intent", sandboxName, parentAgentId);
    return {
      provisioningKey: String(r.provisioningKey),
      sandboxName: String(r.sandboxName),
      sandboxId: typeof r.sandboxId === "string" ? r.sandboxId : null,
      attempts: Number(r.attempts),
    };
  }

  /** Phase 6: record the outcome of looking up an uncertain sandbox (svc_provision_reconcile). */
  async reconcileProvisioning(
    provisioningKey: string,
    outcome: "found" | "absent" | "unknown",
    sandboxId: string | null,
    actor: string,
  ): Promise<{ ok: boolean; code?: string; reason?: string; agentStatus?: string }> {
    const r = await this.tx(async (c) =>
      (await c.query("SELECT svc_provision_reconcile($1, $2, $3, $4) AS r", [provisioningKey, outcome, sandboxId, actor])).rows[0].r,
    );
    if (!r.ok) throw new FleetBypassError(`Provisioning reconciliation refused: ${r.code}${r.reason ? ` (${r.reason})` : ""}`);
    return r;
  }

  /** Phase 6: liveness, health and spend authority of one agent (dry-run verification, doctor). */
  async agentAuthority(agentId: string): Promise<{
    status: string;
    dryRun: boolean;
    lastHeartbeat: string | null;
    lastChallengeOkAt: string | null;
    spendingFrozen: boolean | null;
    dailyLimitCents: number | null;
    credentialLive: boolean;
    sandboxId: string | null;
  } | null> {
    return this.read(async (c) => {
      const r = await c.query(
        `SELECT a.status, a.dry_run, a.last_heartbeat, a.last_challenge_ok_at, a.sandbox_id,
                w.spending_frozen, w.daily_limit_cents,
                EXISTS (SELECT 1 FROM fleet_agent_credentials k WHERE k.agent_id = a.agent_id AND k.revoked_at IS NULL) AS cred
           FROM fleet_agents a LEFT JOIN fleet_wallet_custody w ON w.agent_id = a.agent_id WHERE a.agent_id = $1`,
        [agentId],
      );
      const x = r.rows[0];
      if (!x) return null;
      return {
        status: x.status,
        dryRun: x.dry_run,
        lastHeartbeat: iso(x.last_heartbeat),
        lastChallengeOkAt: iso(x.last_challenge_ok_at),
        spendingFrozen: x.spending_frozen ?? null,
        dailyLimitCents: x.daily_limit_cents === null || x.daily_limit_cents === undefined ? null : Number(x.daily_limit_cents),
        credentialLive: x.cred,
        sandboxId: x.sandbox_id,
      };
    });
  }

  /** Provisioning attempts whose sandbox may exist but was never identified. */
  async listUncertainProvisioning(): Promise<Array<Record<string, unknown>>> {
    return this.read(async (c) =>
      (await c.query(
        `SELECT p.*, a.status AS agent_status FROM fleet_provisioning p JOIN fleet_agents a ON a.agent_id = p.expected_agent_id
          WHERE p.sandbox_id IS NULL AND p.external_state IN ('intent','uncertain')
            AND (a.status NOT IN ('reserved','provisioning') OR p.activation_deadline <= now())
          ORDER BY p.created_at`,
      )).rows,
    );
  }

  async listProvisioning(filter: { needsCleanup?: boolean } = {}): Promise<Array<Record<string, unknown>>> {
    const where = filter.needsCleanup ? "WHERE cleanup_status IN ('pending','unsupported','failed')" : "";
    return this.read(async (c) => (await c.query(`SELECT * FROM fleet_provisioning ${where} ORDER BY created_at`)).rows);
  }

  async listOrphans(filter: { open?: boolean } = {}): Promise<Array<Record<string, unknown>>> {
    const where = filter.open ? "WHERE resolved_at IS NULL" : "";
    return this.read(async (c) => (await c.query(`SELECT * FROM fleet_orphans ${where} ORDER BY detected_at`)).rows);
  }

  /** Replay protection: true the first time (agent, nonce) is seen. */
  async consumeNonce(agentId: string, nonce: string, ttlS: number): Promise<boolean> {
    return this.svcBool("SELECT svc_consume_nonce($1, $2, $3) AS ok", [agentId, nonce, ttlS]);
  }

  /** Issue a health challenge if one is due. The nonce is returned once; only its hash is stored. */
  async issueChallenge(agentId: string): Promise<HealthChallenge | null> {
    const nonce = crypto.randomBytes(32).toString("base64url");
    const challengeId = ulid();
    const canary = HEALTH_CANARIES[crypto.randomInt(HEALTH_CANARIES.length)];
    const r = await this.tx(async (c) =>
      (await c.query("SELECT svc_issue_challenge($1, $2, $3, $4) AS r", [agentId, challengeId, hashAgentToken(nonce), canary])).rows[0].r,
    );
    return r.issued ? { challengeId, nonce, canary, expiresAt: new Date(r.expiresAt).toISOString() } : null;
  }

  async answerChallenge(
    agentId: string,
    answer: { challengeId: string; nonce: string; commit: string | null; buildId: string | null; policyOk: boolean },
  ): Promise<{ ok: boolean; code?: string; reason?: string }> {
    return this.tx(async (c) =>
      (
        await c.query("SELECT svc_answer_challenge($1, $2, $3, $4, $5, $6) AS r", [
          agentId, answer.challengeId, answer.nonce, answer.commit, answer.buildId, answer.policyOk === true,
        ])
      ).rows[0].r,
    );
  }

  /** Operator-only: quarantine an agent now (revoke everything; terminate its sandbox). */
  async quarantine(agentId: string, reason: string, actor: string): Promise<string | null> {
    return this.tx(async (c) => {
      const r = await c.query<{ s: string | null }>("SELECT fleet_begin_termination($1, $2, $3, 'quarantine') AS s", [agentId, scrubText(reason), actor]);
      await this.event(c, "agent_quarantined", agentId, actor, { reason, result: r.rows[0].s });
      return r.rows[0].s;
    });
  }

  /** Operator-only: resolve an orphan after external cleanup was confirmed. */
  async resolveOrphan(agentId: string, resolution: string, actor: string): Promise<boolean> {
    return this.tx(async (c) => {
      await this.lockState(c);
      const o = await c.query(
        "UPDATE fleet_orphans SET resolved_at = now(), resolution = $2, resolved_by = $3 WHERE agent_id = $1 AND resolved_at IS NULL RETURNING orphan_id",
        [agentId, scrubText(resolution), actor],
      );
      if (!o.rowCount) return false;
      await c.query(
        `UPDATE fleet_agents SET status = 'dead', death_time = now(), updated_at = now(),
                status_reason = left(COALESCE(status_reason, '') || '; orphan resolved: ' || $2, 500)
          WHERE agent_id = $1 AND status = 'orphaned'`,
        [agentId, scrubText(resolution)],
      );
      await c.query(
        "UPDATE fleet_sandbox_terminations SET status = 'terminated', completed_at = now(), last_error = $2 WHERE agent_id = $1 AND status <> 'terminated'",
        [agentId, `operator confirmed: ${scrubText(resolution)}`],
      );
      await c.query(
        "UPDATE fleet_provisioning SET cleanup_status = 'terminated', updated_at = now() WHERE expected_agent_id = $1 AND cleanup_status <> 'terminated'",
        [agentId],
      );
      await this.event(c, "orphan_resolved", agentId, actor, { resolution });
      return true;
    });
  }

  async getLifecyclePolicy(): Promise<LifecyclePolicy> {
    return this.read(async (c) => {
      const s = (await c.query("SELECT * FROM fleet_state WHERE id = 1")).rows[0];
      return {
        healthChallengeIntervalS: s.health_challenge_interval_s,
        challengeTtlS: s.challenge_ttl_s,
        healthGraceS: s.health_grace_s,
        maxChallengeFailures: s.max_challenge_failures,
        terminationGraceS: s.termination_grace_s,
        orphanSlotHoldS: s.orphan_slot_hold_s,
        maxOpenOrphans: s.max_open_orphans,
        sessionTtlS: s.session_ttl_s,
      };
    });
  }

  /** Operator-only: health grace periods, termination eligibility, orphan policy, session TTL. */
  async setLifecyclePolicy(p: Partial<LifecyclePolicy>, actor: string): Promise<LifecyclePolicy> {
    const cur = await this.getLifecyclePolicy();
    const n = { ...cur, ...p };
    await this.tx(async (c) => {
      await this.lockState(c);
      await c.query(
        `UPDATE fleet_state SET health_challenge_interval_s = $1, challenge_ttl_s = $2, health_grace_s = $3, max_challenge_failures = $4,
                termination_grace_s = $5, orphan_slot_hold_s = $6, max_open_orphans = $7, session_ttl_s = $8, updated_at = now() WHERE id = 1`,
        [n.healthChallengeIntervalS, n.challengeTtlS, n.healthGraceS, n.maxChallengeFailures, n.terminationGraceS, n.orphanSlotHoldS,
         n.maxOpenOrphans, n.sessionTtlS],
      );
      await this.event(c, "lifecycle_policy_set", null, actor, { ...n });
    });
    return n;
  }

  /**
   * provisioning -> active. The child must have proven its runtime identity:
   * the attestation must carry this reservation's nonce and match the
   * recorded expected repo, commit, lockfile and build identifier. Any
   * mismatch stops activation, releases the slot and marks the provisioning
   * failed (runtime_verification_failed). Issues the child's credential.
   *
   * Checked twice: here (detailed errors, fail fast) and authoritatively in
   * svc_activate() under the fleet lock, so a controller bug cannot activate
   * an unverified child.
   */
  async activate(
    agentId: string,
    params: {
      walletAddress: string;
      sandboxId?: string | null;
      runtimeCommit?: string | null;
      runtimeVersion?: string | null;
      attestation?: RuntimeAttestation | null;
      parentAgentId?: string;
      actor?: string | null;
      /** Phase 6: must equal the lease's provisioning key (reservation id) when given. */
      provisioningKey?: string | null;
    },
  ): Promise<ActivationResult> {
    const pre = await this.read(async (c) => {
      const a = await c.query<AgentRow>("SELECT * FROM fleet_agents WHERE agent_id = $1", [agentId]);
      const l = await c.query<LeaseRow>("SELECT * FROM fleet_reservations WHERE agent_id = $1", [agentId]);
      return { row: a.rows[0], lease: l.rows[0], now: await dbNow(c) };
    });
    const { row, lease } = pre;
    if (!row || row.status !== "provisioning") {
      throw new Error(`Cannot activate fleet agent ${agentId}: not in provisioning state`);
    }
    if (!lease || lease.status !== "provisioning") {
      throw new Error(`Cannot activate fleet agent ${agentId}: no open provisioning lease`);
    }
    if (params.parentAgentId !== undefined && lease.parent_agent_id !== params.parentAgentId) {
      throw new FleetBypassError(`Activation denied: reservation ${lease.reservation_id} belongs to another parent.`);
    }
    if (params.provisioningKey != null && params.provisioningKey !== lease.reservation_id) {
      throw new FleetBypassError(`Activation denied: provisioning key does not match reservation ${lease.reservation_id}.`);
    }
    if (lease.expires_at.getTime() <= pre.now) {
      throw new FleetBypassError(`Activation denied: provisioning lease ${lease.reservation_id} has expired.`);
    }
    let attestation: RuntimeAttestation;
    try {
      if (!params.runtimeCommit || params.runtimeCommit !== lease.expected_commit) {
        throw new FleetRuntimeError(
          `Cannot activate fleet agent ${agentId}: verified runtime ${params.runtimeCommit ?? "<none>"} != pinned ${lease.expected_commit}`,
        );
      }
      attestation = checkAttestation(params.attestation ? sanitizeAttestation(params.attestation) : null, {
        repo: lease.expected_repo,
        commit: lease.expected_commit,
        buildId: lease.expected_build_id,
        lockfileSha256: lease.expected_lockfile_sha256,
        nonce: lease.attestation_nonce ?? "",
      });
    } catch (err) {
      await this.recordVerificationFailure(agentId, err instanceof Error ? err.message : String(err), params.actor ?? null).catch(() => {});
      throw err;
    }

    const token = mintAgentToken(agentId);
    let res: { ok: boolean; code?: string; reason?: string; agent?: Record<string, unknown> };
    try {
      const r = await this.tx(async (c) =>
        c.query<{ res: typeof res }>("SELECT svc_activate($1, $2, $3, $4, $5, $6, $7, $8, $9) AS res", [
          agentId,
          params.parentAgentId ?? null,
          params.walletAddress,
          params.sandboxId ?? null,
          params.runtimeCommit,
          params.runtimeVersion ?? null,
          JSON.stringify({ ...attestation, repo: normalizeRepoUrl(attestation.repo) }),
          params.actor ?? null,
          hashAgentToken(token),
        ]),
      );
      res = r.rows[0].res;
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      if (e.code === "23505") {
        throw new FleetDuplicateRegistrationError(
          `Duplicate child registration rejected for ${agentId} (${e.constraint ?? "unique constraint"}).`,
        );
      }
      throw err;
    }
    if (!res.ok) {
      const reason = res.reason ?? "activation refused";
      if (res.code === "FLEET_RUNTIME_UNVERIFIED") throw new FleetRuntimeError(reason);
      if (res.code === "FLEET_NOT_AUTHORIZED") throw new FleetBypassError(reason);
      throw new Error(reason);
    }
    return { agent: agentFromJson(res.agent!), credential: { agentId, token } };
  }

  /**
   * Runtime verification failed: stop activation, release the reservation
   * and mark the provisioning failed. Idempotent.
   */
  async recordVerificationFailure(agentId: string, reason: string, actor: string | null = null): Promise<boolean> {
    return this.svcBool("SELECT svc_verification_failed($1, $2, $3) AS ok", [agentId, scrubText(reason), actor]);
  }

  /** reserved/provisioning -> failed. Returns false if already released/active/dead (no double release). */
  async releaseReservation(agentId: string, reason: string, actor: string | null = null): Promise<boolean> {
    return this.svcBool("SELECT svc_release($1, $2, $3) AS ok", [agentId, scrubText(reason), actor]);
  }

  /** Record a death. The row is retained forever and no longer counts; the credential is revoked. Idempotent. */
  async markDead(agentId: string, reason: string, actor?: string, cause = "reported"): Promise<boolean> {
    return this.svcBool("SELECT svc_mark_dead($1, $2, $3, $4) AS ok", [agentId, scrubText(reason), actor ?? null, cause]);
  }

  private async svcBool(sql: string, args: unknown[]): Promise<boolean> {
    return this.tx(async (c) => (await c.query<{ ok: boolean }>(sql, args)).rows[0].ok === true);
  }

  async markDeadByLocalChildId(localChildId: string, reason: string): Promise<boolean> {
    const agent = await this.read(async (c) =>
      c.query<{ agent_id: string }>("SELECT agent_id FROM fleet_agents WHERE local_child_id = $1", [localChildId]),
    );
    const id = agent.rows[0]?.agent_id;
    return id ? this.markDead(id, reason, undefined, "child_lifecycle") : false;
  }

  /**
   * A parent reports its child's local lifecycle ended (svc_child_terminal):
   * unclaimed/provisioning children are released now; a living child dies
   * now only if it has already gone quiet, else once it does.
   */
  async reportChildTerminal(
    parentAgentId: string,
    localChildId: string,
    state: string,
  ): Promise<{ ok: boolean; code?: string; outcome?: "released" | "dead" | "deferred" | "already_terminal"; changed?: boolean }> {
    return this.tx(async (c) => {
      const r = await c.query("SELECT svc_child_terminal($1, $2, $3) AS res", [parentAgentId, localChildId, scrubText(state).slice(0, 32)]);
      return r.rows[0].res;
    });
  }

  /** Update last_heartbeat of a living agent (unresponsive agents recover). Never inserts. */
  async heartbeat(agentId: string): Promise<boolean> {
    return this.tx(async (c) => {
      const r = await c.query<{ s: string | null }>("SELECT svc_heartbeat($1) AS s", [agentId]);
      return r.rows[0].s === "active";
    });
  }

  async selfStatus(agentId: string): Promise<SharedAgentStatus | null> {
    return (await this.getAgent(agentId))?.status ?? null;
  }

  /**
   * One reaper pass: expire leases, retire quiet parent-reported children,
   * then ACTIVE -> UNRESPONSIVE -> DEAD for missed heartbeats. Safe to run
   * concurrently and repeatedly.
   */
  async reap(actor = "reaper"): Promise<ReapResult> {
    return this.tx(async (c) => {
      const r = await c.query<{ res: { expired: number; unresponsive: number; dead: number; graceFrom: string | null } }>(
        "SELECT svc_reap($1) AS res",
        [actor],
      );
      return r.rows[0].res;
    });
  }

  /** Append an audit event (service-level events: API auth failures, DB authorization failures, …). */
  async recordEvent(eventType: string, agentId: string | null, actor: string | null, detail: Record<string, unknown> = {}): Promise<void> {
    await this.tx(async (c) =>
      c.query("SELECT svc_record_event($1, $2, $3, $4)", [eventType, agentId, actor, JSON.stringify(scrubDetail(detail))]),
    );
  }

  // ─── Sandbox terminations ──────────────────────────────────────

  async terminationsDue(limit = 20): Promise<Array<{ agentId: string; sandboxId: string; attempts: number }>> {
    return this.tx(async (c) => (await c.query("SELECT svc_terminations_due($1) AS res", [limit])).rows[0].res);
  }

  async recordTerminationResult(
    agentId: string,
    status: "terminated" | "unsupported" | "failed",
    error: string | null,
    actor = "fleet-service",
  ): Promise<boolean> {
    return this.svcBool("SELECT svc_termination_result($1, $2, $3, $4) AS ok", [agentId, status, error ? scrubText(error) : null, actor]);
  }

  async listTerminations(): Promise<SandboxTerminationRecord[]> {
    return this.read(async (c) => {
      const r = await c.query("SELECT * FROM fleet_sandbox_terminations ORDER BY requested_at, agent_id");
      return r.rows.map((t) => ({
        agentId: t.agent_id,
        sandboxId: t.sandbox_id,
        status: t.status,
        requestedAt: t.requested_at.toISOString(),
        attempts: t.attempts,
        lastError: t.last_error,
      }));
    });
  }

  /** Stale/zombie indicators for fleet:doctor. */
  async staleness(): Promise<{
    staleAgents: number;
    unresponsive: number;
    staleReservations: number;
    openReservations: number;
    unterminatedSandboxes: number;
    reaperLastRunAt: string | null;
    openOrphans: number;
    provisioningNeedingCleanup: number;
    quarantined: number;
    terminating: number;
    uncertainProvisioning: number;
    dryRunChildren: number;
    dryRunProven: number;
  }> {
    return this.read(async (c) => {
      const r = await c.query(
        `SELECT
           (SELECT count(*) FROM fleet_agents a WHERE a.status IN ('active','unresponsive')
              AND COALESCE(a.last_heartbeat, a.updated_at) < now() - make_interval(secs => s.heartbeat_unresponsive_s))::int AS stale_agents,
           (SELECT count(*) FROM fleet_agents WHERE status = 'unresponsive')::int AS unresponsive,
           (SELECT count(*) FROM fleet_reservations WHERE status IN ('reserved','provisioning') AND expires_at <= now())::int AS stale_reservations,
           (SELECT count(*) FROM fleet_reservations WHERE status IN ('reserved','provisioning'))::int AS open_reservations,
           (SELECT count(*) FROM fleet_sandbox_terminations WHERE status <> 'terminated')::int AS unterminated,
           (SELECT count(*) FROM fleet_orphans WHERE resolved_at IS NULL)::int AS open_orphans,
           (SELECT count(*) FROM fleet_provisioning WHERE cleanup_status IN ('pending','unsupported','failed'))::int AS prov_cleanup,
           (SELECT count(*) FROM fleet_agents WHERE status = 'orphaned')::int AS quarantined,
           (SELECT count(*) FROM fleet_agents WHERE status = 'terminating')::int AS terminating,
           (SELECT count(*) FROM fleet_provisioning WHERE sandbox_id IS NULL AND external_state IN ('intent','uncertain')
               AND status <> 'active' AND (status <> 'provisioning' OR activation_deadline <= now()))::int AS uncertain,
           (SELECT count(*) FROM fleet_agents WHERE dry_run AND status IN ('reserved','provisioning','active','unresponsive','terminating','orphaned'))::int AS dry_run,
           (SELECT count(*) FROM fleet_agents WHERE dry_run AND activated_at IS NOT NULL AND last_challenge_ok_at IS NOT NULL)::int AS dry_run_proven,
           s.reaper_last_run_at
         FROM fleet_state s WHERE s.id = 1`,
      );
      const x = r.rows[0];
      return {
        staleAgents: x.stale_agents,
        unresponsive: x.unresponsive,
        staleReservations: x.stale_reservations,
        openReservations: x.open_reservations,
        unterminatedSandboxes: x.unterminated,
        reaperLastRunAt: iso(x.reaper_last_run_at),
        openOrphans: x.open_orphans,
        provisioningNeedingCleanup: x.prov_cleanup,
        quarantined: x.quarantined,
        terminating: x.terminating,
        uncertainProvisioning: x.uncertain,
        dryRunChildren: x.dry_run,
        dryRunProven: x.dry_run_proven,
      };
    });
  }

  async getReservation(idOrAgentId: string): Promise<ReservationLease | null> {
    return this.read(async (c) => {
      const r = await c.query<LeaseRow>(
        "SELECT * FROM fleet_reservations WHERE reservation_id = $1 OR agent_id = $1",
        [idOrAgentId],
      );
      return r.rows[0] ? toLease(r.rows[0]) : null;
    });
  }

  async listReservations(filter?: { open?: boolean }): Promise<ReservationLease[]> {
    const where = filter?.open ? "WHERE status IN ('reserved','provisioning')" : "";
    return this.read(async (c) => {
      const r = await c.query<LeaseRow>(`SELECT * FROM fleet_reservations ${where} ORDER BY created_at, reservation_id`);
      return r.rows.map(toLease);
    });
  }

  // ─── Queries ───────────────────────────────────────────────────

  /**
   * Capability scope of an agent identity (schema v7), read by agent id with
   * the controller's own role. null when no such agent exists. Used by the
   * fleet service's route policy before any route handler runs.
   */
  async capabilityScope(agentId: string): Promise<FleetCapabilityScope | string | null> {
    return this.read(async (c) => {
      const r = await c.query<{ s: string }>("SELECT capability_scope AS s FROM fleet_agents WHERE agent_id = $1", [agentId]);
      return r.rows[0]?.s ?? null;
    });
  }

  async getAgent(agentId: string): Promise<SharedAgentRecord | null> {
    return this.read(async (c) => {
      const r = await c.query<AgentRow>("SELECT * FROM fleet_agents WHERE agent_id = $1", [agentId]);
      return r.rows[0] ? toAgent(r.rows[0]) : null;
    });
  }

  async listAgents(filter?: { living?: boolean }): Promise<SharedAgentRecord[]> {
    const where = filter?.living === undefined
      ? ""
      : filter.living
        ? "WHERE status IN ('reserved','provisioning','active','unresponsive')"
        : "WHERE status IN ('dead','failed')";
    return this.read(async (c) => {
      const r = await c.query<AgentRow>(`SELECT * FROM fleet_agents ${where} ORDER BY created_at, agent_id`);
      return r.rows.map(toAgent);
    });
  }

  async getEvents(agentId?: string): Promise<Array<{ eventType: string; agentId: string | null; detail: Record<string, unknown> }>> {
    return this.read(async (c) => {
      const r = agentId
        ? await c.query("SELECT * FROM fleet_events WHERE agent_id = $1 ORDER BY id", [agentId])
        : await c.query("SELECT * FROM fleet_events ORDER BY id");
      return r.rows.map((e) => ({ eventType: e.event_type, agentId: e.agent_id, detail: e.detail }));
    });
  }

  /** Public wallet addresses of every fleet agent (any status). */
  async listMemberAddresses(): Promise<string[]> {
    return this.read(async (c) => {
      const r = await c.query<{ a: string }>(
        "SELECT lower(wallet_address) AS a FROM fleet_agents WHERE wallet_address IS NOT NULL",
      );
      return r.rows.map((x) => x.a);
    });
  }
}
```

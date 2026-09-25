/**
 * Genesis — owner (FleetAdmin) API (Phase F, schema v11).
 *
 * Human operator CLI only, with the admin (schema owner) credential. Never
 * reachable through the Operator API, the fleet service, an agent, Claude's
 * or ChatGPT's bridges. Every step is a named database function that checks
 * the owner actor, the authorization's content hash, expiry and state; the
 * database refuses approval and activation unless the owner has enabled
 * Genesis (fleet_genesis_policy.genesis_enabled, default off).
 *
 *   propose → approve (content hash) → provision → attest (each founder) → fund (virtual) → activate (content hash)
 *
 * Activation mints one long-lived credential per founder; each is written
 * once to its own 0600 file (never printed) and only its SHA-256 reaches the
 * database. Any founder failure rolls the whole Genesis back.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import pg from "pg";
import type { Pool, PoolClient } from "pg";
import { quoteIdent } from "../postgres/migrations.js";
import { hashAgentToken, mintAgentToken } from "../postgres/store.js";

export interface GenesisView {
  genesisId: string;
  kind: string;
  status: string;
  founderCount: number;
  manifestId: string;
  manifestSha256: string;
  templateVersion: string;
  runtime: { repo: string; commit: string; buildId: string; lockfileSha256: string };
  economicPolicySha256: string;
  allocationCents: number;
  expiresAt: string;
  requestedBy: string;
  approvedBy: string | null;
  authSha256: string;
  founderIds: string[] | null;
  statusReason: string | null;
  founders: Array<{ ordinal: number; agentId: string; status: string; workspaceId: string; stateNamespace: string; agentStatus: string }>;
  replay?: boolean;
}

export interface AttestationEvidence {
  commit: string;
  buildId: string;
  lockfileSha256: string;
  manifestSha256: string;
  workspaceId: string;
  stateNamespace: string;
}

/** Anything with a pg query method: a Pool, or a single client inside a caller-owned transaction (dry run). */
export interface GenesisDb {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

/** Write a founder credential once: 0600, never replacing an existing file. */
export function writeFounderCredential(dir: string, agentId: string, token: string, apiUrl: string | null): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `founder-${agentId}.json`);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ agentId, token, apiUrl }, null, 2), { mode: 0o600, flag: "wx" });
  try {
    fs.linkSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  fs.chmodSync(file, 0o600);
  return file;
}

export class GenesisOps {
  constructor(private readonly db: GenesisDb) {}

  private async one<T>(sql: string, params: unknown[] = []): Promise<T> {
    return (await this.db.query(sql, params)).rows[0]?.r as T;
  }

  setEnabled(enabled: boolean, actor: string, reason: string) {
    return this.one<{ genesisEnabled: boolean }>(`SELECT fleet_genesis_set_enabled($1, $2, $3) AS r`, [enabled, actor, reason]);
  }

  propose(p: { idempotencyKey: string; founderCount: number; manifestId?: string; allocationCents: number; ttlS?: number; actor: string; kind?: string }) {
    return this.one<GenesisView>(`SELECT fleet_genesis_propose($1, $2, $3, $4, $5, $6, $7) AS r`, [
      p.idempotencyKey, p.kind ?? "genesis", p.founderCount, p.manifestId ?? null, p.allocationCents, p.ttlS ?? null, p.actor,
    ]);
  }

  approve(genesisId: string, authSha256: string, actor: string) {
    return this.one<GenesisView & { code?: string }>(`SELECT fleet_genesis_approve($1, $2, $3) AS r`, [genesisId, authSha256, actor]);
  }

  abort(genesisId: string, status: "rejected" | "cancelled", actor: string, reason: string) {
    return this.one<Record<string, unknown>>(`SELECT fleet_genesis_close($1, $2, $3, $4) AS r`, [genesisId, status, actor, reason]);
  }

  provision(genesisId: string, actor: string) {
    return this.one<GenesisView & { code?: string }>(`SELECT fleet_genesis_provision($1, $2) AS r`, [genesisId, actor]);
  }

  /** v12: `evidence` is the HOST evidence; the runtime's own evidence must already be recorded. */
  attest(genesisId: string, agentId: string, evidence: AttestationEvidence | Record<string, unknown>, actor: string) {
    return this.one<{ ok: boolean; code?: string; why?: string; status?: string; genesis?: GenesisView }>(
      `SELECT fleet_genesis_attest($1, $2, $3, $4) AS r`,
      [genesisId, agentId, JSON.stringify(evidence), actor],
    );
  }

  /** Schema v12: issue (or re-issue before evidence) one founder's runtime attestation token digest + nonce. */
  issueRuntime(genesisId: string, agentId: string, tokenSha256: string, nonce: string, actor: string) {
    return this.one<{ genesisId: string; agentId: string; workspaceId: string; stateNamespace: string; manifestId: string; manifestSha256: string;
      runtime: { repo: string; commit: string; buildId: string; lockfileSha256: string } }>(
      `SELECT fleet_genesis_issue_runtime($1, $2, $3, $4, $5) AS r`, [genesisId, agentId, tokenSha256, nonce, actor]);
  }

  /** Runtime evidence recorded by the controller for a founder (null until the process submitted it). */
  async runtimeEvidence(genesisId: string, agentId: string): Promise<{ evidence: Record<string, unknown> | null; at: string | null }> {
    const r = await this.db.query(`SELECT runtime_evidence, runtime_evidence_at FROM fleet_genesis_founders WHERE genesis_id = $1 AND agent_id = $2`, [genesisId, agentId]);
    return { evidence: r.rows[0]?.runtime_evidence ?? null, at: r.rows[0]?.runtime_evidence_at ?? null };
  }

  fail(genesisId: string, agentId: string | null, reason: string, actor: string) {
    return this.one<Record<string, unknown>>(`SELECT fleet_genesis_fail($1, $2, $3, $4) AS r`, [genesisId, agentId, reason, actor]);
  }

  fund(genesisId: string, actor: string) {
    return this.one<GenesisView & { status: string }>(`SELECT fleet_genesis_fund($1, $2) AS r`, [genesisId, actor]);
  }

  /** Activation with caller-supplied token hashes (the CLI mints and stores the tokens). */
  activateWithHashes(genesisId: string, authSha256: string, tokenHashes: string[], actor: string) {
    return this.one<GenesisView>(`SELECT fleet_genesis_activate($1, $2, $3, $4) AS r`, [genesisId, authSha256, tokenHashes, actor]);
  }

  async status(genesisId: string): Promise<GenesisView | null> {
    return (await this.db.query(`SELECT fleet_genesis_json(g) AS r FROM fleet_genesis g WHERE genesis_id = $1`, [genesisId])).rows[0]?.r ?? null;
  }

  async list(): Promise<GenesisView[]> {
    return (await this.db.query(`SELECT fleet_genesis_json(g) AS r FROM fleet_genesis g ORDER BY requested_at DESC LIMIT 50`)).rows.map((x) => x.r);
  }

  async policy(): Promise<Record<string, unknown>> {
    return (await this.db.query(`SELECT to_jsonb(p) AS r FROM fleet_genesis_policy p WHERE id = 1`)).rows[0].r;
  }

  eligibility(agentId: string) {
    return this.one<Record<string, unknown>>(`SELECT fleet_reproduction_eligibility($1) AS r`, [agentId]);
  }

  reviewKnowledge(proposalId: string, promote: boolean, note: string | null, actor: string) {
    return this.one<Record<string, unknown>>(`SELECT fleet_knowledge_review($1, $2, $3, $4) AS r`, [proposalId, promote, note, actor]);
  }

  decideIdentityClaim(claimId: string, approve: boolean, ttlS: number | null, maxReads: number | null, actor: string) {
    return this.one<Record<string, unknown>>(`SELECT fleet_org_identity_decide($1, $2, $3, $4, $5) AS r`, [claimId, approve, ttlS, maxReads, actor]);
  }

  /** Current approved runtime and manifest digest: the evidence a correctly provisioned founder runtime presents. */
  async expectedEvidence(genesisId: string, agentId: string): Promise<AttestationEvidence> {
    const r = await this.db.query(
      `SELECT g.runtime_commit, g.runtime_build_id, g.runtime_lockfile_sha256, g.manifest_sha256, a.workspace_id, a.state_namespace
         FROM fleet_genesis g JOIN fleet_agents a ON a.genesis_id = g.genesis_id WHERE g.genesis_id = $1 AND a.agent_id = $2`,
      [genesisId, agentId],
    );
    const x = r.rows[0];
    if (!x) throw new Error(`${agentId} is not a founder of Genesis ${genesisId}`);
    return {
      commit: x.runtime_commit,
      buildId: x.runtime_build_id,
      lockfileSha256: x.runtime_lockfile_sha256,
      manifestSha256: x.manifest_sha256,
      workspaceId: x.workspace_id,
      stateNamespace: x.state_namespace,
    };
  }
}

/** Pool-backed owner API used by the CLI. */
export class PgGenesisAdmin extends GenesisOps {
  private readonly pool: Pool;

  constructor(opts: { connectionString: string; schema?: string }) {
    const schema = opts.schema ?? "fleet";
    quoteIdent(schema);
    const pool = new pg.Pool({
      connectionString: opts.connectionString,
      max: 2,
      application_name: "automaton-fleet-genesis-admin",
      options: `-c search_path=${schema} -c statement_timeout=60000 -c lock_timeout=10000`,
    });
    pool.on("error", () => {});
    super(pool);
    this.pool = pool;
  }

  /**
   * The owner's activation gate: mint one credential per founder, write each
   * to its own 0600 file in `credentialDir`, activate every founder in one
   * transaction. If the database refuses, the credential files are removed.
   */
  async activate(genesisId: string, authSha256: string, actor: string, credentialDir: string, apiUrl: string | null) {
    const g = await this.status(genesisId);
    if (!g || !g.founderIds) throw new Error("Genesis has no provisioned founders");
    const tokens = g.founderIds.map((id) => ({ id, token: mintAgentToken(id) }));
    const files = tokens.map((t) => writeFounderCredential(credentialDir, t.id, t.token, apiUrl));
    try {
      return { genesis: await this.activateWithHashes(genesisId, authSha256, tokens.map((t) => hashAgentToken(t.token)), actor), credentialFiles: files };
    } catch (err) {
      for (const f of files) fs.rmSync(f, { force: true });
      throw err;
    }
  }

  /** The owner connection (search_path = the fleet schema), for helpers that take a GenesisDb. */
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> {
    return this.pool.query(sql, params);
  }

  async withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      return await fn(c);
    } finally {
      c.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => {});
  }
}

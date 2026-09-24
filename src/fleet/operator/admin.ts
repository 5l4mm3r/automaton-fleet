/**
 * Operator principal lifecycle (Phase B2) — human operator CLI only, with the
 * admin (schema owner) credential. Never reachable through the Operator API.
 *
 *   enroll / add-key / revoke-key / revoke / revoke-all / api enable|disable /
 *   list / archive (audited, exported, never automatic)
 *
 * Every action writes a fleet_events row with actor operator:<os user> and
 * bumps the kill-switch generation where it changes who may authenticate, so
 * the Operator API drops its key cache. Public keys are never logged; only
 * their key id (fingerprint).
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import pg from "pg";
import type { Pool, PoolClient } from "pg";
import { ulid } from "ulid";
import { quoteIdent } from "../postgres/migrations.js";
import { redactDetail } from "../redact.js";
import { keyIdOf } from "./canonical.js";
import { requirePrivateDirectory } from "./keygen.js";
import { OPERATOR_KINDS, OPERATOR_SCOPES, type OperatorKind, type OperatorScope } from "./route-policy.js";

/** Rows per archival call (also enforced by fleet_operator_archive_check). */
export const OPERATOR_ARCHIVE_MAX_ROWS = 100_000;

export class PgOperatorAdmin {
  private readonly pool: Pool;

  constructor(opts: { connectionString: string; schema?: string }) {
    const schema = opts.schema ?? "fleet";
    quoteIdent(schema);
    this.pool = new pg.Pool({
      connectionString: opts.connectionString,
      max: 2,
      application_name: "automaton-fleet-admin",
      options: `-c search_path=${schema} -c statement_timeout=30000 -c lock_timeout=5000`,
    });
    this.pool.on("error", () => {});
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => {});
  }

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const r = await fn(c);
      await c.query("COMMIT");
      return r;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  private async event(c: PoolClient, type: string, actor: string, detail: Record<string, unknown>): Promise<void> {
    await c.query("INSERT INTO fleet_events (event_type, agent_id, actor, detail) VALUES ($1, NULL, $2, $3)", [
      type,
      actor.slice(0, 128),
      JSON.stringify(redactDetail(detail)),
    ]);
  }

  private async bumpGeneration(c: PoolClient, actor: string): Promise<number> {
    const r = await c.query<{ g: string }>(
      "UPDATE fleet_operator_state SET generation = generation + 1, updated_at = now(), updated_by = $1 WHERE id = 1 RETURNING generation AS g",
      [actor.slice(0, 128)],
    );
    return Number(r.rows[0].g);
  }

  private static publicKey(b64u: string): Buffer {
    if (!/^[A-Za-z0-9_-]{43}$/.test(b64u)) throw new Error("public key must be 43 base64url characters (32 raw bytes)");
    const raw = Buffer.from(b64u, "base64url");
    if (raw.length !== 32 || raw.toString("base64url") !== b64u) throw new Error("public key is not canonical base64url of 32 bytes");
    return raw;
  }

  private static requireActor(actor: string): void {
    if (!/^operator:[A-Za-z0-9_.-]{1,64}$/.test(actor)) throw new Error("operator lifecycle actions require an operator:<user> actor");
  }

  async enroll(p: { name: string; kind: OperatorKind; scopes: OperatorScope[]; publicKey: string; expiresDays: number; actor: string }) {
    PgOperatorAdmin.requireActor(p.actor);
    if (!OPERATOR_KINDS.includes(p.kind)) throw new Error(`kind must be one of ${OPERATOR_KINDS.join(", ")}`);
    if (!p.scopes.length || p.scopes.some((s) => !OPERATOR_SCOPES.includes(s))) throw new Error(`scopes must be from ${OPERATOR_SCOPES.join(", ")}`);
    if (!(Number.isInteger(p.expiresDays) && p.expiresDays >= 1 && p.expiresDays <= 90)) throw new Error("expires-days must be 1..90");
    const raw = PgOperatorAdmin.publicKey(p.publicKey);
    const keyId = keyIdOf(raw);
    const principalId = `op_${ulid()}`;
    return this.tx(async (c) => {
      await c.query("INSERT INTO fleet_operator_principals (principal_id, name, kind, scopes, created_by) VALUES ($1, $2, $3, $4, $5)", [
        principalId,
        p.name,
        p.kind,
        p.scopes,
        p.actor,
      ]);
      const k = await c.query<{ expires_at: Date }>(
        `INSERT INTO fleet_operator_keys (key_id, principal_id, public_key, expires_at, created_by)
         VALUES ($1, $2, $3, now() + make_interval(days => $4), $5) RETURNING expires_at`,
        [keyId, principalId, raw, p.expiresDays, p.actor],
      );
      const expiresAt = k.rows[0].expires_at.toISOString();
      const generation = await this.bumpGeneration(c, p.actor);
      await this.event(c, "operator_principal_enrolled", p.actor, { principalId, kind: p.kind, keyId, expiresAt });
      return { principalId, name: p.name, kind: p.kind, scopes: [...p.scopes].sort(), keyId, expiresAt, generation };
    });
  }

  async addKey(p: { principalId: string; publicKey: string; expiresDays: number; actor: string }) {
    PgOperatorAdmin.requireActor(p.actor);
    if (!(Number.isInteger(p.expiresDays) && p.expiresDays >= 1 && p.expiresDays <= 90)) throw new Error("expires-days must be 1..90");
    const raw = PgOperatorAdmin.publicKey(p.publicKey);
    const keyId = keyIdOf(raw);
    return this.tx(async (c) => {
      const k = await c.query<{ expires_at: Date }>(
        `INSERT INTO fleet_operator_keys (key_id, principal_id, public_key, expires_at, created_by)
         VALUES ($1, $2, $3, now() + make_interval(days => $4), $5) RETURNING expires_at`,
        [keyId, p.principalId, raw, p.expiresDays, p.actor],
      );
      const expiresAt = k.rows[0].expires_at.toISOString();
      await this.bumpGeneration(c, p.actor);
      await this.event(c, "operator_key_added", p.actor, { principalId: p.principalId, keyId, expiresAt });
      return { principalId: p.principalId, keyId, expiresAt };
    });
  }

  async revokeKey(p: { keyId: string; reason: string; actor: string }) {
    PgOperatorAdmin.requireActor(p.actor);
    return this.tx(async (c) => {
      const r = await c.query(
        "UPDATE fleet_operator_keys SET revoked_at = now(), revoked_by = $2, revoke_reason = left($3, 200) WHERE key_id = $1 AND revoked_at IS NULL",
        [p.keyId, p.actor, p.reason],
      );
      if (!r.rowCount) throw new Error(`no active key ${p.keyId}`);
      await this.bumpGeneration(c, p.actor);
      await this.event(c, "operator_key_revoked", p.actor, { keyId: p.keyId });
      return { keyId: p.keyId, revoked: true };
    });
  }

  async revokePrincipal(p: { principalId: string; reason: string; actor: string }) {
    PgOperatorAdmin.requireActor(p.actor);
    return this.tx(async (c) => {
      const r = await c.query(
        "UPDATE fleet_operator_principals SET revoked_at = now(), revoked_by = $2, revoke_reason = left($3, 200) WHERE principal_id = $1 AND revoked_at IS NULL",
        [p.principalId, p.actor, p.reason],
      );
      if (!r.rowCount) throw new Error(`no active principal ${p.principalId}`);
      const k = await c.query(
        "UPDATE fleet_operator_keys SET revoked_at = now(), revoked_by = $2, revoke_reason = left($3, 200) WHERE principal_id = $1 AND revoked_at IS NULL",
        [p.principalId, p.actor, p.reason],
      );
      await this.bumpGeneration(c, p.actor);
      await this.event(c, "operator_principal_revoked", p.actor, { principalId: p.principalId, keys: k.rowCount ?? 0 });
      return { principalId: p.principalId, revoked: true, keysRevoked: k.rowCount ?? 0 };
    });
  }

  /** Emergency: revoke every principal and key AND disable the API, in one transaction. */
  async revokeAll(p: { reason: string; actor: string }) {
    PgOperatorAdmin.requireActor(p.actor);
    return this.tx(async (c) => {
      const pr = await c.query(
        "UPDATE fleet_operator_principals SET revoked_at = now(), revoked_by = $1, revoke_reason = left($2, 200) WHERE revoked_at IS NULL",
        [p.actor, p.reason],
      );
      const k = await c.query("UPDATE fleet_operator_keys SET revoked_at = now(), revoked_by = $1, revoke_reason = left($2, 200) WHERE revoked_at IS NULL", [
        p.actor,
        p.reason,
      ]);
      await c.query("UPDATE fleet_operator_state SET operator_api_enabled = false, updated_at = now(), updated_by = $1 WHERE id = 1", [p.actor.slice(0, 128)]);
      const generation = await this.bumpGeneration(c, p.actor);
      await this.event(c, "operator_revoke_all", p.actor, { principals: pr.rowCount ?? 0, keys: k.rowCount ?? 0 });
      return { principalsRevoked: pr.rowCount ?? 0, keysRevoked: k.rowCount ?? 0, enabled: false, generation };
    });
  }

  async setEnabled(p: { enabled: boolean; reason: string; actor: string }) {
    PgOperatorAdmin.requireActor(p.actor);
    return this.tx(async (c) => {
      await c.query("UPDATE fleet_operator_state SET operator_api_enabled = $1, updated_at = now(), updated_by = $2 WHERE id = 1", [p.enabled, p.actor.slice(0, 128)]);
      const generation = await this.bumpGeneration(c, p.actor);
      await this.event(c, "operator_api_enabled_set", p.actor, { enabled: p.enabled, generation, reason: p.reason });
      return { enabled: p.enabled, generation };
    });
  }

  /** Public metadata only (no public keys). */
  async list() {
    const s = await this.pool.query(
      "SELECT operator_api_enabled AS enabled, generation::int, request_count::int AS \"requestCount\", request_cap::int AS \"requestCap\" FROM fleet_operator_state WHERE id = 1",
    );
    const principals = await this.pool.query(
      `SELECT p.principal_id AS "principalId", p.name, p.kind, p.scopes, p.created_at AS "createdAt", p.revoked_at AS "revokedAt",
              COALESCE(json_agg(json_build_object('keyId', k.key_id, 'expiresAt', k.expires_at, 'revokedAt', k.revoked_at)
                       ORDER BY k.created_at) FILTER (WHERE k.key_id IS NOT NULL), '[]') AS keys
         FROM fleet_operator_principals p LEFT JOIN fleet_operator_keys k USING (principal_id)
        GROUP BY p.principal_id ORDER BY p.created_at`,
    );
    return { state: s.rows[0], principals: principals.rows };
  }

  /**
   * Audited archival of the oldest fleet_operator_requests rows received before
   * `before` (at least one minute in the past), one bounded batch per call.
   * Fail-closed order:
   *   1. the database produces the canonical export lines;
   *   2. they are written to a NEW 0600 file (exclusive create, no symlinks, in
   *      a private directory) and fsynced;
   *   3. the file is read back and its size, mode, owner, link count, line
   *      count and SHA-256 are verified;
   *   4. only then does fleet_operator_archive_requests re-select the same rows,
   *      recompute their digest and delete them if count and digest match.
   * Any failure before or during step 4 leaves every row in the database. A
   * failure after the export exists is recorded as an
   * operator_requests_archive_failed event (no row data).
   */
  async archive(p: { before: Date; outFile: string; actor: string; maxRows?: number; afterExport?: (file: string) => void | Promise<void> }) {
    PgOperatorAdmin.requireActor(p.actor);
    if (!(p.before.getTime() < Date.now() - 60_000)) throw new Error("--before must be at least one minute in the past");
    const maxRows = p.maxRows ?? OPERATOR_ARCHIVE_MAX_ROWS;
    if (!(Number.isInteger(maxRows) && maxRows >= 1 && maxRows <= OPERATOR_ARCHIVE_MAX_ROWS)) throw new Error(`--max-rows must be 1..${OPERATOR_ARCHIVE_MAX_ROWS}`);
    const abs = path.resolve(p.outFile);
    requirePrivateDirectory(path.dirname(abs));
    const rows = await this.pool.query<{ line: string }>("SELECT line FROM fleet_operator_archive_export($1, $2)", [p.before, maxRows]);
    if (rows.rows.length === 0) return { archived: 0, exportFile: null, exportSha256: null };
    const bytes = Buffer.from(rows.rows.map((r) => `${r.line}\n`).join(""), "utf8");
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    const expected = rows.rows.length;

    const fd = fs.openSync(abs, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } catch (err) {
      fs.closeSync(fd);
      fs.rmSync(abs, { force: true }); // our own partial file (exclusive create); the rows are untouched
      throw new Error(`archival aborted at export; no request rows were deleted: ${err instanceof Error ? err.message : String(err)}`);
    }
    fs.closeSync(fd);
    let stage = "verify";
    try {
      if (p.afterExport) await p.afterExport(abs);
      PgOperatorAdmin.verifyExport(abs, bytes.length, expected, sha);
      stage = "delete";
      const r = await this.pool.query<{ n: string }>("SELECT fleet_operator_archive_requests($1, $2, $3, $4) AS n", [p.before, expected, sha, p.actor]);
      return { archived: Number(r.rows[0].n), exportFile: abs, exportSha256: sha };
    } catch (err) {
      await this.tx((c) => this.event(c, "operator_requests_archive_failed", p.actor, { stage, rows: expected, before: p.before.toISOString() })).catch(() => {});
      throw new Error(`archival aborted at ${stage}; no request rows were deleted (export left at ${abs}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Re-read the export from disk and prove it is exactly what the database produced. */
  private static verifyExport(file: string, size: number, lines: number, sha: string): void {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) throw new Error("export is not a regular file");
      if ((st.mode & 0o777) !== 0o600) throw new Error(`export mode is ${(st.mode & 0o777).toString(8)}, expected 600`);
      if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error("export is owned by another user");
      if (st.nlink !== 1) throw new Error("export has extra hard links");
      if (st.size !== size) throw new Error(`export size ${st.size} != ${size}`);
      const data = fs.readFileSync(fd);
      if (data.length !== size) throw new Error("export changed while reading");
      let n = 0;
      for (const b of data) if (b === 0x0a) n++;
      if (n !== lines || data[data.length - 1] !== 0x0a) throw new Error(`export has ${n} lines, expected ${lines}`);
      if (crypto.createHash("sha256").update(data).digest("hex") !== sha) throw new Error("export digest mismatch");
    } finally {
      fs.closeSync(fd);
    }
  }
}

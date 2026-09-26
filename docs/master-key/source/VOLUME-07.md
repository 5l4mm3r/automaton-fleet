# SOURCE VOLUME 07 — Operator API B2 (src/fleet/operator)

Exact, byte-for-byte text of each file at repository commit `efad2148a3460ab881b0ab845fb13c25d1fa3e74` (branch fleet-development).
No file in this volume contains a real secret; test fixtures generate synthetic secrets at runtime.
Each file's SHA-256 is of the file bytes on disk and matches 22-RECONSTRUCTION-MANIFEST.md.

## Files

- `src/fleet/operator/admin.ts` — 283 lines, sha256 `5ac548519ab22e967bfc7002e735cff2840b3b83e031dad0f238ba244912079d`
- `src/fleet/operator/canonical.ts` — 223 lines, sha256 `a285cd01fb7e6f04e11983b02d9f7aed1d1678164cd7e48489fa2483f8de3fdb`
- `src/fleet/operator/gateway.ts` — 155 lines, sha256 `09021a68963a36c08a272ab40ec17c561883e12b39bfb099fffc32ecbc1c47b5`
- `src/fleet/operator/keygen.ts` — 78 lines, sha256 `c4c7974dc881a99974ed5b480b83ac98cbe5a99401205489211f86267d2ed54d`
- `src/fleet/operator/main.ts` — 209 lines, sha256 `9540bb16ebcce5cfd3f8632cfc755a180b1563422ca3574d893dc3f70a0deb55`
- `src/fleet/operator/responses.ts` — 250 lines, sha256 `5126c7edb68f311a8dc9b0e37815d8230b4427a11e2263b29879038c880824c8`
- `src/fleet/operator/route-policy.ts` — 94 lines, sha256 `91df7bd9c57cfe5c5472d0235838df45dd4205f71019af1a4f736f8e81bdfa9d`
- `src/fleet/operator/server.ts` — 490 lines, sha256 `8901fd9fc371727cdc4e61cfa0cfbb9e9ed6d41a2a424c991bc9a7fb41cc7400`

## `src/fleet/operator/admin.ts`

sha256 `5ac548519ab22e967bfc7002e735cff2840b3b83e031dad0f238ba244912079d` · 14664 bytes · 283 lines

```ts
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
```

## `src/fleet/operator/canonical.ts`

sha256 `a285cd01fb7e6f04e11983b02d9f7aed1d1678164cd7e48489fa2483f8de3fdb` · 8533 bytes · 223 lines

```ts
/**
 * Operator API request authentication (Phase B2): strict request-target
 * canonicalization and Ed25519 request signatures (FLEET-OP-SIG-V1).
 *
 * Nothing here normalizes: a request target or header that is not already
 * canonical is rejected, so independent implementations cannot disagree
 * about encoding, query order, duplicates or empty bodies.
 *
 * String to sign (nine lines, LF-separated, no trailing LF, ASCII):
 *
 *   FLEET-OP-SIG-V1
 *   <principal_id>        op_<ULID>
 *   <key_id>              32 lowercase hex = first half of sha256(raw public key)
 *   <METHOD>              exactly as received ("GET" in v1)
 *   <path>                raw path, /v1/operator(/segment)+, lowercase, no %, no empty/dot segments
 *   <query>               raw query without "?", already canonical ("" when absent)
 *   <timestamp>           epoch milliseconds, 13 digits
 *   <nonce>               base64url, 22-64 chars (>= 128 bits)
 *   <body_sha256_hex>     sha256 of the raw body bytes (empty body in v1)
 *
 * Only Node's built-in crypto is used (Ed25519, RFC 8032, no prehash).
 */

import crypto, { type KeyObject } from "crypto";

export const OP_SIG_VERSION = "FLEET-OP-SIG-V1";

export const OP_HEADERS = Object.freeze({
  principal: "x-fleet-op-principal",
  key: "x-fleet-op-key",
  timestamp: "x-fleet-op-timestamp",
  nonce: "x-fleet-op-nonce",
  signature: "x-fleet-op-signature",
});

export const EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export const OP_LIMITS = Object.freeze({
  maxTargetBytes: 2048,
  maxHeaderBytes: 8192,
  skewMs: 30_000,
});

export const PRINCIPAL_RE = /^op_[0-9A-HJKMNP-TV-Z]{26}$/;
export const KEY_ID_RE = /^[0-9a-f]{32}$/;
const TIMESTAMP_RE = /^[1-9][0-9]{12}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{22,64}$/;
const SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/;
const PATH_RE = /^\/v1\/operator(\/[a-z0-9][a-z0-9_-]{0,63})+$/;
const QUERY_KEY_RE = /^[a-z][a-z_]{0,31}$/;
const QUERY_VALUE_RE = /^[A-Za-z0-9._~-]{1,128}$/;

export type OpErrorCode =
  | "FLEET_OP_BAD_REQUEST"
  | "FLEET_OP_NONCANONICAL"
  | "FLEET_OP_BAD_PARAM"
  | "FLEET_OP_STALE"
  | "FLEET_OP_AUTH_FAILED"
  | "FLEET_OP_SCOPE_DENIED"
  | "FLEET_OP_NOT_FOUND"
  | "FLEET_OP_REPLAYED"
  | "FLEET_OP_RATE_LIMITED"
  | "FLEET_OP_INTERNAL"
  | "FLEET_OP_DISABLED"
  | "FLEET_OP_AUDIT_FULL";

export type TargetResult =
  | { ok: true; path: string; query: string; params: Record<string, string> }
  | { ok: false; code: "FLEET_OP_BAD_REQUEST" | "FLEET_OP_NONCANONICAL" };

/**
 * Parse the raw request target. Rejects (never normalizes) anything that is
 * not canonical: percent-encoding, "+", empty/bare/duplicate/unsorted query
 * parameters, fragments, dot segments, trailing slashes, uppercase.
 */
export function parseTarget(raw: string): TargetResult {
  if (typeof raw !== "string" || raw.length === 0 || Buffer.byteLength(raw, "utf8") > OP_LIMITS.maxTargetBytes) {
    return { ok: false, code: "FLEET_OP_BAD_REQUEST" };
  }
  if (!/^[\x21-\x7e]+$/.test(raw) || raw.includes("#")) return { ok: false, code: "FLEET_OP_NONCANONICAL" };
  const q = raw.indexOf("?");
  const path = q < 0 ? raw : raw.slice(0, q);
  const query = q < 0 ? "" : raw.slice(q + 1);
  if (!PATH_RE.test(path)) return { ok: false, code: "FLEET_OP_NONCANONICAL" };
  const params: Record<string, string> = {};
  if (q >= 0) {
    if (query === "") return { ok: false, code: "FLEET_OP_NONCANONICAL" };
    let prev = "";
    for (const part of query.split("&")) {
      const eq = part.indexOf("=");
      if (eq <= 0) return { ok: false, code: "FLEET_OP_NONCANONICAL" };
      const k = part.slice(0, eq);
      const v = part.slice(eq + 1);
      if (!QUERY_KEY_RE.test(k) || !QUERY_VALUE_RE.test(v)) return { ok: false, code: "FLEET_OP_NONCANONICAL" };
      if (prev !== "" && !(k > prev)) return { ok: false, code: "FLEET_OP_NONCANONICAL" }; // unsorted or duplicate
      prev = k;
      params[k] = v;
    }
  }
  return { ok: true, path, query, params };
}

export interface SignedFields {
  principal: string;
  key: string;
  method: string;
  path: string;
  query: string;
  timestamp: string;
  nonce: string;
  bodySha256: string;
}

export function canonicalString(f: SignedFields): string {
  return [OP_SIG_VERSION, f.principal, f.key, f.method, f.path, f.query, f.timestamp, f.nonce, f.bodySha256].join("\n");
}

export function bodyDigest(body: Buffer | string): string {
  return crypto.createHash("sha256").update(body).digest("hex");
}

export interface OpHeaderValues {
  principal: string;
  key: string;
  timestamp: string;
  nonce: string;
  signature: string;
}

/**
 * Exactly one of each X-Fleet-Op-* header, in its exact format; no
 * Authorization (agent credentials never cross over) and no Cookie.
 */
export function readOpHeaders(headers: Record<string, string[] | undefined>): { ok: true; values: OpHeaderValues } | { ok: false } {
  if (headers.authorization !== undefined || headers.cookie !== undefined) return { ok: false };
  const one = (name: string, re: RegExp): string | null => {
    const v = headers[name];
    if (!v || v.length !== 1 || !re.test(v[0])) return null;
    return v[0];
  };
  const principal = one(OP_HEADERS.principal, PRINCIPAL_RE);
  const key = one(OP_HEADERS.key, KEY_ID_RE);
  const timestamp = one(OP_HEADERS.timestamp, TIMESTAMP_RE);
  const nonce = one(OP_HEADERS.nonce, NONCE_RE);
  const signature = one(OP_HEADERS.signature, SIGNATURE_RE);
  if (!principal || !key || !timestamp || !nonce || !signature) return { ok: false };
  return { ok: true, values: { principal, key, timestamp, nonce, signature } };
}

/** base64url, no padding, exactly 64 bytes, and canonical (re-encodes to the same string). */
export function decodeSignature(sig: string): Buffer | null {
  if (!SIGNATURE_RE.test(sig)) return null;
  const b = Buffer.from(sig, "base64url");
  if (b.length !== 64 || b.toString("base64url") !== sig) return null;
  return b;
}

/** First 32 hex chars of sha256(raw 32-byte public key). */
export function keyIdOf(rawPublicKey: Buffer): string {
  return crypto.createHash("sha256").update(rawPublicKey).digest("hex").slice(0, 32);
}

/** Raw 32-byte Ed25519 public key -> KeyObject. */
export function publicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new Error("Ed25519 public key must be 32 bytes");
  return crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
}

/** Raw 32-byte public key of an Ed25519 KeyObject (public or private). */
export function rawPublicKey(key: KeyObject): Buffer {
  const pub = key.type === "private" ? crypto.createPublicKey(key) : key;
  const jwk = pub.export({ format: "jwk" }) as { x?: string; crv?: string };
  if (jwk.crv !== "Ed25519" || !jwk.x) throw new Error("not an Ed25519 key");
  return Buffer.from(jwk.x, "base64url");
}

export function verifySignature(publicKey: KeyObject, canonical: string, signature: Buffer): boolean {
  try {
    return crypto.verify(null, Buffer.from(canonical, "utf8"), publicKey, signature);
  } catch {
    return false;
  }
}

/** Client side (bridges, tests): sign the canonical string; returns base64url. */
export function signCanonical(privateKey: KeyObject, canonical: string): string {
  return crypto.sign(null, Buffer.from(canonical, "utf8"), privateKey).toString("base64url");
}

/** Client side: fresh nonce (144 random bits, base64url). */
export function newNonce(): string {
  return crypto.randomBytes(18).toString("base64url");
}

/**
 * Client side: headers for one signed GET request to `target` (path+query,
 * already canonical). The private key never leaves the caller.
 */
export function signedHeaders(
  privateKey: KeyObject,
  principal: string,
  target: string,
  opts: { method?: string; now?: number; nonce?: string; keyId?: string } = {},
): Record<string, string> {
  const q = target.indexOf("?");
  const fields: SignedFields = {
    principal,
    key: opts.keyId ?? keyIdOf(rawPublicKey(privateKey)),
    method: opts.method ?? "GET",
    path: q < 0 ? target : target.slice(0, q),
    query: q < 0 ? "" : target.slice(q + 1),
    timestamp: String(opts.now ?? Date.now()),
    nonce: opts.nonce ?? newNonce(),
    bodySha256: EMPTY_BODY_SHA256,
  };
  return {
    [OP_HEADERS.principal]: fields.principal,
    [OP_HEADERS.key]: fields.key,
    [OP_HEADERS.timestamp]: fields.timestamp,
    [OP_HEADERS.nonce]: fields.nonce,
    [OP_HEADERS.signature]: signCanonical(privateKey, canonicalString(fields)),
  };
}
```

## `src/fleet/operator/gateway.ts`

sha256 `09021a68963a36c08a272ab40ec17c561883e12b39bfb099fffc32ecbc1c47b5` · 6767 bytes · 155 lines

```ts
/**
 * Operator API database gateway (Phase B2). Connects ONLY as the restricted
 * fleet_operator_login role (FLEET_OPERATOR_DATABASE_URL) and calls ONLY the
 * op_* functions; it never issues table SQL. The admin, service and agent
 * credentials are never available to this process.
 */

import pg from "pg";
import type { Pool } from "pg";
import { quoteIdent } from "../postgres/migrations.js";
import { auditPrivileges, DEFAULT_OPERATOR_ROLES, type PrivilegeAuditResult } from "../postgres/privileges.js";

export interface PingResult {
  schemaVersion: number | null;
  operatorApiEnabled: boolean;
  generation: number;
  requestCount: number;
  requestCap: number;
  dbTime: string;
  runtimeRepo: string | null;
  runtimeCommit: string | null;
  runtimeBuildId: string | null;
  runtimeLockfileSha256: string | null;
}

export interface KeyMaterial {
  ok: boolean;
  publicKey?: string;
  kind?: string;
  scopes?: string[];
  expiresAt?: string;
}

export type BeginResult = { ok: true; requestId: string; fn: string; requestCount: number; requestCap: number } | { ok: false; code: string };

/** What the Operator API server needs from the database (a fake implements it in tests). */
export interface OperatorGateway {
  ping(): Promise<PingResult>;
  keyMaterial(principal: string, key: string): Promise<KeyMaterial>;
  beginRequest(a: { principal: string; key: string; route: string; clientTsMs: number; nonce: string; bodySha256: string }): Promise<BeginResult>;
  whoami(requestId: string): Promise<Record<string, unknown>>;
  fleetStatus(requestId: string): Promise<Record<string, unknown>>;
  listAgents(requestId: string, after: string | null, limit: number): Promise<{ items: Record<string, unknown>[]; limit: number }>;
  getAgent(requestId: string, agentId: string): Promise<{ found: boolean; item?: Record<string, unknown> }>;
  listEvents(requestId: string, after: string | null, limit: number, type: string | null): Promise<{ items: Record<string, unknown>[]; limit: number }>;
  close(): Promise<void>;
}

export class PgOperatorGateway implements OperatorGateway {
  private readonly pool: Pool;
  private readonly s: string;

  constructor(opts: { connectionString: string; schema?: string; poolMax?: number }) {
    const schema = opts.schema ?? "fleet";
    this.s = quoteIdent(schema);
    this.pool = new pg.Pool({
      connectionString: opts.connectionString,
      max: opts.poolMax ?? 4,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 10_000,
      allowExitOnIdle: true,
      application_name: "automaton-fleet-operator-api",
      options: `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=10000`,
    });
    this.pool.on("error", () => {});
  }

  private async fn<T>(sql: string, params: unknown[]): Promise<T> {
    const r = await this.pool.query<{ r: T }>(sql, params);
    return r.rows[0].r;
  }

  /**
   * Every read runs in its own READ ONLY transaction: whatever an op_* read
   * function (or anything it calls, directly or via dynamic SQL) tries, the
   * server refuses any write, sequence change, NOTIFY or large-object write.
   * Only op_begin_request (fn) runs read-write.
   */
  private async ro<T>(sql: string, params: unknown[]): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN TRANSACTION READ ONLY");
      const r = await c.query<{ r: T }>(sql, params);
      await c.query("COMMIT");
      return r.rows[0].r;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  async ping(): Promise<PingResult> {
    return this.ro<PingResult>(`SELECT ${this.s}.op_ping() AS r`, []);
  }

  async keyMaterial(principal: string, key: string): Promise<KeyMaterial> {
    return this.ro<KeyMaterial>(`SELECT ${this.s}.op_key_material($1, $2) AS r`, [principal, key]);
  }

  async beginRequest(a: { principal: string; key: string; route: string; clientTsMs: number; nonce: string; bodySha256: string }): Promise<BeginResult> {
    return this.fn<BeginResult>(`SELECT ${this.s}.op_begin_request($1, $2, $3, $4, $5, $6) AS r`, [
      a.principal,
      a.key,
      a.route,
      a.clientTsMs,
      a.nonce,
      a.bodySha256,
    ]);
  }

  async whoami(requestId: string): Promise<Record<string, unknown>> {
    return this.ro(`SELECT ${this.s}.op_whoami($1) AS r`, [requestId]);
  }

  async fleetStatus(requestId: string): Promise<Record<string, unknown>> {
    return this.ro(`SELECT ${this.s}.op_fleet_status($1) AS r`, [requestId]);
  }

  async listAgents(requestId: string, after: string | null, limit: number): Promise<{ items: Record<string, unknown>[]; limit: number }> {
    return this.ro(`SELECT ${this.s}.op_list_agents($1, $2, $3) AS r`, [requestId, after, limit]);
  }

  async getAgent(requestId: string, agentId: string): Promise<{ found: boolean; item?: Record<string, unknown> }> {
    return this.ro(`SELECT ${this.s}.op_get_agent($1, $2) AS r`, [requestId, agentId]);
  }

  async listEvents(requestId: string, after: string | null, limit: number, type: string | null): Promise<{ items: Record<string, unknown>[]; limit: number }> {
    return this.ro(`SELECT ${this.s}.op_list_events($1, $2, $3, $4) AS r`, [requestId, after, limit, type]);
  }

  /** Who this connection is, and whether it is anything more than the operator role. */
  async identity(): Promise<{ user: string; isOwner: boolean; superuser: boolean; memberOf: string[] }> {
    const r = await this.pool.query<{ u: string; owner: string | null; su: boolean; m: string[] | null }>(
      `SELECT current_user AS u, (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = current_schema()) AS owner,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su,
              ARRAY(SELECT rolname::text FROM pg_roles WHERE rolname <> current_user AND pg_has_role(current_user, oid, 'MEMBER') ORDER BY 1) AS m`,
    );
    const row = r.rows[0];
    return { user: row.u, isOwner: row.owner === row.u, superuser: row.su === true, memberOf: row.m ?? [] };
  }

  /** Privilege audit restricted to the operator roles (the agent/service roles are the controller's concern). */
  async auditOperator(schema = "fleet"): Promise<PrivilegeAuditResult> {
    // The connected login is audited too, whatever its name.
    const who = (await this.pool.query<{ u: string }>("SELECT current_user AS u")).rows[0].u;
    const roles = [...new Set([...DEFAULT_OPERATOR_ROLES, who])];
    return auditPrivileges(this.pool, { schema, agentRoles: [], serviceRoles: [], operatorRoles: roles, requireOperatorRoles: true });
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => {});
  }
}
```

## `src/fleet/operator/keygen.ts`

sha256 `c4c7974dc881a99974ed5b480b83ac98cbe5a99401205489211f86267d2ed54d` · 3661 bytes · 78 lines

```ts
/**
 * Operator key generation (Phase B2). Runs ON THE BRIDGE HOST as the
 * bridge's own user — never on the controller, never with a database
 * credential:
 *
 *   pnpm fleet:operator-keygen <private-key-file>
 *
 * Writes an Ed25519 private key (PKCS#8 PEM) with exclusive create, mode
 * 0600, into a directory that is not group/world-writable and not a symlink.
 * Prints ONLY the public key (base64url, 32 raw bytes) and its key id; the
 * operator enrolls those with `fleet:admin operator-enroll` and compares the
 * key id out of band. The private key never appears on stdout or in logs.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { keyIdOf, rawPublicKey } from "./canonical.js";

/** A directory for private output: real (no symlink anywhere in its path), owned by this user, not group/world-writable. */
export function requirePrivateDirectory(dir: string): void {
  const d = fs.lstatSync(dir);
  if (d.isSymbolicLink() || !d.isDirectory()) throw new Error(`${dir} must be a real directory`);
  if (fs.realpathSync(dir) !== dir) throw new Error(`${dir} resolves through a symlink`);
  if (typeof process.getuid === "function" && d.uid !== process.getuid()) throw new Error(`${dir} is not owned by this user`);
  if (d.mode & 0o022) throw new Error(`${dir} is group/world-writable (mode ${(d.mode & 0o777).toString(8)})`);
}

export function generateOperatorKey(file: string): { publicKey: string; keyId: string; file: string } {
  const abs = path.resolve(file);
  requirePrivateDirectory(path.dirname(abs));
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const fd = fs.openSync(abs, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(fd, pem);
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
  const raw = rawPublicKey(privateKey);
  return { publicKey: raw.toString("base64url"), keyId: keyIdOf(raw), file: abs };
}

/** Load a private key written by generateOperatorKey (bridge side). Refuses loose permissions. */
export function loadOperatorPrivateKey(file: string): crypto.KeyObject {
  // Open once without following symlinks, then check and read that same descriptor (no check-then-read race).
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let pem: Buffer;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(`${file} must be a regular file`);
    if (st.mode & 0o077) throw new Error(`${file} must be mode 0600 (is ${(st.mode & 0o777).toString(8)})`);
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`${file} is not owned by this user`);
    if (st.nlink !== 1) throw new Error(`${file} has extra hard links`);
    pem = fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const key = crypto.createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`${file} is not an Ed25519 private key`);
  return key;
}

if (process.argv[1] && /fleet[\\/]operator[\\/]keygen\.(ts|js)$/.test(process.argv[1])) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: fleet:operator-keygen <private-key-file>   (run on the bridge host as the bridge user)");
    process.exit(2);
  }
  try {
    const r = generateOperatorKey(file);
    console.log(JSON.stringify({ publicKey: r.publicKey, keyId: r.keyId, privateKeyFile: r.file }));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
```

## `src/fleet/operator/main.ts`

sha256 `9540bb16ebcce5cfd3f8632cfc755a180b1563422ca3574d893dc3f70a0deb55` · 10211 bytes · 209 lines

```ts
/**
 * Operator API entrypoint (Phase B2): `node dist/fleet/operator/main.js`,
 * run by deploy/systemd/automaton-fleet-operator-api.service as its own
 * system user, from the same pinned release as FleetController.
 *
 * Startup refuses (fail closed) when:
 *  - running as root, or not as FLEET_OPERATOR_EXPECTED_USER;
 *  - any admin/service/agent/Conway/wallet credential is visible, or
 *    admin.env / service.env / the TLS key is readable by this process;
 *  - FLEET_OPERATOR_DATABASE_URL is missing;
 *  - the listen address is not loopback;
 *  - any safety switch is on;
 *  - the pinned release is incomplete or differs from the registry approval;
 *  - the database login is the schema owner, a superuser, or a member of
 *    anything but fleet_operator;
 *  - the schema is not v8, or the operator privilege audit reports anything.
 */

import fs from "fs";
import os from "os";
import { createAuditSink, createJsonLogger, type Logger } from "../service/log.js";
import {
  DEFAULT_ADMIN_ENV_FILE,
  DEFAULT_RUNTIME_ENV_FILE,
  DEFAULT_SERVICE_ENV_FILE,
  DEFAULT_TLS_KEY_FILE,
  OPERATOR_FORBIDDEN_ENV,
  loadOperatorEnv,
  readEnvFile,
} from "../secret-files.js";
import { loadRuntimeRelease, normalizeRepoUrl } from "../runtime.js";
import { PgOperatorGateway } from "./gateway.js";
import { OPERATOR_SCHEMA_VERSION, OperatorService } from "./server.js";
import type { RuntimeFlagsView } from "./responses.js";
import { redactText } from "../redact.js";

export const DEFAULT_OPERATOR_LISTEN = "127.0.0.1:8788";
export const DEFAULT_TIMESYNC_MARKER = "/run/systemd/timesync/synchronized";
const SAFETY_SWITCHES = ["REAL_REPLICATION_ENABLED", "REAL_PAYMENTS_ENABLED", "OWNER_SWEEP_ENABLED", "FLEET_DRY_RUN_CHILD"];
const on = (v: string | undefined) => v?.trim().toLowerCase() === "true";

export function parseOperatorListen(v: string | undefined): { host: string; port: number } {
  const s = (v ?? DEFAULT_OPERATOR_LISTEN).trim();
  const m = /^(127\.0\.0\.1|\[::1\]|localhost):([0-9]{1,5})$/.exec(s);
  if (!m) throw new Error(`FLEET_OPERATOR_LISTEN must be a loopback address (got ${redactText(s)})`);
  const port = Number(m[2]);
  if (port < 1 || port > 65535) throw new Error("FLEET_OPERATOR_LISTEN port out of range");
  return { host: m[1] === "[::1]" ? "::1" : m[1], port };
}

export interface OperatorStartOptions {
  log?: Logger;
  uid?: number | null;
  username?: string;
  /** Files this process must NOT be able to read (defaults: admin.env, service.env, TLS key). */
  secretFiles?: string[];
  timesyncMarker?: string;
  installSignalHandlers?: boolean;
  /** Tests: override the listen address. */
  listen?: { host: string; port: number };
}

/** Controller and witness secrets the Operator API process must not be able to read. */
export const OPERATOR_UNREADABLE_FILES: readonly string[] = [
  DEFAULT_ADMIN_ENV_FILE,
  DEFAULT_SERVICE_ENV_FILE,
  DEFAULT_TLS_KEY_FILE,
  "/etc/automaton-fleet/legacy-env-fleet.bak",
  "/run/credentials/automaton-fleet.service/service.env",
  "/run/credentials/automaton-fleet.service/tls.key",
  "/var/lib/automaton-fleet-witness/fleet-credentials.json",
];

/** Startup problems that need no database. Names only, never values. */
export function operatorEnvProblems(
  e: Record<string, string | undefined>,
  opts: { uid?: number | null; username?: string; secretFiles?: string[] } = {},
): string[] {
  const problems: string[] = [];
  const uid = opts.uid === undefined ? (typeof process.getuid === "function" ? process.getuid() : null) : opts.uid;
  if (uid === 0) problems.push("refusing to run as root (uid 0)");
  const expected = e.FLEET_OPERATOR_EXPECTED_USER?.trim();
  const user = opts.username ?? os.userInfo().username;
  if (expected && user !== expected) problems.push(`running as ${user}, expected ${expected}`);
  if (!expected && e.NODE_ENV === "production") problems.push("FLEET_OPERATOR_EXPECTED_USER is required in production");
  for (const k of OPERATOR_FORBIDDEN_ENV) if (e[k]) problems.push(`${k} present (the Operator API must hold no admin/service/agent/Conway/wallet credential)`);
  for (const f of opts.secretFiles ?? OPERATOR_UNREADABLE_FILES) {
    try {
      fs.accessSync(f, fs.constants.R_OK);
      problems.push(`controller secret ${f} is readable by this process`);
    } catch {
      // not readable (or absent): as intended
    }
  }
  if (!e.FLEET_OPERATOR_DATABASE_URL?.trim()) problems.push("FLEET_OPERATOR_DATABASE_URL is not configured (operator.env)");
  for (const s of SAFETY_SWITCHES) if (on(e[s])) problems.push(`${s}=true (the Operator API refuses to run with a safety switch on)`);
  if (!loadRuntimeRelease(e)) problems.push("no complete pinned runtime release (FLEET_RUNTIME_REPO/_COMMIT/_BUILD_ID/_LOCKFILE_SHA256)");
  try {
    parseOperatorListen(e.FLEET_OPERATOR_LISTEN);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }
  return problems;
}

/** Safety switches as this process can see them; unknown (null) when runtime.env cannot be read. */
function flagsFrom(file: string): RuntimeFlagsView {
  let env: Record<string, string>;
  try {
    if (!fs.existsSync(file)) throw new Error("missing");
    env = readEnvFile(file);
  } catch {
    return { realReplicationEnabled: null, realPaymentsEnabled: null, ownerSweepEnabled: null, dryRunChildEnabled: null };
  }
  return {
    realReplicationEnabled: on(env.REAL_REPLICATION_ENABLED),
    realPaymentsEnabled: on(env.REAL_PAYMENTS_ENABLED),
    ownerSweepEnabled: on(env.OWNER_SWEEP_ENABLED),
    dryRunChildEnabled: on(env.FLEET_DRY_RUN_CHILD),
  };
}

export async function startOperatorApiFromEnv(
  e: Record<string, string | undefined>,
  opts: OperatorStartOptions = {},
): Promise<{ service: OperatorService; url: string; close: () => Promise<void> }> {
  const log = opts.log ?? createJsonLogger(undefined, "automaton-fleet-operator-api");
  const envProblems = operatorEnvProblems(e, opts);
  if (envProblems.length) throw new Error(`Operator API startup refused: ${envProblems.join("; ")}`);
  const listen = opts.listen ?? parseOperatorListen(e.FLEET_OPERATOR_LISTEN);
  const schema = e.FLEET_PG_SCHEMA?.trim() || "fleet";
  const gateway = new PgOperatorGateway({ connectionString: e.FLEET_OPERATOR_DATABASE_URL!.trim(), schema });
  try {
    const who = await gateway.identity();
    if (who.isOwner || who.superuser) throw new Error(`the operator database login must be the restricted role, not ${who.isOwner ? "the schema owner" : "a superuser"} ${who.user}`);
    const expectedLogin = e.FLEET_OPERATOR_DB_LOGIN?.trim() || "fleet_operator_login";
    if (who.user !== expectedLogin) throw new Error(`the operator database login is ${who.user}, expected ${expectedLogin}`);
    const extra = who.memberOf.filter((r) => r !== "fleet_operator");
    if (extra.length) throw new Error(`the operator database login is a member of ${extra.join(", ")}`);
    const ping = await gateway.ping();
    if (ping.schemaVersion !== OPERATOR_SCHEMA_VERSION) throw new Error(`registry schema v${ping.schemaVersion ?? "none"} != required v${OPERATOR_SCHEMA_VERSION}`);
    const release = loadRuntimeRelease(e)!;
    const approvedRepo = ping.runtimeRepo ? normalizeRepoUrl(ping.runtimeRepo) : null;
    if (
      approvedRepo !== normalizeRepoUrl(release.repo) ||
      ping.runtimeCommit !== release.commit ||
      ping.runtimeBuildId !== release.buildId ||
      ping.runtimeLockfileSha256 !== release.lockfileSha256
    ) {
      throw new Error("pinned runtime release differs from the registry-approved runtime");
    }
    const audit = await gateway.auditOperator(schema);
    if (!audit.ok) throw new Error(`operator privilege audit failed: ${audit.problems.join("; ")}`);
  } catch (err) {
    await gateway.close();
    throw new Error(`Operator API startup refused: ${redactText(err instanceof Error ? err.message : String(err))}`);
  }

  const timesync = opts.timesyncMarker ?? e.FLEET_OPERATOR_TIMESYNC_MARKER?.trim() ?? DEFAULT_TIMESYNC_MARKER;
  const requireTimesync = e.FLEET_OPERATOR_REQUIRE_TIMESYNC?.trim().toLowerCase() !== "false";
  let privCache: { at: number; ok: boolean } = { at: 0, ok: false };
  const service = new OperatorService({
    gateway,
    audit: createAuditSink(log, e.FLEET_OPERATOR_AUDIT_LOG?.trim() || undefined),
    runtimeFlags: () => flagsFrom(e.FLEET_RUNTIME_ENV_FILE?.trim() || DEFAULT_RUNTIME_ENV_FILE),
    readinessChecks: async () => {
      if (Date.now() - privCache.at > 60_000) privCache = { at: Date.now(), ok: (await gateway.auditOperator(schema)).ok };
      const p = await gateway.ping();
      const skewOk = Math.abs(new Date(p.dbTime).getTime() - Date.now()) <= 5_000;
      const synced = !requireTimesync || fs.existsSync(timesync);
      return { privileges: { ok: privCache.ok }, clock: { ok: skewOk && synced } };
    },
  });
  const { url } = await service.listen(listen.port, listen.host);
  log("info", "operator_api_started", { url, schemaVersion: OPERATOR_SCHEMA_VERSION });
  const close = async () => {
    await service.close();
    await gateway.close();
  };
  if (opts.installSignalHandlers) {
    const stop = () => void close().then(() => process.exit(0));
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  }
  return { service, url, close };
}

if (process.argv[1] && /fleet[\\/]operator[\\/]main\.(ts|js)$/.test(process.argv[1])) {
  const log = createJsonLogger(undefined, "automaton-fleet-operator-api");
  process.on("uncaughtException", (err) => {
    log("fatal", "uncaught_exception", { error: err.message });
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    log("fatal", "unhandled_rejection", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
  let env: Record<string, string | undefined>;
  try {
    env = loadOperatorEnv().env;
  } catch (err) {
    log("fatal", "startup_failed", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
  startOperatorApiFromEnv(env, { log, installSignalHandlers: true }).catch((err) => {
    log("fatal", "startup_failed", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
```

## `src/fleet/operator/responses.ts`

sha256 `5126c7edb68f311a8dc9b0e37815d8230b4427a11e2263b29879038c880824c8` · 11797 bytes · 250 lines

```ts
/**
 * Operator API response builders (Phase B2).
 *
 * Every response is rebuilt from typed fields; nothing from the database is
 * passed through as-is. Rules:
 *  - agent- or externally-influenced text (agent names, reasons, "why") is
 *    returned ONLY as { kind: "untrusted_text", value, truncated }, after the
 *    canonical B0 redactor (redactText) and whitespace flattening;
 *  - enums are validated against known values ("unknown" otherwise);
 *  - identifiers and hashes are format-checked (dropped otherwise);
 *  - event detail is rebuilt from a per-event-type allow-list; unknown types
 *    return detail {} with detailOmitted: true; IPs and raw actors are dropped;
 *  - each finished item then passes through B0 redactDetail (per item, never
 *    the whole response: whole-response redaction would truncate pages).
 * The server adds no prose, Markdown or instruction-like framing.
 */

import { redactDetail, redactText } from "../redact.js";

export interface UntrustedText {
  kind: "untrusted_text";
  value: string;
  truncated: boolean;
}

export const UNTRUSTED_MAX = 200;
const TRUNC_MARK = "...[truncated]";

export function untrusted(v: unknown): UntrustedText {
  const text = typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
  const red = redactText(text).replace(/[\t\n]+/g, " ");
  let value = red;
  let truncated = red.endsWith(TRUNC_MARK);
  if (truncated) value = value.slice(0, -TRUNC_MARK.length);
  if (value.length > UNTRUSTED_MAX) {
    value = value.slice(0, UNTRUSTED_MAX);
    if (/[\uD800-\uDBFF]$/.test(value)) value = value.slice(0, -1);
    truncated = true;
  }
  return { kind: "untrusted_text", value, truncated };
}

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const hex40 = (v: unknown): string | null => (typeof v === "string" && HEX40.test(v) ? v : null);
const hex64 = (v: unknown): string | null => (typeof v === "string" && HEX64.test(v) ? v : null);
const enumOf = <T extends string>(v: unknown, values: readonly T[]): T | "unknown" => (typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : "unknown");
/** Agent ids travel as lowercase ULIDs on the wire. */
export const wireId = (v: unknown): string | null => (typeof v === "string" && ULID.test(v) ? v.toLowerCase() : null);
export const dbId = (wire: string): string => wire.toUpperCase();
function iso(v: unknown): string | null {
  if (typeof v !== "string" && !(v instanceof Date)) return null;
  const t = new Date(v as string).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const AGENT_STATUSES = ["reserved", "provisioning", "active", "unresponsive", "terminating", "orphaned", "dead", "failed"] as const;
const MODES = ["DEVELOPMENT", "EXPANSION", "HARVEST", "EMERGENCY"] as const;

export function agentItem(a: Record<string, unknown>): Record<string, unknown> {
  return redactDetail({
    agentId: wireId(a.agentId),
    role: enumOf(a.role, ["root", "child"] as const),
    generation: int(a.generation),
    parentAgentId: wireId(a.parentAgentId),
    status: enumOf(a.status, AGENT_STATUSES),
    capabilityScope: enumOf(a.capabilityScope, ["full", "witness"] as const),
    dryRun: bool(a.dryRun) ?? false,
    runtimeCommit: hex40(a.runtimeCommit),
    createdAt: iso(a.createdAt),
    lastHeartbeat: iso(a.lastHeartbeat),
    deathTime: iso(a.deathTime),
    name: untrusted(a.name),
  });
}

export type AuditLevel = "ok" | "info" | "elevated" | "full";

/** Amendment 1: < 50% ok, >= 50% info (early warning), >= 75% elevated, >= 100% full (fail closed). */
export function auditLevel(count: number, cap: number): AuditLevel {
  if (!(cap > 0)) return "full";
  const r = count / cap;
  if (r >= 1) return "full";
  if (r >= 0.75) return "elevated";
  if (r >= 0.5) return "info";
  return "ok";
}

/** null = unknown (the flag source could not be read); never reported as "off". */
export interface RuntimeFlagsView {
  realReplicationEnabled: boolean | null;
  realPaymentsEnabled: boolean | null;
  ownerSweepEnabled: boolean | null;
  dryRunChildEnabled: boolean | null;
}

export function statusBody(
  db: Record<string, unknown>,
  flags: RuntimeFlagsView,
  readiness: { ready: boolean; checks: Record<string, { ok: boolean; warn?: boolean }> },
): Record<string, unknown> {
  const fleet = (db.fleet ?? {}) as Record<string, unknown>;
  const runtime = (db.runtime ?? {}) as Record<string, unknown>;
  const schema = (db.schema ?? {}) as Record<string, unknown>;
  const op = (db.operatorApi ?? {}) as Record<string, unknown>;
  const count = int(op.requestCount) ?? 0;
  const cap = int(op.requestCap) ?? 0;
  const checks: Record<string, { ok: boolean; warn: boolean }> = {};
  for (const [k, v] of Object.entries(readiness.checks)) {
    if (/^[a-zA-Z]{1,32}$/.test(k)) checks[k] = { ok: v.ok === true, warn: v.warn === true };
  }
  return {
    fleet: redactDetail({
      maxAgents: int(fleet.maxAgents),
      living: int(fleet.living),
      reserved: int(fleet.reserved),
      quarantined: int(fleet.quarantined),
      mode: enumOf(fleet.mode, MODES),
      replicationEnabled: bool(fleet.replicationEnabled),
    }),
    runtime: redactDetail({
      repo: typeof runtime.repo === "string" && /^https:\/\/[A-Za-z0-9./_-]{1,200}$/.test(runtime.repo) ? runtime.repo : null,
      commit: hex40(runtime.commit),
      buildId: hex64(runtime.buildId),
      lockfileSha256: hex64(runtime.lockfileSha256),
    }),
    schema: { version: int(schema.version) },
    safety: { ...flags, source: "runtime.env as read by the Operator API (the controller may also set switches in its own environment)" },
    readiness: { ready: readiness.ready, checks },
    operatorApi: { enabled: bool(op.enabled) ?? false, requestCount: count, requestCap: cap, auditLevel: auditLevel(count, cap) },
  };
}

// ─── Events ─────────────────────────────────────────────────────

type FieldKind = "int" | "bool" | "hex40" | "hex64" | "ulid" | "text" | "iso" | { enum: readonly string[] };
type EventSchema = Readonly<Record<string, FieldKind>>;

const OP_REASON = { enum: ["FLEET_OP_BAD_REQUEST", "FLEET_OP_NOT_FOUND", "FLEET_OP_DISABLED", "FLEET_OP_AUDIT_FULL", "FLEET_OP_AUTH_FAILED", "FLEET_OP_SCOPE_DENIED", "FLEET_OP_STALE", "FLEET_OP_REPLAYED"] } as const;
const OP_ROUTE = { enum: ["GET /v1/operator/whoami", "GET /v1/operator/status", "GET /v1/operator/agents", "GET /v1/operator/agents/{agent_id}", "GET /v1/operator/events", "unknown"] } as const;

/**
 * Allow-listed event types and fields (dotted paths into detail). Anything
 * else is omitted. IP addresses are never included (D-11).
 */
export const EVENT_SCHEMAS: Readonly<Record<string, EventSchema>> = Object.freeze({
  cap_set: { previous: "int", max: "int" },
  runtime_approved: { "runtime.commit": "hex40", "build.buildId": "hex64", "build.lockfileSha256": "hex64", "previous.commit": "hex40", "previous.buildId": "hex64" },
  agent_role_granted: { role: "text" },
  service_role_granted: { role: "text" },
  operator_role_granted: { role: "text" },
  api_auth_failed: { why: "text", path: "text" },
  request_replay_blocked: { path: "text" },
  scope_denied: { method: { enum: ["GET", "POST"] }, path: "text", scope: { enum: ["full", "witness"] }, layer: { enum: ["service", "database"] } },
  session_opened: {},
  credential_issued: {},
  root_registered: { name: "text", capabilityScope: { enum: ["full", "witness"] } },
  slot_reserved: { living: "int", reserved: "int", max: "int" },
  reservation_denied: { code: "text", living: "int", reserved: "int", quarantined: "int", max: "int" },
  agent_died: { reason: "text" },
  agent_quarantined: { reason: "text" },
  operator_auth_failed: { code: OP_REASON, route: OP_ROUTE, layer: { enum: ["database"] } },
  operator_scope_denied: { code: OP_REASON, route: OP_ROUTE, layer: { enum: ["database"] } },
  operator_replay_blocked: { code: OP_REASON, route: OP_ROUTE, layer: { enum: ["database"] } },
  operator_stale: { code: OP_REASON, route: OP_ROUTE, layer: { enum: ["database"] } },
  operator_disabled: { code: OP_REASON, route: OP_ROUTE, layer: { enum: ["database"] } },
  operator_audit_full: { code: OP_REASON, route: OP_ROUTE, layer: { enum: ["database"] } },
  operator_bad_request: { code: OP_REASON, route: OP_ROUTE, layer: { enum: ["database"] } },
  operator_principal_enrolled: { kind: { enum: ["bridge_claude", "bridge_chatgpt"] }, keyId: "text", expiresAt: "iso" },
  operator_key_added: { keyId: "text", expiresAt: "iso" },
  operator_key_revoked: { keyId: "text" },
  operator_principal_revoked: {},
  operator_revoke_all: { principals: "int", keys: "int" },
  operator_api_enabled_set: { enabled: "bool", generation: "int" },
  operator_requests_archived: { rows: "int", before: "iso", remaining: "int" },
  operator_requests_archive_failed: { stage: { enum: ["verify", "delete"] }, rows: "int", before: "iso" },
});

function pick(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const part of dotted.split(".")) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    const d = Object.getOwnPropertyDescriptor(cur, part);
    if (!d || !("value" in d)) return undefined;
    cur = d.value;
  }
  return cur;
}

function field(kind: FieldKind, v: unknown): unknown {
  if (typeof kind === "object") return typeof v === "string" && kind.enum.includes(v) ? v : "unknown";
  switch (kind) {
    case "int":
      return int(v);
    case "bool":
      return bool(v);
    case "hex40":
      return hex40(v);
    case "hex64":
      return hex64(v);
    case "ulid":
      return wireId(v);
    case "iso":
      return iso(v);
    case "text":
      return v === undefined || v === null ? null : untrusted(v);
  }
}

export type ActorClass = "operator" | "operator_api" | "service" | "agent" | "database" | "unknown";

export function actorClass(actor: unknown): ActorClass {
  const a = str(actor) ?? "";
  if (a.startsWith("operator:") || a === "operator") return "operator";
  if (a.startsWith("op:")) return "operator_api";
  if (a === "fleet-service") return "service";
  if (ULID.test(a) || /^0x[0-9a-fA-F]{40}$/.test(a)) return "agent";
  if (a === "migration" || a === "reaper" || a === "system") return "database";
  return "unknown";
}

export function eventItem(e: Record<string, unknown>): Record<string, unknown> {
  const type = typeof e.type === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(e.type) ? e.type : "unknown";
  const schema = Object.prototype.hasOwnProperty.call(EVENT_SCHEMAS, type) ? EVENT_SCHEMAS[type] : null;
  // Rebuilt as nested objects so public identities keep their exact B0 field
  // names (build.buildId -> { build: { buildId } }); dotted keys would not match.
  const detail: Record<string, unknown> = {};
  if (schema) {
    for (const [path, kind] of Object.entries(schema)) {
      const parts = path.split(".");
      let cur = detail;
      for (const p of parts.slice(0, -1)) cur = (cur[p] ??= {}) as Record<string, unknown>;
      cur[parts[parts.length - 1]] = field(kind, pick(e.detail, path));
    }
  }
  return redactDetail({
    id: typeof e.id === "string" && /^[1-9][0-9]{0,18}$/.test(e.id) ? e.id : null,
    type,
    agentId: wireId(e.agentId),
    actor: { class: actorClass(e.actor) },
    createdAt: iso(e.createdAt),
    detail,
    ...(schema ? {} : { detailOmitted: true }),
  });
}
```

## `src/fleet/operator/route-policy.ts`

sha256 `91df7bd9c57cfe5c5472d0235838df45dd4205f71019af1a4f736f8e81bdfa9d` · 4718 bytes · 94 lines

```ts
/**
 * Operator API route policy (Phase B2, read-only v1). Default deny: a route
 * absent from OPERATOR_ROUTE_POLICY is 404 and never dispatched.
 *
 * Each route maps to exactly one database read function. verifyRoutePolicy()
 * enforces the signature-termination invariant at compile/startup time: a
 * route can only name one of OPERATOR_READ_FUNCTIONS (all STABLE); mapping a
 * route to op_begin_request, a svc_/api_ function or anything else fails.
 * The database mirrors this with a CHECK on fleet_operator_routes.fn.
 *
 * ops.read.treasury is reserved (Phase E) and ops.propose does not exist:
 * adding a mutating capability requires a separate security-design gate.
 */

import { OPERATOR_READ_FUNCTIONS } from "../postgres/migrations.js";

export type OperatorKind = "bridge_claude" | "bridge_chatgpt";
export type OperatorScope = "ops.read.status" | "ops.read.agents" | "ops.read.events";

export const OPERATOR_KINDS: readonly OperatorKind[] = Object.freeze(["bridge_claude", "bridge_chatgpt"]);
export const OPERATOR_SCOPES: readonly OperatorScope[] = Object.freeze(["ops.read.status", "ops.read.agents", "ops.read.events"]);
/** Documented, not implemented until Phase E. */
export const RESERVED_SCOPES: readonly string[] = Object.freeze(["ops.read.treasury"]);

export interface OperatorRoute {
  scope: OperatorScope | null;
  kinds: readonly OperatorKind[];
  fn: string;
  /** Allowed query parameters and their exact value formats. */
  params: Readonly<Record<string, RegExp>>;
}

const LIMIT = /^(?:[1-9][0-9]?|1[0-9]{2}|200)$/;
const ULID_LOWER = /^[0-9a-hjkmnp-tv-z]{26}$/;
const EVENT_ID = /^[1-9][0-9]{0,18}$/;
const EVENT_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
const BOTH: readonly OperatorKind[] = Object.freeze(["bridge_claude", "bridge_chatgpt"]);

export const OPERATOR_ROUTE_POLICY: Readonly<Record<string, Readonly<OperatorRoute>>> = Object.freeze({
  "GET /v1/operator/whoami": Object.freeze({ scope: null, kinds: BOTH, fn: "op_whoami", params: Object.freeze({}) }),
  "GET /v1/operator/status": Object.freeze({ scope: "ops.read.status", kinds: BOTH, fn: "op_fleet_status", params: Object.freeze({}) }),
  "GET /v1/operator/agents": Object.freeze({
    scope: "ops.read.agents",
    kinds: BOTH,
    fn: "op_list_agents",
    params: Object.freeze({ after: ULID_LOWER, limit: LIMIT }),
  }),
  "GET /v1/operator/agents/{agent_id}": Object.freeze({ scope: "ops.read.agents", kinds: BOTH, fn: "op_get_agent", params: Object.freeze({}) }),
  "GET /v1/operator/events": Object.freeze({
    scope: "ops.read.events",
    kinds: Object.freeze(["bridge_claude"] as OperatorKind[]),
    fn: "op_list_events",
    params: Object.freeze({ after: EVENT_ID, limit: LIMIT, type: EVENT_TYPE }),
  }),
});

export interface RouteMatch {
  key: string;
  route: Readonly<OperatorRoute>;
  pathParams: Record<string, string>;
}

/** Exact route match on an already-canonical path. Agent ids travel as lowercase ULIDs. */
export function matchRoute(method: string, path: string, policy = OPERATOR_ROUTE_POLICY): RouteMatch | null {
  const exact = policy[`${method} ${path}`];
  if (exact) return { key: `${method} ${path}`, route: exact, pathParams: {} };
  const m = /^\/v1\/operator\/agents\/([^/]+)$/.exec(path);
  if (m && ULID_LOWER.test(m[1])) {
    const key = `${method} /v1/operator/agents/{agent_id}`;
    const route = policy[key];
    if (route) return { key, route, pathParams: { agent_id: m[1] } };
  }
  return null;
}

/**
 * Problems with a route policy. Empty for the shipped policy; tests prove
 * that a mutating/unknown function, a reserved scope or a non-GET route fails.
 */
export function verifyRoutePolicy(policy: Readonly<Record<string, Readonly<OperatorRoute>>> = OPERATOR_ROUTE_POLICY): string[] {
  const problems: string[] = [];
  const readFns = new Set(OPERATOR_READ_FUNCTIONS);
  const seen = new Set<string>();
  for (const [key, r] of Object.entries(policy)) {
    if (!/^GET \/v1\/operator\/[a-z0-9_/{}-]+$/.test(key)) problems.push(`${key}: only read-only GET routes under /v1/operator are allowed`);
    if (!readFns.has(r.fn)) problems.push(`${key}: ${r.fn} is not an allow-listed read function (signature-termination invariant)`);
    if (seen.has(r.fn)) problems.push(`${key}: ${r.fn} is mapped by more than one route`);
    seen.add(r.fn);
    if (r.scope !== null && !OPERATOR_SCOPES.includes(r.scope)) problems.push(`${key}: scope ${r.scope} is not a v1 scope`);
    if (!r.kinds.length || r.kinds.some((k) => !OPERATOR_KINDS.includes(k))) problems.push(`${key}: invalid principal kinds`);
    if (r.scope === "ops.read.events" && r.kinds.includes("bridge_chatgpt")) problems.push(`${key}: ChatGPT may not read events in v1 (D-5)`);
  }
  return problems;
}
```

## `src/fleet/operator/server.ts`

sha256 `8901fd9fc371727cdc4e61cfa0cfbb9e9ed6d41a2a424c991bc9a7fb41cc7400` · 20351 bytes · 490 lines

```ts
/**
 * Operator API server (Phase B2). A separate process from FleetController:
 * loopback-only HTTP listener (127.0.0.1:8788), read-only v1 routes, every
 * request individually Ed25519-signed (canonical.ts) and re-checked by the
 * database (op_begin_request) before exactly one STABLE read function runs.
 *
 * Verification order (fail closed; unauthenticated input never causes a
 * database write):
 *   1  canonical request target, route in OPERATOR_ROUTE_POLICY   (404 / 400)
 *   2  headers: exactly one of each X-Fleet-Op-*, no Authorization/Cookie
 *   3  empty body (no Content-Length > 0, no Transfer-Encoding)
 *   4  query parameters allow-listed per route with exact formats
 *   5  (unused; auth failures never lock out other principals)
 *   6  ±30 s timestamp window (process clock)
 *   7  principal/key lookup (public keys only; cache <= 30 s, dropped on
 *      kill-switch generation change) and principal kind for the route;
 *      lookups of pairs never seen valid share one global budget
 *   8  Ed25519 signature over the canonical string
 *   9  scope, 10 per-principal rate limit
 *  11  op_begin_request: kill switch, audit cap, principal/key/scope/route
 *      again from the database, database-time window, nonce (replay)
 *  12  exactly the route's read function, in a READ ONLY transaction;
 *      typed, per-item-redacted response
 *
 * /healthz and /readyz are unauthenticated, require a loopback Host header
 * (DNS rebinding) and serve a readiness result cached per poll interval.
 * Denied-request audit lines are budgeted; the excess is summarised.
 *
 * 401 responses never say which check failed; the reason goes to the audit
 * log only. Private keys, signatures, raw nonces, Authorization values and
 * request bodies are never logged.
 */

import http from "http";
import crypto, { type KeyObject } from "crypto";
import { RateLimiter, type RateLimit } from "../service/rate-limit.js";
import {
  EMPTY_BODY_SHA256,
  OP_LIMITS,
  PRINCIPAL_RE,
  canonicalString,
  decodeSignature,
  parseTarget,
  publicKeyFromRaw,
  readOpHeaders,
  verifySignature,
  type OpErrorCode,
} from "./canonical.js";
import { matchRoute, verifyRoutePolicy, type RouteMatch } from "./route-policy.js";
import type { KeyMaterial, OperatorGateway } from "./gateway.js";
import { agentItem, dbId, eventItem, statusBody, untrusted, type RuntimeFlagsView } from "./responses.js";
import { redactDetail, redactText } from "../redact.js";

export const OPERATOR_SCHEMA_VERSION = 8;

export interface OperatorLimits {
  perPrincipal: RateLimit;
  /**
   * Database lookups for principal/key pairs never seen valid by this process.
   * Global (all clients share one loopback peer behind the SSH tunnel), so it
   * only throttles junk identities: pairs already known valid bypass it and
   * cannot be locked out by someone else's failures.
   */
  unknownKeyLookups: RateLimit;
  /** Denied-request audit records; beyond this they are counted and summarised. */
  deniedAudit: RateLimit;
  maxConcurrent: number;
  keyCacheMs: number;
  pollMs: number;
  maxResponseBytes: number;
}

export const DEFAULT_OPERATOR_LIMITS: OperatorLimits = Object.freeze({
  perPrincipal: { capacity: 30, refillPerSec: 1 },
  unknownKeyLookups: { capacity: 20, refillPerSec: 20 / 60 },
  deniedAudit: { capacity: 120, refillPerSec: 2 },
  maxConcurrent: 16,
  keyCacheMs: 30_000,
  pollMs: 5_000,
  maxResponseBytes: 256 * 1024,
});

export interface OperatorAuditEntry {
  ts: string;
  event: string;
  agentId: string | null;
  detail: Record<string, unknown>;
}

export interface OperatorServiceOptions {
  gateway: OperatorGateway;
  /** Audit sink (operator JSONL + journald via createAuditSink). */
  audit?: (entry: OperatorAuditEntry) => void;
  now?: () => number;
  /** Safety flags as read by this process from runtime.env. */
  runtimeFlags?: () => RuntimeFlagsView;
  /** Extra readiness checks (privilege audit, clock). */
  readinessChecks?: () => Promise<Record<string, { ok: boolean; warn?: boolean }>>;
  limits?: Partial<OperatorLimits>;
}

const STATUS_OF: Record<string, number> = {
  FLEET_OP_BAD_REQUEST: 400,
  FLEET_OP_NONCANONICAL: 400,
  FLEET_OP_BAD_PARAM: 400,
  FLEET_OP_STALE: 401,
  FLEET_OP_AUTH_FAILED: 401,
  FLEET_OP_SCOPE_DENIED: 403,
  FLEET_OP_NOT_FOUND: 404,
  FLEET_OP_REPLAYED: 409,
  FLEET_OP_RATE_LIMITED: 429,
  FLEET_OP_INTERNAL: 500,
  FLEET_OP_DISABLED: 503,
  FLEET_OP_AUDIT_FULL: 503,
};

class OpFailure extends Error {
  constructor(
    readonly code: OpErrorCode,
    /** Audit-only reason (never sent to the client). */
    readonly reason: string,
  ) {
    super(code);
  }
}

/** No flag source: report unknown, never "off". */
const NO_FLAGS: RuntimeFlagsView = { realReplicationEnabled: null, realPaymentsEnabled: null, ownerSweepEnabled: null, dryRunChildEnabled: null };

const LOOPBACK_HOST_HEADER = /^(127\.0\.0\.1|localhost|\[::1\])(:[0-9]{1,5})?$/;

type ReadinessResult = { ready: boolean; state: string; checks: Record<string, { ok: boolean; warn?: boolean }> };

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function emptyBody(req: http.IncomingMessage): Promise<boolean> {
  return new Promise((resolve) => {
    let got = false;
    req.on("data", () => {
      got = true;
    });
    req.on("end", () => resolve(!got));
    req.on("error", () => resolve(false));
  });
}

export class OperatorService {
  private readonly limits: OperatorLimits;
  private readonly now: () => number;
  private readonly perPrincipal: RateLimiter;
  private readonly unknownLookups: RateLimiter;
  private readonly deniedAudit: RateLimiter;
  private suppressedDenials = 0;
  /** Pairs that resolved to a valid key at least once (revocation is still enforced by the database per request). */
  private readonly knownPairs = new Set<string>();
  private readyCache: { at: number; value: Promise<ReadinessResult> } | null = null;
  private readonly keyCache = new Map<string, { at: number; km: KeyMaterial; pub: KeyObject }>();
  private server: http.Server | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private inflight = 0;
  private generation: number | null = null;
  private enabled = false;
  private dbOk = false;
  private schemaVersion: number | null = null;

  constructor(private readonly opts: OperatorServiceOptions) {
    const problems = verifyRoutePolicy();
    if (problems.length) throw new Error(`Operator route policy violates the read-only invariant: ${problems.join("; ")}`);
    this.limits = { ...DEFAULT_OPERATOR_LIMITS, ...(opts.limits ?? {}) };
    this.now = opts.now ?? Date.now;
    this.perPrincipal = new RateLimiter(this.limits.perPrincipal, this.now);
    this.unknownLookups = new RateLimiter(this.limits.unknownKeyLookups, this.now);
    this.deniedAudit = new RateLimiter(this.limits.deniedAudit, this.now);
  }

  /** Poll the kill switch / generation; drops the key cache when the generation changes. */
  async refresh(): Promise<void> {
    await this.poll();
    this.readyCache = null;
  }

  private async poll(): Promise<void> {
    try {
      const p = await this.opts.gateway.ping();
      if (this.generation !== p.generation) this.keyCache.clear();
      this.generation = p.generation;
      this.enabled = p.operatorApiEnabled === true;
      this.schemaVersion = p.schemaVersion;
      this.dbOk = true;
    } catch {
      this.dbOk = false;
    }
  }

  async listen(port: number, host = "127.0.0.1"): Promise<{ url: string; port: number }> {
    if (!isLoopbackHost(host)) throw new Error(`Operator API listens on loopback only (refusing ${host})`);
    await this.refresh();
    const server = http.createServer(
      { maxHeaderSize: OP_LIMITS.maxHeaderBytes, requestTimeout: 10_000, headersTimeout: 5_000, keepAliveTimeout: 5_000 },
      (req, res) => void this.handle(req, res),
    );
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve());
    });
    this.pollTimer = setInterval(() => void this.refresh(), this.limits.pollMs);
    this.pollTimer.unref();
    const addr = server.address() as { port: number };
    return { url: `http://${host.includes(":") ? `[${host}]` : host}:${addr.port}`, port: addr.port };
  }

  async close(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  private auditDenied(detail: Record<string, unknown>): void {
    if (!this.deniedAudit.take("all")) {
      this.suppressedDenials++;
      return;
    }
    if (this.suppressedDenials > 0) {
      this.audit("operator_request_denied_suppressed", { count: this.suppressedDenials });
      this.suppressedDenials = 0;
    }
    this.audit("operator_request_denied", detail);
  }

  private audit(event: string, detail: Record<string, unknown>): void {
    try {
      this.opts.audit?.({ ts: new Date(this.now()).toISOString(), event, agentId: null, detail: redactDetail(detail) });
    } catch {
      // audit sink failures must not break request handling
    }
  }

  /**
   * Readiness, computed at most once per poll interval and shared by
   * concurrent callers, so unauthenticated /readyz traffic cannot multiply
   * database work.
   */
  private readiness(): Promise<ReadinessResult> {
    const c = this.readyCache;
    if (c && this.now() - c.at < this.limits.pollMs) return c.value;
    const value = this.computeReadiness();
    this.readyCache = { at: this.now(), value };
    return value;
  }

  private async computeReadiness(): Promise<ReadinessResult> {
    await this.poll();
    const checks: Record<string, { ok: boolean; warn?: boolean }> = {
      database: { ok: this.dbOk },
      schema: { ok: this.schemaVersion === OPERATOR_SCHEMA_VERSION },
      killSwitch: { ok: this.enabled, warn: !this.enabled },
    };
    try {
      Object.assign(checks, (await this.opts.readinessChecks?.()) ?? {});
    } catch {
      checks.readinessChecks = { ok: false };
    }
    const allOk = Object.entries(checks).every(([k, c]) => c.ok || k === "killSwitch");
    const ready = allOk && this.enabled;
    return { ready, state: ready ? "ready" : allOk ? "disabled" : "not_ready", checks };
  }

  private async keyMaterial(principal: string, key: string): Promise<{ km: KeyMaterial; pub: KeyObject } | null> {
    const ck = `${principal}|${key}`;
    const hit = this.keyCache.get(ck);
    if (hit && this.now() - hit.at < this.limits.keyCacheMs) return hit;
    const known = this.knownPairs.has(ck);
    if (!known && this.unknownLookups.retryAfterS("all") > 0) throw new OpFailure("FLEET_OP_RATE_LIMITED", "unknown key lookups");
    const km = await this.opts.gateway.keyMaterial(principal, key);
    if (!km.ok || typeof km.publicKey !== "string") {
      if (!known) this.unknownLookups.take("all");
      return null;
    }
    const raw = Buffer.from(km.publicKey, "base64");
    if (raw.length !== 32) return null;
    const entry = { at: this.now(), km, pub: publicKeyFromRaw(raw) };
    this.keyCache.set(ck, entry);
    if (this.knownPairs.size < 1000) this.knownPairs.add(ck);
    return entry;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const started = this.now();
    const requestId = crypto.randomUUID();
    const peer = req.socket.remoteAddress ?? "unknown";
    const raw = req.url ?? "";
    let status = 500;
    let code: string | undefined;
    let reason: string | undefined;
    let routeKey = "unknown";
    let principal = "none";
    let items: number | undefined;
    let counted = false;

    const send = (st: number, body: Record<string, unknown>) => {
      status = st;
      const text = JSON.stringify(body);
      res.writeHead(st, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-request-id": requestId,
        "content-length": Buffer.byteLength(text),
      });
      res.end(text);
    };

    if ((raw === "/healthz" || raw === "/readyz") && !LOOPBACK_HOST_HEADER.test(req.headers.host ?? "")) {
      // DNS-rebinding guard for the unauthenticated endpoints.
      send(421, { ok: false, code: "FLEET_OP_BAD_REQUEST" });
      return;
    }
    if (req.method === "GET" && raw === "/healthz") {
      send(200, { ok: true, status: "alive" });
      return;
    }
    if (req.method === "GET" && raw === "/readyz") {
      const r = await this.readiness();
      send(r.ready ? 200 : 503, r);
      return;
    }

    try {
      if (this.inflight >= this.limits.maxConcurrent) throw new OpFailure("FLEET_OP_RATE_LIMITED", "concurrency");
      this.inflight++;
      counted = true;

      const target = parseTarget(raw);
      if (!target.ok) {
        const underOperator = raw.startsWith("/v1/operator/");
        throw new OpFailure(underOperator ? target.code : "FLEET_OP_NOT_FOUND", "target");
      }
      const match = matchRoute(req.method ?? "", target.path);
      if (!match) throw new OpFailure("FLEET_OP_NOT_FOUND", "route");
      routeKey = match.key;

      const h = readOpHeaders(req.headersDistinct as Record<string, string[] | undefined>);
      if (!h.ok) throw new OpFailure("FLEET_OP_BAD_REQUEST", "headers");
      if (PRINCIPAL_RE.test(h.values.principal)) principal = h.values.principal;
      const cl = req.headers["content-length"];
      if ((cl !== undefined && cl !== "0") || req.headers["transfer-encoding"] !== undefined) throw new OpFailure("FLEET_OP_BAD_REQUEST", "body");
      if (!(await emptyBody(req))) throw new OpFailure("FLEET_OP_BAD_REQUEST", "body");
      for (const [k, v] of Object.entries(target.params)) {
        const re = match.route.params[k];
        if (!re || !re.test(v)) throw new OpFailure("FLEET_OP_BAD_PARAM", "param");
      }

      const authFail = (c: OpErrorCode, why: string): never => {
        throw new OpFailure(c, why);
      };
      const ts = Number(h.values.timestamp);
      if (Math.abs(this.now() - ts) > OP_LIMITS.skewMs) authFail("FLEET_OP_STALE", "clock window");
      const key = await this.keyMaterial(h.values.principal, h.values.key);
      if (!key) authFail("FLEET_OP_AUTH_FAILED", "unknown/revoked/expired principal or key");
      if (!match.route.kinds.includes(key!.km.kind as never)) authFail("FLEET_OP_AUTH_FAILED", "principal kind not allowed for route");
      const sig = decodeSignature(h.values.signature);
      const canonical = canonicalString({
        principal: h.values.principal,
        key: h.values.key,
        method: req.method ?? "",
        path: target.path,
        query: target.query,
        timestamp: h.values.timestamp,
        nonce: h.values.nonce,
        bodySha256: EMPTY_BODY_SHA256,
      });
      if (!sig || !verifySignature(key!.pub, canonical, sig)) authFail("FLEET_OP_AUTH_FAILED", "signature");
      if (match.route.scope !== null && !(key!.km.scopes ?? []).includes(match.route.scope)) throw new OpFailure("FLEET_OP_SCOPE_DENIED", "scope");
      if (!this.perPrincipal.take(h.values.principal)) throw new OpFailure("FLEET_OP_RATE_LIMITED", "principal rate");

      const begun = await this.opts.gateway.beginRequest({
        principal: h.values.principal,
        key: h.values.key,
        route: match.key,
        clientTsMs: ts,
        nonce: h.values.nonce,
        bodySha256: EMPTY_BODY_SHA256,
      });
      if (!begun.ok) {
        const c = (Object.prototype.hasOwnProperty.call(STATUS_OF, begun.code) ? begun.code : "FLEET_OP_INTERNAL") as OpErrorCode;
        throw new OpFailure(c, "database");
      }
      if (begun.fn !== match.route.fn) throw new OpFailure("FLEET_OP_INTERNAL", "route/function mismatch between process and database");

      const data = await this.dispatch(match, target.params, begun.requestId);
      if (data === null) throw new OpFailure("FLEET_OP_NOT_FOUND", "agent not found");
      items = Array.isArray((data as { items?: unknown[] }).items) ? (data as { items: unknown[] }).items.length : undefined;
      send(200, { ok: true, requestId, serverTime: new Date(this.now()).toISOString(), data });
    } catch (err) {
      if (err instanceof OpFailure) {
        code = err.code;
        reason = err.reason;
      } else {
        code = "FLEET_OP_INTERNAL";
        reason = redactText(err instanceof Error ? err.message : String(err));
      }
      if (!res.headersSent) send(STATUS_OF[code] ?? 500, { ok: false, requestId, code });
    } finally {
      if (counted) this.inflight--;
      (status < 400 ? (d: Record<string, unknown>) => this.audit("operator_request", d) : (d: Record<string, unknown>) => this.auditDenied(d))({
        requestId,
        principal,
        route: routeKey,
        status,
        ...(code ? { code, reason } : {}),
        ...(items !== undefined ? { items } : {}),
        ms: this.now() - started,
        peer: peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1" ? "loopback" : "other",
      });
    }
  }

  private async dispatch(match: RouteMatch, params: Record<string, string>, requestId: string): Promise<Record<string, unknown> | null> {
    const g = this.opts.gateway;
    switch (match.route.fn) {
      case "op_whoami": {
        const w = await g.whoami(requestId);
        const p = (w.principal ?? {}) as Record<string, unknown>;
        const k = (w.key ?? {}) as Record<string, unknown>;
        return {
          principal: {
            id: typeof p.id === "string" && PRINCIPAL_RE.test(p.id) ? p.id : null,
            name: typeof p.name === "string" && /^[a-z][a-z0-9-]{2,40}$/.test(p.name) ? p.name : null,
            kind: p.kind === "bridge_claude" || p.kind === "bridge_chatgpt" ? p.kind : "unknown",
            scopes: Array.isArray(p.scopes) ? p.scopes.filter((s) => s === "ops.read.status" || s === "ops.read.agents" || s === "ops.read.events") : [],
          },
          key: {
            id: typeof k.id === "string" && /^[0-9a-f]{32}$/.test(k.id) ? k.id : null,
            expiresAt: typeof k.expiresAt === "string" ? new Date(k.expiresAt).toISOString() : null,
          },
        };
      }
      case "op_fleet_status": {
        const db = await g.fleetStatus(requestId);
        const r = await this.readiness();
        return statusBody(db, this.opts.runtimeFlags?.() ?? NO_FLAGS, { ready: r.ready, checks: r.checks });
      }
      case "op_list_agents": {
        const limit = params.limit ? Number(params.limit) : 50;
        const r = await g.listAgents(requestId, params.after ? dbId(params.after) : null, limit);
        return this.page(r.items, limit, (a) => agentItem(a), (it) => (it.agentId as string | null) ?? null);
      }
      case "op_get_agent": {
        const r = await g.getAgent(requestId, dbId(match.pathParams.agent_id));
        return r.found && r.item ? { item: agentItem(r.item) } : null;
      }
      case "op_list_events": {
        const limit = params.limit ? Number(params.limit) : 50;
        const r = await g.listEvents(requestId, params.after ?? null, limit, params.type ?? null);
        return this.page(r.items, limit, (e) => eventItem(e), (it) => (it.id as string | null) ?? null);
      }
      default:
        throw new OpFailure("FLEET_OP_INTERNAL", `unmapped function ${untrusted(match.route.fn).value}`);
    }
  }

  /** Keyset page bounded by `limit` and by maxResponseBytes (never truncates an item). */
  private page(
    rawItems: Record<string, unknown>[],
    limit: number,
    build: (x: Record<string, unknown>) => Record<string, unknown>,
    cursorOf: (it: Record<string, unknown>) => string | null,
  ): Record<string, unknown> {
    const out: Record<string, unknown>[] = [];
    let bytes = 256;
    let more = rawItems.length > limit;
    for (const raw of rawItems.slice(0, limit)) {
      const it = build(raw);
      const size = Buffer.byteLength(JSON.stringify(it));
      if (bytes + size > this.limits.maxResponseBytes) {
        more = true;
        break;
      }
      bytes += size + 1;
      out.push(it);
    }
    const last = out[out.length - 1];
    return { items: out, next: more && last ? { after: cursorOf(last) } : null };
  }
}
```

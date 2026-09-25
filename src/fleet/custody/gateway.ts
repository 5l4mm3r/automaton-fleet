/**
 * Custody executor database gateway (Phase E, schema v10).
 *
 * Connects as the restricted custody login (fleet_custody_login) and can only
 * call the three cx_* SECURITY DEFINER functions: ping, claim an already
 * authorized instruction under a lease, report its external result. It holds
 * no table privilege, cannot create, approve, re-target or resize a payment,
 * and cannot post an arbitrary journal.
 */

import pg from "pg";
import type { Pool } from "pg";
import { quoteIdent } from "../postgres/migrations.js";
import { auditPrivileges, DEFAULT_CUSTODY_ROLES, type PrivilegeAuditResult } from "../postgres/privileges.js";

export interface CustodyPing {
  schemaVersion: number | null;
  executionEnabled: boolean;
  issued: number;
  claimed: number;
  dbTime: string;
  runtimeRepo: string | null;
  runtimeCommit: string | null;
  runtimeBuildId: string | null;
  runtimeLockfileSha256: string | null;
}

export interface ClaimedInstruction {
  instructionId: string;
  amountCents: number;
  destinationId: string;
  rail: string;
  referenceSha256: string;
  instructionSha256: string;
}

export type CxResult = { ok: true; [k: string]: unknown } | { ok: false; code: string };

export class PgCustodyGateway {
  private readonly pool: Pool;
  private readonly s: string;

  constructor(opts: { connectionString: string; schema?: string }) {
    const schema = opts.schema ?? "fleet";
    this.s = quoteIdent(schema);
    this.pool = new pg.Pool({
      connectionString: opts.connectionString,
      max: 2,
      application_name: "automaton-fleet-custody",
      options: `-c statement_timeout=10000 -c lock_timeout=5000`,
    });
    this.pool.on("error", () => {});
  }

  async ping(): Promise<CustodyPing> {
    return (await this.pool.query(`SELECT ${this.s}.cx_ping() AS r`)).rows[0].r;
  }

  async claim(worker: string, leaseSha256: string): Promise<{ ok: true; instruction: ClaimedInstruction | null } | { ok: false; code: string }> {
    return (await this.pool.query(`SELECT ${this.s}.cx_claim_instruction($1, $2) AS r`, [worker, leaseSha256])).rows[0].r;
  }

  async report(
    instructionId: string,
    lease: string,
    outcome: "settled" | "failed",
    externalRef: string | null,
    settledCents: number | null,
    failureCode: string | null,
  ): Promise<CxResult> {
    return (
      await this.pool.query(`SELECT ${this.s}.cx_report_result($1, $2, $3, $4, $5, $6) AS r`, [
        instructionId, lease, outcome, externalRef, settledCents, failureCode,
      ])
    ).rows[0].r;
  }

  async identity(): Promise<{ user: string; isOwner: boolean; superuser: boolean; memberOf: string[] }> {
    const r = await this.pool.query<{ u: string; owner: string | null; su: boolean; m: string[] | null }>(
      `SELECT current_user AS u, (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = $1) AS owner,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su,
              ARRAY(SELECT rolname::text FROM pg_roles WHERE rolname <> current_user AND pg_has_role(current_user, oid, 'MEMBER') ORDER BY 1) AS m`,
      [this.s.replace(/"/g, "")],
    );
    const row = r.rows[0];
    return { user: row.u, isOwner: row.owner === row.u, superuser: row.su === true, memberOf: row.m ?? [] };
  }

  /** Privilege audit restricted to the custody roles (plus the connected login, whatever its name). */
  async auditCustody(schema = "fleet"): Promise<PrivilegeAuditResult> {
    const who = (await this.pool.query<{ u: string }>("SELECT current_user AS u")).rows[0].u;
    const roles = [...new Set([...DEFAULT_CUSTODY_ROLES, who])];
    return auditPrivileges(this.pool, { schema, agentRoles: [], serviceRoles: [], operatorRoles: [], custodyRoles: roles, requireCustodyRoles: true });
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => {});
  }
}

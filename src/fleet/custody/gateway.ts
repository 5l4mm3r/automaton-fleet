/**
 * Custody executor database gateway (Phase E, schema v10).
 *
 * Connects as the restricted custody login (fleet_custody_login) and can only
 * call the cx_* SECURITY DEFINER functions: ping, claim an already
 * authorized instruction under a lease, report its external result (v32: attest
 * signers, gate credential use; v48: the PayPal treasury's receiving and
 * reconciliation records). It holds
 * no table privilege, cannot create, approve, re-target or resize a payment,
 * and cannot post an arbitrary journal.
 */

import pg from "pg";
import type { Pool } from "pg";
import { quoteIdent } from "../postgres/migrations.js";
import { auditPrivileges, DEFAULT_CUSTODY_ROLES, type PrivilegeAuditResult } from "../postgres/privileges.js";
import type { PayPalGatewayPort, PayPalInboxItem, PayPalRail, PayPalWorkItem } from "./paypal-treasury.js";
import type { SealedCredentialPort } from "./sealed-vault.js";

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
  // v32: the binding (rail, credential, capability, venture), where to pay, and the accounting currency.
  reference?: string | null;
  paymentRailId?: string | null;
  provider?: string | null;
  railMode?: string | null;
  credentialId?: string | null;
  vaultRef?: string | null;
  capability?: string | null;
  ventureId?: string | null;
  currency?: string | null;
}

export type CxResult = { ok: true; [k: string]: unknown } | { ok: false; code: string };

export class PgCustodyGateway implements PayPalGatewayPort, SealedCredentialPort {
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

  /** v32: attest one signer (rail + credential) this executor holds. */
  async attest(worker: string, railId: string, provider: string, mode: string, credentialId: string): Promise<CxResult> {
    return (await this.pool.query(`SELECT ${this.s}.cx_attest_signer($1, $2, $3, $4, $5) AS r`, [worker, railId, provider, mode, credentialId])).rows[0].r;
  }

  /** v32: gate and audit one credential use for a claimed instruction (under its lease). */
  async credentialUse(instructionId: string, lease: string, action: string, outcome: "ok" | "failed", detail: string | null): Promise<CxResult> {
    return (await this.pool.query(`SELECT ${this.s}.cx_credential_use($1, $2, $3, $4, $5) AS r`, [instructionId, lease, action, outcome, detail])).rows[0].r;
  }

  // ── v48: the PayPal treasury (receiving and reconciliation; see paypal-treasury.ts) ──
  private async cx<T>(fn: string, args: unknown[]): Promise<T> {
    const ph = args.map((_, i) => `$${i + 1}`).join(", ");
    return (await this.pool.query(`SELECT ${this.s}.${fn}(${ph}) AS r`, args)).rows[0].r as T;
  }
  paypalInbox(worker: string, limit: number) { return this.cx<PayPalInboxItem[]>("cx_paypal_inbox", [worker, limit]); }
  paypalInboxResult(worker: string, eventId: string, status: string, note: string | null) { return this.cx<CxResult>("cx_paypal_inbox_result", [worker, eventId, status, note]); }
  paypalWork(worker: string, limit: number) { return this.cx<PayPalWorkItem[]>("cx_paypal_work", [worker, limit]); }
  paypalRails(worker: string) { return this.cx<PayPalRail[]>("cx_paypal_rails", [worker]); }
  paypalCheckoutByOrder(worker: string, orderId: string) { return this.cx<CxResult>("cx_paypal_checkout_by_order", [worker, orderId]); }
  paypalCheckoutUpdate(worker: string, checkoutId: string, status: string, orderId: string | null, approvalUrl: string | null, failure: string | null) {
    return this.cx<CxResult>("cx_paypal_checkout_update", [worker, checkoutId, status, orderId, approvalUrl, failure]);
  }
  paypalCaptureRecord(worker: string, checkoutId: string, captureId: string, status: string, grossMinor: number, feeMinor: number, currency: string, evidence: string) {
    return this.cx<CxResult>("cx_paypal_capture_record", [worker, checkoutId, captureId, status, grossMinor, feeMinor, currency, evidence]);
  }
  paypalRefundRecord(worker: string, captureId: string, refundId: string, kind: string, amountMinor: number, currency: string) {
    return this.cx<CxResult>("cx_paypal_refund_record", [worker, captureId, refundId, kind, amountMinor, currency]);
  }
  paypalTxnRecord(worker: string, railId: string, txn: Record<string, unknown>) { return this.cx<CxResult>("cx_paypal_txn_record", [worker, railId, JSON.stringify(txn)]); }
  paypalBalanceRecord(worker: string, railId: string, currency: string, availableMinor: number, totalMinor: number) {
    return this.cx<CxResult>("cx_paypal_balance_record", [worker, railId, currency, availableMinor, totalMinor]);
  }

  paypalBuyerWork(worker: string, limit: number) {
    return this.cx<Array<{ checkoutId: string; paypalOrderId: string; railMode: "live" | "sandbox"; vaultRef: string }>>("cx_paypal_buyer_work", [worker, limit]);
  }
  paypalBuyerRecord(worker: string, checkoutId: string, payer: Record<string, unknown> | null) {
    return this.cx<CxResult>("cx_paypal_buyer_record", [worker, checkoutId, payer === null ? null : JSON.stringify(payer)]);
  }

  paypalClawbackEvidence(worker: string, ref: string, group: string, captureId: string, amountMinor: number, currency: string) {
    return this.cx<CxResult>("cx_paypal_clawback_evidence", [worker, "webhook", ref, group, captureId, amountMinor, currency]);
  }
  paypalDisputeRecord(worker: string, disputeId: string, captureId: string, status: string, outcome: string | null, amountMinor: number, currency: string) {
    return this.cx<CxResult>("cx_paypal_dispute_record", [worker, disputeId, captureId, status, outcome, amountMinor, currency]);
  }

  paypalRefundWork(worker: string, limit: number) {
    return this.cx<Array<{ refundRequestId: string; captureId: string; amountMinor: number; currency: string; note: string; invoiceId: string; railId: string;
      railMode: "live" | "sandbox"; vaultRef: string }>>("cx_paypal_refund_work", [worker, limit]);
  }
  paypalRefundResult(worker: string, requestId: string, outcome: string, refundId: string | null, amountMinor: number | null, currency: string | null, failure: string | null) {
    return this.cx<CxResult>("cx_paypal_refund_result", [worker, requestId, outcome, refundId, amountMinor, currency, failure]);
  }

  // ── v49: the custody key and dashboard-sealed credentials ──
  publishKey(worker: string, publicKeyB64: string, fingerprint: string) { return this.cx<CxResult>("cx_publish_key", [worker, publicKeyB64, fingerprint]); }
  sealedCredentials(worker: string) { return this.cx<Array<{ vaultRef: string; sealedB64: string; fingerprint: string }>>("cx_sealed_credentials", [worker]); }

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

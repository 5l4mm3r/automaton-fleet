/**
 * Central treasury ledger — owner (FleetAdmin) API (Phase E, schema v10).
 *
 * Human operator CLI only, with the admin (schema owner) credential. Never
 * reachable through the Operator API, the fleet service or an agent. Every
 * economic fact goes through the database's single posting function
 * (fleet_ledger_post) via the named fleet_admin_* / fleet_destination_* /
 * fleet_estate_* functions; this module never writes a ledger table itself.
 *
 * FleetAdmin authority (E7): policy warnings come back as
 * `needs_acknowledgement` with a recommendation; the owner may proceed by
 * acknowledging them (recorded as an override). Constitutional / custody /
 * availability invariants come back as `refused` and cannot be acknowledged.
 *
 * Secrets: one-time activation / confirmation codes are generated here,
 * returned once to the owner's terminal, and only their SHA-256 reaches the
 * database. Destination details are never stored: only a SHA-256 of the
 * owner-held reference and a short hint.
 */

import crypto from "crypto";
import pg from "pg";
import type { Pool } from "pg";
import { ulid } from "ulid";
import { quoteIdent } from "../postgres/migrations.js";

export type DestinationKind = "owner" | "payee";
export type DestinationRail = "evm_usdc" | "bank_transfer" | "conway_credits" | "provider_account";

export interface AgentEconomics {
  cash: number;
  reserved: number;
  assetsRecoverable: number;
  recoverable: number;
  protectedPrincipal: number;
  protectedObligations: number;
  survivalEquity: number;
  expensePurchasingCapacity: number;
  purchasingCapacity: number;
  reservedRecoverable: number;
  externalCustomerRevenue: number;
  realizedInvestmentPnl: number;
  genesisAllocation: number;
  treasuryAllocation: number;
  internalTransfersNet: number;
  realizedNetProfit: number;
  lifetimeContribution: number;
  uncontributedProfit: number;
  survivalEquityExhausted: boolean;
}

export interface LedgerVerifyResult {
  ok: boolean;
  journals: number;
  headHash?: string;
  unbalanced?: number;
  firstBadSeq?: number;
}

export interface EconomicModel {
  ledgerAuthoritative: boolean;
  custodyExecutionEnabled: boolean;
  ownerApprovalThresholdCents: number;
  agentDailySpendCents: number;
  reservationTtlS: number;
  strongAuthThresholdCents: number;
  destinationCooldownS: number;
  confirmationTtlS: number;
}

/** Owner actor string (the OS user of the human operator). */
export function ownerActor(osUser: string): string {
  const u = osUser.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
  if (!u) throw new Error("cannot derive an owner actor from the OS user");
  return `operator:${u}`;
}

/** A one-time code for the owner's terminal (never stored; only its SHA-256 is). */
export function oneTimeCode(): { code: string; sha256: string } {
  const code = crypto.randomBytes(15).toString("base64url");
  return { code, sha256: sha256Hex(code) };
}

export function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

/** Destination id: dst_<ULID>. */
export function newDestinationId(): string {
  return `dst_${ulid()}`;
}

const HINT_RE = /^[A-Za-z0-9*._-]{0,12}$/;
const IDEM_RE = /^[A-Za-z0-9:_.-]{8,128}$/;

export function idempotencyKey(prefix: string): string {
  return `${prefix}:${crypto.randomBytes(12).toString("base64url")}`;
}

function cents(n: unknown, what: string): number {
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) throw new Error(`${what} must be a positive integer number of cents`);
  return n;
}

function idem(k: string): string {
  if (!IDEM_RE.test(k)) throw new Error("idempotency key must match ^[A-Za-z0-9:_.-]{8,128}$");
  return k;
}

function num(v: unknown): number {
  return typeof v === "string" ? Number(v) : (v as number);
}

export class PgLedgerAdmin {
  private readonly pool: Pool;

  constructor(opts: { connectionString: string; schema?: string }) {
    const schema = opts.schema ?? "fleet";
    quoteIdent(schema);
    this.pool = new pg.Pool({
      connectionString: opts.connectionString,
      max: 2,
      application_name: "automaton-fleet-ledger-admin",
      options: `-c search_path=${schema} -c statement_timeout=30000 -c lock_timeout=5000`,
    });
    this.pool.on("error", () => {});
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => {});
  }

  private async one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
    const r = await this.pool.query(sql, params);
    return r.rows[0]?.r as T;
  }

  async model(): Promise<EconomicModel> {
    const r = await this.pool.query(`SELECT * FROM fleet_economic_model WHERE id = 1`);
    const m = r.rows[0];
    return {
      ledgerAuthoritative: m.ledger_authoritative,
      custodyExecutionEnabled: m.custody_execution_enabled,
      ownerApprovalThresholdCents: num(m.owner_approval_threshold_cents),
      agentDailySpendCents: num(m.agent_daily_spend_cents),
      reservationTtlS: m.reservation_ttl_s,
      strongAuthThresholdCents: num(m.strong_auth_threshold_cents),
      destinationCooldownS: m.destination_cooldown_s,
      confirmationTtlS: m.confirmation_ttl_s,
    };
  }

  async verify(): Promise<LedgerVerifyResult> {
    return this.one<LedgerVerifyResult>(`SELECT fleet_ledger_verify() AS r`);
  }

  /** Normal-side balances of every account (derived from postings). */
  async balances(): Promise<Array<{ accountId: string; class: string; agentId: string | null; balanceCents: number }>> {
    const r = await this.pool.query(
      `SELECT account_id, class, agent_id, fleet_ledger_balance(account_id) AS b FROM fleet_ledger_accounts ORDER BY account_id`,
    );
    return r.rows.map((x) => ({ accountId: x.account_id, class: x.class, agentId: x.agent_id, balanceCents: num(x.b) }));
  }

  async economics(agentId: string): Promise<AgentEconomics> {
    return this.one<AgentEconomics>(`SELECT fleet_agent_economics($1) AS r`, [agentId]);
  }

  /** Lifetime Fleet Contribution: the fleet:profit balance (realized net profit contributed). */
  async lifetimeFleetContribution(): Promise<number> {
    return num(await this.one(`SELECT fleet_ledger_balance('fleet:profit') AS r`));
  }

  async journal(limit = 50): Promise<Array<Record<string, unknown>>> {
    const r = await this.pool.query(
      `SELECT j.seq, j.journal_id, j.kind, j.actor, j.source, j.agent_id, j.order_id, j.external_ref, j.reverses_journal_id, j.recorded_at, j.entry_hash,
              (SELECT jsonb_agg(jsonb_build_object('account', p.account_id, 'side', p.side, 'amount', p.amount_cents) ORDER BY p.line)
                 FROM fleet_ledger_postings p WHERE p.journal_id = j.journal_id) AS postings
         FROM fleet_ledger_journal j ORDER BY j.seq DESC LIMIT $1`,
      [Math.min(Math.max(1, limit), 1000)],
    );
    return r.rows;
  }

  async orders(filter: { status?: string; agentId?: string } = {}): Promise<Array<Record<string, unknown>>> {
    const r = await this.pool.query(
      `SELECT fleet_order_json(o) AS r FROM fleet_payment_orders o
        WHERE ($1::text IS NULL OR o.status = $1) AND ($2::text IS NULL OR o.agent_id = $2) ORDER BY o.seq DESC LIMIT 200`,
      [filter.status ?? null, filter.agentId ?? null],
    );
    return r.rows.map((x) => x.r);
  }

  async estateAttention(): Promise<{ assetsUnderDeadAgents: number; deadAgentsWithBalances: number; assetsWithoutOwner: number }> {
    return this.one(`SELECT fleet_estate_attention() AS r`);
  }

  // ── Destinations (enrollment is separate from payment approval) ─

  /**
   * Enroll a destination. `reference` is the owner-held destination detail
   * (e.g. an address); only its SHA-256 and `hint` are stored. Returns the
   * one-time activation code ONCE; activation needs it after the cooldown.
   */
  async enrollDestination(d: {
    kind: DestinationKind;
    rail: DestinationRail;
    label: string;
    reference: string;
    hint?: string;
    agentId?: string | null;
    actor: string;
  }): Promise<{ destinationId: string; activatableAt: string; activationCode: string }> {
    const hint = d.hint ?? "";
    if (!HINT_RE.test(hint)) throw new Error("hint must be at most 12 characters of [A-Za-z0-9*._-]");
    if (!d.reference || d.reference.length > 512) throw new Error("reference is required (it is hashed, never stored)");
    const code = oneTimeCode();
    const id = newDestinationId();
    const r = await this.one<{ destinationId: string; activatableAt: string }>(
      `SELECT fleet_destination_enroll($1, $2, $3, $4, $5, $6, $7, $8, $9) AS r`,
      [id, d.kind, d.rail, d.label, sha256Hex(d.reference), hint || null, d.agentId ?? null, d.actor, code.sha256],
    );
    return { destinationId: r.destinationId, activatableAt: r.activatableAt, activationCode: code.code };
  }

  async activateDestination(destinationId: string, activationCode: string, actor: string): Promise<{ status: string }> {
    return this.one(`SELECT fleet_destination_activate($1, $2, $3) AS r`, [destinationId, activationCode, actor]);
  }

  async revokeDestination(destinationId: string, reason: string, actor: string): Promise<{ status: string }> {
    return this.one(`SELECT fleet_destination_revoke($1, $2, $3) AS r`, [destinationId, actor, reason]);
  }

  // ── Bookkeeping of external facts (moves nothing) ─────────────

  async recordOwnerFunding(amountCents: number, externalRef: string, actor: string, key = idempotencyKey("funding")): Promise<string> {
    return this.one(`SELECT fleet_admin_record_owner_funding($1, $2, $3, $4) AS r`, [cents(amountCents, "amount"), externalRef, actor, idem(key)]);
  }

  /**
   * Schema v14: the owner bought prepaid inference (Conway) credits outside the
   * fleet; moves unallocated treasury cash into the credit asset. External
   * reference (the provider's invoice/receipt id) required.
   */
  async recordCreditsPurchase(amountCents: number, externalRef: string, actor: string, key = idempotencyKey("credits")): Promise<string> {
    return this.one(`SELECT fleet_admin_record_credits_purchase($1, $2, $3, $4) AS r`, [cents(amountCents, "amount"), externalRef, actor, idem(key)]);
  }

  /**
   * Record an external economic fact for an agent (schema v11 provenance): realized
   * customer revenue, a refund, or realized investment P&L. `counterparty` is the
   * external party's reference (hashed here, never stored); value from a
   * fleet-controlled counterparty is refused (FLEET_INTERNAL_TRANSFER_NOT_REVENUE).
   */
  async recordExternal(
    kind: "external_revenue" | "external_refund" | "investment_realized_gain" | "investment_realized_loss",
    agentId: string,
    amountCents: number,
    externalRef: string,
    counterparty: string,
    actor: string,
    key = idempotencyKey(kind.replace(/_/g, "-")),
  ): Promise<string> {
    if (!counterparty) throw new Error("an external counterparty reference is required");
    return this.one(`SELECT fleet_admin_record_external($1, $2, $3, $4, $5, $6, $7) AS r`, [
      kind, agentId, cents(amountCents, "amount"), externalRef, sha256Hex(counterparty.trim().toLowerCase()), actor, idem(key),
    ]);
  }

  async recordRevenue(agentId: string, amountCents: number, externalRef: string, counterparty: string, actor: string, key = idempotencyKey("revenue")): Promise<string> {
    return this.recordExternal("external_revenue", agentId, amountCents, externalRef, counterparty, actor, key);
  }

  /** Owner-only: mark a reference (e.g. a treasury account) as fleet-controlled, so value from it is never revenue. */
  async addControlledReference(reference: string, label: string, actor: string): Promise<void> {
    await this.pool.query(`SELECT fleet_controlled_reference_add($1, $2, $3)`, [sha256Hex(reference.trim().toLowerCase()), label, actor]);
  }

  async reverse(journalId: string, reason: string, actor: string, key = idempotencyKey("reversal")): Promise<string> {
    return this.one(`SELECT fleet_admin_reverse($1, $2, $3, $4) AS r`, [journalId, actor, reason, idem(key)]);
  }

  // ── FleetAdmin instructions (assessment → recommendation → decision) ─

  async agentCapital(p: {
    agentId: string;
    amountCents: number;
    mode: "grant" | "principal";
    actor: string;
    reason?: string;
    acknowledgeWarnings?: boolean;
    key?: string;
  }): Promise<Record<string, unknown>> {
    return this.one(`SELECT fleet_admin_agent_capital($1, $2, $3, $4, $5, $6, $7) AS r`, [
      p.agentId, cents(p.amountCents, "amount"), p.mode, p.actor, p.reason ?? null, p.acknowledgeWarnings === true,
      idem(p.key ?? idempotencyKey(p.mode)),
    ]);
  }

  async spendDecision(orderId: string, decision: "approve" | "reject", actor: string, opts: { note?: string; acknowledgeWarnings?: boolean } = {}) {
    return this.one<Record<string, unknown>>(`SELECT fleet_admin_spend_decision($1, $2, $3, $4, $5) AS r`, [
      orderId, decision, actor, opts.note ?? null, opts.acknowledgeWarnings === true,
    ]);
  }

  /**
   * Owner withdrawal instruction. Above the strong-auth threshold this returns
   * `pending_confirmation` plus a one-time confirmation code (shown once);
   * confirmWithdrawal() with that code places the (inert) reserved order.
   */
  async ownerWithdrawal(p: {
    amountCents: number;
    destinationId: string;
    actor: string;
    reason?: string;
    acknowledgeWarnings?: boolean;
    key?: string;
  }): Promise<Record<string, unknown> & { confirmationCode?: string }> {
    const m = await this.model();
    const code = p.amountCents >= m.strongAuthThresholdCents ? oneTimeCode() : null;
    const r = await this.one<Record<string, unknown>>(`SELECT fleet_admin_owner_withdrawal($1, $2, $3, $4, $5, $6, $7) AS r`, [
      cents(p.amountCents, "amount"), p.destinationId, p.actor, p.reason ?? null, p.acknowledgeWarnings === true,
      idem(p.key ?? idempotencyKey("withdrawal")), code?.sha256 ?? null,
    ]);
    return r.status === "pending_confirmation" && code ? { ...r, confirmationCode: code.code } : r;
  }

  async confirm(instructionId: string, code: string, actor: string): Promise<Record<string, unknown>> {
    return this.one(`SELECT fleet_admin_confirm($1, $2, $3) AS r`, [instructionId, code, actor]);
  }

  /** Contribute realized, uncontributed net profit to the fleet (LFC). Internal ledger only; moves nothing. */
  async contribute(agentId: string, amountCents: number, actor: string, key = idempotencyKey("contribution")): Promise<string> {
    return this.one(`SELECT fleet_profit_contribution($1, $2, $3, 'owner', $4) AS r`, [agentId, cents(amountCents, "amount"), actor, idem(key)]);
  }

  // ── Estates (not wired to the lifecycle in v10) ──────────────

  async estateOpen(agentId: string, actor: string): Promise<Record<string, unknown>> {
    return this.one(`SELECT fleet_estate_open($1, $2) AS r`, [agentId, actor]);
  }

  async estateSettle(agentId: string, actor: string): Promise<Record<string, unknown>> {
    return this.one(`SELECT fleet_estate_settle($1, $2) AS r`, [agentId, actor]);
  }

  async legacyDigests(): Promise<Array<{ table: string; rows: number; sha256: string }>> {
    const r = await this.pool.query(`SELECT table_name, row_count, rows_sha256 FROM fleet_legacy_economics ORDER BY table_name`);
    return r.rows.map((x) => ({ table: x.table_name, rows: num(x.row_count), sha256: x.rows_sha256 }));
  }
}

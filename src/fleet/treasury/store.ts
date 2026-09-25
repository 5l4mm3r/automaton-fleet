/**
 * Fleet treasury store (Phase 5) — FleetAdmin operations over the treasury
 * tables (schema v5). Connects with the ADMIN (owner) credential; neither
 * the service role nor agents hold any privilege on these tables. Agents
 * can only propose capital use and request spends through the fleet API
 * (api_propose_allocation / api_request_spend); every decision here requires
 * a named operator approver, and the database refuses any fleet agent id as
 * approver (fleet_require_operator_approver).
 *
 * Nothing here moves money. Sweeps, owner distributions and custody
 * transfers are recorded as plans ('planned_not_executed' /
 * 'blocked_payments_disabled').
 */

import pg from "pg";
import type { Pool, PoolClient } from "pg";
import { ulid } from "ulid";
import { quoteIdent } from "../postgres/migrations.js";
import { redactDetail } from "../redact.js";
import {
  DEFAULT_TREASURY_POLICY,
  TREASURY_USES,
  capitalPerformanceProfile,
  computeAgentWaterfall,
  discretionaryLimitCents,
  evaluateRescue,
  monthlyOperatingExpenseCents,
  planOwnerDistribution,
  reserveTargetCents,
  treasuryBalanceCents,
  validatePolicy,
  type AgentLedgerEntry,
  type AgentLedgerKind,
  type AgentWaterfall,
  type CapitalAllocation,
  type CapitalPerformanceProfile,
  type OwnerDistributionPlan,
  type TreasuryEntry,
  type TreasuryKind,
  type TreasuryPolicy,
} from "./engine.js";

export interface TreasuryPolicyRecord extends TreasuryPolicy {
  treasuryAddress: string | null;
  ownerWithdrawalAddress: string | null;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function toAllocation(r: Record<string, any>): CapitalAllocation & { proposedBy: string; decidedBy: string | null; decisionReason: string | null } {
  return {
    allocationId: r.allocation_id,
    agentId: r.agent_id,
    kind: r.kind,
    purpose: r.purpose,
    requestedAmountCents: Number(r.requested_amount_cents),
    approvedAmountCents: r.approved_amount_cents === null ? null : Number(r.approved_amount_cents),
    deployedCents: Number(r.deployed_cents),
    startDate: iso(r.start_date),
    expiryDate: iso(r.expiry_date),
    expectedReturnCents: Number(r.expected_return_cents),
    expectedDurationDays: r.expected_duration_days,
    status: r.status,
    actualReturnCents: r.actual_return_cents === null ? null : Number(r.actual_return_cents),
    decidedAt: iso(r.decided_at),
    proposedBy: r.proposed_by,
    decidedBy: r.decided_by,
    decisionReason: r.decision_reason,
  };
}

export class PgTreasuryStore {
  readonly schema: string;
  private readonly pool: Pool;

  constructor(opts: { connectionString: string; schema?: string }) {
    this.schema = opts.schema ?? "fleet";
    quoteIdent(this.schema);
    this.pool = new pg.Pool({
      connectionString: opts.connectionString,
      max: 3,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 10_000,
      allowExitOnIdle: true,
      application_name: "automaton-fleet-treasury",
      options: `-c search_path=${this.schema} -c lock_timeout=5000 -c statement_timeout=15000`,
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

  private async event(c: PoolClient, type: string, agentId: string | null, actor: string, detail: Record<string, unknown>): Promise<void> {
    await c.query("INSERT INTO fleet_events (event_type, agent_id, actor, detail) VALUES ($1, $2, $3, $4)", [
      type,
      agentId,
      actor,
      JSON.stringify(redactDetail(detail)),
    ]);
  }

  // ─── Policy ────────────────────────────────────────────────────

  async getPolicy(): Promise<TreasuryPolicyRecord> {
    const r = (await this.pool.query("SELECT * FROM fleet_treasury_policy WHERE id = 1")).rows[0];
    return {
      runwayDays: r.runway_days,
      contingencyPct: Number(r.contingency_pct),
      minContingencyCents: Number(r.min_contingency_cents),
      populationRates: r.population_rates,
      matureFleetRate: Number(r.mature_fleet_rate),
      maxSweepRate: Number(r.max_sweep_rate),
      reserveTargetMonths: Number(r.reserve_target_months),
      maturityAgeDays: r.maturity_age_days,
      treasuryAddress: r.treasury_address,
      ownerWithdrawalAddress: r.owner_withdrawal_address,
    };
  }

  async setPolicy(patch: Partial<TreasuryPolicyRecord>, actor: string): Promise<TreasuryPolicyRecord> {
    const cur = await this.getPolicy();
    const next = { ...cur, ...patch };
    validatePolicy(next);
    await this.tx(async (c) => {
      await c.query(
        `UPDATE fleet_treasury_policy SET runway_days = $1, contingency_pct = $2, min_contingency_cents = $3, population_rates = $4,
                mature_fleet_rate = $5, max_sweep_rate = $6, reserve_target_months = $7, maturity_age_days = $8,
                treasury_address = $9, owner_withdrawal_address = $10, updated_at = now(), updated_by = $11 WHERE id = 1`,
        [
          next.runwayDays, next.contingencyPct, next.minContingencyCents, JSON.stringify(next.populationRates),
          next.matureFleetRate, next.maxSweepRate, next.reserveTargetMonths, next.maturityAgeDays,
          next.treasuryAddress, next.ownerWithdrawalAddress, actor,
        ],
      );
      await this.event(c, "treasury_policy_set", null, actor, { ...next });
    });
    return next;
  }

  // ─── Ledgers and obligations ───────────────────────────────────

  async recordAgentLedger(
    e: { agentId: string; kind: AgentLedgerKind; amountCents: number; occurredAt?: Date; allocationId?: string; reference?: string; source?: "controller" | "operator" | "agent_reported" },
    actor: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO fleet_agent_ledger (agent_id, kind, amount_cents, occurred_at, allocation_id, reference, source, recorded_by)
       VALUES ($1, $2, $3, COALESCE($4, now()), $5, $6, $7, $8)`,
      [e.agentId, e.kind, e.amountCents, e.occurredAt ?? null, e.allocationId ?? null, e.reference ?? null, e.source ?? "operator", actor],
    );
  }

  async recordBalance(agentId: string, cashCents: number, source: "controller" | "operator" | "agent_reported" = "operator", observedAt?: Date): Promise<void> {
    await this.pool.query(
      "INSERT INTO fleet_balance_observations (agent_id, cash_cents, source, observed_at) VALUES ($1, $2, $3, COALESCE($4, now()))",
      [agentId, cashCents, source, observedAt ?? null],
    );
  }

  async addObligation(o: { agentId: string; description: string; amountCents: number; dueAt: Date }, approvedBy: string): Promise<string> {
    const id = ulid();
    await this.tx(async (c) => {
      await c.query("SELECT fleet_require_operator_approver($1, $2)", [approvedBy, o.agentId]);
      await c.query(
        "INSERT INTO fleet_obligations (obligation_id, agent_id, description, amount_cents, due_at, approved_by) VALUES ($1, $2, $3, $4, $5, $6)",
        [id, o.agentId, o.description, o.amountCents, o.dueAt, approvedBy],
      );
      await this.event(c, "obligation_approved", o.agentId, approvedBy, { obligationId: id, amountCents: o.amountCents });
    });
    return id;
  }

  // ─── Capital allocations ───────────────────────────────────────

  async listAllocations(agentId?: string): Promise<ReturnType<typeof toAllocation>[]> {
    const r = agentId
      ? await this.pool.query("SELECT * FROM fleet_capital_allocations WHERE agent_id = $1 ORDER BY created_at", [agentId])
      : await this.pool.query("SELECT * FROM fleet_capital_allocations ORDER BY created_at");
    return r.rows.map(toAllocation);
  }

  /** Operator-side proposal (e.g. an operator-initiated rescue). Agents propose via the fleet API. */
  async proposeAllocation(
    p: { agentId: string; purpose: string; requestedCents: number; expectedReturnCents: number; expectedDurationDays: number; kind?: "growth" | "rescue" },
    proposedBy: string,
  ): Promise<string> {
    const id = ulid();
    await this.pool.query(
      `INSERT INTO fleet_capital_allocations (allocation_id, agent_id, kind, purpose, requested_amount_cents, expected_return_cents,
                                              expected_duration_days, proposed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, p.agentId, p.kind ?? "growth", p.purpose, p.requestedCents, p.expectedReturnCents, p.expectedDurationDays, proposedBy],
    );
    return id;
  }

  /**
   * Approve a proposed allocation. Approved amounts above the agent's
   * discretionary limit (performance-scaled) need an explicit override.
   */
  async approveAllocation(
    allocationId: string,
    d: { approvedCents: number; startDate?: Date; expiryDate?: Date; reason: string; override?: boolean; baseDiscretionaryCents?: number },
    approver: string,
  ): Promise<void> {
    await this.tx(async (c) => {
      const cur = (await c.query("SELECT * FROM fleet_capital_allocations WHERE allocation_id = $1 FOR UPDATE", [allocationId])).rows[0];
      if (!cur) throw new Error(`unknown allocation ${allocationId}`);
      const a = toAllocation(cur);
      if (d.baseDiscretionaryCents !== undefined && !d.override) {
        const profile = await this.profileTx(c, a.agentId);
        const limit = discretionaryLimitCents(d.baseDiscretionaryCents, profile);
        if (d.approvedCents > limit) {
          throw new Error(`approval ${d.approvedCents} exceeds the agent's discretionary limit ${limit}; pass override to approve anyway`);
        }
      }
      const start = d.startDate ?? new Date();
      const expiry = d.expiryDate ?? new Date(start.getTime() + a.expectedDurationDays * 86_400_000);
      await c.query(
        `UPDATE fleet_capital_allocations SET status = 'approved', approved_amount_cents = $2, start_date = $3, expiry_date = $4,
                decided_by = $5, decided_at = now(), decision_reason = $6 WHERE allocation_id = $1`,
        [allocationId, d.approvedCents, start, expiry, approver, d.reason],
      );
      await this.event(c, "capital_approved", a.agentId, approver, { allocationId, approvedCents: d.approvedCents, override: !!d.override });
    });
  }

  async rejectAllocation(allocationId: string, reason: string, approver: string): Promise<void> {
    await this.tx(async (c) => {
      const r = await c.query(
        `UPDATE fleet_capital_allocations SET status = 'rejected', decided_by = $2, decided_at = now(), decision_reason = $3
          WHERE allocation_id = $1 RETURNING agent_id`,
        [allocationId, approver, reason],
      );
      await this.event(c, "capital_rejected", r.rows[0]?.agent_id ?? null, approver, { allocationId, reason });
    });
  }

  /** Change terms of an approved allocation (amount/expiry). */
  async changeAllocation(allocationId: string, change: { approvedCents?: number; expiryDate?: Date; reason: string }, approver: string): Promise<void> {
    await this.tx(async (c) => {
      const r = await c.query(
        `UPDATE fleet_capital_allocations SET approved_amount_cents = COALESCE($2, approved_amount_cents),
                expiry_date = COALESCE($3, expiry_date), decided_by = $4, decided_at = now(), decision_reason = $5
          WHERE allocation_id = $1 AND status = 'approved' RETURNING agent_id`,
        [allocationId, change.approvedCents ?? null, change.expiryDate ?? null, approver, change.reason],
      );
      if (!r.rowCount) throw new Error(`allocation ${allocationId} is not approved`);
      await this.event(c, "capital_changed", r.rows[0].agent_id, approver, { allocationId, ...change });
    });
  }

  /** Record deployment of approved capital (reduces the protected unspent amount). */
  async recordDeployment(allocationId: string, amountCents: number, actor: string): Promise<void> {
    await this.tx(async (c) => {
      const r = await c.query(
        `UPDATE fleet_capital_allocations SET deployed_cents = deployed_cents + $2
          WHERE allocation_id = $1 AND status = 'approved' AND deployed_cents + $2 <= approved_amount_cents RETURNING agent_id`,
        [allocationId, amountCents],
      );
      if (!r.rowCount) throw new Error(`deployment refused for ${allocationId} (not approved or exceeds approved amount)`);
      await c.query(
        "INSERT INTO fleet_agent_ledger (agent_id, kind, amount_cents, allocation_id, source, recorded_by) VALUES ($1, 'allocation_deployed', $2, $3, 'operator', $4)",
        [r.rows[0].agent_id, amountCents, allocationId, actor],
      );
    });
  }

  /** Close an allocation with its actual return (feeds the capital-performance profile). */
  async completeAllocation(allocationId: string, actualReturnCents: number, approver: string): Promise<void> {
    await this.tx(async (c) => {
      const r = await c.query(
        `UPDATE fleet_capital_allocations SET status = 'completed', actual_return_cents = $2, decided_by = $3, decided_at = now()
          WHERE allocation_id = $1 AND status = 'approved' RETURNING agent_id`,
        [allocationId, actualReturnCents, approver],
      );
      if (!r.rowCount) throw new Error(`allocation ${allocationId} is not approved`);
      if (actualReturnCents > 0) {
        await c.query(
          "INSERT INTO fleet_agent_ledger (agent_id, kind, amount_cents, allocation_id, source, recorded_by) VALUES ($1, 'allocation_returned', $2, $3, 'operator', $4)",
          [r.rows[0].agent_id, actualReturnCents, allocationId, approver],
        );
      }
      await this.event(c, "capital_completed", r.rows[0].agent_id, approver, { allocationId, actualReturnCents });
    });
  }

  /** Approved allocations past expiry become expired (they stop protecting capital even before this runs). */
  async expireAllocations(actor: string): Promise<number> {
    return this.tx(async (c) => {
      const r = await c.query(
        `UPDATE fleet_capital_allocations SET status = 'expired', decided_by = $1, decided_at = now(), decision_reason = 'expired'
          WHERE status = 'approved' AND expiry_date <= now() RETURNING allocation_id`,
        [actor],
      );
      return r.rowCount ?? 0;
    });
  }

  // ─── Sweep reductions, freezes, quarantine support ─────────────

  async reduceSweep(
    r: { agentId: string; reductionPct: number; reason: string; expiresAt: Date; allocationId?: string },
    approver: string,
  ): Promise<string> {
    const id = ulid();
    await this.tx(async (c) => {
      await c.query(
        `INSERT INTO fleet_sweep_reductions (reduction_id, agent_id, allocation_id, reduction_pct, reason, expires_at, approved_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, r.agentId, r.allocationId ?? null, r.reductionPct, r.reason, r.expiresAt, approver],
      );
      await this.event(c, "sweep_reduced", r.agentId, approver, { reductionId: id, reductionPct: r.reductionPct, expiresAt: r.expiresAt });
    });
    return id;
  }

  async freezeSpending(agentId: string, frozen: boolean, reason: string, actor: string): Promise<void> {
    await this.tx(async (c) => {
      const a = (await c.query("SELECT status FROM fleet_agents WHERE agent_id = $1", [agentId])).rows[0];
      if (!frozen && a && !["active", "unresponsive"].includes(a.status)) {
        throw new Error(`cannot unfreeze a ${a.status} agent`);
      }
      const r = await c.query(
        `UPDATE fleet_wallet_custody SET spending_frozen = $2, frozen_reason = CASE WHEN $2 THEN $3 END,
                frozen_at = CASE WHEN $2 THEN now() END, updated_at = now() WHERE agent_id = $1`,
        [agentId, frozen, reason],
      );
      if (!r.rowCount) throw new Error(`no custody record for ${agentId}`);
      await this.event(c, frozen ? "spending_frozen" : "spending_unfrozen", agentId, actor, { reason });
    });
  }

  async setDailySpendLimit(agentId: string, cents: number, actor: string): Promise<void> {
    await this.tx(async (c) => {
      await c.query("UPDATE fleet_wallet_custody SET daily_limit_cents = $2, updated_at = now() WHERE agent_id = $1", [agentId, cents]);
      await this.event(c, "spend_limit_set", agentId, actor, { dailyLimitCents: cents });
    });
  }

  /** Custody transfer according to policy. Recorded only: payments are disabled. */
  async planCustodyTransfer(
    t: { fromAgentId: string; destination: "fleet_treasury" | "agent"; toAgentId?: string; amountCents: number; policy: "quarantine_recovery" | "death_recovery" | "rebalance" | "sweep"; reason: string },
    approver: string,
  ): Promise<string> {
    const id = ulid();
    await this.tx(async (c) => {
      if (t.policy === "rebalance") {
        const s = (await c.query("SELECT status FROM fleet_agents WHERE agent_id = $1", [t.fromAgentId])).rows[0]?.status;
        if (s !== "active") throw new Error("rebalance transfers require an active source agent");
      }
      await c.query(
        `INSERT INTO fleet_custody_transfers (transfer_id, from_agent_id, destination, to_agent_id, amount_cents, policy, reason, approved_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, t.fromAgentId, t.destination, t.toAgentId ?? null, t.amountCents, t.policy, t.reason, approver],
      );
      await this.event(c, "custody_transfer_planned", t.fromAgentId, approver, { transferId: id, ...t, executed: false });
    });
    return id;
  }

  // ─── Treasury (fleet bank) ─────────────────────────────────────

  async recordTreasury(
    e: { kind: TreasuryKind; amountCents: number; agentId?: string; allocationId?: string; reference?: string; occurredAt?: Date },
    actor: string,
  ): Promise<void> {
    if (!TREASURY_USES.has(e.kind) && !["sweep_in", "owner_funding_in", "allocation_return_in"].includes(e.kind)) {
      throw new Error(`${e.kind} is not a permitted recorded treasury movement (owner distributions are planned via planOwnerDistribution)`);
    }
    await this.pool.query(
      `INSERT INTO fleet_treasury_ledger (kind, amount_cents, status, agent_id, allocation_id, reference, recorded_by, occurred_at)
       VALUES ($1, $2, 'recorded', $3, $4, $5, $6, COALESCE($7, now()))`,
      [e.kind, e.amountCents, e.agentId ?? null, e.allocationId ?? null, e.reference ?? null, actor, e.occurredAt ?? null],
    );
  }

  async addTreasuryObligation(o: { category: string; description: string; amountCents: number; dueAt: Date }, approver: string): Promise<string> {
    const id = ulid();
    await this.pool.query(
      "INSERT INTO fleet_treasury_obligations (obligation_id, category, description, amount_cents, due_at, approved_by) VALUES ($1, $2, $3, $4, $5, $6)",
      [id, o.category, o.description, o.amountCents, o.dueAt, approver],
    );
    return id;
  }

  async treasuryPosition(opts: { asOf?: Date; monthlyExpenseOverrideCents?: number } = {}): Promise<{
    balanceCents: number;
    monthlyExpenseCents: number;
    reserveTargetCents: number;
    obligationsCents: number;
    surplusCents: number;
  }> {
    const asOf = opts.asOf ?? new Date();
    const policy = await this.getPolicy();
    const entries: TreasuryEntry[] = (
      await this.pool.query("SELECT kind, amount_cents, status, occurred_at FROM fleet_treasury_ledger")
    ).rows.map((r) => ({ kind: r.kind, amountCents: Number(r.amount_cents), status: r.status, occurredAt: r.occurred_at }));
    const balance = treasuryBalanceCents(entries);
    const monthly = monthlyOperatingExpenseCents(entries, asOf, 90, opts.monthlyExpenseOverrideCents);
    const target = reserveTargetCents(monthly, policy);
    const obligations = Number(
      (await this.pool.query("SELECT COALESCE(sum(amount_cents), 0) AS s FROM fleet_treasury_obligations WHERE status = 'approved'")).rows[0].s,
    );
    return { balanceCents: balance, monthlyExpenseCents: monthly, reserveTargetCents: target, obligationsCents: obligations, surplusCents: Math.max(0, balance - target - obligations) };
  }

  /** Owner distribution: only surplus above reserve + obligations; recorded as a plan (never executed here). */
  async planOwnerDistribution(requestedCents: number, approver: string, opts: { monthlyExpenseOverrideCents?: number } = {}): Promise<OwnerDistributionPlan & { distributionId: string }> {
    const policy = await this.getPolicy();
    if (!policy.ownerWithdrawalAddress) throw new Error("owner withdrawal address is not configured");
    if (policy.treasuryAddress && policy.treasuryAddress.toLowerCase() === policy.ownerWithdrawalAddress.toLowerCase()) {
      throw new Error("the fleet treasury must not be the owner's withdrawal destination");
    }
    const pos = await this.treasuryPosition(opts);
    const plan = planOwnerDistribution({
      requestedCents,
      balanceCents: pos.balanceCents,
      reserveTargetCents: pos.reserveTargetCents,
      obligationsCents: pos.obligationsCents,
    });
    const id = ulid();
    await this.tx(async (c) => {
      await c.query("SELECT fleet_require_operator_approver($1, NULL)", [approver]);
      await c.query(
        `INSERT INTO fleet_owner_distributions (distribution_id, requested_cents, approved_cents, treasury_balance_cents, reserve_target_cents,
                                                obligations_cents, destination, status, reason, decided_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, requestedCents, plan.approvedCents, plan.treasuryBalanceCents, plan.reserveTargetCents, plan.obligationsCents,
         policy.ownerWithdrawalAddress, plan.status, plan.reason, approver],
      );
      if (plan.status === "planned_not_executed") {
        await c.query(
          `INSERT INTO fleet_treasury_ledger (kind, amount_cents, status, reference, recorded_by) VALUES ('owner_distribution', $1, 'planned_not_executed', $2, $3)`,
          [plan.approvedCents, `distribution ${id}`, approver],
        );
      }
      await this.event(c, plan.status === "rejected" ? "owner_distribution_rejected" : "owner_distribution_planned", null, approver, {
        distributionId: id,
        ...plan,
        executed: false,
      });
    });
    return { ...plan, distributionId: id };
  }

  // ─── Agent economics ───────────────────────────────────────────

  private async profileTx(c: PoolClient | Pool, agentId: string): Promise<CapitalPerformanceProfile> {
    const allocations = (await c.query("SELECT * FROM fleet_capital_allocations WHERE agent_id = $1", [agentId])).rows.map(toAllocation);
    const ledger = await this.ledgerOf(c, agentId);
    return capitalPerformanceProfile(allocations, ledger, new Date());
  }

  private async ledgerOf(c: PoolClient | Pool, agentId: string): Promise<AgentLedgerEntry[]> {
    return (
      await c.query("SELECT kind, amount_cents, occurred_at, allocation_id FROM fleet_agent_ledger WHERE agent_id = $1 ORDER BY occurred_at", [agentId])
    ).rows.map((r) => ({ kind: r.kind, amountCents: Number(r.amount_cents), occurredAt: r.occurred_at, allocationId: r.allocation_id }));
  }

  /** Internal capital-performance profile (FleetAdmin only; not exposed to agents). */
  async performanceProfile(agentId: string): Promise<CapitalPerformanceProfile> {
    return this.profileTx(this.pool, agentId);
  }

  /** Full waterfall for an agent from registry data. Uses the latest observed balance unless cash is given. */
  async agentWaterfall(
    agentId: string,
    opts: { cashCents?: number; asOf?: Date; monthlyExpenseOverrideCents?: number; plannedSweepsCents?: number } = {},
  ): Promise<AgentWaterfall> {
    const asOf = opts.asOf ?? new Date();
    const agent = (await this.pool.query("SELECT created_at, status FROM fleet_agents WHERE agent_id = $1", [agentId])).rows[0];
    if (!agent) throw new Error(`unknown agent ${agentId}`);
    let cash = opts.cashCents;
    if (cash === undefined) {
      const b = (await this.pool.query("SELECT cash_cents FROM fleet_balance_observations WHERE agent_id = $1 ORDER BY observed_at DESC LIMIT 1", [agentId])).rows[0];
      if (!b) throw new Error(`no observed balance for ${agentId}`);
      cash = Number(b.cash_cents);
    }
    const [policy, pos, living, ledger, obligations, allocations, reductions] = await Promise.all([
      this.getPolicy(),
      this.treasuryPosition({ asOf, monthlyExpenseOverrideCents: opts.monthlyExpenseOverrideCents }),
      this.pool.query("SELECT living_agents FROM fleet_state WHERE id = 1").then((r) => r.rows[0].living_agents as number),
      this.ledgerOf(this.pool, agentId),
      this.pool.query("SELECT amount_cents, due_at, status FROM fleet_obligations WHERE agent_id = $1", [agentId]),
      this.pool.query("SELECT * FROM fleet_capital_allocations WHERE agent_id = $1", [agentId]),
      this.pool.query("SELECT reduction_pct, starts_at, expires_at, revoked_at FROM fleet_sweep_reductions WHERE agent_id = $1", [agentId]),
    ]);
    return computeAgentWaterfall(
      {
        agentId,
        cashCents: cash,
        agentCreatedAt: agent.created_at,
        ledger,
        obligations: obligations.rows.map((o) => ({ amountCents: Number(o.amount_cents), dueAt: o.due_at, status: o.status })),
        allocations: allocations.rows.map(toAllocation),
        reductions: reductions.rows.map((r) => ({ reductionPct: Number(r.reduction_pct), startsAt: r.starts_at, expiresAt: r.expires_at, revokedAt: r.revoked_at })),
        livingAgents: living,
        treasury: { balanceCents: pos.balanceCents, reserveTargetCents: pos.reserveTargetCents },
        asOf,
        plannedSweepsCents: opts.plannedSweepsCents ?? (await this.plannedSweepsCents(this.pool, agentId)),
      },
      policy,
    );
  }

  /** Phase D3.1: profit claimed by recorded sweep plans (planned, never executed; plans are immutable). */
  private async plannedSweepsCents(q: Pool | PoolClient, agentId: string): Promise<number> {
    const r = await q.query<{ s: string }>(
      "SELECT COALESCE(sum(amount_cents), 0)::text AS s FROM fleet_sweep_plans WHERE agent_id = $1 AND status = 'planned_not_executed'",
      [agentId],
    );
    return Number(r.rows[0].s);
  }

  /** Compute and record a sweep plan (never executed: payments are disabled). */
  async planSweep(agentId: string, actor: string, opts: { cashCents?: number } = {}): Promise<AgentWaterfall & { planId: string }> {
    const status = (await this.pool.query("SELECT status FROM fleet_agents WHERE agent_id = $1", [agentId])).rows[0]?.status;
    if (status !== "active") throw new Error(`sweeps are planned only for active agents (${agentId} is ${status})`);
    const id = ulid();
    // Phase D3.1: reserve what earlier plans claimed, so the same profit is never planned twice.
    // Optimistic: compute without holding a lock, then insert under the agent row lock only if no
    // other plan was recorded in between (otherwise recompute); no connection waits while computing.
    for (let attempt = 0; attempt < 3; attempt++) {
      const planned = await this.plannedSweepsCents(this.pool, agentId);
      const wf = await this.agentWaterfall(agentId, { ...opts, plannedSweepsCents: planned });
      const done = await this.tx(async (c) => {
        await c.query("SELECT 1 FROM fleet_agents WHERE agent_id = $1 FOR UPDATE", [agentId]);
        if ((await this.plannedSweepsCents(c, agentId)) !== planned) return false;
        await c.query(
          "INSERT INTO fleet_sweep_plans (plan_id, agent_id, rate, amount_cents, waterfall, computed_by) VALUES ($1, $2, $3, $4, $5, $6)",
          [id, agentId, wf.rate.rate, wf.FLEET_SWEEP, JSON.stringify(wf), actor],
        );
        await this.event(c, "sweep_planned", agentId, actor, {
          planId: id,
          rate: wf.rate.rate,
          amountCents: wf.FLEET_SWEEP,
          reservedByEarlierPlansCents: planned,
          executed: false,
        });
        return true;
      });
      if (done) return { ...wf, planId: id };
    }
    throw new Error(`concurrent sweep planning for ${agentId}; retry`);
  }

  /** Discretionary rescue advice (never automatic). */
  async rescueAdvice(agentId: string, cashCents?: number) {
    const w = await this.agentWaterfall(agentId, { cashCents });
    return evaluateRescue(w.profile, w);
  }
}

export { DEFAULT_TREASURY_POLICY };

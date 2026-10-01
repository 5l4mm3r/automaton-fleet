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

/**
 * Schema v19: Genesis takes the fleet from 0 to exactly this many founders (the registry's
 * fleet_genesis_policy.genesis_max_founders must equal it in production). The registry cap is a
 * ceiling only; growth beyond one founder is earned later, never owner-funded at Genesis.
 */
export const GENESIS_FOUNDERS = 1;

/**
 * Schema v20: parse a decimal exchange rate ("1.2745" USD per unit of the capital currency) into integer
 * micro-units without floating point. At most 6 decimals; must be positive.
 */
export function parseFxMicro(rate: string): number {
  const m = /^(\d{1,4})(?:\.(\d{1,6}))?$/.exec(rate.trim());
  if (!m) throw new Error("the exchange rate must be a positive decimal with at most 6 decimals (USD per unit)");
  const micro = Number(m[1]) * 1_000_000 + Number((m[2] ?? "").padEnd(6, "0"));
  if (!Number.isSafeInteger(micro) || micro < 1) throw new Error("the exchange rate must be positive");
  return micro;
}

/** USD cents a capital amount (minor units) buys at a micro-unit rate, rounded down (the registry's rule). */
export function capitalToCents(minorUnits: number, fxUsdMicro: number): number {
  return Number((BigInt(minorUnits) * BigInt(fxUsdMicro)) / 1_000_000n);
}

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
  /** v20: the owner's capital decision and the rate that converted it into allocationCents (null on plain USD proposals). */
  capital?: { currency: string; minorUnits: number; fxUsdMicro: number; fxSource: string; fxObservedAt: string; classification: string } | null;
  expiresAt: string;
  requestedBy: string;
  approvedBy: string | null;
  authSha256: string;
  founderIds: string[] | null;
  statusReason: string | null;
  founders: Array<{ ordinal: number; agentId: string; status: string; workspaceId: string; stateNamespace: string; agentStatus: string }>;
  replay?: boolean;
}

/** A runtime release as the registry records it. */
export interface RuntimeReleaseRow { repo: string; commit: string; buildId: string; lockfileSha256: string }

/** One living-founder runtime upgrade attempt (schema v23). */
export interface RuntimeUpgradeView {
  upgradeId: string;
  seq: number;
  agentId: string;
  status: "prepared" | "committed" | "verified" | "rolled_back" | "aborted";
  from: RuntimeReleaseRow;
  to: RuntimeReleaseRow;
  stateSha256Before: string;
  ledgerBefore: Record<string, unknown>;
  before: Record<string, unknown>;
  after: Record<string, unknown> | null;
  rollback: Record<string, unknown> | null;
  reason: string | null;
  preparedAt: string;
  preparedBy: string;
  committedAt: string | null;
  verifiedAt: string | null;
  closedAt: string | null;
  closedBy: string | null;
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

  // ─── Schema v13: founder cognition (owner controls) ─────────────────
  async cognitionPolicy(): Promise<Record<string, unknown>> {
    return (await this.db.query(`SELECT to_jsonb(p) AS r FROM fleet_cognition_policy p WHERE id = 1`)).rows[0].r;
  }

  setCognitionPolicy(p: {
    enabled: boolean; provider?: string | null; model?: string | null; maxOutputTokens?: number | null; inputMicrocents?: number | null; outputMicrocents?: number | null;
    dailyBudgetCents?: number | null; maxTurnsPerHour?: number | null; actor: string; cacheWriteMicrocents?: number | null; cacheReadMicrocents?: number | null;
  }) {
    return this.one<Record<string, unknown>>(`SELECT fleet_cognition_set_policy($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) AS r`, [
      p.enabled, p.provider ?? null, p.model ?? null, p.maxOutputTokens ?? null, p.inputMicrocents ?? null, p.outputMicrocents ?? null,
      p.dailyBudgetCents ?? null, p.maxTurnsPerHour ?? null, p.actor, p.cacheWriteMicrocents ?? null, p.cacheReadMicrocents ?? null,
    ]);
  }

  setFounderCognition(agentId: string, p: { enabled?: boolean | null; paused?: boolean | null; dailyBudgetCents?: number | null; maxTurnsPerHour?: number | null; reason: string; actor: string }) {
    return this.one<Record<string, unknown>>(`SELECT fleet_founder_cognition_set($1, $2, $3, $4, $5, $6, $7) AS r`, [
      agentId, p.enabled ?? null, p.paused ?? null, p.dailyBudgetCents ?? null, p.maxTurnsPerHour ?? null, p.reason, p.actor,
    ]);
  }

  cognitionState(agentId: string) {
    return this.one<Record<string, unknown>>(`SELECT fleet_cognition_state($1) AS r`, [agentId]);
  }

  // ─── Schema v22: neutral cognition routing (owner controls; inert by default) ─────────────────
  cognitionRouting() {
    return this.one<Record<string, unknown>>(`SELECT jsonb_build_object('routing', (SELECT to_jsonb(r) FROM fleet_cognition_routing r WHERE id = 1),
      'tiers', (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.tier) FROM fleet_cognition_tiers t),
      'actionMinTier', (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.action_class) FROM fleet_action_min_tier m),
      'founders', (SELECT COALESCE(jsonb_agg(to_jsonb(f) ORDER BY f.agent_id), '[]'::jsonb) FROM fleet_founder_routing f)) AS r`);
  }

  cognitionRoutingSet(enabled: boolean, majorSpendThresholdMinor: number | null, actor: string) {
    return this.one<Record<string, unknown>>(`SELECT fleet_cognition_routing_set($1, $2, $3) AS r`, [enabled, majorSpendThresholdMinor, actor]);
  }

  /** Changing a tier's mapping voids its verification and disables it until re-verified. */
  cognitionTierSet(p: { tier: string; model: string; thinking: string | null; effort: string | null; maxOutputTokens: number;
    inputMicrocents: number; outputMicrocents: number; cacheWriteMicrocents: number; cacheReadMicrocents: number; actor: string }) {
    return this.one<Record<string, unknown>>(`SELECT fleet_cognition_tier_set($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) AS r`, [
      p.tier, p.model, p.thinking, p.effort, p.maxOutputTokens, p.inputMicrocents, p.outputMicrocents, p.cacheWriteMicrocents, p.cacheReadMicrocents, p.actor,
    ]);
  }

  /** Record that `model` was verified for `tier` against the provider account (e.g. a Models API check reference). */
  cognitionTierVerify(tier: string, model: string, ref: string, actor: string) {
    return this.one<Record<string, unknown>>(`SELECT fleet_cognition_tier_verify($1, $2, $3, $4) AS r`, [tier, model, ref, actor]);
  }

  cognitionTierEnable(tier: string, enabled: boolean, actor: string) {
    return this.one<Record<string, unknown>>(`SELECT fleet_cognition_tier_enable($1, $2, $3) AS r`, [tier, enabled, actor]);
  }

  founderRoutingSet(agentId: string, enabled: boolean, actor: string) {
    return this.one<Record<string, unknown>>(`SELECT fleet_founder_routing_set($1, $2, $3) AS r`, [agentId, enabled, actor]);
  }

  cognitionReport(since: Date) {
    return this.one<Record<string, unknown>>(`SELECT fleet_cognition_report($1) AS r`, [since.toISOString()]);
  }

  // ─── Schema v24: opportunity → experiment pipeline (owner side; financially inert) ───
  experimentPolicy() {
    return this.one<Record<string, unknown>>(`SELECT jsonb_build_object('policy', (SELECT to_jsonb(p) FROM fleet_experiment_policy p WHERE id = 1),
      'ladder', (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.level) FROM fleet_evidence_ladder l)) AS r`);
  }

  experimentPolicySet(enabled: boolean | null, hardCapMinor: number | null, actor: string) {
    return this.one<Record<string, unknown>>(`SELECT fleet_experiment_policy_set($1, $2, $3) AS r`, [enabled, hardCapMinor, actor]);
  }

  evidenceLadderSet(level: number, autoCapMinor: number | null, actor: string) {
    return this.one<Record<string, unknown>>(`SELECT fleet_evidence_ladder_set($1::smallint, $2, $3) AS r`, [level, autoCapMinor, actor]);
  }

  experimentList(agentId: string | null, limit = 50) {
    return this.one<Array<Record<string, unknown>>>(`SELECT COALESCE(jsonb_agg(fleet_experiment_json(e) || jsonb_build_object('agentId', e.agent_id) ORDER BY e.seq DESC), '[]'::jsonb) AS r
      FROM (SELECT * FROM fleet_experiments WHERE $1::text IS NULL OR agent_id = $1 ORDER BY seq DESC LIMIT $2) e`, [agentId, limit]);
  }

  experimentView(experimentId: string) {
    return this.one<Record<string, unknown> | null>(`SELECT fleet_experiment_view($1) AS r`, [experimentId]);
  }

  experimentDecide(experimentId: string, decision: string, approvedMinor: number | null, maxLossMinor: number | null, actor: string, reason: string) {
    return this.one<Record<string, unknown>>(`SELECT fleet_experiment_decide($1, $2, $3, $4, $5, $6) AS r`, [experimentId, decision, approvedMinor, maxLossMinor, actor, reason]);
  }

  /** Optional, audited owner override of one evidence item's relevance (ordinary evidence is judged by the controller). */
  experimentAssessRelevance(experimentId: string, attemptId: string, verdict: "relevant" | "irrelevant" | "uncertain", actor: string, reason: string) {
    return this.one<Record<string, unknown>>(`SELECT fleet_experiment_assess_relevance($1, $2, $3, $4, $5) AS r`, [experimentId, attemptId, verdict, actor, reason]);
  }

  /** Relevance-assessor calls whose cost is unknown and still needs reconciliation with the provider. */
  relevanceCallsUnreconciled() {
    return this.one<Array<Record<string, unknown>>>(`SELECT fleet_relevance_calls_unreconciled() AS r`, []);
  }

  /** Record the provider's actual charge for one unknown-cost relevance call (0 allowed; once per call). */
  relevanceCallReconcile(requestId: string, usdMicrocents: number, actor: string, ref: string) {
    return this.one<Record<string, unknown>>(`SELECT fleet_relevance_call_reconcile($1, $2, $3, $4) AS r`, [requestId, usdMicrocents, actor, ref]);
  }

  /** E4 lineage: attribute a realized external-revenue journal to a concluded experiment of the same founder (reads the ledger only). */
  experimentAttributeRevenue(journalId: string, experimentId: string, actor: string, reason: string) {
    return this.one<Record<string, unknown>>(`SELECT fleet_experiment_attribute_revenue($1, $2, $3, $4) AS r`, [journalId, experimentId, actor, reason]);
  }

  experimentObserve(experimentId: string, idempotencyKey: string, metric: string, value: number, source: string, actor: string) {
    return this.one<Record<string, unknown>>(`SELECT fleet_experiment_observe($1, $2, $3, $4, $5, $6) AS r`, [experimentId, idempotencyKey, metric, value, source, actor]);
  }

  experimentStop(experimentId: string, actor: string, reason: string) {
    return this.one<Record<string, unknown>>(`SELECT fleet_experiment_stop($1, $2, $3) AS r`, [experimentId, actor, reason]);
  }

  experimentConclude(experimentId: string, actor: string, lessons: string | null, confidence: number | null) {
    return this.one<Record<string, unknown>>(`SELECT fleet_experiment_conclude($1, $2, $3, $4::smallint) AS r`, [experimentId, actor, lessons, confidence]);
  }

  strategyRegistry(agentId: string | null, limit = 50) {
    return this.one<Array<Record<string, unknown>>>(`SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.seq DESC), '[]'::jsonb) AS r
      FROM (SELECT * FROM fleet_strategy_registry WHERE $1::text IS NULL OR agent_id = $1 ORDER BY seq DESC LIMIT $2) s`, [agentId, limit]);
  }

  /** Schema v23: a tier's prompt-cache policy (T1 is constrained to off; a question-scoped escalation never caches). */
  cognitionTierCacheSet(tier: string, mode: string, actor: string) {
    return this.one<Record<string, unknown>>(`SELECT fleet_cognition_tier_cache_set($1, $2, $3) AS r`, [tier, mode, actor]);
  }

  // ─── Schema v23: runtime upgrade of a LIVING founder (the host-side lifecycle is src/fleet/founder/upgrade.ts) ───
  /** The runtime the founder is registered to run (latest committed/verified upgrade, else its Genesis attestation). */
  founderRuntimeCurrent(agentId: string) {
    return this.one<(RuntimeReleaseRow & { source: string; upgradeId?: string; status?: string }) | null>(`SELECT fleet_founder_runtime_current($1) AS r`, [agentId]);
  }

  founderRuntimeUpgradePrepare(agentId: string, from: RuntimeReleaseRow, to: RuntimeReleaseRow, before: Record<string, unknown>, actor: string) {
    return this.one<RuntimeUpgradeView>(`SELECT fleet_founder_runtime_upgrade_prepare($1, $2, $3, $4, $5) AS r`, [agentId, JSON.stringify(from), JSON.stringify(to), JSON.stringify(before), actor]);
  }

  founderRuntimeUpgradeCommit(upgradeId: string, stateSha256: string, actor: string) {
    return this.one<RuntimeUpgradeView>(`SELECT fleet_founder_runtime_upgrade_commit($1, $2, $3) AS r`, [upgradeId, stateSha256, actor]);
  }

  founderRuntimeUpgradeVerify(upgradeId: string, after: Record<string, unknown>, actor: string) {
    return this.one<RuntimeUpgradeView>(`SELECT fleet_founder_runtime_upgrade_verify($1, $2, $3) AS r`, [upgradeId, JSON.stringify(after), actor]);
  }

  founderRuntimeUpgradeRollback(upgradeId: string, reason: string, actor: string) {
    return this.one<RuntimeUpgradeView>(`SELECT fleet_founder_runtime_upgrade_rollback($1, $2, $3) AS r`, [upgradeId, reason, actor]);
  }

  founderRuntimeUpgradeRollbackVerify(upgradeId: string, after: Record<string, unknown>, actor: string) {
    return this.one<RuntimeUpgradeView>(`SELECT fleet_founder_runtime_upgrade_rollback_verify($1, $2, $3) AS r`, [upgradeId, JSON.stringify(after), actor]);
  }

  founderRuntimeUpgradeAbort(upgradeId: string, reason: string, actor: string) {
    return this.one<RuntimeUpgradeView>(`SELECT fleet_founder_runtime_upgrade_abort($1, $2, $3) AS r`, [upgradeId, reason, actor]);
  }

  founderRuntimeUpgrade(upgradeId: string) {
    return this.one<RuntimeUpgradeView | null>(`SELECT fleet_founder_runtime_upgrade_view($1) AS r`, [upgradeId]);
  }

  /** A founder's upgrade history, newest first. */
  founderRuntimeUpgrades(agentId: string, limit = 20) {
    return this.one<RuntimeUpgradeView[]>(
      `SELECT COALESCE(jsonb_agg(fleet_founder_runtime_upgrade_view(x.upgrade_id) ORDER BY x.seq DESC), '[]'::jsonb) AS r
         FROM (SELECT upgrade_id, seq FROM fleet_founder_runtime_upgrades WHERE agent_id = $1 ORDER BY seq DESC LIMIT $2) x`, [agentId, limit]);
  }

  founderRuntimeHealthSince(agentId: string, since: Date | string) {
    return this.one<{ status: string; lastHeartbeat: string | null; heartbeatAfter: boolean; challengesPassed: number; challengesFailed: number; challengeFailures: number; runtimeCommit: string | null } | null>(
      `SELECT fleet_founder_runtime_health_since($1, $2) AS r`, [agentId, typeof since === "string" ? since : since.toISOString()]);
  }

  founderLedgerFingerprint(agentId: string) {
    return this.one<Record<string, unknown>>(`SELECT fleet_founder_ledger_fingerprint($1) AS r`, [agentId]);
  }

  /** What the upgrade preflight needs to know about the founder and the fleet (read-only). */
  founderRuntimeContext(agentId: string) {
    return this.one<{ agent: { status: string; origin: string; role: string; runtimeRepo: string | null; runtimeCommit: string | null; genesisId: string | null; workspaceId: string | null; stateNamespace: string | null; lastHeartbeat: string | null; challengeFailures: number } | null;
      approved: RuntimeReleaseRow | null; heartbeatUnresponsiveS: number; heartbeatDeadS: number; maxChallengeFailures: number; inFlight: boolean; schemaVersion: number }>(
      `SELECT jsonb_build_object(
         'agent', (SELECT jsonb_build_object('status', a.status, 'origin', a.origin, 'role', a.role, 'runtimeRepo', a.runtime_repo, 'runtimeCommit', a.runtime_commit,
                     'genesisId', a.genesis_id, 'workspaceId', a.workspace_id, 'stateNamespace', a.state_namespace, 'lastHeartbeat', a.last_heartbeat,
                     'challengeFailures', a.challenge_failures) FROM fleet_agents a WHERE a.agent_id = $1),
         'approved', (SELECT CASE WHEN s.runtime_commit IS NULL THEN NULL ELSE jsonb_build_object('repo', s.runtime_repo, 'commit', s.runtime_commit,
                        'buildId', s.runtime_build_id, 'lockfileSha256', s.runtime_lockfile_sha256) END FROM fleet_state s WHERE s.id = 1),
         'heartbeatUnresponsiveS', (SELECT heartbeat_unresponsive_s FROM fleet_state WHERE id = 1),
         'heartbeatDeadS', (SELECT heartbeat_dead_s FROM fleet_state WHERE id = 1),
         'maxChallengeFailures', (SELECT max_challenge_failures FROM fleet_state WHERE id = 1),
         'inFlight', EXISTS (SELECT 1 FROM fleet_cognition_inflight WHERE agent_id = $1),
         'schemaVersion', (SELECT max(version) FROM fleet_schema_migrations)) AS r`, [agentId]);
  }

  /**
   * Phase F.3 owner monitoring: one row per founder — lifecycle, own economics,
   * cognition switches and usage, forbidden tool requests the model made (all
   * refused by the runtime) and its reserved (unexecuted) spend orders. Schema v27: no order ever awaits the owner —
   * own-capital spend is the founder's, custody-checked by FleetController.
   */
  async foundersReport(founderToolNames: readonly string[]): Promise<Array<Record<string, unknown>>> {
    const r = await this.db.query(
      `SELECT a.agent_id, a.status, a.origin, a.operator_hold_at IS NOT NULL AS held,
              fleet_agent_economics(a.agent_id) AS economics,
              fleet_cognition_state(a.agent_id) AS cognition,
              (SELECT count(*) FROM fleet_cognition_log l WHERE l.agent_id = a.agent_id AND l.at > now() - interval '1 day')::int AS calls_24h,
              (SELECT COALESCE(sum(charged_cents), 0) FROM fleet_cognition_log l WHERE l.agent_id = a.agent_id AND l.at > now() - interval '1 day')::bigint AS charged_24h,
              (SELECT COALESCE(jsonb_object_agg(n, c), '{}'::jsonb) FROM (
                 SELECT t ->> 'name' AS n, count(*) AS c FROM fleet_cognition_log l, jsonb_array_elements(l.tool_calls) t
                  WHERE l.agent_id = a.agent_id AND l.at > now() - interval '1 day' AND NOT ((t ->> 'name') = ANY($1::text[]))
                  GROUP BY 1) x) AS forbidden_24h,
              (SELECT count(*) FROM fleet_payment_orders o WHERE o.agent_id = a.agent_id AND o.status = 'reserved')::int AS orders_reserved
         FROM fleet_agents a WHERE a.origin IN ('genesis_founder','reseed_founder') ORDER BY a.agent_id`,
      [founderToolNames],
    );
    return r.rows.map((x) => ({
      agentId: x.agent_id,
      status: x.status,
      held: x.held,
      cash: x.economics?.cash ?? null,
      survivalEquity: x.economics?.survivalEquity ?? null,
      cognition: {
        enabled: x.cognition?.policyEnabled === true && x.cognition?.founderEnabled === true,
        paused: x.cognition?.paused === true,
        dailyBudgetCents: x.cognition?.dailyBudgetCents,
        spentTodayCents: x.cognition?.spentTodayCents,
        turnsLastHour: x.cognition?.turnsLastHour,
      },
      calls24h: x.calls_24h,
      charged24hCents: Number(x.charged_24h),
      forbiddenRequests24h: x.forbidden_24h,
      ordersReserved: x.orders_reserved,
    }));
  }

  async cognitionLog(agentId: string | null, limit = 50): Promise<Array<Record<string, unknown>>> {
    const r = await this.db.query(
      `SELECT to_jsonb(l) AS r FROM fleet_cognition_log l WHERE ($1::text IS NULL OR agent_id = $1) ORDER BY seq DESC LIMIT $2`,
      [agentId, Math.min(Math.max(1, limit), 500)],
    );
    return r.rows.map((x) => x.r);
  }

  // ─── Schema v18: founder web research (owner controls) ─────────────
  async researchPolicy(): Promise<Record<string, unknown>> {
    return (await this.db.query(`SELECT to_jsonb(p) AS r FROM fleet_research_policy p WHERE id = 1`)).rows[0].r;
  }

  setResearchPolicy(p: { enabled: boolean; founderHourly?: number | null; founderDaily?: number | null; fleetHourly?: number | null; fleetDaily?: number | null; actor: string }) {
    return this.one<Record<string, unknown>>(`SELECT fleet_research_set_policy($1, $2, $3, $4, $5, $6) AS r`, [
      p.enabled, p.founderHourly ?? null, p.founderDaily ?? null, p.fleetHourly ?? null, p.fleetDaily ?? null, p.actor,
    ]);
  }

  setFounderResearch(agentId: string, p: { paused?: boolean | null; hourly?: number | null; daily?: number | null; reason: string; actor: string }) {
    return this.one<Record<string, unknown>>(`SELECT fleet_founder_research_set($1, $2, $3, $4, $5, $6) AS r`, [agentId, p.paused ?? null, p.hourly ?? null, p.daily ?? null, p.reason, p.actor]);
  }

  researchState(agentId: string) {
    return this.one<Record<string, unknown>>(`SELECT fleet_research_state($1) AS r`, [agentId]);
  }

  async researchLog(agentId: string | null, limit = 50): Promise<Array<Record<string, unknown>>> {
    const r = await this.db.query(
      `SELECT to_jsonb(a) || COALESCE(to_jsonb(r) - 'attempt_id', '{}'::jsonb) AS r FROM fleet_research_attempts a LEFT JOIN fleet_research_results r USING (attempt_id)
        WHERE ($1::text IS NULL OR a.agent_id = $1) ORDER BY a.seq DESC LIMIT $2`,
      [agentId, Math.min(Math.max(1, limit), 500)],
    );
    return r.rows.map((x) => x.r);
  }

  setEnabled(enabled: boolean, actor: string, reason: string) {
    return this.one<{ genesisEnabled: boolean }>(`SELECT fleet_genesis_set_enabled($1, $2, $3) AS r`, [enabled, actor, reason]);
  }

  propose(p: { idempotencyKey: string; founderCount: number; manifestId?: string; allocationCents: number; ttlS?: number; actor: string; kind?: string }) {
    return this.one<GenesisView>(`SELECT fleet_genesis_propose($1, $2, $3, $4, $5, $6, $7) AS r`, [
      p.idempotencyKey, p.kind ?? "genesis", p.founderCount, p.manifestId ?? null, p.allocationCents, p.ttlS ?? null, p.actor,
    ]);
  }

  /** v20/v21: propose with the configured bootstrap capital; a rate only when the capital is not in the accounting currency. */
  proposeCapital(p: { idempotencyKey: string; founderCount: number; manifestId?: string; fxUsdMicro?: number | null; fxSource?: string | null; fxObservedAt?: Date | string | null; ttlS?: number; actor: string }) {
    return this.one<GenesisView>(`SELECT fleet_genesis_propose_capital($1, $2, $3, $4, $5, $6, $7, $8) AS r`, [
      p.idempotencyKey, p.founderCount, p.manifestId ?? null, p.fxUsdMicro ?? null, p.fxSource ?? null, p.fxObservedAt ?? null, p.ttlS ?? null, p.actor,
    ]);
  }

  /** v21: the ledger's accounting currency (null before v21, when the ledger was USD by constitution). */
  async accountingCurrency(): Promise<string | null> {
    const r = await this.db.query(`SELECT to_jsonb(m) ->> 'accounting_currency' AS c FROM fleet_economic_model m WHERE id = 1`);
    return (r.rows[0]?.c as string | null) ?? null;
  }

  /** v20: the configured bootstrap capital per founder (null when none is configured). */
  async bootstrapCapital(): Promise<{ currency: string; minorUnits: number } | null> {
    const r = await this.db.query(`SELECT to_jsonb(p) AS p FROM fleet_genesis_policy p WHERE id = 1`);
    const x = r.rows[0]?.p as Record<string, unknown> | undefined;
    return x && x.bootstrap_capital_minor != null ? { currency: String(x.bootstrap_capital_currency), minorUnits: Number(x.bootstrap_capital_minor) } : null;
  }

  /** v20 (owner only): the bootstrap capital for FUTURE Geneses; null clears it. */
  setBootstrapCapital(capital: { currency: string; minorUnits: number } | null, actor: string) {
    return this.one<Record<string, unknown>>(`SELECT fleet_genesis_set_bootstrap($1, $2, $3) AS r`, [capital?.currency ?? null, capital?.minorUnits ?? null, actor]);
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

  /** F1-LIVE-01 (v25): pending owner requests and knowledge proposals awaiting review, oldest first (all: every status). */
  ownerQueue(all: boolean) {
    return this.one<Record<string, unknown>>(`SELECT fleet_owner_queue($1) AS r`, [all]);
  }

  /** OWNER: record the answer to a founder's owner request. It grants nothing; the founder reads it in its task packet. */
  decideOwnerRequest(requestId: string, decision: "approved" | "declined" | "answered", response: string | null, actor: string) {
    return this.one<Record<string, unknown>>(`SELECT fleet_owner_request_decide($1, $2, $3, $4) AS r`, [requestId, decision, response, actor]);
  }

  /**
   * Admin migration step: import a legacy knowledge proposal that was really an identity/legal dependency as an
   * action-scoped dependency (same id, founder and creation time; kind and the one action stated here). Decides nothing;
   * blocks nothing but that action; idempotent.
   */
  importOwnerRequest(proposalId: string, kind: string, action: string, goalRef: string | null, actor: string) {
    return this.one<Record<string, unknown>>(`SELECT fleet_owner_request_import($1, $2, $3, $4, $5) AS r`, [proposalId, kind, action, goalRef, actor]);
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

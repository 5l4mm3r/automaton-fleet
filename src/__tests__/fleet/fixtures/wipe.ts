import type { PoolClient } from "pg";

/**
 * Test-only: empty every fleet registry table in `schema` (owner connection,
 * throwaway schema/cluster). Singleton config rows (fleet_state,
 * fleet_treasury_policy) are kept; counters and reaper bookkeeping reset.
 * Schema v10: the economic model, chart of accounts grammar and legacy
 * digests (and, v11, the capability catalogue, Genesis and reproduction policies; v13, the
 * cognition policy row, reset to its disabled default; v18, the research policy row, likewise) are kept; the fleet-scope ledger accounts are restored and the
 * ledger head reset (journals, postings and agent accounts are emptied).
 * Must run inside the caller's transaction.
 */
/** v35 singleton rows (economy-engine policies and the replication high-water state): reset to migration defaults. */
const V35_SINGLETONS = ["fleet_replication_policy", "fleet_replication_state", "fleet_mission_policy", "fleet_risk_policy",
  "fleet_notification_policy", "fleet_estate_policy"];

export async function wipeRegistry(c: PoolClient, schema: string): Promise<void> {
  const keep = new Set([
    "fleet_state", "fleet_schema_migrations", "fleet_treasury_policy",
    "fleet_economic_model", "fleet_ledger_classes", "fleet_ledger_kinds", "fleet_ledger_rules", "fleet_ledger_head", "fleet_legacy_economics",
    "fleet_capability_classes", "fleet_capability_manifests", "fleet_genesis_policy", "fleet_reproduction_policy",
    "fleet_operator_state", "fleet_operator_routes", "fleet_cognition_policy", "fleet_research_policy",
    "fleet_cognition_routing", "fleet_cognition_tiers", "fleet_action_min_tier",
    "fleet_experiment_policy", "fleet_evidence_ladder", "fleet_spend_circuit_breaker",
    "fleet_economy_policy", "fleet_venture_transition_rules", "fleet_tax_policy", "fleet_transfer_policy",
    "fleet_capital_policy", "fleet_sweep_policy", "fleet_cognition_depth_policy", "fleet_admin_withdrawal_policy", "fleet_custody_policy",
    ...V35_SINGLETONS,
  ]);
  const r = await c.query<{ t: string }>(
    "SELECT tablename AS t FROM pg_tables WHERE schemaname = $1 ORDER BY tablename",
    [schema],
  );
  const all = r.rows.map((x) => `"${schema}"."${x.t}"`);
  const wipe = r.rows.filter((x) => !keep.has(x.t)).map((x) => `"${schema}"."${x.t}"`);
  await c.query(`LOCK TABLE ${all.join(", ")} IN ACCESS EXCLUSIVE MODE`);
  for (const t of all) await c.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
  const hasLedger = r.rows.some((x) => x.t === "fleet_ledger_accounts");
  const fleetAccounts = hasLedger ? (await c.query(`SELECT * FROM "${schema}".fleet_ledger_accounts WHERE agent_id IS NULL`)).rows : [];
  await c.query(`TRUNCATE ${wipe.join(", ")} RESTART IDENTITY CASCADE`);
  if (hasLedger) {
    for (const a of fleetAccounts) {
      await c.query(
        `INSERT INTO "${schema}".fleet_ledger_accounts (account_id, class, agent_id, currency, description, created_at, created_by) VALUES ($1, $2, NULL, $3, $4, $5, $6)`,
        [a.account_id, a.class, a.currency, a.description, a.created_at, a.created_by],
      );
    }
    await c.query(`UPDATE "${schema}".fleet_ledger_head SET head_seq = 0, head_hash = repeat('0', 64)`);
  }
  const cols = await c.query<{ c: string }>(
    "SELECT column_name AS c FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'fleet_state'",
    [schema],
  );
  const has = new Set(cols.rows.map((x) => x.c));
  const sets = ["living_agents = 0", "reserved_slots = 0"];
  if (has.has("quarantined_slots")) sets.push("quarantined_slots = 0");
  if (has.has("reaper_last_run_at")) sets.push("reaper_last_run_at = NULL", "reaper_grace_from = NULL");
  await c.query(`UPDATE "${schema}".fleet_state SET ${sets.join(", ")}`);
  if (r.rows.some((x) => x.t === "fleet_cognition_policy")) {
    await c.query(`UPDATE "${schema}".fleet_cognition_policy SET cognition_enabled = false, provider = 'none', model = 'none', max_output_tokens = 1024,
      input_microcents_per_token = 0, output_microcents_per_token = 0, default_daily_budget_cents = 100, default_max_turns_per_hour = 30, updated_by = 'migration'`);
  }
  const gp = await c.query("SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'fleet_genesis_policy' AND column_name = 'genesis_max_founders'", [schema]);
  if (gp.rowCount) await c.query(`UPDATE "${schema}".fleet_genesis_policy SET genesis_max_founders = 1`);
  // v20: test registries run without a bootstrap-capital decision (plain USD allocations); production-like tests set it.
  const bc = await c.query("SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'fleet_genesis_policy' AND column_name = 'bootstrap_capital_minor'", [schema]);
  if (bc.rowCount) await c.query(`UPDATE "${schema}".fleet_genesis_policy SET bootstrap_capital_currency = NULL, bootstrap_capital_minor = NULL`);
  // v22: routing back to its inert default (off; tiers disabled and unverified).
  if (r.rows.some((x) => x.t === "fleet_cognition_tiers")) {
    await c.query(`UPDATE "${schema}".fleet_cognition_routing SET routing_enabled = false, major_spend_threshold_minor = 2000, duplicate_failure_window_s = 600, action_link_window_s = 1800, updated_by = 'migration'`);
    await c.query(`UPDATE "${schema}".fleet_cognition_tiers t SET provider = 'anthropic', model = s.model, thinking = s.thinking, effort = s.effort,
        max_output_tokens = s.max_out, input_microcents_per_token = s.i, output_microcents_per_token = s.o, cache_write_microcents_per_token = s.cw,
        cache_read_microcents_per_token = s.cr, enabled = false, verified_at = NULL, verified_ref = NULL, updated_by = 'migration'
      FROM (VALUES ('T1', 'claude-haiku-4-5-20251001', NULL, NULL, 2000, 100, 500, 125, 10),
                   ('T2', 'claude-sonnet-5-5', 'adaptive', 'medium', 8000, 200, 1000, 250, 20),
                   ('T3', 'claude-opus-5-5', 'adaptive', 'medium', 8000, 400, 2000, 500, 20)) AS s(tier, model, thinking, effort, max_out, i, o, cw, cr)
      WHERE t.tier = s.tier`);
  }
  // v23: tier prompt-cache policy back to its migration default (T1 off; T2/T3 prefix).
  const pc = await c.query("SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'fleet_cognition_tiers' AND column_name = 'prompt_cache'", [schema]);
  if (pc.rowCount) await c.query(`UPDATE "${schema}".fleet_cognition_tiers SET prompt_cache = CASE WHEN tier = 'T1' THEN 'off' ELSE 'prefix' END`);
  // v24: experiment pipeline back to its inert defaults (off; ladder caps as seeded).
  if (r.rows.some((x) => x.t === "fleet_experiment_policy")) {
    await c.query(`UPDATE "${schema}".fleet_experiment_policy SET enabled = false, hard_cap_minor = 5000, max_proposal_ttl_s = 1209600, approval_ttl_s = 604800, relevance_max_calls_per_hour = 60,
      max_run_s = 2592000, max_active_per_founder = 3, updated_by = 'migration'`);
    await c.query(`UPDATE "${schema}".fleet_evidence_ladder l SET auto_cap_minor = s.cap, updated_by = 'migration'
      FROM (VALUES (0, 0::bigint), (1, 300::bigint), (2, 1000::bigint), (3, 2500::bigint), (4, NULL::bigint)) AS s(level, cap) WHERE l.level = s.level`);
  }
  if (r.rows.some((x) => x.t === "fleet_research_policy")) {
    await c.query(`UPDATE "${schema}".fleet_research_policy SET research_enabled = false, founder_hourly = 60, founder_daily = 300,
      fleet_hourly = 120, fleet_daily = 600, updated_by = 'migration'`);
  }
  // v27: the spend circuit breaker is a singleton infrastructure row (a missing row fails closed): back to every signal unset.
  if (r.rows.some((x) => x.t === "fleet_spend_circuit_breaker")) {
    await c.query(`UPDATE "${schema}".fleet_spend_circuit_breaker SET tripped = false, trip_reason = NULL, order_wallet_bp = NULL,
      velocity_window_s = NULL, velocity_wallet_bp = NULL, updated_by = 'migration'`);
  }
  // v28: the economy policy back to its migration defaults (the transition rules are grammar and are kept as is).
  if (r.rows.some((x) => x.t === "fleet_economy_policy")) {
    await c.query(`UPDATE "${schema}".fleet_economy_policy SET shortlist_max = 5, evidence_fresh_days = 30, knowledge_fresh_days = 180, forecast_tolerance_bp = 2500,
      failsafe_open_opportunities = 60, failsafe_active_ventures = 25, failsafe_records_per_day = 400, failsafe_vendors_per_day = 20, research_loop_fetches = 40, research_loop_window_h = 24,
      no_route_hours = 72, updated_by = 'migration'`);
  }
  // v29: tax fallback and safe-transfer policy back to their defaults; the circuit-breaker novelty signal unset.
  if (r.rows.some((x) => x.t === "fleet_tax_policy")) {
    // v33 pins the retired unprofiled reserve to 0 (no synthetic tax); before v33 its default was 2500.
    const v33 = (await c.query(`SELECT 1 FROM pg_constraint WHERE conname = 'fleet_tax_policy_no_synthetic_tax' AND connamespace = '"${schema}"'::regnamespace`)).rows.length > 0;
    await c.query(`UPDATE "${schema}".fleet_tax_policy SET unprofiled_reserve_bp = ${v33 ? 0 : 2500}, updated_by = 'migration'`);
    await c.query(`UPDATE "${schema}".fleet_transfer_policy SET cushion_bp = 1000, horizon_days = 30, burn_window_days = 30, updated_by = 'migration'`);
    await c.query(`UPDATE "${schema}".fleet_spend_circuit_breaker SET new_destination_age_s = NULL, new_destination_wallet_bp = NULL`);
  }
  // v30: capital, sweep and cognition-depth policy back to their migration defaults (sweeps disabled).
  if (r.rows.some((x) => x.t === "fleet_capital_policy")) {
    await c.query(`UPDATE "${schema}".fleet_capital_policy SET version = 1, enabled = true, treasury_reserve_bp = 5000, max_request_treasury_bp = 1000,
      max_agent_exposure_bp = 2500, partial_tranche_bp = 5000, min_confidence_bp = 3000, min_evidence_items = 2, min_track_record = 3, limited_stop_loss_bp = 5000,
      envelope_days = 30, limited_envelope_days = 14, high_roi_bp = 5000, reinvestment_reduction_bp = 2500, reapply_cooldown_s = 3600,
      limited_max_single_bp = 5000, calibration_floor_bp = 2500, updated_by = 'migration'`);
    await c.query(`UPDATE "${schema}".fleet_sweep_policy SET enabled = false, mature_fleet_bp = 4500, max_bp = 7000, maturity_days = 180, surplus_multiple = 4,
      population_bands = '[{"maxAgents":10,"rateBp":1000},{"maxAgents":20,"rateBp":1250},{"maxAgents":30,"rateBp":1500},{"maxAgents":40,"rateBp":1750},{"maxAgents":49,"rateBp":2000}]', updated_by = 'migration'`);
    await c.query(`UPDATE "${schema}".fleet_cognition_depth_policy SET major_exposure_bp = 2500, updated_by = 'migration'`);
  }
  // v31: admin-withdrawal risk advice back to its default (10 % cushion, 30-day horizon).
  if (r.rows.some((x) => x.t === "fleet_admin_withdrawal_policy")) {
    await c.query(`UPDATE "${schema}".fleet_admin_withdrawal_policy SET cushion_bp = 1000, horizon_days = 30, updated_by = 'migration'`);
  }
  // v32: custody signer heartbeat window back to its default.
  if (r.rows.some((x) => x.t === "fleet_custody_policy")) {
    await c.query(`UPDATE "${schema}".fleet_custody_policy SET attestation_ttl_s = 900, updated_by = 'migration'`);
  }
  for (const t of V35_SINGLETONS) {
    if (r.rows.some((x) => x.t === t)) await c.query(`DELETE FROM "${schema}".${t}; INSERT INTO "${schema}".${t} (id) VALUES (1)`);
  }
  for (const t of all) await c.query(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
  // v21 fixtures: an identity USD→GBP rate (so historical accounting expectations keep their numbers) and generous
  // synthetic native-USD provider credit. Tests of FX and credit exhaustion set their own.
  if (r.rows.some((x) => x.t === "fleet_fx_rates")) {
    await c.query(`INSERT INTO "${schema}".fleet_fx_rates (base, quote, rate_micro, source, observed_on, recorded_by)
      SELECT 'USD', m.accounting_currency, 1000000, 'test fixture (identity rate)', (now() AT TIME ZONE 'UTC')::date, 'operator:test-fixture'
        FROM "${schema}".fleet_economic_model m WHERE m.id = 1 AND m.accounting_currency <> 'USD'`);
    for (const provider of ["anthropic", "openai_compatible", "scripted"]) {
      await c.query(`INSERT INTO "${schema}".fleet_provider_credit_events (provider, kind, usd_microcents, external_ref, recorded_by)
        VALUES ($1, 'purchase', 100000000000000, 'test fixture credit', 'operator:test-fixture')`, [provider]);
    }
  }
}

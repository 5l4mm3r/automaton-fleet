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
export async function wipeRegistry(c: PoolClient, schema: string): Promise<void> {
  const keep = new Set([
    "fleet_state", "fleet_schema_migrations", "fleet_treasury_policy",
    "fleet_economic_model", "fleet_ledger_classes", "fleet_ledger_kinds", "fleet_ledger_rules", "fleet_ledger_head", "fleet_legacy_economics",
    "fleet_capability_classes", "fleet_capability_manifests", "fleet_genesis_policy", "fleet_reproduction_policy",
    "fleet_operator_state", "fleet_operator_routes", "fleet_cognition_policy", "fleet_research_policy",
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
  if (r.rows.some((x) => x.t === "fleet_research_policy")) {
    await c.query(`UPDATE "${schema}".fleet_research_policy SET research_enabled = false, founder_hourly = 60, founder_daily = 300,
      fleet_hourly = 120, fleet_daily = 600, updated_by = 'migration'`);
  }
  for (const t of all) await c.query(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
}

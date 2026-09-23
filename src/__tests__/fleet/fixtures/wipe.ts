import type { PoolClient } from "pg";

/**
 * Test-only: empty every fleet registry table in `schema` (owner connection,
 * throwaway schema/cluster). Singleton config rows (fleet_state,
 * fleet_treasury_policy) are kept; counters and reaper bookkeeping reset.
 * Must run inside the caller's transaction.
 */
export async function wipeRegistry(c: PoolClient, schema: string): Promise<void> {
  const keep = new Set(["fleet_state", "fleet_schema_migrations", "fleet_treasury_policy"]);
  const r = await c.query<{ t: string }>(
    "SELECT tablename AS t FROM pg_tables WHERE schemaname = $1 ORDER BY tablename",
    [schema],
  );
  const all = r.rows.map((x) => `"${schema}"."${x.t}"`);
  const wipe = r.rows.filter((x) => !keep.has(x.t)).map((x) => `"${schema}"."${x.t}"`);
  await c.query(`LOCK TABLE ${all.join(", ")} IN ACCESS EXCLUSIVE MODE`);
  for (const t of all) await c.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
  await c.query(`TRUNCATE ${wipe.join(", ")} RESTART IDENTITY CASCADE`);
  const cols = await c.query<{ c: string }>(
    "SELECT column_name AS c FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'fleet_state'",
    [schema],
  );
  const has = new Set(cols.rows.map((x) => x.c));
  const sets = ["living_agents = 0", "reserved_slots = 0"];
  if (has.has("quarantined_slots")) sets.push("quarantined_slots = 0");
  if (has.has("reaper_last_run_at")) sets.push("reaper_last_run_at = NULL", "reaper_grace_from = NULL");
  await c.query(`UPDATE "${schema}".fleet_state SET ${sets.join(", ")}`);
  for (const t of all) await c.query(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
}

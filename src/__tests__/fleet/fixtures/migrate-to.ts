/**
 * Apply the fleet migrations only up to `maxVersion` (tests of superseded
 * behaviour: e.g. v5 legacy economics before the v10 ledger froze them).
 */

import pg from "pg";
import { PG_MIGRATIONS } from "../../../fleet/postgres/migrations.js";

export async function migrateUpTo(ownerUrl: string, schema: string, maxVersion: number): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error("bad schema");
  const pool = new pg.Pool({ connectionString: ownerUrl, max: 1 });
  const c = await pool.connect();
  try {
    await c.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await c.query(`CREATE TABLE IF NOT EXISTS "${schema}".fleet_schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const m of PG_MIGRATIONS.filter((x) => x.version <= maxVersion)) {
      const done = await c.query(`SELECT 1 FROM "${schema}".fleet_schema_migrations WHERE version = $1`, [m.version]);
      if (done.rowCount) continue;
      await c.query("BEGIN");
      await c.query(`SET LOCAL search_path TO "${schema}"`);
      await c.query(m.sql.replaceAll("@@SCHEMA@@", `"${schema}"`));
      await c.query(`INSERT INTO "${schema}".fleet_schema_migrations (version, name) VALUES ($1, $2)`, [m.version, m.name]);
      await c.query("COMMIT");
    }
  } finally {
    c.release();
    await pool.end();
  }
}

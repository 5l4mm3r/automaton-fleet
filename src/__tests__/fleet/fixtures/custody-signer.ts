/**
 * Test-only stand-in for the future reviewed live-activation migration, in a schema of its own: removes the two
 * constitutional pins (custody execution off, rails never live), registers a legal entity, a scoped PayPal credential
 * reference and a LIVE payout rail, and lets the custody role attest a signer for it. Production keeps both pins.
 */
import type pg from "pg";

export interface ArmedCustody {
  entityId: string;
  credentialId: string;
  railId: string;
  vaultRef: string;
}

const q1 = async (db: pg.Pool | pg.PoolClient, sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];

/** Drop the pins in `schema` (owner connection) — the activation stand-in. */
export async function unpinCustody(owner: pg.Pool, schema: string): Promise<void> {
  for (const [table, def] of [["fleet_economic_model", "NOT custody_execution_enabled"], ["fleet_payment_rails", "mode <> 'live'"]] as const) {
    const c = await q1(owner, `SELECT conname FROM pg_constraint WHERE conrelid = '${schema}.${table}'::regclass AND pg_get_constraintdef(oid) ~ $1`, [def.replace(/[()]/g, "\\$&")]);
    if (c) await owner.query(`ALTER TABLE ${schema}.${table} DROP CONSTRAINT ${c.conname}`);
  }
  await owner.query(`UPDATE ${schema}.fleet_economic_model SET custody_execution_enabled = true`);
}

/** A live PayPal payout rail with its credential reference (never a secret) in `schema`. */
export async function liveRail(owner: pg.Pool, schema: string, actor: string, opts: { vaultRef?: string; scope?: string[]; label?: string } = {}): Promise<ArmedCustody> {
  const vaultRef = opts.vaultRef ?? `vault:paypal/treasury-${Math.random().toString(36).slice(2, 8)}`;
  const ent = await q1(owner, `SELECT ${schema}.fleet_admin_legal_entity_add($1, 'GB', 'company', false, $2) AS r`, [`Fleet Ltd ${vaultRef.slice(-6)}`, actor]);
  const entityId = ent.r.entityId ?? ent.r.entity_id;
  const cred = await q1(owner, `SELECT ${schema}.fleet_admin_credential_register('paypal', 'Treasury payouts', $1, $2, false, NULL, $3) AS r`,
    [vaultRef, opts.scope ?? ["payouts"], actor]);
  const credentialId = cred.r.credential_id;
  const rail = await q1(owner, `SELECT ${schema}.fleet_admin_rail_add('paypal', $1, 'shared', $2, ARRAY['payouts','receive_payments'], 'PayPal treasury', $3, 'live', NULL, NULL, $4) AS r`,
    [opts.label ?? "PayPal treasury", entityId, credentialId, actor]);
  return { entityId, credentialId, railId: rail.r.railId ?? rail.r.rail_id, vaultRef };
}

/** The custody role attests a signer for the rail. */
export async function attest(custody: pg.Pool, schema: string, a: ArmedCustody, worker = "custody-executor"): Promise<Record<string, any>> {
  return (await q1(custody, `SELECT ${schema}.cx_attest_signer($1, $2, 'paypal', 'live', $3) AS r`, [worker, a.railId, a.credentialId])).r;
}

/**
 * Test-only: give a registered root the keyless identity a Genesis founder has (Genesis itself derives it at creation).
 * Triggers are bypassed exactly as the other fixtures do for clock/identity setup.
 */
export async function makeKeyless(su: pg.Pool, schema: string, agentId: string): Promise<void> {
  const c = await su.connect();
  try {
    await c.query("SET session_replication_role = replica");
    await c.query(`UPDATE ${schema}.fleet_agents SET wallet_address = ${schema}.fleet_keyless_address(agent_id) WHERE agent_id = $1`, [agentId]);
    await c.query(`UPDATE ${schema}.fleet_wallet_custody SET wallet_address = ${schema}.fleet_keyless_address(agent_id), custody_mode = 'controller_keyless' WHERE agent_id = $1`, [agentId]);
  } finally {
    await c.query("RESET session_replication_role");
    c.release();
  }
}

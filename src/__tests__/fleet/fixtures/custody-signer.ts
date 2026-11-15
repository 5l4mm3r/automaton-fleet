/**
 * Arms custody in a test schema the way the owner does on a real registry (schema v48): an owner custody activation
 * (four-key model — the activation, a verified live PayPal rail, a fresh live signer attestation and, outside SQL, the
 * custody executor's REAL_PAYMENTS_ENABLED), a legal entity, a scoped PayPal credential reference and a LIVE payout rail.
 * Production keeps custody off until the owner grants an activation.
 */
import type pg from "pg";

export interface ArmedCustody {
  entityId: string;
  credentialId: string;
  railId: string;
  vaultRef: string;
}

const q1 = async (db: pg.Pool | pg.PoolClient, sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];

/** Grant a custody activation in `schema` (owner connection), generous limits, 24 hours. */
export async function unpinCustody(owner: pg.Pool, schema: string, actor = "operator:owner",
  limits: { maxInstructionMinor?: number; maxDailyMinor?: number; hours?: number } = {}): Promise<string> {
  const r = await q1(owner, `SELECT ${schema}.fleet_admin_custody_activate($1, $2, $3, 'test activation', $4) AS r`,
    [limits.maxInstructionMinor ?? 100_000_000, limits.maxDailyMinor ?? 1_000_000_000, limits.hours ?? 24, actor]);
  return r.r.activationId;
}

/** A live PayPal payout rail with its credential reference (never a secret) in `schema`. */
export async function liveRail(owner: pg.Pool, schema: string, actor: string, opts: { vaultRef?: string; scope?: string[]; label?: string; capabilities?: string[] } = {}): Promise<ArmedCustody> {
  const vaultRef = opts.vaultRef ?? `vault:paypal/treasury-${Math.random().toString(36).slice(2, 8)}`;
  const ent = await q1(owner, `SELECT ${schema}.fleet_admin_legal_entity_add($1, 'GB', 'company', false, $2) AS r`, [`Fleet Ltd ${vaultRef.slice(-6)}`, actor]);
  const entityId = ent.r.entityId ?? ent.r.entity_id;
  const cred = await q1(owner, `SELECT ${schema}.fleet_admin_credential_register('paypal', 'Treasury payouts', $1, $2, false, NULL, $3) AS r`,
    [vaultRef, opts.scope ?? ["payouts"], actor]);
  const credentialId = cred.r.credential_id;
  const rail = await q1(owner, `SELECT ${schema}.fleet_admin_rail_add('paypal', $1, 'shared', $2, $5::text[], 'PayPal treasury', $3, 'live', NULL, NULL, $4) AS r`,
    [opts.label ?? "PayPal treasury", entityId, credentialId, actor, opts.capabilities ?? ["payouts", "receive_payments"]]);
  const railId = rail.r.railId ?? rail.r.rail_id;
  // v46: a real rail starts pending_setup; this test rail records the evidence its capabilities need, then goes active.
  for (const check of ["account_access", "payout_reconciliation", "sale_ingestion"]) {
    await q1(owner, `SELECT ${schema}.fleet_admin_rail_verify($1, $2, 'verified', 'probe', '{"note":"test fixture"}'::jsonb, NULL, $3) AS r`, [railId, check, actor]);
  }
  await q1(owner, `SELECT ${schema}.fleet_admin_rail_set_status($1, 'active', 'test fixture', $2) AS r`, [railId, actor]);
  return { entityId, credentialId, railId, vaultRef };
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

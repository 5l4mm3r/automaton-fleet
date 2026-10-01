/**
 * Fleet Hub (F2, schema v30): the owner's economy views and infrastructure controls over the admin connection.
 *
 * The Hub is observability and infrastructure administration — Treasury, legal/tax setup, payment accounts, credentials,
 * security and audit. It is not a management queue: nothing here approves an agent's business decision. Every write is
 * an owner function that records an audit event; reads come from fleet_hub(section).
 */
import pg from "pg";

export const HUB_SECTIONS = ["overview", "agents", "wallet", "ventures", "treasury", "rails", "tax", "capital", "envelopes", "opportunities", "profit",
  "dependencies", "credentials", "audit", "reconcile"] as const;
export type HubSection = (typeof HUB_SECTIONS)[number];

export class PgHubAdmin {
  private readonly pool: pg.Pool;
  constructor(o: { connectionString: string; schema?: string }) {
    const schema = o.schema ?? "fleet";
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error("bad schema");
    this.pool = new pg.Pool({ connectionString: o.connectionString, max: 2, application_name: "automaton-fleet-hub-admin",
      options: `-c search_path=${schema} -c statement_timeout=30000 -c lock_timeout=5000` });
    this.pool.on("error", () => {});
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async one<T = unknown>(sql: string, params: unknown[] = []): Promise<T> {
    return (await this.pool.query(sql, params)).rows[0]?.r as T;
  }

  view(section: HubSection, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!HUB_SECTIONS.includes(section)) throw new Error(`FLEET_BAD_REQUEST: section is one of ${HUB_SECTIONS.join(", ")}`);
    return this.one(`SELECT fleet_hub($1, $2::jsonb) AS r`, [section, JSON.stringify(args)]);
  }

  health(): Promise<{ ok: boolean; warn: boolean; findings: Array<{ severity: string; code: string; detail: unknown }> }> {
    return this.one(`SELECT fleet_economy_health() AS r`);
  }

  // ── Legal entities, tax ────────────────────────────────────────────
  entityAdd(name: string, jurisdiction: string, kind: string, isDefault: boolean, actor: string) {
    return this.one(`SELECT fleet_admin_legal_entity_add($1, $2, $3, $4, $5) AS r`, [name, jurisdiction, kind, isDefault, actor]);
  }
  taxProfileSet(entityId: string, rules: unknown, effective: string | null, note: string | null, actor: string) {
    return this.one(`SELECT fleet_admin_tax_profile_set($1, $2::jsonb, $3, $4, $5) AS r`, [entityId, JSON.stringify(rules), effective, note, actor]);
  }
  taxPolicySet(unprofiledBp: number, actor: string) {
    return this.one(`SELECT fleet_admin_tax_policy_set($1, $2) AS r`, [unprofiledBp, actor]);
  }
  taxTrueUp(agentId: string, actor: string) {
    return this.one(`SELECT fleet_tax_true_up($1, $2) AS r`, [agentId, actor]);
  }
  taxPayment(agentId: string, amountMinor: number, externalRef: string, actor: string, idem: string) {
    return this.one(`SELECT fleet_admin_tax_payment($1, $2, $3, $4, $5) AS r`, [agentId, amountMinor, externalRef, actor, idem]);
  }

  // ── Payment accounts, credentials ─────────────────────────────────
  railAdd(r: { provider: string; label: string; kind: string; entityId: string | null; capabilities: string[]; accountRef: string; credentialId: string | null;
    mode: string; dedicatedVentureId: string | null; maxVentures: number | null }, actor: string) {
    return this.one(`SELECT fleet_admin_rail_add($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) AS r`,
      [r.provider, r.label, r.kind, r.entityId, r.capabilities, r.accountRef, r.credentialId, r.mode, r.dedicatedVentureId, r.maxVentures, actor]);
  }
  railStatus(railId: string, status: string, note: string | null, actor: string) {
    return this.one(`SELECT fleet_admin_rail_set_status($1, $2, $3, $4) AS r`, [railId, status, note, actor]);
  }
  credentialRegister(provider: string, purpose: string, vaultRef: string, scope: string[], spendLimited: boolean, hint: string | null, actor: string) {
    return this.one(`SELECT fleet_admin_credential_register($1, $2, $3, $4, $5, $6, $7) AS r`, [provider, purpose, vaultRef, scope, spendLimited, hint, actor]);
  }
  credentialStatus(credentialId: string, status: string, actor: string) {
    return this.one(`SELECT fleet_admin_credential_set_status($1, $2, $3) AS r`, [credentialId, status, actor]);
  }
  settlementAttribute(txnId: string, ventureId: string, actor: string) {
    return this.one(`SELECT fleet_admin_settlement_attribute($1, $2, $3) AS r`, [txnId, ventureId, actor]);
  }

  // ── Policies (configuration; never per-decision approvals) ─────────
  capitalPolicy(p: Record<string, unknown>, actor: string) {
    return this.one(`SELECT fleet_admin_capital_policy_set($1::jsonb, $2) AS r`, [JSON.stringify(p), actor]);
  }
  sweepPolicy(p: { enabled?: boolean; bands?: unknown; matureBp?: number; maxBp?: number; maturityDays?: number; surplusMultiple?: number }, actor: string) {
    return this.one(`SELECT fleet_admin_sweep_policy_set($1, $2::jsonb, $3, $4, $5, $6, $7) AS r`,
      [p.enabled ?? null, p.bands === undefined ? null : JSON.stringify(p.bands), p.matureBp ?? null, p.maxBp ?? null, p.maturityDays ?? null, p.surplusMultiple ?? null, actor]);
  }
  transferPolicy(cushionBp: number | null, horizonDays: number | null, burnWindowDays: number | null, actor: string) {
    return this.one(`SELECT fleet_admin_transfer_policy_set($1, $2, $3, $4) AS r`, [cushionBp, horizonDays, burnWindowDays, actor]);
  }
  cognitionDepth(majorExposureBp: number, actor: string) {
    return this.one(`SELECT fleet_admin_cognition_depth_set($1, $2) AS r`, [majorExposureBp, actor]);
  }
  economyPolicy(p: Record<string, unknown>, actor: string) {
    return this.one(`SELECT fleet_admin_economy_policy_set($1::jsonb, $2) AS r`, [JSON.stringify(p), actor]);
  }
  breakerNovelty(ageS: number | null, walletBp: number | null, actor: string) {
    return this.one(`SELECT fleet_admin_spend_circuit_breaker_novelty($1, $2, $3) AS r`, [actor, ageS, walletBp]);
  }

  // ── Treasury / solvency management ────────────────────────────────
  safeTransfer(agentId: string) {
    return this.one(`SELECT fleet_safe_transfer_amount($1) AS r`, [agentId]);
  }
  walletTransfer(agentId: string, amountMinor: number, target: "treasury" | "operating_pool", reason: string, actor: string, idem: string) {
    return this.one(`SELECT fleet_admin_wallet_transfer($1, $2, $3, $4, $5, $6) AS r`, [agentId, amountMinor, target, reason, actor, idem]);
  }
  sweepCompute(agentId: string) {
    return this.one(`SELECT fleet_sweep_compute($1) AS r`, [agentId]);
  }
}

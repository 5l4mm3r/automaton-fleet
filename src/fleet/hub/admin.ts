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

  /** v31: FleetController's admin-withdrawal risk advice for an amount (or the recommendation alone) and the audited history. */
  withdrawals(amountMinor: number | null) {
    return this.one(`SELECT fleet_hub_withdrawals($1) AS r`, [amountMinor]);
  }
  withdrawalPolicy(cushionBp: number | null, horizonDays: number | null, actor: string) {
    return this.one(`SELECT fleet_admin_withdrawal_policy_set($1, $2, $3) AS r`, [cushionBp, horizonDays, actor]);
  }

  /** v34: agent identities/accounts, the owner identity vault's metadata and the broker queue (never a value or secret). */
  identity(agentId: string | null) {
    return this.one(`SELECT fleet_hub_identity($1) AS r`, [agentId]);
  }
  ownerIdentityClass(cls: string, status: string, expiresAt: string | null, actor: string) {
    return this.one(`SELECT fleet_admin_owner_identity_class_set($1, $2, $3, $4, $5) AS r`, [cls, `ovault:${cls}`, expiresAt, status, actor]);
  }
  ownerIdentityConsent(purposes: string[], providers: string[] | null, classes: string[], statement: string, actor: string) {
    return this.one(`SELECT fleet_admin_owner_identity_consent_set($1, $2, $3, $4, $5) AS r`, [purposes, providers, classes, statement, actor]);
  }
  ownerIdentityConsentRevoke(consentId: string, actor: string) {
    return this.one(`SELECT fleet_admin_owner_identity_consent_revoke($1, $2) AS r`, [consentId, actor]);
  }
  identityStatus() {
    return this.one(`SELECT fleet_identity_status() AS r`);
  }

  /** v32: custody facts (keyless vs self-keyed agents, attested signers, instruction states). */
  custody() {
    return this.one(`SELECT fleet_custody_status() AS r`);
  }
  custodyPolicy(ttlS: number, actor: string) {
    return this.one(`SELECT fleet_admin_custody_policy_set($1, $2) AS r`, [ttlS, actor]);
  }
  /** v32: record an owner-enrolled destination's payable reference (only the enrolled one is accepted). */
  destinationReference(destinationId: string, reference: string, actor: string) {
    return this.one(`SELECT fleet_admin_destination_reference_set($1, $2, $3) AS r`, [destinationId, reference, actor]);
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
  /** v35: no economic cap — above the advised safe amount the Admin acknowledges; only the real balance binds. */
  walletTransfer(agentId: string, amountMinor: number, target: "treasury" | "operating_pool", reason: string, actor: string, idem: string, acknowledge = false) {
    return this.one(`SELECT fleet_admin_wallet_transfer($1, $2, $3, $4, $5, $6, $7) AS r`, [agentId, amountMinor, target, reason, actor, idem, acknowledge]);
  }
  agentTransfer(from: string, to: string, amountMinor: number, reason: string, actor: string, idem: string, acknowledge = false) {
    return this.one(`SELECT fleet_admin_agent_transfer($1, $2, $3, $4, $5, $6, $7) AS r`, [from, to, amountMinor, reason, actor, idem, acknowledge]);
  }

  // ── v35 economy engine: replication, births, missions, estates, notifications, risk ──
  engine() {
    return this.one(`SELECT fleet_hub_engine() AS r`);
  }
  replication() {
    return this.one(`SELECT fleet_admin_replication_status() AS r`);
  }
  replicationPolicy(patch: Record<string, unknown>, actor: string) {
    return this.one(`SELECT fleet_admin_replication_policy_set($1::jsonb, $2) AS r`, [JSON.stringify(patch), actor]);
  }
  birth(mission: string, reason: string, fundingMinor: number, role: string | null, actor: string, idem: string) {
    return this.one(`SELECT fleet_admin_birth($1, $2, $3, $4, $5, $6) AS r`, [mission, reason, fundingMinor, role, actor, idem]);
  }
  reseed(deadAgentId: string, reason: string, fundingMinor: number, actor: string, idem: string) {
    return this.one(`SELECT fleet_admin_reseed($1, $2, $3, $4, $5) AS r`, [deadAgentId, reason, fundingMinor, actor, idem]);
  }
  birthFulfil(orderId: string, agentId: string, actor: string) {
    return this.one(`SELECT fleet_admin_birth_fulfil($1, $2, $3) AS r`, [orderId, agentId, actor]);
  }
  birthCancel(orderId: string, reason: string, actor: string) {
    return this.one(`SELECT fleet_admin_birth_cancel($1, $2, $3) AS r`, [orderId, reason, actor]);
  }
  missionAssign(agentId: string, kind: string, brief: string, beneficiaries: unknown[] | null, actor: string) {
    return this.one(`SELECT fleet_admin_mission_assign($1, $2, $3, $4::jsonb, $5) AS r`, [agentId, kind, brief, beneficiaries ? JSON.stringify(beneficiaries) : null, actor]);
  }
  missionEnd(missionId: string, outcome: string | null, actor: string) {
    return this.one(`SELECT fleet_admin_mission_end($1, $2, $3) AS r`, [missionId, outcome, actor]);
  }
  missionRequest(kind: string, brief: string, beneficiaries: unknown[] | null, actor: string) {
    return this.one(`SELECT fleet_admin_mission_request($1, $2, $3::jsonb, $4) AS r`, [kind, brief, beneficiaries ? JSON.stringify(beneficiaries) : null, actor]);
  }
  missionPolicy(patch: Record<string, unknown>, actor: string) {
    return this.one(`SELECT fleet_admin_mission_policy_set($1::jsonb, $2) AS r`, [JSON.stringify(patch), actor]);
  }
  estates() {
    return this.one(`SELECT fleet_admin_estates() AS r`);
  }
  estateAssign(itemId: string, agentId: string, actor: string) {
    return this.one(`SELECT fleet_admin_estate_assign($1, $2, $3) AS r`, [itemId, agentId, actor]);
  }
  estateRelease(itemId: string, reason: string | null, actor: string) {
    return this.one(`SELECT fleet_admin_estate_release($1, $2, $3) AS r`, [itemId, reason, actor]);
  }
  notifications(limit: number, unacknowledgedOnly: boolean) {
    return this.one(`SELECT fleet_admin_notifications($1, $2) AS r`, [limit, unacknowledgedOnly]);
  }
  notificationAck(id: string, actor: string) {
    return this.one(`SELECT fleet_admin_notification_ack($1, $2) AS r`, [id, actor]);
  }
  notificationPolicy(dailyHourUtc: number | null, adminEmail: string | null, actor: string) {
    return this.one(`SELECT fleet_admin_notification_policy_set($1, $2, $3) AS r`, [dailyHourUtc, adminEmail, actor]);
  }
  riskPolicy(patch: Record<string, unknown>, actor: string) {
    return this.one(`SELECT fleet_admin_risk_policy_set($1::jsonb, $2) AS r`, [JSON.stringify(patch), actor]);
  }
  riskContext(agentId: string, amountMinor: number | null) {
    return this.one(`SELECT fleet_agent_risk_context($1, $2) AS r`, [agentId, amountMinor]);
  }
  dailyReport() {
    return this.one(`SELECT fleet_daily_report() AS r`);
  }

  // ── v36: communications, reveal through the broker, owner vault upload ──
  comms(agentId: string | null) {
    return this.one(`SELECT fleet_hub_comms($1) AS r`, [agentId]);
  }
  brokerOwnerKey() {
    return this.one<{ ownerPub: string | null; fingerprint?: string; publishedAt?: string }>(`SELECT fleet_admin_broker_owner_key() AS r`);
  }
  ownerVaultUpload(cls: string, sealed: Buffer, contentType: string, expiresAt: string | null, actor: string) {
    return this.one(`SELECT fleet_admin_owner_vault_upload($1, $2, $3, $4, $5) AS r`, [cls, sealed, contentType, expiresAt, actor]);
  }
  revealRequest(kind: "agent_credential" | "owner_identity", target: string, ephemeralPubB64: string, stepupRef: string, actor: string) {
    return this.one<{ ok: boolean; requestId: string; expiresAt: string }>(`SELECT fleet_admin_reveal_request($1, $2, $3, $4, $5) AS r`,
      [kind, target, ephemeralPubB64, stepupRef, actor]);
  }
  revealTake(requestId: string, actor: string) {
    return this.one<{ ok: boolean; status?: string; sealedB64?: string; code?: string }>(`SELECT fleet_admin_reveal_take($1, $2) AS r`, [requestId, actor]);
  }
  /** v38: a one-time dashboard enrollment token (first passkey + TOTP, or recovery); the database keeps its digest only. */
  dashboardEnroll(tokenSha: string, actor: string) {
    return this.one(`SELECT fleet_admin_dashboard_enroll($1, $2) AS r`, [tokenSha, actor]);
  }
  /** v37: browser sessions, actions, credential requests and refused origins (no secret). */
  browser(agentId: string | null) {
    return this.one(`SELECT fleet_hub_browser($1) AS r`, [agentId]);
  }
  revealLog(limit: number) {
    return this.one(`SELECT fleet_admin_reveal_log($1) AS r`, [limit]);
  }
  sweepCompute(agentId: string) {
    return this.one(`SELECT fleet_sweep_compute($1) AS r`, [agentId]);
  }
}

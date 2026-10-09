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
  /** v46: record evidence for one readiness check of a rail (append-only; the latest row per check counts). */
  railVerify(railId: string, check: string, status: string, evidenceKind: string, note: string | null, expiresAt: string | null, actor: string) {
    return this.one(`SELECT fleet_admin_rail_verify($1, $2, $3, $4, $5::jsonb, $6, $7) AS r`,
      [railId, check, status, evidenceKind, JSON.stringify(note ? { note } : {}), expiresAt, actor]);
  }
  // ── v48: custody activation, wallet limits, card clearing, the treasury list and PayPal ──
  /** `hours` null: an ongoing activation (v51; no expiry, ends only when the owner ends it). */
  custodyActivate(maxInstructionMinor: number, maxDailyMinor: number, hours: number | null, reason: string, actor: string) {
    return this.one(`SELECT fleet_admin_custody_activate($1, $2, $3, $4, $5) AS r`, [maxInstructionMinor, maxDailyMinor, hours, reason, actor]);
  }
  custodyDeactivate(reason: string | null, actor: string) {
    return this.one(`SELECT fleet_admin_custody_deactivate($1, $2) AS r`, [reason, actor]);
  }
  walletLimits(agentId: string, maxInstructionMinor: number | null, maxDailyMinor: number | null, cardMaxMinor: number | null, cardDailyMinor: number | null,
    note: string | null, actor: string) {
    return this.one(`SELECT fleet_admin_wallet_limits_set($1, $2, $3, $4, $5, $6, $7) AS r`, [agentId, maxInstructionMinor, maxDailyMinor, cardMaxMinor, cardDailyMinor, note, actor]);
  }
  cardCharge(agentId: string, amountMinor: number, merchant: string, statementRef: string, actor: string) {
    return this.one(`SELECT fleet_admin_card_charge_record($1, $2, $3, $4, $5) AS r`, [agentId, amountMinor, merchant, statementRef, actor]);
  }
  cardConfirm(chargeId: string, amountMinor: number, statementRef: string, actor: string) {
    return this.one(`SELECT fleet_admin_card_charge_confirm($1, $2, $3, $4) AS r`, [chargeId, amountMinor, statementRef, actor]);
  }
  cardRepay(amountMinor: number, reference: string, actor: string) {
    return this.one(`SELECT fleet_admin_card_repayment_record($1, $2, $3) AS r`, [amountMinor, reference, actor]);
  }
  cardReceipt(agentId: string, amountMinor: number, kind: string, reference: string, note: string | null, actor: string) {
    return this.one(`SELECT fleet_admin_card_receipt_record($1, $2, $3, $4, $5, $6) AS r`, [agentId, amountMinor, kind, reference, note, actor]);
  }
  cardResolve(receiptId: string, resolution: string, sweepMinor: number | null, reference: string | null, actor: string) {
    return this.one(`SELECT fleet_admin_card_receipt_resolve($1, $2, $3, $4, $5) AS r`, [receiptId, resolution, sweepMinor, reference, actor]);
  }
  /** v51: return / withdrawal, by transfer (the money reached the owner) or applied to the card balance. */
  /** v57: the swept share of a return goes to the treasury unless sweepTo = owner (an explicit owner withdrawal). */
  cardSettle(receiptId: string, resolution: string, method: string, sweepMinor: number | null, reference: string | null, actor: string, sweepTo: "treasury" | "owner" = "treasury") {
    return this.one(`SELECT fleet_admin_card_receipt_settle($1, $2, $3, $4, $5, $6, $7) AS r`, [receiptId, resolution, method, sweepMinor, reference, actor, sweepTo]);
  }
  // ── v57: PayPal disputes and debits Transaction Search could not classify ──
  paypalDisputes() { return this.one(`SELECT fleet_paypal_disputes_json() AS r`); }
  paypalDisputeResolve(disputeId: string, outcome: string, note: string | null, actor: string) {
    return this.one(`SELECT fleet_admin_paypal_dispute_resolve($1, $2, $3, $4) AS r`, [disputeId, outcome, note, actor]);
  }
  paypalDebitClassify(refId: string, as: string, note: string | null, actor: string) {
    return this.one(`SELECT fleet_admin_paypal_debit_classify($1, $2, $3, $4) AS r`, [refId, as, note, actor]);
  }
  cardClearing() { return this.one(`SELECT fleet_card_clearing() AS r`); }
  treasuryTransactions(agentId: string | null, limit: number, beforeSeq: number | null, direction: string | null) {
    return this.one(`SELECT fleet_treasury_transactions($1, $2, $3, $4) AS r`, [agentId, limit, beforeSeq, direction]);
  }
  treasuryHealth() { return this.one(`SELECT fleet_treasury_health() AS r`); }
  paypalStatus() { return this.one(`SELECT fleet_paypal_status() AS r`); }
  paypalAttribute(railId: string, txnId: string, eventCode: string, as: string, reference: string | null, actor: string) {
    return this.one(`SELECT fleet_admin_paypal_txn_attribute($1, $2, $3, $4, $5, $6) AS r`, [railId, txnId, eventCode, as, reference, actor]);
  }

  // ── v49: standing identity authority, freezes, footprint, custody key, webhook ids ──
  identityAutonomy() { return this.one(`SELECT fleet_identity_autonomy_json() AS r`); }
  identityAutonomySet(enabled: boolean, classes: string[], cardEnabled: boolean, cardMax: number | null, cardDaily: number | null, excluded: string[], statement: string | null, actor: string) {
    return this.one(`SELECT fleet_admin_identity_autonomy_set($1, $2, $3, $4, $5, $6, $7, $8) AS r`, [enabled, classes, cardEnabled, cardMax, cardDaily, excluded, statement, actor]);
  }
  accountFreeze(accountId: string, reason: string | null, actor: string) { return this.one(`SELECT fleet_admin_account_freeze($1, $2, $3) AS r`, [accountId, reason, actor]); }
  accountUnfreeze(accountId: string, status: string, actor: string) { return this.one(`SELECT fleet_admin_account_unfreeze($1, $2, $3) AS r`, [accountId, status, actor]); }
  footprint(agentId: string, limit: number) { return this.one(`SELECT fleet_agent_footprint($1, $2) AS r`, [agentId, limit]); }
  identityUses(agentId: string | null, limit: number) { return this.one(`SELECT fleet_identity_uses_json($1, $2) AS r`, [agentId, limit]); }
  custodyKey() { return this.one(`SELECT fleet_custody_key_json() AS r`); }
  custodyCredentialUpload(vaultRef: string, sealed: Buffer, actor: string) { return this.one(`SELECT fleet_admin_custody_credential_upload($1, $2, $3) AS r`, [vaultRef, sealed, actor]); }
  custodyCredentialRevoke(vaultRef: string, actor: string) { return this.one(`SELECT fleet_admin_custody_credential_revoke($1, $2) AS r`, [vaultRef, actor]); }
  railWebhook(railId: string, webhookId: string, actor: string) { return this.one(`SELECT fleet_admin_rail_webhook_set($1, $2, $3) AS r`, [railId, webhookId, actor]); }
  // ── v50/v51: wallet exhaustion (death), sweep reductions, the knowledge library ──
  insolvency() { return this.one(`SELECT fleet_insolvency_json() AS r`); }
  walletMeasure(agentId: string | null) {
    return agentId ? this.one(`SELECT fleet_agent_wallet_measure($1) AS r`, [agentId]) : this.one(`SELECT fleet_wallet_measures() AS r`);
  }
  moneyStates() { return this.one(`SELECT fleet_money_states() AS r`); }
  // ── v51: documents under the standing authority; mail / SMS provider secrets sealed to the broker ──
  identityDocuments(classes: string[], actor: string) { return this.one(`SELECT fleet_admin_identity_documents_set($1, $2) AS r`, [classes, actor]); }
  providerSecretUpload(name: string, sealed: Buffer, actor: string) { return this.one(`SELECT fleet_admin_provider_secret_upload($1, $2, $3) AS r`, [name, sealed, actor]); }
  providerSecrets() { return this.one(`SELECT fleet_provider_secrets_json() AS r`); }
  // ── v52: the Gumroad storefront gateway and receipt evidence ──
  // ── v53: the weekly card statement; the owner's PayPal receiving test ──
  cardStatementIssue(actor: string) { return this.one(`SELECT fleet_admin_card_statement_issue($1) AS r`, [actor]); }
  cardStatementPaid(statementId: string, reference: string, actor: string) {
    return this.one(`SELECT fleet_admin_card_statement_paid($1, $2, $3) AS r`, [statementId, reference, actor]);
  }
  cardStatementPolicy(enabled: boolean | null, weekday: number | null, hour: number | null, timeZone: string | null, actor: string) {
    return this.one(`SELECT fleet_admin_card_statement_policy_set($1, $2, $3, $4, $5) AS r`, [enabled, weekday, hour, timeZone, actor]);
  }
  paypalTestCheckout(amountMinor: number, actor: string) { return this.one(`SELECT fleet_admin_paypal_test_checkout($1, $2) AS r`, [amountMinor, actor]); }
  // ── v55: the owner's survival protection switch ──
  survivalProtection() { return this.one(`SELECT fleet_survival_protection_json() AS r`); }
  survivalProtectionSet(enabled: boolean, reason: string | null, actor: string) {
    return this.one(`SELECT fleet_admin_survival_protection_set($1, $2, $3) AS r`, [enabled, reason, actor]);
  }
  survivalProtectionAgent(agentId: string, mode: string, reason: string | null, actor: string) {
    return this.one(`SELECT fleet_admin_survival_protection_agent_set($1, $2, $3, $4) AS r`, [agentId, mode, reason, actor]);
  }
  // ── v54: card requests (PayPal first; the owner decides above the threshold) ──
  cardRequests(agentId: string | null) { return this.one(`SELECT fleet_card_requests_json($1) AS r`, [agentId]); }
  cardRequestDecide(requestId: string, decision: string, reference: string | null, note: string | null, actor: string) {
    return this.one(`SELECT fleet_admin_card_request_decide($1, $2, $3, $4, $5) AS r`, [requestId, decision, reference, note, actor]);
  }
  cardRequestPolicy(thresholdMinor: number | null, validHours: number | null, actor: string) {
    return this.one(`SELECT fleet_admin_card_request_policy_set($1, $2, $3) AS r`, [thresholdMinor, validHours, actor]);
  }
  paypalTest() { return this.one(`SELECT fleet_paypal_test_json() AS r`); }
  storefront(agentId: string | null) { return this.one(`SELECT fleet_storefront_json($1) AS r`, [agentId]); }
  storefrontProbe(accountId: string, actor: string) { return this.one(`SELECT fleet_admin_storefront_probe($1, $2) AS r`, [accountId, actor]); }
  destinationPaypal(destinationId: string, railId: string, actor: string) {
    return this.one(`SELECT fleet_admin_settlement_destination_paypal($1, $2, $3) AS r`, [destinationId, railId, actor]);
  }
  sweepReductions(agentId: string | null) { return this.one(`SELECT fleet_sweep_rate_reductions_json($1) AS r`, [agentId]); }
  sweepReductionGrant(agentId: string, bp: number, days: number, reason: string, requestId: string | null, actor: string) {
    return this.one(`SELECT fleet_admin_sweep_reduction_grant($1, $2, $3, $4, $5, $6) AS r`, [agentId, bp, days, reason, requestId, actor]);
  }
  sweepReductionEnd(reductionId: string, reason: string | null, actor: string) { return this.one(`SELECT fleet_admin_sweep_reduction_end($1, $2, $3) AS r`, [reductionId, reason, actor]); }
  sweepReductionDecline(requestId: string, reason: string | null, actor: string) { return this.one(`SELECT fleet_admin_sweep_reduction_decline($1, $2, $3) AS r`, [requestId, reason, actor]); }
  knowledgeLibraryLoad(library: unknown, actor: string) { return this.one(`SELECT fleet_admin_knowledge_library_load($1::jsonb, $2) AS r`, [JSON.stringify(library), actor]); }
  knowledgeLibrarySearch(query: string | null, category: string | null, limit: number) {
    return this.one(`SELECT fleet_knowledge_library_search($1, $2, $3, true) AS r`, [query, category, limit]);
  }

  /** v46: assign an evidenced capability of a rail to a venture. */
  railAssign(railId: string, ventureId: string, capability: string, actor: string) {
    return this.one(`SELECT fleet_admin_rail_assign($1, $2, $3, $4) AS r`, [railId, ventureId, capability, actor]);
  }
  railReadiness(railId: string) {
    return this.one(`SELECT fleet_rail_readiness($1) || jsonb_build_object('disclosure', fleet_rail_readiness_text($1)) AS r`, [railId]);
  }
  // ── v47: provider records and cash-basis settlement (owner side) ──
  providerAccountRegister(railId: string, providerUserId: string, label: string, extraCounterpartySha256: string[], actor: string) {
    return this.one(`SELECT fleet_admin_provider_account_register($1, $2, $3, $4, $5) AS r`, [railId, providerUserId, label, extraCounterpartySha256, actor]);
  }
  providerProductAssign(accountId: string, productId: string, ventureId: string, effectiveFrom: string | null, reason: string, actor: string) {
    return this.one(`SELECT fleet_admin_provider_product_assign($1, $2, $3, $4, $5, $6) AS r`, [accountId, productId, ventureId, effectiveFrom, reason, actor]);
  }
  destinationAdd(d: { kind: string; label: string; maskedRef: string; payoutVisual: string | null; currency: string; descriptorPattern: string | null;
    entityId: string | null; bankfeedCredentialId: string | null }, actor: string) {
    return this.one(`SELECT fleet_admin_settlement_destination_add($1, $2, $3, $4, $5, $6, $7, $8, $9) AS r`,
      [d.kind, d.label, d.maskedRef, d.payoutVisual, d.currency, d.descriptorPattern, d.entityId, d.bankfeedCredentialId, actor]);
  }
  destinationVerifyAccess(destinationId: string, evidenceKind: string, note: string, actor: string) {
    return this.one(`SELECT fleet_admin_settlement_destination_verify_access($1, $2, $3::jsonb, $4) AS r`, [destinationId, evidenceKind, JSON.stringify({ note }), actor]);
  }
  pilotAuthorise(days: number, reason: string, actor: string) {
    return this.one(`SELECT fleet_admin_pilot_authorise('receipt_attestation', $1, $2, $3) AS r`, [days, reason, actor]);
  }
  pilotRevoke(pilotId: string, actor: string) {
    return this.one(`SELECT fleet_admin_pilot_revoke($1, $2) AS r`, [pilotId, actor]);
  }
  receiptAttest(destinationId: string, accountId: string, payoutId: string, amountMinor: number, currency: string, bookedOn: string, actor: string) {
    return this.one(`SELECT fleet_admin_receipt_attest($1, $2, $3, $4, $5, $6::date, $7) AS r`, [destinationId, accountId, payoutId, amountMinor, currency, bookedOn, actor]);
  }
  receiptTransferLink(externalReceiptId: string, treasuryReceiptId: string, actor: string) {
    return this.one(`SELECT fleet_admin_receipt_transfer_link($1, $2, $3) AS r`, [externalReceiptId, treasuryReceiptId, actor]);
  }
  suspenseRelease(receiptId: string, actor: string) {
    return this.one(`SELECT fleet_admin_provider_suspense_release($1, $2) AS r`, [receiptId, actor]);
  }
  debitAssign(receiptId: string, agentId: string, amountMinor: number, reason: string, actor: string) {
    return this.one(`SELECT fleet_admin_receipt_debit_assign($1, $2, $3, $4, $5) AS r`, [receiptId, agentId, amountMinor, reason, actor]);
  }

  /** v46: answer a pending request from a verified capability assigned to the request's agent (the text is generated). */
  dependencyAnswerFromCapability(requestId: string, railId: string, capability: string, actor: string) {
    return this.one(`SELECT fleet_admin_dependency_answer_from_capability($1, $2, $3, $4) AS r`, [requestId, railId, capability, actor]);
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
  /** v43 host recovery: remove the Admin authenticator (then issue an enrollment link to register a new one). */
  dashboardTotpReset(actor: string) {
    return this.one(`SELECT fleet_admin_dashboard_totp_reset($1) AS r`, [actor]);
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
  /**
   * One INTERNAL Treasury allocation pass for a period (YYYY-MM or YYYY-MM-DD): for each active agent, the policy's share
   * of its realised, uncontributed net profit after tax is recorded as a Lifetime Fleet Contribution (agent cash →
   * Treasury on the ledger). No payment order, rail or custody executor is involved, and no host flag is read: only the
   * DB sweep policy (`fleet_sweep_policy.enabled`) gates it. Idempotent per period and agent (a retry never sweeps twice).
   * The cadence is the owner's decision: nothing runs this automatically.
   */
  sweepRun(period: string) {
    return this.one(`SELECT svc_sweep_run($1) AS r`, [period]);
  }
}

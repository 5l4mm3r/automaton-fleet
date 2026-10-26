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
/** v82 host recovery: what a host recovery command keeps on purpose (by default it ends sessions and retires recovery codes). */
export interface HostRecoveryKeep { sessions: boolean; recoveryCodes: boolean }

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
  custodyActivate(maxInstructionMinor: number | null, maxDailyMinor: number | null, hours: number | null, reason: string, actor: string) {
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
  /** v57/v58: a return's swept share goes where the owner says each time (treasury, or owner = an owner withdrawal). */
  cardSettle(receiptId: string, resolution: string, method: string, sweepMinor: number | null, reference: string | null, actor: string, sweepTo: "treasury" | "owner" | null = null) {
    return this.one(`SELECT fleet_admin_card_receipt_settle($1, $2, $3, $4, $5, $6, $7) AS r`, [receiptId, resolution, method, sweepMinor, reference, actor, sweepTo]);
  }
  /** v96: a refund authority custody enforces at dispatch — standing (orderId null; hours null = ongoing) or one order only. */
  refundAuthorityGrant(scope: string, orderId: string | null, maxRefundMinor: number, maxDailyMinor: number, maxTotalMinor: number | null, hours: number | null,
    reason: string, actor: string) {
    return this.one(`SELECT fleet_admin_refund_authority_grant($1, $2, $3, $4, $5, $6, $7, $8) AS r`, [scope, orderId, maxRefundMinor, maxDailyMinor, maxTotalMinor, hours, reason, actor]);
  }
  refundAuthorityEnd(authorityId: string, reason: string | null, actor: string) {
    return this.one(`SELECT fleet_admin_refund_authority_end($1, $2, $3) AS r`, [authorityId, reason, actor]);
  }
  /** v106: the owner's own claim (AI credit owed to the owner) waits behind the refund of the owner's own proof order. */
  ownerClaimWait(orderId: string, reason: string, actor: string) {
    return this.one(`SELECT fleet_admin_owner_claim_wait($1, $2, $3) AS r`, [orderId, reason, actor]);
  }
  ownerClaimWaitEnd(orderId: string, reason: string | null, actor: string) {
    return this.one(`SELECT fleet_admin_owner_claim_wait_end($1, $2, $3) AS r`, [orderId, reason, actor]);
  }
  /** v114: the owner records a buyer's genuine withdrawal of a requested correction (the buyer's own message on that order). */
  orderCorrectionWithdrawn(orderId: string, buyerMessageId: string, reason: string, actor: string) {
    return this.one(`SELECT fleet_admin_order_correction_withdrawn($1, $2, $3, $4) AS r`, [orderId, buyerMessageId, reason, actor]);
  }
  /** v108: the countries the treasury checkout does not sell to (the owner's supported geography). */
  salesGeography(unsupported: string[], reason: string, actor: string) {
    return this.one(`SELECT fleet_admin_sales_geography($1::text[], $2, $3) AS r`, [unsupported, reason, actor]);
  }
  refundAuthorities() {
    return this.one(`SELECT fleet_refund_authorities_json(false) AS r`);
  }
  /** v98: PayPal evidence that needs the owner (late approvals / payments on retired orders, duplicates, unverifiable not-found),
   *  the reconciliation channels' status (Transaction Search, the order audit, the token's scopes) and open checkouts' PayPal orders. */
  paypalReconciliation(actor: string) {
    return this.one(`SELECT fleet_admin_paypal_reconciliation($1) AS r`, [actor]);
  }
  paypalReconciliationResolve(itemId: string, resolution: string, actor: string) {
    return this.one(`SELECT fleet_admin_paypal_reconciliation_resolve($1, $2, $3) AS r`, [itemId, resolution, actor]);
  }
  /** v98: retire a PayPal order the Fleet could not verify as gone (never one with any sign of approval or payment). */
  paypalOrderRetire(paypalOrderId: string, reason: string, actor: string) {
    return this.one(`SELECT fleet_admin_paypal_order_retire($1, $2, $3) AS r`, [paypalOrderId, reason, actor]);
  }
  /** v96: Fleet Control's daily AI budget (checked before each of its review calls is claimed) and its state. */
  fleetControlAiBudget(dailyMinor: number, reason: string, actor: string) {
    return this.one(`SELECT fleet_admin_fleet_control_ai_budget($1, $2, $3) AS r`, [dailyMinor, reason, actor]);
  }
  // v117: the actual cost of a Fleet Control call whose cost the provider did not report (from the console); settles it once.
  fleetControlAiReconcile(reservationId: string, usdMicrocents: number, ref: string, actor: string) {
    return this.one(`SELECT fleet_admin_fleet_control_ai_reconcile($1, $2, $3, $4) AS r`, [reservationId, usdMicrocents, ref, actor]);
  }
  /** v110: clear it again (unset = no paid Fleet Control call). */
  fleetControlAiBudgetClear(reason: string, actor: string) {
    return this.one(`SELECT fleet_admin_fleet_control_ai_budget_clear($1, $2) AS r`, [reason, actor]);
  }
  /** v111: model-call reservations with no result past their time, and cost exceptions (overrun / uncollectable). */
  cognitionSettlement() {
    return this.one(`SELECT fleet_admin_cognition_settlement_state() AS r`);
  }
  /** v111: resolve a reservation whose result never came, from provider evidence: billed (at its reservation) or not_billed. */
  cognitionReservationResolve(requestId: string, outcome: string, reason: string, actor: string) {
    return this.one(`SELECT fleet_admin_cognition_reservation_resolve($1, $2, $3, $4) AS r`, [requestId, outcome, reason, actor]);
  }
  /** v111: allocate a cost exception to the agent or to the treasury (the owner's decision). */
  cognitionExceptionAllocate(exceptionId: string, to: string, reason: string, actor: string) {
    return this.one(`SELECT fleet_admin_cognition_exception_allocate($1, $2, $3, $4) AS r`, [exceptionId, to, reason, actor]);
  }
  /** v111: import a scenario harness run's per-call evidence (eval/cost-meter.ts rows) as engineering consumption. */
  engineeringCallsImport(runId: string, provider: string, rows: unknown[], actor: string) {
    return this.one(`SELECT fleet_admin_engineering_calls_import($1, $2, $3::jsonb, $4) AS r`, [runId, provider, JSON.stringify(rows), actor]);
  }
  /** v111: set aside provider credit for an engineering run before it starts; release it after its calls are imported. */
  engineeringCreditHold(runId: string, provider: string, usdMicro: bigint, reason: string, actor: string) {
    return this.one(`SELECT fleet_admin_engineering_credit_hold($1, $2, $3, $4, $5) AS r`, [runId, provider, usdMicro.toString(), reason, actor]);
  }
  engineeringCreditRelease(runId: string, reason: string, actor: string) {
    return this.one(`SELECT fleet_admin_engineering_credit_release($1, $2, $3) AS r`, [runId, reason, actor]);
  }
  fleetControlAi() {
    return this.one(`SELECT fleet_control_ai_state() AS r`);
  }
  /** v96: hold one offer (not sold publicly; accepted work continues) / release it. The agent is told. */
  offerHold(slug: string, reason: string, actor: string) {
    return this.one(`SELECT fleet_admin_offer_hold($1, $2, $3) AS r`, [slug, reason, actor]);
  }
  offerRelease(slug: string, reason: string | null, actor: string) {
    return this.one(`SELECT fleet_admin_offer_release($1, $2, $3) AS r`, [slug, reason, actor]);
  }
  /** v59: refund a sale's buyer (all that is still refundable when amountMinor is null). */
  orderRefund(orderId: string, amountMinor: number | null, reason: string, actor: string) {
    return this.one(`SELECT fleet_admin_order_refund($1, $2, $3, $4) AS r`, [orderId, amountMinor, reason, actor]);
  }
  /** v58: card credit (pre-funded, unused) moved back to the treasury PayPal account. */
  cardCreditReturn(amountMinor: number, reference: string, actor: string) {
    return this.one(`SELECT fleet_admin_card_credit_return($1, $2, $3) AS r`, [amountMinor, reference, actor]);
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
  // v66: a real PayPal deposit backs the existing (virtual) capital instead of crediting it twice; and the reconciliation.
  capitalBacking() { return this.one(`SELECT fleet_capital_backing() AS r`); }
  // v69: bring in the AI costs charged before v69 as owed to the owner (once; owner action after the cutover).
  // v70: AI credit by funding source; a treasury-funded purchase evidenced by the treasury PayPal debit.
  aiCredits() { return this.one(`SELECT fleet_ai_credit_status() AS r`); }
  // v71: the owner's funding route / detection settings; confirming or rejecting an observed purchase.
  aiCreditPolicySet(provider: string, route: string, receiptSender: string | null, counterparty: string | null, thresholdUsdCents: number | null, reloadToUsdCents: number | null, enabled: boolean, actor: string) {
    return this.one(`SELECT fleet_admin_ai_credit_policy_set($1, $2, $3, $4, $5, $6, $7, $8) AS r`, [provider, route, receiptSender, counterparty, thresholdUsdCents, reloadToUsdCents, enabled, actor]);
  }
  aiCreditConfirm(receiptId: string, source: string, railId: string | null, txnId: string | null, eventCode: string | null, actor: string) {
    return this.one(`SELECT fleet_admin_ai_credit_confirm($1, $2, $3, $4, $5, $6) AS r`, [receiptId, source, railId, txnId, eventCode, actor]);
  }
  // v72: reconcile with the console balance; a lot's acquisition cost (tax / fees) from evidence.
  aiCreditReconcile(provider: string, consoleUsdCents: number, actor: string) {
    return this.one(`SELECT fleet_admin_ai_credit_balance_reconcile($1, $2, $3) AS r`, [provider, consoleUsdCents, actor]);
  }
  aiCreditLotCost(lotId: string, creditUsdCents: number, totalUsdCents: number, evidence: string, actor: string) {
    return this.one(`SELECT fleet_admin_ai_credit_lot_cost($1, $2, $3, $4, $5) AS r`, [lotId, creditUsdCents, totalUsdCents, evidence, actor]);
  }
  // v116: a promotional grant from the console (once); which credit the provider draws first.
  aiCreditPromotionalGrant(provider: string, grantRef: string, grantUsdCents: number, remainingUsdCents: number, grantedAt: string, expiresAt: string,
    expiryBasis: string, displayed: string, evidence: string, actor: string) {
    return this.one(`SELECT fleet_admin_ai_credit_promotional_grant($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8, $9, $10) AS r`,
      [provider, grantRef, grantUsdCents, remainingUsdCents, grantedAt, expiresAt, expiryBasis, displayed, evidence, actor]);
  }
  aiCreditDrawOrder(provider: string, order: string, evidence: string, actor: string) {
    return this.one(`SELECT fleet_admin_ai_credit_draw_order($1, $2, $3, $4) AS r`, [provider, order, evidence, actor]);
  }
  aiCreditReject(receiptId: string, reason: string, actor: string) {
    return this.one(`SELECT fleet_admin_ai_credit_reject($1, $2, $3) AS r`, [receiptId, reason, actor]);
  }
  aiCreditTreasuryPurchase(provider: string, usdCents: number, railId: string, txnId: string, eventCode: string, receipt: string, actor: string) {
    return this.one(`SELECT fleet_admin_ai_credit_treasury_purchase($1, $2, $3, $4, $5, $6, $7) AS r`, [provider, usdCents, railId, txnId, eventCode, receipt, actor]);
  }
  // v73: the one-time historical acquisition-cost correction (preview is read-only).
  aiCreditHistoricalPreview(provider: string, creditUsdCents: number, totalUsdCents: number) {
    return this.one(`SELECT fleet_ai_credit_historical_preview($1, $2, $3) AS r`, [provider, creditUsdCents, totalUsdCents]);
  }
  aiCreditHistoricalCost(provider: string, creditUsdCents: number, totalUsdCents: number, evidence: string, actor: string) {
    return this.one(`SELECT fleet_admin_ai_credit_historical_cost($1, $2, $3, $4, $5) AS r`, [provider, creditUsdCents, totalUsdCents, evidence, actor]);
  }
  // v74: pre-launch test costs written off once (preview is read-only).
  aiCreditTestPeriodPreview() { return this.one(`SELECT fleet_ai_credit_test_period_preview() AS r`); }
  aiCreditTestPeriodWriteoff(actor: string) { return this.one(`SELECT fleet_admin_ai_credit_test_period_writeoff($1) AS r`, [actor]); }
  launchBoundaryRecord(note: string, actor: string) { return this.one(`SELECT fleet_admin_launch_boundary_record($1, $2) AS r`, [note, actor]); }
  launchBoundary() { return this.one(`SELECT to_jsonb(b) - 'id' AS r FROM fleet_launch_boundary b WHERE id = 1`); }
  // v76: the public site for offer and order pages (owner), and the owner's read of offers and enquiries.
  publicSiteSet(url: string, notice: string | null, actor: string) { return this.one(`SELECT fleet_admin_public_site_set($1, $2, $3) AS r`, [url, notice, actor]); }
  /** v76: the owner's live proof purchase of an agent's published product (owner capital at capture, never agent revenue). */
  /** v76: the owner reimbursed themselves from the treasury PayPal for AI credit their card paid (records the v69 payable as settled). */
  ownerPayableReimbursed(amountMinor: number, reference: string, actor: string) {
    return this.one(`SELECT fleet_admin_owner_payable_reimbursed($1, $2, $3) AS r`, [amountMinor, reference, actor]);
  }
  /** v77: is an owner withdrawal of this kind and amount free cash now (before moving it in PayPal)? */
  ownerWithdrawalAssess(kind: string, amountMinor: number) { return this.one(`SELECT fleet_admin_owner_withdrawal_assess($1, $2) AS r`, [kind, amountMinor]); }
  /** v77: record an owner withdrawal made in PayPal (profit distribution or capital return), once per PayPal transaction id. */
  ownerWithdrawalRecord(kind: string, amountMinor: number, txn: string, note: string | null, actor: string) {
    return this.one(`SELECT fleet_admin_owner_withdrawal_record($1, $2, $3, $4, $5) AS r`, [kind, amountMinor, txn, note, actor]);
  }
  /** v76: open or close sales to the public (closed: offer pages not public, no buys or briefs; order pages and the proof purchase work). */
  salesSet(open: boolean, actor: string) { return this.one(`SELECT fleet_admin_sales_set($1, $2) AS r`, [open, actor]); }
  sellerSet(fields: Record<string, unknown>, actor: string) { return this.one(`SELECT fleet_admin_seller_set($1::jsonb, $2) AS r`, [JSON.stringify(fields), actor]); }
  seller() { return this.one(`SELECT fleet_admin_seller() AS r`, []); }
  offerProofBuy(slug: string, actor: string) { return this.one(`SELECT fleet_admin_offer_proof_buy($1, $2) AS r`, [slug, actor]); }
  offers(agentId: string | null) { return this.one(`SELECT fleet_offers_admin_json($1) AS r`, [agentId]); }
  /** v79: release one agent from the preparation hold for a controlled proof (nothing becomes public), or hold it again. */
  /** v80: a scoped, expiring release for a controlled proof — permits EXTERNAL actions within its scope (public at once). */
  outwardRelease(agentId: string, scope: Record<string, unknown>, note: string, actor: string) {
    return this.one(`SELECT fleet_admin_outward_release($1, $2::jsonb, $3, $4) AS r`, [agentId, JSON.stringify(scope), note, actor]);
  }
  outwardHold(agentId: string, actor: string) { return this.one(`SELECT fleet_admin_outward_hold($1, $2) AS r`, [agentId, actor]); }
  outwardList() { return this.one(`SELECT fleet_admin_outward_list() AS r`, []); }
  /** v80: connect one of an agent's channels to the API account the owner authorised (token in the channel gateway's vault). */
  channelConnect(channelId: string, provider: string, vaultRef: string, expectedAccount: string, shopId: string | null, actor: string) {
    return this.one(`SELECT fleet_admin_channel_connect($1::uuid, $2, $3, $4, $5, $6) AS r`, [channelId, provider, vaultRef, expectedAccount, shopId, actor]);
  }
  channelDisconnect(channelId: string, actor: string) { return this.one(`SELECT fleet_admin_channel_disconnect($1::uuid, $2) AS r`, [channelId, actor]); }
  channelApi() { return this.one(`SELECT fleet_channel_api_admin_json() AS r`, []); }
  /** v79: each agent's business beyond the offer pages (channels, live presence, leads, obligations, outreach, payouts awaiting the owner). */
  business(agentId: string | null) { return this.one(`SELECT fleet_business_admin_json($1) AS r`, [agentId]); }
  /** v79: the bank statement line that received a marketplace payout (owner_bank route). */
  channelPayoutBank(payoutId: string, bankRef: string, receivedOn: string, amountMinor: number, actor: string) {
    return this.one(`SELECT fleet_admin_channel_payout_bank($1::uuid, $2, $3::date, $4, $5) AS r`, [payoutId, bankRef, receivedOn, amountMinor, actor]);
  }
  /** v79: the treasury transfer (one PayPal credit from your bank) carrying exactly these bank payouts. */
  channelPayoutTransfer(paypalTxn: string, payoutIds: string[], actor: string) {
    return this.one(`SELECT fleet_admin_channel_payout_transfer($1, $2::uuid[], $3) AS r`, [paypalTxn, payoutIds, actor]);
  }
  /** v79: book a channel payout against a named treasury PayPal credit, or reject the claim. */
  channelPayoutDecide(payoutId: string, decision: "book" | "reject", paypalTxn: string | null, note: string | null, actor: string) {
    return this.one(`SELECT fleet_admin_channel_payout_decide($1::uuid, $2, $3, $4, $5) AS r`, [payoutId, decision, paypalTxn, note, actor]);
  }
  enquiries(agentId: string | null) { return this.one(`SELECT fleet_enquiries_admin_json($1) AS r`, [agentId]); }
  aiCreditOpening(actor: string) { return this.one(`SELECT fleet_admin_ai_credit_opening($1) AS r`, [actor]); }
  /** 2026-10-20: trip or reset the infrastructure spend circuit breaker; the owner's anomaly thresholds are kept as they are. */
  spendBreaker(tripped: boolean, reason: string | null, actor: string) {
    return this.one(`SELECT fleet_admin_spend_circuit_breaker($1, $2, $3, b.order_wallet_bp, b.velocity_window_s, b.velocity_wallet_bp) AS r
      FROM fleet_spend_circuit_breaker b WHERE b.id = 1`, [actor, tripped, reason]);
  }
  capitalBack(railId: string, txnId: string, eventCode: string, actor: string) {
    return this.one(`SELECT fleet_admin_capital_back($1, $2, $3, $4) AS r`, [railId, txnId, eventCode, actor]);
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
  // ── v86: money locations (PayPal and bank accounts; transfers between them are the same money) ──
  locations() { return this.one(`SELECT fleet_locations_json() AS r`); }
  locationAdd(provider: string, label: string, actor: string) {
    return this.one(`SELECT fleet_admin_location_add('bank', $1, $2, NULL, $3) AS r`, [provider, label, actor]);
  }
  locationStatus(locationId: string, status: string, note: string | null, actor: string) {
    return this.one(`SELECT fleet_admin_location_status($1, $2, $3, $4) AS r`, [locationId, status, note, actor]);
  }
  locationBindCard(locationId: string | null, actor: string) { return this.one(`SELECT fleet_admin_location_bind_card($1, $2) AS r`, [locationId, actor]); }
  locationTransfer(from: string, to: string, amountMinor: number, reference: string, actor: string) {
    return this.one(`SELECT fleet_admin_location_transfer($1, $2, $3, $4, $5) AS r`, [from, to, amountMinor, reference, actor]);
  }
  locationContribution(txnId: string, actor: string) { return this.one(`SELECT fleet_admin_location_contribution($1, $2) AS r`, [txnId, actor]); }
  bankTxnClassify(txnId: string, as: string, note: string | null, actor: string) {
    return this.one(`SELECT fleet_admin_bank_txn_classify($1, $2, $3, $4) AS r`, [txnId, as, note, actor]);
  }
  transferArrival(txnId: string, transferId: string, actor: string) { return this.one(`SELECT fleet_admin_transfer_arrival($1, $2, $3) AS r`, [txnId, transferId, actor]); }
  cardHoldRelease(chargeId: string, evidence: string, actor: string) { return this.one(`SELECT fleet_admin_card_hold_release($1, $2, $3) AS r`, [chargeId, evidence, actor]); }
  cardDisputeOpen(chargeId: string, amountMinor: number, reason: string, actor: string) {
    return this.one(`SELECT fleet_admin_card_dispute_open($1, $2, $3, $4) AS r`, [chargeId, amountMinor, reason, actor]);
  }
  cardDisputeResolve(disputeId: string, outcome: string, txnId: string | null, note: string | null, actor: string) {
    return this.one(`SELECT fleet_admin_card_dispute_resolve($1, $2, $3, $4, $5) AS r`, [disputeId, outcome, txnId, note, actor]);
  }
  treasuryReconciliation() { return this.one(`SELECT fleet_treasury_reconciliation() AS r`); }
  cardSlotSet(slot: string, label: string, mode: string, locationId: string | null, priority: number, status: string, fallback: boolean, actor: string) {
    return this.one(`SELECT fleet_admin_card_slot_set($1, $2, $3, $4, $5, $6, $7, $8) AS r`, [slot, label, mode, locationId, priority, status, fallback, actor]);
  }
  cardDisputeReversal(txnId: string, disputeId: string, actor: string) { return this.one(`SELECT fleet_admin_card_dispute_reversal($1, $2, $3) AS r`, [txnId, disputeId, actor]); }
  unitEconomics(agentId: string | null, days: number) { return this.one(`SELECT fleet_unit_economics($1, $2) AS r`, [agentId, days]); }
  codeAccess() { return this.one(`SELECT fleet_code_json() AS r`); }
  repoAccessRevoke(id: string, reason: string, actor: string) { return this.one(`SELECT fleet_admin_repo_access_revoke($1, $2, $3) AS r`, [id, reason, actor]); }
  /** A statement export's lines (and optionally the balance the bank's app shows now), recorded in one transaction. */
  locationImport(locationId: string, lines: unknown[], balance: { availableMinor: number; clearedMinor: number | null } | null, actor: string) {
    return this.one(`SELECT fleet_admin_location_import($1, $2::jsonb, $3::jsonb, $4) AS r`, [locationId, JSON.stringify(lines), balance ? JSON.stringify(balance) : null, actor]);
  }
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
  /** v38: a one-time dashboard enrollment token (first passkey + TOTP, or recovery); the database keeps its digest only.
   *  v82: it ends every session and retires every unused recovery code unless `keep` says otherwise. */
  dashboardEnroll(tokenSha: string, actor: string, keep: HostRecoveryKeep = { sessions: false, recoveryCodes: false }) {
    return this.one(`SELECT fleet_admin_dashboard_enroll($1, $2, $3, $4) AS r`, [tokenSha, actor, keep.sessions, keep.recoveryCodes]);
  }
  /** v43 host recovery: remove the Admin authenticator (then issue an enrollment link to register a new one). v82: as above. */
  dashboardTotpReset(actor: string, keep: HostRecoveryKeep = { sessions: false, recoveryCodes: false }) {
    return this.one(`SELECT fleet_admin_dashboard_totp_reset($1, $2, $3) AS r`, [actor, keep.sessions, keep.recoveryCodes]);
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

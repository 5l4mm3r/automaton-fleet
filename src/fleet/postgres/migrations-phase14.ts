/**
 * Schema v14 (Phase F.3): the owner records a purchase of prepaid inference
 * (Conway) credits made outside the fleet, so founder cognition can be funded
 * while custody execution stays disabled.
 *
 * fleet_admin_record_credits_purchase(amount, externalRef, actor, idem):
 *   - owner only (never granted; `operator:<name>` actor; AI principals refused);
 *   - external reference required (the provider's invoice or receipt id);
 *   - treasury_cash C / conway_credits D, from the treasury's UNALLOCATED cash
 *     only: founder allocations and protected capital are never touched;
 *   - idempotent (the same key returns the same journal) and recorded as a
 *     FleetAdmin instruction for audit.
 * Consumption stays on the per-founder inference path (inference_charge, v13).
 */

export const V14_SQL = `
ALTER TABLE fleet_admin_instructions DROP CONSTRAINT fleet_admin_instructions_kind_check;
ALTER TABLE fleet_admin_instructions ADD CONSTRAINT fleet_admin_instructions_kind_check
  CHECK (kind IN ('spend_decision','owner_withdrawal','capital_grant','principal_advance','profit_contribution','owner_funding_record',
                  'credits_purchase_record'));

CREATE FUNCTION fleet_admin_record_credits_purchase(p_amount bigint, p_external_ref text, p_actor text, p_idem text) RETURNS uuid LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_j uuid; v_prior uuid;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_credits');
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: amount must be positive'; END IF;
  IF p_external_ref IS NULL OR length(trim(p_external_ref)) < 4 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the provider invoice/receipt reference is required'; END IF;
  SELECT journal_id INTO v_prior FROM fleet_ledger_journal WHERE idempotency_key = p_idem AND kind = 'conway_credits_purchase';
  IF v_prior IS NOT NULL THEN RETURN v_prior; END IF;
  PERFORM 1 FROM fleet_ledger_accounts WHERE account_id = 'fleet:treasury:unallocated' FOR UPDATE;
  IF fleet_ledger_balance('fleet:treasury:unallocated') < p_amount THEN
    RAISE EXCEPTION 'FLEET_INSUFFICIENT_TREASURY: unallocated treasury cash is below the purchase amount';
  END IF;
  v_j := fleet_ledger_post('conway_credits_purchase', p_idem, p_actor, 'prepaid inference credits bought by the owner', 'owner', NULL, NULL, NULL,
    p_external_ref, NULL, now(),
    jsonb_build_array(jsonb_build_object('account', 'fleet:conway_credits', 'side', 'D', 'amount', p_amount),
                      jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', p_amount)));
  PERFORM fleet_admin_record('credits_purchase_record', jsonb_build_object('amountCents', p_amount, 'journalId', v_j), '{}'::jsonb, NULL, true,
    'standard', NULL, NULL, 'executed', NULL, jsonb_build_object('journalId', v_j), p_actor);
  RETURN v_j;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

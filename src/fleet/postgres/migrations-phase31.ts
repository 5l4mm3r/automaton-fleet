/**
 * Schema v31 — launch hardening of the F2 economy (integration branch; v26–v30 are the frozen, tested candidate).
 *
 * 1. MANUAL ADMIN WITHDRAWALS / PAYMENTS: no nominal software amount limit, FleetController's risk advice instead.
 *    - `fleet_admin_withdrawal_assessment(amount)`: unrestricted withdrawable liquidity (the Treasury's unallocated pool),
 *      restricted money shown and excluded (agent cash, tax reserves, envelope capital, in-flight withdrawals, Treasury
 *      partitions), PROTECTED OPERATING REQUIREMENTS (committed Fleet-capital tranches of active envelopes, approved
 *      Treasury obligations, projected Fleet infrastructure/provider costs over the horizon, the continuity shortfall of
 *      active agent businesses that cannot fund the horizon themselves), a TREASURY CUSHION (`cushion_bp` of the
 *      unrestricted liquidity, default 1 000 = 10 %, the owner's current admin-risk policy), the RECOMMENDED SAFE
 *      WITHDRAWAL = liquidity − protected − cushion, the amount above it, the resulting liquidity, the commitments that
 *      would go unfunded, infrastructure cover and a severity. Advisory: it is never a cap.
 *    - `fleet_admin_owner_withdrawal` (same signature): above the recommendation it returns needs_acknowledgement with
 *      the full assessment; with acknowledgement the admin proceeds. The only refusals are ownership/availability
 *      boundaries (not an owner destination, more than the unrestricted pool holds) — tax, restricted and agent money are
 *      never in the pool. Strong confirmation now applies to EVERY withdrawal (the fixed strong-auth amount threshold is
 *      retired, inert); a repeated idempotency key returns the original instruction (no second withdrawal).
 *    - This is distinct from automatic owner sweeps (OWNER_SWEEP_ENABLED, still off) and from agent spending.
 * 2. R24 OWN-CAPITAL EXPERIMENTS: the controller's commercial-evidence gate is retired. Relevance assessment and the
 *    verified evidence level are still recorded (information, Fleet knowledge), but an own-capital experiment is decided
 *    on custody alone — survival headroom bounds its budget; irreversible = the whole budget at risk. No WATCH for
 *    "insufficient", "uncertain" or "pending" evidence.
 * 3. CONTEXTUAL COGNITION DEPTH at the spend boundary: exposure share of own available capital is ONE input (half the
 *    configured line = 1 point, the line = 2, no capital = 3); a fully recoverable asset purchase lowers it (−1); a
 *    destination this founder has never paid raises it (+1). Critical-tier cognition is required at 2 points. No single
 *    percentage decides alone, and nothing here is a spending permission (custody decides the order).
 */

import { V24_SQL } from "./migrations-phase24.js";

/** One v24 function definition, verbatim, as the base of a v31 redefinition (exact edits, each asserted). */
function v24Function(name: string, edits: Array<[string, string]>): string {
  const start = V24_SQL.indexOf(`CREATE FUNCTION ${name}(`);
  const end = V24_SQL.indexOf("END $$;", start);
  if (start < 0 || end < 0) throw new Error(`v31: v24 function ${name} not found`);
  let body = "CREATE OR REPLACE" + V24_SQL.slice(start + "CREATE".length, end + "END $$;".length);
  for (const [from, to] of edits) {
    if (!body.includes(from)) throw new Error(`v31: expected text not found in ${name}`);
    body = body.replace(from, to);
  }
  return body;
}

/**
 * R24 evidence keeps being assessed after an own-capital experiment is approved (v31 decides at once): the assessor also
 * works on approved / partially approved / running experiments; their verified level is recorded as information, and only
 * an experiment still awaiting a decision is (re)decided.
 */
const ASSESSED = "'proposed','watch','approved','partially_approved','running'";
const RELEVANCE_PENDING = v24Function("svc_experiment_relevance_pending", [["WHERE pol.enabled AND e.status IN ('proposed','watch')", `WHERE pol.enabled AND e.status IN (${ASSESSED})`]]);
const RELEVANCE_RECORD = v24Function("svc_experiment_relevance_record", [
  ["IF e.status NOT IN ('proposed','watch') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE'); END IF;",
   `IF e.status NOT IN (${ASSESSED}) THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE'); END IF;`],
  [`  d := fleet_experiment_evaluate(e);
  e := fleet_experiment_apply(e, d, 'controller', 'controller');`,
   `  IF e.status IN ('proposed','watch') THEN
    d := fleet_experiment_evaluate(e);
    e := fleet_experiment_apply(e, d, 'controller', 'controller');
  ELSE
    d := jsonb_build_object('decision', e.status, 'code', 'FLEET_EVIDENCE_RECORDED', 'reason', 'evidence level recorded as information; the custody decision stands');
  END IF;`],
]);
const RELEVANCE_OVERRIDE = v24Function("fleet_experiment_assess_relevance", [
  ["IF e.status NOT IN ('proposed','watch') THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: relevance is settled before the decision (experiment is %)', e.status; END IF;",
   `IF e.status NOT IN (${ASSESSED}) THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: relevance is settled once the experiment has ended (experiment is %)', e.status; END IF;`],
  [`  d := fleet_experiment_evaluate(e);
  e := fleet_experiment_apply(e, d, 'controller', 'controller');`,
   `  IF e.status IN ('proposed','watch') THEN
    d := fleet_experiment_evaluate(e);
    e := fleet_experiment_apply(e, d, 'controller', 'controller');
  ELSE
    d := jsonb_build_object('decision', e.status, 'code', 'FLEET_EVIDENCE_RECORDED', 'reason', 'evidence level recorded as information; the custody decision stands');
  END IF;`],
]);

export const V31_SQL = `
-- ═══ 1. Admin withdrawal risk assessment (advisory) ═══
CREATE TABLE fleet_admin_withdrawal_policy (
  id            smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  cushion_bp    integer     NOT NULL DEFAULT 1000 CHECK (cushion_bp BETWEEN 0 AND 10000),
  horizon_days  integer     NOT NULL DEFAULT 30 CHECK (horizon_days BETWEEN 1 AND 365),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text        NOT NULL DEFAULT 'migration'
);
INSERT INTO fleet_admin_withdrawal_policy (id) VALUES (1);
COMMENT ON TABLE fleet_admin_withdrawal_policy IS 'Admin/Treasury risk ADVICE for manual withdrawals: cushion = cushion_bp of the unrestricted Treasury liquidity (owner policy: 10 %); horizon for projected costs. Never a withdrawal cap, never an agent rule.';
CREATE TRIGGER fleet_admin_withdrawal_policy_no_delete BEFORE DELETE ON fleet_admin_withdrawal_policy FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_admin_withdrawal_policy_no_truncate BEFORE TRUNCATE ON fleet_admin_withdrawal_policy FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION fleet_admin_withdrawal_policy_set(p_cushion_bp integer, p_horizon_days integer, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_admin_withdrawal_policy;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');
  UPDATE fleet_admin_withdrawal_policy SET cushion_bp = COALESCE(p_cushion_bp, cushion_bp), horizon_days = COALESCE(p_horizon_days, horizon_days),
         updated_at = now(), updated_by = p_actor WHERE id = 1 RETURNING * INTO r;
  PERFORM fleet_event('admin_withdrawal_policy_set', NULL, p_actor, to_jsonb(r) - 'id');
  RETURN to_jsonb(r) - 'id';
END $$;

CREATE FUNCTION fleet_admin_withdrawal_assessment(p_amount bigint) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_admin_withdrawal_policy; v_liquid bigint; v_committed bigint; v_oblig bigint; v_infra_window bigint; v_infra bigint; v_continuity bigint;
        v_protected bigint; v_cushion bigint; v_safe bigint; v_after bigint; v_above bigint; v_sev text; v_unfunded jsonb; v_infra_day bigint; r record;
        v_agent_cash bigint; v_tax bigint; v_env bigint; v_clearing bigint; v_partitions bigint; v_pool bigint;
BEGIN
  SELECT * INTO p FROM fleet_admin_withdrawal_policy WHERE id = 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_REGISTRY_UNAVAILABLE: admin withdrawal policy missing (fail closed)'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a positive amount is required'; END IF;
  -- Unrestricted withdrawable liquidity: the Treasury's unallocated pool (what an owner withdrawal debits).
  v_liquid := fleet_ledger_balance('fleet:treasury:unallocated');
  v_pool := fleet_ledger_balance('fleet:operating:pool');
  -- Restricted / not in the pool (shown, never withdrawable through this flow).
  SELECT COALESCE(sum(fleet_ledger_balance(account_id)) FILTER (WHERE class IN ('agent_cash','agent_reserved')), 0),
         COALESCE(sum(fleet_ledger_balance(account_id)) FILTER (WHERE class = 'agent_tax_reserve'), 0),
         COALESCE(sum(fleet_ledger_balance(account_id)) FILTER (WHERE class = 'agent_envelope_cash'), 0),
         COALESCE(sum(fleet_ledger_balance(account_id)) FILTER (WHERE class = 'custody_clearing'), 0),
         COALESCE(sum(fleet_ledger_balance(account_id)) FILTER (WHERE class = 'treasury_cash' AND account_id <> 'fleet:treasury:unallocated'), 0)
    INTO v_agent_cash, v_tax, v_env, v_clearing, v_partitions
    FROM fleet_ledger_accounts;
  -- Protected operating requirements.
  SELECT COALESCE(sum(capital_minor - allocated_minor), 0) INTO v_committed FROM fleet_envelopes WHERE status = 'active';
  SELECT COALESCE(sum(amount_cents), 0) INTO v_oblig FROM fleet_treasury_obligations WHERE status = 'approved';
  SELECT COALESCE(sum(CASE WHEN po.side = 'D' THEN po.amount_cents ELSE -po.amount_cents END), 0)::bigint INTO v_infra_window
    FROM fleet_ledger_postings po JOIN fleet_ledger_journal j ON j.journal_id = po.journal_id JOIN fleet_ledger_accounts a ON a.account_id = po.account_id
   WHERE a.class = 'fleet_expense' AND j.occurred_at > now() - make_interval(days => p.horizon_days);
  v_infra_day := (GREATEST(v_infra_window, 0) + p.horizon_days - 1) / p.horizon_days;
  v_infra := v_infra_day * p.horizon_days;
  -- Agent business continuity: active agents whose own available capital cannot fund their burn over the horizon.
  v_continuity := 0;
  FOR r IN SELECT agent_id FROM fleet_agents WHERE status = 'active' LOOP
    v_continuity := v_continuity + GREATEST(0, COALESCE(fleet_agent_burn_per_day(r.agent_id), 0) * p.horizon_days
                    - COALESCE((fleet_agent_economics(r.agent_id) ->> 'expensePurchasingCapacity')::bigint, 0));
  END LOOP;
  v_protected := v_committed + v_oblig + v_infra + v_continuity;
  v_cushion := fleet_ceil_bp(GREATEST(v_liquid, 0), p.cushion_bp);
  v_safe := GREATEST(0, v_liquid - v_protected - v_cushion);
  v_above := GREATEST(0, p_amount - v_safe);
  v_after := v_liquid - p_amount;
  v_sev := CASE WHEN p_amount > v_liquid THEN 'unavailable'
                WHEN v_above = 0 THEN 'normal'
                WHEN v_after >= v_protected THEN 'elevated'          -- consumes (part of) the cushion only
                WHEN v_after >= v_committed + v_oblig THEN 'high'     -- cuts into projected infrastructure / agent continuity
                ELSE 'critical' END;                                  -- committed capital or obligations would go unfunded
  SELECT COALESCE(jsonb_agg(jsonb_build_object('envelopeId', envelope_id, 'agentId', agent_id, 'unallocatedTrancheMinor', capital_minor - allocated_minor)
           ORDER BY created_at), '[]'::jsonb)
    INTO v_unfunded FROM fleet_envelopes WHERE status = 'active' AND capital_minor > allocated_minor AND v_after < v_committed + v_oblig;
  RETURN jsonb_build_object(
    'requestedMinor', p_amount, 'unrestrictedLiquidMinor', v_liquid,
    'restrictedExcluded', jsonb_build_object('agentCashMinor', v_agent_cash, 'taxReservesMinor', v_tax, 'envelopeCapitalMinor', v_env,
      'inFlightWithdrawalsMinor', v_clearing, 'treasuryPartitionsMinor', v_partitions, 'operatingPoolMinor', v_pool),
    'protected', jsonb_build_object('committedFleetCapitalMinor', v_committed, 'treasuryObligationsMinor', v_oblig,
      'projectedInfrastructureMinor', v_infra, 'infrastructurePerDayMinor', v_infra_day, 'agentContinuityShortfallMinor', v_continuity,
      'horizonDays', p.horizon_days, 'totalMinor', v_protected),
    'cushion', jsonb_build_object('bp', p.cushion_bp, 'baseMinor', GREATEST(v_liquid, 0), 'minor', v_cushion,
      'rule', 'cushion = cushion_bp of the unrestricted Treasury liquidity (owner admin-risk policy)'),
    'recommendedSafeMinor', v_safe, 'aboveRecommendationMinor', v_above, 'resultingLiquidMinor', v_after,
    'infrastructureCoverDaysAfter', CASE WHEN v_infra_day > 0 THEN GREATEST(v_after, 0) / v_infra_day END,
    'unfundedCommitments', v_unfunded, 'severity', v_sev,
    'reason', CASE v_sev
      WHEN 'normal' THEN 'within the recommended safe amount: protected operating requirements and the cushion stay funded'
      WHEN 'elevated' THEN 'above the recommendation: the Treasury cushion is reduced; protected operating requirements stay funded'
      WHEN 'high' THEN 'above the recommendation: projected infrastructure costs and/or agent-business continuity are no longer fully covered'
      WHEN 'critical' THEN 'above the recommendation: committed Fleet capital or approved obligations would go unfunded'
      ELSE 'more than the unrestricted Treasury pool holds (restricted, tax and agent money are not withdrawable)' END,
    'advisory', true);
END $$;

-- The owner/admin withdrawal: no nominal cap; strong confirmation for every withdrawal; risk advice, acknowledgement above it.
CREATE OR REPLACE FUNCTION fleet_admin_owner_withdrawal(p_amount bigint, p_destination text, p_actor text, p_reason text, p_ack boolean, p_idem text, p_confirmation_sha256 text)
RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE d fleet_payment_destinations; a jsonb; m fleet_economic_model; v_admin uuid; v_hard text; prior fleet_admin_instructions; v_warn text[] := ARRAY[]::text[];
        v_legacy jsonb;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');
  IF p_amount IS NULL OR p_amount <= 0 OR p_idem IS NULL OR p_idem !~ '^[A-Za-z0-9:_.-]{8,128}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: amount and idempotency key required'; END IF;
  -- Idempotency: the same key returns the original instruction (a retried request never withdraws twice).
  SELECT * INTO prior FROM fleet_admin_instructions WHERE kind = 'owner_withdrawal' AND params ->> 'idempotencyKey' = p_idem ORDER BY created_at LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('status', prior.status, 'replay', true, 'instructionId', prior.instruction_id, 'result', prior.result);
  END IF;
  SELECT * INTO m FROM fleet_economic_model WHERE id = 1;
  SELECT * INTO d FROM fleet_payment_destinations WHERE destination_id = p_destination;
  a := fleet_admin_withdrawal_assessment(p_amount);
  IF NOT FOUND OR d.kind <> 'owner' THEN v_hard := 'FLEET_DESTINATION_NOT_ALLOWED';
  ELSIF d.status <> 'active' THEN v_hard := 'FLEET_DESTINATION_NOT_ACTIVE';
  ELSIF (a ->> 'unrestrictedLiquidMinor')::bigint < p_amount THEN v_hard := 'FLEET_INSUFFICIENT_TREASURY';
  END IF;
  IF v_hard IS NOT NULL THEN
    v_admin := fleet_admin_record('owner_withdrawal', jsonb_build_object('amountCents', p_amount, 'destinationId', p_destination, 'idempotencyKey', p_idem),
      a, NULL, p_ack, 'strong', NULL, NULL, 'refused', v_hard, NULL, p_actor);
    RETURN jsonb_build_object('status', 'refused', 'code', v_hard, 'constitutional', true, 'instructionId', v_admin, 'assessment', a);
  END IF;
  IF (a ->> 'aboveRecommendationMinor')::bigint > 0 THEN v_warn := v_warn || ('above_safe_recommendation_' || (a ->> 'severity'))::text; END IF;
  -- The owner's own reserve target (fleet_treasury_policy.reserve_target_months, v10) stays an acknowledgeable warning.
  v_legacy := fleet_treasury_assessment(p_amount);
  IF (v_legacy ->> 'afterCents')::bigint < (v_legacy ->> 'reserveTargetCents')::bigint THEN v_warn := v_warn || 'below_reserve_target'::text; END IF;
  a := a || jsonb_build_object('ownerReserveTargetMinor', (v_legacy ->> 'reserveTargetCents')::bigint);
  IF cardinality(v_warn) > 0 AND NOT COALESCE(p_ack, false) THEN
    RETURN jsonb_build_object('status', 'needs_acknowledgement', 'warnings', to_jsonb(v_warn), 'recommendation', 'recommend_against', 'assessment', a,
      'note', 'Advisory: the admin may proceed knowingly (acknowledge). Restricted, tax and agent money are never withdrawable.');
  END IF;
  -- Strong confirmation for every withdrawal (no amount decides when security applies).
  IF p_confirmation_sha256 IS NULL OR p_confirmation_sha256 !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'FLEET_STRONG_AUTH_REQUIRED: a confirmation code digest is required'; END IF;
  v_admin := fleet_admin_record('owner_withdrawal', jsonb_build_object('amountCents', p_amount, 'destinationId', p_destination, 'idempotencyKey', p_idem,
    'reason', left(fleet_scrub(p_reason), 200)), a, v_warn, p_ack, 'strong', p_confirmation_sha256, now() + make_interval(secs => m.confirmation_ttl_s),
    'pending_confirmation', NULL, NULL, p_actor);
  PERFORM fleet_event('admin_withdrawal_requested', NULL, p_actor, jsonb_build_object('instructionId', v_admin, 'amountMinor', p_amount,
    'recommendedSafeMinor', a -> 'recommendedSafeMinor', 'severity', a ->> 'severity', 'acknowledged', COALESCE(p_ack, false)));
  RETURN jsonb_build_object('status', 'pending_confirmation', 'instructionId', v_admin, 'confirmBy', now() + make_interval(secs => m.confirmation_ttl_s), 'assessment', a);
END $$;
COMMENT ON COLUMN fleet_economic_model.strong_auth_threshold_cents IS 'LEGACY (retired at v31): every owner withdrawal requires strong confirmation; no amount decides when security applies.';

-- ═══ 2. R24: own-capital experiments are decided on custody alone ═══
CREATE OR REPLACE FUNCTION fleet_experiment_evaluate(e fleet_experiments) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE eco jsonb; v_committed bigint; v_head bigint; v_amt bigint; v_loss bigint; rel jsonb; v_info text;
BEGIN
  -- Evidence is recorded as information (relevance, verified level), never a commercial gate on the founder's own capital.
  rel := fleet_experiment_relevant_evidence(e.experiment_id, e.verified_evidence);
  v_info := format('E%s verified (claimed E%s; %s relevant, %s uncertain, %s unassessed)', e.verified_level, e.claimed_level,
    rel ->> 'relevant', rel ->> 'uncertain', rel ->> 'unassessed');
  -- Custody: never more than the founder could lose without touching protected capital (survival headroom), net of the
  -- maximum loss other active experiments already commit.
  eco := fleet_agent_economics(e.agent_id);
  SELECT COALESCE(sum(COALESCE(approved_max_loss_minor, 0)), 0) INTO v_committed
    FROM fleet_experiments WHERE agent_id = e.agent_id AND status IN ('approved','partially_approved','running') AND experiment_id <> e.experiment_id;
  v_head := GREATEST(0, COALESCE((eco ->> 'expensePurchasingCapacity')::bigint, 0) - v_committed);
  IF e.max_loss_minor > 0 AND v_head = 0 THEN
    RETURN jsonb_build_object('decision', 'rejected', 'code', 'FLEET_PROTECTED_CAPITAL', 'reason', 'no headroom above protected capital and committed experiments');
  END IF;
  v_amt := LEAST(e.requested_minor, v_head);
  v_loss := CASE WHEN e.reversibility = 'irreversible' THEN v_amt ELSE LEAST(e.max_loss_minor, v_amt) END;
  IF v_amt < e.requested_minor OR v_loss < e.max_loss_minor THEN
    RETURN jsonb_build_object('decision', 'partially_approved', 'code', 'FLEET_EXPERIMENT_PARTIAL', 'approvedMinor', v_amt, 'maxLossMinor', v_loss,
      'reason', format('%s; survival headroom %s: budget %s of %s, maximum loss %s%s', v_info, v_head, v_amt, e.requested_minor, v_loss,
        CASE WHEN e.reversibility = 'irreversible' THEN ' (irreversible: the whole budget is at risk — reason carefully)' ELSE '' END));
  END IF;
  RETURN jsonb_build_object('decision', 'approved', 'code', 'FLEET_EXPERIMENT_APPROVED', 'approvedMinor', e.requested_minor, 'maxLossMinor', v_loss,
    'reason', format('%s; within survival headroom %s%s', v_info, v_head,
      CASE WHEN e.reversibility = 'irreversible' THEN ' (irreversible: the whole budget is at risk — reason carefully)' ELSE '' END));
END $$;

-- R24 evidence assessment continues after approval (information; see RELEVANCE_* above).
${RELEVANCE_PENDING}

${RELEVANCE_RECORD}

${RELEVANCE_OVERRIDE}

-- ═══ 3. Contextual cognition depth at the spend boundary ═══
CREATE FUNCTION fleet_spend_depth(p_agent text, p_amount bigint, p_category text, p_destination text, p_recoverable bigint) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_avail bigint := COALESCE((fleet_agent_economics(p_agent) ->> 'expensePurchasingCapacity')::bigint, 0);
        v_line integer := (SELECT major_exposure_bp FROM fleet_cognition_depth_policy WHERE id = 1); v_points integer := 0; v_factors jsonb := '[]'::jsonb; v_share numeric;
BEGIN
  IF v_avail <= 0 THEN
    v_points := 3; v_factors := v_factors || '"no available own capital"'::jsonb;
  ELSE
    v_share := COALESCE(p_amount, 0)::numeric * 10000 / v_avail;
    IF v_share >= v_line THEN v_points := 2; v_factors := v_factors || to_jsonb(format('exposure %s%% of available own capital', round(v_share / 100)));
    ELSIF v_share * 2 >= v_line THEN v_points := 1; v_factors := v_factors || to_jsonb(format('exposure %s%% of available own capital', round(v_share / 100)));
    END IF;
  END IF;
  IF p_category = 'asset_acquisition' AND COALESCE(p_recoverable, 0) >= COALESCE(p_amount, 0) AND v_points > 0 THEN
    v_points := v_points - 1; v_factors := v_factors || '"fully recoverable asset"'::jsonb;
  END IF;
  IF p_destination IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fleet_payment_orders WHERE agent_id = p_agent AND destination_id = p_destination
                                                   AND status IN ('reserved','executing','settled')) THEN
    v_points := v_points + 1; v_factors := v_factors || '"first payment to this destination"'::jsonb;
  END IF;
  RETURN jsonb_build_object('critical', v_points >= 2, 'points', v_points, 'factors', v_factors);
END $$;

-- The boundary with context (the v22 signature remains for compatibility: no destination → novelty is not scored).
CREATE FUNCTION svc_action_cognition_verify_ctx(p_agent text, p_action_class text, p_amount_minor bigint, p_category text, p_destination text,
  p_recoverable bigint, p_tool_call_id text, p_action_sha256 text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE rt fleet_cognition_routing; v_class text := p_action_class; v_min text; l fleet_cognition_log; dep jsonb;
BEGIN
  IF NOT fleet_routing_active(p_agent) THEN RETURN jsonb_build_object('ok', true, 'enforced', false); END IF;
  SELECT * INTO rt FROM fleet_cognition_routing WHERE id = 1;
  IF v_class = 'spend_request' THEN
    dep := fleet_spend_depth(p_agent, p_amount_minor, p_category, p_destination, p_recoverable);
    IF (dep ->> 'critical')::boolean THEN v_class := 'major_spend_request'; END IF;
  END IF;
  SELECT min_tier INTO v_min FROM fleet_action_min_tier WHERE action_class = v_class;
  IF v_min IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ACTION_CLASS_UNKNOWN'); END IF;
  IF p_tool_call_id IS NULL OR p_tool_call_id !~ '^[A-Za-z0-9_.:-]{1,64}$' OR p_action_sha256 IS NULL OR p_action_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ACTION_COGNITION_MISSING', 'actionClass', v_class, 'minTier', v_min, 'depth', dep);
  END IF;
  SELECT * INTO l FROM fleet_cognition_log
   WHERE agent_id = p_agent AND outcome = 'ok' AND tier IS NOT NULL
     AND at > now() - make_interval(secs => rt.action_link_window_s)
     AND tool_calls @> jsonb_build_array(jsonb_build_object('id', p_tool_call_id, 'actionSha256', p_action_sha256))
   ORDER BY seq DESC LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ACTION_COGNITION_MISSING', 'actionClass', v_class, 'minTier', v_min, 'depth', dep); END IF;
  IF array_position(ARRAY['T1','T2','T3'], l.tier) < array_position(ARRAY['T1','T2','T3'], v_min) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ACTION_COGNITION_TIER', 'actionClass', v_class, 'minTier', v_min, 'tier', l.tier, 'requestId', l.request_id, 'depth', dep);
  END IF;
  IF EXISTS (SELECT 1 FROM fleet_action_cognition_links WHERE request_id = l.request_id AND tool_call_id = p_tool_call_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ACTION_COGNITION_REUSED', 'actionClass', v_class);
  END IF;
  INSERT INTO fleet_action_cognition_links (request_id, tool_call_id, agent_id, action_class, action_sha256, tier)
    VALUES (l.request_id, p_tool_call_id, p_agent, v_class, p_action_sha256, l.tier);
  RETURN jsonb_build_object('ok', true, 'enforced', true, 'actionClass', v_class, 'minTier', v_min, 'tier', l.tier, 'requestId', l.request_id, 'depth', dep);
END $$;

-- Hub: the admin-withdrawal view — FleetController's assessment for a requested amount (or the recommendation alone)
-- and the audited history of withdrawal instructions.
CREATE FUNCTION fleet_hub_withdrawals(p_amount bigint DEFAULT NULL) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('assessment', fleet_admin_withdrawal_assessment(GREATEST(COALESCE(p_amount, 1), 1)),
    'history', COALESCE((SELECT jsonb_agg(jsonb_build_object('instructionId', i.instruction_id, 'at', i.created_at, 'actor', i.actor, 'status', i.status,
        'amountMinor', (i.params ->> 'amountCents')::bigint, 'recommendedSafeMinor', (i.assessment ->> 'recommendedSafeMinor')::bigint,
        'severity', i.assessment ->> 'severity', 'acknowledged', i.warnings_acknowledged, 'code', i.refusal_code) ORDER BY i.created_at DESC)
      FROM (SELECT * FROM fleet_admin_instructions WHERE kind = 'owner_withdrawal' ORDER BY created_at DESC LIMIT 100) i), '[]'::jsonb))
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

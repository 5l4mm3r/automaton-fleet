/**
 * Schema v30 — F2 capital engine, sweeps, cognition depth, experiment gate retirement, Hub and Doctor views.
 *
 * Three capital classes stay distinct:
 *   A. own spendable capital — the agent decides and self-risk-manages; FleetController checks custody only (v27);
 *   B. Fleet / Treasury / shared capital — FleetController allocates, as lender, through a deterministic risk engine;
 *   C. restricted capital (tax reserves, protected principal/obligations, other agents' money, envelope capital outside
 *      its purpose) — never ordinarily spendable.
 *
 * 1. CAPITAL REQUESTS (class B only). `capital.request` records purpose, amount, evidence, expected revenue/net/payback,
 *    downside, confidence, milestones and a lower-capital alternative. `fleet_capital_decide` returns APPROVE |
 *    PARTIAL_APPROVE | APPROVE_WITH_LIMITS | DEFER | REJECT, with reason codes and what would change the answer. It is
 *    deterministic, versioned (policy version recorded) and has NO owner branch. Policy values are relative (basis points
 *    of the Treasury, of the request), never nominal amounts.
 * 2. EXECUTION ENVELOPES. An approval becomes bounded authority: capital (tranches), purpose, venture, expiry, maximum
 *    loss (stop-loss), permitted spend categories, optional maximum single exposure, milestones and a reassessment
 *    date. Envelope capital sits in `agent_envelope_cash` (restricted to the envelope); `envelope.spend` reserves from
 *    it; release returns to it; stop-loss freezes only that envelope and returns unspent capital; a met milestone
 *    (ledger-verified) releases the next tranche automatically; expiry returns unspent capital (`svc_capital_reap`).
 * 3. SWEEPS from REALIZED NET PROFIT after tax only, never gross revenue: base = min(uncontributed after-tax profit, the
 *    safely transferable amount); rate = population band + maturity × surplus × (max − band) − active reinvestment
 *    reductions, all integer basis points, capped at 7 000 bp. Agents cannot set their rate. Posted through the v10
 *    LFC-capped `fleet_profit_contribution`. `enabled` defaults to FALSE: activation is an operator step.
 * 4. COGNITION DEPTH (retires the fixed £20 `major_spend_threshold_minor`): a spend is a major action when its exposure is
 *    at least `major_exposure_bp` of the agent's own available capital (relative), or when the agent has none. The old
 *    column stays as an inert LEGACY value.
 * 5. EXPERIMENTS: the owner branch for irreversible / E4 experiments and the nominal evidence-ladder caps are retired. An
 *    own-capital experiment's budget is bounded by its survival headroom (custody); irreversibility tightens the bound
 *    (maximum loss = budget) and is stated in the reason; nothing routes to the owner. The legacy columns stay inert.
 * 6. HUB views (`fleet_hub`) and DOCTOR checks (`fleet_economy_health`) — read-only, owner functions.
 */

export const V30_SQL = `
-- ═══ 1. Capital policy (relative; versioned) ═══
CREATE TABLE fleet_capital_policy (
  id                        smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  version                   integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
  enabled                   boolean     NOT NULL DEFAULT true,
  treasury_reserve_bp       integer     NOT NULL DEFAULT 5000 CHECK (treasury_reserve_bp BETWEEN 0 AND 10000),
  max_request_treasury_bp   integer     NOT NULL DEFAULT 1000 CHECK (max_request_treasury_bp BETWEEN 1 AND 10000),
  max_agent_exposure_bp     integer     NOT NULL DEFAULT 2500 CHECK (max_agent_exposure_bp BETWEEN 1 AND 10000),
  partial_tranche_bp        integer     NOT NULL DEFAULT 5000 CHECK (partial_tranche_bp BETWEEN 1 AND 10000),
  min_confidence_bp         integer     NOT NULL DEFAULT 3000 CHECK (min_confidence_bp BETWEEN 0 AND 10000),
  min_evidence_items        integer     NOT NULL DEFAULT 2 CHECK (min_evidence_items BETWEEN 0 AND 12),
  min_track_record          integer     NOT NULL DEFAULT 3 CHECK (min_track_record BETWEEN 0 AND 100),
  limited_stop_loss_bp      integer     NOT NULL DEFAULT 5000 CHECK (limited_stop_loss_bp BETWEEN 1 AND 10000),
  envelope_days             integer     NOT NULL DEFAULT 30 CHECK (envelope_days BETWEEN 1 AND 365),
  limited_envelope_days     integer     NOT NULL DEFAULT 14 CHECK (limited_envelope_days BETWEEN 1 AND 365),
  high_roi_bp               integer     NOT NULL DEFAULT 5000 CHECK (high_roi_bp BETWEEN 1 AND 1000000),
  reinvestment_reduction_bp integer     NOT NULL DEFAULT 2500 CHECK (reinvestment_reduction_bp BETWEEN 0 AND 10000),
  reapply_cooldown_s        integer     NOT NULL DEFAULT 3600 CHECK (reapply_cooldown_s BETWEEN 0 AND 604800),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                text        NOT NULL DEFAULT 'migration'
);
INSERT INTO fleet_capital_policy (id) VALUES (1);
COMMENT ON TABLE fleet_capital_policy IS 'FleetController''s lender policy for Fleet/Treasury capital (class B) only. Relative values (bp); versioned; never applied to own capital.';
CREATE TRIGGER fleet_capital_policy_no_delete BEFORE DELETE ON fleet_capital_policy FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_capital_policy_no_truncate BEFORE TRUNCATE ON fleet_capital_policy FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION fleet_admin_capital_policy_set(p jsonb, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_capital_policy; k text;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  FOR k IN SELECT jsonb_object_keys(COALESCE(p, '{}'::jsonb)) LOOP
    IF k NOT IN ('enabled','treasuryReserveBp','maxRequestTreasuryBp','maxAgentExposureBp','partialTrancheBp','minConfidenceBp','minEvidenceItems','minTrackRecord',
                 'limitedStopLossBp','envelopeDays','limitedEnvelopeDays','highRoiBp','reinvestmentReductionBp','reapplyCooldownS') THEN
      RAISE EXCEPTION 'FLEET_BAD_REQUEST: unknown capital policy key %', k;
    END IF;
  END LOOP;
  UPDATE fleet_capital_policy SET version = version + 1,
    enabled = COALESCE((p ->> 'enabled')::boolean, enabled),
    treasury_reserve_bp = COALESCE((p ->> 'treasuryReserveBp')::integer, treasury_reserve_bp),
    max_request_treasury_bp = COALESCE((p ->> 'maxRequestTreasuryBp')::integer, max_request_treasury_bp),
    max_agent_exposure_bp = COALESCE((p ->> 'maxAgentExposureBp')::integer, max_agent_exposure_bp),
    partial_tranche_bp = COALESCE((p ->> 'partialTrancheBp')::integer, partial_tranche_bp),
    min_confidence_bp = COALESCE((p ->> 'minConfidenceBp')::integer, min_confidence_bp),
    min_evidence_items = COALESCE((p ->> 'minEvidenceItems')::integer, min_evidence_items),
    min_track_record = COALESCE((p ->> 'minTrackRecord')::integer, min_track_record),
    limited_stop_loss_bp = COALESCE((p ->> 'limitedStopLossBp')::integer, limited_stop_loss_bp),
    envelope_days = COALESCE((p ->> 'envelopeDays')::integer, envelope_days),
    limited_envelope_days = COALESCE((p ->> 'limitedEnvelopeDays')::integer, limited_envelope_days),
    high_roi_bp = COALESCE((p ->> 'highRoiBp')::integer, high_roi_bp),
    reinvestment_reduction_bp = COALESCE((p ->> 'reinvestmentReductionBp')::integer, reinvestment_reduction_bp),
    reapply_cooldown_s = COALESCE((p ->> 'reapplyCooldownS')::integer, reapply_cooldown_s),
    updated_at = now(), updated_by = p_actor
   WHERE id = 1 RETURNING * INTO r;
  PERFORM fleet_event('capital_policy_set', NULL, p_actor, p || jsonb_build_object('version', r.version));
  RETURN to_jsonb(r);
END $$;

-- ═══ 2. Requests, decisions, envelopes ═══
CREATE TABLE fleet_capital_requests (
  request_id              uuid        PRIMARY KEY,
  agent_id                text        NOT NULL REFERENCES fleet_agents(agent_id),
  venture_id              uuid        NOT NULL REFERENCES fleet_ventures(venture_id),
  idempotency_key         text        NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_.-]{4,128}$'),
  purpose                 text        NOT NULL CHECK (length(purpose) BETWEEN 1 AND 300),
  amount_minor            bigint      NOT NULL CHECK (amount_minor BETWEEN 1 AND 100000000000),
  evidence                jsonb       NOT NULL CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) <= 12),
  expected_revenue_minor  bigint      NOT NULL CHECK (expected_revenue_minor BETWEEN 0 AND 100000000000),
  expected_net_minor      bigint      NOT NULL CHECK (expected_net_minor BETWEEN -100000000000 AND 100000000000),
  expected_payback_days   integer     CHECK (expected_payback_days BETWEEN 0 AND 3650),
  downside_minor          bigint      NOT NULL CHECK (downside_minor >= 0),
  confidence_bp           integer     NOT NULL CHECK (confidence_bp BETWEEN 0 AND 10000),
  milestones              jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(milestones) = 'array' AND jsonb_array_length(milestones) <= 6),
  alternative_plan        text        CHECK (length(alternative_plan) <= 300),
  alternative_minor       bigint      CHECK (alternative_minor BETWEEN 1 AND 100000000000),
  categories              text[]      NOT NULL DEFAULT ARRAY['expense','fee'] CHECK (categories <@ ARRAY['expense','fee','asset_acquisition','conway_credits']::text[]),
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, idempotency_key),
  CHECK (downside_minor <= amount_minor)
);
CREATE TRIGGER fleet_capital_requests_no_change BEFORE UPDATE OR DELETE ON fleet_capital_requests FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_capital_requests_no_truncate BEFORE TRUNCATE ON fleet_capital_requests FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_envelopes (
  envelope_id         uuid        PRIMARY KEY,
  agent_id            text        NOT NULL REFERENCES fleet_agents(agent_id),
  venture_id          uuid        NOT NULL REFERENCES fleet_ventures(venture_id),
  request_id          uuid        NOT NULL UNIQUE REFERENCES fleet_capital_requests(request_id),
  purpose             text        NOT NULL,
  capital_minor       bigint      NOT NULL CHECK (capital_minor > 0),
  allocated_minor     bigint      NOT NULL DEFAULT 0 CHECK (allocated_minor >= 0),
  returned_minor      bigint      NOT NULL DEFAULT 0 CHECK (returned_minor >= 0),
  max_loss_minor      bigint      NOT NULL CHECK (max_loss_minor > 0),
  max_single_bp       integer     CHECK (max_single_bp BETWEEN 1 AND 10000),
  categories          text[]      NOT NULL,
  milestones          jsonb       NOT NULL DEFAULT '[]',
  expires_at          timestamptz NOT NULL,
  reassess_at         timestamptz,
  sweep_reduction_bp  integer     NOT NULL DEFAULT 0 CHECK (sweep_reduction_bp BETWEEN 0 AND 10000),
  status              text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','expired','closed')),
  status_reason       text        CHECK (length(status_reason) <= 300),
  created_at          timestamptz NOT NULL DEFAULT now(),
  closed_at           timestamptz,
  CHECK (allocated_minor <= capital_minor),
  CHECK (returned_minor <= allocated_minor)
);
CREATE INDEX fleet_envelopes_agent ON fleet_envelopes (agent_id, status);
CREATE TRIGGER fleet_envelopes_no_delete BEFORE DELETE ON fleet_envelopes FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_envelopes_no_truncate BEFORE TRUNCATE ON fleet_envelopes FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
CREATE FUNCTION fleet_envelopes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('expired','closed') THEN RAISE EXCEPTION 'FLEET_IMMUTABLE: a closed envelope is final'; END IF;
  IF (to_jsonb(NEW) - ARRAY['allocated_minor','returned_minor','milestones','status','status_reason','closed_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['allocated_minor','returned_minor','milestones','status','status_reason','closed_at']) THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: an envelope''s terms are fixed (request more capital for new terms)';
  END IF;
  IF NEW.allocated_minor < OLD.allocated_minor OR NEW.returned_minor < OLD.returned_minor THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: envelope counters only grow';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_envelopes_guard BEFORE UPDATE ON fleet_envelopes FOR EACH ROW EXECUTE FUNCTION fleet_envelopes_guard();

CREATE TABLE fleet_capital_decisions (
  decision_id      uuid        PRIMARY KEY,
  request_id       uuid        NOT NULL UNIQUE REFERENCES fleet_capital_requests(request_id),
  outcome          text        NOT NULL CHECK (outcome IN ('APPROVE','PARTIAL_APPROVE','APPROVE_WITH_LIMITS','DEFER','REJECT')),
  approved_minor   bigint      NOT NULL DEFAULT 0 CHECK (approved_minor >= 0),
  reasons          jsonb       NOT NULL CHECK (jsonb_typeof(reasons) = 'array'),
  would_change     text        CHECK (length(would_change) <= 400),
  inputs           jsonb       NOT NULL,
  policy_version   integer     NOT NULL,
  envelope_id      uuid        REFERENCES fleet_envelopes(envelope_id),
  decided_by       text        NOT NULL CHECK (decided_by = 'controller'),
  decided_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((outcome IN ('DEFER','REJECT')) = (approved_minor = 0 AND envelope_id IS NULL))
);
CREATE TRIGGER fleet_capital_decisions_no_change BEFORE UPDATE OR DELETE ON fleet_capital_decisions FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_capital_decisions_no_truncate BEFORE TRUNCATE ON fleet_capital_decisions FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- Orders know their funding: own capital (v27 custody path) or an envelope (Fleet capital, this migration).
ALTER TABLE fleet_payment_orders ADD COLUMN funding text NOT NULL DEFAULT 'own' CHECK (funding IN ('own','envelope')),
  ADD COLUMN envelope_id uuid REFERENCES fleet_envelopes(envelope_id),
  ADD CONSTRAINT fleet_payment_orders_funding_envelope CHECK ((funding = 'envelope') = (envelope_id IS NOT NULL));
CREATE FUNCTION fleet_orders_funding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.funding IS DISTINCT FROM OLD.funding OR NEW.envelope_id IS DISTINCT FROM OLD.envelope_id THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: an order''s funding is fixed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_orders_funding_guard BEFORE UPDATE ON fleet_payment_orders FOR EACH ROW EXECUTE FUNCTION fleet_orders_funding_guard();

-- Release returns funds to where they came from (own cash, or the envelope).
CREATE OR REPLACE FUNCTION fleet_order_release(o fleet_payment_orders, p_status text, p_actor text, p_source text, p_code text)
RETURNS fleet_payment_orders LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_j uuid; r fleet_payment_orders;
BEGIN
  IF o.reservation_journal_id IS NOT NULL THEN
    IF o.order_type = 'agent_spend' AND o.funding = 'envelope' THEN
      v_j := fleet_ledger_post('envelope_spend_release', 'release:' || o.order_id, p_actor, 'release envelope order: ' || p_status, p_source, o.agent_id, o.order_id,
        NULL, NULL, NULL, now(), jsonb_build_array(
          jsonb_build_object('account', fleet_ledger_account(o.agent_id, 'agent_envelope_cash'), 'side', 'D', 'amount', o.amount_cents),
          jsonb_build_object('account', fleet_ledger_account(o.agent_id, 'agent_reserved'), 'side', 'C', 'amount', o.amount_cents)));
    ELSIF o.order_type = 'agent_spend' THEN
      v_j := fleet_ledger_post('spend_release', 'release:' || o.order_id, p_actor, 'release spend order: ' || p_status, p_source, o.agent_id, o.order_id,
        NULL, NULL, NULL, now(), jsonb_build_array(
          jsonb_build_object('account', fleet_ledger_account(o.agent_id, 'agent_cash'), 'side', 'D', 'amount', o.amount_cents),
          jsonb_build_object('account', fleet_ledger_account(o.agent_id, 'agent_reserved'), 'side', 'C', 'amount', o.amount_cents)));
    ELSE
      v_j := fleet_ledger_post('owner_withdrawal_release', 'release:' || o.order_id, p_actor, 'release owner withdrawal: ' || p_status,
        CASE WHEN p_source = 'controller' THEN 'owner' ELSE p_source END, NULL, o.order_id, NULL, NULL, NULL, now(), jsonb_build_array(
          jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', o.amount_cents),
          jsonb_build_object('account', 'fleet:custody:withdrawal_clearing', 'side', 'C', 'amount', o.amount_cents)));
    END IF;
  END IF;
  UPDATE fleet_payment_orders SET status = p_status, release_journal_id = v_j, decision_code = COALESCE(p_code, decision_code)
   WHERE order_id = o.order_id RETURNING * INTO r;
  PERFORM fleet_event('payment_order_' || p_status, o.agent_id, left(p_actor, 128),
    jsonb_build_object('orderId', o.order_id, 'orderType', o.order_type, 'amountCents', o.amount_cents, 'code', p_code, 'funding', o.funding));
  RETURN r;
END $$;

-- Envelope position: allocated − returned − committed (reserved/executing/settled orders under it).
CREATE FUNCTION fleet_envelope_position(e fleet_envelopes) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  WITH o AS (SELECT COALESCE(sum(amount_cents) FILTER (WHERE status IN ('reserved','executing')), 0) AS reserved,
                    COALESCE(sum(amount_cents) FILTER (WHERE status = 'settled'), 0) AS spent
               FROM fleet_payment_orders WHERE envelope_id = e.envelope_id),
       rv AS (SELECT COALESCE((fleet_venture_financials(e.venture_id, e.created_at) ->> 'revenueMinor')::bigint
                              - (fleet_venture_financials(e.venture_id, e.created_at) ->> 'refundsMinor')::bigint, 0) AS revenue)
  SELECT jsonb_build_object('capitalMinor', e.capital_minor, 'allocatedMinor', e.allocated_minor, 'returnedMinor', e.returned_minor,
    'reservedMinor', o.reserved, 'spentMinor', o.spent, 'availableMinor', e.allocated_minor - e.returned_minor - o.reserved - o.spent,
    'revenueSinceMinor', rv.revenue, 'lossMinor', GREATEST(0, o.spent - rv.revenue), 'maxLossMinor', e.max_loss_minor)
  FROM o, rv
$$;

CREATE FUNCTION fleet_envelope_json(e fleet_envelopes) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('envelopeId', e.envelope_id, 'venture', (SELECT venture_key FROM fleet_ventures WHERE venture_id = e.venture_id),
    'purpose', e.purpose, 'status', e.status, 'statusReason', e.status_reason, 'categories', to_jsonb(e.categories), 'maxSingleBp', e.max_single_bp,
    'milestones', e.milestones, 'expiresAt', e.expires_at, 'reassessAt', e.reassess_at, 'position', fleet_envelope_position(e)))
$$;

-- Return the unspent part of an envelope to the Treasury and close/freeze it.
CREATE FUNCTION fleet_envelope_return(e fleet_envelopes, p_status text, p_reason text, p_actor text) RETURNS fleet_envelopes LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE pos jsonb := fleet_envelope_position(e); v_back bigint; r fleet_envelopes;
BEGIN
  v_back := GREATEST(0, (pos ->> 'availableMinor')::bigint);
  IF v_back > 0 THEN
    PERFORM fleet_ledger_post('envelope_return', 'envret:' || e.envelope_id || ':' || (e.returned_minor + v_back), p_actor, left('envelope return: ' || p_reason, 200),
      'controller', e.agent_id, NULL, NULL, NULL, NULL, now(),
      jsonb_build_array(jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', v_back),
                        jsonb_build_object('account', fleet_ledger_account(e.agent_id, 'agent_envelope_cash'), 'side', 'C', 'amount', v_back)));
  END IF;
  UPDATE fleet_envelopes SET returned_minor = returned_minor + v_back, status = p_status, status_reason = left(p_reason, 300),
         closed_at = CASE WHEN p_status IN ('expired','closed') THEN now() END
   WHERE envelope_id = e.envelope_id RETURNING * INTO r;
  PERFORM fleet_event('envelope_' || p_status, e.agent_id, p_actor, jsonb_build_object('envelopeId', e.envelope_id, 'returnedMinor', v_back, 'reason', p_reason));
  RETURN r;
END $$;

-- Allocate a tranche into an envelope (Treasury → envelope capital).
CREATE FUNCTION fleet_envelope_allocate(e fleet_envelopes, p_amount bigint, p_actor text, p_note text) RETURNS fleet_envelopes LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_envelopes;
BEGIN
  IF p_amount <= 0 THEN RETURN e; END IF;
  PERFORM fleet_ledger_post('envelope_allocation', 'envalloc:' || e.envelope_id || ':' || (e.allocated_minor + p_amount), p_actor, left('envelope tranche: ' || p_note, 200),
    'controller', e.agent_id, NULL, NULL, NULL, NULL, now(),
    jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(e.agent_id, 'agent_envelope_cash'), 'side', 'D', 'amount', p_amount),
                      jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', p_amount)));
  UPDATE fleet_envelopes SET allocated_minor = allocated_minor + p_amount WHERE envelope_id = e.envelope_id RETURNING * INTO r;
  PERFORM fleet_event('envelope_allocation', e.agent_id, p_actor, jsonb_build_object('envelopeId', e.envelope_id, 'amountMinor', p_amount, 'note', p_note));
  RETURN r;
END $$;

-- Milestones and stop-loss, from the ledger only. Milestone: {key, metric: revenue_minor|net_profit_minor, target, trancheMinor, met}.
CREATE FUNCTION fleet_envelope_evaluate(p_envelope uuid, p_actor text) RETURNS fleet_envelopes LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE e fleet_envelopes; pos jsonb; f jsonb; m jsonb; v_ms jsonb := '[]'::jsonb; v_release bigint := 0; v_val bigint;
BEGIN
  SELECT * INTO e FROM fleet_envelopes WHERE envelope_id = p_envelope FOR UPDATE;
  IF e.status <> 'active' THEN RETURN e; END IF;
  pos := fleet_envelope_position(e);
  IF (pos ->> 'lossMinor')::bigint >= e.max_loss_minor THEN
    RETURN fleet_envelope_return(e, 'frozen', format('stop-loss reached (loss %s of maximum %s): this envelope only; request again on new evidence',
      pos ->> 'lossMinor', e.max_loss_minor), p_actor);
  END IF;
  IF e.expires_at <= now() THEN RETURN fleet_envelope_return(e, 'expired', 'envelope expired: unspent capital returned', p_actor); END IF;
  f := fleet_venture_financials(e.venture_id, e.created_at);
  FOR m IN SELECT x FROM jsonb_array_elements(e.milestones) x LOOP
    v_val := CASE m ->> 'metric' WHEN 'revenue_minor' THEN (f ->> 'revenueMinor')::bigint - (f ->> 'refundsMinor')::bigint
                                 WHEN 'net_profit_minor' THEN (f ->> 'netProfitMinor')::bigint END;
    IF NOT COALESCE((m ->> 'met')::boolean, false) AND v_val IS NOT NULL AND v_val >= (m ->> 'target')::bigint THEN
      m := m || jsonb_build_object('met', true, 'metAt', now());
      v_release := v_release + COALESCE((m ->> 'trancheMinor')::bigint, 0);
      PERFORM fleet_event('envelope_milestone', e.agent_id, p_actor, jsonb_build_object('envelopeId', e.envelope_id, 'milestone', m ->> 'key'));
    END IF;
    v_ms := v_ms || jsonb_build_array(m);
  END LOOP;
  IF v_ms IS DISTINCT FROM e.milestones THEN
    UPDATE fleet_envelopes SET milestones = v_ms WHERE envelope_id = e.envelope_id RETURNING * INTO e;
  END IF;
  v_release := LEAST(v_release, e.capital_minor - e.allocated_minor, GREATEST(0, fleet_ledger_balance('fleet:treasury:unallocated')));
  IF v_release > 0 THEN e := fleet_envelope_allocate(e, v_release, p_actor, 'milestone met'); END IF;
  RETURN e;
END $$;

-- The deterministic lender decision (Fleet capital only). No branch routes to the owner.
CREATE FUNCTION fleet_capital_decide(q fleet_capital_requests) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_capital_policy; a fleet_agents; v_unalloc bigint; v_outstanding bigint; v_total bigint; v_floor bigint; v_room bigint; v_req_cap bigint;
        v_agent_out bigint; v_agent_cap bigint; v_cap bigint; perf jsonb; v_measured integer; v_within integer; v_adj_net bigint; v_roi bigint;
        v_reasons jsonb := '[]'::jsonb; v_outcome text; v_amount bigint; v_limits boolean := false; v_failed integer; v_profitable integer;
BEGIN
  SELECT * INTO p FROM fleet_capital_policy WHERE id = 1;
  IF NOT FOUND OR NOT p.enabled THEN
    RETURN jsonb_build_object('outcome', 'DEFER', 'reasons', jsonb_build_array('ENGINE_DISABLED'), 'wouldChange', 'the capital engine is disabled; use own capital meanwhile',
      'policyVersion', COALESCE(p.version, 0), 'inputs', '{}'::jsonb);
  END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = q.agent_id;
  IF a.status <> 'active' OR a.operator_hold_at IS NOT NULL OR EXISTS (SELECT 1 FROM fleet_wallet_custody w WHERE w.agent_id = q.agent_id AND w.spending_frozen) THEN
    RETURN jsonb_build_object('outcome', 'REJECT', 'reasons', jsonb_build_array('AGENT_NOT_ELIGIBLE'), 'wouldChange', 'an active agent without a hold or freeze',
      'policyVersion', p.version, 'inputs', '{}'::jsonb);
  END IF;
  -- Treasury liquidity and concentration (FleetController's own exposure as lender).
  v_unalloc := fleet_ledger_balance('fleet:treasury:unallocated');
  SELECT COALESCE(sum(allocated_minor - returned_minor), 0) INTO v_outstanding FROM fleet_envelopes WHERE status IN ('active','frozen');
  v_total := v_unalloc + v_outstanding;
  v_floor := fleet_ceil_bp(v_total, p.treasury_reserve_bp);
  v_room := GREATEST(0, v_unalloc - v_floor);
  v_req_cap := (v_total * p.max_request_treasury_bp) / 10000;
  SELECT COALESCE(sum(capital_minor - returned_minor), 0) INTO v_agent_out FROM fleet_envelopes WHERE agent_id = q.agent_id AND status IN ('active','frozen');
  v_agent_cap := GREATEST(0, (v_total * p.max_agent_exposure_bp) / 10000 - v_agent_out);
  v_cap := LEAST(v_room, v_req_cap, v_agent_cap);
  -- Expected value, discounted by the agent's own calibration (once it has a track record) or its stated confidence.
  perf := fleet_agent_performance(q.agent_id);
  v_measured := COALESCE((perf #>> '{forecast,measured}')::integer, 0);
  v_within := (perf #>> '{forecast,withinToleranceBp}')::integer;
  v_failed := COALESCE((perf #>> '{ventures,failed}')::integer, 0);
  v_profitable := COALESCE((perf #>> '{ventures,profitable}')::integer, 0);
  v_adj_net := CASE WHEN v_measured >= p.min_track_record AND v_within IS NOT NULL THEN (q.expected_net_minor * GREATEST(v_within, 2500)) / 10000
                    ELSE (q.expected_net_minor * q.confidence_bp) / 10000 END;
  v_roi := (v_adj_net * 10000) / q.amount_minor;
  IF q.expected_net_minor <= 0 OR v_adj_net <= 0 THEN
    v_outcome := 'REJECT'; v_reasons := v_reasons || '"NEGATIVE_EXPECTED_VALUE"'::jsonb;
  ELSIF jsonb_array_length(q.evidence) < p.min_evidence_items THEN
    v_outcome := 'DEFER'; v_reasons := v_reasons || '"MORE_EVIDENCE"'::jsonb;
  ELSIF v_cap <= 0 THEN
    v_outcome := 'DEFER'; v_reasons := v_reasons || CASE WHEN v_agent_cap <= 0 THEN '"AGENT_CONCENTRATION"' ELSE '"TREASURY_LIQUIDITY"' END::jsonb;
  ELSE
    v_limits := q.confidence_bp < p.min_confidence_bp OR (v_measured >= p.min_track_record AND v_failed > v_profitable);
    IF q.amount_minor > v_cap THEN
      v_outcome := 'PARTIAL_APPROVE';
      v_amount := LEAST(v_cap, GREATEST(COALESCE(q.alternative_minor, 0), (q.amount_minor * p.partial_tranche_bp) / 10000));
      v_reasons := v_reasons || '"FIRST_TRANCHE"'::jsonb;
    ELSIF v_limits THEN
      v_outcome := 'APPROVE_WITH_LIMITS'; v_amount := q.amount_minor;
      v_reasons := v_reasons || CASE WHEN q.confidence_bp < p.min_confidence_bp THEN '"LOW_CONFIDENCE"' ELSE '"WEAK_TRACK_RECORD"' END::jsonb;
    ELSE
      v_outcome := 'APPROVE'; v_amount := q.amount_minor;
    END IF;
  END IF;
  RETURN jsonb_build_object('outcome', v_outcome, 'approvedMinor', COALESCE(v_amount, 0), 'limits', v_limits OR v_outcome = 'APPROVE_WITH_LIMITS',
    'reasons', v_reasons, 'adjustedRoiBp', v_roi, 'policyVersion', p.version,
    'wouldChange', CASE v_outcome WHEN 'REJECT' THEN 'a plan with positive expected net return on evidence'
                                  WHEN 'DEFER' THEN CASE WHEN v_reasons ? 'MORE_EVIDENCE' THEN format('at least %s evidence items', p.min_evidence_items)
                                                         ELSE 'a smaller request, the lower-capital alternative, or Treasury liquidity later' END END,
    'inputs', jsonb_build_object('treasuryUnallocatedMinor', v_unalloc, 'outstandingMinor', v_outstanding, 'treasuryRoomMinor', v_room, 'requestCapMinor', v_req_cap,
      'agentRoomMinor', v_agent_cap, 'adjustedNetMinor', v_adj_net, 'measuredForecasts', v_measured, 'withinToleranceBp', v_within, 'confidenceBp', q.confidence_bp,
      'evidenceItems', jsonb_array_length(q.evidence)));
END $$;

CREATE FUNCTION fleet_econ_capital_request(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v fleet_ventures; q fleet_capital_requests; d jsonb; e fleet_envelopes; p fleet_capital_policy; v_idem text := fleet_econ_text(a, 'idempotencyKey', 128, true);
        v_ms jsonb := '[]'::jsonb; m jsonb; v_cats text[]; v_dec fleet_capital_decisions; v_last timestamptz; v_days integer; v_amount bigint; v_alloc bigint;
BEGIN
  SELECT * INTO q FROM fleet_capital_requests WHERE agent_id = p_agent AND idempotency_key = v_idem;
  IF FOUND THEN
    SELECT * INTO v_dec FROM fleet_capital_decisions WHERE request_id = q.request_id;
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'outcome', v_dec.outcome, 'approvedMinor', v_dec.approved_minor,
      'envelope', (SELECT fleet_envelope_json(x) FROM fleet_envelopes x WHERE x.envelope_id = v_dec.envelope_id));
  END IF;
  SELECT * INTO v FROM fleet_ventures WHERE agent_id = p_agent AND venture_key = fleet_econ_key(a, 'ventureKey');
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND', 'reason', 'Fleet capital is requested for one of your ventures'); END IF;
  IF v.state IN ('failed','closed') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE', 'reason', 'the venture is ' || v.state); END IF;
  SELECT * INTO p FROM fleet_capital_policy WHERE id = 1;
  SELECT max(created_at) INTO v_last FROM fleet_capital_requests WHERE agent_id = p_agent AND venture_id = v.venture_id;
  IF v_last IS NOT NULL AND v_last > now() - make_interval(secs => p.reapply_cooldown_s) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_RATE_LIMITED', 'reason', 'one capital request per venture per cooldown: act on the last decision first');
  END IF;
  IF a ? 'milestones' THEN
    IF jsonb_typeof(a -> 'milestones') <> 'array' OR jsonb_array_length(a -> 'milestones') > 6 THEN PERFORM fleet_econ_bad('milestones is an array of at most 6'); END IF;
    FOR m IN SELECT x FROM jsonb_array_elements(a -> 'milestones') x LOOP
      IF m ->> 'metric' NOT IN ('revenue_minor','net_profit_minor') OR (m ->> 'target') !~ '^[0-9]{1,12}$' OR COALESCE(m ->> 'trancheMinor', '0') !~ '^[0-9]{1,12}$' THEN
        PERFORM fleet_econ_bad('each milestone is {key, metric: revenue_minor|net_profit_minor, target, trancheMinor}');
      END IF;
      v_ms := v_ms || jsonb_build_array(jsonb_build_object('key', left(COALESCE(m ->> 'key', 'm' || (jsonb_array_length(v_ms) + 1)), 40), 'metric', m ->> 'metric',
                'target', (m ->> 'target')::bigint, 'trancheMinor', COALESCE((m ->> 'trancheMinor')::bigint, 0), 'met', false));
    END LOOP;
  END IF;
  IF a ? 'categories' THEN
    SELECT array_agg(DISTINCT x) INTO v_cats FROM jsonb_array_elements_text(a -> 'categories') x;
    IF NOT (v_cats <@ ARRAY['expense','fee','asset_acquisition','conway_credits']::text[]) THEN PERFORM fleet_econ_bad('categories are expense, fee, asset_acquisition, conway_credits'); END IF;
  END IF;
  INSERT INTO fleet_capital_requests (request_id, agent_id, venture_id, idempotency_key, purpose, amount_minor, evidence, expected_revenue_minor, expected_net_minor,
      expected_payback_days, downside_minor, confidence_bp, milestones, alternative_plan, alternative_minor, categories)
    VALUES (gen_random_uuid(), p_agent, v.venture_id, v_idem, fleet_econ_text(a, 'purpose', 300, true), fleet_econ_int(a, 'amountMinor', 1, 100000000000, true),
      fleet_econ_evidence(a, 'evidence', 12), fleet_econ_int(a, 'expectedRevenueMinor', 0, 100000000000, true),
      fleet_econ_int(a, 'expectedNetMinor', -100000000000, 100000000000, true), fleet_econ_int(a, 'expectedPaybackDays', 0, 3650)::integer,
      fleet_econ_int(a, 'downsideMinor', 0, 100000000000, true), fleet_econ_int(a, 'confidenceBp', 0, 10000, true)::integer, v_ms,
      fleet_econ_text(a, 'alternativePlan', 300), fleet_econ_int(a, 'alternativeMinor', 1, 100000000000), COALESCE(v_cats, ARRAY['expense','fee']))
    RETURNING * INTO q;
  d := fleet_capital_decide(q);
  IF d ->> 'outcome' IN ('APPROVE','PARTIAL_APPROVE','APPROVE_WITH_LIMITS') THEN
    v_amount := (d ->> 'approvedMinor')::bigint;
    v_days := CASE WHEN (d ->> 'limits')::boolean THEN p.limited_envelope_days ELSE p.envelope_days END;
    INSERT INTO fleet_envelopes (envelope_id, agent_id, venture_id, request_id, purpose, capital_minor, max_loss_minor, max_single_bp, categories, milestones,
        expires_at, reassess_at, sweep_reduction_bp)
      VALUES (gen_random_uuid(), p_agent, v.venture_id, q.request_id, q.purpose,
        -- Partial: the first tranche now, the rest through milestones (bounded by what was requested).
        CASE WHEN d ->> 'outcome' = 'PARTIAL_APPROVE' THEN LEAST(q.amount_minor, v_amount + COALESCE((SELECT sum((x ->> 'trancheMinor')::bigint) FROM jsonb_array_elements(v_ms) x), 0)) ELSE v_amount END,
        GREATEST(1, LEAST(q.downside_minor, CASE WHEN (d ->> 'limits')::boolean THEN fleet_ceil_bp(v_amount, p.limited_stop_loss_bp) ELSE v_amount END)),
        CASE WHEN (d ->> 'limits')::boolean THEN 5000 END, q.categories, v_ms,
        now() + make_interval(days => v_days), now() + make_interval(days => GREATEST(1, v_days / 2)),
        CASE WHEN (d ->> 'adjustedRoiBp')::bigint >= p.high_roi_bp THEN p.reinvestment_reduction_bp ELSE 0 END)
      RETURNING * INTO e;
    v_alloc := v_amount;
    e := fleet_envelope_allocate(e, v_alloc, 'controller', 'approval');
  END IF;
  INSERT INTO fleet_capital_decisions (decision_id, request_id, outcome, approved_minor, reasons, would_change, inputs, policy_version, envelope_id, decided_by)
    VALUES (gen_random_uuid(), q.request_id, d ->> 'outcome', CASE WHEN e.envelope_id IS NULL THEN 0 ELSE (d ->> 'approvedMinor')::bigint END, d -> 'reasons',
            d ->> 'wouldChange', d -> 'inputs', (d ->> 'policyVersion')::integer, e.envelope_id, 'controller');
  PERFORM fleet_event('capital_decision', p_agent, 'controller', jsonb_build_object('requestId', q.request_id, 'outcome', d ->> 'outcome',
    'requestedMinor', q.amount_minor, 'approvedMinor', d ->> 'approvedMinor', 'reasons', d -> 'reasons', 'policyVersion', d ->> 'policyVersion'));
  RETURN jsonb_build_object('ok', true, 'outcome', d ->> 'outcome', 'approvedMinor', CASE WHEN e.envelope_id IS NULL THEN 0 ELSE (d ->> 'approvedMinor')::bigint END,
    'reasons', d -> 'reasons', 'wouldChange', d ->> 'wouldChange', 'envelope', CASE WHEN e.envelope_id IS NOT NULL THEN fleet_envelope_json(e) END,
    'note', 'FleetController decided as lender of Fleet capital. Your own capital needs no request.');
END $$;

-- Spend inside an envelope: the envelope's terms and custody (agent, destination) apply; the infrastructure breaker applies.
CREATE FUNCTION fleet_econ_envelope_spend(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE e fleet_envelopes; o fleet_payment_orders; ag fleet_agents; d fleet_payment_destinations; pos jsonb; v_amount bigint := fleet_econ_int(a, 'amountMinor', 1, 100000000000, true);
        v_cat text := COALESCE(fleet_econ_text(a, 'category', 20), 'expense'); v_dst text := fleet_econ_text(a, 'destinationId', 40, true);
        v_idem text := fleet_econ_text(a, 'idempotencyKey', 128, true); v_hash text; v_refusal text; v_signal text; v_j uuid; v_ttl integer;
BEGIN
  IF v_idem !~ '^[A-Za-z0-9:_.-]{8,128}$' THEN PERFORM fleet_econ_bad('idempotencyKey is 8-128 of A-Z a-z 0-9 : _ . -'); END IF;
  SELECT * INTO e FROM fleet_envelopes WHERE envelope_id = (a ->> 'envelopeId')::uuid AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND', 'reason', 'no such envelope of yours'); END IF;
  v_hash := encode(sha256(convert_to(concat_ws('|', p_agent, e.envelope_id, v_amount, v_cat, v_dst, fleet_scrub(a ->> 'purpose')), 'UTF8')), 'hex');
  SELECT * INTO o FROM fleet_payment_orders WHERE order_type = 'agent_spend' AND agent_id = p_agent AND idempotency_key = v_idem;
  IF FOUND THEN
    IF o.request_sha256 <> v_hash THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_IDEMPOTENCY_CONFLICT', 'custody', 'IDEMPOTENCY_CONFLICT'); END IF;
    RETURN jsonb_build_object('ok', o.status IN ('reserved','executing','settled'), 'replay', true, 'order', fleet_order_json(o));
  END IF;
  e := fleet_envelope_evaluate(e.envelope_id, 'controller');
  IF e.status <> 'active' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ENVELOPE_' || upper(e.status), 'reason', e.status_reason || '. Other envelopes, ventures and your own capital are unaffected.');
  END IF;
  IF NOT (v_cat = ANY (e.categories)) THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ENVELOPE_PURPOSE', 'reason', 'that category is outside this envelope''s purpose'); END IF;
  pos := fleet_envelope_position(e);
  IF v_amount > (pos ->> 'availableMinor')::bigint THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ENVELOPE_EXHAUSTED', 'reason', 'beyond this envelope''s available capital: use own capital or request more');
  END IF;
  IF e.max_single_bp IS NOT NULL AND v_amount * 10000 > e.capital_minor * e.max_single_bp THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ENVELOPE_SINGLE_EXPOSURE', 'reason', 'one order above this envelope''s single-exposure bound: split it or request new terms');
  END IF;
  -- Custody (agent and destination): the same rules as an own-capital order.
  SELECT * INTO ag FROM fleet_agents WHERE agent_id = p_agent;
  SELECT * INTO d FROM fleet_payment_destinations WHERE destination_id = v_dst;
  v_refusal := CASE WHEN ag.status <> 'active' THEN 'FLEET_AGENT_NOT_ACTIVE'
                    WHEN ag.operator_hold_at IS NOT NULL THEN 'FLEET_AGENT_HELD'
                    WHEN EXISTS (SELECT 1 FROM fleet_wallet_custody w WHERE w.agent_id = p_agent AND w.spending_frozen) THEN 'FLEET_SPENDING_FROZEN'
                    WHEN d.destination_id IS NULL OR d.kind <> 'payee' OR (d.allowed_agent_id IS NOT NULL AND d.allowed_agent_id <> p_agent) THEN 'FLEET_DESTINATION_NOT_ALLOWED'
                    WHEN d.status <> 'active' THEN 'FLEET_DESTINATION_NOT_ACTIVE' END;
  IF v_refusal IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_refusal, 'custody', fleet_custody_refusal(v_refusal)); END IF;
  SELECT reservation_ttl_s INTO v_ttl FROM fleet_economic_model WHERE id = 1;
  INSERT INTO fleet_payment_orders (order_id, order_type, agent_id, idempotency_key, amount_cents, category, destination_id, purpose, recoverable_cents,
      requested_by, request_sha256, status, expires_at, funding, envelope_id)
    VALUES (gen_random_uuid(), 'agent_spend', p_agent, v_idem, v_amount, v_cat, v_dst, left(fleet_econ_text(a, 'purpose', 300, true), 300), 0, p_agent, v_hash,
            'requested', now() + make_interval(secs => v_ttl), 'envelope', e.envelope_id)
    RETURNING * INTO o;
  v_signal := fleet_spend_circuit_breaker_check(o);
  IF v_signal IS NOT NULL THEN
    UPDATE fleet_payment_orders SET status = 'rejected', decided_by = 'controller', decision_code = 'FLEET_INFRASTRUCTURE_CIRCUIT_BREAKER',
           decision_reason = 'infrastructure circuit breaker: ' || v_signal WHERE order_id = o.order_id RETURNING * INTO o;
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INFRASTRUCTURE_CIRCUIT_BREAKER', 'custody', 'INFRASTRUCTURE_CIRCUIT_BREAKER', 'order', fleet_order_json(o));
  END IF;
  v_j := fleet_ledger_post('envelope_spend_reservation', 'reserve:' || o.order_id, 'controller', 'reserve envelope order', 'controller', p_agent, o.order_id,
    NULL, NULL, NULL, now(), jsonb_build_array(
      jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_reserved'), 'side', 'D', 'amount', v_amount),
      jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_envelope_cash'), 'side', 'C', 'amount', v_amount)));
  UPDATE fleet_payment_orders SET status = 'reserved', reservation_journal_id = v_j, decided_by = 'controller', decision_code = 'FLEET_ENVELOPE_CLEARED',
         decision_reason = 'within the envelope''s terms; custody checks passed' WHERE order_id = o.order_id RETURNING * INTO o;
  PERFORM fleet_event('payment_order_reserved', p_agent, 'controller', jsonb_build_object('orderId', o.order_id, 'funding', 'envelope', 'envelopeId', e.envelope_id,
    'amountCents', v_amount));
  RETURN jsonb_build_object('ok', true, 'order', fleet_order_json(o), 'envelope', fleet_envelope_json((SELECT x FROM fleet_envelopes x WHERE x.envelope_id = e.envelope_id)));
END $$;

-- Reaper (FleetController service): expiry, stop-loss and milestones for every active envelope.
CREATE FUNCTION svc_capital_reap(p_limit integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE e fleet_envelopes; n integer := 0; changed integer := 0; s text;
BEGIN
  FOR e IN SELECT * FROM fleet_envelopes WHERE status = 'active' ORDER BY expires_at LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 1000) LOOP
    s := e.status;
    e := fleet_envelope_evaluate(e.envelope_id, 'controller');
    n := n + 1;
    IF e.status <> s THEN changed := changed + 1; END IF;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'evaluated', n, 'changed', changed);
END $$;

-- ═══ 3. Sweeps from realized net profit after tax ═══
CREATE TABLE fleet_sweep_policy (
  id               smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled          boolean     NOT NULL DEFAULT false,
  population_bands jsonb       NOT NULL DEFAULT '[{"maxAgents":10,"rateBp":1000},{"maxAgents":20,"rateBp":1250},{"maxAgents":30,"rateBp":1500},{"maxAgents":40,"rateBp":1750},{"maxAgents":49,"rateBp":2000}]',
  mature_fleet_bp  integer     NOT NULL DEFAULT 4500 CHECK (mature_fleet_bp BETWEEN 0 AND 7000),
  max_bp           integer     NOT NULL DEFAULT 7000 CHECK (max_bp BETWEEN 0 AND 7000),
  maturity_days    integer     NOT NULL DEFAULT 180 CHECK (maturity_days BETWEEN 1 AND 3650),
  surplus_multiple integer     NOT NULL DEFAULT 4 CHECK (surplus_multiple BETWEEN 2 AND 100),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       text        NOT NULL DEFAULT 'migration',
  CHECK (mature_fleet_bp <= max_bp)
);
INSERT INTO fleet_sweep_policy (id) VALUES (1);
COMMENT ON TABLE fleet_sweep_policy IS 'Treasury sweep curve (configurable, bp). Applies to realized net profit after tax only; agents cannot set their rate. Disabled until an operator activates it.';
CREATE TRIGGER fleet_sweep_policy_no_delete BEFORE DELETE ON fleet_sweep_policy FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_sweep_policy_no_truncate BEFORE TRUNCATE ON fleet_sweep_policy FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION fleet_admin_sweep_policy_set(p_enabled boolean, p_bands jsonb, p_mature_bp integer, p_max_bp integer, p_maturity_days integer, p_surplus_multiple integer, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_sweep_policy; b jsonb; v_prev integer := 0;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');
  IF p_bands IS NOT NULL THEN
    FOR b IN SELECT x FROM jsonb_array_elements(p_bands) x LOOP
      IF (b ->> 'maxAgents')::integer <= v_prev OR (b ->> 'maxAgents')::integer >= 50 OR (b ->> 'rateBp')::integer NOT BETWEEN 0 AND COALESCE(p_max_bp, 7000) THEN
        RAISE EXCEPTION 'FLEET_BAD_REQUEST: bands increase, stay below 50 agents and within the maximum rate';
      END IF;
      v_prev := (b ->> 'maxAgents')::integer;
    END LOOP;
  END IF;
  UPDATE fleet_sweep_policy SET enabled = COALESCE(p_enabled, enabled), population_bands = COALESCE(p_bands, population_bands),
         mature_fleet_bp = COALESCE(p_mature_bp, mature_fleet_bp), max_bp = COALESCE(p_max_bp, max_bp), maturity_days = COALESCE(p_maturity_days, maturity_days),
         surplus_multiple = COALESCE(p_surplus_multiple, surplus_multiple), updated_at = now(), updated_by = p_actor
   WHERE id = 1 RETURNING * INTO r;
  PERFORM fleet_event('sweep_policy_set', NULL, p_actor, to_jsonb(r) - 'id');
  RETURN to_jsonb(r) - 'id';
END $$;

-- The sweep for one agent, with its full derivation (integer basis points; nothing posted).
CREATE FUNCTION fleet_sweep_compute(p_agent text) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_sweep_policy; eco jsonb; s jsonb; v_living integer; v_base_bp integer; v_age_days integer; v_mat_bp integer; v_surplus_bp integer; v_protected bigint;
        v_avail bigint; v_uplift integer; v_red integer; v_rate integer; v_profit bigint; v_tax bigint; v_basis bigint; v_amount bigint; b jsonb;
BEGIN
  SELECT * INTO p FROM fleet_sweep_policy WHERE id = 1;
  eco := fleet_agent_economics(p_agent);
  s := fleet_safe_transfer_amount(p_agent);
  SELECT living_agents INTO v_living FROM fleet_state WHERE id = 1;
  v_base_bp := p.mature_fleet_bp;
  IF v_living < 50 THEN
    FOR b IN SELECT x FROM jsonb_array_elements(p.population_bands) x ORDER BY (x ->> 'maxAgents')::integer LOOP
      IF v_living <= (b ->> 'maxAgents')::integer THEN v_base_bp := (b ->> 'rateBp')::integer; EXIT; END IF;
    END LOOP;
  END IF;
  v_base_bp := LEAST(v_base_bp, p.max_bp);
  SELECT floor(extract(epoch FROM now() - created_at) / 86400)::integer INTO v_age_days FROM fleet_agents WHERE agent_id = p_agent;
  v_mat_bp := LEAST(10000, GREATEST(0, v_age_days) * 10000 / p.maturity_days);
  -- Surplus intensity: how far available capital exceeds what is protected (needs, commitments, cushion, growth).
  v_avail := (s ->> 'availableMinor')::bigint;
  v_protected := v_avail - (s ->> 'safeTransferableMinor')::bigint;
  v_surplus_bp := CASE WHEN v_protected <= 0 THEN CASE WHEN v_avail > 0 THEN 10000 ELSE 0 END
                       ELSE LEAST(10000, GREATEST(0, ((v_avail * 10000 / v_protected) - 10000) / (p.surplus_multiple - 1))) END;
  v_uplift := ((p.max_bp - v_base_bp)::bigint * v_mat_bp / 10000 * v_surplus_bp / 10000)::integer;
  SELECT COALESCE(max(sweep_reduction_bp), 0) INTO v_red FROM fleet_envelopes WHERE agent_id = p_agent AND status = 'active';
  v_rate := LEAST(p.max_bp, v_base_bp + v_uplift);
  v_rate := (v_rate::bigint * (10000 - v_red) / 10000)::integer;
  -- Realized net profit AFTER TAX not yet contributed: never gross revenue.
  v_tax := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_tax_reserve')) + fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_tax_expense'));
  v_profit := GREATEST(0, (eco ->> 'realizedNetProfit')::bigint - (eco ->> 'lifetimeContribution')::bigint - v_tax);
  v_basis := LEAST(v_profit, (s ->> 'safeTransferableMinor')::bigint);
  v_amount := (v_basis * v_rate) / 10000;
  RETURN jsonb_build_object('enabled', p.enabled, 'amountMinor', v_amount, 'rateBp', v_rate, 'baseBp', v_base_bp, 'maturityBp', v_mat_bp, 'surplusBp', v_surplus_bp,
    'upliftBp', v_uplift, 'reinvestmentReductionBp', v_red, 'afterTaxUncontributedProfitMinor', v_profit, 'safeTransferableMinor', (s ->> 'safeTransferableMinor')::bigint,
    'basisMinor', v_basis, 'livingAgents', v_living);
END $$;

CREATE FUNCTION fleet_sweep_execute(p_agent text, p_actor text, p_idem text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c jsonb; v_j uuid;
BEGIN
  IF p_idem IS NULL OR p_idem !~ '^[A-Za-z0-9:_.-]{8,128}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: idempotency key required'; END IF;
  IF EXISTS (SELECT 1 FROM fleet_ledger_journal WHERE idempotency_key = p_idem) THEN
    RETURN jsonb_build_object('ok', true, 'replay', true, 'journalId', (SELECT journal_id FROM fleet_ledger_journal WHERE idempotency_key = p_idem));
  END IF;
  PERFORM 1 FROM fleet_ledger_accounts WHERE account_id = fleet_ledger_account(p_agent, 'agent_cash') FOR UPDATE;
  c := fleet_sweep_compute(p_agent);
  IF NOT (c ->> 'enabled')::boolean THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_SWEEP_DISABLED', 'computed', c); END IF;
  IF (c ->> 'amountMinor')::bigint <= 0 THEN RETURN jsonb_build_object('ok', true, 'amountMinor', 0, 'computed', c); END IF;
  -- The v10 LFC function enforces: realized, uncontributed net profit only; survival equity never breached.
  v_j := fleet_profit_contribution(p_agent, (c ->> 'amountMinor')::bigint, p_actor, 'controller', p_idem);
  PERFORM fleet_event('treasury_sweep', p_agent, p_actor, jsonb_build_object('journalId', v_j) || (c - 'enabled'));
  RETURN jsonb_build_object('ok', true, 'amountMinor', (c ->> 'amountMinor')::bigint, 'journalId', v_j, 'computed', c);
END $$;

-- FleetController's periodic run (only when the operator has enabled sweeps).
CREATE FUNCTION svc_sweep_run(p_period text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a record; r jsonb; n integer := 0; total bigint := 0;
BEGIN
  IF NOT (SELECT enabled FROM fleet_sweep_policy WHERE id = 1) THEN RETURN jsonb_build_object('ok', true, 'enabled', false); END IF;
  IF p_period IS NULL OR p_period !~ '^[0-9]{4}-[0-9]{2}(-[0-9]{2})?$' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  FOR a IN SELECT agent_id FROM fleet_agents WHERE status = 'active' AND operator_hold_at IS NULL ORDER BY agent_id LOOP
    r := fleet_sweep_execute(a.agent_id, 'controller', 'sweep:' || p_period || ':' || a.agent_id);
    IF (r ->> 'ok')::boolean AND COALESCE((r ->> 'amountMinor')::bigint, 0) > 0 THEN n := n + 1; total := total + (r ->> 'amountMinor')::bigint; END IF;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'enabled', true, 'swept', n, 'totalMinor', total);
END $$;

-- FleetController's periodic tax true-up for every active agent with settled sales (the reserve follows the liability).
CREATE FUNCTION svc_tax_true_up(p_limit integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a record; r jsonb; n integer := 0; moved bigint := 0; short bigint := 0;
BEGIN
  FOR a IN SELECT DISTINCT t.agent_id FROM fleet_external_transactions t JOIN fleet_agents ag ON ag.agent_id = t.agent_id
            WHERE t.status = 'settled' AND ag.status = 'active' ORDER BY t.agent_id LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 1000) LOOP
    r := fleet_tax_true_up(a.agent_id, 'controller');
    n := n + 1;
    moved := moved + COALESCE((r ->> 'movedMinor')::bigint, 0);
    short := short + COALESCE((r ->> 'shortfallMinor')::bigint, 0);
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'agents', n, 'movedMinor', moved, 'shortfallMinor', short);
END $$;

-- ═══ 4. Cognition depth: relative, never a fixed amount (retires the £20 major-spend line) ═══
CREATE TABLE fleet_cognition_depth_policy (
  id                smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  major_exposure_bp integer     NOT NULL DEFAULT 2500 CHECK (major_exposure_bp BETWEEN 1 AND 10000),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        text        NOT NULL DEFAULT 'migration'
);
INSERT INTO fleet_cognition_depth_policy (id) VALUES (1);
COMMENT ON TABLE fleet_cognition_depth_policy IS 'A spend is a major action (critical-tier cognition) when it exposes at least major_exposure_bp of the founder''s own available capital. Relative: a 500 and a 500 000 wallet are treated proportionally.';
CREATE TRIGGER fleet_cognition_depth_policy_no_delete BEFORE DELETE ON fleet_cognition_depth_policy FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_cognition_depth_policy_no_truncate BEFORE TRUNCATE ON fleet_cognition_depth_policy FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
COMMENT ON COLUMN fleet_cognition_routing.major_spend_threshold_minor IS 'LEGACY (retired at v30): no decision reads it; the major-spend classification is relative (fleet_cognition_depth_policy).';

CREATE FUNCTION fleet_spend_is_major(p_agent text, p_amount bigint) RETURNS boolean LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT CASE WHEN COALESCE((fleet_agent_economics(p_agent) ->> 'expensePurchasingCapacity')::bigint, 0) <= 0 THEN true
              ELSE COALESCE(p_amount, 0)::numeric * 10000 >= (fleet_agent_economics(p_agent) ->> 'expensePurchasingCapacity')::numeric
                     * (SELECT major_exposure_bp FROM fleet_cognition_depth_policy WHERE id = 1) END
$$;

CREATE OR REPLACE FUNCTION svc_action_cognition_verify(p_agent text, p_action_class text, p_amount_minor bigint, p_tool_call_id text, p_action_sha256 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE rt fleet_cognition_routing; v_class text := p_action_class; v_min text; l fleet_cognition_log;
BEGIN
  IF NOT fleet_routing_active(p_agent) THEN RETURN jsonb_build_object('ok', true, 'enforced', false); END IF;
  SELECT * INTO rt FROM fleet_cognition_routing WHERE id = 1;
  -- v30: relative exposure of the founder's own available capital, never a fixed amount.
  IF v_class = 'spend_request' AND fleet_spend_is_major(p_agent, p_amount_minor) THEN v_class := 'major_spend_request'; END IF;
  SELECT min_tier INTO v_min FROM fleet_action_min_tier WHERE action_class = v_class;
  IF v_min IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ACTION_CLASS_UNKNOWN'); END IF;
  IF p_tool_call_id IS NULL OR p_tool_call_id !~ '^[A-Za-z0-9_.:-]{1,64}$' OR p_action_sha256 IS NULL OR p_action_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ACTION_COGNITION_MISSING', 'actionClass', v_class, 'minTier', v_min);
  END IF;
  SELECT * INTO l FROM fleet_cognition_log
   WHERE agent_id = p_agent AND outcome = 'ok' AND tier IS NOT NULL
     AND at > now() - make_interval(secs => rt.action_link_window_s)
     AND tool_calls @> jsonb_build_array(jsonb_build_object('id', p_tool_call_id, 'actionSha256', p_action_sha256))
   ORDER BY seq DESC LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ACTION_COGNITION_MISSING', 'actionClass', v_class, 'minTier', v_min); END IF;
  IF array_position(ARRAY['T1','T2','T3'], l.tier) < array_position(ARRAY['T1','T2','T3'], v_min) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ACTION_COGNITION_TIER', 'actionClass', v_class, 'minTier', v_min, 'tier', l.tier, 'requestId', l.request_id);
  END IF;
  IF EXISTS (SELECT 1 FROM fleet_action_cognition_links WHERE request_id = l.request_id AND tool_call_id = p_tool_call_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ACTION_COGNITION_REUSED', 'actionClass', v_class);
  END IF;
  INSERT INTO fleet_action_cognition_links (request_id, tool_call_id, agent_id, action_class, action_sha256, tier)
    VALUES (l.request_id, p_tool_call_id, p_agent, v_class, p_action_sha256, l.tier);
  RETURN jsonb_build_object('ok', true, 'enforced', true, 'actionClass', v_class, 'minTier', v_min, 'tier', l.tier, 'requestId', l.request_id);
END $$;

-- ═══ 5. Experiments: no owner branch, no nominal ladder caps (own capital: custody headroom bounds the budget) ═══
COMMENT ON COLUMN fleet_experiment_policy.hard_cap_minor IS 'LEGACY (retired at v30): no decision reads it; an own-capital experiment is bounded by its survival headroom.';
COMMENT ON COLUMN fleet_evidence_ladder.auto_cap_minor IS 'LEGACY (retired at v30): evidence levels are recorded as information; no nominal cap and no owner level remain.';
CREATE OR REPLACE FUNCTION fleet_experiment_evaluate(e fleet_experiments) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE eco jsonb; v_committed bigint; v_head bigint; v_amt bigint; v_loss bigint; rel jsonb;
BEGIN
  -- The controller decides on a complete relevance record only (automated assessment; never an owner step).
  rel := fleet_experiment_relevant_evidence(e.experiment_id, e.verified_evidence);
  IF (rel ->> 'unassessed')::integer > 0 THEN
    RETURN jsonb_build_object('decision', 'watch', 'code', 'FLEET_RELEVANCE_PENDING',
      'reason', format('awaiting the controller''s automated relevance assessment of %s of %s provenance-verified item(s) (claimed E%s)',
        rel ->> 'unassessed', rel ->> 'verified', e.claimed_level));
  END IF;
  IF (rel ->> 'uncertain')::integer > 0 THEN
    RETURN jsonb_build_object('decision', 'watch', 'code', 'FLEET_EVIDENCE_UNCERTAIN',
      'reason', format('%s of %s cited item(s) assessed uncertain (ambiguous, conflicting or unverifiable); relevant %s: cite clearer evidence (claimed E%s)',
        rel ->> 'uncertain', rel ->> 'verified', rel ->> 'relevant', e.claimed_level));
  END IF;
  IF e.verified_level = 0 THEN
    RETURN jsonb_build_object('decision', 'watch', 'code', 'FLEET_EVIDENCE_INSUFFICIENT',
      'reason', format('no relevant verified evidence yet (claimed E%s, verified E0): cite evidence for the hypothesis', e.claimed_level));
  END IF;
  -- Custody: never more than the founder could lose without touching protected capital (survival headroom), net of the
  -- maximum loss other active experiments already commit. No nominal cap; no owner level.
  eco := fleet_agent_economics(e.agent_id);
  SELECT COALESCE(sum(COALESCE(approved_max_loss_minor, 0)), 0) INTO v_committed
    FROM fleet_experiments WHERE agent_id = e.agent_id AND status IN ('approved','partially_approved','running') AND experiment_id <> e.experiment_id;
  v_head := GREATEST(0, COALESCE((eco ->> 'expensePurchasingCapacity')::bigint, 0) - v_committed);
  IF e.max_loss_minor > 0 AND v_head = 0 THEN
    RETURN jsonb_build_object('decision', 'rejected', 'code', 'FLEET_PROTECTED_CAPITAL', 'reason', 'no headroom above protected capital and committed experiments');
  END IF;
  v_amt := LEAST(e.requested_minor, v_head);
  -- Irreversible: a stronger execution boundary (the whole budget counts as maximum loss), never an owner decision.
  v_loss := CASE WHEN e.reversibility = 'irreversible' THEN v_amt ELSE LEAST(e.max_loss_minor, v_amt) END;
  IF v_amt < e.requested_minor OR v_loss < e.max_loss_minor THEN
    RETURN jsonb_build_object('decision', 'partially_approved', 'code', 'FLEET_EXPERIMENT_PARTIAL', 'approvedMinor', v_amt, 'maxLossMinor', v_loss,
      'reason', format('E%s; survival headroom %s: budget %s of %s, maximum loss %s%s', e.verified_level, v_head, v_amt, e.requested_minor, v_loss,
        CASE WHEN e.reversibility = 'irreversible' THEN ' (irreversible: the whole budget is at risk — reason carefully)' ELSE '' END));
  END IF;
  RETURN jsonb_build_object('decision', 'approved', 'code', 'FLEET_EXPERIMENT_APPROVED', 'approvedMinor', e.requested_minor, 'maxLossMinor', v_loss,
    'reason', format('E%s within survival headroom %s%s', e.verified_level, v_head,
      CASE WHEN e.reversibility = 'irreversible' THEN ' (irreversible: the whole budget is at risk — reason carefully)' ELSE '' END));
END $$;

-- A compact economic brief for one task packet (figures only; drill down with the economy tools).
CREATE FUNCTION fleet_economy_brief(p_agent text) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  -- MATERIALIZED: computed once (an inlined CTE would re-run the wallet for every field it feeds).
  WITH w AS MATERIALIZED (SELECT fleet_agent_wallet(p_agent) AS w)
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'availableMinor', (w ->> 'availableMinor')::bigint, 'taxReserveMinor', (w ->> 'taxReserveMinor')::bigint,
    'envelopeCapitalMinor', (w #>> '{restricted,envelopeCapitalMinor}')::bigint, 'burnPerDayMinor', (w #>> '{runway,burnPerDayMinor}')::bigint,
    'revenue30dMinor', (w #>> '{last30d,revenueMinor}')::bigint,
    'ventures', (SELECT jsonb_agg(jsonb_build_object('key', v.venture_key, 'state', v.state, 'netMinor', (fleet_venture_financials(v.venture_id) ->> 'netProfitMinor')::bigint)
                                  ORDER BY v.updated_at DESC) FROM (SELECT * FROM fleet_ventures WHERE agent_id = p_agent AND state NOT IN ('closed') ORDER BY updated_at DESC LIMIT 6) v),
    'shortlist', (SELECT jsonb_agg(o.opportunity_key ORDER BY o.agent_rank) FROM fleet_opportunities o WHERE o.agent_id = p_agent AND o.status = 'shortlisted'),
    'pendingOutcomes', (SELECT count(*) FROM (SELECT DISTINCT ON (decision_key) outcome_status FROM fleet_decision_records WHERE agent_id = p_agent
                         ORDER BY decision_key, revision DESC) d WHERE outcome_status = 'pending'),
    'activeEnvelopes', (SELECT count(*) FROM fleet_envelopes WHERE agent_id = p_agent AND status = 'active')))
  FROM w
$$;

-- ═══ 6. api_economy: capital requests and envelope operations ═══
CREATE OR REPLACE FUNCTION api_economy(p_agent text, p_token text, p_op text, p_args jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text; v_class text; a jsonb := COALESCE(p_args, '{}'::jsonb);
BEGIN
  v_class := CASE p_op
    WHEN 'opportunity.record' THEN 'planning' WHEN 'opportunity.shortlist' THEN 'planning' WHEN 'opportunity.status' THEN 'planning'
    WHEN 'opportunity.list' THEN 'planning'
    WHEN 'venture.create' THEN 'planning' WHEN 'venture.transition' THEN 'planning' WHEN 'venture.status' THEN 'planning'
    WHEN 'venture.list' THEN 'planning' WHEN 'venture.metric' THEN 'planning'
    WHEN 'decision.record' THEN 'planning' WHEN 'decision.outcome' THEN 'planning' WHEN 'decision.correct' THEN 'planning'
    WHEN 'decision.list' THEN 'planning'
    WHEN 'knowledge.record' THEN 'planning' WHEN 'knowledge.search' THEN 'knowledge.read'
    WHEN 'performance' THEN 'ledger.read'
    WHEN 'wallet' THEN 'ledger.read' WHEN 'wallet.plan' THEN 'ledger.read'
    WHEN 'rail.require' THEN 'spend.request' WHEN 'vendor.register' THEN 'spend.request' WHEN 'vendor.revoke' THEN 'spend.request'
    WHEN 'vendor.list' THEN 'spend.request'
    WHEN 'capital.request' THEN 'spend.request' WHEN 'capital.list' THEN 'ledger.read'
    WHEN 'envelope.spend' THEN 'spend.request' WHEN 'envelope.list' THEN 'ledger.read'
    WHEN 'brief' THEN 'ledger.read'
  END;
  IF v_class IS NULL OR p_op IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_UNKNOWN_OPERATION'); END IF;
  v_code := fleet_authenticate(p_agent, p_token, 'economy:' || p_op);
  IF v_code IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code)
      || CASE WHEN fleet_custody_refusal(v_code) IS NOT NULL AND p_op = 'envelope.spend' THEN jsonb_build_object('custody', fleet_custody_refusal(v_code)) ELSE '{}'::jsonb END;
  END IF;
  IF NOT fleet_agent_can(p_agent, v_class) THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CAPABILITY_DENIED'); END IF;
  IF jsonb_typeof(a) <> 'object' OR length(a::text) > 32000 THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'arguments are a JSON object (<= 32 kB)'); END IF;
  BEGIN
    RETURN CASE p_op
      WHEN 'opportunity.record' THEN fleet_econ_opportunity_record(p_agent, a)
      WHEN 'opportunity.shortlist' THEN fleet_econ_opportunity_shortlist(p_agent, a)
      WHEN 'opportunity.status' THEN fleet_econ_opportunity_status(p_agent, a)
      WHEN 'opportunity.list' THEN fleet_econ_opportunity_list(p_agent, a)
      WHEN 'venture.create' THEN fleet_econ_venture_create(p_agent, a)
      WHEN 'venture.transition' THEN fleet_econ_venture_transition(p_agent, a)
      WHEN 'venture.status' THEN (SELECT CASE WHEN v.venture_id IS NULL THEN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND')
                                              ELSE jsonb_build_object('ok', true, 'venture', fleet_venture_json(v, true)) END
                                    FROM (SELECT 1) one LEFT JOIN fleet_ventures v ON v.agent_id = p_agent AND v.venture_key = fleet_econ_key(a, 'key'))
      WHEN 'venture.list' THEN jsonb_build_object('ok', true, 'ventures', COALESCE((SELECT jsonb_agg(fleet_venture_json(v) ORDER BY v.updated_at DESC)
                                 FROM fleet_ventures v WHERE v.agent_id = p_agent AND (COALESCE((a ->> 'includeClosed')::boolean, false) OR v.state NOT IN ('closed'))), '[]'::jsonb))
      WHEN 'venture.metric' THEN fleet_econ_venture_metric(p_agent, a)
      WHEN 'decision.record' THEN fleet_econ_decision_record(p_agent, a)
      WHEN 'decision.outcome' THEN fleet_econ_decision_outcome(p_agent, a)
      WHEN 'decision.correct' THEN fleet_econ_decision_correct(p_agent, a)
      WHEN 'decision.list' THEN fleet_econ_decision_list(p_agent, a)
      WHEN 'knowledge.record' THEN fleet_econ_knowledge_record(p_agent, a)
      WHEN 'knowledge.search' THEN fleet_econ_knowledge_search(p_agent, a)
      WHEN 'performance' THEN jsonb_build_object('ok', true, 'performance', fleet_agent_performance(p_agent))
      WHEN 'wallet' THEN jsonb_build_object('ok', true, 'wallet', fleet_agent_wallet(p_agent))
      WHEN 'wallet.plan' THEN fleet_econ_wallet_plan(p_agent, a)
      WHEN 'rail.require' THEN fleet_econ_rail_require(p_agent, a)
      WHEN 'vendor.register' THEN fleet_econ_vendor_register(p_agent, a)
      WHEN 'vendor.revoke' THEN fleet_econ_vendor_revoke(p_agent, a)
      WHEN 'vendor.list' THEN jsonb_build_object('ok', true, 'vendors', COALESCE((SELECT jsonb_agg(jsonb_build_object('destinationId', v.destination_id,
                                 'vendor', v.vendor_name, 'category', v.category, 'status', d.status, 'trust', v.trust, 'hint', d.reference_hint) ORDER BY v.registered_at DESC)
                                 FROM fleet_vendor_destinations v JOIN fleet_payment_destinations d ON d.destination_id = v.destination_id
                                WHERE v.agent_id = p_agent AND d.status <> 'revoked'), '[]'::jsonb))
      WHEN 'capital.request' THEN fleet_econ_capital_request(p_agent, a)
      WHEN 'capital.list' THEN jsonb_build_object('ok', true, 'requests', COALESCE((SELECT jsonb_agg(jsonb_build_object('purpose', q.purpose, 'amountMinor', q.amount_minor,
                                 'venture', (SELECT venture_key FROM fleet_ventures WHERE venture_id = q.venture_id), 'outcome', d.outcome, 'approvedMinor', d.approved_minor,
                                 'reasons', d.reasons, 'wouldChange', d.would_change, 'at', q.created_at) ORDER BY q.created_at DESC)
                                 FROM fleet_capital_requests q JOIN fleet_capital_decisions d ON d.request_id = q.request_id WHERE q.agent_id = p_agent), '[]'::jsonb))
      WHEN 'brief' THEN jsonb_build_object('ok', true, 'brief', fleet_economy_brief(p_agent))
      WHEN 'envelope.spend' THEN fleet_econ_envelope_spend(p_agent, a)
      WHEN 'envelope.list' THEN jsonb_build_object('ok', true, 'envelopes', COALESCE((SELECT jsonb_agg(fleet_envelope_json(e) ORDER BY e.created_at DESC)
                                 FROM fleet_envelopes e WHERE e.agent_id = p_agent AND (COALESCE((a ->> 'all')::boolean, false) OR e.status = 'active')), '[]'::jsonb))
    END;
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM ~ '^FLEET_(BAD_REQUEST|INFRASTRUCTURE_CEILING|VENTURE_[A-Z]+|IMMUTABLE|INVALID_STATE|ATTRIBUTION_SCOPE):' THEN
        IF SQLERRM ~ '^FLEET_INFRASTRUCTURE_CEILING:' THEN
          PERFORM fleet_event('economy_failsafe', p_agent, 'controller', jsonb_build_object('op', p_op));
        END IF;
        RETURN jsonb_build_object('ok', false, 'code', split_part(SQLERRM, ':', 1), 'reason', btrim(substr(SQLERRM, position(':' IN SQLERRM) + 1)));
      END IF;
      RAISE;
    WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'a value has the wrong format');
  END;
END $$;

-- Owner setters for the remaining configurable policies (audited; one writer each).
CREATE FUNCTION fleet_admin_cognition_depth_set(p_major_exposure_bp integer, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_cognition_depth_policy;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  UPDATE fleet_cognition_depth_policy SET major_exposure_bp = p_major_exposure_bp, updated_at = now(), updated_by = p_actor WHERE id = 1 RETURNING * INTO r;
  PERFORM fleet_event('cognition_depth_set', NULL, p_actor, to_jsonb(r) - 'id');
  RETURN to_jsonb(r) - 'id';
END $$;
CREATE FUNCTION fleet_admin_transfer_policy_set(p_cushion_bp integer, p_horizon_days integer, p_burn_window_days integer, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_transfer_policy;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  UPDATE fleet_transfer_policy SET cushion_bp = COALESCE(p_cushion_bp, cushion_bp), horizon_days = COALESCE(p_horizon_days, horizon_days),
         burn_window_days = COALESCE(p_burn_window_days, burn_window_days), updated_at = now(), updated_by = p_actor WHERE id = 1 RETURNING * INTO r;
  PERFORM fleet_event('transfer_policy_set', NULL, p_actor, to_jsonb(r) - 'id');
  RETURN to_jsonb(r) - 'id';
END $$;
CREATE FUNCTION fleet_admin_tax_policy_set(p_unprofiled_reserve_bp integer, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_tax_policy;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  UPDATE fleet_tax_policy SET unprofiled_reserve_bp = p_unprofiled_reserve_bp, updated_at = now(), updated_by = p_actor WHERE id = 1 RETURNING * INTO r;
  PERFORM fleet_event('tax_policy_set', NULL, p_actor, to_jsonb(r) - 'id');
  RETURN to_jsonb(r) - 'id';
END $$;

-- ═══ 7. Hub (owner/admin views; read-only) ═══
CREATE FUNCTION fleet_hub(p_section text, p_args jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a jsonb := COALESCE(p_args, '{}'::jsonb); v_agent text := a ->> 'agentId';
BEGIN
  RETURN CASE p_section
    WHEN 'overview' THEN (
      WITH ws AS MATERIALIZED (SELECT fleet_agent_wallet(ag.agent_id) AS w FROM fleet_agents ag
                   WHERE ag.status NOT IN ('dead','failed') AND EXISTS (SELECT 1 FROM fleet_ledger_accounts x WHERE x.agent_id = ag.agent_id))
      SELECT jsonb_build_object(
        'currency', (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1),
        'externalCashHeldMinor', fleet_ledger_balance('fleet:treasury:unallocated') + fleet_ledger_balance('fleet:operating:pool')
                                 + COALESCE((SELECT sum((w ->> 'cashHeldMinor')::bigint) FROM ws), 0),
        'economicEquityMinor', COALESCE((SELECT sum((w ->> 'economicBalanceMinor')::bigint) FROM ws), 0),
        'spendableCapitalMinor', COALESCE((SELECT sum((w ->> 'availableMinor')::bigint) FROM ws), 0),
        'treasuryMinor', fleet_ledger_balance('fleet:treasury:unallocated'), 'operatingPoolMinor', fleet_ledger_balance('fleet:operating:pool'),
        'taxReservesMinor', COALESCE((SELECT sum((w ->> 'taxReserveMinor')::bigint) FROM ws), 0),
        'totalRevenueMinor', COALESCE((SELECT sum((w #>> '{lifetime,revenueMinor}')::bigint) FROM ws), 0),
        'netProfitMinor', COALESCE((SELECT sum((w #>> '{lifetime,netProfitMinor}')::bigint) FROM ws), 0),
        'lifetimeContributionMinor', fleet_ledger_balance('fleet:profit'),
        'activeVentures', (SELECT count(*) FROM fleet_ventures WHERE state NOT IN ('failed','closed')),
        'agents', (SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*) AS n FROM fleet_agents GROUP BY status) s),
        'openDependencies', (SELECT count(*) FROM fleet_owner_requests WHERE status = 'pending'),
        'sweepsEnabled', (SELECT enabled FROM fleet_sweep_policy WHERE id = 1), 'capitalEngineEnabled', (SELECT enabled FROM fleet_capital_policy WHERE id = 1)))
    WHEN 'agents' THEN (SELECT COALESCE(jsonb_agg(jsonb_build_object('agentId', ag.agent_id, 'name', ag.name, 'status', ag.status, 'wallet', fleet_agent_wallet(ag.agent_id),
        'performance', fleet_agent_performance(ag.agent_id)) ORDER BY ag.created_at), '[]'::jsonb)
        FROM fleet_agents ag WHERE EXISTS (SELECT 1 FROM fleet_ledger_accounts x WHERE x.agent_id = ag.agent_id))
    WHEN 'wallet' THEN jsonb_build_object('wallet', fleet_agent_wallet(v_agent), 'history', (SELECT COALESCE(jsonb_agg(h ORDER BY (h ->> 'seq')::bigint DESC), '[]'::jsonb) FROM (
        SELECT jsonb_build_object('seq', j.seq, 'kind', j.kind, 'at', j.occurred_at, 'reason', j.reason, 'externalRef', j.external_ref,
          'postings', (SELECT jsonb_agg(jsonb_build_object('class', ac.class, 'side', po.side, 'amountMinor', po.amount_cents) ORDER BY po.line)
                         FROM fleet_ledger_postings po JOIN fleet_ledger_accounts ac ON ac.account_id = po.account_id WHERE po.journal_id = j.journal_id)) AS h
          FROM fleet_ledger_journal j WHERE j.agent_id = v_agent ORDER BY j.seq DESC LIMIT LEAST(COALESCE((a ->> 'limit')::integer, 50), 500)) x))
    WHEN 'ventures' THEN (SELECT COALESCE(jsonb_agg(fleet_venture_json(v, true) || jsonb_build_object('agentId', v.agent_id,
        'rails', (SELECT COALESCE(jsonb_agg(fleet_rail_json(r) || jsonb_build_object('capability', x.capability)), '[]'::jsonb) FROM fleet_rail_assignments x
                    JOIN fleet_payment_rails r ON r.rail_id = x.rail_id WHERE x.venture_id = v.venture_id AND x.released_at IS NULL),
        'decisions', (SELECT COALESCE(jsonb_agg(fleet_decision_json(d) ORDER BY d.created_at DESC), '[]'::jsonb) FROM fleet_decision_records d WHERE d.venture_id = v.venture_id))
        ORDER BY v.updated_at DESC), '[]'::jsonb) FROM fleet_ventures v WHERE v_agent IS NULL OR v.agent_id = v_agent)
    WHEN 'treasury' THEN jsonb_build_object('unallocatedMinor', fleet_ledger_balance('fleet:treasury:unallocated'),
        'operatingPoolMinor', fleet_ledger_balance('fleet:operating:pool'), 'lifetimeContributionMinor', fleet_ledger_balance('fleet:profit'),
        'outstandingEnvelopesMinor', (SELECT COALESCE(sum(allocated_minor - returned_minor), 0) FROM fleet_envelopes WHERE status IN ('active','frozen')),
        'flows30d', (SELECT COALESCE(jsonb_object_agg(kind, amt), '{}'::jsonb) FROM (SELECT j.kind, sum(CASE WHEN po.side = 'D' THEN po.amount_cents ELSE -po.amount_cents END) AS amt
              FROM fleet_ledger_postings po JOIN fleet_ledger_journal j ON j.journal_id = po.journal_id
             WHERE po.account_id = 'fleet:treasury:unallocated' AND j.occurred_at > now() - interval '30 days' GROUP BY j.kind) f),
        'sweepPolicy', (SELECT to_jsonb(s) - 'id' FROM fleet_sweep_policy s WHERE id = 1), 'capitalPolicy', (SELECT to_jsonb(c) - 'id' FROM fleet_capital_policy c WHERE id = 1))
    WHEN 'rails' THEN (SELECT COALESCE(jsonb_agg(fleet_rail_json(r) || jsonb_build_object('assignments', (SELECT count(*) FROM fleet_rail_assignments x WHERE x.rail_id = r.rail_id AND x.released_at IS NULL),
        'lastSettlementAt', r.last_settlement_at, 'healthNote', r.health_note,
        'credential', (SELECT jsonb_build_object('provider', c.provider, 'status', c.status, 'health', c.health, 'hint', c.display_hint) FROM fleet_credential_refs c WHERE c.credential_id = r.credential_id))
        ORDER BY r.created_at), '[]'::jsonb) FROM fleet_payment_rails r)
    WHEN 'tax' THEN jsonb_build_object('entities', (SELECT COALESCE(jsonb_agg(jsonb_build_object('entity', to_jsonb(e) - 'created_by', 'profile', to_jsonb(fleet_tax_profile_active(e.entity_id)) - 'created_by')), '[]'::jsonb)
          FROM fleet_legal_entities e),
        'reservesByAgent', (SELECT COALESCE(jsonb_object_agg(agent_id, jsonb_build_object('reservedMinor', fleet_ledger_balance(fleet_ledger_account(agent_id, 'agent_tax_reserve')),
          'paidMinor', fleet_ledger_balance(fleet_ledger_account(agent_id, 'agent_tax_expense')))), '{}'::jsonb)
          FROM (SELECT DISTINCT agent_id FROM fleet_ledger_accounts WHERE class = 'agent_tax_reserve') x),
        'fallbackPolicy', (SELECT to_jsonb(t) - 'id' FROM fleet_tax_policy t WHERE id = 1))
    WHEN 'capital' THEN (SELECT COALESCE(jsonb_agg(jsonb_build_object('agentId', q.agent_id, 'venture', (SELECT venture_key FROM fleet_ventures WHERE venture_id = q.venture_id),
        'purpose', q.purpose, 'amountMinor', q.amount_minor, 'expectedNetMinor', q.expected_net_minor, 'confidenceBp', q.confidence_bp, 'evidenceItems', jsonb_array_length(q.evidence),
        'outcome', d.outcome, 'approvedMinor', d.approved_minor, 'reasons', d.reasons, 'wouldChange', d.would_change, 'inputs', d.inputs, 'policyVersion', d.policy_version,
        'at', q.created_at) ORDER BY q.created_at DESC), '[]'::jsonb) FROM fleet_capital_requests q JOIN fleet_capital_decisions d ON d.request_id = q.request_id)
    WHEN 'envelopes' THEN (SELECT COALESCE(jsonb_agg(fleet_envelope_json(e) || jsonb_build_object('agentId', e.agent_id) ORDER BY e.created_at DESC), '[]'::jsonb) FROM fleet_envelopes e)
    WHEN 'opportunities' THEN (SELECT COALESCE(jsonb_agg(fleet_opportunity_json(o) || jsonb_build_object('agentId', o.agent_id) ORDER BY o.agent_id, o.agent_rank NULLS LAST, o.updated_at DESC), '[]'::jsonb)
        FROM fleet_opportunities o WHERE (v_agent IS NULL OR o.agent_id = v_agent) AND o.status IN ('candidate','shortlisted','selected','converted','rejected','invalidated'))
    WHEN 'profit' THEN (SELECT COALESCE(jsonb_agg(x ORDER BY (x #>> '{netProfitMinor}')::bigint DESC), '[]'::jsonb) FROM (
        SELECT jsonb_build_object('agentId', ag.agent_id, 'name', ag.name, 'revenueMinor', (w #>> '{lifetime,revenueMinor}')::bigint,
          'refundsMinor', (SELECT COALESCE(sum((fleet_venture_financials(v.venture_id) ->> 'refundsMinor')::bigint), 0) FROM fleet_ventures v WHERE v.agent_id = ag.agent_id),
          'costsMinor', (w #>> '{lifetime,expensesMinor}')::bigint + (w #>> '{lifetime,feesMinor}')::bigint, 'inference30dMinor', (w #>> '{last30d,inferenceMinor}')::bigint,
          'netProfitMinor', (w #>> '{lifetime,netProfitMinor}')::bigint, 'roiBp', p #>> '{realized,roiBp}', 'treasuryContributionMinor', (w ->> 'treasuryContributionsMinor')::bigint,
          'taxReserveMinor', (w ->> 'taxReserveMinor')::bigint, 'retainedMinor', (w ->> 'retainedEarningsMinor')::bigint, 'runwayDays', w #>> '{runway,days}',
          'forecast', p -> 'forecast', 'ventures', p -> 'ventures') AS x
          -- OFFSET 0 keeps the subquery from being flattened (each agent's wallet and performance are computed once).
          FROM (SELECT ag.*, fleet_agent_wallet(ag.agent_id) AS w, fleet_agent_performance(ag.agent_id) AS p FROM fleet_agents ag
                 WHERE EXISTS (SELECT 1 FROM fleet_ledger_accounts x WHERE x.agent_id = ag.agent_id) OFFSET 0) ag) y)
    WHEN 'dependencies' THEN (SELECT COALESCE(jsonb_agg(fleet_owner_request_json(r) || jsonb_build_object('agentId', r.agent_id) ORDER BY r.created_at DESC), '[]'::jsonb)
        FROM fleet_owner_requests r WHERE r.status = 'pending' OR (a ->> 'all')::boolean)
    WHEN 'credentials' THEN (SELECT COALESCE(jsonb_agg(jsonb_build_object('credentialId', c.credential_id, 'provider', c.provider, 'purpose', c.purpose, 'status', c.status,
        'health', c.health, 'hint', c.display_hint, 'scope', to_jsonb(c.scope), 'spendLimited', c.spend_limited, 'lastUsedAt', c.last_used_at, 'rotatedAt', c.rotated_at,
        'uses30d', (SELECT count(*) FROM fleet_credential_use_log u WHERE u.credential_id = c.credential_id AND u.at > now() - interval '30 days'))
        ORDER BY c.created_at), '[]'::jsonb) FROM fleet_credential_refs c)
    WHEN 'audit' THEN (SELECT COALESCE(jsonb_agg(jsonb_build_object('at', e.created_at, 'type', e.event_type, 'agentId', e.agent_id, 'actor', e.actor, 'detail', e.detail) ORDER BY e.id DESC), '[]'::jsonb)
        FROM (SELECT * FROM fleet_events WHERE event_type ~ '^(settlement|tax|wallet|capital|envelope|treasury_sweep|payment_rail|credential|vendor|legal_entity|economy_policy|sweep_policy|spend_circuit|payment_order|venture_attribution)'
              ORDER BY id DESC LIMIT LEAST(COALESCE((a ->> 'limit')::integer, 100), 1000)) e)
    WHEN 'reconcile' THEN fleet_reconcile()
    ELSE jsonb_build_object('error', 'unknown section', 'sections', jsonb_build_array('overview','agents','wallet','ventures','treasury','rails','tax','capital',
           'envelopes','opportunities','profit','dependencies','credentials','audit','reconcile'))
  END;
END $$;

-- ═══ 8. Doctor: economy health (INFO / WARN / FAIL). Agent autonomy itself is never an error. ═══
CREATE FUNCTION fleet_economy_health() RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE f jsonb := '[]'::jsonb; rec jsonb; n bigint; p fleet_economy_policy; x jsonb;
BEGIN
  SELECT * INTO p FROM fleet_economy_policy WHERE id = 1;
  rec := fleet_reconcile();
  FOR x IN SELECT y FROM jsonb_array_elements(rec -> 'findings') y LOOP
    IF x ->> 'code' NOT IN ('TREASURY') THEN f := f || jsonb_build_array(x); END IF;
  END LOOP;
  -- Expired envelopes still marked active (the reaper is behind).
  SELECT count(*) INTO n FROM fleet_envelopes WHERE status = 'active' AND expires_at < now() - interval '1 hour';
  IF n > 0 THEN f := f || jsonb_build_array(jsonb_build_object('severity', 'WARN', 'code', 'ENVELOPES_EXPIRED_UNREAPED', 'detail', jsonb_build_object('count', n))); END IF;
  -- Envelope cash on the ledger equals the envelopes' positions.
  SELECT count(*) INTO n FROM (SELECT e.agent_id, sum((fleet_envelope_position(e) ->> 'availableMinor')::bigint) AS pos FROM fleet_envelopes e WHERE status IN ('active','frozen') GROUP BY e.agent_id) s
   WHERE s.pos <> fleet_ledger_balance(fleet_ledger_account(s.agent_id, 'agent_envelope_cash'));
  f := f || jsonb_build_array(jsonb_build_object('severity', CASE WHEN n = 0 THEN 'INFO' ELSE 'FAIL' END, 'code', 'ENVELOPE_LEDGER', 'detail', jsonb_build_object('mismatchedAgents', n)));
  -- Rails without credential health information, or degraded.
  SELECT count(*) INTO n FROM fleet_payment_rails WHERE status = 'degraded';
  IF n > 0 THEN f := f || jsonb_build_array(jsonb_build_object('severity', 'WARN', 'code', 'RAILS_DEGRADED', 'detail', jsonb_build_object('count', n))); END IF;
  SELECT count(*) INTO n FROM fleet_credential_refs WHERE status IN ('active','rotating') AND health = 'failing';
  IF n > 0 THEN f := f || jsonb_build_array(jsonb_build_object('severity', 'FAIL', 'code', 'CREDENTIALS_FAILING', 'detail', jsonb_build_object('count', n))); END IF;
  -- Action-dependency violation: an open dependency that is not an exception scoped to one action (the CHECK makes this impossible; verified).
  SELECT count(*) INTO n FROM fleet_owner_requests WHERE status = 'pending' AND NOT (blocks_action AND kind IN ('human_identity','kyc','legal_signature','constitutional_change','non_delegable_credential'));
  f := f || jsonb_build_array(jsonb_build_object('severity', CASE WHEN n = 0 THEN 'INFO' ELSE 'FAIL' END, 'code', 'DEPENDENCIES_ACTION_SCOPED', 'detail', jsonb_build_object('violations', n,
    'open', (SELECT count(*) FROM fleet_owner_requests WHERE status = 'pending'))));
  -- Research loops: many research fetches in the window and no decision resolved or recorded (a liveness signal, never a quota).
  SELECT count(*) INTO n FROM (SELECT ra.agent_id FROM fleet_research_attempts ra WHERE ra.created_at > now() - make_interval(hours => p.research_loop_window_h)
     GROUP BY ra.agent_id HAVING count(*) >= p.research_loop_fetches
        AND NOT EXISTS (SELECT 1 FROM fleet_decision_records d WHERE d.agent_id = ra.agent_id AND d.created_at > now() - make_interval(hours => p.research_loop_window_h))) z;
  IF n > 0 THEN f := f || jsonb_build_array(jsonb_build_object('severity', 'WARN', 'code', 'RESEARCH_WITHOUT_DECISION', 'detail', jsonb_build_object('agents', n))); END IF;
  -- Stale opportunity evidence on shortlists.
  SELECT count(*) INTO n FROM fleet_opportunities WHERE status = 'shortlisted' AND COALESCE(evidence_at, created_at) < now() - make_interval(days => p.evidence_fresh_days);
  IF n > 0 THEN f := f || jsonb_build_array(jsonb_build_object('severity', 'INFO', 'code', 'STALE_SHORTLIST_EVIDENCE', 'detail', jsonb_build_object('count', n))); END IF;
  -- An active agent with no route forward: no open venture, no open decision, no candidate, nothing recorded for a while.
  SELECT count(*) INTO n FROM fleet_agents ag
   WHERE ag.status = 'active' AND ag.origin IN ('genesis_founder','reseed_founder')
     AND NOT EXISTS (SELECT 1 FROM fleet_ventures v WHERE v.agent_id = ag.agent_id AND v.state NOT IN ('failed','closed'))
     AND NOT EXISTS (SELECT 1 FROM fleet_opportunities o WHERE o.agent_id = ag.agent_id AND o.status IN ('candidate','shortlisted','selected'))
     AND NOT EXISTS (SELECT 1 FROM fleet_decision_records d WHERE d.agent_id = ag.agent_id AND d.created_at > now() - make_interval(hours => p.no_route_hours))
     AND ag.created_at < now() - make_interval(hours => p.no_route_hours);
  IF n > 0 THEN f := f || jsonb_build_array(jsonb_build_object('severity', 'WARN', 'code', 'AGENT_NO_ROUTE_FORWARD', 'detail', jsonb_build_object('agents', n))); END IF;
  -- Wallet anomalies: negative economic balance with cash still held (death conditions are the lifecycle's).
  SELECT count(*) INTO n FROM fleet_agents ag WHERE ag.status = 'active' AND (fleet_agent_economics(ag.agent_id) ->> 'survivalEquity')::bigint < 0;
  IF n > 0 THEN f := f || jsonb_build_array(jsonb_build_object('severity', 'WARN', 'code', 'WALLET_NEGATIVE_EQUITY', 'detail', jsonb_build_object('agents', n))); END IF;
  -- Constitutional pins (real money stays off in this schema).
  f := f || jsonb_build_array(jsonb_build_object('severity',
    CASE WHEN EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fleet_payment_rails_not_live') THEN 'INFO' ELSE 'FAIL' END, 'code', 'RAILS_NOT_LIVE_PINNED', 'detail', '{}'::jsonb));
  RETURN jsonb_build_object('ok', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(f) y WHERE y ->> 'severity' = 'FAIL'),
    'warn', EXISTS (SELECT 1 FROM jsonb_array_elements(f) y WHERE y ->> 'severity' = 'WARN'), 'findings', f);
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

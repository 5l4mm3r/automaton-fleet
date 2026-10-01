/**
 * Schema v27 — F2 Phase A: own capital is the founder's to risk-manage; FleetController is its custodian only.
 *
 * Retires the last legacy contradiction in ordinary agent spending: the v10 spend policy routed every own-capital order
 * above `owner_approval_threshold_cents` (10000 = 100.00 per order) or above `agent_daily_spend_cents` (5000 = 50.00 per
 * day) to `awaiting_owner` / FLEET_OWNER_APPROVAL_REQUIRED. A fixed nominal amount says nothing about a founder's wallet,
 * evidence, exposure or downside, and an owner queue made every larger decision wait on a human.
 *
 * 1. `api_spend_request` (same signature, same grants) decides an own-capital order on CUSTODY alone:
 *    - custody: the founder's own unreserved cash only; never protected capital (principal, approved obligations), never
 *      a TAX RESERVE, never another agent's or the Treasury's money (the order can only debit the authenticated agent's
 *      own cash account); never while held, frozen or inactive; only to an active payee destination allowed to it;
 *    - an INFRASTRUCTURE CIRCUIT BREAKER (anomaly protection, below), when configured;
 *    - otherwise the order is reserved (FLEET_CUSTODY_CLEARED). There is no owner route, no fixed amount and no
 *      commercial judgement: the founder sized the exposure under its own decided decision (founder runtime).
 *    Every refusal carries a precise FLEET_* code AND its custody category (`custody`: PROTECTED_CAPITAL, TAX_RESERVE,
 *    INSUFFICIENT_OWN_CAPITAL, HOLD, FROZEN, AGENT_NOT_ACTIVE, INVALID_DESTINATION, IDEMPOTENCY_CONFLICT,
 *    INFRASTRUCTURE_CIRCUIT_BREAKER, PAYMENT_RAIL_UNAVAILABLE). A refusal is final for that order and creates nothing
 *    for anyone to decide.
 * 2. The owner spend route is retired: legacy `awaiting_owner` orders (never reserved, so no capital is locked) are
 *    cancelled with FLEET_OWNER_ROUTE_RETIRED, a CHECK makes the state unreachable, and the owner decision function
 *    refuses. `owner_approval_threshold_cents` / `agent_daily_spend_cents` stay as inert LEGACY columns (kept so earlier
 *    economic-policy seals remain comparable); no decision reads them.
 * 3. TAX RESERVES: an approved obligation can be a `tax_reserve`; it is protected like every obligation and named
 *    precisely (FLEET_TAX_RESERVE) when an order would consume it.
 * 4. The spend circuit breaker is infrastructure, not policy: relative signals only (basis points of the founder's own
 *    wallet, time windows) and a manual trip for an incident (a compromised provider, a catastrophic anomaly). Every
 *    signal is UNSET at v27 — no production threshold is chosen here — and no column can hold a nominal currency amount.
 *    Its configuration is never returned to an agent: it is not an allowance or an entitlement.
 *
 * Fleet / Treasury / shared capital (capital allocations, Treasury grants) is a separate allocation path, untouched here.
 */

import { CUSTODY_REFUSAL_CODES } from "../custody-refusals.js";

export const V27_SQL = `
-- ═══ 1. Retire the owner spend route (legacy history is kept; nothing is locked) ═══
SELECT fleet_event('payment_order_cancelled', agent_id, 'migration',
         jsonb_build_object('orderId', order_id, 'orderType', order_type, 'amountCents', amount_cents, 'code', 'FLEET_OWNER_ROUTE_RETIRED'))
  FROM fleet_payment_orders WHERE status = 'awaiting_owner' ORDER BY seq;
UPDATE fleet_payment_orders SET status = 'cancelled', decision_code = 'FLEET_OWNER_ROUTE_RETIRED',
       decision_reason = 'v27: the owner spend route is retired; own capital is the founder''s to commit within custody (re-request under a decided decision)'
 WHERE status = 'awaiting_owner';
ALTER TABLE fleet_payment_orders ADD CONSTRAINT fleet_payment_orders_no_owner_route CHECK (status <> 'awaiting_owner');
COMMENT ON COLUMN fleet_economic_model.owner_approval_threshold_cents IS 'LEGACY (retired at v27): no spend decision reads it; kept so earlier economic-policy seals stay comparable';
COMMENT ON COLUMN fleet_economic_model.agent_daily_spend_cents IS 'LEGACY (retired at v27): no spend decision reads it; kept so earlier economic-policy seals stay comparable';

CREATE OR REPLACE FUNCTION fleet_admin_spend_decision(p_order uuid, p_decision text, p_actor text, p_note text, p_ack boolean) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'FLEET_OWNER_ROUTE_RETIRED: own-capital spend is decided by the founder and validated by custody; there is no owner spend approval';
END $$;

-- ═══ 2. Tax reserves: protected like every obligation, named precisely ═══
ALTER TABLE fleet_obligations ADD COLUMN category text NOT NULL DEFAULT 'obligation';
ALTER TABLE fleet_obligations ADD CONSTRAINT fleet_obligations_category_check CHECK (category IN ('obligation','tax_reserve'));

-- ═══ 3. Infrastructure circuit breaker (relative signals only; every signal unset) ═══
CREATE TABLE fleet_spend_circuit_breaker (
  id                 smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  tripped            boolean     NOT NULL DEFAULT false,
  trip_reason        text        CHECK (length(trip_reason) BETWEEN 1 AND 300),
  order_wallet_bp    integer     CHECK (order_wallet_bp BETWEEN 1 AND 10000),
  velocity_window_s  integer     CHECK (velocity_window_s BETWEEN 60 AND 2592000),
  velocity_wallet_bp integer     CHECK (velocity_wallet_bp BETWEEN 1 AND 10000),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         text        NOT NULL DEFAULT 'migration',
  CHECK (tripped = (trip_reason IS NOT NULL)),
  CHECK ((velocity_window_s IS NULL) = (velocity_wallet_bp IS NULL))
);
INSERT INTO fleet_spend_circuit_breaker (id) VALUES (1);
CREATE TRIGGER fleet_spend_circuit_breaker_no_delete BEFORE DELETE ON fleet_spend_circuit_breaker
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_spend_circuit_breaker_no_truncate BEFORE TRUNCATE ON fleet_spend_circuit_breaker
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
COMMENT ON TABLE fleet_spend_circuit_breaker IS 'v27 INFRASTRUCTURE circuit breaker for own-capital spend: anomaly protection, never a commercial judgement, an approval route or an allowance. Relative signals only (basis points of the founder''s own wallet, time windows); NULL = unset. No production threshold is chosen at v27.';
COMMENT ON COLUMN fleet_spend_circuit_breaker.order_wallet_bp IS 'one order above this share (basis points) of the founder''s own unreserved cash trips the breaker; NULL = unset';
COMMENT ON COLUMN fleet_spend_circuit_breaker.velocity_wallet_bp IS 'own spend inside velocity_window_s above this share (basis points) of the wallet the window started with trips the breaker; NULL = unset';

-- The breaker signal an order trips (NULL = clear). Signal names only: the configuration never reaches an agent.
CREATE FUNCTION fleet_spend_circuit_breaker_check(o fleet_payment_orders) RETURNS text LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE b fleet_spend_circuit_breaker; v_cash bigint; v_window bigint;
BEGIN
  SELECT * INTO b FROM fleet_spend_circuit_breaker WHERE id = 1;
  IF NOT FOUND THEN RETURN 'unavailable'; END IF; -- fail closed (the row cannot be deleted)
  IF b.tripped THEN RETURN 'tripped'; END IF;
  IF b.order_wallet_bp IS NULL AND b.velocity_wallet_bp IS NULL THEN RETURN NULL; END IF;
  v_cash := fleet_ledger_balance(fleet_ledger_account(o.agent_id, 'agent_cash'));
  IF b.order_wallet_bp IS NOT NULL AND o.amount_cents::numeric * 10000 > v_cash::numeric * b.order_wallet_bp THEN
    RETURN 'order_wallet_share';
  END IF;
  IF b.velocity_wallet_bp IS NOT NULL THEN
    SELECT COALESCE(sum(amount_cents), 0) INTO v_window FROM fleet_payment_orders
     WHERE agent_id = o.agent_id AND order_id <> o.order_id AND status IN ('reserved','executing','settled')
       AND created_at > now() - make_interval(secs => b.velocity_window_s);
    IF (v_window + o.amount_cents)::numeric * 10000 > (v_cash + v_window)::numeric * b.velocity_wallet_bp THEN
      RETURN 'velocity_wallet_share';
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- Owner infrastructure control (an incident switch and its relative signals), never a per-order decision.
CREATE FUNCTION fleet_admin_spend_circuit_breaker(p_actor text, p_tripped boolean, p_reason text, p_order_wallet_bp integer,
  p_velocity_window_s integer, p_velocity_wallet_bp integer) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE b fleet_spend_circuit_breaker;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');
  UPDATE fleet_spend_circuit_breaker SET tripped = COALESCE(p_tripped, false),
         trip_reason = CASE WHEN COALESCE(p_tripped, false) THEN left(fleet_scrub(p_reason), 300) END,
         order_wallet_bp = p_order_wallet_bp, velocity_window_s = p_velocity_window_s, velocity_wallet_bp = p_velocity_wallet_bp,
         updated_at = now(), updated_by = p_actor
   WHERE id = 1 RETURNING * INTO b;
  PERFORM fleet_event('spend_circuit_breaker_set', NULL, p_actor, to_jsonb(b) - 'id');
  RETURN to_jsonb(b) - 'id';
END $$;

-- ═══ 4. Custody (constitutional / availability) for an own-capital order ═══
CREATE FUNCTION fleet_custody_refusal(p_code text) RETURNS text LANGUAGE sql IMMUTABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT CASE p_code ${CUSTODY_REFUSAL_CODES.map(([c, k]) => `WHEN '${c}' THEN '${k}'`).join(" ")} END
$$;

-- The v10 hard checks, with the most senior protected claim named precisely. NULL = custody clears the order.
CREATE FUNCTION fleet_spend_custody_check(o fleet_payment_orders) RETURNS text LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_order_hard_check(o); v_tax bigint;
BEGIN
  IF v_code = 'FLEET_PROTECTED_CAPITAL' AND o.order_type = 'agent_spend' THEN
    SELECT COALESCE(sum(amount_cents), 0) INTO v_tax FROM fleet_obligations
     WHERE agent_id = o.agent_id AND status = 'approved' AND category = 'tax_reserve';
    IF (fleet_agent_economics(o.agent_id) ->> 'recoverable')::bigint - o.amount_cents + o.recoverable_cents < v_tax THEN
      RETURN 'FLEET_TAX_RESERVE';
    END IF;
  END IF;
  RETURN v_code;
END $$;

-- E5 → F2-A: an agent commits its OWN capital; FleetController validates custody and reserves. Nothing is executed here.
CREATE OR REPLACE FUNCTION api_spend_request(p_agent text, p_token text, p_idem text, p_amount_cents bigint, p_category text,
  p_destination text, p_purpose text, p_recoverable_cents bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'spend_request'); o fleet_payment_orders; v_ttl integer;
        v_hash text; v_refusal text; v_signal text; v_rec bigint := COALESCE(p_recoverable_cents, 0);
BEGIN
  -- Authentication refuses a held or inactive agent first; such a refusal is still a custody category (HOLD, ...).
  IF v_code IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code)
      || CASE WHEN fleet_custody_refusal(v_code) IS NOT NULL THEN jsonb_build_object('custody', fleet_custody_refusal(v_code)) ELSE '{}'::jsonb END;
  END IF;
  IF p_idem IS NULL OR p_idem !~ '^[A-Za-z0-9:_.-]{8,128}$' OR p_amount_cents IS NULL OR p_amount_cents <= 0 OR p_amount_cents > 100000000000
     OR p_category NOT IN ('expense','fee','asset_acquisition','conway_credits') OR p_destination IS NULL
     OR p_destination !~ '^dst_[0-9A-HJKMNP-TV-Z]{26}$' OR p_purpose IS NULL OR length(p_purpose) NOT BETWEEN 1 AND 300
     OR v_rec < 0 OR v_rec > p_amount_cents OR (p_category <> 'asset_acquisition' AND v_rec <> 0) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  PERFORM fleet_ledger_open_agent(p_agent, p_agent);
  -- Serialise this agent's spend decisions (no double-spend races).
  PERFORM 1 FROM fleet_ledger_accounts WHERE account_id = fleet_ledger_account(p_agent, 'agent_cash') FOR UPDATE;
  v_hash := encode(sha256(convert_to(concat_ws('|', p_agent, p_amount_cents, p_category, p_destination, fleet_scrub(p_purpose), v_rec), 'UTF8')), 'hex');
  SELECT * INTO o FROM fleet_payment_orders WHERE order_type = 'agent_spend' AND agent_id = p_agent AND idempotency_key = p_idem;
  IF FOUND THEN
    IF o.request_sha256 <> v_hash THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_IDEMPOTENCY_CONFLICT', 'custody', fleet_custody_refusal('FLEET_IDEMPOTENCY_CONFLICT'));
    END IF;
    RETURN jsonb_build_object('ok', o.status IN ('reserved','executing','settled'), 'replay', true, 'order', fleet_order_json(o))
      || CASE WHEN o.status = 'rejected' THEN jsonb_build_object('code', o.decision_code, 'custody', fleet_custody_refusal(o.decision_code)) ELSE '{}'::jsonb END;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fleet_payment_destinations WHERE destination_id = p_destination) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_DESTINATION_NOT_ALLOWED', 'custody', fleet_custody_refusal('FLEET_DESTINATION_NOT_ALLOWED'));
  END IF;
  SELECT reservation_ttl_s INTO v_ttl FROM fleet_economic_model WHERE id = 1;
  INSERT INTO fleet_payment_orders (order_id, order_type, agent_id, idempotency_key, amount_cents, category, destination_id, purpose,
      recoverable_cents, requested_by, request_sha256, status, expires_at)
    VALUES (gen_random_uuid(), 'agent_spend', p_agent, p_idem, p_amount_cents, p_category, p_destination, left(fleet_scrub(p_purpose), 300),
      v_rec, p_agent, v_hash, 'requested', now() + make_interval(secs => v_ttl))
    RETURNING * INTO o;
  -- 1. Custody: the founder's own unreserved capital, never protected, tax-reserved, frozen or held capital.
  v_refusal := fleet_spend_custody_check(o);
  -- 2. Infrastructure circuit breaker (anomaly protection; unset signals never trip).
  IF v_refusal IS NULL THEN
    v_signal := fleet_spend_circuit_breaker_check(o);
    IF v_signal IS NOT NULL THEN v_refusal := 'FLEET_INFRASTRUCTURE_CIRCUIT_BREAKER'; END IF;
  END IF;
  IF v_refusal IS NOT NULL THEN
    UPDATE fleet_payment_orders SET status = 'rejected', decided_by = 'controller', decision_code = v_refusal,
           decision_reason = CASE WHEN v_signal IS NOT NULL THEN 'infrastructure circuit breaker: ' || v_signal
                                  ELSE 'custody: ' || COALESCE(fleet_custody_refusal(v_refusal), v_refusal) END
     WHERE order_id = o.order_id RETURNING * INTO o;
    PERFORM fleet_event('payment_order_rejected', p_agent, 'controller',
      jsonb_build_object('orderId', o.order_id, 'code', v_refusal, 'custody', fleet_custody_refusal(v_refusal), 'amountCents', p_amount_cents));
    RETURN jsonb_build_object('ok', false, 'code', v_refusal, 'custody', fleet_custody_refusal(v_refusal), 'order', fleet_order_json(o));
  END IF;
  -- 3. Within custody: reserved. No owner route, no fixed amount, no judgement of the founder's commercial decision.
  o := fleet_order_reserve(o, 'controller', 'controller', 'controller', 'FLEET_CUSTODY_CLEARED', 'own capital, founder-sized; custody checks passed', NULL);
  RETURN jsonb_build_object('ok', true, 'order', fleet_order_json(o));
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

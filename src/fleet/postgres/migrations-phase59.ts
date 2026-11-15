/**
 * Schema v59 — refunds initiated by the Fleet (PayPal Payments v2: POST /v2/payments/captures/{capture_id}/refund).
 *
 * An agent refunds its own PayPal sale (in full or in part) with `order.refund`; the owner can do the same from the
 * dashboard or CLI. The request reserves the amount at once (it is no longer spendable: exposure), custody sends it to
 * PayPal under the same money-out authority as payouts (an active custody activation; REAL_PAYMENTS_ENABLED for a live
 * rail) with a PayPal-Request-Id per request (a retry never refunds twice), and the accounting is posted ONLY from PayPal's
 * evidence through the v57/v58 reconciliation: the refund's id is recorded as webhook-source evidence, so PayPal's own
 * PAYMENT.CAPTURE.REFUNDED webhook for it, and its Transaction Search row, never post it again.
 * Refundable = what the buyer paid, less refunds and reversals already posted (plus money given back), less refunds still
 * in flight. Only the agent that made the sale (or the owner) can refund it. A refund PayPal refuses releases the reserve.
 */
import { V56_SQL } from "./migrations-phase56.js";
import { V57_SQL } from "./migrations-phase57.js";
import { V58_SQL } from "./migrations-phase58.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));
const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

export const EVENT_ROUTES_V59 = Object.freeze({
  P2_IMPORTANT: ["order_refund_failed"],
  P3_INFO: ["order_refund_requested", "order_refund_completed"],
} as const);
export const DASHBOARD_SENSITIVE_OPS_V59 = ["order_refund"] as const;

const WORKER = `IF p_worker IS NULL OR p_worker !~ '^[a-z0-9-]{3,40}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: worker name'; END IF;`;
const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');`;
const INFLIGHT = `('requested','sent','pending')`;

const DISPATCH = restate(V56_SQL, "api_economy", [
  [`WHEN 'order.list' THEN 'planning'`, `WHEN 'order.list' THEN 'planning' WHEN 'order.refund' THEN 'planning'`],
  [`      WHEN 'order.fulfil' THEN fleet_econ_order_fulfil(p_agent, a)`,
   `      WHEN 'order.fulfil' THEN fleet_econ_order_fulfil(p_agent, a)
      WHEN 'order.refund' THEN fleet_econ_order_refund(p_agent, a)`],
]);

// Exposure: a refund in flight is no longer the agent's to spend (it is not lost yet: PayPal has not confirmed it).
const SALE_EXPOSURE = restate(V58_SQL, "fleet_paypal_sale_exposure", [
  [`           LEAST(GREATEST(r.disputed, r.unclassified), GREATEST(0, c.amount_minor - p.refund - p.reversal + p.returned))`,
   `           LEAST(GREATEST(r.disputed, r.unclassified)
                 + COALESCE((SELECT sum(x.amount_minor) FROM fleet_paypal_refund_requests x WHERE x.checkout_id = p_checkout AND x.status IN ${INFLIGHT}), 0),
                 GREATEST(0, c.amount_minor - p.refund - p.reversal + p.returned))`],
]);
const AGENT_EXPOSURE = restate(V57_SQL, "fleet_paypal_dispute_exposure", [
  [`          OR EXISTS (SELECT 1 FROM fleet_paypal_clawback_evidence e WHERE e.checkout_id = c.checkout_id AND e.grp IN ('dispute_hold','unclassified')))`,
   `          OR EXISTS (SELECT 1 FROM fleet_paypal_clawback_evidence e WHERE e.checkout_id = c.checkout_id AND e.grp IN ('dispute_hold','unclassified'))
          OR EXISTS (SELECT 1 FROM fleet_paypal_refund_requests x WHERE x.checkout_id = c.checkout_id AND x.status IN ${INFLIGHT}))`],
]);

// A refund's webhook / Search row completes its request (the posting itself is the reconciliation's, once).
const EVIDENCE = restate(V57_SQL, "cx_paypal_clawback_evidence", [
  [`  INSERT INTO fleet_paypal_clawback_evidence (source, ref_id, grp, checkout_id, amount_minor) VALUES ('webhook', p_ref, p_grp, c.checkout_id, p_amount)
    ON CONFLICT DO NOTHING;`,
   `  INSERT INTO fleet_paypal_clawback_evidence (source, ref_id, grp, checkout_id, amount_minor) VALUES ('webhook', p_ref, p_grp, c.checkout_id, p_amount)
    ON CONFLICT DO NOTHING;
  IF p_grp = 'refund' THEN PERFORM fleet_refund_request_completed(c.checkout_id, p_ref); END IF;`],
]);
const TXN = restate(V57_SQL, "cx_paypal_txn_record", [
  [`      rc := fleet_paypal_clawback_reconcile(t.checkout_id, p_worker);`,
   `      IF v_grp = 'refund' THEN PERFORM fleet_refund_request_completed(t.checkout_id, t.transaction_id); END IF;
      rc := fleet_paypal_clawback_reconcile(t.checkout_id, p_worker);`],
]);

const DASH_CALL = restate(V58_SQL, "dash_call", [
  [`'paypal_dispute_resolve','paypal_debit_classify','card_credit_return');`, `'paypal_dispute_resolve','paypal_debit_classify','card_credit_return',${q(DASHBOARD_SENSITIVE_OPS_V59)});`],
  [`      WHEN 'card_credit_return' THEN`,
   `      WHEN 'order_refund' THEN fleet_admin_order_refund((a ->> 'orderId')::uuid, (a ->> 'amountMinor')::bigint, a ->> 'reason', 'operator:owner')
      WHEN 'card_credit_return' THEN`],
]);

const EVENT_ROUTE = restate(V58_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V59) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
]);

export const V59_SQL = `
CREATE TABLE fleet_paypal_refund_requests (
  request_id      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_id     uuid        NOT NULL REFERENCES fleet_paypal_checkouts(checkout_id),
  order_id        uuid        REFERENCES fleet_customer_orders(order_id),
  agent_id        text        NOT NULL REFERENCES fleet_agents(agent_id),
  amount_minor    bigint      NOT NULL CHECK (amount_minor > 0),
  currency        text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reason          text        NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  requested_by    text        NOT NULL,
  idempotency_key text        NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  status          text        NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','sent','pending','completed','failed')),
  paypal_refund_id text       UNIQUE CHECK (paypal_refund_id ~ '^[A-Za-z0-9-]{5,64}$'),
  failure_code    text        CHECK (failure_code ~ '^[A-Z0-9_]{2,64}$'),
  attempts        integer     NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_paypal_refund_requests_work ON fleet_paypal_refund_requests (status, updated_at) WHERE status IN ${INFLIGHT};
CREATE INDEX fleet_paypal_refund_requests_checkout ON fleet_paypal_refund_requests (checkout_id);
CREATE TRIGGER fleet_paypal_refund_requests_no_delete BEFORE DELETE ON fleet_paypal_refund_requests FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE FUNCTION fleet_paypal_refund_requests_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.checkout_id <> OLD.checkout_id OR NEW.agent_id <> OLD.agent_id OR NEW.amount_minor <> OLD.amount_minor OR NEW.currency <> OLD.currency
     OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.requested_by <> OLD.requested_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a refund request''s sale, amount and requester are fixed';
  END IF;
  IF OLD.status IN ('completed','failed') THEN RAISE EXCEPTION 'FLEET_IMMUTABLE: a finished refund request is history'; END IF;
  IF NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN NEW.updated_at := now(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_paypal_refund_requests_guard BEFORE UPDATE ON fleet_paypal_refund_requests FOR EACH ROW EXECUTE FUNCTION fleet_paypal_refund_requests_guard();

-- What can still be refunded on a sale: paid, less refunds and reversals posted (plus money given back), less in flight.
CREATE FUNCTION fleet_paypal_refundable(p_checkout uuid) RETURNS bigint LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT GREATEST(0, c.amount_minor
    - COALESCE((SELECT sum(p.amount_minor) FROM fleet_paypal_clawback_posts p WHERE p.checkout_id = c.checkout_id AND p.grp IN ('refund','reversal')), 0)
    + COALESCE((SELECT sum(p.amount_minor) FROM fleet_paypal_clawback_posts p WHERE p.checkout_id = c.checkout_id AND p.grp = 'reversal_return'), 0)
    - COALESCE((SELECT sum(x.amount_minor) FROM fleet_paypal_refund_requests x WHERE x.checkout_id = c.checkout_id AND x.status IN ${INFLIGHT}), 0))::bigint
  FROM fleet_paypal_checkouts c WHERE c.checkout_id = p_checkout
$$;

CREATE FUNCTION fleet_refund_request_json(x fleet_paypal_refund_requests) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('refundRequestId', x.request_id, 'orderId', x.order_id, 'checkoutId', x.checkout_id, 'amountMinor', x.amount_minor,
    'currency', x.currency, 'status', x.status, 'reason', x.reason, 'paypalRefundId', x.paypal_refund_id, 'failure', x.failure_code,
    'requestedBy', x.requested_by, 'at', x.created_at))
$$;

-- The one way a refund is requested (agent or owner): own captured sale, within what is refundable, once per key.
CREATE FUNCTION fleet_order_refund_request(p_order uuid, p_agent text, p_amount bigint, p_reason text, p_key text, p_by text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_customer_orders; c fleet_paypal_checkouts; x fleet_paypal_refund_requests; v_left bigint; v_amount bigint; v_reason text := left(trim(fleet_scrub(COALESCE(p_reason, ''))), 300);
BEGIN
  SELECT * INTO x FROM fleet_paypal_refund_requests WHERE idempotency_key = p_key;
  IF FOUND THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'refund', fleet_refund_request_json(x)); END IF;
  SELECT * INTO o FROM fleet_customer_orders WHERE order_id = p_order AND (p_agent IS NULL OR agent_id = p_agent);
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: orderId — one of your orders'; END IF;
  SELECT * INTO c FROM fleet_paypal_checkouts WHERE checkout_id = o.checkout_id FOR UPDATE;
  IF c.status <> 'captured' OR c.purpose <> 'agent_sale' OR c.capture_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE', 'reason', 'only a captured sale can be refunded');
  END IF;
  IF length(v_reason) < 3 THEN PERFORM fleet_econ_bad('reason: why the buyer is refunded (3..300 characters)'); END IF;
  v_left := fleet_paypal_refundable(c.checkout_id);
  v_amount := COALESCE(p_amount, v_left);
  IF v_amount IS NULL OR v_amount <= 0 OR v_amount > v_left THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_REFUND_EXCEEDS_REFUNDABLE', 'refundableMinor', v_left,
      'reason', 'at most what the buyer paid, less refunds and reversals already made or in flight');
  END IF;
  INSERT INTO fleet_paypal_refund_requests (checkout_id, order_id, agent_id, amount_minor, currency, reason, requested_by, idempotency_key)
    VALUES (c.checkout_id, o.order_id, c.agent_id, v_amount, c.currency, v_reason, p_by, p_key) RETURNING * INTO x;
  PERFORM fleet_event('order_refund_requested', c.agent_id, p_by, jsonb_build_object('orderId', o.order_id, 'refundRequestId', x.request_id, 'amountMinor', v_amount));
  RETURN jsonb_build_object('ok', true, 'refund', fleet_refund_request_json(x), 'refundableAfterMinor', v_left - v_amount,
    'note', CASE WHEN EXISTS (SELECT 1 FROM fleet_custody_activation_live())
                 THEN 'custody sends it to PayPal shortly; the amount is set aside now and posted when PayPal confirms it'
                 ELSE 'set aside now; custody sends it to PayPal once money-out is activated (refunds use the same authority as payments)' END);
END $$;

-- Agent: refund its own sale (in full by default, or part of it).
CREATE FUNCTION fleet_econ_order_refund(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  RETURN fleet_order_refund_request(fleet_identity_uuid(a, 'orderId'), p_agent, fleet_econ_int(a, 'amountMinor', 1, 100000000), a ->> 'reason',
    'agent:' || p_agent || ':' || fleet_econ_text(a, 'idempotencyKey', 128, true), 'agent');
END $$;

-- Owner: refund any agent's sale.
CREATE FUNCTION fleet_admin_order_refund(p_order uuid, p_amount bigint, p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  ${OWNER_ACTOR}
  RETURN fleet_order_refund_request(p_order, NULL, p_amount, p_reason, 'owner:' || p_order || ':' || gen_random_uuid(), p_actor);
END $$;

-- PayPal's evidence of a refund completes its request (webhook id or Transaction Search id = the refund id).
CREATE FUNCTION fleet_refund_request_completed(p_checkout uuid, p_refund_id text) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_paypal_refund_requests;
BEGIN
  UPDATE fleet_paypal_refund_requests SET status = 'completed' WHERE checkout_id = p_checkout AND paypal_refund_id = p_refund_id AND status IN ${INFLIGHT}
    RETURNING * INTO x;
  IF FOUND THEN PERFORM fleet_event('order_refund_completed', x.agent_id, 'custody', jsonb_build_object('refundRequestId', x.request_id, 'orderId', x.order_id, 'amountMinor', x.amount_minor)); END IF;
END $$;

-- Custody: refunds to send (only while money-out is activated), each with its sale's capture and rail credential.
CREATE FUNCTION cx_paypal_refund_work(p_worker text, p_limit integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r jsonb;
BEGIN
  ${WORKER}
  -- The same live owner activation payouts need (enabled, unended, unexpired).
  IF NOT EXISTS (SELECT 1 FROM fleet_custody_activation_live()) THEN RETURN '[]'::jsonb; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('refundRequestId', x.request_id, 'captureId', c.capture_id, 'amountMinor', x.amount_minor, 'currency', x.currency,
           'note', left(x.reason, 255), 'invoiceId', 'fleet-refund:' || x.request_id, 'railId', r2.rail_id, 'railMode', r2.mode, 'vaultRef', k.vault_ref) ORDER BY x.created_at), '[]'::jsonb) INTO r
    FROM (SELECT * FROM fleet_paypal_refund_requests WHERE status = 'requested' OR (status = 'sent' AND updated_at < now() - interval '10 minutes')
           ORDER BY created_at LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50)) x
    JOIN fleet_paypal_checkouts c ON c.checkout_id = x.checkout_id
    JOIN fleet_payment_rails r2 ON r2.rail_id = c.rail_id JOIN fleet_credential_refs k ON k.credential_id = r2.credential_id
   WHERE r2.status = 'active' AND 'refunds' = ANY (r2.capabilities) AND k.status IN ('active','rotating');
  RETURN r;
END $$;

-- Custody: PayPal's answer. completed → recorded as the refund's evidence (posted once, by reconciliation); pending →
-- PayPal's webhook / Search completes it; failed → the reserve is released; unknown → sent again with the same request id.
CREATE FUNCTION cx_paypal_refund_result(p_worker text, p_request uuid, p_outcome text, p_refund_id text, p_amount bigint, p_currency text, p_failure text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_paypal_refund_requests; c fleet_paypal_checkouts; r jsonb;
BEGIN
  ${WORKER}
  IF p_outcome NOT IN ('completed','pending','failed','unknown') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  SELECT * INTO x FROM fleet_paypal_refund_requests WHERE request_id = p_request FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF x.status IN ('completed','failed') THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'status', x.status); END IF;
  SELECT * INTO c FROM fleet_paypal_checkouts WHERE checkout_id = x.checkout_id;
  IF p_outcome = 'unknown' THEN
    UPDATE fleet_paypal_refund_requests SET status = 'sent', attempts = attempts + 1 WHERE request_id = p_request;
    RETURN jsonb_build_object('ok', true, 'status', 'sent');
  END IF;
  IF p_outcome = 'failed' THEN
    UPDATE fleet_paypal_refund_requests SET status = 'failed', attempts = attempts + 1,
           failure_code = CASE WHEN p_failure ~ '^[A-Z0-9_]{2,64}$' THEN p_failure ELSE 'PAYPAL_REFUND_REFUSED' END WHERE request_id = p_request RETURNING * INTO x;
    PERFORM fleet_event('order_refund_failed', x.agent_id, 'custody', jsonb_build_object('refundRequestId', x.request_id, 'orderId', x.order_id, 'code', x.failure_code,
      'note', 'PayPal refused this refund; nothing left the treasury and the amount is spendable again'));
    RETURN jsonb_build_object('ok', true, 'status', 'failed');
  END IF;
  IF p_refund_id IS NULL OR p_refund_id !~ '^[A-Za-z0-9-]{5,64}$' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  UPDATE fleet_paypal_refund_requests SET status = 'pending', paypal_refund_id = p_refund_id, attempts = attempts + 1 WHERE request_id = p_request;
  IF p_outcome = 'completed' THEN
    IF p_amount IS DISTINCT FROM x.amount_minor OR p_currency IS DISTINCT FROM x.currency THEN
      PERFORM fleet_event('paypal_refund_unmatched', x.agent_id, 'custody', jsonb_build_object('refundRequestId', x.request_id, 'refundId', p_refund_id,
        'expectedMinor', x.amount_minor, 'reportedMinor', p_amount));
    END IF;
    -- The same evidence PayPal's REFUNDED webhook gives (same refund id): posted once whichever arrives first.
    r := cx_paypal_clawback_evidence(p_worker, 'webhook', p_refund_id, 'refund', c.capture_id, COALESCE(p_amount, x.amount_minor), COALESCE(p_currency, x.currency));
  END IF;
  SELECT * INTO x FROM fleet_paypal_refund_requests WHERE request_id = p_request;
  RETURN jsonb_build_object('ok', true, 'status', x.status, 'posted', r -> 'posted');
END $$;

${SALE_EXPOSURE}

${AGENT_EXPOSURE}

${EVIDENCE}

${TXN}

${DISPATCH}

${DASH_CALL}

${EVENT_ROUTE}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

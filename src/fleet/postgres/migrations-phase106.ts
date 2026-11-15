/**
 * Schema v106 — the owner's own claim may wait behind the refund of the owner's own proof order (owner, 2026-10-20: "I do
 * not need to deposit any money into the PayPal! Refund the £5 to complete the test"; asked whether their AI-credit
 * reimbursement may wait behind this one refund: "Yes, my claim waits").
 *
 * Custody sends a refund only when the treasury's free cash covers it (`cx_paypal_refund_work`, v96): PayPal's available
 * balance less everything committed — including what is owed to the owner for AI credit the owner's card paid
 * (`fleet:owner:payable`, v69). For a refund of an OWNER-PROOF order (the owner's own purchase) the owner may record that
 * their claim waits: that refund's cover then counts the owner payable as available. Nothing else changes — no other
 * refund, payout or payment; the claim is not forgiven, reduced, reclassified or paid (it stays owed, in full, and is
 * shown as before); other commitments (card to repay, other refunds, payments in flight) still come first; the refund
 * authority, rail, credential and REAL_PAYMENTS_ENABLED checks are unchanged.
 *
 * `fleet_admin_owner_claim_wait(order, reason, actor)` records the decision (owner actor; the order must be an owner-proof
 * order; one live decision per order); `fleet_admin_owner_claim_wait_end` ends it. Both are events (P2).
 */
import { V96_SQL } from "./migrations-phase96.js";
import { V98_SQL, EVENT_ROUTES_V98 } from "./migrations-phase98.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));
const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

export const EVENT_ROUTES_V106 = Object.freeze({
  P1_HIGH: [...EVENT_ROUTES_V98.P1_HIGH],
  P2_IMPORTANT: [...EVENT_ROUTES_V98.P2_IMPORTANT, "owner_claim_waits", "owner_claim_wait_ended"],
} as const);

const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');`;

const REFUND_WORK = restate(V96_SQL, "cx_paypal_refund_work", [
  [`    IF v_stale OR x.amount_minor > v_free THEN PERFORM fleet_treasury_liquidity_wait(x.agent_id, 'refund', x.request_id::text, x.amount_minor, v_liq); CONTINUE; END IF;`,
   `    -- v106: the refund of an owner-proof order the owner let their own claim wait behind: the owner payable counts as available.
    v_wait := CASE WHEN EXISTS (SELECT 1 FROM fleet_owner_claim_waits w JOIN fleet_customer_orders o ON o.order_id = w.order_id
                                 WHERE w.order_id = x.order_id AND w.ended_at IS NULL AND o.owner_proof)
                   THEN COALESCE((v_liq #>> '{committed,owedToOwnerMinor}')::bigint, 0) ELSE 0 END;
    IF v_stale OR x.amount_minor > v_free + v_wait THEN PERFORM fleet_treasury_liquidity_wait(x.agent_id, 'refund', x.request_id::text, x.amount_minor, v_liq); CONTINUE; END IF;`],
  [`DECLARE r jsonb; v_free bigint;`, `DECLARE r jsonb; v_free bigint; v_wait bigint;`],
]);

const EVENT_ROUTE = restate(V98_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN",
    `    WHEN p_type IN (${q(["owner_claim_waits", "owner_claim_wait_ended"])}) THEN 'P2_IMPORTANT'\n    WHEN p_type = 'spend_circuit_breaker_set' THEN`],
]);

export const V106_SQL = `
CREATE TABLE fleet_owner_claim_waits (
  wait_id     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid        NOT NULL REFERENCES fleet_customer_orders(order_id),
  decided_by  text        NOT NULL CHECK (decided_by ~ '^operator:'),
  reason      text        NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  decided_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  ended_by    text,
  end_reason  text
);
CREATE UNIQUE INDEX fleet_owner_claim_waits_live ON fleet_owner_claim_waits (order_id) WHERE ended_at IS NULL;

CREATE FUNCTION fleet_admin_owner_claim_wait(p_order uuid, p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_customer_orders; w fleet_owner_claim_waits;
BEGIN
  ${OWNER_ACTOR}
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a reason is required'; END IF;
  SELECT * INTO o FROM fleet_customer_orders WHERE order_id = p_order;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: orderId'; END IF;
  IF NOT o.owner_proof THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: only the refund of the owner''s own proof order can be put ahead of the owner''s claim'; END IF;
  SELECT * INTO w FROM fleet_owner_claim_waits WHERE order_id = p_order AND ended_at IS NULL;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'waitId', w.wait_id, 'orderId', w.order_id, 'decidedAt', w.decided_at, 'already', true);
  END IF;
  INSERT INTO fleet_owner_claim_waits (order_id, decided_by, reason) VALUES (p_order, p_actor, left(fleet_scrub(p_reason), 300)) RETURNING * INTO w;
  PERFORM fleet_event('owner_claim_waits', o.agent_id, p_actor, jsonb_build_object('waitId', w.wait_id, 'orderId', w.order_id,
    'owedToOwnerMinor', GREATEST(0, fleet_ledger_balance('fleet:owner:payable')), 'reason', w.reason));
  RETURN jsonb_build_object('ok', true, 'waitId', w.wait_id, 'orderId', w.order_id, 'decidedAt', w.decided_at,
    'note', 'a refund of this order may now use the cash committed to what is owed to you; your claim is unchanged and stays owed; nothing else changes');
END $$;

CREATE FUNCTION fleet_admin_owner_claim_wait_end(p_order uuid, p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE w fleet_owner_claim_waits;
BEGIN
  ${OWNER_ACTOR}
  UPDATE fleet_owner_claim_waits SET ended_at = now(), ended_by = p_actor, end_reason = left(COALESCE(NULLIF(trim(p_reason), ''), 'ended by the owner'), 300)
   WHERE order_id = p_order AND ended_at IS NULL RETURNING * INTO w;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', true, 'ended', false); END IF;
  PERFORM fleet_event('owner_claim_wait_ended', (SELECT agent_id FROM fleet_customer_orders WHERE order_id = p_order), p_actor,
    jsonb_build_object('waitId', w.wait_id, 'orderId', w.order_id, 'reason', w.end_reason));
  RETURN jsonb_build_object('ok', true, 'ended', true, 'waitId', w.wait_id);
END $$;

${REFUND_WORK}

${EVENT_ROUTE}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

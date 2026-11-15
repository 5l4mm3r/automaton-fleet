/**
 * Schema v99 — the buyer back from PayPal sees "processing", never "not paid yet" (2026-10-19, owner, after the proof payment:
 * PayPal returned the buyer at 18:38, the Fleet saw the approval at 18:38:30 and captured at 18:38:32, but the page the buyer
 * landed on still said "Not paid yet" with the Pay button).
 *
 * PayPal returns an approving buyer to the order page with its order id and the payer id in the query. The controller records
 * that return (`svc_order_returned`: only for the checkout's CURRENT PayPal order, only while it is open) as a pay request, so
 * custody reads the order within seconds and captures it once PayPal reports it APPROVED; the page shows "processing" (no Pay
 * button) until custody has answered. If PayPal does not report the order approved, the page returns to the payment step — the
 * return alone never counts as payment.
 */
import { V98_SQL } from "./migrations-phase98.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));

const ORDER_PAGE = restate(V98_SQL, "svc_order_page", [
  [`                  WHEN fleet_paypal_pay_pending(c) THEN 'preparing'`,
   `                  WHEN fleet_paypal_pay_pending(c) AND c.returned_at IS NOT NULL AND c.returned_at >= c.pay_requested_at THEN 'processing'
                  WHEN fleet_paypal_pay_pending(c) THEN 'preparing'`],
]);

export const V99_SQL = `
ALTER TABLE fleet_paypal_checkouts ADD COLUMN returned_at timestamptz;

-- PayPal brought the buyer back (with the payer id): custody is asked to read the order now. Idempotent; never payment by itself.
CREATE FUNCTION svc_order_returned(p_token text, p_paypal_order text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_customer_orders; c fleet_paypal_checkouts; v timestamptz := clock_timestamp();
BEGIN
  IF p_paypal_order IS NULL OR p_paypal_order !~ '^[A-Z0-9]{5,40}$' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  SELECT * INTO x FROM fleet_customer_orders WHERE access_token = p_token;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  SELECT * INTO c FROM fleet_paypal_checkouts WHERE checkout_id = x.checkout_id FOR UPDATE;
  IF c.status <> 'open' OR c.paypal_order_id IS DISTINCT FROM p_paypal_order OR x.payment_status <> 'awaiting_payment' THEN
    RETURN jsonb_build_object('ok', true, 'recorded', false);
  END IF;
  IF fleet_paypal_pay_pending(c) AND c.returned_at IS NOT NULL AND c.returned_at >= c.pay_requested_at THEN RETURN jsonb_build_object('ok', true, 'recorded', false); END IF;
  UPDATE fleet_paypal_checkouts SET pay_requested_at = v, returned_at = v, pay_failure = NULL, pay_failure_ref = NULL WHERE checkout_id = c.checkout_id;
  RETURN jsonb_build_object('ok', true, 'recorded', true);
END $$;

${ORDER_PAGE}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

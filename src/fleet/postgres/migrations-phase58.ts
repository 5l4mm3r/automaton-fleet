/**
 * Schema v58 — closing corrections to reconciliation, card clearing and the selling loop (no new capability).
 *
 *  1. One chargeback, many codes. Transaction Search may report one chargeback both as a payment reversal (T1106) and as a
 *     chargeback (T1201), and PayPal can never take back more principal than the buyer paid. Per sale: refunds are capped at
 *     the gross, reversals at what refunds left; evidence beyond that is reported (P3), never posted as a second loss; money
 *     given back is capped at what was taken. Fees stay separate (each is a genuine cost).
 *  2. One principal, counted once. A sale's exposure is the larger of (disputed or PayPal-held principal not yet reversed) and
 *     (unclassified debits), never their sum, capped at the principal still in the agent's books, less what PayPal still
 *     holds back from availability anyway. A posted reversal is the confirmed loss; the exposure for it ends.
 *  3. Card credit. Money the owner moved to the card ahead of a charge and not used by it (a pre-funded request charged for
 *     less, or one that expired unused) left the treasury: it is recorded as card credit (fleet:card:credit), applied to the
 *     next charges automatically (the weekly statement then asks only the rest), and the owner can record taking it back.
 *  4. The card receipt's swept share has no default destination: when a return carries a swept share, the owner chooses
 *     treasury or owner each time (applied to the card balance it can only stay in the treasury).
 *  5. Fulfilment honesty. A checkout promising a file by mail is refused while the Fleet's mail is not configured (the agent
 *     is told to sell it on the storefront, which delivers, or as a service); an order whose delivery gave up, or whose buyer
 *     PayPal never reveals, is raised for the owner (P1) with the recovery path (deliver another way, or refund the buyer —
 *     the agent's wallet refund or the dashboard's Orders → Refund (v59) — which reconciles).
 */
import { V53_SQL } from "./migrations-phase53.js";
import { V56_SQL } from "./migrations-phase56.js";
import { V57_SQL } from "./migrations-phase57.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));
const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

export const EVENT_ROUTES_V58 = Object.freeze({
  P1_HIGH: ["order_needs_owner"],
  P3_INFO: ["paypal_evidence_over_principal", "card_credit_recorded", "card_credit_applied", "card_credit_returned"],
} as const);
export const DASHBOARD_SENSITIVE_OPS_V58 = ["card_credit_return"] as const;

const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');`;

// ── 4. The swept share's destination is the owner's choice each time ──
// V57 defines the 7-argument form, then the 6-argument wrapper: restate the former (the text before the wrapper).
const V57_SETTLE_SRC = V57_SQL.slice(0, V57_SQL.indexOf("-- The v51 form (dashboard, CLI and the v48 resolve)"));
const SETTLE = restate(V57_SETTLE_SRC, "fleet_admin_card_receipt_settle", [
  [`DECLARE v_to text := COALESCE(p_sweep_to, 'treasury');`, `DECLARE v_to text := NULLIF(p_sweep_to, '');`],
  [`  IF v_to NOT IN ('treasury','owner') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: sweepTo treasury|owner'; END IF;`,
   `  IF p_method = 'card_balance' AND v_to IS NULL THEN v_to := 'treasury'; END IF; -- nothing reached the owner
  IF v_to IS NOT NULL AND v_to NOT IN ('treasury','owner') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: sweepTo treasury|owner'; END IF;`],
  [`  v_keep := rc.amount_minor - v_s;`,
   `  -- v58: a swept share has no default destination — the owner says where it goes.
  IF p_resolution = 'return' AND v_s > 0 AND v_to IS NULL THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: choose where the swept share goes: treasury (you transfer the full amount) or owner (you keep it: an owner withdrawal)';
  END IF;
  v_keep := rc.amount_minor - v_s;`],
]);

const DASH_CALL = restate(V57_SQL, "dash_call", [
  [`'operator:owner', COALESCE(a ->> 'sweepTo', 'treasury'))`, `'operator:owner', a ->> 'sweepTo')`],
  // v57 added the dispute / debit decisions to dispatch but not to the step-up list (they were refused as unknown): fixed here.
  [`'survival_protection_set','survival_protection_agent_set');`, `'survival_protection_set','survival_protection_agent_set','paypal_dispute_resolve','paypal_debit_classify',${q(DASHBOARD_SENSITIVE_OPS_V58)});`],
  [`      WHEN 'paypal_dispute_resolve' THEN`,
   `      WHEN 'card_credit_return' THEN fleet_admin_card_credit_return((a ->> 'amountMinor')::bigint, a ->> 'reference', 'operator:owner')
      WHEN 'paypal_dispute_resolve' THEN`],
]);

const CLEARING = restate(V53_SQL, "fleet_card_clearing", [
  [`    'reserveMinor', fleet_ledger_balance('fleet:card:reserve'),`,
   `    'reserveMinor', fleet_ledger_balance('fleet:card:reserve'),
    'creditMinor', fleet_ledger_balance('fleet:card:credit'),`],
  [`'sweepMinor', x.sweep_minor, 'at', x.recorded_at,`, `'sweepMinor', x.sweep_minor, 'sweepTo', x.sweep_to, 'at', x.recorded_at,`],
]);

// ── 5. Fulfilment honesty ──
const CHECKOUT = restate(V56_SQL, "fleet_econ_paypal_checkout_order", [
  [`  r := fleet_econ_paypal_checkout(p_agent, a - 'fulfilment');`,
   `  -- v58: never take payment for a file the Fleet cannot deliver yet.
  IF v_kind = 'digital_file' AND NOT fleet_comms_configured('mail') THEN
    RETURN fleet_comms_unavailable(p_agent, 'mail', 'paypal.checkout', 'deliver a sold file by mail', NULL)
      || jsonb_build_object('code', 'FLEET_FULFILMENT_UNAVAILABLE',
           'reason', 'a file sold by PayPal checkout is delivered by the Fleet''s mail, which is not configured yet: sell the file on the storefront '
                     || '(Gumroad delivers it), or sell a service you fulfil yourself (fulfilment service)');
  END IF;
  r := fleet_econ_paypal_checkout(p_agent, a - 'fulfilment');`],
]);

const DELIVERY_FOLLOW = restate(V56_SQL, "fleet_order_delivery_follow", [
  [`      'code', (CASE WHEN NEW.send_error ~ '^[A-Z0-9_]{2,64}$' THEN NEW.send_error ELSE 'FLEET_MAIL_SEND_FAILED' END), 'note', 'delivery failed five times; try another channel or deliver again later'));`,
   `      'code', (CASE WHEN NEW.send_error ~ '^[A-Z0-9_]{2,64}$' THEN NEW.send_error ELSE 'FLEET_MAIL_SEND_FAILED' END), 'note', 'delivery failed five times; try another channel or deliver again later'));
    PERFORM fleet_event('order_needs_owner', o.agent_id, 'controller', jsonb_build_object('orderId', o.order_id, 'reason', 'delivery_failed',
      'note', 'a paid order could not be delivered by mail after five attempts: the agent may deliver it another way or try again; if it cannot, refund the buyer (the agent''s wallet refund, or Orders → Refund in the dashboard)'));`],
]);

const BUYER = restate(V56_SQL, "cx_paypal_buyer_record", [
  [`    UPDATE fleet_customer_orders SET buyer_lookups = buyer_lookups + 1,
           buyer_next_lookup = now() + LEAST(interval '1 minute' * power(2, buyer_lookups), interval '12 hours') WHERE order_id = o.order_id;`,
   `    UPDATE fleet_customer_orders SET buyer_lookups = buyer_lookups + 1,
           buyer_next_lookup = now() + LEAST(interval '1 minute' * power(2, buyer_lookups), interval '12 hours') WHERE order_id = o.order_id;
    IF o.buyer_lookups + 1 = 12 THEN
      PERFORM fleet_event('order_needs_owner', o.agent_id, 'custody', jsonb_build_object('orderId', o.order_id, 'reason', 'buyer_unknown',
        'note', 'PayPal has not revealed this buyer''s e-mail after twelve lookups: find the buyer in PayPal''s activity and deliver, or refund the order (Orders → Refund); the agent keeps trying'));
    END IF;`],
]);

// A send that raises (a mailbox no longer active, mail switched off) waits like an unavailable provider; the pass goes on.
const RETRY = restate(V56_SQL, "svc_order_deliveries_retry", [
  [`    r := fleet_order_delivery_send(d, d.attempts + 1);`,
   `    BEGIN
      r := fleet_order_delivery_send(d, d.attempts + 1);
    EXCEPTION WHEN raise_exception THEN
      r := jsonb_build_object('ok', false, 'code', CASE WHEN split_part(SQLERRM, ':', 1) ~ '^FLEET_[A-Z_]{2,58}$' THEN split_part(SQLERRM, ':', 1) ELSE 'FLEET_MAIL_UNAVAILABLE' END);
    END;`],
]);

const EVENT_ROUTE = restate(V57_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V58) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
]);

export const V58_SQL = `
-- ═══ 1–2. Reconciliation: principal caps; one exposure per sale ═══
CREATE OR REPLACE FUNCTION fleet_paypal_clawback_reconcile(p_checkout uuid, p_worker text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_paypal_checkouts; g text; v_ev bigint; v_target bigint; v_posted bigint; v_delta bigint; r jsonb; v_out jsonb := '{}'::jsonb;
        v_refund bigint := 0; v_reversal bigint := 0; v_fee bigint := 0; v_over bigint := 0;
BEGIN
  SELECT * INTO c FROM fleet_paypal_checkouts WHERE checkout_id = p_checkout FOR UPDATE;
  IF NOT FOUND OR c.status <> 'captured' OR c.purpose <> 'agent_sale' THEN RETURN jsonb_build_object('ok', true, 'skipped', true); END IF;
  FOREACH g IN ARRAY ARRAY['refund','reversal','fee','reversal_return','fee_return'] LOOP
    -- Evidence: the larger source (the same money reported by both counts once), plus the owner's classifications.
    SELECT GREATEST(COALESCE(sum(e.amount_minor) FILTER (WHERE e.source = 'webhook'), 0), COALESCE(sum(e.amount_minor) FILTER (WHERE e.source = 'search'), 0))
           + COALESCE(sum(e.amount_minor) FILTER (WHERE e.source = 'owner'), 0)
      INTO v_ev FROM fleet_paypal_clawback_evidence e WHERE e.checkout_id = p_checkout AND e.grp = g;
    -- v58: PayPal never takes back more principal than was paid, nor gives back more than it took.
    v_target := CASE g WHEN 'refund' THEN LEAST(v_ev, c.amount_minor)
                       WHEN 'reversal' THEN LEAST(v_ev, GREATEST(0, c.amount_minor - v_refund))
                       WHEN 'reversal_return' THEN LEAST(v_ev, v_reversal)
                       WHEN 'fee_return' THEN LEAST(v_ev, v_fee)
                       ELSE v_ev END;
    v_over := v_over + (v_ev - v_target);
    IF g = 'refund' THEN v_refund := v_target; ELSIF g = 'reversal' THEN v_reversal := v_target; ELSIF g = 'fee' THEN v_fee := v_target; END IF;
    SELECT COALESCE(sum(amount_minor), 0) INTO v_posted FROM fleet_paypal_clawback_posts WHERE checkout_id = p_checkout AND grp = g;
    -- What was posted counts towards the caps that follow (a refund posted before v57 included).
    IF g = 'refund' THEN v_refund := GREATEST(v_refund, v_posted); ELSIF g = 'reversal' THEN v_reversal := GREATEST(v_reversal, v_posted);
    ELSIF g = 'fee' THEN v_fee := GREATEST(v_fee, v_posted); END IF;
    v_delta := v_target - v_posted;
    CONTINUE WHEN v_delta <= 0;
    IF g IN ('refund','reversal','fee') THEN
      r := cx_paypal_refund_record(p_worker, c.capture_id, 'R' || substr(md5(p_checkout::text || ':' || g || ':' || (v_posted + v_delta)::text), 1, 30),
             CASE g WHEN 'fee' THEN 'chargeback_fee' ELSE g END, v_delta, c.currency);
    ELSE
      r := fleet_paypal_clawback_return(p_checkout, g, v_delta, p_worker, 'paypal:return:' || substr(md5(p_checkout::text || ':' || g || ':' || (v_posted + v_delta)::text), 1, 30));
    END IF;
    v_out := v_out || jsonb_build_object(g, v_delta);
  END LOOP;
  IF v_out <> '{}'::jsonb THEN
    PERFORM fleet_event('paypal_clawback_reconciled', c.agent_id, 'custody', jsonb_build_object('checkoutId', p_checkout, 'postedMinor', v_out));
  END IF;
  IF v_over > 0 AND NOT EXISTS (SELECT 1 FROM fleet_events WHERE event_type = 'paypal_evidence_over_principal' AND detail ->> 'checkoutId' = p_checkout::text
                                  AND (detail ->> 'overMinor')::bigint = v_over) THEN
    PERFORM fleet_event('paypal_evidence_over_principal', c.agent_id, 'custody', jsonb_build_object('checkoutId', p_checkout, 'overMinor', v_over,
      'note', 'PayPal reported more taken back than this sale''s principal (one chargeback under several codes): counted once'));
  END IF;
  RETURN jsonb_build_object('ok', true, 'posted', v_out);
END $$;

CREATE OR REPLACE FUNCTION fleet_paypal_sale_exposure(p_checkout uuid) RETURNS bigint LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  WITH c AS (SELECT * FROM fleet_paypal_checkouts WHERE checkout_id = p_checkout),
  posted AS (SELECT COALESCE(sum(amount_minor) FILTER (WHERE grp = 'refund'), 0) AS refund, COALESCE(sum(amount_minor) FILTER (WHERE grp = 'reversal'), 0) AS reversal,
                    COALESCE(sum(amount_minor) FILTER (WHERE grp = 'reversal_return'), 0) AS returned
               FROM fleet_paypal_clawback_posts WHERE checkout_id = p_checkout),
  risk AS (SELECT
      -- Disputed or PayPal-held principal not yet reversed (a lost dispute stays at risk until its reversal is posted).
      GREATEST(0, GREATEST(COALESCE((SELECT sum(d.amount_minor) FROM fleet_paypal_disputes d WHERE d.checkout_id = p_checkout AND d.status IN ('open','lost','unresolved')), 0),
                           COALESCE((SELECT sum(e.amount_minor) FROM fleet_paypal_clawback_evidence e WHERE e.checkout_id = p_checkout AND e.grp = 'dispute_hold'), 0))
                  - (SELECT reversal - returned FROM posted)) AS disputed,
      COALESCE((SELECT sum(e.amount_minor) FROM fleet_paypal_clawback_evidence e WHERE e.checkout_id = p_checkout AND e.grp = 'unclassified'
                  AND NOT EXISTS (SELECT 1 FROM fleet_paypal_debit_classifications k WHERE k.ref_id = e.ref_id)), 0) AS unclassified)
  SELECT GREATEST(0,
           LEAST(GREATEST(r.disputed, r.unclassified), GREATEST(0, c.amount_minor - p.refund - p.reversal + p.returned))
           - COALESCE((SELECT a.remaining_minor FROM fleet_paypal_availability a WHERE a.checkout_id = p_checkout AND a.status = 'pending'), 0))::bigint
    FROM c, posted p, risk r
$$;

-- ═══ 3. Card credit ═══
INSERT INTO fleet_ledger_classes (class, kind, normal_side, scope, non_negative, description) VALUES
  ('card_credit', 'asset', 'D', 'fleet', true, 'Money the owner moved from the treasury to the card ahead of charges and not yet used by one (a credit on the card)');
INSERT INTO fleet_ledger_accounts (account_id, class, description, created_by) VALUES ('fleet:card:credit', 'card_credit', 'Card credit (pre-funded, unused)', 'migration');
INSERT INTO fleet_ledger_kinds (kind, requires_external_ref, allowed_sources, multi_agent, description, provenance) VALUES
  ('card_credit_record', true, ARRAY['owner','controller'], false, 'Treasury money moved to the card ahead of a charge and not used by it', 'internal_transfer'),
  ('card_credit_apply',  true, ARRAY['controller'],         false, 'Card credit pays a booked charge; the cash reserved for it returns to the treasury', 'internal_transfer'),
  ('card_credit_return', true, ARRAY['owner'],              false, 'The owner moved card credit back to the treasury', 'internal_transfer');
INSERT INTO fleet_ledger_rules (kind, class, side) VALUES
  ('card_credit_record','card_credit','D'), ('card_credit_record','treasury_cash','C'),
  ('card_credit_apply','card_payable','D'), ('card_credit_apply','card_credit','C'), ('card_credit_apply','treasury_cash','D'), ('card_credit_apply','card_cash_reserve','C'),
  ('card_credit_return','treasury_cash','D'), ('card_credit_return','card_credit','C');

CREATE FUNCTION fleet_card_credit_record(p_amount bigint, p_key text, p_actor text, p_source text, p_why text) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR EXISTS (SELECT 1 FROM fleet_ledger_journal WHERE external_ref = p_key) THEN RETURN; END IF;
  PERFORM fleet_ledger_post('card_credit_record', p_key, p_actor, left('card credit: ' || p_why, 200), p_source, NULL, NULL, NULL, p_key, NULL, now(), jsonb_build_array(
    jsonb_build_object('account', 'fleet:card:credit', 'side', 'D', 'amount', p_amount),
    jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', p_amount)));
  PERFORM fleet_event('card_credit_recorded', NULL, p_actor, jsonb_build_object('amountMinor', p_amount, 'why', left(p_why, 120), 'creditMinor', fleet_ledger_balance('fleet:card:credit')));
END $$;

-- Pre-funded charges: the transfer repays the charge (v54) and any excess becomes card credit; any card credit then pays
-- what is owed on the card.
CREATE OR REPLACE FUNCTION fleet_card_request_prefund_settle(p_charge uuid) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_card_requests; ch fleet_card_charges; v_ref text; v_amount bigint; v_credit bigint; v_key text;
BEGIN
  SELECT * INTO r FROM fleet_card_requests WHERE charge_id = p_charge AND prefund_reference IS NOT NULL;
  IF FOUND THEN
    v_ref := 'prefund:' || r.prefund_reference;
    IF NOT EXISTS (SELECT 1 FROM fleet_card_repayments WHERE reference = v_ref) THEN
      SELECT * INTO ch FROM fleet_card_charges WHERE charge_id = p_charge;
      v_amount := LEAST(r.prefund_minor, ch.amount_minor, fleet_ledger_balance('fleet:card:payable'));
      IF v_amount > 0 THEN PERFORM fleet_admin_card_repayment_record(v_amount, v_ref, r.decided_by); END IF;
      PERFORM fleet_card_credit_record(r.prefund_minor - GREATEST(v_amount, 0), 'card-credit:' || r.prefund_reference, r.decided_by, 'owner',
        'pre-funded ' || r.prefund_minor || ', charged ' || COALESCE(ch.amount_minor, 0));
    END IF;
  END IF;
  -- Card credit pays what is owed on the card (the reserve set aside for it returns to the treasury).
  v_credit := LEAST(fleet_ledger_balance('fleet:card:credit'), fleet_ledger_balance('fleet:card:payable'));
  IF v_credit > 0 THEN
    v_key := 'card-credit-apply:' || p_charge;
    IF NOT EXISTS (SELECT 1 FROM fleet_ledger_journal WHERE external_ref = v_key) THEN
      PERFORM fleet_ledger_post('card_credit_apply', v_key, 'controller', 'card credit pays a booked charge', 'controller', NULL, NULL, NULL, v_key, NULL, now(), jsonb_build_array(
        jsonb_build_object('account', 'fleet:card:payable', 'side', 'D', 'amount', v_credit),
        jsonb_build_object('account', 'fleet:card:credit', 'side', 'C', 'amount', v_credit),
        jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', v_credit),
        jsonb_build_object('account', 'fleet:card:reserve', 'side', 'C', 'amount', v_credit)));
      PERFORM fleet_event('card_credit_applied', NULL, 'controller', jsonb_build_object('chargeId', p_charge, 'amountMinor', v_credit));
    END IF;
  END IF;
END $$;

-- Reaper: a pre-funded request that expired unused leaves its transfer on the card as credit.
CREATE OR REPLACE FUNCTION svc_card_requests_expire() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_card_requests; n integer := 0;
BEGIN
  FOR r IN SELECT * FROM fleet_card_requests WHERE status IN ('approved','pending_owner') AND expires_at <= now() ORDER BY expires_at LIMIT 200 FOR UPDATE SKIP LOCKED LOOP
    UPDATE fleet_card_requests SET status = 'expired' WHERE request_id = r.request_id;
    IF r.prefund_reference IS NOT NULL THEN
      PERFORM fleet_card_credit_record(r.prefund_minor, 'card-credit:' || r.prefund_reference, 'controller', 'controller', 'pre-funded, never used');
      PERFORM fleet_event('card_request_expired', r.agent_id, 'controller', jsonb_build_object('requestId', r.request_id, 'amountMinor', r.amount_minor,
        'prefundReference', r.prefund_reference, 'note', 'approved and funded but never used: the money you moved to the card is recorded as card credit and pays the next charges'));
    END IF;
    n := n + 1;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'expired', n);
END $$;

-- Owner: card credit moved back to the treasury PayPal account.
CREATE FUNCTION fleet_admin_card_credit_return(p_amount bigint, p_reference text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_key text := 'card-credit-return:' || left(trim(COALESCE(p_reference, '')), 100);
BEGIN
  ${OWNER_ACTOR}
  IF p_reference IS NULL OR length(trim(p_reference)) < 2 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the transfer reference'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > fleet_ledger_balance('fleet:card:credit') THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: at most the card credit (%)', fleet_ledger_balance('fleet:card:credit');
  END IF;
  IF EXISTS (SELECT 1 FROM fleet_ledger_journal WHERE external_ref = v_key) THEN RAISE EXCEPTION 'FLEET_ALREADY_CLAIMED: that reference is recorded'; END IF;
  PERFORM fleet_ledger_post('card_credit_return', v_key, p_actor, 'card credit moved back to the treasury', 'owner', NULL, NULL, NULL, v_key, NULL, now(), jsonb_build_array(
    jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', p_amount),
    jsonb_build_object('account', 'fleet:card:credit', 'side', 'C', 'amount', p_amount)));
  PERFORM fleet_event('card_credit_returned', NULL, p_actor, jsonb_build_object('amountMinor', p_amount, 'creditMinor', fleet_ledger_balance('fleet:card:credit')));
  RETURN jsonb_build_object('ok', true, 'creditMinor', fleet_ledger_balance('fleet:card:credit'));
END $$;

${CLEARING}

-- ═══ 4–5 ═══
${SETTLE}

CREATE OR REPLACE FUNCTION fleet_admin_card_receipt_settle(p_receipt uuid, p_resolution text, p_method text, p_sweep bigint, p_reference text, p_actor text)
RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  RETURN fleet_admin_card_receipt_settle(p_receipt, p_resolution, p_method, p_sweep, p_reference, p_actor, NULL::text);
END $$;

${CHECKOUT}

${DELIVERY_FOLLOW}

${RETRY}

${BUYER}

${DASH_CALL}

${EVENT_ROUTE}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

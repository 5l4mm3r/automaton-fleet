/**
 * Schema v77 — treasury integrity (owner brief, 2026-10-14; master specification §31). v76 is deployed (a0e0ac0) and is never
 * edited; what the integrity review found is completed here:
 *
 *  1. Treasury liquidity. Every real outflow the Fleet starts — a payout instruction, a refund — fits the PayPal cash actually
 *     AVAILABLE (custody's latest Balances reading, at most 3 hours old), less what is already committed to leave: issued /
 *     claimed payouts, refunds requested or sent, the card balance still to repay, and what is owed to the owner for AI credit
 *     their card paid. Ledger wallets (which may hold unbacked owner capital) never authorise real cash on their own; a row
 *     lock on the treasury rail serialises payouts and refunds, so two agents cannot spend the same cash. Short of cash the
 *     payment WAITS — still reserved, which is the agent's own money and never exhaustion — and is noted once (P2).
 *  2. Envelope spending (Fleet-allocated capital) gets the same contextual assessment and automated Fleet Control review as
 *     own-capital orders (v64 covered only own capital). No cap is added.
 *  3. AI credit the owner's card paid (v69 payable): the owner's reimbursement — money they move to themselves in PayPal —
 *     is recorded once per PayPal reference, never above what is owed (`economy-ai-credit-reimbursed`).
 * Nothing here moves money, changes a live flag or grants authority.
 */
import { V30_SQL } from "./migrations-phase30.js";
import { V59_SQL } from "./migrations-phase59.js";
import { V64_SQL } from "./migrations-phase64.js";
import { V76_SQL } from "./migrations-phase76.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));
const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

export const EVENT_ROUTES_V77 = Object.freeze({
  P2_IMPORTANT: ["treasury_liquidity_wait"],
  P3_SUMMARY: ["ai_credit_owner_reimbursed"],
} as const);

// ── Treasury liquidity: every real outflow the Fleet starts (a payout instruction, a refund) fits the PayPal cash actually
//    AVAILABLE, less what is already committed to leave (issued / claimed payouts, refunds requested or sent, the card balance
//    still to repay). Ledger wallets (which may hold unbacked capital) never authorise real cash on their own. Serialised by a
//    row lock on the treasury rail (payouts and refunds alike), so two agents cannot spend the same cash. Short of cash, the payment WAITS (still reserved —
//    a reservation is the agent's own money, never exhaustion); nothing fails. A balance older than 3 hours is not relied on. ──
// Envelope spending (Fleet-allocated capital) gets the same contextual assessment and, when flagged, the same automated Fleet
// Control review as own-capital orders (v64 covered only own capital). No cap is added: routine orders pass straight through.
const ENVELOPE_REVIEW = restate(V30_SQL, "fleet_econ_envelope_spend", [
  [`v_hash text; v_refusal text; v_signal text; v_j uuid; v_ttl integer;`, `v_hash text; v_refusal text; v_signal text; v_j uuid; v_ttl integer; v_assess jsonb; v_review uuid;`],
  [`  v_j := fleet_ledger_post('envelope_spend_reservation',`,
   `  v_assess := fleet_spend_review_assess(p_agent, 'payment_order', v_amount, v_dst, d.enrolled_at, true, o.order_id);
  PERFORM fleet_spend_review_use_override(v_assess);
  v_j := fleet_ledger_post('envelope_spend_reservation',`],
  [`  RETURN jsonb_build_object('ok', true, 'order', fleet_order_json(o), 'envelope', fleet_envelope_json((SELECT x FROM fleet_envelopes x WHERE x.envelope_id = e.envelope_id)));`,
   `  IF (v_assess ->> 'review')::boolean THEN
    v_review := fleet_spend_review_open('payment_order', o.order_id, p_agent, v_amount, v_dst, v_assess,
      jsonb_build_object('purpose', o.purpose, 'category', o.category, 'destinationId', v_dst, 'funding', 'envelope', 'envelopeId', e.envelope_id));
    UPDATE fleet_payment_orders SET review_status = 'pending', review_id = v_review WHERE order_id = o.order_id RETURNING * INTO o;
  END IF;
  RETURN jsonb_build_object('ok', true, 'order', fleet_order_json(o) || fleet_order_review_json(o),
    'envelope', fleet_envelope_json((SELECT x FROM fleet_envelopes x WHERE x.envelope_id = e.envelope_id)))
    || CASE WHEN (v_assess ->> 'review')::boolean THEN jsonb_build_object('note', 'reserved; Fleet Control is reviewing this commitment before it is paid (it is '
         || (v_assess ->> 'summary') || '). Keep working: spend_reviews shows the outcome.') ELSE '{}'::jsonb END;`],
]);
/** How old the latest PayPal balance observation may be before outflows wait for a fresh one. */
export const LIQUIDITY_MAX_AGE_HOURS = 3;
const ISSUE_LIQUIDITY = restate(V64_SQL, "svc_issue_payment_instruction", [
  [`        act fleet_custody_activations; lim fleet_agent_wallet_limits; v_day bigint;`,
   `        act fleet_custody_activations; lim fleet_agent_wallet_limits; v_day bigint; v_liq jsonb;`],
  [`  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NO_CUSTODY_SIGNER'); END IF;
`, `  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NO_CUSTODY_SIGNER'); END IF;
  -- v76: real cash. The order stays reserved and is tried again on the next pass.
  IF r.provider = 'paypal' THEN
    PERFORM 1 FROM fleet_payment_rails WHERE rail_id = r.rail_id FOR UPDATE;   -- one treasury, one decision at a time
    v_liq := fleet_treasury_liquidity(r.rail_id);
    IF (v_liq ->> 'stale')::boolean OR (v_liq ->> 'freeMinor')::bigint < o.amount_cents THEN
      PERFORM fleet_treasury_liquidity_wait(o.agent_id, 'payment', o.order_id::text, o.amount_cents, v_liq);
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_TREASURY_LIQUIDITY', 'liquidity', v_liq);
    END IF;
  END IF;
`],
]);
const REFUND_WORK_LIQUIDITY = restate(V59_SQL, "cx_paypal_refund_work", [
  [`DECLARE r jsonb;`, `DECLARE r jsonb; v_free bigint; v_stale boolean; v_liq jsonb; v_ok uuid[] := '{}'; q record;`],
  [`  IF NOT EXISTS (SELECT 1 FROM fleet_custody_activation_live()) THEN RETURN '[]'::jsonb; END IF;
`, `  IF NOT EXISTS (SELECT 1 FROM fleet_custody_activation_live()) THEN RETURN '[]'::jsonb; END IF;
  -- v76: a NEW refund leaves only if the cash is available (retries of one already sent are the same PayPal request).
  FOR q IN SELECT x.request_id, x.amount_minor, x.agent_id, c.rail_id FROM fleet_paypal_refund_requests x JOIN fleet_paypal_checkouts c ON c.checkout_id = x.checkout_id
            WHERE x.status = 'requested' ORDER BY x.created_at LOOP
    IF v_free IS NULL THEN
      PERFORM 1 FROM fleet_payment_rails WHERE rail_id = q.rail_id FOR UPDATE;   -- the same lock the payout issuer takes
      v_liq := fleet_treasury_liquidity(q.rail_id);
      v_stale := (v_liq ->> 'stale')::boolean;
      -- Requested refunds are counted as committed by fleet_treasury_liquidity; they are the candidates here.
      v_free := (v_liq ->> 'freeMinor')::bigint + (v_liq #>> '{committed,refundsRequestedMinor}')::bigint;
    END IF;
    IF NOT v_stale AND q.amount_minor <= v_free THEN v_ok := v_ok || q.request_id; v_free := v_free - q.amount_minor;
    ELSE PERFORM fleet_treasury_liquidity_wait(q.agent_id, 'refund', q.request_id::text, q.amount_minor, v_liq); END IF;
  END LOOP;
`],
  [`WHERE status = 'requested' OR (status = 'sent' AND updated_at < now() - interval '10 minutes')`,
   `WHERE (status = 'requested' AND request_id = ANY (v_ok)) OR (status = 'sent' AND updated_at < now() - interval '10 minutes')`],
]);


const EVENT_ROUTE = restate(V76_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V77) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
]);

export const V77_SQL = `
-- ═══ 1. Treasury liquidity (real outflows fit the PayPal cash actually available) ═══
CREATE FUNCTION fleet_treasury_liquidity(p_rail uuid) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE b fleet_paypal_balance_observations; v_cur text := (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1);
        v_ins bigint; v_req bigint; v_sent bigint; v_card bigint; v_owner bigint; v_avail bigint;
BEGIN
  SELECT * INTO b FROM fleet_paypal_balance_observations WHERE rail_id = p_rail AND currency = v_cur ORDER BY observed_at DESC LIMIT 1;
  v_avail := COALESCE(b.available_minor, 0);
  SELECT COALESCE(sum(amount_cents), 0) INTO v_ins FROM fleet_payment_instructions WHERE payment_rail_id = p_rail AND status IN ('issued','claimed');
  SELECT COALESCE(sum(x.amount_minor) FILTER (WHERE x.status = 'requested'), 0), COALESCE(sum(x.amount_minor) FILTER (WHERE x.status = 'sent'), 0)
    INTO v_req, v_sent FROM fleet_paypal_refund_requests x JOIN fleet_paypal_checkouts c ON c.checkout_id = x.checkout_id WHERE c.rail_id = p_rail;
  v_card := GREATEST(0, fleet_ledger_balance('fleet:card:payable'));
  -- Owed to the owner for AI credit their card paid (v69): reimbursed only by the owner's own payment, never spent by agents.
  v_owner := GREATEST(0, fleet_ledger_balance('fleet:owner:payable'));
  RETURN jsonb_build_object('railId', p_rail, 'currency', v_cur, 'availableMinor', v_avail, 'observedAt', b.observed_at,
    'stale', b.observation_id IS NULL OR b.observed_at < now() - interval '${LIQUIDITY_MAX_AGE_HOURS} hours',
    'committed', jsonb_build_object('paymentsInFlightMinor', v_ins, 'refundsRequestedMinor', v_req, 'refundsSentMinor', v_sent, 'cardToRepayMinor', v_card,
      'owedToOwnerMinor', v_owner),
    'freeMinor', v_avail - v_ins - v_req - v_sent - v_card - v_owner);
END $$;

-- One P2 notice per waiting payment or refund (not on every pass): what waits, how much, and the cash picture.
CREATE FUNCTION fleet_treasury_liquidity_wait(p_agent text, p_kind text, p_ref text, p_amount bigint, p_liq jsonb) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM fleet_events WHERE event_type = 'treasury_liquidity_wait' AND detail ->> 'ref' = p_ref) THEN RETURN; END IF;
  PERFORM fleet_event('treasury_liquidity_wait', p_agent, 'controller', jsonb_build_object('kind', p_kind, 'ref', p_ref, 'amountMinor', p_amount, 'liquidity', p_liq,
    'note', CASE WHEN (p_liq ->> 'stale')::boolean THEN 'waiting for a fresh PayPal balance (custody reads it hourly)'
                 ELSE 'waiting: the PayPal cash available, less what is already committed to leave, does not cover it yet (still reserved; nothing failed)' END));
END $$;

${ISSUE_LIQUIDITY}

${ENVELOPE_REVIEW}

${REFUND_WORK_LIQUIDITY}

-- ═══ 3. AI credit the owner's card paid for: the owner's reimbursement, recorded when the owner pays themselves ═══
-- v69 books what is owed (D treasury:owner_reimbursable / C owner:payable) but nothing recorded the payment itself: the owner
-- moves the money in PayPal (no Fleet payout), then records it here — once per PayPal reference, never more than is owed.
ALTER TABLE fleet_ledger_kinds DISABLE TRIGGER fleet_ledger_kinds_no_change;
INSERT INTO fleet_ledger_kinds (kind, requires_external_ref, allowed_sources, multi_agent, description, provenance) VALUES
  ('owner_payable_reimbursed', true, ARRAY['owner'], false, 'The owner reimbursed themselves from the treasury PayPal for AI credit their card paid (v69 payable settled)', 'owner_withdrawal');
ALTER TABLE fleet_ledger_kinds ENABLE TRIGGER fleet_ledger_kinds_no_change;
INSERT INTO fleet_ledger_rules (kind, class, side) VALUES ('owner_payable_reimbursed','owner_payable','D'), ('owner_payable_reimbursed','treasury_cash','C');
CREATE FUNCTION fleet_admin_owner_payable_reimbursed(p_amount bigint, p_reference text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_owed bigint; v_held bigint; v_key text; v_j uuid;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');
  IF p_reference IS NULL OR p_reference !~ '^[A-Za-z0-9-]{5,64}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the PayPal transaction id of the payment to yourself'; END IF;
  v_key := 'owner-reimbursed:' || p_reference;
  IF EXISTS (SELECT 1 FROM fleet_ledger_journal WHERE external_ref = v_key) THEN RETURN jsonb_build_object('ok', true, 'replay', true); END IF;
  PERFORM 1 FROM fleet_ledger_accounts WHERE account_id IN ('fleet:owner:payable', 'fleet:treasury:owner_reimbursable') ORDER BY account_id FOR UPDATE;
  v_owed := fleet_ledger_balance('fleet:owner:payable');
  v_held := fleet_ledger_balance('fleet:treasury:owner_reimbursable');
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > v_owed OR p_amount > v_held THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: at most what is owed to you (% minor units)', LEAST(v_owed, v_held);
  END IF;
  v_j := fleet_ledger_post('owner_payable_reimbursed', v_key, p_actor, 'owner reimbursed for AI credit their card paid (PayPal ' || p_reference || ')', 'owner', NULL,
    NULL, NULL, v_key, NULL, now(), jsonb_build_array(
      jsonb_build_object('account', 'fleet:owner:payable', 'side', 'D', 'amount', p_amount),
      jsonb_build_object('account', 'fleet:treasury:owner_reimbursable', 'side', 'C', 'amount', p_amount)));
  PERFORM fleet_event('ai_credit_owner_reimbursed', NULL, p_actor, jsonb_build_object('amountMinor', p_amount, 'reference', p_reference, 'journalId', v_j,
    'stillOwedMinor', v_owed - p_amount));
  RETURN jsonb_build_object('ok', true, 'journalId', v_j, 'reimbursedMinor', p_amount, 'stillOwedMinor', v_owed - p_amount);
END $$;

${EVENT_ROUTE}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

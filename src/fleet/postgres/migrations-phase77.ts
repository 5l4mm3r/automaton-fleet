/**
 * Schema v77 — treasury integrity (owner brief, 2026-10-14; master specification §31). v76 is deployed (a0e0ac0) and is never
 * edited; what the integrity review found is completed here:
 *
 *  1. Treasury liquidity. Every real outflow the Fleet starts — a payout instruction, a refund — fits the PayPal cash actually
 *     AVAILABLE in the PayPal ACCOUNT (custody's latest Balances reading for any rail on that account, at most 3 hours old),
 *     less what is committed to leave (payouts issued / claimed, refunds requested / sent, the card balance still to repay, what
 *     is owed to the owner for AI credit their card paid) and less what already left after that reading (payouts settled,
 *     refunds accepted or completed, card repayments and owner reimbursements recorded) — the reading does not show those yet. Ledger wallets (which may hold unbacked owner capital) never authorise real cash on their own; a row
 *     lock on the treasury rail serialises payouts and refunds, so two agents cannot spend the same cash. Short of cash the
 *     payment WAITS — still reserved, which is the agent's own money and never exhaustion — and is noted once (P2).
 *  2. Envelope spending (Fleet-allocated capital) gets the same contextual assessment and automated Fleet Control review as
 *     own-capital orders (v64 covered only own capital). No cap is added.
 *  3. AI credit the owner's card paid (v69 payable): the owner's reimbursement — money they move to themselves in PayPal —
 *     is recorded once per PayPal reference, never above what is owed (`economy-ai-credit-reimbursed`).
 *  4. Contextual capital sizing (opt-in policy key "sizing": "contextual"): Fleet Control lends at most what the treasury can
 *     actually release — fleet_treasury_lendable() = real free cash − every agent's own money held in the account − the owner's
 *     earmarked reserves, never above ledger unallocated capital — instead of fixed fractions of ledger capital; the opportunity
 *     evidence still decides (reject / defer / limits / partial / approve).
 *  5. Owner withdrawals recorded (the Fleet never executes them): profit distribution (≤ Fleet profit not yet distributed) or
 *     capital return (≤ owner capital), once per PayPal transaction id, matched to Transaction Search's row when present;
 *     assessed beforehand against lendable cash; counted as gone from the account until the next reading.
 * Nothing here moves money, changes a live flag or grants authority.
 */
import { V30_SQL } from "./migrations-phase30.js";
import { V51_SQL } from "./migrations-phase51.js";
import { V59_SQL } from "./migrations-phase59.js";
import { V64_SQL } from "./migrations-phase64.js";
import { V76_SQL } from "./migrations-phase76.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));
const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

export const EVENT_ROUTES_V77 = Object.freeze({
  P2_IMPORTANT: ["treasury_liquidity_wait", "owner_withdrawal_recorded"],
  P3_SUMMARY: ["ai_credit_owner_reimbursed"],
} as const);
/** v77: what an owner withdrawal is (recorded after the owner moves the money in PayPal; the Fleet never executes it). */
export const OWNER_WITHDRAWAL_KINDS = ["profit_distribution", "capital_return"] as const;
/** v77: the agents' money held in the PayPal account's AVAILABLE balance (held captures are not available yet). */
export const AGENT_MONEY_CLASSES = ["agent_cash", "agent_reserved", "agent_envelope_cash", "agent_project_escrow", "agent_tax_reserve"] as const;
/** v77: treasury cash earmarked by the owner (never lent or withdrawn as free cash). */
export const EARMARKED_TREASURY = ["fleet:treasury:operating_reserve", "fleet:treasury:contingency", "fleet:treasury:growth_pool"] as const;

// Capital sizing from the actual treasury (opt-in, policy key "sizing": "contextual"). The v30 engine's fixed fractions (reserve,
// per-request, per-agent) give way to what the Fleet can actually lend: real free cash on the PayPal account (v77 liquidity)
// less every agent's own money held there and the owner's earmarked reserves — and never more than ledger unallocated capital.
// Opportunity evidence still decides the outcome (expected value × confidence or measured calibration, return, payback vs runway;
// reject / defer / partial / limits / approve). No reading, no lending (DEFER TREASURY_LIQUIDITY). "fixed" keeps v30 behaviour.
const CAPITAL_POLICY_SET = restate(V30_SQL, "fleet_admin_capital_policy_set", [
  [`'limitedMaxSingleBp','calibrationFloorBp') THEN`, `'limitedMaxSingleBp','calibrationFloorBp','sizing') THEN`],
  [`    calibration_floor_bp = COALESCE((p ->> 'calibrationFloorBp')::integer, calibration_floor_bp),`,
   `    calibration_floor_bp = COALESCE((p ->> 'calibrationFloorBp')::integer, calibration_floor_bp),
    sizing = COALESCE(p ->> 'sizing', sizing),`],
]);
const CAPITAL_DECIDE_CONTEXTUAL = restate(V51_SQL, "fleet_capital_decide", [
  [`        obs jsonb; v_runway numeric; v_short boolean := false;`, `        obs jsonb; v_runway numeric; v_short boolean := false; v_lend jsonb;`],
  [`  v_cap := LEAST(v_room, v_req_cap, v_agent_cap);`,
   `  v_cap := LEAST(v_room, v_req_cap, v_agent_cap);
  IF p.sizing = 'contextual' THEN
    v_lend := fleet_treasury_lendable();
    v_room := GREATEST(0, LEAST(v_unalloc, COALESCE((v_lend ->> 'lendableMinor')::bigint, 0)));
    v_req_cap := 9223372036854775807; v_agent_cap := 9223372036854775807;   -- no fixed shares: real lendable cash bounds the decision
    v_cap := v_room;
  END IF;`],
  [`      'trackRecordRequired', false));`, `      'trackRecordRequired', false, 'sizing', p.sizing, 'lendable', v_lend));`],
]);



// ── Treasury liquidity: every real outflow the Fleet starts (a payout instruction, a refund) fits the PayPal cash actually
//    AVAILABLE, less what is already committed to leave (issued / claimed payouts, refunds requested or sent, the card balance
//    still to repay). Ledger wallets (which may hold unbacked capital) never authorise real cash on their own. Serialised by a
//    lock on every rail record of the PayPal account (payouts and refunds alike), so two agents cannot spend the same cash. Short of cash, the payment WAITS (still reserved —
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
    PERFORM fleet_treasury_lock(r.rail_id);   -- one PayPal account, one decision at a time
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
      PERFORM fleet_treasury_lock(q.rail_id);   -- the same lock the payout issuer takes
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
DECLARE r fleet_payment_rails; b fleet_paypal_balance_observations; v_cur text := (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1);
        v_rails uuid[]; v_at timestamptz; v_ins bigint; v_settled bigint; v_req bigint; v_sent bigint; v_refunded bigint; v_card bigint; v_owner bigint;
        v_card_paid bigint; v_owner_paid bigint; v_withdrawn bigint; v_avail bigint;
BEGIN
  SELECT * INTO r FROM fleet_payment_rails WHERE rail_id = p_rail;
  -- One PayPal ACCOUNT, however many rail records point at it (the same credential, or the same masked account of the same entity).
  SELECT array_agg(x.rail_id) INTO v_rails FROM fleet_payment_rails x
   WHERE x.provider = r.provider AND (x.rail_id = r.rail_id OR x.credential_id = r.credential_id
          OR (x.account_ref = r.account_ref AND x.legal_entity_id = r.legal_entity_id));
  SELECT * INTO b FROM fleet_paypal_balance_observations WHERE rail_id = ANY (v_rails) AND currency = v_cur ORDER BY observed_at DESC LIMIT 1;
  v_avail := COALESCE(b.available_minor, 0);
  v_at := COALESCE(b.observed_at, '-infinity'::timestamptz);
  -- Still to leave: payouts issued / claimed; refunds requested / sent.
  SELECT COALESCE(sum(amount_cents) FILTER (WHERE status IN ('issued','claimed')), 0),
         -- Already left, but after the reading: PayPal's available balance does not show it yet.
         COALESCE(sum(COALESCE(settled_cents, amount_cents)) FILTER (WHERE status = 'settled' AND finished_at > v_at), 0)
    INTO v_ins, v_settled FROM fleet_payment_instructions WHERE payment_rail_id = ANY (v_rails);
  SELECT COALESCE(sum(x.amount_minor) FILTER (WHERE x.status = 'requested'), 0), COALESCE(sum(x.amount_minor) FILTER (WHERE x.status = 'sent'), 0),
         COALESCE(sum(x.amount_minor) FILTER (WHERE x.status IN ('pending','completed') AND x.updated_at > v_at), 0)
    INTO v_req, v_sent, v_refunded FROM fleet_paypal_refund_requests x JOIN fleet_paypal_checkouts c ON c.checkout_id = x.checkout_id WHERE c.rail_id = ANY (v_rails);
  -- Owed and not yet paid from the account: the card balance, and AI credit the owner's card paid (v69).
  v_card := GREATEST(0, fleet_ledger_balance('fleet:card:payable'));
  v_owner := GREATEST(0, fleet_ledger_balance('fleet:owner:payable'));
  -- Paid by hand from the account after the reading (the owner's card repayment and reimbursement transfers).
  SELECT COALESCE(sum(p.amount_cents) FILTER (WHERE j.kind = 'card_repayment' AND p.account_id = 'fleet:card:payable' AND p.side = 'D'), 0),
         COALESCE(sum(p.amount_cents) FILTER (WHERE j.kind = 'owner_payable_reimbursed' AND p.account_id = 'fleet:owner:payable' AND p.side = 'D'), 0)
    INTO v_card_paid, v_owner_paid FROM fleet_ledger_journal j JOIN fleet_ledger_postings p ON p.journal_id = j.journal_id
   WHERE j.kind IN ('card_repayment','owner_payable_reimbursed') AND j.recorded_at > v_at;
  -- Owner withdrawals (profit distributions, capital returns) recorded after the reading. The table is created later in this
  -- migration; plpgsql resolves it at call time.
  SELECT COALESCE(sum(amount_minor), 0) INTO v_withdrawn FROM fleet_owner_withdrawal_records WHERE recorded_at > v_at;
  RETURN jsonb_build_object('railId', p_rail, 'accountRails', to_jsonb(v_rails), 'currency', v_cur, 'availableMinor', v_avail, 'observedAt', b.observed_at,
    'stale', b.observation_id IS NULL OR b.observed_at < now() - interval '${LIQUIDITY_MAX_AGE_HOURS} hours',
    'committed', jsonb_build_object('paymentsInFlightMinor', v_ins, 'refundsRequestedMinor', v_req, 'refundsSentMinor', v_sent, 'cardToRepayMinor', v_card,
      'owedToOwnerMinor', v_owner),
    'leftSinceReading', jsonb_build_object('paymentsSettledMinor', v_settled, 'refundsMinor', v_refunded, 'cardRepaidMinor', v_card_paid, 'ownerReimbursedMinor', v_owner_paid,
      'ownerWithdrawnMinor', v_withdrawn),
    'freeMinor', v_avail - v_ins - v_req - v_sent - v_card - v_owner - v_settled - v_refunded - v_card_paid - v_owner_paid - v_withdrawn);
END $$;

-- Serialise every real-cash decision on one PayPal account: lock all its rail records, always in the same order.
CREATE FUNCTION fleet_treasury_lock(p_rail uuid) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_payment_rails;
BEGIN
  SELECT * INTO r FROM fleet_payment_rails WHERE rail_id = p_rail;
  PERFORM 1 FROM fleet_payment_rails x
   WHERE x.provider = r.provider AND (x.rail_id = r.rail_id OR x.credential_id = r.credential_id OR (x.account_ref = r.account_ref AND x.legal_entity_id = r.legal_entity_id))
   ORDER BY x.rail_id FOR UPDATE;
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

-- ═══ 4. What the Fleet can actually release: real free cash less everyone else's money ═══
ALTER TABLE fleet_capital_policy ADD COLUMN sizing text NOT NULL DEFAULT 'fixed' CHECK (sizing IN ('fixed','contextual'));
CREATE FUNCTION fleet_treasury_lendable() RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_rail uuid; v_liq jsonb; v_agents bigint; v_earmarked bigint;
BEGIN
  SELECT rail_id INTO v_rail FROM fleet_payment_rails WHERE provider = 'paypal' AND rail_kind = 'shared' AND status = 'active' AND mode = 'live'
   ORDER BY rail_id LIMIT 1;
  IF v_rail IS NULL THEN RETURN jsonb_build_object('known', false, 'reason', 'no live PayPal treasury rail', 'lendableMinor', 0); END IF;
  v_liq := fleet_treasury_liquidity(v_rail);
  SELECT COALESCE(sum(fleet_ledger_balance(a.account_id)), 0) INTO v_agents FROM fleet_ledger_accounts a WHERE a.class IN (${q(AGENT_MONEY_CLASSES)});
  SELECT COALESCE(sum(fleet_ledger_balance(x)), 0) INTO v_earmarked FROM unnest(ARRAY[${q(EARMARKED_TREASURY)}]) x;
  IF (v_liq ->> 'stale')::boolean THEN
    RETURN jsonb_build_object('known', false, 'reason', 'no PayPal balance reading in the last ${LIQUIDITY_MAX_AGE_HOURS} hours', 'lendableMinor', 0, 'liquidity', v_liq);
  END IF;
  RETURN jsonb_build_object('known', true, 'railId', v_rail, 'freeMinor', (v_liq ->> 'freeMinor')::bigint, 'agentsMoneyMinor', v_agents, 'earmarkedMinor', v_earmarked,
    'lendableMinor', GREATEST(0, (v_liq ->> 'freeMinor')::bigint - v_agents - v_earmarked), 'liquidity', v_liq);
END $$;

${CAPITAL_POLICY_SET}

${CAPITAL_DECIDE_CONTEXTUAL}

-- ═══ 5. Owner withdrawals: a profit distribution or a capital return, recorded after the owner moves the money in PayPal ═══
-- The Fleet never executes them (custody pays only agents' orders; PayPal Payouts cannot pay the account itself): the owner
-- withdraws to their bank in PayPal, then records it here with PayPal's transaction id — once per id; never more profit than
-- has been contributed and not yet distributed, never more capital than contributed; the id is matched to Transaction Search's
-- row when present (and refused if that row is already attributed to something else). AI-credit reimbursement stays its own
-- record (§3). fleet_owner_withdrawal_assess tells the owner beforehand whether an amount is free cash.
CREATE TABLE fleet_owner_withdrawal_records (
  record_id      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           text        NOT NULL CHECK (kind IN (${q(OWNER_WITHDRAWAL_KINDS)})),
  amount_minor   bigint      NOT NULL CHECK (amount_minor > 0),
  currency       text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  paypal_txn_id  text        NOT NULL UNIQUE CHECK (paypal_txn_id ~ '^[A-Z0-9]{5,40}$'),
  evidence       text        NOT NULL CHECK (evidence IN ('transaction_search','owner_attested')),
  note           text        CHECK (length(note) <= 300),
  journal_id     uuid        NOT NULL REFERENCES fleet_ledger_journal(journal_id),
  recorded_by    text        NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_owner_withdrawal_records_immutable BEFORE UPDATE OR DELETE ON fleet_owner_withdrawal_records FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
ALTER TABLE fleet_paypal_transactions DROP CONSTRAINT fleet_paypal_transactions_attributed_as_check;
ALTER TABLE fleet_paypal_transactions ADD CONSTRAINT fleet_paypal_transactions_attributed_as_check
  CHECK (attributed_as IN ('owner_funding','agent_revenue','not_revenue','provider_payout','capital_backing','ai_credit_purchase','owner_withdrawal'));
ALTER TABLE fleet_ledger_kinds DISABLE TRIGGER fleet_ledger_kinds_no_change;
INSERT INTO fleet_ledger_kinds (kind, requires_external_ref, allowed_sources, multi_agent, description, provenance) VALUES
  ('owner_profit_distribution', true, ARRAY['owner'], false, 'Fleet profit distributed to the owner (moved by the owner in PayPal; recorded once)', 'owner_withdrawal'),
  ('owner_capital_return', true, ARRAY['owner'], false, 'Owner capital returned to the owner (moved by the owner in PayPal; recorded once)', 'owner_withdrawal');
ALTER TABLE fleet_ledger_kinds ENABLE TRIGGER fleet_ledger_kinds_no_change;
INSERT INTO fleet_ledger_rules (kind, class, side) VALUES
  ('owner_profit_distribution','owner_withdrawals','D'), ('owner_profit_distribution','treasury_cash','C'),
  ('owner_capital_return','owner_capital','D'), ('owner_capital_return','treasury_cash','C');

CREATE FUNCTION fleet_owner_withdrawable(p_kind text) RETURNS bigint LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT GREATEST(0, CASE p_kind
    -- Lifetime Fleet Contribution (realised net profit contributed by agents) not yet distributed.
    WHEN 'profit_distribution' THEN fleet_ledger_balance('fleet:profit')
         - COALESCE((SELECT sum(amount_minor) FROM fleet_owner_withdrawal_records WHERE kind = 'profit_distribution'), 0)
    -- Capital the owner contributed and has not taken back.
    WHEN 'capital_return' THEN fleet_ledger_balance('fleet:owner:capital') END)
$$;

CREATE FUNCTION fleet_admin_owner_withdrawal_assess(p_kind text, p_amount bigint) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_lend jsonb := fleet_treasury_lendable(); v_max bigint; v_unalloc bigint := fleet_ledger_balance('fleet:treasury:unallocated');
BEGIN
  IF p_kind NOT IN (${q(OWNER_WITHDRAWAL_KINDS)}) THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: profit_distribution or capital_return'; END IF;
  v_max := fleet_owner_withdrawable(p_kind);
  RETURN jsonb_build_object('kind', p_kind, 'amountMinor', p_amount, 'withdrawableMinor', v_max, 'treasuryUnallocatedMinor', v_unalloc, 'lendable', v_lend,
    'safe', (v_lend ->> 'known')::boolean AND p_amount > 0 AND p_amount <= v_max AND p_amount <= v_unalloc AND p_amount <= (v_lend ->> 'lendableMinor')::bigint,
    'how', 'in PayPal: withdraw to your bank (the Fleet never moves it; PayPal Payouts cannot pay this account itself); then record it with economy-owner-withdrawal '
           || p_kind || ' <amountMinor> <paypalTxnId>');
END $$;

CREATE FUNCTION fleet_admin_owner_withdrawal_record(p_kind text, p_amount bigint, p_txn text, p_note text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_cur text := (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1); t fleet_paypal_transactions; v_max bigint; v_j uuid; x fleet_owner_withdrawal_records;
        v_evidence text := 'owner_attested'; v_key text;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');
  IF p_kind NOT IN (${q(OWNER_WITHDRAWAL_KINDS)}) THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: profit_distribution or capital_return'; END IF;
  IF p_txn IS NULL OR p_txn !~ '^[A-Z0-9]{5,40}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: PayPal''s transaction id of the withdrawal'; END IF;
  SELECT * INTO x FROM fleet_owner_withdrawal_records WHERE paypal_txn_id = p_txn;
  IF FOUND THEN
    IF x.kind <> p_kind OR x.amount_minor <> p_amount THEN RAISE EXCEPTION 'FLEET_ALREADY_CLAIMED: that PayPal transaction is already recorded as % %', x.kind, x.amount_minor; END IF;
    RETURN jsonb_build_object('ok', true, 'replay', true, 'recordId', x.record_id);
  END IF;
  -- Evidence: Transaction Search's own row for that id, when it has arrived (a debit of the account, not claimed for anything else).
  SELECT * INTO t FROM fleet_paypal_transactions WHERE transaction_id = p_txn ORDER BY initiated_at DESC LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    IF t.amount_minor >= 0 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: PayPal shows that transaction as money received, not a withdrawal'; END IF;
    IF t.checkout_id IS NOT NULL OR (t.attributed_as IS NOT NULL AND t.attributed_as <> 'owner_withdrawal') THEN
      RAISE EXCEPTION 'FLEET_ALREADY_CLAIMED: that PayPal transaction is already accounted for (%)', COALESCE(t.attributed_as, 'a sale');
    END IF;
    IF -t.amount_minor <> p_amount OR t.currency <> v_cur THEN
      RAISE EXCEPTION 'FLEET_BAD_REQUEST: PayPal shows % % for that transaction', -t.amount_minor, t.currency;
    END IF;
    v_evidence := 'transaction_search';
  END IF;
  PERFORM 1 FROM fleet_ledger_accounts WHERE account_id IN ('fleet:profit', 'fleet:owner:capital', 'fleet:treasury:unallocated') ORDER BY account_id FOR UPDATE;
  v_max := fleet_owner_withdrawable(p_kind);
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > v_max THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: at most % minor units can be recorded as %', v_max, p_kind;
  END IF;
  v_key := 'owner-withdrawal:' || p_txn;
  v_j := fleet_ledger_post(CASE p_kind WHEN 'profit_distribution' THEN 'owner_profit_distribution' ELSE 'owner_capital_return' END, v_key, p_actor,
    CASE p_kind WHEN 'profit_distribution' THEN 'Fleet profit distributed to the owner' ELSE 'owner capital returned' END || ' (PayPal ' || p_txn || ')', 'owner', NULL,
    NULL, NULL, v_key, NULL, now(), jsonb_build_array(
      jsonb_build_object('account', CASE p_kind WHEN 'profit_distribution' THEN 'fleet:owner:withdrawals' ELSE 'fleet:owner:capital' END, 'side', 'D', 'amount', p_amount),
      jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', p_amount)));
  INSERT INTO fleet_owner_withdrawal_records (kind, amount_minor, currency, paypal_txn_id, evidence, note, journal_id, recorded_by)
    VALUES (p_kind, p_amount, v_cur, p_txn, v_evidence, left(p_note, 300), v_j, p_actor) RETURNING * INTO x;
  IF v_evidence = 'transaction_search' THEN
    UPDATE fleet_paypal_transactions SET attributed_as = 'owner_withdrawal', attributed_ref = x.record_id::text, attributed_by = p_actor, attributed_at = now()
     WHERE rail_id = t.rail_id AND transaction_id = t.transaction_id AND event_code = t.event_code AND initiated_at = t.initiated_at;
  END IF;
  PERFORM fleet_event('owner_withdrawal_recorded', NULL, p_actor, jsonb_build_object('recordId', x.record_id, 'kind', p_kind, 'amountMinor', p_amount,
    'paypalTxnId', p_txn, 'evidence', v_evidence, 'stillWithdrawableMinor', v_max - p_amount));
  RETURN jsonb_build_object('ok', true, 'recordId', x.record_id, 'journalId', v_j, 'evidence', v_evidence, 'stillWithdrawableMinor', v_max - p_amount);
END $$;

${EVENT_ROUTE}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

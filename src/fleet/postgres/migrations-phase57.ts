/**
 * Schema v57 — the two accounting questions left open by v56, closed before deployment.
 *
 *  1. Refunds, reversals, chargebacks, dispute holds and fees of a PayPal sale are reconciled from EVIDENCE, never posted
 *     twice. Each source records what it saw (webhooks by PayPal's event resource id, Transaction Search by transaction id):
 *     per sale and per group (refund / reversal / fee / their returns), the amount that must have left the agent is the
 *     LARGER of the two sources' totals (each source is complete but may lag; the same money reported by both counts once),
 *     plus anything the owner classified. Only the difference from what is already posted is posted.
 *     An open or unresolved dispute, money PayPal holds for one (T1110 / T1111), and a debit Transaction Search cannot
 *     classify are EXPOSURE: deducted from the agent's survival equity (so nothing spendable is overstated) and shown as
 *     money of its own held (so a dispute alone never ends an agent). A dispute resolution PayPal does not state plainly is
 *     left for the owner to resolve; an unclassified debit for the owner to classify.
 *  2. A card receipt settled as a RETURN keeps the swept share in the treasury (the existing sweep policy: an internal
 *     net-profit contribution, never a payment to the owner; OWNER_SWEEP_ENABLED stays false). The owner keeping the swept
 *     share is an explicit choice, recorded as an owner withdrawal and labelled so; it is refused when the money only
 *     reduced the card balance (the owner received nothing).
 */
import { V51_SQL } from "./migrations-phase51.js";
import { V56_SQL } from "./migrations-phase56.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));
const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

export const EVENT_ROUTES_V57 = Object.freeze({
  P1_HIGH: ["paypal_dispute_opened", "paypal_dispute_unresolved", "paypal_debit_unclassified"],
  P2_IMPORTANT: ["paypal_dispute_resolved", "paypal_dispute_set_by_owner"],
  P3_INFO: ["paypal_clawback_reconciled", "paypal_debit_classified"],
} as const);
export const DASHBOARD_READ_OPS_V57 = ["paypal_disputes"] as const;
export const DASHBOARD_SENSITIVE_OPS_V57 = ["paypal_dispute_resolve", "paypal_debit_classify"] as const;
/** Transaction Search event codes, by what they do to a sale (PayPal's published code list; verified at first live use). */
export const PAYPAL_CLAWBACK_CODES = Object.freeze({
  refund: ["T1107"], reversal: ["T1106", "T1201"], reversal_return: ["T1202"], fee: ["T0106"], fee_return: ["T1108"], dispute_hold: ["T1110", "T1111"],
} as const);

const WORKER = `IF p_worker IS NULL OR p_worker !~ '^[a-z0-9-]{3,40}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: worker name'; END IF;`;
const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');`;
const C = PAYPAL_CLAWBACK_CODES;

// ── 1. Posted clawbacks are recorded per sale and group (whatever posted them) ──
const REFUND = restate(V56_SQL, "cx_paypal_refund_record", [
  [`  INSERT INTO fleet_revenue_claims (claim_key, claim_kind, journal_id, claimed_by) VALUES (v_key, 'paypal_refund', v_j, 'custody:' || p_worker);`,
   `  INSERT INTO fleet_revenue_claims (claim_key, claim_kind, journal_id, claimed_by) VALUES (v_key, 'paypal_refund', v_j, 'custody:' || p_worker);
  INSERT INTO fleet_paypal_clawback_posts (claim_key, checkout_id, grp, amount_minor, journal_id)
    VALUES (v_key, c.checkout_id, CASE p_kind WHEN 'refund' THEN 'refund' WHEN 'reversal' THEN 'reversal' ELSE 'fee' END, p_amount, v_j);`],
]);

// ── 2. Survival equity carries the dispute exposure; the measure shows it as the agent's own money held ──
const ECONOMICS = restate(V51_SQL, "fleet_agent_economics", [
  [`        v_holds bigint; v_pending bigint;`, `        v_holds bigint; v_pending bigint; v_dispute bigint;`],
  [`  v_eq := v_rec - v_principal - v_oblig - v_payable;`,
   `  -- v57: money a PayPal dispute, hold or unclassified debit may yet take back is not the agent's to spend.
  v_dispute := fleet_paypal_dispute_exposure(p_agent);
  v_eq := v_rec - v_principal - v_oblig - v_payable - v_dispute;`],
  [`    'cardHoldsReserved', v_holds, 'cashPendingAvailability', v_pending);`,
   `    'cardHoldsReserved', v_holds, 'cashPendingAvailability', v_pending, 'paypalDisputeExposure', v_dispute);`],
]);

const MEASURE = restate(V51_SQL, "fleet_agent_wallet_measure", [
  [`        v_spend bigint; v_own bigint; v_in bigint; v_open bigint; v_env bigint; m jsonb; v_orders bigint;`,
   `        v_spend bigint; v_own bigint; v_in bigint; v_open bigint; v_env bigint; m jsonb; v_orders bigint; v_disp bigint; v_disp_held bigint;`],
  [`  v_in := v_pending + v_cap_pending + v_card;`,
   `  -- v57: disputed money still in the wallet is held (it may come back to the agent), not spendable and not gone.
  v_disp := COALESCE((e ->> 'paypalDisputeExposure')::bigint, 0);
  v_disp_held := LEAST(v_disp, GREATEST(v_cash, 0));
  v_in := v_pending + v_cap_pending + v_card + v_disp_held;`],
  [`'paypalCapturePendingMinor', v_cap_pending, 'paidToOwnerCardMinor', v_card),`,
   `'paypalCapturePendingMinor', v_cap_pending, 'paidToOwnerCardMinor', v_card, 'paypalDisputedMinor', v_disp_held),
    'paypalDisputeExposureMinor', v_disp,`],
]);

// ── 3. Card receipts: where the swept share goes ──
const SETTLE = restate(V51_SQL, "fleet_admin_card_receipt_settle", [
  [`p_reference text, p_actor text)\nRETURNS jsonb`, `p_reference text, p_actor text, p_sweep_to text)\nRETURNS jsonb`],
  [`DECLARE rc fleet_card_receipts; v_j uuid;`, `DECLARE v_to text := COALESCE(p_sweep_to, 'treasury'); rc fleet_card_receipts; v_j uuid;`],
  [`    RAISE EXCEPTION 'FLEET_BAD_REQUEST: resolution return|withdrawal, method transfer|card_balance';
  END IF;`,
   `    RAISE EXCEPTION 'FLEET_BAD_REQUEST: resolution return|withdrawal, method transfer|card_balance';
  END IF;
  -- v57: the swept share of a return stays in the treasury unless the owner explicitly keeps it (an owner withdrawal).
  IF v_to NOT IN ('treasury','owner') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: sweepTo treasury|owner'; END IF;
  IF p_resolution = 'return' AND p_method = 'card_balance' AND v_to = 'owner' THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: applied to the card balance, the money never reached you: the swept share stays in the treasury';
  END IF;`],
  [`    jsonb_build_object('account', 'fleet:owner:withdrawals', 'side', 'D', 'amount', v_s),`,
   `    jsonb_build_object('account', CASE WHEN p_resolution = 'return' AND v_to = 'treasury' THEN 'fleet:treasury:unallocated' ELSE 'fleet:owner:withdrawals' END, 'side', 'D', 'amount', v_s),`],
  [`      || CASE WHEN p_method = 'card_balance' THEN ' (applied to the card balance)' ELSE '' END, 'owner', rc.agent_id`,
   `      || CASE WHEN p_method = 'card_balance' THEN ' (applied to the card balance)' ELSE '' END
      || CASE WHEN p_resolution = 'return' AND v_s > 0 THEN CASE WHEN v_to = 'treasury' THEN '; the swept share stays in the treasury'
                                                             ELSE '; the swept share was kept by the owner (an owner withdrawal)' END ELSE '' END, 'owner', rc.agent_id`],
  [`  UPDATE fleet_card_receipts SET status = CASE WHEN p_resolution = 'return' THEN 'returned' ELSE 'withdrawn' END, sweep_minor = v_s, method = p_method,`,
   `  UPDATE fleet_card_receipts SET status = CASE WHEN p_resolution = 'return' THEN 'returned' ELSE 'withdrawn' END, sweep_minor = v_s, method = p_method,
         sweep_to = CASE WHEN p_resolution = 'return' AND v_s > 0 THEN v_to END,`],
  [`    jsonb_build_object('receiptId', p_receipt, 'returnedMinor', v_keep, 'sweepMinor', v_s, 'method', p_method));`,
   `    jsonb_build_object('receiptId', p_receipt, 'returnedMinor', v_keep, 'sweepMinor', v_s, 'method', p_method,
      'sweepTo', CASE WHEN p_resolution = 'return' AND v_s > 0 THEN v_to END));`],
  [`'returnedMinor', v_keep, 'sweepMinor', v_s, 'withdrawnMinor',`,
   `'returnedMinor', v_keep, 'sweepMinor', v_s, 'sweepTo', CASE WHEN p_resolution = 'return' AND v_s > 0 THEN v_to END,
    'ownerTransferMinor', CASE WHEN p_resolution = 'return' AND p_method = 'transfer' THEN CASE WHEN v_to = 'treasury' THEN rc.amount_minor ELSE v_keep END END,
    'withdrawnMinor',`],
]);

const DASH_CALL = restate(V56_SQL, "dash_call", [
  [`          (a ->> 'sweepMinor')::bigint, a ->> 'reference', 'operator:owner')`,
   `          (a ->> 'sweepMinor')::bigint, a ->> 'reference', 'operator:owner', COALESCE(a ->> 'sweepTo', 'treasury'))`],
  [`,${q(["customer_orders"])})) THEN`, `,${q(["customer_orders"])},${q(DASHBOARD_READ_OPS_V57)})) THEN`],
  [`      WHEN 'customer_orders' THEN fleet_customer_orders_json(a ->> 'agentId')`,
   `      WHEN 'customer_orders' THEN fleet_customer_orders_json(a ->> 'agentId')
      WHEN 'paypal_disputes' THEN fleet_paypal_disputes_json()`],
  [`      WHEN 'card_request_decide' THEN`,
   `      WHEN 'paypal_dispute_resolve' THEN fleet_admin_paypal_dispute_resolve(a ->> 'disputeId', a ->> 'outcome', a ->> 'note', 'operator:owner')
      WHEN 'paypal_debit_classify' THEN fleet_admin_paypal_debit_classify(a ->> 'refId', a ->> 'as', a ->> 'note', 'operator:owner')
      WHEN 'card_request_decide' THEN`],
]);

const EVENT_ROUTE = restate(V56_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V57) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
]);

export const V57_SQL = `
-- ═══ 1. Evidence, posts and disputes ═══
CREATE TABLE fleet_paypal_clawback_evidence (
  source       text        NOT NULL CHECK (source IN ('webhook','search','owner')),
  ref_id       text        NOT NULL CHECK (ref_id ~ '^[A-Za-z0-9:-]{3,90}$'),
  grp          text        NOT NULL CHECK (grp IN ('refund','reversal','fee','reversal_return','fee_return','dispute_hold','unclassified')),
  checkout_id  uuid        NOT NULL REFERENCES fleet_paypal_checkouts(checkout_id),
  -- Positive: taken from the sale (or, for the *_return groups, given back); for dispute_hold a release is negative.
  amount_minor bigint      NOT NULL CHECK (amount_minor <> 0 AND (grp = 'dispute_hold' OR amount_minor > 0)),
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, ref_id, grp)
);
CREATE INDEX fleet_paypal_clawback_evidence_checkout ON fleet_paypal_clawback_evidence (checkout_id, grp);
CREATE TRIGGER fleet_paypal_clawback_evidence_no_change BEFORE UPDATE OR DELETE ON fleet_paypal_clawback_evidence FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_paypal_clawback_evidence_no_truncate BEFORE TRUNCATE ON fleet_paypal_clawback_evidence FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_paypal_clawback_posts (
  claim_key    text        PRIMARY KEY,
  checkout_id  uuid        NOT NULL REFERENCES fleet_paypal_checkouts(checkout_id),
  grp          text        NOT NULL CHECK (grp IN ('refund','reversal','fee','reversal_return','fee_return')),
  amount_minor bigint      NOT NULL CHECK (amount_minor > 0),
  journal_id   uuid        REFERENCES fleet_ledger_journal(journal_id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_paypal_clawback_posts_checkout ON fleet_paypal_clawback_posts (checkout_id, grp);
CREATE TRIGGER fleet_paypal_clawback_posts_no_change BEFORE UPDATE OR DELETE ON fleet_paypal_clawback_posts FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_paypal_clawback_posts_no_truncate BEFORE TRUNCATE ON fleet_paypal_clawback_posts FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
-- What was posted before v57 (refunds, reversals and fees by their own ids) counts as posted, so evidence never posts it again.
INSERT INTO fleet_paypal_clawback_posts (claim_key, checkout_id, grp, amount_minor)
  SELECT 'legacy:' || ev.id::text, (ev.detail ->> 'checkoutId')::uuid,
         CASE ev.detail ->> 'kind' WHEN 'refund' THEN 'refund' WHEN 'reversal' THEN 'reversal' ELSE 'fee' END, (ev.detail ->> 'amountMinor')::bigint
    FROM fleet_events ev WHERE ev.event_type = 'paypal_clawback_posted' AND (ev.detail ->> 'amountMinor')::bigint > 0
     AND EXISTS (SELECT 1 FROM fleet_paypal_checkouts c WHERE c.checkout_id::text = ev.detail ->> 'checkoutId');

CREATE TABLE fleet_paypal_disputes (
  dispute_id   text        PRIMARY KEY CHECK (dispute_id ~ '^[A-Za-z0-9-]{5,64}$'),
  checkout_id  uuid        NOT NULL REFERENCES fleet_paypal_checkouts(checkout_id),
  agent_id     text        NOT NULL REFERENCES fleet_agents(agent_id),
  amount_minor bigint      NOT NULL CHECK (amount_minor > 0),
  currency     text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status       text        NOT NULL CHECK (status IN ('open','won','lost','unresolved')),
  outcome      text        CHECK (outcome ~ '^[A-Z_]{2,40}$'),
  set_by       text        NOT NULL,
  note         text        CHECK (length(note) <= 300),
  opened_at    timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_paypal_disputes_checkout ON fleet_paypal_disputes (checkout_id);
CREATE TRIGGER fleet_paypal_disputes_no_delete BEFORE DELETE ON fleet_paypal_disputes FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- The owner's classification of a debit Transaction Search could not classify (history).
CREATE TABLE fleet_paypal_debit_classifications (
  ref_id        text        PRIMARY KEY,
  classified_as text        NOT NULL CHECK (classified_as IN ('refund','reversal','fee','not_this_sale')),
  note          text        CHECK (length(note) <= 300),
  set_by        text        NOT NULL,
  set_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_paypal_debit_classifications_no_change BEFORE UPDATE OR DELETE ON fleet_paypal_debit_classifications FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

ALTER TABLE fleet_card_receipts ADD COLUMN sweep_to text CHECK (sweep_to IN ('treasury','owner'));

INSERT INTO fleet_ledger_kinds (kind, requires_external_ref, allowed_sources, multi_agent, description, provenance) VALUES
  ('paypal_clawback_return', true, ARRAY['executor'], false, 'Money PayPal gave back to a sale after a reversal or fee (a dispute won, a fee reversed)', 'external_customer_revenue');
INSERT INTO fleet_ledger_rules (kind, class, side) VALUES
  ('paypal_clawback_return','agent_cash','D'), ('paypal_clawback_return','agent_revenue','C'), ('paypal_clawback_return','agent_fees','C'),
  -- v57: a returned card receipt's swept share stays in the treasury.
  ('card_receipt_return','treasury_cash','D');

-- Money a sale may still lose: open / lost-but-not-yet-reversed / unresolved disputes and PayPal's dispute holds (the larger
-- of the two sources), less what has already been reversed and what PayPal still holds back anyway; plus debits nobody has
-- classified yet.
CREATE FUNCTION fleet_paypal_sale_exposure(p_checkout uuid) RETURNS bigint LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT GREATEST(0,
           GREATEST(COALESCE((SELECT sum(d.amount_minor) FROM fleet_paypal_disputes d WHERE d.checkout_id = p_checkout AND d.status IN ('open','lost','unresolved')), 0),
                    COALESCE((SELECT sum(e.amount_minor) FROM fleet_paypal_clawback_evidence e WHERE e.checkout_id = p_checkout AND e.grp = 'dispute_hold'), 0))
           - COALESCE((SELECT sum(p.amount_minor) FROM fleet_paypal_clawback_posts p WHERE p.checkout_id = p_checkout AND p.grp = 'reversal'), 0)
           - COALESCE((SELECT a.remaining_minor FROM fleet_paypal_availability a WHERE a.checkout_id = p_checkout AND a.status = 'pending'), 0))
       + COALESCE((SELECT sum(e.amount_minor) FROM fleet_paypal_clawback_evidence e WHERE e.checkout_id = p_checkout AND e.grp = 'unclassified'
                     AND NOT EXISTS (SELECT 1 FROM fleet_paypal_debit_classifications k WHERE k.ref_id = e.ref_id)), 0)
$$;

CREATE FUNCTION fleet_paypal_dispute_exposure(p_agent text) RETURNS bigint LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(sum(fleet_paypal_sale_exposure(c.checkout_id)), 0)::bigint FROM fleet_paypal_checkouts c
   WHERE c.agent_id = p_agent AND c.status = 'captured'
     AND (EXISTS (SELECT 1 FROM fleet_paypal_disputes d WHERE d.checkout_id = c.checkout_id)
          OR EXISTS (SELECT 1 FROM fleet_paypal_clawback_evidence e WHERE e.checkout_id = c.checkout_id AND e.grp IN ('dispute_hold','unclassified')))
$$;

${REFUND}

-- Money given back to a sale (a reversal reversed, a fee refunded): revenue / fees restored, the agent's payable repaid first.
CREATE FUNCTION fleet_paypal_clawback_return(p_checkout uuid, p_grp text, p_amount bigint, p_worker text, p_key text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_paypal_checkouts; v_j uuid; v_pay bigint; rep bigint;
BEGIN
  IF p_grp NOT IN ('reversal_return','fee_return') OR p_amount <= 0 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a return of a reversal or a fee'; END IF;
  IF EXISTS (SELECT 1 FROM fleet_paypal_clawback_posts WHERE claim_key = p_key) THEN RETURN jsonb_build_object('ok', true, 'replay', true); END IF;
  SELECT * INTO c FROM fleet_paypal_checkouts WHERE checkout_id = p_checkout;
  PERFORM 1 FROM fleet_ledger_accounts WHERE account_id IN (fleet_ledger_account(c.agent_id, 'agent_cash'), fleet_ledger_account(c.agent_id, 'agent_provider_payable'))
    ORDER BY account_id FOR UPDATE;
  v_j := fleet_ledger_post('paypal_clawback_return', p_key, 'custody:' || p_worker,
    CASE p_grp WHEN 'reversal_return' THEN 'PayPal reversal given back: ' ELSE 'PayPal fee given back: ' END || c.description, 'executor', c.agent_id,
    NULL, NULL, p_key, NULL, now(), jsonb_build_array(
      jsonb_build_object('account', fleet_ledger_account(c.agent_id, 'agent_cash'), 'side', 'D', 'amount', p_amount),
      jsonb_build_object('account', fleet_ledger_account(c.agent_id, CASE p_grp WHEN 'reversal_return' THEN 'agent_revenue' ELSE 'agent_fees' END), 'side', 'C', 'amount', p_amount)));
  INSERT INTO fleet_paypal_clawback_posts (claim_key, checkout_id, grp, amount_minor, journal_id) VALUES (p_key, p_checkout, p_grp, p_amount, v_j);
  INSERT INTO fleet_venture_journals (journal_id, venture_id, agent_id, cost_category, attributed_by) VALUES (v_j, c.venture_id, c.agent_id, 'revenue', 'custody');
  v_pay := COALESCE((SELECT fleet_ledger_balance(account_id) FROM fleet_ledger_accounts WHERE agent_id = c.agent_id AND class = 'agent_provider_payable'), 0);
  rep := LEAST(v_pay, p_amount);
  IF rep > 0 THEN
    PERFORM fleet_ledger_post('paypal_payable_repayment', p_key || ':rp', 'custody:' || p_worker, 'provider payable repaid from money PayPal gave back', 'executor', c.agent_id,
      NULL, NULL, p_key, NULL, now(), jsonb_build_array(
        jsonb_build_object('account', fleet_ledger_account(c.agent_id, 'agent_provider_payable'), 'side', 'D', 'amount', rep),
        jsonb_build_object('account', fleet_ledger_account(c.agent_id, 'agent_cash'), 'side', 'C', 'amount', rep),
        jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', rep),
        jsonb_build_object('account', 'fleet:provider:advances', 'side', 'C', 'amount', rep)));
  END IF;
  IF p_grp = 'reversal_return' THEN
    UPDATE fleet_customer_orders SET refunded_minor = GREATEST(0, refunded_minor - p_amount),
           payment_status = CASE WHEN GREATEST(0, refunded_minor - p_amount) = 0 THEN 'paid' ELSE 'partially_refunded' END
     WHERE checkout_id = p_checkout;
  END IF;
  RETURN jsonb_build_object('ok', true, 'journalId', v_j, 'payableRepaidMinor', rep);
END $$;

-- Per sale and group: post the difference between the evidence (the larger source, plus the owner's classifications) and
-- what is posted. Deterministic keys make a concurrent or repeated call a replay.
CREATE FUNCTION fleet_paypal_clawback_reconcile(p_checkout uuid, p_worker text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_paypal_checkouts; g text; v_target bigint; v_posted bigint; v_delta bigint; r jsonb; v_out jsonb := '{}'::jsonb;
BEGIN
  SELECT * INTO c FROM fleet_paypal_checkouts WHERE checkout_id = p_checkout FOR UPDATE;
  IF NOT FOUND OR c.status <> 'captured' OR c.purpose <> 'agent_sale' THEN RETURN jsonb_build_object('ok', true, 'skipped', true); END IF;
  FOREACH g IN ARRAY ARRAY['refund','reversal','fee','reversal_return','fee_return'] LOOP
    SELECT GREATEST(COALESCE(sum(e.amount_minor) FILTER (WHERE e.source = 'webhook'), 0), COALESCE(sum(e.amount_minor) FILTER (WHERE e.source = 'search'), 0))
           + COALESCE(sum(e.amount_minor) FILTER (WHERE e.source = 'owner'), 0)
      INTO v_target FROM fleet_paypal_clawback_evidence e WHERE e.checkout_id = p_checkout AND e.grp = g;
    SELECT COALESCE(sum(amount_minor), 0) INTO v_posted FROM fleet_paypal_clawback_posts WHERE checkout_id = p_checkout AND grp = g;
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
  RETURN jsonb_build_object('ok', true, 'posted', v_out);
END $$;

-- Custody: a webhook's refund or reversal of a sale, as evidence.
CREATE FUNCTION cx_paypal_clawback_evidence(p_worker text, p_source text, p_ref text, p_grp text, p_capture text, p_amount bigint, p_currency text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_paypal_checkouts;
BEGIN
  ${WORKER}
  IF p_source <> 'webhook' OR p_grp NOT IN ('refund','reversal') OR p_ref IS NULL OR p_ref !~ '^[A-Za-z0-9-]{5,64}$' OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  SELECT * INTO c FROM fleet_paypal_checkouts WHERE capture_id = p_capture AND status = 'captured';
  IF NOT FOUND OR p_currency IS DISTINCT FROM c.currency THEN
    PERFORM fleet_event('paypal_refund_unmatched', NULL, 'custody', jsonb_build_object('captureId', p_capture, 'refundId', p_ref, 'kind', p_grp,
      'amountMinor', p_amount, 'currency', p_currency));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND');
  END IF;
  IF c.purpose = 'owner_test' THEN
    -- The owner's receiving test: reported once, never posted (v53).
    RETURN cx_paypal_refund_record(p_worker, p_capture, p_ref, p_grp, p_amount, p_currency);
  END IF;
  INSERT INTO fleet_paypal_clawback_evidence (source, ref_id, grp, checkout_id, amount_minor) VALUES ('webhook', p_ref, p_grp, c.checkout_id, p_amount)
    ON CONFLICT DO NOTHING;
  RETURN fleet_paypal_clawback_reconcile(c.checkout_id, p_worker);
END $$;

-- Custody: a dispute's state from PayPal's webhook (CUSTOMER.DISPUTE.CREATED / UPDATED / RESOLVED).
CREATE FUNCTION cx_paypal_dispute_record(p_worker text, p_dispute text, p_capture text, p_status text, p_outcome text, p_amount bigint, p_currency text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_paypal_checkouts; d fleet_paypal_disputes; v_status text;
BEGIN
  ${WORKER}
  IF p_dispute IS NULL OR p_dispute !~ '^[A-Za-z0-9-]{5,64}$' OR p_status IS NULL OR p_status !~ '^[A-Z_]{2,40}$' OR (p_outcome IS NOT NULL AND p_outcome !~ '^[A-Z_]{2,40}$')
     OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  SELECT * INTO c FROM fleet_paypal_checkouts WHERE capture_id = p_capture AND status = 'captured' AND purpose = 'agent_sale';
  IF NOT FOUND OR p_currency IS DISTINCT FROM c.currency THEN
    PERFORM fleet_event('paypal_dispute_unresolved', NULL, 'custody', jsonb_build_object('disputeId', p_dispute, 'captureId', p_capture,
      'note', 'a PayPal dispute on a transaction no sale matches; review it in PayPal'));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND');
  END IF;
  v_status := CASE WHEN p_status <> 'RESOLVED' THEN 'open'
                   WHEN p_outcome IN ('RESOLVED_SELLER_FAVOUR','RESOLVED_WITH_PAYOUT','CANCELED_BY_BUYER','DENIED') THEN 'won'
                   WHEN p_outcome IN ('RESOLVED_BUYER_FAVOUR','ACCEPTED') THEN 'lost'
                   ELSE 'unresolved' END;
  SELECT * INTO d FROM fleet_paypal_disputes WHERE dispute_id = p_dispute FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO fleet_paypal_disputes (dispute_id, checkout_id, agent_id, amount_minor, currency, status, outcome, set_by)
      VALUES (p_dispute, c.checkout_id, c.agent_id, p_amount, p_currency, v_status, p_outcome, 'custody:' || p_worker) RETURNING * INTO d;
    PERFORM fleet_event('paypal_dispute_opened', c.agent_id, 'custody', jsonb_build_object('disputeId', p_dispute, 'checkoutId', c.checkout_id, 'amountMinor', p_amount,
      'status', v_status, 'note', 'the disputed amount is held back from the agent''s spendable money until PayPal resolves it'));
  ELSIF d.set_by LIKE 'operator:%' OR d.status IN ('won','lost') AND v_status = 'open' THEN
    RETURN jsonb_build_object('ok', true, 'unchanged', true, 'status', d.status); -- the owner's resolution, or a final outcome, stands
  ELSIF d.status IS DISTINCT FROM v_status OR d.amount_minor <> p_amount THEN
    UPDATE fleet_paypal_disputes SET status = v_status, outcome = p_outcome, amount_minor = p_amount, updated_at = now(), set_by = 'custody:' || p_worker
     WHERE dispute_id = p_dispute RETURNING * INTO d;
  END IF;
  IF v_status IN ('won','lost') THEN
    PERFORM fleet_event('paypal_dispute_resolved', c.agent_id, 'custody', jsonb_build_object('disputeId', p_dispute, 'checkoutId', c.checkout_id, 'outcome', v_status));
  ELSIF v_status = 'unresolved' THEN
    PERFORM fleet_event('paypal_dispute_unresolved', c.agent_id, 'custody', jsonb_build_object('disputeId', p_dispute, 'checkoutId', c.checkout_id, 'outcome', p_outcome,
      'note', 'PayPal closed this dispute without a plain outcome; the amount stays held back until you resolve it (won or lost)'));
  END IF;
  RETURN jsonb_build_object('ok', true, 'status', v_status, 'exposureMinor', fleet_paypal_sale_exposure(c.checkout_id));
END $$;

-- Owner: resolve a dispute PayPal left ambiguous (or correct one): won releases the amount, lost keeps it held until the
-- reversal is posted from PayPal's evidence.
CREATE FUNCTION fleet_admin_paypal_dispute_resolve(p_dispute text, p_outcome text, p_note text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE d fleet_paypal_disputes;
BEGIN
  ${OWNER_ACTOR}
  IF p_outcome NOT IN ('won','lost') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: outcome won|lost'; END IF;
  UPDATE fleet_paypal_disputes SET status = p_outcome, set_by = p_actor, note = left(fleet_scrub(p_note), 300), updated_at = now()
   WHERE dispute_id = p_dispute RETURNING * INTO d;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such dispute'; END IF;
  PERFORM fleet_event('paypal_dispute_set_by_owner', d.agent_id, p_actor, jsonb_build_object('disputeId', p_dispute, 'outcome', p_outcome));
  RETURN jsonb_build_object('ok', true, 'disputeId', p_dispute, 'status', p_outcome, 'exposureMinor', fleet_paypal_sale_exposure(d.checkout_id));
END $$;

-- Owner: classify a debit Transaction Search could not (refund / reversal / fee are posted once; not_this_sale clears it).
CREATE FUNCTION fleet_admin_paypal_debit_classify(p_ref text, p_as text, p_note text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE e fleet_paypal_clawback_evidence; r jsonb;
BEGIN
  ${OWNER_ACTOR}
  IF p_as NOT IN ('refund','reversal','fee','not_this_sale') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: as refund|reversal|fee|not_this_sale'; END IF;
  SELECT * INTO e FROM fleet_paypal_clawback_evidence WHERE ref_id = p_ref AND grp = 'unclassified' AND source = 'search';
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such unclassified debit'; END IF;
  IF EXISTS (SELECT 1 FROM fleet_paypal_debit_classifications WHERE ref_id = p_ref) THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: already classified'; END IF;
  INSERT INTO fleet_paypal_debit_classifications (ref_id, classified_as, note, set_by) VALUES (p_ref, p_as, left(fleet_scrub(p_note), 300), p_actor);
  IF p_as <> 'not_this_sale' THEN
    INSERT INTO fleet_paypal_clawback_evidence (source, ref_id, grp, checkout_id, amount_minor) VALUES ('owner', p_ref, p_as, e.checkout_id, e.amount_minor);
    r := fleet_paypal_clawback_reconcile(e.checkout_id, 'owner-classified');
  END IF;
  PERFORM fleet_event('paypal_debit_classified', (SELECT agent_id FROM fleet_paypal_checkouts WHERE checkout_id = e.checkout_id), p_actor,
    jsonb_build_object('refId', p_ref, 'as', p_as));
  RETURN jsonb_build_object('ok', true, 'refId', p_ref, 'as', p_as, 'posted', r -> 'posted');
END $$;

-- Custody's Transaction Search record (v48 + v56 reference link), now classifying a sale's debits and returns as evidence.
CREATE OR REPLACE FUNCTION cx_paypal_txn_record(p_worker text, p_rail uuid, p_txn jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE t fleet_paypal_transactions; v_checkout uuid; v_custom text; v_invoice text; c fleet_paypal_checkouts; v_grp text; v_amt bigint; rc jsonb;
BEGIN
  ${WORKER}
  IF NOT EXISTS (SELECT 1 FROM fleet_payment_rails WHERE rail_id = p_rail AND provider = 'paypal') OR p_txn IS NULL OR jsonb_typeof(p_txn) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  v_custom := left(p_txn ->> 'customField', 255);
  v_invoice := left(p_txn ->> 'invoiceId', 127);
  v_checkout := CASE WHEN v_custom ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN v_custom::uuid
                     WHEN v_invoice ~ '^fleet:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN substr(v_invoice, 7)::uuid END;
  IF v_checkout IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fleet_paypal_checkouts WHERE checkout_id = v_checkout AND rail_id = p_rail) THEN v_checkout := NULL; END IF;
  -- v56: a row may name only the capture it concerns (paypal_reference_id).
  IF v_checkout IS NULL AND (p_txn ->> 'referenceId') ~ '^[A-Z0-9]{5,40}$' THEN
    SELECT checkout_id INTO v_checkout FROM fleet_paypal_checkouts WHERE capture_id = p_txn ->> 'referenceId' AND rail_id = p_rail;
  END IF;
  INSERT INTO fleet_paypal_transactions (rail_id, transaction_id, event_code, initiated_at, status, amount_minor, fee_minor, currency, invoice_id, custom_field, checkout_id)
    VALUES (p_rail, p_txn ->> 'transactionId', p_txn ->> 'eventCode', (p_txn ->> 'initiatedAt')::timestamptz, p_txn ->> 'status',
            (p_txn ->> 'amountMinor')::bigint, COALESCE((p_txn ->> 'feeMinor')::bigint, 0), p_txn ->> 'currency', v_invoice, v_custom, v_checkout)
  ON CONFLICT (rail_id, transaction_id, event_code, initiated_at) DO UPDATE SET status = EXCLUDED.status, amount_minor = EXCLUDED.amount_minor,
    fee_minor = EXCLUDED.fee_minor, checkout_id = COALESCE(fleet_paypal_transactions.checkout_id, EXCLUDED.checkout_id), updated_at = now()
  RETURNING * INTO t;
  IF t.checkout_id IS NOT NULL THEN SELECT * INTO c FROM fleet_paypal_checkouts WHERE checkout_id = t.checkout_id; END IF;
  -- v57: what PayPal took from or gave back to a captured sale is evidence (completed rows only; the capture itself is not).
  IF t.checkout_id IS NOT NULL AND t.status = 'S' AND c.status = 'captured' AND c.purpose = 'agent_sale' AND t.amount_minor <> 0
     AND NOT (t.amount_minor > 0 AND t.event_code !~ '^(${[...C.reversal_return, ...C.fee_return, ...C.dispute_hold].join("|")})$') THEN
    v_grp := CASE
      WHEN t.event_code IN (${q(C.refund)}) AND t.amount_minor < 0 THEN 'refund'
      WHEN t.event_code IN (${q(C.reversal)}) AND t.amount_minor < 0 THEN 'reversal'
      WHEN t.event_code IN (${q(C.reversal_return)}) AND t.amount_minor > 0 THEN 'reversal_return'
      WHEN t.event_code IN (${q(C.fee)}) AND t.amount_minor < 0 THEN 'fee'
      WHEN t.event_code IN (${q(C.fee_return)}) AND t.amount_minor > 0 THEN 'fee_return'
      WHEN t.event_code IN (${q(C.dispute_hold)}) THEN 'dispute_hold'
      WHEN t.amount_minor < 0 THEN 'unclassified' END;
    IF v_grp IS NOT NULL THEN
      -- A dispute hold takes money (positive), its release gives it back (negative); every other group is a positive amount.
      v_amt := CASE WHEN v_grp = 'dispute_hold' THEN -t.amount_minor ELSE abs(t.amount_minor) END;
      INSERT INTO fleet_paypal_clawback_evidence (source, ref_id, grp, checkout_id, amount_minor)
        VALUES ('search', t.transaction_id || ':' || t.event_code, v_grp, t.checkout_id, v_amt) ON CONFLICT DO NOTHING;
      IF FOUND AND v_grp = 'unclassified' THEN
        PERFORM fleet_event('paypal_debit_unclassified', c.agent_id, 'custody', jsonb_build_object('checkoutId', t.checkout_id, 'refId', t.transaction_id || ':' || t.event_code,
          'eventCode', t.event_code, 'amountMinor', t.amount_minor,
          'note', 'PayPal took money from this sale under a code the Fleet does not classify; it is held back from the agent until you classify it'));
      END IF;
      rc := fleet_paypal_clawback_reconcile(t.checkout_id, p_worker);
    END IF;
  END IF;
  RETURN jsonb_build_object('ok', true, 'checkoutId', t.checkout_id,
    'needsCapturePost', t.checkout_id IS NOT NULL AND t.status = 'S' AND t.amount_minor > 0 AND t.event_code ~ '^T00' AND c.status <> 'captured',
    'reconciled', rc -> 'posted');
END $$;

${ECONOMICS}

${MEASURE}

${SETTLE}

-- The v51 form (dashboard, CLI and the v48 resolve) keeps the treasury as the swept share's destination.
CREATE OR REPLACE FUNCTION fleet_admin_card_receipt_settle(p_receipt uuid, p_resolution text, p_method text, p_sweep bigint, p_reference text, p_actor text)
RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  RETURN fleet_admin_card_receipt_settle(p_receipt, p_resolution, p_method, p_sweep, p_reference, p_actor, 'treasury');
END $$;

-- ═══ Dashboard ═══
CREATE FUNCTION fleet_paypal_disputes_json() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'disputes', COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('disputeId', d.dispute_id, 'agentId', d.agent_id, 'checkoutId', d.checkout_id,
        'amountMinor', d.amount_minor, 'currency', d.currency, 'status', d.status, 'outcome', d.outcome, 'setBy', d.set_by, 'openedAt', d.opened_at,
        'exposureMinor', fleet_paypal_sale_exposure(d.checkout_id))) ORDER BY d.opened_at DESC)
      FROM (SELECT * FROM fleet_paypal_disputes ORDER BY opened_at DESC LIMIT 100) d), '[]'::jsonb),
    'unclassified', COALESCE((SELECT jsonb_agg(jsonb_build_object('refId', e.ref_id, 'checkoutId', e.checkout_id, 'amountMinor', e.amount_minor,
        'agentId', (SELECT agent_id FROM fleet_paypal_checkouts WHERE checkout_id = e.checkout_id), 'at', e.recorded_at) ORDER BY e.recorded_at DESC)
      FROM fleet_paypal_clawback_evidence e WHERE e.grp = 'unclassified' AND NOT EXISTS (SELECT 1 FROM fleet_paypal_debit_classifications k WHERE k.ref_id = e.ref_id)), '[]'::jsonb),
    'exposureByAgent', COALESCE((SELECT jsonb_object_agg(a.agent_id, x) FROM (SELECT g.agent_id, fleet_paypal_dispute_exposure(g.agent_id) AS x FROM fleet_agents g) a WHERE x > 0), '{}'::jsonb),
    'webhookEvents', jsonb_build_array('CUSTOMER.DISPUTE.CREATED','CUSTOMER.DISPUTE.UPDATED','CUSTOMER.DISPUTE.RESOLVED'))
$$;

${DASH_CALL}

${EVENT_ROUTE}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

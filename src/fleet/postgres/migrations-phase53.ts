/**
 * Schema v53 — launch preparation for the owner's routine (owner decisions 2026-10-08, after rev 2):
 *
 * 1. WEEKLY CARD STATEMENT. The card on file is the owner's credit card; agents' card spending is taken from their wallets
 *    (or a Fleet Control allocation) at once and set aside in the card reserve (v48/v51). Each week the Fleet issues a
 *    statement: every charge booked in the period (agent, merchant, amount) and the total owed on the card. The owner moves
 *    that total from the treasury PayPal to the card (PayPal cannot pay a credit card directly: withdraw to the bank, then
 *    pay the card) and marks the statement paid with the transfer reference, which records the card repayment (v48) and
 *    releases the reserve. A newer statement supersedes an unpaid older one (the amount owed is always the whole card
 *    liability at issue). Schedule: weekday + hour in the owner's time zone (default Monday 09:00 Europe/London); the
 *    reaper issues it; the owner can also issue one now.
 * 2. OWNER RECEIVING TEST. The owner opens a small PayPal checkout (at most 10.00) on the treasury's receiving rail and pays
 *    it themselves. It goes through the same custody path as an agent's checkout (order, approval, capture, verified
 *    webhook, Transaction Search, Balances) but is never revenue: the captured net amount is OWNER CAPITAL in the treasury
 *    (owner_funding). A refund of a test is not posted automatically; it is reported to the owner.
 */
import { V48_SQL } from "./migrations-phase48.js";
import { V51_SQL } from "./migrations-phase51.js";
import { V52_SQL } from "./migrations-phase52.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));

export const EVENT_ROUTES_V53 = Object.freeze({
  P1_HIGH: ["paypal_test_refund_seen"],
  P2_IMPORTANT: ["card_statement_issued", "card_statement_paid", "paypal_test_checkout_requested", "paypal_test_captured"],
  AUDIT_ONLY: ["card_statement_policy_set"],
} as const);
export const DASHBOARD_READ_OPS_V53 = ["paypal_test"] as const;
export const DASHBOARD_SENSITIVE_OPS_V53 = ["card_statement_issue", "card_statement_paid", "card_statement_policy_set", "paypal_test_checkout"] as const;
/** The largest owner receiving test (minor units of the accounting currency). */
export const PAYPAL_TEST_MAX_MINOR = 1_000;

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');`;

// A checkout's owner and venture are fixed, including "nobody" for an owner test (NULL-safe comparisons).
const CHECKOUT_GUARD = restate(V48_SQL, "fleet_paypal_checkouts_guard", [
  ["NEW.agent_id <> OLD.agent_id OR NEW.venture_id <> OLD.venture_id", "NEW.agent_id IS DISTINCT FROM OLD.agent_id OR NEW.venture_id IS DISTINCT FROM OLD.venture_id OR NEW.purpose <> OLD.purpose"],
]);

// An owner test's capture is owner capital in the treasury (net of PayPal's fee), never an agent's revenue.
const CAPTURE = restate(V51_SQL, "cx_paypal_capture_record", [
  [`  IF fleet_claim_taken(v_key) THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ALREADY_CLAIMED'); END IF;
`, `  IF fleet_claim_taken(v_key) THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ALREADY_CLAIMED'); END IF;
  IF c.purpose = 'owner_test' THEN
    v_j := fleet_ledger_post('owner_funding', v_key, 'custody:' || p_worker, 'owner receiving test (PayPal capture, net of fee)', 'executor', NULL,
      NULL, NULL, v_key, NULL, now(), jsonb_build_array(
        jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', p_gross - p_fee),
        jsonb_build_object('account', 'fleet:owner:capital', 'side', 'C', 'amount', p_gross - p_fee)));
    INSERT INTO fleet_revenue_claims (claim_key, claim_kind, journal_id, claimed_by) VALUES (v_key, 'paypal_capture', v_j, 'custody:' || p_worker);
    UPDATE fleet_paypal_checkouts SET status = 'captured', capture_id = p_capture_id, captured_at = now(), journal_id = v_j WHERE checkout_id = c.checkout_id;
    PERFORM fleet_event('paypal_test_captured', NULL, 'custody', jsonb_build_object('checkoutId', c.checkout_id, 'captureId', p_capture_id,
      'grossMinor', p_gross, 'feeMinor', p_fee, 'evidence', p_evidence, 'ownerCapitalMinor', p_gross - p_fee));
    RETURN jsonb_build_object('ok', true, 'status', 'captured', 'journalId', v_j, 'netMinor', p_gross - p_fee, 'ownerTest', true);
  END IF;
`],
]);

// A refund of an owner test is the owner's own money going back to them: reported, never posted against an agent.
const REFUND = restate(V51_SQL, "cx_paypal_refund_record", [
  [`    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND');
  END IF;
`, `    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND');
  END IF;
  IF c.purpose = 'owner_test' THEN
    IF NOT EXISTS (SELECT 1 FROM fleet_events WHERE event_type = 'paypal_test_refund_seen' AND detail ->> 'refundId' = p_refund_id) THEN
      PERFORM fleet_event('paypal_test_refund_seen', NULL, 'custody', jsonb_build_object('checkoutId', c.checkout_id, 'captureId', p_capture_id,
        'refundId', p_refund_id, 'kind', p_kind, 'amountMinor', p_amount,
        'note', 'a refund of your receiving test: not posted automatically; record it as an owner withdrawal if the money left the treasury'));
    END IF;
    RETURN jsonb_build_object('ok', true, 'ownerTest', true, 'posted', false);
  END IF;
`],
]);

const CARD_CLEARING = restate(V48_SQL, "fleet_card_clearing", [
  [`    'reserveMinor', fleet_ledger_balance('fleet:card:reserve'),`,
   `    'reserveMinor', fleet_ledger_balance('fleet:card:reserve'),
    'statementPolicy', (SELECT jsonb_build_object('enabled', p.enabled, 'weekday', p.weekday, 'hour', p.hour, 'timeZone', p.time_zone,
        'nextAt', fleet_card_statement_slot(now() + interval '7 days', p)) FROM fleet_card_statement_policy p WHERE p.id = 1),
    'statements', COALESCE((SELECT jsonb_agg(fleet_card_statement_json(s) ORDER BY s.period_end DESC)
        FROM (SELECT * FROM fleet_card_statements ORDER BY period_end DESC LIMIT 26) s), '[]'::jsonb),`],
]);

const DASH_CALL = restate(V52_SQL, "dash_call", [
  [`'storefront_probe','destination_paypal_link');`, `'storefront_probe','destination_paypal_link',${q(DASHBOARD_SENSITIVE_OPS_V53)});`],
  [`'provider_secrets','storefront')) THEN`, `'provider_secrets','storefront',${q(DASHBOARD_READ_OPS_V53)})) THEN`],
  [`      WHEN 'storefront' THEN fleet_storefront_json(a ->> 'agentId')`,
   `      WHEN 'storefront' THEN fleet_storefront_json(a ->> 'agentId')
      WHEN 'paypal_test' THEN fleet_paypal_test_json()`],
  [`      WHEN 'storefront_probe' THEN`,
   `      WHEN 'card_statement_issue' THEN fleet_admin_card_statement_issue('operator:owner')
      WHEN 'card_statement_paid' THEN fleet_admin_card_statement_paid((a ->> 'statementId')::uuid, a ->> 'reference', 'operator:owner')
      WHEN 'card_statement_policy_set' THEN fleet_admin_card_statement_policy_set((a ->> 'enabled')::boolean, (a ->> 'weekday')::integer, (a ->> 'hour')::integer,
        a ->> 'timeZone', 'operator:owner')
      WHEN 'paypal_test_checkout' THEN fleet_admin_paypal_test_checkout((a ->> 'amountMinor')::bigint, 'operator:owner')
      WHEN 'storefront_probe' THEN`],
]);

const EVENT_ROUTE = restate(V52_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V53) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
]);

export const V53_SQL = `
-- ═══ 1. Weekly card statement ═══
CREATE TABLE fleet_card_statement_policy (
  id         integer     PRIMARY KEY CHECK (id = 1),
  enabled    boolean     NOT NULL DEFAULT true,
  weekday    integer     NOT NULL DEFAULT 1 CHECK (weekday BETWEEN 1 AND 7),  -- ISO: 1 = Monday
  hour       integer     NOT NULL DEFAULT 9 CHECK (hour BETWEEN 0 AND 23),
  time_zone  text        NOT NULL DEFAULT 'Europe/London' CHECK (time_zone ~ '^[A-Za-z_]{1,32}(/[A-Za-z0-9_+-]{1,32}){0,2}$'),
  updated_by text        NOT NULL DEFAULT 'migration',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fleet_card_statement_policy (id) VALUES (1);
CREATE TRIGGER fleet_card_statement_policy_no_delete BEFORE DELETE ON fleet_card_statement_policy FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_card_statement_policy_no_truncate BEFORE TRUNCATE ON fleet_card_statement_policy FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_card_statements (
  statement_id   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start   timestamptz NOT NULL,
  period_end     timestamptz NOT NULL UNIQUE,
  charge_count   integer     NOT NULL CHECK (charge_count >= 0),
  charges_minor  bigint      NOT NULL CHECK (charges_minor >= 0),
  due_minor      bigint      NOT NULL CHECK (due_minor >= 0),
  lines          jsonb       NOT NULL CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) <= 500),
  status         text        NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','paid','superseded')),
  issued_by      text        NOT NULL,
  issued_at      timestamptz NOT NULL DEFAULT now(),
  paid_minor     bigint      CHECK (paid_minor >= 0),
  paid_reference text        CHECK (length(paid_reference) BETWEEN 2 AND 120),
  repayment_id   uuid        REFERENCES fleet_card_repayments(repayment_id),
  paid_by        text,
  paid_at        timestamptz,
  superseded_by  uuid        REFERENCES fleet_card_statements(statement_id),
  CHECK (period_end > period_start),
  CHECK ((status = 'paid') = (paid_at IS NOT NULL AND paid_minor IS NOT NULL AND paid_reference IS NOT NULL)),
  CHECK ((status = 'superseded') = (superseded_by IS NOT NULL))
);
CREATE FUNCTION fleet_card_statements_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'issued' THEN RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: a settled card statement is history'; END IF;
  IF NEW.statement_id <> OLD.statement_id OR NEW.period_start <> OLD.period_start OR NEW.period_end <> OLD.period_end OR NEW.charge_count <> OLD.charge_count
     OR NEW.charges_minor <> OLD.charges_minor OR NEW.due_minor <> OLD.due_minor OR NEW.lines <> OLD.lines OR NEW.issued_by <> OLD.issued_by
     OR NEW.issued_at <> OLD.issued_at THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a card statement''s facts are fixed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_card_statements_guard BEFORE UPDATE OR DELETE ON fleet_card_statements FOR EACH ROW EXECUTE FUNCTION fleet_card_statements_guard();
CREATE TRIGGER fleet_card_statements_no_truncate BEFORE TRUNCATE ON fleet_card_statements FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- The latest scheduled statement time at or before p_at (the policy's weekday and hour in its time zone).
CREATE FUNCTION fleet_card_statement_slot(p_at timestamptz, p fleet_card_statement_policy) RETURNS timestamptz LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT CASE WHEN s > (p_at AT TIME ZONE p.time_zone) THEN s - interval '7 days' ELSE s END AT TIME ZONE p.time_zone
    FROM (SELECT date_trunc('week', p_at AT TIME ZONE p.time_zone) + (p.weekday - 1) * interval '1 day' + p.hour * interval '1 hour' AS s) x
$$;

CREATE FUNCTION fleet_card_statement_json(s fleet_card_statements) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('statementId', s.statement_id, 'periodStart', s.period_start, 'periodEnd', s.period_end,
    'chargeCount', s.charge_count, 'chargesMinor', s.charges_minor, 'dueMinor', s.due_minor, 'lines', s.lines, 'status', s.status,
    'issuedAt', s.issued_at, 'issuedBy', s.issued_by, 'paidMinor', s.paid_minor, 'paidReference', s.paid_reference, 'repaymentId', s.repayment_id,
    'paidAt', s.paid_at, 'supersededBy', s.superseded_by,
    'howToPay', CASE WHEN s.status = 'issued' AND s.due_minor > 0
      THEN 'move the amount owed from the treasury PayPal to the card (withdraw to the bank, then pay the card), then mark this statement paid with the transfer reference' END))
$$;

-- Issue one statement ending at p_end: the charges booked since the previous statement and the whole card liability now.
-- Nothing to report (no charge in the period and nothing owed) issues nothing.
CREATE FUNCTION fleet_card_statement_issue(p_end timestamptz, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_start timestamptz; v_due bigint; v_n integer; v_sum bigint; v_lines jsonb; s fleet_card_statements;
BEGIN
  PERFORM 1 FROM fleet_card_statement_policy WHERE id = 1 FOR UPDATE;   -- one issuer at a time
  IF EXISTS (SELECT 1 FROM fleet_card_statements WHERE period_end >= p_end) THEN RETURN jsonb_build_object('ok', true, 'issued', false, 'reason', 'already issued'); END IF;
  SELECT max(period_end) INTO v_start FROM fleet_card_statements;
  v_start := COALESCE(v_start, LEAST(p_end - interval '7 days', (SELECT min(booked_at) FROM fleet_card_charges WHERE booked_at IS NOT NULL)));
  SELECT count(*), COALESCE(sum(c.amount_minor), 0),
         COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('chargeId', c.charge_id, 'agentId', c.agent_id, 'agentName', a.name, 'merchant', c.merchant,
           'amountMinor', c.amount_minor, 'status', c.status, 'bookedAt', c.booked_at, 'statementRef', c.statement_ref)) ORDER BY c.booked_at), '[]'::jsonb)
    INTO v_n, v_sum, v_lines
    FROM (SELECT * FROM fleet_card_charges WHERE status IN ('booked','confirmed') AND booked_at >= v_start AND booked_at < p_end ORDER BY booked_at LIMIT 500) c
    JOIN fleet_agents a ON a.agent_id = c.agent_id;
  v_due := fleet_ledger_balance('fleet:card:payable');
  IF v_n = 0 AND v_due = 0 THEN RETURN jsonb_build_object('ok', true, 'issued', false, 'reason', 'nothing charged and nothing owed'); END IF;
  INSERT INTO fleet_card_statements (period_start, period_end, charge_count, charges_minor, due_minor, lines, issued_by)
    VALUES (v_start, p_end, v_n, v_sum, v_due, v_lines, p_actor) RETURNING * INTO s;
  UPDATE fleet_card_statements SET status = 'superseded', superseded_by = s.statement_id WHERE status = 'issued' AND statement_id <> s.statement_id;
  PERFORM fleet_event('card_statement_issued', NULL, p_actor, jsonb_build_object('statementId', s.statement_id, 'periodStart', v_start, 'periodEnd', p_end,
    'chargeCount', v_n, 'chargesMinor', v_sum, 'dueMinor', v_due,
    'note', CASE WHEN v_due > 0 THEN 'pay the card from the treasury PayPal, then mark the statement paid' ELSE 'nothing is owed on the card' END));
  RETURN jsonb_build_object('ok', true, 'issued', true, 'statement', fleet_card_statement_json(s));
END $$;

-- Reaper: issue the statement of the latest scheduled time if it is not issued yet.
CREATE FUNCTION svc_card_statement_tick() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_card_statement_policy;
BEGIN
  SELECT * INTO p FROM fleet_card_statement_policy WHERE id = 1;
  IF NOT FOUND OR NOT p.enabled THEN RETURN jsonb_build_object('ok', true, 'enabled', false); END IF;
  RETURN fleet_card_statement_issue(fleet_card_statement_slot(now(), p), 'controller');
END $$;

-- Owner: issue a statement now (outside the weekly schedule).
CREATE FUNCTION fleet_admin_card_statement_issue(p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  ${OWNER_ACTOR}
  RETURN fleet_card_statement_issue(now(), p_actor);
END $$;

-- Owner: the statement was paid — the card repaid from the treasury PayPal. Records the repayment (v48) of what is still owed
-- of the statement's total (never more than the card liability now) and releases the reserve.
CREATE FUNCTION fleet_admin_card_statement_paid(p_statement uuid, p_reference text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE s fleet_card_statements; v_amount bigint; r jsonb; v_rep uuid;
BEGIN
  ${OWNER_ACTOR}
  SELECT * INTO s FROM fleet_card_statements WHERE statement_id = p_statement FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such card statement'; END IF;
  IF s.status = 'superseded' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: a newer statement replaces this one; mark the newest statement paid'; END IF;
  IF s.status <> 'issued' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: this statement is already paid'; END IF;
  IF p_reference IS NULL OR length(trim(p_reference)) < 2 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the transfer reference of the card payment'; END IF;
  PERFORM 1 FROM fleet_ledger_accounts WHERE account_id = 'fleet:card:payable' FOR UPDATE;
  v_amount := LEAST(s.due_minor, fleet_ledger_balance('fleet:card:payable'));
  IF v_amount > 0 THEN
    IF EXISTS (SELECT 1 FROM fleet_card_repayments WHERE reference = trim(p_reference)) THEN
      RAISE EXCEPTION 'FLEET_ALREADY_CLAIMED: that reference is already recorded as a card repayment';
    END IF;
    r := fleet_admin_card_repayment_record(v_amount, p_reference, p_actor);
    v_rep := (r ->> 'repaymentId')::uuid;
  END IF;
  UPDATE fleet_card_statements SET status = 'paid', paid_minor = v_amount, paid_reference = left(trim(p_reference), 120), repayment_id = v_rep,
         paid_by = p_actor, paid_at = now()
   WHERE statement_id = p_statement RETURNING * INTO s;
  PERFORM fleet_event('card_statement_paid', NULL, p_actor, jsonb_build_object('statementId', s.statement_id, 'paidMinor', v_amount, 'repaymentId', v_rep,
    'outstandingMinor', fleet_ledger_balance('fleet:card:payable')));
  RETURN jsonb_build_object('ok', true, 'statement', fleet_card_statement_json(s), 'outstandingMinor', fleet_ledger_balance('fleet:card:payable'));
END $$;

CREATE FUNCTION fleet_admin_card_statement_policy_set(p_enabled boolean, p_weekday integer, p_hour integer, p_time_zone text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_card_statement_policy;
BEGIN
  ${OWNER_ACTOR}
  IF p_time_zone IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_time_zone) THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: unknown time zone'; END IF;
  IF p_weekday IS NOT NULL AND p_weekday NOT BETWEEN 1 AND 7 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: weekday 1 (Monday) .. 7 (Sunday)'; END IF;
  IF p_hour IS NOT NULL AND p_hour NOT BETWEEN 0 AND 23 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: hour 0..23'; END IF;
  UPDATE fleet_card_statement_policy SET enabled = COALESCE(p_enabled, enabled), weekday = COALESCE(p_weekday, weekday), hour = COALESCE(p_hour, hour),
         time_zone = COALESCE(p_time_zone, time_zone), updated_by = p_actor, updated_at = now()
   WHERE id = 1 RETURNING * INTO p;
  PERFORM fleet_event('card_statement_policy_set', NULL, p_actor, jsonb_build_object('enabled', p.enabled, 'weekday', p.weekday, 'hour', p.hour, 'timeZone', p.time_zone));
  RETURN jsonb_build_object('ok', true, 'enabled', p.enabled, 'weekday', p.weekday, 'hour', p.hour, 'timeZone', p.time_zone,
    'nextAt', fleet_card_statement_slot(now() + interval '7 days', p));
END $$;

${CARD_CLEARING}

-- ═══ 2. Owner receiving test ═══
ALTER TABLE fleet_paypal_checkouts
  ADD COLUMN purpose text NOT NULL DEFAULT 'agent_sale' CHECK (purpose IN ('agent_sale','owner_test')),
  ALTER COLUMN agent_id DROP NOT NULL,
  ALTER COLUMN venture_id DROP NOT NULL,
  ADD CONSTRAINT fleet_paypal_checkouts_purpose CHECK (CASE purpose WHEN 'owner_test' THEN agent_id IS NULL AND venture_id IS NULL
                                                                    ELSE agent_id IS NOT NULL AND venture_id IS NOT NULL END);

${CHECKOUT_GUARD}

CREATE FUNCTION fleet_admin_paypal_test_checkout(p_amount bigint, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_payment_rails; c fleet_paypal_checkouts; v_cur text;
BEGIN
  ${OWNER_ACTOR}
  IF p_amount IS NULL OR p_amount NOT BETWEEN 1 AND ${PAYPAL_TEST_MAX_MINOR} THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a test of 1..${PAYPAL_TEST_MAX_MINOR} minor units'; END IF;
  SELECT * INTO c FROM fleet_paypal_checkouts WHERE purpose = 'owner_test' AND status IN ('requested','open','approved','capture_pending') ORDER BY created_at DESC LIMIT 1;
  IF FOUND THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'test', fleet_paypal_test_json_one(c)); END IF;
  SELECT x.* INTO r FROM fleet_payment_rails x
   WHERE x.provider = 'paypal' AND x.status = 'active' AND x.mode IN ('live','sandbox') AND x.rail_kind = 'shared' AND 'receive_payments' = ANY(x.capabilities)
     AND fleet_rail_capability_ready(x.rail_id, 'receive_payments')
   ORDER BY (x.mode = 'live') DESC, x.rail_id LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NO_RECEIVING_RAIL: no shared PayPal treasury rail is active and ready to receive payments'; END IF;
  v_cur := (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1);
  INSERT INTO fleet_paypal_checkouts (agent_id, venture_id, rail_id, description, amount_minor, currency, idempotency_key, purpose)
    VALUES (NULL, NULL, r.rail_id, 'Automaton Fleet receiving test', p_amount, v_cur, 'owner:test:' || gen_random_uuid(), 'owner_test') RETURNING * INTO c;
  PERFORM fleet_event('paypal_test_checkout_requested', NULL, p_actor, jsonb_build_object('checkoutId', c.checkout_id, 'amountMinor', p_amount, 'railId', r.rail_id,
    'mode', r.mode));
  RETURN jsonb_build_object('ok', true, 'test', fleet_paypal_test_json_one(c),
    'note', 'the custody executor opens it with PayPal shortly; read the approval link with hub-paypal-test (or the dashboard) and pay it yourself');
END $$;

-- One test as the owner follows it: checkout state, PayPal's own evidence (verified webhooks, Transaction Search, Balances)
-- and the posting (owner capital).
CREATE FUNCTION fleet_paypal_test_json_one(c fleet_paypal_checkouts) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('checkoutId', c.checkout_id, 'amountMinor', c.amount_minor, 'currency', c.currency, 'status', c.status,
    'mode', (SELECT mode FROM fleet_payment_rails WHERE rail_id = c.rail_id),
    'approvalUrl', CASE WHEN c.status = 'open' THEN c.approval_url END, 'failure', c.failure_code, 'createdAt', c.created_at, 'expiresAt', c.expires_at,
    'paypalOrderId', c.paypal_order_id, 'captureId', c.capture_id, 'capturedAt', c.captured_at, 'journalId', c.journal_id,
    'ownerCapitalMinor', (SELECT sum(p.amount_cents) FROM fleet_ledger_postings p WHERE p.journal_id = c.journal_id AND p.account_id = 'fleet:owner:capital'),
    'webhooks', (SELECT jsonb_object_agg(w.event_type || ':' || w.status, w.n) FROM (SELECT event_type, status, count(*) AS n FROM fleet_paypal_webhook_inbox
        WHERE resource_id IN (c.paypal_order_id, c.capture_id) GROUP BY event_type, status) w),
    'transactionSearch', (SELECT jsonb_agg(jsonb_build_object('transactionId', t.transaction_id, 'eventCode', t.event_code, 'status', t.status,
        'amountMinor', t.amount_minor, 'feeMinor', t.fee_minor)) FROM fleet_paypal_transactions t WHERE t.checkout_id = c.checkout_id),
    'balance', (SELECT jsonb_build_object('availableMinor', b.available_minor, 'observedAt', b.observed_at) FROM fleet_paypal_balance_observations b
        WHERE b.rail_id = c.rail_id AND b.currency = c.currency ORDER BY b.observed_at DESC LIMIT 1),
    'stage', CASE
      WHEN c.status IN ('failed','cancelled','expired') THEN c.status
      WHEN c.status <> 'captured' THEN c.status
      WHEN NOT EXISTS (SELECT 1 FROM fleet_paypal_transactions t WHERE t.checkout_id = c.checkout_id AND t.status = 'S') THEN 'captured (waiting for Transaction Search)'
      WHEN NOT EXISTS (SELECT 1 FROM fleet_paypal_balance_observations b WHERE b.rail_id = c.rail_id AND b.currency = c.currency AND b.observed_at > c.captured_at)
        THEN 'captured and completed (waiting for a Balances reading)'
      ELSE 'captured, completed and in the balance: receiving works' END))
$$;

CREATE FUNCTION fleet_paypal_test_json() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('maxMinor', ${PAYPAL_TEST_MAX_MINOR}, 'tests', COALESCE((SELECT jsonb_agg(fleet_paypal_test_json_one(c) ORDER BY c.created_at DESC)
    FROM (SELECT * FROM fleet_paypal_checkouts WHERE purpose = 'owner_test' ORDER BY created_at DESC LIMIT 10) c), '[]'::jsonb))
$$;

${CAPTURE}

${REFUND}

-- ═══ 3. Dashboard, routing ═══
${DASH_CALL}

${EVENT_ROUTE}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

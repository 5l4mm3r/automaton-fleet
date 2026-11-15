/**
 * Schema v54 — the owner's card rule (owner decision 2026-10-09): PAYPAL FIRST; the card is the last option, by request.
 *
 * 1. An agent pays through the treasury PayPal wherever the payee takes it (a registered vendor + spend, issued by custody).
 * 2. Only when PayPal is truly unavailable does it ask Fleet Control for the card (`card.request`): the merchant site (one of
 *    its accounts), the amount, WHY PayPal cannot be used and what the purchase is for. Fleet Control checks the reason —
 *    "payouts unavailable" is refused while the treasury can pay out — and that the agent's wallet (or its envelope) covers
 *    the amount in full (the card is never an open cash pool).
 * 3. Up to the owner's threshold (default £100) Fleet Control approves at once. Above it the request goes to the owner (P1):
 *    the owner moves the amount from the treasury to the card first and approves with that transfer's reference, or
 *    declines. When the charge is booked, the owner's transfer is recorded as the card repayment of that charge
 *    (so the weekly statement does not ask for it twice).
 * 4. `card.authorize` (the hold that reserves the agent's money and lets the browser fill the card) requires an approved
 *    request of the same agent, account and site, for no more than the approved amount; it uses the request up.
 */
import { V51_SQL } from "./migrations-phase51.js";
import { V52_SQL } from "./migrations-phase52.js";
import { V53_SQL } from "./migrations-phase53.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));

export const CARD_REQUEST_OPS = ["card.request", "card.requests"] as const;
/** Why PayPal cannot be used (the agent names one). */
export const PAYPAL_UNAVAILABLE_REASONS = ["card_only_merchant", "paypal_needs_login", "payee_no_paypal", "payouts_unavailable"] as const;
export const EVENT_ROUTES_V54 = Object.freeze({
  P1_HIGH: ["card_request_owner_review"],
  P2_IMPORTANT: ["card_request_owner_approved", "card_request_declined", "card_request_expired"],
  AGENT_ACTIVITY_ONLY: ["card_request_approved"],
  AUDIT_ONLY: ["card_request_policy_set"],
} as const);
export const DASHBOARD_READ_OPS_V54 = ["card_requests"] as const;
export const DASHBOARD_SENSITIVE_OPS_V54 = ["card_request_decide", "card_request_policy_set"] as const;

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');`;

// The hold needs an approved request (checked after the authority, limit and open-hold checks, before anything is reserved).
const AUTHORIZE = restate(V51_SQL, "fleet_econ_card_authorize", [
  [`        eco jsonb; v_avail bigint; v_env uuid; v_j uuid; v_from text;`, `        eco jsonb; v_avail bigint; v_env uuid; v_j uuid; v_from text; rq fleet_card_requests;`],
  [`  -- v51: reserve the maximum before the card can be filled`,
   `  -- v54: PayPal first — the card only under an approved request (Fleet Control, or the owner above the threshold).
  IF NOT (a ? 'requestId') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CARD_REQUEST_REQUIRED',
      'reason', 'pay through the treasury PayPal where the payee takes it; if PayPal is truly unavailable, ask Fleet Control with card_request first');
  END IF;
  SELECT * INTO rq FROM fleet_card_requests WHERE request_id = fleet_identity_uuid(a, 'requestId') AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND', 'reason', 'requestId: one of your card requests'); END IF;
  IF rq.status IN ('approved','pending_owner') AND rq.expires_at <= now() THEN
    UPDATE fleet_card_requests SET status = 'expired' WHERE request_id = rq.request_id RETURNING * INTO rq;
  END IF;
  IF rq.status <> 'approved' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CARD_REQUEST_NOT_APPROVED', 'status', rq.status); END IF;
  IF rq.account_id <> acc.account_id OR rq.origin <> v_origin OR v_max > rq.amount_minor OR rq.envelope_id IS DISTINCT FROM (CASE WHEN a ? 'envelopeId' THEN fleet_identity_uuid(a, 'envelopeId') END) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CARD_REQUEST_MISMATCH',
      'reason', 'the hold must be on the approved account, site and envelope, for no more than the approved amount', 'approvedMinor', rq.amount_minor);
  END IF;
  -- v51: reserve the maximum before the card can be filled`],
  [`            CASE WHEN v_env IS NULL THEN 'own' ELSE 'envelope' END, v_env, v_max) RETURNING * INTO c;`,
   `            CASE WHEN v_env IS NULL THEN 'own' ELSE 'envelope' END, v_env, v_max) RETURNING * INTO c;
  UPDATE fleet_card_requests SET status = 'used', charge_id = c.charge_id WHERE request_id = rq.request_id;`],
]);

// A pre-funded request (owner approval above the threshold): the owner's transfer becomes the card repayment once booked.
const CHARGE_POST = restate(V51_SQL, "fleet_card_charge_post", [
  [`  SELECT * INTO ch FROM fleet_card_charges WHERE charge_id = p_charge;
  IF v_adv > 0 THEN`, `  SELECT * INTO ch FROM fleet_card_charges WHERE charge_id = p_charge;
  IF d > 0 THEN PERFORM fleet_card_request_prefund_settle(p_charge); END IF;
  IF v_adv > 0 THEN`],
]);

const DISPATCH = restate(V52_SQL, "api_economy", [
  [`WHEN 'wallet.measure' THEN 'ledger.read'`, `${CARD_REQUEST_OPS.map((o) => `WHEN '${o}' THEN 'planning'`).join(" ")} WHEN 'wallet.measure' THEN 'ledger.read'`],
  [`      WHEN 'wallet.measure' THEN jsonb_build_object('ok', true) || fleet_agent_wallet_measure(p_agent)`,
   `      WHEN 'wallet.measure' THEN jsonb_build_object('ok', true) || fleet_agent_wallet_measure(p_agent)
      WHEN 'card.request' THEN fleet_econ_card_request(p_agent, a)
      WHEN 'card.requests' THEN fleet_econ_card_requests(p_agent, a)`],
]);

const DASH_CALL = restate(V53_SQL, "dash_call", [
  [`'paypal_test_checkout');`, `'paypal_test_checkout',${q(DASHBOARD_SENSITIVE_OPS_V54)});`],
  [`'storefront','paypal_test')) THEN`, `'storefront','paypal_test',${q(DASHBOARD_READ_OPS_V54)})) THEN`],
  [`      WHEN 'paypal_test' THEN fleet_paypal_test_json()`,
   `      WHEN 'paypal_test' THEN fleet_paypal_test_json()
      WHEN 'card_requests' THEN fleet_card_requests_json(a ->> 'agentId')`],
  [`      WHEN 'card_statement_issue' THEN`,
   `      WHEN 'card_request_decide' THEN fleet_admin_card_request_decide((a ->> 'requestId')::uuid, a ->> 'decision', a ->> 'reference', a ->> 'note', 'operator:owner')
      WHEN 'card_request_policy_set' THEN fleet_admin_card_request_policy_set((a ->> 'ownerReviewAboveMinor')::bigint, (a ->> 'validHours')::integer, 'operator:owner')
      WHEN 'card_statement_issue' THEN`],
]);

const EVENT_ROUTE = restate(V53_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V54) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
]);

export const V54_SQL = `
-- ═══ 1. Policy and requests ═══
CREATE TABLE fleet_card_request_policy (
  id                      integer     PRIMARY KEY CHECK (id = 1),
  owner_review_above_minor bigint     NOT NULL DEFAULT 10000 CHECK (owner_review_above_minor >= 0),
  valid_hours             integer     NOT NULL DEFAULT 48 CHECK (valid_hours BETWEEN 1 AND 336),
  updated_by              text        NOT NULL DEFAULT 'migration',
  updated_at              timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fleet_card_request_policy (id) VALUES (1);
CREATE TRIGGER fleet_card_request_policy_no_delete BEFORE DELETE ON fleet_card_request_policy FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_card_request_policy_no_truncate BEFORE TRUNCATE ON fleet_card_request_policy FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_card_requests (
  request_id        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          text        NOT NULL REFERENCES fleet_agents(agent_id),
  account_id        uuid        NOT NULL REFERENCES fleet_agent_accounts(account_id),
  origin            text        NOT NULL CHECK (origin ~ '^https://[A-Za-z0-9.-]{3,253}(:[0-9]{2,5})?$'),
  merchant          text        NOT NULL CHECK (length(merchant) BETWEEN 2 AND 120),
  amount_minor      bigint      NOT NULL CHECK (amount_minor > 0),
  envelope_id       uuid        REFERENCES fleet_envelopes(envelope_id),
  paypal_unavailable text       NOT NULL CHECK (paypal_unavailable IN (${q(PAYPAL_UNAVAILABLE_REASONS)})),
  purpose           text        NOT NULL CHECK (length(purpose) BETWEEN 3 AND 300),
  status            text        NOT NULL CHECK (status IN ('approved','pending_owner','declined','used','expired')),
  decided_by        text,
  decided_at        timestamptz,
  decision_note     text        CHECK (length(decision_note) <= 300),
  prefund_reference text        CHECK (length(prefund_reference) BETWEEN 2 AND 100),
  prefund_minor     bigint      CHECK (prefund_minor > 0),
  charge_id         uuid        UNIQUE REFERENCES fleet_card_charges(charge_id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  CHECK ((prefund_reference IS NULL) = (prefund_minor IS NULL)),
  CHECK ((status = 'used') = (charge_id IS NOT NULL))
);
CREATE INDEX fleet_card_requests_agent ON fleet_card_requests (agent_id, created_at DESC);
CREATE INDEX fleet_card_requests_open ON fleet_card_requests (expires_at) WHERE status IN ('approved','pending_owner');
CREATE FUNCTION fleet_card_requests_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status IN ('declined','used','expired') THEN RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: a settled card request is history'; END IF;
  IF NEW.request_id <> OLD.request_id OR NEW.agent_id <> OLD.agent_id OR NEW.account_id <> OLD.account_id OR NEW.origin <> OLD.origin OR NEW.merchant <> OLD.merchant
     OR NEW.amount_minor <> OLD.amount_minor OR NEW.envelope_id IS DISTINCT FROM OLD.envelope_id OR NEW.paypal_unavailable <> OLD.paypal_unavailable
     OR NEW.purpose <> OLD.purpose OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a card request''s terms are fixed';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'pending_owner' AND NEW.status IN ('approved','declined','expired'))
                                    OR (OLD.status = 'approved' AND NEW.status IN ('used','expired'))) THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: card request % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_card_requests_guard BEFORE UPDATE OR DELETE ON fleet_card_requests FOR EACH ROW EXECUTE FUNCTION fleet_card_requests_guard();
CREATE TRIGGER fleet_card_requests_no_truncate BEFORE TRUNCATE ON fleet_card_requests FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- Can the treasury pay out through PayPal right now (an owner custody activation and a ready PayPal payouts rail)?
CREATE FUNCTION fleet_paypal_payouts_available() RETURNS boolean LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM fleet_custody_activation_live())
     AND EXISTS (SELECT 1 FROM fleet_payment_rails x WHERE x.provider = 'paypal' AND x.status = 'active' AND x.mode = 'live' AND 'payouts' = ANY(x.capabilities)
                  AND fleet_rail_capability_ready(x.rail_id, 'payouts'))
$$;

CREATE FUNCTION fleet_card_request_json(r fleet_card_requests) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('requestId', r.request_id, 'agentId', r.agent_id, 'accountId', r.account_id, 'origin', r.origin, 'merchant', r.merchant,
    'amountMinor', r.amount_minor, 'envelopeId', r.envelope_id, 'paypalUnavailable', r.paypal_unavailable, 'purpose', r.purpose, 'status', r.status,
    'decidedBy', r.decided_by, 'decidedAt', r.decided_at, 'note', r.decision_note, 'prefundReference', r.prefund_reference, 'prefundMinor', r.prefund_minor,
    'chargeId', r.charge_id, 'createdAt', r.created_at, 'expiresAt', r.expires_at))
$$;

-- Agent: ask Fleet Control for the card (PayPal truly unavailable).
CREATE FUNCTION fleet_econ_card_request(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE au fleet_identity_autonomy; acc fleet_agent_accounts; p fleet_card_request_policy; r fleet_card_requests; e fleet_envelopes; eco jsonb;
        v_origin text; v_amount bigint; v_reason text := a ->> 'paypalUnavailable'; v_purpose text; v_merchant text := fleet_econ_text(a, 'merchant', 120, true);
        v_env uuid; v_avail bigint;
BEGIN
  SELECT * INTO au FROM fleet_identity_autonomy WHERE id = 1;
  IF NOT au.enabled OR NOT au.card_enabled THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NO_STANDING_AUTHORITY', 'reason', 'the owner has not enabled the card; pay through the treasury PayPal (a registered vendor)');
  END IF;
  SELECT * INTO acc FROM fleet_agent_accounts WHERE account_id = fleet_identity_uuid(a, 'accountId') AND agent_id = p_agent;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: accountId — one of your accounts (the merchant site you would pay on)'; END IF;
  IF acc.status IN ('frozen','closed','banned') THEN RAISE EXCEPTION 'FLEET_ACCOUNT_FROZEN: that account cannot be used'; END IF;
  v_origin := lower(COALESCE(a ->> 'origin', acc.origins[1]));
  IF v_origin IS NULL OR NOT (v_origin = ANY (acc.origins)) THEN PERFORM fleet_econ_bad('origin is one of the account''s pinned origins (add_origin first)'); END IF;
  v_amount := CASE WHEN jsonb_typeof(a -> 'amountMinor') = 'number' THEN (a ->> 'amountMinor')::bigint END;
  IF v_amount IS NULL OR v_amount <= 0 THEN PERFORM fleet_econ_bad('amountMinor — the most this purchase may cost, in minor units'); END IF;
  IF v_reason IS NULL OR v_reason NOT IN (${q(PAYPAL_UNAVAILABLE_REASONS)}) THEN
    PERFORM fleet_econ_bad('paypalUnavailable — why the treasury PayPal cannot pay: ${PAYPAL_UNAVAILABLE_REASONS.join("|")}');
  END IF;
  v_purpose := left(trim(fleet_scrub(COALESCE(a ->> 'purpose', ''))), 300);
  IF length(v_purpose) < 3 THEN PERFORM fleet_econ_bad('purpose — what the purchase is for (and why it matters to your survival or opportunity)'); END IF;
  IF v_reason = 'payouts_unavailable' AND fleet_paypal_payouts_available() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PAYPAL_FIRST',
      'reason', 'the treasury can pay through PayPal now: register the payee as a vendor and spend through it; the card is only for payees PayPal cannot reach');
  END IF;
  IF (SELECT count(*) FROM fleet_card_requests WHERE agent_id = p_agent AND status IN ('approved','pending_owner') AND expires_at > now()) >= 5 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_LIMIT', 'reason', 'five open card requests: use or let them expire first');
  END IF;
  -- The card is never an open pool: the agent's own spendable capital (or the named envelope) must cover the whole amount.
  IF a ? 'envelopeId' THEN
    v_env := fleet_identity_uuid(a, 'envelopeId');
    e := fleet_card_envelope_open(p_agent, v_env);
    IF e.envelope_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ENVELOPE_UNAVAILABLE', 'reason', 'not one of your active envelopes that permits expense'); END IF;
    v_avail := LEAST((fleet_envelope_position(e) ->> 'availableMinor')::bigint, fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_envelope_cash')));
  ELSE
    eco := fleet_agent_economics(p_agent);
    v_avail := GREATEST(0, LEAST((eco ->> 'cash')::bigint, (eco ->> 'survivalEquity')::bigint));
  END IF;
  IF v_amount > v_avail THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INSUFFICIENT_FUNDS', 'availableMinor', GREATEST(v_avail, 0),
      'reason', 'the card is limited to your own wallet (or the named envelope): lower the amount or request Fleet capital first');
  END IF;
  SELECT * INTO p FROM fleet_card_request_policy WHERE id = 1;
  INSERT INTO fleet_card_requests (agent_id, account_id, origin, merchant, amount_minor, envelope_id, paypal_unavailable, purpose, status, decided_by, decided_at, expires_at)
    VALUES (p_agent, acc.account_id, v_origin, left(fleet_scrub(v_merchant), 120), v_amount, v_env, v_reason, v_purpose,
            CASE WHEN v_amount <= p.owner_review_above_minor THEN 'approved' ELSE 'pending_owner' END,
            CASE WHEN v_amount <= p.owner_review_above_minor THEN 'fleet_control' END,
            CASE WHEN v_amount <= p.owner_review_above_minor THEN now() END,
            now() + CASE WHEN v_amount <= p.owner_review_above_minor THEN p.valid_hours * interval '1 hour' ELSE interval '72 hours' END)
    RETURNING * INTO r;
  IF r.status = 'approved' THEN
    PERFORM fleet_event('card_request_approved', p_agent, 'fleet_control', jsonb_build_object('requestId', r.request_id, 'merchant', r.merchant, 'amountMinor', v_amount,
      'paypalUnavailable', v_reason));
    RETURN jsonb_build_object('ok', true, 'request', fleet_card_request_json(r),
      'note', 'approved by Fleet Control: open the hold with card_authorize {requestId, accountId, merchant, maxMinor ≤ the approved amount} before it expires');
  END IF;
  PERFORM fleet_event('card_request_owner_review', p_agent, 'fleet_control', jsonb_build_object('requestId', r.request_id, 'merchant', r.merchant, 'origin', v_origin,
    'amountMinor', v_amount, 'paypalUnavailable', v_reason, 'purpose', v_purpose,
    'note', 'above your card threshold: move the amount from the treasury to the card, then approve with the transfer reference — or decline'));
  RETURN jsonb_build_object('ok', true, 'request', fleet_card_request_json(r),
    'note', 'above the owner''s threshold: the owner decides (and funds the card first); check card_requests — keep working on other things meanwhile');
END $$;

CREATE FUNCTION fleet_econ_card_requests(p_agent text, a jsonb) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('ok', true, 'paypalPayoutsAvailable', fleet_paypal_payouts_available(),
    'ownerReviewAboveMinor', (SELECT owner_review_above_minor FROM fleet_card_request_policy WHERE id = 1),
    'requests', COALESCE((SELECT jsonb_agg(fleet_card_request_json(r) ORDER BY r.created_at DESC)
      FROM (SELECT * FROM fleet_card_requests WHERE agent_id = p_agent ORDER BY created_at DESC LIMIT 50) r), '[]'::jsonb))
$$;

-- Owner: decide a request above the threshold. Approve only after moving the amount from the treasury to the card.
CREATE FUNCTION fleet_admin_card_request_decide(p_request uuid, p_decision text, p_reference text, p_note text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_card_requests; p fleet_card_request_policy;
BEGIN
  ${OWNER_ACTOR}
  SELECT * INTO r FROM fleet_card_requests WHERE request_id = p_request FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such card request'; END IF;
  IF r.status <> 'pending_owner' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: this request is %', r.status; END IF;
  IF r.expires_at <= now() THEN
    UPDATE fleet_card_requests SET status = 'expired' WHERE request_id = r.request_id;
    RAISE EXCEPTION 'FLEET_INVALID_STATE: this request expired; the agent can ask again';
  END IF;
  SELECT * INTO p FROM fleet_card_request_policy WHERE id = 1;
  IF p_decision = 'approve' THEN
    IF p_reference IS NULL OR length(trim(p_reference)) < 2 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the reference of your treasury → card transfer'; END IF;
    IF EXISTS (SELECT 1 FROM fleet_card_repayments WHERE reference IN (trim(p_reference), 'prefund:' || trim(p_reference)))
       OR EXISTS (SELECT 1 FROM fleet_card_requests WHERE prefund_reference = trim(p_reference)) THEN
      RAISE EXCEPTION 'FLEET_ALREADY_CLAIMED: that transfer reference is already recorded';
    END IF;
    UPDATE fleet_card_requests SET status = 'approved', decided_by = p_actor, decided_at = now(), decision_note = left(fleet_scrub(p_note), 300),
           prefund_reference = left(trim(p_reference), 100), prefund_minor = r.amount_minor, expires_at = now() + p.valid_hours * interval '1 hour'
     WHERE request_id = r.request_id RETURNING * INTO r;
    PERFORM fleet_event('card_request_owner_approved', r.agent_id, p_actor, jsonb_build_object('requestId', r.request_id, 'amountMinor', r.amount_minor,
      'merchant', r.merchant, 'note', 'the card may now be used for this purchase'));
  ELSIF p_decision = 'decline' THEN
    UPDATE fleet_card_requests SET status = 'declined', decided_by = p_actor, decided_at = now(), decision_note = left(fleet_scrub(p_note), 300)
     WHERE request_id = r.request_id RETURNING * INTO r;
    PERFORM fleet_event('card_request_declined', r.agent_id, p_actor, jsonb_build_object('requestId', r.request_id, 'amountMinor', r.amount_minor, 'merchant', r.merchant,
      'note', r.decision_note));
  ELSE
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: decision approve|decline';
  END IF;
  RETURN jsonb_build_object('ok', true, 'request', fleet_card_request_json(r));
END $$;

CREATE FUNCTION fleet_admin_card_request_policy_set(p_threshold bigint, p_valid_hours integer, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_card_request_policy;
BEGIN
  ${OWNER_ACTOR}
  IF p_threshold IS NOT NULL AND p_threshold < 0 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the owner-review threshold is ≥ 0'; END IF;
  IF p_valid_hours IS NOT NULL AND p_valid_hours NOT BETWEEN 1 AND 336 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: valid hours 1..336'; END IF;
  UPDATE fleet_card_request_policy SET owner_review_above_minor = COALESCE(p_threshold, owner_review_above_minor), valid_hours = COALESCE(p_valid_hours, valid_hours),
         updated_by = p_actor, updated_at = now() WHERE id = 1 RETURNING * INTO p;
  PERFORM fleet_event('card_request_policy_set', NULL, p_actor, jsonb_build_object('ownerReviewAboveMinor', p.owner_review_above_minor, 'validHours', p.valid_hours));
  RETURN jsonb_build_object('ok', true, 'ownerReviewAboveMinor', p.owner_review_above_minor, 'validHours', p.valid_hours);
END $$;

-- Owner's view: requests awaiting a decision first, then recent ones.
CREATE FUNCTION fleet_card_requests_json(p_agent text) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('ownerReviewAboveMinor', p.owner_review_above_minor, 'validHours', p.valid_hours, 'paypalPayoutsAvailable', fleet_paypal_payouts_available(),
    'requests', COALESCE((SELECT jsonb_agg(fleet_card_request_json(r) || jsonb_build_object('agentName', (SELECT name FROM fleet_agents x WHERE x.agent_id = r.agent_id))
        ORDER BY (r.status = 'pending_owner' AND r.expires_at > now()) DESC, r.created_at DESC)
      FROM (SELECT * FROM fleet_card_requests WHERE p_agent IS NULL OR agent_id = p_agent ORDER BY created_at DESC LIMIT 100) r), '[]'::jsonb))
  FROM fleet_card_request_policy p WHERE p.id = 1
$$;

-- Booking a charge under a pre-funded request: the owner's transfer is that charge's card repayment (once).
CREATE FUNCTION fleet_card_request_prefund_settle(p_charge uuid) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_card_requests; ch fleet_card_charges; v_ref text; v_amount bigint;
BEGIN
  SELECT * INTO r FROM fleet_card_requests WHERE charge_id = p_charge AND prefund_reference IS NOT NULL;
  IF NOT FOUND THEN RETURN; END IF;
  v_ref := 'prefund:' || r.prefund_reference;
  IF EXISTS (SELECT 1 FROM fleet_card_repayments WHERE reference = v_ref) THEN RETURN; END IF;
  SELECT * INTO ch FROM fleet_card_charges WHERE charge_id = p_charge;
  v_amount := LEAST(r.prefund_minor, ch.amount_minor, fleet_ledger_balance('fleet:card:payable'));
  IF v_amount > 0 THEN PERFORM fleet_admin_card_repayment_record(v_amount, v_ref, r.decided_by); END IF;
END $$;

-- Reaper: open requests past their time expire (a pre-funded one tells the owner the money is still on the card).
CREATE FUNCTION svc_card_requests_expire() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_card_requests; n integer := 0;
BEGIN
  FOR r IN SELECT * FROM fleet_card_requests WHERE status IN ('approved','pending_owner') AND expires_at <= now() ORDER BY expires_at LIMIT 200 FOR UPDATE SKIP LOCKED LOOP
    UPDATE fleet_card_requests SET status = 'expired' WHERE request_id = r.request_id;
    IF r.prefund_reference IS NOT NULL THEN
      PERFORM fleet_event('card_request_expired', r.agent_id, 'controller', jsonb_build_object('requestId', r.request_id, 'amountMinor', r.amount_minor,
        'prefundReference', r.prefund_reference, 'note', 'approved and funded but never used: the money you moved to the card is still there'));
    END IF;
    n := n + 1;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'expired', n);
END $$;

${AUTHORIZE}

${CHARGE_POST}

-- ═══ 2. Agent operations, dashboard, routing ═══
${DISPATCH}

${DASH_CALL}

${EVENT_ROUTE}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

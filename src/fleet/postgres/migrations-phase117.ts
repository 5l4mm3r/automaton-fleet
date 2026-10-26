/**
 * Schema v117 — every Fleet Control AI call is funded before it is made, and every completed call is recorded (owner
 * correction, 2026-10-26: "Calls must either reserve valid funding before execution or stop; completed usage must always be
 * recorded … including late results — without double charging").
 *
 * Until now a Fleet Control call (spend review, lesson review, message check, evidence relevance) reserved its bounded
 * maximum against the daily AI ceiling only. Its cost was then posted from the treasury's unallocated money as far as that
 * reached, and the rest was dropped ("unfunded": the provider credit was drawn, but no expense or payable was posted);
 * evidence-relevance calls were never posted in GBP at all; a cost the provider did not report stayed an open maximum
 * with nothing recorded; and an unfunded treasury burned review attempts until the review stalled. Now:
 *
 *  - Reserve (svc_fleet_control_ai_reserve, before the call, under the budget row's lock): the daily ceiling as before, AND
 *    real funding — the call's maximum in GBP is moved from fleet:treasury:unallocated into fleet:treasury:control_reserved
 *    (a held partition of treasury cash: one journal), AND its maximum in provider credit is held (it counts in
 *    fleet_provider_credit_held, so agent inference, engineering holds and other reservations cannot use it). Without
 *    room, money or credit: refused — no call (FLEET_CONTROL_AI_BUDGET_UNFUNDED). The reservation carries the call's request id.
 *  - Settle (once per reservation, whoever reports it first — the worker right after the call, a late result through the
 *    record path, the minutely sweep, or the owner's reconciliation): the provider-credit consumption for the request id
 *    (written once; if already written, that amount is the actual), the GBP charge posted from the held partition (the v69
 *    legs: expense, owed to the owner), and the rest of the hold released. The sub-penny remainder accrues per kind, as
 *    before; nothing is dropped. A cost above the bound (a wrong bound) is still posted in full: from unallocated money
 *    while there is any, the rest as owed to the owner without cash — and Fleet Command is told.
 *  - Unknown cost (the provider reported no usage): the hold stays in place, Fleet Command is told, and the reservation
 *    waits for a late result or the owner's reconciliation (economy-fleet-control-ai-reconcile) — never released unrecorded.
 *  - Sweep (minutely settlement): a reservation still open 15 minutes after it was made is settled from its recorded
 *    consumption if there is one, otherwise marked unknown (hold kept).
 *  - Claims wait while Fleet Control cannot be funded (no attempt is used, the review stays pending, Fleet Command is told
 *    once a day). Nothing is ever approved because a review could not be paid for.
 *  - Double charging is impossible: one consumption event per request id (unique), one settlement per reservation (row
 *    lock + status), one hold / charge / release journal per reservation (idempotency keys), and the record paths count
 *    a call's cost toward its review once.
 * The migration posts nothing (existing reservations are marked legacy and keep their old meaning).
 */
import { V24_SQL } from "./migrations-phase24.js";
import { V96_SQL } from "./migrations-phase96.js";
import { V111_SQL } from "./migrations-phase111.js";
import { V115_SQL } from "./migrations-phase115.js";
import { V116_SQL } from "./migrations-phase116.js";
import { restate } from "./migrations-phase42.js";

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');`;

export const CONTROL_RESERVED_ACCOUNT = "fleet:treasury:control_reserved";
export const CONTROL_HOLD_KIND = "fleet_control_ai_hold";
export const CONTROL_RELEASE_KIND = "fleet_control_ai_release";
export const RELEVANCE_CHARGE_KIND = "evidence_relevance_charge";
/** A reservation still open this long after it was made is settled from its recorded consumption, or marked unknown. */
export const CONTROL_SWEEP_AFTER_MINUTES = 15;
/** Each Fleet Control call kind and the ledger kind its cost is posted under. */
export const CONTROL_CHARGE_KINDS = Object.freeze({
  spend_review: "spend_review_charge", knowledge_review: "knowledge_review_charge", message_check: "message_check_charge",
  evidence_relevance: RELEVANCE_CHARGE_KIND,
} as const);
/** The recorder each kind's consumption has always carried (v64 / v65 / v115 / v24; v73 matches journals by it). */
export const CONTROL_RECORDERS = Object.freeze({
  spend_review: "controller:spend_review", knowledge_review: "controller:knowledge_review_charge", message_check: "controller:message_check_charge",
  evidence_relevance: "controller:evidence_relevance",
} as const);
export const EVENT_ROUTES_V117 = Object.freeze({
  P2_IMPORTANT: ["fleet_control_ai_unfunded", "fleet_control_ai_cost_unknown", "fleet_control_ai_unreserved_call"],
  P3_SUMMARY: ["fleet_control_ai_reconciled"],
});

const KIND_CASE = (col: string) => `CASE ${col} ${Object.entries(CONTROL_CHARGE_KINDS).map(([k, v]) => `WHEN '${k}' THEN '${v}'`).join(" ")} END`;
const CHARGE_TO_KIND = (col: string) => `CASE ${col} ${Object.entries(CONTROL_CHARGE_KINDS).map(([k, v]) => `WHEN '${v}' THEN '${k}'`).join(" ")} END`;
const RATE = `(SELECT rate_micro FROM fleet_fx_rates WHERE base = 'USD' AND quote = (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1)
     ORDER BY observed_on DESC, rate_id DESC LIMIT 1)`;

// Claims: wait (no attempt used) while Fleet Control cannot be funded.
const GATE = (tier: string) => `    IF NOT fleet_control_ai_fundable(v_est, pol.estimate_usd_microcents, ${tier}) THEN EXIT; END IF;\n`;
const SPEND_CLAIM = restate(V96_SQL, "svc_spend_reviews_claim", [
  [`    IF v_avail < v_est THEN
      -- The treasury cannot pay for the review: never approve silently; retry later, bounded.
      PERFORM fleet_spend_review_failed_internal(rv, 'FLEET_TREASURY_INSUFFICIENT: the treasury cannot fund the review call', pol);
      CONTINUE;
    END IF;
`, `    -- v117: Fleet Control cannot fund the review: it waits (no attempt used; never approved by default).
${GATE("pol.review_tier")}`],
]);
const KNOWLEDGE_CLAIM = restate(V96_SQL, "svc_knowledge_proposals_claim", [
  [`    IF fleet_ledger_balance('fleet:treasury:unallocated') < v_est THEN
      PERFORM fleet_knowledge_review_failed_internal(st.proposal_id, 'FLEET_TREASURY_INSUFFICIENT: the treasury cannot fund the review call', false);
      CONTINUE;
    END IF;
`, `    -- v117: Fleet Control cannot fund the review: it waits (no attempt used).
${GATE("pol.review_tier")}`],
]);
const MESSAGE_CLAIM = restate(V115_SQL, "svc_message_checks_claim", [
  [`    IF (fleet_control_ai_state() ->> 'roomMinor')::bigint < v_est THEN PERFORM fleet_control_ai_budget_reached(); EXIT; END IF;
`, `    IF (fleet_control_ai_state() ->> 'roomMinor')::bigint < v_est THEN PERFORM fleet_control_ai_budget_reached(); EXIT; END IF;
${GATE("pol.review_tier")}`],
]);
const RELEVANCE_PENDING = restate(V96_SQL, "svc_experiment_relevance_pending", [
  [`  v_room := LEAST(v_room, GREATEST(0, ((fleet_control_ai_state() ->> 'roomMinor')::bigint / GREATEST((fleet_control_ai_state() ->> 'estimateMinor')::bigint * 2, 1))::integer));`,
   `  v_room := LEAST(v_room, GREATEST(0, ((fleet_control_ai_state() ->> 'roomMinor')::bigint / GREATEST((fleet_control_ai_state() ->> 'estimateMinor')::bigint * 2, 1))::integer));
  -- v117: and within what Fleet Control can fund (GBP and provider credit; each job up to two calls at the estimate).
  v_room := LEAST(v_room, GREATEST(0, LEAST(
    (fleet_ledger_balance('fleet:treasury:unallocated') / GREATEST((fleet_control_ai_state() ->> 'estimateMinor')::bigint * 2, 1)),
    ((fleet_provider_credit_balance((SELECT provider FROM fleet_cognition_tiers WHERE tier = 'T2')) - fleet_provider_credit_held((SELECT provider FROM fleet_cognition_tiers WHERE tier = 'T2')))
      / GREATEST((SELECT estimate_usd_microcents FROM fleet_spend_review_policy WHERE id = 1) * 2, 1)))::integer));`],
]);

// Provider credit held: engineering holds AND Fleet Control reservations not yet settled (their maximum).
const HELD = restate(V111_SQL, "fleet_provider_credit_held", [
  [`  SELECT COALESCE(sum(usd_microcents), 0)::bigint FROM fleet_provider_credit_holds WHERE provider = p_provider AND status = 'open';`,
   `  SELECT (SELECT COALESCE(sum(usd_microcents), 0) FROM fleet_provider_credit_holds WHERE provider = p_provider AND status = 'open')::bigint
       + (SELECT COALESCE(sum(max_usd_microcents), 0) FROM fleet_control_ai_reservations WHERE provider = p_provider AND status IN ('open','unknown'))::bigint;`],
]);

const STATE = restate(V96_SQL, "fleet_control_ai_state", [
  [`'setBy', b.set_by, 'setAt', b.set_at, 'reason', b.reason,`,
   `'setBy', b.set_by, 'setAt', b.set_at, 'reason', b.reason,
    'funding', jsonb_build_object('unallocatedMinor', fleet_ledger_balance('fleet:treasury:unallocated'), 'heldMinor', fleet_ledger_balance('${CONTROL_RESERVED_ACCOUNT}'),
      'open', (SELECT count(*) FROM fleet_control_ai_reservations WHERE status = 'open'),
      'unknownCost', (SELECT COALESCE(jsonb_agg(jsonb_build_object('reservationId', x.reservation_id, 'kind', x.kind, 'ref', x.ref, 'requestId', x.request_id,
                        'maxUsdMicrocents', x.max_usd_microcents, 'heldMinor', x.held_minor, 'reservedAt', x.reserved_at) ORDER BY x.reserved_at), '[]'::jsonb)
                      FROM fleet_control_ai_reservations x WHERE x.status = 'unknown'),
      'rule', 'each call holds its maximum in GBP (treasury) and provider credit before it is made; settled once at its actual cost; an unknown cost keeps its hold until reconciled'),`],
]);

const SETTLE = restate(V116_SQL, "svc_ai_credit_settle", [
  [`  v_detect := v_detect || jsonb_build_object('promotionalExpired', fleet_ai_credit_promotional_expire());`,
   `  v_detect := v_detect || jsonb_build_object('promotionalExpired', fleet_ai_credit_promotional_expire());
  v_detect := v_detect || jsonb_build_object('fleetControlSweep', fleet_control_ai_sweep());`],
]);

// The owner's reconciliation of an unknown-cost relevance call also settles its Fleet Control reservation (GBP posted once).
const RELEVANCE_RECONCILE = restate(V24_SQL, "fleet_relevance_call_reconcile", [
  [`  PERFORM fleet_event('provider_cost_reconciled', NULL, p_actor, jsonb_build_object('requestId', p_request, 'usdMicrocents', p_usd_microcents, 'source', 'evidence_relevance'));`,
   `  PERFORM fleet_control_ai_settle_request(p_request, p_usd_microcents, p_ref, p_actor);
  PERFORM fleet_event('provider_cost_reconciled', NULL, p_actor, jsonb_build_object('requestId', p_request, 'usdMicrocents', p_usd_microcents, 'source', 'evidence_relevance'));`],
]);

export const V117_SQL = `
-- ═══ 1. The held partition and its journals ═══
INSERT INTO fleet_ledger_accounts (account_id, class, description, created_by) VALUES
  ('${CONTROL_RESERVED_ACCOUNT}', 'treasury_cash', 'Treasury cash held for Fleet Control AI calls in flight (each call''s maximum, until it is settled)', 'migration');
INSERT INTO fleet_ledger_kinds (kind, requires_external_ref, allowed_sources, multi_agent, description, provenance) VALUES
  ('${CONTROL_HOLD_KIND}', false, ARRAY['controller'], false, 'Fleet Control AI call: its maximum cost held from unallocated treasury money before the call', 'reservation'),
  ('${CONTROL_RELEASE_KIND}', false, ARRAY['controller'], false, 'Fleet Control AI call settled: the unused part of its hold returned to unallocated treasury money', 'reservation');
INSERT INTO fleet_ledger_rules (kind, class, side) VALUES
  ('${CONTROL_HOLD_KIND}','treasury_cash','D'), ('${CONTROL_HOLD_KIND}','treasury_cash','C'),
  ('${CONTROL_RELEASE_KIND}','treasury_cash','D'), ('${CONTROL_RELEASE_KIND}','treasury_cash','C');
-- Evidence relevance is posted in GBP like the other reviews (it never was).
INSERT INTO fleet_ledger_kinds (kind, requires_external_ref, allowed_sources, multi_agent, description, provenance)
  SELECT '${RELEVANCE_CHARGE_KIND}', requires_external_ref, allowed_sources, multi_agent,
         'Fleet Control''s evidence-relevance assessment of an agent''s research, paid by the treasury (fleet overhead, never the agent)', provenance
    FROM fleet_ledger_kinds WHERE kind = 'knowledge_review_charge';
INSERT INTO fleet_ledger_rules (kind, class, side) SELECT '${RELEVANCE_CHARGE_KIND}', class, side FROM fleet_ledger_rules WHERE kind = 'knowledge_review_charge';

ALTER TABLE fleet_control_accrual DROP CONSTRAINT fleet_control_accrual_kind_check;
ALTER TABLE fleet_control_accrual ADD CONSTRAINT fleet_control_accrual_kind_check CHECK (kind IN (${q(Object.values(CONTROL_CHARGE_KINDS))}));
INSERT INTO fleet_control_accrual (kind) VALUES ('spend_review_charge'), ('${RELEVANCE_CHARGE_KIND}') ON CONFLICT DO NOTHING;

-- ═══ 2. Reservations carry their call, their hold and their settlement ═══
ALTER TABLE fleet_control_ai_reservations
  ADD COLUMN provider              text   CHECK (provider ~ '^[a-z][a-z0-9_]{1,39}$'),
  ADD COLUMN request_id            uuid   UNIQUE,
  ADD COLUMN max_usd_microcents    bigint CHECK (max_usd_microcents > 0),
  ADD COLUMN held_minor            bigint NOT NULL DEFAULT 0 CHECK (held_minor >= 0),
  ADD COLUMN actual_usd_microcents bigint CHECK (actual_usd_microcents >= 0),
  ADD COLUMN posted_minor          bigint CHECK (posted_minor >= 0),
  ADD COLUMN charged_micro         bigint CHECK (charged_micro >= 0),   -- the GBP micro this call added to its kind's accrual (v118 reverses the promotional part)
  ADD COLUMN status                text   NOT NULL DEFAULT 'open' CHECK (status IN ('open','unknown','settled','legacy')),
  ADD COLUMN unknown_at            timestamptz,
  ADD COLUMN settled_by            text   CHECK (settled_by ~ '^(controller|operator:[A-Za-z0-9._-]{1,64})$'),
  ADD COLUMN subject_counted       boolean NOT NULL DEFAULT false;
UPDATE fleet_control_ai_reservations SET status = 'legacy';   -- made before v117: no hold, their old meaning kept
ALTER TABLE fleet_control_ai_reservations ADD CONSTRAINT fleet_control_ai_reservations_v117 CHECK (status = 'legacy' OR (
  provider IS NOT NULL AND request_id IS NOT NULL AND max_usd_microcents IS NOT NULL
  AND (status = 'settled') = (settled_at IS NOT NULL AND actual_usd_microcents IS NOT NULL AND posted_minor IS NOT NULL)
  AND (status = 'unknown') = (unknown_at IS NOT NULL AND settled_at IS NULL)));
CREATE INDEX fleet_control_ai_reservations_open ON fleet_control_ai_reservations (reserved_at) WHERE status IN ('open','unknown');

${HELD}

-- ═══ 3. Funding ═══
-- Can Fleet Control fund a call of about this size now (GBP and provider credit)? Fleet Command is told once a day when not.
CREATE FUNCTION fleet_control_ai_fundable(p_minor bigint, p_usd_microcents bigint, p_tier text) RETURNS boolean LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_provider text := (SELECT provider FROM fleet_cognition_tiers WHERE tier = p_tier); v_free bigint; v_avail bigint;
BEGIN
  v_avail := fleet_ledger_balance('fleet:treasury:unallocated');
  v_free := CASE WHEN v_provider IS NULL THEN 0 ELSE fleet_provider_credit_balance(v_provider) - fleet_provider_credit_held(v_provider) END;
  IF v_avail >= GREATEST(COALESCE(p_minor, 1), 1) AND v_free >= GREATEST(COALESCE(p_usd_microcents, 1), 1) THEN RETURN true; END IF;
  IF NOT EXISTS (SELECT 1 FROM fleet_events WHERE event_type = 'fleet_control_ai_unfunded' AND created_at > now() - interval '24 hours') THEN
    PERFORM fleet_event('fleet_control_ai_unfunded', NULL, 'fleet_control', jsonb_build_object('unallocatedMinor', v_avail, 'neededMinor', p_minor,
      'provider', v_provider, 'freeCreditUsdMicrocents', v_free, 'neededUsdMicrocents', p_usd_microcents,
      'note', 'Fleet Control cannot fund its AI calls (treasury money or provider credit): spend reviews, lesson reviews and message checks wait — nothing is approved by default — until it can'));
  END IF;
  RETURN false;
END $$;

-- Before every paid call: the daily ceiling, then real funding, both held, under the budget row's lock. No room: no call.
DROP FUNCTION svc_fleet_control_ai_reserve(text, text, bigint);
CREATE FUNCTION svc_fleet_control_ai_reserve(p_kind text, p_ref text, p_max_usd_microcents bigint, p_request uuid, p_provider text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE b fleet_control_ai_budget; v_max bigint; v_used bigint; v_free bigint; v_avail bigint; x fleet_control_ai_reservations;
BEGIN
  IF p_kind NOT IN (${q(Object.keys(CONTROL_CHARGE_KINDS))}) OR p_ref IS NULL OR p_max_usd_microcents IS NULL OR p_max_usd_microcents <= 0
     OR p_request IS NULL OR p_provider IS NULL OR p_provider !~ '^[a-z][a-z0-9_]{1,39}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  SELECT * INTO b FROM fleet_control_ai_budget WHERE id = 1 FOR UPDATE;
  SELECT * INTO x FROM fleet_control_ai_reservations WHERE request_id = p_request;
  IF FOUND THEN
    IF x.kind = p_kind AND x.max_usd_microcents = p_max_usd_microcents THEN
      RETURN jsonb_build_object('ok', true, 'replay', true, 'reservationId', x.reservation_id, 'maxMinor', x.max_minor, 'status', x.status);
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CONFLICT', 'reason', 'that request id already has a different reservation');
  END IF;
  IF b.daily_ceiling_minor IS NULL THEN
    PERFORM fleet_control_ai_budget_reached();
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CONTROL_AI_BUDGET_UNSET', 'reason', 'the owner has not set Fleet Control''s daily AI budget');
  END IF;
  v_max := GREATEST(fleet_usd_microcents_minor(p_max_usd_microcents), 1);
  SELECT COALESCE(sum(COALESCE(actual_minor, max_minor)), 0) INTO v_used FROM fleet_control_ai_reservations WHERE reserved_at > now() - interval '24 hours';
  IF v_used + v_max > b.daily_ceiling_minor THEN
    PERFORM fleet_control_ai_budget_reached();
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CONTROL_AI_BUDGET', 'reason', 'Fleet Control''s daily AI budget has no room for this call',
      'usedMinor', v_used, 'maxMinor', v_max, 'ceilingMinor', b.daily_ceiling_minor);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('fleet_provider_credits:' || p_provider));
  v_avail := fleet_ledger_balance('fleet:treasury:unallocated');
  v_free := fleet_provider_credit_balance(p_provider) - fleet_provider_credit_held(p_provider);
  IF v_avail < v_max OR v_free < p_max_usd_microcents THEN
    PERFORM fleet_control_ai_fundable(v_max, p_max_usd_microcents, (SELECT tier FROM fleet_cognition_tiers WHERE provider = p_provider ORDER BY tier LIMIT 1));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CONTROL_AI_BUDGET_UNFUNDED',
      'reason', CASE WHEN v_avail < v_max THEN 'the treasury''s unallocated money cannot hold this call''s maximum' ELSE 'the provider credit cannot hold this call''s maximum' END,
      'maxMinor', v_max, 'unallocatedMinor', v_avail, 'maxUsdMicrocents', p_max_usd_microcents, 'freeCreditUsdMicrocents', v_free);
  END IF;
  INSERT INTO fleet_control_ai_reservations (kind, ref, max_minor, provider, request_id, max_usd_microcents, held_minor)
    VALUES (p_kind, left(p_ref, 100), v_max, p_provider, p_request, p_max_usd_microcents, v_max) RETURNING * INTO x;
  PERFORM fleet_ledger_post('${CONTROL_HOLD_KIND}', 'fcai:hold:' || x.reservation_id, 'controller', 'Fleet Control AI call: maximum held before the call',
    'controller', NULL, NULL, NULL, NULL, NULL, now(), jsonb_build_array(
      jsonb_build_object('account', '${CONTROL_RESERVED_ACCOUNT}', 'side', 'D', 'amount', v_max),
      jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', v_max)));
  RETURN jsonb_build_object('ok', true, 'reservationId', x.reservation_id, 'maxMinor', v_max, 'heldMinor', v_max);
END $$;

-- ═══ 4. Settlement: once per reservation, from whichever report comes first ═══
-- p_usd NULL: the cost is unknown — the hold stays and the owner is told. Otherwise: consumption (once per request id; an
-- amount already recorded is the actual), the GBP charge from the hold, the rest released.
CREATE FUNCTION fleet_control_ai_settle_internal(p_reservation uuid, p_usd bigint, p_ref text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_control_ai_reservations; v_usd bigint; v_micro bigint; v_unposted bigint; v_total bigint; v_charge bigint; v_funded bigint;
        v_from_unalloc bigint; v_cash bigint; v_release bigint; v_kind text; v_lines jsonb; v_was text;
BEGIN
  SELECT * INTO x FROM fleet_control_ai_reservations WHERE reservation_id = p_reservation FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF x.status IN ('settled','legacy') THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'status', x.status, 'actualUsdMicrocents', x.actual_usd_microcents); END IF;
  IF p_usd IS NULL THEN
    IF x.status = 'open' THEN
      UPDATE fleet_control_ai_reservations SET status = 'unknown', unknown_at = now() WHERE reservation_id = x.reservation_id;
      PERFORM fleet_event('fleet_control_ai_cost_unknown', NULL, 'fleet_control', jsonb_build_object('reservationId', x.reservation_id, 'kind', x.kind, 'ref', x.ref,
        'requestId', x.request_id, 'provider', x.provider, 'maxUsdMicrocents', x.max_usd_microcents, 'heldMinor', x.held_minor,
        'note', 'the provider reported no usage for this Fleet Control call: its maximum stays held (money and credit) until a late result or your reconciliation from the provider console (economy-fleet-control-ai-reconcile)'));
    END IF;
    RETURN jsonb_build_object('ok', true, 'status', 'unknown', 'kept', 'hold');
  END IF;
  IF p_usd < 0 THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  v_was := x.status;
  IF p_usd > 0 THEN
    INSERT INTO fleet_provider_credit_events (provider, kind, usd_microcents, request_id, external_ref, recorded_by)
      VALUES (x.provider, 'consumption', -p_usd, x.request_id, p_ref,
              COALESCE(NULLIF(p_actor, 'controller'), CASE x.kind ${Object.entries(CONTROL_RECORDERS).map(([k, v]) => `WHEN '${k}' THEN '${v}'`).join(" ")} END))
      ON CONFLICT (request_id) DO NOTHING;
  END IF;
  -- The provider-credit record is the actual (written once, by whichever path came first).
  v_usd := COALESCE((SELECT -usd_microcents FROM fleet_provider_credit_events WHERE request_id = x.request_id AND kind = 'consumption'), p_usd);
  v_kind := ${KIND_CASE("x.kind")};
  v_micro := CEIL(v_usd::numeric * COALESCE(${RATE}, 1000000) / 1000000)::bigint;
  SELECT unposted_microcents INTO v_unposted FROM fleet_control_accrual WHERE kind = v_kind FOR UPDATE;
  v_total := v_unposted + v_micro;
  v_charge := v_total / 1000000;
  v_funded := LEAST(v_charge, x.held_minor);
  v_from_unalloc := LEAST(v_charge - v_funded, GREATEST(fleet_ledger_balance('fleet:treasury:unallocated'), 0));
  v_cash := v_funded + v_from_unalloc;
  IF v_charge > 0 THEN
    v_lines := jsonb_build_array(jsonb_build_object('account', 'fleet:expense', 'side', 'D', 'amount', v_charge));
    IF v_funded > 0 THEN v_lines := v_lines || jsonb_build_object('account', '${CONTROL_RESERVED_ACCOUNT}', 'side', 'C', 'amount', v_funded); END IF;
    IF v_from_unalloc > 0 THEN v_lines := v_lines || jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', v_from_unalloc); END IF;
    IF v_cash > 0 THEN v_lines := v_lines || jsonb_build_object('account', 'fleet:treasury:owner_reimbursable', 'side', 'D', 'amount', v_cash); END IF;
    v_lines := v_lines || jsonb_build_object('account', 'fleet:owner:payable', 'side', 'C', 'amount', v_charge);
    PERFORM fleet_ledger_post(v_kind, 'fcai:charge:' || x.reservation_id, 'controller', 'Fleet Control ' || replace(x.kind, '_', ' ') || ' (AI assessment)',
      'controller', NULL, NULL, NULL, NULL, NULL, now(), v_lines);
  END IF;
  v_release := x.held_minor - v_funded;
  IF v_release > 0 THEN
    PERFORM fleet_ledger_post('${CONTROL_RELEASE_KIND}', 'fcai:release:' || x.reservation_id, 'controller', 'Fleet Control AI call settled: unused hold returned',
      'controller', NULL, NULL, NULL, NULL, NULL, now(), jsonb_build_array(
        jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', v_release),
        jsonb_build_object('account', '${CONTROL_RESERVED_ACCOUNT}', 'side', 'C', 'amount', v_release)));
  END IF;
  UPDATE fleet_control_accrual SET unposted_microcents = v_total - v_charge * 1000000, updated_at = now() WHERE kind = v_kind;
  UPDATE fleet_control_ai_reservations SET status = 'settled', actual_usd_microcents = v_usd, actual_minor = fleet_usd_microcents_minor(v_usd), posted_minor = v_charge,
         charged_micro = v_micro,
         settled_at = now(), settled_by = CASE WHEN p_actor ~ '^operator:' THEN p_actor ELSE 'controller' END
   WHERE reservation_id = x.reservation_id RETURNING * INTO x;
  IF v_usd > x.max_usd_microcents OR v_charge > x.held_minor THEN
    PERFORM fleet_event('fleet_control_ai_bound_exceeded', NULL, 'fleet_control', jsonb_build_object('reservationId', x.reservation_id, 'kind', x.kind,
      'maxUsdMicrocents', x.max_usd_microcents, 'actualUsdMicrocents', v_usd, 'heldMinor', x.held_minor, 'postedMinor', v_charge,
      'notHeldPostedMinor', v_charge - v_funded, 'owedWithoutCashMinor', v_charge - v_cash,
      'note', 'a Fleet Control call cost more than its computed maximum: posted in full anyway (beyond the hold from unallocated money, then owed to the owner); the bound is wrong and must be fixed'));
  END IF;
  IF v_was = 'unknown' THEN
    PERFORM fleet_event('fleet_control_ai_reconciled', NULL, COALESCE(NULLIF(p_actor, 'controller'), 'fleet_control'), jsonb_build_object('reservationId', x.reservation_id,
      'kind', x.kind, 'actualUsdMicrocents', v_usd, 'postedMinor', v_charge, 'ref', p_ref));
  END IF;
  RETURN jsonb_build_object('ok', true, 'status', 'settled', 'actualUsdMicrocents', v_usd, 'actualMinor', x.actual_minor, 'maxMinor', x.max_minor,
    'postedMinor', v_charge, 'releasedMinor', GREATEST(v_release, 0));
END $$;

CREATE OR REPLACE FUNCTION svc_fleet_control_ai_settle(p_reservation uuid, p_actual_usd_microcents bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  RETURN fleet_control_ai_settle_internal(p_reservation, p_actual_usd_microcents, NULL, 'controller');
END $$;

-- By request id (record paths and the owner's relevance reconciliation): NULL when the call has no reservation.
CREATE FUNCTION fleet_control_ai_settle_request(p_request uuid, p_usd bigint, p_ref text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_res uuid := (SELECT reservation_id FROM fleet_control_ai_reservations WHERE request_id = p_request);
BEGIN
  IF v_res IS NULL THEN RETURN NULL; END IF;
  RETURN fleet_control_ai_settle_internal(v_res, p_usd, p_ref, p_actor);
END $$;

-- The record paths (reviewer answers and failures, possibly late): each reported call settles its reservation if it is not
-- settled yet, and its cost counts toward the review once. A call without a reservation (never expected) is still recorded
-- in full — a reservation is created for it with nothing held, so it is posted like a bound overrun — and Fleet Command is told.
CREATE FUNCTION fleet_control_ai_record_calls(p_kind text, p_ref text, p_calls jsonb) RETURNS bigint LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c jsonb; x fleet_control_ai_reservations; v_usd bigint; v_counted bigint := 0;
BEGIN
  FOR c IN SELECT * FROM jsonb_array_elements(COALESCE(p_calls, '[]'::jsonb)) LOOP
    IF (c ->> 'requestId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR COALESCE(c ->> 'usdMicrocents', '') !~ '^[0-9]{1,15}$' THEN CONTINUE; END IF;
    v_usd := (c ->> 'usdMicrocents')::bigint;
    SELECT * INTO x FROM fleet_control_ai_reservations WHERE request_id = (c ->> 'requestId')::uuid FOR UPDATE;
    IF NOT FOUND THEN
      IF v_usd = 0 THEN CONTINUE; END IF;
      INSERT INTO fleet_control_ai_reservations (kind, ref, max_minor, provider, request_id, max_usd_microcents, held_minor)
        VALUES (p_kind, left(p_ref, 100), GREATEST(fleet_usd_microcents_minor(v_usd), 1), COALESCE(c ->> 'provider', 'anthropic'), (c ->> 'requestId')::uuid, v_usd, 0)
        RETURNING * INTO x;
      PERFORM fleet_event('fleet_control_ai_unreserved_call', NULL, 'fleet_control', jsonb_build_object('reservationId', x.reservation_id, 'kind', p_kind, 'ref', p_ref,
        'requestId', x.request_id, 'usdMicrocents', v_usd, 'note', 'a Fleet Control call was reported without a reservation: recorded and posted in full; this should not happen'));
    END IF;
    IF x.status IN ('open','unknown') THEN PERFORM fleet_control_ai_settle_internal(x.reservation_id, v_usd, NULL, 'controller'); END IF;
    UPDATE fleet_control_ai_reservations SET subject_counted = true WHERE reservation_id = x.reservation_id AND NOT subject_counted AND status = 'settled'
      RETURNING * INTO x;
    IF FOUND THEN v_counted := v_counted + x.actual_usd_microcents; END IF;
  END LOOP;
  RETURN v_counted;
END $$;

-- The v65 / v115 charge (lesson reviews, message checks) and the v64 spend-review charge now go through the reservations.
CREATE OR REPLACE FUNCTION fleet_control_charge(p_kind text, p_ref text, p_calls jsonb) RETURNS bigint LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  RETURN fleet_control_ai_record_calls(${CHARGE_TO_KIND("p_kind")}, p_ref, p_calls);
END $$;

CREATE OR REPLACE FUNCTION fleet_spend_review_charge(p_review uuid, p_calls jsonb) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_usd bigint;
BEGIN
  v_usd := fleet_control_ai_record_calls('spend_review', p_review::text, p_calls);
  IF v_usd > 0 THEN UPDATE fleet_spend_reviews SET cost_usd_microcents = cost_usd_microcents + v_usd WHERE review_id = p_review; END IF;
END $$;

-- Minutely: a reservation still open after ${CONTROL_SWEEP_AFTER_MINUTES} minutes is settled from its recorded consumption, or
-- marked unknown (its hold kept; the owner is told).
CREATE FUNCTION fleet_control_ai_sweep() RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_control_ai_reservations; v_settled integer := 0; v_unknown integer := 0; v_usd bigint;
BEGIN
  FOR x IN SELECT * FROM fleet_control_ai_reservations WHERE status = 'open' AND reserved_at < now() - interval '${CONTROL_SWEEP_AFTER_MINUTES} minutes'
            ORDER BY reserved_at LIMIT 100 FOR UPDATE SKIP LOCKED LOOP
    v_usd := (SELECT -usd_microcents FROM fleet_provider_credit_events WHERE request_id = x.request_id AND kind = 'consumption');
    PERFORM fleet_control_ai_settle_internal(x.reservation_id, v_usd, NULL, 'controller');
    IF v_usd IS NULL THEN v_unknown := v_unknown + 1; ELSE v_settled := v_settled + 1; END IF;
  END LOOP;
  RETURN jsonb_build_object('settled', v_settled, 'unknown', v_unknown);
END $$;

-- Owner: the actual cost of an unknown-cost (or stale open) call, from the provider console (0 allowed). Settles it once.
CREATE FUNCTION fleet_admin_fleet_control_ai_reconcile(p_reservation uuid, p_usd_microcents bigint, p_ref text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_control_ai_reservations;
BEGIN
  ${OWNER_ACTOR}
  IF p_usd_microcents IS NULL OR p_usd_microcents < 0 OR p_usd_microcents > 100000000000 OR p_ref IS NULL OR length(trim(p_ref)) NOT BETWEEN 3 AND 200
     OR fleet_secret_shaped(p_ref) THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: the actual USD microcents (>= 0) and where the provider shows it';
  END IF;
  SELECT * INTO x FROM fleet_control_ai_reservations WHERE reservation_id = p_reservation;
  IF NOT FOUND OR x.status NOT IN ('open','unknown') THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no unsettled Fleet Control reservation with this id'; END IF;
  IF x.status = 'open' AND x.reserved_at > now() - interval '${CONTROL_SWEEP_AFTER_MINUTES} minutes' THEN
    RAISE EXCEPTION 'FLEET_INVALID_STATE: that call may still be in flight';
  END IF;
  IF x.status = 'open' THEN PERFORM fleet_control_ai_settle_internal(x.reservation_id, NULL, NULL, p_actor); END IF;
  RETURN fleet_control_ai_settle_internal(x.reservation_id, p_usd_microcents, left(fleet_scrub(trim(p_ref)), 200), p_actor);
END $$;

${STATE}

${SPEND_CLAIM}

${KNOWLEDGE_CLAIM}

${MESSAGE_CLAIM}

${RELEVANCE_PENDING}

${RELEVANCE_RECONCILE}

${SETTLE}

${restate(V116_SQL, "fleet_event_route", [["    WHEN p_type = 'spend_circuit_breaker_set' THEN",
  (Object.entries(EVENT_ROUTES_V117) as Array<[string, readonly string[]]>)
    .map(([lvl, types]) => `    WHEN p_type IN (${q(types)}) THEN '${lvl}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"]])}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

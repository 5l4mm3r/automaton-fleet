/**
 * Schema v116 — promotional AI credit is its own lot (owner request, 2026-10-24: "reconcile the actual promotional grant,
 * expiry and remaining balance alongside purchased credit and Fleet's recorded balance … no postings or internal agent
 * charges yet").
 *
 * Until now every unit of provider credit was a purchase: an owner lot (owed to the owner as it is used, v69) or a treasury
 * lot (a prepaid asset, v70). A promotional grant is neither — nobody paid for it — and it expires. Now:
 *  - `fleet_admin_ai_credit_promotional_grant` (owner, once per grant, from the provider console): a lot of source
 *    `promotional` (no cash cost, no acquisition cost, its expiry), a provider-credit event of kind `grant`, and — when the
 *    console shows part of the grant already used — that part drawn from THIS lot only (`grant_used`; never from a purchased
 *    lot), reported as usage Fleet did not record (outside Fleet, or Fleet's own calls if the provider drew the grant first).
 *  - Expiry is recorded by the minutely settlement: what is left of a lot past its expiry is drawn (`expiry`), so it stops
 *    counting as credit for reservations and holds. Nothing is posted to the GBP books: the grant was never an asset.
 *  - The draw order is explicit (`fleet_admin_ai_credit_draw_order`, owner, with its evidence): `oldest_first` (unchanged
 *    default) or `promotional_first` (unexpired promotional lots, soonest expiry first, then purchased lots oldest first).
 *    It is taken from what the provider console shows, never assumed. Expired promotional lots are never drawn.
 *  - Promotional use creates no new posting. A charge still posts what it posts today (v69: the agent's cost, made owed to
 *    the owner); how promotional-funded use is finally treated (an internal agent charge or none, and the owner payable it
 *    created) is the owner's decision and a later migration. The status reports that use separately, with the payable it
 *    created, so nothing is hidden meanwhile.
 * Nothing here buys, tops up, charges or posts.
 */
import { V70_SQL } from "./migrations-phase70.js";
import { V71_SQL } from "./migrations-phase71.js";
import { V72_SQL } from "./migrations-phase72.js";
import { V111_SQL } from "./migrations-phase111.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
export const EVENT_ROUTES_V116 = Object.freeze({
  P3_SUMMARY: ["ai_credit_promotional_grant_recorded", "ai_credit_promotional_expired", "ai_credit_draw_order_set"],
});
export const AI_CREDIT_DRAW_ORDERS = ["oldest_first", "promotional_first"] as const;
const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');`;

// The draw follows the recorded order; an expired promotional lot is never drawn.
const DRAW = restateRaw(V71_SQL, "fleet_ai_credit_draw", [
  [`v_unexplained bigint := 0;`, `v_unexplained bigint := 0;
  v_promo_first boolean := COALESCE((SELECT draw_order = 'promotional_first' FROM fleet_ai_credit_policy WHERE provider = p_provider), false);`],
  [`  FOR l IN SELECT * FROM fleet_ai_credit_lots WHERE provider = p_provider AND usd_remaining > 0 ORDER BY purchased_at, lot_id FOR UPDATE LOOP`,
   `  FOR l IN SELECT * FROM fleet_ai_credit_lots WHERE provider = p_provider AND usd_remaining > 0
             AND NOT (source = 'promotional' AND expires_at <= now())
           ORDER BY CASE WHEN v_promo_first AND source = 'promotional' THEN 0 ELSE 1 END,
                    CASE WHEN v_promo_first AND source = 'promotional' THEN expires_at END NULLS LAST, purchased_at, lot_id FOR UPDATE LOOP`],
]);

// The minutely settlement also records expired promotional credit.
const SETTLE = restateRaw(V72_SQL, "svc_ai_credit_settle", [
  [`  v_detect := v_detect || jsonb_build_object('acquisitionCost', fleet_ai_credit_cost_pass());`,
   `  v_detect := v_detect || jsonb_build_object('acquisitionCost', fleet_ai_credit_cost_pass());
  v_detect := v_detect || jsonb_build_object('promotionalExpired', fleet_ai_credit_promotional_expire());`],
]);

const STATUS = restateRaw(V71_SQL, "fleet_ai_credit_status", [
  [`    'unallocatedUsageUsdMicrocents',`, `    'promotional', COALESCE((SELECT jsonb_agg(jsonb_build_object('lotId', l.lot_id, 'provider', l.provider, 'grantRef', substr(l.external_ref, 7),
        'grantedUsdMicrocents', l.usd_purchased, 'remainingUsdMicrocents', l.usd_remaining, 'grantedAt', l.granted_at, 'expiresAt', l.expires_at, 'evidence', l.grant_evidence,
        'expired', l.expires_at <= now(),
        'usedBeforeRecordingUsdMicrocents', (SELECT COALESCE(sum(d.usd), 0) FROM fleet_ai_credit_draws d WHERE d.lot_id = l.lot_id AND d.cause = 'grant_used'),
        'expiredUsdMicrocents', (SELECT COALESCE(sum(d.usd), 0) FROM fleet_ai_credit_draws d WHERE d.lot_id = l.lot_id AND d.cause = 'expiry'),
        'fleetUse', (SELECT jsonb_build_object('calls', count(*), 'usdMicrocents', COALESCE(sum(d.usd), 0), 'gbpMicro', COALESCE(sum(d.gbp_micro), 0))
                       FROM fleet_ai_credit_draws d WHERE d.lot_id = l.lot_id AND d.cause = 'consumption'))
        ORDER BY l.expires_at) FROM fleet_ai_credit_lots l WHERE l.source = 'promotional'), '[]'::jsonb),
    'promotionalTreatment', 'not decided: promotional use has no cash cost, but each charge still posts as today (the agent''s cost, made owed to the owner by the v69 default); fleetUse above is that use, at charge rates. Nothing else is posted.',
    'unallocatedUsageUsdMicrocents',`],
]);

export const V116_SQL = `
ALTER TABLE fleet_ai_credit_lots ADD COLUMN granted_at timestamptz, ADD COLUMN expires_at timestamptz,
  ADD COLUMN grant_evidence text CHECK (length(grant_evidence) BETWEEN 3 AND 200);
ALTER TABLE fleet_ai_credit_lots DROP CONSTRAINT fleet_ai_credit_lots_source_check;
ALTER TABLE fleet_ai_credit_lots ADD CONSTRAINT fleet_ai_credit_lots_source_check CHECK (source IN ('owner','treasury','promotional'));
ALTER TABLE fleet_ai_credit_lots ADD CONSTRAINT fleet_ai_credit_lots_promotional CHECK (
  (source = 'promotional') = (expires_at IS NOT NULL AND granted_at IS NOT NULL)
  AND (source <> 'promotional' OR (acq_total_usd_cents IS NULL AND expires_at > granted_at AND external_ref LIKE 'grant:%')));

ALTER TABLE fleet_provider_credit_events DROP CONSTRAINT fleet_provider_credit_events_kind_check;
ALTER TABLE fleet_provider_credit_events ADD CONSTRAINT fleet_provider_credit_events_kind_check
  CHECK (kind IN ('purchase','adjustment','consumption','grant','grant_used','expiry'));
ALTER TABLE fleet_provider_credit_events ADD CONSTRAINT fleet_provider_credit_events_promotional_sign
  CHECK ((kind <> 'grant' OR usd_microcents > 0) AND (kind NOT IN ('grant_used','expiry') OR usd_microcents < 0));

ALTER TABLE fleet_ai_credit_draws DROP CONSTRAINT fleet_ai_credit_draws_cause_check;
ALTER TABLE fleet_ai_credit_draws ADD CONSTRAINT fleet_ai_credit_draws_cause_check CHECK (cause IN ('consumption','adjustment','grant_used','expiry'));

ALTER TABLE fleet_ai_credit_policy
  ADD COLUMN draw_order text NOT NULL DEFAULT 'oldest_first' CHECK (draw_order IN (${q(AI_CREDIT_DRAW_ORDERS)})),
  ADD COLUMN draw_order_evidence text CHECK (length(draw_order_evidence) BETWEEN 3 AND 300);

${DRAW}

-- Owner: a promotional grant, once, from the provider console (amount, date, expiry, the grant's identifier, remaining).
CREATE FUNCTION fleet_admin_ai_credit_promotional_grant(p_provider text, p_grant_ref text, p_grant_usd_cents bigint, p_remaining_usd_cents bigint,
    p_granted_at timestamptz, p_expires_at timestamptz, p_evidence text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_ref text; v_lot uuid; v_used bigint;
BEGIN
  ${OWNER_ACTOR}
  IF p_provider IS NULL OR p_provider !~ '^[a-z][a-z0-9_]{1,39}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: provider'; END IF;
  IF p_grant_ref IS NULL OR p_grant_ref !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the grant''s identifier as the console shows it'; END IF;
  IF p_grant_usd_cents IS NULL OR p_grant_usd_cents <= 0 OR p_grant_usd_cents > 10000000 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the grant in positive USD cents'; END IF;
  IF p_remaining_usd_cents IS NULL OR p_remaining_usd_cents < 0 OR p_remaining_usd_cents > p_grant_usd_cents THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: the remaining balance is between 0 and the grant';
  END IF;
  IF p_granted_at IS NULL OR p_granted_at > now() THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the date granted (not in the future)'; END IF;
  IF p_expires_at IS NULL OR p_expires_at <= p_granted_at THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the expiry is after the date granted'; END IF;
  IF p_expires_at <= now() THEN RAISE EXCEPTION 'FLEET_PROMOTIONAL_EXPIRED: an expired grant is not credit'; END IF;
  IF p_evidence IS NULL OR length(trim(p_evidence)) NOT BETWEEN 3 AND 200 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the evidence (where the console shows it)'; END IF;
  v_ref := 'grant:' || p_provider || ':' || p_grant_ref;
  PERFORM pg_advisory_xact_lock(hashtext('fleet_provider_credits:' || p_provider));
  IF EXISTS (SELECT 1 FROM fleet_ai_credit_lots WHERE external_ref = v_ref) THEN RAISE EXCEPTION 'FLEET_ALREADY_CLAIMED: that grant is already recorded'; END IF;
  INSERT INTO fleet_ai_credit_lots (provider, source, usd_purchased, usd_remaining, external_ref, recorded_by, purchased_at, granted_at, expires_at, grant_evidence)
    VALUES (p_provider, 'promotional', p_grant_usd_cents * 1000000, p_grant_usd_cents * 1000000, v_ref, p_actor, p_granted_at, p_granted_at, p_expires_at,
            left(fleet_scrub(trim(p_evidence)), 200))
    RETURNING lot_id INTO v_lot;
  INSERT INTO fleet_provider_credit_events (provider, kind, usd_microcents, external_ref, recorded_by) VALUES (p_provider, 'grant', p_grant_usd_cents * 1000000, v_ref, p_actor);
  -- Used before Fleet recorded it: drawn from this grant only — never from a purchased lot, never attributed to an agent.
  v_used := (p_grant_usd_cents - p_remaining_usd_cents) * 1000000;
  IF v_used > 0 THEN
    UPDATE fleet_ai_credit_lots SET usd_remaining = usd_remaining - v_used WHERE lot_id = v_lot;
    INSERT INTO fleet_ai_credit_draws (lot_id, usd, gbp_micro, cause, request_id) VALUES (v_lot, v_used, 0, 'grant_used', NULL);
    INSERT INTO fleet_provider_credit_events (provider, kind, usd_microcents, external_ref, recorded_by) VALUES (p_provider, 'grant_used', -v_used, v_ref || ':used', p_actor);
  END IF;
  PERFORM fleet_event('ai_credit_promotional_grant_recorded', NULL, p_actor, jsonb_build_object('provider', p_provider, 'lotId', v_lot, 'grantRef', p_grant_ref,
    'grantUsdCents', p_grant_usd_cents, 'remainingUsdCents', p_remaining_usd_cents, 'usedBeforeRecordingUsdCents', p_grant_usd_cents - p_remaining_usd_cents,
    'grantedAt', p_granted_at, 'expiresAt', p_expires_at,
    'note', 'promotional credit: no cash cost, nothing posted; what was used before recording is not attributed to anyone'));
  RETURN jsonb_build_object('ok', true, 'lotId', v_lot, 'grantUsdCents', p_grant_usd_cents, 'remainingUsdCents', p_remaining_usd_cents,
    'usedBeforeRecordingUsdCents', p_grant_usd_cents - p_remaining_usd_cents, 'expiresAt', p_expires_at,
    'recordedBalanceUsdMicrocents', fleet_provider_credit_balance(p_provider));
END $$;

-- Expired promotional credit stops being credit: what is left is drawn (no posting; the grant was never an asset).
CREATE FUNCTION fleet_ai_credit_promotional_expire() RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE l fleet_ai_credit_lots; v_n integer := 0; v_usd bigint := 0;
BEGIN
  FOR l IN SELECT * FROM fleet_ai_credit_lots WHERE source = 'promotional' AND expires_at <= now() AND usd_remaining > 0 ORDER BY expires_at FOR UPDATE SKIP LOCKED LOOP
    UPDATE fleet_ai_credit_lots SET usd_remaining = 0 WHERE lot_id = l.lot_id;
    INSERT INTO fleet_ai_credit_draws (lot_id, usd, gbp_micro, cause, request_id) VALUES (l.lot_id, l.usd_remaining, 0, 'expiry', NULL);
    INSERT INTO fleet_provider_credit_events (provider, kind, usd_microcents, external_ref, recorded_by)
      VALUES (l.provider, 'expiry', -l.usd_remaining, l.external_ref || ':expired', 'controller');
    PERFORM fleet_event('ai_credit_promotional_expired', NULL, 'controller', jsonb_build_object('provider', l.provider, 'lotId', l.lot_id,
      'grantRef', substr(l.external_ref, 7), 'expiredUsdMicrocents', l.usd_remaining, 'expiresAt', l.expires_at));
    v_n := v_n + 1; v_usd := v_usd + l.usd_remaining;
  END LOOP;
  RETURN jsonb_build_object('lots', v_n, 'usdMicrocents', v_usd);
END $$;

-- Owner: which credit the provider draws first, as its console shows it (never assumed).
CREATE FUNCTION fleet_admin_ai_credit_draw_order(p_provider text, p_order text, p_evidence text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_ai_credit_policy;
BEGIN
  ${OWNER_ACTOR}
  IF p_order IS NULL OR p_order NOT IN (${q(AI_CREDIT_DRAW_ORDERS)}) THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the draw order is one of ${AI_CREDIT_DRAW_ORDERS.join(", ")}'; END IF;
  IF p_evidence IS NULL OR length(trim(p_evidence)) NOT BETWEEN 3 AND 300 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the evidence (what the console showed)'; END IF;
  UPDATE fleet_ai_credit_policy SET draw_order = p_order, draw_order_evidence = left(fleet_scrub(trim(p_evidence)), 300), set_by = p_actor, set_at = now()
   WHERE provider = p_provider RETURNING * INTO r;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no AI-credit policy for % (set it first)', p_provider; END IF;
  INSERT INTO fleet_ai_credit_policy_history (provider, policy, set_by) VALUES (p_provider, to_jsonb(r), p_actor);
  PERFORM fleet_event('ai_credit_draw_order_set', NULL, p_actor, jsonb_build_object('provider', p_provider, 'drawOrder', p_order));
  RETURN jsonb_build_object('ok', true, 'provider', p_provider, 'drawOrder', p_order);
END $$;

${SETTLE}

${STATUS}

${restateRaw(V111_SQL, "fleet_event_route", [["    WHEN p_type = 'spend_circuit_breaker_set' THEN",
  (Object.entries(EVENT_ROUTES_V116) as Array<[string, readonly string[]]>)
    .map(([lvl, types]) => `    WHEN p_type IN (${q(types)}) THEN '${lvl}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"]])}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

void V70_SQL;

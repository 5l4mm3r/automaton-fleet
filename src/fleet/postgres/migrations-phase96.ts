/**
 * Schema v96 — custody enforces refund authority itself (launch-readiness §1 rows 21–22, 2026-10-19).
 *
 * Before v96 a refund left whenever money-out was activated: `cx_paypal_refund_work` checked only that an activation was
 * live and the cash available, and the activation's maxima were never applied to refunds. Now:
 *
 * 1. AUTHORITY. A refund leaves only under a live REFUND AUTHORITY the owner granted: `standing` (ordinary customer
 *    refunds, autonomous within its limits; ongoing or expiring) or `order` (one named order only, e.g. a proof; always
 *    expiring, at most 7 days, with a lifetime total). Each states a per-refund maximum, a rolling 24-hour maximum and an
 *    optional lifetime total, in one currency. A grant is fixed once made (end it and grant another); history is kept.
 *    Payouts keep their own owner activation (`fleet_custody_activations`); it no longer governs refunds.
 * 2. DISPATCH. Custody binds each new refund to the authority that covers it, under that authority's row lock, in the
 *    same transaction that hands it to the worker (`authority_id`, `authorised_at`). Everything already bound to the
 *    authority and not failed — waiting, sent, pending or completed — counts toward its limits, so concurrent workers
 *    and refunds still in flight cannot exceed them. A refund no authority covers stays set aside (nothing fails) and the
 *    owner is told once why (`refund_awaiting_authority`). A refund custody already sent is re-checked with PayPal under
 *    the same PayPal-Request-Id even after its authority ends: that never refunds twice. A bound refund that was never
 *    sent leaves only while its authority is still live (else it is bound again to another live authority, or waits). Two
 *    workers at once may both be handed the same bound refund: its PayPal-Request-Id makes that one refund, and nothing
 *    is ever bound beyond a limit.
 * 3. OWNER PROOF. A refund, reversal or fee on the owner's own proof purchase is owner capital (`owner_proof_return`), so
 *    it is no longer held from the agent's spendable cash while in flight (row 21). Ordinary sales are unchanged.
 * 4. PRODUCT QUALITY. Reviews by inspector fleet-qa-3 (spreadsheets opened in the office application, as the customer sees
 *    them) are accepted. A product is SOLD PUBLICLY only on a passing review by a current inspector (QA_SALE_INSPECTORS)
 *    of its current files, and when no owner hold is on it: the offer page shows it unavailable, the buy path refuses, the
 *    sitemap and search notifications leave it out, and the agent's offer view says why (`saleBlock`). Publishing a
 *    product needs such a review. Work already accepted (paid orders, their delivery and revisions) is unaffected. The
 *    owner can hold one offer (and release it) without closing sales or holding the agent; the agent is told.
 * 5. GUIDANCE. The dated capability entry agents read (fleet-capability-status v14) is rewritten from verified state:
 *    search connected, images not offered, Gumroad deferred, refunds under refund authority, the owner-paid card, sales
 *    closed until launch, the inspector's spreadsheet checks.
 */
import { V51_SQL } from "./migrations-phase51.js";
import { V59_SQL } from "./migrations-phase59.js";
import { V77_SQL } from "./migrations-phase77.js";
import { V76_SQL } from "./migrations-phase76.js";
import { V78_SQL } from "./migrations-phase78.js";
import { V80_SQL } from "./migrations-phase80.js";
import { V82_SQL } from "./migrations-phase82.js";
import { V85_SQL, QA_INSPECTOR_VERSIONS_V85 } from "./migrations-phase85.js";
import { restate as restateRaw } from "./migrations-phase42.js";
import { CAPABILITY_STATUS_V14 } from "./knowledge-capability-status-v14.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));
const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

export const REFUND_SCOPES = ["standing", "order"] as const;
/** An order-scoped authority (a proof) lasts at most this long. */
export const ORDER_AUTHORITY_MAX_HOURS = 168;
/** A standing authority, when it expires at all, lasts at most this long. */
export const STANDING_AUTHORITY_MAX_HOURS = 8760;
export const EVENT_ROUTES_V96 = Object.freeze({
  P1_HIGH: ["refund_awaiting_authority"],
  P2_IMPORTANT: ["refund_authority_granted", "refund_authority_ended", "offer_held", "offer_released"],
} as const);
/** v96: fleet-qa-3 reviews are accepted (earlier ones stay valid records). */
export const QA_INSPECTOR_VERSIONS_V96 = [...QA_INSPECTOR_VERSIONS_V85, "fleet-qa-3"] as const;
/** v96: the inspectors whose passing review lets a product be sold publicly. */
export const QA_SALE_INSPECTORS = ["fleet-qa-3"] as const;

const WORKER = `IF p_worker IS NULL OR p_worker !~ '^[a-z0-9-]{3,40}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: worker name'; END IF;`;
const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');`;

// A bound refund request keeps its authority unless it is still waiting to be sent (then it may be bound again).
const REQUEST_GUARD = restate(V59_SQL, "fleet_paypal_refund_requests_guard", [
  [`  IF OLD.status IN ('completed','failed') THEN`,
   `  IF (NEW.authority_id IS DISTINCT FROM OLD.authority_id OR NEW.authorised_at IS DISTINCT FROM OLD.authorised_at)
     AND (OLD.status <> 'requested' OR NEW.authority_id IS NULL) THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a refund''s authority is fixed once it was sent';
  END IF;
  IF OLD.status IN ('completed','failed') THEN`],
]);

// The refund request's view carries its authority.
const REQUEST_JSON = restate(V59_SQL, "fleet_refund_request_json", [
  [`'requestedBy', x.requested_by, 'at', x.created_at))`, `'requestedBy', x.requested_by, 'at', x.created_at, 'authorityId', x.authority_id, 'authorisedAt', x.authorised_at))`],
]);

// The request's note says whether the owner's refund authority covers it now (custody checks again, under lock, to send it).
const REQUEST = restate(V59_SQL, "fleet_order_refund_request", [
  [`    'note', CASE WHEN EXISTS (SELECT 1 FROM fleet_custody_activation_live())
                 THEN 'custody sends it to PayPal shortly; the amount is set aside now and posted when PayPal confirms it'
                 ELSE 'set aside now; custody sends it to PayPal once money-out is activated (refunds use the same authority as payments)' END);`,
   `    'authority', fleet_refund_authority_cover(x, false),
    'note', CASE WHEN (fleet_refund_authority_cover(x, false) ->> 'covered')::boolean
                 THEN 'within the owner''s refund authority: custody sends it to PayPal shortly; the amount is set aside now and posted when PayPal confirms it'
                 ELSE 'set aside now; it waits — ' || (fleet_refund_authority_cover(x, false) ->> 'reason') || ' — and the owner has been told; nothing failed' END);`],
]);

// Row 21: the owner's proof purchase is owner capital: its refund, reversal or fee never holds the agent's cash.
const AGENT_EXPOSURE = restate(V59_SQL, "fleet_paypal_dispute_exposure", [
  [`   WHERE c.agent_id = p_agent AND c.status = 'captured'`,
   `   WHERE c.agent_id = p_agent AND c.status = 'captured'
     AND NOT EXISTS (SELECT 1 FROM fleet_customer_orders z WHERE z.checkout_id = c.checkout_id AND z.owner_proof)`],
]);

const CUSTODY_STATUS = restate(V51_SQL, "fleet_custody_status", [
  [`    'liveRails', (SELECT count(*) FROM fleet_payment_rails WHERE mode = 'live' AND status = 'active'),`,
   `    'liveRails', (SELECT count(*) FROM fleet_payment_rails WHERE mode = 'live' AND status = 'active'),
    -- v96: refunds leave only under these (the activation above governs payouts only).
    'refundAuthorities', fleet_refund_authorities_json(true),`],
]);

const EVENT_ROUTE = restate(V80_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V96) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
]);

void V77_SQL;

// ── 4. Product quality ──
const REVIEW_RECORD = restate(V85_SQL, "fleet_econ_review_record", [
  [`NOT IN (${q(QA_INSPECTOR_VERSIONS_V85)})`, `NOT IN (${q(QA_INSPECTOR_VERSIONS_V96)})`],
]);
const OFFER_BUY = restate(V82_SQL, "svc_offer_buy", [
  [`  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_OFFER_UNAVAILABLE'); END IF;`,
   `  IF NOT FOUND OR fleet_offer_sale_block(o) IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_OFFER_UNAVAILABLE'); END IF;`],
]);
const PUBLIC_JSON = restate(V78_SQL, "fleet_offer_public_json", [
  [`'available', o.status = 'published' AND`, `'available', o.status = 'published' AND fleet_offer_sale_block(o) IS NULL AND`],
]);
const SITEMAP = restate(V80_SQL, "svc_sitemap", [
  [`FROM fleet_offers WHERE status = 'published'), '[]'::jsonb)`, `FROM fleet_offers o WHERE o.status = 'published' AND fleet_offer_sale_block(o) IS NULL), '[]'::jsonb)`],
]);
const INDEXNOW = restate(V80_SQL, "chx_indexnow_due", [
  [`        WHERE o.status = 'published' AND (p.offer_id IS NULL`, `        WHERE o.status = 'published' AND fleet_offer_sale_block(o) IS NULL AND (p.offer_id IS NULL`],
]);
const PUBLISH = restate(V78_SQL, "fleet_econ_offer_publish", [
  [`    IF r.files_digest <> fleet_files_digest(v_files) THEN RAISE EXCEPTION 'FLEET_REVIEW_STALE: the offer''s files are not the files that review covered; review the current files'; END IF;`,
   `    IF r.files_digest <> fleet_files_digest(v_files) THEN RAISE EXCEPTION 'FLEET_REVIEW_STALE: the offer''s files are not the files that review covered; review the current files'; END IF;
    -- v96: a product is sold on a review by a current inspector (it opens spreadsheets as the customer sees them).
    IF r.inspector NOT IN (${q(QA_SALE_INSPECTORS)}) THEN
      RAISE EXCEPTION 'FLEET_REVIEW_INSPECTOR: that review was made by %, which no longer qualifies a product for sale; inspect the current files (deliverable inspect), fix what fails, review them again and publish with that review', r.inspector;
    END IF;`],
]);
const OFFER_JSON = restate(V76_SQL, "fleet_offer_json", [
  [`'filesVersion', o.files_version, 'reviewId', o.review_id,`, `'filesVersion', o.files_version, 'reviewId', o.review_id,
    'saleBlock', CASE WHEN o.status = 'published' THEN fleet_offer_sale_block(o) END, 'heldAt', o.held_at, 'heldReason', o.held_reason,`],
]);

export const V96_SQL = `
-- ═══ 1. Refund authorities ═══
CREATE TABLE fleet_refund_authorities (
  authority_id     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  scope            text        NOT NULL CHECK (scope IN (${q(REFUND_SCOPES)})),
  order_id         uuid        REFERENCES fleet_customer_orders(order_id),
  currency         text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  max_refund_minor bigint      NOT NULL CHECK (max_refund_minor > 0),
  max_daily_minor  bigint      NOT NULL CHECK (max_daily_minor >= max_refund_minor),
  max_total_minor  bigint      CHECK (max_total_minor IS NULL OR max_total_minor >= max_refund_minor),
  granted_by       text        NOT NULL CHECK (granted_by ~ '^operator:[A-Za-z0-9._-]{1,64}$'),
  reason           text        NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  granted_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz,
  ended_at         timestamptz,
  ended_by         text,
  end_reason       text        CHECK (end_reason IS NULL OR length(end_reason) BETWEEN 1 AND 300),
  CHECK ((scope = 'order') = (order_id IS NOT NULL)),
  CHECK (scope = 'standing' OR (expires_at IS NOT NULL AND max_total_minor IS NOT NULL
                                AND expires_at <= granted_at + interval '${ORDER_AUTHORITY_MAX_HOURS} hours')),
  CHECK (expires_at IS NULL OR (expires_at > granted_at AND expires_at <= granted_at + interval '${STANDING_AUTHORITY_MAX_HOURS} hours')),
  CHECK ((ended_at IS NULL) = (ended_by IS NULL) AND (ended_at IS NULL) = (end_reason IS NULL))
);
CREATE UNIQUE INDEX fleet_refund_authorities_one_standing ON fleet_refund_authorities ((scope)) WHERE scope = 'standing' AND ended_at IS NULL;
CREATE UNIQUE INDEX fleet_refund_authorities_one_per_order ON fleet_refund_authorities (order_id) WHERE scope = 'order' AND ended_at IS NULL;
CREATE FUNCTION fleet_refund_authorities_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.ended_at IS NOT NULL THEN RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: a refund authority is history once ended'; END IF;
  IF NEW.authority_id <> OLD.authority_id OR NEW.scope <> OLD.scope OR NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.currency <> OLD.currency
     OR NEW.max_refund_minor <> OLD.max_refund_minor OR NEW.max_daily_minor <> OLD.max_daily_minor OR NEW.max_total_minor IS DISTINCT FROM OLD.max_total_minor
     OR NEW.granted_by <> OLD.granted_by OR NEW.reason <> OLD.reason OR NEW.granted_at <> OLD.granted_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: a refund authority''s grant is fixed (end it and grant another)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_refund_authorities_guard BEFORE UPDATE OR DELETE ON fleet_refund_authorities FOR EACH ROW EXECUTE FUNCTION fleet_refund_authorities_guard();
CREATE TRIGGER fleet_refund_authorities_no_truncate BEFORE TRUNCATE ON fleet_refund_authorities FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

ALTER TABLE fleet_paypal_refund_requests ADD COLUMN authority_id uuid REFERENCES fleet_refund_authorities(authority_id);
ALTER TABLE fleet_paypal_refund_requests ADD COLUMN authorised_at timestamptz;
ALTER TABLE fleet_paypal_refund_requests ADD CONSTRAINT fleet_paypal_refund_requests_authority CHECK ((authority_id IS NULL) = (authorised_at IS NULL));
-- Requests still waiting, and requests sent before v96 (under the money-out activation of the time), keep NULL.
CREATE INDEX fleet_paypal_refund_requests_authority ON fleet_paypal_refund_requests (authority_id) WHERE authority_id IS NOT NULL;
${REQUEST_GUARD}

-- Live = not ended and not expired.
CREATE FUNCTION fleet_refund_authority_live(a fleet_refund_authorities) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT a.ended_at IS NULL AND (a.expires_at IS NULL OR a.expires_at > now())
$$;

-- What is already bound to an authority (not failed: waiting to be sent, sent, pending or completed).
CREATE FUNCTION fleet_refund_authority_used(p_authority uuid, p_except uuid) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('dailyMinor', COALESCE(sum(amount_minor) FILTER (WHERE authorised_at > now() - interval '24 hours'), 0),
                            'totalMinor', COALESCE(sum(amount_minor), 0), 'refunds', count(*))
    FROM fleet_paypal_refund_requests WHERE authority_id = p_authority AND status <> 'failed' AND request_id IS DISTINCT FROM p_except
$$;

-- Does a live authority cover this refund? p_lock: take each candidate authority's row lock first (custody's dispatch), so
-- the sums are read after any concurrent dispatch under it has committed. An order-scoped authority is preferred.
CREATE FUNCTION fleet_refund_authority_cover(p fleet_paypal_refund_requests, p_lock boolean) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_refund_authorities; u jsonb; v_why text;
BEGIN
  FOR a IN SELECT * FROM fleet_refund_authorities x WHERE fleet_refund_authority_live(x) AND x.currency = p.currency
             AND ((x.scope = 'order' AND x.order_id = p.order_id) OR x.scope = 'standing')
           ORDER BY (x.scope = 'order') DESC, x.granted_at LOOP
    IF p_lock THEN
      PERFORM 1 FROM fleet_refund_authorities WHERE authority_id = a.authority_id FOR UPDATE;
      SELECT * INTO a FROM fleet_refund_authorities WHERE authority_id = a.authority_id;
      IF NOT fleet_refund_authority_live(a) THEN CONTINUE; END IF;
    END IF;
    u := fleet_refund_authority_used(a.authority_id, p.request_id);
    IF p.amount_minor > a.max_refund_minor THEN
      v_why := COALESCE(v_why, 'over the per-refund maximum of the ' || a.scope || ' refund authority (' || a.max_refund_minor || ')');
    ELSIF (u ->> 'dailyMinor')::bigint + p.amount_minor > a.max_daily_minor THEN
      v_why := COALESCE(v_why, 'over the 24-hour maximum of the ' || a.scope || ' refund authority (' || a.max_daily_minor || '; ' || (u ->> 'dailyMinor') || ' used)');
    ELSIF a.max_total_minor IS NOT NULL AND (u ->> 'totalMinor')::bigint + p.amount_minor > a.max_total_minor THEN
      v_why := COALESCE(v_why, 'over the total of the ' || a.scope || ' refund authority (' || a.max_total_minor || '; ' || (u ->> 'totalMinor') || ' used)');
    ELSE
      RETURN jsonb_build_object('covered', true, 'authorityId', a.authority_id, 'scope', a.scope, 'expiresAt', a.expires_at,
        'maxRefundMinor', a.max_refund_minor, 'dailyLeftMinor', a.max_daily_minor - (u ->> 'dailyMinor')::bigint - p.amount_minor,
        'totalLeftMinor', a.max_total_minor - (u ->> 'totalMinor')::bigint - p.amount_minor);
    END IF;
  END LOOP;
  RETURN jsonb_build_object('covered', false, 'reason', COALESCE(v_why, 'no live refund authority covers this order'));
END $$;

-- The owner is told once per request and reason (the refund stays set aside; nothing failed).
CREATE FUNCTION fleet_refund_authority_wait(p fleet_paypal_refund_requests, p_cover jsonb) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM fleet_events WHERE event_type = 'refund_awaiting_authority' AND detail ->> 'refundRequestId' = p.request_id::text
               AND detail ->> 'reason' = p_cover ->> 'reason') THEN RETURN; END IF;
  PERFORM fleet_event('refund_awaiting_authority', p.agent_id, 'custody', jsonb_build_object('refundRequestId', p.request_id, 'orderId', p.order_id,
    'amountMinor', p.amount_minor, 'currency', p.currency, 'reason', p_cover ->> 'reason',
    'note', 'a customer refund waits: no refund authority covers it. It stays set aside; grant or widen a refund authority (economy-refund-authority-grant) to let it leave'));
END $$;

CREATE FUNCTION fleet_refund_authorities_json(p_live_only boolean) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('authorityId', a.authority_id, 'scope', a.scope, 'orderId', a.order_id, 'currency', a.currency,
           'maxRefundMinor', a.max_refund_minor, 'maxDailyMinor', a.max_daily_minor, 'maxTotalMinor', a.max_total_minor, 'grantedBy', a.granted_by,
           'grantedAt', a.granted_at, 'expiresAt', a.expires_at, 'live', fleet_refund_authority_live(a), 'endedAt', a.ended_at, 'endReason', a.end_reason,
           'reason', a.reason, 'used', fleet_refund_authority_used(a.authority_id, NULL))) ORDER BY a.granted_at DESC), '[]'::jsonb)
    FROM fleet_refund_authorities a WHERE NOT p_live_only OR fleet_refund_authority_live(a)
$$;

-- Owner: grant a refund authority. p_scope 'standing' (p_order NULL; p_hours NULL = ongoing until ended) or 'order' (that
-- order only; 1..${ORDER_AUTHORITY_MAX_HOURS} hours; a lifetime total required). A new grant of the same scope (and order) ends the previous one.
CREATE FUNCTION fleet_admin_refund_authority_grant(p_scope text, p_order uuid, p_max_refund bigint, p_max_daily bigint, p_max_total bigint, p_hours integer,
  p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_refund_authorities; o fleet_customer_orders; v_cur text;
BEGIN
  ${OWNER_ACTOR}
  IF p_scope NOT IN (${q(REFUND_SCOPES)}) THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: scope is standing or order'; END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a reason is required'; END IF;
  IF p_max_refund IS NULL OR p_max_refund <= 0 OR p_max_daily IS NULL OR p_max_daily < p_max_refund OR (p_max_total IS NOT NULL AND p_max_total < p_max_refund) THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: a positive per-refund maximum, a 24-hour maximum at least as large and (optionally) a total at least as large';
  END IF;
  IF p_scope = 'order' THEN
    SELECT * INTO o FROM fleet_customer_orders WHERE order_id = p_order;
    IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: orderId'; END IF;
    IF p_hours IS NULL OR p_hours NOT BETWEEN 1 AND ${ORDER_AUTHORITY_MAX_HOURS} OR p_max_total IS NULL THEN
      RAISE EXCEPTION 'FLEET_BAD_REQUEST: an order authority lasts 1..${ORDER_AUTHORITY_MAX_HOURS} hours and states a total';
    END IF;
    v_cur := o.currency;
  ELSE
    IF p_order IS NOT NULL THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a standing authority names no order'; END IF;
    IF p_hours IS NOT NULL AND p_hours NOT BETWEEN 1 AND ${STANDING_AUTHORITY_MAX_HOURS} THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a standing authority lasts 1..${STANDING_AUTHORITY_MAX_HOURS} hours, or is ongoing'; END IF;
    v_cur := (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1);
  END IF;
  UPDATE fleet_refund_authorities SET ended_at = now(), ended_by = p_actor, end_reason = 'superseded by a new grant'
   WHERE ended_at IS NULL AND scope = p_scope AND order_id IS NOT DISTINCT FROM p_order;
  INSERT INTO fleet_refund_authorities (scope, order_id, currency, max_refund_minor, max_daily_minor, max_total_minor, granted_by, reason, expires_at)
    VALUES (p_scope, p_order, v_cur, p_max_refund, p_max_daily, p_max_total, p_actor, left(fleet_scrub(p_reason), 300),
            CASE WHEN p_hours IS NULL THEN NULL ELSE now() + make_interval(hours => p_hours) END) RETURNING * INTO a;
  PERFORM fleet_event('refund_authority_granted', o.agent_id, p_actor, jsonb_build_object('authorityId', a.authority_id, 'scope', a.scope, 'orderId', a.order_id,
    'maxRefundMinor', a.max_refund_minor, 'maxDailyMinor', a.max_daily_minor, 'maxTotalMinor', a.max_total_minor, 'expiresAt', a.expires_at));
  RETURN jsonb_build_object('ok', true, 'authorityId', a.authority_id, 'scope', a.scope, 'orderId', a.order_id, 'currency', a.currency, 'expiresAt', a.expires_at,
    'note', 'custody sends a refund only within a live refund authority; a live PayPal rail with the refunds capability and the custody host''s REAL_PAYMENTS_ENABLED are also needed');
END $$;

CREATE FUNCTION fleet_admin_refund_authority_end(p_authority uuid, p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_refund_authorities;
BEGIN
  ${OWNER_ACTOR}
  UPDATE fleet_refund_authorities SET ended_at = now(), ended_by = p_actor, end_reason = left(COALESCE(NULLIF(trim(p_reason), ''), 'ended by the owner'), 300)
   WHERE authority_id = p_authority AND ended_at IS NULL RETURNING * INTO a;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM fleet_refund_authorities WHERE authority_id = p_authority) THEN RETURN jsonb_build_object('ok', true, 'replay', true); END IF;
    RAISE EXCEPTION 'FLEET_NOT_FOUND: authorityId';
  END IF;
  PERFORM fleet_event('refund_authority_ended', (SELECT agent_id FROM fleet_customer_orders WHERE order_id = a.order_id), p_actor,
    jsonb_build_object('authorityId', a.authority_id, 'scope', a.scope, 'orderId', a.order_id, 'used', fleet_refund_authority_used(a.authority_id, NULL)));
  RETURN jsonb_build_object('ok', true, 'authorityId', a.authority_id, 'endedAt', a.ended_at, 'used', fleet_refund_authority_used(a.authority_id, NULL));
END $$;

${REQUEST_JSON}

${REQUEST}

-- ═══ 2. Custody's dispatch: authority, then cash, bound in the same transaction that hands the refund to the worker ═══
CREATE OR REPLACE FUNCTION cx_paypal_refund_work(p_worker text, p_limit integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r jsonb; v_free bigint; v_stale boolean; v_liq jsonb; v_ok uuid[] := '{}'; x fleet_paypal_refund_requests; v_rail uuid; cov jsonb;
        v_lim integer := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50); n integer := 0;
BEGIN
  ${WORKER}
  -- New refunds, and bound ones whose authority ended or expired before they were sent (bound again, or they wait).
  FOR x IN SELECT q.* FROM fleet_paypal_refund_requests q JOIN fleet_paypal_checkouts c ON c.checkout_id = q.checkout_id
             JOIN fleet_payment_rails r2 ON r2.rail_id = c.rail_id JOIN fleet_credential_refs k ON k.credential_id = r2.credential_id
            WHERE q.status = 'requested' AND r2.status = 'active' AND 'refunds' = ANY (r2.capabilities) AND k.status IN ('active','rotating')
              AND (q.authority_id IS NULL OR NOT EXISTS (SELECT 1 FROM fleet_refund_authorities a WHERE a.authority_id = q.authority_id AND fleet_refund_authority_live(a)))
            ORDER BY q.created_at LOOP
    EXIT WHEN n >= v_lim;
    SELECT c.rail_id INTO v_rail FROM fleet_paypal_checkouts c WHERE c.checkout_id = x.checkout_id;
    IF v_free IS NULL THEN
      PERFORM fleet_treasury_lock(v_rail);   -- the same lock the payout issuer takes
      v_liq := fleet_treasury_liquidity(v_rail);
      v_stale := (v_liq ->> 'stale')::boolean;
      -- Requested refunds are counted as committed by fleet_treasury_liquidity; they are the candidates here.
      v_free := (v_liq ->> 'freeMinor')::bigint + (v_liq #>> '{committed,refundsRequestedMinor}')::bigint;
    END IF;
    SELECT * INTO x FROM fleet_paypal_refund_requests WHERE request_id = x.request_id FOR UPDATE;
    -- Re-read under its lock: another worker may have sent it, or bound it to a live authority, meanwhile.
    IF x.status <> 'requested' OR (x.authority_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM fleet_refund_authorities a WHERE a.authority_id = x.authority_id AND fleet_refund_authority_live(a))) THEN CONTINUE; END IF;
    cov := fleet_refund_authority_cover(x, true);
    IF NOT (cov ->> 'covered')::boolean THEN PERFORM fleet_refund_authority_wait(x, cov); CONTINUE; END IF;
    IF v_stale OR x.amount_minor > v_free THEN PERFORM fleet_treasury_liquidity_wait(x.agent_id, 'refund', x.request_id::text, x.amount_minor, v_liq); CONTINUE; END IF;
    UPDATE fleet_paypal_refund_requests SET authority_id = (cov ->> 'authorityId')::uuid, authorised_at = now() WHERE request_id = x.request_id;
    v_ok := v_ok || x.request_id; v_free := v_free - x.amount_minor; n := n + 1;
  END LOOP;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('refundRequestId', x2.request_id, 'captureId', c.capture_id, 'amountMinor', x2.amount_minor, 'currency', x2.currency,
           'note', left(x2.reason, 255), 'invoiceId', 'fleet-refund:' || x2.request_id, 'retry', x2.status = 'sent', 'authorityId', x2.authority_id,
           'railId', r2.rail_id, 'railMode', r2.mode, 'vaultRef', k.vault_ref) ORDER BY x2.created_at), '[]'::jsonb) INTO r
    FROM (SELECT * FROM fleet_paypal_refund_requests q
           WHERE q.request_id = ANY (v_ok)
              -- bound earlier and not yet sent (the worker was gated or stopped): its authority must still be live
              OR (q.status = 'requested' AND q.authority_id IS NOT NULL
                  AND EXISTS (SELECT 1 FROM fleet_refund_authorities a WHERE a.authority_id = q.authority_id AND fleet_refund_authority_live(a)))
              -- sent and unanswered: the same PayPal request again (never a second refund), whatever the authority now
              OR (q.status = 'sent' AND q.updated_at < now() - interval '10 minutes')
           ORDER BY q.created_at LIMIT 50) x2
    JOIN fleet_paypal_checkouts c ON c.checkout_id = x2.checkout_id
    JOIN fleet_payment_rails r2 ON r2.rail_id = c.rail_id JOIN fleet_credential_refs k ON k.credential_id = r2.credential_id
   WHERE r2.status = 'active' AND 'refunds' = ANY (r2.capabilities) AND k.status IN ('active','rotating');
  RETURN r;
END $$;

-- ═══ 3. The owner's proof purchase never holds the agent's cash (row 21) ═══
${AGENT_EXPOSURE}

-- ═══ 4. Product quality: sold publicly only on a current inspector's pass of the current files, and not held ═══
ALTER TABLE fleet_artifact_reviews DROP CONSTRAINT fleet_artifact_reviews_inspector_check;
ALTER TABLE fleet_artifact_reviews ADD CONSTRAINT fleet_artifact_reviews_inspector_check CHECK (inspector IN (${q(QA_INSPECTOR_VERSIONS_V96)}));
${REVIEW_RECORD}

ALTER TABLE fleet_offers ADD COLUMN held_at timestamptz;
ALTER TABLE fleet_offers ADD COLUMN held_by text CHECK (held_by IS NULL OR held_by ~ '^operator:[A-Za-z0-9._-]{1,64}$');
ALTER TABLE fleet_offers ADD COLUMN held_reason text CHECK (held_reason IS NULL OR length(held_reason) BETWEEN 3 AND 300);
ALTER TABLE fleet_offers ADD CONSTRAINT fleet_offers_hold CHECK ((held_at IS NULL) = (held_by IS NULL) AND (held_at IS NULL) = (held_reason IS NULL));

-- Why a published offer is not sold publicly now (NULL: it is). Services keep their sample-review rule (v76).
CREATE FUNCTION fleet_offer_sale_block(o fleet_offers) RETURNS text LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT CASE
    WHEN o.status <> 'published' THEN 'not published'
    WHEN o.held_at IS NOT NULL THEN 'held by the owner: ' || o.held_reason
    WHEN o.kind <> 'product' THEN NULL
    WHEN r.review_id IS NULL OR r.verdict <> 'pass' THEN 'no passing review'
    WHEN r.files_digest <> fleet_files_digest(fleet_offer_deliverables(o.offer_id)) THEN 'its files changed since the review'
    WHEN r.inspector NOT IN (${q(QA_SALE_INSPECTORS)}) THEN 'its review was made by ' || r.inspector || ', which no longer qualifies a product for sale: inspect the current files (deliverable inspect; spreadsheets are now opened as the customer sees them), fix what fails, review again and publish with that review'
  END
  FROM (SELECT 1) one LEFT JOIN fleet_artifact_reviews r ON r.review_id = o.review_id
$$;

${OFFER_BUY}

${PUBLIC_JSON}

${SITEMAP}

${INDEXNOW}

${PUBLISH}

${OFFER_JSON}

-- Owner: hold one offer (not sold publicly; work already accepted continues) and release it. The agent is told.
CREATE FUNCTION fleet_admin_offer_hold(p_slug text, p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_offers;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 3 AND 300 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a reason (3..300 characters) the agent will read'; END IF;
  SELECT * INTO o FROM fleet_offers WHERE slug = p_slug FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: offer slug'; END IF;
  IF o.held_at IS NOT NULL THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'heldAt', o.held_at, 'heldReason', o.held_reason); END IF;
  UPDATE fleet_offers SET held_at = now(), held_by = p_actor, held_reason = left(fleet_scrub(trim(p_reason)), 300) WHERE offer_id = o.offer_id RETURNING * INTO o;
  PERFORM fleet_event('offer_held', o.agent_id, p_actor, jsonb_build_object('offerId', o.offer_id, 'slug', o.slug, 'reason', o.held_reason));
  PERFORM fleet_spend_review_notice(o.agent_id, 'The owner has held your offer "' || o.title || '" (' || o.slug || '): it is not sold publicly until released. Reason: '
    || o.held_reason || '. Orders already paid continue as normal (deliver, support, revise, refund).');
  RETURN jsonb_build_object('ok', true, 'heldAt', o.held_at, 'saleBlock', fleet_offer_sale_block(o));
END $$;

CREATE FUNCTION fleet_admin_offer_release(p_slug text, p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_offers;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  SELECT * INTO o FROM fleet_offers WHERE slug = p_slug FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: offer slug'; END IF;
  IF o.held_at IS NULL THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'saleBlock', fleet_offer_sale_block(o)); END IF;
  UPDATE fleet_offers SET held_at = NULL, held_by = NULL, held_reason = NULL WHERE offer_id = o.offer_id RETURNING * INTO o;
  PERFORM fleet_event('offer_released', o.agent_id, p_actor, jsonb_build_object('offerId', o.offer_id, 'slug', o.slug, 'note', left(COALESCE(p_reason, ''), 300)));
  PERFORM fleet_spend_review_notice(o.agent_id, 'The owner released the hold on your offer "' || o.title || '" (' || o.slug || ').'
    || COALESCE(' It is still not sold publicly: ' || fleet_offer_sale_block(o) || '.', ''));
  RETURN jsonb_build_object('ok', true, 'saleBlock', fleet_offer_sale_block(o));
END $$;

-- ═══ 5. What agents are told the Fleet can do, from verified state (2026-10-19) ═══
SELECT fleet_admin_knowledge_library_load('${JSON.stringify({ entries: CAPABILITY_STATUS_V14.entries }).replace(/'/g, "''")}'::jsonb, 'migration');

-- ═══ 6. Status and routing ═══
${CUSTODY_STATUS}

${EVENT_ROUTE}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

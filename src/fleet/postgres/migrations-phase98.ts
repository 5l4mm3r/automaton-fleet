/**
 * Schema v98 — the PayPal order lifecycle (2026-10-19, during the purchase proof: the order page's PayPal link, created at
 * 11:05Z and pressed after 17:16Z, reached a PayPal page that "doesn't appear to be working"; PayPal's API answers 404 for
 * the order. Nothing was approved or captured).
 *
 * 1. TWO LIFETIMES. The Fleet order (its checkout) is payable until its own expiry (`expires_at`, unchanged). A PayPal order —
 *    the approval link — is shorter-lived and PayPal decides it. The order page sends a buyer straight to PayPal only while
 *    PayPal confirmed the link within the last PAYPAL_LINK_FRESH_MINUTES; otherwise "Pay with PayPal" asks custody first
 *    (`svc_order_pay`) and custody, within seconds: REUSES the PayPal order when PayPal still reports it payable (CREATED /
 *    PAYER_ACTION_REQUIRED), captures it when APPROVED, reads it back when COMPLETED — or RETIRES it and creates a fresh one.
 * 2. EVERY PROVIDER ORDER IS KEPT (`fleet_paypal_provider_orders`, immutable identifiers, append-only history in
 *    `fleet_paypal_provider_order_events` with PayPal's HTTP status, order status, error name and debug id — never a token,
 *    a credential or an approval link). Each creation is CLAIMED first under the checkout's lock with its PayPal-Request-Id
 *    (`order:<checkout>` for the first, `order:<checkout>:<n>` after): at most one live provider order per checkout (unique
 *    index), so double clicks, concurrent workers and retries after a lost answer reuse the same request id and therefore the
 *    same PayPal order. A claim whose answer never came for PAYPAL_CREATE_UNKNOWN_HOURS is kept as `create_unknown` and
 *    reconciled (any order it made was never shown to anyone, so it cannot have been approved through the Fleet).
 *    Every attempt carries the same invoice id (`fleet:<checkout>`), so PayPal itself refuses a second payment of one checkout
 *    where the account blocks duplicate invoice ids; a DUPLICATE_INVOICE_ID refusal is reconciled.
 * 3. RETIREMENT IS EVIDENCE-BASED, NOT A CLAIM OF NON-PAYMENT. A provider order is retired only when (a) PayPal VOIDED it, or
 *    (b) PayPal answered RESOURCE_NOT_FOUND (by name, with a debug id) to at least two separate reads, made with the SAME
 *    credential and environment that created it (a credential that predates the order and is still bound to the rail), AND
 *    a control read of a captured order of that same credential and environment succeeded at the same time (so the 404 is
 *    about this order, not access) — and never when anything suggests approval or payment (an APPROVED / COMPLETED status, a
 *    webhook about the order, a capture on the checkout). A 404 that cannot be verified retires nothing: it is reconciled and
 *    the owner may retire it explicitly (recorded). A retired order stays WATCHED (read for PAYPAL_RETIRED_WATCH_DAYS; its
 *    webhooks matched): a late approval is never captured automatically — it is reconciled and alerted (P1); a late capture
 *    (money PayPal took) is booked to the checkout only if the checkout has no capture yet, otherwise it is a duplicate held
 *    for reconciliation (P1). No automatic refund is promised: a refund needs the existing refund authority.
 * 4. RECONCILIATION WITHOUT TRANSACTION SEARCH. Transaction Search answers 403 when the app lacks its permission; that
 *    outcome (HTTP status, error name, debug id) and whether the access token carries the Transaction Search scope are now
 *    recorded (`fleet_paypal_sync_status`). Independently, every provider order the Fleet created is audited through the
 *    Orders API the credential already uses: each captured order is read daily for 30 days, then weekly to 180 days, and its
 *    captures and refunds (PayPal's own objects, by id) are booked once through the existing capture / refund evidence paths;
 *    disagreements are reconciled. No credential is broadened.
 */
import { V97_SQL } from "./migrations-phase97.js";
import { V76_SQL } from "./migrations-phase76.js";
import { V53_SQL } from "./migrations-phase53.js";
import { V48_SQL } from "./migrations-phase48.js";
import { V80_SQL } from "./migrations-phase80.js";
import { EVENT_ROUTES_V96 } from "./migrations-phase96.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));
const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

/** The Fleet sends a buyer straight to PayPal only while PayPal confirmed the link this recently (minutes). */
export const PAYPAL_LINK_FRESH_MINUTES = 60;
/** A creation whose answer never came is kept as create_unknown after this long (hours). */
export const PAYPAL_CREATE_UNKNOWN_HOURS = 3;
/** A retired PayPal order is still read (late approval / capture) for this long (days). */
export const PAYPAL_RETIRED_WATCH_DAYS = 30;
/** RESOURCE_NOT_FOUND answers (each with its own debug id) needed before a not-found order can be retired. */
export const PAYPAL_NOT_FOUND_READS = 2;
/** A buyer's pay request PayPal could not settle within this long is answered "try again" (minutes). */
export const PAYPAL_PAY_WAIT_MINUTES = 3;
const PAY_WAIT_MINUTES_SQL = String(PAYPAL_PAY_WAIT_MINUTES);
/** Captured orders are audited (captures, refunds) for this long (days). */
export const PAYPAL_AUDIT_DAYS = 180;
export const PAYPAL_RECON_KINDS = ["late_approval", "late_capture", "duplicate_capture", "duplicate_invoice", "create_outcome_unknown",
  "not_found_unverifiable", "audit_mismatch", "mapping_mismatch"] as const;
export const PAYPAL_ORDER_EVENT_KINDS = ["create_requested", "created", "create_failed", "create_indefinite", "create_unknown", "read", "approved", "captured",
  "capture_failed", "retired", "closed", "late_approval", "late_capture", "audit"] as const;
export const EVENT_ROUTES_V98 = Object.freeze({
  P1_HIGH: [...EVENT_ROUTES_V96.P1_HIGH, "paypal_reconciliation_needed"],
  P2_IMPORTANT: [...EVENT_ROUTES_V96.P2_IMPORTANT, "paypal_order_replaced", "paypal_order_retired", "paypal_reconciliation_resolved"],
} as const);

const WORKER = `IF p_worker IS NULL OR p_worker !~ '^[a-z0-9-]{3,40}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: worker name'; END IF;`;
const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');`;
const PAYPAL_ID = `'^[A-Z0-9]{5,40}$'`;
const DEBUG_ID = `'^[A-Za-z0-9-]{4,64}$'`;
const APPROVAL_URL = `'^https://www[.](sandbox[.])?paypal[.]com/[A-Za-z0-9/?&=._%-]+$'`;
const REQ = (attempt: string) => `CASE WHEN ${attempt} = 1 THEN 'order:' || c.checkout_id ELSE 'order:' || c.checkout_id || ':' || ${attempt} END`;
const CAPTURE_REQ = `CASE WHEN p.attempt IS NULL OR p.attempt = 1 THEN 'capture:' || c.checkout_id ELSE 'capture:' || c.checkout_id || ':' || p.attempt END`;

// ── The checkout's current PayPal order may change only to a newly recorded one, after the previous one was retired ──
const CHECKOUT_GUARD = restate(V53_SQL, "fleet_paypal_checkouts_guard", [
  [`     OR (OLD.paypal_order_id IS NOT NULL AND NEW.paypal_order_id IS DISTINCT FROM OLD.paypal_order_id)`,
   `     OR (OLD.paypal_order_id IS NOT NULL AND NEW.paypal_order_id IS DISTINCT FROM OLD.paypal_order_id
         AND NOT @@SCHEMA@@.fleet_paypal_replacement_ok(OLD.checkout_id, OLD.paypal_order_id, NEW.paypal_order_id))`],
]);

// ── Custody's lists carry each provider order's capture request id (the first order keeps the legacy one) ──
const WORK = restate(V76_SQL, "cx_paypal_work", [
  [`'vaultRef', k.vault_ref, 'returnToken',`,
   `'vaultRef', k.vault_ref, 'captureRequestId', (SELECT ${CAPTURE_REQ} FROM (SELECT 1) one LEFT JOIN fleet_paypal_provider_orders p ON p.paypal_order_id = c.paypal_order_id),
           'returnToken',`],
]);
const STATUS_WORK = restate(V76_SQL, "cx_paypal_status_work", [
  [`'paypalOrderId', c.paypal_order_id, 'railId', r.rail_id,`,
   `'paypalOrderId', c.paypal_order_id, 'captureRequestId', (SELECT ${CAPTURE_REQ} FROM (SELECT 1) one LEFT JOIN fleet_paypal_provider_orders p ON p.paypal_order_id = c.paypal_order_id),
           'providerOrderId', (SELECT p.provider_order_id FROM fleet_paypal_provider_orders p WHERE p.paypal_order_id = c.paypal_order_id),
           'railId', r.rail_id,`],
]);
// A webhook's order id: any provider order the Fleet ever created (current or retired), with that order's own credential.
const BY_ORDER = restate(V48_SQL, "cx_paypal_checkout_by_order", [
  [`DECLARE c fleet_paypal_checkouts; r fleet_payment_rails; k fleet_credential_refs;`,
   `DECLARE c fleet_paypal_checkouts; r fleet_payment_rails; k fleet_credential_refs; p fleet_paypal_provider_orders;`],
  [`  SELECT * INTO c FROM fleet_paypal_checkouts WHERE paypal_order_id = p_order_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;`,
   `  SELECT * INTO p FROM fleet_paypal_provider_orders WHERE paypal_order_id = p_order_id;
  SELECT * INTO c FROM fleet_paypal_checkouts WHERE checkout_id = p.checkout_id OR (p.checkout_id IS NULL AND paypal_order_id = p_order_id);
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;`],
  [`    'railId', r.rail_id, 'railMode', r.mode, 'credentialId', r.credential_id, 'vaultRef', k.vault_ref);`,
   `    'railId', r.rail_id, 'railMode', r.mode, 'credentialId', r.credential_id, 'vaultRef', k.vault_ref)
    || jsonb_strip_nulls(jsonb_build_object('providerOrderId', p.provider_order_id, 'orderState', p.state, 'current', c.paypal_order_id = p_order_id,
         'captureRequestId', ${CAPTURE_REQ}));`],
]);
// A capture may also be read back from the order (the audit); a second, different capture of a checkout is reconciled.
const CAPTURE_RECORD = restate(V76_SQL, "cx_paypal_capture_record", [
  [`p_evidence NOT IN ('capture_response','webhook','transaction_search')`, `p_evidence NOT IN ('capture_response','webhook','transaction_search','order_read')`],
  [`    PERFORM fleet_event('paypal_capture_conflict', c.agent_id, 'custody', jsonb_build_object('checkoutId', c.checkout_id, 'recorded', c.capture_id, 'reported', p_capture_id));`,
   `    PERFORM fleet_event('paypal_capture_conflict', c.agent_id, 'custody', jsonb_build_object('checkoutId', c.checkout_id, 'recorded', c.capture_id, 'reported', p_capture_id));
    PERFORM fleet_paypal_recon_add('duplicate_capture', c.checkout_id, NULL, p_capture_id, p_gross, p_currency,
      jsonb_build_object('recordedCapture', c.capture_id, 'evidence', p_evidence, 'note', 'PayPal reports a second capture for a checkout that is already captured: not booked; refund only under refund authority'));`],
]);

// ── The order page: which payment step to show (see public-pages.ts) ──
const ORDER_PAGE = restate(V97_SQL, "svc_order_page", [
  [`'approvalUrl', CASE WHEN c.status = 'open' AND x.consent_at IS NOT NULL THEN c.approval_url END,`,
   `'approvalUrl', CASE WHEN c.status = 'open' AND x.consent_at IS NOT NULL AND fleet_paypal_link_fresh(c.checkout_id) AND NOT fleet_paypal_pay_pending(c)
                        THEN (SELECT p.approval_url FROM fleet_paypal_provider_orders p WHERE p.checkout_id = c.checkout_id AND p.state = 'open') END,
      'pay', CASE WHEN x.consent_at IS NULL OR c.status NOT IN ('requested','open') OR c.expires_at <= now() THEN NULL
                  WHEN fleet_paypal_pay_pending(c) THEN 'preparing'
                  WHEN c.status = 'open' AND fleet_paypal_link_fresh(c.checkout_id) THEN 'link'
                  WHEN c.pay_failure IS NOT NULL THEN 'retry' ELSE 'button' END,
      'payFailureRef', CASE WHEN c.pay_failure IS NOT NULL THEN c.pay_failure_ref END,
      'payableUntil', CASE WHEN c.status IN ('requested','open') THEN c.expires_at END,`],
]);

const EVENT_ROUTE = restate(V80_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V98) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
]);

export const V98_SQL = `
-- ═══ 1. Provider orders, their history, reconciliation items, sync status ═══
ALTER TABLE fleet_paypal_checkouts ADD COLUMN pay_requested_at timestamptz, ADD COLUMN pay_served_at timestamptz,
  ADD COLUMN pay_failure text CHECK (pay_failure ~ '^[a-z0-9_]{2,64}$'), ADD COLUMN pay_failure_ref text CHECK (pay_failure_ref ~ ${DEBUG_ID});

CREATE TABLE fleet_paypal_provider_orders (
  provider_order_id uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_id       uuid        NOT NULL REFERENCES fleet_paypal_checkouts(checkout_id),
  attempt           integer     NOT NULL CHECK (attempt BETWEEN 1 AND 100),
  request_id        text        NOT NULL UNIQUE CHECK (request_id ~ '^order:[0-9a-f-]{36}(:[0-9]{1,3})?$'),
  rail_id           uuid        NOT NULL REFERENCES fleet_payment_rails(rail_id),
  credential_id     uuid        NOT NULL REFERENCES fleet_credential_refs(credential_id),
  rail_mode         text        NOT NULL CHECK (rail_mode IN ('live','sandbox')),
  paypal_order_id   text        UNIQUE CHECK (paypal_order_id ~ ${PAYPAL_ID}),
  approval_url      text        CHECK (length(approval_url) <= 500 AND approval_url ~ ${APPROVAL_URL}),
  payee_merchant_id text        CHECK (payee_merchant_id ~ ${PAYPAL_ID}),
  state             text        NOT NULL CHECK (state IN ('creating','open','approved','captured','retired','closed','create_failed','create_unknown')),
  legacy            boolean     NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  opened_at         timestamptz,
  confirmed_at      timestamptz,
  last_status_seen  text        CHECK (last_status_seen ~ '^[A-Z_]{2,40}$'),
  reads             integer     NOT NULL DEFAULT 0,
  last_read_at      timestamptz,
  next_read_at      timestamptz,
  retired_at        timestamptz,
  retire_reason     text        CHECK (retire_reason IN ('voided','not_found_verified','owner')),
  retire_evidence   jsonb       CHECK (retire_evidence IS NULL OR length(retire_evidence::text) <= 2000),
  UNIQUE (checkout_id, attempt),
  CHECK (state NOT IN ('open','approved','captured') OR paypal_order_id IS NOT NULL),
  CHECK (state <> 'retired' OR (retired_at IS NOT NULL AND retire_reason IS NOT NULL))
);
CREATE UNIQUE INDEX fleet_paypal_provider_orders_live ON fleet_paypal_provider_orders (checkout_id) WHERE state IN ('creating','open','approved','captured');
CREATE INDEX fleet_paypal_provider_orders_watch ON fleet_paypal_provider_orders (next_read_at) WHERE state IN ('retired','captured','closed');
CREATE FUNCTION fleet_paypal_provider_orders_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: provider orders are history'; END IF;
  IF NEW.provider_order_id <> OLD.provider_order_id OR NEW.checkout_id <> OLD.checkout_id OR NEW.attempt <> OLD.attempt OR NEW.request_id <> OLD.request_id
     OR NEW.rail_id <> OLD.rail_id OR NEW.credential_id <> OLD.credential_id OR NEW.rail_mode <> OLD.rail_mode OR NEW.created_at <> OLD.created_at
     OR NEW.legacy <> OLD.legacy
     OR (OLD.paypal_order_id IS NOT NULL AND NEW.paypal_order_id IS DISTINCT FROM OLD.paypal_order_id)
     OR (OLD.approval_url IS NOT NULL AND NEW.approval_url IS DISTINCT FROM OLD.approval_url)
     OR (OLD.retired_at IS NOT NULL AND (NEW.retired_at IS DISTINCT FROM OLD.retired_at OR NEW.retire_reason IS DISTINCT FROM OLD.retire_reason
                                         OR NEW.retire_evidence IS DISTINCT FROM OLD.retire_evidence)) THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a provider order''s identity and retirement are fixed';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'creating' AND NEW.state IN ('open','create_failed','create_unknown','closed'))
    OR (OLD.state = 'open' AND NEW.state IN ('approved','captured','retired','closed'))
    OR (OLD.state = 'approved' AND NEW.state IN ('captured','closed'))
    -- Money that arrives after the Fleet gave up on a checkout is still that checkout's money.
    OR (OLD.state = 'closed' AND NEW.state IN ('captured'))) THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: provider order % -> %', OLD.state, NEW.state;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_paypal_provider_orders_guard BEFORE UPDATE OR DELETE ON fleet_paypal_provider_orders FOR EACH ROW EXECUTE FUNCTION fleet_paypal_provider_orders_guard();
CREATE TRIGGER fleet_paypal_provider_orders_no_truncate BEFORE TRUNCATE ON fleet_paypal_provider_orders FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_paypal_provider_order_events (
  event_id          bigserial   PRIMARY KEY,
  provider_order_id uuid        NOT NULL REFERENCES fleet_paypal_provider_orders(provider_order_id),
  at                timestamptz NOT NULL DEFAULT now(),
  kind              text        NOT NULL CHECK (kind IN (${q(PAYPAL_ORDER_EVENT_KINDS)})),
  http_status       integer     CHECK (http_status BETWEEN 100 AND 599),
  provider_status   text        CHECK (provider_status ~ '^[A-Z_]{2,40}$'),
  error_name        text        CHECK (error_name ~ '^[A-Z0-9_]{2,64}$'),
  debug_id          text        CHECK (debug_id ~ ${DEBUG_ID}),
  detail            jsonb       CHECK (detail IS NULL OR (jsonb_typeof(detail) = 'object' AND length(detail::text) <= 2000))
);
CREATE INDEX fleet_paypal_provider_order_events_order ON fleet_paypal_provider_order_events (provider_order_id, at);
CREATE TRIGGER fleet_paypal_provider_order_events_no_change BEFORE UPDATE OR DELETE ON fleet_paypal_provider_order_events FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_paypal_provider_order_events_no_truncate BEFORE TRUNCATE ON fleet_paypal_provider_order_events FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_paypal_reconciliation_items (
  item_id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text        NOT NULL CHECK (kind IN (${q(PAYPAL_RECON_KINDS)})),
  checkout_id       uuid        REFERENCES fleet_paypal_checkouts(checkout_id),
  provider_order_id uuid        REFERENCES fleet_paypal_provider_orders(provider_order_id),
  paypal_ref        text        NOT NULL CHECK (paypal_ref ~ '^[A-Za-z0-9:-]{3,90}$'),
  amount_minor      bigint,
  currency          text        CHECK (currency ~ '^[A-Z]{3}$'),
  detail            jsonb       CHECK (detail IS NULL OR (jsonb_typeof(detail) = 'object' AND length(detail::text) <= 2000)),
  status            text        NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,
  resolved_by       text        CHECK (resolved_by ~ '^operator:[A-Za-z0-9._-]{1,64}$'),
  resolution        text        CHECK (length(resolution) BETWEEN 3 AND 500),
  UNIQUE (kind, paypal_ref),
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND resolution IS NOT NULL))
);
CREATE FUNCTION fleet_paypal_reconciliation_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: reconciliation items are history'; END IF;
  IF OLD.status = 'resolved' OR NEW.item_id <> OLD.item_id OR NEW.kind <> OLD.kind OR NEW.checkout_id IS DISTINCT FROM OLD.checkout_id
     OR NEW.provider_order_id IS DISTINCT FROM OLD.provider_order_id OR NEW.paypal_ref <> OLD.paypal_ref OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
     OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.detail IS DISTINCT FROM OLD.detail OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a reconciliation item is only resolved, once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_paypal_reconciliation_items_guard BEFORE UPDATE OR DELETE ON fleet_paypal_reconciliation_items FOR EACH ROW EXECUTE FUNCTION fleet_paypal_reconciliation_items_guard();
CREATE TRIGGER fleet_paypal_reconciliation_items_no_truncate BEFORE TRUNCATE ON fleet_paypal_reconciliation_items FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_paypal_sync_status (
  rail_id         uuid        NOT NULL REFERENCES fleet_payment_rails(rail_id),
  kind            text        NOT NULL CHECK (kind IN ('transaction_search','order_audit','token_scopes')),
  last_attempt_at timestamptz NOT NULL,
  last_http       integer     CHECK (last_http BETWEEN 100 AND 599),
  last_error_name text        CHECK (last_error_name ~ '^[A-Z0-9_]{2,64}$'),
  last_debug_id   text        CHECK (last_debug_id ~ ${DEBUG_ID}),
  last_ok_at      timestamptz,
  detail          jsonb       CHECK (detail IS NULL OR (jsonb_typeof(detail) = 'object' AND length(detail::text) <= 2000)),
  PRIMARY KEY (rail_id, kind)
);

-- ═══ 2. Helpers ═══
CREATE FUNCTION fleet_paypal_link_fresh(p_checkout uuid) RETURNS boolean LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM fleet_paypal_provider_orders p WHERE p.checkout_id = p_checkout AND p.state = 'open' AND p.approval_url IS NOT NULL
                   AND COALESCE(p.confirmed_at, p.opened_at) > now() - interval '${PAYPAL_LINK_FRESH_MINUTES} minutes')
$$;
CREATE FUNCTION fleet_paypal_pay_pending(c fleet_paypal_checkouts) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT c.pay_requested_at IS NOT NULL AND c.pay_requested_at > COALESCE(c.pay_served_at, '-infinity'::timestamptz)
$$;
-- The checkout's current order may change only from a retired one to a newly recorded one of the same checkout.
CREATE FUNCTION fleet_paypal_replacement_ok(p_checkout uuid, p_old text, p_new text) RETURNS boolean LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT p_new IS NOT NULL
     AND EXISTS (SELECT 1 FROM fleet_paypal_provider_orders WHERE checkout_id = p_checkout AND paypal_order_id = p_old AND state = 'retired')
     AND EXISTS (SELECT 1 FROM fleet_paypal_provider_orders WHERE checkout_id = p_checkout AND paypal_order_id = p_new AND state = 'open')
$$;
CREATE FUNCTION fleet_paypal_order_event(p_order uuid, p_kind text, p_http integer, p_status text, p_name text, p_debug text, p_detail jsonb) RETURNS void LANGUAGE sql
SET search_path = @@SCHEMA@@, pg_temp AS $$
  INSERT INTO fleet_paypal_provider_order_events (provider_order_id, kind, http_status, provider_status, error_name, debug_id, detail)
    VALUES (p_order, p_kind, CASE WHEN p_http BETWEEN 100 AND 599 THEN p_http END, CASE WHEN p_status ~ '^[A-Z_]{2,40}$' THEN p_status END,
            CASE WHEN p_name ~ '^[A-Z0-9_]{2,64}$' THEN p_name END, CASE WHEN p_debug ~ ${DEBUG_ID} THEN p_debug END,
            CASE WHEN jsonb_typeof(p_detail) = 'object' AND length(p_detail::text) <= 2000 THEN p_detail END)
$$;
-- A reconciliation item (once per kind and PayPal reference) and one P1 alert for it.
CREATE FUNCTION fleet_paypal_recon_add(p_kind text, p_checkout uuid, p_order uuid, p_ref text, p_amount bigint, p_currency text, p_detail jsonb) RETURNS boolean LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v uuid; a text;
BEGIN
  INSERT INTO fleet_paypal_reconciliation_items (kind, checkout_id, provider_order_id, paypal_ref, amount_minor, currency, detail)
    VALUES (p_kind, p_checkout, p_order, left(p_ref, 90), p_amount, CASE WHEN p_currency ~ '^[A-Z]{3}$' THEN p_currency END,
            CASE WHEN jsonb_typeof(p_detail) = 'object' AND length(p_detail::text) <= 2000 THEN p_detail END)
    ON CONFLICT (kind, paypal_ref) DO NOTHING RETURNING item_id INTO v;
  IF v IS NULL THEN RETURN false; END IF;
  SELECT agent_id INTO a FROM fleet_paypal_checkouts WHERE checkout_id = p_checkout;
  PERFORM fleet_event('paypal_reconciliation_needed', a, 'custody', jsonb_build_object('itemId', v, 'kind', p_kind, 'checkoutId', p_checkout, 'paypalRef', p_ref,
    'note', 'PayPal evidence that needs the owner''s reconciliation (nothing was captured or refunded automatically because of it): fleet:admin hub-paypal-reconciliation'));
  RETURN true;
END $$;

-- Provider orders follow their checkout (approved / captured / closed) and every order id a checkout carries is recorded —
-- whichever path set it (custody's creation, an older custody's checkout update, a test fixture).
CREATE FUNCTION fleet_paypal_checkouts_follow_orders() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_payment_rails; n integer; p fleet_paypal_provider_orders;
BEGIN
  IF NEW.paypal_order_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO p FROM fleet_paypal_provider_orders WHERE paypal_order_id = NEW.paypal_order_id;
  IF NOT FOUND THEN
    SELECT * INTO r FROM fleet_payment_rails WHERE rail_id = NEW.rail_id;
    SELECT COALESCE(max(attempt), 0) + 1 INTO n FROM fleet_paypal_provider_orders WHERE checkout_id = NEW.checkout_id;
    INSERT INTO fleet_paypal_provider_orders (checkout_id, attempt, request_id, rail_id, credential_id, rail_mode, paypal_order_id, approval_url, state, legacy, opened_at, confirmed_at)
      VALUES (NEW.checkout_id, n, CASE WHEN n = 1 THEN 'order:' || NEW.checkout_id ELSE 'order:' || NEW.checkout_id || ':' || n END, r.rail_id, r.credential_id, r.mode,
              NEW.paypal_order_id, NEW.approval_url, 'open', true, COALESCE(NEW.opened_at, now()), COALESCE(NEW.opened_at, now()))
      RETURNING * INTO p;
  END IF;
  IF NEW.status = 'approved' AND p.state = 'open' THEN
    UPDATE fleet_paypal_provider_orders SET state = 'approved' WHERE provider_order_id = p.provider_order_id;
    PERFORM fleet_paypal_order_event(p.provider_order_id, 'approved', NULL, 'APPROVED', NULL, NULL, NULL);
  ELSIF NEW.status = 'captured' AND p.state IN ('open','approved','closed') THEN
    -- Money that came through a retired order of this checkout (a late capture) is not this order's: it is closed, not captured.
    IF p.state = 'open' AND COALESCE(p.last_status_seen, '') <> 'COMPLETED' AND EXISTS (SELECT 1 FROM fleet_paypal_provider_orders z
         JOIN fleet_paypal_provider_order_events e ON e.provider_order_id = z.provider_order_id
        WHERE z.checkout_id = NEW.checkout_id AND z.provider_order_id <> p.provider_order_id AND e.kind = 'late_capture') THEN
      UPDATE fleet_paypal_provider_orders SET state = 'closed', next_read_at = now() + interval '10 minutes' WHERE provider_order_id = p.provider_order_id;
      PERFORM fleet_paypal_order_event(p.provider_order_id, 'closed', NULL, NULL, NULL, NULL, jsonb_build_object('checkout', 'captured through a retired order'));
    ELSE
      UPDATE fleet_paypal_provider_orders SET state = 'captured', next_read_at = now() + interval '1 day' WHERE provider_order_id = p.provider_order_id;
      PERFORM fleet_paypal_order_event(p.provider_order_id, 'captured', NULL, 'COMPLETED', NULL, NULL, jsonb_build_object('captureId', NEW.capture_id));
    END IF;
  ELSIF NEW.status IN ('failed','cancelled','expired') AND p.state IN ('creating','open','approved') THEN
    UPDATE fleet_paypal_provider_orders SET state = 'closed', next_read_at = now() + interval '10 minutes' WHERE provider_order_id = p.provider_order_id;
    PERFORM fleet_paypal_order_event(p.provider_order_id, 'closed', NULL, NULL, NULL, NULL, jsonb_build_object('checkout', NEW.status));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_paypal_checkouts_follow_orders AFTER INSERT OR UPDATE OF status, paypal_order_id ON fleet_paypal_checkouts
  FOR EACH ROW EXECUTE FUNCTION fleet_paypal_checkouts_follow_orders();

-- Every order id the Fleet already holds becomes a provider order (attempt 1, the request id it was created with).
INSERT INTO fleet_paypal_provider_orders (checkout_id, attempt, request_id, rail_id, credential_id, rail_mode, paypal_order_id, approval_url, state, legacy,
                                          created_at, opened_at, confirmed_at, last_status_seen, reads, next_read_at)
SELECT c.checkout_id, 1, 'order:' || c.checkout_id, r.rail_id, r.credential_id, r.mode, c.paypal_order_id, c.approval_url,
       CASE c.status WHEN 'open' THEN 'open' WHEN 'approved' THEN 'approved' WHEN 'capture_pending' THEN 'approved' WHEN 'captured' THEN 'captured' ELSE 'closed' END,
       true, COALESCE(c.opened_at, c.created_at), c.opened_at, c.opened_at, c.last_status_seen, c.status_checks,
       CASE WHEN c.status = 'captured' THEN now() END
  FROM fleet_paypal_checkouts c JOIN fleet_payment_rails r ON r.rail_id = c.rail_id
 WHERE c.paypal_order_id IS NOT NULL;

${CHECKOUT_GUARD}

-- ═══ 3. The buyer is ready to pay (controller, service role) ═══
-- Idempotent: a double click, a reload or a second tab records one pending request. A link PayPal confirmed recently is
-- returned at once; anything else waits for custody (seconds).
CREATE FUNCTION svc_order_pay(p_token text, p_origin text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_customer_orders; c fleet_paypal_checkouts; v_url text;
BEGIN
  SELECT * INTO x FROM fleet_customer_orders WHERE access_token = p_token;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  -- The same rule as the page: the payment step comes after the consent the law requires (when the order asks for one).
  IF x.consent_at IS NULL AND jsonb_typeof(fleet_order_consent_json(x) -> 'statements') = 'array'
     AND jsonb_array_length(fleet_order_consent_json(x) -> 'statements') > 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CONSENT_REQUIRED');
  END IF;
  SELECT * INTO c FROM fleet_paypal_checkouts WHERE checkout_id = x.checkout_id FOR UPDATE;
  IF c.status NOT IN ('requested','open') OR c.expires_at <= now() OR x.payment_status <> 'awaiting_payment' THEN
    RETURN jsonb_build_object('ok', true, 'state', c.status);
  END IF;
  IF c.status = 'open' AND fleet_paypal_link_fresh(c.checkout_id) AND NOT fleet_paypal_pay_pending(c) THEN
    SELECT approval_url INTO v_url FROM fleet_paypal_provider_orders WHERE checkout_id = c.checkout_id AND state = 'open';
    RETURN jsonb_build_object('ok', true, 'state', 'link', 'redirect', v_url);
  END IF;
  IF NOT fleet_paypal_pay_pending(c) THEN
    UPDATE fleet_paypal_checkouts SET pay_requested_at = clock_timestamp(), pay_failure = NULL, pay_failure_ref = NULL WHERE checkout_id = c.checkout_id;
  END IF;
  RETURN jsonb_build_object('ok', true, 'state', 'preparing');
END $$;

${ORDER_PAGE}

-- ═══ 4. Custody: claim, create, read, retire, watch, reconcile ═══
-- Checkouts whose buyer is waiting to pay, with their live provider order and, for a not-found check, a control order of the
-- same credential and environment.
CREATE FUNCTION cx_paypal_pay_work(p_worker text, p_limit integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r jsonb;
BEGIN
  ${WORKER}
  -- A buyer is never left waiting: a request PayPal could not settle within ${PAY_WAIT_MINUTES_SQL} minutes is answered "try again" (nothing charged).
  UPDATE fleet_paypal_checkouts z SET pay_served_at = clock_timestamp(), pay_failure = 'paypal_unavailable'
   WHERE fleet_paypal_pay_pending(z) AND z.pay_requested_at < now() - interval '${PAY_WAIT_MINUTES_SQL} minutes';
  SELECT COALESCE(jsonb_agg(jsonb_build_object('checkoutId', c.checkout_id, 'status', c.status, 'amountMinor', c.amount_minor, 'currency', c.currency,
           'description', c.description, 'railId', x.rail_id, 'railMode', x.mode, 'credentialId', x.credential_id, 'vaultRef', k.vault_ref,
           'returnToken', (SELECT o.access_token FROM fleet_customer_orders o WHERE o.checkout_id = c.checkout_id),
           'order', (SELECT jsonb_strip_nulls(jsonb_build_object('providerOrderId', p.provider_order_id, 'state', p.state, 'paypalOrderId', p.paypal_order_id,
                       'railMode', p.rail_mode, 'vaultRef', pk.vault_ref, 'captureRequestId', ${CAPTURE_REQ},
                       'notFoundReads', (SELECT count(DISTINCT e.debug_id) FROM fleet_paypal_provider_order_events e WHERE e.provider_order_id = p.provider_order_id
                                           AND e.kind = 'read' AND e.http_status = 404 AND e.error_name = 'RESOURCE_NOT_FOUND' AND e.debug_id IS NOT NULL
                                           AND e.at > now() - interval '10 minutes'),
                       'control', (SELECT z.paypal_order_id FROM fleet_paypal_provider_orders z WHERE z.state = 'captured' AND z.credential_id = p.credential_id
                                     AND z.rail_mode = p.rail_mode ORDER BY z.created_at DESC LIMIT 1)))
                       FROM fleet_paypal_provider_orders p JOIN fleet_credential_refs pk ON pk.credential_id = p.credential_id
                      WHERE p.checkout_id = c.checkout_id AND p.state IN ('creating','open','approved'))) ORDER BY c.pay_requested_at), '[]'::jsonb) INTO r
    FROM (SELECT * FROM fleet_paypal_checkouts z WHERE fleet_paypal_pay_pending(z) AND z.status IN ('requested','open','approved') AND z.expires_at > now()
           ORDER BY z.pay_requested_at LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50)) c
    JOIN fleet_payment_rails x ON x.rail_id = c.rail_id JOIN fleet_credential_refs k ON k.credential_id = x.credential_id
   WHERE (x.status = 'active' OR (x.status = 'pending_setup' AND c.purpose = 'owner_test')) AND k.status IN ('active','rotating');
  RETURN r;
END $$;

-- Claim the creation of a PayPal order for a checkout, under its lock: the live claim is returned again (a retry uses the same
-- PayPal-Request-Id, so PayPal returns the same order); a claim unanswered for ${PAYPAL_CREATE_UNKNOWN_HOURS} h is kept as create_unknown.
CREATE FUNCTION cx_paypal_order_claim(p_worker text, p_checkout uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_paypal_checkouts; p fleet_paypal_provider_orders; x fleet_payment_rails; k fleet_credential_refs; n integer; v_retry boolean := false;
BEGIN
  ${WORKER}
  SELECT * INTO c FROM fleet_paypal_checkouts WHERE checkout_id = p_checkout FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF c.status NOT IN ('requested','open') OR c.expires_at <= now() THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE', 'status', c.status); END IF;
  SELECT * INTO p FROM fleet_paypal_provider_orders WHERE checkout_id = c.checkout_id AND state IN ('creating','open','approved','captured');
  IF FOUND AND p.state = 'creating' AND p.created_at > now() - interval '${PAYPAL_CREATE_UNKNOWN_HOURS} hours' THEN
    v_retry := true;
  ELSIF FOUND AND p.state = 'creating' THEN
    UPDATE fleet_paypal_provider_orders SET state = 'create_unknown' WHERE provider_order_id = p.provider_order_id;
    PERFORM fleet_paypal_order_event(p.provider_order_id, 'create_unknown', NULL, NULL, NULL, NULL, jsonb_build_object('requestId', p.request_id));
    PERFORM fleet_paypal_recon_add('create_outcome_unknown', c.checkout_id, p.provider_order_id, p.request_id, c.amount_minor, c.currency,
      jsonb_build_object('note', 'PayPal never answered this creation; an order may exist under this request id, but its approval link was never shown to anyone'));
    p := NULL;
  ELSIF FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ORDER_LIVE', 'state', p.state, 'paypalOrderId', p.paypal_order_id);
  END IF;
  SELECT * INTO x FROM fleet_payment_rails WHERE rail_id = c.rail_id;
  SELECT * INTO k FROM fleet_credential_refs WHERE credential_id = x.credential_id;
  IF NOT v_retry THEN
    IF NOT ((x.status = 'active' OR (x.status = 'pending_setup' AND c.purpose = 'owner_test')) AND k.status IN ('active','rotating')) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_RAIL_UNAVAILABLE');
    END IF;
    SELECT COALESCE(max(attempt), 0) + 1 INTO n FROM fleet_paypal_provider_orders WHERE checkout_id = c.checkout_id;
    INSERT INTO fleet_paypal_provider_orders (checkout_id, attempt, request_id, rail_id, credential_id, rail_mode, state)
      VALUES (c.checkout_id, n, ${REQ("n")}, x.rail_id, x.credential_id, x.mode, 'creating') RETURNING * INTO p;
    PERFORM fleet_paypal_order_event(p.provider_order_id, 'create_requested', NULL, NULL, NULL, NULL, jsonb_build_object('requestId', p.request_id));
  END IF;
  RETURN jsonb_build_object('ok', true, 'retry', v_retry, 'providerOrderId', p.provider_order_id, 'attempt', p.attempt, 'requestId', p.request_id,
    'checkoutId', c.checkout_id, 'amountMinor', c.amount_minor, 'currency', c.currency, 'description', c.description, 'railMode', p.rail_mode,
    'vaultRef', (SELECT vault_ref FROM fleet_credential_refs WHERE credential_id = p.credential_id),
    'returnToken', (SELECT o.access_token FROM fleet_customer_orders o WHERE o.checkout_id = c.checkout_id));
END $$;

-- PayPal created the order (or returned it again for the same request id): it becomes the checkout's current order.
CREATE FUNCTION cx_paypal_order_created(p_worker text, p_order uuid, p_paypal_order text, p_approval_url text, p_payee text, p_debug text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_paypal_provider_orders; c fleet_paypal_checkouts; v_old text;
BEGIN
  ${WORKER}
  IF p_paypal_order IS NULL OR p_paypal_order !~ ${PAYPAL_ID} OR p_approval_url IS NULL OR length(p_approval_url) > 500 OR p_approval_url !~ ${APPROVAL_URL} THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  SELECT * INTO p FROM fleet_paypal_provider_orders WHERE provider_order_id = p_order FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF p.paypal_order_id = p_paypal_order THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'state', p.state); END IF;
  IF p.paypal_order_id IS NOT NULL OR EXISTS (SELECT 1 FROM fleet_paypal_provider_orders WHERE paypal_order_id = p_paypal_order) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PAYPAL_CONFLICT');
  END IF;
  SELECT * INTO c FROM fleet_paypal_checkouts WHERE checkout_id = p.checkout_id FOR UPDATE;
  IF p.state <> 'creating' THEN
    -- An answer after the claim was given up (create_unknown / closed): kept as history, never shown.
    UPDATE fleet_paypal_provider_orders SET paypal_order_id = p_paypal_order, payee_merchant_id = CASE WHEN p_payee ~ ${PAYPAL_ID} THEN p_payee END
     WHERE provider_order_id = p.provider_order_id;
    PERFORM fleet_paypal_order_event(p.provider_order_id, 'created', 201, NULL, NULL, p_debug, jsonb_build_object('late', true));
    RETURN jsonb_build_object('ok', true, 'late', true, 'state', p.state);
  END IF;
  IF c.status NOT IN ('requested','open') THEN
    UPDATE fleet_paypal_provider_orders SET paypal_order_id = p_paypal_order, approval_url = p_approval_url, state = 'closed',
           payee_merchant_id = CASE WHEN p_payee ~ ${PAYPAL_ID} THEN p_payee END WHERE provider_order_id = p.provider_order_id;
    PERFORM fleet_paypal_order_event(p.provider_order_id, 'created', 201, NULL, NULL, p_debug, jsonb_build_object('checkout', c.status));
    RETURN jsonb_build_object('ok', true, 'state', 'closed');
  END IF;
  UPDATE fleet_paypal_provider_orders SET paypal_order_id = p_paypal_order, approval_url = p_approval_url, state = 'open', opened_at = now(), confirmed_at = now(),
         payee_merchant_id = CASE WHEN p_payee ~ ${PAYPAL_ID} THEN p_payee END, next_read_at = NULL
   WHERE provider_order_id = p.provider_order_id;
  PERFORM fleet_paypal_order_event(p.provider_order_id, 'created', 201, NULL, NULL, p_debug, jsonb_build_object('attempt', p.attempt));
  v_old := c.paypal_order_id;
  IF c.status = 'requested' THEN
    UPDATE fleet_paypal_checkouts SET status = 'open', paypal_order_id = p_paypal_order, approval_url = p_approval_url, opened_at = now() WHERE checkout_id = c.checkout_id;
    PERFORM fleet_event('paypal_checkout_opened', c.agent_id, 'custody', jsonb_build_object('checkoutId', c.checkout_id));
  ELSE
    UPDATE fleet_paypal_checkouts SET paypal_order_id = p_paypal_order, approval_url = p_approval_url, status_checks = 0, next_status_check = NULL, last_status_seen = NULL
     WHERE checkout_id = c.checkout_id;
    PERFORM fleet_event('paypal_order_replaced', c.agent_id, 'custody', jsonb_build_object('checkoutId', c.checkout_id, 'attempt', p.attempt, 'previous', v_old,
      'note', 'a fresh PayPal order for the same checkout; the previous one stays recorded and watched'));
  END IF;
  UPDATE fleet_paypal_checkouts SET pay_served_at = clock_timestamp(), pay_failure = NULL, pay_failure_ref = NULL WHERE checkout_id = c.checkout_id AND pay_requested_at IS NOT NULL;
  RETURN jsonb_build_object('ok', true, 'state', 'open');
END $$;

-- Everything else PayPal answered about a provider order: a creation it refused (definite) or did not answer (indefinite),
-- a read (status, or error with its debug id), a refused capture, an audit. Reads move state only on PayPal's own statuses.
CREATE FUNCTION cx_paypal_order_note(p_worker text, p_order uuid, p_kind text, p_http integer, p_status text, p_name text, p_debug text, p_detail jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_paypal_provider_orders; c fleet_paypal_checkouts; v_action text := 'none'; v_page boolean; v_last text;
BEGIN
  ${WORKER}
  IF p_kind NOT IN ('create_failed','create_indefinite','read','capture_failed','audit') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  IF p_status IS NOT NULL AND p_status !~ '^[A-Z_]{2,40}$' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  SELECT * INTO p FROM fleet_paypal_provider_orders WHERE provider_order_id = p_order FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  SELECT * INTO c FROM fleet_paypal_checkouts WHERE checkout_id = p.checkout_id FOR UPDATE;
  v_page := EXISTS (SELECT 1 FROM fleet_customer_orders o WHERE o.checkout_id = c.checkout_id AND o.access_token IS NOT NULL);

  IF p_kind = 'create_indefinite' THEN
    PERFORM fleet_paypal_order_event(p.provider_order_id, 'create_indefinite', p_http, NULL, p_name, p_debug, p_detail);
    RETURN jsonb_build_object('ok', true);
  END IF;
  IF p_kind = 'create_failed' THEN
    IF p.state <> 'creating' THEN RETURN jsonb_build_object('ok', true, 'replay', true); END IF;
    UPDATE fleet_paypal_provider_orders SET state = 'create_failed' WHERE provider_order_id = p.provider_order_id;
    PERFORM fleet_paypal_order_event(p.provider_order_id, 'create_failed', p_http, NULL, p_name, p_debug, p_detail);
    IF c.status = 'requested' AND NOT v_page THEN
      UPDATE fleet_paypal_checkouts SET status = 'failed', failure_code = left('paypal_' || lower(COALESCE(p_name, 'http_' || p_http)), 64), closed_at = now()
       WHERE checkout_id = c.checkout_id;
      PERFORM fleet_event('paypal_checkout_failed', c.agent_id, 'custody', jsonb_build_object('checkoutId', c.checkout_id, 'failure', lower(COALESCE(p_name, 'http_' || p_http))));
    ELSE
      UPDATE fleet_paypal_checkouts SET pay_served_at = clock_timestamp(), pay_failure = left('paypal_' || lower(COALESCE(p_name, 'http_' || p_http)), 64),
             pay_failure_ref = CASE WHEN p_debug ~ ${DEBUG_ID} THEN p_debug END WHERE checkout_id = c.checkout_id;
    END IF;
    RETURN jsonb_build_object('ok', true);
  END IF;
  IF p_kind = 'capture_failed' THEN
    PERFORM fleet_paypal_order_event(p.provider_order_id, 'capture_failed', p_http, p_status, p_name, p_debug, p_detail);
    IF p_name = 'DUPLICATE_INVOICE_ID' THEN
      PERFORM fleet_paypal_recon_add('duplicate_invoice', c.checkout_id, p.provider_order_id, p.paypal_order_id, c.amount_minor, c.currency,
        jsonb_build_object('note', 'PayPal refused to capture this order because a payment with the checkout''s invoice id already exists: find that payment before anything else'));
    END IF;
    RETURN jsonb_build_object('ok', true);
  END IF;

  -- A read (or an audit read).
  SELECT e.provider_status || '|' || COALESCE(e.http_status::text, '') || '|' || COALESCE(e.error_name, '') INTO v_last
    FROM fleet_paypal_provider_order_events e WHERE e.provider_order_id = p.provider_order_id AND e.kind IN ('read','audit') ORDER BY e.at DESC, e.event_id DESC LIMIT 1;
  IF p_kind = 'audit' OR p_debug IS NOT NULL OR v_last IS DISTINCT FROM (p_status || '|' || COALESCE(p_http::text, '') || '|' || COALESCE(p_name, ''))
     OR COALESCE((p_detail ->> 'payCheck')::boolean, false) THEN
    PERFORM fleet_paypal_order_event(p.provider_order_id, p_kind, p_http, p_status, p_name, p_debug, p_detail);
  END IF;
  UPDATE fleet_paypal_provider_orders SET reads = reads + 1, last_read_at = now(), last_status_seen = COALESCE(p_status, last_status_seen),
         next_read_at = CASE WHEN state = 'retired' THEN now() + CASE WHEN retired_at > now() - interval '1 day' THEN interval '10 minutes' ELSE interval '6 hours' END
                             WHEN state = 'closed' THEN now() + interval '6 hours'
                             WHEN state = 'captured' THEN now() + CASE WHEN COALESCE(opened_at, created_at) > now() - interval '30 days' THEN interval '1 day' ELSE interval '7 days' END
                             ELSE next_read_at END
   WHERE provider_order_id = p.provider_order_id RETURNING * INTO p;

  IF p.state IN ('retired','create_unknown') AND p_status IN ('APPROVED','COMPLETED') THEN
    -- Late evidence on an order the Fleet no longer offers: never captured automatically; reconciled and alerted.
    PERFORM fleet_paypal_order_event(p.provider_order_id, CASE WHEN p_status = 'APPROVED' THEN 'late_approval' ELSE 'late_capture' END, p_http, p_status, NULL, p_debug, p_detail);
    PERFORM fleet_paypal_recon_add(CASE WHEN p_status = 'APPROVED' THEN 'late_approval' ELSE 'late_capture' END, c.checkout_id, p.provider_order_id,
      COALESCE(p.paypal_order_id, p.request_id), c.amount_minor, c.currency,
      jsonb_build_object('checkoutStatus', c.status, 'retireReason', p.retire_reason, 'source', COALESCE(p_detail ->> 'source', 'read'),
        'note', CASE WHEN p_status = 'APPROVED' THEN 'a buyer approved a PayPal order the Fleet had retired: it is not captured automatically (it lapses uncaptured); decide with the buyer'
                     ELSE 'PayPal reports money taken on a retired order: booked to the checkout only if it had no capture yet; otherwise held as a duplicate for refund under refund authority' END));
    RETURN jsonb_build_object('ok', true, 'action', CASE WHEN p_status = 'COMPLETED' THEN 'record_capture' ELSE 'none' END, 'late', true);
  END IF;
  IF p.state = 'open' AND p_status IN ('CREATED','PAYER_ACTION_REQUIRED','SAVED') THEN
    UPDATE fleet_paypal_provider_orders SET confirmed_at = now() WHERE provider_order_id = p.provider_order_id;
    IF c.paypal_order_id = p.paypal_order_id AND fleet_paypal_pay_pending(c) THEN
      UPDATE fleet_paypal_checkouts SET pay_served_at = clock_timestamp() WHERE checkout_id = c.checkout_id;
    END IF;
    v_action := 'reuse';
  ELSIF p.state IN ('open','approved') AND p_status = 'APPROVED' AND c.paypal_order_id = p.paypal_order_id THEN
    IF c.status = 'open' THEN
      UPDATE fleet_paypal_checkouts SET status = 'approved', approved_at = now() WHERE checkout_id = c.checkout_id;
    END IF;
    v_action := 'capture';
  ELSIF p.state IN ('open','approved','captured','closed') AND p_status = 'COMPLETED' THEN
    v_action := 'record_capture';
  ELSIF p.state = 'open' AND p_status = 'VOIDED' THEN
    UPDATE fleet_paypal_provider_orders SET state = 'retired', retired_at = now(), retire_reason = 'voided',
           retire_evidence = jsonb_build_object('http', p_http, 'status', 'VOIDED', 'debugId', p_debug), next_read_at = now() + interval '10 minutes'
     WHERE provider_order_id = p.provider_order_id;
    PERFORM fleet_paypal_order_event(p.provider_order_id, 'retired', p_http, 'VOIDED', NULL, p_debug, jsonb_build_object('reason', 'voided'));
    PERFORM fleet_event('paypal_order_retired', c.agent_id, 'custody', jsonb_build_object('checkoutId', c.checkout_id, 'paypalOrderId', p.paypal_order_id, 'reason', 'voided'));
    -- Without a buyer waiting to pay, a voided order still fails its checkout (v76).
    IF NOT fleet_paypal_pay_pending(c) AND c.status = 'open' AND NOT v_page THEN
      UPDATE fleet_paypal_checkouts SET status = 'failed', failure_code = 'paypal_order_voided', closed_at = now() WHERE checkout_id = c.checkout_id;
      PERFORM fleet_event('paypal_checkout_failed', c.agent_id, 'custody', jsonb_build_object('checkoutId', c.checkout_id, 'failure', 'paypal_order_voided'));
    END IF;
    v_action := 'replace';
  END IF;
  RETURN jsonb_build_object('ok', true, 'action', v_action, 'state', p.state);
END $$;

-- Retire a provider order PayPal no longer has, on verified evidence only (see the header). Never when anything suggests
-- approval or payment. An unverifiable not-found retires nothing: it is reconciled and the buyer is told to try later.
CREATE FUNCTION cx_paypal_order_retire(p_worker text, p_order uuid, p_evidence jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_paypal_provider_orders; c fleet_paypal_checkouts; x fleet_payment_rails; k fleet_credential_refs; n integer; v_why text;
BEGIN
  ${WORKER}
  IF jsonb_typeof(p_evidence) <> 'object' OR length(p_evidence::text) > 1500 THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  SELECT * INTO p FROM fleet_paypal_provider_orders WHERE provider_order_id = p_order FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF p.state = 'retired' THEN RETURN jsonb_build_object('ok', true, 'replay', true); END IF;
  SELECT * INTO c FROM fleet_paypal_checkouts WHERE checkout_id = p.checkout_id FOR UPDATE;
  SELECT * INTO x FROM fleet_payment_rails WHERE rail_id = c.rail_id;
  SELECT * INTO k FROM fleet_credential_refs WHERE credential_id = p.credential_id;
  SELECT count(DISTINCT debug_id) INTO n FROM fleet_paypal_provider_order_events
   WHERE provider_order_id = p.provider_order_id AND kind = 'read' AND http_status = 404 AND error_name = 'RESOURCE_NOT_FOUND' AND debug_id IS NOT NULL AND at > now() - interval '10 minutes';
  v_why := CASE
    WHEN p.state <> 'open' THEN 'the order is ' || p.state
    WHEN c.capture_id IS NOT NULL OR c.status NOT IN ('requested','open') THEN 'the checkout is ' || c.status
    WHEN p.last_status_seen IN ('APPROVED','COMPLETED') OR EXISTS (SELECT 1 FROM fleet_paypal_provider_order_events e WHERE e.provider_order_id = p.provider_order_id
           AND (e.kind IN ('approved','captured','late_approval','late_capture') OR e.provider_status IN ('APPROVED','COMPLETED'))) THEN 'PayPal reported approval or payment for it'
    WHEN EXISTS (SELECT 1 FROM fleet_paypal_webhook_inbox w WHERE w.resource_id = p.paypal_order_id) THEN 'a webhook about it was received'
    WHEN n < ${PAYPAL_NOT_FOUND_READS} THEN 'fewer than ${PAYPAL_NOT_FOUND_READS} separate RESOURCE_NOT_FOUND answers (each with its own debug id) in the last 10 minutes'
    WHEN x.credential_id <> p.credential_id OR x.mode <> p.rail_mode OR k.status NOT IN ('active','rotating') OR k.created_at > p.created_at
      THEN 'the credential or environment that created it is no longer the rail''s'
    WHEN COALESCE((p_evidence #>> '{control,http}')::integer, 0) <> 200 OR NOT EXISTS (SELECT 1 FROM fleet_paypal_provider_orders z
           WHERE z.paypal_order_id = p_evidence #>> '{control,orderId}' AND z.state = 'captured' AND z.credential_id = p.credential_id AND z.rail_mode = p.rail_mode)
      THEN 'no successful control read of a captured order of the same credential and environment'
    ELSE NULL END;
  IF v_why IS NOT NULL THEN
    IF n >= ${PAYPAL_NOT_FOUND_READS} THEN
      PERFORM fleet_paypal_recon_add('not_found_unverifiable', c.checkout_id, p.provider_order_id, p.paypal_order_id, c.amount_minor, c.currency,
        jsonb_build_object('why', v_why, 'note', 'PayPal answers not found for this order but the Fleet cannot verify it; nothing was retired. The owner may retire it: fleet:admin economy-paypal-order-retire'));
      UPDATE fleet_paypal_checkouts SET pay_served_at = clock_timestamp(), pay_failure = 'paypal_order_unverifiable',
             pay_failure_ref = (SELECT e.debug_id FROM fleet_paypal_provider_order_events e WHERE e.provider_order_id = p.provider_order_id AND e.debug_id IS NOT NULL ORDER BY e.at DESC LIMIT 1)
       WHERE checkout_id = c.checkout_id AND fleet_paypal_pay_pending(c);
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_RETIRE_REFUSED', 'reason', v_why);
  END IF;
  UPDATE fleet_paypal_provider_orders SET state = 'retired', retired_at = now(), retire_reason = 'not_found_verified', next_read_at = now() + interval '10 minutes',
         retire_evidence = jsonb_build_object('notFoundAnswers', (SELECT jsonb_agg(jsonb_build_object('at', e.at, 'debugId', e.debug_id) ORDER BY e.at)
             FROM fleet_paypal_provider_order_events e WHERE e.provider_order_id = p.provider_order_id AND e.kind = 'read' AND e.http_status = 404 AND e.debug_id IS NOT NULL
              AND e.at > now() - interval '10 minutes'),
           'credentialId', p.credential_id, 'environment', p.rail_mode, 'control', p_evidence -> 'control')
   WHERE provider_order_id = p.provider_order_id;
  PERFORM fleet_paypal_order_event(p.provider_order_id, 'retired', 404, NULL, 'RESOURCE_NOT_FOUND', NULL, jsonb_build_object('reason', 'not_found_verified'));
  PERFORM fleet_event('paypal_order_retired', c.agent_id, 'custody', jsonb_build_object('checkoutId', c.checkout_id, 'paypalOrderId', p.paypal_order_id,
    'reason', 'not_found_verified', 'note', 'PayPal no longer has this order (verified); it stays recorded and watched for late approval or payment'));
  RETURN jsonb_build_object('ok', true);
END $$;

-- Provider orders to read again: retired and closed ones (late approval / payment) and captured ones (the audit of their captures
-- and refunds — the reconciliation that does not depend on Transaction Search).
CREATE FUNCTION cx_paypal_order_watch_work(p_worker text, p_limit integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r jsonb;
BEGIN
  ${WORKER}
  SELECT COALESCE(jsonb_agg(jsonb_build_object('providerOrderId', p.provider_order_id, 'paypalOrderId', p.paypal_order_id, 'state', p.state, 'checkoutId', c.checkout_id,
           'checkoutStatus', c.status, 'captureId', c.capture_id, 'amountMinor', c.amount_minor, 'currency', c.currency, 'railId', p.rail_id, 'railMode', p.rail_mode,
           'vaultRef', k.vault_ref, 'payee', p.payee_merchant_id) ORDER BY p.next_read_at), '[]'::jsonb) INTO r
    FROM (SELECT * FROM fleet_paypal_provider_orders z WHERE z.paypal_order_id IS NOT NULL AND z.next_read_at <= now()
            AND ((z.state = 'retired' AND z.retired_at > now() - interval '${PAYPAL_RETIRED_WATCH_DAYS} days')
              OR (z.state = 'closed' AND z.created_at > now() - interval '${PAYPAL_RETIRED_WATCH_DAYS} days')
              OR (z.state = 'captured' AND z.created_at > now() - interval '${PAYPAL_AUDIT_DAYS} days'))
          ORDER BY z.next_read_at LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50)) p
    JOIN fleet_paypal_checkouts c ON c.checkout_id = p.checkout_id JOIN fleet_credential_refs k ON k.credential_id = p.credential_id
   WHERE k.status IN ('active','rotating');
  RETURN r;
END $$;

-- What the audit (or a read) found that does not match the books, in PayPal's own terms.
CREATE FUNCTION cx_paypal_recon_report(p_worker text, p_order uuid, p_kind text, p_ref text, p_amount bigint, p_currency text, p_detail jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_paypal_provider_orders;
BEGIN
  ${WORKER}
  IF p_kind NOT IN ('audit_mismatch','mapping_mismatch') OR p_ref IS NULL OR p_ref !~ '^[A-Za-z0-9:-]{3,90}$' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  SELECT * INTO p FROM fleet_paypal_provider_orders WHERE provider_order_id = p_order;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  RETURN jsonb_build_object('ok', true, 'recorded', fleet_paypal_recon_add(p_kind, p.checkout_id, p.provider_order_id, p_ref, p_amount, p_currency, p_detail));
END $$;

-- The outcome of a reconciliation channel (Transaction Search, the order audit, the token's scopes): statuses and names only.
CREATE FUNCTION cx_paypal_sync_record(p_worker text, p_rail uuid, p_kind text, p_ok boolean, p_http integer, p_name text, p_debug text, p_detail jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  ${WORKER}
  IF p_kind NOT IN ('transaction_search','order_audit','token_scopes') OR NOT EXISTS (SELECT 1 FROM fleet_payment_rails WHERE rail_id = p_rail) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  INSERT INTO fleet_paypal_sync_status (rail_id, kind, last_attempt_at, last_http, last_error_name, last_debug_id, last_ok_at, detail)
    VALUES (p_rail, p_kind, now(), CASE WHEN p_http BETWEEN 100 AND 599 THEN p_http END, CASE WHEN p_name ~ '^[A-Z0-9_]{2,64}$' THEN p_name END,
            CASE WHEN p_debug ~ ${DEBUG_ID} THEN p_debug END, CASE WHEN p_ok THEN now() END,
            CASE WHEN jsonb_typeof(p_detail) = 'object' AND length(p_detail::text) <= 2000 THEN p_detail END)
    ON CONFLICT (rail_id, kind) DO UPDATE SET last_attempt_at = EXCLUDED.last_attempt_at, last_http = EXCLUDED.last_http, last_error_name = EXCLUDED.last_error_name,
      last_debug_id = EXCLUDED.last_debug_id, last_ok_at = COALESCE(EXCLUDED.last_ok_at, fleet_paypal_sync_status.last_ok_at),
      detail = COALESCE(EXCLUDED.detail, fleet_paypal_sync_status.detail);
  RETURN jsonb_build_object('ok', true);
END $$;

${WORK}

${STATUS_WORK}

${BY_ORDER}

${CAPTURE_RECORD}

-- ═══ 5. The owner: what needs reconciling, resolving it, retiring an order the Fleet could not verify ═══
CREATE FUNCTION fleet_admin_paypal_reconciliation(p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  ${OWNER_ACTOR}
  RETURN jsonb_build_object('ok', true,
    'items', COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('itemId', i.item_id, 'kind', i.kind, 'status', i.status, 'checkoutId', i.checkout_id,
               'paypalRef', i.paypal_ref, 'amountMinor', i.amount_minor, 'currency', i.currency, 'detail', i.detail, 'createdAt', i.created_at,
               'resolvedAt', i.resolved_at, 'resolution', i.resolution)) ORDER BY i.status, i.created_at DESC)
             FROM (SELECT * FROM fleet_paypal_reconciliation_items ORDER BY created_at DESC LIMIT 200) i), '[]'::jsonb),
    'sync', COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('railId', s.rail_id, 'kind', s.kind, 'lastAttemptAt', s.last_attempt_at, 'lastHttp', s.last_http,
               'lastErrorName', s.last_error_name, 'lastDebugId', s.last_debug_id, 'lastOkAt', s.last_ok_at, 'detail', s.detail)) ORDER BY s.kind) FROM fleet_paypal_sync_status s), '[]'::jsonb),
    'openCheckouts', COALESCE((SELECT jsonb_agg(jsonb_build_object('checkoutId', c.checkout_id, 'status', c.status, 'payableUntil', c.expires_at,
               'orders', (SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('attempt', p.attempt, 'paypalOrderId', p.paypal_order_id, 'state', p.state, 'createdAt', p.created_at,
                            'lastStatusSeen', p.last_status_seen, 'retireReason', p.retire_reason, 'lastDebugId', (SELECT e.debug_id FROM fleet_paypal_provider_order_events e
                              WHERE e.provider_order_id = p.provider_order_id AND e.debug_id IS NOT NULL ORDER BY e.at DESC LIMIT 1))) ORDER BY p.attempt)
                          FROM fleet_paypal_provider_orders p WHERE p.checkout_id = c.checkout_id)) ORDER BY c.created_at)
             FROM fleet_paypal_checkouts c WHERE c.status IN ('requested','open','approved','capture_pending')), '[]'::jsonb));
END $$;

CREATE FUNCTION fleet_admin_paypal_reconciliation_resolve(p_item uuid, p_resolution text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE i fleet_paypal_reconciliation_items;
BEGIN
  ${OWNER_ACTOR}
  IF p_resolution IS NULL OR length(trim(p_resolution)) < 3 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: say how it was resolved'; END IF;
  SELECT * INTO i FROM fleet_paypal_reconciliation_items WHERE item_id = p_item FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: reconciliation item'; END IF;
  IF i.status = 'resolved' THEN RETURN jsonb_build_object('ok', true, 'replay', true); END IF;
  UPDATE fleet_paypal_reconciliation_items SET status = 'resolved', resolved_at = now(), resolved_by = p_actor, resolution = left(fleet_scrub(trim(p_resolution)), 500)
   WHERE item_id = p_item;
  PERFORM fleet_event('paypal_reconciliation_resolved', NULL, p_actor, jsonb_build_object('itemId', p_item, 'kind', i.kind));
  RETURN jsonb_build_object('ok', true);
END $$;

-- The owner retires a provider order the Fleet could not verify (recorded with the reason; the same safety checks for approval
-- and payment as custody's retirement — only the not-found verification is the owner's).
CREATE FUNCTION fleet_admin_paypal_order_retire(p_paypal_order text, p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_paypal_provider_orders; c fleet_paypal_checkouts;
BEGIN
  ${OWNER_ACTOR}
  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a reason of at least 10 characters'; END IF;
  SELECT * INTO p FROM fleet_paypal_provider_orders WHERE paypal_order_id = p_paypal_order FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: a PayPal order the Fleet created'; END IF;
  IF p.state = 'retired' THEN RETURN jsonb_build_object('ok', true, 'replay', true); END IF;
  SELECT * INTO c FROM fleet_paypal_checkouts WHERE checkout_id = p.checkout_id FOR UPDATE;
  IF p.state <> 'open' OR c.capture_id IS NOT NULL OR c.status NOT IN ('requested','open') OR p.last_status_seen IN ('APPROVED','COMPLETED')
     OR EXISTS (SELECT 1 FROM fleet_paypal_provider_order_events e WHERE e.provider_order_id = p.provider_order_id
                  AND (e.kind IN ('approved','captured','late_approval','late_capture') OR e.provider_status IN ('APPROVED','COMPLETED')))
     OR EXISTS (SELECT 1 FROM fleet_paypal_webhook_inbox w WHERE w.resource_id = p.paypal_order_id) THEN
    RAISE EXCEPTION 'FLEET_RETIRE_REFUSED: PayPal evidence suggests approval or payment, or the checkout is no longer open';
  END IF;
  UPDATE fleet_paypal_provider_orders SET state = 'retired', retired_at = now(), retire_reason = 'owner', next_read_at = now() + interval '10 minutes',
         retire_evidence = jsonb_build_object('actor', p_actor, 'reason', left(fleet_scrub(trim(p_reason)), 300)) WHERE provider_order_id = p.provider_order_id;
  PERFORM fleet_paypal_order_event(p.provider_order_id, 'retired', NULL, NULL, NULL, NULL, jsonb_build_object('reason', 'owner'));
  UPDATE fleet_paypal_checkouts SET pay_failure = NULL, pay_failure_ref = NULL WHERE checkout_id = c.checkout_id;
  PERFORM fleet_event('paypal_order_retired', c.agent_id, p_actor, jsonb_build_object('checkoutId', c.checkout_id, 'paypalOrderId', p.paypal_order_id, 'reason', 'owner'));
  RETURN jsonb_build_object('ok', true);
END $$;

${EVENT_ROUTE}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

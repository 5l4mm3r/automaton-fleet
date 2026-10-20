/**
 * Schema v108 — the launch completion package (owner, 2026-10-20).
 *
 * 1. SUPPORTED CUSTOMER GEOGRAPHY (owner policy, playbook decisions / Field Guide v2: "Worldwide"; "EU consumer digital
 *    sales go through a merchant-of-record marketplace"; 2026-10-19: "Explain and enforce the supported customer geography").
 *    `fleet_sales_geography` is the owner's list of countries the treasury checkout does not sell to — seeded with the EU-27
 *    (no merchant of record is connected); the owner changes it (`fleet_admin_sales_geography`). The buyer states their country
 *    before paying (`svc_order_country`, on the offer page and on the order page); `svc_order_pay` refuses an order without a
 *    stated country or with a listed one, before any payment. After payment, a PayPal payer country that is listed, or that
 *    differs from the stated one, HOLDS delivery (automatic and `order.deliver`) and tells the agent and the owner
 *    (`order_needs_attention`): the agent refunds within its refund authority, or the owner decides.
 * 2. ORDER CONVERSATIONS CLOSE (owner, 2026-10-20: "the ai needs to log off after customer satisfaction is met so it doesnt
 *    double down as a free ai chat!"; chosen: "Refund or 7 days"): an order's conversation is closed to new buyer messages at
 *    a full refund, 7 days after the agent resolved the buyer's request (a sent delivery or a resolving reply) with nothing new
 *    since, or at 10 buyer messages in all. Requests already made stay owed (obligations unchanged). The closed page keeps the
 *    receipt and downloads and names the support address.
 * 3. CUSTOMER EMAIL (owner, 2026-10-19: buyers see the shared address and "<agent name> - …"; 2026-10-20: the conversation
 *    should be by email): a buyer's emailed reply to an order mail (its message, delivery or confirmation thread) — or, from
 *    the buyer's own address, mail routed to the agent of exactly one open order of that buyer — joins the order's thread as a
 *    buyer message (the same obligation, wake and limits as one sent on the page; quoted history removed). Only from the
 *    order's buyer address; never for a closed conversation.
 * 4. A PRODUCT IS SOLD PUBLICLY ONLY WITH ITS SPREADSHEETS' VALUES SAVED (owner, 2026-10-20: "resolve the saved-formula-values
 *    issue before selling that workbook publicly"): `fleet_offer_sale_block` also requires each delivered spreadsheet's
 *    cached_values check to pass (formulas saved with their values: previewers, phones and mail clients show them).
 */
import { V41_SQL } from "./migrations-phase41.js";
import { V76_SQL } from "./migrations-phase76.js";
import { V82_SQL } from "./migrations-phase82.js";
import { V96_SQL } from "./migrations-phase96.js";
import { V97_SQL } from "./migrations-phase97.js";
import { V98_SQL } from "./migrations-phase98.js";
import { V99_SQL } from "./migrations-phase99.js";
import { V106_SQL } from "./migrations-phase106.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));
const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

/** The EU-27: consumer digital sales need a merchant of record (none connected). */
export const EU_27 = ["AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK"] as const;
export const ORDER_CONVERSATION_DAYS = 7;
export const ORDER_BUYER_MESSAGES_MAX = 10;
export const SUPPORT_ADDRESS = "fleet.treasury@proton.me";

const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');`;

// ── 1. geography ──
const PAY = restate(V98_SQL, "svc_order_pay", [
  [`    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CONSENT_REQUIRED');
  END IF;`, `    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CONSENT_REQUIRED');
  END IF;
  -- v108: the buyer's country first (the owner's supported geography), before any payment.
  IF x.buyer_stated_country IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COUNTRY_REQUIRED'); END IF;
  IF fleet_country_unsupported(x.buyer_stated_country) THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COUNTRY_UNSUPPORTED'); END IF;`],
]);
const TICK = restate(V82_SQL, "svc_offer_tick", [
  [`    IF v_rev.review_id IS NULL OR v_rev.verdict <> 'pass' OR v_rev.files_digest <> fleet_files_digest(fleet_offer_deliverables(o.offer_id))`,
   `    -- v108: a payer country outside the supported geography, or not the one the buyer stated, holds delivery.
    IF fleet_order_country_hold(x) IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM fleet_events WHERE event_type = 'order_needs_attention' AND detail ->> 'orderId' = x.order_id::text AND detail ? 'countryHold') THEN
        PERFORM fleet_event('order_needs_attention', x.agent_id, 'controller', jsonb_build_object('orderId', x.order_id, 'offerId', o.offer_id, 'countryHold', fleet_order_country_hold(x),
          'note', 'delivery held: ' || fleet_order_country_hold(x) || ' — refund the buyer (wallet refund) or ask the owner'));
      END IF;
      nb := nb + 1;
      CONTINUE;
    END IF;
    IF v_rev.review_id IS NULL OR v_rev.verdict <> 'pass' OR v_rev.files_digest <> fleet_files_digest(fleet_offer_deliverables(o.offer_id))`],
]);
const DELIVER = restate(V97_SQL, "fleet_econ_order_deliver", [
  [`    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ORDER_NOT_PAID', 'payment', o.payment_status, 'reason', 'deliver only what PayPal shows paid (and not refunded)');
  END IF;`, `    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ORDER_NOT_PAID', 'payment', o.payment_status, 'reason', 'deliver only what PayPal shows paid (and not refunded)');
  END IF;
  IF fleet_order_country_hold(o) IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COUNTRY_HOLD', 'reason', 'delivery is held: ' || fleet_order_country_hold(o) || ' — refund the buyer (wallet refund) or ask the owner');
  END IF;`],
]);

// ── 2 + 1. the order page shows the conversation's state and the stated country ──
const ORDER_PAGE = restate(V99_SQL, "svc_order_page", [
  [`'kind', x.fulfilment, 'payment', x.payment_status,`,
   `'kind', x.fulfilment, 'payment', x.payment_status, 'conversation', fleet_order_conversation(x),
      'country', jsonb_build_object('stated', x.buyer_stated_country, 'unsupported', (SELECT to_jsonb(g.unsupported) FROM fleet_sales_geography g WHERE g.id = 1)),`],
]);
const MESSAGE = restate(V76_SQL, "svc_customer_message", [
  [`    v_agent := x.agent_id;
  ELSE RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');`,
   `    v_agent := x.agent_id;
    -- v108: a closed conversation takes no new messages (the receipt and downloads stay; the support address is named).
    IF NOT (fleet_order_conversation(x) ->> 'open')::boolean THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ORDER_CLOSED', 'reason', fleet_order_conversation(x) ->> 'note');
    END IF;
  ELSE RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');`],
]);

// ── 3. emailed replies join the order's thread ──
const STORE_IN = restate(V41_SQL, "fleet_mail_store_in", [
  [`  RETURN jsonb_build_object('messageId', v_id, 'agentId', p_agent, 'routing', p_routing, 'address', v_addr);`,
   `  IF p_agent IS NOT NULL AND NOT COALESCE(p_withheld, false) THEN PERFORM fleet_mail_to_order(v_id); END IF;
  RETURN jsonb_build_object('messageId', v_id, 'agentId', p_agent, 'routing', p_routing, 'address', v_addr);`],
]);

const EVENT_ROUTE = restate(V106_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", `    WHEN p_type = 'sales_geography_set' THEN 'P2_IMPORTANT'\n    WHEN p_type = 'spend_circuit_breaker_set' THEN`],
]);

// ── 4. spreadsheets' values saved before public sale ──
const SALE_BLOCK = restate(V96_SQL, "fleet_offer_sale_block", [
  [`    WHEN r.inspector NOT IN (`, `    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.automated -> 'files') = 'array' THEN r.automated -> 'files' ELSE '[]'::jsonb END) f,
                       jsonb_array_elements(CASE WHEN jsonb_typeof(f -> 'checks') = 'array' THEN f -> 'checks' ELSE '[]'::jsonb END) k
                 WHERE k ->> 'id' = 'cached_values' AND k ->> 'status' <> 'pass')
      THEN 'a spreadsheet in it saves formulas without their values (previewers, phones and mail clients show those cells blank or wrong): save the computed values (recalculate and save it with the office application, or pass value= to XlsxWriter''s write_formula), inspect again, review and publish with that review'
    WHEN r.inspector NOT IN (`],
]);

export const V108_SQL = `
-- ═══ 1. Supported customer geography ═══
CREATE TABLE fleet_sales_geography (
  id          integer     PRIMARY KEY CHECK (id = 1),
  unsupported text[]      NOT NULL CHECK (array_to_string(unsupported, ',') ~ '^([A-Z]{2}(,[A-Z]{2})*)?$'),
  reason      text        NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  set_by      text        NOT NULL,
  set_at      timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fleet_sales_geography (id, unsupported, reason, set_by) VALUES (1, ARRAY[${q(EU_27)}],
  'owner policy (playbook decisions, Field Guide v2): worldwide; EU consumer digital sales only through a merchant of record — none is connected, so the treasury checkout does not sell to the EU-27',
  'migration:v108');
ALTER TABLE fleet_customer_orders ADD COLUMN buyer_stated_country text CHECK (buyer_stated_country ~ '^[A-Z]{2}$'), ADD COLUMN country_stated_at timestamptz;

CREATE FUNCTION fleet_country_unsupported(p text) RETURNS boolean LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT p IS NULL OR p !~ '^[A-Z]{2}$' OR EXISTS (SELECT 1 FROM fleet_sales_geography g WHERE g.id = 1 AND p = ANY (g.unsupported))
$$;

-- Why delivery of a paid order is held for its buyer's country (NULL: it is not). Orders made before v108 state no country.
CREATE FUNCTION fleet_order_country_hold(o fleet_customer_orders) RETURNS text LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT CASE
    WHEN o.buyer_country IS NOT NULL AND fleet_country_unsupported(o.buyer_country)
      THEN 'PayPal shows the buyer in ' || o.buyer_country || ', where the treasury checkout does not sell (the owner''s supported geography)'
    WHEN o.buyer_country IS NOT NULL AND o.buyer_stated_country IS NOT NULL AND o.buyer_country <> o.buyer_stated_country
      THEN 'the buyer stated ' || o.buyer_stated_country || ' but PayPal shows ' || o.buyer_country
  END
$$;

-- The buyer states their country before paying (offer page or order page). Refused when the treasury checkout does not sell there.
CREATE FUNCTION svc_order_country(p_token text, p_origin text, p_country text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_customer_orders; v text := upper(btrim(COALESCE(p_country, '')));
BEGIN
  SELECT * INTO x FROM fleet_customer_orders WHERE access_token = p_token FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF v !~ '^[A-Z]{2}$' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'choose your country'); END IF;
  IF x.payment_status <> 'awaiting_payment' THEN RETURN jsonb_build_object('ok', true, 'stated', x.buyer_stated_country, 'unchanged', true); END IF;
  IF fleet_country_unsupported(v) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COUNTRY_UNSUPPORTED', 'country', v,
      'reason', 'this shop cannot sell digital products to buyers in ' || v || ' yet');
  END IF;
  UPDATE fleet_customer_orders SET buyer_stated_country = v, country_stated_at = now() WHERE order_id = x.order_id;
  RETURN jsonb_build_object('ok', true, 'stated', v);
END $$;

CREATE FUNCTION fleet_admin_sales_geography(p_unsupported text[], p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE g fleet_sales_geography; v text[];
BEGIN
  ${OWNER_ACTOR}
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a reason is required'; END IF;
  SELECT COALESCE(array_agg(DISTINCT upper(btrim(c)) ORDER BY upper(btrim(c))), '{}') INTO v FROM unnest(COALESCE(p_unsupported, '{}')) c WHERE btrim(c) <> '';
  IF EXISTS (SELECT 1 FROM unnest(v) c WHERE c !~ '^[A-Z]{2}$') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: ISO 3166 two-letter country codes'; END IF;
  UPDATE fleet_sales_geography SET unsupported = v, reason = left(fleet_scrub(p_reason), 500), set_by = p_actor, set_at = now() WHERE id = 1 RETURNING * INTO g;
  PERFORM fleet_event('sales_geography_set', NULL, p_actor, jsonb_build_object('unsupported', to_jsonb(g.unsupported), 'reason', g.reason));
  RETURN jsonb_build_object('ok', true, 'unsupported', to_jsonb(g.unsupported), 'setAt', g.set_at);
END $$;

${PAY}

${TICK}

${DELIVER}

-- ═══ 2. Order conversations close ═══
CREATE FUNCTION fleet_order_conversation(o fleet_customer_orders) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  WITH b AS (SELECT count(*) AS n, max(created_at) AS last FROM fleet_customer_messages WHERE order_id = o.order_id AND author = 'buyer'),
       r AS (SELECT GREATEST((SELECT max(d.created_at) FROM fleet_order_deliveries d WHERE d.order_id = o.order_id AND d.status = 'sent'),
                             (SELECT max(m.created_at) FROM fleet_customer_messages m WHERE m.order_id = o.order_id AND m.author = 'agent' AND m.resolves)) AS at),
       s AS (SELECT CASE
                WHEN o.payment_status = 'refunded' THEN 'refunded'
                WHEN b.n >= ${ORDER_BUYER_MESSAGES_MAX} THEN 'message_limit'
                WHEN r.at IS NOT NULL AND (b.last IS NULL OR b.last <= r.at) AND r.at < now() - interval '${ORDER_CONVERSATION_DAYS} days' THEN 'resolved'
              END AS reason, b.n, r.at FROM b, r)
  SELECT jsonb_strip_nulls(jsonb_build_object('open', s.reason IS NULL, 'reason', s.reason, 'buyerMessages', s.n, 'buyerMessagesMax', ${ORDER_BUYER_MESSAGES_MAX},
    'closesAt', CASE WHEN s.reason IS NULL AND s.at IS NOT NULL THEN s.at + interval '${ORDER_CONVERSATION_DAYS} days' END,
    'support', '${SUPPORT_ADDRESS}',
    'note', CASE s.reason
      WHEN 'refunded' THEN 'this order was refunded and its conversation is closed'
      WHEN 'message_limit' THEN 'this order''s conversation has reached its message limit'
      WHEN 'resolved' THEN 'this order was completed more than ${ORDER_CONVERSATION_DAYS} days ago and its conversation is closed' END
      || CASE WHEN s.reason IS NOT NULL THEN ': for anything else write to ${SUPPORT_ADDRESS}' END)) FROM s
$$;

${ORDER_PAGE}

${MESSAGE}

-- ═══ 3. A buyer's emailed reply joins the order ═══
-- The text the buyer wrote, without the quoted history ("On … wrote:", "> …", the original message).
CREATE FUNCTION fleet_mail_reply_text(p text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT btrim(regexp_replace(split_part(split_part(COALESCE(p, ''), E'\\n-----Original Message-----', 1), E'\\n________________________________', 1),
    E'\\n(On [^\\n]{0,250} wrote:|Le [^\\n]{0,250} a écrit :|Am [^\\n]{0,250} schrieb [^\\n]{0,200}:|>[^\\n]*).*$', ''), E' \\n\\r\\t')
$$;

CREATE FUNCTION fleet_mail_to_order(p_mail uuid) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE mm fleet_agent_mail; v_order uuid; o fleet_customer_orders; v_body text; m fleet_customer_messages;
BEGIN
  SELECT * INTO mm FROM fleet_agent_mail WHERE message_id = p_mail;
  IF mm.message_id IS NULL OR mm.direction <> 'in' OR mm.agent_id IS NULL OR mm.withheld OR mm.sender_address IS NULL THEN RETURN; END IF;
  -- The order of the conversation this mail continues: an order message, delivery or confirmation in the same thread.
  IF mm.routing = 'thread' THEN
    SELECT x.order_id INTO v_order FROM fleet_agent_mail t,
      LATERAL (SELECT c.order_id FROM fleet_customer_messages c WHERE c.mail_message_id = t.message_id AND c.order_id IS NOT NULL
               UNION ALL SELECT d.order_id FROM fleet_order_deliveries d WHERE d.message_id = t.message_id
               UNION ALL SELECT z.order_id FROM fleet_customer_orders z WHERE z.confirmation_message_id = t.message_id) x
     WHERE t.thread_id = mm.thread_id AND t.message_id <> mm.message_id AND t.agent_id = mm.agent_id LIMIT 1;
  END IF;
  -- Otherwise: the agent's only open order from this buyer address.
  IF v_order IS NULL THEN
    SELECT CASE WHEN count(*) = 1 THEN (array_agg(z.order_id))[1] END INTO v_order FROM fleet_customer_orders z
     WHERE z.agent_id = mm.agent_id AND lower(z.buyer_email) = lower(mm.sender_address) AND z.payment_status IN ('paid','partially_refunded')
       AND (fleet_order_conversation(z) ->> 'open')::boolean;
  END IF;
  IF v_order IS NULL THEN RETURN; END IF;
  SELECT * INTO o FROM fleet_customer_orders WHERE order_id = v_order;
  IF lower(COALESCE(o.buyer_email, '')) <> lower(mm.sender_address) OR o.agent_id <> mm.agent_id THEN RETURN; END IF;   -- only the buyer's own address
  IF NOT (fleet_order_conversation(o) ->> 'open')::boolean THEN RETURN; END IF;
  IF (SELECT count(*) FROM fleet_customer_messages WHERE author = 'buyer' AND order_id = o.order_id AND created_at > now() - interval '1 day') >= 20 THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM fleet_customer_messages WHERE mail_message_id = mm.message_id) THEN RETURN; END IF;
  v_body := left(fleet_mail_reply_text(mm.body), 8000);
  IF length(btrim(COALESCE(v_body, ''))) < 1 THEN RETURN; END IF;
  INSERT INTO fleet_customer_messages (agent_id, order_id, author, body, mail_message_id) VALUES (o.agent_id, o.order_id, 'buyer', v_body, mm.message_id) RETURNING * INTO m;
  PERFORM fleet_event('customer_message_received', o.agent_id, 'buyer', jsonb_build_object('orderId', o.order_id, 'messageId', m.message_id, 'via', 'email'));
END $$;

${STORE_IN}

-- ═══ 4. Spreadsheets' values saved before public sale ═══
${SALE_BLOCK}

${EVENT_ROUTE}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

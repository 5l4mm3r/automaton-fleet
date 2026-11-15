/**
 * Schema v56 — the selling loop closed: customer orders, delivery, and truthful account creation.
 *
 *  1. Customer orders. Every checkout an agent opens is also an ORDER of that agent (fulfilment `digital_file` or
 *     `service`). Its payment state follows PayPal's evidence (captured → paid; refund / reversal → refunded); the buyer's
 *     contact (PayPal's payer e-mail, name, country) is recorded by custody after capture, from PayPal's own order record.
 *     Orders and buyer contacts are the responsible agent's private records: only its own `order.*` operations and the
 *     owner's dashboard read them; no event carries them; shared knowledge is scrubbed of e-mail addresses (v50).
 *  2. Delivery. A paid `digital_file` order is delivered by `order.deliver`: the agent's workspace file(s) are mailed to the
 *     buyer from the Fleet's shared mailbox (the identity broker's ordinary `mail.send` job, with attachments). The order is
 *     delivered only when the provider accepted the message; a failed send is retried by the reaper with back-off (five
 *     attempts), never twice in parallel, never after a refund. A `service` order is marked fulfilled only by the agent,
 *     with evidence (a sent message to the buyer, or a note of what was delivered) — payment alone never fulfils.
 *  3. Bodies carrying files. `storefront.file` and `order.deliver` carry a workspace file (base64); every other economy
 *     operation keeps the 32 kB argument limit.
 *  4. account.create needs a dedicated connector, which the identity broker publishes at start-up. None ships today, so it
 *     answers FLEET_NO_CONNECTOR at once and points to the working path (register_account + browser) instead of queuing a
 *     job that can only fail.
 *  5. Dashboard: orders (owner view) and the Gumroad storefront's sales and payouts with their settlement state.
 */
import { V11_SQL } from "./migrations-phase11.js";
import { V41_SQL } from "./migrations-phase41.js";
import { V48_SQL } from "./migrations-phase48.js";
import { V52_SQL, STOREFRONT_FILE_TYPES } from "./migrations-phase52.js";
import { V53_SQL } from "./migrations-phase53.js";
import { V54_SQL } from "./migrations-phase54.js";
import { V55_SQL } from "./migrations-phase55.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));
const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

export const ORDER_OPS = ["order.list", "order.deliver", "order.fulfil"] as const;
/** Operations whose arguments carry a workspace file (base64). */
export const FILE_CARRYING_OPS = ["storefront.file", "order.deliver"] as const;
export const ORDER_DELIVERY_MAX_BYTES = 15_000_000;
export const ORDER_DELIVERY_MAX_ATTEMPTS = 5;
export const EVENT_ROUTES_V56 = Object.freeze({
  P1_HIGH: ["paypal_reversal_seen"],
  P2_IMPORTANT: ["customer_order_paid", "order_delivery_gave_up"],
  P3_INFO: ["order_delivered", "order_fulfilled", "order_delivery_failed", "estate_late_money"],
} as const);
export const DASHBOARD_READ_OPS_V56 = ["customer_orders"] as const;

const WORKER = `IF p_worker IS NULL OR p_worker !~ '^[a-z0-9-]{3,40}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: worker name'; END IF;`;
const PAYPAL_ID = `'^[A-Z0-9]{5,40}$'`;

// ── api_economy: the order operations, the file-carrying argument limit, account.create through its connector check ──
const DISPATCH = restate(V54_SQL, "api_economy", [
  [`WHEN 'wallet.measure' THEN 'ledger.read'`, `${ORDER_OPS.map((o) => `WHEN '${o}' THEN 'planning'`).join(" ")} WHEN 'wallet.measure' THEN 'ledger.read'`],
  [`IF jsonb_typeof(a) <> 'object' OR length(a::text) > 32000 THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'arguments are a JSON object (<= 32 kB)'); END IF;`,
   `IF jsonb_typeof(a) <> 'object' OR length(a::text) > (CASE WHEN p_op IN (${q(FILE_CARRYING_OPS)}) THEN 21000000 ELSE 32000 END) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', CASE WHEN p_op IN (${q(FILE_CARRYING_OPS)}) THEN 'arguments are a JSON object (a file of at most 15 MB)' ELSE 'arguments are a JSON object (<= 32 kB)' END);
  END IF;`],
  [`      WHEN 'paypal.checkout' THEN fleet_econ_paypal_checkout(p_agent, a)`, `      WHEN 'paypal.checkout' THEN fleet_econ_paypal_checkout_order(p_agent, a)`],
  [`      WHEN 'account.create' THEN fleet_econ_account_create(p_agent, a)`, `      WHEN 'account.create' THEN fleet_econ_account_create_connected(p_agent, a)`],
  [`      WHEN 'wallet.measure' THEN jsonb_build_object('ok', true) || fleet_agent_wallet_measure(p_agent)`,
   `      WHEN 'wallet.measure' THEN jsonb_build_object('ok', true) || fleet_agent_wallet_measure(p_agent)
      WHEN 'order.list' THEN fleet_econ_order_list(p_agent, a)
      WHEN 'order.deliver' THEN fleet_econ_order_deliver(p_agent, a)
      WHEN 'order.fulfil' THEN fleet_econ_order_fulfil(p_agent, a)`],
]);

// ── The identity broker's job context: a delivery's attachments are listed (names and sizes; the bytes are fetched apart) ──
const JOB_CONTEXT = restate(V41_SQL, "ix_job_context", [
  [`'mailboxes', COALESCE(`, `'attachments', (SELECT jsonb_agg(jsonb_build_object('fileName', f.file_name, 'contentType', f.content_type, 'sizeBytes', f.size_bytes) ORDER BY f.file_no)
                  FROM fleet_order_deliveries d JOIN fleet_order_delivery_files f ON f.delivery_id = d.delivery_id
                 WHERE j.kind = 'mail.send' AND d.message_id::text = j.params ->> 'messageId' AND d.agent_id = j.agent_id),
    'mailboxes', COALESCE(`],
]);

// ── Refunds and reversals reach the order (payment state; an undelivered order is not delivered after a full refund) ──
const REFUND = restate(V53_SQL, "cx_paypal_refund_record", [
  [`  PERFORM fleet_event('paypal_clawback_posted', c.agent_id, 'custody',`,
   `  IF p_kind IN ('refund','reversal') THEN PERFORM fleet_order_refunded(c.checkout_id, p_kind, p_amount); END IF;
  PERFORM fleet_event('paypal_clawback_posted', c.agent_id, 'custody',`],
]);

// ── Transaction Search catches a refund the webhooks missed: PayPal's refunds of a checkout beyond what is recorded are posted
//    (the shortfall only, so a refund already posted from its webhook under another id is never posted twice); a reversal or
//    chargeback seen only there is raised for the owner (P1), not guessed. ──
const TXN = restate(V48_SQL, "cx_paypal_txn_record", [
  [`  RETURN jsonb_build_object('ok', true, 'checkoutId', t.checkout_id,
    'needsCapturePost', t.checkout_id IS NOT NULL AND t.status = 'S' AND t.amount_minor > 0 AND c.status <> 'captured');`,
   `  IF t.checkout_id IS NOT NULL AND t.status = 'S' AND t.amount_minor < 0 AND c.status = 'captured' AND c.purpose = 'agent_sale' THEN
    IF t.event_code = 'T1107' THEN
      v_short := COALESCE((SELECT -sum(x.amount_minor) FROM fleet_paypal_transactions x WHERE x.checkout_id = t.checkout_id AND x.status = 'S' AND x.event_code = 'T1107' AND x.amount_minor < 0), 0)
               - COALESCE((SELECT o.refunded_minor FROM fleet_customer_orders o WHERE o.checkout_id = t.checkout_id), 0);
      RETURN jsonb_build_object('ok', true, 'checkoutId', t.checkout_id, 'needsCapturePost', false,
        'refundShortfallMinor', GREATEST(LEAST(v_short, -t.amount_minor), 0), 'captureId', c.capture_id);
    ELSIF NOT EXISTS (SELECT 1 FROM fleet_events WHERE event_type = 'paypal_reversal_seen' AND detail ->> 'transactionId' = t.transaction_id) THEN
      PERFORM fleet_event('paypal_reversal_seen', c.agent_id, 'custody', jsonb_build_object('checkoutId', t.checkout_id, 'transactionId', t.transaction_id,
        'eventCode', t.event_code, 'amountMinor', t.amount_minor,
        'note', 'PayPal shows money taken back from this sale (reversal, chargeback or fee) that no webhook reported; review it in PayPal and record it'));
    END IF;
  END IF;
  RETURN jsonb_build_object('ok', true, 'checkoutId', t.checkout_id,
    'needsCapturePost', t.checkout_id IS NOT NULL AND t.status = 'S' AND t.amount_minor > 0 AND c.status <> 'captured');`],
  ["DECLARE t fleet_paypal_transactions; v_checkout uuid;", "DECLARE v_short bigint; t fleet_paypal_transactions; v_checkout uuid;"],
  [`  IF v_checkout IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fleet_paypal_checkouts WHERE checkout_id = v_checkout AND rail_id = p_rail) THEN v_checkout := NULL; END IF;`,
   `  IF v_checkout IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fleet_paypal_checkouts WHERE checkout_id = v_checkout AND rail_id = p_rail) THEN v_checkout := NULL; END IF;
  -- v56: a refund row may name only the capture it refunds (paypal_reference_id).
  IF v_checkout IS NULL AND (p_txn ->> 'referenceId') ~ '^[A-Z0-9]{5,40}$' THEN
    SELECT checkout_id INTO v_checkout FROM fleet_paypal_checkouts WHERE capture_id = p_txn ->> 'referenceId' AND rail_id = p_rail;
  END IF;`],
]);

// ── Estates and the newer money states: an estate is settled only once held PayPal money, pending captures and card holds
//    have resolved; the agent's payable is repaid from its cash first, and what it cannot repay is written off against the
//    treasury's advance; money reaching a settled estate later goes to the treasury. ──
const ESTATE_SETTLE = restate(V11_SQL, "fleet_estate_settle_internal", [
  ["DECLARE es fleet_estates; ag fleet_agents; v_cash bigint;", "DECLARE v_pay bigint; v_rp bigint := 0; v_pwo bigint := 0; es fleet_estates; ag fleet_agents; v_cash bigint;"],
  [`  PERFORM fleet_ledger_open_agent(p_agent, p_actor);
  v_cash := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_cash'));`,
   `  PERFORM fleet_ledger_open_agent(p_agent, p_actor);
  v_rp := fleet_estate_repay_payable(p_agent, p_actor, 'estate:payable:' || p_agent);
  v_cash := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_cash'));`],
  [`  UPDATE fleet_assets SET economic_owner_account = 'fleet:assets', authority_agent_id = NULL WHERE authority_agent_id = p_agent;
  s := jsonb_build_object('principalRecovered', v_rec, 'principalWrittenOff', v_wo, 'cashToTreasury', v_cash, 'assetsToTreasury', v_assets);`,
   `  UPDATE fleet_assets SET economic_owner_account = 'fleet:assets', authority_agent_id = NULL WHERE authority_agent_id = p_agent;
  v_pwo := fleet_estate_write_off_payable(p_agent, p_actor, 'estate:payable-writeoff:' || p_agent);
  s := jsonb_build_object('principalRecovered', v_rec, 'principalWrittenOff', v_wo, 'cashToTreasury', v_cash, 'assetsToTreasury', v_assets,
    'payableRepaid', v_rp, 'payableWrittenOff', v_pwo);`],
]);

const SETTLE_ESTATES = restate(V11_SQL, "svc_settle_estates", [
  ["DECLARE r record; n integer := 0;", "DECLARE r record; n integer := 0; v bigint; v_rp bigint; v_wo bigint; v_id text;"],
  [`            ORDER BY e.opened_at LIMIT`,
   `              -- v56: nothing of the agent's still held (PayPal money awaiting availability or capture, open card holds).
              AND NOT EXISTS (SELECT 1 FROM fleet_paypal_availability v WHERE v.agent_id = e.agent_id AND v.status = 'pending')
              AND NOT EXISTS (SELECT 1 FROM fleet_paypal_checkouts c WHERE c.agent_id = e.agent_id AND c.status = 'capture_pending')
              AND NOT EXISTS (SELECT 1 FROM fleet_card_charges h WHERE h.agent_id = e.agent_id AND h.status = 'held')
            ORDER BY e.opened_at LIMIT`],
  [`    PERFORM fleet_estate_settle_internal(r.agent_id, 'controller');
    n := n + 1;
  END LOOP;`,
   `    PERFORM fleet_estate_settle_internal(r.agent_id, 'controller');
    n := n + 1;
  END LOOP;
  -- v56: money that reached a settled estate later (a late receipt, a released hold) goes to the treasury; a payable that arose
  -- later (a refund after death) is repaid from it, and the rest written off.
  FOR r IN SELECT e.agent_id FROM fleet_estates e
            WHERE e.status = 'settled' AND (fleet_ledger_balance(fleet_ledger_account(e.agent_id, 'agent_cash')) > 0
                                            OR fleet_ledger_balance(fleet_ledger_account(e.agent_id, 'agent_provider_payable')) > 0)
            ORDER BY e.settled_at LIMIT 20 FOR UPDATE OF e SKIP LOCKED LOOP
    v_id := gen_random_uuid()::text;
    v_rp := fleet_estate_repay_payable(r.agent_id, 'controller', 'estate:payable:' || r.agent_id || ':late:' || v_id);
    v := fleet_ledger_balance(fleet_ledger_account(r.agent_id, 'agent_cash'));
    IF v > 0 THEN
      PERFORM fleet_ledger_post('estate_transfer', 'estate:transfer:' || r.agent_id || ':late:' || v_id, 'controller', 'estate: money that arrived after settlement, to the treasury',
        'owner', r.agent_id, NULL, NULL, NULL, NULL, now(), jsonb_build_array(
          jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', v),
          jsonb_build_object('account', fleet_ledger_account(r.agent_id, 'agent_cash'), 'side', 'C', 'amount', v)));
    END IF;
    v_wo := fleet_estate_write_off_payable(r.agent_id, 'controller', 'estate:payable-writeoff:' || r.agent_id || ':late:' || v_id);
    PERFORM fleet_event('estate_late_money', r.agent_id, 'controller', jsonb_build_object('cashToTreasury', GREATEST(v, 0), 'payableRepaid', v_rp, 'payableWrittenOff', v_wo));
  END LOOP;`],
]);

// ── Dashboard: the storefront's sales and payouts with their settlement state; customer orders ──
const STOREFRONT_JSON = restate(V52_SQL, "fleet_storefront_json", [
  [`    'sales', (SELECT count(*) FROM fleet_provider_sales), 'payouts', (SELECT count(*) FROM fleet_provider_payouts))`,
   `    'sales', (SELECT count(*) FROM fleet_provider_sales), 'payouts', (SELECT count(*) FROM fleet_provider_payouts),
    -- v56: the latest sales (memo: Gumroad delivers the files itself) and payouts with the evidence of their arrival.
    'recentSales', COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('saleId', s.sale_id, 'at', s.sale_at, 'currency', s.currency,
         'priceMinor', s.price_minor, 'feeMinor', s.fee_minor, 'agentId', fleet_provider_product_owner(s.account_id, s.product_id, s.sale_at),
         'product', (SELECT p.name FROM fleet_provider_products p WHERE p.account_id = s.account_id AND p.product_id = s.product_id ORDER BY p.created_at DESC LIMIT 1),
         'refunded', s.refunded, 'partiallyRefunded', s.partially_refunded, 'chargedback', s.chargedback, 'disputed', s.disputed,
         'fulfilment', 'delivered by Gumroad')) ORDER BY s.sale_at DESC)
       FROM (SELECT * FROM fleet_provider_sales x WHERE p_agent IS NULL OR fleet_provider_product_owner(x.account_id, x.product_id, x.sale_at) = p_agent
             ORDER BY x.sale_at DESC LIMIT 50) s), '[]'::jsonb),
    'recentPayouts', COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('payoutId', o.payout_id, 'status', o.status, 'amountMinor', o.amount_minor,
         'currency', o.currency, 'processedAt', o.processed_at, 'lines', o.line_count,
         'receipt', (SELECT jsonb_build_object('status', r.status, 'evidence', r.evidence_kind, 'bookedOn', r.booked_on)
                       FROM fleet_settlement_receipts r WHERE r.account_id = o.account_id AND r.payout_id = o.payout_id ORDER BY r.booked_on DESC LIMIT 1),
         'settlement', CASE WHEN EXISTS (SELECT 1 FROM fleet_settlement_receipts r WHERE r.account_id = o.account_id AND r.payout_id = o.payout_id AND r.status IN ('posted','transferred'))
                            THEN 'received: credited to the agents' WHEN o.status = 'completed' THEN 'sent by Gumroad: awaiting evidence of arrival'
                            ELSE 'not yet paid out' END)) ORDER BY COALESCE(o.processed_at, o.reported_at) DESC)
       FROM (SELECT * FROM fleet_provider_payouts ORDER BY COALESCE(processed_at, reported_at) DESC LIMIT 20) o), '[]'::jsonb))`],
]);

const DASH_CALL = restate(V55_SQL, "dash_call", [
  [`,${q(["survival_protection"])})) THEN`, `,${q(["survival_protection"])},${q(DASHBOARD_READ_OPS_V56)})) THEN`],
  [`      WHEN 'survival_protection' THEN fleet_survival_protection_json()`,
   `      WHEN 'survival_protection' THEN fleet_survival_protection_json()
      WHEN 'customer_orders' THEN fleet_customer_orders_json(a ->> 'agentId')`],
]);

const EVENT_ROUTE = restate(V55_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V56) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
]);

export const V56_SQL = `
-- ═══ 1. Customer orders (the agent's own records) ═══
CREATE TABLE fleet_customer_orders (
  order_id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id           text        NOT NULL REFERENCES fleet_agents(agent_id),
  venture_id         uuid        NOT NULL REFERENCES fleet_ventures(venture_id),
  checkout_id        uuid        NOT NULL UNIQUE REFERENCES fleet_paypal_checkouts(checkout_id),
  item               text        NOT NULL CHECK (length(item) BETWEEN 3 AND 127),
  amount_minor       bigint      NOT NULL CHECK (amount_minor > 0),
  currency           text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  fulfilment         text        NOT NULL CHECK (fulfilment IN ('digital_file','service')),
  payment_status     text        NOT NULL DEFAULT 'awaiting_payment'
                                 CHECK (payment_status IN ('awaiting_payment','payment_pending','paid','partially_refunded','refunded','reversed','cancelled')),
  status             text        NOT NULL DEFAULT 'awaiting_payment'
                                 CHECK (status IN ('awaiting_payment','to_fulfil','delivering','delivered','delivery_failed','fulfilled','cancelled')),
  refunded_minor     bigint      NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  buyer_email        text        CHECK (buyer_email ~ '^[^@[:space:]<>]{1,64}@[A-Za-z0-9.-]{3,190}$'),
  buyer_name         text        CHECK (length(buyer_name) <= 140),
  buyer_country      text        CHECK (buyer_country ~ '^[A-Z]{2}$'),
  buyer_payer_id     text        CHECK (buyer_payer_id ~ '^[A-Z0-9]{5,40}$'),
  buyer_recorded_at  timestamptz,
  buyer_lookups      integer     NOT NULL DEFAULT 0,
  buyer_next_lookup  timestamptz NOT NULL DEFAULT now(),
  note               text        CHECK (length(note) <= 2000),
  fulfilled_at       timestamptz,
  fulfilment_evidence jsonb      CHECK (fulfilment_evidence IS NULL OR length(fulfilment_evidence::text) <= 2000),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('delivered','fulfilled') OR (fulfilled_at IS NOT NULL AND fulfilment_evidence IS NOT NULL)),
  CHECK (status <> 'delivered' OR fulfilment = 'digital_file')
);
CREATE INDEX fleet_customer_orders_agent ON fleet_customer_orders (agent_id, created_at DESC);
CREATE INDEX fleet_customer_orders_buyer_work ON fleet_customer_orders (buyer_next_lookup) WHERE buyer_email IS NULL AND payment_status = 'paid';

CREATE FUNCTION fleet_customer_orders_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.order_id <> OLD.order_id OR NEW.agent_id <> OLD.agent_id OR NEW.venture_id <> OLD.venture_id OR NEW.checkout_id <> OLD.checkout_id
     OR NEW.amount_minor <> OLD.amount_minor OR NEW.currency <> OLD.currency OR NEW.fulfilment <> OLD.fulfilment OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: an order''s agent, checkout, amount and fulfilment kind are fixed';
  END IF;
  IF OLD.buyer_email IS NOT NULL AND NEW.buyer_email IS DISTINCT FROM OLD.buyer_email THEN RAISE EXCEPTION 'FLEET_IMMUTABLE: the buyer is recorded once'; END IF;
  IF OLD.status IN ('delivered','fulfilled') AND NEW.status NOT IN ('delivered','fulfilled','delivering') THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a delivered order stays delivered';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_customer_orders_guard BEFORE UPDATE ON fleet_customer_orders FOR EACH ROW EXECUTE FUNCTION fleet_customer_orders_guard();
CREATE TRIGGER fleet_customer_orders_no_delete BEFORE DELETE ON fleet_customer_orders FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_customer_orders_no_truncate BEFORE TRUNCATE ON fleet_customer_orders FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- One delivery of an order (a resend is a new delivery); its attempts are the reaper's retries of the same message.
CREATE TABLE fleet_order_deliveries (
  delivery_id     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid        NOT NULL REFERENCES fleet_customer_orders(order_id),
  agent_id        text        NOT NULL REFERENCES fleet_agents(agent_id),
  idempotency_key text        NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  subject         text        NOT NULL CHECK (length(subject) BETWEEN 1 AND 300),
  body            text        NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  resend_reason   text        CHECK (length(resend_reason) <= 300),
  status          text        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','gave_up','cancelled')),
  attempts        integer     NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND ${ORDER_DELIVERY_MAX_ATTEMPTS}),
  message_id      uuid        REFERENCES fleet_agent_mail(message_id),
  last_error      text        CHECK (last_error ~ '^[A-Z0-9_]{2,64}$'),
  next_attempt_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  CHECK (status <> 'sent' OR sent_at IS NOT NULL)
);
CREATE UNIQUE INDEX fleet_order_deliveries_one_active ON fleet_order_deliveries (order_id) WHERE status IN ('queued','failed');
CREATE INDEX fleet_order_deliveries_retry ON fleet_order_deliveries (next_attempt_at) WHERE status = 'failed';
CREATE UNIQUE INDEX fleet_order_deliveries_message ON fleet_order_deliveries (message_id) WHERE message_id IS NOT NULL;
CREATE TRIGGER fleet_order_deliveries_no_delete BEFORE DELETE ON fleet_order_deliveries FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- The delivered files; the bytes are erased once the provider accepted the message (the hash and size stay as evidence).
CREATE TABLE fleet_order_delivery_files (
  delivery_id    uuid        NOT NULL REFERENCES fleet_order_deliveries(delivery_id),
  file_no        integer     NOT NULL CHECK (file_no BETWEEN 1 AND 5),
  file_name      text        NOT NULL CHECK (file_name ~ '^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$'),
  content_type   text        NOT NULL CHECK (content_type IN (${q(STOREFRONT_FILE_TYPES)})),
  size_bytes     integer     NOT NULL CHECK (size_bytes BETWEEN 1 AND ${ORDER_DELIVERY_MAX_BYTES}),
  content_sha256 text        NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  blob           bytea,
  PRIMARY KEY (delivery_id, file_no)
);

-- The platforms the identity broker has a dedicated account connector for (published by the broker at start-up).
CREATE TABLE fleet_identity_connectors (
  platform     text        PRIMARY KEY CHECK (platform ~ '^[a-z0-9][a-z0-9._-]{1,40}$'),
  published_by text        NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION fleet_customer_order_json(o fleet_customer_orders, p_private boolean) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('orderId', o.order_id, 'checkoutId', o.checkout_id,
    'venture', (SELECT venture_key FROM fleet_ventures WHERE venture_id = o.venture_id), 'item', o.item, 'amountMinor', o.amount_minor, 'currency', o.currency,
    'fulfilment', o.fulfilment, 'payment', o.payment_status, 'status', o.status, 'refundedMinor', NULLIF(o.refunded_minor, 0),
    'buyer', CASE WHEN o.buyer_email IS NULL THEN NULL WHEN p_private
                  THEN jsonb_strip_nulls(jsonb_build_object('email', o.buyer_email, 'name', o.buyer_name, 'country', o.buyer_country))
                  ELSE jsonb_build_object('email', regexp_replace(o.buyer_email, '^(.).*(@.*)$', '\\1…\\2'), 'country', o.buyer_country) END,
    'buyerPending', CASE WHEN o.buyer_email IS NULL AND o.payment_status = 'paid' THEN true END,
    'note', CASE WHEN p_private THEN o.note END, 'fulfilledAt', o.fulfilled_at, 'evidence', o.fulfilment_evidence,
    'delivery', (SELECT jsonb_strip_nulls(jsonb_build_object('deliveryId', d.delivery_id, 'status', d.status, 'attempts', d.attempts, 'lastError', d.last_error,
                   'nextAttemptAt', CASE WHEN d.status = 'failed' THEN d.next_attempt_at END, 'sentAt', d.sent_at,
                   'files', (SELECT jsonb_agg(jsonb_build_object('fileName', f.file_name, 'sizeBytes', f.size_bytes, 'sha256', f.content_sha256) ORDER BY f.file_no)
                               FROM fleet_order_delivery_files f WHERE f.delivery_id = d.delivery_id)))
                 FROM fleet_order_deliveries d WHERE d.order_id = o.order_id ORDER BY d.created_at DESC LIMIT 1),
    'createdAt', o.created_at))
$$;

-- Agent: a checkout is also an order (what is sold, and how it will be fulfilled).
CREATE FUNCTION fleet_econ_paypal_checkout_order(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_kind text := COALESCE(a ->> 'fulfilment', 'service'); r jsonb; c fleet_paypal_checkouts; o fleet_customer_orders;
BEGIN
  IF v_kind NOT IN ('digital_file','service') THEN PERFORM fleet_econ_bad('fulfilment is digital_file (you deliver a file with wallet deliver) or service (you fulfil it yourself, then record it)'); END IF;
  r := fleet_econ_paypal_checkout(p_agent, a - 'fulfilment');
  IF NOT COALESCE((r ->> 'ok')::boolean, false) THEN RETURN r; END IF;
  SELECT * INTO c FROM fleet_paypal_checkouts WHERE checkout_id = (r #>> '{checkout,checkoutId}')::uuid;
  INSERT INTO fleet_customer_orders (agent_id, venture_id, checkout_id, item, amount_minor, currency, fulfilment)
    VALUES (c.agent_id, c.venture_id, c.checkout_id, c.description, c.amount_minor, c.currency, v_kind)
    ON CONFLICT (checkout_id) DO NOTHING;
  SELECT * INTO o FROM fleet_customer_orders WHERE checkout_id = c.checkout_id;
  RETURN r || jsonb_build_object('order', fleet_customer_order_json(o, true));
END $$;

-- Payment state follows the checkout (PayPal's evidence, recorded by custody).
CREATE FUNCTION fleet_customer_orders_follow() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_customer_orders;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  SELECT * INTO o FROM fleet_customer_orders WHERE checkout_id = NEW.checkout_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.status = 'captured' AND o.payment_status IN ('awaiting_payment','payment_pending') THEN
    UPDATE fleet_customer_orders SET payment_status = 'paid', status = CASE WHEN status = 'awaiting_payment' THEN 'to_fulfil' ELSE status END
     WHERE order_id = o.order_id;
    PERFORM fleet_event('customer_order_paid', o.agent_id, 'controller', jsonb_build_object('orderId', o.order_id, 'fulfilment', o.fulfilment,
      'note', 'paid: fulfil it (wallet deliver for a file; wallet fulfil with evidence for a service)'));
  ELSIF NEW.status = 'capture_pending' AND o.payment_status = 'awaiting_payment' THEN
    UPDATE fleet_customer_orders SET payment_status = 'payment_pending' WHERE order_id = o.order_id;
  ELSIF NEW.status IN ('cancelled','expired','failed') AND o.payment_status IN ('awaiting_payment','payment_pending') THEN
    UPDATE fleet_customer_orders SET payment_status = 'cancelled', status = 'cancelled' WHERE order_id = o.order_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_customer_orders_follow AFTER UPDATE OF status ON fleet_paypal_checkouts FOR EACH ROW EXECUTE FUNCTION fleet_customer_orders_follow();

-- Custody's refund recorder: money went back to the buyer (refund or reversal).
CREATE FUNCTION fleet_order_refunded(p_checkout uuid, p_kind text, p_amount bigint) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_customer_orders; v_total bigint; v_full boolean;
BEGIN
  SELECT * INTO o FROM fleet_customer_orders WHERE checkout_id = p_checkout FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  v_total := o.refunded_minor + p_amount;
  v_full := v_total >= o.amount_minor;
  UPDATE fleet_customer_orders SET refunded_minor = LEAST(v_total, amount_minor),
         payment_status = CASE WHEN p_kind = 'reversal' AND v_full THEN 'reversed' WHEN v_full THEN 'refunded' ELSE 'partially_refunded' END,
         status = CASE WHEN v_full AND status IN ('to_fulfil','delivering','delivery_failed') THEN 'cancelled' ELSE status END
   WHERE order_id = o.order_id;
  -- A fully refunded order is not delivered afterwards (a delivery already handed to the broker cannot be recalled).
  IF v_full THEN
    UPDATE fleet_order_deliveries SET status = 'cancelled', next_attempt_at = NULL WHERE order_id = o.order_id AND status = 'failed';
    UPDATE fleet_order_delivery_files f SET blob = NULL FROM fleet_order_deliveries d
     WHERE d.delivery_id = f.delivery_id AND d.order_id = o.order_id AND d.status = 'cancelled';
  END IF;
END $$;

${REFUND}

${TXN}

-- Agent: its own orders, with the buyer's contact (for delivery, invoices and support — never for the shared library).
CREATE FUNCTION fleet_econ_order_list(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_limit integer := COALESCE(fleet_econ_int(a, 'limit', 1, 200), 50)::integer; v_status text := fleet_econ_text(a, 'status', 30);
BEGIN
  RETURN jsonb_build_object('ok', true, 'orders', COALESCE((SELECT jsonb_agg(fleet_customer_order_json(o, true) ORDER BY o.created_at DESC)
      FROM (SELECT * FROM fleet_customer_orders x WHERE x.agent_id = p_agent
              AND (a ->> 'orderId' IS NULL OR x.order_id::text = a ->> 'orderId') AND (v_status IS NULL OR x.status = v_status)
            ORDER BY x.created_at DESC LIMIT v_limit) o), '[]'::jsonb),
    'note', 'Your customers'' contacts are yours to use for this order (delivery, invoice, support). Never put them into shared knowledge.');
END $$;

-- One send of a delivery: an ordinary outbound message of the agent to the buyer, from its mailbox on the shared address.
CREATE FUNCTION fleet_order_delivery_send(d fleet_order_deliveries, p_attempt integer) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_customer_orders; r jsonb;
BEGIN
  SELECT * INTO o FROM fleet_customer_orders WHERE order_id = d.order_id;
  r := fleet_econ_mail_send(d.agent_id, jsonb_build_object('to', o.buyer_email, 'subject', d.subject, 'body', d.body, 'ventureId', o.venture_id::text,
         'idempotencyKey', left('order-delivery:' || d.delivery_id || ':' || p_attempt, 128)));
  RETURN r;
END $$;

-- Agent: deliver a paid digital order — its file(s) mailed to the buyer. Payment alone never delivers anything.
CREATE FUNCTION fleet_econ_order_deliver(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_customer_orders; d fleet_order_deliveries; v_idem text := fleet_econ_text(a, 'idempotencyKey', 128, true); v_key text;
        v_subject text := fleet_econ_text(a, 'subject', 300); v_body text := fleet_econ_text(a, 'message', 20000); v_resend text := fleet_econ_text(a, 'resendReason', 300);
        f jsonb; n integer := 0; v_blob bytea; v_total bigint := 0; v_name text; v_type text; r jsonb; v_msg uuid;
BEGIN
  v_key := 'agent:' || p_agent || ':' || v_idem;
  SELECT * INTO d FROM fleet_order_deliveries WHERE idempotency_key = v_key;
  IF FOUND THEN
    SELECT * INTO o FROM fleet_customer_orders WHERE order_id = d.order_id;
    RETURN jsonb_build_object('ok', true, 'replay', true, 'order', fleet_customer_order_json(o, true));
  END IF;
  SELECT * INTO o FROM fleet_customer_orders WHERE order_id = fleet_identity_uuid(a, 'orderId') AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: orderId — one of your orders'; END IF;
  IF o.fulfilment <> 'digital_file' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE', 'reason', 'a service order is fulfilled by you, then recorded with wallet fulfil'); END IF;
  IF o.payment_status NOT IN ('paid','partially_refunded') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ORDER_NOT_PAID', 'payment', o.payment_status, 'reason', 'deliver only what PayPal shows paid (and not refunded)');
  END IF;
  IF o.buyer_email IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BUYER_PENDING', 'reason', 'the buyer''s contact is read from PayPal shortly after capture; try again on a later turn');
  END IF;
  IF EXISTS (SELECT 1 FROM fleet_order_deliveries WHERE order_id = o.order_id AND status IN ('queued','failed')) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_DELIVERY_IN_PROGRESS', 'order', fleet_customer_order_json(o, true));
  END IF;
  IF o.status IN ('delivered') AND (v_resend IS NULL OR length(v_resend) < 3) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ALREADY_DELIVERED', 'reason', 'already delivered; to send it again (the buyer asked), give resendReason');
  END IF;
  IF (SELECT count(*) FROM fleet_order_deliveries WHERE order_id = o.order_id) >= 4 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INFRASTRUCTURE_CEILING', 'reason', 'an order is delivered at most four times');
  END IF;
  IF jsonb_typeof(a -> 'files') <> 'array' OR jsonb_array_length(a -> 'files') NOT BETWEEN 1 AND 5 THEN PERFORM fleet_econ_bad('files: 1..5 of your workspace files'); END IF;
  INSERT INTO fleet_order_deliveries (order_id, agent_id, idempotency_key, subject, body, resend_reason)
    VALUES (o.order_id, p_agent, v_key, COALESCE(v_subject, 'Your order: ' || o.item),
            COALESCE(v_body, 'Thank you for your order of ' || o.item || '. Your file' || CASE WHEN jsonb_array_length(a -> 'files') > 1 THEN 's are' ELSE ' is' END || ' attached.'),
            v_resend)
    RETURNING * INTO d;
  FOR f IN SELECT * FROM jsonb_array_elements(a -> 'files') LOOP
    n := n + 1;
    v_name := f ->> 'fileName'; v_type := COALESCE(f ->> 'contentType', 'application/pdf');
    IF v_name IS NULL OR v_name !~ '^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$' THEN PERFORM fleet_econ_bad('fileName: letters, digits, . _ - and spaces'); END IF;
    IF v_type NOT IN (${q(STOREFRONT_FILE_TYPES)}) THEN PERFORM fleet_econ_bad('contentType is one of ${STOREFRONT_FILE_TYPES.join(", ")}'); END IF;
    BEGIN v_blob := decode(f ->> 'contentB64', 'base64'); EXCEPTION WHEN OTHERS THEN PERFORM fleet_econ_bad('contentB64: the file, base64'); END;
    IF v_blob IS NULL OR octet_length(v_blob) < 1 THEN PERFORM fleet_econ_bad('an empty file'); END IF;
    v_total := v_total + octet_length(v_blob);
    IF v_total > ${ORDER_DELIVERY_MAX_BYTES} THEN PERFORM fleet_econ_bad('the files together are at most 15 MB'); END IF;
    INSERT INTO fleet_order_delivery_files (delivery_id, file_no, file_name, content_type, size_bytes, content_sha256, blob)
      VALUES (d.delivery_id, n, v_name, v_type, octet_length(v_blob), encode(sha256(v_blob), 'hex'), v_blob);
  END LOOP;
  r := fleet_order_delivery_send(d, 1);
  IF NOT COALESCE((r ->> 'ok')::boolean, false) THEN
    -- Mail is not available (not configured, or no mailbox): nothing was queued; the order waits for the agent's next try.
    RAISE EXCEPTION '%', COALESCE(r ->> 'code', 'FLEET_MAIL_UNAVAILABLE') || ': ' || COALESCE(r ->> 'reason', 'mail is not available for delivery yet; the order stays to fulfil');
  END IF;
  v_msg := (r ->> 'messageId')::uuid;
  UPDATE fleet_order_deliveries SET message_id = v_msg WHERE delivery_id = d.delivery_id;
  UPDATE fleet_customer_orders SET status = 'delivering' WHERE order_id = o.order_id RETURNING * INTO o;
  RETURN jsonb_build_object('ok', true, 'order', fleet_customer_order_json(o, true),
    'note', 'queued to the buyer from the Fleet''s shared address (your routing address as Reply-To); delivered once the mail provider accepts it, retried automatically if it fails');
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('ok', false, 'code', 'FLEET_DELIVERY_IN_PROGRESS');
END $$;

-- The broker's outcome of a delivery's message reaches the delivery and the order.
CREATE FUNCTION fleet_order_delivery_follow() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE d fleet_order_deliveries; o fleet_customer_orders;
BEGIN
  IF NEW.direction <> 'out' OR NEW.send_status IS NOT DISTINCT FROM OLD.send_status OR NEW.send_status NOT IN ('sent','failed') THEN RETURN NEW; END IF;
  SELECT * INTO d FROM fleet_order_deliveries WHERE message_id = NEW.message_id FOR UPDATE;
  IF NOT FOUND OR d.status <> 'queued' THEN RETURN NEW; END IF;
  SELECT * INTO o FROM fleet_customer_orders WHERE order_id = d.order_id FOR UPDATE;
  IF NEW.send_status = 'sent' THEN
    UPDATE fleet_order_deliveries SET status = 'sent', sent_at = now(), last_error = NULL, next_attempt_at = NULL WHERE delivery_id = d.delivery_id;
    UPDATE fleet_order_delivery_files SET blob = NULL WHERE delivery_id = d.delivery_id;
    UPDATE fleet_customer_orders SET status = 'delivered', fulfilled_at = COALESCE(fulfilled_at, now()),
           fulfilment_evidence = jsonb_build_object('kind', 'mail', 'messageId', NEW.message_id, 'externalMessageId', NEW.external_message_id, 'sentAt', now(),
             'files', (SELECT jsonb_agg(jsonb_build_object('fileName', f.file_name, 'sha256', f.content_sha256)) FROM fleet_order_delivery_files f WHERE f.delivery_id = d.delivery_id))
     WHERE order_id = o.order_id AND status IN ('delivering','delivered');
    PERFORM fleet_event('order_delivered', o.agent_id, 'controller', jsonb_build_object('orderId', o.order_id, 'deliveryId', d.delivery_id, 'attempt', d.attempts));
  ELSIF d.attempts >= ${ORDER_DELIVERY_MAX_ATTEMPTS} THEN
    UPDATE fleet_order_deliveries SET status = 'gave_up', last_error = (CASE WHEN NEW.send_error ~ '^[A-Z0-9_]{2,64}$' THEN NEW.send_error ELSE 'FLEET_MAIL_SEND_FAILED' END), next_attempt_at = NULL WHERE delivery_id = d.delivery_id;
    UPDATE fleet_order_delivery_files SET blob = NULL WHERE delivery_id = d.delivery_id;
    UPDATE fleet_customer_orders SET status = CASE WHEN status = 'delivering' THEN 'delivery_failed' ELSE status END WHERE order_id = o.order_id;
    PERFORM fleet_event('order_delivery_gave_up', o.agent_id, 'controller', jsonb_build_object('orderId', o.order_id, 'deliveryId', d.delivery_id, 'attempts', d.attempts,
      'code', (CASE WHEN NEW.send_error ~ '^[A-Z0-9_]{2,64}$' THEN NEW.send_error ELSE 'FLEET_MAIL_SEND_FAILED' END), 'note', 'delivery failed five times; try another channel or deliver again later'));
  ELSE
    UPDATE fleet_order_deliveries SET status = 'failed', last_error = (CASE WHEN NEW.send_error ~ '^[A-Z0-9_]{2,64}$' THEN NEW.send_error ELSE 'FLEET_MAIL_SEND_FAILED' END),
           next_attempt_at = now() + (interval '15 minutes' * power(4, d.attempts - 1)) WHERE delivery_id = d.delivery_id;
    PERFORM fleet_event('order_delivery_failed', o.agent_id, 'controller', jsonb_build_object('orderId', o.order_id, 'deliveryId', d.delivery_id, 'attempt', d.attempts,
      'code', (CASE WHEN NEW.send_error ~ '^[A-Z0-9_]{2,64}$' THEN NEW.send_error ELSE 'FLEET_MAIL_SEND_FAILED' END)));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_order_delivery_follow AFTER UPDATE OF send_status ON fleet_agent_mail FOR EACH ROW EXECUTE FUNCTION fleet_order_delivery_follow();

-- Reaper: failed deliveries are sent again (15 min, 1 h, 4 h, 16 h); never after a full refund; one message at a time.
CREATE FUNCTION svc_order_deliveries_retry(p_limit integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE d fleet_order_deliveries; o fleet_customer_orders; r jsonb; n integer := 0; nw integer := 0;
BEGIN
  FOR d IN SELECT * FROM fleet_order_deliveries WHERE status = 'failed' AND next_attempt_at <= now() ORDER BY next_attempt_at
            LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100) FOR UPDATE SKIP LOCKED LOOP
    SELECT * INTO o FROM fleet_customer_orders WHERE order_id = d.order_id FOR UPDATE;
    IF o.payment_status NOT IN ('paid','partially_refunded') OR o.status NOT IN ('delivering','delivered')
       OR NOT EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = d.agent_id AND status IN ('active','unresponsive')) THEN
      UPDATE fleet_order_deliveries SET status = 'cancelled', next_attempt_at = NULL WHERE delivery_id = d.delivery_id;
      UPDATE fleet_order_delivery_files SET blob = NULL WHERE delivery_id = d.delivery_id;
      CONTINUE;
    END IF;
    r := fleet_order_delivery_send(d, d.attempts + 1);
    IF COALESCE((r ->> 'ok')::boolean, false) THEN
      UPDATE fleet_order_deliveries SET status = 'queued', attempts = attempts + 1, message_id = (r ->> 'messageId')::uuid, next_attempt_at = NULL
       WHERE delivery_id = d.delivery_id;
      n := n + 1;
    ELSE
      -- Mail unavailable right now: wait an hour, without spending an attempt.
      UPDATE fleet_order_deliveries SET next_attempt_at = now() + interval '1 hour', last_error = left(COALESCE(r ->> 'code', 'FLEET_MAIL_UNAVAILABLE'), 64)
       WHERE delivery_id = d.delivery_id;
      nw := nw + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'resent', n, 'waiting', nw);
END $$;

-- Agent: a service order is fulfilled by the agent's own work; it records that with evidence.
CREATE FUNCTION fleet_econ_order_fulfil(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_customer_orders; m fleet_agent_mail; v_note text := fleet_econ_text(a, 'note', 1000); v_ev jsonb;
BEGIN
  SELECT * INTO o FROM fleet_customer_orders WHERE order_id = fleet_identity_uuid(a, 'orderId') AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: orderId — one of your orders'; END IF;
  IF o.status = 'fulfilled' THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'order', fleet_customer_order_json(o, true)); END IF;
  IF o.fulfilment <> 'service' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE', 'reason', 'a digital order is delivered with wallet deliver'); END IF;
  IF o.payment_status NOT IN ('paid','partially_refunded') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ORDER_NOT_PAID', 'payment', o.payment_status, 'reason', 'record fulfilment of what PayPal shows paid');
  END IF;
  IF a ? 'messageId' THEN
    SELECT * INTO m FROM fleet_agent_mail WHERE message_id = fleet_identity_uuid(a, 'messageId') AND agent_id = p_agent AND direction = 'out' AND send_status = 'sent';
    IF NOT FOUND OR o.buyer_email IS NULL OR NOT (lower(o.buyer_email) = ANY (m.recipients)) THEN
      PERFORM fleet_econ_bad('messageId is a message of yours, sent, to this order''s buyer');
    END IF;
    v_ev := jsonb_strip_nulls(jsonb_build_object('kind', 'mail', 'messageId', m.message_id, 'sentAt', m.sent_at, 'note', v_note));
  ELSIF v_note IS NOT NULL AND length(v_note) >= 10 THEN
    v_ev := jsonb_build_object('kind', 'note', 'note', fleet_scrub(v_note));
  ELSE
    PERFORM fleet_econ_bad('evidence: messageId (your sent message to the buyer) or a note of what you delivered (10+ characters)');
  END IF;
  UPDATE fleet_customer_orders SET status = 'fulfilled', fulfilled_at = now(), fulfilment_evidence = v_ev WHERE order_id = o.order_id RETURNING * INTO o;
  PERFORM fleet_event('order_fulfilled', p_agent, 'agent', jsonb_build_object('orderId', o.order_id, 'evidence', v_ev ->> 'kind'));
  RETURN jsonb_build_object('ok', true, 'order', fleet_customer_order_json(o, true));
END $$;

-- ═══ Shared lessons: personal data is scrubbed whatever its letter case; a subject never carries a long number ═══
CREATE OR REPLACE FUNCTION fleet_scrub_pii(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(t,
    '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}', '[email]', 'g'),
    '\\m[A-Za-z]{2}[0-9]{2}[A-Za-z0-9]{11,30}\\M', '[bank account]', 'g'),
    '([0-9][ -]?){12,18}[0-9]', '[number]', 'g'),
    '\\m[0-9]{2}-[0-9]{2}-[0-9]{2}\\M', '[sort code]', 'g'),
    '(\\+[0-9]{1,3}[ -]?|\\m0)[0-9]{2,4}[ -]?[0-9]{3,4}[ -]?[0-9]{3,4}', '[phone]', 'g'),
    '\\m[A-Za-z]{1,2}[0-9][A-Za-z0-9]? ?[0-9][A-Za-z]{2}\\M', '[postcode]', 'g')
$$;
CREATE OR REPLACE FUNCTION fleet_knowledge_scrub() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'fleet_economic_knowledge' THEN
    NEW.claim := fleet_scrub_pii(NEW.claim);
    NEW.evidence := fleet_scrub_pii(NEW.evidence::text)::jsonb;
    -- v56: the subject is a short slug; a run of six or more digits (a phone, card or account number) never stays in it.
    NEW.subject := regexp_replace(NEW.subject, '[0-9][0-9 ._/-]{4,}[0-9]', 'num', 'g');
  ELSE
    NEW.title := fleet_scrub_pii(NEW.title);
    NEW.content := fleet_scrub_pii(NEW.content);
  END IF;
  RETURN NEW;
END $$;

-- ═══ Estates: the agent's payable at death ═══
INSERT INTO fleet_ledger_kinds (kind, requires_external_ref, allowed_sources, multi_agent, description, provenance) VALUES
  ('estate_payable_writeoff', true, ARRAY['controller','owner'], false, 'A dead agent''s payable it could not repay is written off against the treasury''s advance', 'estate');
INSERT INTO fleet_ledger_rules (kind, class, side) VALUES
  ('estate_payable_writeoff','agent_provider_payable','D'), ('estate_payable_writeoff','provider_advances','C');

-- Repay as much of the agent's payable (treasury advances) as its cash covers; returns the amount repaid.
CREATE FUNCTION fleet_estate_repay_payable(p_agent text, p_actor text, p_key text) RETURNS bigint LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v bigint := LEAST(fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_provider_payable')), fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_cash')));
BEGIN
  IF v IS NULL OR v <= 0 THEN RETURN 0; END IF;
  PERFORM fleet_ledger_post('payable_repayment', p_key, p_actor, 'estate: the agent''s payable repaid from its cash', 'controller', p_agent,
    NULL, NULL, p_key, NULL, now(), jsonb_build_array(
      jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_provider_payable'), 'side', 'D', 'amount', v),
      jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_cash'), 'side', 'C', 'amount', v),
      jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', v),
      jsonb_build_object('account', 'fleet:provider:advances', 'side', 'C', 'amount', v)));
  RETURN v;
END $$;

-- Write off what remains of a dead agent's payable (the treasury's advance is lost); returns the amount.
CREATE FUNCTION fleet_estate_write_off_payable(p_agent text, p_actor text, p_key text) RETURNS bigint LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v bigint := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_provider_payable'));
BEGIN
  IF v IS NULL OR v <= 0 THEN RETURN 0; END IF;
  PERFORM fleet_ledger_post('estate_payable_writeoff', p_key, p_actor, 'estate: unrecoverable payable written off', 'controller', p_agent,
    NULL, NULL, p_key, NULL, now(), jsonb_build_array(
      jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_provider_payable'), 'side', 'D', 'amount', v),
      jsonb_build_object('account', 'fleet:provider:advances', 'side', 'C', 'amount', v)));
  RETURN v;
END $$;

${ESTATE_SETTLE}

${SETTLE_ESTATES}

-- ═══ 2. The buyer's contact, from PayPal's own order record (custody) ═══
CREATE FUNCTION cx_paypal_buyer_work(p_worker text, p_limit integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r jsonb;
BEGIN
  ${WORKER}
  SELECT COALESCE(jsonb_agg(jsonb_build_object('checkoutId', c.checkout_id, 'paypalOrderId', c.paypal_order_id, 'railId', x.rail_id, 'railMode', x.mode,
           'credentialId', x.credential_id, 'vaultRef', k.vault_ref)), '[]'::jsonb) INTO r
    FROM (SELECT o.checkout_id FROM fleet_customer_orders o WHERE o.buyer_email IS NULL AND o.payment_status = 'paid' AND o.buyer_next_lookup <= now()
           ORDER BY o.buyer_next_lookup LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100)) w
    JOIN fleet_paypal_checkouts c ON c.checkout_id = w.checkout_id
    JOIN fleet_payment_rails x ON x.rail_id = c.rail_id JOIN fleet_credential_refs k ON k.credential_id = x.credential_id
   WHERE c.paypal_order_id IS NOT NULL AND x.status = 'active' AND k.status IN ('active','rotating');
  RETURN r;
END $$;

-- p_payer: PayPal's payer object ({email_address, name: {given_name, surname}, address: {country_code}, payer_id}); NULL = not
-- readable this time (looked up again with back-off).
CREATE FUNCTION cx_paypal_buyer_record(p_worker text, p_checkout uuid, p_payer jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_customer_orders; v_email text; v_name text; v_country text; v_payer text;
BEGIN
  ${WORKER}
  SELECT * INTO o FROM fleet_customer_orders WHERE checkout_id = p_checkout FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF o.buyer_email IS NOT NULL THEN RETURN jsonb_build_object('ok', true, 'replay', true); END IF;
  v_email := p_payer ->> 'email_address';
  IF v_email IS NULL OR v_email !~ '^[^@[:space:]<>]{1,64}@[A-Za-z0-9.-]{3,190}$' THEN
    UPDATE fleet_customer_orders SET buyer_lookups = buyer_lookups + 1,
           buyer_next_lookup = now() + LEAST(interval '1 minute' * power(2, buyer_lookups), interval '12 hours') WHERE order_id = o.order_id;
    RETURN jsonb_build_object('ok', true, 'recorded', false);
  END IF;
  v_name := NULLIF(left(btrim(regexp_replace(COALESCE(p_payer #>> '{name,given_name}', '') || ' ' || COALESCE(p_payer #>> '{name,surname}', ''), '[[:cntrl:]<>]', '', 'g')), 140), '');
  v_country := CASE WHEN (p_payer #>> '{address,country_code}') ~ '^[A-Z]{2}$' THEN p_payer #>> '{address,country_code}' END;
  v_payer := CASE WHEN (p_payer ->> 'payer_id') ~ ${PAYPAL_ID} THEN p_payer ->> 'payer_id' END;
  UPDATE fleet_customer_orders SET buyer_email = lower(v_email), buyer_name = v_name, buyer_country = v_country, buyer_payer_id = v_payer,
         buyer_recorded_at = now(), buyer_lookups = buyer_lookups + 1 WHERE order_id = o.order_id;
  RETURN jsonb_build_object('ok', true, 'recorded', true);
END $$;

-- ═══ 3. The identity broker: a delivery's files; the dedicated connectors it has ═══
CREATE FUNCTION ix_mail_attachments(p_job uuid, p_lease text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_identity_jobs := ix_leased(p_job, p_lease); r jsonb;
BEGIN
  IF j.kind <> 'mail.send' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('fileName', f.file_name, 'contentType', f.content_type, 'contentB64', encode(f.blob, 'base64')) ORDER BY f.file_no), '[]'::jsonb) INTO r
    FROM fleet_order_deliveries d JOIN fleet_order_delivery_files f ON f.delivery_id = d.delivery_id
   WHERE d.message_id::text = j.params ->> 'messageId' AND d.agent_id = j.agent_id AND d.status = 'queued' AND f.blob IS NOT NULL;
  RETURN jsonb_build_object('ok', true, 'attachments', r);
END $$;

CREATE FUNCTION ix_connectors_publish(p_worker text, p_platforms jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v text[];
BEGIN
  ${WORKER}
  IF jsonb_typeof(p_platforms) <> 'array' OR jsonb_array_length(p_platforms) > 100 THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  SELECT COALESCE(array_agg(DISTINCT lower(e)), '{}') INTO v FROM jsonb_array_elements_text(p_platforms) e;
  IF EXISTS (SELECT 1 FROM unnest(v) x WHERE x !~ '^[a-z0-9][a-z0-9._-]{1,40}$') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  DELETE FROM fleet_identity_connectors WHERE NOT (platform = ANY (v));
  INSERT INTO fleet_identity_connectors (platform, published_by) SELECT x, 'identity:' || p_worker FROM unnest(v) x ON CONFLICT (platform) DO NOTHING;
  RETURN jsonb_build_object('ok', true, 'connectors', cardinality(v));
END $$;

-- Agent: account.create only where the broker has a dedicated connector; otherwise the working path, at once.
CREATE FUNCTION fleet_econ_account_create_connected(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_platform text := lower(fleet_econ_text(a, 'platform', 41, true));
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleet_identity_connectors WHERE platform = v_platform) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NO_CONNECTOR',
      'reason', 'the identity broker has no dedicated connector for ' || COALESCE(v_platform, 'that platform')
        || ' (connectors: ' || COALESCE((SELECT string_agg(platform, ', ' ORDER BY platform) FROM fleet_identity_connectors), 'none') || '). '
        || 'Create the account yourself: identity register_account {platform, kind, origin, loginEmail (your mailbox)}, then the browser tool with that accountId.');
  END IF;
  RETURN fleet_econ_account_create(p_agent, a);
END $$;

${JOB_CONTEXT}

${DISPATCH}

-- ═══ 4. Dashboard ═══
CREATE FUNCTION fleet_customer_orders_json(p_agent text) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'counts', COALESCE((SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*) AS n FROM fleet_customer_orders WHERE p_agent IS NULL OR agent_id = p_agent GROUP BY status) s), '{}'::jsonb),
    'orders', COALESCE((SELECT jsonb_agg(fleet_customer_order_json(o, false) || jsonb_build_object('agentId', o.agent_id) ORDER BY o.created_at DESC)
       FROM (SELECT * FROM fleet_customer_orders WHERE p_agent IS NULL OR agent_id = p_agent ORDER BY created_at DESC LIMIT 100) o), '[]'::jsonb),
    'connectors', COALESCE((SELECT jsonb_agg(platform ORDER BY platform) FROM fleet_identity_connectors), '[]'::jsonb))
$$;

${STOREFRONT_JSON}

${DASH_CALL}

${EVENT_ROUTE}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

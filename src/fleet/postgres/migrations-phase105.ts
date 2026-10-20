/**
 * Schema v105 — platform-calculated quotes and invoices (owner, 2026-10-20: "implement platform-calculated quotes and
 * invoices from structured line items, with explicit currency, precision, tax/fee treatment and rounding. Render totals
 * from those calculated records into customer messages and documents. Preserve legitimate agent pricing decisions").
 *
 * 1. CURRENCIES. `fleet_supported_currencies()` is what the Fleet's records actually use — the accounting currency (the
 *    only one checkouts take: payments: true) and the currencies of its recorded exchange rates — each with its ISO 4217
 *    minor-unit exponent (`fleet_currency_exponent`: 0 for JPY, KRW, …; 3 for BHD, KWD, …; 2 otherwise). No currency is
 *    assumed: a new accounting currency or exchange rate extends it.
 * 2. PRICING. `fleet_price_lines(currency, items, fees, tax)` computes a price from the agent's own decisions — each
 *    line's description, quantity (≤ 3 decimals), unit price in minor units and discount (basis points); fixed or
 *    percentage fees; a tax rate, exclusive (added) or inclusive (shown, not added). Exact numeric arithmetic in minor
 *    units; ONE stated rounding rule: half-up (away from zero) to the currency's minor unit, applied to each line, each
 *    discount, each fee and the tax. The result is a record (lines, subtotal, fees, tax, total) and its rendered text.
 * 3. QUOTES. `enquiry.quote` takes `items` (+ `fees`, `tax`) instead of a typed price: the platform computes the total,
 *    stores the record on the order (`fleet_customer_orders.pricing`) and renders it into the buyer's message and e-mail. A
 *    `priceMinor` given with items must equal the computed total (FLEET_PRICE_MISMATCH otherwise). A quote with a single
 *    price is still accepted and recorded as one line.
 *    `money.price` returns the same calculation without quoting (a preview; the toolbox's pre-send money check uses it).
 * 4. INVOICES. `order.invoice` renders an invoice from the authoritative record only: the seller's legal facts, the
 *    order's pricing record (or its single line), what was captured, refunded and is still pending — never a figure the
 *    agent typed.
 */
import { V76_SQL } from "./migrations-phase76.js";
import { V95_SQL } from "./migrations-phase95.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));

export const AGENT_OPS_V105 = ["order.invoice", "money.currencies", "money.price"] as const;
export const PRICE_LINES_MAX = 50;
export const PRICE_FEES_MAX = 10;

const QUOTE = restate(V76_SQL, "fleet_econ_enquiry_quote", [
  [`v_price bigint := fleet_econ_int(a, 'priceMinor', 100, 100000000, true);`,
   `v_price bigint := fleet_econ_int(a, 'priceMinor', 100, 100000000, NOT (a ? 'items'));
        v_ccy text := (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1); v_pricing jsonb;`],
  [`  IF e.status NOT IN ('new','clarifying') THEN RAISE EXCEPTION 'FLEET_ENQUIRY_CLOSED: quote an open enquiry (this one is %)', e.status; END IF;`,
   `  IF e.status NOT IN ('new','clarifying') THEN RAISE EXCEPTION 'FLEET_ENQUIRY_CLOSED: quote an open enquiry (this one is %)', e.status; END IF;
  -- v105: the price is calculated by the platform from the agent's line items (or recorded as the one line it quoted).
  IF a ? 'items' THEN
    v_pricing := fleet_price_lines(v_ccy, a -> 'items', a -> 'fees', a -> 'tax');
    IF v_price IS NOT NULL AND v_price <> (v_pricing ->> 'totalMinor')::bigint THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PRICE_MISMATCH', 'computedMinor', (v_pricing ->> 'totalMinor')::bigint, 'pricing', v_pricing,
        'reason', format('the line items come to %s, not %s: nothing was quoted. Leave priceMinor out (the platform calculates it) or correct the items',
          fleet_money_text((v_pricing ->> 'totalMinor')::bigint, v_ccy), fleet_money_text(v_price, v_ccy)));
    END IF;
    v_price := (v_pricing ->> 'totalMinor')::bigint;
    IF v_price < 100 THEN PERFORM fleet_econ_bad('the line items come to less than the minimum price (100 minor units)'); END IF;
  ELSE
    v_pricing := fleet_price_lines(v_ccy, jsonb_build_array(jsonb_build_object('description', left(v_scope, 200), 'quantity', 1, 'unitMinor', v_price)), NULL, NULL);
  END IF;`],
  [`  SELECT * INTO x FROM fleet_customer_orders WHERE checkout_id = c.checkout_id;`,
   `  UPDATE fleet_customer_orders SET pricing = v_pricing WHERE checkout_id = c.checkout_id AND pricing IS NULL;
  SELECT * INTO x FROM fleet_customer_orders WHERE checkout_id = c.checkout_id;`],
  [`format('Price: %s %s; delivery within %s days of payment; %s', to_char(v_price / 100.0, 'FM999999990.00'), x.currency, v_days,`,
   `v_pricing ->> 'text', format('Delivery within %s days of payment; %s', v_days,`],
  [`format('Price: %s %s. Delivery within %s days of payment.', to_char(v_price / 100.0, 'FM999999990.00'), x.currency, v_days),`,
   `v_pricing ->> 'text', format('Delivery within %s days of payment.', v_days),`],
]);

const DISPATCH = restate(V95_SQL, "api_economy", [
  [`WHEN 'code.job' THEN 'planning'`, `WHEN 'code.job' THEN 'planning' ${AGENT_OPS_V105.map((o) => `WHEN '${o}' THEN 'planning'`).join(" ")}`],
  [`      WHEN 'code.job' THEN fleet_econ_code_job_result(p_agent, a)`, `      WHEN 'code.job' THEN fleet_econ_code_job_result(p_agent, a)
      WHEN 'order.invoice' THEN fleet_econ_order_invoice(p_agent, a)
      WHEN 'money.currencies' THEN jsonb_build_object('ok', true, 'currencies', fleet_supported_currencies(),
        'rounding', 'half-up (away from zero) to the currency''s minor unit')
      WHEN 'money.price' THEN jsonb_build_object('ok', true, 'pricing', fleet_price_lines((SELECT accounting_currency FROM fleet_economic_model WHERE id = 1), a -> 'items', a -> 'fees', a -> 'tax'),
        'note', 'calculated by the platform; quote with these items (priceMinor left out) to charge exactly this')`],
]);

export const V105_SQL = `
-- ISO 4217 minor-unit exponents (the currencies whose minor unit is not the cent).
CREATE FUNCTION fleet_currency_exponent(p text) RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT CASE WHEN p IS NULL OR p !~ '^[A-Z]{3}$' THEN NULL
    WHEN p IN ('BIF','CLP','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF','UGX','UYI','VND','VUV','XAF','XOF','XPF') THEN 0
    WHEN p IN ('BHD','IQD','JOD','KWD','LYD','OMR','TND') THEN 3
    WHEN p IN ('CLF','UYW') THEN 4
    ELSE 2 END
$$;

-- The currencies the Fleet's records use: the accounting currency (payments) and those of its recorded exchange rates.
CREATE FUNCTION fleet_supported_currencies() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  WITH acct AS (SELECT accounting_currency AS c FROM fleet_economic_model WHERE id = 1),
       u AS (SELECT c FROM acct UNION SELECT base FROM fleet_fx_rates UNION SELECT quote FROM fleet_fx_rates)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('code', u.c, 'exponent', fleet_currency_exponent(u.c), 'payments', u.c = (SELECT c FROM acct)) ORDER BY u.c), '[]'::jsonb)
    FROM u WHERE fleet_currency_exponent(u.c) IS NOT NULL
$$;

-- An amount in minor units as the customer reads it: "£5.00", "€12.50", "USD 6.40", "JPY 500".
CREATE FUNCTION fleet_money_text(p_minor numeric, p_ccy text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT CASE WHEN p_minor < 0 THEN '-' ELSE '' END || CASE p_ccy WHEN 'GBP' THEN '£' WHEN 'EUR' THEN '€' ELSE p_ccy || ' ' END
      || CASE WHEN fleet_currency_exponent(p_ccy) = 0 THEN to_char(abs(p_minor), 'FM999,999,999,990')
              ELSE to_char(abs(p_minor) / (10 ^ fleet_currency_exponent(p_ccy))::numeric, 'FM999,999,999,990.' || repeat('0', fleet_currency_exponent(p_ccy))) END
$$;

-- A price from the agent's decisions, computed exactly; one rounding rule: half-up to the minor unit, per line, discount,
-- fee and tax (numeric round() rounds half away from zero).
CREATE FUNCTION fleet_price_lines(p_currency text, p_items jsonb, p_fees jsonb, p_tax jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_e integer := fleet_currency_exponent(p_currency); it jsonb; f jsonb; v_q numeric; v_u bigint; v_d integer; v_gross bigint; v_disc bigint; v_net bigint;
        v_lines jsonb := '[]'::jsonb; v_sub bigint := 0; v_fees jsonb := '[]'::jsonb; v_feet bigint := 0; v_fm bigint; v_bp integer; v_incl boolean := false;
        v_tax bigint := 0; v_taxin bigint := 0; v_total bigint; v_txt text[] := '{}'; v_label text; v_desc text;
BEGIN
  IF v_e IS NULL OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(fleet_supported_currencies()) c WHERE c ->> 'code' = p_currency) THEN
    PERFORM fleet_econ_bad(format('currency %s is not one the Fleet''s records use', COALESCE(p_currency, '(none)')));
  END IF;
  IF p_items IS NULL OR COALESCE(jsonb_typeof(p_items), 'missing') <> 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND ${PRICE_LINES_MAX} THEN
    PERFORM fleet_econ_bad('items: 1..${PRICE_LINES_MAX} lines of {description, quantity, unitMinor, discountBp?}');
  END IF;
  FOR it IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_desc := btrim(COALESCE(it ->> 'description', ''));
    IF length(v_desc) NOT BETWEEN 1 AND 200 THEN PERFORM fleet_econ_bad('each line has a description (1..200 characters)'); END IF;
    IF COALESCE(jsonb_typeof(it -> 'quantity'), 'missing') <> 'number' OR (it ->> 'quantity')::numeric <= 0 OR (it ->> 'quantity')::numeric > 100000
       OR scale((it ->> 'quantity')::numeric) > 3 THEN PERFORM fleet_econ_bad('quantity: a number above 0, at most 100000, at most 3 decimals'); END IF;
    IF COALESCE(jsonb_typeof(it -> 'unitMinor'), 'missing') <> 'number' OR (it ->> 'unitMinor')::numeric <> trunc((it ->> 'unitMinor')::numeric)
       OR (it ->> 'unitMinor')::numeric NOT BETWEEN 0 AND 1000000000 THEN PERFORM fleet_econ_bad('unitMinor: a whole number of minor units, 0..1000000000'); END IF;
    IF it ? 'discountBp' AND (COALESCE(jsonb_typeof(it -> 'discountBp'), 'missing') <> 'number' OR (it ->> 'discountBp')::numeric <> trunc((it ->> 'discountBp')::numeric)
       OR (it ->> 'discountBp')::numeric NOT BETWEEN 0 AND 10000) THEN PERFORM fleet_econ_bad('discountBp: whole basis points 0..10000 (1000 = 10%)'); END IF;
    v_q := (it ->> 'quantity')::numeric; v_u := (it ->> 'unitMinor')::bigint; v_d := COALESCE((it ->> 'discountBp')::integer, 0);
    v_gross := round(v_q * v_u);
    v_disc := round(v_gross * v_d / 10000.0);
    v_net := v_gross - v_disc;
    v_sub := v_sub + v_net;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('description', v_desc, 'quantity', v_q, 'unitMinor', v_u, 'discountBp', v_d,
      'grossMinor', v_gross, 'discountMinor', v_disc, 'lineMinor', v_net));
    v_txt := v_txt || format('- %s: %s × %s = %s%s', v_desc, rtrim(rtrim(v_q::text, '0'), '.'), fleet_money_text(v_u, p_currency), fleet_money_text(v_gross, p_currency),
      CASE WHEN v_disc > 0 THEN format(', less %s%% discount (%s) = %s', rtrim(rtrim((v_d / 100.0)::text, '0'), '.'), fleet_money_text(v_disc, p_currency), fleet_money_text(v_net, p_currency)) ELSE '' END);
  END LOOP;
  v_txt := v_txt || format('Subtotal: %s', fleet_money_text(v_sub, p_currency));
  IF p_fees IS NOT NULL AND jsonb_typeof(p_fees) <> 'null' THEN
    IF jsonb_typeof(p_fees) <> 'array' OR jsonb_array_length(p_fees) > ${PRICE_FEES_MAX} THEN PERFORM fleet_econ_bad('fees: up to ${PRICE_FEES_MAX} of {label, minor | bp}'); END IF;
    FOR f IN SELECT * FROM jsonb_array_elements(p_fees) LOOP
      v_label := btrim(COALESCE(f ->> 'label', ''));
      IF length(v_label) NOT BETWEEN 1 AND 80 OR ((f ? 'minor') = (f ? 'bp')) THEN PERFORM fleet_econ_bad('each fee: a label (1..80) and exactly one of minor (fixed) or bp (of the subtotal)'); END IF;
      IF f ? 'minor' AND (jsonb_typeof(f -> 'minor') <> 'number' OR (f ->> 'minor')::numeric <> trunc((f ->> 'minor')::numeric) OR (f ->> 'minor')::numeric NOT BETWEEN 0 AND 1000000000)
        THEN PERFORM fleet_econ_bad('fee minor: whole minor units'); END IF;
      IF f ? 'bp' AND (jsonb_typeof(f -> 'bp') <> 'number' OR (f ->> 'bp')::numeric <> trunc((f ->> 'bp')::numeric) OR (f ->> 'bp')::numeric NOT BETWEEN 0 AND 10000)
        THEN PERFORM fleet_econ_bad('fee bp: whole basis points 0..10000'); END IF;
      v_fm := CASE WHEN f ? 'minor' THEN (f ->> 'minor')::bigint ELSE round(v_sub * (f ->> 'bp')::integer / 10000.0) END;
      v_feet := v_feet + v_fm;
      v_fees := v_fees || jsonb_build_array(jsonb_build_object('label', v_label, 'bp', (f ->> 'bp')::integer, 'minor', v_fm));
      v_txt := v_txt || format('%s%s: %s', v_label, CASE WHEN f ? 'bp' THEN format(' (%s%% of the subtotal)', rtrim(rtrim(((f ->> 'bp')::integer / 100.0)::text, '0'), '.')) ELSE '' END, fleet_money_text(v_fm, p_currency));
    END LOOP;
  END IF;
  IF p_tax IS NOT NULL AND jsonb_typeof(p_tax) <> 'null' THEN
    IF jsonb_typeof(p_tax) <> 'object' OR COALESCE(jsonb_typeof(p_tax -> 'bp'), 'missing') <> 'number' OR (p_tax ->> 'bp')::numeric <> trunc((p_tax ->> 'bp')::numeric)
       OR (p_tax ->> 'bp')::numeric NOT BETWEEN 0 AND 10000 THEN PERFORM fleet_econ_bad('tax: {label?, bp (2000 = 20%), inclusive?}'); END IF;
    v_bp := (p_tax ->> 'bp')::integer; v_incl := COALESCE((p_tax ->> 'inclusive')::boolean, false);
    v_label := COALESCE(NULLIF(btrim(p_tax ->> 'label'), ''), 'Tax');
    IF NOT v_incl THEN
      v_tax := round((v_sub + v_feet) * v_bp / 10000.0);
      v_txt := v_txt || format('%s %s%%: %s', v_label, rtrim(rtrim((v_bp / 100.0)::text, '0'), '.'), fleet_money_text(v_tax, p_currency));
    END IF;
  END IF;
  v_total := v_sub + v_feet + v_tax;
  IF v_incl THEN v_taxin := round(v_total * v_bp / (10000.0 + v_bp)); END IF;
  v_txt := v_txt || format('Total: %s', fleet_money_text(v_total, p_currency));
  IF v_incl THEN v_txt := v_txt || format('(includes %s %s%%: %s)', v_label, rtrim(rtrim((v_bp / 100.0)::text, '0'), '.'), fleet_money_text(v_taxin, p_currency)); END IF;
  RETURN jsonb_build_object('currency', p_currency, 'exponent', v_e, 'rounding', 'half-up (away from zero) to the minor unit, per line, discount, fee and tax',
    'lines', v_lines, 'subtotalMinor', v_sub, 'fees', v_fees, 'feesMinor', v_feet,
    'tax', CASE WHEN v_bp IS NULL THEN NULL ELSE jsonb_build_object('label', v_label, 'bp', v_bp, 'inclusive', v_incl, 'minor', CASE WHEN v_incl THEN v_taxin ELSE v_tax END) END,
    'totalMinor', v_total, 'text', array_to_string(v_txt, E'\\n'));
END $$;

ALTER TABLE fleet_customer_orders ADD COLUMN pricing jsonb CHECK (pricing IS NULL OR (jsonb_typeof(pricing) = 'object' AND pricing ? 'totalMinor'));

${QUOTE}

-- An invoice from the authoritative record only.
CREATE FUNCTION fleet_econ_order_invoice(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_customer_orders; c fleet_paypal_checkouts; s fleet_seller_identity; v_pricing jsonb; v_paid bigint; v_ref bigint; v_pend bigint; v_no text; v_txt text[];
BEGIN
  SELECT * INTO o FROM fleet_customer_orders WHERE order_id = fleet_op_uuid(a ->> 'orderId') AND agent_id = p_agent;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: orderId — one of your orders'; END IF;
  SELECT * INTO c FROM fleet_paypal_checkouts WHERE checkout_id = o.checkout_id;
  v_pricing := COALESCE(o.pricing, fleet_price_lines(o.currency, jsonb_build_array(jsonb_build_object('description', left(o.item, 200), 'quantity', 1, 'unitMinor', o.amount_minor)), NULL, NULL));
  IF (v_pricing ->> 'totalMinor')::bigint <> o.amount_minor THEN
    RAISE EXCEPTION 'FLEET_INVALID_STATE: the order''s pricing record (%) does not equal its amount (%)', v_pricing ->> 'totalMinor', o.amount_minor;
  END IF;
  v_paid := CASE WHEN c.status = 'captured' THEN c.amount_minor ELSE 0 END;
  SELECT COALESCE(sum(amount_minor) FILTER (WHERE status = 'completed'), 0), COALESCE(sum(amount_minor) FILTER (WHERE status IN ('requested','sent','pending')), 0)
    INTO v_ref, v_pend FROM fleet_paypal_refund_requests WHERE order_id = o.order_id;
  SELECT * INTO s FROM fleet_seller_identity ORDER BY set_at DESC LIMIT 1;
  v_no := 'INV-' || upper(left(replace(o.order_id::text, '-', ''), 10));
  v_txt := ARRAY['INVOICE ' || v_no, 'Issued: ' || to_char(now() AT TIME ZONE 'UTC', 'DD Mon YYYY'),
    'Seller: ' || COALESCE(s.trading_name || ' (' || s.legal_name || ')', s.legal_name, '(seller details not set)')
      || COALESCE(', ' || s.postal_address, '') || COALESCE(', VAT ' || s.vat_number, ''),
    'Billed to: ' || COALESCE(o.buyer_name, (SELECT q.buyer_name FROM fleet_offer_enquiries q WHERE q.enquiry_id = o.enquiry_id), o.buyer_email, 'the buyer'), 'Order: ' || o.order_id::text, '',
    v_pricing ->> 'text', '',
    'Paid: ' || fleet_money_text(v_paid, o.currency) || CASE WHEN v_paid > 0 THEN ' (PayPal)' ELSE ' (awaiting payment)' END];
  IF v_ref > 0 THEN v_txt := v_txt || ('Refunded: ' || fleet_money_text(v_ref, o.currency)); END IF;
  IF v_pend > 0 THEN v_txt := v_txt || ('Refund in progress: ' || fleet_money_text(v_pend, o.currency)); END IF;
  RETURN jsonb_build_object('ok', true, 'invoice', jsonb_build_object('number', v_no, 'orderId', o.order_id, 'currency', o.currency, 'pricing', v_pricing,
    'amountMinor', o.amount_minor, 'paidMinor', v_paid, 'refundedMinor', v_ref, 'refundPendingMinor', v_pend, 'text', array_to_string(v_txt, E'\\n')),
    'note', 'calculated from the order''s record; deliver it as it is (wallet invoice writes it to invoices/ in your workspace)');
END $$;

${DISPATCH}

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

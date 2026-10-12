/**
 * Schema v71 — AI-credit purchases: provisional observations, verified promotion (owner, 2026-10-12).
 *
 * The provider (Anthropic) exposes no interface for its credit balance, purchases or auto-reloads (its Admin API reports
 * usage and cost only, and is unavailable to individual accounts). Two signals are OBSERVED, never trusted on their own:
 *   - a provider purchase RECEIPT e-mailed to a Fleet mailbox (sender configured by the owner): receipt number + USD amount.
 *     Unauthenticated text → a provisional observation (`fleet_ai_credit_receipts`). It adds no provider credit, no lot, no
 *     owner liability and no amount anyone relies on.
 *   - a treasury PayPal DEBIT from Transaction Search (authenticated by PayPal) with its counterparty → provisional until
 *     linked to a purchase. No estimated purchase is ever created from a debit alone.
 * Promotion to confirmed credit (a lot + a provider-credit `purchase` event) needs evidence linking the provider purchase,
 * its amount and its funding source:
 *   - treasury_paypal route, automatic: exactly ONE receipt and exactly ONE debit match each other (counterparty pattern,
 *     time window and implied rate within tolerance are matching aids). The receipt gives the purchase number and USD; the
 *     debit gives the funding source and GBP. Any ambiguity (more than one candidate on either side) or no candidate after the
 *     window → reconciliation (P2), never a guess.
 *   - by the owner, for any route: `fleet_admin_ai_credit_confirm` (owner-funded, or treasury-funded naming the debit). The
 *     owner_card route always needs this confirmation: a receipt alone cannot establish who paid.
 * Usage beyond confirmed credit is recorded as an unallocated draw (it is owed to the owner by the v69 default, as before) and
 * is absorbed, oldest first, by the next confirmed purchase — a treasury purchase then reclassifies exactly that usage out
 * of the owner payable. Duplicates: one observation per receipt number; one lot per receipt and per debit — in either order.
 * Nothing buys or tops up credit: purchasing (including the provider's auto-reload) happens at the provider.
 */
import { V70_SQL, AI_CREDITS_ACCOUNT } from "./migrations-phase70.js";
import { KNOWLEDGE_FOUNDATION_V1 } from "./knowledge-foundation-v1.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const lit = (v: unknown) => `'${JSON.stringify(v).replace(/'/g, "''")}'`;
export const AI_CREDIT_ROUTES = ["owner_card", "treasury_paypal"] as const;
export const EVENT_ROUTES_V71 = Object.freeze({
  P2_IMPORTANT: ["ai_credit_reconcile", "ai_credit_receipt_unparsed", "ai_credit_treasury_insufficient"],
  P3_SUMMARY: ["ai_credit_receipt_observed", "ai_credit_purchase_confirmed", "ai_credit_policy_set"],
});
const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');`;
const WORKER = `IF p_worker IS NULL OR p_worker !~ '^[a-z0-9-]{3,40}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: worker name'; END IF;`;
const RATE = `COALESCE((SELECT rate_micro FROM fleet_fx_rates WHERE base = 'USD' AND quote = (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1)
   ORDER BY observed_on DESC, rate_id DESC LIMIT 1), 1000000)`;
/** A debit d is a candidate for receipt r (matching aids only): counterparty, window, implied rate. */
const CANDIDATE = (d: string, r: string, p: string) => `(${d}.status = 'S' AND ${d}.currency = v_ccy AND ${d}.amount_minor < 0 AND ${d}.attributed_at IS NULL AND ${d}.checkout_id IS NULL
     AND position(lower(${p}.counterparty_pattern) IN lower(COALESCE(${d}.counterparty, ''))) > 0
     AND ${d}.initiated_at BETWEEN ${r}.observed_at - make_interval(hours => ${p}.match_window_hours) AND ${r}.observed_at + make_interval(hours => ${p}.match_window_hours)
     AND abs((-(${d}.amount_minor + ${d}.fee_minor))::numeric * 1000000000000 / (${r}.usd_cents * 1000000) - v_rate) <= v_rate::numeric * ${p}.rate_tolerance_bp / 10000)`;

// Every draw records its GBP value; USD beyond every confirmed lot is recorded as an unallocated draw (lot_id NULL).
const DRAW = restateRaw(V70_SQL, "fleet_ai_credit_draw", [
  [`    v_micro := CASE WHEN l.source = 'treasury' THEN CEIL(v_take::numeric * v_rate / 1000000)::bigint ELSE 0 END;
    UPDATE fleet_ai_credit_lots SET usd_remaining = usd_remaining - v_take,
           reclass_micro = reclass_micro + CASE WHEN p_cause = 'consumption' THEN v_micro ELSE 0 END WHERE lot_id = l.lot_id;`,
   `    v_micro := CEIL(v_take::numeric * v_rate / 1000000)::bigint;
    UPDATE fleet_ai_credit_lots SET usd_remaining = usd_remaining - v_take,
           reclass_micro = reclass_micro + CASE WHEN p_cause = 'consumption' AND l.source = 'treasury' THEN v_micro ELSE 0 END WHERE lot_id = l.lot_id;`],
  [`  RETURN v_unexplained;`, `  IF v_left > 0 AND p_cause = 'consumption' THEN
    INSERT INTO fleet_ai_credit_draws (lot_id, usd, gbp_micro, cause, request_id) VALUES (NULL, v_left, CEIL(v_left::numeric * v_rate / 1000000)::bigint, p_cause, p_request);
  END IF;
  RETURN v_unexplained;`],
]);

const SETTLE = restateRaw(V70_SQL, "svc_ai_credit_settle", [
  [`DECLARE l fleet_ai_credit_lots; v_post bigint;`, `DECLARE v_detect jsonb; l fleet_ai_credit_lots; v_post bigint;`],
  [`BEGIN
  FOR l IN SELECT * FROM fleet_ai_credit_lots WHERE source = 'treasury' AND settled_at IS NULL`,
   `BEGIN
  v_detect := fleet_ai_credit_match();
  FOR l IN SELECT * FROM fleet_ai_credit_lots WHERE source = 'treasury' AND settled_at IS NULL`],
  [`  RETURN jsonb_build_object('ok', true, 'reclassifiedMinor', v_posted, 'lotsSettled', v_settled);`,
   `  RETURN jsonb_build_object('ok', true, 'reclassifiedMinor', v_posted, 'lotsSettled', v_settled, 'detection', v_detect);`],
]);

export const V71_SQL = `
CREATE TABLE fleet_ai_credit_policy (
  provider              text        PRIMARY KEY CHECK (provider ~ '^[a-z0-9_-]{2,40}$'),
  funding_route         text        NOT NULL CHECK (funding_route IN (${q(AI_CREDIT_ROUTES)})),
  receipt_sender        text        CHECK (receipt_sender ~ '^[a-z0-9._%+@-]{3,120}$'),
  counterparty_pattern  text        CHECK (length(counterparty_pattern) BETWEEN 3 AND 80),
  match_window_hours    integer     NOT NULL DEFAULT 72 CHECK (match_window_hours BETWEEN 1 AND 720),
  rate_tolerance_bp     integer     NOT NULL DEFAULT 800 CHECK (rate_tolerance_bp BETWEEN 50 AND 3000),
  auto_reload_threshold_usd_cents bigint CHECK (auto_reload_threshold_usd_cents > 0),
  auto_reload_to_usd_cents        bigint CHECK (auto_reload_to_usd_cents > 0),
  enabled               boolean     NOT NULL DEFAULT true,
  set_by                text        NOT NULL,
  set_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (funding_route <> 'treasury_paypal' OR counterparty_pattern IS NOT NULL)
);
CREATE TABLE fleet_ai_credit_policy_history (
  seq bigserial PRIMARY KEY, provider text NOT NULL, policy jsonb NOT NULL, set_by text NOT NULL, set_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_ai_credit_policy_history_no_change BEFORE UPDATE OR DELETE ON fleet_ai_credit_policy_history FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

ALTER TABLE fleet_paypal_transactions ADD COLUMN counterparty text CHECK (length(counterparty) <= 200);
ALTER TABLE fleet_ai_credit_draws ALTER COLUMN lot_id DROP NOT NULL;

-- Receipts observed in a Fleet mailbox: provisional until promoted (or rejected) — one per provider receipt number.
CREATE TABLE fleet_ai_credit_receipts (
  receipt_id   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     text        NOT NULL,
  receipt_no   text        NOT NULL CHECK (receipt_no ~ '^[A-Z0-9][A-Z0-9-]{3,39}$'),
  usd_cents    bigint      NOT NULL CHECK (usd_cents > 0 AND usd_cents <= 10000000),
  message_id   uuid,
  observed_at  timestamptz NOT NULL DEFAULT now(),
  state        text        NOT NULL DEFAULT 'provisional' CHECK (state IN ('provisional','ambiguous','unmatched','promoted','rejected')),
  lot_id       uuid        REFERENCES fleet_ai_credit_lots(lot_id),
  decided_by   text,
  decided_at   timestamptz,
  note         text        CHECK (length(note) <= 300),
  UNIQUE (provider, receipt_no),
  CHECK ((state = 'promoted') = (lot_id IS NOT NULL))
);
CREATE TRIGGER fleet_ai_credit_receipts_no_delete BEFORE DELETE ON fleet_ai_credit_receipts FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
-- Usage beyond confirmed credit, absorbed by the purchase that paid for it (oldest first).
CREATE TABLE fleet_ai_credit_absorptions (
  draw_id  bigint      PRIMARY KEY REFERENCES fleet_ai_credit_draws(draw_id),
  lot_id   uuid        NOT NULL REFERENCES fleet_ai_credit_lots(lot_id),
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_ai_credit_absorptions_no_change BEFORE UPDATE OR DELETE ON fleet_ai_credit_absorptions FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
-- Debits already reported for reconciliation (each reported once).
CREATE TABLE fleet_ai_credit_debit_notices (
  rail_id uuid NOT NULL, transaction_id text NOT NULL, event_code text NOT NULL, noted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rail_id, transaction_id, event_code)
);

CREATE FUNCTION cx_paypal_txn_counterparty(p_worker text, p_rail uuid, p_txn text, p_event_code text, p_counterparty text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  ${WORKER}
  UPDATE fleet_paypal_transactions SET counterparty = left(regexp_replace(COALESCE(p_counterparty, ''), '[[:cntrl:]]', ' ', 'g'), 200), updated_at = now()
   WHERE rail_id = p_rail AND transaction_id = p_txn AND event_code = p_event_code AND counterparty IS DISTINCT FROM left(p_counterparty, 200);
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE FUNCTION fleet_admin_ai_credit_policy_set(p_provider text, p_route text, p_receipt_sender text, p_counterparty text,
    p_threshold_usd_cents bigint, p_reload_to_usd_cents bigint, p_enabled boolean, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_ai_credit_policy;
BEGIN
  ${OWNER_ACTOR}
  IF p_route IS NULL OR p_route NOT IN (${q(AI_CREDIT_ROUTES)}) THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: route is owner_card or treasury_paypal'; END IF;
  INSERT INTO fleet_ai_credit_policy (provider, funding_route, receipt_sender, counterparty_pattern, auto_reload_threshold_usd_cents, auto_reload_to_usd_cents, enabled, set_by)
    VALUES (p_provider, p_route, lower(p_receipt_sender), p_counterparty, p_threshold_usd_cents, p_reload_to_usd_cents, COALESCE(p_enabled, true), p_actor)
  ON CONFLICT (provider) DO UPDATE SET funding_route = EXCLUDED.funding_route, receipt_sender = EXCLUDED.receipt_sender,
    counterparty_pattern = EXCLUDED.counterparty_pattern, auto_reload_threshold_usd_cents = EXCLUDED.auto_reload_threshold_usd_cents,
    auto_reload_to_usd_cents = EXCLUDED.auto_reload_to_usd_cents, enabled = EXCLUDED.enabled, set_by = EXCLUDED.set_by, set_at = now()
  RETURNING * INTO r;
  INSERT INTO fleet_ai_credit_policy_history (provider, policy, set_by) VALUES (p_provider, to_jsonb(r), p_actor);
  PERFORM fleet_event('ai_credit_policy_set', NULL, p_actor, jsonb_build_object('provider', p_provider, 'route', p_route, 'enabled', r.enabled));
  RETURN jsonb_build_object('ok', true, 'policy', to_jsonb(r));
END $$;

-- A provider receipt in a Fleet mailbox → a provisional observation only (parsed conservatively; never guessed).
CREATE FUNCTION fleet_ai_credit_receipt_trigger() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_ai_credit_policy; v_from text := lower(COALESCE(NEW.sender_address, NEW.sender, '')); v_amt text; v_no text; v_usd bigint;
BEGIN
  IF NEW.direction <> 'in' THEN RETURN NULL; END IF;
  FOR p IN SELECT * FROM fleet_ai_credit_policy WHERE enabled AND receipt_sender IS NOT NULL LOOP
    CONTINUE WHEN NOT (CASE WHEN left(p.receipt_sender, 1) = '@' THEN v_from LIKE '%' || p.receipt_sender || '%' ELSE position(p.receipt_sender IN v_from) > 0 END);
    CONTINUE WHEN NOT (NEW.subject ~* '(receipt|invoice|payment)');
    v_no := upper(substring(NEW.subject || ' ' || NEW.body FROM '(?i)(?:receipt|invoice)\\s*(?:number|no\\.?|#)\\s*[:#]?\\s*([A-Z0-9][A-Z0-9-]{3,39})'));
    v_amt := substring(NEW.body FROM '(?i)(?:amount paid|total|amount)[^$0-9]{0,40}\\$\\s?([0-9]{1,6}(?:,[0-9]{3})*\\.[0-9]{2})');
    IF v_no IS NULL OR v_amt IS NULL THEN
      PERFORM fleet_event('ai_credit_receipt_unparsed', NULL, 'identity', jsonb_build_object('provider', p.provider, 'messageId', NEW.message_id,
        'note', 'a mail from the provider''s receipt sender could not be read as a purchase: confirm it by hand if it is one'));
      CONTINUE;
    END IF;
    v_usd := (replace(v_amt, ',', '')::numeric * 100)::bigint;
    CONTINUE WHEN v_usd <= 0 OR v_usd > 10000000;
    INSERT INTO fleet_ai_credit_receipts (provider, receipt_no, usd_cents, message_id,
        state, lot_id, decided_by, decided_at, note)
      SELECT p.provider, v_no, v_usd, NEW.message_id,
        CASE WHEN l.lot_id IS NULL THEN 'provisional' ELSE 'promoted' END, l.lot_id,
        CASE WHEN l.lot_id IS NULL THEN NULL ELSE 'recorded before the receipt arrived' END, CASE WHEN l.lot_id IS NULL THEN NULL ELSE now() END, NULL
        FROM (SELECT NULL) x LEFT JOIN fleet_ai_credit_lots l ON l.external_ref = 'receipt:' || p.provider || ':' || v_no
    ON CONFLICT (provider, receipt_no) DO NOTHING;
    IF FOUND THEN
      PERFORM fleet_event('ai_credit_receipt_observed', NULL, 'identity', jsonb_build_object('provider', p.provider, 'receipt', v_no, 'usdCents', v_usd,
        'route', p.funding_route, 'state', 'provisional'));
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER fleet_ai_credit_receipts AFTER INSERT ON fleet_agent_mail FOR EACH ROW EXECUTE FUNCTION fleet_ai_credit_receipt_trigger();

-- Promote a receipt to confirmed credit. Treasury-funded needs its debit (the funding evidence); owner-funded is only
-- reachable through the owner's confirmation. Absorbs unallocated usage oldest first. One lot per receipt and per debit.
CREATE FUNCTION fleet_ai_credit_promote(p_receipt uuid, p_source text, t fleet_paypal_transactions, p_actor text, p_ledger_source text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_ai_credit_receipts; v_ref text; v_key text; v_gbp bigint; v_j uuid; v_lot uuid; d record; v_usd_left bigint; v_reclass bigint := 0;
BEGIN
  SELECT * INTO r FROM fleet_ai_credit_receipts WHERE receipt_id = p_receipt FOR UPDATE;
  IF r.receipt_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF r.state NOT IN ('provisional','ambiguous','unmatched') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ALREADY_CLAIMED', 'state', r.state); END IF;
  v_ref := 'receipt:' || r.provider || ':' || r.receipt_no;
  IF EXISTS (SELECT 1 FROM fleet_ai_credit_lots WHERE external_ref = v_ref) THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ALREADY_CLAIMED'); END IF;
  IF p_source = 'treasury' THEN
    v_key := 'paypal:txn:' || t.transaction_id;
    v_gbp := -(t.amount_minor + t.fee_minor);
    IF t.transaction_id IS NULL OR t.attributed_at IS NOT NULL OR fleet_claim_taken(v_key) OR EXISTS (SELECT 1 FROM fleet_ai_credit_lots WHERE claim_key = v_key)
       OR EXISTS (SELECT 1 FROM fleet_ledger_journal WHERE external_ref = v_key) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ALREADY_CLAIMED');
    END IF;
    IF fleet_ledger_balance('fleet:treasury:unallocated') < v_gbp THEN
      PERFORM fleet_event('ai_credit_treasury_insufficient', NULL, 'controller', jsonb_build_object('receiptId', p_receipt, 'gbpMinor', v_gbp, 'transactionId', t.transaction_id));
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_TREASURY_INSUFFICIENT');
    END IF;
    v_j := fleet_ledger_post('ai_credit_treasury_purchase', 'ai-credit:' || v_key, p_actor, 'AI provider credit bought with treasury money', p_ledger_source,
      NULL, NULL, NULL, v_key, NULL, now(), jsonb_build_array(
        jsonb_build_object('account', '${AI_CREDITS_ACCOUNT}', 'side', 'D', 'amount', v_gbp),
        jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', v_gbp)));
  END IF;
  INSERT INTO fleet_ai_credit_lots (provider, source, usd_purchased, usd_remaining, gbp_cost_minor, external_ref, claim_key, journal_id, recorded_by, purchased_at)
    VALUES (r.provider, p_source, r.usd_cents * 1000000, r.usd_cents * 1000000, CASE WHEN p_source = 'treasury' THEN v_gbp END, v_ref,
            CASE WHEN p_source = 'treasury' THEN v_key END, v_j, p_actor, r.observed_at)
    RETURNING lot_id INTO v_lot;
  -- usage that ran beyond confirmed credit was served by this purchase: absorb it, oldest first
  v_usd_left := r.usd_cents * 1000000;
  FOR d IN SELECT x.* FROM fleet_ai_credit_draws x WHERE x.lot_id IS NULL AND x.cause = 'consumption'
            AND NOT EXISTS (SELECT 1 FROM fleet_ai_credit_absorptions a WHERE a.draw_id = x.draw_id) ORDER BY x.draw_id LOOP
    EXIT WHEN d.usd > v_usd_left;
    INSERT INTO fleet_ai_credit_absorptions (draw_id, lot_id) VALUES (d.draw_id, v_lot);
    v_usd_left := v_usd_left - d.usd;
    v_reclass := v_reclass + d.gbp_micro;
  END LOOP;
  UPDATE fleet_ai_credit_lots SET usd_remaining = v_usd_left, reclass_micro = CASE WHEN p_source = 'treasury' THEN v_reclass ELSE 0 END WHERE lot_id = v_lot;
  INSERT INTO fleet_provider_credit_events (provider, kind, usd_microcents, external_ref, recorded_by)
    VALUES (r.provider, 'purchase', r.usd_cents * 1000000, v_ref, p_actor);
  IF p_source = 'treasury' THEN
    UPDATE fleet_paypal_transactions SET attributed_as = 'ai_credit_purchase', attributed_ref = v_key, attributed_by = p_actor, attributed_at = now(), updated_at = now()
     WHERE rail_id = t.rail_id AND transaction_id = t.transaction_id AND event_code = t.event_code AND initiated_at = t.initiated_at;
  END IF;
  UPDATE fleet_ai_credit_receipts SET state = 'promoted', lot_id = v_lot, decided_by = p_actor, decided_at = now() WHERE receipt_id = p_receipt;
  PERFORM fleet_event('ai_credit_purchase_confirmed', NULL, p_actor, jsonb_build_object('provider', r.provider, 'receipt', r.receipt_no, 'usdCents', r.usd_cents,
    'source', p_source, 'gbpMinor', v_gbp, 'lotId', v_lot));
  RETURN jsonb_build_object('ok', true, 'lotId', v_lot, 'source', p_source, 'usdCents', r.usd_cents, 'gbpMinor', v_gbp);
END $$;

-- Minutely: promote unambiguous receipt ↔ debit pairs on the treasury route; send everything else to reconciliation.
CREATE FUNCTION fleet_ai_credit_match() RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_ai_credit_policy; r fleet_ai_credit_receipts; t fleet_paypal_transactions; v_rate bigint := ${RATE}; v_ccy text; res jsonb;
        n_debits integer; n_receipts integer; v_promoted integer := 0; v_reconcile integer := 0;
BEGIN
  SELECT accounting_currency INTO v_ccy FROM fleet_economic_model WHERE id = 1;
  FOR p IN SELECT * FROM fleet_ai_credit_policy WHERE enabled AND funding_route = 'treasury_paypal' LOOP
    FOR r IN SELECT * FROM fleet_ai_credit_receipts WHERE provider = p.provider AND state IN ('provisional','ambiguous') ORDER BY observed_at LOOP
      SELECT count(*) INTO n_debits FROM fleet_paypal_transactions d WHERE ${CANDIDATE("d", "r", "p")};
      IF n_debits = 1 THEN
        SELECT d.* INTO t FROM fleet_paypal_transactions d WHERE ${CANDIDATE("d", "r", "p")};
        SELECT count(*) INTO n_receipts FROM fleet_ai_credit_receipts r2 WHERE r2.provider = p.provider AND r2.state IN ('provisional','ambiguous')
          AND (SELECT ${CANDIDATE("t", "r2", "p")});
        IF n_receipts = 1 THEN
          res := fleet_ai_credit_promote(r.receipt_id, 'treasury', t, 'controller', 'controller');
          IF (res ->> 'ok')::boolean THEN v_promoted := v_promoted + 1; END IF;
          CONTINUE;
        END IF;
      END IF;
      IF n_debits > 1 OR (n_debits = 1 AND n_receipts > 1) THEN
        IF r.state <> 'ambiguous' THEN
          UPDATE fleet_ai_credit_receipts SET state = 'ambiguous' WHERE receipt_id = r.receipt_id;
          PERFORM fleet_event('ai_credit_reconcile', NULL, 'controller', jsonb_build_object('receiptId', r.receipt_id, 'receipt', r.receipt_no, 'reason', 'ambiguous',
            'note', 'more than one treasury debit or receipt could match: confirm the right pair (economy-ai-credit-confirm)'));
          v_reconcile := v_reconcile + 1;
        END IF;
      ELSIF n_debits = 0 AND r.observed_at < now() - make_interval(hours => p.match_window_hours) THEN
        UPDATE fleet_ai_credit_receipts SET state = 'unmatched' WHERE receipt_id = r.receipt_id;
        PERFORM fleet_event('ai_credit_reconcile', NULL, 'controller', jsonb_build_object('receiptId', r.receipt_id, 'receipt', r.receipt_no, 'reason', 'no_debit',
          'note', 'no treasury debit matches this receipt: confirm who paid (economy-ai-credit-confirm … owner|treasury) or reject it'));
        v_reconcile := v_reconcile + 1;
      END IF;
    END LOOP;
    -- treasury debits to the provider with no receipt after the window: reported once, never turned into credit
    FOR t IN SELECT d.* FROM fleet_paypal_transactions d
              WHERE d.status = 'S' AND d.currency = v_ccy AND d.amount_minor < 0 AND d.attributed_at IS NULL AND d.checkout_id IS NULL
                AND position(lower(p.counterparty_pattern) IN lower(COALESCE(d.counterparty, ''))) > 0
                AND d.initiated_at < now() - make_interval(hours => p.match_window_hours)
                AND NOT EXISTS (SELECT 1 FROM fleet_ai_credit_debit_notices nd WHERE nd.rail_id = d.rail_id AND nd.transaction_id = d.transaction_id AND nd.event_code = d.event_code)
              LIMIT 20 LOOP
      INSERT INTO fleet_ai_credit_debit_notices (rail_id, transaction_id, event_code) VALUES (t.rail_id, t.transaction_id, t.event_code);
      PERFORM fleet_event('ai_credit_reconcile', NULL, 'controller', jsonb_build_object('transactionId', t.transaction_id, 'gbpMinor', -(t.amount_minor + t.fee_minor),
        'reason', 'debit_without_receipt', 'note', 'a treasury payment to the provider has no receipt: confirm the purchase with its receipt (economy-ai-credit-confirm) — nothing is assumed'));
      v_reconcile := v_reconcile + 1;
    END LOOP;
  END LOOP;
  RETURN jsonb_build_object('promoted', v_promoted, 'reconcile', v_reconcile);
END $$;

-- Owner: confirm a receipt's purchase — owner-funded, or treasury-funded naming its debit. Resolves ambiguity.
CREATE FUNCTION fleet_admin_ai_credit_confirm(p_receipt uuid, p_source text, p_rail uuid, p_txn text, p_event_code text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE t fleet_paypal_transactions; v_ccy text;
BEGIN
  ${OWNER_ACTOR}
  IF p_source NOT IN ('owner','treasury') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: funding is owner or treasury'; END IF;
  IF p_source = 'treasury' THEN
    SELECT * INTO t FROM fleet_paypal_transactions WHERE rail_id = p_rail AND transaction_id = p_txn AND event_code = p_event_code ORDER BY initiated_at DESC LIMIT 1 FOR UPDATE;
    SELECT accounting_currency INTO v_ccy FROM fleet_economic_model WHERE id = 1;
    IF t.transaction_id IS NULL OR t.status <> 'S' OR t.currency <> v_ccy OR t.amount_minor >= 0 OR t.checkout_id IS NOT NULL THEN
      RAISE EXCEPTION 'FLEET_BAD_REQUEST: treasury funding needs a completed treasury debit in %', COALESCE(v_ccy, 'GBP');
    END IF;
  END IF;
  RETURN fleet_ai_credit_promote(p_receipt, p_source, t, p_actor, 'owner');
END $$;

-- Owner: this observation is not a purchase.
CREATE FUNCTION fleet_admin_ai_credit_reject(p_receipt uuid, p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  ${OWNER_ACTOR}
  UPDATE fleet_ai_credit_receipts SET state = 'rejected', decided_by = p_actor, decided_at = now(), note = left(p_reason, 300)
   WHERE receipt_id = p_receipt AND state IN ('provisional','ambiguous','unmatched');
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no open receipt observation with that id'; END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

ALTER TABLE fleet_ledger_kinds DISABLE TRIGGER fleet_ledger_kinds_no_change;
UPDATE fleet_ledger_kinds SET allowed_sources = ARRAY['owner','controller'] WHERE kind = 'ai_credit_treasury_purchase';
ALTER TABLE fleet_ledger_kinds ENABLE TRIGGER fleet_ledger_kinds_no_change;

${DRAW}

${SETTLE}

${restateRaw(V70_SQL, "fleet_ai_credit_status", [
  [`    'note', 'Owner-funded credit is owed`, `    'policy', (SELECT jsonb_object_agg(provider, to_jsonb(p) - 'provider') FROM fleet_ai_credit_policy p),
    'unallocatedUsageUsdMicrocents', (SELECT COALESCE(sum(usd), 0) FROM fleet_ai_credit_draws x WHERE x.lot_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM fleet_ai_credit_absorptions a WHERE a.draw_id = x.draw_id)),
    'observations', COALESCE((SELECT jsonb_agg(jsonb_build_object('receiptId', receipt_id, 'provider', provider, 'receipt', receipt_no, 'usdCents', usd_cents,
        'state', state, 'observedAt', observed_at) ORDER BY observed_at DESC) FROM (SELECT * FROM fleet_ai_credit_receipts ORDER BY observed_at DESC LIMIT 50) o), '[]'::jsonb),
    'note', 'Receipts and unmatched debits are provisional observations; only confirmed purchases are credit. Owner-funded credit is owed`],
])}

${restateRaw(V70_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V71) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
])}

-- The dated capability entry, version 3 (AI cost attribution corrected: owner conversations are paid by the treasury).
SELECT fleet_admin_knowledge_library_load(${lit({ entries: KNOWLEDGE_FOUNDATION_V1.entries.filter((e) => e.id === "fleet-capability-status") })}::jsonb, 'migration');

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

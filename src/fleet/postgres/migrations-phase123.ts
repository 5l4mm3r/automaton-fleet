/**
 * Schema v123 — Treasury Watch (owner, 2026-10-30: "the running Fleet detects and explains treasury movements without me reporting
 * each one"; docs/design/treasury-watch.md). Code, not paid model calls. Runs in the controller; needs no engineer session.
 *
 * 1. Every PayPal row custody reports becomes one `fleet_treasury_movements` row (append-only history beside it): direction, type,
 *    provider status, provenance, accounting status and the action needed.
 * 2. Classification uses PayPal's published event codes. A positive row with no checkout is NOT assumed to be owner funding.
 * 3. Auto-booking is OFF until the owner names the rail (`fleet_admin_treasury_watch_policy_set`). When on, it books a settled top-up
 *    as owner funding only when every test in fleet_treasury_topup_check passes. It uses the same journal kind and external reference
 *    as the manual route (`stage2-proof.sh fund`), so the ledger's unique (kind, external_ref) refuses a second booking either way.
 * 4. A booked deposit that PayPal later reverses is taken back through `owner_funding_returned`: unallocated first, then the rest in
 *    the shortfall account (fleet_treasury_shortfall_settle fills it from later money). No wallet is touched and no money is invented.
 * 5. The position gains sync freshness, restricted funds, movements and alerts; Fleet Control's spend review gets a small treasury
 *    projection as context; the operator API gets one read-only route. No spending gate changes (proposal in the design note).
 *
 * A note on labels: `fleet_paypal_clawback_evidence.source = 'webhook'` means "not Transaction Search": cx_paypal_refund_result and the
 * order audit write it too. Only `fleet_paypal_webhook_inbox` shows what webhook deliveries arrived.
 */
import { V76_SQL } from "./migrations-phase76.js";
import { V98_SQL } from "./migrations-phase98.js";
import { V117_SQL } from "./migrations-phase117.js";
import { V121_SQL } from "./migrations-phase121.js";
import { V122_SQL } from "./migrations-phase122.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));
const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

/** Search runs every 15 minutes: this long without a good read means receipts on screen cannot be relied on. */
export const PAYPAL_SEARCH_STALE_MINUTES = 120;
/** PayPal documents "a maximum of three hours"; measured here up to 3 h 34. Past this its data is late, not merely delayed. */
export const PAYPAL_DATA_STALE_HOURS = 6;
/** The periodic backfill reads one slice a day: older than this means it has stopped. */
export const PAYPAL_BACKFILL_STALE_HOURS = 72;
/** Candidate top-up codes when the owner turns auto-booking on. PayPal publishes T0300 as "Bank deposit to PayPal account" and T0700 as
 *  "General credit card deposit"; it publishes no code for a debit-card top-up, so a different code stays for review. */
export const TREASURY_TOPUP_CODES_DEFAULT = ["T0300", "T0700"] as const;
/** A pending top-up waits this long after first being seen, so a paired outgoing leg (a card funding a purchase) can arrive. */
export const TREASURY_TOPUP_MIN_AGE_MINUTES = 30;
/** A candidate still lacking balance evidence after this long stops waiting and asks for a look. */
export const TREASURY_EVIDENCE_WAIT_HOURS = 24;
export const TREASURY_DIFFERENCE_GRACE_HOURS = 6;
export const TREASURY_AUTO_BOOK_MAX_MINOR = 50_000;
export const TREASURY_MATERIAL_OUT_MINOR = 500;
export const OWNER_FUNDING_RETURNED_KIND = "owner_funding_returned";
export const TREASURY_ACCOUNTING_STATUSES = ["none_required", "linked", "pending", "awaiting_evidence", "booked", "recorded", "needs_review", "held", "denied",
  "reversed", "reversal_shortfall", "reversal_review"] as const;
const SHORTFALL = "fleet:treasury:shortfall";

export const EVENT_ROUTES_V123 = Object.freeze({
  P0_CRITICAL: ["treasury_reversal_shortfall"],
  P1_HIGH: ["treasury_movement_needs_review", "treasury_balance_unexplained", "treasury_sync_problem", "treasury_funding_reversed"],
  P2_IMPORTANT: ["treasury_funding_booked", "treasury_outgoing_recorded"],
  P3_SUMMARY: ["treasury_movement_recorded"],
  AUDIT_ONLY: ["treasury_watch_policy_set"],
});

export const V123_SQL = `
-- ═══ 1. What custody keeps from PayPal, and the sync kinds ═══
ALTER TABLE fleet_paypal_transactions ADD COLUMN evidence jsonb CHECK (evidence IS NULL OR (jsonb_typeof(evidence) = 'object' AND length(evidence::text) <= 1000));
COMMENT ON COLUMN fleet_paypal_transactions.evidence IS 'v123: payerPresent, payerIsSelf, referenceId, referenceType, instrumentType, instrumentSubType (never a name or address)';

${restate(V76_SQL, "cx_paypal_txn_record", [
  [`  INSERT INTO fleet_paypal_transactions (rail_id, transaction_id, event_code, initiated_at, status, amount_minor, fee_minor, currency, invoice_id, custom_field, checkout_id)`,
   `  INSERT INTO fleet_paypal_transactions (rail_id, transaction_id, event_code, initiated_at, status, amount_minor, fee_minor, currency, invoice_id, custom_field, checkout_id, evidence)`],
  [`(p_txn ->> 'amountMinor')::bigint, COALESCE((p_txn ->> 'feeMinor')::bigint, 0), p_txn ->> 'currency', v_invoice, v_custom, v_checkout)`,
   `(p_txn ->> 'amountMinor')::bigint, COALESCE((p_txn ->> 'feeMinor')::bigint, 0), p_txn ->> 'currency', v_invoice, v_custom, v_checkout,
            CASE WHEN jsonb_typeof(p_txn -> 'evidence') = 'object' AND length((p_txn -> 'evidence')::text) <= 1000 THEN p_txn -> 'evidence' END)`],
  [`fee_minor = EXCLUDED.fee_minor, checkout_id = COALESCE(fleet_paypal_transactions.checkout_id, EXCLUDED.checkout_id), updated_at = now()`,
   `fee_minor = EXCLUDED.fee_minor, checkout_id = COALESCE(fleet_paypal_transactions.checkout_id, EXCLUDED.checkout_id),
    evidence = COALESCE(EXCLUDED.evidence, fleet_paypal_transactions.evidence), updated_at = now()`],
])}

ALTER TABLE fleet_paypal_sync_status DROP CONSTRAINT fleet_paypal_sync_status_kind_check;
ALTER TABLE fleet_paypal_sync_status ADD CONSTRAINT fleet_paypal_sync_status_kind_check CHECK (kind IN ('transaction_search','order_audit','token_scopes','balances','backfill'));
${restate(V98_SQL, "cx_paypal_sync_record", [
  [`IF p_kind NOT IN ('transaction_search','order_audit','token_scopes') OR`, `IF p_kind NOT IN ('transaction_search','order_audit','token_scopes','balances','backfill') OR`],
])}

-- ═══ 2. The accounting path a reversed deposit takes ═══
ALTER TABLE fleet_ledger_kinds DISABLE TRIGGER fleet_ledger_kinds_no_change;
INSERT INTO fleet_ledger_kinds (kind, requires_external_ref, allowed_sources, multi_agent, description, provenance) VALUES
  ('${OWNER_FUNDING_RETURNED_KIND}', true, ARRAY['executor'], false, 'A deposit booked as owner funding that the provider reversed: the capital credit is undone from unallocated cash, and any part already spent stays open in the treasury shortfall', 'correction');
ALTER TABLE fleet_ledger_kinds ENABLE TRIGGER fleet_ledger_kinds_no_change;
INSERT INTO fleet_ledger_rules (kind, class, side) VALUES
  ('${OWNER_FUNDING_RETURNED_KIND}','owner_capital','D'), ('${OWNER_FUNDING_RETURNED_KIND}','treasury_cash','C'), ('${OWNER_FUNDING_RETURNED_KIND}','treasury_shortfall','C')
ON CONFLICT DO NOTHING;

-- ═══ 3. Policy, movements, history ═══
CREATE TABLE fleet_treasury_watch_policy (
  id                  smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  auto_book_enabled   boolean     NOT NULL DEFAULT false,
  auto_book_rail      uuid        REFERENCES fleet_payment_rails(rail_id),
  auto_book_from      timestamptz,
  auto_book_codes     text[]      NOT NULL DEFAULT ARRAY[${q(TREASURY_TOPUP_CODES_DEFAULT)}]::text[] CHECK (auto_book_codes <@ ARRAY['T0300','T0303','T0700']::text[]),
  auto_book_max_minor bigint      NOT NULL DEFAULT ${TREASURY_AUTO_BOOK_MAX_MINOR} CHECK (auto_book_max_minor > 0),
  material_out_minor  bigint      NOT NULL DEFAULT ${TREASURY_MATERIAL_OUT_MINOR} CHECK (material_out_minor > 0),
  updated_by          text        NOT NULL DEFAULT 'migration',
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT auto_book_enabled OR (auto_book_rail IS NOT NULL AND auto_book_from IS NOT NULL))
);
INSERT INTO fleet_treasury_watch_policy (id) VALUES (1);

CREATE TABLE fleet_treasury_watch_state (
  id                smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_tick_at      timestamptz,
  last_error        text        CHECK (length(last_error) <= 300),
  last_error_at     timestamptz,
  difference_since  timestamptz,
  difference_minor  bigint
);
INSERT INTO fleet_treasury_watch_state (id) VALUES (1);

CREATE TABLE fleet_treasury_movements (
  movement_id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  rail_id             uuid        NOT NULL REFERENCES fleet_payment_rails(rail_id),
  transaction_id      text        NOT NULL,
  event_code          text        NOT NULL,
  initiated_at        timestamptz NOT NULL,
  direction           text        NOT NULL CHECK (direction IN ('in','out','none')),
  amount_minor        bigint      NOT NULL,
  fee_minor           bigint      NOT NULL,
  currency            text        NOT NULL,
  provider_status     text        NOT NULL,
  classification      text        NOT NULL CHECK (length(classification) <= 60),
  accounting_status   text        NOT NULL CHECK (accounting_status IN (${q(TREASURY_ACCOUNTING_STATUSES)})),
  rule                text        CHECK (length(rule) <= 300),
  action              text        CHECK (length(action) <= 300),
  journal_id          uuid,
  return_journal_id   uuid,
  shortfall_minor     bigint      NOT NULL DEFAULT 0 CHECK (shortfall_minor >= 0),
  seeded              boolean     NOT NULL DEFAULT false,
  last_error          text        CHECK (length(last_error) <= 300),
  first_seen_at       timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rail_id, transaction_id, event_code, initiated_at)
);
CREATE INDEX fleet_treasury_movements_recent ON fleet_treasury_movements (initiated_at DESC);

CREATE TABLE fleet_treasury_movement_history (
  history_id   bigserial   PRIMARY KEY,
  movement_id  uuid        NOT NULL REFERENCES fleet_treasury_movements(movement_id),
  at           timestamptz NOT NULL DEFAULT now(),
  from_status  text,
  to_status    text        NOT NULL,
  provider_status text     NOT NULL,
  classification text      NOT NULL,
  rule         text,
  journal_id   uuid
);
CREATE FUNCTION fleet_treasury_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: treasury movement history cannot change'; END $$;
CREATE TRIGGER fleet_treasury_movement_history_guard BEFORE UPDATE OR DELETE ON fleet_treasury_movement_history FOR EACH ROW EXECUTE FUNCTION fleet_treasury_history_immutable();
CREATE TRIGGER fleet_treasury_movement_history_no_truncate BEFORE TRUNCATE ON fleet_treasury_movement_history FOR EACH STATEMENT EXECUTE FUNCTION fleet_treasury_history_immutable();

-- ═══ 4. Classification: PayPal's published codes; nothing is assumed from the sign alone ═══
CREATE FUNCTION fleet_treasury_classify(t fleet_paypal_transactions, p fleet_treasury_watch_policy) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c text := t.event_code; a bigint := t.amount_minor; v_class text; v_action text;
BEGIN
  IF c ~ '^T98' OR a = 0 THEN RETURN jsonb_build_object('class', 'display_only', 'status', 'none_required'); END IF;
  IF t.checkout_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'linked', 'class', CASE
      WHEN c = 'T1107' THEN 'sale_refund' WHEN c IN ('T1106','T1201') THEN 'sale_reversal' WHEN c = 'T1202' THEN 'sale_reversal_return'
      WHEN c = 'T0106' THEN 'sale_chargeback_fee' WHEN c IN ('T1108','T1109') THEN 'sale_fee_return' WHEN c IN ('T1110','T1111') THEN 'sale_dispute_hold'
      WHEN a > 0 AND c ~ '^T00' THEN 'sale' WHEN a < 0 THEN 'sale_debit_unclassified' ELSE 'sale_other' END);
  END IF;
  IF t.attributed_at IS NOT NULL THEN RETURN jsonb_build_object('class', 'attributed_' || t.attributed_as, 'status', 'recorded'); END IF;
  IF EXISTS (SELECT 1 FROM fleet_location_transfers x WHERE x.source_evidence = 'paypal:' || t.transaction_id OR x.arrival_evidence = 'paypal:' || t.transaction_id) THEN
    RETURN jsonb_build_object('class', 'location_transfer', 'status', 'recorded');
  END IF;
  IF c = 'T1105' OR c ~ '^T15' OR c ~ '^T21' OR c IN ('T1110','T1111') THEN
    RETURN jsonb_build_object('class', 'hold_or_release', 'status', 'held', 'action', 'PayPal holds or released money outside any sale: check the hold in PayPal; nothing was booked');
  END IF;
  IF a > 0 THEN
    IF c = ANY (p.auto_book_codes) THEN RETURN jsonb_build_object('class', 'top_up', 'status', 'candidate'); END IF;
    v_class := CASE WHEN c ~ '^T0[37]' THEN 'funding_other_code' WHEN c ~ '^T00' THEN 'incoming_payment' ELSE 'incoming_unknown' END;
    v_action := 'money arrived that the Fleet cannot identify: say what it was (economy-paypal-attribute); it is not in any balance until then';
  ELSE
    v_class := CASE WHEN c ~ '^T04' THEN 'withdrawal' WHEN c IN ('T1100','T1104','T1106','T1201','T1203','T0600') THEN 'reversal_candidate' WHEN c = 'T1107' THEN 'refund_unlinked'
                    WHEN c ~ '^T00' THEN 'outgoing_payment' WHEN c ~ '^T01' THEN 'fee_unlinked' WHEN c ~ '^T02' THEN 'currency_conversion' WHEN c ~ '^T20' THEN 'transfer' ELSE 'outgoing_unknown' END;
    v_action := 'money left that the Fleet did not initiate or cannot match: check it in PayPal and record what it was (economy-paypal-attribute)';
  END IF;
  RETURN jsonb_build_object('class', v_class, 'status', 'needs_review', 'action', v_action);
END $$;

-- The explicit rule for booking a top-up by itself. Outcome: 'book', 'wait' (evidence may yet arrive) or 'review', with the reason.
CREATE FUNCTION fleet_treasury_topup_check(t fleet_paypal_transactions, p fleet_treasury_watch_policy) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_net bigint := t.amount_minor + LEAST(t.fee_minor, 0); v_ref text := 'paypal:' || left(t.rail_id::text, 8) || ':' || t.transaction_id; ev jsonb := COALESCE(t.evidence, '{}'::jsonb);
        cb jsonb := fleet_capital_backing(); v_ccy text; v_diff bigint; v_avail bigint; v_obs timestamptz;
BEGIN
  SELECT accounting_currency INTO v_ccy FROM fleet_economic_model WHERE id = 1;
  IF NOT p.auto_book_enabled THEN RETURN jsonb_build_object('outcome', 'review', 'reason', 'auto-booking is off'); END IF;
  IF p.auto_book_rail IS DISTINCT FROM t.rail_id THEN RETURN jsonb_build_object('outcome', 'review', 'reason', 'not the rail named for auto-booking'); END IF;
  IF t.initiated_at < p.auto_book_from THEN RETURN jsonb_build_object('outcome', 'review', 'reason', 'older than the auto-booking start'); END IF;
  IF t.currency IS DISTINCT FROM v_ccy THEN RETURN jsonb_build_object('outcome', 'review', 'reason', 'not in the accounting currency'); END IF;
  IF t.fee_minor > 0 OR v_net <= 0 THEN RETURN jsonb_build_object('outcome', 'review', 'reason', 'its net amount is not positive'); END IF;
  IF v_net > p.auto_book_max_minor THEN RETURN jsonb_build_object('outcome', 'review', 'reason', 'above the auto-booking limit'); END IF;
  IF t.evidence IS NULL THEN RETURN jsonb_build_object('outcome', 'review', 'reason', 'no provenance evidence from custody'); END IF;
  IF COALESCE((ev ->> 'payerPresent')::boolean, true) AND NOT COALESCE((ev ->> 'payerIsSelf')::boolean, false) THEN
    RETURN jsonb_build_object('outcome', 'review', 'reason', 'PayPal names a payer that is not shown to be this account');
  END IF;
  IF ev ->> 'referenceId' IS NOT NULL THEN RETURN jsonb_build_object('outcome', 'review', 'reason', 'it refers to another transaction'); END IF;
  IF EXISTS (SELECT 1 FROM fleet_paypal_transactions x WHERE x.evidence ->> 'referenceId' = t.transaction_id) THEN
    RETURN jsonb_build_object('outcome', 'review', 'reason', 'another transaction refers to it');
  END IF;
  -- A card or bank funding a purchase shows the same deposit paired with money leaving: that is not funding.
  IF EXISTS (SELECT 1 FROM fleet_paypal_transactions x WHERE x.rail_id = t.rail_id AND x.amount_minor = -t.amount_minor AND x.currency = t.currency AND x.attributed_at IS NULL
              AND x.initiated_at BETWEEN t.initiated_at - interval '1 hour' AND t.initiated_at + interval '1 hour') THEN
    RETURN jsonb_build_object('outcome', 'review', 'reason', 'an equal amount left at about the same time');
  END IF;
  IF EXISTS (SELECT 1 FROM fleet_location_transfers x WHERE x.state = 'in_transit' AND x.amount_minor = t.amount_minor) THEN
    RETURN jsonb_build_object('outcome', 'review', 'reason', 'a transfer of that amount is on its way: this may be its arrival');
  END IF;
  IF fleet_claim_taken(v_ref) OR fleet_provider_reference_known(v_ref) THEN RETURN jsonb_build_object('outcome', 'review', 'reason', 'its reference is already claimed'); END IF;
  IF EXISTS (SELECT 1 FROM fleet_paypal_transactions x WHERE x.rail_id = t.rail_id AND x.transaction_id = t.transaction_id AND x.event_code <> t.event_code AND x.amount_minor <> 0) THEN
    RETURN jsonb_build_object('outcome', 'review', 'reason', 'PayPal reports this id under another code as well');
  END IF;
  IF t.first_seen_at > now() - interval '${TREASURY_TOPUP_MIN_AGE_MINUTES} minutes' THEN RETURN jsonb_build_object('outcome', 'wait', 'reason', 'waiting for any paired movement to arrive'); END IF;
  -- The provider's own balance must already hold it, beyond what the books know.
  v_diff := (cb ->> 'differenceMinor')::bigint;
  v_avail := (cb #>> '{paypal,availableMinor}')::bigint;
  v_obs := (cb #>> '{paypal,observedAt}')::timestamptz;
  IF cb ->> 'differenceScope' IS NOT NULL AND v_diff IS NULL THEN RETURN jsonb_build_object('outcome', 'review', 'reason', 'the books cannot be compared with PayPal alone (another money location is active)'); END IF;
  IF v_obs IS NULL OR v_obs <= t.initiated_at OR v_diff IS NULL OR v_diff < v_net OR v_avail < v_net THEN
    RETURN jsonb_build_object('outcome', 'wait', 'reason', 'PayPal''s available balance does not yet show this money');
  END IF;
  RETURN jsonb_build_object('outcome', 'book', 'reason', 'settled top-up on the named account; balance evidence holds', 'netMinor', v_net, 'ref', v_ref);
END $$;

-- A booked deposit PayPal reversed: undone once, from unallocated first; the rest stays open as a shortfall (never invented, never hidden).
CREATE FUNCTION fleet_treasury_funding_return(p_ref text, p_reason text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_ledger_journal; v_net bigint; v_free bigint; v_take bigint; v_short bigint; v_id uuid; v_lines jsonb; v_prior fleet_ledger_journal;
BEGIN
  SELECT * INTO j FROM fleet_ledger_journal WHERE kind = 'owner_funding' AND external_ref = p_ref;
  IF j.journal_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  SELECT * INTO v_prior FROM fleet_ledger_journal WHERE kind = '${OWNER_FUNDING_RETURNED_KIND}' AND external_ref = 'return:' || p_ref;
  IF v_prior.journal_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'replay', true, 'journalId', v_prior.journal_id, 'shortfallMinor',
      COALESCE((SELECT amount_cents FROM fleet_ledger_postings WHERE journal_id = v_prior.journal_id AND account_id = '${SHORTFALL}' AND side = 'C'), 0));
  END IF;
  SELECT COALESCE(sum(amount_cents), 0) INTO v_net FROM fleet_ledger_postings WHERE journal_id = j.journal_id AND account_id = 'fleet:owner:capital' AND side = 'C';
  PERFORM 1 FROM fleet_ledger_accounts WHERE account_id IN ('fleet:treasury:unallocated', '${SHORTFALL}') ORDER BY account_id FOR UPDATE;
  v_free := GREATEST(fleet_ledger_balance('fleet:treasury:unallocated'), 0);
  v_take := LEAST(v_free, v_net);
  v_short := v_net - v_take;
  v_lines := jsonb_build_array(jsonb_build_object('account', 'fleet:owner:capital', 'side', 'D', 'amount', v_net));
  IF v_take > 0 THEN v_lines := v_lines || jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', v_take); END IF;
  IF v_short > 0 THEN v_lines := v_lines || jsonb_build_object('account', '${SHORTFALL}', 'side', 'C', 'amount', v_short); END IF;
  v_id := fleet_ledger_post('${OWNER_FUNDING_RETURNED_KIND}', 'treasury-watch:return:' || p_ref, 'treasury-watch', left(p_reason, 200), 'executor', NULL, NULL, NULL, 'return:' || p_ref, NULL, now(), v_lines);
  RETURN jsonb_build_object('ok', true, 'journalId', v_id, 'returnedMinor', v_net, 'shortfallMinor', v_short);
END $$;

CREATE FUNCTION fleet_treasury_money(p_minor bigint, p_ccy text) RETURNS text LANGUAGE sql IMMUTABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$ SELECT COALESCE(p_ccy, '') || ' ' || to_char(p_minor / 100.0, 'FM999999990.00') $$;

-- One row: classify, apply the state machine, keep history, tell whoever needs telling. Safe to run any number of times, in any order.
CREATE FUNCTION fleet_treasury_movement_eval(t fleet_paypal_transactions, p fleet_treasury_watch_policy, p_seed boolean) RETURNS text LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE m fleet_treasury_movements; c jsonb := fleet_treasury_classify(t, p); v_class text := c ->> 'class'; v_status text := c ->> 'status'; v_action text := c ->> 'action'; v_rule text;
        v_ref text := 'paypal:' || left(t.rail_id::text, 8) || ':' || t.transaction_id; v_journal uuid; v_return uuid; v_short bigint := 0; r jsonb; v_target text; v_tref text; v_prev text;
        v_new boolean; v_dir text := CASE WHEN t.amount_minor > 0 THEN 'in' WHEN t.amount_minor < 0 THEN 'out' ELSE 'none' END; v_detail jsonb; v_tj fleet_ledger_journal; v_gross bigint;
BEGIN
  SELECT * INTO m FROM fleet_treasury_movements x WHERE x.rail_id = t.rail_id AND x.transaction_id = t.transaction_id AND x.event_code = t.event_code AND x.initiated_at = t.initiated_at FOR UPDATE;
  v_new := m.movement_id IS NULL;
  SELECT journal_id INTO v_journal FROM fleet_ledger_journal WHERE kind = 'owner_funding' AND external_ref = v_ref;
  v_return := m.return_journal_id; v_short := COALESCE(m.shortfall_minor, 0);

  IF t.status = 'D' THEN
    IF v_journal IS NULL THEN v_status := 'denied'; v_action := NULL; v_rule := 'PayPal denied this transaction'; END IF;
  ELSIF t.status = 'P' THEN
    IF v_status <> 'linked' AND v_journal IS NULL THEN v_status := 'pending'; v_action := NULL; v_rule := 'PayPal has not settled it; nothing is booked yet'; END IF;
  ELSIF t.status NOT IN ('S','V') THEN
    v_status := 'needs_review'; v_rule := 'an unknown PayPal status'; v_action := 'PayPal reports a status the Fleet does not know: check this transaction in PayPal';
  END IF;

  -- Money PayPal took back from a deposit: the row itself reversed, or a debit naming it.
  IF t.status = 'V' AND v_journal IS NULL THEN
    v_status := CASE WHEN t.checkout_id IS NOT NULL THEN 'linked' ELSE 'reversed' END; v_action := NULL; v_rule := 'reversed before anything was booked';
  ELSIF t.status IN ('V','D') AND v_journal IS NOT NULL THEN
    r := fleet_treasury_funding_return(v_ref, 'PayPal reversed ' || t.transaction_id);
    v_return := (r ->> 'journalId')::uuid; v_short := COALESCE((r ->> 'shortfallMinor')::bigint, 0);
    v_status := CASE WHEN v_short > 0 THEN 'reversal_shortfall' ELSE 'reversed' END;
    v_rule := 'the booked funding was undone'; v_action := CASE WHEN v_short > 0 THEN 'the deposit was reversed after its money was used: the shortfall stays open until new money fills it' END;
  ELSIF v_journal IS NOT NULL THEN
    v_status := CASE WHEN COALESCE(t.attributed_by, '') = 'treasury-watch' THEN 'booked' ELSE 'recorded' END; v_action := NULL;
    v_rule := 'booked as owner funding';
  ELSIF v_class = 'reversal_candidate' AND t.status = 'S' THEN
    v_target := t.evidence ->> 'referenceId';
    IF v_target IS NOT NULL THEN
      v_tref := 'paypal:' || left(t.rail_id::text, 8) || ':' || v_target;
      SELECT * INTO v_tj FROM fleet_ledger_journal WHERE kind = 'owner_funding' AND external_ref = v_tref;
      IF v_tj.journal_id IS NOT NULL THEN
        SELECT COALESCE(sum(amount_minor), 0) INTO v_gross FROM fleet_paypal_transactions x WHERE x.rail_id = t.rail_id AND x.transaction_id = v_target AND x.amount_minor > 0;
        IF -t.amount_minor = v_gross THEN
          r := fleet_treasury_funding_return(v_tref, 'PayPal reversal ' || t.transaction_id || ' of ' || v_target);
          v_return := (r ->> 'journalId')::uuid; v_short := COALESCE((r ->> 'shortfallMinor')::bigint, 0);
          v_class := 'funding_reversal'; v_status := CASE WHEN v_short > 0 THEN 'reversal_shortfall' ELSE 'reversed' END; v_rule := 'reverses funded transaction ' || v_target;
          v_action := CASE WHEN v_short > 0 THEN 'the deposit was reversed after its money was used: the shortfall stays open until new money fills it' END;
        ELSE
          v_class := 'funding_reversal'; v_status := 'reversal_review'; v_rule := 'a reversal of funded transaction ' || v_target || ' for a different amount';
          v_action := 'PayPal took back a different amount from a booked deposit: nothing was reversed automatically; check it in PayPal and correct it';
        END IF;
      END IF;
    END IF;
  ELSIF v_status = 'candidate' THEN
    r := fleet_treasury_topup_check(t, p);
    v_rule := r ->> 'reason';
    IF r ->> 'outcome' = 'book' AND NOT p_seed THEN
      v_journal := fleet_ledger_post('owner_funding', 'treasury-watch:' || v_ref, 'treasury-watch', 'settled top-up on the owner''s treasury account (' || t.event_code || ')', 'executor',
        NULL, NULL, NULL, v_ref, NULL, now(), jsonb_build_array(jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', (r ->> 'netMinor')::bigint),
          jsonb_build_object('account', 'fleet:owner:capital', 'side', 'C', 'amount', (r ->> 'netMinor')::bigint)));
      UPDATE fleet_paypal_transactions x SET attributed_as = 'owner_funding', attributed_ref = v_ref, attributed_by = 'treasury-watch', attributed_at = now(), updated_at = now()
       WHERE x.rail_id = t.rail_id AND x.transaction_id = t.transaction_id AND x.event_code = t.event_code AND x.initiated_at = t.initiated_at;
      PERFORM fleet_treasury_shortfall_settle();
      v_status := 'booked'; v_action := NULL;
    ELSIF r ->> 'outcome' = 'wait' AND t.first_seen_at > now() - interval '${TREASURY_EVIDENCE_WAIT_HOURS} hours' THEN
      v_status := 'awaiting_evidence'; v_action := NULL;
    ELSE
      v_status := 'needs_review';
      v_action := 'this looks like a top-up but was not booked automatically (' || v_rule || '): if it is your own funding, record it through the funding command';
    END IF;
  END IF;

  v_prev := m.accounting_status;
  IF NOT v_new AND v_prev = v_status AND m.provider_status = t.status AND m.classification = v_class AND m.rule IS NOT DISTINCT FROM v_rule AND m.journal_id IS NOT DISTINCT FROM v_journal AND m.last_error IS NULL THEN RETURN v_status; END IF;
  INSERT INTO fleet_treasury_movements AS x (rail_id, transaction_id, event_code, initiated_at, direction, amount_minor, fee_minor, currency, provider_status, classification, accounting_status, rule, action, journal_id, return_journal_id, shortfall_minor, seeded, first_seen_at)
    VALUES (t.rail_id, t.transaction_id, t.event_code, t.initiated_at, v_dir, t.amount_minor, t.fee_minor, COALESCE(t.currency, '?'), t.status, v_class, v_status, left(v_rule, 300), left(v_action, 300), v_journal, v_return, v_short, p_seed, t.first_seen_at)
  ON CONFLICT (rail_id, transaction_id, event_code, initiated_at) DO UPDATE SET amount_minor = EXCLUDED.amount_minor, fee_minor = EXCLUDED.fee_minor, provider_status = EXCLUDED.provider_status,
    classification = EXCLUDED.classification, accounting_status = EXCLUDED.accounting_status, rule = EXCLUDED.rule, action = EXCLUDED.action, journal_id = EXCLUDED.journal_id,
    return_journal_id = COALESCE(EXCLUDED.return_journal_id, x.return_journal_id), shortfall_minor = EXCLUDED.shortfall_minor, last_error = NULL, updated_at = now()
  RETURNING * INTO m;
  INSERT INTO fleet_treasury_movement_history (movement_id, from_status, to_status, provider_status, classification, rule, journal_id)
    VALUES (m.movement_id, v_prev, v_status, t.status, v_class, left(v_rule, 300), v_journal);
  IF p_seed THEN RETURN v_status; END IF;

  v_detail := jsonb_build_object('movementId', m.movement_id, 'transactionId', t.transaction_id, 'eventCode', t.event_code, 'direction', v_dir, 'amountMinor', t.amount_minor, 'feeMinor', t.fee_minor,
    'currency', t.currency, 'providerStatus', t.status, 'classification', v_class, 'accountingStatus', v_status, 'rule', v_rule, 'action', v_action, 'initiatedAt', t.initiated_at);
  IF v_new THEN PERFORM fleet_event('treasury_movement_recorded', NULL, 'controller', v_detail); END IF;
  IF v_prev IS DISTINCT FROM v_status THEN
    IF v_status = 'booked' THEN
      PERFORM fleet_event('treasury_funding_booked', NULL, 'controller', v_detail || jsonb_build_object('journalId', v_journal, 'netMinor', t.amount_minor + LEAST(t.fee_minor, 0)));
      PERFORM fleet_notify('AMBER', 'TREASURY_FUNDING_RECEIVED', NULL, 'Funding received and booked: ' || fleet_treasury_money(t.amount_minor + LEAST(t.fee_minor, 0), t.currency) || ' net (' || t.transaction_id || ')',
        v_detail || jsonb_build_object('action', 'none: this is for your records'), 'treasury-move:' || m.movement_id || ':booked');
    ELSIF v_status IN ('needs_review', 'reversal_review') THEN
      PERFORM fleet_event('treasury_movement_needs_review', NULL, 'controller', v_detail);
      PERFORM fleet_notify('AMBER', 'TREASURY_NEEDS_REVIEW', NULL, 'Treasury movement needs a look: ' || fleet_treasury_money(t.amount_minor, t.currency) || ' (' || t.event_code || ', ' || t.transaction_id || ')', v_detail, 'treasury-move:' || m.movement_id || ':' || v_status);
    ELSIF v_status = 'held' THEN
      PERFORM fleet_notify('AMBER', 'TREASURY_NEEDS_REVIEW', NULL, 'PayPal hold or release: ' || fleet_treasury_money(t.amount_minor, t.currency) || ' (' || t.event_code || ', ' || t.transaction_id || ')', v_detail, 'treasury-move:' || m.movement_id || ':held');
    ELSIF v_status = 'reversed' AND v_return IS NOT NULL THEN
      PERFORM fleet_event('treasury_funding_reversed', NULL, 'controller', v_detail || jsonb_build_object('returnJournalId', v_return));
      PERFORM fleet_notify('RED', 'TREASURY_FUNDING_REVERSED', NULL, 'A booked deposit was reversed and taken back: ' || t.transaction_id, v_detail || jsonb_build_object('action', 'none needed for the books; check why PayPal reversed it'), 'treasury-move:' || m.movement_id || ':reversed');
    ELSIF v_status = 'reversal_shortfall' THEN
      PERFORM fleet_event('treasury_reversal_shortfall', NULL, 'controller', v_detail || jsonb_build_object('returnJournalId', v_return, 'shortfallMinor', v_short));
      PERFORM fleet_notify('RED', 'TREASURY_FUNDING_REVERSED', NULL, 'A reversed deposit left a shortfall of ' || fleet_treasury_money(v_short, t.currency) || ': ' || t.transaction_id, v_detail || jsonb_build_object('shortfallMinor', v_short), 'treasury-move:' || m.movement_id || ':shortfall');
    END IF;
  END IF;
  IF v_new AND v_dir = 'out' AND -t.amount_minor >= p.material_out_minor THEN
    PERFORM fleet_event('treasury_outgoing_recorded', NULL, 'controller', v_detail);
    IF v_status NOT IN ('needs_review', 'reversal_review') THEN
      PERFORM fleet_notify('AMBER', 'TREASURY_OUTGOING', NULL, 'Material money left the treasury: ' || fleet_treasury_money(-t.amount_minor, t.currency) || ' (' || t.event_code || ', ' || t.transaction_id || ')',
        v_detail || jsonb_build_object('action', 'for your records; it is ' || v_status), 'treasury-move:' || m.movement_id || ':out');
    END IF;
  END IF;
  RETURN v_status;
END $$;

-- ═══ 5. What is known about the provider, separately from what was booked ═══
CREATE FUNCTION fleet_provider_sync_visibility() RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE s fleet_paypal_sync_status; b fleet_paypal_sync_status; f fleet_paypal_sync_status; r fleet_payment_rails; w fleet_treasury_watch_state; v_d jsonb; v_receipts jsonb; v_n bigint; v_items jsonb; v_rec bigint; v_state text; v_age numeric;
        v_out bigint; v_review bigint; v_asof timestamptz; v_ingested timestamptz; v_caps bigint; v_inbox bigint;
BEGIN
  SELECT * INTO r FROM fleet_payment_rails WHERE provider = 'paypal' AND status = 'active' ORDER BY created_at LIMIT 1;
  IF r.rail_id IS NULL THEN RETURN jsonb_build_object('state', 'no_rail'); END IF;
  SELECT * INTO s FROM fleet_paypal_sync_status WHERE rail_id = r.rail_id AND kind = 'transaction_search';
  SELECT * INTO b FROM fleet_paypal_sync_status WHERE rail_id = r.rail_id AND kind = 'balances';
  SELECT * INTO f FROM fleet_paypal_sync_status WHERE rail_id = r.rail_id AND kind = 'backfill';
  SELECT * INTO w FROM fleet_treasury_watch_state WHERE id = 1;
  v_d := COALESCE(s.detail, '{}'::jsonb);
  v_age := extract(epoch FROM now() - s.last_ok_at) / 60;
  BEGIN v_asof := (v_d ->> 'lastRefreshedAt')::timestamptz; EXCEPTION WHEN others THEN v_asof := NULL; END;
  SELECT max(first_seen_at) INTO v_ingested FROM fleet_paypal_transactions WHERE rail_id = r.rail_id;
  SELECT count(*) INTO v_n FROM fleet_paypal_transactions WHERE rail_id = r.rail_id AND checkout_id IS NULL AND amount_minor > 0 AND attributed_at IS NULL;
  SELECT count(*) INTO v_out FROM fleet_paypal_transactions WHERE rail_id = r.rail_id AND checkout_id IS NULL AND amount_minor < 0 AND attributed_at IS NULL;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('transactionId', t.transaction_id, 'eventCode', t.event_code, 'amountMinor', t.amount_minor, 'feeMinor', t.fee_minor,
           'currency', t.currency, 'status', t.status, 'initiatedAt', t.initiated_at, 'firstSeenAt', t.first_seen_at) ORDER BY t.initiated_at DESC), '[]'::jsonb) INTO v_receipts
    FROM (SELECT * FROM fleet_paypal_transactions WHERE rail_id = r.rail_id AND checkout_id IS NULL AND amount_minor <> 0 AND attributed_at IS NULL ORDER BY initiated_at DESC LIMIT 20) t;
  SELECT count(*) INTO v_rec FROM fleet_paypal_reconciliation_items WHERE status = 'open';
  SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('kind', i.kind, 'paypalRef', i.paypal_ref, 'amountMinor', i.amount_minor, 'currency', i.currency, 'createdAt', i.created_at)) ORDER BY i.created_at DESC), '[]'::jsonb) INTO v_items
    FROM (SELECT * FROM fleet_paypal_reconciliation_items WHERE status = 'open' ORDER BY created_at DESC LIMIT 20) i;
  SELECT count(*) INTO v_review FROM fleet_treasury_movements WHERE accounting_status IN ('needs_review','reversal_review','reversal_shortfall','held');
  v_state := CASE WHEN s.rail_id IS NULL THEN 'never_read'
                  WHEN s.last_http IS DISTINCT FROM 200 THEN 'failing'
                  WHEN v_age IS NULL OR v_age > ${PAYPAL_SEARCH_STALE_MINUTES} THEN 'stale'
                  WHEN COALESCE((v_d ->> 'dropped')::bigint, 0) + COALESCE((v_d ->> 'refused')::bigint, 0) > 0 OR COALESCE((v_d ->> 'truncated')::boolean, false) THEN 'rows_lost'
                  WHEN v_asof IS NOT NULL AND v_asof < now() - interval '${PAYPAL_DATA_STALE_HOURS} hours' THEN 'provider_data_stale'
                  WHEN f.rail_id IS NOT NULL AND (f.last_http IS DISTINCT FROM 200 OR f.last_ok_at < now() - interval '${PAYPAL_BACKFILL_STALE_HOURS} hours') THEN 'backfill_stale'
                  WHEN v_rec > 0 THEN 'reconciliation_open'
                  WHEN v_review > 0 THEN 'needs_review'
                  WHEN v_n + v_out > 0 THEN 'unmatched_receipts'
                  ELSE 'current' END;
  -- Configured is not working: payments the Fleet took on this rail, against deliveries that ever arrived.
  SELECT count(*) INTO v_caps FROM fleet_paypal_checkouts WHERE rail_id = r.rail_id AND status = 'captured';
  SELECT count(*) INTO v_inbox FROM fleet_paypal_webhook_inbox;
  RETURN jsonb_build_object('state', v_state, 'railId', r.rail_id, 'accountRef', r.account_ref, 'mode', r.mode,
    'lastTransactionIngestedAt', v_ingested,
    'watch', jsonb_strip_nulls(jsonb_build_object('lastTickAt', w.last_tick_at, 'lastError', w.last_error, 'lastErrorAt', w.last_error_at, 'differenceMinor', w.difference_minor, 'differenceSince', w.difference_since)),
    'search', jsonb_strip_nulls(jsonb_build_object('lastAttemptAt', s.last_attempt_at, 'lastOkAt', s.last_ok_at, 'lastHttp', s.last_http, 'lastErrorName', s.last_error_name,
      'lastDebugId', s.last_debug_id, 'ageMinutes', round(v_age), 'staleAfterMinutes', ${PAYPAL_SEARCH_STALE_MINUTES}, 'reportedUpTo', v_d ->> 'lastRefreshedAt',
      'windowStart', v_d ->> 'windowStart', 'windowEnd', v_d ->> 'windowEnd', 'totalItems', v_d -> 'totalItems', 'totalPages', v_d -> 'totalPages', 'pagesRead', v_d -> 'pagesRead', 'returned', v_d -> 'returned', 'ingested', v_d -> 'ingested',
      'dropped', v_d -> 'dropped', 'refused', v_d -> 'refused', 'truncated', v_d -> 'truncated')),
    'balances', jsonb_strip_nulls(jsonb_build_object('lastOkAt', b.last_ok_at, 'lastHttp', b.last_http, 'asOf', b.detail ->> 'asOf', 'refreshedAt', b.detail ->> 'refreshedAt', 'accountTail', b.detail ->> 'accountTail')),
    'backfill', jsonb_strip_nulls(jsonb_build_object('lastOkAt', f.last_ok_at, 'lastHttp', f.last_http, 'windowStart', f.detail ->> 'windowStart', 'windowEnd', f.detail ->> 'windowEnd', 'returned', f.detail -> 'returned', 'dropped', f.detail -> 'dropped',
      'refused', f.detail -> 'refused', 'truncated', f.detail -> 'truncated', 'horizonDays', f.detail -> 'horizonDays')),
    'unmatchedReceipts', jsonb_build_object('count', v_n, 'outgoingCount', v_out, 'items', v_receipts),
    'needsReview', v_review,
    'reconciliation', jsonb_build_object('open', v_rec, 'items', v_items),
    'webhooks', (SELECT jsonb_strip_nulls(jsonb_build_object('receivedEver', count(*), 'lastReceivedAt', max(received_at), 'configured', r.webhook_id IS NOT NULL, 'capturesOnRail', v_caps,
       'delivering', CASE WHEN r.webhook_id IS NULL THEN false WHEN v_inbox > 0 THEN true WHEN v_caps > 0 THEN false END,
       'rejected24h', count(*) FILTER (WHERE status = 'rejected' AND received_at > now() - interval '24 hours'))) FROM fleet_paypal_webhook_inbox),
    'note', 'a payment reaches these figures only when PayPal reports it; money paid after reportedUpTo cannot be seen yet');
END $$;

CREATE FUNCTION fleet_treasury_movements_recent(p_limit integer) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('movementId', m.movement_id, 'transactionId', m.transaction_id, 'eventCode', m.event_code, 'direction', m.direction,
      'amountMinor', m.amount_minor, 'feeMinor', m.fee_minor, 'currency', m.currency, 'providerStatus', m.provider_status, 'classification', m.classification, 'accountingStatus', m.accounting_status,
      'rule', m.rule, 'action', m.action, 'journalId', m.journal_id, 'returnJournalId', m.return_journal_id, 'shortfallMinor', NULLIF(m.shortfall_minor, 0), 'initiatedAt', m.initiated_at,
      'firstSeenAt', m.first_seen_at, 'updatedAt', m.updated_at)) ORDER BY m.initiated_at DESC), '[]'::jsonb)
    FROM (SELECT * FROM fleet_treasury_movements ORDER BY initiated_at DESC LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 30), 200))) m
$$;

${restate(V121_SQL, "fleet_treasury_position", [
  [`  RETURN jsonb_build_object('currency', v_ccy,`,
   `  RETURN jsonb_build_object('currency', v_ccy, 'providerSync', fleet_provider_sync_visibility(), 'movements', fleet_treasury_movements_recent(30),
    'restrictedMinor', CASE WHEN pp IS NULL THEN NULL ELSE (pp ->> 'totalMinor')::bigint - (pp ->> 'availableMinor')::bigint END,
    'pendingIncomingMinor', (SELECT COALESCE(sum(amount_minor), 0) FROM fleet_treasury_movements WHERE direction = 'in' AND accounting_status IN ('pending','awaiting_evidence','needs_review')),
    'autoBook', (SELECT jsonb_build_object('enabled', auto_book_enabled, 'codes', auto_book_codes, 'maxMinor', auto_book_max_minor, 'materialOutMinor', material_out_minor) FROM fleet_treasury_watch_policy WHERE id = 1),`],
])}

-- What Fleet Control sees: verified facts or "unknown", never a guess. Context for a review, not a spending gate.
CREATE FUNCTION fleet_treasury_control_facts() RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p jsonb := fleet_treasury_position();
BEGIN
  RETURN jsonb_build_object('reconciliation', p #>> '{reconciliation,status}', 'providerCashAvailableMinor', p #> '{paypal,availableMinor}', 'providerCashObservedAt', p #>> '{paypal,observedAt}',
    'providerCashFresh', p #> '{paypal,fresh}', 'restrictedMinor', p -> 'restrictedMinor', 'backedTreasuryAvailableMinor', p #> '{treasury,availableMinor}', 'unbackedCapitalMinor', p #> '{reconciliation,unbackedCapitalMinor}',
    'ownerPayableMinor', p #> '{owner,payableMinor}', 'providerSync', p #>> '{providerSync,state}', 'providerDataReachesTo', p #>> '{providerSync,search,reportedUpTo}');
END $$;

${restate(V117_SQL, "svc_spend_reviews_claim", [
  [`'payee', rv.payee_key, 'signals', rv.signals,`, `'payee', rv.payee_key, 'treasury', fleet_treasury_control_facts(), 'signals', rv.signals,`],
])}

-- ═══ 6. The watch: every few minutes, off the request path, safe to interrupt and repeat ═══
CREATE FUNCTION fleet_treasury_movements_sync(p_limit integer, p_seed boolean) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE t fleet_paypal_transactions; p fleet_treasury_watch_policy; n integer := 0; e integer := 0; v_err text;
BEGIN
  SELECT * INTO p FROM fleet_treasury_watch_policy WHERE id = 1;
  FOR t IN SELECT x.* FROM fleet_paypal_transactions x LEFT JOIN fleet_treasury_movements m
             ON m.rail_id = x.rail_id AND m.transaction_id = x.transaction_id AND m.event_code = x.event_code AND m.initiated_at = x.initiated_at
            WHERE m.movement_id IS NULL OR m.provider_status <> x.status OR m.amount_minor <> x.amount_minor OR m.last_error IS NOT NULL
               OR m.accounting_status IN ('pending','awaiting_evidence','needs_review','held')
            ORDER BY x.initiated_at LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 500)) LOOP
    BEGIN
      PERFORM fleet_treasury_movement_eval(t, p, p_seed);
      n := n + 1;
    EXCEPTION WHEN others THEN
      -- One row failing is recorded and retried; it never stops the rows after it, and nothing of it is half-booked.
      v_err := left(SQLERRM, 300); e := e + 1;
      INSERT INTO fleet_treasury_movements AS x (rail_id, transaction_id, event_code, initiated_at, direction, amount_minor, fee_minor, currency, provider_status, classification, accounting_status, last_error, action, first_seen_at)
        VALUES (t.rail_id, t.transaction_id, t.event_code, t.initiated_at, CASE WHEN t.amount_minor > 0 THEN 'in' WHEN t.amount_minor < 0 THEN 'out' ELSE 'none' END, t.amount_minor, t.fee_minor, COALESCE(t.currency, '?'), t.status,
                'processing_failed', 'needs_review', v_err, 'the Fleet could not process this row: it retries by itself; tell engineering if this stays', t.first_seen_at)
      ON CONFLICT (rail_id, transaction_id, event_code, initiated_at) DO UPDATE SET last_error = EXCLUDED.last_error, updated_at = now();
      UPDATE fleet_treasury_watch_state SET last_error = v_err, last_error_at = now() WHERE id = 1;
      PERFORM fleet_notify('AMBER', 'TREASURY_INGESTION_FAILED', NULL, 'A treasury movement could not be processed: ' || t.transaction_id, jsonb_build_object('transactionId', t.transaction_id, 'eventCode', t.event_code, 'error', v_err,
        'action', 'it retries by itself; tell engineering if this stays'), 'treasury-fail:' || t.transaction_id || ':' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'));
    END;
  END LOOP;
  RETURN jsonb_build_object('evaluated', n, 'failed', e);
END $$;

CREATE FUNCTION svc_treasury_watch_tick() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r jsonb; v jsonb; cb jsonb; w fleet_treasury_watch_state; v_diff bigint; day text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'); n integer := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('fleet_treasury_watch')) THEN RETURN jsonb_build_object('ok', true, 'skipped', true); END IF;
  r := fleet_treasury_movements_sync(200, false);
  v := fleet_provider_sync_visibility();
  IF v ->> 'state' IN ('no_rail', 'never_read', 'failing', 'stale', 'rows_lost', 'provider_data_stale', 'backfill_stale') THEN
    IF fleet_notify('AMBER', 'TREASURY_SYNC_PROBLEM', NULL, 'PayPal reporting needs attention: ' || (v ->> 'state'), jsonb_build_object('state', v ->> 'state', 'search', v -> 'search', 'backfill', v -> 'backfill',
         'action', 'new treasury movements may not be visible: check the custody service and PayPal access'), 'treasury-sync:' || (v ->> 'state') || ':' || day) THEN
      PERFORM fleet_event('treasury_sync_problem', NULL, 'controller', jsonb_build_object('state', v ->> 'state', 'search', v -> 'search')); n := n + 1;
    END IF;
  END IF;
  -- PayPal's balance against the books: a difference that stays unexplained past its grace is raised once a day.
  cb := fleet_capital_backing();
  v_diff := (cb ->> 'differenceMinor')::bigint;
  SELECT * INTO w FROM fleet_treasury_watch_state WHERE id = 1 FOR UPDATE;
  UPDATE fleet_treasury_watch_state SET last_tick_at = now(), difference_minor = v_diff,
    difference_since = CASE WHEN COALESCE(v_diff, 0) = 0 THEN NULL ELSE COALESCE(w.difference_since, now()) END,
    last_error = CASE WHEN (r ->> 'failed')::integer = 0 THEN NULL ELSE last_error END WHERE id = 1 RETURNING * INTO w;
  IF COALESCE(v_diff, 0) <> 0 AND w.difference_since < now() - interval '${TREASURY_DIFFERENCE_GRACE_HOURS} hours' THEN
    IF fleet_notify('AMBER', 'TREASURY_BALANCE_UNEXPLAINED', NULL, 'PayPal and the books differ by ' || fleet_treasury_money(v_diff, cb ->> 'currency'), jsonb_build_object('differenceMinor', v_diff, 'since', w.difference_since, 'paypal', cb -> 'paypal',
         'booksCashMinor', cb -> 'booksCashMinor', 'unbackedMinor', cb -> 'unbackedMinor', 'needsReview', v -> 'needsReview',
         'action', 'check the movements needing a look; if none explains it, money moved that PayPal has not reported or the Fleet has not recorded'), 'treasury-diff:' || day) THEN
      PERFORM fleet_event('treasury_balance_unexplained', NULL, 'controller', jsonb_build_object('differenceMinor', v_diff, 'since', w.difference_since)); n := n + 1;
    END IF;
  END IF;
  RETURN jsonb_build_object('ok', true, 'alerts', n) || r;
END $$;

-- Existing rows are history: recorded without events, alerts or booking.
SELECT fleet_treasury_movements_sync(500, true);

-- ═══ 7. The owner's switch ═══
CREATE FUNCTION fleet_admin_treasury_watch_policy_set(p_enabled boolean, p_rail uuid, p_codes text[], p_max bigint, p_material bigint, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_treasury_watch_policy;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  IF p_enabled AND NOT EXISTS (SELECT 1 FROM fleet_payment_rails WHERE rail_id = p_rail AND provider = 'paypal' AND status = 'active' AND mode = 'live') THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: auto-booking needs the active live PayPal rail of the owner-operated treasury account';
  END IF;
  UPDATE fleet_treasury_watch_policy SET auto_book_enabled = p_enabled, auto_book_rail = CASE WHEN p_enabled THEN p_rail ELSE auto_book_rail END,
    auto_book_from = CASE WHEN p_enabled AND NOT auto_book_enabled THEN now() ELSE auto_book_from END, auto_book_codes = COALESCE(p_codes, auto_book_codes),
    auto_book_max_minor = COALESCE(p_max, auto_book_max_minor), material_out_minor = COALESCE(p_material, material_out_minor), updated_by = p_actor, updated_at = now()
   WHERE id = 1 RETURNING * INTO p;
  PERFORM fleet_event('treasury_watch_policy_set', NULL, left(p_actor, 128), jsonb_build_object('enabled', p.auto_book_enabled, 'railId', p.auto_book_rail, 'from', p.auto_book_from, 'codes', p.auto_book_codes, 'maxMinor', p.auto_book_max_minor, 'materialOutMinor', p.material_out_minor));
  RETURN jsonb_build_object('ok', true, 'enabled', p.auto_book_enabled, 'railId', p.auto_book_rail, 'from', p.auto_book_from, 'codes', p.auto_book_codes, 'maxMinor', p.auto_book_max_minor, 'materialOutMinor', p.material_out_minor);
END $$;

-- ═══ 8. Read-only operator access: the same facts, for the bridge_claude kind only ═══
ALTER TABLE fleet_operator_principals DROP CONSTRAINT fleet_operator_principals_scopes_check;
ALTER TABLE fleet_operator_principals ADD CONSTRAINT fleet_operator_principals_scopes_check CHECK (
  cardinality(scopes) BETWEEN 1 AND 7
  AND scopes <@ ARRAY['ops.read.status','ops.read.agents','ops.read.events','ops.read.lifecycle','ops.read.treasury','ops.act.agents','ops.propose.agents']::text[]
  AND array_position(scopes, NULL) IS NULL);
ALTER TABLE fleet_operator_routes DROP CONSTRAINT fleet_operator_routes_scope_check;
ALTER TABLE fleet_operator_routes ADD CONSTRAINT fleet_operator_routes_scope_check
  CHECK (scope IS NULL OR scope IN ('ops.read.status','ops.read.agents','ops.read.events','ops.read.lifecycle','ops.read.treasury','ops.act.agents','ops.propose.agents'));
ALTER TABLE fleet_operator_routes DROP CONSTRAINT fleet_operator_routes_fn_check;
ALTER TABLE fleet_operator_routes ADD CONSTRAINT fleet_operator_routes_fn_check CHECK (fn IN (
  'op_whoami','op_fleet_status','op_list_agents','op_get_agent','op_list_events',
  'op_lifecycle_health','op_runtime_status','op_list_reservations','op_list_orphans','op_list_proposals','op_list_actions','op_treasury_watch',
  'op_act_hold_agent','op_act_release_agent_hold','op_act_request_health_challenge','op_act_revoke_agent_sessions',
  'op_act_reconcile_lifecycle','op_propose_agent_action'));
ALTER TABLE fleet_operator_routes DROP CONSTRAINT fleet_operator_routes_method_matches_fn;
ALTER TABLE fleet_operator_routes ADD CONSTRAINT fleet_operator_routes_method_matches_fn CHECK (
  (route LIKE 'GET %') = (fn IN ('op_whoami','op_fleet_status','op_list_agents','op_get_agent','op_list_events',
    'op_lifecycle_health','op_runtime_status','op_list_reservations','op_list_orphans','op_list_proposals','op_list_actions','op_treasury_watch')));
INSERT INTO fleet_operator_routes (route, scope, fn, kinds) VALUES
  ('GET /v1/operator/treasury', 'ops.read.treasury', 'op_treasury_watch', ARRAY['bridge_claude']);

CREATE FUNCTION op_treasury_watch(p_request uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_operator_requests; p jsonb;
BEGIN
  r := fleet_operator_request_ok(p_request, 'op_treasury_watch');
  p := fleet_treasury_position();
  RETURN jsonb_build_object('currency', p -> 'currency', 'providerSync', p -> 'providerSync', 'movements', p -> 'movements', 'paypal', p -> 'paypal', 'restrictedMinor', p -> 'restrictedMinor',
    'pendingIncomingMinor', p -> 'pendingIncomingMinor', 'reconciliation', p -> 'reconciliation', 'treasury', p -> 'treasury', 'owner', p -> 'owner', 'apiCredit', p -> 'apiCredit', 'autoBook', p -> 'autoBook');
END $$;

${restate(V122_SQL, "fleet_event_route", [["    WHEN p_type = 'spend_circuit_breaker_set' THEN",
  (Object.entries(EVENT_ROUTES_V123) as Array<[string, readonly string[]]>)
    .map(([lvl, types]) => `    WHEN p_type IN (${q(types)}) THEN '${lvl}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"]])}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

/**
 * Schema v90 — the remaining master-checklist items (owner, 2026-10-16: "finish the outstanding items in the existing
 * master checklist").
 *
 * 1. SEVERAL CARDS (R9): a card registry — up to three card slots (the owner's identity classes payment_card,
 *    payment_card_2, payment_card_3), each credit (repaid by the owner, the v48 path) or debit (drawing on one bank money
 *    location, the v86 path), with a priority and a status. A hold uses the card the agent names, else the first active
 *    card by priority that can carry it (a debit card only from its bank's fresh free cash); the hold records its card,
 *    and the browser fills exactly that card. The old single binding (location_bind_card) sets slot 1.
 *
 * 2. A PROVISIONAL CHARGEBACK REVERSED: when the bank takes back a dispute credit it gave (a line naming a chargeback /
 *    reversal / dispute, of that credit's amount, at that bank), the dispute becomes `reversed` and the charge goes back
 *    up — booked against the agent as any charge (its cash, then its debt; v88 shortfall rules). The owner can attribute a
 *    line the bank did not name that way.
 *
 * 3. A PAYPAL LIMITATION SIGNAL: PayPal has no account-limitation API. The hourly watch reads PayPal's own failure codes
 *    from the last 24 hours (refunds, payouts); a code describing OUR account (restricted / locked / limited / compliance /
 *    suspended — not the payee's or the buyer's) marks the PayPal location limited (PayPal outflows wait) and raises RED
 *    PAYPAL_LIMITED. The owner re-activates the location when PayPal lifts it.
 *
 * 4. UNIT ECONOMICS per order and per venture: the AI calls that acted on an order, enquiry, offer, venture or repository
 *    access (the gateway records which, never the arguments) share that call's cost; with each order's support burden
 *    (customer and agent messages, deliveries, revisions, days open) and revenue. AI calls that touched none are
 *    "general". For the owner (Fleet HQ) and for the agent (business op economics).
 */
import { V48_SQL } from "./migrations-phase48.js";
import { V52_SQL } from "./migrations-phase52.js";
import { V86_SQL, DEBIT_GATE } from "./migrations-phase86.js";
import { V88_SQL } from "./migrations-phase88.js";
import { V89_SQL } from "./migrations-phase89.js";
import { restate } from "./migrations-phase42.js";

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
export const CARD_SLOTS = ["payment_card", "payment_card_2", "payment_card_3"] as const;
export const PAYPAL_LIMIT_CODES = "(RESTRICTED|LOCKED|LIMITED|LIMITATION|COMPLIANCE|SUSPENDED)";
export const PAYPAL_NOT_OURS = "^(PAYEE|RECEIVER|RECIPIENT|BUYER|PAYER|CUSTOMER)_";
export const AGENT_OPS_V90 = ["business.economics"] as const;
export const DASHBOARD_READ_OPS_V90 = ["unit_economics"] as const;
export const DASHBOARD_SENSITIVE_OPS_V90 = ["card_slot_set"] as const;
export const DASHBOARD_WRITE_OPS_V90_ADDED = ["card_dispute_reversal"] as const;

// ── 1. Cards: the hold chooses its card; the fill uses that card ──
const CARD_AUTHORIZE = restate(V88_SQL, "fleet_econ_card_authorize", [
  [`        eco jsonb; v_avail bigint; v_env uuid; v_j uuid; v_from text; rq fleet_card_requests; loc fleet_money_locations; liq jsonb;`,
   `        eco jsonb; v_avail bigint; v_env uuid; v_j uuid; v_from text; rq fleet_card_requests; loc fleet_money_locations; liq jsonb; v_card jsonb;`],
  [`  IF NOT EXISTS (SELECT 1 FROM fleet_owner_identity_classes WHERE class_key = 'payment_card' AND status = 'configured' AND (expires_at IS NULL OR expires_at > now())) THEN`,
   `  IF NOT EXISTS (SELECT 1 FROM fleet_owner_identity_classes WHERE class_key IN (${q(CARD_SLOTS)}) AND status = 'configured' AND (expires_at IS NULL OR expires_at > now())) THEN`],
  [DEBIT_GATE, `
  -- v90: the card — the one the agent names, else the first active card by priority that can carry this hold (a debit card
  -- only from its bank's fresh free cash, under that location's lock). Its location (debit) or none (credit, v48).
  v_card := fleet_card_choose(NULLIF(a ->> 'card', ''), v_max);
  IF NOT (v_card ->> 'ok')::boolean THEN RETURN v_card; END IF;
  SELECT * INTO loc FROM fleet_money_locations WHERE location_id = NULLIF(v_card ->> 'locationId', '')::uuid;
`],
  [`, location_id, evidence_status, venture_id)`, `, location_id, evidence_status, venture_id, card_slot)`],
  [`            acc.venture_id) RETURNING * INTO c;`, `            acc.venture_id, v_card ->> 'slot') RETURNING * INTO c;`],
]);
// The browser fills exactly the card of the agent's open hold on this site (its slot), never another card.
const SECRET_REQUEST = restate(V52_SQL, "bx_secret_request", [
  [`    v_class := CASE WHEN v_kind = 'owner_card' THEN 'payment_card' ELSE split_part(p_kind, ':', 2) END;`,
   `    v_class := CASE WHEN v_kind = 'owner_card' THEN COALESCE((SELECT card_slot FROM fleet_card_charges WHERE agent_id = x.agent_id AND status = 'held' AND declare_by > now()
                     AND origin = lower(p_origin) ORDER BY created_at DESC LIMIT 1), 'payment_card') ELSE split_part(p_kind, ':', 2) END;`],
]);

// ── 2. A reversed chargeback ──
const MATCH = restate(V86_SQL, "fleet_location_match", [
  [`  IF t.kind = 'card' AND t.direction = 'out' THEN
    IF t.charge_id IS NULL THEN
`, `  IF t.kind = 'card' AND t.direction = 'out' THEN
    IF t.charge_id IS NULL THEN
      -- v90: the bank takes back a provisional dispute credit (a chargeback reversal), named as such on its line.
      IF t.status = 'settled' AND t.classified IS NULL AND COALESCE(t.descriptor, '') ~* '(chargeback|reversal|dispute)' THEN
        SELECT count(*) INTO n FROM fleet_card_disputes d JOIN fleet_bank_transactions cr ON cr.txn_id = d.credit_txn_id JOIN fleet_card_charges c ON c.charge_id = d.charge_id
         WHERE d.state = 'won' AND d.reversal_txn_id IS NULL AND c.location_id = t.location_id AND cr.amount_minor = t.amount_minor;
        IF n = 1 THEN
          SELECT d.* INTO dsp FROM fleet_card_disputes d JOIN fleet_bank_transactions cr ON cr.txn_id = d.credit_txn_id JOIN fleet_card_charges c ON c.charge_id = d.charge_id
           WHERE d.state = 'won' AND d.reversal_txn_id IS NULL AND c.location_id = t.location_id AND cr.amount_minor = t.amount_minor FOR UPDATE OF d;
          RETURN fleet_card_dispute_reverse(dsp.dispute_id, t.txn_id, 'matcher');
        ELSIF n > 1 THEN RETURN 'ambiguous';
        END IF;
      END IF;
`],
]);

// ── 3 + the watch: PayPal's own codes that describe our account ──
const OPS_WATCH = restate(V89_SQL, "svc_operations_watch", [
  [`DECLARE h jsonb := fleet_economy_health(); x jsonb; n integer := 0; o record; c record; k bigint; rec jsonb;`,
   `DECLARE h jsonb := fleet_economy_health(); x jsonb; n integer := 0; o record; c record; k bigint; rec jsonb; v_codes text;`],
  [`  rec := fleet_treasury_reconciliation();`, `  -- v90: PayPal has no limitation API — its own failure codes about OUR account mark the PayPal location limited.
  SELECT string_agg(DISTINCT code, ', ' ORDER BY code) INTO v_codes FROM (
      SELECT failure_code AS code FROM fleet_paypal_refund_requests WHERE status = 'failed' AND updated_at > now() - interval '24 hours'
      UNION ALL SELECT failure_code FROM fleet_payment_instructions WHERE status = 'failed' AND finished_at > now() - interval '24 hours') x
   WHERE upper(code) ~ '${PAYPAL_LIMIT_CODES}' AND upper(code) !~ '${PAYPAL_NOT_OURS}';
  IF v_codes IS NOT NULL THEN
    UPDATE fleet_money_locations SET status = 'limited', status_note = left('PayPal reported ' || v_codes || ' (automatic; mark it active when PayPal lifts it)', 300),
           updated_at = now(), updated_by = 'controller'
     WHERE kind = 'paypal' AND status = 'active';
    IF fleet_notify('RED', 'PAYPAL_LIMITED', NULL, 'PayPal refused a payment with ' || v_codes || ': PayPal outflows wait', jsonb_build_object('codes', v_codes), 'paypal-limited:' || day) THEN n := n + 1; END IF;
  END IF;
  rec := fleet_treasury_reconciliation();`],
]);
const READINESS = restate(V48_SQL, "fleet_payments_readiness", [
  [`    'cardBypass', EXISTS (SELECT 1 FROM fleet_owner_identity_classes c WHERE c.class_key = 'payment_card' AND c.status = 'configured'),`,
   `    'cardBypass', EXISTS (SELECT 1 FROM fleet_owner_identity_classes c WHERE c.class_key IN (${q(CARD_SLOTS)}) AND c.status = 'configured'),`],
]);

const DISPATCH = restate(V89_SQL, "api_economy", [
  [`WHEN 'code.job' THEN 'planning'`, `WHEN 'code.job' THEN 'planning' ${AGENT_OPS_V90.map((o) => `WHEN '${o}' THEN 'planning'`).join(" ")}`],
  [`      WHEN 'code.job' THEN fleet_econ_code_job_result(p_agent, a)`, `      WHEN 'code.job' THEN fleet_econ_code_job_result(p_agent, a)
      WHEN 'business.economics' THEN jsonb_build_object('ok', true) || fleet_unit_economics(p_agent, COALESCE(fleet_econ_int(a, 'days', 1, 365, false)::integer, 90))`],
]);
const DASH_CALL = restate(V89_SQL, "dash_call", [
  [`'capabilities','locations','code')) THEN`, `'capabilities','locations','code',${q(DASHBOARD_READ_OPS_V90)})) THEN`],
  [`      WHEN 'code' THEN fleet_code_json()`, `      WHEN 'code' THEN fleet_code_json()
      WHEN 'unit_economics' THEN fleet_unit_economics(NULLIF(a ->> 'agentId', ''), COALESCE((a ->> 'days')::integer, 90))`],
  [`'card_hold_release','media_statement');`, `'card_hold_release','media_statement',${q(DASHBOARD_SENSITIVE_OPS_V90)});`],
  [`'media_job_resolve','repo_access_revoke');`, `'media_job_resolve','repo_access_revoke',${q(DASHBOARD_WRITE_OPS_V90_ADDED)});`],
  [`      WHEN 'repo_access_revoke' THEN`, `      WHEN 'card_dispute_reversal' THEN fleet_admin_card_dispute_reversal((a ->> 'txnId')::uuid, (a ->> 'disputeId')::uuid, 'operator:owner')
      WHEN 'repo_access_revoke' THEN`],
  [`      WHEN 'media_statement' THEN`, `      WHEN 'card_slot_set' THEN fleet_admin_card_slot_set(a ->> 'slot', a ->> 'label', a ->> 'mode', NULLIF(a ->> 'locationId', '')::uuid,
        COALESCE((a ->> 'priority')::integer, 1), COALESCE(a ->> 'status', 'active'), 'operator:owner')
      WHEN 'media_statement' THEN`],
]);
const LOCATIONS_JSON = restate(V88_SQL, "fleet_locations_json", [
  [`    'reconciliation', fleet_treasury_reconciliation(),`, `    'reconciliation', fleet_treasury_reconciliation(),
    'cards', COALESCE((SELECT jsonb_agg(jsonb_build_object('slot', k.card_slot, 'label', k.label, 'mode', k.mode, 'locationId', k.location_id, 'priority', k.priority,
                   'status', k.status, 'configured', EXISTS (SELECT 1 FROM fleet_owner_identity_classes o WHERE o.class_key = k.card_slot AND o.status = 'configured'
                   AND (o.expires_at IS NULL OR o.expires_at > now()))) ORDER BY k.priority, k.card_slot) FROM fleet_cards k), '[]'::jsonb),`],
]);
const BIND_CARD = restate(V86_SQL, "fleet_admin_location_bind_card", [
  [`  PERFORM fleet_event('money_location_card', NULL, p_actor, jsonb_build_object('locationId', p_loc));`,
   `  -- v90: the old single binding is card slot 1.
  UPDATE fleet_cards SET mode = CASE WHEN p_loc IS NULL THEN 'credit' ELSE 'debit' END, location_id = p_loc, updated_at = now(), updated_by = p_actor WHERE card_slot = 'payment_card';
  PERFORM fleet_event('money_location_card', NULL, p_actor, jsonb_build_object('locationId', p_loc));`],
]);

export const V90_SQL = `
-- ═══ 1. Several cards ═══
-- The owner's identity classes and the browser's fill admit the extra card slots (each constraint rewritten in place).
DO $mig$
DECLARE r record; v text;
BEGIN
  FOR r IN SELECT conrelid::regclass AS t, conname, pg_get_constraintdef(oid) AS d FROM pg_constraint
            WHERE connamespace = '@@SCHEMA@@'::regnamespace AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%payment_card%' LOOP
    v := replace(r.d, '''payment_card''::text,', '''payment_card''::text, ''payment_card_2''::text, ''payment_card_3''::text,');
    v := replace(v, '''payment_card''::text]', '''payment_card''::text, ''payment_card_2''::text, ''payment_card_3''::text]');
    v := replace(v, '(owner_class = ''payment_card''::text)', '(owner_class = ANY (ARRAY[''payment_card''::text, ''payment_card_2''::text, ''payment_card_3''::text]))');
    v := replace(v, 'cardinality(classes) <= 13', 'cardinality(classes) <= 15');
    IF v <> r.d THEN
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.t, r.conname);
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', r.t, r.conname, v);
    END IF;
  END LOOP;
END $mig$;

-- The owner's vault references carry the slot number (ovault:payment_card_2).
ALTER TABLE fleet_owner_identity_classes DROP CONSTRAINT fleet_owner_identity_classes_vault_ref_check;
ALTER TABLE fleet_owner_identity_classes ADD CONSTRAINT fleet_owner_identity_classes_vault_ref_check CHECK (vault_ref ~ '^ovault:[a-z0-9_]{3,30}$');

CREATE TABLE fleet_cards (
  card_slot    text        PRIMARY KEY CHECK (card_slot IN (${q(CARD_SLOTS)})),
  label        text        NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  mode         text        NOT NULL CHECK (mode IN ('credit','debit')),
  location_id  uuid        UNIQUE REFERENCES fleet_money_locations(location_id),
  priority     integer     NOT NULL DEFAULT 1 CHECK (priority BETWEEN 1 AND 9),
  status       text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text        NOT NULL,
  CHECK ((mode = 'debit') = (location_id IS NOT NULL))
);
CREATE TRIGGER fleet_cards_no_delete BEFORE DELETE ON fleet_cards FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
-- Slot 1 is today's card: debit on the bound bank if one is bound, else the owner's credit card.
INSERT INTO fleet_cards (card_slot, label, mode, location_id, priority, updated_by)
  SELECT 'payment_card', 'Card 1', CASE WHEN l.location_id IS NULL THEN 'credit' ELSE 'debit' END, l.location_id, 1, 'migration'
    FROM (SELECT (SELECT location_id FROM fleet_money_locations WHERE card_drawn LIMIT 1) AS location_id) l;
ALTER TABLE fleet_card_charges ADD COLUMN card_slot text CHECK (card_slot IN (${q(CARD_SLOTS)}));
COMMENT ON COLUMN fleet_card_charges.card_slot IS 'v90: the card this hold uses (the browser fills exactly this card)';

-- The card for a hold: the named one, else the first active card by priority that can carry it.
CREATE FUNCTION fleet_card_choose(p_slot text, p_max bigint) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE k record; liq jsonb; first_refusal jsonb;
BEGIN
  -- Slot 1 without a registry row is today's card (before v90): debit on the bound bank, else the owner's credit card.
  FOR k IN SELECT x.*, l.status AS loc_status FROM (
              SELECT card_slot, mode, location_id, priority, status FROM fleet_cards
              UNION ALL
              SELECT 'payment_card', CASE WHEN d.location_id IS NULL THEN 'credit' ELSE 'debit' END, d.location_id, 9, 'active'
                FROM (SELECT (SELECT location_id FROM fleet_money_locations WHERE card_drawn LIMIT 1) AS location_id) d
               WHERE NOT EXISTS (SELECT 1 FROM fleet_cards WHERE card_slot = 'payment_card')) x
            LEFT JOIN fleet_money_locations l ON l.location_id = x.location_id
            WHERE x.status = 'active' AND (p_slot IS NULL OR x.card_slot = p_slot)
              AND EXISTS (SELECT 1 FROM fleet_owner_identity_classes o WHERE o.class_key = x.card_slot AND o.status = 'configured' AND (o.expires_at IS NULL OR o.expires_at > now()))
            ORDER BY x.priority, x.card_slot LOOP
    IF k.mode = 'credit' THEN RETURN jsonb_build_object('ok', true, 'slot', k.card_slot, 'mode', 'credit'); END IF;
    PERFORM 1 FROM fleet_money_locations WHERE location_id = k.location_id FOR UPDATE;
    liq := fleet_location_liquidity(k.location_id);
    IF k.loc_status <> 'active' THEN
      first_refusal := COALESCE(first_refusal, jsonb_build_object('ok', false, 'code', 'FLEET_LOCATION_UNAVAILABLE', 'reason', 'the bank behind the card is ' || k.loc_status || ': card purchases wait (other payment routes are unaffected)'));
    ELSIF (liq ->> 'stale')::boolean THEN
      first_refusal := COALESCE(first_refusal, jsonb_build_object('ok', false, 'code', 'FLEET_LOCATION_EVIDENCE_STALE', 'reason', 'the bank balance is not fresh enough to rely on: card purchases wait for the next bank reading'));
    ELSIF p_max > (liq ->> 'freeMinor')::bigint THEN
      first_refusal := COALESCE(first_refusal, jsonb_build_object('ok', false, 'code', 'FLEET_LOCATION_INSUFFICIENT', 'freeMinor', (liq ->> 'freeMinor')::bigint,
        'reason', 'the bank account behind the card does not hold enough free cash for this hold (it is never overdrawn or topped up automatically)'));
    ELSE
      RETURN jsonb_build_object('ok', true, 'slot', k.card_slot, 'mode', 'debit', 'locationId', k.location_id);
    END IF;
  END LOOP;
  RETURN COALESCE(first_refusal, jsonb_build_object('ok', false, 'code', 'FLEET_OWNER_FACT_UNAVAILABLE', 'reason', CASE WHEN p_slot IS NULL THEN 'no card is on file' ELSE 'that card is not available' END));
END $$;

CREATE FUNCTION fleet_admin_card_slot_set(p_slot text, p_label text, p_mode text, p_loc uuid, p_priority integer, p_status text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_treasury');
  IF p_slot NOT IN (${q(CARD_SLOTS)}) OR p_mode NOT IN ('credit','debit') OR p_status NOT IN ('active','disabled') OR p_priority NOT BETWEEN 1 AND 9 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'slot ${CARD_SLOTS.join(" | ")}; mode credit | debit; priority 1..9; status active | disabled');
  END IF;
  IF (p_mode = 'debit') <> (p_loc IS NOT NULL) OR (p_loc IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fleet_money_locations WHERE location_id = p_loc AND kind = 'bank')) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'a debit card draws on one bank location; a credit card on none');
  END IF;
  INSERT INTO fleet_cards (card_slot, label, mode, location_id, priority, status, updated_by)
    VALUES (p_slot, left(COALESCE(NULLIF(btrim(p_label), ''), p_slot), 60), p_mode, p_loc, p_priority, p_status, p_actor)
    ON CONFLICT (card_slot) DO UPDATE SET label = EXCLUDED.label, mode = EXCLUDED.mode, location_id = EXCLUDED.location_id, priority = EXCLUDED.priority,
      status = EXCLUDED.status, updated_at = now(), updated_by = p_actor;
  -- The v86 flag stays true for the bank of the first active debit card (older readers of card_drawn).
  UPDATE fleet_money_locations SET card_drawn = false WHERE card_drawn;
  UPDATE fleet_money_locations SET card_drawn = true WHERE location_id = (SELECT location_id FROM fleet_cards WHERE mode = 'debit' AND status = 'active' ORDER BY priority, card_slot LIMIT 1);
  PERFORM fleet_event('card_slot_set', NULL, p_actor, jsonb_build_object('slot', p_slot, 'mode', p_mode, 'locationId', p_loc, 'priority', p_priority, 'status', p_status));
  RETURN jsonb_build_object('ok', true, 'slot', p_slot, 'note', 'upload the card itself as the owner''s identity class ' || p_slot || ' (encrypted to the identity broker)');
END $$;

${CARD_AUTHORIZE}
${SECRET_REQUEST}
${BIND_CARD}
${READINESS}

-- ═══ 2. A provisional chargeback reversed ═══
ALTER TABLE fleet_card_disputes DROP CONSTRAINT fleet_card_disputes_state_check;
ALTER TABLE fleet_card_disputes ADD CONSTRAINT fleet_card_disputes_state_check CHECK (state IN ('open','won','lost','withdrawn','reversed'));
ALTER TABLE fleet_card_disputes ADD COLUMN reversal_txn_id uuid UNIQUE REFERENCES fleet_bank_transactions(txn_id);

CREATE FUNCTION fleet_card_dispute_reverse(p_dispute uuid, p_txn uuid, p_actor text) RETURNS text LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE d fleet_card_disputes; c fleet_card_charges; t fleet_bank_transactions; r jsonb;
BEGIN
  SELECT * INTO d FROM fleet_card_disputes WHERE dispute_id = p_dispute FOR UPDATE;
  SELECT * INTO c FROM fleet_card_charges WHERE charge_id = d.charge_id FOR UPDATE;
  SELECT * INTO t FROM fleet_bank_transactions WHERE txn_id = p_txn FOR UPDATE;
  IF d.state <> 'won' OR d.reversal_txn_id IS NOT NULL OR t.classified IS NOT NULL OR t.direction <> 'out' OR t.status <> 'settled' OR t.location_id <> c.location_id
     OR t.amount_minor <> (SELECT amount_minor FROM fleet_bank_transactions WHERE txn_id = d.credit_txn_id) THEN
    RAISE EXCEPTION 'FLEET_INVALID_STATE: a won dispute and a settled debit of its credit''s amount at its bank';
  END IF;
  -- The charge goes back up: booked against the agent like any charge (its cash, then its debt; v88 shortfall rules).
  r := fleet_card_charge_post(c.charge_id, c.amount_minor + t.amount_minor, 'card:' || c.charge_id || ':dispute-reversal:' || t.txn_id, 'controller', 'bank:' || t.txn_id);
  UPDATE fleet_card_disputes SET state = 'reversed', reversal_txn_id = t.txn_id, outcome_note = left(COALESCE(outcome_note || '; ', '') || 'the bank took the provisional credit back', 300)
   WHERE dispute_id = d.dispute_id;
  UPDATE fleet_bank_transactions SET charge_id = c.charge_id, classified = 'card_charge', classified_by = left(p_actor, 128), journal_id = (r ->> 'journalId')::uuid, updated_at = now()
   WHERE txn_id = t.txn_id;
  PERFORM fleet_notify('AMBER', 'CARD_DISPUTE_REVERSED', c.agent_id, 'The bank took back a dispute credit for ' || c.merchant || ': the charge stands again',
    jsonb_build_object('disputeId', d.dispute_id, 'chargeId', c.charge_id, 'amountMinor', t.amount_minor), 'dispute-reversed:' || d.dispute_id);
  RETURN 'dispute_reversed';
END $$;
CREATE FUNCTION fleet_admin_card_dispute_reversal(p_txn uuid, p_dispute uuid, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_treasury');
  RETURN jsonb_build_object('ok', true, 'result', fleet_card_dispute_reverse(p_dispute, p_txn, p_actor));
END $$;
${MATCH}

-- ═══ 4. Unit economics per order and per venture ═══
-- A cognition call's references (recorded by the gateway: kind:id, never the arguments) → the order / venture they belong to.
CREATE FUNCTION fleet_ref_venture(p_agent text, p_ref text) RETURNS uuid LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT CASE split_part(p_ref, ':', 1)
    WHEN 'venture' THEN (SELECT venture_id FROM fleet_ventures WHERE agent_id = p_agent AND venture_key = split_part(p_ref, ':', 2))
    WHEN 'order' THEN (SELECT venture_id FROM fleet_customer_orders WHERE order_id::text = split_part(p_ref, ':', 2) AND agent_id = p_agent)
    WHEN 'offer' THEN (SELECT venture_id FROM fleet_offers WHERE offer_id::text = split_part(p_ref, ':', 2) AND agent_id = p_agent)
    WHEN 'enquiry' THEN (SELECT o.venture_id FROM fleet_offer_enquiries e JOIN fleet_offers o ON o.offer_id = e.offer_id WHERE e.enquiry_id::text = split_part(p_ref, ':', 2) AND e.agent_id = p_agent)
    WHEN 'repo' THEN (SELECT COALESCE((SELECT o.venture_id FROM fleet_offer_enquiries e JOIN fleet_offers o ON o.offer_id = e.offer_id WHERE e.enquiry_id = r.enquiry_id),
                                      (SELECT x.venture_id FROM fleet_customer_orders x WHERE x.order_id = r.order_id))
                        FROM fleet_repo_authorizations r WHERE r.authorization_id::text = split_part(p_ref, ':', 2) AND r.agent_id = p_agent)
  END
$$;
CREATE FUNCTION fleet_ref_order(p_agent text, p_ref text) RETURNS uuid LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT CASE split_part(p_ref, ':', 1)
    WHEN 'order' THEN (SELECT order_id FROM fleet_customer_orders WHERE order_id::text = split_part(p_ref, ':', 2) AND agent_id = p_agent)
    WHEN 'enquiry' THEN (SELECT order_id FROM fleet_offer_enquiries WHERE enquiry_id::text = split_part(p_ref, ':', 2) AND agent_id = p_agent)
    WHEN 'repo' THEN (SELECT COALESCE(r.order_id, (SELECT e.order_id FROM fleet_offer_enquiries e WHERE e.enquiry_id = r.enquiry_id))
                        FROM fleet_repo_authorizations r WHERE r.authorization_id::text = split_part(p_ref, ':', 2) AND r.agent_id = p_agent)
  END
$$;

CREATE FUNCTION fleet_unit_economics(p_agent text, p_days integer) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  WITH calls AS (
    SELECT l.agent_id, l.seq, l.charged_cents::numeric AS cost,
           ARRAY(SELECT DISTINCT x FROM jsonb_array_elements(l.tool_calls) tc, jsonb_array_elements_text(COALESCE(tc -> 'refs', '[]'::jsonb)) x) AS refs
      FROM fleet_cognition_log l
     WHERE (p_agent IS NULL OR l.agent_id = p_agent) AND l.at > now() - make_interval(days => GREATEST(LEAST(COALESCE(p_days, 90), 365), 1))),
  shares AS (  -- each call's cost split equally among the things it acted on
    SELECT c.agent_id, r AS ref, c.cost / cardinality(c.refs) AS cost FROM calls c, unnest(c.refs) r WHERE cardinality(c.refs) > 0),
  attributed AS (
    SELECT s.agent_id, s.cost, fleet_ref_order(s.agent_id, s.ref) AS order_id, fleet_ref_venture(s.agent_id, s.ref) AS venture_id FROM shares s),
  orders AS (
    SELECT x.order_id, x.agent_id, x.venture_id, x.item, x.status, x.payment_status, x.created_at,
           CASE WHEN x.payment_status IN ('paid','partially_refunded') THEN x.amount_minor ELSE 0 END AS revenue_minor,
           (SELECT count(*) FROM fleet_customer_messages m WHERE m.order_id = x.order_id AND m.author = 'buyer')
             + COALESCE((SELECT count(*) FROM fleet_customer_messages m WHERE m.enquiry_id = x.enquiry_id AND m.author = 'buyer'), 0) AS buyer_messages,
           (SELECT count(*) FROM fleet_customer_messages m WHERE m.order_id = x.order_id AND m.author = 'agent')
             + COALESCE((SELECT count(*) FROM fleet_customer_messages m WHERE m.enquiry_id = x.enquiry_id AND m.author = 'agent'), 0) AS agent_messages,
           (SELECT count(*) FROM fleet_order_deliveries d WHERE d.order_id = x.order_id) AS deliveries,
           (SELECT COALESCE(round(sum(a.cost)), 0) FROM attributed a WHERE a.order_id = x.order_id) AS ai_cost_minor
      FROM fleet_customer_orders x
     WHERE (p_agent IS NULL OR x.agent_id = p_agent) AND x.created_at > now() - make_interval(days => GREATEST(LEAST(COALESCE(p_days, 90), 365), 1)))
  SELECT jsonb_build_object('days', GREATEST(LEAST(COALESCE(p_days, 90), 365), 1),
    'orders', COALESCE((SELECT jsonb_agg(jsonb_build_object('orderId', o.order_id, 'agentId', o.agent_id, 'venture', v.venture_key, 'item', o.item, 'status', o.status,
                  'payment', o.payment_status, 'revenueMinor', o.revenue_minor, 'aiCostMinor', o.ai_cost_minor, 'buyerMessages', o.buyer_messages,
                  'agentMessages', o.agent_messages, 'deliveries', o.deliveries, 'revisions', GREATEST(o.deliveries - 1, 0),
                  'daysOpen', round(extract(epoch FROM (now() - o.created_at)) / 86400.0, 1)) ORDER BY o.created_at DESC)
                  FROM orders o LEFT JOIN fleet_ventures v ON v.venture_id = o.venture_id), '[]'::jsonb),
    'ventures', COALESCE((SELECT jsonb_agg(jsonb_build_object('ventureId', v.venture_id, 'venture', v.venture_key, 'agentId', v.agent_id,
                  'revenueMinor', COALESCE((SELECT sum(o.revenue_minor) FROM orders o WHERE o.venture_id = v.venture_id), 0),
                  'aiCostMinor', COALESCE((SELECT round(sum(a.cost)) FROM attributed a WHERE a.venture_id = v.venture_id), 0),
                  'orders', (SELECT count(*) FROM orders o WHERE o.venture_id = v.venture_id),
                  'buyerMessages', COALESCE((SELECT sum(o.buyer_messages) FROM orders o WHERE o.venture_id = v.venture_id), 0)) ORDER BY v.venture_key)
                  FROM fleet_ventures v WHERE (p_agent IS NULL OR v.agent_id = p_agent)), '[]'::jsonb),
    'generalAiCostMinor', COALESCE((SELECT round(sum(c.cost)) FROM calls c WHERE cardinality(c.refs) = 0), 0)
      + COALESCE((SELECT round(sum(a.cost)) FROM attributed a WHERE a.venture_id IS NULL AND a.order_id IS NULL), 0),
    'note', 'AI cost per order / venture: each AI call''s cost shared among the orders, enquiries, offers, ventures and repository accesses its tool calls acted on; calls that acted on none are general. Recorded from v90 on.')
$$;

${DISPATCH}
${DASH_CALL}
${LOCATIONS_JSON}
${OPS_WATCH}
`;

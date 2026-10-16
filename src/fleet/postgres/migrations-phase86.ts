/**
 * Schema v86 — P2 multi-location treasury (owner, 2026-10-16: "treat contributed bank funds as another treasury location in
 * the existing ledger, without double-counting transfers"; docs/design/bank-debit-card-requirements.md §8.3).
 *
 * ONE ledger. Agent wallets stay ledger sub-balances. Money LOCATIONS (the PayPal account, a bank account) are where the
 * Fleet's cash physically is; each has its own provider evidence, status and lock:
 *   - a TRANSFER between locations (the owner moves money; the Fleet never executes it) is the same money: no journal, no
 *     capital, no revenue. It leaves the source location's spendable cash when recorded and reaches the destination only
 *     through that location's next evidence (in transit meanwhile: spendable from neither);
 *   - a DEPOSIT the owner makes straight into the bank is owner funding, posted once against the bank transaction that
 *     shows it;
 *   - a location's cash is spendable only from FRESH provider evidence (available balance, not pending or held), less what
 *     the Fleet has committed there; a stale, limited or unavailable location blocks only the actions that use it (they
 *     wait, nothing is invented) and the hourly watch says so.
 *
 * The CARD on a bank location (DEBIT MODE; the owner binds it — card_drawn): the existing credit-card path is unchanged
 * when no location is bound. In debit mode a hold must also fit the bank location's fresh spendable cash (under the
 * location's lock); an agent's declared amount books nothing — a charge is booked only when the bank's own transaction
 * for it settles (matched by amount, time and merchant), with no card payable (the money left the bank); a decline or a
 * reversal releases the hold; a merchant refund (or a dispute the bank decides for the owner) reduces the charge. A used
 * hold the bank has not shown after 7 days is OVERDUE, not gone: it stays reserved and the owner is told; it is released
 * only on evidence (the bank's decline / reversal, or the owner's own check), and a charge the bank presents after a
 * release is still booked (late settlement: from the agent's cash, any shortfall an advance it repays) — the same money is
 * never spendable twice. Never booked at its maximum. Bank transactions nothing explains wait in the owner's queue.
 *
 * A TRANSFER completes only on evidence that it is THAT transfer: its reference in the bank line, or the source
 * provider's own record of the money leaving (PayPal's withdrawal) together with the source named on the bank line. An
 * unrelated credit of the same amount never completes one; the owner attributes anything else explicitly.
 *
 * WHOLE-TREASURY RECONCILIATION: every location's latest evidence plus money in transit, against what the books say the
 * treasury holds (fleet_capital_backing: books less unbacked capital).
 */
import { V49_SQL } from "./migrations-phase49.js";
import { V51_SQL } from "./migrations-phase51.js";
import { V54_SQL } from "./migrations-phase54.js";
import { V64_SQL } from "./migrations-phase64.js";
import { V77_SQL } from "./migrations-phase77.js";
import { V83_SQL } from "./migrations-phase83.js";
import { V85_SQL } from "./migrations-phase85.js";
import { restate } from "./migrations-phase42.js";

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
export const LOCATION_KINDS = ["paypal", "bank"] as const;
export const LOCATION_PROVIDERS = ["paypal", "starling", "airwallex", "revolut", "csv", "simulated"] as const;
export const LOCATION_STATUSES = ["pending_setup", "active", "limited", "unavailable"] as const;
export const BANK_TXN_STATUSES = ["pending", "settled", "declined", "reversed"] as const;
export const BANK_TXN_KINDS = ["card", "card_refund", "transfer", "fee", "interest", "other"] as const;
/** A used debit-card hold (card filled or amount declared) the bank has not shown after this many days is OVERDUE: still
 *  reserved, the owner is told; released only on evidence. Never booked at its maximum. */
export const DEBIT_EVIDENCE_DAYS = 7;
/** A charge the bank presents after its hold was released (late settlement) is still matched for this many days. */
export const LATE_SETTLEMENT_DAYS = 60;
/** Whole-treasury reconciliation: a difference beyond this (minor units) is reported. */
export const RECONCILE_TOLERANCE_MINOR = 100;
/** A transfer leaves its source (PayPal's withdrawal record) no earlier than this before it was recorded. */
export const TRANSFER_SOURCE_WINDOW_DAYS = 3;
/** A bank amount may exceed the hold by this share for FX / tips before it is not a match (basis points). */
export const DEBIT_MATCH_TOLERANCE_BP = 1000;
export const AGENT_OPS_V86 = ["card.awaiting_approval"] as const;
export const DASHBOARD_READ_OPS_V86 = ["locations"] as const;
export const DASHBOARD_SENSITIVE_OPS_V86 = ["location_add", "location_bind_card", "location_transfer", "location_contribution", "card_hold_release"] as const;
export const DASHBOARD_WRITE_OPS_V86_ADDED = ["location_status", "bank_txn_classify", "transfer_arrival", "card_dispute_open", "card_dispute_resolve"] as const;
/** The bank-feed connector's added surface (role fleet_bankfeed: read-only bank data in, nothing out). */
export const BANKFEED_API_FUNCTIONS_V86 = ["rx_location_balance(text, uuid, bigint, bigint, bigint, text)", "rx_location_txn(text, uuid, jsonb)", "rx_locations(text)"] as const;

// ── Card: debit mode on a bank location ──
const DEBIT_GATE = `
  -- v86: debit mode — the hold must also fit the bank location's fresh spendable cash (under that location's lock).
  SELECT * INTO loc FROM fleet_money_locations WHERE card_drawn ORDER BY created_at LIMIT 1;
  IF FOUND THEN
    PERFORM 1 FROM fleet_money_locations WHERE location_id = loc.location_id FOR UPDATE;
    liq := fleet_location_liquidity(loc.location_id);
    IF loc.status <> 'active' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_LOCATION_UNAVAILABLE', 'reason', 'the bank behind the card is ' || loc.status || ': card purchases wait (other payment routes are unaffected)');
    END IF;
    IF (liq ->> 'stale')::boolean THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_LOCATION_EVIDENCE_STALE', 'reason', 'the bank balance is not fresh enough to rely on: card purchases wait for the next bank reading');
    END IF;
    IF v_max > (liq ->> 'freeMinor')::bigint THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_LOCATION_INSUFFICIENT', 'freeMinor', (liq ->> 'freeMinor')::bigint,
        'reason', 'the bank account behind the card does not hold enough free cash for this hold (it is never overdrawn or topped up automatically)');
    END IF;
  END IF;
`;
const CARD_AUTHORIZE = restate(V64_SQL, "fleet_econ_card_authorize", [
  [`        eco jsonb; v_avail bigint; v_env uuid; v_j uuid; v_from text; rq fleet_card_requests;`,
   `        eco jsonb; v_avail bigint; v_env uuid; v_j uuid; v_from text; rq fleet_card_requests; loc fleet_money_locations; liq jsonb;`],
  [`  INSERT INTO fleet_card_charges (agent_id, merchant, origin, status, source, hold_max_minor, declare_by, funding, envelope_id, reserved_minor)
    VALUES (p_agent, left(fleet_scrub(v_merchant), 120), v_origin, 'held', 'agent', v_max, now() + interval '24 hours',
            CASE WHEN v_env IS NULL THEN 'own' ELSE 'envelope' END, v_env, v_max) RETURNING * INTO c;`,
   `${DEBIT_GATE}
  INSERT INTO fleet_card_charges (agent_id, merchant, origin, status, source, hold_max_minor, declare_by, funding, envelope_id, reserved_minor, location_id, evidence_status, venture_id)
    VALUES (p_agent, left(fleet_scrub(v_merchant), 120), v_origin, 'held', 'agent', v_max, now() + interval '24 hours',
            CASE WHEN v_env IS NULL THEN 'own' ELSE 'envelope' END, v_env, v_max, loc.location_id, CASE WHEN loc.location_id IS NOT NULL THEN 'awaiting' END,
            acc.venture_id) RETURNING * INTO c;`],
]);
const CARD_DECLARE = restate(V49_SQL, "fleet_econ_card_declare", [
  [`  r := fleet_card_charge_post(c.charge_id, v_amount, 'card:' || c.charge_id || ':book', 'controller', 'agent:' || p_agent);`,
   `  -- v86: debit mode — the agent's statement books nothing; the bank's settled transaction does.
  IF c.location_id IS NOT NULL THEN
    UPDATE fleet_card_charges SET declared_minor = v_amount, sca = COALESCE(CASE WHEN a ->> 'authentication' IN ('frictionless','challenged','exempt') THEN a ->> 'authentication' END, sca)
     WHERE charge_id = c.charge_id RETURNING * INTO c;
    PERFORM fleet_location_match_pending(c.location_id);
    SELECT * INTO c FROM fleet_card_charges WHERE charge_id = c.charge_id;
    RETURN jsonb_build_object('ok', true, 'charge', fleet_card_charge_json(c), 'evidence', c.evidence_status,
      'note', 'recorded; the charge is booked when the bank shows it settled (the rest of the reservation comes back then)');
  END IF;
  r := fleet_card_charge_post(c.charge_id, v_amount, 'card:' || c.charge_id || ':book', 'controller', 'agent:' || p_agent);`],
]);
const HOLDS_EXPIRE = restate(V51_SQL, "svc_card_holds_expire", [
  [`  FOR c IN SELECT * FROM fleet_card_charges WHERE status = 'held' AND declare_by <= now() ORDER BY declare_by LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500) FOR UPDATE SKIP LOCKED LOOP`,
   `  FOR c IN SELECT * FROM fleet_card_charges WHERE status = 'held' AND declare_by <= now() ORDER BY declare_by LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500) FOR UPDATE SKIP LOCKED LOOP
    -- v86: debit mode — never booked at its maximum. A hold the card was never used for is released as before; a used one
    -- (card filled or amount declared) waits for the bank's evidence, and after ${DEBIT_EVIDENCE_DAYS} days without it is OVERDUE:
    -- still reserved (the money may still leave), the owner told; released only on evidence (fleet_admin_card_hold_release).
    IF c.location_id IS NOT NULL THEN
      IF c.declared_minor IS NULL AND NOT EXISTS (SELECT 1 FROM fleet_identity_uses u WHERE u.charge_id = c.charge_id) THEN
        PERFORM fleet_card_hold_release(c.charge_id, c.reserved_minor, 'controller', 'controller');
        UPDATE fleet_card_charges SET status = 'void', evidence_status = 'none' WHERE charge_id = c.charge_id;
        PERFORM fleet_event('card_hold_voided', c.agent_id, 'controller', jsonb_build_object('chargeId', c.charge_id, 'reason', 'expired unused'));
        nv := nv + 1;
      ELSIF c.evidence_status IN ('awaiting','authorised') AND c.created_at < now() - interval '${DEBIT_EVIDENCE_DAYS} days' THEN
        UPDATE fleet_card_charges SET evidence_status = 'overdue' WHERE charge_id = c.charge_id;
        PERFORM fleet_notify('AMBER', 'CARD_HOLD_UNRESOLVED', c.agent_id, 'A card purchase at ' || c.merchant || ' has no bank record after ${DEBIT_EVIDENCE_DAYS} days: its money stays reserved',
          jsonb_build_object('chargeId', c.charge_id, 'merchant', c.merchant, 'holdMaxMinor', c.hold_max_minor, 'declaredMinor', c.declared_minor,
            'next', 'check the bank app: if nothing was or will be charged, release it (Treasury → Money locations); otherwise it books when the bank shows it'),
          'card-overdue:' || c.charge_id);
      END IF;
      CONTINUE;
    END IF;`],
]);
const CHARGE_POST = restate(V54_SQL, "fleet_card_charge_post", [
  [`  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a positive amount'; END IF;`,
   `  -- v86: a debit charge refunded in full (by the merchant, or a dispute the bank decided) goes to zero; nothing else may.
  IF p_amount IS NULL OR p_amount < 0 OR (p_amount = 0 AND (ch.location_id IS NULL OR ch.status NOT IN ('booked','confirmed'))) THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: a positive amount';
  END IF;`],
  [`    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'fleet:card:reserve', 'side', 'D', 'amount', d),
                                            jsonb_build_object('account', 'fleet:card:payable', 'side', 'C', 'amount', d));`,
   `    -- v86: a debit-card charge left the bank at once — no card payable to repay later.
    IF ch.location_id IS NULL THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'fleet:card:reserve', 'side', 'D', 'amount', d),
                                              jsonb_build_object('account', 'fleet:card:payable', 'side', 'C', 'amount', d));
    END IF;`],
  [`    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'fleet:card:payable', 'side', 'D', 'amount', -d),
                                            jsonb_build_object('account', 'fleet:card:reserve', 'side', 'C', 'amount', -d));`,
   `    IF ch.location_id IS NULL THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'fleet:card:payable', 'side', 'D', 'amount', -d),
                                              jsonb_build_object('account', 'fleet:card:reserve', 'side', 'C', 'amount', -d));
    END IF;`],
]);

// A debit charge released earlier and presented late by the merchant is booked after all (the only way back from void).
const CHARGES_GUARD = restate(V51_SQL, "fleet_card_charges_guard", [
  [`  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'held' AND NEW.status IN ('booked','void','confirmed')) OR (OLD.status = 'booked' AND NEW.status = 'confirmed')) THEN`,
   `  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'held' AND NEW.status IN ('booked','void','confirmed')) OR (OLD.status = 'booked' AND NEW.status = 'confirmed')
     OR (OLD.status = 'void' AND NEW.status = 'booked' AND OLD.location_id IS NOT NULL AND OLD.evidence_status = 'late')) THEN`],
]);

// Debit mode: once the agent has declared what was charged, the hold is no longer the agent's to void (only the bank's
// evidence or the owner's check releases it); an unused hold voids as before.
const CARD_VOID = restate(V51_SQL, "fleet_econ_card_void", [
  [`  PERFORM fleet_card_hold_release(c.charge_id, c.reserved_minor, 'agent:' || p_agent, 'controller');
  UPDATE fleet_card_charges SET status = 'void' WHERE charge_id = c.charge_id RETURNING * INTO c;`,
   `  IF c.location_id IS NOT NULL AND c.declared_minor IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CARD_USED', 'reason', 'you declared a charge for this hold: it books when the bank shows it (or is released if the bank never takes it)');
  END IF;
  PERFORM fleet_card_hold_release(c.charge_id, c.reserved_minor, 'agent:' || p_agent, 'controller');
  UPDATE fleet_card_charges SET status = 'void', evidence_status = CASE WHEN location_id IS NOT NULL THEN 'none' END WHERE charge_id = c.charge_id RETURNING * INTO c;`],
]);

// ── PayPal: a location like any other — transfers out of it leave its spendable cash at once; a limitation blocks it ──
const TREASURY_LIQUIDITY = restate(V77_SQL, "fleet_treasury_liquidity", [
  [`        v_card_paid bigint; v_owner_paid bigint; v_withdrawn bigint; v_avail bigint;`,
   `        v_card_paid bigint; v_owner_paid bigint; v_withdrawn bigint; v_avail bigint; v_moved bigint; v_status text;`],
  [`  SELECT COALESCE(sum(amount_minor), 0) INTO v_withdrawn FROM fleet_owner_withdrawal_records WHERE recorded_at > v_at;`,
   `  SELECT COALESCE(sum(amount_minor), 0) INTO v_withdrawn FROM fleet_owner_withdrawal_records WHERE recorded_at > v_at;
  -- v86: money the owner moved to another location after the reading (the same money: it is in transit or arrived there).
  SELECT COALESCE(sum(t.amount_minor), 0) INTO v_moved FROM fleet_location_transfers t JOIN fleet_money_locations l ON l.location_id = t.from_location
   WHERE l.rail_id = ANY (v_rails) AND t.state <> 'cancelled' AND t.recorded_at > v_at;
  SELECT status INTO v_status FROM fleet_money_locations WHERE rail_id = ANY (v_rails) ORDER BY created_at LIMIT 1;`],
  [`    'stale', b.observation_id IS NULL OR b.observed_at < now() - interval '`, `    'locationStatus', COALESCE(v_status, 'active'), 'movedToOtherLocationMinor', v_moved,
    'stale', COALESCE(v_status, 'active') NOT IN ('active') OR b.observation_id IS NULL OR b.observed_at < now() - interval '`],
  [`    'freeMinor', v_avail - v_ins - v_req - v_sent - v_card - v_owner - v_settled - v_refunded - v_card_paid - v_owner_paid - v_withdrawn);`,
   `    'freeMinor', CASE WHEN COALESCE(v_status, 'active') <> 'active' THEN 0
                      ELSE v_avail - v_ins - v_req - v_sent - v_card - v_owner - v_settled - v_refunded - v_card_paid - v_owner_paid - v_withdrawn - v_moved END);`],
]);

const DISPATCH = restate(V85_SQL, "api_economy", [
  [`WHEN 'media.result' THEN 'planning'`, `WHEN 'media.result' THEN 'planning' ${AGENT_OPS_V86.map((o) => `WHEN '${o}' THEN 'planning'`).join(" ")}`],
  [`      WHEN 'media.result' THEN fleet_econ_media_result(p_agent, a)`, `      WHEN 'media.result' THEN fleet_econ_media_result(p_agent, a)
      WHEN 'card.awaiting_approval' THEN fleet_econ_card_awaiting_approval(p_agent, a)`],
]);
const DASH_CALL = restate(V85_SQL, "dash_call", [
  [`'launch','helpers','push','capabilities')) THEN`, `'launch','helpers','push','capabilities',${q(DASHBOARD_READ_OPS_V86)})) THEN`],
  [`      WHEN 'capabilities' THEN fleet_capabilities_json()`, `      WHEN 'capabilities' THEN fleet_capabilities_json()
      WHEN 'locations' THEN fleet_locations_json()`],
  [`'outward_release','channel_connect','push_device_add');`, `'outward_release','channel_connect','push_device_add',${q(DASHBOARD_SENSITIVE_OPS_V86)});`],
  [`'outward_hold','channel_disconnect','push_device_revoke','push_test','push_test_received');`, `'outward_hold','channel_disconnect','push_device_revoke','push_test','push_test_received',${q(DASHBOARD_WRITE_OPS_V86_ADDED)});`],
  [`      WHEN 'push_device_revoke' THEN`, `      WHEN 'location_status' THEN fleet_admin_location_status((a ->> 'locationId')::uuid, a ->> 'status', a ->> 'note', 'operator:owner')
      WHEN 'bank_txn_classify' THEN fleet_admin_bank_txn_classify((a ->> 'txnId')::uuid, a ->> 'as', a ->> 'note', 'operator:owner')
      WHEN 'transfer_arrival' THEN fleet_admin_transfer_arrival((a ->> 'txnId')::uuid, (a ->> 'transferId')::uuid, 'operator:owner')
      WHEN 'card_dispute_open' THEN fleet_admin_card_dispute_open((a ->> 'chargeId')::uuid, (a ->> 'amountMinor')::bigint, a ->> 'reason', 'operator:owner')
      WHEN 'card_dispute_resolve' THEN fleet_admin_card_dispute_resolve((a ->> 'disputeId')::uuid, a ->> 'outcome', NULLIF(a ->> 'txnId', '')::uuid, a ->> 'note', 'operator:owner')
      WHEN 'push_device_revoke' THEN`],
  [`      WHEN 'push_device_add' THEN`, `      WHEN 'location_add' THEN fleet_admin_location_add(a ->> 'kind', a ->> 'provider', a ->> 'label', NULLIF(a ->> 'railId', '')::uuid, 'operator:owner')
      WHEN 'location_bind_card' THEN fleet_admin_location_bind_card(NULLIF(a ->> 'locationId', '')::uuid, 'operator:owner')
      WHEN 'location_transfer' THEN fleet_admin_location_transfer((a ->> 'fromLocation')::uuid, (a ->> 'toLocation')::uuid, (a ->> 'amountMinor')::bigint, a ->> 'reference', 'operator:owner')
      WHEN 'location_contribution' THEN fleet_admin_location_contribution((a ->> 'txnId')::uuid, 'operator:owner')
      WHEN 'card_hold_release' THEN fleet_admin_card_hold_release((a ->> 'chargeId')::uuid, a ->> 'evidence', 'operator:owner')
      WHEN 'push_device_add' THEN`],
]);
const OPS_WATCH = restate(V83_SQL, "svc_operations_watch", [
  [`DECLARE h jsonb := fleet_economy_health(); x jsonb; n integer := 0; o record; c record;`,
   `DECLARE h jsonb := fleet_economy_health(); x jsonb; n integer := 0; o record; c record; k bigint; rec jsonb;`],
  [`  RETURN jsonb_build_object('ok', true, 'raised', n);`,
   `  -- v86: money locations — stale evidence on an active location, bank transactions nothing explains, balance drift, a
  -- negative bank balance, a limited or unavailable location; transfers' provider evidence; card holds still unresolved;
  -- disputes the bank has not decided; the whole treasury against the books.
  PERFORM fleet_location_transfers_evidence();
  PERFORM fleet_location_match_pending(location_id) FROM fleet_money_locations WHERE kind = 'bank' AND status <> 'pending_setup';
  SELECT count(*) INTO k FROM fleet_card_charges WHERE location_id IS NOT NULL AND status = 'held' AND evidence_status = 'overdue';
  IF k > 0 AND fleet_notify('AMBER', 'CARD_HOLDS_UNRESOLVED', NULL, k || ' card purchase(s) still have no bank record: their money stays reserved',
       jsonb_build_object('count', k), 'card-overdue-daily:' || day) THEN n := n + 1; END IF;
  SELECT count(*) INTO k FROM fleet_card_disputes WHERE state = 'open' AND opened_at < now() - interval '30 days';
  IF k > 0 AND fleet_notify('AMBER', 'CARD_DISPUTES_OPEN', NULL, k || ' card dispute(s) open for over 30 days', jsonb_build_object('count', k), 'card-disputes:' || day) THEN n := n + 1; END IF;
  rec := fleet_treasury_reconciliation();
  IF rec ->> 'state' = 'difference' AND fleet_notify('AMBER', 'TREASURY_UNRECONCILED', NULL,
       'The money in your accounts differs from the books by ' || (rec ->> 'differenceMinor') || ' (minor units)', rec - 'locations', 'treasury-recon:' || day) THEN n := n + 1; END IF;
  FOR c IN SELECT l.location_id, l.label, l.status, fleet_location_liquidity(l.location_id) AS liq, fleet_location_drift(l.location_id) AS drift,
                  (SELECT count(*) FROM fleet_bank_transactions t WHERE t.location_id = l.location_id AND t.classified IS NULL AND t.first_seen < now() - interval '24 hours') AS unexplained
             FROM fleet_money_locations l WHERE l.kind = 'bank' AND l.status <> 'pending_setup' LOOP
    IF c.status IN ('limited','unavailable') AND fleet_notify('RED', 'LOCATION_UNAVAILABLE', NULL, 'A money location is ' || c.status || ': ' || c.label,
         jsonb_build_object('locationId', c.location_id), 'loc-status:' || c.location_id || ':' || c.status || ':' || day) THEN n := n + 1; END IF;
    IF c.status = 'active' AND (c.liq ->> 'stale')::boolean AND fleet_notify('AMBER', 'LOCATION_EVIDENCE_STALE', NULL, 'No fresh balance from ' || c.label || ': its spending waits',
         jsonb_build_object('locationId', c.location_id, 'observedAt', c.liq ->> 'observedAt'), 'loc-stale:' || c.location_id || ':' || day) THEN n := n + 1; END IF;
    IF c.unexplained > 0 AND fleet_notify('RED', 'BANK_TRANSACTIONS_UNEXPLAINED', NULL, c.unexplained || ' bank transaction(s) nothing explains at ' || c.label,
         jsonb_build_object('locationId', c.location_id, 'count', c.unexplained), 'loc-unexplained:' || c.location_id || ':' || day) THEN n := n + 1; END IF;
    IF (c.drift ->> 'driftMinor')::bigint <> 0 AND fleet_notify('RED', 'LOCATION_DRIFT', NULL, 'The balance at ' || c.label || ' does not match its transactions',
         c.drift, 'loc-drift:' || c.location_id || ':' || day) THEN n := n + 1; END IF;
    IF COALESCE((c.liq ->> 'availableMinor')::bigint, 0) < 0 AND fleet_notify('RED', 'LOCATION_NEGATIVE', NULL, c.label || ' is overdrawn',
         jsonb_build_object('locationId', c.location_id, 'availableMinor', c.liq ->> 'availableMinor'), 'loc-negative:' || c.location_id || ':' || day) THEN n := n + 1; END IF;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'raised', n);`],
]);

export const V86_SQL = `
-- ═══ 1. Money locations and their evidence ═══
CREATE TABLE fleet_money_locations (
  location_id  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text        NOT NULL CHECK (kind IN (${q(LOCATION_KINDS)})),
  provider     text        NOT NULL CHECK (provider IN (${q(LOCATION_PROVIDERS)})),
  label        text        NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  currency     text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  rail_id      uuid        UNIQUE REFERENCES fleet_payment_rails(rail_id),
  status       text        NOT NULL DEFAULT 'pending_setup' CHECK (status IN (${q(LOCATION_STATUSES)})),
  status_note  text        CHECK (length(status_note) <= 300),
  evidence_max_age_hours integer NOT NULL DEFAULT 24 CHECK (evidence_max_age_hours BETWEEN 1 AND 168),
  card_drawn   boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text        NOT NULL,
  CHECK ((kind = 'paypal') = (rail_id IS NOT NULL)),
  CHECK (NOT card_drawn OR kind = 'bank')
);
CREATE UNIQUE INDEX fleet_money_locations_one_card ON fleet_money_locations ((true)) WHERE card_drawn;
CREATE TRIGGER fleet_money_locations_no_delete BEFORE DELETE ON fleet_money_locations FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
-- The PayPal account(s) the Fleet already uses become locations (active, as today).
INSERT INTO fleet_money_locations (kind, provider, label, currency, rail_id, status, evidence_max_age_hours, updated_by)
  SELECT 'paypal', 'paypal', COALESCE(left(r.label, 80), 'PayPal treasury'), COALESCE((SELECT accounting_currency FROM fleet_economic_model WHERE id = 1), 'GBP'),
         r.rail_id, 'active', 3, 'migration'
    FROM fleet_payment_rails r WHERE r.provider = 'paypal';

-- A PayPal rail registered later becomes a location too (active, like the treasury rail it is).
CREATE FUNCTION fleet_money_location_for_rail() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF NEW.provider = 'paypal' THEN
    INSERT INTO fleet_money_locations (kind, provider, label, currency, rail_id, status, evidence_max_age_hours, updated_by)
      VALUES ('paypal', 'paypal', COALESCE(left(NEW.label, 80), 'PayPal treasury'), COALESCE((SELECT accounting_currency FROM fleet_economic_model WHERE id = 1), 'GBP'),
              NEW.rail_id, 'active', 3, 'rail-registration')
      ON CONFLICT (rail_id) DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER fleet_money_location_for_rail AFTER INSERT ON fleet_payment_rails FOR EACH ROW EXECUTE FUNCTION fleet_money_location_for_rail();

CREATE TABLE fleet_bank_balance_observations (
  observation_id  bigserial   PRIMARY KEY,
  location_id     uuid        NOT NULL REFERENCES fleet_money_locations(location_id),
  available_minor bigint      NOT NULL,
  cleared_minor   bigint,
  pending_minor   bigint,
  source          text        NOT NULL CHECK (source IN ('api','csv','owner','simulated')),
  observed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_bank_balance_observations_latest ON fleet_bank_balance_observations (location_id, observed_at DESC);
CREATE TRIGGER fleet_bank_balance_observations_no_change BEFORE UPDATE OR DELETE ON fleet_bank_balance_observations FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_bank_transactions (
  txn_id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id     uuid        NOT NULL REFERENCES fleet_money_locations(location_id),
  external_id     text        NOT NULL CHECK (length(external_id) BETWEEN 1 AND 120),
  status          text        NOT NULL CHECK (status IN (${q(BANK_TXN_STATUSES)})),
  direction       text        NOT NULL CHECK (direction IN ('in','out')),
  kind            text        NOT NULL CHECK (kind IN (${q(BANK_TXN_KINDS)})),
  amount_minor    bigint      NOT NULL CHECK (amount_minor > 0),
  currency        text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  original_amount_minor bigint CHECK (original_amount_minor > 0),
  original_currency text      CHECK (original_currency ~ '^[A-Z]{3}$'),
  fx_rate         numeric     CHECK (fx_rate > 0),
  fee_minor       bigint      CHECK (fee_minor >= 0),
  descriptor      text        CHECK (length(descriptor) <= 140),
  authorised_at   timestamptz,
  settled_at      timestamptz,
  source          text        NOT NULL CHECK (source IN ('api','csv','simulated')),
  charge_id       uuid        REFERENCES fleet_card_charges(charge_id),
  transfer_id     uuid,
  classified      text        CHECK (classified IN ('card_charge','card_refund','transfer_in','transfer_out','owner_contribution','fee','explained')),
  classified_by   text,
  classified_note text        CHECK (length(classified_note) <= 300),
  journal_id      uuid,
  first_seen      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, external_id)
);
CREATE INDEX fleet_bank_transactions_open ON fleet_bank_transactions (location_id, first_seen) WHERE classified IS NULL;
CREATE TRIGGER fleet_bank_transactions_no_delete BEFORE DELETE ON fleet_bank_transactions FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_location_transfers (
  transfer_id   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  from_location uuid        NOT NULL REFERENCES fleet_money_locations(location_id),
  to_location   uuid        NOT NULL REFERENCES fleet_money_locations(location_id),
  amount_minor  bigint      NOT NULL CHECK (amount_minor > 0),
  currency      text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  state         text        NOT NULL DEFAULT 'in_transit' CHECK (state IN ('in_transit','arrived','cancelled')),
  reference     text        NOT NULL CHECK (length(reference) BETWEEN 3 AND 120),
  arrival_txn_id uuid       REFERENCES fleet_bank_transactions(txn_id),
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  arrived_at    timestamptz,
  recorded_by   text        NOT NULL,
  CHECK (from_location <> to_location),
  -- What shows it is THIS transfer: the source provider's record of the money leaving, and how its arrival was attributed.
  source_evidence text       UNIQUE CHECK (length(source_evidence) <= 160),
  source_seen_at  timestamptz,
  arrival_basis   text       CHECK (arrival_basis IN ('reference','source_evidence','provider','owner')),
  arrival_evidence text      UNIQUE CHECK (length(arrival_evidence) <= 160),
  UNIQUE (from_location, reference)
);
CREATE TRIGGER fleet_location_transfers_no_delete BEFORE DELETE ON fleet_location_transfers FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

ALTER TABLE fleet_card_charges ADD COLUMN location_id uuid REFERENCES fleet_money_locations(location_id);
ALTER TABLE fleet_card_charges ADD COLUMN evidence_status text CHECK (evidence_status IN ('awaiting','authorised','settled','declined','reversed','none','overdue','released','late'));
ALTER TABLE fleet_card_charges ADD COLUMN declared_minor bigint CHECK (declared_minor > 0);
ALTER TABLE fleet_card_charges ADD COLUMN bank_txn_id uuid REFERENCES fleet_bank_transactions(txn_id);
ALTER TABLE fleet_card_charges ADD COLUMN sca text CHECK (sca IN ('frictionless','challenged','exempt'));
ALTER TABLE fleet_card_charges ADD COLUMN awaiting_approval_since timestamptz;
ALTER TABLE fleet_card_charges ADD CONSTRAINT fleet_card_charges_debit_evidence CHECK ((location_id IS NULL) = (evidence_status IS NULL));
ALTER TABLE fleet_card_charges ADD COLUMN venture_id uuid REFERENCES fleet_ventures(venture_id);
COMMENT ON COLUMN fleet_card_charges.venture_id IS 'v86: the venture the purchase is for (the merchant account''s venture when the hold was opened)';
-- A debit charge refunded in full stands at zero (credit-mode charges stay positive: fleet_card_charge_post).
ALTER TABLE fleet_card_charges DROP CONSTRAINT fleet_card_charges_amount_minor_check;
ALTER TABLE fleet_card_charges ADD CONSTRAINT fleet_card_charges_amount_minor_check CHECK (amount_minor >= 0 AND (amount_minor > 0 OR location_id IS NOT NULL));

-- Disputes the owner raises with the bank on a debit-card charge. The bank decides; its credit (matched, or attributed by
-- the owner) reduces the charge. Nothing is booked when a dispute opens.
CREATE TABLE fleet_card_disputes (
  dispute_id    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  charge_id     uuid        NOT NULL REFERENCES fleet_card_charges(charge_id),
  amount_minor  bigint      NOT NULL CHECK (amount_minor > 0),
  reason        text        NOT NULL CHECK (length(reason) BETWEEN 5 AND 300),
  state         text        NOT NULL DEFAULT 'open' CHECK (state IN ('open','won','lost','withdrawn')),
  credit_txn_id uuid        UNIQUE REFERENCES fleet_bank_transactions(txn_id),
  outcome_note  text        CHECK (length(outcome_note) <= 300),
  opened_by     text        NOT NULL,
  opened_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  CHECK ((state = 'open') = (resolved_at IS NULL))
);
CREATE UNIQUE INDEX fleet_card_disputes_one_open ON fleet_card_disputes (charge_id) WHERE state = 'open';
CREATE TRIGGER fleet_card_disputes_no_delete BEFORE DELETE ON fleet_card_disputes FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- ═══ 2. What a location can spend now, and whether its balance matches its transactions ═══
CREATE FUNCTION fleet_location_liquidity(p_loc uuid) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE l fleet_money_locations; b fleet_bank_balance_observations; v_at timestamptz; v_holds bigint; v_out bigint; v_settled bigint;
BEGIN
  SELECT * INTO l FROM fleet_money_locations WHERE location_id = p_loc;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF l.kind = 'paypal' THEN RETURN fleet_treasury_liquidity(l.rail_id) || jsonb_build_object('locationId', l.location_id, 'kind', 'paypal'); END IF;
  SELECT * INTO b FROM fleet_bank_balance_observations WHERE location_id = p_loc ORDER BY observed_at DESC, observation_id DESC LIMIT 1;
  v_at := COALESCE(b.observed_at, '-infinity'::timestamptz);
  -- Fleet holds the bank has not shown yet (an authorised or settled charge is already in the bank's available balance).
  SELECT COALESCE(sum(reserved_minor), 0) INTO v_holds FROM fleet_card_charges WHERE location_id = p_loc AND status = 'held' AND bank_txn_id IS NULL;
  -- Money the owner moved out after the reading.
  SELECT COALESCE(sum(amount_minor), 0) INTO v_out FROM fleet_location_transfers WHERE from_location = p_loc AND state <> 'cancelled' AND recorded_at > v_at;
  -- Debits the bank first showed after the reading, authorised or settled (the reading's available balance did not carry them).
  SELECT COALESCE(sum(amount_minor), 0) INTO v_settled FROM fleet_bank_transactions WHERE location_id = p_loc AND direction = 'out'
     AND status IN ('pending','settled') AND COALESCE(authorised_at, settled_at, first_seen) > v_at;
  RETURN jsonb_build_object('locationId', p_loc, 'kind', l.kind, 'status', l.status, 'currency', l.currency, 'availableMinor', b.available_minor,
    'pendingMinor', b.pending_minor, 'observedAt', b.observed_at,
    'stale', b.observation_id IS NULL OR b.observed_at < now() - make_interval(hours => l.evidence_max_age_hours),
    'committed', jsonb_build_object('holdsAwaitingBankMinor', v_holds, 'movedOutMinor', v_out, 'debitsSinceReadingMinor', v_settled),
    'freeMinor', CASE WHEN l.status <> 'active' OR b.observation_id IS NULL THEN 0 ELSE GREATEST(b.available_minor, 0) - v_holds - v_out - v_settled END);
END $$;

-- Between the last two readings, the balance moved by exactly what settled in between (else: drift, a P1).
CREATE FUNCTION fleet_location_drift(p_loc uuid) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE b1 fleet_bank_balance_observations; b2 fleet_bank_balance_observations; v_in bigint; v_out bigint;
BEGIN
  SELECT * INTO b2 FROM fleet_bank_balance_observations WHERE location_id = p_loc AND cleared_minor IS NOT NULL ORDER BY observed_at DESC, observation_id DESC LIMIT 1;
  SELECT * INTO b1 FROM fleet_bank_balance_observations WHERE location_id = p_loc AND cleared_minor IS NOT NULL AND observation_id <> b2.observation_id ORDER BY observed_at DESC, observation_id DESC LIMIT 1;
  IF b1.observation_id IS NULL THEN RETURN jsonb_build_object('locationId', p_loc, 'driftMinor', 0, 'note', 'fewer than two cleared readings'); END IF;
  SELECT COALESCE(sum(amount_minor) FILTER (WHERE direction = 'in'), 0), COALESCE(sum(amount_minor) FILTER (WHERE direction = 'out'), 0) INTO v_in, v_out
    FROM fleet_bank_transactions WHERE location_id = p_loc AND status = 'settled' AND settled_at > b1.observed_at AND settled_at <= b2.observed_at;
  RETURN jsonb_build_object('locationId', p_loc, 'from', b1.observed_at, 'to', b2.observed_at, 'clearedBefore', b1.cleared_minor, 'clearedAfter', b2.cleared_minor,
    'settledInMinor', v_in, 'settledOutMinor', v_out, 'driftMinor', b2.cleared_minor - b1.cleared_minor - v_in + v_out);
END $$;

-- ═══ 3. Matching the bank's evidence to the Fleet's records ═══
-- A card debit settles / authorises / declines one held debit-mode charge (or, presented late, one released after use); a
-- card credit settles an open dispute or refunds one booked charge; an incoming credit completes a transfer only on evidence
-- that it is that transfer. Ambiguous or unknown items wait for the owner (never guessed).
CREATE FUNCTION fleet_norm(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT regexp_replace(lower(COALESCE(p, '')), '[^a-z0-9]', '', 'g') $$;

-- The bank line names the transfer's source: its provider (PayPal, Starling …) or, for a statement-only bank, its label.
CREATE FUNCTION fleet_location_source_named(p_from uuid, p_descriptor text) RETURNS boolean LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM fleet_money_locations l WHERE l.location_id = p_from
    AND position(CASE WHEN l.provider IN ('csv','simulated') THEN fleet_norm(l.label) ELSE fleet_norm(l.provider) END IN fleet_norm(p_descriptor)) > 0)
$$;

CREATE FUNCTION fleet_location_match(p_txn uuid) RETURNS text LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE t fleet_bank_transactions; ch fleet_card_charges; n integer; tr fleet_location_transfers; r jsonb; dsp fleet_card_disputes; v_at timestamptz;
BEGIN
  SELECT * INTO t FROM fleet_bank_transactions WHERE txn_id = p_txn FOR UPDATE;
  v_at := COALESCE(t.authorised_at, t.settled_at, t.first_seen);
  IF t.kind = 'card' AND t.direction = 'out' THEN
    IF t.charge_id IS NULL THEN
      -- Candidates: open debit-mode holds on this location, opened before the bank saw it, that the amount fits.
      SELECT count(*) INTO n FROM fleet_card_charges c WHERE c.location_id = t.location_id AND c.status = 'held' AND c.bank_txn_id IS NULL
         AND c.created_at <= v_at + interval '1 hour'
         AND t.amount_minor * 10000 <= c.hold_max_minor * (10000 + ${DEBIT_MATCH_TOLERANCE_BP})
         AND (c.declared_minor IS NULL OR abs(c.declared_minor - t.amount_minor) * 10000 <= c.declared_minor * ${DEBIT_MATCH_TOLERANCE_BP});
      IF n > 1 THEN RETURN 'ambiguous'; END IF;
      IF n = 1 THEN
        SELECT c.* INTO ch FROM fleet_card_charges c WHERE c.location_id = t.location_id AND c.status = 'held' AND c.bank_txn_id IS NULL
           AND c.created_at <= v_at + interval '1 hour'
           AND t.amount_minor * 10000 <= c.hold_max_minor * (10000 + ${DEBIT_MATCH_TOLERANCE_BP})
           AND (c.declared_minor IS NULL OR abs(c.declared_minor - t.amount_minor) * 10000 <= c.declared_minor * ${DEBIT_MATCH_TOLERANCE_BP}) FOR UPDATE;
      ELSE
        -- Late settlement: a used hold released earlier (by the bank's reversal or the owner's check) that the merchant
        -- presents after all. It is still booked — the agent bears it — so nothing is spendable twice.
        SELECT count(*) INTO n FROM fleet_card_charges c WHERE c.location_id = t.location_id AND c.status = 'void' AND c.evidence_status IN ('released','reversed')
           AND (c.declared_minor IS NOT NULL OR EXISTS (SELECT 1 FROM fleet_identity_uses u WHERE u.charge_id = c.charge_id))
           AND c.created_at BETWEEN v_at - interval '${LATE_SETTLEMENT_DAYS} days' AND v_at + interval '1 hour' AND c.bank_txn_id IS DISTINCT FROM t.txn_id
           AND t.amount_minor * 10000 <= c.hold_max_minor * (10000 + ${DEBIT_MATCH_TOLERANCE_BP})
           AND (c.declared_minor IS NULL OR abs(c.declared_minor - t.amount_minor) * 10000 <= c.declared_minor * ${DEBIT_MATCH_TOLERANCE_BP});
        IF n <> 1 THEN RETURN CASE WHEN n = 0 THEN 'unmatched' ELSE 'ambiguous' END; END IF;
        SELECT c.* INTO ch FROM fleet_card_charges c WHERE c.location_id = t.location_id AND c.status = 'void' AND c.evidence_status IN ('released','reversed')
           AND (c.declared_minor IS NOT NULL OR EXISTS (SELECT 1 FROM fleet_identity_uses u WHERE u.charge_id = c.charge_id))
           AND c.created_at BETWEEN v_at - interval '${LATE_SETTLEMENT_DAYS} days' AND v_at + interval '1 hour' AND c.bank_txn_id IS DISTINCT FROM t.txn_id
           AND t.amount_minor * 10000 <= c.hold_max_minor * (10000 + ${DEBIT_MATCH_TOLERANCE_BP})
           AND (c.declared_minor IS NULL OR abs(c.declared_minor - t.amount_minor) * 10000 <= c.declared_minor * ${DEBIT_MATCH_TOLERANCE_BP}) FOR UPDATE;
        UPDATE fleet_card_charges SET evidence_status = 'late' WHERE charge_id = ch.charge_id RETURNING * INTO ch;
        PERFORM fleet_notify('AMBER', 'CARD_LATE_SETTLEMENT', ch.agent_id, 'A card purchase at ' || ch.merchant || ' was charged after its hold was released',
          jsonb_build_object('chargeId', ch.charge_id, 'amountMinor', t.amount_minor, 'txnId', t.txn_id), 'card-late:' || ch.charge_id || ':' || t.txn_id);
      END IF;
      UPDATE fleet_bank_transactions SET charge_id = ch.charge_id, classified = 'card_charge', classified_by = 'matcher' WHERE txn_id = t.txn_id RETURNING * INTO t;
      UPDATE fleet_card_charges SET bank_txn_id = t.txn_id WHERE charge_id = ch.charge_id;
    END IF;
    SELECT * INTO ch FROM fleet_card_charges WHERE charge_id = t.charge_id FOR UPDATE;
    IF t.status = 'pending' AND ch.status = 'held' THEN
      UPDATE fleet_card_charges SET evidence_status = 'authorised' WHERE charge_id = ch.charge_id;
      RETURN 'authorised';
    ELSIF t.status = 'settled' AND (ch.status = 'held' OR (ch.status = 'void' AND ch.evidence_status = 'late')) THEN
      r := fleet_card_charge_post(ch.charge_id, t.amount_minor, 'card:' || ch.charge_id || ':bank', 'controller', 'bank:' || t.txn_id);
      UPDATE fleet_card_charges SET evidence_status = 'settled', status = 'booked' WHERE charge_id = ch.charge_id;
      UPDATE fleet_bank_transactions SET journal_id = (r ->> 'journalId')::uuid WHERE txn_id = t.txn_id;
      PERFORM fleet_event('card_charge_booked', ch.agent_id, 'controller', jsonb_build_object('chargeId', ch.charge_id, 'amountMinor', t.amount_minor, 'merchant', ch.merchant,
        'evidence', 'bank', 'declaredMinor', ch.declared_minor, 'late', ch.status = 'void'));
      RETURN CASE WHEN ch.status = 'void' THEN 'late_settled' ELSE 'settled' END;
    ELSIF t.status IN ('declined','reversed') AND ch.status = 'held' THEN
      PERFORM fleet_card_hold_release(ch.charge_id, ch.reserved_minor, 'controller', 'controller');
      UPDATE fleet_card_charges SET status = 'void', evidence_status = t.status WHERE charge_id = ch.charge_id;
      PERFORM fleet_event('card_hold_voided', ch.agent_id, 'controller', jsonb_build_object('chargeId', ch.charge_id, 'reason', 'the bank ' || t.status || ' it'));
      RETURN t.status;
    END IF;
    RETURN 'unchanged';
  ELSIF t.kind = 'card_refund' AND t.direction = 'in' AND t.status = 'settled' AND t.classified IS NULL THEN
    -- 1. The bank's decision on an open dispute of exactly this amount at this location.
    SELECT count(*) INTO n FROM fleet_card_disputes d JOIN fleet_card_charges c ON c.charge_id = d.charge_id
     WHERE d.state = 'open' AND c.location_id = t.location_id AND d.amount_minor = t.amount_minor AND d.opened_at <= v_at + interval '1 hour';
    IF n = 1 THEN
      SELECT d.* INTO dsp FROM fleet_card_disputes d JOIN fleet_card_charges c ON c.charge_id = d.charge_id
       WHERE d.state = 'open' AND c.location_id = t.location_id AND d.amount_minor = t.amount_minor AND d.opened_at <= v_at + interval '1 hour' FOR UPDATE OF d;
      RETURN fleet_card_dispute_credit(dsp.dispute_id, t.txn_id, 'matcher');
    ELSIF n > 1 THEN RETURN 'ambiguous';
    END IF;
    -- 2. A merchant refund reduces exactly one booked charge at this location that it fits (never more than was charged).
    SELECT count(*) INTO n FROM fleet_card_charges c WHERE c.location_id = t.location_id AND c.status IN ('booked','confirmed') AND c.amount_minor >= t.amount_minor
       AND (t.descriptor IS NULL OR position(lower(split_part(c.merchant, ' ', 1)) IN lower(t.descriptor)) > 0);
    IF n <> 1 THEN RETURN CASE WHEN n = 0 THEN 'unmatched' ELSE 'ambiguous' END; END IF;
    SELECT c.* INTO ch FROM fleet_card_charges c WHERE c.location_id = t.location_id AND c.status IN ('booked','confirmed') AND c.amount_minor >= t.amount_minor
       AND (t.descriptor IS NULL OR position(lower(split_part(c.merchant, ' ', 1)) IN lower(t.descriptor)) > 0) FOR UPDATE;
    r := fleet_card_charge_post(ch.charge_id, ch.amount_minor - t.amount_minor, 'card:' || ch.charge_id || ':refund:' || t.txn_id, 'controller', 'bank:' || t.txn_id);
    UPDATE fleet_bank_transactions SET charge_id = ch.charge_id, classified = 'card_refund', classified_by = 'matcher', journal_id = (r ->> 'journalId')::uuid WHERE txn_id = t.txn_id;
    RETURN 'refund';
  ELSIF t.kind IN ('transfer','other') AND t.direction = 'in' AND t.status = 'settled' AND t.classified IS NULL THEN
    -- Only evidence that it is THAT transfer completes one (never the amount alone):
    --   (a) the transfer's own reference appears in the bank line; or
    --   (b) the source provider recorded the money leaving (PayPal's withdrawal) and the bank line names that source —
    --       and exactly one such transfer is in transit.
    SELECT count(*) INTO n FROM fleet_location_transfers x WHERE x.to_location = t.location_id AND x.state = 'in_transit' AND x.amount_minor = t.amount_minor
       AND x.currency = t.currency AND x.recorded_at <= v_at + interval '1 hour'
       AND length(fleet_norm(x.reference)) >= 6 AND position(fleet_norm(x.reference) IN fleet_norm(t.descriptor)) > 0;
    IF n = 1 THEN
      SELECT x.* INTO tr FROM fleet_location_transfers x WHERE x.to_location = t.location_id AND x.state = 'in_transit' AND x.amount_minor = t.amount_minor
         AND x.currency = t.currency AND x.recorded_at <= v_at + interval '1 hour'
         AND length(fleet_norm(x.reference)) >= 6 AND position(fleet_norm(x.reference) IN fleet_norm(t.descriptor)) > 0 FOR UPDATE;
      RETURN fleet_location_transfer_arrive(tr.transfer_id, t.txn_id, 'reference');
    ELSIF n > 1 THEN RETURN 'ambiguous';
    END IF;
    SELECT count(*) INTO n FROM fleet_location_transfers x WHERE x.to_location = t.location_id AND x.state = 'in_transit' AND x.amount_minor = t.amount_minor
       AND x.currency = t.currency AND x.source_evidence IS NOT NULL AND x.source_seen_at <= v_at + interval '1 hour'
       AND fleet_location_source_named(x.from_location, t.descriptor);
    IF n <> 1 THEN RETURN CASE WHEN n = 0 THEN 'unmatched' ELSE 'ambiguous' END; END IF;
    SELECT x.* INTO tr FROM fleet_location_transfers x WHERE x.to_location = t.location_id AND x.state = 'in_transit' AND x.amount_minor = t.amount_minor
       AND x.currency = t.currency AND x.source_evidence IS NOT NULL AND x.source_seen_at <= v_at + interval '1 hour'
       AND fleet_location_source_named(x.from_location, t.descriptor) FOR UPDATE;
    RETURN fleet_location_transfer_arrive(tr.transfer_id, t.txn_id, 'source_evidence');
  END IF;
  RETURN 'unmatched';
END $$;

-- A transfer arrives (one bank line completes one transfer; the basis is kept).
CREATE FUNCTION fleet_location_transfer_arrive(p_transfer uuid, p_txn uuid, p_basis text) RETURNS text LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE t fleet_bank_transactions;
BEGIN
  SELECT * INTO t FROM fleet_bank_transactions WHERE txn_id = p_txn;
  UPDATE fleet_location_transfers SET state = 'arrived', arrived_at = COALESCE(t.settled_at, now()), arrival_txn_id = p_txn, arrival_basis = p_basis,
         arrival_evidence = 'bank:' || p_txn
   WHERE transfer_id = p_transfer AND state = 'in_transit';
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: that transfer is not in transit'; END IF;
  UPDATE fleet_bank_transactions SET transfer_id = p_transfer, classified = 'transfer_in', classified_by = CASE WHEN p_basis = 'owner' THEN classified_by ELSE 'matcher' END,
         updated_at = now() WHERE txn_id = p_txn;
  PERFORM fleet_event('money_location_transfer_arrived', NULL, 'controller', jsonb_build_object('transferId', p_transfer, 'txnId', p_txn, 'basis', p_basis));
  RETURN 'transfer_arrived';
END $$;

-- The provider's own records of the money leaving the source (and, for PayPal as the destination, arriving there):
-- PayPal's withdrawal (T0400) / funding (T0300) of exactly that amount, completed, not used by another transfer; a bank
-- source's outgoing line carrying the transfer's reference. Run on every new transfer, every match pass and hourly.
CREATE FUNCTION fleet_location_transfers_evidence() RETURNS integer LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x record; v_txn text; v_at timestamptz; n integer := 0; k integer; bt fleet_bank_transactions;
BEGIN
  FOR x IN SELECT tr.*, f.kind AS from_kind, f.rail_id AS from_rail, d.kind AS to_kind, d.rail_id AS to_rail
             FROM fleet_location_transfers tr JOIN fleet_money_locations f ON f.location_id = tr.from_location JOIN fleet_money_locations d ON d.location_id = tr.to_location
            WHERE tr.state = 'in_transit' ORDER BY tr.recorded_at FOR UPDATE OF tr LOOP
    IF x.source_evidence IS NULL AND x.from_kind = 'paypal' THEN
      -- Prefer the PayPal transaction the owner named as the reference; else the one unused withdrawal of that amount.
      SELECT p.transaction_id, p.initiated_at INTO v_txn, v_at FROM fleet_paypal_transactions p
       WHERE p.rail_id = x.from_rail AND p.event_code = 'T0400' AND p.status = 'S' AND p.amount_minor = -x.amount_minor AND p.currency = x.currency
         AND p.initiated_at >= x.recorded_at - interval '${TRANSFER_SOURCE_WINDOW_DAYS} days'
         AND NOT EXISTS (SELECT 1 FROM fleet_location_transfers o WHERE o.source_evidence = 'paypal:' || p.transaction_id)
       ORDER BY (p.transaction_id = x.reference) DESC, p.initiated_at LIMIT 1;
      SELECT count(*) INTO k FROM fleet_paypal_transactions p
       WHERE p.rail_id = x.from_rail AND p.event_code = 'T0400' AND p.status = 'S' AND p.amount_minor = -x.amount_minor AND p.currency = x.currency
         AND p.initiated_at >= x.recorded_at - interval '${TRANSFER_SOURCE_WINDOW_DAYS} days'
         AND NOT EXISTS (SELECT 1 FROM fleet_location_transfers o WHERE o.source_evidence = 'paypal:' || p.transaction_id);
      IF v_txn IS NOT NULL AND (v_txn = x.reference OR k = 1) THEN
        UPDATE fleet_location_transfers SET source_evidence = 'paypal:' || v_txn, source_seen_at = v_at WHERE transfer_id = x.transfer_id;
        n := n + 1;
      END IF;
    ELSIF x.source_evidence IS NULL AND x.from_kind = 'bank' THEN
      SELECT * INTO bt FROM fleet_bank_transactions b WHERE b.location_id = x.from_location AND b.direction = 'out' AND b.status = 'settled' AND b.classified IS NULL
         AND b.kind IN ('transfer','other') AND b.amount_minor = x.amount_minor AND COALESCE(b.settled_at, b.first_seen) >= x.recorded_at - interval '${TRANSFER_SOURCE_WINDOW_DAYS} days'
         AND length(fleet_norm(x.reference)) >= 6 AND position(fleet_norm(x.reference) IN fleet_norm(b.descriptor)) > 0
       ORDER BY b.first_seen LIMIT 1 FOR UPDATE;
      IF FOUND THEN
        UPDATE fleet_bank_transactions SET classified = 'transfer_out', classified_by = 'matcher', transfer_id = x.transfer_id, updated_at = now() WHERE txn_id = bt.txn_id;
        UPDATE fleet_location_transfers SET source_evidence = 'bank:' || bt.txn_id, source_seen_at = COALESCE(bt.settled_at, bt.first_seen) WHERE transfer_id = x.transfer_id;
        n := n + 1;
      END IF;
    END IF;
    IF x.to_kind = 'paypal' THEN
      SELECT p.transaction_id, p.initiated_at INTO v_txn, v_at FROM fleet_paypal_transactions p
       WHERE p.rail_id = x.to_rail AND p.event_code = 'T0300' AND p.status = 'S' AND p.amount_minor = x.amount_minor AND p.currency = x.currency
         AND p.initiated_at >= x.recorded_at - interval '1 day'
         AND NOT EXISTS (SELECT 1 FROM fleet_location_transfers o WHERE o.arrival_evidence = 'paypal:' || p.transaction_id)
       ORDER BY p.initiated_at LIMIT 1;
      -- PayPal's funding record names no transfer: it completes one only when exactly one of that amount is on its way.
      SELECT count(*) INTO k FROM fleet_location_transfers o WHERE o.to_location = x.to_location AND o.state = 'in_transit' AND o.amount_minor = x.amount_minor;
      IF v_txn IS NOT NULL AND k = 1 AND x.source_evidence IS NOT NULL THEN
        UPDATE fleet_location_transfers SET state = 'arrived', arrived_at = v_at, arrival_basis = 'provider', arrival_evidence = 'paypal:' || v_txn WHERE transfer_id = x.transfer_id;
        PERFORM fleet_event('money_location_transfer_arrived', NULL, 'controller', jsonb_build_object('transferId', x.transfer_id, 'paypalTxn', v_txn, 'basis', 'provider'));
        n := n + 1;
      END IF;
    END IF;
  END LOOP;
  RETURN n;
END $$;

-- Re-run matching for a location's open items (after a declaration, a new hold, or new evidence).
CREATE FUNCTION fleet_location_match_pending(p_loc uuid) RETURNS integer LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE t uuid; n integer := 0; r text;
BEGIN
  n := fleet_location_transfers_evidence();
  FOR t IN SELECT txn_id FROM fleet_bank_transactions WHERE location_id = p_loc AND (classified IS NULL OR (kind = 'card' AND status IN ('settled','declined','reversed')))
            ORDER BY first_seen LOOP
    r := fleet_location_match(t);
    IF r NOT IN ('unmatched','ambiguous','unchanged') THEN n := n + 1; END IF;
  END LOOP;
  RETURN n;
END $$;

-- ═══ 4. Evidence in: the bank-feed connector (role fleet_bankfeed; read-only data, nothing out) — and the owner's CSV ═══
CREATE FUNCTION fleet_location_balance_record(p_loc uuid, p_available bigint, p_cleared bigint, p_pending bigint, p_source text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleet_money_locations WHERE location_id = p_loc AND kind = 'bank') OR p_available IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  INSERT INTO fleet_bank_balance_observations (location_id, available_minor, cleared_minor, pending_minor, source) VALUES (p_loc, p_available, p_cleared, p_pending, p_source);
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE FUNCTION fleet_location_txn_record(p_loc uuid, x jsonb, p_source text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE t fleet_bank_transactions; v_status text := x ->> 'status'; v_rank jsonb := '{"pending":1,"settled":2,"declined":3,"reversed":3}'; r text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleet_money_locations WHERE location_id = p_loc AND kind = 'bank') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF COALESCE(x ->> 'externalId', '') = '' OR v_status NOT IN (${q(BANK_TXN_STATUSES)}) OR x ->> 'direction' NOT IN ('in','out') OR x ->> 'kind' NOT IN (${q(BANK_TXN_KINDS)})
     OR jsonb_typeof(x -> 'amountMinor') <> 'number' OR (x ->> 'amountMinor')::bigint <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  SELECT * INTO t FROM fleet_bank_transactions WHERE location_id = p_loc AND external_id = x ->> 'externalId' FOR UPDATE;
  IF FOUND THEN
    -- A status only moves forward (pending → settled / declined / reversed); a replay changes nothing.
    IF (v_rank ->> v_status)::integer <= (v_rank ->> t.status)::integer THEN RETURN jsonb_build_object('ok', true, 'txnId', t.txn_id, 'replay', true); END IF;
    UPDATE fleet_bank_transactions SET status = v_status, amount_minor = (x ->> 'amountMinor')::bigint, settled_at = COALESCE((x ->> 'settledAt')::timestamptz, settled_at),
      fee_minor = COALESCE((x ->> 'feeMinor')::bigint, fee_minor), updated_at = now() WHERE txn_id = t.txn_id RETURNING * INTO t;
  ELSE
    INSERT INTO fleet_bank_transactions (location_id, external_id, status, direction, kind, amount_minor, currency, original_amount_minor, original_currency, fx_rate,
        fee_minor, descriptor, authorised_at, settled_at, source)
      VALUES (p_loc, left(x ->> 'externalId', 120), v_status, x ->> 'direction', x ->> 'kind', (x ->> 'amountMinor')::bigint, COALESCE(x ->> 'currency', 'GBP'),
        (x ->> 'originalAmountMinor')::bigint, x ->> 'originalCurrency', (x ->> 'fxRate')::numeric, (x ->> 'feeMinor')::bigint, left(fleet_scrub(x ->> 'descriptor'), 140),
        (x ->> 'authorisedAt')::timestamptz, (x ->> 'settledAt')::timestamptz, p_source)
      RETURNING * INTO t;
  END IF;
  r := fleet_location_match(t.txn_id);
  RETURN jsonb_build_object('ok', true, 'txnId', t.txn_id, 'match', r);
END $$;

CREATE FUNCTION rx_locations(p_worker text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('locationId', location_id, 'provider', provider, 'currency', currency, 'status', status) ORDER BY created_at), '[]'::jsonb)
    FROM fleet_money_locations WHERE kind = 'bank' AND status <> 'unavailable' AND provider NOT IN ('csv','paypal')
$$;
-- The feed writes only to the locations it is given (an API-fed bank account; never a statement-only or PayPal location).
CREATE FUNCTION rx_location_fed(p_loc uuid) RETURNS boolean LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM fleet_money_locations WHERE location_id = p_loc AND kind = 'bank' AND status <> 'unavailable' AND provider NOT IN ('csv','paypal'))
$$;
CREATE FUNCTION rx_location_balance(p_worker text, p_loc uuid, p_available bigint, p_cleared bigint, p_pending bigint, p_source text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_source NOT IN ('api','simulated') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  IF NOT rx_location_fed(p_loc) THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FED'); END IF;
  RETURN fleet_location_balance_record(p_loc, p_available, p_cleared, p_pending, p_source);
END $$;
CREATE FUNCTION rx_location_txn(p_worker text, p_loc uuid, x jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF NOT rx_location_fed(p_loc) THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FED'); END IF;
  RETURN fleet_location_txn_record(p_loc, x, CASE WHEN x ->> 'source' = 'simulated' THEN 'simulated' ELSE 'api' END);
END $$;

-- The owner's CSV export (host CLI: economy-location-import): the same path, source csv; a balance line optional.
CREATE FUNCTION fleet_admin_location_import(p_loc uuid, p_rows jsonb, p_balance jsonb, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x jsonb; r jsonb; n integer := 0; nm integer := 0; nr integer := 0;
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_treasury');
  IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) > 5000 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: rows is an array of at most 5000 transactions'; END IF;
  FOR x IN SELECT y FROM jsonb_array_elements(p_rows) y LOOP
    r := fleet_location_txn_record(p_loc, x, 'csv');
    IF NOT (r ->> 'ok')::boolean THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a row is not a valid transaction: %', left(x::text, 200); END IF;
    IF r ->> 'replay' = 'true' THEN nr := nr + 1; ELSE n := n + 1; END IF;
    IF r ->> 'match' NOT IN ('unmatched','ambiguous','unchanged') THEN nm := nm + 1; END IF;
  END LOOP;
  IF p_balance IS NOT NULL AND jsonb_typeof(p_balance -> 'availableMinor') = 'number' THEN
    PERFORM fleet_location_balance_record(p_loc, (p_balance ->> 'availableMinor')::bigint, (p_balance ->> 'clearedMinor')::bigint, (p_balance ->> 'pendingMinor')::bigint, 'csv');
  END IF;
  RETURN jsonb_build_object('ok', true, 'recorded', n, 'replayed', nr, 'matched', nm,
    'unexplained', (SELECT count(*) FROM fleet_bank_transactions WHERE location_id = p_loc AND classified IS NULL));
END $$;

-- ═══ 5. The owner's controls ═══
CREATE FUNCTION fleet_admin_location_add(p_kind text, p_provider text, p_label text, p_rail uuid, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v uuid;
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_treasury');
  IF p_kind <> 'bank' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: add a bank location (the PayPal account is a location already)'; END IF;
  INSERT INTO fleet_money_locations (kind, provider, label, currency, status, updated_by)
    VALUES ('bank', p_provider, btrim(p_label), COALESCE((SELECT accounting_currency FROM fleet_economic_model WHERE id = 1), 'GBP'), 'pending_setup', p_actor) RETURNING location_id INTO v;
  PERFORM fleet_event('money_location_added', NULL, p_actor, jsonb_build_object('locationId', v, 'kind', 'bank', 'provider', p_provider));
  RETURN jsonb_build_object('ok', true, 'locationId', v, 'status', 'pending_setup',
    'next', 'feed it evidence (a connector or a CSV import), then set it active; binding the card to it is a separate step');
END $$;

CREATE FUNCTION fleet_admin_location_status(p_loc uuid, p_status text, p_note text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE l fleet_money_locations;
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_treasury');
  IF p_status NOT IN (${q(LOCATION_STATUSES)}) THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: status is one of ${LOCATION_STATUSES.join(", ")}'; END IF;
  UPDATE fleet_money_locations SET status = p_status, status_note = left(p_note, 300), updated_at = now(), updated_by = p_actor WHERE location_id = p_loc RETURNING * INTO l;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  PERFORM fleet_event('money_location_status', NULL, p_actor, jsonb_build_object('locationId', p_loc, 'status', p_status));
  RETURN jsonb_build_object('ok', true, 'status', p_status);
END $$;

-- The card on file is a debit card on this bank location (or, with NULL, back to the credit-card path). Holds already open
-- keep the path they were opened under.
CREATE FUNCTION fleet_admin_location_bind_card(p_loc uuid, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_treasury');
  UPDATE fleet_money_locations SET card_drawn = false, updated_at = now(), updated_by = p_actor WHERE card_drawn AND location_id IS DISTINCT FROM p_loc;
  IF p_loc IS NOT NULL THEN
    UPDATE fleet_money_locations SET card_drawn = true, updated_at = now(), updated_by = p_actor WHERE location_id = p_loc AND kind = 'bank';
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND', 'reason', 'a bank location'); END IF;
  END IF;
  PERFORM fleet_event('money_location_card', NULL, p_actor, jsonb_build_object('locationId', p_loc));
  RETURN jsonb_build_object('ok', true, 'cardMode', CASE WHEN p_loc IS NULL THEN 'credit (owner card, repaid weekly)' ELSE 'debit (this bank location)' END);
END $$;

-- The owner moved money between locations (the Fleet never executes it): the same money — no journal.
CREATE FUNCTION fleet_admin_location_transfer(p_from uuid, p_to uuid, p_amount bigint, p_ref text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE f fleet_money_locations; t fleet_money_locations; v uuid; liq jsonb;
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_treasury');
  SELECT * INTO f FROM fleet_money_locations WHERE location_id = p_from FOR UPDATE;
  SELECT * INTO t FROM fleet_money_locations WHERE location_id = p_to;
  IF f.location_id IS NULL OR t.location_id IS NULL OR p_amount IS NULL OR p_amount <= 0 OR length(btrim(COALESCE(p_ref, ''))) < 3 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'two locations, a positive amount and the provider''s reference of the transfer');
  END IF;
  IF f.currency <> t.currency THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'same-currency transfers only'); END IF;
  liq := fleet_location_liquidity(p_from);
  INSERT INTO fleet_location_transfers (from_location, to_location, amount_minor, currency, reference, recorded_by)
    VALUES (p_from, p_to, p_amount, f.currency, btrim(p_ref), p_actor) RETURNING transfer_id INTO v;
  PERFORM fleet_event('money_location_transfer', NULL, p_actor, jsonb_build_object('transferId', v, 'from', p_from, 'to', p_to, 'amountMinor', p_amount));
  IF t.kind = 'bank' THEN PERFORM fleet_location_match_pending(p_to); ELSE PERFORM fleet_location_transfers_evidence(); END IF;
  RETURN jsonb_build_object('ok', true, 'transferId', v, 'state', (SELECT state FROM fleet_location_transfers WHERE transfer_id = v),
    'sourceFreeBeforeMinor', liq ->> 'freeMinor',
    'note', 'the same money: no capital or revenue; spendable at the destination once its evidence shows it (in transit meanwhile)');
END $$;

-- A deposit the owner made straight into the bank: owner funding, posted once against the bank transaction that shows it.
CREATE FUNCTION fleet_admin_location_contribution(p_txn uuid, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE t fleet_bank_transactions; v_j uuid;
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_treasury');
  SELECT * INTO t FROM fleet_bank_transactions WHERE txn_id = p_txn FOR UPDATE;
  IF NOT FOUND OR t.direction <> 'in' OR t.status <> 'settled' OR t.kind NOT IN ('transfer','other') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'a settled incoming bank transaction');
  END IF;
  IF t.classified IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ALREADY_CLASSIFIED', 'classified', t.classified); END IF;
  v_j := fleet_admin_record_owner_funding(t.amount_minor, 'bank:' || t.location_id || ':' || t.external_id, p_actor, 'bank-contribution:' || t.txn_id);
  UPDATE fleet_bank_transactions SET classified = 'owner_contribution', classified_by = p_actor, journal_id = v_j, updated_at = now() WHERE txn_id = t.txn_id;
  RETURN jsonb_build_object('ok', true, 'journalId', v_j, 'amountMinor', t.amount_minor);
END $$;

-- Everything else the owner explains: a bank fee (a Fleet expense, posted), a transfer out the owner recorded, or explained.
CREATE FUNCTION fleet_admin_bank_txn_classify(p_txn uuid, p_as text, p_note text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE t fleet_bank_transactions; v_j uuid;
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_treasury');
  SELECT * INTO t FROM fleet_bank_transactions WHERE txn_id = p_txn FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF t.classified IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ALREADY_CLASSIFIED', 'classified', t.classified); END IF;
  IF p_as NOT IN ('fee','transfer_out','explained') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: fee, transfer_out or explained (an owner deposit: location_contribution)'; END IF;
  IF p_as IN ('fee','transfer_out') AND (t.direction <> 'out' OR t.status <> 'settled') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a settled outgoing transaction'; END IF;
  IF p_as = 'explained' AND length(btrim(COALESCE(p_note, ''))) < 5 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: say what it is'; END IF;
  IF p_as = 'fee' THEN
    v_j := fleet_ledger_post('fleet_expense_settlement', 'bank-fee:' || t.txn_id, p_actor, 'bank fee: ' || COALESCE(t.descriptor, ''), 'owner', NULL, NULL, NULL,
      'bank:' || t.location_id || ':' || t.external_id, NULL, now(), jsonb_build_array(
        jsonb_build_object('account', 'fleet:expense', 'side', 'D', 'amount', t.amount_minor),
        jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', t.amount_minor)));
  END IF;
  UPDATE fleet_bank_transactions SET classified = p_as, classified_by = p_actor, classified_note = left(p_note, 300), journal_id = v_j, updated_at = now() WHERE txn_id = t.txn_id;
  RETURN jsonb_build_object('ok', true, 'classified', p_as, 'journalId', v_j);
END $$;

-- The owner says which transfer an incoming bank line is (when the matcher had no evidence to do it alone).
CREATE FUNCTION fleet_admin_transfer_arrival(p_txn uuid, p_transfer uuid, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE t fleet_bank_transactions; tr fleet_location_transfers;
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_treasury');
  SELECT * INTO t FROM fleet_bank_transactions WHERE txn_id = p_txn FOR UPDATE;
  SELECT * INTO tr FROM fleet_location_transfers WHERE transfer_id = p_transfer FOR UPDATE;
  IF t.txn_id IS NULL OR tr.transfer_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF t.classified IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ALREADY_CLASSIFIED', 'classified', t.classified); END IF;
  IF t.direction <> 'in' OR t.status <> 'settled' OR tr.state <> 'in_transit' OR tr.to_location <> t.location_id OR tr.amount_minor <> t.amount_minor OR tr.currency <> t.currency THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'a settled credit at the transfer''s destination, of exactly its amount, while it is in transit');
  END IF;
  UPDATE fleet_bank_transactions SET classified_by = p_actor WHERE txn_id = p_txn;
  PERFORM fleet_location_transfer_arrive(p_transfer, p_txn, 'owner');
  RETURN jsonb_build_object('ok', true, 'transferId', p_transfer, 'basis', 'owner');
END $$;

-- The owner checked: a used debit hold the bank has not shown will not be charged (the bank app shows nothing pending, or
-- the merchant confirmed the cancellation). Its reservation comes back; if the merchant presents it after all, it is still
-- booked (late settlement, the agent bears it). A hold the bank has already shown is released only by the bank's own record.
CREATE FUNCTION fleet_admin_card_hold_release(p_charge uuid, p_evidence text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_card_charges;
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_treasury');
  SELECT * INTO c FROM fleet_card_charges WHERE charge_id = p_charge FOR UPDATE;
  IF NOT FOUND OR c.location_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND', 'reason', 'a debit-card hold'); END IF;
  IF c.status <> 'held' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE', 'status', c.status); END IF;
  IF c.bank_txn_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BANK_SHOWS_IT', 'reason', 'the bank has shown this charge: it is released only when the bank reverses or declines it');
  END IF;
  IF length(btrim(COALESCE(p_evidence, ''))) < 10 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'say what you checked (e.g. "bank app: nothing pending; merchant cancelled order 123")');
  END IF;
  PERFORM fleet_card_hold_release(c.charge_id, c.reserved_minor, p_actor, 'owner');
  UPDATE fleet_card_charges SET status = 'void', evidence_status = 'released' WHERE charge_id = c.charge_id;
  PERFORM fleet_event('card_hold_released_verified', c.agent_id, p_actor, jsonb_build_object('chargeId', c.charge_id, 'evidence', left(p_evidence, 300)));
  RETURN jsonb_build_object('ok', true, 'released', c.reserved_minor,
    'note', 'released; if the merchant charges it after all, it is booked against the agent (late settlement)');
END $$;

-- Disputes (the owner raises them with the bank; the bank decides).
CREATE FUNCTION fleet_admin_card_dispute_open(p_charge uuid, p_amount bigint, p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_card_charges; v uuid;
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_treasury');
  SELECT * INTO c FROM fleet_card_charges WHERE charge_id = p_charge FOR UPDATE;
  IF NOT FOUND OR c.location_id IS NULL OR c.status NOT IN ('booked','confirmed') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'a booked debit-card charge');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > c.amount_minor THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'an amount up to what was charged', 'chargedMinor', c.amount_minor);
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 5 THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'the reason you gave the bank'); END IF;
  IF EXISTS (SELECT 1 FROM fleet_card_disputes WHERE charge_id = p_charge AND state = 'open') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ALREADY_OPEN');
  END IF;
  INSERT INTO fleet_card_disputes (charge_id, amount_minor, reason, opened_by) VALUES (p_charge, p_amount, btrim(p_reason), p_actor) RETURNING dispute_id INTO v;
  PERFORM fleet_event('card_dispute_opened', c.agent_id, p_actor, jsonb_build_object('disputeId', v, 'chargeId', p_charge, 'amountMinor', p_amount));
  PERFORM fleet_location_match_pending(c.location_id);
  RETURN jsonb_build_object('ok', true, 'disputeId', v, 'state', (SELECT state FROM fleet_card_disputes WHERE dispute_id = v),
    'note', 'nothing is booked now; the bank''s credit, when it comes, reduces the charge');
END $$;

-- The bank's credit for a dispute: reduces the charge by it (never below zero), once.
CREATE FUNCTION fleet_card_dispute_credit(p_dispute uuid, p_txn uuid, p_actor text) RETURNS text LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE d fleet_card_disputes; c fleet_card_charges; t fleet_bank_transactions; r jsonb;
BEGIN
  SELECT * INTO d FROM fleet_card_disputes WHERE dispute_id = p_dispute FOR UPDATE;
  SELECT * INTO c FROM fleet_card_charges WHERE charge_id = d.charge_id FOR UPDATE;
  SELECT * INTO t FROM fleet_bank_transactions WHERE txn_id = p_txn FOR UPDATE;
  IF d.state <> 'open' OR t.classified IS NOT NULL OR t.direction <> 'in' OR t.status <> 'settled' OR t.location_id <> c.location_id OR t.amount_minor > c.amount_minor THEN
    RAISE EXCEPTION 'FLEET_INVALID_STATE: an open dispute and a settled credit at its bank, within what was charged';
  END IF;
  r := fleet_card_charge_post(c.charge_id, c.amount_minor - t.amount_minor, 'card:' || c.charge_id || ':dispute:' || t.txn_id, 'controller', 'bank:' || t.txn_id);
  UPDATE fleet_card_disputes SET state = 'won', credit_txn_id = t.txn_id, resolved_at = now(),
         outcome_note = CASE WHEN t.amount_minor < d.amount_minor THEN 'the bank credited less than disputed' END WHERE dispute_id = d.dispute_id;
  UPDATE fleet_bank_transactions SET charge_id = c.charge_id, classified = 'card_refund', classified_by = left(p_actor, 128), journal_id = (r ->> 'journalId')::uuid, updated_at = now()
   WHERE txn_id = t.txn_id;
  PERFORM fleet_event('card_dispute_resolved', c.agent_id, left(p_actor, 128), jsonb_build_object('disputeId', d.dispute_id, 'state', 'won', 'creditMinor', t.amount_minor));
  RETURN 'dispute_won';
END $$;

-- The owner records the bank's decision: won (with its credit line, when the matcher could not tie it), lost or withdrawn.
CREATE FUNCTION fleet_admin_card_dispute_resolve(p_dispute uuid, p_outcome text, p_txn uuid, p_note text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE d fleet_card_disputes;
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_treasury');
  SELECT * INTO d FROM fleet_card_disputes WHERE dispute_id = p_dispute FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF d.state <> 'open' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE', 'state', d.state); END IF;
  IF p_outcome = 'won' THEN
    IF p_txn IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'won: name the bank''s credit line (txnId)'); END IF;
    PERFORM fleet_card_dispute_credit(p_dispute, p_txn, p_actor);
  ELSIF p_outcome IN ('lost','withdrawn') THEN
    UPDATE fleet_card_disputes SET state = p_outcome, resolved_at = now(), outcome_note = left(p_note, 300) WHERE dispute_id = p_dispute;
    PERFORM fleet_event('card_dispute_resolved', NULL, p_actor, jsonb_build_object('disputeId', p_dispute, 'state', p_outcome));
  ELSE
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'won, lost or withdrawn');
  END IF;
  RETURN jsonb_build_object('ok', true, 'state', (SELECT state FROM fleet_card_disputes WHERE dispute_id = p_dispute));
END $$;

-- ═══ Whole-treasury reconciliation ═══
-- Every location's latest evidence plus money between locations, against what the books say the treasury holds (the books
-- less capital not yet backed by money: fleet_capital_backing). PayPal counts its total balance; a bank its CLEARED
-- balance (the books book a card charge when it settles). Incomplete — never "reconciled" — while any location lacks a
-- fresh reading.
CREATE FUNCTION fleet_treasury_reconciliation() RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE cb jsonb; l record; v_sum bigint := 0; v_transit bigint := 0; v_locs jsonb := '[]'::jsonb; v_stale integer := 0; v_expected bigint; v_bal bigint;
        v_at timestamptz; v_fresh boolean; v_ccy text;
BEGIN
  SELECT accounting_currency INTO v_ccy FROM fleet_economic_model WHERE id = 1;
  cb := fleet_capital_backing();
  v_expected := (cb ->> 'booksCashMinor')::bigint - (cb ->> 'unbackedMinor')::bigint;
  FOR l IN SELECT * FROM fleet_money_locations WHERE status <> 'pending_setup' ORDER BY created_at LOOP
    IF l.kind = 'paypal' THEN
      SELECT o.total_minor, o.observed_at INTO v_bal, v_at FROM fleet_paypal_balance_observations o WHERE o.rail_id = l.rail_id AND o.currency = l.currency
       ORDER BY o.observed_at DESC LIMIT 1;
    ELSE
      SELECT COALESCE(o.cleared_minor, o.available_minor), o.observed_at INTO v_bal, v_at FROM fleet_bank_balance_observations o WHERE o.location_id = l.location_id
       ORDER BY o.observed_at DESC, o.observation_id DESC LIMIT 1;
    END IF;
    v_fresh := v_at IS NOT NULL AND v_at >= now() - make_interval(hours => l.evidence_max_age_hours);
    IF NOT v_fresh THEN v_stale := v_stale + 1; END IF;
    v_sum := v_sum + COALESCE(v_bal, 0);
    v_locs := v_locs || jsonb_build_array(jsonb_build_object('locationId', l.location_id, 'label', l.label, 'kind', l.kind, 'balanceMinor', v_bal,
      'observedAt', v_at, 'fresh', v_fresh));
    v_bal := NULL; v_at := NULL;
  END LOOP;
  -- Money between locations: left the source per its reading, not yet in the destination's.
  SELECT COALESCE(sum(t.amount_minor), 0) INTO v_transit FROM fleet_location_transfers t
   WHERE t.state <> 'cancelled'
     AND t.recorded_at < COALESCE((SELECT max(o.observed_at) FROM fleet_paypal_balance_observations o JOIN fleet_money_locations f ON f.rail_id = o.rail_id WHERE f.location_id = t.from_location),
                                  (SELECT max(o.observed_at) FROM fleet_bank_balance_observations o WHERE o.location_id = t.from_location), '-infinity')
     AND (t.state = 'in_transit' OR t.arrived_at > COALESCE((SELECT max(o.observed_at) FROM fleet_paypal_balance_observations o JOIN fleet_money_locations d ON d.rail_id = o.rail_id WHERE d.location_id = t.to_location),
                                                          (SELECT max(o.observed_at) FROM fleet_bank_balance_observations o WHERE o.location_id = t.to_location), '-infinity'));
  RETURN jsonb_build_object('currency', v_ccy, 'locations', v_locs, 'locationsMinor', v_sum, 'inTransitMinor', v_transit,
    'expectedMinor', v_expected, 'booksCashMinor', cb -> 'booksCashMinor', 'unbackedMinor', cb -> 'unbackedMinor',
    'differenceMinor', v_sum + v_transit - v_expected,
    'state', CASE WHEN v_stale > 0 THEN 'incomplete'
                  WHEN abs(v_sum + v_transit - v_expected) <= ${RECONCILE_TOLERANCE_MINOR} THEN 'reconciled' ELSE 'difference' END,
    'staleLocations', v_stale,
    'note', 'locations + in transit − (books − unbacked capital); above 0: money the books do not record yet; below 0: money missing');
END $$;

-- ═══ 6. 3-D Secure: the agent says the bank asked the cardholder; the owner is alerted (never bypassed) ═══
CREATE FUNCTION fleet_econ_card_awaiting_approval(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_card_charges;
BEGIN
  SELECT * INTO c FROM fleet_card_charges WHERE charge_id = fleet_identity_uuid(a, 'chargeId') AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such card hold of yours'; END IF;
  IF c.status <> 'held' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE', 'status', c.status); END IF;
  IF c.awaiting_approval_since IS NULL THEN
    UPDATE fleet_card_charges SET awaiting_approval_since = now(), sca = 'challenged' WHERE charge_id = c.charge_id;
    PERFORM fleet_notify('RED', 'CARD_APPROVAL_NEEDED', p_agent, 'Your bank is asking you to approve a card purchase: ' || c.merchant,
      jsonb_build_object('chargeId', c.charge_id, 'merchant', c.merchant, 'maxMinor', c.hold_max_minor), 'card-approval:' || c.charge_id);
  END IF;
  RETURN jsonb_build_object('ok', true, 'note', 'the owner was alerted to approve it in the bank''s app; wait on the page (do not retry or work around it); if it is not approved before the hold expires, void the hold');
END $$;

-- ═══ 7. The owner's view ═══
CREATE FUNCTION fleet_locations_json() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'locations', COALESCE((SELECT jsonb_agg(jsonb_build_object('locationId', l.location_id, 'kind', l.kind, 'provider', l.provider, 'label', l.label, 'currency', l.currency,
                   'status', l.status, 'statusNote', l.status_note, 'cardDrawn', l.card_drawn, 'liquidity', fleet_location_liquidity(l.location_id),
                   'drift', CASE WHEN l.kind = 'bank' THEN fleet_location_drift(l.location_id) END) ORDER BY l.created_at) FROM fleet_money_locations l), '[]'::jsonb),
    'transfers', COALESCE((SELECT jsonb_agg(jsonb_build_object('transferId', transfer_id, 'from', from_location, 'to', to_location, 'amountMinor', amount_minor, 'state', state,
                   'reference', reference, 'recordedAt', recorded_at, 'arrivedAt', arrived_at, 'sourceEvidence', source_evidence, 'arrivalBasis', arrival_basis) ORDER BY recorded_at DESC)
                   FROM (SELECT * FROM fleet_location_transfers ORDER BY recorded_at DESC LIMIT 50) t), '[]'::jsonb),
    'unexplained', COALESCE((SELECT jsonb_agg(jsonb_build_object('txnId', txn_id, 'locationId', location_id, 'status', status, 'direction', direction, 'kind', kind,
                   'amountMinor', amount_minor, 'descriptor', descriptor, 'at', COALESCE(settled_at, authorised_at, first_seen)) ORDER BY first_seen)
                   FROM (SELECT * FROM fleet_bank_transactions WHERE classified IS NULL ORDER BY first_seen LIMIT 100) t), '[]'::jsonb),
    'debitCharges', COALESCE((SELECT jsonb_agg(jsonb_build_object('chargeId', charge_id, 'agentId', agent_id, 'merchant', merchant, 'status', status, 'evidence', evidence_status,
                   'holdMaxMinor', hold_max_minor, 'declaredMinor', declared_minor, 'amountMinor', amount_minor, 'sca', sca, 'awaitingApprovalSince', awaiting_approval_since,
                   'ventureId', venture_id, 'venture', (SELECT v.venture_key FROM fleet_ventures v WHERE v.venture_id = c.venture_id),
                   'createdAt', created_at) ORDER BY created_at DESC)
                   FROM (SELECT * FROM fleet_card_charges WHERE location_id IS NOT NULL ORDER BY created_at DESC LIMIT 50) c), '[]'::jsonb),
    'disputes', COALESCE((SELECT jsonb_agg(jsonb_build_object('disputeId', d.dispute_id, 'chargeId', d.charge_id, 'merchant', c.merchant, 'amountMinor', d.amount_minor,
                   'reason', d.reason, 'state', d.state, 'openedAt', d.opened_at, 'resolvedAt', d.resolved_at, 'outcomeNote', d.outcome_note) ORDER BY d.opened_at DESC)
                   FROM (SELECT * FROM fleet_card_disputes ORDER BY opened_at DESC LIMIT 50) d JOIN fleet_card_charges c ON c.charge_id = d.charge_id), '[]'::jsonb),
    'reconciliation', fleet_treasury_reconciliation())
$$;

${CHARGES_GUARD}
${CARD_VOID}
${CARD_AUTHORIZE}
${CARD_DECLARE}
${HOLDS_EXPIRE}
${CHARGE_POST}
${TREASURY_LIQUIDITY}
${DISPATCH}
${DASH_CALL}
${OPS_WATCH}
`;

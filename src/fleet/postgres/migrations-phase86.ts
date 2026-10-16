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
 * reversal releases the hold; a merchant refund reduces the charge; a hold the bank never shows is released after 7 days,
 * never booked at its maximum. Bank transactions nothing explains wait in the owner's queue.
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
/** A debit-card hold the bank never shows is released after this many days (never booked at its maximum). */
export const DEBIT_EVIDENCE_DAYS = 7;
/** A bank amount may exceed the hold by this share for FX / tips before it is not a match (basis points). */
export const DEBIT_MATCH_TOLERANCE_BP = 1000;
export const AGENT_OPS_V86 = ["card.awaiting_approval"] as const;
export const DASHBOARD_READ_OPS_V86 = ["locations"] as const;
export const DASHBOARD_SENSITIVE_OPS_V86 = ["location_add", "location_bind_card", "location_transfer", "location_contribution"] as const;
export const DASHBOARD_WRITE_OPS_V86_ADDED = ["location_status", "bank_txn_classify"] as const;
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
  INSERT INTO fleet_card_charges (agent_id, merchant, origin, status, source, hold_max_minor, declare_by, funding, envelope_id, reserved_minor, location_id, evidence_status)
    VALUES (p_agent, left(fleet_scrub(v_merchant), 120), v_origin, 'held', 'agent', v_max, now() + interval '24 hours',
            CASE WHEN v_env IS NULL THEN 'own' ELSE 'envelope' END, v_env, v_max, loc.location_id, CASE WHEN loc.location_id IS NOT NULL THEN 'awaiting' END) RETURNING * INTO c;`],
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
    -- v86: debit mode — never booked at its maximum: it waits for the bank's evidence; released when none comes.
    IF c.location_id IS NOT NULL THEN
      IF c.evidence_status = 'awaiting' AND c.created_at < now() - interval '${DEBIT_EVIDENCE_DAYS} days' THEN
        PERFORM fleet_card_hold_release(c.charge_id, c.reserved_minor, 'controller', 'controller');
        UPDATE fleet_card_charges SET status = 'void', evidence_status = 'none' WHERE charge_id = c.charge_id;
        PERFORM fleet_event('card_hold_voided', c.agent_id, 'controller', jsonb_build_object('chargeId', c.charge_id, 'reason', 'the bank showed no charge within ${DEBIT_EVIDENCE_DAYS} days'));
        nv := nv + 1;
      END IF;
      CONTINUE;
    END IF;`],
]);
const CHARGE_POST = restate(V54_SQL, "fleet_card_charge_post", [
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
      WHEN 'push_device_revoke' THEN`],
  [`      WHEN 'push_device_add' THEN`, `      WHEN 'location_add' THEN fleet_admin_location_add(a ->> 'kind', a ->> 'provider', a ->> 'label', NULLIF(a ->> 'railId', '')::uuid, 'operator:owner')
      WHEN 'location_bind_card' THEN fleet_admin_location_bind_card(NULLIF(a ->> 'locationId', '')::uuid, 'operator:owner')
      WHEN 'location_transfer' THEN fleet_admin_location_transfer((a ->> 'fromLocation')::uuid, (a ->> 'toLocation')::uuid, (a ->> 'amountMinor')::bigint, a ->> 'reference', 'operator:owner')
      WHEN 'location_contribution' THEN fleet_admin_location_contribution((a ->> 'txnId')::uuid, 'operator:owner')
      WHEN 'push_device_add' THEN`],
]);
const OPS_WATCH = restate(V83_SQL, "svc_operations_watch", [
  [`  RETURN jsonb_build_object('ok', true, 'raised', n);`,
   `  -- v86: money locations — stale evidence on an active location, bank transactions nothing explains, balance drift, a
  -- negative bank balance, a limited or unavailable location.
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
  UNIQUE (from_location, reference)
);
CREATE TRIGGER fleet_location_transfers_no_delete BEFORE DELETE ON fleet_location_transfers FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

ALTER TABLE fleet_card_charges ADD COLUMN location_id uuid REFERENCES fleet_money_locations(location_id);
ALTER TABLE fleet_card_charges ADD COLUMN evidence_status text CHECK (evidence_status IN ('awaiting','authorised','settled','declined','reversed','none'));
ALTER TABLE fleet_card_charges ADD COLUMN declared_minor bigint CHECK (declared_minor > 0);
ALTER TABLE fleet_card_charges ADD COLUMN bank_txn_id uuid REFERENCES fleet_bank_transactions(txn_id);
ALTER TABLE fleet_card_charges ADD COLUMN sca text CHECK (sca IN ('frictionless','challenged','exempt'));
ALTER TABLE fleet_card_charges ADD COLUMN awaiting_approval_since timestamptz;
ALTER TABLE fleet_card_charges ADD CONSTRAINT fleet_card_charges_debit_evidence CHECK ((location_id IS NULL) = (evidence_status IS NULL));

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
  SELECT COALESCE(sum(reserved_minor), 0) INTO v_holds FROM fleet_card_charges WHERE location_id = p_loc AND status = 'held' AND evidence_status = 'awaiting';
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
-- A card debit settles / authorises / declines one held debit-mode charge; a card credit is a refund of one booked charge;
-- an incoming transfer completes one transfer in transit. Ambiguous or unknown items wait for the owner (never guessed).
CREATE FUNCTION fleet_location_match(p_txn uuid) RETURNS text LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE t fleet_bank_transactions; ch fleet_card_charges; n integer; tr fleet_location_transfers; r jsonb;
BEGIN
  SELECT * INTO t FROM fleet_bank_transactions WHERE txn_id = p_txn FOR UPDATE;
  IF t.kind = 'card' AND t.direction = 'out' THEN
    IF t.charge_id IS NULL THEN
      -- Candidates: open debit-mode holds on this location, opened before the bank saw it, that the amount fits.
      SELECT count(*) INTO n FROM fleet_card_charges c WHERE c.location_id = t.location_id AND c.status = 'held' AND c.evidence_status IN ('awaiting','authorised') AND c.bank_txn_id IS NULL
         AND c.created_at <= COALESCE(t.authorised_at, t.settled_at, t.first_seen) + interval '1 hour'
         AND t.amount_minor * 10000 <= c.hold_max_minor * (10000 + ${DEBIT_MATCH_TOLERANCE_BP})
         AND (c.declared_minor IS NULL OR abs(c.declared_minor - t.amount_minor) * 10000 <= c.declared_minor * ${DEBIT_MATCH_TOLERANCE_BP});
      IF n <> 1 THEN RETURN CASE WHEN n = 0 THEN 'unmatched' ELSE 'ambiguous' END; END IF;
      SELECT c.* INTO ch FROM fleet_card_charges c WHERE c.location_id = t.location_id AND c.status = 'held' AND c.evidence_status IN ('awaiting','authorised') AND c.bank_txn_id IS NULL
         AND c.created_at <= COALESCE(t.authorised_at, t.settled_at, t.first_seen) + interval '1 hour'
         AND t.amount_minor * 10000 <= c.hold_max_minor * (10000 + ${DEBIT_MATCH_TOLERANCE_BP})
         AND (c.declared_minor IS NULL OR abs(c.declared_minor - t.amount_minor) * 10000 <= c.declared_minor * ${DEBIT_MATCH_TOLERANCE_BP}) FOR UPDATE;
      UPDATE fleet_bank_transactions SET charge_id = ch.charge_id, classified = 'card_charge', classified_by = 'matcher' WHERE txn_id = t.txn_id RETURNING * INTO t;
      UPDATE fleet_card_charges SET bank_txn_id = t.txn_id WHERE charge_id = ch.charge_id;
    END IF;
    SELECT * INTO ch FROM fleet_card_charges WHERE charge_id = t.charge_id FOR UPDATE;
    IF t.status = 'pending' AND ch.status = 'held' THEN
      UPDATE fleet_card_charges SET evidence_status = 'authorised' WHERE charge_id = ch.charge_id;
      RETURN 'authorised';
    ELSIF t.status = 'settled' AND ch.status = 'held' THEN
      r := fleet_card_charge_post(ch.charge_id, t.amount_minor, 'card:' || ch.charge_id || ':bank', 'controller', 'bank:' || t.txn_id);
      UPDATE fleet_card_charges SET evidence_status = 'settled' WHERE charge_id = ch.charge_id;
      UPDATE fleet_bank_transactions SET journal_id = (r ->> 'journalId')::uuid WHERE txn_id = t.txn_id;
      PERFORM fleet_event('card_charge_booked', ch.agent_id, 'controller', jsonb_build_object('chargeId', ch.charge_id, 'amountMinor', t.amount_minor, 'merchant', ch.merchant,
        'evidence', 'bank', 'declaredMinor', ch.declared_minor));
      RETURN 'settled';
    ELSIF t.status IN ('declined','reversed') AND ch.status = 'held' THEN
      PERFORM fleet_card_hold_release(ch.charge_id, ch.reserved_minor, 'controller', 'controller');
      UPDATE fleet_card_charges SET status = 'void', evidence_status = t.status WHERE charge_id = ch.charge_id;
      PERFORM fleet_event('card_hold_voided', ch.agent_id, 'controller', jsonb_build_object('chargeId', ch.charge_id, 'reason', 'the bank ' || t.status || ' it'));
      RETURN t.status;
    END IF;
    RETURN 'unchanged';
  ELSIF t.kind = 'card_refund' AND t.direction = 'in' AND t.status = 'settled' AND t.classified IS NULL THEN
    -- A refund reduces exactly one booked charge at this location that it fits (never more than was charged).
    SELECT count(*) INTO n FROM fleet_card_charges c WHERE c.location_id = t.location_id AND c.status IN ('booked','confirmed') AND c.amount_minor >= t.amount_minor
       AND (t.descriptor IS NULL OR position(lower(split_part(c.merchant, ' ', 1)) IN lower(t.descriptor)) > 0);
    IF n <> 1 THEN RETURN CASE WHEN n = 0 THEN 'unmatched' ELSE 'ambiguous' END; END IF;
    SELECT c.* INTO ch FROM fleet_card_charges c WHERE c.location_id = t.location_id AND c.status IN ('booked','confirmed') AND c.amount_minor >= t.amount_minor
       AND (t.descriptor IS NULL OR position(lower(split_part(c.merchant, ' ', 1)) IN lower(t.descriptor)) > 0) FOR UPDATE;
    IF ch.amount_minor = t.amount_minor THEN
      RETURN 'unmatched'; -- a full refund cannot reduce a charge to zero here: the owner records it (it is visible in the queue)
    END IF;
    r := fleet_card_charge_post(ch.charge_id, ch.amount_minor - t.amount_minor, 'card:' || ch.charge_id || ':refund:' || t.txn_id, 'controller', 'bank:' || t.txn_id);
    UPDATE fleet_bank_transactions SET charge_id = ch.charge_id, classified = 'card_refund', classified_by = 'matcher', journal_id = (r ->> 'journalId')::uuid WHERE txn_id = t.txn_id;
    RETURN 'refund';
  ELSIF t.kind IN ('transfer','other') AND t.direction = 'in' AND t.status = 'settled' AND t.classified IS NULL THEN
    -- A credit of exactly the amount of a transfer you recorded to this account before it arrived (a statement export may
    -- not say "transfer"). Two alike in transit are interchangeable: the oldest arrives first.
    SELECT * INTO tr FROM fleet_location_transfers WHERE to_location = t.location_id AND state = 'in_transit' AND amount_minor = t.amount_minor
       AND recorded_at <= COALESCE(t.settled_at, t.first_seen) + interval '1 hour' ORDER BY recorded_at, transfer_id LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN RETURN 'unmatched'; END IF;
    UPDATE fleet_location_transfers SET state = 'arrived', arrived_at = COALESCE(t.settled_at, now()), arrival_txn_id = t.txn_id WHERE transfer_id = tr.transfer_id;
    UPDATE fleet_bank_transactions SET transfer_id = tr.transfer_id, classified = 'transfer_in', classified_by = 'matcher' WHERE txn_id = t.txn_id;
    RETURN 'transfer_arrived';
  END IF;
  RETURN 'unmatched';
END $$;

-- Re-run matching for a location's open items (after a declaration, a new hold, or new evidence).
CREATE FUNCTION fleet_location_match_pending(p_loc uuid) RETURNS integer LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE t uuid; n integer := 0; r text;
BEGIN
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
  PERFORM fleet_location_match_pending(p_to);
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
                   'reference', reference, 'recordedAt', recorded_at, 'arrivedAt', arrived_at) ORDER BY recorded_at DESC)
                   FROM (SELECT * FROM fleet_location_transfers ORDER BY recorded_at DESC LIMIT 50) t), '[]'::jsonb),
    'unexplained', COALESCE((SELECT jsonb_agg(jsonb_build_object('txnId', txn_id, 'locationId', location_id, 'status', status, 'direction', direction, 'kind', kind,
                   'amountMinor', amount_minor, 'descriptor', descriptor, 'at', COALESCE(settled_at, authorised_at, first_seen)) ORDER BY first_seen)
                   FROM (SELECT * FROM fleet_bank_transactions WHERE classified IS NULL ORDER BY first_seen LIMIT 100) t), '[]'::jsonb),
    'debitCharges', COALESCE((SELECT jsonb_agg(jsonb_build_object('chargeId', charge_id, 'agentId', agent_id, 'merchant', merchant, 'status', status, 'evidence', evidence_status,
                   'holdMaxMinor', hold_max_minor, 'declaredMinor', declared_minor, 'amountMinor', amount_minor, 'sca', sca, 'awaitingApprovalSince', awaiting_approval_since,
                   'createdAt', created_at) ORDER BY created_at DESC)
                   FROM (SELECT * FROM fleet_card_charges WHERE location_id IS NOT NULL ORDER BY created_at DESC LIMIT 50) c), '[]'::jsonb))
$$;

${CARD_AUTHORIZE}
${CARD_DECLARE}
${HOLDS_EXPIRE}
${CHARGE_POST}
${TREASURY_LIQUIDITY}
${DISPATCH}
${DASH_CALL}
${OPS_WATCH}
`;

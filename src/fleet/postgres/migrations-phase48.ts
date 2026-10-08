/**
 * Schema v48 — the PayPal treasury rail, four-key custody activation, agent wallet limits, card clearing and the treasury
 * transaction list (docs/design/master-launch-specification.md §§4–6).
 *
 * Nothing here moves money at migration time, connects a provider or turns anything on. It replaces the two constitutional
 * pins that made live custody impossible in every configuration with an explicit, owner-granted, expiring activation:
 *
 * 1. FOUR-KEY CUSTODY ACTIVATION. fleet_economic_model.custody_execution_enabled is no longer pinned false by a CHECK; it
 *    may be true only while it names an owner activation (fleet_custody_activations: per-instruction and rolling-24 h
 *    maxima, an expiry of at most 90 days) and only fleet_admin_custody_activate / _deactivate and the reaper's expiry can
 *    change it (guard trigger). An instruction is issued only when (1) that activation is live, (2) a LIVE PayPal rail has
 *    verified readiness for the capability, (3) the custody signer has a fresh live attestation and (4) — outside SQL — the
 *    custody executor runs with REAL_PAYMENTS_ENABLED=true. Default: off.
 * 2. LIVE IS PAYPAL ONLY. The "never live" rail pin becomes a scope: a live rail is the owner's PayPal treasury with a
 *    credential reference, capabilities within {receive_payments, refunds, payouts}. It still starts pending_setup and
 *    matches a capability only with verified readiness (v46).
 * 3. WALLET LIMITS. Agent wallets stay ledger partitions of the treasury; Fleet Control may set per-agent maxima per
 *    instruction and per rolling 24 h (and for card charges). The issuer checks them with the activation limits.
 * 4. THE ISSUER RUNS. svc_issue_due_instructions issues every reserved agent order the four keys allow (reaper pass);
 *    nothing else changes for an order that cannot be paid (it waits and expires as before).
 * 5. PAYPAL RECEIVING. Agents open checkouts (Orders v2) for their ventures; the custody executor (the only holder of the
 *    PayPal credential) creates, captures and reconciles them. Webhooks land unverified in an inbox through the controller
 *    (no PayPal secret there) and are verified by custody by postback. A completed capture is the agent's revenue (net of
 *    PayPal's fee) exactly once (claim paypal:capture:<id>); refunds, reversals and dispute fees come back from the agent's
 *    cash, any shortfall advanced by the treasury against its payable (as v47). Money with no checkout is never revenue:
 *    it stays unmatched for the owner to attribute.
 * 6. CARD CLEARING. The owner's card is a bypass, not a source of money: a charge is the agent's expense (the treasury
 *    covers any shortfall as a fleet expense) and moves that cash into a reserve against the card liability; the owner
 *    repays the card outside the fleet (PayPal has no repayment API) and records it. Money paid to the card is an owner
 *    invoice: returned (minus the swept share, which is the agent's profit contribution taken by the owner) or kept as an
 *    owner withdrawal — either way logged.
 * 7. TREASURY LIST AND HEALTH. One row per journal with its real-cash effect, attributed to its agent, filterable; health
 *    with partitions, card liability, invoices, flows, contributions, runway and PayPal reconciliation.
 *
 * Unchanged: REAL_PAYMENTS_ENABLED / OWNER_SWEEP_ENABLED / REAL_REPLICATION_ENABLED (no SQL reads them), the cap, the
 * operating mode, replication, the sweep model, owner requests.
 */
import { V32_SQL } from "./migrations-phase32.js";
import { V42_SQL } from "./migrations-phase42.js";
import { V30_SQL } from "./migrations-phase30.js";
import { V45_SQL } from "./migrations-phase45.js";
import { V46_SQL } from "./migrations-phase46.js";
import { V47_SQL } from "./migrations-phase47.js";
import { restate } from "./migrations-phase42.js";

export const EVENT_ROUTES_V48 = Object.freeze({
  P0_CRITICAL: ["paypal_capture_conflict"],
  P1_HIGH: ["custody_activated", "custody_deactivated", "custody_activation_expired", "card_receipt_recorded", "paypal_clawback_posted",
    "paypal_receipt_mismatch", "paypal_refund_unmatched"],
  P2_IMPORTANT: ["wallet_limits_set", "card_charge_booked", "card_repayment_recorded", "card_receipt_returned", "card_receipt_withdrawn",
    "paypal_receipt_posted", "paypal_checkout_failed"],
  AUDIT_ONLY: ["card_charge_confirmed", "paypal_webhook_rejected", "paypal_balance_observed"],
  AGENT_ACTIVITY_ONLY: ["paypal_checkout_requested", "paypal_checkout_opened", "paypal_checkout_cancelled"],
} as const);

/** v48 agent operations (all through api_economy). */
export const PAYPAL_OPS = ["paypal.checkout", "paypal.checkouts", "paypal.cancel"] as const;
export const DASHBOARD_READ_OPS_V48 = ["treasury_transactions", "treasury_health", "card_clearing", "paypal", "custody"] as const;
export const DASHBOARD_SENSITIVE_OPS_V48 = ["custody_activate", "custody_deactivate", "wallet_limits_set", "card_charge_record", "card_charge_confirm",
  "card_repayment_record", "card_receipt_record", "card_receipt_resolve"] as const;
/** The ledger classes whose balances are real money held for the fleet (treasury partitions, agent partitions, reserves). */
export const CASH_CLASSES = ["treasury_cash", "custody_clearing", "agent_cash", "agent_reserved", "agent_envelope_cash", "agent_project_escrow",
  "agent_tax_reserve", "fleet_operating_pool", "card_cash_reserve"] as const;

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');`;
const WORKER = `IF p_worker IS NULL OR p_worker !~ '^[a-z0-9-]{3,40}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: worker name'; END IF;`;
const PAYPAL_ID = `'^[A-Z0-9]{5,40}$'`;

// ── Restatements ──
const ISSUE = restate(V32_SQL, "svc_issue_payment_instruction", [
  [`        v_id uuid := gen_random_uuid(); v_cap text; v_ref text; v_venture uuid; v_vprov text;`,
   `        v_id uuid := gen_random_uuid(); v_cap text; v_ref text; v_venture uuid; v_vprov text;
        act fleet_custody_activations; lim fleet_agent_wallet_limits; v_day bigint;`],
  [`  IF NOT (SELECT custody_execution_enabled FROM fleet_economic_model WHERE id = 1) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CUSTODY_EXECUTION_DISABLED');
  END IF;`,
   `  -- v48: key 1 — a live owner activation (custody_execution_enabled names it; expiry is checked here, not only by the reaper).
  SELECT * INTO act FROM fleet_custody_activation_live();
  IF act.activation_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CUSTODY_EXECUTION_DISABLED');
  END IF;`],
  [`  -- Destination/provider compatibility: payouts to a provider account, bank transfers; never crypto or credits.`,
   `  -- v48: the activation's maxima, then the agent's own wallet limits (both per instruction and per rolling 24 h).
  IF o.amount_cents > act.max_instruction_minor THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ACTIVATION_LIMIT'); END IF;
  SELECT COALESCE(sum(amount_cents), 0) INTO v_day FROM fleet_payment_instructions WHERE issued_at > now() - interval '24 hours' AND status <> 'failed';
  IF v_day + o.amount_cents > act.max_daily_minor THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ACTIVATION_DAILY_LIMIT'); END IF;
  IF o.order_type = 'agent_spend' THEN
    SELECT * INTO lim FROM fleet_agent_wallet_limits WHERE agent_id = o.agent_id;
    IF FOUND AND lim.max_instruction_minor IS NOT NULL AND o.amount_cents > lim.max_instruction_minor THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_WALLET_LIMIT');
    END IF;
    IF FOUND AND lim.max_daily_minor IS NOT NULL THEN
      SELECT COALESCE(sum(i.amount_cents), 0) INTO v_day FROM fleet_payment_instructions i JOIN fleet_payment_orders x ON x.order_id = i.order_id
       WHERE x.agent_id = o.agent_id AND i.issued_at > now() - interval '24 hours' AND i.status <> 'failed';
      IF v_day + o.amount_cents > lim.max_daily_minor THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_WALLET_DAILY_LIMIT'); END IF;
    END IF;
  END IF;
  -- Destination/provider compatibility: payouts to a provider account, bank transfers; never crypto or credits.`],
]);

const CUSTODY_STATUS = restate(V32_SQL, "fleet_custody_status", [
  [`    'executionEnabled', (SELECT custody_execution_enabled FROM fleet_economic_model WHERE id = 1),`,
   `    'executionEnabled', (SELECT custody_execution_enabled FROM fleet_economic_model WHERE id = 1),
    'activation', (SELECT jsonb_build_object('activationId', a.activation_id, 'grantedBy', a.granted_by, 'grantedAt', a.granted_at, 'expiresAt', a.expires_at,
                     'maxInstructionMinor', a.max_instruction_minor, 'maxDailyMinor', a.max_daily_minor, 'reason', a.reason)
                   FROM fleet_custody_activation_live() a WHERE a.activation_id IS NOT NULL),
    'liveRails', (SELECT count(*) FROM fleet_payment_rails WHERE mode = 'live' AND status = 'active'),`],
]);

// The not-live pin is now a scope: live only for the owner's PayPal treasury; custody on only under an owner activation.
const ECONOMY_HEALTH = restate(V30_SQL, "fleet_economy_health", [
  [`  -- Constitutional pins (real money stays off in this schema).
  f := f || jsonb_build_array(jsonb_build_object('severity',
    CASE WHEN EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fleet_payment_rails_not_live') THEN 'INFO' ELSE 'FAIL' END, 'code', 'RAILS_NOT_LIVE_PINNED', 'detail', '{}'::jsonb));`,
   `  -- v48: live money is scoped (the PayPal treasury only) and custody runs only under a live owner activation.
  f := f || jsonb_build_array(jsonb_build_object('severity',
    CASE WHEN EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fleet_payment_rails_live_scope')
          AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fleet_economic_model_custody_activation') THEN 'INFO' ELSE 'FAIL' END,
    'code', 'LIVE_MONEY_SCOPED', 'detail', jsonb_build_object('liveRails', (SELECT count(*) FROM fleet_payment_rails WHERE mode = 'live' AND status = 'active'),
      'custodyActive', EXISTS (SELECT 1 FROM fleet_custody_activation_live() a WHERE a.activation_id IS NOT NULL))));`],
]);

// A registry with real money (a receive-only or a live rail) never allows simulated settlement.
const SIMULATED_SET = restate(V46_SQL, "fleet_admin_simulated_settlement_set", [
  [`IF p_allowed AND EXISTS (SELECT 1 FROM fleet_payment_rails WHERE mode = 'live_receive' AND status <> 'revoked') THEN`,
   `IF p_allowed AND EXISTS (SELECT 1 FROM fleet_payment_rails WHERE mode IN ('live_receive','live') AND status <> 'revoked') THEN`],
]);

const OPEN_AGENT = restate(V47_SQL, "fleet_ledger_open_agent", [
  [`'agent_provider_payable']`, `'agent_provider_payable','agent_card_receivable']`],
]);

const DISPATCH = restate(V42_SQL, "api_economy", [
  [`WHEN 'account.mark' THEN 'planning' WHEN 'phone.quote' THEN 'planning'`,
   `WHEN 'account.mark' THEN 'planning' WHEN 'phone.quote' THEN 'planning'
    -- v48: PayPal checkouts are the agent's own selling (receiving money; no approval step).
    WHEN 'paypal.checkout' THEN 'planning' WHEN 'paypal.checkouts' THEN 'planning' WHEN 'paypal.cancel' THEN 'planning'`],
  [`      WHEN 'wallet' THEN jsonb_build_object('ok', true, 'wallet', fleet_agent_wallet(p_agent))`,
   `      WHEN 'wallet' THEN jsonb_build_object('ok', true, 'wallet', fleet_agent_wallet(p_agent) || jsonb_build_object('limits', fleet_wallet_limits_json(p_agent),
                                 'payments', fleet_payments_readiness()))`],
  [`      WHEN 'phone.quote' THEN fleet_econ_phone_quote(p_agent, a)`,
   `      WHEN 'phone.quote' THEN fleet_econ_phone_quote(p_agent, a)
      WHEN 'paypal.checkout' THEN fleet_econ_paypal_checkout(p_agent, a)
      WHEN 'paypal.checkouts' THEN fleet_econ_paypal_checkouts(p_agent, a)
      WHEN 'paypal.cancel' THEN fleet_econ_paypal_cancel(p_agent, a)`],
]);

const DASH_CALL = restate(V45_SQL, "dash_call", [
  [`'provider_credits_record');`, `'provider_credits_record',${q(DASHBOARD_SENSITIVE_OPS_V48)});`],
  [`'notification_get','command_events')) THEN`, `'notification_get','command_events',${q(DASHBOARD_READ_OPS_V48)})) THEN`],
  [`      WHEN 'command_events' THEN fleet_command_events(COALESCE((a ->> 'limit')::integer, 200))`,
   `      WHEN 'command_events' THEN fleet_command_events(COALESCE((a ->> 'limit')::integer, 200))
      -- v48: the treasury
      WHEN 'treasury_transactions' THEN fleet_treasury_transactions(a ->> 'agentId', COALESCE((a ->> 'limit')::integer, 100), (a ->> 'beforeSeq')::bigint, a ->> 'direction')
      WHEN 'treasury_health' THEN fleet_treasury_health()
      WHEN 'card_clearing' THEN fleet_card_clearing()
      WHEN 'paypal' THEN fleet_paypal_status()
      WHEN 'custody' THEN fleet_custody_status()`],
  [`      WHEN 'provider_credits_record' THEN fleet_admin_provider_credits_record((a ->> 'amountMinor')::bigint, a ->> 'externalRef', a ->> 'reason', 'operator:owner')`,
   `      WHEN 'provider_credits_record' THEN fleet_admin_provider_credits_record((a ->> 'amountMinor')::bigint, a ->> 'externalRef', a ->> 'reason', 'operator:owner')
      WHEN 'custody_activate' THEN fleet_admin_custody_activate((a ->> 'maxInstructionMinor')::bigint, (a ->> 'maxDailyMinor')::bigint, (a ->> 'hours')::integer, a ->> 'reason', 'operator:owner')
      WHEN 'custody_deactivate' THEN fleet_admin_custody_deactivate(a ->> 'reason', 'operator:owner')
      WHEN 'wallet_limits_set' THEN fleet_admin_wallet_limits_set(a ->> 'agentId', (a ->> 'maxInstructionMinor')::bigint, (a ->> 'maxDailyMinor')::bigint,
          (a ->> 'cardMaxChargeMinor')::bigint, (a ->> 'cardMaxDailyMinor')::bigint, a ->> 'note', 'operator:owner')
      WHEN 'card_charge_record' THEN fleet_admin_card_charge_record(a ->> 'agentId', (a ->> 'amountMinor')::bigint, a ->> 'merchant', a ->> 'statementRef', 'operator:owner')
      WHEN 'card_charge_confirm' THEN fleet_admin_card_charge_confirm((a ->> 'chargeId')::uuid, (a ->> 'amountMinor')::bigint, a ->> 'statementRef', 'operator:owner')
      WHEN 'card_repayment_record' THEN fleet_admin_card_repayment_record((a ->> 'amountMinor')::bigint, a ->> 'reference', 'operator:owner')
      WHEN 'card_receipt_record' THEN fleet_admin_card_receipt_record(a ->> 'agentId', (a ->> 'amountMinor')::bigint, COALESCE(a ->> 'kind', 'revenue'), a ->> 'reference',
          a ->> 'note', 'operator:owner')
      WHEN 'card_receipt_resolve' THEN fleet_admin_card_receipt_resolve((a ->> 'receiptId')::uuid, a ->> 'resolution', (a ->> 'sweepMinor')::bigint, a ->> 'reference',
          'operator:owner')`],
]);

// The retired owner spend route's event type is no longer named: historical rows of it still route P1 through the
// payment_order_ prefix (behaviour unchanged), and no live function names the retired route.
const EVENT_ROUTE = restate(V47_SQL, "fleet_event_route", [
  ["'payment_order_cancelled','payment_order_awaiting_owner','payment_instruction_issued'", "'payment_order_cancelled','payment_instruction_issued'"],
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V48) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
]);

const RECONCILE = restate(V47_SQL, "fleet_reconcile", [
  ["  -- Treasury: the unallocated partition never negative (ledger CHECK) — reported for the overview.",
   `  -- v48: PayPal receiving, card clearing and the custody activation.
  SELECT count(*) INTO n FROM fleet_paypal_checkouts WHERE status IN ('approved','capture_pending') AND COALESCE(approved_at, opened_at, created_at) < now() - interval '6 hours';
  IF n > 0 THEN f := f || jsonb_build_array(jsonb_build_object('severity', 'WARN', 'code', 'PAYPAL_CAPTURES_STALE', 'detail', jsonb_build_object('count', n))); END IF;
  SELECT count(*) INTO n FROM fleet_paypal_transactions WHERE checkout_id IS NULL AND amount_minor > 0 AND attributed_at IS NULL;
  IF n > 0 THEN f := f || jsonb_build_array(jsonb_build_object('severity', 'WARN', 'code', 'PAYPAL_UNMATCHED_RECEIPTS', 'detail', jsonb_build_object('count', n))); END IF;
  SELECT count(*) INTO n FROM fleet_paypal_webhook_inbox WHERE status = 'rejected' AND received_at > now() - interval '24 hours';
  IF n > 0 THEN f := f || jsonb_build_array(jsonb_build_object('severity', 'INFO', 'code', 'PAYPAL_WEBHOOKS_REJECTED', 'detail', jsonb_build_object('count24h', n))); END IF;
  SELECT count(*) INTO n FROM fleet_paypal_webhook_inbox WHERE status = 'received' AND received_at < now() - interval '1 hour';
  IF n > 0 THEN f := f || jsonb_build_array(jsonb_build_object('severity', 'WARN', 'code', 'PAYPAL_WEBHOOKS_UNVERIFIED', 'detail', jsonb_build_object('count', n))); END IF;
  amt := fleet_ledger_balance('fleet:card:payable');
  IF amt > 0 THEN f := f || jsonb_build_array(jsonb_build_object('severity', 'INFO', 'code', 'CARD_REPAYMENT_OUTSTANDING', 'detail', jsonb_build_object('minor', amt))); END IF;
  SELECT count(*) INTO n FROM fleet_card_receipts WHERE status = 'invoiced';
  IF n > 0 THEN f := f || jsonb_build_array(jsonb_build_object('severity', 'WARN', 'code', 'CARD_RECEIPTS_UNRESOLVED', 'detail', jsonb_build_object('count', n))); END IF;
  IF fleet_ledger_balance('fleet:card:reserve') <> fleet_ledger_balance('fleet:card:payable') THEN
    f := f || jsonb_build_array(jsonb_build_object('severity', 'ERROR', 'code', 'CARD_RESERVE_MISMATCH', 'detail',
      jsonb_build_object('reserveMinor', fleet_ledger_balance('fleet:card:reserve'), 'payableMinor', fleet_ledger_balance('fleet:card:payable'))));
  END IF;
  -- Treasury: the unallocated partition never negative (ledger CHECK) — reported for the overview.`],
]);

export const V48_SQL = `
-- ═══ 1. Custody activation (replaces the v10 pin) ═══
CREATE TABLE fleet_custody_activations (
  activation_id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  granted_by            text        NOT NULL CHECK (granted_by ~ '^operator:[A-Za-z0-9._-]{1,64}$'),
  reason                text        NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  max_instruction_minor bigint      NOT NULL CHECK (max_instruction_minor > 0),
  max_daily_minor       bigint      NOT NULL CHECK (max_daily_minor >= max_instruction_minor),
  granted_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,
  ended_at              timestamptz,
  ended_by              text,
  end_reason            text        CHECK (end_reason IS NULL OR length(end_reason) BETWEEN 1 AND 300),
  CHECK (expires_at > granted_at AND expires_at <= granted_at + interval '90 days'),
  CHECK ((ended_at IS NULL) = (ended_by IS NULL) AND (ended_at IS NULL) = (end_reason IS NULL))
);
CREATE FUNCTION fleet_custody_activations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.ended_at IS NOT NULL THEN RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: a custody activation is history once ended'; END IF;
  IF NEW.activation_id <> OLD.activation_id OR NEW.granted_by <> OLD.granted_by OR NEW.reason <> OLD.reason OR NEW.max_instruction_minor <> OLD.max_instruction_minor
     OR NEW.max_daily_minor <> OLD.max_daily_minor OR NEW.granted_at <> OLD.granted_at OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: an activation''s grant is fixed (end it and grant another)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_custody_activations_guard BEFORE UPDATE OR DELETE ON fleet_custody_activations FOR EACH ROW EXECUTE FUNCTION fleet_custody_activations_guard();
CREATE TRIGGER fleet_custody_activations_no_truncate BEFORE TRUNCATE ON fleet_custody_activations FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- Not a foreign key: only fleet_custody_switch writes it (behind the guard), always with an activation it just read or created.
ALTER TABLE fleet_economic_model ADD COLUMN custody_activation_id uuid;
ALTER TABLE fleet_economic_model DROP CONSTRAINT fleet_economic_model_custody_execution_enabled_check;
ALTER TABLE fleet_economic_model ADD CONSTRAINT fleet_economic_model_custody_activation CHECK (NOT custody_execution_enabled OR custody_activation_id IS NOT NULL);
CREATE FUNCTION fleet_economic_model_custody_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.custody_execution_enabled IS DISTINCT FROM OLD.custody_execution_enabled OR NEW.custody_activation_id IS DISTINCT FROM OLD.custody_activation_id)
     AND COALESCE(current_setting('fleet.custody_activation', true), '') <> 'on' THEN
    RAISE EXCEPTION 'FLEET_CUSTODY_ACTIVATION_REQUIRED: custody execution changes only through an owner activation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_economic_model_custody_guard BEFORE UPDATE ON fleet_economic_model FOR EACH ROW EXECUTE FUNCTION fleet_economic_model_custody_guard();

-- The live activation (a NULL row when there is none): enabled, unended and unexpired.
CREATE FUNCTION fleet_custody_activation_live() RETURNS SETOF fleet_custody_activations LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT a.* FROM fleet_economic_model m JOIN fleet_custody_activations a ON a.activation_id = m.custody_activation_id
   WHERE m.id = 1 AND m.custody_execution_enabled AND a.ended_at IS NULL AND a.expires_at > now()
$$;

CREATE FUNCTION fleet_custody_switch(p_on boolean, p_activation uuid) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM set_config('fleet.custody_activation', 'on', true);
  UPDATE fleet_economic_model SET custody_execution_enabled = p_on, custody_activation_id = CASE WHEN p_on THEN p_activation END WHERE id = 1;
  PERFORM set_config('fleet.custody_activation', 'off', true);
END $$;

CREATE FUNCTION fleet_admin_custody_activate(p_max_instruction bigint, p_max_daily bigint, p_hours integer, p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE prev uuid; a fleet_custody_activations;
BEGIN
  ${OWNER_ACTOR}
  IF p_hours IS NULL OR p_hours NOT BETWEEN 1 AND 2160 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: an activation lasts 1..2160 hours (90 days)'; END IF;
  IF p_max_instruction IS NULL OR p_max_daily IS NULL OR p_max_instruction <= 0 OR p_max_daily < p_max_instruction THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: a positive per-instruction maximum and a daily maximum at least as large';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a reason is required'; END IF;
  SELECT custody_activation_id INTO prev FROM fleet_economic_model WHERE id = 1 FOR UPDATE;
  IF prev IS NOT NULL THEN
    UPDATE fleet_custody_activations SET ended_at = now(), ended_by = p_actor, end_reason = 'superseded by a new activation' WHERE activation_id = prev AND ended_at IS NULL;
  END IF;
  INSERT INTO fleet_custody_activations (granted_by, reason, max_instruction_minor, max_daily_minor, expires_at)
    VALUES (p_actor, left(fleet_scrub(p_reason), 300), p_max_instruction, p_max_daily, now() + make_interval(hours => p_hours)) RETURNING * INTO a;
  PERFORM fleet_custody_switch(true, a.activation_id);
  PERFORM fleet_event('custody_activated', NULL, p_actor, jsonb_build_object('activationId', a.activation_id, 'maxInstructionMinor', a.max_instruction_minor,
    'maxDailyMinor', a.max_daily_minor, 'expiresAt', a.expires_at));
  RETURN jsonb_build_object('ok', true, 'activationId', a.activation_id, 'expiresAt', a.expires_at,
    'note', 'money leaves only when a live PayPal rail is verified for the capability, the custody signer attests it, and the custody executor host has real payments switched on');
END $$;

CREATE FUNCTION fleet_admin_custody_deactivate(p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE prev uuid;
BEGIN
  ${OWNER_ACTOR}
  SELECT custody_activation_id INTO prev FROM fleet_economic_model WHERE id = 1 FOR UPDATE;
  IF prev IS NULL THEN RETURN jsonb_build_object('ok', true, 'active', false); END IF;
  UPDATE fleet_custody_activations SET ended_at = now(), ended_by = p_actor, end_reason = left(COALESCE(NULLIF(trim(p_reason), ''), 'deactivated by the owner'), 300)
   WHERE activation_id = prev AND ended_at IS NULL;
  PERFORM fleet_custody_switch(false, NULL);
  PERFORM fleet_event('custody_deactivated', NULL, p_actor, jsonb_build_object('activationId', prev));
  RETURN jsonb_build_object('ok', true, 'active', false, 'activationId', prev);
END $$;

-- Reaper: an expired (or ended) activation switches custody off.
CREATE FUNCTION svc_custody_activation_expire() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE m fleet_economic_model; a fleet_custody_activations;
BEGIN
  SELECT * INTO m FROM fleet_economic_model WHERE id = 1 FOR UPDATE;
  IF NOT m.custody_execution_enabled THEN RETURN jsonb_build_object('ok', true, 'active', false); END IF;
  SELECT * INTO a FROM fleet_custody_activations WHERE activation_id = m.custody_activation_id;
  IF a.ended_at IS NULL AND a.expires_at > now() THEN RETURN jsonb_build_object('ok', true, 'active', true, 'expiresAt', a.expires_at); END IF;
  IF a.ended_at IS NULL THEN UPDATE fleet_custody_activations SET ended_at = now(), ended_by = 'controller', end_reason = 'expired' WHERE activation_id = a.activation_id; END IF;
  PERFORM fleet_custody_switch(false, NULL);
  PERFORM fleet_event('custody_activation_expired', NULL, 'controller', jsonb_build_object('activationId', a.activation_id, 'expiresAt', a.expires_at));
  RETURN jsonb_build_object('ok', true, 'active', false, 'expired', a.activation_id);
END $$;

-- ═══ 2. Live rails: the owner's PayPal treasury only ═══
ALTER TABLE fleet_payment_rails DROP CONSTRAINT fleet_payment_rails_not_live;
ALTER TABLE fleet_payment_rails ADD CONSTRAINT fleet_payment_rails_live_scope
  CHECK (mode <> 'live' OR (provider = 'paypal' AND credential_id IS NOT NULL AND capabilities <@ ARRAY['receive_payments','refunds','payouts']::text[]));

${SIMULATED_SET}

-- ═══ 3. Agent wallet limits (Fleet Control) ═══
CREATE TABLE fleet_agent_wallet_limits (
  agent_id              text        PRIMARY KEY REFERENCES fleet_agents(agent_id),
  max_instruction_minor bigint      CHECK (max_instruction_minor > 0),
  max_daily_minor       bigint      CHECK (max_daily_minor > 0),
  card_max_charge_minor bigint      CHECK (card_max_charge_minor > 0),
  card_max_daily_minor  bigint      CHECK (card_max_daily_minor > 0),
  note                  text        CHECK (length(note) <= 300),
  set_by                text        NOT NULL,
  set_at                timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_agent_wallet_limits_no_delete BEFORE DELETE ON fleet_agent_wallet_limits FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_agent_wallet_limits_no_truncate BEFORE TRUNCATE ON fleet_agent_wallet_limits FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION fleet_admin_wallet_limits_set(p_agent text, p_max_instruction bigint, p_max_daily bigint, p_card_max bigint, p_card_daily bigint, p_note text, p_actor text)
RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_agent_wallet_limits;
BEGIN
  ${OWNER_ACTOR}
  IF NOT EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = p_agent) THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: unknown agent'; END IF;
  INSERT INTO fleet_agent_wallet_limits (agent_id, max_instruction_minor, max_daily_minor, card_max_charge_minor, card_max_daily_minor, note, set_by)
    VALUES (p_agent, p_max_instruction, p_max_daily, p_card_max, p_card_daily, left(fleet_scrub(p_note), 300), p_actor)
  ON CONFLICT (agent_id) DO UPDATE SET max_instruction_minor = EXCLUDED.max_instruction_minor, max_daily_minor = EXCLUDED.max_daily_minor,
    card_max_charge_minor = EXCLUDED.card_max_charge_minor, card_max_daily_minor = EXCLUDED.card_max_daily_minor, note = EXCLUDED.note,
    set_by = EXCLUDED.set_by, set_at = now()
  RETURNING * INTO r;
  PERFORM fleet_event('wallet_limits_set', p_agent, p_actor, to_jsonb(r) - 'agent_id' - 'set_by');
  RETURN jsonb_build_object('ok', true, 'limits', fleet_wallet_limits_json(p_agent));
END $$;

CREATE FUNCTION fleet_wallet_limits_json(p_agent text) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('maxInstructionMinor', l.max_instruction_minor, 'maxDailyMinor', l.max_daily_minor, 'cardMaxChargeMinor', l.card_max_charge_minor,
    'cardMaxDailyMinor', l.card_max_daily_minor, 'note', l.note, 'setAt', l.set_at,
    'activation', (SELECT jsonb_build_object('maxInstructionMinor', a.max_instruction_minor, 'maxDailyMinor', a.max_daily_minor, 'expiresAt', a.expires_at)
                   FROM fleet_custody_activation_live() a WHERE a.activation_id IS NOT NULL))
  FROM (SELECT 1) one LEFT JOIN fleet_agent_wallet_limits l ON l.agent_id = p_agent
$$;

-- What the fleet can actually do with real money right now (agents read this; nothing is promised).
CREATE FUNCTION fleet_payments_readiness() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'custodyActive', EXISTS (SELECT 1 FROM fleet_custody_activation_live() a WHERE a.activation_id IS NOT NULL),
    'paypalReceiving', EXISTS (SELECT 1 FROM fleet_payment_rails r WHERE r.provider = 'paypal' AND r.status = 'active' AND r.mode IN ('live','sandbox')
                                 AND fleet_rail_capability_ready(r.rail_id, 'receive_payments')),
    'payoutsLive', EXISTS (SELECT 1 FROM fleet_payment_rails r WHERE r.provider = 'paypal' AND r.status = 'active' AND r.mode = 'live'
                             AND fleet_rail_capability_ready(r.rail_id, 'payouts')
                             AND EXISTS (SELECT 1 FROM fleet_custody_attestations x WHERE x.rail_id = r.rail_id AND x.capability = 'payouts' AND x.rail_mode = 'live' AND x.expires_at > now())),
    'cardBypass', EXISTS (SELECT 1 FROM fleet_owner_identity_classes c WHERE c.class_key = 'payment_card' AND c.status = 'configured'),
    'note', 'payouts run only while the owner''s custody activation is live; card bypass needs the owner''s standing authority')
$$;

-- ═══ 4. The issuer ═══
${ISSUE}

CREATE FUNCTION svc_issue_due_instructions(p_limit integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o record; r jsonb; n integer := 0; w jsonb := '{}'::jsonb; c text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleet_custody_activation_live() a WHERE a.activation_id IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', true, 'enabled', false, 'issued', 0);
  END IF;
  FOR o IN SELECT order_id FROM fleet_payment_orders WHERE status = 'reserved' AND order_type = 'agent_spend' AND expires_at > now()
            ORDER BY created_at LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500) LOOP
    r := svc_issue_payment_instruction(o.order_id);
    IF COALESCE((r ->> 'ok')::boolean, false) THEN n := n + 1;
    ELSE c := COALESCE(r ->> 'code', 'FLEET_UNKNOWN'); w := jsonb_set(w, ARRAY[c], to_jsonb(COALESCE((w ->> c)::integer, 0) + 1)); END IF;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'enabled', true, 'issued', n, 'waiting', w);
END $$;

${CUSTODY_STATUS}

${ECONOMY_HEALTH}

-- ═══ 5. Ledger grammar: PayPal receipts and clawbacks, card clearing ═══
INSERT INTO fleet_ledger_classes (class, kind, normal_side, scope, non_negative, description) VALUES
  ('card_cash_reserve',     'asset',     'D', 'fleet', true, 'Treasury cash earmarked to repay the owner''s card for charges it made on the fleet''s behalf'),
  ('card_payable',          'liability', 'C', 'fleet', true, 'What the fleet owes the owner''s card (repaid by the owner from the treasury account)'),
  ('agent_card_receivable', 'asset',     'D', 'agent', true, 'Money paid to the owner''s card on the agent''s behalf, owed back to the treasury (not spendable)');
INSERT INTO fleet_ledger_accounts (account_id, class, description, created_by) VALUES
  ('fleet:card:reserve', 'card_cash_reserve', 'Treasury cash reserved for card repayment', 'migration'),
  ('fleet:card:payable', 'card_payable', 'Card liability', 'migration');
INSERT INTO fleet_ledger_kinds (kind, requires_external_ref, allowed_sources, multi_agent, description, provenance) VALUES
  ('paypal_receipt',            true,  ARRAY['executor','owner'],    false, 'A PayPal capture of an agent''s checkout received into the treasury (net of PayPal''s fee)', 'external_customer_revenue'),
  ('paypal_clawback',           true,  ARRAY['executor','owner'],    false, 'A PayPal refund, reversal or dispute fee: from the agent''s cash, any shortfall advanced against its payable', 'refund'),
  ('paypal_payable_repayment',  true,  ARRAY['executor','owner'],    false, 'An agent repays a payable from a later PayPal receipt; the treasury advance is recovered', 'internal_transfer'),
  ('card_charge',               true,  ARRAY['controller','owner'],  false, 'A charge on the owner''s card for an agent: its expense (treasury covers any shortfall), cash reserved for repayment', 'internal_transfer'),
  ('card_charge_adjust',        true,  ARRAY['controller','owner'],  false, 'A card charge corrected to the statement amount', 'internal_transfer'),
  ('card_repayment',            true,  ARRAY['owner'],               false, 'The owner repaid the card from the treasury account', 'internal_transfer'),
  ('card_receipt',              true,  ARRAY['controller','owner'],  false, 'Money paid to the owner''s card on an agent''s behalf (owed back to the treasury)', 'external_customer_revenue'),
  ('card_receipt_return',       true,  ARRAY['owner'],               false, 'Card money returned to the treasury, minus the swept share the owner kept', 'internal_transfer'),
  ('card_receipt_withdrawal',   true,  ARRAY['owner'],               false, 'Card money kept by the owner as a permanent withdrawal (the agent''s contribution)', 'internal_transfer');
INSERT INTO fleet_ledger_rules (kind, class, side) VALUES
  ('paypal_receipt','agent_cash','D'), ('paypal_receipt','agent_fees','D'), ('paypal_receipt','agent_revenue','C'),
  ('paypal_clawback','agent_revenue','D'), ('paypal_clawback','agent_fees','D'), ('paypal_clawback','agent_cash','C'),
  ('paypal_clawback','agent_provider_payable','C'), ('paypal_clawback','provider_advances','D'), ('paypal_clawback','treasury_cash','C'),
  ('paypal_payable_repayment','agent_provider_payable','D'), ('paypal_payable_repayment','agent_cash','C'),
  ('paypal_payable_repayment','treasury_cash','D'), ('paypal_payable_repayment','provider_advances','C'),
  ('card_charge','agent_expense','D'), ('card_charge','agent_cash','C'), ('card_charge','fleet_expense','D'), ('card_charge','treasury_cash','C'),
  ('card_charge','card_cash_reserve','D'), ('card_charge','card_payable','C'),
  ('card_charge_adjust','agent_expense','D'), ('card_charge_adjust','agent_expense','C'), ('card_charge_adjust','agent_cash','C'), ('card_charge_adjust','agent_cash','D'),
  ('card_charge_adjust','fleet_expense','D'), ('card_charge_adjust','fleet_expense','C'), ('card_charge_adjust','treasury_cash','C'), ('card_charge_adjust','treasury_cash','D'),
  ('card_charge_adjust','card_cash_reserve','D'), ('card_charge_adjust','card_cash_reserve','C'), ('card_charge_adjust','card_payable','C'), ('card_charge_adjust','card_payable','D'),
  ('card_repayment','card_payable','D'), ('card_repayment','card_cash_reserve','C'),
  ('card_receipt','agent_card_receivable','D'), ('card_receipt','agent_revenue','C'), ('card_receipt','agent_expense','C'),
  ('card_receipt_return','agent_cash','D'), ('card_receipt_return','agent_contributions','D'), ('card_receipt_return','agent_card_receivable','C'),
  ('card_receipt_return','owner_withdrawals','D'), ('card_receipt_return','fleet_profit','C'),
  ('card_receipt_withdrawal','agent_contributions','D'), ('card_receipt_withdrawal','agent_card_receivable','C'),
  ('card_receipt_withdrawal','owner_withdrawals','D'), ('card_receipt_withdrawal','fleet_profit','C');
${OPEN_AGENT}
SELECT fleet_ledger_open_agent(agent_id, 'migration') FROM fleet_ledger_accounts WHERE class = 'agent_cash' GROUP BY agent_id;

ALTER TABLE fleet_revenue_claims DROP CONSTRAINT fleet_revenue_claims_claim_kind_check;
ALTER TABLE fleet_revenue_claims ADD CONSTRAINT fleet_revenue_claims_claim_kind_check
  CHECK (claim_kind IN ('manual_revenue','provider_payout','bank_receipt','owner_attestation','receipt_transfer','paypal_capture','paypal_refund','card_receipt'));

-- ═══ 6. PayPal receiving ═══
CREATE TABLE fleet_paypal_checkouts (
  checkout_id     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        text        NOT NULL REFERENCES fleet_agents(agent_id),
  venture_id      uuid        NOT NULL REFERENCES fleet_ventures(venture_id),
  rail_id         uuid        NOT NULL REFERENCES fleet_payment_rails(rail_id),
  description     text        NOT NULL CHECK (length(description) BETWEEN 3 AND 127),
  amount_minor    bigint      NOT NULL CHECK (amount_minor BETWEEN 1 AND 100000000),
  currency        text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  idempotency_key text        NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  status          text        NOT NULL DEFAULT 'requested'
                              CHECK (status IN ('requested','open','approved','capture_pending','captured','failed','cancelled','expired')),
  paypal_order_id text        UNIQUE CHECK (paypal_order_id ~ ${PAYPAL_ID}),
  approval_url    text        CHECK (length(approval_url) <= 500 AND approval_url ~ '^https://www\\.(sandbox\\.)?paypal\\.com/[A-Za-z0-9/?&=._%-]+$'),
  capture_id      text        UNIQUE CHECK (capture_id ~ ${PAYPAL_ID}),
  failure_code    text        CHECK (failure_code ~ '^[a-z0-9_]{2,64}$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  opened_at       timestamptz,
  approved_at     timestamptz,
  captured_at     timestamptz,
  closed_at       timestamptz,
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '72 hours',
  journal_id      uuid        REFERENCES fleet_ledger_journal(journal_id),
  CHECK (status <> 'open' OR (paypal_order_id IS NOT NULL AND approval_url IS NOT NULL)),
  CHECK (status <> 'captured' OR (capture_id IS NOT NULL AND journal_id IS NOT NULL))
);
CREATE INDEX fleet_paypal_checkouts_agent ON fleet_paypal_checkouts (agent_id, created_at DESC);
CREATE INDEX fleet_paypal_checkouts_work ON fleet_paypal_checkouts (status) WHERE status IN ('requested','approved','capture_pending');
CREATE FUNCTION fleet_paypal_checkouts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: checkouts are history'; END IF;
  IF NEW.checkout_id <> OLD.checkout_id OR NEW.agent_id <> OLD.agent_id OR NEW.venture_id <> OLD.venture_id OR NEW.rail_id <> OLD.rail_id
     OR NEW.description <> OLD.description OR NEW.amount_minor <> OLD.amount_minor OR NEW.currency <> OLD.currency
     OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.created_at <> OLD.created_at
     OR (OLD.paypal_order_id IS NOT NULL AND NEW.paypal_order_id IS DISTINCT FROM OLD.paypal_order_id)
     OR (OLD.capture_id IS NOT NULL AND NEW.capture_id IS DISTINCT FROM OLD.capture_id)
     OR (OLD.journal_id IS NOT NULL AND NEW.journal_id IS DISTINCT FROM OLD.journal_id) THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a checkout''s terms and provider identifiers are fixed';
  END IF;
  IF OLD.status = 'captured' AND NEW.status <> 'captured' THEN RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: a captured checkout is final'; END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'requested' AND NEW.status IN ('open','failed','cancelled','expired'))
    OR (OLD.status = 'open' AND NEW.status IN ('approved','capture_pending','captured','failed','cancelled','expired'))
    OR (OLD.status = 'approved' AND NEW.status IN ('capture_pending','captured','failed'))
    OR (OLD.status = 'capture_pending' AND NEW.status IN ('captured','failed'))
    -- Money that arrives after the fleet gave up on a checkout is still that checkout's money.
    OR (OLD.status IN ('failed','cancelled','expired') AND NEW.status IN ('capture_pending','captured'))) THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: checkout % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_paypal_checkouts_guard BEFORE UPDATE OR DELETE ON fleet_paypal_checkouts FOR EACH ROW EXECUTE FUNCTION fleet_paypal_checkouts_guard();
CREATE TRIGGER fleet_paypal_checkouts_no_truncate BEFORE TRUNCATE ON fleet_paypal_checkouts FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- Webhooks as received (unverified until custody verifies them with PayPal). Never trusted by the controller.
CREATE TABLE fleet_paypal_webhook_inbox (
  event_id     text        PRIMARY KEY CHECK (event_id ~ '^[A-Za-z0-9-]{8,80}$'),
  event_type   text        NOT NULL CHECK (event_type ~ '^[A-Z0-9._]{3,80}$'),
  resource_id  text        CHECK (resource_id ~ '^[A-Za-z0-9-]{3,80}$'),
  headers      jsonb       NOT NULL CHECK (jsonb_typeof(headers) = 'object' AND length(headers::text) <= 4000),
  body         text        NOT NULL CHECK (length(body) BETWEEN 2 AND 65536),
  body_sha256  text        NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  received_at  timestamptz NOT NULL DEFAULT now(),
  status       text        NOT NULL DEFAULT 'received' CHECK (status IN ('received','verified','rejected','processed','ignored')),
  attempts     integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  verified_at  timestamptz,
  processed_at timestamptz,
  note         text        CHECK (length(note) <= 300)
);
CREATE INDEX fleet_paypal_webhook_inbox_pending ON fleet_paypal_webhook_inbox (received_at) WHERE status IN ('received','verified');
CREATE FUNCTION fleet_paypal_webhook_inbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: webhooks are evidence'; END IF;
  IF NEW.event_id <> OLD.event_id OR NEW.event_type <> OLD.event_type OR NEW.resource_id IS DISTINCT FROM OLD.resource_id OR NEW.headers <> OLD.headers
     OR NEW.body <> OLD.body OR NEW.body_sha256 <> OLD.body_sha256 OR NEW.received_at <> OLD.received_at THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a received webhook is fixed';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'received' AND NEW.status IN ('verified','rejected'))
                                       OR (OLD.status = 'verified' AND NEW.status IN ('processed','ignored'))) THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: webhook % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_paypal_webhook_inbox_guard BEFORE UPDATE OR DELETE ON fleet_paypal_webhook_inbox FOR EACH ROW EXECUTE FUNCTION fleet_paypal_webhook_inbox_guard();
CREATE TRIGGER fleet_paypal_webhook_inbox_no_truncate BEFORE TRUNCATE ON fleet_paypal_webhook_inbox FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- PayPal's own transaction records (Transaction Search), keyed as PayPal identifies them (an id is not unique alone).
CREATE TABLE fleet_paypal_transactions (
  rail_id         uuid        NOT NULL REFERENCES fleet_payment_rails(rail_id),
  transaction_id  text        NOT NULL CHECK (transaction_id ~ '^[A-Z0-9]{5,40}$'),
  event_code      text        NOT NULL CHECK (event_code ~ '^T[0-9]{4}$'),
  initiated_at    timestamptz NOT NULL,
  status          text        NOT NULL CHECK (status IN ('S','P','V','F','D')),
  amount_minor    bigint      NOT NULL,
  fee_minor       bigint      NOT NULL DEFAULT 0,
  currency        text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  invoice_id      text        CHECK (length(invoice_id) <= 127),
  custom_field    text        CHECK (length(custom_field) <= 255),
  checkout_id     uuid        REFERENCES fleet_paypal_checkouts(checkout_id),
  attributed_as   text        CHECK (attributed_as IN ('owner_funding','agent_revenue','not_revenue')),
  attributed_ref  text        CHECK (length(attributed_ref) <= 200),
  attributed_by   text,
  attributed_at   timestamptz,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rail_id, transaction_id, event_code, initiated_at),
  CHECK ((attributed_at IS NULL) = (attributed_as IS NULL))
);
CREATE TRIGGER fleet_paypal_transactions_no_delete BEFORE DELETE ON fleet_paypal_transactions FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_paypal_transactions_no_truncate BEFORE TRUNCATE ON fleet_paypal_transactions FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_paypal_balance_observations (
  observation_id bigserial   PRIMARY KEY,
  rail_id        uuid        NOT NULL REFERENCES fleet_payment_rails(rail_id),
  currency       text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  available_minor bigint     NOT NULL,
  total_minor    bigint      NOT NULL,
  observed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_paypal_balance_observations_no_change BEFORE UPDATE OR DELETE ON fleet_paypal_balance_observations FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_paypal_balance_observations_no_truncate BEFORE TRUNCATE ON fleet_paypal_balance_observations FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION fleet_paypal_checkout_json(c fleet_paypal_checkouts) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('checkoutId', c.checkout_id, 'venture', (SELECT venture_key FROM fleet_ventures WHERE venture_id = c.venture_id),
    'description', c.description, 'amountMinor', c.amount_minor, 'currency', c.currency, 'status', c.status,
    'approvalUrl', CASE WHEN c.status = 'open' THEN c.approval_url END, 'failure', c.failure_code, 'createdAt', c.created_at,
    'capturedAt', c.captured_at, 'expiresAt', c.expires_at,
    'mode', (SELECT mode FROM fleet_payment_rails WHERE rail_id = c.rail_id)))
$$;

-- Agent: open a checkout for one of its ventures (the custody executor creates the PayPal order).
CREATE FUNCTION fleet_econ_paypal_checkout(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v fleet_ventures; r fleet_payment_rails; c fleet_paypal_checkouts; v_amount bigint; v_cur text; v_desc text; v_idem text;
BEGIN
  v_idem := a ->> 'idempotencyKey';
  IF v_idem IS NULL OR length(v_idem) NOT BETWEEN 8 AND 128 THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'idempotencyKey (8..128)'); END IF;
  SELECT * INTO c FROM fleet_paypal_checkouts WHERE idempotency_key = 'agent:' || p_agent || ':' || v_idem;
  IF FOUND THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'checkout', fleet_paypal_checkout_json(c)); END IF;
  SELECT * INTO v FROM fleet_ventures WHERE agent_id = p_agent AND venture_key = fleet_econ_key(a, 'venture') AND state NOT IN ('closed');
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND', 'reason', 'venture: the key of one of your open ventures'); END IF;
  v_amount := CASE WHEN jsonb_typeof(a -> 'amountMinor') = 'number' THEN (a ->> 'amountMinor')::bigint END;
  IF v_amount IS NULL OR v_amount NOT BETWEEN 1 AND 100000000 THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'amountMinor (1..100000000)'); END IF;
  v_cur := COALESCE(upper(a ->> 'currency'), (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1));
  IF v_cur <> (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CURRENCY_UNSUPPORTED', 'reason', 'checkouts are in the treasury''s accounting currency');
  END IF;
  v_desc := left(trim(fleet_scrub(COALESCE(a ->> 'description', ''))), 127);
  IF length(v_desc) < 3 THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'description (what the buyer is paying for)'); END IF;
  SELECT x.* INTO r FROM fleet_payment_rails x
   WHERE x.provider = 'paypal' AND x.status = 'active' AND x.mode IN ('live','sandbox') AND 'receive_payments' = ANY(x.capabilities)
     AND fleet_rail_capability_ready(x.rail_id, 'receive_payments')
     AND (x.rail_kind = 'shared' OR x.dedicated_venture_id = v.venture_id)
   ORDER BY (x.mode = 'live') DESC, (x.rail_kind = 'dedicated') DESC, x.rail_id LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NO_RECEIVING_RAIL',
      'reason', 'no PayPal treasury rail is ready to receive payments yet; record the need with fleet_capital require_rail (capability receive_payments)');
  END IF;
  IF (SELECT count(*) FROM fleet_paypal_checkouts WHERE agent_id = p_agent AND status IN ('requested','open')) >= 200 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_LIMIT', 'reason', 'too many open checkouts; cancel unused ones');
  END IF;
  INSERT INTO fleet_paypal_checkouts (agent_id, venture_id, rail_id, description, amount_minor, currency, idempotency_key)
    VALUES (p_agent, v.venture_id, r.rail_id, v_desc, v_amount, v_cur, 'agent:' || p_agent || ':' || v_idem) RETURNING * INTO c;
  PERFORM fleet_event('paypal_checkout_requested', p_agent, 'agent', jsonb_build_object('checkoutId', c.checkout_id, 'ventureId', v.venture_id, 'amountMinor', v_amount));
  RETURN jsonb_build_object('ok', true, 'checkout', fleet_paypal_checkout_json(c),
    'note', 'the custody executor opens it with PayPal shortly; read the approval link with paypal.checkouts and give it to the buyer');
END $$;

CREATE FUNCTION fleet_econ_paypal_checkouts(p_agent text, a jsonb) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('ok', true, 'checkouts', COALESCE((SELECT jsonb_agg(fleet_paypal_checkout_json(c) ORDER BY c.created_at DESC)
    FROM fleet_paypal_checkouts c WHERE c.checkout_id IN (SELECT x.checkout_id FROM fleet_paypal_checkouts x WHERE x.agent_id = p_agent
            AND (a ->> 'checkoutId' IS NULL OR x.checkout_id::text = a ->> 'checkoutId')
            AND (a ->> 'status' IS NULL OR x.status = a ->> 'status')
          ORDER BY x.created_at DESC LIMIT LEAST(COALESCE(CASE WHEN jsonb_typeof(a -> 'limit') = 'number' THEN (a ->> 'limit')::integer END, 50), 200))), '[]'::jsonb))
$$;

CREATE FUNCTION fleet_econ_paypal_cancel(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_paypal_checkouts;
BEGIN
  SELECT * INTO c FROM fleet_paypal_checkouts WHERE agent_id = p_agent AND checkout_id::text = a ->> 'checkoutId' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF c.status NOT IN ('requested','open') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE', 'status', c.status); END IF;
  UPDATE fleet_paypal_checkouts SET status = 'cancelled', closed_at = now() WHERE checkout_id = c.checkout_id RETURNING * INTO c;
  PERFORM fleet_event('paypal_checkout_cancelled', p_agent, 'agent', jsonb_build_object('checkoutId', c.checkout_id));
  RETURN jsonb_build_object('ok', true, 'checkout', fleet_paypal_checkout_json(c));
END $$;

-- Controller (service role): store a webhook as received. Deduplicated by PayPal's event id; refused under backlog so
-- PayPal retries (it retries for three days).
CREATE FUNCTION svc_paypal_webhook_receive(p_event_id text, p_event_type text, p_resource_id text, p_headers jsonb, p_body text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE n integer;
BEGIN
  IF p_event_id IS NULL OR p_event_id !~ '^[A-Za-z0-9-]{8,80}$' OR p_event_type IS NULL OR p_event_type !~ '^[A-Z0-9._]{3,80}$'
     OR (p_resource_id IS NOT NULL AND p_resource_id !~ '^[A-Za-z0-9-]{3,80}$')
     OR p_headers IS NULL OR jsonb_typeof(p_headers) <> 'object' OR length(p_headers::text) > 4000 OR p_body IS NULL OR length(p_body) NOT BETWEEN 2 AND 65536 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  SELECT count(*) INTO n FROM fleet_paypal_webhook_inbox WHERE status = 'received';
  IF n >= 5000 THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BACKLOG'); END IF;
  INSERT INTO fleet_paypal_webhook_inbox (event_id, event_type, resource_id, headers, body, body_sha256)
    VALUES (p_event_id, p_event_type, p_resource_id, p_headers, p_body, encode(sha256(convert_to(p_body, 'UTF8')), 'hex'))
  ON CONFLICT (event_id) DO NOTHING;
  RETURN jsonb_build_object('ok', true, 'duplicate', NOT FOUND);
END $$;

-- Custody: the webhooks to verify (received) and to interpret (verified), oldest first.
CREATE FUNCTION cx_paypal_inbox(p_worker text, p_limit integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r jsonb;
BEGIN
  ${WORKER}
  WITH picked AS (
    SELECT event_id FROM fleet_paypal_webhook_inbox WHERE status IN ('received','verified') AND attempts < 50
     ORDER BY received_at LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100) FOR UPDATE SKIP LOCKED),
  bumped AS (UPDATE fleet_paypal_webhook_inbox w SET attempts = w.attempts + 1 FROM picked WHERE w.event_id = picked.event_id RETURNING w.*)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('eventId', b.event_id, 'eventType', b.event_type, 'status', b.status, 'headers', b.headers, 'body', b.body)
                            ORDER BY b.received_at), '[]'::jsonb) INTO r FROM bumped b;
  RETURN r;
END $$;

CREATE FUNCTION cx_paypal_inbox_result(p_worker text, p_event_id text, p_status text, p_note text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE w fleet_paypal_webhook_inbox;
BEGIN
  ${WORKER}
  SELECT * INTO w FROM fleet_paypal_webhook_inbox WHERE event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF w.status = p_status THEN RETURN jsonb_build_object('ok', true, 'replay', true); END IF;
  IF p_status NOT IN ('verified','rejected','processed','ignored') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  IF NOT ((w.status = 'received' AND p_status IN ('verified','rejected')) OR (w.status = 'verified' AND p_status IN ('processed','ignored'))) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE', 'status', w.status);
  END IF;
  UPDATE fleet_paypal_webhook_inbox SET status = p_status, note = left(fleet_scrub(p_note), 300),
         verified_at = CASE WHEN p_status = 'verified' THEN now() ELSE verified_at END,
         processed_at = CASE WHEN p_status IN ('processed','ignored','rejected') THEN now() ELSE processed_at END
   WHERE event_id = p_event_id;
  IF p_status = 'rejected' THEN
    PERFORM fleet_event('paypal_webhook_rejected', NULL, 'custody', jsonb_build_object('eventId', p_event_id, 'eventType', w.event_type, 'note', left(fleet_scrub(p_note), 120)));
  END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

-- Custody: checkouts to open with PayPal (requested) and to capture (approved), each with its rail's credential binding.
-- Requested checkouts past their expiry are closed here.
CREATE FUNCTION cx_paypal_work(p_worker text, p_limit integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r jsonb;
BEGIN
  ${WORKER}
  UPDATE fleet_paypal_checkouts SET status = 'expired', closed_at = now() WHERE status IN ('requested','open') AND expires_at <= now();
  SELECT COALESCE(jsonb_agg(jsonb_build_object('checkoutId', c.checkout_id, 'status', c.status, 'amountMinor', c.amount_minor, 'currency', c.currency,
           'description', c.description, 'paypalOrderId', c.paypal_order_id, 'railId', r.rail_id, 'railMode', r.mode, 'credentialId', r.credential_id,
           'vaultRef', k.vault_ref) ORDER BY c.created_at), '[]'::jsonb) INTO r
    FROM (SELECT * FROM fleet_paypal_checkouts WHERE status IN ('requested','approved') ORDER BY created_at
           LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100)) c
    JOIN fleet_payment_rails r ON r.rail_id = c.rail_id JOIN fleet_credential_refs k ON k.credential_id = r.credential_id
   WHERE r.status = 'active' AND k.status IN ('active','rotating');
  RETURN r;
END $$;

-- Custody: the receiving rails it serves (for reconciliation and balances).
CREATE FUNCTION cx_paypal_rails(p_worker text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r jsonb;
BEGIN
  ${WORKER}
  SELECT COALESCE(jsonb_agg(jsonb_build_object('railId', x.rail_id, 'railMode', x.mode, 'credentialId', x.credential_id, 'vaultRef', k.vault_ref,
           'lastSyncAt', (SELECT max(updated_at) FROM fleet_paypal_transactions t WHERE t.rail_id = x.rail_id))), '[]'::jsonb) INTO r
    FROM fleet_payment_rails x JOIN fleet_credential_refs k ON k.credential_id = x.credential_id
   WHERE x.provider = 'paypal' AND x.status = 'active' AND x.mode IN ('live','sandbox') AND k.status IN ('active','rotating');
  RETURN r;
END $$;

CREATE FUNCTION cx_paypal_checkout_by_order(p_worker text, p_order_id text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_paypal_checkouts; r fleet_payment_rails; k fleet_credential_refs;
BEGIN
  ${WORKER}
  SELECT * INTO c FROM fleet_paypal_checkouts WHERE paypal_order_id = p_order_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  SELECT * INTO r FROM fleet_payment_rails WHERE rail_id = c.rail_id;
  SELECT * INTO k FROM fleet_credential_refs WHERE credential_id = r.credential_id;
  RETURN jsonb_build_object('ok', true, 'checkoutId', c.checkout_id, 'status', c.status, 'amountMinor', c.amount_minor, 'currency', c.currency,
    'railId', r.rail_id, 'railMode', r.mode, 'credentialId', r.credential_id, 'vaultRef', k.vault_ref);
END $$;

-- Custody: a checkout's provider-side progress (order created / approved / capture pending / failed).
CREATE FUNCTION cx_paypal_checkout_update(p_worker text, p_checkout uuid, p_status text, p_order_id text, p_approval_url text, p_failure text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_paypal_checkouts;
BEGIN
  ${WORKER}
  SELECT * INTO c FROM fleet_paypal_checkouts WHERE checkout_id = p_checkout FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF c.status = p_status AND c.paypal_order_id IS NOT DISTINCT FROM COALESCE(p_order_id, c.paypal_order_id) THEN RETURN jsonb_build_object('ok', true, 'replay', true); END IF;
  IF p_status NOT IN ('open','approved','capture_pending','failed') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  IF c.status IN ('captured') OR (p_status <> 'failed' AND c.status IN ('failed','cancelled','expired') AND p_status <> 'capture_pending') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE', 'status', c.status);
  END IF;
  UPDATE fleet_paypal_checkouts SET status = p_status,
         paypal_order_id = COALESCE(paypal_order_id, p_order_id),
         approval_url = CASE WHEN p_status = 'open' THEN p_approval_url ELSE approval_url END,
         failure_code = CASE WHEN p_status = 'failed' THEN COALESCE(p_failure, 'provider_failed') ELSE failure_code END,
         opened_at = CASE WHEN p_status = 'open' THEN now() ELSE opened_at END,
         approved_at = CASE WHEN p_status = 'approved' THEN now() ELSE approved_at END,
         closed_at = CASE WHEN p_status = 'failed' THEN now() ELSE closed_at END
   WHERE checkout_id = p_checkout RETURNING * INTO c;
  IF p_status = 'open' THEN PERFORM fleet_event('paypal_checkout_opened', c.agent_id, 'custody', jsonb_build_object('checkoutId', c.checkout_id)); END IF;
  IF p_status = 'failed' THEN PERFORM fleet_event('paypal_checkout_failed', c.agent_id, 'custody', jsonb_build_object('checkoutId', c.checkout_id, 'failure', c.failure_code)); END IF;
  RETURN jsonb_build_object('ok', true, 'status', c.status);
END $$;

-- Custody: a capture of a checkout as PayPal reports it (capture response, verified webhook or Transaction Search).
-- COMPLETED posts the agent's revenue exactly once (claim paypal:capture:<id>), attributed to the checkout's venture,
-- and repays any provider payable first; PENDING only records the capture. A different amount, currency or capture is
-- never posted.
CREATE FUNCTION cx_paypal_capture_record(p_worker text, p_checkout uuid, p_capture_id text, p_status text, p_gross bigint, p_fee bigint, p_currency text, p_evidence text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_paypal_checkouts; v_key text; v_j uuid; v_lines jsonb; v_pay bigint; rep bigint;
BEGIN
  ${WORKER}
  IF p_capture_id IS NULL OR p_capture_id !~ ${PAYPAL_ID} OR p_status NOT IN ('COMPLETED','PENDING') OR p_evidence NOT IN ('capture_response','webhook','transaction_search') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  SELECT * INTO c FROM fleet_paypal_checkouts WHERE checkout_id = p_checkout FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF c.capture_id IS NOT NULL AND c.capture_id <> p_capture_id THEN
    PERFORM fleet_event('paypal_capture_conflict', c.agent_id, 'custody', jsonb_build_object('checkoutId', c.checkout_id, 'recorded', c.capture_id, 'reported', p_capture_id));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PAYPAL_CONFLICT');
  END IF;
  IF c.status = 'captured' THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'journalId', c.journal_id); END IF;
  IF p_currency IS DISTINCT FROM c.currency OR p_gross IS DISTINCT FROM c.amount_minor OR p_fee IS NULL OR p_fee < 0 OR p_fee >= p_gross THEN
    PERFORM fleet_event('paypal_receipt_mismatch', c.agent_id, 'custody', jsonb_build_object('checkoutId', c.checkout_id, 'captureId', p_capture_id,
      'expectedMinor', c.amount_minor, 'reportedMinor', p_gross, 'currency', p_currency));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PAYPAL_AMOUNT_MISMATCH');
  END IF;
  IF p_status = 'PENDING' THEN
    UPDATE fleet_paypal_checkouts SET status = 'capture_pending', capture_id = p_capture_id WHERE checkout_id = c.checkout_id;
    RETURN jsonb_build_object('ok', true, 'status', 'capture_pending');
  END IF;
  v_key := 'paypal:capture:' || p_capture_id;
  IF fleet_claim_taken(v_key) THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ALREADY_CLAIMED'); END IF;
  v_lines := jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(c.agent_id, 'agent_cash'), 'side', 'D', 'amount', p_gross - p_fee),
    jsonb_build_object('account', fleet_ledger_account(c.agent_id, 'agent_revenue'), 'side', 'C', 'amount', p_gross));
  IF p_fee > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(c.agent_id, 'agent_fees'), 'side', 'D', 'amount', p_fee)); END IF;
  v_j := fleet_ledger_post('paypal_receipt', v_key, 'custody:' || p_worker, 'PayPal checkout captured: ' || c.description, 'executor', c.agent_id,
    NULL, NULL, v_key, NULL, now(), v_lines);
  INSERT INTO fleet_revenue_claims (claim_key, claim_kind, journal_id, claimed_by) VALUES (v_key, 'paypal_capture', v_j, 'custody:' || p_worker);
  INSERT INTO fleet_venture_journals (journal_id, venture_id, agent_id, cost_category, attributed_by) VALUES (v_j, c.venture_id, c.agent_id, 'revenue', 'custody');
  UPDATE fleet_paypal_checkouts SET status = 'captured', capture_id = p_capture_id, captured_at = now(), journal_id = v_j WHERE checkout_id = c.checkout_id;
  -- A provider payable (an earlier refund the agent could not cover) is repaid first.
  v_pay := COALESCE((SELECT fleet_ledger_balance(account_id) FROM fleet_ledger_accounts WHERE agent_id = c.agent_id AND class = 'agent_provider_payable'), 0);
  rep := LEAST(v_pay, p_gross - p_fee);
  IF rep > 0 THEN
    PERFORM fleet_ledger_post('paypal_payable_repayment', v_key || ':rp', 'custody:' || p_worker, 'provider payable repaid from a PayPal receipt', 'executor', c.agent_id,
      NULL, NULL, v_key, NULL, now(), jsonb_build_array(
        jsonb_build_object('account', fleet_ledger_account(c.agent_id, 'agent_provider_payable'), 'side', 'D', 'amount', rep),
        jsonb_build_object('account', fleet_ledger_account(c.agent_id, 'agent_cash'), 'side', 'C', 'amount', rep),
        jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', rep),
        jsonb_build_object('account', 'fleet:provider:advances', 'side', 'C', 'amount', rep)));
  END IF;
  PERFORM fleet_event('paypal_receipt_posted', c.agent_id, 'custody', jsonb_build_object('checkoutId', c.checkout_id, 'captureId', p_capture_id,
    'grossMinor', p_gross, 'feeMinor', p_fee, 'evidence', p_evidence, 'payableRepaidMinor', rep));
  RETURN jsonb_build_object('ok', true, 'status', 'captured', 'journalId', v_j, 'netMinor', p_gross - p_fee, 'payableRepaidMinor', rep);
END $$;

-- Custody: money going back to a buyer (refund / reversal) or a dispute / chargeback fee, against a captured checkout.
CREATE FUNCTION cx_paypal_refund_record(p_worker text, p_capture_id text, p_refund_id text, p_kind text, p_amount bigint, p_currency text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_paypal_checkouts; v_key text; v_cash bigint; v_own bigint; v_short bigint; v_lines jsonb; v_j uuid; v_class text;
BEGIN
  ${WORKER}
  IF p_refund_id IS NULL OR p_refund_id !~ '^[A-Za-z0-9-]{5,64}$' OR p_kind NOT IN ('refund','reversal','dispute_fee','chargeback_fee') OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  v_key := 'paypal:' || CASE WHEN p_kind IN ('refund','reversal') THEN 'refund:' ELSE 'fee:' END || p_refund_id;
  IF fleet_claim_taken(v_key) THEN RETURN jsonb_build_object('ok', true, 'replay', true); END IF;
  SELECT * INTO c FROM fleet_paypal_checkouts WHERE capture_id = p_capture_id AND status = 'captured';
  IF NOT FOUND OR p_currency IS DISTINCT FROM c.currency THEN
    PERFORM fleet_event('paypal_refund_unmatched', NULL, 'custody', jsonb_build_object('captureId', p_capture_id, 'refundId', p_refund_id, 'kind', p_kind,
      'amountMinor', p_amount, 'currency', p_currency));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND');
  END IF;
  PERFORM 1 FROM fleet_ledger_accounts WHERE account_id = fleet_ledger_account(c.agent_id, 'agent_cash') FOR UPDATE;
  v_cash := fleet_ledger_balance(fleet_ledger_account(c.agent_id, 'agent_cash'));
  v_own := LEAST(v_cash, p_amount);
  v_short := p_amount - v_own;
  v_class := CASE WHEN p_kind IN ('refund','reversal') THEN 'agent_revenue' ELSE 'agent_fees' END;
  v_lines := jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(c.agent_id, v_class), 'side', 'D', 'amount', p_amount));
  IF v_own > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(c.agent_id, 'agent_cash'), 'side', 'C', 'amount', v_own)); END IF;
  IF v_short > 0 THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account', fleet_ledger_account(c.agent_id, 'agent_provider_payable'), 'side', 'C', 'amount', v_short),
      jsonb_build_object('account', 'fleet:provider:advances', 'side', 'D', 'amount', v_short),
      jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', v_short));
  END IF;
  v_j := fleet_ledger_post('paypal_clawback', v_key, 'custody:' || p_worker, 'PayPal ' || replace(p_kind, '_', ' ') || ': ' || c.description, 'executor', c.agent_id,
    NULL, NULL, v_key, NULL, now(), v_lines);
  INSERT INTO fleet_revenue_claims (claim_key, claim_kind, journal_id, claimed_by) VALUES (v_key, 'paypal_refund', v_j, 'custody:' || p_worker);
  INSERT INTO fleet_venture_journals (journal_id, venture_id, agent_id, cost_category, attributed_by)
    VALUES (v_j, c.venture_id, c.agent_id, CASE WHEN p_kind IN ('refund','reversal') THEN 'refund' ELSE 'processor_fee' END, 'custody');
  PERFORM fleet_event('paypal_clawback_posted', c.agent_id, 'custody', jsonb_build_object('checkoutId', c.checkout_id, 'kind', p_kind, 'amountMinor', p_amount,
    'fromCashMinor', v_own, 'advancedMinor', v_short));
  RETURN jsonb_build_object('ok', true, 'journalId', v_j, 'fromCashMinor', v_own, 'advancedMinor', v_short);
END $$;

-- Custody: one Transaction Search row (upserted by PayPal's key). Attributed to a checkout by its invoice id / custom id.
CREATE FUNCTION cx_paypal_txn_record(p_worker text, p_rail uuid, p_txn jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE t fleet_paypal_transactions; v_checkout uuid; v_custom text; v_invoice text; c fleet_paypal_checkouts;
BEGIN
  ${WORKER}
  IF NOT EXISTS (SELECT 1 FROM fleet_payment_rails WHERE rail_id = p_rail AND provider = 'paypal') OR p_txn IS NULL OR jsonb_typeof(p_txn) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  v_custom := left(p_txn ->> 'customField', 255);
  v_invoice := left(p_txn ->> 'invoiceId', 127);
  v_checkout := CASE WHEN v_custom ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN v_custom::uuid
                     WHEN v_invoice ~ '^fleet:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN substr(v_invoice, 7)::uuid END;
  IF v_checkout IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fleet_paypal_checkouts WHERE checkout_id = v_checkout AND rail_id = p_rail) THEN v_checkout := NULL; END IF;
  INSERT INTO fleet_paypal_transactions (rail_id, transaction_id, event_code, initiated_at, status, amount_minor, fee_minor, currency, invoice_id, custom_field, checkout_id)
    VALUES (p_rail, p_txn ->> 'transactionId', p_txn ->> 'eventCode', (p_txn ->> 'initiatedAt')::timestamptz, p_txn ->> 'status',
            (p_txn ->> 'amountMinor')::bigint, COALESCE((p_txn ->> 'feeMinor')::bigint, 0), p_txn ->> 'currency', v_invoice, v_custom, v_checkout)
  ON CONFLICT (rail_id, transaction_id, event_code, initiated_at) DO UPDATE SET status = EXCLUDED.status, amount_minor = EXCLUDED.amount_minor,
    fee_minor = EXCLUDED.fee_minor, checkout_id = COALESCE(fleet_paypal_transactions.checkout_id, EXCLUDED.checkout_id), updated_at = now()
  RETURNING * INTO t;
  IF t.checkout_id IS NOT NULL THEN SELECT * INTO c FROM fleet_paypal_checkouts WHERE checkout_id = t.checkout_id; END IF;
  RETURN jsonb_build_object('ok', true, 'checkoutId', t.checkout_id,
    'needsCapturePost', t.checkout_id IS NOT NULL AND t.status = 'S' AND t.amount_minor > 0 AND c.status <> 'captured');
END $$;

CREATE FUNCTION cx_paypal_balance_record(p_worker text, p_rail uuid, p_currency text, p_available bigint, p_total bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  ${WORKER}
  IF NOT EXISTS (SELECT 1 FROM fleet_payment_rails WHERE rail_id = p_rail AND provider = 'paypal') OR p_currency !~ '^[A-Z]{3}$' OR p_available IS NULL OR p_total IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  INSERT INTO fleet_paypal_balance_observations (rail_id, currency, available_minor, total_minor) VALUES (p_rail, p_currency, p_available, p_total);
  RETURN jsonb_build_object('ok', true);
END $$;

-- Owner: what an unmatched PayPal transaction was (owner funding / an agent's revenue / not revenue). The posting itself
-- is the existing owner funding or manual revenue command with this transaction's claim key; this only closes the item.
CREATE FUNCTION fleet_admin_paypal_txn_attribute(p_rail uuid, p_txn text, p_event_code text, p_as text, p_ref text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE n integer;
BEGIN
  ${OWNER_ACTOR}
  IF p_as NOT IN ('owner_funding','agent_revenue','not_revenue') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: owner_funding, agent_revenue or not_revenue'; END IF;
  IF p_as <> 'not_revenue' AND NOT fleet_claim_taken(p_ref) AND NOT EXISTS (SELECT 1 FROM fleet_ledger_journal WHERE external_ref = p_ref) THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: record the funding or revenue first and name its reference';
  END IF;
  UPDATE fleet_paypal_transactions SET attributed_as = p_as, attributed_ref = left(p_ref, 200), attributed_by = p_actor, attributed_at = now()
   WHERE rail_id = p_rail AND transaction_id = p_txn AND event_code = p_event_code AND checkout_id IS NULL AND attributed_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no unattributed transaction with that key'; END IF;
  RETURN jsonb_build_object('ok', true, 'rows', n);
END $$;

CREATE FUNCTION fleet_paypal_status() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'readiness', fleet_payments_readiness(),
    'rails', COALESCE((SELECT jsonb_agg(jsonb_build_object('railId', r.rail_id, 'label', r.label, 'mode', r.mode, 'status', r.status, 'capabilities', r.capabilities,
               'readiness', fleet_rail_readiness(r.rail_id),
               'balance', (SELECT jsonb_build_object('currency', b.currency, 'availableMinor', b.available_minor, 'totalMinor', b.total_minor, 'at', b.observed_at)
                           FROM fleet_paypal_balance_observations b WHERE b.rail_id = r.rail_id ORDER BY b.observed_at DESC LIMIT 1)))
             FROM fleet_payment_rails r WHERE r.provider = 'paypal' AND r.status <> 'revoked'), '[]'::jsonb),
    'checkouts', (SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*) AS n FROM fleet_paypal_checkouts GROUP BY status) s),
    'webhooks', (SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*) AS n FROM fleet_paypal_webhook_inbox GROUP BY status) s),
    'unmatched', COALESCE((SELECT jsonb_agg(jsonb_build_object('railId', t.rail_id, 'transactionId', t.transaction_id, 'eventCode', t.event_code, 'at', t.initiated_at,
               'amountMinor', t.amount_minor, 'feeMinor', t.fee_minor, 'currency', t.currency, 'status', t.status) ORDER BY t.initiated_at DESC)
             FROM (SELECT * FROM fleet_paypal_transactions WHERE checkout_id IS NULL AND attributed_at IS NULL ORDER BY initiated_at DESC LIMIT 100) t), '[]'::jsonb))
$$;

-- ═══ 7. Card clearing ═══
CREATE TABLE fleet_card_charges (
  charge_id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id            text        NOT NULL REFERENCES fleet_agents(agent_id),
  merchant            text        NOT NULL CHECK (length(merchant) BETWEEN 2 AND 120),
  origin              text        CHECK (origin ~ '^https://[A-Za-z0-9.-]{3,253}(:[0-9]{2,5})?$'),
  status              text        NOT NULL CHECK (status IN ('held','booked','confirmed','void')),
  source              text        NOT NULL CHECK (source IN ('agent','owner')),
  hold_max_minor      bigint      CHECK (hold_max_minor > 0),
  amount_minor        bigint      CHECK (amount_minor > 0),
  agent_part_minor    bigint      NOT NULL DEFAULT 0 CHECK (agent_part_minor >= 0),
  treasury_part_minor bigint      NOT NULL DEFAULT 0 CHECK (treasury_part_minor >= 0),
  statement_ref       text        CHECK (length(statement_ref) BETWEEN 2 AND 120),
  created_at          timestamptz NOT NULL DEFAULT now(),
  declare_by          timestamptz,
  booked_at           timestamptz,
  confirmed_at        timestamptz,
  CHECK (status = 'held' OR status = 'void' OR (amount_minor IS NOT NULL AND agent_part_minor + treasury_part_minor = amount_minor))
);
CREATE INDEX fleet_card_charges_agent ON fleet_card_charges (agent_id, created_at DESC);
CREATE TRIGGER fleet_card_charges_no_delete BEFORE DELETE ON fleet_card_charges FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_card_charges_no_truncate BEFORE TRUNCATE ON fleet_card_charges FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_card_repayments (
  repayment_id uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  amount_minor bigint      NOT NULL CHECK (amount_minor > 0),
  reference    text        NOT NULL UNIQUE CHECK (length(reference) BETWEEN 2 AND 120),
  journal_id   uuid        NOT NULL REFERENCES fleet_ledger_journal(journal_id),
  recorded_by  text        NOT NULL,
  recorded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_card_repayments_no_change BEFORE UPDATE OR DELETE ON fleet_card_repayments FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_card_repayments_no_truncate BEFORE TRUNCATE ON fleet_card_repayments FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_card_receipts (
  receipt_id      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        text        NOT NULL REFERENCES fleet_agents(agent_id),
  kind            text        NOT NULL CHECK (kind IN ('revenue','refund')),
  amount_minor    bigint      NOT NULL CHECK (amount_minor > 0),
  reference       text        NOT NULL UNIQUE CHECK (length(reference) BETWEEN 2 AND 120),
  note            text        CHECK (length(note) <= 300),
  suggested_sweep_minor bigint NOT NULL DEFAULT 0 CHECK (suggested_sweep_minor >= 0),
  status          text        NOT NULL DEFAULT 'invoiced' CHECK (status IN ('invoiced','returned','withdrawn')),
  sweep_minor     bigint      CHECK (sweep_minor >= 0),
  return_reference text       CHECK (length(return_reference) BETWEEN 2 AND 120),
  journal_id      uuid        NOT NULL REFERENCES fleet_ledger_journal(journal_id),
  resolve_journal_id uuid     REFERENCES fleet_ledger_journal(journal_id),
  recorded_by     text        NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  resolved_by     text,
  resolved_at     timestamptz,
  CHECK ((status = 'invoiced') = (resolved_at IS NULL))
);
CREATE FUNCTION fleet_card_receipts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'invoiced' THEN RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: a resolved card receipt is history'; END IF;
  IF NEW.receipt_id <> OLD.receipt_id OR NEW.agent_id <> OLD.agent_id OR NEW.kind <> OLD.kind OR NEW.amount_minor <> OLD.amount_minor
     OR NEW.reference <> OLD.reference OR NEW.journal_id <> OLD.journal_id OR NEW.recorded_at <> OLD.recorded_at THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a card receipt''s facts are fixed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_card_receipts_guard BEFORE UPDATE OR DELETE ON fleet_card_receipts FOR EACH ROW EXECUTE FUNCTION fleet_card_receipts_guard();
CREATE TRIGGER fleet_card_receipts_no_truncate BEFORE TRUNCATE ON fleet_card_receipts FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- Book a charge at an amount: the agent's spendable cash first, the treasury for any shortfall; the whole amount moves into
-- the card reserve against the card liability. p_delta is the change from what is already booked (adjustments).
CREATE FUNCTION fleet_card_charge_post(p_charge uuid, p_amount bigint, p_idem text, p_source text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE ch fleet_card_charges; e jsonb; v_avail bigint; v_agent bigint; v_tre bigint; d_agent bigint; d_tre bigint; d bigint; v_lines jsonb := '[]'::jsonb;
        v_kind text; v_j uuid;
  -- one signed line pair (D/C swapped for a negative amount)
BEGIN
  SELECT * INTO ch FROM fleet_card_charges WHERE charge_id = p_charge FOR UPDATE;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a positive amount'; END IF;
  PERFORM 1 FROM fleet_ledger_accounts WHERE account_id = fleet_ledger_account(ch.agent_id, 'agent_cash') FOR UPDATE;
  d := p_amount - COALESCE(ch.amount_minor, 0);
  IF d = 0 THEN RETURN jsonb_build_object('ok', true, 'unchanged', true); END IF;
  IF d > 0 THEN
    e := fleet_agent_economics(ch.agent_id);
    v_avail := GREATEST(0, LEAST((e ->> 'cash')::bigint, (e ->> 'survivalEquity')::bigint));
    d_agent := LEAST(d, v_avail);
    d_tre := d - d_agent;
  ELSE
    -- A reduction gives back to the treasury share first, then to the agent.
    d_tre := -LEAST(-d, ch.treasury_part_minor);
    d_agent := d - d_tre;
  END IF;
  v_agent := ch.agent_part_minor + d_agent;
  v_tre := ch.treasury_part_minor + d_tre;
  IF d_agent > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(ch.agent_id, 'agent_expense'), 'side', 'D', 'amount', d_agent),
                                                                 jsonb_build_object('account', fleet_ledger_account(ch.agent_id, 'agent_cash'), 'side', 'C', 'amount', d_agent));
  ELSIF d_agent < 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(ch.agent_id, 'agent_cash'), 'side', 'D', 'amount', -d_agent),
                                                                    jsonb_build_object('account', fleet_ledger_account(ch.agent_id, 'agent_expense'), 'side', 'C', 'amount', -d_agent));
  END IF;
  IF d_tre > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'fleet:expense', 'side', 'D', 'amount', d_tre),
                                                               jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', d_tre));
  ELSIF d_tre < 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', -d_tre),
                                                                  jsonb_build_object('account', 'fleet:expense', 'side', 'C', 'amount', -d_tre));
  END IF;
  IF d > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'fleet:card:reserve', 'side', 'D', 'amount', d),
                                                           jsonb_build_object('account', 'fleet:card:payable', 'side', 'C', 'amount', d));
  ELSE v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'fleet:card:payable', 'side', 'D', 'amount', -d),
                                                jsonb_build_object('account', 'fleet:card:reserve', 'side', 'C', 'amount', -d));
  END IF;
  v_kind := CASE WHEN ch.amount_minor IS NULL THEN 'card_charge' ELSE 'card_charge_adjust' END;
  v_j := fleet_ledger_post(v_kind, p_idem, p_actor, 'card charge: ' || ch.merchant, p_source, ch.agent_id, NULL, NULL, p_idem, NULL, now(), v_lines);
  UPDATE fleet_card_charges SET amount_minor = p_amount, agent_part_minor = v_agent, treasury_part_minor = v_tre,
         status = CASE WHEN status = 'held' THEN 'booked' ELSE status END, booked_at = COALESCE(booked_at, now())
   WHERE charge_id = p_charge;
  RETURN jsonb_build_object('ok', true, 'journalId', v_j, 'amountMinor', p_amount, 'agentPartMinor', v_agent, 'treasuryPartMinor', v_tre);
END $$;

-- Owner: a card charge seen on the statement (an agent purchase recorded after the fact).
CREATE FUNCTION fleet_admin_card_charge_record(p_agent text, p_amount bigint, p_merchant text, p_statement_ref text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE ch fleet_card_charges; r jsonb;
BEGIN
  ${OWNER_ACTOR}
  IF NOT EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = p_agent) THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: unknown agent'; END IF;
  IF p_statement_ref IS NULL OR length(trim(p_statement_ref)) < 2 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the statement reference'; END IF;
  IF EXISTS (SELECT 1 FROM fleet_card_charges WHERE statement_ref = trim(p_statement_ref)) THEN RAISE EXCEPTION 'FLEET_ALREADY_CLAIMED: that statement line is recorded'; END IF;
  INSERT INTO fleet_card_charges (agent_id, merchant, status, source, statement_ref)
    VALUES (p_agent, left(fleet_scrub(p_merchant), 120), 'held', 'owner', left(trim(p_statement_ref), 120)) RETURNING * INTO ch;
  r := fleet_card_charge_post(ch.charge_id, p_amount, 'card:' || ch.charge_id || ':book', 'owner', p_actor);
  UPDATE fleet_card_charges SET status = 'confirmed', confirmed_at = now() WHERE charge_id = ch.charge_id;
  PERFORM fleet_event('card_charge_booked', p_agent, p_actor, jsonb_build_object('chargeId', ch.charge_id, 'amountMinor', p_amount,
    'agentPartMinor', r ->> 'agentPartMinor', 'treasuryPartMinor', r ->> 'treasuryPartMinor', 'merchant', left(fleet_scrub(p_merchant), 120)));
  RETURN r || jsonb_build_object('chargeId', ch.charge_id);
END $$;

-- Owner: confirm a booked charge at its statement amount (adjusting the booking by the difference).
CREATE FUNCTION fleet_admin_card_charge_confirm(p_charge uuid, p_amount bigint, p_statement_ref text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE ch fleet_card_charges; r jsonb;
BEGIN
  ${OWNER_ACTOR}
  SELECT * INTO ch FROM fleet_card_charges WHERE charge_id = p_charge FOR UPDATE;
  IF NOT FOUND OR ch.status NOT IN ('booked','confirmed') THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: only a booked charge is confirmed'; END IF;
  IF p_statement_ref IS NULL OR length(trim(p_statement_ref)) < 2 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the statement reference'; END IF;
  r := fleet_card_charge_post(p_charge, p_amount, 'card:' || p_charge || ':confirm:' || md5(trim(p_statement_ref) || ':' || p_amount), 'owner', p_actor);
  UPDATE fleet_card_charges SET status = 'confirmed', confirmed_at = now(), statement_ref = left(trim(p_statement_ref), 120) WHERE charge_id = p_charge;
  PERFORM fleet_event('card_charge_confirmed', ch.agent_id, p_actor, jsonb_build_object('chargeId', p_charge, 'amountMinor', p_amount, 'previousMinor', ch.amount_minor));
  RETURN r || jsonb_build_object('chargeId', p_charge, 'status', 'confirmed');
END $$;

-- Owner: the card was repaid from the treasury PayPal account (PayPal offers no API for this; the owner does it and records it).
CREATE FUNCTION fleet_admin_card_repayment_record(p_amount bigint, p_reference text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_j uuid; v_out bigint; v_id uuid;
BEGIN
  ${OWNER_ACTOR}
  IF p_reference IS NULL OR length(trim(p_reference)) < 2 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the repayment reference'; END IF;
  IF EXISTS (SELECT 1 FROM fleet_card_repayments WHERE reference = trim(p_reference)) THEN
    RETURN jsonb_build_object('ok', true, 'replay', true);
  END IF;
  PERFORM 1 FROM fleet_ledger_accounts WHERE account_id = 'fleet:card:payable' FOR UPDATE;
  v_out := fleet_ledger_balance('fleet:card:payable');
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > v_out THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: 1..% is outstanding on the card', v_out; END IF;
  v_j := fleet_ledger_post('card_repayment', 'card-repay:' || trim(p_reference), p_actor, 'card repaid from the treasury account', 'owner', NULL, NULL, NULL,
    'card-repay:' || left(trim(p_reference), 100), NULL, now(), jsonb_build_array(
      jsonb_build_object('account', 'fleet:card:payable', 'side', 'D', 'amount', p_amount),
      jsonb_build_object('account', 'fleet:card:reserve', 'side', 'C', 'amount', p_amount)));
  INSERT INTO fleet_card_repayments (amount_minor, reference, journal_id, recorded_by) VALUES (p_amount, left(trim(p_reference), 120), v_j, p_actor) RETURNING repayment_id INTO v_id;
  PERFORM fleet_event('card_repayment_recorded', NULL, p_actor, jsonb_build_object('repaymentId', v_id, 'amountMinor', p_amount, 'outstandingMinor', v_out - p_amount));
  RETURN jsonb_build_object('ok', true, 'repaymentId', v_id, 'journalId', v_j, 'outstandingMinor', v_out - p_amount);
END $$;

-- Owner: money paid to the card on an agent's behalf (its sale, or a merchant refund of a card charge) — an invoice for the
-- owner to return to the treasury (minus the swept share) or keep as a withdrawal.
CREATE FUNCTION fleet_admin_card_receipt_record(p_agent text, p_amount bigint, p_kind text, p_reference text, p_note text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_j uuid; v_key text; v_id uuid; s jsonb; v_sugg bigint := 0; v_exp bigint; v_lines jsonb;
BEGIN
  ${OWNER_ACTOR}
  IF NOT EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = p_agent) THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: unknown agent'; END IF;
  IF p_kind NOT IN ('revenue','refund') OR p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: kind revenue|refund and a positive amount'; END IF;
  IF p_reference IS NULL OR length(trim(p_reference)) < 2 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the card statement reference'; END IF;
  v_key := 'card:receipt:' || regexp_replace(left(trim(p_reference), 100), '[^A-Za-z0-9._:@/=-]', '_', 'g');
  IF fleet_claim_taken(v_key) THEN RAISE EXCEPTION 'FLEET_ALREADY_CLAIMED: that card receipt is recorded'; END IF;
  -- A refund reduces the agent's expenses (never below zero; anything beyond what it spent is income).
  v_exp := CASE WHEN p_kind = 'refund' THEN LEAST(p_amount, fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_expense'))) ELSE 0 END;
  v_lines := jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_card_receivable'), 'side', 'D', 'amount', p_amount));
  IF v_exp > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_expense'), 'side', 'C', 'amount', v_exp)); END IF;
  IF p_amount - v_exp > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_revenue'), 'side', 'C', 'amount', p_amount - v_exp)); END IF;
  v_j := fleet_ledger_post('card_receipt', v_key, p_actor, 'money paid to the owner''s card for the agent', 'owner', p_agent, NULL, NULL, v_key, NULL, now(), v_lines);
  INSERT INTO fleet_revenue_claims (claim_key, claim_kind, journal_id, claimed_by) VALUES (v_key, 'card_receipt', v_j, p_actor);
  IF p_kind = 'revenue' THEN
    -- The suggested owner share: the agent's current dynamic sweep rate on what is profit (never more than net profit).
    s := fleet_sweep_compute(p_agent);
    v_sugg := LEAST(p_amount, GREATEST(0, (s ->> 'afterTaxUncontributedProfitMinor')::bigint)) * GREATEST(0, (s ->> 'rateBp')::integer) / 10000;
  END IF;
  INSERT INTO fleet_card_receipts (agent_id, kind, amount_minor, reference, note, suggested_sweep_minor, journal_id, recorded_by)
    VALUES (p_agent, p_kind, p_amount, left(trim(p_reference), 120), left(fleet_scrub(p_note), 300), v_sugg, v_j, p_actor) RETURNING receipt_id INTO v_id;
  PERFORM fleet_event('card_receipt_recorded', p_agent, p_actor, jsonb_build_object('receiptId', v_id, 'kind', p_kind, 'amountMinor', p_amount,
    'returnMinor', p_amount - v_sugg, 'suggestedSweepMinor', v_sugg));
  RETURN jsonb_build_object('ok', true, 'receiptId', v_id, 'journalId', v_j, 'invoice', jsonb_build_object('amountMinor', p_amount, 'suggestedSweepMinor', v_sugg,
    'returnMinor', p_amount - v_sugg));
END $$;

-- Owner: resolve a card receipt — returned to the treasury (minus the sweep share kept by the owner) or kept entirely.
CREATE FUNCTION fleet_admin_card_receipt_resolve(p_receipt uuid, p_resolution text, p_sweep bigint, p_reference text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE rc fleet_card_receipts; v_j uuid; v_s bigint; v_lines jsonb; s jsonb; v_cap bigint;
BEGIN
  ${OWNER_ACTOR}
  SELECT * INTO rc FROM fleet_card_receipts WHERE receipt_id = p_receipt FOR UPDATE;
  IF NOT FOUND OR rc.status <> 'invoiced' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: not an open card invoice'; END IF;
  IF p_resolution = 'return' THEN
    IF p_reference IS NULL OR length(trim(p_reference)) < 2 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the transfer reference of the returned money'; END IF;
    v_s := COALESCE(p_sweep, rc.suggested_sweep_minor);
    IF rc.kind = 'refund' THEN v_cap := 0;
    ELSE s := fleet_sweep_compute(rc.agent_id); v_cap := LEAST(rc.amount_minor, GREATEST(0, (s ->> 'afterTaxUncontributedProfitMinor')::bigint)); END IF;
    IF v_s < 0 OR v_s > v_cap THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the swept share is 0..% (net profit only)', v_cap; END IF;
    v_lines := jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(rc.agent_id, 'agent_card_receivable'), 'side', 'C', 'amount', rc.amount_minor));
    IF rc.amount_minor - v_s > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(rc.agent_id, 'agent_cash'), 'side', 'D', 'amount', rc.amount_minor - v_s)); END IF;
    IF v_s > 0 THEN v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account', fleet_ledger_account(rc.agent_id, 'agent_contributions'), 'side', 'D', 'amount', v_s),
      jsonb_build_object('account', 'fleet:owner:withdrawals', 'side', 'D', 'amount', v_s),
      jsonb_build_object('account', 'fleet:profit', 'side', 'C', 'amount', v_s)); END IF;
    v_j := fleet_ledger_post('card_receipt_return', 'card-return:' || rc.receipt_id, p_actor, 'card money returned to the treasury', 'owner', rc.agent_id, NULL, NULL,
      'card-return:' || left(trim(p_reference), 100), NULL, now(), v_lines);
    UPDATE fleet_card_receipts SET status = 'returned', sweep_minor = v_s, return_reference = left(trim(p_reference), 120), resolve_journal_id = v_j,
           resolved_by = p_actor, resolved_at = now() WHERE receipt_id = p_receipt;
    PERFORM fleet_event('card_receipt_returned', rc.agent_id, p_actor, jsonb_build_object('receiptId', p_receipt, 'returnedMinor', rc.amount_minor - v_s, 'sweepMinor', v_s));
    RETURN jsonb_build_object('ok', true, 'status', 'returned', 'returnedMinor', rc.amount_minor - v_s, 'sweepMinor', v_s, 'journalId', v_j);
  ELSIF p_resolution = 'withdrawal' THEN
    v_j := fleet_ledger_post('card_receipt_withdrawal', 'card-withdraw:' || rc.receipt_id, p_actor, 'card money kept by the owner (withdrawal)', 'owner', rc.agent_id, NULL, NULL,
      'card-withdraw:' || rc.receipt_id, NULL, now(), jsonb_build_array(
        jsonb_build_object('account', fleet_ledger_account(rc.agent_id, 'agent_contributions'), 'side', 'D', 'amount', rc.amount_minor),
        jsonb_build_object('account', fleet_ledger_account(rc.agent_id, 'agent_card_receivable'), 'side', 'C', 'amount', rc.amount_minor),
        jsonb_build_object('account', 'fleet:owner:withdrawals', 'side', 'D', 'amount', rc.amount_minor),
        jsonb_build_object('account', 'fleet:profit', 'side', 'C', 'amount', rc.amount_minor)));
    UPDATE fleet_card_receipts SET status = 'withdrawn', sweep_minor = rc.amount_minor, resolve_journal_id = v_j, resolved_by = p_actor, resolved_at = now()
     WHERE receipt_id = p_receipt;
    PERFORM fleet_event('card_receipt_withdrawn', rc.agent_id, p_actor, jsonb_build_object('receiptId', p_receipt, 'amountMinor', rc.amount_minor));
    RETURN jsonb_build_object('ok', true, 'status', 'withdrawn', 'withdrawnMinor', rc.amount_minor, 'journalId', v_j);
  END IF;
  RAISE EXCEPTION 'FLEET_BAD_REQUEST: resolution is return or withdrawal';
END $$;

CREATE FUNCTION fleet_card_clearing() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'outstandingMinor', fleet_ledger_balance('fleet:card:payable'),
    'reserveMinor', fleet_ledger_balance('fleet:card:reserve'),
    'charges', COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('chargeId', c.charge_id, 'agentId', c.agent_id, 'merchant', c.merchant, 'origin', c.origin,
        'status', c.status, 'source', c.source, 'amountMinor', c.amount_minor, 'holdMaxMinor', c.hold_max_minor, 'agentPartMinor', c.agent_part_minor,
        'treasuryPartMinor', c.treasury_part_minor, 'statementRef', c.statement_ref, 'at', c.created_at, 'declareBy', c.declare_by)) ORDER BY c.created_at DESC)
        FROM (SELECT * FROM fleet_card_charges ORDER BY created_at DESC LIMIT 200) c), '[]'::jsonb),
    'repayments', COALESCE((SELECT jsonb_agg(jsonb_build_object('repaymentId', r.repayment_id, 'amountMinor', r.amount_minor, 'reference', r.reference, 'at', r.recorded_at)
        ORDER BY r.recorded_at DESC) FROM (SELECT * FROM fleet_card_repayments ORDER BY recorded_at DESC LIMIT 100) r), '[]'::jsonb),
    'invoices', COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('receiptId', x.receipt_id, 'agentId', x.agent_id, 'kind', x.kind, 'amountMinor', x.amount_minor,
        'reference', x.reference, 'note', x.note, 'status', x.status, 'suggestedSweepMinor', x.suggested_sweep_minor, 'returnMinor', x.amount_minor - x.suggested_sweep_minor,
        'sweepMinor', x.sweep_minor, 'at', x.recorded_at, 'resolvedAt', x.resolved_at)) ORDER BY (x.status = 'invoiced') DESC, x.recorded_at DESC)
        FROM (SELECT * FROM fleet_card_receipts ORDER BY recorded_at DESC LIMIT 200) x), '[]'::jsonb))
$$;

-- ═══ 8. Treasury transactions and health ═══
-- One row per journal: its effect on real money (in / out / internal), fees, revenue, contribution, the card liability.
CREATE FUNCTION fleet_treasury_transactions(p_agent text, p_limit integer, p_before bigint, p_direction text) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  WITH j AS (
    SELECT * FROM fleet_ledger_journal
     WHERE (p_agent IS NULL OR agent_id = p_agent) AND (p_before IS NULL OR seq < p_before)
     ORDER BY seq DESC LIMIT 5000),
  t AS (
    SELECT j.seq, j.journal_id, j.kind, j.agent_id, j.occurred_at, j.external_ref, j.reason, j.source,
      COALESCE(sum(CASE WHEN a.class IN (${q(CASH_CLASSES)}) THEN CASE p.side WHEN 'D' THEN p.amount_cents ELSE -p.amount_cents END END), 0) AS cash,
      COALESCE(sum(CASE WHEN a.class = 'agent_fees' THEN CASE p.side WHEN 'D' THEN p.amount_cents ELSE -p.amount_cents END END), 0) AS fees,
      COALESCE(sum(CASE WHEN a.class = 'agent_revenue' THEN CASE p.side WHEN 'C' THEN p.amount_cents ELSE -p.amount_cents END END), 0) AS revenue,
      COALESCE(sum(CASE WHEN a.class = 'agent_contributions' THEN CASE p.side WHEN 'D' THEN p.amount_cents ELSE -p.amount_cents END END), 0) AS contribution,
      COALESCE(sum(CASE WHEN a.class = 'card_payable' THEN CASE p.side WHEN 'C' THEN p.amount_cents ELSE -p.amount_cents END END), 0) AS card
    FROM j JOIN fleet_ledger_postings p ON p.journal_id = j.journal_id JOIN fleet_ledger_accounts a ON a.account_id = p.account_id
    GROUP BY j.seq, j.journal_id, j.kind, j.agent_id, j.occurred_at, j.external_ref, j.reason, j.source),
  f AS (
    SELECT *, CASE WHEN cash > 0 THEN 'in' WHEN cash < 0 THEN 'out' ELSE 'internal' END AS direction FROM t),
  page AS (
    SELECT * FROM f WHERE p_direction IS NULL OR direction = p_direction ORDER BY seq DESC LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500))
  SELECT jsonb_build_object('items', COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('seq', seq, 'journalId', journal_id, 'at', occurred_at, 'kind', kind,
      'agentId', agent_id, 'agentName', (SELECT name FROM fleet_agents x WHERE x.agent_id = page.agent_id), 'direction', direction, 'amountMinor', abs(cash),
      'feesMinor', NULLIF(fees, 0), 'revenueMinor', NULLIF(revenue, 0), 'contributionMinor', NULLIF(contribution, 0), 'cardLiabilityMinor', NULLIF(card, 0),
      'reference', external_ref, 'reason', reason, 'source', source)) ORDER BY seq DESC) FROM page), '[]'::jsonb),
    'nextBeforeSeq', (SELECT min(seq) FROM page),
    'agentId', p_agent)
$$;

CREATE FUNCTION fleet_treasury_health() RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_in bigint; v_out bigint; v_cash bigint; v_burn bigint; r jsonb;
BEGIN
  SELECT COALESCE(sum(fleet_ledger_balance(account_id)), 0) INTO v_cash FROM fleet_ledger_accounts WHERE class IN (${q(CASH_CLASSES)});
  SELECT COALESCE(sum(CASE WHEN x > 0 THEN x END), 0), COALESCE(-sum(CASE WHEN x < 0 THEN x END), 0) INTO v_in, v_out
    FROM (SELECT sum(CASE p.side WHEN 'D' THEN p.amount_cents ELSE -p.amount_cents END) AS x
            FROM fleet_ledger_journal j JOIN fleet_ledger_postings p ON p.journal_id = j.journal_id JOIN fleet_ledger_accounts a ON a.account_id = p.account_id
           WHERE j.occurred_at > now() - interval '30 days' AND a.class IN (${q(CASH_CLASSES)}) GROUP BY j.journal_id) s;
  v_burn := GREATEST(0, v_out - v_in);
  r := jsonb_build_object(
    'cashMinor', v_cash,
    'partitions', jsonb_build_object(
      'treasuryUnallocatedMinor', fleet_ledger_balance('fleet:treasury:unallocated'),
      'agentsMinor', (SELECT COALESCE(sum(fleet_ledger_balance(account_id)), 0) FROM fleet_ledger_accounts WHERE class IN ('agent_cash','agent_envelope_cash')),
      'reservedMinor', (SELECT COALESCE(sum(fleet_ledger_balance(account_id)), 0) FROM fleet_ledger_accounts WHERE class IN ('agent_reserved','custody_clearing')),
      'otherMinor', (SELECT COALESCE(sum(fleet_ledger_balance(account_id)), 0) FROM fleet_ledger_accounts
                      WHERE class IN ('agent_project_escrow','agent_tax_reserve','fleet_operating_pool') OR (class = 'treasury_cash' AND account_id <> 'fleet:treasury:unallocated')),
      'cardReserveMinor', fleet_ledger_balance('fleet:card:reserve')),
    'cardOutstandingMinor', fleet_ledger_balance('fleet:card:payable'),
    'cardInvoicesOpen', (SELECT count(*) FROM fleet_card_receipts WHERE status = 'invoiced'),
    'cardInvoicesOpenMinor', (SELECT COALESCE(sum(amount_minor), 0) FROM fleet_card_receipts WHERE status = 'invoiced'),
    'providerSuspenseMinor', COALESCE(fleet_ledger_balance('fleet:provider:suspense'), 0),
    'providerAdvancesMinor', COALESCE(fleet_ledger_balance('fleet:provider:advances'), 0),
    'flow30d', jsonb_build_object('inMinor', v_in, 'outMinor', v_out, 'netMinor', v_in - v_out),
    'runwayDays', CASE WHEN v_burn > 0 THEN (v_cash * 30 / v_burn) END,
    'lifetimeContributionMinor', fleet_ledger_balance('fleet:profit'),
    'ownerWithdrawalsMinor', fleet_ledger_balance('fleet:owner:withdrawals'),
    'contributions', COALESCE((SELECT jsonb_agg(jsonb_build_object('agentId', a.agent_id, 'name', a.name, 'status', a.status,
        'cashMinor', fleet_ledger_balance(fleet_ledger_account(a.agent_id, 'agent_cash')),
        'revenueMinor', fleet_ledger_balance(fleet_ledger_account(a.agent_id, 'agent_revenue')),
        'contributionMinor', fleet_ledger_balance(fleet_ledger_account(a.agent_id, 'agent_contributions'))) ORDER BY a.created_at)
        FROM fleet_agents a WHERE EXISTS (SELECT 1 FROM fleet_ledger_accounts x WHERE x.agent_id = a.agent_id)), '[]'::jsonb),
    'paypal', jsonb_build_object('readiness', fleet_payments_readiness(),
        'latestBalance', (SELECT jsonb_build_object('currency', b.currency, 'availableMinor', b.available_minor, 'totalMinor', b.total_minor, 'at', b.observed_at)
                          FROM fleet_paypal_balance_observations b ORDER BY b.observed_at DESC LIMIT 1),
        'unmatched', (SELECT count(*) FROM fleet_paypal_transactions WHERE checkout_id IS NULL AND amount_minor > 0 AND attributed_at IS NULL)),
    'custody', jsonb_build_object('active', EXISTS (SELECT 1 FROM fleet_custody_activation_live() a WHERE a.activation_id IS NOT NULL)));
  RETURN r;
END $$;

-- ═══ 9. Agent operations, dashboard, routing, reconciliation ═══
${DISPATCH}

${DASH_CALL}

${EVENT_ROUTE}

${RECONCILE}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

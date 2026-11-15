/**
 * Schema v66 — backing the existing ledger capital with real money (owner, 2026-10-12).
 *
 * The first two agents were born on owner capital recorded with no money behind it (`owner-authorized-virtual:` owner
 * funding, 2 × £100). Their AI costs since then were paid in reality from the owner's prepaid provider credit (USD, outside
 * the GBP ledger, v21), so every such charge lowered the cash in the books without touching the treasury. The real money the
 * treasury must hold to back the books is therefore
 *
 *   unbacked = virtual owner capital − provider-paid charges (inference, owner conversation, Fleet Control reviews) − backed
 *
 * (never below zero). Recording an owner deposit as ordinary owner funding would credit that capital a second time. A
 * BACKING records a real PayPal deposit against the existing capital instead: it posts no ledger credit for the backed part
 * (the money is already in the books), only the part beyond what is unbacked becomes ordinary owner funding (one journal,
 * the same claim key), and the PayPal transaction is closed as `capital_backing`. One backing per transaction; the
 * transaction's key can then never be recorded as owner funding or revenue (fleet_claim_taken). Owner-only, with the
 * dashboard's step-up.
 *
 * `fleet_capital_backing()` reports the reconciliation: virtual capital, provider-paid charges, backed, unbacked, the cash in
 * the books, the latest verified PayPal balance and the difference between them. Nothing here moves money, changes a
 * budget, a flag or an agent.
 */
import { V46_SQL } from "./migrations-phase46.js";
import { V65_SQL } from "./migrations-phase65.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));
const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

/** Charge kinds paid in reality from the owner's prepaid provider credit (USD, outside the ledger), not from the treasury. */
export const PROVIDER_PAID_KINDS = ["inference_charge", "owner_conversation_charge", "spend_review_charge", "knowledge_review_charge"] as const;
/** Ledger classes whose money is held in the PayPal treasury (the cross-check against the verified balance). */
export const TREASURY_HELD_CLASSES = ["agent_cash", "agent_reserved", "agent_envelope_cash", "agent_project_escrow", "agent_tax_reserve",
  "treasury_cash", "card_cash_reserve", "custody_clearing", "fleet_operating_pool"] as const;
export const VIRTUAL_FUNDING_PREFIX = "owner-authorized-virtual:";
export const EVENT_ROUTES_V66 = Object.freeze({ P3_SUMMARY: ["capital_backed"] });
export const DASHBOARD_READ_OPS_V66 = ["capital_backing"] as const;
export const DASHBOARD_SENSITIVE_OPS_V66 = ["capital_back"] as const;

const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');`;

// A backed PayPal transaction's key counts as claimed: it can never also be recorded as owner funding or revenue.
const CLAIM_TAKEN = restate(V46_SQL, "fleet_claim_taken", [
  [`  SELECT p_key IS NOT NULL AND EXISTS (SELECT 1 FROM fleet_revenue_claims WHERE claim_key = p_key)`,
   `  SELECT p_key IS NOT NULL AND (EXISTS (SELECT 1 FROM fleet_revenue_claims WHERE claim_key = p_key)
     OR EXISTS (SELECT 1 FROM fleet_capital_backings WHERE claim_key = p_key))`],
]);

const DASH_CALL = restate(V65_SQL, "dash_call", [
  [`'order_refund',`, `'order_refund',${q(DASHBOARD_SENSITIVE_OPS_V66)},`],
  [`'customer_orders','paypal_disputes','spend_reviews',`, `'customer_orders','paypal_disputes','spend_reviews',${q(DASHBOARD_READ_OPS_V66)},`],
  [`      WHEN 'business_folders' THEN fleet_admin_business_folders(a ->> 'agentId')`, `      WHEN 'business_folders' THEN fleet_admin_business_folders(a ->> 'agentId')
      -- v66: backing the existing capital with a real PayPal deposit (no second credit), and its reconciliation.
      WHEN 'capital_backing' THEN fleet_capital_backing()
      WHEN 'capital_back' THEN fleet_admin_capital_back((a ->> 'railId')::uuid, a ->> 'transactionId', a ->> 'eventCode', 'operator:owner')`],
]);
const EVENT_ROUTE = restate(V65_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V66) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
]);

export const V66_SQL = `
CREATE TABLE fleet_capital_backings (
  backing_id        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_key         text        NOT NULL UNIQUE CHECK (claim_key ~ '^paypal:txn:[A-Z0-9]{5,40}$'),
  rail_id           uuid        NOT NULL REFERENCES fleet_payment_rails(rail_id),
  transaction_id    text        NOT NULL,
  event_code        text        NOT NULL,
  net_minor         bigint      NOT NULL CHECK (net_minor > 0),
  backed_minor      bigint      NOT NULL CHECK (backed_minor > 0),
  excess_minor      bigint      NOT NULL CHECK (excess_minor >= 0),
  excess_journal_id uuid        REFERENCES fleet_ledger_journal(journal_id),
  unbacked_before   bigint      NOT NULL CHECK (unbacked_before > 0),
  recorded_by       text        NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rail_id, transaction_id, event_code),
  CHECK (backed_minor + excess_minor = net_minor),
  CHECK (backed_minor <= unbacked_before),
  CHECK ((excess_minor > 0) = (excess_journal_id IS NOT NULL))
);
CREATE TRIGGER fleet_capital_backings_no_change BEFORE UPDATE OR DELETE ON fleet_capital_backings FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_capital_backings_no_truncate BEFORE TRUNCATE ON fleet_capital_backings FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

ALTER TABLE fleet_paypal_transactions DROP CONSTRAINT fleet_paypal_transactions_attributed_as_check;
ALTER TABLE fleet_paypal_transactions ADD CONSTRAINT fleet_paypal_transactions_attributed_as_check
  CHECK (attributed_as IN ('owner_funding','agent_revenue','not_revenue','provider_payout','capital_backing'));

${CLAIM_TAKEN}

CREATE FUNCTION fleet_capital_backing() RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_virtual bigint; v_paid bigint; v_backed bigint; v_unbacked bigint; v_books bigint; b fleet_paypal_balance_observations; v_ccy text;
BEGIN
  SELECT accounting_currency INTO v_ccy FROM fleet_economic_model WHERE id = 1;
  SELECT COALESCE(sum(p.amount_cents), 0) INTO v_virtual FROM fleet_ledger_journal j JOIN fleet_ledger_postings p ON p.journal_id = j.journal_id
   WHERE j.kind = 'owner_funding' AND j.external_ref LIKE '${VIRTUAL_FUNDING_PREFIX}%' AND p.account_id = 'fleet:owner:capital' AND p.side = 'C';
  SELECT COALESCE(sum(p.amount_cents), 0) INTO v_paid FROM fleet_ledger_journal j JOIN fleet_ledger_postings p ON p.journal_id = j.journal_id
    JOIN fleet_ledger_accounts a ON a.account_id = p.account_id
   WHERE j.kind IN (${q(PROVIDER_PAID_KINDS)}) AND p.side = 'C' AND a.class IN (${q(TREASURY_HELD_CLASSES)});
  SELECT COALESCE(sum(backed_minor), 0) INTO v_backed FROM fleet_capital_backings;
  v_unbacked := GREATEST(v_virtual - v_paid - v_backed, 0);
  SELECT COALESCE(sum(fleet_ledger_balance(account_id)), 0) INTO v_books FROM fleet_ledger_accounts WHERE class IN (${q(TREASURY_HELD_CLASSES)});
  SELECT * INTO b FROM fleet_paypal_balance_observations o
   WHERE o.currency = v_ccy AND o.rail_id IN (SELECT rail_id FROM fleet_payment_rails WHERE provider = 'paypal' AND status <> 'revoked')
   ORDER BY o.observed_at DESC LIMIT 1;
  RETURN jsonb_build_object('currency', v_ccy,
    'virtualCapitalMinor', v_virtual, 'providerPaidMinor', v_paid, 'backedMinor', v_backed, 'unbackedMinor', v_unbacked,
    'booksCashMinor', v_books,
    'paypal', CASE WHEN b.observation_id IS NULL THEN NULL ELSE jsonb_build_object('railId', b.rail_id, 'totalMinor', b.total_minor,
      'availableMinor', b.available_minor, 'observedAt', b.observed_at) END,
    -- PayPal minus what it should hold (the books less what is still unbacked): 0 = reconciled; above 0 = provider-paid
    -- costs beyond the virtual capital, or money not yet recorded; below 0 = money missing.
    'differenceMinor', CASE WHEN b.observation_id IS NULL THEN NULL ELSE b.total_minor - (v_books - v_unbacked) END,
    'backings', COALESCE((SELECT jsonb_agg(jsonb_build_object('backingId', k.backing_id, 'transactionId', k.transaction_id, 'netMinor', k.net_minor,
        'backedMinor', k.backed_minor, 'excessMinor', k.excess_minor, 'excessJournalId', k.excess_journal_id, 'at', k.recorded_at, 'by', k.recorded_by)
        ORDER BY k.recorded_at) FROM fleet_capital_backings k), '[]'::jsonb));
END $$;

-- Owner: this PayPal deposit backs the existing capital (no second credit). Any part beyond what is unbacked is ordinary
-- owner funding under the same claim key.
CREATE FUNCTION fleet_admin_capital_back(p_rail uuid, p_txn text, p_event_code text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE t fleet_paypal_transactions; v_key text; v_net bigint; v_unbacked bigint; v_backed bigint; v_excess bigint; v_j uuid; v_id uuid; v_ccy text;
BEGIN
  ${OWNER_ACTOR}
  -- One backing decision at a time (the unbacked amount is computed, then consumed).
  PERFORM pg_advisory_xact_lock(hashtext('fleet_capital_backing'));
  SELECT * INTO t FROM fleet_paypal_transactions
   WHERE rail_id = p_rail AND transaction_id = p_txn AND event_code = p_event_code ORDER BY initiated_at DESC LIMIT 1 FOR UPDATE;
  IF t.transaction_id IS NULL THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no PayPal transaction with that key'; END IF;
  IF NOT EXISTS (SELECT 1 FROM fleet_payment_rails WHERE rail_id = p_rail AND provider = 'paypal') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: not a PayPal rail'; END IF;
  IF t.checkout_id IS NOT NULL OR t.attributed_at IS NOT NULL THEN
    RAISE EXCEPTION 'FLEET_ALREADY_CLAIMED: that transaction is already accounted for (%)', COALESCE(t.attributed_as, 'a checkout');
  END IF;
  IF t.status <> 'S' THEN RAISE EXCEPTION 'FLEET_NOT_SETTLED: PayPal shows that transaction as % (only completed money backs capital)', t.status; END IF;
  SELECT accounting_currency INTO v_ccy FROM fleet_economic_model WHERE id = 1;
  IF t.currency <> v_ccy THEN RAISE EXCEPTION 'FLEET_FX_REQUIRED: the deposit is in %, the books in %', t.currency, v_ccy; END IF;
  v_net := t.amount_minor + t.fee_minor;  -- PayPal reports its fee as a negative amount
  IF t.amount_minor <= 0 OR v_net <= 0 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: only money received into the treasury backs capital'; END IF;
  v_key := 'paypal:txn:' || t.transaction_id;
  IF fleet_claim_taken(v_key) OR EXISTS (SELECT 1 FROM fleet_ledger_journal WHERE external_ref = v_key) THEN
    RAISE EXCEPTION 'FLEET_ALREADY_CLAIMED: this deposit is already recorded (claim %)', v_key;
  END IF;
  v_unbacked := (fleet_capital_backing() ->> 'unbackedMinor')::bigint;
  IF v_unbacked <= 0 THEN
    RAISE EXCEPTION 'FLEET_NOTHING_TO_BACK: the existing capital is fully backed; record this deposit as owner funding';
  END IF;
  v_backed := LEAST(v_net, v_unbacked);
  v_excess := v_net - v_backed;
  IF v_excess > 0 THEN
    v_j := fleet_ledger_post('owner_funding', 'funding:' || v_key, p_actor, 'owner capital received into custody (beyond the backed capital)', 'owner',
      NULL, NULL, NULL, v_key, NULL, now(), jsonb_build_array(
        jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', v_excess),
        jsonb_build_object('account', 'fleet:owner:capital', 'side', 'C', 'amount', v_excess)));
  END IF;
  INSERT INTO fleet_capital_backings (claim_key, rail_id, transaction_id, event_code, net_minor, backed_minor, excess_minor, excess_journal_id, unbacked_before, recorded_by)
    VALUES (v_key, p_rail, t.transaction_id, t.event_code, v_net, v_backed, v_excess, v_j, v_unbacked, p_actor) RETURNING backing_id INTO v_id;
  UPDATE fleet_paypal_transactions SET attributed_as = 'capital_backing', attributed_ref = v_key, attributed_by = p_actor, attributed_at = now(), updated_at = now()
   WHERE rail_id = t.rail_id AND transaction_id = t.transaction_id AND event_code = t.event_code AND initiated_at = t.initiated_at;
  PERFORM fleet_event('capital_backed', NULL, p_actor, jsonb_build_object('backingId', v_id, 'transactionId', t.transaction_id, 'netMinor', v_net,
    'backedMinor', v_backed, 'excessMinor', v_excess, 'unbackedAfterMinor', v_unbacked - v_backed));
  RETURN jsonb_build_object('ok', true, 'backingId', v_id, 'netMinor', v_net, 'backedMinor', v_backed, 'excessMinor', v_excess,
    'excessJournalId', v_j, 'unbackedAfterMinor', v_unbacked - v_backed);
END $$;

${DASH_CALL}

${EVENT_ROUTE}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

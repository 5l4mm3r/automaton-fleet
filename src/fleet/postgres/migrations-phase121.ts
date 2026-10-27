/**
 * Schema v121 — the treasury shown as it is (owner, 2026-10-26: "the treasury shows 10.79gbp when the paypal has 0.22p only …
 * this is very basic mechanics and infrastructure — fix it!"). READ-ONLY: no journal, balance, policy or economic rule changes.
 *
 * Root causes (production, 26 Oct):
 *  1. HQ's "Treasury cash — real spendable Treasury funds now" is `fleet_treasury_cash()`: the sum of every `treasury_cash`
 *     ledger partition. Today that is entirely `fleet:treasury:owner_reimbursable` (1,079p): book money set aside to repay
 *     the owner, which came out of unbacked wallet money. It is neither PayPal cash nor spendable.
 *  2. "Real money held" (`fleet_treasury_health.cashMinor`) is the BOOK cash of the treasury and the wallets (20,022p), which
 *     includes the 20,000p of unbacked starting capital (the two virtual genesis allocations).
 *  3. The PayPal balance shown is the newest observation of ANY currency. Each sync writes GBP then USD (2 ms apart), so the
 *     USD row (0) is shown instead of the GBP balance (22p).
 *
 * v121 adds `fleet_treasury_position()` — actual provider cash (and when it was observed), the reconciliation of the books
 * against it, available BACKED treasury funds (unknown, never a guess, while the reconciliation is unresolved), the agents'
 * wallets with the unbacked capital beside them, what is owed to the owner and what the books set aside for it, and API credit
 * separately in USD — and makes the PayPal balance the accounting currency's. `fleet_treasury_cash()` and the wealth figure
 * `treasuryCashMinor` are NOT changed (replication and insolvency read them; changing them is an economic-policy decision):
 * the wealth read only gains the honest figures beside it, and HQ shows those.
 */
import { V39_SQL } from "./migrations-phase39.js";
import { V51_SQL } from "./migrations-phase51.js";
import { V93_SQL } from "./migrations-phase93.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));

/** An observation older than this is "stale": the position then shows no available figure. */
export const PAYPAL_BALANCE_STALE_HOURS = 26;
export const DASHBOARD_READ_OPS_V121 = ["treasury_position"] as const;

const HEALTH = restate(V51_SQL, "fleet_treasury_health", [
  [`        'latestBalance', (SELECT jsonb_build_object('currency', b.currency, 'availableMinor', b.available_minor, 'totalMinor', b.total_minor, 'at', b.observed_at)
                          FROM fleet_paypal_balance_observations b ORDER BY b.observed_at DESC LIMIT 1),`,
   `        -- v121: the accounting currency's balance (each sync also writes a USD row a moment later; the newest row was shown).
        'latestBalance', fleet_paypal_balance_latest(),`],
]);

const MONEY_STATES = restate(V51_SQL, "fleet_money_states", [
  [`    'paypalObserved', (SELECT jsonb_build_object('currency', b.currency, 'availableMinor', b.available_minor, 'totalMinor', b.total_minor,
                         'withheldMinor', b.total_minor - b.available_minor, 'at', b.observed_at)
                       FROM fleet_paypal_balance_observations b ORDER BY b.observed_at DESC LIMIT 1))`,
   `    'paypalObserved', fleet_paypal_balance_latest())`],
]);

const WEALTH = restate(V39_SQL, "fleet_generated_treasury_wealth", [
  [`    'fleetGeneratedMinor', GREATEST(0, v_lfc),`,
   `    'fleetGeneratedMinor', GREATEST(0, v_lfc),
    -- v121: what HQ shows instead of the ledger partition sum above (kept for replication / insolvency, unchanged).
    'treasuryCashBasis', 'ledger partitions of class treasury_cash (includes money set aside for the owner); not provider cash',
    'actualCashMinor', (fleet_treasury_position() #>> '{paypal,totalMinor}')::bigint,
    'actualCashAt', fleet_treasury_position() #>> '{paypal,observedAt}',
    'availableTreasuryMinor', (fleet_treasury_position() #>> '{treasury,availableMinor}')::bigint,
    'reconciliationStatus', fleet_treasury_position() #>> '{reconciliation,status}',`],
]);

const DASH_CALL = restate(V93_SQL, "dash_call", [
  [`'spend_reviews','capital_backing','business_folders',`, `'spend_reviews','capital_backing','treasury_position','business_folders',`],
  [`      WHEN 'capital_backing' THEN fleet_capital_backing()`, `      WHEN 'capital_backing' THEN fleet_capital_backing()
      -- v121: the treasury as it is (actual cash, reconciliation, backed funds, wallets, owner liabilities, API credit in USD).
      WHEN 'treasury_position' THEN fleet_treasury_position()`],
]);

export const V121_SQL = `
-- The newest PayPal balance in the accounting currency, on a live PayPal rail (null when none was ever observed).
CREATE FUNCTION fleet_paypal_balance_latest() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('currency', b.currency, 'availableMinor', b.available_minor, 'totalMinor', b.total_minor,
           'withheldMinor', b.total_minor - b.available_minor, 'at', b.observed_at)
    FROM fleet_paypal_balance_observations b
   WHERE b.currency = (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1)
     AND b.rail_id IN (SELECT rail_id FROM fleet_payment_rails WHERE provider = 'paypal' AND status <> 'revoked')
   ORDER BY b.observed_at DESC LIMIT 1
$$;

CREATE FUNCTION fleet_treasury_position() RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE cb jsonb := fleet_capital_backing(); pp jsonb := fleet_paypal_balance_latest(); v_ccy text; v_age numeric; v_status text;
        v_unalloc bigint := fleet_ledger_balance('fleet:treasury:unallocated'); v_reserved bigint := fleet_ledger_balance('fleet:treasury:control_reserved');
        v_reimb bigint := fleet_ledger_balance('fleet:treasury:owner_reimbursable'); v_treasury bigint; v_wallets bigint; v_unbacked bigint;
        v_diff bigint; v_credit bigint := fleet_provider_credit_balance('anthropic'); v_held bigint := fleet_provider_credit_held('anthropic');
BEGIN
  SELECT accounting_currency INTO v_ccy FROM fleet_economic_model WHERE id = 1;
  SELECT COALESCE(sum(fleet_ledger_balance(account_id)), 0) INTO v_treasury FROM fleet_ledger_accounts WHERE class = 'treasury_cash';
  SELECT COALESCE(sum(fleet_ledger_balance(account_id)), 0) INTO v_wallets FROM fleet_ledger_accounts WHERE class = 'agent_cash';
  v_unbacked := (cb ->> 'unbackedMinor')::bigint;
  v_diff := (cb ->> 'differenceMinor')::bigint;
  v_age := CASE WHEN pp IS NULL THEN NULL ELSE extract(epoch FROM now() - (pp ->> 'at')::timestamptz) / 3600 END;
  v_status := CASE WHEN pp IS NULL OR v_diff IS NULL THEN 'unavailable'
                   WHEN v_age > ${PAYPAL_BALANCE_STALE_HOURS} OR v_diff <> 0 THEN 'unresolved' ELSE 'reconciled' END;
  RETURN jsonb_build_object('currency', v_ccy,
    'paypal', CASE WHEN pp IS NULL THEN NULL ELSE pp || jsonb_build_object('observedAt', pp ->> 'at', 'ageHours', round(v_age, 1),
      'fresh', v_age <= ${PAYPAL_BALANCE_STALE_HOURS}) END,
    'reconciliation', jsonb_build_object('status', v_status, 'differenceMinor', v_diff, 'scope', cb ->> 'differenceScope',
      'booksCashMinor', (cb ->> 'booksCashMinor')::bigint, 'unbackedCapitalMinor', v_unbacked, 'backedCapitalMinor', (cb ->> 'backedMinor')::bigint,
      'note', 'books cash − unbacked capital should equal the provider cash; anything else is unresolved, never spendable'),
    'treasury', jsonb_build_object(
      'unallocatedMinor', v_unalloc,
      'fleetControlReservedMinor', v_reserved,
      'ownerSetAsideMinor', v_reimb,
      'otherPartitionsMinor', v_treasury - v_unalloc - v_reserved - v_reimb,
      -- Spendable by Fleet Control: the unallocated book money real cash covers — only while the books reconcile.
      'availableMinor', CASE WHEN v_status = 'reconciled' THEN GREATEST(0, LEAST(v_unalloc, (pp ->> 'availableMinor')::bigint)) END),
    'agents', jsonb_build_object(
      'walletsMinor', v_wallets,
      'backedAtMostMinor', GREATEST(0, v_wallets - v_unbacked),
      'wallets', COALESCE((SELECT jsonb_agg(jsonb_build_object('agentId', a.agent_id, 'status', a.status, 'walletMinor', fleet_ledger_balance(fleet_ledger_account(a.agent_id, 'agent_cash')))
        ORDER BY a.created_at) FROM fleet_agents a WHERE EXISTS (SELECT 1 FROM fleet_ledger_accounts x WHERE x.agent_id = a.agent_id)), '[]'::jsonb),
      'note', 'book budgets; unbacked starting capital is counted here until real money backs it'),
    'owner', jsonb_build_object(
      'payableMinor', fleet_ledger_balance('fleet:owner:payable'),
      'setAsideMinor', v_reimb,
      'note', 'payable = what the Fleet owes you; set aside = book money reserved to repay it (real only as far as cash covers it)'),
    'apiCredit', jsonb_build_object('currency', 'USD', 'provider', 'anthropic', 'unit', 'USD × 1e-8',
      'balance', v_credit, 'held', v_held, 'free', v_credit - v_held,
      'promotional', (SELECT COALESCE(sum(usd_remaining), 0) FROM fleet_ai_credit_lots WHERE provider = 'anthropic' AND source = 'promotional'),
      'purchased', (SELECT COALESCE(sum(usd_remaining), 0) FROM fleet_ai_credit_lots WHERE provider = 'anthropic' AND source <> 'promotional'),
      'promotionalExpiresAt', (SELECT min(expires_at) FROM fleet_ai_credit_lots WHERE provider = 'anthropic' AND source = 'promotional' AND usd_remaining > 0),
      'note', 'inference capacity at the provider, not cash: never added to a GBP figure'));
END $$;

${HEALTH}

${MONEY_STATES}

${WEALTH}

${DASH_CALL}

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

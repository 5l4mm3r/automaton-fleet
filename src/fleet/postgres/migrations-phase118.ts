/**
 * Schema v118 — the credit that pays is known before the charge is posted (owner, 2026-10-26, option A: "determine the
 * credit source before posting the charge, within the same transaction. Promotional-funded usage should never temporarily
 * drain an agent's wallet").
 *
 * Until now a model call's charge was posted first (agent inference: the agent's cash; an owner conversation: the treasury;
 * always owed to the owner, v69) and its provider-credit consumption — which draws the lots (v116: promotional first) — was
 * written after it. A promotional draw therefore charged the payer and created an owner payable for credit nobody bought.
 * A delayed reversal (the first v118 draft, never deployed) left a window in which a promotional charge could exhaust — and
 * kill — an agent, raised false notices, aborted concurrent settlement passes and could refund an uncollectable charge.
 *
 * Now, in the recording transaction itself:
 *  1. the consumption is written FIRST (the lots are drawn under their row locks; concurrent calls serialise there);
 *  2. what this request drew from promotional lots is read back (fleet_ai_credit_promotional_drawn);
 *  3. only the purchased part is charged: the intended charge × purchased USD ÷ the call's USD, rounded up; the v111
 *     overrun exception likewise covers only the purchased part. A call wholly on promotional credit charges no one, owes
 *     no one and leaves no exception; purchased-only calls are unchanged.
 *  4. the call log keeps the intended charge (charged_intended_microcents), what promotional credit paid
 *     (promotional_usd_microcents), the purchased charge before any shortfall (charged_microcents) and what was posted
 *     (charged_cents); an uncollectable shortfall stays a cost exception of the purchased part.
 * Fleet Control's settlement does the same (v117, amended). The minutely settlement does nothing for promotional use.
 *
 * Reservations never rely on promotional credit: an agent's authorisation still needs its own cash for the full estimate
 * (the promotional credit may be spent by a competing call or expire before the call is recorded), and promotional credit
 * expiring within the hour no longer counts as available provider credit for new reservations (fleet_provider_credit_held).
 * Wallet-zero death is unchanged. Nothing here posts, refunds or rewrites history.
 */
import { V111_SQL } from "./migrations-phase111.js";
import { V116_SQL } from "./migrations-phase116.js";
import { V117_SQL } from "./migrations-phase117.js";
import { restate } from "./migrations-phase42.js";

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
/** Promotional credit expiring within this window is not counted as available for a new reservation. */
export const PROMOTIONAL_EXPIRY_MARGIN_MINUTES = 60;
export const EVENT_ROUTES_V118 = Object.freeze({ P3_SUMMARY: ["cognition_overrun_promotional"] });

const CONSUME_FIRST = (provider: string) => `  -- v118: the consumption first — the lots are drawn now, so the credit that pays is known before anything is charged.
  IF v_used_usd > 0 THEN
    INSERT INTO fleet_provider_credit_events (provider, kind, usd_microcents, request_id, recorded_by)
      VALUES (${provider}, 'consumption', -v_used_usd, p_request, 'controller');
  END IF;
  v_promo_usd := LEAST(fleet_ai_credit_promotional_drawn(p_request), v_used_usd);
  v_intended := v_micro;
  v_micro := fleet_ai_credit_purchased_part(v_micro, v_used_usd, v_promo_usd);
`;

const ROUTED = restate(V111_SQL, "svc_cognition_routed_record", [
  [`        v_unposted bigint; v_total bigint; v_rate bigint; v_acct text; v_saving bigint; v_avail bigint; v_unfunded bigint := 0;`,
   `        v_unposted bigint; v_total bigint; v_rate bigint; v_acct text; v_saving bigint; v_avail bigint; v_unfunded bigint := 0;
        v_promo_usd bigint := 0; v_intended bigint; v_over_full bigint := 0;`],
  [`  IF i.payer = 'treasury' THEN
    -- v62: an owner conversation turn: the treasury pays (fleet operating expense), never the Agent.`,
   `${CONSUME_FIRST("i.route_provider")}  v_over_full := v_over;
  v_over := fleet_ai_credit_purchased_part(v_over, v_used_usd, v_promo_usd);
  v_over_usd := fleet_ai_credit_purchased_part(v_over_usd, v_used_usd, v_promo_usd);
  IF i.payer = 'treasury' THEN
    -- v62: an owner conversation turn: the treasury pays (fleet operating expense), never the Agent.`],
  [`  IF v_used_usd > 0 THEN
    INSERT INTO fleet_provider_credit_events (provider, kind, usd_microcents, request_id, recorded_by)
      VALUES (i.route_provider, 'consumption', -v_used_usd, p_request, 'controller');
  END IF;
  -- v111: only this call's reservation`, `  -- v111: only this call's reservation`],
  [`      cache_policy, cache_saving_microcents)`, `      cache_policy, cache_saving_microcents, promotional_usd_microcents, charged_intended_microcents)`],
  [`THEN v_obs ->> 'promptCache' END, v_saving);`, `THEN v_obs ->> 'promptCache' END, v_saving, v_promo_usd, v_intended);`],
  [`  IF v_short > 0 THEN`, `  IF v_over = 0 AND v_over_full > 0 THEN
    PERFORM fleet_event('cognition_overrun_promotional', p_agent, 'controller', jsonb_build_object('requestId', p_request, 'ledgerMicro', v_over_full,
      'note', 'a model call cost more than its reservation, but promotional credit paid it: nothing to charge or allocate; the estimate was low'));
  END IF;
  IF v_short > 0 THEN`],
  [`'chargedCents', v_charge, 'chargedMicrocents', v_micro,`, `'chargedCents', v_charge, 'chargedMicrocents', v_micro, 'chargedIntendedMicrocents', v_intended, 'promotionalUsdMicrocents', v_promo_usd,`],
]);

const LEGACY = restate(V111_SQL, "svc_cognition_record", [
  [`DECLARE i fleet_cognition_inflight; p fleet_cognition_policy; v_cost bigint; v_used_usd bigint; v_cost_l bigint; v_micro bigint; v_charge bigint; v_j uuid;`,
   `DECLARE i fleet_cognition_inflight; p fleet_cognition_policy; v_cost bigint; v_used_usd bigint; v_cost_l bigint; v_micro bigint; v_charge bigint; v_j uuid;
        v_promo_usd bigint := 0; v_intended bigint;`],
  [`  IF v_used_usd > 0 THEN
    INSERT INTO fleet_provider_credit_events (provider, kind, usd_microcents, request_id, recorded_by)
      VALUES (p.provider, 'consumption', -v_used_usd, p_request, 'controller');
  END IF;
`, ``],
  [`  INSERT INTO fleet_cognition_accrual (agent_id) VALUES (p_agent) ON CONFLICT (agent_id) DO NOTHING;`,
   `${CONSUME_FIRST("p.provider")}  INSERT INTO fleet_cognition_accrual (agent_id) VALUES (p_agent) ON CONFLICT (agent_id) DO NOTHING;`],
  [`      ledger_currency, fx_rate_id, fx_rate_micro, provider_usd_microcents)`, `      ledger_currency, fx_rate_id, fx_rate_micro, provider_usd_microcents, promotional_usd_microcents, charged_intended_microcents)`],
  [`      v_acct, i.fx_rate_id, v_rate, v_used_usd);`, `      v_acct, i.fx_rate_id, v_rate, v_used_usd, v_promo_usd, v_intended);`],
  [`'chargedCents', v_charge, 'chargedMicrocents', v_micro,`, `'chargedCents', v_charge, 'chargedMicrocents', v_micro, 'chargedIntendedMicrocents', v_intended, 'promotionalUsdMicrocents', v_promo_usd,`],
]);

// Provider credit not available for a new reservation: engineering holds, unsettled Fleet Control calls (v117), and
// promotional credit expiring within the margin (it may be gone before the call is recorded).
const HELD = restate(V117_SQL, "fleet_provider_credit_held", [
  [`       + (SELECT COALESCE(sum(max_usd_microcents), 0) FROM fleet_control_ai_reservations WHERE provider = p_provider AND status IN ('open','unknown'))::bigint;`,
   `       + (SELECT COALESCE(sum(max_usd_microcents), 0) FROM fleet_control_ai_reservations WHERE provider = p_provider AND status IN ('open','unknown'))::bigint
       + (SELECT COALESCE(sum(usd_remaining), 0) FROM fleet_ai_credit_lots WHERE provider = p_provider AND source = 'promotional' AND usd_remaining > 0
            AND expires_at > now() AND expires_at <= now() + interval '${PROMOTIONAL_EXPIRY_MARGIN_MINUTES} minutes')::bigint;`],
]);

const STATUS = restate(V116_SQL, "fleet_ai_credit_status", [
  [`    'promotionalTreatment', 'not decided: promotional use has no cash cost, but each charge still posts as today (the agent''s cost, made owed to the owner by the v69 default); fleetUse above is that use, at charge rates. Nothing else is posted.',`,
   `    'promotionalTreatment', 'no cost (v118): the credit that pays is known before a charge is posted; promotional use is charged to no one and owed to no one. No internal charge to agents for promotional use is approved; one would need a separate policy and migration.',
    'consumed', jsonb_build_object(
      'promotional', jsonb_build_object(
        'usdMicrocents', (SELECT COALESCE(sum(d.usd), 0) FROM fleet_ai_credit_draws d JOIN fleet_ai_credit_lots l ON l.lot_id = d.lot_id WHERE l.source = 'promotional' AND d.cause = 'consumption'),
        'agentCalls', (SELECT jsonb_build_object('calls', count(*), 'usdMicrocents', COALESCE(sum(promotional_usd_microcents), 0)) FROM fleet_cognition_log WHERE payer = 'agent' AND promotional_usd_microcents > 0),
        'treasuryCalls', (SELECT jsonb_build_object('calls', count(*), 'usdMicrocents', COALESCE(sum(promotional_usd_microcents), 0)) FROM fleet_cognition_log WHERE payer = 'treasury' AND promotional_usd_microcents > 0),
        'fleetControlCalls', (SELECT jsonb_build_object('calls', count(*), 'usdMicrocents', COALESCE(sum(promotional_usd_microcents), 0)) FROM fleet_control_ai_reservations WHERE promotional_usd_microcents > 0),
        'chargedMinor', 0, 'owedToOwnerMinor', 0),
      'purchased', jsonb_build_object(
        'usdMicrocents', (SELECT COALESCE(sum(d.usd), 0) FROM fleet_ai_credit_draws d JOIN fleet_ai_credit_lots l ON l.lot_id = d.lot_id WHERE l.source IN ('owner','treasury') AND d.cause = 'consumption'),
        'ownerPayableMinor', fleet_ledger_balance('fleet:owner:payable'),
        'note', 'owner-bought lots: their use is owed to the owner (v69), the evidenced reimbursement; treasury-bought lots are reclassified (v70)'),
      'internalChargeToAgentsForPromotional', jsonb_build_object('policy', 'none approved', 'postedMinor', 0)),`],
]);

export const V118_SQL = `
ALTER TABLE fleet_cognition_log
  ADD COLUMN promotional_usd_microcents bigint CHECK (promotional_usd_microcents >= 0),
  ADD COLUMN charged_intended_microcents bigint CHECK (charged_intended_microcents >= 0);

${ROUTED}

${LEGACY}

${HELD}

${STATUS}

${restate(V117_SQL, "fleet_event_route", [["    WHEN p_type = 'spend_circuit_breaker_set' THEN",
  (Object.entries(EVENT_ROUTES_V118) as Array<[string, readonly string[]]>)
    .map(([lvl, types]) => `    WHEN p_type IN (${q(types)}) THEN '${lvl}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"]])}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

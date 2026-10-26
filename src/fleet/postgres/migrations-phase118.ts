/**
 * Schema v118 — promotional credit used by Fleet costs nothing and is owed to no one (owner correction, 2026-10-26: "Promotional
 * credit must not create an owner-reimbursement payable merely because Fleet consumed it … Keep separate: promotional credit
 * consumed; purchased credit consumed and its evidenced reimbursement; any proposed internal charge to agents. No new internal
 * charging policy is approved.").
 *
 * The path until now: every AI charge is posted when the call is recorded, before anyone knows which credit the provider
 * drew — agent inference D agent_expense / C agent_cash, an owner conversation or a Fleet Control review D fleet:expense /
 * C treasury — and always with the v69 legs D fleet:treasury:owner_reimbursable / C fleet:owner:payable. The consumption
 * then draws lots (v116: promotional first). For a promotional lot nothing corrected the charge, so free credit became a
 * cost to the agent (or the treasury) AND a debt to the owner, although nobody paid for it.
 *
 * Now the minutely settlement reverses, for each draw from a promotional lot, exactly the part of the call's charge that
 * the draw covers (the call's own GBP charge × promotional USD / the call's USD):
 *   D fleet:owner:payable  /  C fleet:treasury:owner_reimbursable        (not owed to the owner: he paid nothing for it)
 *   D the payer's cash     /  C the payer's expense                       (agent: agent_cash / agent_expense;
 *                                                                          treasury or Fleet Control: unallocated / fleet:expense)
 * accrued per payer in GBP micro and posted in whole pence, never beyond what that payer was charged. Purchased credit is
 * untouched: its draws keep the v69 legs (owed to the owner, the evidenced reimbursement). Engineering runs post no GBP charge,
 * so their promotional use is recorded only (provider credit and draw). A draw whose charge cannot be found within an hour is
 * recorded as unattributed and Fleet Command is told; an owner-conversation call the treasury could not fund in full is held
 * for the owner (no reversal is posted for a charge that was never booked).
 *
 * The three are reported separately (fleet_ai_credit_status): promotional consumed (USD, by payer, GBP reversed), purchased
 * consumed (owed to the owner), and the internal charge to agents for promotional use — none: no policy is approved; any
 * such charge needs a separate, approved policy and migration. The migration posts nothing.
 */
import { V117_SQL } from "./migrations-phase117.js";
import { V116_SQL } from "./migrations-phase116.js";
import { OWNER_PAYABLE_ACCOUNT, REIMBURSABLE_ACCOUNT } from "./migrations-phase69.js";
import { restate } from "./migrations-phase42.js";

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
export const PROMOTIONAL_USE_KIND = "ai_credit_promotional_use";
export const PROMOTIONAL_PAYERS = ["agent", "treasury", "fleet_control", "none"] as const;
/** A promotional draw whose charge is not found after this long is recorded as unattributed. */
export const PROMOTIONAL_ATTRIBUTE_WITHIN_MINUTES = 60;
export const EVENT_ROUTES_V118 = Object.freeze({ P2_IMPORTANT: ["ai_credit_promotional_unattributed"] });

const SETTLE = restate(V117_SQL, "svc_ai_credit_settle", [
  [`  v_detect := v_detect || jsonb_build_object('fleetControlSweep', fleet_control_ai_sweep());`,
   `  v_detect := v_detect || jsonb_build_object('fleetControlSweep', fleet_control_ai_sweep());
  v_detect := v_detect || jsonb_build_object('promotionalUse', fleet_ai_credit_promotional_use_settle());`],
]);

const STATUS = restate(V116_SQL, "fleet_ai_credit_status", [
  [`    'promotionalTreatment', 'not decided: promotional use has no cash cost, but each charge still posts as today (the agent''s cost, made owed to the owner by the v69 default); fleetUse above is that use, at charge rates. Nothing else is posted.',`,
   `    'promotionalTreatment', 'no cost (v118): promotional use is owed to no one and charged to no one — the charge each call posted is reversed for the part promotional credit covered. No internal charge to agents for promotional use is approved; one would need a separate policy and migration.',
    'consumed', jsonb_build_object(
      'promotional', (SELECT jsonb_build_object('usdMicrocents', COALESCE(sum(d.usd), 0), 'calls', count(DISTINCT d.request_id),
          'byPayer', COALESCE((SELECT jsonb_object_agg(payer, jsonb_build_object('usdMicrocents', usd, 'gbpMicroReversible', micro))
                                 FROM (SELECT payer, sum(usd) AS usd, sum(gbp_micro) AS micro FROM fleet_ai_credit_promotional_uses GROUP BY payer) p), '{}'::jsonb),
          'unattributedDraws', (SELECT count(*) FROM fleet_ai_credit_promotional_uses WHERE payer = 'none' AND basis = 'unattributed'),
          'pendingDraws', (SELECT count(*) FROM fleet_ai_credit_draws d2 JOIN fleet_ai_credit_lots l2 ON l2.lot_id = d2.lot_id
                            WHERE l2.source = 'promotional' AND d2.cause = 'consumption'
                              AND NOT EXISTS (SELECT 1 FROM fleet_ai_credit_promotional_uses u WHERE u.draw_id = d2.draw_id)),
          'reversedMinor', (SELECT COALESCE(sum(posted_minor), 0) FROM fleet_ai_credit_promotional_accrual))
        FROM fleet_ai_credit_draws d JOIN fleet_ai_credit_lots l ON l.lot_id = d.lot_id WHERE l.source = 'promotional' AND d.cause = 'consumption'),
      'purchased', (SELECT jsonb_build_object('usdMicrocents', COALESCE(sum(d.usd), 0), 'ownerPayableMinor', fleet_ledger_balance('${OWNER_PAYABLE_ACCOUNT}'),
          'note', 'owner-bought lots: their use is owed to the owner (v69), the evidenced reimbursement; treasury-bought lots are reclassified (v70)')
        FROM fleet_ai_credit_draws d JOIN fleet_ai_credit_lots l ON l.lot_id = d.lot_id WHERE l.source IN ('owner','treasury') AND d.cause = 'consumption'),
      'internalChargeToAgentsForPromotional', jsonb_build_object('policy', 'none approved', 'postedMinor', 0)),`],
]);

export const V118_SQL = `
INSERT INTO fleet_ledger_kinds (kind, requires_external_ref, allowed_sources, multi_agent, description, provenance) VALUES
  ('${PROMOTIONAL_USE_KIND}', false, ARRAY['controller'], false,
   'AI use covered by promotional (free) provider credit: the call''s charge reversed for that part — owed to no one, charged to no one', 'correction');
INSERT INTO fleet_ledger_rules (kind, class, side) VALUES
  ('${PROMOTIONAL_USE_KIND}','owner_payable','D'), ('${PROMOTIONAL_USE_KIND}','treasury_cash','C'),
  ('${PROMOTIONAL_USE_KIND}','agent_cash','D'), ('${PROMOTIONAL_USE_KIND}','agent_expense','C'),
  ('${PROMOTIONAL_USE_KIND}','treasury_cash','D'), ('${PROMOTIONAL_USE_KIND}','fleet_expense','C');

-- One row per promotional draw: whose charge it covered and how much of it (GBP micro), once.
CREATE TABLE fleet_ai_credit_promotional_uses (
  draw_id     bigint      PRIMARY KEY REFERENCES fleet_ai_credit_draws(draw_id),
  request_id  uuid,
  payer       text        NOT NULL CHECK (payer IN (${q(PROMOTIONAL_PAYERS)})),
  agent_id    text        REFERENCES fleet_agents(agent_id),
  usd         bigint      NOT NULL CHECK (usd > 0),
  gbp_micro   bigint      NOT NULL CHECK (gbp_micro >= 0),
  basis       text        NOT NULL CHECK (basis IN ('charge','no_gbp_charge','unattributed','unfunded_owner_review')),
  at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((payer = 'agent') = (agent_id IS NOT NULL)),
  CHECK (payer <> 'none' OR gbp_micro = 0)
);
CREATE TRIGGER fleet_ai_credit_promotional_uses_no_change BEFORE UPDATE OR DELETE ON fleet_ai_credit_promotional_uses FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- Per payer account: GBP micro to reverse, and whole pence reversed so far.
CREATE TABLE fleet_ai_credit_promotional_accrual (
  cash_account    text        PRIMARY KEY,
  expense_account text        NOT NULL,
  agent_id        text        REFERENCES fleet_agents(agent_id),
  micro           bigint      NOT NULL DEFAULT 0 CHECK (micro >= 0),
  posted_minor    bigint      NOT NULL DEFAULT 0 CHECK (posted_minor >= 0),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (posted_minor * 1000000 <= micro)
);
CREATE TRIGGER fleet_ai_credit_promotional_accrual_no_delete BEFORE DELETE ON fleet_ai_credit_promotional_accrual FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- Minutely: attribute new promotional draws to the charge they covered, then reverse whole pence per payer.
CREATE FUNCTION fleet_ai_credit_promotional_use_settle() RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE d record; c fleet_cognition_log; x fleet_control_ai_reservations; v_call_usd bigint; v_micro bigint; v_payer text; v_basis text;
        v_cash text; v_exp text; v_agent text; a fleet_ai_credit_promotional_accrual; v_post bigint; v_room bigint;
        v_new integer := 0; v_posted bigint := 0; v_unattributed integer := 0;
BEGIN
  FOR d IN SELECT dr.* FROM fleet_ai_credit_draws dr JOIN fleet_ai_credit_lots l ON l.lot_id = dr.lot_id
            WHERE l.source = 'promotional' AND dr.cause = 'consumption'
              AND NOT EXISTS (SELECT 1 FROM fleet_ai_credit_promotional_uses u WHERE u.draw_id = dr.draw_id)
            ORDER BY dr.draw_id LIMIT 500 LOOP
    v_payer := NULL; v_micro := 0; v_agent := NULL; v_cash := NULL; v_exp := NULL; v_basis := 'charge';
    v_call_usd := (SELECT -usd_microcents FROM fleet_provider_credit_events WHERE request_id = d.request_id AND kind = 'consumption');
    SELECT * INTO c FROM fleet_cognition_log WHERE request_id = d.request_id;
    IF c.request_id IS NOT NULL THEN
      IF c.payer = 'agent' THEN
        v_payer := 'agent'; v_agent := c.agent_id;
        v_cash := fleet_ledger_account(c.agent_id, 'agent_cash'); v_exp := fleet_ledger_account(c.agent_id, 'agent_expense');
      ELSE
        v_payer := 'treasury'; v_cash := 'fleet:treasury:unallocated'; v_exp := 'fleet:expense';
        IF COALESCE((SELECT unfunded_cents FROM fleet_conversation_turns WHERE turn_id = c.conversation_turn), 0) > 0 THEN v_basis := 'unfunded_owner_review'; END IF;
      END IF;
      v_micro := CASE WHEN v_basis = 'charge' THEN (COALESCE(c.charged_microcents, 0)::numeric * d.usd / GREATEST(v_call_usd, d.usd))::bigint ELSE 0 END;
    ELSE
      SELECT * INTO x FROM fleet_control_ai_reservations WHERE request_id = d.request_id AND status = 'settled';
      IF x.reservation_id IS NOT NULL THEN
        v_payer := 'fleet_control'; v_cash := 'fleet:treasury:unallocated'; v_exp := 'fleet:expense';
        v_micro := (COALESCE(x.charged_micro, 0)::numeric * d.usd / GREATEST(x.actual_usd_microcents, d.usd))::bigint;
      ELSIF EXISTS (SELECT 1 FROM fleet_engineering_cognition_calls WHERE call_id = d.request_id) THEN
        v_payer := 'none'; v_basis := 'no_gbp_charge';
      ELSIF d.at < now() - interval '${PROMOTIONAL_ATTRIBUTE_WITHIN_MINUTES} minutes' THEN
        v_payer := 'none'; v_basis := 'unattributed';
      ELSE
        CONTINUE;   -- its charge is not recorded yet (an open reservation, a call still being recorded): next pass
      END IF;
    END IF;
    IF v_payer = 'fleet_control' AND x.reservation_id IS NULL THEN CONTINUE; END IF;
    INSERT INTO fleet_ai_credit_promotional_uses (draw_id, request_id, payer, agent_id, usd, gbp_micro, basis)
      VALUES (d.draw_id, d.request_id, v_payer, v_agent, d.usd, CASE WHEN v_payer = 'none' THEN 0 ELSE v_micro END, v_basis);
    v_new := v_new + 1;
    IF v_basis IN ('unattributed','unfunded_owner_review') THEN
      v_unattributed := v_unattributed + 1;
      PERFORM fleet_event('ai_credit_promotional_unattributed', v_agent, 'controller', jsonb_build_object('drawId', d.draw_id, 'requestId', d.request_id,
        'usdMicrocents', d.usd, 'basis', v_basis, 'note', CASE WHEN v_basis = 'unattributed'
          THEN 'promotional credit was drawn for a call whose charge Fleet cannot find: nothing is reversed or owed; the use is recorded'
          ELSE 'promotional credit covered an owner-conversation call the treasury could not fund in full: nothing is reversed automatically; review it' END));
    ELSIF v_micro > 0 THEN
      INSERT INTO fleet_ai_credit_promotional_accrual (cash_account, expense_account, agent_id, micro) VALUES (v_cash, v_exp, v_agent, v_micro)
        ON CONFLICT (cash_account) DO UPDATE SET micro = fleet_ai_credit_promotional_accrual.micro + EXCLUDED.micro, updated_at = now();
    END IF;
  END LOOP;
  -- Whole pence per payer, never beyond what was owed to the owner and held for him.
  FOR a IN SELECT * FROM fleet_ai_credit_promotional_accrual WHERE micro / 1000000 > posted_minor ORDER BY cash_account FOR UPDATE SKIP LOCKED LOOP
    v_room := LEAST(fleet_ledger_balance('${OWNER_PAYABLE_ACCOUNT}'), fleet_ledger_balance('${REIMBURSABLE_ACCOUNT}'));
    v_post := LEAST(a.micro / 1000000 - a.posted_minor, GREATEST(v_room, 0));
    CONTINUE WHEN v_post <= 0;
    PERFORM fleet_ledger_post('${PROMOTIONAL_USE_KIND}', 'ai-credit-promotional:' || a.cash_account || ':' || (a.posted_minor + v_post), 'controller',
      'AI use covered by promotional credit: owed to no one, charged to no one', 'controller', a.agent_id, NULL, NULL, NULL, NULL, now(), jsonb_build_array(
        jsonb_build_object('account', '${OWNER_PAYABLE_ACCOUNT}', 'side', 'D', 'amount', v_post),
        jsonb_build_object('account', '${REIMBURSABLE_ACCOUNT}', 'side', 'C', 'amount', v_post),
        jsonb_build_object('account', a.cash_account, 'side', 'D', 'amount', v_post),
        jsonb_build_object('account', a.expense_account, 'side', 'C', 'amount', v_post)));
    UPDATE fleet_ai_credit_promotional_accrual SET posted_minor = posted_minor + v_post, updated_at = now() WHERE cash_account = a.cash_account;
    v_posted := v_posted + v_post;
  END LOOP;
  RETURN jsonb_build_object('attributed', v_new, 'reversedMinor', v_posted, 'unattributed', v_unattributed);
END $$;

${SETTLE}

${STATUS}

${restate(V117_SQL, "fleet_event_route", [["    WHEN p_type = 'spend_circuit_breaker_set' THEN",
  (Object.entries(EVENT_ROUTES_V118) as Array<[string, readonly string[]]>)
    .map(([lvl, types]) => `    WHEN p_type IN (${q(types)}) THEN '${lvl}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"]])}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

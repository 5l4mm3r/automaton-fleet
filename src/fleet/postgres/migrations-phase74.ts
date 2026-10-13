/**
 * Schema v74 — pre-launch test costs are not the agents' and not owed to the owner (owner decision, 2026-10-13:
 * "Agents don't owe me anything for testing fees"; "Nothing is owed and withdrawal of fees will always solve that for
 * future expenses").
 *
 * Everything before launch was setup and testing. One owner action, once, while EVERY living agent is still paused (resuming
 * is the launch, so nothing after the cutoff can be included):
 *   - each agent's AI cost so far (the pre-tax charges and their tax share) moves to the Fleet:
 *       D agent cash / C agent expense   and   D Fleet expense / C treasury unallocated
 *     — the expense stays recognised once, now as the Fleet's launch cost;
 *   - what the Fleet owed the owner for that pre-launch credit becomes the owner's contribution, and the treasury cash held
 *     for it is released:   D owner payable / C owner capital   and   D treasury unallocated / C treasury owner-reimbursable;
 *   - the sub-penny tax remainders still carried for pre-launch usage are waived (recorded, never posted).
 * From launch on nothing changes: owner-funded AI credit is owed to the owner as it is used (v69), agents bear their own
 * work's cost (v72). The capital to back is unchanged (these move money only between accounts the backing already counts).
 */
import { PROVIDER_PAID_KINDS } from "./migrations-phase66.js";
import { OWNER_PAYABLE_ACCOUNT, REIMBURSABLE_ACCOUNT } from "./migrations-phase69.js";
import { V73_SQL } from "./migrations-phase73.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
export const EVENT_ROUTES_V74 = Object.freeze({ P3_SUMMARY: ["ai_credit_test_period_written_off"] });
export const TEST_PERIOD_KIND = "ai_credit_test_period_writeoff";
const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');`;
const AI_COST_KINDS = [...PROVIDER_PAID_KINDS, "ai_credit_acquisition_cost"];

export const V74_SQL = `
ALTER TABLE fleet_ledger_kinds DISABLE TRIGGER fleet_ledger_kinds_no_change;
INSERT INTO fleet_ledger_kinds (kind, requires_external_ref, allowed_sources, multi_agent, description, provenance) VALUES
  ('${TEST_PERIOD_KIND}', false, ARRAY['owner'], false,
   'Pre-launch test costs: an agent''s AI cost moved to the Fleet, or the owner''s pre-launch AI credit written off as contribution', 'correction');
ALTER TABLE fleet_ledger_kinds ENABLE TRIGGER fleet_ledger_kinds_no_change;
INSERT INTO fleet_ledger_rules (kind, class, side) VALUES
  ('${TEST_PERIOD_KIND}','agent_cash','D'), ('${TEST_PERIOD_KIND}','agent_expense','C'),
  ('${TEST_PERIOD_KIND}','fleet_expense','D'), ('${TEST_PERIOD_KIND}','treasury_cash','C'),
  ('${TEST_PERIOD_KIND}','owner_payable','D'), ('${TEST_PERIOD_KIND}','owner_capital','C'), ('${TEST_PERIOD_KIND}','treasury_cash','D')
ON CONFLICT DO NOTHING;

CREATE TABLE fleet_ai_credit_test_period_runs (
  id          integer     PRIMARY KEY CHECK (id = 1),          -- once, ever
  result      jsonb       NOT NULL,
  applied_by  text        NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_ai_credit_test_period_runs_no_change BEFORE UPDATE OR DELETE ON fleet_ai_credit_test_period_runs FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- What the write-off would do now, and whether it may (read-only).
CREATE FUNCTION fleet_ai_credit_test_period_preview() RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_agents jsonb; v_running jsonb; v_payable bigint; v_reimb bigint; v_carry bigint; v_refused text; v_total bigint;
BEGIN
  SELECT COALESCE(jsonb_object_agg(x.agent_id, x.amount), '{}'::jsonb), COALESCE(sum(x.amount), 0) INTO v_agents, v_total FROM (
    SELECT j.agent_id, sum(CASE WHEN p.side = 'D' THEN p.amount_cents ELSE -p.amount_cents END)::bigint AS amount
      FROM fleet_ledger_journal j JOIN fleet_ledger_postings p ON p.journal_id = j.journal_id
     WHERE j.kind IN (${q(AI_COST_KINDS)}) AND j.agent_id IS NOT NULL AND p.account_id = fleet_ledger_account(j.agent_id, 'agent_expense')
     GROUP BY j.agent_id HAVING sum(CASE WHEN p.side = 'D' THEN p.amount_cents ELSE -p.amount_cents END) > 0) x;
  SELECT COALESCE(jsonb_agg(a.agent_id ORDER BY a.agent_id), '[]'::jsonb) INTO v_running FROM fleet_agents a
   WHERE a.status NOT IN ('dead', 'terminated')
     AND NOT COALESCE((SELECT c.paused OR NOT c.enabled FROM fleet_founder_cognition c WHERE c.agent_id = a.agent_id), false);
  v_payable := fleet_ledger_balance('${OWNER_PAYABLE_ACCOUNT}');
  v_reimb := fleet_ledger_balance('${REIMBURSABLE_ACCOUNT}');
  SELECT COALESCE(sum(unposted_micro), 0) INTO v_carry FROM fleet_ai_credit_cost_accrual;
  v_refused := CASE
    WHEN EXISTS (SELECT 1 FROM fleet_ai_credit_test_period_runs) THEN 'already written off'
    WHEN jsonb_array_length(v_running) > 0 THEN 'every living agent must still be paused (resuming is the launch): ' || v_running::text
    WHEN v_reimb < v_payable THEN 'the treasury holds less for the owner than is owed'
    WHEN fleet_ledger_balance('fleet:treasury:unallocated') + v_payable < v_total THEN 'the treasury cannot cover the agents'' test costs'
  END;
  RETURN jsonb_build_object('refused', v_refused, 'agentsMinor', v_agents, 'agentsTotalMinor', v_total, 'ownerPayableMinor', v_payable,
    'carriedMicro', v_carry, 'note', 'agents: their AI cost so far moves to the Fleet; owner payable: written off as contribution; carried sub-penny tax: waived');
END $$;

-- Owner: write the pre-launch test costs off (once).
CREATE FUNCTION fleet_admin_ai_credit_test_period_writeoff(p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE pv jsonb; r fleet_ai_credit_test_period_runs; k text; v bigint; v_payable bigint; v_result jsonb; v_j jsonb := '[]'::jsonb; v_id uuid;
BEGIN
  ${OWNER_ACTOR}
  LOCK TABLE fleet_ai_credit_test_period_runs IN EXCLUSIVE MODE;
  SELECT * INTO r FROM fleet_ai_credit_test_period_runs WHERE id = 1;
  IF r.id IS NOT NULL THEN RETURN jsonb_build_object('ok', true, 'already', true, 'appliedAt', r.applied_at, 'appliedBy', r.applied_by) || r.result; END IF;
  -- no AI cost may be added while this runs
  LOCK TABLE fleet_ledger_head IN EXCLUSIVE MODE;
  pv := fleet_ai_credit_test_period_preview();
  IF pv->>'refused' IS NOT NULL THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: %', pv->>'refused'; END IF;
  -- 1. the owner's pre-launch credit: written off as contribution; the cash held for it released to the treasury
  v_payable := (pv->>'ownerPayableMinor')::bigint;
  IF v_payable > 0 THEN
    v_id := fleet_ledger_post('${TEST_PERIOD_KIND}', 'ai-credit-test-period:owner', p_actor,
      'pre-launch AI credit (setup and testing) written off by the owner: contribution, nothing owed', 'owner', NULL, NULL, NULL, NULL, NULL, now(), jsonb_build_array(
        jsonb_build_object('account', '${OWNER_PAYABLE_ACCOUNT}', 'side', 'D', 'amount', v_payable),
        jsonb_build_object('account', 'fleet:owner:capital', 'side', 'C', 'amount', v_payable),
        jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', v_payable),
        jsonb_build_object('account', '${REIMBURSABLE_ACCOUNT}', 'side', 'C', 'amount', v_payable)));
    v_j := v_j || to_jsonb(v_id);
  END IF;
  -- 2. each agent's AI cost so far becomes the Fleet's launch cost
  FOR k, v IN SELECT key, value::bigint FROM jsonb_each_text(pv->'agentsMinor') ORDER BY key LOOP
    v_id := fleet_ledger_post('${TEST_PERIOD_KIND}', 'ai-credit-test-period:' || k, p_actor,
      'pre-launch AI cost (setup and testing) is the Fleet''s, not the agent''s', 'owner', k, NULL, NULL, NULL, NULL, now(), jsonb_build_array(
        jsonb_build_object('account', fleet_ledger_account(k, 'agent_cash'), 'side', 'D', 'amount', v),
        jsonb_build_object('account', fleet_ledger_account(k, 'agent_expense'), 'side', 'C', 'amount', v),
        jsonb_build_object('account', 'fleet:expense', 'side', 'D', 'amount', v),
        jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', v)));
    v_j := v_j || to_jsonb(v_id);
  END LOOP;
  -- 3. the sub-penny tax still carried for pre-launch usage: waived
  UPDATE fleet_ai_credit_cost_accrual SET unposted_micro = 0 WHERE unposted_micro > 0;
  v_result := jsonb_build_object('agentsMinor', pv->'agentsMinor', 'agentsTotalMinor', pv->'agentsTotalMinor', 'ownerPayableWrittenOffMinor', v_payable,
    'waivedCarriedMicro', pv->'carriedMicro', 'journals', v_j);
  INSERT INTO fleet_ai_credit_test_period_runs (id, result, applied_by) VALUES (1, v_result, p_actor);
  PERFORM fleet_event('ai_credit_test_period_written_off', NULL, p_actor, v_result - 'journals');
  RETURN jsonb_build_object('ok', true) || v_result;
END $$;

${restateRaw(V73_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V74) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
])}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

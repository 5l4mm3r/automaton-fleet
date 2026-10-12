/**
 * Schema v73 — the one-time historical acquisition-cost correction (owner instruction, 2026-10-12).
 *
 * v72 prices the tax / fees on AI credit for every consumption DRAW from a lot. The AI charges made before the lots existed
 * (before v70: the calls the v69 opening brought in as owed to the owner, at the provider's pre-tax price) were drawn from no
 * lot, so their tax share was never recognised. This correction recognises it exactly once, with v72's own mechanism:
 *
 *   - the rate is the opening pool's evidenced ratio — the receipts' total charged against the credit bought — which the
 *     owner states and which must reproduce the acquisition cost already recorded on that lot (never assumed);
 *   - the base is each historical AI-charge journal's recognised pre-tax expense (whole pence, as posted);
 *   - the payer is the ORIGINAL attribution: an agent's inference → that agent (agent expense / agent cash); Fleet Control
 *     reviews and treasury-paid owner turns → the treasury (Fleet expense / treasury); a journal is attributed only when its
 *     postings, its agent and its provider evidence agree (its cognition records, or for a Fleet Control review the
 *     controller's provider consumption) — anything else is REPORTED, never posted or guessed;
 *   - each journal's share goes into the opening lot's (owner-funded) per-payer accrual, and v72's cost pass posts it in
 *     whole pence (remainders carried as for any draw): D payer expense / C payer cash, D treasury owner-reimbursable /
 *     C owner payable. The pre-tax charge was recognised once by the original journal; this is only the tax on it.
 *
 * Applied once: each corrected journal is recorded (primary key), and the run itself is a single row; a second application
 * returns the first run. `fleet_ai_credit_historical_scan` / `_preview` are read-only.
 */
import { PROVIDER_PAID_KINDS } from "./migrations-phase66.js";
import { OPENING_KIND } from "./migrations-phase69.js";
import { V72_SQL } from "./migrations-phase72.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
export const EVENT_ROUTES_V73 = Object.freeze({ P3_SUMMARY: ["ai_credit_historical_cost_applied"] });
const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');`;
const REVIEW_KINDS = ["spend_review_charge", "knowledge_review_charge"] as const;

export const V73_SQL = `
CREATE TABLE fleet_ai_credit_historical_runs (
  id            integer     PRIMARY KEY CHECK (id = 1),          -- one run, ever
  provider      text        NOT NULL,
  lot_id        uuid        NOT NULL REFERENCES fleet_ai_credit_lots(lot_id),
  credit_usd_cents bigint   NOT NULL CHECK (credit_usd_cents > 0),
  total_usd_cents  bigint   NOT NULL CHECK (total_usd_cents >= credit_usd_cents),
  evidence      text        NOT NULL CHECK (length(evidence) BETWEEN 3 AND 200),
  result        jsonb       NOT NULL,
  applied_by    text        NOT NULL,
  applied_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_ai_credit_historical_runs_no_change BEFORE UPDATE OR DELETE ON fleet_ai_credit_historical_runs FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TABLE fleet_ai_credit_historical_costs (
  journal_id  uuid        PRIMARY KEY REFERENCES fleet_ledger_journal(journal_id),   -- each historical charge corrected once
  lot_id      uuid        NOT NULL REFERENCES fleet_ai_credit_lots(lot_id),
  payer       text        NOT NULL,                                                  -- 'agent:<id>' or 'treasury'
  base_minor  bigint      NOT NULL CHECK (base_minor > 0),
  cost_micro  bigint      NOT NULL CHECK (cost_micro >= 0),
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_ai_credit_historical_costs_no_change BEFORE UPDATE OR DELETE ON fleet_ai_credit_historical_costs FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- Every AI-charge journal made before the AI-credit lots began (v70's opening pool), with its attribution or the reason it
-- has none. Read-only.
CREATE FUNCTION fleet_ai_credit_historical_scan(p_provider text)
RETURNS TABLE (journal_id uuid, kind text, agent_id text, payer text, base_minor bigint, reason text) LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_ai_credit_lots; j record; v_exp bigint; v_shape text; v_cog integer; v_cog_bad integer; v_cog_payer text; v_payer text; v_why text;
BEGIN
  SELECT * INTO o FROM fleet_ai_credit_lots WHERE provider = p_provider AND external_ref = 'opening:v70:' || p_provider;
  IF o.lot_id IS NULL THEN RETURN; END IF;
  FOR j IN SELECT x.journal_id, x.kind, x.agent_id, x.recorded_at FROM fleet_ledger_journal x
            WHERE x.kind IN (${q(PROVIDER_PAID_KINDS)}) AND x.recorded_at < o.purchased_at
              AND x.reverses_journal_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM fleet_ledger_journal r WHERE r.reverses_journal_id = x.journal_id)
            ORDER BY x.seq LOOP
    v_payer := NULL; v_why := NULL;
    -- the recognised pre-tax expense and the posting shape (expense debit and the cash it came from, owner legs aside)
    SELECT COALESCE(sum(p.amount_cents) FILTER (WHERE a.class IN ('agent_expense', 'fleet_expense') AND p.side = 'D'), 0),
           string_agg(p.account_id || ':' || p.side, ',' ORDER BY p.account_id, p.side)
             FILTER (WHERE p.account_id NOT IN ('fleet:owner:payable', 'fleet:treasury:owner_reimbursable'))
      INTO v_exp, v_shape
      FROM fleet_ledger_postings p JOIN fleet_ledger_accounts a ON a.account_id = p.account_id WHERE p.journal_id = j.journal_id;
    SELECT count(*), count(*) FILTER (WHERE g.provider IS DISTINCT FROM p_provider), min(CASE WHEN g.payer = 'treasury' THEN 'treasury' ELSE 'agent:' || g.agent_id END)
      INTO v_cog, v_cog_bad, v_cog_payer FROM fleet_cognition_log g WHERE g.journal_id = j.journal_id;
    IF v_exp <= 0 THEN v_why := 'no recognised expense';
    ELSIF j.agent_id IS NOT NULL AND v_shape = fleet_ledger_account(j.agent_id, 'agent_cash') || ':C,' || fleet_ledger_account(j.agent_id, 'agent_expense') || ':D' THEN
      IF v_cog = 0 THEN v_why := 'agent charge without a cognition record';
      ELSIF v_cog_bad > 0 THEN v_why := 'not a ' || p_provider || ' call';
      ELSIF v_cog_payer IS DISTINCT FROM 'agent:' || j.agent_id OR (SELECT count(DISTINCT COALESCE(g.payer, '') || g.agent_id) FROM fleet_cognition_log g WHERE g.journal_id = j.journal_id) > 1 THEN
        v_why := 'cognition records disagree with the journal''s agent';
      ELSE v_payer := 'agent:' || j.agent_id; END IF;
    ELSIF j.agent_id IS NULL AND v_shape = 'fleet:expense:D,fleet:treasury:unallocated:C' THEN
      IF v_cog > 0 THEN
        IF v_cog_bad > 0 THEN v_why := 'not a ' || p_provider || ' call';
        ELSIF v_cog_payer IS DISTINCT FROM 'treasury' OR (SELECT count(DISTINCT COALESCE(g.payer, '')) FROM fleet_cognition_log g WHERE g.journal_id = j.journal_id) > 1 THEN
          v_why := 'cognition records disagree with a treasury charge';
        ELSE v_payer := 'treasury'; END IF;
      ELSIF j.kind IN (${q(REVIEW_KINDS)}) AND EXISTS (SELECT 1 FROM fleet_provider_credit_events e
              WHERE e.kind = 'consumption' AND e.provider = p_provider AND e.recorded_by = 'controller:' || j.kind
                AND e.at BETWEEN j.recorded_at - interval '1 hour' AND j.recorded_at)
            AND NOT EXISTS (SELECT 1 FROM fleet_provider_credit_events e
              WHERE e.kind = 'consumption' AND e.provider IS DISTINCT FROM p_provider AND e.recorded_by = 'controller:' || j.kind
                AND e.at BETWEEN j.recorded_at - interval '1 hour' AND j.recorded_at) THEN
        v_payer := 'treasury';                       -- Fleet Control review: the controller's own consumption of this provider
      ELSE v_why := 'treasury charge without provider evidence'; END IF;
    ELSE v_why := 'unexpected posting shape (' || COALESCE(v_shape, 'none') || ')';
    END IF;
    journal_id := j.journal_id; kind := j.kind; agent_id := j.agent_id; payer := v_payer; base_minor := v_exp; reason := v_why;
    RETURN NEXT;
  END LOOP;
END $$;

-- The correction a given evidence would make, by payer, and what cannot be attributed. Read-only.
CREATE FUNCTION fleet_ai_credit_historical_preview(p_provider text, p_credit_usd_cents bigint, p_total_usd_cents bigint) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_ai_credit_lots; v_run fleet_ai_credit_historical_runs; v_by jsonb; v_un jsonb; v_check text;
BEGIN
  SELECT * INTO v_run FROM fleet_ai_credit_historical_runs WHERE id = 1;
  SELECT * INTO o FROM fleet_ai_credit_lots WHERE provider = p_provider AND external_ref = 'opening:v70:' || p_provider;
  v_check := CASE
    WHEN o.lot_id IS NULL THEN 'no opening pool for ' || p_provider
    WHEN o.acq_total_usd_cents IS NULL THEN 'record the opening pool''s acquisition cost first (economy-ai-credit-lot-cost)'
    WHEN p_credit_usd_cents IS NULL OR p_total_usd_cents IS NULL OR p_credit_usd_cents <= 0 OR p_total_usd_cents < p_credit_usd_cents THEN 'the total charged is at least the credit bought'
    WHEN CEIL(o.usd_purchased::numeric / 1000000 * p_total_usd_cents / p_credit_usd_cents)::bigint <> o.acq_total_usd_cents THEN
      'these figures do not reproduce the opening pool''s recorded acquisition cost (' || o.acq_evidence || ')'
    WHEN NOT EXISTS (SELECT 1 FROM fleet_ledger_journal WHERE kind = '${OPENING_KIND}') THEN 'record the AI-credit opening first (economy-ai-credit-opening)'
  END;
  SELECT COALESCE(jsonb_object_agg(payer, jsonb_build_object('journals', n, 'baseMinor', b,
           'costMicro', (b::numeric * 1000000 * (p_total_usd_cents - p_credit_usd_cents) / NULLIF(p_credit_usd_cents, 0))::bigint)), '{}'::jsonb)
    INTO v_by FROM (SELECT s.payer, count(*) n, sum(s.base_minor) b FROM fleet_ai_credit_historical_scan(p_provider) s
                     WHERE s.payer IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fleet_ai_credit_historical_costs c WHERE c.journal_id = s.journal_id)
                     GROUP BY s.payer) x;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('journalId', s.journal_id, 'kind', s.kind, 'agentId', s.agent_id, 'baseMinor', s.base_minor, 'reason', s.reason)), '[]'::jsonb)
    INTO v_un FROM fleet_ai_credit_historical_scan(p_provider) s WHERE s.payer IS NULL;
  RETURN jsonb_build_object('provider', p_provider, 'lotId', o.lot_id, 'ratio', round(p_total_usd_cents::numeric / NULLIF(p_credit_usd_cents, 0), 4),
    'refused', v_check, 'alreadyApplied', v_run.id IS NOT NULL, 'byPayer', v_by, 'unattributed', v_un,
    'note', 'costMicro is GBP micro-pence; whole pence are posted per payer, remainders carried with the opening pool');
END $$;

-- Owner: apply the correction (once).
CREATE FUNCTION fleet_admin_ai_credit_historical_cost(p_provider text, p_credit_usd_cents bigint, p_total_usd_cents bigint, p_evidence text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_run fleet_ai_credit_historical_runs; pv jsonb; o fleet_ai_credit_lots; s record; v_micro bigint; v_pass jsonb; v_result jsonb; v_n integer := 0;
BEGIN
  ${OWNER_ACTOR}
  IF p_evidence IS NULL OR length(p_evidence) < 3 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: name the receipts'; END IF;
  LOCK TABLE fleet_ai_credit_historical_runs IN EXCLUSIVE MODE;
  SELECT * INTO v_run FROM fleet_ai_credit_historical_runs WHERE id = 1;
  IF v_run.id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'appliedAt', v_run.applied_at, 'appliedBy', v_run.applied_by) || v_run.result;
  END IF;
  pv := fleet_ai_credit_historical_preview(p_provider, p_credit_usd_cents, p_total_usd_cents);
  IF pv->>'refused' IS NOT NULL THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: %', pv->>'refused'; END IF;
  SELECT * INTO o FROM fleet_ai_credit_lots WHERE lot_id = (pv->>'lotId')::uuid FOR UPDATE;
  FOR s IN SELECT * FROM fleet_ai_credit_historical_scan(p_provider) x WHERE x.payer IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM fleet_ai_credit_historical_costs c WHERE c.journal_id = x.journal_id) LOOP
    v_micro := (s.base_minor::numeric * 1000000 * (p_total_usd_cents - p_credit_usd_cents) / p_credit_usd_cents)::bigint;
    INSERT INTO fleet_ai_credit_historical_costs (journal_id, lot_id, payer, base_minor, cost_micro) VALUES (s.journal_id, o.lot_id, s.payer, s.base_minor, v_micro);
    INSERT INTO fleet_ai_credit_cost_accrual (lot_id, payer, unposted_micro) VALUES (o.lot_id, s.payer, v_micro)
      ON CONFLICT (lot_id, payer) DO UPDATE SET unposted_micro = fleet_ai_credit_cost_accrual.unposted_micro + EXCLUDED.unposted_micro;
    v_n := v_n + 1;
  END LOOP;
  -- v72's own pass posts whole pence per payer, funded as the opening pool (owed to the owner)
  v_pass := fleet_ai_credit_cost_pass();
  v_result := jsonb_build_object('journals', v_n, 'byPayer', pv->'byPayer', 'unattributed', pv->'unattributed', 'ratio', pv->'ratio', 'costPass', v_pass,
    'posted', (SELECT COALESCE(jsonb_object_agg(a.payer, jsonb_build_object('postedMinor', a.posted_minor, 'carriedMicro', a.unposted_micro)), '{}'::jsonb)
                 FROM fleet_ai_credit_cost_accrual a WHERE a.lot_id = o.lot_id));
  INSERT INTO fleet_ai_credit_historical_runs (id, provider, lot_id, credit_usd_cents, total_usd_cents, evidence, result, applied_by)
    VALUES (1, p_provider, o.lot_id, p_credit_usd_cents, p_total_usd_cents, left(p_evidence, 200), v_result, p_actor);
  PERFORM fleet_event('ai_credit_historical_cost_applied', NULL, p_actor, jsonb_build_object('provider', p_provider, 'journals', v_n,
    'ratio', pv->'ratio', 'unattributed', jsonb_array_length(pv->'unattributed')));
  IF jsonb_array_length(pv->'unattributed') > 0 THEN
    PERFORM fleet_event('ai_credit_reconcile', NULL, p_actor, jsonb_build_object('provider', p_provider, 'reason', 'historical_unattributed',
      'journals', jsonb_array_length(pv->'unattributed'), 'note', 'historical AI charges without a reliable attribution: no tax share posted'));
  END IF;
  RETURN jsonb_build_object('ok', true) || v_result;
END $$;

${restateRaw(V72_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V73) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
])}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

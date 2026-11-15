/**
 * Schema v74 — pre-launch test costs are not the agents' and not owed to the owner (owner decisions, 2026-10-13:
 * "Agents don't owe me anything for testing fees"; "Nothing is owed"; the £21.87 payable is waived as contributed capital;
 * future reimbursement stays separate from fee withdrawals; an EXPLICIT launch boundary, not "any resume").
 *
 * The launch boundary is its own record: `fleet_admin_launch_boundary_record` (owner, once, immutable) stamps the moment
 * the Fleet launched. Pausing or resuming an agent never sets or moves it.
 *
 * The write-off (owner) covers the AI-cost journals recorded BEFORE the boundary — or, while no boundary is recorded yet,
 * before now (the Fleet has not launched) — that it has not covered already. Each journal is covered at most once
 * (`fleet_ai_credit_test_period_items`), so it may be run again before launch (e.g. once more at launch) without ever
 * double-counting, and never reaches past the boundary:
 *   - an agent's AI cost in those journals (pre-tax charges and their tax share) moves to the Fleet:
 *       D agent cash / C agent expense   and   D Fleet expense / C treasury unallocated   (recognised once: moved)
 *   - what those journals made owed to the owner is waived as the owner's contributed capital, and the treasury cash held
 *     for it is released:   D owner payable / C owner capital   and   D treasury unallocated / C treasury owner-reimbursable
 *   - sub-penny tax still carried for pre-boundary usage is waived (recorded per lot and payer; never posted).
 * After the boundary nothing changes: owner-funded AI credit is owed to the owner as it is used (v69) and is reimbursed
 * only by its own authorised owner payment — never netted against fee withdrawals; agents bear their own work (v72).
 * The capital to back is unchanged (money moves only between accounts the backing already counts).
 */
import { PROVIDER_PAID_KINDS } from "./migrations-phase66.js";
import { OPENING_KIND, OWNER_PAYABLE_ACCOUNT, REIMBURSABLE_ACCOUNT } from "./migrations-phase69.js";
import { V73_SQL } from "./migrations-phase73.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
export const EVENT_ROUTES_V74 = Object.freeze({ P3_SUMMARY: ["ai_credit_test_period_written_off"], P2_IMPORTANT: ["fleet_launch_boundary_recorded"] });
export const TEST_PERIOD_KIND = "ai_credit_test_period_writeoff";
const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');`;
/** Journals whose agent cost or owner payable belongs to the AI-cost history. */
const SCOPE_KINDS = [...PROVIDER_PAID_KINDS, "ai_credit_acquisition_cost", OPENING_KIND];

export const V74_SQL = `
ALTER TABLE fleet_ledger_kinds DISABLE TRIGGER fleet_ledger_kinds_no_change;
INSERT INTO fleet_ledger_kinds (kind, requires_external_ref, allowed_sources, multi_agent, description, provenance) VALUES
  ('${TEST_PERIOD_KIND}', false, ARRAY['owner'], false,
   'Pre-launch test costs: an agent''s AI cost moved to the Fleet, or the owner''s pre-launch AI-credit payable waived as contributed capital', 'correction');
ALTER TABLE fleet_ledger_kinds ENABLE TRIGGER fleet_ledger_kinds_no_change;
INSERT INTO fleet_ledger_rules (kind, class, side) VALUES
  ('${TEST_PERIOD_KIND}','agent_cash','D'), ('${TEST_PERIOD_KIND}','agent_expense','C'),
  ('${TEST_PERIOD_KIND}','fleet_expense','D'), ('${TEST_PERIOD_KIND}','treasury_cash','C'),
  ('${TEST_PERIOD_KIND}','owner_payable','D'), ('${TEST_PERIOD_KIND}','owner_capital','C'), ('${TEST_PERIOD_KIND}','treasury_cash','D')
ON CONFLICT DO NOTHING;

-- The launch boundary: one row, set once by the owner, never changed.
CREATE TABLE fleet_launch_boundary (
  id           integer     PRIMARY KEY CHECK (id = 1),
  launched_at  timestamptz NOT NULL,
  note         text        NOT NULL CHECK (length(note) BETWEEN 3 AND 300),
  recorded_by  text        NOT NULL,
  recorded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_launch_boundary_no_change BEFORE UPDATE OR DELETE ON fleet_launch_boundary FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_ai_credit_test_period_runs (
  seq         bigserial   PRIMARY KEY,
  cutoff      timestamptz NOT NULL,
  boundary    boolean     NOT NULL,                       -- true: the cutoff is the recorded launch boundary
  result      jsonb       NOT NULL,
  applied_by  text        NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_ai_credit_test_period_runs_no_change BEFORE UPDATE OR DELETE ON fleet_ai_credit_test_period_runs FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TABLE fleet_ai_credit_test_period_items (
  journal_id  uuid    PRIMARY KEY REFERENCES fleet_ledger_journal(journal_id),   -- each journal covered at most once
  run_seq     bigint  NOT NULL REFERENCES fleet_ai_credit_test_period_runs(seq) DEFERRABLE INITIALLY DEFERRED,
  agent_id    text,
  agent_minor bigint  NOT NULL CHECK (agent_minor >= 0),
  owner_minor bigint  NOT NULL CHECK (owner_minor >= 0)
);
CREATE TRIGGER fleet_ai_credit_test_period_items_no_change BEFORE UPDATE OR DELETE ON fleet_ai_credit_test_period_items FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TABLE fleet_ai_credit_test_period_waivers (
  run_seq bigint NOT NULL REFERENCES fleet_ai_credit_test_period_runs(seq) DEFERRABLE INITIALLY DEFERRED,
  lot_id  uuid   NOT NULL REFERENCES fleet_ai_credit_lots(lot_id),
  payer   text   NOT NULL,
  micro   bigint NOT NULL CHECK (micro > 0),
  PRIMARY KEY (run_seq, lot_id, payer)
);
CREATE TRIGGER fleet_ai_credit_test_period_waivers_no_change BEFORE UPDATE OR DELETE ON fleet_ai_credit_test_period_waivers FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- Owner: record the launch (once). Independent of any agent's pause or resume.
CREATE FUNCTION fleet_admin_launch_boundary_record(p_note text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE b fleet_launch_boundary;
BEGIN
  ${OWNER_ACTOR}
  IF p_note IS NULL OR length(p_note) < 3 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a note describing the launch'; END IF;
  LOCK TABLE fleet_launch_boundary IN EXCLUSIVE MODE;
  SELECT * INTO b FROM fleet_launch_boundary WHERE id = 1;
  IF b.id IS NOT NULL THEN RETURN jsonb_build_object('ok', true, 'already', true, 'launchedAt', b.launched_at, 'note', b.note, 'recordedBy', b.recorded_by); END IF;
  INSERT INTO fleet_launch_boundary (id, launched_at, note, recorded_by) VALUES (1, now(), left(p_note, 300), p_actor) RETURNING * INTO b;
  PERFORM fleet_event('fleet_launch_boundary_recorded', NULL, p_actor, jsonb_build_object('launchedAt', b.launched_at, 'note', b.note));
  RETURN jsonb_build_object('ok', true, 'launchedAt', b.launched_at, 'note', b.note);
END $$;

-- The journals the write-off would cover now (read-only): before the cutoff, in scope, not yet covered.
CREATE FUNCTION fleet_ai_credit_test_period_scan(p_cutoff timestamptz)
RETURNS TABLE (journal_id uuid, agent_id text, agent_minor bigint, owner_minor bigint) LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT j.journal_id, j.agent_id,
         GREATEST(0, COALESCE(sum(CASE WHEN j.agent_id IS NOT NULL AND p.account_id = fleet_ledger_account(j.agent_id, 'agent_expense')
                                        THEN CASE WHEN p.side = 'D' THEN p.amount_cents ELSE -p.amount_cents END END), 0))::bigint,
         GREATEST(0, COALESCE(sum(CASE WHEN p.account_id = '${OWNER_PAYABLE_ACCOUNT}'
                                        THEN CASE WHEN p.side = 'C' THEN p.amount_cents ELSE -p.amount_cents END END), 0))::bigint
    FROM fleet_ledger_journal j JOIN fleet_ledger_postings p ON p.journal_id = j.journal_id
   WHERE j.kind IN (${q(SCOPE_KINDS)}) AND j.recorded_at < p_cutoff
     AND j.reverses_journal_id IS NULL AND NOT EXISTS (SELECT 1 FROM fleet_ledger_journal r WHERE r.reverses_journal_id = j.journal_id)
     AND NOT EXISTS (SELECT 1 FROM fleet_ai_credit_test_period_items i WHERE i.journal_id = j.journal_id)
   GROUP BY j.journal_id, j.agent_id
$$;

-- Sub-penny tax carried for pre-cutoff usage, per lot and payer (posting consumes the oldest accrual first).
CREATE FUNCTION fleet_ai_credit_test_period_carry(p_cutoff timestamptz)
RETURNS TABLE (lot_id uuid, payer text, micro bigint) LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT a.lot_id, a.payer, LEAST(a.unposted_micro, GREATEST(0,
           COALESCE((SELECT sum(h.cost_micro) FROM fleet_ai_credit_historical_costs h WHERE h.lot_id = a.lot_id AND h.payer = a.payer AND h.at < p_cutoff), 0)
         + COALESCE((SELECT sum(c.cost_micro) FROM fleet_ai_credit_draw_costs c JOIN fleet_ai_credit_draws d ON d.draw_id = c.draw_id
                      WHERE c.lot_id = a.lot_id AND c.payer = a.payer AND d.at < p_cutoff), 0)
         - a.posted_minor * 1000000
         - COALESCE((SELECT sum(w.micro) FROM fleet_ai_credit_test_period_waivers w WHERE w.lot_id = a.lot_id AND w.payer = a.payer), 0)))::bigint
    FROM fleet_ai_credit_cost_accrual a WHERE a.unposted_micro > 0
$$;

-- What the write-off would do now (read-only).
CREATE FUNCTION fleet_ai_credit_test_period_preview() RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE b fleet_launch_boundary; v_cut timestamptz; v_agents jsonb; v_atotal bigint; v_owner bigint; v_n integer; v_carry bigint; v_refused text;
BEGIN
  SELECT * INTO b FROM fleet_launch_boundary WHERE id = 1;
  v_cut := COALESCE(b.launched_at, now());
  SELECT COALESCE(jsonb_object_agg(x.agent_id, x.m) FILTER (WHERE x.agent_id IS NOT NULL AND x.m > 0), '{}'::jsonb), COALESCE(sum(x.m), 0)
    INTO v_agents, v_atotal FROM (SELECT s.agent_id, sum(s.agent_minor)::bigint AS m FROM fleet_ai_credit_test_period_scan(v_cut) s GROUP BY s.agent_id) x;
  SELECT COALESCE(sum(s.owner_minor), 0), count(*) INTO v_owner, v_n FROM fleet_ai_credit_test_period_scan(v_cut) s;
  SELECT COALESCE(sum(c.micro), 0) INTO v_carry FROM fleet_ai_credit_test_period_carry(v_cut) c;
  v_refused := CASE
    WHEN fleet_ledger_balance('${OWNER_PAYABLE_ACCOUNT}') < v_owner THEN 'the owner payable is below what these journals made owed'
    WHEN fleet_ledger_balance('${REIMBURSABLE_ACCOUNT}') < v_owner THEN 'the treasury holds less for the owner than is to be waived'
    WHEN fleet_ledger_balance('fleet:treasury:unallocated') + v_owner < v_atotal THEN 'the treasury cannot cover the agents'' test costs'
  END;
  RETURN jsonb_build_object('cutoff', v_cut, 'launchBoundary', CASE WHEN b.id IS NULL THEN NULL ELSE jsonb_build_object('launchedAt', b.launched_at, 'note', b.note) END,
    'journals', v_n, 'agentsMinor', v_agents, 'agentsTotalMinor', v_atotal, 'ownerPayableWaivedMinor', v_owner, 'carriedMicro', v_carry, 'refused', v_refused,
    'note', CASE WHEN b.id IS NULL THEN 'no launch recorded: covers AI costs recorded before now; may run again before launch (each journal once)'
                 ELSE 'covers AI costs recorded before the launch boundary only' END);
END $$;

-- Owner: write the pre-launch test costs off (each journal at most once; never past the launch boundary).
CREATE FUNCTION fleet_admin_ai_credit_test_period_writeoff(p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE pv jsonb; b fleet_launch_boundary; v_cut timestamptz; v_seq bigint; k text; v bigint; v_owner bigint; v_j jsonb := '[]'::jsonb; v_id uuid; v_result jsonb; c record; v_waived bigint := 0;
BEGIN
  ${OWNER_ACTOR}
  LOCK TABLE fleet_ai_credit_test_period_runs IN EXCLUSIVE MODE;
  LOCK TABLE fleet_ledger_head IN EXCLUSIVE MODE;          -- no AI cost is added while this runs
  SELECT * INTO b FROM fleet_launch_boundary WHERE id = 1;
  v_cut := COALESCE(b.launched_at, now());
  pv := fleet_ai_credit_test_period_preview();
  IF pv->>'refused' IS NOT NULL THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: %', pv->>'refused'; END IF;
  IF (pv->>'journals')::integer = 0 AND (pv->>'carriedMicro')::bigint = 0 THEN
    RETURN jsonb_build_object('ok', true, 'nothingToCover', true, 'cutoff', v_cut);
  END IF;
  v_seq := nextval(pg_get_serial_sequence('fleet_ai_credit_test_period_runs', 'seq'));   -- the run row is written last, with its result
  INSERT INTO fleet_ai_credit_test_period_items (journal_id, run_seq, agent_id, agent_minor, owner_minor)
    SELECT s.journal_id, v_seq, s.agent_id, s.agent_minor, s.owner_minor FROM fleet_ai_credit_test_period_scan(v_cut) s;
  -- 1. the owner's pre-launch AI-credit payable: waived as contributed capital; the cash held for it released
  v_owner := (pv->>'ownerPayableWaivedMinor')::bigint;
  IF v_owner > 0 THEN
    v_id := fleet_ledger_post('${TEST_PERIOD_KIND}', 'ai-credit-test-period:' || v_seq || ':owner', p_actor,
      'pre-launch AI credit (setup and testing): payable waived by the owner as contributed capital', 'owner', NULL, NULL, NULL, NULL, NULL, now(), jsonb_build_array(
        jsonb_build_object('account', '${OWNER_PAYABLE_ACCOUNT}', 'side', 'D', 'amount', v_owner),
        jsonb_build_object('account', 'fleet:owner:capital', 'side', 'C', 'amount', v_owner),
        jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', v_owner),
        jsonb_build_object('account', '${REIMBURSABLE_ACCOUNT}', 'side', 'C', 'amount', v_owner)));
    v_j := v_j || to_jsonb(v_id);
  END IF;
  -- 2. each agent's pre-launch AI cost becomes the Fleet's launch cost
  FOR k, v IN SELECT key, value::bigint FROM jsonb_each_text(pv->'agentsMinor') ORDER BY key LOOP
    v_id := fleet_ledger_post('${TEST_PERIOD_KIND}', 'ai-credit-test-period:' || v_seq || ':' || k, p_actor,
      'pre-launch AI cost (setup and testing) is the Fleet''s, not the agent''s', 'owner', k, NULL, NULL, NULL, NULL, now(), jsonb_build_array(
        jsonb_build_object('account', fleet_ledger_account(k, 'agent_cash'), 'side', 'D', 'amount', v),
        jsonb_build_object('account', fleet_ledger_account(k, 'agent_expense'), 'side', 'C', 'amount', v),
        jsonb_build_object('account', 'fleet:expense', 'side', 'D', 'amount', v),
        jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', v)));
    v_j := v_j || to_jsonb(v_id);
  END LOOP;
  -- 3. sub-penny tax still carried for pre-cutoff usage: waived (recorded)
  FOR c IN SELECT * FROM fleet_ai_credit_test_period_carry(v_cut) x WHERE x.micro > 0 LOOP
    INSERT INTO fleet_ai_credit_test_period_waivers (run_seq, lot_id, payer, micro) VALUES (v_seq, c.lot_id, c.payer, c.micro);
    UPDATE fleet_ai_credit_cost_accrual SET unposted_micro = unposted_micro - c.micro WHERE lot_id = c.lot_id AND payer = c.payer;
    v_waived := v_waived + c.micro;
  END LOOP;
  v_result := jsonb_build_object('run', v_seq, 'cutoff', v_cut, 'boundary', b.id IS NOT NULL, 'journalsCovered', (pv->>'journals')::integer,
    'agentsMinor', pv->'agentsMinor', 'agentsTotalMinor', pv->'agentsTotalMinor', 'ownerPayableWaivedMinor', v_owner, 'waivedCarriedMicro', v_waived);
  INSERT INTO fleet_ai_credit_test_period_runs (seq, cutoff, boundary, result, applied_by) VALUES (v_seq, v_cut, b.id IS NOT NULL, v_result || jsonb_build_object('journals', v_j), p_actor);
  PERFORM fleet_event('ai_credit_test_period_written_off', NULL, p_actor, v_result);
  RETURN jsonb_build_object('ok', true, 'journals', v_j) || v_result;
END $$;

${restateRaw(V73_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V74) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
])}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

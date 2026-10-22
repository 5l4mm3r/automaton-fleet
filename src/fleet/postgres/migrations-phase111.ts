/**
 * Schema v111 — model-call costs are never lost (launch review, 2026-10-22: "Five minutes may expire permission to start
 * work; it cannot make already incurred costs disappear … If an unexpected real overrun occurs, record it honestly and stop
 * further unauthorized exposure. The owner must choose liability allocation for exceptional losses").
 *
 * Two leaks, both reproduced on v110 (fleet-v111-cognition-settlement-pg):
 *  1. A reservation older than 5 minutes was DELETED by the agent's next authorisation. The controller makes the provider
 *     call; if it died, restarted or failed to write after the provider had billed, the late record found no reservation
 *     (FLEET_COGNITION_NOT_AUTHORIZED): no log row, no charge to anyone, no provider-credit consumption.
 *  2. A recorded cost above its reservation was charged to the payer only up to the reservation, while provider credit was
 *     debited in full: the excess was booked to no one. (The reservation is meant to be a true upper bound — costBoundMicro —
 *     so an overrun is a platform fault: an image larger than its estimate, or tier prices that differ from the provider's.)
 *
 * Now:
 *  - An expired reservation stops blocking the next call but is KEPT as an unresolved hold (expired_at): its ledger-currency
 *    estimate stays held against the agent's cash, its USD estimate against provider credit, and the owner is told (P1).
 *  - A late result settles that reservation by its own request id, exactly once (the log's unique request id; only that
 *    reservation is removed — before, recording any call deleted every reservation of the agent).
 *  - A result that never comes is resolved by the owner from provider evidence: billed (settled at the reservation, as an
 *    estimate) or not billed (released). Nothing is guessed automatically.
 *  - An overrun is charged up to the reservation as before and the excess is recorded as a cost exception (P1); the agent
 *    makes no further paid call until the owner allocates it (to the agent, or to the treasury as fleet expense).
 *  - A charge the agent's cash cannot cover (late settlement after its cash moved) is charged as far as cash allows and the
 *    rest recorded the same way — never a failed write that loses the record.
 * Allocation is the owner's decision; this migration books nothing for an exception until the owner chooses.
 */
import { restate as restateRaw } from "./migrations-phase42.js";
import { V13_SQL } from "./migrations-phase13.js";
import { V21_SQL } from "./migrations-phase21.js";
import { V62_SQL } from "./migrations-phase62.js";
import { V69_SQL, OWNER_PAYABLE_ACCOUNT, REIMBURSABLE_ACCOUNT } from "./migrations-phase69.js";
import { V109_SQL } from "./migrations-phase109.js";
import { V96_SQL } from "./migrations-phase96.js";
import { V56_SQL } from "./migrations-phase56.js";
import { V100_SQL, OBLIGATIONS_MAX } from "./migrations-phase100.js";
import { V105_SQL } from "./migrations-phase105.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));

export const EVENT_ROUTES_V111 = Object.freeze({
  P1_HIGH: ["cognition_reservation_unresolved", "cognition_cost_exception"],
  P3_SUMMARY: ["cognition_reservation_settled_late", "cognition_reservation_resolved", "cognition_cost_exception_allocated", "engineering_cognition_recorded"],
});
/** Minutes after which a reservation no longer blocks the agent's next call (unchanged since v13). */
export const RESERVATION_EXPIRY_MINUTES = 5;

const PURGE = `  DELETE FROM fleet_cognition_inflight WHERE agent_id = p_agent AND started_at <= now() - interval '5 minutes';`;
const EXPIRE = `  -- v111: an expired reservation no longer blocks this call, but it is kept: its cost may already be incurred. It stays
  -- held (cash below, provider credit with every other reservation) until its result is recorded or the owner resolves it.
  WITH x AS (UPDATE fleet_cognition_inflight SET expired_at = now()
              WHERE agent_id = p_agent AND expired_at IS NULL AND started_at <= now() - interval '${RESERVATION_EXPIRY_MINUTES} minutes' RETURNING request_id)
  SELECT count(*) INTO v_expired FROM x;
  IF v_expired > 0 THEN
    PERFORM fleet_event('cognition_reservation_unresolved', p_agent, 'controller', jsonb_build_object('count', v_expired,
      'note', 'a model call has no recorded result after ${RESERVATION_EXPIRY_MINUTES} minutes; its reservation stays held until the result arrives or the owner resolves it from provider evidence'));
  END IF;
  -- v111: an unallocated cost overrun stops further paid calls of this agent until the owner allocates it.
  IF EXISTS (SELECT 1 FROM fleet_cognition_cost_exceptions WHERE agent_id = p_agent AND kind = 'overrun' AND status = 'unallocated') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_COST_EXCEPTION');
  END IF;`;
const BUSY = `  IF EXISTS (SELECT 1 FROM fleet_cognition_inflight WHERE agent_id = p_agent) THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_BUSY'); END IF;`;
const BUSY_LIVE = `  IF EXISTS (SELECT 1 FROM fleet_cognition_inflight WHERE agent_id = p_agent AND expired_at IS NULL) THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_COGNITION_BUSY'); END IF;`;
const DECL = `DECLARE a fleet_agents; s jsonb; e jsonb; v_id uuid := gen_random_uuid();`;

const AUTHORIZE = restate(V21_SQL, "svc_cognition_authorize", [
  [DECL, `${DECL} v_expired integer; v_held bigint;`],
  [PURGE, EXPIRE],
  [BUSY, BUSY_LIVE],
  [`  v_unposted := (s ->> 'unpostedMicrocents')::bigint;`,
   `  v_unposted := (s ->> 'unpostedMicrocents')::bigint;
  -- v111: unresolved (expired) reservations the agent pays for are held against its cash and equity.
  SELECT COALESCE(sum(estimate_cents), 0) * 1000000 INTO v_held FROM fleet_cognition_inflight
   WHERE agent_id = p_agent AND expired_at IS NOT NULL AND payer IS DISTINCT FROM 'treasury';
  v_unposted := v_unposted + v_held;`],
]);
// v62's treasury-paid copy (owner conversation turns) had the same purge: it would have deleted the agent's unresolved holds.
const AUTHORIZE_TREASURY = restate(V62_SQL, "fleet_cognition_authorize_treasury", [
  [DECL, `${DECL} v_expired integer;`],
  [PURGE, EXPIRE],
  [BUSY, BUSY_LIVE],
]);

const RECORD = restate(V69_SQL, "svc_cognition_routed_record", [
  [`DECLARE i fleet_cognition_inflight; v_cost bigint;`,
   `DECLARE i fleet_cognition_inflight; v_over bigint := 0; v_over_usd bigint := 0; v_short bigint := 0; v_cash bigint; v_cost bigint;`],
  [`  v_micro := CASE v_src WHEN 'provider' THEN LEAST(i.estimate_cents * 1000000, v_cost_l) WHEN 'estimate' THEN i.estimate_cents * 1000000 ELSE 0 END;`,
   `  v_micro := CASE v_src WHEN 'provider' THEN LEAST(i.estimate_cents * 1000000, v_cost_l) WHEN 'estimate' THEN i.estimate_cents * 1000000 ELSE 0 END;
  -- v111: the excess above the reservation is a platform fault: recorded below as a cost exception, never dropped.
  IF v_src = 'provider' THEN
    v_over := GREATEST(v_cost_l - i.estimate_cents * 1000000, 0);
    v_over_usd := GREATEST(v_cost - COALESCE(i.estimate_usd_cents, 0) * 1000000, 0);
  END IF;`],
  [`
  v_total := v_unposted + v_micro;
  v_charge := v_total / 1000000;
  v_unposted := v_total - v_charge * 1000000;
  IF v_charge > 0 THEN`,
   `
  v_total := v_unposted + v_micro;
  v_charge := v_total / 1000000;
  v_unposted := v_total - v_charge * 1000000;
  -- v111: as far as the agent's cash allows (a late settlement after its cash moved); the rest is a cost exception.
  v_cash := GREATEST(fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_cash')), 0);
  IF v_charge > v_cash THEN v_short := v_charge - v_cash; v_charge := v_cash; END IF;
  IF v_charge > 0 THEN`],
  [`  DELETE FROM fleet_cognition_inflight WHERE agent_id = p_agent;`,
   `  -- v111: only this call's reservation (others may be unresolved holds of earlier calls).
  DELETE FROM fleet_cognition_inflight WHERE agent_id = p_agent AND request_id = p_request;`],
  [`  RETURN jsonb_build_object('ok', true, 'payer', i.payer,`,
   `  IF v_over > 0 THEN
    INSERT INTO fleet_cognition_cost_exceptions (request_id, agent_id, kind, payer, usd_microcents, ledger_microcents, currency)
      VALUES (p_request, p_agent, 'overrun', COALESCE(i.payer, 'agent'), v_over_usd, v_over, v_acct);
    PERFORM fleet_event('cognition_cost_exception', p_agent, 'controller', jsonb_build_object('requestId', p_request, 'kind', 'overrun',
      'ledgerMicro', v_over, 'usdMicro', v_over_usd, 'note', 'a model call cost more than its reservation; the excess is not charged to anyone until the owner allocates it; this agent makes no further paid call until then'));
  END IF;
  IF v_short > 0 THEN
    INSERT INTO fleet_cognition_cost_exceptions (request_id, agent_id, kind, payer, usd_microcents, ledger_microcents, currency)
      VALUES (p_request, p_agent, 'uncollectable', 'agent', 0, v_short * 1000000, v_acct);
    PERFORM fleet_event('cognition_cost_exception', p_agent, 'controller', jsonb_build_object('requestId', p_request, 'kind', 'uncollectable',
      'ledgerMinor', v_short, 'note', 'the agent''s cash could not cover this model call in full; the rest awaits the owner''s allocation'));
  END IF;
  IF i.expired_at IS NOT NULL THEN
    PERFORM fleet_event('cognition_reservation_settled_late', p_agent, 'controller', jsonb_build_object('requestId', p_request, 'expiredAt', i.expired_at));
  END IF;
  RETURN jsonb_build_object('ok', true, 'payer', i.payer, 'overrunMicro', v_over, 'uncollectableMinor', v_short, 'late', i.expired_at IS NOT NULL,`],
]);

// The legacy (unrouted) record: the same request-scoped removal.
const LEGACY_RECORD = restate(V69_SQL, "svc_cognition_record", [
  [`  DELETE FROM fleet_cognition_inflight WHERE agent_id = p_agent;`,
   `  DELETE FROM fleet_cognition_inflight WHERE agent_id = p_agent AND request_id = p_request;`],
]);

// An agent-paid model call not yet settled (live or an unresolved hold) is a bill of the agent's still open: the agent is
// not exhausted while it is (its cash has not been charged yet), and its estate is not settled until it is.
const UNSETTLED = `(SELECT COALESCE(sum(estimate_cents), 0) FROM fleet_cognition_inflight WHERE agent_id = p_agent AND payer IS DISTINCT FROM 'treasury')`;
const MEASURE = restate(V96_SQL, "fleet_agent_wallet_measure", [
  [`        v_spend bigint; v_own bigint; v_in bigint; v_open bigint; v_env bigint; m jsonb; v_orders bigint; v_disp bigint; v_disp_held bigint;`,
   `        v_spend bigint; v_own bigint; v_in bigint; v_open bigint; v_env bigint; m jsonb; v_orders bigint; v_disp bigint; v_disp_held bigint; v_cog bigint := ${UNSETTLED};`],
  [`'paidToOwnerCardMinor', v_card, 'paypalDisputedMinor', v_disp_held),`,
   `'paidToOwnerCardMinor', v_card, 'paypalDisputedMinor', v_disp_held, 'modelCallsUnsettledMinor', v_cog),`],
  [`    'exhausted', v_own = 0 AND v_in = 0 AND v_orders = 0`,
   `    'exhausted', v_own = 0 AND v_in = 0 AND v_orders = 0 AND v_cog = 0`],
]);
const ESTATE_SETTLE = restate(V56_SQL, "fleet_estate_settle_internal", [
  [`    RAISE EXCEPTION 'FLEET_ESTATE_PENDING: reconcile pending orders first';
  END IF;`,
   `    RAISE EXCEPTION 'FLEET_ESTATE_PENDING: reconcile pending orders first';
  END IF;
  -- v111: a model call of the agent's not yet settled (in flight, or an unresolved hold) is settled first.
  IF ${UNSETTLED} > 0 THEN RAISE EXCEPTION 'FLEET_ESTATE_PENDING: settle the agent''s unsettled model calls first'; END IF;`],
]);

// v13 deleted every reservation of an agent at its end: a bill arriving after death was lost and the estate settled without
// it. The reservations now stop being live (no new work) but stay as holds until their results or the owner settle them.
const COGNITION_STOP = restate(V13_SQL, "fleet_agents_cognition_stop", [
  [`    DELETE FROM fleet_cognition_inflight WHERE agent_id = NEW.agent_id;`,
   `    UPDATE fleet_cognition_inflight SET expired_at = COALESCE(expired_at, now()) WHERE agent_id = NEW.agent_id;`],
]);

// v100 returned the 10 OLDEST obligations: an 11th — say a paid order's newest message behind 10 old enquiries — was neither
// shown nor stopped the agent's sleep. Up to OBLIGATIONS_LIMIT_V111 now, most urgent first: unanswered before answered,
// paid orders before enquiries, then oldest. The packet shows the first ones and counts the rest (founder/obligations.ts).
export const OBLIGATIONS_LIMIT_V111 = 50;
// The record id breaks ties: requests of the same moment keep a stable order (a page never skips or repeats one).
const PRIORITY = `CASE WHEN replied IS NULL OR replied < last_buyer THEN 0 ELSE 1 END, CASE WHEN kind = 'order' THEN 0 ELSE 1 END, since, id`;
const OBLIGATIONS = restate(V100_SQL, "fleet_customer_obligations", [
  [`'delivering', CASE WHEN delivering THEN true END)) ORDER BY since), '[]'::jsonb)
    FROM (SELECT * FROM ob ORDER BY since LIMIT ${OBLIGATIONS_MAX}) y`,
   `'delivering', CASE WHEN delivering THEN true END)) ORDER BY ${PRIORITY}), '[]'::jsonb)
    FROM (SELECT * FROM ob ORDER BY ${PRIORITY} LIMIT ${OBLIGATIONS_LIMIT_V111}) y`],
]);
// Every open request, in the same order, for paging beyond the packet's list (review 2026-10-23: "require pagination or
// another durable retrieval path beyond 50 … every unresolved obligation must remain recoverable").
const OBLIGATIONS_ALL = restate(V100_SQL, "fleet_customer_obligations", [
  [`CREATE OR REPLACE FUNCTION fleet_customer_obligations(p_agent text)`, `CREATE OR REPLACE FUNCTION fleet_customer_obligations_all(p_agent text)`],
  [`'delivering', CASE WHEN delivering THEN true END)) ORDER BY since), '[]'::jsonb)
    FROM (SELECT * FROM ob ORDER BY since LIMIT ${OBLIGATIONS_MAX}) y`,
   `'delivering', CASE WHEN delivering THEN true END)) ORDER BY ${PRIORITY}), '[]'::jsonb)
    FROM ob y`],
]);
export const AGENT_OPS_V111 = ["customer.obligations"] as const;
const DISPATCH = restate(V105_SQL, "api_economy", [
  [`WHEN 'code.job' THEN 'planning'`, `WHEN 'code.job' THEN 'planning' WHEN 'customer.obligations' THEN 'planning'`],
  [`      WHEN 'order.invoice' THEN fleet_econ_order_invoice(p_agent, a)`, `      WHEN 'order.invoice' THEN fleet_econ_order_invoice(p_agent, a)
      WHEN 'customer.obligations' THEN (WITH al AS (SELECT fleet_customer_obligations_all(p_agent) AS j),
          pg AS (SELECT GREATEST(COALESCE((a ->> 'offset')::integer, 0), 0) AS off, LEAST(GREATEST(COALESCE((a ->> 'limit')::integer, 20), 1), 50) AS lim)
        SELECT jsonb_build_object('ok', true, 'total', jsonb_array_length(al.j), 'offset', pg.off,
          'obligations', COALESCE((SELECT jsonb_agg(x ORDER BY n) FROM jsonb_array_elements(al.j) WITH ORDINALITY e(x, n) WHERE n > pg.off AND n <= pg.off + pg.lim), '[]'::jsonb),
          'next', CASE WHEN jsonb_array_length(al.j) > pg.off + pg.lim THEN pg.off + pg.lim END,
          'note', 'every open customer request, most urgent first (unanswered, then paid orders, then oldest); page with offset = next')
          FROM al, pg)`],
]);

const OWNER = `  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a reason (the evidence) is required'; END IF;`;

export const V111_SQL = `
ALTER TABLE fleet_cognition_inflight ADD COLUMN expired_at timestamptz;
-- One row per RESERVATION (was one per agent): an unresolved hold and the agent's next call coexist. At most one LIVE
-- reservation per agent is still enforced, by the database.
ALTER TABLE fleet_cognition_inflight DROP CONSTRAINT fleet_cognition_inflight_pkey;
ALTER TABLE fleet_cognition_inflight ADD PRIMARY KEY (request_id);
CREATE UNIQUE INDEX fleet_cognition_inflight_one_live ON fleet_cognition_inflight (agent_id) WHERE expired_at IS NULL;
CREATE INDEX fleet_cognition_inflight_agent_idx ON fleet_cognition_inflight (agent_id);

-- A model call's cost the reservation did not cover: kept until the owner allocates it (append-only; never deleted).
CREATE TABLE fleet_cognition_cost_exceptions (
  exception_id      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id        uuid        NOT NULL,
  agent_id          text        NOT NULL REFERENCES fleet_agents(agent_id),
  kind              text        NOT NULL CHECK (kind IN ('overrun','uncollectable')),
  payer             text        NOT NULL CHECK (payer IN ('agent','treasury')),
  usd_microcents    bigint      NOT NULL CHECK (usd_microcents >= 0),
  ledger_microcents bigint      NOT NULL CHECK (ledger_microcents > 0),
  currency          text        NOT NULL,
  status            text        NOT NULL DEFAULT 'unallocated' CHECK (status IN ('unallocated','allocated')),
  allocated_to      text        CHECK (allocated_to IN ('agent','treasury')),
  allocated_minor   bigint,
  journal_id        uuid,
  reason            text,
  allocated_by      text,
  allocated_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, kind),
  CHECK ((status = 'unallocated') = (allocated_to IS NULL))
);
CREATE TRIGGER fleet_cognition_cost_exceptions_no_delete BEFORE DELETE ON fleet_cognition_cost_exceptions
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_cognition_cost_exceptions_no_truncate BEFORE TRUNCATE ON fleet_cognition_cost_exceptions
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

${AUTHORIZE}

${AUTHORIZE_TREASURY}

${RECORD}

${LEGACY_RECORD}

${MEASURE}

${ESTATE_SETTLE}

${COGNITION_STOP}

${OBLIGATIONS}

${OBLIGATIONS_ALL}

${DISPATCH}

-- The owner resolves a reservation whose result never came, from provider evidence (the provider's usage for that time):
-- 'billed' settles it at its reservation (recorded as an estimate, exactly once); 'not_billed' releases it.
CREATE FUNCTION fleet_admin_cognition_reservation_resolve(p_request uuid, p_outcome text, p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE i fleet_cognition_inflight; r jsonb;
BEGIN
${OWNER}
  IF p_outcome NOT IN ('billed','not_billed') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: outcome is billed or not_billed'; END IF;
  SELECT * INTO i FROM fleet_cognition_inflight WHERE request_id = p_request FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no open reservation %', p_request; END IF;
  -- Past its time even if no later call has marked it yet (a paused agent asks for none).
  IF i.expired_at IS NULL AND i.started_at > now() - interval '${RESERVATION_EXPIRY_MINUTES} minutes' THEN
    RAISE EXCEPTION 'FLEET_CONFLICT: the reservation is still within its time; its result may yet arrive';
  END IF;
  IF p_outcome = 'billed' THEN
    IF i.route_tier IS NULL THEN RAISE EXCEPTION 'FLEET_CONFLICT: a legacy (unrouted) reservation cannot be settled here'; END IF;
    -- No prompt or response is known for a call that never reported back: all-zero digests, marked RESOLVED_BY_OWNER.
    r := svc_cognition_routed_record(i.agent_id, p_request, 'error', 0, 0, repeat('0', 64), repeat('0', 64), NULL, 'RESOLVED_BY_OWNER', 'estimate', 1, NULL, NULL, NULL, 0, 0, NULL, NULL, '{}'::jsonb);
  ELSE
    DELETE FROM fleet_cognition_inflight WHERE request_id = p_request;
    r := jsonb_build_object('ok', true, 'released', true);
  END IF;
  PERFORM fleet_event('cognition_reservation_resolved', i.agent_id, p_actor, jsonb_build_object('requestId', p_request, 'outcome', p_outcome,
    'reason', left(fleet_scrub(trim(p_reason)), 300)));
  RETURN r || jsonb_build_object('outcome', p_outcome);
END $$;

-- The owner allocates a cost exception: to the agent (its expense, as far as its cash allows) or to the treasury (fleet
-- expense). Either way the provider credit was the owner's: the owner-payable legs follow, as for every AI charge (v69).
CREATE FUNCTION fleet_admin_cognition_exception_allocate(p_exception uuid, p_to text, p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_cognition_cost_exceptions; v_amount bigint; v_j uuid;
BEGIN
${OWNER}
  IF p_to NOT IN ('agent','treasury') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: allocate to agent or treasury'; END IF;
  SELECT * INTO x FROM fleet_cognition_cost_exceptions WHERE exception_id = p_exception FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no cost exception %', p_exception; END IF;
  IF x.status <> 'unallocated' THEN RAISE EXCEPTION 'FLEET_CONFLICT: already allocated'; END IF;
  v_amount := ceil(x.ledger_microcents::numeric / 1000000)::bigint;
  IF p_to = 'agent' THEN
    IF fleet_ledger_balance(fleet_ledger_account(x.agent_id, 'agent_cash')) < v_amount THEN
      RAISE EXCEPTION 'FLEET_INSUFFICIENT_ALLOCATION: the agent''s cash cannot cover %', v_amount;
    END IF;
    v_j := fleet_ledger_post('inference_charge', 'cognition-exception:' || p_exception, p_actor, 'model call cost exception (allocated to the agent)', 'controller', x.agent_id, NULL, NULL, NULL, NULL, now(),
      jsonb_build_array(
        jsonb_build_object('account', fleet_ledger_account(x.agent_id, 'agent_expense'), 'side', 'D', 'amount', v_amount),
        jsonb_build_object('account', fleet_ledger_account(x.agent_id, 'agent_cash'), 'side', 'C', 'amount', v_amount),
        jsonb_build_object('account', '${REIMBURSABLE_ACCOUNT}', 'side', 'D', 'amount', v_amount),
        jsonb_build_object('account', '${OWNER_PAYABLE_ACCOUNT}', 'side', 'C', 'amount', v_amount)));
  ELSE
    IF fleet_ledger_balance('fleet:treasury:unallocated') < v_amount THEN
      RAISE EXCEPTION 'FLEET_TREASURY_INSUFFICIENT: the treasury cannot cover %', v_amount;
    END IF;
    v_j := fleet_ledger_post('owner_conversation_charge', 'cognition-exception:' || p_exception, p_actor, 'model call cost exception (fleet expense)', 'controller', NULL, NULL, NULL, NULL, NULL, now(),
      jsonb_build_array(
        jsonb_build_object('account', 'fleet:expense', 'side', 'D', 'amount', v_amount),
        jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', v_amount),
        jsonb_build_object('account', '${REIMBURSABLE_ACCOUNT}', 'side', 'D', 'amount', v_amount),
        jsonb_build_object('account', '${OWNER_PAYABLE_ACCOUNT}', 'side', 'C', 'amount', v_amount)));
  END IF;
  UPDATE fleet_cognition_cost_exceptions SET status = 'allocated', allocated_to = p_to, allocated_minor = v_amount, journal_id = v_j,
         reason = left(fleet_scrub(trim(p_reason)), 300), allocated_by = p_actor, allocated_at = now()
   WHERE exception_id = p_exception;
  PERFORM fleet_event('cognition_cost_exception_allocated', x.agent_id, p_actor, jsonb_build_object('exceptionId', p_exception, 'to', p_to, 'minor', v_amount));
  RETURN jsonb_build_object('ok', true, 'exceptionId', p_exception, 'allocatedTo', p_to, 'minor', v_amount, 'journalId', v_j);
END $$;

-- Engineering model calls (the real-model scenario harness: a throwaway registry, the production provider key). The harness
-- never holds production database credentials: it writes one evidence row per call (eval/cost-meter.ts) and the owner imports
-- them after the run. Each call is recorded once (its call id) and becomes a provider-credit consumption by the controller
-- (recorded_by controller:engineering:<run>): the credit lots are drawn (v70) and the acquisition cost is Fleet overhead
-- (v72, as for Fleet Control's own calls). No agent wallet is touched.
CREATE TABLE fleet_engineering_cognition_calls (
  call_id              uuid        PRIMARY KEY,
  run_id               text        NOT NULL CHECK (run_id ~ '^[A-Za-z0-9._:-]{3,64}$'),
  scenario             text        NOT NULL CHECK (scenario ~ '^[A-Za-z0-9._:-]{1,64}$'),
  provider             text        NOT NULL,
  model                text        NOT NULL,
  provider_request_id  text,
  outcome              text        NOT NULL CHECK (outcome IN ('ok','error','refused_ceiling')),
  charge               text        NOT NULL CHECK (charge IN ('usage','worst_case','none')),
  input_tokens         bigint      NOT NULL DEFAULT 0, output_tokens bigint NOT NULL DEFAULT 0,
  cache_read_tokens    bigint      NOT NULL DEFAULT 0, cache_write_tokens bigint NOT NULL DEFAULT 0,
  usd_microcents       bigint      NOT NULL CHECK (usd_microcents >= 0),
  ledger_microcents    bigint      NOT NULL CHECK (ledger_microcents >= 0),
  all_in_microcents    bigint      NOT NULL CHECK (all_in_microcents >= 0),
  called_at            timestamptz NOT NULL,
  imported_by          text        NOT NULL,
  imported_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_engineering_cognition_calls_run ON fleet_engineering_cognition_calls (run_id, scenario);
CREATE TRIGGER fleet_engineering_cognition_calls_no_change BEFORE UPDATE OR DELETE ON fleet_engineering_cognition_calls
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_engineering_cognition_calls_no_truncate BEFORE TRUNCATE ON fleet_engineering_cognition_calls
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION fleet_admin_engineering_calls_import(p_run text, p_provider text, p_rows jsonb, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x jsonb; v_new integer := 0; v_dup integer := 0; v_usd bigint := 0; v_all bigint := 0; v_id uuid;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');
  IF p_provider IS NULL OR p_provider !~ '^[a-z_]{2,32}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: provider'; END IF;
  IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) > 5000 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: rows must be an array of at most 5000'; END IF;
  FOR x IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    IF x ->> 'runId' IS DISTINCT FROM p_run THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a row of another run (%)', x ->> 'runId'; END IF;
    INSERT INTO fleet_engineering_cognition_calls (call_id, run_id, scenario, provider, model, provider_request_id, outcome, charge,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, usd_microcents, ledger_microcents, all_in_microcents, called_at, imported_by)
      VALUES ((x ->> 'callId')::uuid, p_run, left(x ->> 'scenario', 64), p_provider, left(x ->> 'model', 120),
        CASE WHEN x ->> 'providerRequestId' ~ '^[A-Za-z0-9_.:-]{1,128}$' THEN x ->> 'providerRequestId' END, x ->> 'outcome', x ->> 'charge',
        COALESCE((x -> 'usage' ->> 'inputTokens')::bigint, 0), COALESCE((x -> 'usage' ->> 'outputTokens')::bigint, 0),
        COALESCE((x -> 'usage' ->> 'cacheReadTokens')::bigint, 0), COALESCE((x -> 'usage' ->> 'cacheWriteTokens')::bigint, 0),
        (x ->> 'usdMicro')::bigint, (x ->> 'ledgerMicro')::bigint, (x ->> 'allInMicro')::bigint, (x ->> 'at')::timestamptz, p_actor)
      ON CONFLICT (call_id) DO NOTHING RETURNING call_id INTO v_id;
    IF v_id IS NULL THEN v_dup := v_dup + 1; CONTINUE; END IF;
    v_new := v_new + 1; v_usd := v_usd + (x ->> 'usdMicro')::bigint; v_all := v_all + (x ->> 'allInMicro')::bigint;
    IF (x ->> 'usdMicro')::bigint > 0 THEN
      INSERT INTO fleet_provider_credit_events (provider, kind, usd_microcents, request_id, recorded_by)
        VALUES (p_provider, 'consumption', -(x ->> 'usdMicro')::bigint, v_id, 'controller:engineering:' || p_run);
    END IF;
    v_id := NULL;
  END LOOP;
  PERFORM fleet_event('engineering_cognition_recorded', NULL, p_actor, jsonb_build_object('runId', p_run, 'calls', v_new, 'duplicates', v_dup,
    'usdMicro', v_usd, 'allInMicro', v_all));
  RETURN jsonb_build_object('ok', true, 'runId', p_run, 'recorded', v_new, 'alreadyRecorded', v_dup, 'usdMicro', v_usd, 'allInMicro', v_all,
    'run', (SELECT jsonb_build_object('calls', count(*), 'usdMicro', COALESCE(sum(usd_microcents), 0), 'allInMicro', COALESCE(sum(all_in_microcents), 0))
              FROM fleet_engineering_cognition_calls WHERE run_id = p_run));
END $$;

-- The owner's view: unresolved reservations and cost exceptions.
CREATE FUNCTION fleet_admin_cognition_settlement_state() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'unresolved', COALESCE((SELECT jsonb_agg(jsonb_build_object('requestId', request_id, 'agentId', agent_id, 'payer', COALESCE(payer, 'agent'),
        'startedAt', started_at, 'expiredAt', expired_at, 'estimateMinor', estimate_cents, 'estimateUsdCents', estimate_usd_cents,
        'tier', route_tier, 'model', route_model) ORDER BY started_at) FROM fleet_cognition_inflight
        WHERE expired_at IS NOT NULL OR started_at <= now() - interval '${RESERVATION_EXPIRY_MINUTES} minutes'), '[]'::jsonb),
    'exceptions', COALESCE((SELECT jsonb_agg(jsonb_build_object('exceptionId', exception_id, 'requestId', request_id, 'agentId', agent_id, 'kind', kind,
        'payer', payer, 'usdMicro', usd_microcents, 'ledgerMicro', ledger_microcents, 'currency', currency, 'status', status, 'allocatedTo', allocated_to,
        'allocatedMinor', allocated_minor, 'createdAt', created_at) ORDER BY created_at) FROM fleet_cognition_cost_exceptions), '[]'::jsonb));
$$;

${restateRaw(V109_SQL, "fleet_event_route", [["    WHEN p_type = 'spend_circuit_breaker_set' THEN",
  (Object.entries(EVENT_ROUTES_V111) as Array<[string, readonly string[]]>)
    .map(([lvl, types]) => `    WHEN p_type IN (${types.map((t) => `'${t}'`).join(",")}) THEN '${lvl}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"]])}

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

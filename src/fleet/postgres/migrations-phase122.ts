/**
 * Schema v122 — founder recovery (INCIDENT 2026-10-27: both founders died after a ~106 s controller outage).
 *
 * R1. A Genesis founder could never recover from `unresponsive`: `fleet_agents_origin_guard` (v11) refused ANY founder status
 *     change to `active` outside a Genesis operation, and recovery (`fleet_heartbeat` / `svc_answer_challenge`: unresponsive →
 *     active) is exactly such a change — the heartbeat and every challenge answer were rolled back (400 FLEET_GENESIS_REQUIRED),
 *     the founders exited (code 3) and the reaper ended them at the 480 s grace. Now exactly `unresponsive → active` is allowed;
 *     every other founder advance (reserved → provisioning → active) still needs its Genesis operation.
 * R2. Controller downtime counted against agents: the reaper reset its grace window only after it had itself been idle for more
 *     than heartbeat_unresponsive_s (120 s), so an outage of 90–120 s was judged as if none happened. The reaper runs every 15 s;
 *     a gap of more than 45 s (three periods) now always restarts the grace window.
 * R3. An incident reinstatement (owner only, atomic): `fleet_admin_incident_reinstate` returns founders that died of a HEALTH or
 *     HEARTBEAT timeout, with a cash-only estate, to the living population under their ORIGINAL identity (agent id, credential,
 *     wallet, ledger accounts; memory and workspace are files the registry never touched). Corrections are explicit and auditable:
 *       - the treasury-paid AI-credit acquisition cost that posted only because the estates put unbacked money into
 *         `unallocated` is reversed (mirrored `reversal`) and returned to waiting (`unwound_minor` records it);
 *       - each estate transfer is reversed (mirrored `reversal`); the estate is marked `reverted` with an append-only record;
 *       - dead → unresponsive under a reinstatement-only allowance; the credential revoked at death is restored; the wallet
 *         frozen at death is unfrozen; cognition enabled but PAUSED; a health challenge is due at the next heartbeat —
 *         the founder becomes active only by passing it (R1).
 *     History is never deleted: agent_died / estate_settled / journals 1177–1179 stay; reversals and events record the change.
 * R4. Unbacked estate money can no longer pass a treasury gate: an estate's cash up to the still-unbacked starting capital goes
 *     to `fleet:treasury:unbacked_estates` (treasury_cash: the capital reconciliation is unchanged), never to
 *     `fleet:treasury:unallocated`, which funds Fleet Control, owner turns, acquisition costs and refund bookings.
 *     The estate freeze reopens a reverted estate and estate journal keys never collide after a reinstatement.
 */
import { V11_SQL } from "./migrations-phase11.js";
import { V111_SQL } from "./migrations-phase111.js";
import { V120_SQL } from "./migrations-phase120.js";
import { v4Sql } from "./migrations-phase5.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));
const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

/** A reaper gap longer than this restarts the grace window (the reaper runs every 15 s). */
export const REAPER_RESUME_GAP_S = 45;
/** Deaths that a reinstatement may reverse: health and heartbeat timeouts only (never economic death or an owner kill). */
export const REINSTATABLE_CAUSES = ["health_timeout", "heartbeat_timeout"] as const;
/** How long after death a reinstatement stays possible. */
export const REINSTATE_WINDOW_DAYS = 14;
export const UNBACKED_ESTATES_ACCOUNT = "fleet:treasury:unbacked_estates";
/** The verification hold a reinstatement sets (owner-chosen within these bounds). */
export const HOLD_MIN_MINUTES = 5;
export const HOLD_MAX_MINUTES = 120;
export const EVENT_ROUTES_V122 = Object.freeze({
  P1_HIGH: ["agent_reinstated"],
  P2_IMPORTANT: ["estate_reverted", "ai_cost_unwound", "lifecycle_hold_ended"],
});

const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_genesis');`;

// R1: exactly unresponsive → active is recovery, not a Genesis advance.
const ORIGIN_GUARD = restate(V11_SQL, "fleet_agents_origin_guard", [
  [`  IF NEW.origin IN ('genesis_founder','reseed_founder') AND NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status IN ('provisioning','active') AND COALESCE(current_setting('fleet.genesis_op', true), '') <> NEW.genesis_id::text THEN`,
   `  -- v122: recovery from unresponsive (a heartbeat or a passed challenge) is not a Genesis advance.
  IF NEW.origin IN ('genesis_founder','reseed_founder') AND NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status IN ('provisioning','active') AND NOT (OLD.status = 'unresponsive' AND NEW.status = 'active')
     AND COALESCE(current_setting('fleet.genesis_op', true), '') <> NEW.genesis_id::text THEN`],
]);

// R2: any reaper gap over REAPER_RESUME_GAP_S restarts the grace window (controller downtime never counts against agents).
const HOLD_OFF = `(lifecycle_hold_until IS NULL OR lifecycle_hold_until <= now())`;
const REAP = restate(v4Sql(50), "fleet_reap", [
  [`     OR now() - st.reaper_last_run_at > make_interval(secs => st.heartbeat_unresponsive_s) THEN`,
   `     OR now() - st.reaper_last_run_at > make_interval(secs => LEAST(st.heartbeat_unresponsive_s, ${REAPER_RESUME_GAP_S})) THEN`],
  // v122: an agent under a bounded lifecycle hold (an owner reinstatement under verification) is neither marked unresponsive
  // nor terminated for health / heartbeat; after the hold the full grace runs from its end.
  [`            WHERE status = 'active'
              AND (GREATEST(COALESCE(last_heartbeat, updated_at), v_grace) < now() - make_interval(secs => st.heartbeat_unresponsive_s)`,
   `            WHERE status = 'active' AND ${HOLD_OFF}
              AND (GREATEST(COALESCE(last_heartbeat, updated_at), v_grace) < now() - make_interval(secs => st.heartbeat_unresponsive_s)`],
  [`            WHERE status = 'unresponsive'
              AND (GREATEST(COALESCE(last_heartbeat, updated_at), v_grace) < now() - make_interval(secs => st.heartbeat_dead_s)
                   OR GREATEST(COALESCE(unresponsive_since, updated_at), v_grace) < now() - make_interval(secs => st.termination_grace_s))`,
   `            WHERE status = 'unresponsive' AND ${HOLD_OFF}
              AND (GREATEST(COALESCE(last_heartbeat, updated_at), v_grace, COALESCE(lifecycle_hold_until, '-infinity')) < now() - make_interval(secs => st.heartbeat_dead_s)
                   OR GREATEST(COALESCE(unresponsive_since, updated_at), v_grace, COALESCE(lifecycle_hold_until, '-infinity')) < now() - make_interval(secs => st.termination_grace_s))`],
]);
// v122: becoming active ends a lifecycle hold.
const STAMPS = restate(v4Sql(50), "fleet_agents_lifecycle_stamps", [
  [`    IF NEW.status = 'active' THEN NEW.unresponsive_since := NULL; END IF;`,
   `    IF NEW.status = 'active' THEN NEW.unresponsive_since := NULL; NEW.lifecycle_hold_until := NULL; NEW.lifecycle_hold_reason := NULL; END IF;`],
]);

// R3: the only way out of a terminal state — an owner incident reinstatement of this very agent, in this transaction.
const TRANSITION_GUARD = `
CREATE OR REPLACE FUNCTION fleet_agents_transition_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('reserved','active') THEN
      RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: cannot insert agent in status %', NEW.status;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.agent_id <> NEW.agent_id OR OLD.role <> NEW.role OR OLD.generation <> NEW.generation
     OR OLD.parent_agent_id IS DISTINCT FROM NEW.parent_agent_id
     OR OLD.created_at <> NEW.created_at OR OLD.dry_run <> NEW.dry_run THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: identity columns cannot change';
  END IF;
  IF OLD.wallet_address IS NOT NULL AND OLD.wallet_address IS DISTINCT FROM NEW.wallet_address THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: wallet_address cannot change once set';
  END IF;
  IF OLD.runtime_commit IS NOT NULL AND OLD.runtime_commit IS DISTINCT FROM NEW.runtime_commit AND OLD.role = 'child' THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: child runtime_commit cannot change';
  END IF;
  -- v122: an owner incident reinstatement (fleet_admin_incident_reinstate) of THIS agent may move it dead → unresponsive.
  IF OLD.status = 'dead' AND NEW.status = 'unresponsive' AND COALESCE(current_setting('fleet.reinstate_op', true), '') = NEW.agent_id THEN
    RETURN NEW;
  END IF;
  IF OLD.status = NEW.status THEN
    IF OLD.status IN ('dead','failed') AND OLD.death_time IS DISTINCT FROM NEW.death_time THEN
      RAISE EXCEPTION 'FLEET_TERMINAL_STATE_IMMUTABLE';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('dead','failed') THEN
    RAISE EXCEPTION 'FLEET_TERMINAL_STATE_IMMUTABLE: agent % is %', OLD.agent_id, OLD.status;
  END IF;
  IF NOT (
       (OLD.status = 'reserved'     AND NEW.status IN ('provisioning','failed'))
    OR (OLD.status = 'provisioning' AND NEW.status IN ('active','failed','orphaned'))
    OR (OLD.status = 'active'       AND NEW.status IN ('unresponsive','terminating','dead'))
    OR (OLD.status = 'unresponsive' AND NEW.status IN ('active','terminating','dead'))
    OR (OLD.status = 'terminating'  AND NEW.status IN ('orphaned','dead'))
    OR (OLD.status = 'orphaned'     AND NEW.status = 'dead')
  ) THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;`;

// R4 + reinstatement-safe keys: the unbacked share of an estate's cash never reaches `unallocated`; keys are unique per settlement.
const SUFFIX = `COALESCE(':' || NULLIF((SELECT count(*) FROM fleet_estate_reversions x WHERE x.agent_id = p_agent), 0)::text, '')`;
const ESTATE_SETTLE = restate(V111_SQL, "fleet_estate_settle_internal", [
  [`'estate:recover:' || p_agent,`, `'estate:recover:' || p_agent || ${SUFFIX},`],
  [`'estate:writeoff:' || p_agent,`, `'estate:writeoff:' || p_agent || ${SUFFIX},`],
  [`  IF v_cash > 0 OR v_assets > 0 THEN
    PERFORM fleet_ledger_post('estate_transfer', 'estate:transfer:' || p_agent, p_actor, 'estate: remaining assets to the treasury', 'owner', p_agent,
      NULL, NULL, NULL, NULL, now(), (
        SELECT jsonb_agg(x) FROM (
          SELECT jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', v_cash) x WHERE v_cash > 0`,
   `  -- v122: the agent's own earnings (external customer revenue it kept: revenue − its treasury contributions) are real money and
  -- stay backed; only the rest of its cash — capital the fleet gave it — counts as unbacked, capped by the fleet's still-unbacked
  -- starting capital. That part is parked apart from unallocated (it is no money anyone paid in).
  v_earn := GREATEST(0, COALESCE((fleet_agent_economics(p_agent) ->> 'externalCustomerRevenue')::bigint, 0)
                        - COALESCE((fleet_agent_economics(p_agent) ->> 'lifetimeContribution')::bigint, 0));
  v_unb := LEAST(GREATEST(0, v_cash - v_earn),
                 GREATEST(0, (fleet_capital_backing() ->> 'unbackedMinor')::bigint - fleet_ledger_balance('${UNBACKED_ESTATES_ACCOUNT}')));
  IF v_cash > 0 OR v_assets > 0 THEN
    PERFORM fleet_ledger_post('estate_transfer', 'estate:transfer:' || p_agent || ${SUFFIX}, p_actor, 'estate: remaining assets to the treasury', 'owner', p_agent,
      NULL, NULL, NULL, NULL, now(), (
        SELECT jsonb_agg(x) FROM (
          SELECT jsonb_build_object('account', '${UNBACKED_ESTATES_ACCOUNT}', 'side', 'D', 'amount', v_unb) x WHERE v_unb > 0
          UNION ALL SELECT jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', v_cash - v_unb) WHERE v_cash - v_unb > 0`],
  [`DECLARE v_pay bigint;`, `DECLARE v_unb bigint := 0; v_earn bigint := 0; v_pay bigint;`],
  [`    'payableRepaid', v_rp, 'payableWrittenOff', v_pwo);`, `    'payableRepaid', v_rp, 'payableWrittenOff', v_pwo, 'cashUnbacked', v_unb);`],
]);

// A later real death of a reinstated agent opens its estate again (the reverted record stays in fleet_estate_reversions).
const ESTATE_FREEZE = restate(V11_SQL, "fleet_estate_freeze", [
  [`  INSERT INTO fleet_estates (agent_id, opened_by) VALUES (p_agent, left(p_actor, 128)) ON CONFLICT (agent_id) DO NOTHING;`,
   `  INSERT INTO fleet_estates (agent_id, opened_by) VALUES (p_agent, left(p_actor, 128))
    ON CONFLICT (agent_id) DO UPDATE SET status = 'open', opened_at = now(), opened_by = left(p_actor, 128), settled_at = NULL, settled_by = NULL, summary = NULL
     WHERE fleet_estates.status = 'reverted';`],
]);

export const V122_SQL = `
${ORIGIN_GUARD}

-- ═══ A bounded lifecycle hold (set only by an owner reinstatement; ends at active, at its time, or by the owner) ═══
ALTER TABLE fleet_agents ADD COLUMN lifecycle_hold_until timestamptz, ADD COLUMN lifecycle_hold_reason text CHECK (lifecycle_hold_reason IS NULL OR length(lifecycle_hold_reason) <= 300);

${REAP}

${STAMPS}

${TRANSITION_GUARD}

-- ═══ Estates: a reverted state and its append-only record ═══
ALTER TABLE fleet_estates DROP CONSTRAINT IF EXISTS fleet_estates_status_check;
ALTER TABLE fleet_estates DROP CONSTRAINT IF EXISTS fleet_estates_check;
ALTER TABLE fleet_estates ADD CONSTRAINT fleet_estates_status_check CHECK (status IN ('open','settled','reverted'));
ALTER TABLE fleet_estates ADD CONSTRAINT fleet_estates_check CHECK ((status IN ('settled','reverted')) = (settled_at IS NOT NULL));
CREATE TABLE fleet_estate_reversions (
  reversion_id        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id            text        NOT NULL REFERENCES fleet_agents(agent_id),
  incident            text        NOT NULL CHECK (length(incident) BETWEEN 3 AND 300),
  previous_summary    jsonb,
  settled_at          timestamptz NOT NULL,
  transfer_journal_id uuid        REFERENCES fleet_ledger_journal(journal_id),
  reversal_journal_id uuid        REFERENCES fleet_ledger_journal(journal_id),
  reverted_by         text        NOT NULL,
  reverted_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_estate_reversions_no_change BEFORE UPDATE OR DELETE ON fleet_estate_reversions FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- ═══ Unbacked estate money: its own treasury partition (not unallocated) ═══
INSERT INTO fleet_ledger_accounts (account_id, class, description, created_by) VALUES
  ('${UNBACKED_ESTATES_ACCOUNT}', 'treasury_cash', 'Estate cash up to the still-unbacked starting capital (never unallocated)', 'migration:v122') ON CONFLICT DO NOTHING;

-- ═══ An unwound acquisition cost goes back to waiting; posted_minor keeps advancing so keys never repeat ═══
ALTER TABLE fleet_ai_credit_cost_accrual ADD COLUMN unwound_minor bigint NOT NULL DEFAULT 0 CHECK (unwound_minor >= 0);

${ESTATE_SETTLE}

${ESTATE_FREEZE}

-- ═══ The owner's incident reinstatement (atomic; nothing partial) ═══
CREATE FUNCTION fleet_admin_incident_reinstate(p_incident text, p_agents text[], p_unwind_journals uuid[], p_hold_minutes integer, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE st fleet_state; a fleet_agents; es fleet_estates; j fleet_ledger_journal; v_rev uuid; v_cause text; v_amt bigint; v_lot uuid; v_payer text;
        m text[]; v_out jsonb := '[]'::jsonb; v_unw jsonb := '[]'::jsonb; v_id text; v_tj uuid; v_cred integer;
BEGIN
  ${OWNER_ACTOR}
  IF p_incident IS NULL OR length(btrim(p_incident)) < 3 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: name the incident'; END IF;
  IF p_agents IS NULL OR cardinality(p_agents) = 0 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: at least one agent'; END IF;
  IF p_hold_minutes IS NULL OR p_hold_minutes NOT BETWEEN ${HOLD_MIN_MINUTES} AND ${HOLD_MAX_MINUTES} THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: a verification hold of ${HOLD_MIN_MINUTES}..${HOLD_MAX_MINUTES} minutes';
  END IF;
  st := fleet_lock_state();
  -- 1. Acquisition costs that posted only on unbacked estate money: mirrored reversal, back to waiting.
  FOREACH v_rev IN ARRAY COALESCE(p_unwind_journals, '{}') LOOP
    SELECT * INTO j FROM fleet_ledger_journal WHERE journal_id = v_rev;
    IF NOT FOUND OR j.kind <> 'ai_credit_acquisition_cost' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: % is not an AI-credit acquisition cost', v_rev; END IF;
    IF EXISTS (SELECT 1 FROM fleet_ledger_journal r WHERE r.reverses_journal_id = j.journal_id) THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: % is already reversed', v_rev; END IF;
    m := regexp_match(j.idempotency_key, '^ai-credit-cost:([0-9a-f-]{36}):(.+):([0-9]+)$');
    IF m IS NULL THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: % has no accrual key', v_rev; END IF;
    v_lot := m[1]::uuid; v_payer := m[2];
    SELECT p.amount_cents INTO v_amt FROM fleet_ledger_postings p WHERE p.journal_id = j.journal_id AND p.side = 'D'
       AND (p.account_id = 'fleet:expense' OR p.account_id LIKE 'agent:%:expense') LIMIT 1;
    PERFORM fleet_admin_reverse(j.journal_id, p_actor, 'incident ' || left(p_incident, 200) || ': acquisition cost posted on unbacked estate money; back to waiting',
      'incident-unwind:' || j.journal_id);
    UPDATE fleet_ai_credit_cost_accrual SET unposted_micro = unposted_micro + v_amt * 1000000, unwound_minor = unwound_minor + v_amt
     WHERE lot_id = v_lot AND payer = v_payer;
    IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: no accrual for %', v_rev; END IF;
    PERFORM fleet_event('ai_cost_unwound', NULL, p_actor, jsonb_build_object('journalId', j.journal_id, 'seq', j.seq, 'amountMinor', v_amt, 'incident', left(p_incident, 200)));
    v_unw := v_unw || jsonb_build_object('journalId', j.journal_id, 'seq', j.seq, 'amountMinor', v_amt);
  END LOOP;
  -- 2. Each founder: guards, estate reversal, identity restored, paused, a challenge due.
  FOREACH v_id IN ARRAY p_agents LOOP
    SELECT * INTO a FROM fleet_agents WHERE agent_id = v_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: %', v_id; END IF;
    IF a.origin NOT IN ('genesis_founder','reseed_founder') THEN RAISE EXCEPTION 'FLEET_REINSTATE_REFUSED: % is not a founder', v_id; END IF;
    IF a.status <> 'dead' OR a.sandbox_id IS NOT NULL THEN RAISE EXCEPTION 'FLEET_REINSTATE_REFUSED: % is % (only a dead founder without a sandbox)', v_id, a.status; END IF;
    IF a.death_time < now() - interval '${REINSTATE_WINDOW_DAYS} days' THEN RAISE EXCEPTION 'FLEET_REINSTATE_REFUSED: % died more than ${REINSTATE_WINDOW_DAYS} days ago', v_id; END IF;
    SELECT e.detail ->> 'cause' INTO v_cause FROM fleet_events e WHERE e.agent_id = v_id AND e.event_type = 'agent_died' ORDER BY e.id DESC LIMIT 1;
    IF v_cause IS NULL OR v_cause NOT IN (${q(REINSTATABLE_CAUSES)}) THEN
      RAISE EXCEPTION 'FLEET_REINSTATE_REFUSED: % died of % (only health or heartbeat timeouts are reinstated)', v_id, COALESCE(v_cause, 'an unknown cause');
    END IF;
    SELECT * INTO es FROM fleet_estates WHERE agent_id = v_id FOR UPDATE;
    IF NOT FOUND OR es.status <> 'settled' THEN RAISE EXCEPTION 'FLEET_REINSTATE_REFUSED: % has no settled estate', v_id; END IF;
    IF COALESCE((es.summary ->> 'assetsToTreasury')::bigint, 0) <> 0 OR COALESCE((es.summary ->> 'principalRecovered')::bigint, 0) <> 0
       OR COALESCE((es.summary ->> 'principalWrittenOff')::bigint, 0) <> 0 OR COALESCE((es.summary ->> 'payableRepaid')::bigint, 0) <> 0
       OR COALESCE((es.summary ->> 'payableWrittenOff')::bigint, 0) <> 0 THEN
      RAISE EXCEPTION 'FLEET_REINSTATE_REFUSED: %''s estate moved more than cash (reverse it by hand)', v_id;
    END IF;
    IF EXISTS (SELECT 1 FROM fleet_ledger_journal x WHERE x.agent_id = v_id AND x.kind = 'estate_transfer' AND x.idempotency_key LIKE 'estate:transfer:' || v_id || ':late:%') THEN
      RAISE EXCEPTION 'FLEET_REINSTATE_REFUSED: % received money after its estate settled (reverse it by hand)', v_id;
    END IF;
    v_tj := NULL;
    SELECT x.journal_id INTO v_tj FROM fleet_ledger_journal x WHERE x.agent_id = v_id AND x.kind = 'estate_transfer'
       AND NOT EXISTS (SELECT 1 FROM fleet_ledger_journal r WHERE r.reverses_journal_id = x.journal_id) ORDER BY x.seq DESC LIMIT 1;
    IF COALESCE((es.summary ->> 'cashToTreasury')::bigint, 0) > 0 AND v_tj IS NULL THEN
      RAISE EXCEPTION 'FLEET_REINSTATE_REFUSED: %''s estate transfer is missing or already reversed', v_id;
    END IF;
    v_rev := NULL;
    IF v_tj IS NOT NULL THEN
      v_rev := fleet_admin_reverse(v_tj, p_actor, 'incident ' || left(p_incident, 200) || ': estate reverted; the founder is reinstated', 'incident-reinstate:' || v_tj);
    END IF;
    INSERT INTO fleet_estate_reversions (agent_id, incident, previous_summary, settled_at, transfer_journal_id, reversal_journal_id, reverted_by)
      VALUES (v_id, left(p_incident, 300), es.summary, es.settled_at, v_tj, v_rev, p_actor);
    UPDATE fleet_estates SET status = 'reverted' WHERE agent_id = v_id;
    PERFORM fleet_event('estate_reverted', v_id, p_actor, jsonb_build_object('transferJournalId', v_tj, 'reversalJournalId', v_rev, 'incident', left(p_incident, 200)));
    -- The credential and wallet authority taken at death (and only those) come back.
    UPDATE fleet_agent_credentials SET revoked_at = NULL WHERE agent_id = v_id AND revoked_at = a.death_time;
    GET DIAGNOSTICS v_cred = ROW_COUNT;
    IF v_cred = 0 THEN RAISE EXCEPTION 'FLEET_REINSTATE_REFUSED: %''s credential was not revoked by its death', v_id; END IF;
    UPDATE fleet_wallet_custody SET spending_frozen = false, frozen_reason = NULL, frozen_at = NULL, updated_at = now()
     WHERE agent_id = v_id AND frozen_reason = 'agent dead';
    PERFORM set_config('fleet.reinstate_op', v_id, true);
    UPDATE fleet_agents SET status = 'unresponsive', death_time = NULL, challenge_failures = 0, challenge_requested_at = now(),
           lifecycle_hold_until = now() + make_interval(mins => p_hold_minutes), lifecycle_hold_reason = left('verification after reinstatement: ' || p_incident, 300),
           status_reason = left('reinstated after incident ' || p_incident || '; active only after a passed health challenge', 500),
           health_reason = 'reinstated: awaiting a passed health challenge', updated_at = now()
     WHERE agent_id = v_id;
    PERFORM set_config('fleet.reinstate_op', '', true);
    UPDATE fleet_founder_cognition SET enabled = true, paused = true, updated_by = p_actor, updated_at = now(),
           reason = left('reinstated (paused) after incident ' || p_incident, 300)
     WHERE agent_id = v_id;
    PERFORM fleet_event('agent_reinstated', v_id, p_actor, jsonb_build_object('incident', left(p_incident, 200), 'reversalJournalId', v_rev,
      'diedAt', a.death_time, 'cause', v_cause, 'status', 'unresponsive', 'paused', true, 'holdMinutes', p_hold_minutes));
    v_out := v_out || jsonb_build_object('agentId', v_id, 'reversalJournalId', v_rev, 'diedAt', a.death_time, 'cause', v_cause);
  END LOOP;
  IF fleet_ledger_balance('fleet:treasury:unallocated') < 0 THEN RAISE EXCEPTION 'FLEET_LEDGER_NEGATIVE: unallocated would be negative'; END IF;
  IF (fleet_ledger_verify() ->> 'ok')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'FLEET_LEDGER_INVALID: the ledger does not verify after reinstatement'; END IF;
  RETURN jsonb_build_object('ok', true, 'incident', left(p_incident, 200), 'reinstated', v_out, 'unwound', v_unw,
    'holdUntil', now() + make_interval(mins => p_hold_minutes),
    'note', 'agents are unresponsive and paused, protected from automatic termination until the hold ends; each becomes active only by passing the health challenge due at its next heartbeat (which ends its hold)');
END $$;

-- The owner ends a verification hold early (normal lifecycle rules apply again at once; the full grace runs from now).
CREATE FUNCTION fleet_admin_lifecycle_hold_end(p_agent text, p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_agents;
BEGIN
  ${OWNER_ACTOR}
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a reason is required'; END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: %', p_agent; END IF;
  IF a.lifecycle_hold_until IS NULL OR a.lifecycle_hold_until <= now() THEN RETURN jsonb_build_object('ok', true, 'replay', true); END IF;
  UPDATE fleet_agents SET lifecycle_hold_until = now(), lifecycle_hold_reason = NULL, unresponsive_since = CASE WHEN status = 'unresponsive' THEN now() ELSE unresponsive_since END
   WHERE agent_id = p_agent;
  PERFORM fleet_event('lifecycle_hold_ended', p_agent, p_actor, jsonb_build_object('reason', left(fleet_scrub(btrim(p_reason)), 300)));
  RETURN jsonb_build_object('ok', true);
END $$;

${restate(V120_SQL, "fleet_event_route", [["    WHEN p_type = 'spend_circuit_breaker_set' THEN",
  (Object.entries(EVENT_ROUTES_V122) as Array<[string, readonly string[]]>)
    .map(([lvl, types]) => `    WHEN p_type IN (${q(types)}) THEN '${lvl}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"]])}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

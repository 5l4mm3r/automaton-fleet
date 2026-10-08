/**
 * Schema v50 — the operating loop's lifecycle and knowledge (docs/design/master-launch-specification.md §§8, 9).
 *
 * 1. INSOLVENCY IS A STATE, NOT A QUOTA. An active agent with nothing it can spend (spendable = min(cash, survival equity)
 *    = 0) and nothing in flight that could change that (no open PayPal checkout, no active envelope, no card hold, no
 *    reserved order) becomes DORMANT: the owner is told (P1), nothing else is taken from it, and any receipt, allocation
 *    or transfer clears it at the next pass. Death follows only if the owner sets death_after_hours (default: never) — an
 *    insolvent agent past that grace, not held by the owner, dies with cause `insolvent` and the existing estate flow
 *    runs. No work quota, score or own-capital threshold is involved.
 * 2. BURN COUNTS COMMITMENTS. The survival observation's burn is inference (7 days) plus the agent's active recurring
 *    commitments, normalised per day (phone rentals are commitments since v41).
 * 3. TEMPORARY SWEEP REDUCTIONS. Fleet Control may lower an agent's sweep rate by a number of basis points until an expiry
 *    (≤ 180 days); agents may ask for one with a reason. The sweep uses the larger of an active reduction and an envelope's
 *    reinvestment reduction; an expired reduction reverts by itself and is recorded. The sweep stays net-profit only.
 * 4. THE FOUNDATIONAL LIBRARY. 49 researched entries (8 categories) are stored versioned; `knowledge.library` returns the
 *    best matches for a query or category, always with the entry's hard rules, and a VERIFY BEFORE RELYING banner when a
 *    changeable fact is stale or unverified. Health / legal / finance and review topics always include the matching
 *    compliance entry. Nothing is injected into turns.
 * 5. SHARED LESSONS CARRY NO PERSONAL DATA. Fleet-shared economic knowledge and knowledge proposals are scrubbed of
 *    e-mail addresses, phone numbers, card-like and bank numbers, sort codes and postcodes before they are stored.
 */
import { KNOWLEDGE_LIBRARY_V1 as LIBRARY } from "./knowledge-library-v1.js";
import { V26_SQL } from "./migrations-phase26.js";
import { V42_SQL } from "./migrations-phase42.js";
import { V49_SQL } from "./migrations-phase49.js";
import { restate as restateRaw } from "./migrations-phase42.js";

/** restate() applies String.replace: every literal "$" of a replacement is escaped ("$'" would splice in the text after the match). */
const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));

export const EVENT_ROUTES_V50 = Object.freeze({
  P1_HIGH: ["agent_dormant_insolvent", "insolvency_policy_set"],
  P2_IMPORTANT: ["agent_solvent_again", "sweep_reduction_granted", "sweep_reduction_requested", "sweep_reduction_ended", "knowledge_library_loaded"],
} as const);
export const LIBRARY_OPS = ["knowledge.library", "sweep.reduction_request", "sweep.reductions"] as const;
export const DASHBOARD_READ_OPS_V50 = ["insolvency", "sweep_reductions", "knowledge_library"] as const;
export const DASHBOARD_SENSITIVE_OPS_V50 = ["insolvency_policy_set", "sweep_reduction_grant", "sweep_reduction_end", "sweep_reduction_decline", "paypal_txn_attribute"] as const;

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const lit = (v: unknown) => `'${JSON.stringify(v).replace(/'/g, "''")}'`;
const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;`;

// ── Restatements ──
const SURVIVAL = restate(V26_SQL, "fleet_survival_observation", [
  [`               FROM fleet_cognition_log WHERE agent_id = p_agent AND at > now() - interval '7 days')`,
   `               FROM fleet_cognition_log WHERE agent_id = p_agent AND at > now() - interval '7 days'),
       c AS (SELECT COALESCE(sum(amount_minor::numeric / CASE period WHEN 'weekly' THEN 7 WHEN 'monthly' THEN 30.4 WHEN 'quarterly' THEN 91.3 WHEN 'yearly' THEN 365 END)
                    FILTER (WHERE period <> 'once'), 0) AS per_day
               FROM fleet_agent_commitments WHERE agent_id = p_agent AND status = 'active')`],
  [`  SELECT jsonb_build_object('survivalEquityCents', e.eq, 'inferenceTodayCents', ceil(b.today)::bigint, 'burnPerDayCents', round(b.per_day, 1),
    'runwayDays', CASE WHEN b.per_day > 0 THEN round(GREATEST(e.eq, 0) / b.per_day, 1) END, 'burnBasis', 'inference, last 7 days')
    FROM e CROSS JOIN b`,
   `  SELECT jsonb_build_object('survivalEquityCents', e.eq, 'inferenceTodayCents', ceil(b.today)::bigint, 'burnPerDayCents', round(b.per_day + c.per_day, 1),
    'inferenceBurnPerDayCents', round(b.per_day, 1), 'commitmentsPerDayCents', round(c.per_day, 1),
    'runwayDays', CASE WHEN b.per_day + c.per_day > 0 THEN round(GREATEST(e.eq, 0) / (b.per_day + c.per_day), 1) END,
    'burnBasis', 'inference over the last 7 days plus active recurring commitments')
    FROM e CROSS JOIN b CROSS JOIN c`],
]);

const SWEEP_COMPUTE = restate(V42_SQL, "fleet_sweep_compute", [
  [`  SELECT COALESCE(max(sweep_reduction_bp), 0) INTO v_red FROM fleet_envelopes WHERE agent_id = p_agent AND status = 'active';`,
   `  SELECT COALESCE(max(sweep_reduction_bp), 0) INTO v_red FROM fleet_envelopes WHERE agent_id = p_agent AND status = 'active';
  -- v50: an active temporary reduction (Fleet Control, with expiry) counts like an envelope's reinvestment reduction.
  v_red := GREATEST(v_red, COALESCE((SELECT max(reduction_bp) FROM fleet_sweep_rate_reductions WHERE agent_id = p_agent AND status = 'active' AND expires_at > now()), 0));`],
]);

const DISPATCH = restate(V49_SQL, "api_economy", [
  [`WHEN 'card.authorize' THEN 'planning'`,
   `WHEN 'knowledge.library' THEN 'knowledge.read' WHEN 'sweep.reduction_request' THEN 'ledger.read' WHEN 'sweep.reductions' THEN 'ledger.read' WHEN 'card.authorize' THEN 'planning'`],
  [`      WHEN 'card.authorize' THEN fleet_econ_card_authorize(p_agent, a)`,
   `      WHEN 'knowledge.library' THEN fleet_econ_knowledge_library(p_agent, a)
      WHEN 'sweep.reduction_request' THEN fleet_econ_sweep_reduction_request(p_agent, a)
      WHEN 'sweep.reductions' THEN fleet_econ_sweep_reductions(p_agent, a)
      WHEN 'card.authorize' THEN fleet_econ_card_authorize(p_agent, a)`],
]);

const DASH_CALL = restate(V49_SQL, "dash_call", [
  [`'custody_credential_revoke','rail_webhook_set');`, `'custody_credential_revoke','rail_webhook_set',${q(DASHBOARD_SENSITIVE_OPS_V50)});`],
  [`'identity_uses','custody_key')) THEN`, `'identity_uses','custody_key',${q(DASHBOARD_READ_OPS_V50)})) THEN`],
  [`      WHEN 'custody_key' THEN fleet_custody_key_json()`,
   `      WHEN 'custody_key' THEN fleet_custody_key_json()
      -- v50: lifecycle and knowledge
      WHEN 'insolvency' THEN fleet_insolvency_json()
      WHEN 'sweep_reductions' THEN fleet_sweep_rate_reductions_json(a ->> 'agentId')
      WHEN 'knowledge_library' THEN fleet_knowledge_library_search(a ->> 'query', a ->> 'category', COALESCE((a ->> 'limit')::integer, 20), true)`],
  [`      WHEN 'identity_autonomy_set' THEN`,
   `      WHEN 'insolvency_policy_set' THEN fleet_admin_insolvency_policy_set(COALESCE((a ->> 'dormancyEnabled')::boolean, true), (a ->> 'deathAfterHours')::integer, 'operator:owner')
      WHEN 'sweep_reduction_grant' THEN fleet_admin_sweep_reduction_grant(a ->> 'agentId', (a ->> 'reductionBp')::integer, (a ->> 'days')::integer, a ->> 'reason',
          (a ->> 'requestId')::uuid, 'operator:owner')
      WHEN 'sweep_reduction_end' THEN fleet_admin_sweep_reduction_end((a ->> 'reductionId')::uuid, a ->> 'reason', 'operator:owner')
      WHEN 'sweep_reduction_decline' THEN fleet_admin_sweep_reduction_decline((a ->> 'requestId')::uuid, a ->> 'reason', 'operator:owner')
      WHEN 'paypal_txn_attribute' THEN fleet_admin_paypal_txn_attribute((a ->> 'railId')::uuid, a ->> 'transactionId', a ->> 'eventCode', a ->> 'as', a ->> 'reference', 'operator:owner')
      WHEN 'identity_autonomy_set' THEN`],
]);

const EVENT_ROUTE = restate(V49_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V50) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
]);

export const V50_SQL = `
-- ═══ 1. Insolvency → dormancy (→ death only if the owner sets a grace) ═══
CREATE TABLE fleet_insolvency_policy (
  id                smallint    PRIMARY KEY CHECK (id = 1),
  dormancy_enabled  boolean     NOT NULL DEFAULT true,
  death_after_hours integer     CHECK (death_after_hours BETWEEN 24 AND 8760),
  updated_by        text        NOT NULL DEFAULT 'migration',
  updated_at        timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fleet_insolvency_policy (id) VALUES (1);
CREATE TRIGGER fleet_insolvency_policy_no_delete BEFORE DELETE ON fleet_insolvency_policy FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_agent_insolvency (
  episode_id   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     text        NOT NULL REFERENCES fleet_agents(agent_id),
  status       text        NOT NULL DEFAULT 'dormant' CHECK (status IN ('dormant','cleared','died')),
  since        timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz,
  detail       jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object' AND length(detail::text) <= 2000),
  CHECK ((status = 'dormant') = (ended_at IS NULL))
);
CREATE UNIQUE INDEX fleet_agent_insolvency_open ON fleet_agent_insolvency (agent_id) WHERE status = 'dormant';
CREATE TRIGGER fleet_agent_insolvency_no_delete BEFORE DELETE ON fleet_agent_insolvency FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- What could still change an agent's position (nothing here is a judgement of its work).
CREATE FUNCTION fleet_agent_in_flight(p_agent text) RETURNS boolean LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM fleet_paypal_checkouts WHERE agent_id = p_agent AND status IN ('open','approved','capture_pending'))
      OR EXISTS (SELECT 1 FROM fleet_envelopes WHERE agent_id = p_agent AND status = 'active')
      OR EXISTS (SELECT 1 FROM fleet_card_charges WHERE agent_id = p_agent AND status = 'held')
      OR EXISTS (SELECT 1 FROM fleet_payment_orders WHERE agent_id = p_agent AND status IN ('reserved','executing'))
      OR EXISTS (SELECT 1 FROM fleet_card_receipts WHERE agent_id = p_agent AND status = 'invoiced')
$$;

CREATE FUNCTION fleet_agent_insolvent(p_agent text) RETURNS boolean LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT GREATEST(0, LEAST((e ->> 'cash')::bigint, (e ->> 'survivalEquity')::bigint)) = 0 AND NOT fleet_agent_in_flight(p_agent)
    FROM (SELECT fleet_agent_economics(p_agent) AS e) x
$$;

CREATE FUNCTION svc_insolvency_tick() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_insolvency_policy; a record; ep fleet_agent_insolvency; nd integer := 0; nc integer := 0; nx integer := 0;
BEGIN
  SELECT * INTO p FROM fleet_insolvency_policy WHERE id = 1;
  IF NOT p.dormancy_enabled THEN RETURN jsonb_build_object('ok', true, 'enabled', false); END IF;
  FOR a IN SELECT agent_id, operator_hold_at FROM fleet_agents WHERE status = 'active' AND EXISTS (SELECT 1 FROM fleet_ledger_accounts x WHERE x.agent_id = fleet_agents.agent_id) LOOP
    SELECT * INTO ep FROM fleet_agent_insolvency WHERE agent_id = a.agent_id AND status = 'dormant';
    IF fleet_agent_insolvent(a.agent_id) THEN
      IF ep.episode_id IS NULL THEN
        INSERT INTO fleet_agent_insolvency (agent_id, detail) VALUES (a.agent_id, jsonb_build_object('economics', fleet_agent_economics(a.agent_id) - 'genesisAllocation'));
        PERFORM fleet_event('agent_dormant_insolvent', a.agent_id, 'controller', jsonb_build_object('deathAfterHours', p.death_after_hours,
          'note', 'nothing spendable and nothing in flight; any receipt, allocation or transfer clears this'));
        nd := nd + 1;
      ELSIF p.death_after_hours IS NOT NULL AND a.operator_hold_at IS NULL AND ep.since < now() - make_interval(hours => p.death_after_hours) THEN
        UPDATE fleet_agent_insolvency SET status = 'died', ended_at = now() WHERE episode_id = ep.episode_id;
        PERFORM fleet_mark_dead(a.agent_id, format('insolvent for more than %s hours', p.death_after_hours), 'controller', 'insolvent');
        nx := nx + 1;
      END IF;
    ELSIF ep.episode_id IS NOT NULL THEN
      UPDATE fleet_agent_insolvency SET status = 'cleared', ended_at = now() WHERE episode_id = ep.episode_id;
      PERFORM fleet_event('agent_solvent_again', a.agent_id, 'controller', jsonb_build_object('dormantSince', ep.since));
      nc := nc + 1;
    END IF;
  END LOOP;
  -- An agent that died otherwise closes its episode.
  UPDATE fleet_agent_insolvency i SET status = 'died', ended_at = now() FROM fleet_agents g
   WHERE g.agent_id = i.agent_id AND i.status = 'dormant' AND g.status NOT IN ('active','unresponsive');
  RETURN jsonb_build_object('ok', true, 'enabled', true, 'dormant', nd, 'cleared', nc, 'died', nx);
END $$;

CREATE FUNCTION fleet_admin_insolvency_policy_set(p_dormancy boolean, p_death_after_hours integer, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_insolvency_policy;
BEGIN
  ${OWNER_ACTOR}
  UPDATE fleet_insolvency_policy SET dormancy_enabled = COALESCE(p_dormancy, true), death_after_hours = p_death_after_hours, updated_by = p_actor, updated_at = now()
   WHERE id = 1 RETURNING * INTO r;
  PERFORM fleet_event('insolvency_policy_set', NULL, p_actor, jsonb_build_object('dormancyEnabled', r.dormancy_enabled, 'deathAfterHours', r.death_after_hours));
  RETURN jsonb_build_object('ok', true, 'dormancyEnabled', r.dormancy_enabled, 'deathAfterHours', r.death_after_hours);
END $$;

CREATE FUNCTION fleet_insolvency_json() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('policy', (SELECT jsonb_build_object('dormancyEnabled', dormancy_enabled, 'deathAfterHours', death_after_hours, 'updatedAt', updated_at)
                                        FROM fleet_insolvency_policy WHERE id = 1),
    'episodes', COALESCE((SELECT jsonb_agg(jsonb_build_object('agentId', i.agent_id, 'status', i.status, 'since', i.since, 'endedAt', i.ended_at) ORDER BY i.since DESC)
                          FROM (SELECT * FROM fleet_agent_insolvency ORDER BY since DESC LIMIT 100) i), '[]'::jsonb))
$$;

${SURVIVAL}

-- ═══ 2. Temporary sweep reductions ═══
CREATE TABLE fleet_sweep_rate_reduction_requests (
  request_id   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     text        NOT NULL REFERENCES fleet_agents(agent_id),
  reduction_bp integer     NOT NULL CHECK (reduction_bp BETWEEN 1 AND 10000),
  days         integer     NOT NULL CHECK (days BETWEEN 1 AND 180),
  reason       text        NOT NULL CHECK (length(reason) BETWEEN 10 AND 1000),
  status       text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','granted','declined','withdrawn')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz
);
CREATE TRIGGER fleet_sweep_rate_reduction_requests_no_delete BEFORE DELETE ON fleet_sweep_rate_reduction_requests FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TABLE fleet_sweep_rate_reductions (
  reduction_id uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     text        NOT NULL REFERENCES fleet_agents(agent_id),
  request_id   uuid        REFERENCES fleet_sweep_rate_reduction_requests(request_id),
  reduction_bp integer     NOT NULL CHECK (reduction_bp BETWEEN 1 AND 10000),
  reason       text        NOT NULL CHECK (length(reason) BETWEEN 3 AND 1000),
  starts_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  status       text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','ended')),
  ended_at     timestamptz,
  decided_by   text        NOT NULL,
  CHECK (expires_at > starts_at AND expires_at <= starts_at + interval '180 days'),
  CHECK ((status = 'active') = (ended_at IS NULL))
);
CREATE INDEX fleet_sweep_rate_reductions_agent ON fleet_sweep_rate_reductions (agent_id, status);
CREATE FUNCTION fleet_sweep_rate_reductions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'active' THEN RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: a sweep reduction is history once ended'; END IF;
  IF NEW.reduction_id <> OLD.reduction_id OR NEW.agent_id <> OLD.agent_id OR NEW.reduction_bp <> OLD.reduction_bp OR NEW.starts_at <> OLD.starts_at
     OR NEW.expires_at <> OLD.expires_at OR NEW.reason <> OLD.reason THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: a granted reduction is fixed (end it and grant another)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_sweep_rate_reductions_guard BEFORE UPDATE OR DELETE ON fleet_sweep_rate_reductions FOR EACH ROW EXECUTE FUNCTION fleet_sweep_rate_reductions_guard();

CREATE FUNCTION fleet_sweep_rate_reductions_json(p_agent text) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'reductions', COALESCE((SELECT jsonb_agg(jsonb_build_object('reductionId', r.reduction_id, 'agentId', r.agent_id, 'reductionBp', r.reduction_bp, 'reason', r.reason,
        'startsAt', r.starts_at, 'expiresAt', r.expires_at, 'status', r.status, 'endedAt', r.ended_at) ORDER BY r.starts_at DESC)
        FROM fleet_sweep_rate_reductions r WHERE p_agent IS NULL OR r.agent_id = p_agent), '[]'::jsonb),
    'requests', COALESCE((SELECT jsonb_agg(jsonb_build_object('requestId', x.request_id, 'agentId', x.agent_id, 'reductionBp', x.reduction_bp, 'days', x.days,
        'reason', x.reason, 'status', x.status, 'at', x.created_at) ORDER BY x.created_at DESC)
        FROM fleet_sweep_rate_reduction_requests x WHERE p_agent IS NULL OR x.agent_id = p_agent), '[]'::jsonb))
$$;

CREATE FUNCTION fleet_econ_sweep_reduction_request(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_bp integer; v_days integer; v_reason text := fleet_econ_text(a, 'reason', 1000, true); v_id uuid;
BEGIN
  v_bp := CASE WHEN jsonb_typeof(a -> 'reductionBp') = 'number' THEN (a ->> 'reductionBp')::integer END;
  v_days := CASE WHEN jsonb_typeof(a -> 'days') = 'number' THEN (a ->> 'days')::integer END;
  IF v_bp IS NULL OR v_bp NOT BETWEEN 1 AND 10000 OR v_days IS NULL OR v_days NOT BETWEEN 1 AND 180 OR length(v_reason) < 10 THEN
    PERFORM fleet_econ_bad('reductionBp 1..10000, days 1..180 and a reason (what the retained profit will be reinvested in)');
  END IF;
  IF EXISTS (SELECT 1 FROM fleet_sweep_rate_reduction_requests WHERE agent_id = p_agent AND status = 'pending') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_REQUEST_PENDING', 'reason', 'one request at a time');
  END IF;
  INSERT INTO fleet_sweep_rate_reduction_requests (agent_id, reduction_bp, days, reason) VALUES (p_agent, v_bp, v_days, left(fleet_scrub(v_reason), 1000)) RETURNING request_id INTO v_id;
  PERFORM fleet_event('sweep_reduction_requested', p_agent, p_agent, jsonb_build_object('requestId', v_id, 'reductionBp', v_bp, 'days', v_days));
  RETURN jsonb_build_object('ok', true, 'requestId', v_id, 'status', 'pending', 'note', 'Fleet Control decides; the sweep stays on net profit only');
END $$;

CREATE FUNCTION fleet_econ_sweep_reductions(p_agent text, a jsonb) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('ok', true, 'sweep', fleet_sweep_compute(p_agent) - 'livingAgents') || fleet_sweep_rate_reductions_json(p_agent)
$$;

CREATE FUNCTION fleet_admin_sweep_reduction_grant(p_agent text, p_bp integer, p_days integer, p_reason text, p_request uuid, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_id uuid; rq fleet_sweep_rate_reduction_requests;
BEGIN
  ${OWNER_ACTOR}
  IF NOT EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = p_agent) THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: unknown agent'; END IF;
  IF p_bp IS NULL OR p_bp NOT BETWEEN 1 AND 10000 OR p_days IS NULL OR p_days NOT BETWEEN 1 AND 180 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: 1..10000 bp for 1..180 days'; END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a reason is required'; END IF;
  IF p_request IS NOT NULL THEN
    SELECT * INTO rq FROM fleet_sweep_rate_reduction_requests WHERE request_id = p_request AND agent_id = p_agent FOR UPDATE;
    IF NOT FOUND OR rq.status <> 'pending' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: not a pending request of this agent'; END IF;
    UPDATE fleet_sweep_rate_reduction_requests SET status = 'granted', decided_at = now() WHERE request_id = p_request;
  END IF;
  INSERT INTO fleet_sweep_rate_reductions (agent_id, request_id, reduction_bp, reason, expires_at, decided_by)
    VALUES (p_agent, p_request, p_bp, left(fleet_scrub(p_reason), 1000), now() + make_interval(days => p_days), p_actor) RETURNING reduction_id INTO v_id;
  PERFORM fleet_event('sweep_reduction_granted', p_agent, p_actor, jsonb_build_object('reductionId', v_id, 'reductionBp', p_bp, 'days', p_days));
  RETURN jsonb_build_object('ok', true, 'reductionId', v_id, 'sweep', fleet_sweep_compute(p_agent) - 'livingAgents');
END $$;

CREATE FUNCTION fleet_admin_sweep_reduction_end(p_reduction uuid, p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_sweep_rate_reductions;
BEGIN
  ${OWNER_ACTOR}
  UPDATE fleet_sweep_rate_reductions SET status = 'ended', ended_at = now() WHERE reduction_id = p_reduction AND status = 'active' RETURNING * INTO r;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no active reduction with that id'; END IF;
  PERFORM fleet_event('sweep_reduction_ended', r.agent_id, p_actor, jsonb_build_object('reductionId', p_reduction, 'reason', left(fleet_scrub(p_reason), 200)));
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE FUNCTION fleet_admin_sweep_reduction_decline(p_request uuid, p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE rq fleet_sweep_rate_reduction_requests;
BEGIN
  ${OWNER_ACTOR}
  UPDATE fleet_sweep_rate_reduction_requests SET status = 'declined', decided_at = now() WHERE request_id = p_request AND status = 'pending' RETURNING * INTO rq;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no pending request with that id'; END IF;
  PERFORM fleet_event('sweep_reduction_ended', rq.agent_id, p_actor, jsonb_build_object('requestId', p_request, 'declined', true, 'reason', left(fleet_scrub(p_reason), 200)));
  RETURN jsonb_build_object('ok', true);
END $$;

-- Reaper: a lapsed reduction reverts by itself (recorded).
CREATE FUNCTION svc_sweep_reductions_expire() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_sweep_rate_reductions; n integer := 0;
BEGIN
  FOR r IN SELECT * FROM fleet_sweep_rate_reductions WHERE status = 'active' AND expires_at <= now() FOR UPDATE SKIP LOCKED LOOP
    UPDATE fleet_sweep_rate_reductions SET status = 'expired', ended_at = now() WHERE reduction_id = r.reduction_id;
    PERFORM fleet_event('sweep_reduction_ended', r.agent_id, 'controller', jsonb_build_object('reductionId', r.reduction_id, 'expired', true));
    n := n + 1;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'expired', n);
END $$;

${SWEEP_COMPUTE}

-- ═══ 3. The foundational knowledge library ═══
CREATE TABLE fleet_knowledge_library (
  entry_id      text        NOT NULL CHECK (entry_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  version       integer     NOT NULL CHECK (version >= 1),
  category      text        NOT NULL CHECK (category IN ('demand-validation','product-formats-pricing','sales-channels','acquisition','delivery-support',
                                                         'uk-legal-compliance','unit-economics','ethics-safety')),
  title         text        NOT NULL CHECK (length(title) BETWEEN 3 AND 120),
  body          text        NOT NULL CHECK (length(body) BETWEEN 10 AND 6000),
  tags          text[]      NOT NULL DEFAULT '{}',
  keywords      text[]      NOT NULL DEFAULT '{}',
  facts         jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(facts) = 'array'),
  hard_rules    text[]      NOT NULL DEFAULT '{}',
  sources       jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sources) = 'array'),
  last_reviewed date        NOT NULL,
  loaded_by     text        NOT NULL,
  loaded_at     timestamptz NOT NULL DEFAULT now(),
  current       boolean     NOT NULL DEFAULT true,
  PRIMARY KEY (entry_id, version)
);
CREATE UNIQUE INDEX fleet_knowledge_library_current ON fleet_knowledge_library (entry_id) WHERE current;
CREATE FUNCTION fleet_knowledge_library_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (to_jsonb(NEW) - 'current') IS DISTINCT FROM (to_jsonb(OLD) - 'current') OR (NOT OLD.current AND NEW.current) THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: a library entry version is fixed (load a new version)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_knowledge_library_guard BEFORE UPDATE OR DELETE ON fleet_knowledge_library FOR EACH ROW EXECUTE FUNCTION fleet_knowledge_library_guard();

-- Load a library (new versions supersede; an unchanged entry is not reloaded).
CREATE FUNCTION fleet_admin_knowledge_library_load(p_library jsonb, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE e jsonb; n integer := 0; v_cur integer;
BEGIN
  IF p_actor IS NULL OR (p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' AND p_actor <> 'migration') THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  IF p_library IS NULL OR jsonb_typeof(p_library -> 'entries') <> 'array' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: {entries:[…]}'; END IF;
  FOR e IN SELECT x FROM jsonb_array_elements(p_library -> 'entries') x LOOP
    SELECT version INTO v_cur FROM fleet_knowledge_library WHERE entry_id = e ->> 'id' AND current;
    IF v_cur IS NOT NULL AND v_cur >= (e ->> 'version')::integer THEN CONTINUE; END IF;
    UPDATE fleet_knowledge_library SET current = false WHERE entry_id = e ->> 'id' AND current;
    INSERT INTO fleet_knowledge_library (entry_id, version, category, title, body, tags, keywords, facts, hard_rules, sources, last_reviewed, loaded_by)
      VALUES (e ->> 'id', (e ->> 'version')::integer, e ->> 'category', e ->> 'title', e ->> 'body',
        ARRAY(SELECT jsonb_array_elements_text(COALESCE(e -> 'tags', '[]'))), ARRAY(SELECT jsonb_array_elements_text(COALESCE(e -> 'keywords', '[]'))),
        COALESCE(e -> 'factsThatChange', '[]'), ARRAY(SELECT jsonb_array_elements_text(COALESCE(e -> 'hardRules', '[]'))), COALESCE(e -> 'sources', '[]'),
        (e ->> 'lastReviewed')::date, p_actor);
    n := n + 1;
  END LOOP;
  IF n > 0 AND p_actor <> 'migration' THEN PERFORM fleet_event('knowledge_library_loaded', NULL, p_actor, jsonb_build_object('entries', n)); END IF;
  RETURN jsonb_build_object('ok', true, 'loaded', n, 'current', (SELECT count(*) FROM fleet_knowledge_library WHERE current));
END $$;

-- An entry as an agent receives it: hard rules always; a banner when any changeable fact is stale or unverified.
CREATE FUNCTION fleet_knowledge_library_entry_json(k fleet_knowledge_library, p_full boolean) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('id', k.entry_id, 'version', k.version, 'category', k.category, 'title', k.title,
    'banner', CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(k.facts) f
                                 WHERE f ->> 'confidence' = 'unverified'
                                    OR ((f ->> 'lastChecked')::date + COALESCE((f ->> 'staleAfterDays')::integer, 90)) < current_date)
              THEN 'VERIFY BEFORE RELYING: a fact here changes over time and is stale or unverified — check the source before acting on it' END,
    'hardRules', to_jsonb(k.hard_rules),
    'body', CASE WHEN p_full THEN k.body ELSE left(k.body, 1500) END,
    'factsThatChange', (SELECT jsonb_agg(jsonb_build_object('fact', f ->> 'fact', 'confidence', f ->> 'confidence', 'lastChecked', f ->> 'lastChecked',
        'stale', ((f ->> 'lastChecked')::date + COALESCE((f ->> 'staleAfterDays')::integer, 90)) < current_date, 'verifyAt', f -> 'verifyAt')) FROM jsonb_array_elements(k.facts) f),
    'sources', k.sources, 'tags', to_jsonb(k.tags), 'lastReviewed', k.last_reviewed))
$$;

CREATE FUNCTION fleet_knowledge_library_search(p_query text, p_category text, p_limit integer, p_full boolean) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  WITH t AS (SELECT DISTINCT w FROM regexp_split_to_table(lower(COALESCE(p_query, '')), '[^a-z0-9-]+') w WHERE length(w) >= 3),
  scored AS (
    SELECT k.*, (SELECT count(*) FROM t WHERE t.w = ANY (k.tags) OR t.w = ANY (k.keywords)) * 3
              + (SELECT count(*) FROM t WHERE position(t.w IN lower(k.title)) > 0) * 2
              + (SELECT count(*) FROM t WHERE position(t.w IN lower(k.body)) > 0)
              -- Always-fetch compliance entries for regulated topics and reviews.
              + CASE WHEN k.entry_id = 'legal-no-regulated-advice' AND lower(COALESCE(p_query, '')) ~ '(health|medical|legal|law|financ|invest|tax|mental)' THEN 100 ELSE 0 END
              + CASE WHEN k.entry_id = 'legal-reviews-dmcc' AND lower(COALESCE(p_query, '')) ~ '(review|testimonial|rating)' THEN 100 ELSE 0 END AS score
      FROM fleet_knowledge_library k WHERE k.current AND (p_category IS NULL OR k.category = p_category))
  SELECT jsonb_build_object('ok', true, 'query', p_query, 'category', p_category,
    'entries', COALESCE((SELECT jsonb_agg(fleet_knowledge_library_entry_json(row(s.entry_id, s.version, s.category, s.title, s.body, s.tags, s.keywords, s.facts, s.hard_rules,
        s.sources, s.last_reviewed, s.loaded_by, s.loaded_at, s.current)::fleet_knowledge_library, p_full) ORDER BY s.score DESC, s.entry_id)
      FROM (SELECT * FROM scored WHERE (p_query IS NULL OR score > 0) ORDER BY score DESC, entry_id LIMIT LEAST(GREATEST(COALESCE(p_limit, 5), 1), 60)) s), '[]'::jsonb),
    'categories', (SELECT jsonb_object_agg(category, n) FROM (SELECT category, count(*) AS n FROM fleet_knowledge_library WHERE current GROUP BY category) c),
    'note', 'researched guidance (2026-10-08), not a rule set: hard rules are non-negotiable; check facts marked stale or unverified before relying on them')
$$;

CREATE FUNCTION fleet_econ_knowledge_library(p_agent text, a jsonb) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT CASE WHEN a ? 'id' THEN
      COALESCE((SELECT jsonb_build_object('ok', true, 'entry', fleet_knowledge_library_entry_json(k, true)) FROM fleet_knowledge_library k WHERE k.entry_id = a ->> 'id' AND k.current),
               jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'))
    ELSE fleet_knowledge_library_search(left(a ->> 'query', 300), a ->> 'category',
      CASE WHEN jsonb_typeof(a -> 'limit') = 'number' THEN (a ->> 'limit')::integer ELSE 5 END, false) END
$$;

SELECT fleet_admin_knowledge_library_load(${lit(LIBRARY)}::jsonb, 'migration');

-- ═══ 4. Shared lessons carry no personal data ═══
CREATE FUNCTION fleet_scrub_pii(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(t,
    '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}', '[email]', 'g'),
    '\\m[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}\\M', '[bank account]', 'g'),
    '([0-9][ -]?){12,18}[0-9]', '[number]', 'g'),
    '\\m[0-9]{2}-[0-9]{2}-[0-9]{2}\\M', '[sort code]', 'g'),
    '(\\+[0-9]{1,3}[ -]?|\\m0)[0-9]{2,4}[ -]?[0-9]{3,4}[ -]?[0-9]{3,4}', '[phone]', 'g'),
    '\\m[A-Z]{1,2}[0-9][A-Z0-9]? ?[0-9][A-Z]{2}\\M', '[postcode]', 'g')
$$;
CREATE FUNCTION fleet_knowledge_scrub() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'fleet_economic_knowledge' THEN
    NEW.claim := fleet_scrub_pii(NEW.claim);
    NEW.evidence := fleet_scrub_pii(NEW.evidence::text)::jsonb;
  ELSE
    NEW.title := fleet_scrub_pii(NEW.title);
    NEW.content := fleet_scrub_pii(NEW.content);
  END IF;
  RETURN NEW;
END $$;
-- Named to run before the existing guards (triggers fire in name order; the proposal guard hashes the stored content).
CREATE TRIGGER fleet_economic_knowledge_a_scrub BEFORE INSERT ON fleet_economic_knowledge FOR EACH ROW EXECUTE FUNCTION fleet_knowledge_scrub();
CREATE TRIGGER fleet_knowledge_proposals_a_scrub BEFORE INSERT ON fleet_knowledge_proposals FOR EACH ROW EXECUTE FUNCTION fleet_knowledge_scrub();

-- ═══ 5. Agent operations, dashboard, routing ═══
${DISPATCH}

${DASH_CALL}

${EVENT_ROUTE}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

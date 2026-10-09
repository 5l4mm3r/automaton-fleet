/**
 * Schema v55 — the owner's survival protection switch (owner decision 2026-10-09).
 *
 * Exhaustion is death (v51) is the Fleet's rule. The owner holds a fleet-wide fail-safe over it: while protection is ON
 * (the default — it is ON from this migration until the owner turns it off), an agent whose wallet is exhausted is NOT
 * ended by the lifecycle pass; the owner is told (once per agent per protection period) and decides. Turning protection
 * OFF ("live": the survival rule applies) and back ON is the owner's alone (dashboard step-up), recorded with a reason in
 * an append-only history and as a P1 event. Agents are not told of the switch: their survival observation keeps stating
 * the rule. Advanced: the owner can set single agents to "always protected" or "live" regardless of the fleet switch
 * (default: follow the fleet). Nothing else changes: other ends (the owner's retirement of an agent, heartbeat loss) are unaffected.
 */
import { V51_SQL } from "./migrations-phase51.js";
import { V54_SQL } from "./migrations-phase54.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));

export const EVENT_ROUTES_V55 = Object.freeze({
  P1_HIGH: ["survival_protection_set", "survival_protection_agent_set", "agent_exhaustion_protected"],
} as const);
export const DASHBOARD_READ_OPS_V55 = ["survival_protection"] as const;
export const DASHBOARD_SENSITIVE_OPS_V55 = ["survival_protection_set", "survival_protection_agent_set"] as const;

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');`;

const TICK = restate(V51_SQL, "svc_insolvency_tick", [
  ["DECLARE a record; g fleet_agents; m jsonb; nx integer := 0; nh integer := 0;", "DECLARE a record; g fleet_agents; m jsonb; nx integer := 0; nh integer := 0; np integer := 0; pr fleet_survival_protection;"],
  ["BEGIN\n  FOR a IN", "BEGIN\n  SELECT * INTO pr FROM fleet_survival_protection WHERE id = 1;\n  FOR a IN"],
  [`    IF NOT (m ->> 'exhausted')::boolean THEN CONTINUE; END IF;
`, `    IF NOT (m ->> 'exhausted')::boolean THEN CONTINUE; END IF;
    -- v55: the owner's fail-safe — while protection is on, exhaustion is reported to the owner, never enacted.
    IF fleet_agent_protected(a.agent_id) THEN
      np := np + 1;
      IF NOT EXISTS (SELECT 1 FROM fleet_events e WHERE e.event_type = 'agent_exhaustion_protected' AND e.agent_id = a.agent_id AND e.created_at >= fleet_agent_protection_since(a.agent_id)) THEN
        PERFORM fleet_event('agent_exhaustion_protected', a.agent_id, 'controller', jsonb_build_object('measure', m - 'rule',
          'note', 'this agent''s wallet is exhausted; survival protection is on, so it was not ended — fund it, hold it, or turn protection off'));
      END IF;
      CONTINUE;
    END IF;
`],
  ["RETURN jsonb_build_object('ok', true, 'died', nx, 'heldByOwner', nh);", "RETURN jsonb_build_object('ok', true, 'died', nx, 'heldByOwner', nh, 'protected', np, 'protection', pr.enabled);"],
]);

const INSOLVENCY_JSON = restate(V51_SQL, "fleet_insolvency_json", [
  ["  SELECT jsonb_build_object('rule', 'exhaustion is death (no dormancy, no grace, no rescue)',",
   "  SELECT jsonb_build_object('rule', 'exhaustion is death (no dormancy, no grace, no rescue)', 'protection', fleet_survival_protection_json(),"],
]);

const MEASURES = restate(V51_SQL, "fleet_wallet_measures", [
  ["jsonb_build_object('agentId', a.agent_id, 'name', a.name, 'status', a.status)", "jsonb_build_object('agentId', a.agent_id, 'name', a.name, 'status', a.status, 'protected', fleet_agent_protected(a.agent_id))"],
]);

const DASH_CALL = restate(V54_SQL, "dash_call", [
  [`'card_request_decide','card_request_policy_set');`, `'card_request_decide','card_request_policy_set',${q(DASHBOARD_SENSITIVE_OPS_V55)});`],
  [`'paypal_test','card_requests')) THEN`, `'paypal_test','card_requests',${q(DASHBOARD_READ_OPS_V55)})) THEN`],
  [`      WHEN 'card_requests' THEN fleet_card_requests_json(a ->> 'agentId')`,
   `      WHEN 'card_requests' THEN fleet_card_requests_json(a ->> 'agentId')
      WHEN 'survival_protection' THEN fleet_survival_protection_json()`],
  [`      WHEN 'card_request_decide' THEN`,
   `      WHEN 'survival_protection_set' THEN fleet_admin_survival_protection_set((a ->> 'enabled')::boolean, a ->> 'reason', 'operator:owner')
      WHEN 'survival_protection_agent_set' THEN fleet_admin_survival_protection_agent_set(a ->> 'agentId', a ->> 'mode', a ->> 'reason', 'operator:owner')
      WHEN 'card_request_decide' THEN`],
]);

const EVENT_ROUTE = restate(V54_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V55) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
]);

export const V55_SQL = `
CREATE TABLE fleet_survival_protection (
  id      integer     PRIMARY KEY CHECK (id = 1),
  enabled boolean     NOT NULL DEFAULT true,
  reason  text        NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  set_by  text        NOT NULL,
  set_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fleet_survival_protection (id, enabled, reason, set_by) VALUES (1, true, 'on from schema v55 until the owner turns it off', 'migration');
CREATE TRIGGER fleet_survival_protection_no_delete BEFORE DELETE ON fleet_survival_protection FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_survival_protection_no_truncate BEFORE TRUNCATE ON fleet_survival_protection FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_survival_protection_agents (
  agent_id text        PRIMARY KEY REFERENCES fleet_agents(agent_id),
  mode     text        NOT NULL CHECK (mode IN ('protected','live')),
  reason   text        NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  set_by   text        NOT NULL,
  set_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fleet_survival_protection_history (
  seq     bigserial   PRIMARY KEY,
  agent_id text       REFERENCES fleet_agents(agent_id),   -- NULL: the fleet-wide switch
  state   text        NOT NULL CHECK (state IN ('on','off','follow') AND (agent_id IS NOT NULL OR state <> 'follow')),
  reason  text        NOT NULL,
  set_by  text        NOT NULL,
  set_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_survival_protection_history_no_change BEFORE UPDATE OR DELETE ON fleet_survival_protection_history FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_survival_protection_history_no_truncate BEFORE TRUNCATE ON fleet_survival_protection_history FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
INSERT INTO fleet_survival_protection_history (state, reason, set_by) VALUES ('on', 'on from schema v55 until the owner turns it off', 'migration');

-- An agent's effective protection: its own override, else the fleet switch; and since when it has been so.
CREATE FUNCTION fleet_agent_protected(p_agent text) RETURNS boolean LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE((SELECT o.mode = 'protected' FROM fleet_survival_protection_agents o WHERE o.agent_id = p_agent),
                  (SELECT p.enabled FROM fleet_survival_protection p WHERE p.id = 1), true)
$$;
CREATE FUNCTION fleet_agent_protection_since(p_agent text) RETURNS timestamptz LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE((SELECT o.set_at FROM fleet_survival_protection_agents o WHERE o.agent_id = p_agent),
                  (SELECT p.set_at FROM fleet_survival_protection p WHERE p.id = 1))
$$;

CREATE FUNCTION fleet_survival_protection_json() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('enabled', p.enabled, 'reason', p.reason, 'setBy', p.set_by, 'setAt', p.set_at,
    'exhaustedAgents', COALESCE((SELECT jsonb_agg(jsonb_build_object('agentId', m ->> 'agentId', 'name', m ->> 'name', 'protected', (m ->> 'protected')::boolean))
       FROM jsonb_array_elements(fleet_wallet_measures()) m WHERE (m ->> 'exhausted')::boolean), '[]'::jsonb),
    'agents', COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('agentId', g.agent_id, 'name', g.name, 'override', o.mode, 'overrideReason', o.reason,
         'protected', fleet_agent_protected(g.agent_id))) ORDER BY g.created_at)
       FROM fleet_agents g LEFT JOIN fleet_survival_protection_agents o ON o.agent_id = g.agent_id WHERE g.status IN ('active','unresponsive')), '[]'::jsonb),
    'history', COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('agentId', h.agent_id, 'state', h.state, 'enabled', CASE h.state WHEN 'on' THEN true WHEN 'off' THEN false END,
         'reason', h.reason, 'setBy', h.set_by, 'at', h.set_at)) ORDER BY h.seq DESC)
       FROM (SELECT * FROM fleet_survival_protection_history ORDER BY seq DESC LIMIT 20) h), '[]'::jsonb))
  FROM fleet_survival_protection p WHERE p.id = 1
$$;

-- Owner: protection on (exhaustion is reported, never enacted) or off (live: the survival rule applies).
CREATE FUNCTION fleet_admin_survival_protection_set(p_enabled boolean, p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_survival_protection; v_reason text := left(trim(fleet_scrub(COALESCE(p_reason, ''))), 300);
BEGIN
  ${OWNER_ACTOR}
  IF p_enabled IS NULL THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: on or off'; END IF;
  IF length(v_reason) < 3 THEN v_reason := CASE WHEN p_enabled THEN 'protection turned on by the owner' ELSE 'survival rule made live by the owner' END; END IF;
  SELECT * INTO p FROM fleet_survival_protection WHERE id = 1 FOR UPDATE;
  IF p.enabled = p_enabled THEN RETURN jsonb_build_object('ok', true, 'unchanged', true) || fleet_survival_protection_json(); END IF;
  UPDATE fleet_survival_protection SET enabled = p_enabled, reason = v_reason, set_by = p_actor, set_at = now() WHERE id = 1;
  INSERT INTO fleet_survival_protection_history (state, reason, set_by) VALUES (CASE WHEN p_enabled THEN 'on' ELSE 'off' END, v_reason, p_actor);
  PERFORM fleet_event('survival_protection_set', NULL, p_actor, jsonb_build_object('enabled', p_enabled, 'reason', v_reason,
    'note', CASE WHEN p_enabled THEN 'protection on: no agent is ended for an exhausted wallet' ELSE 'live: an agent whose wallet is exhausted is ended at the next pass' END));
  RETURN jsonb_build_object('ok', true) || fleet_survival_protection_json();
END $$;

-- Owner (advanced): one agent always protected, live, or following the fleet switch again.
CREATE FUNCTION fleet_admin_survival_protection_agent_set(p_agent text, p_mode text, p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_reason text := left(trim(fleet_scrub(COALESCE(p_reason, ''))), 300);
BEGIN
  ${OWNER_ACTOR}
  IF p_mode IS NULL OR p_mode NOT IN ('protected','live','follow') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: mode protected|live|follow'; END IF;
  IF NOT EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = p_agent AND status IN ('active','unresponsive')) THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such living agent'; END IF;
  IF length(v_reason) < 3 THEN v_reason := CASE p_mode WHEN 'protected' THEN 'always protected by the owner' WHEN 'live' THEN 'made live by the owner' ELSE 'follows the fleet switch' END; END IF;
  IF p_mode = 'follow' THEN
    DELETE FROM fleet_survival_protection_agents WHERE agent_id = p_agent;
  ELSE
    INSERT INTO fleet_survival_protection_agents (agent_id, mode, reason, set_by) VALUES (p_agent, p_mode, v_reason, p_actor)
      ON CONFLICT (agent_id) DO UPDATE SET mode = EXCLUDED.mode, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = now();
  END IF;
  INSERT INTO fleet_survival_protection_history (agent_id, state, reason, set_by)
    VALUES (p_agent, CASE p_mode WHEN 'protected' THEN 'on' WHEN 'live' THEN 'off' ELSE 'follow' END, v_reason, p_actor);
  PERFORM fleet_event('survival_protection_agent_set', p_agent, p_actor, jsonb_build_object('mode', p_mode, 'reason', v_reason, 'protected', fleet_agent_protected(p_agent)));
  RETURN jsonb_build_object('ok', true) || fleet_survival_protection_json();
END $$;

${TICK}

${MEASURES}

${INSOLVENCY_JSON}

${DASH_CALL}

${EVENT_ROUTE}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

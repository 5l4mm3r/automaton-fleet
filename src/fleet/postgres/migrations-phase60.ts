/**
 * Schema v60 — the owner names the Agents.
 *
 * Every member of the Fleet is an Agent. The registry keeps the name each was given at creation (`founder-1`, `agent-2`, …):
 * it is part of the identity, referenced by events, ledgers, runtime units and the founders' own state, and it is never
 * renamed. What the owner sees is a separate, owner-chosen label:
 *
 * - `fleet_agent_labels` holds at most one label per Agent (1–40 printable characters). No label means the default:
 *   a legacy `founder-N` / `agent-N` name is shown as `Agent-N`, any other name as stored (`fleet_agent_label`).
 * - `agent_rename` is an ordinary dashboard write (session + CSRF, no step-up, like `passkey_rename`): a new label, or an
 *   empty one to return to the default. Two Agents never show the same name (case-insensitive). Each rename is a permanent
 *   `agent_renamed` event in the Agent's history (P3).
 * - The dashboard's `agents` read carries `label`, so every page and the treasury show the same name.
 */
import { V59_SQL } from "./migrations-phase59.js";
import { DASHBOARD_WRITE_OPS_V45 } from "./migrations-phase45.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));
const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

export const EVENT_ROUTES_V60 = Object.freeze({
  P3_INFO: ["agent_renamed"],
});
export const DASHBOARD_WRITE_OPS_V60 = [...DASHBOARD_WRITE_OPS_V45, "agent_rename"] as const;

const DASH_CALL = restate(V59_SQL, "dash_call", [
  [`OR p_op IN (${q(DASHBOARD_WRITE_OPS_V45)})`, `OR p_op IN (${q(DASHBOARD_WRITE_OPS_V60)})`],
  [`      WHEN 'agents' THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('agentId', x.agent_id, 'name', x.name, 'status', x.status, 'createdAt', x.created_at,`,
   `      WHEN 'agents' THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('agentId', x.agent_id, 'name', x.name, 'label', fleet_agent_label(x.agent_id), 'status', x.status, 'createdAt', x.created_at,`],
  [`      WHEN 'passkey_rename' THEN dash_passkey_rename(a ->> 'credentialId', a ->> 'name', p_ip)`,
   `      WHEN 'passkey_rename' THEN dash_passkey_rename(a ->> 'credentialId', a ->> 'name', p_ip)
      WHEN 'agent_rename' THEN fleet_admin_agent_rename(a ->> 'agentId', a ->> 'name', 'operator:owner')`],
]);

const EVENT_ROUTE = restate(V59_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V60) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
]);

export const V60_SQL = `
CREATE TABLE fleet_agent_labels (
  agent_id   text        PRIMARY KEY REFERENCES fleet_agents(agent_id),
  label      text        NOT NULL CHECK (length(label) BETWEEN 1 AND 40 AND label = btrim(label) AND label !~ '[[:cntrl:]]'),
  set_by     text        NOT NULL,
  set_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX fleet_agent_labels_unique ON fleet_agent_labels (lower(label));

-- The name shown for a registry name when the owner has chosen none (the dashboard's naming.ts applies the same rule).
CREATE FUNCTION fleet_agent_default_label(p_name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN btrim(COALESCE(p_name, '')) ~* '^(founder|agent)[-_ ]?[0-9]+$'
              THEN 'Agent-' || (substring(btrim(p_name) FROM '([0-9]+)$'))::bigint
              ELSE btrim(p_name) END
$$;

-- The name the owner sees: their label, or the default.
CREATE FUNCTION fleet_agent_label(p_agent text) RETURNS text LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(l.label, fleet_agent_default_label(a.name)) FROM fleet_agents a LEFT JOIN fleet_agent_labels l ON l.agent_id = a.agent_id
  WHERE a.agent_id = p_agent
$$;

-- The owner renames an Agent (empty = back to the default). The registry name and the identity are untouched.
CREATE FUNCTION fleet_admin_agent_rename(p_agent text, p_name text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE ag fleet_agents; v_label text := btrim(regexp_replace(COALESCE(p_name, ''), '[[:cntrl:]]', '', 'g')); v_from text; v_to text;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  SELECT * INTO ag FROM fleet_agents WHERE agent_id = p_agent;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such agent'; END IF;
  IF length(v_label) > 40 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: an agent name is at most 40 characters'; END IF;
  v_from := fleet_agent_label(p_agent);
  v_to := CASE WHEN v_label = '' THEN fleet_agent_default_label(ag.name) ELSE v_label END;
  IF EXISTS (SELECT 1 FROM fleet_agents o WHERE o.agent_id <> p_agent AND lower(fleet_agent_label(o.agent_id)) = lower(v_to)) THEN
    RAISE EXCEPTION 'FLEET_CONFLICT: another agent is already called %', v_to;
  END IF;
  IF v_to = v_from THEN RETURN jsonb_build_object('ok', true, 'agentId', p_agent, 'label', v_to, 'changed', false); END IF;
  IF v_label = '' OR v_label = fleet_agent_default_label(ag.name) THEN
    DELETE FROM fleet_agent_labels WHERE agent_id = p_agent;
  ELSE
    INSERT INTO fleet_agent_labels (agent_id, label, set_by) VALUES (p_agent, v_label, p_actor)
    ON CONFLICT (agent_id) DO UPDATE SET label = EXCLUDED.label, set_by = EXCLUDED.set_by, set_at = now();
  END IF;
  PERFORM fleet_event('agent_renamed', p_agent, p_actor, jsonb_build_object('from', v_from, 'to', v_to));
  RETURN jsonb_build_object('ok', true, 'agentId', p_agent, 'label', v_to, 'changed', true);
END $$;

${DASH_CALL}

${EVENT_ROUTE}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

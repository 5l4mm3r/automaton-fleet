/**
 * Schema v120 — owner tasks (owner, 2026-10-26: "give Agent-1 an explicit, durable instruction … without triggering a
 * treasury-paid conversation").
 *
 * An owner message (v62) is answered in a conversation turn paid by the treasury; a Fleet Control notice (v94) is Fleet
 * Control's own voice. An OWNER TASK is neither: a short instruction from the owner, attributed to the owner, that the agent
 * carries out in its ORDINARY working turns — paid from its own wallet, inside its own daily usage, turn rate and provider
 * credit limits, exactly like any other work.
 *  - `fleet_admin_owner_task_send` / `fleet_admin_owner_task_close` (owner only). A task is data: it changes no cognition
 *    setting (a paused agent stays paused; nothing runs because of it), grants no permission (spending, identity, accounts,
 *    outward action keep their own flows) and is never claimed as a conversation turn (no treasury payer).
 *  - `fleet_agent_attention.ownerTasks`: the open tasks, oldest first, in every working turn until the owner closes them
 *    (durable: not "shown once", and visible again after a restart); `ownerTasksDigest` lets a runtime that shows tasks wake
 *    on a new or closed one. Runtimes that do not know the key ignore it (nothing is mislabelled as a Fleet Control notice).
 *  - Fleet Command records each task sent and closed (P3).
 */
import { V103_SQL } from "./migrations-phase103.js";
import { V118_SQL } from "./migrations-phase118.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));
const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

export const OWNER_TASK_TITLE_MAX = 120;
export const OWNER_TASK_BODY_MAX = 1_500;
/** Open tasks per agent: a few explicit instructions, not a second work queue. */
export const OWNER_TASKS_OPEN_MAX = 3;

export const EVENT_ROUTES_V120 = Object.freeze({
  P3_SUMMARY: ["owner_task_sent", "owner_task_closed"],
});

const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_cognition');`;

const ATTENTION = restate(V103_SQL, "fleet_agent_attention", [
  [`    'customerObligations', fleet_customer_obligations(p_agent),`,
   `    'customerObligations', fleet_customer_obligations(p_agent),
    -- v120: the owner's open tasks, oldest first — in every working turn until the owner closes them.
    'ownerTasks', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', t.task_id, 'at', t.created_at, 'title', t.title, 'body', t.body) ORDER BY t.created_at), '[]'::jsonb)
      FROM fleet_owner_tasks t WHERE t.agent_id = p_agent AND t.closed_at IS NULL),
    'ownerTasksDigest', (SELECT md5(COALESCE(string_agg(task_id::text, ',' ORDER BY task_id), '')) FROM fleet_owner_tasks
                          WHERE agent_id = p_agent AND closed_at IS NULL),`],
]);

export const V120_SQL = `
CREATE TABLE fleet_owner_tasks (
  task_id      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     text        NOT NULL REFERENCES fleet_agents(agent_id),
  title        text        NOT NULL CHECK (char_length(title) BETWEEN 3 AND ${OWNER_TASK_TITLE_MAX}),
  body         text        NOT NULL CHECK (char_length(body) BETWEEN 10 AND ${OWNER_TASK_BODY_MAX}),
  created_by   text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz,
  closed_by    text,
  close_reason text,
  CHECK ((closed_at IS NULL) = (closed_by IS NULL) AND (closed_at IS NULL) = (close_reason IS NULL))
);
CREATE INDEX fleet_owner_tasks_open ON fleet_owner_tasks (agent_id, created_at) WHERE closed_at IS NULL;

-- A task's words never change; only its one closure is recorded.
CREATE FUNCTION fleet_owner_tasks_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: owner tasks are kept'; END IF;
  IF OLD.closed_at IS NOT NULL OR NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.agent_id IS DISTINCT FROM OLD.agent_id OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.body IS DISTINCT FROM OLD.body OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: an owner task changes only by its one closure';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_owner_tasks_guard BEFORE UPDATE OR DELETE ON fleet_owner_tasks FOR EACH ROW EXECUTE FUNCTION fleet_owner_tasks_guard();

CREATE FUNCTION fleet_admin_owner_task_send(p_agent text, p_title text, p_body text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE ag fleet_agents; t fleet_owner_tasks; v_title text := btrim(COALESCE(p_title, '')); v_body text := btrim(COALESCE(p_body, '')); v_hint text;
BEGIN
  ${OWNER_ACTOR}
  SELECT * INTO ag FROM fleet_agents WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such agent'; END IF;
  IF ag.status = 'dead' THEN RAISE EXCEPTION 'FLEET_AGENT_DEAD: this agent has died'; END IF;
  IF char_length(v_title) NOT BETWEEN 3 AND ${OWNER_TASK_TITLE_MAX} THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a title of 3..${OWNER_TASK_TITLE_MAX} characters'; END IF;
  IF char_length(v_body) NOT BETWEEN 10 AND ${OWNER_TASK_BODY_MAX} THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a task of 10..${OWNER_TASK_BODY_MAX} characters'; END IF;
  IF (v_title || v_body) ~ '[\\x01-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the task contains hidden control characters'; END IF;
  v_hint := fleet_secret_hint(v_title || E'\\n' || v_body);
  IF v_hint IS NOT NULL THEN RAISE EXCEPTION 'FLEET_SECRET_DETECTED: the task looks like it contains %. A task is not a vault', v_hint; END IF;
  IF (SELECT count(*) FROM fleet_owner_tasks WHERE agent_id = p_agent AND closed_at IS NULL) >= ${OWNER_TASKS_OPEN_MAX} THEN
    RAISE EXCEPTION 'FLEET_OWNER_TASKS_FULL: this agent already has ${OWNER_TASKS_OPEN_MAX} open tasks; close one first';
  END IF;
  INSERT INTO fleet_owner_tasks (agent_id, title, body, created_by) VALUES (p_agent, v_title, v_body, p_actor) RETURNING * INTO t;
  PERFORM fleet_event('owner_task_sent', p_agent, p_actor, jsonb_build_object('taskId', t.task_id, 'title', t.title));
  RETURN jsonb_build_object('ok', true, 'taskId', t.task_id, 'agentId', t.agent_id, 'title', t.title, 'createdAt', t.created_at,
    'note', 'shown to the agent in its ordinary working turns until you close it; it changes no setting (a paused agent stays paused) and approves nothing');
END $$;

CREATE FUNCTION fleet_admin_owner_task_close(p_task uuid, p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE t fleet_owner_tasks;
BEGIN
  ${OWNER_ACTOR}
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 3 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a reason is required'; END IF;
  SELECT * INTO t FROM fleet_owner_tasks WHERE task_id = p_task FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such task'; END IF;
  IF t.closed_at IS NOT NULL THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'taskId', t.task_id, 'closedAt', t.closed_at); END IF;
  UPDATE fleet_owner_tasks SET closed_at = now(), closed_by = p_actor, close_reason = left(fleet_scrub(btrim(p_reason)), 300) WHERE task_id = p_task RETURNING * INTO t;
  PERFORM fleet_event('owner_task_closed', t.agent_id, p_actor, jsonb_build_object('taskId', t.task_id, 'reason', t.close_reason));
  RETURN jsonb_build_object('ok', true, 'taskId', t.task_id, 'closedAt', t.closed_at);
END $$;

CREATE FUNCTION fleet_admin_owner_tasks(p_agent text) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('taskId', task_id, 'agentId', agent_id, 'title', title, 'body', body, 'createdBy', created_by, 'createdAt', created_at,
    'closedAt', closed_at, 'closedBy', closed_by, 'closeReason', close_reason) ORDER BY created_at DESC), '[]'::jsonb)
    FROM fleet_owner_tasks WHERE p_agent IS NULL OR agent_id = p_agent
$$;

${ATTENTION}

${restate(V118_SQL, "fleet_event_route", [["    WHEN p_type = 'spend_circuit_breaker_set' THEN",
  (Object.entries(EVENT_ROUTES_V120) as Array<[string, readonly string[]]>)
    .map(([lvl, types]) => `    WHEN p_type IN (${q(types)}) THEN '${lvl}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"]])}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

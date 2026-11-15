/**
 * Schema v75 — the Virtual Command Centre's live presence (owner, 2026-10-14). Read-only: the dashboard's `agents` read
 * gains what the Virtual view needs to show an agent's rest and times truthfully. Nothing is written, nothing moves, no
 * permission changes; levels and wandering stay display-only in the dashboard.
 *
 * Each `agents` row adds (absent = not known, never inferred):
 *   - `paused` / `pausedSince`: the OWNER's cognition pause (`fleet_founder_cognition.paused` set by an operator — a
 *     lifecycle stop is not an owner pause); since = the first `founder_cognition_paused` event after the last
 *     enable / disable of that agent's cognition.
 *   - `hibernation`: what the agent itself last REPORTED (`fleet_agent_mind_reports`, sent by the runtime at the end of
 *     each turn): `state` hibernating (its turn ended in a sleep with a wake condition or review time) or awake,
 *     `reportedAt` (the freshness: the dashboard shows a stale or missing report as unknown) and `since` (the first
 *     report of the current hibernation). The agent's own wording is never exposed here. Inactivity and the owner's
 *     pause never make a hibernation.
 *   - `deathTime`: `fleet_agents.death_time` (the Hall of Survivors).
 *   - `modeSince`: when the active temporary mission started (`fleet_agent_missions.started_at`).
 *   - `heldSince`: when the operator hold began (`fleet_agents.operator_hold_at`).
 */
import { V69_SQL } from "./migrations-phase69.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const MODE_LINE = `          'mode', COALESCE((SELECT upper(kind) FROM fleet_agent_missions m WHERE m.agent_id = x.agent_id AND m.status = 'active'), 'NORMAL')) ORDER BY x.created_at)`;

export const V75_SQL = `
CREATE FUNCTION fleet_agent_presence(p_agent text) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  WITH owner_pause AS (
    SELECT c.paused AND c.updated_by LIKE 'operator:%' AS paused FROM fleet_founder_cognition c WHERE c.agent_id = p_agent
  ), pause_start AS (
    SELECT min(e.created_at) AS at FROM fleet_events e
     WHERE e.agent_id = p_agent AND e.event_type = 'founder_cognition_paused'
       AND e.id > COALESCE((SELECT max(o.id) FROM fleet_events o WHERE o.agent_id = p_agent
                              AND o.event_type IN ('founder_cognition_enabled', 'founder_cognition_disabled')), 0)
  ), reports AS (
    SELECT r.report_id, r.at, (r.wake_on IS NOT NULL OR r.review_at IS NOT NULL) AS hib FROM fleet_agent_mind_reports r WHERE r.agent_id = p_agent
  ), latest AS (
    SELECT * FROM reports ORDER BY at DESC, report_id DESC LIMIT 1
  )
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'paused', (SELECT paused FROM owner_pause),
    'pausedSince', CASE WHEN (SELECT paused FROM owner_pause) THEN (SELECT at FROM pause_start) END,
    'hibernation', (SELECT jsonb_strip_nulls(jsonb_build_object('state', CASE WHEN l.hib THEN 'hibernating' ELSE 'awake' END, 'reportedAt', l.at,
        'since', CASE WHEN l.hib THEN (SELECT min(r.at) FROM reports r WHERE r.at > COALESCE((SELECT max(w.at) FROM reports w WHERE NOT w.hib), '-infinity')) END))
      FROM latest l),
    'deathTime', (SELECT a.death_time FROM fleet_agents a WHERE a.agent_id = p_agent),
    'heldSince', (SELECT a.operator_hold_at FROM fleet_agents a WHERE a.agent_id = p_agent),
    'modeSince', (SELECT max(m.started_at) FROM fleet_agent_missions m WHERE m.agent_id = p_agent AND m.status = 'active')))
$$;

${restateRaw(V69_SQL, "dash_call", [
  [MODE_LINE, MODE_LINE.replace(`'NORMAL')) ORDER BY`, `'NORMAL')) || fleet_agent_presence(x.agent_id) ORDER BY`)],
])}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

/**
 * Schema v45 — disposable notifications and a clearable Fleet Command (owner brief 2026-10-07, "final Fleet Command +
 * notification cleanup").
 *
 * NOTIFICATIONS ARE DISPOSABLE. Deleting one deletes the row — title, body, everything. No tombstone, no
 * notifications_deleted event, no audit copy, no access-log line. The only state kept is a SHORT-LIVED suppression key
 * (fleet_notification_suppress: dedupe key + expiry, 7 days, purged as it expires) so a periodic producer (the daily
 * report, an open alert) does not re-raise the very notification the owner just deleted. Storage is bounded by the
 * deletions of the last 7 days, never by all deletions ever.
 *
 * FLEET COMMAND IS THE OPERATIONAL BRAIN, NOT THE RECORD. fleet_events stays the Fleet's append-only history (several
 * subsystems read it: project distributions read treasury_sweep events, the economy hub's financial audit, the
 * settlement-conflict health check, the Operator API). Fleet Command now has its own bounded, non-canonical feed,
 * fleet_command_feed: every new event the router classes P0–P3 is copied into it (a trigger), at most 500 rows per
 * priority are kept, and the owner may CLEAR a priority — those rows are deleted, nothing else is touched, and no
 * replacement event is written. Canonical records (ledger, ventures, projects, missions, knowledge, Agents, events) are
 * never deleted by clearing.
 *
 * ROUTING: a `notification` event reaches Fleet Command only for a genuine incident or summary — sign-in lockout and
 * suspected passkey cloning (P0), Treasury below obligations (P0), a high-exposure spend or an action only the owner can
 * take (P1), the daily report (P3). Routine notices (passkey added / revoked, password set, authenticator reset, test
 * fixtures) never do; the breaker has its own event. Normal sign-ins, sessions, CSRF mechanics and housekeeping were
 * already audit-only.
 */
import { DASHBOARD_WRITE_OPS_V43 } from "./migrations-phase43.js";
import { V44_SQL, caseExact, casePrefix, DASHBOARD_READ_OPS_V44 } from "./migrations-phase44.js";
import { restate } from "./migrations-phase42.js";

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const ACTOR = "'operator:owner'";

/** Notification codes that are operational incidents or summaries (everything else stays out of Fleet Command). */
export const NOTIFICATION_ROUTES: Readonly<Record<string, "P0_CRITICAL" | "P1_HIGH" | "P3_SUMMARY">> = Object.freeze({
  ADMIN_AUTH_LOCKOUT: "P0_CRITICAL", ADMIN_PASSKEY_CLONE_SUSPECTED: "P0_CRITICAL", TREASURY_INSOLVENT: "P0_CRITICAL",
  HIGH_EXPOSURE_SPEND: "P1_HIGH", HUMAN_ACTION_REQUIRED: "P1_HIGH",
  DAILY_REPORT: "P3_SUMMARY",
});
/** Owner housekeeping operations that leave no access-log line (they change no Fleet state). */
export const HOUSEKEEPING_OPS = ["notification_delete", "notification_delete_acknowledged", "command_clear"] as const;
export const DASHBOARD_WRITE_OPS_V45 = [...DASHBOARD_WRITE_OPS_V43, "command_clear"] as const;
export const COMMAND_FEED_CAP = 500;
export const SUPPRESS_DAYS = 7;

const notificationCases = Object.entries(NOTIFICATION_ROUTES).map(([code, p]) => `      WHEN p_detail ->> 'code' = '${code}' THEN '${p}'`).join("\n");

const DASH_CALL = restate(V44_SQL, "dash_call", [
  [`OR p_op IN (${q(DASHBOARD_WRITE_OPS_V43)})`, `OR p_op IN (${q(DASHBOARD_WRITE_OPS_V45)})`],
  [`      WHEN 'passkey_rename' THEN dash_passkey_rename(a ->> 'credentialId', a ->> 'name', p_ip)`,
   `      WHEN 'passkey_rename' THEN dash_passkey_rename(a ->> 'credentialId', a ->> 'name', p_ip)
      WHEN 'command_clear' THEN fleet_admin_command_clear(a ->> 'priority', ${ACTOR})`],
  [`  IF v_write THEN PERFORM fleet_admin_auth_log_write('op', true, p_op, NULL, p_ip, jsonb_build_object('sensitive', v_sensitive)); END IF;`,
   `  -- Housekeeping (deleting notifications, clearing Fleet Command) changes no Fleet state and leaves no trace.
  IF v_write AND p_op NOT IN (${q(HOUSEKEEPING_OPS)}) THEN PERFORM fleet_admin_auth_log_write('op', true, p_op, NULL, p_ip, jsonb_build_object('sensitive', v_sensitive)); END IF;`],
]);

export const V45_SQL = `
-- ═══ 1. Routing: only incident / summary notifications reach Fleet Command ═══
DROP INDEX IF EXISTS fleet_events_command;  -- the feed table replaces it (and the router's notification rule changes)
CREATE OR REPLACE FUNCTION fleet_event_route(p_type text, p_detail jsonb) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT CASE
    WHEN p_type = 'notification' THEN CASE
${notificationCases}
      ELSE 'AUDIT_ONLY' END
    WHEN p_type = 'spend_circuit_breaker_set' THEN CASE WHEN COALESCE((p_detail ->> 'tripped')::boolean, true) THEN 'P0_CRITICAL' ELSE 'P2_IMPORTANT' END
${caseExact}
${casePrefix}
    ELSE 'AUDIT_ONLY' END
$$;

-- ═══ 2. Fleet Command's own bounded, clearable feed (never the canonical record) ═══
CREATE TABLE fleet_command_feed (
  feed_id    bigserial   PRIMARY KEY,
  event_id   bigint      NOT NULL UNIQUE,     -- the fleet_events row it signals (the history itself is untouched)
  priority   text        NOT NULL CHECK (priority IN ('P0_CRITICAL','P1_HIGH','P2_IMPORTANT','P3_SUMMARY')),
  at         timestamptz NOT NULL,
  type       text        NOT NULL,
  agent_id   text,
  actor      text,
  detail     jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX fleet_command_feed_priority ON fleet_command_feed (priority, at DESC);
CREATE INDEX fleet_command_feed_at ON fleet_command_feed (at DESC);

CREATE FUNCTION fleet_command_feed_capture() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p text := fleet_event_route(NEW.event_type, NEW.detail);
BEGIN
  IF p IN ('P0_CRITICAL','P1_HIGH','P2_IMPORTANT','P3_SUMMARY') THEN
    INSERT INTO fleet_command_feed (event_id, priority, at, type, agent_id, actor, detail)
      VALUES (NEW.id, p, NEW.created_at, NEW.event_type, NEW.agent_id, NEW.actor, NEW.detail) ON CONFLICT (event_id) DO NOTHING;
    -- Bounded: the oldest rows of that priority beyond the cap leave the display (the history keeps the event).
    DELETE FROM fleet_command_feed WHERE priority = p AND feed_id IN (
      SELECT feed_id FROM fleet_command_feed WHERE priority = p ORDER BY at DESC, feed_id DESC OFFSET ${COMMAND_FEED_CAP});
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER fleet_command_feed_capture AFTER INSERT ON fleet_events FOR EACH ROW EXECUTE FUNCTION fleet_command_feed_capture();

-- Existing operational events seed the feed (newest ${COMMAND_FEED_CAP} per priority).
INSERT INTO fleet_command_feed (event_id, priority, at, type, agent_id, actor, detail)
  SELECT id, p, created_at, event_type, agent_id, actor, detail FROM (
    SELECT e.*, fleet_event_route(e.event_type, e.detail) AS p,
           row_number() OVER (PARTITION BY fleet_event_route(e.event_type, e.detail) ORDER BY e.created_at DESC, e.id DESC) AS n
      FROM fleet_events e) x
   WHERE p IN ('P0_CRITICAL','P1_HIGH','P2_IMPORTANT','P3_SUMMARY') AND n <= ${COMMAND_FEED_CAP};

CREATE OR REPLACE FUNCTION fleet_command_events(p_limit integer) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('at', f.at, 'type', f.type, 'agentId', f.agent_id, 'actor', f.actor, 'detail', f.detail,
      'priority', f.priority, 'feedId', f.feed_id) ORDER BY f.at DESC), '[]'::jsonb)
    FROM (SELECT * FROM fleet_command_feed ORDER BY at DESC, feed_id DESC LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 2000))) f
$$;

-- Clear one priority from the display: those feed rows are deleted; nothing else changes; no event is written.
CREATE FUNCTION fleet_admin_command_clear(p_priority text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE n integer;
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_command_feed');
  IF p_priority IS NULL OR p_priority NOT IN ('P0_CRITICAL','P1_HIGH','P2_IMPORTANT','P3_SUMMARY') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: priority is P0_CRITICAL, P1_HIGH, P2_IMPORTANT or P3_SUMMARY'; END IF;
  DELETE FROM fleet_command_feed WHERE priority = p_priority;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'priority', p_priority, 'cleared', n);
END $$;

-- ═══ 3. Disposable notifications: delete means delete ═══
DROP TRIGGER fleet_notifications_no_delete ON fleet_notifications;
DELETE FROM fleet_notifications WHERE deleted_at IS NOT NULL;           -- the v43 tombstones go
DROP INDEX IF EXISTS fleet_notifications_inbox;
ALTER TABLE fleet_notifications DROP CONSTRAINT fleet_notifications_delete_acknowledged;
ALTER TABLE fleet_notifications DROP COLUMN deleted_at, DROP COLUMN deleted_by;

-- A short-lived suppression key per deleted notification (not the notification: only its dedupe key and an expiry).
CREATE TABLE fleet_notification_suppress (
  dedupe_key  text        PRIMARY KEY CHECK (length(dedupe_key) BETWEEN 3 AND 200),
  until       timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION fleet_notify(p_class text, p_code text, p_agent text, p_title text, p_detail jsonb, p_dedupe text) RETURNS boolean LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE n integer;
BEGIN
  DELETE FROM fleet_notification_suppress WHERE until < now();
  IF EXISTS (SELECT 1 FROM fleet_notification_suppress WHERE dedupe_key = p_dedupe) THEN RETURN false; END IF;
  INSERT INTO fleet_notifications (class, code, agent_id, title, detail, dedupe_key)
    VALUES (p_class, p_code, p_agent, left(fleet_scrub(p_title), 200), COALESCE(p_detail, '{}'::jsonb), p_dedupe)
    ON CONFLICT (dedupe_key) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN PERFORM fleet_event('notification', p_agent, 'controller', jsonb_build_object('class', p_class, 'code', p_code)); END IF;
  RETURN n > 0;
END $$;

CREATE OR REPLACE FUNCTION fleet_admin_notifications(p_limit integer, p_unacknowledged boolean) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('notifications', COALESCE((SELECT jsonb_agg(to_jsonb(n) ORDER BY n.created_at DESC) FROM (
      SELECT * FROM fleet_notifications WHERE NOT COALESCE(p_unacknowledged, false) OR acknowledged_at IS NULL
       ORDER BY created_at DESC LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 500))) n), '[]'::jsonb),
    'unacknowledged', (SELECT jsonb_object_agg(class, n) FROM (SELECT class, count(*) n FROM fleet_notifications WHERE acknowledged_at IS NULL GROUP BY class) z),
    'inbox', (SELECT jsonb_build_object('total', count(*), 'unacknowledged', count(*) FILTER (WHERE acknowledged_at IS NULL),
        'acknowledged', count(*) FILTER (WHERE acknowledged_at IS NOT NULL)) FROM fleet_notifications))
$$;

CREATE OR REPLACE FUNCTION fleet_admin_notification_get(p_id uuid) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE((SELECT to_jsonb(n) FROM fleet_notifications n WHERE n.notification_id = p_id), jsonb_build_object('notification_id', p_id, 'missing', true))
$$;

CREATE OR REPLACE FUNCTION fleet_admin_notification_ack(p_id uuid, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_notifications');
  UPDATE fleet_notifications SET acknowledged_at = now(), acknowledged_by = p_actor WHERE notification_id = p_id AND acknowledged_at IS NULL;
  RETURN jsonb_build_object('ok', FOUND);
END $$;

-- Delete (acknowledged ones; unacknowledged only with an explicit acknowledge-and-delete). Repeats are harmless.
CREATE OR REPLACE FUNCTION fleet_admin_notifications_delete(p_ids uuid[], p_ack_unread boolean, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_unread uuid[]; n integer; v_missing integer;
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_notifications');
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN RETURN jsonb_build_object('ok', true, 'deleted', 0, 'missing', 0, 'refusedUnread', '[]'::jsonb); END IF;
  IF cardinality(p_ids) > 500 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: at most 500 notifications per request'; END IF;
  SELECT COALESCE(array_agg(notification_id), '{}') INTO v_unread FROM fleet_notifications
   WHERE notification_id = ANY (p_ids) AND acknowledged_at IS NULL AND NOT COALESCE(p_ack_unread, false);
  SELECT count(*) INTO v_missing FROM (SELECT DISTINCT x FROM unnest(p_ids) x) d WHERE NOT EXISTS (SELECT 1 FROM fleet_notifications WHERE notification_id = d.x);
  WITH gone AS (
    DELETE FROM fleet_notifications WHERE notification_id = ANY (p_ids) AND NOT (notification_id = ANY (v_unread)) RETURNING dedupe_key)
  INSERT INTO fleet_notification_suppress (dedupe_key, until) SELECT dedupe_key, now() + interval '${SUPPRESS_DAYS} days' FROM gone
    ON CONFLICT (dedupe_key) DO UPDATE SET until = EXCLUDED.until;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'deleted', n, 'missing', v_missing, 'refusedUnread', to_jsonb(v_unread));
END $$;

CREATE OR REPLACE FUNCTION fleet_admin_notifications_delete_acknowledged(p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE n integer;
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_notifications');
  WITH gone AS (DELETE FROM fleet_notifications WHERE acknowledged_at IS NOT NULL RETURNING dedupe_key)
  INSERT INTO fleet_notification_suppress (dedupe_key, until) SELECT dedupe_key, now() + interval '${SUPPRESS_DAYS} days' FROM gone
    ON CONFLICT (dedupe_key) DO UPDATE SET until = EXCLUDED.until;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'deleted', n);
END $$;

CREATE OR REPLACE FUNCTION ix_notifications_unsent(p_worker text, p_limit integer) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('to', p.admin_email, 'notifications', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', n.notification_id, 'class', n.class,
      'code', n.code, 'agentId', n.agent_id, 'title', n.title, 'detail', n.detail, 'at', n.created_at) ORDER BY n.created_at)
    FROM (SELECT * FROM fleet_notifications WHERE emailed_at IS NULL AND email_attempts < 5 AND class = ANY (p.email_classes)
           ORDER BY created_at LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100))) n), '[]'::jsonb))
    FROM fleet_notification_policy p WHERE p.id = 1 AND p.admin_email IS NOT NULL
$$;

${DASH_CALL}
`;

export { DASHBOARD_READ_OPS_V44 as DASHBOARD_READ_OPS_V45 };

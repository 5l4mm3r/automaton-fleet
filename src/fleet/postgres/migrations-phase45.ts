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
 *
 * FLEET HISTORY IS MEANINGFUL MEMORY, NOT SOFTWARE PLUMBING (owner brief "final V2.4.4", same day). fleet_events keeps
 * its canonical events forever (UPDATE stays refused, and DELETE of anything canonical stays refused). Two kinds of rows
 * are not history and now EXPIRE:
 *   - routine event COPIES whose real record lives elsewhere: session_opened (the session table), ledger_journal_posted
 *     (the ledger journal itself, never touched), <role>_role_granted (the database's grants), notifications_deleted
 *     (no longer produced) — kept 7 days;
 *   - routine security DIAGNOSTICS: API / database / operator authentication failures — kept 30 days.
 * Serious incidents (replay blocked, passkey clone, lockout, privilege denials, attestation / signing / custody
 * failures) are neither, so they never expire. No code reads the expiring types (verified: only the Operator API's
 * generic event listing and fleet-edge.sh's 10-minute api_auth_failed scan, both inside the windows).
 * The guard is the delete trigger itself: a DELETE succeeds only for an expiring type, only past its retention, and only
 * inside the retention pass (svc_event_retention, run hourly by the controller; it writes no event). The migration
 * purges every existing copy once. The dashboard's history (`events` read without a type) shows meaningful history only:
 * not the expiring types, not release preparation, provisioning steps, routine operator calls or routine notification
 * copies. An explicit `type` still returns that type (diagnostics stay reachable during their window, as through the
 * Operator API).
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
/** Routine event copies (the canonical record lives elsewhere): expire, never history. Plus every `<role>_role_granted`. */
export const EVENT_COPY_TYPES = ["session_opened", "ledger_journal_posted", "notifications_deleted"] as const;
export const ROLE_GRANT_PATTERN = "^[a-z]+_role_granted$";
/** Routine authentication diagnostics: expire after the diagnostic window, never history. (Serious incidents are not here.) */
export const EVENT_DIAGNOSTIC_TYPES = ["api_auth_failed", "api_auth_failed_suppressed", "db_auth_failed", "operator_auth_failed",
  "operator_scope_denied", "operator_stale"] as const;
export const EVENT_COPY_RETENTION_DAYS = 7;
export const EVENT_DIAGNOSTIC_RETENTION_DAYS = 30;
/** Durable (kept) but not Fleet history: release preparation, provisioning and registry steps, routine operator calls. */
export const HISTORY_HIDDEN_TYPES = ["runtime_approved", "founder_runtime_upgrade_prepared", "founder_runtime_upgrade_committed", "operator_action",
  "operator_requests_archived", "health_challenge_requested", "runtime_verified", "credential_issued", "slot_reserved", "slot_released", "slot_claimed",
  "orphan_slot_released", "reservation_expired", "genesis_runtime_issued", "genesis_runtime_evidence", "fx_rate_recorded"] as const;
export const HISTORY_HIDDEN_PREFIXES = ["provisioning_"] as const;
/** Rows removed per retention pass (the pass repeats hourly). */
export const RETENTION_BATCH = 20000;
export const SUPPRESS_DAYS = 7;

/** The one-time purge of every existing routine event copy (in the v45 migration; a tested statement on its own). */
export const PURGE_COPIES_SQL = `SELECT set_config('fleet.event_retention', 'purge', true);
DELETE FROM fleet_events WHERE fleet_event_retention_days(event_type) = ${EVENT_COPY_RETENTION_DAYS};
SELECT set_config('fleet.event_retention', '', true);`;

const notificationCases = Object.entries(NOTIFICATION_ROUTES).map(([code, p]) => `      WHEN p_detail ->> 'code' = '${code}' THEN '${p}'`).join("\n");

const DASH_CALL = restate(V44_SQL, "dash_call", [
  [`OR p_op IN (${q(DASHBOARD_WRITE_OPS_V43)})`, `OR p_op IN (${q(DASHBOARD_WRITE_OPS_V45)})`],
  [`      WHEN 'passkey_rename' THEN dash_passkey_rename(a ->> 'credentialId', a ->> 'name', p_ip)`,
   `      WHEN 'passkey_rename' THEN dash_passkey_rename(a ->> 'credentialId', a ->> 'name', p_ip)
      WHEN 'command_clear' THEN fleet_admin_command_clear(a ->> 'priority', ${ACTOR})`],
  // Fleet history: the dashboard's event history (no explicit type) is meaningful history only.
  [`FROM (SELECT * FROM fleet_events WHERE (a ->> 'type' IS NULL OR event_type = a ->> 'type')`,
   `FROM (SELECT * FROM fleet_events WHERE (CASE WHEN a ->> 'type' IS NULL THEN fleet_event_in_history(event_type, detail) ELSE event_type = a ->> 'type' END)`],
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

-- ═══ 4. Fleet history vs plumbing: expiring copies and diagnostics, a guarded delete, an hourly retention pass ═══
CREATE FUNCTION fleet_event_retention_days(p_type text) RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT CASE
    WHEN p_type IN (${q(EVENT_COPY_TYPES)}) OR p_type ~ '${ROLE_GRANT_PATTERN}' THEN ${EVENT_COPY_RETENTION_DAYS}
    WHEN p_type IN (${q(EVENT_DIAGNOSTIC_TYPES)}) THEN ${EVENT_DIAGNOSTIC_RETENTION_DAYS}
    ELSE NULL END
$$;

CREATE FUNCTION fleet_event_in_history(p_type text, p_detail jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT fleet_event_retention_days(p_type) IS NULL
     AND p_type NOT IN (${q(HISTORY_HIDDEN_TYPES)})
${HISTORY_HIDDEN_PREFIXES.map((x) => `     AND NOT starts_with(p_type, '${x}')`).join("\n")}
     AND NOT (p_type = 'notification' AND fleet_event_route(p_type, p_detail) = 'AUDIT_ONLY')
$$;

-- The history stays append-only: UPDATE is always refused; DELETE only for an expiring type past its retention, inside
-- the retention pass ('expire'), or (once, in this migration) every existing routine copy ('purge').
CREATE FUNCTION fleet_events_expire_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE m text := COALESCE(current_setting('fleet.event_retention', true), ''); d integer := fleet_event_retention_days(OLD.event_type);
BEGIN
  IF d IS NOT NULL AND ((m = 'expire' AND OLD.created_at < now() - make_interval(days => d))
                        OR (m = 'purge' AND d = ${EVENT_COPY_RETENTION_DAYS})) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: % on % is not allowed', TG_OP, TG_TABLE_NAME;
END $$;
DROP TRIGGER fleet_events_no_change ON fleet_events;
CREATE TRIGGER fleet_events_no_update BEFORE UPDATE ON fleet_events FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_events_expire_guard BEFORE DELETE ON fleet_events FOR EACH ROW EXECUTE FUNCTION fleet_events_expire_guard();
CREATE INDEX fleet_events_created ON fleet_events (created_at);

-- One-time purge of the existing routine copies (session_opened, ledger_journal_posted, role grants,
-- notifications_deleted). The ledger journals, sessions and grants themselves are not touched.
${PURGE_COPIES_SQL}

-- The retention pass: expired copies, expired diagnostics, expired notification suppression keys. Writes no event.
CREATE FUNCTION svc_event_retention() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE n integer; k integer;
BEGIN
  PERFORM set_config('fleet.event_retention', 'expire', true);
  DELETE FROM fleet_events WHERE id IN (
    SELECT id FROM fleet_events WHERE created_at < now() - interval '${EVENT_COPY_RETENTION_DAYS} days'
       AND fleet_event_retention_days(event_type) IS NOT NULL
       AND created_at < now() - make_interval(days => fleet_event_retention_days(event_type))
     ORDER BY id LIMIT ${RETENTION_BATCH});
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('fleet.event_retention', '', true);
  DELETE FROM fleet_notification_suppress WHERE until < now();
  GET DIAGNOSTICS k = ROW_COUNT;
  RETURN jsonb_build_object('eventsExpired', n, 'suppressionExpired', k);
END $$;

${DASH_CALL}
`;

export { DASHBOARD_READ_OPS_V44 as DASHBOARD_READ_OPS_V45 };

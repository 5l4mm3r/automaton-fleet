/**
 * Schema v84 — P1 follow-ups (owner, 2026-10-16): an alert whose push ran out or failed stays VISIBLY unresolved.
 *
 * A Pushover alarm repeats for at most an hour (src/fleet/push/pushover.ts: 72 s × 50, Pushover's caps). After that, or when
 * every attempt failed, or when a push has waited too long to be sent (no credentials, sender down), the phone is silent —
 * so the dashboard's push read lists each such notification that is still unacknowledged, with the reason, until the owner
 * acknowledges it. Nothing is re-sent automatically and nothing is approved.
 */
import { V83_SQL } from "./migrations-phase83.js";
import { restate } from "./migrations-phase42.js";
import { ALARM_EXPIRE_S } from "../push/pushover.js";

/** A push still unsent after this long counts as unresolved (minutes). */
export const PUSH_WAITING_UNRESOLVED_MIN = 15;

const PUSH_JSON = restate(V83_SQL, "fleet_push_json", [
  [`    'lastFailure', (SELECT jsonb_build_object('at', created_at, 'error', last_error) FROM fleet_push_deliveries WHERE state = 'failed' ORDER BY created_at DESC LIMIT 1))`,
   `    'lastFailure', (SELECT jsonb_build_object('at', created_at, 'error', last_error) FROM fleet_push_deliveries WHERE state = 'failed' ORDER BY created_at DESC LIMIT 1),
    -- v84: unacknowledged notifications whose phone alert is over without an answer: the alarm expired, every push failed,
    -- or it has waited too long to be sent. Listed until the owner acknowledges them.
    'unresolved', COALESCE((SELECT jsonb_agg(u ORDER BY u ->> 'createdAt' DESC) FROM (
       SELECT jsonb_build_object('notificationId', n.notification_id, 'class', n.class, 'code', n.code, 'createdAt', n.created_at,
         'reason', CASE WHEN bool_or(x.priority = 2 AND x.state = 'sent' AND x.alarm_cancelled_at IS NULL AND x.sent_at < now() - interval '${ALARM_EXPIRE_S} seconds') THEN 'alarm_expired'
                        WHEN bool_and(x.state = 'failed') THEN 'push_failed'
                        WHEN bool_or(x.state = 'pending' AND x.created_at < now() - interval '${PUSH_WAITING_UNRESOLVED_MIN} minutes') THEN 'push_waiting' END) AS u
         FROM fleet_notifications n JOIN fleet_push_deliveries x ON x.notification_id = n.notification_id
        WHERE n.acknowledged_at IS NULL AND x.kind = 'alert'
        GROUP BY n.notification_id, n.class, n.code, n.created_at
       HAVING bool_or(x.priority = 2 AND x.state = 'sent' AND x.alarm_cancelled_at IS NULL AND x.sent_at < now() - interval '${ALARM_EXPIRE_S} seconds')
           OR bool_and(x.state = 'failed')
           OR bool_or(x.state = 'pending' AND x.created_at < now() - interval '${PUSH_WAITING_UNRESOLVED_MIN} minutes')
        LIMIT 50) z), '[]'::jsonb))`],
]);

export const V84_SQL = `
${PUSH_JSON}
`;

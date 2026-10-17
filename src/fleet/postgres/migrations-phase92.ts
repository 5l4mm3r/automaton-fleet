/**
 * Schema v92 — the ALARM DRILL (owner, 2026-10-17: proof 2 needs "a real alert that rang and was cancelled by
 * acknowledgement", and an unanswered one listed as unresolved; every alarm code until now is a real emergency).
 *
 * `push_alarm_drill` (an ordinary dashboard write: it only rings the owner's own phones) raises ONE notification, class
 * RED, code ALARM_DRILL, titled as a drill, on exactly the path a real P0 alarm takes: one delivery per phone at
 * priority 2 (Pushover emergency: repeats every 72 s for at most an hour); acknowledging the notification in Fleet HQ
 * cancels the alarm at the provider (px_push_cancel_due → px_push_cancelled); left unanswered past the alarm's hour it is
 * listed under "alerts still unresolved" (v84) until acknowledged. It is not an incident: the code has no Fleet Command
 * route (audit only), it touches no agent, money or setting, and only one drill can be open at a time.
 */
import { V83_SQL } from "./migrations-phase83.js";
import { V90_SQL } from "./migrations-phase90.js";
import { restate } from "./migrations-phase42.js";

export const ALARM_DRILL_CODE = "ALARM_DRILL";
export const DASHBOARD_WRITE_OPS_V92_ADDED = ["push_alarm_drill"] as const;

const PRIORITY = restate(V83_SQL, "fleet_push_priority", [
  [`  SELECT CASE WHEN p_code IN (`, `  SELECT CASE WHEN p_code = '${ALARM_DRILL_CODE}' THEN 2
              WHEN p_code IN (`],
]);

const DASH_CALL = restate(V90_SQL, "dash_call", [
  [`'repo_access_revoke','card_dispute_reversal');`, `'repo_access_revoke','card_dispute_reversal','push_alarm_drill');`],
  [`      WHEN 'push_test' THEN`, `      WHEN 'push_alarm_drill' THEN fleet_admin_push_alarm_drill('operator:owner')
      WHEN 'push_test' THEN`],
]);

export const V92_SQL = `
${PRIORITY}

CREATE FUNCTION fleet_admin_push_alarm_drill(p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_id uuid; v_n integer;
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_notifications');
  SELECT count(*) INTO v_n FROM fleet_push_devices WHERE revoked_at IS NULL;
  IF v_n = 0 THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NO_PHONE', 'reason', 'add a phone first (Phone alerts)'); END IF;
  IF EXISTS (SELECT 1 FROM fleet_notifications WHERE code = '${ALARM_DRILL_CODE}' AND acknowledged_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_DRILL_OPEN', 'reason', 'a drill is already ringing: acknowledge it first');
  END IF;
  PERFORM fleet_notify('RED', '${ALARM_DRILL_CODE}', NULL, 'Alarm drill (a test, not an incident): acknowledge it in Fleet HQ to stop the alarm',
    jsonb_build_object('drill', true, 'by', p_actor), 'alarm-drill:' || gen_random_uuid());
  SELECT notification_id INTO v_id FROM fleet_notifications WHERE code = '${ALARM_DRILL_CODE}' AND acknowledged_at IS NULL ORDER BY created_at DESC LIMIT 1;
  RETURN jsonb_build_object('ok', true, 'notificationId', v_id, 'phones', v_n,
    'note', 'your phones ring until you acknowledge this notification in Fleet HQ (at most an hour; then it is listed as unresolved)');
END $$;

${DASH_CALL}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

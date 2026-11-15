/**
 * Schema v43 — owner sign-in RESILIENCE and notification housekeeping (owner handoff 2026-10-07, "final corrective").
 *
 * Why: owner access must not depend on one browser- or provider-specific passkey. Until v42 the only route was a passkey
 * (+ TOTP); a passkey held by one browser's credential provider stranded the owner when that browser was not at hand.
 *
 * SIGN-IN (additive — the existing passkey and TOTP enrollment are untouched):
 *   ROUTE A  password + TOTP   — the password is never stored: the dashboard process derives a scrypt verifier
 *                                (memory-hard; salt; constant-time comparison) and only the verifier is kept here.
 *   ROUTE B  passkey + TOTP    — unchanged.
 *   TOTP is the second factor of BOTH routes; neither a password nor a passkey alone ever yields a full session.
 *   Step-up (sensitive operations) accepts a fresh passkey assertion OR a fresh password + TOTP, bound to the same
 *   operation and argument digest, single use, 2 minutes — the dashboard verifies the factors, this schema records them.
 * PASSWORD:      set or changed from a full session with a fresh step-up ('password_set', args '{}'), or with a one-time
 *                host enrollment/recovery token (fleet:admin hub-dashboard-enroll). Setting it ends the other password
 *                sessions. The verifier never leaves the dashboard gateway functions and is never returned by any read.
 * PASSKEYS:      several, independent (each its own credential row); added from a full session with a step-up
 *                ('passkey_add', args '{}' — the credential id is unknown until the browser creates it); renamed; revoked.
 * LOCKOUT GUARD: revoking a passkey is refused if it would leave no passkey AND no password; the authenticator (the
 *                second factor of both routes) can no longer be reset from the dashboard — only on the Fleet host
 *                (fleet_admin_dashboard_totp_reset, owner connection), followed by an enrollment link.
 *
 * NOTIFICATIONS: acknowledge stays as it was. DELETE is a separate, owner-attributed action, allowed only for
 *   acknowledged notifications (or explicitly "acknowledge and delete"). A deleted notification leaves the inbox, its
 *   counts and Acknowledge all; what remains is a minimal tombstone (id, class, code, created / acknowledged / deleted
 *   times, who deleted it) — its title and detail are cleared, as the owner asked. Rows are never physically removed
 *   (the dedupe key stays, so a deleted daily report is not re-raised). Repeating a delete changes nothing.
 */
import { V42_SQL, restate } from "./migrations-phase42.js";
import { DASHBOARD_READ_OPS_V42 } from "./migrations-phase42.js";
import { DASHBOARD_WRITE_OPS_V41 } from "./migrations-phase41.js";

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const ACTOR = "'operator:owner'";

export const DASHBOARD_READ_OPS_V43 = [...DASHBOARD_READ_OPS_V42, "notification_get"] as const;
export const DASHBOARD_WRITE_OPS_V43 = [...DASHBOARD_WRITE_OPS_V41, "notification_delete", "notification_delete_acknowledged", "passkey_rename"] as const;

/** scrypt$v1$N=<n>,r=<r>,p=<p>$<salt b64url>$<key b64url> — the only verifier format accepted. */
export const PASSWORD_VERIFIER_RE = "^scrypt\\$v1\\$N=[0-9]{4,7},r=[0-9]{1,2},p=[0-9]{1,2}\\$[A-Za-z0-9_-]{16,64}\\$[A-Za-z0-9_-]{40,128}$";

const DASH_CALL = restate(V42_SQL, "dash_call", [
  [`p_op IN (${q(DASHBOARD_READ_OPS_V42)})`, `p_op IN (${q(DASHBOARD_READ_OPS_V43)})`],
  [`OR p_op IN (${q(DASHBOARD_WRITE_OPS_V41)})`, `OR p_op IN (${q(DASHBOARD_WRITE_OPS_V43)})`],
  [`      WHEN 'projects' THEN fleet_admin_projects(a)`, `      WHEN 'projects' THEN fleet_admin_projects(a)
      WHEN 'notification_get' THEN fleet_admin_notification_get((a ->> 'id')::uuid)
      WHEN 'notification_delete' THEN fleet_admin_notifications_delete(ARRAY(SELECT jsonb_array_elements_text(COALESCE(a -> 'ids', '[]'::jsonb)))::uuid[],
          COALESCE((a ->> 'acknowledgeUnread')::boolean, false), ${ACTOR})
      WHEN 'notification_delete_acknowledged' THEN fleet_admin_notifications_delete_acknowledged(${ACTOR})
      WHEN 'passkey_rename' THEN dash_passkey_rename(a ->> 'credentialId', a ->> 'name', p_ip)`],
  // The Security read: sign-in methods (never a verifier, key or secret).
  [`          'passkeys', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', left(credential_id, 16), 'credentialId', credential_id, 'name', name, 'createdAt', created_at,
              'lastUsedAt', last_used_at, 'revokedAt', revoked_at)) FROM fleet_admin_passkeys), '[]'::jsonb),`,
   `          'passkeys', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', left(credential_id, 16), 'credentialId', credential_id, 'name', name, 'createdAt', created_at,
              'lastUsedAt', last_used_at, 'revokedAt', revoked_at, 'transports', transports, 'current', credential_id = s.credential_id) ORDER BY created_at) FROM fleet_admin_passkeys), '[]'::jsonb),
          'password', (SELECT jsonb_build_object('configured', true, 'setAt', set_at) FROM fleet_admin_password WHERE id = 1),
          'totp', jsonb_build_object('configured', EXISTS (SELECT 1 FROM fleet_admin_totp WHERE confirmed_at IS NOT NULL)),
          'method', s.method,`],
  [`          'sessions', COALESCE((SELECT jsonb_agg(jsonb_build_object('current', x.session_sha = p_session_sha, 'ip', x.ip, 'userAgent', x.user_agent, 'createdAt', x.created_at,`,
   `          'sessions', COALESCE((SELECT jsonb_agg(jsonb_build_object('current', x.session_sha = p_session_sha, 'method', x.method, 'ip', x.ip, 'userAgent', x.user_agent, 'createdAt', x.created_at,`],
]);

export const V43_SQL = `
-- ═══ 1. Password route (verifier only) and session methods ═══
CREATE TABLE fleet_admin_password (
  id         smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  verifier   text        NOT NULL CHECK (verifier ~ '${PASSWORD_VERIFIER_RE}'),
  set_at     timestamptz NOT NULL DEFAULT now(),
  set_via    text        NOT NULL CHECK (set_via IN ('session','enrollment'))
);

ALTER TABLE fleet_admin_sessions ALTER COLUMN credential_id DROP NOT NULL;
ALTER TABLE fleet_admin_sessions ADD COLUMN method text NOT NULL DEFAULT 'passkey' CHECK (method IN ('passkey','password'));
ALTER TABLE fleet_admin_sessions ADD CONSTRAINT fleet_admin_sessions_method_credential CHECK ((method = 'passkey') = (credential_id IS NOT NULL));

CREATE OR REPLACE FUNCTION dash_auth_state() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'passkeys', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', credential_id, 'transports', transports)) FROM fleet_admin_passkeys WHERE revoked_at IS NULL), '[]'::jsonb),
    'passwordConfigured', EXISTS (SELECT 1 FROM fleet_admin_password WHERE id = 1),
    'totpConfigured', EXISTS (SELECT 1 FROM fleet_admin_totp WHERE confirmed_at IS NOT NULL),
    'locked', (SELECT count(*) FROM fleet_admin_auth_log WHERE NOT ok AND event IN ('login','totp','stepup','enroll') AND at > now() - interval '15 minutes') >= 20)
$$;

-- The verifier, for the dashboard process to check a presented password (it is never part of any read or response).
CREATE FUNCTION dash_password_get() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT (SELECT jsonb_build_object('verifier', verifier, 'setAt', set_at) FROM fleet_admin_password WHERE id = 1)
$$;

-- Set or change the password: a one-time enrollment / recovery token, or a full session with a fresh step-up.
CREATE FUNCTION dash_password_set(p_token_sha text, p_session_sha text, p_stepup_sha text, p_verifier text, p_ip text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_via text; n integer;
BEGIN
  IF p_verifier IS NULL OR p_verifier !~ '${PASSWORD_VERIFIER_RE}' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  IF p_token_sha IS NOT NULL THEN
    UPDATE fleet_admin_enrollment SET used_at = now() WHERE token_sha = p_token_sha AND used_at IS NULL AND expires_at > now();
    IF NOT FOUND THEN PERFORM fleet_admin_auth_log_write('enroll', false, NULL, 'FLEET_ENROLLMENT_INVALID', p_ip, '{}'); RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ENROLLMENT_INVALID'); END IF;
    v_via := 'enrollment';
  ELSE
    IF (dash_session_live(p_session_sha, true)).session_sha IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_SESSION_INVALID'); END IF;
    IF NOT dash_stepup_consume(p_session_sha, p_stepup_sha, 'password_set', encode(sha256(convert_to('{}', 'UTF8')), 'hex')) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_STEPUP_REQUIRED');
    END IF;
    v_via := 'session';
  END IF;
  INSERT INTO fleet_admin_password (id, verifier, set_at, set_via) VALUES (1, p_verifier, now(), v_via)
    ON CONFLICT (id) DO UPDATE SET verifier = EXCLUDED.verifier, set_at = EXCLUDED.set_at, set_via = EXCLUDED.set_via;
  -- A changed password ends every other password session (passkey sessions are unaffected).
  UPDATE fleet_admin_sessions SET ended_at = now() WHERE method = 'password' AND ended_at IS NULL AND session_sha IS DISTINCT FROM p_session_sha;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM fleet_admin_auth_log_write('password_set', true, NULL, v_via, p_ip, jsonb_build_object('passwordSessionsEnded', n));
  PERFORM fleet_notify('AMBER', 'ADMIN_PASSWORD_SET', NULL, 'The Admin sign-in password was set or changed', jsonb_build_object('via', v_via), 'password:' || now());
  RETURN jsonb_build_object('ok', true, 'via', v_via);
END $$;

-- A full session from the password route: the dashboard verified the password AND a fresh TOTP code (accepted once).
CREATE FUNCTION dash_session_begin_password(p_session_sha text, p_csrf_sha text, p_ip text, p_ua text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleet_admin_password WHERE id = 1) OR NOT EXISTS (SELECT 1 FROM fleet_admin_totp WHERE confirmed_at IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_LOGIN_INVALID');
  END IF;
  INSERT INTO fleet_admin_sessions (session_sha, csrf_sha, credential_id, method, totp_ok, ip, user_agent, expires_at)
    VALUES (p_session_sha, p_csrf_sha, NULL, 'password', true, left(p_ip, 64), left(p_ua, 300), now() + interval '12 hours');
  PERFORM fleet_admin_auth_log_write('login', true, NULL, 'password', p_ip, '{}');
  PERFORM fleet_admin_auth_log_write('totp', true, NULL, NULL, p_ip, '{}');
  RETURN jsonb_build_object('ok', true, 'expiresAt', now() + interval '12 hours');
END $$;

-- A live full session: a passkey session needs its passkey unrevoked; a password session needs a password to exist
-- (changing the password ends every OTHER password session explicitly, in dash_password_set).
CREATE OR REPLACE FUNCTION dash_session_live(p_session_sha text, p_touch boolean) RETURNS fleet_admin_sessions LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE s fleet_admin_sessions;
BEGIN
  SELECT * INTO s FROM fleet_admin_sessions WHERE session_sha = p_session_sha AND ended_at IS NULL AND totp_ok AND expires_at > now()
     AND last_seen_at > now() - interval '30 minutes'
     AND CASE method
           WHEN 'passkey' THEN EXISTS (SELECT 1 FROM fleet_admin_passkeys k WHERE k.credential_id = fleet_admin_sessions.credential_id AND k.revoked_at IS NULL)
           WHEN 'password' THEN EXISTS (SELECT 1 FROM fleet_admin_password p WHERE p.id = 1)
           ELSE false END;
  IF FOUND AND p_touch THEN UPDATE fleet_admin_sessions SET last_seen_at = now() WHERE session_sha = p_session_sha; END IF;
  RETURN s;
END $$;

-- The session's own CSRF token (state-changing requests outside dash_call: password, passkey registration).
CREATE FUNCTION dash_session_csrf_ok(p_session_sha text, p_csrf_sha text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE s fleet_admin_sessions := dash_session_live(p_session_sha, false);
BEGIN
  RETURN s.session_sha IS NOT NULL AND p_csrf_sha IS NOT NULL AND s.csrf_sha = p_csrf_sha;
END $$;

-- ═══ 2. Several passkeys: add from a session (step-up on '{}'), rename, revoke with the lockout guard ═══
CREATE OR REPLACE FUNCTION dash_passkey_add(p_token_sha text, p_session_sha text, p_stepup_sha text, p_id text, p_public_key bytea, p_count bigint, p_transports text[], p_name text, p_ip text)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_name text := left(btrim(regexp_replace(COALESCE(p_name, ''), '[[:cntrl:]]', '', 'g')), 80);
BEGIN
  IF v_name = '' THEN v_name := 'passkey'; END IF;
  IF p_token_sha IS NOT NULL THEN
    UPDATE fleet_admin_enrollment SET used_at = now() WHERE token_sha = p_token_sha AND used_at IS NULL AND expires_at > now();
    IF NOT FOUND THEN PERFORM fleet_admin_auth_log_write('enroll', false, NULL, 'FLEET_ENROLLMENT_INVALID', p_ip, '{}'); RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ENROLLMENT_INVALID'); END IF;
  ELSE
    IF (dash_session_live(p_session_sha, true)).session_sha IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_SESSION_INVALID'); END IF;
    IF NOT dash_stepup_consume(p_session_sha, p_stepup_sha, 'passkey_add', encode(sha256(convert_to('{}', 'UTF8')), 'hex')) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_STEPUP_REQUIRED');
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM fleet_admin_passkeys WHERE credential_id = p_id) THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PASSKEY_EXISTS'); END IF;
  INSERT INTO fleet_admin_passkeys (credential_id, public_key, sign_count, transports, name) VALUES (p_id, p_public_key, GREATEST(0, p_count), COALESCE(p_transports, '{}'), v_name);
  PERFORM fleet_admin_auth_log_write('passkey_added', true, NULL, NULL, p_ip, jsonb_build_object('credentialId', left(p_id, 24), 'name', v_name));
  PERFORM fleet_notify('AMBER', 'ADMIN_PASSKEY_ADDED', NULL, 'A new Admin passkey was registered: ' || v_name, jsonb_build_object('ip', p_ip, 'name', v_name), 'passkey:' || p_id);
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE FUNCTION dash_passkey_rename(p_id text, p_name text, p_ip text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_name text := left(btrim(regexp_replace(COALESCE(p_name, ''), '[[:cntrl:]]', '', 'g')), 80);
BEGIN
  IF v_name = '' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a passkey name is 1-80 characters'; END IF;
  UPDATE fleet_admin_passkeys SET name = v_name WHERE credential_id = p_id AND revoked_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no active passkey with that id'; END IF;
  PERFORM fleet_admin_auth_log_write('passkey_renamed', true, NULL, NULL, p_ip, jsonb_build_object('credentialId', left(p_id, 24), 'name', v_name));
  RETURN jsonb_build_object('ok', true, 'name', v_name);
END $$;

-- Revoking may never leave the owner without a primary route: another active passkey, or a password, must remain.
CREATE OR REPLACE FUNCTION dash_passkey_revoke(p_id text, p_ip text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleet_admin_passkeys WHERE credential_id = p_id AND revoked_at IS NULL) THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF (SELECT count(*) FROM fleet_admin_passkeys WHERE revoked_at IS NULL AND credential_id <> p_id) < 1 AND NOT EXISTS (SELECT 1 FROM fleet_admin_password WHERE id = 1) THEN
    RAISE EXCEPTION 'FLEET_LAST_SIGN_IN_METHOD: this is your last passkey and no password is set; set a password or add another passkey first';
  END IF;
  UPDATE fleet_admin_passkeys SET revoked_at = now() WHERE credential_id = p_id AND revoked_at IS NULL;
  PERFORM fleet_admin_auth_log_write('passkey_revoked', true, NULL, NULL, p_ip, jsonb_build_object('credentialId', left(p_id, 24)));
  PERFORM fleet_notify('AMBER', 'ADMIN_PASSKEY_REVOKED', NULL, 'An Admin passkey was revoked', jsonb_build_object('ip', p_ip), 'passkey-revoked:' || p_id);
  RETURN jsonb_build_object('ok', true);
END $$;

-- The authenticator is the second factor of BOTH routes: resetting it from the dashboard would lock every route, so it
-- fails closed here. Host recovery: fleet_admin_dashboard_totp_reset (owner connection) + an enrollment link.
CREATE OR REPLACE FUNCTION dash_totp_reset(p_ip text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'FLEET_LOCKOUT_PREVENTED: the authenticator is the second factor of every sign-in route; removing it here would lock you out. Replace it on the Fleet host (fleet:admin hub-dashboard-totp-reset, then a hub-dashboard-enroll link)';
END $$;

CREATE FUNCTION fleet_admin_dashboard_totp_reset(p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_dashboard');
  DELETE FROM fleet_admin_totp WHERE id = 1;
  PERFORM fleet_admin_auth_log_write('totp_reset', true, NULL, 'host', NULL, jsonb_build_object('by', p_actor));
  PERFORM fleet_notify('AMBER', 'ADMIN_TOTP_RESET', NULL, 'The Admin authenticator was reset on the Fleet host: enroll a new one with an enrollment link', '{}'::jsonb, 'totp-reset:' || now());
  RETURN jsonb_build_object('ok', true, 'next', 'issue an enrollment link (fleet:admin hub-dashboard-enroll) and register the new authenticator');
END $$;

-- ═══ 3. Notifications: delete (acknowledged only) leaves a minimal tombstone ═══
ALTER TABLE fleet_notifications ADD COLUMN deleted_at timestamptz;
ALTER TABLE fleet_notifications ADD COLUMN deleted_by text CHECK (length(deleted_by) <= 128);
ALTER TABLE fleet_notifications ADD CONSTRAINT fleet_notifications_delete_acknowledged CHECK (deleted_at IS NULL OR (acknowledged_at IS NOT NULL AND deleted_by IS NOT NULL));
CREATE INDEX fleet_notifications_inbox ON fleet_notifications (created_at DESC) WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION fleet_admin_notifications(p_limit integer, p_unacknowledged boolean) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('notifications', COALESCE((SELECT jsonb_agg(to_jsonb(n) - 'deleted_at' - 'deleted_by' ORDER BY n.created_at DESC) FROM (
      SELECT * FROM fleet_notifications WHERE deleted_at IS NULL AND (NOT COALESCE(p_unacknowledged, false) OR acknowledged_at IS NULL)
       ORDER BY created_at DESC LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 500))) n), '[]'::jsonb),
    'unacknowledged', (SELECT jsonb_object_agg(class, n) FROM (SELECT class, count(*) n FROM fleet_notifications WHERE acknowledged_at IS NULL AND deleted_at IS NULL GROUP BY class) z),
    'inbox', (SELECT jsonb_build_object('total', count(*), 'unacknowledged', count(*) FILTER (WHERE acknowledged_at IS NULL),
        'acknowledged', count(*) FILTER (WHERE acknowledged_at IS NOT NULL)) FROM fleet_notifications WHERE deleted_at IS NULL))
$$;

CREATE FUNCTION fleet_admin_notification_get(p_id uuid) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE((SELECT CASE WHEN n.deleted_at IS NOT NULL THEN jsonb_build_object('notification_id', n.notification_id, 'deleted', true)
                               ELSE to_jsonb(n) - 'deleted_at' - 'deleted_by' END
                     FROM fleet_notifications n WHERE n.notification_id = p_id), jsonb_build_object('notification_id', p_id, 'missing', true))
$$;

CREATE OR REPLACE FUNCTION fleet_admin_notification_ack(p_id uuid, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_notifications');
  UPDATE fleet_notifications SET acknowledged_at = now(), acknowledged_by = p_actor WHERE notification_id = p_id AND acknowledged_at IS NULL AND deleted_at IS NULL;
  RETURN jsonb_build_object('ok', FOUND);
END $$;

-- Delete from the inbox. Unacknowledged ones are refused unless p_ack_unread (an explicit "acknowledge and delete").
CREATE FUNCTION fleet_admin_notifications_delete(p_ids uuid[], p_ack_unread boolean, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_notifications; v_deleted uuid[] := '{}'; v_already integer := 0; v_unread uuid[] := '{}'; v_missing integer := 0; v_id uuid;
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_notifications');
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN RETURN jsonb_build_object('ok', true, 'deleted', 0, 'alreadyDeleted', 0, 'refusedUnread', '[]'::jsonb); END IF;
  IF cardinality(p_ids) > 500 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: at most 500 notifications per request'; END IF;
  FOREACH v_id IN ARRAY (SELECT array_agg(DISTINCT x) FROM unnest(p_ids) x) LOOP
    SELECT * INTO r FROM fleet_notifications WHERE notification_id = v_id FOR UPDATE;
    IF NOT FOUND THEN v_missing := v_missing + 1; CONTINUE; END IF;
    IF r.deleted_at IS NOT NULL THEN v_already := v_already + 1; CONTINUE; END IF;
    IF r.acknowledged_at IS NULL AND NOT COALESCE(p_ack_unread, false) THEN v_unread := v_unread || v_id; CONTINUE; END IF;
    UPDATE fleet_notifications SET acknowledged_at = COALESCE(acknowledged_at, now()), acknowledged_by = COALESCE(acknowledged_by, p_actor),
           deleted_at = now(), deleted_by = p_actor, title = 'Deleted notification', detail = '{}'::jsonb
     WHERE notification_id = v_id;
    v_deleted := v_deleted || v_id;
  END LOOP;
  IF cardinality(v_deleted) > 0 THEN
    PERFORM fleet_event('notifications_deleted', NULL, p_actor, jsonb_build_object('count', cardinality(v_deleted), 'ids', to_jsonb(v_deleted)));
  END IF;
  RETURN jsonb_build_object('ok', true, 'deleted', cardinality(v_deleted), 'alreadyDeleted', v_already, 'missing', v_missing, 'refusedUnread', to_jsonb(v_unread));
END $$;

CREATE FUNCTION fleet_admin_notifications_delete_acknowledged(p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_ids uuid[];
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_notifications');
  SELECT COALESCE(array_agg(notification_id), '{}') INTO v_ids FROM fleet_notifications WHERE acknowledged_at IS NOT NULL AND deleted_at IS NULL;
  IF cardinality(v_ids) = 0 THEN RETURN jsonb_build_object('ok', true, 'deleted', 0); END IF;
  UPDATE fleet_notifications SET deleted_at = now(), deleted_by = p_actor, title = 'Deleted notification', detail = '{}'::jsonb WHERE notification_id = ANY (v_ids);
  PERFORM fleet_event('notifications_deleted', NULL, p_actor, jsonb_build_object('count', cardinality(v_ids), 'allAcknowledged', true));
  RETURN jsonb_build_object('ok', true, 'deleted', cardinality(v_ids));
END $$;

-- A deleted notification is never emailed afterwards.
CREATE OR REPLACE FUNCTION ix_notifications_unsent(p_worker text, p_limit integer) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('to', p.admin_email, 'notifications', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', n.notification_id, 'class', n.class,
      'code', n.code, 'agentId', n.agent_id, 'title', n.title, 'detail', n.detail, 'at', n.created_at) ORDER BY n.created_at)
    FROM (SELECT * FROM fleet_notifications WHERE emailed_at IS NULL AND email_attempts < 5 AND deleted_at IS NULL AND class = ANY (p.email_classes)
           ORDER BY created_at LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100))) n), '[]'::jsonb))
    FROM fleet_notification_policy p WHERE p.id = 1 AND p.admin_email IS NOT NULL
$$;

${DASH_CALL}
`;

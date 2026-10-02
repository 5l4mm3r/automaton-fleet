/**
 * Schema v38 — the Admin dashboard's authentication and its single gateway (master handoff §§9, 28, 36–37, 44, 49;
 * owner decisions 2026-10-02: public admin.agentfleet.vip, WebAuthn passkey + TOTP, no password, no IP allow-list,
 * step-up for sensitive actions, reveal through the broker, never plaintext secrets in HTML).
 *
 * The dashboard process (own OS user, DB role fleet_dashboard) holds NO owner database credential and no vault. It can
 * call only dash_* functions. Every Admin operation goes through dash_call, which:
 *   - requires a live, fully authenticated session (passkey AND TOTP; 30-minute idle, 12-hour absolute expiry),
 *   - requires the CSRF token for every state change,
 *   - requires a fresh, single-use STEP-UP (a passkey assertion bound to this operation and these exact arguments) for
 *     every sensitive operation (reveals, money movement, identity vault, kill/reseed/funded birth, security settings),
 *   - dispatches only to an allow-listed set of Admin functions, as operator:owner, and
 *   - writes a permanent audit row (never a secret).
 * These controls authenticate that the person exercising Admin authority is the owner; they never limit that authority.
 */

const ACTOR = "'operator:owner'";

/** Operations that need a step-up (a fresh passkey assertion bound to the exact operation and arguments). */
export const DASHBOARD_SENSITIVE_OPS = [
  "reveal_request", "owner_vault_upload", "owner_identity_consent_set", "owner_identity_consent_revoke", "owner_identity_class_set",
  "agent_transfer", "wallet_transfer", "agent_fund", "owner_withdrawal", "agent_kill", "birth", "reseed", "estate_assign", "estate_release",
  "replication_policy", "mission_policy", "risk_policy", "notification_policy", "genesis_capital", "passkey_revoke", "totp_reset", "session_revoke_all",
] as const;
export const DASHBOARD_WRITE_OPS = ["notification_ack", "agent_hold", "agent_release", "mission_assign", "mission_end", "mission_request", "reveal_take"] as const;
export const DASHBOARD_READ_OPS = ["hub", "engine", "identity", "comms", "browser", "replication", "estates", "notifications", "daily_report", "risk", "wallet",
  "agent_events", "reveal_log", "broker_key", "health", "withdrawals", "security", "agents"] as const;

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

export const V38_SQL = `
-- ═══ 1. Admin authentication state ═══
CREATE TABLE fleet_admin_passkeys (
  credential_id  text        PRIMARY KEY CHECK (credential_id ~ '^[A-Za-z0-9_-]+$' AND length(credential_id) BETWEEN 16 AND 1400),
  public_key     bytea       NOT NULL CHECK (octet_length(public_key) BETWEEN 32 AND 2048),
  sign_count     bigint      NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  transports     text[]      NOT NULL DEFAULT '{}',
  name           text        NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz,
  revoked_at     timestamptz
);
CREATE TRIGGER fleet_admin_passkeys_no_delete BEFORE DELETE ON fleet_admin_passkeys FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_admin_totp (
  id            smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  factor_ciphertext    bytea       NOT NULL CHECK (octet_length(factor_ciphertext) BETWEEN 32 AND 512),
  confirmed_at  timestamptz,
  last_counter  bigint      NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fleet_admin_enrollment (
  token_sha   text        PRIMARY KEY CHECK (token_sha ~ '^[0-9a-f]{64}$'),
  created_by  text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

CREATE TABLE fleet_admin_challenges (
  challenge_sha  text        PRIMARY KEY CHECK (challenge_sha ~ '^[0-9a-f]{64}$'),
  purpose        text        NOT NULL CHECK (purpose IN ('enroll','login','stepup','passkey_add')),
  session_sha    text,
  op             text,
  args_sha       text        CHECK (args_sha ~ '^[0-9a-f]{64}$'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL DEFAULT now() + interval '5 minutes',
  used_at        timestamptz
);

CREATE TABLE fleet_admin_sessions (
  session_sha    text        PRIMARY KEY CHECK (session_sha ~ '^[0-9a-f]{64}$'),
  csrf_sha       text        NOT NULL CHECK (csrf_sha ~ '^[0-9a-f]{64}$'),
  credential_id  text        NOT NULL REFERENCES fleet_admin_passkeys(credential_id),
  totp_ok        boolean     NOT NULL DEFAULT false,
  ip             text        CHECK (length(ip) <= 64),
  user_agent     text        CHECK (length(user_agent) <= 300),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  ended_at       timestamptz,
  totp_failures  integer     NOT NULL DEFAULT 0
);

CREATE TABLE fleet_admin_stepups (
  stepup_sha   text        PRIMARY KEY CHECK (stepup_sha ~ '^[0-9a-f]{64}$'),
  session_sha  text        NOT NULL REFERENCES fleet_admin_sessions(session_sha),
  op           text        NOT NULL,
  args_sha     text        NOT NULL CHECK (args_sha ~ '^[0-9a-f]{64}$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '2 minutes',
  used_at      timestamptz
);

CREATE TABLE fleet_admin_auth_log (
  seq     bigserial   PRIMARY KEY,
  at      timestamptz NOT NULL DEFAULT now(),
  event   text        NOT NULL CHECK (event ~ '^[a-z_]{2,40}$'),
  ok      boolean     NOT NULL,
  op      text,
  code    text,
  ip      text,
  detail  jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (length(detail::text) <= 4000)
);
CREATE INDEX fleet_admin_auth_log_at ON fleet_admin_auth_log (at DESC);
CREATE TRIGGER fleet_admin_auth_log_no_change BEFORE UPDATE OR DELETE ON fleet_admin_auth_log FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_admin_auth_log_no_truncate BEFORE TRUNCATE ON fleet_admin_auth_log FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION fleet_admin_auth_log_write(p_event text, p_ok boolean, p_op text, p_code text, p_ip text, p_detail jsonb) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_fail integer;
BEGIN
  INSERT INTO fleet_admin_auth_log (event, ok, op, code, ip, detail) VALUES (p_event, p_ok, left(p_op, 60), left(p_code, 80), left(p_ip, 64), COALESCE(p_detail, '{}'::jsonb));
  IF NOT p_ok AND p_event IN ('login','totp','stepup','enroll') THEN
    SELECT count(*) INTO v_fail FROM fleet_admin_auth_log WHERE NOT ok AND event IN ('login','totp','stepup','enroll') AND at > now() - interval '15 minutes';
    IF v_fail >= 20 THEN
      PERFORM fleet_notify('RED', 'ADMIN_AUTH_LOCKOUT', NULL, 'Repeated failed Admin sign-in attempts: Admin sign-in is locked for 15 minutes',
        jsonb_build_object('failures15m', v_fail, 'lastIp', p_ip), 'admin-lockout:' || to_char(now(), 'YYYY-MM-DD"T"HH24'));
    END IF;
  END IF;
END $$;

-- ═══ 2. Authentication protocol (dash_*; role fleet_dashboard) ═══
CREATE FUNCTION dash_ping() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('schemaVersion', (SELECT max(version) FROM fleet_schema_migrations))
$$;

CREATE FUNCTION dash_auth_state() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'passkeys', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', credential_id, 'transports', transports)) FROM fleet_admin_passkeys WHERE revoked_at IS NULL), '[]'::jsonb),
    'totpConfigured', EXISTS (SELECT 1 FROM fleet_admin_totp WHERE confirmed_at IS NOT NULL),
    'locked', (SELECT count(*) FROM fleet_admin_auth_log WHERE NOT ok AND event IN ('login','totp','stepup','enroll') AND at > now() - interval '15 minutes') >= 20)
$$;

CREATE FUNCTION dash_log(p_event text, p_ok boolean, p_code text, p_ip text, p_detail jsonb) RETURNS void LANGUAGE sql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT fleet_admin_auth_log_write(p_event, p_ok, NULL, p_code, p_ip, p_detail)
$$;

CREATE FUNCTION dash_challenge_new(p_challenge_sha text, p_purpose text, p_session_sha text, p_op text, p_args_sha text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  DELETE FROM fleet_admin_challenges WHERE expires_at < now() - interval '1 hour';
  INSERT INTO fleet_admin_challenges (challenge_sha, purpose, session_sha, op, args_sha) VALUES (p_challenge_sha, p_purpose, p_session_sha, p_op, p_args_sha);
  RETURN jsonb_build_object('ok', true);
END $$;

-- Single use; bound to its purpose (and, for a step-up, to the session, operation and argument digest).
CREATE FUNCTION dash_challenge_use(p_challenge_sha text, p_purpose text, p_session_sha text, p_op text, p_args_sha text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  UPDATE fleet_admin_challenges SET used_at = now()
   WHERE challenge_sha = p_challenge_sha AND purpose = p_purpose AND used_at IS NULL AND expires_at > now()
     AND session_sha IS NOT DISTINCT FROM p_session_sha AND op IS NOT DISTINCT FROM p_op AND args_sha IS NOT DISTINCT FROM p_args_sha;
  RETURN FOUND;
END $$;

CREATE FUNCTION dash_enroll_valid(p_token_sha text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM fleet_admin_enrollment WHERE token_sha = p_token_sha AND used_at IS NULL AND expires_at > now())
$$;

-- A passkey is added by a valid enrollment token (first device / recovery) or by a full session with a step-up.
CREATE FUNCTION dash_passkey_add(p_token_sha text, p_session_sha text, p_stepup_sha text, p_id text, p_public_key bytea, p_count bigint, p_transports text[], p_name text, p_ip text)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_token_sha IS NOT NULL THEN
    UPDATE fleet_admin_enrollment SET used_at = now() WHERE token_sha = p_token_sha AND used_at IS NULL AND expires_at > now();
    IF NOT FOUND THEN PERFORM fleet_admin_auth_log_write('enroll', false, NULL, 'FLEET_ENROLLMENT_INVALID', p_ip, '{}'); RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ENROLLMENT_INVALID'); END IF;
  ELSE
    IF NOT dash_stepup_consume(p_session_sha, p_stepup_sha, 'passkey_add', encode(sha256(convert_to(p_id, 'UTF8')), 'hex')) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_STEPUP_REQUIRED');
    END IF;
  END IF;
  INSERT INTO fleet_admin_passkeys (credential_id, public_key, sign_count, transports, name) VALUES (p_id, p_public_key, GREATEST(0, p_count), COALESCE(p_transports, '{}'), left(p_name, 80));
  PERFORM fleet_admin_auth_log_write('passkey_added', true, NULL, NULL, p_ip, jsonb_build_object('credentialId', left(p_id, 24), 'name', left(p_name, 80)));
  PERFORM fleet_notify('AMBER', 'ADMIN_PASSKEY_ADDED', NULL, 'A new Admin passkey was registered: ' || left(p_name, 80), jsonb_build_object('ip', p_ip), 'passkey:' || p_id);
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE FUNCTION dash_passkey_get(p_id text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT (SELECT jsonb_build_object('id', credential_id, 'publicKeyB64', encode(public_key, 'base64'), 'counter', sign_count, 'transports', transports)
            FROM fleet_admin_passkeys WHERE credential_id = p_id AND revoked_at IS NULL)
$$;

-- A verified assertion advances the counter; a regression (cloned authenticator) is refused and reported RED.
CREATE FUNCTION dash_passkey_used(p_id text, p_new_count bigint, p_ip text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE k fleet_admin_passkeys;
BEGIN
  SELECT * INTO k FROM fleet_admin_passkeys WHERE credential_id = p_id AND revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF (p_new_count > 0 OR k.sign_count > 0) AND p_new_count <= k.sign_count THEN
    PERFORM fleet_admin_auth_log_write('login', false, NULL, 'FLEET_PASSKEY_COUNTER_REGRESSION', p_ip, jsonb_build_object('credentialId', left(p_id, 24)));
    PERFORM fleet_notify('RED', 'ADMIN_PASSKEY_CLONE_SUSPECTED', NULL, 'An Admin passkey presented a signature counter that went backwards', jsonb_build_object('ip', p_ip), 'clone:' || p_id || ':' || p_new_count);
    RETURN false;
  END IF;
  UPDATE fleet_admin_passkeys SET sign_count = p_new_count, last_used_at = now() WHERE credential_id = p_id;
  RETURN true;
END $$;

CREATE FUNCTION dash_totp_set(p_token_sha text, p_factor_ciphertext bytea, p_ip text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  -- Only during enrollment (the token was just consumed by the first passkey) or replacing an unconfirmed secret.
  IF EXISTS (SELECT 1 FROM fleet_admin_totp WHERE confirmed_at IS NOT NULL) THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_TOTP_CONFIGURED'); END IF;
  IF NOT EXISTS (SELECT 1 FROM fleet_admin_enrollment WHERE token_sha = p_token_sha AND used_at > now() - interval '15 minutes') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ENROLLMENT_INVALID');
  END IF;
  INSERT INTO fleet_admin_totp (id, factor_ciphertext) VALUES (1, p_factor_ciphertext) ON CONFLICT (id) DO UPDATE SET factor_ciphertext = EXCLUDED.factor_ciphertext, last_counter = 0, updated_at = now();
  PERFORM fleet_admin_auth_log_write('totp_set', true, NULL, NULL, p_ip, '{}');
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE FUNCTION dash_totp_get() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT (SELECT jsonb_build_object('secretEncB64', encode(factor_ciphertext, 'base64'), 'lastCounter', last_counter, 'confirmed', confirmed_at IS NOT NULL) FROM fleet_admin_totp WHERE id = 1)
$$;

-- A TOTP code is accepted once (its counter must be newer than the last accepted one: replay-proof).
CREATE FUNCTION dash_totp_accept(p_counter bigint, p_confirm boolean) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  UPDATE fleet_admin_totp SET last_counter = p_counter, confirmed_at = CASE WHEN p_confirm THEN COALESCE(confirmed_at, now()) ELSE confirmed_at END, updated_at = now()
   WHERE id = 1 AND p_counter > last_counter AND (p_confirm OR confirmed_at IS NOT NULL);
  RETURN FOUND;
END $$;

-- Sessions: created half-authenticated (passkey); full only after TOTP.
CREATE FUNCTION dash_session_begin(p_session_sha text, p_csrf_sha text, p_credential text, p_ip text, p_ua text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  INSERT INTO fleet_admin_sessions (session_sha, csrf_sha, credential_id, ip, user_agent, expires_at)
    VALUES (p_session_sha, p_csrf_sha, p_credential, left(p_ip, 64), left(p_ua, 300), now() + interval '5 minutes');
  PERFORM fleet_admin_auth_log_write('login', true, NULL, 'passkey', p_ip, jsonb_build_object('credentialId', left(p_credential, 24)));
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE FUNCTION dash_session_totp(p_session_sha text, p_ok boolean, p_ip text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE s fleet_admin_sessions;
BEGIN
  SELECT * INTO s FROM fleet_admin_sessions WHERE session_sha = p_session_sha AND ended_at IS NULL AND NOT totp_ok AND expires_at > now() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_SESSION_INVALID'); END IF;
  IF NOT p_ok THEN
    UPDATE fleet_admin_sessions SET totp_failures = totp_failures + 1, ended_at = CASE WHEN totp_failures + 1 >= 5 THEN now() END WHERE session_sha = p_session_sha;
    PERFORM fleet_admin_auth_log_write('totp', false, NULL, 'FLEET_TOTP_INVALID', p_ip, '{}');
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_TOTP_INVALID');
  END IF;
  UPDATE fleet_admin_sessions SET totp_ok = true, expires_at = now() + interval '12 hours', last_seen_at = now() WHERE session_sha = p_session_sha;
  PERFORM fleet_admin_auth_log_write('totp', true, NULL, NULL, p_ip, '{}');
  RETURN jsonb_build_object('ok', true, 'expiresAt', now() + interval '12 hours');
END $$;

CREATE FUNCTION dash_session_live(p_session_sha text, p_touch boolean) RETURNS fleet_admin_sessions LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE s fleet_admin_sessions;
BEGIN
  SELECT * INTO s FROM fleet_admin_sessions WHERE session_sha = p_session_sha AND ended_at IS NULL AND totp_ok AND expires_at > now()
     AND last_seen_at > now() - interval '30 minutes'
     AND EXISTS (SELECT 1 FROM fleet_admin_passkeys k WHERE k.credential_id = fleet_admin_sessions.credential_id AND k.revoked_at IS NULL);
  IF FOUND AND p_touch THEN UPDATE fleet_admin_sessions SET last_seen_at = now() WHERE session_sha = p_session_sha; END IF;
  RETURN s;
END $$;

CREATE FUNCTION dash_session_check(p_session_sha text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE s fleet_admin_sessions := dash_session_live(p_session_sha, false);
BEGIN
  RETURN jsonb_build_object('ok', s.session_sha IS NOT NULL, 'expiresAt', s.expires_at);
END $$;

CREATE FUNCTION dash_session_end(p_session_sha text, p_ip text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  UPDATE fleet_admin_sessions SET ended_at = now() WHERE session_sha = p_session_sha AND ended_at IS NULL;
  IF FOUND THEN PERFORM fleet_admin_auth_log_write('logout', true, NULL, NULL, p_ip, '{}'); END IF;
END $$;

CREATE FUNCTION dash_stepup_record(p_session_sha text, p_stepup_sha text, p_op text, p_args_sha text, p_ip text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE s fleet_admin_sessions := dash_session_live(p_session_sha, true);
BEGIN
  IF s.session_sha IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_SESSION_INVALID'); END IF;
  INSERT INTO fleet_admin_stepups (stepup_sha, session_sha, op, args_sha) VALUES (p_stepup_sha, p_session_sha, p_op, p_args_sha);
  PERFORM fleet_admin_auth_log_write('stepup', true, p_op, NULL, p_ip, '{}');
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE FUNCTION dash_stepup_consume(p_session_sha text, p_stepup_sha text, p_op text, p_args_sha text) RETURNS boolean LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  UPDATE fleet_admin_stepups SET used_at = now()
   WHERE stepup_sha = p_stepup_sha AND session_sha = p_session_sha AND op = p_op AND args_sha = p_args_sha AND used_at IS NULL AND expires_at > now();
  RETURN FOUND;
END $$;

-- ═══ 3. The single Admin gateway ═══
CREATE FUNCTION dash_arg(a jsonb, k text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT a ->> k $$;

CREATE FUNCTION dash_call(p_session_sha text, p_csrf_sha text, p_op text, p_args text, p_stepup_sha text, p_ip text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE s fleet_admin_sessions := dash_session_live(p_session_sha, true); a jsonb; r jsonb; v_args_sha text; v_sensitive boolean; v_write boolean;
        v_code text; v_inst uuid;
BEGIN
  IF s.session_sha IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_SESSION_INVALID'); END IF;
  v_sensitive := p_op IN (${q(DASHBOARD_SENSITIVE_OPS)});
  v_write := v_sensitive OR p_op IN (${q(DASHBOARD_WRITE_OPS)});
  IF NOT (v_write OR p_op IN (${q(DASHBOARD_READ_OPS)})) THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_UNKNOWN_OP'); END IF;
  IF v_write AND (p_csrf_sha IS NULL OR p_csrf_sha <> s.csrf_sha) THEN
    PERFORM fleet_admin_auth_log_write('op', false, p_op, 'FLEET_CSRF', p_ip, '{}');
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CSRF');
  END IF;
  BEGIN a := COALESCE(p_args, '{}')::jsonb; EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END;
  IF jsonb_typeof(a) <> 'object' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  v_args_sha := encode(sha256(convert_to(COALESCE(p_args, '{}'), 'UTF8')), 'hex');
  IF v_sensitive AND NOT dash_stepup_consume(p_session_sha, p_stepup_sha, p_op, v_args_sha) THEN
    PERFORM fleet_admin_auth_log_write('op', false, p_op, 'FLEET_STEPUP_REQUIRED', p_ip, '{}');
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_STEPUP_REQUIRED');
  END IF;
  BEGIN
    r := CASE p_op
      -- reads
      WHEN 'hub' THEN fleet_hub(COALESCE(a ->> 'section', 'overview'), COALESCE(a -> 'args', '{}'::jsonb))
      WHEN 'engine' THEN fleet_hub_engine()
      WHEN 'identity' THEN fleet_hub_identity(a ->> 'agentId')
      WHEN 'comms' THEN fleet_hub_comms(a ->> 'agentId')
      WHEN 'browser' THEN fleet_hub_browser(a ->> 'agentId')
      WHEN 'replication' THEN fleet_admin_replication_status()
      WHEN 'estates' THEN fleet_admin_estates()
      WHEN 'notifications' THEN fleet_admin_notifications(COALESCE((a ->> 'limit')::integer, 50), COALESCE((a ->> 'unacknowledged')::boolean, false))
      WHEN 'daily_report' THEN fleet_daily_report()
      WHEN 'risk' THEN fleet_agent_risk_context(a ->> 'agentId', (a ->> 'amountMinor')::bigint)
      WHEN 'wallet' THEN fleet_agent_wallet(a ->> 'agentId')
      WHEN 'agent_events' THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('at', e.created_at, 'type', e.event_type, 'actor', e.actor, 'detail', e.detail) ORDER BY e.created_at DESC)
          FROM (SELECT * FROM fleet_events WHERE agent_id = a ->> 'agentId' ORDER BY created_at DESC LIMIT 200) e), '[]'::jsonb)
      WHEN 'agents' THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('agentId', x.agent_id, 'name', x.name, 'status', x.status, 'createdAt', x.created_at,
          'cashMinor', fleet_agent_cash(x.agent_id), 'valueMinor', fleet_agent_value(x.agent_id),
          'held', x.operator_hold_at IS NOT NULL,
          'mode', COALESCE((SELECT upper(kind) FROM fleet_agent_missions m WHERE m.agent_id = x.agent_id AND m.status = 'active'), 'NORMAL')) ORDER BY x.created_at)
          FROM fleet_agents x), '[]'::jsonb)
      WHEN 'reveal_log' THEN fleet_admin_reveal_log(200)
      WHEN 'broker_key' THEN fleet_admin_broker_owner_key()
      WHEN 'health' THEN fleet_economy_health()
      WHEN 'withdrawals' THEN fleet_hub_withdrawals((a ->> 'amountMinor')::bigint)
      WHEN 'security' THEN jsonb_build_object(
          'passkeys', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', left(credential_id, 16), 'credentialId', credential_id, 'name', name, 'createdAt', created_at,
              'lastUsedAt', last_used_at, 'revokedAt', revoked_at)) FROM fleet_admin_passkeys), '[]'::jsonb),
          'sessions', COALESCE((SELECT jsonb_agg(jsonb_build_object('current', x.session_sha = p_session_sha, 'ip', x.ip, 'userAgent', x.user_agent, 'createdAt', x.created_at,
              'lastSeenAt', x.last_seen_at, 'expiresAt', x.expires_at) ORDER BY x.created_at DESC)
              FROM fleet_admin_sessions x WHERE x.ended_at IS NULL AND x.totp_ok AND x.expires_at > now()), '[]'::jsonb),
          'authLog', COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.seq DESC) FROM (SELECT * FROM fleet_admin_auth_log ORDER BY seq DESC LIMIT 200) l), '[]'::jsonb))
      -- ordinary writes
      WHEN 'notification_ack' THEN fleet_admin_notification_ack((a ->> 'id')::uuid, ${ACTOR})
      WHEN 'agent_hold' THEN to_jsonb(fleet_agent_hold_set(a ->> 'agentId', COALESCE(a ->> 'reason', 'paused by Admin'), ${ACTOR}))
      WHEN 'agent_release' THEN to_jsonb(fleet_agent_hold_release(a ->> 'agentId', ${ACTOR}))
      WHEN 'mission_assign' THEN fleet_admin_mission_assign(a ->> 'agentId', a ->> 'kind', a ->> 'brief', a -> 'beneficiaries', ${ACTOR})
      WHEN 'mission_end' THEN fleet_admin_mission_end((a ->> 'missionId')::uuid, a ->> 'outcome', ${ACTOR})
      WHEN 'mission_request' THEN fleet_admin_mission_request(a ->> 'kind', a ->> 'brief', a -> 'beneficiaries', ${ACTOR})
      WHEN 'reveal_take' THEN fleet_admin_reveal_take((a ->> 'requestId')::uuid, ${ACTOR})
      -- sensitive (a step-up was consumed above)
      WHEN 'reveal_request' THEN fleet_admin_reveal_request(a ->> 'kind', a ->> 'target', a ->> 'ephemeralPub', 'webauthn:' || left(p_stepup_sha, 32), ${ACTOR})
      WHEN 'owner_vault_upload' THEN fleet_admin_owner_vault_upload(a ->> 'class', decode(a ->> 'sealedB64', 'base64'), a ->> 'contentType', (a ->> 'expiresAt')::timestamptz, ${ACTOR})
      WHEN 'owner_identity_consent_set' THEN fleet_admin_owner_identity_consent_set(ARRAY(SELECT jsonb_array_elements_text(a -> 'purposes')),
          CASE WHEN a ? 'providers' AND jsonb_typeof(a -> 'providers') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(a -> 'providers')) END,
          ARRAY(SELECT jsonb_array_elements_text(a -> 'classes')), a ->> 'statement', ${ACTOR})
      WHEN 'owner_identity_consent_revoke' THEN fleet_admin_owner_identity_consent_revoke((a ->> 'consentId')::uuid, ${ACTOR})
      WHEN 'owner_identity_class_set' THEN fleet_admin_owner_identity_class_set(a ->> 'class', 'ovault:' || (a ->> 'class'), (a ->> 'expiresAt')::timestamptz,
          COALESCE(a ->> 'status', 'configured'), ${ACTOR})
      WHEN 'agent_transfer' THEN fleet_admin_agent_transfer(a ->> 'from', a ->> 'to', (a ->> 'amountMinor')::bigint, a ->> 'reason', ${ACTOR},
          'dash-at:' || left(p_stepup_sha, 40), COALESCE((a ->> 'acknowledge')::boolean, false))
      WHEN 'wallet_transfer' THEN fleet_admin_wallet_transfer(a ->> 'agentId', (a ->> 'amountMinor')::bigint, a ->> 'target', a ->> 'reason', ${ACTOR},
          'dash-wt:' || left(p_stepup_sha, 40), COALESCE((a ->> 'acknowledge')::boolean, false))
      WHEN 'agent_fund' THEN fleet_admin_agent_capital(a ->> 'agentId', (a ->> 'amountMinor')::bigint, COALESCE(a ->> 'mode', 'grant'), ${ACTOR}, a ->> 'reason',
          COALESCE((a ->> 'acknowledge')::boolean, false), 'dash-fund:' || left(p_stepup_sha, 40))
      WHEN 'agent_kill' THEN jsonb_build_object('ok', fleet_mark_dead(a ->> 'agentId', COALESCE(a ->> 'reason', 'killed by Admin'), ${ACTOR}, 'operator'))
      WHEN 'birth' THEN fleet_admin_birth(COALESCE(a ->> 'mission', 'independent'), a ->> 'reason', COALESCE((a ->> 'fundingMinor')::bigint, 0), a ->> 'role', ${ACTOR},
          'dash-birth:' || left(p_stepup_sha, 40))
      WHEN 'reseed' THEN fleet_admin_reseed(a ->> 'deadAgentId', a ->> 'reason', COALESCE((a ->> 'fundingMinor')::bigint, 0), ${ACTOR}, 'dash-reseed:' || left(p_stepup_sha, 40))
      WHEN 'estate_assign' THEN fleet_admin_estate_assign((a ->> 'itemId')::uuid, a ->> 'agentId', ${ACTOR})
      WHEN 'estate_release' THEN fleet_admin_estate_release((a ->> 'itemId')::uuid, a ->> 'reason', ${ACTOR})
      WHEN 'replication_policy' THEN fleet_admin_replication_policy_set(a -> 'patch', ${ACTOR})
      WHEN 'mission_policy' THEN fleet_admin_mission_policy_set(a -> 'patch', ${ACTOR})
      WHEN 'risk_policy' THEN fleet_admin_risk_policy_set(a -> 'patch', ${ACTOR})
      WHEN 'notification_policy' THEN fleet_admin_notification_policy_set((a ->> 'dailyHourUtc')::integer, a ->> 'adminEmail', ${ACTOR})
      WHEN 'genesis_capital' THEN fleet_genesis_set_bootstrap(COALESCE(a ->> 'currency', 'GBP'), (a ->> 'minor')::bigint, ${ACTOR})
      WHEN 'passkey_revoke' THEN dash_passkey_revoke(a ->> 'credentialId', p_ip)
      WHEN 'totp_reset' THEN dash_totp_reset(p_ip)
      WHEN 'session_revoke_all' THEN dash_sessions_revoke_all(p_session_sha, p_ip)
    END;
  EXCEPTION WHEN OTHERS THEN
    v_code := COALESCE(substring(SQLERRM FROM '^(FLEET_[A-Z_]+)'), 'FLEET_OPERATION_FAILED');
    PERFORM fleet_admin_auth_log_write('op', false, p_op, v_code, p_ip, '{}');
    RETURN jsonb_build_object('ok', false, 'code', v_code, 'reason', left(regexp_replace(SQLERRM, '^FLEET_[A-Z_]+:\\s*', ''), 300));
  END;
  -- Owner withdrawal: the step-up passkey assertion IS the strong confirmation (a one-time code is generated and used here).
  IF p_op = 'owner_withdrawal' THEN
    BEGIN
      v_code := encode(sha256(convert_to(gen_random_uuid()::text || clock_timestamp()::text, 'UTF8')), 'hex');
      r := fleet_admin_owner_withdrawal((a ->> 'amountMinor')::bigint, a ->> 'destination', ${ACTOR}, a ->> 'reason', COALESCE((a ->> 'acknowledge')::boolean, false),
             'dash-wd:' || left(p_stepup_sha, 40), encode(sha256(convert_to(v_code, 'UTF8')), 'hex'));
      v_inst := (r ->> 'instructionId')::uuid;
      IF r ->> 'status' = 'pending_confirmation' AND v_inst IS NOT NULL THEN r := r || jsonb_build_object('confirmed', fleet_admin_confirm(v_inst, v_code, ${ACTOR})); END IF;
    EXCEPTION WHEN OTHERS THEN
      v_code := COALESCE(substring(SQLERRM FROM '^(FLEET_[A-Z_]+)'), 'FLEET_OPERATION_FAILED');
      PERFORM fleet_admin_auth_log_write('op', false, p_op, v_code, p_ip, '{}');
      RETURN jsonb_build_object('ok', false, 'code', v_code, 'reason', left(regexp_replace(SQLERRM, '^FLEET_[A-Z_]+:\\s*', ''), 300));
    END;
  END IF;
  IF v_write THEN PERFORM fleet_admin_auth_log_write('op', true, p_op, NULL, p_ip, jsonb_build_object('sensitive', v_sensitive)); END IF;
  RETURN jsonb_build_object('ok', true, 'result', r);
END $$;

CREATE FUNCTION dash_passkey_revoke(p_id text, p_ip text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF (SELECT count(*) FROM fleet_admin_passkeys WHERE revoked_at IS NULL AND credential_id <> p_id) < 1 THEN
    RAISE EXCEPTION 'FLEET_LAST_PASSKEY: register another passkey before revoking the last one';
  END IF;
  UPDATE fleet_admin_passkeys SET revoked_at = now() WHERE credential_id = p_id AND revoked_at IS NULL;
  PERFORM fleet_admin_auth_log_write('passkey_revoked', true, NULL, NULL, p_ip, jsonb_build_object('credentialId', left(p_id, 24)));
  RETURN jsonb_build_object('ok', FOUND);
END $$;

CREATE FUNCTION dash_totp_reset(p_ip text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  DELETE FROM fleet_admin_totp WHERE id = 1;
  PERFORM fleet_admin_auth_log_write('totp_reset', true, NULL, NULL, p_ip, '{}');
  PERFORM fleet_notify('AMBER', 'ADMIN_TOTP_RESET', NULL, 'The Admin TOTP factor was reset: enroll a new one with an enrollment token', '{}'::jsonb, 'totp-reset:' || now());
  RETURN jsonb_build_object('ok', true, 'next', 'run fleet:admin hub-dashboard-enroll to set a new TOTP factor');
END $$;

CREATE FUNCTION dash_sessions_revoke_all(p_keep text, p_ip text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE n integer;
BEGIN
  UPDATE fleet_admin_sessions SET ended_at = now() WHERE ended_at IS NULL AND session_sha <> p_keep;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM fleet_admin_auth_log_write('sessions_revoked', true, NULL, NULL, p_ip, jsonb_build_object('count', n));
  RETURN jsonb_build_object('ok', true, 'revoked', n);
END $$;

-- Owner CLI: a one-time enrollment token for the first passkey + TOTP (or recovery). Owner connection only.
CREATE FUNCTION fleet_admin_dashboard_enroll(p_token_sha text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_dashboard');
  INSERT INTO fleet_admin_enrollment (token_sha, created_by, expires_at) VALUES (p_token_sha, p_actor, now() + interval '15 minutes');
  PERFORM fleet_admin_auth_log_write('enroll_issued', true, NULL, NULL, NULL, jsonb_build_object('by', p_actor));
  RETURN jsonb_build_object('ok', true, 'expiresAt', now() + interval '15 minutes');
END $$;
`;

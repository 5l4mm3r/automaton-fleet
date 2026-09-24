/**
 * Phase B2 migration (schema v8): read-only Operator API.
 *
 * Operator principals are NOT fleet agents: they never occupy slots, own no
 * wallet/custody, have no lifecycle and inherit no agent permission. They
 * authenticate every request with an Ed25519 signature that the Operator API
 * process verifies; PostgreSQL stores public keys only.
 *
 * SIGNATURE-TERMINATION INVARIANT (B2 Amendment 2). PostgreSQL cannot verify
 * Ed25519, so it cannot independently authenticate a signed operator request.
 * Therefore the operator role's entire surface (op_*) MUST stay observational
 * with respect to fleet/business state:
 *   - every op_* function except op_begin_request is STABLE (PostgreSQL
 *     rejects INSERT/UPDATE/DELETE in non-volatile functions);
 *   - op_begin_request writes only operator security/audit bookkeeping
 *     (fleet_operator_nonces, fleet_operator_requests, the bounded
 *     request counter in fleet_operator_state, and denial events in
 *     fleet_events) — Amendment 3;
 *   - routes can only point at the five read functions (CHECK below).
 * A mutating operator capability (e.g. ops.propose) MUST NOT be added by
 * extending these tables/allow-lists; it requires a separate security-design
 * gate that re-evaluates the trust boundary. Enforced by the privilege audit
 * (privileges.ts) and the operator-surface verifier (operator/surface.ts).
 *
 * Retention (D-9, Amendment 1): fleet_operator_requests is append-only and
 * capped at 2,000,000 rows via a counter; at the cap op_begin_request fails
 * closed (FLEET_OP_AUDIT_FULL). Nothing is ever deleted automatically; rows
 * leave only through the owner-only, audited fleet_operator_archive_requests.
 */

export const OPERATOR_REQUEST_CAP = 2_000_000;

export const V8_SQL = `
-- ── Kill switch, generation and bounded audit counter (single row)
CREATE TABLE fleet_operator_state (
  id                    integer     PRIMARY KEY CHECK (id = 1),
  operator_api_enabled  boolean     NOT NULL DEFAULT false,
  generation            bigint      NOT NULL DEFAULT 0 CHECK (generation >= 0),
  request_count         bigint      NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  request_cap           bigint      NOT NULL DEFAULT ${OPERATOR_REQUEST_CAP} CHECK (request_cap = ${OPERATOR_REQUEST_CAP}),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            text        NOT NULL DEFAULT 'migration' CHECK (length(updated_by) BETWEEN 1 AND 128)
);
INSERT INTO fleet_operator_state (id) VALUES (1);

CREATE FUNCTION fleet_operator_state_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF NEW.request_count < OLD.request_count AND COALESCE(current_setting('fleet.operator_archive', true), '') <> 'on' THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: the operator request counter only decreases through audited archival';
  END IF;
  IF NEW.generation < OLD.generation THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: the operator generation never decreases';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_operator_state_guard BEFORE UPDATE ON fleet_operator_state
  FOR EACH ROW EXECUTE FUNCTION fleet_operator_state_guard();
CREATE TRIGGER fleet_operator_state_no_delete BEFORE DELETE ON fleet_operator_state
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_operator_state_no_truncate BEFORE TRUNCATE ON fleet_operator_state
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- ── Principals (never agents) and their Ed25519 public keys
CREATE TABLE fleet_operator_principals (
  principal_id   text        PRIMARY KEY CHECK (principal_id ~ '^op_[0-9A-HJKMNP-TV-Z]{26}$'),
  name           text        NOT NULL UNIQUE CHECK (name ~ '^[a-z][a-z0-9-]{2,40}$'),
  kind           text        NOT NULL CHECK (kind IN ('bridge_claude','bridge_chatgpt')),
  scopes         text[]      NOT NULL CHECK (
                   cardinality(scopes) BETWEEN 1 AND 3
                   AND scopes <@ ARRAY['ops.read.status','ops.read.agents','ops.read.events']::text[]
                   AND array_position(scopes, NULL) IS NULL),
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text        NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  revoked_at     timestamptz,
  revoked_by     text        CHECK (length(revoked_by) <= 128),
  revoke_reason  text        CHECK (length(revoke_reason) <= 200),
  CONSTRAINT fleet_operator_principals_revocation_complete CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CONSTRAINT fleet_operator_principals_chatgpt_no_events CHECK (kind <> 'bridge_chatgpt' OR NOT ('ops.read.events' = ANY (scopes)))
);

CREATE TABLE fleet_operator_keys (
  key_id         text        PRIMARY KEY CHECK (key_id ~ '^[0-9a-f]{32}$'),
  principal_id   text        NOT NULL REFERENCES fleet_operator_principals(principal_id),
  algorithm      text        NOT NULL DEFAULT 'ed25519' CHECK (algorithm = 'ed25519'),
  public_key     bytea       NOT NULL UNIQUE CHECK (octet_length(public_key) = 32),
  not_before     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text        NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  revoked_at     timestamptz,
  revoked_by     text        CHECK (length(revoked_by) <= 128),
  revoke_reason  text        CHECK (length(revoke_reason) <= 200),
  CONSTRAINT fleet_operator_keys_id_is_fingerprint CHECK (key_id = left(encode(sha256(public_key), 'hex'), 32)),
  CONSTRAINT fleet_operator_keys_validity CHECK (expires_at > not_before AND expires_at <= not_before + interval '90 days'),
  CONSTRAINT fleet_operator_keys_revocation_complete CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX fleet_operator_keys_principal_idx ON fleet_operator_keys (principal_id) WHERE revoked_at IS NULL;

-- Identity fields are immutable; revocation is set once and never cleared.
CREATE FUNCTION fleet_operator_principals_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (SELECT count(DISTINCT s) FROM unnest(NEW.scopes) s) <> cardinality(NEW.scopes) THEN
      RAISE EXCEPTION 'FLEET_OPERATOR_INVALID: duplicate scopes';
    END IF;
    IF NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'FLEET_OPERATOR_INVALID: a principal cannot be created revoked';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.principal_id IS DISTINCT FROM OLD.principal_id OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.scopes IS DISTINCT FROM OLD.scopes
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: operator principal identity cannot change';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by
     OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason) THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: operator revocation is final';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_operator_principals_guard BEFORE INSERT OR UPDATE ON fleet_operator_principals
  FOR EACH ROW EXECUTE FUNCTION fleet_operator_principals_guard();
CREATE TRIGGER fleet_operator_principals_no_delete BEFORE DELETE ON fleet_operator_principals
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_operator_principals_no_truncate BEFORE TRUNCATE ON fleet_operator_principals
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION fleet_operator_keys_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'FLEET_OPERATOR_INVALID: a key cannot be created revoked';
    END IF;
    -- Lock the principal first, then test revocation on the locked row, so a
    -- concurrent revocation cannot be missed.
    PERFORM 1 FROM fleet_operator_principals WHERE principal_id = NEW.principal_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM fleet_operator_principals WHERE principal_id = NEW.principal_id AND revoked_at IS NOT NULL) THEN
      RAISE EXCEPTION 'FLEET_OPERATOR_INVALID: principal % is revoked', NEW.principal_id;
    END IF;
    IF (SELECT count(*) FROM fleet_operator_keys WHERE principal_id = NEW.principal_id AND revoked_at IS NULL) >= 2 THEN
      RAISE EXCEPTION 'FLEET_OPERATOR_INVALID: principal % already has 2 active keys (revoke one first)', NEW.principal_id;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.key_id IS DISTINCT FROM OLD.key_id OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR NEW.algorithm IS DISTINCT FROM OLD.algorithm OR NEW.public_key IS DISTINCT FROM OLD.public_key
     OR NEW.not_before IS DISTINCT FROM OLD.not_before OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: operator key material cannot change';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by
     OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason) THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: operator key revocation is final';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_operator_keys_guard BEFORE INSERT OR UPDATE ON fleet_operator_keys
  FOR EACH ROW EXECUTE FUNCTION fleet_operator_keys_guard();
CREATE TRIGGER fleet_operator_keys_no_delete BEFORE DELETE ON fleet_operator_keys
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_operator_keys_no_truncate BEFORE TRUNCATE ON fleet_operator_keys
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- ── Replay ledger (hashed nonces; purged only after expiry)
CREATE TABLE fleet_operator_nonces (
  principal_id  text        NOT NULL REFERENCES fleet_operator_principals(principal_id),
  nonce_sha256  text        NOT NULL CHECK (nonce_sha256 ~ '^[0-9a-f]{64}$'),
  expires_at    timestamptz NOT NULL,
  PRIMARY KEY (principal_id, nonce_sha256)
);
CREATE INDEX fleet_operator_nonces_expiry_idx ON fleet_operator_nonces (expires_at);
CREATE TRIGGER fleet_operator_nonces_no_truncate BEFORE TRUNCATE ON fleet_operator_nonces
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- ── Route -> scope -> function map. Routes can only point at the read functions.
CREATE TABLE fleet_operator_routes (
  route  text   PRIMARY KEY CHECK (route ~ '^GET /v1/operator/[a-z0-9_/{}-]+$'),
  scope  text   CHECK (scope IS NULL OR scope IN ('ops.read.status','ops.read.agents','ops.read.events')),
  fn     text   NOT NULL UNIQUE CHECK (fn IN ('op_whoami','op_fleet_status','op_list_agents','op_get_agent','op_list_events')),
  kinds  text[] NOT NULL CHECK (cardinality(kinds) BETWEEN 1 AND 2
                                AND kinds <@ ARRAY['bridge_claude','bridge_chatgpt']::text[])
);
INSERT INTO fleet_operator_routes (route, scope, fn, kinds) VALUES
  ('GET /v1/operator/whoami',            NULL,              'op_whoami',       ARRAY['bridge_claude','bridge_chatgpt']),
  ('GET /v1/operator/status',            'ops.read.status', 'op_fleet_status', ARRAY['bridge_claude','bridge_chatgpt']),
  ('GET /v1/operator/agents',            'ops.read.agents', 'op_list_agents',  ARRAY['bridge_claude','bridge_chatgpt']),
  ('GET /v1/operator/agents/{agent_id}', 'ops.read.agents', 'op_get_agent',    ARRAY['bridge_claude','bridge_chatgpt']),
  ('GET /v1/operator/events',            'ops.read.events', 'op_list_events',  ARRAY['bridge_claude']);
CREATE TRIGGER fleet_operator_routes_no_change BEFORE UPDATE OR DELETE ON fleet_operator_routes
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_operator_routes_no_truncate BEFORE TRUNCATE ON fleet_operator_routes
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- ── Accepted-request audit (append-only; hashes only)
CREATE TABLE fleet_operator_requests (
  request_id    uuid        PRIMARY KEY,
  principal_id  text        NOT NULL REFERENCES fleet_operator_principals(principal_id),
  key_id        text        NOT NULL REFERENCES fleet_operator_keys(key_id),
  route         text        NOT NULL REFERENCES fleet_operator_routes(route),
  scope         text,
  client_ts     timestamptz NOT NULL,
  nonce_sha256  text        NOT NULL CHECK (nonce_sha256 ~ '^[0-9a-f]{64}$'),
  body_sha256   text        NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  received_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_operator_requests_principal_idx ON fleet_operator_requests (principal_id, received_at);
CREATE INDEX fleet_operator_requests_received_idx ON fleet_operator_requests (received_at);

-- UPDATE is never allowed; DELETE only inside the audited archival function.
CREATE FUNCTION fleet_operator_requests_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' AND COALESCE(current_setting('fleet.operator_archive', true), '') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: % on fleet_operator_requests is not allowed (archive with fleet:admin operator-archive)', TG_OP;
END $$;
CREATE TRIGGER fleet_operator_requests_guard BEFORE UPDATE OR DELETE ON fleet_operator_requests
  FOR EACH ROW EXECUTE FUNCTION fleet_operator_requests_guard();
CREATE TRIGGER fleet_operator_requests_no_truncate BEFORE TRUNCATE ON fleet_operator_requests
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- ── Owner-only, audited archival (never granted; never automatic).
-- Rows leave in bounded batches (<= 100000) and only after a verified export:
--   1. the CLI reads canonical lines from fleet_operator_archive_export,
--      writes them to a new 0600 file, reads the file back and checks its
--      SHA-256, size and line count;
--   2. fleet_operator_archive_requests re-selects the same rows (locked),
--      recomputes the digest of their canonical lines and deletes them only if
--      the row count AND the digest equal what the CLI exported.
-- Any mismatch or error raises, so the transaction leaves every row intact.
CREATE FUNCTION fleet_operator_request_line(r fleet_operator_requests) RETURNS text LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'requestId', r.request_id, 'principalId', r.principal_id, 'keyId', r.key_id, 'route', r.route,
    'scope', r.scope,
    'clientTs', to_char(r.client_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'nonceSha256', r.nonce_sha256, 'bodySha256', r.body_sha256,
    'receivedAt', to_char(r.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text
$$;

CREATE FUNCTION fleet_operator_archive_check(p_before timestamptz, p_rows bigint) RETURNS void LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_before IS NULL OR p_before > now() - interval '1 minute' THEN
    RAISE EXCEPTION 'FLEET_OPERATOR_INVALID: archival cutoff must be at least one minute in the past';
  END IF;
  IF p_rows IS NULL OR p_rows < 1 OR p_rows > 100000 THEN
    RAISE EXCEPTION 'FLEET_OPERATOR_INVALID: archival batch must be 1..100000 rows';
  END IF;
END $$;

CREATE FUNCTION fleet_operator_archive_export(p_before timestamptz, p_max_rows integer)
RETURNS TABLE (line text) LANGUAGE plpgsql STABLE SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM fleet_operator_archive_check(p_before, p_max_rows);
  RETURN QUERY SELECT fleet_operator_request_line(r) FROM fleet_operator_requests r
    WHERE r.received_at < p_before ORDER BY r.received_at, r.request_id LIMIT p_max_rows;
END $$;

CREATE FUNCTION fleet_operator_archive_requests(p_before timestamptz, p_expected_rows bigint, p_export_sha256 text, p_actor text)
RETURNS bigint LANGUAGE plpgsql SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE
  v_ids uuid[];
  v_n bigint;
  v_sha text;
  v_deleted bigint;
  v_remaining bigint;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN
    RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: archival requires an operator actor';
  END IF;
  IF p_export_sha256 IS NULL OR p_export_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'FLEET_OPERATOR_INVALID: export digest required';
  END IF;
  PERFORM fleet_operator_archive_check(p_before, p_expected_rows);
  PERFORM 1 FROM fleet_operator_state WHERE id = 1 FOR UPDATE;
  SELECT array_agg(s.request_id ORDER BY s.received_at, s.request_id),
         count(*),
         encode(sha256(convert_to(COALESCE(string_agg(s.line || E'\n', '' ORDER BY s.received_at, s.request_id), ''), 'UTF8')), 'hex')
    INTO v_ids, v_n, v_sha
    FROM (SELECT r.request_id, r.received_at, fleet_operator_request_line(r) AS line
            FROM fleet_operator_requests r
           WHERE r.received_at < p_before
           ORDER BY r.received_at, r.request_id
           LIMIT p_expected_rows
             FOR UPDATE) s;
  IF v_n <> p_expected_rows THEN
    RAISE EXCEPTION 'FLEET_OPERATOR_INVALID: archival matched % rows, export had %', v_n, p_expected_rows;
  END IF;
  IF v_sha <> p_export_sha256 THEN
    RAISE EXCEPTION 'FLEET_OPERATOR_INVALID: archival digest does not match the export';
  END IF;
  PERFORM set_config('fleet.operator_archive', 'on', true);
  DELETE FROM fleet_operator_requests WHERE request_id = ANY (v_ids);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> v_n THEN
    RAISE EXCEPTION 'FLEET_OPERATOR_INVALID: archival deleted % rows, expected %', v_deleted, v_n;
  END IF;
  UPDATE fleet_operator_state SET request_count = GREATEST(request_count - v_n, 0), updated_at = now(), updated_by = p_actor WHERE id = 1;
  PERFORM set_config('fleet.operator_archive', 'off', true);
  SELECT count(*) INTO v_remaining FROM fleet_operator_requests WHERE received_at < p_before;
  PERFORM fleet_event('operator_requests_archived', NULL, p_actor,
    jsonb_build_object('before', p_before, 'rows', v_n, 'remaining', v_remaining, 'exportSha256', p_export_sha256));
  RETURN v_n;
END $$;

-- ── Approver rule: operator principals can never approve anything.
CREATE OR REPLACE FUNCTION fleet_require_operator_approver(p_approver text, p_subject text) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_approver IS NULL OR length(trim(p_approver)) = 0 THEN
    RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: an operator approver is required';
  END IF;
  IF p_approver = p_subject OR EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = p_approver OR lower(wallet_address) = lower(p_approver)) THEN
    RAISE EXCEPTION 'FLEET_SELF_APPROVAL: agents cannot approve capital exceptions (approver %)', p_approver;
  END IF;
  IF p_approver ~* '^op[:_]' OR EXISTS (SELECT 1 FROM fleet_operator_principals WHERE principal_id = p_approver OR name = p_approver) THEN
    RAISE EXCEPTION 'FLEET_SELF_APPROVAL: operator API principals can never approve (approver %)', p_approver;
  END IF;
END $$;

-- ── Read-surface helper (owner-only, never granted): validates a request id
-- for exactly one read function. STABLE: it cannot write.
CREATE FUNCTION fleet_operator_request_ok(p_request uuid, p_fn text) RETURNS fleet_operator_requests LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_operator_requests;
BEGIN
  SELECT q.* INTO r FROM fleet_operator_requests q
    JOIN fleet_operator_routes rt ON rt.route = q.route AND rt.fn = p_fn
    JOIN fleet_operator_principals p ON p.principal_id = q.principal_id AND p.revoked_at IS NULL
    JOIN fleet_operator_keys k ON k.key_id = q.key_id AND k.revoked_at IS NULL AND now() < k.expires_at
    JOIN fleet_operator_state s ON s.id = 1 AND s.operator_api_enabled
   WHERE q.request_id = p_request AND q.received_at > now() - interval '30 seconds'
     AND (rt.scope IS NULL OR rt.scope = ANY (p.scopes)) AND p.kind = ANY (rt.kinds);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FLEET_OP_REQUEST_INVALID';
  END IF;
  RETURN r;
END $$;

-- ── op_begin_request: the ONLY volatile operator function. Writes are
-- restricted to security/audit bookkeeping (Amendment 3).
CREATE FUNCTION op_begin_request(p_principal text, p_key text, p_route text, p_client_ts_ms bigint, p_nonce text, p_body_sha256 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE
  st fleet_operator_state; pr fleet_operator_principals; k fleet_operator_keys; rt fleet_operator_routes;
  v_actor text; v_route text; v_ts timestamptz; v_nh text; v_ins integer; v_id uuid; v_code text; v_type text;
BEGIN
  v_actor := CASE WHEN p_principal ~ '^op_[0-9A-HJKMNP-TV-Z]{26}$' THEN 'op:' || p_principal ELSE 'op:invalid' END;
  SELECT * INTO rt FROM fleet_operator_routes WHERE route = p_route;
  v_route := CASE WHEN FOUND THEN rt.route ELSE 'unknown' END;

  IF p_principal IS NULL OR p_principal !~ '^op_[0-9A-HJKMNP-TV-Z]{26}$' OR p_key IS NULL OR p_key !~ '^[0-9a-f]{32}$'
     OR p_nonce IS NULL OR p_nonce !~ '^[A-Za-z0-9_-]{22,64}$' OR p_body_sha256 IS NULL OR p_body_sha256 !~ '^[0-9a-f]{64}$'
     OR p_client_ts_ms IS NULL OR p_client_ts_ms < 1000000000000 OR p_client_ts_ms > 9999999999999 THEN
    v_code := 'FLEET_OP_BAD_REQUEST'; v_type := 'operator_bad_request';
  ELSIF v_route = 'unknown' THEN
    v_code := 'FLEET_OP_NOT_FOUND'; v_type := 'operator_bad_request';
  END IF;

  IF v_code IS NULL THEN
    SELECT * INTO st FROM fleet_operator_state WHERE id = 1 FOR UPDATE;
    IF NOT FOUND OR NOT st.operator_api_enabled THEN
      v_code := 'FLEET_OP_DISABLED'; v_type := 'operator_disabled';
    ELSIF st.request_count >= st.request_cap THEN
      v_code := 'FLEET_OP_AUDIT_FULL'; v_type := 'operator_audit_full';
    END IF;
  END IF;

  IF v_code IS NULL THEN
    SELECT * INTO pr FROM fleet_operator_principals WHERE principal_id = p_principal;
    IF NOT FOUND OR pr.revoked_at IS NOT NULL THEN
      v_code := 'FLEET_OP_AUTH_FAILED'; v_type := 'operator_auth_failed';
    ELSE
      SELECT * INTO k FROM fleet_operator_keys WHERE key_id = p_key AND principal_id = p_principal;
      IF NOT FOUND OR k.revoked_at IS NOT NULL OR now() < k.not_before OR now() >= k.expires_at THEN
        v_code := 'FLEET_OP_AUTH_FAILED'; v_type := 'operator_auth_failed';
      ELSIF NOT (pr.kind = ANY (rt.kinds)) OR (rt.scope IS NOT NULL AND NOT (rt.scope = ANY (pr.scopes))) THEN
        v_code := 'FLEET_OP_SCOPE_DENIED'; v_type := 'operator_scope_denied';
      END IF;
    END IF;
  END IF;

  IF v_code IS NULL THEN
    v_ts := to_timestamp(p_client_ts_ms / 1000.0);
    IF abs(extract(epoch FROM (now() - v_ts))) > 30 THEN
      v_code := 'FLEET_OP_STALE'; v_type := 'operator_stale';
    END IF;
  END IF;

  IF v_code IS NULL THEN
    v_nh := encode(sha256(convert_to(p_nonce, 'UTF8')), 'hex');
    INSERT INTO fleet_operator_nonces (principal_id, nonce_sha256, expires_at)
      VALUES (p_principal, v_nh, v_ts + interval '60 seconds') ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_ins = ROW_COUNT;
    IF v_ins = 0 THEN
      v_code := 'FLEET_OP_REPLAYED'; v_type := 'operator_replay_blocked';
    END IF;
  END IF;

  IF v_code IS NOT NULL THEN
    -- Bounded: at most 60 database-layer denial events per rolling minute
    -- (checked over the newest 1000 events via the primary key), so a holder
    -- of the operator login cannot flood fleet_events. The denial itself
    -- always stands.
    IF (SELECT count(*) FROM fleet_events e
         WHERE e.id > (SELECT COALESCE(max(id), 0) FROM fleet_events) - 1000
           AND e.actor LIKE 'op:%' AND e.created_at > now() - interval '1 minute') < 60 THEN
      PERFORM fleet_event(v_type, NULL, v_actor, jsonb_build_object('code', v_code, 'route', v_route, 'layer', 'database'));
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', v_code);
  END IF;

  v_id := gen_random_uuid();
  INSERT INTO fleet_operator_requests (request_id, principal_id, key_id, route, scope, client_ts, nonce_sha256, body_sha256)
    VALUES (v_id, p_principal, p_key, rt.route, rt.scope, v_ts, v_nh, p_body_sha256);
  UPDATE fleet_operator_state SET request_count = request_count + 1 WHERE id = 1;
  DELETE FROM fleet_operator_nonces WHERE ctid IN (SELECT ctid FROM fleet_operator_nonces WHERE expires_at < now() LIMIT 1000);
  RETURN jsonb_build_object('ok', true, 'requestId', v_id, 'fn', rt.fn, 'requestCount', st.request_count + 1, 'requestCap', st.request_cap);
END $$;

-- ── Key material for signature verification (public keys only). STABLE.
CREATE FUNCTION op_key_material(p_principal text, p_key text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE pr fleet_operator_principals; k fleet_operator_keys;
BEGIN
  IF p_principal IS NULL OR p_principal !~ '^op_[0-9A-HJKMNP-TV-Z]{26}$' OR p_key IS NULL OR p_key !~ '^[0-9a-f]{32}$' THEN
    RETURN jsonb_build_object('ok', false);
  END IF;
  SELECT * INTO pr FROM fleet_operator_principals WHERE principal_id = p_principal;
  SELECT * INTO k FROM fleet_operator_keys WHERE key_id = p_key AND principal_id = p_principal;
  IF pr.principal_id IS NULL OR k.key_id IS NULL OR pr.revoked_at IS NOT NULL OR k.revoked_at IS NOT NULL
     OR now() < k.not_before OR now() >= k.expires_at THEN
    RETURN jsonb_build_object('ok', false);
  END IF;
  RETURN jsonb_build_object('ok', true, 'publicKey', encode(k.public_key, 'base64'), 'kind', pr.kind,
    'scopes', to_jsonb(pr.scopes), 'expiresAt', k.expires_at);
END $$;

-- ── Readiness + startup identity check (no authentication; kill switch, counter and
-- approved runtime identity only; callable by the operator process alone). STABLE.
CREATE FUNCTION op_ping() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('schemaVersion', (SELECT max(version) FROM fleet_schema_migrations),
    'operatorApiEnabled', s.operator_api_enabled, 'generation', s.generation,
    'requestCount', s.request_count, 'requestCap', s.request_cap, 'dbTime', now(),
    'runtimeRepo', f.runtime_repo, 'runtimeCommit', f.runtime_commit, 'runtimeBuildId', f.runtime_build_id,
    'runtimeLockfileSha256', f.runtime_lockfile_sha256)
    FROM fleet_operator_state s CROSS JOIN fleet_state f WHERE s.id = 1 AND f.id = 1
$$;

-- ── Read functions: STABLE; each accepts only a fresh request id for itself.
CREATE FUNCTION op_whoami(p_request uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_operator_requests; pr fleet_operator_principals; k fleet_operator_keys;
BEGIN
  r := fleet_operator_request_ok(p_request, 'op_whoami');
  SELECT * INTO pr FROM fleet_operator_principals WHERE principal_id = r.principal_id;
  SELECT * INTO k FROM fleet_operator_keys WHERE key_id = r.key_id;
  RETURN jsonb_build_object('principal', jsonb_build_object('id', pr.principal_id, 'name', pr.name, 'kind', pr.kind,
      'scopes', to_jsonb(ARRAY(SELECT s FROM unnest(pr.scopes) s ORDER BY s))),
    'key', jsonb_build_object('id', k.key_id, 'expiresAt', k.expires_at));
END $$;

CREATE FUNCTION op_fleet_status(p_request uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_operator_requests; s fleet_state; o fleet_operator_state;
BEGIN
  r := fleet_operator_request_ok(p_request, 'op_fleet_status');
  SELECT * INTO s FROM fleet_state WHERE id = 1;
  SELECT * INTO o FROM fleet_operator_state WHERE id = 1;
  RETURN jsonb_build_object(
    'fleet', jsonb_build_object('maxAgents', s.max_agents, 'living', s.living_agents, 'reserved', s.reserved_slots,
      'quarantined', s.quarantined_slots, 'mode', s.operating_mode, 'replicationEnabled', s.replication_enabled),
    'runtime', jsonb_build_object('repo', s.runtime_repo, 'commit', s.runtime_commit, 'buildId', s.runtime_build_id,
      'lockfileSha256', s.runtime_lockfile_sha256),
    'schema', jsonb_build_object('version', (SELECT max(version) FROM fleet_schema_migrations)),
    'operatorApi', jsonb_build_object('enabled', o.operator_api_enabled, 'requestCount', o.request_count, 'requestCap', o.request_cap));
END $$;

CREATE FUNCTION fleet_operator_agent_json(a fleet_agents) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('agentId', a.agent_id, 'role', a.role, 'generation', a.generation,
    'parentAgentId', a.parent_agent_id, 'status', a.status, 'capabilityScope', a.capability_scope, 'dryRun', a.dry_run,
    'runtimeCommit', a.runtime_commit, 'createdAt', a.created_at, 'lastHeartbeat', a.last_heartbeat,
    'deathTime', a.death_time, 'name', a.name)
$$;

CREATE FUNCTION op_list_agents(p_request uuid, p_after text, p_limit integer) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_operator_requests; v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
BEGIN
  r := fleet_operator_request_ok(p_request, 'op_list_agents');
  RETURN jsonb_build_object('items', COALESCE((
    SELECT jsonb_agg(fleet_operator_agent_json(a) ORDER BY a.agent_id)
      FROM (SELECT * FROM fleet_agents WHERE p_after IS NULL OR agent_id > p_after ORDER BY agent_id LIMIT v_limit + 1) a
  ), '[]'::jsonb), 'limit', v_limit);
END $$;

CREATE FUNCTION op_get_agent(p_request uuid, p_agent text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_operator_requests; a fleet_agents;
BEGIN
  r := fleet_operator_request_ok(p_request, 'op_get_agent');
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;
  RETURN jsonb_build_object('found', true, 'item', fleet_operator_agent_json(a));
END $$;

CREATE FUNCTION op_list_events(p_request uuid, p_after bigint, p_limit integer, p_type text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_operator_requests; v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
BEGIN
  r := fleet_operator_request_ok(p_request, 'op_list_events');
  RETURN jsonb_build_object('items', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id', e.id::text, 'type', e.event_type, 'agentId', e.agent_id, 'actor', e.actor,
             'createdAt', e.created_at, 'detail', e.detail) ORDER BY e.id)
      FROM (SELECT * FROM fleet_events WHERE (p_after IS NULL OR id > p_after) AND (p_type IS NULL OR event_type = p_type)
             ORDER BY id LIMIT v_limit + 1) e
  ), '[]'::jsonb), 'limit', v_limit);
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

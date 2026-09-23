/**
 * Phase 5 migrations (schema v4 + v5). Applied by migrations.ts.
 *
 * V4 — lifecycle enforcement and the remote control plane:
 *   - agent lifecycle adds TERMINATING and ORPHANED; ORPHANED holds a
 *     quarantine slot (fleet_state.quarantined_slots) that counts against the
 *     cap until the orphan is resolved or the documented hold expires
 *   - fleet_provisioning: every claimed reservation is tracked from before
 *     the sandbox exists, through VERIFYING, to ACTIVE / FAILED_PROVISIONING /
 *     ORPHANED, with a cleanup status
 *   - health: controller challenge/response (short-lived nonces), health
 *     grace, termination eligibility — heartbeats alone never keep a slot
 *   - leaving the living population always revokes credentials, sessions and
 *     wallet spending authority (trigger; no code path can forget it)
 *   - fleet_orphans: audit of external infrastructure that could not be stopped
 *   - short-lived per-agent sessions and a request-nonce ledger (replay protection)
 *   - wallet custody records (controller-supervised; spending freeze)
 *
 * V5 — fleet treasury economics (see src/fleet/treasury/): ledgers,
 * obligations, capital allocations, sweep reductions, treasury ledger,
 * sweep plans, owner distributions, custody transfers, spend requests.
 * All money movements are RECORDED/PLANNED only; nothing here executes a
 * transfer (REAL_PAYMENTS_ENABLED / OWNER_SWEEP_ENABLED stay false).
 */

export function v4Sql(hardMax: number): string {
  return `
-- ── Lifecycle statuses
ALTER TABLE fleet_agents DROP CONSTRAINT fleet_agents_status_check;
ALTER TABLE fleet_agents ADD CONSTRAINT fleet_agents_status_check
  CHECK (status IN ('reserved','provisioning','active','unresponsive','terminating','orphaned','dead','failed'));
DROP INDEX fleet_agents_sandbox_live_uq;
CREATE UNIQUE INDEX fleet_agents_sandbox_live_uq ON fleet_agents (sandbox_id)
  WHERE sandbox_id IS NOT NULL AND status IN ('reserved','provisioning','active','unresponsive','terminating','orphaned');
ALTER TABLE fleet_agents
  ADD COLUMN activated_at        timestamptz,
  ADD COLUMN last_challenge_ok_at timestamptz,
  ADD COLUMN challenge_failures  integer NOT NULL DEFAULT 0 CHECK (challenge_failures >= 0),
  ADD COLUMN unresponsive_since  timestamptz,
  ADD COLUMN health_reason       text,
  ADD COLUMN quarantined_at      timestamptz;
UPDATE fleet_agents SET activated_at = COALESCE(last_heartbeat, updated_at) WHERE status IN ('active','unresponsive');
UPDATE fleet_agents SET unresponsive_since = updated_at WHERE status = 'unresponsive';

ALTER TABLE fleet_state
  ADD COLUMN quarantined_slots           integer NOT NULL DEFAULT 0 CHECK (quarantined_slots >= 0),
  ADD COLUMN health_challenge_interval_s integer NOT NULL DEFAULT 60     CHECK (health_challenge_interval_s BETWEEN 1 AND 86400),
  ADD COLUMN challenge_ttl_s             integer NOT NULL DEFAULT 60     CHECK (challenge_ttl_s BETWEEN 5 AND 3600),
  ADD COLUMN health_grace_s              integer NOT NULL DEFAULT 300    CHECK (health_grace_s BETWEEN 10 AND 86400),
  ADD COLUMN max_challenge_failures      integer NOT NULL DEFAULT 3      CHECK (max_challenge_failures BETWEEN 1 AND 100),
  ADD COLUMN termination_grace_s         integer NOT NULL DEFAULT 480    CHECK (termination_grace_s BETWEEN 1 AND 604800),
  ADD COLUMN orphan_slot_hold_s          integer NOT NULL DEFAULT 259200 CHECK (orphan_slot_hold_s >= 0),
  ADD COLUMN max_open_orphans            integer NOT NULL DEFAULT 1      CHECK (max_open_orphans >= 0),
  ADD COLUMN session_ttl_s               integer NOT NULL DEFAULT 600    CHECK (session_ttl_s BETWEEN 30 AND 3600),
  ADD CONSTRAINT fleet_state_population CHECK (living_agents + reserved_slots + quarantined_slots <= ${hardMax});

-- living: active, unresponsive, terminating (still being stopped); quarantined: orphaned.
CREATE OR REPLACE FUNCTION fleet_bucket(s text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN s IN ('reserved','provisioning') THEN 'reserved'
              WHEN s IN ('active','unresponsive','terminating') THEN 'living'
              WHEN s = 'orphaned' THEN 'quarantined'
              ELSE NULL END
$$;

CREATE OR REPLACE FUNCTION fleet_agents_counters() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE
  old_b text := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE fleet_bucket(OLD.status) END;
  new_b text := fleet_bucket(NEW.status);
  st fleet_state%ROWTYPE;
BEGIN
  IF old_b IS NOT DISTINCT FROM new_b THEN
    RETURN NEW;
  END IF;
  UPDATE fleet_state SET
    living_agents     = living_agents + (CASE WHEN new_b = 'living' THEN 1 ELSE 0 END) - (CASE WHEN old_b = 'living' THEN 1 ELSE 0 END),
    reserved_slots    = reserved_slots + (CASE WHEN new_b = 'reserved' THEN 1 ELSE 0 END) - (CASE WHEN old_b = 'reserved' THEN 1 ELSE 0 END),
    quarantined_slots = quarantined_slots + (CASE WHEN new_b = 'quarantined' THEN 1 ELSE 0 END) - (CASE WHEN old_b = 'quarantined' THEN 1 ELSE 0 END),
    updated_at = now()
  WHERE id = 1
  RETURNING * INTO st;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FLEET_CAP_EXCEEDED: fleet_state missing (fail closed)';
  END IF;
  IF old_b IS NULL AND new_b IS NOT NULL
     AND st.living_agents + st.reserved_slots + st.quarantined_slots > st.max_agents THEN
    RAISE EXCEPTION 'FLEET_CAP_EXCEEDED: % living + % reserved + % quarantined > max %',
      st.living_agents, st.reserved_slots, st.quarantined_slots, st.max_agents;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION fleet_state_counter_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() = 1 AND (NEW.living_agents <> OLD.living_agents OR NEW.reserved_slots <> OLD.reserved_slots
                                 OR NEW.quarantined_slots <> OLD.quarantined_slots) THEN
    RAISE EXCEPTION 'FLEET_COUNTERS_READ_ONLY: living_agents/reserved_slots/quarantined_slots are derived from fleet_agents';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION fleet_agents_transition_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('reserved','active') THEN
      RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: cannot insert agent in status %', NEW.status;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.agent_id <> NEW.agent_id OR OLD.role <> NEW.role OR OLD.generation <> NEW.generation
     OR OLD.parent_agent_id IS DISTINCT FROM NEW.parent_agent_id
     OR OLD.created_at <> NEW.created_at THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: identity columns cannot change';
  END IF;
  IF OLD.wallet_address IS NOT NULL AND OLD.wallet_address IS DISTINCT FROM NEW.wallet_address THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: wallet_address cannot change once set';
  END IF;
  IF OLD.runtime_commit IS NOT NULL AND OLD.runtime_commit IS DISTINCT FROM NEW.runtime_commit AND OLD.role = 'child' THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: child runtime_commit cannot change';
  END IF;
  IF OLD.status = NEW.status THEN
    IF OLD.status IN ('dead','failed') AND OLD.death_time IS DISTINCT FROM NEW.death_time THEN
      RAISE EXCEPTION 'FLEET_TERMINAL_STATE_IMMUTABLE';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('dead','failed') THEN
    RAISE EXCEPTION 'FLEET_TERMINAL_STATE_IMMUTABLE: agent % is %', OLD.agent_id, OLD.status;
  END IF;
  IF NOT (
       (OLD.status = 'reserved'     AND NEW.status IN ('provisioning','failed'))
    OR (OLD.status = 'provisioning' AND NEW.status IN ('active','failed'))
    OR (OLD.status = 'active'       AND NEW.status IN ('unresponsive','terminating','dead'))
    OR (OLD.status = 'unresponsive' AND NEW.status IN ('active','terminating','dead'))
    OR (OLD.status = 'terminating'  AND NEW.status IN ('orphaned','dead'))
    OR (OLD.status = 'orphaned'     AND NEW.status = 'dead')
  ) THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;

-- Lifecycle timestamps, maintained whatever path changes the status.
CREATE FUNCTION fleet_agents_lifecycle_stamps() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'active' AND (TG_OP = 'INSERT' OR OLD.status IN ('reserved','provisioning')) THEN
    NEW.activated_at := COALESCE(NEW.activated_at, now());
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'unresponsive' THEN NEW.unresponsive_since := now(); END IF;
    IF NEW.status = 'active' THEN NEW.unresponsive_since := NULL; END IF;
    IF NEW.status IN ('terminating','orphaned') THEN NEW.quarantined_at := COALESCE(NEW.quarantined_at, now()); END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_agents_lifecycle_stamps BEFORE INSERT OR UPDATE OF status ON fleet_agents
  FOR EACH ROW EXECUTE FUNCTION fleet_agents_lifecycle_stamps();

-- ── Sessions (short-lived, per-agent, hash only) and replay nonces
CREATE TABLE fleet_agent_sessions (
  session_hash text        PRIMARY KEY CHECK (session_hash ~ '^[0-9a-f]{64}$'),
  agent_id     text        NOT NULL REFERENCES fleet_agents(agent_id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX fleet_agent_sessions_agent_idx ON fleet_agent_sessions (agent_id, expires_at);

CREATE TABLE fleet_request_nonces (
  agent_id   text        NOT NULL,
  nonce      text        NOT NULL CHECK (nonce ~ '^[A-Za-z0-9_-]{16,64}$'),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (agent_id, nonce)
);

-- ── Wallet custody: the controller supervises every agent wallet
CREATE TABLE fleet_wallet_custody (
  agent_id          text        PRIMARY KEY REFERENCES fleet_agents(agent_id),
  wallet_address    text        NOT NULL,
  custody_mode      text        NOT NULL DEFAULT 'controller_supervised'
                                CHECK (custody_mode IN ('controller_supervised','controller_signer')),
  spending_frozen   boolean     NOT NULL DEFAULT false,
  frozen_reason     text,
  frozen_at         timestamptz,
  daily_limit_cents bigint      NOT NULL DEFAULT 0 CHECK (daily_limit_cents >= 0),
  supervisor        text        NOT NULL DEFAULT 'fleetadmin',
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX fleet_wallet_custody_wallet_uq ON fleet_wallet_custody (lower(wallet_address));

-- ── Provisioning records: tracked from claim, before any sandbox exists
CREATE TABLE fleet_provisioning (
  provisioning_id         text        PRIMARY KEY CHECK (provisioning_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  reservation_id          text        NOT NULL UNIQUE REFERENCES fleet_reservations(reservation_id),
  parent_agent_id         text        NOT NULL REFERENCES fleet_agents(agent_id),
  expected_agent_id       text        NOT NULL UNIQUE REFERENCES fleet_agents(agent_id),
  expected_runtime_commit text        NOT NULL CHECK (expected_runtime_commit ~ '^[0-9a-f]{40}$'),
  sandbox_id              text        CHECK (length(sandbox_id) BETWEEN 1 AND 128),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  activation_deadline     timestamptz NOT NULL,
  status                  text        NOT NULL DEFAULT 'provisioning'
                                      CHECK (status IN ('provisioning','verifying','active','failed_provisioning','orphaned')),
  cleanup_status          text        NOT NULL DEFAULT 'none'
                                      CHECK (cleanup_status IN ('none','not_required','pending','terminated','unsupported','failed')),
  failure_reason          text
);
CREATE INDEX fleet_provisioning_cleanup_idx ON fleet_provisioning (cleanup_status) WHERE cleanup_status IN ('pending','unsupported','failed');
CREATE TRIGGER fleet_provisioning_no_delete BEFORE DELETE ON fleet_provisioning
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- ── Orphaned external infrastructure (audit; never deleted)
CREATE TABLE fleet_orphans (
  orphan_id        bigserial   PRIMARY KEY,
  agent_id         text        NOT NULL REFERENCES fleet_agents(agent_id),
  provisioning_id  text        REFERENCES fleet_provisioning(provisioning_id),
  sandbox_id       text        NOT NULL,
  reason           text        NOT NULL,
  holds_slot       boolean     NOT NULL,
  detected_at      timestamptz NOT NULL DEFAULT now(),
  slot_released_at timestamptz,
  resolved_at      timestamptz,
  resolution       text,
  resolved_by      text
);
CREATE UNIQUE INDEX fleet_orphans_open_uq ON fleet_orphans (agent_id) WHERE resolved_at IS NULL;
CREATE TRIGGER fleet_orphans_no_delete BEFORE DELETE ON fleet_orphans
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- ── Health challenges (short-lived nonces; only the hash is stored)
CREATE TABLE fleet_health_challenges (
  challenge_id text        PRIMARY KEY CHECK (challenge_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  agent_id     text        NOT NULL REFERENCES fleet_agents(agent_id),
  nonce_hash   text        NOT NULL CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  canary       text        NOT NULL,
  issued_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  answered_at  timestamptz,
  outcome      text        NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending','passed','failed','expired')),
  detail       text
);
CREATE INDEX fleet_health_challenges_agent_idx ON fleet_health_challenges (agent_id, issued_at DESC);
CREATE UNIQUE INDEX fleet_health_challenges_pending_uq ON fleet_health_challenges (agent_id) WHERE outcome = 'pending';

-- Leaving the living population ALWAYS revokes every capability: fleet
-- credential, sessions, wallet spending authority. Provisioning failures are
-- recorded and their sandbox (if any) queued for cleanup.
CREATE FUNCTION fleet_agents_lifecycle_effects() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_provisioning;
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NEW.status IN ('terminating','orphaned','dead','failed') THEN
    UPDATE fleet_agent_credentials SET revoked_at = now() WHERE agent_id = NEW.agent_id AND revoked_at IS NULL;
    UPDATE fleet_agent_sessions SET revoked_at = now() WHERE agent_id = NEW.agent_id AND revoked_at IS NULL;
    UPDATE fleet_wallet_custody SET spending_frozen = true, frozen_reason = 'agent ' || NEW.status, frozen_at = now(), updated_at = now()
     WHERE agent_id = NEW.agent_id AND NOT spending_frozen;
    UPDATE fleet_health_challenges SET outcome = 'expired', detail = 'agent left living population'
     WHERE agent_id = NEW.agent_id AND outcome = 'pending';
  END IF;
  IF OLD.status IN ('reserved','provisioning') AND NEW.status = 'failed' THEN
    SELECT * INTO p FROM fleet_provisioning WHERE expected_agent_id = NEW.agent_id FOR UPDATE;
    IF FOUND THEN
      UPDATE fleet_provisioning
         SET status = 'failed_provisioning', failure_reason = left(NEW.status_reason, 500), updated_at = now(),
             cleanup_status = CASE WHEN p.sandbox_id IS NULL THEN 'not_required' ELSE 'pending' END
       WHERE provisioning_id = p.provisioning_id;
      IF p.sandbox_id IS NOT NULL THEN
        INSERT INTO fleet_sandbox_terminations (agent_id, sandbox_id, status) VALUES (NEW.agent_id, p.sandbox_id, 'pending')
          ON CONFLICT (agent_id) DO NOTHING;
        PERFORM fleet_event('sandbox_termination_requested', NEW.agent_id, 'lifecycle',
          jsonb_build_object('sandboxId', p.sandbox_id, 'provisioningId', p.provisioning_id, 'phase', 'failed_provisioning'));
      END IF;
    END IF;
  END IF;
  IF OLD.status = 'provisioning' AND NEW.status = 'active' THEN
    SELECT * INTO p FROM fleet_provisioning WHERE expected_agent_id = NEW.agent_id FOR UPDATE;
    IF FOUND THEN
      IF p.sandbox_id IS NOT NULL AND NEW.sandbox_id IS DISTINCT FROM p.sandbox_id THEN
        RAISE EXCEPTION 'FLEET_SANDBOX_MISMATCH: activation sandbox % differs from provisioned sandbox %', NEW.sandbox_id, p.sandbox_id;
      END IF;
      UPDATE fleet_provisioning SET status = 'active', cleanup_status = 'not_required', updated_at = now()
       WHERE provisioning_id = p.provisioning_id;
    END IF;
    IF NEW.wallet_address IS NOT NULL THEN
      INSERT INTO fleet_wallet_custody (agent_id, wallet_address) VALUES (NEW.agent_id, NEW.wallet_address)
        ON CONFLICT (agent_id) DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_agents_lifecycle_effects AFTER UPDATE OF status ON fleet_agents
  FOR EACH ROW EXECUTE FUNCTION fleet_agents_lifecycle_effects();

-- Roots get a custody record on registration.
CREATE FUNCTION fleet_agents_custody_on_insert() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF NEW.wallet_address IS NOT NULL THEN
    INSERT INTO fleet_wallet_custody (agent_id, wallet_address) VALUES (NEW.agent_id, NEW.wallet_address)
      ON CONFLICT (agent_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_agents_custody_on_insert AFTER INSERT ON fleet_agents
  FOR EACH ROW EXECUTE FUNCTION fleet_agents_custody_on_insert();
INSERT INTO fleet_wallet_custody (agent_id, wallet_address, spending_frozen, frozen_reason, frozen_at)
  SELECT agent_id, wallet_address, status NOT IN ('active','unresponsive'),
         CASE WHEN status NOT IN ('active','unresponsive') THEN 'agent ' || status END,
         CASE WHEN status NOT IN ('active','unresponsive') THEN now() END
    FROM fleet_agents WHERE wallet_address IS NOT NULL
  ON CONFLICT (agent_id) DO NOTHING;

CREATE OR REPLACE FUNCTION fleet_state_json(st fleet_state) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'livingAgents', st.living_agents,
    'reservedSlots', st.reserved_slots,
    'quarantinedSlots', st.quarantined_slots,
    'maxAgents', st.max_agents,
    'operatingMode', st.operating_mode,
    'replicationEnabled', st.replication_enabled,
    'runtime', CASE WHEN st.runtime_repo IS NULL THEN NULL
                    ELSE jsonb_build_object('repo', st.runtime_repo, 'commit', st.runtime_commit) END,
    'build', CASE WHEN st.runtime_build_id IS NULL THEN NULL
                  ELSE jsonb_build_object('buildId', st.runtime_build_id, 'lockfileSha256', st.runtime_lockfile_sha256) END,
    'updatedAt', st.updated_at)
$$;

-- ── Authentication: long-lived credential (fa1.) or short-lived session (fs1.)
CREATE OR REPLACE FUNCTION fleet_authenticate(p_agent text, p_token text, p_action text) RETURNS text LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_agent_credentials; s fleet_agent_sessions; v_status text; v_hash text;
BEGIN
  IF p_agent IS NULL OR p_token IS NULL OR length(p_token) > 256 OR length(p_agent) > 64 THEN
    PERFORM fleet_event('db_auth_failed', NULL, NULL, jsonb_build_object('action', p_action, 'why', 'malformed'));
    RETURN 'FLEET_AUTH_FAILED';
  END IF;
  v_hash := encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  SELECT status INTO v_status FROM fleet_agents WHERE agent_id = p_agent;
  IF p_token LIKE 'fs1.%' THEN
    SELECT * INTO s FROM fleet_agent_sessions WHERE session_hash = v_hash;
    IF NOT FOUND OR s.agent_id <> p_agent THEN
      PERFORM fleet_event('db_auth_failed', NULL, NULL,
        jsonb_build_object('action', p_action, 'claimedAgentId', left(p_agent, 64), 'why', 'bad session'));
      RETURN 'FLEET_AUTH_FAILED';
    END IF;
  ELSE
    SELECT * INTO c FROM fleet_agent_credentials WHERE agent_id = p_agent;
    IF NOT FOUND OR c.token_hash <> v_hash THEN
      PERFORM fleet_event('db_auth_failed', NULL, NULL,
        jsonb_build_object('action', p_action, 'claimedAgentId', left(p_agent, 64), 'why', 'bad credential'));
      RETURN 'FLEET_AUTH_FAILED';
    END IF;
  END IF;
  IF v_status IN ('dead','failed') THEN
    RETURN 'FLEET_AGENT_DEAD';
  END IF;
  IF v_status IN ('terminating','orphaned') THEN
    PERFORM fleet_event('db_auth_failed', p_agent, p_agent, jsonb_build_object('action', p_action, 'why', 'quarantined'));
    RETURN 'FLEET_AGENT_QUARANTINED';
  END IF;
  IF (s.session_hash IS NOT NULL AND s.revoked_at IS NOT NULL) OR (c.agent_id IS NOT NULL AND c.revoked_at IS NOT NULL) THEN
    PERFORM fleet_event('db_auth_failed', p_agent, p_agent, jsonb_build_object('action', p_action, 'why', 'revoked'));
    RETURN 'FLEET_AUTH_FAILED';
  END IF;
  IF s.session_hash IS NOT NULL THEN
    IF s.expires_at <= now() THEN
      RETURN 'FLEET_SESSION_EXPIRED';
    END IF;
    IF EXISTS (SELECT 1 FROM fleet_agent_credentials WHERE agent_id = p_agent AND revoked_at IS NOT NULL) THEN
      RETURN 'FLEET_AUTH_FAILED';
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- Exchange the long-lived credential for a short-lived session. Sessions
-- cannot mint sessions (no indefinite extension from a stolen session).
CREATE FUNCTION api_open_session(p_agent text, p_token text, p_session_hash text) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text; v_exp timestamptz; st fleet_state;
BEGIN
  IF p_token IS NULL OR p_token LIKE 'fs1.%' OR p_session_hash IS NULL OR p_session_hash !~ '^[0-9a-f]{64}$' THEN
    PERFORM fleet_event('db_auth_failed', NULL, NULL, jsonb_build_object('action', 'open_session', 'why', 'session tokens cannot open sessions'));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_AUTH_FAILED');
  END IF;
  v_code := fleet_authenticate(p_agent, p_token, 'open_session');
  IF v_code IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code);
  END IF;
  SELECT * INTO st FROM fleet_state WHERE id = 1;
  v_exp := now() + make_interval(secs => st.session_ttl_s);
  -- At most 8 live sessions per agent: the oldest is revoked.
  UPDATE fleet_agent_sessions SET revoked_at = now()
   WHERE session_hash IN (SELECT session_hash FROM fleet_agent_sessions
                           WHERE agent_id = p_agent AND revoked_at IS NULL AND expires_at > now()
                           ORDER BY created_at DESC OFFSET 7);
  INSERT INTO fleet_agent_sessions (session_hash, agent_id, expires_at) VALUES (p_session_hash, p_agent, v_exp);
  PERFORM fleet_event('session_opened', p_agent, p_agent, jsonb_build_object('expiresAt', v_exp));
  RETURN jsonb_build_object('ok', true, 'expiresAt', v_exp, 'ttlS', st.session_ttl_s);
END $$;

-- Replay protection: a (agent, nonce) pair is accepted once. Purged by the reaper after expiry.
CREATE FUNCTION svc_consume_nonce(p_agent text, p_nonce text, p_ttl_s integer) RETURNS boolean LANGUAGE plpgsql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_nonce IS NULL OR p_nonce !~ '^[A-Za-z0-9_-]{16,64}$' THEN
    RETURN false;
  END IF;
  INSERT INTO fleet_request_nonces (agent_id, nonce, expires_at)
  VALUES (left(p_agent, 64), p_nonce, now() + make_interval(secs => GREATEST(LEAST(p_ttl_s, 3600), 1)))
  ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    PERFORM fleet_event('request_replayed', NULL, left(p_agent, 64), jsonb_build_object('nonce', left(p_nonce, 16)));
    RETURN false;
  END IF;
  RETURN true;
END $$;

-- ── Provisioning: record the sandbox the moment it exists, then VERIFYING.
CREATE FUNCTION svc_provision_update(p_agent text, p_parent text, p_phase text, p_sandbox text) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_provisioning; a fleet_agents;
BEGIN
  SELECT * INTO p FROM fleet_provisioning WHERE expected_agent_id = p_agent FOR UPDATE;
  IF NOT FOUND OR (p_parent IS NOT NULL AND p.parent_agent_id <> p_parent) THEN
    PERFORM fleet_event('authorization_denied', NULL, p_parent, jsonb_build_object('action', 'provision_update', 'agentId', left(p_agent, 64)));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_AUTHORIZED');
  END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent;
  IF p_phase = 'sandbox_created' THEN
    IF p_sandbox IS NULL OR length(p_sandbox) NOT BETWEEN 1 AND 128 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
    END IF;
    IF p.sandbox_id IS NOT NULL AND p.sandbox_id <> p_sandbox THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_SANDBOX_MISMATCH');
    END IF;
    UPDATE fleet_provisioning SET sandbox_id = p_sandbox, updated_at = now() WHERE provisioning_id = p.provisioning_id;
    -- A sandbox reported after the attempt already failed is queued for cleanup at once.
    IF p.status IN ('failed_provisioning','orphaned') THEN
      UPDATE fleet_provisioning SET cleanup_status = 'pending' WHERE provisioning_id = p.provisioning_id AND cleanup_status = 'not_required';
      INSERT INTO fleet_sandbox_terminations (agent_id, sandbox_id, status) VALUES (p_agent, p_sandbox, 'pending')
        ON CONFLICT (agent_id) DO NOTHING;
    END IF;
    PERFORM fleet_event('provisioning_sandbox_created', p_agent, p_parent,
      jsonb_build_object('provisioningId', p.provisioning_id, 'sandboxId', p_sandbox));
  ELSIF p_phase = 'verifying' THEN
    IF p.status <> 'provisioning' OR a.status <> 'provisioning' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE');
    END IF;
    UPDATE fleet_provisioning SET status = 'verifying', updated_at = now() WHERE provisioning_id = p.provisioning_id;
    PERFORM fleet_event('provisioning_verifying', p_agent, p_parent, jsonb_build_object('provisioningId', p.provisioning_id));
  ELSE
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  RETURN jsonb_build_object('ok', true, 'provisioningId', p.provisioning_id);
END $$;

-- Provisioning record creation on claim (reserved -> provisioning).
CREATE FUNCTION fleet_reservations_provisioning() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF NEW.status = 'provisioning' AND OLD.status = 'reserved' THEN
    INSERT INTO fleet_provisioning (provisioning_id, reservation_id, parent_agent_id, expected_agent_id,
                                    expected_runtime_commit, activation_deadline)
    VALUES (NEW.reservation_id, NEW.reservation_id, NEW.parent_agent_id, NEW.agent_id, NEW.expected_commit, NEW.expires_at)
    ON CONFLICT (reservation_id) DO NOTHING;
    PERFORM fleet_event('provisioning_started', NEW.agent_id, NEW.parent_agent_id,
      jsonb_build_object('provisioningId', NEW.reservation_id, 'activationDeadline', NEW.expires_at));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_reservations_provisioning AFTER UPDATE OF status ON fleet_reservations
  FOR EACH ROW EXECUTE FUNCTION fleet_reservations_provisioning();

-- ── Termination: revoke everything first, then stop the sandbox.
CREATE FUNCTION fleet_begin_termination(p_agent text, p_reason text, p_actor text, p_cause text) RETURNS text LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_agents; v_reason text := fleet_scrub(p_reason);
BEGIN
  PERFORM fleet_lock_state();
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND OR a.status NOT IN ('active','unresponsive') THEN
    RETURN NULL;
  END IF;
  IF a.sandbox_id IS NULL THEN
    -- No external infrastructure known: nothing to stop; the agent is dead.
    PERFORM fleet_mark_dead(p_agent, v_reason, p_actor, p_cause);
    RETURN 'dead';
  END IF;
  UPDATE fleet_agents SET status = 'terminating', status_reason = v_reason, health_reason = left(p_cause, 64), updated_at = now()
   WHERE agent_id = p_agent;
  INSERT INTO fleet_sandbox_terminations (agent_id, sandbox_id, status) VALUES (p_agent, a.sandbox_id, 'pending')
    ON CONFLICT (agent_id) DO NOTHING;
  PERFORM fleet_event('agent_terminating', p_agent, p_actor,
    jsonb_build_object('reason', v_reason, 'cause', p_cause, 'sandboxId', a.sandbox_id, 'capabilitiesRevoked', true));
  PERFORM fleet_event('sandbox_termination_requested', p_agent, p_actor, jsonb_build_object('sandboxId', a.sandbox_id));
  RETURN 'terminating';
END $$;

-- Termination outcome. TERMINATING -> DEAD when the sandbox is gone; when the
-- provider cannot stop it (unsupported, or 5 failed attempts) -> ORPHANED,
-- holding a quarantine slot per the orphan policy. Deaths the agent itself
-- confirmed (retirement) and failed provisioning are audited as orphans
-- but hold no slot.
CREATE OR REPLACE FUNCTION svc_termination_result(p_agent text, p_status text, p_error text, p_actor text) RETURNS boolean LANGUAGE plpgsql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE t fleet_sandbox_terminations; a fleet_agents; p fleet_provisioning; v_orphan boolean;
BEGIN
  IF p_status NOT IN ('terminated','unsupported','failed') THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: termination status %', p_status;
  END IF;
  PERFORM fleet_lock_state();
  UPDATE fleet_sandbox_terminations
     SET status = p_status, attempts = attempts + 1, last_attempt_at = now(), last_error = fleet_scrub(p_error),
         completed_at = CASE WHEN p_status IN ('terminated','unsupported') THEN now() END
   WHERE agent_id = p_agent AND status IN ('pending','failed')
   RETURNING * INTO t;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM fleet_event(CASE p_status WHEN 'terminated' THEN 'sandbox_terminated'
                                    WHEN 'unsupported' THEN 'sandbox_termination_unsupported'
                                    ELSE 'sandbox_termination_failed' END,
                      p_agent, p_actor, jsonb_build_object('sandboxId', t.sandbox_id, 'error', fleet_scrub(p_error)));
  v_orphan := p_status = 'unsupported' OR (p_status = 'failed' AND t.attempts >= 5);
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent FOR UPDATE;
  SELECT * INTO p FROM fleet_provisioning WHERE expected_agent_id = p_agent FOR UPDATE;
  IF p.provisioning_id IS NOT NULL AND p.status <> 'active' THEN
    UPDATE fleet_provisioning
       SET cleanup_status = CASE WHEN p_status = 'terminated' THEN 'terminated' WHEN v_orphan THEN 'unsupported' ELSE 'failed' END,
           status = CASE WHEN v_orphan THEN 'orphaned' ELSE status END, updated_at = now()
     WHERE provisioning_id = p.provisioning_id;
  END IF;
  IF a.status = 'terminating' THEN
    IF p_status = 'terminated' THEN
      UPDATE fleet_agents SET status = 'dead', death_time = now(), updated_at = now(),
             status_reason = left(COALESCE(status_reason, '') || '; sandbox terminated', 500)
       WHERE agent_id = p_agent;
      PERFORM fleet_event('agent_died', p_agent, p_actor, jsonb_build_object('cause', 'terminated', 'status', 'dead'));
      PERFORM fleet_event('slot_released', p_agent, p_actor, jsonb_build_object('reason', 'sandbox terminated'));
    ELSIF v_orphan THEN
      UPDATE fleet_agents SET status = 'orphaned', updated_at = now() WHERE agent_id = p_agent;
      INSERT INTO fleet_orphans (agent_id, provisioning_id, sandbox_id, reason, holds_slot)
      VALUES (p_agent, p.provisioning_id, t.sandbox_id, left(COALESCE(p_error, p_status), 500), true)
      ON CONFLICT DO NOTHING;
      PERFORM fleet_event('agent_orphaned', p_agent, p_actor,
        jsonb_build_object('sandboxId', t.sandbox_id, 'holdsSlot', true, 'capabilitiesRevoked', true));
    END IF;
  ELSIF v_orphan THEN
    INSERT INTO fleet_orphans (agent_id, provisioning_id, sandbox_id, reason, holds_slot)
    VALUES (p_agent, p.provisioning_id, t.sandbox_id, left(COALESCE(p_error, p_status), 500), false)
    ON CONFLICT DO NOTHING;
    PERFORM fleet_event('infrastructure_orphaned', p_agent, p_actor,
      jsonb_build_object('sandboxId', t.sandbox_id, 'agentStatus', a.status, 'holdsSlot', false));
  END IF;
  RETURN true;
END $$;

-- Heartbeat: records liveness. An UNRESPONSIVE agent returns to ACTIVE only
-- if its health (last passed controller challenge) is fresh — a heartbeat
-- alone never restores health.
CREATE OR REPLACE FUNCTION fleet_heartbeat(p_agent text, p_actor text) RETURNS text LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_agents; st fleet_state;
BEGIN
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF a.status NOT IN ('active','unresponsive') THEN
    RETURN a.status;
  END IF;
  SELECT * INTO st FROM fleet_state WHERE id = 1;
  IF a.status = 'unresponsive'
     AND COALESCE(a.last_challenge_ok_at, a.activated_at, a.created_at) >= now() - make_interval(secs => st.health_grace_s)
     AND a.challenge_failures < st.max_challenge_failures THEN
    UPDATE fleet_agents SET last_heartbeat = now(), status = 'active', health_reason = NULL WHERE agent_id = p_agent;
    PERFORM fleet_event('agent_recovered', p_agent, p_actor, '{}'::jsonb);
    RETURN 'active';
  END IF;
  UPDATE fleet_agents SET last_heartbeat = now() WHERE agent_id = p_agent;
  RETURN a.status;
END $$;

-- An unhealthy (UNRESPONSIVE) agent is still alive: its heartbeat succeeds
-- and reports the status, so it keeps answering challenges instead of
-- shutting itself down.
CREATE OR REPLACE FUNCTION api_heartbeat(p_agent text, p_token text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'heartbeat'); v_status text;
BEGIN
  IF v_code IN ('FLEET_AGENT_DEAD','FLEET_AGENT_QUARANTINED') THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code,
      'status', (SELECT status FROM fleet_agents WHERE agent_id = p_agent));
  ELSIF v_code IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code);
  END IF;
  v_status := fleet_heartbeat(p_agent, p_agent);
  RETURN jsonb_build_object('ok', COALESCE(v_status IN ('active','unresponsive'), false), 'status', v_status);
END $$;

-- ── Health challenges
CREATE FUNCTION svc_issue_challenge(p_agent text, p_challenge_id text, p_nonce_hash text, p_canary text) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_agents; st fleet_state; last fleet_health_challenges; v_exp timestamptz;
BEGIN
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND OR a.status NOT IN ('active','unresponsive') THEN
    RETURN jsonb_build_object('issued', false, 'reason', 'not living');
  END IF;
  SELECT * INTO st FROM fleet_state WHERE id = 1;
  SELECT * INTO last FROM fleet_health_challenges WHERE agent_id = p_agent ORDER BY issued_at DESC LIMIT 1;
  IF FOUND AND last.outcome = 'pending' THEN
    IF last.expires_at > now() THEN
      RETURN jsonb_build_object('issued', false, 'reason', 'pending');
    END IF;
    PERFORM fleet_expire_challenge(last.challenge_id);
  ELSIF FOUND AND last.outcome = 'passed' AND last.issued_at > now() - make_interval(secs => st.health_challenge_interval_s) THEN
    RETURN jsonb_build_object('issued', false, 'reason', 'not due');
  END IF;
  v_exp := now() + make_interval(secs => st.challenge_ttl_s);
  INSERT INTO fleet_health_challenges (challenge_id, agent_id, nonce_hash, canary, expires_at)
  VALUES (p_challenge_id, p_agent, p_nonce_hash, left(p_canary, 200), v_exp);
  RETURN jsonb_build_object('issued', true, 'expiresAt', v_exp);
END $$;

CREATE FUNCTION fleet_challenge_failed(p_agent text, p_detail text) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_agents; st fleet_state;
BEGIN
  SELECT * INTO st FROM fleet_state WHERE id = 1;
  UPDATE fleet_agents SET challenge_failures = challenge_failures + 1, health_reason = left(p_detail, 200)
   WHERE agent_id = p_agent RETURNING * INTO a;
  PERFORM fleet_event('health_challenge_failed', p_agent, 'controller',
    jsonb_build_object('detail', left(p_detail, 200), 'failures', a.challenge_failures));
  IF a.status = 'active' AND a.challenge_failures >= st.max_challenge_failures THEN
    UPDATE fleet_agents SET status = 'unresponsive', updated_at = now() WHERE agent_id = p_agent AND status = 'active';
    PERFORM fleet_event('agent_unresponsive', p_agent, 'controller',
      jsonb_build_object('cause', 'health_challenge', 'failures', a.challenge_failures));
  END IF;
END $$;

CREATE FUNCTION fleet_expire_challenge(p_challenge text) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_health_challenges;
BEGIN
  UPDATE fleet_health_challenges SET outcome = 'expired', detail = 'no answer before expiry'
   WHERE challenge_id = p_challenge AND outcome = 'pending' RETURNING * INTO c;
  IF FOUND THEN
    PERFORM fleet_challenge_failed(c.agent_id, 'challenge expired unanswered');
  END IF;
END $$;

-- Answer: nonce (single use, unexpired), runtime identity against the
-- agent's lease/registration, and the policy canary must all pass.
CREATE FUNCTION svc_answer_challenge(p_agent text, p_challenge_id text, p_nonce text, p_commit text, p_build_id text, p_policy_ok boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_agents; c fleet_health_challenges; l fleet_reservations; st fleet_state; v_fail text;
BEGIN
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent FOR UPDATE;
  SELECT * INTO c FROM fleet_health_challenges WHERE challenge_id = p_challenge_id FOR UPDATE;
  IF NOT FOUND OR c.agent_id <> p_agent THEN
    PERFORM fleet_event('authorization_denied', NULL, p_agent, jsonb_build_object('action', 'answer_challenge'));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_AUTHORIZED');
  END IF;
  IF c.outcome <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CHALLENGE_USED');
  END IF;
  IF c.expires_at <= now() THEN
    PERFORM fleet_expire_challenge(c.challenge_id);
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CHALLENGE_EXPIRED');
  END IF;
  SELECT * INTO st FROM fleet_state WHERE id = 1;
  SELECT * INTO l FROM fleet_reservations WHERE agent_id = p_agent;
  IF a.status NOT IN ('active','unresponsive') THEN v_fail := 'agent not living';
  ELSIF c.nonce_hash <> encode(sha256(convert_to(COALESCE(p_nonce, ''), 'UTF8')), 'hex') THEN v_fail := 'nonce mismatch';
  ELSIF a.role = 'child' AND (l.reservation_id IS NULL OR p_commit IS DISTINCT FROM l.expected_commit) THEN v_fail := 'runtime commit mismatch';
  ELSIF a.role = 'child' AND p_build_id IS DISTINCT FROM l.expected_build_id THEN v_fail := 'runtime build mismatch';
  ELSIF a.role = 'root' AND a.runtime_commit IS NOT NULL AND p_commit IS DISTINCT FROM a.runtime_commit THEN v_fail := 'runtime commit mismatch';
  ELSIF p_policy_ok IS DISTINCT FROM true THEN v_fail := 'policy canary not blocked';
  END IF;
  IF v_fail IS NOT NULL THEN
    UPDATE fleet_health_challenges SET outcome = 'failed', answered_at = now(), detail = v_fail WHERE challenge_id = c.challenge_id;
    PERFORM fleet_challenge_failed(p_agent, v_fail);
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CHALLENGE_FAILED', 'reason', v_fail);
  END IF;
  UPDATE fleet_health_challenges SET outcome = 'passed', answered_at = now() WHERE challenge_id = c.challenge_id;
  UPDATE fleet_agents SET last_challenge_ok_at = now(), challenge_failures = 0, health_reason = NULL WHERE agent_id = p_agent;
  IF a.status = 'unresponsive' AND COALESCE(a.last_heartbeat, a.updated_at) >= now() - make_interval(secs => st.heartbeat_unresponsive_s) THEN
    UPDATE fleet_agents SET status = 'active', updated_at = now() WHERE agent_id = p_agent;
    PERFORM fleet_event('agent_recovered', p_agent, p_agent, jsonb_build_object('via', 'health_challenge'));
  END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

-- ── Slot allocator: as V2, plus quarantine slots in the population and the
-- unresolved-orphan replication block.
CREATE OR REPLACE FUNCTION fleet_reserve_slot(
  p_parent text, p_requested_by text, p_name text, p_request_key text, p_local_max integer,
  p_ttl_ms bigint, p_match_pin boolean, p_repo text, p_commit text, p_agent_id text, p_reservation_id text
) RETURNS jsonb LANGUAGE plpgsql SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE st fleet_state; par fleet_agents; mx integer; v_code text; v_reason text; v_exp timestamptz; v_orphans integer; v_occ integer;
BEGIN
  PERFORM fleet_lock_state();
  PERFORM fleet_expire_leases(p_requested_by);
  SELECT * INTO st FROM fleet_state WHERE id = 1;
  mx := LEAST(st.max_agents, COALESCE(p_local_max, ${hardMax}), ${hardMax});
  v_occ := st.living_agents + st.reserved_slots + st.quarantined_slots;
  SELECT count(*) INTO v_orphans FROM fleet_orphans WHERE resolved_at IS NULL;

  IF st.operating_mode = 'EMERGENCY' OR st.operating_mode NOT IN ('DEVELOPMENT','EXPANSION','HARVEST') THEN
    v_code := 'FLEET_EMERGENCY'; v_reason := 'Shared fleet state is EMERGENCY.';
  ELSIF st.operating_mode = 'DEVELOPMENT' THEN
    v_code := 'FLEET_DEVELOPMENT_MODE'; v_reason := 'Shared fleet state is DEVELOPMENT.';
  ELSIF st.operating_mode = 'HARVEST' THEN
    v_code := 'FLEET_HARVEST'; v_reason := 'Shared fleet state is HARVEST.';
  ELSIF NOT st.replication_enabled THEN
    v_code := 'REAL_REPLICATION_DISABLED'; v_reason := 'Replication is disabled in the shared fleet registry.';
  ELSIF st.runtime_repo IS NULL OR st.runtime_build_id IS NULL THEN
    v_code := 'FLEET_RUNTIME_UNVERIFIED'; v_reason := 'No fleet-approved runtime build.';
  ELSIF p_match_pin AND (p_repo IS DISTINCT FROM st.runtime_repo OR p_commit IS DISTINCT FROM st.runtime_commit) THEN
    v_code := 'FLEET_RUNTIME_UNVERIFIED'; v_reason := 'Child runtime pin does not match the fleet-approved runtime.';
  ELSIF v_orphans > st.max_open_orphans THEN
    v_code := 'FLEET_ORPHANS_UNRESOLVED';
    v_reason := format('%s unresolved orphaned sandboxes exceed the limit of %s.', v_orphans, st.max_open_orphans);
  END IF;

  IF v_code IS NULL THEN
    SELECT * INTO par FROM fleet_agents WHERE agent_id = p_parent;
    IF NOT FOUND OR par.status <> 'active' THEN
      v_code := 'FLEET_PARENT_NOT_LIVING'; v_reason := 'Parent is not a living, healthy registered fleet agent.';
    ELSIF EXISTS (SELECT 1 FROM fleet_wallet_custody WHERE agent_id = p_parent AND spending_frozen) THEN
      v_code := 'FLEET_PARENT_FROZEN'; v_reason := 'Parent spending authority is frozen.';
    ELSIF EXISTS (SELECT 1 FROM fleet_agents WHERE request_key = p_request_key) THEN
      v_code := 'FLEET_DUPLICATE_REQUEST'; v_reason := 'Replication request already registered.';
    ELSIF v_occ >= mx THEN
      v_code := 'FLEET_CAP_REACHED';
      v_reason := format('Fleet at cap (%s living + %s reserved + %s quarantined >= %s).',
                         st.living_agents, st.reserved_slots, st.quarantined_slots, mx);
    END IF;
  END IF;

  IF v_code IS NOT NULL THEN
    PERFORM fleet_event('reservation_denied', NULL, p_requested_by,
      jsonb_build_object('code', v_code, 'living', st.living_agents, 'reserved', st.reserved_slots,
                         'quarantined', st.quarantined_slots, 'max', mx));
    RETURN jsonb_build_object('ok', false, 'code', v_code, 'reason', v_reason,
      'living', st.living_agents, 'reserved', st.reserved_slots, 'max', mx);
  END IF;

  v_exp := now() + make_interval(secs => COALESCE(p_ttl_ms, st.reservation_ttl_s::bigint * 1000)::double precision / 1000);
  INSERT INTO fleet_agents (agent_id, parent_agent_id, role, generation, name, runtime_repo, runtime_commit,
                            status, requested_by, request_key, reservation_expires_at)
  VALUES (p_agent_id, p_parent, 'child', par.generation + 1, p_name, st.runtime_repo, st.runtime_commit,
          'reserved', p_requested_by, p_request_key, v_exp);
  INSERT INTO fleet_reservations (reservation_id, agent_id, parent_agent_id, status, expires_at,
                                  expected_repo, expected_commit, expected_build_id, expected_lockfile_sha256)
  VALUES (p_reservation_id, p_agent_id, p_parent, 'reserved', v_exp,
          st.runtime_repo, st.runtime_commit, st.runtime_build_id, st.runtime_lockfile_sha256);
  PERFORM fleet_event('slot_reserved', p_agent_id, p_requested_by, jsonb_build_object(
    'reservationId', p_reservation_id, 'living', st.living_agents, 'reserved', st.reserved_slots + 1, 'max', mx,
    'expiresAt', v_exp));
  RETURN jsonb_build_object('ok', true, 'agentId', p_agent_id, 'reservationId', p_reservation_id,
    'parentAgentId', p_parent, 'generation', par.generation + 1, 'expiresAt', v_exp,
    'runtime', jsonb_build_object('repo', st.runtime_repo, 'commit', st.runtime_commit),
    'build', jsonb_build_object('buildId', st.runtime_build_id, 'lockfileSha256', st.runtime_lockfile_sha256));
END $$;

-- ── Reaper (v4). Order per pass:
--   1 leases   2 challenges   3 parent-reported quiet children
--   4 UNRESPONSIVE past termination eligibility -> TERMINATING (or DEAD if no sandbox)
--   5 ACTIVE with stale heartbeat OR stale health OR too many failed challenges -> UNRESPONSIVE
--   6 ORPHANED past the slot hold -> DEAD (orphan record stays open)
--   7 purge expired nonces/sessions
-- Heartbeat-only agents: their health goes stale (5), and UNRESPONSIVE is
-- measured from unresponsive_since, not from the last heartbeat (4).
CREATE OR REPLACE FUNCTION fleet_reap(p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE st fleet_state; v_grace timestamptz; v_expired integer; v_unresp integer := 0; v_dead integer := 0;
        v_term integer := 0; v_orph integer := 0; v_chal integer := 0; r record; v_res text;
BEGIN
  st := fleet_lock_state();
  IF st.reaper_last_run_at IS NULL OR st.reaper_grace_from IS NULL
     OR now() - st.reaper_last_run_at > make_interval(secs => st.heartbeat_unresponsive_s) THEN
    v_grace := now();
    PERFORM fleet_event('reaper_resumed', NULL, p_actor, jsonb_build_object('lastRunAt', st.reaper_last_run_at));
  ELSE
    v_grace := st.reaper_grace_from;
  END IF;
  UPDATE fleet_state SET reaper_last_run_at = now(), reaper_grace_from = v_grace WHERE id = 1;

  v_expired := fleet_expire_leases(p_actor);

  FOR r IN SELECT challenge_id FROM fleet_health_challenges WHERE outcome = 'pending' AND expires_at <= now() ORDER BY challenge_id LOOP
    PERFORM fleet_expire_challenge(r.challenge_id);
    v_chal := v_chal + 1;
  END LOOP;

  FOR r IN SELECT agent_id FROM fleet_agents
            WHERE status IN ('active','unresponsive') AND terminal_reported_at IS NOT NULL
              AND GREATEST(COALESCE(last_heartbeat, updated_at), v_grace) < now() - make_interval(secs => st.parent_report_quiet_s)
            ORDER BY agent_id LOOP
    IF fleet_mark_dead(r.agent_id, format('parent reported terminal; no heartbeat for more than %s s', st.parent_report_quiet_s),
                       p_actor, 'parent_reported') THEN
      v_dead := v_dead + 1;
    END IF;
  END LOOP;

  FOR r IN SELECT agent_id, last_heartbeat, unresponsive_since FROM fleet_agents
            WHERE status = 'unresponsive'
              AND (GREATEST(COALESCE(last_heartbeat, updated_at), v_grace) < now() - make_interval(secs => st.heartbeat_dead_s)
                   OR GREATEST(COALESCE(unresponsive_since, updated_at), v_grace) < now() - make_interval(secs => st.termination_grace_s))
            ORDER BY agent_id LOOP
    v_res := fleet_begin_termination(r.agent_id,
      CASE WHEN GREATEST(COALESCE(r.last_heartbeat, now()), v_grace) < now() - make_interval(secs => st.heartbeat_dead_s)
           THEN format('no heartbeat for more than %s s', st.heartbeat_dead_s)
           ELSE format('unresponsive (unhealthy) for more than %s s', st.termination_grace_s) END,
      p_actor,
      CASE WHEN GREATEST(COALESCE(r.last_heartbeat, now()), v_grace) < now() - make_interval(secs => st.heartbeat_dead_s)
           THEN 'heartbeat_timeout' ELSE 'health_timeout' END);
    IF v_res = 'dead' THEN v_dead := v_dead + 1; ELSIF v_res = 'terminating' THEN v_term := v_term + 1; END IF;
  END LOOP;

  FOR r IN SELECT agent_id, last_heartbeat, challenge_failures,
                  GREATEST(COALESCE(last_heartbeat, updated_at), v_grace) < now() - make_interval(secs => st.heartbeat_unresponsive_s) AS hb_stale
             FROM fleet_agents
            WHERE status = 'active'
              AND (GREATEST(COALESCE(last_heartbeat, updated_at), v_grace) < now() - make_interval(secs => st.heartbeat_unresponsive_s)
                   OR GREATEST(COALESCE(last_challenge_ok_at, activated_at, created_at), v_grace) < now() - make_interval(secs => st.health_grace_s)
                   OR challenge_failures >= st.max_challenge_failures)
            ORDER BY agent_id FOR UPDATE LOOP
    UPDATE fleet_agents SET status = 'unresponsive', updated_at = now(),
           health_reason = CASE WHEN r.hb_stale THEN 'heartbeat stale' ELSE 'health challenge stale or failing' END
     WHERE agent_id = r.agent_id AND status = 'active';
    PERFORM fleet_event('agent_unresponsive', r.agent_id, p_actor,
      jsonb_build_object('lastHeartbeat', r.last_heartbeat, 'timeoutS', st.heartbeat_unresponsive_s,
                         'cause', CASE WHEN r.hb_stale THEN 'heartbeat' ELSE 'health' END, 'challengeFailures', r.challenge_failures));
    v_unresp := v_unresp + 1;
  END LOOP;

  IF st.orphan_slot_hold_s > 0 THEN
    FOR r IN SELECT agent_id FROM fleet_agents
              WHERE status = 'orphaned' AND quarantined_at < now() - make_interval(secs => st.orphan_slot_hold_s)
              ORDER BY agent_id LOOP
      UPDATE fleet_agents SET status = 'dead', death_time = now(), updated_at = now(),
             status_reason = left(COALESCE(status_reason, '') || '; orphan slot hold elapsed (sandbox not confirmed stopped)', 500)
       WHERE agent_id = r.agent_id;
      UPDATE fleet_orphans SET slot_released_at = now() WHERE agent_id = r.agent_id AND resolved_at IS NULL;
      PERFORM fleet_event('orphan_slot_released', r.agent_id, p_actor, jsonb_build_object('holdS', st.orphan_slot_hold_s));
      v_orph := v_orph + 1;
    END LOOP;
  END IF;

  DELETE FROM fleet_request_nonces WHERE expires_at < now();
  DELETE FROM fleet_agent_sessions WHERE expires_at < now() - interval '1 day';

  RETURN jsonb_build_object('expired', v_expired, 'unresponsive', v_unresp, 'dead', v_dead, 'terminating', v_term,
                            'orphanSlotsReleased', v_orph, 'challengesExpired', v_chal, 'graceFrom', v_grace);
END $$;

-- ── Custody: spend requests (decision only; nothing is signed or sent here)
CREATE TABLE fleet_spend_requests (
  request_id     text        PRIMARY KEY CHECK (request_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  agent_id       text        NOT NULL REFERENCES fleet_agents(agent_id),
  wallet_address text        NOT NULL,
  to_address     text        NOT NULL,
  amount_cents   bigint      NOT NULL CHECK (amount_cents > 0),
  purpose        text        NOT NULL,
  allocation_id  text,
  decision       text        NOT NULL CHECK (decision IN ('denied','approved_not_executed')),
  reason         text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_spend_requests_no_change BEFORE UPDATE OR DELETE ON fleet_spend_requests
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
}

export const V5_SQL = `
-- ── Treasury policy (single row; FleetAdmin-managed)
CREATE TABLE fleet_treasury_policy (
  id                       smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  runway_days              integer     NOT NULL DEFAULT 30   CHECK (runway_days BETWEEN 0 AND 365),
  contingency_pct          numeric     NOT NULL DEFAULT 0.10 CHECK (contingency_pct BETWEEN 0 AND 1),
  min_contingency_cents    bigint      NOT NULL DEFAULT 1000 CHECK (min_contingency_cents >= 0),
  population_rates         jsonb       NOT NULL DEFAULT '[{"maxAgents":10,"rate":0.10},{"maxAgents":20,"rate":0.125},{"maxAgents":30,"rate":0.15},{"maxAgents":40,"rate":0.175},{"maxAgents":49,"rate":0.20}]',
  mature_fleet_rate        numeric     NOT NULL DEFAULT 0.45 CHECK (mature_fleet_rate BETWEEN 0 AND 0.70),
  max_sweep_rate           numeric     NOT NULL DEFAULT 0.70 CHECK (max_sweep_rate BETWEEN 0 AND 0.70),
  reserve_target_months    numeric     NOT NULL DEFAULT 3    CHECK (reserve_target_months BETWEEN 0 AND 36),
  maturity_age_days        integer     NOT NULL DEFAULT 180  CHECK (maturity_age_days BETWEEN 1 AND 3650),
  treasury_address         text        CHECK (treasury_address ~ '^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$'),
  owner_withdrawal_address text        CHECK (owner_withdrawal_address ~ '^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$'),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               text,
  CHECK (mature_fleet_rate <= max_sweep_rate),
  -- The fleet treasury is never the owner's personal withdrawal destination.
  CHECK (treasury_address IS NULL OR owner_withdrawal_address IS NULL OR lower(treasury_address) <> lower(owner_withdrawal_address))
);
INSERT INTO fleet_treasury_policy (id) VALUES (1);
CREATE TRIGGER fleet_treasury_policy_no_delete BEFORE DELETE ON fleet_treasury_policy
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- No fleet agent id may ever appear as the approver of money decisions.
CREATE FUNCTION fleet_require_operator_approver(p_approver text, p_subject text) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_approver IS NULL OR length(trim(p_approver)) = 0 THEN
    RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: an operator approver is required';
  END IF;
  IF p_approver = p_subject OR EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = p_approver OR lower(wallet_address) = lower(p_approver)) THEN
    RAISE EXCEPTION 'FLEET_SELF_APPROVAL: agents cannot approve capital exceptions (approver %)', p_approver;
  END IF;
END $$;

-- ── Per-agent ledger (revenue/cost/funding). Owner funding is never revenue.
CREATE TABLE fleet_agent_ledger (
  entry_id      bigserial   PRIMARY KEY,
  agent_id      text        NOT NULL REFERENCES fleet_agents(agent_id),
  kind          text        NOT NULL CHECK (kind IN ('revenue','direct_cost','owner_funding','fleet_funding',
                                                     'allocation_deployed','allocation_returned','sweep_to_treasury')),
  amount_cents  bigint      NOT NULL CHECK (amount_cents > 0),
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  allocation_id text,
  reference     text        CHECK (length(reference) <= 200),
  source        text        NOT NULL CHECK (source IN ('controller','operator','agent_reported')),
  recorded_by   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_agent_ledger_agent_idx ON fleet_agent_ledger (agent_id, occurred_at);
CREATE TRIGGER fleet_agent_ledger_no_change BEFORE UPDATE OR DELETE ON fleet_agent_ledger
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- Observed wallet balance (cash on hand) per agent.
CREATE TABLE fleet_balance_observations (
  observation_id bigserial   PRIMARY KEY,
  agent_id       text        NOT NULL REFERENCES fleet_agents(agent_id),
  cash_cents     bigint      NOT NULL CHECK (cash_cents >= 0),
  observed_at    timestamptz NOT NULL DEFAULT now(),
  source         text        NOT NULL CHECK (source IN ('controller','operator','agent_reported'))
);
CREATE INDEX fleet_balance_observations_agent_idx ON fleet_balance_observations (agent_id, observed_at DESC);

-- Approved operating obligations (never swept).
CREATE TABLE fleet_obligations (
  obligation_id text        PRIMARY KEY CHECK (obligation_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  agent_id      text        NOT NULL REFERENCES fleet_agents(agent_id),
  description   text        NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  amount_cents  bigint      NOT NULL CHECK (amount_cents > 0),
  due_at        timestamptz NOT NULL,
  status        text        NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','settled','cancelled')),
  approved_by   text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ── Capital allocations: agents propose; only FleetAdmin decides.
CREATE TABLE fleet_capital_allocations (
  allocation_id          text        PRIMARY KEY CHECK (allocation_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  agent_id               text        NOT NULL REFERENCES fleet_agents(agent_id),
  kind                   text        NOT NULL DEFAULT 'growth' CHECK (kind IN ('growth','rescue')),
  purpose                text        NOT NULL CHECK (length(purpose) BETWEEN 1 AND 500),
  requested_amount_cents bigint      NOT NULL CHECK (requested_amount_cents > 0),
  approved_amount_cents  bigint      CHECK (approved_amount_cents >= 0),
  deployed_cents         bigint      NOT NULL DEFAULT 0 CHECK (deployed_cents >= 0),
  start_date             timestamptz,
  expiry_date            timestamptz,
  expected_return_cents  bigint      NOT NULL DEFAULT 0 CHECK (expected_return_cents >= 0),
  expected_duration_days integer     NOT NULL CHECK (expected_duration_days BETWEEN 1 AND 3650),
  status                 text        NOT NULL DEFAULT 'proposed'
                                     CHECK (status IN ('proposed','approved','rejected','completed','expired','cancelled')),
  actual_return_cents    bigint,
  proposed_by            text        NOT NULL,
  decided_by             text,
  decided_at             timestamptz,
  decision_reason        text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'approved' OR (approved_amount_cents IS NOT NULL AND start_date IS NOT NULL AND expiry_date > start_date)),
  CHECK (approved_amount_cents IS NULL OR approved_amount_cents <= requested_amount_cents * 10)
);
CREATE INDEX fleet_capital_allocations_agent_idx ON fleet_capital_allocations (agent_id, status);

CREATE FUNCTION fleet_allocations_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'proposed' THEN
      RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: allocations start proposed';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.allocation_id <> NEW.allocation_id OR OLD.agent_id <> NEW.agent_id OR OLD.proposed_by <> NEW.proposed_by
     OR OLD.requested_amount_cents <> NEW.requested_amount_cents OR OLD.created_at <> NEW.created_at THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: allocation identity cannot change';
  END IF;
  IF OLD.status IN ('rejected','completed','expired','cancelled') THEN
    RAISE EXCEPTION 'FLEET_TERMINAL_STATE_IMMUTABLE: allocation % is %', OLD.allocation_id, OLD.status;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'proposed' AND NEW.status IN ('approved','rejected','cancelled'))
    OR (OLD.status = 'approved' AND NEW.status IN ('completed','expired','cancelled'))) THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: allocation % -> %', OLD.status, NEW.status;
  END IF;
  -- Any decision or change of terms needs an operator (never an agent).
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.approved_amount_cents IS DISTINCT FROM OLD.approved_amount_cents
     OR NEW.expiry_date IS DISTINCT FROM OLD.expiry_date OR NEW.start_date IS DISTINCT FROM OLD.start_date THEN
    PERFORM fleet_require_operator_approver(NEW.decided_by, NEW.agent_id);
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_allocations_guard BEFORE INSERT OR UPDATE ON fleet_capital_allocations
  FOR EACH ROW EXECUTE FUNCTION fleet_allocations_guard();
CREATE TRIGGER fleet_allocations_no_delete BEFORE DELETE ON fleet_capital_allocations
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- Temporary sweep reductions for approved high-value opportunities.
CREATE TABLE fleet_sweep_reductions (
  reduction_id  text        PRIMARY KEY CHECK (reduction_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  agent_id      text        NOT NULL REFERENCES fleet_agents(agent_id),
  allocation_id text        REFERENCES fleet_capital_allocations(allocation_id),
  reduction_pct numeric     NOT NULL CHECK (reduction_pct > 0 AND reduction_pct <= 1),
  reason        text        NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  starts_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  approved_by   text        NOT NULL,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > starts_at),
  CHECK (expires_at <= starts_at + interval '180 days')
);
CREATE FUNCTION fleet_sweep_reductions_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM fleet_require_operator_approver(NEW.approved_by, NEW.agent_id);
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_sweep_reductions_guard BEFORE INSERT OR UPDATE ON fleet_sweep_reductions
  FOR EACH ROW EXECUTE FUNCTION fleet_sweep_reductions_guard();

-- ── Fleet bank: treasury ledger (recorded = observed movements; planned = not executed)
CREATE TABLE fleet_treasury_ledger (
  entry_id      bigserial   PRIMARY KEY,
  kind          text        NOT NULL CHECK (kind IN ('sweep_in','owner_funding_in','allocation_return_in',
                                                     'infrastructure','inference','maintenance','emergency_rescue',
                                                     'replacement_agent','approved_growth','compliance','contingency',
                                                     'owner_distribution')),
  amount_cents  bigint      NOT NULL CHECK (amount_cents > 0),
  status        text        NOT NULL CHECK (status IN ('recorded','planned_not_executed')),
  agent_id      text        REFERENCES fleet_agents(agent_id),
  allocation_id text,
  reference     text        CHECK (length(reference) <= 200),
  recorded_by   text        NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_treasury_ledger_no_change BEFORE UPDATE OR DELETE ON fleet_treasury_ledger
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_treasury_obligations (
  obligation_id text        PRIMARY KEY CHECK (obligation_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  category      text        NOT NULL,
  description   text        NOT NULL,
  amount_cents  bigint      NOT NULL CHECK (amount_cents > 0),
  due_at        timestamptz NOT NULL,
  status        text        NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','settled','cancelled')),
  approved_by   text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fleet_sweep_plans (
  plan_id      text        PRIMARY KEY CHECK (plan_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  agent_id     text        NOT NULL REFERENCES fleet_agents(agent_id),
  rate         numeric     NOT NULL CHECK (rate BETWEEN 0 AND 0.70),
  amount_cents bigint      NOT NULL CHECK (amount_cents >= 0),
  waterfall    jsonb       NOT NULL,
  status       text        NOT NULL DEFAULT 'planned_not_executed' CHECK (status IN ('planned_not_executed')),
  computed_by  text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_sweep_plans_no_change BEFORE UPDATE OR DELETE ON fleet_sweep_plans
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_owner_distributions (
  distribution_id        text        PRIMARY KEY CHECK (distribution_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  requested_cents        bigint      NOT NULL CHECK (requested_cents > 0),
  approved_cents         bigint      NOT NULL CHECK (approved_cents >= 0),
  treasury_balance_cents bigint      NOT NULL,
  reserve_target_cents   bigint      NOT NULL,
  obligations_cents      bigint      NOT NULL,
  destination            text,
  status                 text        NOT NULL CHECK (status IN ('rejected','planned_not_executed')),
  reason                 text        NOT NULL,
  decided_by             text        NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'planned_not_executed' OR approved_cents <= GREATEST(treasury_balance_cents - reserve_target_cents - obligations_cents, 0))
);
CREATE TRIGGER fleet_owner_distributions_no_change BEFORE UPDATE OR DELETE ON fleet_owner_distributions
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_custody_transfers (
  transfer_id   text        PRIMARY KEY CHECK (transfer_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  from_agent_id text        NOT NULL REFERENCES fleet_agents(agent_id),
  destination   text        NOT NULL CHECK (destination IN ('fleet_treasury','agent')),
  to_agent_id   text        REFERENCES fleet_agents(agent_id),
  amount_cents  bigint      NOT NULL CHECK (amount_cents > 0),
  policy        text        NOT NULL CHECK (policy IN ('quarantine_recovery','death_recovery','rebalance','sweep')),
  reason        text        NOT NULL,
  status        text        NOT NULL DEFAULT 'blocked_payments_disabled' CHECK (status IN ('blocked_payments_disabled')),
  approved_by   text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((destination = 'agent') = (to_agent_id IS NOT NULL)),
  CHECK (to_agent_id IS NULL OR to_agent_id <> from_agent_id)
);
CREATE FUNCTION fleet_custody_transfers_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM fleet_require_operator_approver(NEW.approved_by, NEW.from_agent_id);
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_custody_transfers_guard BEFORE INSERT ON fleet_custody_transfers
  FOR EACH ROW EXECUTE FUNCTION fleet_custody_transfers_guard();
CREATE TRIGGER fleet_custody_transfers_no_change BEFORE UPDATE OR DELETE ON fleet_custody_transfers
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- ── Agent API (authenticated; own identity only)

-- Propose capital use. Creates a PROPOSED allocation; approval is operator-only.
CREATE FUNCTION api_propose_allocation(p_agent text, p_token text, p_allocation_id text, p_purpose text,
                                       p_requested_cents bigint, p_expected_return_cents bigint, p_expected_duration_days integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'propose_allocation'); a fleet_agents;
BEGIN
  IF v_code IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code);
  END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent;
  IF a.status <> 'active' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_AGENT_UNHEALTHY');
  END IF;
  IF (SELECT count(*) FROM fleet_capital_allocations WHERE agent_id = p_agent AND status = 'proposed') >= 5 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_TOO_MANY_PROPOSALS');
  END IF;
  INSERT INTO fleet_capital_allocations (allocation_id, agent_id, purpose, requested_amount_cents,
                                         expected_return_cents, expected_duration_days, proposed_by)
  VALUES (p_allocation_id, p_agent, left(fleet_scrub(p_purpose), 500), p_requested_cents,
          COALESCE(p_expected_return_cents, 0), p_expected_duration_days, p_agent);
  PERFORM fleet_event('capital_requested', p_agent, p_agent,
    jsonb_build_object('allocationId', p_allocation_id, 'requestedCents', p_requested_cents));
  RETURN jsonb_build_object('ok', true, 'allocationId', p_allocation_id, 'status', 'proposed');
END $$;

-- Spend request against the caller's OWN custody wallet. Decision only:
-- nothing is signed or sent (the controller signer executes only when real
-- payments are enabled, which they are not).
CREATE FUNCTION api_request_spend(p_agent text, p_token text, p_request_id text, p_from_wallet text, p_to_address text,
                                  p_amount_cents bigint, p_purpose text, p_allocation_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'request_spend'); a fleet_agents; w fleet_wallet_custody;
        al fleet_capital_allocations; v_today bigint; v_decision text := 'approved_not_executed'; v_reason text;
BEGIN
  IF v_code IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code);
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 OR p_to_address !~ '^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent;
  SELECT * INTO w FROM fleet_wallet_custody WHERE agent_id = p_agent;
  IF w.agent_id IS NULL OR lower(p_from_wallet) IS DISTINCT FROM lower(w.wallet_address) THEN
    PERFORM fleet_event('authorization_denied', NULL, p_agent,
      jsonb_build_object('action', 'request_spend', 'fromWallet', left(p_from_wallet, 64)));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_AUTHORIZED', 'reason', 'not the caller''s custody wallet');
  END IF;
  SELECT COALESCE(sum(amount_cents), 0) INTO v_today FROM fleet_spend_requests
   WHERE agent_id = p_agent AND decision = 'approved_not_executed' AND created_at > now() - interval '1 day';
  IF a.status <> 'active' THEN v_decision := 'denied'; v_reason := 'agent not healthy (' || a.status || ')';
  ELSIF w.spending_frozen THEN v_decision := 'denied'; v_reason := 'spending frozen: ' || COALESCE(w.frozen_reason, '');
  ELSIF p_allocation_id IS NOT NULL THEN
    SELECT * INTO al FROM fleet_capital_allocations WHERE allocation_id = p_allocation_id;
    IF al.allocation_id IS NULL OR al.agent_id <> p_agent OR al.status <> 'approved'
       OR now() NOT BETWEEN al.start_date AND al.expiry_date THEN
      v_decision := 'denied'; v_reason := 'allocation not approved, not yours, or not current';
    ELSIF al.deployed_cents + p_amount_cents > al.approved_amount_cents THEN
      v_decision := 'denied'; v_reason := 'exceeds approved allocation';
    END IF;
  ELSIF v_today + p_amount_cents > w.daily_limit_cents THEN
    v_decision := 'denied'; v_reason := format('exceeds daily limit (%s cents)', w.daily_limit_cents);
  END IF;
  INSERT INTO fleet_spend_requests (request_id, agent_id, wallet_address, to_address, amount_cents, purpose, allocation_id, decision, reason)
  VALUES (p_request_id, p_agent, w.wallet_address, p_to_address, p_amount_cents, left(fleet_scrub(p_purpose), 300),
          p_allocation_id, v_decision, v_reason);
  PERFORM fleet_event(CASE WHEN v_decision = 'denied' THEN 'spend_denied' ELSE 'spend_approved_not_executed' END,
    p_agent, p_agent, jsonb_build_object('requestId', p_request_id, 'amountCents', p_amount_cents, 'reason', v_reason));
  RETURN jsonb_build_object('ok', v_decision <> 'denied', 'decision', v_decision, 'reason', v_reason, 'executed', false);
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

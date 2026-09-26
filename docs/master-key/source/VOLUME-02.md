# SOURCE VOLUME 02 — PostgreSQL migrations (src/fleet/postgres/migrations*.ts)

Exact, byte-for-byte text of each file at repository commit `efad2148a3460ab881b0ab845fb13c25d1fa3e74` (branch fleet-development).
No file in this volume contains a real secret; test fixtures generate synthetic secrets at runtime.
Each file's SHA-256 is of the file bytes on disk and matches 22-RECONSTRUCTION-MANIFEST.md.

## Files

- `src/fleet/postgres/migrations-phase5.ts` — 1209 lines, sha256 `4867898711d3706834cca6da9597e7a87c746bd60f1aeef485bf61a9e33e5fb1`
- `src/fleet/postgres/migrations-phase6.ts` — 428 lines, sha256 `67ec6e7202f5e7afac88b0c32b4e27c1a425230c6d3f5d6afefc8734e58b5261`
- `src/fleet/postgres/migrations-phase7.ts` — 241 lines, sha256 `181a2d7b12a3df19130a6e8e01b6711655c1ec36279483faf210705a7921e532`
- `src/fleet/postgres/migrations-phase8.ts` — 532 lines, sha256 `a9b93dc2cf4dbd7ba0417f681ace4c3520048847acc102cfbf0da62fa27bab9d`
- `src/fleet/postgres/migrations.ts` — 1289 lines, sha256 `49682d4af8f8c55849a2ebdc4fed4bad65f3279fe9f75ec5b6bf1b904ac4b0c4`

## `src/fleet/postgres/migrations-phase5.ts`

sha256 `4867898711d3706834cca6da9597e7a87c746bd60f1aeef485bf61a9e33e5fb1` · 71077 bytes · 1209 lines

```ts
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
```

## `src/fleet/postgres/migrations-phase6.ts`

sha256 `67ec6e7202f5e7afac88b0c32b4e27c1a425230c6d3f5d6afefc8734e58b5261` · 25751 bytes · 428 lines

```ts
/**
 * Phase 6 migration (schema v6). Applied by migrations.ts.
 *
 * Closes the Phase 5 "untracked sandbox window" (a sandbox could be created
 * while the provisioning callback that reports it was lost):
 *   - every provisioning attempt carries a provisioning key (= reservation
 *     id) and a deterministic sandbox name derived from it
 *     (fleet-<lower(key)>). The key travels through reservation, sandbox
 *     creation, the child's runtime manifest, the provisioning callbacks and
 *     activation.
 *   - a durable external-resource intent is recorded BEFORE the sandbox is
 *     created (svc_provision_update 'sandbox_intent'); create attempts are
 *     counted, so a retry looks the sandbox up by name before creating again.
 *   - a provisioning attempt that fails while its sandbox outcome is still
 *     unknown (intent recorded, no sandbox id) becomes ORPHANED instead of
 *     FAILED: capabilities revoked (lifecycle trigger), an orphan record is
 *     kept, and it holds a quarantine slot until reconciled
 *     (svc_provision_reconcile: found / absent / unknown) or the orphan hold
 *     elapses.
 *
 * DRY_RUN_CHILD (first remote child dry run):
 *   - fleet_reserve_dry_run(): operator-only (never granted), independent of
 *     the replication switch, at most one dry-run child at a time, only under
 *     a living root, only when the fleet cap is <= 2 and no orphan is open.
 *   - a dry-run agent can never replicate (insert guard), never gets spend
 *     authority (custody is forced frozen with a zero daily limit) and can
 *     never be allocated capital.
 */

export const V6_SQL = `
-- ── Provisioning key, deterministic sandbox name, external-resource intent
ALTER TABLE fleet_provisioning
  ADD COLUMN provisioning_key text,
  ADD COLUMN sandbox_name     text CHECK (sandbox_name ~ '^fleet-[0-9a-z]{26}$'),
  ADD COLUMN external_state   text NOT NULL DEFAULT 'none'
                              CHECK (external_state IN ('none','intent','created','absent','uncertain')),
  ADD COLUMN intent_at        timestamptz,
  ADD COLUMN create_attempts  integer NOT NULL DEFAULT 0 CHECK (create_attempts BETWEEN 0 AND 10),
  ADD COLUMN reconciled_at    timestamptz,
  ADD COLUMN reconcile_note   text,
  ADD COLUMN dry_run          boolean NOT NULL DEFAULT false;
UPDATE fleet_provisioning
   SET provisioning_key = provisioning_id,
       external_state = CASE WHEN sandbox_id IS NULL THEN 'none' ELSE 'created' END;
ALTER TABLE fleet_provisioning ALTER COLUMN provisioning_key SET NOT NULL;
CREATE UNIQUE INDEX fleet_provisioning_key_uq ON fleet_provisioning (provisioning_key);
CREATE UNIQUE INDEX fleet_provisioning_sandbox_name_uq ON fleet_provisioning (sandbox_name) WHERE sandbox_name IS NOT NULL;
CREATE INDEX fleet_provisioning_uncertain_idx ON fleet_provisioning (external_state)
  WHERE external_state IN ('intent','uncertain');

ALTER TABLE fleet_orphans ALTER COLUMN sandbox_id DROP NOT NULL;
ALTER TABLE fleet_orphans ADD COLUMN sandbox_name text;

ALTER TABLE fleet_agents ADD COLUMN dry_run boolean NOT NULL DEFAULT false;
ALTER TABLE fleet_reservations ADD COLUMN dry_run boolean NOT NULL DEFAULT false;

CREATE FUNCTION fleet_provisioning_defaults() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  NEW.provisioning_key := COALESCE(NEW.provisioning_key, NEW.provisioning_id);
  IF NEW.provisioning_key <> NEW.provisioning_id THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: provisioning key must equal the reservation id';
  END IF;
  NEW.dry_run := COALESCE((SELECT dry_run FROM fleet_reservations WHERE reservation_id = NEW.reservation_id), false);
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_provisioning_defaults BEFORE INSERT ON fleet_provisioning
  FOR EACH ROW EXECUTE FUNCTION fleet_provisioning_defaults();

CREATE FUNCTION fleet_provisioning_key_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provisioning_key IS DISTINCT FROM OLD.provisioning_key OR NEW.dry_run IS DISTINCT FROM OLD.dry_run
     OR (OLD.sandbox_name IS NOT NULL AND NEW.sandbox_name IS DISTINCT FROM OLD.sandbox_name)
     OR (OLD.sandbox_id IS NOT NULL AND NEW.sandbox_id IS DISTINCT FROM OLD.sandbox_id) THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: provisioning key, sandbox name/id and dry-run flag cannot change once set';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_provisioning_key_immutable BEFORE UPDATE ON fleet_provisioning
  FOR EACH ROW EXECUTE FUNCTION fleet_provisioning_key_immutable();

-- ── Transition guard (v6): PROVISIONING may become ORPHANED when its sandbox
-- outcome is uncertain; the dry-run flag is part of an agent's identity.
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
     OR OLD.created_at <> NEW.created_at OR OLD.dry_run <> NEW.dry_run THEN
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
    OR (OLD.status = 'provisioning' AND NEW.status IN ('active','failed','orphaned'))
    OR (OLD.status = 'active'       AND NEW.status IN ('unresponsive','terminating','dead'))
    OR (OLD.status = 'unresponsive' AND NEW.status IN ('active','terminating','dead'))
    OR (OLD.status = 'terminating'  AND NEW.status IN ('orphaned','dead'))
    OR (OLD.status = 'orphaned'     AND NEW.status = 'dead')
  ) THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;

-- A provisioning attempt that fails while a sandbox MAY exist (intent
-- recorded, sandbox id never reported) is not allowed to free its slot:
-- whatever path fails it (lease expiry, verification failure, parent report),
-- it becomes ORPHANED. Named to sort before the other BEFORE triggers.
CREATE FUNCTION fleet_agents_provisioning_uncertain() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_provisioning;
BEGIN
  IF OLD.status = 'provisioning' AND NEW.status = 'failed' THEN
    SELECT * INTO p FROM fleet_provisioning WHERE expected_agent_id = NEW.agent_id;
    IF FOUND AND p.sandbox_id IS NULL AND p.external_state IN ('intent','uncertain') THEN
      NEW.status := 'orphaned';
      NEW.death_time := NULL;
      NEW.status_reason := left(COALESCE(NEW.status_reason, 'provisioning failed')
        || '; sandbox creation outcome unknown (quarantine slot held until reconciled)', 500);
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_agents_a_provisioning_uncertain BEFORE UPDATE OF status ON fleet_agents
  FOR EACH ROW EXECUTE FUNCTION fleet_agents_provisioning_uncertain();

CREATE FUNCTION fleet_agents_uncertain_effects() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_provisioning;
BEGIN
  IF OLD.status = 'provisioning' AND NEW.status = 'orphaned' THEN
    SELECT * INTO p FROM fleet_provisioning WHERE expected_agent_id = NEW.agent_id FOR UPDATE;
    UPDATE fleet_provisioning
       SET status = 'orphaned', external_state = 'uncertain', cleanup_status = 'pending',
           failure_reason = left(NEW.status_reason, 500), updated_at = now()
     WHERE provisioning_id = p.provisioning_id;
    INSERT INTO fleet_orphans (agent_id, provisioning_id, sandbox_id, sandbox_name, reason, holds_slot)
    VALUES (NEW.agent_id, p.provisioning_id, NULL, p.sandbox_name,
            'provisioning outcome uncertain: sandbox creation was requested but never confirmed', true)
    ON CONFLICT DO NOTHING;
    PERFORM fleet_event('provisioning_uncertain', NEW.agent_id, 'lifecycle',
      jsonb_build_object('provisioningKey', p.provisioning_key, 'sandboxName', p.sandbox_name,
                         'createAttempts', p.create_attempts, 'holdsSlot', true, 'capabilitiesRevoked', true));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_agents_uncertain_effects AFTER UPDATE OF status ON fleet_agents
  FOR EACH ROW EXECUTE FUNCTION fleet_agents_uncertain_effects();

-- A confirmed termination of an ORPHANED agent's sandbox resolves the orphan
-- and frees its quarantine slot (the orphan record stays, resolved).
CREATE FUNCTION fleet_terminations_resolve_orphan() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF NEW.status = 'terminated' AND OLD.status IS DISTINCT FROM 'terminated' THEN
    UPDATE fleet_orphans SET resolved_at = now(), resolution = 'sandbox termination confirmed', resolved_by = 'lifecycle'
     WHERE agent_id = NEW.agent_id AND resolved_at IS NULL;
    UPDATE fleet_agents SET status = 'dead', death_time = now(), updated_at = now(),
           status_reason = left(COALESCE(status_reason, '') || '; sandbox termination confirmed', 500)
     WHERE agent_id = NEW.agent_id AND status = 'orphaned';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_terminations_resolve_orphan AFTER UPDATE OF status ON fleet_sandbox_terminations
  FOR EACH ROW EXECUTE FUNCTION fleet_terminations_resolve_orphan();

-- ── Provisioning callbacks (v6): durable intent BEFORE the sandbox exists.
CREATE OR REPLACE FUNCTION svc_provision_update(p_agent text, p_parent text, p_phase text, p_sandbox text) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_provisioning; a fleet_agents;
BEGIN
  SELECT * INTO p FROM fleet_provisioning WHERE expected_agent_id = p_agent FOR UPDATE;
  IF NOT FOUND OR (p_parent IS NOT NULL AND p.parent_agent_id <> p_parent) THEN
    PERFORM fleet_event('authorization_denied', NULL, p_parent, jsonb_build_object('action', 'provision_update', 'agentId', left(p_agent, 64)));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_AUTHORIZED');
  END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent;
  IF p_phase = 'sandbox_intent' THEN
    -- p_sandbox carries the deterministic sandbox NAME, not an id.
    IF p_sandbox IS DISTINCT FROM 'fleet-' || lower(p.provisioning_key) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'sandbox name must be derived from the provisioning key');
    END IF;
    IF p.sandbox_id IS NOT NULL THEN
      -- The sandbox is already known: a retry must reuse it, never create another.
      RETURN jsonb_build_object('ok', true, 'provisioningKey', p.provisioning_key, 'sandboxName', p.sandbox_name,
                                'sandboxId', p.sandbox_id, 'attempts', p.create_attempts);
    END IF;
    IF p.status <> 'provisioning' OR a.status <> 'provisioning' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE');
    END IF;
    IF p.create_attempts >= 3 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PROVISIONING_UNCERTAIN',
                                'reason', 'too many sandbox create attempts; reconcile before retrying');
    END IF;
    UPDATE fleet_provisioning
       SET sandbox_name = p_sandbox, external_state = 'intent', intent_at = COALESCE(intent_at, now()),
           create_attempts = create_attempts + 1, updated_at = now()
     WHERE provisioning_id = p.provisioning_id
     RETURNING * INTO p;
    PERFORM fleet_event('provisioning_sandbox_intent', p_agent, p_parent,
      jsonb_build_object('provisioningKey', p.provisioning_key, 'sandboxName', p.sandbox_name, 'attempt', p.create_attempts));
    RETURN jsonb_build_object('ok', true, 'provisioningKey', p.provisioning_key, 'sandboxName', p.sandbox_name,
                              'sandboxId', NULL, 'attempts', p.create_attempts);
  ELSIF p_phase = 'sandbox_created' THEN
    IF p_sandbox IS NULL OR length(p_sandbox) NOT BETWEEN 1 AND 128 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
    END IF;
    IF p.sandbox_id IS NOT NULL AND p.sandbox_id <> p_sandbox THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_SANDBOX_MISMATCH');
    END IF;
    UPDATE fleet_provisioning SET sandbox_id = p_sandbox, external_state = 'created', updated_at = now()
     WHERE provisioning_id = p.provisioning_id;
    -- A sandbox reported after the attempt already failed is queued for cleanup at once.
    IF p.status IN ('failed_provisioning','orphaned') THEN
      UPDATE fleet_provisioning SET cleanup_status = 'pending'
       WHERE provisioning_id = p.provisioning_id AND cleanup_status IN ('not_required','none');
      UPDATE fleet_orphans SET sandbox_id = p_sandbox WHERE agent_id = p_agent AND resolved_at IS NULL AND sandbox_id IS NULL;
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
  RETURN jsonb_build_object('ok', true, 'provisioningId', p.provisioning_id, 'provisioningKey', p.provisioning_key);
END $$;

-- ── Reconciliation of an uncertain sandbox outcome (parent via the service,
-- or the operator). found: the sandbox exists -> recorded, queued for
-- cleanup if the attempt is over. absent: confirmed never created (only
-- after the activation deadline, so no create can still be in flight) ->
-- the quarantine slot is freed. unknown: the provider cannot tell -> stays
-- uncertain (slot held).
CREATE FUNCTION svc_provision_reconcile(p_key text, p_outcome text, p_sandbox text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_provisioning; a fleet_agents;
BEGIN
  IF p_outcome NOT IN ('found','absent','unknown') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  PERFORM fleet_lock_state();
  SELECT * INTO p FROM fleet_provisioning WHERE provisioning_key = p_key FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND');
  END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p.expected_agent_id FOR UPDATE;
  IF p_outcome = 'found' THEN
    IF p_sandbox IS NULL OR length(p_sandbox) NOT BETWEEN 1 AND 128 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
    END IF;
    IF p.sandbox_id IS NOT NULL AND p.sandbox_id <> p_sandbox THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_SANDBOX_MISMATCH');
    END IF;
    UPDATE fleet_provisioning SET sandbox_id = p_sandbox, external_state = 'created', reconciled_at = now(),
           reconcile_note = 'found by provisioning key', updated_at = now()
     WHERE provisioning_id = p.provisioning_id;
    IF a.status NOT IN ('reserved','provisioning','active','unresponsive') THEN
      UPDATE fleet_provisioning SET cleanup_status = 'pending'
       WHERE provisioning_id = p.provisioning_id AND cleanup_status IN ('none','not_required');
      UPDATE fleet_orphans SET sandbox_id = p_sandbox WHERE agent_id = a.agent_id AND resolved_at IS NULL AND sandbox_id IS NULL;
      INSERT INTO fleet_sandbox_terminations (agent_id, sandbox_id, status) VALUES (a.agent_id, p_sandbox, 'pending')
        ON CONFLICT (agent_id) DO NOTHING;
      PERFORM fleet_event('sandbox_termination_requested', a.agent_id, p_actor,
        jsonb_build_object('sandboxId', p_sandbox, 'provisioningKey', p_key, 'phase', 'reconciled'));
    END IF;
  ELSIF p_outcome = 'absent' THEN
    IF p.sandbox_id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_SANDBOX_KNOWN', 'reason', 'a sandbox was reported for this provisioning');
    END IF;
    IF a.status IN ('reserved','provisioning') AND now() < p.activation_deadline THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PROVISIONING_IN_FLIGHT',
                                'reason', 'absence can only be concluded after the activation deadline');
    END IF;
    UPDATE fleet_provisioning
       SET external_state = 'absent', cleanup_status = 'not_required', reconciled_at = now(),
           reconcile_note = 'confirmed absent', updated_at = now(),
           status = CASE WHEN status = 'orphaned' THEN 'failed_provisioning' ELSE status END
     WHERE provisioning_id = p.provisioning_id;
    UPDATE fleet_orphans SET resolved_at = now(), resolution = 'reconciled: sandbox never created', resolved_by = left(p_actor, 128)
     WHERE agent_id = a.agent_id AND resolved_at IS NULL AND sandbox_id IS NULL;
    IF a.status = 'orphaned' THEN
      UPDATE fleet_agents SET status = 'dead', death_time = now(), updated_at = now(),
             status_reason = left(COALESCE(status_reason, '') || '; reconciled: sandbox never created', 500)
       WHERE agent_id = a.agent_id;
      PERFORM fleet_event('slot_released', a.agent_id, p_actor, jsonb_build_object('reason', 'reconciled: sandbox never created'));
    END IF;
  ELSE
    UPDATE fleet_provisioning SET external_state = CASE WHEN sandbox_id IS NULL THEN 'uncertain' ELSE external_state END,
           reconciled_at = now(), reconcile_note = left(COALESCE(p_sandbox, 'provider could not confirm'), 300), updated_at = now()
     WHERE provisioning_id = p.provisioning_id;
  END IF;
  PERFORM fleet_event('provisioning_reconciled', a.agent_id, p_actor,
    jsonb_build_object('provisioningKey', p_key, 'outcome', p_outcome, 'sandboxId', CASE WHEN p_outcome = 'found' THEN p_sandbox END));
  RETURN jsonb_build_object('ok', true, 'outcome', p_outcome, 'agentStatus', (SELECT status FROM fleet_agents WHERE agent_id = a.agent_id));
END $$;

-- ── DRY_RUN_CHILD
-- Operator-only (the admin credential; never granted to the service or
-- agent roles). Independent of the replication switch so the first remote
-- child can be proven while REAL_REPLICATION_ENABLED stays false.
CREATE FUNCTION fleet_reserve_dry_run(p_parent text, p_requested_by text, p_name text, p_agent_id text,
                                      p_reservation_id text, p_ttl_ms bigint) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE st fleet_state; par fleet_agents; v_orphans integer; v_code text; v_reason text; v_exp timestamptz;
BEGIN
  PERFORM fleet_lock_state();
  PERFORM fleet_expire_leases(p_requested_by);
  SELECT * INTO st FROM fleet_state WHERE id = 1;
  SELECT count(*) INTO v_orphans FROM fleet_orphans WHERE resolved_at IS NULL;
  IF st.operating_mode NOT IN ('DEVELOPMENT','EXPANSION') THEN
    v_code := 'FLEET_' || st.operating_mode; v_reason := format('Shared fleet state is %s.', st.operating_mode);
  ELSIF st.runtime_repo IS NULL OR st.runtime_build_id IS NULL THEN
    v_code := 'FLEET_RUNTIME_UNVERIFIED'; v_reason := 'No fleet-approved runtime build.';
  ELSIF v_orphans > 0 THEN
    v_code := 'FLEET_ORPHANS_UNRESOLVED'; v_reason := format('%s unresolved orphan(s); a dry run needs none.', v_orphans);
  ELSIF st.max_agents > 2 THEN
    v_code := 'FLEET_DRY_RUN_CAP'; v_reason := format('The dry run requires a fleet cap of at most 2 (cap is %s).', st.max_agents);
  ELSIF EXISTS (SELECT 1 FROM fleet_agents WHERE dry_run
                  AND status IN ('reserved','provisioning','active','unresponsive','terminating','orphaned')) THEN
    v_code := 'FLEET_DRY_RUN_IN_PROGRESS'; v_reason := 'A dry-run child already exists; quarantine or retire it first.';
  ELSIF st.living_agents + st.reserved_slots + st.quarantined_slots >= st.max_agents THEN
    v_code := 'FLEET_CAP_REACHED';
    v_reason := format('Fleet at cap (%s living + %s reserved + %s quarantined >= %s).',
                       st.living_agents, st.reserved_slots, st.quarantined_slots, st.max_agents);
  ELSE
    SELECT * INTO par FROM fleet_agents WHERE agent_id = p_parent;
    IF NOT FOUND OR par.role <> 'root' OR par.status <> 'active' OR par.dry_run THEN
      v_code := 'FLEET_PARENT_NOT_LIVING'; v_reason := 'The dry-run parent must be a living root agent.';
    END IF;
  END IF;
  IF v_code IS NOT NULL THEN
    PERFORM fleet_event('reservation_denied', NULL, p_requested_by, jsonb_build_object('code', v_code, 'dryRun', true));
    RETURN jsonb_build_object('ok', false, 'code', v_code, 'reason', v_reason,
      'living', st.living_agents, 'reserved', st.reserved_slots, 'max', st.max_agents);
  END IF;
  v_exp := now() + make_interval(secs => COALESCE(p_ttl_ms, st.reservation_ttl_s::bigint * 1000)::double precision / 1000);
  INSERT INTO fleet_agents (agent_id, parent_agent_id, role, generation, name, runtime_repo, runtime_commit,
                            status, requested_by, request_key, reservation_expires_at, dry_run)
  VALUES (p_agent_id, p_parent, 'child', par.generation + 1, p_name, st.runtime_repo, st.runtime_commit,
          'reserved', p_requested_by, 'dry-run:' || p_reservation_id, v_exp, true);
  INSERT INTO fleet_reservations (reservation_id, agent_id, parent_agent_id, status, expires_at,
                                  expected_repo, expected_commit, expected_build_id, expected_lockfile_sha256, dry_run)
  VALUES (p_reservation_id, p_agent_id, p_parent, 'reserved', v_exp,
          st.runtime_repo, st.runtime_commit, st.runtime_build_id, st.runtime_lockfile_sha256, true);
  PERFORM fleet_event('slot_reserved', p_agent_id, p_requested_by, jsonb_build_object(
    'reservationId', p_reservation_id, 'dryRun', true, 'living', st.living_agents, 'reserved', st.reserved_slots + 1,
    'max', st.max_agents, 'expiresAt', v_exp));
  RETURN jsonb_build_object('ok', true, 'agentId', p_agent_id, 'reservationId', p_reservation_id,
    'parentAgentId', p_parent, 'generation', par.generation + 1, 'expiresAt', v_exp, 'dryRun', true,
    'runtime', jsonb_build_object('repo', st.runtime_repo, 'commit', st.runtime_commit),
    'build', jsonb_build_object('buildId', st.runtime_build_id, 'lockfileSha256', st.runtime_lockfile_sha256));
END $$;

-- A dry-run agent can never be a parent (whatever path inserts the child).
CREATE FUNCTION fleet_agents_dry_run_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF NEW.parent_agent_id IS NOT NULL AND EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = NEW.parent_agent_id AND dry_run) THEN
    PERFORM fleet_event('replication_rejected', NULL, NEW.parent_agent_id,
      jsonb_build_object('code', 'FLEET_DRY_RUN_NO_REPLICATION'));
    RAISE EXCEPTION 'FLEET_DRY_RUN_NO_REPLICATION: dry-run agent % cannot replicate', NEW.parent_agent_id;
  END IF;
  IF NEW.dry_run AND NEW.role <> 'child' THEN
    RAISE EXCEPTION 'FLEET_DRY_RUN_NO_REPLICATION: only children can be dry-run agents';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_agents_dry_run_guard BEFORE INSERT ON fleet_agents
  FOR EACH ROW EXECUTE FUNCTION fleet_agents_dry_run_guard();

-- A dry-run agent never has spend authority: its custody record is always
-- frozen with a zero daily limit, whatever writes it.
CREATE FUNCTION fleet_custody_dry_run_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = NEW.agent_id AND dry_run) THEN
    NEW.spending_frozen := true;
    NEW.daily_limit_cents := 0;
    NEW.frozen_reason := COALESCE(NEW.frozen_reason, 'dry-run child: no spend authority');
    NEW.frozen_at := COALESCE(NEW.frozen_at, now());
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_custody_dry_run_guard BEFORE INSERT OR UPDATE ON fleet_wallet_custody
  FOR EACH ROW EXECUTE FUNCTION fleet_custody_dry_run_guard();

CREATE FUNCTION fleet_allocations_dry_run_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = NEW.agent_id AND dry_run) THEN
    RAISE EXCEPTION 'FLEET_DRY_RUN_NO_SPEND: dry-run agent % cannot hold capital', NEW.agent_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_allocations_dry_run_guard BEFORE INSERT ON fleet_capital_allocations
  FOR EACH ROW EXECUTE FUNCTION fleet_allocations_dry_run_guard();

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
```

## `src/fleet/postgres/migrations-phase7.ts`

sha256 `181a2d7b12a3df19130a6e8e01b6711655c1ec36279483faf210705a7921e532` · 13961 bytes · 241 lines

```ts
/**
 * FLEET-KI-4 migration (schema v7): capability scope on the agent identity.
 *
 * fleet_agents.capability_scope is 'full' (every existing agent, unchanged
 * behaviour) or 'witness': a root that exists only to be the living parent of
 * the operator-controlled dry run. It is set at enrollment by the operator
 * and can never change afterwards. Because it lives on the agent row, which
 * fleet_authenticate() already reads for both the long-lived credential and
 * every session, credential rotation and fa1 -> fs1 exchange cannot escape it.
 *
 * A witness identity:
 *   - may authenticate only the api_* actions open_session, heartbeat and
 *     whoami; every other action, including any future one, fails closed
 *     with FLEET_SCOPE_DENIED (fleet_authenticate);
 *   - is refused as a parent by the normal allocator (fleet_reserve_slot)
 *     and by an insert guard on fleet_agents, but stays acceptable to the
 *     operator-only fleet_reserve_dry_run (dry-run children only);
 *   - never has spend authority or capital (custody forced frozen, zero limit).
 *
 * svc_* functions are unchanged: the operator's dry run passes the witness
 * root as parent to svc_claim / svc_activate / svc_provision_update, so the
 * agent-facing lease routes are denied by the fleet service's route policy
 * (src/fleet/service/server.ts), not in the database.
 */

export const WITNESS_API_ACTIONS: readonly string[] = Object.freeze(["open_session", "heartbeat", "whoami"]);

export function v7Sql(hardMax: number): string {
  return `
-- ── Capability scope (identity, immutable)
ALTER TABLE fleet_agents ADD COLUMN capability_scope text NOT NULL DEFAULT 'full'
  CONSTRAINT fleet_agents_capability_scope_valid CHECK (capability_scope IN ('full','witness'));
ALTER TABLE fleet_agents ADD CONSTRAINT fleet_agents_witness_is_root
  CHECK (capability_scope = 'full' OR (role = 'root' AND NOT dry_run AND parent_agent_id IS NULL));

CREATE FUNCTION fleet_agents_scope_immutable() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: capability_scope of agent % cannot change after enrollment', OLD.agent_id;
END $$;
-- Named to sort after every other BEFORE UPDATE trigger, so its WHEN sees their changes.
CREATE TRIGGER fleet_agents_zz_scope_immutable BEFORE UPDATE ON fleet_agents
  FOR EACH ROW WHEN (OLD.capability_scope IS DISTINCT FROM NEW.capability_scope)
  EXECUTE FUNCTION fleet_agents_scope_immutable();

-- A restricted identity can never be the parent of a normal child, whatever
-- path inserts it. Dry-run children (operator-only fleet_reserve_dry_run) are allowed.
CREATE FUNCTION fleet_agents_scope_parent_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF NEW.parent_agent_id IS NOT NULL AND NOT NEW.dry_run
     AND EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = NEW.parent_agent_id AND capability_scope <> 'full') THEN
    RAISE EXCEPTION 'FLEET_PARENT_SCOPE: agent % has a restricted capability scope and cannot replicate', NEW.parent_agent_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_agents_scope_parent_guard BEFORE INSERT ON fleet_agents
  FOR EACH ROW EXECUTE FUNCTION fleet_agents_scope_parent_guard();

-- No spend authority for dry-run agents (v6) or restricted identities (v7):
-- custody is always frozen with a zero daily limit, whatever writes it.
CREATE OR REPLACE FUNCTION fleet_custody_dry_run_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_agents;
BEGIN
  SELECT * INTO a FROM fleet_agents WHERE agent_id = NEW.agent_id;
  IF FOUND AND (a.dry_run OR a.capability_scope <> 'full') THEN
    NEW.spending_frozen := true;
    NEW.daily_limit_cents := 0;
    NEW.frozen_reason := COALESCE(NEW.frozen_reason,
      CASE WHEN a.dry_run THEN 'dry-run child: no spend authority'
           ELSE a.capability_scope || ' identity: no spend authority' END);
    NEW.frozen_at := COALESCE(NEW.frozen_at, now());
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION fleet_allocations_dry_run_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = NEW.agent_id AND dry_run) THEN
    RAISE EXCEPTION 'FLEET_DRY_RUN_NO_SPEND: dry-run agent % cannot hold capital', NEW.agent_id;
  END IF;
  IF EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = NEW.agent_id AND capability_scope <> 'full') THEN
    RAISE EXCEPTION 'FLEET_SCOPE_DENIED: restricted identity % cannot hold capital', NEW.agent_id;
  END IF;
  RETURN NEW;
END $$;

-- ── Authentication (v4) + capability scope. Unchanged for 'full'. A
-- restricted identity passes only an explicit allow-list of actions; any
-- other action, and any unknown scope, fails closed.
CREATE OR REPLACE FUNCTION fleet_authenticate(p_agent text, p_token text, p_action text) RETURNS text LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_agent_credentials; s fleet_agent_sessions; v_status text; v_scope text; v_hash text;
BEGIN
  IF p_agent IS NULL OR p_token IS NULL OR length(p_token) > 256 OR length(p_agent) > 64 THEN
    PERFORM fleet_event('db_auth_failed', NULL, NULL, jsonb_build_object('action', p_action, 'why', 'malformed'));
    RETURN 'FLEET_AUTH_FAILED';
  END IF;
  v_hash := encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  SELECT status, capability_scope INTO v_status, v_scope FROM fleet_agents WHERE agent_id = p_agent;
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
  IF v_scope IS DISTINCT FROM 'full'
     AND NOT (v_scope = 'witness' AND p_action IN ('open_session','heartbeat','whoami')) THEN
    PERFORM fleet_event('scope_denied', p_agent, p_agent,
      jsonb_build_object('action', left(COALESCE(p_action, ''), 64), 'scope', v_scope, 'layer', 'database'));
    RETURN 'FLEET_SCOPE_DENIED';
  END IF;
  RETURN NULL;
END $$;

-- whoami (v2) + capability scope, so an agent (and the witness) can see its own scope.
CREATE OR REPLACE FUNCTION api_whoami(p_agent text, p_token text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'whoami'); a fleet_agents;
BEGIN
  IF v_code IS NOT NULL AND v_code <> 'FLEET_AGENT_DEAD' THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code);
  END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent;
  RETURN jsonb_build_object('ok', v_code IS NULL, 'code', v_code, 'agent', jsonb_build_object(
    'agentId', a.agent_id, 'parentAgentId', a.parent_agent_id, 'role', a.role, 'generation', a.generation,
    'name', a.name, 'walletAddress', a.wallet_address, 'runtimeVersion', a.runtime_version,
    'runtimeRepo', a.runtime_repo, 'runtimeCommit', a.runtime_commit, 'sandboxId', a.sandbox_id,
    'localChildId', a.local_child_id, 'status', a.status, 'statusReason', a.status_reason,
    'requestedBy', a.requested_by, 'createdAt', a.created_at, 'updatedAt', a.updated_at,
    'lastHeartbeat', a.last_heartbeat, 'deathTime', a.death_time, 'capabilityScope', a.capability_scope));
END $$;

-- ── Slot allocator (v4) + a restricted parent is refused (FLEET_PARENT_SCOPE).
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
    ELSIF par.capability_scope <> 'full' THEN
      v_code := 'FLEET_PARENT_SCOPE'; v_reason := format('Parent has the restricted capability scope %s and cannot replicate.', par.capability_scope);
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

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
}
```

## `src/fleet/postgres/migrations-phase8.ts`

sha256 `a9b93dc2cf4dbd7ba0417f681ace4c3520048847acc102cfbf0da62fa27bab9d` · 30999 bytes · 532 lines

```ts
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
```

## `src/fleet/postgres/migrations.ts`

sha256 `49682d4af8f8c55849a2ebdc4fed4bad65f3279fe9f75ec5b6bf1b904ac4b0c4` · 68934 bytes · 1289 lines

```ts
/**
 * Shared Fleet Registry — PostgreSQL migrations
 *
 * Applied by the operator (`pnpm fleet:migrate`), never by agents. Each
 * migration runs in its own transaction while holding an advisory lock, so
 * concurrent migrators serialise. Objects are created unqualified inside the
 * target schema (search_path is set per transaction); trigger functions pin
 * their search_path so they cannot be redirected by a caller.
 *
 * No secrets are stored: wallet_address is constrained to public-address
 * formats, and the event log is JSON detail scrubbed by the store.
 */

import type { PoolClient } from "pg";
import { V5_SQL, v4Sql } from "./migrations-phase5.js";
import { V6_SQL } from "./migrations-phase6.js";
import { v7Sql } from "./migrations-phase7.js";
import { V8_SQL } from "./migrations-phase8.js";

export const FLEET_PG_SCHEMA_VERSION = 8;
export const FLEET_PG_HARD_MAX_AGENTS = 50;
const MIGRATION_LOCK_KEY = 0x464c4545; // "FLEE"

export interface PgMigration {
  version: number;
  name: string;
  sql: string;
}

const V1 = `
CREATE TABLE fleet_state (
  id              smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  living_agents   integer     NOT NULL DEFAULT 0 CHECK (living_agents >= 0),
  reserved_slots  integer     NOT NULL DEFAULT 0 CHECK (reserved_slots >= 0),
  max_agents      integer     NOT NULL DEFAULT 1 CHECK (max_agents BETWEEN 1 AND ${FLEET_PG_HARD_MAX_AGENTS}),
  operating_mode  text        NOT NULL DEFAULT 'DEVELOPMENT'
                              CHECK (operating_mode IN ('DEVELOPMENT','EXPANSION','HARVEST','EMERGENCY')),
  runtime_repo    text,
  runtime_commit  text        CHECK (runtime_commit ~ '^[0-9a-f]{40}$'),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (living_agents + reserved_slots <= ${FLEET_PG_HARD_MAX_AGENTS}),
  CHECK ((runtime_repo IS NULL) = (runtime_commit IS NULL))
);
INSERT INTO fleet_state (id) VALUES (1);

CREATE TABLE fleet_agents (
  agent_id               text        PRIMARY KEY CHECK (agent_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  parent_agent_id        text        REFERENCES fleet_agents(agent_id),
  role                   text        NOT NULL CHECK (role IN ('root','child')),
  generation             integer     NOT NULL CHECK (generation >= 0),
  name                   text        NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  wallet_address         text        CHECK (wallet_address ~ '^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$'),
  runtime_version        text        CHECK (length(runtime_version) <= 64),
  runtime_repo           text,
  runtime_commit         text        CHECK (runtime_commit ~ '^[0-9a-f]{40}$'),
  sandbox_id             text,
  local_child_id         text,
  status                 text        NOT NULL CHECK (status IN ('reserved','provisioning','active','dead','failed')),
  status_reason          text,
  requested_by           text,
  request_key            text        UNIQUE,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  last_heartbeat         timestamptz,
  reservation_expires_at timestamptz,
  death_time             timestamptz,
  CHECK ((status IN ('dead','failed')) = (death_time IS NOT NULL)),
  CHECK ((role = 'root') = (parent_agent_id IS NULL)),
  CHECK (role = 'child' OR generation = 0),
  CHECK (role = 'root' OR generation >= 1),
  CHECK (status NOT IN ('reserved','provisioning') OR role = 'child'),
  CHECK (status <> 'active' OR wallet_address IS NOT NULL),
  CHECK (role = 'root' OR runtime_commit IS NOT NULL)
);
-- A wallet belongs to exactly one agent, ever (duplicate registration guard).
CREATE UNIQUE INDEX fleet_agents_wallet_uq ON fleet_agents (lower(wallet_address)) WHERE wallet_address IS NOT NULL;
-- A local child id / sandbox can back at most one living agent.
CREATE UNIQUE INDEX fleet_agents_child_uq ON fleet_agents (local_child_id) WHERE local_child_id IS NOT NULL;
CREATE UNIQUE INDEX fleet_agents_sandbox_live_uq ON fleet_agents (sandbox_id)
  WHERE sandbox_id IS NOT NULL AND status IN ('reserved','provisioning','active');
CREATE INDEX fleet_agents_status_idx ON fleet_agents (status);
CREATE INDEX fleet_agents_parent_idx ON fleet_agents (parent_agent_id);

CREATE TABLE fleet_events (
  id          bigserial   PRIMARY KEY,
  event_type  text        NOT NULL,
  agent_id    text,
  actor       text,
  detail      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_events_agent_idx ON fleet_events (agent_id, id);

-- Status buckets: 'reserved' + 'provisioning' -> reserved_slots, 'active' -> living_agents.
CREATE FUNCTION fleet_bucket(s text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN s IN ('reserved','provisioning') THEN 'reserved'
              WHEN s = 'active' THEN 'living'
              ELSE NULL END
$$;

-- Maintains fleet_state counters and enforces the cap at the row level.
-- Updating fleet_state takes the same row lock reservations use, so even raw
-- SQL is serialised and capped.
CREATE FUNCTION fleet_agents_counters() RETURNS trigger LANGUAGE plpgsql
SET search_path FROM CURRENT AS $$
DECLARE
  old_b text := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE fleet_bucket(OLD.status) END;
  new_b text := fleet_bucket(NEW.status);
  st fleet_state%ROWTYPE;
BEGIN
  IF old_b IS NOT DISTINCT FROM new_b THEN
    RETURN NEW;
  END IF;
  UPDATE fleet_state SET
    living_agents  = living_agents
                     + (CASE WHEN new_b = 'living' THEN 1 ELSE 0 END)
                     - (CASE WHEN old_b = 'living' THEN 1 ELSE 0 END),
    reserved_slots = reserved_slots
                     + (CASE WHEN new_b = 'reserved' THEN 1 ELSE 0 END)
                     - (CASE WHEN old_b = 'reserved' THEN 1 ELSE 0 END),
    updated_at = now()
  WHERE id = 1
  RETURNING * INTO st;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FLEET_CAP_EXCEEDED: fleet_state missing (fail closed)';
  END IF;
  -- Entering the living/reserved population from outside it must respect the cap.
  IF old_b IS NULL AND new_b IS NOT NULL AND st.living_agents + st.reserved_slots > st.max_agents THEN
    RAISE EXCEPTION 'FLEET_CAP_EXCEEDED: % living + % reserved > max %', st.living_agents, st.reserved_slots, st.max_agents;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fleet_agents_counters_ins AFTER INSERT ON fleet_agents
  FOR EACH ROW EXECUTE FUNCTION fleet_agents_counters();
CREATE TRIGGER fleet_agents_counters_upd AFTER UPDATE OF status ON fleet_agents
  FOR EACH ROW EXECUTE FUNCTION fleet_agents_counters();

-- Lifecycle guard: only forward transitions; terminal rows never change status.
CREATE FUNCTION fleet_agents_transition_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path FROM CURRENT AS $$
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
    OR (OLD.status = 'active'       AND NEW.status = 'dead')
  ) THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fleet_agents_transition_guard BEFORE INSERT OR UPDATE ON fleet_agents
  FOR EACH ROW EXECUTE FUNCTION fleet_agents_transition_guard();

CREATE FUNCTION fleet_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: % on % is not allowed', TG_OP, TG_TABLE_NAME;
END $$;

CREATE TRIGGER fleet_agents_no_delete BEFORE DELETE ON fleet_agents
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_agents_no_truncate BEFORE TRUNCATE ON fleet_agents
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_events_no_change BEFORE UPDATE OR DELETE ON fleet_events
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_events_no_truncate BEFORE TRUNCATE ON fleet_events
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_state_no_delete BEFORE DELETE ON fleet_state
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_state_no_truncate BEFORE TRUNCATE ON fleet_state
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- Counters are trigger-maintained; direct edits are refused.
CREATE FUNCTION fleet_state_counter_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() = 1 AND (NEW.living_agents <> OLD.living_agents OR NEW.reserved_slots <> OLD.reserved_slots) THEN
    RAISE EXCEPTION 'FLEET_COUNTERS_READ_ONLY: living_agents/reserved_slots are derived from fleet_agents';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_state_counter_guard BEFORE UPDATE ON fleet_state
  FOR EACH ROW EXECUTE FUNCTION fleet_state_counter_guard();
`;

/**
 * V2 — Phase 3: reservation leases, heartbeat expiry, restricted agent API.
 *
 * Every function that changes slot occupancy locks the fleet_state row first
 * (same lock order as V1 reservations), so the reaper, releases and
 * reservations serialise and cannot deadlock. SECURITY DEFINER functions pin
 * search_path to the fleet schema followed by pg_temp, so a caller cannot
 * shadow fleet tables with temporary objects.
 *
 * api_* functions are the whole surface of the restricted agent role: each
 * one authenticates the calling agent by (agent_id, token) against a SHA-256
 * hash, acts only on that agent's own row (or reservations it parents), and
 * returns a JSON result instead of raising so that authorization failures
 * are committed to the audit log.
 */
const V2 = `
-- ── Agent status: 'unresponsive' (missed heartbeats; still holds its living slot)
ALTER TABLE fleet_agents DROP CONSTRAINT fleet_agents_status_check;
ALTER TABLE fleet_agents ADD CONSTRAINT fleet_agents_status_check
  CHECK (status IN ('reserved','provisioning','active','unresponsive','dead','failed'));
ALTER TABLE fleet_agents ADD CONSTRAINT fleet_agents_unresponsive_wallet
  CHECK (status <> 'unresponsive' OR wallet_address IS NOT NULL);
DROP INDEX fleet_agents_sandbox_live_uq;
CREATE UNIQUE INDEX fleet_agents_sandbox_live_uq ON fleet_agents (sandbox_id)
  WHERE sandbox_id IS NOT NULL AND status IN ('reserved','provisioning','active','unresponsive');
CREATE INDEX fleet_agents_heartbeat_idx ON fleet_agents (status, last_heartbeat);

CREATE OR REPLACE FUNCTION fleet_bucket(s text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN s IN ('reserved','provisioning') THEN 'reserved'
              WHEN s IN ('active','unresponsive') THEN 'living'
              ELSE NULL END
$$;

CREATE OR REPLACE FUNCTION fleet_agents_transition_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path FROM CURRENT AS $$
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
    OR (OLD.status = 'active'       AND NEW.status IN ('unresponsive','dead'))
    OR (OLD.status = 'unresponsive' AND NEW.status IN ('active','dead'))
  ) THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;

-- ── Shared settings: DB-level replication switch, approved build, timeouts, reaper bookkeeping
ALTER TABLE fleet_state
  ADD COLUMN replication_enabled      boolean     NOT NULL DEFAULT false,
  ADD COLUMN runtime_build_id         text        CHECK (runtime_build_id ~ '^[0-9a-f]{64}$'),
  ADD COLUMN runtime_lockfile_sha256  text        CHECK (runtime_lockfile_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN reservation_ttl_s        integer     NOT NULL DEFAULT 1800 CHECK (reservation_ttl_s BETWEEN 1 AND 86400),
  ADD COLUMN provisioning_ttl_s       integer     NOT NULL DEFAULT 2700 CHECK (provisioning_ttl_s BETWEEN 1 AND 86400),
  ADD COLUMN heartbeat_unresponsive_s integer     NOT NULL DEFAULT 120  CHECK (heartbeat_unresponsive_s BETWEEN 1 AND 86400),
  ADD COLUMN heartbeat_dead_s         integer     NOT NULL DEFAULT 600  CHECK (heartbeat_dead_s BETWEEN 2 AND 604800),
  ADD COLUMN reaper_last_run_at       timestamptz,
  ADD COLUMN reaper_grace_from        timestamptz,
  ADD CONSTRAINT fleet_state_heartbeat_order CHECK (heartbeat_dead_s > heartbeat_unresponsive_s),
  ADD CONSTRAINT fleet_state_build_pair CHECK ((runtime_build_id IS NULL) = (runtime_lockfile_sha256 IS NULL)),
  ADD CONSTRAINT fleet_state_build_needs_runtime CHECK (runtime_repo IS NOT NULL OR runtime_build_id IS NULL);

-- ── Reservation leases
CREATE TABLE fleet_reservations (
  reservation_id           text        PRIMARY KEY CHECK (reservation_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  agent_id                 text        NOT NULL UNIQUE REFERENCES fleet_agents(agent_id),
  parent_agent_id          text        NOT NULL REFERENCES fleet_agents(agent_id),
  status                   text        NOT NULL
                                       CHECK (status IN ('reserved','provisioning','completed','expired','released','failed')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  expires_at               timestamptz NOT NULL,
  claimed_at               timestamptz,
  completed_at             timestamptz,
  ended_at                 timestamptz,
  end_reason               text,
  expected_repo            text        NOT NULL,
  expected_commit          text        NOT NULL CHECK (expected_commit ~ '^[0-9a-f]{40}$'),
  expected_build_id        text        NOT NULL CHECK (expected_build_id ~ '^[0-9a-f]{64}$'),
  expected_lockfile_sha256 text        NOT NULL CHECK (expected_lockfile_sha256 ~ '^[0-9a-f]{64}$'),
  attestation_nonce        text        CHECK (attestation_nonce ~ '^[0-9a-f]{64}$'),
  attested_at              timestamptz,
  attestation              jsonb,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('expired','released','failed')) = (ended_at IS NOT NULL)),
  CHECK (status NOT IN ('provisioning','completed') OR (claimed_at IS NOT NULL AND attestation_nonce IS NOT NULL)),
  CHECK (status <> 'completed' OR (attested_at IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX fleet_reservations_open_idx ON fleet_reservations (expires_at) WHERE status IN ('reserved','provisioning');
CREATE INDEX fleet_reservations_parent_idx ON fleet_reservations (parent_agent_id);

CREATE FUNCTION fleet_reservations_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'reserved' THEN
      RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: lease must start reserved';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.reservation_id <> NEW.reservation_id OR OLD.agent_id <> NEW.agent_id
     OR OLD.parent_agent_id <> NEW.parent_agent_id OR OLD.created_at <> NEW.created_at
     OR OLD.expected_repo <> NEW.expected_repo OR OLD.expected_commit <> NEW.expected_commit
     OR OLD.expected_build_id <> NEW.expected_build_id OR OLD.expected_lockfile_sha256 <> NEW.expected_lockfile_sha256
     OR (OLD.attestation_nonce IS NOT NULL AND OLD.attestation_nonce IS DISTINCT FROM NEW.attestation_nonce) THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: lease identity and expectations cannot change';
  END IF;
  IF OLD.status IN ('completed','expired','released','failed') THEN
    RAISE EXCEPTION 'FLEET_TERMINAL_STATE_IMMUTABLE: lease % is %', OLD.reservation_id, OLD.status;
  END IF;
  IF OLD.status <> NEW.status AND NOT (
       (OLD.status = 'reserved'     AND NEW.status IN ('provisioning','expired','released','failed'))
    OR (OLD.status = 'provisioning' AND NEW.status IN ('completed','expired','released','failed'))
  ) THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: lease % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_reservations_guard BEFORE INSERT OR UPDATE ON fleet_reservations
  FOR EACH ROW EXECUTE FUNCTION fleet_reservations_guard();
CREATE TRIGGER fleet_reservations_no_delete BEFORE DELETE ON fleet_reservations
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_reservations_no_truncate BEFORE TRUNCATE ON fleet_reservations
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- ── Per-agent credentials (only a SHA-256 of the bearer token is stored)
CREATE TABLE fleet_agent_credentials (
  agent_id    text        PRIMARY KEY REFERENCES fleet_agents(agent_id),
  token_hash  text        NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
CREATE TRIGGER fleet_agent_credentials_no_delete BEFORE DELETE ON fleet_agent_credentials
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- ── Phase 2 reservations have no lease and can never be attested: fail them.
UPDATE fleet_agents SET status = 'failed', status_reason = 'phase 3 migration: reservation predates leases',
       death_time = now(), updated_at = now()
 WHERE status IN ('reserved','provisioning');

-- ── Internal helpers (owner only; never granted)

CREATE FUNCTION fleet_scrub(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT left(regexp_replace(regexp_replace(COALESCE(t, ''),
           '0x[0-9a-fA-F]{64}', '[redacted]', 'g'),
           '[a-zA-Z][a-zA-Z0-9+.-]*://[^[:space:]:@/]+:[^[:space:]@/]+@', '[redacted]@', 'g'), 500)
$$;

CREATE FUNCTION fleet_event(p_type text, p_agent text, p_actor text, p_detail jsonb)
RETURNS void LANGUAGE sql SET search_path = @@SCHEMA@@, pg_temp AS $$
  INSERT INTO fleet_events (event_type, agent_id, actor, detail)
  VALUES (p_type, p_agent, left(p_actor, 128), COALESCE(p_detail, '{}'::jsonb));
$$;

CREATE FUNCTION fleet_lock_state() RETURNS fleet_state LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE st fleet_state;
BEGIN
  SELECT * INTO st FROM fleet_state WHERE id = 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FLEET_REGISTRY_UNAVAILABLE: fleet_state row missing (fail closed)';
  END IF;
  RETURN st;
END $$;

CREATE FUNCTION fleet_state_json(st fleet_state) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'livingAgents', st.living_agents,
    'reservedSlots', st.reserved_slots,
    'maxAgents', st.max_agents,
    'operatingMode', st.operating_mode,
    'replicationEnabled', st.replication_enabled,
    'runtime', CASE WHEN st.runtime_repo IS NULL THEN NULL
                    ELSE jsonb_build_object('repo', st.runtime_repo, 'commit', st.runtime_commit) END,
    'build', CASE WHEN st.runtime_build_id IS NULL THEN NULL
                  ELSE jsonb_build_object('buildId', st.runtime_build_id, 'lockfileSha256', st.runtime_lockfile_sha256) END,
    'updatedAt', st.updated_at)
$$;

-- Expire open leases past expires_at (caller holds the fleet_state lock). Idempotent.
CREATE FUNCTION fleet_expire_leases(p_actor text) RETURNS integer LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r record; n integer := 0;
BEGIN
  FOR r IN SELECT reservation_id, agent_id, status FROM fleet_reservations
            WHERE status IN ('reserved','provisioning') AND expires_at <= now()
            ORDER BY created_at, reservation_id FOR UPDATE LOOP
    UPDATE fleet_reservations
       SET status = 'expired', ended_at = now(), end_reason = 'lease expired while ' || r.status, updated_at = now()
     WHERE reservation_id = r.reservation_id AND status = r.status;
    UPDATE fleet_agents
       SET status = 'failed', status_reason = 'reservation lease expired (' || r.status || ')', death_time = now(), updated_at = now()
     WHERE agent_id = r.agent_id AND status IN ('reserved','provisioning');
    PERFORM fleet_event('reservation_expired', r.agent_id, p_actor,
      jsonb_build_object('reservationId', r.reservation_id, 'phase', r.status));
    PERFORM fleet_event('slot_released', r.agent_id, p_actor,
      jsonb_build_object('reservationId', r.reservation_id, 'reason', 'lease expired'));
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- reserved/provisioning -> failed. Returns false when there is nothing to release (idempotent).
CREATE FUNCTION fleet_release(p_agent text, p_reason text, p_outcome text, p_actor text) RETURNS boolean LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_res text; v_reason text := fleet_scrub(p_reason);
BEGIN
  IF p_outcome NOT IN ('released','failed') THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: release outcome %', p_outcome;
  END IF;
  PERFORM fleet_lock_state();
  UPDATE fleet_agents SET status = 'failed', status_reason = v_reason, death_time = now(), updated_at = now()
   WHERE agent_id = p_agent AND status IN ('reserved','provisioning');
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE fleet_reservations SET status = p_outcome, ended_at = now(), end_reason = v_reason, updated_at = now()
   WHERE agent_id = p_agent AND status IN ('reserved','provisioning')
   RETURNING reservation_id INTO v_res;
  IF p_outcome = 'failed' THEN
    PERFORM fleet_event('provisioning_failed', p_agent, p_actor, jsonb_build_object('reservationId', v_res, 'reason', v_reason));
  END IF;
  PERFORM fleet_event('slot_released', p_agent, p_actor, jsonb_build_object('reservationId', v_res, 'reason', v_reason));
  RETURN true;
END $$;

-- Any living/reserved agent -> dead (was living) or failed (never activated).
-- Revokes its credential and closes any open lease. Idempotent.
CREATE FUNCTION fleet_mark_dead(p_agent text, p_reason text, p_actor text, p_cause text) RETURNS boolean LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_status text; v_reason text := fleet_scrub(p_reason);
BEGIN
  PERFORM fleet_lock_state();
  UPDATE fleet_agents
     SET status = CASE WHEN status IN ('active','unresponsive') THEN 'dead' ELSE 'failed' END,
         status_reason = v_reason, death_time = now(), updated_at = now()
   WHERE agent_id = p_agent AND status IN ('reserved','provisioning','active','unresponsive')
   RETURNING status INTO v_status;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE fleet_reservations SET status = 'released', ended_at = now(), end_reason = v_reason, updated_at = now()
   WHERE agent_id = p_agent AND status IN ('reserved','provisioning');
  UPDATE fleet_agent_credentials SET revoked_at = now() WHERE agent_id = p_agent AND revoked_at IS NULL;
  PERFORM fleet_event('agent_died', p_agent, p_actor, jsonb_build_object('reason', v_reason, 'cause', p_cause, 'status', v_status));
  PERFORM fleet_event('slot_released', p_agent, p_actor, jsonb_build_object('reason', v_reason));
  RETURN true;
END $$;

-- Record a heartbeat; unresponsive agents recover. Returns the agent's status after the call (NULL if unknown).
-- Touches only the agent row: no fleet-wide lock, and never inserts.
CREATE FUNCTION fleet_heartbeat(p_agent text, p_actor text) RETURNS text LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_old text;
BEGIN
  SELECT status INTO v_old FROM fleet_agents WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_old NOT IN ('active','unresponsive') THEN
    RETURN v_old;
  END IF;
  UPDATE fleet_agents SET last_heartbeat = now(), status = 'active' WHERE agent_id = p_agent;
  IF v_old = 'unresponsive' THEN
    PERFORM fleet_event('agent_recovered', p_agent, p_actor, '{}'::jsonb);
  END IF;
  RETURN 'active';
END $$;

-- Authenticate (agent_id, bearer token). NULL = ok, else a denial code. Failures are audited.
CREATE FUNCTION fleet_authenticate(p_agent text, p_token text, p_action text) RETURNS text LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_agent_credentials; v_status text;
BEGIN
  IF p_agent IS NULL OR p_token IS NULL OR length(p_token) > 256 OR length(p_agent) > 64 THEN
    PERFORM fleet_event('db_auth_failed', NULL, NULL, jsonb_build_object('action', p_action, 'why', 'malformed'));
    RETURN 'FLEET_AUTH_FAILED';
  END IF;
  SELECT * INTO c FROM fleet_agent_credentials WHERE agent_id = p_agent;
  IF NOT FOUND OR c.token_hash <> encode(sha256(convert_to(p_token, 'UTF8')), 'hex') THEN
    PERFORM fleet_event('db_auth_failed', NULL, NULL,
      jsonb_build_object('action', p_action, 'claimedAgentId', left(p_agent, 64), 'why', 'bad credential'));
    RETURN 'FLEET_AUTH_FAILED';
  END IF;
  SELECT status INTO v_status FROM fleet_agents WHERE agent_id = p_agent;
  IF v_status IN ('dead','failed') THEN
    RETURN 'FLEET_AGENT_DEAD';
  END IF;
  IF c.revoked_at IS NOT NULL THEN
    PERFORM fleet_event('db_auth_failed', p_agent, p_agent, jsonb_build_object('action', p_action, 'why', 'revoked'));
    RETURN 'FLEET_AUTH_FAILED';
  END IF;
  RETURN NULL;
END $$;

-- The single slot allocator. Checks run under the fleet_state row lock.
CREATE FUNCTION fleet_reserve_slot(
  p_parent text, p_requested_by text, p_name text, p_request_key text, p_local_max integer,
  p_ttl_ms bigint, p_match_pin boolean, p_repo text, p_commit text, p_agent_id text, p_reservation_id text
) RETURNS jsonb LANGUAGE plpgsql SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE st fleet_state; par fleet_agents; mx integer; v_code text; v_reason text; v_exp timestamptz;
BEGIN
  PERFORM fleet_lock_state();
  PERFORM fleet_expire_leases(p_requested_by);
  SELECT * INTO st FROM fleet_state WHERE id = 1;
  mx := LEAST(st.max_agents, COALESCE(p_local_max, ${FLEET_PG_HARD_MAX_AGENTS}), ${FLEET_PG_HARD_MAX_AGENTS});

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
  END IF;

  IF v_code IS NULL THEN
    SELECT * INTO par FROM fleet_agents WHERE agent_id = p_parent;
    IF NOT FOUND OR par.status <> 'active' THEN
      v_code := 'FLEET_PARENT_NOT_LIVING'; v_reason := 'Parent is not a living registered fleet agent.';
    ELSIF EXISTS (SELECT 1 FROM fleet_agents WHERE request_key = p_request_key) THEN
      v_code := 'FLEET_DUPLICATE_REQUEST'; v_reason := 'Replication request already registered.';
    ELSIF st.living_agents + st.reserved_slots >= mx THEN
      v_code := 'FLEET_CAP_REACHED';
      v_reason := format('Fleet at cap (%s living + %s reserved >= %s).', st.living_agents, st.reserved_slots, mx);
    END IF;
  END IF;

  IF v_code IS NOT NULL THEN
    PERFORM fleet_event('reservation_denied', NULL, p_requested_by,
      jsonb_build_object('code', v_code, 'living', st.living_agents, 'reserved', st.reserved_slots, 'max', mx));
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

-- Background reaper: lease expiry, then ACTIVE -> UNRESPONSIVE -> DEAD on missed heartbeats.
-- If the reaper itself has not run for longer than the unresponsive timeout (service or
-- registry outage), heartbeat ages are measured from its resumption, so an outage
-- cannot kill agents that were healthy but unable to report. Idempotent.
CREATE FUNCTION fleet_reap(p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE st fleet_state; v_grace timestamptz; v_expired integer; v_unresp integer := 0; v_dead integer := 0; r record;
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

  -- Dead first, so an agent needs two reaper passes to go ACTIVE -> UNRESPONSIVE -> DEAD.
  FOR r IN SELECT agent_id FROM fleet_agents
            WHERE status = 'unresponsive'
              AND GREATEST(COALESCE(last_heartbeat, updated_at), v_grace) < now() - make_interval(secs => st.heartbeat_dead_s)
            ORDER BY agent_id LOOP
    IF fleet_mark_dead(r.agent_id, format('no heartbeat for more than %s s', st.heartbeat_dead_s), p_actor, 'heartbeat_timeout') THEN
      v_dead := v_dead + 1;
    END IF;
  END LOOP;

  FOR r IN SELECT agent_id, last_heartbeat FROM fleet_agents
            WHERE status = 'active'
              AND GREATEST(COALESCE(last_heartbeat, updated_at), v_grace) < now() - make_interval(secs => st.heartbeat_unresponsive_s)
            ORDER BY agent_id FOR UPDATE LOOP
    UPDATE fleet_agents SET status = 'unresponsive', updated_at = now() WHERE agent_id = r.agent_id AND status = 'active';
    PERFORM fleet_event('agent_unresponsive', r.agent_id, p_actor,
      jsonb_build_object('lastHeartbeat', r.last_heartbeat, 'timeoutS', st.heartbeat_unresponsive_s));
    v_unresp := v_unresp + 1;
  END LOOP;

  RETURN jsonb_build_object('expired', v_expired, 'unresponsive', v_unresp, 'dead', v_dead, 'graceFrom', v_grace);
END $$;

-- ── Restricted agent API (SECURITY DEFINER; the only functions granted to the agent role)

CREATE FUNCTION api_fleet_state() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT fleet_state_json(s) FROM fleet_state s WHERE s.id = 1
$$;

CREATE FUNCTION api_member_addresses() RETURNS SETOF text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT lower(wallet_address) FROM fleet_agents WHERE wallet_address IS NOT NULL
$$;

CREATE FUNCTION api_whoami(p_agent text, p_token text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'whoami'); a fleet_agents;
BEGIN
  IF v_code IS NOT NULL AND v_code <> 'FLEET_AGENT_DEAD' THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code);
  END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent;
  RETURN jsonb_build_object('ok', v_code IS NULL, 'code', v_code, 'agent', jsonb_build_object(
    'agentId', a.agent_id, 'parentAgentId', a.parent_agent_id, 'role', a.role, 'generation', a.generation,
    'name', a.name, 'walletAddress', a.wallet_address, 'runtimeVersion', a.runtime_version,
    'runtimeRepo', a.runtime_repo, 'runtimeCommit', a.runtime_commit, 'sandboxId', a.sandbox_id,
    'localChildId', a.local_child_id, 'status', a.status, 'statusReason', a.status_reason,
    'requestedBy', a.requested_by, 'createdAt', a.created_at, 'updatedAt', a.updated_at,
    'lastHeartbeat', a.last_heartbeat, 'deathTime', a.death_time));
END $$;

CREATE FUNCTION api_heartbeat(p_agent text, p_token text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'heartbeat'); v_status text;
BEGIN
  IF v_code = 'FLEET_AGENT_DEAD' THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code,
      'status', (SELECT status FROM fleet_agents WHERE agent_id = p_agent));
  ELSIF v_code IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code);
  END IF;
  v_status := fleet_heartbeat(p_agent, p_agent);
  RETURN jsonb_build_object('ok', COALESCE(v_status = 'active', false), 'status', v_status);
END $$;

CREATE FUNCTION api_request_replication(
  p_agent text, p_token text, p_name text, p_request_key text, p_new_agent_id text, p_reservation_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'request_replication'); v_result jsonb;
BEGIN
  IF v_code IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code, 'reason', 'Agent authentication failed.');
  END IF;
  PERFORM fleet_event('replication_requested', p_agent, p_agent,
    jsonb_build_object('name', left(p_name, 128), 'requestKey', left(p_request_key, 64)));
  v_result := fleet_reserve_slot(p_agent, p_agent, p_name, p_request_key, NULL, NULL, false, NULL, NULL,
                                 p_new_agent_id, p_reservation_id);
  IF (v_result->>'ok')::boolean THEN
    PERFORM fleet_event('replication_granted', v_result->>'agentId', p_agent,
      jsonb_build_object('reservationId', v_result->>'reservationId', 'parentAgentId', p_agent));
  ELSE
    PERFORM fleet_event('replication_rejected', NULL, p_agent,
      jsonb_build_object('code', v_result->>'code', 'parentAgentId', p_agent));
  END IF;
  RETURN v_result;
END $$;

CREATE FUNCTION api_release_reservation(p_agent text, p_token text, p_reservation_id text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'release_reservation'); l fleet_reservations;
BEGIN
  IF v_code IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code);
  END IF;
  SELECT * INTO l FROM fleet_reservations WHERE reservation_id = p_reservation_id;
  IF NOT FOUND OR l.parent_agent_id <> p_agent THEN
    PERFORM fleet_event('authorization_denied', NULL, p_agent,
      jsonb_build_object('action', 'release_reservation', 'reservationId', left(p_reservation_id, 64)));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_AUTHORIZED');
  END IF;
  RETURN jsonb_build_object('ok', true, 'released',
    fleet_release(l.agent_id, 'released by parent: ' || COALESCE(p_reason, ''), 'released', p_agent));
END $$;

CREATE FUNCTION api_set_own_status(p_agent text, p_token text, p_status text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'set_own_status');
BEGIN
  IF v_code IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code);
  END IF;
  IF p_status = 'dead' THEN
    RETURN jsonb_build_object('ok', true, 'changed',
      fleet_mark_dead(p_agent, 'self-reported: ' || COALESCE(p_reason, ''), p_agent, 'self_reported'));
  ELSIF p_status = 'active' THEN
    RETURN jsonb_build_object('ok', COALESCE(fleet_heartbeat(p_agent, p_agent) = 'active', false), 'changed', false);
  END IF;
  PERFORM fleet_event('authorization_denied', p_agent, p_agent,
    jsonb_build_object('action', 'set_own_status', 'requested', left(p_status, 32)));
  RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_TRANSITION');
END $$;

-- Nothing in this schema is executable or readable by PUBLIC; the agent role
-- receives EXECUTE on api_* only (PgFleetStore.grantAgentRole).
REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
-- Per-schema default privileges cannot remove PostgreSQL's global PUBLIC
-- EXECUTE default, so revoke it for every function this (owner) role creates.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
`;

/**
 * V3 — Phase 4: least-privilege controller role, runtime immutability,
 * parent-reported deaths, sandbox termination queue.
 *
 * The fleet service no longer holds the owner credential. It connects as a
 * restricted service role that can SELECT the non-secret tables and EXECUTE
 * the svc_* SECURITY DEFINER functions below — nothing else. Every write the
 * controller performs (claim, attested activation, verification failure,
 * release, death, reaper, audit events, terminations) is one of these
 * functions, so the service role cannot change the cap, mode, approved
 * runtime or replication switch, cannot insert agents, cannot read
 * credential hashes and cannot skip the attestation check: svc_activate
 * re-checks the child's proof against the lease itself.
 */
const V3 = `
-- ── Settings
ALTER TABLE fleet_state
  ADD COLUMN parent_report_quiet_s integer NOT NULL DEFAULT 60 CHECK (parent_report_quiet_s BETWEEN 1 AND 86400);
ALTER TABLE fleet_agents ADD COLUMN terminal_reported_at timestamptz;

-- ── The approved runtime is immutable while a release is running: it cannot
-- change while any lease is open or any child is living. Clearing it (which
-- blocks all replication) is always allowed.
CREATE FUNCTION fleet_state_runtime_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF (OLD.runtime_repo, OLD.runtime_commit, OLD.runtime_build_id, OLD.runtime_lockfile_sha256)
       IS DISTINCT FROM (NEW.runtime_repo, NEW.runtime_commit, NEW.runtime_build_id, NEW.runtime_lockfile_sha256)
     AND NEW.runtime_repo IS NOT NULL
     AND (EXISTS (SELECT 1 FROM fleet_reservations WHERE status IN ('reserved','provisioning'))
          OR EXISTS (SELECT 1 FROM fleet_agents WHERE role = 'child' AND status IN ('reserved','provisioning','active','unresponsive'))) THEN
    RAISE EXCEPTION 'FLEET_RUNTIME_IMMUTABLE: the approved runtime cannot change while leases are open or children are living (clear it, drain, then approve)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_state_runtime_guard BEFORE UPDATE ON fleet_state
  FOR EACH ROW EXECUTE FUNCTION fleet_state_runtime_guard();

-- ── Sandbox termination queue. A death with a known sandbox enqueues a
-- termination; the controller works the queue. 'unsupported' means the
-- provider cannot stop it (a deployment blocker, surfaced by fleet:doctor).
CREATE TABLE fleet_sandbox_terminations (
  agent_id        text        PRIMARY KEY REFERENCES fleet_agents(agent_id),
  sandbox_id      text        NOT NULL,
  status          text        NOT NULL CHECK (status IN ('pending','terminated','unsupported','failed')),
  requested_at    timestamptz NOT NULL DEFAULT now(),
  attempts        integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at timestamptz,
  completed_at    timestamptz,
  last_error      text,
  CHECK ((status IN ('terminated','unsupported')) = (completed_at IS NOT NULL))
);
CREATE TRIGGER fleet_sandbox_terminations_no_delete BEFORE DELETE ON fleet_sandbox_terminations
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_sandbox_terminations_no_truncate BEFORE TRUNCATE ON fleet_sandbox_terminations
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION fleet_agent_json(a fleet_agents) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'agentId', a.agent_id, 'parentAgentId', a.parent_agent_id, 'role', a.role, 'generation', a.generation,
    'name', a.name, 'walletAddress', a.wallet_address, 'runtimeVersion', a.runtime_version,
    'runtimeRepo', a.runtime_repo, 'runtimeCommit', a.runtime_commit, 'sandboxId', a.sandbox_id,
    'localChildId', a.local_child_id, 'status', a.status, 'statusReason', a.status_reason,
    'requestedBy', a.requested_by, 'createdAt', a.created_at, 'updatedAt', a.updated_at,
    'lastHeartbeat', a.last_heartbeat, 'deathTime', a.death_time)
$$;

-- Death now also enqueues termination of the agent's sandbox (idempotent).
CREATE OR REPLACE FUNCTION fleet_mark_dead(p_agent text, p_reason text, p_actor text, p_cause text) RETURNS boolean LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_status text; v_sandbox text; v_reason text := fleet_scrub(p_reason);
BEGIN
  PERFORM fleet_lock_state();
  UPDATE fleet_agents
     SET status = CASE WHEN status IN ('active','unresponsive') THEN 'dead' ELSE 'failed' END,
         status_reason = v_reason, death_time = now(), updated_at = now()
   WHERE agent_id = p_agent AND status IN ('reserved','provisioning','active','unresponsive')
   RETURNING status, sandbox_id INTO v_status, v_sandbox;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE fleet_reservations SET status = 'released', ended_at = now(), end_reason = v_reason, updated_at = now()
   WHERE agent_id = p_agent AND status IN ('reserved','provisioning');
  UPDATE fleet_agent_credentials SET revoked_at = now() WHERE agent_id = p_agent AND revoked_at IS NULL;
  PERFORM fleet_event('agent_died', p_agent, p_actor, jsonb_build_object('reason', v_reason, 'cause', p_cause, 'status', v_status));
  PERFORM fleet_event('slot_released', p_agent, p_actor, jsonb_build_object('reason', v_reason));
  IF v_sandbox IS NOT NULL THEN
    INSERT INTO fleet_sandbox_terminations (agent_id, sandbox_id, status) VALUES (p_agent, v_sandbox, 'pending')
      ON CONFLICT (agent_id) DO NOTHING;
    IF FOUND THEN
      PERFORM fleet_event('sandbox_termination_requested', p_agent, p_actor, jsonb_build_object('sandboxId', v_sandbox));
    END IF;
  END IF;
  RETURN true;
END $$;

-- Reaper: as V2, plus parent-reported children that have stayed quiet for
-- parent_report_quiet_s die without waiting for the full heartbeat timeout.
CREATE OR REPLACE FUNCTION fleet_reap(p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE st fleet_state; v_grace timestamptz; v_expired integer; v_unresp integer := 0; v_dead integer := 0; r record;
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

  FOR r IN SELECT agent_id FROM fleet_agents
            WHERE status IN ('active','unresponsive') AND terminal_reported_at IS NOT NULL
              AND GREATEST(COALESCE(last_heartbeat, updated_at), v_grace) < now() - make_interval(secs => st.parent_report_quiet_s)
            ORDER BY agent_id LOOP
    IF fleet_mark_dead(r.agent_id, format('parent reported terminal; no heartbeat for more than %s s', st.parent_report_quiet_s),
                       p_actor, 'parent_reported') THEN
      v_dead := v_dead + 1;
    END IF;
  END LOOP;

  FOR r IN SELECT agent_id FROM fleet_agents
            WHERE status = 'unresponsive'
              AND GREATEST(COALESCE(last_heartbeat, updated_at), v_grace) < now() - make_interval(secs => st.heartbeat_dead_s)
            ORDER BY agent_id LOOP
    IF fleet_mark_dead(r.agent_id, format('no heartbeat for more than %s s', st.heartbeat_dead_s), p_actor, 'heartbeat_timeout') THEN
      v_dead := v_dead + 1;
    END IF;
  END LOOP;

  FOR r IN SELECT agent_id, last_heartbeat FROM fleet_agents
            WHERE status = 'active'
              AND GREATEST(COALESCE(last_heartbeat, updated_at), v_grace) < now() - make_interval(secs => st.heartbeat_unresponsive_s)
            ORDER BY agent_id FOR UPDATE LOOP
    UPDATE fleet_agents SET status = 'unresponsive', updated_at = now() WHERE agent_id = r.agent_id AND status = 'active';
    PERFORM fleet_event('agent_unresponsive', r.agent_id, p_actor,
      jsonb_build_object('lastHeartbeat', r.last_heartbeat, 'timeoutS', st.heartbeat_unresponsive_s));
    v_unresp := v_unresp + 1;
  END LOOP;

  RETURN jsonb_build_object('expired', v_expired, 'unresponsive', v_unresp, 'dead', v_dead, 'graceFrom', v_grace);
END $$;

-- ── Controller API (SECURITY DEFINER; the only functions granted to the service role)

-- reserved -> provisioning, exactly once; issues the attestation nonce.
CREATE FUNCTION svc_claim(p_agent text, p_local_child text, p_parent text, p_ttl_ms bigint, p_nonce text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE st fleet_state; l fleet_reservations; a fleet_agents; v_ttl double precision;
BEGIN
  IF p_nonce IS NULL OR p_nonce !~ '^[0-9a-f]{64}$' OR p_local_child IS NULL OR length(p_local_child) > 64 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'Replication denied: malformed claim.');
  END IF;
  st := fleet_lock_state();
  SELECT * INTO l FROM fleet_reservations WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND OR l.status <> 'reserved' OR l.expires_at <= now() THEN
    RETURN jsonb_build_object('ok', false,
      'reason', format('Replication denied: fleet reservation %s is invalid, expired, or already used.', p_agent));
  END IF;
  IF p_parent IS NOT NULL AND l.parent_agent_id <> p_parent THEN
    RETURN jsonb_build_object('ok', false,
      'reason', format('Replication denied: reservation %s belongs to another parent.', l.reservation_id));
  END IF;
  v_ttl := COALESCE(p_ttl_ms, st.provisioning_ttl_s::bigint * 1000)::double precision / 1000;
  UPDATE fleet_agents SET status = 'provisioning', local_child_id = p_local_child, updated_at = now(),
         reservation_expires_at = now() + make_interval(secs => v_ttl)
   WHERE agent_id = p_agent AND status = 'reserved'
   RETURNING * INTO a;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false,
      'reason', format('Replication denied: fleet reservation %s is invalid, expired, or already used.', p_agent));
  END IF;
  UPDATE fleet_reservations SET status = 'provisioning', claimed_at = now(), attestation_nonce = p_nonce,
         expires_at = now() + make_interval(secs => v_ttl), updated_at = now()
   WHERE reservation_id = l.reservation_id AND status = 'reserved';
  PERFORM fleet_event('slot_claimed', p_agent, p_parent,
    jsonb_build_object('localChildId', p_local_child, 'reservationId', l.reservation_id));
  RETURN jsonb_build_object('ok', true, 'agentId', p_agent, 'parentAgentId', a.parent_agent_id, 'generation', a.generation,
    'reservationId', l.reservation_id, 'repo', l.expected_repo, 'commit', l.expected_commit,
    'buildId', l.expected_build_id, 'lockfileSha256', l.expected_lockfile_sha256);
END $$;

-- provisioning -> active, only with a runtime proof matching the lease. The
-- check here is authoritative and independent of the service's own check:
-- nonce, commit (reported and attested), repository, lockfile, build id,
-- clean tree and proof hash. A mismatch releases the slot as failed.
CREATE FUNCTION svc_activate(p_agent text, p_parent text, p_wallet text, p_sandbox text, p_runtime_commit text,
                             p_runtime_version text, p_attestation jsonb, p_actor text, p_token_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_agents; l fleet_reservations; v_fail text; att jsonb := COALESCE(p_attestation, 'null'::jsonb);
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'credential hash malformed');
  END IF;
  PERFORM fleet_lock_state();
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND OR a.status <> 'provisioning' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE',
      'reason', format('Cannot activate fleet agent %s: not in provisioning state', p_agent));
  END IF;
  SELECT * INTO l FROM fleet_reservations WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND OR l.status <> 'provisioning' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE',
      'reason', format('Cannot activate fleet agent %s: no open provisioning lease', p_agent));
  END IF;
  IF p_parent IS NOT NULL AND l.parent_agent_id <> p_parent THEN
    PERFORM fleet_event('authorization_denied', NULL, p_actor,
      jsonb_build_object('action', 'activate', 'reservationId', l.reservation_id));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_AUTHORIZED',
      'reason', format('Activation denied: reservation %s belongs to another parent.', l.reservation_id));
  END IF;
  IF l.expires_at <= now() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_AUTHORIZED',
      'reason', format('Activation denied: provisioning lease %s has expired.', l.reservation_id));
  END IF;

  IF jsonb_typeof(att) IS DISTINCT FROM 'object' THEN v_fail := 'no attestation';
  ELSIF p_runtime_commit IS DISTINCT FROM l.expected_commit THEN v_fail := 'reported commit does not match the lease';
  ELSIF l.attestation_nonce IS NULL OR att->>'nonce' IS DISTINCT FROM l.attestation_nonce THEN v_fail := 'nonce does not match the lease';
  ELSIF att->>'commit' IS DISTINCT FROM l.expected_commit THEN v_fail := 'attested commit does not match the lease';
  ELSIF att->>'repo' IS DISTINCT FROM l.expected_repo THEN v_fail := 'attested repository does not match the lease';
  ELSIF att->>'lockfileSha256' IS DISTINCT FROM l.expected_lockfile_sha256 THEN v_fail := 'attested lockfile does not match the lease';
  ELSIF att->>'buildId' IS DISTINCT FROM l.expected_build_id THEN v_fail := 'attested build id does not match the lease';
  ELSIF att->'clean' IS DISTINCT FROM 'true'::jsonb THEN v_fail := 'attested runtime tree is not clean';
  ELSIF att->>'proof' IS DISTINCT FROM encode(sha256(convert_to(
          (att->>'nonce') || ':' || (att->>'commit') || ':' || (att->>'buildId') || ':' || (att->>'lockfileSha256'), 'UTF8')), 'hex') THEN
    v_fail := 'attestation proof is inconsistent';
  END IF;
  IF v_fail IS NOT NULL THEN
    PERFORM fleet_event('runtime_verification_failed', p_agent, p_actor,
      jsonb_build_object('reason', 'controller check: ' || v_fail, 'reservationId', l.reservation_id));
    PERFORM fleet_release(p_agent, 'runtime verification failed: ' || v_fail, 'failed', p_actor);
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_RUNTIME_UNVERIFIED', 'reason', 'Runtime verification failed: ' || v_fail);
  END IF;

  UPDATE fleet_agents SET status = 'active', wallet_address = p_wallet, sandbox_id = p_sandbox,
         runtime_version = COALESCE(att->>'version', p_runtime_version),
         last_heartbeat = now(), reservation_expires_at = NULL, updated_at = now()
   WHERE agent_id = p_agent AND status = 'provisioning'
   RETURNING * INTO a;
  UPDATE fleet_reservations SET status = 'completed', completed_at = now(), attested_at = now(),
         attestation = att, updated_at = now()
   WHERE reservation_id = l.reservation_id AND status = 'provisioning';
  PERFORM fleet_event('runtime_verified', p_agent, p_actor, jsonb_build_object('reservationId', l.reservation_id,
    'commit', att->>'commit', 'buildId', att->>'buildId', 'lockfileSha256', att->>'lockfileSha256'));
  PERFORM fleet_event('agent_activated', p_agent, p_actor, jsonb_build_object('walletAddress', p_wallet,
    'sandboxId', p_sandbox, 'runtimeCommit', att->>'commit'));
  INSERT INTO fleet_agent_credentials (agent_id, token_hash) VALUES (p_agent, p_token_hash)
    ON CONFLICT (agent_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, created_at = now(), revoked_at = NULL;
  PERFORM fleet_event('credential_issued', p_agent, p_actor, '{}'::jsonb);
  RETURN jsonb_build_object('ok', true, 'agent', fleet_agent_json(a));
END $$;

CREATE FUNCTION svc_verification_failed(p_agent text, p_reason text, p_actor text) RETURNS boolean LANGUAGE plpgsql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM fleet_event('runtime_verification_failed', p_agent, p_actor, jsonb_build_object('reason', fleet_scrub(p_reason)));
  RETURN fleet_release(p_agent, 'runtime verification failed: ' || COALESCE(p_reason, ''), 'failed', p_actor);
END $$;

CREATE FUNCTION svc_release(p_agent text, p_reason text, p_actor text) RETURNS boolean LANGUAGE sql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT fleet_release(p_agent, p_reason, 'released', p_actor)
$$;

CREATE FUNCTION svc_mark_dead(p_agent text, p_reason text, p_actor text, p_cause text) RETURNS boolean LANGUAGE sql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT fleet_mark_dead(p_agent, p_reason, p_actor, left(COALESCE(p_cause, 'reported'), 32))
$$;

CREATE FUNCTION svc_heartbeat(p_agent text) RETURNS text LANGUAGE sql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT fleet_heartbeat(p_agent, p_agent)
$$;

CREATE FUNCTION svc_reap(p_actor text) RETURNS jsonb LANGUAGE sql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT fleet_reap(p_actor)
$$;

CREATE FUNCTION svc_record_event(p_type text, p_agent text, p_actor text, p_detail jsonb) RETURNS void LANGUAGE plpgsql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_type IS NULL OR p_type !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'FLEET_BAD_EVENT: invalid event type';
  END IF;
  PERFORM fleet_event(p_type, left(p_agent, 64), p_actor, p_detail);
END $$;

-- A parent reports that its child's local lifecycle ended. Unclaimed or
-- provisioning children are released at once; a living child that has been
-- quiet for parent_report_quiet_s dies now, otherwise it is flagged so the
-- reaper retires it once it goes quiet. A child that keeps heartbeating is
-- never killed on its parent's word.
CREATE FUNCTION svc_child_terminal(p_parent text, p_local_child text, p_state text) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_agents; st fleet_state; v_outcome text; v_changed boolean := false;
        v_state text := left(COALESCE(p_state, ''), 32);
BEGIN
  SELECT * INTO a FROM fleet_agents WHERE local_child_id = p_local_child;
  IF NOT FOUND OR a.parent_agent_id IS DISTINCT FROM p_parent THEN
    PERFORM fleet_event('authorization_denied', NULL, p_parent,
      jsonb_build_object('action', 'child_terminal', 'localChildId', left(p_local_child, 64)));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_AUTHORIZED');
  END IF;
  SELECT * INTO st FROM fleet_state WHERE id = 1;
  IF a.status IN ('reserved','provisioning') THEN
    v_changed := fleet_release(a.agent_id, 'parent reported child terminal: ' || v_state, 'failed', p_parent);
    v_outcome := 'released';
  ELSIF a.status IN ('active','unresponsive') THEN
    UPDATE fleet_agents SET terminal_reported_at = COALESCE(terminal_reported_at, now()) WHERE agent_id = a.agent_id;
    IF COALESCE(a.last_heartbeat, a.updated_at) < now() - make_interval(secs => st.parent_report_quiet_s) THEN
      v_changed := fleet_mark_dead(a.agent_id,
        format('parent reported terminal (%s); no heartbeat for more than %s s', v_state, st.parent_report_quiet_s),
        p_parent, 'parent_reported');
      v_outcome := 'dead';
    ELSE
      v_outcome := 'deferred';
    END IF;
  ELSE
    v_outcome := 'already_terminal';
  END IF;
  PERFORM fleet_event('child_terminal_reported', a.agent_id, p_parent,
    jsonb_build_object('localChildId', p_local_child, 'state', v_state, 'outcome', v_outcome));
  RETURN jsonb_build_object('ok', true, 'outcome', v_outcome, 'changed', v_changed);
END $$;

-- Terminations due: pending, or failed with attempts left and not tried in the last minute.
CREATE FUNCTION svc_terminations_due(p_limit integer) RETURNS jsonb LANGUAGE sql STABLE
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('agentId', agent_id, 'sandboxId', sandbox_id, 'attempts', attempts)), '[]'::jsonb)
    FROM (SELECT * FROM fleet_sandbox_terminations
           WHERE status = 'pending'
              OR (status = 'failed' AND attempts < 5 AND last_attempt_at < now() - interval '60 seconds')
           ORDER BY requested_at LIMIT LEAST(GREATEST(p_limit, 1), 100)) t
$$;

CREATE FUNCTION svc_termination_result(p_agent text, p_status text, p_error text, p_actor text) RETURNS boolean LANGUAGE plpgsql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_sandbox text;
BEGIN
  IF p_status NOT IN ('terminated','unsupported','failed') THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: termination status %', p_status;
  END IF;
  UPDATE fleet_sandbox_terminations
     SET status = p_status, attempts = attempts + 1, last_attempt_at = now(), last_error = fleet_scrub(p_error),
         completed_at = CASE WHEN p_status IN ('terminated','unsupported') THEN now() END
   WHERE agent_id = p_agent AND status IN ('pending','failed')
   RETURNING sandbox_id INTO v_sandbox;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM fleet_event(CASE p_status WHEN 'terminated' THEN 'sandbox_terminated'
                                    WHEN 'unsupported' THEN 'sandbox_termination_unsupported'
                                    ELSE 'sandbox_termination_failed' END,
                      p_agent, p_actor, jsonb_build_object('sandboxId', v_sandbox, 'error', fleet_scrub(p_error)));
  RETURN true;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

export const PG_MIGRATIONS: readonly PgMigration[] = Object.freeze([
  { version: 1, name: "shared_fleet_registry", sql: V1 },
  { version: 2, name: "leases_heartbeat_expiry_restricted_api", sql: V2 },
  { version: 3, name: "service_role_runtime_immutability_terminations", sql: V3 },
  { version: 4, name: "lifecycle_health_sessions_provisioning_orphans_custody", sql: v4Sql(FLEET_PG_HARD_MAX_AGENTS) },
  { version: 5, name: "treasury_economics", sql: V5_SQL },
  { version: 6, name: "provisioning_intents_dry_run_child", sql: V6_SQL },
  { version: 7, name: "capability_scope_witness", sql: v7Sql(FLEET_PG_HARD_MAX_AGENTS) },
  { version: 8, name: "operator_api_read_only", sql: V8_SQL },
]);

/** The only functions the restricted service role may execute (name + signature). */
export const SERVICE_API_FUNCTIONS: readonly string[] = Object.freeze([
  "svc_claim(text, text, text, bigint, text)",
  "svc_activate(text, text, text, text, text, text, jsonb, text, text)",
  "svc_verification_failed(text, text, text)",
  "svc_release(text, text, text)",
  "svc_mark_dead(text, text, text, text)",
  "svc_heartbeat(text)",
  "svc_reap(text)",
  "svc_record_event(text, text, text, jsonb)",
  "svc_child_terminal(text, text, text)",
  "svc_terminations_due(integer)",
  "svc_termination_result(text, text, text, text)",
  "svc_consume_nonce(text, text, integer)",
  "svc_provision_update(text, text, text, text)",
  "svc_provision_reconcile(text, text, text, text)",
  "svc_issue_challenge(text, text, text, text)",
  "svc_answer_challenge(text, text, text, text, text, boolean)",
]);

/** Tables the service role may SELECT. fleet_agent_credentials (token hashes) is deliberately absent. */
export const SERVICE_READ_TABLES: readonly string[] = Object.freeze([
  "fleet_schema_migrations",
  "fleet_state",
  "fleet_agents",
  "fleet_reservations",
  "fleet_events",
  "fleet_sandbox_terminations",
  "fleet_provisioning",
  "fleet_orphans",
  "fleet_wallet_custody",
  "fleet_health_challenges",
]);

/** The only functions the restricted agent role may execute (name + signature). */
export const AGENT_API_FUNCTIONS: readonly string[] = Object.freeze([
  "api_fleet_state()",
  "api_member_addresses()",
  "api_whoami(text, text)",
  "api_heartbeat(text, text)",
  "api_request_replication(text, text, text, text, text, text)",
  "api_release_reservation(text, text, text, text)",
  "api_set_own_status(text, text, text, text)",
  "api_open_session(text, text, text)",
  "api_propose_allocation(text, text, text, text, bigint, bigint, integer)",
  "api_request_spend(text, text, text, text, text, bigint, text, text)",
]);

/**
 * The ONLY functions the operator role may execute (schema v8, Phase B2).
 * Signature-termination invariant: every one of them is STABLE except
 * op_begin_request, whose writes are limited to OPERATOR_BOOKKEEPING_TABLES
 * (plus denial events via fleet_event). A mutating operator capability must
 * not be added here; it needs a separate security-design gate.
 */
export const OPERATOR_API_FUNCTIONS: readonly string[] = Object.freeze([
  "op_begin_request(text, text, text, bigint, text, text)",
  "op_key_material(text, text)",
  "op_ping()",
  "op_whoami(uuid)",
  "op_fleet_status(uuid)",
  "op_list_agents(uuid, text, integer)",
  "op_get_agent(uuid, text)",
  "op_list_events(uuid, bigint, integer, text)",
]);

/** The single volatile operator function (security/audit bookkeeping only). */
export const OPERATOR_VOLATILE_FUNCTIONS: readonly string[] = Object.freeze(["op_begin_request(text, text, text, bigint, text, text)"]);

/** The read functions a route may map to (mirrors the fleet_operator_routes CHECK). */
export const OPERATOR_READ_FUNCTIONS: readonly string[] = Object.freeze([
  "op_whoami",
  "op_fleet_status",
  "op_list_agents",
  "op_get_agent",
  "op_list_events",
]);

/** Tables op_begin_request may write (Amendment 3); fleet_events via fleet_event() for denials. */
export const OPERATOR_BOOKKEEPING_TABLES: readonly string[] = Object.freeze([
  "fleet_operator_nonces",
  "fleet_operator_requests",
  "fleet_operator_state",
]);

export function quoteIdent(ident: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(ident)) {
    throw new Error(`Invalid fleet schema name: ${ident}`);
  }
  return `"${ident}"`;
}

/** Apply pending migrations. Safe to call concurrently. Returns versions applied. */
export async function migrate(client: PoolClient, schema: string): Promise<number[]> {
  const s = quoteIdent(schema);
  const applied: number[] = [];
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${s}.fleet_schema_migrations (
         version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }

  for (const m of PG_MIGRATIONS) {
    await client.query("BEGIN");
    try {
      await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
      const done = await client.query(`SELECT 1 FROM ${s}.fleet_schema_migrations WHERE version = $1`, [m.version]);
      if (done.rowCount === 0) {
        await client.query(`SET LOCAL search_path TO ${s}`);
        await client.query(m.sql.replaceAll("@@SCHEMA@@", s));
        await client.query(`INSERT INTO ${s}.fleet_schema_migrations (version, name) VALUES ($1, $2)`, [m.version, m.name]);
        applied.push(m.version);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
  }
  return applied;
}

/**
 * Transactional verification of the pending migrations: applies every
 * pending version inside ONE transaction, reads the resulting schema
 * version, then ROLLS BACK. Nothing changes; a failing migration surfaces
 * here before `migrate` touches the database.
 */
export async function migrateCheck(
  client: PoolClient,
  schema: string,
): Promise<{ currentVersion: number | null; resultingVersion: number; wouldApply: number[] }> {
  const s = quoteIdent(schema);
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${s}.fleet_schema_migrations (
         version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const cur = await client.query<{ v: number | null }>(`SELECT max(version) AS v FROM ${s}.fleet_schema_migrations`);
    const wouldApply: number[] = [];
    for (const m of PG_MIGRATIONS) {
      const done = await client.query(`SELECT 1 FROM ${s}.fleet_schema_migrations WHERE version = $1`, [m.version]);
      if (done.rowCount) continue;
      await client.query(`SET LOCAL search_path TO ${s}`);
      await client.query(m.sql.replaceAll("@@SCHEMA@@", s));
      await client.query(`INSERT INTO ${s}.fleet_schema_migrations (version, name) VALUES ($1, $2)`, [m.version, m.name]);
      wouldApply.push(m.version);
    }
    const after = await client.query<{ v: number }>(`SELECT max(version) AS v FROM ${s}.fleet_schema_migrations`);
    return { currentVersion: cur.rows[0].v, resultingVersion: after.rows[0].v, wouldApply };
  } finally {
    await client.query("ROLLBACK").catch(() => {});
  }
}
```

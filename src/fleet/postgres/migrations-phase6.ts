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

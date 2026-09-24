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

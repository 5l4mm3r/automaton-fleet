/**
 * Schema v12 — Phase F.1: founder runtime provisioning and real-runtime attestation.
 *
 * A database row is not attestation. From v12 a founder is attested only
 * when BOTH of these exist and agree with its Genesis authorization:
 *
 *   runtime evidence — submitted by the running founder process itself
 *     (POST /v1/genesis/runtime-evidence → svc_genesis_runtime_evidence),
 *     authenticated by a one-time attestation token issued for exactly that
 *     founder (only its SHA-256 is stored) and bound to a fresh nonce: the
 *     process's own view of its release tree (commit, build id, lockfile),
 *     compiled capability manifest, identity, workspace and state namespace;
 *
 *   host evidence — observed from outside the process by the owner's root
 *     provisioner (systemd unit, pid, uid, /proc/<pid>/cwd tree identity,
 *     environment, state directory ownership) and passed to
 *     fleet_genesis_attest, which must name the SAME process instance.
 *
 * Missing, stale, mismatched or duplicate-process evidence rolls the whole
 * Genesis back (v11 semantics). The attestation token authorizes nothing
 * else: it cannot open a session, heartbeat or call any agent API.
 */

export const V12_SQL = `
ALTER TABLE fleet_genesis_founders
  ADD COLUMN runtime_token_sha256 text CHECK (runtime_token_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN runtime_nonce        text CHECK (runtime_nonce ~ '^[A-Za-z0-9_-]{22,64}$'),
  ADD COLUMN runtime_issued_at    timestamptz,
  ADD COLUMN runtime_evidence     jsonb,
  ADD COLUMN runtime_evidence_at  timestamptz,
  ADD COLUMN host_evidence        jsonb;
ALTER TABLE fleet_genesis_founders ADD CONSTRAINT fleet_genesis_founders_runtime_issue
  CHECK ((runtime_token_sha256 IS NULL) = (runtime_nonce IS NULL) AND (runtime_token_sha256 IS NULL) = (runtime_issued_at IS NULL));
ALTER TABLE fleet_genesis_founders ADD CONSTRAINT fleet_genesis_founders_runtime_evidence
  CHECK (runtime_evidence IS NULL OR (runtime_token_sha256 IS NOT NULL AND runtime_evidence_at IS NOT NULL));

-- Evidence is set once; a token can only be (re)issued while no evidence exists.
CREATE OR REPLACE FUNCTION fleet_genesis_founders_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF COALESCE(current_setting('fleet.genesis_op', true), '') <> NEW.genesis_id::text THEN
    RAISE EXCEPTION 'FLEET_GENESIS_REQUIRED: founder records change only through the Genesis functions';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.genesis_id <> OLD.genesis_id OR NEW.ordinal <> OLD.ordinal OR NEW.agent_id <> OLD.agent_id
     OR (OLD.attestation IS NOT NULL AND NEW.attestation IS DISTINCT FROM OLD.attestation)
     OR (OLD.allocation_journal_id IS NOT NULL AND NEW.allocation_journal_id IS DISTINCT FROM OLD.allocation_journal_id)
     OR (OLD.runtime_evidence IS NOT NULL AND (NEW.runtime_evidence IS DISTINCT FROM OLD.runtime_evidence
         OR NEW.runtime_token_sha256 IS DISTINCT FROM OLD.runtime_token_sha256 OR NEW.runtime_nonce IS DISTINCT FROM OLD.runtime_nonce))
     OR (OLD.host_evidence IS NOT NULL AND NEW.host_evidence IS DISTINCT FROM OLD.host_evidence)
     OR OLD.status IN ('active','rolled_back')) THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: founder record';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Owner: issue (or, before any evidence, re-issue) one founder's runtime attestation token + nonce.
CREATE FUNCTION fleet_genesis_issue_runtime(p_id uuid, p_agent text, p_token_sha256 text, p_nonce text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE g fleet_genesis; f fleet_genesis_founders; a fleet_agents;
BEGIN
  PERFORM fleet_genesis_owner(p_actor);
  g := fleet_genesis_lock(p_id);
  IF g.status <> 'attesting' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: Genesis % is %', p_id, g.status; END IF;
  IF now() >= g.expires_at THEN RAISE EXCEPTION 'FLEET_GENESIS_EXPIRED: authorization expired'; END IF;
  SELECT * INTO f FROM fleet_genesis_founders WHERE genesis_id = p_id AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: % is not a founder of Genesis %', p_agent, p_id; END IF;
  IF f.status <> 'provisioned' OR f.runtime_evidence IS NOT NULL THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: founder runtime already attested or evidenced'; END IF;
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' OR p_nonce IS NULL OR p_nonce !~ '^[A-Za-z0-9_-]{22,64}$' THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: token digest and nonce required';
  END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent;
  PERFORM fleet_genesis_begin(p_id, p_actor);
  UPDATE fleet_genesis_founders SET runtime_token_sha256 = p_token_sha256, runtime_nonce = p_nonce, runtime_issued_at = now()
   WHERE genesis_id = p_id AND agent_id = p_agent;
  PERFORM fleet_event('genesis_runtime_issued', p_agent, p_actor, jsonb_build_object('genesisId', p_id, 'reissue', f.runtime_token_sha256 IS NOT NULL));
  PERFORM fleet_genesis_end();
  RETURN jsonb_build_object('genesisId', p_id, 'agentId', p_agent, 'workspaceId', a.workspace_id, 'stateNamespace', a.state_namespace,
    'manifestId', g.manifest_id, 'manifestSha256', g.manifest_sha256,
    'runtime', jsonb_build_object('repo', g.runtime_repo, 'commit', g.runtime_commit, 'buildId', g.runtime_build_id, 'lockfileSha256', g.runtime_lockfile_sha256));
END $$;

-- Evidence shape: every field a string (or integer where noted), bounded.
CREATE FUNCTION fleet_genesis_evidence_problem(e jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE k text;
BEGIN
  IF e IS NULL OR jsonb_typeof(e) <> 'object' OR length(e::text) > 8192 THEN RETURN 'evidence must be a small object'; END IF;
  FOREACH k IN ARRAY ARRAY['agentId','genesisId','repo','commit','buildId','lockfileSha256','manifestId','manifestSha256','workspaceId','stateNamespace','instanceId'] LOOP
    IF jsonb_typeof(e -> k) IS DISTINCT FROM 'string' OR length(e ->> k) NOT BETWEEN 1 AND 300 THEN RETURN 'missing ' || k; END IF;
  END LOOP;
  IF (e ->> 'instanceId') !~ '^[A-Za-z0-9_-]{16,64}$' THEN RETURN 'bad instanceId'; END IF;
  FOREACH k IN ARRAY ARRAY['pid','uid'] LOOP
    IF jsonb_typeof(e -> k) IS DISTINCT FROM 'number' OR (e ->> k)::numeric < 1 THEN RETURN 'missing ' || k; END IF;
  END LOOP;
  RETURN NULL;
END $$;

-- Does evidence describe exactly the authorized founder runtime? NULL = yes, else the first difference.
CREATE FUNCTION fleet_genesis_evidence_mismatch(g fleet_genesis, a fleet_agents, e jsonb) RETURNS text LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_problem text := fleet_genesis_evidence_problem(e);
BEGIN
  IF v_problem IS NOT NULL THEN RETURN v_problem; END IF;
  IF e ->> 'agentId' <> a.agent_id THEN RETURN 'founder identity differs'; END IF;
  IF e ->> 'genesisId' <> g.genesis_id::text THEN RETURN 'Genesis differs'; END IF;
  IF regexp_replace(rtrim(lower(e ->> 'repo'), '/'), '\\.git$', '') <> regexp_replace(rtrim(lower(g.runtime_repo), '/'), '\\.git$', '') THEN
    RETURN 'repository differs';
  END IF;
  IF e ->> 'commit' <> g.runtime_commit THEN RETURN 'runtime commit differs'; END IF;
  IF e ->> 'buildId' <> g.runtime_build_id THEN RETURN 'runtime build id differs'; END IF;
  IF e ->> 'lockfileSha256' <> g.runtime_lockfile_sha256 THEN RETURN 'runtime lockfile differs'; END IF;
  IF e ->> 'manifestId' <> g.manifest_id OR e ->> 'manifestSha256' <> g.manifest_sha256 THEN RETURN 'capability manifest differs'; END IF;
  IF e ->> 'workspaceId' <> a.workspace_id OR e ->> 'stateNamespace' <> a.state_namespace THEN RETURN 'workspace/state isolation identity differs'; END IF;
  RETURN NULL;
END $$;

-- Service (controller): record the running founder's own evidence. Token + nonce bound; set once;
-- a second, different process instance is refused (duplicate founder runtime).
CREATE FUNCTION svc_genesis_runtime_evidence(p_agent text, p_token text, p_evidence jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE f fleet_genesis_founders; g fleet_genesis; a fleet_agents; v_problem text;
BEGIN
  IF p_agent IS NULL OR p_agent !~ '^[0-9A-HJKMNP-TV-Z]{26}$' OR p_token IS NULL OR length(p_token) NOT BETWEEN 32 AND 128 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_AUTH_FAILED');
  END IF;
  SELECT * INTO f FROM fleet_genesis_founders WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND OR f.runtime_token_sha256 IS NULL OR f.runtime_token_sha256 <> encode(sha256(convert_to(p_token, 'UTF8')), 'hex') THEN
    PERFORM fleet_event('genesis_runtime_auth_failed', NULL, 'controller', jsonb_build_object('claimedAgentId', left(p_agent, 26)));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_AUTH_FAILED');
  END IF;
  SELECT * INTO g FROM fleet_genesis WHERE genesis_id = f.genesis_id;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent;
  IF g.status <> 'attesting' OR f.status <> 'provisioned' OR now() >= g.expires_at THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_GENESIS_NOT_ATTESTING');
  END IF;
  IF p_evidence ->> 'nonce' IS DISTINCT FROM f.runtime_nonce THEN
    PERFORM fleet_event('genesis_runtime_nonce_mismatch', p_agent, 'controller', jsonb_build_object('genesisId', g.genesis_id));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_GENESIS_NONCE_MISMATCH');
  END IF;
  v_problem := fleet_genesis_evidence_problem(p_evidence);
  IF v_problem IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'why', v_problem); END IF;
  IF f.runtime_evidence IS NOT NULL THEN
    IF f.runtime_evidence ->> 'instanceId' = p_evidence ->> 'instanceId' THEN
      RETURN jsonb_build_object('ok', true, 'replay', true);
    END IF;
    PERFORM fleet_event('genesis_duplicate_runtime', p_agent, 'controller', jsonb_build_object('genesisId', g.genesis_id,
      'firstInstance', f.runtime_evidence ->> 'instanceId', 'secondInstance', p_evidence ->> 'instanceId'));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_DUPLICATE_FOUNDER_RUNTIME');
  END IF;
  PERFORM fleet_genesis_begin(g.genesis_id, 'controller');
  UPDATE fleet_genesis_founders SET runtime_evidence = p_evidence - 'nonce', runtime_evidence_at = now()
   WHERE genesis_id = g.genesis_id AND agent_id = p_agent;
  PERFORM fleet_genesis_end();
  PERFORM fleet_event('genesis_runtime_evidence', p_agent, 'controller', jsonb_build_object('genesisId', g.genesis_id,
    'instanceId', p_evidence ->> 'instanceId', 'commit', p_evidence ->> 'commit', 'buildId', p_evidence ->> 'buildId',
    'manifestSha256', p_evidence ->> 'manifestSha256', 'matches', fleet_genesis_evidence_mismatch(g, a, p_evidence) IS NULL));
  RETURN jsonb_build_object('ok', true);
END $$;

-- Attest (v12): runtime evidence (from the process) AND host evidence (from the provisioner) must both
-- match the authorization and name the same process instance; otherwise the whole Genesis rolls back.
CREATE OR REPLACE FUNCTION fleet_genesis_attest(p_id uuid, p_agent text, p_evidence jsonb, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE g fleet_genesis; f fleet_genesis_founders; a fleet_agents; st fleet_state; v_bad text; r jsonb;
BEGIN
  PERFORM fleet_genesis_owner(p_actor);
  g := fleet_genesis_lock(p_id);
  IF g.status <> 'attesting' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: Genesis % is %', p_id, g.status; END IF;
  SELECT * INTO f FROM fleet_genesis_founders WHERE genesis_id = p_id AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: % is not a founder of Genesis %', p_agent, p_id; END IF;
  IF f.status <> 'provisioned' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: founder already %', f.status; END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent;
  SELECT * INTO st FROM fleet_state WHERE id = 1;
  r := f.runtime_evidence;
  IF now() >= g.expires_at THEN v_bad := 'authorization expired';
  ELSIF st.runtime_commit IS DISTINCT FROM g.runtime_commit OR st.runtime_build_id IS DISTINCT FROM g.runtime_build_id
     OR st.runtime_lockfile_sha256 IS DISTINCT FROM g.runtime_lockfile_sha256 THEN v_bad := 'approved runtime changed';
  ELSIF f.runtime_token_sha256 IS NULL THEN v_bad := 'no runtime attestation was issued';
  ELSIF r IS NULL THEN v_bad := 'no evidence from the running founder process';
  ELSIF f.runtime_evidence_at < now() - interval '30 minutes' THEN v_bad := 'runtime evidence is stale';
  ELSE
    v_bad := fleet_genesis_evidence_mismatch(g, a, r);
    IF v_bad IS NOT NULL THEN v_bad := 'runtime: ' || v_bad;
    ELSE
      v_bad := fleet_genesis_evidence_mismatch(g, a, p_evidence);
      IF v_bad IS NOT NULL THEN v_bad := 'host: ' || v_bad;
      ELSIF p_evidence ->> 'instanceId' <> r ->> 'instanceId' OR (p_evidence ->> 'pid')::bigint <> (r ->> 'pid')::bigint
         OR (p_evidence ->> 'uid')::bigint <> (r ->> 'uid')::bigint THEN
        v_bad := 'host and runtime evidence describe different processes';
      END IF;
    END IF;
  END IF;
  IF v_bad IS NOT NULL THEN
    PERFORM fleet_event('genesis_attestation_failed', p_agent, p_actor, jsonb_build_object('genesisId', p_id, 'why', v_bad));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_GENESIS_ATTESTATION_FAILED', 'why', v_bad)
      || fleet_genesis_rollback(p_id, 'attestation failed for ' || p_agent || ': ' || v_bad, p_actor);
  END IF;
  PERFORM fleet_genesis_begin(p_id, p_actor);
  UPDATE fleet_genesis_founders SET status = 'attested', attested_at = now(), host_evidence = p_evidence,
         attestation = jsonb_build_object('commit', g.runtime_commit, 'buildId', g.runtime_build_id, 'lockfileSha256', g.runtime_lockfile_sha256,
           'manifestSha256', g.manifest_sha256, 'workspaceId', a.workspace_id, 'stateNamespace', a.state_namespace,
           'instanceId', r ->> 'instanceId', 'pid', r -> 'pid', 'uid', r -> 'uid', 'attestedBy', p_actor)
   WHERE genesis_id = p_id AND agent_id = p_agent;
  UPDATE fleet_agents SET status = 'provisioning', updated_at = now() WHERE agent_id = p_agent;
  PERFORM fleet_event('genesis_founder_attested', p_agent, p_actor, jsonb_build_object('genesisId', p_id, 'instanceId', r ->> 'instanceId'));
  IF NOT EXISTS (SELECT 1 FROM fleet_genesis_founders WHERE genesis_id = p_id AND status = 'provisioned') THEN
    UPDATE fleet_genesis SET status = 'funding_virtual' WHERE genesis_id = p_id;
  END IF;
  PERFORM fleet_genesis_end();
  RETURN jsonb_build_object('ok', true, 'genesis', fleet_genesis_json(fleet_genesis_lock(p_id)));
END $$;

-- Status view gains runtime attestation progress (no token, no nonce).
CREATE OR REPLACE FUNCTION fleet_genesis_json(g fleet_genesis) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('genesisId', g.genesis_id, 'kind', g.kind, 'status', g.status, 'founderCount', g.founder_count,
    'manifestId', g.manifest_id, 'manifestSha256', g.manifest_sha256, 'templateVersion', g.template_version,
    'runtime', jsonb_build_object('repo', g.runtime_repo, 'commit', g.runtime_commit, 'buildId', g.runtime_build_id, 'lockfileSha256', g.runtime_lockfile_sha256),
    'economicPolicySha256', g.economic_policy_sha256, 'allocationCents', g.allocation_cents, 'expiresAt', g.expires_at,
    'requestedBy', g.requested_by, 'approvedBy', g.approved_by, 'approvedAt', g.approved_at, 'activatedAt', g.activated_at,
    'authSha256', g.auth_sha256, 'founderIds', to_jsonb(g.founder_ids), 'statusReason', g.status_reason,
    'founders', (SELECT COALESCE(jsonb_agg(jsonb_build_object('ordinal', f.ordinal, 'agentId', f.agent_id, 'status', f.status,
        'workspaceId', a.workspace_id, 'stateNamespace', a.state_namespace, 'agentStatus', a.status,
        'runtimeIssued', f.runtime_issued_at IS NOT NULL, 'runtimeEvidenceAt', f.runtime_evidence_at,
        'runtimeInstanceId', f.runtime_evidence ->> 'instanceId') ORDER BY f.ordinal), '[]'::jsonb)
       FROM fleet_genesis_founders f JOIN fleet_agents a USING (agent_id) WHERE f.genesis_id = g.genesis_id))
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

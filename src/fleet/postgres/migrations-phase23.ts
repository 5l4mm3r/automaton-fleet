/**
 * Schema v23 — living-founder runtime upgrade lifecycle, and tier/scope-aware prompt-cache policy.
 *
 * Additive. Nothing changes for any founder until the owner runs the upgrade lifecycle for it.
 *
 * 1. Runtime upgrade of a LIVING founder (the same economic agent on a newer approved runtime):
 *
 *      prepared ──commit──▶ committed ──verify──▶ verified
 *          │                    │                     │
 *          └─abort─▶ aborted    └──────rollback───────┴─▶ rolled_back
 *
 *    fleet_founder_runtime_upgrades   one record per attempt (append-only history; one open attempt per founder)
 *    fleet_founder_runtime_current()  the runtime a founder is registered to run: its latest committed/verified
 *                                     upgrade target, else its Genesis-attested runtime
 *    fleet_founder_runtime_upgrade_prepare / _commit / _verify / _rollback / _rollback_verify / _abort  (owner-only)
 *
 *    Invariants enforced here (the host-side lifecycle in src/fleet/founder/upgrade.ts supplies the evidence):
 *      - only a living Genesis/reseed founder; the founder row is never replaced: only runtime_repo/runtime_commit
 *        change, and only inside an upgrade operation (fleet_agents_founder_runtime_guard);
 *      - `from` must be exactly the founder's current registered runtime; `to` must be exactly the owner-approved
 *        runtime (fleet_state) at prepare AND at commit;
 *      - no inference in flight at prepare; the stopped-state hash and the founder's ledger fingerprint at commit
 *        must equal those recorded at prepare (nothing moved while the runtime was switched);
 *      - verification is decided from the registry's own record: a heartbeat and a passed health challenge after
 *        the commit, no failed challenge, the observed process on the target commit/build, identity and credential
 *        files unchanged, the same ledger accounts;
 *      - rollback restores the previous registered runtime from the record itself (never from caller input).
 *    Once a founder has been upgraded its health challenges also compare the reported BUILD id with the registered
 *    build (a Genesis-state founder keeps the commit comparison it was attested with).
 *
 * 2. Prompt-cache policy per tier (R22 evidence: a T2 prefix pays back within a tool loop; a one-off T3 escalation
 *    only pays the write premium; a T1 routine prompt is below the provider's minimum):
 *      fleet_cognition_tiers.prompt_cache   off | prefix | prefix+tail   (T1 is constrained to off)
 *      fleet_cognition_log.cache_policy / cache_saving_microcents   what was applied and what it saved or cost
 *    The scope rule (a question-scoped escalation never writes a cache) lives in the routed gateway.
 */

export const V23_SQL = `
-- ═══ 1. Living-founder runtime upgrades ═══
CREATE TABLE fleet_founder_runtime_upgrades (
  seq                  bigserial   UNIQUE,
  upgrade_id           uuid        PRIMARY KEY,
  agent_id             text        NOT NULL REFERENCES fleet_agents(agent_id),
  status               text        NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','committed','verified','rolled_back','aborted')),
  from_repo            text        NOT NULL,
  from_commit          text        NOT NULL CHECK (from_commit ~ '^[0-9a-f]{40}$'),
  from_build_id        text        NOT NULL CHECK (from_build_id ~ '^[0-9a-f]{64}$'),
  from_lockfile_sha256 text        NOT NULL CHECK (from_lockfile_sha256 ~ '^[0-9a-f]{64}$'),
  to_repo              text        NOT NULL,
  to_commit            text        NOT NULL CHECK (to_commit ~ '^[0-9a-f]{40}$'),
  to_build_id          text        NOT NULL CHECK (to_build_id ~ '^[0-9a-f]{64}$'),
  to_lockfile_sha256   text        NOT NULL CHECK (to_lockfile_sha256 ~ '^[0-9a-f]{64}$'),
  state_sha256_before  text        NOT NULL CHECK (state_sha256_before ~ '^[0-9a-f]{64}$'),
  ledger_before        jsonb       NOT NULL,
  before               jsonb       NOT NULL CHECK (length(before::text) <= 8192),
  after                jsonb       CHECK (after IS NULL OR length(after::text) <= 8192),
  rollback             jsonb       CHECK (rollback IS NULL OR length(rollback::text) <= 8192),
  reason               text        CHECK (reason IS NULL OR length(reason) BETWEEN 3 AND 500),
  prepared_at          timestamptz NOT NULL DEFAULT now(),
  prepared_by          text        NOT NULL CHECK (length(prepared_by) BETWEEN 3 AND 128),
  committed_at         timestamptz,
  verified_at          timestamptz,
  closed_at            timestamptz,
  closed_by            text,
  CHECK (from_commit <> to_commit OR from_build_id <> to_build_id)
);
-- One open attempt per founder: a second lifecycle cannot start while one is prepared or awaiting verification.
CREATE UNIQUE INDEX fleet_founder_runtime_upgrades_open_uq ON fleet_founder_runtime_upgrades (agent_id) WHERE status IN ('prepared','committed');
CREATE INDEX fleet_founder_runtime_upgrades_agent_idx ON fleet_founder_runtime_upgrades (agent_id, seq);

CREATE FUNCTION fleet_founder_runtime_upgrades_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF COALESCE(current_setting('fleet.runtime_upgrade_op', true), '') <> NEW.upgrade_id::text THEN
    RAISE EXCEPTION 'FLEET_RUNTIME_UPGRADE_REQUIRED: upgrade records change only through the runtime-upgrade functions';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.upgrade_id <> OLD.upgrade_id OR NEW.seq <> OLD.seq OR NEW.agent_id <> OLD.agent_id
       OR NEW.from_repo <> OLD.from_repo OR NEW.from_commit <> OLD.from_commit OR NEW.from_build_id <> OLD.from_build_id OR NEW.from_lockfile_sha256 <> OLD.from_lockfile_sha256
       OR NEW.to_repo <> OLD.to_repo OR NEW.to_commit <> OLD.to_commit OR NEW.to_build_id <> OLD.to_build_id OR NEW.to_lockfile_sha256 <> OLD.to_lockfile_sha256
       OR NEW.state_sha256_before <> OLD.state_sha256_before OR NEW.ledger_before <> OLD.ledger_before OR NEW.before <> OLD.before
       OR NEW.prepared_at <> OLD.prepared_at OR NEW.prepared_by <> OLD.prepared_by
       OR (OLD.after IS NOT NULL AND NEW.after IS DISTINCT FROM OLD.after)
       OR (OLD.rollback IS NOT NULL AND NEW.rollback IS DISTINCT FROM OLD.rollback) THEN
      RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: runtime upgrade record';
    END IF;
    IF NEW.status <> OLD.status AND NOT (
         (OLD.status = 'prepared'  AND NEW.status IN ('committed','aborted'))
      OR (OLD.status = 'committed' AND NEW.status IN ('verified','rolled_back'))
      OR (OLD.status = 'verified'  AND NEW.status = 'rolled_back')) THEN
      RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: runtime upgrade % cannot go from % to %', OLD.upgrade_id, OLD.status, NEW.status;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_founder_runtime_upgrades_guard BEFORE INSERT OR UPDATE ON fleet_founder_runtime_upgrades
  FOR EACH ROW EXECUTE FUNCTION fleet_founder_runtime_upgrades_guard();
CREATE TRIGGER fleet_founder_runtime_upgrades_no_delete BEFORE DELETE ON fleet_founder_runtime_upgrades
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_founder_runtime_upgrades_no_truncate BEFORE TRUNCATE ON fleet_founder_runtime_upgrades
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- A founder's registered runtime changes only inside a runtime-upgrade operation (never by an ad-hoc UPDATE).
CREATE FUNCTION fleet_agents_founder_runtime_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF OLD.origin IN ('genesis_founder','reseed_founder')
     AND (NEW.runtime_commit IS DISTINCT FROM OLD.runtime_commit OR NEW.runtime_repo IS DISTINCT FROM OLD.runtime_repo)
     AND COALESCE(current_setting('fleet.runtime_upgrade_op', true), '') = '' THEN
    RAISE EXCEPTION 'FLEET_RUNTIME_UPGRADE_REQUIRED: a founder''s registered runtime changes only through the runtime-upgrade lifecycle';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_agents_founder_runtime_guard BEFORE UPDATE ON fleet_agents
  FOR EACH ROW EXECUTE FUNCTION fleet_agents_founder_runtime_guard();

-- The runtime a founder is registered to run: its latest committed/verified upgrade, else its Genesis attestation.
CREATE FUNCTION fleet_founder_runtime_current(p_agent text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(
    (SELECT jsonb_build_object('repo', u.to_repo, 'commit', u.to_commit, 'buildId', u.to_build_id, 'lockfileSha256', u.to_lockfile_sha256,
                               'source', 'upgrade', 'upgradeId', u.upgrade_id, 'status', u.status)
       FROM fleet_founder_runtime_upgrades u WHERE u.agent_id = p_agent AND u.status IN ('committed','verified') ORDER BY u.seq DESC LIMIT 1),
    (SELECT jsonb_build_object('repo', g.runtime_repo, 'commit', g.runtime_commit, 'buildId', g.runtime_build_id, 'lockfileSha256', g.runtime_lockfile_sha256,
                               'source', 'genesis', 'genesisId', g.genesis_id)
       FROM fleet_agents a JOIN fleet_genesis g ON g.genesis_id = a.genesis_id
      WHERE a.agent_id = p_agent AND a.origin IN ('genesis_founder','reseed_founder')))
$$;

-- The founder's economic identity: its ledger accounts and balances, its journals, its unposted inference remainder.
CREATE FUNCTION fleet_founder_ledger_fingerprint(p_agent text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'accounts', (SELECT COALESCE(jsonb_agg(jsonb_build_object('account', a.account_id, 'class', a.class, 'balance', fleet_ledger_balance(a.account_id)) ORDER BY a.account_id), '[]'::jsonb)
                   FROM fleet_ledger_accounts a WHERE a.agent_id = p_agent),
    'journals', (SELECT count(*) FROM fleet_ledger_journal j WHERE j.agent_id = p_agent),
    'lastJournalSeq', (SELECT COALESCE(max(j.seq), 0) FROM fleet_ledger_journal j WHERE j.agent_id = p_agent),
    'unpostedMicrocents', COALESCE((SELECT c.unposted_microcents FROM fleet_cognition_accrual c WHERE c.agent_id = p_agent), 0))
$$;

CREATE FUNCTION fleet_founder_runtime_upgrade_view(p_upgrade uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('upgradeId', u.upgrade_id, 'seq', u.seq, 'agentId', u.agent_id, 'status', u.status,
    'from', jsonb_build_object('repo', u.from_repo, 'commit', u.from_commit, 'buildId', u.from_build_id, 'lockfileSha256', u.from_lockfile_sha256),
    'to', jsonb_build_object('repo', u.to_repo, 'commit', u.to_commit, 'buildId', u.to_build_id, 'lockfileSha256', u.to_lockfile_sha256),
    'stateSha256Before', u.state_sha256_before, 'ledgerBefore', u.ledger_before, 'before', u.before, 'after', u.after, 'rollback', u.rollback,
    'reason', u.reason, 'preparedAt', u.prepared_at, 'preparedBy', u.prepared_by, 'committedAt', u.committed_at, 'verifiedAt', u.verified_at,
    'closedAt', u.closed_at, 'closedBy', u.closed_by)
  FROM fleet_founder_runtime_upgrades u WHERE u.upgrade_id = p_upgrade
$$;

-- prepared: the founder is stopped, its state hashed; nothing has been switched yet.
CREATE FUNCTION fleet_founder_runtime_upgrade_prepare(p_agent text, p_from jsonb, p_to jsonb, p_before jsonb, p_actor text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_agents; st fleet_state; cur jsonb; v_id uuid := gen_random_uuid();
BEGIN
  IF p_actor IS NULL OR length(p_actor) < 3 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: actor required'; END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND OR a.origin NOT IN ('genesis_founder','reseed_founder') OR a.role <> 'root' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: not a founder'; END IF;
  IF a.status NOT IN ('active','unresponsive') THEN RAISE EXCEPTION 'FLEET_RUNTIME_UPGRADE_REFUSED: founder is %; only a living founder is upgraded', a.status; END IF;
  IF EXISTS (SELECT 1 FROM fleet_founder_runtime_upgrades WHERE agent_id = p_agent AND status IN ('prepared','committed')) THEN
    RAISE EXCEPTION 'FLEET_RUNTIME_UPGRADE_IN_PROGRESS: an upgrade of this founder is already open';
  END IF;
  cur := fleet_founder_runtime_current(p_agent);
  IF cur IS NULL THEN RAISE EXCEPTION 'FLEET_RUNTIME_UPGRADE_REFUSED: the founder has no registered runtime'; END IF;
  IF a.runtime_commit IS DISTINCT FROM cur ->> 'commit' OR a.runtime_repo IS DISTINCT FROM cur ->> 'repo' THEN
    RAISE EXCEPTION 'FLEET_RUNTIME_PIN_MISMATCH: the registry row and the founder''s runtime record disagree';
  END IF;
  IF p_from ->> 'repo' IS DISTINCT FROM cur ->> 'repo' OR p_from ->> 'commit' IS DISTINCT FROM cur ->> 'commit'
     OR p_from ->> 'buildId' IS DISTINCT FROM cur ->> 'buildId' OR p_from ->> 'lockfileSha256' IS DISTINCT FROM cur ->> 'lockfileSha256' THEN
    RAISE EXCEPTION 'FLEET_RUNTIME_PIN_MISMATCH: the observed current runtime is not the founder''s registered runtime';
  END IF;
  SELECT * INTO st FROM fleet_state WHERE id = 1;
  IF st.runtime_commit IS NULL OR p_to ->> 'repo' IS DISTINCT FROM st.runtime_repo OR p_to ->> 'commit' IS DISTINCT FROM st.runtime_commit
     OR p_to ->> 'buildId' IS DISTINCT FROM st.runtime_build_id OR p_to ->> 'lockfileSha256' IS DISTINCT FROM st.runtime_lockfile_sha256 THEN
    RAISE EXCEPTION 'FLEET_RUNTIME_NOT_APPROVED: the target is not the owner-approved runtime';
  END IF;
  IF p_to ->> 'commit' = cur ->> 'commit' AND p_to ->> 'buildId' = cur ->> 'buildId' THEN
    RAISE EXCEPTION 'FLEET_RUNTIME_UPGRADE_REFUSED: the founder already runs the target runtime';
  END IF;
  IF p_before IS NULL OR COALESCE(p_before ->> 'stateSha256', '') !~ '^[0-9a-f]{64}$' OR COALESCE(p_before ->> 'identitySha256', '') !~ '^[0-9a-f]{64}$'
     OR COALESCE(p_before ->> 'credentialSha256', '') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: the state snapshot (stateSha256, identitySha256, credentialSha256) is required';
  END IF;
  -- An inference call still being recorded would move the ledger under the snapshot.
  IF EXISTS (SELECT 1 FROM fleet_cognition_inflight WHERE agent_id = p_agent) THEN
    RAISE EXCEPTION 'FLEET_RUNTIME_UPGRADE_BUSY: an inference call of this founder is still in flight';
  END IF;
  PERFORM set_config('fleet.runtime_upgrade_op', v_id::text, true);
  INSERT INTO fleet_founder_runtime_upgrades (upgrade_id, agent_id, from_repo, from_commit, from_build_id, from_lockfile_sha256,
      to_repo, to_commit, to_build_id, to_lockfile_sha256, state_sha256_before, ledger_before, before, prepared_by)
    VALUES (v_id, p_agent, cur ->> 'repo', cur ->> 'commit', cur ->> 'buildId', cur ->> 'lockfileSha256',
      st.runtime_repo, st.runtime_commit, st.runtime_build_id, st.runtime_lockfile_sha256, p_before ->> 'stateSha256',
      fleet_founder_ledger_fingerprint(p_agent), p_before, left(p_actor, 128));
  PERFORM set_config('fleet.runtime_upgrade_op', '', true);
  PERFORM fleet_event('founder_runtime_upgrade_prepared', p_agent, p_actor, jsonb_build_object('upgradeId', v_id,
    'from', cur ->> 'commit', 'to', st.runtime_commit, 'toBuildId', st.runtime_build_id, 'stateSha256', p_before ->> 'stateSha256'));
  RETURN fleet_founder_runtime_upgrade_view(v_id);
END $$;

-- committed: the registry pin moves to the target in one transaction (the founder is still stopped).
CREATE FUNCTION fleet_founder_runtime_upgrade_commit(p_upgrade uuid, p_state_sha256 text, p_actor text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE u fleet_founder_runtime_upgrades; a fleet_agents; st fleet_state;
BEGIN
  IF p_actor IS NULL OR length(p_actor) < 3 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: actor required'; END IF;
  SELECT * INTO u FROM fleet_founder_runtime_upgrades WHERE upgrade_id = p_upgrade FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such runtime upgrade'; END IF;
  IF u.status <> 'prepared' THEN RAISE EXCEPTION 'FLEET_RUNTIME_UPGRADE_REFUSED: upgrade is %, not prepared', u.status; END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = u.agent_id FOR UPDATE;
  IF a.status NOT IN ('active','unresponsive') THEN RAISE EXCEPTION 'FLEET_RUNTIME_UPGRADE_REFUSED: founder is %', a.status; END IF;
  IF a.runtime_commit IS DISTINCT FROM u.from_commit OR a.runtime_repo IS DISTINCT FROM u.from_repo THEN
    RAISE EXCEPTION 'FLEET_RUNTIME_PIN_MISMATCH: the registry pin changed since the upgrade was prepared';
  END IF;
  SELECT * INTO st FROM fleet_state WHERE id = 1;
  IF st.runtime_repo IS DISTINCT FROM u.to_repo OR st.runtime_commit IS DISTINCT FROM u.to_commit
     OR st.runtime_build_id IS DISTINCT FROM u.to_build_id OR st.runtime_lockfile_sha256 IS DISTINCT FROM u.to_lockfile_sha256 THEN
    RAISE EXCEPTION 'FLEET_RUNTIME_NOT_APPROVED: the approved runtime changed since the upgrade was prepared';
  END IF;
  -- Nothing may have moved while the founder was stopped: not its files, not its books.
  IF p_state_sha256 IS DISTINCT FROM u.state_sha256_before THEN
    RAISE EXCEPTION 'FLEET_RUNTIME_STATE_MISMATCH: the founder''s state changed since it was snapshotted';
  END IF;
  IF EXISTS (SELECT 1 FROM fleet_cognition_inflight WHERE agent_id = u.agent_id) OR fleet_founder_ledger_fingerprint(u.agent_id) <> u.ledger_before THEN
    RAISE EXCEPTION 'FLEET_RUNTIME_STATE_MISMATCH: the founder''s ledger moved since it was snapshotted';
  END IF;
  PERFORM set_config('fleet.runtime_upgrade_op', u.upgrade_id::text, true);
  -- The switched runtime is challenged on its first heartbeat (runtime identity + policy canary): prompt health proof.
  UPDATE fleet_agents SET runtime_repo = u.to_repo, runtime_commit = u.to_commit, challenge_requested_at = now(), updated_at = now() WHERE agent_id = u.agent_id;
  UPDATE fleet_founder_runtime_upgrades SET status = 'committed', committed_at = now() WHERE upgrade_id = u.upgrade_id;
  PERFORM set_config('fleet.runtime_upgrade_op', '', true);
  PERFORM fleet_event('founder_runtime_upgrade_committed', u.agent_id, p_actor, jsonb_build_object('upgradeId', u.upgrade_id, 'from', u.from_commit, 'to', u.to_commit));
  RETURN fleet_founder_runtime_upgrade_view(u.upgrade_id);
END $$;

-- Health and continuity since p_since, from the registry's own record (never from the caller's claim).
CREATE FUNCTION fleet_founder_runtime_health_since(p_agent text, p_since timestamptz) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'status', a.status, 'lastHeartbeat', a.last_heartbeat, 'heartbeatAfter', COALESCE(a.last_heartbeat > p_since, false),
    'challengesPassed', (SELECT count(*) FROM fleet_health_challenges c WHERE c.agent_id = p_agent AND c.outcome = 'passed' AND c.answered_at > p_since),
    -- Only challenges ISSUED since then: one left pending when the runtime was stopped expires through no fault of the new one.
    'challengesFailed', (SELECT count(*) FROM fleet_health_challenges c WHERE c.agent_id = p_agent AND c.outcome IN ('failed','expired') AND c.issued_at > p_since),
    'challengeFailures', a.challenge_failures, 'runtimeCommit', a.runtime_commit)
  FROM fleet_agents a WHERE a.agent_id = p_agent
$$;

-- verified: the SAME founder is alive on the target runtime (decided from the registry's record + host observation).
CREATE FUNCTION fleet_founder_runtime_upgrade_verify(p_upgrade uuid, p_after jsonb, p_actor text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE u fleet_founder_runtime_upgrades; h jsonb; lf jsonb; v_bad text;
BEGIN
  IF p_actor IS NULL OR length(p_actor) < 3 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: actor required'; END IF;
  SELECT * INTO u FROM fleet_founder_runtime_upgrades WHERE upgrade_id = p_upgrade FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such runtime upgrade'; END IF;
  IF u.status <> 'committed' THEN RAISE EXCEPTION 'FLEET_RUNTIME_UPGRADE_REFUSED: upgrade is %, not committed', u.status; END IF;
  h := fleet_founder_runtime_health_since(u.agent_id, u.committed_at);
  lf := fleet_founder_ledger_fingerprint(u.agent_id);
  IF p_after ->> 'agentId' IS DISTINCT FROM u.agent_id THEN v_bad := 'observed process belongs to another founder';
  ELSIF p_after ->> 'commit' IS DISTINCT FROM u.to_commit THEN v_bad := 'observed runtime commit differs from the target';
  ELSIF p_after ->> 'buildId' IS DISTINCT FROM u.to_build_id THEN v_bad := 'observed runtime build differs from the target';
  ELSIF p_after ->> 'lockfileSha256' IS DISTINCT FROM u.to_lockfile_sha256 THEN v_bad := 'observed runtime lockfile differs from the target';
  ELSIF p_after ->> 'identitySha256' IS DISTINCT FROM u.before ->> 'identitySha256' THEN v_bad := 'founder identity file changed';
  ELSIF p_after ->> 'credentialSha256' IS DISTINCT FROM u.before ->> 'credentialSha256' THEN v_bad := 'founder credential changed';
  ELSIF p_after ->> 'stateSha256AtStart' IS DISTINCT FROM u.state_sha256_before THEN v_bad := 'founder state was not identical when the new runtime started';
  ELSIF (p_after ->> 'durableLost')::integer IS DISTINCT FROM 0 THEN v_bad := 'memory or workspace files were lost';
  ELSIF h ->> 'status' <> 'active' THEN v_bad := 'founder is not active';
  ELSIF h ->> 'runtimeCommit' IS DISTINCT FROM u.to_commit THEN v_bad := 'registry pin is not the target';
  ELSIF (h ->> 'challengesFailed')::integer <> 0 THEN v_bad := 'a health challenge failed since the switch';
  ELSIF (h ->> 'heartbeatAfter')::boolean IS NOT TRUE THEN v_bad := 'no heartbeat since the switch';
  ELSIF (h ->> 'challengesPassed')::integer < 1 THEN v_bad := 'no health challenge passed since the switch';
  ELSIF (SELECT jsonb_agg(jsonb_build_object('account', x ->> 'account', 'class', x ->> 'class') ORDER BY x ->> 'account') FROM jsonb_array_elements(lf -> 'accounts') x)
        IS DISTINCT FROM
        (SELECT jsonb_agg(jsonb_build_object('account', x ->> 'account', 'class', x ->> 'class') ORDER BY x ->> 'account') FROM jsonb_array_elements(u.ledger_before -> 'accounts') x)
    THEN v_bad := 'ledger accounts differ';
  ELSIF (lf ->> 'journals')::bigint < (u.ledger_before ->> 'journals')::bigint THEN v_bad := 'ledger history shrank';
  END IF;
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'FLEET_RUNTIME_VERIFY_FAILED: %', v_bad; END IF;
  PERFORM set_config('fleet.runtime_upgrade_op', u.upgrade_id::text, true);
  UPDATE fleet_founder_runtime_upgrades SET status = 'verified', verified_at = now(),
      after = p_after || jsonb_build_object('health', h, 'ledger', lf) WHERE upgrade_id = u.upgrade_id;
  PERFORM set_config('fleet.runtime_upgrade_op', '', true);
  PERFORM fleet_event('founder_runtime_upgrade_verified', u.agent_id, p_actor, jsonb_build_object('upgradeId', u.upgrade_id, 'commit', u.to_commit, 'buildId', u.to_build_id));
  RETURN fleet_founder_runtime_upgrade_view(u.upgrade_id);
END $$;

-- rolled_back: the registry pin returns to the runtime recorded at prepare (only the founder's latest switch can be undone).
CREATE FUNCTION fleet_founder_runtime_upgrade_rollback(p_upgrade uuid, p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE u fleet_founder_runtime_upgrades; a fleet_agents;
BEGIN
  IF p_actor IS NULL OR length(p_actor) < 3 OR p_reason IS NULL OR length(p_reason) < 3 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: actor and reason required'; END IF;
  SELECT * INTO u FROM fleet_founder_runtime_upgrades WHERE upgrade_id = p_upgrade FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such runtime upgrade'; END IF;
  IF u.status NOT IN ('committed','verified') THEN RAISE EXCEPTION 'FLEET_RUNTIME_UPGRADE_REFUSED: upgrade is %; only a committed or verified upgrade is rolled back', u.status; END IF;
  IF EXISTS (SELECT 1 FROM fleet_founder_runtime_upgrades x WHERE x.agent_id = u.agent_id AND x.seq > u.seq AND x.status IN ('prepared','committed','verified')) THEN
    RAISE EXCEPTION 'FLEET_RUNTIME_UPGRADE_REFUSED: a later upgrade of this founder exists; roll that one back first';
  END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = u.agent_id FOR UPDATE;
  IF a.runtime_commit IS DISTINCT FROM u.to_commit THEN RAISE EXCEPTION 'FLEET_RUNTIME_PIN_MISMATCH: the registry pin is not this upgrade''s target'; END IF;
  PERFORM set_config('fleet.runtime_upgrade_op', u.upgrade_id::text, true);
  UPDATE fleet_agents SET runtime_repo = u.from_repo, runtime_commit = u.from_commit, challenge_requested_at = now(), updated_at = now() WHERE agent_id = u.agent_id;
  UPDATE fleet_founder_runtime_upgrades SET status = 'rolled_back', closed_at = now(), closed_by = left(p_actor, 128), reason = left(p_reason, 500) WHERE upgrade_id = u.upgrade_id;
  PERFORM set_config('fleet.runtime_upgrade_op', '', true);
  PERFORM fleet_event('founder_runtime_upgrade_rolled_back', u.agent_id, p_actor, jsonb_build_object('upgradeId', u.upgrade_id, 'restored', u.from_commit, 'reason', left(p_reason, 300)));
  RETURN fleet_founder_runtime_upgrade_view(u.upgrade_id);
END $$;

-- The founder's health on the restored runtime, recorded once (evidence only; the rollback itself is already final).
CREATE FUNCTION fleet_founder_runtime_upgrade_rollback_verify(p_upgrade uuid, p_after jsonb, p_actor text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE u fleet_founder_runtime_upgrades; h jsonb; v_bad text;
BEGIN
  IF p_actor IS NULL OR length(p_actor) < 3 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: actor required'; END IF;
  SELECT * INTO u FROM fleet_founder_runtime_upgrades WHERE upgrade_id = p_upgrade FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such runtime upgrade'; END IF;
  IF u.status <> 'rolled_back' OR u.rollback IS NOT NULL THEN RAISE EXCEPTION 'FLEET_RUNTIME_UPGRADE_REFUSED: no unverified rollback on this upgrade'; END IF;
  h := fleet_founder_runtime_health_since(u.agent_id, u.closed_at);
  IF p_after ->> 'agentId' IS DISTINCT FROM u.agent_id THEN v_bad := 'observed process belongs to another founder';
  ELSIF p_after ->> 'commit' IS DISTINCT FROM u.from_commit OR p_after ->> 'buildId' IS DISTINCT FROM u.from_build_id THEN v_bad := 'observed runtime is not the restored runtime';
  ELSIF p_after ->> 'identitySha256' IS DISTINCT FROM u.before ->> 'identitySha256' THEN v_bad := 'founder identity file changed';
  ELSIF p_after ->> 'credentialSha256' IS DISTINCT FROM u.before ->> 'credentialSha256' THEN v_bad := 'founder credential changed';
  ELSIF (p_after ->> 'durableLost')::integer IS DISTINCT FROM 0 THEN v_bad := 'memory or workspace files were lost';
  ELSIF h ->> 'status' <> 'active' THEN v_bad := 'founder is not active';
  ELSIF h ->> 'runtimeCommit' IS DISTINCT FROM u.from_commit THEN v_bad := 'registry pin is not the restored runtime';
  ELSIF (h ->> 'challengesFailed')::integer <> 0 THEN v_bad := 'a health challenge failed since the rollback';
  ELSIF (h ->> 'heartbeatAfter')::boolean IS NOT TRUE THEN v_bad := 'no heartbeat since the rollback';
  ELSIF (h ->> 'challengesPassed')::integer < 1 THEN v_bad := 'no health challenge passed since the rollback';
  END IF;
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'FLEET_RUNTIME_VERIFY_FAILED: %', v_bad; END IF;
  PERFORM set_config('fleet.runtime_upgrade_op', u.upgrade_id::text, true);
  UPDATE fleet_founder_runtime_upgrades SET rollback = p_after || jsonb_build_object('health', h, 'ledger', fleet_founder_ledger_fingerprint(u.agent_id), 'verifiedBy', left(p_actor, 128)) WHERE upgrade_id = u.upgrade_id;
  PERFORM set_config('fleet.runtime_upgrade_op', '', true);
  PERFORM fleet_event('founder_runtime_rollback_verified', u.agent_id, p_actor, jsonb_build_object('upgradeId', u.upgrade_id, 'commit', u.from_commit));
  RETURN fleet_founder_runtime_upgrade_view(u.upgrade_id);
END $$;

-- aborted: nothing was switched.
CREATE FUNCTION fleet_founder_runtime_upgrade_abort(p_upgrade uuid, p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE u fleet_founder_runtime_upgrades;
BEGIN
  IF p_actor IS NULL OR length(p_actor) < 3 OR p_reason IS NULL OR length(p_reason) < 3 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: actor and reason required'; END IF;
  SELECT * INTO u FROM fleet_founder_runtime_upgrades WHERE upgrade_id = p_upgrade FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such runtime upgrade'; END IF;
  IF u.status <> 'prepared' THEN RAISE EXCEPTION 'FLEET_RUNTIME_UPGRADE_REFUSED: upgrade is %; only a prepared upgrade is aborted', u.status; END IF;
  PERFORM set_config('fleet.runtime_upgrade_op', u.upgrade_id::text, true);
  UPDATE fleet_founder_runtime_upgrades SET status = 'aborted', closed_at = now(), closed_by = left(p_actor, 128), reason = left(p_reason, 500) WHERE upgrade_id = u.upgrade_id;
  PERFORM set_config('fleet.runtime_upgrade_op', '', true);
  PERFORM fleet_event('founder_runtime_upgrade_aborted', u.agent_id, p_actor, jsonb_build_object('upgradeId', u.upgrade_id, 'reason', left(p_reason, 300)));
  RETURN fleet_founder_runtime_upgrade_view(u.upgrade_id);
END $$;

-- Health challenges: an upgraded founder must also report its registered BUILD (Genesis-state founders: commit, as attested).
CREATE OR REPLACE FUNCTION svc_answer_challenge(p_agent text, p_challenge_id text, p_nonce text, p_commit text, p_build_id text, p_policy_ok boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_agents; c fleet_health_challenges; l fleet_reservations; st fleet_state; v_fail text; v_rt jsonb;
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
  IF a.origin IN ('genesis_founder','reseed_founder') THEN v_rt := fleet_founder_runtime_current(p_agent); END IF;
  IF a.status NOT IN ('active','unresponsive') THEN v_fail := 'agent not living';
  ELSIF c.nonce_hash <> encode(sha256(convert_to(COALESCE(p_nonce, ''), 'UTF8')), 'hex') THEN v_fail := 'nonce mismatch';
  ELSIF a.role = 'child' AND (l.reservation_id IS NULL OR p_commit IS DISTINCT FROM l.expected_commit) THEN v_fail := 'runtime commit mismatch';
  ELSIF a.role = 'child' AND p_build_id IS DISTINCT FROM l.expected_build_id THEN v_fail := 'runtime build mismatch';
  ELSIF a.role = 'root' AND a.runtime_commit IS NOT NULL AND p_commit IS DISTINCT FROM a.runtime_commit THEN v_fail := 'runtime commit mismatch';
  ELSIF v_rt ->> 'source' = 'upgrade' AND p_build_id IS DISTINCT FROM v_rt ->> 'buildId' THEN v_fail := 'runtime build mismatch';
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

-- ═══ 2. Prompt-cache policy per tier, and its observed economics ═══
ALTER TABLE fleet_cognition_tiers
  ADD COLUMN prompt_cache text NOT NULL DEFAULT 'off' CHECK (prompt_cache IN ('off','prefix','prefix+tail')),
  -- T1 is a compact routine prompt, never padded to a cache minimum: caching it is not a policy choice.
  ADD CONSTRAINT fleet_cognition_tiers_t1_no_cache CHECK (tier <> 'T1' OR prompt_cache = 'off');
-- R22 evidence (docs/evaluations/routing-v22): the stable founder prefix is written once and read back on T2.
-- T3 shares the setting for a multi-step T3 task; a question-scoped escalation never caches (gateway scope rule).
UPDATE fleet_cognition_tiers SET prompt_cache = 'prefix', updated_at = now(), updated_by = 'migration:v23' WHERE tier IN ('T2','T3');

ALTER TABLE fleet_cognition_log
  ADD COLUMN cache_policy            text   CHECK (cache_policy IN ('off','prefix','prefix+tail')),
  ADD COLUMN cache_saving_microcents bigint;

CREATE FUNCTION fleet_cognition_tier_cache_set(p_tier text, p_mode text, p_actor text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_actor IS NULL OR length(p_actor) < 3 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: actor required'; END IF;
  IF p_mode NOT IN ('off','prefix','prefix+tail') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: cache mode is off, prefix or prefix+tail'; END IF;
  IF p_tier = 'T1' AND p_mode <> 'off' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: T1 routine prompts are never cached or padded'; END IF;
  UPDATE fleet_cognition_tiers SET prompt_cache = p_mode, updated_at = now(), updated_by = p_actor WHERE tier = p_tier;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: tier is T1, T2 or T3'; END IF;
  PERFORM fleet_event('cognition_tier_cache_set', NULL, p_actor, jsonb_build_object('tier', p_tier, 'promptCache', p_mode));
  RETURN (SELECT to_jsonb(x) FROM fleet_cognition_tiers x WHERE tier = p_tier);
END $$;

-- Routing state: + each tier's cache policy, when this founder's most recent call was (cache reuse expectation), and
-- which model produced the thinking an ongoing conversation may carry.
CREATE OR REPLACE FUNCTION svc_cognition_routing_state(p_agent text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'routingEnabled', fleet_routing_active(p_agent),
    'globalEnabled', r.routing_enabled,
    'majorSpendThresholdMinor', r.major_spend_threshold_minor,
    -- The model behind this founder's most recent call: provider-bound thinking is only handed back to the same model.
    'lastModel', (SELECT l.model FROM fleet_cognition_log l WHERE l.agent_id = p_agent ORDER BY l.seq DESC LIMIT 1),
    'lastAgeS', (SELECT floor(extract(epoch FROM now() - l.at))::integer FROM fleet_cognition_log l WHERE l.agent_id = p_agent ORDER BY l.seq DESC LIMIT 1),
    -- The model that produced the thinking a continuing conversation may carry: the founder's most recent successful
    -- conversational call. A T1 chore or a question-scoped escalation in between is a separate single-message
    -- conversation whose thinking never returns, so it must not make the loop's own thinking look foreign.
    'conversationModel', (SELECT l.model FROM fleet_cognition_log l WHERE l.agent_id = p_agent AND l.outcome = 'ok'
        AND (l.tier IS NULL OR (l.tier <> 'T1' AND COALESCE(l.router_decision ->> 'scope', 'task_step') <> 'question')) ORDER BY l.seq DESC LIMIT 1),
    'tiers', (SELECT COALESCE(jsonb_agg(jsonb_build_object('tier', t.tier, 'provider', t.provider, 'model', t.model, 'thinking', t.thinking,
                'effort', t.effort, 'maxOutputTokens', t.max_output_tokens, 'enabled', t.enabled, 'verifiedAt', t.verified_at, 'promptCache', t.prompt_cache,
                'prices', jsonb_build_object('inputMicrocentsPerToken', t.input_microcents_per_token, 'outputMicrocentsPerToken', t.output_microcents_per_token,
                  'cacheWriteMicrocentsPerToken', t.cache_write_microcents_per_token, 'cacheReadMicrocentsPerToken', t.cache_read_microcents_per_token))
                ORDER BY t.tier), '[]'::jsonb) FROM fleet_cognition_tiers t))
  FROM fleet_cognition_routing r WHERE r.id = 1
$$;

-- Routed record: as v22, plus the cache policy applied and its saving (+) or premium (−) at the snapshot prices:
--   saving = cache_read × (input − cache_read price) − cache_write × (cache_write − input price)   [USD µ¢]
CREATE OR REPLACE FUNCTION svc_cognition_routed_record(p_agent text, p_request uuid, p_outcome text, p_input_tokens integer, p_output_tokens integer,
  p_prompt_sha256 text, p_response_sha256 text, p_tool_calls jsonb, p_error_code text,
  p_usage_source text, p_attempts integer, p_provider_status integer, p_response_model text, p_latency_ms integer,
  p_cache_read_tokens integer, p_cache_write_tokens integer, p_provider_request_id text, p_stop_reason text,
  p_obs jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE i fleet_cognition_inflight; v_cost bigint; v_used_usd bigint; v_cost_l bigint; v_micro bigint; v_charge bigint; v_j uuid;
        v_unposted bigint; v_total bigint; v_rate bigint; v_acct text; v_saving bigint;
        v_ok boolean := p_outcome = 'ok';
        v_src text := CASE WHEN p_usage_source IN ('provider','estimate','none') THEN p_usage_source ELSE 'estimate' END;
        v_in bigint := GREATEST(COALESCE(p_input_tokens, 0), 0); v_out bigint := GREATEST(COALESCE(p_output_tokens, 0), 0);
        v_cr bigint := GREATEST(COALESCE(p_cache_read_tokens, 0), 0); v_cw bigint := GREATEST(COALESCE(p_cache_write_tokens, 0), 0);
        rp jsonb; ro jsonb; v_obs jsonb := COALESCE(p_obs, '{}'::jsonb);
BEGIN
  SELECT * INTO i FROM fleet_cognition_inflight WHERE agent_id = p_agent AND request_id = p_request FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', CASE WHEN EXISTS (SELECT 1 FROM fleet_cognition_log WHERE request_id = p_request)
      THEN 'FLEET_COGNITION_ALREADY_RECORDED' ELSE 'FLEET_COGNITION_NOT_AUTHORIZED' END);
  END IF;
  -- Only a routed authorization is recorded here (its prices are the snapshot, not the legacy policy's).
  IF i.route_tier IS NULL OR i.route_prices IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ROUTE_NOT_AUTHORIZED'); END IF;
  IF v_ok AND v_src = 'none' THEN v_src := 'estimate'; END IF;
  rp := i.route_prices; ro := COALESCE(i.route, '{}'::jsonb);
  SELECT accounting_currency INTO v_acct FROM fleet_economic_model WHERE id = 1;
  v_rate := COALESCE(i.fx_rate_micro, 1000000);
  v_cost := CASE v_src
    WHEN 'provider' THEN v_in * (rp ->> 'in')::bigint + v_out * (rp ->> 'out')::bigint + v_cw * (rp ->> 'cw')::bigint + v_cr * (rp ->> 'cr')::bigint
    WHEN 'estimate' THEN COALESCE(i.estimate_usd_cents, i.estimate_cents) * 1000000 ELSE 0 END;
  v_saving := CASE WHEN v_src = 'provider'
    THEN v_cr * ((rp ->> 'in')::bigint - (rp ->> 'cr')::bigint) - v_cw * ((rp ->> 'cw')::bigint - (rp ->> 'in')::bigint) END;
  v_used_usd := v_cost;
  v_cost_l := ceil(v_cost::numeric * v_rate / 1000000)::bigint;
  v_micro := CASE v_src WHEN 'provider' THEN LEAST(i.estimate_cents * 1000000, v_cost_l) WHEN 'estimate' THEN i.estimate_cents * 1000000 ELSE 0 END;
  INSERT INTO fleet_cognition_accrual (agent_id) VALUES (p_agent) ON CONFLICT (agent_id) DO NOTHING;
  SELECT unposted_microcents INTO v_unposted FROM fleet_cognition_accrual WHERE agent_id = p_agent FOR UPDATE;
  v_total := v_unposted + v_micro;
  v_charge := v_total / 1000000;
  v_unposted := v_total - v_charge * 1000000;
  IF v_charge > 0 THEN
    v_j := fleet_ledger_post('inference_charge', 'infer:' || p_request, 'controller', 'founder inference', 'controller', p_agent, NULL, NULL, NULL, NULL, now(),
      jsonb_build_array(
        jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_expense'), 'side', 'D', 'amount', v_charge),
        jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_cash'), 'side', 'C', 'amount', v_charge)));
  END IF;
  UPDATE fleet_cognition_accrual SET unposted_microcents = v_unposted, updated_at = now() WHERE agent_id = p_agent;
  IF v_used_usd > 0 THEN
    INSERT INTO fleet_provider_credit_events (provider, kind, usd_microcents, request_id, recorded_by)
      VALUES (i.route_provider, 'consumption', -v_used_usd, p_request, 'controller');
  END IF;
  DELETE FROM fleet_cognition_inflight WHERE agent_id = p_agent;
  INSERT INTO fleet_cognition_log (request_id, agent_id, provider, model, outcome, input_tokens, output_tokens, cost_microcents, charged_cents, journal_id,
      prompt_sha256, response_sha256, tool_calls, error_code, usage_source, attempts, provider_status, response_model, latency_ms,
      cache_read_tokens, cache_write_tokens, provider_request_id, stop_reason, charged_microcents,
      ledger_currency, fx_rate_id, fx_rate_micro, provider_usd_microcents,
      route_version, task_id, task_class, tier, requested_tier, escalation_reason, router_decision, parent_request_id, reasoning, packet_bytes, thinking_tokens,
      cache_policy, cache_saving_microcents)
    VALUES (p_request, p_agent, i.route_provider, i.route_model, CASE WHEN v_ok THEN 'ok' ELSE 'error' END,
      CASE WHEN v_src = 'provider' THEN v_in ELSE 0 END, CASE WHEN v_src = 'provider' THEN v_out ELSE 0 END, v_cost, v_charge, v_j,
      p_prompt_sha256, p_response_sha256, CASE WHEN v_ok THEN COALESCE(p_tool_calls, '[]'::jsonb) ELSE '[]'::jsonb END,
      CASE WHEN v_ok THEN NULL WHEN p_error_code ~ '^[A-Z_]{2,64}$' THEN p_error_code ELSE 'PROVIDER_ERROR' END,
      v_src, LEAST(GREATEST(COALESCE(p_attempts, 1), 1), 5),
      CASE WHEN p_provider_status BETWEEN 100 AND 599 THEN p_provider_status END,
      CASE WHEN p_response_model ~ '^[A-Za-z0-9._:/@-]{1,120}$' THEN p_response_model END,
      CASE WHEN p_latency_ms BETWEEN 0 AND 3600000 THEN p_latency_ms END,
      CASE WHEN v_src = 'provider' THEN v_cr ELSE 0 END, CASE WHEN v_src = 'provider' THEN v_cw ELSE 0 END,
      CASE WHEN p_provider_request_id ~ '^[A-Za-z0-9_.:-]{1,128}$' THEN p_provider_request_id END,
      CASE WHEN p_stop_reason ~ '^[a-z_]{1,40}$' THEN p_stop_reason END, v_micro,
      v_acct, i.fx_rate_id, v_rate, v_used_usd,
      1,
      CASE WHEN ro ->> 'taskId' ~ '^[A-Za-z0-9:_.-]{1,64}$' THEN ro ->> 'taskId' END,
      CASE WHEN ro ->> 'taskClass' ~ '^[a-z_]{3,48}$' THEN ro ->> 'taskClass' END,
      i.route_tier,
      CASE WHEN ro ->> 'requestedTier' IN ('T1','T2','T3') THEN ro ->> 'requestedTier' END,
      CASE WHEN ro ->> 'escalationReason' ~ '^[A-Z_]{3,40}$' THEN ro ->> 'escalationReason' END,
      jsonb_build_object('source', ro ->> 'source', 'scope', ro ->> 'scope', 'minTier', ro ->> 'minTier', 'maxTier', ro ->> 'maxTier', 'actionClass', ro ->> 'actionClass'),
      CASE WHEN ro ->> 'parentRequestId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (ro ->> 'parentRequestId')::uuid END,
      jsonb_build_object('thinking', ro ->> 'thinking', 'effort', ro ->> 'effort', 'promptCache', v_obs ->> 'promptCache', 'cacheReason', left(v_obs ->> 'cacheReason', 60)),
      CASE WHEN (v_obs ->> 'packetBytes') ~ '^[0-9]{1,7}$' THEN (v_obs ->> 'packetBytes')::integer END,
      CASE WHEN (v_obs ->> 'thinkingTokens') ~ '^[0-9]{1,9}$' THEN (v_obs ->> 'thinkingTokens')::integer END,
      CASE WHEN v_obs ->> 'promptCache' IN ('off','prefix','prefix+tail') THEN v_obs ->> 'promptCache' END, v_saving);
  RETURN jsonb_build_object('ok', true, 'chargedCents', v_charge, 'chargedMicrocents', v_micro, 'unpostedMicrocents', v_unposted,
    'journalId', v_j, 'usageSource', v_src, 'currency', v_acct, 'fxRateMicro', v_rate, 'providerUsdMicrocents', v_used_usd,
    'tier', i.route_tier, 'model', i.route_model, 'cacheSavingMicrocents', v_saving);
END $$;

-- Report: + cache policy and net cache saving per task class × tier × model.
CREATE OR REPLACE FUNCTION fleet_cognition_report(p_since timestamptz) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('since', p_since, 'rows', COALESCE(jsonb_agg(x ORDER BY x.tier NULLS FIRST, x.task_class NULLS FIRST), '[]'::jsonb))
  FROM (SELECT COALESCE(task_class, '(legacy)') AS task_class, tier, model,
               count(*) AS calls, count(*) FILTER (WHERE outcome = 'error') AS errors,
               count(*) FILTER (WHERE escalation_reason IS NOT NULL) AS escalations,
               sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
               sum(cache_read_tokens) AS cache_read_tokens, sum(cache_write_tokens) AS cache_write_tokens,
               sum(COALESCE(thinking_tokens, 0)) AS thinking_tokens, sum(COALESCE(packet_bytes, 0)) AS packet_bytes,
               sum(cost_microcents) AS provider_usd_microcents, sum(COALESCE(charged_microcents, 0)) AS charged_microcents,
               sum(attempts - 1) AS retries,
               count(*) FILTER (WHERE cache_policy IS NOT NULL AND cache_policy <> 'off') AS cached_calls,
               sum(COALESCE(cache_saving_microcents, 0)) AS cache_saving_microcents
          FROM fleet_cognition_log WHERE at >= p_since GROUP BY 1, 2, 3) x
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

/**
 * Schema v33 — constitutional correction: no synthetic tax, no required legal entity (owner decision 2026-10-02).
 *
 * Automaton Fleet is an experimental autonomous economic survival system funded by the owner — not a company or a
 * conventional managed business. Conventional administration must not become an artificial restriction on it:
 *
 * 1. NO SYNTHETIC AGENT TAX. Until v32, a sale whose venture had no tax profile reserved `unprofiled_reserve_bp`
 *    (default 25 %) of its net cash into the agent's restricted tax reserve — a deduction from survival capital with no
 *    real obligation behind it. Now a sale reserves tax ONLY under an owner-configured tax profile (an actual external
 *    obligation). The fallback rate is pinned to 0 (CHECK); its setter refuses anything else. The true-up releases a
 *    reserve that no configured obligation backs (none exists in production: no sale has settled).
 * 2. A LEGAL ENTITY IS OPTIONAL owner metadata. A payment rail no longer needs one, and rail matching never fails for
 *    lack of one: an entity restricts matching only when BOTH the rail and the venture name one (and they differ).
 *    A rail's entity, once set, stays fixed.
 *
 * 3. FUTURE AGENTS CAN TRANSACT. A replicated child's economic identity is the same keyless controller-custody address a
 *    Genesis founder has (v32 custody pays only keyless identities); the wallet its upstream runtime generated is kept
 *    as `runtime_wallet_address`, information only — never custody, never paid. Replication itself stays off.
 *
 * Unchanged: an owner-configured tax profile (when real-world law actually requires it) still reserves exactly what it
 * says, at the owner/payment boundary; tax payments, refunds and the profile history are as before. Custody, payment
 * security and the ledger are untouched; nothing here gives FleetController a commercial say.
 */

import { V29_SQL } from "./migrations-phase29.js";

/** A v29 function verbatim, as CREATE OR REPLACE, with exact asserted edits. */
function v29Function(name: string, edits: Array<[string, string]>): string {
  const start = V29_SQL.indexOf(`CREATE FUNCTION ${name}(`);
  const end = V29_SQL.indexOf("END $$;", start);
  if (start < 0 || end < 0) throw new Error(`v33: v29 function ${name} not found`);
  if (!/LANGUAGE plpgsql/.test(V29_SQL.slice(start, V29_SQL.indexOf("$$", start)))) throw new Error(`v33: ${name} is not plpgsql (restate it in full)`);
  let body = "CREATE OR REPLACE" + V29_SQL.slice(start + "CREATE".length, end + "END $$;".length);
  for (const [from, to] of edits) {
    if (!body.includes(from)) throw new Error(`v33: expected text not found in ${name}`);
    body = body.replace(from, to);
  }
  return body;
}

const TAX_FOR_SALE = v29Function("fleet_tax_for_sale", [
  [`  IF pr.profile_id IS NULL THEN
    v_other := fleet_ceil_bp(GREATEST(p_gross - p_fee, 0), (SELECT unprofiled_reserve_bp FROM fleet_tax_policy WHERE id = 1));
    RETURN jsonb_build_object('profileId', NULL, 'fallback', true, 'vatMinor', 0, 'salesTaxMinor', 0, 'profitTaxMinor', 0, 'otherMinor', v_other, 'totalMinor', v_other);
  END IF;`,
   `  -- v33: no configured obligation, no reserve (no synthetic tax on survival capital).
  IF pr.profile_id IS NULL THEN
    RETURN jsonb_build_object('profileId', NULL, 'fallback', false, 'profiled', false, 'vatMinor', 0, 'salesTaxMinor', 0, 'profitTaxMinor', 0, 'otherMinor', 0, 'totalMinor', 0);
  END IF;`],
]);

const TRUE_UP = v29Function("fleet_tax_true_up", [
  [`  IF pr.profile_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'skipped', true, 'reason', 'no active tax profile: the conservative fallback reserve stays in place');
  END IF;`,
   `  -- v33: without a configured obligation nothing is owed: a reserve left from the retired fallback returns to the agent.
  IF pr.profile_id IS NULL THEN
    v_have := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_tax_reserve'));
    IF v_have > 0 THEN
      v_j := fleet_ledger_post('tax_reserve_release', 'taxup:' || p_agent || ':' || gen_random_uuid(), p_actor, 'no configured tax obligation: reserve released',
        'controller', p_agent, NULL, NULL, NULL, NULL, now(),
        jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_cash'), 'side', 'D', 'amount', v_have),
                          jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_tax_reserve'), 'side', 'C', 'amount', v_have)));
      PERFORM fleet_event('tax_true_up', p_agent, p_actor, jsonb_build_object('targetMinor', 0, 'reservedBefore', v_have, 'movedMinor', -v_have, 'reason', 'no configured obligation'));
    END IF;
    RETURN jsonb_build_object('ok', true, 'skipped', v_have = 0, 'reason', 'no configured tax obligation', 'releasedMinor', GREATEST(v_have, 0), 'journalId', v_j);
  END IF;`],
]);

// fleet_rail_match is a SQL-language function (no END): restated in full, identical but for the entity condition.
const RAIL_MATCH = `CREATE OR REPLACE FUNCTION fleet_rail_match(p_venture uuid, p_capability text, p_preference text, p_provider text) RETURNS fleet_payment_rails LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT r.* FROM fleet_payment_rails r
   WHERE r.status = 'active' AND p_capability = ANY (r.capabilities)
     -- v33: an entity restricts matching only when both the rail and the venture name one.
     AND (r.legal_entity_id IS NULL OR fleet_venture_entity(p_venture) IS NULL OR r.legal_entity_id = fleet_venture_entity(p_venture))
     AND (p_provider IS NULL OR r.provider = p_provider)
     AND (CASE p_preference WHEN 'dedicated' THEN r.dedicated_venture_id = p_venture
                            WHEN 'shared' THEN r.rail_kind = 'shared'
                            ELSE r.dedicated_venture_id = p_venture OR r.rail_kind = 'shared' END)
     AND (r.rail_kind = 'dedicated' OR r.max_ventures IS NULL
          OR (SELECT count(DISTINCT a.venture_id) FROM fleet_rail_assignments a WHERE a.rail_id = r.rail_id AND a.released_at IS NULL) < r.max_ventures)
     AND (r.credential_id IS NULL OR EXISTS (SELECT 1 FROM fleet_credential_refs c WHERE c.credential_id = r.credential_id AND c.status IN ('active','rotating')))
   ORDER BY (r.dedicated_venture_id = p_venture) DESC NULLS LAST, r.created_at
   LIMIT 1
$$;`;

const RAILS_GUARD = v29Function("fleet_payment_rails_guard", [
  ["OR NEW.legal_entity_id <> OLD.legal_entity_id", "OR (OLD.legal_entity_id IS NOT NULL AND NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id)"],
]);

export const V33_SQL = `
-- ═══ 1. No synthetic tax ═══
UPDATE fleet_tax_policy SET unprofiled_reserve_bp = 0, updated_at = now(), updated_by = 'migration' WHERE id = 1;
ALTER TABLE fleet_tax_policy ALTER COLUMN unprofiled_reserve_bp SET DEFAULT 0;
ALTER TABLE fleet_tax_policy ADD CONSTRAINT fleet_tax_policy_no_synthetic_tax CHECK (unprofiled_reserve_bp = 0);
COMMENT ON COLUMN fleet_tax_policy.unprofiled_reserve_bp IS 'LEGACY (retired at v33): pinned 0. No reserve is taken without an owner-configured tax profile (an actual obligation).';
${TAX_FOR_SALE}

${TRUE_UP}

CREATE OR REPLACE FUNCTION fleet_admin_tax_policy_set(p_unprofiled_reserve_bp integer, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  IF COALESCE(p_unprofiled_reserve_bp, 0) <> 0 THEN
    RAISE EXCEPTION 'FLEET_NO_SYNTHETIC_TAX: an unprofiled reserve is retired; configure an actual obligation with a tax profile';
  END IF;
  RETURN (SELECT to_jsonb(t) - 'id' FROM fleet_tax_policy t WHERE id = 1);
END $$;

-- ═══ 2. Legal entity optional ═══
ALTER TABLE fleet_payment_rails ALTER COLUMN legal_entity_id DROP NOT NULL;
${RAILS_GUARD}

${RAIL_MATCH}

-- ═══ 3. Future agents: keyless economic identity at activation ═══
ALTER TABLE fleet_agents ADD COLUMN runtime_wallet_address text CHECK (runtime_wallet_address IS NULL OR length(runtime_wallet_address) BETWEEN 1 AND 128);
COMMENT ON COLUMN fleet_agents.runtime_wallet_address IS 'v33: the address a replicated runtime generated for itself (information only). The economic identity (wallet_address) is the keyless controller-custody address.';
CREATE OR REPLACE FUNCTION svc_activate(p_agent text, p_parent text, p_wallet text, p_sandbox text, p_runtime_commit text,
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

  -- v33: a runtime address already identifying another agent is a duplicate registration (as when it was the identity).
  IF p_wallet IS NOT NULL AND EXISTS (SELECT 1 FROM fleet_agents x WHERE x.agent_id <> p_agent
       AND (lower(x.wallet_address) = lower(p_wallet) OR lower(x.runtime_wallet_address) = lower(p_wallet))) THEN
    RAISE EXCEPTION 'duplicate key value violates unique constraint "fleet_agents_runtime_wallet_uq"' USING ERRCODE = 'unique_violation', CONSTRAINT = 'fleet_agents_runtime_wallet_uq';
  END IF;
  -- v33: a child's ECONOMIC identity is keyless controller custody (like a Genesis founder): custody can pay it without
  -- the child ever holding a payment credential. The address its runtime reports is recorded as information only.
  UPDATE fleet_agents SET status = 'active', wallet_address = fleet_keyless_address(p_agent), runtime_wallet_address = p_wallet, sandbox_id = p_sandbox,
         runtime_version = COALESCE(att->>'version', p_runtime_version),
         last_heartbeat = now(), reservation_expires_at = NULL, updated_at = now()
   WHERE agent_id = p_agent AND status = 'provisioning'
   RETURNING * INTO a;
  UPDATE fleet_reservations SET status = 'completed', completed_at = now(), attested_at = now(),
         attestation = att, updated_at = now()
   WHERE reservation_id = l.reservation_id AND status = 'provisioning';
  PERFORM fleet_event('runtime_verified', p_agent, p_actor, jsonb_build_object('reservationId', l.reservation_id,
    'commit', att->>'commit', 'buildId', att->>'buildId', 'lockfileSha256', att->>'lockfileSha256'));
  PERFORM fleet_event('agent_activated', p_agent, p_actor, jsonb_build_object('walletAddress', a.wallet_address, 'runtimeWalletAddress', p_wallet,
    'sandboxId', p_sandbox, 'runtimeCommit', att->>'commit'));
  INSERT INTO fleet_agent_credentials (agent_id, token_hash) VALUES (p_agent, p_token_hash)
    ON CONFLICT (agent_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, created_at = now(), revoked_at = NULL;
  PERFORM fleet_event('credential_issued', p_agent, p_actor, '{}'::jsonb);
  RETURN jsonb_build_object('ok', true, 'agent', fleet_agent_json(a));
END $$;

-- An agent's runtime wallet is still an agent identity: it can never approve anything (self-approval guard).
CREATE OR REPLACE FUNCTION fleet_require_operator_approver(p_approver text, p_subject text) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_approver IS NULL OR length(trim(p_approver)) = 0 THEN
    RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: an operator approver is required';
  END IF;
  IF p_approver = p_subject OR EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = p_approver OR lower(wallet_address) = lower(p_approver)
                                                                  OR lower(runtime_wallet_address) = lower(p_approver)) THEN
    RAISE EXCEPTION 'FLEET_SELF_APPROVAL: agents cannot approve capital exceptions (approver %)', p_approver;
  END IF;
  IF p_approver ~* '^op[:_]' OR EXISTS (SELECT 1 FROM fleet_operator_principals WHERE principal_id = p_approver OR name = p_approver) THEN
    RAISE EXCEPTION 'FLEET_SELF_APPROVAL: operator API principals can never approve (approver %)', p_approver;
  END IF;
END $$;

-- The agent record carries the runtime address too (a replicated child confirms its identity with it).
CREATE OR REPLACE FUNCTION fleet_agent_json(a fleet_agents) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'agentId', a.agent_id, 'parentAgentId', a.parent_agent_id, 'role', a.role, 'generation', a.generation,
    'name', a.name, 'walletAddress', a.wallet_address, 'runtimeWalletAddress', a.runtime_wallet_address, 'runtimeVersion', a.runtime_version,
    'runtimeRepo', a.runtime_repo, 'runtimeCommit', a.runtime_commit, 'sandboxId', a.sandbox_id,
    'localChildId', a.local_child_id, 'status', a.status, 'statusReason', a.status_reason,
    'requestedBy', a.requested_by, 'createdAt', a.created_at, 'updatedAt', a.updated_at,
    'lastHeartbeat', a.last_heartbeat, 'deathTime', a.death_time)
$$;
-- A runtime address identifies one agent only (duplicate registration stays refused, as when it was the identity).
CREATE UNIQUE INDEX fleet_agents_runtime_wallet_uq ON fleet_agents (lower(runtime_wallet_address)) WHERE runtime_wallet_address IS NOT NULL;

-- The agent's own view carries its runtime address (a replicated child confirms its identity with it).
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
    'name', a.name, 'walletAddress', a.wallet_address, 'runtimeWalletAddress', a.runtime_wallet_address, 'runtimeVersion', a.runtime_version,
    'runtimeRepo', a.runtime_repo, 'runtimeCommit', a.runtime_commit, 'sandboxId', a.sandbox_id,
    'localChildId', a.local_child_id, 'status', a.status, 'statusReason', a.status_reason,
    'requestedBy', a.requested_by, 'createdAt', a.created_at, 'updatedAt', a.updated_at,
    'lastHeartbeat', a.last_heartbeat, 'deathTime', a.death_time, 'capabilityScope', a.capability_scope));
END $$;
`;

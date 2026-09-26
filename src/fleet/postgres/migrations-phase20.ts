/**
 * Schema v20 — Genesis bootstrap capital (owner decision for Founder 1: £100.00).
 *
 * The ledger is USD-only (v10: integer USD cents; inference is billed in USD). The owner decides founder
 * capital in its own currency, so a Genesis now records BOTH, bound into the owner's authorization hash:
 *   capital_currency / capital_minor     the owner's decision (GBP, 10000 = £100.00)
 *   fx_usd_micro / fx_source / fx_observed_at   the rate (USD per unit × 10^6) the owner states at proposal
 *   allocation_cents                      floor(capital_minor × rate / 10^6): the ledger amount (never more than the capital buys)
 * The rate must be fresh (observed within 24 h of the proposal); nothing here invents one.
 *
 * Classification is unchanged and explicit: the owner's contribution is recorded as owner_funding
 * (treasury) and reaches the founder as genesis_allocation — never revenue, profit, realized net profit
 * or reproduction-eligible earnings.
 *
 * The amount is policy, not a constitutional constant: fleet_genesis_set_bootstrap (owner only) changes it
 * for future Geneses. While a bootstrap capital is configured, every new Genesis must carry exactly it
 * (fleet_genesis_propose_capital); the plain USD proposal path is refused.
 */

export const V20_SQL = `
ALTER TABLE fleet_genesis_policy
  ADD COLUMN bootstrap_capital_currency text   CHECK (bootstrap_capital_currency ~ '^[A-Z]{3}$'),
  ADD COLUMN bootstrap_capital_minor    bigint CHECK (bootstrap_capital_minor BETWEEN 1 AND 100000000000),
  ADD CONSTRAINT fleet_genesis_policy_bootstrap_pair CHECK ((bootstrap_capital_currency IS NULL) = (bootstrap_capital_minor IS NULL));
COMMENT ON COLUMN fleet_genesis_policy.bootstrap_capital_minor IS
  'Owner bootstrap capital per founder, in minor units of bootstrap_capital_currency (Founder 1: GBP 10000 = 100.00). Policy, not a constant.';
UPDATE fleet_genesis_policy SET bootstrap_capital_currency = 'GBP', bootstrap_capital_minor = 10000, updated_by = 'migration:v20', updated_at = now() WHERE id = 1;

ALTER TABLE fleet_genesis
  ADD COLUMN capital_currency text        CHECK (capital_currency ~ '^[A-Z]{3}$'),
  ADD COLUMN capital_minor    bigint      CHECK (capital_minor BETWEEN 1 AND 100000000000),
  ADD COLUMN fx_usd_micro     bigint      CHECK (fx_usd_micro BETWEEN 1 AND 1000000000),
  ADD COLUMN fx_source        text        CHECK (length(fx_source) BETWEEN 3 AND 200),
  ADD COLUMN fx_observed_at   timestamptz,
  ADD CONSTRAINT fleet_genesis_capital_complete CHECK (
    (capital_minor IS NULL AND capital_currency IS NULL AND fx_usd_micro IS NULL AND fx_source IS NULL AND fx_observed_at IS NULL)
    OR (capital_minor IS NOT NULL AND capital_currency IS NOT NULL AND fx_usd_micro IS NOT NULL AND fx_source IS NOT NULL AND fx_observed_at IS NOT NULL
        AND allocation_cents = floor(capital_minor::numeric * fx_usd_micro / 1000000)::bigint
        AND (capital_currency <> 'USD' OR fx_usd_micro = 1000000)));

-- The owner approves the capital decision and the rate: both are part of the authorization content.
-- (concat_ws skips NULLs, so authorizations without capital hash exactly as before.)
CREATE OR REPLACE FUNCTION fleet_genesis_canonical(g fleet_genesis) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT concat_ws('|', 'fleet-genesis-v1', g.genesis_id::text, g.kind, g.idempotency_key, g.founder_count, g.template_version,
    g.manifest_id, g.manifest_sha256, g.runtime_repo, g.runtime_commit, g.runtime_build_id, g.runtime_lockfile_sha256,
    g.economic_policy_sha256, g.allocation_cents, to_char(g.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), g.requested_by,
    CASE WHEN g.capital_minor IS NULL THEN NULL ELSE concat_ws(':', 'capital', g.capital_currency, g.capital_minor, g.fx_usd_micro, g.fx_source,
      to_char(g.fx_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END)
$$;

-- Capital fields are frozen after the proposal (as every other authorization field).
CREATE FUNCTION fleet_genesis_capital_frozen() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF (NEW.capital_currency, NEW.capital_minor, NEW.fx_usd_micro, NEW.fx_source, NEW.fx_observed_at)
     IS DISTINCT FROM (OLD.capital_currency, OLD.capital_minor, OLD.fx_usd_micro, OLD.fx_source, OLD.fx_observed_at) THEN
    RAISE EXCEPTION 'FLEET_GENESIS_TAMPERED: the capital decision and rate of an authorization cannot change';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_genesis_capital_frozen BEFORE UPDATE ON fleet_genesis
  FOR EACH ROW EXECUTE FUNCTION fleet_genesis_capital_frozen();

-- While a bootstrap capital is configured, every new Genesis carries exactly it, at a fresh rate.
CREATE FUNCTION fleet_genesis_capital_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE pol fleet_genesis_policy;
BEGIN
  SELECT * INTO pol FROM fleet_genesis_policy WHERE id = 1;
  IF pol.bootstrap_capital_minor IS NOT NULL AND (NEW.capital_minor IS DISTINCT FROM pol.bootstrap_capital_minor
       OR NEW.capital_currency IS DISTINCT FROM pol.bootstrap_capital_currency) THEN
    RAISE EXCEPTION 'FLEET_GENESIS_CAPITAL: Genesis capital is % % (minor units) per founder; use fleet_genesis_propose_capital',
      pol.bootstrap_capital_currency, pol.bootstrap_capital_minor;
  END IF;
  IF NEW.capital_minor IS NOT NULL AND (NEW.fx_observed_at > now() + interval '5 minutes' OR NEW.fx_observed_at < now() - interval '24 hours') THEN
    RAISE EXCEPTION 'FLEET_GENESIS_FX_STALE: the exchange rate must have been observed within 24 hours';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_genesis_capital_guard BEFORE INSERT ON fleet_genesis
  FOR EACH ROW EXECUTE FUNCTION fleet_genesis_capital_guard();

-- Owner only: change the bootstrap capital for FUTURE Geneses (NULL, NULL = no capital decision; plain USD proposals).
CREATE FUNCTION fleet_genesis_set_bootstrap(p_currency text, p_minor bigint, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM fleet_genesis_owner(p_actor);
  UPDATE fleet_genesis_policy SET bootstrap_capital_currency = p_currency, bootstrap_capital_minor = p_minor, updated_by = p_actor, updated_at = now() WHERE id = 1;
  PERFORM fleet_event('genesis_bootstrap_capital_set', NULL, p_actor, jsonb_build_object('currency', p_currency, 'minorUnits', p_minor));
  RETURN jsonb_build_object('ok', true, 'currency', p_currency, 'minorUnits', p_minor);
END $$;

CREATE FUNCTION fleet_genesis_propose_capital(p_idem text, p_founder_count integer, p_manifest_id text, p_fx_usd_micro bigint,
  p_fx_source text, p_fx_observed_at timestamptz, p_ttl_s integer, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p_kind text := 'genesis'; p_allocation_cents bigint; g fleet_genesis; pol fleet_genesis_policy; st fleet_state; m fleet_capability_manifests; v_id uuid := gen_random_uuid(); prior fleet_genesis;
BEGIN
  PERFORM fleet_genesis_owner(p_actor);
  IF p_idem IS NULL OR p_idem !~ '^[A-Za-z0-9:_.-]{8,128}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: idempotency key required'; END IF;
  SELECT * INTO pol FROM fleet_genesis_policy WHERE id = 1;
  IF pol.bootstrap_capital_minor IS NULL THEN RAISE EXCEPTION 'FLEET_GENESIS_CAPITAL: no bootstrap capital is configured'; END IF;
  IF p_fx_usd_micro IS NULL OR p_fx_usd_micro < 1 OR p_fx_usd_micro > 1000000000
     OR (pol.bootstrap_capital_currency = 'USD' AND p_fx_usd_micro <> 1000000) THEN
    RAISE EXCEPTION 'FLEET_GENESIS_FX_INVALID: USD per % must be a positive rate (micro-units)', pol.bootstrap_capital_currency;
  END IF;
  -- Conservative conversion: never more USD cents than the owner's capital buys at the stated rate.
  p_allocation_cents := floor(pol.bootstrap_capital_minor::numeric * p_fx_usd_micro / 1000000)::bigint;
  SELECT * INTO st FROM fleet_state WHERE id = 1;
  SELECT * INTO m FROM fleet_capability_manifests WHERE manifest_id = COALESCE(p_manifest_id, pol.default_manifest_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_MANIFEST_INVALID: unknown manifest'; END IF;
  IF p_kind = 'reseeding' AND NOT pol.refounding_enabled THEN RAISE EXCEPTION 'FLEET_RESEEDING_NOT_ENABLED: reseeding is modelled but not enabled'; END IF;
  IF p_kind <> 'genesis' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: kind is genesis'; END IF;
  IF p_founder_count IS NULL OR p_founder_count < 1 OR p_founder_count > 50 THEN
    RAISE EXCEPTION 'FLEET_CAP_EXCEEDED: founder count must be 1..50 (constitutional maximum)';
  END IF;
  IF p_allocation_cents IS NULL OR p_allocation_cents < 0 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: allocation must be >= 0'; END IF;
  IF st.runtime_commit IS NULL OR st.runtime_build_id IS NULL OR st.runtime_lockfile_sha256 IS NULL THEN
    RAISE EXCEPTION 'FLEET_RUNTIME_NOT_APPROVED: approve a runtime before Genesis';
  END IF;
  SELECT * INTO prior FROM fleet_genesis WHERE idempotency_key = p_idem;
  IF FOUND THEN
    IF prior.founder_count = p_founder_count AND prior.manifest_id = m.manifest_id AND prior.allocation_cents = p_allocation_cents AND prior.kind = p_kind
       AND prior.fx_usd_micro IS NOT DISTINCT FROM p_fx_usd_micro AND prior.fx_source IS NOT DISTINCT FROM p_fx_source THEN
      RETURN fleet_genesis_json(prior) || jsonb_build_object('replay', true);
    END IF;
    RAISE EXCEPTION 'FLEET_IDEMPOTENCY_CONFLICT: key % belongs to a different Genesis', p_idem;
  END IF;
  PERFORM fleet_genesis_begin(v_id, p_actor);
  g.genesis_id := v_id; g.kind := p_kind; g.idempotency_key := p_idem; g.founder_count := p_founder_count;
  g.template_version := pol.template_version; g.manifest_id := m.manifest_id; g.manifest_sha256 := m.manifest_sha256;
  g.runtime_repo := st.runtime_repo; g.runtime_commit := st.runtime_commit; g.runtime_build_id := st.runtime_build_id;
  g.runtime_lockfile_sha256 := st.runtime_lockfile_sha256; g.economic_policy_sha256 := fleet_economic_policy_sha256();
  g.allocation_cents := p_allocation_cents;
  g.capital_currency := pol.bootstrap_capital_currency; g.capital_minor := pol.bootstrap_capital_minor; g.fx_usd_micro := p_fx_usd_micro;
  g.fx_source := p_fx_source; g.fx_observed_at := date_trunc('milliseconds', p_fx_observed_at);
  g.expires_at := date_trunc('milliseconds', now() + make_interval(secs => LEAST(GREATEST(COALESCE(p_ttl_s, 86400), 600), pol.max_ttl_s)));
  g.requested_by := p_actor;
  g.auth_sha256 := encode(sha256(convert_to(fleet_genesis_canonical(g), 'UTF8')), 'hex');
  INSERT INTO fleet_genesis (genesis_id, kind, idempotency_key, founder_count, template_version, manifest_id, manifest_sha256, runtime_repo,
      runtime_commit, runtime_build_id, runtime_lockfile_sha256, economic_policy_sha256, allocation_cents, expires_at, requested_by, auth_sha256,
      capital_currency, capital_minor, fx_usd_micro, fx_source, fx_observed_at)
    VALUES (g.genesis_id, g.kind, g.idempotency_key, g.founder_count, g.template_version, g.manifest_id, g.manifest_sha256, g.runtime_repo,
      g.runtime_commit, g.runtime_build_id, g.runtime_lockfile_sha256, g.economic_policy_sha256, g.allocation_cents, g.expires_at, g.requested_by, g.auth_sha256,
      g.capital_currency, g.capital_minor, g.fx_usd_micro, g.fx_source, g.fx_observed_at)
    RETURNING * INTO g;
  PERFORM fleet_event('genesis_proposed', NULL, p_actor, jsonb_build_object('genesisId', v_id, 'founderCount', p_founder_count, 'capitalCurrency', g.capital_currency, 'capitalMinor', g.capital_minor, 'fxUsdMicro', g.fx_usd_micro,
    'authSha256', g.auth_sha256, 'allocationCents', p_allocation_cents));
  PERFORM fleet_genesis_end();
  RETURN fleet_genesis_json(g);
END $$;

CREATE OR REPLACE FUNCTION fleet_genesis_json(g fleet_genesis) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('genesisId', g.genesis_id, 'kind', g.kind, 'status', g.status, 'founderCount', g.founder_count,
    'manifestId', g.manifest_id, 'manifestSha256', g.manifest_sha256, 'templateVersion', g.template_version,
    'runtime', jsonb_build_object('repo', g.runtime_repo, 'commit', g.runtime_commit, 'buildId', g.runtime_build_id, 'lockfileSha256', g.runtime_lockfile_sha256),
    'economicPolicySha256', g.economic_policy_sha256, 'allocationCents', g.allocation_cents, 'expiresAt', g.expires_at,
    'requestedBy', g.requested_by, 'approvedBy', g.approved_by, 'approvedAt', g.approved_at, 'activatedAt', g.activated_at,
    'authSha256', g.auth_sha256,
    'capital', CASE WHEN g.capital_minor IS NULL THEN NULL ELSE jsonb_build_object('currency', g.capital_currency, 'minorUnits', g.capital_minor,
      'fxUsdMicro', g.fx_usd_micro, 'fxSource', g.fx_source, 'fxObservedAt', g.fx_observed_at, 'classification', 'owner_bootstrap_capital') END, 'founderIds', to_jsonb(g.founder_ids), 'statusReason', g.status_reason,
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

/**
 * Schema v40 — birth provisioning: a birth order becomes a running agent (master handoff §§16–19, 45–46; owner
 * correction 2026-10-02).
 *
 * The birth order (automatic: earned + healthy for 24 h with every switch on; Admin: a step-up-confirmed override;
 * reseed: a new agent inheriting a dead agent's estate) IS the authorization. `fleet_birth_authorize` turns a queued
 * order into an APPROVED one-founder Genesis cohort of kind 'birth', linked to its order, pinned to the approved runtime,
 * the capability manifest and the economic policy exactly like the initial Genesis. From there the proven Genesis
 * machinery runs unchanged — provision (keyless identity, reserved), attest (runtime evidence), fund (the order's own
 * funding from the Treasury), activate (credential) — through the same host provisioner (`fleet-founders.sh birth`).
 *
 * Born agents carry origin 'reseed_founder' (a founder created after the initial Genesis), so every founder-aware path
 * (capabilities, cognition, runtime pins, upgrades) applies to them unchanged; the initial Genesis keeps its one-shot
 * rules (empty fleet, done once). Activation marks the order born, links the agent, starts its birth mission and, for a
 * reseed, transfers the dead agent's transferable estate. The registry's living cap and the 50 ceiling still bind every
 * provisioning (the reserved slot counts). Founders still cannot spawn children themselves (reproduction stays pinned):
 * new agents come only from birth orders.
 */
import { V11_SQL } from "./migrations-phase11.js";
import { V21_SQL } from "./migrations-phase21.js";
import { V35_SQL } from "./migrations-phase35.js";
import { DASHBOARD_READ_OPS_V39, V39_SQL } from "./migrations-phase39.js";

function restate(src: string, name: string, edits: Array<[string, string]>): string {
  const head = Math.max(src.lastIndexOf(`CREATE FUNCTION ${name}(`), src.lastIndexOf(`CREATE OR REPLACE FUNCTION ${name}(`));
  if (head < 0) throw new Error(`v40: function ${name} not found`);
  const end = src.indexOf("$$;", src.indexOf("AS $$", head) + 5);
  let body = "CREATE OR REPLACE " + src.slice(src.indexOf("FUNCTION", head), end + 3);
  for (const [from, to] of edits) {
    if (body.split(from).length !== 2) throw new Error(`v40: expected text not found exactly once in ${name}: ${from.slice(0, 60)}`);
    body = body.replace(from, to);
  }
  return body;
}

const PROVISION = restate(V11_SQL, "fleet_genesis_provision", [
  [`VALUES (v_agent, 'root', 0, 'founder-' || i,`,
   `VALUES (v_agent, 'root', 0, CASE WHEN g.kind = 'birth' THEN 'agent-' || (SELECT count(*) + 1 FROM fleet_agents WHERE origin IN ('genesis_founder','reseed_founder')) ELSE 'founder-' || i END,`],
  [`g.runtime_repo, g.runtime_commit, 'reserved', 'Genesis founder (no authority until activation)', p_actor,
        'genesis_founder', p_id,`,
   `g.runtime_repo, g.runtime_commit, 'reserved', CASE WHEN g.kind = 'birth' THEN 'born agent (no authority until activation)' ELSE 'Genesis founder (no authority until activation)' END, p_actor,
        CASE WHEN g.kind = 'genesis' THEN 'genesis_founder' ELSE 'reseed_founder' END, p_id,`],
]);

const ACTIVATE = restate(V11_SQL, "fleet_genesis_activate", [
  [`  PERFORM fleet_event('genesis_activated', NULL, p_actor, jsonb_build_object('genesisId', p_id, 'founderIds', to_jsonb(g.founder_ids)));`,
   `  PERFORM fleet_event('genesis_activated', NULL, p_actor, jsonb_build_object('genesisId', p_id, 'founderIds', to_jsonb(g.founder_ids)));
  IF g.kind = 'birth' THEN PERFORM fleet_birth_born(g.birth_order_id, g.founder_ids[1], p_id, p_actor); END IF;`],
]);

// The configured Genesis capital governs the initial Genesis; a birth carries the funding its order chose.
const CAPITAL_GUARD = restate(V21_SQL, "fleet_genesis_capital_guard", [
  [`  IF pol.bootstrap_capital_minor IS NOT NULL AND (NEW.capital_minor`, `  IF NEW.kind <> 'birth' AND pol.bootstrap_capital_minor IS NOT NULL AND (NEW.capital_minor`],
]);

const LIVE = `status NOT IN ('activated','expired','rolled_back','cancelled','rejected')`;

// A manual fulfilment never races the pipeline: an order with a live cohort is the pipeline's to finish.
const FULFIL = restate(V35_SQL, "fleet_admin_birth_fulfil", [
  [`  IF o.status <> 'queued' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: the order is %', o.status; END IF;`,
   `  IF o.status <> 'queued' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: the order is %', o.status; END IF;
  IF EXISTS (SELECT 1 FROM fleet_genesis WHERE birth_order_id = p_order AND ${LIVE}) THEN
    RAISE EXCEPTION 'FLEET_INVALID_STATE: the order is being provisioned (cohort in flight)';
  END IF;`],
]);

// Cancelling an order unwinds its cohort: an unprovisioned one closes; a provisioned one rolls back (its reserved agent
// fails and any funding returns to the Treasury).
const CANCEL = restate(V35_SQL, "fleet_admin_birth_cancel", [
  [`BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_population');`,
   `DECLARE g fleet_genesis;
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_population');
  SELECT * INTO g FROM fleet_genesis WHERE birth_order_id = p_order AND ${LIVE} FOR UPDATE;
  IF FOUND AND EXISTS (SELECT 1 FROM fleet_birth_orders WHERE order_id = p_order AND status = 'queued') THEN
    PERFORM fleet_genesis_close(g.genesis_id, 'cancelled', p_actor, left('birth order cancelled: ' || p_reason, 200));
  END IF;`],
]);

/** v40: the control centre shows each queued order's provisioning cohort. */
export const DASHBOARD_READ_OPS_V40 = [...DASHBOARD_READ_OPS_V39, "births_pending"] as const;
const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const DASH_CALL = restate(V39_SQL, "dash_call", [
  [`p_op IN (${q(DASHBOARD_READ_OPS_V39)})`, `p_op IN (${q(DASHBOARD_READ_OPS_V40)})`],
  [`      WHEN 'reveal_log' THEN fleet_admin_reveal_log(200)`, `      WHEN 'reveal_log' THEN fleet_admin_reveal_log(200)
      WHEN 'births_pending' THEN fleet_admin_births_pending()`],
]);

export const V40_SQL = `
ALTER TABLE fleet_genesis DROP CONSTRAINT fleet_genesis_kind_check;
ALTER TABLE fleet_genesis ADD CONSTRAINT fleet_genesis_kind_check CHECK (kind IN ('genesis','reseeding','birth'));
ALTER TABLE fleet_genesis ADD COLUMN birth_order_id uuid REFERENCES fleet_birth_orders(order_id);
ALTER TABLE fleet_genesis ADD CONSTRAINT fleet_genesis_birth_link CHECK ((kind = 'birth') = (birth_order_id IS NOT NULL));
CREATE FUNCTION fleet_genesis_birth_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.birth_order_id IS DISTINCT FROM OLD.birth_order_id THEN RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: a birth cohort''s order never changes'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_genesis_birth_link_guard BEFORE UPDATE ON fleet_genesis FOR EACH ROW EXECUTE FUNCTION fleet_genesis_birth_link_guard();

ALTER TABLE fleet_birth_orders ADD COLUMN genesis_id uuid REFERENCES fleet_genesis(genesis_id);
-- One live birth cohort per order (an expired or rolled-back cohort may be replaced by a new one).
CREATE UNIQUE INDEX fleet_genesis_birth_live ON fleet_genesis (birth_order_id)
  WHERE birth_order_id IS NOT NULL AND status NOT IN ('expired','rolled_back','cancelled','rejected');

${CAPITAL_GUARD}
${PROVISION}

-- A queued order becomes an approved one-founder birth cohort (the order is the authorization).
CREATE FUNCTION fleet_birth_authorize(p_order uuid, p_ttl_s integer, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_birth_orders; g fleet_genesis; pol fleet_genesis_policy; st fleet_state; m fleet_capability_manifests; v_id uuid := gen_random_uuid();
        v_acct text := (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1); live fleet_genesis; pop jsonb;
BEGIN
  PERFORM fleet_genesis_owner(p_actor);
  SELECT * INTO o FROM fleet_birth_orders WHERE order_id = p_order FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such birth order'; END IF;
  IF o.status <> 'queued' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: the birth order is %', o.status; END IF;
  SELECT * INTO live FROM fleet_genesis WHERE birth_order_id = p_order AND status NOT IN ('expired','rolled_back','cancelled','rejected');
  IF FOUND THEN RETURN fleet_genesis_json(live) || jsonb_build_object('replay', true, 'birthOrderId', p_order); END IF;
  SELECT * INTO pol FROM fleet_genesis_policy WHERE id = 1;
  IF NOT pol.genesis_enabled THEN RAISE EXCEPTION 'FLEET_GENESIS_DISABLED: agent provisioning is not enabled'; END IF;
  SELECT * INTO st FROM fleet_state WHERE id = 1;
  IF st.runtime_commit IS NULL OR st.runtime_build_id IS NULL OR st.runtime_lockfile_sha256 IS NULL THEN
    RAISE EXCEPTION 'FLEET_RUNTIME_NOT_APPROVED: approve a runtime before provisioning an agent';
  END IF;
  -- The order itself already holds a population place (queued orders count); the reserved slot binds again at provisioning.
  pop := fleet_population();
  IF (pop ->> 'living')::integer >= (pop ->> 'ceiling')::integer THEN
    RAISE EXCEPTION 'FLEET_CAP_EXCEEDED: % living agents reach the population ceiling %', pop ->> 'living', pop ->> 'ceiling';
  END IF;
  IF o.funding_source = 'treasury' AND o.funding_minor > fleet_ledger_balance('fleet:treasury:unallocated') THEN
    RAISE EXCEPTION 'FLEET_TREASURY_INSUFFICIENT: the Treasury holds % unallocated for a % funding', fleet_ledger_balance('fleet:treasury:unallocated'), o.funding_minor;
  END IF;
  SELECT * INTO m FROM fleet_capability_manifests WHERE manifest_id = pol.default_manifest_id;
  PERFORM fleet_genesis_begin(v_id, p_actor);
  g.genesis_id := v_id; g.kind := 'birth'; g.idempotency_key := 'birth:' || replace(p_order::text, '-', '') || ':' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS');
  g.founder_count := 1; g.template_version := pol.template_version; g.manifest_id := m.manifest_id; g.manifest_sha256 := m.manifest_sha256;
  g.runtime_repo := st.runtime_repo; g.runtime_commit := st.runtime_commit; g.runtime_build_id := st.runtime_build_id;
  g.runtime_lockfile_sha256 := st.runtime_lockfile_sha256; g.economic_policy_sha256 := fleet_economic_policy_sha256();
  g.allocation_cents := CASE WHEN o.funding_source = 'treasury' THEN o.funding_minor ELSE 0 END;
  g.expires_at := date_trunc('milliseconds', now() + make_interval(secs => LEAST(GREATEST(COALESCE(p_ttl_s, 86400), 600), pol.max_ttl_s)));
  g.requested_by := p_actor; g.capital_minor := NULLIF(g.allocation_cents, 0); g.capital_currency := CASE WHEN g.allocation_cents > 0 THEN v_acct END;
  g.auth_sha256 := encode(sha256(convert_to(fleet_genesis_canonical(g), 'UTF8')), 'hex');
  INSERT INTO fleet_genesis (genesis_id, kind, idempotency_key, founder_count, template_version, manifest_id, manifest_sha256, runtime_repo,
      runtime_commit, runtime_build_id, runtime_lockfile_sha256, economic_policy_sha256, allocation_cents, expires_at, requested_by, auth_sha256,
      capital_minor, capital_currency, birth_order_id)
    VALUES (g.genesis_id, g.kind, g.idempotency_key, g.founder_count, g.template_version, g.manifest_id, g.manifest_sha256, g.runtime_repo,
      g.runtime_commit, g.runtime_build_id, g.runtime_lockfile_sha256, g.economic_policy_sha256, g.allocation_cents, g.expires_at, g.requested_by, g.auth_sha256,
      g.capital_minor, g.capital_currency, p_order)
    RETURNING * INTO g;
  UPDATE fleet_genesis SET status = 'approved', approved_by = p_actor, approved_at = now(), status_reason = 'authorized by birth order ' || p_order
   WHERE genesis_id = v_id RETURNING * INTO g;
  UPDATE fleet_birth_orders SET genesis_id = v_id, updated_at = now() WHERE order_id = p_order;
  PERFORM fleet_event('birth_authorized', NULL, p_actor, jsonb_build_object('orderId', p_order, 'genesisId', v_id, 'kind', o.kind, 'fundingMinor', g.allocation_cents));
  PERFORM fleet_genesis_end();
  RETURN fleet_genesis_json(g) || jsonb_build_object('birthOrderId', p_order, 'authSha256', g.auth_sha256);
END $$;

-- Activation of a birth cohort: the order is born; a reseed inherits the dead agent's transferable estate; the birth
-- mission (if any) starts.
CREATE FUNCTION fleet_birth_born(p_order uuid, p_agent text, p_genesis uuid, p_actor text) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_birth_orders; it record; v_n integer := 0; v_j uuid;
BEGIN
  SELECT * INTO o FROM fleet_birth_orders WHERE order_id = p_order FOR UPDATE;
  IF NOT FOUND OR o.status <> 'queued' THEN RAISE EXCEPTION 'FLEET_GENESIS_INCONSISTENT: birth order % is not queued', p_order; END IF;
  SELECT allocation_journal_id INTO v_j FROM fleet_genesis_founders WHERE genesis_id = p_genesis AND agent_id = p_agent;
  UPDATE fleet_birth_orders SET status = 'born', agent_id = p_agent, funding_journal = v_j, updated_at = now() WHERE order_id = p_order;
  IF o.kind = 'reseed' THEN
    FOR it IN SELECT item_id FROM fleet_estate_items WHERE origin_agent_id = o.inherits_from AND status = 'held' AND kind IN ('identity','account','asset') LOOP
      PERFORM fleet_estate_assign_internal(it.item_id, p_agent, p_actor, 'reseed inheritance');
      v_n := v_n + 1;
    END LOOP;
  END IF;
  IF o.mission IN ('marketing','opportunity_hunt','knowledge_data') THEN
    PERFORM fleet_mission_start(p_agent, o.mission, NULL, 'birth mission: ' || o.reason, NULL, p_actor);
  END IF;
  PERFORM fleet_event('agent_born', p_agent, p_actor, jsonb_build_object('orderId', p_order, 'genesisId', p_genesis, 'kind', o.kind, 'mission', o.mission,
    'fundingMinor', o.funding_minor, 'journalId', v_j, 'inherited', v_n));
END $$;

${ACTIVATE}
${FULFIL}
${CANCEL}

CREATE FUNCTION fleet_admin_births_pending() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('orderId', o.order_id, 'kind', o.kind, 'mission', o.mission, 'reason', o.reason, 'fundingMinor', o.funding_minor,
      'createdAt', o.created_at, 'genesisId', g.genesis_id, 'genesisStatus', g.status, 'authSha256', g.auth_sha256) ORDER BY o.created_at), '[]'::jsonb)
    FROM fleet_birth_orders o LEFT JOIN fleet_genesis g ON g.genesis_id = o.genesis_id WHERE o.status = 'queued'
$$;

${DASH_CALL}
`;

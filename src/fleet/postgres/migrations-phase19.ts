/**
 * Schema v19 — single-founder Genesis (Pre-Genesis step 5).
 *
 * Genesis takes the fleet from 0 to exactly ONE founder. The registry cap (2 in development) stays a
 * ceiling only: nothing creates a second founder. Growth beyond one founder is to be earned
 * economically (a later capability), never owner-funded at Genesis. Replacement after a founder's
 * death (1 → 0 → replacement) is a separate, later process (reseeding stays disabled).
 *
 *  - fleet_genesis_policy.genesis_max_founders (default 1): the most founders one Genesis may create.
 *    No SECURITY DEFINER function changes it; raising it is a reviewed migration or owner SQL.
 *  - every new Genesis row must have 1..genesis_max_founders founders (insert trigger, so no path
 *    around fleet_genesis_propose exists), and fleet_genesis_approve re-checks it.
 * The Genesis machinery itself stays N-founder capable (and its tests exercise N > 1 by raising the
 * policy in throwaway registries).
 */

export const V19_SQL = `
ALTER TABLE fleet_genesis_policy ADD COLUMN genesis_max_founders integer NOT NULL DEFAULT 1
  CHECK (genesis_max_founders BETWEEN 1 AND 50);
COMMENT ON COLUMN fleet_genesis_policy.genesis_max_founders IS
  'Founders one Genesis may create (production: 1). Expansion beyond it is earned, not founded. Changed only by reviewed migration/owner SQL.';

CREATE FUNCTION fleet_genesis_founder_count_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_max integer;
BEGIN
  SELECT genesis_max_founders INTO v_max FROM fleet_genesis_policy WHERE id = 1;
  IF v_max IS NULL OR NEW.founder_count IS NULL OR NEW.founder_count < 1 OR NEW.founder_count > v_max THEN
    RAISE EXCEPTION 'FLEET_GENESIS_FOUNDER_COUNT: Genesis creates at most % founder(s); requested %', COALESCE(v_max, 0), NEW.founder_count;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_genesis_founder_count BEFORE INSERT ON fleet_genesis
  FOR EACH ROW EXECUTE FUNCTION fleet_genesis_founder_count_guard();

CREATE OR REPLACE FUNCTION fleet_genesis_approve(p_id uuid, p_auth_sha256 text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE g fleet_genesis; st fleet_state; pol fleet_genesis_policy;
BEGIN
  PERFORM fleet_genesis_owner(p_actor);
  g := fleet_genesis_lock(p_id);
  SELECT * INTO pol FROM fleet_genesis_policy WHERE id = 1;
  IF NOT pol.genesis_enabled THEN RAISE EXCEPTION 'FLEET_GENESIS_DISABLED: the owner has not enabled Genesis'; END IF;
  IF g.status <> 'proposed' THEN RAISE EXCEPTION 'FLEET_GENESIS_CONSUMED: Genesis % is %', p_id, g.status; END IF;
  IF p_auth_sha256 IS DISTINCT FROM g.auth_sha256 THEN RAISE EXCEPTION 'FLEET_GENESIS_TAMPERED: approval does not match the authorization content'; END IF;
  PERFORM fleet_genesis_begin(p_id, p_actor);
  IF now() >= g.expires_at THEN
    UPDATE fleet_genesis SET status = 'expired', status_reason = 'expired before approval' WHERE genesis_id = p_id;
    PERFORM fleet_genesis_end();
    RETURN jsonb_build_object('status', 'expired', 'code', 'FLEET_GENESIS_EXPIRED');
  END IF;
  IF EXISTS (SELECT 1 FROM fleet_genesis WHERE status = 'activated') THEN
    RAISE EXCEPTION 'FLEET_GENESIS_ALREADY_DONE: the initial founder population already exists (reseeding is a separate process)';
  END IF;
  st := fleet_lock_state();
  IF st.living_agents + st.reserved_slots + st.quarantined_slots > 0 THEN
    RAISE EXCEPTION 'FLEET_GENESIS_POPULATION: Genesis requires an empty fleet';
  END IF;
  -- v19: re-checked at approval (the policy may have been lowered after the proposal).
  IF g.founder_count < 1 OR g.founder_count > pol.genesis_max_founders THEN
    RAISE EXCEPTION 'FLEET_GENESIS_FOUNDER_COUNT: Genesis creates at most % founder(s); this proposal has %', pol.genesis_max_founders, g.founder_count;
  END IF;
  IF g.founder_count > st.max_agents THEN
    RAISE EXCEPTION 'FLEET_CAP_EXCEEDED: % founders > registry cap %', g.founder_count, st.max_agents;
  END IF;
  UPDATE fleet_genesis SET status = 'approved', approved_by = p_actor, approved_at = now() WHERE genesis_id = p_id RETURNING * INTO g;
  PERFORM fleet_event('genesis_approved', NULL, p_actor, jsonb_build_object('genesisId', p_id, 'authSha256', g.auth_sha256));
  PERFORM fleet_genesis_end();
  RETURN fleet_genesis_json(g);
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

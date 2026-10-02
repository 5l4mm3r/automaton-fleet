/**
 * Schema v32 — controller custody signer (live-financial hardening). Real payments stay OFF.
 *
 * Custody model (E1, unchanged): the Fleet Treasury owns custody; agents hold virtual allocations in the ledger and submit
 * structured orders; FleetController decides WHAT is paid (custody/security validation, never commercial judgement);
 * the isolated custody executor (own OS user, own DB role) knows HOW and holds the only credentials that can move money.
 *
 * v32 completes the signer side of that boundary:
 *
 * 1. CUSTODY MODE is a fact derived from the wallet address, never set by hand. A Genesis founder's address is the
 *    keyless derivation '0x' || sha256('automaton-fleet:founder:no-key:' || agentId)[1..40] (v11): nothing can sign for
 *    it — `controller_keyless`. Any other address belongs to a runtime that generated its own key (upstream children,
 *    legacy roots) — `agent_held_key`: such an agent's orders are never issued to custody. The mode is read from the
 *    agent's identity address (immutable once set), never from a writable custody column.
 * 2. SIGNER ATTESTATION. The custody executor attests, per payment rail, that it holds a signer for that rail: the rail
 *    is active, provider/mode/credential match the registry, the credential is active and scoped to the capability.
 *    Attestations expire (a technical heartbeat window, owner policy; not a money limit) and are append-only.
 * 3. INSTRUCTIONS ARE BOUND. An instruction names the payment rail, provider, mode, credential, capability and venture
 *    it executes on, all inside its content hash. It is issued only for a controller-custody agent, a payable
 *    destination (provider account / bank transfer; never crypto or credits), a destination whose reference is on
 *    record, and a LIVE rail with a fresh attestation. No signer → that payment waits (FLEET_NO_CUSTODY_SIGNER); nothing
 *    else is blocked. Live rails and custody execution remain constitutionally pinned off (v10, v29 CHECKs).
 * 4. CREDENTIAL USE BY CUSTODY is gated and audited per instruction under its lease (a revoked credential fails the
 *    payment closed, before any provider call).
 * 5. SETTLEMENT is attributed exactly: the settlement journal is linked to the instruction's venture (envelope venture,
 *    else the vendor destination's venture) — venture → agent → wallet (ledger) → Treasury.
 *
 * No amount, runway or owner threshold is introduced: own capital stays founder-sized and custody-checked (v27/v31);
 * Fleet capital stays under its envelopes (v30).
 */

import { V10_SQL } from "./migrations-phase10.js";

/** A v10 function verbatim, as CREATE OR REPLACE, with exact asserted edits. */
function v10Function(name: string, edits: Array<[string, string]>): string {
  const start = V10_SQL.indexOf(`CREATE FUNCTION ${name}(`);
  const end = V10_SQL.indexOf("END $$;", start);
  if (start < 0 || end < 0) throw new Error(`v32: v10 function ${name} not found`);
  let body = "CREATE OR REPLACE" + V10_SQL.slice(start + "CREATE".length, end + "END $$;".length);
  for (const [from, to] of edits) {
    if (!body.includes(from)) throw new Error(`v32: expected text not found in ${name}`);
    body = body.replace(from, to);
  }
  return body;
}

const INSTRUCTIONS_GUARD = v10Function("fleet_instructions_guard", [
  [
    "    IF NEW.status <> 'issued' THEN RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: instructions start issued'; END IF;",
    `    IF NEW.status <> 'issued' THEN RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: instructions start issued'; END IF;
    -- v32: every instruction is bound to the rail, credential and signer capability that executes it.
    IF NEW.payment_rail_id IS NULL OR NEW.credential_id IS NULL OR NEW.provider IS NULL OR NEW.rail_mode IS NULL OR NEW.capability IS NULL THEN
      RAISE EXCEPTION 'FLEET_CUSTODY_UNBOUND: an instruction names its payment rail, credential and capability';
    END IF;`,
  ],
]);

const CLAIM = v10Function("cx_claim_instruction", [
  ["DECLARE i fleet_payment_instructions; d fleet_payment_destinations;",
   "DECLARE i fleet_payment_instructions; d fleet_payment_destinations; c fleet_credential_refs; v_ref text;"],
  [`  SELECT * INTO d FROM fleet_payment_destinations WHERE destination_id = i.destination_id;
  RETURN jsonb_build_object('ok', true, 'instruction', jsonb_build_object('instructionId', i.instruction_id, 'amountCents', i.amount_cents,
    'destinationId', i.destination_id, 'rail', i.rail, 'referenceSha256', d.reference_sha256, 'instructionSha256', i.instruction_sha256));`,
   `  SELECT * INTO d FROM fleet_payment_destinations WHERE destination_id = i.destination_id;
  SELECT * INTO c FROM fleet_credential_refs WHERE credential_id = i.credential_id;
  SELECT reference INTO v_ref FROM fleet_destination_references WHERE destination_id = i.destination_id;
  -- v32: the signer needs where to pay (the reference; it re-checks it against the enrolled hash) and which rail/credential.
  RETURN jsonb_build_object('ok', true, 'instruction', jsonb_build_object('instructionId', i.instruction_id, 'amountCents', i.amount_cents,
    'destinationId', i.destination_id, 'rail', i.rail, 'referenceSha256', d.reference_sha256, 'instructionSha256', i.instruction_sha256,
    'reference', v_ref, 'paymentRailId', i.payment_rail_id, 'provider', i.provider, 'railMode', i.rail_mode, 'credentialId', i.credential_id,
    'vaultRef', c.vault_ref, 'capability', i.capability, 'ventureId', i.venture_id,
    'currency', (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1)));`],
]);

const REPORT = v10Function("cx_report_result", [
  ["DECLARE i fleet_payment_instructions; o fleet_payment_orders; v_j uuid; v_class text;",
   "DECLARE i fleet_payment_instructions; o fleet_payment_orders; v_j uuid; v_class text; v_cost text;"],
  [`      IF o.category IN ('asset_acquisition','conway_credits') THEN`,
   `      -- v32: exact venture attribution of the settlement (venture → agent → wallet → Treasury).
      IF i.venture_id IS NOT NULL THEN
        v_cost := CASE o.category WHEN 'fee' THEN 'processor_fee' WHEN 'asset_acquisition' THEN 'capital' WHEN 'conway_credits' THEN 'inference' ELSE 'operating' END;
        INSERT INTO fleet_venture_journals (journal_id, venture_id, agent_id, cost_category, attributed_by)
          VALUES (v_j, i.venture_id, o.agent_id, v_cost, 'custody-executor');
      END IF;
      IF o.category IN ('asset_acquisition','conway_credits') THEN`],
]);

export const V32_SQL = `
-- ═══ 1. Custody mode: derived from the wallet address ═══
CREATE FUNCTION fleet_keyless_address(p_agent text) RETURNS text LANGUAGE sql IMMUTABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT '0x' || substr(encode(sha256(convert_to('automaton-fleet:founder:no-key:' || p_agent, 'UTF8')), 'hex'), 1, 40)
$$;
ALTER TABLE fleet_wallet_custody DROP CONSTRAINT fleet_wallet_custody_custody_mode_check;
ALTER TABLE fleet_wallet_custody ALTER COLUMN custody_mode DROP DEFAULT;
CREATE FUNCTION fleet_wallet_custody_mode() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_addr text;
BEGIN
  -- Derived from the agent's IDENTITY address (immutable once set, v5/v6), never from a writable custody column.
  SELECT wallet_address INTO v_addr FROM fleet_agents WHERE agent_id = NEW.agent_id;
  IF TG_OP = 'INSERT' OR NEW.wallet_address IS DISTINCT FROM OLD.wallet_address THEN
    IF v_addr IS NULL OR lower(NEW.wallet_address) IS DISTINCT FROM lower(v_addr) THEN
      RAISE EXCEPTION 'FLEET_CUSTODY_IDENTITY: a custody record carries its agent''s own identity address';
    END IF;
  END IF;
  -- Never chosen: a keyless (Genesis) identity is controller custody; any other address has a key held by its runtime.
  NEW.custody_mode := CASE WHEN v_addr IS NOT NULL AND lower(v_addr) = fleet_keyless_address(NEW.agent_id) THEN 'controller_keyless' ELSE 'agent_held_key' END;
  RETURN NEW;
END $$;
UPDATE fleet_wallet_custody w SET custody_mode = CASE WHEN lower(a.wallet_address) = fleet_keyless_address(w.agent_id) THEN 'controller_keyless' ELSE 'agent_held_key' END
  FROM fleet_agents a WHERE a.agent_id = w.agent_id;
ALTER TABLE fleet_wallet_custody ADD CONSTRAINT fleet_wallet_custody_mode_v32 CHECK (custody_mode IN ('controller_keyless','agent_held_key'));
CREATE TRIGGER fleet_wallet_custody_mode BEFORE INSERT OR UPDATE ON fleet_wallet_custody FOR EACH ROW EXECUTE FUNCTION fleet_wallet_custody_mode();
COMMENT ON COLUMN fleet_wallet_custody.custody_mode IS 'v32: derived from the address (trigger). controller_keyless = Genesis keyless identity, custody is the Treasury ledger; agent_held_key = the runtime generated its own key: never issued to custody.';

-- ═══ 2. Signer attestation ═══
CREATE TABLE fleet_custody_policy (
  id                 smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  attestation_ttl_s  integer     NOT NULL DEFAULT 900 CHECK (attestation_ttl_s BETWEEN 60 AND 86400),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         text        NOT NULL DEFAULT 'migration'
);
INSERT INTO fleet_custody_policy (id) VALUES (1);
COMMENT ON TABLE fleet_custody_policy IS 'Custody signer heartbeat window (technical liveness of the attested signer; never a money amount).';
CREATE TRIGGER fleet_custody_policy_no_delete BEFORE DELETE ON fleet_custody_policy FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_custody_policy_no_truncate BEFORE TRUNCATE ON fleet_custody_policy FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION fleet_admin_custody_policy_set(p_ttl_s integer, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_custody_policy;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');
  UPDATE fleet_custody_policy SET attestation_ttl_s = p_ttl_s, updated_at = now(), updated_by = p_actor WHERE id = 1 RETURNING * INTO r;
  PERFORM fleet_event('custody_policy_set', NULL, p_actor, to_jsonb(r) - 'id');
  RETURN to_jsonb(r) - 'id';
END $$;

CREATE TABLE fleet_custody_attestations (
  seq            bigserial   PRIMARY KEY,
  worker         text        NOT NULL CHECK (worker ~ '^[a-z0-9_.-]{1,64}$'),
  rail_id        uuid        NOT NULL REFERENCES fleet_payment_rails(rail_id),
  provider       text        NOT NULL,
  rail_mode      text        NOT NULL CHECK (rail_mode IN ('simulated','sandbox','live')),
  credential_id  uuid        NOT NULL REFERENCES fleet_credential_refs(credential_id),
  capability     text        NOT NULL CHECK (capability IN ('payouts','bank_transfer')),
  runtime_commit text,
  attested_at    timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  CHECK (expires_at > attested_at)
);
CREATE INDEX fleet_custody_attestations_rail ON fleet_custody_attestations (rail_id, expires_at DESC);
CREATE TRIGGER fleet_custody_attestations_no_change BEFORE UPDATE OR DELETE ON fleet_custody_attestations FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_custody_attestations_no_truncate BEFORE TRUNCATE ON fleet_custody_attestations FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- The custody executor attests one signer (rail + credential) it holds. Everything is checked against the registry.
CREATE FUNCTION cx_attest_signer(p_worker text, p_rail uuid, p_provider text, p_mode text, p_credential uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_payment_rails; c fleet_credential_refs; v_cap text; v_exp timestamptz;
BEGIN
  IF p_worker IS NULL OR p_worker !~ '^[a-z0-9_.-]{1,64}$' OR p_rail IS NULL OR p_credential IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  SELECT * INTO r FROM fleet_payment_rails WHERE rail_id = p_rail;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF r.status <> 'active' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_RAIL_NOT_ACTIVE'); END IF;
  IF r.provider IS DISTINCT FROM p_provider OR r.mode IS DISTINCT FROM p_mode OR r.credential_id IS DISTINCT FROM p_credential THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_SIGNER_MISMATCH');
  END IF;
  SELECT * INTO c FROM fleet_credential_refs WHERE credential_id = p_credential;
  IF NOT FOUND OR c.status NOT IN ('active','rotating') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CREDENTIAL_REFUSED'); END IF;
  IF c.provider IS DISTINCT FROM r.provider THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_SIGNER_MISMATCH'); END IF;
  v_cap := CASE WHEN 'payouts' = ANY(r.capabilities) AND 'payouts' = ANY(c.scope) THEN 'payouts'
                WHEN 'bank_transfer' = ANY(r.capabilities) AND 'bank_transfer' = ANY(c.scope) THEN 'bank_transfer' END;
  IF v_cap IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CREDENTIAL_SCOPE'); END IF;
  v_exp := now() + make_interval(secs => (SELECT attestation_ttl_s FROM fleet_custody_policy WHERE id = 1));
  INSERT INTO fleet_custody_attestations (worker, rail_id, provider, rail_mode, credential_id, capability, runtime_commit, expires_at)
    VALUES (p_worker, r.rail_id, r.provider, r.mode, c.credential_id, v_cap, (SELECT runtime_commit FROM fleet_state WHERE id = 1), v_exp);
  RETURN jsonb_build_object('ok', true, 'railId', r.rail_id, 'capability', v_cap, 'mode', r.mode, 'expiresAt', v_exp);
END $$;

-- Credential use by custody: only for a claimed instruction under its lease; refused (and audited) unless active.
CREATE FUNCTION cx_credential_use(p_instruction uuid, p_lease text, p_action text, p_outcome text, p_detail text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE i fleet_payment_instructions; c fleet_credential_refs; v_agent text; v_ok boolean;
BEGIN
  SELECT * INTO i FROM fleet_payment_instructions WHERE instruction_id = p_instruction;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF i.status <> 'claimed' OR p_lease IS NULL OR encode(sha256(convert_to(p_lease, 'UTF8')), 'hex') <> i.lease_sha256 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_LEASE_INVALID');
  END IF;
  IF p_action IS NULL OR p_action !~ '^[a-z_.]{3,40}$' OR p_outcome NOT IN ('ok','failed') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  SELECT * INTO c FROM fleet_credential_refs WHERE credential_id = i.credential_id;
  SELECT agent_id INTO v_agent FROM fleet_payment_orders WHERE order_id = i.order_id;
  v_ok := c.status IN ('active','rotating');
  INSERT INTO fleet_credential_use_log (credential_id, actor, action, agent_id, venture_id, outcome, detail)
    VALUES (c.credential_id, 'custody-executor', p_action, v_agent, i.venture_id, CASE WHEN v_ok THEN p_outcome ELSE 'refused' END,
            left(regexp_replace(COALESCE(p_detail, ''), '(Bearer|Basic)\\s+\\S+', '[redacted]', 'g'), 200));
  IF v_ok THEN UPDATE fleet_credential_refs SET last_used_at = now() WHERE credential_id = c.credential_id; END IF;
  RETURN jsonb_build_object('ok', v_ok AND p_outcome = 'ok', 'status', c.status);
END $$;

-- ═══ 3. Destination references for owner-enrolled destinations (vendors record theirs at registration) ═══
CREATE FUNCTION fleet_admin_destination_reference_set(p_destination text, p_reference text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE d fleet_payment_destinations;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');
  SELECT * INTO d FROM fleet_payment_destinations WHERE destination_id = p_destination;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such destination'; END IF;
  IF p_reference IS NULL OR length(p_reference) NOT BETWEEN 3 AND 200 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a reference is 3-200 characters'; END IF;
  -- Only the enrolled reference itself: its hash must equal the one recorded at enrolment (nothing can be re-targeted).
  IF encode(sha256(convert_to(p_reference, 'UTF8')), 'hex') <> d.reference_sha256
     AND encode(sha256(convert_to(lower(btrim(p_reference)), 'UTF8')), 'hex') <> d.reference_sha256 THEN
    RAISE EXCEPTION 'FLEET_REFERENCE_MISMATCH: the reference is not the one enrolled for this destination';
  END IF;
  IF EXISTS (SELECT 1 FROM fleet_destination_references WHERE destination_id = p_destination) THEN
    RETURN jsonb_build_object('ok', true, 'replay', true, 'destinationId', p_destination);
  END IF;
  INSERT INTO fleet_destination_references (destination_id, reference) VALUES (p_destination, p_reference);
  PERFORM fleet_event('destination_reference_recorded', NULL, p_actor, jsonb_build_object('destinationId', p_destination, 'kind', d.kind, 'rail', d.rail));
  RETURN jsonb_build_object('ok', true, 'destinationId', p_destination);
END $$;

-- ═══ 4. Bound instructions ═══
ALTER TABLE fleet_payment_instructions
  ADD COLUMN payment_rail_id uuid REFERENCES fleet_payment_rails(rail_id),
  ADD COLUMN provider        text,
  ADD COLUMN rail_mode       text CHECK (rail_mode IN ('simulated','sandbox','live')),
  ADD COLUMN credential_id   uuid REFERENCES fleet_credential_refs(credential_id),
  ADD COLUMN capability      text CHECK (capability IN ('payouts','bank_transfer')),
  ADD COLUMN venture_id      uuid REFERENCES fleet_ventures(venture_id);
${INSTRUCTIONS_GUARD}

CREATE OR REPLACE FUNCTION svc_issue_payment_instruction(p_order uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_payment_orders; d fleet_payment_destinations; w fleet_wallet_custody; ag fleet_agents; r fleet_payment_rails;
        v_id uuid := gen_random_uuid(); v_cap text; v_ref text; v_venture uuid; v_vprov text;
BEGIN
  IF NOT (SELECT custody_execution_enabled FROM fleet_economic_model WHERE id = 1) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CUSTODY_EXECUTION_DISABLED');
  END IF;
  SELECT * INTO o FROM fleet_payment_orders WHERE order_id = p_order FOR UPDATE;
  IF NOT FOUND OR o.status <> 'reserved' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE'); END IF;
  SELECT * INTO d FROM fleet_payment_destinations WHERE destination_id = o.destination_id;
  IF d.status <> 'active' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_DESTINATION_NOT_ACTIVE'); END IF;
  IF o.order_type = 'agent_spend' THEN
    -- Custody: only a controller-custody (keyless) agent's money is paid by the custody signer, and only while active.
    SELECT * INTO w FROM fleet_wallet_custody WHERE agent_id = o.agent_id;
    IF NOT FOUND OR w.custody_mode <> 'controller_keyless' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CUSTODY_AGENT_HELD_KEY'); END IF;
    IF w.spending_frozen THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_SPENDING_FROZEN'); END IF;
    SELECT * INTO ag FROM fleet_agents WHERE agent_id = o.agent_id;
    IF ag.status <> 'active' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_AGENT_NOT_ACTIVE'); END IF;
    IF ag.operator_hold_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_AGENT_HELD'); END IF;
  END IF;
  -- Destination/provider compatibility: payouts to a provider account, bank transfers; never crypto or credits.
  v_cap := CASE d.rail WHEN 'provider_account' THEN 'payouts' WHEN 'bank_transfer' THEN 'bank_transfer' END;
  IF v_cap IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_RAIL_UNSUPPORTED'); END IF;
  SELECT reference INTO v_ref FROM fleet_destination_references WHERE destination_id = d.destination_id;
  IF v_ref IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_DESTINATION_REFERENCE_MISSING'); END IF;
  SELECT venture_id, provider INTO v_venture, v_vprov FROM fleet_vendor_destinations WHERE destination_id = d.destination_id;
  IF o.funding = 'envelope' THEN SELECT COALESCE(e.venture_id, v_venture) INTO v_venture FROM fleet_envelopes e WHERE e.envelope_id = o.envelope_id; END IF;
  -- A live rail with a fresh signer attestation for this capability (a dedicated rail serves only its venture).
  SELECT x.* INTO r FROM fleet_payment_rails x
   WHERE x.status = 'active' AND x.mode = 'live' AND v_cap = ANY(x.capabilities)
     AND (v_vprov IS NULL OR x.provider = v_vprov)
     AND (x.rail_kind = 'shared' OR x.dedicated_venture_id IS NOT DISTINCT FROM v_venture)
     AND EXISTS (SELECT 1 FROM fleet_credential_refs c WHERE c.credential_id = x.credential_id AND c.status IN ('active','rotating'))
     AND EXISTS (SELECT 1 FROM fleet_custody_attestations a WHERE a.rail_id = x.rail_id AND a.capability = v_cap AND a.rail_mode = x.mode
                    AND a.credential_id = x.credential_id AND a.expires_at > now())
   ORDER BY (x.rail_kind = 'dedicated') DESC, x.rail_id LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NO_CUSTODY_SIGNER'); END IF;
  INSERT INTO fleet_payment_instructions (instruction_id, order_id, amount_cents, destination_id, rail, instruction_sha256, issued_by,
      payment_rail_id, provider, rail_mode, credential_id, capability, venture_id)
    VALUES (v_id, o.order_id, o.amount_cents, o.destination_id, d.rail,
      encode(sha256(convert_to(concat_ws('|', v_id, o.order_id, o.amount_cents, o.destination_id, d.rail, d.reference_sha256,
        r.rail_id, r.provider, r.mode, r.credential_id, v_cap, COALESCE(v_venture::text, '-')), 'UTF8')), 'hex'), 'controller',
      r.rail_id, r.provider, r.mode, r.credential_id, v_cap, v_venture);
  UPDATE fleet_payment_orders SET status = 'executing' WHERE order_id = o.order_id;
  PERFORM fleet_event('payment_instruction_issued', o.agent_id, 'controller', jsonb_build_object('orderId', o.order_id, 'instructionId', v_id,
    'railId', r.rail_id, 'capability', v_cap, 'ventureId', v_venture));
  RETURN jsonb_build_object('ok', true, 'instructionId', v_id, 'railId', r.rail_id, 'ventureId', v_venture);
END $$;

${CLAIM}

${REPORT}

-- ═══ 5. Custody status (doctor, Hub) ═══
CREATE FUNCTION fleet_custody_status() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'executionEnabled', (SELECT custody_execution_enabled FROM fleet_economic_model WHERE id = 1),
    'livingAgents', (SELECT count(*) FROM fleet_agents WHERE status IN ('active','unresponsive','provisioning','reserved')),
    'keylessAgents', (SELECT count(*) FROM fleet_wallet_custody w JOIN fleet_agents a USING (agent_id)
                       WHERE w.custody_mode = 'controller_keyless' AND a.status IN ('active','unresponsive','provisioning','reserved')),
    'agentHeldKeys', (SELECT count(*) FROM fleet_wallet_custody w JOIN fleet_agents a USING (agent_id)
                       WHERE w.custody_mode = 'agent_held_key' AND a.status IN ('active','unresponsive','provisioning','reserved')),
    'attestedRails', (SELECT count(DISTINCT a.rail_id) FROM fleet_custody_attestations a WHERE a.expires_at > now()),
    'liveSigners', (SELECT count(DISTINCT a.rail_id) FROM fleet_custody_attestations a JOIN fleet_payment_rails r ON r.rail_id = a.rail_id
                     JOIN fleet_credential_refs c ON c.credential_id = a.credential_id
                     WHERE a.expires_at > now() AND a.rail_mode = 'live' AND r.mode = 'live' AND r.status = 'active'
                       AND r.credential_id = a.credential_id AND c.status IN ('active','rotating')),
    'attestationTtlS', (SELECT attestation_ttl_s FROM fleet_custody_policy WHERE id = 1),
    'instructions', (SELECT jsonb_build_object('issued', count(*) FILTER (WHERE status = 'issued'), 'claimed', count(*) FILTER (WHERE status = 'claimed'),
                       'claimedStale', count(*) FILTER (WHERE status = 'claimed' AND claimed_at < now() - interval '1 hour'),
                       'settled', count(*) FILTER (WHERE status = 'settled'), 'failed', count(*) FILTER (WHERE status = 'failed'))
                     FROM fleet_payment_instructions))
$$;
`;

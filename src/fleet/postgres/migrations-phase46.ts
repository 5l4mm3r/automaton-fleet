/**
 * Schema v46 — truthful rail readiness, a receive-only rail mode and settlement guards (Gumroad revenue integration,
 * stage G1; design: docs/design/gumroad-revenue-integration.md §§5.6, 5.7, 6, 8, 10).
 *
 * Nothing here connects a provider, moves money or answers a dependency by itself. It corrects the lifecycle so that a
 * dependency can be answered only for a capability that has actually been evidenced:
 *
 * 1. READINESS IS EVIDENCED, PER CAPABILITY. A rail no longer starts `active`: a real (non-simulated) rail starts
 *    `pending_setup`, and `fleet_rail_match` matches a capability only when every readiness check that capability needs
 *    is verified and unexpired in fleet_rail_capability_checks (append-only evidence; the latest row per check counts).
 *    storefront / marketplace_listing need account_access + storefront_publication; receive_payments / subscriptions
 *    need account_access + sale_ingestion; payouts needs account_access + payout_reconciliation; refunds, card_spend and
 *    bank_transfer need account_access + a check of their own name. Publication needs no sale or payout (no deadlock).
 * 2. ANSWERS SAY WHAT IS TRUE. A dependency answered by a rail connection gets a generated text naming exactly the
 *    verified and the not-yet-verified readiness checks (never "connected" for an unproven capability), and a real
 *    rail whose holder identity is not verified leaves that part open as its own dependency. A legacy request with no
 *    rail requirement is answered only through fleet_admin_dependency_answer_from_capability, which refuses unless the
 *    capability is verified on a rail assigned to that agent's venture.
 * 3. RECEIVE-ONLY MODE. `live_receive` is a new rail mode, not a relaxation of the `mode <> 'live'` pin (kept as is):
 *    provider gumroad, capabilities within {storefront, receive_payments, marketplace_listing} — never payouts, refunds,
 *    card_spend or bank_transfer — so a custody signer cannot attest it and no payment instruction can select it. A
 *    rail's mode is now fixed. A gumroad credential reference is scoped within {edit_products, view_sales, view_payouts}.
 * 4. SIMULATION STAYS SIMULATION. fleet_economic_model.simulated_settlement_allowed (default false): simulated and
 *    sandbox rails can exist, match and settle only on a registry that allows simulated settlement (throwaway test
 *    registries). On any other registry no settlement posts to agent cash through svc_settlement_ingest at all (provider
 *    revenue is cash-basis and arrives only through the later provider-receipt path). It cannot be allowed while a
 *    live_receive rail exists.
 * 5. ONE CLAIM PER EXTERNAL SETTLEMENT. fleet_revenue_claims is the single namespace for external settlement keys;
 *    owner-recorded revenue can claim one (fleet_admin_record_external_claimed), and no manual revenue or owner funding
 *    may reuse a claimed key as its reference.
 *
 * Unchanged: REAL_PAYMENTS_ENABLED and the other host switches (no SQL reads them), custody_execution_enabled (pinned
 * false), payment-instruction rail selection (mode = 'live' only), the owner-request lifecycle (pending → one terminal
 * status). No journal, no event and no balance change at migration time.
 */
import { V10_SQL } from "./migrations-phase10.js";
import { V11_SQL } from "./migrations-phase11.js";
import { V29_SQL } from "./migrations-phase29.js";
import { V33_SQL } from "./migrations-phase33.js";
import { restate } from "./migrations-phase42.js";
import { V45_SQL } from "./migrations-phase45.js";

/** Readiness checks a rail capability needs (the order is the disclosure order). */
export const READINESS_CHECKS = ["account_access", "storefront_publication", "identity_verification", "sale_ingestion",
  "payout_reconciliation", "receipt_verification"] as const;
export const CAPABILITY_CHECKS = ["refunds", "card_spend", "bank_transfer"] as const;
export const CHECK_EVIDENCE_KINDS = ["simulated", "probe", "owner_attested", "first_use", "automatic"] as const;
export const LIVE_RECEIVE_CAPABILITIES = ["storefront", "receive_payments", "marketplace_listing"] as const;
export const GUMROAD_CREDENTIAL_SCOPES = ["edit_products", "view_sales", "view_payouts"] as const;

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

/** v46 event types and their Fleet Command routes (in addition to the v44 catalogue). Evidence and claims are permanent
 * history (audit only); turning simulated settlement on or off is surfaced (P1): on a real registry it must never be on. */
export const EVENT_ROUTES_V46 = Object.freeze({
  AUDIT_ONLY: ["payment_rail_check", "revenue_claimed"],
  P1_HIGH: ["simulated_settlement_policy"],
} as const);
const EVENT_ROUTE = restate(V45_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V46) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${ts.map((t) => `'${t}'`).join(",")}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
]);
const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;`;

const RAILS_GUARD = restate(V33_SQL, "fleet_payment_rails_guard", [
  ["OR NEW.dedicated_venture_id IS DISTINCT FROM OLD.dedicated_venture_id", "OR NEW.dedicated_venture_id IS DISTINCT FROM OLD.dedicated_venture_id OR NEW.mode <> OLD.mode"],
  ["a rail''s provider, kind, legal entity and dedication are fixed", "a rail''s provider, kind, mode, legal entity and dedication are fixed"],
]);

const RAIL_MATCH = restate(V33_SQL, "fleet_rail_match", [
  ["   WHERE r.status = 'active' AND p_capability = ANY (r.capabilities)",
   `   WHERE r.status = 'active' AND p_capability = ANY (r.capabilities)
     -- v46: only an evidenced capability matches; simulated rails only where simulation is allowed.
     AND fleet_rail_capability_ready(r.rail_id, p_capability)
     AND (r.mode NOT IN ('simulated','sandbox') OR fleet_simulated_settlement_allowed())`],
]);

const SETTLEMENT_INGEST = restate(V29_SQL, "svc_settlement_ingest", [
  ["  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_RAIL_UNKNOWN'); END IF;",
   `  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_RAIL_UNKNOWN'); END IF;
  -- v46: this path credits agent cash at once, so it serves simulated settlement only (test registries). Real provider
  -- revenue is cash-basis: it reaches agents only when received into the fleet treasury (provider-receipt path).
  IF r.mode NOT IN ('simulated','sandbox') OR NOT fleet_simulated_settlement_allowed() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_SETTLEMENT_SIMULATION_ONLY',
      'reason', 'direct settlement is for simulated rails on a test registry; provider revenue becomes agent cash only when received into the fleet treasury');
  END IF;`],
]);

const SETTLEMENT_POST = restate(V29_SQL, "fleet_settlement_post", [
  ["  SELECT * INTO v FROM fleet_ventures WHERE venture_id = p_venture;\n  v_ref := 'rail:'",
   `  IF NOT fleet_simulated_settlement_allowed() OR (SELECT mode FROM fleet_payment_rails WHERE rail_id = t.rail_id) NOT IN ('simulated','sandbox') THEN
    RAISE EXCEPTION 'FLEET_SETTLEMENT_SIMULATION_ONLY: direct settlement posts only simulated revenue on a test registry';
  END IF;
  SELECT * INTO v FROM fleet_ventures WHERE venture_id = p_venture;
  v_ref := 'rail:'`],
]);

const CLAIM_GUARD = `  IF fleet_claim_taken(p_external_ref) THEN
    RAISE EXCEPTION 'FLEET_ALREADY_CLAIMED: this external settlement is already recorded (claim %)', p_external_ref;
  END IF;`;
const RECORD_EXTERNAL = restate(V11_SQL, "fleet_admin_record_external", [
  ["  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: positive amount required'; END IF;",
   `  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: positive amount required'; END IF;\n${CLAIM_GUARD}`],
]);
const RECORD_FUNDING = restate(V10_SQL, "fleet_admin_record_owner_funding", [
  ["  v_j := fleet_ledger_post('owner_funding',", `${CLAIM_GUARD}\n  v_j := fleet_ledger_post('owner_funding',`],
]);

const RECONCILE = restate(V29_SQL, "fleet_reconcile", [
  ["  -- Treasury: the unallocated partition never negative (ledger CHECK) — reported for the overview.",
   `  -- v46: a registry that allows simulated settlement (test registries only) says so.
  IF fleet_simulated_settlement_allowed() THEN
    f := f || jsonb_build_array(jsonb_build_object('severity', 'INFO', 'code', 'SIMULATED_SETTLEMENT_ALLOWED', 'detail', jsonb_build_object(
      'simulatedRails', (SELECT count(*) FROM fleet_payment_rails WHERE mode IN ('simulated','sandbox') AND status <> 'revoked'))));
  END IF;
  -- v46: real rails waiting for evidence, and rails whose evidence has lapsed.
  SELECT count(*) INTO n FROM fleet_payment_rails WHERE status = 'pending_setup';
  IF n > 0 THEN f := f || jsonb_build_array(jsonb_build_object('severity', 'INFO', 'code', 'RAILS_PENDING_SETUP', 'detail', jsonb_build_object('rails', n))); END IF;
  -- Treasury: the unallocated partition never negative (ledger CHECK) — reported for the overview.`],
]);

export const V46_SQL = `
-- ═══ 1. Simulation stays simulation ═══
ALTER TABLE fleet_economic_model ADD COLUMN simulated_settlement_allowed boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN fleet_economic_model.simulated_settlement_allowed IS 'v46: true only on throwaway test registries. Simulated/sandbox rails exist, match and settle only while true; never true while a live_receive rail exists.';
CREATE FUNCTION fleet_simulated_settlement_allowed() RETURNS boolean LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE((SELECT simulated_settlement_allowed FROM fleet_economic_model WHERE id = 1), false)
$$;
CREATE FUNCTION fleet_admin_simulated_settlement_set(p_allowed boolean, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  ${OWNER_ACTOR}
  IF p_allowed IS NULL THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: allowed is true or false'; END IF;
  IF p_allowed AND EXISTS (SELECT 1 FROM fleet_payment_rails WHERE mode = 'live_receive' AND status <> 'revoked') THEN
    RAISE EXCEPTION 'FLEET_LIVE_RECEIVE_PRESENT: a registry with a receive-only provider rail cannot allow simulated settlement';
  END IF;
  UPDATE fleet_economic_model SET simulated_settlement_allowed = p_allowed WHERE id = 1;
  PERFORM fleet_event('simulated_settlement_policy', NULL, p_actor, jsonb_build_object('allowed', p_allowed));
  RETURN jsonb_build_object('simulatedSettlementAllowed', p_allowed);
END $$;

-- ═══ 2. Rails: receive-only mode, fixed mode, real rails start pending ═══
ALTER TABLE fleet_payment_rails DROP CONSTRAINT fleet_payment_rails_mode_check;
ALTER TABLE fleet_payment_rails ADD CONSTRAINT fleet_payment_rails_mode_check CHECK (mode IN ('simulated','sandbox','live','live_receive'));
-- Receive-only: one provider, receiving capabilities only. Kept apart from (and in addition to) the not-live pin.
ALTER TABLE fleet_payment_rails ADD CONSTRAINT fleet_payment_rails_live_receive_scope
  CHECK (mode <> 'live_receive' OR (provider = 'gumroad' AND capabilities <@ ARRAY[${q(LIVE_RECEIVE_CAPABILITIES)}]::text[]));
ALTER TABLE fleet_payment_rails ALTER COLUMN status SET DEFAULT 'pending_setup';
${RAILS_GUARD}
CREATE FUNCTION fleet_payment_rails_simulation_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF NEW.mode IN ('simulated','sandbox') AND NOT fleet_simulated_settlement_allowed() THEN
    RAISE EXCEPTION 'FLEET_SIMULATION_ONLY: simulated and sandbox rails exist only on a registry that allows simulated settlement';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_payment_rails_simulation_guard BEFORE INSERT ON fleet_payment_rails FOR EACH ROW EXECUTE FUNCTION fleet_payment_rails_simulation_guard();

-- A gumroad credential reference never carries more than the receive-only gateway needs.
ALTER TABLE fleet_credential_refs ADD CONSTRAINT fleet_credential_refs_gumroad_scope
  CHECK (provider <> 'gumroad' OR scope <@ ARRAY[${q(GUMROAD_CREDENTIAL_SCOPES)}]::text[]);

-- ═══ 3. Readiness evidence (append-only; the latest row per (rail, check) counts) ═══
CREATE TABLE fleet_rail_capability_checks (
  check_id      bigserial   PRIMARY KEY,
  rail_id       uuid        NOT NULL REFERENCES fleet_payment_rails(rail_id),
  check_name    text        NOT NULL CHECK (check_name IN (${q([...READINESS_CHECKS, ...CAPABILITY_CHECKS])})),
  status        text        NOT NULL CHECK (status IN ('verified','failed','expired')),
  evidence_kind text        NOT NULL CHECK (evidence_kind IN (${q(CHECK_EVIDENCE_KINDS)})),
  evidence      jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object' AND length(evidence::text) <= 2000),
  recorded_by   text        NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz CHECK (expires_at IS NULL OR expires_at > recorded_at)
);
CREATE INDEX fleet_rail_capability_checks_latest ON fleet_rail_capability_checks (rail_id, check_name, check_id DESC);
CREATE TRIGGER fleet_rail_capability_checks_no_change BEFORE UPDATE OR DELETE ON fleet_rail_capability_checks FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_rail_capability_checks_no_truncate BEFORE TRUNCATE ON fleet_rail_capability_checks FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION fleet_rail_required_checks(p_capability text) RETURNS text[] LANGUAGE sql IMMUTABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT CASE
    WHEN p_capability IN ('storefront','marketplace_listing') THEN ARRAY['account_access','storefront_publication']
    WHEN p_capability IN ('receive_payments','subscriptions') THEN ARRAY['account_access','sale_ingestion']
    WHEN p_capability = 'payouts' THEN ARRAY['account_access','payout_reconciliation']
    WHEN p_capability IN (${q(CAPABILITY_CHECKS)}) THEN ARRAY['account_access', p_capability]
    ELSE NULL END
$$;
CREATE FUNCTION fleet_rail_check_verified(p_rail uuid, p_check text) RETURNS boolean LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE((SELECT c.status = 'verified' AND (c.expires_at IS NULL OR c.expires_at > now())
                     FROM fleet_rail_capability_checks c WHERE c.rail_id = p_rail AND c.check_name = p_check ORDER BY c.check_id DESC LIMIT 1), false)
$$;
CREATE FUNCTION fleet_rail_capability_ready(p_rail uuid, p_capability text) RETURNS boolean LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT fleet_rail_required_checks(p_capability) IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM unnest(fleet_rail_required_checks(p_capability)) x(c) WHERE NOT fleet_rail_check_verified(p_rail, x.c))
$$;
CREATE FUNCTION fleet_rail_readiness(p_rail uuid) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'checks', COALESCE((SELECT jsonb_object_agg(x.c, jsonb_build_object('status', COALESCE(l.status, 'unverified'), 'verified', fleet_rail_check_verified(p_rail, x.c),
                 'evidenceKind', l.evidence_kind, 'recordedAt', l.recorded_at, 'expiresAt', l.expires_at))
               FROM unnest(ARRAY[${q([...READINESS_CHECKS, ...CAPABILITY_CHECKS])}]) x(c)
               LEFT JOIN LATERAL (SELECT * FROM fleet_rail_capability_checks k WHERE k.rail_id = p_rail AND k.check_name = x.c ORDER BY k.check_id DESC LIMIT 1) l ON true), '{}'::jsonb),
    'capabilitiesReady', COALESCE((SELECT jsonb_agg(c ORDER BY c) FROM fleet_payment_rails r, unnest(r.capabilities) c
                 WHERE r.rail_id = p_rail AND fleet_rail_capability_ready(p_rail, c)), '[]'::jsonb))
$$;

-- The disclosure a dependency answer carries: exactly what is verified, what is not, and that revenue is not spendable.
CREATE FUNCTION fleet_rail_readiness_text(p_rail uuid) RETURNS text LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_payment_rails; v_ok text; v_no text;
BEGIN
  SELECT * INTO r FROM fleet_payment_rails WHERE rail_id = p_rail;
  WITH l AS (
    SELECT x.c, x.o, x.label, (SELECT k.evidence_kind FROM fleet_rail_capability_checks k WHERE k.rail_id = p_rail AND k.check_name = x.c ORDER BY k.check_id DESC LIMIT 1) AS kind,
           fleet_rail_check_verified(p_rail, x.c) AS ok
      FROM (VALUES ('account_access', 1, 'account access'), ('storefront_publication', 2, 'storefront publication'),
                   ('identity_verification', 3, 'identity verification of the account holder'), ('sale_ingestion', 4, 'sale ingestion'),
                   ('payout_reconciliation', 5, 'payout reconciliation'), ('receipt_verification', 6, 'receipt into the fleet treasury')) x(c, o, label))
  SELECT string_agg(label || ' (' || replace(kind, '_', ' ') || ')', ', ' ORDER BY o) FILTER (WHERE ok),
         string_agg(label, ', ' ORDER BY o) FILTER (WHERE NOT ok) INTO v_ok, v_no FROM l;
  RETURN left(format('%s%s rail "%s". Verified: %s. Not yet verified: %s. Revenue is not spendable until it is received into the fleet treasury.',
    CASE WHEN r.mode IN ('simulated','sandbox') THEN 'Simulated (test registry) ' ELSE '' END, r.provider, r.label, COALESCE(v_ok, 'nothing'), COALESCE(v_no, 'nothing')), 2000);
END $$;

-- ═══ 4. Requirements: assignment and truthful answers ═══
-- A real rail whose holder identity is not verified keeps that part open: its own dependency, per agent, once.
CREATE FUNCTION fleet_rail_identity_dependency(p_agent text, r fleet_payment_rails, p_actor text) RETURNS uuid LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_dep uuid; v_key text := 'capability:' || r.rail_id || ':identity_verification';
BEGIN
  IF r.mode <> 'live_receive' OR fleet_rail_check_verified(r.rail_id, 'identity_verification') THEN RETURN NULL; END IF;
  SELECT request_id INTO v_dep FROM fleet_owner_requests WHERE agent_id = p_agent AND idempotency_key = v_key;
  IF FOUND THEN RETURN v_dep; END IF;
  IF (SELECT count(*) FROM fleet_owner_requests WHERE agent_id = p_agent AND status = 'pending') >= 5 THEN RETURN NULL; END IF;
  v_dep := gen_random_uuid();
  INSERT INTO fleet_owner_requests (request_id, agent_id, idempotency_key, kind, action, title, detail, blocks_action)
    VALUES (v_dep, p_agent, v_key, 'kyc',
            left(format('Receive %s payouts: identity verification of the account holder', r.provider), 200),
            left(format('Identity verification required: %s payouts', r.provider), 200),
            'The account can publish, but the account holder''s identity has not been verified for payouts. Only receiving payouts waits on it; '
            || 'publishing and other work do not.', true);
  PERFORM fleet_event('external_dependency_recorded', p_agent, p_actor, jsonb_build_object('requestId', v_dep, 'kind', 'kyc', 'source', 'identity_verification', 'railId', r.rail_id));
  RETURN v_dep;
END $$;

CREATE FUNCTION fleet_rail_requirement_assign(q fleet_rail_requirements, r fleet_payment_rails, p_assignment uuid, p_actor text) RETURNS fleet_rail_requirements LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE out fleet_rail_requirements;
BEGIN
  UPDATE fleet_rail_requirements SET status = 'assigned', assignment_id = p_assignment, resolved_at = now() WHERE requirement_id = q.requirement_id RETURNING * INTO out;
  -- A dependency recorded earlier for this action is answered with exactly what the rail has evidenced.
  IF q.dependency_id IS NOT NULL THEN
    UPDATE fleet_owner_requests SET status = 'answered', decided_by = p_actor, decided_at = now(), response = fleet_rail_readiness_text(r.rail_id)
     WHERE request_id = q.dependency_id AND status = 'pending';
  END IF;
  PERFORM fleet_rail_identity_dependency(q.agent_id, r, p_actor);
  PERFORM fleet_event('payment_rail_assigned', q.agent_id, p_actor, jsonb_build_object('ventureId', q.venture_id, 'railId', r.rail_id, 'capability', q.capability,
    'kind', r.rail_kind));
  RETURN out;
END $$;

CREATE OR REPLACE FUNCTION fleet_rail_resolve(q fleet_rail_requirements, p_actor text) RETURNS fleet_rail_requirements LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_payment_rails; v_assign uuid; out fleet_rail_requirements; v_dep uuid; v_vkey text;
BEGIN
  IF q.status NOT IN ('open','dependency') THEN RETURN q; END IF;
  r := fleet_rail_match(q.venture_id, q.capability, q.preference, q.provider);
  IF r.rail_id IS NOT NULL THEN
    SELECT assignment_id INTO v_assign FROM fleet_rail_assignments WHERE venture_id = q.venture_id AND capability = q.capability AND released_at IS NULL;
    IF v_assign IS NULL THEN
      v_assign := gen_random_uuid();
      INSERT INTO fleet_rail_assignments (assignment_id, rail_id, venture_id, capability, assigned_by) VALUES (v_assign, r.rail_id, q.venture_id, q.capability, p_actor);
    END IF;
    RETURN fleet_rail_requirement_assign(q, r, v_assign, p_actor);
  END IF;
  IF q.provider IS NOT NULL AND q.dependency_id IS NULL
     AND (SELECT count(*) FROM fleet_owner_requests WHERE agent_id = q.agent_id AND status = 'pending') < 5 THEN
    SELECT venture_key INTO v_vkey FROM fleet_ventures WHERE venture_id = q.venture_id;
    v_dep := gen_random_uuid();
    INSERT INTO fleet_owner_requests (request_id, agent_id, idempotency_key, kind, action, title, detail, blocks_action)
      VALUES (v_dep, q.agent_id, 'rail:' || q.requirement_id, 'kyc',
              left(format('Open a %s account (%s) for venture %s', q.provider, q.capability, v_vkey), 200),
              left(format('Payment rail required: %s / %s', q.provider, q.capability), 200),
              'No compatible Fleet rail exists for this provider. A new external account needs a human identity/KYC. Only this action waits: '
              || 'the venture may use another Fleet rail, a direct storefront or another provider.', true);
    UPDATE fleet_rail_requirements SET status = 'dependency', dependency_id = v_dep WHERE requirement_id = q.requirement_id RETURNING * INTO out;
    PERFORM fleet_event('external_dependency_recorded', q.agent_id, p_actor, jsonb_build_object('requestId', v_dep, 'kind', 'kyc', 'source', 'payment_rail_required'));
    RETURN out;
  END IF;
  RETURN q;
END $$;

${RAIL_MATCH}

CREATE FUNCTION fleet_rail_resolve_waiting(p_actor text) RETURNS integer LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE q fleet_rail_requirements; n integer := 0;
BEGIN
  FOR q IN SELECT * FROM fleet_rail_requirements WHERE status IN ('open','dependency') ORDER BY created_at FOR UPDATE LOOP
    IF (fleet_rail_resolve(q, p_actor)).status = 'assigned' THEN n := n + 1; END IF;
  END LOOP;
  RETURN n;
END $$;

-- Owner registration. A simulated/sandbox rail (test registries only) is active with simulated evidence; a real rail
-- starts pending_setup and answers nothing until its capabilities are evidenced.
CREATE OR REPLACE FUNCTION fleet_admin_rail_add(p_provider text, p_label text, p_kind text, p_entity uuid, p_capabilities text[], p_account_ref text,
  p_credential uuid, p_mode text, p_dedicated_venture uuid, p_max_ventures integer, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_payment_rails; n integer := 0; v_mode text := COALESCE(p_mode, 'simulated'); c text;
BEGIN
  ${OWNER_ACTOR}
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');
  INSERT INTO fleet_payment_rails (rail_id, provider, label, rail_kind, legal_entity_id, capabilities, account_ref, credential_id, mode, status, dedicated_venture_id, max_ventures, created_by)
    VALUES (gen_random_uuid(), p_provider, fleet_scrub(p_label), p_kind, COALESCE(p_entity, (SELECT entity_id FROM fleet_legal_entities WHERE is_default)),
            p_capabilities, p_account_ref, p_credential, v_mode, CASE WHEN v_mode IN ('simulated','sandbox') THEN 'active' ELSE 'pending_setup' END,
            p_dedicated_venture, p_max_ventures, p_actor)
    RETURNING * INTO r;
  IF r.mode IN ('simulated','sandbox') THEN
    FOR c IN SELECT DISTINCT x FROM unnest(r.capabilities) cap, unnest(fleet_rail_required_checks(cap)) x LOOP
      INSERT INTO fleet_rail_capability_checks (rail_id, check_name, status, evidence_kind, evidence, recorded_by)
        VALUES (r.rail_id, c, 'verified', 'simulated', jsonb_build_object('note', 'simulated rail on a test registry'), p_actor);
    END LOOP;
  END IF;
  PERFORM fleet_event('payment_rail_added', NULL, p_actor, fleet_rail_json(r));
  IF r.status = 'active' THEN n := fleet_rail_resolve_waiting(p_actor); END IF;
  RETURN fleet_rail_json(r) || jsonb_build_object('requirementsAssigned', n, 'readiness', fleet_rail_readiness(r.rail_id));
END $$;

-- Owner evidence for one readiness check (verified / failed / expired). Never 'simulated' for a real rail.
CREATE FUNCTION fleet_admin_rail_verify(p_rail uuid, p_check text, p_status text, p_evidence_kind text, p_evidence jsonb, p_expires_at timestamptz, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_payment_rails; n integer := 0;
BEGIN
  ${OWNER_ACTOR}
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');
  SELECT * INTO r FROM fleet_payment_rails WHERE rail_id = p_rail FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such rail'; END IF;
  IF r.status = 'revoked' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: the rail is revoked'; END IF;
  IF p_evidence_kind = 'simulated' AND r.mode NOT IN ('simulated','sandbox') THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: simulated evidence is for simulated rails only';
  END IF;
  IF p_check NOT IN (SELECT DISTINCT x FROM unnest(r.capabilities) cap, unnest(fleet_rail_required_checks(cap)) x)
     AND p_check NOT IN ('identity_verification','receipt_verification') THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: % is not a readiness check of this rail''s capabilities', p_check;
  END IF;
  INSERT INTO fleet_rail_capability_checks (rail_id, check_name, status, evidence_kind, evidence, recorded_by, expires_at)
    VALUES (p_rail, p_check, p_status, p_evidence_kind, COALESCE(p_evidence, '{}'::jsonb), p_actor, p_expires_at);
  PERFORM fleet_event('payment_rail_check', NULL, p_actor, jsonb_build_object('railId', p_rail, 'check', p_check, 'status', p_status, 'evidenceKind', p_evidence_kind));
  IF r.status = 'active' AND p_status = 'verified' THEN n := fleet_rail_resolve_waiting(p_actor); END IF;
  RETURN fleet_rail_json(r) || jsonb_build_object('requirementsAssigned', n, 'readiness', fleet_rail_readiness(p_rail));
END $$;

-- Status: pending_setup → active only once a capability is evidenced; activation matches waiting requirements.
CREATE OR REPLACE FUNCTION fleet_admin_rail_set_status(p_rail uuid, p_status text, p_note text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_payment_rails; v_was text; n integer := 0;
BEGIN
  ${OWNER_ACTOR}
  IF p_status NOT IN ('active','degraded','suspended','revoked') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: status is active, degraded, suspended or revoked'; END IF;
  SELECT status INTO v_was FROM fleet_payment_rails WHERE rail_id = p_rail FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such rail'; END IF;
  IF p_status = 'active' AND NOT EXISTS (SELECT 1 FROM fleet_payment_rails x, unnest(x.capabilities) c WHERE x.rail_id = p_rail AND fleet_rail_capability_ready(p_rail, c)) THEN
    RAISE EXCEPTION 'FLEET_RAIL_NOT_READY: no capability of this rail is evidenced yet (fleet:admin economy-rail-verify)';
  END IF;
  UPDATE fleet_payment_rails SET status = p_status, health_note = left(fleet_scrub(p_note), 200), last_health_at = now(),
         revoked_at = CASE WHEN p_status = 'revoked' THEN now() END
   WHERE rail_id = p_rail RETURNING * INTO r;
  IF p_status = 'revoked' THEN
    UPDATE fleet_rail_assignments SET released_at = now(), release_note = 'rail revoked' WHERE rail_id = p_rail AND released_at IS NULL;
  END IF;
  PERFORM fleet_event('payment_rail_status', NULL, p_actor, jsonb_build_object('railId', p_rail, 'status', p_status, 'from', v_was));
  IF p_status = 'active' THEN n := fleet_rail_resolve_waiting(p_actor); END IF;
  RETURN fleet_rail_json(r) || jsonb_build_object('requirementsAssigned', n);
END $$;

-- Owner assignment of an evidenced capability to a venture (e.g. a venture that never filed a requirement).
CREATE FUNCTION fleet_admin_rail_assign(p_rail uuid, p_venture uuid, p_capability text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_payment_rails; v fleet_ventures; v_assign uuid; v_existing fleet_rail_assignments; q fleet_rail_requirements; n integer := 0;
BEGIN
  ${OWNER_ACTOR}
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');
  SELECT * INTO r FROM fleet_payment_rails WHERE rail_id = p_rail FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such rail'; END IF;
  SELECT * INTO v FROM fleet_ventures WHERE venture_id = p_venture;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such venture'; END IF;
  IF v.state = 'closed' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: the venture is closed'; END IF;
  IF r.status <> 'active' THEN RAISE EXCEPTION 'FLEET_RAIL_NOT_READY: the rail is %', r.status; END IF;
  IF NOT (p_capability = ANY (r.capabilities)) THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the rail does not offer %', p_capability; END IF;
  IF NOT fleet_rail_capability_ready(p_rail, p_capability) THEN RAISE EXCEPTION 'FLEET_RAIL_NOT_READY: % is not evidenced on this rail', p_capability; END IF;
  IF r.mode IN ('simulated','sandbox') AND NOT fleet_simulated_settlement_allowed() THEN RAISE EXCEPTION 'FLEET_SIMULATION_ONLY: simulated rail on a registry without simulation'; END IF;
  IF r.rail_kind = 'dedicated' AND r.dedicated_venture_id <> p_venture THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the rail is dedicated to another venture'; END IF;
  SELECT * INTO v_existing FROM fleet_rail_assignments WHERE venture_id = p_venture AND capability = p_capability AND released_at IS NULL;
  IF FOUND THEN
    IF v_existing.rail_id <> p_rail THEN RAISE EXCEPTION 'FLEET_ALREADY_ASSIGNED: the venture has % on another rail', p_capability; END IF;
    v_assign := v_existing.assignment_id;
  ELSE
    IF r.rail_kind = 'shared' AND r.max_ventures IS NOT NULL
       AND (SELECT count(DISTINCT a.venture_id) FROM fleet_rail_assignments a WHERE a.rail_id = p_rail AND a.released_at IS NULL) >= r.max_ventures THEN
      RAISE EXCEPTION 'FLEET_LIMIT_REACHED: the rail serves its maximum number of ventures';
    END IF;
    v_assign := gen_random_uuid();
    INSERT INTO fleet_rail_assignments (assignment_id, rail_id, venture_id, capability, assigned_by) VALUES (v_assign, p_rail, p_venture, p_capability, p_actor);
    PERFORM fleet_event('payment_rail_assigned', v.agent_id, p_actor, jsonb_build_object('ventureId', p_venture, 'railId', p_rail, 'capability', p_capability,
      'kind', r.rail_kind, 'by', 'owner'));
  END IF;
  FOR q IN SELECT * FROM fleet_rail_requirements WHERE venture_id = p_venture AND capability = p_capability AND status IN ('open','dependency') FOR UPDATE LOOP
    PERFORM fleet_rail_requirement_assign(q, r, v_assign, p_actor);
    n := n + 1;
  END LOOP;
  RETURN jsonb_build_object('assignmentId', v_assign, 'railId', p_rail, 'ventureId', p_venture, 'capability', p_capability, 'requirementsAssigned', n);
END $$;

-- A legacy request (no rail requirement) answered from evidence, never from typed text: the capability must be verified
-- on a rail assigned to one of the request's agent's ventures; the answer is the generated disclosure.
CREATE FUNCTION fleet_admin_dependency_answer_from_capability(p_request uuid, p_rail uuid, p_capability text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_owner_requests; r fleet_payment_rails; v_venture uuid; v_dep uuid;
BEGIN
  ${OWNER_ACTOR}
  SELECT * INTO o FROM fleet_owner_requests WHERE request_id = p_request FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such request'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), o.agent_id);
  IF o.status <> 'pending' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: the request is %', o.status; END IF;
  SELECT * INTO r FROM fleet_payment_rails WHERE rail_id = p_rail;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such rail'; END IF;
  IF r.status <> 'active' OR NOT fleet_rail_capability_ready(p_rail, p_capability) THEN
    RAISE EXCEPTION 'FLEET_RAIL_NOT_READY: % is not evidenced on this rail', p_capability;
  END IF;
  SELECT a.venture_id INTO v_venture FROM fleet_rail_assignments a JOIN fleet_ventures v ON v.venture_id = a.venture_id
   WHERE a.rail_id = p_rail AND a.capability = p_capability AND a.released_at IS NULL AND v.agent_id = o.agent_id ORDER BY a.assigned_at LIMIT 1;
  IF v_venture IS NULL THEN
    RAISE EXCEPTION 'FLEET_NOT_ASSIGNED: % on this rail is not assigned to any venture of the request''s agent (fleet:admin economy-rail-assign)', p_capability;
  END IF;
  UPDATE fleet_owner_requests SET status = 'answered', response = fleet_rail_readiness_text(p_rail), decided_by = p_actor, decided_at = now()
   WHERE request_id = p_request RETURNING * INTO o;
  PERFORM fleet_event('owner_request_decided', o.agent_id, p_actor, jsonb_build_object('requestId', p_request, 'decision', 'answered', 'basis', 'capability',
    'railId', p_rail, 'capability', p_capability, 'ventureId', v_venture));
  v_dep := fleet_rail_identity_dependency(o.agent_id, r, p_actor);
  RETURN fleet_owner_request_json(o) || jsonb_build_object('agentId', o.agent_id, 'identityDependency', v_dep);
END $$;

-- ═══ 5. Settlement: simulated only on the direct path ═══
${SETTLEMENT_INGEST}

${SETTLEMENT_POST}

-- ═══ 6. One claim per external settlement ═══
CREATE TABLE fleet_revenue_claims (
  claim_key  text        PRIMARY KEY CHECK (claim_key ~ '^[a-z][a-z0-9_]{1,20}:[A-Za-z0-9._:@/-]{3,200}$'),
  claim_kind text        NOT NULL CHECK (claim_kind IN ('manual_revenue','provider_payout','bank_receipt','owner_attestation','receipt_transfer')),
  journal_id uuid        NOT NULL REFERENCES fleet_ledger_journal(journal_id),
  claimed_by text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_revenue_claims_no_change BEFORE UPDATE OR DELETE ON fleet_revenue_claims FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_revenue_claims_no_truncate BEFORE TRUNCATE ON fleet_revenue_claims FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
CREATE FUNCTION fleet_claim_taken(p_key text) RETURNS boolean LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT p_key IS NOT NULL AND EXISTS (SELECT 1 FROM fleet_revenue_claims WHERE claim_key = p_key)
$$;

${RECORD_EXTERNAL}

${RECORD_FUNDING}

-- Owner-recorded revenue that claims an external settlement key (a provider payout, a bank receipt): recorded once.
CREATE FUNCTION fleet_admin_record_external_claimed(p_kind text, p_agent text, p_amount bigint, p_external_ref text, p_counterparty_sha256 text,
  p_actor text, p_idem text, p_claim_key text) RETURNS uuid LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_j uuid;
BEGIN
  ${OWNER_ACTOR}
  IF p_kind <> 'external_revenue' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: only external revenue claims a settlement key'; END IF;
  IF p_claim_key IS NULL OR p_claim_key !~ '^[a-z][a-z0-9_]{1,20}:[A-Za-z0-9._:@/-]{3,200}$' THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: a claim key is <namespace>:<reference> (e.g. gumroad:<account>:payout:<id>)';
  END IF;
  IF fleet_claim_taken(p_claim_key) THEN RAISE EXCEPTION 'FLEET_ALREADY_CLAIMED: this external settlement is already recorded (claim %)', p_claim_key; END IF;
  v_j := fleet_admin_record_external(p_kind, p_agent, p_amount, p_external_ref, p_counterparty_sha256, p_actor, p_idem);
  INSERT INTO fleet_revenue_claims (claim_key, claim_kind, journal_id, claimed_by) VALUES (p_claim_key, 'manual_revenue', v_j, p_actor);
  PERFORM fleet_event('revenue_claimed', p_agent, p_actor, jsonb_build_object('claimKey', p_claim_key, 'journalId', v_j, 'kind', 'manual_revenue'));
  RETURN v_j;
END $$;

-- ═══ 7. Fleet Command routes for the v46 event types ═══
${EVENT_ROUTE}

-- ═══ 7. Reconciliation ═══
${RECONCILE}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

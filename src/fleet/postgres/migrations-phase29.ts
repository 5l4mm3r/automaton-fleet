/**
 * Schema v29 — F2 money core: legal entities and tax, payment rails, vendor destinations, credential references,
 * settlement, the agent wallet, safe transfers and reconciliation.
 *
 * FleetController is the Fleet's bank: it holds custody, attributes every external transaction exactly
 * (EXTERNAL TRANSACTION → VENTURE → AGENT → WALLET → RETAINED / TAX / TREASURY) and protects restricted money. It does not
 * decide what the agent sells, which vendor it buys from or how it spends its own capital.
 *
 * 1. LEGAL ENTITIES + VERSIONED TAX PROFILES. Tax belongs to the legal entity/account holder, never to the AI agent. A
 *    profile is a list of rules ({taxKind, rateBp, inclusive}); rates are versioned policy data, never constants. A
 *    venture belongs to an entity (default entity when unset). Without an active profile a conservative configurable
 *    fallback reserve applies and doctor WARNs.
 * 2. LEDGER: new classes `agent_tax_reserve` (restricted: never spendable — spend orders draw only on agent_cash),
 *    `agent_tax_expense`, `agent_envelope_cash` (Fleet capital under an execution envelope, v30) and
 *    `fleet_operating_pool`; new kinds for venture sales (gross / processor fee / net in one journal), tax reservation /
 *    release / payment, envelope allocation / return / spend reservation / release, and operating transfers.
 * 3. PAYMENT RAILS (Fleet-owned): shared or dedicated, per legal entity, with capabilities, a MASKED account reference
 *    (never a full card or account number: a CHECK refuses long digit runs), a credential REFERENCE (never a secret)
 *    and a mode. `mode = 'live'` is constitutionally impossible in this schema (CHECK, like custody execution).
 *    PAYMENT_RAIL_REQUIRED: a venture's requirement is matched to a compatible rail automatically; when none exists and
 *    a provider was named, ONE action-scoped dependency (kind kyc) is recorded — the venture is not frozen.
 * 4. VENDOR DESTINATIONS: an agent registers a legitimate business destination itself (supplier, manufacturer,
 *    advertising, hosting, …). FleetController verifies it automatically (format, rail, prohibited categories,
 *    fleet-controlled references) and activates it as a payee scoped to that agent — no owner enrolment, no cooldown.
 *    The custody hard check (v10, unchanged) applies as before. A relative circuit-breaker signal for destination
 *    novelty is added (unset by default).
 * 5. CREDENTIAL REFERENCES + USE LOG: vault references, scope, status, health, rotation and revocation; every broker use
 *    is audited. Agents never receive a secret; a reference is never a secret (CHECK).
 * 6. SETTLEMENT: `svc_settlement_ingest` (FleetController's rail adapter) records an external transaction idempotently
 *    per (rail, external id, kind). A transaction on a rail assigned to a venture is settled: sale journal, venture
 *    attribution, revenue provenance and the tax reservation, atomically. Anything else is UNATTRIBUTED (orphan money,
 *    visible to reconciliation) — never guessed. Duplicates never duplicate money.
 * 7. WALLET (`fleet_agent_wallet`): cash held, economic balance, available, committed, restricted, tax reserve, venture
 *    allocations, revenue, refunds, inference, operating costs, pending settlement, retained earnings, Treasury
 *    contributions, runway figures and the SAFE TRANSFERABLE amount. Read-only figures.
 * 8. SAFE TRANSFER: `fleet_safe_transfer_amount` (cushion and horizon are configurable policy) and the owner's
 *    `fleet_admin_wallet_transfer` (to the Treasury or the Fleet operating pool), refused above the safe amount.
 * 9. RECONCILIATION (`fleet_reconcile`): ledger verification, orphan and stale settlements, attribution sums, tax
 *    reserve consistency and rail/credential health, as INFO/WARN/FAIL findings.
 */

const VENDOR_CATEGORIES = "'supplier','manufacturer','marketplace_fee','advertising','software_subscription','hosting','fulfilment','freelancer','professional_service','other'";

export const V29_SQL = `
-- ═══ 1. Legal entities and versioned tax profiles ═══
CREATE TABLE fleet_legal_entities (
  entity_id     uuid        PRIMARY KEY,
  name          text        NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  jurisdiction  text        NOT NULL CHECK (jurisdiction ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$'),
  entity_kind   text        NOT NULL CHECK (entity_kind IN ('company','sole_trader','partnership','other')),
  status        text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  is_default    boolean     NOT NULL DEFAULT false,
  created_by    text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX fleet_legal_entities_default_uq ON fleet_legal_entities (is_default) WHERE is_default;
CREATE TRIGGER fleet_legal_entities_no_delete BEFORE DELETE ON fleet_legal_entities FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_legal_entities_no_truncate BEFORE TRUNCATE ON fleet_legal_entities FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_tax_profiles (
  profile_id     uuid        PRIMARY KEY,
  entity_id      uuid        NOT NULL REFERENCES fleet_legal_entities(entity_id),
  version        integer     NOT NULL CHECK (version >= 1),
  effective_from timestamptz NOT NULL,
  rules          jsonb       NOT NULL CHECK (jsonb_typeof(rules) = 'array' AND jsonb_array_length(rules) <= 8),
  note           text        CHECK (length(note) <= 300),
  created_by     text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_id, version)
);
CREATE TRIGGER fleet_tax_profiles_no_change BEFORE UPDATE OR DELETE ON fleet_tax_profiles FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_tax_profiles_no_truncate BEFORE TRUNCATE ON fleet_tax_profiles FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_tax_policy (
  id                    smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  unprofiled_reserve_bp integer     NOT NULL DEFAULT 2500 CHECK (unprofiled_reserve_bp BETWEEN 0 AND 10000),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            text        NOT NULL DEFAULT 'migration'
);
INSERT INTO fleet_tax_policy (id) VALUES (1);
COMMENT ON COLUMN fleet_tax_policy.unprofiled_reserve_bp IS 'Conservative reserve (bp of a sale net of processor fees) while a legal entity has no active tax profile. Configurable policy, not a tax rate; doctor WARNs while it applies.';
CREATE TRIGGER fleet_tax_policy_no_delete BEFORE DELETE ON fleet_tax_policy FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_tax_policy_no_truncate BEFORE TRUNCATE ON fleet_tax_policy FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

ALTER TABLE fleet_ventures ADD COLUMN legal_entity_id uuid REFERENCES fleet_legal_entities(entity_id);
CREATE OR REPLACE FUNCTION fleet_ventures_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.venture_id <> OLD.venture_id OR NEW.agent_id <> OLD.agent_id OR NEW.venture_key <> OLD.venture_key OR NEW.created_at <> OLD.created_at
     OR NEW.parent_venture_id IS DISTINCT FROM OLD.parent_venture_id OR NEW.opportunity_id IS DISTINCT FROM OLD.opportunity_id
     OR (OLD.legal_entity_id IS NOT NULL AND NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id) THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a venture''s identity, lineage and legal entity are fixed';
  END IF;
  IF OLD.state = 'closed' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: a closed venture is final'; END IF;
  IF NEW.state <> OLD.state AND COALESCE(current_setting('fleet.venture_move', true), '') <> NEW.venture_id::text THEN
    RAISE EXCEPTION 'FLEET_VENTURE_TRANSITION: a venture changes state only through its state machine';
  END IF;
  RETURN NEW;
END $$;

-- The entity a venture's tax belongs to (its own, else the default entity).
CREATE FUNCTION fleet_venture_entity(p_venture uuid) RETURNS uuid LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE((SELECT legal_entity_id FROM fleet_ventures WHERE venture_id = p_venture),
                  (SELECT entity_id FROM fleet_legal_entities WHERE is_default AND status = 'active'))
$$;

CREATE FUNCTION fleet_tax_profile_active(p_entity uuid) RETURNS fleet_tax_profiles LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT * FROM fleet_tax_profiles WHERE entity_id = p_entity AND effective_from <= now() ORDER BY effective_from DESC, version DESC LIMIT 1
$$;

-- Conservative integer arithmetic: reserves round UP (ceil), never down; no floating point.
CREATE FUNCTION fleet_ceil_bp(p_amount bigint, p_bp integer) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_amount <= 0 OR p_bp <= 0 THEN 0 ELSE (p_amount * p_bp + 9999) / 10000 END
$$;

-- Tax on one sale (gross, processor fee) under the entity's active profile:
--   vat / sales_tax on the gross (inclusive: rate/(1+rate) of the gross; exclusive: rate of the gross);
--   profit / other on the sale's margin (gross − fee − vat − sales tax). Without a profile: the fallback reserve.
CREATE FUNCTION fleet_tax_for_sale(p_entity uuid, p_gross bigint, p_fee bigint) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE pr fleet_tax_profiles; r jsonb; v_rate integer; v_vat bigint := 0; v_sales bigint := 0; v_profit bigint := 0; v_other bigint := 0; v_base bigint;
BEGIN
  pr := fleet_tax_profile_active(p_entity);
  IF pr.profile_id IS NULL THEN
    v_other := fleet_ceil_bp(GREATEST(p_gross - p_fee, 0), (SELECT unprofiled_reserve_bp FROM fleet_tax_policy WHERE id = 1));
    RETURN jsonb_build_object('profileId', NULL, 'fallback', true, 'vatMinor', 0, 'salesTaxMinor', 0, 'profitTaxMinor', 0, 'otherMinor', v_other, 'totalMinor', v_other);
  END IF;
  FOR r IN SELECT x FROM jsonb_array_elements(pr.rules) x LOOP
    v_rate := (r ->> 'rateBp')::integer;
    IF r ->> 'taxKind' IN ('vat','sales_tax') THEN
      IF COALESCE((r ->> 'inclusive')::boolean, r ->> 'taxKind' = 'vat') THEN
        v_base := CASE WHEN v_rate <= 0 THEN 0 ELSE (p_gross * v_rate + (10000 + v_rate) - 1) / (10000 + v_rate) END;
      ELSE
        v_base := fleet_ceil_bp(p_gross, v_rate);
      END IF;
      IF r ->> 'taxKind' = 'vat' THEN v_vat := v_vat + v_base; ELSE v_sales := v_sales + v_base; END IF;
    END IF;
  END LOOP;
  FOR r IN SELECT x FROM jsonb_array_elements(pr.rules) x LOOP
    v_rate := (r ->> 'rateBp')::integer;
    IF r ->> 'taxKind' = 'profit' THEN v_profit := v_profit + fleet_ceil_bp(GREATEST(p_gross - p_fee - v_vat - v_sales, 0), v_rate);
    ELSIF r ->> 'taxKind' = 'other' THEN v_other := v_other + fleet_ceil_bp(GREATEST(p_gross - p_fee - v_vat - v_sales, 0), v_rate);
    END IF;
  END LOOP;
  RETURN jsonb_build_object('profileId', pr.profile_id, 'profileVersion', pr.version, 'fallback', false, 'vatMinor', v_vat, 'salesTaxMinor', v_sales,
    'profitTaxMinor', v_profit, 'otherMinor', v_other, 'totalMinor', LEAST(p_gross, v_vat + v_sales + v_profit + v_other));
END $$;

CREATE FUNCTION fleet_admin_legal_entity_add(p_name text, p_jurisdiction text, p_kind text, p_default boolean, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE e fleet_legal_entities;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  IF COALESCE(p_default, false) THEN UPDATE fleet_legal_entities SET is_default = false WHERE is_default; END IF;
  INSERT INTO fleet_legal_entities (entity_id, name, jurisdiction, entity_kind, is_default, created_by)
    VALUES (gen_random_uuid(), fleet_scrub(p_name), upper(p_jurisdiction), p_kind, COALESCE(p_default, false), p_actor) RETURNING * INTO e;
  PERFORM fleet_event('legal_entity_added', NULL, p_actor, jsonb_build_object('entityId', e.entity_id, 'jurisdiction', e.jurisdiction, 'default', e.is_default));
  RETURN to_jsonb(e);
END $$;
-- Only is_default and status may change on an entity.
CREATE FUNCTION fleet_legal_entities_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['is_default','status']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['is_default','status']) THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a legal entity''s identity is fixed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_legal_entities_guard BEFORE UPDATE ON fleet_legal_entities FOR EACH ROW EXECUTE FUNCTION fleet_legal_entities_guard();

-- A new profile VERSION (history is never rewritten). Rules: [{taxKind: vat|sales_tax|profit|other, rateBp, inclusive?, label?}].
CREATE FUNCTION fleet_admin_tax_profile_set(p_entity uuid, p_rules jsonb, p_effective timestamptz, p_note text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r jsonb; t fleet_tax_profiles; v_ver integer;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM fleet_legal_entities WHERE entity_id = p_entity) THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such legal entity'; END IF;
  IF jsonb_typeof(p_rules) <> 'array' OR jsonb_array_length(p_rules) > 8 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: rules are an array of at most 8'; END IF;
  FOR r IN SELECT x FROM jsonb_array_elements(p_rules) x LOOP
    IF r ->> 'taxKind' NOT IN ('vat','sales_tax','profit','other') OR (r ->> 'rateBp') !~ '^[0-9]{1,5}$' OR (r ->> 'rateBp')::integer > 10000
       OR (r ? 'inclusive' AND jsonb_typeof(r -> 'inclusive') <> 'boolean') THEN
      RAISE EXCEPTION 'FLEET_BAD_REQUEST: each rule is {taxKind: vat|sales_tax|profit|other, rateBp: 0..10000, inclusive?: boolean}';
    END IF;
  END LOOP;
  SELECT COALESCE(max(version), 0) + 1 INTO v_ver FROM fleet_tax_profiles WHERE entity_id = p_entity;
  INSERT INTO fleet_tax_profiles (profile_id, entity_id, version, effective_from, rules, note, created_by)
    VALUES (gen_random_uuid(), p_entity, v_ver, COALESCE(p_effective, now()), p_rules, fleet_scrub(p_note), p_actor) RETURNING * INTO t;
  PERFORM fleet_event('tax_profile_set', NULL, p_actor, jsonb_build_object('entityId', p_entity, 'version', v_ver, 'rules', p_rules));
  RETURN to_jsonb(t);
END $$;

-- ═══ 2. Ledger grammar additions ═══
ALTER TABLE fleet_ledger_classes DISABLE TRIGGER fleet_ledger_classes_no_change;
INSERT INTO fleet_ledger_classes (class, kind, normal_side, scope, non_negative, description) VALUES
  ('agent_tax_reserve',    'asset',   'D', 'agent', true, 'Agent cash set aside for tax of its legal entity: restricted, never spendable'),
  ('agent_tax_expense',    'expense', 'D', 'agent', true, 'Tax paid out of an agent''s tax reserve'),
  ('agent_envelope_cash',  'asset',   'D', 'agent', true, 'Fleet capital allocated to an agent under an execution envelope (restricted to its purpose)'),
  ('fleet_operating_pool', 'asset',   'D', 'fleet', true, 'Admin-controlled Fleet operating pool (infrastructure, providers, subscriptions, upgrades)');
ALTER TABLE fleet_ledger_classes ENABLE TRIGGER fleet_ledger_classes_no_change;

ALTER TABLE fleet_ledger_kinds DISABLE TRIGGER fleet_ledger_kinds_no_change;
ALTER TABLE fleet_ledger_kinds DROP CONSTRAINT fleet_ledger_kinds_provenance;
ALTER TABLE fleet_ledger_kinds ADD CONSTRAINT fleet_ledger_kinds_provenance CHECK (provenance IN ('owner_funding','internal_transfer',
  'treasury_allocation','genesis_allocation','protected_principal','reservation','expense','external_customer_revenue','refund','fee',
  'realized_investment_pnl','unrealized_valuation','profit_contribution','owner_withdrawal','estate','correction','tax','fleet_capital'));
INSERT INTO fleet_ledger_kinds (kind, requires_external_ref, allowed_sources, multi_agent, description, provenance) VALUES
  ('venture_sale',                 true,  ARRAY['owner','controller'], false, 'External sale settled on a Fleet rail: gross revenue, processor fee, net cash', 'external_customer_revenue'),
  ('tax_reservation',              false, ARRAY['owner','controller'], false, 'Move agent cash into its restricted tax reserve', 'tax'),
  ('tax_reserve_release',          false, ARRAY['owner','controller'], false, 'Release an over-reserved tax amount back to agent cash', 'tax'),
  ('tax_payment',                  true,  ARRAY['owner','executor'],   false, 'Tax paid out of the tax reserve (external)', 'tax'),
  ('envelope_allocation',          false, ARRAY['owner','controller'], false, 'Fleet capital allocated under an execution envelope', 'fleet_capital'),
  ('envelope_return',              false, ARRAY['owner','controller'], false, 'Unspent envelope capital returned to the Treasury', 'fleet_capital'),
  ('envelope_spend_reservation',   false, ARRAY['owner','controller'], false, 'Reserve envelope capital for a spend order inside the envelope', 'reservation'),
  ('envelope_spend_release',       false, ARRAY['owner','controller','executor'], false, 'Release an envelope reservation (cancelled, expired, failed)', 'reservation'),
  ('operating_transfer',           false, ARRAY['owner'],              false, 'Owner transfer of safely transferable agent capital to the Fleet operating pool', 'internal_transfer'),
  ('operating_expense_settlement', true,  ARRAY['owner','executor'],   false, 'External settlement of a Fleet operating expense from the operating pool', 'expense');
-- Customer refunds may also be recorded by FleetController's rail settlement.
UPDATE fleet_ledger_kinds SET allowed_sources = ARRAY['owner','executor','controller'] WHERE kind = 'external_refund';
ALTER TABLE fleet_ledger_kinds ENABLE TRIGGER fleet_ledger_kinds_no_change;

INSERT INTO fleet_ledger_rules (kind, class, side) VALUES
  ('venture_sale','agent_cash','D'), ('venture_sale','agent_fees','D'), ('venture_sale','agent_revenue','C'),
  ('tax_reservation','agent_tax_reserve','D'), ('tax_reservation','agent_cash','C'),
  ('tax_reserve_release','agent_cash','D'), ('tax_reserve_release','agent_tax_reserve','C'),
  ('tax_payment','agent_tax_expense','D'), ('tax_payment','agent_tax_reserve','C'),
  ('envelope_allocation','agent_envelope_cash','D'), ('envelope_allocation','treasury_cash','C'),
  ('envelope_return','treasury_cash','D'), ('envelope_return','agent_envelope_cash','C'),
  ('envelope_spend_reservation','agent_reserved','D'), ('envelope_spend_reservation','agent_envelope_cash','C'),
  ('envelope_spend_release','agent_envelope_cash','D'), ('envelope_spend_release','agent_reserved','C'),
  ('operating_transfer','fleet_operating_pool','D'), ('operating_transfer','agent_cash','C'),
  ('operating_expense_settlement','fleet_expense','D'), ('operating_expense_settlement','fleet_operating_pool','C');

INSERT INTO fleet_ledger_accounts (account_id, class, agent_id, description, created_by)
  VALUES ('fleet:operating:pool', 'fleet_operating_pool', NULL, 'Fleet operating pool (admin-controlled)', 'migration');

CREATE OR REPLACE FUNCTION fleet_ledger_open_agent(p_agent text, p_actor text) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = p_agent) THEN
    RAISE EXCEPTION 'FLEET_LEDGER_INVALID: unknown agent %', p_agent;
  END IF;
  FOREACH c IN ARRAY ARRAY['agent_cash','agent_reserved','agent_assets','agent_principal','agent_revenue','agent_expense','agent_fees',
                           'agent_contributions','agent_investment_pnl','agent_tax_reserve','agent_tax_expense','agent_envelope_cash'] LOOP
    INSERT INTO fleet_ledger_accounts (account_id, class, agent_id, description, created_by)
    VALUES ('agent:' || p_agent || ':' || substr(c, 7), c, p_agent, c || ' of ' || p_agent, left(p_actor, 128))
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;
-- Existing agents (Founder 1) get the new accounts now; no journal is posted (no money is created or moved).
SELECT fleet_ledger_open_agent(agent_id, 'migration') FROM fleet_ledger_accounts WHERE class = 'agent_cash' GROUP BY agent_id;

-- ═══ 3. Credential references (never secrets) and the broker's use log ═══
CREATE TABLE fleet_credential_refs (
  credential_id  uuid        PRIMARY KEY,
  provider       text        NOT NULL CHECK (provider ~ '^[a-z0-9_-]{2,30}$'),
  purpose        text        NOT NULL CHECK (length(purpose) BETWEEN 1 AND 120),
  vault_ref      text        NOT NULL UNIQUE CHECK (vault_ref ~ '^vault:[a-z0-9][a-z0-9/._-]{2,118}$'),
  scope          text[]      NOT NULL DEFAULT '{}' CHECK (cardinality(scope) <= 16),
  spend_limited  boolean     NOT NULL DEFAULT false,
  display_hint   text        CHECK (display_hint ~ '^[A-Za-z0-9 •…*._@-]{0,40}$'),
  status         text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','rotating','revoked','expired')),
  health         text        NOT NULL DEFAULT 'unknown' CHECK (health IN ('unknown','ok','degraded','failing')),
  created_by     text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  rotated_at     timestamptz,
  revoked_at     timestamptz,
  last_used_at   timestamptz,
  last_health_at timestamptz,
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
COMMENT ON COLUMN fleet_credential_refs.vault_ref IS 'A REFERENCE into the secret vault (e.g. vault:paypal/treasury). Never a secret; the CHECK refuses anything but a short path.';
CREATE TRIGGER fleet_credential_refs_no_delete BEFORE DELETE ON fleet_credential_refs FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_credential_refs_no_truncate BEFORE TRUNCATE ON fleet_credential_refs FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
CREATE FUNCTION fleet_credential_refs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'revoked' THEN RAISE EXCEPTION 'FLEET_IMMUTABLE: revocation is final'; END IF;
  IF NEW.credential_id <> OLD.credential_id OR NEW.provider <> OLD.provider OR NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a credential reference''s identity is fixed (register a new one)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_credential_refs_guard BEFORE UPDATE ON fleet_credential_refs FOR EACH ROW EXECUTE FUNCTION fleet_credential_refs_guard();

CREATE TABLE fleet_credential_use_log (
  seq           bigserial   PRIMARY KEY,
  credential_id uuid        NOT NULL REFERENCES fleet_credential_refs(credential_id),
  actor         text        NOT NULL,
  action        text        NOT NULL CHECK (action ~ '^[a-z_.]{3,40}$'),
  agent_id      text        REFERENCES fleet_agents(agent_id),
  venture_id    uuid        REFERENCES fleet_ventures(venture_id),
  outcome       text        NOT NULL CHECK (outcome IN ('ok','refused','failed')),
  detail        text        CHECK (length(detail) <= 200),
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_credential_use_log_no_change BEFORE UPDATE OR DELETE ON fleet_credential_use_log FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_credential_use_log_no_truncate BEFORE TRUNCATE ON fleet_credential_use_log FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION fleet_admin_credential_register(p_provider text, p_purpose text, p_vault_ref text, p_scope text[], p_spend_limited boolean, p_hint text, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_credential_refs;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');
  INSERT INTO fleet_credential_refs (credential_id, provider, purpose, vault_ref, scope, spend_limited, display_hint, created_by)
    VALUES (gen_random_uuid(), p_provider, fleet_scrub(p_purpose), p_vault_ref, COALESCE(p_scope, '{}'), COALESCE(p_spend_limited, false), p_hint, p_actor)
    RETURNING * INTO c;
  PERFORM fleet_event('credential_registered', NULL, p_actor, jsonb_build_object('credentialId', c.credential_id, 'provider', c.provider, 'scope', c.scope));
  RETURN to_jsonb(c);
END $$;

CREATE FUNCTION fleet_admin_credential_set_status(p_credential uuid, p_status text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_credential_refs;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  IF p_status NOT IN ('active','rotating','revoked','expired') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: status is active, rotating, revoked or expired'; END IF;
  UPDATE fleet_credential_refs SET status = p_status, revoked_at = CASE WHEN p_status = 'revoked' THEN now() END,
         rotated_at = CASE WHEN p_status = 'rotating' THEN now() ELSE rotated_at END
   WHERE credential_id = p_credential RETURNING * INTO c;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such credential reference'; END IF;
  -- A revoked credential takes its rails out of service (fail closed).
  IF p_status IN ('revoked','expired') THEN
    UPDATE fleet_payment_rails SET status = 'suspended', health_note = 'credential ' || p_status WHERE credential_id = p_credential AND status IN ('active','degraded','pending_setup');
  END IF;
  PERFORM fleet_event('credential_' || p_status, NULL, p_actor, jsonb_build_object('credentialId', p_credential));
  RETURN to_jsonb(c);
END $$;

-- The broker's audit: every use of a credential (by the controller's provider adapters) is recorded; never the secret.
CREATE FUNCTION svc_credential_use(p_credential uuid, p_action text, p_agent text, p_venture uuid, p_outcome text, p_detail text) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_credential_refs;
BEGIN
  SELECT * INTO c FROM fleet_credential_refs WHERE credential_id = p_credential;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF p_outcome NOT IN ('ok','refused','failed') OR p_action !~ '^[a-z_.]{3,40}$' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  INSERT INTO fleet_credential_use_log (credential_id, actor, action, agent_id, venture_id, outcome, detail)
    VALUES (p_credential, 'controller', p_action, p_agent, p_venture, CASE WHEN c.status IN ('active','rotating') THEN p_outcome ELSE 'refused' END, left(fleet_scrub(p_detail), 200));
  UPDATE fleet_credential_refs SET last_used_at = now() WHERE credential_id = p_credential AND status <> 'revoked';
  RETURN jsonb_build_object('ok', c.status IN ('active','rotating'), 'status', c.status);
END $$;

-- ═══ 4. Payment rails (Fleet-owned; shared or dedicated) ═══
CREATE TABLE fleet_payment_rails (
  rail_id              uuid        PRIMARY KEY,
  provider             text        NOT NULL CHECK (provider IN ('paypal','stripe','bank','card','gumroad','etsy','shopify','direct_storefront','simulated','other')),
  label                text        NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
  rail_kind            text        NOT NULL CHECK (rail_kind IN ('shared','dedicated')),
  legal_entity_id      uuid        NOT NULL REFERENCES fleet_legal_entities(entity_id),
  capabilities         text[]      NOT NULL CHECK (cardinality(capabilities) BETWEEN 1 AND 8 AND capabilities <@ ARRAY['receive_payments','refunds','payouts',
                                     'card_spend','bank_transfer','marketplace_listing','subscriptions','storefront']::text[]),
  account_ref          text        NOT NULL CHECK (length(account_ref) BETWEEN 1 AND 60 AND account_ref !~ '[0-9][0-9 -]{6,}[0-9]'),
  credential_id        uuid        REFERENCES fleet_credential_refs(credential_id),
  mode                 text        NOT NULL DEFAULT 'simulated' CHECK (mode IN ('simulated','sandbox','live')),
  status               text        NOT NULL DEFAULT 'active' CHECK (status IN ('pending_setup','active','degraded','suspended','revoked')),
  dedicated_venture_id uuid        REFERENCES fleet_ventures(venture_id),
  max_ventures         integer     CHECK (max_ventures BETWEEN 1 AND 100000),
  last_settlement_at   timestamptz,
  last_health_at       timestamptz,
  health_note          text        CHECK (length(health_note) <= 200),
  created_by           text        NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  revoked_at           timestamptz,
  -- Constitutional pin: no LIVE rail exists while real payments are disabled. Enabling one is a reviewed migration.
  CONSTRAINT fleet_payment_rails_not_live CHECK (mode <> 'live'),
  CHECK ((rail_kind = 'dedicated') = (dedicated_venture_id IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
COMMENT ON COLUMN fleet_payment_rails.account_ref IS 'MASKED display reference only (e.g. "PayPal treasury@…", "Visa •••• 4821"); full account or card numbers are refused by CHECK.';
CREATE TRIGGER fleet_payment_rails_no_delete BEFORE DELETE ON fleet_payment_rails FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_payment_rails_no_truncate BEFORE TRUNCATE ON fleet_payment_rails FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
CREATE FUNCTION fleet_payment_rails_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'revoked' THEN RAISE EXCEPTION 'FLEET_IMMUTABLE: revocation is final'; END IF;
  IF NEW.rail_id <> OLD.rail_id OR NEW.provider <> OLD.provider OR NEW.rail_kind <> OLD.rail_kind OR NEW.legal_entity_id <> OLD.legal_entity_id
     OR NEW.dedicated_venture_id IS DISTINCT FROM OLD.dedicated_venture_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a rail''s provider, kind, legal entity and dedication are fixed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_payment_rails_guard BEFORE UPDATE ON fleet_payment_rails FOR EACH ROW EXECUTE FUNCTION fleet_payment_rails_guard();

CREATE TABLE fleet_rail_assignments (
  assignment_id uuid        PRIMARY KEY,
  rail_id       uuid        NOT NULL REFERENCES fleet_payment_rails(rail_id),
  venture_id    uuid        NOT NULL REFERENCES fleet_ventures(venture_id),
  capability    text        NOT NULL,
  assigned_by   text        NOT NULL,
  assigned_at   timestamptz NOT NULL DEFAULT now(),
  released_at   timestamptz,
  release_note  text        CHECK (length(release_note) <= 200)
);
CREATE UNIQUE INDEX fleet_rail_assignments_active_uq ON fleet_rail_assignments (venture_id, capability) WHERE released_at IS NULL;
CREATE TRIGGER fleet_rail_assignments_no_delete BEFORE DELETE ON fleet_rail_assignments FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_rail_assignments_no_truncate BEFORE TRUNCATE ON fleet_rail_assignments FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_rail_requirements (
  requirement_id uuid        PRIMARY KEY,
  venture_id     uuid        NOT NULL REFERENCES fleet_ventures(venture_id),
  agent_id       text        NOT NULL REFERENCES fleet_agents(agent_id),
  capability     text        NOT NULL,
  preference     text        NOT NULL DEFAULT 'any' CHECK (preference IN ('any','shared','dedicated')),
  provider       text,
  status         text        NOT NULL DEFAULT 'open' CHECK (status IN ('open','assigned','dependency','withdrawn')),
  assignment_id  uuid        REFERENCES fleet_rail_assignments(assignment_id),
  dependency_id  uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz
);
CREATE TRIGGER fleet_rail_requirements_no_delete BEFORE DELETE ON fleet_rail_requirements FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_rail_requirements_no_truncate BEFORE TRUNCATE ON fleet_rail_requirements FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION fleet_rail_json(r fleet_payment_rails) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('railId', r.rail_id, 'provider', r.provider, 'label', r.label, 'kind', r.rail_kind,
    'capabilities', to_jsonb(r.capabilities), 'accountRef', r.account_ref, 'mode', r.mode, 'status', r.status,
    'legalEntity', (SELECT e.name FROM fleet_legal_entities e WHERE e.entity_id = r.legal_entity_id)))
$$;

-- Match a requirement to a compatible rail (dedicated to the venture first, else shared with capacity, same legal entity).
CREATE FUNCTION fleet_rail_match(p_venture uuid, p_capability text, p_preference text, p_provider text) RETURNS fleet_payment_rails LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT r.* FROM fleet_payment_rails r
   WHERE r.status = 'active' AND p_capability = ANY (r.capabilities) AND r.legal_entity_id = fleet_venture_entity(p_venture)
     AND (p_provider IS NULL OR r.provider = p_provider)
     AND (CASE p_preference WHEN 'dedicated' THEN r.dedicated_venture_id = p_venture
                            WHEN 'shared' THEN r.rail_kind = 'shared'
                            ELSE r.dedicated_venture_id = p_venture OR r.rail_kind = 'shared' END)
     AND (r.rail_kind = 'dedicated' OR r.max_ventures IS NULL
          OR (SELECT count(DISTINCT a.venture_id) FROM fleet_rail_assignments a WHERE a.rail_id = r.rail_id AND a.released_at IS NULL) < r.max_ventures)
     AND (r.credential_id IS NULL OR EXISTS (SELECT 1 FROM fleet_credential_refs c WHERE c.credential_id = r.credential_id AND c.status IN ('active','rotating')))
   ORDER BY (r.dedicated_venture_id = p_venture) DESC NULLS LAST, r.created_at
   LIMIT 1
$$;

-- PAYMENT_RAIL_REQUIRED: assign automatically when possible; otherwise, if a provider was named, record ONE action-scoped
-- dependency (a new account needs a human identity/KYC). The venture, its other channels and the agent's work go on.
CREATE FUNCTION fleet_rail_resolve(q fleet_rail_requirements, p_actor text) RETURNS fleet_rail_requirements LANGUAGE plpgsql
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
    UPDATE fleet_rail_requirements SET status = 'assigned', assignment_id = v_assign, resolved_at = now() WHERE requirement_id = q.requirement_id RETURNING * INTO out;
    -- A dependency recorded earlier for this action is answered by the connection itself (nothing waits on anyone).
    IF q.dependency_id IS NOT NULL THEN
      UPDATE fleet_owner_requests SET status = 'answered', decided_by = p_actor, decided_at = now(),
             response = 'A compatible Fleet payment rail is now connected and assigned; the action is available.'
       WHERE request_id = q.dependency_id AND status = 'pending';
    END IF;
    PERFORM fleet_event('payment_rail_assigned', q.agent_id, p_actor, jsonb_build_object('ventureId', q.venture_id, 'railId', r.rail_id, 'capability', q.capability,
      'kind', r.rail_kind));
    RETURN out;
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

CREATE FUNCTION fleet_admin_rail_add(p_provider text, p_label text, p_kind text, p_entity uuid, p_capabilities text[], p_account_ref text,
  p_credential uuid, p_mode text, p_dedicated_venture uuid, p_max_ventures integer, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_payment_rails; q fleet_rail_requirements; n integer := 0;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');
  INSERT INTO fleet_payment_rails (rail_id, provider, label, rail_kind, legal_entity_id, capabilities, account_ref, credential_id, mode, dedicated_venture_id, max_ventures, created_by)
    VALUES (gen_random_uuid(), p_provider, fleet_scrub(p_label), p_kind, COALESCE(p_entity, (SELECT entity_id FROM fleet_legal_entities WHERE is_default)),
            p_capabilities, p_account_ref, p_credential, COALESCE(p_mode, 'simulated'), p_dedicated_venture, p_max_ventures, p_actor)
    RETURNING * INTO r;
  PERFORM fleet_event('payment_rail_added', NULL, p_actor, fleet_rail_json(r));
  -- Waiting requirements are matched at once (the venture never had to wait on anyone to be told).
  FOR q IN SELECT * FROM fleet_rail_requirements WHERE status IN ('open','dependency') ORDER BY created_at FOR UPDATE LOOP
    IF (fleet_rail_resolve(q, p_actor)).status = 'assigned' THEN n := n + 1; END IF;
  END LOOP;
  RETURN fleet_rail_json(r) || jsonb_build_object('requirementsAssigned', n);
END $$;

CREATE FUNCTION fleet_admin_rail_set_status(p_rail uuid, p_status text, p_note text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_payment_rails;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  IF p_status NOT IN ('active','degraded','suspended','revoked') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: status is active, degraded, suspended or revoked'; END IF;
  UPDATE fleet_payment_rails SET status = p_status, health_note = left(fleet_scrub(p_note), 200), last_health_at = now(),
         revoked_at = CASE WHEN p_status = 'revoked' THEN now() END
   WHERE rail_id = p_rail RETURNING * INTO r;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such rail'; END IF;
  IF p_status = 'revoked' THEN
    UPDATE fleet_rail_assignments SET released_at = now(), release_note = 'rail revoked' WHERE rail_id = p_rail AND released_at IS NULL;
  END IF;
  PERFORM fleet_event('payment_rail_status', NULL, p_actor, jsonb_build_object('railId', p_rail, 'status', p_status));
  RETURN fleet_rail_json(r);
END $$;

-- ═══ 5. Vendor destinations (agent-registered, controller-verified; no owner enrolment) ═══
CREATE TABLE fleet_vendor_destinations (
  destination_id  text        PRIMARY KEY REFERENCES fleet_payment_destinations(destination_id),
  agent_id        text        NOT NULL REFERENCES fleet_agents(agent_id),
  venture_id      uuid        REFERENCES fleet_ventures(venture_id),
  vendor_name     text        NOT NULL CHECK (length(vendor_name) BETWEEN 1 AND 100),
  category        text        NOT NULL CHECK (category IN (${VENDOR_CATEGORIES})),
  provider        text        CHECK (provider ~ '^[a-z0-9_-]{2,30}$'),
  website         text        CHECK (website ~ '^https://[A-Za-z0-9.-]{3,120}(/[^ ]{0,200})?$'),
  trust           text        NOT NULL DEFAULT 'registered' CHECK (trust IN ('registered','verified','trusted','flagged')),
  risk            jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(risk) = 'object'),
  registered_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_vendor_destinations_no_delete BEFORE DELETE ON fleet_vendor_destinations FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_vendor_destinations_no_truncate BEFORE TRUNCATE ON fleet_vendor_destinations FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
-- The real payee details (needed only by custody execution, which is pinned off) live apart from every role but the owner.
CREATE TABLE fleet_destination_references (
  destination_id text PRIMARY KEY REFERENCES fleet_payment_destinations(destination_id),
  reference      text NOT NULL CHECK (length(reference) BETWEEN 3 AND 200)
);
CREATE TRIGGER fleet_destination_references_no_change BEFORE UPDATE OR DELETE ON fleet_destination_references FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- The enrolment guard (v10): owner-enrolled destinations unchanged; additionally the vendor registry (controller) may create
-- an ACTIVE payee scoped to one agent, inside fleet_vendor_register only.
CREATE OR REPLACE FUNCTION fleet_destinations_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(current_setting('fleet.vendor_register', true), '') = NEW.destination_id THEN
      IF NEW.kind <> 'payee' OR NEW.allowed_agent_id IS NULL OR NEW.enrolled_by <> 'controller' OR NEW.status <> 'active'
         OR NEW.rail NOT IN ('provider_account','bank_transfer') THEN
        RAISE EXCEPTION 'FLEET_DESTINATION_INVALID: a vendor destination is an active payee of one agent on a provider account or bank transfer';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.status <> 'pending' THEN RAISE EXCEPTION 'FLEET_DESTINATION_INVALID: destinations are enrolled pending'; END IF;
    PERFORM fleet_require_operator_approver(substr(NEW.enrolled_by, 10), 'fleet_treasury');
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','activated_by','activated_at','revoked_by','revoked_at','revoke_reason'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','activated_by','activated_at','revoked_by','revoked_at','revoke_reason']) THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: a destination never changes; enroll a new one';
  END IF;
  IF OLD.status = 'revoked' THEN RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: revocation is final'; END IF;
  IF NEW.status = 'active' AND OLD.status = 'pending' THEN
    IF now() < OLD.activatable_at THEN
      RAISE EXCEPTION 'FLEET_DESTINATION_COOLDOWN: destination % activates after %', OLD.destination_id, OLD.activatable_at;
    END IF;
    PERFORM fleet_require_operator_approver(substr(NEW.activated_by, 10), 'fleet_treasury');
  ELSIF NEW.status <> OLD.status AND NOT (NEW.status = 'revoked') THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: destination % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION fleet_econ_vendor_register(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_id text := 'dst_' || fleet_new_ulid(); v_rail text := COALESCE(fleet_econ_text(a, 'rail', 20), 'provider_account');
        v_ref text := fleet_econ_text(a, 'reference', 200, true); v_cat text := fleet_econ_text(a, 'category', 30, true);
        v_name text := fleet_econ_text(a, 'vendorName', 100, true); v_sha text; v_hint text; v_venture uuid; v_existing text;
BEGIN
  IF v_cat NOT IN (${VENDOR_CATEGORIES}) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_VENDOR_CATEGORY', 'reason', 'not a business vendor category FleetController pays automatically (personal transfers, gambling, cash and crypto are never vendors)');
  END IF;
  IF v_rail NOT IN ('provider_account','bank_transfer') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_VENDOR_RAIL', 'reason', 'vendors are paid on a provider account or a bank transfer');
  END IF;
  IF v_rail = 'provider_account' AND v_ref !~ '^([a-z0-9_-]{2,30}:)?([^@ ]{1,64}@[A-Za-z0-9.-]{3,120}|https://[A-Za-z0-9.-]{3,120}(/[^ ]{0,120})?)$' THEN
    PERFORM fleet_econ_bad('a provider-account reference is an email or an https URL (optionally prefixed provider:)');
  END IF;
  IF v_rail = 'bank_transfer' AND v_ref !~ '^[A-Z]{2}[0-9A-Z ]{10,40}$' THEN PERFORM fleet_econ_bad('a bank reference is an IBAN-style account identifier'); END IF;
  v_sha := encode(sha256(convert_to(lower(btrim(v_ref)), 'UTF8')), 'hex');
  IF fleet_counterparty_internal(v_sha) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_VENDOR_INTERNAL', 'reason', 'that reference is Fleet-controlled: an internal transfer is not a vendor payment');
  END IF;
  -- One registration per agent and payee: a repeat returns the existing destination.
  SELECT d.destination_id INTO v_existing FROM fleet_payment_destinations d JOIN fleet_vendor_destinations v ON v.destination_id = d.destination_id
   WHERE v.agent_id = p_agent AND d.reference_sha256 = v_sha AND d.status = 'active';
  IF v_existing IS NOT NULL THEN RETURN jsonb_build_object('ok', true, 'replayed', true, 'destinationId', v_existing); END IF;
  IF (SELECT count(*) FROM fleet_vendor_destinations WHERE agent_id = p_agent AND registered_at > now() - interval '1 day') >= 20 THEN
    RAISE EXCEPTION 'FLEET_INFRASTRUCTURE_CEILING: an infrastructure failsafe against runaway loops was hit';
  END IF;
  IF a ? 'ventureKey' THEN
    SELECT venture_id INTO v_venture FROM fleet_ventures WHERE agent_id = p_agent AND venture_key = fleet_econ_key(a, 'ventureKey');
  END IF;
  v_hint := CASE WHEN length(v_ref) > 4 THEN '***' || regexp_replace(right(v_ref, 4), '[^A-Za-z0-9*._-]', '', 'g') ELSE NULL END;
  PERFORM set_config('fleet.vendor_register', v_id, true);
  INSERT INTO fleet_payment_destinations (destination_id, kind, rail, label, reference_sha256, reference_hint, allowed_agent_id, status, enrolled_by,
      enrolled_at, activatable_at, activation_code_sha256, activated_by, activated_at)
    VALUES (v_id, 'payee', v_rail, left(v_name, 100), v_sha, v_hint, p_agent, 'active', 'controller', now(), now() + interval '1 microsecond',
            encode(sha256(convert_to(gen_random_uuid()::text || clock_timestamp()::text, 'UTF8')), 'hex'), 'controller', now());
  PERFORM set_config('fleet.vendor_register', '', true);
  INSERT INTO fleet_vendor_destinations (destination_id, agent_id, venture_id, vendor_name, category, provider, website, risk)
    VALUES (v_id, p_agent, v_venture, v_name, v_cat, fleet_econ_text(a, 'provider', 30), fleet_econ_text(a, 'website', 300),
            jsonb_build_object('registeredBy', 'agent', 'verification', 'format'));
  INSERT INTO fleet_destination_references (destination_id, reference) VALUES (v_id, v_ref);
  PERFORM fleet_event('vendor_registered', p_agent, 'controller', jsonb_build_object('destinationId', v_id, 'category', v_cat, 'rail', v_rail));
  RETURN jsonb_build_object('ok', true, 'destinationId', v_id, 'status', 'active',
    'note', 'Registered and verified by FleetController; pay it with request_spend. Custody checks still apply to every order.');
END $$;

CREATE FUNCTION fleet_econ_vendor_revoke(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_id text := fleet_econ_text(a, 'destinationId', 40, true);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleet_vendor_destinations WHERE destination_id = v_id AND agent_id = p_agent) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND', 'reason', 'no such vendor destination of yours');
  END IF;
  UPDATE fleet_payment_destinations SET status = 'revoked', revoked_by = p_agent, revoked_at = now(), revoke_reason = fleet_econ_text(a, 'reason', 200)
   WHERE destination_id = v_id AND status <> 'revoked';
  PERFORM fleet_event('vendor_revoked', p_agent, p_agent, jsonb_build_object('destinationId', v_id));
  RETURN jsonb_build_object('ok', true);
END $$;

-- Circuit breaker: a relative destination-novelty signal (unset by default; no production values chosen here).
ALTER TABLE fleet_spend_circuit_breaker ADD COLUMN new_destination_age_s integer CHECK (new_destination_age_s BETWEEN 60 AND 31536000),
  ADD COLUMN new_destination_wallet_bp integer CHECK (new_destination_wallet_bp BETWEEN 1 AND 10000),
  ADD CONSTRAINT fleet_spend_circuit_breaker_novelty_pair CHECK ((new_destination_age_s IS NULL) = (new_destination_wallet_bp IS NULL));
COMMENT ON COLUMN fleet_spend_circuit_breaker.new_destination_wallet_bp IS 'an order to a destination younger than new_destination_age_s above this share (bp) of the founder''s own unreserved cash trips the breaker; NULL = unset';
CREATE OR REPLACE FUNCTION fleet_spend_circuit_breaker_check(o fleet_payment_orders) RETURNS text LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE b fleet_spend_circuit_breaker; v_cash bigint; v_window bigint; v_age interval;
BEGIN
  SELECT * INTO b FROM fleet_spend_circuit_breaker WHERE id = 1;
  IF NOT FOUND THEN RETURN 'unavailable'; END IF; -- fail closed (the row cannot be deleted)
  IF b.tripped THEN RETURN 'tripped'; END IF;
  IF b.order_wallet_bp IS NULL AND b.velocity_wallet_bp IS NULL AND b.new_destination_wallet_bp IS NULL THEN RETURN NULL; END IF;
  v_cash := fleet_ledger_balance(fleet_ledger_account(o.agent_id, 'agent_cash'));
  IF b.order_wallet_bp IS NOT NULL AND o.amount_cents::numeric * 10000 > v_cash::numeric * b.order_wallet_bp THEN
    RETURN 'order_wallet_share';
  END IF;
  IF b.velocity_wallet_bp IS NOT NULL THEN
    SELECT COALESCE(sum(amount_cents), 0) INTO v_window FROM fleet_payment_orders
     WHERE agent_id = o.agent_id AND order_id <> o.order_id AND status IN ('reserved','executing','settled')
       AND created_at > now() - make_interval(secs => b.velocity_window_s);
    IF (v_window + o.amount_cents)::numeric * 10000 > (v_cash + v_window)::numeric * b.velocity_wallet_bp THEN
      RETURN 'velocity_wallet_share';
    END IF;
  END IF;
  IF b.new_destination_wallet_bp IS NOT NULL THEN
    SELECT now() - COALESCE(activated_at, enrolled_at) INTO v_age FROM fleet_payment_destinations WHERE destination_id = o.destination_id;
    IF v_age < make_interval(secs => b.new_destination_age_s) AND o.amount_cents::numeric * 10000 > v_cash::numeric * b.new_destination_wallet_bp THEN
      RETURN 'new_destination_wallet_share';
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION fleet_admin_spend_circuit_breaker_novelty(p_actor text, p_age_s integer, p_wallet_bp integer) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE b fleet_spend_circuit_breaker;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');
  UPDATE fleet_spend_circuit_breaker SET new_destination_age_s = p_age_s, new_destination_wallet_bp = p_wallet_bp, updated_at = now(), updated_by = p_actor
   WHERE id = 1 RETURNING * INTO b;
  PERFORM fleet_event('spend_circuit_breaker_set', NULL, p_actor, to_jsonb(b) - 'id');
  RETURN to_jsonb(b) - 'id';
END $$;

-- ═══ 6. External transactions and settlement ═══
CREATE TABLE fleet_external_transactions (
  txn_id          uuid        PRIMARY KEY,
  rail_id         uuid        NOT NULL REFERENCES fleet_payment_rails(rail_id),
  external_id     text        NOT NULL CHECK (external_id ~ '^[A-Za-z0-9:_./-]{3,120}$'),
  kind            text        NOT NULL CHECK (kind IN ('sale','refund')),
  gross_minor     bigint      NOT NULL CHECK (gross_minor > 0 AND gross_minor <= 100000000000),
  fee_minor       bigint      NOT NULL DEFAULT 0 CHECK (fee_minor >= 0 AND fee_minor <= gross_minor),
  currency        text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  venture_id      uuid        REFERENCES fleet_ventures(venture_id),
  agent_id        text        REFERENCES fleet_agents(agent_id),
  status          text        NOT NULL CHECK (status IN ('settled','unattributed','failed')),
  status_reason   text        CHECK (length(status_reason) <= 300),
  journal_id      uuid        REFERENCES fleet_ledger_journal(journal_id),
  tax_journal_id  uuid        REFERENCES fleet_ledger_journal(journal_id),
  tax             jsonb,
  payload_sha256  text        NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  counterparty_sha256 text    CHECK (counterparty_sha256 ~ '^[0-9a-f]{64}$'),
  occurred_at     timestamptz NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  settled_at      timestamptz,
  UNIQUE (rail_id, external_id, kind),
  CHECK ((status = 'settled') = (journal_id IS NOT NULL AND venture_id IS NOT NULL AND settled_at IS NOT NULL))
);
CREATE INDEX fleet_external_transactions_status ON fleet_external_transactions (status, received_at);
CREATE TRIGGER fleet_external_transactions_no_delete BEFORE DELETE ON fleet_external_transactions FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_external_transactions_no_truncate BEFORE TRUNCATE ON fleet_external_transactions FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
-- A transaction's identity and amounts never change; a settled one is final; the status moves forward only.
CREATE FUNCTION fleet_external_transactions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.txn_id <> OLD.txn_id OR NEW.rail_id <> OLD.rail_id OR NEW.external_id <> OLD.external_id OR NEW.kind <> OLD.kind OR NEW.gross_minor <> OLD.gross_minor
     OR NEW.fee_minor <> OLD.fee_minor OR NEW.currency <> OLD.currency OR NEW.payload_sha256 <> OLD.payload_sha256 OR NEW.occurred_at <> OLD.occurred_at THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: an external transaction never changes';
  END IF;
  IF OLD.status = 'settled' THEN RAISE EXCEPTION 'FLEET_IMMUTABLE: a settled transaction is final (correct it with a reversal)'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_external_transactions_guard BEFORE UPDATE ON fleet_external_transactions FOR EACH ROW EXECUTE FUNCTION fleet_external_transactions_guard();

-- Settle one transaction into its venture (sale or refund), atomically: journal(s), attribution, provenance, tax.
CREATE FUNCTION fleet_settlement_post(t fleet_external_transactions, p_venture uuid, p_actor text) RETURNS fleet_external_transactions LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v fleet_ventures; v_j uuid; v_tj uuid; v_tax jsonb; v_ref text; out fleet_external_transactions; v_reserve bigint; v_release bigint; v_net bigint;
BEGIN
  SELECT * INTO v FROM fleet_ventures WHERE venture_id = p_venture;
  v_ref := 'rail:' || t.rail_id || ':' || t.kind || ':' || t.external_id;
  IF length(v_ref) > 200 THEN v_ref := 'rail:' || encode(sha256(convert_to(v_ref, 'UTF8')), 'hex'); END IF;
  PERFORM fleet_ledger_open_agent(v.agent_id, p_actor);
  IF t.kind = 'sale' THEN
    v_net := t.gross_minor - t.fee_minor;
    v_j := fleet_ledger_post('venture_sale', 'settle:' || t.txn_id, p_actor, 'venture sale settled on a Fleet rail', 'controller', v.agent_id, NULL, NULL, v_ref, NULL, t.occurred_at,
      -- Postings are strictly positive: a zero fee (or a sale entirely consumed by fees) omits that line.
      CASE WHEN v_net > 0 THEN jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(v.agent_id, 'agent_cash'), 'side', 'D', 'amount', v_net)) ELSE '[]'::jsonb END
      || CASE WHEN t.fee_minor > 0 THEN jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(v.agent_id, 'agent_fees'), 'side', 'D', 'amount', t.fee_minor)) ELSE '[]'::jsonb END
      || jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(v.agent_id, 'agent_revenue'), 'side', 'C', 'amount', t.gross_minor)));
    INSERT INTO fleet_venture_journals (journal_id, venture_id, agent_id, cost_category, attributed_by) VALUES (v_j, p_venture, v.agent_id, 'revenue', p_actor);
    INSERT INTO fleet_revenue_provenance (journal_id, agent_id, provenance, counterparty_sha256, recorded_by)
      VALUES (v_j, v.agent_id, 'external_customer_revenue', COALESCE(t.counterparty_sha256, encode(sha256(convert_to(v_ref, 'UTF8')), 'hex')), p_actor);
    -- Tax: reserved at once from the sale's own net cash (restricted: never spendable).
    v_tax := fleet_tax_for_sale(fleet_venture_entity(p_venture), t.gross_minor, t.fee_minor);
    v_reserve := LEAST((v_tax ->> 'totalMinor')::bigint, v_net);
    IF v_reserve > 0 THEN
      v_tj := fleet_ledger_post('tax_reservation', 'tax:' || t.txn_id, p_actor, 'tax reserve for a settled sale', 'controller', v.agent_id, NULL, NULL, NULL, NULL, t.occurred_at,
        jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(v.agent_id, 'agent_tax_reserve'), 'side', 'D', 'amount', v_reserve),
                          jsonb_build_object('account', fleet_ledger_account(v.agent_id, 'agent_cash'), 'side', 'C', 'amount', v_reserve)));
      INSERT INTO fleet_venture_journals (journal_id, venture_id, agent_id, cost_category, attributed_by) VALUES (v_tj, p_venture, v.agent_id, 'tax', p_actor);
    END IF;
  ELSE
    -- Refund: the tax reserved for the refunded value is released first (it is no longer owed), then the customer is repaid.
    v_tax := fleet_tax_for_sale(fleet_venture_entity(p_venture), t.gross_minor, 0);
    v_release := LEAST((v_tax ->> 'totalMinor')::bigint, fleet_ledger_balance(fleet_ledger_account(v.agent_id, 'agent_tax_reserve')));
    IF v_release > 0 THEN
      v_tj := fleet_ledger_post('tax_reserve_release', 'taxrel:' || t.txn_id, p_actor, 'tax reserve released for a refund', 'controller', v.agent_id, NULL, NULL, NULL, NULL, t.occurred_at,
        jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(v.agent_id, 'agent_cash'), 'side', 'D', 'amount', v_release),
                          jsonb_build_object('account', fleet_ledger_account(v.agent_id, 'agent_tax_reserve'), 'side', 'C', 'amount', v_release)));
      INSERT INTO fleet_venture_journals (journal_id, venture_id, agent_id, cost_category, attributed_by) VALUES (v_tj, p_venture, v.agent_id, 'tax', p_actor);
    END IF;
    v_j := fleet_ledger_post('external_refund', 'settle:' || t.txn_id, p_actor, 'customer refund on a Fleet rail', 'controller', v.agent_id, NULL, NULL, v_ref, NULL, t.occurred_at,
      jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(v.agent_id, 'agent_revenue'), 'side', 'D', 'amount', t.gross_minor),
                        jsonb_build_object('account', fleet_ledger_account(v.agent_id, 'agent_cash'), 'side', 'C', 'amount', t.gross_minor)));
    INSERT INTO fleet_venture_journals (journal_id, venture_id, agent_id, cost_category, attributed_by) VALUES (v_j, p_venture, v.agent_id, 'refund', p_actor);
    INSERT INTO fleet_revenue_provenance (journal_id, agent_id, provenance, counterparty_sha256, recorded_by)
      VALUES (v_j, v.agent_id, 'refund', COALESCE(t.counterparty_sha256, encode(sha256(convert_to(v_ref, 'UTF8')), 'hex')), p_actor);
  END IF;
  UPDATE fleet_external_transactions SET status = 'settled', status_reason = NULL, venture_id = p_venture, agent_id = v.agent_id, journal_id = v_j,
         tax_journal_id = v_tj, tax = v_tax, settled_at = now()
   WHERE txn_id = t.txn_id RETURNING * INTO out;
  UPDATE fleet_payment_rails SET last_settlement_at = now() WHERE rail_id = t.rail_id;
  PERFORM fleet_event('settlement_' || t.kind, v.agent_id, p_actor, jsonb_build_object('txnId', t.txn_id, 'ventureId', p_venture, 'grossMinor', t.gross_minor,
    'feeMinor', t.fee_minor, 'taxMinor', COALESCE((v_tax ->> 'totalMinor')::bigint, 0), 'journalId', v_j));
  RETURN out;
END $$;

-- FleetController's rail adapter reports an external transaction (provider webhook / poll; simulated or sandbox rails only).
CREATE FUNCTION svc_settlement_ingest(p_rail uuid, p_external_id text, p_kind text, p_gross bigint, p_fee bigint, p_currency text, p_venture uuid,
  p_occurred timestamptz, p_payload_sha256 text, p_counterparty_sha256 text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_payment_rails; t fleet_external_transactions; v_venture uuid; v_reason text; v_acct text;
BEGIN
  SELECT * INTO r FROM fleet_payment_rails WHERE rail_id = p_rail;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_RAIL_UNKNOWN'); END IF;
  IF p_external_id IS NULL OR p_external_id !~ '^[A-Za-z0-9:_./-]{3,120}$' OR p_kind NOT IN ('sale','refund') OR p_gross IS NULL OR p_gross <= 0
     OR p_gross > 100000000000 OR COALESCE(p_fee, 0) < 0 OR COALESCE(p_fee, 0) > p_gross OR p_currency !~ '^[A-Z]{3}$'
     OR p_payload_sha256 !~ '^[0-9a-f]{64}$' OR (p_counterparty_sha256 IS NOT NULL AND p_counterparty_sha256 !~ '^[0-9a-f]{64}$') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  -- Idempotency: the same (rail, external id, kind) never records money twice; a different payload is a conflict.
  SELECT * INTO t FROM fleet_external_transactions WHERE rail_id = p_rail AND external_id = p_external_id AND kind = p_kind;
  IF FOUND THEN
    IF t.payload_sha256 <> p_payload_sha256 OR t.gross_minor <> p_gross OR t.fee_minor <> COALESCE(p_fee, 0) THEN
      PERFORM fleet_event('settlement_conflict', t.agent_id, 'controller', jsonb_build_object('txnId', t.txn_id, 'railId', p_rail, 'externalId', p_external_id));
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_SETTLEMENT_CONFLICT', 'txnId', t.txn_id);
    END IF;
    RETURN jsonb_build_object('ok', true, 'replay', true, 'txnId', t.txn_id, 'status', t.status);
  END IF;
  SELECT accounting_currency INTO v_acct FROM fleet_economic_model WHERE id = 1;
  -- Attribution: the venture a live assignment of this rail names (dedicated: its venture; shared: the reported venture).
  IF r.rail_kind = 'dedicated' THEN v_venture := r.dedicated_venture_id;
  ELSIF p_venture IS NOT NULL AND EXISTS (SELECT 1 FROM fleet_rail_assignments WHERE rail_id = p_rail AND venture_id = p_venture AND released_at IS NULL) THEN
    v_venture := p_venture;
  END IF;
  v_reason := CASE WHEN r.status NOT IN ('active','degraded') THEN 'rail not in service: ' || r.status
                   WHEN p_currency <> v_acct THEN format('currency %s is not the accounting currency %s (FX conversion required)', p_currency, v_acct)
                   WHEN v_venture IS NULL THEN 'no venture assignment on this rail matches the transaction'
                   WHEN (SELECT state FROM fleet_ventures WHERE venture_id = v_venture) = 'closed' THEN 'the venture is closed' END;
  INSERT INTO fleet_external_transactions (txn_id, rail_id, external_id, kind, gross_minor, fee_minor, currency, venture_id, agent_id, status, status_reason,
      payload_sha256, counterparty_sha256, occurred_at)
    VALUES (gen_random_uuid(), p_rail, p_external_id, p_kind, p_gross, COALESCE(p_fee, 0), p_currency, v_venture,
            (SELECT agent_id FROM fleet_ventures WHERE venture_id = v_venture), 'unattributed', v_reason, p_payload_sha256, p_counterparty_sha256,
            LEAST(COALESCE(p_occurred, now()), now()))
    RETURNING * INTO t;
  IF v_reason IS NOT NULL THEN
    PERFORM fleet_event('settlement_unattributed', t.agent_id, 'controller', jsonb_build_object('txnId', t.txn_id, 'reason', v_reason, 'grossMinor', p_gross));
    RETURN jsonb_build_object('ok', true, 'txnId', t.txn_id, 'status', 'unattributed', 'reason', v_reason);
  END IF;
  BEGIN
    t := fleet_settlement_post(t, v_venture, 'controller');
  EXCEPTION WHEN raise_exception OR check_violation THEN
    -- e.g. a refund larger than the agent's cash: recorded, never half-posted, visible to reconciliation.
    UPDATE fleet_external_transactions SET status = 'failed', status_reason = left('settlement failed: ' || SQLERRM, 300) WHERE txn_id = t.txn_id RETURNING * INTO t;
    PERFORM fleet_event('settlement_failed', t.agent_id, 'controller', jsonb_build_object('txnId', t.txn_id, 'reason', left(SQLERRM, 200)));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_SETTLEMENT_FAILED', 'txnId', t.txn_id, 'status', 'failed');
  END;
  RETURN jsonb_build_object('ok', true, 'txnId', t.txn_id, 'status', t.status, 'journalId', t.journal_id, 'tax', t.tax);
END $$;

-- The owner attributes an orphan (unattributed / failed) transaction once the facts are known (audited).
CREATE FUNCTION fleet_admin_settlement_attribute(p_txn uuid, p_venture uuid, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE t fleet_external_transactions; v_acct text;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  SELECT * INTO t FROM fleet_external_transactions WHERE txn_id = p_txn FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such transaction'; END IF;
  IF t.status = 'settled' THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'journalId', t.journal_id); END IF;
  SELECT accounting_currency INTO v_acct FROM fleet_economic_model WHERE id = 1;
  IF t.currency <> v_acct THEN RAISE EXCEPTION 'FLEET_FX_REQUIRED: convert to the accounting currency first'; END IF;
  t := fleet_settlement_post(t, p_venture, p_actor);
  RETURN jsonb_build_object('ok', true, 'txnId', t.txn_id, 'journalId', t.journal_id, 'tax', t.tax);
END $$;

-- ═══ 7. Tax true-up (FleetController; the reserve follows the estimated liability, never below it) ═══
-- Liability estimate per agent = Σ vat/sales tax of settled sales (net of refunds) + profit/other-tax rates of the
-- default entity × max(0, realized net profit − vat − sales tax). Over-reserve is released; under-reserve is topped up from
-- cash as far as cash allows (the shortfall is reported). Tax paid counts toward the liability.
CREATE FUNCTION fleet_tax_true_up(p_agent text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_indirect bigint; v_profit bigint; v_target bigint; v_have bigint; v_paid bigint; v_delta bigint; v_cash bigint; v_rate integer := 0; pr fleet_tax_profiles;
        eco jsonb; v_entities integer; v_j uuid; v_moved bigint := 0; v_fallback boolean := false;
BEGIN
  SELECT count(DISTINCT fleet_venture_entity(venture_id)) INTO v_entities FROM fleet_external_transactions WHERE agent_id = p_agent AND status = 'settled';
  IF v_entities > 1 THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_TAX_MULTI_ENTITY', 'reason', 'per-entity true-up is required (ventures in several legal entities)'); END IF;
  SELECT COALESCE(sum(CASE WHEN kind = 'sale' THEN 1 ELSE -1 END * ((tax ->> 'vatMinor')::bigint + (tax ->> 'salesTaxMinor')::bigint)), 0),
         bool_or((tax ->> 'fallback')::boolean)
    INTO v_indirect, v_fallback FROM fleet_external_transactions WHERE agent_id = p_agent AND status = 'settled';
  pr := fleet_tax_profile_active((SELECT fleet_venture_entity(venture_id) FROM fleet_external_transactions WHERE agent_id = p_agent AND status = 'settled' LIMIT 1));
  IF pr.profile_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'skipped', true, 'reason', 'no active tax profile: the conservative fallback reserve stays in place');
  END IF;
  SELECT COALESCE(sum((x ->> 'rateBp')::integer), 0) INTO v_rate FROM jsonb_array_elements(pr.rules) x WHERE x ->> 'taxKind' IN ('profit','other');
  eco := fleet_agent_economics(p_agent);
  v_profit := fleet_ceil_bp(GREATEST((eco ->> 'realizedNetProfit')::bigint - GREATEST(v_indirect, 0), 0), v_rate);
  v_target := GREATEST(v_indirect, 0) + v_profit;
  v_have := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_tax_reserve'));
  v_paid := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_tax_expense'));
  v_delta := v_target - v_have - v_paid;
  v_cash := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_cash'));
  IF v_delta > 0 AND v_cash > 0 THEN
    v_moved := LEAST(v_delta, v_cash);
    v_j := fleet_ledger_post('tax_reservation', 'taxup:' || p_agent || ':' || gen_random_uuid(), p_actor, 'tax true-up (reserve)', 'controller', p_agent, NULL, NULL, NULL, NULL, now(),
      jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_tax_reserve'), 'side', 'D', 'amount', v_moved),
                        jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_cash'), 'side', 'C', 'amount', v_moved)));
  ELSIF v_delta < 0 AND NOT COALESCE(v_fallback, false) THEN
    v_moved := -LEAST(-v_delta, v_have);
    IF v_moved < 0 THEN
      v_j := fleet_ledger_post('tax_reserve_release', 'taxup:' || p_agent || ':' || gen_random_uuid(), p_actor, 'tax true-up (release)', 'controller', p_agent, NULL, NULL, NULL, NULL, now(),
        jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_cash'), 'side', 'D', 'amount', -v_moved),
                          jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_tax_reserve'), 'side', 'C', 'amount', -v_moved)));
    END IF;
  END IF;
  PERFORM fleet_event('tax_true_up', p_agent, p_actor, jsonb_build_object('targetMinor', v_target, 'reservedBefore', v_have, 'paid', v_paid, 'movedMinor', v_moved));
  RETURN jsonb_build_object('ok', true, 'liabilityMinor', v_target, 'indirectMinor', GREATEST(v_indirect, 0), 'profitTaxMinor', v_profit,
    'reservedMinor', v_have + GREATEST(v_moved, 0) + LEAST(v_moved, 0), 'paidMinor', v_paid, 'movedMinor', v_moved,
    'shortfallMinor', GREATEST(v_delta - GREATEST(v_moved, 0), 0) * (CASE WHEN v_delta > 0 THEN 1 ELSE 0 END), 'journalId', v_j);
END $$;

CREATE FUNCTION fleet_admin_tax_payment(p_agent text, p_amount bigint, p_external_ref text, p_actor text, p_idem text) RETURNS uuid LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  RETURN fleet_ledger_post('tax_payment', p_idem, p_actor, 'tax paid to the authority from the reserve', 'owner', p_agent, NULL, NULL, p_external_ref, NULL, now(),
    jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_tax_expense'), 'side', 'D', 'amount', p_amount),
                      jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_tax_reserve'), 'side', 'C', 'amount', p_amount)));
END $$;

-- ═══ 8. Wallet, safe transfer ═══
CREATE TABLE fleet_transfer_policy (
  id            smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  cushion_bp    integer     NOT NULL DEFAULT 1000 CHECK (cushion_bp BETWEEN 0 AND 10000),
  horizon_days  integer     NOT NULL DEFAULT 30 CHECK (horizon_days BETWEEN 0 AND 365),
  burn_window_days integer  NOT NULL DEFAULT 30 CHECK (burn_window_days BETWEEN 1 AND 365),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text        NOT NULL DEFAULT 'migration'
);
INSERT INTO fleet_transfer_policy (id) VALUES (1);
COMMENT ON TABLE fleet_transfer_policy IS 'Safe-transfer policy (configurable): cushion = protected share of the agent''s own cash; horizon = projected operating cost kept back.';
CREATE TRIGGER fleet_transfer_policy_no_delete BEFORE DELETE ON fleet_transfer_policy FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_transfer_policy_no_truncate BEFORE TRUNCATE ON fleet_transfer_policy FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- The agent's own stated needs (its runway target and growth reserve): respected by the safe-transfer calculation.
CREATE TABLE fleet_agent_wallet_plans (
  seq                  bigserial   PRIMARY KEY,
  agent_id             text        NOT NULL REFERENCES fleet_agents(agent_id),
  runway_days_target   integer     CHECK (runway_days_target BETWEEN 0 AND 3650),
  growth_reserve_minor bigint      CHECK (growth_reserve_minor BETWEEN 0 AND 100000000000),
  note                 text        CHECK (length(note) <= 300),
  at                   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_agent_wallet_plans_agent ON fleet_agent_wallet_plans (agent_id, seq DESC);
CREATE TRIGGER fleet_agent_wallet_plans_no_change BEFORE UPDATE OR DELETE ON fleet_agent_wallet_plans FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_agent_wallet_plans_no_truncate BEFORE TRUNCATE ON fleet_agent_wallet_plans FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- Daily operating burn (inference, expenses, fees) over the policy window, in minor units per day (integer, rounded up).
CREATE FUNCTION fleet_agent_burn_per_day(p_agent text) RETURNS bigint LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  -- sum(bigint) is numeric: cast back before the integer ceiling division (never fractional money).
  SELECT (COALESCE(sum(CASE WHEN po.side = 'D' THEN po.amount_cents ELSE -po.amount_cents END), 0)::bigint + w.d - 1) / w.d
    FROM (SELECT burn_window_days AS d FROM fleet_transfer_policy WHERE id = 1) w
    LEFT JOIN fleet_ledger_journal j ON j.agent_id = p_agent AND j.occurred_at > now() - make_interval(days => w.d)
    LEFT JOIN fleet_ledger_postings po ON po.journal_id = j.journal_id
         AND po.account_id IN (fleet_ledger_account(p_agent, 'agent_expense'), fleet_ledger_account(p_agent, 'agent_fees'))
   GROUP BY w.d
$$;

-- The maximum amount safely transferable out of an agent's wallet (Treasury / operating pool), with its derivation.
CREATE FUNCTION fleet_safe_transfer_amount(p_agent text) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_transfer_policy; eco jsonb; v_cash bigint; v_avail bigint; v_burn bigint; v_proj bigint; v_cushion bigint; v_commit bigint; v_plan fleet_agent_wallet_plans;
        v_growth bigint; v_runway bigint; v_safe bigint;
BEGIN
  SELECT * INTO p FROM fleet_transfer_policy WHERE id = 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('safeTransferableMinor', 0, 'reason', 'transfer policy missing (fail closed)'); END IF;
  eco := fleet_agent_economics(p_agent);
  v_cash := (eco ->> 'cash')::bigint;
  v_avail := (eco ->> 'expensePurchasingCapacity')::bigint;           -- own cash net of protected principal/obligations (tax reserve is already out of cash)
  v_burn := COALESCE(fleet_agent_burn_per_day(p_agent), 0);
  v_proj := v_burn * p.horizon_days;                                   -- projected operating cost kept back
  v_cushion := fleet_ceil_bp(v_cash, p.cushion_bp);                    -- protected cushion (configurable share of own cash)
  -- Open commitments: capital the agent has exposed under decisions not yet measured (its own sizing).
  SELECT COALESCE(sum(capital_exposed_minor), 0) INTO v_commit FROM (
    SELECT DISTINCT ON (decision_key) capital_exposed_minor, outcome_status FROM fleet_decision_records WHERE agent_id = p_agent ORDER BY decision_key, revision DESC) d
   WHERE outcome_status = 'pending';
  SELECT * INTO v_plan FROM fleet_agent_wallet_plans WHERE agent_id = p_agent ORDER BY seq DESC LIMIT 1;
  v_growth := LEAST(COALESCE(v_plan.growth_reserve_minor, 0), v_avail);
  v_runway := v_burn * COALESCE(v_plan.runway_days_target, 0);         -- the agent's own runway target
  v_safe := GREATEST(0, v_avail - GREATEST(v_proj, v_runway) - v_cushion - v_commit - v_growth);
  RETURN jsonb_build_object('safeTransferableMinor', v_safe, 'availableMinor', v_avail, 'burnPerDayMinor', v_burn, 'projectedCostsMinor', v_proj,
    'agentRunwayTargetMinor', v_runway, 'cushionMinor', v_cushion, 'cushionBp', p.cushion_bp, 'commitmentsMinor', v_commit, 'growthReserveMinor', v_growth,
    'horizonDays', p.horizon_days, 'note', 'expected revenue never increases the safe amount (conservative)');
END $$;

CREATE FUNCTION fleet_admin_wallet_transfer(p_agent text, p_amount bigint, p_target text, p_reason text, p_actor text, p_idem text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE s jsonb; v_j uuid; a fleet_agents;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');
  IF p_target NOT IN ('treasury','operating_pool') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: target is treasury or operating_pool'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: positive amount required'; END IF;
  IF p_reason IS NULL OR length(p_reason) NOT BETWEEN 3 AND 300 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a reason is required'; END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such agent'; END IF;
  PERFORM 1 FROM fleet_ledger_accounts WHERE account_id = fleet_ledger_account(p_agent, 'agent_cash') FOR UPDATE;
  IF EXISTS (SELECT 1 FROM fleet_ledger_journal WHERE idempotency_key = p_idem) THEN
    RETURN jsonb_build_object('ok', true, 'replay', true, 'journalId', (SELECT journal_id FROM fleet_ledger_journal WHERE idempotency_key = p_idem));
  END IF;
  s := fleet_safe_transfer_amount(p_agent);
  IF p_amount > (s ->> 'safeTransferableMinor')::bigint THEN
    RAISE EXCEPTION 'FLEET_TRANSFER_EXCEEDS_SAFE: % exceeds the safely transferable % (operating needs, commitments, tax and cushion are protected)',
      p_amount, s ->> 'safeTransferableMinor';
  END IF;
  IF p_target = 'treasury' THEN
    v_j := fleet_ledger_post('agent_capital_return', p_idem, p_actor, left('safe transfer to the Treasury: ' || p_reason, 200), 'owner', p_agent, NULL, NULL, NULL, NULL, now(),
      jsonb_build_array(jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', p_amount),
                        jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_cash'), 'side', 'C', 'amount', p_amount)));
  ELSE
    v_j := fleet_ledger_post('operating_transfer', p_idem, p_actor, left('safe transfer to the operating pool: ' || p_reason, 200), 'owner', p_agent, NULL, NULL, NULL, NULL, now(),
      jsonb_build_array(jsonb_build_object('account', 'fleet:operating:pool', 'side', 'D', 'amount', p_amount),
                        jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_cash'), 'side', 'C', 'amount', p_amount)));
  END IF;
  PERFORM fleet_event('wallet_transfer', p_agent, p_actor, jsonb_build_object('target', p_target, 'amountMinor', p_amount, 'journalId', v_j,
    'safeTransferableMinor', s ->> 'safeTransferableMinor'));
  RETURN jsonb_build_object('ok', true, 'journalId', v_j, 'safe', s);
END $$;

-- The agent wallet (admin dashboard and the agent's own view). Figures only; nothing here permits or limits anything.
CREATE FUNCTION fleet_agent_wallet(p_agent text) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE eco jsonb; v_tax bigint; v_tax_paid bigint; v_env bigint; v_tax_oblig bigint; v_pending bigint; v_rev30 bigint; v_ref30 bigint; v_inf30 bigint;
        v_op30 bigint; v_burn bigint; s jsonb; v_alloc jsonb;
BEGIN
  eco := fleet_agent_economics(p_agent);
  v_tax := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_tax_reserve'));
  v_tax_paid := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_tax_expense'));
  v_env := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_envelope_cash'));
  SELECT COALESCE(sum(amount_cents), 0) INTO v_tax_oblig FROM fleet_obligations WHERE agent_id = p_agent AND status = 'approved' AND category = 'tax_reserve';
  SELECT COALESCE(sum(gross_minor) FILTER (WHERE kind = 'sale'), 0) INTO v_pending FROM fleet_external_transactions WHERE agent_id = p_agent AND status <> 'settled';
  SELECT COALESCE(sum(CASE WHEN po.side = 'C' THEN po.amount_cents ELSE -po.amount_cents END) FILTER (WHERE ac.class = 'agent_revenue' AND j.kind <> 'external_refund'), 0),
         COALESCE(sum(CASE WHEN po.side = 'D' THEN po.amount_cents ELSE -po.amount_cents END) FILTER (WHERE ac.class = 'agent_revenue' AND j.kind = 'external_refund'), 0),
         COALESCE(sum(CASE WHEN po.side = 'D' THEN po.amount_cents ELSE -po.amount_cents END) FILTER (WHERE ac.class = 'agent_expense' AND j.kind = 'inference_charge'), 0),
         COALESCE(sum(CASE WHEN po.side = 'D' THEN po.amount_cents ELSE -po.amount_cents END) FILTER (WHERE ac.class IN ('agent_expense','agent_fees') AND j.kind <> 'inference_charge'), 0)
    INTO v_rev30, v_ref30, v_inf30, v_op30
    FROM fleet_ledger_journal j JOIN fleet_ledger_postings po ON po.journal_id = j.journal_id JOIN fleet_ledger_accounts ac ON ac.account_id = po.account_id
   WHERE j.agent_id = p_agent AND ac.agent_id = p_agent AND j.occurred_at > now() - interval '30 days';
  v_burn := COALESCE(fleet_agent_burn_per_day(p_agent), 0);
  s := fleet_safe_transfer_amount(p_agent);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('venture', v.venture_key, 'state', v.state, 'capitalDeployedMinor', (f ->> 'capitalDeployedMinor')::bigint,
           'netProfitMinor', (f ->> 'netProfitMinor')::bigint, 'taxReservedMinor', (f ->> 'taxReservedMinor')::bigint) ORDER BY v.updated_at DESC), '[]'::jsonb)
    INTO v_alloc FROM (SELECT v.*, fleet_venture_financials(v.venture_id) AS f FROM fleet_ventures v WHERE v.agent_id = p_agent AND v.state <> 'closed') v;
  RETURN jsonb_build_object(
    'agentId', p_agent, 'currency', (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1),
    'cashHeldMinor', (eco ->> 'cash')::bigint + (eco ->> 'reserved')::bigint + v_tax + v_env,
    'economicBalanceMinor', (eco ->> 'survivalEquity')::bigint,
    'availableMinor', (eco ->> 'expensePurchasingCapacity')::bigint,
    'committedMinor', (eco ->> 'reserved')::bigint,
    'restrictedMinor', v_tax + v_env + (eco ->> 'protectedPrincipal')::bigint + (eco ->> 'protectedObligations')::bigint,
    'restricted', jsonb_build_object('taxReserveMinor', v_tax, 'taxReserveObligationsMinor', v_tax_oblig, 'envelopeCapitalMinor', v_env,
                   'protectedPrincipalMinor', (eco ->> 'protectedPrincipal')::bigint, 'protectedObligationsMinor', (eco ->> 'protectedObligations')::bigint),
    'taxReserveMinor', v_tax, 'taxPaidMinor', v_tax_paid,
    'ventureAllocations', v_alloc,
    'last30d', jsonb_build_object('revenueMinor', v_rev30, 'refundsMinor', v_ref30, 'inferenceMinor', v_inf30, 'operatingCostsMinor', v_op30),
    'pendingSettlementMinor', v_pending,
    'lifetime', jsonb_build_object('revenueMinor', (eco ->> 'externalCustomerRevenue')::bigint, 'expensesMinor', (eco ->> 'expenses')::bigint,
                   'feesMinor', (eco ->> 'fees')::bigint, 'netProfitMinor', (eco ->> 'realizedNetProfit')::bigint),
    'retainedEarningsMinor', (eco ->> 'realizedNetProfit')::bigint - (eco ->> 'lifetimeContribution')::bigint - v_tax - v_tax_paid,
    'treasuryContributionsMinor', (eco ->> 'lifetimeContribution')::bigint,
    'runway', jsonb_build_object('burnPerDayMinor', v_burn,
                 'days', CASE WHEN v_burn > 0 THEN (eco ->> 'expensePurchasingCapacity')::bigint / v_burn END,
                 'note', 'figures for the agent''s own judgement; FleetController sets no runway rule'),
    'safeTransfer', s);
END $$;

-- ═══ 9. Agent operations (through api_economy) ═══
CREATE FUNCTION fleet_econ_rail_require(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v fleet_ventures; q fleet_rail_requirements; v_cap text := COALESCE(fleet_econ_text(a, 'capability', 30), 'receive_payments');
        v_pref text := COALESCE(fleet_econ_text(a, 'preference', 20), 'any'); v_provider text := lower(fleet_econ_text(a, 'provider', 30)); r fleet_payment_rails;
BEGIN
  SELECT * INTO v FROM fleet_ventures WHERE agent_id = p_agent AND venture_key = fleet_econ_key(a, 'ventureKey');
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND', 'reason', 'no such venture of yours'); END IF;
  IF v_cap NOT IN ('receive_payments','refunds','payouts','card_spend','bank_transfer','marketplace_listing','subscriptions','storefront') THEN
    PERFORM fleet_econ_bad('capability is receive_payments, refunds, payouts, card_spend, bank_transfer, marketplace_listing, subscriptions or storefront');
  END IF;
  IF v_pref NOT IN ('any','shared','dedicated') THEN PERFORM fleet_econ_bad('preference is any, shared or dedicated'); END IF;
  SELECT * INTO q FROM fleet_rail_requirements WHERE venture_id = v.venture_id AND capability = v_cap AND status IN ('open','dependency','assigned')
     AND (assignment_id IS NULL OR EXISTS (SELECT 1 FROM fleet_rail_assignments x WHERE x.assignment_id = fleet_rail_requirements.assignment_id AND x.released_at IS NULL))
   ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO fleet_rail_requirements (requirement_id, venture_id, agent_id, capability, preference, provider)
      VALUES (gen_random_uuid(), v.venture_id, p_agent, v_cap, v_pref, v_provider) RETURNING * INTO q;
    PERFORM fleet_event('payment_rail_required', p_agent, p_agent, jsonb_build_object('venture', v.venture_key, 'capability', v_cap, 'provider', v_provider));
  END IF;
  q := fleet_rail_resolve(q, 'controller');
  IF q.status = 'assigned' THEN
    SELECT r2.* INTO r FROM fleet_rail_assignments x JOIN fleet_payment_rails r2 ON r2.rail_id = x.rail_id WHERE x.assignment_id = q.assignment_id;
    RETURN jsonb_build_object('ok', true, 'status', 'assigned', 'rail', fleet_rail_json(r) - 'railId');
  END IF;
  RETURN jsonb_build_object('ok', true, 'status', q.status, 'dependencyRecorded', q.dependency_id IS NOT NULL,
    'note', 'No compatible Fleet rail is available for this action yet. Only this action waits: sell through another channel, a direct storefront or another provider meanwhile.');
END $$;

CREATE FUNCTION fleet_econ_wallet_plan(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  INSERT INTO fleet_agent_wallet_plans (agent_id, runway_days_target, growth_reserve_minor, note)
    VALUES (p_agent, fleet_econ_int(a, 'runwayDaysTarget', 0, 3650)::integer, fleet_econ_int(a, 'growthReserveMinor', 0, 100000000000), fleet_econ_text(a, 'note', 300));
  RETURN jsonb_build_object('ok', true, 'note', 'Your own plan: FleetController keeps it back from any transfer out of your wallet.');
END $$;

-- api_economy gains the v29 operations (same authentication, capability mapping and error contract).
CREATE OR REPLACE FUNCTION api_economy(p_agent text, p_token text, p_op text, p_args jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text; v_class text; a jsonb := COALESCE(p_args, '{}'::jsonb);
BEGIN
  v_class := CASE p_op
    WHEN 'opportunity.record' THEN 'planning' WHEN 'opportunity.shortlist' THEN 'planning' WHEN 'opportunity.status' THEN 'planning'
    WHEN 'opportunity.list' THEN 'planning'
    WHEN 'venture.create' THEN 'planning' WHEN 'venture.transition' THEN 'planning' WHEN 'venture.status' THEN 'planning'
    WHEN 'venture.list' THEN 'planning' WHEN 'venture.metric' THEN 'planning'
    WHEN 'decision.record' THEN 'planning' WHEN 'decision.outcome' THEN 'planning' WHEN 'decision.correct' THEN 'planning'
    WHEN 'decision.list' THEN 'planning'
    WHEN 'knowledge.record' THEN 'planning' WHEN 'knowledge.search' THEN 'knowledge.read'
    WHEN 'performance' THEN 'ledger.read'
    WHEN 'wallet' THEN 'ledger.read' WHEN 'wallet.plan' THEN 'ledger.read'
    WHEN 'rail.require' THEN 'spend.request' WHEN 'vendor.register' THEN 'spend.request' WHEN 'vendor.revoke' THEN 'spend.request'
    WHEN 'vendor.list' THEN 'spend.request'
  END;
  IF v_class IS NULL OR p_op IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_UNKNOWN_OPERATION'); END IF;
  v_code := fleet_authenticate(p_agent, p_token, 'economy:' || p_op);
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_code); END IF;
  IF NOT fleet_agent_can(p_agent, v_class) THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CAPABILITY_DENIED'); END IF;
  IF jsonb_typeof(a) <> 'object' OR length(a::text) > 32000 THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'arguments are a JSON object (<= 32 kB)'); END IF;
  BEGIN
    RETURN CASE p_op
      WHEN 'opportunity.record' THEN fleet_econ_opportunity_record(p_agent, a)
      WHEN 'opportunity.shortlist' THEN fleet_econ_opportunity_shortlist(p_agent, a)
      WHEN 'opportunity.status' THEN fleet_econ_opportunity_status(p_agent, a)
      WHEN 'opportunity.list' THEN fleet_econ_opportunity_list(p_agent, a)
      WHEN 'venture.create' THEN fleet_econ_venture_create(p_agent, a)
      WHEN 'venture.transition' THEN fleet_econ_venture_transition(p_agent, a)
      WHEN 'venture.status' THEN (SELECT CASE WHEN v.venture_id IS NULL THEN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND')
                                              ELSE jsonb_build_object('ok', true, 'venture', fleet_venture_json(v, true)) END
                                    FROM (SELECT 1) one LEFT JOIN fleet_ventures v ON v.agent_id = p_agent AND v.venture_key = fleet_econ_key(a, 'key'))
      WHEN 'venture.list' THEN jsonb_build_object('ok', true, 'ventures', COALESCE((SELECT jsonb_agg(fleet_venture_json(v) ORDER BY v.updated_at DESC)
                                 FROM fleet_ventures v WHERE v.agent_id = p_agent AND (COALESCE((a ->> 'includeClosed')::boolean, false) OR v.state NOT IN ('closed'))), '[]'::jsonb))
      WHEN 'venture.metric' THEN fleet_econ_venture_metric(p_agent, a)
      WHEN 'decision.record' THEN fleet_econ_decision_record(p_agent, a)
      WHEN 'decision.outcome' THEN fleet_econ_decision_outcome(p_agent, a)
      WHEN 'decision.correct' THEN fleet_econ_decision_correct(p_agent, a)
      WHEN 'decision.list' THEN fleet_econ_decision_list(p_agent, a)
      WHEN 'knowledge.record' THEN fleet_econ_knowledge_record(p_agent, a)
      WHEN 'knowledge.search' THEN fleet_econ_knowledge_search(p_agent, a)
      WHEN 'performance' THEN jsonb_build_object('ok', true, 'performance', fleet_agent_performance(p_agent))
      WHEN 'wallet' THEN jsonb_build_object('ok', true, 'wallet', fleet_agent_wallet(p_agent))
      WHEN 'wallet.plan' THEN fleet_econ_wallet_plan(p_agent, a)
      WHEN 'rail.require' THEN fleet_econ_rail_require(p_agent, a)
      WHEN 'vendor.register' THEN fleet_econ_vendor_register(p_agent, a)
      WHEN 'vendor.revoke' THEN fleet_econ_vendor_revoke(p_agent, a)
      WHEN 'vendor.list' THEN jsonb_build_object('ok', true, 'vendors', COALESCE((SELECT jsonb_agg(jsonb_build_object('destinationId', v.destination_id,
                                 'vendor', v.vendor_name, 'category', v.category, 'status', d.status, 'trust', v.trust, 'hint', d.reference_hint) ORDER BY v.registered_at DESC)
                                 FROM fleet_vendor_destinations v JOIN fleet_payment_destinations d ON d.destination_id = v.destination_id
                                WHERE v.agent_id = p_agent AND d.status <> 'revoked'), '[]'::jsonb))
    END;
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM ~ '^FLEET_(BAD_REQUEST|INFRASTRUCTURE_CEILING|VENTURE_[A-Z]+|IMMUTABLE|INVALID_STATE|ATTRIBUTION_SCOPE):' THEN
        IF SQLERRM ~ '^FLEET_INFRASTRUCTURE_CEILING:' THEN
          PERFORM fleet_event('economy_failsafe', p_agent, 'controller', jsonb_build_object('op', p_op));
        END IF;
        RETURN jsonb_build_object('ok', false, 'code', split_part(SQLERRM, ':', 1), 'reason', btrim(substr(SQLERRM, position(':' IN SQLERRM) + 1)));
      END IF;
      RAISE;
    WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'a value has the wrong format');
  END;
END $$;

-- ═══ 10. Reconciliation: external provider ↔ transaction ↔ venture ↔ agent wallet ↔ Treasury ═══
CREATE FUNCTION fleet_reconcile() RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE f jsonb := '[]'::jsonb; v jsonb; n bigint; amt bigint; r record;
BEGIN
  -- Ledger: hash chain and balances.
  v := fleet_ledger_verify();
  f := f || jsonb_build_array(jsonb_build_object('severity', CASE WHEN (v ->> 'ok')::boolean THEN 'INFO' ELSE 'FAIL' END, 'code', 'LEDGER_VERIFY', 'detail', v));
  -- Orphan money: received but not attributed; settlement failures.
  SELECT count(*), COALESCE(sum(gross_minor), 0) INTO n, amt FROM fleet_external_transactions WHERE status = 'unattributed';
  IF n > 0 THEN f := f || jsonb_build_array(jsonb_build_object('severity', 'WARN', 'code', 'UNATTRIBUTED_TRANSACTIONS', 'detail', jsonb_build_object('count', n, 'grossMinor', amt))); END IF;
  SELECT count(*), COALESCE(sum(gross_minor), 0) INTO n, amt FROM fleet_external_transactions WHERE status = 'unattributed' AND received_at < now() - interval '3 days';
  IF n > 0 THEN f := f || jsonb_build_array(jsonb_build_object('severity', 'FAIL', 'code', 'STALE_UNATTRIBUTED', 'detail', jsonb_build_object('count', n, 'grossMinor', amt))); END IF;
  SELECT count(*) INTO n FROM fleet_external_transactions WHERE status = 'failed';
  IF n > 0 THEN f := f || jsonb_build_array(jsonb_build_object('severity', 'FAIL', 'code', 'SETTLEMENT_FAILED', 'detail', jsonb_build_object('count', n))); END IF;
  SELECT count(*) INTO n FROM fleet_events WHERE event_type = 'settlement_conflict' AND created_at > now() - interval '30 days';
  IF n > 0 THEN f := f || jsonb_build_array(jsonb_build_object('severity', 'WARN', 'code', 'SETTLEMENT_CONFLICTS', 'detail', jsonb_build_object('count', n))); END IF;
  -- Each settled transaction's journal carries exactly its gross revenue (sale) or refund, for its own agent.
  SELECT count(*) INTO n FROM fleet_external_transactions t JOIN fleet_ledger_journal j ON j.journal_id = t.journal_id
   WHERE t.status = 'settled' AND (j.agent_id <> t.agent_id OR (SELECT COALESCE(sum(po.amount_cents), 0) FROM fleet_ledger_postings po JOIN fleet_ledger_accounts ac ON ac.account_id = po.account_id
          WHERE po.journal_id = j.journal_id AND ac.class = 'agent_revenue') <> t.gross_minor
          OR NOT EXISTS (SELECT 1 FROM fleet_venture_journals vj WHERE vj.journal_id = j.journal_id AND vj.venture_id = t.venture_id));
  f := f || jsonb_build_array(jsonb_build_object('severity', CASE WHEN n = 0 THEN 'INFO' ELSE 'FAIL' END, 'code', 'SETTLEMENT_JOURNALS', 'detail', jsonb_build_object('mismatched', n)));
  -- Venture attribution never exceeds the agent's own totals.
  FOR r IN SELECT v.agent_id, sum((fleet_venture_financials(v.venture_id) ->> 'revenueMinor')::bigint) AS vrev FROM fleet_ventures v GROUP BY v.agent_id LOOP
    IF r.vrev > fleet_ledger_balance(fleet_ledger_account(r.agent_id, 'agent_revenue')) + (SELECT COALESCE(sum(CASE WHEN po.side = 'D' THEN po.amount_cents ELSE 0 END), 0)
         FROM fleet_ledger_postings po JOIN fleet_ledger_journal j ON j.journal_id = po.journal_id
        WHERE po.account_id = fleet_ledger_account(r.agent_id, 'agent_revenue') AND j.kind = 'external_refund') THEN
      f := f || jsonb_build_array(jsonb_build_object('severity', 'FAIL', 'code', 'ATTRIBUTION_EXCEEDS_AGENT', 'detail', jsonb_build_object('agentId', r.agent_id)));
    END IF;
  END LOOP;
  -- Tax: reserves are never negative (ledger), and a fallback reserve means a missing tax profile.
  SELECT count(*) INTO n FROM fleet_external_transactions WHERE status = 'settled' AND (tax ->> 'fallback')::boolean;
  IF n > 0 THEN f := f || jsonb_build_array(jsonb_build_object('severity', 'WARN', 'code', 'TAX_PROFILE_MISSING', 'detail', jsonb_build_object('settledWithFallback', n))); END IF;
  -- Rails: in service with a revoked/expired credential, or active without a recent settlement while assigned.
  SELECT count(*) INTO n FROM fleet_payment_rails pr JOIN fleet_credential_refs c ON c.credential_id = pr.credential_id
   WHERE pr.status IN ('active','degraded') AND c.status IN ('revoked','expired');
  IF n > 0 THEN f := f || jsonb_build_array(jsonb_build_object('severity', 'FAIL', 'code', 'RAIL_CREDENTIAL_INVALID', 'detail', jsonb_build_object('rails', n))); END IF;
  -- Treasury: the unallocated partition never negative (ledger CHECK) — reported for the overview.
  f := f || jsonb_build_array(jsonb_build_object('severity', 'INFO', 'code', 'TREASURY', 'detail', jsonb_build_object(
    'unallocatedMinor', fleet_ledger_balance('fleet:treasury:unallocated'), 'operatingPoolMinor', fleet_ledger_balance('fleet:operating:pool'))));
  RETURN jsonb_build_object('ok', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(f) x WHERE x ->> 'severity' = 'FAIL'), 'findings', f, 'at', now());
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

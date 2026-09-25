/**
 * Schema v11 — Phase F: Genesis architecture and pre-Genesis integration.
 *
 * GENESIS (owner-authorized creation of the initial founder population),
 * RESEEDING (founders after extinction; modelled, not enabled), REPRODUCTION
 * (a child of an eligible agent; constitutionally unavailable to founders and
 * pinned off) and REPLACEMENT (not implemented) are distinct origins. There is
 * no generic "create agent" operation.
 *
 * Genesis is a single-use, content-hashed authorization carried through a
 * transactional state machine:
 *   proposed → approved → provisioning → attesting → funding_virtual → ready → activated
 *   proposed → rejected | cancelled | expired;   approved → cancelled | expired
 *   provisioning … ready → rolled_back   (any founder failure, expiry or owner abort)
 * Founders exist (reserved slots, no credential, no session, no authority)
 * from provisioning; ALL of them receive credentials and become active in
 * ONE activation transaction, or none does. A rollback fails every founder,
 * returns every virtual allocation and releases every slot. Activation and
 * approval are owner-only and additionally require the owner switch
 * fleet_genesis_policy.genesis_enabled (default off).
 *
 * Also: capability classes and versioned manifests (reproduction, custody
 * payment execution, self-modification, compute provisioning and tool
 * discovery are not grantable), revenue provenance, the Organisation
 * Identity vault (scoped, per-claim fact release; empty), institutional
 * knowledge (deliberate owner promotion with provenance), estate freeze on
 * death and reaper settlement, and the inert reproduction-eligibility model
 * (execution pinned off by CHECK).
 */

export const V11_SQL = `
-- ═══ Capability classes and manifests (F7) ═══════════════════════════════
CREATE TABLE fleet_capability_classes (
  class       text    PRIMARY KEY CHECK (class ~ '^[a-z_]+(\\.[a-z_]+)?$'),
  grantable   boolean NOT NULL,
  description text    NOT NULL
);
INSERT INTO fleet_capability_classes (class, grantable, description) VALUES
  ('liveness',                  true,  'Heartbeat, sleep, low-compute mode'),
  ('planning',                  true,  'Goals, tasks and plans in the agent''s own state'),
  ('memory.private',            true,  'Agent-private working memory in its own state namespace'),
  ('research.read',             true,  'Read-only observation: files, balances, models, domain search'),
  ('workspace.fs',              true,  'Write files inside the agent''s own workspace'),
  ('code.build',                true,  'Shell, git and package installs inside the workspace'),
  ('deployment',                true,  'Expose services from the agent''s own existing sandbox'),
  ('communication',             true,  'Messages and notes'),
  ('website.domain',            true,  'DNS management of domains the fleet already holds'),
  ('external.publish',          true,  'Publish code or an agent card'),
  ('spend.request',             true,  'Submit structured spend orders to FleetController (decided by policy/owner)'),
  ('ledger.read',               true,  'Read the agent''s own ledger position'),
  ('asset.manage',              true,  'Operate assets under the agent''s authority'),
  ('identity.claim_request',    true,  'Request a specific approved Organisation Identity fact for a workflow'),
  ('knowledge.propose',         true,  'Propose an entry for fleet institutional knowledge'),
  ('knowledge.read',            true,  'Read promoted institutional knowledge'),
  ('self_modification',         false, 'Edit own code/soul/model/upstream (capability escalation risk)'),
  ('tool.discovery',            false, 'Install MCP servers or skills at runtime (capability escalation risk)'),
  ('compute.provisioning',      false, 'Create or delete billed sandboxes'),
  ('reproduction',              false, 'Create, fund or command children'),
  ('custody.payment_execution', false, 'Sign, pay, transfer or top up value directly');
CREATE TRIGGER fleet_capability_classes_no_change BEFORE UPDATE OR DELETE ON fleet_capability_classes
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_capability_classes_no_truncate BEFORE TRUNCATE ON fleet_capability_classes
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_capability_manifests (
  manifest_id     text        PRIMARY KEY CHECK (manifest_id ~ '^[a-z0-9-]{1,40}$'),
  version         integer     NOT NULL CHECK (version >= 1),
  allowed         text[]      NOT NULL,
  manifest_sha256 text        NOT NULL UNIQUE CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  description     text        NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  created_by      text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION fleet_manifest_digest(p_id text, p_version integer, p_allowed text[]) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(p_id || '|' || p_version || '|' ||
    (SELECT string_agg(c, ',' ORDER BY c) FROM unnest(p_allowed) c), 'UTF8')), 'hex')
$$;
CREATE FUNCTION fleet_capability_manifests_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c text;
BEGIN
  IF cardinality(NEW.allowed) = 0 OR (SELECT count(DISTINCT x) FROM unnest(NEW.allowed) x) <> cardinality(NEW.allowed) THEN
    RAISE EXCEPTION 'FLEET_MANIFEST_INVALID: allowed classes must be a non-empty set';
  END IF;
  FOREACH c IN ARRAY NEW.allowed LOOP
    IF NOT EXISTS (SELECT 1 FROM fleet_capability_classes WHERE class = c) THEN
      RAISE EXCEPTION 'FLEET_MANIFEST_INVALID: unknown capability class %', c;
    END IF;
    IF NOT (SELECT grantable FROM fleet_capability_classes WHERE class = c) THEN
      RAISE EXCEPTION 'FLEET_CAPABILITY_NOT_GRANTABLE: % is a constitutional exclusion', c;
    END IF;
  END LOOP;
  NEW.manifest_sha256 := fleet_manifest_digest(NEW.manifest_id, NEW.version, NEW.allowed);
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_capability_manifests_guard BEFORE INSERT ON fleet_capability_manifests
  FOR EACH ROW EXECUTE FUNCTION fleet_capability_manifests_guard();
CREATE TRIGGER fleet_capability_manifests_no_change BEFORE UPDATE OR DELETE ON fleet_capability_manifests
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_capability_manifests_no_truncate BEFORE TRUNCATE ON fleet_capability_manifests
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
INSERT INTO fleet_capability_manifests (manifest_id, version, allowed, manifest_sha256, description, created_by) VALUES
  ('founder-v1', 1, ARRAY['liveness','planning','memory.private','research.read','workspace.fs','code.build','deployment',
     'communication','website.domain','external.publish','spend.request','ledger.read','asset.manage','identity.claim_request',
     'knowledge.propose','knowledge.read'], repeat('0', 64),
   'Genesis founder: independent economic discovery; no reproduction, payment execution, self-modification, tool discovery or compute provisioning',
   'migration');

-- ═══ Agent origin, lineage and isolation identity (F1/F2) ════════════════
ALTER TABLE fleet_agents
  ADD COLUMN origin                 text NOT NULL DEFAULT 'legacy'
    CHECK (origin IN ('legacy','genesis_founder','reseed_founder','reproduction_child','dry_run_child','replacement')),
  ADD COLUMN genesis_id             uuid,
  ADD COLUMN lineage_root           text REFERENCES fleet_agents(agent_id),
  ADD COLUMN capability_manifest_id text REFERENCES fleet_capability_manifests(manifest_id),
  ADD COLUMN workspace_id           text UNIQUE CHECK (workspace_id ~ '^ws_[0-9A-HJKMNP-TV-Z]{26}$'),
  ADD COLUMN state_namespace        text UNIQUE CHECK (state_namespace ~ '^st_[0-9A-HJKMNP-TV-Z]{26}$');
UPDATE fleet_agents SET origin = CASE WHEN role = 'child' AND dry_run THEN 'dry_run_child' WHEN role = 'child' THEN 'reproduction_child' ELSE 'legacy' END;
ALTER TABLE fleet_agents ADD CONSTRAINT fleet_agents_founder_identity CHECK (
  origin NOT IN ('genesis_founder','reseed_founder') OR (role = 'root' AND genesis_id IS NOT NULL AND lineage_root = agent_id
    AND capability_manifest_id IS NOT NULL AND workspace_id IS NOT NULL AND state_namespace IS NOT NULL));
ALTER TABLE fleet_agents ADD CONSTRAINT fleet_agents_child_origin CHECK ((role = 'child') = (origin IN ('reproduction_child','dry_run_child')));
-- Founders are the only roots that pass through reserved/provisioning (their Genesis holds the slots).
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'fleet_agents'::regclass AND contype = 'c'
            AND pg_get_constraintdef(oid) ~ 'reserved.*provisioning' AND pg_get_constraintdef(oid) ~ 'child' AND pg_get_constraintdef(oid) !~ 'origin' LOOP
    EXECUTE format('ALTER TABLE fleet_agents DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE fleet_agents ADD CONSTRAINT fleet_agents_pending_is_child_or_founder
  CHECK (status NOT IN ('reserved','provisioning') OR role = 'child' OR origin IN ('genesis_founder','reseed_founder'));

-- ═══ Reproduction: inert eligibility model, execution pinned off (F12) ═══
CREATE TABLE fleet_reproduction_policy (
  id                          smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  execution_enabled           boolean     NOT NULL DEFAULT false CHECK (NOT execution_enabled),
  min_age_days                integer     NOT NULL DEFAULT 90   CHECK (min_age_days >= 0),
  min_realized_net_profit_cents bigint    NOT NULL DEFAULT 1000000 CHECK (min_realized_net_profit_cents >= 0),
  min_lifetime_contribution_cents bigint  NOT NULL DEFAULT 250000  CHECK (min_lifetime_contribution_cents >= 0),
  min_external_revenue_cents  bigint      NOT NULL DEFAULT 2000000 CHECK (min_external_revenue_cents >= 0),
  min_runway_days             integer     NOT NULL DEFAULT 90   CHECK (min_runway_days >= 0),
  max_protected_principal_cents bigint    NOT NULL DEFAULT 0    CHECK (max_protected_principal_cents >= 0),
  min_capital_efficiency      numeric     NOT NULL DEFAULT 1.5  CHECK (min_capital_efficiency >= 0),
  min_treasury_reserve_months numeric     NOT NULL DEFAULT 6    CHECK (min_treasury_reserve_months >= 0),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fleet_reproduction_policy (id) VALUES (1);
CREATE TRIGGER fleet_reproduction_policy_no_delete BEFORE DELETE ON fleet_reproduction_policy
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- Every new agent row carries its origin; founders are created only inside a Genesis
-- operation and never have children while reproduction execution is pinned off.
CREATE FUNCTION fleet_agents_origin_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_agents;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.role = 'child' THEN
      NEW.origin := CASE WHEN NEW.dry_run THEN 'dry_run_child' ELSE 'reproduction_child' END;
      SELECT * INTO p FROM fleet_agents WHERE agent_id = NEW.parent_agent_id;
      IF p.origin IN ('genesis_founder','reseed_founder') AND NOT (SELECT execution_enabled FROM fleet_reproduction_policy WHERE id = 1) THEN
        RAISE EXCEPTION 'FLEET_REPRODUCTION_DISABLED: founders cannot reproduce while reproduction execution is pinned off';
      END IF;
      NEW.lineage_root := COALESCE(p.lineage_root, p.agent_id);
    ELSIF NEW.origin IN ('genesis_founder','reseed_founder') THEN
      IF NEW.genesis_id IS NULL OR COALESCE(current_setting('fleet.genesis_op', true), '') <> NEW.genesis_id::text THEN
        RAISE EXCEPTION 'FLEET_GENESIS_REQUIRED: founders are created only by their Genesis provisioning';
      END IF;
      IF NEW.status <> 'reserved' THEN RAISE EXCEPTION 'FLEET_GENESIS_REQUIRED: founders start reserved'; END IF;
    ELSIF NEW.origin <> 'legacy' THEN
      RAISE EXCEPTION 'FLEET_INVALID_ORIGIN: % agents cannot be created in schema v11', NEW.origin;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.origin IS DISTINCT FROM OLD.origin OR NEW.genesis_id IS DISTINCT FROM OLD.genesis_id
     OR NEW.lineage_root IS DISTINCT FROM OLD.lineage_root OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.state_namespace IS DISTINCT FROM OLD.state_namespace
     OR (OLD.capability_manifest_id IS NOT NULL AND NEW.capability_manifest_id IS DISTINCT FROM OLD.capability_manifest_id) THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: origin, lineage, isolation identity and capability manifest are fixed';
  END IF;
  IF NEW.origin IN ('genesis_founder','reseed_founder') AND NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status IN ('provisioning','active') AND COALESCE(current_setting('fleet.genesis_op', true), '') <> NEW.genesis_id::text THEN
    RAISE EXCEPTION 'FLEET_GENESIS_REQUIRED: a founder advances only through its Genesis state machine';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_agents_origin_guard BEFORE INSERT OR UPDATE ON fleet_agents
  FOR EACH ROW EXECUTE FUNCTION fleet_agents_origin_guard();

-- Capability check (server-side enforcement point for fleet-mediated capabilities).
-- Agents with a manifest get exactly its grantable classes; legacy agents without one
-- keep their pre-v11 behaviour; founders always have one (constraint above).
CREATE FUNCTION fleet_agent_can(p_agent text, p_class text) RETURNS boolean LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT CASE
    WHEN a.capability_manifest_id IS NULL THEN a.origin = 'legacy'
    ELSE EXISTS (SELECT 1 FROM fleet_capability_manifests m JOIN fleet_capability_classes c ON c.class = p_class AND c.grantable
                  WHERE m.manifest_id = a.capability_manifest_id AND p_class = ANY (m.allowed))
  END
  FROM fleet_agents a WHERE a.agent_id = p_agent
$$;

-- Crockford base32 ULID (48-bit ms time + 80 random bits).
CREATE FUNCTION fleet_new_ulid() RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE alphabet text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000);
        rnd bytea := substring(uuid_send(gen_random_uuid()) FROM 1 FOR 10); out text := ''; i integer; acc numeric := 0;
BEGIN
  FOR i IN REVERSE 9..0 LOOP out := out || substr(alphabet, ((ms >> (i * 5)) & 31)::integer + 1, 1); END LOOP;
  FOR i IN 0..9 LOOP acc := acc * 256 + get_byte(rnd, i); END LOOP;
  FOR i IN REVERSE 15..0 LOOP out := out || substr(alphabet, (floor(acc / power(32::numeric, i)) % 32)::integer + 1, 1); END LOOP;
  RETURN out;
END $$;

-- ═══ Ledger additions: revenue provenance and Genesis allocation (F5/F9) ═══
ALTER TABLE fleet_ledger_kinds DISABLE TRIGGER fleet_ledger_kinds_no_change;
ALTER TABLE fleet_ledger_kinds ADD COLUMN provenance text;
UPDATE fleet_ledger_kinds SET provenance = CASE kind
  WHEN 'owner_funding' THEN 'owner_funding'
  WHEN 'treasury_reallocation' THEN 'internal_transfer'
  WHEN 'agent_capital_grant' THEN 'treasury_allocation'
  WHEN 'agent_capital_return' THEN 'treasury_allocation'
  WHEN 'principal_advance' THEN 'protected_principal'
  WHEN 'principal_repayment' THEN 'protected_principal'
  WHEN 'spend_reservation' THEN 'reservation'
  WHEN 'spend_release' THEN 'reservation'
  WHEN 'spend_settlement' THEN 'expense'
  WHEN 'external_revenue' THEN 'external_customer_revenue'
  WHEN 'profit_contribution' THEN 'profit_contribution'
  WHEN 'fleet_expense_settlement' THEN 'expense'
  WHEN 'conway_credits_purchase' THEN 'expense'
  WHEN 'conway_credits_consumption' THEN 'expense'
  WHEN 'owner_withdrawal_reservation' THEN 'owner_withdrawal'
  WHEN 'owner_withdrawal_release' THEN 'owner_withdrawal'
  WHEN 'owner_withdrawal_settlement' THEN 'owner_withdrawal'
  WHEN 'asset_valuation' THEN 'unrealized_valuation'
  WHEN 'estate_principal_recovery' THEN 'estate'
  WHEN 'estate_principal_writeoff' THEN 'estate'
  WHEN 'estate_transfer' THEN 'estate'
  WHEN 'agent_transfer' THEN 'internal_transfer'
  WHEN 'reversal' THEN 'correction'
END;
ALTER TABLE fleet_ledger_kinds ALTER COLUMN provenance SET NOT NULL;
ALTER TABLE fleet_ledger_kinds ADD CONSTRAINT fleet_ledger_kinds_provenance CHECK (provenance IN ('owner_funding','internal_transfer',
  'treasury_allocation','genesis_allocation','protected_principal','reservation','expense','external_customer_revenue','refund','fee',
  'realized_investment_pnl','unrealized_valuation','profit_contribution','owner_withdrawal','estate','correction'));
INSERT INTO fleet_ledger_kinds (kind, requires_external_ref, allowed_sources, multi_agent, description, provenance) VALUES
  ('genesis_allocation',        false, ARRAY['owner'],             false, 'Virtual starting allocation of a Genesis founder', 'genesis_allocation'),
  ('genesis_allocation_return', false, ARRAY['owner','controller'], false, 'Return of a rolled-back founder''s starting allocation', 'genesis_allocation'),
  ('external_refund',           true,  ARRAY['owner','executor'],  false, 'Refund of realized external revenue to a customer', 'refund'),
  ('investment_realized_gain',  true,  ARRAY['owner','executor'],  false, 'Realized investment gain', 'realized_investment_pnl'),
  ('investment_realized_loss',  true,  ARRAY['owner','executor'],  false, 'Realized investment loss', 'realized_investment_pnl');
ALTER TABLE fleet_ledger_kinds ENABLE TRIGGER fleet_ledger_kinds_no_change;

ALTER TABLE fleet_ledger_classes DISABLE TRIGGER fleet_ledger_classes_no_change;
INSERT INTO fleet_ledger_classes (class, kind, normal_side, scope, non_negative, description) VALUES
  ('agent_investment_pnl', 'revenue', 'C', 'agent', false, 'Realized investment profit and loss (external, never internal)');
ALTER TABLE fleet_ledger_classes ENABLE TRIGGER fleet_ledger_classes_no_change;

INSERT INTO fleet_ledger_rules (kind, class, side) VALUES
  ('genesis_allocation','agent_cash','D'), ('genesis_allocation','treasury_cash','C'),
  ('genesis_allocation_return','treasury_cash','D'), ('genesis_allocation_return','agent_cash','C'),
  ('external_refund','agent_revenue','D'), ('external_refund','agent_cash','C'),
  ('investment_realized_gain','agent_cash','D'), ('investment_realized_gain','agent_investment_pnl','C'),
  ('investment_realized_loss','agent_investment_pnl','D'), ('investment_realized_loss','agent_cash','C');

-- Existing agents get the new class account on demand.
CREATE OR REPLACE FUNCTION fleet_ledger_open_agent(p_agent text, p_actor text) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = p_agent) THEN
    RAISE EXCEPTION 'FLEET_LEDGER_INVALID: unknown agent %', p_agent;
  END IF;
  FOREACH c IN ARRAY ARRAY['agent_cash','agent_reserved','agent_assets','agent_principal','agent_revenue','agent_expense','agent_fees',
                           'agent_contributions','agent_investment_pnl'] LOOP
    INSERT INTO fleet_ledger_accounts (account_id, class, agent_id, description, created_by)
    VALUES ('agent:' || p_agent || ':' || substr(c, 7), c, p_agent, c || ' of ' || p_agent, left(p_actor, 128))
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;

-- Fleet-controlled references: value from these is never external revenue.
CREATE TABLE fleet_controlled_references (
  reference_sha256 text        PRIMARY KEY CHECK (reference_sha256 ~ '^[0-9a-f]{64}$'),
  label            text        NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
  added_by         text        NOT NULL,
  added_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_controlled_references_no_change BEFORE UPDATE OR DELETE ON fleet_controlled_references
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_revenue_provenance (
  journal_id           uuid        PRIMARY KEY REFERENCES fleet_ledger_journal(journal_id),
  agent_id             text        NOT NULL REFERENCES fleet_agents(agent_id),
  provenance           text        NOT NULL CHECK (provenance IN ('external_customer_revenue','refund','realized_investment_pnl')),
  counterparty_sha256  text        NOT NULL CHECK (counterparty_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_by          text        NOT NULL,
  recorded_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_revenue_provenance_no_change BEFORE UPDATE OR DELETE ON fleet_revenue_provenance
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- Is this counterparty fleet-controlled (an agent identity, an owner destination, a registered fleet reference)?
CREATE FUNCTION fleet_counterparty_internal(p_sha256 text) RETURNS boolean LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM fleet_agents WHERE wallet_address IS NOT NULL AND encode(sha256(convert_to(lower(wallet_address), 'UTF8')), 'hex') = p_sha256)
      OR EXISTS (SELECT 1 FROM fleet_payment_destinations WHERE kind = 'owner' AND reference_sha256 = p_sha256)
      OR EXISTS (SELECT 1 FROM fleet_controlled_references WHERE reference_sha256 = p_sha256)
$$;

-- Record realized external revenue (replaces the v10 form): the counterparty is
-- required and must not be fleet-controlled (no profit from internal transfers).
DROP FUNCTION fleet_admin_record_revenue(text, bigint, text, text, text);
CREATE FUNCTION fleet_admin_record_external(p_kind text, p_agent text, p_amount bigint, p_external_ref text, p_counterparty_sha256 text,
  p_actor text, p_idem text) RETURNS uuid LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_j uuid; v_lines jsonb; v_prov text;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  IF p_counterparty_sha256 IS NULL OR p_counterparty_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'FLEET_PROVENANCE_REQUIRED: an external counterparty reference is required';
  END IF;
  IF fleet_counterparty_internal(p_counterparty_sha256) THEN
    RAISE EXCEPTION 'FLEET_INTERNAL_TRANSFER_NOT_REVENUE: the counterparty is fleet-controlled';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: positive amount required'; END IF;
  PERFORM fleet_ledger_open_agent(p_agent, p_actor);
  v_lines := CASE p_kind
    WHEN 'external_revenue' THEN jsonb_build_array(
      jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_cash'), 'side', 'D', 'amount', p_amount),
      jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_revenue'), 'side', 'C', 'amount', p_amount))
    WHEN 'external_refund' THEN jsonb_build_array(
      jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_revenue'), 'side', 'D', 'amount', p_amount),
      jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_cash'), 'side', 'C', 'amount', p_amount))
    WHEN 'investment_realized_gain' THEN jsonb_build_array(
      jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_cash'), 'side', 'D', 'amount', p_amount),
      jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_investment_pnl'), 'side', 'C', 'amount', p_amount))
    WHEN 'investment_realized_loss' THEN jsonb_build_array(
      jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_investment_pnl'), 'side', 'D', 'amount', p_amount),
      jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_cash'), 'side', 'C', 'amount', p_amount))
  END;
  IF v_lines IS NULL THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: unsupported external kind %', p_kind; END IF;
  v_j := fleet_ledger_post(p_kind, p_idem, p_actor, 'external economic fact', 'owner', p_agent, NULL, NULL, p_external_ref, NULL, now(), v_lines);
  v_prov := (SELECT provenance FROM fleet_ledger_kinds WHERE kind = p_kind);
  INSERT INTO fleet_revenue_provenance (journal_id, agent_id, provenance, counterparty_sha256, recorded_by)
    VALUES (v_j, p_agent, v_prov, p_counterparty_sha256, p_actor) ON CONFLICT (journal_id) DO NOTHING;
  RETURN v_j;
END $$;

-- Agent economics (v11): provenance-separated.
CREATE OR REPLACE FUNCTION fleet_agent_economics(p_agent text) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_cash bigint; v_res bigint; v_assets_rec bigint; v_principal bigint; v_oblig bigint; v_rev bigint; v_exp bigint; v_fees bigint;
        v_contrib bigint; v_inv bigint; v_rec bigint; v_eq bigint; v_net bigint; v_res_rec bigint; v_genesis bigint; v_granted bigint; v_transfers bigint;
BEGIN
  v_cash := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_cash'));
  v_res := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_reserved'));
  v_principal := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_principal'));
  v_rev := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_revenue'));
  v_exp := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_expense'));
  v_fees := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_fees'));
  v_contrib := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_contributions'));
  v_inv := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_investment_pnl'));
  SELECT COALESCE(sum(LEAST(recoverable_cents, acquisition_basis_cents)), 0) INTO v_assets_rec
    FROM fleet_assets WHERE authority_agent_id = p_agent AND status = 'held';
  SELECT COALESCE(sum(recoverable_cents), 0) INTO v_res_rec
    FROM fleet_payment_orders WHERE agent_id = p_agent AND status IN ('reserved','executing');
  SELECT COALESCE(sum(amount_cents), 0) INTO v_oblig FROM fleet_obligations WHERE agent_id = p_agent AND status = 'approved';
  SELECT COALESCE(sum(CASE WHEN j.kind = 'genesis_allocation' THEN p.amount_cents ELSE -p.amount_cents END) FILTER (WHERE j.kind IN ('genesis_allocation','genesis_allocation_return')), 0),
         COALESCE(sum(CASE WHEN j.kind = 'agent_capital_grant' THEN p.amount_cents ELSE -p.amount_cents END) FILTER (WHERE j.kind IN ('agent_capital_grant','agent_capital_return')), 0),
         COALESCE(sum(CASE WHEN p.side = 'D' THEN p.amount_cents ELSE -p.amount_cents END) FILTER (WHERE j.kind = 'agent_transfer'), 0)
    INTO v_genesis, v_granted, v_transfers
    FROM fleet_ledger_postings p JOIN fleet_ledger_journal j ON j.journal_id = p.journal_id
   WHERE p.account_id = fleet_ledger_account(p_agent, 'agent_cash');
  v_rec := v_cash + v_res_rec + v_assets_rec;
  v_eq := v_rec - v_principal - v_oblig;
  v_net := v_rev - v_exp - v_fees + v_inv;
  RETURN jsonb_build_object('cash', v_cash, 'reserved', v_res, 'reservedRecoverable', v_res_rec, 'assetsRecoverable', v_assets_rec,
    'recoverable', v_rec, 'protectedPrincipal', v_principal, 'protectedObligations', v_oblig, 'survivalEquity', v_eq,
    'expensePurchasingCapacity', GREATEST(0, LEAST(v_cash, v_eq)), 'purchasingCapacity', v_cash,
    'externalCustomerRevenue', v_rev, 'realizedInvestmentPnl', v_inv, 'expenses', v_exp, 'fees', v_fees,
    'realizedNetProfit', v_net, 'lifetimeContribution', v_contrib, 'uncontributedProfit', GREATEST(0, v_net - v_contrib),
    'genesisAllocation', v_genesis, 'treasuryAllocation', v_granted, 'internalTransfersNet', v_transfers,
    'survivalEquityExhausted', v_eq <= 0 AND v_principal > 0);
END $$;

-- ═══ Genesis (F1/F3/F4) ══════════════════════════════════════════════════
CREATE TABLE fleet_genesis_policy (
  id                      smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  genesis_enabled         boolean     NOT NULL DEFAULT false,
  refounding_enabled       boolean     NOT NULL DEFAULT false CHECK (NOT refounding_enabled),
  template_version        text        NOT NULL DEFAULT 'founder-template-v1' CHECK (template_version ~ '^[a-z0-9.-]{1,40}$'),
  default_manifest_id     text        NOT NULL DEFAULT 'founder-v1' REFERENCES fleet_capability_manifests(manifest_id),
  max_ttl_s               integer     NOT NULL DEFAULT 604800 CHECK (max_ttl_s BETWEEN 600 AND 2592000),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              text        NOT NULL DEFAULT 'migration'
);
INSERT INTO fleet_genesis_policy (id) VALUES (1);
CREATE TRIGGER fleet_genesis_policy_no_delete BEFORE DELETE ON fleet_genesis_policy
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- Economic policy identity at a point in time (ledger grammar + economic model).
CREATE FUNCTION fleet_economic_policy_sha256() RETURNS text LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT encode(sha256(convert_to(
    (SELECT string_agg(kind || ':' || class || ':' || side, ',' ORDER BY kind, class, side) FROM fleet_ledger_rules) || '|' ||
    (SELECT string_agg(kind || ':' || provenance, ',' ORDER BY kind) FROM fleet_ledger_kinds) || '|' ||
    (SELECT concat_ws(':', owner_approval_threshold_cents, agent_daily_spend_cents, reservation_ttl_s, strong_auth_threshold_cents,
                      destination_cooldown_s, confirmation_ttl_s, custody_execution_enabled) FROM fleet_economic_model WHERE id = 1),
    'UTF8')), 'hex')
$$;

CREATE TABLE fleet_genesis (
  genesis_id               uuid        PRIMARY KEY,
  kind                     text        NOT NULL CHECK (kind IN ('genesis','reseeding')),
  idempotency_key          text        NOT NULL UNIQUE CHECK (idempotency_key ~ '^[A-Za-z0-9:_.-]{8,128}$'),
  founder_count            integer     NOT NULL CHECK (founder_count BETWEEN 1 AND 50),
  template_version         text        NOT NULL,
  manifest_id              text        NOT NULL REFERENCES fleet_capability_manifests(manifest_id),
  manifest_sha256          text        NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  runtime_repo             text        NOT NULL,
  runtime_commit           text        NOT NULL CHECK (runtime_commit ~ '^[0-9a-f]{40}$'),
  runtime_build_id         text        NOT NULL CHECK (runtime_build_id ~ '^[0-9a-f]{64}$'),
  runtime_lockfile_sha256  text        NOT NULL CHECK (runtime_lockfile_sha256 ~ '^[0-9a-f]{64}$'),
  economic_policy_sha256   text        NOT NULL CHECK (economic_policy_sha256 ~ '^[0-9a-f]{64}$'),
  allocation_cents         bigint      NOT NULL CHECK (allocation_cents BETWEEN 0 AND 100000000000),
  expires_at               timestamptz NOT NULL,
  requested_by             text        NOT NULL CHECK (requested_by ~ '^operator:[A-Za-z0-9._-]{1,64}$'),
  requested_at             timestamptz NOT NULL DEFAULT now(),
  auth_sha256              text        NOT NULL UNIQUE CHECK (auth_sha256 ~ '^[0-9a-f]{64}$'),
  status                   text        NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','provisioning','attesting',
                                        'funding_virtual','ready','activated','rejected','cancelled','expired','rolled_back')),
  approved_by              text        CHECK (approved_by ~ '^operator:[A-Za-z0-9._-]{1,64}$'),
  approved_at              timestamptz,
  activated_by             text,
  activated_at             timestamptz,
  consumed_at              timestamptz,
  founder_ids              text[],
  status_reason            text        CHECK (length(status_reason) <= 300),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('proposed','rejected') OR (status = 'cancelled' AND approved_at IS NULL) OR (status = 'expired' AND approved_at IS NULL))
         OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK ((status = 'activated') = (activated_at IS NOT NULL)),
  CHECK (status NOT IN ('activated','rolled_back') OR consumed_at IS NOT NULL)
);
-- At most one Genesis in flight at any time.
CREATE UNIQUE INDEX fleet_genesis_one_in_flight ON fleet_genesis ((true))
  WHERE status IN ('approved','provisioning','attesting','funding_virtual','ready');
ALTER TABLE fleet_agents ADD CONSTRAINT fleet_agents_genesis_fk FOREIGN KEY (genesis_id) REFERENCES fleet_genesis(genesis_id);

-- Canonical content of an authorization (what the owner approves; hashed).
CREATE FUNCTION fleet_genesis_canonical(g fleet_genesis) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT concat_ws('|', 'fleet-genesis-v1', g.genesis_id::text, g.kind, g.idempotency_key, g.founder_count, g.template_version,
    g.manifest_id, g.manifest_sha256, g.runtime_repo, g.runtime_commit, g.runtime_build_id, g.runtime_lockfile_sha256,
    g.economic_policy_sha256, g.allocation_cents, to_char(g.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), g.requested_by)
$$;

CREATE FUNCTION fleet_genesis_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_fixed text[] := ARRAY['genesis_id','kind','idempotency_key','founder_count','template_version','manifest_id','manifest_sha256',
  'runtime_repo','runtime_commit','runtime_build_id','runtime_lockfile_sha256','economic_policy_sha256','allocation_cents','expires_at',
  'requested_by','requested_at','auth_sha256'];
BEGIN
  IF COALESCE(current_setting('fleet.genesis_op', true), '') <> NEW.genesis_id::text THEN
    RAISE EXCEPTION 'FLEET_GENESIS_REQUIRED: Genesis records change only through the Genesis functions';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'proposed' OR NEW.auth_sha256 <> encode(sha256(convert_to(fleet_genesis_canonical(NEW), 'UTF8')), 'hex') THEN
      RAISE EXCEPTION 'FLEET_GENESIS_INVALID: a Genesis starts proposed with its canonical hash';
    END IF;
    RETURN NEW;
  END IF;
  IF (SELECT jsonb_object_agg(k, to_jsonb(NEW) -> k) FROM unnest(v_fixed) k) IS DISTINCT FROM (SELECT jsonb_object_agg(k, to_jsonb(OLD) -> k) FROM unnest(v_fixed) k) THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: an authorization''s content never changes';
  END IF;
  IF OLD.approved_at IS NOT NULL AND (NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.approved_by IS DISTINCT FROM OLD.approved_by)
     OR OLD.founder_ids IS NOT NULL AND NEW.founder_ids IS DISTINCT FROM OLD.founder_ids THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: approval and founder identities are set once';
  END IF;
  IF OLD.status IN ('activated','rejected','cancelled','expired','rolled_back') THEN
    RAISE EXCEPTION 'FLEET_TERMINAL_STATE_IMMUTABLE: Genesis % is %', OLD.genesis_id, OLD.status;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'proposed'        AND NEW.status IN ('approved','rejected','cancelled','expired'))
    OR (OLD.status = 'approved'        AND NEW.status IN ('provisioning','cancelled','expired'))
    OR (OLD.status = 'provisioning'    AND NEW.status IN ('attesting','rolled_back'))
    OR (OLD.status = 'attesting'       AND NEW.status IN ('funding_virtual','rolled_back'))
    OR (OLD.status = 'funding_virtual' AND NEW.status IN ('ready','rolled_back'))
    OR (OLD.status = 'ready'           AND NEW.status IN ('activated','rolled_back'))) THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: Genesis % -> %', OLD.status, NEW.status;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO fleet_genesis_transitions (genesis_id, from_status, to_status, actor, reason)
      VALUES (NEW.genesis_id, OLD.status, NEW.status, COALESCE(current_setting('fleet.genesis_actor', true), 'unknown'), left(NEW.status_reason, 300));
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TABLE fleet_genesis_transitions (
  seq         bigserial   PRIMARY KEY,
  genesis_id  uuid        NOT NULL REFERENCES fleet_genesis(genesis_id),
  from_status text        NOT NULL,
  to_status   text        NOT NULL,
  actor       text        NOT NULL,
  reason      text,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_genesis_guard BEFORE INSERT OR UPDATE ON fleet_genesis
  FOR EACH ROW EXECUTE FUNCTION fleet_genesis_guard();
CREATE TRIGGER fleet_genesis_no_delete BEFORE DELETE ON fleet_genesis
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_genesis_no_truncate BEFORE TRUNCATE ON fleet_genesis
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_genesis_transitions_no_change BEFORE UPDATE OR DELETE ON fleet_genesis_transitions
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_genesis_founders (
  genesis_id          uuid        NOT NULL REFERENCES fleet_genesis(genesis_id),
  ordinal             integer     NOT NULL CHECK (ordinal >= 1),
  agent_id            text        NOT NULL UNIQUE REFERENCES fleet_agents(agent_id),
  status              text        NOT NULL DEFAULT 'provisioned' CHECK (status IN ('provisioned','attested','funded','active','rolled_back')),
  attestation         jsonb,
  attested_at         timestamptz,
  allocation_journal_id uuid       REFERENCES fleet_ledger_journal(journal_id),
  return_journal_id   uuid        REFERENCES fleet_ledger_journal(journal_id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (genesis_id, ordinal)
);
CREATE FUNCTION fleet_genesis_founders_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF COALESCE(current_setting('fleet.genesis_op', true), '') <> NEW.genesis_id::text THEN
    RAISE EXCEPTION 'FLEET_GENESIS_REQUIRED: founder records change only through the Genesis functions';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.genesis_id <> OLD.genesis_id OR NEW.ordinal <> OLD.ordinal OR NEW.agent_id <> OLD.agent_id
     OR (OLD.attestation IS NOT NULL AND NEW.attestation IS DISTINCT FROM OLD.attestation)
     OR (OLD.allocation_journal_id IS NOT NULL AND NEW.allocation_journal_id IS DISTINCT FROM OLD.allocation_journal_id)
     OR OLD.status IN ('active','rolled_back')) THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: founder record';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_genesis_founders_guard BEFORE INSERT OR UPDATE ON fleet_genesis_founders
  FOR EACH ROW EXECUTE FUNCTION fleet_genesis_founders_guard();
CREATE TRIGGER fleet_genesis_founders_no_delete BEFORE DELETE ON fleet_genesis_founders
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- ═══ Genesis functions (owner-only; never granted) ═══════════════════════
CREATE FUNCTION fleet_genesis_begin(p_id uuid, p_actor text) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM set_config('fleet.genesis_op', p_id::text, true);
  PERFORM set_config('fleet.genesis_actor', left(p_actor, 128), true);
END $$;

CREATE FUNCTION fleet_genesis_end() RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM set_config('fleet.genesis_op', '', true);
  PERFORM set_config('fleet.genesis_actor', '', true);
END $$;

CREATE FUNCTION fleet_genesis_owner(p_actor text) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN
    RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: Genesis is a FleetAdmin (owner) act';
  END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_genesis');
END $$;

CREATE FUNCTION fleet_genesis_json(g fleet_genesis) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('genesisId', g.genesis_id, 'kind', g.kind, 'status', g.status, 'founderCount', g.founder_count,
    'manifestId', g.manifest_id, 'manifestSha256', g.manifest_sha256, 'templateVersion', g.template_version,
    'runtime', jsonb_build_object('repo', g.runtime_repo, 'commit', g.runtime_commit, 'buildId', g.runtime_build_id, 'lockfileSha256', g.runtime_lockfile_sha256),
    'economicPolicySha256', g.economic_policy_sha256, 'allocationCents', g.allocation_cents, 'expiresAt', g.expires_at,
    'requestedBy', g.requested_by, 'approvedBy', g.approved_by, 'approvedAt', g.approved_at, 'activatedAt', g.activated_at,
    'authSha256', g.auth_sha256, 'founderIds', to_jsonb(g.founder_ids), 'statusReason', g.status_reason,
    'founders', (SELECT COALESCE(jsonb_agg(jsonb_build_object('ordinal', f.ordinal, 'agentId', f.agent_id, 'status', f.status,
        'workspaceId', a.workspace_id, 'stateNamespace', a.state_namespace, 'agentStatus', a.status) ORDER BY f.ordinal), '[]'::jsonb)
       FROM fleet_genesis_founders f JOIN fleet_agents a USING (agent_id) WHERE f.genesis_id = g.genesis_id))
$$;

CREATE FUNCTION fleet_genesis_set_enabled(p_enabled boolean, p_actor text, p_reason text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM fleet_genesis_owner(p_actor);
  UPDATE fleet_genesis_policy SET genesis_enabled = p_enabled, updated_at = now(), updated_by = p_actor WHERE id = 1;
  PERFORM fleet_event(CASE WHEN p_enabled THEN 'genesis_enabled' ELSE 'genesis_disabled' END, NULL, p_actor, jsonb_build_object('reason', left(fleet_scrub(p_reason), 200)));
  RETURN jsonb_build_object('genesisEnabled', p_enabled);
END $$;

-- Propose (idempotent). Pins the currently approved runtime, the manifest and the economic policy.
CREATE FUNCTION fleet_genesis_propose(p_idem text, p_kind text, p_founder_count integer, p_manifest_id text, p_allocation_cents bigint,
  p_ttl_s integer, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE g fleet_genesis; pol fleet_genesis_policy; st fleet_state; m fleet_capability_manifests; v_id uuid := gen_random_uuid(); prior fleet_genesis;
BEGIN
  PERFORM fleet_genesis_owner(p_actor);
  IF p_idem IS NULL OR p_idem !~ '^[A-Za-z0-9:_.-]{8,128}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: idempotency key required'; END IF;
  SELECT * INTO pol FROM fleet_genesis_policy WHERE id = 1;
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
    IF prior.founder_count = p_founder_count AND prior.manifest_id = m.manifest_id AND prior.allocation_cents = p_allocation_cents AND prior.kind = p_kind THEN
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
  g.expires_at := date_trunc('milliseconds', now() + make_interval(secs => LEAST(GREATEST(COALESCE(p_ttl_s, 86400), 600), pol.max_ttl_s)));
  g.requested_by := p_actor;
  g.auth_sha256 := encode(sha256(convert_to(fleet_genesis_canonical(g), 'UTF8')), 'hex');
  INSERT INTO fleet_genesis (genesis_id, kind, idempotency_key, founder_count, template_version, manifest_id, manifest_sha256, runtime_repo,
      runtime_commit, runtime_build_id, runtime_lockfile_sha256, economic_policy_sha256, allocation_cents, expires_at, requested_by, auth_sha256)
    VALUES (g.genesis_id, g.kind, g.idempotency_key, g.founder_count, g.template_version, g.manifest_id, g.manifest_sha256, g.runtime_repo,
      g.runtime_commit, g.runtime_build_id, g.runtime_lockfile_sha256, g.economic_policy_sha256, g.allocation_cents, g.expires_at, g.requested_by, g.auth_sha256)
    RETURNING * INTO g;
  PERFORM fleet_event('genesis_proposed', NULL, p_actor, jsonb_build_object('genesisId', v_id, 'founderCount', p_founder_count,
    'authSha256', g.auth_sha256, 'allocationCents', p_allocation_cents));
  PERFORM fleet_genesis_end();
  RETURN fleet_genesis_json(g);
END $$;

-- Lock and validate a Genesis for a step: content hash intact, not expired.
CREATE FUNCTION fleet_genesis_lock(p_id uuid) RETURNS fleet_genesis LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE g fleet_genesis;
BEGIN
  SELECT * INTO g FROM fleet_genesis WHERE genesis_id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: Genesis %', p_id; END IF;
  IF g.auth_sha256 <> encode(sha256(convert_to(fleet_genesis_canonical(g), 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'FLEET_GENESIS_TAMPERED: stored authorization does not match its hash';
  END IF;
  RETURN g;
END $$;

-- Rollback: every founder fails, allocations return, slots release. Deterministic; one transaction.
CREATE FUNCTION fleet_genesis_rollback(p_id uuid, p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE g fleet_genesis; f fleet_genesis_founders; v_bal bigint; v_j uuid; n integer := 0;
BEGIN
  g := fleet_genesis_lock(p_id);
  IF g.status NOT IN ('provisioning','attesting','funding_virtual','ready') THEN
    RAISE EXCEPTION 'FLEET_INVALID_STATE: Genesis % cannot roll back from %', p_id, g.status;
  END IF;
  PERFORM fleet_genesis_begin(p_id, p_actor);
  PERFORM fleet_lock_state();
  FOR f IN SELECT * FROM fleet_genesis_founders WHERE genesis_id = p_id ORDER BY ordinal FOR UPDATE LOOP
    v_j := NULL;
    IF f.allocation_journal_id IS NOT NULL THEN
      v_bal := fleet_ledger_balance(fleet_ledger_account(f.agent_id, 'agent_cash'));
      IF v_bal <> g.allocation_cents THEN
        RAISE EXCEPTION 'FLEET_GENESIS_INCONSISTENT: founder % cash % differs from its allocation', f.agent_id, v_bal;
      END IF;
      IF v_bal > 0 THEN
        v_j := fleet_ledger_post('genesis_allocation_return', 'genesis:' || p_id || ':return:' || f.agent_id, p_actor, 'Genesis rolled back',
          'owner', f.agent_id, NULL, p_id::text, NULL, NULL, now(), jsonb_build_array(
            jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', v_bal),
            jsonb_build_object('account', fleet_ledger_account(f.agent_id, 'agent_cash'), 'side', 'C', 'amount', v_bal)));
      END IF;
    END IF;
    UPDATE fleet_agent_credentials SET revoked_at = now() WHERE agent_id = f.agent_id AND revoked_at IS NULL;
    UPDATE fleet_agent_sessions SET revoked_at = now() WHERE agent_id = f.agent_id AND revoked_at IS NULL;
    UPDATE fleet_agents SET status = 'failed', death_time = now(), updated_at = now(),
           status_reason = left('Genesis rolled back: ' || fleet_scrub(p_reason), 500)
     WHERE agent_id = f.agent_id AND status IN ('reserved','provisioning');
    UPDATE fleet_genesis_founders SET status = 'rolled_back', return_journal_id = v_j WHERE genesis_id = p_id AND ordinal = f.ordinal;
    n := n + 1;
  END LOOP;
  UPDATE fleet_genesis SET status = 'rolled_back', consumed_at = COALESCE(consumed_at, now()), status_reason = left(fleet_scrub(p_reason), 300)
   WHERE genesis_id = p_id;
  PERFORM fleet_event('genesis_rolled_back', NULL, p_actor, jsonb_build_object('genesisId', p_id, 'founders', n, 'reason', left(fleet_scrub(p_reason), 200)));
  PERFORM fleet_genesis_end();
  RETURN jsonb_build_object('status', 'rolled_back', 'founders', n);
END $$;

CREATE FUNCTION fleet_genesis_approve(p_id uuid, p_auth_sha256 text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
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
  IF g.founder_count > st.max_agents THEN
    RAISE EXCEPTION 'FLEET_CAP_EXCEEDED: % founders > registry cap %', g.founder_count, st.max_agents;
  END IF;
  UPDATE fleet_genesis SET status = 'approved', approved_by = p_actor, approved_at = now() WHERE genesis_id = p_id RETURNING * INTO g;
  PERFORM fleet_event('genesis_approved', NULL, p_actor, jsonb_build_object('genesisId', p_id, 'authSha256', g.auth_sha256));
  PERFORM fleet_genesis_end();
  RETURN fleet_genesis_json(g);
END $$;

CREATE FUNCTION fleet_genesis_close(p_id uuid, p_status text, p_actor text, p_reason text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE g fleet_genesis;
BEGIN
  PERFORM fleet_genesis_owner(p_actor);
  g := fleet_genesis_lock(p_id);
  IF p_status NOT IN ('rejected','cancelled') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: reject or cancel'; END IF;
  IF g.status IN ('provisioning','attesting','funding_virtual','ready') THEN
    RETURN fleet_genesis_rollback(p_id, COALESCE(p_reason, 'owner abort'), p_actor);
  END IF;
  PERFORM fleet_genesis_begin(p_id, p_actor);
  UPDATE fleet_genesis SET status = p_status, status_reason = left(fleet_scrub(p_reason), 300) WHERE genesis_id = p_id RETURNING * INTO g;
  PERFORM fleet_event('genesis_' || p_status, NULL, p_actor, jsonb_build_object('genesisId', p_id));
  PERFORM fleet_genesis_end();
  RETURN fleet_genesis_json(g);
END $$;

-- Provision: create every founder (reserved slot, keyless identity, own workspace/state/ledger, no credential).
CREATE FUNCTION fleet_genesis_provision(p_id uuid, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE g fleet_genesis; i integer; v_agent text; v_ids text[] := ARRAY[]::text[]; st fleet_state;
BEGIN
  PERFORM fleet_genesis_owner(p_actor);
  g := fleet_genesis_lock(p_id);
  IF g.status <> 'approved' THEN RAISE EXCEPTION 'FLEET_GENESIS_CONSUMED: Genesis % is %', p_id, g.status; END IF;
  PERFORM fleet_genesis_begin(p_id, p_actor);
  IF now() >= g.expires_at THEN
    UPDATE fleet_genesis SET status = 'expired', status_reason = 'expired before provisioning' WHERE genesis_id = p_id;
    PERFORM fleet_genesis_end();
    RETURN jsonb_build_object('status', 'expired', 'code', 'FLEET_GENESIS_EXPIRED');
  END IF;
  st := fleet_lock_state();
  IF st.runtime_commit IS DISTINCT FROM g.runtime_commit OR st.runtime_build_id IS DISTINCT FROM g.runtime_build_id
     OR st.runtime_lockfile_sha256 IS DISTINCT FROM g.runtime_lockfile_sha256 THEN
    RAISE EXCEPTION 'FLEET_RUNTIME_MISMATCH: the approved runtime changed since authorization';
  END IF;
  UPDATE fleet_genesis SET status = 'provisioning' WHERE genesis_id = p_id;
  FOR i IN 1..g.founder_count LOOP
    v_agent := fleet_new_ulid();
    INSERT INTO fleet_agents (agent_id, role, generation, name, wallet_address, runtime_repo, runtime_commit, status, status_reason,
        requested_by, origin, genesis_id, lineage_root, capability_manifest_id, workspace_id, state_namespace)
      VALUES (v_agent, 'root', 0, 'founder-' || i, '0x' || substr(encode(sha256(convert_to('automaton-fleet:founder:no-key:' || v_agent, 'UTF8')), 'hex'), 1, 40),
        g.runtime_repo, g.runtime_commit, 'reserved', 'Genesis founder (no authority until activation)', p_actor,
        'genesis_founder', p_id, v_agent, g.manifest_id, 'ws_' || fleet_new_ulid(), 'st_' || fleet_new_ulid());
    -- Keyless identity: nothing can sign for it; custody is the fleet treasury.
    INSERT INTO fleet_wallet_custody (agent_id, wallet_address, daily_limit_cents)
      SELECT agent_id, wallet_address, 0 FROM fleet_agents WHERE agent_id = v_agent ON CONFLICT (agent_id) DO NOTHING;
    PERFORM fleet_ledger_open_agent(v_agent, p_actor);
    INSERT INTO fleet_genesis_founders (genesis_id, ordinal, agent_id) VALUES (p_id, i, v_agent);
    v_ids := v_ids || v_agent;
  END LOOP;
  UPDATE fleet_genesis SET status = 'attesting', founder_ids = v_ids WHERE genesis_id = p_id RETURNING * INTO g;
  PERFORM fleet_event('genesis_provisioned', NULL, p_actor, jsonb_build_object('genesisId', p_id, 'founderIds', to_jsonb(v_ids)));
  PERFORM fleet_genesis_end();
  RETURN fleet_genesis_json(g);
END $$;

-- Attest one founder's runtime/workspace. Any mismatch fails the WHOLE Genesis (rolled back here).
CREATE FUNCTION fleet_genesis_attest(p_id uuid, p_agent text, p_evidence jsonb, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE g fleet_genesis; f fleet_genesis_founders; a fleet_agents; st fleet_state; v_bad text;
BEGIN
  PERFORM fleet_genesis_owner(p_actor);
  g := fleet_genesis_lock(p_id);
  IF g.status <> 'attesting' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: Genesis % is %', p_id, g.status; END IF;
  SELECT * INTO f FROM fleet_genesis_founders WHERE genesis_id = p_id AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: % is not a founder of Genesis %', p_agent, p_id; END IF;
  IF f.status <> 'provisioned' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: founder already %', f.status; END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent;
  SELECT * INTO st FROM fleet_state WHERE id = 1;
  IF now() >= g.expires_at THEN v_bad := 'authorization expired';
  ELSIF p_evidence IS NULL OR jsonb_typeof(p_evidence) <> 'object' THEN v_bad := 'no evidence';
  ELSIF p_evidence ->> 'commit' IS DISTINCT FROM g.runtime_commit OR p_evidence ->> 'buildId' IS DISTINCT FROM g.runtime_build_id
     OR p_evidence ->> 'lockfileSha256' IS DISTINCT FROM g.runtime_lockfile_sha256 THEN v_bad := 'runtime identity differs from the authorization';
  ELSIF st.runtime_commit IS DISTINCT FROM g.runtime_commit OR st.runtime_build_id IS DISTINCT FROM g.runtime_build_id THEN v_bad := 'approved runtime changed';
  ELSIF p_evidence ->> 'manifestSha256' IS DISTINCT FROM g.manifest_sha256 THEN v_bad := 'capability manifest differs';
  ELSIF p_evidence ->> 'workspaceId' IS DISTINCT FROM a.workspace_id OR p_evidence ->> 'stateNamespace' IS DISTINCT FROM a.state_namespace THEN
    v_bad := 'workspace/state isolation identity differs';
  END IF;
  IF v_bad IS NOT NULL THEN
    PERFORM fleet_event('genesis_attestation_failed', p_agent, p_actor, jsonb_build_object('genesisId', p_id, 'why', v_bad));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_GENESIS_ATTESTATION_FAILED', 'why', v_bad)
      || fleet_genesis_rollback(p_id, 'attestation failed for ' || p_agent || ': ' || v_bad, p_actor);
  END IF;
  PERFORM fleet_genesis_begin(p_id, p_actor);
  UPDATE fleet_genesis_founders SET status = 'attested', attested_at = now(),
         attestation = jsonb_build_object('commit', g.runtime_commit, 'buildId', g.runtime_build_id, 'lockfileSha256', g.runtime_lockfile_sha256,
           'manifestSha256', g.manifest_sha256, 'workspaceId', a.workspace_id, 'stateNamespace', a.state_namespace, 'attestedBy', p_actor)
   WHERE genesis_id = p_id AND agent_id = p_agent;
  UPDATE fleet_agents SET status = 'provisioning', updated_at = now() WHERE agent_id = p_agent;
  PERFORM fleet_event('genesis_founder_attested', p_agent, p_actor, jsonb_build_object('genesisId', p_id));
  IF NOT EXISTS (SELECT 1 FROM fleet_genesis_founders WHERE genesis_id = p_id AND status = 'provisioned') THEN
    UPDATE fleet_genesis SET status = 'funding_virtual' WHERE genesis_id = p_id;
  END IF;
  PERFORM fleet_genesis_end();
  RETURN jsonb_build_object('ok', true, 'genesis', fleet_genesis_json(fleet_genesis_lock(p_id)));
END $$;

-- Owner-reported failure of an external step (e.g. a founder's workspace could not be provisioned).
CREATE FUNCTION fleet_genesis_fail(p_id uuid, p_agent text, p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM fleet_genesis_owner(p_actor);
  PERFORM fleet_event('genesis_founder_failed', p_agent, p_actor, jsonb_build_object('genesisId', p_id, 'reason', left(fleet_scrub(p_reason), 200)));
  RETURN fleet_genesis_rollback(p_id, 'founder ' || COALESCE(p_agent, '?') || ' failed: ' || COALESCE(p_reason, ''), p_actor);
END $$;

-- Virtual starting capital through the ledger (never a wallet transfer). All founders or none.
CREATE FUNCTION fleet_genesis_fund(p_id uuid, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE g fleet_genesis; f fleet_genesis_founders; v_j uuid;
BEGIN
  PERFORM fleet_genesis_owner(p_actor);
  g := fleet_genesis_lock(p_id);
  IF g.status <> 'funding_virtual' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: Genesis % is %', p_id, g.status; END IF;
  IF now() >= g.expires_at THEN RETURN fleet_genesis_rollback(p_id, 'authorization expired before funding', p_actor); END IF;
  IF fleet_economic_policy_sha256() <> g.economic_policy_sha256 THEN
    RAISE EXCEPTION 'FLEET_POLICY_CHANGED: the economic policy changed since authorization';
  END IF;
  IF fleet_ledger_balance('fleet:treasury:unallocated') < g.allocation_cents * g.founder_count THEN
    RAISE EXCEPTION 'FLEET_INSUFFICIENT_TREASURY: % needed for % founders', g.allocation_cents * g.founder_count, g.founder_count;
  END IF;
  PERFORM fleet_genesis_begin(p_id, p_actor);
  FOR f IN SELECT * FROM fleet_genesis_founders WHERE genesis_id = p_id ORDER BY ordinal FOR UPDATE LOOP
    v_j := NULL;
    IF g.allocation_cents > 0 THEN
      v_j := fleet_ledger_post('genesis_allocation', 'genesis:' || p_id || ':alloc:' || f.agent_id, p_actor, 'Genesis virtual starting allocation',
        'owner', f.agent_id, NULL, p_id::text, NULL, NULL, now(), jsonb_build_array(
          jsonb_build_object('account', fleet_ledger_account(f.agent_id, 'agent_cash'), 'side', 'D', 'amount', g.allocation_cents),
          jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', g.allocation_cents)));
    END IF;
    UPDATE fleet_genesis_founders SET status = 'funded', allocation_journal_id = v_j WHERE genesis_id = p_id AND ordinal = f.ordinal;
  END LOOP;
  UPDATE fleet_genesis SET status = 'ready' WHERE genesis_id = p_id RETURNING * INTO g;
  PERFORM fleet_event('genesis_funded', NULL, p_actor, jsonb_build_object('genesisId', p_id, 'perFounderCents', g.allocation_cents, 'virtual', true));
  PERFORM fleet_genesis_end();
  RETURN fleet_genesis_json(g);
END $$;

-- Activation: the owner gate. Every founder gets its credential and becomes active in ONE transaction.
CREATE FUNCTION fleet_genesis_activate(p_id uuid, p_auth_sha256 text, p_token_hashes text[], p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE g fleet_genesis; f fleet_genesis_founders; st fleet_state; i integer := 0;
BEGIN
  PERFORM fleet_genesis_owner(p_actor);
  g := fleet_genesis_lock(p_id);
  IF NOT (SELECT genesis_enabled FROM fleet_genesis_policy WHERE id = 1) THEN RAISE EXCEPTION 'FLEET_GENESIS_DISABLED: the owner has not enabled Genesis'; END IF;
  IF g.status <> 'ready' THEN RAISE EXCEPTION 'FLEET_GENESIS_CONSUMED: Genesis % is %', p_id, g.status; END IF;
  IF p_auth_sha256 IS DISTINCT FROM g.auth_sha256 THEN RAISE EXCEPTION 'FLEET_GENESIS_TAMPERED: activation does not match the authorization content'; END IF;
  IF now() >= g.expires_at THEN RETURN fleet_genesis_rollback(p_id, 'authorization expired before activation', p_actor); END IF;
  st := fleet_lock_state();
  IF st.runtime_commit IS DISTINCT FROM g.runtime_commit OR st.runtime_build_id IS DISTINCT FROM g.runtime_build_id
     OR st.runtime_lockfile_sha256 IS DISTINCT FROM g.runtime_lockfile_sha256 THEN
    RAISE EXCEPTION 'FLEET_RUNTIME_MISMATCH: the approved runtime changed since authorization';
  END IF;
  IF fleet_economic_policy_sha256() <> g.economic_policy_sha256
     OR (SELECT manifest_sha256 FROM fleet_capability_manifests WHERE manifest_id = g.manifest_id) <> g.manifest_sha256 THEN
    RAISE EXCEPTION 'FLEET_POLICY_CHANGED: economic or capability policy changed since authorization';
  END IF;
  IF p_token_hashes IS NULL OR cardinality(p_token_hashes) <> g.founder_count
     OR (SELECT count(DISTINCT h) FROM unnest(p_token_hashes) h WHERE h ~ '^[0-9a-f]{64}$') <> g.founder_count THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: one distinct credential hash per founder';
  END IF;
  PERFORM fleet_genesis_begin(p_id, p_actor);
  FOR f IN SELECT * FROM fleet_genesis_founders WHERE genesis_id = p_id ORDER BY ordinal FOR UPDATE LOOP
    i := i + 1;
    IF f.status <> 'funded' THEN RAISE EXCEPTION 'FLEET_GENESIS_INCONSISTENT: founder % is %', f.agent_id, f.status; END IF;
    UPDATE fleet_agents SET status = 'active', last_heartbeat = now(), updated_at = now(), status_reason = 'Genesis founder activated'
     WHERE agent_id = f.agent_id AND status = 'provisioning';
    IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_GENESIS_INCONSISTENT: founder % is not provisioning', f.agent_id; END IF;
    INSERT INTO fleet_agent_credentials (agent_id, token_hash) VALUES (f.agent_id, p_token_hashes[i]);
    UPDATE fleet_genesis_founders SET status = 'active' WHERE genesis_id = p_id AND ordinal = f.ordinal;
    PERFORM fleet_event('credential_issued', f.agent_id, p_actor, jsonb_build_object('genesisId', p_id));
  END LOOP;
  UPDATE fleet_genesis SET status = 'activated', activated_by = p_actor, activated_at = now(), consumed_at = now() WHERE genesis_id = p_id RETURNING * INTO g;
  PERFORM fleet_event('genesis_activated', NULL, p_actor, jsonb_build_object('genesisId', p_id, 'founderIds', to_jsonb(g.founder_ids)));
  PERFORM fleet_genesis_end();
  RETURN fleet_genesis_json(g);
END $$;

-- Reaper: an in-flight Genesis past expiry is closed (before provisioning) or rolled back (after).
CREATE FUNCTION svc_genesis_expire(p_limit integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE g fleet_genesis; n integer := 0;
BEGIN
  FOR g IN SELECT * FROM fleet_genesis WHERE status IN ('proposed','approved','provisioning','attesting','funding_virtual','ready')
             AND expires_at <= now() ORDER BY requested_at LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50) LOOP
    IF g.status IN ('proposed','approved') THEN
      PERFORM fleet_genesis_begin(g.genesis_id, 'controller');
      UPDATE fleet_genesis SET status = 'expired', status_reason = 'expired (reaper)' WHERE genesis_id = g.genesis_id;
      PERFORM fleet_genesis_end();
    ELSE
      PERFORM fleet_genesis_rollback(g.genesis_id, 'expired (reaper)', 'controller');
    END IF;
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- ═══ Organisation Identity vault (F8): scoped per-claim release; empty in v11 ═
CREATE TABLE fleet_org_identity_facts (
  fact_key     text        PRIMARY KEY CHECK (fact_key IN ('legal_name','trading_name','company_registration','tax_identifier','registered_address',
                                                          'contact_email','bank_account_owner','regulatory_status','website')),
  sensitivity  text        NOT NULL CHECK (sensitivity IN ('public','restricted','secret')),
  value        text        NOT NULL CHECK (length(value) BETWEEN 1 AND 500),
  value_sha256 text        NOT NULL CHECK (value_sha256 ~ '^[0-9a-f]{64}$'),
  set_by       text        NOT NULL CHECK (set_by ~ '^operator:[A-Za-z0-9._-]{1,64}$'),
  set_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_org_identity_facts_no_truncate BEFORE TRUNCATE ON fleet_org_identity_facts
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
CREATE TABLE fleet_org_identity_claims (
  claim_id     uuid        PRIMARY KEY,
  agent_id     text        NOT NULL REFERENCES fleet_agents(agent_id),
  fact_key     text        NOT NULL,
  purpose      text        NOT NULL CHECK (length(purpose) BETWEEN 1 AND 300),
  workflow     text        NOT NULL CHECK (workflow ~ '^[a-z0-9_.-]{1,64}$'),
  status       text        NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','rejected','revoked')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by   text,
  decided_at   timestamptz,
  expires_at   timestamptz,
  max_reads    integer     CHECK (max_reads BETWEEN 1 AND 100),
  reads        integer     NOT NULL DEFAULT 0 CHECK (reads >= 0),
  CHECK (status <> 'approved' OR (expires_at IS NOT NULL AND max_reads IS NOT NULL AND decided_by IS NOT NULL))
);
CREATE TRIGGER fleet_org_identity_claims_no_delete BEFORE DELETE ON fleet_org_identity_claims
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION api_identity_request(p_agent text, p_token text, p_fact_key text, p_purpose text, p_workflow text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'identity_request'); v_id uuid := gen_random_uuid();
BEGIN
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_code); END IF;
  IF NOT fleet_agent_can(p_agent, 'identity.claim_request') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CAPABILITY_DENIED'); END IF;
  IF p_fact_key IS NULL OR p_fact_key !~ '^[a-z_]{1,40}$' OR p_workflow IS NULL OR p_workflow !~ '^[a-z0-9_.-]{1,64}$'
     OR p_purpose IS NULL OR length(p_purpose) NOT BETWEEN 1 AND 300 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  IF (SELECT count(*) FROM fleet_org_identity_claims WHERE agent_id = p_agent AND status = 'requested') >= 5 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_RATE_LIMITED');
  END IF;
  INSERT INTO fleet_org_identity_claims (claim_id, agent_id, fact_key, purpose, workflow)
    VALUES (v_id, p_agent, p_fact_key, left(fleet_scrub(p_purpose), 300), p_workflow);
  PERFORM fleet_event('identity_claim_requested', p_agent, p_agent, jsonb_build_object('claimId', v_id, 'factKey', p_fact_key, 'workflow', p_workflow));
  RETURN jsonb_build_object('ok', true, 'claimId', v_id, 'status', 'requested');
END $$;

-- Release exactly one approved fact for one approved claim; secret facts are never released to agents; nothing is listable.
CREATE FUNCTION api_identity_fact(p_agent text, p_token text, p_claim uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'identity_fact'); c fleet_org_identity_claims; f fleet_org_identity_facts;
BEGIN
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_code); END IF;
  IF NOT fleet_agent_can(p_agent, 'identity.claim_request') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CAPABILITY_DENIED'); END IF;
  SELECT * INTO c FROM fleet_org_identity_claims WHERE claim_id = p_claim AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF c.status <> 'approved' OR now() >= c.expires_at OR c.reads >= c.max_reads THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_IDENTITY_CLAIM_NOT_ACTIVE');
  END IF;
  SELECT * INTO f FROM fleet_org_identity_facts WHERE fact_key = c.fact_key;
  IF NOT FOUND OR f.sensitivity = 'secret' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_IDENTITY_FACT_UNAVAILABLE'); END IF;
  UPDATE fleet_org_identity_claims SET reads = reads + 1 WHERE claim_id = p_claim;
  PERFORM fleet_event('identity_fact_released', p_agent, p_agent, jsonb_build_object('claimId', p_claim, 'factKey', c.fact_key, 'valueSha256', f.value_sha256));
  RETURN jsonb_build_object('ok', true, 'factKey', c.fact_key, 'value', f.value);
END $$;

CREATE FUNCTION fleet_org_identity_decide(p_claim uuid, p_approve boolean, p_ttl_s integer, p_max_reads integer, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_org_identity_claims;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  SELECT * INTO c FROM fleet_org_identity_claims WHERE claim_id = p_claim FOR UPDATE;
  IF NOT FOUND OR c.status <> 'requested' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: claim is not pending'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), c.agent_id);
  UPDATE fleet_org_identity_claims SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END, decided_by = p_actor, decided_at = now(),
         expires_at = CASE WHEN p_approve THEN now() + make_interval(secs => LEAST(GREATEST(COALESCE(p_ttl_s, 3600), 60), 604800)) END,
         max_reads = CASE WHEN p_approve THEN LEAST(GREATEST(COALESCE(p_max_reads, 1), 1), 100) END
   WHERE claim_id = p_claim RETURNING * INTO c;
  PERFORM fleet_event('identity_claim_decided', c.agent_id, p_actor, jsonb_build_object('claimId', p_claim, 'status', c.status));
  RETURN jsonb_build_object('claimId', p_claim, 'status', c.status, 'expiresAt', c.expires_at, 'maxReads', c.max_reads);
END $$;

-- Owner-only: store an authoritative fact (never done in Phase F; no secrets are placed here by Claude).
CREATE FUNCTION fleet_org_identity_set(p_fact_key text, p_value text, p_sensitivity text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_identity');
  INSERT INTO fleet_org_identity_facts (fact_key, sensitivity, value, value_sha256, set_by)
    VALUES (p_fact_key, p_sensitivity, p_value, encode(sha256(convert_to(p_value, 'UTF8')), 'hex'), p_actor)
    ON CONFLICT (fact_key) DO UPDATE SET sensitivity = EXCLUDED.sensitivity, value = EXCLUDED.value, value_sha256 = EXCLUDED.value_sha256,
      set_by = EXCLUDED.set_by, set_at = now();
  -- Changing a fact revokes every outstanding claim on it.
  UPDATE fleet_org_identity_claims SET status = 'revoked' WHERE fact_key = p_fact_key AND status IN ('requested','approved');
  PERFORM fleet_event('identity_fact_set', NULL, p_actor, jsonb_build_object('factKey', p_fact_key, 'sensitivity', p_sensitivity,
    'valueSha256', encode(sha256(convert_to(p_value, 'UTF8')), 'hex')));
  RETURN jsonb_build_object('factKey', p_fact_key, 'sensitivity', p_sensitivity);
END $$;

-- Owner-only: register a fleet-controlled reference (treasury account, owner wallet …) by its SHA-256.
CREATE FUNCTION fleet_controlled_reference_add(p_reference_sha256 text, p_label text, p_actor text) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  INSERT INTO fleet_controlled_references (reference_sha256, label, added_by) VALUES (p_reference_sha256, left(fleet_scrub(p_label), 100), p_actor)
    ON CONFLICT DO NOTHING;
END $$;

-- ═══ Institutional knowledge (F10) ═══════════════════════════════════════
CREATE TABLE fleet_knowledge_proposals (
  proposal_id     uuid        PRIMARY KEY,
  agent_id        text        NOT NULL REFERENCES fleet_agents(agent_id),
  lineage_root    text,
  genesis_id      uuid,
  category        text        NOT NULL CHECK (category IN ('market','customer','supplier','technique','failure','policy','other')),
  title           text        NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  content         text        NOT NULL CHECK (length(content) BETWEEN 1 AND 8000),
  content_sha256  text        NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  status          text        NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','promoted','rejected')),
  submitted_at    timestamptz NOT NULL DEFAULT now(),
  reviewed_by     text,
  reviewed_at     timestamptz
);
CREATE TABLE fleet_knowledge_entries (
  seq             bigserial   UNIQUE,
  entry_id        uuid        PRIMARY KEY,
  proposal_id     uuid        NOT NULL UNIQUE REFERENCES fleet_knowledge_proposals(proposal_id),
  origin_agent_id text        NOT NULL REFERENCES fleet_agents(agent_id),
  origin_lineage_root text,
  origin_genesis_id uuid,
  category        text        NOT NULL,
  title           text        NOT NULL,
  content         text        NOT NULL,
  content_sha256  text        NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  promoted_by     text        NOT NULL CHECK (promoted_by ~ '^operator:[A-Za-z0-9._-]{1,64}$'),
  promoted_at     timestamptz NOT NULL DEFAULT now(),
  note            text        CHECK (length(note) <= 300)
);
CREATE FUNCTION fleet_knowledge_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_knowledge_proposals;
BEGIN
  IF TG_TABLE_NAME = 'fleet_knowledge_proposals' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.content_sha256 := encode(sha256(convert_to(NEW.content, 'UTF8')), 'hex');
      IF NEW.status <> 'proposed' THEN RAISE EXCEPTION 'FLEET_KNOWLEDGE_INVALID: proposals start proposed'; END IF;
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - ARRAY['status','reviewed_by','reviewed_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','reviewed_by','reviewed_at'])
       OR OLD.status <> 'proposed' THEN
      RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: a knowledge proposal is reviewed once and never edited';
    END IF;
    RETURN NEW;
  END IF;
  -- entries: provenance is copied from the proposal, never supplied.
  SELECT * INTO p FROM fleet_knowledge_proposals WHERE proposal_id = NEW.proposal_id;
  IF p.status <> 'promoted' OR NEW.origin_agent_id IS DISTINCT FROM p.agent_id OR NEW.content IS DISTINCT FROM p.content
     OR NEW.content_sha256 IS DISTINCT FROM p.content_sha256 OR NEW.content_sha256 <> encode(sha256(convert_to(NEW.content, 'UTF8')), 'hex')
     OR NEW.origin_lineage_root IS DISTINCT FROM p.lineage_root OR NEW.origin_genesis_id IS DISTINCT FROM p.genesis_id
     OR NEW.title IS DISTINCT FROM p.title OR NEW.category IS DISTINCT FROM p.category THEN
    RAISE EXCEPTION 'FLEET_KNOWLEDGE_PROVENANCE: an entry must match its promoted proposal exactly';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_knowledge_proposals_guard BEFORE INSERT OR UPDATE ON fleet_knowledge_proposals
  FOR EACH ROW EXECUTE FUNCTION fleet_knowledge_guard();
CREATE TRIGGER fleet_knowledge_entries_guard BEFORE INSERT ON fleet_knowledge_entries
  FOR EACH ROW EXECUTE FUNCTION fleet_knowledge_guard();
CREATE TRIGGER fleet_knowledge_proposals_no_delete BEFORE DELETE ON fleet_knowledge_proposals
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_knowledge_entries_no_change BEFORE UPDATE OR DELETE ON fleet_knowledge_entries
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_knowledge_entries_no_truncate BEFORE TRUNCATE ON fleet_knowledge_entries
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION api_knowledge_propose(p_agent text, p_token text, p_category text, p_title text, p_content text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'knowledge_propose'); a fleet_agents; v_id uuid := gen_random_uuid();
BEGIN
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_code); END IF;
  IF NOT fleet_agent_can(p_agent, 'knowledge.propose') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CAPABILITY_DENIED'); END IF;
  IF p_category NOT IN ('market','customer','supplier','technique','failure','policy','other') OR p_title IS NULL OR length(p_title) NOT BETWEEN 1 AND 200
     OR p_content IS NULL OR length(p_content) NOT BETWEEN 1 AND 8000 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  IF (SELECT count(*) FROM fleet_knowledge_proposals WHERE agent_id = p_agent AND submitted_at > now() - interval '1 day') >= 20 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_RATE_LIMITED');
  END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent;
  INSERT INTO fleet_knowledge_proposals (proposal_id, agent_id, lineage_root, genesis_id, category, title, content, content_sha256)
    VALUES (v_id, p_agent, a.lineage_root, a.genesis_id, p_category, left(fleet_scrub(p_title), 200), fleet_scrub_long(p_content), repeat('0', 64));
  PERFORM fleet_event('knowledge_proposed', p_agent, p_agent, jsonb_build_object('proposalId', v_id, 'category', p_category));
  RETURN jsonb_build_object('ok', true, 'proposalId', v_id, 'status', 'proposed');
END $$;

-- fleet_scrub caps at 500 chars; knowledge content keeps up to 8000 with the same redactions.
CREATE FUNCTION fleet_scrub_long(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT left(regexp_replace(regexp_replace(COALESCE(t, ''),
           '0x[0-9a-fA-F]{64}', '[redacted]', 'g'),
           '[a-zA-Z][a-zA-Z0-9+.-]*://[^[:space:]:@/]+:[^[:space:]@/]+@', '[redacted]@', 'g'), 8000)
$$;

CREATE FUNCTION api_knowledge_list(p_agent text, p_token text, p_after bigint, p_limit integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'knowledge_list');
BEGIN
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_code); END IF;
  IF NOT fleet_agent_can(p_agent, 'knowledge.read') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CAPABILITY_DENIED'); END IF;
  RETURN jsonb_build_object('ok', true, 'entries', (SELECT COALESCE(jsonb_agg(jsonb_build_object('seq', e.seq, 'entryId', e.entry_id,
      'category', e.category, 'title', e.title, 'content', e.content, 'contentSha256', e.content_sha256,
      'originAgentId', e.origin_agent_id, 'originLineageRoot', e.origin_lineage_root, 'promotedBy', e.promoted_by, 'promotedAt', e.promoted_at)
      ORDER BY e.seq), '[]'::jsonb)
    FROM (SELECT * FROM fleet_knowledge_entries WHERE seq > COALESCE(p_after, 0) ORDER BY seq LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)) e));
END $$;

CREATE FUNCTION fleet_knowledge_review(p_proposal uuid, p_promote boolean, p_note text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_knowledge_proposals; v_entry uuid;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  SELECT * INTO p FROM fleet_knowledge_proposals WHERE proposal_id = p_proposal FOR UPDATE;
  IF NOT FOUND OR p.status <> 'proposed' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: proposal is not pending'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), p.agent_id);
  UPDATE fleet_knowledge_proposals SET status = CASE WHEN p_promote THEN 'promoted' ELSE 'rejected' END, reviewed_by = p_actor, reviewed_at = now()
   WHERE proposal_id = p_proposal;
  IF p_promote THEN
    v_entry := gen_random_uuid();
    INSERT INTO fleet_knowledge_entries (entry_id, proposal_id, origin_agent_id, origin_lineage_root, origin_genesis_id, category, title, content,
        content_sha256, promoted_by, note)
      VALUES (v_entry, p.proposal_id, p.agent_id, p.lineage_root, p.genesis_id, p.category, p.title, p.content, p.content_sha256, p_actor, left(fleet_scrub(p_note), 300));
  END IF;
  PERFORM fleet_event(CASE WHEN p_promote THEN 'knowledge_promoted' ELSE 'knowledge_rejected' END, p.agent_id, p_actor,
    jsonb_build_object('proposalId', p_proposal, 'entryId', v_entry));
  RETURN jsonb_build_object('proposalId', p_proposal, 'status', CASE WHEN p_promote THEN 'promoted' ELSE 'rejected' END, 'entryId', v_entry);
END $$;

-- ═══ Capabilities surface for agents ════════════════════════════════════
CREATE FUNCTION api_capabilities(p_agent text, p_token text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'capabilities'); a fleet_agents; m fleet_capability_manifests;
BEGIN
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_code); END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent;
  SELECT * INTO m FROM fleet_capability_manifests WHERE manifest_id = a.capability_manifest_id;
  RETURN jsonb_build_object('ok', true, 'origin', a.origin, 'manifestId', m.manifest_id, 'manifestSha256', m.manifest_sha256,
    'allowed', to_jsonb(m.allowed), 'reproductionExecutable', false, 'paymentExecutable', false);
END $$;

-- Capability enforcement for the v10 economic surface (founders and any manifest-bearing agent).
CREATE OR REPLACE FUNCTION api_ledger_summary(p_agent text, p_token text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'ledger_summary');
BEGIN
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_code); END IF;
  IF NOT fleet_agent_can(p_agent, 'ledger.read') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CAPABILITY_DENIED'); END IF;
  IF NOT EXISTS (SELECT 1 FROM fleet_ledger_accounts WHERE agent_id = p_agent) THEN
    RETURN jsonb_build_object('ok', true, 'economics', NULL);
  END IF;
  RETURN jsonb_build_object('ok', true, 'economics', fleet_agent_economics(p_agent));
END $$;

CREATE FUNCTION fleet_spend_capability_gate() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF NEW.order_type = 'agent_spend' AND NOT fleet_agent_can(NEW.agent_id, 'spend.request') THEN
    RAISE EXCEPTION 'FLEET_CAPABILITY_DENIED: spend.request is not in this agent''s capability manifest';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_orders_capability_gate BEFORE INSERT ON fleet_payment_orders
  FOR EACH ROW EXECUTE FUNCTION fleet_spend_capability_gate();

-- ═══ Death / estate integration (F11) ═══════════════════════════════════
-- Lifecycle-internal estate operations (no owner actor): same effects as the owner forms.
CREATE FUNCTION fleet_estate_freeze(p_agent text, p_actor text) RETURNS integer LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_payment_orders; n integer := 0;
BEGIN
  UPDATE fleet_agent_sessions SET revoked_at = now() WHERE agent_id = p_agent AND revoked_at IS NULL;
  UPDATE fleet_agent_credentials SET revoked_at = now() WHERE agent_id = p_agent AND revoked_at IS NULL;
  IF NOT EXISTS (SELECT 1 FROM fleet_ledger_accounts WHERE agent_id = p_agent) THEN RETURN 0; END IF;
  INSERT INTO fleet_estates (agent_id, opened_by) VALUES (p_agent, left(p_actor, 128)) ON CONFLICT (agent_id) DO NOTHING;
  FOR o IN SELECT * FROM fleet_payment_orders WHERE agent_id = p_agent AND status IN ('awaiting_owner','reserved') ORDER BY seq FOR UPDATE LOOP
    PERFORM fleet_order_release(o, 'cancelled', p_actor, 'controller', 'FLEET_ESTATE_FREEZE');
    n := n + 1;
  END LOOP;
  PERFORM fleet_event('estate_frozen', p_agent, p_actor, jsonb_build_object('ordersCancelled', n));
  RETURN n;
END $$;

-- Freeze economic authority the moment an agent leaves the living, trusted states (death, failure,
-- quarantine). Compute termination is a separate queue; economic death does not wait for it.
CREATE FUNCTION fleet_agents_death_freeze() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF NEW.status IN ('dead','failed','terminating','orphaned') AND OLD.status NOT IN ('dead','failed','terminating','orphaned') THEN
    BEGIN
      PERFORM fleet_estate_freeze(NEW.agent_id, 'lifecycle');
    EXCEPTION WHEN OTHERS THEN
      -- Never block the lifecycle transition itself; the agent has no authority anyway (dead agents cannot authenticate).
      PERFORM fleet_event('estate_freeze_failed', NEW.agent_id, 'lifecycle', jsonb_build_object('error', left(SQLERRM, 200)));
    END;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER fleet_agents_death_freeze AFTER UPDATE OF status ON fleet_agents
  FOR EACH ROW EXECUTE FUNCTION fleet_agents_death_freeze();

-- Settle an open estate (principal recovery, write-off, residual to treasury, asset ownership) — internal form.
CREATE FUNCTION fleet_estate_settle_internal(p_agent text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE es fleet_estates; ag fleet_agents; v_cash bigint; v_principal bigint; v_rec bigint; v_assets bigint; v_wo bigint; s jsonb;
BEGIN
  SELECT * INTO es FROM fleet_estates WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND OR es.status <> 'open' THEN RAISE EXCEPTION 'FLEET_ESTATE_INVALID: no open estate'; END IF;
  SELECT * INTO ag FROM fleet_agents WHERE agent_id = p_agent;
  IF ag.status NOT IN ('dead','failed') THEN RAISE EXCEPTION 'FLEET_ESTATE_INVALID: settle only after economic death (agent is %)', ag.status; END IF;
  IF EXISTS (SELECT 1 FROM fleet_payment_orders WHERE agent_id = p_agent AND status IN ('awaiting_owner','reserved','executing')) THEN
    RAISE EXCEPTION 'FLEET_ESTATE_PENDING: reconcile pending orders first';
  END IF;
  PERFORM fleet_ledger_open_agent(p_agent, p_actor);
  v_cash := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_cash'));
  v_principal := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_principal'));
  v_rec := LEAST(v_cash, v_principal);
  IF v_rec > 0 THEN
    PERFORM fleet_ledger_post('estate_principal_recovery', 'estate:recover:' || p_agent, p_actor, 'estate: recover protected principal', 'owner', p_agent,
      NULL, NULL, NULL, NULL, now(), jsonb_build_array(
        jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_principal'), 'side', 'D', 'amount', v_rec),
        jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_cash'), 'side', 'C', 'amount', v_rec),
        jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', v_rec),
        jsonb_build_object('account', 'fleet:treasury:principal_receivable', 'side', 'C', 'amount', v_rec)));
  END IF;
  v_wo := v_principal - v_rec;
  IF v_wo > 0 THEN
    PERFORM fleet_ledger_post('estate_principal_writeoff', 'estate:writeoff:' || p_agent, p_actor, 'estate: unrecoverable principal', 'owner', p_agent,
      NULL, NULL, NULL, NULL, now(), jsonb_build_array(
        jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_principal'), 'side', 'D', 'amount', v_wo),
        jsonb_build_object('account', 'fleet:treasury:principal_receivable', 'side', 'C', 'amount', v_wo)));
  END IF;
  v_cash := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_cash'));
  v_assets := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_assets'));
  IF v_cash > 0 OR v_assets > 0 THEN
    PERFORM fleet_ledger_post('estate_transfer', 'estate:transfer:' || p_agent, p_actor, 'estate: remaining assets to the treasury', 'owner', p_agent,
      NULL, NULL, NULL, NULL, now(), (
        SELECT jsonb_agg(x) FROM (
          SELECT jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', v_cash) x WHERE v_cash > 0
          UNION ALL SELECT jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_cash'), 'side', 'C', 'amount', v_cash) WHERE v_cash > 0
          UNION ALL SELECT jsonb_build_object('account', 'fleet:assets', 'side', 'D', 'amount', v_assets) WHERE v_assets > 0
          UNION ALL SELECT jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_assets'), 'side', 'C', 'amount', v_assets) WHERE v_assets > 0) q));
  END IF;
  UPDATE fleet_assets SET economic_owner_account = 'fleet:assets', authority_agent_id = NULL WHERE authority_agent_id = p_agent;
  s := jsonb_build_object('principalRecovered', v_rec, 'principalWrittenOff', v_wo, 'cashToTreasury', v_cash, 'assetsToTreasury', v_assets);
  UPDATE fleet_estates SET status = 'settled', settled_at = now(), settled_by = left(p_actor, 128), summary = s WHERE agent_id = p_agent;
  PERFORM fleet_event('estate_settled', p_agent, p_actor, s);
  RETURN jsonb_build_object('status', 'settled') || s;
END $$;

-- Owner forms (v10 signatures) delegate to the internal forms.
CREATE OR REPLACE FUNCTION fleet_estate_open(p_agent text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE ag fleet_agents; n integer;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  SELECT * INTO ag FROM fleet_agents WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND OR ag.status NOT IN ('dead','failed','orphaned','terminating') THEN
    RAISE EXCEPTION 'FLEET_ESTATE_INVALID: estates are opened only for agents that are dying or dead';
  END IF;
  PERFORM fleet_ledger_open_agent(p_agent, p_actor);
  n := fleet_estate_freeze(p_agent, p_actor);
  RETURN jsonb_build_object('status', 'open', 'ordersCancelled', n,
    'executingOrders', (SELECT count(*) FROM fleet_payment_orders WHERE agent_id = p_agent AND status = 'executing'));
END $$;

CREATE OR REPLACE FUNCTION fleet_estate_settle(p_agent text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  RETURN fleet_estate_settle_internal(p_agent, p_actor);
END $$;

-- Reaper: settle open estates of economically dead agents with nothing in flight.
CREATE FUNCTION svc_settle_estates(p_limit integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r record; n integer := 0;
BEGIN
  FOR r IN SELECT e.agent_id FROM fleet_estates e JOIN fleet_agents a USING (agent_id)
            WHERE e.status = 'open' AND a.status IN ('dead','failed')
              AND NOT EXISTS (SELECT 1 FROM fleet_payment_orders o WHERE o.agent_id = e.agent_id AND o.status IN ('awaiting_owner','reserved','executing'))
            ORDER BY e.opened_at LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50) FOR UPDATE OF e SKIP LOCKED LOOP
    PERFORM fleet_estate_settle_internal(r.agent_id, 'controller');
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- ═══ Reproduction eligibility (inert; F12) ══════════════════════════════
CREATE FUNCTION fleet_reproduction_eligibility(p_agent text) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_agents; p fleet_reproduction_policy; e jsonb; st fleet_state; v_reasons text[] := ARRAY[]::text[]; v_monthly bigint; v_runway numeric;
        v_treasury bigint; v_reserve_target bigint; v_capital bigint; v_eff numeric;
BEGIN
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent;
  IF NOT FOUND THEN RETURN jsonb_build_object('eligible', false, 'executable', false, 'reasons', jsonb_build_array('unknown agent')); END IF;
  SELECT * INTO p FROM fleet_reproduction_policy WHERE id = 1;
  SELECT * INTO st FROM fleet_state WHERE id = 1;
  e := fleet_agent_economics(p_agent);
  SELECT COALESCE(sum(pp.amount_cents), 0) INTO v_monthly FROM fleet_ledger_postings pp JOIN fleet_ledger_journal j USING (journal_id)
   WHERE pp.account_id IN (fleet_ledger_account(p_agent, 'agent_expense'), fleet_ledger_account(p_agent, 'agent_fees')) AND pp.side = 'D'
     AND j.occurred_at > now() - interval '30 days';
  v_runway := CASE WHEN v_monthly = 0 THEN NULL ELSE (e ->> 'cash')::numeric / v_monthly * 30 END;
  v_capital := (e ->> 'genesisAllocation')::bigint + (e ->> 'treasuryAllocation')::bigint + (e ->> 'protectedPrincipal')::bigint;
  v_eff := CASE WHEN v_capital > 0 THEN (e ->> 'realizedNetProfit')::numeric / v_capital ELSE NULL END;
  v_treasury := fleet_ledger_balance('fleet:treasury:unallocated');
  IF a.status <> 'active' THEN v_reasons := v_reasons || 'not active'::text; END IF;
  IF a.activated_at IS NULL OR a.activated_at > now() - make_interval(days => p.min_age_days) THEN v_reasons := v_reasons || 'too young'::text; END IF;
  IF (e ->> 'externalCustomerRevenue')::bigint < p.min_external_revenue_cents THEN v_reasons := v_reasons || 'insufficient external customer revenue'::text; END IF;
  IF (e ->> 'realizedNetProfit')::bigint < p.min_realized_net_profit_cents THEN v_reasons := v_reasons || 'insufficient realized net profit'::text; END IF;
  IF (e ->> 'lifetimeContribution')::bigint < p.min_lifetime_contribution_cents THEN v_reasons := v_reasons || 'insufficient lifetime fleet contribution'::text; END IF;
  IF (e ->> 'protectedPrincipal')::bigint > p.max_protected_principal_cents THEN v_reasons := v_reasons || 'outstanding protected principal'::text; END IF;
  IF (e ->> 'protectedObligations')::bigint > 0 AND (e ->> 'survivalEquity')::bigint <= 0 THEN v_reasons := v_reasons || 'obligations exceed equity'::text; END IF;
  IF v_runway IS NOT NULL AND v_runway < p.min_runway_days THEN v_reasons := v_reasons || 'short runway'::text; END IF;
  IF v_eff IS NULL OR v_eff < p.min_capital_efficiency THEN v_reasons := v_reasons || 'capital efficiency below policy'::text; END IF;
  IF st.living_agents + st.reserved_slots + st.quarantined_slots >= st.max_agents THEN v_reasons := v_reasons || 'no fleet slot'::text; END IF;
  v_reasons := v_reasons || 'reproduction execution is constitutionally disabled'::text;
  RETURN jsonb_build_object('agentId', p_agent, 'eligible', false, 'executable', false,
    'meetsEconomicCriteria', cardinality(v_reasons) = 1, 'reasons', to_jsonb(v_reasons),
    'inputs', jsonb_build_object('realizedNetProfit', e -> 'realizedNetProfit', 'lifetimeContribution', e -> 'lifetimeContribution',
      'externalCustomerRevenue', e -> 'externalCustomerRevenue', 'protectedPrincipal', e -> 'protectedPrincipal',
      'obligations', e -> 'protectedObligations', 'runwayDays', v_runway, 'capitalEfficiency', v_eff,
      'freeSlots', st.max_agents - st.living_agents - st.reserved_slots - st.quarantined_slots, 'treasuryCents', v_treasury));
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

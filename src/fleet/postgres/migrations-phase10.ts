/**
 * Schema v10 — Phase E: central treasury, double-entry ledger and custody boundary (INERT).
 *
 * Invariant (E1): the fleet treasury owns custody; the ledger is the only
 * economic truth; agents hold virtual allocations and submit structured
 * spend orders; an isolated custody executor (own OS user and DB role)
 * executes already-authorized instructions. In v10 no instruction can be
 * issued: fleet_economic_model.custody_execution_enabled is pinned false by
 * a CHECK constraint (a constitutional custody invariant; enabling it needs a
 * reviewed migration, never an ordinary economic override).
 *
 * Ledger (E2): accounts belong to fixed classes; journal kinds may touch
 * only the (class, side) pairs of fleet_ledger_rules; every journal balances
 * (deferred constraint triggers), postings exist only in their journal's own
 * transaction, non-negative classes stay non-negative, history is append-only
 * (no UPDATE/DELETE/TRUNCATE) and hash-chained (fleet_ledger_verify).
 * Corrections are reversals. Balances are derived from postings.
 *
 * Agent economics (E3): survival equity = recoverable assets − protected
 * treasury principal − protected obligations. No spend (or contribution) may
 * make it negative; principal is purchasing capacity only for asset
 * acquisitions whose recoverable value covers it.
 *
 * LFC (E4): only profit_contribution journals may credit fleet:profit, and a
 * contribution cannot exceed the agent's realized net profit not yet
 * contributed (external revenue − expenses − fees − prior contributions).
 * Owner funding, principal, internal transfers and valuation changes cannot
 * reach it (rules table).
 *
 * Money amounts are integer cents (USD) everywhere.
 */

export const V10_SQL = `
-- ═══ Economic model (single row) ═════════════════════════════════════════
CREATE TABLE fleet_economic_model (
  id                              smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  ledger_authoritative            boolean     NOT NULL DEFAULT true CHECK (ledger_authoritative),
  legacy_superseded_at            timestamptz NOT NULL DEFAULT now(),
  -- Constitutional custody invariant (v10): nothing can be executed externally.
  custody_execution_enabled       boolean     NOT NULL DEFAULT false CHECK (NOT custody_execution_enabled),
  owner_approval_threshold_cents  bigint      NOT NULL DEFAULT 10000  CHECK (owner_approval_threshold_cents >= 0),
  agent_daily_spend_cents         bigint      NOT NULL DEFAULT 5000   CHECK (agent_daily_spend_cents >= 0),
  reservation_ttl_s               integer     NOT NULL DEFAULT 86400  CHECK (reservation_ttl_s BETWEEN 60 AND 604800),
  strong_auth_threshold_cents     bigint      NOT NULL DEFAULT 50000  CHECK (strong_auth_threshold_cents >= 0),
  destination_cooldown_s          integer     NOT NULL DEFAULT 259200 CHECK (destination_cooldown_s >= 3600),
  confirmation_ttl_s              integer     NOT NULL DEFAULT 900    CHECK (confirmation_ttl_s BETWEEN 60 AND 3600),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  updated_by                      text        NOT NULL DEFAULT 'migration'
);
INSERT INTO fleet_economic_model (id) VALUES (1);
CREATE TRIGGER fleet_economic_model_no_delete BEFORE DELETE ON fleet_economic_model
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_economic_model_no_truncate BEFORE TRUNCATE ON fleet_economic_model
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- ═══ Chart of accounts ═══════════════════════════════════════════════════
CREATE TABLE fleet_ledger_classes (
  class        text    PRIMARY KEY,
  kind         text    NOT NULL CHECK (kind IN ('asset','liability','equity','revenue','expense')),
  normal_side  char(1) NOT NULL CHECK (normal_side IN ('D','C')),
  scope        text    NOT NULL CHECK (scope IN ('fleet','agent')),
  non_negative boolean NOT NULL,
  description  text    NOT NULL
);
INSERT INTO fleet_ledger_classes (class, kind, normal_side, scope, non_negative, description) VALUES
  ('treasury_cash',                 'asset',     'D', 'fleet', true,  'Fleet treasury cash in custody, by partition'),
  ('treasury_principal_receivable', 'asset',     'D', 'fleet', true,  'Protected treasury principal advanced to agents'),
  ('treasury_assets',               'asset',     'D', 'fleet', true,  'Fleet-owned non-cash assets (at cost)'),
  ('custody_clearing',              'asset',     'D', 'fleet', true,  'Treasury cash reserved for an owner withdrawal in flight'),
  ('conway_credits',                'asset',     'D', 'fleet', true,  'Prepaid Conway compute credits'),
  ('fleet_expense',                 'expense',   'D', 'fleet', true,  'Fleet operating expenses and fees'),
  ('owner_capital',                 'equity',    'C', 'fleet', true,  'Capital contributed by the owner'),
  ('owner_withdrawals',             'equity',    'D', 'fleet', true,  'Capital returned to the owner (contra equity)'),
  ('fleet_profit',                  'equity',    'C', 'fleet', true,  'Lifetime Fleet Contribution: realized net profit contributed by agents'),
  ('unrealized_valuation',          'equity',    'C', 'fleet', false, 'Unrealized valuation changes (never profit)'),
  ('agent_cash',                    'asset',     'D', 'agent', true,  'Agent virtual cash allocation (available)'),
  ('agent_reserved',                'asset',     'D', 'agent', true,  'Agent cash reserved for an approved spend order'),
  ('agent_assets',                  'asset',     'D', 'agent', true,  'Fleet assets under an agent''s authority (at cost)'),
  ('agent_principal',               'liability', 'C', 'agent', true,  'Protected treasury principal owed by the agent'),
  ('agent_revenue',                 'revenue',   'C', 'agent', true,  'Realized external revenue'),
  ('agent_expense',                 'expense',   'D', 'agent', true,  'Realized external operating expenses'),
  ('agent_fees',                    'expense',   'D', 'agent', true,  'Fees'),
  ('agent_contributions',           'equity',    'D', 'agent', true,  'Realized profit contributed to the fleet (contra equity)');
CREATE TRIGGER fleet_ledger_classes_no_change BEFORE UPDATE OR DELETE ON fleet_ledger_classes
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_ledger_classes_no_truncate BEFORE TRUNCATE ON fleet_ledger_classes
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_ledger_accounts (
  account_id  text        PRIMARY KEY CHECK (account_id ~ '^(fleet|agent):[A-Za-z0-9_:.-]{1,120}$'),
  class       text        NOT NULL REFERENCES fleet_ledger_classes(class),
  agent_id    text        REFERENCES fleet_agents(agent_id),
  currency    text        NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  description text        NOT NULL CHECK (length(description) BETWEEN 1 AND 200),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text        NOT NULL,
  CHECK ((account_id LIKE 'agent:%') = (agent_id IS NOT NULL)),
  CHECK (agent_id IS NULL OR account_id LIKE 'agent:' || agent_id || ':%')
);
CREATE UNIQUE INDEX fleet_ledger_accounts_agent_class_uq ON fleet_ledger_accounts (agent_id, class) WHERE agent_id IS NOT NULL;
CREATE FUNCTION fleet_ledger_accounts_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_ledger_classes;
BEGIN
  SELECT * INTO c FROM fleet_ledger_classes WHERE class = NEW.class;
  IF (c.scope = 'agent') <> (NEW.agent_id IS NOT NULL) THEN
    RAISE EXCEPTION 'FLEET_LEDGER_INVALID: class % is % scoped', NEW.class, c.scope;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_ledger_accounts_guard BEFORE INSERT ON fleet_ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION fleet_ledger_accounts_guard();
CREATE TRIGGER fleet_ledger_accounts_no_change BEFORE UPDATE OR DELETE ON fleet_ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_ledger_accounts_no_truncate BEFORE TRUNCATE ON fleet_ledger_accounts
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

INSERT INTO fleet_ledger_accounts (account_id, class, description, created_by) VALUES
  ('fleet:treasury:unallocated',          'treasury_cash',                 'Treasury cash not earmarked', 'migration'),
  ('fleet:treasury:operating_reserve',    'treasury_cash',                 'Operating reserve', 'migration'),
  ('fleet:treasury:contingency',          'treasury_cash',                 'Contingency reserve', 'migration'),
  ('fleet:treasury:growth_pool',          'treasury_cash',                 'Approved growth capital pool', 'migration'),
  ('fleet:treasury:principal_receivable', 'treasury_principal_receivable', 'Protected principal advanced to agents', 'migration'),
  ('fleet:assets',                        'treasury_assets',               'Fleet-owned non-cash assets', 'migration'),
  ('fleet:custody:withdrawal_clearing',   'custody_clearing',              'Owner withdrawals in flight', 'migration'),
  ('fleet:conway_credits',                'conway_credits',                'Prepaid Conway credits', 'migration'),
  ('fleet:expense',                       'fleet_expense',                 'Fleet operating expenses', 'migration'),
  ('fleet:owner:capital',                 'owner_capital',                 'Owner contributed capital', 'migration'),
  ('fleet:owner:withdrawals',             'owner_withdrawals',             'Owner withdrawals (contra equity)', 'migration'),
  ('fleet:profit',                        'fleet_profit',                  'Lifetime Fleet Contribution', 'migration'),
  ('fleet:unrealized_valuation',          'unrealized_valuation',          'Unrealized valuation changes', 'migration');

-- ═══ Journal kinds and the posting grammar ═══════════════════════════════
CREATE TABLE fleet_ledger_kinds (
  kind                  text    PRIMARY KEY,
  requires_external_ref boolean NOT NULL,
  allowed_sources       text[]  NOT NULL CHECK (allowed_sources <@ ARRAY['owner','controller','executor']::text[]),
  multi_agent           boolean NOT NULL DEFAULT false,
  description           text    NOT NULL
);
INSERT INTO fleet_ledger_kinds (kind, requires_external_ref, allowed_sources, multi_agent, description) VALUES
  ('owner_funding',                true,  ARRAY['owner','executor'],            false, 'Owner capital received into custody'),
  ('treasury_reallocation',        false, ARRAY['owner'],                       false, 'Move treasury cash between partitions'),
  ('agent_capital_grant',          false, ARRAY['owner','controller'],          false, 'Allocate treasury cash to an agent as its own equity'),
  ('agent_capital_return',         false, ARRAY['owner','controller'],          false, 'Return agent cash to the treasury'),
  ('principal_advance',            false, ARRAY['owner'],                       false, 'Advance protected treasury principal to an agent'),
  ('principal_repayment',          false, ARRAY['owner','controller'],          false, 'Repay protected principal'),
  ('spend_reservation',            false, ARRAY['owner','controller'],          false, 'Reserve agent cash for an approved spend order'),
  ('spend_release',                false, ARRAY['owner','controller','executor'], false, 'Release a reservation (cancelled, expired, failed)'),
  ('spend_settlement',             true,  ARRAY['owner','executor'],            false, 'External settlement of an agent spend order'),
  ('external_revenue',             true,  ARRAY['owner','executor'],            false, 'Realized external revenue received into custody'),
  ('profit_contribution',          false, ARRAY['owner','controller'],          false, 'Realized net profit contributed to the fleet (LFC)'),
  ('fleet_expense_settlement',     true,  ARRAY['owner','executor'],            false, 'External settlement of a fleet expense'),
  ('conway_credits_purchase',      true,  ARRAY['owner','executor'],            false, 'Purchase of Conway credits'),
  ('conway_credits_consumption',   false, ARRAY['owner','controller'],          false, 'Consumption of Conway credits'),
  ('owner_withdrawal_reservation', false, ARRAY['owner'],                       false, 'Reserve treasury cash for an owner withdrawal'),
  ('owner_withdrawal_release',     false, ARRAY['owner','executor'],            false, 'Release an owner withdrawal reservation'),
  ('owner_withdrawal_settlement',  true,  ARRAY['owner','executor'],            false, 'External settlement of an owner withdrawal'),
  ('asset_valuation',              false, ARRAY['owner'],                       false, 'Unrealized valuation change (never profit)'),
  ('estate_principal_recovery',    false, ARRAY['owner'],                       false, 'Recover protected principal from a dead agent'),
  ('estate_principal_writeoff',    false, ARRAY['owner'],                       false, 'Write off unrecoverable internal principal'),
  ('estate_transfer',              false, ARRAY['owner'],                       false, 'Transfer a dead agent''s remaining assets to the treasury'),
  ('agent_transfer',               false, ARRAY['owner'],                       true,  'Owner-directed transfer between two agents'),
  ('reversal',                     false, ARRAY['owner'],                       true,  'Exact reversal of an earlier journal');
CREATE TRIGGER fleet_ledger_kinds_no_change BEFORE UPDATE OR DELETE ON fleet_ledger_kinds
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_ledger_kinds_no_truncate BEFORE TRUNCATE ON fleet_ledger_kinds
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_ledger_rules (
  kind  text    NOT NULL REFERENCES fleet_ledger_kinds(kind),
  class text    NOT NULL REFERENCES fleet_ledger_classes(class),
  side  char(1) NOT NULL CHECK (side IN ('D','C')),
  PRIMARY KEY (kind, class, side)
);
INSERT INTO fleet_ledger_rules (kind, class, side) VALUES
  ('owner_funding','treasury_cash','D'), ('owner_funding','owner_capital','C'),
  ('treasury_reallocation','treasury_cash','D'), ('treasury_reallocation','treasury_cash','C'),
  ('agent_capital_grant','agent_cash','D'), ('agent_capital_grant','treasury_cash','C'),
  ('agent_capital_return','treasury_cash','D'), ('agent_capital_return','agent_cash','C'),
  ('principal_advance','agent_cash','D'), ('principal_advance','treasury_cash','C'),
  ('principal_advance','treasury_principal_receivable','D'), ('principal_advance','agent_principal','C'),
  ('principal_repayment','treasury_cash','D'), ('principal_repayment','agent_cash','C'),
  ('principal_repayment','agent_principal','D'), ('principal_repayment','treasury_principal_receivable','C'),
  ('spend_reservation','agent_reserved','D'), ('spend_reservation','agent_cash','C'),
  ('spend_release','agent_cash','D'), ('spend_release','agent_reserved','C'),
  ('spend_settlement','agent_expense','D'), ('spend_settlement','agent_fees','D'), ('spend_settlement','agent_assets','D'),
  ('spend_settlement','agent_cash','D'), ('spend_settlement','agent_reserved','C'),
  ('external_revenue','agent_cash','D'), ('external_revenue','agent_revenue','C'),
  ('profit_contribution','treasury_cash','D'), ('profit_contribution','agent_cash','C'),
  ('profit_contribution','agent_contributions','D'), ('profit_contribution','fleet_profit','C'),
  ('fleet_expense_settlement','fleet_expense','D'), ('fleet_expense_settlement','treasury_cash','C'),
  ('conway_credits_purchase','conway_credits','D'), ('conway_credits_purchase','treasury_cash','C'),
  ('conway_credits_consumption','fleet_expense','D'), ('conway_credits_consumption','agent_expense','D'),
  ('conway_credits_consumption','conway_credits','C'),
  ('owner_withdrawal_reservation','custody_clearing','D'), ('owner_withdrawal_reservation','treasury_cash','C'),
  ('owner_withdrawal_release','treasury_cash','D'), ('owner_withdrawal_release','custody_clearing','C'),
  ('owner_withdrawal_settlement','owner_withdrawals','D'), ('owner_withdrawal_settlement','custody_clearing','C'),
  ('asset_valuation','agent_assets','D'), ('asset_valuation','agent_assets','C'),
  ('asset_valuation','treasury_assets','D'), ('asset_valuation','treasury_assets','C'),
  ('asset_valuation','unrealized_valuation','D'), ('asset_valuation','unrealized_valuation','C'),
  ('estate_principal_recovery','agent_principal','D'), ('estate_principal_recovery','agent_cash','C'),
  ('estate_principal_recovery','treasury_cash','D'), ('estate_principal_recovery','treasury_principal_receivable','C'),
  ('estate_principal_writeoff','agent_principal','D'), ('estate_principal_writeoff','treasury_principal_receivable','C'),
  ('estate_transfer','treasury_cash','D'), ('estate_transfer','treasury_assets','D'),
  ('estate_transfer','agent_cash','C'), ('estate_transfer','agent_assets','C'),
  ('agent_transfer','agent_cash','D'), ('agent_transfer','agent_cash','C');
CREATE TRIGGER fleet_ledger_rules_no_change BEFORE UPDATE OR DELETE ON fleet_ledger_rules
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_ledger_rules_no_truncate BEFORE TRUNCATE ON fleet_ledger_rules
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- ═══ Journal and postings (append-only, hash-chained) ════════════════════
CREATE TABLE fleet_ledger_head (
  id        smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  head_seq  bigint   NOT NULL DEFAULT 0,
  head_hash text     NOT NULL DEFAULT repeat('0', 64) CHECK (head_hash ~ '^[0-9a-f]{64}$')
);
INSERT INTO fleet_ledger_head (id) VALUES (1);
CREATE TRIGGER fleet_ledger_head_no_delete BEFORE DELETE ON fleet_ledger_head
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_ledger_journal (
  seq                 bigserial   UNIQUE,
  journal_id          uuid        PRIMARY KEY,
  kind                text        NOT NULL REFERENCES fleet_ledger_kinds(kind),
  idempotency_key     text        NOT NULL UNIQUE CHECK (idempotency_key ~ '^[A-Za-z0-9:_.-]{8,128}$'),
  actor               text        NOT NULL CHECK (length(actor) BETWEEN 1 AND 128),
  reason              text        NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  source              text        NOT NULL CHECK (source IN ('owner','controller','executor')),
  agent_id            text        REFERENCES fleet_agents(agent_id),
  order_id            uuid,
  approval_ref        text        CHECK (length(approval_ref) <= 128),
  external_ref        text        CHECK (external_ref ~ '^[A-Za-z0-9:_./-]{4,200}$'),
  reverses_journal_id uuid        UNIQUE REFERENCES fleet_ledger_journal(journal_id),
  occurred_at         timestamptz NOT NULL,
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  txid                bigint      NOT NULL DEFAULT txid_current(),
  prev_hash           text        NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  entry_hash          text        NOT NULL UNIQUE CHECK (entry_hash ~ '^[0-9a-f]{64}$'),
  CHECK ((kind = 'reversal') = (reverses_journal_id IS NOT NULL))
);
CREATE UNIQUE INDEX fleet_ledger_external_ref_uq ON fleet_ledger_journal (kind, external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX fleet_ledger_journal_agent_idx ON fleet_ledger_journal (agent_id, seq);

CREATE TABLE fleet_ledger_postings (
  posting_id   bigserial PRIMARY KEY,
  journal_id   uuid      NOT NULL REFERENCES fleet_ledger_journal(journal_id),
  line         smallint  NOT NULL CHECK (line BETWEEN 1 AND 32),
  account_id   text      NOT NULL REFERENCES fleet_ledger_accounts(account_id),
  side         char(1)   NOT NULL CHECK (side IN ('D','C')),
  amount_cents bigint    NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 100000000000000),
  UNIQUE (journal_id, line)
);
CREATE INDEX fleet_ledger_postings_account_idx ON fleet_ledger_postings (account_id);

-- Only fleet_ledger_post writes the ledger (it sets this guard for its own transaction).
CREATE FUNCTION fleet_ledger_write_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF COALESCE(current_setting('fleet.ledger_post', true), '') <> 'on' THEN
    RAISE EXCEPTION 'FLEET_LEDGER_DIRECT_WRITE: the ledger is written only by fleet_ledger_post';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_ledger_journal_write_guard BEFORE INSERT ON fleet_ledger_journal
  FOR EACH ROW EXECUTE FUNCTION fleet_ledger_write_guard();
CREATE TRIGGER fleet_ledger_postings_write_guard BEFORE INSERT ON fleet_ledger_postings
  FOR EACH ROW EXECUTE FUNCTION fleet_ledger_write_guard();

-- Grammar: a posting's (kind, class, side) must be allowed, in its journal's own transaction.
CREATE FUNCTION fleet_ledger_posting_rules() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_ledger_journal; a fleet_ledger_accounts;
BEGIN
  SELECT * INTO j FROM fleet_ledger_journal WHERE journal_id = NEW.journal_id;
  IF j.txid <> txid_current() THEN
    RAISE EXCEPTION 'FLEET_LEDGER_IMMUTABLE: postings can only be added in their journal''s own transaction';
  END IF;
  SELECT * INTO a FROM fleet_ledger_accounts WHERE account_id = NEW.account_id;
  IF j.kind <> 'reversal' AND NOT EXISTS (SELECT 1 FROM fleet_ledger_rules r WHERE r.kind = j.kind AND r.class = a.class AND r.side = NEW.side) THEN
    RAISE EXCEPTION 'FLEET_LEDGER_RULE: % may not % %', j.kind, CASE NEW.side WHEN 'D' THEN 'debit' ELSE 'credit' END, a.class;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_ledger_postings_rules BEFORE INSERT ON fleet_ledger_postings
  FOR EACH ROW EXECUTE FUNCTION fleet_ledger_posting_rules();

-- Balance: every journal has >= 2 postings and sum(debits) = sum(credits) (checked at commit).
-- Deferred checks run at COMMIT, outside any SECURITY DEFINER frame, as the session
-- role (e.g. fleet_agent_login): they must be SECURITY DEFINER to read the ledger.
CREATE FUNCTION fleet_ledger_balanced() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE d numeric; c numeric; n integer;
BEGIN
  SELECT COALESCE(sum(amount_cents) FILTER (WHERE side = 'D'), 0), COALESCE(sum(amount_cents) FILTER (WHERE side = 'C'), 0), count(*)
    INTO d, c, n FROM fleet_ledger_postings WHERE journal_id = NEW.journal_id;
  IF n < 2 OR d <> c THEN
    RAISE EXCEPTION 'FLEET_LEDGER_UNBALANCED: journal % has % postings, debits %, credits %', NEW.journal_id, n, d, c;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER fleet_ledger_journal_balanced AFTER INSERT ON fleet_ledger_journal
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fleet_ledger_balanced();
CREATE CONSTRAINT TRIGGER fleet_ledger_postings_balanced AFTER INSERT ON fleet_ledger_postings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fleet_ledger_balanced();

-- Normal-side balance of an account (derived from postings; the only balance source).
CREATE FUNCTION fleet_ledger_balance(p_account text) RETURNS bigint LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(sum(CASE WHEN p.side = c.normal_side THEN p.amount_cents ELSE -p.amount_cents END), 0)::bigint
    FROM fleet_ledger_accounts a JOIN fleet_ledger_classes c ON c.class = a.class
    LEFT JOIN fleet_ledger_postings p ON p.account_id = a.account_id
   WHERE a.account_id = p_account
$$;

-- Non-negative classes stay non-negative (checked at commit for every touched account).
CREATE FUNCTION fleet_ledger_nonnegative() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_ledger_classes; b bigint;
BEGIN
  SELECT cl.* INTO c FROM fleet_ledger_accounts a JOIN fleet_ledger_classes cl ON cl.class = a.class WHERE a.account_id = NEW.account_id;
  IF c.non_negative THEN
    b := fleet_ledger_balance(NEW.account_id);
    IF b < 0 THEN
      RAISE EXCEPTION 'FLEET_LEDGER_NEGATIVE: account % would be % (class % must not be negative)', NEW.account_id, b, c.class;
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER fleet_ledger_postings_nonnegative AFTER INSERT ON fleet_ledger_postings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fleet_ledger_nonnegative();

CREATE TRIGGER fleet_ledger_journal_no_change BEFORE UPDATE OR DELETE ON fleet_ledger_journal
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_ledger_journal_no_truncate BEFORE TRUNCATE ON fleet_ledger_journal
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_ledger_postings_no_change BEFORE UPDATE OR DELETE ON fleet_ledger_postings
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_ledger_postings_no_truncate BEFORE TRUNCATE ON fleet_ledger_postings
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- Canonical text of a journal (hash input); recomputable from stored rows.
CREATE FUNCTION fleet_ledger_canonical(j fleet_ledger_journal) RETURNS text LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT concat_ws('|', j.journal_id::text, j.kind, j.idempotency_key, j.actor, j.reason, j.source,
      COALESCE(j.agent_id, '-'), COALESCE(j.order_id::text, '-'), COALESCE(j.approval_ref, '-'), COALESCE(j.external_ref, '-'),
      COALESCE(j.reverses_journal_id::text, '-'), to_char(j.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      COALESCE((SELECT string_agg(p.line || ':' || p.account_id || ':' || p.side || ':' || p.amount_cents, ';' ORDER BY p.line)
                  FROM fleet_ledger_postings p WHERE p.journal_id = j.journal_id), ''))
$$;

-- Recompute the whole chain (doctor / audit).
CREATE FUNCTION fleet_ledger_verify() RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_ledger_journal; prev text := repeat('0', 64); n bigint := 0; h fleet_ledger_head; unbalanced bigint;
BEGIN
  FOR j IN SELECT * FROM fleet_ledger_journal ORDER BY seq LOOP
    n := n + 1;
    IF j.prev_hash <> prev OR j.entry_hash <> encode(sha256(convert_to(prev || '|' || fleet_ledger_canonical(j), 'UTF8')), 'hex') THEN
      RETURN jsonb_build_object('ok', false, 'journals', n, 'firstBadSeq', j.seq);
    END IF;
    prev := j.entry_hash;
  END LOOP;
  SELECT * INTO h FROM fleet_ledger_head WHERE id = 1;
  SELECT count(*) INTO unbalanced FROM (SELECT journal_id FROM fleet_ledger_postings GROUP BY journal_id
    HAVING sum(amount_cents) FILTER (WHERE side = 'D') IS DISTINCT FROM sum(amount_cents) FILTER (WHERE side = 'C')) u;
  RETURN jsonb_build_object('ok', h.head_hash = prev AND unbalanced = 0, 'journals', n, 'headHash', prev, 'unbalanced', unbalanced);
END $$;

-- Per-agent accounts (idempotent; the agent must exist).
CREATE FUNCTION fleet_ledger_open_agent(p_agent text, p_actor text) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = p_agent) THEN
    RAISE EXCEPTION 'FLEET_LEDGER_INVALID: unknown agent %', p_agent;
  END IF;
  FOREACH c IN ARRAY ARRAY['agent_cash','agent_reserved','agent_assets','agent_principal','agent_revenue','agent_expense','agent_fees','agent_contributions'] LOOP
    INSERT INTO fleet_ledger_accounts (account_id, class, agent_id, description, created_by)
    VALUES ('agent:' || p_agent || ':' || substr(c, 7), c, p_agent, c || ' of ' || p_agent, left(p_actor, 128))
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;

CREATE FUNCTION fleet_ledger_account(p_agent text, p_class text) RETURNS text LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT 'agent:' || p_agent || ':' || substr(p_class, 7)
$$;

-- ═══ The single posting function (owner-only; never granted) ═════════════
-- p_lines: [{"account": text, "side": "D"|"C", "amount": integer cents}, ...]
CREATE FUNCTION fleet_ledger_post(p_kind text, p_idem text, p_actor text, p_reason text, p_source text, p_agent text,
  p_order uuid, p_approval text, p_external text, p_reverses uuid, p_occurred timestamptz, p_lines jsonb) RETURNS uuid LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE k fleet_ledger_kinds; prior fleet_ledger_journal; h fleet_ledger_head; j fleet_ledger_journal; orig fleet_ledger_journal;
        l jsonb; a fleet_ledger_accounts; cl fleet_ledger_classes; v_id uuid := gen_random_uuid(); i integer := 0;
        v_d numeric := 0; v_c numeric := 0; v_agents text[] := ARRAY[]::text[]; v_lines text; v_prior_lines text; v_acct text;
BEGIN
  SELECT * INTO k FROM fleet_ledger_kinds WHERE kind = p_kind;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_LEDGER_INVALID: unknown journal kind %', p_kind; END IF;
  IF p_source IS NULL OR NOT (p_source = ANY (k.allowed_sources)) THEN
    RAISE EXCEPTION 'FLEET_LEDGER_SOURCE: % journals cannot come from source %', p_kind, p_source;
  END IF;
  IF k.requires_external_ref AND p_external IS NULL THEN
    RAISE EXCEPTION 'FLEET_LEDGER_INVALID: % requires an external reference', p_kind;
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) NOT BETWEEN 2 AND 32 THEN
    RAISE EXCEPTION 'FLEET_LEDGER_INVALID: 2..32 postings required';
  END IF;
  SELECT string_agg((x ->> 'account') || ':' || (x ->> 'side') || ':' || (x ->> 'amount'), ';' ORDER BY ord) INTO v_lines
    FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS t(x, ord);

  -- Idempotency: the same key returns the same journal, or refuses a different one.
  SELECT * INTO prior FROM fleet_ledger_journal WHERE idempotency_key = p_idem;
  IF FOUND THEN
    SELECT string_agg(p.account_id || ':' || p.side || ':' || p.amount_cents, ';' ORDER BY p.line) INTO v_prior_lines
      FROM fleet_ledger_postings p WHERE p.journal_id = prior.journal_id;
    IF prior.kind = p_kind AND v_prior_lines = v_lines AND prior.agent_id IS NOT DISTINCT FROM p_agent THEN
      RETURN prior.journal_id;
    END IF;
    RAISE EXCEPTION 'FLEET_LEDGER_IDEMPOTENCY_CONFLICT: key % already used for a different journal', p_idem;
  END IF;

  -- Validate every line before writing; lock the touched accounts in a fixed order.
  FOR l IN SELECT x FROM jsonb_array_elements(p_lines) x LOOP
    IF (l ->> 'side') NOT IN ('D','C') OR jsonb_typeof(l -> 'amount') <> 'number' OR (l ->> 'amount') !~ '^[1-9][0-9]{0,13}$' THEN
      RAISE EXCEPTION 'FLEET_LEDGER_INVALID: bad posting %', l;
    END IF;
    SELECT * INTO a FROM fleet_ledger_accounts WHERE account_id = l ->> 'account';
    IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_LEDGER_INVALID: unknown account %', l ->> 'account'; END IF;
    IF a.agent_id IS NOT NULL AND NOT (a.agent_id = ANY (v_agents)) THEN v_agents := v_agents || a.agent_id; END IF;
    IF l ->> 'side' = 'D' THEN v_d := v_d + (l ->> 'amount')::numeric; ELSE v_c := v_c + (l ->> 'amount')::numeric; END IF;
  END LOOP;
  IF v_d <> v_c THEN
    RAISE EXCEPTION 'FLEET_LEDGER_UNBALANCED: debits % credits %', v_d, v_c;
  END IF;
  -- Agent scoping: an agent journal touches only that agent's accounts (owner transfers / reversals excepted).
  IF NOT k.multi_agent THEN
    IF cardinality(v_agents) > 1 OR (cardinality(v_agents) = 1 AND v_agents[1] IS DISTINCT FROM p_agent) THEN
      RAISE EXCEPTION 'FLEET_LEDGER_SCOPE: % may touch only the accounts of agent %', p_kind, p_agent;
    END IF;
  ELSIF p_kind = 'agent_transfer' AND cardinality(v_agents) <> 2 THEN
    RAISE EXCEPTION 'FLEET_LEDGER_SCOPE: agent_transfer moves cash between exactly two agents';
  END IF;
  -- Reversal: exactly the original's postings with sides swapped; each journal reversed at most once.
  IF p_kind = 'reversal' THEN
    SELECT * INTO orig FROM fleet_ledger_journal WHERE journal_id = p_reverses;
    IF NOT FOUND OR orig.kind = 'reversal' THEN RAISE EXCEPTION 'FLEET_LEDGER_INVALID: nothing reversible'; END IF;
    SELECT string_agg(p.account_id || ':' || CASE p.side WHEN 'D' THEN 'C' ELSE 'D' END || ':' || p.amount_cents, ';' ORDER BY p.line) INTO v_prior_lines
      FROM fleet_ledger_postings p WHERE p.journal_id = orig.journal_id;
    IF v_prior_lines <> v_lines THEN
      RAISE EXCEPTION 'FLEET_LEDGER_INVALID: a reversal must mirror the original postings exactly';
    END IF;
  END IF;
  FOR v_acct IN SELECT DISTINCT x ->> 'account' FROM jsonb_array_elements(p_lines) x ORDER BY 1 LOOP
    PERFORM 1 FROM fleet_ledger_accounts WHERE account_id = v_acct FOR UPDATE;
  END LOOP;

  PERFORM set_config('fleet.ledger_post', 'on', true);
  SELECT * INTO h FROM fleet_ledger_head WHERE id = 1 FOR UPDATE;
  INSERT INTO fleet_ledger_journal (journal_id, kind, idempotency_key, actor, reason, source, agent_id, order_id, approval_ref,
      external_ref, reverses_journal_id, occurred_at, prev_hash, entry_hash)
    VALUES (v_id, p_kind, p_idem, left(p_actor, 128), left(fleet_scrub(p_reason), 500), p_source, p_agent, p_order, p_approval,
      p_external, p_reverses, COALESCE(p_occurred, now()), h.head_hash, repeat('0', 64))
    RETURNING * INTO j;
  FOR l IN SELECT x FROM jsonb_array_elements(p_lines) x LOOP
    i := i + 1;
    INSERT INTO fleet_ledger_postings (journal_id, line, account_id, side, amount_cents)
      VALUES (v_id, i, l ->> 'account', l ->> 'side', (l ->> 'amount')::bigint);
  END LOOP;
  -- The entry hash covers the postings; it is set once, inside this same statement sequence.
  PERFORM set_config('fleet.ledger_hash', 'on', true);
  UPDATE fleet_ledger_journal SET entry_hash = encode(sha256(convert_to(h.head_hash || '|' || fleet_ledger_canonical(j), 'UTF8')), 'hex')
   WHERE journal_id = v_id RETURNING * INTO j;
  PERFORM set_config('fleet.ledger_hash', 'off', true);
  UPDATE fleet_ledger_head SET head_seq = j.seq, head_hash = j.entry_hash WHERE id = 1;
  PERFORM set_config('fleet.ledger_post', 'off', true);
  -- Immediate non-negative check (the deferred trigger re-checks at commit).
  FOR v_acct IN SELECT DISTINCT x ->> 'account' FROM jsonb_array_elements(p_lines) x LOOP
    SELECT cl2.* INTO cl FROM fleet_ledger_accounts a2 JOIN fleet_ledger_classes cl2 ON cl2.class = a2.class WHERE a2.account_id = v_acct;
    IF cl.non_negative AND fleet_ledger_balance(v_acct) < 0 THEN
      RAISE EXCEPTION 'FLEET_LEDGER_NEGATIVE: account % would be %', v_acct, fleet_ledger_balance(v_acct);
    END IF;
  END LOOP;
  PERFORM fleet_event('ledger_journal_posted', p_agent, left(p_actor, 128),
    jsonb_build_object('journalId', v_id, 'kind', p_kind, 'seq', j.seq, 'amountCents', v_d, 'source', p_source));
  RETURN v_id;
END $$;

-- The only permitted update of a journal row: filling entry_hash once, inside fleet_ledger_post.
DROP TRIGGER fleet_ledger_journal_no_change ON fleet_ledger_journal;
CREATE FUNCTION fleet_ledger_journal_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND COALESCE(current_setting('fleet.ledger_hash', true), '') = 'on'
     AND OLD.entry_hash = repeat('0', 64) AND OLD.txid = txid_current()
     AND (to_jsonb(NEW) - 'entry_hash') = (to_jsonb(OLD) - 'entry_hash') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: % on fleet_ledger_journal is not allowed (post a reversal)', TG_OP;
END $$;
CREATE TRIGGER fleet_ledger_journal_no_change BEFORE UPDATE OR DELETE ON fleet_ledger_journal
  FOR EACH ROW EXECUTE FUNCTION fleet_ledger_journal_guard();
CREATE FUNCTION fleet_ledger_head_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF COALESCE(current_setting('fleet.ledger_post', true), '') <> 'on' OR NEW.head_seq <= OLD.head_seq THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: the ledger head only advances inside fleet_ledger_post';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_ledger_head_guard BEFORE UPDATE ON fleet_ledger_head
  FOR EACH ROW EXECUTE FUNCTION fleet_ledger_head_guard();

-- ═══ Assets and estates (E9: an agent can die; an asset cannot be orphaned) ═
CREATE TABLE fleet_assets (
  asset_id               uuid        PRIMARY KEY,
  asset_class            text        NOT NULL CHECK (asset_class IN ('domain','compute','credits','investment','intellectual_property','other')),
  description            text        NOT NULL CHECK (length(description) BETWEEN 1 AND 200),
  custody_owner          text        NOT NULL CHECK (custody_owner ~ '^(fleet_treasury|provider:[a-z0-9_.-]{1,64})$'),
  economic_owner_account text        NOT NULL REFERENCES fleet_ledger_accounts(account_id),
  authority_agent_id     text        REFERENCES fleet_agents(agent_id),
  acquisition_journal_id uuid        REFERENCES fleet_ledger_journal(journal_id),
  acquisition_basis_cents bigint     NOT NULL CHECK (acquisition_basis_cents >= 0),
  recoverable_cents      bigint      NOT NULL DEFAULT 0 CHECK (recoverable_cents >= 0),
  valuation_source       text        NOT NULL DEFAULT 'cost' CHECK (valuation_source ~ '^[a-z0-9_:.-]{1,64}$'),
  disposition_policy     text        NOT NULL DEFAULT 'return_to_treasury'
                                     CHECK (disposition_policy IN ('return_to_treasury','liquidate','retire')),
  status                 text        NOT NULL DEFAULT 'held' CHECK (status IN ('held','disposed')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             text        NOT NULL
);
CREATE FUNCTION fleet_assets_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_ledger_accounts;
BEGIN
  SELECT * INTO a FROM fleet_ledger_accounts WHERE account_id = NEW.economic_owner_account;
  IF a.class NOT IN ('agent_assets','treasury_assets') THEN
    RAISE EXCEPTION 'FLEET_ASSET_INVALID: an asset is owned by an agent_assets or treasury_assets account';
  END IF;
  IF (a.class = 'agent_assets') <> (NEW.authority_agent_id IS NOT NULL) OR (a.agent_id IS DISTINCT FROM NEW.authority_agent_id AND a.class = 'agent_assets') THEN
    RAISE EXCEPTION 'FLEET_ASSET_INVALID: authority agent must match the owning agent account';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.asset_id <> OLD.asset_id OR NEW.asset_class <> OLD.asset_class OR NEW.acquisition_basis_cents <> OLD.acquisition_basis_cents
     OR NEW.acquisition_journal_id IS DISTINCT FROM OLD.acquisition_journal_id OR NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by) THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: asset provenance cannot change';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_assets_guard BEFORE INSERT OR UPDATE ON fleet_assets
  FOR EACH ROW EXECUTE FUNCTION fleet_assets_guard();
CREATE TRIGGER fleet_assets_no_delete BEFORE DELETE ON fleet_assets
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_assets_no_truncate BEFORE TRUNCATE ON fleet_assets
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_estates (
  agent_id   text        PRIMARY KEY REFERENCES fleet_agents(agent_id),
  status     text        NOT NULL DEFAULT 'open' CHECK (status IN ('open','settled')),
  opened_at  timestamptz NOT NULL DEFAULT now(),
  opened_by  text        NOT NULL,
  settled_at timestamptz,
  settled_by text,
  summary    jsonb,
  CHECK ((status = 'settled') = (settled_at IS NOT NULL))
);
CREATE TRIGGER fleet_estates_no_delete BEFORE DELETE ON fleet_estates
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- ═══ Agent economics (E3) ════════════════════════════════════════════════
CREATE FUNCTION fleet_agent_economics(p_agent text) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_cash bigint; v_res bigint; v_assets_rec bigint; v_principal bigint; v_oblig bigint; v_rev bigint; v_exp bigint; v_fees bigint; v_contrib bigint;
        v_rec bigint; v_eq bigint; v_net bigint; v_res_rec bigint;
BEGIN
  v_cash := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_cash'));
  v_res := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_reserved'));
  v_principal := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_principal'));
  v_rev := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_revenue'));
  v_exp := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_expense'));
  v_fees := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_fees'));
  v_contrib := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_contributions'));
  SELECT COALESCE(sum(LEAST(recoverable_cents, acquisition_basis_cents)), 0) INTO v_assets_rec
    FROM fleet_assets WHERE authority_agent_id = p_agent AND status = 'held';
  -- Reserved funds are already committed: only the recoverable part of a pending
  -- asset purchase still counts toward survival (never the whole reservation).
  SELECT COALESCE(sum(recoverable_cents), 0) INTO v_res_rec
    FROM fleet_payment_orders WHERE agent_id = p_agent AND status IN ('reserved','executing');
  SELECT COALESCE(sum(amount_cents), 0) INTO v_oblig FROM fleet_obligations WHERE agent_id = p_agent AND status = 'approved';
  v_rec := v_cash + v_res_rec + v_assets_rec;
  v_eq := v_rec - v_principal - v_oblig;
  v_net := v_rev - v_exp - v_fees;
  RETURN jsonb_build_object('cash', v_cash, 'reserved', v_res, 'assetsRecoverable', v_assets_rec, 'reservedRecoverable', v_res_rec, 'recoverable', v_rec,
    'protectedPrincipal', v_principal, 'protectedObligations', v_oblig, 'survivalEquity', v_eq,
    'expensePurchasingCapacity', GREATEST(0, LEAST(v_cash, v_eq)), 'purchasingCapacity', v_cash,
    'realizedNetProfit', v_net, 'lifetimeContribution', v_contrib, 'uncontributedProfit', GREATEST(0, v_net - v_contrib),
    'survivalEquityExhausted', v_eq <= 0 AND v_principal > 0);
END $$;

-- ═══ Payment destinations (enrollment separated from payment approval) ═══
CREATE TABLE fleet_payment_destinations (
  destination_id   text        PRIMARY KEY CHECK (destination_id ~ '^dst_[0-9A-HJKMNP-TV-Z]{26}$'),
  kind             text        NOT NULL CHECK (kind IN ('owner','payee')),
  rail             text        NOT NULL CHECK (rail IN ('evm_usdc','bank_transfer','conway_credits','provider_account')),
  label            text        NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
  -- The real details live only in custody; the ledger keeps a digest and a short hint.
  reference_sha256 text        NOT NULL CHECK (reference_sha256 ~ '^[0-9a-f]{64}$'),
  reference_hint   text        CHECK (reference_hint ~ '^[A-Za-z0-9*._-]{0,12}$'),
  allowed_agent_id text        REFERENCES fleet_agents(agent_id),
  status           text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','revoked')),
  enrolled_by      text        NOT NULL,
  enrolled_at      timestamptz NOT NULL DEFAULT now(),
  activatable_at   timestamptz NOT NULL,
  activation_code_sha256 text  NOT NULL CHECK (activation_code_sha256 ~ '^[0-9a-f]{64}$'),
  activated_by     text,
  activated_at     timestamptz,
  revoked_by       text,
  revoked_at       timestamptz,
  revoke_reason    text        CHECK (length(revoke_reason) <= 200),
  CHECK (kind <> 'owner' OR allowed_agent_id IS NULL),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (status <> 'active' OR activated_at IS NOT NULL),
  CHECK (activatable_at > enrolled_at)
);
CREATE FUNCTION fleet_destinations_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
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
CREATE TRIGGER fleet_destinations_guard BEFORE INSERT OR UPDATE ON fleet_payment_destinations
  FOR EACH ROW EXECUTE FUNCTION fleet_destinations_guard();
CREATE TRIGGER fleet_destinations_no_delete BEFORE DELETE ON fleet_payment_destinations
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_destinations_no_truncate BEFORE TRUNCATE ON fleet_payment_destinations
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- ═══ Payment orders (agent spend and owner withdrawal) ═══════════════════
CREATE TABLE fleet_payment_orders (
  seq                    bigserial   UNIQUE,
  order_id               uuid        PRIMARY KEY,
  order_type             text        NOT NULL CHECK (order_type IN ('agent_spend','owner_withdrawal')),
  agent_id               text        REFERENCES fleet_agents(agent_id),
  idempotency_key        text        NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_.-]{8,128}$'),
  amount_cents           bigint      NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 100000000000),
  category               text        NOT NULL CHECK (category IN ('expense','fee','asset_acquisition','conway_credits','owner_withdrawal')),
  destination_id         text        NOT NULL REFERENCES fleet_payment_destinations(destination_id),
  purpose                text        NOT NULL CHECK (length(purpose) BETWEEN 1 AND 300),
  recoverable_cents      bigint      NOT NULL DEFAULT 0 CHECK (recoverable_cents >= 0),
  requested_by           text        NOT NULL,
  request_sha256         text        NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  status                 text        NOT NULL CHECK (status IN ('requested','awaiting_owner','reserved','executing','settled',
                                                             'failed','rejected','cancelled','expired')),
  decided_by             text,
  decision_code          text        CHECK (decision_code ~ '^FLEET_[A-Z_]{2,48}$'),
  decision_reason        text        CHECK (length(decision_reason) <= 300),
  admin_instruction_id   uuid,
  reservation_journal_id uuid        REFERENCES fleet_ledger_journal(journal_id),
  release_journal_id     uuid        REFERENCES fleet_ledger_journal(journal_id),
  settlement_journal_id  uuid        REFERENCES fleet_ledger_journal(journal_id),
  settled_cents          bigint,
  external_ref           text,
  expires_at             timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK ((order_type = 'agent_spend') = (agent_id IS NOT NULL)),
  CHECK ((order_type = 'owner_withdrawal') = (category = 'owner_withdrawal')),
  CHECK (recoverable_cents <= amount_cents),
  CHECK (category = 'asset_acquisition' OR recoverable_cents = 0),
  CHECK (status NOT IN ('reserved','executing','settled') OR reservation_journal_id IS NOT NULL),
  CHECK (status <> 'settled' OR (settlement_journal_id IS NOT NULL AND settled_cents = amount_cents)),
  CHECK (status NOT IN ('failed') OR release_journal_id IS NOT NULL),
  CHECK (reservation_journal_id IS NULL OR status NOT IN ('cancelled','expired') OR release_journal_id IS NOT NULL)
);
CREATE UNIQUE INDEX fleet_payment_orders_idem_uq ON fleet_payment_orders (order_type, COALESCE(agent_id, ''), idempotency_key);
CREATE INDEX fleet_payment_orders_agent_idx ON fleet_payment_orders (agent_id, created_at);
CREATE FUNCTION fleet_orders_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_fixed text[] := ARRAY['seq','order_id','order_type','agent_id','idempotency_key','amount_cents','category','destination_id',
                                'purpose','recoverable_cents','requested_by','request_sha256','created_at','expires_at'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'requested' THEN RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: orders start requested'; END IF;
    RETURN NEW;
  END IF;
  IF (SELECT jsonb_object_agg(k, to_jsonb(NEW) -> k) FROM unnest(v_fixed) k) IS DISTINCT FROM (SELECT jsonb_object_agg(k, to_jsonb(OLD) -> k) FROM unnest(v_fixed) k) THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: order identity cannot change';
  END IF;
  IF OLD.reservation_journal_id IS NOT NULL AND NEW.reservation_journal_id IS DISTINCT FROM OLD.reservation_journal_id
     OR OLD.release_journal_id IS NOT NULL AND NEW.release_journal_id IS DISTINCT FROM OLD.release_journal_id
     OR OLD.settlement_journal_id IS NOT NULL AND NEW.settlement_journal_id IS DISTINCT FROM OLD.settlement_journal_id THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: an order''s ledger links are set once';
  END IF;
  IF OLD.status IN ('settled','failed','rejected','cancelled','expired') THEN
    RAISE EXCEPTION 'FLEET_TERMINAL_STATE_IMMUTABLE: order % is %', OLD.order_id, OLD.status;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'requested'      AND NEW.status IN ('awaiting_owner','reserved','rejected'))
    OR (OLD.status = 'awaiting_owner' AND NEW.status IN ('reserved','rejected','cancelled','expired'))
    OR (OLD.status = 'reserved'       AND NEW.status IN ('executing','cancelled','expired'))
    OR (OLD.status = 'executing'      AND NEW.status IN ('settled','failed'))) THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: order % -> %', OLD.status, NEW.status;
  END IF;
  -- Never approved by an agent or an operator principal (Claude/ChatGPT): owner or controller only.
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('reserved','rejected') AND NEW.decided_by IS DISTINCT FROM 'controller' THEN
    PERFORM fleet_require_operator_approver(CASE WHEN NEW.decided_by LIKE 'operator:%' THEN substr(NEW.decided_by, 10) ELSE NEW.decided_by END,
                                            COALESCE(NEW.agent_id, 'fleet_treasury'));
    IF NEW.decided_by IS NULL OR NEW.decided_by !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN
      RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: only the controller or the owner decides an order';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_orders_guard BEFORE INSERT OR UPDATE ON fleet_payment_orders
  FOR EACH ROW EXECUTE FUNCTION fleet_orders_guard();
CREATE TRIGGER fleet_orders_no_delete BEFORE DELETE ON fleet_payment_orders
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_orders_no_truncate BEFORE TRUNCATE ON fleet_payment_orders
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- ═══ Payment instructions (controller -> custody executor protocol) ═══════
CREATE TABLE fleet_payment_instructions (
  instruction_id     uuid        PRIMARY KEY,
  order_id           uuid        NOT NULL UNIQUE REFERENCES fleet_payment_orders(order_id),
  amount_cents       bigint      NOT NULL CHECK (amount_cents > 0),
  destination_id     text        NOT NULL REFERENCES fleet_payment_destinations(destination_id),
  rail               text        NOT NULL,
  instruction_sha256 text        NOT NULL CHECK (instruction_sha256 ~ '^[0-9a-f]{64}$'),
  status             text        NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','claimed','settled','failed')),
  issued_by          text        NOT NULL,
  issued_at          timestamptz NOT NULL DEFAULT now(),
  claimed_by         text,
  claimed_at         timestamptz,
  lease_sha256       text        CHECK (lease_sha256 ~ '^[0-9a-f]{64}$'),
  external_ref       text        UNIQUE,
  settled_cents      bigint,
  failure_code       text,
  finished_at        timestamptz
);
CREATE FUNCTION fleet_instructions_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT (SELECT custody_execution_enabled FROM fleet_economic_model WHERE id = 1) THEN
      RAISE EXCEPTION 'FLEET_CUSTODY_EXECUTION_DISABLED: no payment instruction can be issued (constitutional custody invariant)';
    END IF;
    IF NEW.status <> 'issued' THEN RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: instructions start issued'; END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','claimed_by','claimed_at','lease_sha256','external_ref','settled_cents','failure_code','finished_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','claimed_by','claimed_at','lease_sha256','external_ref','settled_cents','failure_code','finished_at']) THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: an instruction''s content never changes';
  END IF;
  IF NOT ((OLD.status = 'issued' AND NEW.status = 'claimed') OR (OLD.status = 'claimed' AND NEW.status IN ('settled','failed'))) THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: instruction % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_instructions_guard BEFORE INSERT OR UPDATE ON fleet_payment_instructions
  FOR EACH ROW EXECUTE FUNCTION fleet_instructions_guard();
CREATE TRIGGER fleet_instructions_no_delete BEFORE DELETE ON fleet_payment_instructions
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_instructions_no_truncate BEFORE TRUNCATE ON fleet_payment_instructions
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- ═══ FleetAdmin instructions (E7: authority, assessment, override, audit) ═
CREATE TABLE fleet_admin_instructions (
  seq                  bigserial   UNIQUE,
  instruction_id       uuid        PRIMARY KEY,
  kind                 text        NOT NULL CHECK (kind IN ('spend_decision','owner_withdrawal','capital_grant','principal_advance',
                                                          'profit_contribution','owner_funding_record')),
  params               jsonb       NOT NULL,
  assessment           jsonb       NOT NULL,
  recommendation       text        NOT NULL CHECK (recommendation IN ('proceed','recommend_against')),
  override             boolean     NOT NULL,
  warnings_acknowledged boolean    NOT NULL,
  auth_level           text        NOT NULL CHECK (auth_level IN ('standard','strong')),
  confirmation_sha256  text        CHECK (confirmation_sha256 ~ '^[0-9a-f]{64}$'),
  confirm_by           timestamptz,
  status               text        NOT NULL CHECK (status IN ('pending_confirmation','executed','refused','expired')),
  refusal_code         text        CHECK (refusal_code ~ '^FLEET_[A-Z_]{2,48}$'),
  result               jsonb,
  actor                text        NOT NULL CHECK (actor ~ '^operator:[A-Za-z0-9._-]{1,64}$'),
  created_at           timestamptz NOT NULL DEFAULT now(),
  finished_at          timestamptz,
  CHECK (override = (recommendation = 'recommend_against' AND status = 'executed') OR status <> 'executed' OR recommendation = 'proceed'),
  CHECK ((status = 'pending_confirmation') = (finished_at IS NULL)),
  CHECK (NOT override OR warnings_acknowledged)
);
CREATE FUNCTION fleet_admin_instructions_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM fleet_require_operator_approver(substr(NEW.actor, 10), 'fleet_treasury');
    RETURN NEW;
  END IF;
  IF OLD.status <> 'pending_confirmation' OR (to_jsonb(NEW) - ARRAY['status','result','finished_at','refusal_code','override'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','result','finished_at','refusal_code','override']) THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: an admin instruction is decided once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_admin_instructions_guard BEFORE INSERT OR UPDATE ON fleet_admin_instructions
  FOR EACH ROW EXECUTE FUNCTION fleet_admin_instructions_guard();
CREATE TRIGGER fleet_admin_instructions_no_delete BEFORE DELETE ON fleet_admin_instructions
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_admin_instructions_no_truncate BEFORE TRUNCATE ON fleet_admin_instructions
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- ═══ Internal order helpers (owner-only) ═════════════════════════════════

-- Hard (constitutional) checks for reserving an agent spend order now. NULL = ok.
CREATE FUNCTION fleet_order_hard_check(o fleet_payment_orders) RETURNS text LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_agents; d fleet_payment_destinations; e jsonb;
BEGIN
  SELECT * INTO d FROM fleet_payment_destinations WHERE destination_id = o.destination_id;
  IF o.order_type = 'agent_spend' THEN
    SELECT * INTO a FROM fleet_agents WHERE agent_id = o.agent_id;
    IF a.status <> 'active' THEN RETURN 'FLEET_AGENT_NOT_ACTIVE'; END IF;
    IF a.operator_hold_at IS NOT NULL THEN RETURN 'FLEET_AGENT_HELD'; END IF;
    IF EXISTS (SELECT 1 FROM fleet_wallet_custody w WHERE w.agent_id = o.agent_id AND w.spending_frozen) THEN RETURN 'FLEET_SPENDING_FROZEN'; END IF;
    IF d.kind <> 'payee' OR (d.allowed_agent_id IS NOT NULL AND d.allowed_agent_id <> o.agent_id) THEN RETURN 'FLEET_DESTINATION_NOT_ALLOWED'; END IF;
    e := fleet_agent_economics(o.agent_id);
    IF (e ->> 'cash')::bigint < o.amount_cents THEN RETURN 'FLEET_INSUFFICIENT_ALLOCATION'; END IF;
    -- Borrowed principal is not survival capital: never spend what the protected claims need.
    IF (e ->> 'recoverable')::bigint - o.amount_cents + o.recoverable_cents - (e ->> 'protectedPrincipal')::bigint - (e ->> 'protectedObligations')::bigint < 0 THEN
      RETURN 'FLEET_PROTECTED_CAPITAL';
    END IF;
  ELSE
    IF d.kind <> 'owner' THEN RETURN 'FLEET_DESTINATION_NOT_ALLOWED'; END IF;
    IF fleet_ledger_balance('fleet:treasury:unallocated') < o.amount_cents THEN RETURN 'FLEET_INSUFFICIENT_TREASURY'; END IF;
  END IF;
  IF d.status <> 'active' THEN RETURN 'FLEET_DESTINATION_NOT_ACTIVE'; END IF;
  RETURN NULL;
END $$;

-- Reserve an order (posts the reservation journal). Caller has locked the order row.
CREATE FUNCTION fleet_order_reserve(o fleet_payment_orders, p_actor text, p_source text, p_decided_by text, p_code text, p_reason text, p_admin uuid)
RETURNS fleet_payment_orders LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_j uuid; r fleet_payment_orders; v_ttl integer;
BEGIN
  SELECT reservation_ttl_s INTO v_ttl FROM fleet_economic_model WHERE id = 1;
  IF o.order_type = 'agent_spend' THEN
    v_j := fleet_ledger_post('spend_reservation', 'reserve:' || o.order_id, p_actor, 'reserve spend order', p_source, o.agent_id, o.order_id,
      p_admin::text, NULL, NULL, now(), jsonb_build_array(
        jsonb_build_object('account', fleet_ledger_account(o.agent_id, 'agent_reserved'), 'side', 'D', 'amount', o.amount_cents),
        jsonb_build_object('account', fleet_ledger_account(o.agent_id, 'agent_cash'), 'side', 'C', 'amount', o.amount_cents)));
  ELSE
    v_j := fleet_ledger_post('owner_withdrawal_reservation', 'reserve:' || o.order_id, p_actor, 'reserve owner withdrawal', 'owner', NULL, o.order_id,
      p_admin::text, NULL, NULL, now(), jsonb_build_array(
        jsonb_build_object('account', 'fleet:custody:withdrawal_clearing', 'side', 'D', 'amount', o.amount_cents),
        jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', o.amount_cents)));
  END IF;
  UPDATE fleet_payment_orders SET status = 'reserved', reservation_journal_id = v_j, decided_by = p_decided_by, decision_code = p_code,
         decision_reason = left(p_reason, 300), admin_instruction_id = p_admin
   WHERE order_id = o.order_id RETURNING * INTO r;
  PERFORM fleet_event('payment_order_reserved', o.agent_id, left(p_actor, 128),
    jsonb_build_object('orderId', o.order_id, 'orderType', o.order_type, 'amountCents', o.amount_cents, 'decidedBy', p_decided_by, 'executed', false));
  RETURN r;
END $$;

-- Release a reserved order's funds and move it to a terminal status (cancelled / expired / failed).
CREATE FUNCTION fleet_order_release(o fleet_payment_orders, p_status text, p_actor text, p_source text, p_code text)
RETURNS fleet_payment_orders LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_j uuid; r fleet_payment_orders;
BEGIN
  IF o.reservation_journal_id IS NOT NULL THEN
    IF o.order_type = 'agent_spend' THEN
      v_j := fleet_ledger_post('spend_release', 'release:' || o.order_id, p_actor, 'release spend order: ' || p_status, p_source, o.agent_id, o.order_id,
        NULL, NULL, NULL, now(), jsonb_build_array(
          jsonb_build_object('account', fleet_ledger_account(o.agent_id, 'agent_cash'), 'side', 'D', 'amount', o.amount_cents),
          jsonb_build_object('account', fleet_ledger_account(o.agent_id, 'agent_reserved'), 'side', 'C', 'amount', o.amount_cents)));
    ELSE
      v_j := fleet_ledger_post('owner_withdrawal_release', 'release:' || o.order_id, p_actor, 'release owner withdrawal: ' || p_status,
        CASE WHEN p_source = 'controller' THEN 'owner' ELSE p_source END, NULL, o.order_id, NULL, NULL, NULL, now(), jsonb_build_array(
          jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', o.amount_cents),
          jsonb_build_object('account', 'fleet:custody:withdrawal_clearing', 'side', 'C', 'amount', o.amount_cents)));
    END IF;
  END IF;
  UPDATE fleet_payment_orders SET status = p_status, release_journal_id = v_j, decision_code = COALESCE(p_code, decision_code)
   WHERE order_id = o.order_id RETURNING * INTO r;
  PERFORM fleet_event('payment_order_' || p_status, o.agent_id, left(p_actor, 128),
    jsonb_build_object('orderId', o.order_id, 'orderType', o.order_type, 'amountCents', o.amount_cents, 'code', p_code));
  RETURN r;
END $$;

CREATE FUNCTION fleet_order_json(o fleet_payment_orders) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('orderId', o.order_id, 'orderType', o.order_type, 'agentId', o.agent_id, 'amountCents', o.amount_cents,
    'category', o.category, 'destinationId', o.destination_id, 'status', o.status, 'decidedBy', o.decided_by,
    'decisionCode', o.decision_code, 'decisionReason', o.decision_reason, 'expiresAt', o.expires_at, 'executed', o.status = 'settled')
$$;

-- ═══ Agent API (authenticated; own identity only) ════════════════════════

-- E5: an agent proposes a spend; the controller decides deterministically and records it.
CREATE FUNCTION api_spend_request(p_agent text, p_token text, p_idem text, p_amount_cents bigint, p_category text,
  p_destination text, p_purpose text, p_recoverable_cents bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'spend_request'); m fleet_economic_model; o fleet_payment_orders;
        v_hash text; v_hard text; v_today bigint; v_rec bigint := COALESCE(p_recoverable_cents, 0);
BEGIN
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_code); END IF;
  IF p_idem IS NULL OR p_idem !~ '^[A-Za-z0-9:_.-]{8,128}$' OR p_amount_cents IS NULL OR p_amount_cents <= 0 OR p_amount_cents > 100000000000
     OR p_category NOT IN ('expense','fee','asset_acquisition','conway_credits') OR p_destination IS NULL
     OR p_destination !~ '^dst_[0-9A-HJKMNP-TV-Z]{26}$' OR p_purpose IS NULL OR length(p_purpose) NOT BETWEEN 1 AND 300
     OR v_rec < 0 OR v_rec > p_amount_cents OR (p_category <> 'asset_acquisition' AND v_rec <> 0) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  PERFORM fleet_ledger_open_agent(p_agent, p_agent);
  -- Serialise this agent's spend decisions (no double-spend races).
  PERFORM 1 FROM fleet_ledger_accounts WHERE account_id = fleet_ledger_account(p_agent, 'agent_cash') FOR UPDATE;
  v_hash := encode(sha256(convert_to(concat_ws('|', p_agent, p_amount_cents, p_category, p_destination, fleet_scrub(p_purpose), v_rec), 'UTF8')), 'hex');
  SELECT * INTO o FROM fleet_payment_orders WHERE order_type = 'agent_spend' AND agent_id = p_agent AND idempotency_key = p_idem;
  IF FOUND THEN
    IF o.request_sha256 <> v_hash THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_IDEMPOTENCY_CONFLICT'); END IF;
    RETURN jsonb_build_object('ok', o.status IN ('reserved','awaiting_owner','executing','settled'), 'replay', true, 'order', fleet_order_json(o));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fleet_payment_destinations WHERE destination_id = p_destination) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_DESTINATION_NOT_ALLOWED');
  END IF;
  SELECT * INTO m FROM fleet_economic_model WHERE id = 1;
  INSERT INTO fleet_payment_orders (order_id, order_type, agent_id, idempotency_key, amount_cents, category, destination_id, purpose,
      recoverable_cents, requested_by, request_sha256, status, expires_at)
    VALUES (gen_random_uuid(), 'agent_spend', p_agent, p_idem, p_amount_cents, p_category, p_destination, left(fleet_scrub(p_purpose), 300),
      v_rec, p_agent, v_hash, 'requested', now() + make_interval(secs => m.reservation_ttl_s))
    RETURNING * INTO o;
  v_hard := fleet_order_hard_check(o);
  IF v_hard IS NOT NULL THEN
    UPDATE fleet_payment_orders SET status = 'rejected', decided_by = 'controller', decision_code = v_hard,
           decision_reason = 'constitutional/availability check failed' WHERE order_id = o.order_id RETURNING * INTO o;
    PERFORM fleet_event('payment_order_rejected', p_agent, 'controller', jsonb_build_object('orderId', o.order_id, 'code', v_hard, 'amountCents', p_amount_cents));
    RETURN jsonb_build_object('ok', false, 'code', v_hard, 'order', fleet_order_json(o));
  END IF;
  SELECT COALESCE(sum(amount_cents), 0) INTO v_today FROM fleet_payment_orders
   WHERE agent_id = p_agent AND status IN ('reserved','executing','settled') AND created_at > now() - interval '1 day';
  IF p_amount_cents > m.owner_approval_threshold_cents OR v_today + p_amount_cents > m.agent_daily_spend_cents THEN
    -- Policy, not constitution: the owner decides (the controller never vetoes the owner on policy).
    UPDATE fleet_payment_orders SET status = 'awaiting_owner', decided_by = 'controller', decision_code = 'FLEET_OWNER_APPROVAL_REQUIRED',
           decision_reason = format('above policy (threshold %s, daily %s/%s)', m.owner_approval_threshold_cents, v_today + p_amount_cents, m.agent_daily_spend_cents)
     WHERE order_id = o.order_id RETURNING * INTO o;
    PERFORM fleet_event('payment_order_awaiting_owner', p_agent, 'controller', jsonb_build_object('orderId', o.order_id, 'amountCents', p_amount_cents));
    RETURN jsonb_build_object('ok', true, 'order', fleet_order_json(o));
  END IF;
  o := fleet_order_reserve(o, 'controller', 'controller', 'controller', 'FLEET_APPROVED', 'within allocation and policy', NULL);
  RETURN jsonb_build_object('ok', true, 'order', fleet_order_json(o));
END $$;

CREATE FUNCTION api_spend_cancel(p_agent text, p_token text, p_order uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'spend_cancel'); o fleet_payment_orders;
BEGIN
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_code); END IF;
  SELECT * INTO o FROM fleet_payment_orders WHERE order_id = p_order AND order_type = 'agent_spend' AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF o.status NOT IN ('awaiting_owner','reserved') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE', 'order', fleet_order_json(o));
  END IF;
  o := fleet_order_release(o, 'cancelled', p_agent, 'controller', 'FLEET_CANCELLED_BY_AGENT');
  RETURN jsonb_build_object('ok', true, 'order', fleet_order_json(o));
END $$;

CREATE FUNCTION api_ledger_summary(p_agent text, p_token text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'ledger_summary');
BEGIN
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_code); END IF;
  IF NOT EXISTS (SELECT 1 FROM fleet_ledger_accounts WHERE agent_id = p_agent) THEN
    RETURN jsonb_build_object('ok', true, 'economics', NULL);
  END IF;
  RETURN jsonb_build_object('ok', true, 'economics', fleet_agent_economics(p_agent));
END $$;

-- Legacy (v5) spend path: superseded by the v10 ledger (no second financial truth).
CREATE OR REPLACE FUNCTION api_request_spend(p_agent text, p_token text, p_request_id text, p_from_wallet text, p_to_address text,
                                             p_amount_cents bigint, p_purpose text, p_allocation_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'request_spend');
BEGIN
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_code); END IF;
  RETURN jsonb_build_object('ok', false, 'code', 'FLEET_LEGACY_SUPERSEDED',
    'reason', 'agent-wallet spend requests are superseded by ledger spend orders (POST /v1/spend/request)');
END $$;

-- ═══ Controller (service role) ═══════════════════════════════════════════

-- Expire reserved / awaiting orders past their TTL (reaper). Releases funds.
CREATE FUNCTION svc_expire_payment_orders(p_limit integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_payment_orders; n integer := 0;
BEGIN
  FOR o IN SELECT * FROM fleet_payment_orders WHERE status IN ('reserved','awaiting_owner') AND expires_at <= now()
            ORDER BY seq LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500) FOR UPDATE SKIP LOCKED LOOP
    PERFORM fleet_order_release(o, 'expired', 'controller', 'controller', 'FLEET_EXPIRED');
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- FleetController knows WHAT should be paid; the custody executor knows HOW. In v10 the
-- instruction table refuses every insert (custody execution constitutionally disabled).
CREATE FUNCTION svc_issue_payment_instruction(p_order uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_payment_orders; d fleet_payment_destinations; v_id uuid := gen_random_uuid();
BEGIN
  IF NOT (SELECT custody_execution_enabled FROM fleet_economic_model WHERE id = 1) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CUSTODY_EXECUTION_DISABLED');
  END IF;
  SELECT * INTO o FROM fleet_payment_orders WHERE order_id = p_order FOR UPDATE;
  IF NOT FOUND OR o.status <> 'reserved' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE'); END IF;
  SELECT * INTO d FROM fleet_payment_destinations WHERE destination_id = o.destination_id;
  IF d.status <> 'active' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_DESTINATION_NOT_ACTIVE'); END IF;
  INSERT INTO fleet_payment_instructions (instruction_id, order_id, amount_cents, destination_id, rail, instruction_sha256, issued_by)
    VALUES (v_id, o.order_id, o.amount_cents, o.destination_id, d.rail,
      encode(sha256(convert_to(concat_ws('|', v_id, o.order_id, o.amount_cents, o.destination_id, d.rail, d.reference_sha256), 'UTF8')), 'hex'), 'controller');
  UPDATE fleet_payment_orders SET status = 'executing' WHERE order_id = o.order_id;
  RETURN jsonb_build_object('ok', true, 'instructionId', v_id);
END $$;

-- ═══ Custody executor protocol (fleet_custody role only) ═════════════════
CREATE FUNCTION cx_ping() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('schemaVersion', (SELECT max(version) FROM fleet_schema_migrations),
    'executionEnabled', m.custody_execution_enabled,
    'issued', (SELECT count(*) FROM fleet_payment_instructions WHERE status = 'issued'),
    'claimed', (SELECT count(*) FROM fleet_payment_instructions WHERE status = 'claimed'), 'dbTime', now(),
    'runtimeRepo', f.runtime_repo, 'runtimeCommit', f.runtime_commit, 'runtimeBuildId', f.runtime_build_id,
    'runtimeLockfileSha256', f.runtime_lockfile_sha256)
    FROM fleet_economic_model m CROSS JOIN fleet_state f WHERE m.id = 1 AND f.id = 1
$$;

-- Claim one issued instruction under a lease (only its SHA-256 is stored).
CREATE FUNCTION cx_claim_instruction(p_worker text, p_lease_sha256 text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE i fleet_payment_instructions; d fleet_payment_destinations;
BEGIN
  IF p_worker IS NULL OR p_worker !~ '^[a-z0-9_.-]{1,64}$' OR p_lease_sha256 IS NULL OR p_lease_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  IF NOT (SELECT custody_execution_enabled FROM fleet_economic_model WHERE id = 1) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CUSTODY_EXECUTION_DISABLED');
  END IF;
  SELECT * INTO i FROM fleet_payment_instructions WHERE status = 'issued' ORDER BY issued_at LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', true, 'instruction', NULL); END IF;
  UPDATE fleet_payment_instructions SET status = 'claimed', claimed_by = p_worker, claimed_at = now(), lease_sha256 = p_lease_sha256
   WHERE instruction_id = i.instruction_id RETURNING * INTO i;
  SELECT * INTO d FROM fleet_payment_destinations WHERE destination_id = i.destination_id;
  RETURN jsonb_build_object('ok', true, 'instruction', jsonb_build_object('instructionId', i.instruction_id, 'amountCents', i.amount_cents,
    'destinationId', i.destination_id, 'rail', i.rail, 'referenceSha256', d.reference_sha256, 'instructionSha256', i.instruction_sha256));
END $$;

-- Report the external result of a claimed instruction. Only the lease holder; exactly the
-- instructed amount; one external reference; settles or releases in the ledger atomically.
CREATE FUNCTION cx_report_result(p_instruction uuid, p_lease text, p_outcome text, p_external_ref text, p_settled_cents bigint, p_failure_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE i fleet_payment_instructions; o fleet_payment_orders; v_j uuid; v_class text;
BEGIN
  SELECT * INTO i FROM fleet_payment_instructions WHERE instruction_id = p_instruction FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF i.status IN ('settled','failed') THEN
    IF i.status = p_outcome AND i.external_ref IS NOT DISTINCT FROM p_external_ref THEN
      RETURN jsonb_build_object('ok', true, 'replay', true, 'status', i.status);
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ALREADY_FINISHED');
  END IF;
  IF i.status <> 'claimed' OR p_lease IS NULL OR encode(sha256(convert_to(p_lease, 'UTF8')), 'hex') <> i.lease_sha256 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_LEASE_INVALID');
  END IF;
  SELECT * INTO o FROM fleet_payment_orders WHERE order_id = i.order_id FOR UPDATE;
  IF p_outcome = 'settled' THEN
    IF p_settled_cents IS DISTINCT FROM i.amount_cents OR p_external_ref IS NULL OR p_external_ref !~ '^[A-Za-z0-9:_./-]{4,200}$' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_SETTLEMENT_MISMATCH');
    END IF;
    IF o.order_type = 'agent_spend' THEN
      v_class := CASE o.category WHEN 'expense' THEN 'agent_expense' WHEN 'fee' THEN 'agent_fees' ELSE 'agent_assets' END;
      v_j := fleet_ledger_post('spend_settlement', 'settle:' || o.order_id, 'custody-executor', 'executor settlement', 'executor', o.agent_id, o.order_id,
        i.instruction_id::text, p_external_ref, NULL, now(), jsonb_build_array(
          jsonb_build_object('account', fleet_ledger_account(o.agent_id, v_class), 'side', 'D', 'amount', o.amount_cents),
          jsonb_build_object('account', fleet_ledger_account(o.agent_id, 'agent_reserved'), 'side', 'C', 'amount', o.amount_cents)));
      IF o.category IN ('asset_acquisition','conway_credits') THEN
        INSERT INTO fleet_assets (asset_id, asset_class, description, custody_owner, economic_owner_account, authority_agent_id,
            acquisition_journal_id, acquisition_basis_cents, recoverable_cents, created_by)
          VALUES (gen_random_uuid(), CASE WHEN o.category = 'conway_credits' THEN 'credits' ELSE 'other' END, left(o.purpose, 200), 'fleet_treasury',
            fleet_ledger_account(o.agent_id, 'agent_assets'), o.agent_id, v_j, o.amount_cents, o.recoverable_cents, 'custody-executor');
      END IF;
    ELSE
      v_j := fleet_ledger_post('owner_withdrawal_settlement', 'settle:' || o.order_id, 'custody-executor', 'executor settlement', 'executor', NULL, o.order_id,
        i.instruction_id::text, p_external_ref, NULL, now(), jsonb_build_array(
          jsonb_build_object('account', 'fleet:owner:withdrawals', 'side', 'D', 'amount', o.amount_cents),
          jsonb_build_object('account', 'fleet:custody:withdrawal_clearing', 'side', 'C', 'amount', o.amount_cents)));
    END IF;
    UPDATE fleet_payment_instructions SET status = 'settled', external_ref = p_external_ref, settled_cents = p_settled_cents, finished_at = now()
     WHERE instruction_id = i.instruction_id;
    UPDATE fleet_payment_orders SET status = 'settled', settlement_journal_id = v_j, settled_cents = p_settled_cents, external_ref = p_external_ref
     WHERE order_id = o.order_id;
    PERFORM fleet_event('payment_order_settled', o.agent_id, 'custody-executor', jsonb_build_object('orderId', o.order_id, 'amountCents', o.amount_cents));
    RETURN jsonb_build_object('ok', true, 'status', 'settled', 'journalId', v_j);
  ELSIF p_outcome = 'failed' THEN
    UPDATE fleet_payment_instructions SET status = 'failed', failure_code = left(COALESCE(p_failure_code, 'unspecified'), 64), finished_at = now(),
           external_ref = p_external_ref WHERE instruction_id = i.instruction_id;
    PERFORM fleet_order_release(o, 'failed', 'custody-executor', 'executor', 'FLEET_EXECUTION_FAILED');
    RETURN jsonb_build_object('ok', true, 'status', 'failed');
  END IF;
  RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
END $$;

-- ═══ FleetAdmin (owner-only; never granted) ══════════════════════════════

CREATE FUNCTION fleet_admin_record(p_kind text, p_params jsonb, p_assessment jsonb, p_warnings text[], p_ack boolean, p_auth text,
  p_confirm_sha text, p_confirm_by timestamptz, p_status text, p_refusal text, p_result jsonb, p_actor text) RETURNS uuid LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_id uuid := gen_random_uuid(); v_against boolean := cardinality(COALESCE(p_warnings, ARRAY[]::text[])) > 0;
BEGIN
  INSERT INTO fleet_admin_instructions (instruction_id, kind, params, assessment, recommendation, override, warnings_acknowledged,
      auth_level, confirmation_sha256, confirm_by, status, refusal_code, result, actor, finished_at)
    VALUES (v_id, p_kind, p_params, p_assessment || jsonb_build_object('warnings', to_jsonb(COALESCE(p_warnings, ARRAY[]::text[]))),
      CASE WHEN v_against THEN 'recommend_against' ELSE 'proceed' END, v_against AND p_status = 'executed', COALESCE(p_ack, false),
      p_auth, p_confirm_sha, p_confirm_by, p_status, p_refusal, p_result, p_actor,
      CASE WHEN p_status = 'pending_confirmation' THEN NULL ELSE now() END);
  PERFORM fleet_event('admin_instruction_' || p_status, NULL, p_actor,
    jsonb_build_object('instructionId', v_id, 'kind', p_kind, 'override', v_against AND p_status = 'executed', 'refusal', p_refusal));
  RETURN v_id;
END $$;

-- Owner decision on an order awaiting the owner. Policy warnings can be acknowledged
-- (owner authority); constitutional/availability checks can never be overridden.
CREATE FUNCTION fleet_admin_spend_decision(p_order uuid, p_decision text, p_actor text, p_note text, p_ack boolean) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_payment_orders; v_hard text; v_warn text[] := ARRAY[]::text[]; v_admin uuid; m fleet_economic_model; v_today bigint;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  SELECT * INTO o FROM fleet_payment_orders WHERE order_id = p_order FOR UPDATE;
  IF NOT FOUND OR o.status <> 'awaiting_owner' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: order is not awaiting the owner'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), COALESCE(o.agent_id, 'fleet_treasury'));
  IF p_decision = 'reject' THEN
    v_admin := fleet_admin_record('spend_decision', jsonb_build_object('orderId', o.order_id, 'decision', 'reject'), '{}'::jsonb, NULL, true,
      'standard', NULL, NULL, 'executed', NULL, NULL, p_actor);
    UPDATE fleet_payment_orders SET status = 'rejected', decided_by = p_actor, decision_code = 'FLEET_REJECTED_BY_OWNER',
           decision_reason = left(fleet_scrub(p_note), 300), admin_instruction_id = v_admin WHERE order_id = o.order_id RETURNING * INTO o;
    RETURN jsonb_build_object('status', 'rejected', 'order', fleet_order_json(o));
  ELSIF p_decision <> 'approve' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: decision is approve or reject';
  END IF;
  PERFORM 1 FROM fleet_ledger_accounts WHERE account_id = fleet_ledger_account(o.agent_id, 'agent_cash') FOR UPDATE;
  v_hard := fleet_order_hard_check(o);
  IF v_hard IS NOT NULL THEN
    v_admin := fleet_admin_record('spend_decision', jsonb_build_object('orderId', o.order_id, 'decision', 'approve'), '{}'::jsonb, NULL, p_ack,
      'standard', NULL, NULL, 'refused', v_hard, NULL, p_actor);
    RETURN jsonb_build_object('status', 'refused', 'code', v_hard, 'constitutional', true);
  END IF;
  SELECT * INTO m FROM fleet_economic_model WHERE id = 1;
  SELECT COALESCE(sum(amount_cents), 0) INTO v_today FROM fleet_payment_orders
   WHERE agent_id = o.agent_id AND status IN ('reserved','executing','settled') AND created_at > now() - interval '1 day';
  IF o.amount_cents > m.owner_approval_threshold_cents THEN v_warn := v_warn || 'above_owner_threshold'::text; END IF;
  IF v_today + o.amount_cents > m.agent_daily_spend_cents THEN v_warn := v_warn || 'above_agent_daily_policy'::text; END IF;
  IF cardinality(v_warn) > 0 AND NOT COALESCE(p_ack, false) THEN
    RETURN jsonb_build_object('status', 'needs_acknowledgement', 'warnings', to_jsonb(v_warn), 'recommendation', 'recommend_against');
  END IF;
  v_admin := fleet_admin_record('spend_decision', jsonb_build_object('orderId', o.order_id, 'decision', 'approve'),
    jsonb_build_object('dailyAfterCents', v_today + o.amount_cents), v_warn, p_ack, 'standard', NULL, NULL, 'executed', NULL, NULL, p_actor);
  o := fleet_order_reserve(o, p_actor, 'owner', p_actor, 'FLEET_APPROVED_BY_OWNER', COALESCE(fleet_scrub(p_note), 'owner approval'), v_admin);
  RETURN jsonb_build_object('status', 'reserved', 'override', cardinality(v_warn) > 0, 'order', fleet_order_json(o), 'instructionId', v_admin);
END $$;

-- Treasury assessment used by owner instructions (never a veto on policy grounds).
CREATE FUNCTION fleet_treasury_assessment(p_outflow_cents bigint) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_unalloc bigint := fleet_ledger_balance('fleet:treasury:unallocated'); v_oblig bigint; v_reserve_target bigint; p fleet_treasury_policy;
        v_monthly bigint;
BEGIN
  SELECT * INTO p FROM fleet_treasury_policy WHERE id = 1;
  SELECT COALESCE(sum(amount_cents), 0) INTO v_oblig FROM fleet_treasury_obligations WHERE status = 'approved';
  SELECT COALESCE(sum(p2.amount_cents), 0) INTO v_monthly FROM fleet_ledger_postings p2 JOIN fleet_ledger_journal j ON j.journal_id = p2.journal_id
   JOIN fleet_ledger_accounts a ON a.account_id = p2.account_id
   WHERE a.class IN ('fleet_expense','agent_expense','agent_fees') AND p2.side = 'D' AND j.occurred_at > now() - interval '30 days';
  v_reserve_target := ceil(v_monthly * p.reserve_target_months)::bigint;
  RETURN jsonb_build_object('unallocatedCents', v_unalloc, 'afterCents', v_unalloc - p_outflow_cents, 'treasuryObligationsCents', v_oblig,
    'reserveTargetCents', v_reserve_target, 'monthlyExpenseCents', v_monthly,
    'operatingReserveCents', fleet_ledger_balance('fleet:treasury:operating_reserve'),
    'contingencyCents', fleet_ledger_balance('fleet:treasury:contingency'));
END $$;

-- Owner withdrawal instruction (E8). Hard: amount available, owner destination active.
-- Soft (acknowledgeable): reserve target, obligations. Strong auth above the threshold:
-- a two-step confirmation with a one-time code (only its SHA-256 is stored).
CREATE FUNCTION fleet_admin_owner_withdrawal(p_amount bigint, p_destination text, p_actor text, p_reason text, p_ack boolean, p_idem text, p_confirmation_sha256 text)
RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE d fleet_payment_destinations; a jsonb; v_warn text[] := ARRAY[]::text[]; m fleet_economic_model; o fleet_payment_orders; v_admin uuid; v_hard text;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');
  IF p_amount IS NULL OR p_amount <= 0 OR p_idem IS NULL OR p_idem !~ '^[A-Za-z0-9:_.-]{8,128}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: amount and idempotency key required'; END IF;
  SELECT * INTO m FROM fleet_economic_model WHERE id = 1;
  SELECT * INTO d FROM fleet_payment_destinations WHERE destination_id = p_destination;
  a := fleet_treasury_assessment(p_amount);
  IF NOT FOUND OR d.kind <> 'owner' THEN v_hard := 'FLEET_DESTINATION_NOT_ALLOWED';
  ELSIF d.status <> 'active' THEN v_hard := 'FLEET_DESTINATION_NOT_ACTIVE';
  ELSIF (a ->> 'unallocatedCents')::bigint < p_amount THEN v_hard := 'FLEET_INSUFFICIENT_TREASURY';
  END IF;
  IF v_hard IS NOT NULL THEN
    v_admin := fleet_admin_record('owner_withdrawal', jsonb_build_object('amountCents', p_amount, 'destinationId', p_destination), a, NULL, p_ack,
      'standard', NULL, NULL, 'refused', v_hard, NULL, p_actor);
    RETURN jsonb_build_object('status', 'refused', 'code', v_hard, 'constitutional', true, 'instructionId', v_admin);
  END IF;
  IF (a ->> 'afterCents')::bigint < (a ->> 'reserveTargetCents')::bigint THEN v_warn := v_warn || 'below_reserve_target'::text; END IF;
  IF (a ->> 'afterCents')::bigint < (a ->> 'treasuryObligationsCents')::bigint THEN v_warn := v_warn || 'below_treasury_obligations'::text; END IF;
  IF cardinality(v_warn) > 0 AND NOT COALESCE(p_ack, false) THEN
    RETURN jsonb_build_object('status', 'needs_acknowledgement', 'warnings', to_jsonb(v_warn), 'recommendation', 'recommend_against', 'assessment', a);
  END IF;
  IF p_amount >= m.strong_auth_threshold_cents THEN
    IF p_confirmation_sha256 IS NULL OR p_confirmation_sha256 !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'FLEET_STRONG_AUTH_REQUIRED: a confirmation code digest is required'; END IF;
    v_admin := fleet_admin_record('owner_withdrawal', jsonb_build_object('amountCents', p_amount, 'destinationId', p_destination, 'idempotencyKey', p_idem,
      'reason', left(fleet_scrub(p_reason), 200)), a, v_warn, p_ack, 'strong', p_confirmation_sha256, now() + make_interval(secs => m.confirmation_ttl_s),
      'pending_confirmation', NULL, NULL, p_actor);
    RETURN jsonb_build_object('status', 'pending_confirmation', 'instructionId', v_admin, 'confirmBy', now() + make_interval(secs => m.confirmation_ttl_s));
  END IF;
  v_admin := fleet_admin_record('owner_withdrawal', jsonb_build_object('amountCents', p_amount, 'destinationId', p_destination, 'idempotencyKey', p_idem),
    a, v_warn, p_ack, 'standard', NULL, NULL, 'executed', NULL, NULL, p_actor);
  RETURN fleet_admin_withdrawal_place(v_admin, p_amount, p_destination, p_actor, p_reason, p_idem);
END $$;

CREATE FUNCTION fleet_admin_withdrawal_place(p_admin uuid, p_amount bigint, p_destination text, p_actor text, p_reason text, p_idem text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_payment_orders; m fleet_economic_model; v_hard text;
BEGIN
  SELECT * INTO m FROM fleet_economic_model WHERE id = 1;
  INSERT INTO fleet_payment_orders (order_id, order_type, idempotency_key, amount_cents, category, destination_id, purpose, requested_by,
      request_sha256, status, expires_at)
    VALUES (gen_random_uuid(), 'owner_withdrawal', p_idem, p_amount, 'owner_withdrawal', p_destination, left(COALESCE(NULLIF(fleet_scrub(p_reason), ''), 'owner withdrawal'), 300),
      p_actor, encode(sha256(convert_to(concat_ws('|', 'owner', p_amount, p_destination), 'UTF8')), 'hex'), 'requested',
      now() + make_interval(secs => m.reservation_ttl_s))
    RETURNING * INTO o;
  v_hard := fleet_order_hard_check(o);
  IF v_hard IS NOT NULL THEN RAISE EXCEPTION '%: re-check failed at placement', v_hard; END IF;
  o := fleet_order_reserve(o, p_actor, 'owner', p_actor, 'FLEET_APPROVED_BY_OWNER', 'owner withdrawal (inert: no execution in v10)', p_admin);
  RETURN jsonb_build_object('status', 'reserved', 'order', fleet_order_json(o), 'instructionId', p_admin, 'executed', false);
END $$;

-- Second step of a strong-auth instruction: the one-time code, before it expires.
CREATE FUNCTION fleet_admin_confirm(p_instruction uuid, p_code text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE ai fleet_admin_instructions; r jsonb;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  SELECT * INTO ai FROM fleet_admin_instructions WHERE instruction_id = p_instruction FOR UPDATE;
  IF NOT FOUND OR ai.status <> 'pending_confirmation' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: nothing to confirm'; END IF;
  IF ai.actor <> p_actor THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: the instructing owner confirms'; END IF;
  IF now() > ai.confirm_by THEN
    UPDATE fleet_admin_instructions SET status = 'expired', finished_at = now() WHERE instruction_id = ai.instruction_id;
    RETURN jsonb_build_object('status', 'expired');
  END IF;
  IF p_code IS NULL OR encode(sha256(convert_to(p_code, 'UTF8')), 'hex') <> ai.confirmation_sha256 THEN
    RAISE EXCEPTION 'FLEET_STRONG_AUTH_FAILED: confirmation code does not match';
  END IF;
  IF ai.kind <> 'owner_withdrawal' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: unsupported kind'; END IF;
  r := fleet_admin_withdrawal_place(ai.instruction_id, (ai.params ->> 'amountCents')::bigint, ai.params ->> 'destinationId', p_actor,
    ai.params ->> 'reason', ai.params ->> 'idempotencyKey');
  UPDATE fleet_admin_instructions SET status = 'executed', finished_at = now(), result = r,
         override = (recommendation = 'recommend_against') WHERE instruction_id = ai.instruction_id;
  RETURN r;
END $$;

-- Capital to an agent: its own equity (grant) or protected principal (advance). Hard:
-- available treasury cash; agent active. Soft: reserve target.
CREATE FUNCTION fleet_admin_agent_capital(p_agent text, p_amount bigint, p_mode text, p_actor text, p_reason text, p_ack boolean, p_idem text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a jsonb; v_warn text[] := ARRAY[]::text[]; v_admin uuid; v_j uuid; ag fleet_agents; v_hard text;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), p_agent);
  IF p_mode NOT IN ('grant','principal') OR p_amount IS NULL OR p_amount <= 0 OR p_idem IS NULL THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST'; END IF;
  SELECT * INTO ag FROM fleet_agents WHERE agent_id = p_agent;
  a := fleet_treasury_assessment(p_amount);
  IF NOT FOUND OR ag.status <> 'active' THEN v_hard := 'FLEET_AGENT_NOT_ACTIVE';
  ELSIF (a ->> 'unallocatedCents')::bigint < p_amount THEN v_hard := 'FLEET_INSUFFICIENT_TREASURY';
  END IF;
  IF v_hard IS NOT NULL THEN
    v_admin := fleet_admin_record(CASE p_mode WHEN 'grant' THEN 'capital_grant' ELSE 'principal_advance' END,
      jsonb_build_object('agentId', p_agent, 'amountCents', p_amount), a, NULL, p_ack, 'standard', NULL, NULL, 'refused', v_hard, NULL, p_actor);
    RETURN jsonb_build_object('status', 'refused', 'code', v_hard, 'constitutional', true);
  END IF;
  IF (a ->> 'afterCents')::bigint < (a ->> 'reserveTargetCents')::bigint THEN v_warn := v_warn || 'below_reserve_target'::text; END IF;
  IF cardinality(v_warn) > 0 AND NOT COALESCE(p_ack, false) THEN
    RETURN jsonb_build_object('status', 'needs_acknowledgement', 'warnings', to_jsonb(v_warn), 'recommendation', 'recommend_against', 'assessment', a);
  END IF;
  PERFORM fleet_ledger_open_agent(p_agent, p_actor);
  v_admin := fleet_admin_record(CASE p_mode WHEN 'grant' THEN 'capital_grant' ELSE 'principal_advance' END,
    jsonb_build_object('agentId', p_agent, 'amountCents', p_amount), a, v_warn, p_ack, 'standard', NULL, NULL, 'executed', NULL, NULL, p_actor);
  IF p_mode = 'grant' THEN
    v_j := fleet_ledger_post('agent_capital_grant', p_idem, p_actor, COALESCE(p_reason, 'capital grant'), 'owner', p_agent, NULL, v_admin::text, NULL, NULL, now(),
      jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_cash'), 'side', 'D', 'amount', p_amount),
                        jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', p_amount)));
  ELSE
    v_j := fleet_ledger_post('principal_advance', p_idem, p_actor, COALESCE(p_reason, 'protected principal advance'), 'owner', p_agent, NULL, v_admin::text, NULL, NULL, now(),
      jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_cash'), 'side', 'D', 'amount', p_amount),
                        jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', p_amount),
                        jsonb_build_object('account', 'fleet:treasury:principal_receivable', 'side', 'D', 'amount', p_amount),
                        jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_principal'), 'side', 'C', 'amount', p_amount)));
  END IF;
  RETURN jsonb_build_object('status', 'executed', 'journalId', v_j, 'instructionId', v_admin, 'override', cardinality(v_warn) > 0);
END $$;

-- Realized-profit contribution (LFC). Never more than realized, uncontributed net profit;
-- never below the protected claims (survival equity stays >= 0).
CREATE FUNCTION fleet_profit_contribution(p_agent text, p_amount bigint, p_actor text, p_source text, p_idem text) RETURNS uuid LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE e jsonb;
BEGIN
  IF p_source NOT IN ('owner','controller') THEN RAISE EXCEPTION 'FLEET_LEDGER_SOURCE: contributions come from the controller or the owner'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: positive amount required'; END IF;
  PERFORM 1 FROM fleet_ledger_accounts WHERE account_id = fleet_ledger_account(p_agent, 'agent_cash') FOR UPDATE;
  e := fleet_agent_economics(p_agent);
  IF p_amount > (e ->> 'uncontributedProfit')::bigint THEN
    RAISE EXCEPTION 'FLEET_LFC_EXCEEDS_REALIZED_PROFIT: % > uncontributed realized net profit %', p_amount, e ->> 'uncontributedProfit';
  END IF;
  IF (e ->> 'survivalEquity')::bigint - p_amount < 0 OR (e ->> 'cash')::bigint < p_amount THEN
    RAISE EXCEPTION 'FLEET_PROTECTED_CAPITAL: contribution would breach protected principal/obligations';
  END IF;
  RETURN fleet_ledger_post('profit_contribution', p_idem, p_actor, 'realized net profit contribution', p_source, p_agent, NULL, NULL, NULL, NULL, now(),
    jsonb_build_array(jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', p_amount),
                      jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_cash'), 'side', 'C', 'amount', p_amount),
                      jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_contributions'), 'side', 'D', 'amount', p_amount),
                      jsonb_build_object('account', 'fleet:profit', 'side', 'C', 'amount', p_amount)));
END $$;

-- ═══ Estate (E3/E9): freeze -> reconcile -> recover principal -> transfer -> close ═
CREATE FUNCTION fleet_estate_open(p_agent text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE ag fleet_agents; o fleet_payment_orders; n integer := 0;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  SELECT * INTO ag FROM fleet_agents WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND OR ag.status NOT IN ('dead','failed','orphaned','terminating') THEN
    RAISE EXCEPTION 'FLEET_ESTATE_INVALID: estates are opened only for agents that are dying or dead';
  END IF;
  INSERT INTO fleet_estates (agent_id, opened_by) VALUES (p_agent, p_actor) ON CONFLICT (agent_id) DO NOTHING;
  -- Freeze authority: every open order is cancelled and its funds released.
  FOR o IN SELECT * FROM fleet_payment_orders WHERE agent_id = p_agent AND status IN ('awaiting_owner','reserved') FOR UPDATE LOOP
    PERFORM fleet_order_release(o, 'cancelled', p_actor, 'owner', 'FLEET_ESTATE_FREEZE');
    n := n + 1;
  END LOOP;
  PERFORM fleet_event('estate_opened', p_agent, p_actor, jsonb_build_object('ordersCancelled', n));
  RETURN jsonb_build_object('status', 'open', 'ordersCancelled', n,
    'executingOrders', (SELECT count(*) FROM fleet_payment_orders WHERE agent_id = p_agent AND status = 'executing'));
END $$;

CREATE FUNCTION fleet_estate_settle(p_agent text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE es fleet_estates; e jsonb; v_cash bigint; v_principal bigint; v_rec bigint; v_assets bigint; v_wo bigint; s jsonb := '{}'::jsonb;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  SELECT * INTO es FROM fleet_estates WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND OR es.status <> 'open' THEN RAISE EXCEPTION 'FLEET_ESTATE_INVALID: no open estate'; END IF;
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
  -- Economic ownership of every asset under the agent moves to the treasury (never orphaned).
  UPDATE fleet_assets SET economic_owner_account = 'fleet:assets', authority_agent_id = NULL WHERE authority_agent_id = p_agent;
  s := jsonb_build_object('principalRecovered', v_rec, 'principalWrittenOff', v_wo, 'cashToTreasury', v_cash, 'assetsToTreasury', v_assets);
  UPDATE fleet_estates SET status = 'settled', settled_at = now(), settled_by = p_actor, summary = s WHERE agent_id = p_agent;
  PERFORM fleet_event('estate_settled', p_agent, p_actor, s);
  RETURN jsonb_build_object('status', 'settled') || s;
END $$;

-- Assets whose authority agent is no longer living and whose estate is not settled (doctor).
CREATE FUNCTION fleet_estate_attention() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'assetsUnderDeadAgents', (SELECT count(*) FROM fleet_assets fa JOIN fleet_agents a ON a.agent_id = fa.authority_agent_id
                                WHERE a.status IN ('dead','failed') AND fa.status = 'held'),
    'deadAgentsWithBalances', (SELECT count(DISTINCT acc.agent_id) FROM fleet_ledger_accounts acc JOIN fleet_agents a ON a.agent_id = acc.agent_id
                                 WHERE a.status IN ('dead','failed') AND acc.class IN ('agent_cash','agent_reserved','agent_assets','agent_principal')
                                   AND fleet_ledger_balance(acc.account_id) <> 0
                                   AND NOT EXISTS (SELECT 1 FROM fleet_estates e WHERE e.agent_id = a.agent_id AND e.status = 'settled')),
    'assetsWithoutOwner', (SELECT count(*) FROM fleet_assets WHERE economic_owner_account IS NULL))
$$;

-- ═══ Owner bookkeeping and destination enrollment (owner-only; never granted) ═
-- Destination enrollment is separate from payment approval: a destination is
-- enrolled pending, activates only after the cooldown AND with the one-time
-- activation code issued at enrollment (only its SHA-256 is stored), and is
-- immutable afterwards (revoke + re-enroll to change it).
CREATE FUNCTION fleet_destination_enroll(p_id text, p_kind text, p_rail text, p_label text, p_reference_sha256 text, p_hint text,
  p_agent text, p_actor text, p_code_sha256 text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE m fleet_economic_model; d fleet_payment_destinations;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  SELECT * INTO m FROM fleet_economic_model WHERE id = 1;
  INSERT INTO fleet_payment_destinations (destination_id, kind, rail, label, reference_sha256, reference_hint, allowed_agent_id, enrolled_by,
      activatable_at, activation_code_sha256)
    VALUES (p_id, p_kind, p_rail, left(fleet_scrub(p_label), 100), p_reference_sha256, p_hint, p_agent, p_actor,
      now() + make_interval(secs => m.destination_cooldown_s), p_code_sha256)
    RETURNING * INTO d;
  PERFORM fleet_event('payment_destination_enrolled', p_agent, p_actor,
    jsonb_build_object('destinationId', d.destination_id, 'kind', d.kind, 'rail', d.rail, 'activatableAt', d.activatable_at));
  RETURN jsonb_build_object('destinationId', d.destination_id, 'status', d.status, 'activatableAt', d.activatable_at);
END $$;

CREATE FUNCTION fleet_destination_activate(p_id text, p_code text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE d fleet_payment_destinations;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  SELECT * INTO d FROM fleet_payment_destinations WHERE destination_id = p_id FOR UPDATE;
  IF NOT FOUND OR d.status <> 'pending' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: destination is not pending'; END IF;
  IF p_code IS NULL OR encode(sha256(convert_to(p_code, 'UTF8')), 'hex') <> d.activation_code_sha256 THEN
    PERFORM fleet_event('payment_destination_activation_failed', d.allowed_agent_id, p_actor, jsonb_build_object('destinationId', p_id));
    RAISE EXCEPTION 'FLEET_STRONG_AUTH_FAILED: activation code does not match';
  END IF;
  UPDATE fleet_payment_destinations SET status = 'active', activated_by = p_actor, activated_at = now() WHERE destination_id = p_id RETURNING * INTO d;
  PERFORM fleet_event('payment_destination_activated', d.allowed_agent_id, p_actor, jsonb_build_object('destinationId', p_id));
  RETURN jsonb_build_object('destinationId', p_id, 'status', d.status);
END $$;

CREATE FUNCTION fleet_destination_revoke(p_id text, p_actor text, p_reason text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE d fleet_payment_destinations;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  UPDATE fleet_payment_destinations SET status = 'revoked', revoked_by = p_actor, revoked_at = now(), revoke_reason = left(fleet_scrub(p_reason), 200)
   WHERE destination_id = p_id AND status <> 'revoked' RETURNING * INTO d;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: no such live destination'; END IF;
  PERFORM fleet_event('payment_destination_revoked', d.allowed_agent_id, p_actor, jsonb_build_object('destinationId', p_id));
  RETURN jsonb_build_object('destinationId', p_id, 'status', d.status);
END $$;

-- Record owner capital already received into custody (bookkeeping of an external
-- fact; moves nothing). The external reference is unique per kind.
CREATE FUNCTION fleet_admin_record_owner_funding(p_amount bigint, p_external_ref text, p_actor text, p_idem text) RETURNS uuid LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_admin uuid; v_j uuid;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  v_j := fleet_ledger_post('owner_funding', p_idem, p_actor, 'owner capital received into custody', 'owner', NULL, NULL, NULL, p_external_ref, NULL, now(),
    jsonb_build_array(jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', p_amount),
                      jsonb_build_object('account', 'fleet:owner:capital', 'side', 'C', 'amount', p_amount)));
  v_admin := fleet_admin_record('owner_funding_record', jsonb_build_object('amountCents', p_amount, 'journalId', v_j), '{}'::jsonb, NULL, true,
    'standard', NULL, NULL, 'executed', NULL, jsonb_build_object('journalId', v_j), p_actor);
  RETURN v_j;
END $$;

-- Record realized external revenue of an agent already received into custody.
CREATE FUNCTION fleet_admin_record_revenue(p_agent text, p_amount bigint, p_external_ref text, p_actor text, p_idem text) RETURNS uuid LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_ledger_open_agent(p_agent, p_actor);
  RETURN fleet_ledger_post('external_revenue', p_idem, p_actor, 'realized external revenue', 'owner', p_agent, NULL, NULL, p_external_ref, NULL, now(),
    jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_cash'), 'side', 'D', 'amount', p_amount),
                      jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_revenue'), 'side', 'C', 'amount', p_amount)));
END $$;

-- Correct a journal by posting its exact mirror (the original stays in history).
CREATE FUNCTION fleet_admin_reverse(p_journal uuid, p_actor text, p_reason text, p_idem text) RETURNS uuid LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_ledger_journal; v_lines jsonb;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  SELECT * INTO j FROM fleet_ledger_journal WHERE journal_id = p_journal;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: journal %', p_journal; END IF;
  IF j.order_id IS NOT NULL THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: order journals are corrected through the order state machine'; END IF;
  SELECT jsonb_agg(jsonb_build_object('account', account_id, 'side', CASE side WHEN 'D' THEN 'C' ELSE 'D' END, 'amount', amount_cents) ORDER BY line)
    INTO v_lines FROM fleet_ledger_postings WHERE journal_id = p_journal;
  RETURN fleet_ledger_post('reversal', p_idem, p_actor, COALESCE(p_reason, 'reversal'), 'owner', j.agent_id, NULL, NULL, NULL, p_journal, now(), v_lines);
END $$;

-- ═══ Legacy economics: superseded, never deleted (E10/E11) ═══════════════
CREATE TABLE fleet_legacy_economics (
  table_name    text        PRIMARY KEY,
  row_count     bigint      NOT NULL,
  rows_sha256   text        NOT NULL CHECK (rows_sha256 ~ '^[0-9a-f]{64}$'),
  superseded_at timestamptz NOT NULL DEFAULT now(),
  note          text        NOT NULL
);
INSERT INTO fleet_legacy_economics (table_name, row_count, rows_sha256, note)
SELECT t.name, t.n, t.h, 'v5 legacy economic record; frozen at v10 (ledger is authoritative)' FROM (
  SELECT 'fleet_agent_ledger' AS name, (SELECT count(*) FROM fleet_agent_ledger) AS n,
         encode(sha256(convert_to(COALESCE((SELECT string_agg(row_to_json(x)::text, E'\\n' ORDER BY x.entry_id) FROM fleet_agent_ledger x), ''), 'UTF8')), 'hex') AS h
  UNION ALL SELECT 'fleet_balance_observations', (SELECT count(*) FROM fleet_balance_observations),
         encode(sha256(convert_to(COALESCE((SELECT string_agg(row_to_json(x)::text, E'\\n' ORDER BY x.observation_id) FROM fleet_balance_observations x), ''), 'UTF8')), 'hex')
  UNION ALL SELECT 'fleet_treasury_ledger', (SELECT count(*) FROM fleet_treasury_ledger),
         encode(sha256(convert_to(COALESCE((SELECT string_agg(row_to_json(x)::text, E'\\n' ORDER BY x.entry_id) FROM fleet_treasury_ledger x), ''), 'UTF8')), 'hex')
  UNION ALL SELECT 'fleet_sweep_plans', (SELECT count(*) FROM fleet_sweep_plans),
         encode(sha256(convert_to(COALESCE((SELECT string_agg(row_to_json(x)::text, E'\\n' ORDER BY x.plan_id) FROM fleet_sweep_plans x), ''), 'UTF8')), 'hex')
  UNION ALL SELECT 'fleet_owner_distributions', (SELECT count(*) FROM fleet_owner_distributions),
         encode(sha256(convert_to(COALESCE((SELECT string_agg(row_to_json(x)::text, E'\\n' ORDER BY x.distribution_id) FROM fleet_owner_distributions x), ''), 'UTF8')), 'hex')
  UNION ALL SELECT 'fleet_custody_transfers', (SELECT count(*) FROM fleet_custody_transfers),
         encode(sha256(convert_to(COALESCE((SELECT string_agg(row_to_json(x)::text, E'\\n' ORDER BY x.transfer_id) FROM fleet_custody_transfers x), ''), 'UTF8')), 'hex')
  UNION ALL SELECT 'fleet_spend_requests', (SELECT count(*) FROM fleet_spend_requests),
         encode(sha256(convert_to(COALESCE((SELECT string_agg(row_to_json(x)::text, E'\\n' ORDER BY x.request_id) FROM fleet_spend_requests x), ''), 'UTF8')), 'hex')
) t;
CREATE TRIGGER fleet_legacy_economics_no_change BEFORE UPDATE OR DELETE ON fleet_legacy_economics
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION fleet_legacy_superseded() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'FLEET_LEGACY_SUPERSEDED: % is a frozen v5 economic record; the v10 ledger is authoritative', TG_TABLE_NAME;
END $$;
CREATE TRIGGER fleet_agent_ledger_superseded BEFORE INSERT ON fleet_agent_ledger FOR EACH ROW EXECUTE FUNCTION fleet_legacy_superseded();
CREATE TRIGGER fleet_balance_observations_superseded BEFORE INSERT OR UPDATE OR DELETE ON fleet_balance_observations FOR EACH ROW EXECUTE FUNCTION fleet_legacy_superseded();
CREATE TRIGGER fleet_treasury_ledger_superseded BEFORE INSERT ON fleet_treasury_ledger FOR EACH ROW EXECUTE FUNCTION fleet_legacy_superseded();
CREATE TRIGGER fleet_sweep_plans_superseded BEFORE INSERT ON fleet_sweep_plans FOR EACH ROW EXECUTE FUNCTION fleet_legacy_superseded();
CREATE TRIGGER fleet_owner_distributions_superseded BEFORE INSERT ON fleet_owner_distributions FOR EACH ROW EXECUTE FUNCTION fleet_legacy_superseded();
CREATE TRIGGER fleet_custody_transfers_superseded BEFORE INSERT ON fleet_custody_transfers FOR EACH ROW EXECUTE FUNCTION fleet_legacy_superseded();
CREATE TRIGGER fleet_spend_requests_superseded BEFORE INSERT ON fleet_spend_requests FOR EACH ROW EXECUTE FUNCTION fleet_legacy_superseded();
CREATE TRIGGER fleet_balance_observations_no_truncate BEFORE TRUNCATE ON fleet_balance_observations FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

/**
 * Schema v47 — provider records and cash-basis settlement (Gumroad revenue integration, stage G2; design:
 * docs/design/gumroad-revenue-integration.md §§4, 5, 7.2).
 *
 * MONEY STATES ARE DISTINCT AND ONLY THE LAST IS SPENDABLE.
 *   S1 verified sale       fleet_provider_sales          memo (provider currency, USD minor units)   never cash
 *   S2 provider balance    a verified sale in no payout   memo                                        never cash
 *   S3 payout reported     fleet_provider_payouts (+lines, membership)                                never cash
 *   S4 money received      fleet_settlement_receipts (bank feed, or the labelled pilot attestation)    not by itself
 *   S5 accessible capital  S4 into a fleet_treasury destination whose fleet ACCESS is verified, with a complete
 *                          allocation — the only state that credits agent_cash (via fleet_ledger_post).
 * Recording a sale or a payout posts nothing. Registering a destination proves nothing: access must be evidenced
 * separately (fleet_admin_settlement_destination_verify_access), and a receipt into an owner_external account is held
 * until a matching transfer into the treasury is linked.
 *
 * BACKING. Agent cash is a partition of real treasury money (genesis_allocation: D agent_cash / C treasury_cash). A
 * received payout therefore credits agents' cash for their shares, and the treasury (D treasury_cash / C
 * provider_suspense) for any part that belongs to no agent yet. A negative share an agent cannot cover from its cash is
 * ADVANCED by the treasury (D provider_advances / C treasury_cash) against the agent's agent_provider_payable, which
 * reduces its survival equity and therefore its spending capacity, and is repaid first from its later shares. Real
 * money is never fabricated: Σ agent cash deltas + treasury delta = the receipt, exactly, in minor units.
 *
 * ATTRIBUTION IS HISTORY. fleet_provider_product_attributions is append-only; a sale belongs to the owner of its
 * product AT THE SALE TIME. A first assignment may be backdated; a reassignment takes effect from now and never
 * rewrites who earned past sales. Unmapped, ambiguous or inconsistent amounts stay in provider_suspense: a payout whose
 * rows do not reconcile (USD: Σ net = amount exactly; other currencies: implied rate within ±3% of the recorded FX
 * sanity rate) is quarantined whole; a row without an owner goes to suspense; nothing is allocated by guesswork.
 *
 * CURRENCY. Gumroad reports sale rows in USD minor units and pays out in the payout currency; it publishes no per-sale
 * payout-currency amount. For a non-USD payout the RECEIVED amount is split pro rata to each agent's USD net with
 * largest-remainder rounding (exact in total) — an ALLOCATION POLICY (basis pro_rata_usd_net), never presented as a
 * provider exchange rate for any sale. A USD payout allocates exactly by row (basis usd_exact).
 *
 * ONE CREDIT PER EXTERNAL SETTLEMENT. Canonical identities: gumroad:<user_id>:payout:<payout_id> and
 * bank:<destination_id>:txn:<bank_txn_id>, claimed in fleet_revenue_claims inside the posting transaction (PRIMARY KEY:
 * concurrent attempts — one wins, the other rolls back). Manual revenue whose counterparty is a registered provider
 * account, or whose reference is a known payout or bank transaction, must claim the canonical payout key; automated
 * posting finds a manual claim and records nothing; owner funding can never reuse a receipt's reference.
 *
 * Nothing here connects to a provider (the G3 gateway and G4 bank feed call these recorders through their own roles),
 * changes REAL_PAYMENTS_ENABLED or any host switch, or touches outgoing payments. Migration posts no journal.
 */
import { V11_SQL } from "./migrations-phase11.js";
import { V29_SQL } from "./migrations-phase29.js";
import { V42_SQL, restate } from "./migrations-phase42.js";
import { V46_SQL } from "./migrations-phase46.js";

export const PAYOUT_ROW_TYPES = ["sale", "full_refund", "partial_refund", "chargeback", "credit", "refund_fee_written_off",
  "failed_refund_fee_returned", "failed_refund_fee_retained", "affiliate_credit", "payout_fee", "technical_adjustment", "summary"] as const;
/** Accounting tolerance for the implied payout rate vs the recorded FX rate (a sanity bound, never used to convert). */
export const PAYOUT_FX_TOLERANCE_BP = 300;
export const PILOT_MAX_DAYS = 30;
export const RECEIPT_MATCH_BUSINESS_DAYS = 7;

/** v47 event types and their Fleet Command routes. */
export const EVENT_ROUTES_V47 = Object.freeze({
  AUDIT_ONLY: ["provider_account_registered", "provider_product_assigned", "destination_added"],
  P1_HIGH: ["provider_conflict", "receipt_held", "pilot_authorised"],
  P2_IMPORTANT: ["receipt_posted", "destination_access_verified", "pilot_revoked", "provider_suspense_released", "receipt_debit_assigned"],
} as const);

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;`;
const CLAIM_RE = `'^[a-z][a-z0-9_]{1,20}:[A-Za-z0-9._:@/=-]{3,200}$'`;
const ID_RE = `'^[A-Za-z0-9=_-]{3,64}$'`;
const TXN_RE = `'^[A-Za-z0-9._:/=-]{3,120}$'`;

const OPEN_AGENT = restate(V42_SQL, "fleet_ledger_open_agent", [
  [`'agent_project_escrow','agent_project_income','agent_project_expense','agent_distribution_out','agent_distribution_in']`,
   `'agent_project_escrow','agent_project_income','agent_project_expense','agent_distribution_out','agent_distribution_in',
                           'agent_provider_payable']`],
]);

// A provider payable is owed by the agent: it reduces survival equity (and with it the spending capacity) like an
// approved obligation.
const ECONOMICS = restate(V42_SQL, "fleet_agent_economics", [
  [`DECLARE v_escrow bigint;`, `DECLARE v_payable bigint; v_escrow bigint;`],
  [`  v_escrow := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_project_escrow'));`,
   `  v_escrow := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_project_escrow'));
  v_payable := COALESCE((SELECT fleet_ledger_balance(account_id) FROM fleet_ledger_accounts WHERE agent_id = p_agent AND class = 'agent_provider_payable'), 0);`],
  [`  v_eq := v_rec - v_principal - v_oblig;`, `  v_eq := v_rec - v_principal - v_oblig - v_payable;`],
  [`    'profitDistributedOut', v_dout, 'profitDistributionsIn', v_din);`,
   `    'profitDistributedOut', v_dout, 'profitDistributionsIn', v_din, 'providerPayable', v_payable);`],
]);

const WALLET = restate(V29_SQL, "fleet_agent_wallet", [
  [`    'pendingSettlementMinor', v_pending,`,
   `    'pendingSettlementMinor', v_pending,
    -- v47: provider revenue not yet received (memo, never spendable) and what the agent owes back to the treasury.
    'providerPayableMinor', COALESCE((eco ->> 'providerPayable')::bigint, 0),
    'providerPending', fleet_agent_provider_memo(p_agent),`],
]);

// Manual revenue against a registered provider account must claim the canonical payout key (set by the claimed recorder
// for its own call); a manual refund of provider revenue is refused (refunds arrive through payouts).
const RECORD_EXTERNAL = restate(V46_SQL, "fleet_admin_record_external", [
  [`  IF fleet_claim_taken(p_external_ref) THEN`,
   `  IF fleet_provider_counterparty(p_counterparty_sha256) IS NOT NULL OR fleet_provider_reference_known(p_external_ref) THEN
    IF p_kind = 'external_revenue' AND COALESCE(current_setting('fleet.claim_key', true), '') = '' THEN
      RAISE EXCEPTION 'FLEET_CLAIM_REQUIRED: revenue from a registered provider account must claim its payout (ledger-record-revenue --claims gumroad:<account>:payout:<id>)';
    ELSIF p_kind <> 'external_revenue' THEN
      RAISE EXCEPTION 'FLEET_PROVIDER_AUTOMATED: refunds and adjustments of provider revenue arrive through its payouts';
    END IF;
  END IF;
  IF fleet_claim_taken(p_external_ref) THEN`],
]);

const RECORD_CLAIMED = restate(V46_SQL, "fleet_admin_record_external_claimed", [
  [`  IF p_claim_key IS NULL OR p_claim_key !~ '^[a-z][a-z0-9_]{1,20}:[A-Za-z0-9._:@/-]{3,200}$' THEN`,
   // (restate uses String.replace: a literal $ in a replacement must be written $$)
   `  IF p_claim_key IS NULL OR p_claim_key !~ ${CLAIM_RE.replace(/\$/g, "$$$$")} THEN`],
  [`  IF fleet_claim_taken(p_claim_key) THEN RAISE EXCEPTION 'FLEET_ALREADY_CLAIMED: this external settlement is already recorded (claim %)', p_claim_key; END IF;
  v_j := fleet_admin_record_external(p_kind, p_agent, p_amount, p_external_ref, p_counterparty_sha256, p_actor, p_idem);
  INSERT INTO fleet_revenue_claims (claim_key, claim_kind, journal_id, claimed_by) VALUES (p_claim_key, 'manual_revenue', v_j, p_actor);`,
   `  IF fleet_claim_taken(p_claim_key) THEN RAISE EXCEPTION 'FLEET_ALREADY_CLAIMED: this external settlement is already recorded (claim %)', p_claim_key; END IF;
  -- v47: a provider claim names a registered account and a payout (optionally one part of it); revenue from a registered
  -- account's counterparty must claim that account's payout; a payout settled automatically cannot be claimed again.
  IF p_claim_key LIKE 'gumroad:%' OR fleet_provider_counterparty(p_counterparty_sha256) IS NOT NULL THEN
    v_acct := fleet_provider_claim_account(p_claim_key);
    IF v_acct IS NULL THEN
      RAISE EXCEPTION 'FLEET_BAD_REQUEST: a provider claim is gumroad:<registered account>:payout:<id>[:part:<n>]';
    END IF;
    IF fleet_provider_counterparty(p_counterparty_sha256) IS NOT NULL AND fleet_provider_counterparty(p_counterparty_sha256) <> v_acct THEN
      RAISE EXCEPTION 'FLEET_BAD_REQUEST: the counterparty belongs to another provider account than the claim';
    END IF;
    IF EXISTS (SELECT 1 FROM fleet_revenue_claims WHERE claim_key = fleet_provider_payout_claim_base(p_claim_key) AND claim_kind = 'provider_payout') THEN
      RAISE EXCEPTION 'FLEET_ALREADY_CLAIMED: the payout was settled automatically (claim %)', fleet_provider_payout_claim_base(p_claim_key);
    END IF;
    -- A payout is recorded manually either whole or in parts, never both.
    IF (p_claim_key = fleet_provider_payout_claim_base(p_claim_key)
          AND EXISTS (SELECT 1 FROM fleet_revenue_claims WHERE claim_key LIKE fleet_provider_payout_claim_base(p_claim_key) || ':part:%'))
       OR (p_claim_key <> fleet_provider_payout_claim_base(p_claim_key) AND fleet_claim_taken(fleet_provider_payout_claim_base(p_claim_key))) THEN
      RAISE EXCEPTION 'FLEET_ALREADY_CLAIMED: the payout is already recorded % (claim %)',
        CASE WHEN p_claim_key = fleet_provider_payout_claim_base(p_claim_key) THEN 'in parts' ELSE 'whole' END, fleet_provider_payout_claim_base(p_claim_key);
    END IF;
  END IF;
  PERFORM set_config('fleet.claim_key', p_claim_key, true);
  v_j := fleet_admin_record_external(p_kind, p_agent, p_amount, p_external_ref, p_counterparty_sha256, p_actor, p_idem);
  PERFORM set_config('fleet.claim_key', '', true);
  BEGIN
    INSERT INTO fleet_revenue_claims (claim_key, claim_kind, journal_id, claimed_by) VALUES (p_claim_key, 'manual_revenue', v_j, p_actor);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'FLEET_ALREADY_CLAIMED: this external settlement is already recorded (claim %)', p_claim_key;
  END;`],
  [`DECLARE v_j uuid;`, `DECLARE v_j uuid; v_acct uuid;`],
]);

const RECORD_FUNDING = restate(V46_SQL, "fleet_admin_record_owner_funding", [
  [`  v_j := fleet_ledger_post('owner_funding',`,
   `  -- v47: provider money reaches the treasury only through its receipt; owner funding never reuses a receipt reference.
  IF fleet_provider_reference_known(p_external_ref) OR p_external_ref LIKE 'gumroad:%'
     OR EXISTS (SELECT 1 FROM fleet_settlement_receipts WHERE 'bank:' || destination_id || ':txn:' || bank_txn_id = p_external_ref) THEN
    RAISE EXCEPTION 'FLEET_PROVIDER_RECEIPT: % is a provider payout or bank receipt reference; it is settled through its receipt, not as owner funding', p_external_ref;
  END IF;
  v_j := fleet_ledger_post('owner_funding',`],
]);

const EVENT_ROUTE = restate(V46_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V47) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
]);

const RECONCILE = restate(V46_SQL, "fleet_reconcile", [
  ["  -- Treasury: the unallocated partition never negative (ledger CHECK) — reported for the overview.",
   `  -- v47: provider settlement — suspense, held / unmatched receipts, unreceived payouts, conservation, advances ↔ payables.
  amt := fleet_ledger_balance('fleet:provider:suspense');
  IF amt <> 0 THEN f := f || jsonb_build_array(jsonb_build_object('severity', CASE WHEN amt < 0 THEN 'WARN' ELSE 'INFO' END, 'code', 'PROVIDER_SUSPENSE',
    'detail', jsonb_build_object('balanceMinor', amt))); END IF;
  SELECT count(*) INTO n FROM fleet_settlement_receipts WHERE status = 'held';
  IF n > 0 THEN f := f || jsonb_build_array(jsonb_build_object('severity', 'WARN', 'code', 'PROVIDER_RECEIPTS_HELD', 'detail', jsonb_build_object('count', n))); END IF;
  SELECT count(*) INTO n FROM fleet_settlement_receipts WHERE status IN ('unmatched','ambiguous');
  IF n > 0 THEN f := f || jsonb_build_array(jsonb_build_object('severity',
    CASE WHEN EXISTS (SELECT 1 FROM fleet_settlement_receipts WHERE status IN ('unmatched','ambiguous') AND recorded_at < now() - interval '14 days') THEN 'FAIL' ELSE 'WARN' END,
    'code', 'PROVIDER_RECEIPTS_UNMATCHED', 'detail', jsonb_build_object('count', n))); END IF;
  SELECT count(*) INTO n FROM fleet_provider_payouts p WHERE p.status = 'completed' AND p.processed_at < now() - interval '14 days'
     AND NOT EXISTS (SELECT 1 FROM fleet_settlement_receipts rc WHERE rc.account_id = p.account_id AND rc.payout_id = p.payout_id);
  IF n > 0 THEN f := f || jsonb_build_array(jsonb_build_object('severity', 'WARN', 'code', 'PROVIDER_PAYOUTS_UNRECEIVED', 'detail', jsonb_build_object('count', n))); END IF;
  SELECT count(*) INTO n FROM fleet_settlement_receipts rc WHERE rc.status = 'posted' AND rc.manual_claim IS NULL
     AND (SELECT COALESCE(sum(a.share_minor), 0) FROM fleet_provider_allocations a WHERE a.receipt_id = rc.receipt_id) <> rc.amount_minor;
  f := f || jsonb_build_array(jsonb_build_object('severity', CASE WHEN n = 0 THEN 'INFO' ELSE 'FAIL' END, 'code', 'PROVIDER_ALLOCATION_CONSERVATION', 'detail', jsonb_build_object('mismatched', n)));
  amt := (SELECT COALESCE(sum(fleet_ledger_balance(account_id)), 0) FROM fleet_ledger_accounts WHERE class = 'agent_provider_payable');
  IF amt <> fleet_ledger_balance('fleet:provider:advances') THEN
    f := f || jsonb_build_array(jsonb_build_object('severity', 'FAIL', 'code', 'PROVIDER_ADVANCES_MATCH', 'detail', jsonb_build_object('payablesMinor', amt, 'advancesMinor', fleet_ledger_balance('fleet:provider:advances'))));
  ELSIF amt > 0 THEN f := f || jsonb_build_array(jsonb_build_object('severity', 'INFO', 'code', 'PROVIDER_PAYABLE_OUTSTANDING', 'detail', jsonb_build_object('payablesMinor', amt))); END IF;
  SELECT count(*) INTO n FROM fleet_ledger_journal j JOIN fleet_settlement_receipts rc
      ON rc.amount_minor = (SELECT COALESCE(sum(po.amount_cents), 0) FROM fleet_ledger_postings po WHERE po.journal_id = j.journal_id AND po.side = 'D')
     AND abs(j.occurred_at::date - rc.booked_on) <= 3
   WHERE j.kind = 'owner_funding' AND rc.amount_minor > 0;
  IF n > 0 THEN f := f || jsonb_build_array(jsonb_build_object('severity', 'WARN', 'code', 'FUNDING_MATCHES_PROVIDER_RECEIPT', 'detail', jsonb_build_object('count', n))); END IF;
  SELECT count(*) INTO n FROM fleet_provider_sales s WHERE fleet_provider_sale_owner(s.account_id, s.sale_id) IS NULL;
  IF n > 0 THEN f := f || jsonb_build_array(jsonb_build_object('severity', 'WARN', 'code', 'PROVIDER_UNATTRIBUTED_SALES', 'detail', jsonb_build_object('count', n))); END IF;
  -- Treasury: the unallocated partition never negative (ledger CHECK) — reported for the overview.`],
]);

export const V47_SQL = `
-- ═══ 1. Ledger grammar: suspense, advances, provider payable ═══
INSERT INTO fleet_ledger_classes (class, kind, normal_side, scope, non_negative, description) VALUES
  ('provider_suspense',      'liability', 'C', 'fleet', false, 'Received provider money that belongs to no agent yet (unmapped, ambiguous or unreconciled); signed'),
  ('provider_advances',      'asset',     'D', 'fleet', true,  'Treasury money advanced to cover an agent''s provider shortfall (a refund or chargeback it could not pay)'),
  ('agent_provider_payable', 'liability', 'C', 'agent', true,  'What the agent owes the treasury for a provider shortfall it advanced; reduces survival equity');
INSERT INTO fleet_ledger_accounts (account_id, class, description, created_by) VALUES
  ('fleet:provider:suspense', 'provider_suspense', 'Provider receipts not yet attributable', 'migration'),
  ('fleet:provider:advances', 'provider_advances', 'Treasury advances against agents'' provider payables', 'migration');
INSERT INTO fleet_ledger_kinds (kind, requires_external_ref, allowed_sources, multi_agent, description, provenance) VALUES
  ('provider_revenue_receipt',     true, ARRAY['controller','owner'], false, 'An agent''s share of a provider payout received into the fleet treasury', 'external_customer_revenue'),
  ('provider_receipt_suspense',    true, ARRAY['controller','owner'], false, 'The unattributable part of a provider receipt (held for the treasury)', 'external_customer_revenue'),
  ('provider_suspense_allocation', true, ARRAY['controller','owner'], false, 'Provider money moved between suspense and the agent it is now attributable to', 'external_customer_revenue'),
  ('provider_clawback',            true, ARRAY['controller','owner'], false, 'An agent''s negative provider share: from its cash, any shortfall advanced against its payable', 'refund'),
  ('provider_payable_repayment',   true, ARRAY['controller','owner'], false, 'An agent repays a provider payable from a later share; the treasury advance is recovered', 'internal_transfer');
INSERT INTO fleet_ledger_rules (kind, class, side) VALUES
  ('provider_revenue_receipt','agent_cash','D'), ('provider_revenue_receipt','agent_fees','D'), ('provider_revenue_receipt','agent_revenue','C'),
  ('provider_receipt_suspense','treasury_cash','D'), ('provider_receipt_suspense','treasury_cash','C'),
  ('provider_receipt_suspense','provider_suspense','C'), ('provider_receipt_suspense','provider_suspense','D'),
  ('provider_suspense_allocation','provider_suspense','D'), ('provider_suspense_allocation','provider_suspense','C'),
  ('provider_suspense_allocation','treasury_cash','C'), ('provider_suspense_allocation','treasury_cash','D'),
  ('provider_suspense_allocation','agent_cash','D'), ('provider_suspense_allocation','agent_cash','C'),
  ('provider_suspense_allocation','agent_revenue','C'), ('provider_suspense_allocation','agent_revenue','D'),
  ('provider_suspense_allocation','agent_provider_payable','C'), ('provider_suspense_allocation','provider_advances','D'),
  ('provider_clawback','agent_revenue','D'), ('provider_clawback','agent_cash','C'), ('provider_clawback','agent_provider_payable','C'),
  ('provider_clawback','provider_advances','D'), ('provider_clawback','treasury_cash','C'),
  ('provider_payable_repayment','agent_provider_payable','D'), ('provider_payable_repayment','agent_cash','C'),
  ('provider_payable_repayment','treasury_cash','D'), ('provider_payable_repayment','provider_advances','C');
${OPEN_AGENT}
SELECT fleet_ledger_open_agent(agent_id, 'migration') FROM fleet_ledger_accounts WHERE class = 'agent_cash' GROUP BY agent_id;
${ECONOMICS}

-- ═══ 2. Claims: Gumroad identifiers contain '=' ═══
ALTER TABLE fleet_revenue_claims DROP CONSTRAINT fleet_revenue_claims_claim_key_check;
ALTER TABLE fleet_revenue_claims ADD CONSTRAINT fleet_revenue_claims_claim_key_check CHECK (claim_key ~ ${CLAIM_RE});

-- ═══ 3. Provider accounts and immutable, historical product attribution ═══
CREATE TABLE fleet_provider_accounts (
  account_id          uuid        PRIMARY KEY,
  rail_id             uuid        NOT NULL UNIQUE REFERENCES fleet_payment_rails(rail_id),
  provider            text        NOT NULL CHECK (provider = 'gumroad'),
  provider_user_id    text        NOT NULL UNIQUE CHECK (provider_user_id ~ ${ID_RE}),
  label               text        NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
  counterparty_sha256 text[]      NOT NULL CHECK (cardinality(counterparty_sha256) BETWEEN 1 AND 16),
  created_by          text        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fleet_provider_accounts_no_change BEFORE UPDATE OR DELETE ON fleet_provider_accounts FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_provider_accounts_no_truncate BEFORE TRUNCATE ON fleet_provider_accounts FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_provider_product_attributions (
  seq            bigserial   PRIMARY KEY,
  account_id     uuid        NOT NULL REFERENCES fleet_provider_accounts(account_id),
  product_id     text        NOT NULL CHECK (product_id ~ ${ID_RE}),
  venture_id     uuid        NOT NULL REFERENCES fleet_ventures(venture_id),
  agent_id       text        NOT NULL REFERENCES fleet_agents(agent_id),
  effective_from timestamptz NOT NULL,
  created_via    text        NOT NULL CHECK (created_via IN ('gateway','owner')),
  reason         text        NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  recorded_by    text        NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_provider_product_attributions_lookup ON fleet_provider_product_attributions (account_id, product_id, effective_from DESC, seq DESC);
CREATE TRIGGER fleet_provider_product_attributions_no_change BEFORE UPDATE OR DELETE ON fleet_provider_product_attributions FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_provider_product_attributions_no_truncate BEFORE TRUNCATE ON fleet_provider_product_attributions FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
CREATE FUNCTION fleet_provider_product_attributions_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleet_ventures WHERE venture_id = NEW.venture_id AND agent_id = NEW.agent_id) THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: the venture does not belong to the agent';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_provider_product_attributions_guard BEFORE INSERT ON fleet_provider_product_attributions FOR EACH ROW EXECUTE FUNCTION fleet_provider_product_attributions_guard();

CREATE FUNCTION fleet_provider_product_owner(p_account uuid, p_product text, p_at timestamptz) RETURNS text LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT agent_id FROM fleet_provider_product_attributions
   WHERE account_id = p_account AND product_id = p_product AND effective_from <= p_at ORDER BY effective_from DESC, seq DESC LIMIT 1
$$;

-- Which provider account (if any) a manual counterparty hash belongs to; whether a reference is a known payout / receipt.
CREATE FUNCTION fleet_provider_counterparty(p_sha256 text) RETURNS uuid LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT account_id FROM fleet_provider_accounts WHERE p_sha256 = ANY (counterparty_sha256) ORDER BY created_at LIMIT 1
$$;
CREATE FUNCTION fleet_provider_payout_key(p_account uuid, p_payout text) RETURNS text LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT 'gumroad:' || provider_user_id || ':payout:' || p_payout FROM fleet_provider_accounts WHERE account_id = p_account
$$;
CREATE FUNCTION fleet_provider_payout_claim_base(p_claim text) RETURNS text LANGUAGE sql IMMUTABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT substring(p_claim FROM '^(gumroad:[A-Za-z0-9=_-]{3,64}:payout:[A-Za-z0-9=_-]{3,64})(:part:[0-9]{1,2})?$')
$$;
CREATE FUNCTION fleet_provider_claim_account(p_claim text) RETURNS uuid LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT a.account_id FROM fleet_provider_accounts a
   WHERE fleet_provider_payout_claim_base(p_claim) IS NOT NULL
     AND a.provider_user_id = split_part(fleet_provider_payout_claim_base(p_claim), ':', 2)
$$;

-- ═══ 4. Provider memo: verified sales and reported payouts (never money) ═══
CREATE TABLE fleet_provider_sales (
  account_id         uuid        NOT NULL REFERENCES fleet_provider_accounts(account_id),
  sale_id            text        NOT NULL CHECK (sale_id ~ ${ID_RE}),
  product_id         text        NOT NULL CHECK (product_id ~ ${ID_RE}),
  sale_at            timestamptz NOT NULL,
  currency           text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  price_minor        bigint      NOT NULL CHECK (price_minor >= 0),
  fee_minor          bigint      NOT NULL CHECK (fee_minor >= 0),
  tax_minor          bigint      NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  listing_currency   text        CHECK (listing_currency ~ '^[A-Z]{3}$'),
  refunded           boolean     NOT NULL DEFAULT false,
  partially_refunded boolean     NOT NULL DEFAULT false,
  chargedback        boolean     NOT NULL DEFAULT false,
  disputed           boolean     NOT NULL DEFAULT false,
  dispute_won        boolean     NOT NULL DEFAULT false,
  payload_sha256     text        NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_read_at       timestamptz NOT NULL DEFAULT now(),
  read_count         integer     NOT NULL DEFAULT 1,
  PRIMARY KEY (account_id, sale_id)
);
CREATE TRIGGER fleet_provider_sales_no_delete BEFORE DELETE ON fleet_provider_sales FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_provider_sales_no_truncate BEFORE TRUNCATE ON fleet_provider_sales FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
CREATE FUNCTION fleet_provider_sales_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.account_id <> OLD.account_id OR NEW.sale_id <> OLD.sale_id OR NEW.product_id <> OLD.product_id OR NEW.sale_at <> OLD.sale_at
     OR NEW.currency <> OLD.currency OR NEW.price_minor <> OLD.price_minor OR NEW.fee_minor <> OLD.fee_minor OR NEW.first_seen_at <> OLD.first_seen_at THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a verified sale''s identity, product, time and amounts are fixed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_provider_sales_guard BEFORE UPDATE ON fleet_provider_sales FOR EACH ROW EXECUTE FUNCTION fleet_provider_sales_guard();
CREATE FUNCTION fleet_provider_sale_owner(p_account uuid, p_sale text) RETURNS text LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT fleet_provider_product_owner(s.account_id, s.product_id, s.sale_at) FROM fleet_provider_sales s WHERE s.account_id = p_account AND s.sale_id = p_sale
$$;

CREATE TABLE fleet_provider_payouts (
  account_id     uuid        NOT NULL REFERENCES fleet_provider_accounts(account_id),
  payout_id      text        NOT NULL CHECK (payout_id ~ ${ID_RE}),
  amount_minor   bigint      NOT NULL CHECK (amount_minor > 0),
  currency       text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status         text        NOT NULL CHECK (status IN ('payable','pending','completed','failed')),
  processed_at   timestamptz,
  bank_visual    text        CHECK (bank_visual ~ '^[A-Za-z0-9 •*._-]{1,40}$'),
  line_count     integer     NOT NULL CHECK (line_count BETWEEN 1 AND 5000),
  lines_sha256   text        NOT NULL CHECK (lines_sha256 ~ '^[0-9a-f]{64}$'),
  payload_sha256 text        NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  reported_at    timestamptz NOT NULL DEFAULT now(),
  last_read_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, payout_id),
  CHECK ((status = 'completed') = (processed_at IS NOT NULL) OR status = 'failed')
);
CREATE TRIGGER fleet_provider_payouts_no_delete BEFORE DELETE ON fleet_provider_payouts FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_provider_payouts_no_truncate BEFORE TRUNCATE ON fleet_provider_payouts FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
CREATE FUNCTION fleet_provider_payouts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.account_id <> OLD.account_id OR NEW.payout_id <> OLD.payout_id OR NEW.amount_minor <> OLD.amount_minor OR NEW.currency <> OLD.currency
     OR NEW.lines_sha256 <> OLD.lines_sha256 OR NEW.line_count <> OLD.line_count OR (OLD.processed_at IS NOT NULL AND NEW.processed_at IS DISTINCT FROM OLD.processed_at)
     OR OLD.status IN ('completed','failed') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a reported payout''s amount, currency, rows and completion are fixed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_provider_payouts_guard BEFORE UPDATE ON fleet_provider_payouts FOR EACH ROW EXECUTE FUNCTION fleet_provider_payouts_guard();

CREATE TABLE fleet_provider_payout_lines (
  account_id       uuid    NOT NULL,
  payout_id        text    NOT NULL,
  line_no          integer NOT NULL CHECK (line_no >= 1),
  row_type         text    NOT NULL CHECK (row_type IN (${q(PAYOUT_ROW_TYPES)})),
  purchase_id      text    CHECK (purchase_id ~ ${ID_RE}),
  sale_price_minor bigint  NOT NULL,
  fee_minor        bigint  NOT NULL,
  tax_minor        bigint  NOT NULL DEFAULT 0,
  net_minor        bigint  NOT NULL,
  PRIMARY KEY (account_id, payout_id, line_no),
  FOREIGN KEY (account_id, payout_id) REFERENCES fleet_provider_payouts(account_id, payout_id)
);
CREATE TRIGGER fleet_provider_payout_lines_no_change BEFORE UPDATE OR DELETE ON fleet_provider_payout_lines FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_provider_payout_lines_no_truncate BEFORE TRUNCATE ON fleet_provider_payout_lines FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- ═══ 5. Destinations, receipts, the pilot fallback ═══
CREATE TABLE fleet_settlement_destinations (
  destination_id      uuid        PRIMARY KEY,
  kind                text        NOT NULL CHECK (kind IN ('fleet_treasury','owner_external')),
  label               text        NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
  masked_ref          text        NOT NULL CHECK (length(masked_ref) BETWEEN 1 AND 60 AND masked_ref !~ '[0-9][0-9 -]{6,}[0-9]'),
  payout_visual       text        CHECK (payout_visual ~ '^[A-Za-z0-9 •*._-]{1,40}$'),
  currency            text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  descriptor_pattern  text        CHECK (length(descriptor_pattern) BETWEEN 1 AND 120),
  legal_entity_id     uuid        REFERENCES fleet_legal_entities(entity_id),
  bankfeed_credential uuid        REFERENCES fleet_credential_refs(credential_id),
  access_status       text        NOT NULL DEFAULT 'unverified' CHECK (access_status IN ('unverified','verified','revoked')),
  access_evidence     jsonb,
  access_verified_at  timestamptz,
  access_verified_by  text,
  created_by          text        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((access_status = 'verified') = (access_verified_at IS NOT NULL)),
  CHECK (kind = 'fleet_treasury' OR access_status <> 'verified')
);
CREATE TRIGGER fleet_settlement_destinations_no_delete BEFORE DELETE ON fleet_settlement_destinations FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_settlement_destinations_no_truncate BEFORE TRUNCATE ON fleet_settlement_destinations FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
CREATE FUNCTION fleet_settlement_destinations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.destination_id <> OLD.destination_id OR NEW.kind <> OLD.kind OR NEW.currency <> OLD.currency OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a destination''s kind and currency are fixed';
  END IF;
  IF OLD.access_status = 'revoked' AND NEW.access_status <> 'revoked' THEN RAISE EXCEPTION 'FLEET_IMMUTABLE: revocation is final'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_settlement_destinations_guard BEFORE UPDATE ON fleet_settlement_destinations FOR EACH ROW EXECUTE FUNCTION fleet_settlement_destinations_guard();

CREATE TABLE fleet_settlement_receipts (
  receipt_id     uuid        PRIMARY KEY,
  destination_id uuid        NOT NULL REFERENCES fleet_settlement_destinations(destination_id),
  bank_txn_id    text        NOT NULL CHECK (bank_txn_id ~ ${TXN_RE}),
  amount_minor   bigint      NOT NULL CHECK (amount_minor <> 0),
  currency       text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  booked_on      date        NOT NULL,
  descriptor     text        CHECK (length(descriptor) <= 140),
  evidence_kind  text        NOT NULL CHECK (evidence_kind IN ('bank_feed','owner_attested')),
  payload_sha256 text        NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  status         text        NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched','ambiguous','matched','held','posted','transferred')),
  status_reason  text        CHECK (length(status_reason) <= 300),
  account_id     uuid,
  payout_id      text,
  transfer_of    uuid        REFERENCES fleet_settlement_receipts(receipt_id),
  manual_claim   text,
  recorded_by    text        NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  posted_at      timestamptz,
  UNIQUE (destination_id, bank_txn_id),
  FOREIGN KEY (account_id, payout_id) REFERENCES fleet_provider_payouts(account_id, payout_id),
  CHECK ((status IN ('posted','transferred')) = (posted_at IS NOT NULL))
);
CREATE UNIQUE INDEX fleet_settlement_receipts_one_per_payout ON fleet_settlement_receipts (account_id, payout_id)
  WHERE payout_id IS NOT NULL AND status IN ('matched','held','posted') AND transfer_of IS NULL;
CREATE TRIGGER fleet_settlement_receipts_no_delete BEFORE DELETE ON fleet_settlement_receipts FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_settlement_receipts_no_truncate BEFORE TRUNCATE ON fleet_settlement_receipts FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
CREATE FUNCTION fleet_settlement_receipts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.receipt_id <> OLD.receipt_id OR NEW.destination_id <> OLD.destination_id OR NEW.bank_txn_id <> OLD.bank_txn_id OR NEW.amount_minor <> OLD.amount_minor
     OR NEW.currency <> OLD.currency OR NEW.booked_on <> OLD.booked_on OR NEW.evidence_kind <> OLD.evidence_kind OR NEW.payload_sha256 <> OLD.payload_sha256 THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a receipt''s bank evidence is fixed';
  END IF;
  IF OLD.status IN ('posted','transferred') THEN RAISE EXCEPTION 'FLEET_IMMUTABLE: a posted receipt is final'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_settlement_receipts_guard BEFORE UPDATE ON fleet_settlement_receipts FOR EACH ROW EXECUTE FUNCTION fleet_settlement_receipts_guard();

CREATE TABLE fleet_provider_allocations (
  seq              bigserial   PRIMARY KEY,
  receipt_id       uuid        NOT NULL REFERENCES fleet_settlement_receipts(receipt_id),
  round            integer     NOT NULL CHECK (round >= 1),
  agent_id         text        REFERENCES fleet_agents(agent_id),
  basis            text        NOT NULL CHECK (basis IN ('usd_exact','pro_rata_usd_net','quarantined','owner_assignment','manual_claim')),
  net_usd_minor    bigint      NOT NULL DEFAULT 0,
  fee_usd_minor    bigint      NOT NULL DEFAULT 0,
  share_minor      bigint      NOT NULL,
  fee_share_minor  bigint      NOT NULL DEFAULT 0,
  payable_repaid   bigint      NOT NULL DEFAULT 0,
  clawback_cash    bigint      NOT NULL DEFAULT 0,
  clawback_payable bigint      NOT NULL DEFAULT 0,
  journal_id       uuid        REFERENCES fleet_ledger_journal(journal_id),
  note             text        CHECK (length(note) <= 300),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_provider_allocations_receipt ON fleet_provider_allocations (receipt_id, round);
CREATE TRIGGER fleet_provider_allocations_no_change BEFORE UPDATE OR DELETE ON fleet_provider_allocations FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_provider_allocations_no_truncate BEFORE TRUNCATE ON fleet_provider_allocations FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_pilot_authorisations (
  pilot_id   uuid        PRIMARY KEY,
  kind       text        NOT NULL CHECK (kind = 'receipt_attestation'),
  reason     text        NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  granted_by text        NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > granted_at AND expires_at <= granted_at + interval '${PILOT_MAX_DAYS} days')
);
CREATE TRIGGER fleet_pilot_authorisations_no_delete BEFORE DELETE ON fleet_pilot_authorisations FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE FUNCTION fleet_pilot_active(p_kind text) RETURNS boolean LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM fleet_pilot_authorisations WHERE kind = p_kind AND revoked_at IS NULL AND expires_at > now())
$$;
CREATE FUNCTION fleet_bankfeed_active() RETURNS boolean LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM fleet_settlement_destinations d JOIN fleet_credential_refs c ON c.credential_id = d.bankfeed_credential
                  WHERE d.kind = 'fleet_treasury' AND d.access_status = 'verified' AND c.status IN ('active','rotating'))
$$;

CREATE FUNCTION fleet_provider_reference_known(p_ref text) RETURNS boolean LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT p_ref IS NOT NULL AND (EXISTS (SELECT 1 FROM fleet_provider_payouts WHERE payout_id = p_ref)
                                OR EXISTS (SELECT 1 FROM fleet_settlement_receipts WHERE bank_txn_id = p_ref))
$$;

-- Founder-visible memo: provider revenue not yet received (USD minor units; never spendable).
CREATE FUNCTION fleet_agent_provider_memo(p_agent text) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('currency', 'USD', 'spendable', false,
    'verifiedSalesNotPaidOutMinor', COALESCE(sum(s.price_minor - s.fee_minor) FILTER (WHERE NOT s.refunded AND NOT s.chargedback AND NOT EXISTS (
        SELECT 1 FROM fleet_provider_payout_lines l WHERE l.account_id = s.account_id AND l.purchase_id = s.sale_id)), 0),
    'inReportedPayoutsNotReceivedMinor', COALESCE(sum(s.price_minor - s.fee_minor) FILTER (WHERE EXISTS (
        SELECT 1 FROM fleet_provider_payout_lines l JOIN fleet_provider_payouts p ON p.account_id = l.account_id AND p.payout_id = l.payout_id
         WHERE l.account_id = s.account_id AND l.purchase_id = s.sale_id AND l.row_type = 'sale'
           AND NOT EXISTS (SELECT 1 FROM fleet_settlement_receipts r WHERE r.account_id = p.account_id AND r.payout_id = p.payout_id AND r.status = 'posted'))), 0),
    'note', 'Provider revenue becomes spendable only when its payout is received into the fleet treasury.')
    FROM fleet_provider_sales s WHERE fleet_provider_product_owner(s.account_id, s.product_id, s.sale_at) = p_agent
$$;
${WALLET}

-- ═══ 6. Owner registration ═══
CREATE FUNCTION fleet_admin_provider_account_register(p_rail uuid, p_user_id text, p_label text, p_extra_counterparty_sha256 text[], p_actor text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_payment_rails; v_id uuid := gen_random_uuid(); v_hashes text[];
BEGIN
  ${OWNER_ACTOR}
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');
  SELECT * INTO r FROM fleet_payment_rails WHERE rail_id = p_rail;
  IF NOT FOUND OR r.mode <> 'live_receive' OR r.provider <> 'gumroad' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a provider account belongs to a receive-only gumroad rail'; END IF;
  IF p_extra_counterparty_sha256 IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(p_extra_counterparty_sha256) h WHERE h !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: counterparty identifiers are sha256 hex';
  END IF;
  -- The account's own identifiers are always counterparties (manual revenue naming them must claim a payout).
  v_hashes := ARRAY(SELECT DISTINCT x FROM unnest(ARRAY[encode(sha256(convert_to(lower(p_user_id), 'UTF8')), 'hex'),
                                                         encode(sha256(convert_to('gumroad', 'UTF8')), 'hex'),
                                                         encode(sha256(convert_to('gumroad:' || lower(p_user_id), 'UTF8')), 'hex')]
                                                   || COALESCE(p_extra_counterparty_sha256, '{}')) x);
  INSERT INTO fleet_provider_accounts (account_id, rail_id, provider, provider_user_id, label, counterparty_sha256, created_by)
    VALUES (v_id, p_rail, 'gumroad', p_user_id, fleet_scrub(p_label), v_hashes, p_actor);
  PERFORM fleet_event('provider_account_registered', NULL, p_actor, jsonb_build_object('accountId', v_id, 'railId', p_rail));
  RETURN jsonb_build_object('accountId', v_id, 'railId', p_rail, 'providerUserId', p_user_id, 'counterparties', cardinality(v_hashes));
END $$;

-- A product's FIRST owner may be backdated (it covers every sale of the product); a later owner takes effect from now.
CREATE FUNCTION fleet_admin_provider_product_assign(p_account uuid, p_product text, p_venture uuid, p_effective_from timestamptz, p_reason text, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_agent text; v_prior boolean; v_from timestamptz;
BEGIN
  ${OWNER_ACTOR}
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');
  SELECT agent_id INTO v_agent FROM fleet_ventures WHERE venture_id = p_venture;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such venture'; END IF;
  IF NOT EXISTS (SELECT 1 FROM fleet_provider_accounts WHERE account_id = p_account) THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such provider account'; END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a reason is required'; END IF;
  PERFORM 1 FROM fleet_provider_product_attributions WHERE account_id = p_account AND product_id = p_product FOR UPDATE;
  v_prior := FOUND;
  IF v_prior AND p_effective_from IS NOT NULL AND p_effective_from < now() - interval '1 minute' THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a reassignment takes effect from now; past sales keep the owner they were earned by';
  END IF;
  IF v_prior AND fleet_provider_product_owner(p_account, p_product, now()) = v_agent
     AND (SELECT venture_id FROM fleet_provider_product_attributions WHERE account_id = p_account AND product_id = p_product ORDER BY effective_from DESC, seq DESC LIMIT 1) = p_venture THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: the product already belongs to this venture';
  END IF;
  v_from := CASE WHEN v_prior THEN now() ELSE COALESCE(p_effective_from, '1970-01-01'::timestamptz) END;
  INSERT INTO fleet_provider_product_attributions (account_id, product_id, venture_id, agent_id, effective_from, created_via, reason, recorded_by)
    VALUES (p_account, p_product, p_venture, v_agent, v_from, 'owner', left(fleet_scrub(p_reason), 200), p_actor);
  PERFORM fleet_event('provider_product_assigned', v_agent, p_actor, jsonb_build_object('accountId', p_account, 'productId', p_product,
    'ventureId', p_venture, 'effectiveFrom', v_from, 'reassignment', v_prior));
  RETURN jsonb_build_object('accountId', p_account, 'productId', p_product, 'ventureId', p_venture, 'agentId', v_agent, 'effectiveFrom', v_from, 'reassignment', v_prior);
END $$;

CREATE FUNCTION fleet_admin_settlement_destination_add(p_kind text, p_label text, p_masked_ref text, p_payout_visual text, p_currency text,
  p_descriptor_pattern text, p_entity uuid, p_bankfeed_credential uuid, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE d fleet_settlement_destinations;
BEGIN
  ${OWNER_ACTOR}
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');
  IF p_descriptor_pattern IS NOT NULL THEN PERFORM regexp_match('', p_descriptor_pattern); END IF;  -- a malformed pattern fails here
  INSERT INTO fleet_settlement_destinations (destination_id, kind, label, masked_ref, payout_visual, currency, descriptor_pattern, legal_entity_id, bankfeed_credential, created_by)
    VALUES (gen_random_uuid(), p_kind, fleet_scrub(p_label), p_masked_ref, p_payout_visual, p_currency, p_descriptor_pattern, p_entity, p_bankfeed_credential, p_actor)
    RETURNING * INTO d;
  PERFORM fleet_event('destination_added', NULL, p_actor, jsonb_build_object('destinationId', d.destination_id, 'kind', d.kind, 'currency', d.currency));
  RETURN to_jsonb(d) - 'access_evidence';
END $$;

-- Registering a treasury destination proves nothing: the fleet's ACCESS to it (its authorised funding / spending
-- mechanisms can use that account) is evidenced separately, and only then can a receipt there become agent capital.
CREATE FUNCTION fleet_admin_settlement_destination_verify_access(p_destination uuid, p_evidence_kind text, p_evidence jsonb, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE d fleet_settlement_destinations;
BEGIN
  ${OWNER_ACTOR}
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');
  IF p_evidence_kind NOT IN ('owner_attested','automatic') OR p_evidence IS NULL OR jsonb_typeof(p_evidence) <> 'object' OR p_evidence = '{}'::jsonb THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: access evidence (owner_attested or automatic) with a description is required';
  END IF;
  UPDATE fleet_settlement_destinations SET access_status = 'verified', access_verified_at = now(), access_verified_by = p_actor,
         access_evidence = jsonb_build_object('kind', p_evidence_kind, 'evidence', p_evidence)
   WHERE destination_id = p_destination AND kind = 'fleet_treasury' AND access_status = 'unverified' RETURNING * INTO d;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: only an unverified fleet-treasury destination can have its access verified'; END IF;
  PERFORM fleet_event('destination_access_verified', NULL, p_actor, jsonb_build_object('destinationId', p_destination, 'evidenceKind', p_evidence_kind));
  RETURN to_jsonb(d) - 'access_evidence';
END $$;

CREATE FUNCTION fleet_admin_pilot_authorise(p_kind text, p_days integer, p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  ${OWNER_ACTOR}
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');
  IF fleet_bankfeed_active() THEN RAISE EXCEPTION 'FLEET_PILOT_RETIRED: a bank-feed connector verifies receipts; the attestation fallback is retired'; END IF;
  IF p_days IS NULL OR p_days NOT BETWEEN 1 AND ${PILOT_MAX_DAYS} THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: 1..${PILOT_MAX_DAYS} days'; END IF;
  INSERT INTO fleet_pilot_authorisations (pilot_id, kind, reason, granted_by, expires_at) VALUES (v_id, p_kind, fleet_scrub(p_reason), p_actor, now() + make_interval(days => p_days));
  PERFORM fleet_event('pilot_authorised', NULL, p_actor, jsonb_build_object('pilotId', v_id, 'kind', p_kind, 'days', p_days));
  RETURN jsonb_build_object('pilotId', v_id, 'kind', p_kind, 'expiresAt', now() + make_interval(days => p_days));
END $$;
CREATE FUNCTION fleet_admin_pilot_revoke(p_pilot uuid, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  ${OWNER_ACTOR}
  UPDATE fleet_pilot_authorisations SET revoked_at = now() WHERE pilot_id = p_pilot AND revoked_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no active pilot authorisation'; END IF;
  PERFORM fleet_event('pilot_revoked', NULL, p_actor, jsonb_build_object('pilotId', p_pilot));
  RETURN jsonb_build_object('pilotId', p_pilot, 'revoked', true);
END $$;

-- ═══ 7. Recorders (the G3 gateway / G4 bank feed reach these through their own roles) ═══
CREATE FUNCTION fleet_provider_sale_record(p_account uuid, p_sale text, p_product text, p_sale_at timestamptz, p_currency text, p_price bigint, p_fee bigint,
  p_tax bigint, p_listing_currency text, p_flags jsonb, p_payload_sha256 text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE s fleet_provider_sales; f jsonb := COALESCE(p_flags, '{}'::jsonb);
BEGIN
  SELECT * INTO s FROM fleet_provider_sales WHERE account_id = p_account AND sale_id = p_sale FOR UPDATE;
  IF FOUND THEN
    IF s.product_id <> p_product OR s.sale_at <> p_sale_at OR s.currency <> p_currency OR s.price_minor <> p_price OR s.fee_minor <> p_fee THEN
      PERFORM fleet_event('provider_conflict', NULL, p_actor, jsonb_build_object('accountId', p_account, 'saleId', p_sale, 'what', 'sale'));
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PROVIDER_CONFLICT');
    END IF;
    -- Refund / dispute states only ever progress (a later read is the newer truth).
    UPDATE fleet_provider_sales SET refunded = refunded OR COALESCE((f ->> 'refunded')::boolean, false),
           partially_refunded = partially_refunded OR COALESCE((f ->> 'partiallyRefunded')::boolean, false),
           chargedback = chargedback OR COALESCE((f ->> 'chargedback')::boolean, false),
           disputed = disputed OR COALESCE((f ->> 'disputed')::boolean, false),
           dispute_won = dispute_won OR COALESCE((f ->> 'disputeWon')::boolean, false),
           tax_minor = GREATEST(tax_minor, COALESCE(p_tax, 0)), payload_sha256 = p_payload_sha256, last_read_at = now(), read_count = read_count + 1
     WHERE account_id = p_account AND sale_id = p_sale;
    RETURN jsonb_build_object('ok', true, 'replay', true);
  END IF;
  INSERT INTO fleet_provider_sales (account_id, sale_id, product_id, sale_at, currency, price_minor, fee_minor, tax_minor, listing_currency,
      refunded, partially_refunded, chargedback, disputed, dispute_won, payload_sha256)
    VALUES (p_account, p_sale, p_product, p_sale_at, p_currency, p_price, p_fee, COALESCE(p_tax, 0), p_listing_currency,
      COALESCE((f ->> 'refunded')::boolean, false), COALESCE((f ->> 'partiallyRefunded')::boolean, false), COALESCE((f ->> 'chargedback')::boolean, false),
      COALESCE((f ->> 'disputed')::boolean, false), COALESCE((f ->> 'disputeWon')::boolean, false), p_payload_sha256);
  RETURN jsonb_build_object('ok', true, 'replay', false, 'attributedTo', fleet_provider_product_owner(p_account, p_product, p_sale_at));
END $$;

-- A payout and ALL its rows, once: the rows are fixed (their sha256); only the status / completion may progress.
CREATE FUNCTION fleet_provider_payout_record(p_account uuid, p_payout text, p_amount bigint, p_currency text, p_status text, p_processed_at timestamptz,
  p_bank_visual text, p_lines jsonb, p_payload_sha256 text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_provider_payouts; v_sha text; l jsonb; i integer := 0;
BEGIN
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a payout needs its rows'; END IF;
  v_sha := encode(sha256(convert_to(p_lines::text, 'UTF8')), 'hex');
  SELECT * INTO p FROM fleet_provider_payouts WHERE account_id = p_account AND payout_id = p_payout FOR UPDATE;
  IF FOUND THEN
    IF p.amount_minor <> p_amount OR p.currency <> p_currency OR p.lines_sha256 <> v_sha THEN
      PERFORM fleet_event('provider_conflict', NULL, p_actor, jsonb_build_object('accountId', p_account, 'payoutId', p_payout, 'what', 'payout'));
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PROVIDER_CONFLICT');
    END IF;
    IF p.status NOT IN ('completed','failed') AND p_status <> p.status THEN
      UPDATE fleet_provider_payouts SET status = p_status, processed_at = CASE WHEN p_status = 'completed' THEN p_processed_at ELSE processed_at END,
             last_read_at = now() WHERE account_id = p_account AND payout_id = p_payout;
    ELSE
      UPDATE fleet_provider_payouts SET last_read_at = now() WHERE account_id = p_account AND payout_id = p_payout;
    END IF;
    RETURN jsonb_build_object('ok', true, 'replay', true);
  END IF;
  INSERT INTO fleet_provider_payouts (account_id, payout_id, amount_minor, currency, status, processed_at, bank_visual, line_count, lines_sha256, payload_sha256)
    VALUES (p_account, p_payout, p_amount, p_currency, p_status, CASE WHEN p_status = 'completed' THEN p_processed_at END, p_bank_visual,
            jsonb_array_length(p_lines), v_sha, p_payload_sha256);
  FOR l IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    i := i + 1;
    INSERT INTO fleet_provider_payout_lines (account_id, payout_id, line_no, row_type, purchase_id, sale_price_minor, fee_minor, tax_minor, net_minor)
      VALUES (p_account, p_payout, i, l ->> 'rowType', NULLIF(l ->> 'purchaseId', ''), (l ->> 'salePriceMinor')::bigint, (l ->> 'feeMinor')::bigint,
              COALESCE((l ->> 'taxMinor')::bigint, 0), (l ->> 'netMinor')::bigint);
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'replay', false, 'lines', i);
END $$;

CREATE FUNCTION fleet_add_business_days(p_from date, p_days integer) RETURNS date LANGUAGE sql IMMUTABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT d::date FROM generate_series(p_from + 1, p_from + p_days * 2 + 7, interval '1 day') d
   WHERE extract(isodow FROM d) < 6 ORDER BY d OFFSET p_days - 1 LIMIT 1
$$;

-- ═══ 8. Allocation (pure: computes; posts nothing) ═══
CREATE FUNCTION fleet_provider_payout_allocation(p_account uuid, p_payout text, p_received bigint, p_currency text) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_provider_payouts; n_total bigint; n_susp bigint; pf bigint; pos_total bigint; fx fleet_fx_rates; v_basis text; v_reason text;
        b jsonb := '[]'::jsonb; r record; v_rem bigint; v_pf_rem bigint; k integer; v_fee bigint;
        agents text[] := '{}'; nets bigint[] := '{}'; fees bigint[] := '{}'; shares bigint[]; fracs numeric[]; pfs bigint[]; i integer; order_idx integer[];
BEGIN
  SELECT * INTO p FROM fleet_provider_payouts WHERE account_id = p_account AND payout_id = p_payout;
  IF NOT FOUND THEN RETURN jsonb_build_object('quarantined', true, 'reason', 'the payout is not recorded'); END IF;
  IF p.currency <> p_currency OR p.amount_minor <> p_received THEN
    RETURN jsonb_build_object('quarantined', true, 'reason', 'the receipt does not equal the reported payout');
  END IF;
  -- Per-row attribution: the sale's product owner at the sale time. Rows without a resolvable owner go to suspense.
  FOR r IN
    SELECT o.agent_id, sum(l.net_minor) AS net, sum(l.fee_minor) AS fee
      FROM fleet_provider_payout_lines l
      JOIN fleet_provider_sales s ON s.account_id = l.account_id AND s.sale_id = l.purchase_id
      CROSS JOIN LATERAL (SELECT fleet_provider_product_owner(s.account_id, s.product_id, s.sale_at) AS agent_id) o
     WHERE l.account_id = p_account AND l.payout_id = p_payout AND l.purchase_id IS NOT NULL AND l.row_type NOT IN ('summary','technical_adjustment')
       AND o.agent_id IS NOT NULL
     GROUP BY o.agent_id ORDER BY o.agent_id
  LOOP
    agents := agents || r.agent_id; nets := nets || r.net; fees := fees || r.fee;
  END LOOP;
  SELECT COALESCE(sum(net_minor), 0) INTO n_total FROM fleet_provider_payout_lines WHERE account_id = p_account AND payout_id = p_payout;
  SELECT COALESCE(sum(net_minor), 0) INTO pf FROM fleet_provider_payout_lines WHERE account_id = p_account AND payout_id = p_payout AND row_type = 'payout_fee' AND purchase_id IS NULL;
  -- The payout fee is shared by the agents with a positive net, pro rata (exact in USD, largest remainder).
  pfs := array_fill(0::bigint, ARRAY[GREATEST(cardinality(agents), 1)]);
  SELECT COALESCE(sum(x), 0) INTO pos_total FROM unnest(nets) x WHERE x > 0;
  IF pf <> 0 AND pos_total > 0 THEN
    -- floor toward -infinity, then hand the remaining cents (all of one sign) one each, to the agents in id order.
    FOR i IN 1 .. cardinality(agents) LOOP pfs[i] := CASE WHEN nets[i] > 0 THEN floor(pf::numeric * nets[i] / pos_total)::bigint ELSE 0 END; END LOOP;
    v_pf_rem := pf - (SELECT COALESCE(sum(x), 0) FROM unnest(pfs) x);
    i := 1;
    WHILE v_pf_rem <> 0 LOOP
      IF nets[i] > 0 THEN pfs[i] := pfs[i] + sign(v_pf_rem)::bigint; v_pf_rem := v_pf_rem - sign(v_pf_rem)::bigint; END IF;
      i := CASE WHEN i >= cardinality(agents) THEN 1 ELSE i + 1 END;
    END LOOP;
    FOR i IN 1 .. cardinality(agents) LOOP nets[i] := nets[i] + pfs[i]; END LOOP;
    pf := 0;
  END IF;
  n_susp := n_total - (SELECT COALESCE(sum(x), 0) FROM unnest(nets) x);
  -- Whole-payout quarantine when the rows do not reconcile.
  IF p.currency = 'USD' THEN
    IF n_total <> p_received THEN v_reason := format('the payout rows sum to %s, not the payout amount %s', n_total, p_received); END IF;
    v_basis := 'usd_exact';
  ELSE
    fx := fleet_fx_latest('USD', p.currency);
    IF n_total <= 0 THEN v_reason := 'the payout rows do not sum to a positive USD net';
    ELSIF fx.rate_id IS NULL THEN v_reason := format('no recent USD/%s rate to sanity-check the payout', p.currency);
    ELSIF abs(p_received::numeric * 1000000 / n_total - fx.rate_micro) * 10000 > fx.rate_micro * ${PAYOUT_FX_TOLERANCE_BP} THEN
      v_reason := format('the implied rate %s is outside %s bp of the recorded USD/%s rate %s',
        round(p_received::numeric / n_total, 6), ${PAYOUT_FX_TOLERANCE_BP}, p.currency, round(fx.rate_micro::numeric / 1000000, 6));
    END IF;
    v_basis := 'pro_rata_usd_net';
  END IF;
  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object('quarantined', true, 'reason', v_reason, 'basis', 'quarantined', 'received', p_received, 'usdNet', n_total,
      'buckets', '[]'::jsonb, 'suspense', p_received);
  END IF;
  -- Shares: USD exactly by row; otherwise the received amount pro rata to USD net, largest remainder (suspense included).
  IF v_basis = 'usd_exact' THEN
    shares := nets;
  ELSE
    shares := '{}'; fracs := '{}';
    FOR i IN 1 .. cardinality(agents) + 1 LOOP
      shares := shares || floor(p_received::numeric * (CASE WHEN i <= cardinality(agents) THEN nets[i] ELSE n_susp END) / n_total)::bigint;
      fracs := fracs || (p_received::numeric * (CASE WHEN i <= cardinality(agents) THEN nets[i] ELSE n_susp END) / n_total - shares[i]);
    END LOOP;
    v_rem := p_received - (SELECT sum(x) FROM unnest(shares) x);
    order_idx := ARRAY(SELECT j FROM generate_subscripts(fracs, 1) j ORDER BY fracs[j] DESC, j);
    k := 1;
    WHILE v_rem > 0 LOOP shares[order_idx[k]] := shares[order_idx[k]] + 1; v_rem := v_rem - 1; k := k + 1; END LOOP;
    n_susp := shares[cardinality(agents) + 1];
  END IF;
  FOR i IN 1 .. cardinality(agents) LOOP
    v_fee := CASE WHEN v_basis = 'usd_exact' THEN fees[i] ELSE round(p_received::numeric * fees[i] / n_total)::bigint END;
    IF shares[i] <= 0 OR v_fee < 0 THEN v_fee := 0; END IF;
    b := b || jsonb_build_array(jsonb_build_object('agentId', agents[i], 'netUsd', nets[i], 'feeUsd', fees[i], 'share', shares[i], 'feeShare', v_fee));
  END LOOP;
  RETURN jsonb_build_object('quarantined', false, 'basis', v_basis, 'received', p_received, 'usdNet', n_total, 'buckets', b,
    'suspense', CASE WHEN v_basis = 'usd_exact' THEN n_susp ELSE n_susp END,
    'policy', CASE WHEN v_basis = 'usd_exact' THEN 'exact by provider row' ELSE
      'allocation policy: the received amount split pro rata to each agent''s USD net (largest remainder); not a provider exchange rate for any sale' END);
END $$;

-- ═══ 9. Posting (S5): one transaction, both claims, exact conservation ═══
CREATE FUNCTION fleet_provider_journal_ref(p_key text, p_suffix text) RETURNS text LANGUAGE sql IMMUTABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT 'prov:' || encode(sha256(convert_to(p_key, 'UTF8')), 'hex') || ':' || p_suffix
$$;

-- An agent's signed share of one receipt round, posted: a positive share credits cash (repaying any payable first); a
-- negative share comes from its cash, any shortfall advanced by the treasury against its payable. p_from_suspense: the
-- share moves between suspense and the agent (a release) instead of arriving with the receipt.
CREATE FUNCTION fleet_provider_post_share(p_receipt uuid, p_round integer, p_agent text, p_share bigint, p_fee_share bigint, p_key text, p_from_suspense boolean,
  p_basis text, p_net_usd bigint, p_fee_usd bigint, p_note text, p_actor text) RETURNS uuid LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_j uuid; v_first uuid; v_cash bigint; v_pay bigint; c bigint := 0; rem bigint := 0; rep bigint := 0; amt bigint; v_lines jsonb; v_sfx text;
BEGIN
  PERFORM fleet_ledger_open_agent(p_agent, p_actor);
  v_sfx := 'r' || p_round || ':' || p_agent;
  IF p_share > 0 THEN
    IF p_from_suspense THEN
      v_lines := jsonb_build_array(jsonb_build_object('account', 'fleet:provider:suspense', 'side', 'D', 'amount', p_share),
        jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', p_share),
        jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_cash'), 'side', 'D', 'amount', p_share),
        jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_revenue'), 'side', 'C', 'amount', p_share));
      v_j := fleet_ledger_post('provider_suspense_allocation', fleet_provider_journal_ref(p_key, 'sa:' || v_sfx), p_actor, 'provider money released from suspense to its agent',
        'controller', p_agent, NULL, NULL, fleet_provider_journal_ref(p_key, 'sa:' || v_sfx), NULL, now(), v_lines);
    ELSE
      v_lines := jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_cash'), 'side', 'D', 'amount', p_share),
        jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_revenue'), 'side', 'C', 'amount', p_share + p_fee_share));
      IF p_fee_share > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_fees'), 'side', 'D', 'amount', p_fee_share)); END IF;
      v_j := fleet_ledger_post('provider_revenue_receipt', fleet_provider_journal_ref(p_key, 'rv:' || v_sfx), p_actor, 'provider payout received into the fleet treasury',
        'controller', p_agent, NULL, NULL, fleet_provider_journal_ref(p_key, 'rv:' || v_sfx), NULL, now(), v_lines);
    END IF;
    v_first := v_j;
    v_pay := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_provider_payable'));
    rep := LEAST(v_pay, p_share);
    IF rep > 0 THEN
      PERFORM fleet_ledger_post('provider_payable_repayment', fleet_provider_journal_ref(p_key, 'rp:' || v_sfx), p_actor, 'provider payable repaid from a later share',
        'controller', p_agent, NULL, NULL, fleet_provider_journal_ref(p_key, 'rp:' || v_sfx), NULL, now(), jsonb_build_array(
          jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_provider_payable'), 'side', 'D', 'amount', rep),
          jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_cash'), 'side', 'C', 'amount', rep),
          jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', rep),
          jsonb_build_object('account', 'fleet:provider:advances', 'side', 'C', 'amount', rep)));
    END IF;
  ELSIF p_share < 0 THEN
    amt := -p_share;
    v_cash := fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_cash'));
    c := LEAST(GREATEST(v_cash, 0), amt);
    rem := amt - c;
    v_lines := jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_revenue'), 'side', 'D', 'amount', amt));
    IF c > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_cash'), 'side', 'C', 'amount', c)); END IF;
    IF rem > 0 THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_provider_payable'), 'side', 'C', 'amount', rem),
                                              jsonb_build_object('account', 'fleet:provider:advances', 'side', 'D', 'amount', rem));
    END IF;
    IF p_from_suspense THEN
      -- The amount moves from the agent INTO suspense: its cash part reaches the treasury, its shortfall is advanced.
      IF c > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', c)); END IF;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'fleet:provider:suspense', 'side', 'C', 'amount', amt));
      v_j := fleet_ledger_post('provider_suspense_allocation', fleet_provider_journal_ref(p_key, 'sn:' || v_sfx), p_actor, 'a negative provider amount reattributed to its agent',
        'controller', p_agent, NULL, NULL, fleet_provider_journal_ref(p_key, 'sn:' || v_sfx), NULL, now(), v_lines);
    ELSE
      IF rem > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', rem)); END IF;
      v_j := fleet_ledger_post('provider_clawback', fleet_provider_journal_ref(p_key, 'cb:' || v_sfx), p_actor, 'negative provider share (refund / chargeback / fee)',
        'controller', p_agent, NULL, NULL, fleet_provider_journal_ref(p_key, 'cb:' || v_sfx), NULL, now(), v_lines);
    END IF;
    v_first := v_j;
  END IF;
  INSERT INTO fleet_provider_allocations (receipt_id, round, agent_id, basis, net_usd_minor, fee_usd_minor, share_minor, fee_share_minor, payable_repaid,
      clawback_cash, clawback_payable, journal_id, note)
    VALUES (p_receipt, p_round, p_agent, p_basis, COALESCE(p_net_usd, 0), COALESCE(p_fee_usd, 0), p_share, CASE WHEN p_share > 0 AND NOT p_from_suspense THEN p_fee_share ELSE 0 END,
      rep, c, rem, v_first, left(p_note, 300));
  RETURN v_first;
END $$;

CREATE FUNCTION fleet_provider_post_suspense(p_receipt uuid, p_round integer, p_amount bigint, p_key text, p_basis text, p_note text, p_actor text) RETURNS uuid LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_j uuid;
BEGIN
  IF p_amount <> 0 THEN
    v_j := fleet_ledger_post('provider_receipt_suspense', fleet_provider_journal_ref(p_key, 'su:r' || p_round), p_actor, 'provider receipt held in suspense (not attributable)',
      'controller', NULL, NULL, NULL, fleet_provider_journal_ref(p_key, 'su:r' || p_round), NULL, now(), CASE WHEN p_amount > 0 THEN jsonb_build_array(
        jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', p_amount),
        jsonb_build_object('account', 'fleet:provider:suspense', 'side', 'C', 'amount', p_amount)) ELSE jsonb_build_array(
        jsonb_build_object('account', 'fleet:provider:suspense', 'side', 'D', 'amount', -p_amount),
        jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', -p_amount)) END);
  END IF;
  INSERT INTO fleet_provider_allocations (receipt_id, round, agent_id, basis, share_minor, journal_id, note)
    VALUES (p_receipt, p_round, NULL, p_basis, p_amount, v_j, left(p_note, 300));
  RETURN v_j;
END $$;

-- Post a matched receipt into a verified fleet-treasury destination. Claims the payout and the bank transaction in the
-- same transaction: a concurrent or repeated attempt fails on the claim and rolls back everything it did.
CREATE FUNCTION fleet_provider_receipt_post(p_receipt uuid, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_settlement_receipts; d fleet_settlement_destinations; v_pkey text; v_bkey text; v_manual text; a jsonb; x jsonb; v_j uuid; v_first uuid; v_alloc bigint := 0;
BEGIN
  SELECT * INTO r FROM fleet_settlement_receipts WHERE receipt_id = p_receipt FOR UPDATE;
  SELECT * INTO d FROM fleet_settlement_destinations WHERE destination_id = r.destination_id;
  IF r.status NOT IN ('matched','held') OR r.payout_id IS NULL THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: receipt is %', r.status; END IF;
  IF d.kind <> 'fleet_treasury' OR d.access_status <> 'verified' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: not a verified fleet-treasury destination'; END IF;
  v_pkey := fleet_provider_payout_key(r.account_id, r.payout_id);
  v_bkey := 'bank:' || r.destination_id || ':txn:' || r.bank_txn_id;
  -- Recorded manually already (owner claimed the payout): nothing more is credited.
  SELECT claim_key INTO v_manual FROM fleet_revenue_claims WHERE claim_kind = 'manual_revenue' AND (claim_key = v_pkey OR claim_key LIKE v_pkey || ':part:%') ORDER BY claim_key LIMIT 1;
  IF v_manual IS NOT NULL THEN
    BEGIN
      INSERT INTO fleet_revenue_claims (claim_key, claim_kind, journal_id, claimed_by)
        VALUES (v_bkey, CASE WHEN r.evidence_kind = 'owner_attested' THEN 'owner_attestation' ELSE 'bank_receipt' END,
                (SELECT journal_id FROM fleet_revenue_claims WHERE claim_key = v_manual), p_actor);
    EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'FLEET_ALREADY_CLAIMED: bank transaction % is already recorded', v_bkey; END;
    INSERT INTO fleet_provider_allocations (receipt_id, round, agent_id, basis, share_minor, note)
      VALUES (p_receipt, 1, NULL, 'manual_claim', 0, 'recorded manually under claim ' || v_manual);
    UPDATE fleet_settlement_receipts SET status = 'posted', posted_at = now(), manual_claim = v_manual, status_reason = 'recorded manually (claim ' || v_manual || ')'
     WHERE receipt_id = p_receipt;
    PERFORM fleet_event('receipt_posted', NULL, p_actor, jsonb_build_object('receiptId', p_receipt, 'manualClaim', v_manual));
    RETURN jsonb_build_object('ok', true, 'manualClaim', v_manual, 'credited', 0);
  END IF;
  a := fleet_provider_payout_allocation(r.account_id, r.payout_id, r.amount_minor, r.currency);
  FOR x IN SELECT * FROM jsonb_array_elements(a -> 'buckets') LOOP
    v_j := fleet_provider_post_share(p_receipt, 1, x ->> 'agentId', (x ->> 'share')::bigint, (x ->> 'feeShare')::bigint, v_pkey, false,
      a ->> 'basis', (x ->> 'netUsd')::bigint, (x ->> 'feeUsd')::bigint,
      CASE WHEN r.evidence_kind = 'owner_attested' THEN 'owner-attested receipt, not independently verified; ' ELSE '' END || COALESCE(a ->> 'policy', ''), p_actor);
    v_first := COALESCE(v_first, v_j);
    v_alloc := v_alloc + (x ->> 'share')::bigint;
  END LOOP;
  v_j := fleet_provider_post_suspense(p_receipt, 1, r.amount_minor - v_alloc, v_pkey, CASE WHEN (a ->> 'quarantined')::boolean THEN 'quarantined' ELSE a ->> 'basis' END,
    COALESCE(a ->> 'reason', 'unattributable rows'), p_actor);
  v_first := COALESCE(v_first, v_j);
  BEGIN
    INSERT INTO fleet_revenue_claims (claim_key, claim_kind, journal_id, claimed_by) VALUES (v_pkey, 'provider_payout', v_first, p_actor);
    INSERT INTO fleet_revenue_claims (claim_key, claim_kind, journal_id, claimed_by)
      VALUES (v_bkey, CASE WHEN r.evidence_kind = 'owner_attested' THEN 'owner_attestation' ELSE 'bank_receipt' END, v_first, p_actor);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'FLEET_ALREADY_CLAIMED: payout % or bank transaction % is already recorded', v_pkey, v_bkey;
  END;
  UPDATE fleet_settlement_receipts SET status = 'posted', posted_at = now(),
         status_reason = CASE WHEN (a ->> 'quarantined')::boolean THEN 'posted to suspense: ' || (a ->> 'reason') ELSE NULL END
   WHERE receipt_id = p_receipt;
  PERFORM fleet_event('receipt_posted', NULL, p_actor, jsonb_build_object('receiptId', p_receipt, 'amountMinor', r.amount_minor, 'currency', r.currency,
    'basis', a ->> 'basis', 'quarantined', (a ->> 'quarantined')::boolean, 'suspenseMinor', r.amount_minor - v_alloc, 'evidence', r.evidence_kind));
  RETURN jsonb_build_object('ok', true, 'allocation', a, 'suspenseMinor', r.amount_minor - v_alloc);
END $$;

-- Match a receipt to exactly one reported payout, then post it where it may become capital; otherwise hold it with a
-- reason. A posting failure (e.g. the treasury cannot advance a shortfall) rolls the posting back and holds the receipt.
CREATE FUNCTION fleet_receipt_process(p_receipt uuid, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_settlement_receipts; d fleet_settlement_destinations; n integer; m record; v_res jsonb;
BEGIN
  SELECT * INTO r FROM fleet_settlement_receipts WHERE receipt_id = p_receipt FOR UPDATE;
  IF r.status IN ('posted','transferred') THEN RETURN jsonb_build_object('ok', true, 'status', r.status, 'replay', true); END IF;
  SELECT * INTO d FROM fleet_settlement_destinations WHERE destination_id = r.destination_id;
  IF r.amount_minor < 0 THEN
    -- A debit (a negative provider balance taken back): into suspense until attributed to its agent; never guessed.
    IF d.kind <> 'fleet_treasury' OR d.access_status <> 'verified' THEN
      UPDATE fleet_settlement_receipts SET status = 'held', status_reason = 'a debit outside a verified fleet-treasury destination' WHERE receipt_id = p_receipt;
      PERFORM fleet_event('receipt_held', NULL, p_actor, jsonb_build_object('receiptId', p_receipt, 'reason', 'debit outside the verified treasury'));
      RETURN jsonb_build_object('ok', false, 'status', 'held');
    END IF;
    BEGIN
      PERFORM fleet_provider_post_suspense(p_receipt, 1, r.amount_minor, 'bank:' || r.destination_id || ':txn:' || r.bank_txn_id, 'quarantined',
        'a provider debit, held in suspense until attributed', p_actor);
      INSERT INTO fleet_revenue_claims (claim_key, claim_kind, journal_id, claimed_by)
        VALUES ('bank:' || r.destination_id || ':txn:' || r.bank_txn_id, 'bank_receipt',
                (SELECT journal_id FROM fleet_provider_allocations WHERE receipt_id = p_receipt ORDER BY seq LIMIT 1), p_actor);
      UPDATE fleet_settlement_receipts SET status = 'posted', posted_at = now(), status_reason = 'provider debit in suspense' WHERE receipt_id = p_receipt;
    EXCEPTION WHEN OTHERS THEN
      UPDATE fleet_settlement_receipts SET status = 'held', status_reason = left('could not post the debit: ' || SQLERRM, 300) WHERE receipt_id = p_receipt;
      PERFORM fleet_event('receipt_held', NULL, p_actor, jsonb_build_object('receiptId', p_receipt, 'reason', left(SQLERRM, 200)));
      RETURN jsonb_build_object('ok', false, 'status', 'held', 'reason', SQLERRM);
    END;
    RETURN jsonb_build_object('ok', true, 'status', 'posted', 'debitInSuspense', -r.amount_minor);
  END IF;
  IF r.payout_id IS NULL THEN
    SELECT count(*) INTO n FROM fleet_provider_payouts p
     WHERE p.status = 'completed' AND p.currency = r.currency AND p.amount_minor = r.amount_minor
       AND r.booked_on BETWEEN p.processed_at::date AND fleet_add_business_days(p.processed_at::date, ${RECEIPT_MATCH_BUSINESS_DAYS})
       AND (d.payout_visual IS NULL OR p.bank_visual IS NULL OR p.bank_visual = d.payout_visual)
       AND (d.descriptor_pattern IS NULL OR COALESCE(r.descriptor, '') ~* d.descriptor_pattern)
       AND NOT EXISTS (SELECT 1 FROM fleet_settlement_receipts o WHERE o.account_id = p.account_id AND o.payout_id = p.payout_id AND o.receipt_id <> r.receipt_id);
    IF n <> 1 THEN
      UPDATE fleet_settlement_receipts SET status = CASE WHEN n = 0 THEN 'unmatched' ELSE 'ambiguous' END,
             status_reason = CASE WHEN n = 0 THEN 'no reported payout matches' ELSE format('%s reported payouts match', n) END WHERE receipt_id = p_receipt;
      RETURN jsonb_build_object('ok', false, 'status', CASE WHEN n = 0 THEN 'unmatched' ELSE 'ambiguous' END, 'candidates', n);
    END IF;
    SELECT p.account_id, p.payout_id INTO m FROM fleet_provider_payouts p
     WHERE p.status = 'completed' AND p.currency = r.currency AND p.amount_minor = r.amount_minor
       AND r.booked_on BETWEEN p.processed_at::date AND fleet_add_business_days(p.processed_at::date, ${RECEIPT_MATCH_BUSINESS_DAYS})
       AND (d.payout_visual IS NULL OR p.bank_visual IS NULL OR p.bank_visual = d.payout_visual)
       AND (d.descriptor_pattern IS NULL OR COALESCE(r.descriptor, '') ~* d.descriptor_pattern)
       AND NOT EXISTS (SELECT 1 FROM fleet_settlement_receipts o WHERE o.account_id = p.account_id AND o.payout_id = p.payout_id AND o.receipt_id <> r.receipt_id);
    UPDATE fleet_settlement_receipts SET status = 'matched', status_reason = NULL, account_id = m.account_id, payout_id = m.payout_id WHERE receipt_id = p_receipt;
  END IF;
  IF d.kind = 'owner_external' THEN
    UPDATE fleet_settlement_receipts SET status = 'held', status_reason = 'received outside the fleet treasury: link the transfer into the treasury' WHERE receipt_id = p_receipt;
    PERFORM fleet_event('receipt_held', NULL, p_actor, jsonb_build_object('receiptId', p_receipt, 'reason', 'outside the fleet treasury'));
    RETURN jsonb_build_object('ok', true, 'status', 'held', 'reason', 'outside the fleet treasury');
  END IF;
  IF d.access_status <> 'verified' THEN
    UPDATE fleet_settlement_receipts SET status = 'held', status_reason = 'the fleet''s access to this treasury destination is not verified' WHERE receipt_id = p_receipt;
    PERFORM fleet_event('receipt_held', NULL, p_actor, jsonb_build_object('receiptId', p_receipt, 'reason', 'treasury access not verified'));
    RETURN jsonb_build_object('ok', true, 'status', 'held', 'reason', 'treasury access not verified');
  END IF;
  BEGIN
    v_res := fleet_provider_receipt_post(p_receipt, p_actor);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FLEET_ALREADY_CLAIMED%' THEN RAISE; END IF;
    UPDATE fleet_settlement_receipts SET status = 'held', status_reason = left('could not post: ' || SQLERRM, 300) WHERE receipt_id = p_receipt;
    PERFORM fleet_event('receipt_held', NULL, p_actor, jsonb_build_object('receiptId', p_receipt, 'reason', left(SQLERRM, 200)));
    RETURN jsonb_build_object('ok', false, 'status', 'held', 'reason', SQLERRM);
  END;
  RETURN v_res || jsonb_build_object('status', 'posted');
END $$;

-- The bank feed's recorder (G4's rx_ wrapper calls it): idempotent per (destination, bank transaction).
CREATE FUNCTION fleet_bank_receipt_record(p_destination uuid, p_bank_txn text, p_amount bigint, p_currency text, p_booked_on date, p_descriptor text,
  p_payload_sha256 text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_settlement_receipts; d fleet_settlement_destinations;
BEGIN
  SELECT * INTO d FROM fleet_settlement_destinations WHERE destination_id = p_destination;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF d.currency <> p_currency THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'the destination account is in another currency'); END IF;
  SELECT * INTO r FROM fleet_settlement_receipts WHERE destination_id = p_destination AND bank_txn_id = p_bank_txn;
  IF FOUND THEN
    IF r.amount_minor <> p_amount OR r.currency <> p_currency OR r.booked_on <> p_booked_on OR r.payload_sha256 <> p_payload_sha256 THEN
      PERFORM fleet_event('provider_conflict', NULL, p_actor, jsonb_build_object('destinationId', p_destination, 'bankTxn', p_bank_txn, 'what', 'receipt'));
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PROVIDER_CONFLICT');
    END IF;
    RETURN fleet_receipt_process(r.receipt_id, p_actor) || jsonb_build_object('replay', true, 'receiptId', r.receipt_id);
  END IF;
  INSERT INTO fleet_settlement_receipts (receipt_id, destination_id, bank_txn_id, amount_minor, currency, booked_on, descriptor, evidence_kind, payload_sha256, recorded_by)
    VALUES (gen_random_uuid(), p_destination, p_bank_txn, p_amount, p_currency, p_booked_on, left(p_descriptor, 140), 'bank_feed', p_payload_sha256, p_actor)
    RETURNING * INTO r;
  RETURN fleet_receipt_process(r.receipt_id, p_actor) || jsonb_build_object('receiptId', r.receipt_id);
END $$;

-- PILOT FALLBACK (labelled): the owner attests that a payout arrived in a verified treasury destination. Only within an
-- active pilot authorisation, never once a bank feed verifies receipts, and only for the exact reported amount.
CREATE FUNCTION fleet_admin_receipt_attest(p_destination uuid, p_account uuid, p_payout text, p_amount bigint, p_currency text, p_booked_on date, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_provider_payouts; v_id uuid := gen_random_uuid(); v_txn text;
BEGIN
  ${OWNER_ACTOR}
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');
  IF NOT fleet_pilot_active('receipt_attestation') THEN RAISE EXCEPTION 'FLEET_PILOT_REQUIRED: owner attestation needs an active pilot authorisation'; END IF;
  IF fleet_bankfeed_active() THEN RAISE EXCEPTION 'FLEET_PILOT_RETIRED: a bank-feed connector verifies receipts'; END IF;
  SELECT * INTO p FROM fleet_provider_payouts WHERE account_id = p_account AND payout_id = p_payout;
  IF NOT FOUND OR p.status <> 'completed' THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no completed reported payout'; END IF;
  v_txn := 'attested:' || p_payout;
  INSERT INTO fleet_settlement_receipts (receipt_id, destination_id, bank_txn_id, amount_minor, currency, booked_on, descriptor, evidence_kind, payload_sha256,
      recorded_by, status, account_id, payout_id, status_reason)
    VALUES (v_id, p_destination, v_txn, p_amount, p_currency, p_booked_on, 'owner attestation', 'owner_attested',
      encode(sha256(convert_to(p_account || '|' || p_payout || '|' || p_amount || '|' || p_currency || '|' || p_booked_on, 'UTF8')), 'hex'), p_actor,
      CASE WHEN p_amount = p.amount_minor AND p_currency = p.currency THEN 'matched' ELSE 'held' END, p_account, p_payout,
      CASE WHEN p_amount = p.amount_minor AND p_currency = p.currency THEN NULL ELSE 'attested amount differs from the reported payout' END);
  IF p_amount <> p.amount_minor OR p_currency <> p.currency THEN
    PERFORM fleet_event('receipt_held', NULL, p_actor, jsonb_build_object('receiptId', v_id, 'reason', 'attested amount differs'));
    RETURN jsonb_build_object('ok', false, 'status', 'held', 'receiptId', v_id, 'reason', 'attested amount differs from the reported payout');
  END IF;
  RETURN fleet_receipt_process(v_id, p_actor) || jsonb_build_object('receiptId', v_id, 'evidence', 'owner_attested (not independently verified)');
END $$;

-- A payout received in an owner_external account reaches agents only when the matching transfer INTO the treasury is
-- linked: both bank transactions are claimed; the posting is the treasury receipt's.
CREATE FUNCTION fleet_admin_receipt_transfer_link(p_external uuid, p_treasury uuid, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE e fleet_settlement_receipts; t fleet_settlement_receipts; de fleet_settlement_destinations; dt fleet_settlement_destinations; v_res jsonb;
BEGIN
  ${OWNER_ACTOR}
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');
  SELECT * INTO e FROM fleet_settlement_receipts WHERE receipt_id = p_external FOR UPDATE;
  SELECT * INTO t FROM fleet_settlement_receipts WHERE receipt_id = p_treasury FOR UPDATE;
  SELECT * INTO de FROM fleet_settlement_destinations WHERE destination_id = e.destination_id;
  SELECT * INTO dt FROM fleet_settlement_destinations WHERE destination_id = t.destination_id;
  IF de.kind <> 'owner_external' OR e.status <> 'held' OR e.payout_id IS NULL THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: not a held, matched owner-external receipt'; END IF;
  IF dt.kind <> 'fleet_treasury' OR t.status NOT IN ('unmatched','ambiguous') OR t.payout_id IS NOT NULL OR t.amount_minor <> e.amount_minor OR t.currency <> e.currency
     OR t.booked_on < e.booked_on THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: the treasury receipt must be an unmatched credit of the same amount and currency, on or after the original';
  END IF;
  UPDATE fleet_settlement_receipts SET status = 'transferred', posted_at = now(), status_reason = 'moved into the treasury (receipt ' || p_treasury || ')' WHERE receipt_id = p_external;
  UPDATE fleet_settlement_receipts SET status = 'matched', account_id = e.account_id, payout_id = e.payout_id, transfer_of = p_external, status_reason = NULL
   WHERE receipt_id = p_treasury;
  v_res := fleet_receipt_process(p_treasury, p_actor);
  IF (SELECT status FROM fleet_settlement_receipts WHERE receipt_id = p_treasury) = 'posted' THEN
    BEGIN
      INSERT INTO fleet_revenue_claims (claim_key, claim_kind, journal_id, claimed_by)
        VALUES ('bank:' || e.destination_id || ':txn:' || e.bank_txn_id, 'receipt_transfer',
                (SELECT journal_id FROM fleet_revenue_claims WHERE claim_key = 'bank:' || t.destination_id || ':txn:' || t.bank_txn_id), p_actor);
    EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'FLEET_ALREADY_CLAIMED: the original receipt is already recorded'; END;
  ELSE
    RAISE EXCEPTION 'FLEET_INVALID_STATE: the treasury receipt could not be posted (%)', v_res ->> 'reason';
  END IF;
  RETURN v_res;
END $$;

-- Release suspense once attribution allows it: recompute with current attributions (past sales keep their owners) and
-- move only the difference from suspense to the agents. The allocation must now reconcile (no quarantine).
CREATE FUNCTION fleet_admin_provider_suspense_release(p_receipt uuid, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_settlement_receipts; a jsonb; x jsonb; v_round integer; v_posted bigint; v_delta bigint; v_moved bigint := 0; v_pkey text; n integer := 0;
BEGIN
  ${OWNER_ACTOR}
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');
  SELECT * INTO r FROM fleet_settlement_receipts WHERE receipt_id = p_receipt;
  IF NOT FOUND OR r.status <> 'posted' OR r.payout_id IS NULL OR r.manual_claim IS NOT NULL THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: not a posted payout receipt'; END IF;
  PERFORM 1 FROM fleet_provider_allocations WHERE receipt_id = p_receipt FOR UPDATE;
  a := fleet_provider_payout_allocation(r.account_id, r.payout_id, r.amount_minor, r.currency);
  IF (a ->> 'quarantined')::boolean THEN RAISE EXCEPTION 'FLEET_STILL_QUARANTINED: %', a ->> 'reason'; END IF;
  v_round := (SELECT max(round) FROM fleet_provider_allocations WHERE receipt_id = p_receipt) + 1;
  v_pkey := fleet_provider_payout_key(r.account_id, r.payout_id);
  FOR x IN SELECT * FROM jsonb_array_elements(a -> 'buckets') LOOP
    SELECT COALESCE(sum(share_minor), 0) INTO v_posted FROM fleet_provider_allocations WHERE receipt_id = p_receipt AND agent_id = x ->> 'agentId';
    v_delta := (x ->> 'share')::bigint - v_posted;
    IF v_delta <> 0 THEN
      PERFORM fleet_provider_post_share(p_receipt, v_round, x ->> 'agentId', v_delta, 0, v_pkey, true, a ->> 'basis', (x ->> 'netUsd')::bigint, (x ->> 'feeUsd')::bigint,
        'released from suspense: ' || COALESCE(a ->> 'policy', ''), p_actor);
      v_moved := v_moved + v_delta; n := n + 1;
    END IF;
  END LOOP;
  IF n = 0 THEN RAISE EXCEPTION 'FLEET_NOTHING_TO_RELEASE: the allocation is unchanged'; END IF;
  -- The suspense side of the round (its journals are the shares' own): recorded for conservation.
  INSERT INTO fleet_provider_allocations (receipt_id, round, agent_id, basis, share_minor, note)
    VALUES (p_receipt, v_round, NULL, a ->> 'basis', -v_moved, 'suspense side of a release');
  PERFORM fleet_event('provider_suspense_released', NULL, p_actor, jsonb_build_object('receiptId', p_receipt, 'round', v_round, 'movedMinor', v_moved, 'agents', n));
  RETURN jsonb_build_object('ok', true, 'round', v_round, 'movedMinor', v_moved, 'agents', n);
END $$;

-- A provider DEBIT held in suspense, attributed by the owner (with a reason) to the agent whose refunds caused it.
CREATE FUNCTION fleet_admin_receipt_debit_assign(p_receipt uuid, p_agent text, p_amount bigint, p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_settlement_receipts; v_left bigint; v_round integer;
BEGIN
  ${OWNER_ACTOR}
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a reason is required'; END IF;
  SELECT * INTO r FROM fleet_settlement_receipts WHERE receipt_id = p_receipt;
  IF NOT FOUND OR r.status <> 'posted' OR r.amount_minor >= 0 THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: not a posted provider debit'; END IF;
  PERFORM 1 FROM fleet_provider_allocations WHERE receipt_id = p_receipt FOR UPDATE;
  v_left := -(SELECT COALESCE(sum(share_minor), 0) FROM fleet_provider_allocations WHERE receipt_id = p_receipt AND agent_id IS NULL);
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > v_left THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: 1..% of the debit remains unattributed', v_left; END IF;
  v_round := (SELECT max(round) FROM fleet_provider_allocations WHERE receipt_id = p_receipt) + 1;
  PERFORM fleet_provider_post_share(p_receipt, v_round, p_agent, -p_amount, 0, 'bank:' || r.destination_id || ':txn:' || r.bank_txn_id, true, 'owner_assignment',
    NULL, NULL, left('debit attributed: ' || fleet_scrub(p_reason), 300), p_actor);
  INSERT INTO fleet_provider_allocations (receipt_id, round, agent_id, basis, share_minor, note) VALUES (p_receipt, v_round, NULL, 'owner_assignment', p_amount, 'suspense side');
  PERFORM fleet_event('receipt_debit_assigned', p_agent, p_actor, jsonb_build_object('receiptId', p_receipt, 'amountMinor', p_amount));
  RETURN jsonb_build_object('ok', true, 'assignedMinor', p_amount, 'unattributedMinor', v_left - p_amount);
END $$;

-- ═══ 10. Manual revenue, owner funding, routing, reconciliation ═══
${RECORD_EXTERNAL}

${RECORD_CLAIMED}

${RECORD_FUNDING}

${EVENT_ROUTE}

${RECONCILE}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

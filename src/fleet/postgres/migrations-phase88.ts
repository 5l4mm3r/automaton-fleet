/**
 * Schema v88 — money that has left is always on the books (owner, 2026-10-16: "preserve external financial evidence even
 * when allocation or posting fails"; "agent-benefiting media costs, including overruns, remain attributable to that agent").
 *
 * 1. A BANK LINE IS ALWAYS RECORDED. Matching and booking run in their own sub-transaction: if booking fails for any
 *    reason, the line stays recorded with its error, listed as unexplained, alerted (RED BANK_LINE_NOT_BOOKED) and retried
 *    on every pass — never rejected, never blocking the other lines. A statement import records each row on its own.
 *
 * 2. A SHORTFALL IS RECORDED AS WHAT HAPPENED. When a card charge (debit or the owner's card) exceeds the reservation and
 *    the agent's cash, the v51 path books the rest as the agent's DEBT (its payable, repaid first from its next receipts),
 *    advanced by the treasury. Where the treasury's unallocated cash cannot carry that advance, the uncovered part goes to
 *    fleet:treasury:shortfall — a cash account that may be NEGATIVE: money that has left with no partition holding it.
 *    It is counted in the books' cash (so the whole-treasury reconciliation stays true), it is not spendable by anyone,
 *    it is alerted (RED TREASURY_SHORTFALL, daily while open), and the agent's card is frozen while it is open. Nothing is
 *    funded: the agent gains no cash or credit; no other partition is touched.
 *    Later money settles it in order: anything arriving in unallocated cash (the agent's repayments, the owner's funding, a
 *    refund) fills the shortfall first (treasury_shortfall_cover). On the agent's death its unrecoverable payable is
 *    written off as before (v56) and any shortfall stays visible for the owner.
 *
 * 3. MEDIA OVERRUNS ARE THE AGENT'S. A job costing more than its reservation is charged to the agent: the reservation,
 *    then its remaining cash, then the rest as its debt (its payable; owed to the owner through the treasury, who paid the
 *    provider). No wallet credit, no Fleet subsidy. Fleet-benefiting work names its mission's beneficiaries (v87).
 */
import { V51_SQL } from "./migrations-phase51.js";
import { V69_SQL } from "./migrations-phase69.js";
import { V86_SQL } from "./migrations-phase86.js";
import { V87_SQL } from "./migrations-phase87.js";
import { TREASURY_HELD_CLASSES } from "./migrations-phase66.js";
import { restate } from "./migrations-phase42.js";

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
export const SHORTFALL_ACCOUNT = "fleet:treasury:shortfall";
export const SHORTFALL_KINDS = ["treasury_shortfall_cover"] as const;

// ── Card posting: the part of an advance the unallocated cash cannot carry is a recorded shortfall ──
const CHARGE_POST = restate(V86_SQL, "fleet_card_charge_post", [
  [`DECLARE ch fleet_card_charges; e fleet_envelopes; eco jsonb; d bigint; rem bigint; v_res bigint := 0; v_own bigint := 0; v_env bigint := 0; v_adv bigint := 0;`,
   `DECLARE ch fleet_card_charges; e fleet_envelopes; eco jsonb; d bigint; rem bigint; v_res bigint := 0; v_own bigint := 0; v_env bigint := 0; v_adv bigint := 0; v_unf bigint := 0;`],
  [`    IF v_adv > 0 THEN v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account', acct_pay, 'side', 'C', 'amount', v_adv),
      jsonb_build_object('account', 'fleet:provider:advances', 'side', 'D', 'amount', v_adv),
      jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', v_adv)); END IF;`,
   `    -- v88: the advance is carried by unallocated cash as far as it goes; the rest is a recorded shortfall (never rejected).
    IF v_adv > 0 THEN
      PERFORM 1 FROM fleet_ledger_accounts WHERE account_id IN ('fleet:treasury:unallocated', '${SHORTFALL_ACCOUNT}') ORDER BY account_id FOR UPDATE;
      v_unf := GREATEST(0, v_adv - GREATEST(0, fleet_ledger_balance('fleet:treasury:unallocated')));
      v_lines := v_lines || jsonb_build_array(
        jsonb_build_object('account', acct_pay, 'side', 'C', 'amount', v_adv),
        jsonb_build_object('account', 'fleet:provider:advances', 'side', 'D', 'amount', v_adv));
      IF v_adv - v_unf > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', v_adv - v_unf)); END IF;
      IF v_unf > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', '${SHORTFALL_ACCOUNT}', 'side', 'C', 'amount', v_unf)); END IF;
    END IF;`],
  [`  v_j := fleet_ledger_post(v_kind, p_idem, p_actor, 'card charge: ' || ch.merchant, p_source, ch.agent_id, NULL, NULL, p_idem, NULL, now(), v_lines);`,
   `  v_j := fleet_ledger_post(v_kind, p_idem, p_actor, 'card charge: ' || ch.merchant, p_source, ch.agent_id, NULL, NULL, p_idem, NULL, now(), v_lines);
  IF v_unf > 0 THEN
    UPDATE fleet_card_charges SET shortfall_minor = shortfall_minor + v_unf WHERE charge_id = p_charge;
    PERFORM fleet_notify('RED', 'TREASURY_SHORTFALL', ch.agent_id, 'A card charge at ' || ch.merchant || ' left more money than the agent and the unallocated treasury held',
      jsonb_build_object('chargeId', p_charge, 'shortfallMinor', v_unf, 'advancedMinor', v_adv,
        'next', 'the agent owes it (its payable) and its card is frozen; money arriving in unallocated cash fills the shortfall first'), 'shortfall:' || p_charge || ':' || v_j);
  END IF;`],
]);

// ── Matching never loses a line ──
const TXN_RECORD = restate(V86_SQL, "fleet_location_txn_record", [
  [`  r := fleet_location_match(t.txn_id);
  RETURN jsonb_build_object('ok', true, 'txnId', t.txn_id, 'match', r);`,
   `  r := fleet_location_match_safe(t.txn_id);
  RETURN jsonb_build_object('ok', true, 'txnId', t.txn_id, 'match', r);`],
]);
const MATCH_PENDING = restate(V86_SQL, "fleet_location_match_pending", [
  [`    r := fleet_location_match(t);`, `    r := fleet_location_match_safe(t);`],
  [`    IF r NOT IN ('unmatched','ambiguous','unchanged') THEN n := n + 1; END IF;
  END LOOP;
  RETURN n;`, `    IF r NOT IN ('unmatched','ambiguous','unchanged','error') THEN n := n + 1; END IF;
  END LOOP;
  PERFORM fleet_treasury_shortfall_settle();
  RETURN n;`],
]);
const IMPORT = restate(V86_SQL, "fleet_admin_location_import", [
  [`DECLARE x jsonb; r jsonb; n integer := 0; nm integer := 0; nr integer := 0;`, `DECLARE x jsonb; r jsonb; n integer := 0; nm integer := 0; nr integer := 0; i integer := 0; rej jsonb := '[]'::jsonb;`],
  [`    r := fleet_location_txn_record(p_loc, x, 'csv');
    IF NOT (r ->> 'ok')::boolean THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a row is not a valid transaction: %', left(x::text, 200); END IF;`,
   `    i := i + 1;
    r := fleet_location_txn_record(p_loc, x, 'csv');
    -- v88: a row that is not a valid transaction is reported, never a reason to drop the others.
    IF NOT (r ->> 'ok')::boolean THEN rej := rej || jsonb_build_array(jsonb_build_object('row', i, 'code', r ->> 'code')); CONTINUE; END IF;`],
  [`  RETURN jsonb_build_object('ok', true, 'recorded', n, 'replayed', nr, 'matched', nm,`, `  RETURN jsonb_build_object('ok', true, 'recorded', n, 'replayed', nr, 'matched', nm, 'rejected', rej,
    'notBooked', (SELECT count(*) FROM fleet_bank_transactions WHERE location_id = p_loc AND match_error IS NOT NULL AND classified IS NULL),`],
]);
const LOCATIONS_JSON = restate(V86_SQL, "fleet_locations_json", [
  [`                   'amountMinor', amount_minor, 'descriptor', descriptor, 'at', COALESCE(settled_at, authorised_at, first_seen)) ORDER BY first_seen)`,
   `                   'amountMinor', amount_minor, 'descriptor', descriptor, 'at', COALESCE(settled_at, authorised_at, first_seen),
                   'matchError', match_error, 'matchFailedAt', match_failed_at) ORDER BY first_seen)`],
  [`    'reconciliation', fleet_treasury_reconciliation())`, `    'reconciliation', fleet_treasury_reconciliation(),
    'shortfall', jsonb_build_object('minor', -LEAST(fleet_ledger_balance('${SHORTFALL_ACCOUNT}'), 0),
      'charges', COALESCE((SELECT jsonb_agg(jsonb_build_object('chargeId', charge_id, 'agentId', agent_id, 'merchant', merchant, 'shortfallMinor', shortfall_minor) ORDER BY created_at)
                           FROM fleet_card_charges WHERE shortfall_minor > 0), '[]'::jsonb)))`],
]);

// ── The agent's card is frozen while a shortfall it caused is open ──
const CARD_AUTHORIZE = restate(V86_SQL, "fleet_econ_card_authorize", [
  [`  -- v86: debit mode — the hold must also fit the bank location's fresh spendable cash (under that location's lock).`,
   `  -- v88: a charge of yours left more money than you and the unallocated treasury held: no card until it is settled.
  IF fleet_ledger_balance('${SHORTFALL_ACCOUNT}') < 0 AND fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_provider_payable')) > 0
     AND EXISTS (SELECT 1 FROM fleet_card_charges WHERE agent_id = p_agent AND shortfall_minor > 0) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CARD_SHORTFALL',
      'reason', 'a card charge of yours exceeded what you and the treasury held; the card is frozen until that is settled (you owe it: repay from your receipts)');
  END IF;
  -- v86: debit mode — the hold must also fit the bank location's fresh spendable cash (under that location's lock).`],
]);

// ── The books' cash includes the shortfall (so books against money stays true) ──
const BACKING = restate(V69_SQL, "fleet_capital_backing", [
  [`INTO v_books FROM fleet_ledger_accounts WHERE class IN (${q(TREASURY_HELD_CLASSES)});`,
   `INTO v_books FROM fleet_ledger_accounts WHERE class IN (${q([...TREASURY_HELD_CLASSES, "treasury_shortfall"])});`],
]);

// ── The watch: a daily reminder while a shortfall is open; covering it from any unallocated money that arrived ──
const OPS_WATCH = restate(V87_SQL, "svc_operations_watch", [
  [`  rec := fleet_treasury_reconciliation();`, `  -- v88: money that has left with no partition holding it (filled first by anything arriving in unallocated cash).
  PERFORM fleet_treasury_shortfall_settle();
  k := -LEAST(fleet_ledger_balance('${SHORTFALL_ACCOUNT}'), 0);
  IF k > 0 AND fleet_notify('RED', 'TREASURY_SHORTFALL', NULL, 'The treasury is short ' || k || ' (minor units): money left that no partition held',
       jsonb_build_object('shortfallMinor', k), 'treasury-shortfall:' || day) THEN n := n + 1; END IF;
  SELECT count(*) INTO k FROM fleet_bank_transactions WHERE match_error IS NOT NULL AND classified IS NULL;
  IF k > 0 AND fleet_notify('RED', 'BANK_LINE_NOT_BOOKED', NULL, k || ' bank line(s) could not be booked: they are recorded and retried',
       jsonb_build_object('count', k), 'bank-not-booked:' || day) THEN n := n + 1; END IF;
  rec := fleet_treasury_reconciliation();`],
]);

export const V88_SQL = `
-- ═══ 1. The shortfall account: money that has left with no partition holding it ═══
INSERT INTO fleet_ledger_classes (class, kind, normal_side, scope, non_negative, description) VALUES
  ('treasury_shortfall', 'asset', 'D', 'fleet', false, 'Treasury cash that left (a charge beyond the agent''s cash and the unallocated treasury) with no partition holding it: negative while open; not spendable');
INSERT INTO fleet_ledger_accounts (account_id, class, description, created_by) VALUES
  ('${SHORTFALL_ACCOUNT}', 'treasury_shortfall', 'Treasury shortfall (negative while open)', 'migration');
ALTER TABLE fleet_ledger_kinds DISABLE TRIGGER fleet_ledger_kinds_no_change;
INSERT INTO fleet_ledger_kinds (kind, requires_external_ref, allowed_sources, multi_agent, description, provenance) VALUES
  ('treasury_shortfall_cover', false, ARRAY['controller'], false, 'Unallocated treasury cash that arrived fills an open shortfall (the partitions become true again; nobody is funded)', 'correction');
ALTER TABLE fleet_ledger_kinds ENABLE TRIGGER fleet_ledger_kinds_no_change;
INSERT INTO fleet_ledger_rules (kind, class, side) VALUES
  ('card_charge','treasury_shortfall','C'), ('card_charge_adjust','treasury_shortfall','C'),
  ('treasury_shortfall_cover','treasury_shortfall','D'), ('treasury_shortfall_cover','treasury_cash','C'),
  -- v88 media: the agent's remaining cash, then its debt (the treasury's advance against it).
  ('media_charge','agent_cash','C'), ('media_charge','agent_provider_payable','C'), ('media_charge','provider_advances','D')
ON CONFLICT DO NOTHING;

ALTER TABLE fleet_card_charges ADD COLUMN shortfall_minor bigint NOT NULL DEFAULT 0 CHECK (shortfall_minor >= 0);
COMMENT ON COLUMN fleet_card_charges.shortfall_minor IS 'v88: the part of this charge''s advance the unallocated treasury could not carry (recorded in fleet:treasury:shortfall)';
ALTER TABLE fleet_bank_transactions ADD COLUMN match_error text CHECK (length(match_error) <= 300);
ALTER TABLE fleet_bank_transactions ADD COLUMN match_failed_at timestamptz;

-- Money that arrived in unallocated cash fills an open shortfall first.
CREATE FUNCTION fleet_treasury_shortfall_settle() RETURNS bigint LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_short bigint; v_free bigint; v bigint;
BEGIN
  PERFORM 1 FROM fleet_ledger_accounts WHERE account_id IN ('fleet:treasury:unallocated', '${SHORTFALL_ACCOUNT}') ORDER BY account_id FOR UPDATE;
  v_short := -LEAST(fleet_ledger_balance('${SHORTFALL_ACCOUNT}'), 0);
  v_free := GREATEST(fleet_ledger_balance('fleet:treasury:unallocated'), 0);
  v := LEAST(v_short, v_free);
  IF v <= 0 THEN RETURN 0; END IF;
  PERFORM fleet_ledger_post('treasury_shortfall_cover', 'shortfall-cover:' || gen_random_uuid(), 'controller', 'unallocated cash fills the treasury shortfall', 'controller',
    NULL, NULL, NULL, NULL, NULL, now(), jsonb_build_array(
      jsonb_build_object('account', '${SHORTFALL_ACCOUNT}', 'side', 'D', 'amount', v),
      jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', v)));
  PERFORM fleet_event('treasury_shortfall_covered', NULL, 'controller', jsonb_build_object('coveredMinor', v, 'remainingMinor', v_short - v));
  RETURN v;
END $$;

-- Matching and booking in their own sub-transaction: a failure leaves the line recorded, with its error, retried later.
CREATE FUNCTION fleet_location_match_safe(p_txn uuid) RETURNS text LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r text; v_err text;
BEGIN
  BEGIN
    r := fleet_location_match(p_txn);
    UPDATE fleet_bank_transactions SET match_error = NULL, match_failed_at = NULL WHERE txn_id = p_txn AND match_error IS NOT NULL;
    PERFORM fleet_treasury_shortfall_settle(); -- money that came back (a refund) fills an open shortfall first
    RETURN r;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
  END;
  UPDATE fleet_bank_transactions SET match_error = left(v_err, 300), match_failed_at = now(), updated_at = now() WHERE txn_id = p_txn;
  PERFORM fleet_notify('RED', 'BANK_LINE_NOT_BOOKED', NULL, 'A bank line is recorded but could not be booked: it is retried and listed until explained',
    jsonb_build_object('txnId', p_txn, 'error', left(v_err, 200)), 'bank-line-error:' || p_txn);
  RETURN 'error';
END $$;

${CHARGE_POST}
${TXN_RECORD}
${MATCH_PENDING}
${IMPORT}
${LOCATIONS_JSON}
${CARD_AUTHORIZE}
${BACKING}

-- ═══ 2. Media: the whole cost is the agent's — reservation, then cash, then its debt ═══
CREATE OR REPLACE FUNCTION fleet_media_settle(p_job uuid, p_cost_cents integer, p_basis text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_media_jobs; v_cost bigint; v_charge bigint; v_extra bigint := 0; v_debt bigint := 0; v_back bigint; v_lines jsonb; v_j uuid; v_src text; v_over bigint;
BEGIN
  SELECT * INTO j FROM fleet_media_jobs WHERE job_id = p_job FOR UPDATE;
  IF j.cost_state IS NULL OR j.cost_state IN ('charged','released') THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'costState', j.cost_state); END IF;
  v_src := CASE WHEN p_actor LIKE 'operator:%' THEN 'owner' ELSE 'controller' END;
  PERFORM 1 FROM fleet_ledger_accounts WHERE account_id IN (fleet_ledger_account(j.agent_id, 'agent_cash'), fleet_ledger_account(j.agent_id, 'agent_reserved'),
    fleet_ledger_account(j.agent_id, 'agent_provider_payable')) ORDER BY account_id FOR UPDATE;
  IF COALESCE(p_cost_cents, 0) <= 0 THEN
    IF j.reserved_minor > 0 THEN
      v_j := fleet_ledger_post('media_release', 'media:' || j.job_id || ':settle', left(p_actor, 128), 'media job not charged by the provider', v_src, j.agent_id, NULL, NULL, NULL, NULL, now(),
        jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(j.agent_id, 'agent_cash'), 'side', 'D', 'amount', j.reserved_minor),
                          jsonb_build_object('account', fleet_ledger_account(j.agent_id, 'agent_reserved'), 'side', 'C', 'amount', j.reserved_minor)));
    END IF;
    UPDATE fleet_media_jobs SET cost_state = 'released', charged_minor = 0, cost_usd_cents = 0, cost_basis = COALESCE(p_basis, cost_basis), settle_journal = v_j WHERE job_id = j.job_id;
    RETURN jsonb_build_object('ok', true, 'costState', 'released', 'releasedMinor', j.reserved_minor);
  END IF;
  v_cost := fleet_media_usd_to_minor(p_cost_cents);
  v_charge := LEAST(v_cost, j.reserved_minor);
  v_over := v_cost - v_charge;
  v_back := j.reserved_minor - v_charge;
  -- Beyond the reservation: the agent's remaining cash, then its debt (no wallet credit, no Fleet subsidy).
  IF v_over > 0 THEN
    v_extra := LEAST(v_over, GREATEST(fleet_agent_cash(j.agent_id), 0));
    v_debt := v_over - v_extra;
  END IF;
  v_lines := jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(j.agent_id, 'agent_reserved'), 'side', 'C', 'amount', j.reserved_minor),
    jsonb_build_object('account', fleet_ledger_account(j.agent_id, 'agent_expense'), 'side', 'D', 'amount', v_cost),
    jsonb_build_object('account', 'fleet:owner:payable', 'side', 'C', 'amount', v_cost));
  IF v_charge + v_extra > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'fleet:treasury:owner_reimbursable', 'side', 'D', 'amount', v_charge + v_extra)); END IF;
  IF v_back > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(j.agent_id, 'agent_cash'), 'side', 'D', 'amount', v_back)); END IF;
  IF v_extra > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(j.agent_id, 'agent_cash'), 'side', 'C', 'amount', v_extra)); END IF;
  IF v_debt > 0 THEN v_lines := v_lines || jsonb_build_array(
    jsonb_build_object('account', fleet_ledger_account(j.agent_id, 'agent_provider_payable'), 'side', 'C', 'amount', v_debt),
    jsonb_build_object('account', 'fleet:provider:advances', 'side', 'D', 'amount', v_debt)); END IF;
  v_j := fleet_ledger_post('media_charge', 'media:' || j.job_id || ':settle', left(p_actor, 128), left(j.kind || ' job (' || COALESCE(j.provider, '?') || ')', 200), v_src, j.agent_id,
    NULL, NULL, NULL, NULL, now(), v_lines);
  UPDATE fleet_media_jobs SET cost_state = 'charged', cost_usd_cents = p_cost_cents, cost_basis = p_basis, charged_minor = v_cost, overrun_minor = v_over, settle_journal = v_j
   WHERE job_id = j.job_id;
  IF v_over > 0 THEN
    PERFORM fleet_notify('AMBER', 'MEDIA_COST_OVERRUN', j.agent_id, 'A ' || j.kind || ' job cost more than its limit: charged to the agent' || CASE WHEN v_debt > 0 THEN ' (part as its debt)' ELSE '' END,
      jsonb_build_object('jobId', j.job_id, 'reservedMinor', j.reserved_minor, 'costMinor', v_cost, 'fromCashMinor', v_extra, 'debtMinor', v_debt, 'basis', p_basis), 'media-overrun:' || j.job_id);
  END IF;
  RETURN jsonb_build_object('ok', true, 'costState', 'charged', 'chargedMinor', v_cost, 'overrunMinor', v_over, 'fromCashMinor', v_extra, 'debtMinor', v_debt, 'returnedMinor', v_back);
END $$;

${OPS_WATCH}
`;

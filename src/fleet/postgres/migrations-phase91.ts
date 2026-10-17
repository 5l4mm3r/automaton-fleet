/**
 * Schema v91 — a deposit into the BANK backs the existing capital (owner, 2026-10-17: "Confirm whether verified bank
 * deposits can back the existing virtual capital. If that connection is missing, finish it").
 *
 * Until v90 only a PayPal transaction could back capital (fleet_admin_capital_back); a settled deposit the owner made
 * straight into a bank location was always NEW owner funding (fleet_admin_location_contribution), so the £ that the
 * agents' wallets already record stayed "unbacked" and the deposit became unallocated cash instead.
 *
 * From v91 the owner's bank deposit ("My deposit") is applied in this order, under the backing lock:
 *   1. an open treasury shortfall (v88) is filled first — as owner funding into unallocated cash, which the shortfall
 *      settlement moves at once (money that already left the treasury);
 *   2. then capital not yet backed by money: that part is recorded as a backing of the existing capital — NO ledger entry,
 *      the books already hold it (exactly as the PayPal path);
 *   3. anything beyond is ordinary owner funding (unallocated: Fleet Control allocates it, never automatically).
 * Only a settled incoming transfer in the books' currency backs anything; the line is closed and its key (bank:<location>:
 * <external id>) can never be recorded again (as a backing, funding or revenue). Nobody is granted spending by it.
 *
 * fleet_capital_backing() lists bank backings beside PayPal ones; its PayPal-only "difference" is withheld once a bank
 * location is active (the whole-treasury reconciliation — every location against the books — is the true check).
 */
import { V88_SQL, SHORTFALL_ACCOUNT } from "./migrations-phase88.js";
import { restate } from "./migrations-phase42.js";

const BACKING = restate(V88_SQL, "fleet_capital_backing", [
  [`    'differenceMinor', CASE WHEN b.observation_id IS NULL THEN NULL ELSE b.total_minor - (v_books - v_unbacked) END,`,
   `    -- v91: PayPal alone is not the treasury once a bank location holds money: the reconciliation compares every location.
    'differenceMinor', CASE WHEN b.observation_id IS NULL OR EXISTS (SELECT 1 FROM fleet_money_locations WHERE kind <> 'paypal' AND status <> 'pending_setup')
                            THEN NULL ELSE b.total_minor - (v_books - v_unbacked) END,
    'differenceScope', CASE WHEN EXISTS (SELECT 1 FROM fleet_money_locations WHERE kind <> 'paypal' AND status <> 'pending_setup')
                            THEN 'several locations: see the treasury reconciliation' ELSE 'paypal' END,`],
  [`    'backings', COALESCE((SELECT jsonb_agg(jsonb_build_object('backingId', k.backing_id, 'transactionId', k.transaction_id, 'netMinor', k.net_minor,`,
   `    'backings', COALESCE((SELECT jsonb_agg(jsonb_build_object('backingId', k.backing_id, 'source', CASE WHEN k.bank_txn_id IS NULL THEN 'paypal' ELSE 'bank' END,
        'locationId', k.location_id, 'transactionId', COALESCE(k.transaction_id, (SELECT x.external_id FROM fleet_bank_transactions x WHERE x.txn_id = k.bank_txn_id)), 'netMinor', k.net_minor,`],
]);

export const V91_SQL = `
-- ═══ 1. A backing may come from a bank line ═══
ALTER TABLE fleet_capital_backings DROP CONSTRAINT fleet_capital_backings_claim_key_check;
ALTER TABLE fleet_capital_backings ADD CONSTRAINT fleet_capital_backings_claim_key_check
  CHECK (claim_key ~ '^paypal:txn:[A-Z0-9]{5,40}$' OR claim_key ~ '^bank:[0-9a-f-]{36}:.{1,120}$');
ALTER TABLE fleet_capital_backings ALTER COLUMN rail_id DROP NOT NULL, ALTER COLUMN transaction_id DROP NOT NULL, ALTER COLUMN event_code DROP NOT NULL;
ALTER TABLE fleet_capital_backings ADD COLUMN location_id uuid REFERENCES fleet_money_locations(location_id),
  ADD COLUMN bank_txn_id uuid UNIQUE REFERENCES fleet_bank_transactions(txn_id),
  ADD COLUMN shortfall_minor bigint NOT NULL DEFAULT 0 CHECK (shortfall_minor >= 0);
ALTER TABLE fleet_capital_backings ADD CONSTRAINT fleet_capital_backings_one_source CHECK (
  (bank_txn_id IS NULL AND location_id IS NULL AND rail_id IS NOT NULL AND transaction_id IS NOT NULL AND event_code IS NOT NULL AND claim_key LIKE 'paypal:%')
  OR (bank_txn_id IS NOT NULL AND location_id IS NOT NULL AND rail_id IS NULL AND transaction_id IS NULL AND event_code IS NULL AND claim_key LIKE 'bank:%'));
-- The PayPal invariant counted the whole deposit; a bank deposit may first fill a shortfall.
ALTER TABLE fleet_capital_backings DROP CONSTRAINT fleet_capital_backings_check;
ALTER TABLE fleet_capital_backings ADD CONSTRAINT fleet_capital_backings_check CHECK (shortfall_minor + backed_minor + excess_minor = net_minor);
ALTER TABLE fleet_capital_backings DROP CONSTRAINT fleet_capital_backings_check2;
ALTER TABLE fleet_capital_backings ADD CONSTRAINT fleet_capital_backings_check2 CHECK ((excess_minor + shortfall_minor > 0) = (excess_journal_id IS NOT NULL));

ALTER TABLE fleet_bank_transactions DROP CONSTRAINT fleet_bank_transactions_classified_check;
ALTER TABLE fleet_bank_transactions ADD CONSTRAINT fleet_bank_transactions_classified_check
  CHECK (classified IN ('card_charge','card_refund','transfer_in','transfer_out','owner_contribution','fee','explained','capital_backing'));

${BACKING}

-- ═══ 2. The owner's bank deposit: shortfall first, then the existing capital, then new owner funding ═══
CREATE OR REPLACE FUNCTION fleet_admin_location_contribution(p_txn uuid, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE t fleet_bank_transactions; v_j uuid; v_key text; v_ccy text; v_short bigint; v_unbacked bigint; v_fill bigint; v_backed bigint;
        v_excess bigint; v_id uuid;
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_treasury');
  -- One backing decision at a time (the unbacked amount is computed, then consumed) — the PayPal path's lock.
  PERFORM pg_advisory_xact_lock(hashtext('fleet_capital_backing'));
  SELECT * INTO t FROM fleet_bank_transactions WHERE txn_id = p_txn FOR UPDATE;
  IF NOT FOUND OR t.direction <> 'in' OR t.status <> 'settled' OR t.kind NOT IN ('transfer','other') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'a settled incoming bank transaction');
  END IF;
  IF t.classified IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ALREADY_CLASSIFIED', 'classified', t.classified); END IF;
  SELECT accounting_currency INTO v_ccy FROM fleet_economic_model WHERE id = 1;
  IF t.currency <> v_ccy THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_FX_REQUIRED', 'reason', 'the deposit is in ' || t.currency || ', the books in ' || v_ccy);
  END IF;
  v_key := 'bank:' || t.location_id || ':' || t.external_id;
  IF fleet_claim_taken(v_key) OR EXISTS (SELECT 1 FROM fleet_ledger_journal WHERE external_ref = v_key) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ALREADY_CLAIMED', 'reason', 'this deposit is already recorded (claim ' || v_key || ')');
  END IF;
  v_short := -LEAST(fleet_ledger_balance('${SHORTFALL_ACCOUNT}'), 0);
  v_unbacked := (fleet_capital_backing() ->> 'unbackedMinor')::bigint;
  v_fill := LEAST(t.amount_minor, v_short);
  v_backed := LEAST(t.amount_minor - v_fill, v_unbacked);
  v_excess := t.amount_minor - v_fill - v_backed;
  -- Money for the shortfall and anything beyond the unbacked capital is owner funding into unallocated cash (one journal);
  -- the shortfall settlement then moves what the shortfall needs. The backed part needs no entry: the books hold it.
  IF v_fill + v_excess > 0 THEN
    v_j := fleet_admin_record_owner_funding(v_fill + v_excess, v_key, p_actor, 'bank-contribution:' || t.txn_id);
    PERFORM fleet_treasury_shortfall_settle();
  END IF;
  IF v_backed > 0 THEN
    INSERT INTO fleet_capital_backings (claim_key, location_id, bank_txn_id, net_minor, shortfall_minor, backed_minor, excess_minor, excess_journal_id,
                                        unbacked_before, recorded_by)
      VALUES (v_key, t.location_id, t.txn_id, t.amount_minor, v_fill, v_backed, v_excess, v_j, v_unbacked, p_actor) RETURNING backing_id INTO v_id;
    PERFORM fleet_event('capital_backed', NULL, p_actor, jsonb_build_object('backingId', v_id, 'source', 'bank', 'locationId', t.location_id,
      'netMinor', t.amount_minor, 'shortfallMinor', v_fill, 'backedMinor', v_backed, 'excessMinor', v_excess, 'unbackedAfterMinor', v_unbacked - v_backed));
  END IF;
  UPDATE fleet_bank_transactions SET classified = CASE WHEN v_backed > 0 THEN 'capital_backing' ELSE 'owner_contribution' END,
         classified_by = p_actor, journal_id = v_j, updated_at = now() WHERE txn_id = t.txn_id;
  RETURN jsonb_build_object('ok', true, 'amountMinor', t.amount_minor, 'shortfallMinor', v_fill, 'backedMinor', v_backed, 'ownerFundingMinor', v_excess,
    'journalId', v_j, 'backingId', v_id, 'unbackedAfterMinor', v_unbacked - v_backed,
    'note', 'your deposit: an open shortfall first, then the capital the wallets already record (no second credit), the rest new owner funding (unallocated)');
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

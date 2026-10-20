/**
 * Schema v107 — booking the refund of an owner-proof order the owner's claim waits behind (2026-10-20, live: PayPal
 * completed Agent-1's £5 refund of the proof order, but recording it failed every pass with
 * "FLEET_LEDGER_NEGATIVE: account fleet:treasury:unallocated would be -2"; owner: "Yes, fix and install now").
 *
 * v106 let custody SEND that refund from cash committed to the owner's claim; the booking (`cx_paypal_refund_record`,
 * v76) still took the whole refund from `fleet:treasury:unallocated` (498p in the books: the rest of PayPal's cash is held
 * for the owner in `fleet:treasury:owner_reimbursable`, v69). Now, for that refund only — an owner-proof order with a live
 * owner claim decision (v106) — the part `unallocated` cannot cover comes from `owner_reimbursable` (the cash held for the
 * owner): D owner capital / C unallocated (what it holds) / C owner_reimbursable (the rest). What is owed to the owner
 * (`fleet:owner:payable`) is unchanged. Without the decision, or beyond the cash held for the owner, the booking still
 * fails as before (nothing is ever booked from cash the treasury does not hold).
 */
import { V76_SQL } from "./migrations-phase76.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));

const PROOF_REFUND = restate(V76_SQL, "cx_paypal_refund_record", [
  [`DECLARE v_px bigint; v_pj uuid; `, `DECLARE v_px bigint; v_pj uuid; v_fromun bigint; v_fromheld bigint; `],
  [`    IF v_px > 0 THEN
      v_pj := fleet_ledger_post(`, `    IF v_px > 0 THEN
      -- v107: the refund of an owner-proof order the owner's claim waits behind (v106) may use the cash held for the owner.
      PERFORM 1 FROM fleet_ledger_accounts WHERE account_id IN ('fleet:treasury:owner_reimbursable', 'fleet:treasury:unallocated') ORDER BY account_id FOR UPDATE;
      v_fromun := v_px; v_fromheld := 0;
      IF EXISTS (SELECT 1 FROM fleet_owner_claim_waits w JOIN fleet_customer_orders z ON z.order_id = w.order_id
                  WHERE z.checkout_id = c.checkout_id AND z.owner_proof AND w.ended_at IS NULL) THEN
        v_fromun := LEAST(v_px, GREATEST(0, fleet_ledger_balance('fleet:treasury:unallocated')));
        v_fromheld := LEAST(v_px - v_fromun, GREATEST(0, fleet_ledger_balance('fleet:treasury:owner_reimbursable')));
        v_fromun := v_px - v_fromheld;                     -- anything still uncovered stays on unallocated (and fails as before)
      END IF;
      v_pj := fleet_ledger_post(`],
  [`          jsonb_build_object('account', 'fleet:owner:capital', 'side', 'D', 'amount', v_px),
          jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', v_px)));`,
   `          jsonb_build_object('account', 'fleet:owner:capital', 'side', 'D', 'amount', v_px))
        || CASE WHEN v_fromun > 0 THEN jsonb_build_array(jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', v_fromun)) ELSE '[]'::jsonb END
        || CASE WHEN v_fromheld > 0 THEN jsonb_build_array(jsonb_build_object('account', 'fleet:treasury:owner_reimbursable', 'side', 'C', 'amount', v_fromheld)) ELSE '[]'::jsonb END);`],
]);

export const V107_SQL = `
${PROOF_REFUND}

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

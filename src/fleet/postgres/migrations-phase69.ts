/**
 * Schema v69 — owner-funded AI credit is reimbursable (owner decision, 2026-10-12).
 *
 * The owner buys the Fleet's AI provider credit (USD, recorded outside the GBP ledger since v21). Every AI charge moved its
 * cost from a wallet (or the treasury) into expense, while the money stayed in the treasury account — and nothing recorded
 * that the owner had paid it. Now each AI charge (inference, owner conversation, spend review, lesson review) also posts:
 *
 *   D fleet:treasury:owner_reimbursable   (treasury cash held for the owner — a partition, never allocatable)
 *   C fleet:owner:payable                  (owed to the owner for AI credit used)
 *
 * so the books keep the money the treasury still holds and show it as owed to the owner. The expense is recognised once, at
 * use; a credit purchase is never expensed and stays a USD provider event (no GBP asset, no exchange-rate revaluation: the
 * owner is owed the GBP cost charged at each call's controlled rate). The AI costs already charged before v69 are brought in
 * by one opening journal, which the owner records after the cutover (a migration never posts a journal; the rollout refuses
 * a migration that moves the ledger head). Paying the owner back is NOT part of this (it would be a separate, authorised owner withdrawal).
 *
 * The capital backing (v66) changes accordingly: AI costs no longer reduce what must be backed (they are owed to the owner
 * instead), so unbacked = capital recorded without money − backed, and the backing view shows the owner payable.
 */
import { V21_SQL } from "./migrations-phase21.js";
import { V62_SQL } from "./migrations-phase62.js";
import { V64_SQL } from "./migrations-phase64.js";
import { V65_SQL } from "./migrations-phase65.js";
import { V66_SQL, PROVIDER_PAID_KINDS, TREASURY_HELD_CLASSES } from "./migrations-phase66.js";
import { V68_SQL } from "./migrations-phase68.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');`;
export const EVENT_ROUTES_V69 = Object.freeze({ P3_SUMMARY: ["ai_credit_owner_payable_opened"] });
export const DASHBOARD_SENSITIVE_OPS_V69 = ["ai_credit_opening"] as const;
export const OPENING_KIND = "ai_credit_owner_payable_opening";
export const OWNER_PAYABLE_ACCOUNT = "fleet:owner:payable";
export const REIMBURSABLE_ACCOUNT = "fleet:treasury:owner_reimbursable";

const LEGS = `,
        jsonb_build_object('account', '${REIMBURSABLE_ACCOUNT}', 'side', 'D', 'amount', v_charge),
        jsonb_build_object('account', '${OWNER_PAYABLE_ACCOUNT}', 'side', 'C', 'amount', v_charge)))`;
/** Restate a function and append the reimbursable legs after each of its AI-charge posting arrays (counted exactly). */
function withLegs(src: string, name: string, closers: Array<[string, number]>): string {
  let body = restateRaw(src, name, []);
  for (const [closer, n] of closers) {
    const parts = body.split(closer);
    if (parts.length !== n + 1) throw new Error(`v69: ${name}: expected ${n} × ${closer.slice(0, 60)}, found ${parts.length - 1}`);
    body = parts.join(closer.replace(/\)\)\);?$/, (m) => m.endsWith(";") ? `)${LEGS};` : `)${LEGS}`));
  }
  return body;
}
const AGENT_CASH = `jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_cash'), 'side', 'C', 'amount', v_charge)));`;
const TREASURY = `jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', v_charge)));`;

const ROUTED = withLegs(V62_SQL, "svc_cognition_routed_record", [[AGENT_CASH, 1], [TREASURY, 1]]);
const LEGACY = withLegs(V21_SQL, "svc_cognition_record", [[AGENT_CASH, 1]]);
const SPEND_REVIEW = withLegs(V64_SQL, "fleet_spend_review_charge", [[TREASURY, 1]]);
const CONTROL = withLegs(V65_SQL, "fleet_control_charge", [[TREASURY, 1]]);

const DASH_CALL = restateRaw(V66_SQL, "dash_call", [
  [`'order_refund','capital_back',`, `'order_refund','capital_back',${q(DASHBOARD_SENSITIVE_OPS_V69)},`],
  [`      WHEN 'capital_back' THEN`, `      WHEN 'ai_credit_opening' THEN fleet_admin_ai_credit_opening('operator:owner')
      WHEN 'capital_back' THEN`],
]);
const EVENT_ROUTE = restateRaw(V68_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V69) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
]);

// The v66 backing: AI costs are owed to the owner now, so they no longer reduce what real money must back. The term keeps
// counting only AI cash that left the treasury-held accounts without the reimbursable legs (none after the opening journal).
const BACKING = restateRaw(V66_SQL, "fleet_capital_backing", [
  [`DECLARE v_virtual bigint; v_paid bigint;`, `DECLARE v_virtual bigint; v_paid bigint; v_payable bigint;`],
  [`  SELECT COALESCE(sum(p.amount_cents), 0) INTO v_paid FROM fleet_ledger_journal j JOIN fleet_ledger_postings p ON p.journal_id = j.journal_id
    JOIN fleet_ledger_accounts a ON a.account_id = p.account_id
   WHERE j.kind IN (${q(PROVIDER_PAID_KINDS)}) AND p.side = 'C' AND a.class IN (${q(TREASURY_HELD_CLASSES)});`,
   `  SELECT COALESCE(sum(CASE WHEN p.side = 'C' THEN p.amount_cents ELSE -p.amount_cents END), 0) INTO v_paid
    FROM fleet_ledger_journal j JOIN fleet_ledger_postings p ON p.journal_id = j.journal_id JOIN fleet_ledger_accounts a ON a.account_id = p.account_id
   WHERE j.kind IN (${q([...PROVIDER_PAID_KINDS, OPENING_KIND])}) AND a.class IN (${q(TREASURY_HELD_CLASSES)});
  v_paid := GREATEST(v_paid, 0);
  v_payable := fleet_ledger_balance('${OWNER_PAYABLE_ACCOUNT}');`],
  [`'booksCashMinor', v_books,`, `'booksCashMinor', v_books, 'ownerPayableMinor', v_payable,`],
]);

export const V69_SQL = `
INSERT INTO fleet_ledger_classes (class, kind, normal_side, scope, non_negative, description) VALUES
  ('owner_payable', 'liability', 'C', 'fleet', true, 'Owed to the owner: AI provider credit the owner paid for and the Fleet used (reimbursable)');
INSERT INTO fleet_ledger_accounts (account_id, class, description, created_by) VALUES
  ('${OWNER_PAYABLE_ACCOUNT}', 'owner_payable', 'Owed to the owner for AI credit used (reimbursable)', 'migration'),
  ('${REIMBURSABLE_ACCOUNT}', 'treasury_cash', 'Treasury cash held for the owner''s AI-credit reimbursement (never allocatable)', 'migration');

ALTER TABLE fleet_ledger_kinds DISABLE TRIGGER fleet_ledger_kinds_no_change;
INSERT INTO fleet_ledger_kinds (kind, requires_external_ref, allowed_sources, multi_agent, description, provenance) VALUES
  ('${OPENING_KIND}', false, ARRAY['owner'], false, 'AI costs charged before v69, paid from the owner''s provider credit: owed to the owner (reimbursable)', 'correction');
ALTER TABLE fleet_ledger_kinds ENABLE TRIGGER fleet_ledger_kinds_no_change;
INSERT INTO fleet_ledger_rules (kind, class, side) VALUES
${[...PROVIDER_PAID_KINDS, OPENING_KIND].map((k) => `  ('${k}','treasury_cash','D'), ('${k}','owner_payable','C')`).join(",\n")}
ON CONFLICT DO NOTHING;

${ROUTED}

${LEGACY}

${SPEND_REVIEW}

${CONTROL}

${BACKING}

-- Opening (owner action after the cutover — a migration never posts a journal): the AI costs already charged before v69
-- (cash that left the treasury-held accounts without the reimbursable legs) become owed to the owner. Idempotent.
CREATE FUNCTION fleet_admin_ai_credit_opening(p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v bigint; v_j uuid;
BEGIN
  ${OWNER_ACTOR}
  IF EXISTS (SELECT 1 FROM fleet_ledger_journal WHERE kind = '${OPENING_KIND}') THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'ownerPayableMinor', fleet_ledger_balance('${OWNER_PAYABLE_ACCOUNT}'));
  END IF;
  SELECT COALESCE(sum(p.amount_cents), 0) INTO v FROM fleet_ledger_journal j JOIN fleet_ledger_postings p ON p.journal_id = j.journal_id
    JOIN fleet_ledger_accounts a ON a.account_id = p.account_id
   WHERE j.kind IN (${q(PROVIDER_PAID_KINDS)}) AND p.side = 'C' AND a.class IN (${q(TREASURY_HELD_CLASSES)})
     AND NOT EXISTS (SELECT 1 FROM fleet_ledger_postings r WHERE r.journal_id = j.journal_id AND r.account_id = '${OWNER_PAYABLE_ACCOUNT}');
  IF v = 0 THEN RETURN jsonb_build_object('ok', true, 'amountMinor', 0, 'note', 'no AI costs before v69'); END IF;
  v_j := fleet_ledger_post('${OPENING_KIND}', 'ai-credit-owner-payable-opening:v69', p_actor,
    'AI costs charged before v69 were paid from the owner''s provider credit: owed to the owner (reimbursable)', 'owner',
    NULL, NULL, NULL, NULL, NULL, now(), jsonb_build_array(
      jsonb_build_object('account', '${REIMBURSABLE_ACCOUNT}', 'side', 'D', 'amount', v),
      jsonb_build_object('account', '${OWNER_PAYABLE_ACCOUNT}', 'side', 'C', 'amount', v)));
  PERFORM fleet_event('ai_credit_owner_payable_opened', NULL, p_actor, jsonb_build_object('journalId', v_j, 'amountMinor', v));
  RETURN jsonb_build_object('ok', true, 'journalId', v_j, 'amountMinor', v, 'ownerPayableMinor', fleet_ledger_balance('${OWNER_PAYABLE_ACCOUNT}'));
END $$;

${DASH_CALL}

${EVENT_ROUTE}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

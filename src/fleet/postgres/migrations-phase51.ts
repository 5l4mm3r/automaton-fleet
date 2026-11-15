/**
 * Schema v51 — the completion pass (docs/design/master-launch-specification.md, revision 2). Nothing here moves real money
 * at migration time, connects a provider or turns a switch on.
 *
 * 1. EXHAUSTION IS DEATH. v50's indefinite dormancy is removed. One authoritative wallet measure
 *    (fleet_agent_wallet_measure): spendable = max(0, min(cash, survival equity)); the agent's own money that is only
 *    temporarily held (own-funded card holds, PayPal captures awaiting availability, money paid to the owner's card and
 *    invoiced) still counts as the agent's; open or approved checkouts, unsettled provider sales and Fleet envelope
 *    capital do not. An active agent with nothing spendable and nothing of its own held dies at the next lifecycle pass
 *    (cause `insolvent`, the existing estate flow). The pass locks the agent and its accounts, so a receipt or allocation
 *    that commits first keeps it alive and none can land half-way. No grace period, no rescue; an owner hold still pauses
 *    the reaper for that agent (an explicit owner action).
 * 2. CARD HOLDS RESERVE FIRST; NO TREASURY OVERDRAFT. card.authorize reserves the hold maximum from the agent's own
 *    spendable capital or from an active Fleet envelope (a recorded Fleet Control allocation) before the card can be
 *    filled; otherwise it is refused. Booking uses the reservation and releases the rest. A charge larger than its
 *    reservation (the owner's statement) takes the agent's cash, then its envelope, and only then is ADVANCED by the
 *    treasury against the agent's payable — a debt that lowers its survival equity, never a gift. Expense is booked once.
 * 3. CARD RECEIPTS SETTLE TRUTHFULLY. The owner's invoice and choice (return or permanent withdrawal) stay; the return can
 *    now be "applied to the card balance" (the receipt reduced what the fleet owes the card, so the reserve is released)
 *    or "transferred" (the money reached the owner and is sent back). The swept share stays net-profit-only and is recorded
 *    as the agent's contribution, so the daily sweep never takes it twice.
 * 4. PAYPAL MONEY STATES. A completed capture is the agent's revenue at once but its cash is `agent_cash_pending` (held,
 *    owned, not spendable) until PayPal's own evidence shows it available: the capture in Transaction Search with status
 *    S, and the latest Balances observation's available balance covering what is released. A refund comes out of the held
 *    money first. Verified sales, captures, held funds, received funds and available capital are reported separately.
 * 5. CUSTODY ACTIVATION: PILOT OR ONGOING. A pilot activation expires (≤ 90 days); an ongoing activation has no expiry and
 *    runs until the owner ends it. Both carry per-instruction and 24 h maxima (treasury risk limits, not approvals).
 * 6. FLEET CONTROL DECIDES AUTOMATICALLY. Capital decisions also weigh the agent's runway (including its commitments)
 *    against the plan's payback; sweep-reduction requests are decided at once by deterministic policy (profit to retain, an
 *    active venture), and the owner can still end or grant one.
 * 7. DOCUMENTS UNDER THE STANDING AUTHORITY. The owner may let agents have identity documents (passport, licence, ID,
 *    proof of address) uploaded into a provider's own form: browser step `upload` with credential `owner_document`. The
 *    broker seals the file to the worker's one-time key; the agent never sees it; every use is logged.
 * 8. FREEZE STOPS LOCAL USE. Freezing also cancels the account's queued identity jobs and refuses new ones. It does not
 *    close or cancel the account at the provider.
 * 9. KNOWLEDGE REVISION 2: hard rules only where law, a regulator or a platform's terms require them (named), the rest as
 *    recommendations; no invented "one account per platform" rule.
 * 10. COMMUNICATIONS ONBOARDING. The dashboard can seal a mail or SMS provider secret (Proton Mail Bridge, Twilio) to the
 *    identity broker's key; the broker installs it and starts the provider.
 */
import { KNOWLEDGE_LIBRARY_V2 as LIBRARY2 } from "./knowledge-library-v2.js";
import { V30_SQL } from "./migrations-phase30.js";
import { V36_SQL } from "./migrations-phase36.js";
import { V42_SQL } from "./migrations-phase42.js";
import { V47_SQL } from "./migrations-phase47.js";
import { CASH_CLASSES, V48_SQL } from "./migrations-phase48.js";
import { CARD_FIELDS, FILLABLE_CLASSES, V49_SQL } from "./migrations-phase49.js";
import { V50_SQL } from "./migrations-phase50.js";
import { restate as restateRaw } from "./migrations-phase42.js";

/** restate() applies String.replace: every literal "$" of a replacement is escaped ("$'" would splice in the text after the match). */
const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));
/** A function restated with one text replaced everywhere it occurs (at least once). */
function restateAll(src: string, name: string, from: string, to: string): string {
  const body = restateRaw(src, name, []);
  if (!body.includes(from)) throw new Error(`v51: ${name}: text not found: ${from.slice(0, 60)}`);
  return body.split(from).join(to);
}

export const EVENT_ROUTES_V51 = Object.freeze({
  P1_HIGH: ["agent_wallet_exhausted", "card_charge_advanced", "paypal_availability_short", "identity_documents_set", "provider_secret_uploaded"],
  P2_IMPORTANT: ["paypal_funds_available", "card_receipt_applied", "sweep_reduction_decided", "provider_secret_installed"],
  AGENT_ACTIVITY_ONLY: ["card_hold_reserved", "card_hold_released"],
} as const);

/** Owner documents a form may receive by upload (never shown to an agent). */
export const DOCUMENT_CLASSES = ["id_document", "passport", "driving_licence", "proof_of_address"] as const;
export const DASHBOARD_READ_OPS_V51 = ["wallet_measure", "money_states", "provider_secrets"] as const;
export const DASHBOARD_SENSITIVE_OPS_V51 = ["card_receipt_settle", "identity_documents_set", "provider_secret_upload"] as const;
/** Provider secrets the dashboard may seal to the identity broker. */
export const PROVIDER_SECRET_UPLOADS = ["proton-bridge", "twilio"] as const;
/** The real-money classes, now including captured PayPal money that is held until available. */
export const CASH_CLASSES_V51 = [...CASH_CLASSES, "agent_cash_pending"] as const;

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const lit = (v: unknown) => `'${JSON.stringify(v).replace(/'/g, "''")}'`;
const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;`;
const TREASURY_OWNER = `${OWNER_ACTOR}
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');`;
const WORKER = `IF p_worker IS NULL OR p_worker !~ '^[a-z0-9-]{3,40}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: worker name'; END IF;`;
const IXWORKER = `IF p_worker IS NULL OR p_worker !~ '^[a-z0-9_.-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: worker name'; END IF;`;
const PAYPAL_ID = `'^[A-Z0-9]{5,40}$'`;
const OLD_CASH = q(CASH_CLASSES);
const NEW_CASH = q(CASH_CLASSES_V51);

// ── Restatements ──
// Own-funded card holds are the agent's money, only temporarily held: they count towards survival equity.
const ECONOMICS = restate(V47_SQL, "fleet_agent_economics", [
  [`        v_contrib bigint; v_inv bigint; v_rec bigint; v_eq bigint; v_net bigint; v_res_rec bigint; v_genesis bigint; v_granted bigint; v_transfers bigint;`,
   `        v_contrib bigint; v_inv bigint; v_rec bigint; v_eq bigint; v_net bigint; v_res_rec bigint; v_genesis bigint; v_granted bigint; v_transfers bigint;
        v_holds bigint; v_pending bigint;`],
  [`  v_rec := v_cash + v_res_rec + v_assets_rec + v_escrow;`,
   `  -- v51: own-funded card holds (reserved, not yet charged) remain the agent's own money.
  SELECT COALESCE(sum(reserved_minor), 0) INTO v_holds FROM fleet_card_charges WHERE agent_id = p_agent AND status = 'held' AND funding = 'own';
  v_pending := COALESCE((SELECT fleet_ledger_balance(account_id) FROM fleet_ledger_accounts WHERE agent_id = p_agent AND class = 'agent_cash_pending'), 0);
  v_rec := v_cash + v_res_rec + v_assets_rec + v_escrow + v_holds;`],
  [`'profitDistributedOut', v_dout, 'profitDistributionsIn', v_din, 'providerPayable', v_payable);`,
   `'profitDistributedOut', v_dout, 'profitDistributionsIn', v_din, 'providerPayable', v_payable,
    'cardHoldsReserved', v_holds, 'cashPendingAvailability', v_pending);`],
]);

const SURVIVAL = restate(V50_SQL, "fleet_survival_observation", [
  [`    'burnBasis', 'inference over the last 7 days plus active recurring commitments')`,
   `    'burnBasis', 'inference over the last 7 days plus active recurring commitments',
    'wallet', fleet_agent_wallet_measure(p_agent))`],
]);

// Envelope capital committed to card holds and charges counts against the envelope like its orders.
const ENVELOPE_POSITION = restate(V42_SQL, "fleet_envelope_position", [
  [`                FROM fleet_projects WHERE envelope_id = e.envelope_id),`,
   `                FROM fleet_projects WHERE envelope_id = e.envelope_id),
       cc AS (SELECT COALESCE(sum(reserved_minor) FILTER (WHERE status = 'held'), 0) AS reserved,
                     COALESCE(sum(envelope_part_minor) FILTER (WHERE status IN ('booked','confirmed')), 0) AS spent
                FROM fleet_card_charges WHERE envelope_id = e.envelope_id),`],
  [`    'reservedMinor', o.reserved + pj.held, 'spentMinor', o.spent + pj.paid, 'projectEscrowMinor', pj.held, 'projectPaidMinor', pj.paid,
    'availableMinor', e.allocated_minor - e.returned_minor - o.reserved - o.spent - pj.held - pj.paid - pj.back,
    'revenueSinceMinor', rv.revenue, 'lossMinor', GREATEST(0, o.spent + pj.paid - rv.revenue), 'maxLossMinor', e.max_loss_minor)
  FROM o, rv, pj`,
   `    'reservedMinor', o.reserved + pj.held + cc.reserved, 'spentMinor', o.spent + pj.paid + cc.spent, 'projectEscrowMinor', pj.held, 'projectPaidMinor', pj.paid,
    'cardReservedMinor', cc.reserved, 'cardSpentMinor', cc.spent,
    'availableMinor', e.allocated_minor - e.returned_minor - o.reserved - o.spent - pj.held - pj.paid - pj.back - cc.reserved - cc.spent,
    'revenueSinceMinor', rv.revenue, 'lossMinor', GREATEST(0, o.spent + pj.paid + cc.spent - rv.revenue), 'maxLossMinor', e.max_loss_minor)
  FROM o, rv, pj, cc`],
]);

// Capital decisions also weigh the agent's runway (inference plus commitments) against the plan's payback.
const CAPITAL_DECIDE = restate(V30_SQL, "fleet_capital_decide", [
  [`        v_reasons jsonb := '[]'::jsonb; v_outcome text; v_amount bigint; v_limits boolean := false; v_failed integer; v_profitable integer;`,
   `        v_reasons jsonb := '[]'::jsonb; v_outcome text; v_amount bigint; v_limits boolean := false; v_failed integer; v_profitable integer;
        obs jsonb; v_runway numeric; v_short boolean := false;`],
  [`    v_limits := q.confidence_bp < p.min_confidence_bp OR (v_measured >= p.min_track_record AND v_failed > v_profitable);`,
   `    -- v51: a plan that pays back later than the agent's own runway (inference plus commitments) gets bounded terms.
    obs := fleet_survival_observation(q.agent_id);
    v_runway := (obs ->> 'runwayDays')::numeric;
    v_short := q.expected_payback_days IS NOT NULL AND v_runway IS NOT NULL AND v_runway < q.expected_payback_days;
    v_limits := q.confidence_bp < p.min_confidence_bp OR (v_measured >= p.min_track_record AND v_failed > v_profitable) OR v_short;`],
  [`      v_reasons := v_reasons || CASE WHEN q.confidence_bp < p.min_confidence_bp THEN '"LOW_CONFIDENCE"' ELSE '"WEAK_TRACK_RECORD"' END::jsonb;`,
   `      v_reasons := v_reasons || CASE WHEN q.confidence_bp < p.min_confidence_bp THEN '"LOW_CONFIDENCE"' WHEN v_short THEN '"RUNWAY_SHORTER_THAN_PAYBACK"' ELSE '"WEAK_TRACK_RECORD"' END::jsonb;`],
  [`      'evidenceItems', jsonb_array_length(q.evidence)));`,
   `      'evidenceItems', jsonb_array_length(q.evidence), 'agentRunwayDays', v_runway, 'commitmentsPerDayCents', obs -> 'commitmentsPerDayCents',
      'trackRecordRequired', false));`],
]);

const CUSTODY_LIVE = restate(V48_SQL, "fleet_custody_activation_live", [
  [`AND a.ended_at IS NULL AND a.expires_at > now()`, `AND a.ended_at IS NULL AND (a.expires_at IS NULL OR a.expires_at > now())`],
]);
const CUSTODY_EXPIRE = restate(V48_SQL, "svc_custody_activation_expire", [
  [`  IF a.ended_at IS NULL AND a.expires_at > now() THEN RETURN jsonb_build_object('ok', true, 'active', true, 'expiresAt', a.expires_at); END IF;`,
   `  IF a.ended_at IS NULL AND (a.expires_at IS NULL OR a.expires_at > now()) THEN
    RETURN jsonb_build_object('ok', true, 'active', true, 'mode', a.mode, 'expiresAt', a.expires_at);
  END IF;`],
]);
const CUSTODY_STATUS = restate(V48_SQL, "fleet_custody_status", [
  [`'grantedAt', a.granted_at, 'expiresAt', a.expires_at,`, `'grantedAt', a.granted_at, 'expiresAt', a.expires_at, 'mode', a.mode,`],
]);
const WALLET_LIMITS = restate(V48_SQL, "fleet_wallet_limits_json", [
  [`'maxDailyMinor', a.max_daily_minor, 'expiresAt', a.expires_at)`, `'maxDailyMinor', a.max_daily_minor, 'expiresAt', a.expires_at, 'mode', a.mode)`],
]);

const AUTONOMY_JSON = restate(V49_SQL, "fleet_identity_autonomy_json", [
  [`    'fillableClasses', to_jsonb(ARRAY[${q(FILLABLE_CLASSES)}]::text[]),`,
   `    'fillableClasses', to_jsonb(ARRAY[${q(FILLABLE_CLASSES)}]::text[]),
    'documentClasses', to_jsonb(a.document_classes), 'uploadableDocumentClasses', to_jsonb(ARRAY[${q(DOCUMENT_CLASSES)}]::text[]),`],
]);

const STEPS_VALID = restate(V49_SQL, "fleet_browser_steps_valid", [
  [`    IF v_a NOT IN ('goto','click','fill','select','check','press','wait','wait_for','open_auth_link','capture','back') THEN
      PERFORM fleet_econ_bad('action is goto|click|fill|select|check|press|wait|wait_for|open_auth_link|capture|back');
    END IF;`,
   `    IF v_a NOT IN ('goto','click','fill','select','check','press','wait','wait_for','open_auth_link','capture','back','upload') THEN
      PERFORM fleet_econ_bad('action is goto|click|fill|select|check|press|wait|wait_for|open_auth_link|capture|back|upload');
    END IF;
    -- v51: an owner document uploaded into the provider's own form (never shown to the agent).
    IF v_a = 'upload' AND (length(COALESCE(s ->> 'selector', '')) NOT BETWEEN 1 AND 300 OR COALESCE(s ->> 'credential', '') <> 'owner_document'
        OR COALESCE(s ->> 'class', '') NOT IN (${q(DOCUMENT_CLASSES)}) OR NOT p_has_account) THEN
      PERFORM fleet_econ_bad('upload needs an account session, a selector (the file input), credential owner_document and class ${DOCUMENT_CLASSES.join("|")}');
    END IF;`],
]);

const SECRET_REQUEST = restate(V49_SQL, "bx_secret_request", [
  [`  IF p_kind LIKE 'owner_fact:%' OR p_kind LIKE 'owner_card:%' THEN`,
   `  IF p_kind LIKE 'owner_fact:%' OR p_kind LIKE 'owner_card:%' OR p_kind LIKE 'owner_document:%' THEN`],
  [`    v_field := NULLIF(CASE WHEN v_kind = 'owner_card' THEN split_part(p_kind, ':', 2) ELSE split_part(p_kind, ':', 3) END, '');`,
   `    v_field := NULLIF(CASE WHEN v_kind = 'owner_card' THEN split_part(p_kind, ':', 2) WHEN v_kind = 'owner_document' THEN '' ELSE split_part(p_kind, ':', 3) END, '');`],
  [`       OR (v_kind = 'owner_fact' AND NOT (v_class = ANY (au.classes))) OR (v_kind = 'owner_card' AND NOT au.card_enabled) THEN`,
   `       OR (v_kind = 'owner_fact' AND NOT (v_class = ANY (au.classes))) OR (v_kind = 'owner_card' AND NOT au.card_enabled)
       OR (v_kind = 'owner_document' AND NOT (v_class = ANY (au.document_classes))) THEN`],
  [`       OR (v_kind = 'owner_card' AND COALESCE(v_field, '') NOT IN (${q(CARD_FIELDS)})) THEN`,
   `       OR (v_kind = 'owner_card' AND COALESCE(v_field, '') NOT IN (${q(CARD_FIELDS)}))
       OR (v_kind = 'owner_document' AND v_class NOT IN (${q(DOCUMENT_CLASSES)})) THEN`],
]);

const ACCOUNT_FREEZE = restate(V49_SQL, "fleet_admin_account_freeze", [
  [`  GET DIAGNOSTICS n = ROW_COUNT;`,
   `  GET DIAGNOSTICS n = ROW_COUNT;
  -- v51: the account's queued and waiting identity jobs stop too (nothing more is done with it locally).
  UPDATE fleet_identity_jobs SET status = 'failed', finished_at = now(), result = jsonb_build_object('status', 'failed', 'code', 'FLEET_ACCOUNT_FROZEN')
   WHERE account_id = p_account AND status IN ('queued','pending');`],
  [`    'note', 'nothing is served for this account any more; close it at the provider with the revealed credentials if needed');`,
   `    'note', 'the fleet no longer uses this account (no credential, owner value or session is served and queued jobs are stopped). '
         || 'This does not close or cancel it at the provider: use the provider link and the revealed credentials to do that.');`],
]);

// Agents cannot queue identity jobs for an account the owner froze.
const IDENTITY_ENQUEUE = restate(V36_SQL, "fleet_identity_enqueue", [
  [`  IF p_kind NOT IN ('mail.send','sms.send') AND (SELECT count(*)`,
   `  IF p_account IS NOT NULL AND EXISTS (SELECT 1 FROM fleet_agent_accounts WHERE account_id = p_account AND status = 'frozen') THEN
    RAISE EXCEPTION 'FLEET_ACCOUNT_FROZEN: the owner froze this account';
  END IF;
  IF p_kind NOT IN ('mail.send','sms.send') AND (SELECT count(*)`],
]);

const SWEEP_REQUEST = restate(V50_SQL, "fleet_econ_sweep_reduction_request", [
  [`DECLARE v_bp integer; v_days integer; v_reason text := fleet_econ_text(a, 'reason', 1000, true); v_id uuid;`,
   `DECLARE v_bp integer; v_days integer; v_reason text := fleet_econ_text(a, 'reason', 1000, true); v_id uuid; d jsonb;`],
  [`  PERFORM fleet_event('sweep_reduction_requested', p_agent, p_agent, jsonb_build_object('requestId', v_id, 'reductionBp', v_bp, 'days', v_days));
  RETURN jsonb_build_object('ok', true, 'requestId', v_id, 'status', 'pending', 'note', 'Fleet Control decides; the sweep stays on net profit only');`,
   `  PERFORM fleet_event('sweep_reduction_requested', p_agent, p_agent, jsonb_build_object('requestId', v_id, 'reductionBp', v_bp, 'days', v_days));
  -- v51: Fleet Control decides at once (deterministic; the owner can still end or grant a reduction).
  d := fleet_sweep_reduction_decide(v_id);
  RETURN jsonb_build_object('ok', true, 'requestId', v_id) || d || jsonb_build_object('note', 'decided by Fleet Control; the sweep stays on net profit only');`],
]);

const TREASURY_TXNS = restateAll(V48_SQL, "fleet_treasury_transactions", OLD_CASH, NEW_CASH);
const TREASURY_HEALTH = restate(restateAll(V48_SQL, "fleet_treasury_health", OLD_CASH, NEW_CASH).replace(/^CREATE OR REPLACE /, "CREATE "), "fleet_treasury_health", [
  [`      'cardReserveMinor', fleet_ledger_balance('fleet:card:reserve')),`,
   `      'cardReserveMinor', fleet_ledger_balance('fleet:card:reserve'),
      'heldPendingAvailabilityMinor', (SELECT COALESCE(sum(fleet_ledger_balance(account_id)), 0) FROM fleet_ledger_accounts WHERE class = 'agent_cash_pending')),
    'moneyStates', fleet_money_states(),`],
]);

const WALLET = restate(V47_SQL, "fleet_agent_wallet", [
  [`    'providerPending', fleet_agent_provider_memo(p_agent),`,
   `    'providerPending', fleet_agent_provider_memo(p_agent),
    -- v51: captured PayPal money awaiting PayPal's availability evidence (owned, not yet spendable), own card holds, and the
    -- authoritative exhaustion measure.
    'cashPendingAvailabilityMinor', COALESCE((eco ->> 'cashPendingAvailability')::bigint, 0),
    'cardHoldsMinor', COALESCE((eco ->> 'cardHoldsReserved')::bigint, 0),
    'measure', fleet_agent_wallet_measure(p_agent),`],
]);

const DISPATCH = restate(V50_SQL, "api_economy", [
  [`WHEN 'knowledge.library' THEN 'knowledge.read'`, `WHEN 'wallet.measure' THEN 'ledger.read' WHEN 'knowledge.library' THEN 'knowledge.read'`],
  [`      WHEN 'knowledge.library' THEN fleet_econ_knowledge_library(p_agent, a)`,
   `      WHEN 'wallet.measure' THEN jsonb_build_object('ok', true) || fleet_agent_wallet_measure(p_agent)
      WHEN 'knowledge.library' THEN fleet_econ_knowledge_library(p_agent, a)`],
]);

const DASH_CALL = restate(V50_SQL, "dash_call", [
  [`'sweep_reduction_decline','paypal_txn_attribute');`, `'sweep_reduction_decline','paypal_txn_attribute',${q(DASHBOARD_SENSITIVE_OPS_V51)});`],
  [`'insolvency','sweep_reductions','knowledge_library')) THEN`, `'insolvency','sweep_reductions','knowledge_library',${q(DASHBOARD_READ_OPS_V51)})) THEN`],
  [`      WHEN 'knowledge_library' THEN fleet_knowledge_library_search(a ->> 'query', a ->> 'category', COALESCE((a ->> 'limit')::integer, 20), true)`,
   `      WHEN 'knowledge_library' THEN fleet_knowledge_library_search(a ->> 'query', a ->> 'category', COALESCE((a ->> 'limit')::integer, 20), true)
      -- v51: the wallet measure, money states, provider-secret uploads
      WHEN 'wallet_measure' THEN CASE WHEN a ? 'agentId' THEN fleet_agent_wallet_measure(a ->> 'agentId') ELSE fleet_wallet_measures() END
      WHEN 'money_states' THEN fleet_money_states()
      WHEN 'provider_secrets' THEN fleet_provider_secrets_json()`],
  [`      WHEN 'custody_activate' THEN fleet_admin_custody_activate((a ->> 'maxInstructionMinor')::bigint, (a ->> 'maxDailyMinor')::bigint, (a ->> 'hours')::integer, a ->> 'reason', 'operator:owner')`,
   `      WHEN 'custody_activate' THEN fleet_admin_custody_activate((a ->> 'maxInstructionMinor')::bigint, (a ->> 'maxDailyMinor')::bigint,
          CASE WHEN a ->> 'mode' = 'ongoing' THEN NULL ELSE COALESCE((a ->> 'hours')::integer, 0) END, a ->> 'reason', 'operator:owner')`],
  [`      WHEN 'card_receipt_resolve' THEN`,
   `      WHEN 'card_receipt_settle' THEN fleet_admin_card_receipt_settle((a ->> 'receiptId')::uuid, a ->> 'resolution', COALESCE(a ->> 'method', 'transfer'),
          (a ->> 'sweepMinor')::bigint, a ->> 'reference', 'operator:owner')
      WHEN 'identity_documents_set' THEN fleet_admin_identity_documents_set(ARRAY(SELECT jsonb_array_elements_text(COALESCE(a -> 'classes', '[]'::jsonb))), 'operator:owner')
      WHEN 'provider_secret_upload' THEN fleet_admin_provider_secret_upload(a ->> 'name', decode(a ->> 'sealedB64', 'base64'), 'operator:owner')
      WHEN 'card_receipt_resolve' THEN`],
]);

const EVENT_ROUTE = restate(V50_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V51) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
]);

export const V51_SQL = `
-- ═══ 0. Ledger grammar ═══
INSERT INTO fleet_ledger_classes (class, kind, normal_side, scope, non_negative, description) VALUES
  ('agent_cash_pending', 'asset', 'D', 'agent', true, 'Customer money captured into the PayPal treasury for the agent, held until PayPal shows it available (owned, not spendable)');
INSERT INTO fleet_ledger_kinds (kind, requires_external_ref, allowed_sources, multi_agent, description, provenance) VALUES
  ('paypal_funds_available', true,  ARRAY['controller'],          false, 'Captured PayPal money becomes available capital on PayPal''s evidence', 'internal_transfer'),
  ('card_hold_reserve',      true,  ARRAY['controller'],          false, 'A card hold reserves its maximum from the agent''s own capital or its envelope', 'internal_transfer'),
  ('card_hold_release',      true,  ARRAY['controller','owner'],  false, 'An unused card reservation returns to where it came from', 'internal_transfer'),
  ('payable_repayment',      true,  ARRAY['controller'],          false, 'An agent repays its payable (a treasury advance) from money that became available', 'internal_transfer');
INSERT INTO fleet_ledger_rules (kind, class, side) VALUES
  ('paypal_receipt','agent_cash_pending','D'), ('paypal_clawback','agent_cash_pending','C'),
  ('paypal_funds_available','agent_cash','D'), ('paypal_funds_available','agent_cash_pending','C'),
  ('payable_repayment','agent_provider_payable','D'), ('payable_repayment','agent_cash','C'), ('payable_repayment','treasury_cash','D'), ('payable_repayment','provider_advances','C'),
  ('card_hold_reserve','agent_reserved','D'), ('card_hold_reserve','agent_cash','C'), ('card_hold_reserve','agent_envelope_cash','C'),
  ('card_hold_release','agent_reserved','C'), ('card_hold_release','agent_cash','D'), ('card_hold_release','agent_envelope_cash','D'),
  ('card_hold_release','treasury_cash','D'),
  ('card_charge','agent_reserved','C'), ('card_charge','agent_envelope_cash','C'), ('card_charge','agent_provider_payable','C'), ('card_charge','provider_advances','D'),
  ('card_charge_adjust','agent_reserved','C'), ('card_charge_adjust','agent_envelope_cash','C'), ('card_charge_adjust','agent_envelope_cash','D'),
  ('card_charge_adjust','agent_provider_payable','C'), ('card_charge_adjust','agent_provider_payable','D'),
  ('card_charge_adjust','provider_advances','D'), ('card_charge_adjust','provider_advances','C'),
  ('card_receipt_return','card_payable','D'), ('card_receipt_return','card_cash_reserve','C'),
  ('card_receipt_withdrawal','card_payable','D'), ('card_receipt_withdrawal','card_cash_reserve','C');

${restate(V48_SQL, "fleet_ledger_open_agent", [
  [`'agent_provider_payable','agent_card_receivable']`, `'agent_provider_payable','agent_card_receivable','agent_cash_pending']`],
])}
SELECT fleet_ledger_open_agent(agent_id, 'migration') FROM fleet_ledger_accounts WHERE class = 'agent_cash' GROUP BY agent_id;

-- ═══ 1. Card holds reserve first; no treasury overdraft ═══
ALTER TABLE fleet_card_charges
  ADD COLUMN funding             text    NOT NULL DEFAULT 'own' CHECK (funding IN ('own','envelope')),
  ADD COLUMN envelope_id         uuid    REFERENCES fleet_envelopes(envelope_id),
  ADD COLUMN reserved_minor      bigint  NOT NULL DEFAULT 0 CHECK (reserved_minor >= 0),
  ADD COLUMN envelope_part_minor bigint  NOT NULL DEFAULT 0 CHECK (envelope_part_minor >= 0),
  ADD COLUMN reserve_journal_id  uuid    REFERENCES fleet_ledger_journal(journal_id),
  ADD COLUMN release_journal_id  uuid    REFERENCES fleet_ledger_journal(journal_id),
  ADD CONSTRAINT fleet_card_charges_funding_envelope CHECK ((funding = 'envelope') = (envelope_id IS NOT NULL));
ALTER TABLE fleet_card_charges DROP CONSTRAINT fleet_card_charges_check;
ALTER TABLE fleet_card_charges ADD CONSTRAINT fleet_card_charges_parts
  CHECK (status = 'held' OR status = 'void' OR (amount_minor IS NOT NULL AND agent_part_minor + envelope_part_minor + treasury_part_minor = amount_minor));
COMMENT ON COLUMN fleet_card_charges.treasury_part_minor IS 'v51: the part the treasury ADVANCED against the agent''s payable (a debt the agent repays from later receipts)';

CREATE OR REPLACE FUNCTION fleet_card_charges_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.charge_id <> OLD.charge_id OR NEW.agent_id <> OLD.agent_id OR NEW.created_at <> OLD.created_at OR NEW.source <> OLD.source
     OR NEW.origin IS DISTINCT FROM OLD.origin OR NEW.hold_max_minor IS DISTINCT FROM OLD.hold_max_minor
     OR NEW.funding <> OLD.funding OR NEW.envelope_id IS DISTINCT FROM OLD.envelope_id
     OR (OLD.reserve_journal_id IS NOT NULL AND NEW.reserve_journal_id IS DISTINCT FROM OLD.reserve_journal_id) THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a card charge''s agent, source, origin, hold and funding are fixed';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'held' AND NEW.status IN ('booked','void','confirmed')) OR (OLD.status = 'booked' AND NEW.status = 'confirmed')) THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: card charge % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION fleet_card_charge_json(c fleet_card_charges) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('chargeId', c.charge_id, 'merchant', c.merchant, 'origin', c.origin, 'status', c.status, 'holdMaxMinor', c.hold_max_minor,
    'funding', c.funding, 'envelopeId', c.envelope_id, 'reservedMinor', NULLIF(c.reserved_minor, 0),
    'amountMinor', c.amount_minor, 'fromYourCashMinor', c.agent_part_minor, 'fromEnvelopeMinor', NULLIF(c.envelope_part_minor, 0),
    'advancedAgainstYourPayableMinor', NULLIF(c.treasury_part_minor, 0), 'declareBy', c.declare_by,
    'used', EXISTS (SELECT 1 FROM fleet_identity_uses u WHERE u.charge_id = c.charge_id), 'createdAt', c.created_at))
$$;

-- An envelope that can still pay for the agent's card (Fleet capital allocated by Fleet Control); NULL when not usable.
CREATE FUNCTION fleet_card_envelope_open(p_agent text, p_envelope uuid) RETURNS fleet_envelopes LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE e fleet_envelopes;
BEGIN
  IF p_envelope IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO e FROM fleet_envelopes WHERE envelope_id = p_envelope AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  e := fleet_envelope_evaluate(e.envelope_id, 'controller');
  IF e.status <> 'active' OR NOT ('expense' = ANY (e.categories)) THEN RETURN NULL; END IF;
  RETURN e;
END $$;

-- Release what is left of a hold's reservation to where it came from (own cash, the envelope, or the treasury once the
-- envelope has closed).
CREATE FUNCTION fleet_card_hold_release(p_charge uuid, p_amount bigint, p_actor text, p_source text) RETURNS uuid LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE ch fleet_card_charges; v_to text; v_j uuid;
BEGIN
  SELECT * INTO ch FROM fleet_card_charges WHERE charge_id = p_charge FOR UPDATE;
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN NULL; END IF;
  IF p_amount > ch.reserved_minor THEN RAISE EXCEPTION 'FLEET_LEDGER_INVALID: release beyond the reservation'; END IF;
  v_to := CASE WHEN ch.funding = 'own' THEN fleet_ledger_account(ch.agent_id, 'agent_cash')
               WHEN EXISTS (SELECT 1 FROM fleet_envelopes WHERE envelope_id = ch.envelope_id AND status = 'active') THEN fleet_ledger_account(ch.agent_id, 'agent_envelope_cash')
               ELSE 'fleet:treasury:unallocated' END;
  v_j := fleet_ledger_post('card_hold_release', 'card:' || ch.charge_id || ':release:' || ch.reserved_minor || ':' || p_amount, p_actor,
    'unused card reservation released', p_source, ch.agent_id, NULL, NULL, 'card:' || ch.charge_id, NULL, now(), jsonb_build_array(
      jsonb_build_object('account', v_to, 'side', 'D', 'amount', p_amount),
      jsonb_build_object('account', fleet_ledger_account(ch.agent_id, 'agent_reserved'), 'side', 'C', 'amount', p_amount)));
  UPDATE fleet_card_charges SET reserved_minor = reserved_minor - p_amount, release_journal_id = v_j WHERE charge_id = p_charge;
  PERFORM fleet_event('card_hold_released', ch.agent_id, left(p_actor, 128), jsonb_build_object('chargeId', ch.charge_id, 'amountMinor', p_amount,
    'to', CASE WHEN v_to LIKE 'fleet:%' THEN 'treasury' WHEN ch.funding = 'own' THEN 'cash' ELSE 'envelope' END));
  RETURN v_j;
END $$;

-- Book a charge at an amount (first booking, or a correction to the statement amount). The reservation pays first and the
-- rest of it is released; anything beyond it comes from the agent's spendable cash, then its envelope (if the hold was
-- envelope-funded and the envelope is active), and only then is advanced by the treasury against the agent's payable —
-- a debt, which lowers its survival equity. A reduction gives back in the reverse order. The whole amount moves into the
-- card reserve against the card liability; the expense is booked once.
CREATE OR REPLACE FUNCTION fleet_card_charge_post(p_charge uuid, p_amount bigint, p_idem text, p_source text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE ch fleet_card_charges; e fleet_envelopes; eco jsonb; d bigint; rem bigint; v_res bigint := 0; v_own bigint := 0; v_env bigint := 0; v_adv bigint := 0;
        v_avail bigint; v_epos bigint; v_lines jsonb := '[]'::jsonb; v_kind text; v_j uuid; v_pay bigint;
        x_adv bigint := 0; x_env bigint := 0; x_cash bigint := 0; x_from_agent bigint := 0; v_env_to text;
        dp_agent bigint := 0; dp_env bigint := 0; dp_tre bigint := 0;
        acct_cash text; acct_res text; acct_env text; acct_exp text; acct_pay text;
BEGIN
  SELECT * INTO ch FROM fleet_card_charges WHERE charge_id = p_charge FOR UPDATE;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a positive amount'; END IF;
  acct_cash := fleet_ledger_account(ch.agent_id, 'agent_cash'); acct_res := fleet_ledger_account(ch.agent_id, 'agent_reserved');
  acct_env := fleet_ledger_account(ch.agent_id, 'agent_envelope_cash'); acct_exp := fleet_ledger_account(ch.agent_id, 'agent_expense');
  acct_pay := fleet_ledger_account(ch.agent_id, 'agent_provider_payable');
  PERFORM 1 FROM fleet_ledger_accounts WHERE account_id IN (acct_cash, acct_res, acct_env, acct_pay) ORDER BY account_id FOR UPDATE;
  d := p_amount - COALESCE(ch.amount_minor, 0);
  IF d = 0 THEN RETURN jsonb_build_object('ok', true, 'unchanged', true); END IF;
  IF d > 0 THEN
    rem := d;
    -- 1. the hold's own reservation (first booking only), the unused rest released afterwards
    IF ch.status = 'held' AND ch.reserved_minor > 0 THEN
      v_res := LEAST(rem, ch.reserved_minor);
      rem := rem - v_res;
    END IF;
    -- 2. the agent's own spendable cash
    IF rem > 0 THEN
      eco := fleet_agent_economics(ch.agent_id);
      v_avail := GREATEST(0, LEAST((eco ->> 'cash')::bigint, (eco ->> 'survivalEquity')::bigint));
      v_own := LEAST(rem, v_avail); rem := rem - v_own;
    END IF;
    -- 3. its envelope (Fleet capital already allocated by Fleet Control), when the hold was envelope-funded
    IF rem > 0 AND ch.funding = 'envelope' THEN
      e := fleet_card_envelope_open(ch.agent_id, ch.envelope_id);
      IF e.envelope_id IS NOT NULL THEN
        v_epos := GREATEST(0, (fleet_envelope_position(e) ->> 'availableMinor')::bigint);
        v_env := LEAST(rem, v_epos, GREATEST(0, fleet_ledger_balance(acct_env))); rem := rem - v_env;
      END IF;
    END IF;
    -- 4. what is left was charged anyway: the treasury advances it against the agent's payable (a debt, not a gift)
    v_adv := rem;
    v_lines := jsonb_build_array(jsonb_build_object('account', acct_exp, 'side', 'D', 'amount', d));
    IF v_res > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', acct_res, 'side', 'C', 'amount', v_res)); END IF;
    IF v_own > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', acct_cash, 'side', 'C', 'amount', v_own)); END IF;
    IF v_env > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', acct_env, 'side', 'C', 'amount', v_env)); END IF;
    IF v_adv > 0 THEN v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account', acct_pay, 'side', 'C', 'amount', v_adv),
      jsonb_build_object('account', 'fleet:provider:advances', 'side', 'D', 'amount', v_adv),
      jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', v_adv)); END IF;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'fleet:card:reserve', 'side', 'D', 'amount', d),
                                            jsonb_build_object('account', 'fleet:card:payable', 'side', 'C', 'amount', d));
    -- the reservation's own part of the booking counts towards its funding source
    dp_agent := v_own + CASE WHEN ch.funding = 'own' THEN v_res ELSE 0 END;
    dp_env := v_env + CASE WHEN ch.funding = 'envelope' THEN v_res ELSE 0 END;
    dp_tre := v_adv;
  ELSE
    -- A reduction gives back the advance first (only what is still owed), then the envelope, then the agent's cash
    -- (including any advance the agent has already repaid from later receipts).
    rem := -d;
    v_pay := GREATEST(0, fleet_ledger_balance(acct_pay));
    x_adv := LEAST(rem, ch.treasury_part_minor, v_pay); rem := rem - x_adv;
    x_env := LEAST(rem, ch.envelope_part_minor); rem := rem - x_env;
    x_cash := rem;
    IF x_cash > ch.agent_part_minor + ch.treasury_part_minor - x_adv THEN RAISE EXCEPTION 'FLEET_LEDGER_INVALID: reduction beyond the booked charge'; END IF;
    x_from_agent := LEAST(x_cash, ch.agent_part_minor);
    dp_agent := -x_from_agent; dp_env := -x_env; dp_tre := -(x_adv + x_cash - x_from_agent);
    v_lines := jsonb_build_array(jsonb_build_object('account', acct_exp, 'side', 'C', 'amount', -d));
    IF x_adv > 0 THEN v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account', acct_pay, 'side', 'D', 'amount', x_adv),
      jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', x_adv),
      jsonb_build_object('account', 'fleet:provider:advances', 'side', 'C', 'amount', x_adv)); END IF;
    IF x_env > 0 THEN
      v_env_to := CASE WHEN EXISTS (SELECT 1 FROM fleet_envelopes WHERE envelope_id = ch.envelope_id AND status = 'active') THEN acct_env ELSE 'fleet:treasury:unallocated' END;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', v_env_to, 'side', 'D', 'amount', x_env));
    END IF;
    IF x_cash > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', acct_cash, 'side', 'D', 'amount', x_cash)); END IF;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'fleet:card:payable', 'side', 'D', 'amount', -d),
                                            jsonb_build_object('account', 'fleet:card:reserve', 'side', 'C', 'amount', -d));
  END IF;
  v_kind := CASE WHEN ch.amount_minor IS NULL THEN 'card_charge' ELSE 'card_charge_adjust' END;
  v_j := fleet_ledger_post(v_kind, p_idem, p_actor, 'card charge: ' || ch.merchant, p_source, ch.agent_id, NULL, NULL, p_idem, NULL, now(), v_lines);
  UPDATE fleet_card_charges SET amount_minor = p_amount, agent_part_minor = agent_part_minor + dp_agent, envelope_part_minor = envelope_part_minor + dp_env,
         treasury_part_minor = treasury_part_minor + dp_tre, reserved_minor = reserved_minor - v_res,
         status = CASE WHEN status = 'held' THEN 'booked' ELSE status END, booked_at = COALESCE(booked_at, now())
   WHERE charge_id = p_charge RETURNING * INTO ch;
  IF ch.reserved_minor > 0 THEN PERFORM fleet_card_hold_release(p_charge, ch.reserved_minor, p_actor, CASE WHEN p_source = 'owner' THEN 'owner' ELSE 'controller' END); END IF;
  SELECT * INTO ch FROM fleet_card_charges WHERE charge_id = p_charge;
  IF v_adv > 0 THEN
    PERFORM fleet_event('card_charge_advanced', ch.agent_id, left(p_actor, 128), jsonb_build_object('chargeId', ch.charge_id, 'advancedMinor', v_adv,
      'note', 'charged beyond what the agent could cover: advanced by the treasury against its payable, repaid first from its next receipts'));
  END IF;
  RETURN jsonb_build_object('ok', true, 'journalId', v_j, 'amountMinor', p_amount, 'agentPartMinor', ch.agent_part_minor, 'envelopePartMinor', ch.envelope_part_minor,
    'treasuryPartMinor', ch.treasury_part_minor, 'advancedMinor', GREATEST(v_adv, 0));
END $$;

CREATE OR REPLACE FUNCTION fleet_econ_card_authorize(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE au fleet_identity_autonomy; acc fleet_agent_accounts; lim fleet_agent_wallet_limits; c fleet_card_charges; e fleet_envelopes; ag fleet_agents;
        v_max bigint; v_origin text; v_merchant text := fleet_econ_text(a, 'merchant', 120, true); v_agent_day bigint; v_fleet_day bigint;
        eco jsonb; v_avail bigint; v_env uuid; v_j uuid; v_from text;
BEGIN
  SELECT * INTO au FROM fleet_identity_autonomy WHERE id = 1;
  IF NOT au.enabled OR NOT au.card_enabled THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NO_STANDING_AUTHORITY', 'reason', 'the owner has not enabled the card bypass; use a vendor payout or another payment path');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fleet_owner_identity_classes WHERE class_key = 'payment_card' AND status = 'configured' AND (expires_at IS NULL OR expires_at > now())) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_OWNER_FACT_UNAVAILABLE', 'reason', 'no card is on file');
  END IF;
  SELECT * INTO ag FROM fleet_agents WHERE agent_id = p_agent;
  IF ag.operator_hold_at IS NOT NULL OR EXISTS (SELECT 1 FROM fleet_wallet_custody w WHERE w.agent_id = p_agent AND w.spending_frozen) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_SPENDING_FROZEN', 'reason', 'spending is paused for this agent');
  END IF;
  SELECT * INTO acc FROM fleet_agent_accounts WHERE account_id = fleet_identity_uuid(a, 'accountId') AND agent_id = p_agent;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: accountId — one of your accounts (the merchant site you pay on)'; END IF;
  IF acc.status IN ('frozen','closed','banned') THEN RAISE EXCEPTION 'FLEET_ACCOUNT_FROZEN: that account cannot be used'; END IF;
  v_origin := lower(COALESCE(a ->> 'origin', acc.origins[1]));
  IF v_origin IS NULL OR NOT (v_origin = ANY (acc.origins)) THEN PERFORM fleet_econ_bad('origin is one of the account''s pinned origins (add_origin first)'); END IF;
  IF v_origin = ANY (au.excluded_origins) THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ORIGIN_EXCLUDED'); END IF;
  v_max := CASE WHEN jsonb_typeof(a -> 'maxMinor') = 'number' THEN (a ->> 'maxMinor')::bigint END;
  IF v_max IS NULL OR v_max <= 0 THEN PERFORM fleet_econ_bad('maxMinor — the most this purchase may cost, in minor units'); END IF;
  SELECT * INTO lim FROM fleet_agent_wallet_limits WHERE agent_id = p_agent;
  IF v_max > au.card_max_charge_minor OR (lim.card_max_charge_minor IS NOT NULL AND v_max > lim.card_max_charge_minor) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CARD_LIMIT', 'maxMinor', LEAST(au.card_max_charge_minor, COALESCE(lim.card_max_charge_minor, au.card_max_charge_minor)));
  END IF;
  SELECT COALESCE(sum(COALESCE(amount_minor, hold_max_minor)), 0) INTO v_agent_day FROM fleet_card_charges
   WHERE agent_id = p_agent AND status <> 'void' AND created_at > now() - interval '24 hours';
  SELECT COALESCE(sum(COALESCE(amount_minor, hold_max_minor)), 0) INTO v_fleet_day FROM fleet_card_charges WHERE status <> 'void' AND created_at > now() - interval '24 hours';
  IF v_fleet_day + v_max > au.card_max_daily_minor OR (lim.card_max_daily_minor IS NOT NULL AND v_agent_day + v_max > lim.card_max_daily_minor) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CARD_DAILY_LIMIT');
  END IF;
  IF EXISTS (SELECT 1 FROM fleet_card_charges WHERE agent_id = p_agent AND status = 'held' AND origin = v_origin AND declare_by > now()) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CARD_HOLD_OPEN', 'reason', 'declare or void your open hold on this site first');
  END IF;
  -- v51: reserve the maximum before the card can be filled — from your own spendable capital, or from one of your envelopes.
  PERFORM 1 FROM fleet_ledger_accounts WHERE account_id IN (fleet_ledger_account(p_agent, 'agent_cash'), fleet_ledger_account(p_agent, 'agent_envelope_cash'),
    fleet_ledger_account(p_agent, 'agent_reserved')) ORDER BY account_id FOR UPDATE;
  IF a ? 'envelopeId' THEN
    v_env := fleet_identity_uuid(a, 'envelopeId');
    e := fleet_card_envelope_open(p_agent, v_env);
    IF e.envelope_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ENVELOPE_UNAVAILABLE', 'reason', 'not one of your active envelopes that permits expense');
    END IF;
    IF v_max > (fleet_envelope_position(e) ->> 'availableMinor')::bigint OR v_max > fleet_ledger_balance(fleet_ledger_account(p_agent, 'agent_envelope_cash')) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ENVELOPE_EXHAUSTED', 'reason', 'beyond this envelope''s available capital: request more or lower maxMinor');
    END IF;
    IF e.max_single_bp IS NOT NULL AND v_max * 10000 > e.capital_minor * e.max_single_bp THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ENVELOPE_SINGLE_EXPOSURE', 'reason', 'one charge above this envelope''s single-exposure bound');
    END IF;
    v_from := fleet_ledger_account(p_agent, 'agent_envelope_cash');
  ELSE
    eco := fleet_agent_economics(p_agent);
    v_avail := GREATEST(0, LEAST((eco ->> 'cash')::bigint, (eco ->> 'survivalEquity')::bigint));
    IF v_max > v_avail THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INSUFFICIENT_FUNDS', 'availableMinor', v_avail,
        'reason', 'the card reserves maxMinor from your own spendable capital first; lower it, or name one of your envelopes (request Fleet capital with fleet_capital request)');
    END IF;
    v_from := fleet_ledger_account(p_agent, 'agent_cash');
  END IF;
  INSERT INTO fleet_card_charges (agent_id, merchant, origin, status, source, hold_max_minor, declare_by, funding, envelope_id, reserved_minor)
    VALUES (p_agent, left(fleet_scrub(v_merchant), 120), v_origin, 'held', 'agent', v_max, now() + interval '24 hours',
            CASE WHEN v_env IS NULL THEN 'own' ELSE 'envelope' END, v_env, v_max) RETURNING * INTO c;
  v_j := fleet_ledger_post('card_hold_reserve', 'card:' || c.charge_id || ':reserve', 'agent:' || p_agent, 'card hold reserved: ' || c.merchant, 'controller', p_agent,
    NULL, NULL, 'card:' || c.charge_id, NULL, now(), jsonb_build_array(
      jsonb_build_object('account', fleet_ledger_account(p_agent, 'agent_reserved'), 'side', 'D', 'amount', v_max),
      jsonb_build_object('account', v_from, 'side', 'C', 'amount', v_max)));
  UPDATE fleet_card_charges SET reserve_journal_id = v_j WHERE charge_id = c.charge_id RETURNING * INTO c;
  PERFORM fleet_event('card_hold_opened', p_agent, p_agent, jsonb_build_object('chargeId', c.charge_id, 'merchant', c.merchant, 'origin', v_origin, 'holdMaxMinor', v_max,
    'funding', c.funding, 'purpose', left(fleet_scrub(a ->> 'purpose'), 200)));
  PERFORM fleet_event('card_hold_reserved', p_agent, 'controller', jsonb_build_object('chargeId', c.charge_id, 'amountMinor', v_max, 'funding', c.funding));
  RETURN jsonb_build_object('ok', true, 'charge', fleet_card_charge_json(c),
    'note', 'maxMinor is reserved; fill the card with browser fill steps {credential:"owner_card", field:number|expiry|exp_month|exp_year|cvc|name|postcode} on this origin; '
         || 'then declare the amount charged (the rest of the reservation comes back) or void the hold if you did not pay, within 24 hours');
END $$;

CREATE OR REPLACE FUNCTION fleet_econ_card_void(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_card_charges;
BEGIN
  SELECT * INTO c FROM fleet_card_charges WHERE charge_id = fleet_identity_uuid(a, 'chargeId') AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such card hold of yours'; END IF;
  IF c.status <> 'held' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE', 'status', c.status); END IF;
  IF EXISTS (SELECT 1 FROM fleet_identity_uses u WHERE u.charge_id = c.charge_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CARD_USED', 'reason', 'the card was filled for this hold: declare what was charged');
  END IF;
  PERFORM fleet_card_hold_release(c.charge_id, c.reserved_minor, 'agent:' || p_agent, 'controller');
  UPDATE fleet_card_charges SET status = 'void' WHERE charge_id = c.charge_id RETURNING * INTO c;
  PERFORM fleet_event('card_hold_voided', p_agent, p_agent, jsonb_build_object('chargeId', c.charge_id));
  RETURN jsonb_build_object('ok', true, 'charge', fleet_card_charge_json(c));
END $$;

CREATE OR REPLACE FUNCTION svc_card_holds_expire(p_limit integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_card_charges; nb integer := 0; nv integer := 0;
BEGIN
  FOR c IN SELECT * FROM fleet_card_charges WHERE status = 'held' AND declare_by <= now() ORDER BY declare_by LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500) FOR UPDATE SKIP LOCKED LOOP
    IF EXISTS (SELECT 1 FROM fleet_identity_uses u WHERE u.charge_id = c.charge_id) THEN
      PERFORM fleet_card_charge_post(c.charge_id, c.hold_max_minor, 'card:' || c.charge_id || ':book', 'controller', 'controller');
      PERFORM fleet_event('card_hold_booked_at_maximum', c.agent_id, 'controller', jsonb_build_object('chargeId', c.charge_id, 'amountMinor', c.hold_max_minor,
        'merchant', c.merchant, 'note', 'undeclared after use: confirm the statement amount'));
      nb := nb + 1;
    ELSE
      PERFORM fleet_card_hold_release(c.charge_id, c.reserved_minor, 'controller', 'controller');
      UPDATE fleet_card_charges SET status = 'void' WHERE charge_id = c.charge_id;
      PERFORM fleet_event('card_hold_voided', c.agent_id, 'controller', jsonb_build_object('chargeId', c.charge_id, 'reason', 'expired unused'));
      nv := nv + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'bookedAtMaximum', nb, 'voided', nv);
END $$;

${ENVELOPE_POSITION}

-- ═══ 2. Card receipts: the owner's invoice and choice, settled truthfully ═══
ALTER TABLE fleet_card_receipts ADD COLUMN method text CHECK (method IN ('transfer','card_balance'));

-- return / withdrawal × transfer (the money reached the owner) / card_balance (it reduced what the fleet owes the card).
CREATE FUNCTION fleet_admin_card_receipt_settle(p_receipt uuid, p_resolution text, p_method text, p_sweep bigint, p_reference text, p_actor text)
RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE rc fleet_card_receipts; v_j uuid; v_s bigint; v_lines jsonb; s jsonb; v_cap bigint; v_out bigint; v_keep bigint;
BEGIN
  ${TREASURY_OWNER}
  SELECT * INTO rc FROM fleet_card_receipts WHERE receipt_id = p_receipt FOR UPDATE;
  IF NOT FOUND OR rc.status <> 'invoiced' THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: not an open card invoice'; END IF;
  IF p_resolution NOT IN ('return','withdrawal') OR p_method NOT IN ('transfer','card_balance') THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: resolution return|withdrawal, method transfer|card_balance';
  END IF;
  IF p_method = 'card_balance' THEN
    PERFORM 1 FROM fleet_ledger_accounts WHERE account_id IN ('fleet:card:payable','fleet:card:reserve') ORDER BY account_id FOR UPDATE;
    v_out := fleet_ledger_balance('fleet:card:payable');
    IF rc.amount_minor > v_out THEN
      RAISE EXCEPTION 'FLEET_BAD_REQUEST: only % is owed on the card; the rest of this money reached you — use method transfer', v_out;
    END IF;
  ELSIF p_resolution = 'return' AND (p_reference IS NULL OR length(trim(p_reference)) < 2) THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: the transfer reference of the returned money';
  END IF;
  IF p_resolution = 'return' THEN
    v_s := COALESCE(p_sweep, rc.suggested_sweep_minor);
    IF rc.kind = 'refund' THEN v_cap := 0;
    ELSE s := fleet_sweep_compute(rc.agent_id); v_cap := LEAST(rc.amount_minor, GREATEST(0, (s ->> 'afterTaxUncontributedProfitMinor')::bigint)); END IF;
    IF v_s < 0 OR v_s > v_cap THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the swept share is 0..% (net profit only)', v_cap; END IF;
  ELSE
    v_s := rc.amount_minor;
  END IF;
  v_keep := rc.amount_minor - v_s;
  v_lines := jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(rc.agent_id, 'agent_card_receivable'), 'side', 'C', 'amount', rc.amount_minor));
  IF v_keep > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(rc.agent_id, 'agent_cash'), 'side', 'D', 'amount', v_keep)); END IF;
  IF v_s > 0 THEN v_lines := v_lines || jsonb_build_array(
    jsonb_build_object('account', fleet_ledger_account(rc.agent_id, 'agent_contributions'), 'side', 'D', 'amount', v_s),
    jsonb_build_object('account', 'fleet:owner:withdrawals', 'side', 'D', 'amount', v_s),
    jsonb_build_object('account', 'fleet:profit', 'side', 'C', 'amount', v_s)); END IF;
  IF p_method = 'card_balance' THEN
    -- The receipt reduced the card's balance: the fleet owes the card that much less, and the cash earmarked for it is free.
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', 'fleet:card:payable', 'side', 'D', 'amount', rc.amount_minor),
                                            jsonb_build_object('account', 'fleet:card:reserve', 'side', 'C', 'amount', rc.amount_minor));
  END IF;
  v_j := fleet_ledger_post(CASE WHEN p_resolution = 'return' THEN 'card_receipt_return' ELSE 'card_receipt_withdrawal' END,
    'card-' || p_resolution || ':' || rc.receipt_id, p_actor,
    CASE WHEN p_resolution = 'return' THEN 'card money returned to the treasury' ELSE 'card money kept by the owner (withdrawal)' END
      || CASE WHEN p_method = 'card_balance' THEN ' (applied to the card balance)' ELSE '' END, 'owner', rc.agent_id, NULL, NULL,
    'card-' || p_resolution || ':' || left(COALESCE(trim(p_reference), rc.receipt_id::text), 100), NULL, now(), v_lines);
  UPDATE fleet_card_receipts SET status = CASE WHEN p_resolution = 'return' THEN 'returned' ELSE 'withdrawn' END, sweep_minor = v_s, method = p_method,
         return_reference = CASE WHEN p_reference IS NOT NULL AND length(trim(p_reference)) >= 2 THEN left(trim(p_reference), 120) END,
         resolve_journal_id = v_j, resolved_by = p_actor, resolved_at = now() WHERE receipt_id = p_receipt;
  PERFORM fleet_event(CASE WHEN p_resolution = 'return' THEN 'card_receipt_returned' ELSE 'card_receipt_withdrawn' END, rc.agent_id, p_actor,
    jsonb_build_object('receiptId', p_receipt, 'returnedMinor', v_keep, 'sweepMinor', v_s, 'method', p_method));
  IF p_method = 'card_balance' THEN
    PERFORM fleet_event('card_receipt_applied', rc.agent_id, p_actor, jsonb_build_object('receiptId', p_receipt, 'amountMinor', rc.amount_minor,
      'cardOutstandingMinor', fleet_ledger_balance('fleet:card:payable')));
  END IF;
  RETURN jsonb_build_object('ok', true, 'status', CASE WHEN p_resolution = 'return' THEN 'returned' ELSE 'withdrawn' END, 'method', p_method,
    'returnedMinor', v_keep, 'sweepMinor', v_s, 'withdrawnMinor', CASE WHEN p_resolution = 'withdrawal' THEN rc.amount_minor END, 'journalId', v_j,
    'cardOutstandingMinor', fleet_ledger_balance('fleet:card:payable'));
END $$;

CREATE OR REPLACE FUNCTION fleet_admin_card_receipt_resolve(p_receipt uuid, p_resolution text, p_sweep bigint, p_reference text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  RETURN fleet_admin_card_receipt_settle(p_receipt, p_resolution, 'transfer', p_sweep, p_reference, p_actor);
END $$;

-- ═══ 3. PayPal: captured, held, available ═══
CREATE TABLE fleet_paypal_availability (
  capture_id      text        PRIMARY KEY CHECK (capture_id ~ ${PAYPAL_ID}),
  checkout_id     uuid        NOT NULL UNIQUE REFERENCES fleet_paypal_checkouts(checkout_id),
  agent_id        text        NOT NULL REFERENCES fleet_agents(agent_id),
  rail_id         uuid        NOT NULL REFERENCES fleet_payment_rails(rail_id),
  currency        text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  net_minor       bigint      NOT NULL CHECK (net_minor > 0),
  remaining_minor bigint      NOT NULL CHECK (remaining_minor >= 0),
  status          text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','available','reversed')),
  captured_at     timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz,
  journal_id      uuid        REFERENCES fleet_ledger_journal(journal_id),
  evidence        jsonb,
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK (remaining_minor <= net_minor)
);
CREATE INDEX fleet_paypal_availability_pending ON fleet_paypal_availability (captured_at) WHERE status = 'pending';
CREATE TRIGGER fleet_paypal_availability_no_delete BEFORE DELETE ON fleet_paypal_availability FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_paypal_availability_no_truncate BEFORE TRUNCATE ON fleet_paypal_availability FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- A completed capture: the agent's revenue now, its cash held until PayPal shows it available. Any earlier payable is
-- repaid when the money becomes available.
CREATE OR REPLACE FUNCTION cx_paypal_capture_record(p_worker text, p_checkout uuid, p_capture_id text, p_status text, p_gross bigint, p_fee bigint, p_currency text, p_evidence text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_paypal_checkouts; v_key text; v_j uuid; v_lines jsonb;
BEGIN
  ${WORKER}
  IF p_capture_id IS NULL OR p_capture_id !~ ${PAYPAL_ID} OR p_status NOT IN ('COMPLETED','PENDING') OR p_evidence NOT IN ('capture_response','webhook','transaction_search') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  SELECT * INTO c FROM fleet_paypal_checkouts WHERE checkout_id = p_checkout FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF c.capture_id IS NOT NULL AND c.capture_id <> p_capture_id THEN
    PERFORM fleet_event('paypal_capture_conflict', c.agent_id, 'custody', jsonb_build_object('checkoutId', c.checkout_id, 'recorded', c.capture_id, 'reported', p_capture_id));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PAYPAL_CONFLICT');
  END IF;
  IF c.status = 'captured' THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'journalId', c.journal_id); END IF;
  IF p_currency IS DISTINCT FROM c.currency OR p_gross IS DISTINCT FROM c.amount_minor OR p_fee IS NULL OR p_fee < 0 OR p_fee >= p_gross THEN
    PERFORM fleet_event('paypal_receipt_mismatch', c.agent_id, 'custody', jsonb_build_object('checkoutId', c.checkout_id, 'captureId', p_capture_id,
      'expectedMinor', c.amount_minor, 'reportedMinor', p_gross, 'currency', p_currency));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PAYPAL_AMOUNT_MISMATCH');
  END IF;
  IF p_status = 'PENDING' THEN
    UPDATE fleet_paypal_checkouts SET status = 'capture_pending', capture_id = p_capture_id WHERE checkout_id = c.checkout_id;
    RETURN jsonb_build_object('ok', true, 'status', 'capture_pending');
  END IF;
  v_key := 'paypal:capture:' || p_capture_id;
  IF fleet_claim_taken(v_key) THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_ALREADY_CLAIMED'); END IF;
  v_lines := jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(c.agent_id, 'agent_cash_pending'), 'side', 'D', 'amount', p_gross - p_fee),
    jsonb_build_object('account', fleet_ledger_account(c.agent_id, 'agent_revenue'), 'side', 'C', 'amount', p_gross));
  IF p_fee > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(c.agent_id, 'agent_fees'), 'side', 'D', 'amount', p_fee)); END IF;
  v_j := fleet_ledger_post('paypal_receipt', v_key, 'custody:' || p_worker, 'PayPal checkout captured: ' || c.description, 'executor', c.agent_id,
    NULL, NULL, v_key, NULL, now(), v_lines);
  INSERT INTO fleet_revenue_claims (claim_key, claim_kind, journal_id, claimed_by) VALUES (v_key, 'paypal_capture', v_j, 'custody:' || p_worker);
  INSERT INTO fleet_venture_journals (journal_id, venture_id, agent_id, cost_category, attributed_by) VALUES (v_j, c.venture_id, c.agent_id, 'revenue', 'custody');
  UPDATE fleet_paypal_checkouts SET status = 'captured', capture_id = p_capture_id, captured_at = now(), journal_id = v_j WHERE checkout_id = c.checkout_id;
  INSERT INTO fleet_paypal_availability (capture_id, checkout_id, agent_id, rail_id, currency, net_minor, remaining_minor)
    VALUES (p_capture_id, c.checkout_id, c.agent_id, c.rail_id, c.currency, p_gross - p_fee, p_gross - p_fee);
  PERFORM fleet_event('paypal_receipt_posted', c.agent_id, 'custody', jsonb_build_object('checkoutId', c.checkout_id, 'captureId', p_capture_id,
    'grossMinor', p_gross, 'feeMinor', p_fee, 'evidence', p_evidence, 'held', true,
    'note', 'your revenue; the cash becomes spendable when PayPal shows it available'));
  RETURN jsonb_build_object('ok', true, 'status', 'captured', 'journalId', v_j, 'netMinor', p_gross - p_fee, 'availability', 'pending');
END $$;

-- A refund / reversal / dispute fee: from the capture's held money first, then the agent's cash, then advanced against its payable.
CREATE OR REPLACE FUNCTION cx_paypal_refund_record(p_worker text, p_capture_id text, p_refund_id text, p_kind text, p_amount bigint, p_currency text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_paypal_checkouts; av fleet_paypal_availability; v_key text; v_cash bigint; v_held bigint := 0; v_own bigint; v_short bigint; v_lines jsonb; v_j uuid; v_class text;
BEGIN
  ${WORKER}
  IF p_refund_id IS NULL OR p_refund_id !~ '^[A-Za-z0-9-]{5,64}$' OR p_kind NOT IN ('refund','reversal','dispute_fee','chargeback_fee') OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  v_key := 'paypal:' || CASE WHEN p_kind IN ('refund','reversal') THEN 'refund:' ELSE 'fee:' END || p_refund_id;
  IF fleet_claim_taken(v_key) THEN RETURN jsonb_build_object('ok', true, 'replay', true); END IF;
  SELECT * INTO c FROM fleet_paypal_checkouts WHERE capture_id = p_capture_id AND status = 'captured';
  IF NOT FOUND OR p_currency IS DISTINCT FROM c.currency THEN
    PERFORM fleet_event('paypal_refund_unmatched', NULL, 'custody', jsonb_build_object('captureId', p_capture_id, 'refundId', p_refund_id, 'kind', p_kind,
      'amountMinor', p_amount, 'currency', p_currency));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND');
  END IF;
  PERFORM 1 FROM fleet_ledger_accounts WHERE account_id IN (fleet_ledger_account(c.agent_id, 'agent_cash'), fleet_ledger_account(c.agent_id, 'agent_cash_pending'))
    ORDER BY account_id FOR UPDATE;
  SELECT * INTO av FROM fleet_paypal_availability WHERE capture_id = p_capture_id FOR UPDATE;
  IF FOUND AND av.status = 'pending' THEN v_held := LEAST(av.remaining_minor, p_amount); END IF;
  v_cash := fleet_ledger_balance(fleet_ledger_account(c.agent_id, 'agent_cash'));
  v_own := LEAST(v_cash, p_amount - v_held);
  v_short := p_amount - v_held - v_own;
  v_class := CASE WHEN p_kind IN ('refund','reversal') THEN 'agent_revenue' ELSE 'agent_fees' END;
  v_lines := jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(c.agent_id, v_class), 'side', 'D', 'amount', p_amount));
  IF v_held > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(c.agent_id, 'agent_cash_pending'), 'side', 'C', 'amount', v_held)); END IF;
  IF v_own > 0 THEN v_lines := v_lines || jsonb_build_array(jsonb_build_object('account', fleet_ledger_account(c.agent_id, 'agent_cash'), 'side', 'C', 'amount', v_own)); END IF;
  IF v_short > 0 THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account', fleet_ledger_account(c.agent_id, 'agent_provider_payable'), 'side', 'C', 'amount', v_short),
      jsonb_build_object('account', 'fleet:provider:advances', 'side', 'D', 'amount', v_short),
      jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', v_short));
  END IF;
  v_j := fleet_ledger_post('paypal_clawback', v_key, 'custody:' || p_worker, 'PayPal ' || replace(p_kind, '_', ' ') || ': ' || c.description, 'executor', c.agent_id,
    NULL, NULL, v_key, NULL, now(), v_lines);
  IF v_held > 0 THEN
    UPDATE fleet_paypal_availability SET remaining_minor = remaining_minor - v_held,
           status = CASE WHEN remaining_minor - v_held = 0 THEN 'reversed' ELSE status END,
           decided_at = CASE WHEN remaining_minor - v_held = 0 THEN now() ELSE decided_at END
     WHERE capture_id = p_capture_id;
  END IF;
  INSERT INTO fleet_revenue_claims (claim_key, claim_kind, journal_id, claimed_by) VALUES (v_key, 'paypal_refund', v_j, 'custody:' || p_worker);
  INSERT INTO fleet_venture_journals (journal_id, venture_id, agent_id, cost_category, attributed_by)
    VALUES (v_j, c.venture_id, c.agent_id, CASE WHEN p_kind IN ('refund','reversal') THEN 'refund' ELSE 'processor_fee' END, 'custody');
  PERFORM fleet_event('paypal_clawback_posted', c.agent_id, 'custody', jsonb_build_object('checkoutId', c.checkout_id, 'kind', p_kind, 'amountMinor', p_amount,
    'fromHeldMinor', v_held, 'fromCashMinor', v_own, 'advancedMinor', v_short));
  RETURN jsonb_build_object('ok', true, 'journalId', v_j, 'fromHeldMinor', v_held, 'fromCashMinor', v_own, 'advancedMinor', v_short);
END $$;

-- Reaper: held captures become available capital on PayPal's evidence — the capture completed in Transaction Search (status
-- S) and the latest Balances observation (at most 26 h old) showing an available balance that covers what is released.
CREATE FUNCTION svc_paypal_availability(p_limit integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE av fleet_paypal_availability; b fleet_paypal_balance_observations; v_budget jsonb := '{}'::jsonb; v_left bigint; v_j uuid; v_pay bigint; rep bigint;
        n integer := 0; nshort integer := 0; v_key text;
BEGIN
  FOR av IN SELECT * FROM fleet_paypal_availability WHERE status = 'pending' AND remaining_minor > 0 ORDER BY captured_at
             LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 1000) FOR UPDATE SKIP LOCKED LOOP
    IF NOT EXISTS (SELECT 1 FROM fleet_paypal_transactions t WHERE t.rail_id = av.rail_id AND t.transaction_id = av.capture_id AND t.status = 'S' AND t.amount_minor > 0) THEN
      CONTINUE;
    END IF;
    IF NOT v_budget ? (av.rail_id || ':' || av.currency) THEN
      SELECT * INTO b FROM fleet_paypal_balance_observations WHERE rail_id = av.rail_id AND currency = av.currency AND observed_at > now() - interval '26 hours'
       ORDER BY observed_at DESC LIMIT 1;
      v_budget := v_budget || jsonb_build_object(av.rail_id || ':' || av.currency, COALESCE(b.available_minor, 0));
    END IF;
    v_left := (v_budget ->> (av.rail_id || ':' || av.currency))::bigint;
    IF v_left < av.remaining_minor THEN nshort := nshort + 1; CONTINUE; END IF;
    v_budget := jsonb_set(v_budget, ARRAY[av.rail_id || ':' || av.currency], to_jsonb(v_left - av.remaining_minor));
    v_key := 'paypal:available:' || av.capture_id;
    PERFORM 1 FROM fleet_ledger_accounts WHERE account_id IN (fleet_ledger_account(av.agent_id, 'agent_cash'), fleet_ledger_account(av.agent_id, 'agent_cash_pending'),
      fleet_ledger_account(av.agent_id, 'agent_provider_payable')) ORDER BY account_id FOR UPDATE;
    v_j := fleet_ledger_post('paypal_funds_available', v_key, 'controller', 'PayPal shows the captured money available', 'controller', av.agent_id,
      NULL, NULL, v_key, NULL, now(), jsonb_build_array(
        jsonb_build_object('account', fleet_ledger_account(av.agent_id, 'agent_cash'), 'side', 'D', 'amount', av.remaining_minor),
        jsonb_build_object('account', fleet_ledger_account(av.agent_id, 'agent_cash_pending'), 'side', 'C', 'amount', av.remaining_minor)));
    UPDATE fleet_paypal_availability SET status = 'available', decided_at = now(), journal_id = v_j,
           evidence = jsonb_build_object('transactionStatus', 'S', 'availableBudgetBeforeMinor', v_left)
     WHERE capture_id = av.capture_id;
    -- A payable (an earlier refund or card charge the agent could not cover) is repaid first.
    v_pay := COALESCE(fleet_ledger_balance(fleet_ledger_account(av.agent_id, 'agent_provider_payable')), 0);
    rep := LEAST(v_pay, av.remaining_minor);
    IF rep > 0 THEN
      PERFORM fleet_ledger_post('payable_repayment', v_key || ':rp', 'controller', 'payable repaid from PayPal money now available', 'controller', av.agent_id,
        NULL, NULL, v_key, NULL, now(), jsonb_build_array(
          jsonb_build_object('account', fleet_ledger_account(av.agent_id, 'agent_provider_payable'), 'side', 'D', 'amount', rep),
          jsonb_build_object('account', fleet_ledger_account(av.agent_id, 'agent_cash'), 'side', 'C', 'amount', rep),
          jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'D', 'amount', rep),
          jsonb_build_object('account', 'fleet:provider:advances', 'side', 'C', 'amount', rep)));
    END IF;
    PERFORM fleet_event('paypal_funds_available', av.agent_id, 'controller', jsonb_build_object('captureId', av.capture_id, 'amountMinor', av.remaining_minor,
      'payableRepaidMinor', rep));
    n := n + 1;
  END LOOP;
  IF nshort > 0 THEN
    PERFORM fleet_event('paypal_availability_short', NULL, 'controller', jsonb_build_object('waiting', nshort,
      'note', 'completed captures wait: PayPal''s latest available balance does not cover them (funds on hold, or no recent balance observation)'));
  END IF;
  RETURN jsonb_build_object('ok', true, 'released', n, 'waitingForBalance', nshort);
END $$;

-- What is where, by money state (a list of evidence; the ledger and PayPal's records decide, not this view).
CREATE FUNCTION fleet_money_states() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'currency', (SELECT accounting_currency FROM fleet_economic_model WHERE id = 1),
    'prospective', jsonb_build_object('note', 'checkouts not yet paid: not money',
      'openCheckouts', (SELECT count(*) FROM fleet_paypal_checkouts WHERE status IN ('requested','open','approved')),
      'openCheckoutsMinor', (SELECT COALESCE(sum(amount_minor), 0) FROM fleet_paypal_checkouts WHERE status IN ('requested','open','approved'))),
    'verifiedProviderSales', jsonb_build_object('note', 'verified at the provider, not yet received (USD memo)',
      'notPaidOutUsdMinor', (SELECT COALESCE(sum(price_minor - fee_minor), 0) FROM fleet_provider_sales s WHERE NOT refunded AND NOT chargedback
                              AND NOT EXISTS (SELECT 1 FROM fleet_provider_payout_lines l WHERE l.account_id = s.account_id AND l.purchase_id = s.sale_id)),
      'payoutsReportedNotReceived', (SELECT count(*) FROM fleet_provider_payouts p WHERE p.status = 'completed'
                              AND NOT EXISTS (SELECT 1 FROM fleet_settlement_receipts r WHERE r.account_id = p.account_id AND r.payout_id = p.payout_id AND r.status = 'posted'))),
    'captured', jsonb_build_object('note', 'PayPal captures that are the agents'' revenue',
      'capturePendingMinor', (SELECT COALESCE(sum(amount_minor), 0) FROM fleet_paypal_checkouts WHERE status = 'capture_pending'),
      'heldUntilAvailableMinor', (SELECT COALESCE(sum(remaining_minor), 0) FROM fleet_paypal_availability WHERE status = 'pending'),
      'releasedAvailableMinor', (SELECT COALESCE(sum(net_minor), 0) FROM fleet_paypal_availability WHERE status = 'available')),
    'received', jsonb_build_object('note', 'settlement receipts recorded but not yet posted to agents',
      'receiptsHeld', (SELECT count(*) FROM fleet_settlement_receipts WHERE status IN ('held','unmatched','ambiguous','matched'))),
    'available', jsonb_build_object('note', 'spendable by agents or allocatable by Fleet Control',
      'agentCashMinor', (SELECT COALESCE(sum(fleet_ledger_balance(account_id)), 0) FROM fleet_ledger_accounts WHERE class = 'agent_cash'),
      'treasuryUnallocatedMinor', fleet_ledger_balance('fleet:treasury:unallocated')),
    'paypalObserved', (SELECT jsonb_build_object('currency', b.currency, 'availableMinor', b.available_minor, 'totalMinor', b.total_minor,
                         'withheldMinor', b.total_minor - b.available_minor, 'at', b.observed_at)
                       FROM fleet_paypal_balance_observations b ORDER BY b.observed_at DESC LIMIT 1))
$$;

${TREASURY_TXNS}

${TREASURY_HEALTH}

-- ═══ 4. Custody activation: pilot or ongoing ═══
ALTER TABLE fleet_custody_activations ADD COLUMN mode text NOT NULL DEFAULT 'pilot' CHECK (mode IN ('pilot','ongoing'));
ALTER TABLE fleet_custody_activations ALTER COLUMN expires_at DROP NOT NULL;
ALTER TABLE fleet_custody_activations DROP CONSTRAINT fleet_custody_activations_check1;
ALTER TABLE fleet_custody_activations ADD CONSTRAINT fleet_custody_activations_term
  CHECK ((mode = 'pilot' AND expires_at IS NOT NULL AND expires_at > granted_at AND expires_at <= granted_at + interval '90 days')
      OR (mode = 'ongoing' AND expires_at IS NULL));
CREATE OR REPLACE FUNCTION fleet_custody_activations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.ended_at IS NOT NULL THEN RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: a custody activation is history once ended'; END IF;
  IF NEW.activation_id <> OLD.activation_id OR NEW.granted_by <> OLD.granted_by OR NEW.reason <> OLD.reason OR NEW.max_instruction_minor <> OLD.max_instruction_minor
     OR NEW.max_daily_minor <> OLD.max_daily_minor OR NEW.granted_at <> OLD.granted_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.mode <> OLD.mode THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: an activation''s grant is fixed (end it and grant another)';
  END IF;
  RETURN NEW;
END $$;

${CUSTODY_LIVE}

${CUSTODY_EXPIRE}

${CUSTODY_STATUS}

${WALLET_LIMITS}

-- p_hours: 1..2160 for a pilot activation, NULL for an ongoing one (no expiry; ends only when the owner ends it).
CREATE OR REPLACE FUNCTION fleet_admin_custody_activate(p_max_instruction bigint, p_max_daily bigint, p_hours integer, p_reason text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE prev uuid; a fleet_custody_activations;
BEGIN
  ${TREASURY_OWNER}
  IF p_hours IS NOT NULL AND p_hours NOT BETWEEN 1 AND 2160 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a pilot activation lasts 1..2160 hours (90 days); an ongoing one has no expiry'; END IF;
  IF p_max_instruction IS NULL OR p_max_daily IS NULL OR p_max_instruction <= 0 OR p_max_daily < p_max_instruction THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: a positive per-instruction maximum and a daily maximum at least as large';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a reason is required'; END IF;
  SELECT custody_activation_id INTO prev FROM fleet_economic_model WHERE id = 1 FOR UPDATE;
  IF prev IS NOT NULL THEN
    UPDATE fleet_custody_activations SET ended_at = now(), ended_by = p_actor, end_reason = 'superseded by a new activation' WHERE activation_id = prev AND ended_at IS NULL;
  END IF;
  INSERT INTO fleet_custody_activations (granted_by, reason, max_instruction_minor, max_daily_minor, expires_at, mode)
    VALUES (p_actor, left(fleet_scrub(p_reason), 300), p_max_instruction, p_max_daily,
            CASE WHEN p_hours IS NULL THEN NULL ELSE now() + make_interval(hours => p_hours) END, CASE WHEN p_hours IS NULL THEN 'ongoing' ELSE 'pilot' END)
    RETURNING * INTO a;
  PERFORM fleet_custody_switch(true, a.activation_id);
  PERFORM fleet_event('custody_activated', NULL, p_actor, jsonb_build_object('activationId', a.activation_id, 'mode', a.mode, 'maxInstructionMinor', a.max_instruction_minor,
    'maxDailyMinor', a.max_daily_minor, 'expiresAt', a.expires_at));
  RETURN jsonb_build_object('ok', true, 'activationId', a.activation_id, 'mode', a.mode, 'expiresAt', a.expires_at,
    'note', 'money leaves only when a live PayPal rail is verified for the capability, the custody signer attests it, and the custody executor host has real payments switched on');
END $$;

-- ═══ 5. Exhaustion is death ═══
-- The authoritative wallet measure (see the header). All amounts in the accounting currency's minor units.
CREATE FUNCTION fleet_agent_wallet_measure(p_agent text) RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE e jsonb := fleet_agent_economics(p_agent); v_cash bigint; v_eq bigint; v_holds bigint; v_pending bigint; v_cap_pending bigint; v_card bigint;
        v_spend bigint; v_own bigint; v_in bigint; v_open bigint; v_env bigint; m jsonb; v_orders bigint;
BEGIN
  v_cash := COALESCE((e ->> 'cash')::bigint, 0);
  v_eq := COALESCE((e ->> 'survivalEquity')::bigint, 0);
  v_holds := COALESCE((e ->> 'cardHoldsReserved')::bigint, 0);
  v_pending := COALESCE((e ->> 'cashPendingAvailability')::bigint, 0);
  SELECT COALESCE(sum(amount_minor), 0) INTO v_cap_pending FROM fleet_paypal_checkouts WHERE agent_id = p_agent AND status = 'capture_pending';
  v_card := COALESCE((SELECT fleet_ledger_balance(account_id) FROM fleet_ledger_accounts WHERE agent_id = p_agent AND class = 'agent_card_receivable'), 0);
  -- Own money reserved for a payment still in progress is held, not gone (it returns if the order expires or fails).
  SELECT COALESCE(sum(amount_cents), 0) INTO v_orders FROM fleet_payment_orders
   WHERE agent_id = p_agent AND order_type = 'agent_spend' AND funding = 'own' AND status IN ('reserved','executing');
  SELECT COALESCE(sum(amount_minor), 0) INTO v_open FROM fleet_paypal_checkouts WHERE agent_id = p_agent AND status IN ('requested','open','approved');
  v_env := COALESCE((SELECT fleet_ledger_balance(account_id) FROM fleet_ledger_accounts WHERE agent_id = p_agent AND class = 'agent_envelope_cash'), 0);
  m := fleet_agent_provider_memo(p_agent);
  v_spend := GREATEST(0, LEAST(v_cash, v_eq));
  v_own := GREATEST(0, LEAST(v_cash + v_holds, v_eq));
  v_in := v_pending + v_cap_pending + v_card;
  RETURN jsonb_build_object(
    'spendableMinor', v_spend,
    'ownHeldMinor', jsonb_build_object('cardHoldsMinor', v_holds, 'paymentOrdersInProgressMinor', v_orders, 'paypalHeldUntilAvailableMinor', v_pending,
                                       'paypalCapturePendingMinor', v_cap_pending, 'paidToOwnerCardMinor', v_card),
    'ownFundsMinor', v_own + v_in + v_orders,
    'survivalEquityMinor', v_eq,
    'notCounted', jsonb_build_object('openCheckoutsMinor', v_open, 'envelopeCapitalMinor', v_env,
                    'providerSalesNotReceivedUsdMinor', COALESCE((m ->> 'verifiedSalesNotPaidOutMinor')::bigint, 0) + COALESCE((m ->> 'inReportedPayoutsNotReceivedMinor')::bigint, 0)),
    -- An agent that was never funded has no wallet to exhaust (Genesis owns an unfunded birth).
    'funded', EXISTS (SELECT 1 FROM fleet_ledger_postings po WHERE po.account_id = fleet_ledger_account(p_agent, 'agent_cash') AND po.side = 'D'),
    'exhausted', v_own = 0 AND v_in = 0 AND v_orders = 0
                 AND EXISTS (SELECT 1 FROM fleet_ledger_postings po WHERE po.account_id = fleet_ledger_account(p_agent, 'agent_cash') AND po.side = 'D'),
    'rule', 'Exhaustion means death: when nothing is spendable, no money of yours is held (card holds, payments in progress, PayPal captures awaiting availability, money paid to the owner''s card) '
         || 'and none is owed back to you, Fleet Control ends this agent at its next lifecycle pass and its estate is settled. Open checkouts, provider sales not yet '
         || 'received and Fleet envelope capital do not count. There is no grace period and no rescue: earn, or request capital before you run out.');
END $$;

CREATE FUNCTION fleet_wallet_measures() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('agentId', a.agent_id, 'name', a.name, 'status', a.status) || fleet_agent_wallet_measure(a.agent_id) ORDER BY a.created_at), '[]'::jsonb)
    FROM fleet_agents a WHERE a.status IN ('active','unresponsive') AND EXISTS (SELECT 1 FROM fleet_ledger_accounts x WHERE x.agent_id = a.agent_id)
$$;

CREATE OR REPLACE FUNCTION fleet_agent_insolvent(p_agent text) RETURNS boolean LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT (fleet_agent_wallet_measure(p_agent) ->> 'exhausted')::boolean
$$;

-- The lifecycle pass: an exhausted active agent dies (cause insolvent; the estate flow follows). Each agent is decided under
-- its own row and account locks, so a debit, receipt or allocation either commits before (and is seen) or waits.
CREATE OR REPLACE FUNCTION svc_insolvency_tick() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a record; g fleet_agents; m jsonb; nx integer := 0; nh integer := 0;
BEGIN
  FOR a IN SELECT agent_id FROM fleet_agents WHERE status = 'active' AND EXISTS (SELECT 1 FROM fleet_ledger_accounts x WHERE x.agent_id = fleet_agents.agent_id)
            ORDER BY agent_id LOOP
    IF NOT fleet_agent_insolvent(a.agent_id) THEN CONTINUE; END IF;
    SELECT * INTO g FROM fleet_agents WHERE agent_id = a.agent_id FOR UPDATE;
    IF g.status <> 'active' THEN CONTINUE; END IF;
    IF g.operator_hold_at IS NOT NULL THEN nh := nh + 1; CONTINUE; END IF;
    PERFORM 1 FROM fleet_ledger_accounts WHERE agent_id = a.agent_id ORDER BY account_id FOR UPDATE;
    m := fleet_agent_wallet_measure(a.agent_id);
    IF NOT (m ->> 'exhausted')::boolean THEN CONTINUE; END IF;
    INSERT INTO fleet_agent_insolvency (agent_id, status, ended_at, detail)
      VALUES (a.agent_id, 'died', now(), jsonb_build_object('measure', m - 'rule', 'economics', fleet_agent_economics(a.agent_id) - 'genesisAllocation'));
    PERFORM fleet_event('agent_wallet_exhausted', a.agent_id, 'controller', jsonb_build_object('measure', m - 'rule'));
    PERFORM fleet_mark_dead(a.agent_id, 'wallet exhausted: nothing spendable and no money of its own held', 'controller', 'insolvent');
    nx := nx + 1;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'died', nx, 'heldByOwner', nh);
END $$;

-- v50's dormancy policy is retired (the rule is fixed: exhaustion is death); its row stays as history.
CREATE OR REPLACE FUNCTION fleet_admin_insolvency_policy_set(p_dormancy boolean, p_death_after_hours integer, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'FLEET_RETIRED: exhaustion is death (schema v51); there is no dormancy or grace setting';
END $$;

CREATE OR REPLACE FUNCTION fleet_insolvency_json() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('rule', 'exhaustion is death (no dormancy, no grace, no rescue)',
    'measures', fleet_wallet_measures(),
    'deaths', COALESCE((SELECT jsonb_agg(jsonb_build_object('agentId', i.agent_id, 'status', i.status, 'at', i.since, 'detail', i.detail) ORDER BY i.since DESC)
                        FROM (SELECT * FROM fleet_agent_insolvency ORDER BY since DESC LIMIT 100) i), '[]'::jsonb))
$$;

UPDATE fleet_agent_insolvency SET status = 'cleared', ended_at = now(), detail = detail || '{"closedBy":"v51: dormancy retired"}'::jsonb WHERE status = 'dormant';
UPDATE fleet_insolvency_policy SET dormancy_enabled = false, death_after_hours = NULL, updated_by = 'migration', updated_at = now() WHERE id = 1;

${ECONOMICS}

${SURVIVAL}

${WALLET}

-- ═══ 6. Fleet Control decides automatically ═══
${CAPITAL_DECIDE}

-- A sweep-reduction request decided at once: granted (bounded by the capital policy's reinvestment reduction and envelope
-- term) when the agent has after-tax profit to retain and an active venture to reinvest in; declined otherwise.
CREATE FUNCTION fleet_sweep_reduction_decide(p_request uuid) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE rq fleet_sweep_rate_reduction_requests; p fleet_capital_policy; s jsonb; v_bp integer; v_days integer; v_id uuid; v_reason text;
BEGIN
  SELECT * INTO rq FROM fleet_sweep_rate_reduction_requests WHERE request_id = p_request FOR UPDATE;
  IF rq.status <> 'pending' THEN RETURN jsonb_build_object('status', rq.status); END IF;
  SELECT * INTO p FROM fleet_capital_policy WHERE id = 1;
  s := fleet_sweep_compute(rq.agent_id);
  v_reason := CASE
    WHEN EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = rq.agent_id AND (status <> 'active' OR operator_hold_at IS NOT NULL)) THEN 'AGENT_NOT_ELIGIBLE'
    WHEN COALESCE((s ->> 'afterTaxUncontributedProfitMinor')::bigint, 0) <= 0 THEN 'NO_PROFIT_TO_RETAIN'
    WHEN NOT EXISTS (SELECT 1 FROM fleet_ventures WHERE agent_id = rq.agent_id AND state NOT IN ('failed','closed')) THEN 'NO_ACTIVE_VENTURE'
    WHEN COALESCE(p.reinvestment_reduction_bp, 0) <= 0 THEN 'POLICY_ALLOWS_NO_REDUCTION' END;
  IF v_reason IS NOT NULL THEN
    UPDATE fleet_sweep_rate_reduction_requests SET status = 'declined', decided_at = now() WHERE request_id = p_request;
    PERFORM fleet_event('sweep_reduction_decided', rq.agent_id, 'controller', jsonb_build_object('requestId', p_request, 'outcome', 'declined', 'reason', v_reason));
    RETURN jsonb_build_object('status', 'declined', 'reason', v_reason);
  END IF;
  v_bp := LEAST(rq.reduction_bp, p.reinvestment_reduction_bp);
  v_days := LEAST(rq.days, p.envelope_days, 180);
  UPDATE fleet_sweep_rate_reduction_requests SET status = 'granted', decided_at = now() WHERE request_id = p_request;
  INSERT INTO fleet_sweep_rate_reductions (agent_id, request_id, reduction_bp, reason, expires_at, decided_by)
    VALUES (rq.agent_id, p_request, v_bp, left(rq.reason, 1000), now() + make_interval(days => v_days), 'controller') RETURNING reduction_id INTO v_id;
  PERFORM fleet_event('sweep_reduction_decided', rq.agent_id, 'controller', jsonb_build_object('requestId', p_request, 'outcome', 'granted', 'reductionId', v_id,
    'reductionBp', v_bp, 'days', v_days, 'requestedBp', rq.reduction_bp, 'policyVersion', p.version));
  RETURN jsonb_build_object('status', 'granted', 'reductionId', v_id, 'reductionBp', v_bp, 'days', v_days, 'sweep', fleet_sweep_compute(rq.agent_id) - 'livingAgents');
END $$;

${SWEEP_REQUEST}

-- ═══ 7. Documents under the standing authority ═══
ALTER TABLE fleet_identity_autonomy ADD COLUMN document_classes text[] NOT NULL DEFAULT '{}' CHECK (document_classes <@ ARRAY[${q(DOCUMENT_CLASSES)}]::text[]);

CREATE FUNCTION fleet_admin_identity_documents_set(p_classes text[], p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_identity_autonomy;
BEGIN
  ${OWNER_ACTOR}
  IF NOT (COALESCE(p_classes, '{}') <@ ARRAY[${q(DOCUMENT_CLASSES)}]::text[]) THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: documents are among ${DOCUMENT_CLASSES.join(", ")}'; END IF;
  UPDATE fleet_identity_autonomy SET document_classes = ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_classes, '{}')) x ORDER BY x), set_by = p_actor, set_at = now()
   WHERE id = 1 RETURNING * INTO r;
  INSERT INTO fleet_identity_autonomy_history (snapshot, changed_by) VALUES (to_jsonb(r) - 'id', p_actor);
  PERFORM fleet_event('identity_documents_set', NULL, p_actor, jsonb_build_object('documentClasses', to_jsonb(r.document_classes), 'enabled', r.enabled));
  RETURN jsonb_build_object('ok', true, 'autonomy', fleet_identity_autonomy_json());
END $$;

${AUTONOMY_JSON}

ALTER TABLE fleet_browser_secret_requests DROP CONSTRAINT fleet_browser_secret_requests_kind_check;
ALTER TABLE fleet_browser_secret_requests ADD CONSTRAINT fleet_browser_secret_requests_kind_check
  CHECK (kind IN ('password','username','email','totp','email_code','sms_code','api_key','generate_password','auth_link','capture','owner_fact','owner_card','owner_document'));
ALTER TABLE fleet_browser_secret_requests DROP CONSTRAINT fleet_browser_secret_requests_owner_class_check;
ALTER TABLE fleet_browser_secret_requests ADD CONSTRAINT fleet_browser_secret_requests_owner_class_check
  CHECK (owner_class IN (${q([...FILLABLE_CLASSES, "payment_card", ...DOCUMENT_CLASSES])}));
ALTER TABLE fleet_browser_secret_requests DROP CONSTRAINT fleet_browser_secret_requests_owner;
ALTER TABLE fleet_browser_secret_requests ADD CONSTRAINT fleet_browser_secret_requests_owner CHECK ((kind IN ('owner_fact','owner_card','owner_document')) = (owner_class IS NOT NULL)
    AND (kind <> 'owner_card' OR (owner_class = 'payment_card' AND charge_id IS NOT NULL AND owner_field IS NOT NULL))
    AND (kind <> 'owner_document' OR owner_class IN (${q(DOCUMENT_CLASSES)})));
-- A document travels sealed (up to ~11 MB once encoded); every other value stays within 64 kB.
ALTER TABLE fleet_browser_secret_requests DROP CONSTRAINT fleet_browser_secret_requests_sealed_check;
ALTER TABLE fleet_browser_secret_requests ADD CONSTRAINT fleet_browser_secret_requests_sealed_check
  CHECK (octet_length(sealed) <= CASE WHEN kind = 'owner_document' THEN 16000000 ELSE 64000 END);

${STEPS_VALID}

${SECRET_REQUEST}

-- ═══ 8. Freeze stops local use ═══
${ACCOUNT_FREEZE}

${IDENTITY_ENQUEUE}

-- ═══ 9. Knowledge revision 2 ═══
ALTER TABLE fleet_knowledge_library ADD COLUMN recommendations text[] NOT NULL DEFAULT '{}';
CREATE OR REPLACE FUNCTION fleet_admin_knowledge_library_load(p_library jsonb, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE e jsonb; n integer := 0; v_cur integer;
BEGIN
  IF p_actor IS NULL OR (p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' AND p_actor <> 'migration') THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  IF p_library IS NULL OR jsonb_typeof(p_library -> 'entries') <> 'array' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: {entries:[…]}'; END IF;
  FOR e IN SELECT x FROM jsonb_array_elements(p_library -> 'entries') x LOOP
    SELECT version INTO v_cur FROM fleet_knowledge_library WHERE entry_id = e ->> 'id' AND current;
    IF v_cur IS NOT NULL AND v_cur >= (e ->> 'version')::integer THEN CONTINUE; END IF;
    UPDATE fleet_knowledge_library SET current = false WHERE entry_id = e ->> 'id' AND current;
    INSERT INTO fleet_knowledge_library (entry_id, version, category, title, body, tags, keywords, facts, hard_rules, sources, last_reviewed, loaded_by, recommendations)
      VALUES (e ->> 'id', (e ->> 'version')::integer, e ->> 'category', e ->> 'title', e ->> 'body',
        ARRAY(SELECT jsonb_array_elements_text(COALESCE(e -> 'tags', '[]'))), ARRAY(SELECT jsonb_array_elements_text(COALESCE(e -> 'keywords', '[]'))),
        COALESCE(e -> 'factsThatChange', '[]'), ARRAY(SELECT jsonb_array_elements_text(COALESCE(e -> 'hardRules', '[]'))), COALESCE(e -> 'sources', '[]'),
        (e ->> 'lastReviewed')::date, p_actor, ARRAY(SELECT jsonb_array_elements_text(COALESCE(e -> 'recommendations', '[]'))));
    n := n + 1;
  END LOOP;
  IF n > 0 AND p_actor <> 'migration' THEN PERFORM fleet_event('knowledge_library_loaded', NULL, p_actor, jsonb_build_object('entries', n)); END IF;
  RETURN jsonb_build_object('ok', true, 'loaded', n, 'current', (SELECT count(*) FROM fleet_knowledge_library WHERE current));
END $$;

${restate(V50_SQL, "fleet_knowledge_library_entry_json", [
  [`    'hardRules', to_jsonb(k.hard_rules),`, `    'hardRules', to_jsonb(k.hard_rules), 'recommendations', to_jsonb(k.recommendations),`],
])}

${restate(V50_SQL, "fleet_knowledge_library_search", [
  [`    'entries', COALESCE((SELECT jsonb_agg(fleet_knowledge_library_entry_json(row(s.entry_id, s.version, s.category, s.title, s.body, s.tags, s.keywords, s.facts, s.hard_rules,
        s.sources, s.last_reviewed, s.loaded_by, s.loaded_at, s.current)::fleet_knowledge_library, p_full) ORDER BY s.score DESC, s.entry_id)`,
   `    'entries', COALESCE((SELECT jsonb_agg(fleet_knowledge_library_entry_json(row(s.entry_id, s.version, s.category, s.title, s.body, s.tags, s.keywords, s.facts, s.hard_rules,
        s.sources, s.last_reviewed, s.loaded_by, s.loaded_at, s.current, s.recommendations)::fleet_knowledge_library, p_full) ORDER BY s.score DESC, s.entry_id)`],
  [`'researched guidance (2026-10-08), not a rule set: hard rules are non-negotiable; check facts marked stale or unverified before relying on them')`,
   `'researched guidance (revision 2, 2026-10-08), not a rule set: hard rules are sourced requirements (law, a regulator or the platform''s own terms, named in each); recommendations are advice; check facts marked stale or unverified before relying on them')`],
])}

SELECT fleet_admin_knowledge_library_load(${lit(LIBRARY2)}::jsonb, 'migration');

-- ═══ 10. Communications onboarding: provider secrets sealed to the identity broker ═══
CREATE TABLE fleet_provider_secret_inbox (
  upload_id    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text        NOT NULL CHECK (name IN (${q(PROVIDER_SECRET_UPLOADS)})),
  sealed       bytea       CHECK (octet_length(sealed) BETWEEN 32 AND 64000),
  status       text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','installed','failed')),
  error        text        CHECK (length(error) <= 200),
  uploaded_by  text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  installed_at timestamptz,
  CHECK ((status = 'pending') = (sealed IS NOT NULL))
);
CREATE TRIGGER fleet_provider_secret_inbox_no_delete BEFORE DELETE ON fleet_provider_secret_inbox FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION fleet_admin_provider_secret_upload(p_name text, p_sealed bytea, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  ${OWNER_ACTOR}
  IF p_name IS NULL OR p_name NOT IN (${q(PROVIDER_SECRET_UPLOADS)}) THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: ${PROVIDER_SECRET_UPLOADS.join(" or ")}'; END IF;
  IF p_sealed IS NULL OR octet_length(p_sealed) NOT BETWEEN 32 AND 64000 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: a sealed secret (sealed in the browser to the broker''s key)'; END IF;
  INSERT INTO fleet_provider_secret_inbox (name, sealed, uploaded_by) VALUES (p_name, p_sealed, p_actor) RETURNING upload_id INTO v_id;
  PERFORM fleet_event('provider_secret_uploaded', NULL, p_actor, jsonb_build_object('uploadId', v_id, 'name', p_name));
  RETURN jsonb_build_object('ok', true, 'uploadId', v_id, 'note', 'the identity broker installs it and connects the provider at its next pass');
END $$;

CREATE FUNCTION ix_provider_secret_inbox(p_worker text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  ${IXWORKER}
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('uploadId', upload_id, 'name', name, 'sealedB64', encode(sealed, 'base64')) ORDER BY created_at)
    FROM fleet_provider_secret_inbox WHERE status = 'pending'), '[]'::jsonb);
END $$;

CREATE FUNCTION ix_provider_secret_installed(p_upload uuid, p_worker text, p_ok boolean, p_error text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r fleet_provider_secret_inbox;
BEGIN
  ${IXWORKER}
  UPDATE fleet_provider_secret_inbox SET status = CASE WHEN p_ok THEN 'installed' ELSE 'failed' END, sealed = NULL, error = CASE WHEN p_ok THEN NULL ELSE left(p_error, 200) END,
         installed_at = now() WHERE upload_id = p_upload AND status = 'pending' RETURNING * INTO r;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  PERFORM fleet_event('provider_secret_installed', NULL, 'identity-broker', jsonb_build_object('uploadId', p_upload, 'name', r.name, 'ok', p_ok,
    'error', CASE WHEN p_ok THEN NULL ELSE left(p_error, 200) END));
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE FUNCTION fleet_provider_secrets_json() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'uploads', COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('uploadId', upload_id, 'name', name, 'status', status, 'error', error, 'at', created_at,
        'installedAt', installed_at)) ORDER BY created_at DESC) FROM (SELECT * FROM fleet_provider_secret_inbox ORDER BY created_at DESC LIMIT 20) u), '[]'::jsonb),
    'brokerKey', (SELECT jsonb_build_object('fingerprint', k.fingerprint, 'publishedAt', k.published_at) FROM fleet_identity_broker_keys k WHERE k.id = 1),
    'comms', fleet_admin_comms_status())
$$;

-- ═══ 11. Agent operations, dashboard, routing ═══
${DISPATCH}

${DASH_CALL}

${EVENT_ROUTE}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

/**
 * Schema v109 — a closed order's email goes to the owner, never into paid agent work (owner, 2026-10-21: "Apply the
 * owner-approved conversation closure policy consistently to order pages and email. Do not turn closed-order messages into
 * ordinary agent mail that triggers paid work. Preserve them for owner review").
 *
 * v108 attached a buyer's emailed reply to an OPEN order's thread and left a closed order's mail with the agent as ordinary
 * (waking) mail. Now, in the same transaction that stores it: mail from the buyer's own address that continues a CLOSED
 * order's thread — or from a buyer whose orders with that agent are all closed — is re-routed to the owner (unassigned,
 * with the reason), so the agent never sees or wakes on it; the owner is told (P2). The owner can still hand it to the
 * agent (fleet_admin_mail_assign). Mail from anyone else, and a buyer's mail about an open order, are unchanged.
 *
 * Also — the card proof's merchant account (owner, 2026-10-21: "merchant/account prerequisites have a supported authorization
 * path"): a card-proof release (v108) may, instead of naming an existing account, allow `account_register` at its one
 * merchant origin; the account the agent registers there under that release is then the one its browser fill and its ONE
 * card request may use. Nothing else changes: one origin, one purchase, ≤ 500p, ≤ 24 h. Agents are told how to propose a
 * purchase (fleet-capability-status v16: capabilities op request) — the owner decides the release.
 */
import { V108_SQL } from "./migrations-phase108.js";
import { restate as restateRaw } from "./migrations-phase42.js";
import { CAPABILITY_STATUS_V14 } from "./knowledge-capability-status-v14.js";
import { V15_ENTRIES } from "./migrations-phase108.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));

const TO_ORDER = restate(V108_SQL, "fleet_mail_to_order", [
  [`  IF v_order IS NULL THEN RETURN; END IF;`,
   `  -- v109: a buyer whose orders with this agent are all closed: their mail is the owner's to review.
  IF v_order IS NULL THEN
    SELECT (array_agg(z.order_id ORDER BY z.created_at DESC))[1] INTO v_order FROM fleet_customer_orders z
     WHERE z.agent_id = mm.agent_id AND lower(z.buyer_email) = lower(mm.sender_address) AND NOT (fleet_order_conversation(z) ->> 'open')::boolean
       AND NOT EXISTS (SELECT 1 FROM fleet_customer_orders y WHERE y.agent_id = mm.agent_id AND lower(y.buyer_email) = lower(mm.sender_address)
                        AND y.payment_status IN ('paid','partially_refunded') AND (fleet_order_conversation(y) ->> 'open')::boolean);
  END IF;
  IF v_order IS NULL THEN RETURN; END IF;`],
  [`  IF NOT (fleet_order_conversation(o) ->> 'open')::boolean THEN RETURN; END IF;`,
   `  IF NOT (fleet_order_conversation(o) ->> 'open')::boolean THEN
    -- v109: never the agent's ordinary (waking) mail: kept for the owner, who may hand it to the agent.
    UPDATE fleet_agent_mail SET agent_id = NULL, mailbox_id = NULL, venture_id = NULL, account_id = NULL, routing = 'unassigned',
           routing_reason = left('a buyer''s message about a closed order (' || (fleet_order_conversation(o) ->> 'reason') || '): kept for the owner''s review, not agent work', 300)
     WHERE message_id = mm.message_id;
    PERFORM fleet_event('closed_order_mail', NULL, 'controller', jsonb_build_object('messageId', mm.message_id, 'orderId', o.order_id, 'agentId', o.agent_id,
      'reason', fleet_order_conversation(o) ->> 'reason', 'note', 'a buyer wrote about a closed order: the mail is with you (Mail, unassigned); hand it to the agent only if it needs work'));
    RETURN;
  END IF;`],
]);

// ── the card proof's merchant account ──
const RELEASE = restate(V108_SQL, "fleet_admin_outward_release", [
  [`      OR jsonb_array_length(COALESCE(p_scope -> 'accounts', '[]'::jsonb)) <> 1 OR jsonb_typeof(p_scope -> 'cardMaxMinor') IS DISTINCT FROM 'number'`,
   `      OR (jsonb_array_length(COALESCE(p_scope -> 'accounts', '[]'::jsonb)) <> 1
          AND NOT (v_acts ? 'account_register' AND jsonb_array_length(COALESCE(p_scope -> 'accounts', '[]'::jsonb)) = 0))
      OR jsonb_typeof(p_scope -> 'cardMaxMinor') IS DISTINCT FROM 'number'`],
  [`card is one purchase: with browser, exactly one origin and one account,`, `card is one purchase: with browser, exactly one origin and one account (or account_register there, with no account named),`],
]);
const REFUSAL = restate(V108_SQL, "fleet_outward_refusal", [
  [`    IF NOT COALESCE(r.scope -> 'accounts', '[]'::jsonb) ? COALESCE(a ->> 'accountId', '') THEN
      RETURN format('the card-proof release covers one purchase at %s (its account) only', r.scope ->> 'cardMerchant');`,
   `    IF NOT (COALESCE(r.scope -> 'accounts', '[]'::jsonb) ? COALESCE(a ->> 'accountId', '') OR fleet_release_registered_account(r, a ->> 'accountId')) THEN
      RETURN format('the card-proof release covers one purchase at %s (its account) only', r.scope ->> 'cardMerchant');`],
  [`    IF s.account_id IS NULL OR NOT COALESCE(r.scope -> 'accounts', '[]'::jsonb) ? s.account_id::text THEN`,
   `    IF s.account_id IS NULL OR NOT (COALESCE(r.scope -> 'accounts', '[]'::jsonb) ? s.account_id::text OR fleet_release_registered_account(r, s.account_id::text)) THEN`],
]);

// fleet-capability-status v16: v15 plus the card-proof proposal path and closed-order mail.
const V16_FACTS = [
  { fact: "One card purchase before launch — while sales are closed, a card request is held unless the owner grants a card-proof release for ONE purchase at ONE merchant (at most £5, at most 24 hours; registering an account there if you need one). To propose it, use capabilities op request with the merchant's site, what you would buy and why it matters to your work, and the amount; the owner decides. The reservation comes from your own cash, Fleet Control reviews it as any card request, and the card statement settles it", verifyAt: [], confidence: "verified-official", lastChecked: "2026-10-21", staleAfterDays: 14 },
  { fact: "Closed orders — a buyer's email about a closed order goes to the owner, not to you (no obligation, no wake); the owner hands it to you if it needs work", verifyAt: [], confidence: "verified-official", lastChecked: "2026-10-21", staleAfterDays: 14 },
] as const;
const V16 = V15_ENTRIES.map((e) => ({ ...e, version: 16, lastReviewed: "2026-10-21", title: "Fleet capability status (dated 2026-10-21, v16) — what works today",
  factsThatChange: [...e.factsThatChange, ...V16_FACTS] }));
void CAPABILITY_STATUS_V14;

export const EVENT_ROUTES_V109 = Object.freeze({ P2_IMPORTANT: ["closed_order_mail"] } as const);

export const V109_SQL = `
${TO_ORDER}

-- An account the agent registered under a card-proof release that allows account_register, at its one merchant origin.
CREATE FUNCTION fleet_release_registered_account(r fleet_outward_release, p_account text) RETURNS boolean LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT (r.scope -> 'actions') ? 'card' AND (r.scope -> 'actions') ? 'account_register' AND p_account ~ '^[0-9a-f-]{36}$'
     AND EXISTS (SELECT 1 FROM fleet_agent_accounts c WHERE c.account_id::text = p_account AND c.agent_id = r.agent_id AND c.created_at >= r.released_at
                  AND ((r.scope -> 'origins') ->> 0) = ANY (c.origins))
$$;

${RELEASE}

${REFUSAL}

SELECT fleet_admin_knowledge_library_load('${JSON.stringify({ entries: V16 }).replace(/'/g, "''")}'::jsonb, 'migration');

-- The owner is told of closed-order mail (P2).
${restateRaw(V108_SQL, "fleet_event_route", [["    WHEN p_type = 'spend_circuit_breaker_set' THEN",
  "    WHEN p_type = 'closed_order_mail' THEN 'P2_IMPORTANT'\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"]])}

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

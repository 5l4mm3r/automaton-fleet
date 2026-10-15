/**
 * Schema v81 — the owner's launch and channel onboarding in the dashboard (owner brief, 2026-10-15). v80 (7c35383, the
 * consolidated candidate) is not edited; v81 restates the dashboard gateway only.
 *
 * The dashboard gains one read and six owner operations, so the owner sees and does the onboarding that until now was
 * command-line only:
 *  - read `launch`: the legal seller and each venture's storefront, the public site and sales state, every agent channel with
 *    its API connection and check result, the controlled-proof releases (scope, expiry), discovery, and the standing external
 *    dependencies (Etsy buyer messages, Etsy bank payouts, token renewal, Pinterest Standard access);
 *  - `seller_set` and `public_site_set` (step-up): the legal seller facts and the public site (sales stay closed);
 *  - `outward_release` (step-up) / `outward_hold`: a scoped, expiring controlled-proof release — which permits PUBLIC external
 *    actions — and ending it;
 *  - `channel_connect` (step-up) / `channel_disconnect`: bind an agent channel to the API account the owner authorised on
 *    the host (the OAuth exchange itself stays on the host: the token never passes through the dashboard).
 * Opening sales (launch) stays a deliberate command-line step and is not offered here.
 */
import { V76_SQL } from "./migrations-phase76.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));
const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

export const DASHBOARD_READ_OPS_V81 = ["launch"] as const;
export const DASHBOARD_SENSITIVE_OPS_V81 = ["seller_set", "public_site_set", "outward_release", "channel_connect"] as const;
export const DASHBOARD_WRITE_OPS_V81_ADDED = ["outward_hold", "channel_disconnect"] as const;

const DASH_CALL = restate(V76_SQL, "dash_call", [
  [`'capital_back','ai_credit_opening','spend_review_decide');`, `'capital_back','ai_credit_opening','spend_review_decide',${q(DASHBOARD_SENSITIVE_OPS_V81)});`],
  [`'label_set','agent_cognition_set','mail_dismiss','mail_delete');`, `'label_set','agent_cognition_set','mail_dismiss','mail_delete',${q(DASHBOARD_WRITE_OPS_V81_ADDED)});`],
  [`'agent_thread','agent_mind','mail_summary')) THEN`, `'agent_thread','agent_mind','mail_summary',${q(DASHBOARD_READ_OPS_V81)})) THEN`],
  [`      WHEN 'offers' THEN fleet_offers_admin_json(a ->> 'agentId')`,
   `      WHEN 'offers' THEN fleet_offers_admin_json(a ->> 'agentId')
      WHEN 'launch' THEN fleet_launch_status_json()`],
  [`      WHEN 'agent_rename' THEN fleet_admin_agent_rename(a ->> 'agentId', a ->> 'name', 'operator:owner')`,
   `      WHEN 'agent_rename' THEN fleet_admin_agent_rename(a ->> 'agentId', a ->> 'name', 'operator:owner')
      WHEN 'outward_hold' THEN fleet_admin_outward_hold(a ->> 'agentId', 'operator:owner')
      WHEN 'channel_disconnect' THEN fleet_admin_channel_disconnect((a ->> 'channelId')::uuid, 'operator:owner')`],
  [`      WHEN 'ai_credit_opening' THEN fleet_admin_ai_credit_opening('operator:owner')`,
   `      WHEN 'ai_credit_opening' THEN fleet_admin_ai_credit_opening('operator:owner')
      WHEN 'seller_set' THEN fleet_admin_seller_set(COALESCE(a -> 'fields', '{}'::jsonb), 'operator:owner')
      WHEN 'public_site_set' THEN fleet_admin_public_site_set(a ->> 'url', NULLIF(a ->> 'notice', ''), 'operator:owner')
      WHEN 'outward_release' THEN fleet_admin_outward_release(a ->> 'agentId', a -> 'scope', a ->> 'note', 'operator:owner')
      WHEN 'channel_connect' THEN fleet_admin_channel_connect((a ->> 'channelId')::uuid, a ->> 'provider', a ->> 'vaultRef', a ->> 'account', NULLIF(a ->> 'shopId', ''), 'operator:owner')`],
]);

export const V81_SQL = `
-- ═══ The owner's launch & channels view (read only) ═══
CREATE FUNCTION fleet_launch_status_json() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'seller', fleet_admin_seller(),
    'publicSite', COALESCE((SELECT jsonb_build_object('url', base_url, 'notice', seller_notice, 'salesOpen', sales_open, 'setAt', set_at) FROM fleet_public_site WHERE id = 1),
                           jsonb_build_object('url', NULL, 'salesOpen', false)),
    'releases', fleet_admin_outward_list() -> 'releases',
    'channels', COALESCE((SELECT jsonb_agg(jsonb_build_object('agentId', c.agent_id, 'channelId', c.channel_id, 'ventureKey', v.venture_key, 'name', c.name, 'kind', c.kind,
        'status', c.status, 'url', c.url, 'rulesRecorded', c.rules_source IS NOT NULL AND c.rules_summary IS NOT NULL, 'payoutRoute', c.payout_route,
        'connection', (SELECT jsonb_build_object('provider', x.provider, 'status', x.status, 'checkError', x.check_error, 'checkedAt', x.checked_at, 'vaultRef', x.vault_ref,
                         'account', x.expected_account, 'shopId', x.shop_id) FROM fleet_channel_connections x WHERE x.channel_id = c.channel_id),
        'liveItems', (SELECT count(*) FROM fleet_presence_items p WHERE p.channel_id = c.channel_id AND p.status = 'live'),
        'payoutsAwaitingOwner', (SELECT count(*) FROM fleet_channel_payouts p WHERE p.channel_id = c.channel_id AND p.status = 'needs_owner'))
      ORDER BY c.agent_id, c.created_at) FROM fleet_venture_channels c JOIN fleet_ventures v ON v.venture_id = c.venture_id WHERE c.status <> 'dropped'), '[]'::jsonb),
    'apiJobs24h', fleet_channel_api_admin_json() -> 'jobs24h',
    'discovery', (SELECT jsonb_build_object('lastPingAt', last_ping_at, 'lastStatus', last_status, 'pingedTotal', pinged_total) FROM fleet_discovery WHERE id = 1),
    'dependencies', jsonb_build_array(
      'Etsy buyer messages: Etsy has no messaging API and its terms do not permit automating its website, so buyers'' Etsy messages must be answered by a person (you or someone you appoint) for as long as Etsy is used; digital downloads are delivered by Etsy automatically, and the agent can draft replies you paste.',
      'Etsy payouts: Etsy pays your bank. Each payout becomes the agent''s cash only after you record its bank line and the transfer into the treasury PayPal (several payouts may share one transfer).',
      'API tokens: the channel gateway refreshes them itself. If a provider stops renewing a refresh token (Etsy states 90 days; Pinterest a year), the connection fails its check and you re-authorise once.',
      'Pinterest: Pins stay visible only to their creator until Pinterest grants the app Standard access (your video submission).'))
$$;

${DASH_CALL}
`;

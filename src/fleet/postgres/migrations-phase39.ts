/**
 * Schema v39 — replication accounting correction (owner decision 2026-10-02).
 *
 * Three figures, never collapsed into one balance:
 *   A. TREASURY CASH — real spendable Treasury funds now (every treasury_cash partition).
 *   B. OWNER-CONTRIBUTED FUNDING — capital the owner injected (fleet:owner:capital), with owner withdrawals shown
 *      beside it. Funding, never profit.
 *   C. FLEET-GENERATED REALISED WEALTH — the Lifetime Fleet Contribution (fleet:profit): cumulative realised NET profit
 *      the agents contributed to the Treasury (profit contributions and sweeps). Owner funding never enters it, and a
 *      fall in current liquidity never lowers it (only an exact ledger reversal of a contribution does).
 *
 * The automatic-replication TRIGGER is C against the ladder ("has the Fleet earned enough to justify another agent?").
 * The 24-hour HEALTH GATE is separate ("can it safely afford one now?"): Treasury cash covers obligations and the next
 * Genesis allocation, ventures and commitments stay funded, vulnerable businesses keep their red-zone headroom, no open
 * RED. Owner funding spent on Fleet activity is not a debt to be earned back before C counts. The high-water mark is
 * unchanged: a used threshold never triggers again.
 */

import { DASHBOARD_READ_OPS, V38_SQL } from "./migrations-phase38.js";

function restate(src: string, name: string, edits: Array<[string, string]>): string {
  const head = Math.max(src.lastIndexOf(`CREATE FUNCTION ${name}(`), src.lastIndexOf(`CREATE OR REPLACE FUNCTION ${name}(`));
  if (head < 0) throw new Error(`v39: function ${name} not found`);
  const end = src.indexOf("$$;", src.indexOf("AS $$", head) + 5);
  let body = "CREATE OR REPLACE " + src.slice(src.indexOf("FUNCTION", head), end + 3);
  for (const [from, to] of edits) {
    if (body.split(from).length !== 2) throw new Error(`v39: expected text not found exactly once in ${name}: ${from.slice(0, 60)}`);
    body = body.replace(from, to);
  }
  return body;
}

/** v39: reads the Next.js control centre needs (Fleet knowledge, agents' mail and SMS, the audit trail, all settings). */
export const DASHBOARD_READ_OPS_V39 = [...DASHBOARD_READ_OPS, "knowledge", "mail", "sms", "events", "settings"] as const;
const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

const DASH_CALL = restate(V38_SQL, "dash_call", [
  [`p_op IN (${q(DASHBOARD_READ_OPS)})`, `p_op IN (${q(DASHBOARD_READ_OPS_V39)})`],
  [`      WHEN 'reveal_log' THEN fleet_admin_reveal_log(200)`, `      WHEN 'reveal_log' THEN fleet_admin_reveal_log(200)
      WHEN 'knowledge' THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('knowledgeId', k.knowledge_id, 'agentId', k.agent_id, 'topic', k.topic, 'subject', k.subject,
          'claim', k.claim, 'evidence', k.evidence, 'outcomeBacked', k.outcome_backed, 'confidenceBp', k.confidence_bp, 'observedAt', k.observed_at,
          'expiresAt', k.expires_at, 'superseded', k.superseded_at IS NOT NULL) ORDER BY k.observed_at DESC)
          FROM (SELECT * FROM fleet_economic_knowledge WHERE (a ->> 'topic' IS NULL OR topic = a ->> 'topic')
                  AND (a ->> 'query' IS NULL OR position(lower(a ->> 'query') IN lower(subject || ' ' || claim)) > 0)
                  AND (COALESCE((a ->> 'includeSuperseded')::boolean, false) OR superseded_at IS NULL)
                ORDER BY observed_at DESC LIMIT LEAST(COALESCE((a ->> 'limit')::integer, 200), 1000)) k), '[]'::jsonb)
      WHEN 'mail' THEN COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('messageId', m.message_id, 'agentId', m.agent_id, 'mailbox', b.address,
          'direction', m.direction, 'from', CASE m.direction WHEN 'in' THEN m.sender ELSE b.address END, 'to', CASE m.direction WHEN 'in' THEN to_jsonb(b.address) ELSE to_jsonb(m.recipients) END,
          'subject', m.subject, 'body', left(m.body, 20000), 'authenticationMessage', m.withheld, 'sendStatus', m.send_status, 'at', m.received_at)) ORDER BY m.received_at DESC)
          FROM (SELECT * FROM fleet_agent_mail WHERE (a ->> 'agentId' IS NULL OR agent_id = a ->> 'agentId') ORDER BY received_at DESC
                LIMIT LEAST(COALESCE((a ->> 'limit')::integer, 100), 500)) m JOIN fleet_agent_mailboxes b ON b.mailbox_id = m.mailbox_id), '[]'::jsonb)
      WHEN 'sms' THEN COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('smsId', x.sms_id, 'agentId', x.agent_id, 'number', n.e164, 'direction', x.direction,
          'counterparty', x.counterparty, 'body', x.body, 'authenticationMessage', x.withheld, 'sendStatus', x.send_status, 'at', x.at)) ORDER BY x.at DESC)
          FROM (SELECT * FROM fleet_agent_sms WHERE (a ->> 'agentId' IS NULL OR agent_id = a ->> 'agentId') ORDER BY at DESC
                LIMIT LEAST(COALESCE((a ->> 'limit')::integer, 100), 500)) x JOIN fleet_agent_phone_numbers n ON n.number_id = x.number_id), '[]'::jsonb)
      WHEN 'events' THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('at', e.created_at, 'type', e.event_type, 'agentId', e.agent_id, 'actor', e.actor, 'detail', e.detail)
          ORDER BY e.created_at DESC) FROM (SELECT * FROM fleet_events WHERE (a ->> 'type' IS NULL OR event_type = a ->> 'type')
            AND (a ->> 'agentId' IS NULL OR agent_id = a ->> 'agentId') ORDER BY created_at DESC LIMIT LEAST(COALESCE((a ->> 'limit')::integer, 200), 1000)) e), '[]'::jsonb)
      WHEN 'settings' THEN jsonb_build_object(
          'genesisCapital', (SELECT jsonb_build_object('currency', bootstrap_capital_currency, 'minor', bootstrap_capital_minor) FROM fleet_genesis_policy LIMIT 1),
          'replication', (SELECT to_jsonb(p) - 'id' FROM fleet_replication_policy p WHERE id = 1),
          'missions', (SELECT to_jsonb(p) - 'id' FROM fleet_mission_policy p WHERE id = 1),
          'risk', (SELECT to_jsonb(p) - 'id' FROM fleet_risk_policy p WHERE id = 1),
          'notifications', (SELECT to_jsonb(p) - 'id' - 'scan_watermark' FROM fleet_notification_policy p WHERE id = 1),
          'estates', (SELECT to_jsonb(p) - 'id' FROM fleet_estate_policy p WHERE id = 1),
          'sweeps', (SELECT to_jsonb(p) - 'id' FROM fleet_sweep_policy p LIMIT 1),
          'capital', (SELECT to_jsonb(p) - 'id' FROM fleet_capital_policy p LIMIT 1),
          'population', fleet_population(),
          'flags', jsonb_build_object('registryReplicationSwitch', (SELECT replication_enabled FROM fleet_state LIMIT 1), 'maxAgents', (SELECT max_agents FROM fleet_state LIMIT 1)))`],
]);

export const V39_SQL = `
CREATE OR REPLACE FUNCTION fleet_generated_treasury_wealth() RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_cash bigint := fleet_treasury_cash(); v_owner_in bigint := fleet_ledger_balance('fleet:owner:capital');
        v_owner_out bigint := fleet_ledger_balance('fleet:owner:withdrawals'); v_lfc bigint := fleet_ledger_balance('fleet:profit');
BEGIN
  RETURN jsonb_build_object(
    'treasuryCashMinor', v_cash,
    'ownerContributedMinor', v_owner_in,
    'ownerWithdrawnMinor', v_owner_out,
    'fleetGeneratedMinor', GREATEST(0, v_lfc),
    'basis', 'Fleet-generated realised wealth = the Lifetime Fleet Contribution (cumulative realised net profit contributed to the Treasury); owner funding is never counted and a fall in Treasury cash never reduces it');
END $$;

CREATE OR REPLACE FUNCTION fleet_replication_health() RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE s fleet_replication_state; w jsonb := fleet_generated_treasury_wealth(); v_threshold bigint; v_oblig bigint; v_genesis bigint;
        v_cash bigint; v_unfunded text[]; v_red_zone text[]; v_red integer; pop jsonb := fleet_population(); econ jsonb; gate jsonb; v_wealth bigint;
BEGIN
  SELECT * INTO s FROM fleet_replication_state WHERE id = 1;
  v_threshold := fleet_replication_threshold(s.thresholds_consumed);
  v_wealth := (w ->> 'fleetGeneratedMinor')::bigint;
  v_cash := (w ->> 'treasuryCashMinor')::bigint;
  SELECT COALESCE(sum(amount_cents), 0) INTO v_oblig FROM fleet_treasury_obligations WHERE status = 'approved';
  SELECT COALESCE(bootstrap_capital_minor, 0) INTO v_genesis FROM fleet_genesis_policy LIMIT 1;
  SELECT array_agg(a.agent_id ORDER BY a.agent_id) FILTER (WHERE (r ->> 'cashMinor')::bigint < (r ->> 'commitmentsDue30dMinor')::bigint),
         array_agg(a.agent_id ORDER BY a.agent_id) FILTER (WHERE (r ->> 'vulnerable')::boolean AND NOT (r ->> 'redZoneMet')::boolean)
    INTO v_unfunded, v_red_zone
    FROM fleet_agents a CROSS JOIN LATERAL fleet_agent_risk_context(a.agent_id) r WHERE a.status = 'active';
  SELECT count(*) INTO v_red FROM fleet_notifications WHERE class = 'RED' AND acknowledged_at IS NULL;
  -- The economic trigger: earned progress only.
  econ := jsonb_build_object('fleetGeneratedMinor', v_wealth, 'thresholdMinor', v_threshold, 'remainingMinor', GREATEST(0, v_threshold - v_wealth),
    'met', v_wealth >= v_threshold);
  -- The affordability gate: liquidity and the health of what already exists.
  gate := jsonb_build_object(
    'treasurySolvent', v_cash >= v_oblig,
    'genesisAllocationAvailable', v_cash - v_oblig >= COALESCE(v_genesis, 0),
    'businessesFunded', COALESCE(cardinality(v_unfunded), 0) = 0,
    'vulnerableCushionsHealthy', COALESCE(cardinality(v_red_zone), 0) = 0,
    'noOpenRed', v_red = 0);
  RETURN jsonb_build_object(
    'healthy', (econ ->> 'met')::boolean AND NOT EXISTS (SELECT 1 FROM jsonb_each(gate) WHERE value = 'false'::jsonb),
    'economic', econ, 'gate', gate,
    -- v35-compatible keys (the reaper and existing readers):
    'conditions', gate || jsonb_build_object('thresholdMet', econ -> 'met'),
    'thresholdMinor', v_threshold, 'nextAgentNumber', s.thresholds_consumed + 2, 'wealth', w,
    'treasuryObligationsMinor', v_oblig, 'genesisCapitalMinor', v_genesis, 'population', pop,
    'blockers', COALESCE((SELECT jsonb_agg(k ORDER BY k) FROM jsonb_each(gate) g(k, v) WHERE v = 'false'::jsonb), '[]'::jsonb)
                || CASE WHEN (econ ->> 'met')::boolean THEN '[]'::jsonb ELSE '["wealthThresholdNotMet"]'::jsonb END,
    'underfundedAgents', COALESCE(to_jsonb(v_unfunded), '[]'::jsonb), 'redZoneAgents', COALESCE(to_jsonb(v_red_zone), '[]'::jsonb));
END $$;

-- The dashboard's replication picture: the three figures, the next threshold and what remains, the 24 h window,
-- the living count and the high-water stage, and why a pending birth is healthy or blocked.
CREATE OR REPLACE FUNCTION fleet_admin_replication_status() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('policy', (SELECT to_jsonb(p) - 'id' FROM fleet_replication_policy p WHERE id = 1),
    'state', (SELECT to_jsonb(s) - 'id' - 'last_health' FROM fleet_replication_state s WHERE id = 1),
    'registrySwitch', (SELECT replication_enabled FROM fleet_state LIMIT 1),
    'health', fleet_replication_health(),
    'treasury', fleet_generated_treasury_wealth() - 'basis',
    'window', (SELECT jsonb_build_object('hours', p.window_hours, 'pendingSince', s.pending_since, 'phase', s.phase,
        'elapsedSeconds', CASE WHEN s.pending_since IS NOT NULL THEN floor(extract(epoch FROM now() - s.pending_since))::bigint END,
        'remainingSeconds', CASE WHEN s.pending_since IS NOT NULL THEN GREATEST(0, floor(p.window_hours * 3600 - extract(epoch FROM now() - s.pending_since)))::bigint END)
      FROM fleet_replication_state s, fleet_replication_policy p WHERE s.id = 1 AND p.id = 1),
    'stage', (SELECT jsonb_build_object('thresholdsConsumed', s.thresholds_consumed, 'highWaterMinor', s.high_water_minor,
        'nextAgentNumber', s.thresholds_consumed + 2) FROM fleet_replication_state s WHERE s.id = 1),
    'livingAgents', (SELECT count(*) FROM fleet_agents WHERE status IN ('provisioning','active')),
    'nextThresholds', (SELECT jsonb_agg(fleet_replication_threshold(s.thresholds_consumed + i) ORDER BY i) FROM fleet_replication_state s, generate_series(0, 3) i WHERE s.id = 1),
    'births', COALESCE((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.created_at DESC) FROM (SELECT * FROM fleet_birth_orders ORDER BY created_at DESC LIMIT 20) b), '[]'::jsonb))
$$;

${DASH_CALL}
`;

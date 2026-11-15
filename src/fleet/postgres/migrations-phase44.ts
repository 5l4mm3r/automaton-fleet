/**
 * Schema v44 — Fleet Command event routing (owner brief 2026-10-07, "Fleet Command event priority refactor").
 *
 * FLEET COMMAND = IMPORTANT THINGS HAPPENING TO THE FLEET, not everything the software did. fleet_events stays the one
 * append-only history (nothing is removed or rewritten; auditability is unchanged). This migration adds ONE
 * authoritative router, fleet_event_route(type, detail), and reads built on it:
 *
 *   P0_CRITICAL   security / integrity, system survival, Agent survival, safety gates
 *   P1_HIGH       Agent lifecycle, missions, projects, Treasury / shared capital, real money, owner money, replication,
 *                 infrastructure and blocking dependencies
 *   P2_IMPORTANT  commercial and economic milestones, collaboration terms, policy / cap changes, a production deployment
 *                 (one event per cutover) and an Agent runtime upgrade actually applied
 *   P3_SUMMARY    concise summaries (the daily report)
 *   AUDIT_ONLY    accountability / security mechanics: sessions, logins, role grants, ledger postings (the ledger is
 *                 its own record), notification housekeeping (deletion keeps its inbox tombstone), admin configuration
 *   AGENT_ACTIVITY_ONLY  the Agents' workstreams: research, decisions, opportunities, accounts, mail, progress
 *
 *   command_events (dashboard read)  only P0–P3, the limit applied AFTER routing (noise can never push a critical event
 *                                    out of the window), each row carrying its priority
 *   agent_events   (dashboard read)  an Agent's activity without AUDIT_ONLY mechanics
 *   events         (dashboard read)  unchanged (the full stream; Virtual HQ animates activity from it)
 *
 * An event type the table does not name routes to AUDIT_ONLY; a test requires every type the code emits to be named.
 * Read-only: no table, row or money changes; no economics, gate, cap or custody semantics touched.
 */
import { restate } from "./migrations-phase42.js";
import { V43_SQL, DASHBOARD_READ_OPS_V43 } from "./migrations-phase43.js";

export type EventPriority = "P0_CRITICAL" | "P1_HIGH" | "P2_IMPORTANT" | "P3_SUMMARY" | "AUDIT_ONLY" | "AGENT_ACTIVITY_ONLY";

/** The routing table: event type → priority. (A `notification` event routes by its class: see fleet_event_route.) */
export const EVENT_ROUTES: Readonly<Record<EventPriority, readonly string[]>> = Object.freeze({
  P0_CRITICAL: [
    // Agent survival
    "agent_died", "agent_orphaned", "agent_quarantined", "infrastructure_orphaned", "child_terminal_reported",
    // security / integrity
    "runtime_verification_failed", "genesis_attestation_failed", "genesis_runtime_auth_failed", "genesis_duplicate_runtime",
    "genesis_runtime_nonce_mismatch", "health_challenge_failed", "operator_replay_blocked", "request_replayed",
    // money / ledger integrity, safety
    "economy_failsafe", "spend_circuit_breaker_set", "settlement_conflict", "settlement_failed", "settlement_unattributed",
    "provider_cost_reconciliation_required", "estate_freeze_failed", "project_lifecycle_failed",
    "founder_runtime_upgrade_rolled_back", "founder_runtime_upgrade_aborted", "founder_runtime_rollback_verified", "genesis_rolled_back",
    "payment_destination_activation_failed", "provisioning_failed",
    // production survival: a cutover that had to roll back
    "production_rolled_back",
  ],
  P1_HIGH: [
    // lifecycle
    "agent_born", "agent_activated", "agent_hold_set", "agent_hold_released", "agent_terminating", "agent_unresponsive", "agent_recovered",
    "agent_sessions_revoked", "agent_credential_revoked", "agent_account_credentials_revoked",
    "birth_ordered", "birth_authorized", "birth_cancelled", "reservation_denied", "provisioning_uncertain",
    "genesis_proposed", "genesis_approved", "genesis_funded", "genesis_provisioned", "genesis_activated", "genesis_founder_attested", "genesis_founder_failed",
    // replication
    "replication_requested", "replication_granted", "replication_rejected", "replication_pending", "replication_pending_reset", "replication_birth_ordered",
    // missions
    "mission_started", "mission_ended", "mission_requested",
    // projects (lifecycle, team, settlement)
    "project_created", "project_started", "project_completed", "project_cancelled", "project_funded", "project_member_accepted",
    "project_member_exited", "project_member_replaced", "project_member_removed", "project_distributed", "project_settled", "project_paid",
    // Treasury / shared capital, real and owner money
    "capital_requested", "capital_decision", "envelope_allocation", "treasury_sweep", "tax_true_up", "wallet_transfer", "agent_transfer",
    "admin_withdrawal_requested", "admin_instruction_executed", "payment_order_reserved", "payment_order_settled", "payment_order_rejected",
    "payment_order_cancelled", "payment_order_awaiting_owner", "payment_instruction_issued", "estate_opened", "estate_settled",
    // owner attention, blocking dependencies, infrastructure
    "owner_request_created", "owner_request_decided", "owner_request_withdrawn", "owner_request_imported", "external_dependency_recorded",
    "capability_dependency", "reaper_resumed", "phone_released_unpaid",
  ],
  P2_IMPORTANT: [
    // commercial milestones
    "venture_created", "venture_state", "experiment_revenue_attributed", "venture_attribution",
    // collaboration terms
    "project_member_offered", "project_member_countered", "project_replanned", "project_assessment",
    // policy, cap and production
    "cap_set", "replication_policy_set", "risk_policy_set", "mission_policy_set", "sweep_policy_set", "tax_policy_set", "tax_profile_set",
    "capital_policy_set", "transfer_policy_set", "economy_policy_set", "custody_policy_set", "admin_withdrawal_policy_set", "experiment_policy_set",
    "evidence_ladder_set", "genesis_bootstrap_capital_set", "genesis_enabled", "genesis_disabled",
    // production lifecycle: ONE event per cutover, and an Agent runtime upgrade actually applied
    "production_deployed", "founder_runtime_upgrade_verified",
    "estate_item_released", "estate_item_reassigned", "estate_frozen",
    "payment_rail_added", "payment_rail_assigned", "payment_rail_status", "payment_rail_required", "payment_destination_enrolled",
    "payment_destination_activated", "payment_destination_revoked", "legal_entity_added", "vendor_registered", "vendor_revoked", "phone_inherited",
  ],
  P3_SUMMARY: [],
  AUDIT_ONLY: [
    // sessions, logins and access mechanics (the auth and operator logs hold the detail)
    "session_opened", "api_auth_failed", "api_auth_failed_suppressed", "db_auth_failed", "authorization_denied", "scope_denied",
    "agent_role_granted", "service_role_granted", "operator_role_granted", "custody_role_granted", "identity_role_granted", "browser_role_granted",
    "dashboard_role_granted", "operator_action", "operator_actions_enabled_set", "operator_actions_disabled", "operator_principal_enrolled",
    "operator_api_enabled_set", "operator_disabled", "operator_proposal_created", "operator_proposal_approved", "operator_proposal_rejected",
    "operator_proposal_expired", "operator_requests_archived", "health_challenge_requested", "runtime_verified", "credential_issued",
    // release preparation (approval / pin records of each release): the cutover's production_deployed carries the outcome
    "runtime_approved",
    "credential_registered", "identity_broker_key_published", "comms_provider_registered",
    // the ledger is its own record (material movements appear through their own events)
    "ledger_journal_posted", "fx_rate_recorded", "provider_credits_recorded", "provider_cost_reconciled", "destination_reference_recorded",
    // registry / provisioning steps (the lifecycle events above carry the outcome)
    "slot_reserved", "slot_released", "slot_claimed", "orphan_slot_released", "reservation_expired", "sandbox_termination_requested",
    "provisioning_started", "provisioning_sandbox_intent", "provisioning_sandbox_created", "provisioning_verifying", "provisioning_reconciled",
    "genesis_runtime_issued", "genesis_runtime_evidence", "founder_runtime_upgrade_prepared", "founder_runtime_upgrade_committed",
    // configuration of tooling
    "cognition_enabled", "cognition_tier_set", "cognition_tier_enabled", "cognition_tier_verified", "cognition_tier_cache_set", "cognition_routing_set",
    "cognition_depth_set", "founder_cognition_enabled", "founder_routing_set", "research_enabled", "notification_policy_set",
    // notification housekeeping (the inbox tombstone is the record)
    "notifications_deleted",
    // owner identity vault (the reveal log and vault records hold the detail)
    "owner_identity_uploaded", "owner_identity_installed", "owner_identity_release", "owner_identity_consent_set", "owner_identity_consent_revoked",
    "owner_identity_class_set", "identity_fact_set", "identity_fact_released", "browser_credential_stored", "browser_credential_refused",
  ],
  AGENT_ACTIVITY_ONLY: [
    "decision_recorded", "decision_measured", "decision_corrected", "opportunity_recorded", "opportunity_shortlist", "opportunity_stale",
    "knowledge_recorded", "knowledge_proposed", "experiment_evidence_refused", "experiment_relevance_assessed", "experiment_relevance_overridden",
    "experiment_budget_refused", "commitment_added", "commitment_cancelled", "mail_assigned", "mail_route_created", "phone_idle",
    "account_registered", "account_origin_added", "account_marked", "agent_identity_created", "identity_job_queued", "identity_claim_requested",
    "identity_claim_decided", "envelope_milestone", "project_task_started", "project_task_delivered", "project_task_accepted", "project_task_rejected",
    "project_offer_withdrawn", "action_cognition_refused",
  ],
});

/** Prefix routes for families whose members are enumerated at runtime (checked after the exact names). */
export const EVENT_PREFIX_ROUTES: ReadonlyArray<[prefix: string, priority: EventPriority]> = Object.freeze([
  ["project_task_", "AGENT_ACTIVITY_ONLY"], ["project_", "P1_HIGH"], ["payment_order_", "P1_HIGH"], ["genesis_", "P1_HIGH"],
  ["experiment_", "AGENT_ACTIVITY_ONLY"], ["opportunity_", "AGENT_ACTIVITY_ONLY"], ["identity_job_", "AGENT_ACTIVITY_ONLY"],
  ["operator_", "AUDIT_ONLY"], ["cognition_", "AUDIT_ONLY"], ["credential_", "AUDIT_ONLY"], ["settlement_", "P0_CRITICAL"],
] as const);

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
/** The router's generated rules (exact names, then prefixes): reused by later versions of fleet_event_route. */
export const caseExact = (Object.entries(EVENT_ROUTES) as Array<[EventPriority, readonly string[]]>)
  .filter(([, types]) => types.length).map(([p, types]) => `    WHEN p_type IN (${q(types)}) THEN '${p}'`).join("\n");
export const casePrefix = EVENT_PREFIX_ROUTES.map(([prefix, p]) => `    WHEN starts_with(p_type, '${prefix}') THEN '${p}'`).join("\n");

export const DASHBOARD_READ_OPS_V44 = [...DASHBOARD_READ_OPS_V43, "command_events"] as const;

const DASH_CALL = restate(V43_SQL, "dash_call", [
  [`p_op IN (${q(DASHBOARD_READ_OPS_V43)})`, `p_op IN (${q(DASHBOARD_READ_OPS_V44)})`],
  [`      WHEN 'notification_get' THEN fleet_admin_notification_get((a ->> 'id')::uuid)`, `      WHEN 'notification_get' THEN fleet_admin_notification_get((a ->> 'id')::uuid)
      WHEN 'command_events' THEN fleet_command_events(COALESCE((a ->> 'limit')::integer, 200))`],
  // An Agent's activity: its own events without the audit mechanics (sessions, logins, ledger postings …).
  [`FROM (SELECT * FROM fleet_events WHERE agent_id = a ->> 'agentId' ORDER BY created_at DESC LIMIT 200) e), '[]'::jsonb)`,
   `FROM (SELECT * FROM fleet_events WHERE agent_id = a ->> 'agentId' AND fleet_event_route(event_type, detail) <> 'AUDIT_ONLY' ORDER BY created_at DESC LIMIT 200) e), '[]'::jsonb)`],
]);

export const V44_SQL = `
-- ═══ The one event router (pure; the table above is its only source) ═══
CREATE FUNCTION fleet_event_route(p_type text, p_detail jsonb) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT CASE
    -- A notification event mirrors its notification: RED is critical, AMBER / IDENTITY need attention, the daily report
    -- is a summary; test fixtures (TEST_*) never reach Fleet Command.
    WHEN p_type = 'notification' THEN CASE
      WHEN COALESCE(p_detail ->> 'code', '') LIKE 'TEST\\_%' THEN 'AUDIT_ONLY'
      WHEN p_detail ->> 'class' = 'RED' THEN 'P0_CRITICAL'
      WHEN p_detail ->> 'class' IN ('AMBER','IDENTITY') THEN 'P1_HIGH'
      WHEN p_detail ->> 'class' = 'DAILY' THEN 'P3_SUMMARY'
      ELSE 'AUDIT_ONLY' END
    -- A breaker event is critical only when it trips; a reset is an important change.
    WHEN p_type = 'spend_circuit_breaker_set' THEN CASE WHEN COALESCE((p_detail ->> 'tripped')::boolean, true) THEN 'P0_CRITICAL' ELSE 'P2_IMPORTANT' END
${caseExact}
${casePrefix}
    ELSE 'AUDIT_ONLY' END
$$;

-- Fleet Command's rows, indexed (the router is immutable): the feed never scans the audit mechanics.
CREATE INDEX fleet_events_command ON fleet_events (created_at DESC)
  WHERE fleet_event_route(event_type, detail) IN ('P0_CRITICAL','P1_HIGH','P2_IMPORTANT','P3_SUMMARY');

-- Fleet Command's feed: P0–P3 only, newest first, the limit applied after routing; every row carries its priority.
CREATE FUNCTION fleet_command_events(p_limit integer) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('at', e.created_at, 'type', e.event_type, 'agentId', e.agent_id, 'actor', e.actor, 'detail', e.detail,
      'priority', e.priority) ORDER BY e.created_at DESC), '[]'::jsonb)
    FROM (SELECT x.*, fleet_event_route(x.event_type, x.detail) AS priority FROM fleet_events x
           WHERE fleet_event_route(x.event_type, x.detail) IN ('P0_CRITICAL','P1_HIGH','P2_IMPORTANT','P3_SUMMARY')
           ORDER BY x.created_at DESC LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 1000))) e
$$;

${DASH_CALL}
`;

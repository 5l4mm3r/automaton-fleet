/**
 * The dashboard's words, in one place. Everything the owner reads about an event, an error or a finished action comes
 * from here, so Fleet Command, the agent pages, the Virtual Command Centre and the notifications all say the same thing.
 *
 * House style (the convention of mature operations consoles such as Stripe's, Linear's and GitHub's): a title says what
 * happened in plain words and sentence case; details are labelled facts, never identifiers or payloads; an error says
 * what went wrong and what to do next, with the technical code kept last for support. Presentation only — nothing here
 * changes what FleetController records.
 */
import { displayAgentName } from "./naming";

/** What happened, per FleetController event type. Unknown types fall back to their words, capitalised. */
export const EVENT_TITLE: Readonly<Record<string, string>> = Object.freeze({
  // Agents
  agent_born: "New agent created", agent_activated: "Agent started", agent_died: "Agent died", agent_orphaned: "Agent lost contact with the Fleet",
  agent_quarantined: "Agent isolated for safety", agent_terminating: "Agent is shutting down", agent_unresponsive: "Agent stopped responding",
  agent_recovered: "Agent is responding again", agent_hold_set: "Agent paused by you", agent_hold_released: "Agent resumed by you",
  agent_renamed: "Agent renamed", agent_wallet_exhausted: "Agent ran out of money", agent_exhaustion_protected: "Agent out of money — kept alive by survival protection",
  agent_dormant_insolvent: "Agent dormant: out of money", agent_solvent_again: "Agent has money again", agent_sessions_revoked: "Agent signed out of the Fleet",
  agent_credential_revoked: "Agent credential withdrawn", agent_account_credentials_revoked: "Agent's account logins withdrawn",
  founder_runtime_upgrade_verified: "Agent software updated", founder_runtime_upgrade_aborted: "Agent software update stopped",
  founder_runtime_upgrade_rolled_back: "Agent software update undone", founder_runtime_rollback_verified: "Agent back on its previous software",
  // Births and the Genesis agents
  birth_ordered: "New agent ordered", birth_authorized: "New agent approved", birth_cancelled: "New agent cancelled",
  genesis_proposed: "First agent proposed", genesis_approved: "First agent approved", genesis_funded: "First agent funded",
  genesis_provisioned: "First agent set up", genesis_activated: "First agent started", genesis_founder_attested: "First agent's identity confirmed",
  genesis_founder_failed: "First agent failed to start", genesis_enabled: "Agent creation switched on", genesis_disabled: "Agent creation switched off",
  genesis_bootstrap_capital_set: "Starting money for new agents changed", genesis_attestation_failed: "Agent identity check failed",
  genesis_duplicate_runtime: "Duplicate agent software detected", genesis_rolled_back: "Agent creation undone",
  genesis_runtime_auth_failed: "Agent software failed to sign in", genesis_runtime_nonce_mismatch: "Agent software sent an unexpected sign-in",
  replication_requested: "Agent asked to create a new agent", replication_granted: "New agent request approved", replication_rejected: "New agent request declined",
  replication_pending: "New agent request waiting", replication_pending_reset: "New agent request reset", replication_birth_ordered: "New agent ordered by an agent",
  replication_policy_set: "New-agent rules changed", reservation_denied: "No room for another agent", cap_set: "Maximum number of agents changed",
  provisioning_failed: "Agent set-up failed", provisioning_uncertain: "Agent set-up result unclear", infrastructure_orphaned: "Unused agent server found",
  child_terminal_reported: "New agent reported a fatal problem",
  // Estates
  estate_opened: "Estate opened for a dead agent", estate_settled: "Estate settled", estate_frozen: "Estate frozen", estate_freeze_failed: "Estate could not be frozen",
  estate_item_reassigned: "Estate item given to another agent", estate_item_released: "Estate item released", estate_late_money: "Late money arrived for an estate",
  // Your requests and the agents' requests to you
  owner_request_created: "Agent is awaiting your reply", owner_request_imported: "Agent request added to your replies", owner_request_decided: "You replied to an agent",
  owner_request_withdrawn: "Agent withdrew its request", external_dependency_recorded: "Agent is awaiting your reply", capability_dependency: "Agent needs a capability set up",
  payment_rail_required: "Agent needs a payment account connected", order_needs_owner: "An order needs your attention",
  // Missions, capital and ventures
  mission_started: "Mission started", mission_ended: "Mission finished", mission_requested: "Mission requested", mission_policy_set: "Mission rules changed",
  capital_requested: "Agent asked for money", capital_decision: "Money request decided", capital_policy_set: "Funding rules changed", envelope_allocation: "Budget set aside",
  venture_created: "Venture started", venture_state: "Venture status changed", venture_attribution: "Result credited to a venture",
  experiment_policy_set: "Experiment rules changed", experiment_revenue_attributed: "Revenue credited to an experiment", evidence_ladder_set: "Evidence rules changed",
  knowledge_library_loaded: "Knowledge library updated", knowledge_recorded: "Knowledge recorded", knowledge_proposed: "Agent proposed new knowledge", knowledge_reviewed: "Knowledge reviewed",
  // Treasury and money movement
  treasury_sweep: "Profit moved to the treasury", wallet_transfer: "Money moved between treasury and agent", agent_transfer: "Money moved between agents",
  admin_withdrawal_requested: "Withdrawal requested", admin_withdrawal_policy_set: "Withdrawal rules changed", admin_instruction_executed: "Payment instruction carried out",
  payment_instruction_issued: "Payment instruction sent", payment_order_reserved: "Payment reserved", payment_order_settled: "Payment completed",
  payment_order_cancelled: "Payment cancelled", payment_order_rejected: "Payment rejected", receipt_held: "Money received and held for checks",
  receipt_posted: "Money received", receipt_debit_assigned: "Money taken back and assigned", settlement_failed: "A payment could not be settled",
  settlement_conflict: "Conflicting payment records", settlement_unattributed: "Money received but not matched", settlement_paypal_matched: "Sale matched to PayPal",
  simulated_settlement_policy: "Test-payment setting changed", sweep_policy_set: "Profit-sharing rules changed", sweep_reduction_requested: "Agent asked to keep more profit",
  sweep_reduction_granted: "Agent may keep more profit", sweep_reduction_decided: "Profit-sharing request decided", sweep_reduction_ended: "Profit-sharing back to normal",
  tax_policy_set: "Tax rules changed", tax_profile_set: "Tax profile changed", tax_true_up: "Tax adjustment recorded", transfer_policy_set: "Transfer rules changed",
  economy_policy_set: "Economy rules changed", risk_policy_set: "Risk rules changed", insolvency_policy_set: "Out-of-money rules changed",
  wallet_limits_set: "Agent spending limits changed", economy_failsafe: "Spending stopped by the failsafe", spend_circuit_breaker_set: "Spending safety switch changed",
  provider_cost_reconciliation_required: "AI costs need checking",
  survival_protection_set: "Survival protection changed", survival_protection_agent_set: "Survival protection changed for an agent",
  // Payment accounts, PayPal and custody
  payment_rail_added: "Payment account added", payment_rail_assigned: "Payment account given to a venture", payment_rail_status: "Payment account status changed",
  rail_webhook_set: "PayPal notifications link saved", payment_destination_enrolled: "Payout destination added", payment_destination_activated: "Payout destination ready",
  payment_destination_revoked: "Payout destination removed", payment_destination_activation_failed: "Payout destination could not be activated",
  destination_access_verified: "Payout destination confirmed", custody_credential_uploaded: "PayPal keys saved securely", custody_credential_revoked: "PayPal keys withdrawn",
  custody_activated: "Payments switched on", custody_deactivated: "Payments switched off", custody_activation_expired: "Payments switched off (time limit reached)",
  custody_policy_set: "Payment safety settings changed", pilot_authorised: "Trial payments approved", pilot_revoked: "Trial payments withdrawn",
  paypal_test_checkout_requested: "PayPal test payment created", paypal_test_captured: "PayPal test payment received", paypal_test_refund_seen: "PayPal test payment refunded",
  paypal_receipt_posted: "PayPal sale received", paypal_funds_available: "PayPal money now available", paypal_availability_short: "PayPal shows less money than expected",
  paypal_checkout_failed: "PayPal checkout could not be created", paypal_capture_conflict: "Conflicting PayPal payment records", paypal_receipt_mismatch: "PayPal amount did not match",
  paypal_clawback_posted: "PayPal took money back from a sale", paypal_clawback_reconciled: "PayPal money taken back has been reconciled",
  paypal_debit_unclassified: "PayPal took money for an unknown reason", paypal_debit_classified: "PayPal deduction explained",
  paypal_dispute_opened: "A buyer opened a PayPal dispute", paypal_dispute_unresolved: "PayPal dispute still open", paypal_dispute_resolved: "PayPal dispute resolved",
  paypal_dispute_set_by_owner: "You settled a PayPal dispute", paypal_reversal_seen: "PayPal reversed a payment", paypal_refund_unmatched: "PayPal refund did not match a request",
  paypal_evidence_over_principal: "PayPal reports more money taken back than was paid",
  // Card
  card_charge_booked: "Card payment recorded", card_charge_advanced: "Card payment confirmed", card_hold_opened: "Money set aside for a card payment",
  card_hold_booked_at_maximum: "Card payment at its limit", card_receipt_recorded: "Money returned to the card", card_receipt_applied: "Card refund applied",
  card_receipt_returned: "Card refund passed to the agent", card_receipt_withdrawn: "Card refund kept by you", card_repayment_recorded: "Card repayment recorded",
  card_request_owner_review: "Card payment awaiting your approval", card_request_owner_approved: "You approved a card payment",
  card_request_declined: "Card payment declined", card_request_expired: "Card request expired", card_statement_issued: "Weekly card statement ready",
  card_statement_paid: "Card statement paid", card_credit_recorded: "Card credit recorded", card_credit_applied: "Card credit used", card_credit_returned: "Card credit returned",
  // Orders and storefront
  customer_order_paid: "Customer order paid", order_delivered: "Order delivered", order_fulfilled: "Order completed", order_delivery_failed: "Order delivery failed",
  order_delivery_gave_up: "Order could not be delivered", order_refund_requested: "Refund requested", order_refund_completed: "Refund completed", order_refund_failed: "Refund failed",
  storefront_probe: "Shop connection checked", storefront_product_published: "Product published", storefront_publication_warning: "Product listing has a problem",
  provider_conflict: "Shop records disagree", provider_missing_product: "Product missing from the shop", provider_orphan_product: "Unknown product in the shop",
  provider_suspense_released: "Held shop money released", gateway_account_refused: "Shop account refused",
  // Identity, accounts and security
  identity_autonomy_set: "Agents' permission to use your details changed", identity_documents_set: "Documents agents may use changed",
  account_frozen: "An agent account was frozen", account_unfrozen: "An agent account was unfrozen", legal_entity_added: "Business entity added",
  vendor_registered: "Supplier added", vendor_revoked: "Supplier removed", provider_secret_uploaded: "Service login saved securely", provider_secret_installed: "Service login installed",
  phone_inherited: "Phone number passed on", phone_released_unpaid: "Phone number released (unpaid)", health_challenge_failed: "Agent failed a health check",
  request_replayed: "Repeated request blocked", operator_replay_blocked: "Repeated operator request blocked", runtime_verification_failed: "Software check failed",
  // Teams
  project_created: "Team project created", project_funded: "Team project funded", project_started: "Team project started", project_completed: "Team project completed",
  project_settled: "Team project settled", project_distributed: "Team project earnings shared", project_paid: "Team project paid", project_cancelled: "Team project cancelled",
  project_replanned: "Team project re-planned", project_assessment: "Team project reviewed", project_lifecycle_failed: "Team project could not continue",
  project_member_offered: "Agent invited to a team", project_member_countered: "Agent replied with new terms", project_member_accepted: "Agent joined a team",
  project_member_exited: "Agent left a team", project_member_removed: "Agent removed from a team", project_member_replaced: "Team member replaced",
  // The Fleet itself
  production_deployed: "Fleet update installed", production_rolled_back: "Fleet update undone", runtime_approved: "New Fleet software approved",
  reaper_resumed: "Fleet maintenance resumed", notification: "Notification",
  // v62: conversations and names
  agent_replied: "Agent replied to you", owner_message_sent: "You sent a message", owner_label_set: "Name changed",
  conversation_cost_unfunded: "Treasury could not fully pay for a conversation", founder_cognition_paused: "Agent paused (AI off)",
  founder_cognition_enabled: "Agent's AI switched on", founder_cognition_disabled: "Agent's AI switched off",
});

export function eventTitle(type: string): string {
  return EVENT_TITLE[type] ?? type.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** How detail keys read. Keys mapped to null are never shown (identifiers, fingerprints, internal references). */
const FACT_LABEL: Readonly<Record<string, string | null>> = Object.freeze({
  amountMinor: "Amount", grossMinor: "Amount", netMinor: "Net", feeMinor: "PayPal fee", ownerCapitalMinor: "Added to your capital", expectedMinor: "Expected",
  reportedMinor: "Reported", fundingMinor: "Funding", label: "Name", name: "Name", from: "From", to: "To", status: "Status", mode: "Mode", reason: "Reason",
  note: "Note", kind: "Type", provider: "Provider", ui: "Dashboard version", outcome: "Outcome", title: "Title", currency: "Currency", max: "Maximum",
  previous: null, commit: null, fromSchema: null, toSchema: null, railId: null, checkoutId: null, captureId: null, webhookId: null, vaultRef: null,
  keyFingerprint: null, fingerprint: null, requestId: null, orderId: null, agentId: null, fromAgentId: null, toAgentId: null, journalId: null, eventId: null,
  credentialId: null, entityId: null, missionId: null, ventureId: null, refundRequestId: null, deliveryId: null, idempotencyKey: null, sha256: null,
  evidence: null, actor: null, code: null, class: null,
});
const VALUE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  pending_setup: "setting up", live: "live", sandbox: "test", shared: "shared", active: "active", suspended: "suspended", revoked: "withdrawn",
  approved: "approved", declined: "declined", answered: "answered", true: "yes", false: "no",
});

const pounds = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? `£${(n / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : String(v);
};

/** Up to `max` readable facts of an event: labelled, money formatted, agents by name, identifiers left out. */
export function eventFacts(detail: Record<string, unknown> | null | undefined, max = 3, agentName?: (id: string) => string | undefined): Array<[string, string]> {
  if (!detail) return [];
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(detail)) {
    if (out.length >= max) break;
    if (v === null || v === undefined || typeof v === "object") continue;
    const label = k in FACT_LABEL ? FACT_LABEL[k] : /Id$|Ref$|Sha256$|Key$/.test(k) ? null : k.replace(/Minor$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
    if (!label) continue;
    const raw = String(v);
    let text = /Minor$/.test(k) ? pounds(v) : (agentName && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(raw) ? agentName(raw) ?? raw : VALUE_TEXT[raw] ?? raw);
    if (/^(founder|agent)[-_ ]?\d+$/i.test(text)) text = displayAgentName(text);
    out.push([label, text.length > 80 ? `${text.slice(0, 77)}…` : text]);
  }
  return out;
}

/** The confirmation after an action, in words ("Saved."), per dashboard operation. */
const DONE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  hold: "Agent paused.", resume: "Agent resumed.", rename: "Name saved.", fund: "Money sent to the agent.", transfer: "Transfer recorded.", withdraw: "Withdrawal requested.",
  kill: "Agent retired.", mission: "Mission assigned.", mission_end: "Mission finished.", mission_request: "Mission request created.", birth: "New agent ordered.",
  reseed: "Replacement agent ordered.", estate: "Estate updated.", ack: "Notification acknowledged.", ack_all: "All notifications acknowledged.",
  notification_delete: "Notifications deleted.", notification_delete_acknowledged: "Acknowledged notifications deleted.", command_clear: "Section cleared.",
  policy: "Rules saved.", limits: "Limits saved.", delivery: "Notification settings saved.", genesis: "Starting capital saved.", document: "Document uploaded.",
  document_status: "Document status saved.", consent: "Permission saved.", consent_revoke: "Permission withdrawn.", passkey_rename: "Passkey renamed.",
  passkey_revoke: "Passkey removed.",
});
export function doneText(op: string, args: Record<string, string> = {}): string {
  if (op === "hold" && args.action === "resume") return DONE_TEXT.resume;
  return DONE_TEXT[op] ?? "Done.";
}

/** Notification levels as words. */
export const LEVEL_TEXT: Readonly<Record<string, string>> = Object.freeze({ RED: "Urgent", AMBER: "Warning", IDENTITY: "Identity", INFO: "Information" });

/** Who did it, in words: you, a Fleet service, or the agent by name. */
export function actorText(actor: string | null | undefined, agentName?: (id: string) => string | undefined): string {
  if (!actor) return "Fleet";
  if (/^operator:owner$/.test(actor)) return "You";
  if (/^operator:/.test(actor)) return "You (server)";
  if (/^custody/.test(actor)) return "Payments service";
  if (/^(identity|identity-broker)/.test(actor)) return "Identity service";
  if (/^(lifecycle|reaper|svc|service|fleet-service|migration|operator:release)/.test(actor)) return "Fleet";
  if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(actor)) return agentName?.(actor) ?? "An agent";
  if (/^agent:/.test(actor)) return agentName?.(actor.slice(6)) ?? "An agent";
  return "Fleet";
}

/** The default name of a saved set of PayPal keys (its reference, in words) — used until the owner names it. */
export function credentialName(ref: string): string {
  const slug = ref.replace(/^vault:paypal\//, "");
  return slug.split(/[-_./]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") || ref;
}

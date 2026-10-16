/**
 * The gateway's classification of operations (v41; v43 adds notification deletion and passkey rename as ordinary writes). A sensitive operation is refused without a fresh passkey step-up;
 * the gateway enforces this — the list here only tells the client to ask for one first. A contract test pins it to the
 * backend's own list (DASHBOARD_SENSITIVE_OPS_V41).
 */
export const SENSITIVE_OPS: ReadonlySet<string> = new Set([
  "reveal_request", "owner_vault_upload", "owner_identity_consent_set", "owner_identity_consent_revoke", "owner_identity_class_set",
  "agent_transfer", "wallet_transfer", "agent_fund", "owner_withdrawal", "agent_kill", "birth", "reseed", "estate_assign", "estate_release",
  "replication_policy", "mission_policy", "risk_policy", "notification_policy", "genesis_capital", "passkey_revoke", "totp_reset", "session_revoke_all",
  "provider_credits_record",
  // v48: custody activation, wallet limits, card clearing; v49: standing identity authority, freezes, sealed custody credentials,
  // webhook ids; v50: insolvency policy and sweep reductions.
  "custody_activate", "custody_deactivate", "wallet_limits_set", "card_charge_record", "card_charge_confirm", "card_repayment_record", "card_receipt_record",
  "card_receipt_resolve", "identity_autonomy_set", "account_freeze", "account_unfreeze", "custody_credential_upload", "custody_credential_revoke", "rail_webhook_set",
  "insolvency_policy_set", "sweep_reduction_grant", "sweep_reduction_end", "sweep_reduction_decline", "paypal_txn_attribute",
  // v51: card receipts settled by method, the document authority, mail / SMS provider secrets; v52: the storefront probe and the
  // PayPal treasury as a settlement destination.
  "card_receipt_settle", "identity_documents_set", "provider_secret_upload", "storefront_probe", "destination_paypal_link",
  // v53: the weekly card statement and the owner's PayPal receiving test.
  "card_statement_issue", "card_statement_paid", "card_statement_policy_set", "paypal_test_checkout",
  // v54: card requests above the owner's threshold, and the threshold.
  "card_request_decide", "card_request_policy_set",
  // v55: the owner's survival protection switch.
  "survival_protection_set", "survival_protection_agent_set",
  // v57: a PayPal dispute's outcome and an unclassified debit, decided by the owner.
  "paypal_dispute_resolve", "paypal_debit_classify",
  // v58: card credit moved back to the treasury.
  "card_credit_return",
  // v59: refund a sale's buyer through PayPal.
  "order_refund",
  // v64: the owner's decision on a Fleet Control spend review (approve / hold / retry / allow a resubmission).
  "spend_review_decide",
  // v66: a PayPal deposit backs the existing capital (no second credit).
  "capital_back",
  // v69: record (once) the AI costs charged before v69 as owed to the owner.
  "ai_credit_opening",
  // v81: the legal seller, the public site, a controlled-proof release (permits public external actions), a channel's API connection.
  "seller_set", "public_site_set", "outward_release", "channel_connect",
  // v83: add a phone that receives alerts (it decides where alerts go).
  "push_device_add",
]);

/** Ordinary authenticated writes (session + CSRF, no step-up). */
export const WRITE_OPS: ReadonlySet<string> = new Set([
  "notification_ack", "agent_hold", "agent_release", "mission_assign", "mission_end", "mission_request", "reveal_take", "mail_assign",
  "notification_delete", "notification_delete_acknowledged", "passkey_rename", "command_clear",
  // v60: the owner names an Agent (display only; the registry name and identity are unchanged).
  "agent_rename",
  // v62: conversations, request replies, labels for PayPal keys and payment accounts, pause / resume.
  "agent_message_send", "agent_message_retry", "owner_request_reply", "label_set", "agent_cognition_set",
  // v63: mail housekeeping — dismiss / restore and permanent delete (confirmed in the page; no step-up, owner decision).
  "mail_dismiss", "mail_delete",
  // v81: end a controlled-proof release; disconnect a channel's API account.
  "outward_hold", "channel_disconnect",
  // v83: phone alerts — remove a phone, send a test, confirm a test arrived.
  "push_device_revoke", "push_test", "push_test_received",
]);

/**
 * The gateway's classification of operations (v41). A sensitive operation is refused without a fresh passkey step-up;
 * the gateway enforces this — the list here only tells the client to ask for one first. A contract test pins it to the
 * backend's own list (DASHBOARD_SENSITIVE_OPS_V41).
 */
export const SENSITIVE_OPS: ReadonlySet<string> = new Set([
  "reveal_request", "owner_vault_upload", "owner_identity_consent_set", "owner_identity_consent_revoke", "owner_identity_class_set",
  "agent_transfer", "wallet_transfer", "agent_fund", "owner_withdrawal", "agent_kill", "birth", "reseed", "estate_assign", "estate_release",
  "replication_policy", "mission_policy", "risk_policy", "notification_policy", "genesis_capital", "passkey_revoke", "totp_reset", "session_revoke_all",
  "provider_credits_record",
]);

/** Ordinary authenticated writes (session + CSRF, no step-up). */
export const WRITE_OPS: ReadonlySet<string> = new Set([
  "notification_ack", "agent_hold", "agent_release", "mission_assign", "mission_end", "mission_request", "reveal_take", "mail_assign",
]);

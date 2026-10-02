/**
 * Every owner-dashboard command → the real v41 gateway operation, audited against the backend (dash_call in schema
 * v38–v41). Columns: the gateway op, whether a fresh passkey step-up is required, how a repeat behaves, what is audited.
 *
 * Idempotency, as the backend implements it:
 *  • money and other sensitive operations derive their idempotency key from the single-use step-up token: one step-up
 *    = at most one effect, and a replayed step-up is refused (FLEET_STEPUP_REQUIRED). A NEW step-up is a NEW request —
 *    so the client never retries a sensitive call; after an unknown outcome the owner reviews the refreshed state first.
 *  • hold/release, acknowledgement and consent revocation converge (repeating them changes nothing further).
 *  • mission assignment / requests, birth orders and estate moves are new records each time (never auto-retried).
 * Audit: every write is in the Admin auth log (op, ok, code); money, births, kills and policy also emit Fleet events
 * and ledger journals; reveals are in the permanent reveal log.
 *
 * Commands with NO legitimate live contract are listed in UNSUPPORTED with the reason; the UI shows them disabled in
 * LIVE mode. Nothing is invented to make a button work.
 */
import { FleetApiError } from "./errors";
import type { GatewayClient } from "./client";
import type { LiveCommand, LiveCommandKind } from "./types";

export interface OperationInfo {
  kind: LiveCommandKind;
  /** The gateway op(s) this command uses. */
  ops: string[];
  stepUp: boolean;
  repeat: "converges" | "new_record" | "one_per_stepup";
  audit: string;
}

export const OPERATIONS: Readonly<Record<string, OperationInfo>> = Object.freeze({
  withdraw: { kind: "withdraw", ops: ["owner_withdrawal"], stepUp: true, repeat: "one_per_stepup",
    audit: "withdrawal instruction + Fleet event; executes NO payment while live money is off (custody pinned off)" },
  fund: { kind: "fund", ops: ["agent_fund"], stepUp: true, repeat: "one_per_stepup", audit: "ledger journal (agent_capital_grant / principal) + event" },
  transfer: { kind: "transfer", ops: ["agent_transfer"], stepUp: true, repeat: "one_per_stepup", audit: "ledger journal + event" },
  treasury_transfer: { kind: "treasury_transfer", ops: ["wallet_transfer"], stepUp: true, repeat: "one_per_stepup", audit: "ledger journal + event" },
  hold: { kind: "hold", ops: ["agent_hold"], stepUp: false, repeat: "converges", audit: "operator hold + event" },
  resume: { kind: "resume", ops: ["agent_release"], stepUp: false, repeat: "converges", audit: "hold released + event" },
  kill: { kind: "kill", ops: ["agent_kill"], stepUp: true, repeat: "converges", audit: "agent marked dead (irreversible) + estate inventory" },
  mission: { kind: "mission", ops: ["mission_assign"], stepUp: false, repeat: "new_record", audit: "mission record + event" },
  mission_request: { kind: "mission_request", ops: ["mission_request"], stepUp: false, repeat: "new_record", audit: "mission request + event" },
  mission_end: { kind: "mission_end", ops: ["mission_end"], stepUp: false, repeat: "converges", audit: "mission closed + recharge journals" },
  birth: { kind: "birth", ops: ["birth"], stepUp: true, repeat: "one_per_stepup", audit: "birth order + event (provisioning is a host step)" },
  reseed: { kind: "reseed", ops: ["reseed"], stepUp: true, repeat: "one_per_stepup", audit: "birth order (reseed) + event" },
  estate: { kind: "estate", ops: ["estate_assign", "estate_release"], stepUp: true, repeat: "converges", audit: "estate item + event" },
  ack: { kind: "ack", ops: ["notification_ack"], stepUp: false, repeat: "converges", audit: "acknowledgement" },
  ack_all: { kind: "ack_all", ops: ["notification_ack"], stepUp: false, repeat: "converges", audit: "one acknowledgement per notification" },
  policy: { kind: "policy", ops: ["replication_policy", "mission_policy", "risk_policy"], stepUp: true, repeat: "converges", audit: "policy row + event" },
  delivery: { kind: "delivery", ops: ["notification_policy"], stepUp: true, repeat: "converges", audit: "notification policy + event" },
  genesis: { kind: "genesis", ops: ["genesis_capital"], stepUp: true, repeat: "converges", audit: "Genesis capital decision + event" },
  document: { kind: "document", ops: ["owner_vault_upload"], stepUp: true, repeat: "new_record", audit: "upload metadata (sealed bytes erased on install)" },
  document_status: { kind: "document_status", ops: ["owner_identity_class_set"], stepUp: true, repeat: "converges", audit: "class status + event" },
  consent: { kind: "consent", ops: ["owner_identity_consent_set"], stepUp: true, repeat: "new_record", audit: "standing consent + event" },
  consent_revoke: { kind: "consent_revoke", ops: ["owner_identity_consent_revoke"], stepUp: true, repeat: "converges", audit: "consent revoked + event" },
  passkey_revoke: { kind: "passkey_revoke", ops: ["passkey_revoke"], stepUp: true, repeat: "converges", audit: "auth log" },
  sessions: { kind: "sessions", ops: ["session_revoke_all"], stepUp: true, repeat: "converges", audit: "auth log (other sessions ended)" },
  totp: { kind: "totp", ops: ["totp_reset"], stepUp: true, repeat: "converges", audit: "auth log (re-enrollment required)" },
  mail_assign: { kind: "mail_assign", ops: ["mail_assign"], stepUp: false, repeat: "converges", audit: "routing + event" },
});

/** Simulation commands with no legitimate live contract today — disabled in LIVE mode, with the reason. */
export const UNSUPPORTED: Readonly<Record<string, string>> = Object.freeze({
  topup: "Owner funding is real money arriving from outside; it is recorded with its bank/processor reference by the owner on the Fleet host (fleet:admin ledger owner-funding). The dashboard has no operation that creates money.",
  role: "Permanent roles are set at birth. Temporary roles are missions (use Mission). There is no role-change operation.",
  provision: "Turning a birth order into a running agent is a privileged host step (scripts/fleet-founders.sh birth <orderId>), deliberately not reachable from the web.",
  limits: "The living-agent cap and the safety switches are owner-approved host settings (fleet_state), never changeable from the web.",
  passkey: "Adding a passkey uses a one-time enrollment link from the Fleet host (fleet:admin hub-dashboard-enroll <origin>). The gateway has no in-session add-passkey endpoint yet.",
});

export function isSupported(kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(OPERATIONS, kind);
}

/** Execute one command through the gateway; returns the gateway's result(s). Throws FleetApiError. */
export async function executeLiveCommand(c: GatewayClient, cmd: LiveCommand): Promise<unknown> {
  if (!isSupported(cmd.kind)) throw new FleetApiError("FLEET_UNSUPPORTED_IN_LIVE", UNSUPPORTED[cmd.kind] ?? "no live operation");
  switch (cmd.kind) {
    case "withdraw":
      return c.call("owner_withdrawal", { amountMinor: cmd.amountMinor, destination: cmd.destination, reason: cmd.reason, acknowledge: cmd.acknowledge ?? false });
    case "fund":
      return c.call("agent_fund", { agentId: cmd.agentId, amountMinor: cmd.amountMinor, mode: cmd.mode ?? "grant", reason: cmd.reason, acknowledge: cmd.acknowledge ?? false });
    case "transfer":
      return c.call("agent_transfer", { from: cmd.from, to: cmd.to, amountMinor: cmd.amountMinor, reason: cmd.reason, acknowledge: cmd.acknowledge ?? false });
    case "treasury_transfer":
      return c.call("wallet_transfer", { agentId: cmd.agentId, target: cmd.target, amountMinor: cmd.amountMinor, reason: cmd.reason, acknowledge: cmd.acknowledge ?? false });
    case "hold":
      return c.call("agent_hold", { agentId: cmd.agentId, reason: cmd.reason ?? "paused by Admin" });
    case "resume":
      return c.call("agent_release", { agentId: cmd.agentId });
    case "kill":
      return c.call("agent_kill", { agentId: cmd.agentId, reason: cmd.reason });
    case "mission":
      return c.call("mission_assign", { agentId: cmd.agentId, kind: cmd.missionKind, brief: cmd.brief, beneficiaries: cmd.beneficiaries });
    case "mission_request":
      return c.call("mission_request", { kind: cmd.missionKind, brief: cmd.brief, beneficiaries: cmd.beneficiaries });
    case "mission_end":
      return c.call("mission_end", { missionId: cmd.missionId, outcome: cmd.outcome });
    case "birth":
      return c.call("birth", { mission: cmd.mission, reason: cmd.reason, fundingMinor: cmd.fundingMinor, ...(cmd.role ? { role: cmd.role } : {}) });
    case "reseed":
      return c.call("reseed", { deadAgentId: cmd.deadAgentId, reason: cmd.reason, fundingMinor: cmd.fundingMinor });
    case "estate":
      return cmd.action === "assign" ? c.call("estate_assign", { itemId: cmd.itemId, agentId: cmd.agentId })
        : c.call("estate_release", { itemId: cmd.itemId, reason: cmd.reason });
    case "ack":
      return c.call("notification_ack", { id: cmd.notificationId });
    case "ack_all": {
      const out: unknown[] = [];
      for (const id of cmd.notificationIds) out.push(await c.call("notification_ack", { id }));
      return out;
    }
    case "policy":
      return c.call(`${cmd.area}_policy`, { patch: cmd.patch });
    case "delivery":
      return c.call("notification_policy", { dailyHourUtc: cmd.dailyHourUtc, adminEmail: cmd.adminEmail });
    case "genesis":
      return c.call("genesis_capital", { currency: cmd.currency, minor: cmd.minor });
    case "document":
      return c.call("owner_vault_upload", { class: cmd.class, sealedB64: cmd.sealedB64, contentType: cmd.contentType, expiresAt: cmd.expiresAt });
    case "document_status":
      return c.call("owner_identity_class_set", { class: cmd.class, status: cmd.status, expiresAt: cmd.expiresAt });
    case "consent":
      return c.call("owner_identity_consent_set", { purposes: cmd.purposes, providers: cmd.providers, classes: cmd.classes, statement: cmd.statement });
    case "consent_revoke":
      return c.call("owner_identity_consent_revoke", { consentId: cmd.consentId });
    case "passkey_revoke":
      return c.call("passkey_revoke", { credentialId: cmd.credentialId });
    case "sessions":
      return c.call("session_revoke_all", {});
    case "totp":
      return c.call("totp_reset", {});
    case "mail_assign":
      return c.call("mail_assign", { messageId: cmd.messageId, agentId: cmd.agentId, ...(cmd.ventureId ? { ventureId: cmd.ventureId } : {}),
        ...(cmd.accountId ? { accountId: cmd.accountId } : {}) });
    default:
      throw new FleetApiError("FLEET_UNSUPPORTED_IN_LIVE");
  }
}

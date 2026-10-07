/**
 * Automaton Fleet — the LIVE contract between an owner dashboard and the Fleet dashboard gateway (schema v41, R35).
 *
 * Framework-free TypeScript for the owner's dashboard (the Codex-built Next.js app): drop `dashboard/api/*` and
 * `dashboard/adapters/live.ts` into it. Nothing here hard-codes an installation: every request is same-origin
 * (`/api/*` of whatever host serves the dashboard), so the same build serves admin.<anything>, fleet.example.com or
 * localhost.
 *
 * The backend is authoritative. These types describe what the gateway RETURNS; the dashboard maps them to its own view
 * models and never computes balances, eligibility, health or survival state itself.
 */

/** One snapshot section: the gateway's answer, or why it is unavailable (never fictional data). */
export type Section<T> = { state: "ok"; data: T } | { state: "unavailable"; code: string };

export interface AuthState {
  /** A passkey AND a confirmed TOTP factor exist. */
  enrolled: boolean;
  /** Too many failed sign-ins: sign-in is locked for a while (RED raised). */
  locked: boolean;
  /** "full" = passkey + TOTP session; "none" = signed out / expired. */
  session: "full" | "none";
}

/** v39: three figures, never collapsed (Treasury cash; owner funding; Fleet-generated realised wealth). Minor units. */
export interface TreasuryFigures {
  treasuryCashMinor: number;
  ownerContributedMinor: number;
  ownerWithdrawnMinor: number;
  /** The Lifetime Fleet Contribution — the ONLY replication wealth. Never "cash − owner funding". */
  fleetGeneratedMinor: number;
}

/** `replication` read (fleet_admin_replication_status, v39). Fields beyond these pass through untouched. */
export interface ReplicationStatus {
  treasury: TreasuryFigures;
  health: {
    economic: { fleetGeneratedMinor: number; thresholdMinor: number; remainingMinor: number; met: boolean };
    gate: Record<string, boolean>;
    blockers: string[];
    [k: string]: unknown;
  };
  window: { hours: number; pendingSince: string | null; phase: string; elapsedSeconds: number | null; remainingSeconds: number | null };
  stage: { thresholdsConsumed: number; highWaterMinor: number; nextAgentNumber: number };
  livingAgents: number;
  [k: string]: unknown;
}

/** `agents` read. */
export interface AgentRow {
  agentId: string;
  name: string | null;
  status: string;
  createdAt: string;
  cashMinor: number;
  valueMinor: number;
  held: boolean;
  /** NORMAL or the active temporary mission (MARKETING, OPPORTUNITY_HUNT, KNOWLEDGE_DATA). */
  mode: string;
}

/** `comms_status` read (v41). NOT_CONFIGURED is a deliberate, healthy state. */
export interface CommsStatus {
  mail: { configured: boolean; state: "NOT_CONFIGURED" | "CONFIGURED"; preferredProvider: string; [k: string]: unknown };
  sms: { configured: boolean; state: "NOT_CONFIGURED" | "CONFIGURED"; preferredProvider: string; [k: string]: unknown };
  demands: Array<Record<string, unknown>>;
  providerSecrets: Array<{ name: string; fields: string[]; fingerprint: string; status: string; publishedAt: string }>;
}

/** Everything the owner dashboard shows, read in one pass. Each section is the gateway's own data, or unavailable. */
export interface LiveSnapshot {
  readonly mode: "live";
  /** When this snapshot was read (ISO). The UI shows it so stale data is never mistaken for current. */
  fetchedAt: string;
  /** A snapshot exists only for a full (passkey + TOTP) session; otherwise loading it throws FLEET_SESSION_INVALID. */
  session: "full";
  /** Treasury figures, ladder, 24 h window, high-water stage, living agents, births — `replication`. */
  replication: Section<ReplicationStatus>;
  agents: Section<AgentRow[]>;
  /** Daily report: flows, per-agent summary, missions, births queued — `daily_report`. */
  daily: Section<Record<string, unknown>>;
  /** Economic / system health — `health`. */
  health: Section<Record<string, unknown>>;
  /** RED / AMBER / DAILY / IDENTITY notifications with acknowledgement state — `notifications`. */
  notifications: Section<Record<string, unknown>>;
  /** Missions (active, open requests, policy), estates engine state — `engine`. */
  engine: Section<Record<string, unknown>>;
  /** Estate items, ownership, assignment, storage/value — `estates`. */
  estates: Section<Record<string, unknown>>;
  /** Owner identity: classes (metadata only), consents, releases — `identity` (no agentId) + `comms`.ownerVault. */
  ownerIdentity: Section<Record<string, unknown>>;
  ownerVaultClasses: Section<Array<Record<string, unknown>>>;
  /** Passkeys, sessions, auth log — `security`. TOTP state is part of `auth`/enrollment. */
  security: Section<Record<string, unknown>>;
  /** Mail / SMS configuration (NOT_CONFIGURED by design), recorded needs, provider-secret metadata — `comms_status`. */
  comms: Section<CommsStatus>;
  /** All policies, population, flags (cap, switches) — `settings`. */
  settings: Section<Record<string, unknown>>;
  /** Queued birth orders and their provisioning cohort — `births_pending`. */
  births: Section<Array<Record<string, unknown>>>;
  /** Treasury ledger view (accounts, balances, recent journals) — `hub` section `treasury`. */
  ledger: Section<Record<string, unknown>>;
}

/**
 * Commands, named after the owner dashboard's simulation commands. Amounts are minor units (pence) of the Fleet's
 * accounting currency. See `operations.ts` for each command's gateway operation, step-up and idempotency.
 */
export type LiveCommand =
  | { kind: "withdraw"; amountMinor: number; destination: string; reason: string; acknowledge?: boolean }
  | { kind: "fund"; agentId: string; amountMinor: number; reason: string; mode?: "grant" | "principal"; acknowledge?: boolean }
  | { kind: "transfer"; from: string; to: string; amountMinor: number; reason: string; acknowledge?: boolean }
  /** Move an agent's cash to the Treasury (or the operating pool). The reverse direction is `fund`. */
  | { kind: "treasury_transfer"; agentId: string; target: "treasury" | "operating_pool"; amountMinor: number; reason: string; acknowledge?: boolean }
  | { kind: "hold"; agentId: string; reason?: string }
  | { kind: "resume"; agentId: string }
  | { kind: "kill"; agentId: string; reason: string }
  | { kind: "mission"; agentId: string; missionKind: "marketing" | "opportunity_hunt" | "knowledge_data"; brief: string; beneficiaries: MissionBeneficiary[] }
  | { kind: "mission_request"; missionKind: "marketing" | "opportunity_hunt" | "knowledge_data"; brief: string; beneficiaries: MissionBeneficiary[] }
  | { kind: "mission_end"; missionId: string; outcome: string }
  | { kind: "birth"; mission: "independent" | "marketing" | "opportunity_hunt" | "knowledge_data" | "other"; reason: string; fundingMinor: number; role?: string }
  | { kind: "reseed"; deadAgentId: string; reason: string; fundingMinor: number }
  | { kind: "estate"; action: "assign"; itemId: string; agentId: string }
  | { kind: "estate"; action: "release"; itemId: string; reason: string }
  | { kind: "ack"; notificationId: string }
  | { kind: "ack_all"; notificationIds: string[] }
  | { kind: "policy"; area: "replication" | "mission" | "risk"; patch: Record<string, unknown> }
  | { kind: "delivery"; dailyHourUtc: number; adminEmail: string | null }
  | { kind: "genesis"; currency: string; minor: number }
  | { kind: "document"; class: string; sealedB64: string; contentType: string; expiresAt: string | null }
  | { kind: "document_status"; class: string; status: "configured" | "expired" | "revoked"; expiresAt: string | null }
  | { kind: "consent"; purposes: string[]; providers: string[] | null; classes: string[]; statement: string }
  | { kind: "consent_revoke"; consentId: string }
  | { kind: "passkey_revoke"; credentialId: string }
  | { kind: "passkey_rename"; credentialId: string; name: string }
  | { kind: "notification_delete"; ids: string[]; acknowledgeUnread: boolean }
  | { kind: "notification_delete_acknowledged" }
  | { kind: "sessions"; action: "revoke_all" }
  | { kind: "totp"; action: "reset" }
  | { kind: "mail_assign"; messageId: string; agentId: string; ventureId?: string; accountId?: string }
  // Commands that exist in the simulation but have NO legitimate live contract (see operations.ts): kept so the UI can
  // show them as unavailable in LIVE mode with the reason.
  | { kind: "topup" | "role" | "provision" | "limits" | "passkey" };

export type LiveCommandKind = LiveCommand["kind"];

/** Who a temporary mission serves and pays its attributable cost: 1..10 entries, shares summing to 10000 basis points. */
export type MissionBeneficiary = { agentId: string; shareBp: number; ventureId?: string } | { fleet: true; shareBp: number };

/**
 * Untyped gateway JSON (WebAuthn options, gateway envelopes, read results). Every value taken from it is narrowed where
 * it is used (String(), num(), explicit checks) — this alias is the single place the wire is not statically typed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
export type Json = Record<string, any>;

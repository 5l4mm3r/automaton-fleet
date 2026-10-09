/**
 * Identity broker database gateway (schema v34): connects as the restricted identity login (fleet_identity_login) and can
 * call only the ix_* functions — claim a job under a lease, record credential REFERENCES, mailboxes and sanitised mail,
 * ask whether owner identity classes may be released, record the release and report the job. No table privilege.
 */
import pg from "pg";
import type { Pool } from "pg";
import { quoteIdent } from "../postgres/migrations.js";

export interface IdentityJob {
  jobId: string;
  agentId: string;
  kind: string;
  params: Record<string, unknown>;
  accountId: string | null;
  account: { platform: string; kind: string; handle: string | null; status: string; providerAccountRef: string | null; ventureId: string | null;
    displayName: string | null } | null;
  mailboxes: string[];
  credentials: Array<{ kind: string; vaultRef: string }>;
  /** v36: the outbound message of a mail.send job, the SMS of an sms.send job, the number of a phone job. */
  message?: { messageId: string; from: string; to: string[]; subject: string; body: string; inReplyTo: string | null;
    /** v41: on the shared mailbox, the agent's routing address (Reply-To) and the conversation's Message-IDs. */
    replyTo?: string | null; shared?: boolean; references?: string[] | null } | null;
  /** v56: a mail.send job's order-delivery files (names and sizes; the bytes come from mailAttachments under the job's lease). */
  attachments?: Array<{ fileName: string; contentType: string; sizeBytes: number }> | null;
  sms?: { smsId: string; from: string; to: string; body: string } | null;
  number?: { numberId: string; e164: string | null; providerRef: string | null; country: string } | null;
}

export interface RevealRequest {
  requestId: string;
  kind: "agent_credential" | "owner_identity" | "provider_secret";
  /** v41: the provider secret's name (kind provider_secret). */
  secretName?: string;
  ephemeralPub: string;
  class?: string;
  vaultRef?: string;
  agentId?: string;
  accountId?: string;
  credentialKind?: string;
}

export type IxResult = { ok: true; [k: string]: unknown } | { ok: false; code: string; [k: string]: unknown };

export interface IdentityGatewayPort {
  ping(): Promise<{ schemaVersion: number | null; queued: number; pending: number }>;
  claim(worker: string, leaseSha256: string): Promise<{ ok: true; job: IdentityJob | null } | { ok: false; code: string }>;
  pending(worker: string): Promise<IdentityJob[]>;
  credentialRecord(job: string, lease: string, kind: string, vaultRef: string): Promise<IxResult>;
  retiredCredentials(job: string, lease: string): Promise<string[]>;
  mailboxRecord(job: string, lease: string, address: string, provider: string): Promise<IxResult>;
  mailboxes(worker: string): Promise<Array<{ address: string; provider: string; since: string }>>;
  mailDeliver(worker: string, address: string, sender: string, subject: string, body: string, verification: boolean): Promise<IxResult>;
  mailConsumed(job: string, lease: string, messageId: string): Promise<IxResult>;
  identityAuthorize(job: string, lease: string, provider: string, purpose: string, classes: string[]): Promise<IxResult>;
  releaseRecord(job: string, lease: string, provider: string, purpose: string, classes: string[], consentId: string | null, outcome: string): Promise<IxResult>;
  report(job: string, lease: string, outcome: "pending" | "succeeded" | "failed" | "human_action_required", result: Record<string, unknown>,
    account: Record<string, unknown>): Promise<IxResult>;
  // v36
  mailDeliver2(worker: string, address: string, sender: string, subject: string, body: string, withheld: boolean, providerId: string | null): Promise<IxResult>;
  mailSent(job: string, lease: string, providerId: string | null, ok: boolean): Promise<IxResult>;
  /** v56: an order delivery's files for this mail.send job, and the dedicated account connectors this broker has. */
  mailAttachments?(job: string, lease: string): Promise<{ ok: boolean; attachments?: Array<{ fileName: string; contentType: string; contentB64: string }> }>;
  connectorsPublish?(worker: string, platforms: string[]): Promise<IxResult>;
  phoneRecord(job: string, lease: string, e164: string, provider: string, providerRef: string, monthlyMinor: number | null, currency: string | null): Promise<IxResult>;
  phoneStatus(job: string, lease: string, status: "released" | "failed" | "human_action_required", reason: string | null): Promise<IxResult>;
  numbers(worker: string): Promise<Array<{ numberId: string; e164: string; provider: string; since: string }>>;
  smsDeliver(worker: string, to: string, from: string, body: string, withheld: boolean, providerId: string): Promise<IxResult>;
  smsSent(job: string, lease: string, providerId: string | null, ok: boolean): Promise<IxResult>;
  vaultInbox(worker: string): Promise<Array<{ uploadId: string; class: string; sealedB64: string; contentType: string; expiresAt: string | null }>>;
  vaultInstalled(uploadId: string, worker: string, ok: boolean, error: string | null): Promise<IxResult>;
  revealPending(worker: string): Promise<RevealRequest[]>;
  revealServe(requestId: string, worker: string, sealed: Buffer | null, error: string | null): Promise<IxResult>;
  notificationsUnsent(worker: string, limit: number): Promise<{ to: string; notifications: Array<{ id: string; class: string; code: string; agentId: string | null;
    title: string; detail: Record<string, unknown>; at: string }> } | null>;
  notificationEmailed(id: string, worker: string, ok: boolean): Promise<IxResult>;
  publishOwnerKey(worker: string, pubB64: string): Promise<IxResult>;
  // v37
  authBlobStore(kind: "mail" | "sms", messageId: string, worker: string, blob: Buffer): Promise<IxResult>;
  browserSecretsPending(worker: string): Promise<BrowserSecretRequest[]>;
  browserSecretServe(requestId: string, worker: string, sealed: Buffer | null, error: string | null, usedMessageId: string | null): Promise<IxResult>;
  browserCredentialRecord(requestId: string, worker: string, kind: string, vaultRef: string): Promise<IxResult>;
  // v41
  commsConfigure(worker: string, config: CommsProviderConfig[]): Promise<IxResult & { providers?: Array<CommsProviderConfig & { providerId: string }> }>;
  commsHealth(worker: string, providerId: string, ok: boolean, error: string | null): Promise<IxResult>;
  mailIngest(worker: string, channelId: string, message: SharedMailInput, withheld: boolean): Promise<IxResult & {
    replay?: boolean; deliveries?: Array<{ messageId: string; agentId: string | null; routing: string; address?: string | null }> }>;
  mailSent2(job: string, lease: string, providerId: string | null, externalId: string | null, ok: boolean, error: string | null): Promise<IxResult>;
  providerSecretsPublish(worker: string, list: Array<{ name: string; fields: string[]; fingerprint: string }>): Promise<IxResult>;
  phoneQuoteRecord(job: string, lease: string, quote: Record<string, unknown>): Promise<IxResult>;
  phoneRecord2(job: string, lease: string, e164: string, provider: string, providerRef: string, monthlyMicro: number | null, currency: string | null): Promise<IxResult>;
  smsCostsPending(worker: string): Promise<Array<{ smsId: string; providerMessageId: string; provider: string }>>;
  smsCost(worker: string, smsId: string, priceMicro: number, currency: string): Promise<IxResult>;
  // v51 (optional for in-memory test gateways): provider secrets sealed to the broker from the dashboard.
  providerSecretInbox?(worker: string): Promise<Array<{ uploadId: string; name: string; sealedB64: string }>>;
  providerSecretInstalled?(uploadId: string, worker: string, ok: boolean, error: string | null): Promise<IxResult>;
}

/** v41: one provider the broker is configured with (registered in the registry; none = NOT CONFIGURED). */
export interface CommsProviderConfig {
  capability: "mail" | "sms";
  provider: string;
  mode: "shared" | "dedicated" | "numbers";
  address?: string | null;
}

/** v41: an inbound message of a shared mailbox, as the broker hands it to the registry for attribution. */
export interface SharedMailInput {
  providerId: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  at: string;
}

export interface BrowserSecretRequest {
  requestId: string;
  kind: "password" | "username" | "email" | "totp" | "email_code" | "sms_code" | "api_key" | "generate_password" | "auth_link" | "capture" | "owner_fact" | "owner_card" | "owner_document";
  captureKind?: "api_key" | "password" | "recovery_codes" | "totp";
  /** v49: an owner fact or the owner's card, under the owner's standing authority (class, and the field of a structured value). */
  ownerClass?: string;
  ownerField?: string;
  agentId: string;
  accountId: string;
  workerPub: string;
  sealedInB64?: string;
  handle?: string;
  loginEmail?: string;
  credentials: Array<{ kind: string; vaultRef: string }>;
  authMessages?: Array<{ kind: "mail" | "sms"; messageId: string; blobB64: string }>;
}

export class PgIdentityGateway implements IdentityGatewayPort {
  private readonly pool: Pool;
  private readonly s: string;
  constructor(opts: { connectionString: string; schema?: string }) {
    this.s = quoteIdent(opts.schema ?? "fleet");
    this.pool = new pg.Pool({ connectionString: opts.connectionString, max: 2, application_name: "automaton-fleet-identity",
      options: "-c statement_timeout=10000 -c lock_timeout=5000" });
    this.pool.on("error", () => {});
  }
  private async call<T>(fn: string, args: unknown[]): Promise<T> {
    const ph = args.map((_, i) => `$${i + 1}`).join(", ");
    return (await this.pool.query(`SELECT ${this.s}.${fn}(${ph}) AS r`, args)).rows[0].r as T;
  }
  ping() { return this.call<{ schemaVersion: number | null; queued: number; pending: number }>("ix_ping", []); }
  claim(worker: string, leaseSha256: string) { return this.call<{ ok: true; job: IdentityJob | null } | { ok: false; code: string }>("ix_claim_job", [worker, leaseSha256]); }
  pending(worker: string) { return this.call<IdentityJob[]>("ix_pending_jobs", [worker]); }
  credentialRecord(job: string, lease: string, kind: string, vaultRef: string) { return this.call<IxResult>("ix_credential_record", [job, lease, kind, vaultRef]); }
  retiredCredentials(job: string, lease: string) { return this.call<string[]>("ix_retired_credentials", [job, lease]); }
  mailboxRecord(job: string, lease: string, address: string, provider: string) { return this.call<IxResult>("ix_mailbox_record", [job, lease, address, provider]); }
  mailboxes(worker: string) { return this.call<Array<{ address: string; provider: string; since: string }>>("ix_mailboxes", [worker]); }
  mailDeliver(worker: string, address: string, sender: string, subject: string, body: string, verification: boolean) {
    return this.call<IxResult>("ix_mail_deliver", [worker, address, sender, subject, body, verification]);
  }
  mailConsumed(job: string, lease: string, messageId: string) { return this.call<IxResult>("ix_mail_consumed", [job, lease, messageId]); }
  identityAuthorize(job: string, lease: string, provider: string, purpose: string, classes: string[]) {
    return this.call<IxResult>("ix_identity_authorize", [job, lease, provider, purpose, classes]);
  }
  releaseRecord(job: string, lease: string, provider: string, purpose: string, classes: string[], consentId: string | null, outcome: string) {
    return this.call<IxResult>("ix_release_record", [job, lease, provider, purpose, classes, consentId, outcome]);
  }
  report(job: string, lease: string, outcome: "pending" | "succeeded" | "failed" | "human_action_required", result: Record<string, unknown>, account: Record<string, unknown>) {
    return this.call<IxResult>("ix_report_job", [job, lease, outcome, JSON.stringify(result), JSON.stringify(account)]);
  }
  mailDeliver2(worker: string, address: string, sender: string, subject: string, body: string, withheld: boolean, providerId: string | null) {
    return this.call<IxResult>("ix_mail_deliver2", [worker, address, sender, subject, body, withheld, providerId]);
  }
  mailSent(job: string, lease: string, providerId: string | null, ok: boolean) { return this.call<IxResult>("ix_mail_sent", [job, lease, providerId, ok]); }
  phoneRecord(job: string, lease: string, e164: string, provider: string, providerRef: string, monthlyMinor: number | null, currency: string | null) {
    return this.call<IxResult>("ix_phone_record", [job, lease, e164, provider, providerRef, monthlyMinor, currency]);
  }
  phoneStatus(job: string, lease: string, status: "released" | "failed" | "human_action_required", reason: string | null) {
    return this.call<IxResult>("ix_phone_status", [job, lease, status, reason]);
  }
  numbers(worker: string) { return this.call<Array<{ numberId: string; e164: string; provider: string; since: string }>>("ix_numbers", [worker]); }
  smsDeliver(worker: string, to: string, from: string, body: string, withheld: boolean, providerId: string) {
    return this.call<IxResult>("ix_sms_deliver", [worker, to, from, body, withheld, providerId]);
  }
  smsSent(job: string, lease: string, providerId: string | null, ok: boolean) { return this.call<IxResult>("ix_sms_sent", [job, lease, providerId, ok]); }
  vaultInbox(worker: string) {
    return this.call<Array<{ uploadId: string; class: string; sealedB64: string; contentType: string; expiresAt: string | null }>>("ix_vault_inbox", [worker]);
  }
  vaultInstalled(uploadId: string, worker: string, ok: boolean, error: string | null) { return this.call<IxResult>("ix_vault_installed", [uploadId, worker, ok, error]); }
  revealPending(worker: string) { return this.call<RevealRequest[]>("ix_reveal_pending", [worker]); }
  revealServe(requestId: string, worker: string, sealed: Buffer | null, error: string | null) {
    return this.call<IxResult>("ix_reveal_serve", [requestId, worker, sealed, error]);
  }
  notificationsUnsent(worker: string, limit: number) {
    return this.call<{ to: string; notifications: Array<{ id: string; class: string; code: string; agentId: string | null; title: string;
      detail: Record<string, unknown>; at: string }> } | null>("ix_notifications_unsent", [worker, limit]);
  }
  notificationEmailed(id: string, worker: string, ok: boolean) { return this.call<IxResult>("ix_notification_emailed", [id, worker, ok]); }
  publishOwnerKey(worker: string, pubB64: string) { return this.call<IxResult>("ix_publish_owner_key", [worker, pubB64]); }
  authBlobStore(kind: "mail" | "sms", messageId: string, worker: string, blob: Buffer) { return this.call<IxResult>("ix_auth_blob_store", [kind, messageId, worker, blob]); }
  browserSecretsPending(worker: string) { return this.call<BrowserSecretRequest[]>("ix_browser_secrets_pending", [worker]); }
  browserSecretServe(requestId: string, worker: string, sealed: Buffer | null, error: string | null, usedMessageId: string | null) {
    return this.call<IxResult>("ix_browser_secret_serve", [requestId, worker, sealed, error, usedMessageId]);
  }
  browserCredentialRecord(requestId: string, worker: string, kind: string, vaultRef: string) {
    return this.call<IxResult>("ix_browser_credential_record", [requestId, worker, kind, vaultRef]);
  }
  commsConfigure(worker: string, config: CommsProviderConfig[]) {
    return this.call<IxResult & { providers?: Array<CommsProviderConfig & { providerId: string }> }>("ix_comms_configure", [worker, JSON.stringify(config)]);
  }
  commsHealth(worker: string, providerId: string, ok: boolean, error: string | null) { return this.call<IxResult>("ix_comms_health", [worker, providerId, ok, error]); }
  mailIngest(worker: string, channelId: string, message: SharedMailInput, withheld: boolean) {
    return this.call<IxResult & { replay?: boolean; deliveries?: Array<{ messageId: string; agentId: string | null; routing: string; address?: string | null }> }>(
      "ix_mail_ingest", [worker, channelId, JSON.stringify(message), withheld]);
  }
  mailAttachments(job: string, lease: string) {
    return this.call<{ ok: boolean; attachments?: Array<{ fileName: string; contentType: string; contentB64: string }> }>("ix_mail_attachments", [job, lease]);
  }
  connectorsPublish(worker: string, platforms: string[]) { return this.call<IxResult>("ix_connectors_publish", [worker, JSON.stringify(platforms)]); }
  mailSent2(job: string, lease: string, providerId: string | null, externalId: string | null, ok: boolean, error: string | null) {
    return this.call<IxResult>("ix_mail_sent2", [job, lease, providerId, externalId, ok, error]);
  }
  providerSecretsPublish(worker: string, list: Array<{ name: string; fields: string[]; fingerprint: string }>) {
    return this.call<IxResult>("ix_provider_secrets_publish", [worker, JSON.stringify(list)]);
  }
  phoneQuoteRecord(job: string, lease: string, quote: Record<string, unknown>) { return this.call<IxResult>("ix_phone_quote_record", [job, lease, JSON.stringify(quote)]); }
  phoneRecord2(job: string, lease: string, e164: string, provider: string, providerRef: string, monthlyMicro: number | null, currency: string | null) {
    return this.call<IxResult>("ix_phone_record2", [job, lease, e164, provider, providerRef, monthlyMicro, currency]);
  }
  smsCostsPending(worker: string) { return this.call<Array<{ smsId: string; providerMessageId: string; provider: string }>>("ix_sms_costs_pending", [worker]); }
  smsCost(worker: string, smsId: string, priceMicro: number, currency: string) { return this.call<IxResult>("ix_sms_cost", [worker, smsId, priceMicro, currency]); }
  providerSecretInbox(worker: string) { return this.call<Array<{ uploadId: string; name: string; sealedB64: string }>>("ix_provider_secret_inbox", [worker]); }
  providerSecretInstalled(uploadId: string, worker: string, ok: boolean, error: string | null) {
    return this.call<IxResult>("ix_provider_secret_installed", [uploadId, worker, ok, error]);
  }
  async close(): Promise<void> {
    await this.pool.end().catch(() => {});
  }
}

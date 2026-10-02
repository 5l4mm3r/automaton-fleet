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
  message?: { messageId: string; from: string; to: string[]; subject: string; body: string; inReplyTo: string | null } | null;
  sms?: { smsId: string; from: string; to: string; body: string } | null;
  number?: { numberId: string; e164: string | null; providerRef: string | null; country: string } | null;
}

export interface RevealRequest {
  requestId: string;
  kind: "agent_credential" | "owner_identity";
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
  async close(): Promise<void> {
    await this.pool.end().catch(() => {});
  }
}

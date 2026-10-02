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
  async close(): Promise<void> {
    await this.pool.end().catch(() => {});
  }
}

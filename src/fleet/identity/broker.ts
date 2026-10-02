/**
 * Identity broker (schema v34): the ONLY process that holds agent account credentials and owner identity. It executes
 * the identity jobs agents queue (create/operate/verify/recover/rotate/revoke/close accounts, provision mailboxes) and
 * reports statuses. Agents never receive a secret: passwords are generated here, stored in the agent credential vault
 * and used here; verification emails are consumed here; owner identity is opened here only for a release the registry
 * authorised under the owner's standing consent, handed to the provider connector, and recorded as classes only.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { generatePassword } from "./crypto.js";
import type { IdentityGatewayPort, IdentityJob } from "./gateway.js";
import { findVerification, redactMail, type AccountOutcome, type MailMessage, type MailProvider, type PlatformConnector } from "./providers.js";
import type { AgentCredentialVault, OwnerIdentityVault, OwnerIdentityClass } from "./vaults.js";

type JobOutcome = { outcome: "pending" | "succeeded" | "failed" | "human_action_required"; result: Record<string, unknown>; account: Record<string, unknown> };

export interface BrokerOptions {
  worker?: string;
  mail?: MailProvider | null;
  connectors?: PlatformConnector[];
  ownerVault?: OwnerIdentityVault | null;
  stateFile?: string | null;
  log?: (level: string, event: string, detail?: Record<string, unknown>) => void;
}

const failed = (code: string, note?: string, account: Record<string, unknown> = {}): JobOutcome =>
  ({ outcome: "failed", result: { status: "failed", code, note }, account });

export class IdentityBroker {
  private readonly worker: string;
  private readonly connectors: Map<string, PlatformConnector>;
  private readonly leases = new Map<string, string>();
  private readonly seenMail = new Map<string, string>(); // provider message id -> registry message id

  constructor(private readonly gw: IdentityGatewayPort, private readonly vault: AgentCredentialVault, private readonly o: BrokerOptions = {}) {
    this.worker = o.worker ?? "identity-broker";
    if (!/^[a-z0-9_.-]{1,64}$/.test(this.worker)) throw new Error("worker name must match ^[a-z0-9_.-]{1,64}$");
    this.connectors = new Map((o.connectors ?? []).map((c) => [c.platform, c]));
    if (this.connectors.size !== (o.connectors ?? []).length) throw new Error("one connector per platform");
    this.loadLeases();
  }

  private log(level: string, event: string, detail?: Record<string, unknown>) {
    this.o.log?.(level, event, detail);
  }

  private loadLeases(): void {
    const f = this.o.stateFile;
    if (!f || !fs.existsSync(f)) return;
    const st = fs.lstatSync(f);
    if (!st.isFile() || (st.mode & 0o077) !== 0) throw new Error("identity broker state file must be a regular 0600 file");
    for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, string>)) this.leases.set(k, v);
  }

  private saveLeases(): void {
    const f = this.o.stateFile;
    if (!f) return;
    const tmp = path.join(path.dirname(f), `.${path.basename(f)}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.leases)), { mode: 0o600 });
    fs.renameSync(tmp, f);
  }

  /** Mail sync: provider messages → the owning agent's inbox, sanitised (links and codes redacted). */
  async syncMail(): Promise<number> {
    if (!this.o.mail) return 0;
    let n = 0;
    for (const b of await this.gw.mailboxes(this.worker)) {
      for (const m of await this.o.mail.fetch(b.address, new Date(0))) {
        if (this.seenMail.has(m.id)) continue;
        const v = findVerification(m.body);
        const r = await this.gw.mailDeliver(this.worker, m.to, m.from, m.subject, redactMail(m.body), !!(v.link || v.code));
        if (r.ok) {
          this.seenMail.set(m.id, String(r.messageId));
          n++;
        }
      }
    }
    return n;
  }

  private async password(job: IdentityJob): Promise<{ ref: string } | null> {
    const c = job.credentials.find((x) => x.kind === "password");
    return c ? { ref: c.vaultRef } : null;
  }

  private scope(job: IdentityJob, kind = "password") {
    return { agentId: job.agentId, accountId: job.accountId!, kind };
  }

  private async newPassword(job: IdentityJob, lease: string): Promise<string> {
    const pw = generatePassword();
    const ref = this.vault.put(this.scope(job), pw);
    const r = await this.gw.credentialRecord(job.jobId, lease, "password", ref);
    if (!r.ok) {
      this.vault.shred(ref);
      throw new Error(`FLEET_CREDENTIAL_RECORD_FAILED`);
    }
    return pw;
  }

  /** Try to consume a verification email the platform sent to the account's mailbox. */
  private async confirmFromMail(job: IdentityJob, lease: string, c: PlatformConnector, ref: string | null, email: string | null): Promise<boolean> {
    if (!this.o.mail || !email) return false;
    for (const m of await this.o.mail.fetch(email, new Date(Date.now() - 7 * 86_400_000))) {
      if (!findVerification(m.body).link && !findVerification(m.body).code) continue;
      const r = await c.confirmEmail({ providerAccountRef: ref, message: m });
      if (r.outcome === "succeeded") {
        await this.syncMail();
        const id = this.seenMail.get(m.id);
        if (id) await this.gw.mailConsumed(job.jobId, lease, id);
        return true;
      }
    }
    return false;
  }

  private fromAccountOutcome(r: AccountOutcome, account: Record<string, unknown> = {}): JobOutcome {
    switch (r.outcome) {
      case "succeeded":
        return { outcome: "succeeded", result: { status: "succeeded", note: r.note, data: r.data }, account: { ...account, ...(r.reputation ? { reputation: r.reputation } : {}) } };
      case "pending":
        return { outcome: "pending", result: { status: "pending", note: r.note }, account };
      case "human_action_required":
        return { outcome: "human_action_required", result: { status: "human_action_required", code: r.code, note: r.note }, account: { ...account, status: "human_action_required", reason: r.note } };
      default:
        return failed(r.code, r.note, account);
    }
  }

  /** Execute one job (claimed or pending) under its lease. */
  async handle(job: IdentityJob, lease: string): Promise<JobOutcome> {
    const c = job.account ? this.connectors.get(job.account.platform) : undefined;
    const email = (job.params.useMailbox as string | undefined) ?? job.mailboxes[0] ?? null;
    switch (job.kind) {
      case "mailbox.provision": {
        if (!this.o.mail) return failed("FLEET_NO_MAIL_PROVIDER", "no mail provider is configured for the Fleet yet");
        const { address } = await this.o.mail.provision((job.params.localPart as string | null) ?? null, job.account?.displayName ?? `agent-${job.agentId.slice(-6).toLowerCase()}`);
        const r = await this.gw.mailboxRecord(job.jobId, lease, address, this.o.mail.name);
        if (!r.ok) return failed(String(r.code), "the address is already mapped");
        return { outcome: "succeeded", result: { status: "succeeded", data: { address } }, account: {} };
      }
      case "account.create": {
        if (!c) return failed("FLEET_NO_CONNECTOR", `no adapter for ${job.account?.platform} yet — choose another platform or channel`, { status: "failed" });
        if (job.account?.providerAccountRef) {
          // A pending creation: only the email verification is left.
          const ok = await this.confirmFromMail(job, lease, c, job.account.providerAccountRef, email);
          return ok ? { outcome: "succeeded", result: { status: "succeeded" }, account: { status: "active", verification: "email_verified" } }
            : { outcome: "pending", result: { status: "pending", note: "waiting for the verification email" }, account: {} };
        }
        const pw = await this.newPassword(job, lease);
        const r = await c.createAccount({ handle: job.account?.handle ?? null, displayName: job.account?.displayName ?? null, email, password: pw });
        if (r.outcome !== "succeeded") return this.fromAccountOutcome(r, { status: r.outcome === "human_action_required" ? "human_action_required" : "failed" });
        const base = { providerAccountRef: r.providerAccountRef, handle: r.handle, credentialHealth: "ok" };
        if (!r.needsEmailVerification) return { outcome: "succeeded", result: { status: "succeeded" }, account: { ...base, status: "active" } };
        const ok = await this.confirmFromMail(job, lease, c, r.providerAccountRef ?? null, email);
        return ok ? { outcome: "succeeded", result: { status: "succeeded" }, account: { ...base, status: "active", verification: "email_verified" } }
          : { outcome: "pending", result: { status: "pending", note: "waiting for the verification email" }, account: { ...base, status: "pending_verification", verification: "email_pending" } };
      }
      case "account.operate": {
        if (!c) return failed("FLEET_NO_CONNECTOR");
        const p = await this.password(job);
        if (!p) return failed("FLEET_CREDENTIAL_UNAVAILABLE", "this account has no active credential (recover or rotate it)");
        const r = await this.vault.withSecret(p.ref, this.scope(job), (password) =>
          c.operate({ providerAccountRef: job.account!.providerAccountRef, action: String(job.params.action), params: (job.params.params as Record<string, unknown>) ?? {}, password }));
        return r.outcome === "pending" ? failed("account_not_ready", r.note) : this.fromAccountOutcome(r);
      }
      case "account.verify_identity": {
        if (!c) return failed("FLEET_NO_CONNECTOR");
        const purpose = String(job.params.purpose ?? "account_verification");
        const need = c.identityRequirement(purpose);
        if (need.kind === "none") return { outcome: "succeeded", result: { status: "verified" }, account: { verification: "identity_verified" } };
        if (need.kind === "human_only") {
          await this.gw.releaseRecord(job.jobId, lease, c.platform, purpose, [], null, "human_action_required");
          return { outcome: "human_action_required", result: { status: "human_action_required", code: "FLEET_HUMAN_ONLY_VERIFICATION", note: need.reason },
            account: { status: "human_action_required", verification: "identity_pending", reason: need.reason } };
        }
        const auth = await this.gw.identityAuthorize(job.jobId, lease, c.platform, purpose, need.classes);
        if (!auth.ok) {
          await this.gw.releaseRecord(job.jobId, lease, c.platform, purpose, [], null, "no_consent");
          const note = auth.code === "FLEET_NO_STANDING_CONSENT"
            ? "the owner has not authorised identity use for this provider/purpose" : "the owner has not provided the identity information this provider needs";
          return { outcome: "human_action_required", result: { status: "human_action_required", code: String(auth.code), note },
            account: { status: "human_action_required", verification: "identity_pending", reason: note } };
        }
        let outcome: "verified" | "pending" | "rejected" | "human_action_required";
        {
          const facts = this.o.ownerVault?.open(need.classes as OwnerIdentityClass[]);
          if (!facts) return failed("FLEET_OWNER_VAULT_UNAVAILABLE", "the owner identity vault is not available to the broker");
          outcome = await c.verifyIdentity({ providerAccountRef: job.account!.providerAccountRef, purpose, facts });
          for (const k of Object.keys(facts)) facts[k] = "";
        }
        await this.gw.releaseRecord(job.jobId, lease, c.platform, purpose, need.classes, String(auth.consentId), outcome);
        if (outcome === "verified") return { outcome: "succeeded", result: { status: "verified" }, account: { status: "active", verification: "identity_verified" } };
        if (outcome === "pending") return { outcome: "pending", result: { status: "pending" }, account: { verification: "identity_pending" } };
        if (outcome === "rejected") return { outcome: "failed", result: { status: "rejected", code: "identity_rejected" }, account: { verification: "identity_rejected" } };
        return { outcome: "human_action_required", result: { status: "human_action_required", code: "FLEET_HUMAN_ONLY_VERIFICATION" },
          account: { status: "human_action_required", verification: "identity_pending" } };
      }
      case "account.recover": {
        if (!c) return failed("FLEET_NO_CONNECTOR");
        const pw = generatePassword();
        const r = await c.recover({ providerAccountRef: job.account!.providerAccountRef, email, newPassword: pw });
        if (r.outcome !== "succeeded") return this.fromAccountOutcome(r);
        const ref = this.vault.put(this.scope(job), pw);
        await this.gw.credentialRecord(job.jobId, lease, "password", ref);
        return { outcome: "succeeded", result: { status: "recovered" }, account: { credentialHealth: "ok", status: "active" } };
      }
      case "credential.rotate": {
        if (!c) return failed("FLEET_NO_CONNECTOR");
        const p = await this.password(job);
        if (!p) return failed("FLEET_CREDENTIAL_UNAVAILABLE", "no active credential: recover the account instead");
        const pw = generatePassword();
        const r = await this.vault.withSecret(p.ref, this.scope(job), (old) => c.rotate({ providerAccountRef: job.account!.providerAccountRef, oldPassword: old, newPassword: pw }));
        if (r.outcome !== "succeeded") return this.fromAccountOutcome(r);
        await this.gw.credentialRecord(job.jobId, lease, "password", this.vault.put(this.scope(job), pw));
        for (const ref of await this.gw.retiredCredentials(job.jobId, lease)) this.vault.shred(ref);
        return { outcome: "succeeded", result: { status: "rotated" }, account: { credentialHealth: "ok" } };
      }
      case "credential.revoke": {
        let n = 0;
        for (const ref of await this.gw.retiredCredentials(job.jobId, lease)) if (this.vault.shred(ref)) n++;
        return { outcome: "succeeded", result: { status: "revoked", data: { shredded: n } }, account: { credentialHealth: "revoked" } };
      }
      case "account.close": {
        if (!c) return failed("FLEET_NO_CONNECTOR");
        const p = await this.password(job);
        const r = p ? await this.vault.withSecret(p.ref, this.scope(job), (password) => c.close({ providerAccountRef: job.account!.providerAccountRef, password }))
          : ({ outcome: "succeeded" } as AccountOutcome);
        return r.outcome === "succeeded" ? { outcome: "succeeded", result: { status: "closed" }, account: { status: "closed" } } : this.fromAccountOutcome(r);
      }
      default:
        return failed("FLEET_UNKNOWN_JOB");
    }
  }

  private async run(job: IdentityJob, lease: string): Promise<string> {
    let out: JobOutcome;
    try {
      out = await this.handle(job, lease);
    } catch (err) {
      // Codes only: no exception text that could carry a secret leaves the broker.
      const code = /FLEET_[A-Z_]+/.exec(err instanceof Error ? err.message : "")?.[0] ?? "broker_error";
      out = failed(code, "the identity broker could not complete this job");
    }
    if (out.outcome === "pending") this.leases.set(job.jobId, lease);
    else this.leases.delete(job.jobId);
    this.saveLeases();
    const r = await this.gw.report(job.jobId, lease, out.outcome, out.result, out.account);
    if (!r.ok) this.log("error", "identity_report_refused", { jobId: job.jobId, code: r.code });
    this.log("info", "identity_job_finished", { jobId: job.jobId, kind: job.kind, outcome: out.outcome, code: out.result.code ?? null });
    return out.outcome;
  }

  /** One pass: sync mail, re-check pending jobs, then process queued jobs (up to `max`). */
  async tick(max = 10): Promise<{ processed: number; outcomes: string[] }> {
    const outcomes: string[] = [];
    await this.syncMail();
    for (const job of await this.gw.pending(this.worker)) {
      const lease = this.leases.get(job.jobId);
      if (lease) outcomes.push(await this.run(job, lease));
    }
    for (let i = 0; i < max; i++) {
      const lease = crypto.randomBytes(32).toString("base64url");
      const c = await this.gw.claim(this.worker, crypto.createHash("sha256").update(lease, "utf8").digest("hex"));
      if (!c.ok || !c.job) break;
      outcomes.push(await this.run(c.job, lease));
    }
    await this.syncMail();
    return { processed: outcomes.length, outcomes };
  }
}

export type { MailMessage };

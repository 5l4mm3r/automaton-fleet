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
import { generatePassword, sealTo } from "./crypto.js";
import type { IdentityGatewayPort, IdentityJob } from "./gateway.js";
import { findVerification, isAuthenticationMessage, redactMail, type AccountOutcome, type MailMessage, type MailProvider, type PlatformConnector,
  type SmsProvider } from "./providers.js";
import { OWNER_IDENTITY_CLASSES, type AgentCredentialVault, type OwnerIdentityVault, type OwnerIdentityClass } from "./vaults.js";

type JobOutcome = { outcome: "pending" | "succeeded" | "failed" | "human_action_required"; result: Record<string, unknown>; account: Record<string, unknown> };

export interface BrokerOptions {
  worker?: string;
  mail?: MailProvider | null;
  /** v36: programmable numbers and SMS. */
  sms?: SmsProvider | null;
  /** v36: the Fleet address Admin notifications are sent from (needs a mail provider). */
  notifyFrom?: string | null;
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
  private keyPublished = false;

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

  /**
   * Mail sync (v36): provider messages → the owning agent's mailbox, WHOLE (business mail is the agent's own); only an
   * account-authentication message has its link/code withheld (the broker uses it). Provider ids make it idempotent.
   */
  async syncMail(): Promise<number> {
    if (!this.o.mail) return 0;
    let n = 0;
    for (const b of await this.gw.mailboxes(this.worker)) {
      for (const m of await this.o.mail.fetch(b.address, new Date(new Date(b.since).getTime() - 3_600_000))) {
        if (this.seenMail.has(m.id)) continue;
        const auth = isAuthenticationMessage(m.subject, m.body);
        const r = await this.gw.mailDeliver2(this.worker, m.to, m.from, m.subject, auth ? redactMail(m.body) : m.body, auth, m.id);
        if (r.ok) {
          this.seenMail.set(m.id, String(r.messageId));
          if (!r.replay) n++;
        }
      }
    }
    return n;
  }

  /** SMS sync (v36): inbound texts → the owning agent; authentication codes withheld, everything else whole. */
  async syncSms(): Promise<number> {
    if (!this.o.sms) return 0;
    let n = 0;
    for (const num of await this.gw.numbers(this.worker)) {
      for (const m of await this.o.sms.fetch(num.e164, new Date(new Date(num.since).getTime() - 3_600_000))) {
        const auth = isAuthenticationMessage("", m.body);
        const r = await this.gw.smsDeliver(this.worker, m.to, m.from, auth ? redactMail(m.body) : m.body, auth, m.id);
        if (r.ok && !r.replay) n++;
      }
    }
    return n;
  }

  /** v36: install owner identity uploads sealed (at the dashboard) to this broker's key; the database copy is erased. */
  async installVaultUploads(): Promise<number> {
    const ov = this.o.ownerVault;
    if (!ov) return 0;
    let n = 0;
    for (const u of await this.gw.vaultInbox(this.worker)) {
      try {
        if (!OWNER_IDENTITY_CLASSES.includes(u.class as OwnerIdentityClass)) throw new Error("FLEET_BAD_REQUEST");
        ov.install(u.class as OwnerIdentityClass, Buffer.from(u.sealedB64, "base64"));
        await this.gw.vaultInstalled(u.uploadId, this.worker, true, null);
        n++;
      } catch {
        await this.gw.vaultInstalled(u.uploadId, this.worker, false, "not sealed to this broker's key for that class");
      }
    }
    return n;
  }

  /**
   * v36: Admin reveals. Nothing is hidden from Admin: the requested credential or owner fact is opened here and sealed
   * to the Admin session's ephemeral key (scope reveal:<requestId>); the plaintext never leaves this process unsealed.
   */
  async serveReveals(): Promise<number> {
    let n = 0;
    for (const r of await this.gw.revealPending(this.worker)) {
      let sealed: Buffer | null = null;
      let error: string | null = null;
      try {
        const pub = Buffer.from(r.ephemeralPub, "base64");
        if (r.kind === "agent_credential") {
          if (!r.vaultRef || !r.agentId || !r.accountId || !r.credentialKind) throw new Error("FLEET_BAD_REQUEST");
          sealed = await this.vault.withSecret(r.vaultRef, { agentId: r.agentId, accountId: r.accountId, kind: r.credentialKind },
            async (secret) => sealTo(pub, secret, `reveal:${r.requestId}`));
        } else {
          if (!this.o.ownerVault || !r.class) throw new Error("FLEET_OWNER_VAULT_UNAVAILABLE");
          const v = this.o.ownerVault.open([r.class as OwnerIdentityClass]);
          sealed = sealTo(pub, v[r.class], `reveal:${r.requestId}`);
        }
      } catch (err) {
        error = /FLEET_[A-Z_]+/.exec(err instanceof Error ? err.message : "")?.[0] ?? "reveal_failed";
      }
      await this.gw.revealServe(r.requestId, this.worker, sealed, error);
      n++;
    }
    return n;
  }

  /** v36: email Admin the notification classes the policy selects (the broker holds the mail provider credential). */
  async emailNotifications(): Promise<number> {
    if (!this.o.mail || !this.o.notifyFrom) return 0;
    const u = await this.gw.notificationsUnsent(this.worker, 20);
    if (!u || !u.to) return 0;
    let n = 0;
    for (const x of u.notifications) {
      let ok = false;
      try {
        await this.o.mail.send({ from: this.o.notifyFrom, to: [u.to], subject: `[Fleet ${x.class}] ${x.title}`,
          body: `${x.title}\n\nClass: ${x.class}  Code: ${x.code}${x.agentId ? `  Agent: ${x.agentId}` : ""}\nAt: ${x.at}\n\n${JSON.stringify(x.detail, null, 2)}` });
        ok = true;
        n++;
      } catch {
        ok = false;
      }
      await this.gw.notificationEmailed(x.id, this.worker, ok);
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
      case "mail.send": {
        if (!this.o.mail) return failed("FLEET_NO_MAIL_PROVIDER");
        const m = job.message;
        if (!m) return failed("FLEET_NOT_FOUND", "the message is gone");
        try {
          const r = await this.o.mail.send({ from: m.from, to: m.to, subject: m.subject, body: m.body, inReplyTo: m.inReplyTo });
          await this.gw.mailSent(job.jobId, lease, r.providerMessageId, true);
          return { outcome: "succeeded", result: { status: "sent", data: { messageId: m.messageId } }, account: {} };
        } catch {
          await this.gw.mailSent(job.jobId, lease, null, false);
          return failed("FLEET_MAIL_SEND_FAILED", "the mail provider refused or was unavailable; try again later or another channel");
        }
      }
      case "phone.provision": {
        if (!this.o.sms) return failed("FLEET_NO_SMS_PROVIDER");
        const country = String(job.params.country ?? job.number?.country ?? "");
        const r = await this.o.sms.provision(country);
        if (r.outcome === "succeeded") {
          const rec = await this.gw.phoneRecord(job.jobId, lease, r.e164, this.o.sms.name, r.providerRef, r.monthlyMinor ?? null, r.currency ?? null);
          return { outcome: "succeeded", result: { status: "active", data: { e164: r.e164, commitmentId: rec.commitmentId ?? null } }, account: {} };
        }
        if (r.outcome === "human_action_required") {
          await this.gw.phoneStatus(job.jobId, lease, "human_action_required", r.note);
          return { outcome: "failed", result: { status: "failed", code: r.code, note: `${r.note} — this number only; choose another country or channel` }, account: {} };
        }
        await this.gw.phoneStatus(job.jobId, lease, "failed", r.note ?? r.code);
        return failed(r.code, r.note);
      }
      case "phone.release": {
        if (!this.o.sms) return failed("FLEET_NO_SMS_PROVIDER");
        const ref = job.number?.providerRef;
        const r = ref ? await this.o.sms.release(ref) : { ok: true };
        if (!r.ok) return failed(r.code ?? "release_failed");
        await this.gw.phoneStatus(job.jobId, lease, "released", null);
        return { outcome: "succeeded", result: { status: "released" }, account: {} };
      }
      case "sms.send": {
        if (!this.o.sms) return failed("FLEET_NO_SMS_PROVIDER");
        const m = job.sms;
        if (!m) return failed("FLEET_NOT_FOUND");
        try {
          const r = await this.o.sms.send({ from: m.from, to: m.to, body: m.body });
          await this.gw.smsSent(job.jobId, lease, r.providerMessageId, true);
          return { outcome: "succeeded", result: { status: "sent", data: { smsId: m.smsId } }, account: {} };
        } catch {
          await this.gw.smsSent(job.jobId, lease, null, false);
          return failed("FLEET_SMS_SEND_FAILED", "the SMS provider refused or was unavailable");
        }
      }
      case "credential.rebind": {
        // v35 estate transfer: re-seal each active credential from the previous owner's scope to the new owner's, then
        // shred the retired blobs. A blob that does not belong to (previous agent, this account, kind) cannot be opened.
        const from = typeof job.params.fromAgent === "string" ? job.params.fromAgent : "";
        if (!from) return failed("FLEET_BAD_REQUEST", "no previous owner");
        let n = 0;
        for (const cred of job.credentials) {
          const secret = await this.vault.withSecret(cred.vaultRef, { agentId: from, accountId: job.accountId!, kind: cred.kind }, async (s) => s);
          await this.gw.credentialRecord(job.jobId, lease, cred.kind, this.vault.put(this.scope(job, cred.kind), secret));
          n++;
        }
        for (const ref of await this.gw.retiredCredentials(job.jobId, lease)) this.vault.shred(ref);
        return { outcome: "succeeded", result: { status: "rebound", data: { credentials: n } }, account: { credentialHealth: n ? "ok" : "none" } };
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
    if (!this.keyPublished && this.o.ownerVault) {
      const r = await this.gw.publishOwnerKey(this.worker, this.o.ownerVault.publicKeyBase64());
      this.keyPublished = r.ok;
    }
    await this.syncMail();
    await this.syncSms();
    await this.installVaultUploads();
    await this.serveReveals();
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
    await this.emailNotifications();
    return { processed: outcomes.length, outcomes };
  }
}

export type { MailMessage };

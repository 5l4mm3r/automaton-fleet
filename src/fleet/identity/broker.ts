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
import { generatePassword, sealTo, totp } from "./crypto.js";
import type { CommsProviderConfig, IdentityGatewayPort, IdentityJob } from "./gateway.js";
import { findVerification, isAuthenticationMessage, redactMail, type AccountOutcome, type MailMessage, type MailProvider, type NumberType,
  type PlatformConnector, type SmsProvider } from "./providers.js";
import { OWNER_IDENTITY_CLASSES, type AgentCredentialVault, type OwnerIdentityVault, type OwnerIdentityClass, type ProviderSecretVault } from "./vaults.js";

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
  /** v41: the providers' master secrets (Admin reveal) and the shared mailbox's read cursor (a private 0600 file). */
  providerVault?: ProviderSecretVault | null;
  mailCursorFile?: string | null;
  log?: (level: string, event: string, detail?: Record<string, unknown>) => void;
  /**
   * v51: builds a mail / SMS provider from a secret the owner sealed to this broker (dashboard onboarding), so the provider
   * starts without a restart. Returns null when the secret cannot make a provider (it is still installed).
   */
  providerFactory?: (name: string, secret: Record<string, string>) => { mail?: MailProvider; sms?: SmsProvider } | null;
}

/** v51: the fields a dashboard-sealed provider secret must carry. */
export const PROVIDER_SECRET_FIELDS: Record<string, Array<string[]>> = {
  "proton-bridge": [["address", "username", "password", "certPem"]],
  twilio: [["accountSid", "apiKeySid", "apiKeySecret"], ["accountSid", "authToken"]],
};
/** v51: owner documents a form may receive (sealed to the browser worker for one upload). */
const DOCUMENT_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

const failed = (code: string, note?: string, account: Record<string, unknown> = {}): JobOutcome =>
  ({ outcome: "failed", result: { status: "failed", code, note }, account });

export class IdentityBroker {
  private readonly worker: string;
  private readonly connectors: Map<string, PlatformConnector>;
  private readonly leases = new Map<string, string>();
  private readonly seenMail = new Map<string, string>(); // provider message id -> registry message id
  private keyPublished = false;
  /** v41: the registry ids of the configured providers (null until registered). */
  private mailChannel: string | null = null;
  private smsChannel: string | null = null;
  private registered = false;
  /** v41 (shared mailbox): authentication messages seen this process, by routing address (for connector confirmations). */
  private readonly recentAuth = new Map<string, MailMessage[]>();
  /** v51: the configured providers (a dashboard-sealed secret can start one while the broker runs). */
  private mail: MailProvider | null;
  private sms: SmsProvider | null;

  constructor(private readonly gw: IdentityGatewayPort, private readonly vault: AgentCredentialVault, private readonly o: BrokerOptions = {}) {
    this.worker = o.worker ?? "identity-broker";
    if (!/^[a-z0-9_.-]{1,64}$/.test(this.worker)) throw new Error("worker name must match ^[a-z0-9_.-]{1,64}$");
    this.mail = o.mail ?? null;
    this.sms = o.sms ?? null;
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
   * v41: register exactly the providers this broker is configured with. None = NOT CONFIGURED (a deliberate state):
   * agents asking for mail / SMS get an action-scoped capability dependency and everything else continues.
   */
  async registerProviders(): Promise<void> {
    const config: CommsProviderConfig[] = [];
    if (this.mail) config.push({ capability: "mail", provider: this.mail.name, mode: this.mail.mode ?? "dedicated", address: this.mail.address ?? null });
    if (this.sms) config.push({ capability: "sms", provider: this.sms.name, mode: "numbers" });
    const r = await this.gw.commsConfigure(this.worker, config);
    if (!r.ok) throw new Error(`FLEET_COMMS_CONFIG_REFUSED`);
    const providers = r.providers ?? [];
    this.mailChannel = providers.find((p) => p.capability === "mail")?.providerId ?? null;
    this.smsChannel = providers.find((p) => p.capability === "sms")?.providerId ?? null;
    if (this.o.providerVault) await this.gw.providerSecretsPublish(this.worker, this.o.providerVault.list());
    this.registered = true;
    this.log("info", "comms_providers_registered", { mail: this.mail ? `${this.mail.name}/${this.mail.mode ?? "dedicated"}` : "NOT_CONFIGURED",
      sms: this.sms?.name ?? "NOT_CONFIGURED" });
  }

  private readCursor(): string | null {
    const f = this.o.mailCursorFile;
    if (!f || !fs.existsSync(f)) return null;
    const st = fs.lstatSync(f);
    if (!st.isFile() || (st.mode & 0o077) !== 0) throw new Error("FLEET_MAIL_CURSOR_UNSAFE");
    return fs.readFileSync(f, "utf8").trim() || null;
  }

  private writeCursor(cursor: string | null): void {
    const f = this.o.mailCursorFile;
    if (!f || cursor === null) return;
    const tmp = path.join(path.dirname(f), `.${path.basename(f)}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, cursor, { mode: 0o600 });
    fs.renameSync(tmp, f);
  }

  private memCursor: string | null = null;

  /**
   * v41: the shared mailbox — every new message goes to the registry, which attributes it (routing address,
   * conversation, awaiting verification, correspondent) or keeps it UNASSIGNED; authentication messages arrive with their
   * link/code withheld and the original sealed for the broker alone. The cursor advances only after a whole batch.
   */
  async syncShared(): Promise<number> {
    const mail = this.mail;
    if (!mail?.fetchShared || !this.mailChannel) return 0;
    let batch: Awaited<ReturnType<NonNullable<MailProvider["fetchShared"]>>>;
    try {
      batch = await mail.fetchShared(this.o.mailCursorFile ? this.readCursor() : this.memCursor);
    } catch (err) {
      const c = /FLEET_[A-Z_]+/.exec(err instanceof Error ? err.message : "")?.[0] ?? "FLEET_MAIL_PROVIDER_ERROR";
      await this.gw.commsHealth(this.worker, this.mailChannel, false, c);
      throw new Error(c);
    }
    let n = 0;
    for (const m of batch.messages) {
      const auth = isAuthenticationMessage(m.subject, m.body);
      const r = await this.gw.mailIngest(this.worker, this.mailChannel, { ...m, body: auth ? redactMail(m.body) : m.body }, auth);
      if (!r.ok) throw new Error(`FLEET_MAIL_INGEST_REFUSED`);
      if (r.replay) continue;
      for (const d of r.deliveries ?? []) {
        n++;
        this.seenMail.set(`${m.providerId}:${d.agentId ?? "-"}`, d.messageId);
        if (auth) {
          await this.gw.authBlobStore("mail", d.messageId, this.worker, this.vault.sealAux(m.body, `authmsg:mail:${d.messageId}`));
          const to = (d.address ?? "").toLowerCase();
          if (to) {
            const list = this.recentAuth.get(to) ?? [];
            list.push({ id: d.messageId, to, from: m.from, subject: m.subject, body: m.body, at: m.at });
            this.recentAuth.set(to, list.slice(-10));
          }
        }
      }
    }
    if (this.o.mailCursorFile) this.writeCursor(batch.cursor);
    else this.memCursor = batch.cursor;
    await this.gw.commsHealth(this.worker, this.mailChannel, true, null);
    return n;
  }

  /** v41: the provider's final price of each recent message, recorded for charging the agent. */
  async syncSmsCosts(): Promise<number> {
    const sms = this.sms;
    if (!sms?.messagePrice) return 0;
    let n = 0;
    for (const x of await this.gw.smsCostsPending(this.worker)) {
      if (x.provider !== sms.name) continue;
      const p = await sms.messagePrice(x.providerMessageId);
      if (!p) continue;
      const r = await this.gw.smsCost(this.worker, x.smsId, p.priceMicro, p.currency);
      if (r.ok) n++;
    }
    return n;
  }

  /**
   * Mail sync (v36): provider messages → the owning agent's mailbox, WHOLE (business mail is the agent's own); only an
   * account-authentication message has its link/code withheld (the broker uses it). Provider ids make it idempotent.
   */
  async syncMail(): Promise<number> {
    if (!this.mail) return 0;
    if (this.mail.mode === "shared") return this.syncShared();
    let n = 0;
    for (const b of await this.gw.mailboxes(this.worker)) {
      for (const m of await this.mail.fetch(b.address, new Date(new Date(b.since).getTime() - 3_600_000))) {
        if (this.seenMail.has(m.id)) continue;
        const auth = isAuthenticationMessage(m.subject, m.body);
        const r = await this.gw.mailDeliver2(this.worker, m.to, m.from, m.subject, auth ? redactMail(m.body) : m.body, auth, m.id);
        if (r.ok) {
          this.seenMail.set(m.id, String(r.messageId));
          if (!r.replay) n++;
          // v37: the withheld original, encrypted for the broker alone (credential execution: a code or link to fill).
          if (auth && !r.replay) await this.gw.authBlobStore("mail", String(r.messageId), this.worker, this.vault.sealAux(m.body, `authmsg:mail:${r.messageId}`));
        }
      }
    }
    return n;
  }

  /** SMS sync (v36): inbound texts → the owning agent; authentication codes withheld, everything else whole. */
  async syncSms(): Promise<number> {
    if (!this.sms) return 0;
    let n = 0;
    for (const num of await this.gw.numbers(this.worker)) {
      let inbound: Awaited<ReturnType<SmsProvider["fetch"]>>;
      try {
        inbound = await this.sms.fetch(num.e164, new Date(new Date(num.since).getTime() - 3_600_000));
      } catch (err) {
        if (this.smsChannel) await this.gw.commsHealth(this.worker, this.smsChannel, false, /FLEET_[A-Z_]+/.exec(err instanceof Error ? err.message : "")?.[0] ?? "FLEET_SMS_PROVIDER_ERROR");
        throw err;
      }
      for (const m of inbound) {
        const auth = isAuthenticationMessage("", m.body);
        const r = await this.gw.smsDeliver(this.worker, m.to, m.from, auth ? redactMail(m.body) : m.body, auth, m.id);
        if (r.ok && !r.replay) {
          n++;
          if (auth) await this.gw.authBlobStore("sms", String(r.smsId), this.worker, this.vault.sealAux(m.body, `authmsg:sms:${r.smsId}`));
        }
      }
    }
    if (this.smsChannel) await this.gw.commsHealth(this.worker, this.smsChannel, true, null);
    return n;
  }

  /** v36: install owner identity uploads sealed (at the dashboard) to this broker's key; the database copy is erased. */
  /**
   * v51: provider secrets the owner sealed to this broker's key (dashboard or CLI onboarding): opened here, checked for the
   * provider's fields, installed in the encrypted provider vault and — when the provider was not configured — started at
   * once (re-registered with the registry). The plaintext never leaves this process; the registry learns names only.
   */
  async installProviderSecrets(): Promise<number> {
    const ov = this.o.ownerVault;
    const pv = this.o.providerVault;
    if (!ov || !pv || !this.gw.providerSecretInbox || !this.gw.providerSecretInstalled) return 0;
    let n = 0;
    for (const u of await this.gw.providerSecretInbox(this.worker)) {
      let error: string | null = null;
      try {
        const v = ov.openProviderUpload(Buffer.from(u.sealedB64, "base64"), u.name);
        const shapes = PROVIDER_SECRET_FIELDS[u.name];
        if (!shapes || !shapes.some((fields) => fields.every((f) => typeof v[f] === "string" && v[f].length > 0))) throw new Error("FLEET_PROVIDER_SECRET_FIELDS");
        pv.put(u.name, v);
        const made = this.o.providerFactory?.(u.name, v) ?? null;
        if (made?.mail && !this.mail) { this.mail = made.mail; this.registered = false; }
        if (made?.sms && !this.sms) { this.sms = made.sms; this.registered = false; }
        if (!made?.mail && !made?.sms) this.registered = false; // republish the secret names
        n++;
      } catch (err) {
        error = /FLEET_[A-Z_]+/.exec(err instanceof Error ? err.message : "")?.[0] ?? "not sealed to this broker's key for that provider";
      }
      await this.gw.providerSecretInstalled(u.uploadId, this.worker, error === null, error);
      this.log(error ? "error" : "info", "provider_secret_install", { name: u.name, ok: error === null, code: error });
    }
    return n;
  }

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
        } else if (r.kind === "provider_secret") {
          const v = r.secretName ? this.o.providerVault?.get(r.secretName) : null;
          if (!v) throw new Error("FLEET_PROVIDER_SECRET_UNAVAILABLE");
          sealed = sealTo(pub, JSON.stringify(v), `reveal:${r.requestId}`);
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

  /**
   * v37 credential execution for the browser worker: the value a fill step needs, sealed to the worker's one-time key
   * (scope bsecret:<requestId>). The registry already checked the account and its pinned origin. A generated password or
   * a captured secret is stored in the vault first; the agent never receives any of it.
   */
  async serveBrowserSecrets(): Promise<number> {
    let n = 0;
    for (const r of await this.gw.browserSecretsPending(this.worker)) {
      let value: string | null = null;
      let error: string | null = null;
      let used: string | null = null;
      const scope = (kind: string) => ({ agentId: r.agentId, accountId: r.accountId, kind });
      const cred = (kind: string) => r.credentials.find((c) => c.kind === kind) ?? null;
      try {
        switch (r.kind) {
          case "username": value = r.handle ?? null; break;
          case "email": value = r.loginEmail ?? null; break;
          case "password": case "api_key": {
            const c = cred(r.kind);
            if (c) value = await this.vault.withSecret(c.vaultRef, scope(r.kind), async (x) => x);
            break;
          }
          case "totp": {
            const c = cred("totp");
            if (c) value = await this.vault.withSecret(c.vaultRef, scope("totp"), async (seed) => totp(seed));
            break;
          }
          case "generate_password": {
            const pw = generatePassword();
            const rec = await this.gw.browserCredentialRecord(r.requestId, this.worker, "password", this.vault.put(scope("password"), pw));
            if (rec.ok) value = pw;
            break;
          }
          case "capture": {
            if (!this.o.ownerVault || !r.sealedInB64 || !r.captureKind) break;
            const secret = this.o.ownerVault.openCapture(Buffer.from(r.sealedInB64, "base64"), `capture:${r.accountId}:${r.captureKind}`);
            const rec = await this.gw.browserCredentialRecord(r.requestId, this.worker, r.captureKind, this.vault.put(scope(r.captureKind), secret));
            if (rec.ok) value = "stored";
            break;
          }
          // v49: the owner's facts and card under the standing authority — sealed to the worker for one fill, never to the agent.
          case "owner_fact": case "owner_card": {
            if (!this.o.ownerVault || !r.ownerClass) break;
            const facts = this.o.ownerVault.open([r.ownerClass as OwnerIdentityClass]);
            try {
              value = r.kind === "owner_card" ? cardField(facts[r.ownerClass] ?? "", r.ownerField ?? "") : factField(facts[r.ownerClass] ?? "", r.ownerField ?? null);
            } finally {
              for (const k of Object.keys(facts)) facts[k] = "";
            }
            break;
          }
          // v51: an owner document for one upload into the provider's own form (never to the agent; never logged).
          case "owner_document": {
            if (!this.o.ownerVault || !r.ownerClass) break;
            const docs = this.o.ownerVault.open([r.ownerClass as OwnerIdentityClass]);
            try {
              const d = JSON.parse(docs[r.ownerClass] ?? "") as { contentType?: unknown; dataB64?: unknown };
              if (typeof d.contentType === "string" && DOCUMENT_TYPES.has(d.contentType) && typeof d.dataB64 === "string" && d.dataB64.length > 0) {
                value = JSON.stringify({ contentType: d.contentType, dataB64: d.dataB64 });
              } else {
                error = "FLEET_OWNER_DOCUMENT_INVALID";
              }
            } catch {
              error = "FLEET_OWNER_DOCUMENT_INVALID";
            } finally {
              for (const k of Object.keys(docs)) docs[k] = "";
            }
            break;
          }
          case "email_code": case "sms_code": case "auth_link": {
            for (const m of r.authMessages ?? []) {
              const body = this.vault.openAux(Buffer.from(m.blobB64, "base64"), `authmsg:${m.kind}:${m.messageId}`);
              const v = findVerification(body);
              const found = r.kind === "auth_link" ? v.link : (v.code ?? /\b(\d{4,8})\b/.exec(body)?.[1] ?? null);
              if (found) { value = found; used = m.messageId; break; }
            }
            break;
          }
        }
        if (value === null) error = error ?? (r.kind === "email_code" || r.kind === "sms_code" || r.kind === "auth_link" ? "FLEET_NO_AUTH_MESSAGE" : "FLEET_CREDENTIAL_UNAVAILABLE");
      } catch (err) {
        error = /FLEET_[A-Z_]+/.exec(err instanceof Error ? err.message : "")?.[0] ?? "FLEET_CREDENTIAL_UNAVAILABLE";
        value = null;
      }
      const sealed = value === null ? null : sealTo(Buffer.from(r.workerPub, "base64"), value, `bsecret:${r.requestId}`);
      await this.gw.browserSecretServe(r.requestId, this.worker, sealed, error, used);
      n++;
    }
    return n;
  }

  /** v36: email Admin the notification classes the policy selects (the broker holds the mail provider credential). */
  async emailNotifications(): Promise<number> {
    // v51: a shared mailbox started from the dashboard notifies from its own address.
    const from = this.o.notifyFrom || (this.mail?.mode === "shared" ? this.mail.address ?? null : null);
    if (!this.mail || !from) return 0;
    const u = await this.gw.notificationsUnsent(this.worker, 20);
    if (!u || !u.to) return 0;
    let n = 0;
    for (const x of u.notifications) {
      let ok = false;
      try {
        await this.mail.send({ from, to: [u.to], subject: `[Fleet ${x.class}] ${x.title}`,
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
    if (!this.mail || !email) return false;
    const candidates = this.mail.mode === "shared"
      ? (await this.syncShared(), [...(this.recentAuth.get(email.toLowerCase()) ?? [])])
      : await this.mail.fetch(email, new Date(Date.now() - 7 * 86_400_000));
    for (const m of candidates) {
      if (!findVerification(m.body).link && !findVerification(m.body).code) continue;
      const r = await c.confirmEmail({ providerAccountRef: ref, message: m });
      if (r.outcome === "succeeded") {
        if (this.mail.mode === "shared") {
          // m.id is the registry message id (the shared sync delivered it already).
          await this.gw.mailConsumed(job.jobId, lease, m.id);
          return true;
        }
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
        if (!this.mail) return failed("FLEET_NO_MAIL_PROVIDER", "no mail provider is configured for the Fleet yet");
        const { address } = await this.mail.provision((job.params.localPart as string | null) ?? null, job.account?.displayName ?? `agent-${job.agentId.slice(-6).toLowerCase()}`);
        const r = await this.gw.mailboxRecord(job.jobId, lease, address, this.mail.name);
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
        if (!this.mail) return failed("FLEET_NO_MAIL_PROVIDER");
        const m = job.message;
        if (!m) return failed("FLEET_NOT_FOUND", "the message is gone");
        // v41: a Fleet Message-ID (known before sending, so replies thread back) and, on the shared mailbox, the agent's
        // routing address as Reply-To.
        const domain = (this.mail.address ?? m.from).split("@")[1] ?? "fleet.invalid";
        const messageId = `<${crypto.randomUUID()}@${domain}>`;
        try {
          const r = await this.mail.send({ from: m.from, to: m.to, subject: m.subject, body: m.body, inReplyTo: m.inReplyTo,
            replyTo: m.shared ? m.replyTo ?? null : null, messageId, references: m.references ?? null });
          await this.gw.mailSent2(job.jobId, lease, r.providerMessageId, r.externalMessageId ?? messageId, true, null);
          return { outcome: "succeeded", result: { status: "sent", data: { messageId: m.messageId } }, account: {} };
        } catch (err) {
          const code = /FLEET_[A-Z_]+/.exec(err instanceof Error ? err.message : "")?.[0] ?? "FLEET_MAIL_SEND_FAILED";
          await this.gw.mailSent2(job.jobId, lease, null, null, false, code);
          if (this.mailChannel) await this.gw.commsHealth(this.worker, this.mailChannel, false, code);
          return failed("FLEET_MAIL_SEND_FAILED", "the mail provider refused or was unavailable; try again later or another channel");
        }
      }
      case "phone.provision": {
        if (!this.sms) return failed("FLEET_NO_SMS_PROVIDER");
        const country = String(job.params.country ?? job.number?.country ?? "");
        const max = Number(job.params.maxMonthlyMicro);
        const r = await this.sms.provision(country, { numberType: (job.params.numberType as NumberType | undefined) ?? undefined,
          phoneNumber: typeof job.params.phoneNumber === "string" ? job.params.phoneNumber : null,
          maxMonthlyMicro: Number.isFinite(max) && max > 0 ? max : null, currency: typeof job.params.currency === "string" ? job.params.currency : null });
        if (r.outcome === "succeeded") {
          const rec = await this.gw.phoneRecord2(job.jobId, lease, r.e164, this.sms.name, r.providerRef, r.monthlyMicro ?? null, r.currency ?? null);
          return { outcome: "succeeded", result: { status: "active", data: { e164: r.e164, commitmentId: rec.commitmentId ?? null } }, account: {} };
        }
        if (r.outcome === "human_action_required") {
          await this.gw.phoneStatus(job.jobId, lease, "human_action_required", r.note);
          return { outcome: "failed", result: { status: "failed", code: r.code, note: `${r.note} — this number only; choose another country or channel` }, account: {} };
        }
        await this.gw.phoneStatus(job.jobId, lease, "failed", r.note ?? r.code);
        return failed(r.code, r.note);
      }
      case "phone.quote": {
        if (!this.sms) return failed("FLEET_NO_SMS_PROVIDER");
        const types = (Array.isArray(job.params.numberTypes) ? job.params.numberTypes : ["mobile", "local"]) as NumberType[];
        const q = this.sms.quote ? await this.sms.quote(String(job.params.country ?? ""), types) : { error: "quote_unsupported" };
        const rec = await this.gw.phoneQuoteRecord(job.jobId, lease, q as Record<string, unknown>);
        if (!rec.ok) return failed(String(rec.code));
        return "error" in q ? failed(q.error, "no quote: try another country or number type")
          : { outcome: "succeeded", result: { status: "quoted", data: { quoteId: job.params.quoteId } }, account: {} };
      }
      case "phone.release": {
        if (!this.sms) return failed("FLEET_NO_SMS_PROVIDER");
        const ref = job.number?.providerRef;
        const r = ref ? await this.sms.release(ref) : { ok: true };
        if (!r.ok) return failed(r.code ?? "release_failed");
        await this.gw.phoneStatus(job.jobId, lease, "released", null);
        return { outcome: "succeeded", result: { status: "released" }, account: {} };
      }
      case "sms.send": {
        if (!this.sms) return failed("FLEET_NO_SMS_PROVIDER");
        const m = job.sms;
        if (!m) return failed("FLEET_NOT_FOUND");
        try {
          const r = await this.sms.send({ from: m.from, to: m.to, body: m.body });
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

  private async pass(name: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.log("error", "identity_pass_failed", { pass: name, code: /FLEET_[A-Z_]+/.exec(err instanceof Error ? err.message : "")?.[0] ?? "error" });
    }
  }

  /** One pass: sync mail, re-check pending jobs, then process queued jobs (up to `max`). */
  async tick(max = 10): Promise<{ processed: number; outcomes: string[] }> {
    const outcomes: string[] = [];
    await this.pass("provider_secrets", () => this.installProviderSecrets());
    if (!this.registered) await this.pass("comms_register", () => this.registerProviders());
    if (!this.keyPublished && this.o.ownerVault) {
      const r = await this.gw.publishOwnerKey(this.worker, this.o.ownerVault.publicKeyBase64());
      this.keyPublished = r.ok;
    }
    // Each pass is isolated: one failing pass (a provider outage, a bad row) never stops the others.
    await this.pass("mail_sync", () => this.syncMail());
    await this.pass("sms_sync", () => this.syncSms());
    await this.pass("sms_costs", () => this.syncSmsCosts());
    await this.pass("vault_uploads", () => this.installVaultUploads());
    await this.pass("reveals", () => this.serveReveals());
    await this.pass("browser_secrets", () => this.serveBrowserSecrets());
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
    await this.pass("mail_sync", () => this.syncMail());
    await this.pass("notification_email", () => this.emailNotifications());
    return { processed: outcomes.length, outcomes };
  }
}

export type { MailMessage };

/**
 * v49: one field of a structured owner fact. A fact is either plain text (its whole value is filled; naming a field is
 * refused) or a JSON object (a field must be named, its value a string or number).
 */
export function factField(value: string, field: string | null): string | null {
  const v = value.trim();
  if (!v) return null;
  let parsed: unknown = null;
  if (v.startsWith("{")) { try { parsed = JSON.parse(v); } catch { parsed = null; } }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    if (!field) return null;
    const x = (parsed as Record<string, unknown>)[field];
    return typeof x === "string" || typeof x === "number" ? String(x) : null;
  }
  return field ? null : v;
}

/** v49: one field of the owner's card (JSON: number, expMonth, expYear, cvc, name, postcode); expiry is MM/YY. */
export function cardField(value: string, field: string): string | null {
  let c: Record<string, unknown>;
  try { c = JSON.parse(value) as Record<string, unknown>; } catch { return null; }
  const s = (k: string) => (typeof c[k] === "string" || typeof c[k] === "number" ? String(c[k]).trim() : "");
  const mm = s("expMonth").padStart(2, "0");
  const yyyy = s("expYear").length === 2 ? `20${s("expYear")}` : s("expYear");
  switch (field) {
    case "number": return s("number").replace(/[\s-]/g, "") || null;
    case "exp_month": return /^\d{2}$/.test(mm) ? mm : null;
    case "exp_year": return /^\d{4}$/.test(yyyy) ? yyyy : null;
    case "expiry": return /^\d{2}$/.test(mm) && /^\d{4}$/.test(yyyy) ? `${mm}/${yyyy.slice(2)}` : null;
    case "cvc": return s("cvc") || null;
    case "name": return s("name") || null;
    case "postcode": return s("postcode") || null;
    default: return null;
  }
}

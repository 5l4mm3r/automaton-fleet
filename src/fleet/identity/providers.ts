/**
 * Identity broker provider primitives (schema v34): reusable interfaces for mail and for platform accounts. Specific
 * providers are adapters behind them; the constitution names none. This build ships SIMULATED adapters only (tests and
 * the zero-owner simulation); a real mail domain or platform adapter is added per provider later, and any provider step
 * that genuinely needs a human (CAPTCHA, liveness, biometrics, a fresh personal signature or consent) is reported as
 * `human_action_required` for that one action — never worked around.
 */
import crypto from "crypto";

export interface MailMessage {
  id: string;
  to: string;
  from: string;
  subject: string;
  body: string;
  at: string;
}

export interface MailProvider {
  readonly name: string;
  /**
   * v41: "shared" = ONE Fleet-controlled external mailbox (agents hold internal routing addresses on it and the registry
   * attributes every message); "dedicated" (default) = an address per agent at the provider.
   */
  readonly mode?: "shared" | "dedicated";
  /** v41 (shared): the shared mailbox's own address — the From of all outgoing mail. */
  readonly address?: string;
  /** Provision an address (a mailbox or alias) for an agent; idempotent per local part. (Dedicated providers.) */
  provision(localPart: string | null, hint: string): Promise<{ address: string }>;
  /** Messages for an address since a time (provider order). (Dedicated providers.) */
  fetch(address: string, since: Date): Promise<MailMessage[]>;
  /** v36: send from one of the Fleet's addresses. v41: Reply-To, a Fleet Message-ID and the conversation's references. */
  send(input: OutgoingMail): Promise<{ providerMessageId: string; externalMessageId?: string }>;
  /** v41 (shared): inbound messages after an opaque cursor (null: the last 7 days); returns the next cursor. */
  fetchShared?(cursor: string | null): Promise<{ messages: SharedMailMessage[]; cursor: string | null }>;
  /** v41: a connectivity check for the health view (throws a FLEET_MAIL_PROVIDER_* code). */
  health?(): Promise<void>;
}

export interface OutgoingMail {
  from: string;
  to: string[];
  subject: string;
  body: string;
  inReplyTo?: string | null;
  replyTo?: string | null;
  messageId?: string | null;
  references?: string[] | null;
  /** v56: files sent with the message (an order's delivery). */
  attachments?: Array<{ fileName: string; contentType: string; content: Buffer }> | null;
}

/** v41: one inbound message of a shared mailbox (the registry attributes it). */
export interface SharedMailMessage {
  /** Stable per mailbox (e.g. imap:<uidvalidity>:<uid>): makes ingestion idempotent. */
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

export interface SmsMessage {
  id: string;
  to: string;
  from: string;
  body: string;
  at: string;
}

export type NumberType = "mobile" | "local" | "toll_free" | "national";

export type NumberOutcome =
  | { outcome: "succeeded"; e164: string; providerRef: string; numberType?: NumberType; monthlyMicro?: number; currency?: string }
  | { outcome: "failed"; code: string; note?: string }
  | { outcome: "human_action_required"; code: string; note: string };

/** v41: a live quote — what numbers exist now, what they cost per month, what messages cost, what regulation needs. */
export type NumberQuote =
  | { provider: string; currency: string;
      options: Array<{ numberType: NumberType; monthlyMicro: number | null; available: Array<{ e164: string; locality?: string; region?: string }>;
        smsCapable: boolean; voiceCapable?: boolean }>;
      /** Per-message prices in micro-units of `currency`, keyed outbound_<type> / inbound_<type>. */
      messaging: Record<string, number>;
      regulation?: Record<string, unknown> }
  | { error: string };

/** v36: legitimate programmable numbers and SMS behind a swappable adapter (the constitution names no provider). */
export interface SmsProvider {
  readonly name: string;
  /** v41: live availability and prices (the agent decides with them). */
  quote?(country: string, types: NumberType[]): Promise<NumberQuote>;
  /** Buy a number; v41: of a type, preferably a quoted one, never above the agent's ceiling (micro-units of `currency`). */
  provision(country: string, opts?: { numberType?: NumberType; phoneNumber?: string | null; maxMonthlyMicro?: number | null; currency?: string | null }): Promise<NumberOutcome>;
  release(providerRef: string): Promise<{ ok: boolean; code?: string }>;
  send(input: { from: string; to: string; body: string }): Promise<{ providerMessageId: string }>;
  fetch(e164: string, since: Date): Promise<SmsMessage[]>;
  /** v41: the provider's final price of a message (null while not yet priced). */
  messagePrice?(providerMessageId: string): Promise<{ priceMicro: number; currency: string } | null>;
  /** v41: a connectivity check for the health view. */
  health?(): Promise<void>;
}

export type AccountOutcome =
  | { outcome: "succeeded"; providerAccountRef?: string; handle?: string; note?: string; data?: Record<string, unknown>; reputation?: Record<string, number> }
  | { outcome: "pending"; note: string }
  | { outcome: "failed"; code: string; note?: string }
  | { outcome: "human_action_required"; code: string; note: string };

export type IdentityRequirement =
  | { kind: "none" }
  | { kind: "brokered"; classes: string[] }
  | { kind: "human_only"; reason: string };

export interface PlatformConnector {
  readonly platform: string;
  /** Create the account with the agent's own identity and the broker-held credential. */
  createAccount(input: { handle: string | null; displayName: string | null; email: string | null; password: string }): Promise<AccountOutcome & { needsEmailVerification?: boolean }>;
  /** Consume the verification email the platform sent (link/code extracted by the broker; never shown to the agent). */
  confirmEmail(input: { providerAccountRef: string | null; message: MailMessage }): Promise<AccountOutcome>;
  /** Operate the account (connector-defined actions). */
  operate(input: { providerAccountRef: string | null; action: string; params: Record<string, unknown>; password: string }): Promise<AccountOutcome>;
  /** What a verification of the account holder needs for a purpose. */
  identityRequirement(purpose: string): IdentityRequirement;
  /** Submit brokered account-holder facts (only the authorised classes). */
  verifyIdentity(input: { providerAccountRef: string | null; purpose: string; facts: Record<string, string> }): Promise<"verified" | "pending" | "rejected" | "human_action_required">;
  /** Recover access: the provider resets the credential to `newPassword` (via the account's mailbox where needed). */
  recover(input: { providerAccountRef: string | null; email: string | null; newPassword: string }): Promise<AccountOutcome>;
  /** Change the credential (rotation). */
  rotate(input: { providerAccountRef: string | null; oldPassword: string; newPassword: string }): Promise<AccountOutcome>;
  close(input: { providerAccountRef: string | null; password: string }): Promise<AccountOutcome>;
}

/** Verification links and codes in a message (consumed by the broker). */
export function findVerification(body: string): { link: string | null; code: string | null } {
  const link = /https?:\/\/[^\s"'<>]*(verif|confirm|activate)[^\s"'<>]*/i.exec(body)?.[0] ?? null;
  const code = /\b(?:code|pin)[^0-9]{0,20}(\d{4,8})\b/i.exec(body)?.[1] ?? null;
  return { link, code };
}

/** The link/code of an ACCOUNT AUTHENTICATION message withheld (credential execution uses it; the agent sees the rest). */
export function redactMail(body: string): string {
  return body.replace(/https?:\/\/\S+/g, "[link]").replace(/\b\d{4,8}\b/g, "[code]").slice(0, 100_000);
}

/**
 * v36: an account-authentication message (sign-up confirmation, one-time / login / security code, password reset,
 * two-factor) — its link/code is a credential, handled by the broker. Every other message is ordinary business mail
 * and reaches the agent whole (customers, suppliers, platform correspondence).
 */
export function isAuthenticationMessage(subject: string, body: string): boolean {
  const v = findVerification(body);
  if (!v.link && !v.code && !/\b\d{4,8}\b/.test(body) && !/https?:\/\//.test(body)) return false;
  return /verif|confirm (your|the) (email|account|address)|activat|one[- ]time|\botp\b|security code|log ?in code|sign[- ]?in code|reset (your )?password|password reset|two[- ]factor|\b2fa\b|authenticat/i
    .test(`${subject}\n${body}`);
}

// ─── Simulated adapters (no network; deterministic) ───────────────────────────

export class SimulatedMailProvider implements MailProvider {
  readonly name = "fleet-mail";
  private readonly boxes = new Map<string, MailMessage[]>();
  constructor(private readonly domain = "agents.fleet-mail.test") {}

  async provision(localPart: string | null, hint: string): Promise<{ address: string }> {
    const base = (localPart ?? hint.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "").slice(0, 40)) || "agent";
    let address = `${base}@${this.domain}`;
    for (let i = 2; this.boxes.has(address) && !localPart; i++) address = `${base}${i}@${this.domain}`;
    if (!this.boxes.has(address)) this.boxes.set(address, []);
    return { address };
  }

  async fetch(address: string, since: Date): Promise<MailMessage[]> {
    return (this.boxes.get(address) ?? []).filter((m) => new Date(m.at) >= since);
  }

  readonly outbox: Array<{ from: string; to: string[]; subject: string; body: string; inReplyTo?: string | null; providerMessageId: string }> = [];
  async send(input: { from: string; to: string[]; subject: string; body: string; inReplyTo?: string | null }): Promise<{ providerMessageId: string }> {
    const providerMessageId = `<${crypto.randomUUID()}@${this.domain}>`;
    this.outbox.push({ ...input, providerMessageId });
    for (const to of input.to) if (this.boxes.has(to)) this.deliver({ to, from: input.from, subject: input.subject, body: input.body });
    return { providerMessageId };
  }

  /** Simulation hook: a platform (or anyone) emails an address. */
  deliver(m: Omit<MailMessage, "id" | "at">): MailMessage {
    const box = this.boxes.get(m.to);
    if (!box) throw new Error("no such mailbox");
    const msg = { ...m, id: crypto.randomUUID(), at: new Date().toISOString() };
    box.push(msg);
    return msg;
  }
}

export interface SimulatedPlatformOptions {
  platform: string;
  mail: SimulatedMailProvider;
  /** Does signup require email verification? */
  emailVerification?: boolean;
  /** Account-holder verification: none, brokered classes, or a non-delegable human act. */
  identity?: IdentityRequirement;
  /** Fail every call (provider outage). */
  down?: boolean;
}

/** A simulated platform: accounts, email verification, a couple of operations, brokered identity, recovery. */
export class SimulatedPlatform implements PlatformConnector {
  readonly platform: string;
  readonly accounts = new Map<string, { handle: string; email: string | null; password: string; verified: boolean; identity: string; closed: boolean;
    listings: string[]; sales: number; factsSeen: string[] }>();
  private readonly tokens = new Map<string, string>();
  constructor(private readonly o: SimulatedPlatformOptions) {
    this.platform = o.platform;
  }

  private down(): AccountOutcome | null {
    return this.o.down ? { outcome: "failed", code: "provider_unavailable", note: `${this.platform} is unavailable` } : null;
  }

  async createAccount(input: { handle: string | null; displayName: string | null; email: string | null; password: string }) {
    const d = this.down();
    if (d) return d;
    const handle = input.handle ?? `${(input.displayName ?? "agent").toLowerCase().replace(/[^a-z0-9]+/g, "")}${this.accounts.size + 1}`;
    if ([...this.accounts.values()].some((a) => a.handle.toLowerCase() === handle.toLowerCase())) return { outcome: "failed" as const, code: "handle_taken" };
    const ref = `${this.platform}-${crypto.randomBytes(6).toString("hex")}`;
    const needs = this.o.emailVerification !== false && !!input.email;
    this.accounts.set(ref, { handle, email: input.email, password: input.password, verified: !needs, identity: "none", closed: false, listings: [], sales: 0, factsSeen: [] });
    if (needs) {
      const token = crypto.randomBytes(16).toString("hex");
      this.tokens.set(token, ref);
      this.o.mail.deliver({ to: input.email!, from: `no-reply@${this.platform}.test`, subject: `Confirm your ${this.platform} account`,
        body: `Welcome ${handle}! Confirm here: https://${this.platform}.test/verify?t=${token} (or enter code 482913).` });
    }
    return { outcome: "succeeded" as const, providerAccountRef: ref, handle, needsEmailVerification: needs };
  }

  async confirmEmail(input: { providerAccountRef: string | null; message: MailMessage }): Promise<AccountOutcome> {
    const d = this.down();
    if (d) return d;
    const link = findVerification(input.message.body).link;
    const token = link ? new URL(link).searchParams.get("t") : null;
    const ref = token ? this.tokens.get(token) : undefined;
    if (!ref || ref !== input.providerAccountRef) return { outcome: "failed", code: "verification_invalid" };
    this.accounts.get(ref)!.verified = true;
    this.tokens.delete(token!);
    return { outcome: "succeeded" };
  }

  private acct(ref: string | null, password: string) {
    const a = ref ? this.accounts.get(ref) : undefined;
    if (!a || a.closed) return { err: { outcome: "failed", code: "no_account" } as AccountOutcome };
    if (a.password !== password) return { err: { outcome: "failed", code: "auth_failed" } as AccountOutcome };
    if (!a.verified) return { err: { outcome: "pending", note: "email not verified yet" } as AccountOutcome };
    return { a };
  }

  async operate(input: { providerAccountRef: string | null; action: string; params: Record<string, unknown>; password: string }): Promise<AccountOutcome> {
    const d = this.down();
    if (d) return d;
    const { a, err } = this.acct(input.providerAccountRef, input.password);
    if (err) return err;
    switch (input.action) {
      case "profile.update":
        return { outcome: "succeeded", data: { updated: Object.keys(input.params).slice(0, 10) } };
      case "listing.create": {
        const id = `lst-${a!.listings.length + 1}`;
        a!.listings.push(id);
        return { outcome: "succeeded", data: { listingId: id }, reputation: { listings: a!.listings.length } };
      }
      case "sale.simulate":
        a!.sales += 1;
        return { outcome: "succeeded", data: { sales: a!.sales }, reputation: { sales: a!.sales } };
      default:
        return { outcome: "failed", code: "unsupported_action", note: `${this.platform} has no action ${input.action}` };
    }
  }

  identityRequirement(_purpose: string): IdentityRequirement {
    return this.o.identity ?? { kind: "none" };
  }

  async verifyIdentity(input: { providerAccountRef: string | null; purpose: string; facts: Record<string, string> }) {
    const r = this.identityRequirement(input.purpose);
    if (r.kind === "human_only") return "human_action_required" as const;
    const a = input.providerAccountRef ? this.accounts.get(input.providerAccountRef) : undefined;
    if (!a) return "rejected" as const;
    if (r.kind === "brokered" && r.classes.some((c) => !input.facts[c])) return "rejected" as const;
    a.identity = "verified";
    a.factsSeen.push(...Object.keys(input.facts));
    return "verified" as const;
  }

  async recover(input: { providerAccountRef: string | null; email: string | null; newPassword: string }): Promise<AccountOutcome> {
    const d = this.down();
    if (d) return d;
    const a = input.providerAccountRef ? this.accounts.get(input.providerAccountRef) : undefined;
    if (!a || !input.email || a.email !== input.email) return { outcome: "failed", code: "recovery_refused" };
    a.password = input.newPassword;
    return { outcome: "succeeded" };
  }

  async rotate(input: { providerAccountRef: string | null; oldPassword: string; newPassword: string }): Promise<AccountOutcome> {
    const { a, err } = this.acct(input.providerAccountRef, input.oldPassword);
    if (err) return err;
    a!.password = input.newPassword;
    return { outcome: "succeeded" };
  }

  async close(input: { providerAccountRef: string | null; password: string }): Promise<AccountOutcome> {
    const { a, err } = this.acct(input.providerAccountRef, input.password);
    if (err) return err;
    a!.closed = true;
    return { outcome: "succeeded" };
  }
}


/**
 * A simulated SMS provider: numbers per country, inbound injection, an outbox; "XR" needs a regulatory bundle (human).
 * v41: live-style quotes (monthly rental per type, per-message prices) and message prices.
 */
export class SimulatedSmsProvider implements SmsProvider {
  readonly name = "sim-sms";
  readonly numbers = new Map<string, { e164: string; country: string; released: boolean; numberType: NumberType }>();
  readonly outbox: Array<{ from: string; to: string; body: string; providerMessageId: string }> = [];
  private readonly inbound = new Map<string, SmsMessage[]>();
  private next = 7_700_900_100;
  /** Simulation hook: change the live monthly price (micro-units) to test the agent's ceiling. */
  monthlyMicro: number;
  constructor(private readonly o: { monthlyMinor?: number; currency?: string; down?: boolean; perMessageMicro?: number } = {}) {
    this.monthlyMicro = (o.monthlyMinor ?? 115) * 10_000;
  }

  async quote(country: string, types: NumberType[]): Promise<NumberQuote> {
    if (this.o.down) return { error: "provider_unavailable" };
    if (country === "XX") return { error: "no_numbers_available" };
    const per = this.o.perMessageMicro ?? 7_900;
    return {
      provider: this.name, currency: this.o.currency ?? "USD",
      options: types.map((t, i) => ({ numberType: t, monthlyMicro: this.monthlyMicro + i * 10_000, smsCapable: true, voiceCapable: true,
        available: [{ e164: `+44${this.next + 1000 + i}`, locality: "Simulated" }] })),
      messaging: Object.fromEntries(types.flatMap((t) => [[`outbound_${t}`, per], [`inbound_${t}`, per]])),
      regulation: country === "XR" ? { requires: ["address", "identity_document"], note: "an approved regulatory bundle for the account holder" } : undefined,
    };
  }

  async provision(country: string, opts: { numberType?: NumberType; phoneNumber?: string | null; maxMonthlyMicro?: number | null; currency?: string | null } = {}): Promise<NumberOutcome> {
    if (this.o.down) return { outcome: "failed", code: "provider_unavailable", note: "SMS provider unavailable" };
    if (country === "XR") return { outcome: "human_action_required", code: "regulatory_bundle_required", note: "numbers in this country need an address/identity bundle approved for the account holder" };
    if (country === "XX") return { outcome: "failed", code: "no_numbers_available", note: "no numbers available in that country" };
    if (opts.maxMonthlyMicro != null && this.monthlyMicro > opts.maxMonthlyMicro) {
      return { outcome: "failed", code: "price_above_ceiling", note: "the current monthly price is above your ceiling; request a fresh quote" };
    }
    const e164 = `+44${this.next++}`;
    const providerRef = `PN${crypto.randomBytes(16).toString("hex")}`;
    const numberType = opts.numberType ?? "mobile";
    this.numbers.set(providerRef, { e164, country, released: false, numberType });
    this.inbound.set(e164, []);
    return { outcome: "succeeded", e164, providerRef, numberType, monthlyMicro: this.monthlyMicro, currency: this.o.currency ?? "USD" };
  }
  async release(providerRef: string) {
    const n = this.numbers.get(providerRef);
    if (!n) return { ok: false, code: "not_found" };
    n.released = true;
    return { ok: true };
  }
  async send(input: { from: string; to: string; body: string }) {
    const providerMessageId = `SM${crypto.randomBytes(8).toString("hex")}`;
    this.outbox.push({ ...input, providerMessageId });
    return { providerMessageId };
  }
  async fetch(e164: string, since: Date): Promise<SmsMessage[]> {
    return (this.inbound.get(e164) ?? []).filter((m) => new Date(m.at) >= since);
  }
  async messagePrice(_providerMessageId: string) {
    return { priceMicro: this.o.perMessageMicro ?? 7_900, currency: this.o.currency ?? "USD" };
  }
  /** Simulation hook: someone texts a number. */
  deliver(to: string, from: string, body: string): SmsMessage {
    const box = this.inbound.get(to);
    if (!box) throw new Error("no such number");
    const m = { id: `SM${crypto.randomBytes(8).toString("hex")}`, to, from, body, at: new Date().toISOString() };
    box.push(m);
    return m;
  }
}

/**
 * v41: a simulated SHARED mailbox (the Proton-Bridge shape without a network): one address, every routing tag of it
 * delivering into the same inbox, an outbox that records Reply-To / Message-ID / threading, and a cursor.
 */
export class SimulatedSharedMailProvider implements MailProvider {
  readonly name = "sim-shared-mail";
  readonly mode = "shared" as const;
  readonly inbox: SharedMailMessage[] = [];
  readonly outbox: Array<OutgoingMail & { providerMessageId: string; externalMessageId: string }> = [];
  down = false;
  constructor(readonly address = "fleet@shared.fleet-mail.test") {}

  private ours(addr: string): boolean {
    const [l, d] = addr.toLowerCase().split("@");
    const [bl, bd] = this.address.split("@");
    return d === bd && (l === bl || l.startsWith(`${bl}+`));
  }

  async provision(): Promise<{ address: string }> {
    throw new Error("FLEET_BAD_REQUEST: a shared mailbox's routing addresses are created by the registry");
  }
  async fetch(): Promise<MailMessage[]> {
    return [];
  }
  async send(input: OutgoingMail): Promise<{ providerMessageId: string; externalMessageId: string }> {
    if (this.down) throw new Error("FLEET_MAIL_PROVIDER_CONNECT");
    if (input.from.toLowerCase() !== this.address) throw new Error("FLEET_MAIL_FOREIGN_SENDER");
    const externalMessageId = input.messageId ?? `<${crypto.randomUUID()}@${this.address.split("@")[1]}>`;
    this.outbox.push({ ...input, providerMessageId: externalMessageId, externalMessageId });
    // Mail to the shared mailbox itself (an agent writing to another agent's routing address) lands in the inbox.
    const local = input.to.filter((t) => this.ours(t));
    if (local.length) this.deliver({ from: input.from, to: local, subject: input.subject, body: input.body, messageId: externalMessageId,
      inReplyTo: input.inReplyTo ?? null, references: input.references ?? [] });
    return { providerMessageId: externalMessageId, externalMessageId };
  }
  async fetchShared(cursor: string | null): Promise<{ messages: SharedMailMessage[]; cursor: string | null }> {
    if (this.down) throw new Error("FLEET_MAIL_PROVIDER_CONNECT");
    const from = cursor ? Number(cursor) : 0;
    return { messages: this.inbox.slice(from), cursor: String(this.inbox.length) };
  }
  async health(): Promise<void> {
    if (this.down) throw new Error("FLEET_MAIL_PROVIDER_CONNECT");
  }
  /** Simulation hook: someone emails the shared mailbox (or one of its routing addresses). */
  deliver(m: { from: string; to: string[]; cc?: string[]; subject: string; body: string; messageId?: string | null; inReplyTo?: string | null;
    references?: string[] }): SharedMailMessage {
    const msg: SharedMailMessage = { providerId: `sim:${this.inbox.length + 1}`, messageId: m.messageId ?? `<${crypto.randomUUID()}@sender.example>`,
      inReplyTo: m.inReplyTo ?? null, references: m.references ?? [], from: m.from, to: m.to, cc: m.cc ?? [], subject: m.subject, body: m.body,
      at: new Date().toISOString() };
    this.inbox.push(msg);
    return msg;
  }
}

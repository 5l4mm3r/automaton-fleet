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
  /** Provision an address (a mailbox or alias) for an agent; idempotent per local part. */
  provision(localPart: string | null, hint: string): Promise<{ address: string }>;
  /** Messages for an address since a time (provider order). */
  fetch(address: string, since: Date): Promise<MailMessage[]>;
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

/** What an agent may read of a message: links and codes are redacted (they are credentials of a kind). */
export function redactMail(body: string): string {
  return body.replace(/https?:\/\/\S+/g, "[link]").replace(/\b\d{4,8}\b/g, "[code]").slice(0, 4000);
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

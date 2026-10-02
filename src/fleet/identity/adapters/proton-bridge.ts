/**
 * Mail provider adapter (schema v41): ONE Fleet-controlled Proton Mail mailbox through Proton Mail Bridge on the Fleet
 * host, behind the provider-neutral MailProvider interface (mode "shared"). DORMANT until the owner activates it.
 *
 *   Proton Mail ⇄ Proton Mail Bridge (its own service user) ⇄ loopback IMAP / SMTP ⇄ this adapter (identity broker)
 *
 *  • Loopback only: any host other than 127.0.0.1 / ::1 / localhost is refused — Bridge's ports are never exposed.
 *  • TLS pinned: Bridge's own certificate (exported once by the owner) is the only certificate accepted (exact
 *    SHA-256 pin, STARTTLS or implicit TLS as Bridge is configured).
 *  • Credentials: the Bridge-generated IMAP/SMTP password (never the Proton account password, which only Bridge's
 *    interactive login ever sees) comes from the broker's encrypted provider vault. No client logging; errors become
 *    FLEET_MAIL_PROVIDER_* codes, never server text.
 *  • Inbound: the INBOX is opened read-only and read by UID after a cursor (UIDVALIDITY:UID), so a restart neither
 *    re-delivers nor marks anything read; the registry attributes each message (ix_mail_ingest).
 *  • Outbound: From the shared address, Reply-To the agent's routing address, a Fleet Message-ID and the conversation's
 *    In-Reply-To / References so replies route back. Proton keeps its own encrypted-at-rest copy (Sent folder).
 */
import crypto from "crypto";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser, type AddressObject } from "mailparser";
import type { MailMessage, MailProvider, OutgoingMail, SharedMailMessage } from "../providers.js";

export interface ImapLike {
  connect(): Promise<void>;
  mailboxOpen(path: string, opts: { readOnly: boolean }): Promise<{ uidValidity: bigint | number | string }>;
  search(query: Record<string, unknown>, opts: { uid: true }): Promise<number[] | false | undefined>;
  fetchAll(range: string, query: Record<string, unknown>, opts: { uid: true }): Promise<Array<{ uid: number; size?: number; source?: Buffer; internalDate?: Date | string }>>;
  logout(): Promise<void>;
}
export interface SmtpLike {
  sendMail(m: Record<string, unknown>): Promise<{ messageId?: string }>;
  verify?(): Promise<unknown>;
  close?(): void;
}

export interface ProtonBridgeOptions {
  /** The shared Proton address (the From of all Fleet mail). */
  address: string;
  /** Bridge's IMAP/SMTP username and Bridge-GENERATED password (from the broker's provider vault). */
  username: string;
  password: string;
  /** Bridge's certificate (PEM), exported by the owner; pinned exactly. */
  certPem: string;
  host?: string;
  imapPort?: number;
  smtpPort?: number;
  /** Bridge's connection mode: STARTTLS (its default) or implicit TLS. */
  security?: "starttls" | "ssl";
  mailbox?: string;
  /** Messages larger than this are delivered as a notice, not parsed. */
  maxMessageBytes?: number;
  /** Tests: injected clients (the real ones are ImapFlow and a nodemailer SMTP transport). */
  imapFactory?: (o: Record<string, unknown>) => ImapLike;
  smtpFactory?: (o: Record<string, unknown>) => SmtpLike;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const ADDRESS = /^[a-z0-9._-]{1,64}@[a-z0-9.-]{3,190}$/;

/** The SHA-256 fingerprint of a PEM certificate, in Node's PeerCertificate.fingerprint256 format. */
export function certFingerprint256(pem: string): string {
  return new crypto.X509Certificate(pem).fingerprint256;
}

function code(err: unknown, fallback: string): string {
  const e = err as { authenticationFailed?: boolean; responseCode?: number; code?: string; message?: string } | null;
  if (e?.authenticationFailed || e?.responseCode === 535 || e?.code === "EAUTH") return "FLEET_MAIL_PROVIDER_AUTH";
  if (/FLEET_MAIL_[A-Z_]+/.test(e?.message ?? "")) return /FLEET_MAIL_[A-Z_]+/.exec(e!.message!)![0];
  if (/CERT|TLS|SSL|self.signed|pin/i.test(`${e?.code ?? ""} ${e?.message ?? ""}`)) return "FLEET_MAIL_PROVIDER_TLS";
  if (/ECONNREFUSED|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENOTFOUND/.test(`${e?.code ?? ""} ${e?.message ?? ""}`)) return "FLEET_MAIL_PROVIDER_CONNECT";
  return fallback;
}

function addresses(a: AddressObject | AddressObject[] | undefined): string[] {
  const list = Array.isArray(a) ? a : a ? [a] : [];
  return list.flatMap((x) => x.value.map((v) => String(v.address ?? "").toLowerCase())).filter((s) => s.includes("@")).slice(0, 50);
}

export class ProtonBridgeMailProvider implements MailProvider {
  readonly name = "proton-bridge";
  readonly mode = "shared" as const;
  readonly address: string;
  private readonly host: string;
  private readonly pin: string;
  private readonly tls: Record<string, unknown>;

  constructor(private readonly o: ProtonBridgeOptions) {
    this.address = o.address.trim().toLowerCase();
    if (!ADDRESS.test(this.address)) throw new Error("the shared mail address is malformed");
    this.host = (o.host ?? "127.0.0.1").trim();
    if (!LOOPBACK.has(this.host)) throw new Error("Proton Mail Bridge must be reached on loopback only (127.0.0.1 / ::1)");
    if (!o.username || !o.password || o.password.length < 8) throw new Error("Bridge credentials missing");
    if (!/-----BEGIN CERTIFICATE-----/.test(o.certPem ?? "")) throw new Error("Bridge certificate (PEM) missing");
    this.pin = certFingerprint256(o.certPem);
    const pin = this.pin;
    // Chain validation against Bridge's own self-signed certificate, then an exact fingerprint pin (the host name of a
    // loopback listener carries no meaning; the pin does).
    this.tls = { ca: [o.certPem], rejectUnauthorized: true, minVersion: "TLSv1.2",
      checkServerIdentity: (_host: string, cert: { fingerprint256?: string }) => (cert?.fingerprint256 === pin ? undefined : new Error("FLEET_MAIL_PROVIDER_TLS: certificate pin mismatch")) };
  }

  private imap(): ImapLike {
    const opts = { host: this.host, port: this.o.imapPort ?? 1143, secure: this.o.security === "ssl", doSTARTTLS: this.o.security !== "ssl" ? true : undefined,
      auth: { user: this.o.username, pass: this.o.password }, tls: this.tls, logger: false, emitLogs: false, disableAutoIdle: true, disableCompression: true };
    return this.o.imapFactory ? this.o.imapFactory(opts) : (new ImapFlow(opts as never) as unknown as ImapLike);
  }

  private smtp(): SmtpLike {
    const opts = { host: this.host, port: this.o.smtpPort ?? 1025, secure: this.o.security === "ssl", requireTLS: this.o.security !== "ssl",
      auth: { user: this.o.username, pass: this.o.password }, tls: this.tls, logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true };
    return this.o.smtpFactory ? this.o.smtpFactory(opts) : (nodemailer.createTransport(opts as never) as unknown as SmtpLike);
  }

  async provision(): Promise<{ address: string }> {
    throw new Error("FLEET_BAD_REQUEST: routing addresses on the shared mailbox are created by the registry");
  }

  async fetch(): Promise<MailMessage[]> {
    return [];
  }

  async fetchShared(cursor: string | null): Promise<{ messages: SharedMailMessage[]; cursor: string | null }> {
    const c = this.imap();
    try {
      await c.connect();
    } catch (err) {
      throw new Error(code(err, "FLEET_MAIL_PROVIDER_CONNECT"));
    }
    try {
      const box = await c.mailboxOpen(this.o.mailbox ?? "INBOX", { readOnly: true });
      const uv = String(box.uidValidity);
      let prev: { v: string; u: number } | null = null;
      try { prev = cursor ? (JSON.parse(cursor) as { v: string; u: number }) : null; } catch { prev = null; }
      const same = prev !== null && prev.v === uv && Number.isInteger(prev.u);
      const found = same ? await c.search({ uid: `${prev!.u + 1}:*` }, { uid: true }) : await c.search({ since: new Date(Date.now() - 7 * 86_400_000) }, { uid: true });
      const uids = (found || []).filter((u) => !same || u > prev!.u).sort((a, b) => a - b).slice(0, 200);
      const messages: SharedMailMessage[] = [];
      let last = same ? prev!.u : 0;
      if (uids.length) {
        const max = this.o.maxMessageBytes ?? 10_000_000;
        const sizes = new Map((await c.fetchAll(uids.join(","), { uid: true, size: true, internalDate: true }, { uid: true })).map((m) => [m.uid, m]));
        const small = uids.filter((u) => (sizes.get(u)?.size ?? 0) <= max);
        const sources = small.length ? new Map((await c.fetchAll(small.join(","), { uid: true, source: true }, { uid: true })).map((m) => [m.uid, m.source])) : new Map();
        for (const uid of uids) {
          const meta = sizes.get(uid);
          const at = new Date(meta?.internalDate ?? Date.now()).toISOString();
          const providerId = `imap:${uv}:${uid}`;
          const src = sources.get(uid) as Buffer | undefined;
          if (!src) {
            messages.push({ providerId, messageId: null, inReplyTo: null, references: [], from: "(unknown sender)", to: [this.address], cc: [], subject: "(message too large)",
              body: `A message of ${meta?.size ?? "?"} bytes is in the Fleet mailbox; it is too large to deliver here.`, at });
          } else {
            const p = await simpleParser(src, { skipImageLinks: true, skipTextLinks: true, skipTextToHtml: true });
            const refs = Array.isArray(p.references) ? p.references : p.references ? String(p.references).split(/\s+/) : [];
            const files = (p.attachments ?? []).map((x) => `${x.filename ?? "attachment"} (${Math.ceil((x.size ?? 0) / 1024)} KB)`);
            const text = (p.text ?? (typeof p.html === "string" ? p.html.replace(/<[^>]+>/g, " ") : "") ?? "").replace(/\s+$/, "").slice(0, 98_000);
            messages.push({ providerId, messageId: p.messageId ?? null, inReplyTo: p.inReplyTo ?? null, references: refs.filter(Boolean).slice(0, 50),
              from: String(p.from?.text ?? "(unknown sender)").slice(0, 200), to: addresses(p.to), cc: addresses(p.cc), subject: String(p.subject ?? "").slice(0, 300),
              body: files.length ? `${text}\n\n[attachments: ${files.join(", ").slice(0, 1500)}]` : text, at: (p.date ?? new Date(at)).toISOString() });
          }
          last = Math.max(last, uid);
        }
      }
      return { messages, cursor: JSON.stringify({ v: uv, u: last }) };
    } catch (err) {
      throw new Error(code(err, "FLEET_MAIL_PROVIDER_IMAP"));
    } finally {
      await c.logout().catch(() => undefined);
    }
  }

  async send(input: OutgoingMail): Promise<{ providerMessageId: string; externalMessageId: string }> {
    if (input.from.trim().toLowerCase() !== this.address) throw new Error("FLEET_MAIL_FOREIGN_SENDER");
    const messageId = input.messageId ?? `<${crypto.randomUUID()}@${this.address.split("@")[1]}>`;
    const t = this.smtp();
    try {
      const info = await t.sendMail({ from: this.address, to: input.to, subject: input.subject, text: input.body,
        replyTo: input.replyTo ?? undefined, messageId, inReplyTo: input.inReplyTo ?? undefined,
        references: input.references && input.references.length ? input.references : input.inReplyTo ? [input.inReplyTo] : undefined,
        envelope: { from: this.address, to: input.to }, disableFileAccess: true, disableUrlAccess: true });
      return { providerMessageId: String(info.messageId ?? messageId), externalMessageId: messageId };
    } catch (err) {
      throw new Error(code(err, "FLEET_MAIL_PROVIDER_SEND"));
    } finally {
      t.close?.();
    }
  }

  async health(): Promise<void> {
    const c = this.imap();
    try {
      await c.connect();
      await c.mailboxOpen(this.o.mailbox ?? "INBOX", { readOnly: true });
    } catch (err) {
      throw new Error(code(err, "FLEET_MAIL_PROVIDER_CONNECT"));
    } finally {
      await c.logout().catch(() => undefined);
    }
  }
}

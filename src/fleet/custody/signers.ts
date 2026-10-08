/**
 * Custody signers (schema v32): the integrations that actually move money, running ONLY inside the custody executor
 * (own OS user, own DB role, the only process that can read the custody vault). A signer executes exactly one
 * already-authorized, rail-bound instruction; there is no generic transfer, signing, URL or shell capability.
 *
 * Contract every signer keeps:
 *  - idempotent per instructionId (a retried call never pays twice);
 *  - `settled` only with the provider's confirmation of exactly the instructed amount and currency;
 *  - `failed` only when the provider definitively did not (and will not) pay;
 *  - `pending` when the outcome is not yet final OR unknown after a request may have reached the provider — never a
 *    guess (an unknown outcome reported as failed would release money that may still leave);
 *  - never throws after a request may have reached the provider; never returns or logs a secret or token.
 *
 * Live mode is refused while REAL_PAYMENTS_ENABLED is not true (the fleet spend gate), on top of the registry's own
 * pins (custody execution off, rails never live).
 */
import crypto from "crypto";
import fs from "fs";
import { assertRealSpendAllowed, FLEET_SPEND_GATE, type SpendGate } from "../spend-gate.js";
import type { SecretHandle } from "../payments/credential-broker.js";
import type { ClaimedInstruction } from "./gateway.js";

export type SignerOutcome =
  | { outcome: "settled"; externalRef: string; settledCents: number }
  | { outcome: "failed"; failureCode: string }
  | { outcome: "pending"; externalRef: string | null; note: string };

export interface SignerBinding {
  /** The payment rail (registry fleet_payment_rails.rail_id) this signer serves. */
  railId: string;
  provider: string;
  mode: "sandbox" | "live";
  credentialId: string;
  vaultRef: string;
}

export interface CustodySigner {
  readonly binding: SignerBinding;
  /** Execute one claimed instruction with the credential secret (valid for this call only). */
  execute(inst: ClaimedInstruction, secret: SecretHandle): Promise<SignerOutcome>;
  /** Re-check a pending instruction (idempotent: the same request again, or a status lookup). */
  status(inst: ClaimedInstruction, secret: SecretHandle, externalRef: string | null): Promise<SignerOutcome>;
}

export type HttpPort = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

const CURRENCIES = new Set(["GBP", "USD", "EUR"]); // two-decimal currencies only (exact minor units)
const decimal = (minor: number) => `${Math.trunc(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;

/** "12.30" → 1230 exactly; anything else → null. */
function toMinorExact(v: unknown): number | null {
  if (typeof v !== "string" || !/^\d{1,12}\.\d{2}$/.test(v)) return null;
  const [i, f] = v.split(".");
  return Number(i) * 100 + Number(f);
}

/** A PayPal receiver from a provider-account reference: `paypal:someone@x.y` or a bare email. URLs are not payable. */
export function paypalReceiver(reference: string): string | null {
  const r = reference.trim().replace(/^paypal:/i, "");
  return /^[^@\s:]{1,64}@[A-Za-z0-9.-]{3,120}$/.test(r) ? r : null;
}

/**
 * PayPal Payouts (Fleet Treasury account). The vault secret is the REST app's "clientId:clientSecret"; each call
 * exchanges it for a short-lived access token (kept in a local variable only) and sends one single-item payout with
 * PayPal-Request-Id = sender_batch_id = instructionId, so any retry returns the original batch instead of paying again.
 */
export class PayPalPayoutSigner implements CustodySigner {
  constructor(
    readonly binding: SignerBinding,
    private readonly http: HttpPort,
    gate: SpendGate = FLEET_SPEND_GATE,
  ) {
    if (binding.provider !== "paypal") throw new Error("FLEET_BAD_REQUEST: a PayPal signer serves a paypal rail");
    if (!/^vault:paypal\/[a-z0-9/._-]{1,100}$/.test(binding.vaultRef)) throw new Error("FLEET_BAD_REQUEST: a PayPal credential reference is vault:paypal/…");
    if (binding.mode === "live") assertRealSpendAllowed("credit_transfer", gate);
  }

  private base(): string {
    return this.binding.mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  }

  private async token(secret: SecretHandle): Promise<string | null> {
    const r = await this.http(`${this.base()}/v1/oauth2/token`, {
      method: "POST", headers: { Authorization: secret.basic(), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: "grant_type=client_credentials",
    });
    if (r.status !== 200) return null;
    const t = ((await r.json()) as { access_token?: unknown }).access_token;
    return typeof t === "string" && t.length > 10 ? t : null;
  }

  /** Interpret a payout batch for this instruction (single item). */
  private judge(inst: ClaimedInstruction, body: any): SignerOutcome {
    const batchId = typeof body?.batch_header?.payout_batch_id === "string" ? body.batch_header.payout_batch_id : null;
    const ref = batchId ? `paypal:payout:${batchId}`.slice(0, 200) : null;
    const batch = String(body?.batch_header?.batch_status ?? "");
    const item = Array.isArray(body?.items) ? body.items[0] : null;
    const itemStatus = String(item?.transaction_status ?? "");
    if (["DENIED", "CANCELED"].includes(batch) || ["FAILED", "BLOCKED", "DENIED", "RETURNED", "REFUNDED", "REVERSED"].includes(itemStatus)) {
      return { outcome: "failed", failureCode: `paypal_${(itemStatus || batch).toLowerCase()}`.slice(0, 64) };
    }
    if (batch === "SUCCESS" && itemStatus === "SUCCESS" && ref) {
      const amount = toMinorExact(item?.payout_item?.amount?.value);
      const currency = String(item?.payout_item?.amount?.currency ?? "");
      if (amount !== inst.amountCents || currency !== inst.currency) {
        return { outcome: "pending", externalRef: ref, note: "provider reports a different amount or currency: manual reconciliation" };
      }
      return { outcome: "settled", externalRef: ref, settledCents: amount };
    }
    return { outcome: "pending", externalRef: ref, note: `batch ${batch || "unknown"}, item ${itemStatus || "unknown"}` };
  }

  private request(inst: ClaimedInstruction, receiver: string): string {
    return JSON.stringify({
      sender_batch_header: { sender_batch_id: inst.instructionId, email_subject: "Payment from the Fleet Treasury" },
      items: [{ recipient_type: "EMAIL", receiver, sender_item_id: inst.instructionId,
        amount: { value: decimal(inst.amountCents), currency: inst.currency } }],
    });
  }

  async execute(inst: ClaimedInstruction, secret: SecretHandle): Promise<SignerOutcome> {
    if (!inst.currency || !CURRENCIES.has(inst.currency)) return { outcome: "failed", failureCode: "currency_unsupported" };
    if (!Number.isSafeInteger(inst.amountCents) || inst.amountCents <= 0) return { outcome: "failed", failureCode: "amount_invalid" };
    const receiver = inst.reference ? paypalReceiver(inst.reference) : null;
    if (!receiver) return { outcome: "failed", failureCode: "receiver_unsupported" };
    let token: string | null;
    try {
      token = await this.token(secret);
    } catch {
      return { outcome: "failed", failureCode: "auth_unreachable" }; // nothing was sent that could pay
    }
    if (!token) return { outcome: "failed", failureCode: "auth_refused" };
    return this.send(inst, receiver, token);
  }

  /** POST the payout (or re-POST the same PayPal-Request-Id, which returns the original batch). Never throws. */
  private async send(inst: ClaimedInstruction, receiver: string, token: string): Promise<SignerOutcome> {
    try {
      const r = await this.http(`${this.base()}/v1/payments/payouts`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json", "PayPal-Request-Id": inst.instructionId },
        body: this.request(inst, receiver),
      });
      if (r.status === 201 || r.status === 200) {
        const created = await r.json();
        // A fresh batch is PENDING; look it up once for a final state.
        const out = this.judge(inst, created);
        const id = (created as any)?.batch_header?.payout_batch_id;
        if (out.outcome === "pending" && typeof id === "string" && /^[A-Za-z0-9]{6,40}$/.test(id)) return this.lookup(inst, token, id);
        return out;
      }
      if (r.status === 400 || r.status === 422) {
        const body = (await r.json().catch(() => ({}))) as { name?: string };
        // Validation errors are definitive (nothing was paid); anything else stays pending.
        if (["VALIDATION_ERROR", "INSUFFICIENT_FUNDS", "RECEIVER_UNREGISTERED", "CURRENCY_NOT_SUPPORTED_FOR_RECEIVER"].includes(String(body.name))) {
          return { outcome: "failed", failureCode: `paypal_${String(body.name).toLowerCase()}`.slice(0, 64) };
        }
      }
      if (r.status === 401 || r.status === 403) return { outcome: "failed", failureCode: "paypal_unauthorized" };
      return { outcome: "pending", externalRef: null, note: `payout request answered ${r.status}` };
    } catch {
      return { outcome: "pending", externalRef: null, note: "payout request outcome unknown (network)" };
    }
  }

  private async lookup(inst: ClaimedInstruction, token: string, batchId: string): Promise<SignerOutcome> {
    try {
      const r = await this.http(`${this.base()}/v1/payments/payouts/${batchId}`, { method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
      if (r.status !== 200) return { outcome: "pending", externalRef: `paypal:payout:${batchId}`, note: `status lookup answered ${r.status}` };
      return this.judge(inst, await r.json());
    } catch {
      return { outcome: "pending", externalRef: `paypal:payout:${batchId}`, note: "status lookup unreachable" };
    }
  }

  async status(inst: ClaimedInstruction, secret: SecretHandle, externalRef: string | null): Promise<SignerOutcome> {
    let token: string | null = null;
    try {
      token = await this.token(secret);
    } catch {
      token = null;
    }
    if (!token) return { outcome: "pending", externalRef, note: "auth unavailable for the status check" };
    const m = externalRef ? /^paypal:payout:([A-Za-z0-9]{6,40})$/.exec(externalRef) : null;
    if (m) return this.lookup(inst, token, m[1]);
    // No batch id known (the first answer was lost): the same PayPal-Request-Id returns the original batch, never a new one.
    const receiver = inst.reference ? paypalReceiver(inst.reference) : null;
    if (!receiver) return { outcome: "pending", externalRef, note: "receiver unavailable" };
    return this.send(inst, receiver, token);
  }
}

/**
 * Signer configuration (non-secret): which rails this executor serves, with which credential reference. v48: `webhookId`
 * (the PayPal webhook the treasury worker verifies events against) and `receiveOnly` (the rail is served for receiving and
 * reconciliation only — no payout signer is built, so no REAL_PAYMENTS_ENABLED is needed for it).
 */
export interface SignerConfigEntry extends SignerBinding {
  webhookId?: string;
  receiveOnly?: boolean;
}

/**
 * Load the signer configuration file (JSON array). Strict: a regular file owned by root, not writable by group/other;
 * every entry fully specified; vault references only (never a secret).
 */
export function loadSignerConfig(file: string): { entries: SignerConfigEntry[]; problems: string[] } {
  const problems: string[] = [];
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    return { entries: [], problems: [`signer config ${file} is missing`] };
  }
  if (!st.isFile() || st.isSymbolicLink()) problems.push(`signer config ${file} is not a regular file`);
  if ((st.mode & 0o022) !== 0) problems.push(`signer config ${file} is writable by group or others`);
  if (st.uid !== 0 && typeof process.getuid === "function" && st.uid !== process.getuid()) problems.push(`signer config ${file} is not owned by root`);
  if (problems.length) return { entries: [], problems };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { entries: [], problems: [`signer config ${file} is not valid JSON`] };
  }
  if (!Array.isArray(raw)) return { entries: [], problems: [`signer config ${file} must be a JSON array`] };
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const entries: SignerConfigEntry[] = [];
  raw.forEach((e: any, i) => {
    const ok = e && typeof e === "object" && uuid.test(String(e.railId)) && uuid.test(String(e.credentialId)) && ["paypal"].includes(String(e.provider))
      && ["sandbox", "live"].includes(String(e.mode)) && /^vault:[a-z0-9][a-z0-9/._-]{2,118}$/.test(String(e.vaultRef))
      && (e.webhookId === undefined || /^[A-Z0-9]{8,40}$/.test(String(e.webhookId))) && (e.receiveOnly === undefined || typeof e.receiveOnly === "boolean")
      && Object.keys(e).every((k) => ["railId", "provider", "mode", "credentialId", "vaultRef", "webhookId", "receiveOnly"].includes(k));
    if (!ok) problems.push(`signer config entry ${i} is malformed (railId, provider, mode, credentialId, vaultRef[, webhookId, receiveOnly]; no other field)`);
    else entries.push({ railId: e.railId, provider: e.provider, mode: e.mode, credentialId: e.credentialId, vaultRef: e.vaultRef,
      ...(e.webhookId ? { webhookId: e.webhookId } : {}), ...(e.receiveOnly ? { receiveOnly: true } : {}) });
  });
  if (new Set(entries.map((e) => e.railId)).size !== entries.length) problems.push("signer config names a rail twice");
  return { entries: problems.length ? [] : entries, problems };
}

/** sha256 of a reference in both enrolment forms (owner destinations hash it raw; vendors lowercase-trimmed). */
export function referenceMatches(reference: string | null | undefined, referenceSha256: string): boolean {
  if (!reference) return false;
  const h = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
  return h(reference) === referenceSha256 || h(reference.trim().toLowerCase()) === referenceSha256;
}

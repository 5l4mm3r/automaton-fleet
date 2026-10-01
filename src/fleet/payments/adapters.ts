/**
 * F2 provider adapters: a deterministic SIMULATED rail (used by the autonomy simulations and tests) and the PayPal
 * adapter architecture for the Fleet Treasury PayPal account (connected later through Fleet Hub → Treasury → Payment
 * Accounts → Add PayPal; no credential is configured in this build and no network call is made by any test).
 *
 * Money only ever leaves through custody execution, which is pinned off, and every outgoing call passes the fleet
 * spend gate (REAL_PAYMENTS_ENABLED): initiatePayout always refuses here.
 */
import crypto from "crypto";
import { assertRealSpendAllowed, FLEET_SPEND_GATE, type SpendGate } from "../spend-gate.js";
import type { CredentialBroker } from "./credential-broker.js";
import type { ExternalTransaction, ListingRequest, ListingResult, PaymentsRegistry, PayoutRequest, ProviderAdapter, RailCapability, RailMode } from "./types.js";

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** Deterministic simulated provider: the simulation queues sales/refunds; fetchTransactions returns them once. */
export class SimulatedProvider implements ProviderAdapter {
  readonly provider = "simulated";
  readonly mode: RailMode = "simulated";
  private queue: ExternalTransaction[] = [];
  private seq = 0;
  private listings = 0;
  constructor(private readonly gate: SpendGate = FLEET_SPEND_GATE) {}

  capabilities(): readonly RailCapability[] {
    return ["receive_payments", "refunds", "storefront", "marketplace_listing"];
  }

  /** Simulation hook: a customer buys (or is refunded) through a venture's simulated checkout. */
  record(t: { kind: "sale" | "refund"; grossMinor: number; feeMinor?: number; ventureId: string | null; customer?: string; at?: Date; externalId?: string; currency?: string }): ExternalTransaction {
    if (!Number.isSafeInteger(t.grossMinor) || t.grossMinor <= 0) throw new Error("integer minor units required");
    const externalId = t.externalId ?? `sim-${t.kind}-${++this.seq}`;
    const tx: ExternalTransaction = {
      externalId, kind: t.kind, grossMinor: t.grossMinor, feeMinor: t.feeMinor ?? 0, currency: t.currency ?? "GBP", ventureId: t.ventureId,
      occurredAt: (t.at ?? new Date()).toISOString(), payloadSha256: sha(`${externalId}|${t.kind}|${t.grossMinor}|${t.feeMinor ?? 0}|${t.ventureId ?? ""}`),
      counterpartySha256: t.customer ? sha(t.customer.toLowerCase()) : null,
    };
    this.queue.push(tx);
    return tx;
  }

  async fetchTransactions(_since: Date): Promise<ExternalTransaction[]> {
    const out = this.queue;
    this.queue = [];
    return out;
  }

  async createListing(l: ListingRequest): Promise<ListingResult> {
    if (!Number.isSafeInteger(l.priceMinor) || l.priceMinor <= 0) return { ok: false, code: "FLEET_BAD_REQUEST" };
    const reference = `simlist-${++this.listings}`;
    return { ok: true, reference, url: `https://checkout.simulated.invalid/${reference}` };
  }

  async initiatePayout(_p: PayoutRequest): Promise<never> {
    assertRealSpendAllowed("credit_transfer", this.gate);
    throw new Error("FLEET_CUSTODY_EXECUTION_DISABLED: payouts run only through custody execution, which is pinned off");
  }
}

/**
 * PayPal (Fleet Treasury account). Architecture only in this build: it needs a credential reference registered by the
 * owner (fleet_credential_refs, vault:paypal/…) and a rail in sandbox mode; the live mode is refused at construction
 * (rails cannot be live while real payments are disabled — schema CHECK — and the process gate agrees).
 */
export class PayPalAdapter implements ProviderAdapter {
  readonly provider = "paypal";
  constructor(
    readonly mode: RailMode,
    private readonly cred: { credentialId: string; vaultRef: string },
    private readonly broker: CredentialBroker,
    private readonly http: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; json(): Promise<unknown> }>,
    private readonly gate: SpendGate = FLEET_SPEND_GATE,
  ) {
    if (mode === "live") assertRealSpendAllowed("credit_transfer", gate);
    if (!/^vault:paypal\/[a-z0-9/._-]{1,100}$/.test(cred.vaultRef)) throw new Error("FLEET_BAD_REQUEST: a PayPal credential reference is vault:paypal/…");
  }

  private base(): string {
    return this.mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  }

  capabilities(): readonly RailCapability[] {
    return ["receive_payments", "refunds", "payouts"];
  }

  /** Reporting: transactions since a time, normalised to integer minor units (amount strings parsed exactly). */
  async fetchTransactions(since: Date): Promise<ExternalTransaction[]> {
    return this.broker.withCredential({ ...this.cred, action: "paypal.list_transactions" }, async (h) => {
      const q = new URLSearchParams({ start_date: since.toISOString(), end_date: new Date().toISOString(), fields: "transaction_info,payer_info" });
      const r = await this.http(`${this.base()}/v1/reporting/transactions?${q}`, { method: "GET", headers: { Authorization: h.bearer(), Accept: "application/json" } });
      if (r.status !== 200) throw new Error(`PAYPAL_HTTP_${r.status}`);
      const body = (await r.json()) as { transaction_details?: Array<Record<string, any>> };
      return (body.transaction_details ?? []).flatMap((d) => {
        const ti = d.transaction_info ?? {};
        const gross = toMinor(ti.transaction_amount?.value);
        const fee = toMinor(ti.fee_amount?.value);
        if (gross === null || !ti.transaction_id) return [];
        return [{
          externalId: String(ti.transaction_id).slice(0, 120), kind: gross < 0 ? "refund" : "sale", grossMinor: Math.abs(gross), feeMinor: Math.abs(fee ?? 0),
          currency: String(ti.transaction_amount?.currency_code ?? ""), ventureId: /^[0-9a-f-]{36}$/.test(String(ti.custom_field ?? "")) ? String(ti.custom_field) : null,
          occurredAt: String(ti.transaction_initiation_date ?? new Date().toISOString()), payloadSha256: sha(JSON.stringify(ti)),
          counterpartySha256: d.payer_info?.email_address ? sha(String(d.payer_info.email_address).toLowerCase()) : null,
        } satisfies ExternalTransaction];
      });
    });
  }

  async createListing(_l: ListingRequest): Promise<ListingResult> {
    // PayPal payment links per venture carry the venture id in custom_field (attribution); not enabled in this build.
    return { ok: false, code: "FLEET_PROVIDER_NOT_CONNECTED" };
  }

  async initiatePayout(_p: PayoutRequest): Promise<never> {
    assertRealSpendAllowed("credit_transfer", this.gate);
    throw new Error("FLEET_CUSTODY_EXECUTION_DISABLED: payouts run only through custody execution, which is pinned off");
  }
}

/** Exact decimal string → integer minor units ("12.30" → 1230). Floating point is never used for money. */
export function toMinor(v: unknown): number | null {
  if (typeof v !== "string" || !/^-?\d{1,12}(\.\d{1,2})?$/.test(v)) return null;
  const neg = v.startsWith("-");
  const [i, f = ""] = v.replace("-", "").split(".");
  const n = Number(i) * 100 + Number(f.padEnd(2, "0"));
  return neg ? -n : n;
}

/** Display reference for a card or account: brand and last four only. Full numbers are never stored or shown. */
export function maskAccount(brand: string, number: string): string {
  const digits = number.replace(/\D/g, "");
  if (digits.length < 4) throw new Error("FLEET_BAD_REQUEST: an account number is required to mask");
  return `${brand.replace(/[^A-Za-z ]/g, "").slice(0, 20)} •••• ${digits.slice(-4)}`;
}

/** One synchronisation pass: provider → registry (idempotent; orphans stay unattributed for reconciliation). */
export async function syncRail(railId: string, adapter: ProviderAdapter, registry: PaymentsRegistry, since: Date):
  Promise<{ settled: number; unattributed: number; replays: number; failed: number }> {
  const out = { settled: 0, unattributed: 0, replays: 0, failed: 0 };
  for (const t of await adapter.fetchTransactions(since)) {
    const r = await registry.settlementIngest({ ...t, railId });
    if (r.replay) out.replays++;
    else if (r.status === "settled") out.settled++;
    else if (r.status === "unattributed") out.unattributed++;
    else out.failed++;
  }
  return out;
}

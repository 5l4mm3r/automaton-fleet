/**
 * F2 payment rails (schema v29+): provider adapters run inside FleetController only.
 *
 * Agents never hold provider credentials or call a provider. They ask FleetController for an action (assign a rail,
 * register a vendor, spend inside custody); FleetController's adapters talk to providers with credentials the broker
 * resolves from the secret vault for one call at a time, and every use is audited (fleet_credential_use_log).
 * Money that arrives is reported to the registry (svc_settlement_ingest), which attributes it exactly or leaves it
 * unattributed for reconciliation. Outgoing payments are refused while REAL_PAYMENTS_ENABLED is not true.
 */

export type RailCapability = "receive_payments" | "refunds" | "payouts" | "card_spend" | "bank_transfer" | "marketplace_listing" | "subscriptions" | "storefront";
export type RailMode = "simulated" | "sandbox" | "live";

/** One external transaction as a provider reports it (integer minor units; never floating point). */
export interface ExternalTransaction {
  externalId: string;
  kind: "sale" | "refund";
  grossMinor: number;
  feeMinor: number;
  currency: string;
  /** The venture the provider-side reference names (a payment link / storefront / listing per venture), if any. */
  ventureId: string | null;
  occurredAt: string;
  /** sha256 of the provider's canonical payload (duplicate callbacks compare it; a different payload is a conflict). */
  payloadSha256: string;
  /** sha256 of the paying customer's reference (provenance; never the reference itself). */
  counterpartySha256: string | null;
}

export interface ListingRequest {
  ventureId: string;
  title: string;
  priceMinor: number;
  currency: string;
  description: string;
}

export interface ListingResult {
  ok: boolean;
  /** Provider-side identifier of the listing / payment link (public). */
  reference?: string;
  url?: string;
  code?: string;
}

export interface PayoutRequest {
  destinationReference: string;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
}

/** What every provider adapter implements. Reads are always allowed; anything that moves money passes the spend gate. */
export interface ProviderAdapter {
  readonly provider: string;
  readonly mode: RailMode;
  capabilities(): readonly RailCapability[];
  /** Transactions since a time (polling) — the webhook path normalises into the same shape. */
  fetchTransactions(since: Date): Promise<ExternalTransaction[]>;
  createListing(l: ListingRequest): Promise<ListingResult>;
  /** Moves money: always behind the fleet spend gate (REAL_PAYMENTS_ENABLED) and custody execution. */
  initiatePayout(p: PayoutRequest): Promise<never>;
}

/** The registry ports the payments layer needs (FleetController's service connection). */
export interface PaymentsRegistry {
  settlementIngest(t: ExternalTransaction & { railId: string }): Promise<Record<string, unknown> & { ok: boolean }>;
  credentialUse(credentialId: string, action: string, agentId: string | null, ventureId: string | null, outcome: "ok" | "refused" | "failed", detail: string | null):
    Promise<{ ok: boolean; status?: string; code?: string }>;
}

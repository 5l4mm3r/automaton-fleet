/**
 * Bank-feed receipt connector (schema v52; docs/design/gumroad-revenue-integration.md §§3, 4.3): reads BOOKED transactions of
 * the registered settlement destinations through a read-only account-information client and records them through
 * rx_receipt_record (role fleet_bankfeed), where v47 matches them to reported payouts and posts the allocation.
 *
 * It holds a bank-data credential with account-information scope only: no payment-initiation scope, nothing outgoing.
 * The account-information provider is the owner's choice (none is wired in yet): a provider adapter implements
 * BankFeedClient and is the only part that changes. The PayPal treasury needs none of this — Gumroad payouts received there
 * are matched from PayPal's own Transaction Search records (svc_settlement_paypal_match).
 */
import { SecretHandle, type SecretVault } from "../payments/credential-broker.js";

export interface BankTransaction { transactionId: string; amountMinor: number; currency: string; bookedOn: string; descriptor: string | null }

/** A read-only account-information client for one destination's account. */
export interface BankFeedClient {
  /** The scopes the consent grants; anything beyond reading accounts and transactions is refused. */
  scopes(credential: SecretHandle): Promise<string[]>;
  /** Booked transactions since a date (YYYY-MM-DD), the provider's own ids. Pending items are not returned. */
  transactions(credential: SecretHandle, since: string): Promise<BankTransaction[]>;
}

export interface BankFeedGatewayPort {
  destinations(worker: string): Promise<Array<{ destinationId: string; kind: string; currency: string; vaultRef: string; credentialId: string }>>;
  receiptRecord(worker: string, destinationId: string, txn: BankTransaction): Promise<{ ok: boolean; code?: string; status?: string; receiptId?: string }>;
}

export const BANKFEED_SCOPES = ["read_accounts", "read_transactions"] as const;

export class BankFeedConnector {
  private readonly worker: string;
  constructor(private readonly gw: BankFeedGatewayPort, private readonly vault: SecretVault, private readonly client: BankFeedClient,
    private readonly o: { worker?: string; lookbackDays?: number; now?: () => number; log?: (level: string, event: string, detail?: Record<string, unknown>) => void } = {}) {
    this.worker = o.worker ?? "bank-feed";
    if (!/^[a-z0-9-]{3,40}$/.test(this.worker)) throw new Error("worker name must match ^[a-z0-9-]{3,40}$");
  }

  /** One pass over every destination: scope check, then each booked transaction recorded (idempotent per transaction). */
  async tick(): Promise<{ destinations: number; recorded: number; refused: number }> {
    let recorded = 0;
    let refused = 0;
    const ds = await this.gw.destinations(this.worker);
    const since = new Date((this.o.now ?? Date.now)() - (this.o.lookbackDays ?? 14) * 86_400_000).toISOString().slice(0, 10);
    for (const d of ds) {
      const secret = await this.vault.resolve(d.vaultRef);
      if (!secret) { refused++; continue; }
      const cred = new SecretHandle(secret, d.vaultRef);
      const scopes = await this.client.scopes(cred);
      if (scopes.some((s) => !(BANKFEED_SCOPES as readonly string[]).includes(s))) {
        // A payment-initiation (or any wider) scope: the connector refuses to read with it at all.
        this.o.log?.("error", "bankfeed_scope_refused", { destinationId: d.destinationId, scopes });
        refused++;
        continue;
      }
      for (const t of await this.client.transactions(cred, since)) {
        if (t.currency !== d.currency) continue;
        const r = await this.gw.receiptRecord(this.worker, d.destinationId, t);
        if (r.ok || r.status) recorded++;
      }
    }
    return { destinations: ds.length, recorded, refused };
  }
}

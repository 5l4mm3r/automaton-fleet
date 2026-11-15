/**
 * Money-location feed (schema v86): reads a bank account's balance and transactions — pending, settled, declined and
 * reversed — through a READ-ONLY provider client and records them through rx_location_balance / rx_location_txn (role
 * fleet_bankfeed), where v86 matches card purchases, refunds and the owner's transfers. Nothing goes out: the client's
 * token is refused unless every scope it carries only reads.
 *
 * The Starling adapter is a CANDIDATE: built against Starling's public API v2 shapes and tested against a simulated
 * Starling; not connected to a real account. Verify the endpoints and the token's scopes at setup (docs/design/bank-debit-card-requirements.md).
 */
import { SecretHandle, type SecretVault } from "../payments/credential-broker.js";

export interface LocationTxn {
  externalId: string;
  status: "pending" | "settled" | "declined" | "reversed";
  direction: "in" | "out";
  kind: "card" | "card_refund" | "transfer" | "fee" | "interest" | "other";
  amountMinor: number;
  currency: string;
  originalAmountMinor?: number;
  originalCurrency?: string;
  descriptor: string | null;
  authorisedAt?: string;
  settledAt?: string;
}
export interface LocationBalance { availableMinor: number; clearedMinor: number | null; pendingMinor: number | null; currency: string }

/** A read-only client for one bank account. */
export interface LocationFeedClient {
  /** The token's scopes as the provider reports them. */
  scopes(credential: SecretHandle): Promise<string[]>;
  balance(credential: SecretHandle): Promise<LocationBalance>;
  /** Transactions changed since an instant (ISO), the provider's own ids; pending items included. */
  transactions(credential: SecretHandle, since: string): Promise<LocationTxn[]>;
}

export interface LocationFeedPort {
  locations(worker: string): Promise<Array<{ locationId: string; provider: string; currency: string; status: string }>>;
  balance(worker: string, locationId: string, b: LocationBalance): Promise<{ ok: boolean; code?: string }>;
  txn(worker: string, locationId: string, t: LocationTxn): Promise<{ ok: boolean; code?: string; match?: string }>;
}

/** A scope that only reads ("…:read"); anything else (payments, payees, cards' controls) refuses the whole location. */
export const readOnlyScope = (s: string) => /^[a-z0-9-]+(:[a-z0-9-]+)*:read$/.test(s);

export class LocationFeedConnector {
  private readonly worker: string;
  constructor(private readonly port: LocationFeedPort, private readonly vault: SecretVault,
    private readonly clients: Record<string, LocationFeedClient>, private readonly vaultRefs: Record<string, string>,
    private readonly o: { worker?: string; lookbackHours?: number; now?: () => number; log?: (level: string, event: string, detail?: Record<string, unknown>) => void } = {}) {
    this.worker = o.worker ?? "bank-feed";
    if (!/^[a-z0-9-]{3,40}$/.test(this.worker)) throw new Error("worker name must match ^[a-z0-9-]{3,40}$");
  }

  /** One pass: per fed location, the scope check, its balance, then its recent transactions (idempotent per transaction). */
  async tick(): Promise<{ locations: number; recorded: number; refused: number }> {
    let recorded = 0, refused = 0;
    const locs = await this.port.locations(this.worker);
    const since = new Date((this.o.now ?? Date.now)() - (this.o.lookbackHours ?? 72) * 3_600_000).toISOString();
    for (const l of locs) {
      const client = this.clients[l.provider], ref = this.vaultRefs[l.locationId];
      const secret = client && ref ? await this.vault.resolve(ref) : null;
      if (!secret) { refused++; this.o.log?.("warn", "location_feed_unconfigured", { locationId: l.locationId, provider: l.provider }); continue; }
      const cred = new SecretHandle(secret, ref);
      const scopes = await client.scopes(cred);
      if (scopes.length === 0 || !scopes.every(readOnlyScope)) {
        this.o.log?.("error", "location_feed_scope_refused", { locationId: l.locationId, scopes });
        refused++;
        continue;
      }
      const b = await client.balance(cred);
      if (b.currency !== l.currency) { refused++; this.o.log?.("error", "location_feed_currency", { locationId: l.locationId, currency: b.currency }); continue; }
      // Transactions first, then the balance: a reading taken after them never double-counts them.
      for (const t of await client.transactions(cred, since)) {
        if (t.currency !== l.currency) continue;
        const r = await this.port.txn(this.worker, l.locationId, t);
        if (r.ok) recorded++;
      }
      await this.port.balance(this.worker, l.locationId, b);
    }
    return { locations: locs.length, recorded, refused };
  }
}

// ── Starling (candidate) ──
type Fetch = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
type Money = { currency: string; minorUnits: number };
interface StarlingItem {
  feedItemUid: string; direction: "IN" | "OUT"; status: string; source: string; spendingCategory?: string; amount: Money; sourceAmount?: Money;
  counterPartyName?: string; reference?: string; transactionTime?: string; settlementTime?: string;
}
const STARLING_STATUS: Record<string, LocationTxn["status"] | undefined> = { PENDING: "pending", SETTLED: "settled", DECLINED: "declined", REVERSED: "reversed", REFUNDED: "reversed" };

/** A Starling feed item as a location transaction; null for items that are not money movements yet (upcoming, checks). */
export function starlingTxn(i: StarlingItem): LocationTxn | null {
  const status = STARLING_STATUS[i.status];
  if (!status || !i.amount || !(i.amount.minorUnits > 0)) return null;
  const direction = i.direction === "OUT" ? "out" : "in";
  const kind: LocationTxn["kind"] = i.spendingCategory === "BANK_CHARGES" && direction === "out" ? "fee"
    : /INTEREST/.test(i.source) ? "interest"
    : /MASTER_CARD|CARD/.test(i.source) ? (direction === "out" ? "card" : "card_refund")
    : /FASTER_PAYMENTS|INTERNAL_TRANSFER|SEPA|CHAPS|BACS/.test(i.source) ? "transfer" : "other";
  const fx = i.sourceAmount && i.sourceAmount.currency !== i.amount.currency;
  return {
    externalId: `starling:${i.feedItemUid}`, status, direction, kind, amountMinor: i.amount.minorUnits, currency: i.amount.currency,
    ...(fx ? { originalAmountMinor: i.sourceAmount!.minorUnits, originalCurrency: i.sourceAmount!.currency } : {}),
    descriptor: [i.counterPartyName, i.reference].filter(Boolean).join(" · ").slice(0, 140) || null,
    ...(i.transactionTime ? { authorisedAt: i.transactionTime } : {}),
    ...(status === "settled" && i.settlementTime ? { settledAt: i.settlementTime } : {}),
  };
}

export class StarlingClient implements LocationFeedClient {
  constructor(private readonly o: { accountUid: string; categoryUid: string; baseUrl?: string; fetch?: Fetch }) {
    if (!/^[0-9a-f-]{36}$/.test(o.accountUid) || !/^[0-9a-f-]{36}$/.test(o.categoryUid)) throw new Error("Starling account and category ids are UUIDs");
  }
  private async get<T>(cred: SecretHandle, path: string): Promise<T> {
    const f = this.o.fetch ?? (globalThis.fetch as unknown as Fetch);
    const r = await f(`${this.o.baseUrl ?? "https://api.starlingbank.com"}${path}`, { headers: { Authorization: cred.bearer(), Accept: "application/json" } });
    if (!r.ok) throw new Error(`STARLING_HTTP_${r.status}`);
    return r.json() as Promise<T>;
  }
  async scopes(cred: SecretHandle) { return (await this.get<{ scopes?: string[] }>(cred, "/api/v2/identity/token")).scopes ?? []; }
  async balance(cred: SecretHandle): Promise<LocationBalance> {
    const b = await this.get<{ effectiveBalance: Money; clearedBalance: Money; pendingTransactions: Money }>(cred, `/api/v2/accounts/${this.o.accountUid}/balance`);
    return { availableMinor: b.effectiveBalance.minorUnits, clearedMinor: b.clearedBalance?.minorUnits ?? null, pendingMinor: b.pendingTransactions?.minorUnits ?? null, currency: b.effectiveBalance.currency };
  }
  async transactions(cred: SecretHandle, since: string): Promise<LocationTxn[]> {
    const q = `changesSince=${encodeURIComponent(since)}`;
    const r = await this.get<{ feedItems?: StarlingItem[] }>(cred, `/api/v2/feed/account/${this.o.accountUid}/category/${this.o.categoryUid}?${q}`);
    return (r.feedItems ?? []).map(starlingTxn).filter((t): t is LocationTxn => t !== null);
  }
}

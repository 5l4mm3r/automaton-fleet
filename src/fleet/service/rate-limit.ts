/**
 * Token-bucket rate limiter (in memory, per service instance).
 *
 * Keys are agent ids (claimed from the token, before any DB work) and remote
 * addresses (for authentication failures). The map is bounded so a flood of
 * distinct keys cannot exhaust memory. Multi-instance deployments rate-limit
 * per instance; the per-request nonce ledger (replay protection) is shared
 * in the database.
 */

export interface RateLimit {
  /** Burst size. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSec: number;
}

interface Bucket {
  tokens: number;
  at: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: RateLimit,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  private bucket(key: string): Bucket {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) {
        // Drop the oldest entry (Map preserves insertion order).
        const first = this.buckets.keys().next().value;
        if (first !== undefined) this.buckets.delete(first);
      }
      b = { tokens: this.limit.capacity, at: t };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.limit.capacity, b.tokens + ((t - b.at) / 1000) * this.limit.refillPerSec);
    b.at = t;
    return b;
  }

  /** Take `cost` tokens; false (and nothing taken) when the bucket is empty. */
  take(key: string, cost = 1): boolean {
    const b = this.bucket(key);
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }

  /** Seconds until `cost` tokens are available. */
  retryAfterS(key: string, cost = 1): number {
    const b = this.bucket(key);
    return b.tokens >= cost ? 0 : Math.ceil((cost - b.tokens) / this.limit.refillPerSec);
  }
}

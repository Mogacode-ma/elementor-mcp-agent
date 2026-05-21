/**
 * Per-site token bucket so we don't hammer a WordPress install.
 * Default 60 req/min — most managed hosts (incl. Infomaniak) start throttling
 * around that rate on the wp-json endpoint.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();
  private readonly refillPerMs: number;

  constructor(private readonly capacityPerMinute: number) {
    this.tokens = capacityPerMinute;
    this.refillPerMs = capacityPerMinute / 60_000;
  }

  async acquire(): Promise<void> {
    while (this.tokens < 1) {
      this.refill();
      if (this.tokens < 1) await new Promise((r) => setTimeout(r, 80));
    }
    this.tokens -= 1;
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(
      this.capacityPerMinute,
      this.tokens + (now - this.lastRefill) * this.refillPerMs,
    );
    this.lastRefill = now;
  }

  get available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
}

const buckets = new Map<string, TokenBucket>();
export function bucketFor(siteId: string, perMinute: number): TokenBucket {
  let b = buckets.get(siteId);
  if (!b) {
    b = new TokenBucket(perMinute);
    buckets.set(siteId, b);
  }
  return b;
}

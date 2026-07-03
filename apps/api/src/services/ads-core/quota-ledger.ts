/**
 * Ads Core (E1) — distributed quota ledger for channel API budgets.
 *
 * The repo's token bucket (utils/rate-limiter.ts) is in-process per container
 * — correct for burst smoothing, wrong for hard per-seller/per-app quotas that
 * survive restarts and span instances (the E0 audit gap). This ledger counts
 * reservations in fixed windows keyed in a shared store (Redis in prod,
 * memory in tests/fallback), so callers can budget against verified eBay
 * quotas, e.g.:
 *   reports:        200/hour per seller   → { limit: 200,    windowSec: 3600 }
 *   marketing-ads:  10,000/day per app    → { limit: 10_000, windowSec: 86_400 }
 *   budget updates: 15/day per campaign   → { limit: 15,     windowSec: 86_400 }
 *
 * Fixed-window semantics (INCR + TTL): simple, atomic enough for API quota
 * protection (the provider enforces the real limit; we stay safely under it).
 * Callers `reserve()` BEFORE the API call; a denied reservation defers work
 * visibly (freshness state) — never silently.
 *
 * failMode (store outage):
 *   'closed' (default) — deny reservations, flag degraded. Right for writes.
 *   'open'             — allow, flag degraded. Acceptable for cheap reads.
 */

export interface QuotaStore {
  /** Atomically increment `key`, setting `ttlSec` expiry when first created.
   *  Returns the post-increment count. */
  incr(key: string, ttlSec: number): Promise<number>
}

export interface QuotaBudget {
  /** Stable budget name, e.g. 'ebay:marketing:reports:<connectionId>'. */
  key: string
  limit: number
  windowSec: number
}

export interface QuotaReservation {
  ok: boolean
  /** Count consumed in the current window (post-increment; ≤ limit when ok). */
  used: number
  remaining: number
  /** Seconds until the current window resets (ceil). */
  retryAfterSec: number
  /** True when the store failed and failMode decided the outcome. */
  degraded: boolean
}

export class MemoryQuotaStore implements QuotaStore {
  private buckets = new Map<string, { n: number; expiresAtMs: number }>()
  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  async incr(key: string, ttlSec: number): Promise<number> {
    const now = this.nowMs()
    const hit = this.buckets.get(key)
    if (!hit || hit.expiresAtMs <= now) {
      this.buckets.set(key, { n: 1, expiresAtMs: now + ttlSec * 1000 })
      return 1
    }
    hit.n += 1
    return hit.n
  }
}

/** Minimal Redis surface we need (ioredis-compatible). */
export interface RedisLikeClient {
  incr(key: string): Promise<number>
  expire(key: string, seconds: number): Promise<unknown>
}

export class RedisQuotaStore implements QuotaStore {
  /** Lazy client getter so importing this module never opens a connection. */
  constructor(private readonly getClient: () => Promise<RedisLikeClient> | RedisLikeClient) {}

  async incr(key: string, ttlSec: number): Promise<number> {
    const client = await this.getClient()
    const n = await client.incr(key)
    // First increment creates the key → arm the window TTL. A crash between
    // INCR and EXPIRE could leave a keyless TTL only for that first call;
    // the +60s slack and the provider's own enforcement bound the harm.
    if (n === 1) await client.expire(key, ttlSec + 60)
    return n
  }
}

export class QuotaLedger {
  constructor(
    private readonly store: QuotaStore,
    private readonly opts: { failMode?: 'open' | 'closed'; nowMs?: () => number } = {},
  ) {}

  private now(): number {
    return (this.opts.nowMs ?? (() => Date.now()))()
  }

  /** Reserve `n` units against the budget's current fixed window. */
  async reserve(budget: QuotaBudget, n = 1): Promise<QuotaReservation> {
    const nowSec = Math.floor(this.now() / 1000)
    const windowIdx = Math.floor(nowSec / budget.windowSec)
    const windowKey = `quota:${budget.key}:${windowIdx}`
    const retryAfterSec = (windowIdx + 1) * budget.windowSec - nowSec

    let used: number
    try {
      used = 0
      for (let i = 0; i < n; i++) used = await this.store.incr(windowKey, budget.windowSec)
    } catch {
      const failOpen = this.opts.failMode === 'open'
      return { ok: failOpen, used: 0, remaining: 0, retryAfterSec, degraded: true }
    }

    const ok = used <= budget.limit
    return {
      ok,
      used,
      remaining: Math.max(0, budget.limit - used),
      retryAfterSec,
      degraded: false,
    }
  }
}

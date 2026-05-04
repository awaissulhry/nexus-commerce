/**
 * NN.2 — idempotency-key dedup for critical writes.
 *
 * Caller pattern:
 *
 *   const key = request.headers['idempotency-key']
 *   const cached = await idempotencyService.lookup(key, 'wizard-submit')
 *   if (cached) return cached.result
 *   // … perform work …
 *   await idempotencyService.store(key, 'wizard-submit', result)
 *
 * Purpose: a double-clicked Submit / Replicate / Generate AI button
 * sends two POSTs back to back. Without dedup, the server runs the
 * publish twice. With this in front, the second request hits the
 * cache and returns the first call's result.
 *
 * Storage is in-memory with a 10-minute TTL. Single-instance only.
 * Swap to Redis for multi-instance deploys when that lands.
 */

interface CachedEntry {
  result: unknown
  expiresAt: number
}

const TTL_MS = 10 * 60 * 1000 // 10 minutes
const MAX_ENTRIES = 5000 // prevent unbounded memory growth

class IdempotencyService {
  private cache = new Map<string, CachedEntry>()

  private compositeKey(scope: string, key: string): string {
    return `${scope}:${key}`
  }

  /** Look up a previously stored result. Returns null if missing or
   *  expired. Side-effect: prunes the expired entry on miss-due-to-
   *  expiry so the map doesn't slowly bloat. */
  lookup(scope: string, key: string | undefined): unknown {
    if (!key) return null
    const compKey = this.compositeKey(scope, key)
    const entry = this.cache.get(compKey)
    if (!entry) return null
    if (entry.expiresAt < Date.now()) {
      this.cache.delete(compKey)
      return null
    }
    return entry.result
  }

  /** Store a result under (scope, key). No-op when key is empty. */
  store(scope: string, key: string | undefined, result: unknown): void {
    if (!key) return
    const compKey = this.compositeKey(scope, key)
    if (this.cache.size >= MAX_ENTRIES) {
      // Evict the oldest entry. Map iteration order is insertion
      // order so the first entry is the oldest.
      const firstKey = this.cache.keys().next().value
      if (firstKey !== undefined) this.cache.delete(firstKey)
    }
    this.cache.set(compKey, {
      result,
      expiresAt: Date.now() + TTL_MS,
    })
  }
}

export const idempotencyService = new IdempotencyService()

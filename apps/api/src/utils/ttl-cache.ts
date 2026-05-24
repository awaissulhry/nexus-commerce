/**
 * EH.4 — Tiny in-memory TTL cache for hot GET endpoints.
 *
 * Used in front of expensive Prisma joins or live SP-API schema
 * fetches so the warm-path latency drops from hundreds of
 * milliseconds to single-digit microseconds. Not a replacement for
 * Redis or HTTP caching — it's a per-process scratchpad that:
 *
 *   - Evicts entries when their TTL elapses (lazy: on next get())
 *   - Caps size to prevent memory bloat (LRU on insert when full)
 *   - Treats the key as opaque — caller decides what goes in it
 *
 * Two intended usage shapes:
 *
 *   1. Pure TTL (schema/template that rarely changes):
 *        const k = `${marketplace}:${productType}`
 *        const hit = cache.get(k); if (hit) return hit
 *        const v = await build(); cache.set(k, v); return v
 *
 *   2. Updated-at-keyed (DB-backed entities — invalidate on edit):
 *        const k = `${id}:${updatedAtMs}` // changes when row edits
 *        const hit = cache.get(k); if (hit) return hit
 *        const v = await query(); cache.set(k, v); return v
 *
 *   The second pattern means a single Product.update() bumps
 *   updatedAt → cache key changes → next read repopulates. No
 *   explicit invalidation needed.
 */

export interface TtlCacheOptions {
  /** Time to live for each entry, milliseconds. */
  ttlMs: number
  /** Maximum number of entries; oldest evicted when exceeded. Default 1000. */
  maxEntries?: number
}

interface Entry<V> {
  value: V
  expiresAt: number
}

export class TtlCache<V> {
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly store = new Map<string, Entry<V>>()

  constructor(opts: TtlCacheOptions) {
    this.ttlMs = opts.ttlMs
    this.maxEntries = opts.maxEntries ?? 1000
  }

  get(key: string): V | undefined {
    const hit = this.store.get(key)
    if (!hit) return undefined
    if (hit.expiresAt <= Date.now()) {
      this.store.delete(key)
      return undefined
    }
    // Touch — promote to MRU position so the LRU eviction below is
    // actually least-recently-used and not least-recently-inserted.
    this.store.delete(key)
    this.store.set(key, hit)
    return hit.value
  }

  set(key: string, value: V): void {
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      // Map iteration is insertion order; first key = oldest = LRU
      // because reads `delete + set` promote entries to MRU above.
      const oldest = this.store.keys().next().value
      if (oldest !== undefined) this.store.delete(oldest)
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs })
  }

  /** Drop a specific key. No-op when absent. */
  delete(key: string): void {
    this.store.delete(key)
  }

  /** Drop everything — useful in tests or after bulk migrations. */
  clear(): void {
    this.store.clear()
  }

  /** Approximate live size (does not lazily evict — for observability). */
  get size(): number {
    return this.store.size
  }
}

/**
 * Phase 4 — Redis read-through cache for the hot advertising aggregations.
 *
 * The campaign/ad-group surfaces aggregate AmazonAdsDailyPerformance on every
 * request. Those queries are indexed but the DB compute is contended, so the
 * SAME query swings 1–4s. Caching the response in Redis (co-located in EU,
 * <5ms reads) makes loads fast AND consistent, and absorbs the DB variance.
 *
 * - cached(): read-through with a short TTL. JSON-serialisable values only
 *   (the ad endpoints already stringify BigInt costMicros before returning).
 * - flushAdsCache(): wipe all ads keys — called after any successful mutation
 *   so an operator never sees a stale number right after an edit.
 *
 * Every Redis op is wrapped so a Redis hiccup degrades to a direct DB read
 * rather than an error.
 */
import { redis } from '../../lib/queue.js'
import { logger } from '../../utils/logger.js'

const PREFIX = 'adscache:'

export async function cached<T>(key: string, ttlSec: number, fn: () => Promise<T>): Promise<T> {
  const k = PREFIX + key
  try {
    const hit = await redis.connection.get(k)
    if (hit != null) return JSON.parse(hit) as T
  } catch (e) {
    logger.debug('[ads-cache] read miss/err', { error: String(e).slice(0, 100) })
  }
  const val = await fn()
  try {
    await redis.connection.set(k, JSON.stringify(val), 'EX', ttlSec)
  } catch (e) {
    logger.debug('[ads-cache] write err', { error: String(e).slice(0, 100) })
  }
  return val
}

let flushing = false
export async function flushAdsCache(): Promise<void> {
  if (flushing) return
  flushing = true
  try {
    // Small keyspace (a few dozen ad keys); scan+del is cheap and avoids KEYS
    // blocking. SCAN with the prefix, delete in batches.
    let cursor = '0'
    do {
      const [next, keys] = await redis.connection.scan(cursor, 'MATCH', `${PREFIX}*`, 'COUNT', 200)
      cursor = next
      if (keys.length) await redis.connection.del(...keys)
    } while (cursor !== '0')
  } catch (e) {
    logger.debug('[ads-cache] flush err', { error: String(e).slice(0, 100) })
  } finally {
    flushing = false
  }
}

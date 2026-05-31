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

// HARD timeout for every Redis op. ioredis offline-queues commands when the
// server is unreachable, so a bare `await get()` PENDS forever (never throws) —
// which hung the cached endpoints. Race every op against a short timer so a
// Redis hiccup degrades to a direct DB read in <150ms instead of hanging.
const REDIS_OP_TIMEOUT_MS = 150

function withTimeout<R>(p: Promise<R>, ms: number): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('redis_timeout')), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

// Circuit breaker — if Redis is persistently unreachable, paying the 150ms
// timeout on every request is worse than no cache. After 3 consecutive
// failures, bypass Redis entirely for 30s, then probe again.
let consecutiveFailures = 0
let skipUntil = 0
function redisDisabled(): boolean { return Date.now() < skipUntil }
function noteRedisResult(ok: boolean): void {
  if (ok) { consecutiveFailures = 0; skipUntil = 0; return }
  consecutiveFailures += 1
  if (consecutiveFailures >= 3) { skipUntil = Date.now() + 30_000; logger.warn('[ads-cache] Redis circuit OPEN — bypassing cache 30s') }
}

export async function cached<T>(key: string, ttlSec: number, fn: () => Promise<T>): Promise<T> {
  if (redisDisabled()) return fn()
  const k = PREFIX + key
  try {
    const hit = await withTimeout(redis.connection.get(k), REDIS_OP_TIMEOUT_MS)
    noteRedisResult(true)
    if (hit != null) return JSON.parse(hit) as T
  } catch (e) {
    noteRedisResult(false)
    logger.debug('[ads-cache] read miss/err', { error: String(e).slice(0, 100) })
  }
  const val = await fn()
  // Fire-and-forget the write so a slow Redis never delays the response.
  withTimeout(redis.connection.set(k, JSON.stringify(val), 'EX', ttlSec), REDIS_OP_TIMEOUT_MS)
    .then(() => noteRedisResult(true))
    .catch((e) => { noteRedisResult(false); logger.debug('[ads-cache] write err', { error: String(e).slice(0, 100) }) })
  return val
}

let flushing = false
export async function flushAdsCache(): Promise<void> {
  if (flushing || redisDisabled()) return
  flushing = true
  try {
    // Small keyspace (a few dozen ad keys); scan+del is cheap and avoids KEYS
    // blocking. SCAN with the prefix, delete in batches. Each op is time-boxed
    // so an unreachable Redis can't hang the flush (and an unbounded loop).
    let cursor = '0'
    let guard = 0
    do {
      const [next, keys] = await withTimeout(redis.connection.scan(cursor, 'MATCH', `${PREFIX}*`, 'COUNT', 200), REDIS_OP_TIMEOUT_MS)
      cursor = next
      if (keys.length) await withTimeout(redis.connection.del(...keys), REDIS_OP_TIMEOUT_MS)
    } while (cursor !== '0' && ++guard < 100)
  } catch (e) {
    logger.debug('[ads-cache] flush err', { error: String(e).slice(0, 100) })
  } finally {
    flushing = false
  }
}

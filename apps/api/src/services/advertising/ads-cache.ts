/**
 * Phase 4 — two-tier read cache for the hot advertising aggregations.
 *
 * The campaign/ad-group surfaces re-aggregate AmazonAdsDailyPerformance (and,
 * for ad groups, the whole campaign's siblings) on every request. Those queries
 * are indexed but the DB compute is contended, so the SAME query swings 1–4s+.
 *
 * - L1 = in-process memory cache (Map). Always available, instant (no network),
 *   works even when Redis is down. This is the primary speed layer for a single
 *   API instance — and it's what actually makes the ad-group page fast when
 *   Redis is unreachable on prod.
 * - L2 = Redis. Shared across instances when reachable; every op is time-boxed
 *   (ioredis offline-queues commands, so a bare await PENDS forever when Redis
 *   is down — that hung the endpoints) + a circuit breaker bypasses it after
 *   repeated failures.
 *
 * flushAdsCache() clears BOTH tiers after any successful mutation so an operator
 * never sees a stale number right after an edit.
 */
import { redis } from '../../lib/queue.js'
import { logger } from '../../utils/logger.js'

const PREFIX = 'adscache:'

// ── L1 in-memory cache ────────────────────────────────────────────────────
interface MemEntry { val: unknown; exp: number }
const mem = new Map<string, MemEntry>()
const MEM_MAX = 1000
function memGet(key: string): unknown | undefined {
  const e = mem.get(key)
  if (!e) return undefined
  if (Date.now() > e.exp) { mem.delete(key); return undefined }
  // refresh LRU position
  mem.delete(key); mem.set(key, e)
  return e.val
}
function memSet(key: string, val: unknown, ttlSec: number): void {
  if (mem.size >= MEM_MAX) { const oldest = mem.keys().next().value; if (oldest) mem.delete(oldest) }
  mem.set(key, { val, exp: Date.now() + ttlSec * 1000 })
}

// ── L2 Redis (time-boxed + circuit breaker) ────────────────────────────────
const REDIS_OP_TIMEOUT_MS = 150
function withTimeout<R>(p: Promise<R>, ms: number): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('redis_timeout')), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}
let consecutiveFailures = 0
let skipUntil = 0
function redisDisabled(): boolean { return Date.now() < skipUntil }
function noteRedisResult(ok: boolean): void {
  if (ok) { consecutiveFailures = 0; skipUntil = 0; return }
  consecutiveFailures += 1
  if (consecutiveFailures >= 3) { skipUntil = Date.now() + 30_000; logger.warn('[ads-cache] Redis circuit OPEN — bypassing L2 30s (L1 memory still active)') }
}

export async function cached<T>(key: string, ttlSec: number, fn: () => Promise<T>): Promise<T> {
  const k = PREFIX + key
  // L1 — instant, always available.
  const m = memGet(k)
  if (m !== undefined) return m as T

  // L2 — Redis, if reachable.
  if (!redisDisabled()) {
    try {
      const hit = await withTimeout(redis.connection.get(k), REDIS_OP_TIMEOUT_MS)
      noteRedisResult(true)
      if (hit != null) { const v = JSON.parse(hit) as T; memSet(k, v, ttlSec); return v }
    } catch (e) {
      noteRedisResult(false)
      logger.debug('[ads-cache] L2 read miss/err', { error: String(e).slice(0, 100) })
    }
  }

  const val = await fn()
  memSet(k, val, ttlSec)
  if (!redisDisabled()) {
    // Fire-and-forget the L2 write so a slow Redis never delays the response.
    withTimeout(redis.connection.set(k, JSON.stringify(val), 'EX', ttlSec), REDIS_OP_TIMEOUT_MS)
      .then(() => noteRedisResult(true))
      .catch((e) => { noteRedisResult(false); logger.debug('[ads-cache] L2 write err', { error: String(e).slice(0, 100) }) })
  }
  return val
}

let flushing = false
export async function flushAdsCache(): Promise<void> {
  mem.clear() // L1 always cleared, synchronously.
  if (flushing || redisDisabled()) return
  flushing = true
  try {
    let cursor = '0'
    let guard = 0
    do {
      const [next, keys] = await withTimeout(redis.connection.scan(cursor, 'MATCH', `${PREFIX}*`, 'COUNT', 200), REDIS_OP_TIMEOUT_MS)
      cursor = next
      if (keys.length) await withTimeout(redis.connection.del(...keys), REDIS_OP_TIMEOUT_MS)
    } while (cursor !== '0' && ++guard < 100)
  } catch (e) {
    logger.debug('[ads-cache] L2 flush err', { error: String(e).slice(0, 100) })
  } finally {
    flushing = false
  }
}

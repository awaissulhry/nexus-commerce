/**
 * Google Ads — two guards of one account's read, in the CURRENT business, on the Redis the operations allowance uses
 * (ops-budget.ts: the same connection and the same test seam). Both keys carry the business and the account.
 *
 *   the read lock     one read of a business's account at a time (sync.service.ts takes it before anything else).
 *                     `SET nexus:gads:read-lock:<business>:<account> <token> PX 2h NX` takes it; `finally` gives it back
 *                     (compare-and-delete: only the holder's own token). Two hours is far longer than a read takes (a
 *                     daily read is about 25 queries; even a big account's pages come in minutes, each page bounded by a
 *                     2-minute timeout); a holder that dies leaves it to run out, so a crash blocks the account's reads
 *                     for two hours at most. A read that finds it held is skipped in words and spends nothing. Without
 *                     Redis (none configured, or it does not answer within 3 s): a lock in this process.
 *   refused queries   the queries with a twin without one field are a safety net: every such field is verified valid
 *                     in v25 (https://developers.google.com/google-ads/api/fields/v25/<resource>, gaql.ts). Should
 *                     Google refuse one anyway, the refusal is remembered for 7 days per business + account + read
 *                     (`nexus:gads:fallback:<business>:<account>:<read>`). While remembered, the read sends the twin at
 *                     once, so a refused attempt costs one operation a week instead of one a day; after 7 days it tries
 *                     the full query again. Without Redis nothing is remembered: the read sends the full query first,
 *                     as before.
 */
import { randomUUID } from 'node:crypto'
import { RELEASE_LEASE } from '../../../lib/cron/workspace-lease.js'
import { workspaceIdForQuery } from '../../../lib/workspace-context.js'
import { logger } from '../../../utils/logger.js'
import { googleAdsRedis, timed, type OpsRedis } from './ops-budget.js'

/** Far longer than a read takes; a holder that dies leaves the lock to run out after this. */
export const READ_LOCK_MS = 2 * 60 * 60_000
/** How long a refused query is remembered before the full query is tried again. */
export const FALLBACK_MEMORY_MS = 7 * 24 * 60 * 60_000

const LOCK_PREFIX = 'nexus:gads:read-lock'
const FALLBACK_PREFIX = 'nexus:gads:fallback'

export const readLockKey = (customerId: string): string => `${LOCK_PREFIX}:${workspaceIdForQuery()}:${customerId}`
export const fallbackKey = (customerId: string, read: string): string => `${FALLBACK_PREFIX}:${workspaceIdForQuery()}:${customerId}:${read}`

async function liveRedis(): Promise<OpsRedis | null> {
  const redis = await googleAdsRedis().catch(() => null)
  return !redis || redis.status === 'end' || redis.status === 'close' ? null : redis
}

// ── the read lock ────────────────────────────────────────────────────────────────────────────────────────────────

/** Locks held in this process when Redis cannot be asked. */
const localLocks = new Set<string>()

export interface ReadLock {
  /** Give the lock back. Never throws. */
  release(): Promise<void>
}

/** Take this business's lock on the account; null when another read holds it. */
export async function takeReadLock(customerId: string): Promise<ReadLock | null> {
  const key = readLockKey(customerId)
  const token = randomUUID()
  const redis = await liveRedis()
  let late: Promise<unknown> | null = null
  if (redis) {
    const claim = redis.set(key, token, 'PX', READ_LOCK_MS, 'NX')
    try {
      if ((await timed(claim)) !== 'OK') return null
      return {
        release: async () => {
          try {
            if (redis.eval) await timed(redis.eval(RELEASE_LEASE, 1, key, token))
          } catch (err) {
            logger.warn('[google-ads-sync] the read lock was not given back; it runs out on its own', { customerId, error: err instanceof Error ? err.message : String(err) })
          }
        },
      }
    } catch {
      // Redis did not answer: this process's lock. A claim that still lands later is given back with it.
      late = claim
    }
  }
  if (localLocks.has(key)) return null
  localLocks.add(key)
  return {
    release: async () => {
      localLocks.delete(key)
      if (late && redis?.eval) {
        const evalOf = redis.eval.bind(redis)
        void late.then((answer) => (answer === 'OK' ? evalOf(RELEASE_LEASE, 1, key, token) : null)).catch(() => {})
      }
    },
  }
}

// ── refused queries ──────────────────────────────────────────────────────────────────────────────────────────────

/** True while Google's refusal of this read's full query is remembered (fewer than 7 days before `now`). */
export async function fallbackRemembered(customerId: string, read: string, now: Date): Promise<boolean> {
  const redis = await liveRedis()
  if (!redis) return false
  try {
    const at = Date.parse((await timed(redis.get(fallbackKey(customerId, read)))) ?? '')
    return Number.isFinite(at) && now.getTime() - at < FALLBACK_MEMORY_MS
  } catch {
    return false
  }
}

/** Remember that Google refused this read's full query (for 7 days). Never throws. */
export async function rememberFallback(customerId: string, read: string, now: Date): Promise<void> {
  const redis = await liveRedis()
  if (!redis) return
  try {
    await timed(redis.set(fallbackKey(customerId, read), now.toISOString(), 'PX', FALLBACK_MEMORY_MS))
  } catch { /* not remembered: the next read tries the full query first, as before */ }
}

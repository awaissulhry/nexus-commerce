/**
 * 2026-09-30 — one inventory write per Etsy listing at a time, across every worker process.
 *
 * Etsy's inventory PUT replaces the whole inventory, so every stock or price write is read → change → replace. Two
 * rows for ONE listing that overlap (its price and its stock, or two sibling SKUs of one variation listing) both read
 * the same inventory, and the second replace puts back what the first one had just changed: a lost update that the
 * PUT answers 200 to. The outbound worker runs up to two jobs per account at once, so they can overlap.
 *
 * The lock is a Redis lease, the pattern `lib/cron/workspace-lease.ts` already uses: `SET key token PX ttl NX` takes
 * it, a compare-and-expire renews it while the write runs, a compare-and-delete releases it (only the holder's own
 * token can). Why not the other locks in this codebase:
 * - a PostgreSQL SESSION advisory lock does not survive pgbouncer transaction pooling;
 * - a TRANSACTION advisory lock or a row lock would hold a pooled connection open across Etsy's HTTP calls, which
 *   `stock-lock.ts` and `ads-mutation.service.ts` both rule out;
 * - an in-process lock does not cover a second worker replica.
 *
 * What a writer that finds the listing locked does:
 * - it WAITS, polling, for up to `waitMs` (20 s, well inside the 45 s dispatch timeout; a write holds it for seconds);
 * - if it still cannot take it, or Redis cannot be reached, it throws `EtsyListingBusy` BEFORE reading or sending
 *   anything. The queue DEFERS that row (no retry spent) and runs it again shortly; it is never reported as done.
 *
 * A holder that dies stops renewing, and its lease expires after `ttlMs` (30 s): a crash cannot block a listing.
 */
import { randomUUID } from 'node:crypto'
import { logger } from '../../utils/logger.js'

/** The two Redis commands the lease needs; `ioredis` has both. */
export interface ListingLockStore {
  status?: string
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<unknown>
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>
}

export const RENEW_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`
export const RELEASE_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`

export const ETSY_LISTING_LOCK_DEFAULTS = { ttlMs: 30_000, waitMs: 20_000, pollMs: 250, commandTimeoutMs: 3_000 }

/** Another change to the same Etsy listing holds its inventory, or the lock could not be taken. Nothing was read or sent. */
export class EtsyListingBusy extends Error {
  readonly code = 'ETSY_LISTING_BUSY'
  constructor(message: string) { super(message); this.name = 'EtsyListingBusy' }
}

/** Account first: Etsy listing ids are per shop. The braces keep every Etsy lock in one Redis Cluster slot. */
export function etsyListingLockKey(accountId: string, listingId: string | number): string {
  return `{nexus:etsy:inventory}:${accountId}:${String(listingId)}`
}

let sharedRedis: (() => ListingLockStore | null) | null = null

/**
 * The app's Redis, handed over by `lib/queue.ts` when it creates its connection — as the gateway's rate buckets and
 * the step-up guards get theirs. This module never opens a connection itself.
 */
export function registerEtsyListingLockRedis(get: (() => ListingLockStore | null) | null): void {
  sharedRedis = get
}

async function defaultStore(): Promise<ListingLockStore | null> {
  // A process that has not loaded the queue module yet: loading it creates the connection and registers it here.
  // Without it every Etsy inventory write would wait and be deferred for want of a lock nobody could take.
  if (!sharedRedis) {
    try { await import('../../lib/queue.js') } catch { /* no Redis configured: no lock, so no write (deferred) */ }
  }
  return sharedRedis?.() ?? null
}

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([promise, new Promise<never>((_, reject) => { const t = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms); t.unref?.() })])

export interface EtsyListingLockOptions {
  accountId: string
  listingId: string | number
  /** Tests pass one; production uses the queue's Redis connection (`registerEtsyListingLockRedis`). */
  store?: ListingLockStore | null
  ttlMs?: number
  waitMs?: number
  pollMs?: number
  commandTimeoutMs?: number
}

/** Run `work` holding the listing's inventory lock; wait for it, or throw `EtsyListingBusy` without running `work`. */
export async function withEtsyListingLock<T>(options: EtsyListingLockOptions, work: () => Promise<T>): Promise<T> {
  const { ttlMs, waitMs, pollMs, commandTimeoutMs } = { ...ETSY_LISTING_LOCK_DEFAULTS, ...definedOnly(options) }
  const store = options.store === undefined ? await defaultStore() : options.store
  const key = etsyListingLockKey(options.accountId, options.listingId)
  const token = randomUUID()
  const deadline = Date.now() + waitMs

  for (;;) {
    let taken: boolean
    try {
      // `ready` only: the queue's connection retries forever while Redis is down, so a command would hang, not fail.
      if (!store || store.status !== 'ready') throw new Error('Redis is not connected')
      taken = (await withTimeout(store.set(key, token, 'PX', ttlMs, 'NX'), commandTimeoutMs)) === 'OK'
    } catch (error) {
      logger.warn('[etsy] listing lock unavailable; the write is deferred', { key, error: error instanceof Error ? error.message : String(error) })
      throw new EtsyListingBusy('The lock that keeps two changes to this Etsy listing apart could not be taken, so nothing was sent. This change is retried shortly.')
    }
    if (taken) break
    if (Date.now() >= deadline) {
      throw new EtsyListingBusy('Another change to this Etsy listing is still being sent, so nothing was sent for this one yet. It is retried shortly.')
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs + Math.floor(Math.random() * pollMs)))
  }

  let renewing = false
  const timer = setInterval(async () => {
    if (renewing) return
    renewing = true
    try {
      if (await withTimeout(store!.eval(RENEW_SCRIPT, 1, key, token, ttlMs), commandTimeoutMs) !== 1) throw new Error('lease lost')
    } catch (error) {
      logger.error('[etsy] listing lock lost while an inventory write was in progress', { key, error: error instanceof Error ? error.message : String(error) })
    } finally { renewing = false }
  }, Math.max(50, Math.floor(ttlMs / 3)))
  timer.unref?.()
  try {
    return await work()
  } finally {
    clearInterval(timer)
    try { await withTimeout(store!.eval(RELEASE_SCRIPT, 1, key, token), commandTimeoutMs) }
    catch (error) { logger.warn('[etsy] listing lock release failed; it expires on its own', { key, error: error instanceof Error ? error.message : String(error) }) }
  }
}

function definedOnly(options: EtsyListingLockOptions): Partial<typeof ETSY_LISTING_LOCK_DEFAULTS> {
  const out: Partial<typeof ETSY_LISTING_LOCK_DEFAULTS> = {}
  for (const k of ['ttlMs', 'waitMs', 'pollMs', 'commandTimeoutMs'] as const) if (options[k] !== undefined) out[k] = options[k]
  return out
}

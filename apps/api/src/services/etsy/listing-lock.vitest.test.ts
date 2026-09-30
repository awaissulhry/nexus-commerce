/**
 * 2026-09-30 — the Etsy listing lock (`listing-lock.ts`): one inventory write per (account, listing) at a time.
 *
 * Every arm runs against the in-memory stand-in of the two Redis commands. When `NEXUS_TEST_REDIS_URL` names a
 * throwaway Redis (a loopback URL only), the same arms run against it too, so the lease is proven on Redis itself and
 * not only on a fake of it. CI has no Redis; that arm is skipped there and run locally.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import Redis from 'ioredis'
import { EtsyListingBusy, etsyListingLockKey, withEtsyListingLock, type ListingLockStore } from './listing-lock.js'
import { FakeLeaseRedis } from '../../test-support/fake-lease-redis.js'

const REAL_URL = process.env.NEXUS_TEST_REDIS_URL?.trim() ?? ''
if (REAL_URL && !/^redis:\/\/(127\.0\.0\.1|localhost)[:/]/.test(REAL_URL)) throw new Error('NEXUS_TEST_REDIS_URL must be a loopback Redis')
let real: Redis | null = null
afterAll(async () => { await real?.quit() })

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const FAST = { ttlMs: 400, waitMs: 3_000, pollMs: 10 }

const stores: Array<[string, () => Promise<ListingLockStore & { hold(key: string, value: string, ttlMs: number): Promise<void> | void }>]> = [
  ['in-memory stand-in', async () => new FakeLeaseRedis()],
]
if (REAL_URL) {
  stores.push(['real Redis', async () => {
    real ??= new Redis(REAL_URL, { maxRetriesPerRequest: 1 })
    if (real.status !== 'ready') await new Promise((resolve, reject) => { real!.once('ready', resolve); real!.once('error', reject) })
    return Object.assign(real, { hold: async (key: string, value: string, ttlMs: number) => { await real!.set(key, value, 'PX', ttlMs) } }) as never
  }])
}

describe.each(stores)('the Etsy listing lock on the %s', (_name, makeStore) => {
  /** A fresh account per arm, so arms (and a real Redis shared between runs) never see each other's keys. */
  const account = () => `test-acct-${randomUUID()}`

  it('refuses a new send after another holder has taken the lease', async () => {
    const store = await makeStore(); const accountId = account()
    await withEtsyListingLock({ accountId, listingId: '1000000001', store, ...FAST }, async (lease) => {
      await store.hold(etsyListingLockKey(accountId, '1000000001'), 'replacement', 5_000)
      await expect(lease.assertHeld()).rejects.toBeInstanceOf(EtsyListingBusy)
      expect(lease.signal.aborted).toBe(true)
    })
  })

  it('aborts the active request signal when renewal finds a different holder', async () => {
    const store = await makeStore(); const accountId = account()
    await withEtsyListingLock({ accountId, listingId: '1000000001', store, ...FAST }, async (lease) => {
      await store.hold(etsyListingLockKey(accountId, '1000000001'), 'replacement', 5_000)
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Lease loss was not signalled')), 2_000)
        lease.signal.addEventListener('abort', () => { clearTimeout(timeout); resolve() }, { once: true })
      })
      expect(lease.signal.aborted).toBe(true)
    })
  })

  it('🔴 two writes to ONE listing never overlap: the second starts after the first has finished', async () => {
    const store = await makeStore(); const accountId = account()
    const events: string[] = []
    const write = (name: string) => withEtsyListingLock({ accountId, listingId: '1000000001', store, ...FAST }, async () => {
      events.push(`${name} start`); await pause(120); events.push(`${name} end`)
    })
    await Promise.all([write('A'), write('B')])
    expect(events.join(' | ')).toMatch(/^(A start \| A end \| B start \| B end|B start \| B end \| A start \| A end)$/)
  })

  it('two different listings still run side by side', async () => {
    const store = await makeStore(); const accountId = account()
    const events: string[] = []
    const write = (listingId: string) => withEtsyListingLock({ accountId, listingId, store, ...FAST }, async () => {
      events.push(`${listingId} start`); await pause(120); events.push(`${listingId} end`)
    })
    await Promise.all([write('1000000001'), write('1000000002')])
    expect(events.slice(0, 2).sort()).toEqual(['1000000001 start', '1000000002 start'])
  })

  it('the same listing id in two different shops is two listings (Etsy ids are per shop)', async () => {
    const store = await makeStore()
    const events: string[] = []
    const write = (accountId: string) => withEtsyListingLock({ accountId, listingId: '1000000001', store, ...FAST }, async () => {
      events.push('start'); await pause(120); events.push('end')
    })
    await Promise.all([write(account()), write(account())])
    expect(events.slice(0, 2)).toEqual(['start', 'start'])
  })

  it('🔴 a holder that died (its lease never released) blocks the listing only until the lease expires', async () => {
    const store = await makeStore(); const accountId = account()
    // A worker takes the lock, then its process dies: its renewals and its release never reach Redis.
    const dying: ListingLockStore = { status: 'ready', set: store.set.bind(store) as ListingLockStore['set'], eval: async () => { throw new Error('the process is gone') } }
    await withEtsyListingLock({ accountId, listingId: '1000000001', store: dying, ttlMs: 300, waitMs: 3_000, pollMs: 10 }, async () => undefined)
    const started = Date.now()
    let ran = false
    await withEtsyListingLock({ accountId, listingId: '1000000001', store, ...FAST }, async () => { ran = true })
    expect(ran).toBe(true)
    // It waited for the dead holder's lease to run out — and not a moment past the wait it is allowed.
    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
    expect(Date.now() - started).toBeLessThan(FAST.waitMs)
  })

  it('a LIVE holder keeps its lease past the TTL by renewing it: nobody gets in while it is still writing', async () => {
    const store = await makeStore(); const accountId = account()
    const events: string[] = []
    const slow = withEtsyListingLock({ accountId, listingId: '1000000001', store, ttlMs: 150, waitMs: 3_000, pollMs: 10 }, async () => {
      events.push('slow start'); await pause(600); events.push('slow end')   // four TTLs long
    })
    await pause(20)
    const next = withEtsyListingLock({ accountId, listingId: '1000000001', store, ttlMs: 150, waitMs: 3_000, pollMs: 10 }, async () => { events.push('next start') })
    await Promise.all([slow, next])
    expect(events).toEqual(['slow start', 'slow end', 'next start'])
  })

  it('🔴 still busy after the wait: EtsyListingBusy, and the write never runs (the queue defers it)', async () => {
    const store = await makeStore(); const accountId = account()
    await store.hold(etsyListingLockKey(accountId, '1000000001'), 'another-worker', 5_000)
    let ran = false
    await expect(withEtsyListingLock({ accountId, listingId: '1000000001', store, ttlMs: 400, waitMs: 150, pollMs: 10 }, async () => { ran = true }))
      .rejects.toMatchObject({ name: 'EtsyListingBusy', code: 'ETSY_LISTING_BUSY' })
    expect(ran).toBe(false)
  })

  it('a write that throws still releases the lock, so the next one is not held up', async () => {
    const store = await makeStore(); const accountId = account()
    await expect(withEtsyListingLock({ accountId, listingId: '1000000001', store, ...FAST }, async () => { throw new Error('Etsy said no') })).rejects.toThrow('Etsy said no')
    const started = Date.now()
    await withEtsyListingLock({ accountId, listingId: '1000000001', store, ...FAST, waitMs: 50 }, async () => undefined)
    expect(Date.now() - started).toBeLessThan(200)
  })

  it('a release never frees another holder\'s lease (only the token that took it can)', async () => {
    const store = await makeStore(); const accountId = account()
    const key = etsyListingLockKey(accountId, '1000000001')
    await withEtsyListingLock({ accountId, listingId: '1000000001', store, ttlMs: 60, waitMs: 1_000, pollMs: 10 }, async () => {
      // Our lease is lost mid-write (it lapsed during a stall) and another worker has taken the listing.
      await pause(250)
      await store.hold(key, 'the-next-holder', 5_000)
    })
    const held = store instanceof FakeLeaseRedis ? store.get(key) : await (store as unknown as Redis).get(key)
    expect(held).toBe('the-next-holder')
  })
})

describe('when the lock cannot be taken at all', () => {
  it.each([['no Redis connection', null], ['Redis not ready', Object.assign(new FakeLeaseRedis(), { status: 'reconnecting' })]])('%s: EtsyListingBusy, nothing runs', async (_name, store) => {
    let ran = false
    await expect(withEtsyListingLock({ accountId: 'test-acct', listingId: '1000000001', store: store as never, ...FAST }, async () => { ran = true }))
      .rejects.toBeInstanceOf(EtsyListingBusy)
    expect(ran).toBe(false)
  })

  it('a Redis that does not answer: EtsyListingBusy after the command timeout, not a hang', async () => {
    const silent: ListingLockStore = { status: 'ready', set: () => new Promise(() => undefined), eval: () => new Promise(() => undefined) }
    let ran = false
    await expect(withEtsyListingLock({ accountId: 'test-acct', listingId: '1000000001', store: silent, ...FAST, commandTimeoutMs: 50 }, async () => { ran = true }))
      .rejects.toBeInstanceOf(EtsyListingBusy)
    expect(ran).toBe(false)
  })
})

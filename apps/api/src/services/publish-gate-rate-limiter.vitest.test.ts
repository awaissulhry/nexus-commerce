/**
 * The publish gates' token buckets must not fail a caller whose wait timer fires a millisecond early.
 *
 * 2026-09-26: `db-security` failed on a docs-only PR because the Shopify shadow-report test, reading
 * through the real Shopify bucket, got "Shopify publish rate limiter could not acquire token after
 * waiting". Each gate waited exactly as long as one token needs, re-read Date.now() once, and gave up.
 * A timer can fire 1 ms early against Date.now(), which leaves 0.998 of a token — so a caller that
 * waited correctly was refused. The gates now keep waiting (still bounded by their cap).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireShopifyPublishToken } from './shopify-publish-gate.service.js'
import { acquireAmazonPublishToken } from './amazon-publish-gate.service.js'
import { acquireEbayPublishToken } from './ebay-publish-gate.service.js'

type Acquire = (key: string, maxWaitMs?: number) => Promise<{ ok: boolean; waitedMs: number; error?: string }>

// One bucket per shop (Shopify), per seller+marketplace (Amazon), per connection+marketplace (eBay).
const GATES: Array<{ name: string; acquire: Acquire; burst: number; perSecond: number }> = [
  { name: 'Shopify', acquire: (key, maxWaitMs) => acquireShopifyPublishToken(key, maxWaitMs), burst: 20, perSecond: 2 },
  { name: 'Amazon', acquire: (key, maxWaitMs) => acquireAmazonPublishToken(key, 'APJ6JRA9NG5V4', maxWaitMs), burst: 10, perSecond: 5 },
  { name: 'eBay', acquire: (key, maxWaitMs) => acquireEbayPublishToken(key, 'EBAY_IT', maxWaitMs), burst: 100, perSecond: 10 },
]

let clock = 0
beforeEach(() => {
  clock = 1_790_000_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  vi.useFakeTimers({ toFake: ['setTimeout'] })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe.each(GATES)('$name publish gate — token bucket', ({ acquire, burst, perSecond }) => {
  it('a wait timer that fires 1 ms early against the clock still gets its token', async () => {
    const key = `early-${Math.random()}`
    for (let i = 0; i < burst; i++) expect((await acquire(key)).ok).toBe(true)

    const pending = acquire(key)
    const fullWait = Math.ceil(1000 / perSecond)
    clock += fullWait - 1 // the timer fires, but Date.now() reads 1 ms short of a whole token
    await vi.advanceTimersByTimeAsync(fullWait)
    clock += 1
    await vi.advanceTimersByTimeAsync(5)
    const result = await pending

    expect(result.ok, result.error).toBe(true)
  })

  it('still refuses when the wait would exceed the cap', async () => {
    const key = `cap-${Math.random()}`
    for (let i = 0; i < burst; i++) await acquire(key)
    const result = await acquire(key, 1)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/rate-limited \(would need \d+ms wait, cap 1ms\)/)
  })
})

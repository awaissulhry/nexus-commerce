import { describe, it, expect } from 'vitest'
import { QuotaLedger, MemoryQuotaStore, RedisQuotaStore, type QuotaStore } from './quota-ledger.js'

const BUDGET = { key: 'ebay:test:reports', limit: 3, windowSec: 3600 }

function fixedClock(startMs: number) {
  let now = startMs
  return { nowMs: () => now, advance: (ms: number) => { now += ms } }
}

describe('QuotaLedger with MemoryQuotaStore', () => {
  it('grants up to the limit, then denies with retryAfter', async () => {
    const clock = fixedClock(1_000_000_000_000)
    const ledger = new QuotaLedger(new MemoryQuotaStore(clock.nowMs), { nowMs: clock.nowMs })

    for (let i = 1; i <= 3; i++) {
      const r = await ledger.reserve(BUDGET)
      expect(r.ok).toBe(true)
      expect(r.used).toBe(i)
      expect(r.remaining).toBe(3 - i)
      expect(r.degraded).toBe(false)
    }
    const denied = await ledger.reserve(BUDGET)
    expect(denied.ok).toBe(false)
    expect(denied.used).toBe(4)
    expect(denied.remaining).toBe(0)
    expect(denied.retryAfterSec).toBeGreaterThan(0)
    expect(denied.retryAfterSec).toBeLessThanOrEqual(3600)
  })

  it('resets in the next fixed window', async () => {
    const clock = fixedClock(1_000_000_000_000)
    const ledger = new QuotaLedger(new MemoryQuotaStore(clock.nowMs), { nowMs: clock.nowMs })

    for (let i = 0; i < 3; i++) await ledger.reserve(BUDGET)
    expect((await ledger.reserve(BUDGET)).ok).toBe(false)

    clock.advance(3600 * 1000) // next window
    const r = await ledger.reserve(BUDGET)
    expect(r.ok).toBe(true)
    expect(r.used).toBe(1)
  })

  it('reserves n units at once', async () => {
    const clock = fixedClock(1_000_000_000_000)
    const ledger = new QuotaLedger(new MemoryQuotaStore(clock.nowMs), { nowMs: clock.nowMs })
    const r = await ledger.reserve(BUDGET, 3)
    expect(r.ok).toBe(true)
    expect(r.used).toBe(3)
    expect((await ledger.reserve(BUDGET)).ok).toBe(false)
  })

  it('separate budget keys do not interfere', async () => {
    const clock = fixedClock(1_000_000_000_000)
    const ledger = new QuotaLedger(new MemoryQuotaStore(clock.nowMs), { nowMs: clock.nowMs })
    for (let i = 0; i < 3; i++) await ledger.reserve(BUDGET)
    const other = await ledger.reserve({ ...BUDGET, key: 'ebay:test:other' })
    expect(other.ok).toBe(true)
  })
})

describe('QuotaLedger fail modes', () => {
  const broken: QuotaStore = { incr: async () => { throw new Error('redis down') } }

  it('fails CLOSED by default (deny + degraded)', async () => {
    const r = await new QuotaLedger(broken).reserve(BUDGET)
    expect(r.ok).toBe(false)
    expect(r.degraded).toBe(true)
  })
  it('fails OPEN when configured (allow + degraded)', async () => {
    const r = await new QuotaLedger(broken, { failMode: 'open' }).reserve(BUDGET)
    expect(r.ok).toBe(true)
    expect(r.degraded).toBe(true)
  })
})

describe('RedisQuotaStore', () => {
  it('INCRs and arms TTL only on window creation (fake client)', async () => {
    const calls: string[] = []
    let n = 0
    const fake = {
      incr: async (key: string) => { calls.push(`incr:${key}`); return ++n },
      expire: async (key: string, s: number) => { calls.push(`expire:${key}:${s}`); return 1 },
    }
    const store = new RedisQuotaStore(() => fake)
    expect(await store.incr('quota:k:1', 100)).toBe(1)
    expect(await store.incr('quota:k:1', 100)).toBe(2)
    expect(calls).toEqual(['incr:quota:k:1', 'expire:quota:k:1:160', 'incr:quota:k:1'])
  })
})

/**
 * Google Ads steps 1a and 1b — the daily operations allowance over a rolling 24 hours: the global cap (env, default
 * 2,400) and 100 per account (step 1b: was 60), counted in Redis hourly buckets; refused when Redis is down; stopped
 * for an hour when Google says the day's allowance is used up; two racing reservations never overspend.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACCOUNT_DAILY_OPS, DEFAULT_GLOBAL_DAILY_OPS, WRITE_ACCOUNT_DAILY_OPS, addSpentOps, globalOpsCap, markQuotaExhausted, opsUsedLast24h, releaseOps, reserveOps, setOpsBudgetRedisForTests, type OpsRedis, LIVE_ACCOUNT_DAILY_OPS,
} from './ops-budget.js'

/** The Redis commands ops-budget uses, in memory. Every command yields once, so concurrent callers interleave. */
class FakeOpsRedis implements OpsRedis {
  status = 'ready'
  readonly values = new Map<string, string>()
  readonly ttl = new Map<string, number>()
  private tick = () => new Promise<void>((resolve) => setImmediate(resolve))
  async incrby(key: string, n: number) { await this.tick(); const v = Number(this.values.get(key) ?? 0) + n; this.values.set(key, String(v)); return v }
  async decrby(key: string, n: number) { await this.tick(); const v = Number(this.values.get(key) ?? 0) - n; this.values.set(key, String(v)); return v }
  async expire(key: string, seconds: number) { await this.tick(); this.ttl.set(key, seconds); return 1 }
  async mget(...keys: string[]) { await this.tick(); return keys.map((k) => this.values.get(k) ?? null) }
  async get(key: string) { await this.tick(); return this.values.get(key) ?? null }
  async set(key: string, value: string, mode: 'PX', ms: number) { await this.tick(); this.values.set(key, value); this.ttl.set(key, Math.ceil(ms / 1000)); return 'OK' }
}

const T0 = new Date('2026-10-13T06:25:00Z')
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000)
let redis: FakeOpsRedis

beforeEach(() => { redis = new FakeOpsRedis(); setOpsBudgetRedisForTests(redis) })
afterEach(() => { setOpsBudgetRedisForTests(undefined); vi.unstubAllEnvs() })

describe('the Google Ads operations allowance', () => {
  it('caps: 2,400 a day for Nexus (env can lower it), 100 per account', () => {
    expect(DEFAULT_GLOBAL_DAILY_OPS).toBe(2400)
    expect(ACCOUNT_DAILY_OPS).toBe(100)
    vi.stubEnv('NEXUS_GOOGLE_ADS_DAILY_OPS', '')
    expect(globalOpsCap()).toBe(2400)
    vi.stubEnv('NEXUS_GOOGLE_ADS_DAILY_OPS', '500')
    expect(globalOpsCap()).toBe(500)
    vi.stubEnv('NEXUS_GOOGLE_ADS_DAILY_OPS', 'nonsense')
    expect(globalOpsCap()).toBe(2400)
  })

  it('a daily run reserves its operations in the current hour\'s buckets (25 h TTL)', async () => {
    const r = await reserveOps('1234567890', 14, T0)
    expect(r).toMatchObject({ ok: true, reason: null, ops: 14, usedGlobal: 14, usedAccount: 14, capGlobal: 2400, capAccount: 100, sentence: '' })
    expect(redis.values.get('nexus:gads:ops:2026101306')).toBe('14')
    expect(redis.values.get('nexus:gads:ops:acct:1234567890:2026101306')).toBe('14')
    expect(redis.ttl.get('nexus:gads:ops:2026101306')).toBe(25 * 3600)
  })

  it('the account cap refuses and takes its own share back', async () => {
    expect((await reserveOps('1234567890', 90, T0)).ok).toBe(true)
    const refused = await reserveOps('1234567890', 14, at(5))
    expect(refused).toMatchObject({ ok: false, reason: 'account_cap', ops: 0, usedAccount: 90 })
    expect(refused.sentence).toContain('90 of its 100')
    expect(await opsUsedLast24h('1234567890', at(5))).toEqual({ global: 90, account: 90 })
    // Another account is not held back by this one.
    expect((await reserveOps('1112223334', 14, at(5))).ok).toBe(true)
  })

  it('the global cap counts every account and the connect flow', async () => {
    vi.stubEnv('NEXUS_GOOGLE_ADS_DAILY_OPS', '30')
    expect((await reserveOps('1234567890', 14, T0)).ok).toBe(true)
    expect((await reserveOps(null, 10, T0)).ok).toBe(true) // discovery: no account yet, global only
    const refused = await reserveOps('1112223334', 14, T0)
    expect(refused).toMatchObject({ ok: false, reason: 'global_cap', usedGlobal: 24 })
    expect(await opsUsedLast24h(null, T0)).toEqual({ global: 24, account: null })
  })

  it('a refusal says when the same request first fits again (the oldest hours leave the rolling 24)', async () => {
    vi.stubEnv('NEXUS_GOOGLE_ADS_DAILY_OPS', '30')
    expect((await reserveOps(null, 10, new Date('2026-10-13T02:10:00Z'))).ok).toBe(true) // the 02:00 bucket
    expect((await reserveOps(null, 15, T0)).ok).toBe(true) // the 06:00 bucket
    const refused = await reserveOps(null, 10, at(5))
    // 25 counted + 10 > 30. The 02:00 hour leaves the window at 02:00 tomorrow: then 15 + 10 fits.
    expect(refused).toMatchObject({ ok: false, reason: 'global_cap', retryAt: new Date('2026-10-14T02:00:00Z') })
    // Larger than what the 06:00 hour alone leaves room for: it fits only when that hour leaves too.
    expect((await reserveOps(null, 20, at(5))).retryAt).toEqual(new Date('2026-10-14T06:00:00Z'))
    // Larger than the cap itself: never.
    expect((await reserveOps(null, 31, at(5))).retryAt).toBeNull()
    expect(await opsUsedLast24h(null, at(5))).toEqual({ global: 25, account: null })
  })

  it('the account cap\'s refusal says when the account has room again', async () => {
    expect((await reserveOps('1234567890', 90, T0)).ok).toBe(true)
    expect(await reserveOps('1234567890', 14, at(5))).toMatchObject({ reason: 'account_cap', retryAt: new Date('2026-10-14T06:00:00Z') })
  })

  it('rolling 24 hours: an hour\'s operations count until 24 hourly buckets later', async () => {
    await reserveOps('1234567890', 100, T0) // counted in the 06:00 UTC bucket
    expect((await reserveOps('1234567890', 1, new Date('2026-10-14T05:59:00Z'))).reason).toBe('account_cap')
    expect((await reserveOps('1234567890', 1, new Date('2026-10-14T06:00:00Z'))).ok).toBe(true)
  })

  it('operations a run did not spend go back to the hour they were counted in', async () => {
    const r = await reserveOps('1234567890', 14, T0)
    await releaseOps('1234567890', 9, r.reservedAt)
    expect(await opsUsedLast24h('1234567890', at(90))).toEqual({ global: 5, account: 5 })
    await releaseOps('1234567890', 0, r.reservedAt)
    expect(await opsUsedLast24h('1234567890', at(90))).toEqual({ global: 5, account: 5 })
  })

  it('operations spent beyond a reservation are always counted, even over a cap — never refused and given back', async () => {
    const r = await reserveOps('1234567890', 100, T0) // the account's whole allowance
    expect(r.ok).toBe(true)
    await addSpentOps('1234567890', 2, r.reservedAt) // two retries reached Google
    expect(await opsUsedLast24h('1234567890', at(30))).toEqual({ global: 102, account: 102 })
    expect(redis.ttl.get('nexus:gads:ops:acct:1234567890:2026101306')).toBe(25 * 3600)
    // Nothing to add, or Redis down: nothing happens, nothing throws.
    await addSpentOps('1234567890', 0, r.reservedAt)
    setOpsBudgetRedisForTests(null)
    await expect(addSpentOps('1234567890', 3, r.reservedAt)).resolves.toBeUndefined()
    setOpsBudgetRedisForTests(redis)
    expect(await opsUsedLast24h('1234567890', at(30))).toEqual({ global: 102, account: 102 })
    // The next reservation waits until the overspend leaves the rolling 24 hours.
    expect((await reserveOps('1234567890', 1, at(30))).reason).toBe('account_cap')
  })

  it('Google said the allowance is used up: every reservation is refused for an hour', async () => {
    await markQuotaExhausted(T0)
    const refused = await reserveOps('1234567890', 14, at(30))
    expect(refused).toMatchObject({ ok: false, reason: 'quota_exhausted', exhaustedUntil: at(60), retryAt: at(60) })
    expect(refused.sentence).toContain('used up')
    expect(redis.ttl.get('nexus:gads:quota-exhausted')).toBe(3600)
    expect((await reserveOps('1234567890', 14, at(61))).ok).toBe(true)
  })

  it('Redis down = refused, never "allowed because nobody counted"', async () => {
    setOpsBudgetRedisForTests(null)
    expect(await reserveOps('1234567890', 14, T0)).toMatchObject({ ok: false, reason: 'redis_unavailable', ops: 0 })
    redis.status = 'end'
    setOpsBudgetRedisForTests(redis)
    expect((await reserveOps('1234567890', 14, T0)).reason).toBe('redis_unavailable')
    redis.status = 'ready'
    redis.incrby = async () => { throw new Error('connection lost') }
    expect((await reserveOps('1234567890', 14, T0)).reason).toBe('redis_unavailable')
    expect(await opsUsedLast24h('1234567890', T0)).toEqual({ global: 0, account: 0 })
  })

  it('Redis that does not answer in 3 s counts as down', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      redis.get = () => new Promise(() => {}) // a reconnecting ioredis queues the command forever
      const pending = reserveOps('1234567890', 14, T0)
      await vi.advanceTimersByTimeAsync(3000)
      expect((await pending).reason).toBe('redis_unavailable')
    } finally {
      vi.useRealTimers()
    }
  })

  it('two reservations racing at the cap never overspend it', async () => {
    const [a, b] = await Promise.all([reserveOps('1234567890', 60, T0), reserveOps('1234567890', 60, T0)])
    expect([a.ok, b.ok].filter(Boolean).length).toBeLessThanOrEqual(1)
    const used = await opsUsedLast24h('1234567890', T0)
    expect(used?.account).toBeLessThanOrEqual(100)
    expect(used?.account).toBe((a.ok ? 60 : 0) + (b.ok ? 60 : 0))
  })

  it('nothing to reserve is always fine and counts nothing', async () => {
    expect(await reserveOps('1234567890', 0, T0)).toMatchObject({ ok: true, ops: 0 })
    expect(redis.values.size).toBe(0)
  })
})

describe('Google Ads changes (2026-10-15): the account\'s change allowance', () => {
  it('a change draws on its own per-account allowance (2,000), inside the global cap; the read allowance is untouched', async () => {
    expect(WRITE_ACCOUNT_DAILY_OPS).toBe(2000)
    const write = await reserveOps('111', 450, T0, 'write')
    expect(write).toMatchObject({ ok: true, ops: 450, usedAccount: 450, capAccount: 2000 })
    // The daily read of the same account still has its own 100.
    expect(await reserveOps('111', 22, at(1))).toMatchObject({ ok: true, usedAccount: 22, capAccount: 100 })
    // Both count against the global cap.
    expect(await opsUsedLast24h(null, at(2))).toEqual({ global: 472, account: null })
  })

  it('refused past the change allowance, in words about a change (nothing checked or sent)', async () => {
    expect(await reserveOps('111', 1900, T0, 'write')).toMatchObject({ ok: true })
    const refused = await reserveOps('111', 200, at(1), 'write')
    expect(refused).toMatchObject({ ok: false, reason: 'account_cap', usedAccount: 1900, capAccount: 2000 })
    expect(refused.sentence).toMatch(/^The Google Ads change is not checked or sent: this account has used 1900 of its 2000 Google Ads change operations/)
  })

  it('release and spent-beyond go back to the change allowance they came from', async () => {
    const r = await reserveOps('111', 100, T0, 'write')
    await releaseOps('111', 40, r.reservedAt, 'write')
    await addSpentOps('111', 5, r.reservedAt, 'write')
    expect(await reserveOps('111', 1935, at(1), 'write')).toMatchObject({ ok: true, usedAccount: 2000 })
    expect(await reserveOps('111', 1, at(2), 'write')).toMatchObject({ ok: false, reason: 'account_cap' })
  })
})

describe('Programme 2, G1 review (2026-10-15): the live read tools\' own allowance', () => {
  it('live reads draw on their own 600 per account, inside the global cap; the change allowance is untouched', async () => {
    expect(LIVE_ACCOUNT_DAILY_OPS).toBe(600)
    expect(await reserveOps('111', 600, T0, 'live')).toMatchObject({ ok: true, usedAccount: 600, capAccount: 600 })
    const refused = await reserveOps('111', 1, at(1), 'live')
    expect(refused).toMatchObject({ ok: false, reason: 'account_cap', usedAccount: 600, capAccount: 600 })
    expect(refused.sentence).toMatch(/^The live Google Ads read is not sent: this account has used 600 of its 600 Google Ads operations for live reads \(their own allowance, so changes and the daily read always have theirs\) in the last 24 hours\. Try again later\.$/)
    // A change and the daily read of the same account still have theirs.
    expect(await reserveOps('111', 1500, at(2), 'write')).toMatchObject({ ok: true, usedAccount: 1500 })
    expect(await reserveOps('111', 22, at(3))).toMatchObject({ ok: true, usedAccount: 22 })
    expect(await opsUsedLast24h(null, at(4))).toEqual({ global: 2122, account: null })
  })
})

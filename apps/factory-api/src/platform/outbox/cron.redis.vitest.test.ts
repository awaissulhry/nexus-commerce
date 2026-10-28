import { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CronConfigError, cronLockKey, defineCron, runTick, startCrons, type CronSettings } from '../../core/cron'
import { assertJobId, QueueConfigError, type Log } from '../../core/queue'
import { testRedis, type TestRedis } from './testing'

/**
 * core/cron.ts on the local Redis (under this file's own prefix), and core/queue.ts's job ids: a clustered
 * cron runs each tick once however many schedulers run it, and not at all when the lock cannot be taken.
 */

const quiet: Log = { info() {}, warn() {}, error() {} }
let redis: TestRedis
let settings: CronSettings

beforeAll(() => {
  redis = testRedis()
  settings = { redis: redis.connect(), prefix: redis.prefix, log: quiet }
})

afterAll(async () => {
  await redis?.cleanup()
})

describe('clustered crons (A1 §3.1; Commerce hard rule 7)', () => {
  it('runs one tick once when two schedulers claim it at the same time', async () => {
    let runs = 0
    const job = defineCron({ name: 'test.once', schedule: '* * * * *', run: async () => void runs++ })
    const at = new Date('2026-10-28T09:01:00.000Z')
    const second: CronSettings = { ...settings, redis: redis.connect(), holder: 'replica-2' }
    const outcomes = await Promise.all([runTick(job, at, settings), runTick(job, at, second)])
    expect(outcomes.sort()).toEqual(['ran', 'taken'])
    expect(runs).toBe(1)
    expect(await settings.redis.pttl(cronLockKey(redis.prefix, 'test.once', at))).toBeGreaterThan(40_000)
    // The next minute is a new tick.
    expect(await runTick(job, new Date('2026-10-28T09:02:00.000Z'), second)).toBe('ran')
    expect(runs).toBe(2)
  })

  it('runs every tick once with two schedulers running the same jobs', async () => {
    const ticks: number[] = []
    const job = defineCron({ name: 'test.every-second', schedule: '* * * * * *', lockTtlMs: 900, run: async ({ scheduledAt }) => void ticks.push(scheduledAt.getTime()) })
    const one = startCrons([job], settings)
    const two = startCrons([job], { ...settings, redis: redis.connect(), holder: 'replica-2' })
    await new Promise((resolve) => setTimeout(resolve, 3_300))
    await Promise.all([one.stop(), two.stop()])
    expect(ticks.length).toBeGreaterThanOrEqual(2)
    expect(new Set(ticks).size).toBe(ticks.length)
  })

  it('fails closed: no Redis, no run', async () => {
    let runs = 0
    const job = defineCron({ name: 'test.no-redis', schedule: '* * * * *', run: async () => void runs++ })
    const down = new Redis('redis://127.0.0.1:1', { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, retryStrategy: () => null })
    const errors: string[] = []
    const log: Log = { ...quiet, error: (_fields, message) => void errors.push(message) }
    try {
      expect(await runTick(job, new Date(), { redis: down, prefix: redis.prefix, log })).toBe('no_lock')
    } finally {
      down.disconnect()
    }
    expect(runs).toBe(0)
    expect(errors).toEqual(['cron tick skipped: the Redis lock is unavailable'])
  })

  it('logs a failed tick and keeps the claim (no second run in that tick)', async () => {
    const job = defineCron({ name: 'test.failing', schedule: '* * * * *', run: async () => { throw new Error('boom') } })
    const at = new Date('2026-10-28T09:05:00.000Z')
    expect(await runTick(job, at, settings)).toBe('failed')
    expect(await runTick(job, at, settings)).toBe('taken')
  })

  it('refuses a bad job, and a job scheduled twice', () => {
    const run = async () => {}
    expect(() => defineCron({ name: 'nodots', schedule: '* * * * *', run })).toThrow(CronConfigError)
    expect(() => defineCron({ name: 'test.bad', schedule: 'every minute', run })).toThrow(/not a node-cron expression/)
    expect(() => defineCron({ name: 'test.ttl', schedule: '* * * * *', lockTtlMs: 5, run })).toThrow(/lockTtlMs/)
    const job = defineCron({ name: 'test.twice', schedule: '* * * * *', run })
    expect(() => startCrons([job, job], settings)).toThrow(/scheduled twice/)
    expect(cronLockKey('w0_12', 'outbox.lag', new Date('2026-10-28T09:00:00.500Z'))).toBe('w0_12:cron:outbox.lag:1793178000')
  })
})

describe('job ids', () => {
  it('takes only deterministic-id shaped job ids', () => {
    expect(assertJobId('0190a000-0000-7000-8000-000000000001')).toBe('0190a000-0000-7000-8000-000000000001')
    expect(assertJobId('sites.audited.0190a000-0000-7000-8000-000000000001')).toMatch(/^sites/)
    for (const bad of ['', 'a:b', ' x', 'x'.repeat(201)]) expect(() => assertJobId(bad), bad).toThrow(QueueConfigError)
  })
})

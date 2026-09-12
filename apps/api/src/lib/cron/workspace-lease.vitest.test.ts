import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'
import { runWorkspaceTick } from './workspace-lease.js'

it('does not start business automation when Redis cannot establish ownership', async () => {
  const work = vi.fn(async () => {})
  expect(await runWorkspaceTick({ status: 'reconnecting', eval: vi.fn() }, 'offline', Date.now(), work)).toBe(false)
  expect(await runWorkspaceTick({ status: 'ready', eval: vi.fn().mockRejectedValue(new Error('connection lost')) }, 'offline', Date.now(), work)).toBe(false)
  expect(work).not.toHaveBeenCalled()
})

// Explicit local/test URL only. Never flush a database or use application credentials.
describe.skipIf(!process.env.NEXUS_TEST_REDIS_URL)('business schedule leases against Redis', () => {
  let redis: Redis
  const prefix = `test:${randomUUID()}`
  const names = ['shared', 'other', 'failure', 'renewal'].map(name => `${prefix}:${name}`)
  beforeAll(async () => {
    redis = new Redis(process.env.NEXUS_TEST_REDIS_URL!, { lazyConnect: true, maxRetriesPerRequest: 1 })
    await redis.connect()
  })
  afterAll(async () => {
    if (redis?.status === 'ready') await redis.del(...names.flatMap(name => [`{nexus:cron:workspace:${name}}:last`, `{nexus:cron:workspace:${name}}:lease`]))
    redis?.disconnect()
  })

  it('serializes competing replicas while allowing another business to work', async () => {
    const work = vi.fn(async () => {})
    expect((await Promise.all(Array.from({ length: 8 }, () => runWorkspaceTick(redis, names[0], 120_000, work)))).filter(Boolean)).toHaveLength(1)
    expect(work).toHaveBeenCalledTimes(1)
    expect(await runWorkspaceTick(redis, names[0], 179_000, work)).toBe(false)
    expect(await runWorkspaceTick(redis, names[1], 120_000, work)).toBe(true)
    expect(await runWorkspaceTick(redis, names[0], 180_000, work)).toBe(true)
  })

  it('releases a failed execution without allowing its tick to run twice', async () => {
    await expect(runWorkspaceTick(redis, names[2], 120_000, async () => { throw new Error('provider unavailable') })).rejects.toThrow('provider unavailable')
    expect(await redis.exists(`{nexus:cron:workspace:${names[2]}}:lease`)).toBe(0)
    expect(await runWorkspaceTick(redis, names[2], 120_000, async () => {})).toBe(false)
    expect(await runWorkspaceTick(redis, names[2], 180_000, async () => {})).toBe(true)
  })

  it('renews long work and prevents a following tick from overlapping it', async () => {
    await runWorkspaceTick(redis, names[3], 120_000, async () => {
      await new Promise(resolve => setTimeout(resolve, 22_000))
      expect(await redis.pttl(`{nexus:cron:workspace:${names[3]}}:lease`)).toBeGreaterThan(80_000)
      expect(await runWorkspaceTick(redis, names[3], 180_000, async () => {})).toBe(false)
    })
    expect(await runWorkspaceTick(redis, names[3], 180_000, async () => {})).toBe(true)
  }, 30_000)
})

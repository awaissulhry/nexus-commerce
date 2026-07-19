/**
 * IM.2 P5 — addJobSafely: the enqueue guard that makes a hung Redis
 * `Queue.add()` impossible to hang a request. We fake a Queue with a
 * controllable `add()` so no Redis is needed.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { addJobSafely, resetEnqueueCircuitForTests, resolveRedisTarget } from './queue.js'

function fakeQueue(add: (name: string, data: unknown, opts?: unknown) => Promise<unknown>) {
  return { name: 'test-queue', add } as any
}

// RT.1 — addJobSafely now short-circuits when workers are disabled; these
// tests exercise the enqueue path itself, so run them with workers "on".
let savedWorkersFlag: string | undefined
beforeAll(() => {
  savedWorkersFlag = process.env.ENABLE_QUEUE_WORKERS
  process.env.ENABLE_QUEUE_WORKERS = '1'
})
afterAll(() => {
  if (savedWorkersFlag === undefined) delete process.env.ENABLE_QUEUE_WORKERS
  else process.env.ENABLE_QUEUE_WORKERS = savedWorkersFlag
})

describe('IM.2 P5 — addJobSafely', () => {
  beforeEach(() => resetEnqueueCircuitForTests())

  it('returns enqueued=true when add() resolves in time', async () => {
    const q = fakeQueue(async () => ({ id: 'job1' }))
    const r = await addJobSafely(q, 'sync-job', { queueId: 'q1' }, { jobId: 'q1' }, 500)
    expect(r).toEqual({ enqueued: true })
  })

  it('does NOT hang when add() never resolves — times out and opens the circuit', async () => {
    // add() returns a promise that never settles — the exact prod failure mode.
    const q = fakeQueue(() => new Promise<never>(() => {}))
    const start = Date.now()
    const r = await addJobSafely(q, 'sync-job', { queueId: 'q1' }, { jobId: 'q1' }, 80)
    const elapsed = Date.now() - start
    expect(r.enqueued).toBe(false)
    expect(r.timedOut).toBe(true)
    // Bounded: returned near the timeout, not hung.
    expect(elapsed).toBeLessThan(1000)
  })

  it('opens a circuit after a timeout so subsequent adds skip instantly', async () => {
    const hang = fakeQueue(() => new Promise<never>(() => {}))
    await addJobSafely(hang, 'sync-job', { queueId: 'q1' }, undefined, 50) // trips the circuit

    let called = false
    const wouldWork = fakeQueue(async () => { called = true; return { id: 'x' } })
    const start = Date.now()
    const r = await addJobSafely(wouldWork, 'sync-job', { queueId: 'q2' }, undefined, 50)
    const elapsed = Date.now() - start
    expect(r).toEqual({ enqueued: false, skipped: true })
    expect(called).toBe(false)      // add() never attempted while circuit open
    expect(elapsed).toBeLessThan(20) // returns immediately, no timeout wait
  })

  it('reports error (not hang) when add() rejects', async () => {
    const q = fakeQueue(async () => { throw new Error('ECONNREFUSED') })
    const r = await addJobSafely(q, 'sync-job', { queueId: 'q1' }, undefined, 500)
    expect(r.enqueued).toBe(false)
    expect(r.error).toContain('ECONNREFUSED')
  })

  it('a resolving add() after reset closes the circuit path again', async () => {
    resetEnqueueCircuitForTests()
    const q = fakeQueue(async () => ({ id: 'ok' }))
    const r = await addJobSafely(q, 'sync-job', {}, undefined, 200)
    expect(r.enqueued).toBe(true)
  })

  it('RT.1 — workers disabled ⇒ skip instantly, add() never attempted', async () => {
    const saved = process.env.ENABLE_QUEUE_WORKERS
    delete process.env.ENABLE_QUEUE_WORKERS
    try {
      let called = false
      const q = fakeQueue(async () => { called = true; return { id: 'x' } })
      const start = Date.now()
      const r = await addJobSafely(q, 'sync-job', { queueId: 'q1' }, undefined, 500)
      expect(r).toEqual({ enqueued: false, skipped: true, workersOff: true })
      expect(called).toBe(false)
      expect(Date.now() - start).toBeLessThan(20)
    } finally {
      process.env.ENABLE_QUEUE_WORKERS = saved ?? '1'
    }
  })
})

describe('RT.1 — resolveRedisTarget (the ioredis-url fix)', () => {
  it('rediss:// URL → positional-url target WITH tls', () => {
    const t = resolveRedisTarget({ REDIS_URL: 'rediss://default:pw@host.upstash.io:6379' })
    expect(t.kind).toBe('url')
    if (t.kind !== 'url') return
    expect(t.url).toBe('rediss://default:pw@host.upstash.io:6379')
    expect(t.options.tls).toEqual({ rejectUnauthorized: false })
    expect(t.options.maxRetriesPerRequest).toBeNull()
  })

  it('redis:// URL is HONORED (the old code silently ignored it → localhost)', () => {
    const t = resolveRedisTarget({ REDIS_URL: 'redis://default:pw@redis.railway.internal:6379' })
    expect(t.kind).toBe('url')
    if (t.kind !== 'url') return
    expect(t.url).toContain('redis.railway.internal')
    expect(t.options.tls).toBeUndefined() // plain redis:// — no TLS wrapper
  })

  it('no REDIS_URL → host/port fallback (localhost default)', () => {
    const t = resolveRedisTarget({})
    expect(t).toEqual({
      kind: 'host-port', host: 'localhost', port: 6379,
      options: { maxRetriesPerRequest: null, enableReadyCheck: false },
    })
  })

  it('REDIS_HOST/REDIS_PORT respected when no URL', () => {
    const t = resolveRedisTarget({ REDIS_HOST: 'redis.internal', REDIS_PORT: '6380' })
    expect(t.kind).toBe('host-port')
    if (t.kind !== 'host-port') return
    expect(t.host).toBe('redis.internal')
    expect(t.port).toBe(6380)
  })
})

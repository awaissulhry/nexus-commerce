/**
 * IM.2 P5 — addJobSafely: the enqueue guard that makes a hung Redis
 * `Queue.add()` impossible to hang a request. We fake a Queue with a
 * controllable `add()` so no Redis is needed.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { addJobSafely, resetEnqueueCircuitForTests } from './queue.js'

function fakeQueue(add: (name: string, data: unknown, opts?: unknown) => Promise<unknown>) {
  return { name: 'test-queue', add } as any
}

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
})

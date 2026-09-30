/**
 * 2026-09-30 — the wiring: the Etsy listing lock takes its lease from the SAME Redis the queue opens (`lib/queue.ts`
 * registers it, as it does for the gateway's rate buckets), in a process that has loaded the queue — and in one that
 * has not yet, where the lock loads it. A lock with no Redis would defer every Etsy stock and price write forever.
 * `ioredis` and the queue classes are stand-ins here: nothing connects anywhere.
 */
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ clients: [] as unknown[] }))
vi.mock('ioredis', async () => {
  const { FakeLeaseRedis } = await import('../../test-support/fake-lease-redis.js')
  class StandInRedis extends FakeLeaseRedis { constructor() { super(); h.clients.push(this) } on() { return this } }
  return { default: StandInRedis, Redis: StandInRedis }
})
vi.mock('bullmq', () => ({ QueueEvents: class { on() { return this } }, Queue: class { on() { return this } }, Worker: class {} }))
vi.mock('../../lib/workspace-jobs.js', () => ({ WorkspaceQueue: class { on() { return this } } }))

import { withEtsyListingLock } from './listing-lock.js'

describe('the Etsy listing lock and the queue\'s Redis', () => {
  it('with no store given, the lock loads the queue module and leases on the Redis connection it opened', async () => {
    let ran = false
    await withEtsyListingLock({ accountId: 'test-acct', listingId: '1000000001' }, async () => { ran = true })
    expect(ran).toBe(true)
    // Exactly the queue's one connection, and the lease went through it: taken, then released.
    expect(h.clients).toHaveLength(1)
    const log = (h.clients[0] as { log: string[] }).log
    expect(log[0]).toBe('SET {nexus:etsy:inventory}:test-acct:1000000001')
    expect(log.at(-1)).toBe('RELEASE {nexus:etsy:inventory}:test-acct:1000000001')
  })
})

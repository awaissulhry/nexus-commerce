/**
 * P1.3 — per-account concurrency in the outbound worker: an account with 2 jobs running postpones its
 * next job (BullMQ's delayed move, not a failure); another account is not held up; a finished job frees
 * its slot; a row without an account, or a call outside a worker, is not limited.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DelayedError } from 'bullmq'

const h = vi.hoisted(() => ({ accountOf: {} as Record<string, string | null> }))
vi.mock('@nexus/database', async (original) => ({
  ...(await original<object>()),
  prisma: { outboundSyncQueue: { findUnique: vi.fn(async ({ where }: any) => ({ channelConnectionId: h.accountOf[where.id] ?? null })) } },
}))
vi.mock('../lib/queue.js', () => ({ redis: { connection: null } }))

import { __accountSlotsTest, takeAccountSlot } from './bullmq-sync.worker.js'

const job = (queueId: string) => ({ data: { queueId }, moveToDelayed: vi.fn(async () => {}) }) as any

beforeEach(() => { __accountSlotsTest.reset(); h.accountOf = { a1: 'acct-A', a2: 'acct-A', a3: 'acct-A', b1: 'acct-B', n1: null } })

describe('P1.3 — per-account slots', () => {
  it('two jobs of one account run; the third is postponed (delayed, not failed); another account goes on', async () => {
    const r1 = await takeAccountSlot(job('a1'), 'tok')
    const r2 = await takeAccountSlot(job('a2'), 'tok')
    const third = job('a3')
    await expect(takeAccountSlot(third, 'tok')).rejects.toBeInstanceOf(DelayedError)
    expect(third.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'tok')
    expect(await takeAccountSlot(job('b1'), 'tok')).toBeTypeOf('function')
    r1!(); r1!()
    expect(__accountSlotsTest.running('acct-A')).toBe(1)
    expect(await takeAccountSlot(job('a3'), 'tok')).toBeTypeOf('function')
    r2!()
  })
  it('the limit is set by NEXUS_OUTBOUND_ACCOUNT_CONCURRENCY', async () => {
    vi.stubEnv('NEXUS_OUTBOUND_ACCOUNT_CONCURRENCY', '1')
    await takeAccountSlot(job('a1'), 'tok')
    await expect(takeAccountSlot(job('a2'), 'tok')).rejects.toBeInstanceOf(DelayedError)
    vi.unstubAllEnvs()
  })
  it('no account on the row, or no worker token → not limited', async () => {
    expect(await takeAccountSlot(job('n1'), 'tok')).toBeNull()
    expect(await takeAccountSlot(job('a1'), undefined)).toBeNull()
  })
})

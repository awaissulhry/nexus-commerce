/**
 * A2 — exactly-once per-job queue. processSingle processes ONLY its own row (no
 * table drain), honors the guards, and the cron's skip predicate lets it act as a
 * backstop (skip rows a live BullMQ job owns). Amazon publishing is gated by
 * default (NEXUS_ENABLE_AMAZON_PUBLISH unset → 'gated'), so dispatch returns a
 * synthetic FAILED with no network — enough to prove the row was dispatched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const db = vi.hoisted(() => ({
  outboundSyncQueue: {
    findUnique: vi.fn(),
    findMany: vi.fn(async () => [] as any[]),
    update: vi.fn(async () => ({})),
  },
}))
vi.mock('../db.js', () => ({ default: db }))
vi.mock('./channel-publish-audit.service.js', () => ({
  writeAttemptLog: vi.fn(),
  digestPayload: () => 'digest',
}))

import outboundSync from './outbound-sync.service.js'

beforeEach(() => {
  db.outboundSyncQueue.findUnique.mockReset()
  db.outboundSyncQueue.findMany.mockReset().mockResolvedValue([])
  db.outboundSyncQueue.update.mockReset().mockResolvedValue({})
  delete process.env.NEXUS_ENABLE_AMAZON_PUBLISH // → Amazon gate = 'gated'
})

const inProgressUpdates = () =>
  db.outboundSyncQueue.update.mock.calls.filter((c: any) => c[0]?.data?.syncStatus === 'IN_PROGRESS')

describe('A2.1 — processSingle touches only its own row', () => {
  it('not-found → FAILED, no IN_PROGRESS update, no table drain', async () => {
    db.outboundSyncQueue.findUnique.mockResolvedValue(null)
    const r = await outboundSync.processSingle('Q1')
    expect(r.success).toBe(false)
    expect(r.error).toBe('queue-row-not-found')
    expect(inProgressUpdates().length).toBe(0)
    expect(db.outboundSyncQueue.findMany).not.toHaveBeenCalled() // never drains the table
  })

  it('cancelled → SKIPPED, never dispatched', async () => {
    db.outboundSyncQueue.findUnique.mockResolvedValue({ id: 'Q1', syncStatus: 'CANCELLED', targetChannel: 'AMAZON' })
    const r = await outboundSync.processSingle('Q1')
    expect(r.status).toBe('SKIPPED')
    expect(inProgressUpdates().length).toBe(0)
  })

  it('not-PENDING → SKIPPED', async () => {
    db.outboundSyncQueue.findUnique.mockResolvedValue({ id: 'Q1', syncStatus: 'SUCCESS', targetChannel: 'AMAZON' })
    expect((await outboundSync.processSingle('Q1')).status).toBe('SKIPPED')
  })

  it('still-held → SKIPPED (does not process before the grace window)', async () => {
    db.outboundSyncQueue.findUnique.mockResolvedValue({
      id: 'Q1', syncStatus: 'PENDING', targetChannel: 'AMAZON',
      holdUntil: new Date(Date.now() + 60_000),
    })
    expect((await outboundSync.processSingle('Q1')).status).toBe('SKIPPED')
    expect(inProgressUpdates().length).toBe(0)
  })

  it('PENDING Amazon → marks ONLY this row IN_PROGRESS + dispatches it (gated)', async () => {
    db.outboundSyncQueue.findUnique.mockResolvedValue({
      id: 'Q1', syncStatus: 'PENDING', targetChannel: 'AMAZON',
      product: { sku: 'X', id: 'p1' }, payload: { price: 10 },
    })
    const r = await outboundSync.processSingle('Q1')
    expect(db.outboundSyncQueue.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'Q1' } }))
    expect(inProgressUpdates().some((c: any) => c[0].where.id === 'Q1')).toBe(true)
    expect(db.outboundSyncQueue.findMany).not.toHaveBeenCalled() // ONLY this row, no drain
    expect(r.channel).toBe('AMAZON')
    expect(r.success).toBe(false) // gated, no network
  })
})

describe('A2.3 — cron skip predicate (backstop)', () => {
  it('skips rows a live BullMQ job owns — none dispatched', async () => {
    db.outboundSyncQueue.findMany
      .mockResolvedValueOnce([
        { id: 'A', syncStatus: 'PENDING', targetChannel: 'AMAZON', product: {} },
        { id: 'B', syncStatus: 'PENDING', targetChannel: 'AMAZON', product: {} },
      ])
      .mockResolvedValueOnce([]) // retry items
    const skip = vi.fn(async () => true)
    const stats = await outboundSync.processPendingSyncs({ skip })
    expect(skip).toHaveBeenCalledTimes(2)
    expect(stats.skipped).toBe(2)
    expect(inProgressUpdates().length).toBe(0) // nothing processed
  })
})

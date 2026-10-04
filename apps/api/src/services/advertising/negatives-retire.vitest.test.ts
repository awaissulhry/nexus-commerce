/**
 * 5f — a failed or skipped retire can be retried.
 *
 * `retiredAt` is stamped when the archive is QUEUED (`negatives-retire.service.ts`, after
 * `updateAdTargetWithSync` returns), not when Amazon accepts it. When the write gate skips the
 * write or Amazon rejects it, the next sync heals the row back to ENABLED — and the old check
 * `if (row.retiredAt) skip` then refused every later retire of a negative that is still live at
 * Amazon. The decision is now made on status: ARCHIVED is skipped, anything else is retired.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }))
vi.mock('../../db.js', () => ({
  default: {
    adTarget: {
      findMany: vi.fn(async () => h.rows),
      update: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
    },
  },
}))
vi.mock('./ads-mutation.service.js', () => ({
  updateAdTargetWithSync: vi.fn(),
  writeAdvertisingActionLog: vi.fn(async () => 'log-local'),
}))
vi.mock('./negatives.service.js', () => ({
  getTermContext: vi.fn(async () => null),
  normaliseNegTerm: (t: string) => t.trim().toLowerCase(),
}))

import prisma from '../../db.js'
import { updateAdTargetWithSync } from './ads-mutation.service.js'
import { retireNegatives, RETIRE_ACTION_TYPE } from './negatives-retire.service.js'

const sync = vi.mocked(updateAdTargetWithSync)
const update = vi.mocked(prisma.adTarget.update)

const row = (over: Record<string, unknown>) => ({
  id: 'neg-1', expressionValue: 'cheap gloves', status: 'ENABLED', externalTargetId: 'ext-1',
  negativeLevel: 'AD_GROUP', retiredAt: null,
  adGroup: { name: 'AG', campaign: { name: 'Camp', marketplace: 'IT' } },
  ...over,
})
const retire = () => retireNegatives({ adTargetIds: h.rows.map((r) => String(r.id)), actor: 'user:test', retireReason: 'test' })

beforeEach(() => {
  vi.clearAllMocks()
  h.rows = []
  sync.mockResolvedValue({ ok: true, outboundQueueId: 'q-2', bidHistoryIds: [], actionLogId: 'log-2', error: null })
})

describe('5f retireNegatives decides on status, not on retiredAt alone', () => {
  it('🔴 a negative whose earlier retire failed (retiredAt set, the sync healed it back to ENABLED) is retired again', async () => {
    h.rows = [row({ retiredAt: new Date('2026-09-30T10:00:00Z'), status: 'ENABLED' })]
    const { outcomes, summary } = await retire()

    expect(sync).toHaveBeenCalledTimes(1)
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({
      adTargetId: 'neg-1', patch: { status: 'ARCHIVED' }, actionType: RETIRE_ACTION_TYPE, applyImmediately: true,
    }))
    expect(outcomes[0]).toMatchObject({ kind: 'retired', delivery: 'enqueued', outboundQueueId: 'q-2' })
    expect(summary).toMatchObject({ retired: 1, skipped: 0 })
    // The new attempt re-stamps the row, so `retiredAt` dates the attempt that is now in flight.
    expect(update).toHaveBeenCalledWith({ where: { id: 'neg-1' }, data: { retiredAt: expect.any(Date), retireReason: 'test' } })
    expect((update.mock.calls[0][0] as { data: { retiredAt: Date } }).data.retiredAt.getTime()).toBeGreaterThan(Date.parse('2026-09-30T10:00:00Z'))
  })

  it('a PAUSED negative with a stale retiredAt is retired too — only ARCHIVED blocks', async () => {
    h.rows = [row({ retiredAt: new Date('2026-09-30T10:00:00Z'), status: 'PAUSED' })]
    const { outcomes } = await retire()
    expect(sync).toHaveBeenCalledTimes(1)
    expect(outcomes[0].kind).toBe('retired')
  })

  it('a negative we retired that is ARCHIVED is skipped, and says it was retired here', async () => {
    h.rows = [row({ retiredAt: new Date('2026-09-30T10:00:00Z'), status: 'ARCHIVED' })]
    const { outcomes } = await retire()
    expect(sync).not.toHaveBeenCalled()
    expect(outcomes[0]).toMatchObject({ kind: 'skipped', delivery: 'not_applicable', reason: 'already retired here on 2026-09-30' })
  })

  it('a negative archived at Amazon by someone else is still skipped as mirrored in', async () => {
    h.rows = [row({ status: 'ARCHIVED' })]
    const { outcomes } = await retire()
    expect(sync).not.toHaveBeenCalled()
    expect(outcomes[0]).toMatchObject({ kind: 'skipped', reason: expect.stringMatching(/already archived at Amazon/) })
  })

  it('a first retire of a live negative is unchanged', async () => {
    h.rows = [row({})]
    const { outcomes } = await retire()
    expect(sync).toHaveBeenCalledTimes(1)
    expect(outcomes[0]).toMatchObject({ kind: 'retired', delivery: 'enqueued' })
  })
})

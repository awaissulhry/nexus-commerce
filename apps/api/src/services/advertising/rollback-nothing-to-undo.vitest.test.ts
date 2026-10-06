/**
 * CM-22 — an Undo that changed nothing says "Nothing to undo", never "reversed".
 *
 * `reverseOne` answers `{ ok: true, skipped: true }` for a row whose before and after values are the same (or that has
 * no placement record to restore). The single-row Undo counted that as reversed (`reversed: 1`) and marked the row
 * undone; the change-set and rule paths counted it as skipped but answered with no reason at all. A rename and a
 * portfolio move were such rows too: the campaign Undo did not read `name` / `portfolioId` from the before values.
 *
 * Prisma and the write service are stand-ins: what is checked is the counting, the words and what is sent back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  logs: new Map<string, Record<string, unknown>>(),
  updates: [] as Array<{ id: string; data: Record<string, unknown> }>,
}))
vi.mock('../../db.js', () => ({
  default: {
    advertisingActionLog: {
      findUnique: async ({ where }: { where: { id: string } }) => db.logs.get(where.id) ?? null,
      findMany: async ({ where }: { where: { executionId?: string } }) =>
        [...db.logs.values()].filter((l) => l.executionId === where.executionId && l.rolledBackAt == null),
      count: async () => 0,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        db.updates.push({ id: where.id, data })
        return { ...db.logs.get(where.id), ...data }
      },
    },
  },
}))
const writes = vi.hoisted(() => ({ campaign: [] as Array<Record<string, unknown>> }))
vi.mock('./ads-mutation.service.js', () => ({
  updateCampaignWithSync: async (args: { patch: Record<string, unknown> }) => {
    writes.campaign.push(args.patch)
    return { ok: true, outboundQueueId: 'q1', bidHistoryIds: [], actionLogId: 'a2', error: null }
  },
  updateAdGroupWithSync: async () => ({ ok: true }),
  updateAdTargetWithSync: async () => ({ ok: true }),
}))

import { rollbackByActionLogId, rollbackByChangeSetId } from './rollback.service.js'

const campaignLog = (id: string, before: Record<string, unknown>, after: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id, actionType: 'AD_BUDGET_UPDATE', entityType: 'CAMPAIGN', entityId: 'camp-1', userId: 'user:test',
  payloadBefore: before, payloadAfter: after, createdAt: new Date(), rolledBackAt: null, amazonResponseStatus: 'SUCCESS',
  executionId: null, ...extra,
})
const same = { name: 'Camp A', portfolioId: null, dailyBudget: 10, dailyBudgetCurrency: 'EUR', status: 'ENABLED', biddingStrategy: 'LEGACY_FOR_SALES', endDate: null }

beforeEach(() => { db.logs.clear(); db.updates.length = 0; writes.campaign.length = 0 })

describe('CM-22 — a no-op is "Nothing to undo"', () => {
  it('one row whose values did not change: skipped, not reversed, not marked undone, and the reason says so', async () => {
    db.logs.set('l1', campaignLog('l1', same, { ...same }))
    const out = await rollbackByActionLogId({ actionLogId: 'l1', actor: 'user:test' as never, reason: 'Undo: test', manual: true })
    expect(out.reversed).toBe(0)
    expect(out.skipped).toBe(1)
    expect(out.failed).toBe(0)
    expect(out.ok).toBe(true)
    expect(out.nothingToUndo).toBe(true)
    expect(out.reason).toMatch(/^Nothing to undo: /)
    expect(out.details).toEqual([expect.objectContaining({ actionLogId: 'l1', outcome: 'SKIPPED' })])
    expect(db.updates).toEqual([]) // not stamped rolledBackAt
    expect(writes.campaign).toEqual([]) // nothing sent
  })

  it('a placement change with no record of the placements before: nothing to undo, with that reason', async () => {
    db.logs.set('l2', campaignLog('l2', {}, {}, { actionType: 'update_placement_bidding' }))
    const out = await rollbackByActionLogId({ actionLogId: 'l2', actor: 'user:test' as never, reason: 'Undo: test' })
    expect(out.reversed).toBe(0)
    expect(out.nothingToUndo).toBe(true)
    expect(out.reason).toContain('no record of the placements')
    expect(db.updates).toEqual([])
  })

  it('a real change is still reversed and marked undone', async () => {
    db.logs.set('l3', campaignLog('l3', same, { ...same, dailyBudget: 25 }))
    const out = await rollbackByActionLogId({ actionLogId: 'l3', actor: 'user:test' as never, reason: 'Undo: test' })
    expect(out.reversed).toBe(1)
    expect(out.nothingToUndo).toBeUndefined()
    expect(out.reason).toBeUndefined()
    expect(writes.campaign).toEqual([{ dailyBudget: 10 }])
    expect(db.updates.map((u) => u.id)).toEqual(['l3'])
  })

  it('a change set whose rows were all no-ops answers "Nothing to undo" (it answered nothing before)', async () => {
    db.logs.set('s1', campaignLog('s1', same, { ...same }, { executionId: 'set-1' }))
    db.logs.set('s2', campaignLog('s2', same, { ...same }, { executionId: 'set-1' }))
    const out = await rollbackByChangeSetId({ changeSetId: 'set-1', actor: 'user:test' as never, reason: 'Undo: test' })
    expect(out.reversed).toBe(0)
    expect(out.skipped).toBe(2)
    expect(out.nothingToUndo).toBe(true)
    expect(out.reason).toMatch(/^Nothing to undo: the values before and after/)
  })
})

describe('CM-22 — a rename and a portfolio move can be undone', () => {
  it('puts the old name back', async () => {
    db.logs.set('r1', campaignLog('r1', same, { ...same, name: 'Camp B' }, { actionType: 'AD_CAMPAIGN_NAME_UPDATE' }))
    const out = await rollbackByActionLogId({ actionLogId: 'r1', actor: 'user:test' as never, reason: 'Undo: test' })
    expect(out.reversed).toBe(1)
    expect(writes.campaign).toEqual([{ name: 'Camp A' }])
  })

  it('puts the old portfolio back, and "no portfolio" back as no portfolio', async () => {
    db.logs.set('p1', campaignLog('p1', { ...same, portfolioId: 'pf-1' }, { ...same, portfolioId: 'pf-2' }, { actionType: 'AD_CAMPAIGN_PORTFOLIO_UPDATE' }))
    db.logs.set('p2', campaignLog('p2', same, { ...same, portfolioId: 'pf-2' }, { actionType: 'AD_CAMPAIGN_PORTFOLIO_UPDATE' }))
    await rollbackByActionLogId({ actionLogId: 'p1', actor: 'user:test' as never, reason: 'Undo: test' })
    await rollbackByActionLogId({ actionLogId: 'p2', actor: 'user:test' as never, reason: 'Undo: test' })
    expect(writes.campaign).toEqual([{ portfolioId: 'pf-1' }, { portfolioId: null }])
  })
})

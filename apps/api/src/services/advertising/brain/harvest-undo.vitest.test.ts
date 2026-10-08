/**
 * Batch 2 fix — AB-11's side of auto-undo's harvest pass (brain/harvest-undo.ts), the shape AB-15's HarvestUndoProvider
 * reads: the brain's own pairs and their judgements, the pair put back as auto-undo (UNDONE, AB-11's own waiting undo
 * request withdrawn), AB-11's undo request, and whether it was put back. The writes and the database are stubs (the pair
 * itself: harvest-write.vitest.test.ts; the real path: harvest-postgres). Every value is made up (public repo).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  record: { status: 'UNDO_PROPOSED', undoApprovalId: 'ap-undo' } as Record<string, unknown> | null,
  undo: vi.fn(),
  marked: vi.fn(),
  withdrawn: vi.fn(async (_a: unknown) => ({ count: 1 })),
  propose: vi.fn(async (_id: string, _why: string) => ({ approvalId: 'ap-undo' })),
  findMany: vi.fn(),
}))
vi.mock('../../../db.js', () => ({
  default: {
    adsBrainHarvest: { findMany: (a: unknown) => h.findMany(a), findUnique: vi.fn(async () => h.record) },
    agentApproval: { updateMany: (a: unknown) => h.withdrawn(a) },
  },
}))
vi.mock('./harvest-write.js', () => ({ undoHarvest: (...a: unknown[]) => h.undo(...a), proposeUndo: (id: string, why: string) => h.propose(id, why) }))
vi.mock('./harvest-request.js', () => ({ markUndone: (...a: unknown[]) => h.marked(...a) }))

const { harvestUndoProvider, UNDONE_BY_AUTO_UNDO } = await import('./harvest-undo.js')

const LANDED = new Date('2026-09-28T06:00:00Z')
beforeEach(() => {
  h.record = { status: 'UNDO_PROPOSED', undoApprovalId: 'ap-undo' }
  h.undo.mockReset().mockResolvedValue({ paused: true, retired: 2, problems: [], complete: true, actionLogIds: ['log-pause', 'log-n1', 'log-n2'] })
  h.marked.mockReset(); h.withdrawn.mockClear(); h.propose.mockClear()
  h.findMany.mockReset().mockImplementation(async () => h.rows)
  h.rows = [
    { id: 'hv-1', productId: 'p-jacket', marketplace: 'IT', destCampaignId: 'c-exact', term: 'touring jacket', landedAt: LANDED, verdict: 'WORSE', judgement: { why: 'it stopped converting' }, why: 'harvested' },
    { id: 'hv-2', productId: 'p-jacket', marketplace: 'IT', destCampaignId: 'c-exact', term: 'sport jacket', landedAt: LANDED, verdict: null, judgement: null, why: 'harvested, waiting' },
  ]
})

describe('batch 2 fix — the harvest\'s side of auto-undo', () => {
  it('judged: only the pairs the brain wrote itself (no approval), landed since, with AB-11\'s verdict and words', async () => {
    const since = new Date('2026-09-20T00:00:00Z')
    expect(await harvestUndoProvider.judged(since)).toEqual([
      { id: 'hv-1', productId: 'p-jacket', market: 'IT', campaignId: 'c-exact', term: 'touring jacket', landedAt: LANDED, verdict: 'WORSE', why: 'it stopped converting' },
      { id: 'hv-2', productId: 'p-jacket', market: 'IT', campaignId: 'c-exact', term: 'sport jacket', landedAt: LANDED, verdict: 'WAITING', why: 'harvested, waiting' },
    ])
    expect(h.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { approvalId: null, landedAt: { gte: since }, status: { in: ['DONE', 'HALF_DONE', 'UNDO_PROPOSED', 'UNDONE'] } } }))
  })

  it('undo: the pair put back as auto-undo (a safety owner, no change set), marked UNDONE, AB-11\'s own waiting request withdrawn', async () => {
    expect(await harvestUndoProvider.undo('hv-1', { actor: 'automation:auto-undo', reason: 'Auto-undo j1: worse' })).toEqual({ ok: true, actionLogId: 'log-pause' })
    expect(h.undo).toHaveBeenCalledWith('hv-1', { actor: 'automation:auto-undo', manual: false, changeSetId: null, reason: 'Auto-undo j1: worse' })
    expect(h.marked).toHaveBeenCalledWith('hv-1', expect.objectContaining({ approvalId: null, by: 'auto-undo', paused: true, retired: 2 }))
    expect(h.withdrawn).toHaveBeenCalledWith({ where: { id: 'ap-undo', status: 'pending' }, data: expect.objectContaining({ status: 'rejected', reason: UNDONE_BY_AUTO_UNDO }) })
  })

  it('undo refused or with nothing to put back: not marked, the reason said; already undone: not twice', async () => {
    h.undo.mockResolvedValue({ paused: false, retired: 0, problems: ['nothing was put back — the write gate refuses the source negative'], complete: false, actionLogIds: [] })
    expect(await harvestUndoProvider.undo('hv-1', { actor: 'automation:auto-undo', reason: 'x' })).toEqual({ ok: false, reason: 'nothing was put back — the write gate refuses the source negative' })
    expect(h.marked).not.toHaveBeenCalled()
    h.record = { status: 'UNDONE', undoApprovalId: null }
    expect(await harvestUndoProvider.undo('hv-1', { actor: 'automation:auto-undo', reason: 'x' })).toEqual({ ok: false, reason: 'it was put back already' })
    h.record = null
    expect(await harvestUndoProvider.undo('hv-1', { actor: 'automation:auto-undo', reason: 'x' })).toMatchObject({ ok: false })
  })

  it('propose: AB-11\'s own undo request (one per harvest); isUndone: the record says UNDONE', async () => {
    expect(await harvestUndoProvider.propose('hv-1', 'Auto-undo j1: worse')).toEqual({ approvalId: 'ap-undo' })
    expect(h.propose).toHaveBeenCalledWith('hv-1', 'Auto-undo j1: worse')
    h.record = { status: 'UNDONE' }
    expect(await harvestUndoProvider.isUndone('hv-1')).toBe(true)
    h.record = { status: 'DONE' }
    expect(await harvestUndoProvider.isUndone('hv-1')).toBe(false)
  })
})

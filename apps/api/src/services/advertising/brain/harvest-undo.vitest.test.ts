/**
 * Batch 2 fix — auto-undo's side of a harvest (AB-15, brain/harvest-undo.ts) at AUTO: the pair put back through AB-11's
 * undoHarvest as auto-undo, marked UNDONE, and AB-11's own undo request for the same harvest that still waits for a person
 * withdrawn (no second request, no double undo); a harvest a person's approved undo put back meanwhile is not put back
 * again; nothing put back, nothing withdrawn. The writes and the database are stubs (the real path: undo-postgres). Made-up
 * values (public repo).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  record: { status: 'UNDO_PROPOSED' } as { status: string } | null,
  undo: vi.fn(),
  update: vi.fn(async (_a: unknown) => ({})),
  withdraw: vi.fn(async (_a: unknown) => ({ count: 1 })),
}))
vi.mock('../../../db.js', () => ({
  default: {
    adsBrainHarvest: { findUnique: vi.fn(async () => h.record), update: (a: unknown) => h.update(a) },
    agentApproval: { updateMany: (a: unknown) => h.withdraw(a) },
  },
}))
vi.mock('../../../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('./harvest-write.js', () => ({ HARVEST_TOOL: 'apply-brain-harvest', undoHarvest: (...a: unknown[]) => h.undo(...a), proposeUndo: vi.fn() }))

const { harvestUndo, UNDONE_BY_AUTO_UNDO } = await import('./harvest-undo.js')
const RUN = { actor: 'automation:auto-undo', reason: 'Auto-undo j1: it stopped converting' }

beforeEach(() => {
  h.record = { status: 'UNDO_PROPOSED' }
  h.undo.mockReset().mockResolvedValue({ paused: true, retired: 1, problems: [], complete: true, actionLogIds: ['log-pause', 'log-retire'] })
  h.update.mockClear(); h.withdraw.mockClear()
})

describe('batch 2 fix — auto-undo puts a harvest back alone: one undo, never two', () => {
  it('the pair put back as auto-undo, UNDONE in the pair\'s order, and AB-11\'s waiting undo request for the same harvest withdrawn', async () => {
    expect(await harvestUndo.undo('hv-1', RUN)).toEqual({ ok: true, actionLogId: 'log-pause' })
    expect(h.undo).toHaveBeenCalledWith('hv-1', { actor: 'automation:auto-undo', manual: false, changeSetId: null, reason: RUN.reason })
    expect(h.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'hv-1' }, data: expect.objectContaining({ status: 'UNDONE', why: 'put back by auto-undo: 1 source negative retired, the keyword paused' }) }))
    expect(h.withdraw).toHaveBeenCalledWith({
      where: { toolName: 'apply-brain-harvest', status: { in: ['pending', 'scheduled'] }, AND: [{ args: { path: ['harvestId'], equals: 'hv-1' } }, { args: { path: ['op'], equals: 'undo' } }] },
      data: expect.objectContaining({ status: 'rejected', reason: UNDONE_BY_AUTO_UNDO }),
    })
    expect(UNDONE_BY_AUTO_UNDO).toMatch(/^withdrawn:/)
  })

  it('a person\'s approved undo ran first (UNDONE): not put back again, nothing withdrawn', async () => {
    h.record = { status: 'UNDONE' }
    expect(await harvestUndo.undo('hv-1', RUN)).toEqual({ ok: false, reason: 'it was put back already (a person\'s approved undo ran first)' })
    expect(h.undo).not.toHaveBeenCalled()
    expect(h.withdraw).not.toHaveBeenCalled()
  })

  it('nothing put back (the gate refused a half): the harvest stays, AB-11\'s request stays for a person', async () => {
    h.undo.mockResolvedValue({ paused: false, retired: 0, problems: ['nothing was put back — the write gate refuses the source negative'], complete: false, actionLogIds: [] })
    expect(await harvestUndo.undo('hv-1', RUN)).toEqual({ ok: false, reason: 'nothing of the harvest was put back: nothing was put back — the write gate refuses the source negative' })
    expect(h.update).not.toHaveBeenCalled()
    expect(h.withdraw).not.toHaveBeenCalled()
  })
})

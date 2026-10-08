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
  h.undo.mockReset().mockResolvedValue({ paused: true, retired: 1, problems: [], complete: true, actionLogIds: ['log-pause', 'log-retire'], alreadyBack: 0 })
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

  it('put back in part (a negative retired, the keyword left running): not UNDONE, nothing withdrawn, sent again at the next run (batch 2 review fix)', async () => {
    h.undo.mockResolvedValue({ paused: false, retired: 1, problems: ['the keyword was not paused (refused): the term runs in its sources and its exact keyword until the undo is sent again'], complete: false, actionLogIds: ['log-retire'], alreadyBack: 0 })
    const out = await harvestUndo.undo('hv-1', RUN)
    expect(out).toEqual({ ok: false, retry: true, reason: expect.stringMatching(/^the pair was put back in part \(1 source negative retired\); the rest is sent again at the next run: the keyword was not paused/) })
    expect(h.update).toHaveBeenCalledTimes(1)
    const data = (h.update.mock.calls[0][0] as { data: Record<string, unknown> }).data
    expect(data.status).toBeUndefined()
    expect(data.lastError).toMatch(/^auto-undo put back part of the pair \(1 source negative retired\)/)
    expect(h.withdraw).not.toHaveBeenCalled()
    // The next run: the rest goes back, and only now is it UNDONE (AB-11's waiting request withdrawn with it).
    h.undo.mockResolvedValue({ paused: true, retired: 0, problems: [], complete: true, actionLogIds: ['log-pause'], alreadyBack: 1 })
    expect(await harvestUndo.undo('hv-1', RUN)).toEqual({ ok: true, actionLogId: 'log-pause' })
    expect(h.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'UNDONE', why: 'put back by auto-undo: the keyword paused', lastError: null }) }))
    expect(h.withdraw).toHaveBeenCalledTimes(1)
  })

  it('a retry that puts nothing more back while the pair is still half put back: kept open (retry), never closed for good (batch 2 re-review fix)', async () => {
    h.undo.mockResolvedValue({ paused: false, retired: 0, problems: ['the keyword was not paused (refused): the term runs in its sources and its exact keyword until the undo is sent again'], complete: false, actionLogIds: [], alreadyBack: 1 })
    const out = await harvestUndo.undo('hv-1', RUN)
    expect(out).toEqual({ ok: false, retry: true, reason: expect.stringMatching(/^the pair is still half put back \(1 of its halves back already\); nothing more went back this run, so it is sent again at the next run: the keyword was not paused/) })
    const data = (h.update.mock.calls[0][0] as { data: Record<string, unknown> }).data
    expect(data.status).toBeUndefined()
    expect(data.lastError).toMatch(/^auto-undo: the pair is still half put back/)
    expect(h.withdraw).not.toHaveBeenCalled()
  })

  it('nothing put back (the gate refused a half): the harvest stays, AB-11\'s request stays for a person', async () => {
    h.undo.mockResolvedValue({ paused: false, retired: 0, problems: ['nothing was put back — the write gate refuses the source negative'], complete: false, actionLogIds: [], alreadyBack: 0 })
    expect(await harvestUndo.undo('hv-1', RUN)).toEqual({ ok: false, reason: 'nothing of the harvest was put back: nothing was put back — the write gate refuses the source negative' })
    expect(h.update).not.toHaveBeenCalled()
    expect(h.withdraw).not.toHaveBeenCalled()
  })
})

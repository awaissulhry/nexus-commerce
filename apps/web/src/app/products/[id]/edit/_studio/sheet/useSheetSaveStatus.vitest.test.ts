/**
 * P2 (2026-09-30, I4-4) — a writer event that changes no count keeps the sheet's status object: every new object
 * re-rendered the whole sheet (about 60 components) with nothing to show.
 */
import { describe, expect, it, vi } from 'vitest'
import { CellSaveTracker } from '@/design-system/grid/editors/roundTrip'
import { SheetWriter, type SheetWriteResult } from '@/design-system/grid/editors/sheetWriter'
import { countSaveStatus, sameStatus, subscribeCoalesced } from './useSheetSaveStatus'

describe('sameStatus', () => {
  const base = { pending: 1, refused: 0, warned: 0, retryable: 0, refusedRowIds: new Set<string>(), offline: false, saving: true }
  it('equal counts and refused rows are the same status', () => {
    expect(sameStatus(base, { ...base, refusedRowIds: new Set() })).toBe(true)
  })
  it('any count, flag or refused row that moves is a new status', () => {
    for (const change of [{ pending: 0 }, { saving: false }, { refused: 1 }, { warned: 1 }, { retryable: 1 }, { offline: true }, { refusedRowIds: new Set(['r1']) }]) {
      expect(sameStatus(base, { ...base, ...change }), JSON.stringify(change)).toBe(false)
    }
  })
})

type Row = { id: string; parentId: string | null }
const idle = { pending: 0, failedCount: 0, unreachable: false, busy: false }

describe('countSaveStatus — audit A11: warnings are counted over the cells shown', () => {
  it('a warned cell whose column left the sheet is not counted', () => {
    const tracker = new CellSaveTracker()
    tracker.setSavedWithWarning('r1', 'title@de', 'Over the 80-character limit.')
    tracker.setSavedWithWarning('r1', 'title', 'Over the 80-character limit.')
    const rows: Row[] = [{ id: 'r1', parentId: null }]
    expect(countSaveStatus(idle, tracker, rows, [{ key: 'title' }, { key: 'title@de' }]).warned).toBe(2)
    // The German chip is turned off: its column is gone, and so is its warning from the status line.
    expect(countSaveStatus(idle, tracker, rows, [{ key: 'title' }]).warned).toBe(1)
    // A row no longer shown (another listing chosen) says nothing either.
    expect(countSaveStatus(idle, tracker, [], [{ key: 'title' }]).warned).toBe(0)
  })

  it('refused cells and rows are counted as before', () => {
    const tracker = new CellSaveTracker()
    tracker.set('r2', 'stock', 'refused', 'No default warehouse.')
    const status = countSaveStatus(idle, tracker, [{ id: 'r1', parentId: null }, { id: 'r2', parentId: 'r1' }], [{ key: 'stock' }])
    expect(status).toMatchObject({ refused: 1, warned: 0 })
    expect([...status.refusedRowIds]).toEqual(['r2'])
  })
})

describe('subscribeCoalesced — audit B26: one recount per burst of writer events', () => {
  it('a 105-row × 5-cell paste on a 60-column sheet recounts a handful of times, not once per emit', async () => {
    const tracker = new CellSaveTracker()
    const writer = new SheetWriter<Row>({
      tracker, getApi: () => null, flushMs: 1, commit: async () => ({ ok: true }),
      commitBatch: async (requests) => new Map(requests.map((r) => [r.rowId, { ok: true, version: 2 } satisfies SheetWriteResult])),
    })
    const rows: Row[] = Array.from({ length: 105 }, (_, i) => ({ id: `r${i}`, parentId: null }))
    const columns = Array.from({ length: 60 }, (_, i) => ({ key: `c${i}` }))
    let emits = 0, recounts = 0, recountMs = 0
    const recount = () => {
      const t = process.hrtime.bigint()
      countSaveStatus(writer, tracker, rows, columns)
      recountMs += Number(process.hrtime.bigint() - t) / 1e6
      recounts++
    }
    writer.subscribe(() => { emits++ })
    const stop = subscribeCoalesced(writer, recount)
    vi.useFakeTimers()
    try {
      writer.beginOperation()
      for (const row of rows) for (let c = 0; c < 5; c++) writer.set(row.id, `c${c}`, 'x')
      writer.endOperation()
      await vi.advanceTimersByTimeAsync(50)
    } finally {
      vi.useRealTimers()
    }
    // Before: one recount per emit (the old subscription), each over the same 105 × 60 cells.
    const t = process.hrtime.bigint()
    for (let i = 0; i < emits; i++) countSaveStatus(writer, tracker, rows, columns)
    const perEmitMs = Number(process.hrtime.bigint() - t) / 1e6
    console.info(`[B26] emits=${emits} recounts=${recounts} recountMs=${recountMs.toFixed(1)} · one recount per emit=${perEmitMs.toFixed(0)} ms`)
    expect(emits).toBeGreaterThan(600)
    expect(recounts).toBeLessThanOrEqual(5)
    expect(tracker.get('r104', 'c4')?.state).toBe('saved')
    stop()
  })

  it('a recount after unsubscribe never runs', async () => {
    const listeners = new Set<() => void>()
    const source = { subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn) } }
    const run = vi.fn()
    const stop = subscribeCoalesced(source, run)
    for (const fn of listeners) fn()
    stop()
    await Promise.resolve()
    expect(run).not.toHaveBeenCalled()
  })
})

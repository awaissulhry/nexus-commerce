import { describe, expect, it } from 'vitest'

import { CellSaveTracker } from './roundTrip'
import { SheetWriter, type SheetCellOutcome, type SheetWriteRequest, type SheetWriteResult } from './sheetWriter'

/**
 * G2 (2026-10-13) — every `set()` hears once what became of it (`onOutcome`): stored, refused, unanswered, or never
 * sent. The product sheet's undo keeps only what was stored; before, it replayed edits the server had refused.
 *
 * Real timers, as the refusal suite: `flush()` settles by polling `setTimeout(…, 5)`.
 */
describe('SheetWriter — each edit hears its outcome', () => {
  const heard = () => {
    const log: Array<[string, SheetCellOutcome]> = []
    return { log, on: (name: string) => (outcome: SheetCellOutcome) => { log.push([name, outcome]) } }
  }

  it('says saved and refused per cell, from the server answer', async () => {
    const h = heard()
    const commit = async (): Promise<SheetWriteResult> => ({ ok: false, cells: { a: { ok: true }, b: { ok: false, reason: 'No.' } } })
    const w = new SheetWriter({ tracker: new CellSaveTracker(), getApi: () => null, commit })
    w.set('r1', 'a', 'A', { onOutcome: h.on('a') })
    w.set('r1', 'b', 'B', { onOutcome: h.on('b') })
    await w.flush()
    expect(h.log).toEqual([['a', 'saved'], ['b', 'refused']])
    w.destroy()
  })

  it('says unknown when no answer came, never refused', async () => {
    const h = heard()
    const commit = async (): Promise<SheetWriteResult> => ({ ok: false, unreachable: true, reason: 'Failed to fetch' })
    const w = new SheetWriter({ tracker: new CellSaveTracker(), getApi: () => null, commit, readBack: async () => null })
    w.set('r1', 'a', 'A', { onOutcome: h.on('a') })
    await w.flush()
    expect(h.log).toEqual([['a', 'unknown']])
    w.destroy()
  })

  it('says dropped for an edit a later edit of the same cell replaced before it was sent — only the last is sent', async () => {
    const h = heard()
    const sent: SheetWriteRequest<unknown>[] = []
    const commit = async (req: SheetWriteRequest<unknown>): Promise<SheetWriteResult> => { sent.push(req); return { ok: true } }
    const w = new SheetWriter({ tracker: new CellSaveTracker(), getApi: () => null, commit })
    w.set('r1', 'a', 'first', { onOutcome: h.on('first') })
    w.set('r1', 'a', 'second', { onOutcome: h.on('second') })
    await w.flush()
    expect(sent.map((r) => r.cells.map((c) => c.value))).toEqual([['second']])
    expect(h.log).toEqual([['first', 'dropped'], ['second', 'saved']])
    w.destroy()
  })

  it('reports each flight on its own: an edit made while the first is on the wire is answered after it', async () => {
    const h = heard()
    let answer = 0
    const commit = async (): Promise<SheetWriteResult> => {
      if (++answer > 1) return { ok: true }
      await new Promise((r) => setTimeout(r, 20))
      return { ok: false, cells: { a: { ok: false, reason: 'No.' } } }
    }
    const w = new SheetWriter({ tracker: new CellSaveTracker(), getApi: () => null, commit, flushMs: 0 })
    w.set('r1', 'a', 'first', { onOutcome: h.on('first') })
    await new Promise((r) => setTimeout(r, 5))
    w.set('r1', 'a', 'second', { onOutcome: h.on('second') })
    expect(h.log).toEqual([])
    await w.flush()
    expect(h.log).toEqual([['first', 'refused'], ['second', 'saved']])
    w.destroy()
  })

  it('in batch mode too, and a discard drops what was queued or in the air', async () => {
    const h = heard()
    let release: (value: Map<string, SheetWriteResult>) => void = () => undefined
    const commitBatch = (requests: SheetWriteRequest<unknown>[]) => new Promise<Map<string, SheetWriteResult>>((resolve) => {
      release = resolve
      void requests
    })
    const w = new SheetWriter({ tracker: new CellSaveTracker(), getApi: () => null, commit: async () => ({ ok: true }), commitBatch, flushMs: 0 })
    w.set('r1', 'a', 'A', { onOutcome: h.on('flying') })
    await new Promise((r) => setTimeout(r, 5))
    w.set('r2', 'a', 'B', { onOutcome: h.on('queued') })
    w.discard()
    expect(h.log.sort()).toEqual([['flying', 'dropped'], ['queued', 'dropped']])
    // The answer of the discarded flight paints nothing and reports nothing again.
    release(new Map([['r1', { ok: true }]]))
    await new Promise((r) => setTimeout(r, 5))
    expect(h.log).toHaveLength(2)
    w.destroy()
  })

  /* Review of #607, finding 2 — "changed elsewhere — refresh" replaced a refused cell's value and left its mark (and its
     retry) on another person's value. A full read now takes both with the value. */
  it('forgets a refused cell a read replaced: no mark, and "Try again" no longer resends it', async () => {
    const tracker = new CellSaveTracker()
    const sent: unknown[] = []
    const commit = async (req: SheetWriteRequest<unknown>): Promise<SheetWriteResult> => {
      sent.push(...req.cells.map((c) => c.value))
      return { ok: false, cells: Object.fromEntries(req.cells.map((c) => [c.colId, { ok: false, reason: 'Changed elsewhere.' }])) }
    }
    const w = new SheetWriter({ tracker, getApi: () => null, commit })
    w.set('r1', 'material', 'X')
    w.set('r2', 'material', 'Z')
    await w.flush()
    expect(w.failedCount).toBe(2)
    w.forgetRefused('r1', 'material')
    expect(tracker.get('r1', 'material')).toBeUndefined()
    expect(w.failedCount).toBe(1)
    sent.length = 0
    w.retryFailed()
    await w.flush()
    expect(sent).toEqual(['Z'])
    // Only a refusal goes: an edit still on its way keeps its mark.
    tracker.set('r3', 'material', 'saving')
    w.forgetRefused('r3', 'material')
    expect(tracker.get('r3', 'material')?.state).toBe('saving')
    w.destroy()
  })
})

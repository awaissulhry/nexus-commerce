import { describe, expect, it, vi } from 'vitest'

import { CellSaveTracker, roundTripClassRules, saveNote, SAVED_FADE_MS } from './roundTrip'
import { SheetWriter, type SheetWriteRequest, type SheetWriteResult } from './sheetWriter'

/**
 * P1 of fix/product-sheet-editing (review 3) — a value the server STORED with a problem it names (over the channel's limit,
 * off its list) came back as plain "saved": the warning reached nobody. The writer keeps it on the cell, in the server's
 * words, until the cell is edited again; the status line counts it.
 */
interface Row { id: string; version: number }
const make = (answer: (req: SheetWriteRequest<Row>) => SheetWriteResult) => {
  const tracker = new CellSaveTracker()
  const writer = new SheetWriter<Row>({ tracker, commit: async (req) => answer(req), getApi: () => null, flushMs: 1 })
  writer.seed([{ id: 'r1', version: 1 }])
  return { tracker, writer }
}

describe('a save that answers a warning', () => {
  it('keeps the warning on the cell, in the server\'s words, past the fade — and counts it', async () => {
    vi.useFakeTimers()
    try {
      const { tracker, writer } = make(() => ({ ok: true, version: 2, cells: { title: { ok: true, warning: 'Title takes at most 80 characters' }, brand: { ok: true } } }))
      writer.set('r1', 'title', 'x'.repeat(94))
      writer.set('r1', 'brand', 'Xavia')
      const flushed = writer.flush()
      await vi.advanceTimersByTimeAsync(5)
      await flushed
      expect(tracker.get('r1', 'title')).toMatchObject({ state: 'saved', warning: 'Title takes at most 80 characters' })
      expect(saveNote(tracker.get('r1', 'title'))).toBe('Saved with a warning: Title takes at most 80 characters')
      expect(tracker.warnedCount).toBe(1)
      await vi.advanceTimersByTimeAsync(SAVED_FADE_MS + 10)
      tracker.sweep(Date.now() + SAVED_FADE_MS * 2)
      expect(tracker.get('r1', 'title')?.warning).toBe('Title takes at most 80 characters')
      // The plain saved mark fades as before.
      expect(tracker.get('r1', 'brand')).toBeUndefined()
    } finally { vi.useRealTimers() }
  })
  it('the cell wears the warning corner, not the saved ring; a refusal still reads as its reason', () => {
    const tracker = new CellSaveTracker()
    tracker.setSavedWithWarning('r1', 'title', 'Over 80')
    tracker.set('r1', 'brand', 'saved')
    tracker.set('r1', 'size', 'refused', 'Needs a number')
    const rules = roundTripClassRules<Row>(tracker, row => row.id)
    const at = (colId: string) => ({ data: { id: 'r1', version: 1 }, colDef: { colId } }) as never
    expect((rules['nds-cell-is-saved-warned'] as (p: unknown) => boolean)(at('title'))).toBe(true)
    expect((rules['nds-cell-is-saved'] as (p: unknown) => boolean)(at('title'))).toBe(false)
    expect((rules['nds-cell-is-saved'] as (p: unknown) => boolean)(at('brand'))).toBe(true)
    expect(saveNote(tracker.get('r1', 'size'))).toBe('Needs a number')
    expect(tracker.hasUnconfirmedChanges).toBe(true)
    tracker.clear('r1', 'size')
    // A stored value with a warning is confirmed: it never holds the sheet's quiet re-read back.
    expect(tracker.hasUnconfirmedChanges).toBe(false)
  })
})

/**
 * Base price on the Matrix (2026-10-13, one save line): a typed edit's ⌘Z step is kept only when its save stores it; the
 * bulk Edit's rows are no ⌘Z step (its own Undo is their one way back — a toast Undo that took a step of its own made ⌘Z
 * re-apply the bulk change); and each bulk row is answered by its own save.
 */
import { describe, expect, it } from 'vitest'

import type { SheetCellOutcome } from '@/design-system/grid'
import { SheetUndoHistory } from '../sheet/sheetUndo'
import { BULK_EDIT_SOURCE, baseRowResult, createBaseLine } from './baseLine'

function setup() {
  const history = new SheetUndoHistory()
  const sent: Array<{ rowId: string; value: unknown; answer: (o: SheetCellOutcome) => void }> = []
  const line = createBaseLine<{ id: string }>({
    history,
    writer: { set: (rowId, _colId, value, opts) => { sent.push({ rowId, value, answer: opts.onOutcome ?? (() => {}) }) } },
    unconfirmed: () => false,
  })
  const undoValues = () => { const seen: unknown[] = []; history.undo((values) => { seen.push(...values.map((v) => [v.rowId, v.value])) }); return seen }
  return { history, sent, line, undoValues }
}
const edit = (rowId: string, before: number, after: number, source?: string) => ({ rowId, colId: 'basePrice', before, after, source })

describe('a typed Base price: its ⌘Z step is kept only when the save stores it', () => {
  it('saved: ⌘Z puts the price back', () => {
    const { line, sent, undoValues } = setup()
    line.changed(edit('a', 100, 90))
    sent[0]!.answer('saved')
    expect(undoValues()).toEqual([['a', 100]])
  })
  it('refused (or no answer): the step leaves the history — ⌘Z never puts back what was not saved', () => {
    const { history, line, sent } = setup()
    line.changed(edit('a', 100, 90))
    line.changed(edit('b', 100, 80, 'paste'))
    sent[0]!.answer('refused')
    sent[1]!.answer('unknown')
    expect(history.canUndo).toBe(false)
  })
  it('⌘Z\'s write-back the server refuses leaves the redo stack: ⌘⇧Z never writes the edit over what the cell holds', () => {
    const { history, line, sent } = setup()
    line.changed(edit('a', 100, 90))
    sent[0]!.answer('saved')
    history.undo((values) => { for (const v of values) line.changed(edit(v.rowId, 90, v.value as number, 'undo')) })
    sent[1]!.answer('refused')
    expect(history.canRedo).toBe(false)
  })
  it('⌘Z\'s own write-back is saved but is no new step', () => {
    const { history, line, sent } = setup()
    line.changed(edit('a', 90, 100, 'undo'))
    sent[0]!.answer('saved')
    expect(history.canUndo).toBe(false)
  })
})

describe('the bulk Edit\'s Base price: saved through the same writer, answered row by row, and never a ⌘Z step', () => {
  it('Apply and its Undo leave no step: ⌘Z afterwards cannot re-apply the bulk change', async () => {
    const { history, line, sent } = setup()
    const a = line.awaitRow('a'), b = line.awaitRow('b'), c = line.awaitRow('c')
    line.changed(edit('a', 100, 90, BULK_EDIT_SOURCE))
    line.changed(edit('b', 100, 90, BULK_EDIT_SOURCE))
    line.settleUnchanged(['a', 'b', 'c'])
    sent[0]!.answer('saved')
    sent[1]!.answer('refused')
    expect([await a, await b, await c]).toEqual(['saved', 'refused', 'unchanged'])
    // The bulk Edit's Undo writes the same way.
    line.changed(edit('a', 90, 100, BULK_EDIT_SOURCE))
    sent[2]!.answer('saved')
    expect(history.canUndo).toBe(false)
  })
  it('a row\'s answer in the dialog\'s words: the cell\'s own refusal first', () => {
    expect(baseRowResult('a', 'saved', () => undefined)).toEqual({ rowId: 'a', ok: true })
    expect(baseRowResult('b', 'refused', () => 'Changed elsewhere — reloaded')).toEqual({ rowId: 'b', ok: false, reason: 'Changed elsewhere — reloaded' })
    expect(baseRowResult('c', 'unknown', () => undefined)).toMatchObject({ ok: false, reason: expect.stringContaining('No answer') })
  })
})

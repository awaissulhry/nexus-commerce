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

/**
 * 2026-10-13 re-review — a Base price undo the server refused takes THAT step off the redo stack (the one whose "before" it
 * put back), never another step of the cell; and a write-back a later one replaced in the queue (`dropped`) was not
 * refused: its step stays redoable.
 */
describe('Base price ⌘Z: only the refused undo leaves the redo stack', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
  /** Two saved steps on one cell: 100 → 110, then 110 → 120. */
  async function twoSteps(writer: { set: (rowId: string, colId: string, value: unknown, opts: { onOutcome?: (o: SheetCellOutcome) => void }) => void }, answer: () => void) {
    const history = new SheetUndoHistory()
    const line = createBaseLine<{ id: string }>({ history, writer, unconfirmed: () => false })
    line.changed(edit('r1', 100, 110)); answer(); await tick()
    line.changed(edit('r1', 110, 120)); answer(); await tick()
    const back = (values: Array<{ rowId: string; colId: string; value: unknown }>) => {
      for (const v of values) line.changed({ rowId: v.rowId, colId: v.colId, before: v.value === 110 ? 120 : 110, after: v.value, source: 'undo' })
    }
    const redoAll = () => { const out: unknown[] = []; while (history.redo((values) => { for (const v of values) out.push(v.value) })) { /* every step */ } return out }
    return { history, back, redoAll }
  }

  it('two undos queued together (the later replaces the earlier in the writer): both steps stay, ⌘⇧Z gives 110 then 120', async () => {
    const queued = new Map<string, (o: SheetCellOutcome) => void>()
    const writer = {
      set: (rowId: string, colId: string, _value: unknown, opts: { onOutcome?: (o: SheetCellOutcome) => void }) => {
        const replaced = queued.get(`${rowId}|${colId}`)
        queued.set(`${rowId}|${colId}`, opts.onOutcome ?? (() => {}))
        replaced?.('dropped')
      },
    }
    const answer = () => { for (const [k, a] of queued) { queued.delete(k); a('saved') } }
    const { history, back, redoAll } = await twoSteps(writer, answer)
    history.undo(back); history.undo(back)
    answer()
    expect(redoAll()).toEqual([110, 120])
  })

  it('the newer undo refused while the older one is queued: the refused step leaves redo, the step put back stays', async () => {
    const answers: Array<(o: SheetCellOutcome) => void> = []
    const writer = { set: (_r: string, _c: string, _v: unknown, opts: { onOutcome?: (o: SheetCellOutcome) => void }) => { answers.push(opts.onOutcome ?? (() => {})) } }
    const { history, back, redoAll } = await twoSteps(writer, () => answers.shift()!('saved'))
    history.undo(back) // puts 110 back (step 2) — refused
    history.undo(back) // puts 100 back (step 1) — saved
    answers.shift()!('refused')
    answers.shift()!('saved')
    expect(redoAll()).toEqual([110])
  })
})

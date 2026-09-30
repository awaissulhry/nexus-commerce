import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SheetUndoHistory, inheritedReset, rememberPriorCell, undoShortcut, withPriorProvenance, type ApplyCellValues } from './sheetUndo'
import { resetChanges } from './sheetReset'

/**
 * The sheet's own undo (`sheetUndo.ts`): one operation = one step, kept across the sheet's re-reads (AG's own history is
 * cleared by every row-model update, so ⌘Z after a fill did nothing — measured 2026-09-29).
 */
describe('SheetUndoHistory', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const recorder = () => {
    const calls: Array<Array<{ rowId: string; colId: string; value: unknown }>> = []
    const apply: ApplyCellValues = (values) => { calls.push(values) }
    return { calls, apply }
  }

  it('undoes a whole fill in ONE step, with ONE apply, and redoes it the same way', () => {
    const history = new SheetUndoHistory()
    history.begin()
    for (let i = 1; i <= 250; i++) history.record({ rowId: `r${i}`, colId: 'theme', before: null, after: 'clean' })
    history.end()

    const { calls, apply } = recorder()
    expect(history.undo(apply)).toBe(250)
    expect(calls).toHaveLength(1)
    expect(calls[0][41]).toEqual({ rowId: 'r42', colId: 'theme', value: null })
    expect(history.canUndo).toBe(false)

    expect(history.redo(apply)).toBe(250)
    expect(calls).toHaveLength(2)
    expect(calls[1][41]).toEqual({ rowId: 'r42', colId: 'theme', value: 'clean' })
  })

  it('makes each typed cell its own step, closed after the turn it happened in', async () => {
    const history = new SheetUndoHistory()
    history.record({ rowId: 'r1', colId: 'a', before: 1, after: 2 })
    await vi.advanceTimersByTimeAsync(0)
    history.record({ rowId: 'r2', colId: 'a', before: 3, after: 4 })
    await vi.advanceTimersByTimeAsync(0)
    const { calls, apply } = recorder()
    history.undo(apply)
    expect(calls).toEqual([[{ rowId: 'r2', colId: 'a', value: 3 }]])
    history.undo(apply)
    expect(calls[1]).toEqual([{ rowId: 'r1', colId: 'a', value: 1 }])
  })

  it('keeps a cell\'s FIRST value before and LAST value after when one step changes it twice', () => {
    const history = new SheetUndoHistory()
    history.begin()
    history.record({ rowId: 'r1', colId: 'a', before: 'orig', after: 'x' })
    history.record({ rowId: 'r1', colId: 'a', before: 'x', after: 'y' })
    history.end()
    const { calls, apply } = recorder()
    history.undo(apply)
    history.redo(apply)
    expect(calls).toEqual([[{ rowId: 'r1', colId: 'a', value: 'orig' }], [{ rowId: 'r1', colId: 'a', value: 'y' }]])
  })

  it('never records the changes an undo itself makes, and a new edit drops the redo', () => {
    const history = new SheetUndoHistory()
    history.begin(); history.record({ rowId: 'r1', colId: 'a', before: 1, after: 2 }); history.end()
    // The grid reports the undo's own writes back through the change handler; they must not become a new step.
    history.undo((values) => { for (const v of values) history.record({ rowId: v.rowId, colId: v.colId, before: 2, after: v.value }) })
    expect(history.canUndo).toBe(false)
    expect(history.canRedo).toBe(true)
    history.begin(); history.record({ rowId: 'r9', colId: 'a', before: 0, after: 1 }); history.end()
    expect(history.canRedo).toBe(false)
  })

  it('keeps at most the limit of steps, dropping the oldest', () => {
    const history = new SheetUndoHistory(2)
    for (const id of ['r1', 'r2', 'r3']) { history.begin(); history.record({ rowId: id, colId: 'a', before: 0, after: 1 }); history.end() }
    const { calls, apply } = recorder()
    while (history.undo(apply)) { /* drain */ }
    expect(calls.map((c) => c[0].rowId)).toEqual(['r3', 'r2'])
  })
})

describe('undoShortcut', () => {
  const key = (k: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {}) =>
    undoShortcut({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods })
  it('reads ⌘Z / Ctrl+Z as undo and ⌘⇧Z / Ctrl+Shift+Z / Ctrl+Y as redo', () => {
    expect(key('z', { metaKey: true })).toBe('undo')
    expect(key('z', { ctrlKey: true })).toBe('undo')
    expect(key('Z', { metaKey: true, shiftKey: true })).toBe('redo')
    expect(key('z', { ctrlKey: true, shiftKey: true })).toBe('redo')
    expect(key('y', { ctrlKey: true })).toBe('redo')
  })
  it('ignores everything else', () => {
    expect(key('z')).toBeNull()
    expect(key('z', { metaKey: true, altKey: true })).toBeNull()
    expect(key('y', { metaKey: true })).toBeNull()
    expect(key('c', { metaKey: true })).toBeNull()
  })
})

/**
 * Audit A05 — undoing an edit to an INHERITED cell stored the inherited value as the row's own (a set pins it: an eBay
 * listing that followed Master's €49 kept €49 after Master moved to €55). Audit A08 — "Reset to inherited" was not an
 * undo step, so ⌘Z after it undid an older step and pinned that step's "before" value over the reset.
 */
describe('undo keeps inheritance (audit A05, A08)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const inherited = { value: 49, inherited: true, pinned: false, layer: 'master', writeField: 'price' }
  const typed = (previous: object, value: unknown) => {
    const next = { ...previous, value, inherited: false, pinned: true, layer: 'aliasVariant' }
    rememberPriorCell(next, previous)
    return next
  }

  it('undo of an edit over an inherited value is a reset (with the inherited cell), not a set of that value', () => {
    const history = new SheetUndoHistory()
    const current = typed(inherited, 45)
    history.record(withPriorProvenance({ rowId: 'r1', colId: 'price', before: 49, after: 45 }, current))
    const calls: Parameters<ApplyCellValues>[0][] = []
    history.undo((values) => { calls.push(values) })
    expect(calls[0]).toEqual([{ rowId: 'r1', colId: 'price', value: 49, reset: { intent: 'reset', cell: inherited } }])
    // Redo types the value again.
    history.redo((values) => { calls.push(values) })
    expect(calls[1]).toEqual([{ rowId: 'r1', colId: 'price', value: 45 }])
  })

  it('a second edit’s undo sets the first edit’s own value back (its "before" was not inherited)', () => {
    const first = typed(inherited, 45)
    const second = typed(first, 40)
    expect(withPriorProvenance({ rowId: 'r1', colId: 'price', before: 45, after: 40 }, second).beforeReset).toBeUndefined()
  })

  it('an own value, an eBay listing-level value on a variation, and an untracked cell undo as a set', () => {
    const own = typed({ value: 'A', inherited: false, pinned: true }, 'B')
    expect(withPriorProvenance({ rowId: 'r1', colId: 'c', before: 'A', after: 'B' }, own).beforeReset).toBeUndefined()
    const level = typed({ value: 'Pelle', inherited: true, pinned: false, mapped: { listingLevel: { productId: 'p0', sku: 'P', variation: true } } }, 'Tela')
    expect(withPriorProvenance({ rowId: 'r1', colId: 'c', before: 'Pelle', after: 'Tela' }, level).beforeReset).toBeUndefined()
    expect(withPriorProvenance({ rowId: 'r1', colId: 'c', before: 'A', after: 'B' }, { value: 'B' }).beforeReset).toBeUndefined()
  })

  it('a whole-list field resets its list', () => {
    expect(inheritedReset({ inherited: true, pinned: false, writeField: 'bullet_point' }, (f) => f === 'bullet_point')?.intent).toBe('reset-list')
  })

  it('a reset is a step: ⌘Z sets the own value back, redo resets again — never the older step', () => {
    const history = new SheetUndoHistory()
    history.record({ rowId: 'r1', colId: 'title', before: 'A', after: 'B', beforeReset: { intent: 'reset' } })
    vi.advanceTimersByTime(0)
    history.begin()
    for (const change of resetChanges({ values: { title: { value: 'B' } } }, { rowId: 'r1', colId: 'title', intent: 'reset', formula: false })) history.record(change)
    history.end()
    const calls: Parameters<ApplyCellValues>[0][] = []
    history.undo((values) => { calls.push(values) })
    expect(calls[0]).toEqual([{ rowId: 'r1', colId: 'title', value: 'B' }])
    history.redo((values) => { calls.push(values) })
    expect(calls[1]).toEqual([{ rowId: 'r1', colId: 'title', value: null, reset: { intent: 'reset' } }])
  })

  it('a list reset records every position and sends the list’s reset once', () => {
    const row = { values: { 'bp:1': { value: 'a' }, 'bp:2': { value: 'b' }, title: { value: 't' } } }
    const changes = resetChanges(row, { rowId: 'r1', colId: 'bp:1', intent: 'reset-list', formula: false }, (_r, colId) => colId.startsWith('bp:') ? 'bp' : null)
    expect(changes).toEqual([
      { rowId: 'r1', colId: 'bp:1', before: 'a', after: null, afterReset: { intent: 'reset-list' } },
      { rowId: 'r1', colId: 'bp:2', before: 'b', after: null, afterReset: { intent: 'reset-list', covered: true } },
    ])
  })
})

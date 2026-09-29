import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SheetUndoHistory, undoShortcut, type ApplyCellValues } from './sheetUndo'

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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { carryEditPrior, inheritedCell, isInheritValue, listPositions, noteEditPrior, routeHistoryValues, SheetUndoHistory, stateBefore, takeEditPrior, undoShortcut, type ApplyCellValues, type CellResetOffer, type SheetInheritValue } from './sheetUndo'

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

  it('forgets a recorded change that did not happen (refused, a conflict, nothing changed); a step left empty leaves the history', async () => {
    const history = new SheetUndoHistory()
    const kept = { v: 'kept' }, refused = { v: 'refused' }, alone = { v: 'alone' }
    history.begin()
    history.record({ rowId: 'r1', colId: 'a', before: 1, after: kept })
    history.record({ rowId: 'r2', colId: 'a', before: 1, after: refused })
    history.end()
    history.record({ rowId: 'r3', colId: 'a', before: 1, after: alone })
    await vi.advanceTimersByTimeAsync(0)
    history.forget('r2', 'a', refused)
    history.forget('r3', 'a', alone)
    // Only the very record goes: another object on the same cell is not touched.
    history.forget('r1', 'a', { v: 'kept' })
    const { calls, apply } = recorder()
    expect(history.undo(apply)).toBe(1)
    expect(calls[0]).toEqual([{ rowId: 'r1', colId: 'a', value: 1 }])
    expect(history.canUndo).toBe(false)
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
 * G3 (2026-10-13) — ⌘Z replayed the DISPLAYED value as a plain set, so a cell that inherited (a variation the family's
 * Description) or followed (a channel cell the Shared Manufacturer) became the cell's own stored value or an explicit
 * empty. The history now keeps the cell's STATE, and an inherited "before" is replayed as the write path's reset.
 */
describe('G3 — undo puts an inherited or following cell back to inheriting', () => {
  type Cell = { value: unknown; inherited?: boolean; pinned?: boolean; source?: string; layer?: string; contentVersion?: number }
  type Row = { id: string; values: Record<string, Cell> }
  // The scope's rule, in short: a reset exists where the cell holds its own value (`masterResetOffer` / `channelResetOffer`).
  const offerOf = (row: Row, colId = 'description'): CellResetOffer => (row.values[colId]?.inherited === false ? { intent: 'reset' } : null)
  const inherits: Cell = { value: 'PD2', inherited: true, pinned: false, source: 'master', layer: 'master' }
  const typed = (cell: Cell, value: unknown): Cell => ({ ...cell, value, inherited: false, pinned: true, source: 'variant', layer: 'variant' })

  it('records an inherited "before" as a reset, and keeps a plain value where the cell held its own', () => {
    const row: Row = { id: 'L', values: { description: typed(inherits, 'LD1') } }
    const before = stateBefore('PD2', row, 'description', inherits, offerOf)
    expect(isInheritValue(before)).toBe(true)
    expect(before).toMatchObject({ value: 'PD2', intent: 'reset', cell: inherits, list: null })
    // Its own value before: a plain value, as before.
    expect(stateBefore('LD0', row, 'description', typed(inherits, 'LD0'), offerOf)).toBe('LD0')
    // No reset after the edit either (a family row, a field nothing inherits): the plain value.
    expect(stateBefore('PD2', row, 'description', inherits, () => null)).toBe('PD2')
    // The value setter did not say what it replaced: the plain value.
    expect(stateBefore('PD2', row, 'description', undefined, offerOf)).toBe('PD2')
  })

  it('a list position carries its list, and a step resets each list once per row', () => {
    const listOffer = (row: Row): CellResetOffer => (row.values.description?.inherited === false ? { intent: 'reset-list' } : null)
    const row: Row = { id: 'L', values: { description: typed(inherits, 'b2') } }
    const before = stateBefore('PD2', row, 'description', inherits, listOffer, { key: 'bullet_point', positions: ['description'], priorOf: () => undefined }) as SheetInheritValue
    expect(before).toMatchObject({ intent: 'reset-list', list: 'bullet_point' })
    const resets: string[] = []
    const plain = routeHistoryValues([
      { rowId: 'L', colId: 'bullet_point[1]', value: before },
      { rowId: 'L', colId: 'bullet_point[2]', value: before },
      { rowId: 'M', colId: 'bullet_point[1]', value: before },
      { rowId: 'L', colId: 'brand', value: 'Xavia' },
    ], ({ rowId, colId }) => resets.push(`${rowId}.${colId}`))
    expect(resets).toEqual(['L.bullet_point[1]', 'M.bullet_point[1]'])
    expect(plain).toEqual([{ rowId: 'L', colId: 'brand', value: 'Xavia' }])
  })

  it('replays the step: the inherited "before" goes to the reset, the redo sends the own value again', () => {
    const history = new SheetUndoHistory()
    const row: Row = { id: 'L', values: { description: typed(inherits, 'LD1') } }
    history.begin()
    history.record({ rowId: 'L', colId: 'description', before: stateBefore('PD2', row, 'description', inherits, offerOf), after: 'LD1' })
    history.end()
    const resets: unknown[] = []
    const grid: unknown[] = []
    const apply: ApplyCellValues = (values) => { grid.push(...routeHistoryValues(values, (cell) => resets.push(cell))) }
    history.undo(apply)
    expect(resets).toEqual([{ rowId: 'L', colId: 'description', value: expect.objectContaining({ value: 'PD2', intent: 'reset' }) }])
    expect(grid).toEqual([])
    history.redo(apply)
    expect(grid).toEqual([{ rowId: 'L', colId: 'description', value: 'LD1' }])
    // A host without a reset writes the plain value (the old behaviour), never the history-only envelope.
    history.undo((values) => { grid.push(...routeHistoryValues(values)) })
    expect(grid.at(-1)).toEqual({ rowId: 'L', colId: 'description', value: 'PD2' })
  })

  it('shows the inherited value and provenance at once, keeping the current cell\'s write tokens', () => {
    const before = stateBefore('PD2', { id: 'L', values: { description: typed(inherits, 'LD1') } }, 'description', inherits, offerOf) as SheetInheritValue
    const current = { ...typed(inherits, 'LD1'), contentVersion: 7 }
    expect(inheritedCell(current, before)).toEqual({ value: 'PD2', inherited: true, pinned: false, source: 'master', layer: 'master', contentVersion: 7 })
  })

  it('reads the cell an edit replaced once (the value setter notes it)', () => {
    const next = typed(inherits, 'LD1')
    noteEditPrior(next, inherits)
    expect(takeEditPrior(next)).toBe(inherits)
    expect(takeEditPrior(next)).toBeUndefined()
    expect(takeEditPrior('LD1')).toBeUndefined()
    // An edit over one the history never recorded (it waits for a Shared/pin choice) keeps the cell as it was before both.
    const first = typed(inherits, 'A'), second = typed(inherits, 'B')
    noteEditPrior(first, inherits)
    noteEditPrior(second, first)
    expect(takeEditPrior(second)).toBe(inherits)
  })
})

/**
 * Review of #607, finding 1 — a list position resets with its WHOLE list. Position 1 typed and saved; position 2 typed
 * while the sheet still showed it following (the re-read waits for the open editor): its "before" was a list reset, and
 * ⌘Z wiped position 1's saved value. A list reset is recorded only when no other position held its own value before.
 */
describe('finding 1 — undo of one list position never wipes the rest of the list', () => {
  type Cell = { value: unknown; inherited: boolean; writeField: string }
  type Row = { rowId: string; values: Record<string, Cell> }
  const follows = (n: number): Cell => ({ value: `Shared ${n}`, inherited: true, writeField: `special_feature[${n}]` })
  const own = (n: number, value: string): Cell => ({ value, inherited: false, writeField: `special_feature[${n}]` })
  const offerOf = (row: Row, colId: string): CellResetOffer => (row.values[colId]?.inherited === false ? { intent: 'reset-list' } : null)
  const listOf = (cell: unknown) => /^(.+)\[\d+\]$/.exec((cell as Cell | undefined)?.writeField ?? '')?.[1] ?? null
  const F1 = 'special_feature[1]', F2 = 'special_feature[2]', F3 = 'special_feature[3]'

  it('position 2 typed after position 1 was saved: the plain value, not a reset of the list', () => {
    const p1 = own(1, 'Waterproof'), p2 = own(2, 'Vented')
    noteEditPrior(p1, follows(1)); takeEditPrior(p1) // position 1's own edit, recorded in an earlier step
    noteEditPrior(p2, follows(2))
    const row: Row = { rowId: 'L', values: { [F1]: p1, [F2]: p2, [F3]: follows(3) } }
    const list = listPositions(row, F2, listOf, () => false)
    expect(list).toMatchObject({ key: 'special_feature', positions: [F1, F2, F3] })
    expect(stateBefore('Shared 2', row, F2, takeEditPrior(p2), offerOf, list)).toBe('Shared 2')
  })

  it('positions pasted together into a list that followed: the list resets as it was', () => {
    const p1 = own(1, 'Waterproof'), p2 = own(2, 'Vented')
    noteEditPrior(p1, follows(1)); noteEditPrior(p2, follows(2))
    const row: Row = { rowId: 'L', values: { [F1]: p1, [F2]: p2, [F3]: follows(3) } }
    // Position 1 is recorded first (its prior taken, in the open step); position 2's own edit is not recorded yet.
    const first = stateBefore('Shared 1', row, F1, takeEditPrior(p1), offerOf, listPositions(row, F1, listOf, () => false))
    const second = stateBefore('Shared 2', row, F2, takeEditPrior(p2), offerOf, listPositions(row, F2, listOf, (colId) => colId === F1))
    expect(first).toMatchObject({ intent: 'reset-list', list: 'special_feature' })
    expect(second).toMatchObject({ intent: 'reset-list', list: 'special_feature' })
  })

  it('a list reset with no list to check is the plain value', () => {
    const p2 = own(2, 'Vented')
    expect(stateBefore('Shared 2', { rowId: 'L', values: { [F2]: p2 } }, F2, follows(2), offerOf)).toBe('Shared 2')
  })
})

/** Review of #607, finding 3 — a Shared/pin choice replaced the cell object, and the edit's prior was lost. */
describe('finding 3 — a prior travels with the cell a choice replaces', () => {
  it('carries an unrecorded prior, and nothing once it was taken', () => {
    const following = { value: 'Shared title', inherited: true }
    const edited = { value: 'New title', inherited: false }
    noteEditPrior(edited, following)
    const marked = { ...edited, contentAcknowledged: true }
    carryEditPrior(edited, marked)
    expect(takeEditPrior(marked)).toBe(following)
    const later = { ...marked }
    carryEditPrior(marked, later)
    expect(takeEditPrior(later)).toBeUndefined()
  })
})

/**
 * G2 (2026-10-13) — ⌘Z / ⌘⇧Z replayed REFUSED edits: the change was recorded when it was typed, before the save, and
 * nothing took it out. Now the writer reports each edit's outcome and the history keeps only what was stored, with the
 * server's value — not the cell's — as "before" (the Matrix's rule, `sendCells`).
 */
describe('G2 — the history keeps only what the server stored', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  const replay = (history: SheetUndoHistory, direction: 'undo' | 'redo') => {
    const out: Array<Array<{ rowId: string; colId: string; value: unknown }>> = []
    history[direction]((values) => { out.push(values) })
    return out[0] ?? null
  }

  it('a refused, unanswered or replaced edit leaves the history; a stored one stays', async () => {
    const history = new SheetUndoHistory()
    const refused = history.edit({ rowId: 'M', colId: 'gtin', before: null, after: '123' }, false)
    await vi.advanceTimersByTimeAsync(0)
    const unknown = history.edit({ rowId: 'M', colId: 'brand', before: 'Xavia', after: 'X' }, false)
    await vi.advanceTimersByTimeAsync(0)
    const dropped = history.edit({ rowId: 'L', colId: 'cost', before: null, after: '1' }, false)
    await vi.advanceTimersByTimeAsync(0)
    const saved = history.edit({ rowId: 'L', colId: 'name', before: 'Old', after: 'New' }, false)
    await vi.advanceTimersByTimeAsync(0)
    refused('refused'); unknown('unknown'); dropped('dropped'); saved('saved')
    expect(replay(history, 'undo')).toEqual([{ rowId: 'L', colId: 'name', value: 'Old' }])
    expect(history.canUndo).toBe(false)
    expect(replay(history, 'redo')).toEqual([{ rowId: 'L', colId: 'name', value: 'New' }])
  })

  it('an edit over a refused one takes what the server holds as its "before", not the refused value it shows', async () => {
    const history = new SheetUndoHistory()
    history.edit({ rowId: 'M', colId: 'man', before: 'X', after: 'A' }, false)('refused')
    await vi.advanceTimersByTimeAsync(0)
    // The cell shows A with its refusal mark (`unconfirmed`); B is typed over it and stored.
    history.edit({ rowId: 'M', colId: 'man', before: 'A', after: 'B' }, true)('saved')
    await vi.advanceTimersByTimeAsync(0)
    expect(replay(history, 'undo')).toEqual([{ rowId: 'M', colId: 'man', value: 'X' }])
    expect(history.canUndo).toBe(false)
  })

  it('an edit made while the one before it is on the wire is made over what that one stores', async () => {
    const history = new SheetUndoHistory()
    const first = history.edit({ rowId: 'L', colId: 'cost', before: null, after: '11' }, false)
    await vi.advanceTimersByTimeAsync(0)
    const second = history.edit({ rowId: 'L', colId: 'cost', before: '11', after: '12' }, false)
    await vi.advanceTimersByTimeAsync(0)
    const third = history.edit({ rowId: 'L', colId: 'cost', before: '12', after: '13' }, false)
    await vi.advanceTimersByTimeAsync(0)
    first('saved'); second('dropped'); third('saved')
    expect(replay(history, 'undo')).toEqual([{ rowId: 'L', colId: 'cost', value: '11' }])
    expect(replay(history, 'undo')).toEqual([{ rowId: 'L', colId: 'cost', value: null }])
    expect(history.canUndo).toBe(false)

    // The same, with the first one refused: the next edit's "before" is the stored value it was typed over.
    const again = new SheetUndoHistory()
    const a = again.edit({ rowId: 'L', colId: 'cost', before: null, after: '11' }, false)
    await vi.advanceTimersByTimeAsync(0)
    const b = again.edit({ rowId: 'L', colId: 'cost', before: '11', after: '12' }, false)
    await vi.advanceTimersByTimeAsync(0)
    a('refused'); b('saved')
    expect(replay(again, 'undo')).toEqual([{ rowId: 'L', colId: 'cost', value: null }])
    expect(again.canUndo).toBe(false)
  })

  it('an undo\'s own write is no step, but what it stores is the next edit\'s "before"', async () => {
    const history = new SheetUndoHistory()
    history.edit({ rowId: 'L', colId: 'man', before: 'X', after: 'A' }, false)('saved')
    await vi.advanceTimersByTimeAsync(0)
    history.undo(() => undefined)
    // The undo writes X back (still on the wire) when B is typed.
    const back = history.edit({ rowId: 'L', colId: 'man', before: 'A', after: 'X' }, false, false)
    const typed = history.edit({ rowId: 'L', colId: 'man', before: 'X', after: 'B' }, false)
    await vi.advanceTimersByTimeAsync(0)
    back('saved'); typed('saved')
    expect(replay(history, 'undo')).toEqual([{ rowId: 'L', colId: 'man', value: 'X' }])
    expect(history.canUndo).toBe(false)
  })

  it('a refused edit, then a read showed another value under the old mark: the next edit\'s "before" is that value (finding 2)', async () => {
    const history = new SheetUndoHistory()
    // The variation inherited F; the operator typed X; the server refused it (someone else had set V2).
    history.edit({ rowId: 'M', colId: 'material', before: 'F (inherited)', after: 'X' }, false)('refused')
    await vi.advanceTimersByTimeAsync(0)
    // "Changed elsewhere — refresh" shows V2 (the mark may still say refused); the operator types Y, and it is stored.
    history.edit({ rowId: 'M', colId: 'material', before: 'V2', after: 'Y' }, true)('saved')
    await vi.advanceTimersByTimeAsync(0)
    expect(replay(history, 'undo')).toEqual([{ rowId: 'M', colId: 'material', value: 'V2' }])
  })

  it('an edit that never reached the writer (dropped while formulas loaded, a refused formula) is remembered as unsaved (finding 4)', async () => {
    const history = new SheetUndoHistory()
    // The cell held nothing; "=upper(x)" was typed and its formula save refused: the cell shows it, the server holds nothing.
    history.unsaved({ rowId: 'M', colId: 'man', before: null, after: '=upper(x)' })
    expect(history.canUndo).toBe(false)
    history.edit({ rowId: 'M', colId: 'man', before: '=upper(x)', after: 'Acme' }, true)('saved')
    await vi.advanceTimersByTimeAsync(0)
    expect(replay(history, 'undo')).toEqual([{ rowId: 'M', colId: 'man', value: null }])
    // A read that replaced the shown value since: the next edit starts from what it shows.
    const reread = new SheetUndoHistory()
    reread.unsaved({ rowId: 'M', colId: 'man', before: null, after: '=upper(x)' })
    reread.edit({ rowId: 'M', colId: 'man', before: 'Other', after: 'Acme' }, true)('saved')
    await vi.advanceTimersByTimeAsync(0)
    expect(replay(reread, 'undo')).toEqual([{ rowId: 'M', colId: 'man', value: 'Other' }])
  })

  it('one step that changed a cell twice keeps its first "before"; the replaced change\'s answer moves nothing', () => {
    const history = new SheetUndoHistory()
    history.begin()
    const first = history.edit({ rowId: 'r1', colId: 'a', before: 'orig', after: 'x' }, false)
    const second = history.edit({ rowId: 'r1', colId: 'a', before: 'x', after: 'y' }, false)
    history.end()
    first('dropped'); second('saved')
    expect(replay(history, 'undo')).toEqual([{ rowId: 'r1', colId: 'a', value: 'orig' }])

    // The same value twice: the replaced change's answer still takes nothing out.
    const same = new SheetUndoHistory()
    same.begin()
    const one = same.edit({ rowId: 'r1', colId: 'a', before: 'orig', after: 'x' }, false)
    const two = same.edit({ rowId: 'r1', colId: 'a', before: 'x', after: 'x' }, false)
    same.end()
    one('dropped'); two('saved')
    expect(replay(same, 'undo')).toEqual([{ rowId: 'r1', colId: 'a', value: 'orig' }])
  })
})

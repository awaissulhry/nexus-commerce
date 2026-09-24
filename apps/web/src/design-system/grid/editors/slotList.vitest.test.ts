import { describe, expect, it } from 'vitest'
import {
  bulletsEditorKey, isSlotListKey, listModeCommit, listModeItems, moveByKey, moveSlot, slotListChanges, slotListKey, slotListText,
  slotListValue, slotPositionOf, suppressSlotListKeys, withTrailingEmpty,
} from './slotList'

/*
 * Step 4.3 #3 (A-52; R-55, R-56) — the pure rules of the one bullets cell. apps/web vitest is node-only; the key rule reads
 * the event target structurally, so the arms below build targets from plain objects.
 */
const TEN = ['one', 'two', '', 'four', 'five', 'six', '', 'eight', 'nine', 'ten']

describe('slotListValue — the one cell holds exactly max positions', () => {
  it('round-trips ten values unchanged', () => {
    expect(slotListValue(TEN, 10)).toEqual(TEN)
  })
  it('keeps a hole IN PLACE (null / undefined / empty become an empty position, never compacted)', () => {
    expect(slotListValue(['a', null, undefined, 'd'], 5)).toEqual(['a', '', '', 'd', ''])
  })
  it('never pads past max and reads nothing as all-empty', () => {
    expect(slotListValue(['a', 'b', 'c'], 2)).toEqual(['a', 'b'])
    expect(slotListValue(null, 3)).toEqual(['', '', ''])
  })
})

describe('slotListChanges — only CHANGED positions leave', () => {
  it('an untouched value changes nothing', () => {
    expect(slotListChanges(TEN, [...TEN], 10)).toEqual([])
  })
  it('one position edited → exactly that position', () => {
    const after = [...TEN]; after[3] = 'FOUR'
    expect(slotListChanges(TEN, after, 10)).toEqual([{ position: 4, value: 'FOUR' }])
  })
  it('a cleared position leaves as null (a slot clear), never as an empty string', () => {
    const after = [...TEN]; after[0] = ''
    expect(slotListChanges(TEN, after, 10)).toEqual([{ position: 1, value: null }])
  })
  it('a hole that stays a hole is not a change (null vs empty string)', () => {
    expect(slotListChanges(['a', null, 'c'], ['a', '', 'c'], 3)).toEqual([])
  })
})

describe('moveSlot — reorder rewrites only the moved span and loses nothing', () => {
  it('3 → 2 changes positions 2 and 3 only', () => {
    const moved = moveSlot(TEN, 2, 1)
    expect(slotListChanges(TEN, moved, 10).map(c => c.position)).toEqual([2, 3])
  })
  it('keeps every position (same length, same texts)', () => {
    const moved = moveSlot(TEN, 0, 9)
    expect(moved).toHaveLength(10)
    expect([...moved].sort()).toEqual([...TEN].sort())
    expect(moved[9]).toBe('one')
  })
  it('a move onto itself or off the ends changes nothing', () => {
    expect(moveSlot(TEN, 4, 4)).toEqual(TEN)
    expect(moveSlot(TEN, 0, 10)).toEqual(TEN)
  })
})

describe('moveByKey — Alt+↑/↓ keyboard parity with the drag and the buttons', () => {
  const ids = ['p1', 'p2', 'p3', 'p4']
  const label = (id: string) => `Bullet ${ids.indexOf(id) + 1}`
  it('Alt+↓ on position 1 swaps 1 and 2, keeps the focus on the moved bullet, and says where it went', () => {
    expect(moveByKey(ids, 1, 'down', label)).toEqual({ order: ['p2', 'p1', 'p3', 'p4'], focus: 'p1', announcement: 'Bullet 1, position 2 of 4' })
  })
  it('Alt+↑ on position 3 → position 2', () => {
    expect(moveByKey(ids, 3, 'up', label)?.order).toEqual(['p1', 'p3', 'p2', 'p4'])
  })
  it('at the ends nothing moves', () => {
    expect(moveByKey(ids, 1, 'up', label)).toBeNull()
    expect(moveByKey(ids, 4, 'down', label)).toBeNull()
  })
})

describe('list mode (Shared bullets)', () => {
  it('the items plus ONE trailing empty position while there is room; unbounded always has one', () => {
    expect(listModeItems(['a', 'b'], null)).toEqual(['a', 'b', ''])
    expect(listModeItems(['a', 'b'], 3)).toEqual(['a', 'b', ''])
    expect(listModeItems(['a', 'b', 'c'], 3)).toEqual(['a', 'b', 'c'])
    expect(listModeItems(null, null)).toEqual([''])
  })
  it('a trailing empty is added only when the last position has text', () => {
    expect(withTrailingEmpty(['a', ''], null)).toEqual(['a', ''])
    expect(withTrailingEmpty(['a', 'b'], null)).toEqual(['a', 'b', ''])
  })
  it('commit drops blanks — the trailing empty is never a bullet — and keeps the order', () => {
    expect(listModeCommit(['b', '', 'a', '  ', ''])).toEqual(['b', 'a'])
  })
})

describe('keys and names', () => {
  it('slotListKey / isSlotListKey', () => {
    expect(slotListKey('bulletPoints')).toBe('slots:bulletPoints')
    expect(slotListKey('bulletPoints', 'de')).toBe('slots:bulletPoints@de')
    expect(isSlotListKey('slots:bulletPoints')).toBe(true)
    expect(isSlotListKey('bulletPoints_1')).toBe(false)
    expect(isSlotListKey(undefined)).toBe(false)
  })
  it('slotListText numbers the filled positions, one per line (copy / export)', () => {
    expect(slotListText(['a', '', 'c'])).toBe('1. a\n3. c')
    expect(slotListText(null)).toBe('')
  })
})

describe('bulletsEditorKey — R-55', () => {
  const k = (key: string, extra: Record<string, boolean> = {}) => ({ key, ...extra })
  it('Tab on 1..9 → next; Tab on the LAST → ag (commits and moves right)', () => {
    for (let p = 1; p < 10; p++) expect(bulletsEditorKey(k('Tab'), p, 10)).toBe('next')
    expect(bulletsEditorKey(k('Tab'), 10, 10)).toBe('ag')
  })
  it('Shift+Tab on 2..10 → prev; on the FIRST → ag; from the footer → prev (to the last position)', () => {
    expect(bulletsEditorKey(k('Tab', { shiftKey: true }), 1, 10)).toBe('ag')
    expect(bulletsEditorKey(k('Tab', { shiftKey: true }), 2, 10)).toBe('prev')
    expect(bulletsEditorKey(k('Tab', { shiftKey: true }), 11, 10)).toBe('prev')
    expect(bulletsEditorKey(k('Tab'), 11, 10)).toBe('ag')
  })
  it('Alt+↑ / Alt+↓ move within the list; at the ends nothing moves (taken, none)', () => {
    expect(bulletsEditorKey(k('ArrowUp', { altKey: true }), 1, 10)).toBe('none')
    expect(bulletsEditorKey(k('ArrowUp', { altKey: true }), 3, 10)).toBe('up')
    expect(bulletsEditorKey(k('ArrowDown', { altKey: true }), 10, 10)).toBe('none')
    expect(bulletsEditorKey(k('ArrowDown', { altKey: true }), 3, 10)).toBe('down')
  })
  it('Enter saves; Shift+Enter is swallowed (a bullet is one line); Enter on a button is that button; Esc is AG', () => {
    expect(bulletsEditorKey(k('Enter'), 4, 10)).toBe('save')
    expect(bulletsEditorKey(k('Enter', { shiftKey: true }), 4, 10)).toBe('swallow')
    expect(bulletsEditorKey(k('Enter'), 4, 10, { onButton: true })).toBe('press')
    expect(bulletsEditorKey(k('Escape'), 4, 10)).toBe('ag')
    expect(bulletsEditorKey(k('a'), 4, 10)).toBe('type')
  })
})

/* A target shaped like the DOM: `closest()` answers for the editor, the reorder row and a button. */
function target(opts: { inEditor?: boolean; index?: number; button?: boolean; count?: number }) {
  const count = opts.count ?? 10
  const editor = { getAttribute: (n: string) => (n === 'data-slot-count' ? String(count) : null) }
  const rows: unknown[] = []
  const list = { children: rows }
  for (let i = 0; i < count; i++) rows.push({ parentElement: list })
  const item = opts.index === undefined ? null : rows[opts.index]
  return {
    closest: (sel: string) => sel === '.nds-slotlist-editor' ? (opts.inEditor === false ? null : editor)
      : sel === '[data-nds-reorder-item]' ? item
      : sel === 'button' ? (opts.button ? {} : null) : null,
  }
}

describe('slotPositionOf / suppressSlotListKeys — which keys are taken from AG', () => {
  it('reads the position from the reorder row, the footer as count + 1, and 0 outside the editor', () => {
    expect(slotPositionOf(target({ index: 3 }))).toMatchObject({ position: 4, count: 10 })
    expect(slotPositionOf(target({}))).toMatchObject({ position: 11, count: 10 })
    expect(slotPositionOf(target({ inEditor: false }))).toMatchObject({ position: 0, count: 0 })
  })
  const ev = (key: string, t: unknown, extra: Record<string, boolean> = {}) => ({ event: { key, target: t, ...extra } as never, editing: true })
  it('not editing, or outside the editor → never taken', () => {
    expect(suppressSlotListKeys({ ...ev('Tab', target({ index: 0 })), editing: false })).toBe(false)
    expect(suppressSlotListKeys(ev('Tab', target({ index: 0, inEditor: false })))).toBe(false)
  })
  it('Tab on position 1 is taken; Tab on the LAST position is not (AG commits and moves right)', () => {
    expect(suppressSlotListKeys(ev('Tab', target({ index: 0 })))).toBe(true)
    expect(suppressSlotListKeys(ev('Tab', target({ index: 9 })))).toBe(false)
  })
  it('Enter and Shift+Enter are taken; Esc is not; a typed letter is not', () => {
    expect(suppressSlotListKeys(ev('Enter', target({ index: 2 })))).toBe(true)
    expect(suppressSlotListKeys(ev('Enter', target({ index: 2 }), { shiftKey: true }))).toBe(true)
    expect(suppressSlotListKeys(ev('Escape', target({ index: 2 })))).toBe(false)
    expect(suppressSlotListKeys(ev('x', target({ index: 2 })))).toBe(false)
  })
  it('Enter on a button (Cancel, a move button) is taken from AG so it can never commit instead', () => {
    expect(suppressSlotListKeys(ev('Enter', target({ button: true })))).toBe(true)
  })
})

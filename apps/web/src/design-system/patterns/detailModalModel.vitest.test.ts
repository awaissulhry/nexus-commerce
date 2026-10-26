import { describe, expect, it } from 'vitest'

import {
  DETAIL_NAV_KEYS, KEY_TARGET_SELECTORS, detailBodyState, nextTallest, detailNavHeld, detailNavKey, detailNavLabel, detailPosition,
  type NavKeyEvent,
} from './detailModalModel'

const ids = ['r1', 'r2', 'r3', 'r4']
const key = (k: string, over: Partial<NavKeyEvent> = {}): NavKeyEvent => ({ key: k, altKey: false, ctrlKey: false, metaKey: false, ...over })

describe('position and Prev / Next', () => {
  it('says where the row is and which rows come before and after it', () => {
    expect(detailPosition(ids, 'r3')).toEqual({ index: 2, total: 4, prevId: 'r2', nextId: 'r4', words: '3 of 4' })
  })

  it('never wraps: the first row has no previous, the last no next, and each says why', () => {
    const first = detailPosition(ids, 'r1')
    expect(first.prevId).toBeNull()
    expect(detailNavHeld(first, 'rule')).toEqual({ prev: 'This is the first rule', next: null })
    const last = detailPosition(ids, 'r4')
    expect(last.nextId).toBeNull()
    expect(detailNavHeld(last, 'keyword')).toEqual({ prev: null, next: 'This is the last keyword' })
    const only = detailPosition(['r1'], 'r1')
    expect(only.words).toBe('1 of 1')
    expect(detailNavHeld(only)).toEqual({ prev: 'This is the first row', next: 'This is the last row' })
  })

  it('holds both when the row is no longer in the list (a filter hides it), with no position', () => {
    const gone = detailPosition(ids, 'r9')
    expect(gone).toEqual({ index: -1, total: 4, prevId: null, nextId: null, words: null })
    expect(detailNavHeld(gone, 'rule')).toEqual({ prev: 'This rule is not in the table now', next: 'This rule is not in the table now' })
    expect(detailPosition([], undefined).words).toBeNull()
  })

  it('a paged list counts the whole list and says a page ends there, never that the list does', () => {
    // Page 2 of a 56-row list, 50 rows a page: the rows on screen are 51–56.
    const onPage2 = detailPosition(ids, 'r3', { offset: 50, total: 56 })
    expect(onPage2).toEqual({ index: 2, total: 56, prevId: 'r2', nextId: 'r4', words: '53 of 56' })
    expect(detailPosition(ids, 'r3', { offset: 0, total: 56 }).words).toBe('3 of 56')
    expect(detailNavHeld(detailPosition(ids, 'r4', { offset: 0, total: 56 }), 'review', { offset: 0, total: 56 }))
      .toEqual({ prev: null, next: 'This is the last review on this page' })
    expect(detailNavHeld(detailPosition(ids, 'r1', { offset: 50, total: 54 }), 'review', { offset: 50, total: 54 }))
      .toEqual({ prev: 'This is the first review on this page', next: null })
    // The last page's last row is the list's last row.
    expect(detailNavHeld(detailPosition(ids, 'r4', { offset: 50, total: 54 }), 'review', { offset: 50, total: 54 }).next).toBe('This is the last review')
    // No total yet (or a smaller one than the rows on screen): the rows on screen are the list.
    expect(detailPosition(ids, 'r2', { total: null }).words).toBe('2 of 4')
    expect(detailPosition(ids, 'r2', { offset: 10, total: 3 }).words).toBe('12 of 14')
  })

  it('names the buttons with the noun', () => {
    expect(detailNavLabel('prev', 'rule')).toBe('Previous rule')
    expect(detailNavLabel('next')).toBe('Next row')
  })
})

describe('keys J / K', () => {
  it('J goes to the next row, K to the previous, in either case', () => {
    expect(DETAIL_NAV_KEYS).toEqual({ prev: 'K', next: 'J' })
    expect(detailNavKey(key('j'), 'other')).toBe('next')
    expect(detailNavKey(key('J'), 'other')).toBe('next')
    expect(detailNavKey(key('k'), 'other')).toBe('prev')
    expect(detailNavKey(key('x'), 'other')).toBeNull()
    expect(detailNavKey(key('ArrowDown'), 'other')).toBeNull()
  })

  it('never takes a letter from a text field, a grid or a list', () => {
    expect(detailNavKey(key('j'), 'text')).toBeNull()
    expect(detailNavKey(key('j'), 'grid')).toBeNull()
    expect(detailNavKey(key('k'), 'list')).toBeNull()
  })

  it('never fires with Ctrl, Alt or Cmd held, or while an input method composes', () => {
    expect(detailNavKey(key('j', { ctrlKey: true }), 'other')).toBeNull()
    expect(detailNavKey(key('j', { altKey: true }), 'other')).toBeNull()
    expect(detailNavKey(key('k', { metaKey: true }), 'other')).toBeNull()
    expect(detailNavKey(key('j', { isComposing: true }), 'other')).toBeNull()
  })

  it('classifies text fields before grids and lists', () => {
    expect(KEY_TARGET_SELECTORS.map(([kind]) => kind)).toEqual(['text', 'grid', 'list'])
    expect(KEY_TARGET_SELECTORS[0][1]).toContain('input')
    expect(KEY_TARGET_SELECTORS[1][1]).toContain('.ag-root-wrapper')
  })
})

describe('body state', () => {
  it('shows a failed read first, then a read in progress, then the content', () => {
    expect(detailBodyState({ loading: true, error: 'Could not read the rule.' })).toBe('error')
    expect(detailBodyState({ loading: true })).toBe('loading')
    expect(detailBodyState({ loading: false, error: null })).toBe('ready')
    expect(detailBodyState({ error: '' })).toBe('ready')
  })
})

describe('the body keeps its tallest height while open (run 3)', () => {
  it('grows with a taller tab and keeps that height for a shorter one', () => {
    expect(nextTallest(0, 120, Infinity)).toBe(120)
    expect(nextTallest(120, 400, Infinity)).toBe(400)
    expect(nextTallest(400, 90, Infinity)).toBe(400)
  })
  it('never more than the room at the max height, so a short tab does not scroll over empty space', () => {
    expect(nextTallest(0, 2000, 640)).toBe(640)
    expect(nextTallest(640, 3000, 640)).toBe(640)
  })
})

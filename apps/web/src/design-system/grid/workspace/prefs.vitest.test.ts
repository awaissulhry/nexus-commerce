import { describe, expect, it } from 'vitest'

import { defaultPrefs, parseStoredPrefs, samePrefs, visibleOrderFromColumnState, widthsToColumnState, withWidth } from './prefs'
import type { GridColumn } from './types'

const col = (key: string, defaultHidden = false): GridColumn<unknown> => ({ key, label: key, render: () => null, defaultHidden })
const COLS = [col('spend'), col('sales'), col('acos', true), col('clicks')]

describe('stored preferences — every shape the legacy grid ever wrote comes back as it was', () => {
  it('the SGX3 object: visible in order, the two sticky flags', () => {
    const p = parseStoredPrefs(JSON.stringify({ visible: ['sales', 'spend'], stickyFirst: false, stickyLast: true }), COLS)
    expect(p).toEqual({ visible: ['sales', 'spend'], stickyFirst: false, stickyLast: true })
  })
  it('the pre-SGX3 bare string[]: adopts sticky-on, which is what it had', () => {
    expect(parseStoredPrefs(JSON.stringify(['clicks', 'spend']), COLS)).toEqual({ visible: ['clicks', 'spend'], stickyFirst: true, stickyLast: true })
  })
  it('drops keys this column set no longer has rather than trusting them', () => {
    expect(parseStoredPrefs(JSON.stringify({ visible: ['spend', 'gone', 'sales'] }), COLS)?.visible).toEqual(['spend', 'sales'])
  })
  it('a missing sticky flag reads as on (`!== false`), exactly as the legacy reader did', () => {
    const p = parseStoredPrefs(JSON.stringify({ visible: ['spend'] }), COLS)
    expect(p?.stickyFirst).toBe(true)
    expect(p?.stickyLast).toBe(true)
  })
  it('nothing stored, garbage, or no `visible` → null, so the caller falls back to this set\'s defaults', () => {
    expect(parseStoredPrefs(null, COLS)).toBeNull()
    expect(parseStoredPrefs('{not json', COLS)).toBeNull()
    expect(parseStoredPrefs(JSON.stringify({ stickyFirst: true }), COLS)).toBeNull()
    expect(parseStoredPrefs(JSON.stringify(42), COLS)).toBeNull()
  })
  it('widths (the AG-era addition) are kept only for known columns and finite positive numbers; absent when empty', () => {
    const p = parseStoredPrefs(JSON.stringify({ visible: ['spend'], widths: { spend: 120.4, gone: 90, sales: -1, clicks: 'x', __first: 320 } }), COLS)
    expect(p?.widths).toEqual({ spend: 120.4, __first: 320 })
    expect(parseStoredPrefs(JSON.stringify({ visible: ['spend'], widths: { gone: 90 } }), COLS)?.widths).toBeUndefined()
  })
  it('defaults: every column not `defaultHidden`, in declared order, sticky on', () => {
    expect(defaultPrefs(COLS)).toEqual({ visible: ['spend', 'sales', 'clicks'], stickyFirst: true, stickyLast: true })
  })
})

describe('header drag → the visible order; header resize → widths', () => {
  it('reads AG\'s display order, keeping known shown columns only', () => {
    const state = [
      { colId: 'ag-Grid-SelectionColumn', hide: false }, { colId: '__first', hide: false },
      { colId: 'sales', hide: false }, { colId: 'spend', hide: false }, { colId: 'acos', hide: true }, { colId: 'clicks', hide: false },
    ]
    expect(visibleOrderFromColumnState(state, new Set(COLS.map((c) => c.key)))).toEqual(['sales', 'spend', 'clicks'])
  })
  it('a resize is rounded and folded in; a null or repeated width changes nothing (identity kept)', () => {
    const p = defaultPrefs(COLS)
    const q = withWidth(p, 'spend', 133.6)
    expect(q.widths).toEqual({ spend: 134 })
    expect(withWidth(q, 'spend', 134)).toBe(q)
    expect(withWidth(q, 'sales', null)).toBe(q)
    expect(withWidth(q, 'sales', 0)).toBe(q)
  })
  it('widths become an applyColumnState payload that states nothing else', () => {
    expect(widthsToColumnState({ ...defaultPrefs(COLS), widths: { spend: 134, __first: 320 } })).toEqual([{ colId: 'spend', width: 134 }, { colId: '__first', width: 320 }])
    expect(widthsToColumnState(defaultPrefs(COLS))).toEqual([])
  })
  it('samePrefs compares order, flags and widths', () => {
    const a = defaultPrefs(COLS)
    expect(samePrefs(a, { ...a })).toBe(true)
    expect(samePrefs(a, { ...a, visible: ['sales', 'spend', 'clicks'] })).toBe(false)
    expect(samePrefs(a, { ...a, stickyLast: false })).toBe(false)
    expect(samePrefs(a, { ...a, widths: { spend: 1 } })).toBe(false)
    expect(samePrefs({ ...a, widths: { spend: 1 } }, { ...a, widths: { spend: 1 } })).toBe(true)
  })
})

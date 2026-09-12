import { describe, expect, it } from 'vitest'

import { defaultPrefs, parseStoredPrefs, reconcileStoredPrefs, serializePrefs, visibleOrderFromColumnState, withWidth } from './prefs'

const TOGGLABLE = ['status', 'type', 'spend', 'acos']
const LOCKED = ['acos']
const input = { togglableKeys: TOGGLABLE, defaultLockedKeys: LOCKED }

describe('the stored shape is the legacy DataGrid\'s (PreferencesValue + knownColumns), byte for byte', () => {
  it('defaults: every togglable column visible, the developer\'s locks, sticky on, the three inert fields', () => {
    expect(defaultPrefs(TOGGLABLE, LOCKED)).toEqual({
      visibleColumns: TOGGLABLE, lockedColumns: LOCKED, stickyFirstColumn: true, stickyLastColumn: true, pageSize: 100, sortBy: '', sortDir: 'desc',
    })
  })
  it('serialises exactly what DataGrid.tsx:429 wrote — `{ ...prefs, knownColumns }`, no `widths` key on a never-resized view', () => {
    const legacy = JSON.stringify({ ...defaultPrefs(TOGGLABLE, LOCKED), knownColumns: TOGGLABLE })
    expect(serializePrefs(defaultPrefs(TOGGLABLE, LOCKED), TOGGLABLE)).toBe(legacy)
    expect(serializePrefs({ ...defaultPrefs(TOGGLABLE, LOCKED), widths: {} }, TOGGLABLE)).toBe(legacy)
  })
  it('a resized view carries `widths` after the legacy fields', () => {
    const s = JSON.parse(serializePrefs({ ...defaultPrefs(TOGGLABLE, LOCKED), widths: { spend: 120 } }, TOGGLABLE))
    expect(s.widths).toEqual({ spend: 120 })
    expect(s.knownColumns).toEqual(TOGGLABLE)
  })
  it('parses under a try: nothing, garbage and `null` read as nothing stored; a primitive as an empty record', () => {
    expect(parseStoredPrefs(null)).toBeNull()
    expect(parseStoredPrefs('')).toBeNull()
    expect(parseStoredPrefs('{not json')).toBeNull()
    expect(parseStoredPrefs('null')).toBeNull()
    expect(parseStoredPrefs('42')).toEqual({})
    expect(parseStoredPrefs('{"visibleColumns":["spend"]}')).toEqual({ visibleColumns: ['spend'] })
  })
})

describe('reconcileStoredPrefs — DataGrid.tsx:354-418, the operator\'s view comes back as it was', () => {
  it('keeps the saved visible order, drops keys the roster no longer has', () => {
    const { patch } = reconcileStoredPrefs({ visibleColumns: ['acos', 'gone', 'status'], knownColumns: TOGGLABLE }, input)
    expect(patch.visibleColumns).toEqual(['acos', 'status'])
  })
  it('a column hidden ON PURPOSE (in knownColumns, not visible) stays hidden; a column shipped since (not in knownColumns) appears at its canonical index', () => {
    const saved = { visibleColumns: ['status', 'acos'], knownColumns: ['status', 'type', 'acos'] } // `spend` shipped since; `type` hidden on purpose
    expect(reconcileStoredPrefs(saved, input).patch.visibleColumns).toEqual(['status', 'spend', 'acos'])
  })
  it('without knownColumns (prefs written before the field) every absent column is appended at its canonical place — no worse than before', () => {
    expect(reconcileStoredPrefs({ visibleColumns: ['acos'] }, input).patch.visibleColumns).toEqual(['status', 'type', 'spend', 'acos'])
  })
  it('locks: the saved set filtered to known keys; absent ⇒ the developer\'s defaults', () => {
    expect(reconcileStoredPrefs({ visibleColumns: [], lockedColumns: ['spend', 'gone'] }, input).patch.lockedColumns).toEqual(['spend'])
    expect(reconcileStoredPrefs({ visibleColumns: [] }, input).patch.lockedColumns).toEqual(['acos'])
  })
  it('sticky toggles read as on unless saved false (`!== false`)', () => {
    const { patch } = reconcileStoredPrefs({ visibleColumns: [], stickyFirstColumn: false }, input)
    expect(patch.stickyFirstColumn).toBe(false)
    expect(patch.stickyLastColumn).toBe(true)
  })
  it('a saved sort is restored ONLY when the caller offers that field, and the rows are told to move', () => {
    const saved = { visibleColumns: TOGGLABLE, sortBy: 'spend', sortDir: 'asc' as const }
    const off = reconcileStoredPrefs(saved, input)
    expect(off.restoredSort).toBeNull()
    expect(off.patch.sortBy).toBeUndefined()
    const on = reconcileStoredPrefs(saved, { ...input, prefsSortFields: [{ value: 'spend', label: 'Spend' }] })
    expect(on.restoredSort).toEqual({ key: 'spend', dir: 'asc' })
    expect(on.patch.sortBy).toBe('spend')
    expect(on.patch.sortDir).toBe('asc')
    // a key no longer offered must not sort the grid by nothing
    expect(reconcileStoredPrefs(saved, { ...input, prefsSortFields: [{ value: 'acos', label: 'ACoS' }] }).restoredSort).toBeNull()
    // an unknown direction reads as desc, as the legacy read it
    expect(reconcileStoredPrefs({ ...saved, sortDir: 'sideways' as unknown as 'asc' }, { ...input, prefsSortFields: [{ value: 'spend', label: 'Spend' }] }).restoredSort).toEqual({ key: 'spend', dir: 'desc' })
  })
  it('widths (the AG-era field) survive only for known columns and finite positive numbers; absent when empty', () => {
    expect(reconcileStoredPrefs({ visibleColumns: [], widths: { spend: 120.4, gone: 90, type: -1, acos: 'x' as unknown as number } }, input).patch.widths).toEqual({ spend: 120.4 })
    expect(reconcileStoredPrefs({ visibleColumns: [], widths: { gone: 90 } }, input).patch.widths).toBeUndefined()
    expect(reconcileStoredPrefs({ visibleColumns: [] }, input).patch.widths).toBeUndefined()
  })
})

describe('the header as an input to the preferences', () => {
  it('a drag: the togglable, shown columns in AG\'s display order (the checkbox and pinned columns are not in `visibleColumns`)', () => {
    const state = [
      { colId: '__ck' }, { colId: 'name' }, { colId: 'acos' }, { colId: 'status', hide: false }, { colId: 'type', hide: true }, { colId: 'spend' }, { colId: 'actions' },
    ]
    expect(visibleOrderFromColumnState(state, new Set(TOGGLABLE))).toEqual(['acos', 'status', 'spend'])
  })
  it('a resize: rounded, only for a real width, untouched when unchanged', () => {
    const p = defaultPrefs(TOGGLABLE, LOCKED)
    expect(withWidth(p, 'spend', 120.4).widths).toEqual({ spend: 120 })
    expect(withWidth(p, 'spend', null)).toBe(p)
    expect(withWidth(p, 'spend', 0)).toBe(p)
    const w = withWidth(p, 'spend', 120)
    expect(withWidth(w, 'spend', 120.2)).toBe(w)
  })
})

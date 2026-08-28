import { describe, expect, it } from 'vitest'
import type { ColumnState } from 'ag-grid-community'
import { AG_AUTO_COL, AG_SELECTION_COL, columnStateToPrefs, prefsToColumnState, type PrefsBridgeOptions } from './columnPrefs'
import type { PreferencesValue } from '@/design-system/patterns/PreferencesModal'

// The products page's shape: product (locked, tree) · movable… · actions (locked)
const O: PrefsBridgeOptions = {
  columns: [
    { key: 'product', locked: true },
    { key: 'channels' }, { key: 'status' }, { key: 'tags' }, { key: 'available' }, { key: 'price' },
    { key: 'actions', locked: true },
  ],
  treeColumnKey: 'product',
  sortKeyToColumn: { product: 'product', available: 'available', price: 'price' },
}
const P = (over: Partial<PreferencesValue> = {}): PreferencesValue => ({
  visibleColumns: ['channels', 'status', 'tags', 'available', 'price'], lockedColumns: [],
  stickyFirstColumn: false, stickyLastColumn: false, pageSize: 100, sortBy: 'product', sortDir: 'asc', ...over,
})
const ids = (s: ColumnState[]) => s.map((c) => c.colId).join(',')

describe('prefsToColumnState — dialog → grid', () => {
  it('puts the selection column first, locked ends in place, the operator order between', () => {
    const s = prefsToColumnState(P({ visibleColumns: ['price', 'status', 'channels', 'tags', 'available'] }), O)
    expect(ids(s)).toBe(`${AG_SELECTION_COL},${AG_AUTO_COL},price,status,channels,tags,available,actions`)
  })
  it('hides a togglable column left out of visibleColumns and lists it LAST, never drops it', () => {
    const s = prefsToColumnState(P({ visibleColumns: ['channels', 'price'] }), O)
    expect(ids(s)).toBe(`${AG_SELECTION_COL},${AG_AUTO_COL},channels,price,actions,status,tags,available`)
    expect(s.filter((c) => c.hide).map((c) => c.colId)).toEqual(['status', 'tags', 'available'])
  })
  it("maps the dialog's product sort onto AG's auto-group column", () => {
    const s = prefsToColumnState(P({ sortBy: 'product', sortDir: 'desc' }), O)
    const auto = s.find((c) => c.colId === AG_AUTO_COL)!
    expect(auto.sort).toBe('desc'); expect(auto.sortIndex).toBe(0)
    expect(s.filter((c) => c.sort).length).toBe(1)
  })
  it('sorts by a movable column when asked', () => {
    const s = prefsToColumnState(P({ sortBy: 'price', sortDir: 'asc' }), O)
    expect(s.find((c) => c.colId === 'price')!.sort).toBe('asc')
    expect(s.find((c) => c.colId === AG_AUTO_COL)!.sort).toBeNull()
  })
  it('pins the locked ends only when the sticky toggles say so', () => {
    const off = prefsToColumnState(P(), O)
    expect(off.find((c) => c.colId === AG_AUTO_COL)!.pinned).toBeNull()
    const on = prefsToColumnState(P({ stickyFirstColumn: true, stickyLastColumn: true }), O)
    expect(on.find((c) => c.colId === AG_AUTO_COL)!.pinned).toBe('left')
    expect(on.find((c) => c.colId === 'actions')!.pinned).toBe('right')
  })
  it('ignores a visibleColumns key that is not a togglable column', () => {
    const s = prefsToColumnState(P({ visibleColumns: ['ghost', 'price'] }), O)
    expect(ids(s)).toBe(`${AG_SELECTION_COL},${AG_AUTO_COL},price,actions,channels,status,tags,available`)
  })
})

describe('columnStateToPrefs — grid → dialog', () => {
  const state: ColumnState[] = [
    { colId: AG_SELECTION_COL }, { colId: AG_AUTO_COL, pinned: 'left' },
    { colId: 'price', sort: 'desc', sortIndex: 0 }, { colId: 'status', hide: true }, { colId: 'channels' },
    { colId: 'tags' }, { colId: 'available', sort: 'asc', sortIndex: 1 }, { colId: 'actions' },
  ]
  it("reads the operator's live order and visibility, dropping the locked ends and AG's own columns", () => {
    const p = columnStateToPrefs(state, P(), O)
    expect(p.visibleColumns).toEqual(['price', 'channels', 'tags', 'available'])
  })
  it('reports the FIRST sort key through the dialog vocabulary and the pinned ends as sticky', () => {
    const p = columnStateToPrefs(state, P(), O)
    expect(p.sortBy).toBe('price'); expect(p.sortDir).toBe('desc')
    expect(p.stickyFirstColumn).toBe(true); expect(p.stickyLastColumn).toBe(false)
  })
  it('maps a sort on the auto-group column back to "product"', () => {
    const p = columnStateToPrefs([{ colId: AG_AUTO_COL, sort: 'asc', sortIndex: 0 }, { colId: 'price' }], P({ sortBy: 'price' }), O)
    expect(p.sortBy).toBe('product'); expect(p.sortDir).toBe('asc')
  })
  it('keeps the previous sort when the grid has none, and carries pageSize/lockedColumns through', () => {
    const p = columnStateToPrefs([{ colId: 'price' }, { colId: 'channels' }], P({ sortBy: 'available', sortDir: 'desc', pageSize: 500, lockedColumns: ['tags'] }), O)
    expect(p.sortBy).toBe('available'); expect(p.sortDir).toBe('desc'); expect(p.pageSize).toBe(500); expect(p.lockedColumns).toEqual(['tags'])
  })
  it('round-trips: dialog → grid → dialog is the identity on what the dialog owns', () => {
    const start = P({ visibleColumns: ['tags', 'price', 'channels'], sortBy: 'available', sortDir: 'desc', stickyLastColumn: true })
    const back = columnStateToPrefs(prefsToColumnState(start, O), start, O)
    expect(back.visibleColumns).toEqual(start.visibleColumns)
    expect(back.sortBy).toBe('available'); expect(back.sortDir).toBe('desc')
    expect(back.stickyFirstColumn).toBe(false); expect(back.stickyLastColumn).toBe(true)
  })
})

describe('row grouping and aggregation — column state, both ways', () => {
  const COLS = [{ key: 'product', locked: true }, { key: 'brand' }, { key: 'status' }, { key: 'sales' }, { key: 'units' }, { key: 'actions', locked: true }]
  const O = { columns: COLS, treeColumnKey: 'product' }
  const base = { visibleColumns: ['brand', 'status', 'sales', 'units'], lockedColumns: [], stickyFirstColumn: false, stickyLastColumn: false, pageSize: 100, sortBy: '', sortDir: 'asc' as const }
  it('a grouped column carries rowGroup in order and hides; an aggregated one carries aggFunc', () => {
    const state = prefsToColumnState({ ...base, rowGroups: ['status', 'brand'], aggregations: { sales: 'sum', units: 'max' } }, O)
    const by = Object.fromEntries(state.map((s) => [s.colId, s]))
    expect(by.status).toMatchObject({ rowGroup: true, rowGroupIndex: 0, hide: true })
    expect(by.brand).toMatchObject({ rowGroup: true, rowGroupIndex: 1, hide: true })
    expect(by.sales).toMatchObject({ rowGroup: false, rowGroupIndex: null, aggFunc: 'sum', hide: false })
    expect(by.units.aggFunc).toBe('max'); expect(by['ag-Grid-AutoColumn'].aggFunc).toBeNull()
  })
  it('no grouping asked ⇒ every column says so explicitly, so a previous grouping is cleared', () => {
    const state = prefsToColumnState(base, O)
    expect(state.every((s) => s.rowGroup === false && s.rowGroupIndex === null && s.aggFunc === null)).toBe(true)
  })
  it('reads grouping and aggregation back, and keeps a grouped (hidden) column among the visible ones', () => {
    const state = prefsToColumnState({ ...base, rowGroups: ['brand'], aggregations: { sales: 'avg' } }, O)
    const prefs = columnStateToPrefs(state, { ...base, rowGroups: [], aggregations: {} }, O)
    expect(prefs.rowGroups).toEqual(['brand']); expect(prefs.aggregations).toEqual({ sales: 'avg' })
    expect(prefs.visibleColumns).toEqual(['brand', 'status', 'sales', 'units'])
  })
  it('a caller that never asked for grouping gets no grouping fields back', () => {
    const prefs = columnStateToPrefs(prefsToColumnState(base, O), base, O)
    expect('rowGroups' in prefs).toBe(false); expect('aggregations' in prefs).toBe(false)
  })
})

/**
 * recordNav (Keyword Harvest DS lane H6, 2026-10-10) — Prev / Next in a detail modal walk the rows as the table shows
 * them (filter + sort, every page), and closing the modal returns to the row's cell, on whatever page it is.
 */
import { describe, expect, it, vi } from 'vitest'
import { AG_SELECTION_COL } from './columns/columnPrefs'
import { cellOf, displayedRowIds, landingColumn, pageOfRow, revealRow, type RecordNavGridApi, type RecordNavRowNode } from './recordNav'

const col = (id: string) => ({ getColId: () => id })
function fakeApi(nodes: RecordNavRowNode[], opts: { pagination?: boolean; pageSize?: number; page?: number; cols?: string[]; cursor?: string | null } = {}) {
  let page = opts.page ?? 0
  const api = {
    forEachNodeAfterFilterAndSort: (cb: (n: RecordNavRowNode) => void) => nodes.forEach(cb),
    getRowNode: (id: string) => nodes.find((n) => n.id === id),
    getGridOption: () => opts.pagination ?? false,
    paginationGetPageSize: () => opts.pageSize ?? 100,
    paginationGetCurrentPage: () => page,
    paginationGoToPage: vi.fn((p: number) => { page = p }),
    ensureIndexVisible: vi.fn(),
    setFocusedCell: vi.fn(),
    getFocusedCell: () => (opts.cursor ? { rowIndex: 0, column: col(opts.cursor) } : null),
    getAllDisplayedColumns: () => (opts.cols ?? [AG_SELECTION_COL, 'term', 'orders']).map(col),
    getGridId: () => 'g1',
    isDestroyed: () => false,
  } satisfies RecordNavGridApi
  return api
}
const rows = (n: number): RecordNavRowNode[] => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, rowIndex: i, data: { i } }))

describe('displayedRowIds', () => {
  it('lists every shown row in the order shown, across pages', () => {
    expect(displayedRowIds(fakeApi(rows(120), { pagination: true, pageSize: 50 }))).toHaveLength(120)
    expect(displayedRowIds(fakeApi([{ id: 'b', rowIndex: 0, data: {} }, { id: 'a', rowIndex: 1, data: {} }]))).toEqual(['b', 'a'])
  })
  it('leaves out group rows, pinned rows and rows without data', () => {
    const nodes: RecordNavRowNode[] = [
      { id: 'g', rowIndex: 0, group: true, data: {} },
      { id: 'x', rowIndex: 1, data: {} },
      { id: 'tot', rowIndex: null, rowPinned: 'bottom', data: {} },
      { id: 'empty', rowIndex: 2 },
    ]
    expect(displayedRowIds(fakeApi(nodes))).toEqual(['x'])
  })
  it('a destroyed grid has no rows', () => {
    expect(displayedRowIds({ ...fakeApi(rows(3)), isDestroyed: () => true })).toEqual([])
  })
})

describe('pageOfRow and landingColumn', () => {
  it('pages by the page size; a grid that does not page is page 0', () => {
    expect(pageOfRow(0, 50, true)).toBe(0)
    expect(pageOfRow(49, 50, true)).toBe(0)
    expect(pageOfRow(50, 50, true)).toBe(1)
    expect(pageOfRow(120, 50, false)).toBe(0)
    expect(pageOfRow(10, 0, true)).toBe(0)
  })
  it('lands on the asked column, else the cursor column, else the first column that is not the tick box', () => {
    const shown = [AG_SELECTION_COL, 'term', 'orders']
    expect(landingColumn(shown, 'orders')).toBe('orders')
    expect(landingColumn(shown, 'hidden', 'orders')).toBe('orders')
    expect(landingColumn(shown, null, AG_SELECTION_COL)).toBe('term')
    expect(landingColumn(shown)).toBe('term')
    expect(landingColumn([])).toBeNull()
  })
})

describe('revealRow', () => {
  it('turns to the row\'s page, scrolls to it and puts the cursor on its cell', () => {
    const api = fakeApi(rows(120), { pagination: true, pageSize: 50, page: 0 })
    const frames: Array<() => void> = []
    expect(revealRow(api, 't75', { schedule: (fn) => frames.push(fn), root: { querySelector: () => null } as never })).toEqual({ rowIndex: 75, colId: 'term' })
    expect(api.paginationGoToPage).toHaveBeenCalledWith(1)
    expect(api.ensureIndexVisible).toHaveBeenCalledWith(75)
    expect(api.setFocusedCell).toHaveBeenCalledWith(75, 'term')
  })
  it('stays on the page when the row is on it, and on a grid that does not page', () => {
    const paged = fakeApi(rows(120), { pagination: true, pageSize: 50, page: 1 })
    revealRow(paged, 't60', { focus: false })
    expect(paged.paginationGoToPage).not.toHaveBeenCalled()
    const flatGrid = fakeApi(rows(120))
    revealRow(flatGrid, 't110', { focus: false })
    expect(flatGrid.paginationGoToPage).not.toHaveBeenCalled()
    expect(flatGrid.ensureIndexVisible).toHaveBeenCalledWith(110)
  })
  it('focus: false moves nothing but the view', () => {
    const api = fakeApi(rows(3))
    revealRow(api, 't1', { focus: false })
    expect(api.setFocusedCell).not.toHaveBeenCalled()
  })
  it('a row that is not shown (filtered out) is null — the caller says so', () => {
    const api = fakeApi([{ id: 'gone', rowIndex: null, data: {} }])
    expect(revealRow(api, 'gone')).toBeNull()
    expect(revealRow(api, 'missing')).toBeNull()
    expect(api.ensureIndexVisible).not.toHaveBeenCalled()
  })
  it('once the cell is drawn the cursor is set again, so the browser focus follows', () => {
    const api = fakeApi(rows(120), { pagination: true, pageSize: 50 })
    const frames: Array<() => void> = []
    let drawn = false
    const cell = { contains: () => false }
    const root = { querySelector: () => (drawn ? cell : null) } as never
    revealRow(api, 't80', { schedule: (fn) => frames.push(fn), root })
    expect(api.setFocusedCell).toHaveBeenCalledTimes(1)
    frames.shift()!() // not drawn yet: waits another frame
    expect(api.setFocusedCell).toHaveBeenCalledTimes(1)
    drawn = true
    frames.shift()!()
    expect(api.setFocusedCell).toHaveBeenCalledTimes(2)
    expect(api.setFocusedCell).toHaveBeenLastCalledWith(80, 'term')
  })
})

describe('cellOf', () => {
  it('reveals the row without taking the focus and returns its drawn cell, looked up inside this grid', () => {
    const api = fakeApi(rows(10), { cursor: 'orders' })
    const cell = { id: 'cell' }
    const asked: string[] = []
    const root = { querySelector: (sel: string) => { asked.push(sel); return cell } } as never
    expect(cellOf(api, 't4', { root })).toBe(cell)
    expect(api.setFocusedCell).not.toHaveBeenCalled()
    expect(asked[0]).toContain('[grid-id="g1"]')
    expect(asked[0]).toContain('[row-id="t4"]')
    expect(asked[0]).toContain('[col-id="orders"]')
  })
  it('a row on a page not drawn yet: null now, the cursor once it is drawn', () => {
    const api = fakeApi(rows(120), { pagination: true, pageSize: 50 })
    const frames: Array<() => void> = []
    let drawn = false
    const root = { querySelector: () => (drawn ? { contains: () => false } : null) } as never
    expect(cellOf(api, 't99', { root, schedule: (fn) => frames.push(fn) })).toBeNull()
    expect(api.paginationGoToPage).toHaveBeenCalledWith(1)
    drawn = true
    frames.shift()!()
    expect(api.setFocusedCell).toHaveBeenCalledWith(99, 'term')
  })
})

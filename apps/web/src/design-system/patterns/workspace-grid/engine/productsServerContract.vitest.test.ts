import { describe, expect, it } from 'vitest'

import { buildGridRequest, EMPTY_CONTEXT_FILTERS, type ProductsGridContext } from './productsServerContract'

const CTX: ProductsGridContext = { tile: null, familyId: null, salesDays: 7, filters: EMPTY_CONTEXT_FILTERS }

describe("buildGridRequest — AG's request travels verbatim", () => {
  it('copies the block, the sort model, the group keys and the filter model as AG gave them', () => {
    const fm = { status: { filterType: 'set' as const, values: ['ACTIVE'] }, price: { filterType: 'number' as const, type: 'inRange' as const, filter: 1, filterTo: 9 } }
    const r = buildGridRequest(CTX, { startRow: 100, endRow: 200, sortModel: [{ colId: 'sales', sort: 'desc' }], groupKeys: ['fam_1'], filterModel: fm })
    expect(r.request).toEqual({ startRow: 100, endRow: 200, sortModel: [{ colId: 'sales', sort: 'desc' }], groupKeys: ['fam_1'], filterModel: fm, rowGroupCols: [], valueCols: [] })
  })
  it('keeps NO column table: any column id is passed through for the server to judge', () => {
    const r = buildGridRequest(CTX, { sortModel: [{ colId: 'whatever', sort: 'desc' }], groupKeys: [], filterModel: { whatever: { filterType: 'set', values: [] } } })
    expect(r.request.sortModel.map((s) => s.colId)).toEqual(['whatever'])
    expect(Object.keys(r.request.filterModel)).toEqual(['whatever'])
  })
  it("translates ONE thing: AG's auto-column id becomes the page's `product`, in the sort and the filter alike", () => {
    const text = { filterType: 'text' as const, type: 'contains' as const, filter: 'jacket' }
    const r = buildGridRequest(CTX, { sortModel: [{ colId: 'ag-Grid-AutoColumn', sort: 'asc' }], groupKeys: [], filterModel: { 'ag-Grid-AutoColumn': text } })
    expect(r.request.sortModel).toEqual([{ colId: 'product', sort: 'asc' }])
    expect(r.request.filterModel).toEqual({ product: text })
    expect(JSON.stringify(r)).not.toContain('ag-Grid')
  })
  it('normalises a missing block to the first hundred rows, group keys to strings, no model to {}', () => {
    const r = buildGridRequest(CTX, { sortModel: [], groupKeys: [42] })
    expect(r.request.startRow).toBe(0); expect(r.request.endRow).toBe(100); expect(r.request.groupKeys).toEqual(['42']); expect(r.request.filterModel).toEqual({})
  })
  it('sends the page context as the operator sees it — codes, not ids', () => {
    const r = buildGridRequest({ ...CTX, tile: 'active', familyId: '', filters: { ...EMPTY_CONTEXT_FILTERS, families: ['gale', 'null'] } }, { sortModel: [], groupKeys: [] })
    expect(r.context).toEqual({ tile: 'active', familyId: null, salesDays: 7, filters: { ...EMPTY_CONTEXT_FILTERS, families: ['gale', 'null'] } })
  })
})

describe('buildGridRequest — grouping columns travel as AG names them', () => {
  it('copies rowGroupCols and valueCols with their aggregate', () => {
    const r = buildGridRequest(CTX, { sortModel: [], groupKeys: ['Xavia'], rowGroupCols: [{ id: 'brand', displayName: 'Brand', field: 'brand' }], valueCols: [{ id: 'sales', displayName: 'Sales', field: 'sales.revenueCents', aggFunc: 'sum' }] })
    expect(r.request.rowGroupCols).toEqual([{ id: 'brand', displayName: 'Brand', field: 'brand', aggFunc: null }])
    expect(r.request.valueCols).toEqual([{ id: 'sales', displayName: 'Sales', field: 'sales.revenueCents', aggFunc: 'sum' }])
    expect(r.request.groupKeys).toEqual(['Xavia'])
  })
})

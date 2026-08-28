import type { ProductsGridRequest } from '@nexus/shared/products-grid'
import { describe, expect, it } from 'vitest'

import { gridRequestToListQuery, type GridLookups } from './products-grid.contract.js'

const LOOKUPS: GridLookups = {
  tagIdsByName: new Map([['Bestseller', 'tag_1']]),
  familyIdsByCode: new Map([['gale', 'fam_gale']]),
  stageIdsByCode: new Map([['approved', ['st_a', 'st_b']]]),
}
const CTX_EMPTY = { stock: [], fulfillment: [], families: [], workflowStages: [], missingChannels: [] }
type Over = { request?: Partial<ProductsGridRequest['request']>; context?: Partial<ProductsGridRequest['context']> }
const body = (over: Over = {}): ProductsGridRequest => ({
  request: { startRow: 0, endRow: 100, sortModel: [], groupKeys: [], filterModel: {}, rowGroupCols: [], valueCols: [], ...(over.request ?? {}) },
  context: { tile: null, familyId: null, salesDays: 7, filters: CTX_EMPTY, ...(over.context ?? {}) },
})
const q = (over?: Over) => gridRequestToListQuery(body(over), LOOKUPS)

describe('paging — AG block → page/limit', () => {
  it('maps the first block and always asks for the row shape the grid renders', () => {
    expect(q().query).toMatchObject({ page: '1', limit: '100', includeCoverage: 'true', includeTags: 'true', includeSales: 'true', salesDays: '7' })
  })
  it('maps a later block', () => {
    expect(q({ request: { startRow: 200, endRow: 300 } }).query).toMatchObject({ page: '3', limit: '100' })
  })
  it("clamps the sales window to the list's own range", () => {
    expect(q({ context: { salesDays: 900 } }).query.salesDays).toBe('365')
    expect(gridRequestToListQuery(undefined, LOOKUPS).query.salesDays).toBe('90')
  })
})

describe('tree — expanding a family', () => {
  it("asks for the first ten in the GRID'S sort; the filters that chose the parent do not narrow them", () => {
    const { query } = q({ request: { startRow: 100, endRow: 200, sortModel: [{ colId: 'price', sort: 'desc' }], groupKeys: ['fam_parent'], filterModel: { status: { filterType: 'set', values: ['ACTIVE'] } } }, context: { tile: 'active', filters: { ...CTX_EMPTY, stock: ['out'] } } })
    expect(query).toMatchObject({ parentId: 'fam_parent', page: '1', limit: '10', sorts: 'basePrice:desc' })
    expect(query.sort).toBeUndefined(); expect(query.status).toBeUndefined(); expect(query.stockLevels).toBeUndefined(); expect(query.search).toBeUndefined()
  })
  it('viewing one family as the page keeps paging, sort and filters', () => {
    const { query } = q({ request: { startRow: 100, endRow: 200, sortModel: [{ colId: 'price', sort: 'asc' }], filterModel: { status: { filterType: 'set', values: ['ACTIVE'] } } }, context: { familyId: 'fam_parent' } })
    expect(query).toMatchObject({ parentId: 'fam_parent', page: '2', limit: '100', sorts: 'basePrice:asc', status: 'ACTIVE' })
  })
})

describe('sort — column ids the server owns', () => {
  it('maps every page column, including the tree column and the windowed roll-ups', () => {
    const { query, unsupported } = q({ request: { sortModel: [{ colId: 'product', sort: 'asc' }, { colId: 'available', sort: 'desc' }, { colId: 'sales', sort: 'desc' }, { colId: 'units', sort: 'asc' }] } })
    expect(query.sorts).toBe('name:asc,totalStock:desc,sales:desc,units:asc'); expect(unsupported).toEqual([])
  })
  it('reports a column it cannot order by rather than inventing one', () => {
    const { query, unsupported } = q({ request: { sortModel: [{ colId: 'actions', sort: 'desc' }] } })
    expect(query.sorts).toBeUndefined(); expect(unsupported).toEqual(['sort:actions'])
  })
})

describe("column filters — AG's filterModel", () => {
  it('the Product column text filter is the search', () => {
    expect(q({ request: { filterModel: { product: { filterType: 'text', type: 'contains', filter: '  jacket ' } } } }).query.search).toBe('jacket')
  })
  it("AG's own auto-column id is the CLIENT's to translate; here it is just an unknown column", () => {
    const { query, unsupported } = q({ request: { filterModel: { 'ag-Grid-AutoColumn': { filterType: 'text', type: 'contains', filter: 'x' } }, sortModel: [{ colId: 'ag-Grid-AutoColumn', sort: 'asc' }] } })
    expect(query.search).toBeUndefined(); expect(query.sorts).toBeUndefined()
    expect(unsupported).toEqual(['sort:ag-Grid-AutoColumn', 'filter:ag-Grid-AutoColumn'])
  })
  it('set filters map onto the list keys; tag names resolve to ids and unknown ones are reported', () => {
    const { query, unsupported } = q({ request: { filterModel: {
      status: { filterType: 'set', values: ['ACTIVE', 'DRAFT'] },
      channels: { filterType: 'set', values: ['AMAZON'] },
      brand: { filterType: 'set', values: ['XAVIA'] },
      productType: { filterType: 'set', values: ['COAT'] },
      tags: { filterType: 'set', values: ['Bestseller', 'Ghost'] },
    } } })
    expect(query).toMatchObject({ status: 'ACTIVE,DRAFT', channels: 'AMAZON', brands: 'XAVIA', productTypes: 'COAT', tags: 'tag_1' })
    expect(unsupported).toEqual(['tag:Ghost'])
  })
  it('number filters become min/max in every form AG can send', () => {
    expect(q({ request: { filterModel: { price: { filterType: 'number', type: 'inRange', filter: 10, filterTo: 99 } } } }).query).toMatchObject({ priceMin: '10', priceMax: '99' })
    expect(q({ request: { filterModel: { price: { filterType: 'number', type: 'greaterThanOrEqual', filter: 10 } } } }).query).toMatchObject({ priceMin: '10' })
    expect(q({ request: { filterModel: { available: { filterType: 'number', type: 'lessThanOrEqual', filter: 5 } } } }).query).toMatchObject({ stockMax: '5' })
    expect(q({ request: { filterModel: { available: { filterType: 'number', type: 'equals', filter: 3 } } } }).query).toMatchObject({ stockMin: '3', stockMax: '3' })
    expect(q({ request: { filterModel: { price: { filterType: 'number', type: 'inRange', filter: null, filterTo: 50 } } } }).query).toMatchObject({ priceMax: '50' })
  })
  it('reports a filter on a column that has none, or of the wrong kind, and still answers', () => {
    const { query, unsupported } = q({ request: { filterModel: { actions: { filterType: 'set', values: ['x'] }, price: { filterType: 'set', values: ['9'] } } } })
    expect(unsupported).toEqual(['filter:actions', 'filter:price:set']); expect(query.priceMin).toBeUndefined(); expect(query.page).toBe('1')
  })
  it('the Active tile narrows the status filter; a contradiction is an empty set, not a union', () => {
    expect(q({ context: { tile: 'active' } }).query.status).toBe('ACTIVE')
    expect(q({ context: { tile: 'active' }, request: { filterModel: { status: { filterType: 'set', values: ['DRAFT'] } } } }).query.status).toBe('__none__')
    expect(q({ context: { tile: 'out-of-stock' } }).query.stockLevels).toBe('out')
    expect(q({ context: { tile: 'attention' } }).query.photos).toBe('none')
  })
})

describe('page context — the dimensions that are not columns', () => {
  it('resolves family and stage codes to ids, reports the ones it cannot, passes the rest through', () => {
    const { query, unsupported } = q({ context: { filters: { stock: ['low'], fulfillment: ['FBA'], families: ['gale', 'null', 'nope'], workflowStages: ['approved', 'null', 'zzz'], missingChannels: ['EBAY'] } } })
    expect(query).toMatchObject({ stockLevels: 'low', fulfillment: 'FBA', families: 'fam_gale,null', workflowStages: 'st_a,st_b,null', missingChannels: 'EBAY' })
    expect(unsupported).toEqual(['family:nope', 'stage:zzz'])
  })
})

describe('row grouping — groupKeys is a group path, the server answers a level', () => {
  const groupBy = (ids: string[]) => ids.map((id) => ({ id, displayName: id }))
  it('the top level of a grouping asks for group rows, with the aggregates the operator chose', () => {
    const { query, grouping, unsupported } = q({ request: { rowGroupCols: groupBy(['brand']), valueCols: [{ id: 'sales', aggFunc: 'sum' }, { id: 'available', aggFunc: 'avg' }] } })
    expect(grouping).toEqual({ groupColId: 'brand', aggregations: [{ colId: 'sales', func: 'sum' }, { colId: 'available', func: 'avg' }], sort: { by: 'key', dir: 'asc' } })
    expect(query.brands).toBeUndefined(); expect(unsupported).toEqual([])
  })
  it('an opened group narrows the list to its key, and the next column groups inside it', () => {
    const { query, grouping } = q({ request: { rowGroupCols: groupBy(['brand', 'productType']), groupKeys: ['XAVIA'] } })
    expect(query.brands).toBe('XAVIA'); expect(grouping?.groupColId).toBe('productType')
  })
  it('the deepest level is plain rows: every key applied, no grouping', () => {
    const { query, grouping } = q({ request: { rowGroupCols: groupBy(['brand', 'productType']), groupKeys: ['XAVIA', 'COAT'], filterModel: { status: { filterType: 'set', values: ['ACTIVE'] } } } })
    expect(grouping).toBeUndefined(); expect(query).toMatchObject({ brands: 'XAVIA', productTypes: 'COAT', status: 'ACTIVE', page: '1', limit: '100' })
    expect(query.parentId).toBeUndefined()
  })
  it('a "no brand" group opens as the null literal, never as a family', () => {
    const { query, grouping } = q({ request: { rowGroupCols: groupBy(['brand']), groupKeys: ['__null__'] } })
    expect(query.brands).toBe('__null__'); expect(grouping).toBeUndefined(); expect(query.parentId).toBeUndefined()
  })
  it('sorts group rows by their key, or by an aggregate the level carries', () => {
    expect(q({ request: { rowGroupCols: groupBy(['brand']), sortModel: [{ colId: 'product', sort: 'desc' }] } }).grouping?.sort).toEqual({ by: 'key', dir: 'desc' })
    expect(q({ request: { rowGroupCols: groupBy(['brand']), valueCols: [{ id: 'sales', aggFunc: 'sum' }], sortModel: [{ colId: 'sales', sort: 'desc' }] } }).grouping?.sort).toEqual({ by: 'sales', dir: 'desc' })
    expect(q({ request: { rowGroupCols: groupBy(['brand']), sortModel: [{ colId: 'price', sort: 'desc' }] } }).grouping?.sort).toEqual({ by: 'key', dir: 'asc' })
  })
  it('reports a column it cannot group or aggregate by, and an aggregate it does not know', () => {
    const { grouping, unsupported } = q({ request: { rowGroupCols: groupBy(['tags', 'brand']), valueCols: [{ id: 'tags', aggFunc: 'sum' }, { id: 'sales', aggFunc: 'median' }] } })
    expect(unsupported).toEqual(['group:tags', 'value:tags', 'value:sales:median']); expect(grouping?.groupColId).toBe('brand'); expect(grouping?.aggregations).toEqual([])
  })
})

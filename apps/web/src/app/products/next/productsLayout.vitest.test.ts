import { describe, expect, it } from 'vitest'

import type { PreferencesColumnSpec, PreferencesValue } from '@/design-system/patterns/PreferencesModal'
import { AG_AUTO_COL, AG_SELECTION_COL, type PrefsBridgeOptions } from '@/design-system/grid/columns/columnPrefs'
import type { GridViewPayload } from '@/design-system/grid/hooks/useGridViews'
import { buildProductsLayout, readProductsLayout } from './productsLayout'

const specs: PreferencesColumnSpec[] = [
  { key: 'product', label: 'Product', group: 'Identity', groupKey: 'identity', defaultLocked: true },
  { key: 'brand', label: 'Brand', group: 'Identity', groupKey: 'identity' },
  { key: 'sku', label: 'SKU', group: 'Identity', groupKey: 'identity' },
  { key: 'stock', label: 'Stock', group: 'Inventory', groupKey: 'inventory' },
  { key: 'price', label: 'Price', group: 'Commerce', groupKey: 'commerce' },
  { key: 'actions', label: 'Actions', group: 'Controls', groupKey: 'controls', defaultLocked: true, lockSide: 'right' },
]
const bridge: PrefsBridgeOptions = {
  columns: specs.map((column) => ({ key: column.key, locked: ['product', 'actions'].includes(column.key) })),
  treeColumnKey: 'product',
  sortKeyToColumn: { name: 'product' },
}
const draft = (overrides: Partial<PreferencesValue> = {}): PreferencesValue => ({
  visibleColumns: ['product', 'brand', 'stock', 'price', 'actions'],
  columnOrder: specs.map((column) => column.key),
  lockedColumns: ['actions', 'brand', 'product'],
  groupOrder: ['commerce', 'identity', 'inventory', 'controls'],
  groupOverrides: { stock: 'commerce' },
  stickyFirstColumn: false,
  stickyLastColumn: false,
  pageSize: 25,
  sortBy: '',
  sortDir: 'asc',
  ...overrides,
})
const snapshot = (): GridViewPayload<{
  lockedColumns: string[]; filters: { channel: string }; tile: string; density: string; pageSize: number
}> => ({
  v: 1,
  page: { lockedColumns: ['product', 'actions'], filters: { channel: 'AMAZON' }, tile: 'active', density: 'compact', pageSize: 75 },
  gridState: {
    version: '35.0.0',
    columnOrder: { orderedColIds: [AG_SELECTION_COL, AG_AUTO_COL, 'brand', 'sku', 'stock', 'price', 'actions'] },
    columnPinning: { leftColIds: [AG_SELECTION_COL, AG_AUTO_COL], rightColIds: ['actions'] },
    columnVisibility: { hiddenColIds: ['brand'] },
    columnSizing: { columnSizingModel: [{ colId: AG_AUTO_COL, width: 310 }, { colId: 'price', width: 150, flex: 1 }] },
    filter: { filterModel: { price: { filterType: 'number', type: 'greaterThan', filter: 10 } } },
    sort: { sortModel: [{ colId: 'stock', sort: 'desc' }, { colId: 'price', sort: 'asc' }] },
    rowGroup: { groupColIds: ['brand'] },
    aggregation: { aggregationModel: [{ colId: 'price', aggFunc: 'sum' }] },
    rowGroupExpansion: { expandedRowGroupIds: ['brand:one'] },
    pagination: { page: 2, pageSize: 75 },
    scroll: { top: 120, left: 140 },
    rowSelection: ['selected-for-current-bulk-action'],
  },
})
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    Object.values(value).forEach(freeze)
  }
  return value
}

describe('buildProductsLayout', () => {
  it('stages a complete JSON-roundtrippable group layout without mutating grid, page or draft', () => {
    const before = freeze(snapshot())
    const preferences = freeze(draft({ rowGroups: [], aggregations: {} }))
    const result = buildProductsLayout(before, preferences, specs, bridge)
    const reloaded = JSON.parse(JSON.stringify(result))
    expect(reloaded).toEqual(result)
    expect(readProductsLayout(reloaded)).toEqual(result.page.columnLayout)
    expect(result.page.columnLayout.groupOverrides).toEqual({ stock: 'commerce' })
    expect(result.page.columnLayout.groupOrder).toEqual(['commerce', 'identity', 'inventory', 'controls'])
    expect(result.page.columnLayout.columnOrder).toEqual(specs.map((column) => column.key))
    expect(result.page.columnLayout.columns).toEqual(['stock', 'price', 'product', 'brand', 'actions'])
    expect(result.gridState.columnOrder?.orderedColIds).toEqual([AG_SELECTION_COL, AG_AUTO_COL, 'brand', 'stock', 'price', 'actions', 'sku'])
    expect(result.gridState.columnVisibility?.hiddenColIds).toEqual(['sku'])
    expect(result.page).toMatchObject({ filters: before.page.filters, tile: 'active', density: 'compact', pageSize: 75 })
    expect(result.gridState.columnSizing).toEqual(before.gridState.columnSizing)
    expect(result.gridState.filter).toEqual(before.gridState.filter)
    expect(result.gridState.scroll).toEqual(before.gridState.scroll)
    expect(result.gridState.pagination).toEqual(before.gridState.pagination)
    expect(before).toEqual(snapshot())
    expect(preferences).toEqual(draft({ rowGroups: [], aggregations: {} }))
  })

  it('pins Product left, Actions right and operator columns between them despite stale sticky flags', () => {
    const result = buildProductsLayout(snapshot(), draft(), specs, bridge)
    expect(result.page.lockedColumns).toEqual(['product', 'brand', 'actions'])
    expect(result.page.columnLayout.lockedColumns).toEqual(['product', 'brand', 'actions'])
    expect(result.gridState.columnPinning).toEqual({ leftColIds: [AG_SELECTION_COL, AG_AUTO_COL, 'brand'], rightColIds: ['actions'] })
  })

  it('unlocks both bookends using the confirmed locks and allows them to be hidden', () => {
    const result = buildProductsLayout(snapshot(), draft({ lockedColumns: [], visibleColumns: ['stock', 'price'] }), specs, bridge)
    expect(result.page.lockedColumns).toEqual([])
    expect(result.page.columnLayout.lockedColumns).toEqual([])
    expect(result.gridState.columnPinning).toEqual({ leftColIds: [AG_SELECTION_COL], rightColIds: [] })
    expect(result.gridState.columnVisibility?.hiddenColIds).toEqual(expect.arrayContaining([AG_AUTO_COL, 'actions']))
    expect(result.page.columnLayout.columnOrder).toContain('product')
    expect(result.page.columnLayout.columnOrder).toContain('actions')
  })

  it('projects explicit row grouping and aggregations and preserves filters and unrelated layout state', () => {
    const before = snapshot()
    const result = buildProductsLayout(before, draft({ rowGroups: ['stock', 'brand'], aggregations: { price: 'avg', stock: 'max' } }), specs, bridge)
    expect(result.gridState.rowGroup).toEqual({ groupColIds: ['stock', 'brand'] })
    expect(result.gridState.aggregation?.aggregationModel).toEqual(expect.arrayContaining([{ colId: 'price', aggFunc: 'avg' }, { colId: 'stock', aggFunc: 'max' }]))
    expect(result.gridState.columnVisibility?.hiddenColIds).toEqual(expect.arrayContaining(['stock', 'brand']))
    expect(result.gridState.filter).toEqual(before.gridState.filter)
    expect(result.gridState.rowGroupExpansion).toEqual(before.gridState.rowGroupExpansion)
    const cleared = buildProductsLayout(before, draft({ rowGroups: [], aggregations: {} }), specs, bridge)
    expect(cleared.gridState.rowGroup).toEqual({ groupColIds: [] })
    expect(cleared.gridState.aggregation).toEqual({ aggregationModel: [] })
  })

  it('keeps grouping, aggregation and header sort when the modal did not supply replacements', () => {
    const before = snapshot()
    const result = buildProductsLayout(before, draft(), specs, bridge)
    expect(result.gridState.rowGroup).toEqual(before.gridState.rowGroup)
    expect(result.gridState.columnVisibility?.hiddenColIds).toContain('brand')
    expect(result.gridState.aggregation).toEqual(before.gridState.aggregation)
    expect(result.gridState.sort).toEqual(before.gridState.sort)
    const sorted = buildProductsLayout(before, draft({ sortBy: 'name', sortDir: 'desc' }), specs, bridge)
    expect(sorted.gridState.sort).toEqual({ sortModel: [{ colId: AG_AUTO_COL, sort: 'desc' }] })
  })

  it('does not persist temporary bulk selection or mutate the current selection', () => {
    const before = snapshot()
    const result = buildProductsLayout(before, draft(), specs, bridge)
    expect(result.gridState).not.toHaveProperty('rowSelection')
    expect(JSON.parse(JSON.stringify(result)).gridState).not.toHaveProperty('rowSelection')
    expect(before.gridState.rowSelection).toEqual(['selected-for-current-bulk-action'])
  })
})

describe('readProductsLayout', () => {
  it('returns null for legacy views, malformed layouts and other payload kinds', () => {
    for (const value of [null, [], 'view', snapshot(), { v: 3, kind: 'columns', columns: [] }, { v: 1, page: { columnLayout: { v: 3, columns: [] } } }]) {
      expect(readProductsLayout(value)).toBeNull()
    }
  })
})

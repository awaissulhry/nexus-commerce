/**
 * The products grid's request — AG's own, verbatim, plus the page's context.
 *
 * "Own the server contract" means the SERVER owns it: `POST /api/products/grid` receives the
 * Server-Side Row Model's request (`startRow`, `endRow`, `sortModel`, `groupKeys`, `filterModel`)
 * as AG produced it, together with what the page knows and the grid does not — the KPI tile, and
 * the accordion dimensions that are not columns (stock level, fulfilment, family, workflow stage,
 * missing channel). Column-backed filters — Product search, Status, Channels, Brand, Product
 * type, Tags, Price, Available — are AG column filters and travel in `filterModel`, so a saved
 * view, the header menu and the accordion all read ONE state.
 *
 * ONE translation happens here, and it is the client's to make: AG names its auto-group (tree)
 * column `ag-Grid-AutoColumn` whatever colId the page gives it. That is an AG implementation
 * detail, so it is mapped back to the page's `product` id before the request leaves the browser
 * — the shared contract and the server never learn AG's naming.
 *
 * The shapes are declared once, in `@nexus/shared/products-grid`, for both apps. Nothing else is
 * translated: no column table, no id maps — the server resolves names and reports what it
 * cannot express in `unsupported`.
 *
 * Pure, so it is unit-tested; the datasource is a thin caller.
 */
import type { SortModelItem } from '@/design-system/grid'

import { PRODUCT_COLUMN_ID, type GridColumnVO, type GridFilterModel, type ProductsGridContext, type ProductsGridRequest } from '@nexus/shared/products-grid'

import { AG_AUTO_COL } from '@/design-system/grid/columns/columnPrefs'

export type {
  AggFunc,
  GridColumnVO,
  GridFilterModel,
  GridFilterModelEntry,
  GridNumberFilterModel,
  GridSetFilterModel,
  GridTextFilterModel,
  KpiTile,
  ProductGridContextFilters,
  ProductsGridContext,
  ProductsGridRequest,
  ProductGroupRow,
  ProductsGridResponse,
  ProductsListStats,
} from '@nexus/shared/products-grid'
export { AGG_FUNCS, EMPTY_CONTEXT_FILTERS, GRID_FILTER_COLUMNS, GRID_GROUP_COLUMNS, GRID_VALUE_COLUMNS, NULL_GROUP_KEY, PRODUCT_COLUMN_ID } from '@nexus/shared/products-grid'

/** AG's auto-column id → the page's Product column id; every other id passes through. */
export const wireColId = (colId: string): string => (colId === AG_AUTO_COL ? PRODUCT_COLUMN_ID : colId)

/** One block's worth of AG request, normalised, plus the page's context. */
export function buildGridRequest(
  context: ProductsGridContext,
  request: {
    startRow?: number
    endRow?: number
    sortModel: readonly SortModelItem[]
    groupKeys: readonly unknown[]
    filterModel?: unknown
    rowGroupCols?: readonly GridColumnVO[]
    valueCols?: readonly GridColumnVO[]
  },
): ProductsGridRequest {
  const startRow = Math.max(0, request.startRow ?? 0)
  const endRow = Math.max(startRow + 1, request.endRow ?? startRow + 100)
  // AG hands the model over as a plain object keyed by column id; an empty object is "no filter".
  const raw = (request.filterModel && typeof request.filterModel === 'object' ? request.filterModel : {}) as GridFilterModel
  const filterModel: GridFilterModel = {}
  for (const [colId, entry] of Object.entries(raw)) filterModel[wireColId(colId)] = entry
  return {
    request: {
      startRow,
      endRow,
      sortModel: request.sortModel.map((s) => ({ colId: wireColId(s.colId), sort: s.sort })),
      groupKeys: request.groupKeys.map((k) => String(k)),
      filterModel,
      rowGroupCols: (request.rowGroupCols ?? []).map((c) => ({ id: c.id, displayName: c.displayName, field: c.field, aggFunc: c.aggFunc ?? null })),
      valueCols: (request.valueCols ?? []).map((c) => ({ id: c.id, displayName: c.displayName, field: c.field, aggFunc: c.aggFunc ?? null })),
    },
    context: {
      tile: context.tile,
      familyId: context.familyId || null,
      salesDays: context.salesDays,
      filters: context.filters,
    },
  }
}

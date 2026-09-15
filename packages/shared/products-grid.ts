// PN.2 — the products grid's server contract, ONE declaration for both apps.
//
// apps/api answers `POST /api/products/grid` with these shapes; apps/web's datasource posts them.
// A field that exists here exists for both, or for neither — the drift a copied type invites
// (two `ProductFilters`, one per app) is what this module removes.
//
// The request is AG Grid's Server-Side Row Model request, verbatim, plus what only the page
// knows. Column-backed filters travel in AG's own `filterModel` (the server owns what each column
// id means); dimensions that are not columns — the KPI tile, stock level, fulfilment, family,
// workflow stage, missing channel — travel as page context.

export type KpiTile = 'active' | 'out-of-stock' | 'attention' | null

/** The accordion dimensions that are NOT grid columns, as the operator sees them (codes). */
export interface ProductGridContextFilters {
  /** Stock level buckets: 'in' | 'low' | 'out'. */
  stock: string[]
  fulfillment: string[]
  /** Family CODES; 'null' is the server's own literal for "no family". */
  families: string[]
  /** Workflow-stage CODES; 'null' likewise. */
  workflowStages: string[]
  missingChannels: string[]
  /**
   * VT.4b — the `Variation mapping` dimension (VX §11.4), as `derived | rule | overridden | unset | collides`
   * (`docs/vt1-contracts.md` §5).
   *
   * It travels as page CONTEXT and not as an AG column filter because it is not a column: the values come from
   * `ReadinessIndex.variationSource` (provenance) and `ReadinessIndex.missing[].kind` (`theme-unset` /
   * `collision`) — VT.1b's column and LX.F's field. The server narrows on it in
   * `list-products.service.ts` via `restrictVariationMapping`, so the grid and `GET /api/products` can never
   * disagree about what the word means.
   */
  variationMapping: string[]
}

export interface ProductsGridContext {
  language?: string
  tile: KpiTile
  /** Viewing ONE family as the page: its variations are the top level, paged and sorted. */
  familyId: string | null
  salesDays: number
  filters: ProductGridContextFilters
}

export type CatalogLanguageField = 'title' | 'description' | 'readiness' | 'fallback'
export function catalogLanguageColumn(key: string): { field: CatalogLanguageField; language: string } | null {
  const match = /^(title|description|readiness|fallback)@([a-z]{2,3})$/.exec(key)
  return match ? { field: match[1] as CatalogLanguageField, language: match[2] } : null
}
export interface CatalogContentCell {
  value: unknown
  tier: 'pin' | 'language' | 'source' | 'computed'
  language: string
  requested: string
  provenance: { member: import('./cell-provenance.js').CellProvenance; from: string | null }
  translation?: { source: 'manual' | 'ai' | 'translated'; reviewedAt: string | null; outdated: boolean }
}
export interface CatalogLanguageProjection {
  title: CatalogContentCell
  description: CatalogContentCell
  // LX.F F2 / R-LX-9 — the FIFTH member. `notComputed` (no `ReadinessIndex` row for
  // this coordinate and language) is not `absent` ("nothing set up here"), and the
  // producer has written it since R-LX-9; this contract said otherwise and only a
  // cast at `catalog-language.ts:51` kept tsc quiet about it.
  readiness: { state: 'ready' | 'warn' | 'blocked' | 'absent' | 'notComputed'; pct: number | null; computedAt: string | null }
  fallsBackToSource: boolean | null
}
export type CatalogTranslateScope = { kind: 'grid'; grid: ProductsGridRequest } | { kind: 'readiness'; query: Record<string, string> }
export interface CatalogTranslateInput { scope: CatalogTranslateScope; language: string; fields: string[] }
export interface CatalogTranslatePreview {
  token: string
  language: string
  fields: string[]
  total: number
  getDraft: number
  alreadyHave: number
  skipped: number
  reach: string
  destinations: string[]
  estimates: Array<{ provider: string; model: string; usd: number; inputTokens: number; outputTokens: number }>
  generationEnabled: false
  gate: string
}

// ── AG's filter model, the three shapes this grid uses ────────────────────────────────────────
export interface GridSetFilterModel {
  filterType: 'set'
  values: string[]
}
export interface GridNumberFilterModel {
  filterType: 'number'
  type: 'inRange' | 'greaterThanOrEqual' | 'lessThanOrEqual' | 'equals'
  filter: number | null
  filterTo?: number | null
}
export interface GridTextFilterModel {
  filterType: 'text'
  type: 'contains'
  filter: string
}
export type GridFilterModelEntry = GridSetFilterModel | GridNumberFilterModel | GridTextFilterModel
export type GridFilterModel = Record<string, GridFilterModelEntry>

/**
 * The Product column's id on the wire. AG renders it as its auto-group (tree) column and names
 * that `ag-Grid-AutoColumn` whatever colId the page gives it; the CLIENT maps AG's id back to
 * this one before the request leaves the browser, so the server never learns AG's naming.
 */
export const PRODUCT_COLUMN_ID = 'product'

/** Column ids that carry a column filter, and the filter each takes. */
export const GRID_FILTER_COLUMNS = {
  product: 'text',
  status: 'set',
  channels: 'set',
  brand: 'set',
  productType: 'set',
  tags: 'set',
  price: 'number',
  available: 'number',
} as const
export type GridFilterColumnId = keyof typeof GRID_FILTER_COLUMNS

// ── Row grouping and aggregation ──────────────────────────────────────────────────────────────
export type AggFunc = 'sum' | 'avg' | 'min' | 'max' | 'count'
export const AGG_FUNCS: readonly AggFunc[] = ['sum', 'avg', 'min', 'max', 'count']

/** Columns the server can group rows by → the list filter that selects one group's rows. */
export const GRID_GROUP_COLUMNS = {
  brand: 'brands',
  productType: 'productTypes',
  status: 'status',
} as const
export type GridGroupColumnId = keyof typeof GRID_GROUP_COLUMNS

/** Columns the server can aggregate → the measure behind each. */
export const GRID_VALUE_COLUMNS = {
  available: 'totalStock',
  price: 'basePrice',
  sales: 'sales',
  units: 'units',
} as const
export type GridValueColumnId = keyof typeof GRID_VALUE_COLUMNS

/** The literal a "no value" group key travels as — a null brand cannot be a URL value. */
export const NULL_GROUP_KEY = '__null__'

/** AG's `ColumnVO`: a column taking part in grouping (`rowGroupCols`) or aggregation (`valueCols`). */
export interface GridColumnVO {
  id: string
  displayName?: string
  field?: string
  aggFunc?: string | null
}

/**
 * A group row, as the server answers a grouped level. The aggregated measures sit under the
 * same fields a product row carries, so a column renders a group the way it renders a product.
 */
export interface ProductGroupRow {
  id: string
  __group: true
  /** The grouped column's id and this group's key (`NULL_GROUP_KEY` for "no value"). */
  groupColId: GridGroupColumnId
  groupKey: string
  childCount: number
  totalStock?: number
  basePrice?: number
  /** Present only when a Sales aggregate was asked for; `units` inside is the units aggregate or 0. */
  sales?: { revenueCents: number | null; units: number; days: number }
  /** Present only when a Units aggregate was asked for. */
  units?: number
  brand?: string
  productType?: string
  status?: string
}

/** The subset of AG's `IServerSideGetRowsRequest` the server reads. */
export interface ProductsGridRowsRequest {
  startRow: number
  endRow: number
  sortModel: Array<{ colId: string; sort: 'asc' | 'desc' }>
  /**
   * With no `rowGroupCols`: the family tree — the id of the parent being expanded. With
   * `rowGroupCols`: the group path — one key per grouped column already opened.
   */
  groupKeys: string[]
  filterModel: GridFilterModel
  rowGroupCols: GridColumnVO[]
  valueCols: GridColumnVO[]
}

export interface ProductsGridRequest {
  request: ProductsGridRowsRequest
  context: ProductsGridContext
}

export interface ProductsListStats {
  total: number
  active: number
  draft: number
  inStock: number
  outOfStock: number
}

export interface ProductsGridResponse<TRow = unknown> {
  rows: TRow[]
  rowCount: number
  stats: ProductsListStats
  salesUnattributed: Array<{ channel: string; orders: number; units: number; revenueCents: number }> | null
  /** What the server could not express — a tag name with no tag, a column with no order or filter. */
  unsupported: string[]
}

export const EMPTY_CONTEXT_FILTERS: ProductGridContextFilters = {
  stock: [], fulfillment: [], families: [], workflowStages: [], missingChannels: [], variationMapping: [],
}

export interface CatalogTranslationRun { id: string; status: string; productCount: number; changeCount: number; createdAt: string; completedAt: string | null }

// apps/web/src/app/products/next/inventoryEditor.logic.ts
//
// The inventory editor's pure model: what a row is, which locations may be edited, how a set of
// PENDING edits sits over the server's numbers, and what the totals row says. Everything the
// grid and the modal compute is here, so it is tested rather than trusted.

/** Location types whose stock we never let the operator edit from the grid. */
export const READONLY_LOCATION_TYPES = new Set(['AMAZON_FBA', 'SHOPIFY_LOCATION'])

export function isLocationEditable(type: string): boolean {
  return !READONLY_LOCATION_TYPES.has(type)
}

export const REASON_OPTIONS = [
  { value: 'MANUAL_ADJUSTMENT', label: 'Manual adjustment' },
  { value: 'INVENTORY_COUNT', label: 'Inventory count' },
  { value: 'WRITE_OFF', label: 'Write-off / damage' },
] as const

export const DEFAULT_REASON = 'MANUAL_ADJUSTMENT'

/** The products grid's own threshold when a row does not carry one. */
export const DEFAULT_LOW_STOCK_THRESHOLD = 10

/** Low-stock → status color token; mirrors the grid cell coloring. */
export function getStockColor(qty: number, threshold: number): string {
  if (qty === 0) return 'var(--nds-danger)'
  if (qty <= threshold) return 'var(--nds-warning)'
  return 'var(--nds-success)'
}

/** Low-stock as a WORD, for a class name rather than a colour. */
export function stockLevelOf(qty: number, threshold: number): 'out' | 'low' | 'ok' {
  if (qty === 0) return 'out'
  if (qty <= threshold) return 'low'
  return 'ok'
}

export type SyncStatus = 'SYNCED' | 'PENDING' | 'FAILED'

export interface LevelCell {
  quantity: number
  reserved: number
  available: number
  syncStatus?: SyncStatus | null
}

export interface RawLocation {
  id: string
  code: string
  name: string
  type: string
}

export interface RawListLevel {
  location: { id: string; code: string; name: string; type: string }
  quantity: number
  reserved: number
  available: number
  syncStatus?: string | null
}

export interface RawFamilyChildLevel {
  locationId: string
  locationCode: string
  locationType: string
  quantity: number
  reserved: number
  available: number
  syncStatus?: string | null
}
export interface RawFamilyChild {
  id: string
  sku: string
  name: string
  thumbnailUrl: string | null
  lowStockThreshold?: number | null
  stockLevels: RawFamilyChildLevel[]
}

export interface MatrixColumn {
  locationId: string
  locationCode: string
  locationName: string
  locationType: string
  editable: boolean
}
export interface MatrixRow {
  productId: string
  sku: string
  name: string
  thumbnailUrl: string | null
  lowStockThreshold: number
  cells: Record<string, LevelCell>
}
/** ONE shape for both cases: a family's variations, or a single product as a one-row family. */
export interface MatrixModel {
  columns: MatrixColumn[]
  rows: MatrixRow[]
}

const asSync = (s: string | null | undefined): SyncStatus | null =>
  s === 'SYNCED' || s === 'PENDING' || s === 'FAILED' ? s : null

const column = (loc: RawLocation): MatrixColumn => ({
  locationId: loc.id,
  locationCode: loc.code,
  locationName: loc.name,
  locationType: loc.type,
  editable: isLocationEditable(loc.type),
})

/** A family: child products (variations) as rows × active locations as columns. */
export function buildMatrixModel(locations: RawLocation[], children: RawFamilyChild[]): MatrixModel {
  const columns = locations.map(column)
  const rows = children.map((c) => {
    const cells: MatrixRow['cells'] = {}
    for (const sl of c.stockLevels) {
      cells[sl.locationId] = { quantity: sl.quantity, reserved: sl.reserved, available: sl.available, syncStatus: asSync(sl.syncStatus) }
    }
    return { productId: c.id, sku: c.sku, name: c.name, thumbnailUrl: c.thumbnailUrl, lowStockThreshold: c.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD, cells }
  })
  return { columns, rows }
}

/**
 * A single product: the same shape with one row, so the editor has one behaviour. Locations
 * without a level appear as 0 (the "add at location" affordance the list mode used to carry).
 */
export function buildSingleModel(
  product: { id: string; sku: string; name: string; thumbnailUrl: string | null; lowStockThreshold?: number | null },
  levels: RawListLevel[],
  activeLocations: RawLocation[],
): MatrixModel {
  const columns = activeLocations.map(column)
  const cells: MatrixRow['cells'] = {}
  for (const lv of levels) {
    cells[lv.location.id] = { quantity: lv.quantity, reserved: lv.reserved, available: lv.available, syncStatus: asSync(lv.syncStatus) }
  }
  return {
    columns,
    rows: [{ productId: product.id, sku: product.sku, name: product.name, thumbnailUrl: product.thumbnailUrl, lowStockThreshold: product.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD, cells }],
  }
}

export function editorModeForRow(row: { isParent: boolean }): 'matrix' | 'list' {
  return row.isParent ? 'matrix' : 'list'
}

// ── pending edits: what the operator has typed and not yet applied ─────────────────────────

/** One key per (product, location) cell. */
export const pendingKey = (productId: string, locationId: string) => `${productId}:${locationId}`

export type PendingEdits = ReadonlyMap<string, number>

/** The on-hand the grid shows: the pending value if there is one, else the server's. */
export function onHandOf(row: MatrixRow, locationId: string, pending: PendingEdits): number {
  return pending.get(pendingKey(row.productId, locationId)) ?? row.cells[locationId]?.quantity ?? 0
}

/** Available follows on-hand live: on-hand − reserved, never below zero. */
export function availableOf(row: MatrixRow, locationId: string, pending: PendingEdits): number {
  const reserved = row.cells[locationId]?.reserved ?? 0
  return Math.max(0, onHandOf(row, locationId, pending) - reserved)
}

/** The change a pending value represents against the server's number; 0 when none. */
export function deltaOf(row: MatrixRow, locationId: string, pending: PendingEdits): number {
  const v = pending.get(pendingKey(row.productId, locationId))
  if (v === undefined) return 0
  return v - (row.cells[locationId]?.quantity ?? 0)
}

/**
 * Record a typed value. A value equal to the server's is NOT a change — it clears any pending
 * edit for that cell, so "change and change back" leaves nothing to apply. Invalid values
 * (negative, fractional, NaN) are refused: the map is returned untouched.
 */
export function withEdit(pending: PendingEdits, row: MatrixRow, locationId: string, value: unknown): Map<string, number> {
  const next = new Map(pending)
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim())
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return next
  const key = pendingKey(row.productId, locationId)
  if (n === (row.cells[locationId]?.quantity ?? 0)) next.delete(key)
  else next.set(key, n)
  return next
}

/** The batch the server receives: one absolute on-hand per changed cell. */
export function changesOf(pending: PendingEdits): Array<{ productId: string; locationId: string; value: number }> {
  return [...pending.entries()].map(([key, value]) => {
    const i = key.indexOf(':')
    return { productId: key.slice(0, i), locationId: key.slice(i + 1), value }
  })
}

/** Totals per location and overall, over the numbers the grid is SHOWING (pending included). */
export function totalsOf(model: MatrixModel, pending: PendingEdits): { cells: Record<string, LevelCell>; totalAvailable: number } {
  const cells: Record<string, LevelCell> = {}
  let totalAvailable = 0
  for (const col of model.columns) {
    let quantity = 0, reserved = 0, available = 0
    for (const row of model.rows) {
      quantity += onHandOf(row, col.locationId, pending)
      reserved += row.cells[col.locationId]?.reserved ?? 0
      available += availableOf(row, col.locationId, pending)
    }
    cells[col.locationId] = { quantity, reserved, available }
    totalAvailable += available
  }
  return { cells, totalAvailable }
}

/** A row's total available across locations, as the products grid shows it. */
export function rowTotalAvailable(row: MatrixRow, columns: readonly MatrixColumn[], pending: PendingEdits): number {
  return columns.reduce((sum, c) => sum + availableOf(row, c.locationId, pending), 0)
}

/** The worst sync state among a row's levels — what the badge shows. */
export function rowSyncStatus(row: MatrixRow): SyncStatus | null {
  const states = Object.values(row.cells).map((c) => c.syncStatus).filter((s): s is SyncStatus => !!s)
  if (states.includes('FAILED')) return 'FAILED'
  if (states.includes('PENDING')) return 'PENDING'
  return states.length ? 'SYNCED' : null
}

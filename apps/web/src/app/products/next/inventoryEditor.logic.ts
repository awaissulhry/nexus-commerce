// apps/web/src/app/products/next/inventoryEditor.logic.ts

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

/** Low-stock → status color token; mirrors the grid cell coloring. */
export function getStockColor(qty: number, threshold: number): string {
  if (qty === 0) return 'var(--status-danger-line)'
  if (qty <= threshold) return 'var(--status-warning-line)'
  return 'var(--status-success-line)'
}

export interface LevelCell {
  locationId: string
  locationCode: string
  locationName: string
  locationType: string
  quantity: number
  reserved: number
  available: number
  editable: boolean
}

export interface RawListLevel {
  location: { id: string; code: string; name: string; type: string }
  quantity: number
  reserved: number
  available: number
}
export interface RawLocation {
  id: string
  code: string
  name: string
  type: string
}

/** List mode: merge a product's existing levels with the full active-location
 *  list so locations without a level still appear (as editable 0-rows for
 *  editable types — that is the "add at location" affordance). */
export function buildListModel(levels: RawListLevel[], activeLocations: RawLocation[]): LevelCell[] {
  const byId = new Map(levels.map((l) => [l.location.id, l]))
  return activeLocations.map((loc) => {
    const lv = byId.get(loc.id)
    return {
      locationId: loc.id,
      locationCode: loc.code,
      locationName: loc.name,
      locationType: loc.type,
      quantity: lv?.quantity ?? 0,
      reserved: lv?.reserved ?? 0,
      available: lv?.available ?? 0,
      editable: isLocationEditable(loc.type),
    }
  })
}

export interface RawFamilyChildLevel {
  locationId: string
  locationCode: string
  locationType: string
  quantity: number
  reserved: number
  available: number
}
export interface RawFamilyChild {
  id: string
  sku: string
  name: string
  thumbnailUrl: string | null
  stockLevels: RawFamilyChildLevel[]
}
export interface MatrixModel {
  columns: Array<{ locationId: string; locationCode: string; locationType: string; editable: boolean }>
  rows: Array<{
    productId: string
    sku: string
    name: string
    thumbnailUrl: string | null
    cells: Record<string, { quantity: number; reserved: number; available: number }>
  }>
}

/** Matrix mode: child products (variations) as rows × active locations as columns. */
export function buildMatrixModel(locations: RawLocation[], children: RawFamilyChild[]): MatrixModel {
  const columns = locations.map((loc) => ({
    locationId: loc.id,
    locationCode: loc.code,
    locationType: loc.type,
    editable: isLocationEditable(loc.type),
  }))
  const rows = children.map((c) => {
    const cells: MatrixModel['rows'][number]['cells'] = {}
    for (const sl of c.stockLevels) {
      cells[sl.locationId] = { quantity: sl.quantity, reserved: sl.reserved, available: sl.available }
    }
    return { productId: c.id, sku: c.sku, name: c.name, thumbnailUrl: c.thumbnailUrl, cells }
  })
  return { columns, rows }
}

export function editorModeForRow(row: { isParent: boolean }): 'matrix' | 'list' {
  return row.isParent ? 'matrix' : 'list'
}

/**
 * Concise label for a variation row in the matrix. Child product names repeat
 * the full parent title (e.g. "XAVIA AIR-MESH Giacca … (L, Nero)"), which would
 * blow out the matrix's first column and push the editable location columns
 * off-screen. Prefer the trailing parenthetical ("L, Nero"); else the child SKU
 * with the parent SKU prefix stripped ("L-BLACK"); else the full SKU.
 */
export function variationLabel(
  child: { name: string; sku: string },
  parent: { name: string; sku: string },
): string {
  const paren = child.name.match(/\(([^)]+)\)\s*$/)
  if (paren) return paren[1].trim()
  if (parent.sku && child.sku.startsWith(parent.sku + '-')) {
    return child.sku.slice(parent.sku.length + 1)
  }
  if (parent.name && child.name.startsWith(parent.name)) {
    const rest = child.name.slice(parent.name.length).replace(/^[\s\-–—|]+/, '').trim()
    if (rest) return rest
  }
  return child.sku
}

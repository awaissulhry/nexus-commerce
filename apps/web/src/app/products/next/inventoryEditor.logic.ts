// apps/web/src/app/products/next/inventoryEditor.logic.ts
//
// The inventory editor's pure model: what a row is, which locations may be edited, how a set of
// PENDING edits sits over the server's numbers, and what the totals row says. Everything the
// grid and the modal compute is here, so it is tested rather than trusted.
//
// Cases (Step 3): a SKU with a case size shows, per warehouse, its sealed cases and loose units
// ("4 + 3"). The sealed count is edited like on-hand and travels in the SAME change of that cell,
// so one Apply writes both in one transaction. The rule is the shared one (`@nexus/shared/stock-cases`):
// a lower on-hand previews the case it opens; a count the units cannot hold is refused.
import { CASE_COPY, caseCountProblem, sealedCases } from '@nexus/shared/stock-cases'

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
  /** Sealed cases the server holds here (already clamped by the units); absent = none. */
  cases?: number
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
  cases?: number
}

export interface RawFamilyChildLevel {
  locationId: string
  locationCode: string
  locationType: string
  quantity: number
  reserved: number
  available: number
  syncStatus?: string | null
  cases?: number
}
export interface RawFamilyChild {
  id: string
  sku: string
  name: string
  thumbnailUrl: string | null
  lowStockThreshold?: number | null
  /** Units in one sealed case; null/absent = no case size. */
  unitsPerCase?: number | null
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
  /** Units in one sealed case; null = no case size (the Cases cell has nothing to edit). */
  unitsPerCase: number | null
  cells: Record<string, LevelCell>
}
/** ONE shape for both cases: a family's variations, or a single product as a one-row family. */
export interface MatrixModel {
  columns: MatrixColumn[]
  rows: MatrixRow[]
}

const asSync = (s: string | null | undefined): SyncStatus | null =>
  s === 'SYNCED' || s === 'PENDING' || s === 'FAILED' ? s : null

/** A case size the rule can use (a whole number ≥ 1), else null. */
const asCaseSize = (n: number | null | undefined): number | null => (typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : null)

const levelCell = (l: { quantity: number; reserved: number; available: number; syncStatus?: string | null; cases?: number }): LevelCell => ({
  quantity: l.quantity, reserved: l.reserved, available: l.available, syncStatus: asSync(l.syncStatus),
  ...(typeof l.cases === 'number' && l.cases > 0 ? { cases: l.cases } : {}),
})

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
    for (const sl of c.stockLevels) cells[sl.locationId] = levelCell(sl)
    return { productId: c.id, sku: c.sku, name: c.name, thumbnailUrl: c.thumbnailUrl, lowStockThreshold: c.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD, unitsPerCase: asCaseSize(c.unitsPerCase), cells }
  })
  return { columns, rows }
}

/**
 * A single product: the same shape with one row, so the editor has one behaviour. Locations
 * without a level appear as 0 (the "add at location" affordance the list mode used to carry).
 */
export function buildSingleModel(
  product: { id: string; sku: string; name: string; thumbnailUrl: string | null; lowStockThreshold?: number | null; unitsPerCase?: number | null },
  levels: RawListLevel[],
  activeLocations: RawLocation[],
): MatrixModel {
  const columns = activeLocations.map(column)
  const cells: MatrixRow['cells'] = {}
  for (const lv of levels) cells[lv.location.id] = levelCell(lv)
  return {
    columns,
    rows: [{ productId: product.id, sku: product.sku, name: product.name, thumbnailUrl: product.thumbnailUrl, lowStockThreshold: product.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD, unitsPerCase: asCaseSize(product.unitsPerCase), cells }],
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

/** One changed cell as the server receives it: an absolute on-hand, an absolute sealed count, or both. */
export interface CellChange { productId: string; locationId: string; value?: number; cases?: number }

const splitKey = (key: string) => {
  const i = key.indexOf(':')
  return { productId: key.slice(0, i), locationId: key.slice(i + 1) }
}

/**
 * The batch the server receives: ONE change per cell, carrying its on-hand and its sealed count
 * when either is pending — so the server writes both in one transaction and checks the count
 * against the NEW units.
 */
export function changesOf(pending: PendingEdits, pendingCases: PendingCases = new Map()): CellChange[] {
  const out: CellChange[] = [...pending.entries()].map(([key, value]) => {
    const cases = pendingCases.get(key)
    return { ...splitKey(key), value, ...(cases !== undefined ? { cases } : {}) }
  })
  for (const [key, cases] of pendingCases) if (!pending.has(key)) out.push({ ...splitKey(key), cases })
  return out
}

/** How many cells carry a pending change (on-hand, sealed count, or both) — what Apply counts. */
export function pendingCellCount(pending: PendingEdits, pendingCases: PendingCases): number {
  let n = pending.size
  for (const key of pendingCases.keys()) if (!pending.has(key)) n += 1
  return n
}

// ── cases: sealed + loose per warehouse ────────────────────────────────────────────────────

/** Sealed cases are counted at the business's own warehouses only (FBA and Shopify stay units). */
export const countsCases = (col: Pick<MatrixColumn, 'locationType'>): boolean => col.locationType === 'WAREHOUSE'

/** The Cases column shows only when some row has a case size and some location is a warehouse. */
export function hasCaseColumns(model: MatrixModel): boolean {
  return model.rows.some((r) => r.unitsPerCase !== null) && model.columns.some(countsCases)
}

/** The case size every sized row shares (for the header); null when none or mixed. */
export function sharedCaseSize(model: MatrixModel): number | null {
  const sizes = new Set(model.rows.map((r) => r.unitsPerCase).filter((n): n is number => n !== null))
  return sizes.size === 1 ? [...sizes][0] : null
}

export type PendingCases = ReadonlyMap<string, number>

/** What one Cases cell shows. */
export interface CasesView {
  /** Units in one case; null = no case size, nothing to edit. */
  size: number | null
  /** The sealed count shown: the typed one, else the server's clamped by the on-hand shown. */
  sealed: number
  /** Loose units (on hand − sealed × size); null while a typed count does not fit the units. */
  loose: number | null
  /** Shown sealed − the server's sealed: the chip. */
  delta: number
  /** A typed count is pending here. */
  typed: boolean
  /** Sealed cases a pending on-hand change opens (no typed count); 0 otherwise. */
  opens: number
  /** Why the typed count cannot be applied, or null. */
  problem: string | null
}

/** The server's sealed count at a cell, as a reader shows it (never more than the units allow). */
function serverSealed(row: MatrixRow, locationId: string): number {
  const cell = row.cells[locationId]
  return sealedCases(cell?.cases ?? 0, cell?.quantity ?? 0, row.unitsPerCase)
}

/**
 * The live preview: a typed count shows as typed (refused when the shown on-hand cannot hold
 * it); without one, the server's count clamped by the shown on-hand — lowering On hand shows the
 * case a sale would open (loose units first, then a case).
 */
export function casesOf(row: MatrixRow, locationId: string, pending: PendingEdits, pendingCases: PendingCases): CasesView {
  const size = row.unitsPerCase
  const onHand = onHandOf(row, locationId, pending)
  const before = serverSealed(row, locationId)
  if (size === null) return { size: null, sealed: 0, loose: null, delta: 0, typed: false, opens: 0, problem: null }
  const typed = pendingCases.get(pendingKey(row.productId, locationId))
  if (typed === undefined) {
    const sealed = sealedCases(before, onHand, size)
    return { size, sealed, loose: onHand - sealed * size, delta: sealed - before, typed: false, opens: before - sealed, problem: null }
  }
  const problem = caseCountProblem({ cases: typed, quantity: onHand, unitsPerCase: size, locationType: 'WAREHOUSE' })?.message ?? null
  return { size, sealed: typed, loose: problem ? null : onHand - typed * size, delta: typed - before, typed: true, opens: 0, problem }
}

/**
 * Record a typed sealed count. A count equal to what the cell shows without one (the server's,
 * clamped by the pending on-hand) is NOT a change — "change and change back", and an undo that
 * restores the preview, leave nothing to apply. Not a whole number ≥ 0, or no case size: refused,
 * the map is returned untouched. A count too high for the units IS kept: the cell shows it red
 * with the reason (`casesOf(...).problem`), as the server would answer.
 */
export function withCasesEdit(pendingCases: PendingCases, row: MatrixRow, locationId: string, value: unknown, pending: PendingEdits): Map<string, number> {
  const next = new Map(pendingCases)
  if (row.unitsPerCase === null) return next
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim())
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return next
  const key = pendingKey(row.productId, locationId)
  const implied = sealedCases(serverSealed(row, locationId), onHandOf(row, locationId, pending), row.unitsPerCase)
  if (n === implied) next.delete(key)
  else next.set(key, n)
  return next
}

/** The server's refusal codes that concern the sealed count (`@nexus/shared/stock-cases` CaseProblemCode). */
const CASE_REFUSAL_CODES = new Set(['NO_CASE_SIZE', 'NOT_A_WAREHOUSE', 'INVALID_CASES', 'CASES_EXCEED_UNITS'])

/** Which cell of a refused change turns red: the one it changed, or — both changed — the one the code names. */
export function refusedColumn(change: CellChange | undefined, code: string | undefined): 'onhand' | 'cases' {
  if (change && change.value === undefined && change.cases !== undefined) return 'cases'
  if (change && change.cases === undefined) return 'onhand'
  return code && CASE_REFUSAL_CODES.has(code) ? 'cases' : 'onhand'
}

/** The `failed` key of a refused Cases cell (an On hand cell uses `pendingKey`). */
export const casesFailKey = (productId: string, locationId: string) => `cases:${pendingKey(productId, locationId)}`

/** The words of the Cases column. */
export const CASES_EDITOR_COPY = {
  header: 'Cases',
  headerTooltip: (size: number | null) =>
    `Sealed cases + loose units${size ? ` (${CASE_COPY.perCase(size)})` : ''}. A sale takes loose units first, then opens a case.`,
  opens: (n: number) => `${n} sealed ${n === 1 ? 'case opens' : 'cases open'}`,
} as const

/** Totals per location and overall, over the numbers the grid is SHOWING (pending included). */
export function totalsOf(model: MatrixModel, pending: PendingEdits, pendingCases: PendingCases = new Map()): {
  cells: Record<string, LevelCell>
  totalAvailable: number
  /** Σ sealed + Σ loose of the rows with a case size, per warehouse; null where none counts cases. */
  cases: Record<string, { sealed: number; loose: number } | null>
} {
  const cells: Record<string, LevelCell> = {}
  const cases: Record<string, { sealed: number; loose: number } | null> = {}
  const sized = model.rows.filter((r) => r.unitsPerCase !== null)
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
    if (!countsCases(col) || sized.length === 0) { cases[col.locationId] = null; continue }
    let sealed = 0, loose = 0
    for (const row of sized) {
      const size = row.unitsPerCase as number
      const onHand = onHandOf(row, col.locationId, pending)
      // A typed count the units cannot hold is not added as typed: the totals never show more cases than units.
      const s = Math.min(casesOf(row, col.locationId, pending, pendingCases).sealed, Math.floor(onHand / size))
      sealed += s
      loose += onHand - s * size
    }
    cases[col.locationId] = { sealed, loose }
  }
  return { cells, totalAvailable, cases }
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

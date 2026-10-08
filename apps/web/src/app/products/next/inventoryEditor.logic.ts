// apps/web/src/app/products/next/inventoryEditor.logic.ts
//
// The inventory editor's pure model: what a row is, which locations may be edited, how a set of
// PENDING edits sits over the server's numbers, and what the totals row says. Everything the
// grid and the modal compute is here, so it is tested rather than trusted.
//
// Cases (Step 3; several case sizes per SKU, Owner 2026-10-08): a SKU with case sizes shows, per
// warehouse, its sealed cases per size and its loose units ("4 + 3", or "2 | 1 + 3" across two size
// columns). Each sealed count is edited like on-hand and travels in the SAME change of that cell, so
// one Apply writes them all in one transaction. The rule is the shared one (`@nexus/shared/stock-cases`):
// a lower on-hand previews the case it opens (the smallest first); counts the units cannot hold are refused.
import { CASE_COPY, caseCountProblem, countsFor, isCaseSize, sealedCases, sealedUnits, withCounts, type CaseCount } from '@nexus/shared/stock-cases'

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
  /** Sealed cases per size the server holds here (already clamped by the units); absent = none. */
  cases?: CaseCount[]
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
  cases?: CaseCount[]
}

export interface RawFamilyChildLevel {
  locationId: string
  locationCode: string
  locationType: string
  quantity: number
  reserved: number
  available: number
  syncStatus?: string | null
  cases?: CaseCount[]
}
export interface RawFamilyChild {
  id: string
  sku: string
  name: string
  thumbnailUrl: string | null
  lowStockThreshold?: number | null
  /** The SKU's case sizes (units per case, biggest first); absent/[] = no case size. */
  caseSizes?: number[]
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
  /** The SKU's case sizes (units per case, biggest first); [] = no case size (no Cases cell to edit). */
  caseSizes: number[]
  cells: Record<string, LevelCell>
}
/** ONE shape for both cases: a family's variations, or a single product as a one-row family. */
export interface MatrixModel {
  columns: MatrixColumn[]
  rows: MatrixRow[]
}

const asSync = (s: string | null | undefined): SyncStatus | null =>
  s === 'SYNCED' || s === 'PENDING' || s === 'FAILED' ? s : null

/** The case sizes the rule can use (whole numbers ≥ 1), each once, biggest first. */
export function asCaseSizes(raw: unknown): number[] {
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.filter(isCaseSize))].sort((a, b) => b - a)
}

/** The sealed counts a level carries on the wire: `{ unitsPerCase, cases }` with whole numbers > 0. */
function asCounts(raw: unknown): CaseCount[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((c): CaseCount[] => {
    const o = c as Partial<CaseCount> | null
    return o && isCaseSize(o.unitsPerCase) && typeof o.cases === 'number' && Number.isInteger(o.cases) && o.cases > 0 ? [{ unitsPerCase: o.unitsPerCase, cases: o.cases }] : []
  })
}

const levelCell = (l: { quantity: number; reserved: number; available: number; syncStatus?: string | null; cases?: unknown }): LevelCell => {
  const cases = asCounts(l.cases)
  return { quantity: l.quantity, reserved: l.reserved, available: l.available, syncStatus: asSync(l.syncStatus), ...(cases.length ? { cases } : {}) }
}

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
    return { productId: c.id, sku: c.sku, name: c.name, thumbnailUrl: c.thumbnailUrl, lowStockThreshold: c.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD, caseSizes: asCaseSizes(c.caseSizes), cells }
  })
  return { columns, rows }
}

/**
 * A single product: the same shape with one row, so the editor has one behaviour. Locations
 * without a level appear as 0 (the "add at location" affordance the list mode used to carry).
 */
export function buildSingleModel(
  product: { id: string; sku: string; name: string; thumbnailUrl: string | null; lowStockThreshold?: number | null; caseSizes?: number[] | null },
  levels: RawListLevel[],
  activeLocations: RawLocation[],
): MatrixModel {
  const columns = activeLocations.map(column)
  const cells: MatrixRow['cells'] = {}
  for (const lv of levels) cells[lv.location.id] = levelCell(lv)
  return {
    columns,
    rows: [{ productId: product.id, sku: product.sku, name: product.name, thumbnailUrl: product.thumbnailUrl, lowStockThreshold: product.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD, caseSizes: asCaseSizes(product.caseSizes), cells }],
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

/**
 * One changed cell as the server receives it: an absolute on-hand, absolute sealed counts of the
 * sizes typed there (the other sizes keep theirs), or both.
 */
export interface CellChange { productId: string; locationId: string; value?: number; cases?: CaseCount[] }

const splitKey = (key: string) => {
  const i = key.indexOf(':')
  return { productId: key.slice(0, i), locationId: key.slice(i + 1) }
}

/** The typed sealed counts of one cell, biggest size first. */
function typedAt(pendingCases: PendingCases, cellKey: string): CaseCount[] {
  const out: CaseCount[] = []
  for (const [key, cases] of pendingCases) {
    const at = splitCasesKey(key)
    if (at.cellKey === cellKey) out.push({ unitsPerCase: at.unitsPerCase, cases })
  }
  return out.sort((a, b) => b.unitsPerCase - a.unitsPerCase)
}

/** The cells (`pendingKey`) that carry a typed sealed count. */
export function casesCells(pendingCases: PendingCases): Set<string> {
  return new Set([...pendingCases.keys()].map((k) => splitCasesKey(k).cellKey))
}

/**
 * The batch the server receives: ONE change per cell, carrying its on-hand and its typed sealed
 * counts when either is pending — so the server writes them in one transaction and checks the
 * counts against the NEW units.
 */
export function changesOf(pending: PendingEdits, pendingCases: PendingCases = new Map()): CellChange[] {
  const caseCells = casesCells(pendingCases)
  const out: CellChange[] = [...pending.entries()].map(([key, value]) => {
    const cases = caseCells.has(key) ? typedAt(pendingCases, key) : null
    return { ...splitKey(key), value, ...(cases ? { cases } : {}) }
  })
  for (const key of caseCells) if (!pending.has(key)) out.push({ ...splitKey(key), cases: typedAt(pendingCases, key) })
  return out
}

/** How many cells carry a pending change (on-hand, sealed counts, or both) — what Apply counts. */
export function pendingCellCount(pending: PendingEdits, pendingCases: PendingCases): number {
  let n = pending.size
  for (const key of casesCells(pendingCases)) if (!pending.has(key)) n += 1
  return n
}

/** The typed sealed counts kept after an Apply: those of the cells the server refused. */
export function keepCasesOf(pendingCases: PendingCases, refusedCells: ReadonlySet<string>): Map<string, number> {
  const next = new Map<string, number>()
  for (const [k, v] of pendingCases) if (refusedCells.has(splitCasesKey(k).cellKey)) next.set(k, v)
  return next
}

// ── cases: sealed per size + loose per warehouse ───────────────────────────────────────────

/** Sealed cases are counted at the business's own warehouses only (FBA and Shopify stay units). */
export const countsCases = (col: Pick<MatrixColumn, 'locationType'>): boolean => col.locationType === 'WAREHOUSE'

/** The Cases columns show only when some row has a case size and some location is a warehouse. */
export function hasCaseColumns(model: MatrixModel): boolean {
  return model.rows.some((r) => r.caseSizes.length > 0) && model.columns.some(countsCases)
}

/** Every case size of the family (units per case), each once, biggest first — one Cases column per size. */
export function familyCaseSizes(model: MatrixModel): number[] {
  return asCaseSizes(model.rows.flatMap((r) => r.caseSizes))
}

/** Typed sealed counts, one per (product, location, case size): `casesKey`. */
export type PendingCases = ReadonlyMap<string, number>

/** One key per (product, location, case size) — a typed sealed count. */
export const casesKey = (productId: string, locationId: string, unitsPerCase: number) => `${pendingKey(productId, locationId)}:${unitsPerCase}`
function splitCasesKey(key: string): { cellKey: string; unitsPerCase: number } {
  const i = key.lastIndexOf(':')
  return { cellKey: key.slice(0, i), unitsPerCase: Number(key.slice(i + 1)) }
}

/** What a level shows: the sealed count per size (the typed ones, else the server's clamped by the on-hand shown). */
export interface LevelCasesView {
  /** The row's sizes, biggest first, with the count shown. */
  sealed: CaseCount[]
  /** The server's count per size (as a reader shows it). */
  before: CaseCount[]
  /** The sizes typed at this level. */
  typed: ReadonlySet<number>
  /** Loose units (on hand − Σ sealed × size); null while typed counts do not fit the units. */
  loose: number | null
  /** Why the typed counts cannot be applied, or null. */
  problem: string | null
}

/** The server's sealed counts at a cell, as a reader shows them (never more than the units allow), biggest first. */
function serverSealed(row: MatrixRow, locationId: string): CaseCount[] {
  const cell = row.cells[locationId]
  return sealedCases(countsFor(row.caseSizes, cell?.cases ?? []), cell?.quantity ?? 0)
}

/**
 * The live preview of one level: a typed count shows as typed (refused, with the reason, when the
 * shown on-hand cannot hold the counts together); a size not typed shows the server's count clamped
 * by the shown on-hand — lowering On hand shows the case a sale would open (loose units first, then
 * the smallest case).
 */
export function levelCasesOf(row: MatrixRow, locationId: string, pending: PendingEdits, pendingCases: PendingCases): LevelCasesView {
  const before = serverSealed(row, locationId)
  const onHand = onHandOf(row, locationId, pending)
  const preview = sealedCases(before, onHand)
  const typedCounts = row.caseSizes.length ? typedAt(pendingCases, pendingKey(row.productId, locationId)).filter((c) => row.caseSizes.includes(c.unitsPerCase)) : []
  const typed = new Set(typedCounts.map((c) => c.unitsPerCase))
  if (typed.size === 0) return { sealed: preview, before, typed, loose: onHand - sealedUnits(preview), problem: null }
  const sealed = withCounts(preview, typedCounts)
  const problem = caseCountProblem({ cases: sealed, quantity: onHand, sizes: row.caseSizes, locationType: 'WAREHOUSE' })?.message ?? null
  return { sealed, before, typed, loose: problem ? null : onHand - sealedUnits(sealed), problem }
}

/** What one Cases cell (a row × a warehouse × a case size) shows. */
export interface CasesView {
  /** Units in one case of this column; null = the row has no case of this size, nothing to edit. */
  size: number | null
  /** The sealed count shown: the typed one, else the server's clamped by the on-hand shown. */
  sealed: number
  /** The row's loose units — set only in the row's smallest own size column; null elsewhere, or while typed counts do not fit. */
  loose: number | null
  /** Shown sealed − the server's sealed: the chip. */
  delta: number
  /** A typed count of this size is pending here. */
  typed: boolean
  /** Sealed cases of this size a pending on-hand change opens (no typed count here); 0 otherwise. */
  opens: number
  /** Why the typed counts of this level cannot be applied (on a typed cell only), or null. */
  problem: string | null
}

const NO_CASE: CasesView = { size: null, sealed: 0, loose: null, delta: 0, typed: false, opens: 0, problem: null }

/** One Cases cell, from the level's preview. `unitsPerCase` = the column's case size. */
export function casesOf(row: MatrixRow, locationId: string, unitsPerCase: number, pending: PendingEdits, pendingCases: PendingCases): CasesView {
  if (!row.caseSizes.includes(unitsPerCase)) return NO_CASE
  const level = levelCasesOf(row, locationId, pending, pendingCases)
  const shown = level.sealed.find((c) => c.unitsPerCase === unitsPerCase)?.cases ?? 0
  const server = level.before.find((c) => c.unitsPerCase === unitsPerCase)?.cases ?? 0
  const typed = level.typed.has(unitsPerCase)
  const smallest = row.caseSizes[row.caseSizes.length - 1]
  return {
    size: unitsPerCase,
    sealed: shown,
    loose: unitsPerCase === smallest ? level.loose : null,
    delta: shown - server,
    typed,
    opens: typed ? 0 : Math.max(0, server - shown),
    problem: typed ? level.problem : null,
  }
}

/**
 * Record a typed sealed count of one size. A count equal to what the cell shows without one (the
 * server's, clamped by the pending on-hand) is NOT a change — "change and change back", and an
 * undo that restores the preview, leave nothing to apply. Not a whole number ≥ 0, or a size the
 * row does not have: refused, the map is returned untouched. A count too high for the units IS
 * kept: the cell shows it red with the reason (`casesOf(...).problem`), as the server would answer.
 */
export function withCasesEdit(pendingCases: PendingCases, row: MatrixRow, locationId: string, unitsPerCase: number, value: unknown, pending: PendingEdits): Map<string, number> {
  const next = new Map(pendingCases)
  if (!row.caseSizes.includes(unitsPerCase)) return next
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim())
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return next
  const key = casesKey(row.productId, locationId, unitsPerCase)
  const implied = sealedCases(serverSealed(row, locationId), onHandOf(row, locationId, pending)).find((c) => c.unitsPerCase === unitsPerCase)?.cases ?? 0
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

/** The words of the Cases columns. */
export const CASES_EDITOR_COPY = {
  /** One case size in the family: "Cases"; several: one column per size, "12 / case". */
  header: (sizes: readonly number[], unitsPerCase: number) => (sizes.length > 1 ? CASE_COPY.perCase(unitsPerCase) : 'Cases'),
  headerTooltip: (sizes: readonly number[]) =>
    `Sealed cases + loose units${sizes.length === 1 ? ` (${CASE_COPY.perCase(sizes[0])})` : ''}. A sale takes loose units first, then opens the smallest case.`,
  opens: (n: number) => `${n} sealed ${n === 1 ? 'case opens' : 'cases open'}`,
  loose: (n: number) => `${n} loose`,
} as const

/** Totals per location and overall, over the numbers the grid is SHOWING (pending included). */
export function totalsOf(model: MatrixModel, pending: PendingEdits, pendingCases: PendingCases = new Map()): {
  cells: Record<string, LevelCell>
  totalAvailable: number
  /** Σ sealed per family size (biggest first) + Σ loose of the rows with case sizes, per warehouse; null where none counts cases. */
  cases: Record<string, { sealed: CaseCount[]; loose: number } | null>
} {
  const cells: Record<string, LevelCell> = {}
  const cases: Record<string, { sealed: CaseCount[]; loose: number } | null> = {}
  const sized = model.rows.filter((r) => r.caseSizes.length > 0)
  const sizes = familyCaseSizes(model)
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
    const sealed = new Map(sizes.map((u) => [u, 0]))
    let loose = 0
    for (const row of sized) {
      const onHand = onHandOf(row, col.locationId, pending)
      // Typed counts the units cannot hold are not added as typed: the totals never show more cases than units.
      const counted = sealedCases(levelCasesOf(row, col.locationId, pending, pendingCases).sealed, onHand)
      for (const c of counted) sealed.set(c.unitsPerCase, (sealed.get(c.unitsPerCase) ?? 0) + c.cases)
      loose += onHand - sealedUnits(counted)
    }
    cases[col.locationId] = { sealed: sizes.map((u) => ({ unitsPerCase: u, cases: sealed.get(u) ?? 0 })), loose }
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

/**
 * Add rows — the empty rows as GRID rows of each product sheet scope, so a scope adapter adds them in a few lines:
 *
 *   rowData    = withNewRows(rowsAfterSearchAndFilters, newRows.rows, row => sharedNewRow(row, parentId))
 *   columnDefs = lockedOnNewRows(columnDefs)        every cell but the SKU: locked and blank on an empty row
 *   refusal    = newRowRefusal(colId, row)          why a cell of an empty row is locked (undefined: a real row)
 *
 * An empty row holds nothing but its SKU: no values, no listing, no readiness, no Status, Action or Publish — so no
 * count, selection, export or formula reads it. It sits where the record it creates will appear: a variation under the
 * family's parent (Shared scope) or under the listing band on screen (channel scope); a listing (alias) row is a band of
 * its own after the last listing. When a search hides that parent or band, the row stands at the top level instead of
 * under an empty filler group.
 */
import type { StudioRow as SharedRow } from '../master/types'
import type { ChannelSheetRow } from '../channel/types'
import { IDENTITY_SKU_COLUMN } from '../identitySkuEdit'
import { productSheetRowPath, type ProductSheetRowIdentity } from '../productSheetRows'
import { newRowCellEditable, type NewRow } from './newRows'

/**
 * A grid row made from an empty row: the scope's row shape, `unsaved` and `unsavedReason` (S11's seam:
 * `IdentitySkuRow`) and the empty row itself.
 */
export type UnsavedGridRow<Row> = Row & { unsaved: true; unsavedReason: string | null; newRow: NewRow }

/** The empty row behind a grid row, or null for every real row. */
export function unsavedOf(data: unknown): NewRow | null {
  const row = data as { unsaved?: unknown; newRow?: NewRow } | null | undefined
  return row && row.unsaved === true && row.newRow ? row.newRow : null
}

const NOTHING_FILLED = { overall: { filled: 0, total: 0, pct: 0 }, required: { filled: 0, total: 0, missing: [] }, byGroup: [] }

function blank(row: NewRow, parentId: string | null) {
  return {
    id: row.id, sku: row.sku, name: null, parentId, isParent: false, status: 'DRAFT', productType: null, version: 0, basePrice: null,
    childCount: 0, values: {}, listing: null, completeness: NOTHING_FILLED, axisValues: {},
    // The SKU cell takes input only while the row can take a SKU (not while its create is on its way, nor once created).
    unsaved: true as const, unsavedReason: newRowCellEditable(row, true).reason, newRow: row,
  }
}

/** Shared scope: an empty variation row, a child of the family's parent. */
export function sharedNewRow(row: NewRow, parentId: string): UnsavedGridRow<SharedRow> {
  return { ...blank(row, parentId) }
}

/**
 * Channel scope: an empty variation row sits under the listing band on screen (`bandAliasId`: null = the primary
 * listing); an empty listing (alias) row is a band of its own, after every listing (its id is its band key, so the tree
 * never mixes it with a real listing).
 */
export function channelNewRow(row: NewRow, parentId: string, bandAliasId: string | null = null): UnsavedGridRow<ChannelSheetRow> {
  const band = row.kind === 'alias'
  return {
    ...blank(row, band ? null : parentId),
    aliasId: band ? row.id : bandAliasId,
    rowKind: band ? 'parent' : 'variant',
    rowId: row.id,
    aliasPosition: band ? Number.MAX_SAFE_INTEGER : 0,
    readiness: { state: 'unlisted', issues: [] },
  }
}

const pathKey = (path: readonly string[]) => JSON.stringify(path)

/** A row at the top level of the tree: a band of its own (channel scope), or a product with no parent on screen. */
function atTopLevel<Row extends ProductSheetRowIdentity>(row: Row): Row {
  return row.rowId !== undefined ? { ...row, rowKind: 'parent', aliasId: row.rowId } : { ...row, parentId: null }
}

/**
 * The grid's rows: the scope's rows (after its search and filters) and then the empty rows, which no filter hides. An
 * empty row whose parent or band the filters hid stands at the top level: the tree never draws an empty filler group.
 */
export function withNewRows<Row extends ProductSheetRowIdentity>(rows: readonly Row[], newRows: readonly NewRow[], toRow: (row: NewRow) => Row): Row[] {
  if (!newRows.length) return rows as Row[]
  const paths = new Set(rows.map((row) => pathKey(productSheetRowPath(row))))
  return [...rows, ...newRows.map((newRow) => {
    const row = toRow(newRow)
    const path = productSheetRowPath(row)
    return path.length > 1 && !paths.has(pathKey(path.slice(0, -1))) ? atTopLevel(row) : row
  })]
}

/** Why a cell of an empty row is locked (null: its SKU cell, open), or undefined for a real row (the sheet's own rules). */
export function newRowRefusal(colId: string, data: unknown): string | null | undefined {
  const row = unsavedOf(data)
  return row ? newRowCellEditable(row, colId === IDENTITY_SKU_COLUMN).reason : undefined
}

/** The part of a column definition this module reads and rewrites: a column's cell hooks, a group's `children`. */
interface CellDef {
  editable?: unknown
  valueGetter?: unknown
  cellRendererSelector?: unknown
  tooltipValueGetter?: unknown
  cellClassRules?: unknown
  children?: unknown
}
type Params = { data?: unknown }
type Hook<T> = (params: Params) => T

/** An empty row's cell draws nothing (no "Loading…", no 0 %, no Status pill). */
const NothingHere = () => null
const NOTHING_HERE = { component: NothingHere }

/**
 * A column's class rules, none of them on an empty row (browser check 2026-10-05, F11): its blank cells are not
 * "required and missing" (the red tint and corner), not invalid, not locked-hatched, not saved — the row is not a record
 * yet, and its own words are in its identity cell. A real row keeps every rule. (A string expression is AG's to read and
 * is kept as it is; the sheets write functions.)
 */
function quietOnNewRows(rules: unknown): Record<string, unknown> | undefined {
  if (!rules || typeof rules !== 'object') return undefined
  return Object.fromEntries(Object.entries(rules as Record<string, unknown>).map(([name, rule]) => [name,
    typeof rule === 'function' ? ((params: Params) => !unsavedOf(params.data) && !!(rule as Hook<unknown>)(params)) : rule]))
}

/**
 * Every column but the SKU, on an empty row: locked (typing, paste and fill skip it) and blank — no value, no renderer
 * (Status, Action and Publish draw nothing, never a loading state), no tooltip, no class rule (no "required" tint).
 * Groups recursively. A real row keeps every column's own hooks untouched. The SKU column (the tree column) is not in
 * `defs`: it is the scope's `autoGroupColumnDef`.
 */
export function lockedOnNewRows<Def extends CellDef>(defs: readonly Def[]): Def[] {
  return defs.map((def) => {
    if (Array.isArray(def.children)) return { ...def, children: lockedOnNewRows(def.children as CellDef[]) }
    const own = { editable: def.editable, valueGetter: def.valueGetter, renderer: def.cellRendererSelector, tooltip: def.tooltipValueGetter }
    const next: CellDef = {
      cellRendererSelector: ((params) => (unsavedOf(params.data) ? NOTHING_HERE : typeof own.renderer === 'function' ? (own.renderer as Hook<unknown>)(params) : undefined)) as Hook<unknown>,
    }
    if (own.editable !== undefined && own.editable !== false) {
      next.editable = ((params) => !unsavedOf(params.data) && (typeof own.editable === 'function' ? !!(own.editable as Hook<unknown>)(params) : !!own.editable)) as Hook<boolean>
    }
    if (typeof own.valueGetter === 'function') next.valueGetter = ((params) => (unsavedOf(params.data) ? null : (own.valueGetter as Hook<unknown>)(params))) as Hook<unknown>
    if (typeof own.tooltip === 'function') next.tooltipValueGetter = ((params) => (unsavedOf(params.data) ? undefined : (own.tooltip as Hook<unknown>)(params))) as Hook<unknown>
    const classRules = quietOnNewRows(def.cellClassRules)
    if (classRules) next.cellClassRules = classRules
    return { ...def, ...next }
  })
}

/**
 * GDS — a saved view as column keys (schema 2) or a complete sheet layout (schema 3).
 *
 * The first saved-view payload (`useGridViews`, schema 1) is AG's own `GridState` blob — every
 * property the operator ever arranged, including `columnVisibility.hiddenColIds`. That is the right
 * shape for `/products/next`, whose column set is fixed, and the wrong shape for a sheet whose
 * column set is a UNION over product types and markets:
 *
 *   - `hiddenColIds` is an INVERTED set. A view saved on OUTERWEAR (102 columns, 85 hidden) applied
 *     to a product type with 60 columns the blob never heard of shows every one of them, because
 *     nothing in the blob says they should be hidden. The view silently means something else.
 *   - The blob carries 84 ids for columns a market switch may legitimately remove, and AG drops an
 *     unknown id without a word — a view that quietly shows fewer columns than it claims.
 *
 * A list of keys says exactly what it means on every product type: "these columns, in this order".
 * Resolved against the LIVE column set (`resolvePreset`), a column the product type lacks is
 * REPORTED, never dropped silently, and a new attribute is never shown by accident.
 *
 * Identity columns are implied by the sheet (its `always` set) and are not stored, so a view never
 * has an opinion about the one thing every view must show.
 *
 * Schema 3 also stores hidden-column order, locks and presentation group overrides. Schema 2
 * stays readable and writable for callers that only arrange visible columns. Schema 1 grid-state
 * payloads keep reading through `isGridStatePayload` in `useGridViews`.
 */

export const COLUMNS_VIEW_SCHEMA = 2
export const SHEET_LAYOUT_SCHEMA = 3

export interface ColumnsViewPayloadV2 {
  v: typeof COLUMNS_VIEW_SCHEMA
  kind: 'columns'
  /** Column keys in the order the view shows them. De-duplicated; identity columns never stored. */
  columns: string[]
  /** A view chip (a row filter) the view applies as well. Absent or null = none. */
  chip?: string | null
}

/** A complete sheet layout, including columns currently hidden or unavailable on this scope. */
export interface SheetLayoutPayload extends Omit<ColumnsViewPayloadV2, 'v'> {
  v: typeof SHEET_LAYOUT_SCHEMA
  columnOrder: string[]
  lockedColumns: string[]
  groupOrder: string[]
  /** Exact column key → stable presentation group ID. Never a master field mapping. */
  groupOverrides: Record<string, string>
}

export type ColumnsViewPayload = ColumnsViewPayloadV2 | SheetLayoutPayload

export interface SheetLayoutInput {
  columns: readonly string[]
  columnOrder: readonly string[]
  lockedColumns: readonly string[]
  groupOrder: readonly string[]
  groupOverrides: Readonly<Record<string, string>>
  chip?: string | null
}

/** Build a payload — de-duplicated, blanks dropped, so a payload can never name a column twice. */
export function columnsViewPayload(columns: readonly string[], chip?: string | null): ColumnsViewPayloadV2 {
  return { v: COLUMNS_VIEW_SCHEMA, kind: 'columns', columns: uniqueKeys(columns), ...(chip ? { chip } : {}) }
}

function uniqueKeys(keys: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of keys) {
    const key = typeof raw === 'string' ? raw.trim() : ''
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

/** Store layout metadata independently of the live column set so a market switch loses nothing. */
export function sheetLayoutPayload(input: SheetLayoutInput): SheetLayoutPayload {
  const groupOverrides = Object.fromEntries(
    Object.entries(input.groupOverrides)
      .map(([key, group]) => [key.trim(), typeof group === 'string' ? group.trim() : ''])
      .filter(([key, group]) => key && group),
  )
  return {
    ...columnsViewPayload(input.columns, input.chip),
    v: SHEET_LAYOUT_SCHEMA,
    columnOrder: uniqueKeys(input.columnOrder),
    lockedColumns: uniqueKeys(input.lockedColumns),
    groupOrder: uniqueKeys(input.groupOrder),
    groupOverrides,
  }
}

/**
 * Is this stored value a columns view? Checked, never cast: the server hands back whatever was
 * stored, and a schema-1 blob, a hand-edited row or a future schema must all read as "not this".
 */
export function isColumnsViewPayload(x: unknown): x is ColumnsViewPayload {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false
  const p = x as Omit<Partial<SheetLayoutPayload>, 'v'> & { v?: number }
  if (
    p.kind !== 'columns' ||
    !Array.isArray(p.columns) ||
    !p.columns.every((k) => typeof k === 'string') ||
    !(p.chip === undefined || p.chip === null || typeof p.chip === 'string')
  ) return false
  if (p.v === COLUMNS_VIEW_SCHEMA) return true
  if (p.v !== SHEET_LAYOUT_SCHEMA) return false
  const validKeys = (keys: unknown): keys is string[] => Array.isArray(keys) && keys.every((key) => typeof key === 'string' && key.trim().length > 0)
  return validKeys(p.columns) && validKeys(p.columnOrder) && validKeys(p.lockedColumns) && validKeys(p.groupOrder) &&
    !!p.groupOverrides && typeof p.groupOverrides === 'object' && !Array.isArray(p.groupOverrides) &&
    Object.entries(p.groupOverrides).every(([key, group]) => key.trim().length > 0 && typeof group === 'string' && group.trim().length > 0)
}

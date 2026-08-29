/**
 * GDS — the sheet's editing helpers: the long-text editor, the validation states a cell can carry,
 * and header-matched paste. Pure where it can be (tested), AG-typed where it must be.
 */
import type { CellClassParams, CellClassRules, ColDef, ProcessDataFromClipboardParams } from 'ag-grid-community'

/** AG's large-text editor as a popup, capped: a description edits in a box, not a one-line input. */
export const longTextEditor = (opts: { maxLength?: number; rows?: number; cols?: number } = {}): Pick<ColDef, 'editable' | 'cellEditor' | 'cellEditorParams' | 'cellEditorPopup'> => ({
  editable: true,
  cellEditor: 'agLargeTextCellEditor',
  cellEditorPopup: true,
  cellEditorParams: { maxLength: opts.maxLength ?? 4000, rows: opts.rows ?? 8, cols: opts.cols ?? 60 },
})

export type CellValidity = 'error' | 'warn' | null

export interface SheetValidation<T> {
  /** `null` = fine; `warn` = accepted but flagged (an off-list value a channel may reject); `error` = a channel will refuse. */
  validate: (value: unknown, data: T, colId: string) => { level: CellValidity; message?: string }
}

/**
 * `cellClassRules` for a sheet column: `.nds-cell-is-invalid` / `.nds-cell-is-warned` (a corner
 * triangle + tint, never colour alone), `.nds-cell-is-inherited` when the value comes from the
 * parent, `.nds-cell-is-locked` when the column definition locks it. Pair with `validationTitle`
 * so the reason is on hover.
 */
export function sheetClassRules<T>(v: SheetValidation<T>, inherited?: (data: T, colId: string) => boolean): CellClassRules<T> {
  const level = (p: CellClassParams<T>) => (p.data ? v.validate(p.value, p.data, p.colDef.colId ?? p.colDef.field ?? '').level : null)
  return {
    'nds-cell-is-invalid': (p) => level(p) === 'error',
    'nds-cell-is-warned': (p) => level(p) === 'warn',
    'nds-cell-is-inherited': (p) => !!p.data && !!inherited && inherited(p.data, p.colDef.colId ?? p.colDef.field ?? ''),
  }
}

/** Off-list handling the eBay flat file taught: WARN, never block — the operator can always type a value. */
export const selectValidation = <T,>(options: readonly string[], mode: 'strict' | 'open' = 'strict', required = false): SheetValidation<T> => ({
  validate: (value) => {
    const s = value == null ? '' : String(value).trim()
    if (!s) return required ? { level: 'error', message: 'Required' } : { level: null }
    if (mode === 'open') return { level: null }
    const hit = options.some((o) => o.toLowerCase() === s.toLowerCase())
    return hit ? { level: null } : { level: 'warn', message: `"${s}" is not in the channel's list — it may be rejected at publish` }
  },
})

export const lengthValidation = <T,>(max: number, required = false, countBytes = false): SheetValidation<T> => ({
  validate: (value) => {
    const s = value == null ? '' : String(value)
    if (!s) return required ? { level: 'error', message: 'Required' } : { level: null }
    const n = countBytes ? new TextEncoder().encode(s).length : s.length
    return n > max ? { level: 'error', message: `${n} of ${max} ${countBytes ? 'bytes' : 'characters'} — the channel cap` } : { level: null }
  },
})

/**
 * Header-matched paste ("smart paste"): when the first pasted row matches ≥2 column headers or ids
 * (case-insensitive), the block is re-ordered onto those columns by NAME rather than landing by
 * position — the way a sheet exported from Excel comes back. Otherwise the block pastes as-is.
 * Returns the 2-D array AG will apply from the focused cell.
 */
export function matchPasteToHeaders<T>(
  data: string[][],
  columns: ReadonlyArray<Pick<ColDef<T>, 'colId' | 'field' | 'headerName'>>,
  targetColIds: readonly string[],
): string[][] {
  if (data.length < 2) return data
  const header = data[0].map((h) => h.trim().toLowerCase())
  const byName = new Map<string, string>()
  for (const c of columns) {
    const id = c.colId ?? c.field
    if (!id) continue
    byName.set(id.toLowerCase(), id)
    if (c.headerName) byName.set(c.headerName.trim().toLowerCase(), id)
  }
  const matched = header.map((h) => byName.get(h) ?? null)
  if (matched.filter(Boolean).length < 2) return data
  // The paste lands on `targetColIds` (the focused cell's column onward); put each matched source
  // column under its target by id, blank where the paste has no such column.
  const srcIndexByCol = new Map<string, number>()
  matched.forEach((id, i) => { if (id) srcIndexByCol.set(id, i) })
  return data.slice(1).map((row) => targetColIds.map((id) => { const i = srcIndexByCol.get(id); return i == null ? '' : (row[i] ?? '') }))
}

/** AG's `processDataFromClipboard` wired to `matchPasteToHeaders`. Pass as a stable reference. */
export function sheetPasteProcessor<T>(columns: ReadonlyArray<Pick<ColDef<T>, 'colId' | 'field' | 'headerName'>>) {
  return (params: ProcessDataFromClipboardParams<T>): string[][] | null => {
    const focused = params.api.getFocusedCell()
    const all = params.api.getAllDisplayedColumns().map((c) => c.getColId())
    const start = focused ? all.indexOf(focused.column.getColId()) : 0
    const targets = all.slice(Math.max(0, start))
    return matchPasteToHeaders(params.data, columns, targets)
  }
}

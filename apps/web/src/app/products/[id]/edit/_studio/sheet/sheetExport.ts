/**
 * The studio sheet's EXPORT — one helper for both scopes (design V.5, 2026-09-04).
 *
 * What it adds over `exportGridCsv` alone, and why each part is here rather than in the engine:
 *
 *   - **D15.2's key row.** Master keys are bare (`brand`); channel keys carry the coordinate
 *     (`brand@AMAZON:IT:it`) — the import routes a column to the coordinate its header names
 *     (D15.3). The engine writes whatever key it is given; the FORMAT of a key is the studio's.
 *   - **`sku` first, from row data.** The identity band absorbed the `sku` column (#714), so the
 *     one column the import matches rows on is no longer a grid column. Measured before this: a
 *     file from the Export button had no `sku` header and every row re-imported as unmatched.
 *   - **Informational columns carry an EMPTY key** — the identity band, the readiness verdicts —
 *     so a re-import of an unmodified export skips them silently (D15.1: zero noise), rather than
 *     reporting "Readiness" as an unknown column on every file.
 *   - **`key.formula` siblings (D15.8)** — only when any exported cell carries a formula.
 *   - **Declared FORMS for non-scalar cells (AM.1 shapes, 2026-09-05).** A `list` cell is written as
 *     its items joined by ` | ` and its key row reads `key[]`; a `measure` cell is written as
 *     `value unit` and its key row reads `key[measure]`. A separator is a rendering claim the file
 *     must DECLARE (`reference_composed_string_invisible_separator`) — the import parses by the
 *     declaration, never by guessing at commas, which the eBay fixture already holds INSIDE one
 *     list item ("Ventilato, Imbottitura rimovibile, …").
 *
 * `mode: 'all'` writes every attribute column in the sheet's ruled order whatever is on screen —
 * the "Export all attributes" the Owner asked for; `'view'` writes what is displayed, in screen
 * order. Both produce importable files.
 */
import type { GridApi } from '@/design-system/grid'

import { exportGridCsv, type GridCsvExtraColumn, type GridCsvResult } from '@/design-system/grid/export/exportGrid'

import type { SheetColumn } from './master/types'

export type SheetExportMode = 'view' | 'all'

/** The coordinate half of a channel key: `@AMAZON:IT:it`. Master keys carry nothing. */
export interface SheetExportScope {
  kind: 'master' | 'channel'
  channel?: string | null
  marketplace?: string | null
  locale?: string | null
}

/** The cell shapes the file has a declared form for. `scalar`/absent = the grid's own rendering. */
export type SheetCellForm = 'list' | 'measure'

/** The separator between list items in the file — declared by the `[]` key form, never inferred. */
export const LIST_SEPARATOR = ' | '

/**
 * D15.2 — `key` on master, `key@channel:market:locale` on a channel scope; a non-scalar cell declares
 * its FORM before the coordinate: `key[]` (list) or `key[measure]`. Pure, tested.
 */
export function exportKeyFor(key: string, scope: SheetExportScope, form?: SheetCellForm | null): string {
  const declared = form === 'list' ? `${key}[]` : form === 'measure' ? `${key}[measure]` : key
  if (scope.kind !== 'channel' || !scope.channel || !scope.marketplace) return declared
  const locale = scope.locale ? `:${scope.locale.toLowerCase()}` : ''
  return `${declared}@${scope.channel.toUpperCase()}:${scope.marketplace.toUpperCase()}${locale}`
}

/**
 * The file form of a stored value, by shape. A list → items joined by `LIST_SEPARATOR`; a measure
 * → `value unit`; anything the shape does not expect passes through as-is (the grid's own rendering
 * then applies), and null/undefined stay empty. Pure, tested.
 */
export function fileValueFor(form: SheetCellForm, raw: unknown): unknown {
  if (raw === null || raw === undefined) return null
  if (form === 'list') return Array.isArray(raw) ? raw.map((x) => (x === null || x === undefined ? '' : String(x))).join(LIST_SEPARATOR) : raw
  if (form === 'measure' && typeof raw === 'object' && !Array.isArray(raw)) {
    const m = raw as { value?: unknown; unit?: unknown }
    if (m.value === null || m.value === undefined || m.value === '') return null
    return m.unit ? `${String(m.value)} ${String(m.unit)}` : String(m.value)
  }
  return raw
}

/** A column's declared form, from the AM.1 shape vocabulary; scalar and legacy columns have none. */
export function formOf(col: { shape?: string }): SheetCellForm | null {
  return col.shape === 'list' ? 'list' : col.shape === 'measure' ? 'measure' : null
}

/** D15.8 — the `.formula` sibling of a key, with the coordinate kept OUTSIDE the suffix (`brand.formula@AMAZON:IT:it`). */
export function formulaKeyFor(key: string, scope: SheetExportScope): string {
  const k = exportKeyFor(key, scope)
  const at = k.indexOf('@')
  return at === -1 ? `${k}.formula` : `${k.slice(0, at)}.formula${k.slice(at)}`
}

/** The file-name suffix: `all` or `view-<name>`; a view with no name is just `view`. */
export function exportSuffix(mode: SheetExportMode, viewName: string | null | undefined): string {
  if (mode === 'all') return 'all'
  const n = (viewName ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return n ? `view-${n}` : 'view'
}

export interface SheetExportArgs<TRow> {
  api: GridApi<TRow>
  mode: SheetExportMode
  /** The attribute columns the sheet builds (reserved ids removed). Decides which colIds get a key. */
  columns: readonly SheetColumn[]
  /** The sheet's ruled order — what `'all'` writes. */
  orderedKeys: readonly string[]
  scope: SheetExportScope
  /** Row → its SKU. The import matches rows on this. */
  skuOf: (row: TRow) => string | null | undefined
  /** Row × column → its formula expression, if the cell carries one. Omit for a scope without formulas. */
  formulaOf?: (row: TRow, key: string) => string | null | undefined
  /** Every row the grid holds — used ONLY to decide whether any `key.formula` sibling is needed. */
  rows: readonly TRow[]
  /**
   * Row × column → the STORED value (not the rendered one), for list and measure cells. Both scopes'
   * rows carry `values[key].value`, which is the default; a scope with another shape passes its own.
   */
  rawValueOf?: (row: TRow, key: string) => unknown
  /** The file's base name (`GALE-JACKET-IT`). */
  base: string
  /** The page's own narrowing (its search). */
  narrowed: boolean
  /** The active view's name, for the file-name suffix. */
  viewName?: string | null
}

/**
 * Export, and hand the file to the browser. Throws `GridExportRefused` under SSRM — the caller
 * shows the message. Returns what was written.
 */
export function exportSheet<TRow>(a: SheetExportArgs<TRow>): GridCsvResult {
  const byKey = new Map(a.columns.map((c) => [c.key, c]))
  const keyOf = (colId: string): string | null => {
    const col = byKey.get(colId)
    return col ? exportKeyFor(colId, a.scope, formOf(col)) : null
  }
  const rawValueOf = a.rawValueOf ?? ((row: TRow, key: string) => (row as { values?: Record<string, { value?: unknown }> }).values?.[key]?.value)
  // A list or measure cell leaves the file in its DECLARED form; a scalar keeps the grid's rendering.
  const valueOf = (colId: string, row: TRow): unknown => {
    const col = byKey.get(colId)
    const form = col ? formOf(col) : null
    return form ? fileValueFor(form, rawValueOf(row, colId)) : undefined
  }

  const leading: GridCsvExtraColumn<TRow>[] = [{ colId: '__export_sku', header: 'SKU', key: 'sku', value: (row) => a.skuOf(row) ?? null }]

  // D15.8 — a `key.formula` column per attribute that carries a formula on ANY row, in the same
  // order as the attribute columns it belongs to. None when no cell has one.
  const trailing: GridCsvExtraColumn<TRow>[] = []
  if (a.formulaOf) {
    const withFormula = new Set<string>()
    for (const row of a.rows) for (const key of byKey.keys()) if (a.formulaOf(row, key)) withFormula.add(key)
    const order = a.mode === 'all' ? a.orderedKeys : a.api.getAllDisplayedColumns().map((c) => c.getColId())
    for (const key of order) {
      if (!withFormula.has(key)) continue
      const col = byKey.get(key)!
      trailing.push({
        colId: `__export_formula:${key}`,
        header: `${col.label} (formula)`,
        key: formulaKeyFor(key, a.scope),
        value: (row) => a.formulaOf!(row, key) ?? null,
      })
    }
  }

  return exportGridCsv(a.api, a.base, {
    columns: a.mode === 'all' ? a.orderedKeys : 'displayed',
    keyOf,
    valueOf,
    leading,
    trailing,
    suffix: exportSuffix(a.mode, a.viewName),
    narrowed: a.narrowed,
  })
}

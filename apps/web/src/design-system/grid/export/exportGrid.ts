/**
 * GDS — export the grid an operator is looking at.
 *
 * `gridCsv.ts` supplies the FORMAT (RFC 4180, a UTF-8 BOM so Excel does not mojibake an Italian
 * product name, a dated file name). This supplies the SOURCE: the columns that are on screen, the
 * rows in the operator's own sort and filter order, and each cell rendered the way the grid renders
 * it. Without it every page that wants an export re-derives all three, and they drift.
 *
 * 🔴 WHY IT REFUSES UNDER SSRM, rather than exporting something.
 * `gridCsv.ts`'s header states the rule this obeys: AG's own exporter walks the rows the GRID is
 * holding, and under the Server-Side Row Model that is the loaded blocks, not the result set — so
 * on a catalogue larger than one page the file is a silent subset of what the operator filtered to,
 * and nothing in it says so. That is worse than no export. A page on SSRM must fetch its own
 * filtered scope and call `toCsv` directly, which is what /products/next does.
 *
 * A SHEET is the case this exists for: it is CSRM, every row is in the browser, and "the rows the
 * grid is holding" and "the result set" are the same thing. So exporting from the grid is honest
 * HERE and dishonest THERE, and the difference is checked rather than left to the caller to
 * remember.
 *
 * THE IMPORTABLE FILE (design V.5, 2026-09-04). A sheet passes `keyOf` — the machine key per
 * column — and the file gains D15.2's second header line, so the import can read what the export
 * wrote. It may also pass `leading`/`trailing` columns computed from row DATA rather than from a
 * grid column: the identity band absorbed the `sku` column (#714), so the one column the import
 * matches rows on is no longer a column at all, and a formula's expression (`key.formula`, D15.8)
 * never was one. And it may ask for `'all'` columns — every column the grid holds, shown or hidden,
 * in an order it names — so "Export all attributes" needs no Customise round-trip first.
 */
import type { GridApi, IRowNode } from 'ag-grid-community'

import { AG_AUTO_COL, AG_SELECTION_COL } from '../columns/columnPrefs'
import { csvFileName, downloadCsv, toCsv, type CsvColumn } from './gridCsv'

/**
 * AG's own columns, which carry no data an operator would want in a file.
 *
 * 🔴 `ag-Grid-AutoColumn` is here for a reason worth stating: it is the TREE column, its header is
 * empty, and its value is the group key — which on the studio sheet is the row's **cuid**. Left in,
 * every export opened with a blank first column header and a database id under it. A file that
 * leaks internal ids is worse than one that omits a column.
 */
const ENGINE_COLUMNS: readonly string[] = [AG_SELECTION_COL, AG_AUTO_COL]

/**
 * What `String(anObject)` produces. AG's `useFormatter` stringifies whatever the column holds, so a
 * cell whose value is a structured projection (a readiness verdict, a coverage roll-up) arrives as
 * this literal rather than as an object `csvField` could recognise and blank.
 */
const STRINGIFIED_OBJECT = '[object Object]'

/**
 * The minimal slice of a grid this needs, so the decisions below are testable without mounting AG.
 * The adapter at the foot of the file is the only part that knows `GridApi`.
 */
export interface GridCsvSource {
  /** `'clientSide'`, `'serverSide'`, … — the honesty check above turns on this. */
  rowModelType: string
  /**
   * The columns to write, in file order. `key` is D15.2's machine key: a string writes it on the
   * key row, `null` writes an empty key cell (informational), undefined means this source has no
   * keys — and if no column has one, no key row is written (see `gridCsv.ts`).
   */
  columns: ReadonlyArray<{ colId: string; header: string; key?: string | null }>
  /** Rows after the operator's filters and sort, top to bottom. */
  rows: ReadonlyArray<{ key: string; isData: boolean }>
  /** The cell as the grid renders it. */
  cell: (rowKey: string, colId: string) => unknown
  /** Is a filter or a search narrowing what is on screen? Decides the `-filtered` suffix. */
  narrowed: boolean
  /** Names which columns the file holds (`all`, `view-pricing`) — part of the file name. */
  suffix?: string
}

export interface GridCsvResult {
  fileName: string
  rows: number
  columns: number
  /** Whether the file carries D15.2's key row — so a caller can say "importable" honestly. */
  keyed: boolean
  csv: string
}

/** Why an export did not happen, in words a caller can show. */
export class GridExportRefused extends Error {}

/**
 * The pure core: source → CSV. No DOM, no download, no AG.
 *
 * A row that is not `isData` — a group header, a pinned totals row, the family footer sentinel
 * /products/next appends under an expanded family — is DROPPED rather than exported as a row of
 * mostly-blank cells. AG offers `shouldRowBeSkipped` for the same problem; a skip-list is a patch
 * on the wrong source, so the caller states what a data row is instead.
 */
export function gridCsvRows(source: GridCsvSource, base: string, date?: Date): GridCsvResult {
  if (source.rowModelType === 'serverSide' || source.rowModelType === 'infinite') {
    throw new GridExportRefused(
      'This grid loads rows from the server as you scroll, so the file would silently hold only the part already loaded. Export the query instead.',
    )
  }
  const columns = source.columns.filter((c) => !ENGINE_COLUMNS.includes(c.colId))
  const rows = source.rows.filter((r) => r.isData)
  /**
   * A column that renders a structured value through a `cellRenderer` and declares no
   * `valueFormatter` reaches here as the literal `[object Object]` — AG's `useFormatter` stringifies
   * whatever the column holds, so `csvField`'s own object check never sees an object to blank.
   * That string is not a value, it is the ABSENCE of one, and writing it puts nonsense in front of
   * an operator (measured: the readiness column, in the first real export). The fix for the column
   * is a `valueFormatter`; the fix for the FILE is never to print this.
   */
  const cell = (rowKey: string, colId: string) => {
    const v = source.cell(rowKey, colId)
    return v === STRINGIFIED_OBJECT ? null : v
  }
  const csvColumns: CsvColumn<{ key: string }>[] = columns.map((c) => ({
    header: c.header,
    value: (r) => cell(r.key, c.colId),
    ...(c.key !== undefined ? { key: c.key } : {}),
  }))
  const keyed = csvColumns.some((c) => c.key !== undefined)
  const csv = toCsv(rows, csvColumns)
  return {
    fileName: csvFileName(base, { filtered: source.narrowed, date, suffix: source.suffix }),
    rows: rows.length,
    columns: columns.length,
    keyed,
    csv,
  }
}

/** A column computed from row DATA rather than read from a grid column (the `sku` key, `key.formula`). */
export interface GridCsvExtraColumn<T> {
  /** A file-local id; must not collide with a grid column's. */
  colId: string
  header: string
  key?: string | null
  value: (data: T) => unknown
}

export interface GridCsvSourceOptions<T> {
  /**
   * `'displayed'` (default) — what is on screen, in screen order. `'all'` — every column the grid
   * holds, shown or hidden, in the grid's own order. An explicit list — those colIds, in THAT order
   * (a sheet passes its ruled order so "all attributes" reads the same in the file as on a fresh
   * sheet). Engine columns are always dropped; an id the grid does not have is skipped.
   */
  columns?: 'displayed' | 'all' | readonly string[]
  /** D15.2's key per grid column. Return `null` for an informational column. Omit for no key row. */
  keyOf?: (colId: string) => string | null
  /** Data-derived columns before / after the grid's. */
  leading?: readonly GridCsvExtraColumn<T>[]
  trailing?: readonly GridCsvExtraColumn<T>[]
  /** See `GridCsvSource.suffix`. */
  suffix?: string
  /**
   * The FILE form of a grid column's cell, when it must not be what the grid renders. A list-shaped
   * cell renders as a chip row and stringifies as `a,b`; a measure renders `12.5 kg` from an
   * object; neither is a value the import can read back without being TOLD the form. A caller that
   * knows the column's shape returns the declared file form here (and declares it in `keyOf`);
   * `undefined` means "render it the way the grid does".
   */
  valueOf?: (colId: string, data: T) => unknown
}

/**
 * AG → the source above. One call from a page's Export control.
 *
 * `forEachNodeAfterFilterAndSort` is the only walk that matches what is on screen: the row model's
 * own order is the unsorted one, and `getRenderedNodes()` is the VIEWPORT — twenty of twenty-one
 * rows on a sheet that has scrolled, which is the viewport-subset bug one level down.
 *
 * `getCellValue({ useFormatter: true })` renders the cell the way the column does (`valueFormatter`,
 * the group column's display logic), so `€1,234` in the grid is `€1,234` in the file rather than
 * `123400` cents. Needs `CellApiModule`, which is registered. It addresses the column MODEL, so a
 * hidden column renders exactly as it would if shown — which is what makes `'all'` honest.
 */
export function gridCsvSourceFromApi<T>(api: GridApi<T>, opts: GridCsvSourceOptions<T> = {}): GridCsvSource {
  const want = opts.columns ?? 'displayed'
  const gridColumns =
    want === 'displayed' ? api.getAllDisplayedColumns()
    : want === 'all' ? api.getAllGridColumns()
    : want.map((id) => api.getColumn(id)).filter((c): c is NonNullable<typeof c> => !!c)
  const keyOf = opts.keyOf
  const columns: GridCsvSource['columns'] = [
    ...(opts.leading ?? []).map((c) => ({ colId: c.colId, header: c.header, ...(c.key !== undefined ? { key: c.key } : {}) })),
    ...gridColumns.map((c) => {
      const colId = c.getColId()
      return {
        colId,
        header: c.getColDef().headerName ?? colId,
        ...(keyOf ? { key: keyOf(colId) } : {}),
      }
    }),
    ...(opts.trailing ?? []).map((c) => ({ colId: c.colId, header: c.header, ...(c.key !== undefined ? { key: c.key } : {}) })),
  ]
  const extras = new Map<string, GridCsvExtraColumn<T>>()
  for (const c of [...(opts.leading ?? []), ...(opts.trailing ?? [])]) extras.set(c.colId, c)

  const nodes: IRowNode<T>[] = []
  api.forEachNodeAfterFilterAndSort((node) => nodes.push(node))
  const byKey = new Map<string, IRowNode<T>>()
  nodes.forEach((n, i) => byKey.set(n.id ?? `#${i}`, n))
  return {
    rowModelType: String(api.getGridOption('rowModelType') ?? 'clientSide'),
    columns,
    rows: nodes.map((n, i) => ({
      key: n.id ?? `#${i}`,
      /**
       * 🔴 A row with DATA is a record; a row without is layout. Not `!n.group`.
       *
       * On a tree the family's parent IS a record — it is the master product, it holds every master
       * attribute, and the sheet edits it — and AG still marks it `group: true` because it has
       * children. Filtering on `group` dropped the parent from every export: 20 lines for a
       * 21-row family, with the row an operator most wanted missing and nothing saying so.
       * A real aggregation group row has no `data`, so this tells them apart honestly.
       */
      isData: !n.rowPinned && !n.footer && n.data != null,
    })),
    cell: (rowKey, colId) => {
      const node = byKey.get(rowKey)
      if (!node) return null
      const extra = extras.get(colId)
      if (extra) return node.data == null ? null : extra.value(node.data)
      if (opts.valueOf && node.data != null) {
        const declared = opts.valueOf(colId, node.data)
        if (declared !== undefined) return declared
      }
      return api.getCellValue({ rowNode: node, colKey: colId, useFormatter: true })
    },
    // `isAnyFilterPresent` covers the column filters AND the quick filter; a page whose own search
    // narrows `rowData` before the grid sees it passes that in itself.
    narrowed: api.isAnyFilterPresent(),
    ...(opts.suffix ? { suffix: opts.suffix } : {}),
  }
}

export interface ExportGridCsvOptions<T> extends GridCsvSourceOptions<T> {
  /** The page's own narrowing (a search applied before AG sees the rows). OR'd with AG's filters. */
  narrowed?: boolean
}

/**
 * Export what is on screen — or what the options name — and hand the file to the browser. Returns
 * what was written so a caller can say "142 rows, 16 columns" rather than leaving the operator
 * guessing whether it worked.
 *
 * Throws `GridExportRefused` under a server-side row model — catch it and show the message.
 */
export function exportGridCsv<T>(api: GridApi<T>, base: string, opts: ExportGridCsvOptions<T> = {}): GridCsvResult {
  const { narrowed, ...sourceOpts } = opts
  const source = gridCsvSourceFromApi(api, sourceOpts)
  const result = gridCsvRows(narrowed === undefined ? source : { ...source, narrowed: source.narrowed || narrowed }, base)
  downloadCsv(result.fileName, result.csv)
  return result
}

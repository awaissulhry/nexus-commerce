/**
 * CSV for a grid, declared once.
 *
 * WHY THIS IS NOT `api.exportDataAsCsv()`
 * AG's own exporter walks the rows the GRID is holding. Under the Server-Side Row Model that is
 * the loaded blocks, not the result set — so on a catalogue larger than one page the file is a
 * silent subset of what the operator filtered to, and nothing in it says so. It also exports every
 * row the grid holds, including rows a page injected for layout: /products/next appends a
 * `FamilyFooterRow` sentinel under an expanded family ("Showing 10 of 40 variations"), which is a
 * row to AG and would land in the file as data. AG offers `shouldRowBeSkipped` for that, but a
 * skip-list is a patch on the wrong source: the fix is to export the QUERY, not the viewport.
 *
 * So a page fetches its full filtered scope and hands the rows here with the columns it is
 * showing. What the operator sees is what they get, because the `value` functions below are the
 * grid's own — not a second implementation on the server that has to re-derive coverage
 * roll-ups, channel states and sales windows, and drift from them.
 *
 * THE KEY ROW (D15.2, 2026-09-04). A column may carry a machine `key`. When any column does, the
 * file gets a SECOND header line holding the keys — the studio import matches on that line and
 * ignores the human one, so "the file you exported is the file you import" (D15.1) is literally
 * true. A column with `key: null` is informational (identity, readiness): its key cell is empty
 * and the import skips it. A column with `key` UNDEFINED is a grid that knows nothing of keys, and
 * if every column is like that no key row is written — every existing export is byte-identical.
 *
 * RFC 4180: fields containing a comma, a quote or a newline are wrapped in quotes and inner
 * quotes are doubled; rows end CRLF. `downloadCsv` prepends a UTF-8 BOM — without it Excel reads
 * the file as the local 8-bit codepage and every Italian product name arrives mojibake.
 */

export interface CsvColumn<TRow> {
  header: string
  /** The cell's value. Give a scalar: an object has no honest CSV form. */
  value: (row: TRow) => unknown
  /**
   * The machine key for the second header line. `null` = an informational column with an empty
   * key cell; undefined = this column has no notion of a key (see the header).
   */
  key?: string | null
}

/** One field, escaped. `null`/`undefined` are empty, never the strings "null"/"undefined". */
export function csvField(value: unknown): string {
  if (value == null) return ''
  const s =
    value instanceof Date ? value.toISOString()
    : typeof value === 'object' ? ''
    : String(value)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Does this column set carry keys at all? One column with a defined key makes the key row. */
export function hasKeyRow<TRow>(columns: readonly CsvColumn<TRow>[]): boolean {
  return columns.some((c) => c.key !== undefined)
}

export function toCsv<TRow>(rows: readonly TRow[], columns: readonly CsvColumn<TRow>[]): string {
  const lines = [columns.map((c) => csvField(c.header)).join(',')]
  if (hasKeyRow(columns)) lines.push(columns.map((c) => csvField(c.key ?? '')).join(','))
  for (const row of rows) lines.push(columns.map((c) => csvField(c.value(row))).join(','))
  return lines.join('\r\n')
}

/**
 * Hand the file to the browser. A Blob, not a data: URL — a data: URL is capped well below the
 * size of a real catalogue export, and fails by truncating rather than by erroring.
 */
export function downloadCsv(fileName: string, csv: string): void {
  if (typeof document === 'undefined') return
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoked on the next frame: revoking synchronously races the click in Safari and the file
  // arrives empty.
  requestAnimationFrame(() => URL.revokeObjectURL(url))
}

/**
 * `products-2026-08-31.csv`, plus a note when the export is narrowed — two exports taken minutes
 * apart under different filters must not both be `products.csv` in the operator's downloads.
 *
 * `suffix` names WHICH columns the file holds (`all`, `view-pricing`) for the same reason: an
 * "all attributes" export and a "Pricing" export of the same family on the same day are different
 * files and must not share a name.
 */
export function csvFileName(base: string, opts: { filtered?: boolean; date?: Date; suffix?: string } = {}): string {
  const d = opts.date ?? new Date()
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const suffix = opts.suffix ? `-${opts.suffix.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')}` : ''
  return `${base}-${stamp}${suffix}${opts.filtered ? '-filtered' : ''}.csv`
}

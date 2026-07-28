/**
 * AX-IE.2 — the spreadsheet library boundary.
 *
 * Every ExcelJS call for the ads bulksheet lives in this file and nowhere else.
 * That is deliberate: the library situation is unstable (upstream `exceljs` last
 * published 2024-12-20; `@protobi/exceljs` is the maintained MIT fork; npm's
 * `xlsx` is frozen at 0.18.5), and `exceljs` is ALSO a direct dependency of
 * apps/web and of 12+ files in apps/api including the untouchable flat-file
 * substrate. Swapping it globally is not an ads change. With the boundary here,
 * swapping it for the ads path later is editing this one file.
 *
 * Three landmines are handled here rather than at each call site:
 *
 *  • **No backpressure in WorkbookWriter** (exceljs#2916). Committing rows in a
 *    tight loop grows RSS without bound, so the writer drains explicitly.
 *  • **dataValidations duplicate on round-trip write.** Validations are always
 *    rebuilt from the schema, never read-then-rewritten.
 *  • **Numbers writes structurally different XLSX** — different `dimension`
 *    refs, sometimes missing `r` attributes on rows and cells. The reader keys
 *    off header NAMES and its own counter, never a cell's claimed address.
 */

import type { Readable } from 'node:stream'
import { NUM_FMT, type BulksheetCellType } from '@nexus/shared/ads-bulksheet'

/** A value the writer knows how to place in a cell. `null` writes a blank. */
export type CellValue = string | number | Date | null

/**
 * AX-IE.7 — a cell that also carries why it is wrong.
 *
 * Marking the OFFENDING CELL rather than the row is the difference between "row
 * 412 has a problem" and landing the operator on the exact value to retype.
 */
export interface AnnotatedCell {
  value: CellValue
  fill?: 'error' | 'conflict' | 'ok'
  note?: string
}
export type RowCell = CellValue | AnnotatedCell

const FILL_ARGB: Record<NonNullable<AnnotatedCell['fill']>, string> = {
  error: 'FFFDE7E9',    // soft red — readable behind black text, unlike a saturated fill
  conflict: 'FFFFF4E5', // amber
  ok: 'FFEAF7ED',       // green
}

function isAnnotated(c: RowCell): c is AnnotatedCell {
  return c !== null && typeof c === 'object' && !(c instanceof Date) && 'value' in c
}

export interface SheetColumnSpec {
  header: string
  type: BulksheetCellType
  /** Offer these as a dropdown. Rebuilt from scratch every export. */
  allowedValues?: readonly string[]
  /** Hover text on the header cell — the Dictionary definition. */
  headerNote?: string
  /** Hidden column: present for the round trip, out of the operator's way. */
  hidden?: boolean
}

export interface SheetSpec {
  name: string
  columns: readonly SheetColumnSpec[]
  /** Hidden sheets back dropdowns and metadata without cluttering the tabs. */
  hidden?: boolean
  /** Freeze the header row and the leading identity columns. */
  freeze?: { rows: number; columns: number }
}

export interface SpreadsheetWriter {
  addSheet(spec: SheetSpec): void
  addRow(sheet: string, values: readonly RowCell[]): Promise<void>
  /** Finish and return the workbook bytes. */
  toBuffer(): Promise<Buffer>
}

export interface ParsedSheet {
  name: string
  /** Headers exactly as they appeared, in order. */
  headers: string[]
  /**
   * One entry per data row. `rowNumber` is the 1-based sheet row so an error can
   * name a real cell address the operator can navigate to.
   */
  rows: Array<{ rowNumber: number; cells: Record<string, string> }>
}

export interface SpreadsheetReader {
  read(input: Buffer | Readable): Promise<ParsedSheet[]>
}

/** Rows beyond this stream rather than buffer. Below it the simpler path is faster. */
export const STREAMING_ROW_THRESHOLD = 20_000

/**
 * Normalise any ExcelJS cell value to a trimmed string.
 *
 * ExcelJS hands back rich text, hyperlink objects, formula wrappers and Dates
 * depending on how the cell was authored — and Numbers re-saves change which.
 * Formula cells yield their cached `result`, which is exactly why formula columns
 * are read-only on import: a sheet that has been through Numbers may carry no
 * cached value at all.
 */
export function cellToString(v: unknown): string {
  if (v == null) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o.text === 'string') return o.text.trim()
    if (Array.isArray(o.richText)) return (o.richText as Array<{ text?: string }>).map((t) => t.text ?? '').join('').trim()
    if (o.result != null) return String(o.result).trim()
    if (o.hyperlink != null) return String(o.text ?? o.hyperlink).trim()
    if (o.error != null) return ''
    return ''
  }
  // NFC-normalise and fold NBSP so a value pasted from a browser compares equal
  // to the same value typed by hand.
  return String(v).replace(/ /g, ' ').normalize('NFC').trim()
}

/**
 * Prefix-escape values a spreadsheet would otherwise evaluate.
 *
 * D6 — for XLSX this is now used only as a PREDICATE ("would this need
 * quoting?"); the workbook writer applies ExcelJS `quotePrefix` styling instead
 * of mutating the value. It remains the correct escape for the CSV path, where
 * there is no styling and prefixing the value is the only defence.
 */
export function escapeFormulaInjection(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
}

// ── ExcelJS implementation ────────────────────────────────────────────

type ExcelJSModule = typeof import('exceljs')

async function loadExcelJS(): Promise<ExcelJSModule> {
  // Single import site. Swapping to @protobi/exceljs is changing this specifier.
  return (await import('exceljs')).default as unknown as ExcelJSModule
}

/** D5 — hidden sheet holding enum ranges for data validation. */
const LISTS_SHEET = 'Lists'

/**
 * 0-based column index → Excel letter. Deliberately local: the identical helper
 * lives in import-validate.ts, which imports THIS module, so sharing it either
 * way round would close a require cycle.
 */
function colLetter(index: number): string {
  let n = index + 1, out = ''
  while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26) }
  return out
}

class ExcelJsWriter implements SpreadsheetWriter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private wb: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sheets = new Map<string, any>()
  private specs = new Map<string, SheetSpec>()
  /** D5 — enum values already given a defined name, keyed by their joined value. */
  private listNames = new Map<string, string>()
  private listCol = 0
  // Deliberately NOT in `sheets`: that map is the DATA-sheet registry and
  // toBuffer() resolves a SheetSpec for every entry. Lists has no spec.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private listsWs: any = null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(wb: any) { this.wb = wb }

  /**
   * D5 — park an enum on a hidden `Lists` sheet and return a defined-name
   * reference for data validation, or null when an inline list is safely short.
   *
   * Two defects, one fix. Excel caps an inline list formula at 255 characters
   * and the Entity enum is 278, so the workbook was being REPAIRED on open.
   * And the validation object was previously constructed per row — O(rows ×
   * enum-columns), ~93k objects at current volume — where a named range is
   * built once and referenced.
   */
  private listRangeFor(header: string, values: readonly string[]): string | null {
    const inlineLength = values.join(',').length + 2
    if (inlineLength <= 255) return null // short enough; no sheet clutter

    const key = values.join('\u0000')
    const existing = this.listNames.get(key)
    if (existing) return `=${existing}`

    if (!this.listsWs) {
      // Hidden so operators never see it, and kept out of the data-sheet
      // registry so it is never treated as an exportable sheet.
      this.listsWs = this.wb.addWorksheet(LISTS_SHEET, { state: 'veryHidden' })
    }
    const ws = this.listsWs
    this.listCol += 1
    const col = this.listCol
    ws.getCell(1, col).value = header
    values.forEach((v, i) => { ws.getCell(i + 2, col).value = v })

    const name = `_bulk_${header.replace(/[^A-Za-z0-9]/g, '_')}`
    const letter = colLetter(col - 1)
    // Absolute, sheet-qualified — a defined name must not drift with insertions.
    this.wb.definedNames.add(`'${LISTS_SHEET}'!$${letter}$2:$${letter}$${values.length + 1}`, name)
    this.listNames.set(key, name)
    return `=${name}`
  }

  addSheet(spec: SheetSpec): void {
    const ws = this.wb.addWorksheet(spec.name, spec.hidden ? { state: 'hidden' } : undefined)
    const header = ws.addRow(spec.columns.map((c) => c.header))
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    header.alignment = { wrapText: true, vertical: 'middle' }
    header.height = 30
    spec.columns.forEach((c, i) => {
      const cell = header.getCell(i + 1)
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } }
      // The Dictionary definition, on the header, so analysts hover instead of
      // switching sheets.
      if (c.headerNote) cell.note = c.headerNote
      const col = ws.getColumn(i + 1)
      const fmt = NUM_FMT[c.type]
      if (fmt) col.numFmt = fmt
      if (c.hidden) col.hidden = true
    })
    if (spec.freeze) {
      ws.views = [{ state: 'frozen', xSplit: spec.freeze.columns, ySplit: spec.freeze.rows, activeCell: 'A2' }]
    }
    if (typeof header.commit === 'function') header.commit()
    this.sheets.set(spec.name, ws)
    this.specs.set(spec.name, spec)
  }

  async addRow(sheet: string, values: readonly RowCell[]): Promise<void> {
    const ws = this.sheets.get(sheet)
    if (!ws) throw new Error(`[bulksheet] unknown sheet "${sheet}"`)
    // D6 — write the RAW value, not an escaped copy of it.
    //
    // MEASURED, not assumed: ExcelJS writes a JS string as an XLSX *string*
    // cell (ValueType.String), and a string cell is never evaluated by Excel —
    // only an explicit <f> formula element is. So the injection defence for
    // XLSX is the cell TYPE, which we already get for free. quotePrefix is
    // applied as belt-and-braces (it stops Excel re-interpreting the value if
    // an operator edits the cell) but it does NOT survive an ExcelJS
    // write→load round trip, so nothing may depend on reading it back.
    //
    // The escape is still essential for the CSV path, where cells carry no type.
    // The defect: escapeFormulaInjection prepended a literal apostrophe to the
    // VALUE, so a campaign named "-50% Sale" was written as "'-50% Sale" — real
    // data, not a display convention. The baseline is hashed pre-escape
    // (build-workbook:184), so the exported cell no longer matched its own
    // fingerprint and a re-upload read as an external change.
    const needsQuote = values.map((c) => {
      const v = isAnnotated(c) ? c.value : c
      return typeof v === 'string' && v !== escapeFormulaInjection(v)
    })
    const plain = values.map((c) => (isAnnotated(c) ? c.value : c))
    const row = ws.addRow(plain)
    needsQuote.forEach((q, i) => {
      if (q) row.getCell(i + 1).style = { ...row.getCell(i + 1).style, quotePrefix: true }
    })
    values.forEach((c, i) => {
      if (!isAnnotated(c) || (!c.fill && !c.note)) return
      const cell = row.getCell(i + 1)
      if (c.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL_ARGB[c.fill] } }
      if (c.note) cell.note = c.note
    })
    if (typeof row.commit === 'function') row.commit()
    await this.maybeDrain()
  }

  /**
   * exceljs#2916 — WorkbookWriter exposes no backpressure, so a tight commit loop
   * grows RSS until the process dies. Yield whenever the sink is backed up.
   */
  private rowsSinceDrain = 0
  private async maybeDrain(): Promise<void> {
    if (++this.rowsSinceDrain < 1000) return
    this.rowsSinceDrain = 0
    const stream = this.wb.stream as { writableLength?: number; once?: (e: string, cb: () => void) => void } | undefined
    if (stream?.once && (stream.writableLength ?? 0) > (1 << 20)) {
      await new Promise<void>((resolve) => stream.once!('drain', resolve))
    } else {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  /**
   * Finalise. Dropdowns and autofilter are applied here, from the schema, once —
   * never carried over from a read workbook, because ExcelJS duplicates
   * dataValidations on round-trip write.
   */
  async toBuffer(): Promise<Buffer> {
    for (const [name, ws] of this.sheets) {
      const spec = this.specs.get(name)!
      const lastRow = ws.rowCount ?? 1
      const lastCol = spec.columns.length
      if (lastCol > 0 && lastRow > 1) {
        // Exact used range — never whole columns; Excel and Numbers both mishandle those.
        ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: lastRow, column: lastCol } }
      }
      spec.columns.forEach((c, i) => {
        if (!c.allowedValues?.length) return
        // D5 — an inline `"a,b,c…"` list is capped at 255 characters by Excel.
        // The 16 Entity values produce 278, so Excel REPAIRED the workbook on
        // open — and a repair prompt taints the whole file. A defined name has
        // no length limit. Falls back to inline only for short lists, so a new
        // enum cannot silently reintroduce the ceiling.
        const named = this.listRangeFor(c.header, c.allowedValues)
        const inline = `"${c.allowedValues.join(',')}"`
        const formula = named ?? inline
        for (let r = 2; r <= lastRow; r++) {
          ws.getCell(r, i + 1).dataValidation = {
            type: 'list', allowBlank: true, formulae: [formula], showErrorMessage: true,
            errorTitle: c.header, error: `Must be one of: ${c.allowedValues.join(', ')}`,
          }
        }
      })
      // Width from the header and a sample of the data, capped. p95-ish without
      // sorting every column: one 300-character search term must not blow out the layout.
      spec.columns.forEach((c, i) => {
        if (c.hidden) return // sizing a hidden column would un-hide it in some readers
        const col = ws.getColumn(i + 1)
        let widest = c.header.length
        let seen = 0
        col.eachCell?.({ includeEmpty: false }, (cell: { value: unknown }) => {
          if (seen++ > 500) return
          const len = cellToString(cell.value).length
          if (len > widest && len <= 60) widest = len
        })
        col.width = Math.min(60, widest + 2)
      })
    }
    const buf = await this.wb.xlsx.writeBuffer()
    return Buffer.from(buf)
  }
}

export async function createWriter(): Promise<SpreadsheetWriter> {
  const ExcelJS = await loadExcelJS()
  return new ExcelJsWriter(new ExcelJS.Workbook())
}

class ExcelJsReader implements SpreadsheetReader {
  async read(input: Buffer | Readable): Promise<ParsedSheet[]> {
    const ExcelJS = await loadExcelJS()
    const wb = new ExcelJS.Workbook()
    // ExcelJS types `load` against its own Buffer flavour; the runtime accepts a
    // Node Buffer unchanged.
    if (Buffer.isBuffer(input)) await wb.xlsx.load(input as unknown as ArrayBuffer)
    else await wb.xlsx.read(input)

    const out: ParsedSheet[] = []
    wb.eachSheet((ws) => {
      const headers: string[] = []
      const headerRow = ws.getRow(1)
      // Numbers omits `r` attributes and writes different dimension refs, so read
      // by index up to actualColumnCount rather than trusting cell addresses.
      const cols = Math.max(ws.actualColumnCount ?? 0, ws.columnCount ?? 0)
      for (let c = 1; c <= cols; c++) headers.push(cellToString(headerRow.getCell(c).value))
      while (headers.length && headers[headers.length - 1] === '') headers.pop()
      if (!headers.length) return

      const rows: ParsedSheet['rows'] = []
      ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return
        const cells: Record<string, string> = {}
        let any = false
        headers.forEach((h, i) => {
          if (!h) return
          const v = cellToString(row.getCell(i + 1).value)
          cells[h] = v
          if (v) any = true
        })
        if (any) rows.push({ rowNumber, cells })
      })
      out.push({ name: ws.name, headers, rows })
    })
    return out
  }
}

export async function createReader(): Promise<SpreadsheetReader> {
  return new ExcelJsReader()
}

/**
 * ExcelJS's streaming reader is sensitive to the ORDER of parts inside the zip.
 * `workbook-reader.js:303` reads `this.model.sheets` while defensively guarding
 * `this.workbookRels` on the line directly above it — so a workbook whose
 * `_rels/workbook.xml.rels` is parsed before `xl/workbook.xml` throws
 * "Cannot read properties of undefined (reading 'sheets')" from inside the
 * library. Reproduced with a plain 2-row workbook.
 *
 * Callers detect it with this and fall back to the buffered reader, which does
 * not care about part order.
 */
export function isExcelJsStreamOrderingBug(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e)
  return /Cannot read properties of undefined \(reading 'sheets'\)/.test(m)
    || /Cannot read property 'sheets' of undefined/.test(m)
}

/** One row handed back by the streaming reader. */
export interface StreamedRow {
  sheet: string
  rowNumber: number
  cells: Record<string, string>
}

/**
 * Stream a workbook off DISK, row by row.
 *
 * The buffered reader materialises every cell as an object: measured at **1.4 GB
 * RSS for a 5.5 MB / 100k-row file**, a ~260x expansion that would take the
 * container down long before the documented row cap. This path holds one row at
 * a time instead, so memory is bounded by the widest row rather than the file.
 *
 * `styles:'ignore'` is a large part of the win and costs nothing here — import
 * wants values, not presentation.
 *
 * Numbers-tolerance matters more in this mode: Numbers writes different
 * `dimension` refs and sometimes omits `r` attributes, so headers are taken from
 * the first row's own array positions and every later row is read by the same
 * index, never by a claimed cell address.
 */
export async function streamWorkbook(
  filePath: string,
  onRow: (row: StreamedRow, headers: string[]) => Promise<void> | void,
  opts: { skipSheets?: (name: string) => boolean } = {},
): Promise<{ sheets: Array<{ name: string; headers: string[]; rows: number }> }> {
  const ExcelJS = await loadExcelJS()
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    // NOT `entries: 'emit'` — the spec suggests it, but emitting entries we never
    // consume is pointless here and only adds a way for the reader to stall.
    sharedStrings: 'cache',
    styles: 'ignore',
    hyperlinks: 'ignore',
    worksheets: 'emit',
  })

  const sheets: Array<{ name: string; headers: string[]; rows: number }> = []
  for await (const worksheet of reader) {
    const name = (worksheet as { name?: string }).name ?? ''
    if (opts.skipSheets?.(name)) {
      // Still have to drain it — an un-consumed worksheet stalls the reader.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of worksheet) { /* discard */ }
      continue
    }
    let headers: string[] = []
    let count = 0
    for await (const row of worksheet) {
      const values = (row.values as unknown[]) ?? []
      // ExcelJS row.values is 1-based with a hole at index 0.
      const cellsArr = values.slice(1).map((v) => cellToString(v))
      if (row.number === 1) {
        headers = cellsArr
        while (headers.length && headers[headers.length - 1] === '') headers.pop()
        continue
      }
      if (!headers.length) continue
      const cells: Record<string, string> = {}
      let any = false
      for (let i = 0; i < headers.length; i++) {
        const h = headers[i]
        if (!h) continue
        const v = cellsArr[i] ?? ''
        cells[h] = v
        if (v) any = true
      }
      if (!any) continue
      count++
      await onRow({ sheet: name, rowNumber: row.number, cells }, headers)
    }
    sheets.push({ name, headers, rows: count })
  }
  return { sheets }
}

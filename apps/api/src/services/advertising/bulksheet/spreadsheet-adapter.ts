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
  addRow(sheet: string, values: readonly CellValue[]): Promise<void>
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

/** Prefix-escape values Excel would otherwise evaluate. Also blocks CSV formula injection. */
export function escapeFormulaInjection(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
}

// ── ExcelJS implementation ────────────────────────────────────────────

type ExcelJSModule = typeof import('exceljs')

async function loadExcelJS(): Promise<ExcelJSModule> {
  // Single import site. Swapping to @protobi/exceljs is changing this specifier.
  return (await import('exceljs')).default as unknown as ExcelJSModule
}

class ExcelJsWriter implements SpreadsheetWriter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private wb: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sheets = new Map<string, any>()
  private specs = new Map<string, SheetSpec>()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(wb: any) { this.wb = wb }

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

  async addRow(sheet: string, values: readonly CellValue[]): Promise<void> {
    const ws = this.sheets.get(sheet)
    if (!ws) throw new Error(`[bulksheet] unknown sheet "${sheet}"`)
    const row = ws.addRow(values.map((v) => (typeof v === 'string' ? escapeFormulaInjection(v) : v)))
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
        const formula = `"${c.allowedValues.join(',')}"`
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

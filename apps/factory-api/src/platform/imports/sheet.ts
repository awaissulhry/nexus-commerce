import { parse } from 'csv-parse/sync'
import ExcelJS from 'exceljs'
import type { Issue } from '@nexus/factory-domain/core/errors'
import { foldWord, type RawCell } from '@nexus/factory-domain/imports/cells'
import { IMPORT_LIMITS, SHEET_TYPES, type CsvEncoding } from '@nexus/factory-domain/imports/job'
import { isBlankRow, type SheetRow } from '@nexus/factory-domain/imports/plan'

/**
 * Reading an uploaded sheet (plan A1 W0-22 "CSV and XLSX readers"; feature PLT-176) into its header row and data rows,
 * for the dry run. Nothing here knows an importer: the cells stay raw (text, numbers, booleans, dates), the domain
 * parses them per column.
 *
 *   CSV    UTF-8 (a BOM is dropped) or Windows-1252: the job's choice, else UTF-8 when the bytes are valid UTF-8, else
 *          Windows-1252 (what Excel on Windows writes). The delimiter is found from the header line: `;` (what Italian
 *          Excel writes), `,` or a tab. Quoted cells may hold delimiters and line breaks.
 *   XLSX   the first sheet, or the named one (without case or accents). A formula is read as its value (the result
 *          Excel saved with it); an Excel error value (#N/A, #DIV/0!) is read as an unreadable cell, which no column
 *          accepts; rich text as its text. Macro-enabled workbooks (with a VBA project) are refused, and so is a
 *          workbook whose parts unpack to more than IMPORT_LIMITS.maxUnpackedBytes (checked from the zip's directory
 *          before anything is unpacked).
 *
 * The header row is the first row that is not blank; blank rows are skipped and not counted; row numbers are the
 * spreadsheet's (the CSV's record number, header = its own number). More data rows than `maxRows`, or more columns than
 * IMPORT_LIMITS.maxColumns, refuses the sheet whole. Problems are SheetError issues in words, never a cell's value.
 */

export interface SheetOptions {
  readonly contentType: string
  readonly sheetName?: string | null
  readonly encoding?: CsvEncoding | null
  /** The most data rows (the importer's maxRows). */
  readonly maxRows: number
}

export interface ReadSheet {
  readonly format: 'csv' | 'xlsx'
  /** The Excel sheet read (null for CSV) and every sheet's name. */
  readonly sheet: string | null
  readonly sheets: readonly string[]
  readonly encoding: CsvEncoding | null
  readonly delimiter: string | null
  /** The header row's cells as text. */
  readonly headers: readonly string[]
  /** The data rows that are not blank. */
  readonly rows: readonly SheetRow[]
}

/** The sheet cannot be read as asked: the dry run stops with these issues. */
export class SheetError extends Error {
  override name = 'SheetError'
  constructor(readonly issues: readonly Issue[]) {
    super(issues.map((issue) => issue.message).join(' '))
  }
}

const problem = (message: string, path = 'file'): SheetError => new SheetError([{ path, message }])

export async function readSheet(bytes: Buffer, options: SheetOptions): Promise<ReadSheet> {
  if (bytes.length > IMPORT_LIMITS.maxBytes) throw problem(`The sheet is larger than ${IMPORT_LIMITS.maxBytes / 1_048_576} MiB; split it into smaller sheets.`)
  const type = options.contentType.split(';')[0]!.trim().toLowerCase()
  const read = type === SHEET_TYPES.xlsx ? await readWorkbook(bytes, options) : readCsv(bytes, options)
  return finish(read, options)
}

/** Header row, data rows, limits. */
function finish(read: Omit<ReadSheet, 'headers' | 'rows'> & { readonly all: readonly SheetRow[] }, options: SheetOptions): ReadSheet {
  const { all, ...rest } = read
  const start = all.findIndex((row) => !isBlankRow(row))
  if (start === -1) throw problem('The sheet is empty: it needs a header row and at least one row of data.')
  const header = all[start]!
  const headers = header.cells.map(headerText)
  while (headers.length > 0 && headers[headers.length - 1] === '') headers.pop()
  if (headers.length > IMPORT_LIMITS.maxColumns) throw problem(`The sheet has more than ${IMPORT_LIMITS.maxColumns} columns.`)
  const rows = all.slice(start + 1).filter((row) => !isBlankRow(row))
  if (rows.length === 0) throw problem('The sheet has a header row but no rows of data.')
  if (rows.length > options.maxRows) throw problem(`The sheet has ${rows.length} rows of data; this import takes at most ${options.maxRows}. Split it into smaller sheets.`)
  if (rows.some((row) => row.cells.length > IMPORT_LIMITS.maxColumns)) throw problem(`The sheet has more than ${IMPORT_LIMITS.maxColumns} columns.`)
  return { ...rest, headers, rows }
}

function headerText(cell: RawCell): string {
  if (cell === null || cell === undefined) return ''
  if (cell instanceof Date) return Number.isFinite(cell.getTime()) ? cell.toISOString().slice(0, 10) : ''
  if (typeof cell === 'number' && !Number.isFinite(cell)) return ''
  return String(cell).trim()
}

// ---- CSV --------------------------------------------------------------------------------------------------------------

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

/** The text of a CSV file and the encoding it was read with. */
export function decodeCsv(bytes: Buffer, asked: CsvEncoding | null | undefined): { text: string; encoding: CsvEncoding } {
  const body = bytes.subarray(0, 3).equals(UTF8_BOM) ? bytes.subarray(3) : bytes
  if (asked === 'windows-1252') return { text: new TextDecoder('windows-1252').decode(body), encoding: 'windows-1252' }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), encoding: 'utf-8' }
  } catch {
    if (asked === 'utf-8') throw problem('The file is not valid UTF-8 text; choose Windows-1252 (what Excel on Windows saves) and try again.', 'encoding')
    return { text: new TextDecoder('windows-1252').decode(body), encoding: 'windows-1252' }
  }
}

/** The delimiter of a CSV: the one of `;`, `,` and tab found most often outside quotes in the first line. */
export function detectDelimiter(text: string): string {
  const counts = new Map<string, number>([[';', 0], [',', 0], ['\t', 0]])
  let quoted = false
  for (const char of text) {
    if (char === '"') quoted = !quoted
    else if (!quoted && (char === '\n' || char === '\r')) break
    else if (!quoted && counts.has(char)) counts.set(char, counts.get(char)! + 1)
  }
  let best = ','
  let most = 0
  for (const [delimiter, count] of counts) {
    if (count > most) {
      best = delimiter
      most = count
    }
  }
  return best
}

function readCsv(bytes: Buffer, options: SheetOptions) {
  const { text, encoding } = decodeCsv(bytes, options.encoding)
  const delimiter = detectDelimiter(text)
  let records: string[][]
  try {
    records = parse(text, { delimiter, relax_column_count: true, skip_empty_lines: false }) as string[][]
  } catch (error) {
    const line = (error as { lines?: number }).lines
    throw problem(`The CSV file is not valid${typeof line === 'number' ? ` near line ${line}` : ''}: check its quotes ("…") and save it again.`)
  }
  const all: SheetRow[] = records.map((cells, index) => ({ rowNumber: index + 1, cells }))
  return { format: 'csv' as const, sheet: null, sheets: [], encoding, delimiter, all }
}

// ---- XLSX -------------------------------------------------------------------------------------------------------------

interface ZipEntry {
  readonly name: string
  readonly unpackedBytes: number
}

/** The entries of a zip file from its central directory (no unpacking), or null when it is not a zip that can be read. */
export function zipEntries(bytes: Buffer): ZipEntry[] | null {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) return null
  let end = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65_535); at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50) {
      end = at
      break
    }
  }
  if (end === -1) return null
  const count = bytes.readUInt16LE(end + 10)
  const offset = bytes.readUInt32LE(end + 16)
  if (count === 0xffff || offset === 0xffffffff || offset >= bytes.length) return null
  const entries: ZipEntry[] = []
  let at = offset
  for (let index = 0; index < count; index++) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== 0x02014b50) return null
    const unpackedBytes = bytes.readUInt32LE(at + 24)
    const nameLength = bytes.readUInt16LE(at + 28)
    const extraLength = bytes.readUInt16LE(at + 30)
    const commentLength = bytes.readUInt16LE(at + 32)
    if (unpackedBytes === 0xffffffff || at + 46 + nameLength > bytes.length) return null
    entries.push({ name: bytes.toString('utf8', at + 46, at + 46 + nameLength), unpackedBytes })
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** Why a workbook is refused before it is opened, or null. */
export function workbookProblem(bytes: Buffer): string | null {
  const entries = zipEntries(bytes)
  if (!entries) return 'The file is not a valid Excel workbook (.xlsx). Save it again from Excel as .xlsx, or as .csv.'
  if (entries.some((entry) => /(^|\/)vbaProject\.bin$/i.test(entry.name))) {
    return 'The workbook contains macros: save it as .xlsx (Excel Workbook, without macros) or .csv and upload that.'
  }
  const unpacked = entries.reduce((sum, entry) => sum + entry.unpackedBytes, 0)
  if (unpacked > IMPORT_LIMITS.maxUnpackedBytes) return 'The workbook is too large once unpacked; split it into smaller sheets.'
  if (!entries.some((entry) => entry.name === 'xl/workbook.xml')) return 'The file is not a valid Excel workbook (.xlsx). Save it again from Excel as .xlsx, or as .csv.'
  return null
}

/** One Excel cell's value as a raw cell. */
export function excelCell(value: ExcelJS.CellValue | undefined): RawCell {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value instanceof Date) return value
  if (typeof value === 'object') {
    if ('error' in value) return Number.NaN
    if ('richText' in value && Array.isArray(value.richText)) return value.richText.map((part) => part.text).join('')
    if ('formula' in value || 'sharedFormula' in value) {
      const result = (value as { result?: unknown }).result
      if (result !== null && typeof result === 'object' && 'error' in (result as object)) return Number.NaN
      return excelCell(result as ExcelJS.CellValue | undefined)
    }
    if ('text' in value) return excelCell((value as { text: ExcelJS.CellValue }).text)
  }
  return null
}

async function readWorkbook(bytes: Buffer, options: SheetOptions) {
  const refused = workbookProblem(bytes)
  if (refused) throw problem(refused)
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer)
  } catch {
    throw problem('The file is not a valid Excel workbook (.xlsx). Save it again from Excel as .xlsx, or as .csv.')
  }
  const sheets = workbook.worksheets.map((worksheet) => worksheet.name)
  const wanted = options.sheetName?.trim()
  const worksheet = wanted ? workbook.worksheets.find((entry) => foldWord(entry.name) === foldWord(wanted)) : workbook.worksheets[0]
  if (!worksheet) {
    throw problem(wanted ? `The workbook has no sheet named "${wanted}"; its sheets are ${sheets.map((name) => `"${name}"`).join(', ')}.` : 'The workbook has no sheet.', 'sheetName')
  }
  const all: SheetRow[] = []
  let tooWide = false
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const values = row.values as ExcelJS.CellValue[]
    if (values.length - 1 > IMPORT_LIMITS.maxColumns) tooWide = true
    const cells: RawCell[] = []
    for (let column = 1; column < Math.min(values.length, IMPORT_LIMITS.maxColumns + 2); column++) cells.push(excelCell(values[column]))
    all.push({ rowNumber, cells })
  })
  if (tooWide) throw problem(`The sheet has more than ${IMPORT_LIMITS.maxColumns} columns.`)
  return { format: 'xlsx' as const, sheet: worksheet.name, sheets, encoding: null, delimiter: null, all }
}

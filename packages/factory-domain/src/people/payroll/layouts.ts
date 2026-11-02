import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import { Dec, type Decimal } from '../../tax/decimal'
import type { ExportCell } from '../../views/exports'
import type { PayrollValue } from './values'

/**
 * Payroll file layouts (B-W2b-54; MES-268, MES-270; GATE-PAYROLL; design people.payroll "5 · Export and send", pop-up "CSV
 * columns"). A layout is DATA (PayrollExportLayout, per company): which columns, their order, headers, number and date
 * formats. This file is the engine, pure: it checks a definition and turns a month's values into a file's text or cells.
 * It knows no vendor. Three starters give a company something to begin from:
 *
 *   GENERIC_CSV, GENERIC_EXCEL   any labour consultant, from day one (MES-270)
 *   ZUCCHETTI                    a FIXED_WIDTH starter that is MADE UP: the record of Zucchetti's "Importa Movimenti Paga da
 *                                esterno" is UNVERIFIED and comes from the consultant's sample. It is typed into the
 *                                company's own layout row, never into this public repository. Until a person records
 *                                who confirmed it, every screen and the summary say it is not confirmed
 *
 * WHAT THE LABOUR CONSULTANT MUST CONFIRM (GATE-PAYROLL): all of `PAYROLL_TO_CONFIRM`.
 */

export const PAYROLL_TO_CONFIRM: readonly string[] = Object.freeze([
  'The provider layout: the record, its widths and formats (the Zucchetti starter here is made up; their sample replaces it).',
  'The file format they import: fixed-width text, delimited text, or XML, which the "Importa Movimenti Paga da esterno" route may ask for.',
  'Their codes (voci, causali) for each hour type, absence code and earning type.',
  'The company code (codice ditta) their software knows us by.',
  'Decimal hours (7.50) rather than hours and minutes, and how negative amounts are written.',
  'That night and holiday hours go as "of which" rows beside ordinary hours.',
  'That agency and external people stay out of the file.',
  'How a leaver\'s last working day is flagged.',
  'That earnings of an earlier month go under their own code.',
  'That a correction replaces the whole file (v2 replaces v1) rather than carrying only the differences.',
  'The character set and line ends of the file.',
  'How long our copy is kept (five years here).',
])

export const PAYROLL_FORMATS = ['DELIMITED', 'SPREADSHEET', 'FIXED_WIDTH'] as const
export type PayrollFormat = (typeof PAYROLL_FORMATS)[number]

export const COLUMN_KEYS = ['companyCode', 'employeeCode', 'month', 'periodStart', 'periodEnd', 'revision', 'kind', 'code', 'ourCode', 'meaning', 'quantity', 'unit', 'minutes', 'amount', 'currency', 'lastDay', 'constant'] as const
export type ColumnKey = (typeof COLUMN_KEYS)[number]

export const DATE_FORMATS = ['DD/MM/YYYY', 'YYYY-MM-DD', 'YYYYMMDD', 'MMYYYY', 'MM/YYYY'] as const
export type DateFormat = (typeof DATE_FORMATS)[number]
export const DELIMITERS = [';', ',', '\t', '|'] as const
export const DECIMAL_SEPARATORS = [',', '.'] as const
export const ENCODINGS = ['UTF-8', 'ISO-8859-1'] as const
export type PayrollEncoding = (typeof ENCODINGS)[number]

export const LAYOUT_LIMITS = Object.freeze({ name: 80, provider: 60, columns: 40, header: 60, width: 200, value: 60, companyCode: 20, confirmedBy: 120 })

export interface LayoutColumn {
  readonly key: ColumnKey
  readonly header?: string
  /** FIXED_WIDTH: the column's characters. */
  readonly width?: number
  /** `number:2` (two decimals), `implied:2` (whole digits, two implied decimals, zero padded), `date:YYYYMMDD`. */
  readonly format?: string
  /** key `constant`: what the column always prints. */
  readonly value?: string
}

/** Who confirmed a provider layout against the consultant's sample, and when. */
export interface LayoutConfirmation {
  readonly on: BusinessDate
  readonly by: string
}

export interface LayoutDefinition {
  readonly columns: readonly LayoutColumn[]
  readonly delimiter?: string
  readonly decimalSeparator?: string
  readonly dateFormat?: string
  readonly encoding?: string
  readonly headerRow?: boolean
  /** The company as the provider knows it; default the company's code. */
  readonly companyCode?: string
  readonly confirmation?: LayoutConfirmation
}

const FORMAT = /^(number|implied):(\d)$/
const DATE_KEYS: ReadonlySet<ColumnKey> = new Set(['periodStart', 'periodEnd', 'lastDay', 'month'])
const NUMBER_KEYS: ReadonlySet<ColumnKey> = new Set(['quantity', 'minutes', 'amount'])

function columnFormatProblem(column: LayoutColumn): string | null {
  const format = column.format
  if (format === undefined) return null
  if (format.startsWith('date:')) return DATE_KEYS.has(column.key) && (DATE_FORMATS as readonly string[]).includes(format.slice(5)) ? null : `A date format goes on a date column and is one of ${DATE_FORMATS.join(', ')}.`
  if (FORMAT.test(format)) return NUMBER_KEYS.has(column.key) ? null : 'A number format goes on quantity, minutes or amount.'
  return 'Expected number:2, implied:2 or date:YYYYMMDD.'
}

/** A definition's problems for its format (paths without `body/`). The database asks the shape again. */
export function definitionProblems(format: PayrollFormat, definition: LayoutDefinition): Issue[] {
  const problems: Issue[] = []
  const columns = definition.columns
  if (columns.length === 0) problems.push({ path: 'definition/columns', message: 'A layout has at least one column.' })
  if (columns.length > LAYOUT_LIMITS.columns) problems.push({ path: 'definition/columns', message: `A layout has at most ${LAYOUT_LIMITS.columns} columns.` })
  columns.forEach((column, index) => {
    const at = `definition/columns/${index}`
    if (!(COLUMN_KEYS as readonly string[]).includes(column.key)) problems.push({ path: `${at}/key`, message: `Expected one of ${COLUMN_KEYS.join(', ')}.` })
    if (column.key === 'constant' && (column.value ?? '') === '') problems.push({ path: `${at}/value`, message: 'A constant column says what it prints.' })
    if (format === 'FIXED_WIDTH' && (!Number.isSafeInteger(column.width) || (column.width ?? 0) < 1 || (column.width ?? 0) > LAYOUT_LIMITS.width)) problems.push({ path: `${at}/width`, message: `A fixed-width column has a whole width of 1 to ${LAYOUT_LIMITS.width}.` })
    if (format !== 'FIXED_WIDTH' && column.width !== undefined) problems.push({ path: `${at}/width`, message: 'Only a fixed-width layout has column widths.' })
    const formatProblem = columnFormatProblem(column)
    if (formatProblem) problems.push({ path: `${at}/format`, message: formatProblem })
  })
  if (definition.delimiter !== undefined && !(DELIMITERS as readonly string[]).includes(definition.delimiter)) problems.push({ path: 'definition/delimiter', message: 'Expected ; , tab or |.' })
  if (definition.decimalSeparator !== undefined && !(DECIMAL_SEPARATORS as readonly string[]).includes(definition.decimalSeparator)) problems.push({ path: 'definition/decimalSeparator', message: 'Expected a comma or a dot.' })
  if (definition.dateFormat !== undefined && !(DATE_FORMATS as readonly string[]).includes(definition.dateFormat)) problems.push({ path: 'definition/dateFormat', message: `Expected one of ${DATE_FORMATS.join(', ')}.` })
  if (definition.encoding !== undefined && !(ENCODINGS as readonly string[]).includes(definition.encoding)) problems.push({ path: 'definition/encoding', message: `Expected one of ${ENCODINGS.join(', ')}.` })
  return problems
}

/** A definition as stored (the database asked its shape). */
export const parseDefinition = (stored: unknown): LayoutDefinition => {
  const value = (stored ?? {}) as LayoutDefinition
  return { ...value, columns: Array.isArray(value.columns) ? value.columns : [] }
}

/** The file prints the provider's code. */
export const printsProviderCode = (definition: LayoutDefinition): boolean => definition.columns.some((column) => column.key === 'code')

/** A provider layout speaks for a provider, so it stands unconfirmed until a person records who confirmed it. */
export const layoutConfirmed = (layout: { readonly provider: string | null; readonly definition: LayoutDefinition }): boolean => layout.provider === null || layout.definition.confirmation !== undefined

export const NOT_CONFIRMED_WORDS = 'Not confirmed by the labour consultant: this layout is a starting shape until their sample replaces it.'

export function confirmationWords(layout: { readonly provider: string | null; readonly definition: LayoutDefinition }): string | null {
  if (layout.provider === null) return null
  const seen = layout.definition.confirmation
  return seen ? `Confirmed by ${seen.by} on ${seen.on}.` : NOT_CONFIRMED_WORDS
}

// ---- the starters --------------------------------------------------------------------------------------------------------

export const LAYOUT_STARTERS = ['GENERIC_CSV', 'GENERIC_EXCEL', 'ZUCCHETTI'] as const
export type LayoutStarter = (typeof LAYOUT_STARTERS)[number]

export interface StarterLayout {
  readonly key: LayoutStarter
  readonly name: string
  readonly format: PayrollFormat
  readonly provider: string | null
  readonly definition: LayoutDefinition
  readonly note: string | null
}

const GENERIC_COLUMNS: readonly LayoutColumn[] = Object.freeze([
  { key: 'employeeCode', header: 'Matricola' },
  { key: 'code', header: 'Voce' },
  { key: 'quantity', header: 'Quantita' },
  { key: 'amount', header: 'Importo' },
])

export const STARTERS: Readonly<Record<LayoutStarter, StarterLayout>> = Object.freeze({
  GENERIC_CSV: {
    key: 'GENERIC_CSV',
    name: 'Generic CSV',
    format: 'DELIMITED',
    provider: null,
    definition: { columns: GENERIC_COLUMNS, delimiter: ';', decimalSeparator: ',', dateFormat: 'DD/MM/YYYY', encoding: 'UTF-8', headerRow: true },
    note: null,
  },
  GENERIC_EXCEL: {
    key: 'GENERIC_EXCEL',
    name: 'Generic Excel',
    format: 'SPREADSHEET',
    provider: null,
    definition: { columns: [{ key: 'employeeCode', header: 'Matricola' }, { key: 'month', header: 'Mese' }, { key: 'code', header: 'Voce' }, { key: 'meaning', header: 'Descrizione' }, { key: 'quantity', header: 'Quantita' }, { key: 'amount', header: 'Importo' }], headerRow: true },
    note: null,
  },
  ZUCCHETTI: {
    key: 'ZUCCHETTI',
    name: 'Zucchetti import',
    format: 'FIXED_WIDTH',
    provider: 'Zucchetti',
    definition: {
      columns: [
        { key: 'companyCode', width: 6 },
        { key: 'employeeCode', width: 7 },
        { key: 'month', width: 6, format: 'date:MMYYYY' },
        { key: 'code', width: 6 },
        { key: 'quantity', width: 7, format: 'implied:2' },
        { key: 'amount', width: 11, format: 'implied:2' },
      ],
      encoding: 'ISO-8859-1',
      headerRow: false,
    },
    note: 'A made-up starting shape, not the provider\'s record: replace it with the consultant\'s sample.',
  },
})

// ---- a file ---------------------------------------------------------------------------------------------------------------

export interface FileContext {
  readonly companyCode: string
  readonly month: string
  readonly periodStart: BusinessDate
  readonly periodEnd: BusinessDate
  readonly revision: number
}

/** "2026-10-31" (or "2026-10") in a date format. */
export function dateText(day: string, format: string): string {
  const [year = '', month = '', date = '01'] = day.split('-')
  switch (format as DateFormat) {
    case 'DD/MM/YYYY':
      return `${date}/${month}/${year}`
    case 'YYYYMMDD':
      return `${year}${month}${date}`
    case 'MMYYYY':
      return `${month}${year}`
    case 'MM/YYYY':
      return `${month}/${year}`
    default:
      return day.length === 7 ? `${year}-${month}-01` : day
  }
}

const decimalsOf = (key: ColumnKey): number => (key === 'minutes' ? 0 : 2)

/** The column's number as a decimal, when the row has one. */
function numberOf(key: ColumnKey, value: PayrollValue): Decimal | null {
  if (key === 'quantity') return value.quantity === null ? null : new Dec(value.quantity)
  if (key === 'minutes') return value.minutes === null ? null : new Dec(value.minutes)
  return value.amount === null ? null : new Dec(value.amount).div(100)
}

function numberText(column: LayoutColumn, value: PayrollValue, decimalSeparator: string): string {
  const number = numberOf(column.key, value)
  if (number === null) return ''
  const format = FORMAT.exec(column.format ?? '')
  const decimals = format ? Number(format[2]) : decimalsOf(column.key)
  if (format?.[1] === 'implied') return number.times(new Dec(10).pow(decimals)).toFixed(0)
  return number.toFixed(decimals).replace('.', decimalSeparator)
}

const dayFormatOf = (column: LayoutColumn, definition: LayoutDefinition): string => (column.format?.startsWith('date:') ? column.format.slice(5) : (definition.dateFormat ?? 'YYYY-MM-DD'))

/** A cell as text, for delimited and fixed-width files. */
function textOf(column: LayoutColumn, value: PayrollValue, context: FileContext, definition: LayoutDefinition, decimalSeparator: string): string {
  switch (column.key) {
    case 'companyCode':
      return definition.companyCode ?? context.companyCode
    case 'employeeCode':
      return value.employeeCode
    case 'month':
      return column.format ? dateText(context.month, dayFormatOf(column, definition)) : context.month
    case 'periodStart':
      return dateText(context.periodStart, dayFormatOf(column, definition))
    case 'periodEnd':
      return dateText(context.periodEnd, dayFormatOf(column, definition))
    case 'lastDay':
      return value.lastDay ? dateText(value.lastDay, dayFormatOf(column, definition)) : ''
    case 'revision':
      return String(context.revision)
    case 'kind':
      return value.kind
    case 'code':
      return value.providerCode ?? ''
    case 'ourCode':
      return value.code
    case 'meaning':
      return value.meaning
    case 'unit':
      return value.unit ?? ''
    case 'currency':
      return value.currency ?? ''
    case 'constant':
      return column.value ?? ''
    default:
      return numberText(column, value, decimalSeparator)
  }
}

/** A cell in its fixed width: numbers to the right (implied ones zero padded after the sign), words to the left. */
function padded(column: LayoutColumn, text: string): string {
  const width = column.width ?? text.length
  if (FORMAT.exec(column.format ?? '')?.[1] === 'implied' && text !== '') {
    const negative = text.startsWith('-')
    const digits = negative ? text.slice(1) : text
    return `${negative ? '-' : ''}${digits.padStart(width - (negative ? 1 : 0), '0')}`
  }
  return NUMBER_KEYS.has(column.key) ? text.padStart(width, ' ') : text.padEnd(width, ' ')
}

/** Values too long for their fixed-width column: such a file would shift every column after it. */
export function overflowingValues(definition: LayoutDefinition, format: PayrollFormat, values: readonly PayrollValue[], context: FileContext): number {
  if (format !== 'FIXED_WIDTH') return 0
  return values.filter((value) => definition.columns.some((column) => textOf(column, value, context, definition, '.').length > (column.width ?? Number.MAX_SAFE_INTEGER))).length
}

const fieldOf = (text: string, delimiter: string): string => (text.includes(delimiter) || /["\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text)

export interface TextFile {
  readonly text: string
  readonly encoding: PayrollEncoding
  readonly extension: 'csv' | 'txt'
  readonly contentType: 'text/csv' | 'text/plain'
  readonly format: 'CSV' | 'TXT'
  readonly rowCount: number
}

const headerOf = (column: LayoutColumn): string => column.header ?? column.key

/** A delimited file: the header unless the layout says none, CRLF line ends, a BOM only for UTF-8. */
export function delimitedFile(definition: LayoutDefinition, values: readonly PayrollValue[], context: FileContext): TextFile {
  const delimiter = definition.delimiter ?? ';'
  const decimal = definition.decimalSeparator ?? ','
  const line = (cells: readonly string[]): string => cells.map((cell) => fieldOf(cell, delimiter)).join(delimiter)
  const lines = [...(definition.headerRow === false ? [] : [line(definition.columns.map(headerOf))]), ...values.map((value) => line(definition.columns.map((column) => textOf(column, value, context, definition, decimal))))]
  const encoding = (definition.encoding ?? 'UTF-8') as PayrollEncoding
  return { text: `${encoding === 'UTF-8' ? '﻿' : ''}${lines.map((text) => `${text}\r\n`).join('')}`, encoding, extension: 'csv', contentType: 'text/csv', format: 'CSV', rowCount: values.length }
}

/** A fixed-width file: one record per value, no header unless the layout asks for one. */
export function fixedWidthFile(definition: LayoutDefinition, values: readonly PayrollValue[], context: FileContext): TextFile {
  const decimal = definition.decimalSeparator ?? ','
  const head = definition.headerRow === true ? [definition.columns.map((column) => headerOf(column).slice(0, column.width).padEnd(column.width ?? 0, ' ')).join('')] : []
  const records = values.map((value) => definition.columns.map((column) => padded(column, textOf(column, value, context, definition, decimal))).join(''))
  return { text: [...head, ...records].map((text) => `${text}\r\n`).join(''), encoding: (definition.encoding ?? 'ISO-8859-1') as PayrollEncoding, extension: 'txt', contentType: 'text/plain', format: 'TXT', rowCount: values.length }
}

/** A cell of a spreadsheet: numbers stay numbers, days stay dates. */
function cellOf(column: LayoutColumn, value: PayrollValue, context: FileContext, definition: LayoutDefinition): ExportCell {
  switch (column.key) {
    case 'quantity':
      return value.quantity === null ? null : { decimal: value.quantity }
    case 'minutes':
      return value.minutes
    case 'amount':
      return value.amount === null ? null : { minor: value.amount, currency: value.currency }
    case 'periodStart':
      return { day: context.periodStart }
    case 'periodEnd':
      return { day: context.periodEnd }
    case 'lastDay':
      return value.lastDay ? { day: value.lastDay } : null
    default:
      return textOf(column, value, context, definition, '.')
  }
}

export interface SpreadsheetFile {
  readonly headings: readonly string[]
  readonly rows: readonly (readonly ExportCell[])[]
  readonly rowCount: number
}

export function spreadsheetFile(definition: LayoutDefinition, values: readonly PayrollValue[], context: FileContext): SpreadsheetFile {
  return { headings: definition.columns.map(headerOf), rows: values.map((value) => definition.columns.map((column) => cellOf(column, value, context, definition))), rowCount: values.length }
}

/** A file's name: it names the company, the month and the version; the export record names the number. */
export const payrollFileName = (context: FileContext, suffix: string, extension: string): string => `PAGHE_${context.companyCode}_${context.month}_v${context.revision}${suffix}.${extension}`.replace(/[^A-Za-z0-9._-]+/g, '-')

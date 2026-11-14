import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import { isBlank, readDate, readNumberText, type NumberFormat, type RawCell } from '../../imports/cells'
import { mapHeaders, type HeaderMapping, type MappableColumn } from '../../imports/headers'
import type { SheetRow } from '../../imports/plan'
import { amountOf, ibanShape, lineProblems, MAX_STATEMENT_LINES, oneLine, StatementReadError, type BankFormat, type BankLineProblem, type ParsedLine, type ParsedStatement } from './statement'

/**
 * A statement exported by the bank as a CSV or an Excel sheet, read with a column mapping (B-W2b-393; FIN-130), pure. The
 * API reads the sheet (the imports engine's reader: CSV in UTF-8 or Windows-1252 with ; , or tab, the first sheet of an
 * xlsx or the one named) into its header row and data rows; this maps the headers to the statement's columns — by name,
 * label or the Italian and English words banks use, or as the person maps them (`mapping`: header → column, or null to
 * leave it out) — and reads each row: the booking day (day first or ISO, or an Excel date), the amount (one signed
 * column, or money in and money out in two), in the chosen number format (it: 1.234,56; en: 1,234.56).
 *
 * The sheet names no account: the person chooses the company's account, whose currency each row is in unless a
 * currency column says otherwise.
 */

export const SHEET_STATEMENT_COLUMNS = {
  bookedOn: { label: 'Booking date', aliases: ['data contabile', 'data operazione', 'data registrazione', 'data', 'booking date', 'posting date', 'date'] },
  valueOn: { label: 'Value date', aliases: ['data valuta', 'valuta', 'value date', 'value'] },
  amount: { label: 'Amount', aliases: ['importo', 'importo eur', 'importo euro', 'amount'] },
  moneyIn: { label: 'Money in', aliases: ['entrate', 'avere', 'accrediti', 'accredito', 'credit', 'credits', 'money in', 'paid in'] },
  moneyOut: { label: 'Money out', aliases: ['uscite', 'dare', 'addebiti', 'addebito', 'debit', 'debits', 'money out', 'paid out'] },
  currency: { label: 'Currency', aliases: ['divisa', 'currency'] },
  bankReference: { label: "Bank's reference", aliases: ['riferimento banca', 'riferimento', 'cro', 'trn', 'id operazione', 'bank reference', 'reference', 'transaction id'] },
  referenceText: { label: 'Reference text', aliases: ['causale', 'descrizione', 'descrizione operazione', 'dettagli', 'description', 'details', 'reference text', 'memo'] },
  counterpartyName: { label: 'Other side', aliases: ['ordinante', 'beneficiario', 'controparte', 'ordinante beneficiario', 'counterparty', 'payer', 'payee', 'name'] },
  counterpartyIban: { label: "Other side's IBAN", aliases: ['iban ordinante', 'iban beneficiario', 'iban controparte', 'counterparty iban', 'iban'] },
} as const satisfies Readonly<Record<string, MappableColumn>>
export type SheetStatementColumn = keyof typeof SHEET_STATEMENT_COLUMNS

/** The mapping of a sheet's headers, and why it cannot be read (the day and an amount are needed). */
export function mapStatementHeaders(headers: readonly string[], overrides: Readonly<Record<string, string | null>> = {}): HeaderMapping {
  const mapped = mapHeaders(SHEET_STATEMENT_COLUMNS, headers, overrides)
  const has = (column: SheetStatementColumn) => mapped.columns.some((entry) => entry.column === column)
  const issues: Issue[] = [...mapped.issues]
  if (!has('bookedOn')) issues.push({ path: 'column/bookedOn', message: 'Map the column of the booking date.' })
  if (!has('amount') && !has('moneyIn') && !has('moneyOut')) issues.push({ path: 'column/amount', message: 'Map the column of the amount, or the columns of money in and money out.' })
  if (has('amount') && (has('moneyIn') || has('moneyOut'))) issues.push({ path: 'column/amount', message: 'Map one signed amount, or money in and money out, not both.' })
  return { ...mapped, issues }
}

/** A cell as a plain decimal string, or null (blank), or false (not a number). */
function decimalCell(raw: RawCell, format: NumberFormat): string | null | false {
  if (isBlank(raw)) return null
  if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : false
  if (typeof raw !== 'string') return false
  return readNumberText(raw, format) ?? false
}

const textCell = (raw: RawCell): string | null => (isBlank(raw) ? null : raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw))

export interface SheetRows {
  readonly format: Extract<BankFormat, 'CSV' | 'XLSX'>
  readonly headers: readonly string[]
  /** Each data row's number in the sheet and its cells. */
  readonly rows: readonly SheetRow[]
}

/**
 * Reads a sheet's rows into a statement with the mapping; the statement is null while the mapping has issues (the day
 * or an amount has no column: the issues say which, and the person maps them).
 */
export function readStatementSheet(sheet: SheetRows, options: { readonly overrides?: Readonly<Record<string, string | null>>; readonly numberFormat: NumberFormat; readonly accountCurrency: string; readonly today: BusinessDate }): { statement: ParsedStatement | null; mapping: HeaderMapping } {
  const mapping = mapStatementHeaders(sheet.headers, options.overrides ?? {})
  if (mapping.issues.length > 0) return { statement: null, mapping }
  if (sheet.rows.length > MAX_STATEMENT_LINES) throw new StatementReadError('TOO_MANY_LINES')
  const at = new Map(mapping.columns.map((entry) => [entry.column as SheetStatementColumn, entry.index]))
  const cell = (cells: readonly RawCell[], column: SheetStatementColumn): RawCell => (at.has(column) ? cells[at.get(column)!] : undefined)

  const lines: ParsedLine[] = sheet.rows.map(({ rowNumber: row, cells }) => {
    const found: BankLineProblem[] = []
    const dayCell = cell(cells, 'bookedOn')
    const bookedOn = isBlank(dayCell) ? null : readDate(dayCell)
    if (!isBlank(dayCell) && bookedOn === null) found.push('BAD_DATE')
    const valueCell = cell(cells, 'valueOn')
    const valueOn = isBlank(valueCell) ? null : readDate(valueCell)
    if (!isBlank(valueCell) && valueOn === null) found.push('BAD_DATE')
    const currency = oneLine(textCell(cell(cells, 'currency')))?.toUpperCase() ?? options.accountCurrency

    let amount: number | null = null
    const signed = (text: string, sign: 1 | -1 | 0): number | null => {
      const read = amountOf(text, currency)
      if (read.problem) {
        found.push(read.problem)
        return null
      }
      return sign === 0 ? read.amount : sign * Math.abs(read.amount!)
    }
    if (at.has('amount')) {
      const text = decimalCell(cell(cells, 'amount'), options.numberFormat)
      if (text === false) found.push('BAD_AMOUNT')
      else if (text !== null) amount = signed(text, 0)
    } else {
      const inText = decimalCell(cell(cells, 'moneyIn'), options.numberFormat)
      const outText = decimalCell(cell(cells, 'moneyOut'), options.numberFormat)
      const zero = (text: string | null | false) => text === null || text === false || /^[-+]?0+(\.0+)?$/.test(text)
      if (inText === false || outText === false) found.push('BAD_AMOUNT')
      else if (!zero(inText) && !zero(outText)) found.push('BOTH_SIDES')
      else if (!zero(inText)) amount = signed(inText as string, 1)
      else if (!zero(outText)) amount = signed(outText as string, -1)
      else if (inText !== null || outText !== null) found.push('ZERO_AMOUNT')
    }
    const line = {
      row,
      bookedOn,
      valueOn,
      amount,
      currency,
      bankReference: oneLine(textCell(cell(cells, 'bankReference'))),
      referenceText: oneLine(textCell(cell(cells, 'referenceText')), 1000),
      counterpartyName: oneLine(textCell(cell(cells, 'counterpartyName')), 140),
      counterpartyIban: ibanShape(textCell(cell(cells, 'counterpartyIban'))),
    }
    return { ...line, problems: lineProblems(line, found, options.today, options.accountCurrency) }
  })
  if (lines.length === 0) throw new StatementReadError('NO_LINES')
  return { statement: { format: sheet.format, iban: null, currency: options.accountCurrency, periodStart: null, periodEnd: null, lines }, mapping }
}

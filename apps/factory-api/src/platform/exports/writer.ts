import ExcelJS from 'exceljs'
import { cellText, csvText, instantText, type ExportCell, type ExportFormat, type ExportLocale } from '@nexus/factory-domain/views/exports'

/**
 * The file of an export (B-W2a-23; PLT-179): the same cells as CSV (factory-domain views/exports csvText: BOM, the
 * language's separator and decimal mark) or as an Excel workbook (one sheet: the note line when columns were left out,
 * the header row bold and frozen, numbers as numbers, days as dates, amounts with two decimals). An amount column whose
 * rows share one currency names it in its heading ("Net (EUR)"); a column of several currencies writes it beside each
 * amount instead, so no file adds euros to dollars.
 */

export interface ExportSheet {
  readonly format: ExportFormat
  readonly locale: ExportLocale
  readonly title: string
  /** The line above the header (the columns left out by rights), or null. */
  readonly note: string | null
  readonly headings: readonly string[]
  readonly rows: readonly (readonly ExportCell[])[]
  readonly timeZone?: string
}

const isAmount = (cell: ExportCell): cell is { minor: number; currency: string | null } => cell !== null && typeof cell === 'object' && 'minor' in cell

/** Per column: the one currency of its amounts (heading suffix), or 'mixed', or null (not an amount column). */
function currencies(sheet: ExportSheet): (string | 'mixed' | null)[] {
  return sheet.headings.map((_, index) => {
    const seen = new Set<string>()
    for (const row of sheet.rows) {
      const cell = row[index] ?? null
      if (isAmount(cell) && cell.currency) seen.add(cell.currency)
    }
    if (seen.size === 0) return null
    return seen.size === 1 ? [...seen][0]! : 'mixed'
  })
}

const headingsOf = (sheet: ExportSheet, money: readonly (string | 'mixed' | null)[]): string[] =>
  sheet.headings.map((heading, index) => (money[index] && money[index] !== 'mixed' ? `${heading} (${money[index]})` : heading))

function csvOf(sheet: ExportSheet): Uint8Array {
  const money = currencies(sheet)
  const rows = sheet.rows.map((row) =>
    sheet.headings.map((_, index) => {
      const cell = row[index] ?? null
      const text = cellText(cell, sheet.locale, sheet.timeZone)
      return money[index] === 'mixed' && isAmount(cell) && cell.currency ? `${text} ${cell.currency}` : text
    }),
  )
  return Buffer.from(csvText({ locale: sheet.locale, header: headingsOf(sheet, money), rows, note: sheet.note }), 'utf8')
}

/** An Excel sheet's name: at most 31 characters, none of : \ / ? * [ ]. */
const sheetName = (title: string): string => title.replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Export'

async function xlsxOf(sheet: ExportSheet): Promise<Uint8Array> {
  const money = currencies(sheet)
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Nexus Factory'
  const worksheet = workbook.addWorksheet(sheetName(sheet.title))
  const dayFormat = sheet.locale === 'it' ? 'dd/mm/yyyy' : 'yyyy-mm-dd'
  if (sheet.note) {
    worksheet.addRow([sheet.note]).font = { italic: true }
  }
  const header = worksheet.addRow(headingsOf(sheet, money))
  header.font = { bold: true }
  worksheet.views = [{ state: 'frozen', ySplit: header.number }]
  for (const row of sheet.rows) {
    const added = worksheet.addRow(sheet.headings.map(() => null))
    sheet.headings.forEach((_, index) => {
      const cell = row[index] ?? null
      const target = added.getCell(index + 1)
      if (cell === null) return
      if (typeof cell === 'string' || typeof cell === 'number') {
        target.value = cell
      } else if ('decimal' in cell) {
        const value = Number(cell.decimal)
        target.value = Number.isFinite(value) ? value : cell.decimal
        target.numFmt = '0.####'
      } else if ('minor' in cell) {
        target.value = cell.minor / 100
        target.numFmt = money[index] === 'mixed' && cell.currency ? `#,##0.00 "${cell.currency}"` : '#,##0.00'
      } else if ('day' in cell) {
        const [year, month, day] = cell.day.split('-').map(Number)
        target.value = year && month && day ? new Date(Date.UTC(year, month - 1, day)) : cell.day
        target.numFmt = dayFormat
      } else {
        target.value = instantText(cell.at, sheet.timeZone)
      }
    })
  }
  worksheet.columns.forEach((column, index) => {
    const heading = headingsOf(sheet, money)[index] ?? ''
    column.width = Math.min(50, Math.max(10, heading.length + 2))
  })
  return new Uint8Array(await workbook.xlsx.writeBuffer())
}

export async function writeExport(sheet: ExportSheet): Promise<Uint8Array> {
  return sheet.format === 'CSV' ? csvOf(sheet) : xlsxOf(sheet)
}

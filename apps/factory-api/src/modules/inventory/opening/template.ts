import ExcelJS from 'exceljs'
import type { NumberFormat } from '@nexus/factory-domain/imports/cells'
import { SHEET_TYPES } from '@nexus/factory-domain/imports/job'
import { openingTemplate } from '@nexus/factory-domain/inventory/opening/importer'

/**
 * The opening stock import's template (A2 SCR-017 "Download template"): every column's label in the importer's order and
 * made-up example rows (hides one per row, a lot of hides in one row, a lining in metres, protectors per piece), as CSV
 * (UTF-8, `;` between cells, which an Italian Excel opens as columns) or as an Excel workbook with a second sheet that
 * explains each column. Numbers and dates are written in the format the import is told to read (Italian by default).
 */

const cellText = (value: string): string => (/[;"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)

export async function openingTemplateFile(format: 'csv' | 'xlsx', numberFormat: NumberFormat): Promise<{ name: string; contentType: string; body: Buffer }> {
  const template = openingTemplate(numberFormat)
  if (format === 'csv') {
    const lines = [template.header, ...template.rows].map((row) => row.map(cellText).join(';'))
    return { name: 'opening-stock-template.csv', contentType: `${SHEET_TYPES.csv}; charset=utf-8`, body: Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8') }
  }
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Opening stock')
  sheet.addRow([...template.header])
  for (const row of template.rows) sheet.addRow([...row])
  sheet.getRow(1).font = { bold: true }
  const help = workbook.addWorksheet('Columns')
  help.addRow(['Column', 'Required', 'What it holds'])
  for (const column of template.columns) help.addRow([column.label, column.required ? 'yes' : '', column.description ?? ''])
  help.getRow(1).font = { bold: true }
  return { name: 'opening-stock-template.xlsx', contentType: SHEET_TYPES.xlsx, body: Buffer.from(await workbook.xlsx.writeBuffer()) }
}

import type ExcelJS from 'exceljs'

// XLSX uses fixed paper colors rather than browser CSS tokens.
export const workbookColors = {
  text: 'FF1C2530', header: 'FF24324A', editHeader: 'FF234A70', white: 'FFFFFFFF',
  input: 'FFFFF8E8', reference: 'FFF0F3F6', stripe: 'FFF8FAFC', border: 'FFD8DFE7',
  actionHeader: 'FF735215', link: 'FF234A70',
} as const
export const fill = (argb: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } })

export function workbookTable(book: ExcelJS.Workbook, name: string, headers: string[], widths?: number[]) {
  const sheet = book.getWorksheet(name) ?? book.addWorksheet(name)
  sheet.views = [{ state: 'frozen', ySplit: 1, xSplit: 1, showGridLines: false }]
  sheet.properties.defaultRowHeight = 24
  sheet.columns = headers.map((header, i) => ({ header, key: header, width: widths?.[i] ?? 26,
    style: { font: { name: 'Arial', size: 10, color: { argb: workbookColors.text } }, alignment: { vertical: 'middle', wrapText: true } } }))
  const heading = sheet.getRow(1)
  heading.font = { name: 'Arial', size: 10, bold: true, color: { argb: workbookColors.white } }
  heading.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
  heading.height = 32
  heading.eachCell(cell => { cell.fill = fill(workbookColors.header); cell.border = { right: { style: 'thin', color: { argb: workbookColors.white } } } })
  sheet.pageSetup = { orientation: 'landscape', printTitlesRow: '1:1', paperSize: 9 }
  return sheet
}

export function fitWorkbookRow(row: ExcelJS.Row, maxHeight = 409) {
  let lines = 1
  row.eachCell(cell => {
    if (cell.worksheet.getColumn(cell.col).hidden) return
    const width = Math.max(8, (cell.worksheet.getColumn(cell.col).width ?? 26) - 3)
    lines = Math.max(lines, cell.text.split(/\r?\n/).reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / width)), 0))
  })
  row.height = Math.min(maxHeight, Math.max(24, lines * 14 + 10))
}

export function formatReferenceSheet(sheet: ExcelJS.Worksheet, filter = true) {
  sheet.eachRow((row, index) => {
    if (index === 1) return
    fitWorkbookRow(row)
  })
  // A bounded formatting rule keeps stripes continuous without allocating a dense
  // matrix when one attribute has thousands of choices and the others have few.
  if (sheet.rowCount > 1) sheet.addConditionalFormatting({ ref: `A2:${sheet.getColumn(sheet.columnCount).letter}${sheet.rowCount}`,
    rules: [{ type: 'expression', formulae: ['MOD(ROW(),2)=1'], priority: 1, style: { fill: fill(workbookColors.stripe) } }] })
  if (filter && sheet.rowCount > 1) sheet.autoFilter = { from: 'A1', to: { row: sheet.rowCount, column: sheet.columnCount } }
}

export function workbookLink(sheet: string, address = 'A1') {
  return { text: sheet, hyperlink: `#'${sheet.replace(/'/g, "''")}'!${address}` }
}

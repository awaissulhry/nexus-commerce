import { Readable } from 'node:stream'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { parse } from 'csv-parse'
import { TRANSFER_MAX_FILE_BYTES, TRANSFER_MAX_ROWS } from './catalog-transfer-file.js'
import type { SourceTable } from './catalog-source-mapping.js'

export async function checkWorkbookSize(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer)
  let expanded = 0
  const entries = Object.values(zip.files)
  if (entries.length > 2000) throw new Error('Workbook has too many archive entries')
  for (const entry of entries) {
    expanded += (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0
    if (expanded > 40 * 1024 * 1024) throw new Error('Expanded workbook exceeds 40 MB; reduce its rows or formatting')
  }
  return expanded
}

/** Parsing is byte/row/column bounded; only source values survive, never workbook styles. */
export async function readSourceFile(buffer: Buffer, filename: string): Promise<SourceTable> {
  if (!buffer.length || buffer.length > TRANSFER_MAX_FILE_BYTES) throw new Error('Choose a non-empty source file up to 10 MB')
  const table: SourceTable = { headers: [], records: [] }
  const append = (line: string[]) => {
    if (!table.headers.length) {
      const headers = line.map(h => h.trim().replace(/^\uFEFF/, ''))
      if (!headers.length || headers.length > 200 || headers.some(h => !h || h.length > 250) || new Set(headers).size !== headers.length) throw new Error('Use 1–200 distinct, non-empty column headers')
      if (headers.some(h => /@(?:AMAZON|EBAY|SHOPIFY|ETSY):/i.test(h))) throw new Error('This channel table export has no account identity. Use Catalog export → Edit and re-import for an editable file.')
      table.headers = headers
      return
    }
    if (line.length > table.headers.length) throw new Error('A source row has more values than the header')
    if (table.records.length >= TRANSFER_MAX_ROWS) throw new Error('A source can contain at most 50,000 rows')
    if (line.some(c => c.length > 256_000)) throw new Error('A source cell exceeds 256,000 characters')
    table.records.push(Object.fromEntries(table.headers.map((h, i) => [h, line[i] ?? ''])))
  }
  if (/\.csv$/i.test(filename)) {
    for await (const line of Readable.from(buffer).pipe(parse({ bom: true, skip_empty_lines: true, max_record_size: 256_000 }))) append(line)
  } else if (/\.xlsx$/i.test(filename)) {
    await checkWorkbookSize(buffer)
    // Workbook parsing is bounded by both compressed and expanded archive sizes above.
    // ExcelJS 4.4's streaming reader can expose unresolved shared-string references when
    // worksheet entries precede workbook metadata. Its document reader preserves the values.
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(buffer as never)
    if (workbook.worksheets.length !== 1) throw new Error('A wide source workbook must have one data worksheet; use the catalog format for an editing export')
    const sheet = workbook.worksheets[0]
    if (sheet.rowCount > TRANSFER_MAX_ROWS + 1 || sheet.columnCount > 200) throw new Error('Source workbook exceeds 50,000 rows or 200 columns')
    sheet.eachRow(row => {
      const line: string[] = []
      for (let c = 1; c <= row.cellCount; c++) {
        const cell = row.getCell(c)
        if (cell.type === ExcelJS.ValueType.Formula || cell.type === ExcelJS.ValueType.Error) throw new Error(`Row ${row.number}: replace formulas and errors with values`)
        line.push(cell.text)
      }
      if (line.some(v => v.trim())) append(line)
    })
  } else if (/\.json$/i.test(filename)) {
    const data: unknown = JSON.parse(buffer.toString('utf8'))
    if (!Array.isArray(data) || data.length > TRANSFER_MAX_ROWS || data.some(r => !r || typeof r !== 'object' || Array.isArray(r))) throw new Error('Use a JSON array of source records, at most 50,000 rows')
    const headers = [...new Set(data.flatMap(r => Object.keys(r)))]
    append(headers)
    for (const record of data) append(headers.map(h => record[h] == null ? '' : typeof record[h] === 'string' ? record[h] : JSON.stringify(record[h])))
  } else throw new Error('Use CSV, XLSX or JSON source data')
  if (!table.headers.length || !table.records.length) throw new Error('The source contains no data records')
  return table
}

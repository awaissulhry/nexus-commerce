import ExcelJS from 'exceljs'
import { parse } from 'csv-parse/sync'
import { TRANSFER_CHANNELS, TRANSFER_COLUMNS, transferFileRow, type TransferRow, type TransferIssue, type TransferEntity } from '@nexus/shared/catalog-transfer'

export const TRANSFER_MAX_ROWS = 50_000
export const TRANSFER_MAX_FILE_BYTES = 10 * 1024 * 1024
export class TransferWorkbookLimitError extends Error {
  constructor(public readonly limit: 'rows' | 'bytes') {
    super(limit === 'rows' ? 'Workbook exceeds 50,000 attribute rows' : 'Workbook exceeds the 10 MB import limit')
  }
}
const ENTITIES: TransferEntity[] = ['Products', 'Listings', 'Overrides']
const unsafeKey = (value: string) => /(^|[.\[\]])(__proto__|prototype|constructor)($|[.\[\]])/.test(value)

/** Empty action + empty value is a no-op. A populated value always needs an explicit action. */
export function parseTransferRecords(records: Record<string, string>[], entity?: string) {
  const rows: TransferRow[] = []
  const issues: TransferIssue[] = []
  for (const [i, record] of records.entries()) {
    const row = i + 2
    const get = (key: string) => (record[key] ?? '').trim()
    const sku = get('sku'), field = get('field'), action = get('action').toUpperCase()
    const error = (message: string) => issues.push({ row, sku, field, message })
    if (!action && !get('value')) continue
    const kind = get('entity') || entity || ''
    if (!ENTITIES.includes(kind as TransferEntity)) { error('entity must be Products, Listings or Overrides'); continue }
    if (!sku || !field) { error('sku and field are required'); continue }
    if (unsafeKey(field) || unsafeKey(get('locale'))) { error('Invalid field or locale'); continue }
    if (!['SET', 'CLEAR', 'INHERIT'].includes(action)) { error('Choose SET, CLEAR or INHERIT; blank action does not change data'); continue }
    if (action !== 'SET' && get('value')) { error(`${action} must have an empty value cell`); continue }
    const channel = get('channel').toUpperCase(), accountId = get('accountId'), marketplace = get('marketplace').toUpperCase(), aliasKey = get('aliasKey'), locale = get('locale').toLowerCase()
    if (kind === 'Products' && (channel || accountId || marketplace || aliasKey)) { error('Shared product rows cannot carry a channel, account, marketplace or alias'); continue }
    if (kind !== 'Products' && (!TRANSFER_CHANNELS.includes(channel) || !accountId || !marketplace)) { error('Channel rows need AMAZON, EBAY, SHOPIFY or ETSY, an accountId and a marketplace'); continue }
    if (kind !== 'Products' && locale) { error('A listing has one marketplace language; leave locale empty on channel rows'); continue }
    if (locale && !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(locale)) { error('Use a language code such as it, en or en-gb'); continue }
    let version: number | undefined
    if (get('version')) {
      version = Number(get('version'))
      if (!/^\d+$/.test(get('version')) || !Number.isSafeInteger(version)) { error('version must be a non-negative whole number'); continue }
    }
    let value: unknown
    if (action === 'SET') {
      const format = get('format') || 'text'
      if (format === 'text') value = record.value ?? ''
      else if (format === 'json') {
        try { value = JSON.parse(record.value) } catch { error('Invalid JSON value; arrays use ["one","two"] and measures use {"value":1.2,"unit":"kg"}'); continue }
        if (value === null) { error('Use CLEAR to store an empty value, or INHERIT to remove an override'); continue }
      } else { error('format must be text or json'); continue }
    }
    rows.push({ row, entity: kind as TransferEntity, sku, channel, accountId, marketplace, aliasKey, locale, field, action: action as TransferRow['action'], value, version })
  }
  return { rows, issues }
}

function recordsOf(grid: string[][]): Record<string, string>[] {
  if (!grid.length) return []
  const headers = grid[0].map(h => h.trim().replace(/^\uFEFF/, ''))
  if (new Set(headers).size !== headers.length) throw new Error('Duplicate column headers are not allowed')
  const unknown = headers.filter(h => !TRANSFER_COLUMNS.includes(h as typeof TRANSFER_COLUMNS[number]))
  if (unknown.length) throw new Error(`Unknown columns: ${unknown.join(', ')}`)
  if (!headers.includes('sku') || !headers.includes('field') || !headers.includes('action')) throw new Error('The file needs sku, field and action columns. Download a catalog template first.')
  if (grid.length - 1 > TRANSFER_MAX_ROWS) throw new Error(`A file can contain at most ${TRANSFER_MAX_ROWS.toLocaleString()} attribute rows`)
  return grid.slice(1).map(line => {
    if (line.length > headers.length) throw new Error('A data row has more cells than the header')
    return Object.fromEntries(headers.map((h, i) => [h, line[i] ?? '']))
  })
}

export async function readTransferFile(buffer: Buffer, filename: string) {
  if (!buffer.length || buffer.length > TRANSFER_MAX_FILE_BYTES) throw new Error('Choose a non-empty CSV or XLSX file up to 10 MB')
  if (/\.csv$/i.test(filename)) {
    const grid = parse(buffer, { bom: true, skip_empty_lines: true, max_record_size: 256_000 }) as string[][]
    return parseTransferRecords(recordsOf(grid))
  }
  if (!/\.xlsx$/i.test(filename)) throw new Error('Use CSV or XLSX. Other spreadsheet formats are not supported.')
  const { checkWorkbookSize } = await import('./catalog-source-file.js')
  await checkWorkbookSize(buffer)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as never)
  const { readCatalogWorkbook } = await import('./catalog-workbook.js')
  const wide = readCatalogWorkbook(workbook)
  if (wide) return wide
  const rows: TransferRow[] = [], issues: TransferIssue[] = []
  for (const sheet of workbook.worksheets) {
    if (['Instructions', 'Dictionary', 'Effective values'].includes(sheet.name)) continue
    if (!ENTITIES.includes(sheet.name as TransferEntity)) throw new Error(`Unknown worksheet "${sheet.name}". Use Products, Listings or Overrides.`)
    // ExcelJS computes columnCount by scanning every row. Read it once, outside the cell loop.
    const columnCount = sheet.columnCount
    if (sheet.rowCount > TRANSFER_MAX_ROWS + 1 || columnCount > TRANSFER_COLUMNS.length) throw new Error('Worksheet exceeds the catalog template limits')
    const grid: string[][] = []
    sheet.eachRow({ includeEmpty: true }, r => {
      const line: string[] = []
      for (let c = 1; c <= columnCount; c++) {
        const cell = r.getCell(c)
        if (cell.type === ExcelJS.ValueType.Formula || cell.type === ExcelJS.ValueType.Error) throw new Error(`${sheet.name}, row ${r.number}: replace formulas and errors with values before importing`)
        line.push(cell.text)
      }
      grid.push(line)
    })
    const parsed = parseTransferRecords(recordsOf(grid), sheet.name)
    rows.push(...parsed.rows); issues.push(...parsed.issues.map(issue => ({ ...issue, message: `${sheet.name}: ${issue.message}` })))
  }
  if (rows.length > TRANSFER_MAX_ROWS) throw new Error(`A workbook can contain at most ${TRANSFER_MAX_ROWS.toLocaleString()} attribute rows`)
  return { rows, issues }
}

/** Excel stores all identities as text; JSON preserves lists, records and numeric zero. */
export async function writeTransferWorkbook(rows: TransferRow[], dictionary: Record<string, unknown>[] = [], effective = false) {
  if (rows.length > TRANSFER_MAX_ROWS) throw new TransferWorkbookLimitError('rows')
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Nexus Commerce'
  const instructions = workbook.addWorksheet('Instructions')
  const notes = effective ? [
    'Effective listing values — review only. This workbook is not an editing import.',
    'Download an editing export to preserve inherited values and explicit overrides.',
  ] : [
    'Nexus catalog format v1 — one row per attribute. Shared values belong in Products.',
    'Choose Create, Update or Create or update on upload. SKUs identify products throughout the catalog.',
    'SET writes value. CLEAR stores an empty value. INHERIT removes the stored override.',
    'Blank action and blank value leave data unchanged. Never put CLEAR or INHERIT in the value cell.',
    'Use format text for text (including identifiers). Use json for numbers, booleans, lists and records.',
    'Text containing carriage returns or XML control characters uses json to preserve the exact text.',
    'Listings sets channel category via productType (Amazon), categoryId (eBay), category (Shopify) or taxonomy_id (Etsy). New listings are drafts.',
    'Overrides identifies one account, marketplace and alias. Empty aliasKey means the primary listing.',
    'Products metadata fields: family (family code), parentSku, categoryIds (JSON array), primaryCategoryId.',
    'New products require name and a family (or parentSku with a family). They are created as drafts.',
    'Parent SKU: use field parentSku with SET and the exact parent SKU as text. File order and SKU spelling do not define relationships.',
    'For a new family, include the parent name and family code, then each child name and parentSku. A root referenced by children becomes a parent.',
    'Example: GALE-JACKET has name=Gale jacket and family=your-family-code. GALE-JACKET-M has name=Gale jacket M and parentSku=GALE-JACKET. Each field is a separate Products row with SET.',
    'An existing standalone product must be promoted to parent before attaching children. An unreferenced new root is standalone.',
    'Blank parentSku action and value preserve its relationship. CLEAR explicitly unlinks; INHERIT also clears the relationship for compatibility with existing exports.',
    'Product role (Standalone, Parent, Child) is calculated. It is separate from completeness percentages and marketplace variation themes.',
    'All listing aliases share the catalog relationship. A product with alias records cannot be moved by attribute import until its listing relationships are resolved.',
    'Keep exported version values to detect edits since export. Apply always checks the preview again.',
    'Price and stock are managed in their dedicated workspaces; an attribute import does not publish.',
    'Missing category-required values are readiness work; they do not prevent saving an incomplete draft.',
  ]
  notes.forEach(note => instructions.addRow([note]))
  instructions.getColumn(1).width = 125
  for (const name of effective ? ['Effective values'] : ENTITIES) {
    const sheet = workbook.addWorksheet(name)
    sheet.columns = TRANSFER_COLUMNS.map(key => ({ header: key, key, width: key === 'value' ? 60 : ['accountId', 'field'].includes(key) ? 32 : 18 }))
    for (const row of rows.filter(row => effective || row.entity === name)) {
      const record = transferFileRow(row)
      // XML normalizes literal carriage returns. JSON escapes preserve them across Excel reads.
      if (record.format === 'text' && /[\u0000-\u0008\u000b-\u001f]/.test(record.value)) {
        record.format = 'json'
        record.value = JSON.stringify(row.value)
      }
      sheet.addRow(record)
    }
    sheet.views = [{ state: 'frozen', ySplit: 1, xSplit: 2 }]
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, sheet.rowCount), column: TRANSFER_COLUMNS.length } }
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF24324A' } }
    sheet.getColumn('sku').numFmt = '@'
    sheet.getColumn('value').numFmt = '@'
  }
  if (dictionary.length) {
    const sheet = workbook.addWorksheet('Dictionary')
    sheet.columns = Object.keys(dictionary[0]).map(key => ({ header: key, key, width: key === 'options' ? 75 : 28 }))
    dictionary.forEach(row => sheet.addRow(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v) ?? '']))))
    sheet.views = [{ state: 'frozen', ySplit: 1 }]
  }
  const file = Buffer.from(await workbook.xlsx.writeBuffer())
  if (file.length > TRANSFER_MAX_FILE_BYTES) throw new TransferWorkbookLimitError('bytes')
  return file
}

export function transferErrorsCsv(issues: TransferIssue[]): string {
  const escape = (value: unknown) => `"${String(value ?? '').replace(/^[=+\-@\t\r]/, "'$&").replace(/"/g, '""')}"`
  return [['row', 'sku', 'field', 'message', 'file', 'sheet', 'column'], ...issues.map(i => [i.row, i.sku, i.field, i.message, i.source?.file, i.source?.sheet, i.source?.column])].map(row => row.map(escape).join(',')).join('\r\n')
}

/**
 * AX-IE.3 — extract the SCHEMA from a real Amazon bulksheet.
 *
 * Usage:  npx tsx scripts/_axie3-extract-amazon-schema.mts ~/Downloads/<file>.xlsx
 *
 * READ ONLY, and it does not print your data. It reports sheet names, the exact
 * column headers in order, the distinct Entity/Operation/Product values Amazon
 * uses, and ONE redacted example row per entity so value SHAPES are visible
 * (ids become 9s, text becomes x's, numbers keep their magnitude).
 *
 * That is everything needed to finish the Sponsored Brands and Sponsored Display
 * sheets against Amazon's real layout instead of a guess.
 */
import { readFileSync } from 'node:fs'
import ExcelJS from 'exceljs'

const path = process.argv[2]
if (!path) {
  console.error('Usage: npx tsx scripts/_axie3-extract-amazon-schema.mts <path-to-bulksheet.xlsx>')
  process.exit(1)
}

const cell = (v: unknown): string => {
  if (v == null) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o.text === 'string') return o.text
    if (Array.isArray(o.richText)) return (o.richText as Array<{ text?: string }>).map((t) => t.text ?? '').join('')
    if (o.result != null) return String(o.result)
    return ''
  }
  return String(v)
}

/** Keep the shape, drop the content. */
const redact = (s: string): string => {
  if (!s) return ''
  if (/^-?\d+([.,]\d+)?$/.test(s)) return s                      // numbers are shape-safe
  if (/^\d{6,}$/.test(s)) return '9'.repeat(s.length)             // long ids
  if (/^B0[A-Z0-9]{8}$/i.test(s)) return 'B0XXXXXXXX'             // ASIN
  if (/^\d{4}-?\d{2}-?\d{2}$/.test(s)) return s                   // dates are shape-safe
  if (s.length <= 24) return s                                    // short enums/labels: keep, they ARE the schema
  return `${s.slice(0, 12)}…(${s.length} chars)`
}

const wb = new ExcelJS.Workbook()
await wb.xlsx.load(readFileSync(path) as unknown as ArrayBuffer)

console.log('='.repeat(78))
console.log('AMAZON BULKSHEET SCHEMA')
console.log('='.repeat(78))
console.log(`sheets: ${wb.worksheets.length}`)

for (const ws of wb.worksheets) {
  const headerRow = ws.getRow(1)
  const cols = Math.max(ws.actualColumnCount ?? 0, ws.columnCount ?? 0)
  const headers: string[] = []
  for (let c = 1; c <= cols; c++) headers.push(cell(headerRow.getCell(c).value))
  while (headers.length && headers[headers.length - 1] === '') headers.pop()

  console.log('\n' + '─'.repeat(78))
  console.log(`SHEET: "${ws.name}"   rows=${ws.rowCount}  cols=${headers.length}  state=${ws.state ?? 'visible'}`)
  console.log('─'.repeat(78))
  console.log('HEADERS (in order):')
  headers.forEach((h, i) => console.log(`  ${String(i + 1).padStart(3)}. ${h}`))

  const iEntity = headers.findIndex((h) => /^entity$/i.test(h))
  const iOp = headers.findIndex((h) => /^operation$/i.test(h))
  const iProduct = headers.findIndex((h) => /^product$/i.test(h))
  const seen = { entity: new Set<string>(), op: new Set<string>(), product: new Set<string>() }
  const example = new Map<string, string[]>()

  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return
    const vals = headers.map((_, i) => cell(row.getCell(i + 1).value))
    if (iEntity >= 0 && vals[iEntity]) seen.entity.add(vals[iEntity]!)
    if (iOp >= 0 && vals[iOp]) seen.op.add(vals[iOp]!)
    if (iProduct >= 0 && vals[iProduct]) seen.product.add(vals[iProduct]!)
    const key = iEntity >= 0 ? (vals[iEntity] || '(blank entity)') : 'row'
    if (!example.has(key)) example.set(key, vals)
  })

  if (seen.product.size) console.log(`\nPRODUCT values:   ${[...seen.product].join(' | ')}`)
  if (seen.entity.size) console.log(`ENTITY values:    ${[...seen.entity].join(' | ')}`)
  if (seen.op.size) console.log(`OPERATION values: ${[...seen.op].join(' | ')}`)

  if (example.size) {
    console.log('\nWHICH COLUMNS EACH ENTITY POPULATES (values redacted):')
    for (const [entity, vals] of example) {
      const filled = vals.map((v, i) => (v ? `${headers[i]}=${redact(v)}` : null)).filter(Boolean)
      console.log(`\n  ${entity}`)
      for (const f of filled) console.log(`      ${f}`)
    }
  }
}
console.log('\n' + '='.repeat(78))

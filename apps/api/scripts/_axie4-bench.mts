/**
 * AX-IE.4 — where does the time go, and does 100k rows actually work?
 *
 * The spec's gate is "100k-row file validates with a complete error list,
 * nothing written". This measures parse vs validate separately so the answer is
 * evidence, not a guess, and so any async-job decision is made on a number.
 */
import { writeFileSync, statSync } from 'node:fs'
import ExcelJS from 'exceljs'
import { COLUMNS, HEADERS, ROW_KEY_HEADER, BASELINE_HEADER } from '@nexus/shared/ads-bulksheet'
import { validateBulksheet } from '../src/services/advertising/bulksheet/import-validate.js'

const N = Number(process.argv[2] ?? 100_000)
const path = `/tmp/axie4-bench-${N}.xlsx`

console.log(`building a ${N.toLocaleString()}-row bulksheet…`)
const t0 = Date.now()
const wb = new ExcelJS.Workbook()
const ws = wb.addWorksheet('Sponsored Products Campaigns')
ws.addRow([...HEADERS, ROW_KEY_HEADER, BASELINE_HEADER])
const col = (h: string) => HEADERS.indexOf(h)
for (let i = 0; i < N; i++) {
  const row: Array<string | number | null> = new Array(HEADERS.length + 2).fill(null)
  row[col('Product')] = 'Sponsored Products'
  row[col('Entity')] = 'Keyword'
  // Every 10th row gets an Operation, and every 100th is deliberately bad, so the
  // error path is exercised at scale rather than only the happy path.
  row[col('Operation')] = i % 10 === 0 ? 'Update' : ''
  row[col('Keyword ID')] = String(100000000000000 + i)
  row[col('Ad group ID')] = String(200000000000 + (i % 500))
  row[col('Campaign ID')] = String(300000000000 + (i % 50))
  row[col('Keyword text')] = `keyword sample ${i}`
  row[col('Match type')] = i % 100 === 0 ? 'Exakt' : 'Broad'
  row[col('Bid')] = i % 100 === 0 ? ('abc' as unknown as number) : Number((0.2 + (i % 50) / 100).toFixed(2))
  row[col('State')] = 'enabled'
  row[HEADERS.length] = `keyword:${100000000000000 + i}:local${i}`
  row[HEADERS.length + 1] = 'deadbeef'
  ws.addRow(row)
}
writeFileSync(path, Buffer.from(await wb.xlsx.writeBuffer()))
const built = Date.now() - t0
const bytes = statSync(path).size
console.log(`  built in ${(built / 1000).toFixed(1)}s · ${(bytes / 1024 / 1024).toFixed(1)} MB on disk`)

const { readFileSync } = await import('node:fs')
const buf = readFileSync(path)

const t1 = Date.now()
const res = await validateBulksheet(buf)
const ms = Date.now() - t1

console.log('\nVALIDATE (parse + every row, no DB writes)')
console.log(`  elapsed        ${(ms / 1000).toFixed(2)}s   (${Math.round((res.counts.total / ms) * 1000).toLocaleString()} rows/sec)`)
console.log(`  rows           ${res.counts.total.toLocaleString()}`)
console.log(`  ready          ${res.counts.ready.toLocaleString()}`)
console.log(`  no-op          ${res.counts.noOp.toLocaleString()}`)
console.log(`  errors         ${res.counts.errors.toLocaleString()}`)
console.log(`  issues kept    ${res.issues.length.toLocaleString()}  truncated=${res.issuesTruncated}`)
console.log(`  peak RSS       ${(process.memoryUsage().rss / 1024 / 1024).toFixed(0)} MB`)
console.log(`  first issue    ${res.issues[0]?.cellAddress} — ${res.issues[0]?.message}`)
console.log(`  columns        unknown=${res.unknownColumns.length} missing=${res.missingColumns.length}`)
console.log(`  structural     ${res.structuralError ?? '(none)'}`)

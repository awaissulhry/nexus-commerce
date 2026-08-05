/** AX-IE.3 — schema extractor over the STREAMING reader. Read-only, values redacted. */
import { streamWorkbook } from '../src/services/advertising/bulksheet/spreadsheet-adapter.js'
const path = process.argv[2]!
const redact = (s: string): string => {
  if (!s) return ''
  if (/^-?\d+([.,]\d+)?$/.test(s)) return s
  if (/^\d{6,}$/.test(s)) return '9'.repeat(s.length)
  if (/^B0[A-Z0-9]{8}$/i.test(s)) return 'B0XXXXXXXX'
  if (/^\d{4}-?\d{2}-?\d{2}$/.test(s)) return s
  if (s.length <= 28) return s
  return `${s.slice(0, 14)}…(${s.length}ch)`
}
const perSheet = new Map<string, { headers: string[]; rows: number; entity: Set<string>; op: Set<string>; product: Set<string>; ex: Map<string, Record<string,string>> }>()
const t = Date.now()
const { sheets } = await streamWorkbook(path, async (row, headers) => {
  let s = perSheet.get(row.sheet)
  if (!s) { s = { headers, rows: 0, entity: new Set(), op: new Set(), product: new Set(), ex: new Map() }; perSheet.set(row.sheet, s) }
  s.rows++
  const e = row.cells['Entity'] ?? ''
  const o = row.cells['Operation'] ?? ''
  const p = row.cells['Product'] ?? ''
  if (e) s.entity.add(e); if (o) s.op.add(o); if (p) s.product.add(p)
  const key = e || '(no entity col)'
  if (!s.ex.has(key)) {
    const filled: Record<string,string> = {}
    for (const [k, v] of Object.entries(row.cells)) if (v) filled[k] = redact(v)
    s.ex.set(key, filled)
  }
})
console.log('='.repeat(76)); console.log('AMAZON BULKSHEET SCHEMA  (' + ((Date.now()-t)/1000).toFixed(1) + 's)'); console.log('='.repeat(76))
console.log('sheets seen:', sheets.map(s => `${s.name}(${s.rows})`).join(' | '))
for (const [name, s] of perSheet) {
  console.log('\n' + '─'.repeat(76)); console.log(`SHEET "${name}"  rows=${s.rows}  cols=${s.headers.length}`); console.log('─'.repeat(76))
  console.log('HEADERS:'); s.headers.forEach((h, i) => console.log(`  ${String(i+1).padStart(3)}. ${h}`))
  if (s.product.size) console.log(`\nPRODUCT:   ${[...s.product].join(' | ')}`)
  if (s.entity.size) console.log(`ENTITY:    ${[...s.entity].join(' | ')}`)
  if (s.op.size) console.log(`OPERATION: ${[...s.op].join(' | ')}`)
  console.log('\nCOLUMNS POPULATED PER ENTITY (redacted):')
  for (const [e, filled] of s.ex) {
    console.log(`\n  ${e}`)
    for (const [k, v] of Object.entries(filled)) console.log(`      ${k} = ${v}`)
  }
}

import { readFile } from 'node:fs/promises'
const { parseXlsx } = await import('../src/services/import/parsers.js')
const bytes = new Uint8Array(await readFile('/Users/awais/Downloads/GALE eBay IT - 5 listings XXS-5XL (import).xlsx'))
const parsed = await parseXlsx(bytes)
const rows = parsed.rows as Array<Record<string, unknown>>
console.log(`file rows: ${rows.length}`)
const byParentage = new Map<string, number>()
const skuSeen = new Map<string, number>()
const byItem = new Map<string, number>()
for (const r of rows) {
  const p = String(r['Parent/Child'] ?? r['parentage'] ?? '').toLowerCase() || '(blank)'
  byParentage.set(p, (byParentage.get(p) ?? 0) + 1)
  const sku = String(r['SKU'] ?? r['sku'] ?? '').trim()
  if (sku) skuSeen.set(sku, (skuSeen.get(sku) ?? 0) + 1)
  const item = String(r['Item ID'] ?? '').trim()
  if (item) byItem.set(item, (byItem.get(item) ?? 0) + 1)
}
console.log('parentage:', JSON.stringify([...byParentage]))
console.log(`distinct SKUs: ${skuSeen.size}; duplicated SKUs: ${[...skuSeen.values()].filter((n) => n > 1).length}`)
console.log('rows per Item ID:', JSON.stringify([...byItem]))
process.exit(0)

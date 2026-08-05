/** READ-ONLY: dump headers + variation-value columns from REGAL; DB-check all child SKUs. */
import ExcelJS from 'exceljs'
import { readFileSync } from 'fs'
const { default: prisma } = await import('../src/db.js')
const S = (v: unknown): string => {
  if (v == null) return ''
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if ('richText' in o) return (o.richText as Array<{ text: string }>).map((r) => r.text).join('')
    if ('text' in o) return String(o.text)
    if ('result' in o) return String(o.result ?? '')
  }
  return String(v)
}
const files: Record<string, string> = {
  REGAL: '/Users/awais/Desktop/2026/LISTNGS/JACKETS/REGAL/eBay/IT/REGAL IT.xlsx',
  WATERPROOF: '/Users/awais/Desktop/2026/LISTNGS/JACKETS/WATERPROOF/eBay/IT/WATERPROOF IT.xlsx',
  MISANO: '/Users/awais/Desktop/2026/LISTNGS/JACKETS/Misano/eBay/IT/MISANO IT.xlsx',
}
const allSkus = new Map<string, string>() // sku -> which file
for (const [name, file] of Object.entries(files)) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(readFileSync(file).buffer as ArrayBuffer)
  const ws = wb.worksheets[0]
  const headers: string[] = []
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => { headers[col] = S(cell.value).trim() })
  if (name === 'REGAL') {
    console.log('ALL HEADERS:', headers.filter(Boolean).map((h, i) => `${i}:${h}`).join(' | '))
    // find columns whose header contains relation/variation/colore/taglia
    const interesting = headers.map((h, i) => [h, i] as const).filter(([h]) => h && /colore|taglia|relationship|variation|aspect|misura/i.test(h))
    console.log('VALUE-CANDIDATE COLS:', interesting.map(([h, i]) => `${i}:${h}`).join(' | '))
    // dump first 4 child rows' values in those cols
    const iSku = headers.findIndex((h) => h?.toLowerCase() === 'sku')
    for (let r = 3; r <= 6; r++) {
      const sku = S(ws.getRow(r).getCell(iSku).value).trim()
      const vals = interesting.map(([h, i]) => `${h}="${S(ws.getRow(r).getCell(i).value).trim()}"`).join(' ')
      console.log(`row${r} ${sku}: ${vals}`)
    }
  }
  const iSku = headers.findIndex((h) => h?.toLowerCase() === 'sku')
  const iPC = headers.findIndex((h) => h?.toLowerCase() === 'parent/child')
  for (let r = 2; r <= ws.rowCount; r++) {
    const sku = S(ws.getRow(r).getCell(iSku).value).trim()
    const pc = S(ws.getRow(r).getCell(iPC).value).trim().toLowerCase()
    if (sku && pc !== 'parent') allSkus.set(sku, name)
  }
}
console.log(`\nDB check: ${allSkus.size} distinct child SKUs`)
const found = await prisma.product.findMany({
  where: { sku: { in: [...allSkus.keys()] } },
  select: { sku: true, deletedAt: true, parentId: true, parent: { select: { sku: true } } },
})
const bySku = new Map(found.map((p) => [p.sku, p]))
const missing: string[] = []
const byParent = new Map<string, number>()
for (const [sku, file] of allSkus) {
  const p = bySku.get(sku)
  if (!p || p.deletedAt) { missing.push(`${sku}(${file})`); continue }
  const key = `${file} under ${p.parent?.sku ?? '(root)'}`
  byParent.set(key, (byParent.get(key) ?? 0) + 1)
}
console.log('EXISTS grouped:', JSON.stringify([...byParent]))
console.log(`MISSING (${missing.length}):`, missing.join(', ') || '(none)')
await prisma.$disconnect()

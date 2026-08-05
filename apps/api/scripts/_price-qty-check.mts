/** READ-ONLY: price/qty sanity per file. */
import ExcelJS from 'exceljs'
import { readFileSync } from 'fs'
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
for (const [name, file] of [
  ['VENTRA', '/Users/awais/Desktop/2026/LISTNGS/JACKETS/VENTRA/eBay/IT/VENTRA IT.xlsx'],
  ['REGAL', '/Users/awais/Desktop/2026/LISTNGS/JACKETS/REGAL/eBay/IT/REGAL IT.xlsx'],
  ['WATERPROOF', '/Users/awais/Desktop/2026/LISTNGS/JACKETS/WATERPROOF/eBay/IT/WATERPROOF IT.xlsx'],
  ['MISANO', '/Users/awais/Desktop/2026/LISTNGS/JACKETS/Misano/eBay/IT/MISANO IT.xlsx'],
] as const) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(readFileSync(file).buffer as ArrayBuffer)
  const ws = wb.worksheets[0]
  const headers: string[] = []
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => { headers[col] = S(cell.value).trim() })
  const iSku = headers.findIndex((h) => h?.toLowerCase() === 'sku')
  const iPC = headers.findIndex((h) => h?.toLowerCase() === 'parent/child')
  const iPrice = headers.findIndex((h) => h?.toLowerCase().startsWith('price'))
  const iQty = headers.findIndex((h) => h?.toLowerCase() === 'qty')
  const iImg = headers.findIndex((h) => h === 'Image 1')
  let children = 0, priced = 0, qtyFilled = 0, qtySum = 0, imgFilled = 0
  const priceVals = new Set<string>()
  for (let r = 2; r <= ws.rowCount; r++) {
    const sku = S(ws.getRow(r).getCell(iSku).value).trim()
    if (!sku) continue
    const pc = S(ws.getRow(r).getCell(iPC).value).trim().toLowerCase()
    if (pc === 'parent') continue
    children++
    const price = S(ws.getRow(r).getCell(iPrice).value).trim()
    const qty = S(ws.getRow(r).getCell(iQty).value).trim()
    if (price) { priced++; priceVals.add(price) }
    if (qty) { qtyFilled++; qtySum += Number(qty) || 0 }
    if (iImg > 0 && S(ws.getRow(r).getCell(iImg).value).trim()) imgFilled++
  }
  console.log(`${name}: children=${children} priced=${priced} prices=[${[...priceVals].slice(0, 6).join(',')}] qtyFilled=${qtyFilled} qtySum=${qtySum} img1Filled=${imgFilled}`)
}

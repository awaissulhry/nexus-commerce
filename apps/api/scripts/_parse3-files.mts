import ExcelJS from 'exceljs'
import { readFileSync } from 'fs'

const files = [
  '/Users/awais/Desktop/2026/LISTNGS/JACKETS/REGAL/eBay/IT/REGAL IT.xlsx',
  '/Users/awais/Desktop/2026/LISTNGS/JACKETS/WATERPROOF/eBay/IT/WATERPROOF IT.xlsx',
  '/Users/awais/Desktop/2026/LISTNGS/JACKETS/Misano/eBay/IT/MISANO IT.xlsx',
]
const S = (v: unknown): string => {
  if (v == null) return ''
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if ('richText' in o) return (o.richText as Array<{ text: string }>).map((r) => r.text).join('')
    if ('text' in o) return String(o.text)
    if ('result' in o) return String(o.result ?? '')
    if ('hyperlink' in o) return String(o.text ?? o.hyperlink)
  }
  return String(v)
}
for (const file of files) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(readFileSync(file).buffer as ArrayBuffer)
  const ws = wb.worksheets[0]
  // merged-cell expansion
  const merges = (ws.model as unknown as { merges?: string[] }).merges ?? []
  const masterOf = new Map<string, string>()
  for (const m of merges) {
    const [a, b] = m.split(':')
    const col = (ref: string) => ref.replace(/\d+$/, '')
    const row = (ref: string) => Number(ref.replace(/^[A-Z]+/, ''))
    const colNum = (c: string) => c.split('').reduce((acc, ch) => acc * 26 + ch.charCodeAt(0) - 64, 0)
    const numCol = (n: number) => { let s = ''; while (n > 0) { s = String.fromCharCode(((n - 1) % 26) + 65) + s; n = Math.floor((n - 1) / 26) } return s }
    for (let r = row(a); r <= row(b); r++) for (let c = colNum(col(a)); c <= colNum(col(b)); c++) {
      const ref = `${numCol(c)}${r}`
      if (ref !== a) masterOf.set(ref, a)
    }
  }
  const cellAt = (r: number, c: number): string => {
    if (c < 1) return ''
    const cell = ws.getRow(r).getCell(c)
    const ref = `${cell.address}`
    const master = masterOf.get(ref)
    if (master && !S(cell.value).trim()) return S(ws.getCell(master).value)
    return S(cell.value)
  }
  const headers: string[] = []
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => { headers[col] = S(cell.value).trim() })
  const hIdx = (name: string) => headers.findIndex((h) => h?.toLowerCase() === name.toLowerCase())
  const iSku = hIdx('SKU'), iPC = hIdx('Parent/Child'), iPS = hIdx('Parent SKU'), iItem = hIdx('eBay Item ID') >= 0 ? hIdx('eBay Item ID') : hIdx('Item ID')
  const iTheme = hIdx('Variation Theme'), iShared = headers.findIndex((h) => h?.toLowerCase().startsWith('shared-sku')), iTitle = hIdx('Title'), iCat = hIdx('Category ID'), iAction = hIdx('Action')
  const axisCols: Array<[string, number]> = []
  headers.forEach((h, i) => { if (h && /^(colore|taglia|sesso|color|size|gender|stile|materiale)$/i.test(h.trim())) axisCols.push([h.trim(), i]) })
  const fams = new Map<string, { parentRow?: Record<string, string>; children: string[]; itemIds: Set<string>; shared: number; axisVals: Map<string, Set<string>> }>()
  let total = 0
  for (let r = 2; r <= ws.rowCount; r++) {
    const sku = cellAt(r, iSku).trim()
    if (!sku) continue
    total++
    const pc = cellAt(r, iPC).trim().toLowerCase()
    const ps = cellAt(r, iPS).trim() || sku
    const f = fams.get(ps) ?? { children: [], itemIds: new Set(), shared: 0, axisVals: new Map() }
    const itemId = iItem >= 0 ? cellAt(r, iItem).trim() : ''
    if (itemId) f.itemIds.add(itemId)
    if (/true|vero|si|sì|1/.test(cellAt(r, iShared).trim().toLowerCase())) f.shared++
    if (pc === 'parent') {
      f.parentRow = { title: cellAt(r, iTitle).slice(0, 60), theme: cellAt(r, iTheme), cat: cellAt(r, iCat), action: cellAt(r, iAction) }
    } else {
      f.children.push(sku)
      for (const [an, ai] of axisCols) {
        const v = cellAt(r, ai + 0).trim()
        if (v) { const set = f.axisVals.get(an) ?? new Set(); set.add(v); f.axisVals.set(an, set) }
      }
    }
    fams.set(ps, f)
  }
  console.log(`\n=== ${file.split('/').pop()} — headers(${headers.filter(Boolean).length}): ${headers.filter(Boolean).slice(0, 12).join(' | ')}`)
  console.log(`rows=${total} families=${fams.size}`)
  for (const [ps, f] of fams) {
    console.log(`family ${ps}: children=${f.children.length} shared=${f.shared} itemIds=[${[...f.itemIds].join(',')}] theme=${f.parentRow?.theme ?? '?'} cat=${f.parentRow?.cat ?? '?'} action=${f.parentRow?.action ?? ''} title="${f.parentRow?.title ?? ''}"`)
    console.log(`  axes: ${[...f.axisVals].map(([a, vs]) => `${a}:${vs.size}v[${[...vs].slice(0,4).join('/')}]`).join('  ') || '(none)'}`)
    console.log(`  ALL children: ${f.children.join(',')}`)
  }
}

import ExcelJS from 'exceljs'
import { readFileSync } from 'node:fs'
const file = process.argv[2]
const bytes = readFileSync(file)
const wb = new ExcelJS.Workbook()
await wb.xlsx.load(bytes as unknown as ArrayBuffer)
const ws = wb.worksheets[0]
const headers: string[] = []
ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { headers[i - 1] = String(c.value ?? '') })
console.log('headers:', JSON.stringify(headers.slice(0, 20)))
const col = (name: string) => headers.findIndex((h) => h.toLowerCase().includes(name)) + 1
const idx = (name: string) => headers.findIndex((h) => h.toLowerCase() === name.toLowerCase()) + 1
const cSku = idx('SKU')
const cPC = idx('Parent/Child')
const cParentSku = idx('Parent SKU')
const cShared = idx('Shared-SKU (Trading API)')
const cItem = headers.findIndex((h) => /item\s*id/i.test(h)) + 1
const fams = new Map<string, { rows: number; item: string; parentRow: boolean; sharedTrue: number }>()
ws.eachRow((r, i) => {
  if (i === 1) return
  const sku = String(r.getCell(cSku).value ?? '').trim()
  if (!sku) return
  const pc = String(r.getCell(cPC).value ?? '').trim().toLowerCase()
  const psku = String(r.getCell(cParentSku).value ?? '').trim()
  const item = cItem ? String(r.getCell(cItem).value ?? '').trim() : ''
  const shared = String(r.getCell(cShared).value ?? '').trim().toUpperCase()
  const fam = pc === 'parent' ? sku : psku || '(none)'
  const e = fams.get(fam) ?? { rows: 0, item: '', parentRow: false, sharedTrue: 0 }
  e.rows++
  if (pc === 'parent') { e.parentRow = true; if (/^\d{10,}$/.test(item)) e.item = item }
  if (/^\d{10,}$/.test(item) && !e.item) e.item = item
  if (shared === 'TRUE' || shared === 'VERO') e.sharedTrue++
  fams.set(fam, e)
})
for (const [fam, e] of fams) console.log(`family ${fam}: rows=${e.rows} parentRow=${e.parentRow} itemId=${e.item || '(none)'} sharedTrue=${e.sharedTrue}`)

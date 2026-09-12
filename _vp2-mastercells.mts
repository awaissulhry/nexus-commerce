import { getStudioSheet } from './apps/api/src/services/pim/studio-sheet.service.js'
const GALE='cmokmy3a40078pm0p1fvnu523'
const s = await getStudioSheet({ productId: GALE, scope:'master', market:'IT', includeMapping:false })
let filled=0, empty=0
const nonNull: string[] = []
for (const r of s.rows as any[]) {
  if (r.isParent) continue
  for (const k of ['color','size']) {
    const v = r.values?.[k]?.value
    if (v === null || v === undefined || v === '') empty++
    else { filled++; nonNull.push(`${r.sku}.${k}=${JSON.stringify(v)}`) }
  }
}
console.log(`master attr cells across 20 children x 2 axes: filled=${filled} empty=${empty}`)
console.log('non-null ones:', nonNull.length ? nonNull.join(' ') : '(none)')
process.exit(0)

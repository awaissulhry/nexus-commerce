import { getStudioSheet } from './apps/api/src/services/pim/studio-sheet.service.js'
import { canonicalVariantAxis } from './apps/api/src/services/pim/variant-attribute-keys.js'
const GALE='cmokmy3a40078pm0p1fvnu523'
const s = await getStudioSheet({ productId: GALE, scope: 'master', market: 'IT', includeMapping: false })
const flagged = s.columns.filter((c:any)=>c.axis)
console.log('columns:', s.columns.length, '| flagged axis:true =', flagged.map((c:any)=>c.key))
console.log('family.variationAxes =', JSON.stringify(s.family.variationAxes))
console.log('\nIs the flag a FALSE match? Test the canonical identity on both sides:')
for (const axis of s.family.variationAxes) {
  for (const col of flagged) {
    const a = canonicalVariantAxis(axis), b = canonicalVariantAxis(col.key)
    if (a === b) console.log(`  axis "${axis}" -> "${a}"   column "${col.key}" -> "${b}"   MATCH (same physical dimension)`)
  }
}
console.log('\nDo those columns offer a WRITE?')
for (const c of flagged as any[]) console.log(' ', c.key, JSON.stringify({ editable: c.editable, writeField: c.writeField, writeTarget: c.writeTarget, storage: c.storage, scope: c.scope }))
process.exit(0)

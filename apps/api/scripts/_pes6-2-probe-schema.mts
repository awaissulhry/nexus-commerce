// PES.6 — read-only probe: what requirement/grouping signals does a CACHED Amazon
// product-type definition actually carry? Priority must be derived from what Amazon
// says, not from what we assume (reference_ask_amazon_allowed_columns).
import prisma from '../src/db.js'

const rows = await prisma.categorySchema.findMany({
  where: { channel: 'AMAZON', isActive: true },
  select: { productType: true, marketplace: true, fetchedAt: true, schemaVersion: true },
  orderBy: { fetchedAt: 'desc' }, take: 20,
})
console.log('cached schemas:', rows.length)
for (const r of rows) console.log(' ', r.marketplace, r.productType, r.schemaVersion, r.fetchedAt.toISOString().slice(0,10))

const one = await prisma.categorySchema.findFirst({
  where: { channel: 'AMAZON', isActive: true },
  orderBy: { fetchedAt: 'desc' },
})
if (!one) { console.log('NO CACHED SCHEMA'); process.exit(0) }
const def: any = one.schemaDefinition
console.log('\n=== root keys of', one.productType, one.marketplace, '===')
console.log(Object.keys(def).join(', '))
console.log('root.required count:', Array.isArray(def.required) ? def.required.length : 'none')
console.log('root.required sample:', (def.required ?? []).slice(0, 12).join(', '))
for (const k of ['anyOf','allOf','oneOf','dependentRequired','dependencies','if','$defs']) {
  if (def[k]) console.log(`root.${k}:`, JSON.stringify(def[k]).slice(0, 300))
}
const props = def.properties ?? {}
console.log('\nproperties:', Object.keys(props).length)
console.log('__-prefixed:', Object.keys(props).filter((k) => k.startsWith('__')).join(', '))
if (props.__propertyGroups) {
  const g: any = props.__propertyGroups
  console.log('\n=== __propertyGroups shape ===')
  console.log(JSON.stringify(g).slice(0, 900))
}
// Per-property signals we might read for priority.
const names = Object.keys(props).filter((k) => !k.startsWith('__'))
const sample = names.slice(0, 3)
for (const n of sample) {
  console.log(`\n--- property "${n}" top-level keys:`, Object.keys(props[n]).join(', '))
  const p: any = props[n]
  for (const k of ['title','description','examples','minItems','maxItems','required','$lifecycle','editable','selectors']) {
    if (p[k] !== undefined) console.log(`   ${k}:`, JSON.stringify(p[k]).slice(0, 200))
  }
}
// How many properties carry minItems>=1 (Amazon's "must supply at least one") vs root.required
let minItems1 = 0, hasLifecycle = 0
for (const n of names) {
  const p: any = props[n]
  if (typeof p.minItems === 'number' && p.minItems >= 1) minItems1++
  if (p.$lifecycle || p.items?.properties?.value?.$lifecycle) hasLifecycle++
}
console.log('\nproperties with minItems>=1:', minItems1, '/', names.length)
console.log('properties with $lifecycle:', hasLifecycle)
await prisma.$disconnect()

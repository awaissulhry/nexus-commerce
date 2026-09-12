// PES.6 — read-only: the ACTUAL grouping + conditional-requirement signals.
import prisma from '../src/db.js'
const one = await prisma.categorySchema.findFirst({
  where: { channel: 'AMAZON', marketplace: 'IT', isActive: true },
  orderBy: { fetchedAt: 'desc' },
})
if (!one) { console.log('none'); process.exit(0) }
const def: any = one.schemaDefinition
console.log('=== ', one.productType, one.marketplace, one.fetchedAt.toISOString().slice(0,10), '===')

console.log('\n--- __requirementsEnforced ---')
console.log(JSON.stringify(def.__requirementsEnforced).slice(0, 400))

console.log('\n--- __propertyGroups (root) ---')
const pg = def.__propertyGroups
console.log('type:', Array.isArray(pg) ? 'array' : typeof pg)
if (pg && typeof pg === 'object') {
  const keys = Object.keys(pg)
  console.log('group count:', keys.length)
  console.log('group keys:', keys.slice(0, 25).join(', '))
  const first = pg[keys[0]]
  console.log('first group shape:', JSON.stringify(first).slice(0, 500))
}

console.log('\n--- allOf conditionals: how many, and which fields do they require? ---')
const allOf: any[] = Array.isArray(def.allOf) ? def.allOf : []
console.log('allOf blocks:', allOf.length)
const conditionallyRequired = new Set<string>()
for (const block of allOf) {
  const collect = (node: any) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node.required)) for (const r of node.required) conditionallyRequired.add(String(r))
    if (node.properties) for (const k of Object.keys(node.properties)) { /* the gated field */ }
    for (const v of Object.values(node)) if (v && typeof v === 'object') collect(v)
  }
  if (block.then) collect(block.then)
}
console.log('fields named in a `then` branch:', conditionallyRequired.size)
console.log(' sample:', [...conditionallyRequired].slice(0, 20).join(', '))

// Which top-level properties are gated by a `then` that adds them to `required`?
const gated = new Set<string>()
for (const block of allOf) {
  const t = block?.then
  if (!t) continue
  if (Array.isArray(t.required)) for (const r of t.required) gated.add(String(r))
  if (t.properties) for (const [k, v] of Object.entries<any>(t.properties)) {
    if (v?.required || v?.items?.required) gated.add(k)
  }
}
console.log('\ntop-level props gated by a conditional:', gated.size)
console.log(' sample:', [...gated].slice(0, 25).join(', '))

const props = Object.keys(def.properties ?? {})
const hard = new Set<string>(def.required ?? [])
console.log('\ntotals — properties:', props.length, '| hard required:', hard.size, '| gated:', [...gated].filter(g=>props.includes(g)).length)
await prisma.$disconnect()

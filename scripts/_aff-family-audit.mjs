// READ-ONLY audit of Amazon flat-file family structure.
// Dumps every parent and its children, variation themes, productTypes,
// ASINs, and per-child variantAttributes. Flags structural problems so we
// can decide what (if anything) to fix. Writes NOTHING to the DB.
// Usage: node scripts/_aff-family-audit.mjs
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()

const sel = {
  id: true, sku: true, name: true, status: true,
  isParent: true, isMaster: true, isMasterProduct: true,
  parentId: true, amazonAsin: true, parentAsin: true,
  productType: true, variationTheme: true, variationAxes: true,
  variantAttributes: true, categoryAttributes: true,
  syncChannels: true,
}

const all = await prisma.product.findMany({ select: sel, orderBy: { sku: 'asc' } })
const byId = new Map(all.map((p) => [p.id, p]))
const childrenOf = new Map()
for (const p of all) {
  if (p.parentId) {
    if (!childrenOf.has(p.parentId)) childrenOf.set(p.parentId, [])
    childrenOf.get(p.parentId).push(p)
  }
}

const isParentish = (p) => p.isParent || p.isMaster || (childrenOf.get(p.id)?.length ?? 0) > 0
const parents = all.filter(isParentish)
const orphans = all.filter((p) => p.parentId && !byId.has(p.parentId))
const childlessParents = parents.filter((p) => (childrenOf.get(p.id)?.length ?? 0) === 0)

console.log(`\n=== TOTALS ===`)
console.log(`products=${all.length}  parents(ish)=${parents.length}  withChildren=${parents.length - childlessParents.length}  orphanChildren=${orphans.length}`)

console.log(`\n=== PARENTS + CHILDREN ===`)
for (const p of parents.sort((a, b) => (a.sku > b.sku ? 1 : -1))) {
  const kids = (childrenOf.get(p.id) ?? []).sort((a, b) => (a.sku > b.sku ? 1 : -1))
  const kidTypes = [...new Set(kids.map((k) => k.productType ?? '∅'))]
  const mixed = kidTypes.length > 1
  console.log(`\n● ${p.sku}  "${p.name}"  [${p.status}]`)
  console.log(`    flags: isParent=${p.isParent} isMaster=${p.isMaster} isMasterProduct=${p.isMasterProduct}`)
  console.log(`    productType=${p.productType ?? '∅'}  variationTheme=${p.variationTheme ?? '∅'}  axes=[${(p.variationAxes ?? []).join(',')}]`)
  console.log(`    amazonAsin=${p.amazonAsin ?? '∅'}  parentAsin=${p.parentAsin ?? '∅'}  channels=[${(p.syncChannels ?? []).join(',')}]`)
  console.log(`    children=${kids.length}  childTypes=[${kidTypes.join(', ')}]${mixed ? '  ⚠️ MIXED-TYPE FAMILY' : ''}`)
  for (const k of kids) {
    const va = k.variantAttributes ? JSON.stringify(k.variantAttributes) : '∅'
    console.log(`      └ ${k.sku}  type=${k.productType ?? '∅'}  variantAttrs=${va}  asin=${k.amazonAsin ?? '∅'}  [${k.status}]`)
  }
}

console.log(`\n=== ⚠️ FLAGS ===`)
if (orphans.length) {
  console.log(`\nOrphan children (parentId points at missing product):`)
  for (const o of orphans) console.log(`  ${o.sku}  parentId=${o.parentId}`)
}
if (childlessParents.length) {
  console.log(`\nParent-flagged but NO children:`)
  for (const c of childlessParents) console.log(`  ${c.sku}  isParent=${c.isParent} isMaster=${c.isMaster}`)
}
const parentsNoTheme = parents.filter((p) => (childrenOf.get(p.id)?.length ?? 0) > 0 && !p.variationTheme && (p.variationAxes ?? []).length === 0)
if (parentsNoTheme.length) {
  console.log(`\nParents WITH children but NO variationTheme/axes:`)
  for (const p of parentsNoTheme) console.log(`  ${p.sku}`)
}
const kidsNoAttrs = all.filter((p) => p.parentId && byId.has(p.parentId) && (!p.variantAttributes || Object.keys(p.variantAttributes).length === 0))
if (kidsNoAttrs.length) {
  console.log(`\nChildren missing variantAttributes (can't form a variation matrix):`)
  for (const k of kidsNoAttrs) console.log(`  ${k.sku}  parent=${byId.get(k.parentId)?.sku}`)
}

// Aireon focus
console.log(`\n=== AIREON FOCUS ===`)
const aireon = all.filter((p) => /aireon/i.test(p.sku) || /aireon/i.test(p.name ?? ''))
if (!aireon.length) console.log('  (no SKU/name matching /aireon/i found)')
for (const a of aireon.sort((x, y) => (x.sku > y.sku ? 1 : -1))) {
  const role = isParentish(a) ? 'PARENT' : (a.parentId ? `child→${byId.get(a.parentId)?.sku ?? a.parentId}` : 'STANDALONE')
  console.log(`  ${a.sku}  [${role}]  type=${a.productType ?? '∅'}  theme=${a.variationTheme ?? '∅'}  va=${a.variantAttributes ? JSON.stringify(a.variantAttributes) : '∅'}`)
}

await prisma.$disconnect()

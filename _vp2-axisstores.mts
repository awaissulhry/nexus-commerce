import { PrismaClient } from '@prisma/client'
const p = new PrismaClient({ datasources: { db: { url: process.argv[2] } } })
const GALE = 'cmokmy3a40078pm0p1fvnu523'
const kids = await p.product.findMany({ where: { parentId: GALE, deletedAt: null }, select: { sku: true, variantAttributes: true, categoryAttributes: true }, orderBy: { sku: 'asc' } })
let va = 0, cv = 0
for (const k of kids) {
  const v = (k.variantAttributes ?? {}) as Record<string, unknown>
  const c = ((k.categoryAttributes ?? {}) as any).variations ?? {}
  const vHas = Object.keys(v).length > 0, cHas = Object.keys(c).length > 0
  if (vHas) va++; if (cHas) cv++
  console.log(k.sku.padEnd(30), 'variantAttributes=', JSON.stringify(v).slice(0,60).padEnd(62), 'variations=', JSON.stringify(c))
}
console.log(`\nchildren=${kids.length}  with variantAttributes=${va}  with categoryAttributes.variations=${cv}`)
await p.$disconnect()

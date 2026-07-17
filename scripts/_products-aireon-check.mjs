// READ-ONLY: current AIREON state + any duplicate/other AIREON products, as the
// /products page would see them.
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()

const aireonish = await prisma.product.findMany({
  where: { OR: [{ sku: { contains: 'AIREON', mode: 'insensitive' } }, { name: { contains: 'AIREON', mode: 'insensitive' } }] },
  select: { id:true, sku:true, name:true, status:true, deletedAt:true, isParent:true, isMaster:true, parentId:true, productType:true, amazonAsin:true },
  orderBy: { sku: 'asc' },
})
const parents = aireonish.filter(p => !p.parentId)
const kids = aireonish.filter(p => p.parentId)
console.log(`AIREON-matching products: ${aireonish.length}  (top-level/parents=${parents.length}, children=${kids.length})`)
console.log(`\n=== TOP-LEVEL (what shows as a product on /products) ===`)
for (const p of parents) {
  const del = p.deletedAt ? `🗑DELETED` : 'LIVE'
  console.log(`  ${p.sku}  [${p.status}] ${del}  isParent=${p.isParent} isMaster=${p.isMaster}  type=${p.productType} asin=${p.amazonAsin??'∅'}`)
}
// children grouped by productType (the "categories" the user may be seeing)
const byType = {}
for (const k of kids.filter(k => !k.deletedAt)) { const t = k.productType ?? '∅'; (byType[t] ??= []).push(k.sku) }
console.log(`\n=== AIREON children by productType (mixed-type family) ===`)
for (const [t, skus] of Object.entries(byType)) console.log(`  ${t}: ${skus.length} children`)

// Does the /products list dedupe/roll-up by parent, or show children too? Check the default products query shape.
console.log(`\n=== how many LIVE top-level products total (for scale) ===`)
const topLevel = await prisma.product.count({ where: { deletedAt: null, parentId: null } })
const allLive = await prisma.product.count({ where: { deletedAt: null } })
console.log(`  top-level (parentId=null): ${topLevel}   all live: ${allLive}`)
await prisma.$disconnect()

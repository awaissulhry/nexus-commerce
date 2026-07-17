import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url)); dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()
const total = await prisma.productReadCache.count()
const prodTotal = await prisma.product.count()
console.log(`cache rows: ${total}   products: ${prodTotal}   match: ${total === prodTotal ? '✓' : '✗'}`)
// AIREON in cache
const aireon = await prisma.productReadCache.findMany({
  where: { OR: [{ sku: { contains: 'AIREON', mode: 'insensitive' } }, { name: { contains: 'AIREON', mode: 'insensitive' } }] },
  select: { sku:true, parentId:true, isParent:true, productType:true, deletedAt:true },
})
const topAireon = aireon.filter(r => !r.parentId && !r.deletedAt)
console.log(`\nAIREON top-level LIVE in cache: ${topAireon.length}`)
for (const r of topAireon) console.log(`  ${r.sku}  isParent=${r.isParent} type=${r.productType}`)
console.log(`AIREON children in cache: ${aireon.filter(r=>r.parentId).length}`)
// phantom check: any GIACCA/PANTALONI/old parents left?
const phantom = aireon.filter(r => /GIACCA|PANTALONI/i.test(r.sku))
console.log(phantom.length ? `⚠️ phantom still present: ${phantom.map(r=>r.sku).join(', ')}` : '✓ no GIACCA/PANTALONI phantoms')
// top-level live products in cache (should be ~14 families, GALE-FBM excluded/soft-deleted)
const topLive = await prisma.productReadCache.findMany({ where: { parentId: null, deletedAt: null }, select: { sku:true }, orderBy: { sku:'asc' } })
console.log(`\nTop-level LIVE products in cache: ${topLive.length}`)
console.log('  ' + topLive.map(r=>r.sku).join('\n  '))
await prisma.$disconnect()

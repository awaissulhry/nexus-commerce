import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url)); dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()
const prodIds = new Set((await prisma.product.findMany({ select: { id: true } })).map(p => p.id))
const cacheRows = await prisma.productReadCache.findMany({ select: { id: true, sku: true, parentId: true } })
const orphans = cacheRows.filter(c => !prodIds.has(c.id))
console.log(`cache rows: ${cacheRows.length}  live products: ${prodIds.size}  ORPHANED cache rows: ${orphans.length}`)
const topOrphans = orphans.filter(o => !o.parentId)
console.log(`orphaned TOP-LEVEL cache rows (show as phantom products): ${topOrphans.length}`)
for (const o of topOrphans.slice(0, 20)) console.log(`  ${o.sku}`)

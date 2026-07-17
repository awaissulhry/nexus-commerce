import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url)); dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()
try {
  const rows = await prisma.productReadCache.findMany({
    where: { OR: [{ sku: { contains: 'AIREON', mode: 'insensitive' } }, { name: { contains: 'AIREON', mode: 'insensitive' } }] },
    select: { id:true, sku:true, name:true, parentId:true, isParent:true, productType:true, deletedAt:true, updatedAt:true },
    orderBy: { sku: 'asc' },
  })
  console.log(`ProductReadCache AIREON rows: ${rows.length}`)
  const topLevel = rows.filter(r => !r.parentId)
  console.log(`top-level in cache: ${topLevel.length}`)
  for (const r of topLevel) console.log(`  ${r.sku}  parentId=${r.parentId??'∅'} isParent=${r.isParent} type=${r.productType} deleted=${r.deletedAt?'Y':'N'} updated=${r.updatedAt?.toISOString?.().slice(0,10)}`)
  const gp = rows.filter(r => /GIACCA|PANTALONI/i.test(r.sku))
  if (gp.length) console.log(`⚠️ STALE: cache still has ${gp.map(r=>r.sku).join(', ')}`)
} catch (e) { console.log('productReadCache query failed:', e.message.split('\n')[0]) }
await prisma.$disconnect()

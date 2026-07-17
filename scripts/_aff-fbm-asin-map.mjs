import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()
const fba = await prisma.product.findUnique({ where: { sku: 'GALE-JACKET' }, select: { id: true } })
const fbm = await prisma.product.findUnique({ where: { sku: 'GALE-JACKET-FBM' }, select: { id: true } })
const fbaKids = await prisma.product.findMany({ where: { parentId: fba.id }, select: { sku: true, amazonAsin: true } })
const fbmKids = await prisma.product.findMany({ where: { parentId: fbm.id }, select: { sku: true, amazonAsin: true } })
const fbaByAsin = new Map(fbaKids.filter(k=>k.amazonAsin).map(k => [k.amazonAsin, k.sku]))
console.log(`FBA children=${fbaKids.length} (with ASIN ${fbaKids.filter(k=>k.amazonAsin).length}), FBM children=${fbmKids.length}`)
let matched=0, unmatched=[]
for (const k of fbmKids) { if (k.amazonAsin && fbaByAsin.has(k.amazonAsin)) matched++; else unmatched.push(k.sku) }
console.log(`FBM→FBA matched-by-ASIN: ${matched}/${fbmKids.length}`)
if (unmatched.length) console.log('UNMATCHED:', unmatched.join(', '))
await prisma.$disconnect()

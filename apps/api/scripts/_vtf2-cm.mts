import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'; import { parse } from 'dotenv'
const url = parse(readFileSync(new URL('../.env', import.meta.url).pathname, 'utf8')).DATABASE_URL!
if (!/nexus_development/.test(url)) throw new Error('REFUSED')
const prisma = new PrismaClient({ datasources: { db: { url } } })
const rows = await prisma.channelListing.groupBy({ by: ['channel', 'marketplace', 'channelMarket', 'region'], _count: { id: true } })
console.log('channelMarket/region values:', JSON.stringify(rows.map(r => [r.channel, r.marketplace, r.channelMarket, r.region, r._count.id])))
const mine = await prisma.product.findMany({ where: { sku: { startsWith: 'VTF2-TEST' } }, select: { id: true, sku: true, parentId: true } })
console.log('VTF2 products already present:', JSON.stringify(mine))
await prisma.$disconnect()

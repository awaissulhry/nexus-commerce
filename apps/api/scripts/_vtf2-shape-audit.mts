import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'; import { parse } from 'dotenv'
const url = parse(readFileSync(new URL('../.env', import.meta.url).pathname, 'utf8')).DATABASE_URL!
if (!/nexus_development/.test(url)) throw new Error('REFUSED')
const prisma = new PrismaClient({ datasources: { db: { url } } })
const rows = await prisma.$queryRawUnsafe<any[]>(`
  SELECT cl.id, p.sku, cl.channel, cl.marketplace, cl.version, cl."variationMapping"::text AS m, cl."variationTheme" AS t
  FROM "ChannelListing" cl JOIN "Product" p ON p.id = cl."productId"
  WHERE cl."variationMapping" IS NOT NULL ORDER BY p.sku`)
console.log('rows with a non-null variationMapping:', rows.length)
for (const r of rows) console.log('  ', JSON.stringify(r))
const total = await prisma.channelListing.count()
console.log('total ChannelListing rows:', total)
await prisma.$disconnect()

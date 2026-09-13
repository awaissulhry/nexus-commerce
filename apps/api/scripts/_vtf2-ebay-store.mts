import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'; import { parse } from 'dotenv'
const url = parse(readFileSync(new URL('../.env', import.meta.url).pathname, 'utf8')).DATABASE_URL!
if (!/nexus_development/.test(url)) throw new Error('REFUSED')
const prisma = new PrismaClient({ datasources: { db: { url } } })
const rows = await prisma.channelListing.findMany({ where: { product: { sku: 'VTF2-TEST-3AX' } }, select: { channel: true, marketplace: true, version: true, variationTheme: true, variationMapping: true, platformAttributes: true } })
for (const r of rows) console.log(`${r.channel}·${r.marketplace} v${r.version} theme=${JSON.stringify(r.variationTheme)} mapping=${JSON.stringify(r.variationMapping)} pa=${JSON.stringify(r.platformAttributes)}`)
const p = await prisma.product.findFirst({ where: { sku: 'VTF2-TEST-3AX' }, select: { version: true, variationTheme: true, variationAxes: true } })
console.log('PARENT PRODUCT', JSON.stringify(p))
await prisma.$disconnect()

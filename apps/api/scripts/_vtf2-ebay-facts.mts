import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'
import { parse } from 'dotenv'
const url = parse(readFileSync(new URL('../.env', import.meta.url).pathname, 'utf8')).DATABASE_URL!
if (!/nexus_development/.test(url)) throw new Error('REFUSED: not local')
const prisma = new PrismaClient({ datasources: { db: { url } } })
const rows = await prisma.categorySchema.findMany({ where: { channel: 'EBAY' }, select: { marketplace: true, productType: true, fetchedAt: true, schemaVersion: true }, orderBy: [{ marketplace: 'asc' }, { fetchedAt: 'desc' }] })
console.log('EBAY CategorySchema rows:', rows.length)
for (const r of rows.slice(0, 25)) console.log('  ', JSON.stringify(r))
const gale = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET' } })
const g = gale as unknown as Record<string, unknown>
console.log('GALE product columns:', JSON.stringify(Object.keys(g)))
console.log('GALE category-ish:', JSON.stringify(Object.fromEntries(Object.entries(g).filter(([k]) => /categor|ebay|type|brand|workspace|business|status/i.test(k)))))
// where does a family's eBay category live? look for a mapping table
const tables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(`SELECT table_name::text FROM information_schema.tables WHERE table_schema='public' AND (table_name ILIKE '%categor%' OR table_name ILIKE '%aspect%') ORDER BY 1`)
console.log('category-ish tables:', JSON.stringify(tables.map(t => t.table_name)))
// XAVIA family, for the fixture's parent
const xavia = await prisma.product.findMany({ where: { sku: { contains: 'XAVIA' } }, select: { id: true, sku: true, parentId: true, isParent: true, productType: true, status: true, variationAxes: true, workspaceId: true } , take: 10 })
console.log('XAVIA:', JSON.stringify(xavia))
await prisma.$disconnect()

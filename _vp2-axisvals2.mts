import { PrismaClient } from '@prisma/client'
const p = new PrismaClient({ datasources: { db: { url: process.argv[2] } } })
const GALE = 'cmokmy3a40078pm0p1fvnu523'
const kids = await p.product.findMany({ where: { parentId: GALE, deletedAt: null }, select: { id: true, sku: true, categoryAttributes: true }, orderBy: { sku: 'asc' }, take: 3 })
for (const k of kids) console.log(k.sku, JSON.stringify(k.categoryAttributes))
const tables: any[] = await p.$queryRawUnsafe(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND (table_name ILIKE '%locale%' OR table_name ILIKE '%content%' OR table_name ILIKE '%attribute%') ORDER BY 1`)
console.log('tables:', tables.map(r => r.table_name).join(', '))
await p.$disconnect()

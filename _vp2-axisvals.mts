import { PrismaClient } from '@prisma/client'
const url = process.argv[2]
const p = new PrismaClient({ datasources: { db: { url } } })
const GALE = 'cmokmy3a40078pm0p1fvnu523'
const kids = await p.product.findMany({ where: { parentId: GALE, deletedAt: null }, select: { id: true, sku: true, categoryAttributes: true }, orderBy: { sku: 'asc' }, take: 3 })
for (const k of kids) {
  const ca = (k.categoryAttributes ?? {}) as Record<string, unknown>
  console.log(k.sku, '| categoryAttributes keys:', Object.keys(ca).length)
  console.log('   axis-ish:', JSON.stringify(Object.fromEntries(Object.entries(ca).filter(([kk]) => /col|tag|size|siz/i.test(kk)))))
}
// localized content?
const lc: any[] = await p.$queryRawUnsafe(`SELECT table_name FROM information_schema.tables WHERE table_name ILIKE '%localiz%' OR table_name ILIKE '%LocalizedContent%'`)
console.log('localized tables:', lc.map(r => r.table_name))
await p.$disconnect()

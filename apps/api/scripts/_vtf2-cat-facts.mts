import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'
import { parse } from 'dotenv'
const url = parse(readFileSync(new URL('../.env', import.meta.url).pathname, 'utf8')).DATABASE_URL!
if (!/nexus_development/.test(url)) throw new Error('REFUSED: not local')
const prisma = new PrismaClient({ datasources: { db: { url } } })
const gale = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET' }, select: { id: true } })
const pc = await prisma.$queryRawUnsafe<any[]>(`SELECT * FROM "ProductCategory" WHERE "productId" = $1`, gale!.id)
console.log('GALE ProductCategory:', JSON.stringify(pc))
const cats = await prisma.$queryRawUnsafe<any[]>(`SELECT id, name, "parentId" FROM "Category" ORDER BY name LIMIT 40`)
console.log('Categories:', JSON.stringify(cats))
if (pc[0]) {
  const ccm = await prisma.$queryRawUnsafe<any[]>(`SELECT * FROM "CategoryChannelMapping" WHERE "categoryId" = $1`, pc[0].categoryId)
  console.log('CategoryChannelMapping for GALE category:', JSON.stringify(ccm))
}
const fam = await prisma.$queryRawUnsafe<any[]>(`SELECT id, name FROM "ProductFamily" LIMIT 20`).catch(() => [])
console.log('ProductFamily:', JSON.stringify(fam))
await prisma.$disconnect()

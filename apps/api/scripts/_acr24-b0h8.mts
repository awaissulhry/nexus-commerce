import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const r = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT p."amazonAsin", p.sku, p.name, p."deletedAt" IS NOT NULL AS deleted
  FROM "Product" p WHERE p."amazonAsin" IN ('B0H8QTNY62','B0H8R7YPXJ','B0H8QHD858')`)
console.log(JSON.stringify(r, null, 1))
await prisma.$disconnect()
process.exit(0)

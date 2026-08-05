import prisma from '../src/db.js'
const r = await prisma.$queryRawUnsafe<any[]>(`
  SELECT "childAsin", "msku", COUNT(*)::int AS days,
         ROUND(SUM("costOfGoodsSold")::numeric,2) AS cogs,
         ROUND(SUM("netProductSales")::numeric,2) AS sales
  FROM "AmazonEconomicsDaily" WHERE "costOfGoodsSold" IS NOT NULL
  GROUP BY 1,2 ORDER BY 3 DESC`)
console.table(r)
await prisma.$disconnect()

/** H10 Brand Metrics — can we render each card? READ-ONLY. */
import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient({ log: [] })
const j = (x: unknown) => JSON.stringify(x, (_k, v) => typeof v === 'bigint' ? Number(v) : v)

console.log('nodeTreeName / lookback / brandedSearchesOnly coverage:')
console.log(j(await prisma.$queryRawUnsafe(`
  SELECT COUNT(*)::int rows,
         COUNT("categoryNodeTreeName")::int with_tree,
         COUNT(DISTINCT "lookbackPeriod")::int lookbacks,
         MIN("lookbackPeriod") lookback,
         COUNT("brandedSearchesOnly")::int bs_only,
         COUNT("newToBrandCustomerRate")::int ntb_rate,
         COUNT("brandCustomers")::int brand_cust,
         COUNT("highValueCustomers")::int hv
  FROM "AmazonAdsBrandBuildingMetric"`)))

console.log('\nIT category nodes (the breadcrumb + Category filter):')
console.log(j(await prisma.$queryRawUnsafe(`
  SELECT "categoryNodeName", "categoryNodeTreeName", COUNT(*)::int weeks
  FROM "AmazonAdsBrandBuildingMetric" WHERE "marketplace"='IT'
  GROUP BY 1,2 ORDER BY 3 DESC`)))

console.log('\nthe funnel over time on the IT root node (Brand Customers YTD equivalent):')
console.log(j(await prisma.$queryRawUnsafe(`
  SELECT "computationDate"::text wk, "awarenessIndex", "considerationIndex", "salesIndex",
         "brandCustomers", "newToBrandCustomerRate", "customerConversionRate", "addToCarts"
  FROM "AmazonAdsBrandBuildingMetric"
  WHERE "marketplace"='IT' AND "categoryNodeName"='/Categorie/Moto, accessori e componenti'
  ORDER BY 1`)))
await prisma.$disconnect()

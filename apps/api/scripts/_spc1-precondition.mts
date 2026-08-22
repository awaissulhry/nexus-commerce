/** SPC.1 — prove the three legacy window columns hold NO information. READ-ONLY. */
import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient({ log: [] })
const j = (x: unknown) => JSON.stringify(x, (_k,v)=> typeof v==='bigint'?Number(v):v)
console.log('every distinct value held by the three columns we would null:')
console.log(j(await prisma.$queryRawUnsafe(`
  SELECT 'sales1dCents' col, "sales1dCents"::text v, COUNT(*)::int n FROM "AmazonAdsDailyPerformance" GROUP BY 2
  UNION ALL
  SELECT 'sales14dCents', "sales14dCents"::text, COUNT(*)::int FROM "AmazonAdsDailyPerformance" GROUP BY 2
  UNION ALL
  SELECT 'sales30dCents', "sales30dCents"::text, COUNT(*)::int FROM "AmazonAdsDailyPerformance" GROUP BY 2
  ORDER BY 1,2`)))
console.log('\nsanity — the columns we are NOT touching do carry real values:')
console.log(j(await prisma.$queryRawUnsafe(`
  SELECT COUNT(DISTINCT "sales7dCents")::int distinct_sales7d,
         MAX("sales7dCents")::int max_sales7d,
         COUNT(*)::int total_rows
  FROM "AmazonAdsDailyPerformance"`)))
await prisma.$disconnect()

import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient({ log: [] })
const j = (x: unknown) => JSON.stringify(x, (_k,v)=> typeof v==='bigint'?Number(v):v)
console.log('campaign rows either side of the 2026-05-17 retention wall:')
console.log(j(await prisma.$queryRawUnsafe(`
  SELECT CASE WHEN "date" < DATE '2026-05-17' THEN 'unreachable (before 05-17)' ELSE 'backfillable' END AS bucket,
         COUNT(*)::int rows, MIN("date")::text first, MAX("date")::text last,
         COUNT(DISTINCT "date")::int days
  FROM "AmazonAdsDailyPerformance" WHERE "entityType"='CAMPAIGN' GROUP BY 1 ORDER BY 1`)))
console.log('\nall entity types (the backfill will cover targeting + product ads later too):')
console.log(j(await prisma.$queryRawUnsafe(`
  SELECT "entityType", COUNT(*) FILTER (WHERE "date" < DATE '2026-05-17')::int unreachable,
         COUNT(*) FILTER (WHERE "date" >= DATE '2026-05-17')::int backfillable
  FROM "AmazonAdsDailyPerformance" GROUP BY 1 ORDER BY 3 DESC`)))
await prisma.$disconnect()

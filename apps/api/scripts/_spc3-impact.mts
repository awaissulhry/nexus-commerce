/** What the 'ams' duplicate rows do to the campaign report operators read. READ-ONLY. */
import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient({ log: [] })
const j=(x:unknown)=>JSON.stringify(x,(_k,v)=>typeof v==='bigint'?Number(v):v)
const W = `"date" BETWEEN DATE '2026-05-21' AND DATE '2026-07-27' AND "entityType"='CAMPAIGN'
           AND (CASE "marketplace" WHEN 'APJ6JRA9NG5V4' THEN 'IT' ELSE UPPER("marketplace") END)='IT'`

console.log('IT campaign report totals, 2026-05-21 → 2026-07-27 — as the report computes them now:')
console.log(j(await p.$queryRawUnsafe(`
  SELECT SUM("impressions")::bigint impressions, SUM("clicks")::bigint clicks,
         (SUM("costMicros")::numeric/1000000)::numeric(12,2)::text spend,
         (SUM(COALESCE("sales7dCents",0))::numeric/100)::numeric(12,2)::text sales
  FROM "AmazonAdsDailyPerformance" WHERE ${W}`)))

console.log('\nthe same window with the duplicate "ams" rows excluded:')
console.log(j(await p.$queryRawUnsafe(`
  SELECT SUM("impressions")::bigint impressions, SUM("clicks")::bigint clicks,
         (SUM("costMicros")::numeric/1000000)::numeric(12,2)::text spend,
         (SUM(COALESCE("sales7dCents",0))::numeric/100)::numeric(12,2)::text sales
  FROM "AmazonAdsDailyPerformance" WHERE ${W} AND "profileId" <> 'ams'`)))

console.log('\nwhat the "ams" rows contribute on their own (note the negatives):')
console.log(j(await p.$queryRawUnsafe(`
  SELECT COUNT(*)::int rows, SUM("impressions")::bigint impressions, SUM("clicks")::bigint clicks,
         MIN("impressions")::int min_imp,
         COUNT(*) FILTER (WHERE "impressions" < 0)::int negative_rows,
         (SUM("costMicros")::numeric/1000000)::numeric(12,2)::text spend
  FROM "AmazonAdsDailyPerformance" WHERE ${W} AND "profileId"='ams'`)))
await p.$disconnect()

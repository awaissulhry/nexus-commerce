import prisma from '../src/db.js'
const q = (s: string) => prisma.$queryRawUnsafe<any[]>(s)
console.log('\n=== IT AMS hourly: is it real delivery or empty records? ===')
console.table(await q(`
  SELECT "date"::text AS day, COUNT(*)::int AS rows,
         SUM("impressions")::int AS impr, SUM("clicks")::int AS clicks,
         ROUND((SUM("costMicros")/1e6)::numeric,2) AS spend,
         COUNT(DISTINCT "entityId")::int AS entities
  FROM "AmazonAdsHourlyPerformance"
  WHERE "marketplace"='IT' AND "date" > CURRENT_DATE - 14
  GROUP BY 1 ORDER BY 1 DESC`))

console.log('\n=== same for DE (the control) ===')
console.table(await q(`
  SELECT "date"::text AS day, COUNT(*)::int AS rows,
         SUM("impressions")::int AS impr, SUM("clicks")::int AS clicks,
         ROUND((SUM("costMicros")/1e6)::numeric,2) AS spend
  FROM "AmazonAdsHourlyPerformance"
  WHERE "marketplace"='DE' AND "date" > CURRENT_DATE - 14
  GROUP BY 1 ORDER BY 1 DESC LIMIT 8`))

console.log('\n=== IT campaign states + bids ===')
console.table(await q(`
  SELECT "status", COUNT(*)::int AS n,
         ROUND(AVG(COALESCE("dailyBudget",0))::numeric,2) AS avg_budget
  FROM "Campaign" WHERE "marketplace"='IT' GROUP BY 1 ORDER BY 2 DESC`))
await prisma.$disconnect()

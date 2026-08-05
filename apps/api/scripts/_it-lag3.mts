import prisma from '../src/db.js'
const q = (s: string) => prisma.$queryRawUnsafe<any[]>(s)

console.log('\n=== A. AMS hourly (SQS push — independent of the v3 report path) ===')
console.table(await q(`
  SELECT "marketplace", MAX("date")::text AS last_day, COUNT(*)::int AS rows,
         MAX("createdAt")::text AS last_write
  FROM "AmazonAdsHourlyPerformance" GROUP BY 1 ORDER BY 2 DESC`))

console.log('\n=== B. IT hourly activity by day, last 14d ===')
console.table(await q(`
  SELECT "date"::text AS day, COUNT(*)::int AS rows,
         ROUND(SUM(COALESCE("cost",0))::numeric,2) AS spend,
         SUM(COALESCE("impressions",0))::int AS impr, SUM(COALESCE("clicks",0))::int AS clicks
  FROM "AmazonAdsHourlyPerformance"
  WHERE "marketplace"='IT' AND "date" > CURRENT_DATE - 14
  GROUP BY 1 ORDER BY 1 DESC`))

console.log('\n=== C. IT campaign states — did they simply stop? ===')
console.table(await q(`
  SELECT "marketplace", "status", COUNT(*)::int AS n
  FROM "Campaign" WHERE "marketplace" IS NOT NULL GROUP BY 1,2 ORDER BY 1,3 DESC`))

console.log('\n=== D. IT daily-perf spend by day (is it zero-row or zero-spend?) ===')
console.table(await q(`
  SELECT "date"::text AS day, "entityType", COUNT(*)::int AS rows,
         ROUND(SUM(COALESCE("cost",0))::numeric,2) AS spend
  FROM "AmazonAdsDailyPerformance"
  WHERE "marketplace"='IT' AND "date" > CURRENT_DATE - 14
  GROUP BY 1,2 ORDER BY 1 DESC, 2`))
await prisma.$disconnect()

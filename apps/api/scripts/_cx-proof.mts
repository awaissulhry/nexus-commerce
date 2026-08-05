import prisma from '../src/db.js'
// Same predicate as detectContradictions, but with the 2-day lag exclusion
// relaxed to CURRENT_DATE - 1 so Aug 3 is in range. Proves the check fires.
const r = await prisma.$queryRawUnsafe<any[]>(`
  WITH ams AS (
    SELECT "marketplace","date", SUM("costMicros")/1e6 AS spend, SUM("impressions")::bigint AS impr
    FROM "AmazonAdsHourlyPerformance" WHERE "date" BETWEEN CURRENT_DATE - 16 AND CURRENT_DATE
    GROUP BY 1,2),
  rep AS (
    SELECT "marketplace","date", COUNT(*)::bigint AS rows
    FROM "AmazonAdsDailyPerformance" WHERE "date" BETWEEN CURRENT_DATE - 16 AND CURRENT_DATE
      AND "entityType" IN ('CAMPAIGN','PRODUCT_AD') GROUP BY 1,2)
  SELECT a."marketplace", a."date"::text AS day, ROUND(a.spend::numeric,2) AS spend,
         a.impr, COALESCE(r.rows,0)::int AS report_rows
  FROM ams a LEFT JOIN rep r ON r."marketplace"=a."marketplace" AND r."date"=a."date"
  WHERE a.spend >= 0.5 AND COALESCE(r.rows,0) = 0
  ORDER BY a."date" DESC`)
console.error('WOULD-FIRE=' + r.length)
for (const x of r) console.error(`CX| ${x.marketplace} ${x.day}: spend €${x.spend}, ${x.impr} impressions, report rows ${x.report_rows}`)
process.exit(0)

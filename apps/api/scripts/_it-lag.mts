/**
 * Why is IT systematically staler than DE/FR/ES? READ-ONLY.
 *
 * Report jobs carry a profileId, not a marketplace, so everything joins through
 * AmazonAdsProfile.
 */
import prisma from '../src/db.js'

const q = (sql: string) => prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(sql)
const J = `LEFT JOIN "AmazonAdsProfile" pr ON pr."profileId" = j."profileId"`
const M = `COALESCE(pr."countryCode", pr."marketplace", j."profileId")`

console.log('\n=== 1. Newest data day per market, per feed ===')
console.table(await q(`
  SELECT 'daily-perf' AS feed, "marketplace", MAX("date")::text AS last_day,
         COUNT(*)::int AS rows, MAX("createdAt")::text AS last_write
  FROM "AmazonAdsDailyPerformance" GROUP BY 1,2
  UNION ALL
  SELECT 'search-terms', "marketplace", MAX("date")::text, COUNT(*)::int, MAX("createdAt")::text
  FROM "AmazonAdsSearchTerm" GROUP BY 1,2
  ORDER BY 1, 3 DESC`))

console.log('\n=== 2. Report jobs by market + status (last 14d) ===')
console.table(await q(`
  SELECT ${M} AS market, j."status", j."reportTypeId", COUNT(*)::int AS n,
         MAX(j."createdAt")::text AS newest,
         SUM(COALESCE(j."rowsIngested",0))::int AS rows_ingested
  FROM "AmazonAdsReportJob" j ${J}
  WHERE j."createdAt" > NOW() - INTERVAL '14 days'
  GROUP BY 1,2,3 ORDER BY 1,3,2`))

console.log('\n=== 3. Requested WINDOW per market (last 14d of jobs) ===')
console.table(await q(`
  SELECT ${M} AS market,
         MIN(j."startDate")::text AS earliest_requested,
         MAX(j."endDate")::text   AS latest_requested,
         COUNT(*)::int AS jobs
  FROM "AmazonAdsReportJob" j ${J}
  WHERE j."createdAt" > NOW() - INTERVAL '14 days'
  GROUP BY 1 ORDER BY 1`))

console.log('\n=== 4. Most recent 15 jobs for the IT profile ===')
console.table(await q(`
  SELECT j."reportTypeId", j."status",
         j."startDate"::text AS start_d, j."endDate"::text AS end_d,
         j."rowsIngested", LEFT(COALESCE(j."errorMessage",''), 60) AS err,
         j."createdAt"::text AS created
  FROM "AmazonAdsReportJob" j ${J}
  WHERE ${M} = 'IT'
  ORDER BY j."createdAt" DESC LIMIT 15`))

console.log('\n=== 5. Per-day row counts, last 18 days ===')
console.table(await q(`
  SELECT "date"::text AS day,
         COUNT(*) FILTER (WHERE "marketplace" = 'IT')::int AS it,
         COUNT(*) FILTER (WHERE "marketplace" = 'DE')::int AS de,
         COUNT(*) FILTER (WHERE "marketplace" = 'FR')::int AS fr,
         COUNT(*) FILTER (WHERE "marketplace" = 'ES')::int AS es
  FROM "AmazonAdsDailyPerformance"
  WHERE "date" > CURRENT_DATE - 18
  GROUP BY 1 ORDER BY 1 DESC`))

console.log('\n=== 6. Profiles registered ===')
console.table(await q(`
  SELECT "profileId", "marketplace", "countryCode", "accountName",
         "lastSyncedAt"::text AS last_synced
  FROM "AmazonAdsProfile" ORDER BY "countryCode"`))

await prisma.$disconnect()

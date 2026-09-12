/** READ-ONLY. ads-detail-metrics applies EXCLUDE_AMS_DAILY to the HOURLY table. If hourly rows
 *  carry that marker — or a NULL reportRunId — the intraday overlay silently returns nothing. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const r = await prisma.$queryRawUnsafe<Record<string,unknown>[]>(`
  SELECT CASE WHEN "reportRunId" IS NULL THEN 'NULL'
              WHEN "reportRunId" = 'ams-stream' THEN 'ams-stream'
              ELSE 'other' END AS kind,
    COUNT(*)::int AS rows, MIN(date)::text AS first, MAX(date)::text AS last
  FROM "AmazonAdsHourlyPerformance" GROUP BY 1 ORDER BY 2 DESC`)
console.log('AmazonAdsHourlyPerformance rows by reportRunId:')
for (const x of r) console.log(`  ${String(x.kind).padEnd(12)} ${String(x.rows).padStart(6)} rows  ${x.first} → ${x.last}`)
// What the detail page's overlay actually sees today, with and without its filter.
const t = await prisma.$queryRawUnsafe<Record<string,unknown>[]>(`
  SELECT ROUND((SUM("costMicros")/1e6)::numeric,2)::text AS all_today,
         ROUND((SUM("costMicros") FILTER (WHERE "reportRunId" IS DISTINCT FROM 'ams-stream')/1e6)::numeric,2)::text AS is_distinct_from,
         ROUND((SUM("costMicros") FILTER (WHERE "reportRunId" <> 'ams-stream')/1e6)::numeric,2)::text AS prisma_not_form
  FROM "AmazonAdsHourlyPerformance" WHERE "entityType"='CAMPAIGN' AND date = CURRENT_DATE`)
console.log('\ntoday, CAMPAIGN grain:')
console.log(`  no filter                €${t[0]?.all_today}`)
console.log(`  IS DISTINCT FROM         €${t[0]?.is_distinct_from}`)
console.log(`  Prisma { not: ... } form €${t[0]?.prisma_not_form}   ← what the overlay uses`)
await prisma.$disconnect()

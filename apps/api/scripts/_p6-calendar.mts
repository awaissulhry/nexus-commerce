/** READ-ONLY. THE decisive question: is AmazonAdsHourlyPerformance."hour" really UTC,
 *  or is it the profile's local clock (Europe/Paris, UTC+2 now) mislabelled as UTC?
 *  Test: per campaign-day, compare the Amazon DAILY report total against
 *    (a) the UTC-day hourly sum   h0..h23 of day D
 *    (b) the PARIS-day hourly sum h22,h23 of D-1 + h0..h21 of D
 *  The daily report is authoritative and is in the profile's local calendar. */
const { default: prisma } = await import('../src/db.js')
const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  WITH d AS (
    SELECT "localEntityId" AS cid, "date"::date AS day, SUM("costMicros")/1e6 AS daily
    FROM "AmazonAdsDailyPerformance"
    WHERE "entityType"='CAMPAIGN' AND "localEntityId" IS NOT NULL AND "reportRunId" <> 'ams-stream'
      AND "date" BETWEEN CURRENT_DATE - 8 AND CURRENT_DATE - 2
    GROUP BY 1,2 HAVING SUM("costMicros") > 0
  ),
  utc AS (
    SELECT "localEntityId" AS cid, "date"::date AS day, SUM("costMicros")/1e6 AS s
    FROM "AmazonAdsHourlyPerformance" WHERE "entityType"='CAMPAIGN' AND "localEntityId" IS NOT NULL
      AND "date" BETWEEN CURRENT_DATE - 9 AND CURRENT_DATE - 1 GROUP BY 1,2
  ),
  paris AS (
    SELECT "localEntityId" AS cid,
           ((("date" + ("hour" || ' hours')::interval) AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Paris')::date AS day,
           SUM("costMicros")/1e6 AS s
    FROM "AmazonAdsHourlyPerformance" WHERE "entityType"='CAMPAIGN' AND "localEntityId" IS NOT NULL
      AND "date" BETWEEN CURRENT_DATE - 9 AND CURRENT_DATE - 1 GROUP BY 1,2
  )
  SELECT COUNT(*)::bigint AS campaign_days,
         ROUND(SUM(d.daily)::numeric,2)                                   AS report_eur,
         ROUND(SUM(COALESCE(utc.s,0))::numeric,2)                         AS utc_day_eur,
         ROUND(SUM(COALESCE(paris.s,0))::numeric,2)                       AS paris_day_eur,
         ROUND(SUM(ABS(d.daily - COALESCE(utc.s,0)))::numeric,2)          AS utc_abs_error,
         ROUND(SUM(ABS(d.daily - COALESCE(paris.s,0)))::numeric,2)        AS paris_abs_error,
         COUNT(*) FILTER (WHERE ABS(d.daily - COALESCE(utc.s,0))   < 0.005)::bigint AS utc_exact,
         COUNT(*) FILTER (WHERE ABS(d.daily - COALESCE(paris.s,0)) < 0.005)::bigint AS paris_exact
  FROM d LEFT JOIN utc ON utc.cid=d.cid AND utc.day=d.day
         LEFT JOIN paris ON paris.cid=d.cid AND paris.day=d.day`)
for (const r of rows) console.log('   ' + Object.entries(r).map(([k, v]) => `${k}=${typeof v === 'bigint' ? Number(v) : String(v)}`).join('\n   '))

console.log('\n   --- worst 12 campaign-days under each hypothesis ---')
const detail = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  WITH d AS (
    SELECT "localEntityId" AS cid, "date"::date AS day, SUM("costMicros")/1e6 AS daily
    FROM "AmazonAdsDailyPerformance"
    WHERE "entityType"='CAMPAIGN' AND "localEntityId" IS NOT NULL AND "reportRunId" <> 'ams-stream'
      AND "date" BETWEEN CURRENT_DATE - 8 AND CURRENT_DATE - 2 GROUP BY 1,2 HAVING SUM("costMicros") > 0),
  utc AS (SELECT "localEntityId" AS cid, "date"::date AS day, SUM("costMicros")/1e6 AS s
          FROM "AmazonAdsHourlyPerformance" WHERE "entityType"='CAMPAIGN' AND "localEntityId" IS NOT NULL GROUP BY 1,2),
  paris AS (SELECT "localEntityId" AS cid, ((("date" + ("hour" || ' hours')::interval) AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Paris')::date AS day,
                   SUM("costMicros")/1e6 AS s
            FROM "AmazonAdsHourlyPerformance" WHERE "entityType"='CAMPAIGN' AND "localEntityId" IS NOT NULL GROUP BY 1,2)
  SELECT LEFT(c.name,26) AS name, d.day::text AS day, ROUND(d.daily::numeric,2) AS report,
         ROUND(COALESCE(utc.s,0)::numeric,2) AS utc_sum, ROUND(COALESCE(paris.s,0)::numeric,2) AS paris_sum
  FROM d JOIN "Campaign" c ON c.id=d.cid
    LEFT JOIN utc ON utc.cid=d.cid AND utc.day=d.day LEFT JOIN paris ON paris.cid=d.cid AND paris.day=d.day
  ORDER BY ABS(d.daily - COALESCE(utc.s,0)) DESC LIMIT 12`)
for (const r of detail) console.log('   ' + Object.entries(r).map(([k, v]) => `${k}=${String(v)}`).join('  '))
await prisma.$disconnect()

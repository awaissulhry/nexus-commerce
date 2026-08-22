/** READ-ONLY. P6 freshness + local-day probe.
 *  Q1 is SQS live?  Q2 what is the REAL hourly lag distribution (not one sample)?
 *  Q3 local-day (Rome) spend-so-far vs UTC-day, per campaign, with the real denominator.
 *  Q4 coverage against the Ad Manager's own 220-row scope. */
const { default: prisma } = await import('../src/db.js')
const q = <T,>(sql: string) => prisma.$queryRawUnsafe<T[]>(sql)
const j = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === 'bigint' ? Number(v) : String(v))
const table = (rows: Array<Record<string, unknown>>) => rows.forEach(r => console.log('   ' + Object.entries(r).map(([k, v]) => `${k}=${j(v)}`).join('  ')))

console.log('=== Q1 · SQS: has it EVER received, and when last? ===')
table(await q(`SELECT MAX("startedAt") AS last_any_record FROM "CronRun" WHERE "jobName"='ams-sqs-poll' AND "outputSummary" ~ 'received=[1-9]'`))
table(await q(`SELECT COUNT(*)::bigint AS runs_24h, COUNT(*) FILTER (WHERE "outputSummary" ~ 'received=[1-9]')::bigint AS with_records_24h
               FROM "CronRun" WHERE "jobName"='ams-sqs-poll' AND "startedAt" > now() - interval '24 hours'`))

console.log('\n=== Q1b · which pipe writes the hourly rows? (reportRunId, last 24h) ===')
table(await q(`SELECT "reportRunId", COUNT(*)::bigint AS rows, MIN("createdAt") AS first_created, MAX("createdAt") AS last_created
               FROM "AmazonAdsHourlyPerformance" WHERE "createdAt" > now() - interval '24 hours' GROUP BY 1 ORDER BY 2 DESC`))

console.log('\n=== Q2 · lag: hour-close (UTC) -> first row created, last 36 buckets ===')
table(await q(`SELECT ("date" + ("hour" || ' hours')::interval)::text AS bucket_start_utc,
                      COUNT(*)::bigint AS rows,
                      MIN("createdAt") AS first_created,
                      ROUND(EXTRACT(EPOCH FROM (MIN("createdAt") - (("date" + (("hour"+1) || ' hours')::interval) AT TIME ZONE 'UTC')))/60)::int AS min_after_close
               FROM "AmazonAdsHourlyPerformance" WHERE "entityType"='CAMPAIGN' AND "date" >= CURRENT_DATE - 2
               GROUP BY 1,"date","hour" ORDER BY "date" DESC,"hour" DESC LIMIT 36`))

console.log('\n=== Q2b · lag distribution over 7 days (minutes after hour close) ===')
table(await q(`WITH b AS (
                 SELECT MIN("createdAt") AS created, (("date" + (("hour"+1) || ' hours')::interval) AT TIME ZONE 'UTC') AS closed
                 FROM "AmazonAdsHourlyPerformance" WHERE "entityType"='CAMPAIGN' AND "date" >= CURRENT_DATE - 7
                 GROUP BY "date","hour")
               SELECT COUNT(*)::bigint AS buckets,
                      ROUND(MIN(EXTRACT(EPOCH FROM (created-closed))/60))::int AS min_lag_min,
                      ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (created-closed))/60))::int AS p50_min,
                      ROUND(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (created-closed))/60))::int AS p90_min,
                      ROUND(MAX(EXTRACT(EPOCH FROM (created-closed))/60))::int AS max_lag_min
               FROM b`))

console.log('\n=== Q3 · the local-day window right now ===')
table(await q(`SELECT now() AS now_utc,
                      (now() AT TIME ZONE 'Europe/Rome')::text AS now_rome,
                      (date_trunc('day', now() AT TIME ZONE 'Europe/Rome') AT TIME ZONE 'Europe/Rome') AS rome_day_start_utc,
                      date_trunc('day', now() AT TIME ZONE 'UTC')::text AS utc_day_start`))

console.log('\n=== Q3b · spend so far: ROME local day vs UTC day (all campaigns pooled) ===')
table(await q(`WITH h AS (SELECT "localEntityId" AS cid, "costMicros",
                             (("date" + ("hour" || ' hours')::interval) AT TIME ZONE 'UTC') AS ts
                          FROM "AmazonAdsHourlyPerformance" WHERE "entityType"='CAMPAIGN' AND "date" >= CURRENT_DATE - 2 AND "localEntityId" IS NOT NULL)
               SELECT 'rome_day' AS window, COUNT(DISTINCT cid)::bigint AS campaigns, ROUND((SUM("costMicros")/1e6)::numeric,2) AS spend_eur, COUNT(*)::bigint AS hour_rows
                 FROM h WHERE ts >= (date_trunc('day', now() AT TIME ZONE 'Europe/Rome') AT TIME ZONE 'Europe/Rome')
               UNION ALL
               SELECT 'utc_day', COUNT(DISTINCT cid), ROUND((SUM("costMicros")/1e6)::numeric,2), COUNT(*)
                 FROM h WHERE ts >= date_trunc('day', now())`))

console.log('\n=== Q4 · Ad Manager scope (limit 200 default) vs hourly coverage ===')
table(await q(`SELECT COUNT(*)::bigint AS campaigns_total,
                      COUNT(*) FILTER (WHERE status='ENABLED')::bigint AS enabled,
                      COUNT(*) FILTER (WHERE "dailyBudget" IS NULL)::bigint AS no_daily_budget,
                      COUNT(*) FILTER (WHERE "dailyBudget" IS NOT NULL AND "dailyBudget" <= 0)::bigint AS zero_budget
               FROM "Campaign"`))
table(await q(`WITH cov AS (SELECT DISTINCT "localEntityId" AS cid FROM "AmazonAdsHourlyPerformance"
                            WHERE "entityType"='CAMPAIGN' AND "date" >= CURRENT_DATE - 7 AND "localEntityId" IS NOT NULL)
               SELECT c.status, COUNT(*)::bigint AS campaigns,
                      COUNT(*) FILTER (WHERE cov.cid IS NOT NULL)::bigint AS with_hourly_7d
               FROM "Campaign" c LEFT JOIN cov ON cov.cid=c.id GROUP BY 1 ORDER BY 2 DESC`))
table(await q(`WITH cov AS (SELECT DISTINCT "localEntityId" AS cid FROM "AmazonAdsHourlyPerformance"
                            WHERE "entityType"='CAMPAIGN' AND ("date" >= CURRENT_DATE - 1) AND "localEntityId" IS NOT NULL)
               SELECT COUNT(*) FILTER (WHERE cov.cid IS NOT NULL)::bigint AS campaigns_with_hourly_since_yesterday,
                      COUNT(*) FILTER (WHERE cov.cid IS NOT NULL AND c.status='ENABLED')::bigint AS enabled_with_hourly
               FROM "Campaign" c LEFT JOIN cov ON cov.cid=c.id`))

console.log('\n=== Q5 · utilization TODAY (Rome day) for the covered campaigns ===')
table(await q(`WITH h AS (SELECT "localEntityId" AS cid, SUM("costMicros")/1e6 AS spend
                          FROM "AmazonAdsHourlyPerformance"
                          WHERE "entityType"='CAMPAIGN' AND "date" >= CURRENT_DATE - 2 AND "localEntityId" IS NOT NULL
                            AND (("date" + ("hour" || ' hours')::interval) AT TIME ZONE 'UTC') >= (date_trunc('day', now() AT TIME ZONE 'Europe/Rome') AT TIME ZONE 'Europe/Rome')
                          GROUP BY 1)
               SELECT COUNT(*)::bigint AS campaigns_with_spend_today,
                      COUNT(*) FILTER (WHERE c."dailyBudget" IS NOT NULL AND c."dailyBudget" > 0)::bigint AS with_denominator,
                      ROUND(MIN(h.spend / NULLIF(c."dailyBudget",0))::numeric,4) AS min_util,
                      ROUND(AVG(h.spend / NULLIF(c."dailyBudget",0))::numeric,4) AS avg_util,
                      ROUND(MAX(h.spend / NULLIF(c."dailyBudget",0))::numeric,4) AS max_util
               FROM h JOIN "Campaign" c ON c.id=h.cid`))
console.log('\n   --- sample rows ---')
table(await q(`WITH h AS (SELECT "localEntityId" AS cid, SUM("costMicros")/1e6 AS spend, MAX("hour")::int AS last_hour, MAX("createdAt") AS last_created
                          FROM "AmazonAdsHourlyPerformance"
                          WHERE "entityType"='CAMPAIGN' AND "date" >= CURRENT_DATE - 2 AND "localEntityId" IS NOT NULL
                            AND (("date" + ("hour" || ' hours')::interval) AT TIME ZONE 'UTC') >= (date_trunc('day', now() AT TIME ZONE 'Europe/Rome') AT TIME ZONE 'Europe/Rome')
                          GROUP BY 1)
               SELECT LEFT(c.name,34) AS name, c.marketplace, c.status, ROUND(h.spend::numeric,2) AS spend_today,
                      c."dailyBudget"::text AS daily_budget,
                      ROUND((100*h.spend/NULLIF(c."dailyBudget",0))::numeric,1) AS util_pct, h.last_hour, h.last_created
               FROM h JOIN "Campaign" c ON c.id=h.cid ORDER BY h.spend DESC LIMIT 12`))
await prisma.$disconnect()

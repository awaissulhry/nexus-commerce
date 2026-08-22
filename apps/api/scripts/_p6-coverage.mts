/** READ-ONLY. P6 · does ABSENCE of an hourly row mean zero spend, or no coverage?
 *  That single question decides whether the empty cell says "0%" or "not measured". */
const { default: prisma } = await import('../src/db.js')
const q = <T,>(sql: string) => prisma.$queryRawUnsafe<T[]>(sql)
const j = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === 'bigint' ? Number(v) : String(v))
const table = (rows: Array<Record<string, unknown>>) => rows.forEach(r => console.log('   ' + Object.entries(r).map(([k, v]) => `${k}=${j(v)}`).join('  ')))

console.log('=== A · SQS runs that received records, last 24h ===')
const hits = await prisma.cronRun.findMany({ where: { jobName: 'ams-sqs-poll', startedAt: { gt: new Date(Date.now() - 24 * 3600e3) } }, orderBy: { startedAt: 'desc' }, take: 1500, select: { startedAt: true, outputSummary: true } })
const withRec = hits.filter(r => /received=[1-9]/.test(r.outputSummary ?? ''))
console.log(`   ${withRec.length} of ${hits.length} runs`)
for (const h of withRec) console.log(`   ${h.startedAt.toISOString()}  ${h.outputSummary}`)

console.log('\n=== B · the decisive test: DAILY report says it spent, HOURLY has no row ===')
table(await q(`
  WITH d AS (SELECT "localEntityId" AS cid, SUM("costMicros")/1e6 AS spend, COUNT(DISTINCT "date")::int AS days
             FROM "AmazonAdsDailyPerformance" WHERE "entityType"='CAMPAIGN' AND "date" >= CURRENT_DATE - 7 AND "localEntityId" IS NOT NULL
               AND "reportRunId" <> 'ams-stream' GROUP BY 1),
       h AS (SELECT DISTINCT "localEntityId" AS cid FROM "AmazonAdsHourlyPerformance"
             WHERE "entityType"='CAMPAIGN' AND "date" >= CURRENT_DATE - 7 AND "localEntityId" IS NOT NULL)
  SELECT COUNT(*) FILTER (WHERE d.spend > 0)::bigint AS campaigns_spending_7d,
         COUNT(*) FILTER (WHERE d.spend > 0 AND h.cid IS NULL)::bigint AS spending_but_NO_hourly,
         ROUND(SUM(d.spend) FILTER (WHERE d.spend > 0 AND h.cid IS NULL)::numeric,2) AS eur_invisible_to_hourly,
         ROUND(SUM(d.spend) FILTER (WHERE d.spend > 0)::numeric,2) AS eur_total_7d
  FROM d LEFT JOIN h ON h.cid = d.cid`))
console.log('   --- the campaigns that spend but have no hourly row (top 10) ---')
table(await q(`
  WITH d AS (SELECT "localEntityId" AS cid, SUM("costMicros")/1e6 AS spend
             FROM "AmazonAdsDailyPerformance" WHERE "entityType"='CAMPAIGN' AND "date" >= CURRENT_DATE - 7 AND "localEntityId" IS NOT NULL
               AND "reportRunId" <> 'ams-stream' GROUP BY 1),
       h AS (SELECT DISTINCT "localEntityId" AS cid FROM "AmazonAdsHourlyPerformance"
             WHERE "entityType"='CAMPAIGN' AND "date" >= CURRENT_DATE - 7 AND "localEntityId" IS NOT NULL)
  SELECT LEFT(c.name,36) AS name, c.marketplace, c.status, ROUND(d.spend::numeric,2) AS spend_7d
  FROM d JOIN "Campaign" c ON c.id=d.cid LEFT JOIN h ON h.cid=d.cid
  WHERE h.cid IS NULL AND d.spend > 0 ORDER BY d.spend DESC LIMIT 10`))

console.log('\n=== B2 · same test for YESTERDAY only (a settled full day, both feeds present) ===')
table(await q(`
  WITH d AS (SELECT "localEntityId" AS cid, SUM("costMicros")/1e6 AS spend
             FROM "AmazonAdsDailyPerformance" WHERE "entityType"='CAMPAIGN' AND "date" = CURRENT_DATE - 1 AND "localEntityId" IS NOT NULL
               AND "reportRunId" <> 'ams-stream' GROUP BY 1),
       h AS (SELECT "localEntityId" AS cid, SUM("costMicros")/1e6 AS spend FROM "AmazonAdsHourlyPerformance"
             WHERE "entityType"='CAMPAIGN' AND "date" = CURRENT_DATE - 1 AND "localEntityId" IS NOT NULL GROUP BY 1)
  SELECT COUNT(*)::bigint AS campaigns_with_daily_row,
         COUNT(*) FILTER (WHERE d.spend>0)::bigint AS spent_yesterday,
         COUNT(*) FILTER (WHERE d.spend>0 AND h.cid IS NULL)::bigint AS spent_but_no_hourly,
         ROUND(SUM(d.spend)::numeric,2) AS daily_eur,
         ROUND(SUM(h.spend)::numeric,2) AS hourly_eur,
         ROUND((100*SUM(h.spend)/NULLIF(SUM(d.spend),0))::numeric,1) AS hourly_pct_of_daily
  FROM d LEFT JOIN h ON h.cid=d.cid`))
console.log('   --- per-campaign agreement, yesterday, campaigns present in BOTH (top 10 by daily spend) ---')
table(await q(`
  WITH d AS (SELECT "localEntityId" AS cid, SUM("costMicros")/1e6 AS spend
             FROM "AmazonAdsDailyPerformance" WHERE "entityType"='CAMPAIGN' AND "date" = CURRENT_DATE - 1 AND "localEntityId" IS NOT NULL
               AND "reportRunId" <> 'ams-stream' GROUP BY 1),
       h AS (SELECT "localEntityId" AS cid, SUM("costMicros")/1e6 AS spend, COUNT(*)::int AS hours FROM "AmazonAdsHourlyPerformance"
             WHERE "entityType"='CAMPAIGN' AND "date" = CURRENT_DATE - 1 AND "localEntityId" IS NOT NULL GROUP BY 1)
  SELECT LEFT(c.name,30) AS name, ROUND(d.spend::numeric,2) AS daily, ROUND(h.spend::numeric,2) AS hourly, h.hours,
         ROUND((100*h.spend/NULLIF(d.spend,0))::numeric,1) AS pct
  FROM d JOIN h ON h.cid=d.cid JOIN "Campaign" c ON c.id=d.cid ORDER BY d.spend DESC LIMIT 10`))

console.log('\n=== C · daily-report freshness (the OTHER candidate source) ===')
table(await q(`SELECT MAX("date")::text AS newest_date, MAX("createdAt") AS newest_created, MAX("reportedAt") AS newest_reported,
                      COUNT(*) FILTER (WHERE "date" = CURRENT_DATE)::bigint AS rows_for_today,
                      COUNT(*) FILTER (WHERE "date" = CURRENT_DATE - 1)::bigint AS rows_for_yesterday
               FROM "AmazonAdsDailyPerformance" WHERE "entityType"='CAMPAIGN'`))

console.log('\n=== D · hourly rows with NO localEntityId (would fall out of a local-id join) ===')
table(await q(`SELECT COUNT(*)::bigint AS rows_7d, COUNT(*) FILTER (WHERE "localEntityId" IS NULL)::bigint AS unlinked
               FROM "AmazonAdsHourlyPerformance" WHERE "entityType"='CAMPAIGN' AND "date" >= CURRENT_DATE - 7`))

console.log('\n=== E · adProduct mix in the hourly feed (SP only? SB/SD too?) ===')
table(await q(`SELECT "adProduct", COUNT(*)::bigint AS rows_7d, COUNT(DISTINCT "localEntityId")::bigint AS campaigns
               FROM "AmazonAdsHourlyPerformance" WHERE "entityType"='CAMPAIGN' AND "date" >= CURRENT_DATE - 7 GROUP BY 1 ORDER BY 2 DESC`))

console.log('\n=== F · Campaign.marketplace -> which timezones do we actually need? ===')
table(await q(`SELECT c.marketplace, COUNT(*)::bigint AS campaigns FROM "Campaign" c GROUP BY 1 ORDER BY 2 DESC`))
await prisma.$disconnect()

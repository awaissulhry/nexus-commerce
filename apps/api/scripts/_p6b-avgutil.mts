/** READ-ONLY. Is the Average Budget Utilization denominator still there, and what does it say? */
const { default: prisma } = await import('../src/db.js')
const q = <T,>(s: string) => prisma.$queryRawUnsafe<T[]>(s)
const j = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === 'bigint' ? Number(v) : String(v))
const t = (r: Array<Record<string, unknown>>) => r.forEach(x => console.log('   ' + Object.entries(x).map(([k, v]) => `${k}=${j(v)}`).join('  ')))
console.log('=== campaignBudgetCents coverage on AmazonAdsDailyPerformance ===')
t(await q(`SELECT COUNT(*)::bigint AS campaign_rows_30d,
   COUNT("campaignBudgetCents")::bigint AS with_budget,
   COUNT(*) FILTER (WHERE "campaignBudgetCents" > 0)::bigint AS budget_positive,
   MIN("date")::text AS first_day, MAX("date")::text AS last_day
 FROM "AmazonAdsDailyPerformance" WHERE "entityType"='CAMPAIGN' AND "date" >= CURRENT_DATE - 30`))
console.log('\n=== the CTE ADM-H used: per-day ratio, then averaged (last 7 days) ===')
t(await q(`WITH d AS (
   SELECT "localEntityId" AS cid, "date",
          SUM("costMicros")/10000.0 AS spend_cents,
          MAX("campaignBudgetCents")::int AS budget_cents
   FROM "AmazonAdsDailyPerformance"
   WHERE "entityType"='CAMPAIGN' AND "localEntityId" IS NOT NULL AND "date" >= CURRENT_DATE - 7
   GROUP BY 1,2)
 SELECT COUNT(DISTINCT cid)::bigint AS campaigns,
   COUNT(*) FILTER (WHERE budget_cents > 0)::bigint AS campaign_days_with_denominator,
   ROUND(AVG(spend_cents / NULLIF(budget_cents,0))::numeric, 4) AS mean_ratio,
   ROUND(MAX(spend_cents / NULLIF(budget_cents,0))::numeric, 4) AS max_ratio,
   COUNT(*) FILTER (WHERE spend_cents / NULLIF(budget_cents,0) >= 1)::bigint AS days_at_or_over_100,
   COUNT(*) FILTER (WHERE spend_cents / NULLIF(budget_cents,0) >= 0.85 AND spend_cents / NULLIF(budget_cents,0) < 1)::bigint AS days_85_to_100
 FROM d`))
console.log('\n=== how many campaigns would each colour band catch (7d average)? ===')
t(await q(`WITH d AS (
   SELECT "localEntityId" AS cid, "date", SUM("costMicros")/10000.0 AS spend_cents, MAX("campaignBudgetCents")::int AS budget_cents
   FROM "AmazonAdsDailyPerformance"
   WHERE "entityType"='CAMPAIGN' AND "localEntityId" IS NOT NULL AND "date" >= CURRENT_DATE - 7 GROUP BY 1,2),
 a AS (SELECT cid, AVG(spend_cents / NULLIF(budget_cents,0)) AS util, COUNT(*) FILTER (WHERE budget_cents > 0) AS days FROM d GROUP BY cid)
 SELECT COUNT(*)::bigint AS campaigns_with_a_reading,
   COUNT(*) FILTER (WHERE util >= 1)::bigint AS red_at_or_over_100,
   COUNT(*) FILTER (WHERE util >= 0.85 AND util < 1)::bigint AS amber_85_to_100,
   COUNT(*) FILTER (WHERE util < 0.85)::bigint AS neutral_below_85
 FROM a WHERE days > 0 AND util IS NOT NULL`))
await prisma.$disconnect()

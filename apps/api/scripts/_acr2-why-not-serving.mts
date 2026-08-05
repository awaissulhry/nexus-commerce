/** ACR.2.2 — 85% of keywords never serve. Budget, bid, or something else? READ-ONLY. */
import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = <T = Record<string, unknown>>(s: string) => p.$queryRawUnsafe<T[]>(s)
const n = (v: unknown) => (typeof v === 'bigint' ? Number(v) : v)
const show = (rows: Record<string, unknown>[], max = 20) => rows.length
  ? rows.slice(0, max).forEach((r) => console.log('  ' + Object.entries(r).map(([k, v]) => `${k}=${n(v)}`).join('  ')))
  : console.log('  (none)')
const h = (s: string) => console.log(`\n── ${s} ──`)

h('1. daily budgets on ENABLED IT campaigns — the starvation hypothesis')
show(await q(`SELECT ROUND(("dailyBudget")::numeric,2) AS daily_budget, COUNT(*)::int AS campaigns,
    SUM((SELECT COUNT(*) FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId"
         WHERE g."campaignId"=c.id AND t.kind='KEYWORD' AND t."expressionType" NOT LIKE 'NEGATIVE%'))::int AS targets
  FROM "Campaign" c WHERE c.marketplace='IT' AND c.status='ENABLED'
  GROUP BY 1 ORDER BY 1`), 20)

h('2. did those campaigns actually SPEND their budget? 30d campaign grain')
show(await q(`
  SELECT ROUND((c."dailyBudget")::numeric,2) AS daily_budget,
         COUNT(DISTINCT c.id)::int AS campaigns,
         ROUND((SUM(d."costMicros")/1e6/30)::numeric,2) AS avg_daily_spend_eur,
         ROUND((100.0*SUM(d."costMicros")/1e6/30/NULLIF(SUM(DISTINCT c."dailyBudget"),0))::numeric,1) AS pct_of_budget_used
  FROM "Campaign" c
  LEFT JOIN "AmazonAdsDailyPerformance" d ON d."entityType"='CAMPAIGN' AND d."entityId"=c."externalCampaignId"
     AND d.date > now() - interval '30 days'
  WHERE c.marketplace='IT' AND c.status='ENABLED'
  GROUP BY 1 ORDER BY 1`), 20)

h('3. bids on the targets that never served vs the ones that did')
show(await q(`
  WITH t AS (
    SELECT t.id, t."externalTargetId", t."bidCents", c."dailyBudget"
    FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
    WHERE c.marketplace='IT' AND c.status='ENABLED' AND t.kind='KEYWORD'
      AND t."expressionType" NOT LIKE 'NEGATIVE%'
  ), d AS (
    SELECT "entityId", SUM(impressions) AS impr FROM "AmazonAdsDailyPerformance"
    WHERE "entityType"='AD_TARGET' GROUP BY 1
  )
  SELECT (COALESCE(d.impr,0) > 0) AS served, COUNT(*)::int AS targets,
         ROUND(AVG(t."bidCents")::numeric,1) AS avg_bid_cents,
         MIN(t."bidCents")::int AS min_bid, MAX(t."bidCents")::int AS max_bid,
         ROUND(AVG(t."dailyBudget")::numeric,2) AS avg_campaign_budget
  FROM t LEFT JOIN d ON d."entityId"=t."externalTargetId"
  GROUP BY 1 ORDER BY 1 DESC`))

h('4. how concentrated is delivery — top campaigns by target-grain impressions')
show(await q(`
  SELECT c.name, ROUND((c."dailyBudget")::numeric,2) AS budget,
         COUNT(DISTINCT t.id)::int AS targets,
         COUNT(DISTINCT t.id) FILTER (WHERE d.impr > 0)::int AS served,
         SUM(COALESCE(d.impr,0))::int AS impressions
  FROM "Campaign" c
  JOIN "AdGroup" g ON g."campaignId"=c.id
  JOIN "AdTarget" t ON t."adGroupId"=g.id AND t.kind='KEYWORD' AND t."expressionType" NOT LIKE 'NEGATIVE%'
  LEFT JOIN (SELECT "entityId", SUM(impressions) AS impr FROM "AmazonAdsDailyPerformance"
             WHERE "entityType"='AD_TARGET' GROUP BY 1) d ON d."entityId"=t."externalTargetId"
  WHERE c.marketplace='IT' AND c.status='ENABLED'
  GROUP BY 1,2 ORDER BY impressions DESC`), 14)

await p.$disconnect()

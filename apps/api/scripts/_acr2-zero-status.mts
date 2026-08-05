/** ACR.2.2 — are the zero-bid targets simply PAUSED? READ-ONLY. */
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

h('zero-bid cohort by TARGET status (my earlier query filtered on CAMPAIGN status only)')
show(await q(`
  SELECT t.status AS target_status, COALESCE(t."bidCents",0) = 0 AS zero_bid, COUNT(*)::int AS targets
  FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE c.marketplace='IT' AND c.status='ENABLED' AND t.kind='KEYWORD' AND t."expressionType" NOT LIKE 'NEGATIVE%'
  GROUP BY 1,2 ORDER BY 1, 2 DESC`))

h('serving rate by TARGET status — the honest denominator')
show(await q(`
  WITH t AS (
    SELECT t.status, t."externalTargetId", COALESCE(t."bidCents",0) AS bid
    FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
    WHERE c.marketplace='IT' AND c.status='ENABLED' AND t.kind='KEYWORD' AND t."expressionType" NOT LIKE 'NEGATIVE%'
  ), d AS (SELECT "entityId", SUM(impressions) AS impr FROM "AmazonAdsDailyPerformance"
           WHERE "entityType"='AD_TARGET' GROUP BY 1)
  SELECT t.status, COUNT(*)::int AS targets,
         ROUND(AVG(t.bid)::numeric,1) AS avg_bid_cents,
         COUNT(*) FILTER (WHERE COALESCE(d.impr,0) > 0)::int AS served,
         ROUND(100.0*COUNT(*) FILTER (WHERE COALESCE(d.impr,0) > 0)/NULLIF(COUNT(*),0),1) AS served_pct
  FROM t LEFT JOIN d ON d."entityId"=t."externalTargetId"
  GROUP BY 1 ORDER BY targets DESC`))

h('ENABLED targets only: bid bands and serving — this is the real question')
show(await q(`
  WITH t AS (
    SELECT t."externalTargetId", COALESCE(t."bidCents",0) AS bid
    FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
    WHERE c.marketplace='IT' AND c.status='ENABLED' AND t.status='ENABLED'
      AND t.kind='KEYWORD' AND t."expressionType" NOT LIKE 'NEGATIVE%'
  ), d AS (SELECT "entityId", SUM(impressions) AS impr FROM "AmazonAdsDailyPerformance"
           WHERE "entityType"='AD_TARGET' GROUP BY 1)
  SELECT CASE WHEN t.bid = 0 THEN 'a 0c (unset?)' WHEN t.bid <= 5 THEN 'b 1-5c'
              WHEN t.bid <= 20 THEN 'c 6-20c' WHEN t.bid <= 40 THEN 'd 21-40c' ELSE 'e 41c+' END AS band,
         COUNT(*)::int AS targets,
         COUNT(*) FILTER (WHERE COALESCE(d.impr,0) > 0)::int AS served,
         ROUND(100.0*COUNT(*) FILTER (WHERE COALESCE(d.impr,0) > 0)/NULLIF(COUNT(*),0),1) AS served_pct
  FROM t LEFT JOIN d ON d."entityId"=t."externalTargetId"
  GROUP BY 1 ORDER BY 1`))

await p.$disconnect()

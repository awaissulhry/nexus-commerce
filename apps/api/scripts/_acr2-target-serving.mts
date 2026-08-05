/** ACR.2.2 — with 30 days of grain, how many targets actually serve? READ-ONLY. */
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

h('grain coverage — days and rows actually landed')
show(await q(`SELECT COUNT(DISTINCT date)::int AS days, COUNT(*)::int AS rows,
  MIN(date)::text AS oldest, MAX(date)::text AS newest,
  COUNT(DISTINCT "entityId")::int AS distinct_targets
  FROM "AmazonAdsDailyPerformance" WHERE "entityType"='AD_TARGET'`))

h('IT non-negative keyword targets: how many EVER served in the window')
show(await q(`
  WITH t AS (
    SELECT t.id, t."externalTargetId", c.name AS campaign
    FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
    WHERE c.marketplace='IT' AND t.kind='KEYWORD' AND t."expressionType" NOT LIKE 'NEGATIVE%'
      AND c.status='ENABLED'
  )
  SELECT COUNT(*)::int AS targets,
         COUNT(*) FILTER (WHERE d.impr > 0)::int AS served,
         COUNT(*) FILTER (WHERE d.impr IS NULL)::int AS never_in_report,
         ROUND(100.0*COUNT(*) FILTER (WHERE d.impr > 0)/NULLIF(COUNT(*),0),1) AS served_pct
  FROM t LEFT JOIN (
    SELECT "entityId", SUM(impressions) AS impr FROM "AmazonAdsDailyPerformance"
    WHERE "entityType"='AD_TARGET' GROUP BY 1
  ) d ON d."entityId" = t."externalTargetId"`))

h('same, GALE only')
show(await q(`
  WITH t AS (
    SELECT t.id, t."externalTargetId"
    FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
    WHERE c.marketplace='IT' AND UPPER(c.name) LIKE '%GALE%' AND t.kind='KEYWORD'
      AND t."expressionType" NOT LIKE 'NEGATIVE%' AND c.status='ENABLED'
  )
  SELECT COUNT(*)::int AS gale_targets,
         COUNT(*) FILTER (WHERE d.impr > 0)::int AS served,
         ROUND(100.0*COUNT(*) FILTER (WHERE d.impr > 0)/NULLIF(COUNT(*),0),1) AS served_pct,
         SUM(COALESCE(d.impr,0))::int AS impressions
  FROM t LEFT JOIN (
    SELECT "entityId", SUM(impressions) AS impr FROM "AmazonAdsDailyPerformance"
    WHERE "entityType"='AD_TARGET' GROUP BY 1
  ) d ON d."entityId" = t."externalTargetId"`))

h('and do any GALE targets have SALES yet — the thing the champion rule needs')
show(await q(`
  SELECT COUNT(*)::int AS targets_with_sales
  FROM (SELECT "entityId", SUM("sales7dCents") AS s FROM "AmazonAdsDailyPerformance"
        WHERE "entityType"='AD_TARGET' GROUP BY 1 HAVING SUM("sales7dCents") > 0) x`))

await p.$disconnect()

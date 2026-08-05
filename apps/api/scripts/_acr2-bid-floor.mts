/** ACR.2.2 — is the 9.4c average bid a choice, or suppression that never lifted? READ-ONLY. */
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

h('1. bid distribution across ENABLED IT keyword targets')
show(await q(`
  SELECT CASE WHEN t."bidCents" IS NULL THEN 'null (inherits ad group)'
              WHEN t."bidCents" = 0 THEN '0c'
              WHEN t."bidCents" <= 5 THEN '1-5c'
              WHEN t."bidCents" <= 10 THEN '6-10c'
              WHEN t."bidCents" <= 20 THEN '11-20c'
              WHEN t."bidCents" <= 40 THEN '21-40c'
              ELSE '41c+' END AS bid_band,
         COUNT(*)::int AS targets,
         COUNT(*) FILTER (WHERE t."suppressedFromBidCents" IS NOT NULL)::int AS suppressed
  FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE c.marketplace='IT' AND c.status='ENABLED' AND t.kind='KEYWORD'
    AND t."expressionType" NOT LIKE 'NEGATIVE%'
  GROUP BY 1 ORDER BY 1`))

h('2. is suppression the cause? targets remembering a higher pre-suppression bid')
show(await q(`
  SELECT COUNT(*)::int AS targets_with_remembered_bid,
         ROUND(AVG(t."bidCents")::numeric,1) AS avg_current_bid,
         ROUND(AVG(t."suppressedFromBidCents")::numeric,1) AS avg_remembered_bid
  FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE c.marketplace='IT' AND c.status='ENABLED' AND t."suppressedFromBidCents" IS NOT NULL`))

h('3. campaign-level suppression — is anything still held down?')
show(await q(`
  SELECT COUNT(*)::int AS campaigns,
         COUNT(*) FILTER (WHERE "bidsSuppressedAt" IS NOT NULL)::int AS suppressed_now,
         COUNT(*) FILTER (WHERE "bidsSuppressedAt" IS NOT NULL AND "bidsSuppressedAt" < now() - interval '7 days')::int AS suppressed_over_a_week
  FROM "Campaign" WHERE marketplace='IT' AND status='ENABLED'`))
show(await q(`
  SELECT name, "bidsSuppressedAt"::text AS since, "bidsSuppressedFloorCents" AS floor_c,
    COALESCE("bidsSuppressedBy",'(unknown owner)') AS owner
  FROM "Campaign" WHERE marketplace='IT' AND "bidsSuppressedAt" IS NOT NULL ORDER BY "bidsSuppressedAt"`), 15)

h('4. served vs not, by bid band — does the 9.4c cohort simply lose?')
show(await q(`
  WITH t AS (
    SELECT t."externalTargetId", COALESCE(t."bidCents",0) AS bid
    FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
    WHERE c.marketplace='IT' AND c.status='ENABLED' AND t.kind='KEYWORD' AND t."expressionType" NOT LIKE 'NEGATIVE%'
  ), d AS (SELECT "entityId", SUM(impressions) AS impr FROM "AmazonAdsDailyPerformance"
           WHERE "entityType"='AD_TARGET' GROUP BY 1)
  SELECT CASE WHEN t.bid <= 5 THEN 'a 0-5c' WHEN t.bid <= 10 THEN 'b 6-10c'
              WHEN t.bid <= 20 THEN 'c 11-20c' WHEN t.bid <= 40 THEN 'd 21-40c' ELSE 'e 41c+' END AS band,
         COUNT(*)::int AS targets,
         COUNT(*) FILTER (WHERE COALESCE(d.impr,0) > 0)::int AS served,
         ROUND(100.0*COUNT(*) FILTER (WHERE COALESCE(d.impr,0) > 0)/NULLIF(COUNT(*),0),1) AS served_pct
  FROM t LEFT JOIN d ON d."entityId"=t."externalTargetId"
  GROUP BY 1 ORDER BY 1`))

await p.$disconnect()

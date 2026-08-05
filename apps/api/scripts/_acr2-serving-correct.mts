/**
 * ACR.2.2 — serving rate, using the schema's REAL negativity discriminator.
 *
 * The earlier pass filtered `expressionType NOT LIKE 'NEGATIVE%'`, assuming the match-type
 * column encodes negativity. It does not — `AdTarget.isNegative` does, and all 1,988 "zero-bid"
 * targets turned out to be negatives. A negative keyword has no bid and never serves, so every
 * number derived from that filter was contaminated. Same two-vocabularies trap this engagement
 * keeps finding, hit here by me.
 */
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

h('0. does expressionType even mark negatives? (the assumption that was wrong)')
show(await q(`SELECT t."isNegative", t."expressionType", COUNT(*)::int AS targets
  FROM "AdTarget" t WHERE t.kind='KEYWORD' GROUP BY 1,2 ORDER BY 1, 3 DESC`), 14)

h('1. POSITIVE keywords on ENABLED IT campaigns — the honest denominator')
show(await q(`
  WITH t AS (
    SELECT t."externalTargetId", COALESCE(t."bidCents",0) AS bid, t.status
    FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
    WHERE c.marketplace='IT' AND c.status='ENABLED' AND t.kind='KEYWORD' AND t."isNegative" = false
  ), d AS (SELECT "entityId", SUM(impressions) AS impr FROM "AmazonAdsDailyPerformance"
           WHERE "entityType"='AD_TARGET' GROUP BY 1)
  SELECT t.status, COUNT(*)::int AS targets, ROUND(AVG(t.bid)::numeric,1) AS avg_bid_cents,
         COUNT(*) FILTER (WHERE COALESCE(d.impr,0) > 0)::int AS served,
         ROUND(100.0*COUNT(*) FILTER (WHERE COALESCE(d.impr,0) > 0)/NULLIF(COUNT(*),0),1) AS served_pct
  FROM t LEFT JOIN d ON d."entityId"=t."externalTargetId" GROUP BY 1 ORDER BY 2 DESC`))

h('2. ENABLED positive keywords by bid band')
show(await q(`
  WITH t AS (
    SELECT t."externalTargetId", COALESCE(t."bidCents",0) AS bid
    FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
    WHERE c.marketplace='IT' AND c.status='ENABLED' AND t.status='ENABLED'
      AND t.kind='KEYWORD' AND t."isNegative" = false
  ), d AS (SELECT "entityId", SUM(impressions) AS impr FROM "AmazonAdsDailyPerformance"
           WHERE "entityType"='AD_TARGET' GROUP BY 1)
  SELECT CASE WHEN t.bid = 0 THEN 'a 0c' WHEN t.bid <= 20 THEN 'b 1-20c'
              WHEN t.bid <= 40 THEN 'c 21-40c' ELSE 'd 41c+' END AS band,
         COUNT(*)::int AS targets,
         COUNT(*) FILTER (WHERE COALESCE(d.impr,0) > 0)::int AS served,
         ROUND(100.0*COUNT(*) FILTER (WHERE COALESCE(d.impr,0) > 0)/NULLIF(COUNT(*),0),1) AS served_pct
  FROM t LEFT JOIN d ON d."entityId"=t."externalTargetId" GROUP BY 1 ORDER BY 1`))

h('3. GALE positives only')
show(await q(`
  WITH t AS (
    SELECT t."externalTargetId"
    FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
    WHERE c.marketplace='IT' AND c.status='ENABLED' AND t.status='ENABLED'
      AND UPPER(c.name) LIKE '%GALE%' AND t.kind='KEYWORD' AND t."isNegative" = false
  ), d AS (SELECT "entityId", SUM(impressions) AS impr FROM "AmazonAdsDailyPerformance"
           WHERE "entityType"='AD_TARGET' GROUP BY 1)
  SELECT COUNT(*)::int AS gale_positive_targets,
         COUNT(*) FILTER (WHERE COALESCE(d.impr,0) > 0)::int AS served,
         ROUND(100.0*COUNT(*) FILTER (WHERE COALESCE(d.impr,0) > 0)/NULLIF(COUNT(*),0),1) AS served_pct
  FROM t LEFT JOIN d ON d."entityId"=t."externalTargetId"`))

await p.$disconnect()

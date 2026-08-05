/** ACR.2.2 — are the 987 zero-bid keywords really zero, or inheriting an ad-group default? READ-ONLY. */
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

h('1. the ad groups those zero-bid keywords sit in — what is the group default?')
show(await q(`
  SELECT COALESCE(g."defaultBidCents", -1) AS group_default_cents,
         COUNT(DISTINCT g.id)::int AS ad_groups,
         COUNT(t.id)::int AS zero_bid_targets
  FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE c.marketplace='IT' AND c.status='ENABLED' AND t.kind='KEYWORD'
    AND t."expressionType" NOT LIKE 'NEGATIVE%' AND COALESCE(t."bidCents",0) = 0
  GROUP BY 1 ORDER BY 1`), 15)

h('2. do zero-bid and non-zero targets share ad groups? (if so, inheritance is not the story)')
show(await q(`
  SELECT g.name AS ad_group, g."defaultBidCents" AS group_default,
         COUNT(*) FILTER (WHERE COALESCE(t."bidCents",0)=0)::int AS zero_bid,
         COUNT(*) FILTER (WHERE COALESCE(t."bidCents",0)>0)::int AS with_bid
  FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE c.marketplace='IT' AND c.status='ENABLED' AND t.kind='KEYWORD' AND t."expressionType" NOT LIKE 'NEGATIVE%'
  GROUP BY 1,2 HAVING COUNT(*) FILTER (WHERE COALESCE(t."bidCents",0)=0) > 0
     AND COUNT(*) FILTER (WHERE COALESCE(t."bidCents",0)>0) > 0
  ORDER BY zero_bid DESC`), 12)

h('3. when were those targets last synced from Amazon?')
show(await q(`
  SELECT COALESCE(t."bidCents",0) = 0 AS zero_bid, COUNT(*)::int AS targets,
         MIN(t."updatedAt")::text AS oldest_sync, MAX(t."updatedAt")::text AS newest_sync
  FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE c.marketplace='IT' AND c.status='ENABLED' AND t.kind='KEYWORD' AND t."expressionType" NOT LIKE 'NEGATIVE%'
  GROUP BY 1 ORDER BY 1`))

h('4. the 3 zero-bid targets that DID serve — what did they cost per click?')
show(await q(`
  SELECT t."expressionValue" AS term, t."bidCents", c.name AS campaign,
         SUM(d.impressions)::int AS impr, SUM(d.clicks)::int AS clicks,
         ROUND((SUM(d."costMicros")/1e6)::numeric,2) AS spend_eur
  FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  JOIN "AmazonAdsDailyPerformance" d ON d."entityType"='AD_TARGET' AND d."entityId"=t."externalTargetId"
  WHERE c.marketplace='IT' AND c.status='ENABLED' AND COALESCE(t."bidCents",0) <= 5
  GROUP BY 1,2,3 HAVING SUM(d.impressions) > 0 ORDER BY impr DESC`), 10)

await p.$disconnect()

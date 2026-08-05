/** ACR.3 — the numbers behind the four operator decisions. READ-ONLY. */
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
const h = (s: string) => console.log(`\n${'─'.repeat(92)}\n${s}\n${'─'.repeat(92)}`)

h('CPC — what a click actually costs us, so a ceiling can be a number not a guess')
show(await q(`
  SELECT COUNT(*)::int AS days_x_targets,
         SUM(clicks)::int AS clicks,
         ROUND((SUM("costMicros")/1e6)::numeric,2) AS spend_eur,
         ROUND((SUM("costMicros")/1e6/NULLIF(SUM(clicks),0))::numeric,3) AS avg_cpc_eur
  FROM "AmazonAdsDailyPerformance" WHERE "entityType"='AD_TARGET' AND clicks > 0`))
show(await q(`
  SELECT ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cpc))::numeric,2) AS p50,
         ROUND((PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY cpc))::numeric,2) AS p90,
         ROUND((PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY cpc))::numeric,2) AS p99,
         ROUND(MAX(cpc)::numeric,2) AS max_cpc
  FROM (SELECT "costMicros"/1e6/NULLIF(clicks,0) AS cpc FROM "AmazonAdsDailyPerformance"
        WHERE "entityType"='AD_TARGET' AND clicks > 0) x`))

h('Highest bid anyone actually holds — a ceiling below this would bind existing intent')
show(await q(`
  SELECT ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY "bidCents"))::numeric,0) AS p50_bid_c,
         ROUND((PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY "bidCents"))::numeric,0) AS p95_bid_c,
         MAX("bidCents")::int AS max_bid_c
  FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE c.marketplace='IT' AND c.status='ENABLED' AND t.status='ENABLED'
    AND t.kind='KEYWORD' AND t."isNegative"=false`))

h('The 14 unbid terms — relevance evidence: do OUR products already appear there organically?')
show(await q(`
  WITH wk AS (SELECT MAX("startDate") AS w FROM "SearchQueryPerformance"
              WHERE marketplace='IT' AND "impressionsBrand">0)
  SELECT s."searchQuery" AS term,
         SUM(s."impressionsTotal")::int AS market_impr,
         SUM(s."impressionsBrand")::int AS our_impr,
         COUNT(DISTINCT s.asin) FILTER (WHERE s."impressionsBrand">0)::int AS our_asins,
         SUM(s."purchasesTotal")::int AS market_buys,
         SUM(s."cartAddsTotal")::int AS market_carts,
         ROUND((100.0*SUM(s."purchasesTotal")/NULLIF(SUM(s."clicksTotal"),0))::numeric,1) AS market_cvr_pct
  FROM "SearchQueryPerformance" s, wk
  WHERE s.marketplace='IT' AND s."startDate"=wk.w AND s."impressionsTotal" >= 25000
    AND NOT EXISTS (
      SELECT 1 FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
      WHERE LOWER(t."expressionValue")=LOWER(s."searchQuery") AND c.marketplace='IT'
        AND t.kind='KEYWORD' AND t."isNegative"=false)
  GROUP BY 1 ORDER BY 2 DESC`), 20)

h('For contrast — terms we DO bid, same week, so relevance can be judged like for like')
show(await q(`
  WITH wk AS (SELECT MAX("startDate") AS w FROM "SearchQueryPerformance"
              WHERE marketplace='IT' AND "impressionsBrand">0)
  SELECT s."searchQuery" AS term, SUM(s."impressionsTotal")::int AS market_impr,
         COUNT(DISTINCT s.asin) FILTER (WHERE s."impressionsBrand">0)::int AS our_asins,
         ROUND((100.0*SUM(s."impressionsBrand")/NULLIF(SUM(s."impressionsTotal"),0))::numeric,2) AS share_pct
  FROM "SearchQueryPerformance" s, wk
  WHERE s.marketplace='IT' AND s."startDate"=wk.w AND s."impressionsTotal" >= 25000
    AND EXISTS (
      SELECT 1 FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
      WHERE LOWER(t."expressionValue")=LOWER(s."searchQuery") AND c.marketplace='IT'
        AND t.kind='KEYWORD' AND t."isNegative"=false)
  GROUP BY 1 ORDER BY 2 DESC`), 12)

h('What do we actually sell? the advertised catalogue')
show(await q(`
  SELECT p.name, COUNT(DISTINCT pa.id)::int AS ads
  FROM "AdProductAd" pa JOIN "Product" p ON p.id = pa."productId"
  GROUP BY 1 ORDER BY 2 DESC`), 14)

await p.$disconnect()

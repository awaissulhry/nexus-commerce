/** ACR.3 — the complete unbid list, aggregated per TERM (not per ASIN row). READ-ONLY. */
import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = <T = Record<string, unknown>>(s: string) => p.$queryRawUnsafe<T[]>(s)
const n = (v: unknown) => (typeof v === 'bigint' ? Number(v) : v)
const show = (rows: Record<string, unknown>[], max = 30) => rows.length
  ? rows.slice(0, max).forEach((r) => console.log('  ' + Object.entries(r).map(([k, v]) => `${k}=${n(v)}`).join('  ')))
  : console.log('  (none)')

console.log('\nAll unbid terms >= 25k impressions, with the relevance evidence:\n')
show(await q(`
  WITH wk AS (SELECT MAX("startDate") AS w FROM "SearchQueryPerformance"
              WHERE marketplace='IT' AND "impressionsBrand">0)
  SELECT s."searchQuery" AS term,
         SUM(s."impressionsTotal")::int AS market_impr,
         SUM(s."impressionsBrand")::int AS our_impr,
         COUNT(DISTINCT s.asin) FILTER (WHERE s."impressionsBrand">0)::int AS our_asins,
         SUM(s."purchasesTotal")::int AS market_buys,
         ROUND((100.0*SUM(s."purchasesTotal")/NULLIF(SUM(s."clicksTotal"),0))::numeric,2) AS mkt_cvr_pct,
         ROUND((100.0*SUM(s."impressionsBrand")/NULLIF(SUM(s."impressionsTotal"),0))::numeric,3) AS our_share_pct
  FROM "SearchQueryPerformance" s, wk
  WHERE s.marketplace='IT' AND s."startDate"=wk.w
    AND NOT EXISTS (
      SELECT 1 FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
      WHERE LOWER(t."expressionValue")=LOWER(s."searchQuery") AND c.marketplace='IT'
        AND t.kind='KEYWORD' AND t."isNegative"=false)
  GROUP BY 1 HAVING SUM(s."impressionsTotal") >= 25000
  ORDER BY 2 DESC`), 25)

await p.$disconnect()

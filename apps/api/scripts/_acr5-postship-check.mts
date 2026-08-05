/**
 * ACR Stage 5 — post-ship safety check. READ-ONLY.
 *
 * Two changes shipped to prod carry real risk and are worth confirming rather than assuming:
 *
 *   1. The report DELIVERY GATE. If its rule is wrong it silently stops SP reports — the exact
 *      failure mode it was written to remove, pointed the other way. The nightly cycle is the
 *      only real test, so this reports what has happened since the deploy and says plainly when
 *      the answer is "not yet".
 *   2. The 88 SB KEYWORDS un-archived from Amazon. Their campaigns are PAUSED so nothing can
 *      spend, but the stated risk was that engines might now consider them in scope. This looks
 *      for any write attempted against them since.
 *
 * Usage: cd apps/api && npx tsx scripts/_acr5-postship-check.mts
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = (s: string) => p.$queryRawUnsafe<any[]>(s)
const show = (r: any[]) => r.length
  ? r.forEach(x => console.log('  ' + Object.entries(x).map(([k, v]) => `${k}=${typeof v === 'bigint' ? Number(v) : v}`).join('  ')))
  : console.log('  (none)')

console.log('\n═══ 1. Report jobs by ad product, last 24h — has a cycle run since the gate shipped? ═══')
show(await q(`SELECT "adProduct" AS prod, COUNT(*)::int AS jobs,
  MIN("createdAt")::text AS first, MAX("createdAt")::text AS last,
  SUM("rowsIngested")::int AS rows
  FROM "AmazonAdsReportJob" WHERE "createdAt" > now() - interval '24 hours'
  GROUP BY 1 ORDER BY jobs DESC`))

console.log('\n═══ 2. …and specifically SINCE the deploy (20:30Z 2026-08-05) ═══')
show(await q(`SELECT "adProduct" AS prod, COUNT(*)::int AS jobs, MAX("createdAt")::text AS last
  FROM "AmazonAdsReportJob" WHERE "createdAt" > timestamp '2026-08-05 20:30:00'
  GROUP BY 1 ORDER BY jobs DESC`))

console.log('\n═══ 3. SB keyword state now — should be 70 ENABLED / 18 PAUSED, matching Amazon ═══')
show(await q(`SELECT t.status, COUNT(*)::int AS n, MIN(t."bidCents")::int AS min_bid, MAX(t."bidCents")::int AS max_bid
  FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE c."adProduct"='SPONSORED_BRANDS' AND t.kind='KEYWORD' AND t."isNegative"=false
  GROUP BY 1 ORDER BY n DESC`))

console.log('\n═══ 4. Their campaigns must still be PAUSED — nothing can spend while they are ═══')
show(await q(`SELECT status, COUNT(*)::int AS n FROM "Campaign"
  WHERE "adProduct" IN ('SPONSORED_BRANDS','SPONSORED_DISPLAY') GROUP BY 1`))

console.log('\n═══ 5. Any write attempted against SB entities since the reconcile? ═══')
show(await q(`SELECT "actionType", COUNT(*)::int AS n, MAX("createdAt")::text AS last
  FROM "AdvertisingActionLog" WHERE "createdAt" > timestamp '2026-08-05 20:15:00'
  GROUP BY 1 ORDER BY n DESC LIMIT 10`))

console.log('\n═══ 6. Ad-product mix unchanged? SB/SD must still show zero delivery ═══')
show(await q(`SELECT "adProduct" AS prod, SUM(impressions)::int AS impr, ROUND(SUM("costMicros")/1e6,2)::text AS spend
  FROM "AmazonAdsDailyPerformance" WHERE date > CURRENT_DATE - 3 GROUP BY 1 ORDER BY impr DESC`))

await p.$disconnect(); process.exit(0)

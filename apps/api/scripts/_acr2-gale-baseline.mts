/**
 * ACR.2.0 — GALE's coverage baseline. READ-ONLY.
 *
 * The pilot's "before". Without this, a widen-or-stop gate in three weeks has nothing to
 * compare against and the whole experiment concludes on vibes.
 *
 * Answers, in order:
 *   1. What IS the GALE family — products, ASINs, SKUs (resolved live, never stored)
 *   2. Which campaigns advertise it, and what do they spend
 *   3. Which keywords do those campaigns SHARE — the coverage set candidates
 *   4. What share of those keywords do we actually hold today (SQP, fixed 2026-08-05)
 *   5. Where are we already competing with ourselves
 *
 * Usage: cd apps/api && npx tsx scripts/_acr2-gale-baseline.mts [familyName=GALE]
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })

const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = <T = Record<string, unknown>>(sql: string) => p.$queryRawUnsafe<T[]>(sql)
const n = (v: unknown) => (typeof v === 'bigint' ? Number(v) : v)
const show = (rows: Record<string, unknown>[], max = 20) => rows.length
  ? rows.slice(0, max).forEach((r) => console.log('  ' + Object.entries(r).map(([k, v]) => `${k}=${n(v)}`).join('  ')))
  : console.log('  (none)')
const h = (s: string) => console.log(`\n${'─'.repeat(78)}\n${s}\n${'─'.repeat(78)}`)

const FAMILY = (process.argv[2] ?? 'GALE').toUpperCase()

h(`1. ${FAMILY} campaigns — what is advertising this family`)
show(await q(`
  SELECT c.name, c.status, c.marketplace,
         c."liveBidWritesEnabled" AS allowlisted,
         ROUND((c."dailyBudget")::numeric, 2) AS daily_budget
  FROM "Campaign" c
  WHERE UPPER(c.name) LIKE '%${FAMILY}%'
  ORDER BY c.status, c.name
`), 30)

h(`2. Spend and sales, last 30 days (campaign grain)`)
show(await q(`
  SELECT SUM(d.impressions)::int AS impressions,
         SUM(d.clicks)::int AS clicks,
         ROUND((SUM(d."costMicros")/1e6)::numeric, 2) AS spend_eur,
         ROUND((SUM(d."sales7dCents")/100.0)::numeric, 2) AS sales_eur,
         SUM(d."orders7d")::int AS orders
  FROM "AmazonAdsDailyPerformance" d
  JOIN "Campaign" c ON c."externalCampaignId" = d."entityId"
  WHERE d."entityType" = 'CAMPAIGN' AND UPPER(c.name) LIKE '%${FAMILY}%'
    AND d.date > now() - interval '30 days'
`))

h(`3. Keywords this family targets, and how many of ITS campaigns share each`)
console.log('  A term carried by 2+ campaigns is a coverage-set candidate — and, today,')
console.log('  a place where the family may already be contesting itself.')
show(await q(`
  SELECT LOWER(t."expressionValue") AS term,
         COUNT(DISTINCT c.id)::int AS campaigns,
         COUNT(*)::int AS targets,
         STRING_AGG(DISTINCT t."expressionType", ',') AS match_types
  FROM "AdTarget" t
  JOIN "AdGroup" g ON g.id = t."adGroupId"
  JOIN "Campaign" c ON c.id = g."campaignId"
  WHERE UPPER(c.name) LIKE '%${FAMILY}%' AND t.kind = 'KEYWORD' AND c.status = 'ENABLED'
  GROUP BY 1
  HAVING COUNT(DISTINCT c.id) > 1
  ORDER BY campaigns DESC, targets DESC
`), 25)

h(`4. Where we actually stand on those terms — SQP share (the number fixed today)`)
console.log('  impressionShare is OUR share of all page-1 impressions for the query.')
show(await q(`
  SELECT s."searchQuery" AS term,
         SUM(s."impressionsTotal")::int AS market_impr,
         SUM(s."impressionsBrand")::int AS our_impr,
         ROUND((100.0 * SUM(s."impressionsBrand") / NULLIF(SUM(s."impressionsTotal"),0))::numeric, 2) AS our_share_pct,
         SUM(s."purchasesTotal")::int AS market_purchases,
         SUM(s."purchasesBrand")::int AS our_purchases
  FROM "SearchQueryPerformance" s
  WHERE s."startDate" = (SELECT MAX("startDate") FROM "SearchQueryPerformance")
  GROUP BY 1
  HAVING SUM(s."impressionsBrand") > 0
  ORDER BY our_impr DESC
`), 15)

h(`5. Headroom — the biggest markets where we are nearly absent`)
console.log('  High market volume + low share = where coverage has somewhere to go.')
show(await q(`
  SELECT s."searchQuery" AS term,
         SUM(s."impressionsTotal")::int AS market_impr,
         ROUND((100.0 * SUM(s."impressionsBrand") / NULLIF(SUM(s."impressionsTotal"),0))::numeric, 2) AS our_share_pct
  FROM "SearchQueryPerformance" s
  WHERE s."startDate" = (SELECT MAX("startDate") FROM "SearchQueryPerformance")
  GROUP BY 1
  HAVING SUM(s."impressionsTotal") > 5000
  ORDER BY (100.0 * SUM(s."impressionsBrand") / NULLIF(SUM(s."impressionsTotal"),0)) ASC NULLS LAST
`), 12)

h(`6. Rank governance — is anything holding these campaigns to a rank today`)
show(await q(`
  SELECT c.name, sch.enabled, sch."defaultTargetKey", sch."lastApplied"::text AS last_applied
  FROM "AdSchedule" sch
  JOIN "Campaign" c ON c.id = sch."campaignId"
  WHERE UPPER(c.name) LIKE '%${FAMILY}%'
  ORDER BY sch.enabled DESC, c.name
`), 20)

await p.$disconnect()
console.log('\nDone — read-only.\n')

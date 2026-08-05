/**
 * ACR Stage 5 — SB/SD state audit, LOCAL SIDE ONLY. READ-ONLY.
 *
 * Answers the question the operator has to answer before Stage 5 is planned:
 * are SB/SD dormant by choice, or abandoned? Local DB cannot prove intent, but it
 * can price the question — how much these campaigns ever spent, when they stopped,
 * and whether the stopping looks like a decision (gradual, per-campaign) or like
 * the reconcile bug (all at once, same timestamp).
 *
 * Usage: cd apps/api && npx tsx scripts/_acr5-sbsd-state.mts
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

console.log('\n═══ 1. Campaign inventory by ad product × status ═══')
show(await q(`SELECT COALESCE("adProduct",'(null)') AS ad_product, status, COUNT(*)::int AS n,
  MIN("createdAt")::text AS first_created, MAX("updatedAt")::text AS last_updated
  FROM "Campaign" GROUP BY 1,2 ORDER BY 1,2`))

console.log('\n═══ 2. The SB/SD campaigns themselves ═══')
show(await q(`SELECT "adProduct" AS prod, name, status, marketplace,
  "externalCampaignId" AS ext_id, "dailyBudget"::text AS budget,
  "createdAt"::text AS created, "updatedAt"::text AS updated
  FROM "Campaign"
  WHERE "adProduct" IN ('SPONSORED_BRANDS','SPONSORED_DISPLAY')
  ORDER BY "adProduct", "updatedAt" DESC`))

console.log('\n═══ 3. Did they all get archived at the SAME MOMENT? (bug signature vs decision) ═══')
show(await q(`SELECT "adProduct" AS prod, date_trunc('minute',"updatedAt")::text AS archived_minute, COUNT(*)::int AS n
  FROM "Campaign"
  WHERE "adProduct" IN ('SPONSORED_BRANDS','SPONSORED_DISPLAY') AND status='ARCHIVED'
  GROUP BY 1,2 ORDER BY n DESC, 2 DESC`))

console.log('\n═══ 4. Lifetime spend/sales — was this ever a real channel? ═══')
show(await q(`SELECT "adProduct" AS prod, COUNT(*)::int AS metric_rows,
  MIN(date)::text AS first_day, MAX(date)::text AS last_day,
  ROUND(SUM("costMicros")/1e6, 2)::text AS lifetime_spend,
  ROUND(SUM(COALESCE("sales7dCents",0))/100.0, 2)::text AS lifetime_sales_7d,
  SUM(clicks)::int AS clicks, SUM(impressions)::int AS impressions
  FROM "AmazonAdsDailyPerformance"
  WHERE "adProduct" IN ('SPONSORED_BRANDS','SPONSORED_DISPLAY')
  GROUP BY 1 ORDER BY 1`))

console.log('\n═══ 4b. …and SP for comparison (the channel that IS running) ═══')
show(await q(`SELECT "adProduct" AS prod, COUNT(*)::int AS metric_rows,
  MIN(date)::text AS first_day, MAX(date)::text AS last_day,
  ROUND(SUM("costMicros")/1e6, 2)::text AS lifetime_spend,
  SUM(impressions)::int AS impressions
  FROM "AmazonAdsDailyPerformance"
  WHERE "adProduct" = 'SPONSORED_PRODUCTS' GROUP BY 1`))

console.log('\n═══ 5. Last 90 days of SB/SD performance rows (is anything still alive on Amazon?) ═══')
show(await q(`SELECT "adProduct" AS prod, date::text AS day,
  ROUND(SUM("costMicros")/1e6, 2)::text AS spend, SUM(impressions)::int AS impr
  FROM "AmazonAdsDailyPerformance"
  WHERE "adProduct" IN ('SPONSORED_BRANDS','SPONSORED_DISPLAY')
    AND date > CURRENT_DATE - 90
  GROUP BY 1,2 HAVING SUM(impressions) > 0 ORDER BY 2 DESC LIMIT 20`))

console.log('\n═══ 6. The report jobs — what are they asking for, and what comes back? (30d) ═══')
show(await q(`SELECT "adProduct" AS prod, status, COUNT(*)::int AS jobs,
  SUM("rowsIngested")::int AS rows_ingested,
  COUNT(*) FILTER (WHERE "ingestedAt" IS NOT NULL)::int AS actually_processed,
  MAX("createdAt")::text AS last_job
  FROM "AmazonAdsReportJob"
  WHERE "createdAt" > CURRENT_DATE - 30
  GROUP BY 1,2 ORDER BY 1, jobs DESC`))

console.log('\n═══ 6b. SB/SD report jobs — cost of asking a question nobody answers ═══')
show(await q(`SELECT "adProduct" AS prod, "reportTypeId" AS report_type, COUNT(*)::int AS jobs_30d,
  SUM("rowsIngested")::int AS total_rows, ROUND(AVG(attempts)::numeric,1)::text AS avg_attempts
  FROM "AmazonAdsReportJob"
  WHERE "createdAt" > CURRENT_DATE - 30 AND "adProduct" IN ('SPONSORED_BRANDS','SPONSORED_DISPLAY')
  GROUP BY 1,2 ORDER BY jobs_30d DESC`))

console.log('\n═══ 7. SB/SD entity substrate that would survive a revival ═══')
for (const [label, sql] of [
  ['ad groups',    `SELECT c."adProduct" AS prod, COUNT(*)::int AS n FROM "AdGroup" g JOIN "Campaign" c ON c.id=g."campaignId" WHERE c."adProduct" IN ('SPONSORED_BRANDS','SPONSORED_DISPLAY') GROUP BY 1`],
  ['product ads',  `SELECT c."adProduct" AS prod, COUNT(*)::int AS n, COUNT(DISTINCT a.asin)::int AS distinct_asins
                    FROM "AdProductAd" a JOIN "AdGroup" g ON g.id=a."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
                    WHERE c."adProduct" IN ('SPONSORED_BRANDS','SPONSORED_DISPLAY') GROUP BY 1`],
  ['targets',      `SELECT c."adProduct" AS prod, t.kind, COUNT(*)::int AS n
                    FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
                    WHERE c."adProduct" IN ('SPONSORED_BRANDS','SPONSORED_DISPLAY') GROUP BY 1,2 ORDER BY 1,3 DESC`],
] as const) {
  console.log(`  — ${label} —`)
  try { show(await q(sql)) } catch (e: any) { console.log(`    (skipped: ${e.message.split('\n')[0]})`) }
}

await p.$disconnect(); process.exit(0)

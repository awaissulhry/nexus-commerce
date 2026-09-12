/** READ-ONLY. GX.2 — is the campaign→product shortfall an ingest HOLE (some days missing)
 *  or STRUCTURAL (every day short by a similar share)? The answer changes the design. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const q = (s: string) => prisma.$queryRawUnsafe<Record<string, unknown>[]>(s)
const show = (t: string, r: Record<string, unknown>[], w = 20) => {
  console.log(`\n== ${t} ==`)
  if (!r.length) return console.log('  (no rows)')
  const cols = Object.keys(r[0])
  console.log('  ' + cols.map(c => c.padEnd(w)).join(''))
  for (const row of r) console.log('  ' + cols.map(c => String(row[c] ?? '—').slice(0, w-1).padEnd(w)).join(''))
}
const AMS = `p."reportRunId" IS DISTINCT FROM 'ams-stream'`
show('per-DAY coverage for one campaign (GALE | IT | PAT), last 12 days with spend', await q(`
  WITH camp AS (
    SELECT p.date, SUM(p."costMicros")/1e6 AS spend
    FROM "AmazonAdsDailyPerformance" p JOIN "Campaign" c ON c.id=p."localEntityId"
    WHERE p."entityType"='CAMPAIGN' AND ${AMS} AND c.name='GALE | IT | PAT' GROUP BY 1),
  prod AS (
    SELECT p.date, SUM(p."costMicros")/1e6 AS spend
    FROM "AmazonAdsDailyPerformance" p
    JOIN "AdProductAd" a ON a.id=p."localEntityId" JOIN "AdGroup" g ON g.id=a."adGroupId"
    JOIN "Campaign" c ON c.id=g."campaignId"
    WHERE p."entityType"='PRODUCT_AD' AND ${AMS} AND c.name='GALE | IT | PAT' GROUP BY 1)
  SELECT camp.date::text AS day, ROUND(camp.spend::numeric,2)::text AS campaign,
    ROUND(COALESCE(prod.spend,0)::numeric,2)::text AS products,
    ROUND((100*COALESCE(prod.spend,0)/NULLIF(camp.spend,0))::numeric,0)::text AS pct
  FROM camp LEFT JOIN prod ON prod.date=camp.date
  WHERE camp.spend > 0 ORDER BY 1 DESC LIMIT 12`))
show('coverage by campaign TARGETING TYPE (IT, Jul–Aug)', await q(`
  WITH camp AS (
    SELECT c.id, c.name, SUM(p."costMicros")/1e6 AS spend
    FROM "AmazonAdsDailyPerformance" p JOIN "Campaign" c ON c.id=p."localEntityId"
    WHERE p."entityType"='CAMPAIGN' AND ${AMS} AND p.marketplace='IT'
      AND p.date BETWEEN '2026-07-01' AND '2026-08-25' GROUP BY 1,2),
  prod AS (
    SELECT g."campaignId" AS id, SUM(p."costMicros")/1e6 AS spend
    FROM "AmazonAdsDailyPerformance" p
    JOIN "AdProductAd" a ON a.id=p."localEntityId" JOIN "AdGroup" g ON g.id=a."adGroupId"
    WHERE p."entityType"='PRODUCT_AD' AND ${AMS} AND p.marketplace='IT'
      AND p.date BETWEEN '2026-07-01' AND '2026-08-25' GROUP BY 1)
  SELECT CASE WHEN camp.name ILIKE '%auto%' THEN 'auto' ELSE 'manual' END AS kind,
    COUNT(*)::int AS campaigns,
    ROUND(SUM(camp.spend)::numeric,2)::text AS campaign_spend,
    ROUND(SUM(COALESCE(prod.spend,0))::numeric,2)::text AS product_spend,
    ROUND((100*SUM(COALESCE(prod.spend,0))/NULLIF(SUM(camp.spend),0))::numeric,1)::text AS pct
  FROM camp LEFT JOIN prod ON prod.id=camp.id GROUP BY 1`))
await prisma.$disconnect()

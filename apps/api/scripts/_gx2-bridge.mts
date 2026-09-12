/** READ-ONLY. GX.1 — can the entity tables bridge PRODUCT_AD / AD_TARGET rows to a campaign,
 *  and how much of the spend survives the join? */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const q = (s: string) => prisma.$queryRawUnsafe<Record<string, unknown>[]>(s)
const show = (t: string, r: Record<string, unknown>[], w = 24) => {
  console.log(`\n== ${t} ==`)
  if (!r.length) return console.log('  (no rows)')
  const cols = Object.keys(r[0])
  console.log('  ' + cols.map(c => c.padEnd(w)).join(''))
  for (const row of r) console.log('  ' + cols.map(c => String(row[c] ?? '—').slice(0, w-1).padEnd(w)).join(''))
}
const W = `p.date >= '2026-07-01' AND p.date <= '2026-08-25'`
const AMS = `p."reportRunId" IS DISTINCT FROM 'ams-stream'`

show('AdProductAd columns', await q(`SELECT string_agg(column_name::text, ', ' ORDER BY ordinal_position) AS cols
  FROM information_schema.columns WHERE table_name='AdProductAd'`, 200))

show('PRODUCT_AD → campaign via AdProductAd→AdGroup', await q(`
  SELECT CASE WHEN g."campaignId" IS NULL THEN 'UNLINKED' ELSE 'linked' END AS bucket,
    COUNT(*)::int AS rows, ROUND((SUM(p."costMicros")/1e6)::numeric,2)::text AS spend
  FROM "AmazonAdsDailyPerformance" p
  LEFT JOIN "AdProductAd" a ON a.id = p."localEntityId"
  LEFT JOIN "AdGroup" g ON g.id = a."adGroupId"
  WHERE p."entityType"='PRODUCT_AD' AND ${W} AND ${AMS} AND p.marketplace='IT'
  GROUP BY 1 ORDER BY 3 DESC`))

show('AD_TARGET → campaign via AdTarget→AdGroup', await q(`
  SELECT CASE WHEN g."campaignId" IS NULL THEN 'UNLINKED' ELSE 'linked' END AS bucket,
    COUNT(*)::int AS rows, ROUND((SUM(p."costMicros")/1e6)::numeric,2)::text AS spend
  FROM "AmazonAdsDailyPerformance" p
  LEFT JOIN "AdTarget" t ON t.id = p."localEntityId"
  LEFT JOIN "AdGroup" g ON g.id = t."adGroupId"
  WHERE p."entityType"='AD_TARGET' AND ${W} AND ${AMS} AND p.marketplace='IT'
  GROUP BY 1 ORDER BY 3 DESC`))

show('per-campaign reconciliation, worst 6 by absolute gap (IT)', await q(`
  WITH camp AS (
    SELECT p."localEntityId" AS cid, SUM(p."costMicros")/1e6 AS spend
    FROM "AmazonAdsDailyPerformance" p WHERE p."entityType"='CAMPAIGN' AND ${W} AND ${AMS} AND p.marketplace='IT'
    GROUP BY 1),
  prod AS (
    SELECT g."campaignId" AS cid, SUM(p."costMicros")/1e6 AS spend
    FROM "AmazonAdsDailyPerformance" p
    JOIN "AdProductAd" a ON a.id = p."localEntityId" JOIN "AdGroup" g ON g.id = a."adGroupId"
    WHERE p."entityType"='PRODUCT_AD' AND ${W} AND ${AMS} AND p.marketplace='IT' GROUP BY 1)
  SELECT COALESCE(c.name,'(unnamed)') AS campaign,
    ROUND(camp.spend::numeric,2)::text AS campaign_spend,
    ROUND(COALESCE(prod.spend,0)::numeric,2)::text AS product_spend,
    ROUND((100*COALESCE(prod.spend,0)/NULLIF(camp.spend,0))::numeric,1)::text AS pct_covered
  FROM camp LEFT JOIN prod ON prod.cid=camp.cid LEFT JOIN "Campaign" c ON c.id=camp.cid
  WHERE camp.spend > 5 ORDER BY ABS(COALESCE(prod.spend,0)-camp.spend) DESC LIMIT 6`, 26))
await prisma.$disconnect()

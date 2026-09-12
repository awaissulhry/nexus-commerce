/** READ-ONLY. GX.0 — can a Market → Portfolio → Campaign → Product/Target tree ADD UP?
 *  A parent whose children do not sum to it is a hierarchy that lies on every expand. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const q = (s: string) => prisma.$queryRawUnsafe<Record<string, unknown>[]>(s)
const show = (t: string, r: Record<string, unknown>[], w = 22) => {
  console.log(`\n== ${t} ==`)
  if (!r.length) return console.log('  (no rows)')
  const cols = Object.keys(r[0])
  console.log('  ' + cols.map(c => c.padEnd(w)).join(''))
  for (const row of r) console.log('  ' + cols.map(c => String(row[c] ?? '—').slice(0, w-1).padEnd(w)).join(''))
}
const W = `date >= '2026-07-01' AND date <= '2026-08-25'`
const AMS = `"reportRunId" IS DISTINCT FROM 'ams-stream'`

show('grain totals over the SAME window (do they reconcile?)', await q(`
  SELECT "entityType"::text AS grain, COUNT(*)::int AS rows,
    COUNT(DISTINCT "localEntityId")::int AS entities,
    ROUND((SUM("costMicros")/1e6)::numeric,2)::text AS spend,
    ROUND((SUM(COALESCE("sales7dCents",0))/100.0)::numeric,2)::text AS sales,
    SUM(impressions)::bigint AS impressions
  FROM "AmazonAdsDailyPerformance" WHERE ${W} AND ${AMS} AND marketplace='IT'
  GROUP BY 1 ORDER BY 3 DESC`))

show('portfolio coverage on Campaign', await q(`
  SELECT CASE WHEN "portfolioId" IS NULL THEN 'no portfolio' ELSE 'has portfolio' END AS bucket,
    COUNT(*)::int AS campaigns,
    COUNT(*) FILTER (WHERE status::text='ENABLED')::int AS enabled
  FROM "Campaign" GROUP BY 1`))

show('does portfolio→campaign cover the spend? (IT, window)', await q(`
  SELECT CASE WHEN c."portfolioId" IS NULL THEN 'no portfolio' ELSE 'in a portfolio' END AS bucket,
    COUNT(DISTINCT c.id)::int AS campaigns,
    ROUND((SUM(p."costMicros")/1e6)::numeric,2)::text AS spend
  FROM "AmazonAdsDailyPerformance" p JOIN "Campaign" c ON c.id = p."localEntityId"
  WHERE p."entityType"='CAMPAIGN' AND ${W} AND p.${AMS} AND p.marketplace='IT'
  GROUP BY 1 ORDER BY 3 DESC`))

show('CAMPAIGN spend vs its PRODUCT_AD children, per campaign (worst 8)', await q(`
  WITH camp AS (
    SELECT "localEntityId" AS cid, SUM("costMicros")/1e6 AS spend
    FROM "AmazonAdsDailyPerformance" WHERE "entityType"='CAMPAIGN' AND ${W} AND ${AMS} AND marketplace='IT'
    GROUP BY 1),
  prod AS (
    SELECT "campaignLocalId" AS cid, SUM("costMicros")/1e6 AS spend
    FROM "AmazonAdsDailyPerformance" WHERE "entityType"='PRODUCT_AD' AND ${W} AND ${AMS} AND marketplace='IT'
    GROUP BY 1)
  SELECT c.name, ROUND(camp.spend::numeric,2)::text AS campaign_spend,
    ROUND(COALESCE(prod.spend,0)::numeric,2)::text AS product_spend,
    ROUND((COALESCE(prod.spend,0) - camp.spend)::numeric,2)::text AS diff
  FROM camp LEFT JOIN prod ON prod.cid = camp.cid LEFT JOIN "Campaign" c ON c.id = camp.cid
  ORDER BY ABS(COALESCE(prod.spend,0) - camp.spend) DESC LIMIT 8`, 26))
await prisma.$disconnect()

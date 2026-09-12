/** READ-ONLY. RPX.2 — purchase-share raw counts + weekly TACoS substrate (IT). */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const q = (s: string) => prisma.$queryRawUnsafe<Record<string, unknown>[]>(s)
const show = (t: string, r: Record<string, unknown>[], w = 15) => {
  console.log(`\n== ${t} ==`)
  if (!r.length) return console.log('  (no rows)')
  const cols = Object.keys(r[0])
  console.log('  ' + cols.map(c => c.padEnd(w)).join(''))
  for (const row of r) console.log('  ' + cols.map(c => String(row[c] ?? '—').slice(0, w-1).padEnd(w)).join(''))
}
show('SQP IT — raw funnel counts by week', await q(`
  SELECT "startDate"::text AS week, COUNT(*)::int AS rows,
    SUM("impressionsBrand")::int AS imp_b, SUM("clicksBrand")::int AS clk_b,
    SUM("cartAddsBrand")::int AS cart_b, SUM("purchasesBrand")::int AS buy_b,
    SUM("purchasesTotal")::int AS buy_mkt
  FROM "SearchQueryPerformance" WHERE marketplace='IT' AND asin IS NOT NULL
  GROUP BY 1 ORDER BY 1 DESC LIMIT 8`))
show('IT weekly — ad spend / ad sales / total sales', await q(`
  WITH ad AS (
    SELECT DATE_TRUNC('week', date)::date AS wk,
      SUM("costMicros")/1e6 AS spend, SUM("sales7dCents")/100.0 AS ad_sales
    FROM "AmazonAdsDailyPerformance"
    WHERE "entityType"='CAMPAIGN' AND marketplace='IT' AND "profileId" IS DISTINCT FROM 'ams'
      AND date >= '2026-06-15' GROUP BY 1),
  tot AS (
    SELECT DATE_TRUNC('week', day)::date AS wk, SUM("grossRevenue") AS total
    FROM "DailySalesAggregate" WHERE marketplace='IT' AND channel='AMAZON' AND day >= '2026-06-15' GROUP BY 1)
  SELECT COALESCE(ad.wk, tot.wk)::text AS week,
    ROUND(ad.spend::numeric,2)::text AS spend,
    ROUND(ad.ad_sales::numeric,2)::text AS ad_sales,
    ROUND(tot.total::numeric,2)::text AS total_sales,
    ROUND((ad.spend / NULLIF(tot.total,0) * 100)::numeric,2)::text AS tacos_pct,
    ROUND((ad.ad_sales / NULLIF(tot.total,0) * 100)::numeric,1)::text AS ad_share_pct
  FROM ad FULL OUTER JOIN tot ON ad.wk = tot.wk ORDER BY 1`))
show('spend by ad product, last 30d, all markets', await q(`
  SELECT c.type::text AS ad_product, COUNT(DISTINCT c.id)::int AS campaigns,
    ROUND((SUM(p."costMicros")/1e6)::numeric,2)::text AS spend_eur
  FROM "AmazonAdsDailyPerformance" p JOIN "Campaign" c ON c.id = p."localEntityId"
  WHERE p."entityType"='CAMPAIGN' AND p.date >= CURRENT_DATE - 30 AND p."profileId" IS DISTINCT FROM 'ams'
  GROUP BY 1 ORDER BY 3 DESC`))
await prisma.$disconnect()

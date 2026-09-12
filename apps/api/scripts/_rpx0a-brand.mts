/** READ-ONLY. RPX.0a — can a brand/strategy dashboard be sourced honestly? Brand Metrics truth. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const q = (s: string) => prisma.$queryRawUnsafe<Record<string, unknown>[]>(s)
const show = (t: string, r: Record<string, unknown>[]) => {
  console.log(`\n== ${t} ==`)
  if (!r.length) return console.log('  (no rows)')
  const cols = Object.keys(r[0])
  console.log('  ' + cols.map(c => c.padEnd(22)).join(''))
  for (const row of r) console.log('  ' + cols.map(c => String(row[c] ?? '—').slice(0,21).padEnd(22)).join(''))
}

show('AmazonAdsBrandBuildingMetric — per market', await q(`
  SELECT marketplace, COUNT(*)::int AS rows, COUNT(DISTINCT "brandName")::int AS brands,
         COUNT(DISTINCT "categoryNodeName")::int AS nodes,
         MIN("computationDate")::text AS first_week, MAX("computationDate")::text AS last_week,
         COUNT(DISTINCT "computationDate")::int AS weeks,
         (CURRENT_DATE - MAX("computationDate"))::int AS lag_days
  FROM "AmazonAdsBrandBuildingMetric" GROUP BY 1 ORDER BY 2 DESC`))

show('promoted-column fill rate (all rows)', await q(`
  SELECT COUNT(*)::int AS rows,
    COUNT("awarenessIndex")::int AS awareness, COUNT("considerationIndex")::int AS consideration,
    COUNT("salesIndex")::int AS sales_idx, COUNT("brandCustomers")::int AS brand_cust,
    COUNT("highValueCustomers")::int AS hi_val, COUNT("addToCarts")::int AS carts,
    COUNT("newToBrandCustomerRate")::int AS ntb_rate, COUNT("customerConversionRate")::int AS cvr
  FROM "AmazonAdsBrandBuildingMetric"`))

show('distinct metric keys in the jsonb (top 60)', await q(`
  SELECT k AS metric_key, COUNT(*)::int AS rows_with_it
  FROM "AmazonAdsBrandBuildingMetric", LATERAL jsonb_object_keys(metrics) k
  GROUP BY 1 ORDER BY 1 LIMIT 60`))

show('legacy AmazonAdsBrandMetric', await q(`
  SELECT marketplace, COUNT(*)::int AS rows, MIN(date)::text AS first, MAX(date)::text AS last,
         COUNT("searchImpressionShare")::int AS sis, COUNT("brandSearches")::int AS searches,
         COUNT("categoryRank")::int AS cat_rank
  FROM "AmazonAdsBrandMetric" GROUP BY 1 ORDER BY 2 DESC`))
await prisma.$disconnect()

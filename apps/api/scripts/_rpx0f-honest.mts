/** READ-ONLY. RPX.0f — shown vs honest for the brand-metrics counts, window 2026-07-28..08-26. */
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
const W = `"computationDate" BETWEEN '2026-07-28' AND '2026-08-26'`
show('shown (sum over every node) vs honest (root node only)', await q(`
  WITH root AS (
    SELECT DISTINCT ON (marketplace, "computationDate") marketplace, "computationDate",
      "brandCustomers", "addToCarts", "highValueCustomers", "viewedDetailPageOnly"
    FROM "AmazonAdsBrandBuildingMetric" WHERE ${W}
    ORDER BY marketplace, "computationDate", LENGTH("categoryNodeName") ASC
  )
  SELECT
    (SELECT SUM("brandCustomers")::int FROM "AmazonAdsBrandBuildingMetric" WHERE ${W}) AS cust_shown,
    (SELECT SUM("brandCustomers")::int FROM root) AS cust_honest,
    (SELECT SUM("addToCarts")::int FROM "AmazonAdsBrandBuildingMetric" WHERE ${W}) AS carts_shown,
    (SELECT SUM("addToCarts")::int FROM root) AS carts_honest,
    (SELECT SUM("viewedDetailPageOnly")::int FROM "AmazonAdsBrandBuildingMetric" WHERE ${W}) AS dpv_shown,
    (SELECT SUM("viewedDetailPageOnly")::int FROM root) AS dpv_honest`))
show('benchmark-trio coverage — how many of the 13 have any data', await q(`
  SELECT k AS metric_key, COUNT(*)::int AS rows
  FROM "AmazonAdsBrandBuildingMetric", LATERAL jsonb_object_keys(metrics) k
  WHERE k LIKE '%CategoryMedian%' GROUP BY 1 ORDER BY 2 DESC`, 46))
show('engagement band + NTB, newest week per market (root node)', await q(`
  SELECT DISTINCT ON (marketplace) marketplace, "computationDate"::text AS week,
    (metrics->>'engagedShopperRateLowerBound') AS eng_low,
    (metrics->>'engagedShopperRateUpperBound') AS eng_high,
    (metrics->>'engagedShopperRateCategoryMedian') AS eng_median,
    ROUND("newToBrandCustomerRate"::numeric,4)::text AS ntb_rate,
    ROUND("customerConversionRate"::numeric,4)::text AS cvr
  FROM "AmazonAdsBrandBuildingMetric" WHERE ${W}
  ORDER BY marketplace, "computationDate" DESC, LENGTH("categoryNodeName") ASC`, 16))
await prisma.$disconnect()

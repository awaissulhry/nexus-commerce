/** READ-ONLY. RPX.1 — real series for the design mockups. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const q = (s: string) => prisma.$queryRawUnsafe<Record<string, unknown>[]>(s)
const show = (t: string, r: Record<string, unknown>[], w = 17) => {
  console.log(`\n== ${t} ==`)
  if (!r.length) return console.log('  (no rows)')
  const cols = Object.keys(r[0])
  console.log('  ' + cols.map(c => c.padEnd(w)).join(''))
  for (const row of r) console.log('  ' + cols.map(c => String(row[c] ?? '—').slice(0, w-1).padEnd(w)).join(''))
}

show('IT root node — all 9 weeks', await q(`
  SELECT DISTINCT ON ("computationDate") "computationDate"::text AS week,
    "brandCustomers"::int AS cust, "addToCarts"::int AS carts,
    "viewedDetailPageOnly"::int AS dpv,
    ROUND("awarenessIndex"::numeric,4)::text AS awareness,
    ROUND("salesIndex"::numeric,4)::text AS sales_idx
  FROM "AmazonAdsBrandBuildingMetric" WHERE marketplace='IT'
  ORDER BY "computationDate", LENGTH("categoryNodeName") ASC`))

show('SQP IT — market funnel by week (last 6)', await q(`
  SELECT "startDate"::text AS week, COUNT(*)::int AS rows,
    SUM("impressionsBrand")::int AS imp_ours, SUM("impressionsTotal")::int AS imp_mkt,
    ROUND((SUM("impressionsBrand")::numeric / NULLIF(SUM("impressionsTotal"),0) * 100),2)::text AS imp_share,
    ROUND((SUM("clicksBrand")::numeric / NULLIF(SUM("clicksTotal"),0) * 100),2)::text AS click_share,
    ROUND((SUM("cartAddsBrand")::numeric / NULLIF(SUM("cartAddsTotal"),0) * 100),2)::text AS cart_share,
    ROUND((SUM("purchasesBrand")::numeric / NULLIF(SUM("purchasesTotal"),0) * 100),2)::text AS buy_share
  FROM "SearchQueryPerformance" WHERE marketplace='IT' AND asin IS NOT NULL
  GROUP BY 1 ORDER BY 1 DESC LIMIT 6`))

show('SQP IT — top queries by market volume, newest week', await q(`
  SELECT "searchQuery" AS query, SUM("impressionsTotal")::int AS mkt_imp,
    SUM("impressionsBrand")::int AS our_imp,
    ROUND((SUM("impressionsBrand")::numeric / NULLIF(SUM("impressionsTotal"),0) * 100),2)::text AS imp_share,
    ROUND((SUM("purchasesBrand")::numeric / NULLIF(SUM("purchasesTotal"),0) * 100),2)::text AS buy_share,
    SUM("purchasesTotal")::int AS mkt_buys
  FROM "SearchQueryPerformance"
  WHERE marketplace='IT' AND asin IS NOT NULL AND "startDate"=(SELECT MAX("startDate") FROM "SearchQueryPerformance" WHERE marketplace='IT')
  GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, 30))
await prisma.$disconnect()

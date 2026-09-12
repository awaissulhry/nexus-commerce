import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const r = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT DISTINCT ON (marketplace) marketplace AS mkt, "computationDate"::text AS wk,
    "categoryNodeName" AS node,
    ROUND("awarenessIndex"::numeric,4)::text AS aw, ROUND("considerationIndex"::numeric,4)::text AS co,
    ROUND("salesIndex"::numeric,4)::text AS sa,
    "viewedDetailPageOnly"::int AS dpv, (metrics->>'viewedDetailPageCategoryMedian') AS dpv_med,
    "addToCarts"::int AS carts, (metrics->>'addToCartsCategoryMedian') AS carts_med,
    "brandCustomers"::int AS cust, (metrics->>'brandCustomersCategoryMedian') AS cust_med,
    (metrics->>'customerConversionRate') AS cvr, (metrics->>'customerConversionRateCategoryMedian') AS cvr_med
  FROM "AmazonAdsBrandBuildingMetric" WHERE "computationDate"='2026-08-15'
  ORDER BY marketplace, LENGTH("categoryNodeName") ASC`)
for (const x of r) console.log(JSON.stringify(x))
await prisma.$disconnect()

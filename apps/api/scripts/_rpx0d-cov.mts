/** READ-ONLY. RPX.0d — coverage + freshness of the total-sales substrate, ad mix, NTB, hourly. */
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
show('AmazonEconomicsDaily', await q(`
  SELECT marketplace, COUNT(*)::int AS rows, COUNT(DISTINCT "childAsin")::int AS asins,
   MIN(date)::text AS first, MAX(date)::text AS last, (CURRENT_DATE-MAX(date))::int AS lag,
   COUNT(*) FILTER (WHERE "costOfGoodsSold" IS NOT NULL AND "costOfGoodsSold" <> 0)::int AS with_cogs,
   ROUND(SUM("netProductSales")::numeric,0)::text AS net_sales
  FROM "AmazonEconomicsDaily" GROUP BY 1 ORDER BY 2 DESC`))
show('DailySalesAggregate', await q(`
  SELECT marketplace, channel, COUNT(*)::int AS rows, MIN(day)::text AS first, MAX(day)::text AS last,
   (CURRENT_DATE-MAX(day))::int AS lag, COUNT(sessions)::int AS with_sessions,
   COUNT("buyBoxPct")::int AS with_bb, ROUND(SUM("grossRevenue")::numeric,0)::text AS revenue
  FROM "DailySalesAggregate" GROUP BY 1,2 ORDER BY 3 DESC LIMIT 12`))
show('Orders per market (last 90d)', await q(`
  SELECT marketplace, COUNT(*)::int AS orders, MIN("purchaseDate")::text AS first,
   MAX("purchaseDate")::text AS last, ROUND(SUM("totalPrice")::numeric,0)::text AS gross
  FROM "Order" WHERE "purchaseDate" > CURRENT_DATE - 90 AND "deletedAt" IS NULL
  GROUP BY 1 ORDER BY 2 DESC LIMIT 10`))
show('Ad product mix — campaigns', await q(`
  SELECT type::text AS type, status::text AS status, marketplace, COUNT(*)::int AS n
  FROM "Campaign" GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 20`))
show('daily perf rows by entityType / adProduct proxy', await q(`
  SELECT "entityType"::text AS grain, marketplace, COUNT(*)::int AS rows,
   MIN(date)::text AS first, MAX(date)::text AS last, (CURRENT_DATE-MAX(date))::int AS lag
  FROM "AmazonAdsDailyPerformance" WHERE "profileId" IS DISTINCT FROM 'ams'
  GROUP BY 1,2 ORDER BY 3 DESC LIMIT 20`))
show('NTB columns on daily perf', await q(`
  SELECT COUNT(*)::int AS rows, COUNT("ntbOrders14d")::int AS ntb_orders_nonnull,
   COUNT(*) FILTER (WHERE "ntbOrders14d" > 0)::int AS ntb_orders_pos,
   COUNT("ntbUnits14d")::int AS ntb_units_nonnull, COUNT("ntbOrdersRate14d")::int AS ntb_rate_nonnull
  FROM "AmazonAdsDailyPerformance"`))
show('AMS hourly freshness', await q(`
  SELECT marketplace, COUNT(*)::int AS rows, MAX(date)::text AS last,
   (CURRENT_DATE-MAX(date))::int AS lag FROM "AmazonAdsHourlyPerformance" GROUP BY 1 ORDER BY 2 DESC`))
await prisma.$disconnect()

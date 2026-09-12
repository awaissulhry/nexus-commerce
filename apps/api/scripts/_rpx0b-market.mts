/** READ-ONLY. RPX.0b — SQP / market-share + total-sales context feasibility. */
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
show('SearchQueryPerformance coverage', await q(`
  SELECT marketplace, COUNT(*)::int AS rows, COUNT(DISTINCT asin)::int AS asins,
    COUNT(DISTINCT "searchQuery")::int AS queries, MIN("startDate")::text AS first,
    MAX("startDate")::text AS last, COUNT(DISTINCT "startDate")::int AS weeks,
    (CURRENT_DATE - MAX("startDate"))::int AS lag_days
  FROM "SearchQueryPerformance" GROUP BY 1 ORDER BY 2 DESC`))
show('SQP columns present', await q(`
  SELECT column_name::text AS col, data_type::text AS typ FROM information_schema.columns
  WHERE table_name='SearchQueryPerformance' ORDER BY ordinal_position`, 34))
show('AmazonEconomicsDaily', await q(`
  SELECT marketplace, COUNT(*)::int AS rows, MIN(date)::text AS first, MAX(date)::text AS last,
    (CURRENT_DATE - MAX(date))::int AS lag_days, COUNT(DISTINCT asin)::int AS asins
  FROM "AmazonEconomicsDaily" GROUP BY 1 ORDER BY 2 DESC`))
show('DailySalesAggregate', await q(`
  SELECT column_name::text AS col, data_type::text AS typ FROM information_schema.columns
  WHERE table_name='DailySalesAggregate' ORDER BY ordinal_position`, 34))
await prisma.$disconnect()

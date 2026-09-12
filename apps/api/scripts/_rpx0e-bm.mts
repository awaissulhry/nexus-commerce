/** READ-ONLY. RPX.0e — does the brand-metrics total double-count across category nodes? */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const q = (s: string) => prisma.$queryRawUnsafe<Record<string, unknown>[]>(s)
const show = (t: string, r: Record<string, unknown>[], w = 26) => {
  console.log(`\n== ${t} ==`)
  if (!r.length) return console.log('  (no rows)')
  const cols = Object.keys(r[0])
  console.log('  ' + cols.map(c => c.padEnd(w)).join(''))
  for (const row of r) console.log('  ' + cols.map(c => String(row[c] ?? '—').slice(0, w-1).padEnd(w)).join(''))
}
const W = `"computationDate" BETWEEN '2026-07-28' AND '2026-08-26'`
show('rows in the window (what the grid sums)', await q(`
  SELECT marketplace, "computationDate"::text AS week, COUNT(*)::int AS nodes,
    SUM("brandCustomers")::int AS sum_over_nodes, MAX("brandCustomers")::int AS root_or_max,
    MIN("brandCustomers")::int AS min_node
  FROM "AmazonAdsBrandBuildingMetric" WHERE ${W} GROUP BY 1,2 ORDER BY 1,2`))
show('the whole-window totals row', await q(`
  SELECT COUNT(*)::int AS rows, SUM("brandCustomers")::int AS grid_total,
    ROUND(AVG("awarenessIndex")::numeric,4)::text AS avg_awareness
  FROM "AmazonAdsBrandBuildingMetric" WHERE ${W}`))
show('node list for IT, newest week', await q(`
  SELECT "categoryNodeName" AS node, "brandCustomers"::int AS cust, "addToCarts"::int AS carts,
    ROUND("awarenessIndex"::numeric,4)::text AS awareness
  FROM "AmazonAdsBrandBuildingMetric"
  WHERE marketplace='IT' AND "computationDate"='2026-08-15' ORDER BY 2 DESC NULLS LAST`, 44))
await prisma.$disconnect()

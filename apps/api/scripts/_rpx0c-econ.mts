/** READ-ONLY. RPX.0c — total-sales context (TACoS / ad-vs-organic) feasibility. */
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
for (const t of ['AmazonEconomicsDaily','DailySalesAggregate','Order']) {
  show(`${t} columns`, await q(`SELECT column_name::text AS col, data_type::text AS typ
    FROM information_schema.columns WHERE table_name='${t}' ORDER BY ordinal_position`), 30)
}
await prisma.$disconnect()

import prisma from '../src/db.js'
const cols = await prisma.$queryRawUnsafe<any[]>(`SELECT column_name::text AS column_name FROM information_schema.columns WHERE table_name='AmazonAdsDailyPerformance' AND (column_name ILIKE '%ntb%' OR column_name ILIKE '%newToBrand%' OR column_name ILIKE '%viewable%') ORDER BY 1`)
console.log('NTB/viewable columns:', cols.map(c=>c.column_name).join(', ') || '(none)')
for (const c of cols) {
  const r = await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*)::int rows, COUNT("${c.column_name}")::int nonnull, SUM(CASE WHEN "${c.column_name}">0 THEN 1 ELSE 0 END)::int pos FROM "AmazonAdsDailyPerformance" WHERE "entityType"='CAMPAIGN'`)
  console.log(`  ${String(c.column_name).padEnd(28)} rows=${r[0].rows} nonNull=${r[0].nonnull} >0=${r[0].pos}`)
}
const ap = await prisma.$queryRawUnsafe<any[]>(`SELECT "adProduct", COUNT(*)::int n FROM "AmazonAdsDailyPerformance" WHERE "entityType"='CAMPAIGN' GROUP BY 1 ORDER BY 2 DESC`)
console.log('\nreport rows by adProduct:', ap.map(r=>`${r.adProduct}=${r.n}`).join('  '))
await prisma.$disconnect()

/** ADM.4 — topOfSearchIS: it had data during the ADM-H audit (65 of 83). Where did it go? */
import prisma from '../src/db.js'
console.log('=== topOfSearchIS by month (CAMPAIGN rows) ===')
const m = await prisma.$queryRawUnsafe<any[]>(`
  SELECT to_char(date,'YYYY-MM') AS mo, COUNT(*)::int AS rows,
         COUNT("topOfSearchIS")::int AS nonnull,
         COUNT(*) FILTER (WHERE "topOfSearchIS" > 0)::int AS positive
  FROM "AmazonAdsDailyPerformance" WHERE "entityType"='CAMPAIGN'
  GROUP BY 1 ORDER BY 1 DESC LIMIT 8`)
for (const r of m) console.log(`  ${r.mo}  rows=${String(r.rows).padStart(6)} nonNull=${String(r.nonnull).padStart(6)} >0=${String(r.positive).padStart(6)}`)

console.log('\n=== last date topOfSearchIS was non-null ===')
const l = await prisma.$queryRawUnsafe<any[]>(`SELECT MAX(date) AS last FROM "AmazonAdsDailyPerformance" WHERE "topOfSearchIS" IS NOT NULL`)
console.log('  ', l[0]?.last)

console.log('\n=== which reportRunId / report types carried it? ===')
const r = await prisma.$queryRawUnsafe<any[]>(`
  SELECT "entityType", COUNT(*)::int rows, COUNT("topOfSearchIS")::int nonnull
  FROM "AmazonAdsDailyPerformance" GROUP BY 1 ORDER BY 2 DESC`)
for (const x of r) console.log(`  ${String(x.entityType).padEnd(14)} rows=${String(x.rows).padStart(7)} tosNonNull=${x.nonnull}`)
await prisma.$disconnect()

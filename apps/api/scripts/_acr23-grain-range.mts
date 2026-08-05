/** ACR.2.3 — what is the AD_TARGET grain's REAL date range? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const r = await prisma.$queryRawUnsafe<{ days: bigint; first: Date; last: Date; rows: bigint }[]>(`
  SELECT COUNT(DISTINCT date) AS days, MIN(date) AS first, MAX(date) AS last, COUNT(*) AS rows
  FROM "AmazonAdsDailyPerformance" WHERE "entityType" = 'AD_TARGET'`)
const a = r[0]!
console.log(`\nAD_TARGET grain, all time: ${a.days} distinct days · ${a.rows} rows`)
console.log(`  ${String(a.first).slice(0, 10)} → ${String(a.last).slice(0, 10)}`)

const w = await prisma.$queryRawUnsafe<{ days: bigint; first: Date }[]>(`
  SELECT COUNT(DISTINCT date) AS days, MIN(date) AS first
  FROM "AmazonAdsDailyPerformance"
  WHERE "entityType" = 'AD_TARGET' AND date > now() - interval '30 days'`)
console.log(`  within the board's 30d window: ${w[0]?.days} days, earliest ${String(w[0]?.first).slice(0, 10)}`)
console.log(`\n  The board's note claims "the grain began accumulating on 2026-07-28".`)
console.log(`  If that were true the window could show at most ~9 days, not ${w[0]?.days}.`)
await prisma.$disconnect()

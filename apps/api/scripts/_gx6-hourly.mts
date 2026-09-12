import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const r = await prisma.$queryRawUnsafe<Record<string,unknown>[]>(`
  SELECT marketplace, COUNT(*)::int AS rows, COUNT(DISTINCT "entityId")::int AS campaigns,
    COUNT(DISTINCT date)::int AS days, MIN(date)::text AS first, MAX(date)::text AS last,
    COUNT(DISTINCT hour)::int AS hours,
    ROUND((SUM("costMicros")/1e6)::numeric,2)::text AS spend
  FROM "AmazonAdsHourlyPerformance" GROUP BY 1 ORDER BY 2 DESC`)
for (const x of r) console.log(`  ${x.marketplace}  rows ${String(x.rows).padStart(6)}  campaigns ${String(x.campaigns).padStart(4)}  days ${String(x.days).padStart(3)} (${x.first}→${x.last})  hours ${x.hours}  €${x.spend}`)
await prisma.$disconnect()

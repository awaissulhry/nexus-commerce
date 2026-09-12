/** READ-ONLY — are the ES whole-day "gaps" real, or is ES simply not running? */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const q = (s: string) => prisma.$queryRawUnsafe<Record<string,unknown>[]>(s)
const r = await q(`
  SELECT marketplace, MAX(date)::text AS last_row,
    MAX(date) FILTER (WHERE "costMicros" > 0)::text AS last_spend_day,
    (CURRENT_DATE - MAX(date) FILTER (WHERE "costMicros" > 0))::int AS days_since_spend
  FROM "AmazonAdsDailyPerformance"
  WHERE "entityType"='CAMPAIGN' AND "reportRunId" IS DISTINCT FROM 'ams-stream'
  GROUP BY 1 ORDER BY 1`)
console.log('last CAMPAIGN row / last day with spend, per market:')
for (const x of r) console.log(`  ${x.marketplace}  last row ${x.last_row}  last spend ${x.last_spend_day}  (${x.days_since_spend}d ago)`)
const e = await q(`
  SELECT status::text AS status, COUNT(*)::int AS n FROM "Campaign"
  WHERE marketplace='ES' GROUP BY 1 ORDER BY 2 DESC`)
console.log('\nES campaigns by status:', e.map(x=>`${x.status} ${x.n}`).join(' · '))
const h = await q(`
  SELECT MAX(date)::text AS last_hour_day FROM "AmazonAdsHourlyPerformance" WHERE marketplace='ES'`)
console.log('ES last hourly-stream day:', h[0]?.last_hour_day)
await prisma.$disconnect()

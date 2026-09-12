/** READ-ONLY. How far does the AMS-duplicate blast radius actually reach? */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const q = (s: string) => prisma.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show = (t: string, r: Record<string,unknown>[], w=20) => {
  console.log(`\n== ${t} ==`)
  if (!r.length) return console.log('  (none)')
  const c = Object.keys(r[0]); console.log('  ' + c.map(x=>x.padEnd(w)).join(''))
  for (const row of r) console.log('  ' + c.map(x=>String(row[x] ?? '—').slice(0,w-1).padEnd(w)).join(''))
}
show('the AMS rows — exactly what they are', await q(`
  SELECT marketplace, "entityType"::text AS grain, COUNT(*)::int AS rows,
    MIN(date)::text AS first, MAX(date)::text AS last,
    (CURRENT_DATE - MAX(date))::int AS days_ago,
    ROUND((SUM("costMicros")/1e6)::numeric,2)::text AS spend
  FROM "AmazonAdsDailyPerformance" WHERE "reportRunId" = 'ams-stream' GROUP BY 1,2`))
show('inflation by lookback window, IT campaign grain', await q(`
  SELECT w AS window_days,
    ROUND((SUM("costMicros")/1e6)::numeric,2)::text AS unguarded,
    ROUND((SUM("costMicros") FILTER (WHERE "reportRunId" IS DISTINCT FROM 'ams-stream')/1e6)::numeric,2)::text AS guarded,
    ROUND((100.0*SUM("costMicros") FILTER (WHERE "reportRunId"='ams-stream')/NULLIF(SUM("costMicros"),0))::numeric,1)::text AS pct_fake
  FROM (VALUES (7),(14),(30),(60),(90),(180)) v(w)
  JOIN "AmazonAdsDailyPerformance" ON "entityType"='CAMPAIGN' AND marketplace='IT' AND date >= CURRENT_DATE - v.w
  GROUP BY 1 ORDER BY 1`))
await prisma.$disconnect()

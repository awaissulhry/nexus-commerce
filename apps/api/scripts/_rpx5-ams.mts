/** READ-ONLY. RPX — does business-context's missing AMS guard move TACoS, and is the
 *  Prisma `not:` form dropping NULL reportRunId rows? */
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
show('CAMPAIGN rows by reportRunId nullness', await q(`
  SELECT CASE WHEN "reportRunId" IS NULL THEN 'null'
              WHEN "reportRunId" = 'ams-stream' THEN 'ams-stream'
              ELSE 'real run id' END AS kind,
    COUNT(*)::int AS rows, MIN(date)::text AS first, MAX(date)::text AS last
  FROM "AmazonAdsDailyPerformance" WHERE "entityType"='CAMPAIGN' GROUP BY 1 ORDER BY 2 DESC`))
show('ALL entityTypes by reportRunId nullness', await q(`
  SELECT "entityType"::text AS grain,
    COUNT(*) FILTER (WHERE "reportRunId" IS NULL)::int AS null_run,
    COUNT(*) FILTER (WHERE "reportRunId" = 'ams-stream')::int AS ams,
    COUNT(*) FILTER (WHERE "reportRunId" IS NOT NULL AND "reportRunId" <> 'ams-stream')::int AS real_run
  FROM "AmazonAdsDailyPerformance" GROUP BY 1`))
show('business-context spend/sales, with and without the AMS rows (last 90d)', await q(`
  SELECT marketplace,
    ROUND((SUM("costMicros")/1e6)::numeric,2)::text AS spend_now,
    ROUND((SUM("costMicros") FILTER (WHERE "reportRunId" IS DISTINCT FROM 'ams-stream')/1e6)::numeric,2)::text AS spend_guarded,
    ROUND((SUM(COALESCE("sales7dCents",0))/100.0)::numeric,2)::text AS sales_now,
    ROUND((SUM(COALESCE("sales7dCents",0)) FILTER (WHERE "reportRunId" IS DISTINCT FROM 'ams-stream')/100.0)::numeric,2)::text AS sales_guarded
  FROM "AmazonAdsDailyPerformance"
  WHERE "entityType"='CAMPAIGN' AND date >= CURRENT_DATE - 90
  GROUP BY 1 ORDER BY 2 DESC`, 16))
show('same, over the full table', await q(`
  SELECT ROUND((SUM("costMicros")/1e6)::numeric,2)::text AS spend_now,
    ROUND((SUM("costMicros") FILTER (WHERE "reportRunId" IS DISTINCT FROM 'ams-stream')/1e6)::numeric,2)::text AS spend_guarded
  FROM "AmazonAdsDailyPerformance" WHERE "entityType"='CAMPAIGN'`, 16))
await prisma.$disconnect()

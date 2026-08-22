const { default: prisma } = await import('../src/db.js')
const q = <T,>(s: string) => prisma.$queryRawUnsafe<T[]>(s)
const j = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === 'bigint' ? Number(v) : String(v))
const t = (rows: Array<Record<string, unknown>>) => rows.forEach(r => console.log('   ' + Object.entries(r).map(([k, v]) => `${k}=${j(v)}`).join('  ')))
console.log('=== who uses the 14d window? adProduct × cutoff ===')
t(await q(`SELECT "adProduct", ("reportedAt" < TIMESTAMP '2026-08-20 00:00:00') AS before_cutoff,
     COUNT(*)::bigint AS rows,
     COUNT("sales14dCents")::bigint AS s14_notnull,
     COUNT(*) FILTER (WHERE "sales14dCents" > 0)::bigint AS s14_positive,
     COALESCE(SUM("sales14dCents"),0)::bigint AS s14_sum
   FROM "AmazonAdsDailyPerformance" GROUP BY 1,2 ORDER BY 1,2`))
console.log('\n=== post-cutoff SB/SD rows: do they carry REAL 14d values? ===')
t(await q(`SELECT "adProduct", COUNT(*)::bigint AS rows, COUNT(DISTINCT "sales14dCents")::bigint AS distinct_vals,
     MAX("sales14dCents")::bigint AS max_val
   FROM "AmazonAdsDailyPerformance"
   WHERE "reportedAt" >= TIMESTAMP '2026-08-20 00:00:00' GROUP BY 1 ORDER BY 1`))
console.log('\n=== entityType breakdown of the 46,204 nulled rows ===')
t(await q(`SELECT "entityType", "adProduct", COUNT(*)::bigint AS rows, MIN("date")::text AS first_day, MAX("date")::text AS last_day
   FROM "AmazonAdsDailyPerformance" WHERE "reportedAt" < TIMESTAMP '2026-08-20 00:00:00' GROUP BY 1,2 ORDER BY 3 DESC`))
console.log('\n=== sanity: does sales7dCents still hold everything it did? ===')
t(await q(`SELECT COUNT(*)::bigint AS rows, COUNT("sales7dCents")::bigint AS s7_notnull,
     COUNT(*) FILTER (WHERE "sales7dCents" > 0)::bigint AS s7_positive, COALESCE(SUM("sales7dCents"),0)::bigint AS s7_sum
   FROM "AmazonAdsDailyPerformance" WHERE "reportedAt" < TIMESTAMP '2026-08-20 00:00:00'`))
await prisma.$disconnect()

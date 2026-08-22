const { default: prisma } = await import('../src/db.js')
const q = <T,>(s: string) => prisma.$queryRawUnsafe<T[]>(s)
const j = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === 'bigint' ? Number(v) : String(v))
const t = (rows: Array<Record<string, unknown>>) => rows.forEach(r => console.log('   ' + Object.entries(r).map(([k, v]) => `${k}=${j(v)}`).join('  ')))
console.log('=== AmazonAdsDailyPerformance legacy window columns, NOW ===')
t(await q(`SELECT COUNT(*)::bigint AS rows,
    COUNT("sales1dCents")::bigint AS s1_notnull, COUNT("sales14dCents")::bigint AS s14_notnull, COUNT("sales30dCents")::bigint AS s30_notnull,
    COUNT(*) FILTER (WHERE "sales14dCents" = 0)::bigint AS s14_zero,
    COUNT(DISTINCT "sales14dCents")::bigint AS s14_distinct,
    COUNT(DISTINCT "sales7dCents")::bigint AS s7_distinct
  FROM "AmazonAdsDailyPerformance"`))
console.log('\n=== split by reportedAt vs the migration cutoff ===')
t(await q(`SELECT ("reportedAt" < TIMESTAMP '2026-08-20 00:00:00') AS before_cutoff, COUNT(*)::bigint AS rows,
    COUNT("sales14dCents")::bigint AS s14_notnull, COUNT(*) FILTER (WHERE "sales14dCents"=0)::bigint AS s14_zero
  FROM "AmazonAdsDailyPerformance" GROUP BY 1 ORDER BY 1`))
console.log('\n=== was anything NON-zero destroyed? (rows now NULL that could have held a value) ===')
t(await q(`SELECT COUNT(*)::bigint AS nulled_rows FROM "AmazonAdsDailyPerformance"
  WHERE "reportedAt" < TIMESTAMP '2026-08-20 00:00:00' AND "sales14dCents" IS NULL`))
console.log('\n=== _prisma_migrations tail ===')
t(await q(`SELECT migration_name, started_at, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at DESC LIMIT 6`))
await prisma.$disconnect()

const { default: prisma } = await import('../src/db.js')
const q = <T,>(s: string) => prisma.$queryRawUnsafe<T[]>(s)
const j = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === 'bigint' ? Number(v) : String(v))
const t = (rows: Array<Record<string, unknown>>) => rows.forEach(r => console.log('   ' + Object.entries(r).map(([k, v]) => `${k}=${j(v)}`).join('  ')))
console.log('now', new Date().toISOString())
console.log('\n=== budget-usage-sample cron runs on PROD ===')
const runs = await prisma.cronRun.findMany({ where: { jobName: 'budget-usage-sample' }, orderBy: { startedAt: 'desc' }, take: 8, select: { startedAt: true, status: true, outputSummary: true, errorMessage: true, triggeredBy: true } })
if (!runs.length) console.log('   (no runs yet)')
for (const r of runs) console.log(`   ${r.startedAt.toISOString()} ${String(r.status).padEnd(8)} by=${r.triggeredBy ?? '?'} ${r.errorMessage ? 'ERR ' + r.errorMessage.slice(0, 80) : (r.outputSummary ?? '')}`)
console.log('\n=== the table is filling ===')
t(await q(`SELECT COUNT(*)::bigint AS rows, COUNT(DISTINCT "campaignId")::bigint AS campaigns,
   MIN("firstSeenAt") AS sampling_since, MAX("lastSeenAt") AS last_seen,
   COUNT(*) FILTER (WHERE "percent" >= 100)::bigint AS at_or_over_100,
   COUNT(*) FILTER (WHERE "percent" >= 95 AND "percent" < 100)::bigint AS warning
 FROM "AdBudgetUsageSample"`))
console.log('\n=== span growth: is lastSeenAt moving past firstSeenAt? (proves the refresh path) ===')
t(await q(`SELECT COUNT(*)::bigint AS rows,
   COUNT(*) FILTER (WHERE "lastSeenAt" > "firstSeenAt")::bigint AS spans_extended,
   ROUND(MAX(EXTRACT(EPOCH FROM ("lastSeenAt" - "firstSeenAt")))/60)::int AS longest_span_min
 FROM "AdBudgetUsageSample"`))
await prisma.$disconnect()

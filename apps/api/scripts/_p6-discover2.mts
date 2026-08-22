const { default: prisma } = await import('../src/db.js')
const runs = await prisma.cronRun.findMany({
  where: { jobName: 'ams-sqs-poll' }, orderBy: { startedAt: 'desc' }, take: 6,
  select: { startedAt: true, status: true, outputSummary: true, errorMessage: true },
})
console.log('== ams-sqs-poll, last 6 ==')
for (const r of runs) console.log(`  ${r.startedAt.toISOString()} ${String(r.status).padEnd(8)} ${r.errorMessage ? 'ERR ' + r.errorMessage.slice(0,60) : (r.outputSummary ?? '(none)').slice(0,100)}`)
// any run that ever saw a budget record?
const withBudget = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`
  SELECT COUNT(*)::bigint AS n FROM "CronRun"
  WHERE "jobName"='ams-sqs-poll' AND "outputSummary" IS NOT NULL
    AND "outputSummary" ~ 'budget=[1-9]'`)
const withReceived = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`
  SELECT COUNT(*)::bigint AS n FROM "CronRun"
  WHERE "jobName"='ams-sqs-poll' AND "outputSummary" ~ 'received=[1-9]'`)
const withChanged = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`
  SELECT COUNT(*)::bigint AS n FROM "CronRun"
  WHERE "jobName"='ams-sqs-poll' AND "outputSummary" ~ 'changed=[1-9]'`)
console.log(`\n  runs that received ANY record : ${Number(withReceived[0].n)}`)
console.log(`  runs that saw a CHANGE record : ${Number(withChanged[0].n)}`)
console.log(`  runs that saw a BUDGET record : ${Number(withBudget[0].n)}   <-- budget-usage subscription tell`)
const tables = await prisma.$queryRawUnsafe<Array<{ t: string }>>(`
  SELECT table_name::text AS t FROM information_schema.tables
  WHERE table_schema='public' AND (table_name ILIKE '%budget%' OR table_name ILIKE '%stream%' OR table_name ILIKE '%ams%') ORDER BY 1`)
console.log(`\n== tables matching budget/stream/ams ==`)
for (const t of tables) console.log('  ' + t.t)
// today's spend-so-far, the candidate live denominatorless numerator
const today = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT COUNT(DISTINCT h."localEntityId")::bigint AS campaigns,
         MAX(h."hour")::int AS max_hour,
         ROUND((SUM(h."costMicros")/1e6)::numeric,2) AS spend_eur_today
  FROM "AmazonAdsHourlyPerformance" h
  WHERE h."entityType"='CAMPAIGN' AND h."date" = CURRENT_DATE AND h."localEntityId" IS NOT NULL`)
console.log(`\n== today's hourly rows (UTC date) ==`)
for (const [k,v] of Object.entries(today[0] ?? {})) console.log(`  ${k.padEnd(18)} ${String(v)}`)
await prisma.$disconnect()

/** READ-ONLY. P6 discovery — what does the AMS pipeline actually deliver today, and how fresh
 *  is the hourly grain (the other candidate source for a live budget-utilization reading)? */
const { default: prisma } = await import('../src/db.js')
const now = new Date()

// 1 · is the SQS poll running, and is it seeing budget records?
const runs = await prisma.cronRun.findMany({
  where: { jobName: 'ams-sqs-poll' }, orderBy: { startedAt: 'desc' }, take: 8,
  select: { startedAt: true, status: true, outputSummary: true, errorMessage: true },
})
console.log(`== ams-sqs-poll — last ${runs.length} runs ==`)
for (const r of runs) console.log(`  ${r.startedAt.toISOString()}  ${String(r.status).padEnd(8)} ${r.errorMessage ? 'ERR: ' + r.errorMessage.slice(0, 70) : (r.outputSummary ?? '(none)').slice(0, 90)}`)
const all = await prisma.cronRun.count({ where: { jobName: 'ams-sqs-poll' } })
console.log(`  total runs ever: ${all}`)

// 2 · every ads-ish cron, so the prompt names the real cadence
const jobs = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT "jobName", COUNT(*)::bigint AS runs, MAX("startedAt") AS last_run
  FROM "CronRun" WHERE "jobName" ILIKE '%ams%' OR "jobName" ILIKE '%stream%' OR "jobName" ILIKE '%hourly%'
  GROUP BY 1 ORDER BY 3 DESC NULLS LAST
`)
console.log(`\n== AMS / stream / hourly crons ==`)
for (const j of jobs) console.log(`  ${String(j.jobName).padEnd(26)} runs=${String(Number(j.runs as bigint)).padStart(6)}  last=${j.last_run ? new Date(j.last_run as Date).toISOString() : 'never'}`)

// 3 · hourly grain freshness — the lag that decides whether "today so far" is possible
const fresh = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT MAX("date")::text AS max_date,
         MAX(("date" + ("hour" || ' hours')::interval)) AS max_hour_ts,
         MAX("reportedAt") AS max_reported,
         MAX("createdAt")  AS max_created,
         COUNT(*)::bigint  AS rows_today
  FROM "AmazonAdsHourlyPerformance"
  WHERE "entityType"='CAMPAIGN' AND "date" >= (CURRENT_DATE - 1)
`)
console.log(`\n== AmazonAdsHourlyPerformance freshness (now ${now.toISOString()}) ==`)
for (const [k, v] of Object.entries(fresh[0] ?? {})) console.log(`  ${k.padEnd(14)} ${v instanceof Date ? v.toISOString() : String(v)}`)
const lagMs = fresh[0]?.max_created ? now.getTime() - new Date(fresh[0].max_created as Date).getTime() : null
console.log(`  ingest lag (now − newest createdAt): ${lagMs != null ? (lagMs / 3.6e6).toFixed(1) + ' h' : 'n/a'}`)

// 4 · per-day hourly coverage over the last 3 days: how many campaigns, how many hours
const cov = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT "date"::text AS d, COUNT(DISTINCT "localEntityId")::bigint AS campaigns,
         MAX("hour")::int AS max_hour, COUNT(*)::bigint AS rows
  FROM "AmazonAdsHourlyPerformance"
  WHERE "entityType"='CAMPAIGN' AND "date" >= (CURRENT_DATE - 4)
  GROUP BY 1 ORDER BY 1 DESC
`)
console.log(`\n== hourly coverage, last 5 days ==`)
for (const r of cov) console.log(`  ${r.d}  campaigns=${String(Number(r.campaigns as bigint)).padStart(3)}  maxHour=${String(r.max_hour).padStart(2)}  rows=${Number(r.rows as bigint)}`)

// 5 · does ANY table hold a budget-usage event? (the answer the prompt must state)
const tables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema='public' AND (table_name ILIKE '%budget%' OR table_name ILIKE '%stream%' OR table_name ILIKE '%ams%')
  ORDER BY 1
`)
console.log(`\n== tables matching budget/stream/ams ==`)
for (const t of tables) console.log(`  ${t.table_name}`)
await prisma.$disconnect()

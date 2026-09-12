import pg from 'pg'
process.loadEnvFile('../../.env')
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
await c.connect()
console.error('=== amazon SQS poll cron, last 12 runs ===')
for (const r of (await c.query(`SELECT "jobName","status","startedAt"::text s,"outputSummary","errorMessage"
  FROM "CronRun" WHERE "jobName" ILIKE '%sqs%' ORDER BY "startedAt" DESC LIMIT 12`)).rows)
  console.error(`  ${r.s}  ${String(r.status).padEnd(8)} ${String(r.outputSummary ?? '').slice(0,80)} ${r.errorMessage ? '| ERR: ' + String(r.errorMessage).slice(0,90) : ''}`)
console.error('\n=== any cron FAILED in the last 2h? ===')
const f = (await c.query(`SELECT "jobName","status","startedAt"::text s,LEFT(COALESCE("errorMessage",''),110) e
  FROM "CronRun" WHERE "startedAt" > NOW() - INTERVAL '2 hours' AND "status" NOT IN ('SUCCESS','RUNNING') ORDER BY "startedAt" DESC LIMIT 12`)).rows
if (f.length === 0) console.error('  none')
for (const r of f) console.error(`  ${r.s}  ${r.jobName} ${r.status} ${r.e}`)
await c.end()

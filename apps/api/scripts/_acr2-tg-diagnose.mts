/** ACR.2.2 — why does AD_TARGET grain have 2 days when the cron is daily? READ-ONLY. */
import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = <T = Record<string, unknown>>(s: string) => p.$queryRawUnsafe<T[]>(s)
const n = (v: unknown) => (typeof v === 'bigint' ? Number(v) : v)
const show = (rows: Record<string, unknown>[], max = 25) => rows.length
  ? rows.slice(0, max).forEach((r) => console.log('  ' + Object.entries(r).map(([k, v]) => `${k}=${String(n(v)).slice(0,150)}`).join('  ')))
  : console.log('  (none)')
const h = (s: string) => console.log(`\n── ${s} ──`)

h('1. did the tg report-create cron run?')
show(await q(`SELECT "jobName", status, "startedAt"::text AS started,
    LEFT(COALESCE("outputSummary"::text,''),120) AS summary, LEFT(COALESCE("errorMessage",''),120) AS err
  FROM "CronRun" WHERE "jobName" ILIKE '%report-create%' ORDER BY "startedAt" DESC LIMIT 12`))

h('2. targeting report JOBS created — by status and date')
show(await q(`SELECT status, COUNT(*)::int AS jobs, MIN("startDate")::text AS oldest, MAX("startDate")::text AS newest,
    SUM("rowsIngested")::int AS rows
  FROM "AmazonAdsReportJob" WHERE "reportTypeId" ILIKE '%Target%' GROUP BY 1 ORDER BY 2 DESC`))

h('3. all report jobs by reportTypeId, last 14 days')
show(await q(`SELECT "reportTypeId", status, COUNT(*)::int AS jobs, SUM("rowsIngested")::int AS rows
  FROM "AmazonAdsReportJob" WHERE "createdAt" > now() - interval '14 days'
  GROUP BY 1,2 ORDER BY 1, 3 DESC`), 30)

h('4. targeting jobs in detail, most recent')
show(await q(`SELECT "profileId", "startDate"::text AS day, status, "rowsIngested",
    LEFT(COALESCE("errorMessage",''),100) AS err, "createdAt"::text AS created
  FROM "AmazonAdsReportJob" WHERE "reportTypeId" ILIKE '%Target%'
  ORDER BY "createdAt" DESC LIMIT 15`))

await p.$disconnect()

/** ACR.2.2 — how much AD_TARGET history exists, and what would a backfill cost? READ-ONLY. */
import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = <T = Record<string, unknown>>(s: string) => p.$queryRawUnsafe<T[]>(s)
const n = (v: unknown) => (typeof v === 'bigint' ? Number(v) : v)
const show = (rows: Record<string, unknown>[], max = 25) => rows.length
  ? rows.slice(0, max).forEach((r) => console.log('  ' + Object.entries(r).map(([k, v]) => `${k}=${n(v)}`).join('  ')))
  : console.log('  (none)')
const h = (s: string) => console.log(`\n── ${s} ──`)

h('AD_TARGET grain — what exists')
show(await q(`
  SELECT MIN(date)::text AS oldest, MAX(date)::text AS newest,
         COUNT(*)::int AS rows, COUNT(DISTINCT date)::int AS days,
         COUNT(DISTINCT "entityId")::int AS targets,
         COUNT(DISTINCT marketplace)::int AS markets
  FROM "AmazonAdsDailyPerformance" WHERE "entityType" = 'AD_TARGET'`))

h('by marketplace')
show(await q(`
  SELECT marketplace, COUNT(*)::int AS rows, COUNT(DISTINCT date)::int AS days,
         MIN(date)::text AS oldest, MAX(date)::text AS newest
  FROM "AmazonAdsDailyPerformance" WHERE "entityType" = 'AD_TARGET'
  GROUP BY 1 ORDER BY 2 DESC`))

h('for comparison — CAMPAIGN grain, which has been running longer')
show(await q(`
  SELECT MIN(date)::text AS oldest, MAX(date)::text AS newest, COUNT(DISTINCT date)::int AS days
  FROM "AmazonAdsDailyPerformance" WHERE "entityType" = 'CAMPAIGN'`))

h('active ads profiles, and which actually carry campaigns')
show(await q(`
  SELECT c."profileId", c.marketplace, c.region, c."isActive",
         (SELECT COUNT(*) FROM "Campaign" k WHERE k.marketplace = c.marketplace)::int AS campaigns
  FROM "AmazonAdsConnection" c ORDER BY campaigns DESC, c.marketplace`), 20)

h('report jobs already requested for targeting')
show(await q(`
  SELECT status, COUNT(*)::int AS jobs, MIN("startDate")::text AS oldest, MAX("startDate")::text AS newest
  FROM "AmazonAdsReportJob" WHERE "groupByJson"::text ILIKE '%targeting%' GROUP BY 1 ORDER BY 2 DESC`)
  .catch(async () => q(`SELECT column_name FROM information_schema.columns WHERE table_name='AmazonAdsReportJob' ORDER BY ordinal_position`)))

await p.$disconnect()

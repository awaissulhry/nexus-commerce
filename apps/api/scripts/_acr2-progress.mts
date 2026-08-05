/** ACR.2 — how are the two backfills doing? READ-ONLY. */
import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = <T = Record<string, unknown>>(s: string) => p.$queryRawUnsafe<T[]>(s)
const n = (v: unknown) => (typeof v === 'bigint' ? Number(v) : v)
const show = (rows: Record<string, unknown>[], max = 15) => rows.length
  ? rows.slice(0, max).forEach((r) => console.log('  ' + Object.entries(r).map(([k, v]) => `${k}=${n(v)}`).join('  ')))
  : console.log('  (none)')
const h = (s: string) => console.log(`\n── ${s} ──`)

h('SQP repair — rows carrying OUR impressions, by week')
show(await q(`SELECT marketplace, "startDate"::text AS week, COUNT(*)::int AS rows,
    COUNT(*) FILTER (WHERE "impressionsBrand" > 0)::int AS repaired
  FROM "SearchQueryPerformance" WHERE marketplace='IT'
  GROUP BY 1,2 ORDER BY 2 DESC`), 12)

h('AD_TARGET backfill — job queue state')
show(await q(`SELECT status, COUNT(*)::int AS jobs, SUM(COALESCE("rowsIngested",0))::int AS rows
  FROM "AmazonAdsReportJob" WHERE "reportTypeId"='spTargeting' GROUP BY 1 ORDER BY 2 DESC`))

h('AD_TARGET grain — days landed')
show(await q(`SELECT COUNT(DISTINCT date)::int AS days, COUNT(*)::int AS rows,
    MIN(date)::text AS oldest, MAX(date)::text AS newest
  FROM "AmazonAdsDailyPerformance" WHERE "entityType"='AD_TARGET'`))

await p.$disconnect()

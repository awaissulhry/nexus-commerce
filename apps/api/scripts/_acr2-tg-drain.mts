/** ACR.2.2 — are the backfilled targeting jobs actually returning rows? READ-ONLY. */
import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = <T = Record<string, unknown>>(s: string) => p.$queryRawUnsafe<T[]>(s)
const n = (v: unknown) => (typeof v === 'bigint' ? Number(v) : v)
const show = (rows: Record<string, unknown>[], max = 25) => rows.length
  ? rows.slice(0, max).forEach((r) => console.log('  ' + Object.entries(r).map(([k, v]) => `${k}=${String(n(v)).slice(0,90)}`).join('  ')))
  : console.log('  (none)')
const h = (s: string) => console.log(`\n── ${s} ──`)

h('backfilled targeting jobs — completed ones, newest first')
show(await q(`SELECT j."startDate"::text AS day, c.marketplace, j.status, j."rowsIngested",
    j."ingestedAt" IS NOT NULL AS ingested, j."completedAt"::text AS completed,
    LEFT(COALESCE(j."errorMessage",''),70) AS err
  FROM "AmazonAdsReportJob" j
  LEFT JOIN "AmazonAdsConnection" c ON c."profileId" = j."profileId"
  WHERE j."reportTypeId"='spTargeting' AND j."createdAt" > now() - interval '2 hours'
    AND j.status <> 'PENDING'
  ORDER BY j."completedAt" DESC NULLS LAST`), 25)

h('status mix of the 116 backfill jobs')
show(await q(`SELECT status, COUNT(*)::int AS jobs, SUM(COALESCE("rowsIngested",0))::int AS rows,
    COUNT(*) FILTER (WHERE "ingestedAt" IS NOT NULL)::int AS ingested
  FROM "AmazonAdsReportJob"
  WHERE "reportTypeId"='spTargeting' AND "createdAt" > now() - interval '2 hours'
  GROUP BY 1 ORDER BY 2 DESC`))

await p.$disconnect()

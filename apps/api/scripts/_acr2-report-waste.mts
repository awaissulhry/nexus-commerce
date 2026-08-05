/** ACR.2.3 — how many report jobs can only ever return zero? READ-ONLY. */
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

h('1. campaigns by ad product — what this account actually runs')
show(await q(`SELECT COALESCE("adProduct",'(null)') AS ad_product, COUNT(*)::int AS campaigns,
    COUNT(*) FILTER (WHERE status='ENABLED')::int AS enabled
  FROM "Campaign" GROUP BY 1 ORDER BY 2 DESC`))

h('2. campaigns per marketplace — which profiles could ever return a row')
show(await q(`SELECT c.marketplace, COUNT(k.id)::int AS campaigns
  FROM "AmazonAdsConnection" c LEFT JOIN "Campaign" k ON k.marketplace = c.marketplace
  WHERE c."isActive" GROUP BY 1 ORDER BY 2 DESC`))

h('3. 30 days of report jobs: which produced nothing, and why')
show(await q(`SELECT j."reportTypeId", j."adProduct",
    COUNT(*)::int AS jobs,
    COUNT(*) FILTER (WHERE COALESCE(j."rowsIngested",0) = 0)::int AS zero_row_jobs,
    SUM(COALESCE(j."rowsIngested",0))::int AS rows
  FROM "AmazonAdsReportJob" j
  WHERE j."createdAt" > now() - interval '30 days'
  GROUP BY 1,2 ORDER BY zero_row_jobs DESC`), 20)

h('4. the two avoidable causes, counted over 30 days')
show(await q(`
  WITH j AS (
    SELECT r.*, (SELECT COUNT(*) FROM "Campaign" k
                 JOIN "AmazonAdsConnection" c2 ON c2.marketplace = k.marketplace
                 WHERE c2."profileId" = r."profileId") AS mkt_campaigns,
           (SELECT COUNT(*) FROM "Campaign" k2 WHERE k2."adProduct" = r."adProduct") AS product_campaigns
    FROM "AmazonAdsReportJob" r WHERE r."createdAt" > now() - interval '30 days'
  )
  SELECT COUNT(*)::int AS total_jobs,
         COUNT(*) FILTER (WHERE mkt_campaigns = 0)::int AS profile_has_no_campaigns,
         COUNT(*) FILTER (WHERE product_campaigns = 0)::int AS ad_product_unused,
         COUNT(*) FILTER (WHERE mkt_campaigns = 0 OR product_campaigns = 0)::int AS avoidable,
         SUM(COALESCE("rowsIngested",0)) FILTER (WHERE mkt_campaigns = 0 OR product_campaigns = 0)::int AS rows_those_returned
  FROM j`))

await p.$disconnect()

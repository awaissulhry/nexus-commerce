import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve('/Users/awais/nexus-commerce', '.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = (s: string) => p.$queryRawUnsafe<Record<string, unknown>[]>(s)
const n = (v: unknown) => (typeof v === 'bigint' ? Number(v) : v instanceof Date ? v.toISOString().slice(0,10) : v)
const t = (rows: Record<string, unknown>[]) => rows.length
  ? rows.map(r => '  ' + Object.entries(r).map(([k,v]) => `${k}=${n(v)}`).join('  ')).join('\n') : '  (none)'
const hr = (s: string) => console.log(`\n--- ${s} ---`)

hr('A. Is IT really staler than DE/FR? last 8 days per marketplace, daily perf')
console.log(t(await q(`SELECT marketplace, MAX(date)::date AS last_day, COUNT(*) FILTER (WHERE date >= CURRENT_DATE-8)::int AS rows_last_8d FROM "AmazonAdsDailyPerformance" GROUP BY 1 ORDER BY 1`)))
hr('A2. same for search terms')
console.log(t(await q(`SELECT marketplace, MAX(date)::date AS last_day, COUNT(*) FILTER (WHERE date >= CURRENT_DATE-8)::int AS rows_last_8d FROM "AmazonAdsSearchTerm" GROUP BY 1 ORDER BY 1`)))

hr('B. Placement marketplace pollution — raw IDs vs country codes')
console.log(t(await q(`SELECT marketplace, COUNT(*)::int AS rows, MIN(date)::date AS first_day, MAX(date)::date AS last_day FROM "AmazonAdsPlacementReport" WHERE LENGTH(marketplace) > 3 GROUP BY 1 ORDER BY 2 DESC`)))

hr('C. Do Sponsored Brands campaigns exist at all? (explains 1,002 zero-row SB jobs)')
console.log(t(await q(`SELECT "adProduct", "marketplace", "status", COUNT(*)::int AS campaigns FROM "Campaign" GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 25`)))

hr('D. Entity types present in daily perf — is target-level performance ingested anywhere?')
console.log(t(await q(`SELECT "entityType", COUNT(*)::int AS rows FROM "AmazonAdsDailyPerformance" GROUP BY 1`)))
console.log(t(await q(`SELECT "entityType", COUNT(*)::int AS rows FROM "CampaignMetric" GROUP BY 1`)))
hr('D2. AdTarget rows that exist locally (targets we could report on)')
console.log(t(await q(`SELECT "kind", COUNT(*)::int AS targets FROM "AdTarget" GROUP BY 1 ORDER BY 2 DESC LIMIT 10`)))

hr('E. AmazonReportRun.rowCount — is it ever populated?')
console.log(t(await q(`SELECT COUNT(*)::int AS runs, COUNT(*) FILTER (WHERE "rowCount" > 0)::int AS with_rowcount, MAX("rowCount")::int AS max_rowcount FROM "AmazonReportRun"`)))

hr('F. eBay ads report task failures (failureReason, not errorMessage)')
console.log(t(await q(`SELECT status, COUNT(*)::int AS n, LEFT(COALESCE("failureReason",'(none)'),50) AS reason FROM "EbayAdsReportTask" GROUP BY 1,3 ORDER BY 2 DESC LIMIT 8`)))

hr('G. s3_download_400 — still accruing? last 10 occurrences by day')
console.log(t(await q(`SELECT "createdAt"::date AS day, COUNT(*)::int AS failures FROM "AmazonAdsExportJob" WHERE "errorMessage" ILIKE '%s3_download_400%' GROUP BY 1 ORDER BY 1 DESC LIMIT 10`)))

await p.$disconnect()

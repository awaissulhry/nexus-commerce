import prisma from '../src/db.js'
const q = (s: string) => prisma.$queryRawUnsafe<any[]>(s)
const rows = await q(`
  SELECT c."marketplace", j."startDate"::text AS day, j."configuration",
         j."fileSize", j."rowsIngested"
  FROM "AmazonAdsReportJob" j
  JOIN "AmazonAdsConnection" c ON c."profileId" = j."profileId"
  WHERE c."marketplace" IN ('IT','DE') AND j."reportTypeId"='spCampaigns'
    AND j."startDate" IN ('2026-08-03','2026-07-27')
  ORDER BY c."marketplace", j."startDate" DESC`)
for (const r of rows) {
  console.log(`\n--- ${r.marketplace}  ${r.day.slice(0,10)}  file=${r.fileSize}  ingested=${r.rowsIngested}`)
  console.log(JSON.stringify(r.configuration))
}
await prisma.$disconnect()

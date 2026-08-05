import prisma from '../src/db.js'
const q = (s: string) => prisma.$queryRawUnsafe<any[]>(s)
console.log('\n=== Did Amazon RETURN data? fileSize on recent IT vs DE jobs ===')
console.table(await q(`
  SELECT c."marketplace", j."reportTypeId", j."startDate"::text AS day,
         j."fileSize", j."rowsIngested", j."status"
  FROM "AmazonAdsReportJob" j
  JOIN "AmazonAdsConnection" c ON c."profileId" = j."profileId"
  WHERE c."marketplace" IN ('IT','DE')
    AND j."reportTypeId" = 'spCampaigns'
    AND j."startDate" >= '2026-07-26'
  ORDER BY c."marketplace", j."startDate" DESC`))
await prisma.$disconnect()

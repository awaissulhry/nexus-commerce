import prisma from '../src/db.js'
const q = (s: string) => prisma.$queryRawUnsafe<any[]>(s)

console.log('\n=== AmazonAdsConnection (the marketplace fallback source) ===')
console.table(await q(`SELECT "profileId","marketplace","region","isActive","updatedAt"::text FROM "AmazonAdsConnection" ORDER BY "marketplace"`))

console.log('\n=== TODAY 2026-08-04 jobs: profile x type x rows ingested ===')
console.table(await q(`
  SELECT "profileId","reportTypeId","status",
         "startDate"::text AS start_d,"endDate"::text AS end_d,"rowsIngested",
         LEFT(COALESCE("errorMessage",''),50) AS err
  FROM "AmazonAdsReportJob"
  WHERE "createdAt" > '2026-08-04' AND "reportTypeId" IN ('spCampaigns','spAdvertisedProduct','spSearchTerm')
  ORDER BY "profileId","reportTypeId"`))

console.log('\n=== rows written today, by marketplace x date ===')
console.table(await q(`
  SELECT "marketplace","date"::text AS day, COUNT(*)::int AS rows
  FROM "AmazonAdsDailyPerformance" WHERE "createdAt" > '2026-08-04'
  GROUP BY 1,2 ORDER BY 1,2 DESC`))
await prisma.$disconnect()

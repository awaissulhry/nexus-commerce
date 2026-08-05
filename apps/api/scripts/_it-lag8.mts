import prisma from '../src/db.js'
const r = await prisma.$queryRawUnsafe<any[]>(`
  SELECT c."marketplace",
         MIN(j."completedAt")::text AS first_done,
         MAX(j."completedAt")::text AS last_done,
         COUNT(*)::int AS jobs,
         COUNT(*) FILTER (WHERE j."rowsIngested"=0)::int AS zero_rows
  FROM "AmazonAdsReportJob" j
  JOIN "AmazonAdsConnection" c ON c."profileId"=j."profileId"
  WHERE j."createdAt" > '2026-08-04' AND j."completedAt" IS NOT NULL
  GROUP BY 1 ORDER BY 2`)
console.table(r)
const n = await prisma.$queryRawUnsafe<any[]>(`
  SELECT COUNT(*)::int AS jobs_per_day FROM "AmazonAdsReportJob" WHERE "createdAt" > '2026-08-04'`)
console.log('jobs created today:', n[0].jobs_per_day, '| ingest capacity/hour = 4 ticks x 10 =', 40)
await prisma.$disconnect()

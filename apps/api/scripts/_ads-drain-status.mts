import prisma from '../src/db.js'
const q = (s: string) => prisma.$queryRawUnsafe<any[]>(s)
console.log('backfill jobs (created tonight):')
console.table(await q(`
  SELECT c."marketplace", j."status",
         COUNT(*)::int AS n,
         COUNT(*) FILTER (WHERE j."ingestedAt" IS NOT NULL)::int AS ingested,
         SUM(j."rowsIngested")::int AS rows
  FROM "AmazonAdsReportJob" j JOIN "AmazonAdsConnection" c ON c."profileId"=j."profileId"
  WHERE j."createdAt" > '2026-08-04 22:10' GROUP BY 1,2 ORDER BY 1,2`))
console.log('\nIT/ES/FR daily-perf coverage after backfill:')
console.table(await q(`
  SELECT "date"::text AS day,
         COUNT(*) FILTER (WHERE "marketplace"='IT')::int AS it,
         COUNT(*) FILTER (WHERE "marketplace"='ES')::int AS es,
         COUNT(*) FILTER (WHERE "marketplace"='FR')::int AS fr
  FROM "AmazonAdsDailyPerformance" WHERE "date" >= '2026-07-28'
  GROUP BY 1 ORDER BY 1`))
await prisma.$disconnect()

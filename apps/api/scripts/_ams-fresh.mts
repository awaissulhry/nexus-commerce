import prisma from '../src/db.js'
// createdAt only moves on INSERT; AMS corrections take the update path, which
// sets reportedAt. Measuring freshness by createdAt understates a live feed.
const r = await prisma.$queryRawUnsafe<any[]>(`
  SELECT MAX("createdAt")::text AS newest_insert,
         MAX("reportedAt")::text AS newest_report,
         COUNT(*) FILTER (WHERE "reportedAt" > NOW() - INTERVAL '15 minutes')::int AS touched_15m
  FROM "AmazonAdsHourlyPerformance"`)
console.error('FRESH| ' + JSON.stringify(r[0]))
process.exit(0)

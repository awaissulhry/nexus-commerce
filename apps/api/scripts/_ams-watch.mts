import prisma from '../src/db.js'
const r = await prisma.$queryRawUnsafe<any[]>(`
  SELECT COUNT(*)::int AS negative_rows,
         MAX("createdAt")::text AS newest_negative
  FROM "AmazonAdsHourlyPerformance" WHERE "impressions" < 0 OR "clicks" < 0`)
const f = await prisma.$queryRawUnsafe<any[]>(`
  SELECT COUNT(*)::int AS rows_last_hour, MAX("createdAt")::text AS newest
  FROM "AmazonAdsHourlyPerformance" WHERE "createdAt" > NOW() - INTERVAL '1 hour'`)
console.error('NEG ' + JSON.stringify(r[0]) + ' | FEED ' + JSON.stringify(f[0]))
process.exit(0)

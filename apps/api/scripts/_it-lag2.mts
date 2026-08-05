import prisma from '../src/db.js'
const q = (s: string) => prisma.$queryRawUnsafe<any[]>(s)

console.log('\n=== AmazonAdsProfile contents ===')
const p = await q(`SELECT "profileId","marketplace","countryCode","accountName","lastSyncedAt"::text FROM "AmazonAdsProfile" ORDER BY "countryCode"`)
console.log('rows:', p.length); console.table(p)

console.log('\n=== how does the ingest know the market? Campaign profile->market ===')
console.table(await q(`
  SELECT "marketplace", COUNT(*)::int AS campaigns, COUNT(DISTINCT "externalCampaignId")::int AS ext
  FROM "Campaign" WHERE "marketplace" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`))

console.log('\n=== per-day rows, last 18 days ===')
console.table(await q(`
  SELECT "date"::text AS day,
         COUNT(*) FILTER (WHERE "marketplace"='IT')::int AS it,
         COUNT(*) FILTER (WHERE "marketplace"='DE')::int AS de,
         COUNT(*) FILTER (WHERE "marketplace"='FR')::int AS fr,
         COUNT(*) FILTER (WHERE "marketplace"='ES')::int AS es
  FROM "AmazonAdsDailyPerformance" WHERE "date" > CURRENT_DATE - 18
  GROUP BY 1 ORDER BY 1 DESC`))

console.log('\n=== IT rows written TODAY: which dates did they carry? ===')
console.table(await q(`
  SELECT "date"::text AS day, COUNT(*)::int AS rows, "entityType"
  FROM "AmazonAdsDailyPerformance"
  WHERE "marketplace"='IT' AND "createdAt" > CURRENT_DATE
  GROUP BY 1,3 ORDER BY 1 DESC LIMIT 15`))
await prisma.$disconnect()

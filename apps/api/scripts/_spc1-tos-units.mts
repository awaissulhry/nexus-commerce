import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient({ log: [] })
const j=(x:unknown)=>JSON.stringify(x,(_k,v)=>typeof v==='bigint'?Number(v):v)
console.log('PLACEMENT topOfSearchIS (existing column, ingested by ingestPlacementRows):')
console.log(j(await p.$queryRawUnsafe(`SELECT MIN("topOfSearchIS")::text lo, MAX("topOfSearchIS")::text hi,
  COUNT(*)::int n FROM "AmazonAdsPlacementReport" WHERE "topOfSearchIS" IS NOT NULL`)))
console.log('\nDAILY topOfSearchIS (the SPC.1 column, just written):')
console.log(j(await p.$queryRawUnsafe(`SELECT MIN("topOfSearchIS")::text lo, MAX("topOfSearchIS")::text hi,
  COUNT(*)::int n FROM "AmazonAdsDailyPerformance" WHERE "topOfSearchIS" IS NOT NULL`)))
console.log('\nsame campaign+day in BOTH tables — do they agree?')
console.log(j(await p.$queryRawUnsafe(`
  SELECT d."entityId", d."date"::text, d."topOfSearchIS"::text daily, pl."topOfSearchIS"::text placement
  FROM "AmazonAdsDailyPerformance" d
  JOIN "AmazonAdsPlacementReport" pl ON pl."campaignId"=d."entityId" AND pl."date"=d."date"
   AND pl."topOfSearchIS" IS NOT NULL
  WHERE d."topOfSearchIS" IS NOT NULL LIMIT 5`)))
await p.$disconnect()

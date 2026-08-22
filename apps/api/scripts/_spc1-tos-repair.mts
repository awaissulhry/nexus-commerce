/** SPC.1 — repair the topOfSearchIS rows written before the normalisation existed. */
import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient({ log: [] })
const j=(x:unknown)=>JSON.stringify(x,(_k,v)=>typeof v==='bigint'?Number(v):v)

console.log('before:', j(await p.$queryRawUnsafe(`SELECT COUNT(*)::int n,
  COUNT(*) FILTER (WHERE "topOfSearchIS" > 1)::int above_one, MAX("topOfSearchIS")::text hi
  FROM "AmazonAdsDailyPerformance" WHERE "topOfSearchIS" IS NOT NULL`)))

// Only rows the buggy pass could have written: a share above 1 is impossible, so
// this cannot touch a correctly-stored fraction.
const r = await p.$executeRawUnsafe(`
  UPDATE "AmazonAdsDailyPerformance" SET "topOfSearchIS" = "topOfSearchIS" / 100
  WHERE "topOfSearchIS" > 1`)
console.log('rows repaired:', r)

console.log('after:', j(await p.$queryRawUnsafe(`SELECT COUNT(*)::int n,
  COUNT(*) FILTER (WHERE "topOfSearchIS" > 1)::int above_one,
  MIN("topOfSearchIS")::text lo, MAX("topOfSearchIS")::text hi
  FROM "AmazonAdsDailyPerformance" WHERE "topOfSearchIS" IS NOT NULL`)))

console.log('\nthe campaign that proved it, now:', j(await p.$queryRawUnsafe(`
  SELECT d."topOfSearchIS"::text daily, pl."topOfSearchIS"::text placement
  FROM "AmazonAdsDailyPerformance" d
  JOIN "AmazonAdsPlacementReport" pl ON pl."campaignId"=d."entityId" AND pl."date"=d."date"
  WHERE d."entityId"='279134427833119' AND d."date"=DATE '2026-08-18' AND pl."topOfSearchIS" IS NOT NULL`)))
await p.$disconnect()

import { config } from 'dotenv'
config({ path: '/Users/awais/nexus-commerce/.env' })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
show('A3 — AdBudgetPlan rows', await q(`
  SELECT * FROM "AdBudgetPlan" ORDER BY 1 LIMIT 3`))
show('A1 — product-level bounds columns present?', await q(`
  SELECT column_name FROM information_schema.columns
  WHERE table_name='Product' AND column_name IN ('minPriceCents','maxPriceCents','costFloorCents','costPriceCents')`))
show('A1 — campaign bounds coverage', await q(`
  SELECT COUNT(*) AS campaigns,
         COUNT(*) FILTER (WHERE "maxBidCents" IS NOT NULL) AS with_max,
         COUNT(*) FILTER (WHERE "minBidCents" IS NOT NULL) AS with_min
  FROM "Campaign" `))
show('C1 — rank engine coverage', await q(`
  SELECT (SELECT COUNT(DISTINCT "campaignId") FROM "AdSchedule" WHERE enabled) AS campaigns_with_schedule,
         (SELECT COUNT(*) FROM "Campaign") AS total_campaigns,
         (SELECT COUNT(*) FROM "RankScheduleGroup") AS groups,
         (SELECT COUNT(*) FROM "RankScheduleGroup" WHERE enabled) AS groups_enabled`))
await p.$disconnect()

import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))

show('1. rank targets — which have NO CPC ceiling?', await q(`
  SELECT key, name, "allOut", "maxCpcCents", "targetISPct", "biasPct", "maxBiasPct", pause
  FROM "RankTarget" ORDER BY "allOut" DESC, key`))

show('2. enabled schedules using an uncapped target', await q(`
  SELECT rt.key AS target, COUNT(DISTINCT s."campaignId") AS campaigns, COUNT(*) AS schedules
  FROM "AdSchedule" s
  JOIN "RankTarget" rt ON rt.key = s."defaultTargetKey" OR s.windows::text LIKE '%"' || rt.key || '"%'
  WHERE s.enabled AND rt."maxCpcCents" IS NULL AND rt."allOut"
  GROUP BY 1 ORDER BY 2 DESC`))

show('3. what bids are actually in use on scheduled campaigns?', await q(`
  SELECT c.marketplace,
         COUNT(DISTINCT c.id) AS campaigns,
         MAX(t."bidCents") AS max_bid_cents,
         ROUND(AVG(NULLIF(t."bidCents",0))) AS avg_bid_cents,
         MAX(g."defaultBidCents") AS max_default_bid
  FROM "Campaign" c
  JOIN "AdSchedule" s ON s."campaignId" = c.id AND s.enabled
  LEFT JOIN "AdGroup" g ON g."campaignId" = c.id
  LEFT JOIN "AdTarget" t ON t."adGroupId" = g.id
  GROUP BY 1 ORDER BY 2 DESC`))

show('4. observed CPC — what a click ACTUALLY costs (last 30d)', await q(`
  SELECT c.marketplace,
         SUM(d."costMicros")/1000000.0 AS spend_eur,
         SUM(d.clicks) AS clicks,
         ROUND((SUM(d."costMicros")/1000000.0 / NULLIF(SUM(d.clicks),0) * 100)::numeric, 1) AS avg_cpc_cents
  FROM "AmazonAdsDailyPerformance" d
  JOIN "Campaign" c ON c."externalCampaignId" = d."externalEntityId"
  WHERE d."entityType"='CAMPAIGN' AND d.date > now() - interval '30 days'
  GROUP BY 1 ORDER BY 2 DESC`))

show('5. current placement multipliers in play (they STACK on the base bid)', await q(`
  SELECT (jsonb_array_elements(("dynamicBidding"->'placementBidding')::jsonb)->>'placement') AS placement,
         MAX((jsonb_array_elements(("dynamicBidding"->'placementBidding')::jsonb)->>'percentage')::int) AS max_pct
  FROM "Campaign" WHERE "dynamicBidding" ? 'placementBidding' GROUP BY 1 ORDER BY 2 DESC`))
await p.$disconnect()

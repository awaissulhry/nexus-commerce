import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))

show('A. all-out / uncapped rank targets', await q(`
  SELECT key, "allOut", "maxCpcCents", "biasPct", "maxBiasPct", "acosCapPct"
  FROM "RankTarget" WHERE "allOut" OR "maxCpcCents" IS NULL ORDER BY "allOut" DESC`))

show('B. which targets do ENABLED schedules actually use?', await q(`
  SELECT COALESCE("defaultTargetKey",'(none)') AS baseline, COUNT(*) AS schedules
  FROM "AdSchedule" WHERE enabled GROUP BY 1 ORDER BY 2 DESC`))

show('C. PEAK bids actually written in the last 30d (the daytime hold)', await q(`
  SELECT c.marketplace, COUNT(DISTINCT m."entityId") AS entities,
         MAX(m."intendedValue"::int) AS peak_bid_cents,
         percentile_disc(0.95) WITHIN GROUP (ORDER BY m."intendedValue"::int) AS p95_bid_cents,
         percentile_disc(0.5)  WITHIN GROUP (ORDER BY m."intendedValue"::int) AS median_bid_cents
  FROM "AdMutation" m JOIN "AdTarget" t ON t.id = m."entityId"
  JOIN "AdGroup" g ON g.id = t."adGroupId" JOIN "Campaign" c ON c.id = g."campaignId"
  WHERE m.field='bid' AND m."createdAt" > now() - interval '30 days'
    AND m."intendedValue" ~ '^[0-9]+$'
  GROUP BY 1 ORDER BY 3 DESC`))

show('D. observed CPC — what a click really costs (30d)', await q(`
  SELECT marketplace, ROUND((SUM("costMicros")/1000000.0)::numeric,2) AS spend_eur, SUM(clicks) AS clicks,
         ROUND((SUM("costMicros")/1000000.0 / NULLIF(SUM(clicks),0) * 100)::numeric,1) AS avg_cpc_cents
  FROM "AmazonAdsDailyPerformance"
  WHERE "entityType"='CAMPAIGN' AND date > now() - interval '30 days'
  GROUP BY 1 ORDER BY 2 DESC`))

show('E. placement multipliers — these STACK on the base bid', await q(`
  SELECT x->>'placement' AS placement, MAX((x->>'percentage')::int) AS max_pct, COUNT(*) AS campaigns
  FROM "Campaign" c, jsonb_array_elements(c."dynamicBidding"->'placementBidding') x
  WHERE c."dynamicBidding" ? 'placementBidding' GROUP BY 1 ORDER BY 2 DESC`))
await p.$disconnect()

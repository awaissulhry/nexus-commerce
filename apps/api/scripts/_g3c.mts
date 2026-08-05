import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
show('uncapped targets reachable from an ENABLED schedule', await q(`
  SELECT rt.key, rt."maxCpcCents", rt."acosCapPct", rt."allOut",
         COUNT(DISTINCT s.id) FILTER (WHERE s.enabled) AS enabled_schedules
  FROM "RankTarget" rt
  LEFT JOIN "AdSchedule" s
    ON s."defaultTargetKey" = rt.key OR s.windows::text LIKE '%"' || rt.key || '"%'
  GROUP BY 1,2,3,4 ORDER BY 5 DESC`))
show('worst-case effective CPC = peak base bid x (1 + max TOP bias)', await q(`
  WITH bids AS (
    SELECT c.marketplace, MAX(m."intendedValue"::int) AS peak_bid
    FROM "AdMutation" m JOIN "AdTarget" t ON t.id=m."entityId"
    JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
    WHERE m.field='bid' AND m."createdAt" > now() - interval '30 days' AND m."intendedValue" ~ '^[0-9]+$'
    GROUP BY 1),
  bias AS (
    SELECT c.marketplace, MAX((x->>'percentage')::int) AS max_top
    FROM "Campaign" c, jsonb_array_elements(c."dynamicBidding"->'placementBidding') x
    WHERE x->>'placement'='PLACEMENT_TOP' GROUP BY 1)
  SELECT b.marketplace, b.peak_bid AS peak_base_bid_cents, bi.max_top AS max_top_bias_pct,
         ROUND(b.peak_bid * (1 + bi.max_top/100.0)) AS worst_effective_cpc_cents
  FROM bids b JOIN bias bi ON bi.marketplace=b.marketplace ORDER BY 4 DESC`))
await p.$disconnect()

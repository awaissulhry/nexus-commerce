import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
show('rank-engine coverage vs the campaign estate', await q(`
  SELECT
    (SELECT COUNT(*) FROM "Campaign")                                    AS all_campaigns,
    (SELECT COUNT(*) FROM "Campaign" WHERE status='ENABLED')             AS enabled_campaigns,
    (SELECT COUNT(*) FROM "AdSchedule")                                  AS schedules,
    (SELECT COUNT(*) FROM "AdSchedule" WHERE enabled)                    AS schedules_enabled,
    (SELECT COUNT(DISTINCT "campaignId") FROM "AdSchedule" WHERE enabled) AS campaigns_covered`))
show('ENABLED campaigns with spend but NO rank schedule (the gap B must fill)', await q(`
  SELECT COUNT(*) AS uncovered_with_spend,
         ROUND(SUM(c.spend)::numeric, 2) AS their_spend
  FROM "Campaign" c
  WHERE c.status='ENABLED' AND c.spend > 0
    AND NOT EXISTS (SELECT 1 FROM "AdSchedule" s WHERE s."campaignId"=c.id AND s.enabled)`))
show('covered campaigns — spend share', await q(`
  SELECT CASE WHEN EXISTS (SELECT 1 FROM "AdSchedule" s WHERE s."campaignId"=c.id AND s.enabled)
              THEN 'rank-engine covered' ELSE 'uncovered' END AS bucket,
         COUNT(*) AS campaigns, ROUND(SUM(c.spend)::numeric,2) AS spend
  FROM "Campaign" c WHERE c.status='ENABLED' GROUP BY 1 ORDER BY 3 DESC`))
show('RankScheduleGroups (the bulk-authoring answer)', await q(`
  SELECT COUNT(*) AS groups, SUM(CASE WHEN enabled THEN 1 ELSE 0 END) AS enabled,
         COUNT(*) FILTER (WHERE "portfolioId" IS NOT NULL) AS portfolio_scoped
  FROM "RankScheduleGroup"`))
await p.$disconnect()

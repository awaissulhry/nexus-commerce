import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))

show('1. allowlist today', await q(`
  SELECT "liveBidWritesEnabled" AS allowlisted, status, COUNT(*) AS n
  FROM "Campaign" GROUP BY 1,2 ORDER BY 3 DESC`))

show('2. which campaigns have ACTUALLY been written to (90d)?', await q(`
  SELECT c.status,
         COUNT(DISTINCT c.id) FILTER (WHERE m.id IS NOT NULL) AS written_to,
         COUNT(DISTINCT c.id) FILTER (WHERE m.id IS NULL)     AS never_written
  FROM "Campaign" c
  LEFT JOIN "AdGroup" g ON g."campaignId" = c.id
  LEFT JOIN "AdTarget" t ON t."adGroupId" = g.id
  LEFT JOIN "AdMutation" m ON m."entityId" = t.id AND m."createdAt" > now() - interval '90 days'
  GROUP BY 1 ORDER BY 2 DESC`))

show('3. campaigns under an ENABLED rank schedule (the actively managed set)', await q(`
  SELECT c.status, COUNT(DISTINCT c.id) AS n
  FROM "Campaign" c JOIN "AdSchedule" s ON s."campaignId"=c.id AND s.enabled
  GROUP BY 1 ORDER BY 2 DESC`))

show('4. the honest split — managed vs dormant', await q(`
  WITH managed AS (
    SELECT DISTINCT c.id FROM "Campaign" c
    LEFT JOIN "AdSchedule" s ON s."campaignId"=c.id AND s.enabled
    LEFT JOIN "AdGroup" g ON g."campaignId"=c.id
    LEFT JOIN "AdTarget" t ON t."adGroupId"=g.id
    LEFT JOIN "AdMutation" m ON m."entityId"=t.id AND m."createdAt" > now() - interval '90 days'
    WHERE s.id IS NOT NULL OR m.id IS NOT NULL OR c.status='ENABLED'
  )
  SELECT CASE WHEN mn.id IS NOT NULL THEN 'managed (schedule / recent write / ENABLED)'
              ELSE 'dormant (no schedule, no write in 90d, not ENABLED)' END AS bucket,
         COUNT(*) AS campaigns
  FROM "Campaign" c LEFT JOIN managed mn ON mn.id = c.id GROUP BY 1 ORDER BY 2 DESC`))
await p.$disconnect()

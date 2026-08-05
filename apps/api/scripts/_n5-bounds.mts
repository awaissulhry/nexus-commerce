import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
show('per-rule spend caps on the gate-open rules', await q(`
  SELECT name, "maxExecutionsPerDay" AS per_day, "maxValueCentsEur" AS per_exec_cents,
         "maxDailyAdSpendCentsEur" AS per_day_cents
  FROM "AutomationRule" WHERE domain='advertising' AND enabled AND "dryRun"
  ORDER BY name LIMIT 20`))
show('campaign-level change clamps (dynamicBidding.maxBidChangePct)', await q(`
  SELECT COUNT(*) FILTER (WHERE "dynamicBidding" ? 'maxBidChangePct') AS with_change_clamp,
         COUNT(*) FILTER (WHERE "dynamicBidding" ? 'cpcCeiling')      AS with_cpc_ceiling,
         COUNT(*) FILTER (WHERE "maxBidCents" IS NOT NULL)            AS with_abs_max,
         COUNT(*) AS total
  FROM "Campaign" WHERE "liveBidWritesEnabled"`))
await p.$disconnect()

import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
show('write-gate blast radius: campaigns writable at all?', await q(`
  SELECT "liveBidWritesEnabled" AS allowlisted, status, COUNT(*) AS n
  FROM "Campaign" GROUP BY 1,2 ORDER BY 3 DESC`))
show('the retail guard rule as it stands', await q(`
  SELECT name, enabled, "dryRun", trigger, "maxExecutionsPerDay" AS cap, "scopeMarketplace"
  FROM "AutomationRule" WHERE domain='advertising' AND name ILIKE '%retail guard%'`))
show('ads connections', await q(`
  SELECT marketplace, mode, ("writesEnabledAt" IS NOT NULL) AS writes_enabled, "isActive"
  FROM "AmazonAdsConnection" ORDER BY marketplace`))
await p.$disconnect()

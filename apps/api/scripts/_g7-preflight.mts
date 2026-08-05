import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
show('1. account autonomy state (SUGGEST here forces dry-run regardless of the rule)', await q(`
  SELECT * FROM "AdsAutomationState" LIMIT 2`))
show('2. the retail guard rule', await q(`
  SELECT id, name, enabled, "dryRun", "maxExecutionsPerDay" AS cap, "scopeMarketplace",
         left(actions::text, 200) AS actions
  FROM "AutomationRule" WHERE domain='advertising' AND name = '🛡 Retail guard'`))
show('3. protections in place before arming', await q(`SELECT mode, COUNT(*) AS n FROM "AdKeywordProtection" GROUP BY 1`))
show('4. allowlist', await q(`
  SELECT "liveBidWritesEnabled" AS allowed, COUNT(*) AS n FROM "Campaign" GROUP BY 1`))
await p.$disconnect()

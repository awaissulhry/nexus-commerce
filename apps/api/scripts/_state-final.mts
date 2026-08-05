import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n${t}\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
show('AUTONOMY', await q(`
  SELECT CASE WHEN NOT enabled THEN 'off'
              WHEN "dryRun" THEN 'proposes - needs approval'
              ELSE 'AUTONOMOUS' END AS mode, COUNT(*) AS rules
  FROM "AutomationRule" WHERE domain='advertising' GROUP BY 1 ORDER BY 2 DESC`))
show('GUARDRAILS', await q(`
  SELECT
    (SELECT COUNT(*) FROM "Campaign" WHERE "liveBidWritesEnabled") AS writable_campaigns,
    (SELECT COUNT(*) FROM "Campaign" WHERE "liveBidWritesEnabled" AND "maxBidCents" IS NOT NULL) AS with_bid_ceiling,
    (SELECT COUNT(*) FROM "AdKeywordProtection") AS protected_terms,
    (SELECT COUNT(*) FROM "AdsRuleSuggestion" WHERE status='pending') AS pending_proposals`))
await p.$disconnect()

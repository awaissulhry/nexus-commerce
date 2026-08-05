import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = <T = Record<string, unknown>>(s: string) => p.$queryRawUnsafe<T[]>(s)
const h = (s: string) => console.log(`\n── ${s} ──`)

h('AdsRuleSuggestion.proposedAction — is there a € in it?')
console.log(await q(`SELECT "ruleName", "entityType", "proposedKey", "proposedAction"
  FROM "AdsRuleSuggestion" WHERE status='pending' ORDER BY "createdAt" DESC LIMIT 4`))

h('pending by rule + age')
console.log(await q(`SELECT COALESCE("ruleName",'(unnamed)') AS rule, COUNT(*)::int AS pending,
  MIN("createdAt")::text AS oldest FROM "AdsRuleSuggestion" WHERE status='pending' GROUP BY 1 ORDER BY 2 DESC`))

h('RankTarget columns')
console.log(await q(`SELECT column_name, data_type FROM information_schema.columns
  WHERE table_name='RankTarget' ORDER BY ordinal_position`))

h('RankTarget rows')
console.log(await q(`SELECT * FROM "RankTarget" LIMIT 5`))

h('AdMutation FAILED, last 7d — what failed and is it still failing')
console.log(await q(`SELECT field, COUNT(*)::int AS rows, MAX("createdAt")::text AS newest,
  LEFT(MAX("lastError"), 90) AS sample
  FROM "AdMutation" WHERE state='FAILED' AND "createdAt" > now() - interval '7 days'
  GROUP BY 1 ORDER BY 2 DESC`))

h('non-delivering enabled campaigns + their 30d spend')
console.log(await q(`SELECT c.name, c.marketplace, c."deliveryReasons",
    COALESCE(SUM(d."costMicros")/10000, 0)::int AS spend30d_c
  FROM "Campaign" c
  LEFT JOIN "AmazonAdsDailyPerformance" d ON d."entityType"='CAMPAIGN' AND d."entityId"=c."externalCampaignId"
    AND d.date > now() - interval '30 days'
  WHERE c.status='ENABLED' AND c."deliveryStatus"='NOT_DELIVERING'
  GROUP BY 1,2,3`))

await p.$disconnect()

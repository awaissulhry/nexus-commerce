import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = <T = Record<string, unknown>>(s: string) => p.$queryRawUnsafe<T[]>(s)

console.log('\nloser-campaign targets on the consolidated terms — bid state now:')
const rows = await q(`
  SELECT c.name AS campaign, COUNT(*)::int AS targets,
         COUNT(*) FILTER (WHERE t."bidCents" <= 5)::int AS at_floor,
         COUNT(*) FILTER (WHERE t."suppressedFromBidCents" IS NOT NULL)::int AS remembered
  FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE c.marketplace='IT' AND t.kind='KEYWORD' AND t."isNegative"=false AND t.status='ENABLED'
    AND c.name IN ('GALE BROAD IT','GALE EXACT IT','GALE PHRASE IT','IT_Exact_Gale_SV=2k+_Key=1','IT_Exact_Gale_SV=6k+_Key=1','Exact_Gale_SV_LessThan_1k_Key=1')
    AND LOWER(t."expressionValue") IN ('giacca moto','giacca moto uomo','giubbotto moto','giubbotto moto uomo')
  GROUP BY 1 ORDER BY 1`)
for (const r of rows) console.log('  ' + Object.entries(r).map(([k, v]) => `${k}=${v}`).join('  '))

console.log('\nchampions untouched (bids intact):')
const champs = await q(`
  SELECT c.name AS campaign, t."expressionValue" AS term, t."bidCents"
  FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE c.name IN ('GALE | IT | Exact | Category','GALE | IT | Phrase | Category','GALE BROAD IT')
    AND LOWER(t."expressionValue") IN ('giacca moto uomo','giacca moto') AND t."isNegative"=false AND t.status='ENABLED'
  ORDER BY 1,2 LIMIT 8`)
for (const r of champs) console.log('  ' + Object.entries(r).map(([k, v]) => `${k}=${v}`).join('  '))
await p.$disconnect()

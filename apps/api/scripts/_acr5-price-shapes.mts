import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = <T = Record<string, unknown>>(s: string) => p.$queryRawUnsafe<T[]>(s)
const h = (s: string) => console.log(`\n── ${s} ──`)

h('proposedKey shapes and a sample action')
const rows = await q<Record<string, unknown>>(`
  SELECT "proposedKey", "entityType", COUNT(*)::int AS n,
         (ARRAY_AGG("proposedAction"))[1] AS sample
  FROM "AdsRuleSuggestion" WHERE status='pending' GROUP BY 1,2 ORDER BY 3 DESC`)
for (const r of rows) console.log(`  ${String(r.proposedKey).padEnd(28)} ${String(r.entityType).padEnd(12)} n=${r.n}  ${JSON.stringify(r.sample).slice(0, 150)}`)

h('can we join a proposal to 30d target-grain spend? (the pricing input)')
console.log(await q(`
  SELECT COUNT(*)::int AS proposals,
         COUNT(*) FILTER (WHERE t.id IS NOT NULL)::int AS resolve_to_a_target,
         COUNT(*) FILTER (WHERE d."entityId" IS NOT NULL)::int AS have_30d_spend
  FROM "AdsRuleSuggestion" s
  LEFT JOIN "AdTarget" t ON t.id = s."entityId"
  LEFT JOIN (SELECT "entityId", SUM("costMicros") AS c FROM "AmazonAdsDailyPerformance"
             WHERE "entityType"='AD_TARGET' GROUP BY 1) d ON d."entityId" = t."externalTargetId"
  WHERE s.status='pending' AND s."entityType"='AD_TARGET'`))

h('what those targets actually cost in 30d — the money the proposals are about')
console.log(await q(`
  SELECT COUNT(DISTINCT t.id)::int AS targets,
         ROUND((SUM(d.c)/1e6)::numeric,2) AS spend_30d_eur,
         SUM(d.clicks)::int AS clicks, ROUND((SUM(d.sales)/100.0)::numeric,2) AS sales_eur
  FROM "AdsRuleSuggestion" s
  JOIN "AdTarget" t ON t.id = s."entityId"
  JOIN (SELECT "entityId", SUM("costMicros") AS c, SUM(clicks) AS clicks, SUM("sales7dCents") AS sales
        FROM "AmazonAdsDailyPerformance" WHERE "entityType"='AD_TARGET' GROUP BY 1) d
    ON d."entityId" = t."externalTargetId"
  WHERE s.status='pending'`))

await p.$disconnect()

import { config } from 'dotenv'
config({ path: '/Users/awais/nexus-commerce/.env' })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const { computeBudgetEnforcement } = await import('../src/services/advertising/ads-budget-enforce.service.js')
const r = await computeBudgetEnforcement({ month: '2026-08' })

// actual daily spend per campaign over the last 14 days
const rows = await p.$queryRawUnsafe<Array<{ localEntityId: string; eur_per_day: string }>>(`
  SELECT "localEntityId", round((SUM("costMicros")/1e6/14)::numeric,2) AS eur_per_day
  FROM "AmazonAdsDailyPerformance"
  WHERE "entityType"='CAMPAIGN' AND date > now() - interval '14 days' AND "localEntityId" IS NOT NULL
  GROUP BY 1`)
const spendBy = new Map(rows.map((x) => [x.localEntityId, Number(x.eur_per_day)]))

const all = r.plans.flatMap((pl) => pl.campaigns.map((c) => ({ ...c, mk: pl.marketplace })))
// targetDailyCents === null means "leave this campaign alone" — NOT a budget of zero.
// Treating null as 0 reported 53 of 54 campaigns as throttled while the engine was
// changing two, which is the measuring instrument being wrong rather than the engine.
const withSpend = all.map((c) => ({ ...c, spend: spendBy.get(c.id) ?? 0 }))
  .filter((c) => c.spend > 0).sort((a, b) => b.spend - a.spend)

console.log('\nTop spenders — actual daily spend vs the budget enforcement would set:')
console.log('  spend/day   new budget   verdict   campaign')
let throttled = 0
for (const c of withSpend.slice(0, 15)) {
  const nb = c.targetDailyCents == null ? null : c.targetDailyCents / 100
  const bad = nb != null && nb < c.spend
  if (bad) throttled++
  console.log(`  ${String(c.spend.toFixed(2)).padStart(8)}  ${(nb == null ? 'unchanged' : nb.toFixed(2)).padStart(10)}   ${bad ? 'THROTTLED' : 'ok       '}  ${c.mk} ${c.name.slice(0, 40)}`)
}
const allThrottled = withSpend.filter((c) => c.targetDailyCents != null && c.targetDailyCents / 100 < c.spend)
console.log(`\ncampaigns with real spend: ${withSpend.length}; would be throttled below current spend: ${allThrottled.length}`)
console.log(`their combined current spend: EUR ${allThrottled.reduce((s, c) => s + c.spend, 0).toFixed(2)}/day`)
await p.$disconnect()

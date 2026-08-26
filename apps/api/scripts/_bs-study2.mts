/** BS part 2 — Budget Manager plans + hourly coverage sanity. READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const plans = await prisma.adBudgetPlan.findMany({
  select: { id: true, marketplace: true, month: true, monthlyBudgetCents: true, autoPacing: true, stopOverSpend: true, tag: true },
})
console.log(`\nAdBudgetPlan (Budget Manager) rows: ${plans.length}`)
for (const p of plans) console.log(`  ${p.marketplace} ${p.month}  €${(p.monthlyBudgetCents / 100).toFixed(2)}/mo  autoPacing=${p.autoPacing} stopOverSpend=${p.stopOverSpend} tag=${p.tag ?? '—'}`)

const h = await prisma.$queryRaw<Array<{ n: bigint; sp: bigint | null; d0: Date | null; d1: Date | null; camps: bigint }>>`
  SELECT COUNT(*)::bigint AS n, SUM("costMicros") AS sp, MIN("date") AS d0, MAX("date") AS d1,
         COUNT(DISTINCT "campaignId")::bigint AS camps
  FROM "AmazonAdsHourlyPerformance" WHERE "date" >= NOW() - INTERVAL '60 days'`
const r = h[0]
console.log(`\nAmazonAdsHourlyPerformance, 60d: ${Number(r.n)} rows · ${Number(r.camps)} campaigns · €${(Number(r.sp ?? 0n) / 1e6).toFixed(2)} spend`)
console.log(`  window ${r.d0?.toISOString().slice(0, 10)} → ${r.d1?.toISOString().slice(0, 10)}`)
const pl = await prisma.amazonAdsPlacementReport.aggregate({ where: { date: { gte: new Date(Date.now() - 60 * 86400000) } }, _sum: { costMicros: true } })
console.log(`  placement report over the same window: €${(Number(pl._sum.costMicros ?? 0n) / 1e6).toFixed(2)} spend`)
console.log(`  → hourly covers ${((Number(r.sp ?? 0n) / Math.max(1, Number(pl._sum.costMicros ?? 0n))) * 100).toFixed(0)}% of measured spend`)
await prisma.$disconnect()

import '../src/env.js'
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()

const month = '2026-08'
const plans = await p.adBudgetPlan.findMany({
  where: { month }, orderBy: [{ marketplace: 'asc' }, { createdAt: 'asc' }],
  select: { id: true, marketplace: true, tag: true, monthlyBudgetCents: true, autoPacing: true, stopOverSpend: true, updatedAt: true, calendar: true },
})
console.log(`AdBudgetPlan rows for ${month}: ${plans.length}`)
for (const r of plans) {
  const cal = (r.calendar as unknown[]) ?? []
  console.log(`  ${r.marketplace} tag=${r.tag ?? 'null'} cap=EUR ${(r.monthlyBudgetCents/100).toFixed(2)} pacing=${r.autoPacing} stop=${r.stopOverSpend} calDays=${cal.length} updated=${r.updatedAt.toISOString()}`)
}
const byMkt = new Map<string, number>()
for (const r of plans) byMkt.set(r.marketplace, (byMkt.get(r.marketplace) ?? 0) + 1)
const dupes = [...byMkt].filter(([, n]) => n > 1)
console.log(`\nIDEMPOTENCY: ${dupes.length === 0 ? 'PASS - one plan per market, two writes created none' : 'FAIL - ' + JSON.stringify(dupes)}`)

const since = new Date(Date.now() - 40 * 60 * 1000)
const total = await p.advertisingActionLog.count({ where: { createdAt: { gte: since } } })
const budget = await p.advertisingActionLog.count({ where: { createdAt: { gte: since }, actionType: { contains: 'BUDGET' } } })
console.log(`\nAUDIT last 40 min: ${total} action-log rows, ${budget} with BUDGET in actionType`)
console.log(budget === 0 ? 'NOTE: a cap edit leaves NO AdvertisingActionLog row - upsertBudgetPlan only logger.info()s, and only on create.' : '')
await p.$disconnect()

import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { ruleWindowBounds } = await import('@nexus/shared/data-vintage')
const { microsToCents } = await import('../src/services/ads-core/metrics-math.js')
const { since, until } = ruleWindowBounds(7)
const camps = await prisma.campaign.findMany({ where: { status: 'ENABLED' }, select: { id: true, name: true, marketplace: true, dailyBudget: true } })
const perf = await prisma.amazonAdsDailyPerformance.groupBy({
  by: ['localEntityId'], where: { entityType: 'CAMPAIGN', localEntityId: { in: camps.map(c => c.id) }, date: { gte: since, lte: until } },
  _sum: { costMicros: true, sales7dCents: true, sales14dCents: true, orders7d: true },
})
const byId = new Map(perf.map(p => [p.localEntityId!, p]))
let reach = 0, cutSurface = 0, acos40plus = 0, spend50 = 0, cutMatch = 0, util90 = 0, raiseMatch = 0, idleMatch = 0
for (const c of camps) {
  const p = byId.get(c.id); const spendCents = microsToCents(p?._sum.costMicros)
  if (spendCents === 0) continue
  reach++
  const budgetCents = Math.round(Number(c.dailyBudget) * 100)
  const atFloor = budgetCents <= 100
  if (!atFloor) cutSurface++
  const salesCents = (p?._sum.sales7dCents ?? 0) + (p?._sum.sales14dCents ?? 0)
  const acos = salesCents > 0 ? spendCents / salesCents : null
  const orders = p?._sum.orders7d ?? 0
  const util = budgetCents > 0 ? Math.round(spendCents / 7) / budgetCents : null
  if (acos != null && acos >= 0.4) acos40plus++
  if (spendCents >= 5000) spend50++
  if (acos != null && acos >= 0.4 && spendCents >= 5000) { cutMatch++; }
  if (util != null && util >= 0.9) util90++
  if (acos != null && acos <= 0.2 && orders >= 2 && util != null && util >= 0.9) raiseMatch++
  if (util != null && util <= 0.1 && spendCents >= 500) idleMatch++
}
console.log(`reachable (ENABLED + spend in 7d settled): ${reach}`)
console.log(`  of those, ABOVE the €1 floor (a cut can actually move them): ${cutSurface}`)
console.log(`  ACoS >= 40%: ${acos40plus} · spend >= EUR50: ${spend50}`)
console.log(`STARTER MATCH COUNTS today:`)
console.log(`  "Trim high-ACoS spend"  (ACoS>=40 AND spend>=EUR50 -> -15%): ${cutMatch}`)
console.log(`  "Feed capped winners"   (ACoS<=20 AND orders>=2 AND util>=90% -> +20%): ${raiseMatch}   [util>=90% alone: ${util90}]`)
console.log(`  "Reclaim idle budget"   (util<=10% AND spend>=EUR5 -> -25%): ${idleMatch}`)
await prisma.$disconnect()

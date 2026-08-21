import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { ruleWindowBounds } = await import('@nexus/shared/data-vintage')
const { microsToCents } = await import('../src/services/ads-core/metrics-math.js')
const { since, until } = ruleWindowBounds(7)
const camps = await prisma.campaign.findMany({ where: { status: 'ENABLED' }, select: { id: true, name: true, marketplace: true, dailyBudget: true, adProduct: true, targetingType: true, portfolioId: true } })
const perf = await prisma.amazonAdsDailyPerformance.groupBy({
  by: ['localEntityId'], where: { entityType: 'CAMPAIGN', localEntityId: { in: camps.map(c=>c.id) }, date: { gte: since, lte: until } }, _sum: { costMicros: true } })
const byId = new Map(perf.map(p=>[p.localEntityId!, p]))
console.log('MATCHES for "Reclaim idle budget" (util <= 10% AND spend >= EUR5):')
for (const c of camps) {
  const sc = microsToCents(byId.get(c.id)?._sum.costMicros); if (sc === 0) continue
  const b = Math.round(Number(c.dailyBudget)*100); const util = b>0 ? (sc/7)/b : null
  if (util != null && util <= 0.10 && sc >= 500)
    console.log(`  ${c.marketplace} | ${c.name}  budget EUR${(b/100).toFixed(2)} spend EUR${(sc/100).toFixed(2)} util ${(util*100).toFixed(1)}% -> -25% = EUR${Math.max(1,(b/100)*0.75).toFixed(2)}`)
}
await prisma.$disconnect()

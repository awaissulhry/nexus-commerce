import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { ruleWindowBounds } = await import('@nexus/shared/data-vintage')
const { microsToCents } = await import('../src/services/ads-core/metrics-math.js')
const { since, until } = ruleWindowBounds(7)
const names = ['DE_Auto_Substitute', 'DE_Exact_3_Keywords', 'GALE PHRASE DE']
for (const n of names) {
  const c = await prisma.campaign.findFirst({ where: { name: n, status: 'ENABLED' }, select: { id: true, name: true, dailyBudget: true, updatedAt: true } })
  if (!c) { console.log(`${n}: NOT FOUND/ENABLED`); continue }
  const p = await prisma.amazonAdsDailyPerformance.groupBy({ by: ['localEntityId'], where: { entityType: 'CAMPAIGN', localEntityId: c.id, date: { gte: since, lte: until } }, _sum: { costMicros: true } })
  const sc = microsToCents(p[0]?._sum.costMicros)
  const b = Math.round(Number(c.dailyBudget) * 100)
  const avg = Math.round(sc / 7)
  const util = b > 0 ? avg / b : null
  console.log(`${n}: budget EUR${(b/100).toFixed(2)} spend EUR${(sc/100).toFixed(2)} avgDaily EUR${(avg/100).toFixed(2)} util ${util==null?'n/a':(util*100).toFixed(2)+'%'} -> util<=10%? ${util!=null&&util<=0.10} spend>=EUR5? ${sc>=500}`)
  const recent = await prisma.advertisingActionLog.findMany({ where: { actionType: 'AD_BUDGET_UPDATE', entityId: c.id, createdAt: { gte: new Date(Date.now() - 6*3600e3) } }, orderBy: { createdAt: 'desc' }, take: 4, select: { createdAt: true, userId: true, payloadBefore: true, payloadAfter: true } })
  for (const r of recent) console.log(`    pacer ${r.createdAt.toISOString()} ${r.userId} ${JSON.stringify(r.payloadBefore)} -> ${JSON.stringify(r.payloadAfter)}`)
}
await prisma.$disconnect()

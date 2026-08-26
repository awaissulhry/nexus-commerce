import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const c = await prisma.campaign.groupBy({ by: ['deliveryStatus'], _count: { _all: true } })
console.log('deliveryStatus NOW:', c.map(r => `${r.deliveryStatus ?? 'null'}×${r._count._all}`).join(' · '))
const s = await prisma.campaign.groupBy({ by: ['status'], _count: { _all: true } })
console.log('status NOW        :', s.map(r => `${r.status}×${r._count._all}`).join(' · '))
const p = await prisma.amazonAdsPortfolio.count().catch((e) => { console.log('portfolio count FAILED:', String(e).slice(0,60)); return null })
console.log('AmazonAdsPortfolio rows:', p)
if (p) {
  const rows = await prisma.amazonAdsPortfolio.findMany({ select: { externalPortfolioId: true, name: true, state: true } })
  console.log('   ', rows.map(r => `${r.name}(${r.externalPortfolioId})`).join(' · '))
}
const sync = await prisma.campaign.aggregate({ _max: { lastSyncedAt: true } })
console.log('newest lastSyncedAt:', sync._max.lastSyncedAt?.toISOString())
await prisma.$disconnect()

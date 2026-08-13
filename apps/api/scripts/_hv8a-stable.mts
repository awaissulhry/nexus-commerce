/** Is previewHarvest stable across calls in one process? READ-ONLY. */
import '../src/env.js'
const { previewHarvest } = await import('../src/services/advertising/ads-harvest.service.js')
const { default: prisma } = await import('../src/db.js')
for (let i=0;i<3;i++) {
  const p = await previewHarvest({ windowDays: 60, minSpendCents: 1000, minOrders: 2 })
  console.log(`  run ${i+1}: negatives=${p.negatives.length} graduations=${p.graduations.length} prodNeg=${p.productNegatives.length} prodGrad=${p.productGraduations.length}`)
}
// and with the ENGINE's own params (ads-auto-harvest passes none → handler defaults)
const d = await previewHarvest({})
console.log(`  defaults: negatives=${d.negatives.length} graduations=${d.graduations.length} (window ${d.windowDays}d)`)
const newest = await prisma.amazonAdsSearchTerm.aggregate({ _max: { date: true } })
console.log(`  newest search-term date: ${newest._max.date?.toISOString().slice(0,10)}`)
await prisma.$disconnect()

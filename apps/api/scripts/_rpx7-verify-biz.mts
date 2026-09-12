/** READ-ONLY. RPX — run the fixed businessContext() and check the numbers. */
import '../src/env.js'
const { businessContext } = await import('../src/services/advertising/ads-business-context.service.js')
const r = await businessContext({ from: '2026-06-15', to: '2026-08-26', marketplaces: ['IT'] })
console.log('window       ', r.window, 'markets', r.marketplaces)
console.log('completeThru ', r.completeThrough)
console.log('totals       ', JSON.stringify(r.totals))
console.log('\nseries:')
for (const w of r.series) {
  console.log(`  ${w.weekStart}  spend ${w.adSpend.toFixed(2).padStart(8)}  adSales ${w.adSales.toFixed(2).padStart(9)}  total ${w.totalSales.toFixed(2).padStart(9)}  tacos ${w.tacos == null ? '  —  ' : (w.tacos * 100).toFixed(2).padStart(6)}%  ${w.partial ? 'PARTIAL' : ''}`)
}
console.log('\ncaveats:'); for (const c of r.caveats) console.log('  ·', c)
const { default: prisma } = await import('../src/db.js')
await prisma.$disconnect()

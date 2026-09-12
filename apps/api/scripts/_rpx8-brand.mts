/** READ-ONLY. RPX — verify brandStrategy() is node-safe and matches the honest figures. */
import '../src/env.js'
const { brandStrategy } = await import('../src/services/advertising/ads-brand-strategy.service.js')
const it = await brandStrategy({ marketplace: 'IT', weeks: 12 })
console.log('MARKET      ', it.marketplace, '| brand', it.brandName, '| week', it.week, '| lag', it.lagDays, 'd | weeksHeld', it.weeksHeld)
console.log('NODE        ', it.node?.name, '| depth', it.node?.depth, '| root?', it.node?.isRoot, '| of', it.nodes.length, 'nodes')
console.log('INDICES     ', JSON.stringify(it.indices))
console.log('\nSTAGES')
for (const s of it.stages) {
  console.log(`  ${s.label.padEnd(15)} index ${String(s.index ?? '—').padStart(7)}`)
  for (const m of s.metrics) console.log(`      ${m.label.padEnd(30)} ours ${String(m.value ?? '—').padStart(8)}  med ${String(m.median ?? '—').padStart(8)}  top ${String(m.top ?? '—').padStart(9)}  ${m.verdict}`)
}
console.log('\nRANKED BENCHMARKS (furthest from median first)')
for (const b of it.benchmarks) {
  console.log(`  ${b.label.padEnd(34)} ours ${String(b.value ?? '—').padStart(8)}  med ${String(b.median ?? '—').padStart(8)}  ratio ${b.ratio == null ? '   —  ' : b.ratio.toFixed(2).padStart(6)}  dist ${b.distance == null ? '  —  ' : b.distance.toFixed(3)}  ${b.verdict}${b.discriminates ? '' : '  [CANNOT DISCRIMINATE]'}`)
}
console.log('\nBANDS'); for (const b of it.bands) console.log(' ', JSON.stringify(b))
console.log('\nSERIES'); for (const p of it.series) console.log(`  ${p.week}  cust ${String(p.brandCustomers ?? '—').padStart(4)}  carts ${String(p.addToCarts ?? '—').padStart(4)}  dpv ${String(p.viewedDetailPageOnly ?? '—').padStart(5)}  median ${p.brandCustomersMedian ?? '—'}`)
console.log('\nFRESHNESS'); for (const f of it.freshness) console.log(' ', JSON.stringify(f))
console.log('\nCAVEATS'); for (const c of it.caveats) console.log('  ·', c)
const all = await brandStrategy({ marketplace: null })
console.log('\nALL-MARKETS RATIO VIEW')
for (const m of all.byMarket) {
  const pick = (id: string) => m.benchmarks.find((b) => b.id === id)
  const f = (id: string) => { const b = pick(id); return b?.ratio == null ? '   —  ' : `${b.ratio.toFixed(2)}×` }
  console.log(`  ${m.marketplace}  ${m.week}  aw ${String(m.indices.awareness ?? '—').padStart(6)}  dpv ${f('viewedDetailPageOnly')}  carts ${f('addToCarts')}  cust ${f('brandCustomers')}  cvr ${f('customerConversionRate')}   node ${m.node.slice(0, 28)}`)
}
const { default: prisma } = await import('../src/db.js'); await prisma.$disconnect()

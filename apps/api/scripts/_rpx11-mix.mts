import '../src/env.js'
const { businessContext } = await import('../src/services/advertising/ads-business-context.service.js')
for (const mkts of [[], ['IT']] as string[][]) {
  const r = await businessContext({ from: '2026-06-15', to: '2026-08-26', marketplaces: mkts })
  console.log(`\nMARKETS ${mkts.length ? mkts.join(',') : 'all'}`)
  for (const m of r.adMix) console.log(`  ${m.adProduct.padEnd(4)} campaigns ${String(m.campaigns).padStart(4)}  enabled ${String(m.enabled).padStart(3)}  spend €${m.spend.toFixed(2)}`)
  const amc = r.caveats.find((c) => c.includes('one circle'))
  console.log('  AMC caveat:', amc ? amc.slice(0, 140) : '(none)')
}
const { default: prisma } = await import('../src/db.js'); await prisma.$disconnect()

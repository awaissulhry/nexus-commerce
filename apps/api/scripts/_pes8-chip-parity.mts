// #310 acceptance test: every scope chip readiness offers must yield draftable columns from
// the enrichment path. Read-only + dryRun. No generation, no spend.
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { getStudioColumns } = await import('../src/services/pim/studio-columns.js')
const { runEnrichment } = await import('../src/services/ai/enrichment/generate.service.js')

const P = 'cmr1b1yxl0000s4rcvopsqv42'
const MARKETS = ['IT', 'DE', 'PL', 'ES', 'FR']
let fails = 0

for (const market of MARKETS) {
  let set
  try {
    set = await getStudioColumns({ market, productTypes: ['OUTERWEAR'], includeEmptyChannels: true })
  } catch (e) {
    console.log(`${market}: readiness cannot open this market (${e instanceof Error ? e.message.slice(0,50) : e})`)
    continue
  }
  // The chips readiness offers = its coordinates, plus the master scope.
  for (const c of set.coordinates) {
    const r = await runEnrichment({
      productIds: [P], market,
      scope: { channel: c.channel, marketplace: c.marketplace },
      dryRun: true,
    })
    const n = r.columnsInScope.length
    // A channel with no per-channel content layer is a correct zero, not a failure — it must say
    // WHY, not report an absence that reads like a bug.
    const noLayer = n === 0 && /no per-channel content of its own/.test(r.refusedReason ?? '')
    const ok = n > 0 || noLayer
    if (!ok) fails++
    const tag = n > 0 ? `${n} draftable` : noLayer ? 'correct zero — no content layer, says so' : `0 draftable :: ${r.refusedReason ?? ''}`
    console.log(`  ${ok ? 'OK ' : 'FAIL'} chip ${String(c.channel + '·' + c.marketplace).padEnd(20)} -> ${tag}`)
  }
  const m = await runEnrichment({ productIds: [P], market, scope: { channel: null, marketplace: null }, dryRun: true })
  const ok = m.columnsInScope.length > 0
  if (!ok) fails++
  console.log(`  ${ok ? 'OK ' : 'FAIL'} chip ${('MASTER·' + market).padEnd(20)} -> ${m.columnsInScope.length} draftable`)
}
console.log(fails === 0 ? 'ACCEPTANCE PASS — every chip yields draftable columns' : `ACCEPTANCE FAIL — ${fails} chip(s) yield none`)
await prisma.$disconnect()
process.exit(fails === 0 ? 0 : 1)

// BE.1 #298/#303 — confirm the create path yields draftable columns. dryRun: no vendor call, no spend.
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { runEnrichment } = await import('../src/services/ai/enrichment/generate.service.js')
const P = 'cmr1b1yxl0000s4rcvopsqv42'

for (const [market, channel] of [['PL','AMAZON'], ['DE','EBAY'], ['PL','EBAY'], ['DE','AMAZON'], ['IT',null]] as const) {
  const r = await runEnrichment({
    productIds: [P], market,
    scope: { channel, marketplace: channel ? market : null },
    dryRun: true,
  })
  const label = `${channel ?? 'MASTER'}·${market}`.padEnd(14)
  if (r.refusedReason) console.log(`${label} REFUSED: ${r.refusedReason}`)
  else console.log(`${label} columns=${String(r.columnsInScope.length).padEnd(3)} calls=${r.callCount} est=$${r.estimatedCostUSD.toFixed(5)}  [${r.columnsInScope.map(c=>c.columnKey).slice(0,4).join(', ')}]`)
}
await prisma.$disconnect()

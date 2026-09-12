// BE.1 #298 — does omitting includeEmptyChannels starve the enrichment column set?
// Read-only. No generation, no spend.
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { getSheetColumns } = await import('../src/services/pim/sheet-columns.service.js')
const { draftableConstraints } = await import('../src/services/ai/enrichment/constraints.js')

const present = await prisma.channelListing.groupBy({ by: ['channel', 'marketplace'], _count: { _all: true } })
console.log('coordinates WITH listings anywhere:', present.map(p => `${p.channel}:${p.marketplace}`).sort().join(', '))

for (const market of ['IT', 'DE']) {
  for (const inc of [false, true]) {
    try {
      const set = await getSheetColumns({ market, productTypes: ['OUTERWEAR'], includeEmptyChannels: inc })
      const coords = set.coordinates.map(c => `${c.channel}:${c.marketplace}`).join(',')
      const draftable = draftableConstraints(set.columns)
      const amazonCaps = draftable.filter(c => c.capFrom).length
      console.log(`${market} includeEmptyChannels=${String(inc).padEnd(5)} coords=[${coords}] columns=${set.columns.length} draftable=${draftable.length} withCaps=${amazonCaps}`)
    } catch (e) {
      console.log(`${market} includeEmptyChannels=${inc} -> ${e instanceof Error ? e.message : e}`)
    }
  }
}
await prisma.$disconnect()

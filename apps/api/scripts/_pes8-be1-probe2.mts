import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { getSheetColumns } = await import('../src/services/pim/sheet-columns.service.js')
const { draftableConstraints } = await import('../src/services/ai/enrichment/constraints.js')
const { isDraftableField } = await import('../src/services/ai/enrichment/draft.service.js')

// Mirror applicableConstraints() for a CHANNEL scope.
const channelScope = (cols: any[], channel: string) =>
  draftableConstraints(cols).filter((c: any) => {
    if (!isDraftableField(c.writeField)) return false
    const isCh = c.writeField.startsWith('amazon_') || c.writeField.startsWith('ebay_')
    return isCh
  }).filter((c: any) => c.writeField.startsWith(channel.toLowerCase() + '_'))

for (const [market, channel] of [['DE', 'EBAY'], ['IT', 'EBAY'], ['DE', 'AMAZON']] as const) {
  for (const inc of [false, true]) {
    const set = await getSheetColumns({ market, productTypes: ['OUTERWEAR'], includeEmptyChannels: inc })
    const n = channelScope(set.columns, channel).length
    console.log(`${channel}:${market} includeEmptyChannels=${String(inc).padEnd(5)} -> ${n} draftable channel column(s)${n === 0 ? '   <-- "No draftable columns in this scope"' : ''}`)
  }
}
await prisma.$disconnect()

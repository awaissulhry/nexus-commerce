/** VT.1b P0 — the live proof: the schema now resolves for the SP-API id the publish payload carries. Read-only. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { loadAmazonThemeFacts, resolveAmazonMarketCode } = await import('../src/services/pim/variation-theme-facts.js')
const row = await prisma.marketplace.findFirst({ where: { channel: 'AMAZON', code: 'IT' }, select: { code: true, marketplaceId: true } })
console.log('Marketplace AMAZON/IT:', JSON.stringify(row))
const counts = await prisma.categorySchema.groupBy({ by: ['marketplace'], where: { channel: 'AMAZON' }, _count: { _all: true } })
console.log('CategorySchema.marketplace values (AMAZON):', counts.map(c => `${c.marketplace} ${c._count._all}`).join(' · '))
for (const key of [row!.code, row!.marketplaceId ?? '(none)']) {
  const code = await resolveAmazonMarketCode(key)
  const facts = await loadAmazonThemeFacts(key, 'SUIT')
  console.log(`key ${JSON.stringify(key)} → code ${JSON.stringify(code)} → SUIT schema ${facts ? `RESOLVED (${facts.facts.themes.length} themes, fetched ${facts.fetchedAt})` : 'null (could not look)'}`)
  if (facts) {
    const props = facts.facts.properties as Record<string, unknown>
    console.log(`   properties: color ${!!props.color} · fit_type ${!!props.fit_type} · size ${!!props.size} · size_name ${!!props.size_name}`)
  }
}
await prisma.$disconnect()

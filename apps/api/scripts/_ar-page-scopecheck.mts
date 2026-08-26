import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const r = await prisma.automationRule.findMany({ where: { domain: 'advertising' }, select: { name: true, enabled: true, autonomyLevel: true, scopeMarketplace: true } })
const en = r.filter(x => x.enabled)
const enScoped = en.filter(x => x.scopeMarketplace)
console.log(`enabled ${en.length} · enabled WITH a market scope ${enScoped.length}`)
for (const x of enScoped) console.log(`   ${x.scopeMarketplace}  ${x.autonomyLevel.padEnd(8)} ${x.name}`)
await prisma.$disconnect()

import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { id: true, name: true, enabled: true, autonomyLevel: true, trigger: true, actions: true, conditions: true, scopeMarketplace: true, createdAt: true },
  orderBy: { createdAt: 'desc' },
})
console.log(`advertising rules: ${rules.length}`)
for (const r of rules) {
  const a0 = (Array.isArray(r.actions) ? r.actions[0] : {}) as Record<string, unknown>
  console.log(`\n"${r.name}"\n  id=${r.id} enabled=${r.enabled} autonomy=${r.autonomyLevel} trigger=${r.trigger} mkt=${r.scopeMarketplace ?? 'all'}`)
  console.log(`  actions[0]: ${JSON.stringify(a0).slice(0, 320)}`)
  if (String(a0.type) === 'placement') console.log(`  conditions: ${JSON.stringify(r.conditions)}`)
}
await prisma.$disconnect()

import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const rows = await prisma.adsRuleSuggestion.findMany({ where: { status: 'pending' }, select: { id: true, ruleId: true, ruleName: true, trigger: true, entityName: true, proposedAction: true, createdAt: true }, orderBy: { createdAt: 'desc' } })
for (const r of rows) console.log(`${r.createdAt.toISOString().slice(0, 16)} rule=${r.ruleName} entity=${r.entityName} action=${JSON.stringify(r.proposedAction).slice(0, 130)}`)
await prisma.$disconnect()

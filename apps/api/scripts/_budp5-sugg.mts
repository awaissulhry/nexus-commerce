import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const id = 'cmt3byq3i00arl901dwu06y4u'
const s = await prisma.adsRuleSuggestion.findMany({ where: { ruleId: id }, orderBy: { createdAt: 'desc' } })
console.log(`SUGGESTIONS (${s.length}):`)
for (const x of s) console.log(`  status=${x.status} entity=${x.entityName ?? x.entityId} ${JSON.stringify(x.proposedAction).slice(0,220)}`)
const ex = await prisma.automationRuleExecution.findMany({ where: { ruleId: id }, orderBy: { createdAt: 'desc' }, take: 6 })
console.log(`\nEXECUTIONS (${ex.length}):`)
for (const e of ex) console.log(`  ${e.status} matched=${e.matched} ${JSON.stringify(e.actionResults ?? {}).slice(0,260)}`)
await prisma.$disconnect()

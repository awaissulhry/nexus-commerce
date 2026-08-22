import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const s = await prisma.adsRuleSuggestion.findMany({ select: { ruleName: true, status: true, entityName: true, proposedAction: true, createdAt: true } })
for (const r of s) console.log(`  ${r.status} · "${r.ruleName}" · ${r.entityName} · ${JSON.stringify(r.proposedAction).slice(0,160)}`)
// does the account carry any AdSpendCeiling / pin that would block placement?
const ceil = await prisma.adSpendCeiling.count().catch(() => -1)
console.log(`AdSpendCeiling rows: ${ceil}`)
// the write-gate authority pin
const st = await prisma.adsAutomationState.findFirst().catch(() => null)
console.log(`automation state: ${JSON.stringify(st)?.slice(0, 400)}`)
await prisma.$disconnect()

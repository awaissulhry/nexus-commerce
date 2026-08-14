/** CAP — what does an AUTO rule's actionResults say actually happened? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising', enabled: true },
  select: { id: true, name: true, autonomyLevel: true, trigger: true },
  orderBy: { name: 'asc' },
})
for (const r of rules) {
  // per rule — never a shared page (WH's quiet-rule trap)
  const rows = await prisma.automationRuleExecution.findMany({
    where: { ruleId: r.id, startedAt: { gte: new Date(Date.now() - 86400_000) } },
    orderBy: { startedAt: 'desc' }, take: 3,
    select: { status: true, dryRun: true, actionResults: true, startedAt: true },
  })
  console.log(`\n■ ${r.name}  [${r.autonomyLevel}] ${r.trigger}  — ${rows.length ? '' : 'NO ROWS in 24h'}`)
  for (const x of rows.slice(0, 2)) {
    console.log(`   ${x.startedAt.toISOString()} status=${x.status} dryRun=${x.dryRun}`)
    const ar = Array.isArray(x.actionResults) ? (x.actionResults as unknown[]) : []
    for (const a of ar) console.log(`     ${JSON.stringify(a).slice(0, 260)}`)
  }
}
await prisma.$disconnect()

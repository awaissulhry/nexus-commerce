/** ACR.6 — does /advertising/automation-analytics' query actually run? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const since = new Date(); since.setUTCDate(since.getUTCDate() - 30); since.setUTCHours(0, 0, 0, 0)

console.log('\n1. the query AS SHIPPED (domain on the EXECUTION):')
try {
  const n = await prisma.automationRuleExecution.findMany({
    where: { startedAt: { gte: since }, domain: 'advertising', status: { in: ['SUCCESS', 'PARTIAL'] } } as never,
    select: { id: true },
  })
  console.log(`   returned ${n.length} rows — no error`)
} catch (e) {
  console.log(`   THROWS: ${(e as Error).message.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 240)}`)
}

console.log('\n2. the same filter routed through the RELATION (the fix):')
const fixed = await prisma.automationRuleExecution.count({
  where: { startedAt: { gte: since }, status: { in: ['SUCCESS', 'PARTIAL'] }, rule: { domain: 'advertising' } },
})
console.log(`   ${fixed} advertising executions in the last 30d`)

const dry = await prisma.automationRuleExecution.count({
  where: { startedAt: { gte: since }, status: { in: ['SUCCESS', 'PARTIAL'] }, rule: { domain: 'advertising' }, dryRun: true },
})
console.log(`   …of which ${dry} are dryRun=true (counted as "changes" by the shipped aggregation)`)

const all = await prisma.automationRuleExecution.count({ where: { startedAt: { gte: since } } })
console.log(`   (all domains, any status, 30d: ${all})`)

const rules = await prisma.automationRule.count({ where: { domain: 'advertising' } })
console.log(`   advertising rules that EXIST: ${rules}`)

await prisma.$disconnect()

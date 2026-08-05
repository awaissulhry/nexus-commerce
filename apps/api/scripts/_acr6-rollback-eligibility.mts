/** ACR.6 (R1) — is the execution-rollback button reachable at all right now? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const cutoff = new Date(Date.now() - 24 * 3600 * 1000)

// The client mirrors the server: !dryRun && status in (SUCCESS,PARTIAL) && startedAt within 24h.
const eligible = await prisma.automationRuleExecution.findMany({
  where: { startedAt: { gte: cutoff }, dryRun: false, status: { in: ['SUCCESS', 'PARTIAL'] }, rule: { domain: 'advertising' } },
  select: { id: true, startedAt: true, status: true, rule: { select: { name: true } } },
  orderBy: { startedAt: 'desc' }, take: 5,
})
console.log(`\nrollback-eligible advertising executions in the last 24h: ${eligible.length}`)
for (const e of eligible) console.log(`  ${e.startedAt.toISOString()}  ${e.status.padEnd(8)} ${e.rule?.name}`)

const inWindow = await prisma.automationRuleExecution.count({ where: { startedAt: { gte: cutoff }, rule: { domain: 'advertising' } } })
const live = await prisma.automationRuleExecution.count({ where: { startedAt: { gte: cutoff }, dryRun: false, rule: { domain: 'advertising' } } })
console.log(`\n  advertising executions in window: ${inWindow}  (of which dryRun=false: ${live})`)
console.log(eligible.length ? '\n→ the Roll back button IS reachable; open that rule\'s history drawer.' : '\n→ nothing eligible: the button correctly renders nowhere, so its condition cannot be exercised on screen today.')
await prisma.$disconnect()

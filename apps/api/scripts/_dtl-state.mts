// NAF.DTL probe — what data actually exists behind the fleet page's six
// panels today, so the redesign is planned against reality, not hopes.
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const [charters, plans, approvals, runs, findings, sweeps, cards] = await Promise.all([
  prisma.agentCharter.findMany({
    select: { key: true, name: true, tier: true, enabled: true, autonomyLevel: true },
    orderBy: { key: 'asc' },
  }),
  prisma.agentPlan.findMany({
    select: { id: true, status: true, criticVerdict: true, createdAt: true, charterKey: true },
    orderBy: { createdAt: 'desc' },
    take: 20,
  }),
  prisma.agentApproval.groupBy({ by: ['status'], _count: true }),
  prisma.agentRun.groupBy({ by: ['status'], _count: true, where: { mode: { not: null } } }),
  prisma.agentFinding.groupBy({ by: ['status'], _count: true }),
  prisma.agentRun.count({ where: { mode: 'sweep' } }),
  prisma.agentScorecard.count(),
])

console.log('— charters —')
for (const c of charters) console.log(`  ${c.enabled ? 'ON ' : 'off'} ${c.key} (${c.tier}) autonomy=${c.autonomyLevel}`)
console.log('— plans —', plans.length)
for (const p of plans.slice(0, 8)) console.log(`  ${p.createdAt.toISOString()} ${p.status} critic=${p.criticVerdict}`)
console.log('— approvals by status —', JSON.stringify(approvals))
console.log('— fleet runs by status —', JSON.stringify(runs))
console.log('— findings by status —', JSON.stringify(findings))
console.log('— sweep runs —', sweeps)
console.log('— scorecards —', cards)

const oldest = await prisma.agentRun.findFirst({
  where: { mode: { not: null } },
  orderBy: { createdAt: 'asc' },
  select: { createdAt: true },
})
console.log('— oldest fleet run —', oldest?.createdAt?.toISOString() ?? 'none')
await prisma.$disconnect()

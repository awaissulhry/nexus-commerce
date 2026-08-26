// NAF.D pre-council check — is there anything on the blackboard for the
// director to plan over, and what state is the fleet in?
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const now = new Date()
const findings = await prisma.agentFinding.findMany({
  where: { charterKey: { not: 'fleet-selftest' } },
  select: {
    id: true, charterKey: true, kind: true, entityId: true, severity: true,
    status: true, createdAt: true, expiresAt: true,
  },
  orderBy: { createdAt: 'desc' },
  take: 40,
})
const open = findings.filter(
  (f) => f.status === 'open' && (!f.expiresAt || f.expiresAt > now),
)
console.log('total recent findings:', findings.length)
console.log('open+unexpired:', open.length)
for (const f of open.slice(0, 20)) {
  console.log(
    ` ${f.charterKey} ${f.kind}:${f.entityId} sev=${f.severity} exp=${f.expiresAt?.toISOString() ?? 'none'}`,
  )
}
if (findings.length && !open.length) {
  const newest = findings[0]!
  console.log(
    'newest finding:', newest.createdAt.toISOString(),
    'status:', newest.status, 'expired:', newest.expiresAt && newest.expiresAt <= now,
  )
}

const charters = await prisma.agentCharter.findMany({
  select: { key: true, version: true, enabled: true, autonomyLevel: true },
  orderBy: { key: 'asc' },
})
console.log('charters:', JSON.stringify(charters))

const state = await prisma.agentFleetState.findFirst()
console.log('fleet state:', JSON.stringify(state))
await prisma.$disconnect()

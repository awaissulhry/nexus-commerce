import '../src/env.js'
const { listCharters } = await import('../src/services/agent-fleet/charter-registry.js')
const { default: prisma } = await import('../src/db.js')
const cs = await listCharters()
for (const c of cs) console.log(' ', c.enabled ? 'ON ' : 'off', c.key, '| autonomy', c.autonomyLevel, '| degraded', c.degraded)
const runs = await prisma.agentRun.count({ where: { agentKey: 'fleet-auditor' } })
console.log('fleet-auditor runs ever:', runs)
await prisma.$disconnect()

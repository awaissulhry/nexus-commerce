import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const cs = await prisma.agentCharter.findMany({
  select: { key: true, enabled: true, autonomyLevel: true, createdAt: true, updatedAt: true },
  orderBy: { updatedAt: 'desc' },
})
console.log('CHARTER STATE + WHEN LAST CHANGED')
for (const c of cs) console.log(`  ${c.key.padEnd(26)} ${c.autonomyLevel.padEnd(8)} enabled=${String(c.enabled).padEnd(5)} created=${c.createdAt.toISOString().slice(0,16)} updated=${c.updatedAt.toISOString().slice(0,16)}`)
console.log('\nThe council runs that cost money were at 2026-08-06T19:54 and 19:57.')
console.log('If updatedAt is AFTER that, the charters were switched off afterwards.')

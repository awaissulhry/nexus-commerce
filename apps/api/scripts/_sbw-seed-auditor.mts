/**
 * NAF.SB.W — seed the missing charter row. `seedCharters()` is create-if-absent
 * and every row it creates is `enabled: false, autonomyLevel: 'OFF'`, so this
 * spends nothing and starts nothing. Only `fleet-auditor` is absent.
 */
import '../src/env.js'
const { seedCharters, listCharters } = await import('../src/services/agent-fleet/charter-registry.js')

const before = await listCharters()
console.log('BEFORE:', before.map(c => `${c.key}=${c.provisioned ? 'row' : 'NO ROW'}`).join(' '))
const res = await seedCharters()
console.log('SEEDED:', JSON.stringify(res))
const after = await listCharters()
console.log('AFTER :', after.map(c => `${c.key}=${c.provisioned ? 'row' : 'NO ROW'}`).join(' '))
const notOff = after.filter(c => c.enabled || c.autonomyLevel !== 'OFF')
console.log('ANY NOT OFF:', notOff.length === 0 ? 'none — the whole fleet is still dark' : JSON.stringify(notOff.map(c => c.key)))
const { default: prisma } = await import('../src/db.js')
await prisma.$disconnect()

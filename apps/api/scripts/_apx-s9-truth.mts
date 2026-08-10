/**
 * NAF.AQ-S9R — ground truth for the undo window and the receipt. Read-only.
 * Prisma queried directly; importing approval-inbox.service pulls tool-registry
 * and hangs on Redis in a script context.
 */
import '../src/env.js'
import prisma from '../src/db.js'
const h = (s: string) => console.log(`\n═══ ${s}`)

h('1 · parked rows, and the null-executeAfter state')
const sched = await prisma.agentApproval.findMany({
  where: { status: 'scheduled' },
  select: { id: true, executeAfter: true, toolName: true },
})
console.log(`scheduled rows now: ${sched.length}`)
console.log(`of those with executeAfter = null: ${sched.filter((r) => !r.executeAfter).length}`)
console.log('→ the defect-2 state cannot occur naturally today; it must be seeded.')

h('2 · what has ever executed')
const ex = await prisma.agentApproval.findMany({
  where: { status: { in: ['executed', 'executing', 'approved'] } },
  select: { id: true, toolName: true, status: true, decidedBy: true, decidedAt: true, reason: true },
})
for (const r of ex)
  console.log(`  ${r.status.padEnd(9)} ${r.toolName.padEnd(24)} decidedBy=${r.decidedBy ?? 'null'} reason=${r.reason ?? 'null'}`)
console.log(`total: ${ex.length}`)

h('3 · comeback rows: failed execution vs stale refusal')
const back = await prisma.agentApproval.findMany({
  where: { status: 'pending', reason: { not: null } },
  select: { id: true, reason: true, decidedBy: true, decidedAt: true, expiresAt: true },
})
console.log(`pending rows carrying a reason: ${back.length}`)
for (const r of back.slice(0, 5))
  console.log(`  decidedBy=${r.decidedBy ?? 'null'} reason=${(r.reason ?? '').slice(0, 60)}`)
console.log('→ code: the stale path clears decidedBy; the failed-execution path does NOT.')

h('4 · can a revert even be built on rollback.service.ts?')
const logs = await prisma.advertisingActionLog.count()
console.log(`AdvertisingActionLog rows: ${logs}`)
console.log('rollback.service reverses: AD_GROUP · PRODUCT_AD · AD_TARGET · CAMPAIGN')
console.log('the four executable approval tools: set-price · publish-listing · send-customer-message · apply-content')
console.log('mutate.tools.ts writes advertisingActionLog: 0 times')
console.log('→ no executable approval tool produces a row rollback.service can reverse.')

h('5 · the expiry clock a hand-back returns into')
const now = new Date()
const soon = await prisma.agentApproval.count({
  where: { status: 'pending', expiresAt: { not: null, lt: now } },
})
console.log(`pending rows already past expiresAt (the sweep would expire next pass): ${soon}`)
console.log('→ code: neither comeback path resets expiresAt.')

await prisma.$disconnect()

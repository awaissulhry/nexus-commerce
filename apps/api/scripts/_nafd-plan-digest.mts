import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const plan = await prisma.agentPlan.findUnique({ where: { id: 'cmshxszap0009njngncdiyxfw' } })
console.log('status:', plan?.status, '· verdict:', plan?.criticVerdict)
console.log('headline:', plan?.headline)
console.log('narrative:', plan?.narrative)
console.log('blastRadius:', JSON.stringify(plan?.blastRadius))
const items = (plan?.items ?? []) as Array<Record<string, unknown>>
console.log(`\nitems (${items.length}):`)
for (const it of items) console.log(` #${it.rank} ${it.tool} f=${it.findingId} args=${JSON.stringify(it.args)}`)
const dropped = (plan?.droppedItems ?? []) as Array<Record<string, unknown>>
console.log(`\ndropped (${dropped.length}):`)
for (const d of dropped) console.log(` ${d.findingId}: ${d.reason}`)
console.log('\ncriticNotes:', JSON.stringify(plan?.criticNotes, null, 2))
await prisma.$disconnect()

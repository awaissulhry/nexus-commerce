/** RA.AUTO — did the simulation write AdvertisingActionLog rows, or was that concurrent cron activity? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const since = new Date(Date.now() - 25 * 60_000)
const rows = await prisma.advertisingActionLog.findMany({
  where: { createdAt: { gte: since } },
  orderBy: { createdAt: 'desc' },
  take: 60,
  select: { id: true, createdAt: true, userId: true, actionType: true, entityType: true, entityId: true, amazonResponseStatus: true, executionId: true },
})
console.log(`\n${rows.length} AdvertisingActionLog rows in the last 25 minutes:\n`)
const byUser: Record<string, number> = {}
for (const r of rows) byUser[String(r.userId)] = (byUser[String(r.userId)] ?? 0) + 1
console.log('by userId:', JSON.stringify(byUser, null, 1))

// The two rules the simulation touched.
const suspects = await prisma.automationRule.findMany({
  where: { name: { in: ['Alert: ad spend beat true profit', 'FBA in-stock resume'] } },
  select: { id: true, name: true },
})
console.log('\nsimulated rule ids:', suspects.map((s) => `${s.name}=${s.id}`).join(' · '))
const suspectIds = new Set(suspects.map((s) => `automation:${s.id}`))
const fromSimulated = rows.filter((r) => suspectIds.has(String(r.userId)))
console.log(`rows attributable to a SIMULATED rule: ${fromSimulated.length}  ← must be 0`)

console.log('\nmost recent 12, in full:')
for (const r of rows.slice(0, 12)) {
  console.log(`   ${r.createdAt.toISOString()} user=${String(r.userId).slice(0, 46).padEnd(48)} ${String(r.actionType).padEnd(22)} ${r.entityType}/${String(r.entityId).slice(0, 14)} status=${r.amazonResponseStatus} exec=${r.executionId ?? '—'}`)
}

// Cross-check: are these the ongoing cron's, i.e. do they keep arriving with no simulation running?
const last5 = await prisma.advertisingActionLog.count({ where: { createdAt: { gte: new Date(Date.now() - 5 * 60_000) } } })
console.log(`\nrows in the last 5 minutes: ${last5}`)
await prisma.$disconnect()

/**
 * BUD.8 §3.5 + §6 — ceilings, refusals, and what SKIPPED means. READ-ONLY.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const [ceilings, refusals] = await Promise.all([
  prisma.adSpendCeiling.count().catch(() => -1),
  prisma.adWriteRefusal.count().catch(() => -1),
])
console.log(`AdSpendCeiling rows : ${ceilings}${ceilings === 0 ? '  — A7 shipped the mechanism, nobody created a ceiling' : ''}`)
console.log(`AdWriteRefusal rows : ${refusals}`)

const refByField = await prisma.adWriteRefusal.groupBy({ by: ['field'], _count: { _all: true } }).catch(() => [] as Array<{ field: string | null; _count: { _all: number } }>)
for (const r of refByField) console.log(`   field=${r.field ?? '(null)'}  ${r._count._all}`)

// 🔴 703 SKIPPED rows in 7 days — the brief asks what that means before anyone quotes a success rate.
const skipped = await prisma.outboundSyncQueue.groupBy({
  by: ['syncType', 'errorCode'],
  where: { syncStatus: 'SKIPPED', syncedAt: { gte: new Date(Date.now() - 7 * 86_400_000) } },
  _count: { _all: true },
})
console.log(`\nSKIPPED outbound rows, last 7 days, by type and cause:`)
for (const s of skipped.sort((a, b) => b._count._all - a._count._all)) {
  console.log(`   ${String(s.syncType).padEnd(28)} ${String(s.errorCode ?? '(no code)').padEnd(22)} ${s._count._all}`)
}

const budgetSkipped = await prisma.outboundSyncQueue.count({
  where: { syncStatus: 'SKIPPED', syncType: 'AD_BUDGET_UPDATE', syncedAt: { gte: new Date(Date.now() - 7 * 86_400_000) } },
})
console.log(`\n   of which AD_BUDGET_UPDATE: ${budgetSkipped}`)

await prisma.$disconnect()

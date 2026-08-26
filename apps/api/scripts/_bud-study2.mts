/** BUD part 2 — did budget writes actually happen, and what refuses them? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const since = new Date(Date.now() - 60 * 86_400_000)

// What action types exist at all? (my first query filtered on the word "budget" and found none)
const kinds = await prisma.advertisingActionLog.groupBy({
  by: ['actionType'], where: { createdAt: { gte: since } }, _count: { _all: true },
})
console.log('\n── AdvertisingActionLog actionTypes, 60d ──')
for (const k of kinds.sort((a, b) => b._count._all - a._count._all)) console.log(`  ${pad(k.actionType, 34)} ${k._count._all.toLocaleString('en-IE')}`)

// Campaign-grain rows written by a rule actor, with a budget change in before/after.
const rows = await prisma.advertisingActionLog.findMany({
  where: { createdAt: { gte: since }, entityType: 'CAMPAIGN' },
  select: { actionType: true, actor: true, beforeValue: true, afterValue: true, createdAt: true, status: true, entityId: true },
  orderBy: { createdAt: 'desc' }, take: 3000,
})
const hasBudget = rows.filter((r) => JSON.stringify(r.beforeValue ?? {}).includes('udget') || JSON.stringify(r.afterValue ?? {}).includes('udget'))
console.log(`\nCAMPAIGN rows: ${rows.length} · carrying a budget field: ${hasBudget.length}`)
const byActor = new Map<string, number>()
for (const r of hasBudget) byActor.set(String(r.actor ?? '—'), (byActor.get(String(r.actor ?? '—')) ?? 0) + 1)
for (const [a, n] of [...byActor].sort((x, y) => y[1] - x[1]).slice(0, 10)) console.log(`  ${pad(a, 50)} ${n}`)
console.log('\n  most recent 10 budget-bearing rows:')
for (const r of hasBudget.slice(0, 10)) {
  const b = JSON.stringify(r.beforeValue), a = JSON.stringify(r.afterValue)
  console.log(`    ${r.createdAt.toISOString().slice(0, 16)} ${pad(r.actionType, 22)} ${pad(r.status ?? '—', 9)} ${b.slice(0, 46)} → ${a.slice(0, 46)}`)
}

// Rule-actor rows of any kind
const ruleRows = rows.filter((r) => String(r.actor ?? '').includes('rule') || String(r.actor ?? '').includes('automation'))
console.log(`\n  rows written by a rule/automation actor: ${ruleRows.length}`)
await prisma.$disconnect()
